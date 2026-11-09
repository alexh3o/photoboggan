//! Searches of the semantic search (spec dev_tools/Evolutions/feat semantic search SigLIP 2.md, §5.2, §7, §18): in-memory index of
//! the embeddings, text encoder, ranking, relative relevance threshold, idle release.
//!
//! - Index (§5.2): built on the first search from every embedding of the active model (fresh or not: a file whose metadata changed keeps
//!   its embedding until the next analysis), kept as half floats in one contiguous array. Scores are dot products (the vectors are
//!   L2-normalised, so this is the cosine) with the half → float conversion inside the loop, computed by `rayon` over blocks of rows.
//! - Updates: the scan hands each stored batch to `on_batch_stored`, which updates the loaded index in place; any other change of the
//!   tables (data deleted) drops it. A generation counter catches a batch stored while the index was being built: the next search rebuilds.
//! - Text queries (§4.2, §15.4): lowercased, spaces collapsed, wrapped in the template when they have at most 3 words; the tokenizer and
//!   the text model are loaded together (two threads) by the first text query, inside its blocking task, and kept with the index.
//! - Release: nothing exists before the first search. After `IDLE_RELEASE` without a search, a single `tokio` sleeping task (armed by the
//!   first use, re-checking the last use when it wakes) drops the index and the text encoder; the feature being disabled, its data or
//!   model deleted drop them too (a loaded model file could not be deleted on Windows).
//! - Results: the best `MAX_RESULTS` photos of the scope, sorted by decreasing cosine (ties by photo id). The relevance slider of the
//!   interface keeps `cos >= best − Δ` among them (`relevance_cut`): moving it needs no new search (§18).

use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, Instant};
use tauri::State;

use crate::semantic::{f16_to_f32, f32_to_f16, normalise_query, Outcome, Target, TextEncoder};
use crate::semantic_models::{active_model, ensure_enabled, ModelSpec};
use crate::AppState;

/// Hard cap of a result list (§7.1).
pub const MAX_RESULTS: usize = 2000;

/// The index (and the text encoder) are released after this long without a search (§5.2, not exposed in the settings).
pub const IDLE_RELEASE: Duration = Duration::from_secs(5 * 60);

/// Error key: "find similar content" on a photo that has no embedding of the active model.
pub const PHOTO_NOT_ANALYSED_ERROR: &str = "semantic_photo_not_analysed";

/// Error key: a text query with nothing to search for (empty, or only spaces and punctuation).
pub const EMPTY_QUERY_ERROR: &str = "semantic_empty_query";

/// Rows scored by one rayon task: large enough to amortise the task, small enough to spread 100,000 rows over every core.
const ROWS_PER_BLOCK: usize = 2048;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/// Size and modification date of the file version an embedding was computed from (as in the tables).
pub type Stamp = (i64, i64);

/// Embeddings of one model, in memory: row `r` is photo `ids[r]`, its vector `vectors[r × dim .. (r + 1) × dim]` (half floats).
pub struct Index {
    model_id: String,
    dim: usize,
    ids: Vec<i64>,
    vectors: Vec<u16>,
    /// File version of each row: tells an up-to-date embedding from one waiting for a new analysis, without a query per photo.
    stamps: Vec<Stamp>,
    /// Row of each photo (updates, query photo of an image search).
    rows: HashMap<i64, usize>,
    /// Value of the cache generation the rows reflect (see SearchCache).
    generation: u64,
}

impl Index {
    pub fn new(model_id: &str, dim: usize) -> Self {
        Index { model_id: model_id.to_string(), dim, ids: Vec::new(), vectors: Vec::new(), stamps: Vec::new(), rows: HashMap::new(), generation: 0 }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.ids.len()
    }

