//! Vérification d'intégrité d'un dossier (commande `integrity_scan`), couplée à la génération des miniatures manquantes.
//!
//! Pour chaque fichier :
//! 1. Intégrité (toujours) : le fichier est décodé. JPEG, HEIC / HEIF : décodeurs de `thumbnails.rs` (le JPEG est décodé à échelle réduite, ce qui lit
//!    tout le flux compressé sans produire l'image pleine résolution) ; PNG (crate `png`, avec contrôle des CRC et de la fin du fichier) et WebP (crate
//!    `image-webp`) ; RAW : seule la vignette JPEG intégrée est extraite puis décodée, jamais de dématriçage. Un échec = fichier suspect.
//! 2. Miniature (seulement si absente) : générée à partir de l'image déjà décodée et écrite dans le cache. Si elle existe, rien n'est écrit sur le disque
//!    et les pixels PNG / WebP ne sont même pas convertis (le décodage seul suffit à vérifier le fichier).
//!
//! Non vérifiés (comptés à part, jamais signalés comme corrompus) : vidéos (leur image fixe dépend du système ou de ffmpeg) et GIF, BMP, AVIF (pas de décodeur).
//! Un décodeur qui panique sur un fichier malformé est traité comme un échec de décodage.
//!
//! Performances : nombre de threads proportionnel aux cœurs (moitié des cœurs, entre 2 et 6, pour laisser de la place à l'interface). Les formats lourds
//! en mémoire et en temps (PNG, WebP, HEIC : décodage en pleine résolution) sont limités à 2 décodages simultanés, pour ne pas saturer la mémoire.
//! Le rapport donne la durée totale et la durée moyenne par format, pour repérer ce qui ralentit.

use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Instant;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::{library_sync, thumbnails, video};

/// Nombre maximal de décodages simultanés pour les formats lourds (PNG, WebP, HEIC).
const HEAVY_DECODES: usize = 2;

/// Un fichier suspect du rapport.
#[derive(Serialize, Deserialize, Clone)]
pub struct IntegrityIssue {
    pub path: String,
    pub error: String,
}

/// Durée moyenne d'analyse d'un fichier pour un format.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatTiming {
    pub format: String,
    pub files: usize,
    pub average_millis: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub folder: String,
    /// Fichiers trouvés dans le dossier.
    pub total: usize,
    /// Fichiers réellement analysés (moins que `total` si la tâche a été arrêtée).
    pub checked: usize,
    pub healthy: usize,
    pub thumbnails_created: usize,
    /// Fichiers sains dont la miniature manquante n'a pas pu être écrite (disque plein, droits…).
    pub thumbnails_failed: usize,
    /// Formats sans décodeur (vidéos, GIF, BMP, AVIF) : non vérifiés.
    pub unsupported: usize,
    pub suspects: Vec<IntegrityIssue>,
    pub cancelled: bool,
    /// Durée totale du parcours et de l'analyse.
    pub elapsed_millis: u64,
    /// Durée moyenne par fichier et par format, du plus lent au plus rapide.
    pub timings: Vec<FormatTiming>,
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
    Other,
}

/// Limite le nombre de décodages lourds simultanés (sémaphore).
struct Gate {
    available: Mutex<usize>,
    released: Condvar,
}

struct GateGuard<'a>(&'a Gate);

impl Gate {
    fn new(slots: usize) -> Self {
        Gate { available: Mutex::new(slots), released: Condvar::new() }
    }

    fn enter(&self) -> GateGuard<'_> {
        let mut available = self.available.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while *available == 0 {
            available = self.released.wait(available).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *available -= 1;
        GateGuard(self)
    }
}

impl Drop for GateGuard<'_> {
    fn drop(&mut self) {
        *self.0.available.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) += 1;
        self.0.released.notify_one();
    }
}

const FORMAT_LABELS: [&str; 6] = ["JPEG", "PNG", "WebP", "HEIC", "RAW", "Other"];

