//! Génération des miniatures du cache en Rust (JPEG, RAW par leur aperçu intégré, HEIC / HEIF, image fixe des vidéos).
//!
//! Le décodage utilise la réduction d'échelle DCT de `jpeg-decoder` (1/2, 1/4 ou 1/8 selon la taille demandée) :
//! une photo de 24 Mpx n'est jamais décodée en pleine résolution. Le redimensionnement final est une moyenne
//! par aires, l'orientation EXIF est appliquée sur la petite image, puis le résultat est écrit en JPEG.
//! Pour les RAW, on ne fait jamais de décodage, on utilise le jpeg intégré aussi bien pour les miniatures que pour le plein écran
//! Tout ce qui n'est pas géré (PNG, JPEG CMYK ou 16 bits, fichier corrompu…) renvoie une erreur :
//! l'interface utilise alors son ancienne génération dans le webview.
//! Vidéos : une image fixe est extraite (voir video.rs), puis réduite et écrite comme n'importe quelle miniature.
//! Aucune vidéo n'est lue ni décodée au-delà de cette image.

use std::fs::{self, File};
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use exif::{In, Reader, Tag};
use jpeg_decoder::{Decoder, PixelFormat};
use jpeg_encoder::{ColorType, Encoder};

/// JPEG quality of cache thumbnails, chosen in Settings > Storage. "Normal" files are about half the size of "High" ones,
/// with very slightly softer fine textures (measured on library photos at 1024 px). Huffman tables are always optimized:
/// about 3 % smaller files at the same image quality, for about 1.5 ms more per thumbnail.
pub const THUMBNAIL_QUALITY_NORMAL: u8 = 60;
pub const THUMBNAIL_QUALITY_HIGH: u8 = 84;

/// Thumbnail quality in use (false = normal, the default). Set at startup from config.json and by set_thumbnail_quality;
/// existing thumbnails are not rewritten when it changes.
static HIGH_QUALITY_THUMBNAILS: AtomicBool = AtomicBool::new(false);

pub fn set_high_quality_thumbnails(high: bool) {
    HIGH_QUALITY_THUMBNAILS.store(high, Ordering::Relaxed);
}

fn thumbnail_quality() -> u8 {
    if HIGH_QUALITY_THUMBNAILS.load(Ordering::Relaxed) { THUMBNAIL_QUALITY_HIGH } else { THUMBNAIL_QUALITY_NORMAL }
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Dimensions d'une miniature (orientation EXIF appliquée).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThumbnailSize {
    pub width: u32,
    pub height: u32,
}

/// Génère la miniature JPEG de `source` dans `destination` à la taille maximale spécifiée.
pub fn generate_thumbnail(source: &Path, destination: &Path, max_side: usize) -> Result<ThumbnailSize, String> {
    let (rgb, width, height) = render_thumbnail(source, max_side)?;
    write_jpeg(destination, &rgb, width, height)?;
    Ok(ThumbnailSize { width: width as u32, height: height as u32 })
}

/// Pixels of the thumbnail of `source` (RGB, oriented, longest side at most `max_side`), before JPEG encoding: shared by the grid
/// (`generate_thumbnail`) and the semantic scan, which also writes the thumbnails it decodes when asked to.
pub(crate) fn render_thumbnail(source: &Path, max_side: usize) -> Result<(Vec<u8>, usize, usize), String> {
    if crate::video::is_video_path(source) {
        // Video: no EXIF orientation (the frame is already upright).
        let (rgb, width, height) = decode_video_frame(source, max_side)?;
        return Ok(resize_to_fit(rgb, width, height, max_side));
    }
    // RAW : l'aperçu n'est extrait qu'une fois, pour le décodage et pour choisir l'orientation (la même que celle de l'aperçu plein écran).
    let mut raw_orientation_value = None;
    let (rgb, width, height) = if is_raw_path(source) {
        let jpeg = extract_raw_preview(source)?;
        raw_orientation_value = Some(raw_display_orientation(source, &jpeg));
        decode_scaled_jpeg_reader(Cursor::new(jpeg), max_side)?
    } else {
        decode_scaled_rgb(source, max_side)?
    };
    let (rgb, width, height) = resize_to_fit(rgb, width, height, max_side);
    // HEIC / HEIF : le décodeur a déjà appliqué la rotation du conteneur, l'orientation EXIF ne doit pas l'être une seconde fois.
    let orientation = raw_orientation_value.unwrap_or_else(|| if crate::heif::is_heif_path(source) { 1 } else { read_orientation(source) });
    Ok(apply_orientation(rgb, width, height, orientation))
}

