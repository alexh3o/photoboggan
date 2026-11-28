//! Background duplicate hash precomputation, pre-flight work counting, settings stats, deletion, and list-view exact hash states.
//!
//! Runs in the shared low-priority background lane (`semantic::background_busy`), commits in chunks of `HASH_CHUNK_SIZE` (128),
//! yields to foreground work and interactive duplicate searches (`BackgroundPauseGuard`), and records per-file failures.

use std::collections::HashSet;
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{Emitter, State};

use crate::db::DbPool;
use crate::duplicates::{
    self, write_failure_log, HashFailure, Scope, HASH_CHUNK_SIZE, LAYOUT_VERSION, MAX_REPORTED_FAILURES,
};
use crate::phash::{self, Failure, Fingerprint, ALGO_VERSION};
use crate::similar;
use crate::AppState;

// ---------------------------------------------------------------------------
// Single-slot precompute guard & chunk coordination with interactive search
// ---------------------------------------------------------------------------

pub const PRECOMPUTE_RUNNING_ERROR: &str = "hash_precompute_running";

static CURRENT_PRECOMPUTE: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

fn current_precompute() -> std::sync::MutexGuard<'static, Option<Arc<AtomicBool>>> {
    CURRENT_PRECOMPUTE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct PrecomputeSlot;

impl PrecomputeSlot {
    fn take(cancel: &Arc<AtomicBool>) -> Option<Self> {
        let mut current = current_precompute();
        if current.is_some() {
            return None;
        }
        *current = Some(cancel.clone());
        Some(PrecomputeSlot)
    }
}

impl Drop for PrecomputeSlot {
    fn drop(&mut self) {
        *current_precompute() = None;
    }
}

pub fn cancel_running_precompute() {
    if let Some(flag) = current_precompute().as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
}