    /// Every embedding of `model_id` in the database. Rows of another length (damaged) are left out.
    pub fn load(conn: &Connection, model_id: &str, dim: usize) -> Result<Self, String> {
        let mut index = Index::new(model_id, dim);
        let mut statement = conn
            .prepare("SELECT photo_id, file_size, file_mtime, vec FROM photo_embeddings WHERE model_id = ?1")
            .map_err(|error| error.to_string())?;
        let mut rows = statement.query(params![model_id]).map_err(|error| error.to_string())?;
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let photo_id: i64 = row.get(0).map_err(|error| error.to_string())?;
            let stamp: Stamp = (row.get(1).map_err(|error| error.to_string())?, row.get(2).map_err(|error| error.to_string())?);
            let blob = row.get_ref(3).map_err(|error| error.to_string())?.as_blob().map_err(|error| error.to_string())?;
            if blob.len() != dim * 2 { continue; }
            index.set_halves(photo_id, stamp, blob.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])));
        }
        Ok(index)
    }

    /// Adds the photo, or replaces its vector.
    fn set_halves(&mut self, photo_id: i64, stamp: Stamp, halves: impl Iterator<Item = u16>) {
        match self.rows.get(&photo_id) {
            Some(&row) => {
                for (slot, half) in self.vectors[row * self.dim..(row + 1) * self.dim].iter_mut().zip(halves) { *slot = half; }
                self.stamps[row] = stamp;
            }
            None => {
                self.rows.insert(photo_id, self.ids.len());
                self.ids.push(photo_id);
                self.vectors.extend(halves.take(self.dim));
                self.stamps.push(stamp);
            }
        }
    }

    /// Adds or replaces the embedding of a photo (stored as half floats, as in the database), computed from the file version `stamp`.
    pub fn upsert(&mut self, photo_id: i64, vector: &[f32], stamp: Stamp) {
        if vector.len() != self.dim { return; }
        self.set_halves(photo_id, stamp, vector.iter().map(|&value| f32_to_f16(value)));
    }

    /// The photo has an embedding of this file version (same rule as `Standing::Analysed`).
    pub fn is_up_to_date(&self, photo_id: i64, stamp: Stamp) -> bool {
        self.rows.get(&photo_id).is_some_and(|&row| self.stamps[row] == stamp)
    }

    /// Removes the embedding of a photo (the last row takes its place).
    pub fn remove(&mut self, photo_id: i64) {
        let Some(row) = self.rows.remove(&photo_id) else { return };
        let last = self.ids.len() - 1;
        if row != last {
            let moved = self.ids[last];
            self.ids[row] = moved;
            self.vectors.copy_within(last * self.dim..(last + 1) * self.dim, row * self.dim);
            self.stamps[row] = self.stamps[last];
            self.rows.insert(moved, row);
        }
        self.ids.pop();
        self.stamps.pop();
        self.vectors.truncate(last * self.dim);
    }

    /// Embedding of a photo, as floats.
    pub fn vector(&self, photo_id: i64) -> Option<Vec<f32>> {
        let row = *self.rows.get(&photo_id)?;
        Some(self.vectors[row * self.dim..(row + 1) * self.dim].iter().map(|&half| f16_to_f32(half)).collect())
    }

    /// The `cap` best photos accepted by `keep`, by decreasing cosine with `query` (ties by increasing photo id, so the order is stable).
    pub fn rank(&self, query: &[f32], keep: &(dyn Fn(i64) -> bool + Sync), cap: usize) -> Ranking {
        if query.len() != self.dim || self.dim == 0 || cap == 0 {
            return Ranking::default();
        }
        let dim = self.dim;
        let blocks: Vec<Vec<Hit>> = self
            .vectors
            .par_chunks(dim * ROWS_PER_BLOCK)
            .zip(self.ids.par_chunks(ROWS_PER_BLOCK))
            .map(|(vectors, ids)| {
                ids.iter()
                    .zip(vectors.chunks_exact(dim))
                    .filter(|(id, _)| keep(**id))
                    .map(|(&photo_id, row)| Hit { photo_id, cos: dot_half(query, row), prob: None })
                    .collect()
            })
            .collect();
        let mut hits: Vec<Hit> = blocks.concat();
        let capped = hits.len() > cap;
        if capped {
            hits.select_nth_unstable_by(cap - 1, rank_order);
            hits.truncate(cap);
        }
        hits.sort_unstable_by(rank_order);
        Ranking { best: hits.first().map(|hit| hit.cos), hits, capped }
    }
}