/// Image fixe d'une vidéo en RGB : vignette du système (Windows), à défaut `ffmpeg` s'il est installé.
fn decode_video_frame(source: &Path, max_side: usize) -> Result<(Vec<u8>, usize, usize), String> {
    let system_error = match crate::video::system_thumbnail(source, max_side) {
        Ok(frame) => return Ok(frame),
        Err(error) => error,
    };
    match crate::video::ffmpeg_frame_jpeg(source) {
        Ok(bytes) => decode_scaled_jpeg_reader(Cursor::new(bytes), max_side),
        Err(error) => Err(format!("Image de la vidéo impossible à extraire ({system_error} ; {error})")),
    }
}

/// Preview image of a video, larger than the grid thumbnail (same cache as RAW and HEIC previews). Shown full screen:
/// always written in high quality, whatever the thumbnail quality setting.
pub fn generate_video_preview(source: &Path, destination: &Path, max_side: usize) -> Result<(), String> {
    let (rgb, width, height) = decode_video_frame(source, max_side)?;
    let (rgb, width, height) = resize_to_fit(rgb, width, height, max_side);
    write_jpeg_with_quality(destination, &rgb, width, height, THUMBNAIL_QUALITY_HIGH)
}

/// Nombre maximal de pixels d'une image décodée en pleine résolution (PNG, WebP) : un en-tête abîmé ou hostile ne doit pas provoquer l'allocation
/// de plusieurs gigaoctets (l'application avorterait au lieu de signaler le fichier).
pub(crate) const MAX_DECODED_PIXELS: u64 = 250_000_000;

pub(crate) fn check_pixel_count(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_DECODED_PIXELS {
        return Err(format!("Unreasonable image dimensions ({width} × {height})"));
    }
    Ok(())
}

/// PNG décodé en RGB 8 bits ; la transparence éventuelle est un plan à part (`alpha`).
pub(crate) struct DecodedPng {
    pub rgb: Vec<u8>,
    pub alpha: Option<Vec<u8>>,
    pub width: usize,
    pub height: usize,
    pub icc: Option<Vec<u8>>,
}

/// Décode un PNG (palettes, niveaux de gris et 16 bits ramenés au RGB(A) 8 bits). `want_pixels` faux : le fichier est entièrement décodé et contrôlé,
/// mais les pixels ne sont pas convertis (RGB vide renvoyé). `verify_end` : lit aussi la suite du fichier jusqu'à la fin du flux, pour détecter un PNG
/// tronqué après les données image (vérification d'intégrité). Les dimensions sont contrôlées avant toute allocation.
pub(crate) fn decode_png<R: std::io::BufRead + Seek>(source: R, want_pixels: bool, verify_end: bool) -> Result<DecodedPng, String> {
    let mut decoder = png::Decoder::new(source);
    // EXPAND : palettes, niveaux de gris < 8 bits et tRNS deviennent du RGB(A) 8 bits ; STRIP_16 : 16 bits -> 8 bits.
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|error| format!("PNG illisible : {error}"))?;
    check_pixel_count(reader.info().width, reader.info().height)?;
    let icc = reader.info().icc_profile.as_ref().map(|profile| profile.to_vec());
    let mut buffer = vec![0u8; reader.output_buffer_size().ok_or("PNG trop grand")?];
    let frame = reader.next_frame(&mut buffer).map_err(|error| format!("PNG decoding failed: {error}"))?;
    if verify_end { reader.finish().map_err(|error| format!("Fin de fichier PNG invalide : {error}"))?; }
    let (width, height) = (frame.width as usize, frame.height as usize);
    if width == 0 || height == 0 { return Err("Inconsistent PNG dimensions".into()); }
    if frame.bit_depth != png::BitDepth::Eight { return Err("Profondeur de bits PNG non prise en charge".into()); }
    if !want_pixels { return Ok(DecodedPng { rgb: Vec::new(), alpha: None, width, height, icc }); }
    let data = &buffer[..frame.buffer_size()];
    let pixel_count = width * height;
    let (rgb, alpha) = match frame.color_type {
        png::ColorType::Rgb => (data.to_vec(), None),
        png::ColorType::Rgba => {
            let mut rgb = Vec::with_capacity(pixel_count * 3);
            let mut alpha = Vec::with_capacity(pixel_count);
            for pixel in data.chunks_exact(4) { rgb.extend_from_slice(&pixel[..3]); alpha.push(pixel[3]); }
            (rgb, Some(alpha))
        }
        png::ColorType::Grayscale => (data.iter().flat_map(|&value| [value, value, value]).collect(), None),
        png::ColorType::GrayscaleAlpha => {
            let mut rgb = Vec::with_capacity(pixel_count * 3);
            let mut alpha = Vec::with_capacity(pixel_count);
            for pixel in data.chunks_exact(2) { rgb.extend_from_slice(&[pixel[0], pixel[0], pixel[0]]); alpha.push(pixel[1]); }
            (rgb, Some(alpha))
        }
        png::ColorType::Indexed => return Err("Indexed PNG not supported".into()),
    };
    if rgb.len() != pixel_count * 3 { return Err("Inconsistent PNG dimensions".into()); }
    Ok(DecodedPng { rgb, alpha, width, height, icc })
}