/// Famille d'un fichier pour les statistiques de durée (d'après l'extension).
fn format_index(source: &Path) -> usize {
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" | "jfif" => 0,
        "png" => 1,
        "webp" => 2,
        "heic" | "heif" | "hif" => 3,
        "arw" | "cr2" | "cr3" | "nef" | "nrw" | "dng" | "raf" | "orf" | "rw2" | "raw" => 4,
        _ => 5,
    }
}

/// Format reconnu d'après le contenu du fichier (une extension trompeuse ne fait pas échouer un fichier sain).
fn sniff(source: &Path) -> Format {
    let mut header = [0u8; 12];
    let read = File::open(source).and_then(|mut file| file.read(&mut header)).unwrap_or(0);
    if read >= 8 && header.starts_with(&[0x89, b'P', b'N', b'G']) {
        Format::Png
    } else if read >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP" {
        Format::WebP
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
fn decode_png(source: &Path, want_pixels: bool) -> Result<(Vec<u8>, usize, usize), String> {
    let file = File::open(source).map_err(|error| format!("Lecture impossible : {error}"))?;
    let mut decoder = png::Decoder::new(BufReader::with_capacity(256 * 1024, file));
    // EXPAND : palettes, niveaux de gris < 8 bits et tRNS deviennent du RGB(A) 8 bits ; STRIP_16 : 16 bits -> 8 bits.
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|error| format!("PNG illisible : {error}"))?;
    let mut buffer = vec![0u8; reader.output_buffer_size().ok_or("PNG trop grand")?];
    let frame = reader.next_frame(&mut buffer).map_err(|error| format!("Décodage PNG impossible : {error}"))?;
    // Lit la suite du fichier jusqu'à la fin du flux : un PNG tronqué après les données image est aussi détecté.
    reader.finish().map_err(|error| format!("Fin de fichier PNG invalide : {error}"))?;
    let (width, height) = (frame.width as usize, frame.height as usize);
    if width == 0 || height == 0 { return Err("Dimensions PNG incohérentes".into()); }
    if frame.bit_depth != png::BitDepth::Eight { return Err("Profondeur de bits PNG non prise en charge".into()); }
    if !want_pixels { return Ok((Vec::new(), width, height)); }
    let data = &buffer[..frame.buffer_size()];
    let rgb: Vec<u8> = match frame.color_type {
        png::ColorType::Rgb => data.to_vec(),
        png::ColorType::Rgba => data.chunks_exact(4).flat_map(|pixel| flatten([pixel[0], pixel[1], pixel[2]], pixel[3])).collect(),
        png::ColorType::Grayscale => data.iter().flat_map(|&value| [value, value, value]).collect(),
        png::ColorType::GrayscaleAlpha => data.chunks_exact(2).flat_map(|pixel| flatten([pixel[0]; 3], pixel[1])).collect(),
        png::ColorType::Indexed => return Err("PNG indexé non pris en charge".into()),
    };
    if rgb.len() != width * height * 3 { return Err("Dimensions PNG incohérentes".into()); }
    Ok((rgb, width, height))
}

/// Décode un WebP (première image s'il est animé). `want_pixels` faux : décodage complet, mais pas de conversion en RGB (vecteur vide renvoyé).
fn decode_webp(source: &Path, want_pixels: bool) -> Result<(Vec<u8>, usize, usize), String> {
    let file = File::open(source).map_err(|error| format!("Lecture impossible : {error}"))?;
    let mut decoder = image_webp::WebPDecoder::new(BufReader::with_capacity(256 * 1024, file)).map_err(|error| format!("WebP illisible : {error}"))?;
    let (width, height) = decoder.dimensions();
    let (width, height) = (width as usize, height as usize);
    let has_alpha = decoder.has_alpha();
    let mut buffer = vec![0u8; decoder.output_buffer_size().ok_or("WebP trop grand")?];
    decoder.read_image(&mut buffer).map_err(|error| format!("Décodage WebP impossible : {error}"))?;
    let channels = if has_alpha { 4 } else { 3 };
    if width == 0 || height == 0 || buffer.len() != width * height * channels { return Err("Dimensions WebP incohérentes".into()); }
    if !want_pixels { return Ok((Vec::new(), width, height)); }
    let rgb: Vec<u8> = if has_alpha {
        buffer.chunks_exact(4).flat_map(|pixel| flatten([pixel[0], pixel[1], pixel[2]], pixel[3])).collect()
    } else {
        buffer
    };
    Ok((rgb, width, height))
}