/// Dot product of a float query with a half-float row, converted on the fly. Eight accumulators: no dependency chain between
/// consecutive additions, so the compiler can keep several multiply-adds in flight (and vectorise).
fn dot_half(query: &[f32], row: &[u16]) -> f32 {
    let mut sums = [0f32; 8];
    let mut query_chunks = query.chunks_exact(8);
    let mut row_chunks = row.chunks_exact(8);
    for (q, r) in (&mut query_chunks).zip(&mut row_chunks) {
        for lane in 0..8 { sums[lane] += q[lane] * f16_to_f32(r[lane]); }
    }
    let tail: f32 = query_chunks.remainder().iter().zip(row_chunks.remainder()).map(|(q, &r)| q * f16_to_f32(r)).sum();
    sums.iter().sum::<f32>() + tail
}

/// Decreasing cosine, then increasing photo id.
fn rank_order(a: &Hit, b: &Hit) -> std::cmp::Ordering {
    b.cos.total_cmp(&a.cos).then(a.photo_id.cmp(&b.photo_id))
}

/// One photo of a result list.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub photo_id: i64,
    /// Cosine with the query (−1 to 1; text queries: typically 0.05 to 0.15, §15.3).
    pub cos: f32,
    /// Text queries: sigmoid probability of the match (§2), for the score badge. Image queries: None (the text constants do not apply).
    pub prob: Option<f32>,
}

#[derive(Default, Debug)]
pub struct Ranking {
    /// Cosine of the first photo (None: nothing in the scope has an embedding).
    pub best: Option<f32>,
    pub hits: Vec<Hit>,
    /// More photos than the cap were scored: only the best ones are kept.
    pub capped: bool,
}

/// Relative relevance threshold (§7.1, §15.3): keeps the photos of a sorted list whose cosine is at least `best − delta`.
pub fn relevance_cut(hits: &mut Vec<Hit>, delta: f32) {
    let Some(best) = hits.first().map(|hit| hit.cos) else { return };
    let floor = best - delta.max(0.0);
    let kept = hits.partition_point(|hit| hit.cos >= floor);
    hits.truncate(kept);
}

/// Sigmoid probability of a text match: sigmoid(cos × logit_scale + logit_bias) (§2, constants of the manifest).
pub fn probability(cos: f32, model: &ModelSpec) -> f32 {
    let logit = cos as f64 * model.logit_scale as f64 + model.logit_bias as f64;
    (1.0 / (1.0 + (-logit).exp())) as f32
}

/// Text fed to the text encoder: `normalise_query` (lowercase, spaces, template for short queries), or `semantic_empty_query` when
/// the query holds nothing to search for: no letter, digit or other non-ASCII symbol (emoji…), only spaces and punctuation.
pub fn prepare_query(query: &str, model: &ModelSpec) -> Result<String, String> {
    const PUNCTUATION: &[char] = &['«', '»', '…', '–', '—', '‘', '’', '“', '”', '¿', '¡', '·', '•'];
    let meaningful = |c: char| c.is_alphanumeric() || (!c.is_ascii() && !c.is_whitespace() && !PUNCTUATION.contains(&c));
    if !query.chars().any(meaningful) { return Err(EMPTY_QUERY_ERROR.to_string()); }
    Ok(normalise_query(query, model))
}

/// ONNX Runtime threads of the text encoder: a query is interactive (~55 ms), but a few threads are enough for one sentence.
fn text_threads() -> usize {
    std::thread::available_parallelism().map_or(2, |count| count.get()).clamp(1, 4)
}

