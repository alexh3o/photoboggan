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
            for pixel in data.as_chunks::<4>().0 { rgb.extend_from_slice(&pixel[..3]); alpha.push(pixel[3]); }
            (rgb, Some(alpha))
        }
        png::ColorType::Grayscale => (data.iter().flat_map(|&value| [value, value, value]).collect(), None),
        png::ColorType::GrayscaleAlpha => {
            let mut rgb = Vec::with_capacity(pixel_count * 3);
            let mut alpha = Vec::with_capacity(pixel_count);
            for pixel in data.as_chunks::<2>().0 { rgb.extend_from_slice(&[pixel[0], pixel[0], pixel[0]]); alpha.push(pixel[1]); }
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
        let entry = entries.as_chunks::<12>().0.iter().find(|e| short([e[0], e[1]]) == tag)?;
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
                if len >= 20_000 && largest_jpeg.is_none_or(|(_, best)| len > best) {
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
    let small = largest_jpeg.is_none_or(|(_, len)| len < 500_000);
    if small && file_len > max_search as u64 {
        let tail_start = file_len.saturating_sub(8 * 1024 * 1024).max(max_search as u64);
        let mut tail = Vec::new();
        file.seek(SeekFrom::Start(tail_start)).map_err(|e| e.to_string())?;
        file.by_ref().take(8 * 1024 * 1024).read_to_end(&mut tail).map_err(|e| e.to_string())?;
        if let Some((start, len)) = largest_jpeg_in(&tail) {
            if largest_jpeg.is_none_or(|(_, best)| len > best) { return Ok(tail[start..start + len].to_vec()); }
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
    if !output.len().is_multiple_of(2) { output.push(0); }
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

/// Encodes an RGB buffer as JPEG bytes in memory with optimized Huffman tables (zero disk writes).
pub(crate) fn encode_jpeg_bytes(rgb: &[u8], width: usize, height: usize, quality: u8) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::new();
    let mut encoder = Encoder::new(&mut buffer, quality);
    encoder.set_optimized_huffman_tables(true);
    encoder
        .encode(rgb, width as u16, height as u16, ColorType::Rgb)
        .map_err(|error| error.to_string())?;
    Ok(buffer)
}

/// Fast single-pass RAM JPEG encoding (skips 2-pass Huffman optimization for transient import thumbnails).
fn encode_jpeg_bytes_fast(rgb: &[u8], width: usize, height: usize, quality: u8) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::new();
    let mut encoder = Encoder::new(&mut buffer, quality);
    encoder.set_optimized_huffman_tables(false);
    encoder
        .encode(rgb, width as u16, height as u16, ColorType::Rgb)
        .map_err(|error| error.to_string())?;
    Ok(buffer)
}

/// Reads (width, height) from the first SOF marker of an in-memory JPEG without decoding pixels.
fn jpeg_sof_dimensions(data: &[u8]) -> Option<(usize, usize)> {
    if data.len() < 4 || data[0] != 0xff || data[1] != 0xd8 {
        return None;
    }
    let mut i = 2usize;
    while i < data.len() {
        while i < data.len() && data[i] != 0xff {
            i += 1;
        }
        while i < data.len() && data[i] == 0xff {
            i += 1;
        }
        if i >= data.len() {
            break;
        }
        let marker = data[i];
        i += 1;
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if marker == 0x00 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if i + 2 > data.len() {
            break;
        }
        let seg_len = u16::from_be_bytes([data[i], data[i + 1]]) as usize;
        if seg_len < 2 || i + seg_len > data.len() {
            break;
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) && seg_len >= 7 {
            let h = u16::from_be_bytes([data[i + 3], data[i + 4]]) as usize;
            let w = u16::from_be_bytes([data[i + 5], data[i + 6]]) as usize;
            if w > 0 && h > 0 {
                return Some((w, h));
            }
            return None;
        }
        i += seg_len;
    }
    None
}

fn extract_raf_preview_fast(file: &mut File, file_len: u64) -> Option<Vec<u8>> {
    file.seek(SeekFrom::Start(0x54)).ok()?;
    let mut buf = [0u8; 8];
    file.read_exact(&mut buf).ok()?;
    let offset = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as u64;
    let length = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]) as usize;
    if offset == 0 || length < 1000 || offset.checked_add(length as u64).is_none_or(|end| end > file_len) {
        return None;
    }
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut jpeg = vec![0u8; length];
    file.read_exact(&mut jpeg).ok()?;
    jpeg.starts_with(&[0xff, 0xd8]).then_some(jpeg)
}

