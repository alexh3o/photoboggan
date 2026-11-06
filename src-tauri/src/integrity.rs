//! Vérification d'intégrité d'un dossier (commande `integrity_scan`), couplée à la génération des miniatures manquantes.
//!
//! Pour chaque fichier :
//! 1. Intégrité (toujours) : le fichier est décodé. JPEG, HEIC / HEIF : décodeurs de `thumbnails.rs` (le JPEG est décodé à échelle réduite, ce qui lit
//!    tout le flux compressé sans produire l'image pleine résolution) ; PNG (crate `png`, avec contrôle des CRC et de la fin du fichier) et WebP (crate
//!    `image-webp`) ; RAW : seule la vignette JPEG intégrée est extraite puis décodée, jamais de dématriçage. Un échec = fichier suspect.
//!    Un JPEG est de plus contrôlé sur ses marqueurs (`check_jpeg_structure`) : un JPEG progressif dont des scans manquent est suspect, même si le décodeur l'accepte.
//! 2. Miniature (seulement si absente) : générée à partir de l'image déjà décodée et écrite dans le cache. Si elle existe, rien n'est écrit sur le disque
//!    et les pixels PNG / WebP ne sont même pas convertis (le décodage seul suffit à vérifier le fichier).
//!
//! Non vérifiés (comptés à part, jamais signalés comme corrompus) : vidéos (leur image fixe dépend du système ou de ffmpeg) et GIF, BMP, AVIF (pas de décodeur).
//! Un décodeur qui panique sur un fichier malformé est traité comme un échec de décodage.
//!
//! Un fichier qui ne répond pas (lecture bloquée, partage réseau coupé) est abandonné après FILE_TIMEOUT et signalé suspect ; l'arrêt demandé par
//! l'utilisateur est aussi observé pendant l'analyse d'un fichier. Les images PNG / WebP aux dimensions déraisonnables sont refusées avant toute allocation.
//!
//! Performances : nombre de threads proportionnel aux cœurs (moitié des cœurs, entre 2 et 6, pour laisser de la place à l'interface). Les formats lourds
//! en mémoire et en temps (PNG, WebP, HEIC : décodage en pleine résolution) sont limités à 2 décodages simultanés, pour ne pas saturer la mémoire.
//! Le rapport donne la durée totale, les extensions vérifiées / non vérifiées et la durée moyenne par fichier pour chaque extension ; il s'exporte en .txt.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::{library_sync, thumbnails, video};

/// Nombre maximal de décodages simultanés pour les formats lourds (PNG, WebP, HEIC).
const HEAVY_DECODES: usize = 2;
/// Durée maximale de l'analyse d'un fichier.
const FILE_TIMEOUT: Duration = Duration::from_secs(120);

/// Un fichier suspect du rapport.
#[derive(Serialize, Deserialize, Clone)]
pub struct IntegrityIssue {
    pub path: String,
    pub error: String,
}

/// Fichiers analysés pour une extension, avec la durée moyenne d'analyse d'un fichier (en millisecondes).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStat {
    pub extension: String,
    pub files: usize,
    pub average_millis: f64,
}

/// Fichiers non vérifiés (pas de décodeur) pour une extension.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCount {
    pub extension: String,
    pub files: usize,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub folder: String,
    /// Date et heure de fin de l'analyse (heure locale, « AAAA-MM-JJ HH:MM:SS »).
    pub generated_at: String,
    /// Fichiers trouvés dans le dossier.
    pub total: usize,
    /// Fichiers réellement analysés (moins que `total` si la tâche a été arrêtée).
    pub checked: usize,
    pub healthy: usize,
    pub thumbnails_created: usize,
    /// Fichiers sains dont la miniature manquante n'a pas pu être écrite (disque plein, droits…).
    pub thumbnails_failed: usize,
    /// Fichiers sans décodeur (vidéos, GIF, BMP, AVIF) : non vérifiés.
    pub unsupported: usize,
    pub suspects: Vec<IntegrityIssue>,
    pub cancelled: bool,
    /// Durée totale du parcours et de l'analyse.
    pub elapsed_millis: u64,
    /// Extensions vérifiées (rencontrées dans le dossier), avec le nombre de fichiers et la durée moyenne par fichier.
    pub timings: Vec<ExtensionStat>,
    /// Extensions non vérifiées (rencontrées dans le dossier).
    pub unsupported_extensions: Vec<ExtensionCount>,
}