/// Dimensions d'une miniature déjà présente dans le cache (lecture de l'en-tête uniquement).
pub fn jpeg_size(path: &Path) -> Result<ThumbnailSize, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut decoder = Decoder::new(BufReader::new(file));
    decoder.read_info().map_err(|error| format!("Miniature illisible : {error}"))?;
    let info = decoder.info().ok_or("Missing JPEG header")?;
    Ok(ThumbnailSize { width: info.width as u32, height: info.height as u32 })
}

use std::io::{Cursor, Read, Seek, SeekFrom};

///////
/// EXTRACTEURS RAW
///////

/// Extrait le flux JPEG de prévisualisation contenu dans un fichier RAW.
pub fn extract_raw_preview(source: &Path) -> Result<Vec<u8>, String> {
    let mut file = File::open(source).map_err(|e| e.to_string())?;
    let mut header = [0u8; 16];
    let n = file.read(&mut header).map_err(|e| e.to_string())?;
    if n < 16 {
        return Err("Fichier RAW trop court".into());
    }

    // 1. Cas spécifique : Fujifilm RAF
    if header.starts_with(b"FUJIFILMCCD-RAW") {
        file.seek(SeekFrom::Start(0x54)).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 8];
        file.read_exact(&mut buf).map_err(|e| e.to_string())?;
        let offset = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as u64;
        let length = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]) as usize;
        // Offset et longueur viennent du fichier : un en-tête corrompu ne doit pas provoquer une allocation énorme.
        let file_len = file.metadata().map_err(|e| e.to_string())?.len();
        let fits = offset.checked_add(length as u64).is_some_and(|end| end <= file_len);
        if offset > 0 && length > 1000 && fits {
            file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            let mut jpeg_data = vec![0u8; length];
            file.read_exact(&mut jpeg_data).map_err(|e| e.to_string())?;
            if jpeg_data.starts_with(&[0xff, 0xd8]) {
                return Ok(jpeg_data);
            }
        }
    }

    // 2. Cas spécifique : Canon CR3 (conteneur ISO BMFF)
    // Recherche de la boîte PRVW dans les premiers mégaoctets
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext == "cr3" {
        if let Ok(jpeg) = find_cr3_preview(&mut file) {
            return Ok(jpeg);
        }
    }

    // 3. Fichiers basés sur TIFF (ARW, CR2, NEF, DNG, ORF, RW2) et fallback universel
    // On scanne les premiers 8 Mo pour localiser le JPEG de prévisualisation (commence par FF D8 FF)
    match find_embedded_jpeg_stream(&mut file) {
        Ok(jpeg) => Ok(jpeg),
        // Pas de JPEG intégré : certains DNG (téléphones) n'ont qu'une vignette RGB non compressée dans l'IFD0, ré-encodée en JPEG (petite image).
        Err(error) => tiff_rgb_thumbnail_jpeg(&mut file).ok_or(error),
    }
}

