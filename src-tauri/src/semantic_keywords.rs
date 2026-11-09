//! Keyword suggestions of the semantic search (spec dev_tools/Evolutions/feat semantic search SigLIP 2.md, §8; decisions and measures
//! in §23). Nothing here writes a keyword: the interface turns an accepted suggestion into a pending keyword, as if it were typed.
//!
//! - Examples score of a photo for a keyword that has at least `MIN_EXAMPLES` tagged photos with an embedding: the mean of its cosines
//!   with its `NEAREST` closest tagged photos (`semantic_search::Query::Examples`). Chosen over the cosine with the centroid of the
//!   tagged photos on a real catalogue (§23.2): better in both directions, because a keyword whose photos form several groups (a place
//!   by day and by night, an event indoors and outdoors) is not averaged into one blurred point.
//! - Text score (fewer examples, keyword → photos only): cosine with the embedding of the keyword name, normalised as a text query. It is
//!   not used for the suggestions of a photo: over a whole vocabulary of user keywords (mostly proper names) its precision is below 1 %.
//! - Thresholds: one per direction and kind, measured in §23.2 (constants below). Keyword → photos with examples uses the spread of the
//!   keyword's own photos, so a keyword with few examples (lower scores) is not emptied by a fixed threshold.
//! - Memory and storage (§23.3): nothing is stored in the database besides the dismissed suggestions. Keyword → photos reads its examples
//!   from the index at each request and encodes the name when needed (~37 ms, text encoder of the text search). Photo → keywords keeps
//!   the index rows of the tagged photos of each eligible leaf (`SuggestionModel`) in the search cache: rebuilt when the index or the
//!   keywords changed, released with the index (§5.2). Nothing exists before the first request.

use rayon::prelude::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::State;

use crate::keywords::collect_rows;
use crate::semantic_models::{active_model, ensure_enabled, ModelSpec};
use crate::semantic_search::{
    cache, load_text_encoder, mean_of_nearest, prepare_query, search_excluding, Index, Query, SearchCache, SearchResults, SearchScope, NEAREST,
    PHOTO_NOT_ANALYSED_ERROR,
};
use crate::AppState;

/// A keyword needs this many tagged photos with an embedding for its examples score; below, keyword → photos uses its name (§8.1).
pub const MIN_EXAMPLES: usize = 5;

/// At most this many tagged photos are compared with each candidate (spread over the tagged photos): bounds the cost of keyword → photos
/// for a keyword carried by thousands of photos (100,000 photos × 256 examples, §23.4).
pub const MAX_EXAMPLES: usize = 256;

/// Photo → keywords: a keyword is suggested when its examples score reaches this (§23.2: precision 0.90 of the top 5, recall 0.86).
pub const SUGGESTION_THRESHOLD: f32 = 0.80;

/// Keyword → photos with examples: a photo is a candidate when its score reaches this quantile of the scores of the keyword's own photos
/// (each against the others, §23.2: 90 % of the hidden tagged photos found with half of the examples).
pub const CANDIDATE_QUANTILE: f64 = 0.10;

/// Keyword → photos by the name (fewer than `MIN_EXAMPLES` examples): cosine floor (§23.2: half of the tagged photos are above it).
pub const TEXT_THRESHOLD: f32 = 0.07;

/// Suggestions of one photo (§8.2-2).
pub const MAX_SUGGESTIONS: usize = 5;

/// Error key: the keyword is not (or no longer) in the tree (same key as the keyword commands).
pub const UNKNOWN_KEYWORD_ERROR: &str = "unknown_keyword";

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/// Changes of the keyword tables (photo ↔ keyword links, tree): a suggestion model built before a change is rebuilt.
static KEYWORDS_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Called by keywords.rs whenever `photo_keywords` or `keyword_nodes` change (files read or written, keyword created, renamed, deleted).
/// A single atomic increment: no cost when the semantic search is off.
pub fn on_keywords_changed() {
    KEYWORDS_GENERATION.fetch_add(1, Ordering::SeqCst);
}

fn keywords_generation() -> u64 {
    KEYWORDS_GENERATION.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/// At most `max` of `ids`, spread evenly over the list (deterministic: the same examples for the same tagged photos).
pub fn spread(ids: &[i64], max: usize) -> Vec<i64> {
    if ids.len() <= max { return ids.to_vec(); }
    (0..max).map(|i| ids[i * ids.len() / max]).collect()
}

/// Value at quantile `q` (0 to 1, nearest rank) of a sorted list.
fn quantile(sorted: &[f32], q: f64) -> Option<f32> {
    if sorted.is_empty() { return None; }
    Some(sorted[((sorted.len() - 1) as f64 * q.clamp(0.0, 1.0)).round() as usize])
}

/// Candidate threshold of a keyword from its own examples: the examples score of each example against the others (leave one out), at
/// quantile `q`. "A photo is a candidate when it is at least as close to the examples as the least typical tenth of them are to each
/// other." None with fewer than two examples.
pub fn own_threshold(examples: &[Vec<f32>], q: f64) -> Option<f32> {
    if examples.len() < 2 { return None; }
    let mut own: Vec<f32> = (0..examples.len())
        .into_par_iter()
        .filter_map(|i| {
            let others = examples.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, other)| crate::semantic_search::dot_f32(&examples[i], other));
            mean_of_nearest(others, NEAREST)
        })
        .collect();
    own.sort_by(|a, b| a.total_cmp(b));
    quantile(&own, q)
}