enum Thumbnail {
    Existing,
    Created,
    Failed,
}

enum Outcome {
    Healthy(Thumbnail),
    Unsupported,
}

enum Format {
    Png,
    WebP,
    Heif,
    Other,
}

/// Limite le nombre de décodages lourds simultanés (sémaphore).
struct Gate {
    available: Mutex<usize>,
    released: Condvar,
}

/// Créneau de décodage lourd d'un fichier : rendu une seule fois, soit par le décodage qui se termine, soit par l'analyse si elle abandonne le fichier
/// après le délai (sans cela, un fichier bloqué garderait son créneau pour toujours et finirait par bloquer tous les décodages lourds).
#[derive(Default)]
struct SlotToken {
    held: AtomicBool,
    returned: AtomicBool,
}

struct GateGuard {
    gate: Arc<Gate>,
    token: Arc<SlotToken>,
}

impl Gate {
    fn new(slots: usize) -> Self {
        Gate { available: Mutex::new(slots), released: Condvar::new() }
    }

    fn enter(gate: &Arc<Gate>, token: &Arc<SlotToken>) -> GateGuard {
        {
            let mut available = gate.available.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            while *available == 0 {
                available = gate.released.wait(available).unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            *available -= 1;
        }
        token.held.store(true, Ordering::SeqCst);
        GateGuard { gate: gate.clone(), token: token.clone() }
    }

    fn release(&self) {
        *self.available.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) += 1;
        self.released.notify_one();
    }

    /// Rend le créneau d'un fichier abandonné (sans effet s'il n'en tenait pas ou s'il l'a déjà rendu).
    fn give_back(&self, token: &SlotToken) {
        if token.held.load(Ordering::SeqCst) && !token.returned.swap(true, Ordering::SeqCst) { self.release(); }
    }
}

impl Drop for GateGuard {
    fn drop(&mut self) {
        if !self.token.returned.swap(true, Ordering::SeqCst) { self.gate.release(); }
    }
}

/// Exécute `work` dans un fil dédié. None si le délai est dépassé ou si l'arrêt est demandé : le fil, resté bloqué, est alors abandonné.
fn run_bounded<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static, timeout: Duration, cancel: &AtomicBool) -> Option<T> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || { let _ = sender.send(work()); });
    let started = Instant::now();
    loop {
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(value) => return Some(value),
            Err(RecvTimeoutError::Timeout) => {
                if started.elapsed() > timeout || cancel.load(Ordering::Relaxed) { return None; }
            }
            Err(RecvTimeoutError::Disconnected) => return None,
        }
    }
}

/// Extension en minuscules, sans le point (« sans extension » si absente), pour les statistiques du rapport.
fn extension_of(source: &Path) -> String {
    source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "sans extension".to_string())
}

/// Marques (« major brand » de la boîte `ftyp`) des fichiers HEIC / HEIF.
const HEIF_BRANDS: [&[u8; 4]; 10] = [b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1"];

/// Format reconnu d'après le contenu du fichier (une extension trompeuse ne fait pas échouer un fichier sain).
fn sniff(source: &Path) -> Format {
    let mut header = [0u8; 12];
    let read = File::open(source).and_then(|mut file| file.read(&mut header)).unwrap_or(0);
    if read >= 8 && header.starts_with(&[0x89, b'P', b'N', b'G']) {
        Format::Png
    } else if read >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP" {
        Format::WebP
    } else if read >= 12 && &header[4..8] == b"ftyp" && HEIF_BRANDS.iter().any(|brand| &header[8..12] == &brand[..]) {
        Format::Heif
    } else {
        Format::Other
    }
}

