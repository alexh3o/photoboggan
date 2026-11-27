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
//!
//! Only files still sharing their key with another file go to the next stage. Results are cached in `photo_hashes` (key: size + modification date),
//! so a second run reads almost nothing. Nothing runs, and the table stays empty, until the user starts a search.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::DbPool;

/// Version of the rules that choose the hashed bytes: bump it when they change, so old cached values are ignored. The semantic scan stores it
/// next to its own copy of the hash (`hash_version`), so a bump also makes it analyse those photos again.
pub(crate) const LAYOUT_VERSION: i64 = 1;
/// Number of files processed and committed per transaction in duplicate/hash scans.
pub(crate) const HASH_CHUNK_SIZE: usize = 128;
/// Maximum number of per-file failures returned over IPC (the full list is written to the log file).
pub(crate) const MAX_REPORTED_FAILURES: usize = 200;
/// Bytes hashed at each end of the image data in the partial stage.
const PARTIAL_BYTES: u64 = 64 * 1024;
const READ_CHUNK: usize = 256 * 1024;
// Videos only have a still frame here: they are not compared.
use crate::video::VIDEO_EXTENSIONS;

/// 128 bits of a SHA-256 digest: plenty to tell files apart once length and partial hash already agree.
pub(crate) type Hash = [u8; 16];
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

fn default_true() -> bool {
    true
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub scope: Scope,
    /// Also compare the scanned photos with the rest of the library (a group is kept only if it holds at least one scanned photo).
    pub compare_with_library: bool,
    /// Ignore metadata (JPEG, PNG, WebP). Off: whole files are compared.
    pub ignore_metadata: bool,
    /// Include RAW files in the search (default true).
    #[serde(default = "default_true")]
    pub include_raw: bool,
    /// Worker threads setting (`"auto"`, `"1"`, `"2"`, `"4"`).
    #[serde(default)]
    pub threads: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HashFailure {
    pub path: String,
    pub error: String,
}

#[derive(Clone, Debug)]
pub struct RichProgress {
    pub percent: u32,
    pub done: usize,
    pub total: usize,
    pub remaining_seconds: Option<u64>,
    pub paused: bool,
    pub phase: Option<&'static str>,
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
    /// Sample of unreadable/corrupt files encountered during this run (up to MAX_REPORTED_FAILURES).
    pub failures: Vec<HashFailure>,
    pub failures_total: usize,
    /// Log file path when failures were recorded.
    pub log_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Catalog table
// ---------------------------------------------------------------------------

/// Cache of the hashes. `mode`: 0 = whole file, 1 = image data only. A row is valid while the file keeps its size and modification date.
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
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
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS photo_hash_failures (
            photo_id INTEGER NOT NULL,
            mode INTEGER NOT NULL,
            version INTEGER NOT NULL,
            size INTEGER NOT NULL,
            modified INTEGER NOT NULL,
            reason TEXT NOT NULL,
            PRIMARY KEY (photo_id, mode)
        ) WITHOUT ROWID;",
    )?;
    Ok(())
}

/// Writes `failures` to `<base_dir>/logs/photoboggan-<prefix>-YYYYMMDD-HHMMSS.log`, returning its path on success.
pub(crate) fn write_failure_log(base_dir: &Path, prefix: &str, failures: &[HashFailure]) -> Option<String> {
    if failures.is_empty() {
        return None;
    }
    let logs_dir = base_dir.join("logs");
    if let Err(error) = fs::create_dir_all(&logs_dir) {
        eprintln!("Failure log directory not created: {error}");
        return None;
    }
    let mut content = String::from("\u{feff}");
    for failure in failures {
        content.push_str(&format!("{}\t{}\r\n", failure.path, failure.error.replace(['\r', '\n'], " ")));
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    for attempt in 0u32.. {
        let name = if attempt == 0 {
            format!("photoboggan-{prefix}-{stamp}.log")
        } else {
            format!("photoboggan-{prefix}-{stamp} ({attempt}).log")
        };
        let target = logs_dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(content.as_bytes()) {
                    drop(file);
                    let _ = fs::remove_file(&target);
                    eprintln!("Failure log not written: {error}");
                    return None;
                }
                return Some(target.to_string_lossy().into_owned());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                eprintln!("Failure log not created: {error}");
                return None;
            }
        }
    }
    None
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
fn jpeg_ranges<R: Read + Seek>(reader: &mut R, size: u64) -> Option<Ranges> {
    let (mut ranges, scan_start) = jpeg_header(reader, size)?;
    let end = jpeg_end(reader, size)?;
    if end <= scan_start {
        return None;
    }
    ranges.push((scan_start, end - scan_start));
    Some(merge(ranges))
}

