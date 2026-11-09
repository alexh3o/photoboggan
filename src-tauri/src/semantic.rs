//! Semantic search with SigLIP 2 (spec dev_tools/Evolutions/feat semantic search SigLIP 2.md): tokenizer, image preprocessing, image and
//! text encoders, fp16 storage of the embeddings, tables and the low-priority scan task. The searches are in semantic_search.rs (phase 3a).
//!
//! - Images (§4.1): RGB resized to `image_size × image_size` without crop nor padding, with the exact algorithm of PIL's BILINEAR resize
//!   (triangle filter widened when downscaling, i.e. antialiased; 8-bit fixed-point passes, horizontal then vertical), as the reference
//!   processor does; then `/255`, `(x − mean) / std`, NCHW float32. The parity is checked on the `pixel_probe` values of the fixtures.
//! - Text (§4.2, §15.4, §15.6): lowercased, spaces collapsed, short queries wrapped in the template; Gemma tokenizer (`tokenizers` crate)
//!   truncating to `max_text_tokens` itself, so the EOS id stays last; padded with the pad id. Same rules as `normalise_query` in
//!   dev_tools/semantic/common.py.
//! - Encoders: `pooler_output` of the ONNX exports, L2-normalised. Sessions are built by onnx_runtime.rs (few threads, no spinning).
//! - Storage: embeddings are kept as IEEE half floats (little-endian), converted here without any extra crate.
//! - Scan (§6): explicit only, incremental (file size + modification date + model id), batches of 16 with one transaction each, the vision
//!   session loaded at the start and dropped at the end, low OS priority, and a pause while any foreground work runs (`PriorityGuard`).
//!   Nothing runs, and nothing is held in memory, while no scan is running.

use ort::environment::Environment;
use ort::session::Session;
use ort::value::Tensor;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, State};

use crate::db::DbPool;
use crate::semantic_models::{active_model, ensure_enabled, ModelSpec};
use crate::AppState;

// ---------------------------------------------------------------------------
// fp16 storage
// ---------------------------------------------------------------------------

/// Nearest IEEE half float (round half to even), with subnormals, infinities and NaN.
pub fn f32_to_f16(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32;
    let mantissa = bits & 0x007f_ffff;
    if exponent == 0xff {
        // Infinity, or NaN (kept quiet and non-zero).
        return sign | 0x7c00 | if mantissa != 0 { 0x0200 } else { 0 };
    }
    let half_exponent = exponent - 127 + 15;
    if half_exponent >= 0x1f {
        return sign | 0x7c00; // too large: infinity
    }
    if half_exponent <= 0 {
        // Subnormal half (value = m × 2^-24) or zero. With the implicit bit, the f32 value is full × 2^(exponent − 150).
        let shift = (14 - half_exponent) as u32;
        if shift > 24 { return sign; }
        let full = mantissa | 0x0080_0000;
        let mut half = full >> shift;
        let rest = full & ((1 << shift) - 1);
        let halfway = 1 << (shift - 1);
        if rest > halfway || (rest == halfway && half & 1 == 1) { half += 1; } // a carry gives the smallest normal, as it should
        return sign | half as u16;
    }
    let mut half = ((half_exponent as u32) << 10) | (mantissa >> 13);
    let rest = mantissa & 0x1fff;
    if rest > 0x1000 || (rest == 0x1000 && half & 1 == 1) { half += 1; } // a carry into the exponent is correct (up to infinity)
    sign | half as u16
}

/// Exact f32 value of an IEEE half float.
#[allow(dead_code)] // first user in the application: the search index (phase 3a)
pub fn f16_to_f32(half: u16) -> f32 {
    let sign = ((half & 0x8000) as u32) << 16;
    let exponent = ((half >> 10) & 0x1f) as u32;
    let mantissa = (half & 0x03ff) as u32;
    match exponent {
        0 => {
            let magnitude = mantissa as f32 * (1.0 / 16_777_216.0); // m × 2^-24, exact in f32
            if sign != 0 { -magnitude } else { magnitude }
        }
        0x1f => f32::from_bits(sign | 0x7f80_0000 | (mantissa << 13)),
        _ => f32::from_bits(sign | ((exponent + 112) << 23) | (mantissa << 13)),
    }
}

/// Embedding → BLOB: `len × 2` bytes, half floats little-endian.
pub fn vector_to_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|&value| f32_to_f16(value).to_le_bytes()).collect()
}

/// BLOB → embedding; None when its length is not `dim × 2` (other model, damaged row).
#[allow(dead_code)] // see f16_to_f32
pub fn blob_to_vector(blob: &[u8], dim: usize) -> Option<Vec<f32>> {
    (blob.len() == dim * 2).then(|| blob.chunks_exact(2).map(|pair| f16_to_f32(u16::from_le_bytes([pair[0], pair[1]]))).collect())
}

fn l2_normalise(vector: &mut [f32]) {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in vector.iter_mut() { *value /= norm; }
    }
}

// ---------------------------------------------------------------------------
// Image preprocessing
// ---------------------------------------------------------------------------

/// Fixed-point precision of PIL's 8-bit resampling (Resample.c: 32 bits − 8 bits of value − 2 bits of margin).
const PRECISION_BITS: u32 = 32 - 8 - 2;