/// Loads the text encoder of the installed model (errors: `semantic_disabled`, `semantic_model_missing`, `semantic_unsupported_platform`).
fn load_text_encoder(models_dir: &Path, model: &ModelSpec) -> Result<TextEncoder, String> {
    // Checked again here: a disable arriving since the command started must not load a model (release() would wait, then drop it).
    ensure_enabled()?;
    let paths = crate::semantic_models::installed_paths(models_dir, model)?;
    let environment = crate::onnx_runtime::environment(&paths.runtime)?;
    TextEncoder::load(&environment, &paths.text, &paths.tokenizer, model, text_threads())
}

// ---------------------------------------------------------------------------
// Cache: index, idle release
// ---------------------------------------------------------------------------

struct Timer {
    last_use: Instant,
    /// A release task is sleeping.
    armed: bool,
}

/// What the searches keep in memory between two queries, and its release.
///
/// Lock order: `building` before `index`. `generation` counts the changes of the embedding tables: an index built from an older
/// generation is rebuilt by the next search (unless `on_batch_stored` brought it up to date in place).
pub struct SearchCache {
    idle: Duration,
    generation: AtomicU64,
    index: RwLock<Option<Index>>,
    /// Held while an index is built (one build at a time) and while it is released (a build ending after a release would bring it back).
    building: Mutex<()>,
    timer: Mutex<Timer>,
    /// Index builds since creation (tests: an update in place does not reload).
    loads: AtomicUsize,
    /// Text encoder, loaded by the first text query. Held for the whole encoding of a query, so a release waits for it to end and the
    /// model file is really closed when `release` returns.
    text: Mutex<Option<TextEncoder>>,
}

impl SearchCache {
    pub fn new(idle: Duration) -> Arc<Self> {
        Arc::new(SearchCache {
            idle,
            generation: AtomicU64::new(0),
            index: RwLock::new(None),
            building: Mutex::new(()),
            timer: Mutex::new(Timer { last_use: Instant::now(), armed: false }),
            loads: AtomicUsize::new(0),
            text: Mutex::new(None),
        })
    }