/// Aplatit un pixel transparent sur fond blanc (le JPEG de la miniature n'a pas de transparence).
fn flatten(color: [u8; 3], alpha: u8) -> [u8; 3] {
    let blend = |channel: u8| ((channel as u32 * alpha as u32 + 255 * (255 - alpha as u32) + 127) / 255) as u8;
    [blend(color[0]), blend(color[1]), blend(color[2])]
}

/// Décode un PNG. `want_pixels` faux : le fichier est entièrement décodé et contrôlé, mais les pixels ne sont pas convertis en RGB (vecteur vide renvoyé).
/// La transparence est aplatie sur fond blanc (le JPEG de la miniature n'en a pas).
pub(crate) fn decode_png(source: &Path, want_pixels: bool) -> Result<(Vec<u8>, usize, usize), String> {
    let file = File::open(source).map_err(|error| format!("Cannot read file: {error}"))?;
    let png = thumbnails::decode_png(BufReader::with_capacity(256 * 1024, file), want_pixels, true)?;
    if !want_pixels { return Ok((Vec::new(), png.width, png.height)); }
    let rgb = match png.alpha {
        Some(alpha) => png.rgb.chunks_exact(3).zip(&alpha).flat_map(|(pixel, &a)| flatten([pixel[0], pixel[1], pixel[2]], a)).collect(),
        None => png.rgb,
    };
    Ok((rgb, png.width, png.height))
}

/// Décode un WebP (première image s'il est animé). `want_pixels` faux : décodage complet, mais pas de conversion en RGB (vecteur vide renvoyé).
pub(crate) fn decode_webp(source: &Path, want_pixels: bool) -> Result<(Vec<u8>, usize, usize), String> {
    let file = File::open(source).map_err(|error| format!("Cannot read file: {error}"))?;
    let mut decoder = image_webp::WebPDecoder::new(BufReader::with_capacity(256 * 1024, file)).map_err(|error| format!("Unreadable WebP: {error}"))?;
    let (width, height) = decoder.dimensions();
    thumbnails::check_pixel_count(width, height)?;
    let (width, height) = (width as usize, height as usize);
    let has_alpha = decoder.has_alpha();
    let mut buffer = vec![0u8; decoder.output_buffer_size().ok_or("WebP too large")?];
    decoder.read_image(&mut buffer).map_err(|error| format!("WebP decoding failed: {error}"))?;
    let channels = if has_alpha { 4 } else { 3 };
    if width == 0 || height == 0 || buffer.len() != width * height * channels { return Err("Inconsistent WebP dimensions".into()); }
    if !want_pixels { return Ok((Vec::new(), width, height)); }
    let rgb: Vec<u8> = if has_alpha {
        buffer.chunks_exact(4).flat_map(|pixel| flatten([pixel[0], pixel[1], pixel[2]], pixel[3])).collect()
    } else {
        buffer
    };
    Ok((rgb, width, height))
}