/// Resampling weights of one axis, as PIL computes them (`precompute_coeffs` then `normalize_coeffs_8bpc`, bilinear filter): for each
/// output position, the first source index and the fixed-point weights of the following source indexes.
fn bilinear_weights(input: usize, output: usize) -> Vec<(usize, Vec<i64>)> {
    let scale = input as f64 / output as f64;
    let filter_scale = scale.max(1.0);
    let support = filter_scale; // bilinear support (1.0) widened when downscaling: this is the antialiasing
    let inverse = 1.0 / filter_scale;
    (0..output)
        .map(|position| {
            let center = (position as f64 + 0.5) * scale;
            // C casts truncate towards zero, as `as` does.
            let first = ((center - support + 0.5) as i64).max(0);
            let last = ((center + support + 0.5) as i64).min(input as i64);
            let weights: Vec<f64> = (first..last)
                .map(|index| {
                    let distance = (index as f64 - center + 0.5) * inverse;
                    (1.0 - distance.abs()).max(0.0)
                })
                .collect();
            let total: f64 = weights.iter().sum();
            let fixed = weights
                .iter()
                .map(|&weight| {
                    let weight = if total != 0.0 { weight / total } else { weight };
                    let scaled = weight * (1u64 << PRECISION_BITS) as f64;
                    (if scaled < 0.0 { scaled - 0.5 } else { scaled + 0.5 }) as i32 as i64
                })
                .collect();
            (first as usize, fixed)
        })
        .collect()
}

/// Rounding and clipping of a fixed-point sum back to 8 bits (PIL's `clip8`).
fn clip8(sum: i64) -> u8 {
    if sum >= (1i64 << PRECISION_BITS << 8) {
        255
    } else if sum <= 0 {
        0
    } else {
        (sum >> PRECISION_BITS) as u8
    }
}

/// RGB image resized to `out_width × out_height` exactly as PIL's `Image.resize(..., BILINEAR)`: horizontal pass to 8 bits, then vertical
/// pass to 8 bits (a pass is skipped when its size does not change).
pub fn resize_bilinear(rgb: &[u8], width: usize, height: usize, out_width: usize, out_height: usize) -> Vec<u8> {
    let half = 1i64 << (PRECISION_BITS - 1);
    let horizontal: Vec<u8> = if out_width == width {
        rgb.to_vec()
    } else {
        let weights = bilinear_weights(width, out_width);
        let mut out = vec![0u8; out_width * height * 3];
        for y in 0..height {
            let row = &rgb[y * width * 3..(y + 1) * width * 3];
            for (x, (first, kernel)) in weights.iter().enumerate() {
                let mut sums = [half; 3];
                for (offset, weight) in kernel.iter().enumerate() {
                    let pixel = (first + offset) * 3;
                    for channel in 0..3 { sums[channel] += row[pixel + channel] as i64 * weight; }
                }
                let target = (y * out_width + x) * 3;
                for channel in 0..3 { out[target + channel] = clip8(sums[channel]); }
            }
        }
        out
    };
    if out_height == height { return horizontal; }
    let weights = bilinear_weights(height, out_height);
    let mut out = vec![0u8; out_width * out_height * 3];
    for (y, (first, kernel)) in weights.iter().enumerate() {
        for x in 0..out_width {
            let mut sums = [half; 3];
            for (offset, weight) in kernel.iter().enumerate() {
                let pixel = ((first + offset) * out_width + x) * 3;
                for channel in 0..3 { sums[channel] += horizontal[pixel + channel] as i64 * weight; }
            }
            let target = (y * out_width + x) * 3;
            for channel in 0..3 { out[target + channel] = clip8(sums[channel]); }
        }
    }
    out
}