    /// Notes a use, and arms the release task if none is sleeping. The task sleeps until `idle` after the last use it knows, checks again
    /// when it wakes (a later use moved the deadline), and releases everything once the cache has really been idle that long.
    pub fn touch(self: &Arc<Self>) {
        let mut timer = lock(&self.timer);
        timer.last_use = Instant::now();
        if timer.armed { return; }
        timer.armed = true;
        let cache = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                let wait = {
                    let timer = lock(&cache.timer);
                    cache.idle.checked_sub(timer.last_use.elapsed()).filter(|left| !left.is_zero())
                };
                match wait {
                    Some(left) => tokio::time::sleep(left).await,
                    None => break,
                }
            }
            // Releasing may wait for a search in progress: off the async workers.
            let _ = tauri::async_runtime::spawn_blocking(move || cache.release_if_idle()).await;
        });
    }

    /// Release by the idle task: only if no use came in the meantime (checked under the timer lock, so a search starting now either
    /// arms a new task after this release, or prevents it).
    fn release_if_idle(&self) {
        let mut timer = lock(&self.timer);
        if timer.last_use.elapsed() < self.idle {
            // Used again since the task last looked: keep everything and let the next use arm a new task.
            timer.armed = false;
            drop(timer);
            return;
        }
        timer.armed = false;
        self.release();
    }

    /// Drops everything held in memory (the next search loads it again). Waits for a search in progress.
    pub fn release(&self) {
        {
            let _building = lock(&self.building);
            *write(&self.index) = None;
        }
        *lock(&self.text) = None;
    }

    /// Runs `task` with the text encoder released and kept from loading until `task` ends (deletion of the model files).
    pub fn without_text_model<R>(&self, task: impl FnOnce() -> R) -> R {
        let mut slot = lock(&self.text);
        *slot = None;
        task()
    }

    /// Embedding of an already normalised query (`prepare_query`), with the encoder loaded by `load` if needed (one load at a time).
    pub fn embed_text(&self, load: impl FnOnce() -> Result<TextEncoder, String>, text: &str) -> Result<Vec<f32>, String> {
        let mut slot = lock(&self.text);
        if slot.is_none() { *slot = Some(load()?); }
        let encoder = slot.as_mut().expect("loaded above");
        encoder.embed(&[text.to_string()])?.pop().ok_or_else(|| "text encoder: no embedding".to_string())
    }

    /// The embedding tables changed outside a scan batch (data deleted): the index is dropped.
    pub fn invalidate(&self) {
        let _building = lock(&self.building);
        let mut index = write(&self.index);
        self.generation.fetch_add(1, Ordering::SeqCst);
        *index = None;
    }

    /// A scan stored a batch: the loaded index (if any, and up to date) takes the new embeddings and drops the photos that failed.
    pub fn on_batch_stored(&self, model_id: &str, results: &[(&Target, Outcome)]) {
        let mut index = write(&self.index);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let Some(index) = index.as_mut() else { return };
        // An index built from an older state is left stale: the next search rebuilds it.
        if index.generation + 1 != generation || index.model_id != model_id { return; }
        for (target, outcome) in results {
            match outcome {
                Outcome::Embedded(vector) => index.upsert(target.photo_id, vector, (target.size, target.mtime)),
                Outcome::Failed(_) => index.remove(target.photo_id),
                Outcome::Skipped => {}
            }
        }
        index.generation = generation;
    }

    /// Runs `use_index` on an up-to-date index of `model`, built by `load` when there is none (or an outdated one). `load` is called
    /// at most once at a time.
    pub fn with_index<R>(
        &self,
        model: &ModelSpec,
        load: impl FnOnce() -> Result<Index, String>,
        use_index: impl FnOnce(&Index) -> R,
    ) -> Result<R, String> {
        let current = |index: &Option<Index>| {
            index.as_ref().is_some_and(|index| index.model_id == model.id && index.generation == self.generation.load(Ordering::SeqCst))
        };
        {
            let index = read(&self.index);
            if current(&index) { return Ok(use_index(index.as_ref().unwrap())); }
        }
        let _building = lock(&self.building);
        {
            let index = read(&self.index);
            if current(&index) { return Ok(use_index(index.as_ref().unwrap())); } // built by the search we waited for
        }
        // Generation read before the rows: a batch stored during the load makes this index outdated, so it is rebuilt next time.
        let generation = self.generation.load(Ordering::SeqCst);
        // The outdated index is dropped first: never two copies in memory.
        *write(&self.index) = None;
        let mut built = load()?;
        built.generation = generation;
        self.loads.fetch_add(1, Ordering::Relaxed);
        let result = use_index(&built);
        *write(&self.index) = Some(built);
        Ok(result)
    }

    #[cfg(test)]
    pub fn is_loaded(&self) -> bool {
        read(&self.index).is_some()
    }
}

/// The cache of the application: created by the first search, never before.
static CACHE: OnceLock<Arc<SearchCache>> = OnceLock::new();

fn cache() -> &'static Arc<SearchCache> {
    CACHE.get_or_init(|| SearchCache::new(IDLE_RELEASE))
}

/// Disabled feature, deleted data or model: everything is released (no-op when no search ever ran).
pub fn release_all() {
    if let Some(cache) = CACHE.get() { cache.release(); }
}

/// Runs `task` while no text query can hold or load the text model (deletion of the model files).
pub fn without_text_model<R>(task: impl FnOnce() -> R) -> R {
    // Creates the (empty) cache if no search ever ran: a query starting during the deletion must wait too.
    cache().without_text_model(task)
}

/// Embedding tables emptied: the index is dropped.
pub fn invalidate() {
    if let Some(cache) = CACHE.get() { cache.invalidate(); }
}

/// Called by the scan after each stored batch.
pub fn on_batch_stored(model_id: &str, results: &[(&Target, Outcome)]) {
    if let Some(cache) = CACHE.get() { cache.on_batch_stored(model_id, results); }
}

// ---------------------------------------------------------------------------
// Scope and search
// ---------------------------------------------------------------------------