/// Walks the segments before the scan (seeking over their content). Returns the kept segments and the offset of the SOS marker.
fn jpeg_header<R: Read + Seek>(file: &mut R, size: u64) -> Option<(Ranges, u64)> {
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
fn jpeg_end<R: Read + Seek>(file: &mut R, size: u64) -> Option<u64> {
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

fn feed<R: Read + Seek>(file: &mut R, start: u64, length: u64, hasher: &mut Sha256, buffer: &mut [u8], cancel: &AtomicBool) -> std::io::Result<()> {
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

fn full_hash<R: Read + Seek>(file: &mut R, ranges: &[(u64, u64)], cancel: &AtomicBool) -> std::io::Result<Hash> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; READ_CHUNK];
    for &(start, length) in ranges {
        feed(file, start, length, &mut hasher, &mut buffer, cancel)?;
    }
    Ok(finish(hasher))
}

/// Start and end of the largest range (the scan, in practice): enough to tell apart almost every pair of files of the same length.
fn partial_hash<R: Read + Seek>(file: &mut R, ranges: &[(u64, u64)], cancel: &AtomicBool) -> std::io::Result<Hash> {
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
// Image-data hash of one file (shared with the semantic scan, semantic.rs)
// ---------------------------------------------------------------------------

/// Image-data hash (mode 1: metadata left out where the format allows it) of one file, and the file version it was computed from, in the
/// units of `photo_hashes` (size in bytes, modification date in ms since 1970).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DataHash {
    pub size: u64,
    pub modified: i64,
    pub data_len: u64,
    /// The metadata could be left out (parsed JPEG, PNG or WebP). False: the whole file was hashed.
    pub tolerant: bool,
    pub hash: Hash,
}

/// Videos are never hashed (whole files of several GB, and the duplicate search does not compare them).
pub(crate) fn is_video(path: &Path) -> bool {
    VIDEO_EXTENSIONS.contains(&extension_of(path).as_str())
}

/// Size and modification date (ms) of a file, the key of a cached hash.
fn file_version(metadata: &fs::Metadata) -> Option<(u64, i64)> {
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
    Some((metadata.len(), modified))
}

/// Size and modification date of a file as `photo_hashes` keys them (compare with a cached `DataHash` before reading the file).
pub(crate) fn current_version(path: &Path) -> std::io::Result<(u64, i64)> {
    file_version(&fs::metadata(path)?).ok_or_else(|| std::io::Error::other("no modification date"))
}

/// Reads only the header layout and partial hash (head + tail 64 KB) for import candidate disambiguation.
pub(crate) fn quick_partial_hash(path: &Path) -> std::io::Result<(u64, Hash)> {
    let (size, _) = current_version(path)?;
    if size == 0 {
        return Err(std::io::Error::other("empty file"));
    }
    let layout = layout_of(path, size, true)?;
    let cancel = AtomicBool::new(false);
    let hash = partial_hash(&mut File::open(path)?, &layout.ranges, &cancel)?;
    Ok((layout.len(), hash))
}

/// Reads one file and computes its image-data hash: layout (headers only), then every image byte. Fails when the file changed while it was
/// read (its version is checked again at the end), so a hash never mixes two versions of a file.
pub(crate) fn image_data_hash(path: &Path, cancel: &AtomicBool) -> std::io::Result<DataHash> {
    let (size, modified) = current_version(path)?;
    if size == 0 {
        return Err(std::io::Error::other("empty file"));
    }
    let layout = layout_of(path, size, true)?;
    let hash = full_hash(&mut File::open(path)?, &layout.ranges, cancel)?;
    if current_version(path)? != (size, modified) {
        return Err(std::io::Error::other("file changed while it was read"));
    }
    Ok(DataHash { size, modified, data_len: layout.len(), tolerant: layout.tolerant, hash })
}

/// Computes the image-data hash (mode 1) from an already-loaded JPEG byte buffer in RAM (zero extra disk I/O).
pub(crate) fn image_data_hash_from_jpeg_bytes(bytes: &[u8], size: u64, modified: i64) -> Option<DataHash> {
    if size == 0 || bytes.len() as u64 != size {
        return None;
    }
    let mut cursor = Cursor::new(bytes);
    let (ranges, tolerant) = match jpeg_ranges(&mut cursor, size) {
        Some(ranges) => (ranges, true),
        None => (vec![(0, size)], false),
    };
    let data_len: u64 = ranges.iter().map(|range| range.1).sum();
    let mut hasher = Sha256::new();
    for (start, length) in ranges {
        let start = start as usize;
        let end = start.checked_add(length as usize)?;
        hasher.update(bytes.get(start..end)?);
    }
    Some(DataHash { size, modified, data_len, tolerant, hash: finish(hasher) })
}

/// Reads only the file headers to compute the pre-pass layout `(size, modified, data_len, tolerant)`.
pub(crate) fn prepass_layout(path: &Path, ignore_metadata: bool) -> std::io::Result<(u64, i64, u64, bool)> {
    let (size, modified) = current_version(path)?;
    if size == 0 {
        return Err(std::io::Error::other("empty file"));
    }
    let layout = layout_of(path, size, ignore_metadata)?;
    Ok((size, modified, layout.len(), layout.tolerant))
}

/// Stores a pre-pass (`data_len` only) in `photo_hashes`, keeping `partial_hash` and `full_hash` when the file version and `data_len` match.
pub(crate) fn remember_prepass(
    conn: &Connection,
    photo_id: i64,
    mode: i64,
    size: u64,
    modified: i64,
    data_len: u64,
    tolerant: bool,
) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "INSERT INTO photo_hashes (photo_id, mode, version, size, modified, data_len, tolerant, partial_hash, full_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL)
         ON CONFLICT (photo_id, mode) DO UPDATE SET
             partial_hash = CASE WHEN version = excluded.version AND size = excluded.size AND modified = excluded.modified
                                  AND data_len = excluded.data_len THEN partial_hash END,
             full_hash = CASE WHEN version = excluded.version AND size = excluded.size AND modified = excluded.modified
                               AND data_len = excluded.data_len THEN full_hash END,
             version = excluded.version, size = excluded.size, modified = excluded.modified, data_len = excluded.data_len,
             tolerant = excluded.tolerant",
    )?
    .execute(params![photo_id, mode, LAYOUT_VERSION, size as i64, modified, data_len as i64, tolerant as i64])?;
    conn.prepare_cached("DELETE FROM photo_hash_failures WHERE photo_id = ?1 AND mode = ?2")?
        .execute(params![photo_id, mode])?;
    Ok(())
}