/// Input tensor of one RGB image for the vision encoder: `3 × size × size` floats (CHW), resized without crop, `/255`, normalised.
/// The arithmetic is float32 step by step, as numpy does in the reference.
pub fn image_tensor(rgb: &[u8], width: usize, height: usize, model: &ModelSpec) -> Vec<f32> {
    let size = model.image_size;
    let resized = resize_bilinear(rgb, width, height, size, size);
    let plane = size * size;
    let mut tensor = vec![0f32; 3 * plane];
    for (index, pixel) in resized.chunks_exact(3).enumerate() {
        for channel in 0..3 {
            tensor[channel * plane + index] = (pixel[channel] as f32 / 255.0 - model.mean[channel]) / model.std[channel];
        }
    }
    tensor
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/// Text actually fed to the tokenizer: lowercased (if the model says so), spaces collapsed, wrapped in the template when it has at most
/// `template_max_words` words (same rule as `normalise_query` in dev_tools/semantic/common.py).
#[allow(dead_code)] // first user in the application: the text search (phase 3a)
pub fn normalise_query(text: &str, model: &ModelSpec) -> String {
    let lowered = if model.lowercase { text.to_lowercase() } else { text.to_string() };
    let words: Vec<&str> = lowered.split_whitespace().collect();
    let cleaned = words.join(" ");
    if words.len() <= model.template_max_words { model.template.replacen("{}", &cleaned, 1) } else { cleaned }
}

#[allow(dead_code)] // see normalise_query
/// Gemma tokenizer of the model, truncating to `max_text_tokens` (EOS kept last) and padding with the pad id.
pub struct TextTokenizer {
    tokenizer: tokenizers::Tokenizer,
    length: usize,
    pad_id: u32,
}

#[allow(dead_code)] // see normalise_query
impl TextTokenizer {
    /// Loads `tokenizer.json` (~1.3 s in a release build: call it off the main thread).
    pub fn load(path: &Path, model: &ModelSpec) -> Result<Self, String> {
        let mut tokenizer = tokenizers::Tokenizer::from_file(path).map_err(|error| format!("tokenizer.json : {error}"))?;
        let truncation = tokenizers::TruncationParams { max_length: model.max_text_tokens, ..Default::default() };
        tokenizer.with_truncation(Some(truncation)).map_err(|error| format!("tokenizer.json : {error}"))?;
        tokenizer.with_padding(None); // padding done below, always to the full length
        Ok(TextTokenizer { tokenizer, length: model.max_text_tokens, pad_id: model.pad_id })
    }

    /// Token ids of an already normalised text, padded to the model length.
    pub fn ids(&self, text: &str) -> Result<Vec<i64>, String> {
        let encoding = self.tokenizer.encode(text, true).map_err(|error| format!("tokenizer : {error}"))?;
        let mut ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
        ids.resize(self.length, self.pad_id as i64);
        Ok(ids)
    }
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

/// Rows of the `pooler_output` output, L2-normalised; checks its shape.
fn pooled_rows(outputs: &ort::session::SessionOutputs, count: usize, dim: usize) -> Result<Vec<Vec<f32>>, String> {
    let value = outputs.get("pooler_output").ok_or("pooler_output missing from the model")?;
    let (shape, data) = value.try_extract_tensor::<f32>().map_err(|error| error.to_string())?;
    if shape.len() != 2 || shape[0] as usize != count || shape[1] as usize != dim || data.len() != count * dim {
        return Err(format!("unexpected embedding shape {shape:?}"));
    }
    Ok(data
        .chunks_exact(dim)
        .map(|row| {
            let mut vector = row.to_vec();
            l2_normalise(&mut vector);
            vector
        })
        .collect())
}

/// Image encoder (`pixel_values` f32 [N, 3, size, size] → `pooler_output` f32 [N, dim]).
pub struct VisionEncoder {
    session: Session,
    size: usize,
    dim: usize,
}

impl VisionEncoder {
    pub fn load(environment: &Environment, path: &Path, model: &ModelSpec, threads: usize) -> Result<Self, String> {
        let session = crate::onnx_runtime::background_session(environment, path, threads).map_err(|error| format!("vision.onnx : {error}"))?;
        Ok(VisionEncoder { session, size: model.image_size, dim: model.embed_dim })
    }

    /// Embeddings of `count` images whose tensors (`image_tensor`) are concatenated in `pixels`.
    pub fn embed(&mut self, pixels: Vec<f32>, count: usize) -> Result<Vec<Vec<f32>>, String> {
        if count == 0 { return Ok(Vec::new()); }
        if pixels.len() != count * 3 * self.size * self.size { return Err("wrong image tensor size".to_string()); }
        let tensor = Tensor::from_array(([count, 3, self.size, self.size], pixels)).map_err(|error| error.to_string())?;
        let outputs = self.session.run(ort::inputs!["pixel_values" => tensor]).map_err(|error| format!("image encoder: {error}"))?;
        pooled_rows(&outputs, count, self.dim)
    }
}

/// Text encoder (`input_ids` i64 [N, length] → `pooler_output` f32 [N, dim]) with its tokenizer.
#[allow(dead_code)] // first user in the application: the text search (phase 3a); the parity tests use it now
pub struct TextEncoder {
    session: Session,
    tokenizer: TextTokenizer,
    dim: usize,
}

#[allow(dead_code)] // see TextEncoder
impl TextEncoder {
    pub fn load(environment: &Environment, model_path: &Path, tokenizer_path: &Path, model: &ModelSpec, threads: usize) -> Result<Self, String> {
        let tokenizer = TextTokenizer::load(tokenizer_path, model)?;
        let session = crate::onnx_runtime::background_session(environment, model_path, threads).map_err(|error| format!("text.onnx : {error}"))?;
        Ok(TextEncoder { session, tokenizer, dim: model.embed_dim })
    }

    /// Embeddings of already normalised texts (`normalise_query`).
    pub fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() { return Ok(Vec::new()); }
        let length = self.tokenizer.length;
        let mut ids = Vec::with_capacity(texts.len() * length);
        for text in texts { ids.extend(self.tokenizer.ids(text)?); }
        let tensor = Tensor::from_array(([texts.len(), length], ids)).map_err(|error| error.to_string())?;
        let outputs = self.session.run(ort::inputs!["input_ids" => tensor]).map_err(|error| format!("text encoder: {error}"))?;
        pooled_rows(&outputs, texts.len(), self.dim)
    }
}

// ---------------------------------------------------------------------------
// Priority: the scan gives way to every foreground task (§6.2)
// ---------------------------------------------------------------------------

/// Foreground tasks running now (library sync, catalogue scans, metadata and keyword writes, integrity check, face scan, duplicate search,
/// thumbnail generation). While it is above zero, the semantic scan waits between two batches.
static FOREGROUND_TASKS: AtomicUsize = AtomicUsize::new(0);

/// Marks a foreground task for as long as it lives (RAII): `let _priority = crate::semantic::PriorityGuard::new();`. A single atomic
/// increment: no cost when the semantic search is off.
pub struct PriorityGuard(());

impl PriorityGuard {
    pub fn new() -> Self {
        FOREGROUND_TASKS.fetch_add(1, Ordering::SeqCst);
        PriorityGuard(())
    }
}

impl Drop for PriorityGuard {
    fn drop(&mut self) {
        FOREGROUND_TASKS.fetch_sub(1, Ordering::SeqCst);
    }
}

pub fn foreground_busy() -> bool {
    FOREGROUND_TASKS.load(Ordering::SeqCst) > 0
}

/// Step of the pause while foreground work runs (the stop request is checked at each step).
const PAUSE_STEP: Duration = Duration::from_millis(500);

/// Lowers the priority of the current thread (the scan worker and its decoder are dedicated threads, never pool threads). Windows only:
/// Linux would need the `libc` crate, and the small number of threads is enough there (§6.2).
#[cfg(windows)]
fn lower_thread_priority() {
    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL};
    // SAFETY: GetCurrentThread returns a pseudo-handle valid in the calling thread; a failure only leaves the normal priority.
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

#[cfg(not(windows))]
fn lower_thread_priority() {}

// ---------------------------------------------------------------------------
// Tables (§5.1)
// ---------------------------------------------------------------------------

/// Creates the tables (empty until a scan runs) and removes the rows of photos that left the catalogue and the rejections of deleted
/// keywords. Called by `db::init_db`, after the photo and keyword tables.
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS photo_embeddings (
            photo_id INTEGER PRIMARY KEY,
            model_id TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            file_mtime INTEGER NOT NULL,
            vec BLOB NOT NULL
        );
        -- Counts per model (status line, storage) read the index, not the 1.5 KB rows.
        CREATE INDEX IF NOT EXISTS idx_photo_embeddings_model ON photo_embeddings(model_id);
        CREATE TABLE IF NOT EXISTS photo_embedding_failures (
            photo_id INTEGER PRIMARY KEY,
            model_id TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            file_mtime INTEGER NOT NULL,
            reason TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS keyword_suggestion_rejections (
            photo_id INTEGER NOT NULL,
            keyword_id INTEGER NOT NULL,
            PRIMARY KEY (photo_id, keyword_id)
        );",
    )?;
    remove_orphans(conn)
}