/// Structural check of a JPEG, from its markers only (no entropy decoding, well under a millisecond per file).
/// `jpeg-decoder` accepts a file whose scans were cut out or overwritten: it feeds zeros past a marker and skips leftover bytes silently.
/// Flags only what is certainly incomplete:
/// - progressive: every coefficient of every component (DC, then AC 1..63) must be refined down to bit 0, with each refinement
///   scan following the previous precision (`Ah` = previous `Al`), as every common encoder produces;
/// - sequential: every component must be covered by a scan.
/// Anything unusual (unsupported coding, truncated header, no frame) is left to the decoder, which reports it more precisely.
pub(crate) fn check_jpeg_structure(data: &[u8]) -> Result<(), String> {
    if data.len() < 4 || data[..2] != [0xff, 0xd8] { return Ok(()); }
    let mut position = 2;
    let mut progressive = false;
    let mut component_ids: Vec<u8> = Vec::new();
    // Per component, per coefficient (0 = DC): the lowest bit position transmitted so far.
    let mut precision: Vec<[Option<u8>; 64]> = Vec::new();
    let mut covered: Vec<bool> = Vec::new();
    let mut scans = 0usize;
    loop {
        // Entropy-coded data is crossed byte by byte: stuffed FF00 and restart markers are no-ops below.
        let Some(offset) = data[position..].iter().position(|&byte| byte == 0xff) else { break };
        position += offset;
        while position < data.len() && data[position] == 0xff { position += 1; }
        if position >= data.len() { break; }
        let marker = data[position];
        position += 1;
        match marker {
            0x00 | 0x01 | 0xd0..=0xd8 => continue,
            0xd9 => break,
            _ => {}
        }
        if position + 2 > data.len() { return Ok(()); }
        let length = u16::from_be_bytes([data[position], data[position + 1]]) as usize;
        if length < 2 || position + length > data.len() { return Ok(()); }
        let segment = &data[position + 2..position + length];
        position += length;
        match marker {
            0xc0..=0xc2 if component_ids.is_empty() => {
                let count = *segment.get(5).unwrap_or(&0) as usize;
                if count == 0 || segment.len() < 6 + count * 3 { return Ok(()); }
                progressive = marker == 0xc2;
                component_ids = (0..count).map(|index| segment[6 + index * 3]).collect();
                precision = vec![[None; 64]; count];
                covered = vec![false; count];
            }
            // Arithmetic, lossless, hierarchical: not decoded by jpeg-decoder anyway.
            0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf => return Ok(()),
            0xda if !component_ids.is_empty() => {
                let count = *segment.first().unwrap_or(&0) as usize;
                if count == 0 || segment.len() < 4 + count * 2 { return Ok(()); }
                let (first, last, approximation) = (segment[1 + count * 2] as usize, segment[2 + count * 2] as usize, segment[3 + count * 2]);
                let (high, low) = (approximation >> 4, approximation & 15);
                scans += 1;
                for index in 0..count {
                    let Some(component) = component_ids.iter().position(|&id| id == segment[1 + index * 2]) else { return Ok(()) };
                    covered[component] = true;
                    if !progressive { continue; }
                    for coefficient in first..=last.min(63) {
                        let state = &mut precision[component][coefficient];
                        if high != 0 && *state != Some(high) {
                            return Err(format!("Inconsistent progressive JPEG: refinement scan {scans} has no matching previous scan (damaged file)"));
                        }
                        *state = Some(low);
                    }
                }
            }
            _ => {}
        }
    }
    if component_ids.is_empty() || scans == 0 { return Ok(()); }
    let complete = if progressive { precision.iter().all(|states| states.iter().all(|&state| state == Some(0))) } else { covered.iter().all(|&done| done) };
    if complete { return Ok(()); }
    Err(format!("Incomplete JPEG: only {scans} scan(s) found, image data is missing (truncated or damaged file)"))
}