/// Photos searched: a selection (`photoIds`), a folder (`folder`, subfolders if `recursive`), or the whole library (neither); same scopes
/// as the scan. `skipRaw` only changes the `pending` count (RAW files left out of the analysis are not "waiting"): the search itself
/// reads every embedding that exists.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchScope {
    pub folder: Option<String>,
    pub recursive: bool,
    pub photo_ids: Option<Vec<i64>>,
    pub skip_raw: bool,
}

/// What a search returns (§18).
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    /// Cosine of the first result (None: no photo of the scope has an embedding).
    pub best: Option<f32>,
    /// Sorted by decreasing cosine, at most MAX_RESULTS, cut at `best − relevance` when a relevance was given.
    pub results: Vec<Hit>,
    /// More photos than MAX_RESULTS were scored.
    pub capped: bool,
    /// Photos of the scope.
    pub total: usize,
    /// Photos of the scope an analysis would handle (same count as `pending` of get_semantic_stats for the same scope and `skipRaw`).
    pub pending: usize,
}

/// A photo of the scope of a search.
struct ScopePhoto {
    id: i64,
    path: String,
    stamp: Stamp,
}

/// Photos of a scope, with the rules of `semantic::select_targets` (selection, or folder compared with "/" with or without its
/// subfolders, or the whole library), but without its per-photo lookups in the embedding tables: the index answers those (100,000
/// photos: a whole search takes ~40 ms instead of ~270 ms). The scope tests check that both give the same `pending` count.
fn scope_photos(conn: &Connection, scope: &SearchScope) -> Result<Vec<ScopePhoto>, String> {
    let columns = "SELECT id, path, COALESCE(file_size, 0), COALESCE(modified, 0) FROM photos WHERE path IS NOT NULL";
    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<ScopePhoto> {
        Ok(ScopePhoto { id: row.get(0)?, path: row.get(1)?, stamp: (row.get(2)?, row.get(3)?) })
    };
    if let Some(ids) = &scope.photo_ids {
        let ids_json = serde_json::to_string(ids).map_err(|error| error.to_string())?;
        let mut statement = conn.prepare(&format!("{columns} AND id IN (SELECT value FROM json_each(?1))")).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![ids_json], map_row).map_err(|error| error.to_string())?;
        crate::keywords::collect_rows(rows)
    } else if let Some(folder) = &scope.folder {
        let prefix = format!("{}/", folder.replace('\\', "/").trim_end_matches('/'));
        let mut statement = conn
            .prepare(&format!(
                "{columns} AND substr(replace(path, char(92), '/'), 1, length(?1)) = ?1
                 AND (?2 OR instr(substr(replace(path, char(92), '/'), length(?1) + 1), '/') = 0)"
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![prefix, scope.recursive], map_row).map_err(|error| error.to_string())?;
        crate::keywords::collect_rows(rows)
    } else {
        let mut statement = conn.prepare(columns).map_err(|error| error.to_string())?;
        let rows = statement.query_map([], map_row).map_err(|error| error.to_string())?;
        crate::keywords::collect_rows(rows)
    }
}

/// Recorded failures of the model, with the file version that failed (a small table: read whole).
fn current_failures(conn: &Connection, model_id: &str) -> Result<HashMap<i64, Stamp>, String> {
    let mut statement =
        conn.prepare("SELECT photo_id, file_size, file_mtime FROM photo_embedding_failures WHERE model_id = ?1").map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![model_id], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?)))).map_err(|error| error.to_string())?;
    Ok(crate::keywords::collect_rows(rows)?.into_iter().collect())
}

/// The query of a search.
pub enum Query<'a> {
    /// Text embedding (text search): the results carry their probability.
    Vector(&'a [f32]),
    /// Photo whose embedding is the query (similar content): the photo itself is left out of the results.
    Photo(i64),
}