/// Rows whose photo left the catalogue (photo ids are never reused) or whose keyword was deleted.
pub fn remove_orphans(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DELETE FROM photo_embeddings WHERE photo_id NOT IN (SELECT id FROM photos);
        DELETE FROM photo_embedding_failures WHERE photo_id NOT IN (SELECT id FROM photos);
        DELETE FROM keyword_suggestion_rejections WHERE photo_id NOT IN (SELECT id FROM photos)
            OR keyword_id NOT IN (SELECT id FROM keyword_nodes);",
    )
}

// ---------------------------------------------------------------------------
// Photos of a scan
// ---------------------------------------------------------------------------

/// Where a photo stands for the active model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    /// Embedding of this model for this version of the file (same size and modification date).
    Analysed,
    /// Failed for this version of the file: not retried until the file changes.
    Failed,
    /// No embedding, other model, or file changed since.
    Pending,
}

pub struct Target {
    pub photo_id: i64,
    pub path: String,
    /// Size and modification date of the file as known by the catalogue (kept by the library sync).
    pub size: i64,
    pub mtime: i64,
    pub standing: Standing,
}

/// Photos of a scope: a selection (`photo_ids`), a folder (`folder`, subfolders included if `recursive`), or the whole library (neither).
/// Same folder rule as the face scan (paths compared with "/").
pub fn select_targets(conn: &Connection, model_id: &str, photo_ids: Option<&[i64]>, folder: Option<&str>, recursive: bool) -> Result<Vec<Target>, String> {
    let columns = "SELECT p.id, p.path, COALESCE(p.file_size, 0), COALESCE(p.modified, 0),
        EXISTS(SELECT 1 FROM photo_embeddings e WHERE e.photo_id = p.id AND e.model_id = ?1
               AND e.file_size = COALESCE(p.file_size, 0) AND e.file_mtime = COALESCE(p.modified, 0)),
        EXISTS(SELECT 1 FROM photo_embedding_failures f WHERE f.photo_id = p.id AND f.model_id = ?1
               AND f.file_size = COALESCE(p.file_size, 0) AND f.file_mtime = COALESCE(p.modified, 0))
        FROM photos p WHERE p.path IS NOT NULL";
    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<Target> {
        let (analysed, failed): (bool, bool) = (row.get(4)?, row.get(5)?);
        Ok(Target {
            photo_id: row.get(0)?,
            path: row.get(1)?,
            size: row.get(2)?,
            mtime: row.get(3)?,
            standing: if analysed { Standing::Analysed } else if failed { Standing::Failed } else { Standing::Pending },
        })
    };
    let rows = if let Some(ids) = photo_ids {
        let ids_json = serde_json::to_string(ids).map_err(|error| error.to_string())?;
        let mut statement = conn.prepare(&format!("{columns} AND p.id IN (SELECT value FROM json_each(?2))")).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![model_id, ids_json], map_row).map_err(|error| error.to_string())?;
        crate::keywords::collect_rows(rows)?
    } else if let Some(folder) = folder {
        let prefix = format!("{}/", folder.replace('\\', "/").trim_end_matches('/'));
        let mut statement = conn
            .prepare(&format!(
                "{columns} AND substr(replace(p.path, char(92), '/'), 1, length(?2)) = ?2
                 AND (?3 OR instr(substr(replace(p.path, char(92), '/'), length(?2) + 1), '/') = 0)"
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![model_id, prefix, recursive], map_row).map_err(|error| error.to_string())?;
        crate::keywords::collect_rows(rows)?
    } else {
        let mut statement = conn.prepare(columns).map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![model_id], map_row).map_err(|error| error.to_string())?;
        crate::keywords::collect_rows(rows)?
    };
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Pixels of a photo
// ---------------------------------------------------------------------------