/// Analyse un fichier. `Err` = fichier suspect (message affiché dans le rapport).
fn check_file(source: &Path, thumbnails_dir: &Path, max_side: usize, heavy: &Arc<Gate>, token: &Arc<SlotToken>) -> Result<Outcome, String> {
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if video::is_video_path(source) || matches!(extension.as_str(), "gif" | "bmp" | "avif") {
        return Ok(Outcome::Unsupported);
    }
    // Même nom de cache que l'interface (chemin, taille et date du fichier). Un fichier dont les métadonnées sont illisibles est suspect.
    let destination = crate::thumbnail_cache_file(thumbnails_dir, &source.to_string_lossy()).map_err(|error| format!("Unreadable file: {error}"))?;
    let thumbnail_missing = !destination.is_file();

    let format = sniff(source);
    let (rgb, width, height) = match format {
        Format::Png => {
            let _slot = Gate::enter(heavy, token);
            decode_png(source, thumbnail_missing)?
        }
        Format::WebP => {
            let _slot = Gate::enter(heavy, token);
            decode_webp(source, thumbnail_missing)?
        }
        // HEIC / HEIF reconnu d'après son contenu (même avec une extension .jpg ou .png) : décodage complet (lourd).
        Format::Heif => {
            let _slot = Gate::enter(heavy, token);
            let decoded = crate::heif::decode(source)?;
            (decoded.rgb, decoded.width, decoded.height)
        }
        Format::Other => {
            // Une extension PNG / WebP sans la bonne signature n'est acceptée que si c'est en réalité un JPEG.
            if matches!(extension.as_str(), "png" | "webp") {
                let mut magic = [0u8; 2];
                let is_jpeg = File::open(source).and_then(|mut file| file.read_exact(&mut magic)).is_ok() && magic == [0xff, 0xd8];
                if !is_jpeg { return Err(format!("Invalid {} signature or truncated file", extension.to_uppercase())); }
            }
            // HEIC / HEIF : décodage complet (lourd) ; JPEG et RAW (vignette JPEG intégrée) : décodage à échelle réduite.
            let _slot = crate::heif::is_heif_path(source).then(|| Gate::enter(heavy, token));
            if thumbnails::is_raw_path(source) || crate::heif::is_heif_path(source) {
                thumbnails::decode_scaled_rgb(source, max_side)?
            } else {
                // Plain JPEG: the file is read once, decoded, then its marker structure is checked (the decoder alone
                // silently accepts a progressive file whose later scans are missing). A decoding error is more precise, so it comes first.
                let bytes = fs::read(source).map_err(|error| format!("Cannot read file: {error}"))?;
                let decoded = thumbnails::decode_scaled_jpeg_reader(std::io::Cursor::new(&bytes), max_side)?;
                check_jpeg_structure(&bytes)?;
                decoded
            }
        }
    };
    if !thumbnail_missing { return Ok(Outcome::Healthy(Thumbnail::Existing)); }

    // Le fichier est sain : la miniature manquante est produite à partir de l'image déjà décodée. Un échec d'écriture n'est pas une corruption.
    let (rgb, width, height) = thumbnails::resize_to_fit(rgb, width, height, max_side);
    let orientation = if matches!(format, Format::Heif) || crate::heif::is_heif_path(source) { 1 } else { thumbnails::read_orientation(source) };
    let (rgb, width, height) = thumbnails::apply_orientation(rgb, width, height, orientation);
    Ok(Outcome::Healthy(match thumbnails::write_jpeg(&destination, &rgb, width, height) {
        Ok(()) => Thumbnail::Created,
        Err(error) => {
            eprintln!("Thumbnail not written for {}: {error}", source.display());
            Thumbnail::Failed
        }
    }))
}

