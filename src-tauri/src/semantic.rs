//! Semantic search with SigLIP 2 (spec dev_tools/Evolutions/feat semantic search SigLIP 2.md): model side (this part) — tokenizer,
//! image preprocessing, image and text encoders, fp16 storage of the embeddings.
//!
//! - Images (§4.1): RGB resized to `image_size × image_size` without crop nor padding, with the exact algorithm of PIL's BILINEAR resize
//!   (triangle filter widened when downscaling, i.e. antialiased; 8-bit fixed-point passes, horizontal then vertical), as the reference
//!   processor does; then `/255`, `(x − mean) / std`, NCHW float32. The parity is checked on the `pixel_probe` values of the fixtures.
//! - Text (§4.2, §15.4, §15.6): lowercased, spaces collapsed, short queries wrapped in the template; Gemma tokenizer (`tokenizers` crate)
//!   truncating to `max_text_tokens` itself, so the EOS id stays last; padded with the pad id. Same rules as `normalise_query` in
//!   dev_tools/semantic/common.py.
//! - Encoders: `pooler_output` of the ONNX exports, L2-normalised. Sessions are built by onnx_runtime.rs (few threads, no spinning).
//! - Storage: embeddings are kept as IEEE half floats (little-endian), converted here without any extra crate.

#![allow(dead_code)] // transitional: the scan task (next step) and the searches (phase 3a) use this part

use ort::environment::Environment;
use ort::session::Session;
use ort::value::Tensor;
use std::path::Path;

use crate::semantic_models::ModelSpec;

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
pub fn normalise_query(text: &str, model: &ModelSpec) -> String {
    let lowered = if model.lowercase { text.to_lowercase() } else { text.to_string() };
    let words: Vec<&str> = lowered.split_whitespace().collect();
    let cleaned = words.join(" ");
    if words.len() <= model.template_max_words { model.template.replacen("{}", &cleaned, 1) } else { cleaned }
}

/// Gemma tokenizer of the model, truncating to `max_text_tokens` (EOS kept last) and padding with the pad id.
pub struct TextTokenizer {
    tokenizer: tokenizers::Tokenizer,
    length: usize,
    pad_id: u32,
}

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

#[cfg(test)]
#[path = "tests/semantic.rs"]
mod tests;
