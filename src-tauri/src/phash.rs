//! Perceptual hash (pHash) of an image, for the "similar images" search (similar.rs).
//!
//! The image is reduced to 32x32 grey levels, a 2D DCT keeps its 8x8 lowest frequencies, and each of the 63 AC coefficients becomes one bit (above or
//! below the median); the 64th bit (DC) is always 0. Two versions of the same picture (resized, recompressed, lightly edited) end up a few bits apart.
//! The 8 rotations / mirrors of the picture are hashed in the same pass (the DCT of a transformed image cannot be derived from the 64 bits), so the
//! "tolerate rotations" option never needs a second scan. Pure Rust, no dependency: the algorithm is public (Zauner 2010) and written here.
//!
//! Source pixels, cheapest first: the cached thumbnail when it exists (small JPEG, orientation already applied), otherwise the file itself decoded at
//! reduced size (JPEG, RAW preview, HEIC) or in full (PNG, WebP). Nothing is ever written to the thumbnail cache by this module.

use std::path::Path;
use std::sync::{Condvar, Mutex, OnceLock};

use crate::{integrity, thumbnails};

/// Version of the algorithm and of the way pixels are obtained: bump it to make cached fingerprints be computed again.
pub const ALGO_VERSION: i64 = 1;
const SIDE: usize = 32;
const LOW: usize = 8;
/// Below this mean absolute AC coefficient (grey levels) an image is considered flat (black, white, plain screenshot): all flat images look alike.
const FLAT_LIMIT: f32 = 1.0;
/// Longest side asked from the decoders: the JPEG decoder then reduces by DCT scaling, far more than the 32 pixels needed.
const DECODE_SIDE: usize = 64;
/// Full-resolution decodes (PNG, WebP, HEIC) running at the same time, to bound memory.
const HEAVY_DECODES: usize = 2;

/// Hashes of the 8 variants of an image: identity, then 7 rotations and mirrors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fingerprint {
    pub hashes: [u64; 8],
    /// Too uniform to be told apart from other uniform images.
    pub flat: bool,
}

pub enum Failure {
    /// Format that cannot be compared by appearance (GIF, BMP, AVIF...).
    Unsupported,
    Unreadable,
}

/// Number of differing bits.
pub fn distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

fn cosines() -> &'static [[f32; SIDE]; LOW] {
    static TABLE: OnceLock<[[f32; SIDE]; LOW]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [[0f32; SIDE]; LOW];
        for (u, row) in table.iter_mut().enumerate() {
            for (x, value) in row.iter_mut().enumerate() {
                *value = (((2 * x + 1) as f64 * u as f64 * std::f64::consts::PI) / (2.0 * SIDE as f64)).cos() as f32;
            }
        }
        table
    })
}

/// Hash of one 32x32 grey picture (row-major), and whether it is flat.
fn hash_grey(grey: &[f32; SIDE * SIDE]) -> (u64, bool) {
    let cos = cosines();
    // Rows first (only the 8 lowest horizontal frequencies), then columns.
    let mut rows = [[0f32; LOW]; SIDE];
    for y in 0..SIDE {
        for u in 0..LOW {
            let mut sum = 0f32;
            for x in 0..SIDE {
                sum += grey[y * SIDE + x] * cos[u][x];
            }
            rows[y][u] = sum / 16.0;
        }
    }
    let mut coefficients = [0f32; LOW * LOW];
    for v in 0..LOW {
        for u in 0..LOW {
            let mut sum = 0f32;
            for y in 0..SIDE {
                sum += rows[y][u] * cos[v][y];
            }
            coefficients[v * LOW + u] = sum / 16.0;
        }
    }
    let mut ac: Vec<f32> = coefficients[1..].to_vec();
    let mean_abs = ac.iter().map(|value| value.abs()).sum::<f32>() / ac.len() as f32;
    ac.sort_by(|a, b| a.total_cmp(b));
    let median = ac[ac.len() / 2];
    let mut hash = 0u64;
    for (index, value) in coefficients.iter().enumerate().skip(1) {
        if *value > median {
            hash |= 1 << index;
        }
    }
    (hash, mean_abs < FLAT_LIMIT)
}

