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
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Instant, UNIX_EPOCH};

use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::Deserialize;

use crate::db::DbPool;
use crate::duplicates::{load_candidates, Report, Scope};
use crate::phash::{self, Failure, Fingerprint, ALGO_VERSION};

/// A group larger than this is dropped: a threshold too loose chains unrelated photos into one useless blob.
const MAX_GROUP: usize = 500;
/// Two photos whose proportions differ by more than this (as a ratio, 1.15 = 15 %) are not compared, unless rotations are tolerated.
const RATIO_TOLERANCE: f32 = 1.15;

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
}

/// Cache of the fingerprints (8 hashes of 8 bytes).
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS photo_phash (
            photo_id INTEGER PRIMARY KEY,
            size INTEGER NOT NULL,
            modified INTEGER NOT NULL,
            algo INTEGER NOT NULL,
            flat INTEGER NOT NULL,
            hashes BLOB NOT NULL
        )",
        [],
    )?;
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
    for (hash, bytes) in hashes.iter_mut().zip(blob.chunks_exact(8)) {
        *hash = u64::from_le_bytes(bytes.try_into().ok()?);
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

fn save_new(conn: &Connection, fresh: &[(i64, u64, i64, Fingerprint)]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached("INSERT OR REPLACE INTO photo_phash (photo_id, size, modified, algo, flat, hashes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
            .map_err(|e| e.to_string())?;
        for (id, size, modified, fingerprint) in fresh {
            stmt.execute(params![id, *size as i64, modified, ALGO_VERSION, fingerprint.flat as i64, encode(&fingerprint.hashes)]).map_err(|e| e.to_string())?;
        }
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

/// Milliseconds of the shooting time (EXIF SubSecTimeOriginal), 0 when the file has none: the catalog only keeps whole seconds.
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
        let cached = subsec.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&item.id).copied();
        let part = cached.unwrap_or_else(|| {
            let value = read_subsec_ms(&item.path);
            subsec.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(item.id, value);
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

/// Finds groups of similar photos. `progress` receives a fraction between 0 and 1. A cancelled run returns no group, flagged `cancelled`.
pub fn run(pool: &DbPool, thumbnails_dir: &Path, request: &Request, cancel: &AtomicBool, progress: &(dyn Fn(f64) + Sync)) -> Result<Report, String> {
    let started = Instant::now();
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM photo_phash WHERE photo_id NOT IN (SELECT id FROM photos)", []).map_err(|e| e.to_string())?;
    let candidates = load_candidates(&conn, &request.scope, request.compare_with_library)?;
    let cache = load_cache(&conn)?;

    // Same sizing as the integrity check: leave room for the interface.
    let cores = std::thread::available_parallelism().map(|count| count.get()).unwrap_or(4);
    let workers = rayon::ThreadPoolBuilder::new().num_threads((cores / 2).clamp(2, 6)).build().map_err(|e| e.to_string())?;

    // Step 1: fingerprints, from the cache or computed.
    let unreadable = AtomicUsize::new(0);
    let unsupported = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let total = candidates.len().max(1);
    let computed: Vec<Option<(Item, Option<(u64, i64)>)>> = workers.install(|| {
        candidates
            .par_iter()
            .map(|candidate| {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                let outcome = (|| {
                    let metadata = fs::metadata(&candidate.path).ok()?;
                    let size = metadata.len();
                    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
                    if let Some(cached) = cache.get(&candidate.id).filter(|cached| cached.size == size && cached.modified == modified) {
                        return Some((cached.fingerprint, None));
                    }
                    match phash::fingerprint_file(Path::new(&candidate.path), thumbnails_dir) {
                        Ok(fingerprint) => Some((fingerprint, Some((size, modified)))),
                        Err(Failure::Unsupported) => {
                            unsupported.fetch_add(1, Ordering::Relaxed);
                            None
                        }
                        Err(Failure::Unreadable) => {
                            unreadable.fetch_add(1, Ordering::Relaxed);
                            None
                        }
                    }
                })();
                let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
                if finished % 32 == 0 {
                    progress(0.8 * finished as f64 / total as f64);
                }
                let (fingerprint, fresh) = outcome?;
                let ratio = (candidate.width > 0 && candidate.height > 0).then(|| candidate.width as f32 / candidate.height as f32);
                let item = Item {
                    id: candidate.id,
                    path: candidate.path.clone(),
                    in_scope: candidate.in_scope,
                    fingerprint,
                    ratio,
                    time: parse_time(&candidate.date_taken),
                    is_raw: crate::thumbnails::is_raw_path(Path::new(&candidate.path)),
                };
                Some((item, fresh))
            })
            .collect()
    });
    let mut fresh = Vec::new();
    let mut items = Vec::with_capacity(computed.len());
    for (item, new_values) in computed.into_iter().flatten() {
        if let Some((size, modified)) = new_values {
            fresh.push((item.id, size, modified, item.fingerprint));
        }
        items.push(item);
    }
    save_new(&conn, &fresh)?;

    let mut report = Report { unreadable: unreadable.load(Ordering::Relaxed), unsupported: unsupported.load(Ordering::Relaxed), ..Report::default() };
    report.scanned = items.len();
    if cancel.load(Ordering::Relaxed) {
        report.cancelled = true;
        report.elapsed_millis = started.elapsed().as_millis() as u64;
        return Ok(report);
    }
    // Flat pictures are left out of the comparison (they all look alike).
    items.retain(|item| !item.fingerprint.flat);

    // Step 2: every photo of the scope against every other photo. Two photos of the scope are compared once.
    let scope_indices: Vec<usize> = (0..items.len()).filter(|&index| items[index].in_scope).collect();
    let subsec: Mutex<HashMap<i64, i64>> = Mutex::new(HashMap::new());
    let compared = AtomicUsize::new(0);
    let scope_total = scope_indices.len().max(1);
    let edges: Vec<(usize, usize)> = workers.install(|| {
        scope_indices
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
                        if request.ignore_bursts && is_burst(a, b, request.burst_ms as i64, &subsec) {
                            continue;
                        }
                        found.push((i, j));
                    }
                }
                let finished = compared.fetch_add(1, Ordering::Relaxed) + 1;
                if finished % 64 == 0 {
                    progress(0.8 + 0.2 * finished as f64 / scope_total as f64);
                }
                found
            })
            .collect()
    });
    if cancel.load(Ordering::Relaxed) {
        report.cancelled = true;
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
    progress(1.0);
    report.elapsed_millis = started.elapsed().as_millis() as u64;
    Ok(report)
}

#[cfg(test)]
#[path = "tests/similar.rs"]
mod tests;
