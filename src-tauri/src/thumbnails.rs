//! Génération des miniatures du cache en Rust (JPEG uniquement).
//!
//! Le décodage utilise la réduction d'échelle DCT de `jpeg-decoder` (1/2, 1/4 ou 1/8 selon la taille demandée) :
//! une photo de 24 Mpx n'est jamais décodée en pleine résolution. Le redimensionnement final est une moyenne
//! par aires, l'orientation EXIF est appliquée sur la petite image, puis le résultat est écrit en JPEG.
//! Tout ce qui n'est pas géré (PNG, JPEG CMYK ou 16 bits, fichier corrompu…) renvoie une erreur :
//! l'interface utilise alors son ancienne génération dans le webview.

use std::fs::{self, File};
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use exif::{In, Reader, Tag};
use jpeg_decoder::{Decoder, PixelFormat};
use jpeg_encoder::{ColorType, Encoder};

/// Plus grand côté des miniatures du cache (identique à l'ancienne génération côté interface).
pub const THUMBNAIL_MAX_SIDE: usize = 512;
const THUMBNAIL_JPEG_QUALITY: u8 = 84;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Dimensions d'une miniature (orientation EXIF appliquée).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThumbnailSize {
    pub width: u32,
    pub height: u32,
}

/// Génère la miniature JPEG de `source` dans `destination` (écriture atomique via un fichier temporaire).
pub fn generate_thumbnail(source: &Path, destination: &Path) -> Result<ThumbnailSize, String> {
    let (rgb, width, height) = decode_scaled_rgb(source)?;
    let (rgb, width, height) = resize_to_fit(rgb, width, height, THUMBNAIL_MAX_SIDE);
    let (rgb, width, height) = apply_orientation(rgb, width, height, read_orientation(source));
    write_jpeg(destination, &rgb, width, height)?;
    Ok(ThumbnailSize { width: width as u32, height: height as u32 })
}

/// Dimensions d'une miniature déjà présente dans le cache (lecture de l'en-tête uniquement).
pub fn jpeg_size(path: &Path) -> Result<ThumbnailSize, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut decoder = Decoder::new(BufReader::new(file));
    decoder.read_info().map_err(|error| format!("Miniature illisible : {error}"))?;
    let info = decoder.info().ok_or("En-tête JPEG absent")?;
    Ok(ThumbnailSize { width: info.width as u32, height: info.height as u32 })
}

/// Décode le JPEG en RGB, déjà réduit par le décodeur : le plus grand côté reste >= 1,5 x THUMBNAIL_MAX_SIDE
/// quand l'original est assez grand, sans jamais agrandir une petite image.
fn decode_scaled_rgb(source: &Path) -> Result<(Vec<u8>, usize, usize), String> {
    let file = File::open(source).map_err(|error| error.to_string())?;
    let mut decoder = Decoder::new(BufReader::with_capacity(256 * 1024, file));
    decoder.read_info().map_err(|error| format!("JPEG illisible : {error}"))?;
    // Le décodeur réduit au plus à 1/8 avec un seul coefficient DC par bloc, trop approximatif pour la chrominance :
    // on lui demande 1,5 fois la taille cible (au moins 1/4 pour une photo de 24 Mpx), puis on termine par un
    // redimensionnement par moyenne des aires.
    let side = (THUMBNAIL_MAX_SIDE * 3 / 2) as u16;
    decoder.scale(side, side).map_err(|error| format!("Réduction JPEG impossible : {error}"))?;
    let pixels = decoder.decode().map_err(|error| format!("Décodage JPEG impossible : {error}"))?;
    let info = decoder.info().ok_or("En-tête JPEG absent")?;
    let (width, height) = (info.width as usize, info.height as usize);
    let rgb = match info.pixel_format {
        PixelFormat::RGB24 => pixels,
        PixelFormat::L8 => pixels.iter().flat_map(|&value| [value, value, value]).collect(),
        PixelFormat::L16 | PixelFormat::CMYK32 => return Err("Format de pixels JPEG non pris en charge".into()),
    };
    if width == 0 || height == 0 || rgb.len() != width * height * 3 {
        return Err("Dimensions JPEG incohérentes".into());
    }
    Ok((rgb, width, height))
}

/// Orientation EXIF (1 à 8), 1 si absente ou illisible.
fn read_orientation(source: &Path) -> u32 {
    let Ok(file) = File::open(source) else { return 1; };
    let mut reader = BufReader::new(file);
    Reader::new()
        .read_from_container(&mut reader)
        .ok()
        .and_then(|exif| exif.get_field(Tag::Orientation, In::PRIMARY).and_then(|field| field.value.get_uint(0)))
        .filter(|value| (1..=8).contains(value))
        .unwrap_or(1)
}