fn extract_cr3_preview_fast(file: &mut File, file_len: u64) -> Option<Vec<u8>> {
    const CANON_PRVW_UUID: [u8; 16] = [
        0xea, 0xf4, 0x2b, 0x5e, 0x1c, 0x98, 0x4b, 0x88,
        0xb9, 0xfb, 0xb7, 0xdc, 0x40, 0x6e, 0x4d, 0x16,
    ];
    let mut pos = 0u64;
    for _ in 0..64 {
        if pos + 8 > file_len {
            break;
        }
        file.seek(SeekFrom::Start(pos)).ok()?;
        let mut hdr = [0u8; 8];
        file.read_exact(&mut hdr).ok()?;
        let size32 = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as u64;
        let box_type = [hdr[4], hdr[5], hdr[6], hdr[7]];
        let (box_size, hdr_len) = if size32 == 1 {
            if pos + 16 > file_len {
                break;
            }
            let mut ext = [0u8; 8];
            file.read_exact(&mut ext).ok()?;
            (u64::from_be_bytes(ext), 16u64)
        } else if size32 == 0 {
            (file_len - pos, 8u64)
        } else {
            (size32, 8u64)
        };
        if box_size < hdr_len || pos + box_size > file_len {
            break;
        }
        if &box_type == b"uuid" && box_size >= hdr_len + 24 {
            let mut uuid = [0u8; 16];
            file.read_exact(&mut uuid).ok()?;
            if uuid == CANON_PRVW_UUID {
                let mut child_pos = pos + hdr_len + 24;
                let box_end = pos + box_size;
                for _ in 0..32 {
                    if child_pos + 8 > box_end {
                        break;
                    }
                    file.seek(SeekFrom::Start(child_pos)).ok()?;
                    let mut chdr = [0u8; 8];
                    file.read_exact(&mut chdr).ok()?;
                    let csize = u32::from_be_bytes([chdr[0], chdr[1], chdr[2], chdr[3]]) as u64;
                    if csize < 8 || child_pos + csize > box_end {
                        break;
                    }
                    if &chdr[4..8] == b"PRVW" && csize > 24 && csize <= 8 * 1024 * 1024 {
                        let mut payload = vec![0u8; (csize - 8) as usize];
                        file.read_exact(&mut payload).ok()?;
                        let search_lim = payload.len().min(64);
                        if let Some(soi) = payload[..search_lim].windows(2).position(|w| w == [0xff, 0xd8]) {
                            if let Some(end) = jpeg_stream_end(&payload, soi) {
                                return Some(payload[soi..end].to_vec());
                            }
                        }
                    }
                    child_pos += csize;
                }
            }
        }
        pos += box_size;
    }
    None
}