/// A search on the database `conn`, with the index of `cache` (built by this call when needed). `gate` is checked before the index is
/// built (the commands pass `ensure_enabled`). `relevance`: optional Δ applied here (None: every capped candidate, the interface
/// filters them with its slider).
pub fn search(
    cache: &SearchCache,
    conn: &Connection,
    model: &ModelSpec,
    query: Query<'_>,
    scope: &SearchScope,
    relevance: Option<f32>,
    gate: fn() -> Result<(), String>,
) -> Result<SearchResults, String> {
    let photos = scope_photos(conn, scope)?;
    let members: HashSet<i64> = photos.iter().map(|photo| photo.id).collect();
    let failures = current_failures(conn, &model.id)?;

    let load = || {
        gate()?;
        Index::load(conn, &model.id, model.embed_dim)
    };
    let (ranking, pending) = cache.with_index(model, load, |index| -> Result<(Ranking, usize), String> {
        // Same rule as `Standing::Pending` (get_semantic_stats, the scan), read from the index instead of one query per photo.
        let pending = photos
            .iter()
            .filter(|photo| !index.is_up_to_date(photo.id, photo.stamp) && failures.get(&photo.id) != Some(&photo.stamp))
            .filter(|photo| !scope.skip_raw || !crate::thumbnails::is_raw_path(Path::new(&photo.path)))
            .count();
        let ranking = match query {
            Query::Vector(vector) => index.rank(vector, &|id| members.contains(&id), MAX_RESULTS),
            Query::Photo(photo_id) => {
                let vector = index.vector(photo_id).ok_or_else(|| PHOTO_NOT_ANALYSED_ERROR.to_string())?;
                index.rank(&vector, &|id| id != photo_id && members.contains(&id), MAX_RESULTS)
            }
        };
        Ok((ranking, pending))
    })??;
    let total = photos.len();
    let mut results = ranking.hits;
    if let Query::Vector(_) = query {
        for hit in results.iter_mut() { hit.prob = Some(probability(hit.cos, model)); }
    }
    if let Some(delta) = relevance.filter(|delta| delta.is_finite()) { relevance_cut(&mut results, delta); }
    Ok(SearchResults { best: ranking.best, results, capped: ranking.capped, total, pending })
}

/// Free-text search (§7.1): photos of `scope` whose content best matches `query`, with their probability. The first query loads the text
/// encoder (~1.5 s); the next ones take ~55 ms plus the search. `relevance`: optional Δ (see `search`). Errors: `semantic_disabled`,
/// `semantic_empty_query`, `semantic_model_missing`, `semantic_unsupported_platform`, or a message.
#[tauri::command]
pub async fn semantic_search_text(
    state: State<'_, AppState>,
    query: String,
    scope: SearchScope,
    relevance: Option<f32>,
) -> Result<SearchResults, String> {
    ensure_enabled()?;
    let model = active_model();
    let fed = prepare_query(&query, model)?;
    let pool = state.pool();
    let models_dir = crate::face_models::models_dir(&state);
    let cache = cache();
    cache.touch();
    let outcome = tokio::task::spawn_blocking(move || {
        let vector = cache.embed_text(|| load_text_encoder(&models_dir, model), &fed)?;
        let conn = pool.get().map_err(|error| error.to_string())?;
        search(cache, &conn, model, Query::Vector(&vector), &scope, relevance, ensure_enabled)
    })
    .await
    .map_err(|error| error.to_string())?;
    cache.touch();
    outcome
}

/// "Find similar content" (§7.2): photos of `scope` whose content is closest to the photo `photoId` (left out of the results).
/// `relevance`: optional Δ (see `search`). Errors: `semantic_disabled`, `semantic_photo_not_analysed`, or a message.
#[tauri::command]
pub async fn semantic_search_image(
    state: State<'_, AppState>,
    photo_id: i64,
    scope: SearchScope,
    relevance: Option<f32>,
) -> Result<SearchResults, String> {
    ensure_enabled()?;
    let pool = state.pool();
    let cache = cache();
    cache.touch();
    let outcome = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|error| error.to_string())?;
        search(cache, &conn, active_model(), Query::Photo(photo_id), &scope, relevance, ensure_enabled)
    })
    .await
    .map_err(|error| error.to_string())?;
    cache.touch(); // the idle delay counts from the end of the search
    outcome
}

#[cfg(test)]
#[path = "tests/semantic_search.rs"]
mod tests;