/// Vignette RGB 8 bits non compressée de l'IFD0 d'un fichier TIFF (DNG de téléphone), encodée en JPEG. None si l'IFD0 n'est pas de ce type :
/// compression, photométrie, bits et tailles des bandes sont tous vérifiés avant de lire les pixels.
fn tiff_rgb_thumbnail_jpeg(file: &mut File) -> Option<Vec<u8>> {
    let mut header = [0u8; 8];
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_exact(&mut header).ok()?;
    let little = match &header[..4] { b"II* " => true, b"MM *" => false, _ => return None };
    let short = |b: [u8; 2]| if little { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) };
    let long = |b: [u8; 4]| if little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) };
    file.seek(SeekFrom::Start(long([header[4], header[5], header[6], header[7]]) as u64)).ok()?;
    let mut count = [0u8; 2];
    file.read_exact(&mut count).ok()?;
    let mut entries = vec![0u8; short(count) as usize * 12];
    file.read_exact(&mut entries).ok()?;
    // Valeurs numériques d'une entrée : inline (SHORT / LONG, une seule) ou lues à l'adresse indiquée (liste de bandes).
    let mut read_values = |tag: u16| -> Option<Vec<u32>> {
        let entry = entries.chunks_exact(12).find(|e| short([e[0], e[1]]) == tag)?;
        let (kind, n) = (short([entry[2], entry[3]]), long([entry[4], entry[5], entry[6], entry[7]]) as usize);
        let size = match kind { 3 => 2, 4 => 4, _ => return None };
        if n == 0 || n > 100_000 { return None; }
        let raw: Vec<u8> = if size * n <= 4 {
            entry[8..8 + size * n].to_vec()
        } else {
            let mut data = vec![0u8; size * n];
            file.seek(SeekFrom::Start(long([entry[8], entry[9], entry[10], entry[11]]) as u64)).ok()?;
            file.read_exact(&mut data).ok()?;
            data
        };
        Some(raw.chunks_exact(size).map(|c| if size == 2 { short([c[0], c[1]]) as u32 } else { long([c[0], c[1], c[2], c[3]]) }).collect())
    };
    let (width, height) = (*read_values(0x100)?.first()? as usize, *read_values(0x101)?.first()? as usize);
    let compression = read_values(0x103)?.first().copied()?;
    let photometric = read_values(0x106)?.first().copied()?;
    let bits = read_values(0x102)?;
    let samples = read_values(0x115).and_then(|v| v.first().copied()).unwrap_or(1);
    let planar = read_values(0x11c).and_then(|v| v.first().copied()).unwrap_or(1);
    if compression != 1 || photometric != 2 || samples != 3 || planar != 1 || bits != [8, 8, 8] { return None; }
    if width == 0 || height == 0 || width * height > 16_000_000 { return None; }
    let (offsets, lengths) = (read_values(0x111)?, read_values(0x117)?);
    if offsets.len() != lengths.len() || lengths.iter().map(|&l| l as usize).sum::<usize>() != width * height * 3 { return None; }
    let mut rgb = Vec::with_capacity(width * height * 3);
    for (offset, length) in offsets.iter().zip(&lengths) {
        file.seek(SeekFrom::Start(*offset as u64)).ok()?;
        file.by_ref().take(*length as u64).read_to_end(&mut rgb).ok()?;
    }
    if rgb.len() != width * height * 3 { return None; }
    let mut jpeg = Vec::new();
    Encoder::new(&mut jpeg, 92).encode(&rgb, width as u16, height as u16, ColorType::Rgb).ok()?;
    Some(jpeg)
}

/// Fin (exclue) du flux JPEG qui commence en `start` (marqueur SOI). Les segments sont parcourus par leur longueur : une vignette EXIF intégrée,
/// avec son propre EOI, ne termine donc pas l'image ; puis les données de l'image sont lues jusqu'à l'EOI. None si le flux est tronqué ou illisible.
fn jpeg_stream_end(data: &[u8], start: usize) -> Option<usize> {
    let mut pos = start.checked_add(2)?;
    loop {
        // Octets de remplissage 0xFF, puis marqueur.
        if *data.get(pos)? != 0xff { return None; }
        while *data.get(pos)? == 0xff { pos += 1; }
        let marker = *data.get(pos)?;
        pos += 1;
        match marker {
            0xd9 => return Some(pos),
            0x01 | 0xd0..=0xd7 => continue, // marqueurs sans contenu
            0x00 | 0xd8 => return None,
            _ => {}
        }
        let length = u16::from_be_bytes([*data.get(pos)?, *data.get(pos + 1)?]) as usize;
        if length < 2 { return None; }
        pos = pos.checked_add(length)?;
        if pos > data.len() { return None; }
        if marker == 0xda {
            // Données de l'image : jusqu'au prochain marqueur (0xFF suivi d'autre chose que 0x00 ou d'un redémarrage RSTn).
            loop {
                let at = pos + data[pos..].iter().position(|&byte| byte == 0xff)?;
                match *data.get(at + 1)? {
                    0x00 | 0xd0..=0xd7 => pos = at + 2,
                    _ => {
                        pos = at;
                        break;
                    }
                }
            }
        }
    }
}