/// Analyse un fichier. `Err` = fichier suspect (message affiché dans le rapport).
fn check_file(source: &Path, thumbnails_dir: &Path, max_side: usize, heavy: &Gate) -> Result<Outcome, String> {
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if video::is_video_path(source) || matches!(extension.as_str(), "gif" | "bmp" | "avif") {
        return Ok(Outcome::Unsupported);
    }
    // Même nom de cache que l'interface (chemin, taille et date du fichier). Un fichier dont les métadonnées sont illisibles est suspect.
    let destination = crate::thumbnail_cache_file(thumbnails_dir, &source.to_string_lossy()).map_err(|error| format!("Fichier illisible : {error}"))?;
    let thumbnail_missing = !destination.is_file();

    let (rgb, width, height) = match sniff(source) {
        Format::Png => {
            let _slot = heavy.enter();
            decode_png(source, thumbnail_missing)?
        }
        Format::WebP => {
            let _slot = heavy.enter();
            decode_webp(source, thumbnail_missing)?
        }
        Format::Other => {
            // Une extension PNG / WebP sans la bonne signature n'est acceptée que si c'est en réalité un JPEG.
            if matches!(extension.as_str(), "png" | "webp") {
                let mut magic = [0u8; 2];
                let is_jpeg = File::open(source).and_then(|mut file| file.read_exact(&mut magic)).is_ok() && magic == [0xff, 0xd8];
                if !is_jpeg { return Err(format!("Signature {} invalide ou fichier tronqué", extension.to_uppercase())); }
            }
            // HEIC / HEIF : décodage complet (lourd) ; JPEG et RAW (vignette JPEG intégrée) : décodage à échelle réduite.
            let _slot = crate::heif::is_heif_path(source).then(|| heavy.enter());
            thumbnails::decode_scaled_rgb(source, max_side)?
        }
    };
    if !thumbnail_missing { return Ok(Outcome::Healthy(Thumbnail::Existing)); }

    // Le fichier est sain : la miniature manquante est produite à partir de l'image déjà décodée. Un échec d'écriture n'est pas une corruption.
    let (rgb, width, height) = thumbnails::resize_to_fit(rgb, width, height, max_side);
    let orientation = if crate::heif::is_heif_path(source) { 1 } else { thumbnails::read_orientation(source) };
    let (rgb, width, height) = thumbnails::apply_orientation(rgb, width, height, orientation);
    Ok(Outcome::Healthy(match thumbnails::write_jpeg(&destination, &rgb, width, height) {
        Ok(()) => Thumbnail::Created,
        Err(error) => {
            eprintln!("Miniature non écrite pour {} : {error}", source.display());
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
    let format_files: Vec<AtomicUsize> = FORMAT_LABELS.iter().map(|_| AtomicUsize::new(0)).collect();
    let format_micros: Vec<AtomicU64> = FORMAT_LABELS.iter().map(|_| AtomicU64::new(0)).collect();
    let heavy = Gate::new(HEAVY_DECODES);

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
            let result = panic::catch_unwind(AssertUnwindSafe(|| check_file(path, thumbnails_dir, max_side, &heavy)))
                .unwrap_or_else(|_| Err("Décodeur interrompu : fichier probablement corrompu".to_string()));
            if !matches!(result, Ok(Outcome::Unsupported)) {
                let index = format_index(path);
                format_files[index].fetch_add(1, Ordering::Relaxed);
                format_micros[index].fetch_add(file_started.elapsed().as_micros() as u64, Ordering::Relaxed);
            }
            match result {
                Ok(Outcome::Unsupported) => { unsupported.fetch_add(1, Ordering::Relaxed); }
                Ok(Outcome::Healthy(thumbnail)) => {
                    checked.fetch_add(1, Ordering::Relaxed);
                    healthy.fetch_add(1, Ordering::Relaxed);
                    match thumbnail {
                        Thumbnail::Created => { created.fetch_add(1, Ordering::Relaxed); }
                        Thumbnail::Failed => { failed.fetch_add(1, Ordering::Relaxed); }
                        Thumbnail::Existing => {}
                    }
                }
                Err(error) => {
                    checked.fetch_add(1, Ordering::Relaxed);
                    suspects.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(IntegrityIssue { path: path.to_string_lossy().into_owned(), error });
                }
            }
            // Valeur approximative : l'ordre d'arrivée entre threads n'est pas garanti.
            let done = finished.fetch_add(1, Ordering::Relaxed) + 1;
            if done % step == 0 || done == total { progress(done as f64 / total.max(1) as f64); }
        });
    });

    let mut suspects = suspects.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner());
    suspects.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    let mut timings: Vec<FormatTiming> = FORMAT_LABELS
        .iter()
        .enumerate()
        .filter_map(|(index, label)| {
            let files = format_files[index].load(Ordering::Relaxed);
            (files > 0).then(|| FormatTiming {
                format: label.to_string(),
                files,
                average_millis: format_micros[index].load(Ordering::Relaxed) / files as u64 / 1000,
            })
        })
        .collect();
    timings.sort_by(|a, b| b.average_millis.cmp(&a.average_millis));
    Ok(IntegrityReport {
        folder: folder.to_string_lossy().into_owned(),
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
    })
}