fn extract_tiff_raw_preview_fast(file: &mut File, file_len: u64, tiff_base: u64) -> Option<(Vec<u8>, u32)> {
    if tiff_base + 8 > file_len {
        return None;
    }
    file.seek(SeekFrom::Start(tiff_base)).ok()?;
    let mut header = [0u8; 8];
    file.read_exact(&mut header).ok()?;
    let little = match &header[..4] {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    let short = |b: [u8; 2]| if little { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) };
    let long = |b: [u8; 4]| if little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) };

    let ifd0_rel = long([header[4], header[5], header[6], header[7]]) as u64;
    let mut queue = vec![ifd0_rel];
    let mut visited = std::collections::HashSet::new();
    let mut candidates: Vec<(u64, usize)> = Vec::new();
    let mut ifd0_orientation = 1u32;

    while let Some(rel_ifd) = queue.pop() {
        if visited.len() >= 16 {
            break;
        }
        let Some(abs_ifd) = tiff_base.checked_add(rel_ifd) else {
            continue;
        };
        if rel_ifd == 0 || !visited.insert(abs_ifd) || abs_ifd + 2 > file_len {
            continue;
        }
        file.seek(SeekFrom::Start(abs_ifd)).ok()?;
        let mut count_buf = [0u8; 2];
        file.read_exact(&mut count_buf).ok()?;
        let count = short(count_buf) as usize;
        if count == 0 || count > 512 {
            continue;
        }
        let table_bytes = count * 12 + 4;
        if abs_ifd + 2 + table_bytes as u64 > file_len {
            continue;
        }
        let mut table = vec![0u8; table_bytes];
        file.read_exact(&mut table).ok()?;
        let next_ifd = long([
            table[count * 12],
            table[count * 12 + 1],
            table[count * 12 + 2],
            table[count * 12 + 3],
        ]) as u64;
        if next_ifd != 0 {
            queue.push(next_ifd);
        }

        let is_ifd0 = rel_ifd == ifd0_rel;
        let mut jpeg_off: Option<u64> = None;
        let mut jpeg_len: Option<usize> = None;
        let mut compression: Option<u32> = None;
        let mut strip_off: Option<u64> = None;
        let mut strip_len: Option<usize> = None;

        for e in table[..count * 12].chunks_exact(12) {
            let tag = short([e[0], e[1]]);
            let kind = short([e[2], e[3]]);
            let n = long([e[4], e[5], e[6], e[7]]) as usize;
            let val = long([e[8], e[9], e[10], e[11]]) as u64;
            match tag {
                0x0112 if is_ifd0 && n == 1 => {
                    let v = if kind == 3 { short([e[8], e[9]]) as u32 } else { val as u32 };
                    if (1..=8).contains(&v) {
                        ifd0_orientation = v;
                    }
                }
                0x014A => {
                    if (kind == 4 || kind == 13) && n == 1 {
                        queue.push(val);
                    } else if (kind == 4 || kind == 13) && n > 1 && n <= 16 {
                        if let Some(sub_abs) = tiff_base.checked_add(val) {
                            if sub_abs + (n * 4) as u64 <= file_len
                                && file.seek(SeekFrom::Start(sub_abs)).is_ok()
                            {
                                let mut sub_buf = vec![0u8; n * 4];
                                if file.read_exact(&mut sub_buf).is_ok() {
                                    for c in sub_buf.chunks_exact(4) {
                                        queue.push(long([c[0], c[1], c[2], c[3]]) as u64);
                                    }
                                }
                            }
                        }
                    }
                }
                0x0201 if n == 1 => jpeg_off = tiff_base.checked_add(val),
                0x0202 if n == 1 => jpeg_len = Some(val as usize),
                0x0103 if n == 1 => {
                    compression = Some(if kind == 3 {
                        short([e[8], e[9]]) as u32
                    } else {
                        val as u32
                    });
                }
                0x0111 if n == 1 => strip_off = tiff_base.checked_add(val),
                0x0117 if n == 1 => strip_len = Some(val as usize),
                0x002E if (2048..=16_000_000).contains(&n) => {
                    if let Some(abs) = tiff_base.checked_add(val) {
                        candidates.push((abs, n));
                    }
                }
                _ => {}
            }
        }
        if let (Some(o), Some(l)) = (jpeg_off, jpeg_len) {
            candidates.push((o, l));
        }
        if matches!(compression, Some(6 | 7)) {
            if let (Some(o), Some(l)) = (strip_off, strip_len) {
                candidates.push((o, l));
            }
        }
    }

    let valid: Vec<(u64, usize)> = candidates
        .into_iter()
        .filter(|&(o, l)| (2048..=16_000_000).contains(&l) && o.checked_add(l as u64).is_some_and(|e| e <= file_len))
        .collect();
    // Prefer the smallest preview >= 24 KB (avoids tiny 160x120 thumbs and multi-MB full-res previews).
    let chosen = valid
        .iter()
        .copied()
        .filter(|&(_, l)| l >= 24_000)
        .min_by_key(|&(_, l)| l)
        .or_else(|| valid.iter().copied().max_by_key(|&(_, l)| l))?;

    file.seek(SeekFrom::Start(chosen.0)).ok()?;
    let mut jpeg = vec![0u8; chosen.1];
    file.read_exact(&mut jpeg).ok()?;
    jpeg.starts_with(&[0xff, 0xd8]).then_some((jpeg, ifd0_orientation))
}