/// Records an unreadable/corrupt file failure for `photo_hashes` so it is not retried until the file changes.
pub(crate) fn save_hash_failure(conn: &Connection, photo_id: i64, mode: i64, size: u64, modified: i64, reason: &str) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "INSERT OR REPLACE INTO photo_hash_failures (photo_id, mode, version, size, modified, reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?
    .execute(params![photo_id, mode, LAYOUT_VERSION, size as i64, modified, reason])?;
    Ok(())
}

/// Full image-data hashes already in `photo_hashes` (mode 1, current layout version) for these photos. The caller compares their version
/// with the file before trusting one.
pub(crate) fn cached_data_hashes(conn: &Connection, photo_ids: &[i64]) -> Result<HashMap<i64, DataHash>, String> {
    let ids = serde_json::to_string(photo_ids).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT photo_id, size, modified, data_len, tolerant, full_hash FROM photo_hashes
             WHERE mode = 1 AND version = ?1 AND full_hash IS NOT NULL AND photo_id IN (SELECT value FROM json_each(?2))",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![LAYOUT_VERSION, ids], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?, row.get::<_, Option<Vec<u8>>>(5)?))
        })
        .map_err(|e| e.to_string())?;
    let mut hashes = HashMap::new();
    for row in rows {
        let (id, size, modified, data_len, tolerant, full) = row.map_err(|e| e.to_string())?;
        if let Some(hash) = to_hash(full) {
            hashes.insert(id, DataHash { size: size as u64, modified, data_len: data_len as u64, tolerant: tolerant != 0, hash });
        }
    }
    Ok(hashes)
}

