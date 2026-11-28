//! Duplicate detection, "similar images" part (command `find_similar_images`): photos that look alike (resized, recompressed, lightly edited, and
//! optionally rotated or mirrored), found with the perceptual hash of phash.rs.
//!
//! Steps: (1) the fingerprint of every photo of the scope and, when asked, of the library: cached in `photo_phash` (key: size + modification date +
//! algorithm version), so only new or modified files are decoded; (2) every photo of the scope is compared with every other one (a bit count on two
//! 64-bit words, spread over the cores), keeping the pairs within the chosen distance; (3) pairs are joined into groups.
//! Nothing runs, and the table stays empty, until the user starts a search.
//!
//! Pairs that are left out, whatever the distance: a RAW with a non-RAW (unless asked), photos of clearly different proportions (unless rotations are
//! tolerated, then either orientation counts), and bursts (photos taken a few milliseconds apart, if asked): a burst looks alike by nature but is not a
//! duplicate. Two photos with exactly the same shooting time are never taken for a burst (a copy shares the time of its original). Flat images (black,
//! white, plain screenshots) all look alike: they are never compared.

use std::collections::HashMap;
use std::fs;
use std::io::BufReader;
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::Deserialize;

use crate::db::DbPool;
use crate::duplicates::{
    load_candidates_filtered, write_failure_log, HashFailure, Report, RichProgress, Scope, HASH_CHUNK_SIZE, MAX_REPORTED_FAILURES,
};
use crate::phash::{self, Failure, Fingerprint, ALGO_VERSION};

/// A group larger than this is dropped: a threshold too loose chains unrelated photos into one useless blob.
const MAX_GROUP: usize = 500;
/// Two photos whose proportions differ by more than this (as a ratio, 1.15 = 15 %) are not compared, unless rotations are tolerated.
const RATIO_TOLERANCE: f32 = 1.15;

fn default_true() -> bool {
    true
}

/// Whether `phash` can decode and fingerprint this file's format.
pub(crate) fn is_phash_supported(path: &Path) -> bool {
    let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "jpg" | "jpeg" | "jfif" | "heic" | "heif" | "png" | "webp") || crate::thumbnails::is_raw_path(path)
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub scope: Scope,
    pub compare_with_library: bool,
    /// Largest number of differing bits (of 64) for two photos to be similar.
    pub max_distance: u32,
    /// Also recognise a photo that was rotated by 90 degrees or mirrored.
    pub rotations: bool,
    /// Leave out photos taken within `burst_ms` of each other.
    pub ignore_bursts: bool,
    pub burst_ms: u32,
    /// Allow a RAW to be grouped with its JPEG (or the other way round).
    pub include_raw_pairs: bool,
    /// Include RAW files in the search (default true).
    #[serde(default = "default_true")]
    pub include_raw: bool,
    /// Worker threads setting (`"auto"`, `"1"`, `"2"`, `"4"`).
    #[serde(default)]
    pub threads: Option<String>,
}

/// Cache of the fingerprints (8 hashes of 8 bytes) and known unreadable/corrupt failures.
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS photo_phash (
            photo_id INTEGER PRIMARY KEY,
            size INTEGER NOT NULL,
            modified INTEGER NOT NULL,
            algo INTEGER NOT NULL,
            flat INTEGER NOT NULL,
            hashes BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS photo_phash_failures (
            photo_id INTEGER PRIMARY KEY,
            size INTEGER NOT NULL,
            modified INTEGER NOT NULL,
            algo INTEGER NOT NULL,
            reason TEXT NOT NULL
        );",
    )?;
    Ok(())
}