/// Longest side of the fallback decode when no thumbnail is cached (the size of a cached thumbnail, §4.1).
const FALLBACK_SIDE: usize = 512;

/// Result of the analysis of one photo.
pub enum Outcome {
    Embedded(Vec<f32>),
    /// Nothing to analyse yet (video or format without a cached thumbnail): not recorded, tried again at the next scan.
    Skipped,
    /// Unreadable file: recorded with its reason, not retried until the file changes.
    Failed(String),
}

/// RGB pixels of the photo as displayed: the cached thumbnail (oriented) when it exists, otherwise a reduced decode of the file in memory.
/// Nothing is ever written to the thumbnail cache (§4.1). Err(None): skipped; Err(Some(reason)): failed.
fn load_pixels(path: &str, thumbnails_dir: &Path) -> Result<(Vec<u8>, usize, usize), Option<String>> {
    use crate::thumbnails;
    let source = Path::new(path);
    let cached = crate::thumbnail_cache_file(thumbnails_dir, path).map_err(Some)?; // file missing or unreadable
    if cached.is_file() {
        if let Ok(decoded) = thumbnails::decode_scaled_rgb(&cached, FALLBACK_SIDE) { return Ok(decoded); }
    }
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let (rgb, width, height) = match extension.as_str() {
        "jpg" | "jpeg" | "jfif" => {
            let (rgb, width, height) = thumbnails::decode_scaled_rgb(source, FALLBACK_SIDE).map_err(Some)?;
            thumbnails::apply_orientation(rgb, width, height, thumbnails::read_orientation(source))
        }
        _ if thumbnails::is_raw_path(source) => {
            let (rgb, width, height) = thumbnails::decode_scaled_rgb(source, FALLBACK_SIDE).map_err(Some)?;
            thumbnails::apply_orientation(rgb, width, height, thumbnails::read_orientation(source))
        }
        // HEIC / HEIF: the decoder already applied the rotation of the container.
        "heic" | "heif" => thumbnails::decode_scaled_rgb(source, FALLBACK_SIDE).map_err(Some)?,
        "png" => crate::integrity::decode_png(source, true).map_err(Some)?,
        "webp" => crate::integrity::decode_webp(source, true).map_err(Some)?,
        // Videos, GIF, BMP, AVIF: only through a cached thumbnail.
        _ => return Err(None),
    };
    Ok(thumbnails::resize_to_fit(rgb, width, height, FALLBACK_SIDE))
}