// ---------------------------------------------------------------------------
// Keyword → photos (§8.2-1)
// ---------------------------------------------------------------------------

/// Which score ranked the candidates.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScoreKind {
    /// Mean cosine with the nearest tagged photos.
    Examples,
    /// Cosine with the keyword name.
    Text,
}

/// Answer of `semantic_keyword_candidates`: the fields of a search (§18.1), plus the score used.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeywordCandidates {
    pub kind: ScoreKind,
    /// Photos tagged with the keyword that have an embedding (the examples when there are at least `MIN_EXAMPLES`).
    pub examples: usize,
    /// Score a result reaches (already applied to `results`).
    pub threshold: f32,
    #[serde(flatten)]
    pub search: SearchResults,
}

fn keyword_name(conn: &Connection, keyword_id: i64) -> Result<String, String> {
    conn.query_row("SELECT name FROM keyword_nodes WHERE id = ?1", params![keyword_id], |row| row.get(0))
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| UNKNOWN_KEYWORD_ERROR.to_string())
}

/// First column of every row of `sql` (photo or keyword ids).
fn ids<P: rusqlite::Params>(conn: &Connection, sql: &str, parameters: P) -> Result<Vec<i64>, String> {
    let mut statement = conn.prepare(sql).map_err(|error| error.to_string())?;
    let rows = statement.query_map(parameters, |row| row.get(0)).map_err(|error| error.to_string())?;
    collect_rows(rows)
}

/// Photos of `scope` that may deserve `keyword_id` (§8.2-1): never a photo that carries it or whose suggestion was dismissed, sorted by
/// decreasing score, cut at the threshold of the score used. `embed_name` encodes the normalised keyword name (text score only: the
/// examples score needs no model). `gate` as for `search`. Errors: `unknown_keyword`, `semantic_empty_query` (a name with nothing to
/// encode), the errors of `embed_name`, or a message.
pub fn keyword_candidates(
    cache: &SearchCache,
    conn: &Connection,
    model: &ModelSpec,
    keyword_id: i64,
    scope: &SearchScope,
    embed_name: &mut dyn FnMut(&str) -> Result<Vec<f32>, String>,
    gate: fn() -> Result<(), String>,
) -> Result<KeywordCandidates, String> {
    let name = keyword_name(conn, keyword_id)?;
    let tagged = ids(
        conn,
        "SELECT pk.photo_id FROM photo_keywords pk JOIN photos p ON p.id = pk.photo_id WHERE pk.keyword_id = ?1 ORDER BY pk.photo_id",
        params![keyword_id],
    )?;
    let mut exclude: HashSet<i64> = tagged.iter().copied().collect();
    exclude.extend(ids(conn, "SELECT photo_id FROM keyword_suggestion_rejections WHERE keyword_id = ?1", params![keyword_id])?);

    let load = || {
        gate()?;
        Index::load(conn, &model.id, model.embed_dim)
    };
    let (count, examples) = cache.with_index(model, load, |index| {
        let analysed: Vec<i64> = tagged.iter().copied().filter(|id| index.row_of(*id).is_some()).collect();
        let examples: Vec<Vec<f32>> = spread(&analysed, MAX_EXAMPLES).into_iter().filter_map(|id| index.vector(id)).collect();
        (analysed.len(), examples)
    })?;

    let (kind, threshold, mut search) = if count >= MIN_EXAMPLES {
        let threshold = own_threshold(&examples, CANDIDATE_QUANTILE).unwrap_or(f32::NEG_INFINITY);
        (ScoreKind::Examples, threshold, search_excluding(cache, conn, model, Query::Examples(&examples), scope, None, gate, &exclude)?)
    } else {
        let vector = embed_name(&prepare_query(&name, model)?)?;
        (ScoreKind::Text, TEXT_THRESHOLD, search_excluding(cache, conn, model, Query::Vector(&vector), scope, None, gate, &exclude)?)
    };
    // Sorted by decreasing score: the threshold keeps a prefix, and `best` stays the score of the first result.
    let kept = search.results.partition_point(|hit| hit.cos >= threshold);
    search.results.truncate(kept);
    search.best = search.results.first().map(|hit| hit.cos);
    Ok(KeywordCandidates { kind, examples: count, threshold, search })
}