/// Parcourt le dossier (sous-dossiers compris) et renvoie le rapport. `progress` reçoit l'avancement de 0 à 1 (environ tous les 1 %) ;
/// `on_folder` reçoit le dossier en cours d'analyse (chemin relatif commençant par le nom du dossier vérifié) à chaque changement de dossier ;
/// `cancel` arrête l'analyse : le rapport couvre alors les fichiers déjà traités.
pub fn run(
    folder: &Path,
    thumbnails_dir: &Path,
    max_side: usize,
    cancel: &AtomicBool,
    progress: &(dyn Fn(f64) + Sync),
    on_folder: &(dyn Fn(&str) + Sync),
) -> Result<IntegrityReport, String> {
    let started = Instant::now();
    let entries: Vec<PathBuf> = WalkDir::new(folder)
        .into_iter()
        .take_while(|_| !cancel.load(Ordering::Relaxed))
        .filter_map(|entry| entry.ok())
        .filter(|entry| !entry.file_type().is_dir() && library_sync::is_photo_file(entry.path()))
        .map(|entry| entry.into_path())
        .collect();

    let total = entries.len();
    let step = (total / 100).max(1);
    let finished = AtomicUsize::new(0);
    let checked = AtomicUsize::new(0);
    let healthy = AtomicUsize::new(0);
    let created = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    let unsupported = AtomicUsize::new(0);
    let suspects: Mutex<Vec<IntegrityIssue>> = Mutex::new(Vec::new());
    // Extension -> (fichiers analysés, durée cumulée en microsecondes) ; extension -> fichiers non vérifiés.
    let timings_by_extension: Mutex<HashMap<String, (usize, u64)>> = Mutex::new(HashMap::new());
    let unsupported_by_extension: Mutex<HashMap<String, usize>> = Mutex::new(HashMap::new());
    let heavy = Arc::new(Gate::new(HEAVY_DECODES));

    // Dossier en cours : annoncé seulement quand il change (les fichiers sont parcourus dossier par dossier).
    let root_name = folder.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| folder.to_string_lossy().into_owned());
    let last_folder: Mutex<Option<PathBuf>> = Mutex::new(None);
    let announce_folder = |path: &Path| {
        let Some(directory) = path.parent() else { return };
        {
            let mut last = last_folder.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if last.as_deref() == Some(directory) { return; }
            *last = Some(directory.to_path_buf());
        }
        let relative = directory
            .strip_prefix(folder)
            .map(|rest| rest.components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
            .unwrap_or_default();
        on_folder(&if relative.is_empty() { root_name.clone() } else { format!("{root_name}/{relative}") });
    };

    if entries.is_empty() { progress(1.0); }

    let cores = std::thread::available_parallelism().map(|count| count.get()).unwrap_or(4);
    let threads = rayon::ThreadPoolBuilder::new().num_threads((cores / 2).clamp(2, 6)).build().map_err(|error| error.to_string())?;
    threads.install(|| {
        entries.par_iter().for_each(|path| {
            if cancel.load(Ordering::Relaxed) { return; }
            announce_folder(path);
            let file_started = Instant::now();
            // Analyse dans un fil dédié : un fichier qui ne répond plus est abandonné après FILE_TIMEOUT (et l'arrêt demandé est vu sans attendre).
            let token = Arc::new(SlotToken::default());
            let work = {
                let (path, thumbnails_dir, heavy, token) = (path.clone(), thumbnails_dir.to_path_buf(), heavy.clone(), token.clone());
                move || {
                    panic::catch_unwind(AssertUnwindSafe(|| check_file(&path, &thumbnails_dir, max_side, &heavy, &token)))
                        .unwrap_or_else(|_| Err("Decoder aborted: file probably corrupt".to_string()))
                }
            };
            let result = match run_bounded(work, FILE_TIMEOUT, cancel) {
                Some(result) => result,
                None => {
                    heavy.give_back(&token);
                    if cancel.load(Ordering::Relaxed) { return; }
                    Err(format!("Timed out ({} s): read or decoding stuck", FILE_TIMEOUT.as_secs()))
                }
            };
            let micros = file_started.elapsed().as_micros() as u64;
            let extension = extension_of(path);
            match result {
                Ok(Outcome::Unsupported) => {
                    unsupported.fetch_add(1, Ordering::Relaxed);
                    *unsupported_by_extension.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).entry(extension).or_insert(0) += 1;
                }
                Ok(Outcome::Healthy(thumbnail)) => {
                    checked.fetch_add(1, Ordering::Relaxed);
                    healthy.fetch_add(1, Ordering::Relaxed);
                    match thumbnail {
                        Thumbnail::Created => { created.fetch_add(1, Ordering::Relaxed); }
                        Thumbnail::Failed => { failed.fetch_add(1, Ordering::Relaxed); }
                        Thumbnail::Existing => {}
                    }
                    let mut timings = timings_by_extension.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    let entry = timings.entry(extension).or_insert((0, 0));
                    entry.0 += 1;
                    entry.1 += micros;
                }
                Err(error) => {
                    checked.fetch_add(1, Ordering::Relaxed);
                    suspects.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(IntegrityIssue { path: path.to_string_lossy().into_owned(), error });
                    let mut timings = timings_by_extension.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    let entry = timings.entry(extension).or_insert((0, 0));
                    entry.0 += 1;
                    entry.1 += micros;
                }
            }
            // Valeur approximative : l'ordre d'arrivée entre threads n'est pas garanti.
            let done = finished.fetch_add(1, Ordering::Relaxed) + 1;
            if done % step == 0 || done == total { progress(done as f64 / total.max(1) as f64); }
        });
    });

    let mut suspects = suspects.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner());
    suspects.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    let mut timings: Vec<ExtensionStat> = timings_by_extension
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .into_iter()
        .map(|(extension, (files, micros))| ExtensionStat { extension, files, average_millis: micros as f64 / files as f64 / 1000.0 })
        .collect();
    timings.sort_by(|a, b| a.extension.cmp(&b.extension));
    let mut unsupported_extensions: Vec<ExtensionCount> = unsupported_by_extension
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .into_iter()
        .map(|(extension, files)| ExtensionCount { extension, files })
        .collect();
    unsupported_extensions.sort_by(|a, b| a.extension.cmp(&b.extension));
    Ok(IntegrityReport {
        folder: folder.to_string_lossy().into_owned(),
        generated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        total,
        checked: checked.load(Ordering::Relaxed),
        healthy: healthy.load(Ordering::Relaxed),
        thumbnails_created: created.load(Ordering::Relaxed),
        thumbnails_failed: failed.load(Ordering::Relaxed),
        unsupported: unsupported.load(Ordering::Relaxed),
        suspects,
        cancelled: cancel.load(Ordering::Relaxed),
        elapsed_millis: started.elapsed().as_millis() as u64,
        timings,
        unsupported_extensions,
    })
}