/// Champ CSV entre guillemets. Une valeur qui commence par = + - @ est précédée d'une apostrophe : sinon Excel la prendrait pour une formule.
fn csv_field(value: &str) -> String {
    let escaped = value.replace('"', "\"\"");
    if value.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("\"'{escaped}\"") } else { format!("\"{escaped}\"") }
}

/// Écrit le rapport en CSV dans `directory` (« photoboggan-integrity-AAAAMMJJ-HHMMSS.csv », jamais d'écrasement) et renvoie le chemin du fichier.
/// Séparateur « ; » et BOM UTF-8 : Excel (réglages français) l'ouvre directement avec les accents corrects.
/// `headers` : titres des 4 colonnes (nom du fichier, dossier, chemin complet, problème), traduits par l'interface.
pub fn write_csv(directory: &Path, headers: &[String], rows: &[IntegrityIssue]) -> Result<PathBuf, String> {
    if !directory.is_dir() { return Err(format!("Dossier de destination introuvable : {}", directory.display())); }
    if headers.len() != 4 { return Err("En-têtes de colonnes invalides".into()); }
    let mut content = String::from("\u{feff}");
    content.push_str(&headers.iter().map(|header| csv_field(header)).collect::<Vec<_>>().join(";"));
    content.push_str("\r\n");
    for row in rows {
        let path = Path::new(&row.path);
        let name = path.file_name().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default();
        let parent = path.parent().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default();
        content.push_str(&[csv_field(&name), csv_field(&parent), csv_field(&row.path), csv_field(&row.error)].join(";"));
        content.push_str("\r\n");
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    for attempt in 0u32.. {
        let name = if attempt == 0 { format!("photoboggan-integrity-{stamp}.csv") } else { format!("photoboggan-integrity-{stamp} ({attempt}).csv") };
        let target = directory.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(content.as_bytes()) {
                    drop(file);
                    let _ = fs::remove_file(&target);
                    return Err(format!("Écriture impossible : {error}"));
                }
                return Ok(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Création du fichier impossible : {error}")),
        }
    }
    Err("Création du fichier impossible".into())
}