pub fn stop_precompute_and_wait() -> Result<(), String> {
    cancel_running_precompute();
    let started = Instant::now();
    while current_precompute().is_some() {
        if started.elapsed() > Duration::from_secs(60) {
            return Err(PRECOMPUTE_RUNNING_ERROR.to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

fn chunk_gate() -> &'static (Mutex<bool>, Condvar) {
    static GATE: OnceLock<(Mutex<bool>, Condvar)> = OnceLock::new();
    GATE.get_or_init(|| (Mutex::new(false), Condvar::new()))
}

struct ChunkActiveGuard;

impl ChunkActiveGuard {
    fn enter() -> Self {
        let (lock, _) = chunk_gate();
        *lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = true;
        ChunkActiveGuard
    }
}

impl Drop for ChunkActiveGuard {
    fn drop(&mut self) {
        let (lock, condvar) = chunk_gate();
        *lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = false;
        condvar.notify_all();
    }
}

/// Waits until any active precompute chunk finishes and commits before an interactive duplicate search reads the cache.
pub(crate) fn wait_for_precompute_chunk(cancel: &AtomicBool) {
    let (lock, condvar) = chunk_gate();
    let mut active = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    while *active {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let (guard, _) = condvar
            .wait_timeout(active, Duration::from_millis(100))
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        active = guard;
    }
}

// ---------------------------------------------------------------------------
// Precomputation kinds & progress/report payloads
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExactMode {
    None,
    Prepass,
    Full,
}

#[derive(Clone, Copy)]
pub(crate) struct PrecomputeMode {
    exact: ExactMode,
    similarity: bool,
}

impl PrecomputeMode {
    pub(crate) fn parse(kind: &str) -> Result<Self, String> {
        match kind {
            "exact_prepass" => Ok(Self { exact: ExactMode::Prepass, similarity: false }),
            "exact_full" => Ok(Self { exact: ExactMode::Full, similarity: false }),
            "similarity" => Ok(Self { exact: ExactMode::None, similarity: true }),
            "both_prepass" => Ok(Self { exact: ExactMode::Prepass, similarity: true }),
            "both_full" => Ok(Self { exact: ExactMode::Full, similarity: true }),
            other => Err(format!("Unknown hash precompute kind: {other}")),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrecomputeProgress {
    pub task_id: String,
    pub percent: u32,
    pub done: usize,
    pub total: usize,
    pub remaining_seconds: Option<u64>,
    pub paused: bool,
    pub phase: &'static str,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrecomputeReport {
    pub total: usize,
    pub computed: usize,
    pub up_to_date: usize,
    pub skipped: usize,
    pub failures: Vec<HashFailure>,
    pub failures_total: usize,
    pub log_path: Option<String>,
    pub cancelled: bool,
}

struct TargetPhoto {
    id: i64,
    path: String,
    need_exact: bool,
    need_similarity: bool,
}

fn load_scope_photos(conn: &Connection, scope: Option<&Scope>, include_raw: bool) -> Result<Vec<(i64, String, u64, i64)>, String> {
    let normalize = |path: &str| path.replace('\\', "/");
    let read = |stmt: &mut rusqlite::Statement, args: &[&dyn rusqlite::ToSql]| -> Result<Vec<(i64, String, u64, i64)>, String> {
        let rows = stmt
            .query_map(args, |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?.max(0) as u64,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
    };

    const COLS: &str = "id, path, COALESCE(file_size, 0), COALESCE(modified, 0)";
    let mut rows = match scope {
        None | Some(Scope::All) => {
            read(&mut conn.prepare(&format!("SELECT {COLS} FROM photos WHERE path IS NOT NULL")).map_err(|e| e.to_string())?, &[])?
        }
        Some(Scope::Folder { path, recursive }) => {
            let prefix = format!("{}/", normalize(path).trim_end_matches('/'));
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {COLS} FROM photos WHERE path IS NOT NULL
                     AND substr(replace(path, char(92), '/'), 1, length(?1)) = ?1
                     AND (?2 OR instr(substr(replace(path, char(92), '/'), length(?1) + 1), '/') = 0)"
                ))
                .map_err(|e| e.to_string())?;
            read(&mut stmt, &[&prefix, recursive])?
        }
        Some(Scope::Paths { paths }) => {
            let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM photos WHERE path = ?1")).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for path in paths {
                out.extend(read(&mut stmt, &[path])?);
            }
            out
        }
    };
    rows.retain(|(_, path, _, _)| {
        let p = Path::new(path);
        !duplicates::is_video(p) && (include_raw || !crate::thumbnails::is_raw_path(p))
    });
    Ok(rows)
}

fn exact_uptodate_set(conn: &Connection, full: bool) -> Result<HashSet<i64>, String> {
    let sql = if full {
        "SELECT h.photo_id FROM photo_hashes h JOIN photos p ON p.id = h.photo_id
         WHERE h.mode = 1 AND h.version = ?1 AND h.full_hash IS NOT NULL
         AND h.size = COALESCE(p.file_size, 0) AND h.modified = COALESCE(p.modified, 0)"
    } else {
        "SELECT h.photo_id FROM photo_hashes h JOIN photos p ON p.id = h.photo_id
         WHERE h.mode = 1 AND h.version = ?1
         AND h.size = COALESCE(p.file_size, 0) AND h.modified = COALESCE(p.modified, 0)"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![LAYOUT_VERSION], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<HashSet<_>>>().map_err(|e| e.to_string())
}

fn exact_failed_set(conn: &Connection) -> Result<HashSet<i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.photo_id FROM photo_hash_failures f JOIN photos p ON p.id = f.photo_id
             WHERE f.mode = 1 AND f.version = ?1 AND f.size = COALESCE(p.file_size, 0) AND f.modified = COALESCE(p.modified, 0)",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![LAYOUT_VERSION], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<HashSet<_>>>().map_err(|e| e.to_string())
}

fn similarity_uptodate_set(conn: &Connection) -> Result<HashSet<i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT h.photo_id FROM photo_phash h JOIN photos p ON p.id = h.photo_id
             WHERE h.algo = ?1 AND h.size = COALESCE(p.file_size, 0) AND h.modified = COALESCE(p.modified, 0)",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![ALGO_VERSION], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<HashSet<_>>>().map_err(|e| e.to_string())
}

fn similarity_failed_set(conn: &Connection) -> Result<HashSet<i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.photo_id FROM photo_phash_failures f JOIN photos p ON p.id = f.photo_id
             WHERE f.algo = ?1 AND f.size = COALESCE(p.file_size, 0) AND f.modified = COALESCE(p.modified, 0)",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![ALGO_VERSION], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<HashSet<_>>>().map_err(|e| e.to_string())
}

enum PhotoWorkOutcome {
    Computed {
        id: i64,
        prepass: Option<(u64, i64, u64, bool)>,
        full: Option<duplicates::DataHash>,
        phash: Option<(u64, i64, Fingerprint)>,
    },
    Skipped,
    Failed {
        id: i64,
        path: String,
        size: u64,
        modified: i64,
        exact_err: Option<String>,
        phash_err: Option<String>,
    },
}

pub(crate) fn run_precompute(
    pool: &DbPool,
    thumbnails_dir: &Path,
    base_dir: Option<&Path>,
    mode: PrecomputeMode,
    include_raw: bool,
    scope: Option<&Scope>,
    threads: Option<&str>,
    cancel: &AtomicBool,
    emit: &dyn Fn(PrecomputeProgress),
) -> Result<PrecomputeReport, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute_batch(
        "DELETE FROM photo_hashes WHERE photo_id NOT IN (SELECT id FROM photos);
         DELETE FROM photo_hash_failures WHERE photo_id NOT IN (SELECT id FROM photos);
         DELETE FROM photo_phash WHERE photo_id NOT IN (SELECT id FROM photos);
         DELETE FROM photo_phash_failures WHERE photo_id NOT IN (SELECT id FROM photos);",
    )
    .map_err(|e| e.to_string())?;

    let mut rows = load_scope_photos(&conn, scope, include_raw)?;
    if mode.exact == ExactMode::None && mode.similarity {
        rows.retain(|(_, path, _, _)| similar::is_phash_supported(Path::new(path)));
    }
    let total_eligible = rows.len();

    let exact_ok = if mode.exact == ExactMode::None {
        HashSet::new()
    } else {
        exact_uptodate_set(&conn, mode.exact == ExactMode::Full)?
    };
    let exact_fail = if mode.exact == ExactMode::None { HashSet::new() } else { exact_failed_set(&conn)? };
    let sim_ok = if mode.similarity { similarity_uptodate_set(&conn)? } else { HashSet::new() };
    let sim_fail = if mode.similarity { similarity_failed_set(&conn)? } else { HashSet::new() };

    let mut pending: Vec<TargetPhoto> = Vec::new();
    for (id, path, _size, _modified) in rows {
        let need_exact = mode.exact != ExactMode::None && !exact_ok.contains(&id) && !exact_fail.contains(&id);
        let need_similarity = mode.similarity
            && similar::is_phash_supported(Path::new(&path))
            && !sim_ok.contains(&id)
            && !sim_fail.contains(&id);
        if need_exact || need_similarity {
            pending.push(TargetPhoto { id, path, need_exact, need_similarity });
        }
    }

    let mut report = PrecomputeReport {
        total: total_eligible,
        up_to_date: total_eligible.saturating_sub(pending.len()),
        ..PrecomputeReport::default()
    };
    if pending.is_empty() {
        return Ok(report);
    }

    let worker_threads = crate::semantic::resolve_hash_threads(threads, false);
    let workers = crate::semantic::build_low_priority_pool(worker_threads)?;

    let pending_total = pending.len();
    let mut done = 0usize;
    let mut busy = Duration::ZERO;
    let mut failures: Vec<HashFailure> = Vec::new();

    for chunk in pending.chunks(HASH_CHUNK_SIZE) {
        if !crate::semantic::wait_while_busy(crate::semantic::background_busy, cancel, &mut || {
            emit(PrecomputeProgress {
                task_id: String::new(),
                percent: (done * 100 / pending_total) as u32,
                done,
                total: pending_total,
                remaining_seconds: (done > 0).then(|| (busy.as_secs_f64() / done as f64 * (pending_total - done) as f64).round() as u64),
                paused: true,
                phase: "hashing",
            });
        }) {
            report.cancelled = true;
            break;
        }

        let chunk_guard = ChunkActiveGuard::enter();
        let chunk_started = Instant::now();

        // Re-check DB in case an interactive duplicate search computed some of these while we were paused.
        let fresh_exact_ok = if mode.exact == ExactMode::None {
            HashSet::new()
        } else {
            exact_uptodate_set(&conn, mode.exact == ExactMode::Full)?
        };
        let fresh_sim_ok = if mode.similarity { similarity_uptodate_set(&conn)? } else { HashSet::new() };

        let results: Vec<PhotoWorkOutcome> = workers.install(|| {
            chunk
                .par_iter()
                .map(|target| {
                    if cancel.load(Ordering::Relaxed) {
                        return PhotoWorkOutcome::Skipped;
                    }
                    let need_exact = target.need_exact && !fresh_exact_ok.contains(&target.id);
                    let need_sim = target.need_similarity && !fresh_sim_ok.contains(&target.id);
                    if !need_exact && !need_sim {
                        return PhotoWorkOutcome::Skipped;
                    }
                    let path = Path::new(&target.path);
                    let Ok(meta) = fs::metadata(path) else {
                        return PhotoWorkOutcome::Skipped;
                    };
                    let size = meta.len();
                    let modified = crate::library_sync::modified_millis(&meta);
                    if size == 0 {
                        return PhotoWorkOutcome::Failed {
                            id: target.id,
                            path: target.path.clone(),
                            size,
                            modified,
                            exact_err: need_exact.then(|| "empty file".to_string()),
                            phash_err: need_sim.then(|| "empty file".to_string()),
                        };
                    }

                    let mut prepass = None;
                    let mut full = None;
                    let mut exact_err = None;
                    if need_exact {
                        match mode.exact {
                            ExactMode::Prepass => {
                                match panic::catch_unwind(AssertUnwindSafe(|| duplicates::prepass_layout(path, true))) {
                                    Ok(Ok((sz, mod_ms, data_len, tolerant))) => prepass = Some((sz, mod_ms, data_len, tolerant)),
                                    Ok(Err(e)) => {
                                        if e.kind() != std::io::ErrorKind::NotFound {
                                            exact_err = Some(e.to_string());
                                        }
                                    }
                                    Err(_) => exact_err = Some("internal error while reading the file".to_string()),
                                }
                            }
                            ExactMode::Full => {
                                match panic::catch_unwind(AssertUnwindSafe(|| duplicates::image_data_hash(path, cancel))) {
                                    Ok(Ok(data)) => full = Some(data),
                                    Ok(Err(e)) => {
                                        if e.kind() != std::io::ErrorKind::NotFound && e.kind() != std::io::ErrorKind::Interrupted {
                                            exact_err = Some(e.to_string());
                                        }
                                    }
                                    Err(_) => exact_err = Some("internal error while reading the file".to_string()),
                                }
                            }
                            ExactMode::None => {}
                        }
                    }

                    let mut phash_res = None;
                    let mut phash_err = None;
                    if need_sim && !cancel.load(Ordering::Relaxed) {
                        match panic::catch_unwind(AssertUnwindSafe(|| phash::fingerprint_file(path, thumbnails_dir))) {
                            Ok(Ok(fp)) => phash_res = Some((size, modified, fp)),
                            Ok(Err(Failure::Unsupported)) => {}
                            Ok(Err(Failure::Unreadable)) => {
                                if path.exists() {
                                    phash_err = Some("unreadable or corrupt image".to_string());
                                }
                            }
                            Err(_) => phash_err = Some("internal error while decoding the file".to_string()),
                        }
                    }

                    if exact_err.is_some() || phash_err.is_some() {
                        PhotoWorkOutcome::Failed {
                            id: target.id,
                            path: target.path.clone(),
                            size,
                            modified,
                            exact_err,
                            phash_err,
                        }
                    } else if prepass.is_none() && full.is_none() && phash_res.is_none() {
                        PhotoWorkOutcome::Skipped
                    } else {
                        PhotoWorkOutcome::Computed {
                            id: target.id,
                            prepass,
                            full,
                            phash: phash_res,
                        }
                    }
                })
                .collect()
        });

        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for outcome in results {
            match outcome {
                PhotoWorkOutcome::Computed { id, prepass, full, phash } => {
                    report.computed += 1;
                    if let Some((sz, mod_ms, data_len, tolerant)) = prepass {
                        duplicates::remember_prepass(&tx, id, 1, sz, mod_ms, data_len, tolerant).map_err(|e| e.to_string())?;
                    }
                    if let Some(data) = full {
                        duplicates::remember_data_hash(&tx, id, &data).map_err(|e| e.to_string())?;
                    }
                    if let Some((sz, mod_ms, fp)) = phash {
                        similar::save_phash_row(&tx, id, sz, mod_ms, &fp).map_err(|e| e.to_string())?;
                    }
                }
                PhotoWorkOutcome::Skipped => {
                    report.skipped += 1;
                }
                PhotoWorkOutcome::Failed { id, path, size, modified, exact_err, phash_err } => {
                    let msg = exact_err.as_deref().or(phash_err.as_deref()).unwrap_or("unreadable file").to_string();
                    failures.push(HashFailure { path, error: msg });
                    if let Some(err) = exact_err {
                        if size > 0 {
                            duplicates::save_hash_failure(&tx, id, 1, size, modified, &err).map_err(|e| e.to_string())?;
                        }
                    }
                    if let Some(err) = phash_err {
                        if size > 0 {
                            similar::save_phash_failure(&tx, id, size, modified, &err).map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        drop(chunk_guard);

        busy += chunk_started.elapsed();
        done += chunk.len();
        emit(PrecomputeProgress {
            task_id: String::new(),
            percent: (done * 100 / pending_total) as u32,
            done,
            total: pending_total,
            remaining_seconds: (done > 0).then(|| (busy.as_secs_f64() / done as f64 * (pending_total - done) as f64).round() as u64),
            paused: false,
            phase: "hashing",
        });

        if cancel.load(Ordering::Relaxed) {
            report.cancelled = true;
            break;
        }
    }

    report.failures_total = failures.len();
    report.log_path = base_dir.and_then(|dir| write_failure_log(dir, "hashes", &failures));
    failures.truncate(MAX_REPORTED_FAILURES);
    report.failures = failures;
    Ok(report)
}

#[tauri::command]
pub async fn precompute_hashes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    kind: String,
    include_raw: bool,
    scope: Option<Scope>,
    threads: Option<String>,
) -> Result<PrecomputeReport, String> {
    let mode = PrecomputeMode::parse(&kind)?;
    let cancel = crate::scan_cancel_flag(&task_id);
    let outcome = async {
        let slot = PrecomputeSlot::take(&cancel).ok_or_else(|| PRECOMPUTE_RUNNING_ERROR.to_string())?;
        let pool = state.pool();
        let thumbnails_dir = state.thumbnails_dir();
        let base_dir = state.base_dir();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let worker_task_id = task_id.clone();
        std::thread::Builder::new()
            .name("hash-precompute".to_string())
            .spawn(move || {
                let _slot = slot;
                crate::semantic::lower_thread_priority();
                let emit = |mut progress: PrecomputeProgress| {
                    progress.task_id.clone_from(&worker_task_id);
                    let _ = app.emit("scan-progress", progress);
                };
                let _ = sender.send(run_precompute(
                    &pool,
                    &thumbnails_dir,
                    Some(&base_dir),
                    mode,
                    include_raw,
                    scope.as_ref(),
                    threads.as_deref(),
                    &cancel,
                    &emit,
                ));
            })
            .map_err(|error| error.to_string())?;
        receiver.await.map_err(|_| "hash precompute stopped unexpectedly".to_string())?
    }
    .await;
    crate::release_scan_cancel_flag(&task_id);
    outcome
}

// ---------------------------------------------------------------------------
// Pre-flight work count (warning dialog & modal coverage indicator)
// ---------------------------------------------------------------------------

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkCount {
    pub total: usize,
    pub up_to_date: usize,
    pub missing: usize,
    pub missing_raw: usize,
    pub unsupported: usize,
    pub fast_count: Option<usize>,
    pub fast_estimated: bool,
}

pub(crate) fn compute_work_count(
    conn: &Connection,
    thumbnails_dir: Option<&Path>,
    kind: &str,
    scope: &Scope,
    compare_with_library: bool,
    ignore_metadata: bool,
    include_raw: bool,
    check_fast: bool,
) -> Result<WorkCount, String> {
    let mut candidates = duplicates::load_candidates_filtered(conn, scope, compare_with_library, include_raw)?;
    let mut unsupported = 0usize;
    if kind == "similar" {
        let before = candidates.len();
        candidates.retain(|c| similar::is_phash_supported(Path::new(&c.path)));
        unsupported = before - candidates.len();
    }

    let ok_ids: HashSet<i64> = if kind == "similar" {
        let mut set = similarity_uptodate_set(conn)?;
        set.extend(similarity_failed_set(conn)?);
        set
    } else {
        let mode: i64 = i64::from(ignore_metadata);
        let mut stmt = conn
            .prepare(
                "SELECT h.photo_id FROM photo_hashes h JOIN photos p ON p.id = h.photo_id
                 WHERE h.mode = ?1 AND h.version = ?2 AND h.size = COALESCE(p.file_size, 0) AND h.modified = COALESCE(p.modified, 0)
                 UNION ALL
                 SELECT f.photo_id FROM photo_hash_failures f JOIN photos p ON p.id = f.photo_id
                 WHERE f.mode = ?1 AND f.version = ?2 AND f.size = COALESCE(p.file_size, 0) AND f.modified = COALESCE(p.modified, 0)",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![mode, LAYOUT_VERSION], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<HashSet<_>>>().map_err(|e| e.to_string())?
    };

    let mut missing_paths: Vec<String> = Vec::new();
    let mut missing_raw = 0usize;
    for c in &candidates {
        if !ok_ids.contains(&c.id) {
            if crate::thumbnails::is_raw_path(Path::new(&c.path)) {
                missing_raw += 1;
            }
            missing_paths.push(c.path.clone());
        }
    }
    let total = candidates.len();
    let missing = missing_paths.len();
    let up_to_date = total - missing;

    let (fast_count, fast_estimated) = if check_fast && kind == "similar" && missing > 0 {
        if let Some(dir) = thumbnails_dir {
            let started = Instant::now();
            let budget = Duration::from_millis(1500);
            let mut checked = 0usize;
            let mut fast = 0usize;
            let mut estimated = false;
            for chunk in missing_paths.chunks(256) {
                let hits: usize = chunk
                    .par_iter()
                    .filter(|path| crate::thumbnail_cache_file(dir, path).is_ok_and(|p| p.is_file()))
                    .count();
                fast += hits;
                checked += chunk.len();
                if checked < missing && started.elapsed() >= budget {
                    estimated = true;
                    break;
                }
            }
            let total_fast = if estimated && checked > 0 {
                ((fast as f64 / checked as f64) * missing as f64).round() as usize
            } else {
                fast
            };
            (Some(total_fast), estimated)
        } else {
            (None, false)
        }
    } else {
        (None, false)
    };

    Ok(WorkCount {
        total,
        up_to_date,
        missing,
        missing_raw,
        unsupported,
        fast_count,
        fast_estimated,
    })
}

#[tauri::command]
pub async fn count_duplicate_work(
    state: State<'_, AppState>,
    kind: String,
    scope: Scope,
    compare_with_library: bool,
    ignore_metadata: bool,
    include_raw: bool,
    check_fast: bool,
) -> Result<WorkCount, String> {
    let pool = state.pool();
    let thumbnails_dir = state.thumbnails_dir();
    tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|e| e.to_string())?;
        compute_work_count(&conn, Some(&thumbnails_dir), &kind, &scope, compare_with_library, ignore_metadata, include_raw, check_fast)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Settings stats, deletion, and list-view states
// ---------------------------------------------------------------------------

#[derive(Serialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HashKindStats {
    pub total: usize,
    pub non_raw_total: usize,
    pub up_to_date: usize,
    pub non_raw_up_to_date: usize,
    pub expired: usize,
    pub failed: usize,
}

#[derive(Serialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateHashStats {
    pub exact_prepass: HashKindStats,
    pub exact_full: HashKindStats,
    pub similarity: HashKindStats,
    pub bytes: u64,
}

pub(crate) fn compute_duplicate_hash_stats(conn: &Connection) -> Result<DuplicateHashStats, String> {
    let mut exact_prepass = HashKindStats::default();
    let mut exact_full = HashKindStats::default();
    let mut similarity = HashKindStats::default();

    let mut photo_stmt = conn.prepare("SELECT id, path FROM photos WHERE path IS NOT NULL").map_err(|e| e.to_string())?;
    let photo_rows = photo_stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;

    let mut raw_ids: HashSet<i64> = HashSet::new();
    let mut phash_eligible: HashSet<i64> = HashSet::new();
    for row in photo_rows {
        let (id, path) = row.map_err(|e| e.to_string())?;
        let p = Path::new(&path);
        if duplicates::is_video(p) {
            continue;
        }
        let is_raw = crate::thumbnails::is_raw_path(p);
        if is_raw {
            raw_ids.insert(id);
        }
        exact_prepass.total += 1;
        exact_full.total += 1;
        if !is_raw {
            exact_prepass.non_raw_total += 1;
            exact_full.non_raw_total += 1;
        }
        if similar::is_phash_supported(p) {
            phash_eligible.insert(id);
            similarity.total += 1;
            if !is_raw {
                similarity.non_raw_total += 1;
            }
        }
    }

    let mut hash_stmt = conn
        .prepare(
            "SELECT h.photo_id, h.full_hash IS NOT NULL,
                    h.version = ?1 AND h.size = COALESCE(p.file_size, 0) AND h.modified = COALESCE(p.modified, 0)
             FROM photo_hashes h JOIN photos p ON p.id = h.photo_id WHERE h.mode = 1",
        )
        .map_err(|e| e.to_string())?;
    let hash_rows = hash_stmt
        .query_map(params![LAYOUT_VERSION], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?, row.get::<_, bool>(2)?)))
        .map_err(|e| e.to_string())?;
    for row in hash_rows {
        let (id, has_full, current) = row.map_err(|e| e.to_string())?;
        let is_raw = raw_ids.contains(&id);
        if current {
            exact_prepass.up_to_date += 1;
            if !is_raw {
                exact_prepass.non_raw_up_to_date += 1;
            }
            if has_full {
                exact_full.up_to_date += 1;
                if !is_raw {
                    exact_full.non_raw_up_to_date += 1;
                }
            }
        } else {
            exact_prepass.expired += 1;
            if has_full {
                exact_full.expired += 1;
            }
        }
    }

    let mut phash_stmt = conn
        .prepare(
            "SELECT h.photo_id,
                    h.algo = ?1 AND h.size = COALESCE(p.file_size, 0) AND h.modified = COALESCE(p.modified, 0)
             FROM photo_phash h JOIN photos p ON p.id = h.photo_id",
        )
        .map_err(|e| e.to_string())?;
    let phash_rows = phash_stmt
        .query_map(params![ALGO_VERSION], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in phash_rows {
        let (id, current) = row.map_err(|e| e.to_string())?;
        if !phash_eligible.contains(&id) {
            continue;
        }
        let is_raw = raw_ids.contains(&id);
        if current {
            similarity.up_to_date += 1;
            if !is_raw {
                similarity.non_raw_up_to_date += 1;
            }
        } else {
            similarity.expired += 1;
        }
    }

    let exact_failed = exact_failed_set(conn)?.len();
    exact_prepass.failed = exact_failed;
    exact_full.failed = exact_failed;
    similarity.failed = similarity_failed_set(conn)?.len();

    let hash_count: i64 = conn.query_row("SELECT COUNT(*) FROM photo_hashes", [], |row| row.get(0)).unwrap_or(0);
    let phash_count: i64 = conn.query_row("SELECT COUNT(*) FROM photo_phash", [], |row| row.get(0)).unwrap_or(0);
    let bytes = hash_count.max(0) as u64 * 85 + phash_count.max(0) as u64 * 100;

    Ok(DuplicateHashStats {
        exact_prepass,
        exact_full,
        similarity,
        bytes,
    })
}

#[tauri::command(async)]
pub fn get_duplicate_hash_stats(state: State<'_, AppState>) -> Result<DuplicateHashStats, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    compute_duplicate_hash_stats(&conn)
}

pub(crate) fn delete_all_hashes(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "DELETE FROM photo_hashes;
         DELETE FROM photo_hash_failures;
         DELETE FROM photo_phash;
         DELETE FROM photo_phash_failures;",
    )?;
    tx.commit()
}

#[tauri::command(async)]
pub fn delete_duplicate_hashes(state: State<'_, AppState>) -> Result<(), String> {
    stop_precompute_and_wait()?;
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    delete_all_hashes(&conn).map_err(|e| e.to_string())
}

#[derive(Serialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExactHashStates {
    pub full: Vec<i64>,
    pub prepass: Vec<i64>,
    pub expired: Vec<i64>,
}

pub(crate) fn exact_hash_states(conn: &Connection) -> Result<ExactHashStates, String> {
    let mut stmt = conn
        .prepare(
            "SELECT h.photo_id,
                    (h.version = ?1 AND h.size = COALESCE(p.file_size, 0) AND h.modified = COALESCE(p.modified, 0)) AS up_to_date,
                    h.full_hash IS NOT NULL
             FROM photo_hashes h JOIN photos p ON p.id = h.photo_id
             WHERE h.mode = 1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![LAYOUT_VERSION], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?, row.get::<_, bool>(2)?)))
        .map_err(|e| e.to_string())?;
    let mut result = ExactHashStates::default();
    for row in rows {
        let (id, up_to_date, has_full) = row.map_err(|e| e.to_string())?;
        if !up_to_date {
            result.expired.push(id);
        } else if has_full {
            result.full.push(id);
        } else {
            result.prepass.push(id);
        }
    }
    Ok(result)
}

#[tauri::command(async)]
pub fn get_exact_hash_states(state: State<'_, AppState>) -> Result<ExactHashStates, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    exact_hash_states(&conn)
}