fn extract_fast_raw_thumbnail(source: &Path) -> Result<(Vec<u8>, Option<u32>), String> {
    let mut file = File::open(source).map_err(|e| e.to_string())?;
    let file_len = file.metadata().map_err(|e| e.to_string())?.len();
    let mut header = [0u8; 16];
    if file.read(&mut header).unwrap_or(0) >= 12 {
        if header.starts_with(b"FUJIFILMCCD-RAW") {
            if let Some(jpeg) = extract_raf_preview_fast(&mut file, file_len) {
                return Ok((jpeg, None));
            }
        } else if &header[4..8] == b"ftyp"
            || source
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("cr3"))
        {
            if let Some(jpeg) = extract_cr3_preview_fast(&mut file, file_len) {
                return Ok((jpeg, None));
            }
        } else if &header[..4] == b"II*\0" || &header[..4] == b"MM\0*" {
            if let Some((jpeg, ori)) = extract_tiff_raw_preview_fast(&mut file, file_len, 0) {
                return Ok((jpeg, Some(ori)));
            }
        }
    }
    extract_raw_preview(source).map(|jpeg| (jpeg, None))
}

fn clean_exif_date(raw: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(raw).ok()?;
    let cleaned = s.trim_matches(|c: char| c == '\0' || c.is_ascii_whitespace() || c == '"');
    if cleaned.len() >= 10 && !cleaned.starts_with("0000") {
        Some(cleaned.to_string())
    } else {
        None
    }
}

fn parse_tiff_slice_exif_fields(tiff: &[u8]) -> (String, u32) {
    if tiff.len() < 8 {
        return (String::new(), 1);
    }
    let little = match &tiff[..4] {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return (String::new(), 1),
    };
    let short = |b: [u8; 2]| if little { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) };
    let long = |b: [u8; 4]| if little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) };

    let read_ascii = |entry: &[u8]| -> Option<String> {
        let kind = short([entry[2], entry[3]]);
        let n = long([entry[4], entry[5], entry[6], entry[7]]) as usize;
        if kind != 2 || !(10..=64).contains(&n) {
            return None;
        }
        let off = long([entry[8], entry[9], entry[10], entry[11]]) as usize;
        let slice = tiff.get(off..off.checked_add(n)?)?;
        clean_exif_date(slice)
    };

    let ifd0_off = long([tiff[4], tiff[5], tiff[6], tiff[7]]) as usize;
    if ifd0_off + 2 > tiff.len() {
        return (String::new(), 1);
    }
    let count0 = (short([tiff[ifd0_off], tiff[ifd0_off + 1]]) as usize).min(512);
    let Some(entries0) = tiff.get(ifd0_off + 2..ifd0_off + 2 + count0 * 12) else {
        return (String::new(), 1);
    };

    let mut orientation = 1u32;
    let mut ifd0_date: Option<String> = None;
    let mut exif_ifd_off: Option<usize> = None;

    for e in entries0.chunks_exact(12) {
        let tag = short([e[0], e[1]]);
        let kind = short([e[2], e[3]]);
        let n = long([e[4], e[5], e[6], e[7]]) as usize;
        match tag {
            0x0112 if n == 1 => {
                let v = if kind == 3 { short([e[8], e[9]]) as u32 } else { long([e[8], e[9], e[10], e[11]]) };
                if (1..=8).contains(&v) {
                    orientation = v;
                }
            }
            0x0132 if ifd0_date.is_none() => ifd0_date = read_ascii(e),
            0x8769 if n == 1 => exif_ifd_off = Some(long([e[8], e[9], e[10], e[11]]) as usize),
            _ => {}
        }
    }

    let mut orig_date: Option<String> = None;
    let mut dig_date: Option<String> = None;
    if let Some(ex_off) = exif_ifd_off.filter(|&o| o + 2 <= tiff.len()) {
        let count_ex = (short([tiff[ex_off], tiff[ex_off + 1]]) as usize).min(512);
        if let Some(entries_ex) = tiff.get(ex_off + 2..ex_off + 2 + count_ex * 12) {
            for e in entries_ex.chunks_exact(12) {
                match short([e[0], e[1]]) {
                    0x9003 if orig_date.is_none() => orig_date = read_ascii(e),
                    0x9004 if dig_date.is_none() => dig_date = read_ascii(e),
                    _ => {}
                }
            }
        }
    }

    (orig_date.or(dig_date).or(ifd0_date).unwrap_or_default(), orientation)
}