/// Stores one up-to-date perceptual hash and clears any prior failure for this photo.
pub(crate) fn save_phash_row(conn: &Connection, photo_id: i64, size: u64, modified: i64, fingerprint: &Fingerprint) -> rusqlite::Result<()> {
    conn.prepare_cached("INSERT OR REPLACE INTO photo_phash (photo_id, size, modified, algo, flat, hashes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?
        .execute(params![photo_id, size as i64, modified, ALGO_VERSION, i64::from(fingerprint.flat), encode(&fingerprint.hashes)])?;
    conn.prepare_cached("DELETE FROM photo_phash_failures WHERE photo_id = ?1")?
        .execute(params![photo_id])?;
    Ok(())
}

/// Records an unreadable/corrupt file failure for `photo_phash` and drops any stale hash row.
pub(crate) fn save_phash_failure(conn: &Connection, photo_id: i64, size: u64, modified: i64, reason: &str) -> rusqlite::Result<()> {
    conn.prepare_cached("INSERT OR REPLACE INTO photo_phash_failures (photo_id, size, modified, algo, reason) VALUES (?1, ?2, ?3, ?4, ?5)")?
        .execute(params![photo_id, size as i64, modified, ALGO_VERSION, reason])?;
    conn.prepare_cached("DELETE FROM photo_phash WHERE photo_id = ?1")?
        .execute(params![photo_id])?;
    Ok(())
}

struct Item {
    id: i64,
    path: String,
    in_scope: bool,
    fingerprint: Fingerprint,
    /// Width / height from the catalog, None when unknown.
    ratio: Option<f32>,
    /// Shooting time, in seconds (local clock, only compared with other times).
    time: Option<i64>,
    is_raw: bool,
}

struct Cached {
    size: u64,
    modified: i64,
    fingerprint: Fingerprint,
}

fn encode(hashes: &[u64; 8]) -> Vec<u8> {
    hashes.iter().flat_map(|hash| hash.to_le_bytes()).collect()
}

fn decode(blob: &[u8]) -> Option<[u64; 8]> {
    if blob.len() != 64 {
        return None;
    }
    let mut hashes = [0u64; 8];
    for (hash, bytes) in hashes.iter_mut().zip(blob.as_chunks::<8>().0) {
        *hash = u64::from_le_bytes(*bytes);
    }
    Some(hashes)
}

fn load_cache(conn: &Connection) -> Result<HashMap<i64, Cached>, String> {
    let mut stmt = conn.prepare("SELECT photo_id, size, modified, flat, hashes FROM photo_phash WHERE algo = ?1").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![ALGO_VERSION], |row| {
            let blob: Vec<u8> = row.get(4)?;
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)? as u64, row.get::<_, i64>(2)?, row.get::<_, i64>(3)? != 0, blob))
        })
        .map_err(|e| e.to_string())?;
    let mut cache = HashMap::new();
    for row in rows {
        let (id, size, modified, flat, blob) = row.map_err(|e| e.to_string())?;
        if let Some(hashes) = decode(&blob) {
            cache.insert(id, Cached { size, modified, fingerprint: Fingerprint { hashes, flat } });
        }
    }
    Ok(cache)
}

