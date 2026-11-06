//! Duplicate detection, "identical images" part (command `find_duplicates`).
//!
//! Two images are identical when their *image data* is identical, whatever their metadata. For JPEG, PNG and WebP the hashed bytes are the ones that
//! describe the pixels (JPEG: every segment except APPn / COM, then the scan; PNG: IHDR, PLTE, tRNS, IDAT and animation chunks; WebP: bitstream, alpha
//! and animation chunks). Other formats (HEIC, AVIF, GIF, BMP, RAW...) are hashed whole: their copies with diverging metadata are not recognised.
//! RAW files are never modified by the application (metadata goes to a `.xmp` sidecar), so hashing them whole is exact.
//!
//! Cost control: reading the files is the expensive part, so candidates are narrowed in three stages, each one reading more than the previous:
//! 1. image data length, from the headers only (a few KB per file) ;
//! 2. hash of the first and last 64 KB of the image data ;
//! 3. hash of the whole image data.
//! Only files still sharing their key with another file go to the next stage. Results are cached in `photo_hashes` (key: size + modification date),
//! so a second run reads almost nothing. Nothing runs, and the table stays empty, until the user starts a search.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Instant, UNIX_EPOCH};

use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::DbPool;

/// Version of the rules that choose the hashed bytes: bump it when they change, so old cached values are ignored.
const LAYOUT_VERSION: i64 = 1;
/// Bytes hashed at each end of the image data in the partial stage.
const PARTIAL_BYTES: u64 = 64 * 1024;
const READ_CHUNK: usize = 256 * 1024;
/// Videos only have a still frame here: they are not compared.
const VIDEO_EXTENSIONS: [&str; 4] = ["mp4", "mov", "avi", "mkv"];

/// 128 bits of a SHA-256 digest: plenty to tell files apart once length and partial hash already agree.
type Hash = [u8; 16];
const NO_HASH: Hash = [0; 16];
/// Byte ranges (offset, length) of a file, in file order.
type Ranges = Vec<(u64, u64)>;

// ---------------------------------------------------------------------------
// Request and report
// ---------------------------------------------------------------------------

/// What to scan. Folder paths follow the catalog convention (`/` or `\`, compared after normalisation).
#[derive(Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Scope {
    All,
    Folder { path: String, recursive: bool },
    Paths { paths: Vec<String> },
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub scope: Scope,
    /// Also compare the scanned photos with the rest of the library (a group is kept only if it holds at least one scanned photo).
    pub compare_with_library: bool,
    /// Ignore metadata (JPEG, PNG, WebP). Off: whole files are compared.
    pub ignore_metadata: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Photos whose format cannot be compared by appearance (GIF, BMP, AVIF...), similar search only.
    pub unsupported: usize,
    /// Groups left out because they were too large to be useful (similar search only: a threshold too loose chains unrelated photos).
    pub skipped_groups: usize,
    /// Groups of identical images (paths), each with at least two members, members sorted by path.
    pub groups: Vec<Vec<String>>,
    /// Photos examined (scanned and, when asked, library).
    pub scanned: usize,
    /// Files that could not be read.
    pub unreadable: usize,
    /// Extensions hashed whole although metadata was to be ignored (the format does not allow it).
    pub whole_file_extensions: Vec<String>,
    pub cancelled: bool,
    pub elapsed_millis: u64,
}

// ---------------------------------------------------------------------------
// Catalog table
// ---------------------------------------------------------------------------

/// Cache of the hashes. `mode`: 0 = whole file, 1 = image data only. A row is valid while the file keeps its size and modification date.
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS photo_hashes (
            photo_id INTEGER NOT NULL,
            mode INTEGER NOT NULL,
            version INTEGER NOT NULL,
            size INTEGER NOT NULL,
            modified INTEGER NOT NULL,
            data_len INTEGER NOT NULL,
            tolerant INTEGER NOT NULL,
            partial_hash BLOB,
            full_hash BLOB,
            PRIMARY KEY (photo_id, mode)
        ) WITHOUT ROWID",
        [],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Which bytes describe the image
// ---------------------------------------------------------------------------

struct Layout {
    ranges: Ranges,
    /// True when metadata could be left out (a supported format that was parsed).
    tolerant: bool,
}

impl Layout {
    fn len(&self) -> u64 {
        self.ranges.iter().map(|range| range.1).sum()
    }
}