fn parse_jpeg_slice_exif_fields(head: &[u8]) -> Option<(String, u32)> {
    if head.len() < 4 || head[0] != 0xff || head[1] != 0xd8 {
        return None;
    }
    let mut i = 2usize;
    while i + 3 < head.len() {
        while i < head.len() && head[i] != 0xff {
            i += 1;
        }
        while i < head.len() && head[i] == 0xff {
            i += 1;
        }
        if i >= head.len() {
            break;
        }
        let marker = head[i];
        i += 1;
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        if marker == 0x00 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if i + 2 > head.len() {
            break;
        }
        let seg_len = u16::from_be_bytes([head[i], head[i + 1]]) as usize;
        if seg_len < 2 || i + seg_len > head.len() {
            break;
        }
        if marker == 0xe1 && seg_len >= 16 && &head[i + 2..i + 8] == b"Exif\0\0" {
            return Some(parse_tiff_slice_exif_fields(&head[i + 8..i + seg_len]));
        }
        i += seg_len;
    }
    None
}

fn read_tiff_file_exif_fields(file: &mut File, file_len: u64, tiff_base: u64) -> (String, u32) {
    if tiff_base + 8 > file_len || file.seek(SeekFrom::Start(tiff_base)).is_err() {
        return (String::new(), 1);
    }
    let mut header = [0u8; 8];
    if file.read_exact(&mut header).is_err() {
        return (String::new(), 1);
    }
    let little = match &header[..4] {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return (String::new(), 1),
    };
    let short = |b: [u8; 2]| if little { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) };
    let long = |b: [u8; 4]| if little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) };

    fn read_ifd_entries(
        file: &mut File,
        file_len: u64,
        tiff_base: u64,
        rel_off: u64,
        little: bool,
    ) -> Option<Vec<u8>> {
        let short = |b: [u8; 2]| if little { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) };
        let abs = tiff_base.checked_add(rel_off)?;
        if abs + 2 > file_len {
            return None;
        }
        file.seek(SeekFrom::Start(abs)).ok()?;
        let mut cbuf = [0u8; 2];
        file.read_exact(&mut cbuf).ok()?;
        let count = (short(cbuf) as usize).min(512);
        if count == 0 || abs + 2 + (count * 12) as u64 > file_len {
            return None;
        }
        let mut buf = vec![0u8; count * 12];
        file.read_exact(&mut buf).ok()?;
        Some(buf)
    }

    fn read_ascii_at(
        file: &mut File,
        file_len: u64,
        tiff_base: u64,
        entry: &[u8],
        little: bool,
    ) -> Option<String> {
        let short = |b: [u8; 2]| if little { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) };
        let long = |b: [u8; 4]| if little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) };
        let kind = short([entry[2], entry[3]]);
        let n = long([entry[4], entry[5], entry[6], entry[7]]) as usize;
        if kind != 2 || !(10..=64).contains(&n) {
            return None;
        }
        let rel = long([entry[8], entry[9], entry[10], entry[11]]) as u64;
        let abs = tiff_base.checked_add(rel)?;
        if abs.checked_add(n as u64)? > file_len {
            return None;
        }
        file.seek(SeekFrom::Start(abs)).ok()?;
        let mut buf = vec![0u8; n];
        file.read_exact(&mut buf).ok()?;
        clean_exif_date(&buf)
    }

    let ifd0_rel = long([header[4], header[5], header[6], header[7]]) as u64;
    let Some(entries0) = read_ifd_entries(file, file_len, tiff_base, ifd0_rel, little) else {
        return (String::new(), 1);
    };

    let mut orientation = 1u32;
    let mut ifd0_date: Option<String> = None;
    let mut exif_ifd_rel: Option<u64> = None;

    for e in entries0.chunks_exact(12) {
        let tag = short([e[0], e[1]]);
        let kind = short([e[2], e[3]]);
        let n = long([e[4], e[5], e[6], e[7]]) as usize;
        match tag {
            0x0112 if n == 1 => {
                let v = if kind == 3 { short([e[8], e[9]]) as u32 } else { long([e[8], e[9], e[10], e[11]]) };
                if (1..=8).contains(&v) {
                    orientation = v;
                }
            }
            0x0132 if ifd0_date.is_none() => ifd0_date = read_ascii_at(file, file_len, tiff_base, e, little),
            0x8769 if n == 1 => exif_ifd_rel = Some(long([e[8], e[9], e[10], e[11]]) as u64),
            _ => {}
        }
    }

    let mut orig_date: Option<String> = None;
    let mut dig_date: Option<String> = None;
    if let Some(ex_rel) = exif_ifd_rel {
        if let Some(entries_ex) = read_ifd_entries(file, file_len, tiff_base, ex_rel, little) {
            for e in entries_ex.chunks_exact(12) {
                match short([e[0], e[1]]) {
                    0x9003 if orig_date.is_none() => orig_date = read_ascii_at(file, file_len, tiff_base, e, little),
                    0x9004 if dig_date.is_none() => dig_date = read_ascii_at(file, file_len, tiff_base, e, little),
                    _ => {}
                }
            }
        }
    }

    (orig_date.or(dig_date).or(ifd0_date).unwrap_or_default(), orientation)
}