/// Input tensor of one photo, or why there is none.
fn prepare(path: &str, thumbnails_dir: &Path, model: &ModelSpec) -> Result<Vec<f32>, Outcome> {
    match load_pixels(path, thumbnails_dir) {
        Ok((rgb, width, height)) if width > 0 && height > 0 => Ok(image_tensor(&rgb, width, height, model)),
        Ok(_) => Err(Outcome::Failed("empty image".to_string())),
        Err(None) => Err(Outcome::Skipped),
        Err(Some(reason)) => Err(Outcome::Failed(reason)),
    }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Stores the results of one batch in a single transaction (never one per photo, so grid queries are not starved). An embedding replaces
/// any failure of the photo; a failure replaces its embedding (it belonged to an older version of the file). Skipped photos are not recorded.
pub fn store_batch(conn: &Connection, model_id: &str, results: &[(&Target, Outcome)]) -> rusqlite::Result<()> {
    let transaction = conn.unchecked_transaction()?;
    {
        let mut insert_vector = transaction.prepare_cached(
            "INSERT OR REPLACE INTO photo_embeddings (photo_id, model_id, file_size, file_mtime, vec) VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        let mut insert_failure = transaction.prepare_cached(
            "INSERT OR REPLACE INTO photo_embedding_failures (photo_id, model_id, file_size, file_mtime, reason) VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        let mut delete_vector = transaction.prepare_cached("DELETE FROM photo_embeddings WHERE photo_id = ?1")?;
        let mut delete_failure = transaction.prepare_cached("DELETE FROM photo_embedding_failures WHERE photo_id = ?1")?;
        for (target, outcome) in results {
            match outcome {
                Outcome::Embedded(vector) => {
                    insert_vector.execute(params![target.photo_id, model_id, target.size, target.mtime, vector_to_blob(vector)])?;
                    delete_failure.execute(params![target.photo_id])?;
                }
                Outcome::Failed(reason) => {
                    insert_failure.execute(params![target.photo_id, model_id, target.size, target.mtime, reason])?;
                    delete_vector.execute(params![target.photo_id])?;
                }
                Outcome::Skipped => {}
            }
        }
    }
    transaction.commit()
}

// ---------------------------------------------------------------------------
// Scan task (§6)
// ---------------------------------------------------------------------------

/// Photos per inference call and per transaction.
const BATCH: usize = 16;

/// Error key: a semantic scan is already running (one at a time).
pub const SCAN_RUNNING_ERROR: &str = "semantic_scan_running";

/// Running scan: its stop flag, so that disabling the feature or deleting its data can stop it. None: no scan.
static CURRENT_SCAN: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

fn current_scan() -> std::sync::MutexGuard<'static, Option<Arc<AtomicBool>>> {
    CURRENT_SCAN.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The single scan slot: clears CURRENT_SCAN when dropped, whatever the way the scan ends (error, panic).
struct ScanSlot;

impl ScanSlot {
    /// Takes the slot, or None when a scan is running.
    fn take(cancel: &Arc<AtomicBool>) -> Option<Self> {
        let mut current = current_scan();
        if current.is_some() { return None; }
        *current = Some(cancel.clone());
        Some(ScanSlot)
    }
}

impl Drop for ScanSlot {
    fn drop(&mut self) {
        *current_scan() = None;
    }
}

/// Asks the running scan (if any) to stop, without waiting.
pub fn cancel_running_scan() {
    if let Some(flag) = current_scan().as_ref() { flag.store(true, Ordering::SeqCst); }
}

/// Stops the running scan and waits until it has released the model and stopped writing (at most one batch: a few seconds).
pub fn stop_scan_and_wait() -> Result<(), String> {
    cancel_running_scan();
    let started = Instant::now();
    while current_scan().is_some() {
        if started.elapsed() > Duration::from_secs(60) { return Err(SCAN_RUNNING_ERROR.to_string()); }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

/// Called when the feature is disabled: the scan stops and releases its model. (Phase 3a: release the search index and text session here.)
pub fn on_disabled() {
    cancel_running_scan();
}

/// Progress of a semantic scan, sent in "scan-progress" like the other queue tasks (`taskId`, `percent`), with the details of this task.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub task_id: String,
    pub percent: u32,
    /// Photos handled / to handle in this run (photos already up to date are not counted).
    pub done: usize,
    pub total: usize,
    /// Estimated time left, from the pace of this run (pauses excluded); None until the first batch is done.
    pub remaining_seconds: Option<u64>,
    /// Waiting for foreground work ("Paused (other task running)").
    pub paused: bool,
}

#[derive(Serialize)]
pub struct ScanFailure {
    pub path: String,
    pub error: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    /// Photos of the scope.
    pub total: usize,
    /// Embeddings computed by this run.
    pub analysed: usize,
    /// Already up to date (embedding or failure of the same model for the same version of the file): not read again.
    pub up_to_date: usize,
    /// Nothing to analyse yet (video or format without a cached thumbnail).
    pub skipped: usize,
    /// Failed in this run (recorded: not retried until the file changes).
    pub failed: Vec<ScanFailure>,
    pub cancelled: bool,
}

/// Scan settings, resolved before the worker starts.
struct ScanJob {
    pool: DbPool,
    models_dir: PathBuf,
    thumbnails_dir: PathBuf,
    photo_ids: Option<Vec<i64>>,
    folder: Option<String>,
    recursive: bool,
    /// Leave the RAW files out (the face scan has the same choice).
    skip_raw: bool,
    threads: usize,
    cancel: Arc<AtomicBool>,
}

/// Waits while foreground work runs (500 ms steps); `on_pause` is called once when the pause starts. Returns false when a stop was
/// requested.
fn wait_for_foreground(cancel: &AtomicBool, on_pause: &mut dyn FnMut()) -> bool {
    let mut announced = false;
    while foreground_busy() {
        if cancel.load(Ordering::Relaxed) { return false; }
        if !announced {
            on_pause();
            announced = true;
        }
        std::thread::sleep(PAUSE_STEP);
    }
    !cancel.load(Ordering::Relaxed)
}

/// Batch prepared by the decoder thread: (index in the pending list, tensor or why there is none).
type PreparedBatch = Vec<(usize, Result<Vec<f32>, Outcome>)>;

/// The scan itself, on the dedicated worker thread. `emit` publishes the progress.
fn run_scan(job: ScanJob, emit: &dyn Fn(ScanProgress)) -> Result<ScanReport, String> {
    lower_thread_priority();
    let model = active_model();
    let conn = job.pool.get().map_err(|error| error.to_string())?;
    remove_orphans(&conn).map_err(|error| error.to_string())?;
    let mut targets = select_targets(&conn, &model.id, job.photo_ids.as_deref(), job.folder.as_deref(), job.recursive)?;
    if job.skip_raw { targets.retain(|target| !crate::thumbnails::is_raw_path(Path::new(&target.path))); }
    let mut report = ScanReport { total: targets.len(), ..ScanReport::default() };
    let pending: Vec<Target> = targets.into_iter().filter(|target| target.standing == Standing::Pending).collect();
    report.up_to_date = report.total - pending.len();
    let total = pending.len();
    if total == 0 { return Ok(report); }

    let paths = crate::semantic_models::installed_paths(&job.models_dir, model)?;
    scan_pending(job, &paths, &conn, pending, report, emit)
}

/// Analyses the pending photos with the model files `paths` (separate from `run_scan` so that the parity tests can give their own files).
fn scan_pending(
    job: ScanJob,
    paths: &crate::semantic_models::ModelPaths,
    conn: &Connection,
    pending: Vec<Target>,
    mut report: ScanReport,
    emit: &dyn Fn(ScanProgress),
) -> Result<ScanReport, String> {
    let model = active_model();
    let total = pending.len();
    // The model is loaded only when there is work, and dropped when this function returns.
    let environment = crate::onnx_runtime::environment(&paths.runtime)?;
    let mut encoder = VisionEncoder::load(&environment, &paths.vision, model, job.threads)?;

    // Pipeline: one extra thread (low priority too) decodes the next batch while the current one is inferred. The bounded channel keeps at
    // most one batch ahead; the thread stops when the worker hangs up or a stop is requested.
    let (sender, batches) = std::sync::mpsc::sync_channel::<PreparedBatch>(1);
    let decoder_cancel = job.cancel.clone();
    let thumbnails_dir = job.thumbnails_dir.clone();
    let paths_to_read: Vec<String> = pending.iter().map(|target| target.path.clone()).collect();
    let decoder = std::thread::Builder::new()
        .name("semantic-decode".to_string())
        .spawn(move || {
            lower_thread_priority();
            for (chunk_index, chunk) in paths_to_read.chunks(BATCH).enumerate() {
                if decoder_cancel.load(Ordering::Relaxed) { break; }
                let batch = chunk
                    .iter()
                    .enumerate()
                    .map(|(offset, path)| (chunk_index * BATCH + offset, prepare(path, &thumbnails_dir, active_model())))
                    .collect();
                if sender.send(batch).is_err() { break; }
            }
        })
        .map_err(|error| error.to_string())?;

    let mut done = 0usize;
    let mut busy = Duration::ZERO; // time spent working, pauses excluded: pace of the remaining-time estimate
    let progress = |done: usize, busy: Duration, paused: bool| ScanProgress {
        task_id: String::new(),
        percent: (done * 100 / total) as u32,
        done,
        total,
        remaining_seconds: (done > 0).then(|| (busy.as_secs_f64() / done as f64 * (total - done) as f64).round() as u64),
        paused,
    };
    let mut failure: Option<String> = None;
    let mut since = Instant::now();
    for batch in batches.iter() {
        // Give way to foreground work before using the CPU and the database.
        busy += since.elapsed();
        let go_on = wait_for_foreground(&job.cancel, &mut || emit(progress(done, busy, true)));
        since = Instant::now();
        // Disabling the feature stops the scan through the same flag (on_disabled).
        if !go_on {
            report.cancelled = true;
            break;
        }
        let mut pixels = Vec::with_capacity(batch.len() * 3 * model.image_size * model.image_size);
        let mut results: Vec<(&Target, Outcome)> = Vec::with_capacity(batch.len());
        let mut embedded_slots = Vec::new();
        for (index, prepared) in batch {
            match prepared {
                Ok(tensor) => {
                    pixels.extend(tensor);
                    embedded_slots.push(results.len());
                    results.push((&pending[index], Outcome::Skipped)); // replaced by its embedding below
                }
                Err(other) => results.push((&pending[index], other)),
            }
        }
        // An inference error is not caused by one photo (memory, damaged model): the scan stops instead of marking photos as failed.
        let embeddings = match encoder.embed(pixels, embedded_slots.len()) {
            Ok(embeddings) => embeddings,
            Err(error) => {
                failure = Some(error);
                break;
            }
        };
        for (slot, vector) in embedded_slots.into_iter().zip(embeddings) { results[slot].1 = Outcome::Embedded(vector); }
        if let Err(error) = store_batch(conn, &model.id, &results) {
            failure = Some(format!("database: {error}"));
            break;
        }
        for (target, result) in &results {
            match result {
                Outcome::Embedded(_) => report.analysed += 1,
                Outcome::Skipped => report.skipped += 1,
                Outcome::Failed(reason) => {
                    eprintln!("Semantic analysis failed for {}: {reason}", target.path);
                    report.failed.push(ScanFailure { path: target.path.clone(), error: reason.clone() });
                }
            }
        }
        done += results.len();
        emit(progress(done, busy + since.elapsed(), false));
    }
    // The decoder stops at its next send (or right away if it saw the stop request).
    drop(batches);
    let _ = decoder.join();
    drop(encoder);
    if done < total && failure.is_none() { report.cancelled = true; }
    match failure {
        Some(error) => Err(error),
        None => Ok(report),
    }
}

/// Content analysis of a selection (`photo_ids`), a folder (`folder`, subfolders if `recursive`) or the whole library (neither): computes
/// the missing embeddings of the active model. Queue task: progress through "scan-progress" (with `done`, `total`, `remainingSeconds`,
/// `paused`), stop through cancel_scan (photos already stored stay). `threads`: ONNX Runtime threads, 1 (default), 2 or 4.
/// Errors: `semantic_disabled`, `semantic_scan_running`, `semantic_model_missing`, `semantic_unsupported_platform`, or a message.
#[tauri::command]
pub async fn semantic_scan(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    folder: Option<String>,
    recursive: bool,
    photo_ids: Option<Vec<i64>>,
    threads: Option<usize>,
    skip_raw: Option<bool>,
) -> Result<ScanReport, String> {
    ensure_enabled()?;
    let cancel = crate::scan_cancel_flag(&task_id);
    let outcome = async {
        let slot = ScanSlot::take(&cancel).ok_or_else(|| SCAN_RUNNING_ERROR.to_string())?;
        // Checked again after taking the slot: a disable arriving in between finds the scan and stops it.
        ensure_enabled()?;
        let job = ScanJob {
            pool: state.pool(),
            models_dir: crate::face_models::models_dir(&state),
            thumbnails_dir: state.thumbnails_dir(),
            photo_ids,
            folder,
            recursive,
            skip_raw: skip_raw.unwrap_or(false),
            threads: threads.unwrap_or(1).clamp(1, 4),
            cancel: cancel.clone(),
        };
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let worker_task_id = task_id.clone();
        // A dedicated thread (not a pool thread): its priority is lowered for its whole life.
        std::thread::Builder::new()
            .name("semantic-scan".to_string())
            .spawn(move || {
                let _slot = slot; // released when the worker ends, after the model is dropped
                let emit = |mut progress: ScanProgress| {
                    progress.task_id = worker_task_id.clone();
                    let _ = app.emit("scan-progress", progress);
                };
                let _ = sender.send(run_scan(job, &emit));
            })
            .map_err(|error| error.to_string())?;
        receiver.await.map_err(|_| "semantic scan stopped unexpectedly".to_string())?
    }
    .await;
    crate::release_scan_cancel_flag(&task_id);
    outcome
}

// ---------------------------------------------------------------------------
// Statistics and deletion
// ---------------------------------------------------------------------------

#[derive(Serialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Photos of the scope.
    pub total: usize,
    /// With an up-to-date embedding of the active model.
    pub analysed: usize,
    /// Failed for their current version (not retried until the file changes).
    pub failed: usize,
    /// Still to analyse.
    pub pending: usize,
    /// Approximate space used by all embeddings in the database (every model, whatever the scope), in bytes.
    pub bytes: u64,
}

/// Bytes of one embedding row besides its vector (ids, model id, size, date, record header, index entry), for the storage estimate.
const ROW_OVERHEAD: u64 = 60;

/// Counts of a scope (`folder` / `photo_ids` / whole library, as for the scan) and storage used.
pub fn stats(conn: &Connection, photo_ids: Option<&[i64]>, folder: Option<&str>, recursive: bool, skip_raw: bool) -> Result<Stats, String> {
    let model = active_model();
    let mut targets = select_targets(conn, &model.id, photo_ids, folder, recursive)?;
    if skip_raw { targets.retain(|target| !crate::thumbnails::is_raw_path(Path::new(&target.path))); }
    let count = |standing: Standing| targets.iter().filter(|target| target.standing == standing).count();
    // Rows per model through the index (the vectors are not read). A model no longer in the manifest is counted with the active size.
    let mut statement = conn.prepare("SELECT model_id, COUNT(*) FROM photo_embeddings GROUP BY model_id").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))).map_err(|error| error.to_string())?;
    let mut bytes = 0u64;
    for (model_id, count) in crate::keywords::collect_rows(rows)? {
        let dim = crate::semantic_models::model_by_id(&model_id).map_or(model.embed_dim, |known| known.embed_dim);
        bytes += count as u64 * (dim as u64 * 2 + ROW_OVERHEAD);
    }
    Ok(Stats { total: targets.len(), analysed: count(Standing::Analysed), failed: count(Standing::Failed), pending: count(Standing::Pending), bytes })
}