pub(crate) fn extension_of(path: &Path) -> String {
    path.extension().map(|ext| ext.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn layout_of(path: &Path, size: u64, ignore_metadata: bool) -> std::io::Result<Layout> {
    let whole = || Layout { ranges: vec![(0, size)], tolerant: false };
    if !ignore_metadata {
        return Ok(whole());
    }
    let mut file = File::open(path)?;
    let parsed = match extension_of(path).as_str() {
        "jpg" | "jpeg" | "jfif" => jpeg_ranges(&mut file, size),
        "png" => png_ranges(&mut file, size),
        "webp" => webp_ranges(&mut file, size),
        _ => None,
    };
    // A file that does not parse (corrupt, or a wrong extension) is compared whole.
    Ok(parsed.map_or_else(whole, |ranges| Layout { ranges, tolerant: true }))
}

/// Joins ranges that touch each other.
fn merge(ranges: Ranges) -> Ranges {
    let mut merged: Ranges = Vec::with_capacity(ranges.len());
    for (start, len) in ranges {
        match merged.last_mut() {
            Some(last) if last.0 + last.1 == start => last.1 += len,
            _ => merged.push((start, len)),
        }
    }
    merged
}

fn read_u8(reader: &mut impl Read) -> Option<u8> {
    let mut byte = [0u8; 1];
    reader.read_exact(&mut byte).ok()?;
    Some(byte[0])
}

/// JPEG: the segments that are not metadata (everything but APPn and COM, except APP14 "Adobe" which sets the colour transform), then the scan up to EOI.
fn jpeg_ranges(file: &mut File, size: u64) -> Option<Ranges> {
    let (mut ranges, scan_start) = jpeg_header(file, size)?;
    let end = jpeg_end(file, size)?;
    if end <= scan_start {
        return None;
    }
    ranges.push((scan_start, end - scan_start));
    Some(merge(ranges))
}

/// Walks the segments before the scan (seeking over their content). Returns the kept segments and the offset of the SOS marker.
fn jpeg_header(file: &mut File, size: u64) -> Option<(Ranges, u64)> {
    file.seek(SeekFrom::Start(0)).ok()?;
    let mut reader = BufReader::with_capacity(16 * 1024, file);
    if read_u8(&mut reader)? != 0xFF || read_u8(&mut reader)? != 0xD8 {
        return None;
    }
    let mut ranges: Ranges = vec![(0, 2)];
    let mut pos: u64 = 2;
    loop {
        let start = pos;
        if read_u8(&mut reader)? != 0xFF {
            return None;
        }
        let mut marker = read_u8(&mut reader)?;
        pos += 2;
        while marker == 0xFF {
            marker = read_u8(&mut reader)?; // fill bytes
            pos += 1;
        }
        match marker {
            0x01 | 0xD0..=0xD8 => {
                ranges.push((start, pos - start)); // markers without a length
                continue;
            }
            0xD9 => return None, // end of image before any scan
            _ => {}
        }
        let mut length = [0u8; 2];
        reader.read_exact(&mut length).ok()?;
        let segment_length = u16::from_be_bytes(length) as u64;
        if segment_length < 2 || pos + segment_length > size {
            return None;
        }
        if marker == 0xDA {
            return Some((ranges, start));
        }
        let is_metadata = (0xE0..=0xEF).contains(&marker) && marker != 0xEE || marker == 0xFE;
        if !is_metadata {
            ranges.push((start, pos + segment_length - start));
        }
        reader.seek_relative(segment_length as i64 - 2).ok()?;
        pos += segment_length;
    }
}

/// End of the image: just after the last EOI marker of the file tail (data appended after it, like a trailing preview, is not image data).
fn jpeg_end(file: &mut File, size: u64) -> Option<u64> {
    let tail = size.min(4096);
    file.seek(SeekFrom::Start(size - tail)).ok()?;
    let mut buffer = vec![0u8; tail as usize];
    file.read_exact(&mut buffer).ok()?;
    Some(buffer.windows(2).rposition(|pair| pair == [0xFF, 0xD9]).map_or(size, |at| size - tail + at as u64 + 2))
}

/// PNG: signature, then the chunks that carry pixels or their interpretation. Text, EXIF, time and colour profile chunks are left out.
fn png_ranges(file: &mut File, size: u64) -> Option<Ranges> {
    const KEPT: [&[u8; 4]; 7] = [b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"acTL", b"fcTL", b"fdAT"];
    file.seek(SeekFrom::Start(0)).ok()?;
    let mut reader = BufReader::with_capacity(16 * 1024, file);
    let mut signature = [0u8; 8];
    reader.read_exact(&mut signature).ok()?;
    if signature != [0x89, b'P', b'N', b'G', 13, 10, 26, 10] {
        return None;
    }
    let mut ranges: Ranges = vec![(0, 8)];
    let mut pos: u64 = 8;
    let mut has_data = false;
    loop {
        let mut head = [0u8; 8];
        reader.read_exact(&mut head).ok()?;
        let length = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as u64;
        let kind: [u8; 4] = [head[4], head[5], head[6], head[7]];
        let total = length + 12; // length, type, data, CRC
        if pos + total > size {
            return None;
        }
        if KEPT.contains(&&kind) {
            ranges.push((pos, total));
            has_data |= &kind == b"IDAT";
        }
        pos += total;
        if &kind == b"IEND" {
            break;
        }
        reader.seek_relative(length as i64 + 4).ok()?;
    }
    has_data.then(|| merge(ranges))
}

/// WebP: the bitstream, alpha and animation chunks. The RIFF size and the VP8X flags change with metadata, so they are left out.
fn webp_ranges(file: &mut File, size: u64) -> Option<Ranges> {
    const KEPT: [&[u8; 4]; 5] = [b"VP8 ", b"VP8L", b"ALPH", b"ANIM", b"ANMF"];
    file.seek(SeekFrom::Start(0)).ok()?;
    let mut reader = BufReader::with_capacity(16 * 1024, file);
    let mut head = [0u8; 12];
    reader.read_exact(&mut head).ok()?;
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WEBP" {
        return None;
    }
    let mut ranges: Ranges = Vec::new();
    let mut pos: u64 = 12;
    let mut has_image = false;
    while pos + 8 <= size {
        let mut chunk = [0u8; 8];
        reader.read_exact(&mut chunk).ok()?;
        let length = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as u64;
        let padded = length + (length & 1);
        let total = 8 + padded;
        if pos + total > size {
            return None;
        }
        let kind: [u8; 4] = [chunk[0], chunk[1], chunk[2], chunk[3]];
        if KEPT.contains(&&kind) {
            ranges.push((pos, total));
            has_image |= &kind != b"ALPH" && &kind != b"ANIM";
        }
        reader.seek_relative(padded as i64).ok()?;
        pos += total;
    }
    has_image.then(|| merge(ranges))
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

fn finish(hasher: Sha256) -> Hash {
    let digest = hasher.finalize();
    let mut hash = NO_HASH;
    hash.copy_from_slice(&digest[..16]);
    hash
}

fn interrupted() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled")
}

fn feed(file: &mut File, start: u64, length: u64, hasher: &mut Sha256, buffer: &mut [u8], cancel: &AtomicBool) -> std::io::Result<()> {
    file.seek(SeekFrom::Start(start))?;
    let mut left = length;
    while left > 0 {
        if cancel.load(Ordering::Relaxed) {
            return Err(interrupted());
        }
        let count = left.min(buffer.len() as u64) as usize;
        file.read_exact(&mut buffer[..count])?;
        hasher.update(&buffer[..count]);
        left -= count as u64;
    }
    Ok(())
}

fn full_hash(file: &mut File, ranges: &[(u64, u64)], cancel: &AtomicBool) -> std::io::Result<Hash> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; READ_CHUNK];
    for &(start, length) in ranges {
        feed(file, start, length, &mut hasher, &mut buffer, cancel)?;
    }
    Ok(finish(hasher))
}