fn load_failure_cache(conn: &Connection) -> Result<HashMap<i64, (u64, i64)>, String> {
    let mut stmt = conn
        .prepare("SELECT photo_id, size, modified FROM photo_phash_failures WHERE algo = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![ALGO_VERSION], |row| Ok((row.get::<_, i64>(0)?, (row.get::<_, i64>(1)? as u64, row.get::<_, i64>(2)?))))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>().map_err(|e| e.to_string())
}

fn save_chunk(
    conn: &Connection,
    fresh: &[(i64, u64, i64, Fingerprint)],
    failures: &[(i64, u64, i64, String)],
) -> Result<(), String> {
    if fresh.is_empty() && failures.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (id, size, modified, fingerprint) in fresh {
        save_phash_row(&tx, *id, *size, *modified, fingerprint).map_err(|e| e.to_string())?;
    }
    for (id, size, modified, reason) in failures {
        save_phash_failure(&tx, *id, *size, *modified, reason).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Shooting time in seconds from the date stored in the catalog ("2024-05-04 12:34:56", EXIF style "2024:05:04 12:34:56" also accepted).
fn parse_time(date_taken: &str) -> Option<i64> {
    let text = date_taken.trim();
    ["%Y-%m-%d %H:%M:%S", "%Y:%m:%d %H:%M:%S"]
        .iter()
        .find_map(|format| chrono::NaiveDateTime::parse_from_str(text, format).ok())
        .map(|time| time.and_utc().timestamp())
}

/// Milliseconds of the shooting time (EXIF `SubSecTimeOriginal`), 0 when the file has none: the catalog only keeps whole seconds.
fn read_subsec_ms(path: &str) -> i64 {
    let Ok(file) = fs::File::open(path) else { return 0 };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut BufReader::new(file)) else { return 0 };
    let Some(field) = exif.get_field(exif::Tag::SubSecTimeOriginal, exif::In::PRIMARY) else { return 0 };
    let exif::Value::Ascii(values) = &field.value else { return 0 };
    let digits: String = values.first().map(|bytes| bytes.iter().filter(|byte| byte.is_ascii_digit()).map(|&byte| byte as char).take(3).collect()).unwrap_or_default();
    if digits.is_empty() { return 0; }
    // "5" is half a second, "05" is 50 ms: the digits are a decimal fraction.
    format!("{digits:0<3}").parse().unwrap_or(0)
}

/// The two photos were taken within `burst_ms` of each other, but not at the same instant. Times are whole seconds in the catalog, so the
/// sub-second part is only read from the files when the difference is small enough to matter.
fn is_burst(a: &Item, b: &Item, burst_ms: i64, subsec: &Mutex<HashMap<i64, i64>>) -> bool {
    let (Some(time_a), Some(time_b)) = (a.time, b.time) else { return false };
    if (time_a - time_b).abs() * 1000 > burst_ms + 999 {
        return false; // even the largest possible sub-second parts cannot bring them within the burst window
    }
    let milliseconds = |item: &Item, time: i64| -> i64 {
        let cached = subsec.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&item.id).copied();
        let part = cached.unwrap_or_else(|| {
            let value = read_subsec_ms(&item.path);
            subsec.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(item.id, value);
            value
        });
        time * 1000 + part
    };
    let gap = (milliseconds(a, time_a) - milliseconds(b, time_b)).abs();
    gap > 0 && gap <= burst_ms
}

/// Whether the shapes of the two pictures allow them to be the same picture.
fn proportions_compatible(a: &Item, b: &Item, rotations: bool) -> bool {
    let (Some(ratio_a), Some(ratio_b)) = (a.ratio, b.ratio) else { return true };
    let close = |x: f32, y: f32| x.max(y) / x.min(y) <= RATIO_TOLERANCE;
    close(ratio_a, ratio_b) || (rotations && close(ratio_a, 1.0 / ratio_b))
}

fn closest(a: &Item, b: &Item, rotations: bool) -> u32 {
    let reference = a.fingerprint.hashes[0];
    let variants = if rotations { 8 } else { 1 };
    b.fingerprint.hashes[..variants].iter().map(|&hash| phash::distance(reference, hash)).min().unwrap_or(64)
}

fn find(parents: &mut [usize], mut index: usize) -> usize {
    while parents[index] != index {
        parents[index] = parents[parents[index]];
        index = parents[index];
    }
    index
}

/// Finds groups of similar photos (tests and simple callers).
#[cfg_attr(not(test), allow(dead_code))]
pub fn run(pool: &DbPool, thumbnails_dir: &Path, request: &Request, cancel: &AtomicBool, progress: &(dyn Fn(f64) + Sync)) -> Result<Report, String> {
    run_with_options(pool, thumbnails_dir, None, request, cancel, &|rich| progress(f64::from(rich.percent) / 100.0))
}

/// Finds groups of similar photos with chunked commits, low-priority workers, foreground pauses, rich progress, and failure logging.
pub fn run_with_options(
    pool: &DbPool,
    thumbnails_dir: &Path,
    base_dir: Option<&Path>,
    request: &Request,
    cancel: &AtomicBool,
    progress: &(dyn Fn(RichProgress) + Sync),
) -> Result<Report, String> {
    let started = Instant::now();
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute_batch(
        "DELETE FROM photo_phash WHERE photo_id NOT IN (SELECT id FROM photos);
         DELETE FROM photo_phash_failures WHERE photo_id NOT IN (SELECT id FROM photos);",
    )
    .map_err(|e| e.to_string())?;
    let candidates = load_candidates_filtered(&conn, &request.scope, request.compare_with_library, request.include_raw)?;
    let cache = load_cache(&conn)?;
    let failure_cache = load_failure_cache(&conn)?;

    let threads = crate::semantic::resolve_hash_threads(request.threads.as_deref(), true);
    let workers = crate::semantic::build_low_priority_pool(threads)?;

    // Step 1: separate already-cached, unsupported, and known failures from photos that actually need fingerprinting.
    let mut items: Vec<Item> = Vec::with_capacity(candidates.len());
    let mut to_compute: Vec<(&crate::duplicates::Candidate, u64, i64)> = Vec::new();
    let mut unsupported_count = 0usize;
    let mut unreadable_count = 0usize;
    let mut new_failures: Vec<HashFailure> = Vec::new();

    for candidate in &candidates {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let path = Path::new(&candidate.path);
        if !is_phash_supported(path) {
            unsupported_count += 1;
            continue;
        }
        let Ok(metadata) = fs::metadata(path) else {
            unreadable_count += 1;
            continue;
        };
        let size = metadata.len();
        let Some(modified) = metadata.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64) else {
            unreadable_count += 1;
            continue;
        };
        if let Some(cached) = cache.get(&candidate.id).filter(|cached| cached.size == size && cached.modified == modified) {
            let ratio = (candidate.width > 0 && candidate.height > 0).then(|| candidate.width as f32 / candidate.height as f32);
            items.push(Item {
                id: candidate.id,
                path: candidate.path.clone(),
                in_scope: candidate.in_scope,
                fingerprint: cached.fingerprint,
                ratio,
                time: parse_time(&candidate.date_taken),
                is_raw: crate::thumbnails::is_raw_path(path),
            });
        } else if failure_cache.get(&candidate.id).is_some_and(|&(fsz, fm)| fsz == size && fm == modified) {
            unreadable_count += 1;
        } else {
            to_compute.push((candidate, size, modified));
        }
    }

    let hash_total = to_compute.len();
    let mut hash_done = 0usize;
    let mut hash_busy = Duration::ZERO;
    for chunk in to_compute.chunks(HASH_CHUNK_SIZE) {
        if !crate::semantic::wait_while_busy(crate::semantic::foreground_busy, cancel, &mut || {
            let frac = if hash_total > 0 { 0.8 * hash_done as f64 / hash_total as f64 } else { 0.8 };
            progress(RichProgress {
                percent: (frac * 100.0).round() as u32,
                done: hash_done,
                total: hash_total,
                remaining_seconds: (hash_done > 0).then(|| (hash_busy.as_secs_f64() / hash_done as f64 * (hash_total - hash_done) as f64).round() as u64),
                paused: true,
                phase: Some("hashing"),
            });
        }) {
            break;
        }
        let chunk_started = Instant::now();
        let computed: Vec<(&crate::duplicates::Candidate, u64, i64, Result<Fingerprint, Failure>)> = workers.install(|| {
            chunk
                .par_iter()
                .map(|&(candidate, size, modified)| {
                    if cancel.load(Ordering::Relaxed) {
                        return (candidate, size, modified, Err(Failure::Unreadable));
                    }
                    let res = panic::catch_unwind(AssertUnwindSafe(|| phash::fingerprint_file(Path::new(&candidate.path), thumbnails_dir)))
                        .unwrap_or(Err(Failure::Unreadable));
                    (candidate, size, modified, res)
                })
                .collect()
        });
        let mut fresh = Vec::new();
        let mut chunk_failures = Vec::new();
        for (candidate, size, modified, res) in computed {
            match res {
                Ok(fingerprint) => {
                    fresh.push((candidate.id, size, modified, fingerprint));
                    let ratio = (candidate.width > 0 && candidate.height > 0).then(|| candidate.width as f32 / candidate.height as f32);
                    items.push(Item {
                        id: candidate.id,
                        path: candidate.path.clone(),
                        in_scope: candidate.in_scope,
                        fingerprint,
                        ratio,
                        time: parse_time(&candidate.date_taken),
                        is_raw: crate::thumbnails::is_raw_path(Path::new(&candidate.path)),
                    });
                }
                Err(Failure::Unsupported) => {
                    unsupported_count += 1;
                }
                Err(Failure::Unreadable) => {
                    unreadable_count += 1;
                    if !cancel.load(Ordering::Relaxed) {
                        let exists = Path::new(&candidate.path).exists();
                        if exists {
                            let reason = "unreadable or corrupt image".to_string();
                            new_failures.push(HashFailure { path: candidate.path.clone(), error: reason.clone() });
                            chunk_failures.push((candidate.id, size, modified, reason));
                        }
                    }
                }
            }
        }
        save_chunk(&conn, &fresh, &chunk_failures)?;
        hash_busy += chunk_started.elapsed();
        hash_done += chunk.len();
        let frac = if hash_total > 0 { 0.8 * hash_done as f64 / hash_total as f64 } else { 0.8 };
        progress(RichProgress {
            percent: (frac * 100.0).round() as u32,
            done: hash_done,
            total: hash_total,
            remaining_seconds: (hash_done > 0).then(|| (hash_busy.as_secs_f64() / hash_done as f64 * (hash_total - hash_done) as f64).round() as u64),
            paused: false,
            phase: Some("hashing"),
        });
    }

    let mut report = Report { unreadable: unreadable_count, unsupported: unsupported_count, ..Report::default() };
    report.scanned = items.len();
    if cancel.load(Ordering::Relaxed) {
        report.cancelled = true;
        report.failures_total = new_failures.len();
        report.log_path = base_dir.and_then(|dir| write_failure_log(dir, "similarity-hashes", &new_failures));
        new_failures.truncate(MAX_REPORTED_FAILURES);
        report.failures = new_failures;
        report.elapsed_millis = started.elapsed().as_millis() as u64;
        return Ok(report);
    }
    // Flat pictures are left out of the comparison (they all look alike).
    items.retain(|item| !item.fingerprint.flat);

    // Step 2: every photo of the scope against every other photo, in chunks so cancellation and foreground pauses stay responsive.
    let scope_indices: Vec<usize> = (0..items.len()).filter(|&index| items[index].in_scope).collect();
    let subsec: Mutex<HashMap<i64, i64>> = Mutex::new(HashMap::new());
    let scope_total = scope_indices.len();
    let mut compared_done = 0usize;
    let mut edges: Vec<(usize, usize)> = Vec::new();
    for chunk in scope_indices.chunks(256) {
        if !crate::semantic::wait_while_busy(crate::semantic::foreground_busy, cancel, &mut || {
            let frac = if scope_total > 0 { 0.8 + 0.2 * compared_done as f64 / scope_total as f64 } else { 1.0 };
            progress(RichProgress {
                percent: (frac * 100.0).round() as u32,
                done: compared_done,
                total: scope_total,
                remaining_seconds: None,
                paused: true,
                phase: Some("comparing"),
            });
        }) {
            break;
        }
        let chunk_edges: Vec<(usize, usize)> = workers.install(|| {
            chunk
                .par_iter()
                .flat_map_iter(|&i| {
                    let mut found = Vec::new();
                    if !cancel.load(Ordering::Relaxed) {
                        let a = &items[i];
                        for (j, b) in items.iter().enumerate() {
                            if j == i || (b.in_scope && j < i) {
                                continue;
                            }
                            if a.is_raw != b.is_raw && !request.include_raw_pairs {
                                continue;
                            }
                            if !proportions_compatible(a, b, request.rotations) {
                                continue;
                            }
                            if closest(a, b, request.rotations) > request.max_distance {
                                continue;
                            }
                            if request.ignore_bursts && is_burst(a, b, i64::from(request.burst_ms), &subsec) {
                                continue;
                            }
                            found.push((i, j));
                        }
                    }
                    found
                })
                .collect()
        });
        edges.extend(chunk_edges);
        compared_done += chunk.len();
        let frac = if scope_total > 0 { 0.8 + 0.2 * compared_done as f64 / scope_total as f64 } else { 1.0 };
        progress(RichProgress {
            percent: (frac * 100.0).round() as u32,
            done: compared_done,
            total: scope_total,
            remaining_seconds: None,
            paused: false,
            phase: Some("comparing"),
        });
    }
    if cancel.load(Ordering::Relaxed) {
        report.cancelled = true;
        report.failures_total = new_failures.len();
        report.log_path = base_dir.and_then(|dir| write_failure_log(dir, "similarity-hashes", &new_failures));
        new_failures.truncate(MAX_REPORTED_FAILURES);
        report.failures = new_failures;
        report.elapsed_millis = started.elapsed().as_millis() as u64;
        return Ok(report);
    }

    // Step 3: pairs become groups.
    let mut parents: Vec<usize> = (0..items.len()).collect();
    for (i, j) in edges {
        let (root_i, root_j) = (find(&mut parents, i), find(&mut parents, j));
        if root_i != root_j {
            parents[root_i] = root_j;
        }
    }
    let mut grouped: HashMap<usize, Vec<usize>> = HashMap::new();
    for index in 0..items.len() {
        let root = find(&mut parents, index);
        grouped.entry(root).or_default().push(index);
    }
    for members in grouped.into_values().filter(|members| members.len() > 1) {
        if members.len() > MAX_GROUP {
            report.skipped_groups += 1;
            continue;
        }
        let mut paths: Vec<String> = members.into_iter().map(|index| items[index].path.clone()).collect();
        paths.sort();
        report.groups.push(paths);
    }
    report.groups.sort();
    report.failures_total = new_failures.len();
    report.log_path = base_dir.and_then(|dir| write_failure_log(dir, "similarity-hashes", &new_failures));
    new_failures.truncate(MAX_REPORTED_FAILURES);
    report.failures = new_failures;
    progress(RichProgress { percent: 100, done: scope_total, total: scope_total, remaining_seconds: Some(0), paused: false, phase: Some("comparing") });
    report.elapsed_millis = started.elapsed().as_millis() as u64;
    Ok(report)
}