/// The 8 variants of a square picture (rotations by 90 degrees and mirrors).
fn variants(grey: &[f32; SIDE * SIDE]) -> [[f32; SIDE * SIDE]; 8] {
    let last = SIDE - 1;
    let mut result = [[0f32; SIDE * SIDE]; 8];
    for y in 0..SIDE {
        for x in 0..SIDE {
            let at = |sy: usize, sx: usize| grey[sy * SIDE + sx];
            let target = y * SIDE + x;
            result[0][target] = at(y, x);
            result[1][target] = at(y, last - x);
            result[2][target] = at(last - y, x);
            result[3][target] = at(last - y, last - x);
            result[4][target] = at(x, y);
            result[5][target] = at(last - x, y);
            result[6][target] = at(x, last - y);
            result[7][target] = at(last - x, last - y);
        }
    }
    result
}

/// Fingerprint of an RGB picture (already in its displayed orientation).
pub fn fingerprint_rgb(rgb: &[u8], width: usize, height: usize) -> Option<Fingerprint> {
    if width == 0 || height == 0 || rgb.len() != width * height * 3 {
        return None;
    }
    let small = thumbnails::resize_area(rgb, width, height, SIDE, SIDE);
    let mut grey = [0f32; SIDE * SIDE];
    for (target, pixel) in grey.iter_mut().zip(small.chunks_exact(3)) {
        *target = 0.299 * pixel[0] as f32 + 0.587 * pixel[1] as f32 + 0.114 * pixel[2] as f32;
    }
    let mut hashes = [0u64; 8];
    let mut flat = false;
    for (index, variant) in variants(&grey).iter().enumerate() {
        let (hash, is_flat) = hash_grey(variant);
        hashes[index] = hash;
        if index == 0 {
            flat = is_flat;
        }
    }
    Some(Fingerprint { hashes, flat })
}

// ---------------------------------------------------------------------------
// Getting the pixels
// ---------------------------------------------------------------------------

/// Limits the full-resolution decodes running at once.
fn heavy_gate() -> &'static (Mutex<usize>, Condvar) {
    static GATE: OnceLock<(Mutex<usize>, Condvar)> = OnceLock::new();
    GATE.get_or_init(|| (Mutex::new(HEAVY_DECODES), Condvar::new()))
}

fn with_heavy_slot<T>(work: impl FnOnce() -> T) -> T {
    let (lock, condvar) = heavy_gate();
    let mut free = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    while *free == 0 {
        free = condvar.wait(free).unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    *free -= 1;
    drop(free);
    let result = work();
    *lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) += 1;
    condvar.notify_one();
    result
}

/// Pixels of the picture as displayed. Cached thumbnail first, then the file.
fn load_rgb(path: &Path, thumbnails_dir: &Path) -> Result<(Vec<u8>, usize, usize), Failure> {
    if let Ok(cached) = crate::thumbnail_cache_file(thumbnails_dir, &path.to_string_lossy()) {
        // The thumbnail was written with the orientation applied: nothing more to do.
        if cached.is_file() {
            if let Ok(decoded) = thumbnails::decode_scaled_rgb(&cached, DECODE_SIDE) {
                return Ok(decoded);
            }
        }
    }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let unreadable = |_: String| Failure::Unreadable;
    match extension.as_str() {
        "jpg" | "jpeg" | "jfif" => {
            let (rgb, width, height) = thumbnails::decode_scaled_rgb(path, DECODE_SIDE).map_err(unreadable)?;
            Ok(thumbnails::apply_orientation(rgb, width, height, thumbnails::read_orientation(path)))
        }
        _ if thumbnails::is_raw_path(path) => {
            let (rgb, width, height) = thumbnails::decode_scaled_rgb(path, DECODE_SIDE).map_err(unreadable)?;
            Ok(thumbnails::apply_orientation(rgb, width, height, thumbnails::read_orientation(path)))
        }
        // HEIC / HEIF: the decoder already applied the rotation of the container.
        "heic" | "heif" => with_heavy_slot(|| thumbnails::decode_scaled_rgb(path, DECODE_SIDE)).map_err(unreadable),
        "png" => with_heavy_slot(|| integrity::decode_png(path, true)).map_err(unreadable),
        "webp" => with_heavy_slot(|| integrity::decode_webp(path, true)).map_err(unreadable),
        _ => Err(Failure::Unsupported),
    }
}

/// Fingerprint of a file.
pub fn fingerprint_file(path: &Path, thumbnails_dir: &Path) -> Result<Fingerprint, Failure> {
    let (rgb, width, height) = load_rgb(path, thumbnails_dir)?;
    fingerprint_rgb(&rgb, width, height).ok_or(Failure::Unreadable)
}

#[cfg(test)]
#[path = "tests/phash.rs"]
mod tests;