/// Start and end of the largest range (the scan, in practice): enough to tell apart almost every pair of files of the same length.
fn partial_hash(file: &mut File, ranges: &[(u64, u64)], cancel: &AtomicBool) -> std::io::Result<Hash> {
    let &(start, length) = ranges.iter().max_by_key(|range| range.1).ok_or_else(|| std::io::Error::other("empty file"))?;
    let head = length.min(PARTIAL_BYTES);
    let tail = if length > PARTIAL_BYTES { PARTIAL_BYTES.min(length - PARTIAL_BYTES) } else { 0 };
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; PARTIAL_BYTES as usize];
    feed(file, start, head, &mut hasher, &mut buffer, cancel)?;
    if tail > 0 {
        feed(file, start + length - tail, tail, &mut hasher, &mut buffer, cancel)?;
    }
    Ok(finish(hasher))
}

// ---------------------------------------------------------------------------
// Candidates and cache
// ---------------------------------------------------------------------------

struct Entry {
    id: i64,
    path: String,
    in_scope: bool,
    size: u64,
    modified: i64,
    data_len: u64,
    tolerant: bool,
    partial: Option<Hash>,
    full: Option<Hash>,
    /// Must be written back to `photo_hashes`.
    dirty: bool,
}

struct Cached {
    size: u64,
    modified: i64,
    data_len: u64,
    tolerant: bool,
    partial: Option<Hash>,
    full: Option<Hash>,
}