fn read_cr3_moov_exif_fields(file: &mut File, file_len: u64) -> (String, u32) {
    let mut pos = 0u64;
    for _ in 0..64 {
        if pos + 8 > file_len || file.seek(SeekFrom::Start(pos)).is_err() {
            break;
        }
        let mut hdr = [0u8; 8];
        if file.read_exact(&mut hdr).is_err() {
            break;
        }
        let size32 = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as u64;
        let box_type = [hdr[4], hdr[5], hdr[6], hdr[7]];
        let (box_size, hdr_len) = if size32 == 1 {
            if pos + 16 > file_len {
                break;
            }
            let mut ext = [0u8; 8];
            if file.read_exact(&mut ext).is_err() {
                break;
            }
            (u64::from_be_bytes(ext), 16u64)
        } else if size32 == 0 {
            (file_len - pos, 8u64)
        } else {
            (size32, 8u64)
        };
        if box_size < hdr_len || pos + box_size > file_len {
            break;
        }
        if &box_type == b"moov" {
            let payload_len = (box_size - hdr_len).min(2 * 1024 * 1024) as usize;
            let mut buf = vec![0u8; payload_len];
            if file.read_exact(&mut buf).is_err() {
                return (String::new(), 1);
            }
            let cmt1 = cr3_box(&buf, b"CMT1").map(parse_tiff_slice_exif_fields);
            let cmt2 = cr3_box(&buf, b"CMT2").map(|b| parse_tiff_slice_exif_fields(&tiff_as_exif_ifd(b)));
            let date = cmt2
                .as_ref()
                .map(|(d, _)| d.as_str())
                .filter(|d| !d.is_empty())
                .or_else(|| cmt1.as_ref().map(|(d, _)| d.as_str()).filter(|d| !d.is_empty()))
                .unwrap_or("")
                .to_string();
            let orientation = cmt1.map(|(_, o)| o).unwrap_or(1);
            return (date, orientation);
        }
        pos += box_size;
    }
    (String::new(), 1)
}

/// Pure-seek lightweight EXIF reader (`date_taken`, `orientation`): reads only ~4-64 KB per file
/// instead of loading entire 40+ MB RAW files into memory.
pub(crate) fn read_fast_exif_fields(source: &Path) -> (String, u32) {
    let Ok(mut file) = File::open(source) else {
        return (String::new(), 1);
    };
    let Ok(meta) = file.metadata() else {
        return (String::new(), 1);
    };
    let file_len = meta.len();
    let mut header = [0u8; 16];
    let n = file.read(&mut header).unwrap_or(0);
    if n < 4 {
        return (String::new(), 1);
    }

    if header[0] == 0xff && header[1] == 0xd8 {
        if file.seek(SeekFrom::Start(0)).is_err() {
            return (String::new(), 1);
        }
        let mut head = Vec::with_capacity(65_536);
        let _ = file.take(65_536).read_to_end(&mut head);
        return parse_jpeg_slice_exif_fields(&head).unwrap_or_else(|| (String::new(), 1));
    }

    if n >= 16 && header.starts_with(b"FUJIFILMCCD-RAW") {
        if file.seek(SeekFrom::Start(0x54)).is_ok() {
            let mut buf = [0u8; 8];
            if file.read_exact(&mut buf).is_ok() {
                let offset = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as u64;
                if offset > 0 && offset < file_len && file.seek(SeekFrom::Start(offset)).is_ok() {
                    let mut head = Vec::with_capacity(65_536);
                    let _ = file.take(65_536).read_to_end(&mut head);
                    if let Some(res) = parse_jpeg_slice_exif_fields(&head) {
                        return res;
                    }
                }
            }
        }
        return (String::new(), 1);
    }

    if (n >= 8 && &header[4..8] == b"ftyp")
        || source
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("cr3"))
    {
        return read_cr3_moov_exif_fields(&mut file, file_len);
    }

    if &header[..4] == b"II*\0" || &header[..4] == b"MM\0*" {
        return read_tiff_file_exif_fields(&mut file, file_len, 0);
    }

    (String::new(), 1)
}