/// Stores a hash computed outside a duplicate search, so that search does not read the file again. The partial hash of the row is kept when
/// it belongs to the same file version, cleared otherwise (it is computed again only if a search needs it).
pub(crate) fn remember_data_hash(conn: &Connection, photo_id: i64, data: &DataHash) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "INSERT INTO photo_hashes (photo_id, mode, version, size, modified, data_len, tolerant, partial_hash, full_hash)
         VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)
         ON CONFLICT (photo_id, mode) DO UPDATE SET
             partial_hash = CASE WHEN version = excluded.version AND size = excluded.size AND modified = excluded.modified
                                  AND data_len = excluded.data_len THEN partial_hash END,
             version = excluded.version, size = excluded.size, modified = excluded.modified, data_len = excluded.data_len,
             tolerant = excluded.tolerant, full_hash = excluded.full_hash",
    )?
    .execute(params![photo_id, LAYOUT_VERSION, data.size as i64, data.modified, data.data_len as i64, data.tolerant as i64, data.hash.as_slice()])?;
    conn.prepare_cached("DELETE FROM photo_hash_failures WHERE photo_id = ?1 AND mode = 1")?
        .execute(params![photo_id])?;
    Ok(())
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

fn load_failure_cache(conn: &Connection, mode: i64) -> Result<HashMap<i64, (u64, i64)>, String> {
    let mut stmt = conn
        .prepare("SELECT photo_id, size, modified FROM photo_hash_failures WHERE mode = ?1 AND version = ?2")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![mode, LAYOUT_VERSION], |row| Ok((row.get::<_, i64>(0)?, (row.get::<_, i64>(1)? as u64, row.get::<_, i64>(2)?))))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>().map_err(|e| e.to_string())
}