/// Ids of photos with an up-to-date perceptual hash in `photo_phash` (matching current `ALGO_VERSION`, size, and mtime).
#[cfg_attr(not(test), allow(dead_code))]
pub fn phash_photo_ids(conn: &Connection) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id FROM photos p WHERE EXISTS(
                SELECT 1 FROM photo_phash h WHERE h.photo_id = p.id AND h.algo = ?1
                AND h.size = COALESCE(p.file_size, 0) AND h.modified = COALESCE(p.modified, 0))",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![ALGO_VERSION], |row| row.get::<_, i64>(0)).map_err(|e| e.to_string())?;
    crate::keywords::collect_rows(rows)
}

#[derive(serde::Serialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PhashStates {
    pub up_to_date: Vec<i64>,
    pub expired: Vec<i64>,
}

/// Photo ids partitioned into up-to-date vs expired `photo_phash` rows (List panel "Similarity hash" column).
pub(crate) fn phash_states(conn: &Connection) -> Result<PhashStates, String> {
    let mut stmt = conn
        .prepare(
            "SELECT h.photo_id,
                    (h.algo = ?1 AND h.size = COALESCE(p.file_size, 0) AND h.modified = COALESCE(p.modified, 0)) AS up_to_date
             FROM photo_phash h JOIN photos p ON p.id = h.photo_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![ALGO_VERSION], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut result = PhashStates::default();
    for row in rows {
        let (id, up_to_date) = row.map_err(|e| e.to_string())?;
        if up_to_date {
            result.up_to_date.push(id);
        } else {
            result.expired.push(id);
        }
    }
    Ok(result)
}

/// Photo ids that have an up-to-date or expired perceptual hash (List panel "Similarity hash" column).
#[tauri::command(async)]
pub fn get_phash_states(state: tauri::State<'_, crate::AppState>) -> Result<PhashStates, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    phash_states(&conn)
}

#[cfg(test)]
#[path = "tests/similar.rs"]
mod tests;