/// "Find photos that may match" (§8.2-1): photos of `scope` (as for the searches, §18.1) that are neither tagged with `keywordId` nor
/// dismissed for it, best first, above the threshold. A keyword with fewer than 5 analysed photos is matched by its name: the first such
/// request loads the text encoder (~1.5 s). Errors: `semantic_disabled`, `unknown_keyword`, `semantic_empty_query`, `semantic_model_missing`,
/// `semantic_unsupported_platform` (the last two: name only), or a message.
#[tauri::command]
pub async fn semantic_keyword_candidates(state: State<'_, AppState>, keyword_id: i64, scope: SearchScope) -> Result<KeywordCandidates, String> {
    ensure_enabled()?;
    let model = active_model();
    let pool = state.pool();
    let models_dir = crate::face_models::models_dir(&state);
    let cache = cache();
    cache.touch();
    let outcome = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|error| error.to_string())?;
        let mut embed_name = |text: &str| {
            // Checked again right before loading the model (see semantic_search_text).
            cache.embed_text(
                || {
                    ensure_enabled()?;
                    load_text_encoder(&models_dir, model)
                },
                text,
            )
        };
        keyword_candidates(cache, &conn, model, keyword_id, &scope, &mut embed_name, ensure_enabled)
    })
    .await
    .map_err(|error| error.to_string())?;
    cache.touch();
    outcome
}

// ---------------------------------------------------------------------------
// Photo → keywords (§8.2-2)
// ---------------------------------------------------------------------------

/// What the suggestions of a photo need besides the index: for every leaf of the tree with at least `MIN_EXAMPLES` tagged photos in the
/// index, the rows of those photos. Valid for one state of the index (`Index::version`) and of the keyword tables.
pub struct SuggestionModel {
    index_version: (u64, u64),
    keywords_generation: u64,
    /// (keyword id, index rows of its tagged photos), by keyword id.
    keywords: Vec<(i64, Vec<u32>)>,
}

impl SuggestionModel {
    /// Reads the links of the leaves (photos still in the catalogue) and keeps those of analysed photos.
    fn build(conn: &Connection, index: &Index) -> Result<Self, String> {
        // Read before the rows: a change during the build makes this model outdated, so it is built again next time.
        let keywords_generation = keywords_generation();
        let mut statement = conn
            .prepare(
                "SELECT pk.keyword_id, pk.photo_id FROM photo_keywords pk
                 JOIN photos p ON p.id = pk.photo_id
                 JOIN keyword_nodes k ON k.id = pk.keyword_id
                 WHERE NOT EXISTS (SELECT 1 FROM keyword_nodes c WHERE c.parent_id = pk.keyword_id)",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement.query([]).map_err(|error| error.to_string())?;
        let mut by_keyword: HashMap<i64, Vec<u32>> = HashMap::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let keyword_id: i64 = row.get(0).map_err(|error| error.to_string())?;
            let photo_id: i64 = row.get(1).map_err(|error| error.to_string())?;
            if let Some(index_row) = index.row_of(photo_id) { by_keyword.entry(keyword_id).or_default().push(index_row as u32); }
        }
        let mut keywords: Vec<(i64, Vec<u32>)> = by_keyword.into_iter().filter(|(_, rows)| rows.len() >= MIN_EXAMPLES).collect();
        keywords.sort_unstable_by_key(|(keyword_id, _)| *keyword_id);
        Ok(SuggestionModel { index_version: index.version(), keywords_generation, keywords })
    }

    fn is_current(&self, index: &Index) -> bool {
        self.index_version == index.version() && self.keywords_generation == keywords_generation()
    }
}

/// One suggested keyword.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub keyword_id: i64,
    /// Examples score (mean cosine with the nearest tagged photos), at least `SUGGESTION_THRESHOLD`.
    pub score: f32,
    /// Analysed photos tagged with the keyword.
    pub examples: usize,
}

/// Answer of `semantic_photo_suggestions`.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PhotoSuggestions {
    /// At most `MAX_SUGGESTIONS`, by decreasing score (ties by keyword id).
    pub suggestions: Vec<Suggestion>,
    /// Leaves that can be suggested at all (at least `MIN_EXAMPLES` analysed photos), before the exclusions of this photo.
    pub eligible: usize,
}