fn save_dirty_and_failures(
    conn: &Connection,
    mode: i64,
    entries: &mut [Entry],
    failures: &[(i64, u64, i64, String)],
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO photo_hashes (photo_id, mode, version, size, modified, data_len, tolerant, partial_hash, full_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(|e| e.to_string())?;
        let mut clear_fail = tx
            .prepare_cached("DELETE FROM photo_hash_failures WHERE photo_id = ?1 AND mode = ?2")
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
            clear_fail.execute(params![entry.id, mode]).map_err(|e| e.to_string())?;
            entry.dirty = false;
        }
        for (photo_id, size, modified, reason) in failures {
            save_hash_failure(&tx, *photo_id, mode, *size, *modified, reason).map_err(|e| e.to_string())?;
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
    // Photos hidden by the active privacy sets are never compared, so no group can reveal them (identical, similar and by-name searches share this list).
    let visible_sql = crate::privacy::visible_condition("");
    if visible_sql != "1" {
        let visible: HashSet<i64> = conn
            .prepare(&format!("SELECT id FROM photos WHERE {visible_sql}")).map_err(|e| e.to_string())?
            .query_map([], |row| row.get(0)).map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?;
        candidates.retain(|candidate| visible.contains(&candidate.id));
    }
    Ok(candidates)
}

/// Same as `load_candidates`, optionally excluding RAW files when `include_raw` is false.
pub(crate) fn load_candidates_filtered(conn: &Connection, scope: &Scope, compare_with_library: bool, include_raw: bool) -> Result<Vec<Candidate>, String> {
    let mut candidates = load_candidates(conn, scope, compare_with_library)?;
    if !include_raw {
        candidates.retain(|candidate| !crate::thumbnails::is_raw_path(Path::new(&candidate.path)));
    }
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

/// Computes the missing hashes of the files still in a group, in parallel chunks of `HASH_CHUNK_SIZE`, committing after each chunk.
#[allow(clippy::too_many_arguments)]
fn fill_hashes(
    pool: &rayon::ThreadPool,
    conn: &Connection,
    mode: i64,
    entries: &mut [Entry],
    groups: &[Vec<usize>],
    full: bool,
    ignore_metadata: bool,
    cancel: &AtomicBool,
    progress: &(dyn Fn(RichProgress) + Sync),
    range: (f64, f64),
    failures: &mut Vec<HashFailure>,
) -> Result<(), String> {
    let mut wanted: Vec<usize> = groups.iter().flatten().copied().filter(|&i| if full { entries[i].full.is_none() } else { entries[i].partial.is_none() }).collect();
    wanted.sort_unstable();
    wanted.dedup();
    if wanted.is_empty() {
        return Ok(());
    }
    let total = wanted.len();
    let mut done = 0usize;
    let mut busy = Duration::ZERO;
    for chunk in wanted.chunks(HASH_CHUNK_SIZE) {
        if !crate::semantic::wait_while_busy(crate::semantic::foreground_busy, cancel, &mut || {
            let frac = range.0 + (range.1 - range.0) * done as f64 / total as f64;
            progress(RichProgress {
                percent: (frac * 100.0).round() as u32,
                done,
                total,
                remaining_seconds: (done > 0).then(|| (busy.as_secs_f64() / done as f64 * (total - done) as f64).round() as u64),
                paused: true,
                phase: Some("hashing"),
            });
        }) {
            break;
        }
        let chunk_started = Instant::now();
        let results: Vec<(usize, Result<Hash, Option<String>>)> = pool.install(|| {
            chunk
                .par_iter()
                .map(|&index| {
                    if cancel.load(Ordering::Relaxed) {
                        return (index, Err(None));
                    }
                    let entry = &entries[index];
                    let res = panic::catch_unwind(AssertUnwindSafe(|| -> Result<Hash, Option<String>> {
                        let layout = layout_of(Path::new(&entry.path), entry.size, ignore_metadata).map_err(|e| {
                            if e.kind() == std::io::ErrorKind::NotFound { None } else { Some(e.to_string()) }
                        })?;
                        if layout.len() != entry.data_len {
                            return Err(None); // file changed since stage 0
                        }
                        let mut file = File::open(&entry.path).map_err(|e| {
                            if e.kind() == std::io::ErrorKind::NotFound { None } else { Some(e.to_string()) }
                        })?;
                        if full {
                            full_hash(&mut file, &layout.ranges, cancel)
                        } else {
                            partial_hash(&mut file, &layout.ranges, cancel)
                        }
                        .map_err(|e| if e.kind() == std::io::ErrorKind::Interrupted { None } else { Some(e.to_string()) })
                    }))
                    .unwrap_or_else(|_| Err(Some("internal error while reading the file".to_string())));
                    (index, res)
                })
                .collect()
        });
        let mut chunk_failures = Vec::new();
        for (index, res) in results {
            match res {
                Ok(hash) => {
                    if full { entries[index].full = Some(hash) } else { entries[index].partial = Some(hash) }
                    entries[index].dirty = true;
                }
                Err(Some(reason)) => {
                    let entry = &entries[index];
                    failures.push(HashFailure { path: entry.path.clone(), error: reason.clone() });
                    chunk_failures.push((entry.id, entry.size, entry.modified, reason));
                }
                Err(None) => {}
            }
        }
        save_dirty_and_failures(conn, mode, entries, &chunk_failures)?;
        busy += chunk_started.elapsed();
        done += chunk.len();
        let frac = range.0 + (range.1 - range.0) * done as f64 / total as f64;
        progress(RichProgress {
            percent: (frac * 100.0).round() as u32,
            done,
            total,
            remaining_seconds: (done > 0).then(|| (busy.as_secs_f64() / done as f64 * (total - done) as f64).round() as u64),
            paused: false,
            phase: Some("hashing"),
        });
    }
    Ok(())
}

/// Finds groups of identical images (tests and simple callers).
#[cfg_attr(not(test), allow(dead_code))]
pub fn run(pool: &DbPool, request: &Request, cancel: &AtomicBool, progress: &(dyn Fn(f64) + Sync)) -> Result<Report, String> {
    run_with_options(pool, None, request, cancel, &|rich| progress(rich.percent as f64 / 100.0))
}

/// Finds groups of identical images with chunked commits, low-priority workers, foreground pauses, rich progress, and failure logging.
pub fn run_with_options(
    pool: &DbPool,
    base_dir: Option<&Path>,
    request: &Request,
    cancel: &AtomicBool,
    progress: &(dyn Fn(RichProgress) + Sync),
) -> Result<Report, String> {
    let started = Instant::now();
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mode: i64 = if request.ignore_metadata { 1 } else { 0 };
    // Rows of photos removed from the catalog are useless (identifiers are never reused).
    conn.execute_batch(
        "DELETE FROM photo_hashes WHERE photo_id NOT IN (SELECT id FROM photos);
         DELETE FROM photo_hash_failures WHERE photo_id NOT IN (SELECT id FROM photos);",
    )
    .map_err(|e| e.to_string())?;
    let candidates = load_candidates_filtered(&conn, &request.scope, request.compare_with_library, request.include_raw)?;
    let cache = load_cache(&conn, mode)?;
    let failure_cache = load_failure_cache(&conn, mode)?;

    let threads = crate::semantic::resolve_hash_threads(request.threads.as_deref(), true);
    let workers = crate::semantic::build_low_priority_pool(threads)?;

    // Stage 0: separate already-cached entries from uncached candidates so we only chunk and hash the missing ones.
    let mut entries: Vec<Entry> = Vec::with_capacity(candidates.len());
    let mut uncached: Vec<&Candidate> = Vec::new();
    let mut unreadable_count = 0usize;
    let mut new_failures: Vec<HashFailure> = Vec::new();

    for candidate in &candidates {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Ok(meta) = fs::metadata(&candidate.path) else {
            unreadable_count += 1;
            continue;
        };
        let Some((size, modified)) = file_version(&meta) else {
            unreadable_count += 1;
            continue;
        };
        if size == 0 {
            unreadable_count += 1;
            continue;
        }
        if let Some(cached) = cache.get(&candidate.id).filter(|c| c.size == size && c.modified == modified) {
            entries.push(Entry {
                id: candidate.id,
                path: candidate.path.clone(),
                in_scope: candidate.in_scope,
                size,
                modified,
                data_len: cached.data_len,
                tolerant: cached.tolerant,
                partial: cached.partial,
                full: cached.full,
                dirty: false,
            });
        } else if failure_cache.get(&candidate.id).is_some_and(|&(fsz, fm)| fsz == size && fm == modified) {
            unreadable_count += 1;
        } else {
            uncached.push(candidate);
        }
    }

    let stage0_total = uncached.len();
    let mut stage0_done = 0usize;
    let mut stage0_busy = Duration::ZERO;
    for chunk in uncached.chunks(HASH_CHUNK_SIZE) {
        if !crate::semantic::wait_while_busy(crate::semantic::foreground_busy, cancel, &mut || {
            let frac = if stage0_total > 0 { 0.3 * stage0_done as f64 / stage0_total as f64 } else { 0.3 };
            progress(RichProgress {
                percent: (frac * 100.0).round() as u32,
                done: stage0_done,
                total: stage0_total,
                remaining_seconds: (stage0_done > 0).then(|| (stage0_busy.as_secs_f64() / stage0_done as f64 * (stage0_total - stage0_done) as f64).round() as u64),
                paused: true,
                phase: Some("hashing"),
            });
        }) {
            break;
        }
        let chunk_started = Instant::now();
        let scanned: Vec<Result<Entry, Option<(i64, String, u64, i64, String)>>> = workers.install(|| {
            chunk
                .par_iter()
                .map(|candidate| {
                    if cancel.load(Ordering::Relaxed) {
                        return Err(None);
                    }
                    panic::catch_unwind(AssertUnwindSafe(|| {
                        let meta = fs::metadata(&candidate.path).map_err(|e| {
                            if e.kind() == std::io::ErrorKind::NotFound { None } else { Some((candidate.id, candidate.path.clone(), 0, 0, e.to_string())) }
                        })?;
                        let (size, modified) = file_version(&meta).ok_or_else(|| Some((candidate.id, candidate.path.clone(), meta.len(), 0, "no modification date".to_string())))?;
                        if size == 0 {
                            return Err(Some((candidate.id, candidate.path.clone(), 0, modified, "empty file".to_string())));
                        }
                        let layout = layout_of(Path::new(&candidate.path), size, request.ignore_metadata)
                            .map_err(|e| Some((candidate.id, candidate.path.clone(), size, modified, e.to_string())))?;
                        Ok(Entry {
                            id: candidate.id,
                            path: candidate.path.clone(),
                            in_scope: candidate.in_scope,
                            size,
                            modified,
                            data_len: layout.len(),
                            tolerant: layout.tolerant,
                            partial: None,
                            full: None,
                            dirty: true,
                        })
                    }))
                    .unwrap_or_else(|_| Err(Some((candidate.id, candidate.path.clone(), 0, 0, "internal error while reading the file".to_string()))))
                })
                .collect()
        });
        let mut chunk_entries = Vec::with_capacity(scanned.len());
        let mut chunk_failures = Vec::new();
        for res in scanned {
            match res {
                Ok(entry) => chunk_entries.push(entry),
                Err(Some((id, path, size, modified, reason))) => {
                    unreadable_count += 1;
                    new_failures.push(HashFailure { path, error: reason.clone() });
                    if size > 0 {
                        chunk_failures.push((id, size, modified, reason));
                    }
                }
                Err(None) => {
                    unreadable_count += 1;
                }
            }
        }
        save_dirty_and_failures(&conn, mode, &mut chunk_entries, &chunk_failures)?;
        entries.extend(chunk_entries);
        stage0_busy += chunk_started.elapsed();
        stage0_done += chunk.len();
        let frac = if stage0_total > 0 { 0.3 * stage0_done as f64 / stage0_total as f64 } else { 0.3 };
        progress(RichProgress {
            percent: (frac * 100.0).round() as u32,
            done: stage0_done,
            total: stage0_total,
            remaining_seconds: (stage0_done > 0).then(|| (stage0_busy.as_secs_f64() / stage0_done as f64 * (stage0_total - stage0_done) as f64).round() as u64),
            paused: false,
            phase: Some("hashing"),
        });
    }

    let mut report = Report { scanned: entries.len(), unreadable: unreadable_count, ..Report::default() };
    if request.ignore_metadata {
        let extensions: BTreeSet<String> = entries.iter().filter(|entry| !entry.tolerant).map(|entry| extension_of(Path::new(&entry.path))).collect();
        report.whole_file_extensions = extensions.into_iter().collect();
    }
    if cancel.load(Ordering::Relaxed) {
        report.cancelled = true;
        report.failures_total = new_failures.len();
        report.log_path = base_dir.and_then(|dir| write_failure_log(dir, "exact-hashes", &new_failures));
        new_failures.truncate(MAX_REPORTED_FAILURES);
        report.failures = new_failures;
        report.elapsed_millis = started.elapsed().as_millis() as u64;
        return Ok(report);
    }

    // Stage 1: same image data length.
    let mut groups = regroup(&entries, vec![(0..entries.len()).collect()], |entry| Some((entry.data_len, NO_HASH)));
    // Stage 2: same start and end.
    fill_hashes(&workers, &conn, mode, &mut entries, &groups, false, request.ignore_metadata, cancel, progress, (0.3, 0.4), &mut new_failures)?;
    groups = regroup(&entries, groups, |entry| entry.partial.map(|hash| (entry.data_len, hash)));
    // Stage 3: same whole image data.
    fill_hashes(&workers, &conn, mode, &mut entries, &groups, true, request.ignore_metadata, cancel, progress, (0.4, 1.0), &mut new_failures)?;
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
    report.unreadable += new_failures.len();
    report.failures_total = new_failures.len();
    report.log_path = base_dir.and_then(|dir| write_failure_log(dir, "exact-hashes", &new_failures));
    new_failures.truncate(MAX_REPORTED_FAILURES);
    report.failures = new_failures;
    progress(RichProgress { percent: 100, done: report.scanned, total: report.scanned, remaining_seconds: Some(0), paused: false, phase: Some("comparing") });
    report.elapsed_millis = started.elapsed().as_millis() as u64;
    Ok(report)
}

#[cfg(test)]
#[path = "tests/duplicates.rs"]
mod tests;