/// Plus grand flux JPEG complet (au moins 20 Ko, pour éviter les minuscules icônes 160x120) du tampon : (début, longueur).
fn largest_jpeg_in(buffer: &[u8]) -> Option<(usize, usize)> {
    let mut largest_jpeg: Option<(usize, usize)> = None;
    let mut i = 0;
    while i + 4 <= buffer.len() {
        // Marqueur de début de JPEG (SOI) suivi d'un marqueur valide (APP0..APP15 ou DQT ou SOF)
        if buffer[i] == 0xff && buffer[i + 1] == 0xd8 && buffer[i + 2] == 0xff {
            let marker = buffer[i + 3];
            if (0xe0..=0xef).contains(&marker) || marker == 0xdb || marker == 0xc0 || marker == 0xc2 {
                let start = i;
                // Flux tronqué ou illisible : pas un aperçu, la recherche continue.
                let Some(end) = jpeg_stream_end(buffer, start) else {
                    i += 1;
                    continue;
                };
                let len = end - start;
                if len >= 20_000 && largest_jpeg.map_or(true, |(_, best)| len > best) {
                    largest_jpeg = Some((start, len));
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    largest_jpeg
}

/// Recherche un flux JPEG intégré dans le fichier (méthode rapide par segments de 512 Ko)
fn find_embedded_jpeg_stream(file: &mut File) -> Result<Vec<u8>, String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    // La plupart des previews RAW sont dans les 12 premiers mégaoctets
    let max_search: usize = 12 * 1024 * 1024;
    let mut buffer = Vec::with_capacity(max_search);
    file.by_ref().take(max_search as u64).read_to_end(&mut buffer).map_err(|e| e.to_string())?;

    let largest_jpeg = largest_jpeg_in(&buffer);
    // Certains RAW (Pentax PEF) rangent le grand JPEG à la fin du fichier, après les données du capteur : si la tête ne donne qu'une petite image,
    // la fin du fichier est aussi parcourue.
    let file_len = file.metadata().map_err(|e| e.to_string())?.len();
    let small = largest_jpeg.map_or(true, |(_, len)| len < 500_000);
    if small && file_len > max_search as u64 {
        let tail_start = file_len.saturating_sub(8 * 1024 * 1024).max(max_search as u64);
        let mut tail = Vec::new();
        file.seek(SeekFrom::Start(tail_start)).map_err(|e| e.to_string())?;
        file.by_ref().take(8 * 1024 * 1024).read_to_end(&mut tail).map_err(|e| e.to_string())?;
        if let Some((start, len)) = largest_jpeg_in(&tail) {
            if largest_jpeg.map_or(true, |(_, best)| len > best) { return Ok(tail[start..start + len].to_vec()); }
        }
    }

    if let Some((start, len)) = largest_jpeg {
        return Ok(buffer[start..start + len].to_vec());
    }

    // Sinon, le premier flux JPEG complet, même petit (ex: 8 Ko).
    let mut from = 0;
    while let Some(relative) = buffer[from..].windows(3).position(|w| w == [0xff, 0xd8, 0xff]) {
        let pos = from + relative;
        if let Some(end) = jpeg_stream_end(&buffer, pos) { return Ok(buffer[pos..end].to_vec()); }
        from = pos + 1;
    }

    Err("No JPEG preview found in the RAW file".into())
}

/// Extraction spécifique pour Canon CR3 (boîte PRVW)
fn find_cr3_preview(file: &mut File) -> Result<Vec<u8>, String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    file.take(8 * 1024 * 1024).read_to_end(&mut buffer).map_err(|e| e.to_string())?;

    // Dans un CR3, la boîte 'PRVW' contient la preview JPEG.
    // L'en-tête de boîte fait 8 octets : 4 octets de taille + 4 octets de nom ('PRVW')
    if let Some(pos) = buffer.windows(4).position(|w| w == b"PRVW") {
        let content_start = pos + 4;
        // On cherche le marqueur FF D8 dans les 128 octets suivants
        if let Some(soi_rel) = buffer[content_start..content_start + 128.min(buffer.len() - content_start)]
            .windows(2)
            .position(|w| w == [0xff, 0xd8])
        {
            let jpeg_start = content_start + soi_rel;
            if let Some(end) = jpeg_stream_end(&buffer, jpeg_start) { return Ok(buffer[jpeg_start..end].to_vec()); }
        }
    }
    Err("CR3 preview not found".into())
}

///////


/// Décode un flux JPEG en RGB avec réduction DCT d'échelle proportionnelle à max_side.
pub(crate) fn decode_scaled_jpeg_reader<R: Read>(reader: R, max_side: usize) -> Result<(Vec<u8>, usize, usize), String> {
    let mut decoder = Decoder::new(reader);
    decoder.read_info().map_err(|error| format!("Unreadable JPEG: {error}"))?;
    let side = (max_side * 3 / 2) as u16;
    decoder.scale(side, side).map_err(|error| format!("JPEG downscaling failed: {error}"))?;
    let pixels = decoder.decode().map_err(|error| format!("JPEG decoding failed: {error}"))?;
    let info = decoder.info().ok_or("Missing JPEG header")?;
    let (width, height) = (info.width as usize, info.height as usize);
    let rgb = match info.pixel_format {
        PixelFormat::RGB24 => pixels,
        PixelFormat::L8 => pixels.iter().flat_map(|&value| [value, value, value]).collect(),
        PixelFormat::L16 | PixelFormat::CMYK32 => return Err("Unsupported JPEG pixel format".into()),
    };
    if width == 0 || height == 0 || rgb.len() != width * height * 3 {
        return Err("Inconsistent JPEG dimensions".into());
    }
    Ok((rgb, width, height))
}

pub(crate) fn decode_scaled_rgb(source: &Path, max_side: usize) -> Result<(Vec<u8>, usize, usize), String> {
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    
    // Si c'est un format RAW, on extrait la prévisualisation JPEG intégrée
    let is_raw = is_raw_extension(&ext);
    if is_raw {
        let jpeg_bytes = extract_raw_preview(source)?;
        return decode_scaled_jpeg_reader(Cursor::new(jpeg_bytes), max_side);
    }

    // HEIC / HEIF : décodage complet en Rust pur (crate heic-rs), pas de réduction DCT possible comme pour le JPEG
    if crate::heif::is_heif_path(source) {
        let decoded = crate::heif::decode(source)?;
        return Ok((decoded.rgb, decoded.width, decoded.height));
    }

    // Sinon décodage JPEG standard direct depuis le fichier
    let file = File::open(source).map_err(|error| error.to_string())?;
    decode_scaled_jpeg_reader(BufReader::with_capacity(256 * 1024, file), max_side)
}

/// Orientation (1 à 8) d'un EXIF déjà lu, None si le tag est absent ou hors plage.
fn orientation_of(exif: &exif::Exif) -> Option<u32> {
    exif.get_field(Tag::Orientation, In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        .filter(|value| (1..=8).contains(value))
}

/// Lecture tolérante : un RAW dont une entrée IFD est mal formée (fréquent) garde les champs déjà lus au lieu de perdre tout l'EXIF.
fn lenient_exif(result: Result<exif::Exif, exif::Error>) -> Option<exif::Exif> {
    result.or_else(|error| error.distill_partial_result(|_| {})).ok()
}

/// Orientation to apply to the decoded pixels (1 to 8), 1 if absent or unreadable: EXIF tag or XMP `tiff:Orientation`, whichever wins
/// (see orientation.rs). For a RAW, the orientation to apply to its JPEG preview (see `raw_display_orientation`).
/// HEIC / HEIF keep their EXIF tag only: the callers that decode them already skip it (the container rotation is applied by the decoder).
pub(crate) fn read_orientation(source: &Path) -> u32 {
    if is_raw_path(source) {
        return extract_raw_preview(source).map(|jpeg| raw_display_orientation(source, &jpeg)).unwrap_or(1);
    }
    match crate::orientation::kind_of(source) {
        crate::orientation::Kind::Fixed => container_orientation(source).unwrap_or(1),
        _ => crate::orientation::read(source).stored,
    }
}

/// EXIF orientation tag of the file itself (the one the webview applies to an image it shows), None if absent.
pub(crate) fn exif_orientation(source: &Path) -> Option<u32> {
    container_orientation(source)
}

/// Orientation of a RAW preview, sidecar `tiff:Orientation` included (a lossless rotation writes it there, see orientation.rs).
pub(crate) fn raw_display_orientation(source: &Path, jpeg: &[u8]) -> u32 {
    let preview = raw_orientation(source, jpeg);
    crate::orientation::raw_preview_orientation(preview, container_orientation(source).unwrap_or(1), crate::exif::read_xmp_orientation(source))
}

/// RAW extensions (lowercase): the single backend list, used by the catalogue (library_sync), previews, faces, resize, content search.
/// The frontend has its own copy (`RAW_EXTENSIONS` in src/format-filters.js), kept equal by the test `raw_extensions_match_the_frontend`.
pub(crate) const RAW_EXTENSIONS: [&str; 11] = ["arw", "cr2", "cr3", "nef", "nrw", "dng", "raf", "orf", "rw2", "pef", "raw"];

/// `extension` without the dot, any case.
pub(crate) fn is_raw_extension(extension: &str) -> bool {
    RAW_EXTENSIONS.iter().any(|raw| raw.eq_ignore_ascii_case(extension))
}

pub(crate) fn is_raw_path(source: &Path) -> bool {
    source.extension().and_then(|e| e.to_str()).is_some_and(is_raw_extension)
}

/// Orientation du fichier lui-même (EXIF d'un JPEG, IFD0 d'un RAW basé sur TIFF, boîte CMT1 d'un CR3, JPEG intégré d'un RAF).
fn container_orientation(source: &Path) -> Option<u32> {
    read_exif_sources(source).iter().find_map(orientation_of)
}

/// Contenu d'une boîte du conteneur ISO BMFF d'un CR3 (nom de 4 octets) : ici un bloc TIFF autonome.
fn cr3_box<'a>(buffer: &'a [u8], name: &[u8; 4]) -> Option<&'a [u8]> {
    let mut from = 4;
    while let Some(relative) = buffer.get(from..)?.windows(4).position(|w| w == name) {
        let at = from + relative;
        let size = u32::from_be_bytes(buffer.get(at - 4..at)?.try_into().ok()?) as usize;
        let content = buffer.get(at + 4..(at - 4).checked_add(size)?);
        // Un vrai bloc TIFF commence par II*\0 ou MM\0* ; sinon c'était une suite d'octets quelconque, la recherche continue.
        if let Some(content) = content.filter(|c| c.starts_with(b"II*\0") || c.starts_with(b"MM\0*")) { return Some(content); }
        from = at + 1;
    }
    None
}

/// Bloc TIFF de la boîte CMT2 d'un CR3 : son IFD0 est directement l'IFD Exif, que kamadak-exif classerait alors comme IFD TIFF (ISO, ouverture,
/// date… introuvables). Un IFD0 minimal est ajouté en fin de bloc, avec le seul pointeur Exif (0x8769) vers l'IFD d'origine : les décalages internes restent valides.
fn tiff_as_exif_ifd(tiff: &[u8]) -> Vec<u8> {
    if tiff.len() < 8 { return tiff.to_vec(); }
    let little = tiff.starts_with(b"II");
    let word = |bytes: [u8; 4]| if little { u32::from_le_bytes(bytes) } else { u32::from_be_bytes(bytes) };
    let short = |value: u16| if little { value.to_le_bytes() } else { value.to_be_bytes() };
    let long = |value: u32| if little { value.to_le_bytes() } else { value.to_be_bytes() };
    let original_ifd = word([tiff[4], tiff[5], tiff[6], tiff[7]]);
    let mut output = tiff.to_vec();
    if output.len() % 2 != 0 { output.push(0); }
    let new_ifd = output.len() as u32;
    output.extend_from_slice(&short(1));
    output.extend_from_slice(&short(0x8769));
    output.extend_from_slice(&short(4));
    output.extend_from_slice(&long(1));
    output.extend_from_slice(&long(original_ifd));
    output.extend_from_slice(&long(0));
    output[4..8].copy_from_slice(&long(new_ifd));
    output
}

/// EXIF d'un fichier, une ou plusieurs sources à lire dans l'ordre (la dernière l'emporte pour une même valeur) :
/// - CR3 : conteneur que kamadak-exif ne lit pas ; l'EXIF de prise de vue est dans la boîte CMT2, l'identité de l'appareil et l'orientation dans CMT1 ;
/// - RAF : l'EXIF est celui du JPEG intégré (position et longueur dans l'en-tête, comme pour l'aperçu) ;
/// - autres : lecture directe du fichier (JPEG, TIFF et RAW basés sur TIFF), tolérante aux entrées IFD mal formées.
pub(crate) fn read_exif_sources(source: &Path) -> Vec<exif::Exif> {
    let Ok(mut file) = File::open(source) else { return Vec::new(); };
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mut reader = Reader::new();
    reader.continue_on_error(true);
    if ext == "cr3" {
        let mut buffer = Vec::new();
        if file.by_ref().take(8 * 1024 * 1024).read_to_end(&mut buffer).is_err() { return Vec::new(); }
        let exif_ifd = cr3_box(&buffer, b"CMT2").map(tiff_as_exif_ifd);
        let ifd0 = cr3_box(&buffer, b"CMT1").map(<[u8]>::to_vec);
        return [exif_ifd, ifd0].into_iter().flatten().filter_map(|tiff| lenient_exif(reader.read_raw(tiff))).collect();
    }
    let mut header = [0u8; 0x5c];
    if file.read_exact(&mut header).is_ok() && header.starts_with(b"FUJIFILMCCD-RAW") {
        let offset = u32::from_be_bytes([header[0x54], header[0x55], header[0x56], header[0x57]]) as u64;
        let length = u32::from_be_bytes([header[0x58], header[0x59], header[0x5a], header[0x5b]]) as u64;
        // Seul le début du JPEG est lu : son EXIF précède les données de l'image.
        let mut jpeg = Vec::new();
        let read = file.seek(SeekFrom::Start(offset)).and_then(|_| file.by_ref().take(length.min(1024 * 1024)).read_to_end(&mut jpeg));
        return match read {
            Ok(_) => lenient_exif(reader.read_from_container(&mut Cursor::new(jpeg))).into_iter().collect(),
            Err(_) => Vec::new(),
        };
    }
    if file.seek(SeekFrom::Start(0)).is_err() { return Vec::new(); }
    lenient_exif(reader.read_from_container(&mut BufReader::new(file))).into_iter().collect()
}

/// Orientation à appliquer à l'aperçu JPEG `jpeg` extrait du RAW `source`, identique pour la miniature et pour l'aperçu affiché par le webview.
/// Selon le constructeur, l'aperçu est tel que sorti du capteur (l'orientation du RAW s'applique), déjà pivoté (rien à appliquer) ou porte son propre
/// tag EXIF (le webview l'applique seul). Ordre : tag explicite de l'aperçu, sauf aperçu paysage pour une prise de vue en portrait ; sinon orientation du RAW,
/// sauf aperçu déjà en portrait.
pub(crate) fn raw_orientation(source: &Path, jpeg: &[u8]) -> u32 {
    let own = lenient_exif(Reader::new().continue_on_error(true).read_from_container(&mut Cursor::new(jpeg))).as_ref().and_then(orientation_of);
    let container = container_orientation(source).unwrap_or(1);
    let mut decoder = Decoder::new(Cursor::new(jpeg));
    let portrait_preview = decoder.read_info().ok().and_then(|_| decoder.info()).is_some_and(|info| info.height > info.width);
    match own {
        Some(value) if value >= 2 => value,
        Some(_) if container >= 5 && !portrait_preview => container,
        Some(value) => value,
        None if container >= 5 && portrait_preview => 1,
        None => container,
    }
}

/// Aperçu JPEG dont l'orientation EXIF est celle de `raw_orientation` : le webview l'applique seul (plein écran, aperçu, comparaison), comme la miniature.
/// Les octets de l'image ne sont pas retouchés : seul le segment EXIF APP1 est remplacé par un segment minimal ne contenant que l'orientation.
pub(crate) fn preview_with_orientation(source: &Path, jpeg: Vec<u8>) -> Vec<u8> {
    let wanted = raw_display_orientation(source, &jpeg);
    let own = lenient_exif(Reader::new().continue_on_error(true).read_from_container(&mut Cursor::new(&jpeg[..]))).as_ref().and_then(orientation_of);
    if wanted == own.unwrap_or(1) || jpeg.len() < 4 { return jpeg; }
    // Segments avant l'image : tout APP1 « Exif » est retiré, le nouveau est inséré après un éventuel APP0 (JFIF).
    let mut output = Vec::with_capacity(jpeg.len() + 40);
    output.extend_from_slice(&jpeg[..2]);
    let mut pos = 2;
    let mut inserted = false;
    let insert = |output: &mut Vec<u8>| {
        output.extend_from_slice(&[0xff, 0xe1, 0x00, 0x22]);
        output.extend_from_slice(b"Exif\0\0MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01");
        output.extend_from_slice(&[0x00, wanted as u8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    };
    while pos + 4 <= jpeg.len() && jpeg[pos] == 0xff && jpeg[pos + 1] != 0xda {
        let marker = jpeg[pos + 1];
        let length = u16::from_be_bytes([jpeg[pos + 2], jpeg[pos + 3]]) as usize;
        let end = pos + 2 + length;
        if length < 2 || end > jpeg.len() { return jpeg; }
        let is_exif = marker == 0xe1 && jpeg[pos + 4..end].starts_with(b"Exif\0\0");
        if marker != 0xe0 && !inserted { insert(&mut output); inserted = true; }
        if !is_exif { output.extend_from_slice(&jpeg[pos..end]); }
        pos = end;
    }
    if !inserted { insert(&mut output); }
    output.extend_from_slice(&jpeg[pos..]);
    output
}

pub(crate) fn resize_to_fit(rgb: Vec<u8>, width: usize, height: usize, max_side: usize) -> (Vec<u8>, usize, usize) {
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
pub(crate) fn resize_area(source: &[u8], source_width: usize, source_height: usize, width: usize, height: usize) -> Vec<u8> {
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
pub(crate) fn apply_orientation(rgb: Vec<u8>, width: usize, height: usize, orientation: u32) -> (Vec<u8>, usize, usize) {
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

/// Writes a cache thumbnail at the quality chosen in the settings.
pub(crate) fn write_jpeg(destination: &Path, rgb: &[u8], width: usize, height: usize) -> Result<(), String> {
    write_jpeg_with_quality(destination, rgb, width, height, thumbnail_quality())
}

/// Atomic write (temporary file, then rename) of an RGB image as a JPEG with optimized Huffman tables.
pub(crate) fn write_jpeg_with_quality(destination: &Path, rgb: &[u8], width: usize, height: usize, quality: u8) -> Result<(), String> {
    let parent = destination.parent().ok_or("Dossier de cache invalide")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!("thumb-{}-{}.tmp", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
    let encoded = Encoder::new_file(&temp, quality)
        .map_err(|error| error.to_string())
        .and_then(|mut encoder| {
            encoder.set_optimized_huffman_tables(true);
            encoder.encode(rgb, width as u16, height as u16, ColorType::Rgb).map_err(|error| error.to_string())
        });
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

#[cfg(test)]
#[path = "tests/thumbnails.rs"]
mod tests;