/// Keywords that `photo_id` may deserve (§8.2-2): leaves of the tree with at least `MIN_EXAMPLES` analysed photos, never one the photo
/// carries, one dismissed for it, or the keyword of a person (no identity in this model: that is the faces feature). Errors:
/// `semantic_photo_not_analysed`, or a message.
pub fn photo_suggestions(cache: &SearchCache, conn: &Connection, model: &ModelSpec, photo_id: i64, gate: fn() -> Result<(), String>) -> Result<PhotoSuggestions, String> {
    let in_catalogue: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM photos WHERE id = ?1)", params![photo_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if !in_catalogue { return Err(PHOTO_NOT_ANALYSED_ERROR.to_string()); }
    let mut excluded: HashSet<i64> = ids(conn, "SELECT keyword_id FROM photo_keywords WHERE photo_id = ?1", params![photo_id])?.into_iter().collect();
    excluded.extend(ids(conn, "SELECT keyword_id FROM keyword_suggestion_rejections WHERE photo_id = ?1", params![photo_id])?);
    excluded.extend(ids(conn, "SELECT keyword_node_id FROM persons WHERE keyword_node_id IS NOT NULL", [])?);

    let load = || {
        gate()?;
        Index::load(conn, &model.id, model.embed_dim)
    };
    cache.with_index(model, load, |index| -> Result<PhotoSuggestions, String> {
        let own_row = index.row_of(photo_id).ok_or_else(|| PHOTO_NOT_ANALYSED_ERROR.to_string())?;
        let vector = index.vector(photo_id).ok_or_else(|| PHOTO_NOT_ANALYSED_ERROR.to_string())?;
        let mut slot = cache.suggestions();
        if !slot.as_ref().is_some_and(|built| built.is_current(index)) {
            *slot = None; // never two models in memory
            *slot = Some(SuggestionModel::build(conn, index)?);
        }
        let built = slot.as_ref().expect("built above");
        let dots = index.dots(&vector);
        let mut suggestions: Vec<Suggestion> = built
            .keywords
            .par_iter()
            .filter(|(keyword_id, _)| !excluded.contains(keyword_id))
            .filter_map(|(keyword_id, rows)| {
                let neighbours = rows.iter().map(|&row| row as usize).filter(|&row| row != own_row).filter_map(|row| dots.get(row).copied());
                let score = mean_of_nearest(neighbours, NEAREST)?;
                (score >= SUGGESTION_THRESHOLD).then_some(Suggestion { keyword_id: *keyword_id, score, examples: rows.len() })
            })
            .collect();
        suggestions.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.keyword_id.cmp(&b.keyword_id)));
        suggestions.truncate(MAX_SUGGESTIONS);
        Ok(PhotoSuggestions { suggestions, eligible: built.keywords.len() })
    })?
}

/// "Suggestions" block of the right panel (§8.2-2), for one selected photo: at most 5 keywords. The first request (and the first after a
/// change of the keywords or of the analysis) reads the keyword links; the next ones only score (§23.4). Errors: `semantic_disabled`,
/// `semantic_photo_not_analysed`, or a message.
#[tauri::command]
pub async fn semantic_photo_suggestions(state: State<'_, AppState>, photo_id: i64) -> Result<PhotoSuggestions, String> {
    ensure_enabled()?;
    let pool = state.pool();
    let cache = cache();
    cache.touch();
    let outcome = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|error| error.to_string())?;
        photo_suggestions(cache, &conn, active_model(), photo_id, ensure_enabled)
    })
    .await
    .map_err(|error| error.to_string())?;
    cache.touch();
    outcome
}

// ---------------------------------------------------------------------------
// Dismissed suggestions (§8.3)
// ---------------------------------------------------------------------------

/// Records that `keyword_id` must not be suggested again for these photos (photos not in the catalogue are ignored). Returns the number
/// of new rows. Error: `unknown_keyword`.
pub fn reject(conn: &Connection, photo_ids: &[i64], keyword_id: i64) -> Result<usize, String> {
    keyword_name(conn, keyword_id)?;
    let ids_json = serde_json::to_string(photo_ids).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO keyword_suggestion_rejections (photo_id, keyword_id)
         SELECT id, ?2 FROM photos WHERE id IN (SELECT value FROM json_each(?1))",
        params![ids_json, keyword_id],
    )
    .map_err(|error| error.to_string())
}

/// "Not this keyword" (§8.2): the keyword is no longer suggested for these photos, in either direction. The rows go with the keyword when
/// it is deleted, and with "Delete analysis data". Errors: `semantic_disabled`, `unknown_keyword`, or a message.
#[tauri::command(async)]
pub fn reject_keyword_suggestion(state: State<'_, AppState>, photo_ids: Vec<i64>, keyword_id: i64) -> Result<usize, String> {
    ensure_enabled()?;
    let conn = state.pool().get().map_err(|error| error.to_string())?;
    reject(&conn, &photo_ids, keyword_id)
}

#[cfg(test)]
#[path = "tests/semantic_keywords.rs"]
mod tests;