fn resize_to_fit(rgb: Vec<u8>, width: usize, height: usize, max_side: usize) -> (Vec<u8>, usize, usize) {
    let longest = width.max(height);
    if longest <= max_side { return (rgb, width, height); }
    let scale = max_side as f64 / longest as f64;
    let new_width = ((width as f64 * scale).round() as usize).max(1);
    let new_height = ((height as f64 * scale).round() as usize).max(1);
    (resize_area(&rgb, width, height, new_width, new_height), new_width, new_height)
}

/// Pour chaque pixel de destination : premier pixel source concerné et poids normalisés (recouvrement exact).
fn axis_weights(source_len: usize, destination_len: usize) -> Vec<(usize, Vec<f32>)> {
    let ratio = source_len as f64 / destination_len as f64;
    (0..destination_len).map(|index| {
        let start = index as f64 * ratio;
        let end = ((index + 1) as f64 * ratio).min(source_len as f64);
        let first = (start.floor() as usize).min(source_len - 1);
        let last = (end.ceil() as usize).clamp(first + 1, source_len);
        let mut weights: Vec<f32> = (first..last)
            .map(|position| (end.min((position + 1) as f64) - start.max(position as f64)).max(0.0) as f32)
            .collect();
        let total: f32 = weights.iter().sum();
        if total > 0.0 { for weight in &mut weights { *weight /= total; } } else { weights = vec![1.0]; }
        (first, weights)
    }).collect()
}

/// Réduction par moyenne des aires (séparable : horizontal puis vertical).
fn resize_area(source: &[u8], source_width: usize, source_height: usize, width: usize, height: usize) -> Vec<u8> {
    let horizontal = axis_weights(source_width, width);
    let vertical = axis_weights(source_height, height);
    let mut intermediate = vec![0f32; width * source_height * 3];
    for y in 0..source_height {
        let row = &source[y * source_width * 3..(y + 1) * source_width * 3];
        for (x, (first, weights)) in horizontal.iter().enumerate() {
            let mut sums = [0f32; 3];
            for (offset, weight) in weights.iter().enumerate() {
                let pixel = (first + offset) * 3;
                sums[0] += row[pixel] as f32 * weight;
                sums[1] += row[pixel + 1] as f32 * weight;
                sums[2] += row[pixel + 2] as f32 * weight;
            }
            let target = (y * width + x) * 3;
            intermediate[target..target + 3].copy_from_slice(&sums);
        }
    }
    let mut output = vec![0u8; width * height * 3];
    for (y, (first, weights)) in vertical.iter().enumerate() {
        for x in 0..width {
            let mut sums = [0f32; 3];
            for (offset, weight) in weights.iter().enumerate() {
                let pixel = ((first + offset) * width + x) * 3;
                sums[0] += intermediate[pixel] * weight;
                sums[1] += intermediate[pixel + 1] * weight;
                sums[2] += intermediate[pixel + 2] * weight;
            }
            let target = (y * width + x) * 3;
            for channel in 0..3 { output[target + channel] = sums[channel].round().clamp(0.0, 255.0) as u8; }
        }
    }
    output
}

/// Applique l'orientation EXIF (2 = miroir horizontal, 3 = 180°, 4 = miroir vertical, 5 = transposition,
/// 6 = 90° horaire, 7 = transversale, 8 = 90° antihoraire) ; 5 à 8 échangent largeur et hauteur.
fn apply_orientation(rgb: Vec<u8>, width: usize, height: usize, orientation: u32) -> (Vec<u8>, usize, usize) {
    if orientation <= 1 || orientation > 8 { return (rgb, width, height); }
    let (out_width, out_height) = if orientation >= 5 { (height, width) } else { (width, height) };
    let mut output = vec![0u8; rgb.len()];
    for y in 0..out_height {
        for x in 0..out_width {
            let (source_x, source_y) = match orientation {
                2 => (width - 1 - x, y),
                3 => (width - 1 - x, height - 1 - y),
                4 => (x, height - 1 - y),
                5 => (y, x),
                6 => (y, height - 1 - x),
                7 => (width - 1 - y, height - 1 - x),
                _ => (width - 1 - y, x),
            };
            let from = (source_y * width + source_x) * 3;
            let to = (y * out_width + x) * 3;
            output[to..to + 3].copy_from_slice(&rgb[from..from + 3]);
        }
    }
    (output, out_width, out_height)
}

fn write_jpeg(destination: &Path, rgb: &[u8], width: usize, height: usize) -> Result<(), String> {
    let parent = destination.parent().ok_or("Dossier de cache invalide")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!("thumb-{}-{}.tmp", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
    let encoded = Encoder::new_file(&temp, THUMBNAIL_JPEG_QUALITY)
        .map_err(|error| error.to_string())
        .and_then(|encoder| encoder.encode(rgb, width as u16, height as u16, ColorType::Rgb).map_err(|error| error.to_string()));
    if let Err(error) = encoded {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temp, destination) {
        let _ = fs::remove_file(&temp);
        if !destination.is_file() { return Err(error.to_string()); }
    }
    Ok(())
}