fn to_hash(blob: Option<Vec<u8>>) -> Option<Hash> {
    blob.and_then(|bytes| Hash::try_from(bytes.as_slice()).ok())
}

fn load_cache(conn: &Connection, mode: i64) -> Result<HashMap<i64, Cached>, String> {
    let mut stmt = conn
        .prepare("SELECT photo_id, size, modified, data_len, tolerant, partial_hash, full_hash FROM photo_hashes WHERE mode = ?1 AND version = ?2")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![mode, LAYOUT_VERSION], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                Cached {
                    size: row.get::<_, i64>(1)? as u64,
                    modified: row.get(2)?,
                    data_len: row.get::<_, i64>(3)? as u64,
                    tolerant: row.get::<_, i64>(4)? != 0,
                    partial: to_hash(row.get(5)?),
                    full: to_hash(row.get(6)?),
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>().map_err(|e| e.to_string())
}

fn save_dirty(conn: &Connection, mode: i64, entries: &mut [Entry]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO photo_hashes (photo_id, mode, version, size, modified, data_len, tolerant, partial_hash, full_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(|e| e.to_string())?;
        for entry in entries.iter_mut().filter(|entry| entry.dirty) {
            stmt.execute(params![
                entry.id,
                mode,
                LAYOUT_VERSION,
                entry.size as i64,
                entry.modified,
                entry.data_len as i64,
                entry.tolerant as i64,
                entry.partial.as_ref().map(|hash| hash.as_slice()),
                entry.full.as_ref().map(|hash| hash.as_slice()),
            ])
            .map_err(|e| e.to_string())?;
            entry.dirty = false;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

fn normalize(path: &str) -> String {
    path.replace('\\', "/")
}

/// A photo of the catalog taken into a search.
pub(crate) struct Candidate {
    pub id: i64,
    pub path: String,
    /// In the scope the user chose (false: only there to be compared with the scope).
    pub in_scope: bool,
    /// Shooting date as stored (may be empty), and pixel size from the catalog (0 when unknown).
    pub date_taken: String,
    pub width: i64,
    pub height: i64,
}

/// Photos of the scope, then (when asked) the rest of the library. Videos are left out.
pub(crate) fn load_candidates(conn: &Connection, scope: &Scope, compare_with_library: bool) -> Result<Vec<Candidate>, String> {
    const COLUMNS: &str = "id, path, COALESCE(date_taken, ''), COALESCE(width, 0), COALESCE(height, 0)";
    let read = |stmt: &mut rusqlite::Statement, args: &[&dyn rusqlite::ToSql]| -> Result<Vec<Candidate>, String> {
        let rows = stmt
            .query_map(args, |row| {
                Ok(Candidate { id: row.get(0)?, path: row.get(1)?, in_scope: false, date_taken: row.get(2)?, width: row.get(3)?, height: row.get(4)? })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
    };
    let mut candidates = match scope {
        Scope::All => read(&mut conn.prepare(&format!("SELECT {COLUMNS} FROM photos")).map_err(|e| e.to_string())?, &[])?,
        Scope::Folder { path, recursive } => {
            let prefix = format!("{}/", normalize(path).trim_end_matches('/'));
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {COLUMNS} FROM photos WHERE substr(replace(path, char(92), '/'), 1, length(?1)) = ?1
                     AND (?2 OR instr(substr(replace(path, char(92), '/'), length(?1) + 1), '/') = 0)"
                ))
                .map_err(|e| e.to_string())?;
            read(&mut stmt, &[&prefix, recursive])?
        }
        Scope::Paths { paths } => {
            let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM photos WHERE path = ?1")).map_err(|e| e.to_string())?;
            let mut rows = Vec::new();
            for path in paths {
                rows.extend(read(&mut stmt, &[path])?);
            }
            rows
        }
    };
    for candidate in &mut candidates {
        candidate.in_scope = true;
    }
    if compare_with_library && !matches!(scope, Scope::All) {
        let scoped_ids: HashSet<i64> = candidates.iter().map(|candidate| candidate.id).collect();
        let all = read(&mut conn.prepare(&format!("SELECT {COLUMNS} FROM photos")).map_err(|e| e.to_string())?, &[])?;
        candidates.extend(all.into_iter().filter(|candidate| !scoped_ids.contains(&candidate.id)));
    }
    candidates.retain(|candidate| !VIDEO_EXTENSIONS.contains(&extension_of(Path::new(&candidate.path)).as_str()));
    Ok(candidates)
}

/// For the search by file name, which runs in the interface (the name pattern is a JavaScript regular expression): path, shooting date and
/// "in the scope" flag of every photo concerned, as compact tuples (the library can hold hundreds of thousands of photos).
pub fn name_candidates(pool: &DbPool, scope: &Scope, compare_with_library: bool) -> Result<Vec<(String, String, bool)>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let candidates = load_candidates(&conn, scope, compare_with_library)?;
    Ok(candidates.into_iter().map(|candidate| (candidate.path, candidate.date_taken, candidate.in_scope)).collect())
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/// Splits each group by `key`; keeps the buckets of two or more files holding at least one scanned photo. Entries without a key are dropped.
fn regroup(entries: &[Entry], groups: Vec<Vec<usize>>, key: impl Fn(&Entry) -> Option<(u64, Hash)>) -> Vec<Vec<usize>> {
    let mut result = Vec::new();
    for group in groups {
        let mut buckets: HashMap<(u64, Hash), Vec<usize>> = HashMap::new();
        for index in group {
            if let Some(k) = key(&entries[index]) {
                buckets.entry(k).or_default().push(index);
            }
        }
        result.extend(buckets.into_values().filter(|bucket| bucket.len() > 1 && bucket.iter().any(|&i| entries[i].in_scope)));
    }
    result
}

/// Computes the missing hashes of the files still in a group, in parallel.
#[allow(clippy::too_many_arguments)]
fn fill_hashes(
    pool: &rayon::ThreadPool,
    entries: &mut [Entry],
    groups: &[Vec<usize>],
    full: bool,
    ignore_metadata: bool,
    cancel: &AtomicBool,
    progress: &(dyn Fn(f64) + Sync),
    range: (f64, f64),
) {
    let mut wanted: Vec<usize> = groups.iter().flatten().copied().filter(|&i| if full { entries[i].full.is_none() } else { entries[i].partial.is_none() }).collect();
    wanted.sort_unstable();
    wanted.dedup();
    let done = AtomicUsize::new(0);
    let total = wanted.len().max(1);
    let results: Vec<(usize, Option<Hash>)> = pool.install(|| {
        wanted
            .par_iter()
            .map(|&index| {
                if cancel.load(Ordering::Relaxed) {
                    return (index, None);
                }
                let entry = &entries[index];
                let hash = (|| {
                    let layout = layout_of(Path::new(&entry.path), entry.size, ignore_metadata).ok()?;
                    if layout.len() != entry.data_len {
                        return None; // the file changed since the length was read
                    }
                    let mut file = File::open(&entry.path).ok()?;
                    if full { full_hash(&mut file, &layout.ranges, cancel).ok() } else { partial_hash(&mut file, &layout.ranges, cancel).ok() }
                })();
                let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
                if finished % 32 == 0 {
                    progress(range.0 + (range.1 - range.0) * finished as f64 / total as f64);
                }
                (index, hash)
            })
            .collect()
    });
    for (index, hash) in results {
        if hash.is_some() {
            if full { entries[index].full = hash } else { entries[index].partial = hash }
            entries[index].dirty = true;
        }
    }
}

/// Finds groups of identical images. `progress` receives a fraction between 0 and 1. A cancelled run returns what it has found so far (no group,
/// in practice: groups are only certain after the last stage), flagged `cancelled`.
pub fn run(pool: &DbPool, request: &Request, cancel: &AtomicBool, progress: &(dyn Fn(f64) + Sync)) -> Result<Report, String> {
    let started = Instant::now();
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mode: i64 = if request.ignore_metadata { 1 } else { 0 };
    // Rows of photos removed from the catalog are useless (identifiers are never reused).
    conn.execute("DELETE FROM photo_hashes WHERE photo_id NOT IN (SELECT id FROM photos)", []).map_err(|e| e.to_string())?;
    let candidates = load_candidates(&conn, &request.scope, request.compare_with_library)?;
    let cache = load_cache(&conn, mode)?;

    // Same sizing as the integrity check: leave room for the interface.
    let cores = std::thread::available_parallelism().map(|count| count.get()).unwrap_or(4);
    let threads = (cores / 2).clamp(2, 6);
    let workers = rayon::ThreadPoolBuilder::new().num_threads(threads).build().map_err(|e| e.to_string())?;

    // Stage 0: size, date and image data length of every file (cache first, headers otherwise).
    let unreadable = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let total = candidates.len().max(1);
    let scanned: Vec<Option<Entry>> = workers.install(|| {
        candidates
            .par_iter()
            .map(|candidate| {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                let (id, path, in_scope) = (&candidate.id, &candidate.path, &candidate.in_scope);
                let entry = (|| {
                    let metadata = fs::metadata(path).ok()?;
                    let size = metadata.len();
                    if size == 0 {
                        return None;
                    }
                    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
                    if let Some(cached) = cache.get(id).filter(|cached| cached.size == size && cached.modified == modified) {
                        return Some(Entry {
                            id: *id, path: path.clone(), in_scope: *in_scope, size, modified, data_len: cached.data_len, tolerant: cached.tolerant,
                            partial: cached.partial, full: cached.full, dirty: false,
                        });
                    }
                    let layout = layout_of(Path::new(path), size, request.ignore_metadata).ok()?;
                    Some(Entry {
                        id: *id, path: path.clone(), in_scope: *in_scope, size, modified, data_len: layout.len(), tolerant: layout.tolerant,
                        partial: None, full: None, dirty: true,
                    })
                })();
                if entry.is_none() {
                    unreadable.fetch_add(1, Ordering::Relaxed);
                }
                let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
                if finished % 64 == 0 {
                    progress(0.3 * finished as f64 / total as f64);
                }
                entry
            })
            .collect()
    });
    let mut entries: Vec<Entry> = scanned.into_iter().flatten().collect();
    save_dirty(&conn, mode, &mut entries)?;
    let mut report = Report { scanned: entries.len(), unreadable: unreadable.load(Ordering::Relaxed), ..Report::default() };
    if request.ignore_metadata {
        let extensions: BTreeSet<String> = entries.iter().filter(|entry| !entry.tolerant).map(|entry| extension_of(Path::new(&entry.path))).collect();
        report.whole_file_extensions = extensions.into_iter().collect();
    }
    if cancel.load(Ordering::Relaxed) {
        report.cancelled = true;
        report.elapsed_millis = started.elapsed().as_millis() as u64;
        return Ok(report);
    }

    // Stage 1: same image data length.
    let mut groups = regroup(&entries, vec![(0..entries.len()).collect()], |entry| Some((entry.data_len, NO_HASH)));
    // Stage 2: same start and end.
    fill_hashes(&workers, &mut entries, &groups, false, request.ignore_metadata, cancel, progress, (0.3, 0.4));
    save_dirty(&conn, mode, &mut entries)?;
    groups = regroup(&entries, groups, |entry| entry.partial.map(|hash| (entry.data_len, hash)));
    // Stage 3: same whole image data.
    fill_hashes(&workers, &mut entries, &groups, true, request.ignore_metadata, cancel, progress, (0.4, 1.0));
    save_dirty(&conn, mode, &mut entries)?;
    if cancel.load(Ordering::Relaxed) {
        report.cancelled = true;
    } else {
        groups = regroup(&entries, groups, |entry| entry.full.map(|hash| (entry.data_len, hash)));
        report.groups = groups
            .into_iter()
            .map(|group| {
                let mut paths: Vec<String> = group.into_iter().map(|index| entries[index].path.clone()).collect();
                paths.sort();
                paths
            })
            .collect();
        report.groups.sort();
    }
    progress(1.0);
    report.elapsed_millis = started.elapsed().as_millis() as u64;
    Ok(report)
}

#[cfg(test)]
#[path = "tests/duplicates.rs"]
mod tests;