/// Champ CSV entre guillemets. Une valeur qui commence par = + - @ est précédée d'une apostrophe : sinon Excel la prendrait pour une formule.
fn csv_field(value: &str) -> String {
    let escaped = value.replace('"', "\"\"");
    if value.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("\"'{escaped}\"") } else { format!("\"{escaped}\"") }
}

/// Écrit le rapport dans `directory` (« photoboggan-integrity-AAAAMMJJ-HHMMSS.txt », jamais d'écrasement) et renvoie le chemin du fichier.
/// Première partie : `preamble`, texte déjà mis en forme et traduit par l'interface (titre, version, date, dossier, extensions, chiffres, durées).
/// Seconde partie, seulement s'il y a des fichiers suspects : leur liste au format CSV (séparateur « ; », champs entre guillemets), précédée de la ligne d'en-têtes.
/// `headers` : titres des 4 colonnes (nom du fichier, dossier, chemin complet, problème). Fins de ligne Windows et BOM UTF-8 : le fichier
/// s'ouvre correctement dans le Bloc-notes, et la partie CSV se copie telle quelle dans Excel.
pub fn write_report(directory: &Path, preamble: &str, headers: &[String], rows: &[IntegrityIssue]) -> Result<PathBuf, String> {
    if !directory.is_dir() { return Err(format!("Destination folder not found: {}", directory.display())); }
    if !rows.is_empty() && headers.len() != 4 { return Err("Invalid column headers".into()); }
    let mut content = String::from("\u{feff}");
    content.push_str(&preamble.trim_end().replace("\r\n", "\n").replace('\n', "\r\n"));
    content.push_str("\r\n");
    if !rows.is_empty() {
        content.push_str(&headers.iter().map(|header| csv_field(header)).collect::<Vec<_>>().join(";"));
        content.push_str("\r\n");
        for row in rows {
            let path = Path::new(&row.path);
            let name = path.file_name().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default();
            let parent = path.parent().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default();
            content.push_str(&[csv_field(&name), csv_field(&parent), csv_field(&row.path), csv_field(&row.error)].join(";"));
            content.push_str("\r\n");
        }
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    for attempt in 0u32.. {
        let name = if attempt == 0 { format!("photoboggan-integrity-{stamp}.txt") } else { format!("photoboggan-integrity-{stamp} ({attempt}).txt") };
        let target = directory.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(content.as_bytes()) {
                    drop(file);
                    let _ = fs::remove_file(&target);
                    return Err(format!("Cannot write file: {error}"));
                }
                return Ok(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Cannot create file: {error}")),
        }
    }
    Err("Cannot create file".into())
}

#[cfg(test)]
#[path = "tests/integrity.rs"]
mod tests;