/// "x of y photos analysed" and storage (Settings; "not analysed yet" line of the searches).
#[tauri::command(async)]
pub fn get_semantic_stats(state: State<'_, AppState>, folder: Option<String>, recursive: bool, photo_ids: Option<Vec<i64>>, skip_raw: Option<bool>) -> Result<Stats, String> {
    ensure_enabled()?;
    let conn = state.pool().get().map_err(|error| error.to_string())?;
    stats(&conn, photo_ids.as_deref(), folder.as_deref(), recursive, skip_raw.unwrap_or(false))
}

/// Deletes every embedding, failure and dismissed suggestion (all models), in one transaction.
pub fn delete_data(conn: &Connection) -> rusqlite::Result<()> {
    let transaction = conn.unchecked_transaction()?;
    transaction.execute_batch(
        "DELETE FROM photo_embeddings;
        DELETE FROM photo_embedding_failures;
        DELETE FROM keyword_suggestion_rejections;",
    )?;
    transaction.commit()
}

/// "Delete analysis data" (with confirmation in the interface): stops a running scan first, then empties the tables.
#[tauri::command(async)]
pub fn delete_semantic_data(state: State<'_, AppState>) -> Result<(), String> {
    ensure_enabled()?;
    stop_scan_and_wait()?;
    let conn = state.pool().get().map_err(|error| error.to_string())?;
    delete_data(&conn).map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "tests/semantic.rs"]
mod tests;