/// Extracts the embedded EXIF IFD1 thumbnail from the first 64 KB of a JPEG if its longest side >= `min_side`.
fn extract_jpeg_exif_thumbnail(source: &Path, min_side: usize) -> Option<(Vec<u8>, u32)> {
    let mut file = File::open(source).ok()?;
    let mut head = Vec::with_capacity(65_536);
    file.by_ref().take(65_536).read_to_end(&mut head).ok()?;
    if head.len() < 4 || head[0] != 0xff || head[1] != 0xd8 {
        return None;
    }
    let mut i = 2usize;
    let mut tiff_slice: Option<&[u8]> = None;
    while i + 3 < head.len() {
        while i < head.len() && head[i] != 0xff {
            i += 1;
        }
        while i < head.len() && head[i] == 0xff {
            i += 1;
        }
        if i >= head.len() {
            break;
        }
        let marker = head[i];
        i += 1;
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        if marker == 0x00 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if i + 2 > head.len() {
            break;
        }
        let seg_len = u16::from_be_bytes([head[i], head[i + 1]]) as usize;
        if seg_len < 2 || i + seg_len > head.len() {
            break;
        }
        if marker == 0xe1 && seg_len >= 16 && &head[i + 2..i + 8] == b"Exif\0\0" {
            tiff_slice = Some(&head[i + 8..i + seg_len]);
            break;
        }
        i += seg_len;
    }
    let tiff = tiff_slice?;
    if tiff.len() < 8 {
        return None;
    }
    let little = match &tiff[..4] {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    let short = |b: [u8; 2]| if little { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) };
    let long = |b: [u8; 4]| if little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) };

    let ifd0_off = long([tiff[4], tiff[5], tiff[6], tiff[7]]) as usize;
    if ifd0_off + 2 > tiff.len() {
        return None;
    }
    let count0 = short([tiff[ifd0_off], tiff[ifd0_off + 1]]) as usize;
    let ifd0_end = ifd0_off + 2 + count0 * 12;
    if ifd0_end + 4 > tiff.len() {
        return None;
    }
    let mut orientation = 1u32;
    for e in tiff[ifd0_off + 2..ifd0_end].chunks_exact(12) {
        if short([e[0], e[1]]) == 0x0112 {
            let v = short([e[8], e[9]]) as u32;
            if (1..=8).contains(&v) {
                orientation = v;
            }
        }
    }
    let ifd1_off = long([tiff[ifd0_end], tiff[ifd0_end + 1], tiff[ifd0_end + 2], tiff[ifd0_end + 3]]) as usize;
    if ifd1_off == 0 || ifd1_off + 2 > tiff.len() {
        return None;
    }
    let count1 = short([tiff[ifd1_off], tiff[ifd1_off + 1]]) as usize;
    let ifd1_end = ifd1_off + 2 + count1 * 12;
    if ifd1_end > tiff.len() {
        return None;
    }
    let mut thumb_off = None;
    let mut thumb_len = None;
    for e in tiff[ifd1_off + 2..ifd1_end].chunks_exact(12) {
        match short([e[0], e[1]]) {
            0x0201 => thumb_off = Some(long([e[8], e[9], e[10], e[11]]) as usize),
            0x0202 => thumb_len = Some(long([e[8], e[9], e[10], e[11]]) as usize),
            _ => {}
        }
    }
    let (off, len) = (thumb_off?, thumb_len?);
    if len < 512 || off.checked_add(len).is_none_or(|end| end > tiff.len()) {
        return None;
    }
    let thumb = &tiff[off..off + len];
    if !thumb.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let (w, h) = jpeg_sof_dimensions(thumb)?;
    if w.max(h) >= min_side {
        Some((thumb.to_vec(), orientation))
    } else {
        None
    }
}

/// Fast RAM-only JPEG thumbnail for the Import view: uses header-seek embedded JPEG extraction
/// and single-pass JPEG encoding, avoiding 12 MB RAW linear scans and disk cache writes.
pub(crate) fn render_fast_import_thumbnail_bytes(
    source: &Path,
    max_side: usize,
    quality: u8,
) -> Result<Vec<u8>, String> {
    if crate::video::is_video_path(source) {
        let (rgb, width, height) = decode_video_frame(source, max_side)?;
        let (rgb, width, height) = resize_to_fit(rgb, width, height, max_side);
        return encode_jpeg_bytes_fast(&rgb, width, height, quality);
    }
    if crate::heif::is_heif_path(source) {
        let decoded = crate::heif::decode(source)?;
        let (rgb, width, height) = resize_to_fit(decoded.rgb, decoded.width, decoded.height, max_side);
        let (rgb, width, height) = apply_orientation(rgb, width, height, read_orientation(source));
        return encode_jpeg_bytes_fast(&rgb, width, height, quality);
    }
    if is_raw_path(source) {
        let (jpeg, fast_container_ori) = extract_fast_raw_thumbnail(source)?;
        let own = parse_jpeg_slice_exif_fields(&jpeg).map(|(_, o)| o);
        let container = fast_container_ori.unwrap_or_else(|| read_fast_exif_fields(source).1);
        let dims = jpeg_sof_dimensions(&jpeg);
        let portrait_preview = dims.is_some_and(|(w, h)| h > w);
        let preview_ori = match own {
            Some(v) if v >= 2 => v,
            Some(_) if container >= 5 && !portrait_preview => container,
            Some(v) => v,
            None if container >= 5 && portrait_preview => 1,
            None => container,
        };
        let display_ori = crate::orientation::raw_preview_orientation(
            preview_ori,
            container,
            crate::exif::read_xmp_orientation(source),
        );
        if display_ori == 1
            && own.unwrap_or(1) == 1
            && jpeg.len() <= 180_000
            && dims.is_some_and(|(w, h)| w.max(h) <= max_side * 2)
        {
            return Ok(jpeg);
        }
        let (rgb, width, height) = decode_scaled_jpeg_reader(Cursor::new(jpeg), max_side)?;
        let (rgb, width, height) = resize_to_fit(rgb, width, height, max_side);
        let (rgb, width, height) = apply_orientation(rgb, width, height, display_ori);
        return encode_jpeg_bytes_fast(&rgb, width, height, quality);
    }
    let is_jpeg = source
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg"));
    if is_jpeg {
        if let Some((thumb, orientation)) = extract_jpeg_exif_thumbnail(source, max_side) {
            if orientation == 1 && thumb.len() <= 150_000 {
                return Ok(thumb);
            }
            if let Ok((rgb, width, height)) = decode_scaled_jpeg_reader(Cursor::new(&thumb), max_side) {
                let (rgb, width, height) = apply_orientation(rgb, width, height, orientation);
                return encode_jpeg_bytes_fast(&rgb, width, height, quality);
            }
        }
    }
    let (rgb, width, height) = render_thumbnail(source, max_side)?;
    encode_jpeg_bytes_fast(&rgb, width, height, quality)
}

/// Renders a RAM-only JPEG thumbnail for `source` without touching any disk cache.
pub(crate) fn render_thumbnail_jpeg_bytes(source: &Path, max_side: usize, quality: u8) -> Result<Vec<u8>, String> {
    let (rgb, width, height) = render_thumbnail(source, max_side)?;
    encode_jpeg_bytes(&rgb, width, height, quality)
}

/// Renders a RAM-only JPEG preview (up to 1600 px) for `source` without touching any disk cache.
pub(crate) fn render_preview_jpeg_bytes(source: &Path) -> Result<Vec<u8>, String> {
    const PREVIEW_MAX_SIDE: usize = 1600;
    if crate::video::is_video_path(source) {
        let (rgb, width, height) = decode_video_frame(source, PREVIEW_MAX_SIDE)?;
        let (rgb, width, height) = resize_to_fit(rgb, width, height, PREVIEW_MAX_SIDE);
        return encode_jpeg_bytes(&rgb, width, height, THUMBNAIL_QUALITY_HIGH);
    }
    if crate::heif::is_heif_path(source) {
        return crate::heif::preview_jpeg(source);
    }
    if is_raw_path(source) {
        let jpeg = extract_raw_preview(source)?;
        return Ok(preview_with_orientation(source, jpeg));
    }
    render_thumbnail_jpeg_bytes(source, PREVIEW_MAX_SIDE, THUMBNAIL_QUALITY_HIGH)
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
