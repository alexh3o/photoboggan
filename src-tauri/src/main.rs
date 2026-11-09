#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod albums;
mod db;
mod duplicates;
mod exif;
mod exiftool;
mod face_detect;
mod face_models;
mod model_files;
mod onnx_runtime;
mod semantic;
mod semantic_models;
mod semantic_search;
mod semantic_keywords;
mod phash;
mod place_search;
mod similar;
mod update_check;
mod private_maps;
mod geolocation;
mod face_recognize;
mod faces;
mod heif;
mod integrity;
mod keywords;
mod library_sync;
mod orientation;
mod resize;
mod thumbnails;
mod video;

#[cfg(test)]
mod test_support;

use tauri::{State, Emitter, Manager};
use std::fs;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;
use rayon::prelude::*;
use db::{DbPool, Photo, TrackedFolder};
use tokio::sync::mpsc;
use rusqlite::params;

use std::sync::RwLock;

#[derive(Clone)]
pub struct AppDataPaths {
    pub base_dir: PathBuf,
    pub db_path: PathBuf,
    pub thumbnails_dir: PathBuf,
    pub raw_previews_dir: PathBuf,
    pub is_custom: bool,
}

impl AppDataPaths {
    pub fn from_base(base_dir: PathBuf, is_custom: bool) -> Self {
        let db_path = base_dir.join("photos_library.db");
        let thumbnails_dir = base_dir.join("thumbnails");
        let raw_previews_dir = base_dir.join("raw_previews");
        Self { base_dir, db_path, thumbnails_dir, raw_previews_dir, is_custom }
    }
}

impl AppState {
    pub fn pool(&self) -> DbPool {
        self.db_pool.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }
    pub fn base_dir(&self) -> PathBuf {
        self.paths.read().unwrap_or_else(|poisoned| poisoned.into_inner()).base_dir.clone()
    }
    pub fn thumbnails_dir(&self) -> PathBuf {
        self.paths.read().unwrap_or_else(|poisoned| poisoned.into_inner()).thumbnails_dir.clone()
    }
    pub fn raw_previews_dir(&self) -> PathBuf {
        self.paths.read().unwrap_or_else(|poisoned| poisoned.into_inner()).raw_previews_dir.clone()
    }
    pub fn is_custom(&self) -> bool {
        self.paths.read().unwrap_or_else(|poisoned| poisoned.into_inner()).is_custom
    }
    pub fn thumbnail_cache_size(&self) -> usize {
        *self.thumbnail_cache_size.read().unwrap_or_else(|poisoned| poisoned.into_inner()) as usize
    }
}

use std::sync::Mutex;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct WindowStateConfig {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_maximized: bool,
}

#[derive(Clone, Debug)]
pub struct WindowTracker {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub struct AppState {
    pub db_pool: RwLock<DbPool>,
    pub paths: RwLock<AppDataPaths>,
    pub thumbnail_cache_size: RwLock<u32>,
    pub window_tracker: Mutex<WindowTracker>, // suivi des dimensions normales (hors maximisation)
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct AppConfig {
    custom_data_dir: Option<String>,
    thumbnail_cache_size: Option<u32>,
    /// Thumbnail JPEG quality: "normal" or "high" (see set_thumbnail_quality). Kept here so it applies from startup,
    /// before the frontend sends anything. None or unknown: normal.
    #[serde(default)]
    thumbnail_quality: Option<String>,
    window_state: Option<WindowStateConfig>, // persistance dans config.json
    /// Programs "Open with" may launch (see open_with). None: list not set up yet (first start after the update, see register_existing_programs).
    #[serde(default)]
    open_with_programs: Option<Vec<String>>,
}

fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

/// Config lue sur le disque. Fichier absent : config par défaut. Fichier présent mais illisible ou invalide : erreur, jamais la config par défaut,
/// pour qu'un fichier abîmé ne fasse pas perdre l'emplacement des données et ne soit pas écrasé par la suite.
fn load_config(app: &tauri::AppHandle) -> Result<AppConfig, String> {
    let path = config_file_path(app)?;
    if !path.exists() { return Ok(AppConfig::default()); }
    let data = fs::read_to_string(&path).map_err(|error| format!("config.json illisible : {error}"))?;
    serde_json::from_str(&data).map_err(|error| format!("config.json invalide : {error}"))
}

/// Config au démarrage : un config.json invalide est mis de côté (`config.json.invalid-<date>`, jamais supprimé) et l'application démarre avec
/// les réglages par défaut. Les écritures de config ultérieures refusent de partir d'un fichier invalide (voir load_config).
fn load_config_at_startup(app: &tauri::AppHandle) -> AppConfig {
    match load_config(app) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("Configuration ignored at startup: {error}");
            if let Ok(path) = config_file_path(app) {
                let seconds = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                let backup = path.with_file_name(format!("config.json.invalid-{seconds}"));
                if let Err(rename_error) = fs::rename(&path, &backup) {
                    eprintln!("Invalid configuration not set aside ({}): {rename_error}", backup.display());
                }
            }
            AppConfig::default()
        }
    }
}

/// Écriture atomique : fichier temporaire puis remplacement, jamais un config.json à moitié écrit.
fn save_config(app: &tauri::AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_file_path(app)?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    let temp = path.with_file_name("config.json.tmp");
    if let Err(error) = fs::write(&temp, json) {
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    fs::rename(&temp, &path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        error.to_string()
    })
}

/////////////////////////
///Fonctions de restauration, Bounds Check et sauvegarde
/// Vérifie si le rectangle de la fenêtre intersecte la zone visible d'au moins un écran actif.
fn check_window_visibility(window: &tauri::WebviewWindow, saved: &WindowStateConfig) -> bool {
    let monitors = match window.available_monitors() {
        Ok(m) => m,
        Err(_) => return false,
    };

    if monitors.is_empty() {
        return false;
    }

    let win_x = saved.x;
    let win_y = saved.y;
    let win_w = saved.width.max(100) as i32;
    let win_h = saved.height.max(100) as i32;
    const MIN_OVERLAP: i32 = 100; // Au moins 100x100 px visibles sur l'écran

    for monitor in &monitors {
        let mon_pos = monitor.position();
        let mon_size = monitor.size();

        let mon_x = mon_pos.x;
        let mon_y = mon_pos.y;
        let mon_w = mon_size.width as i32;
        let mon_h = mon_size.height as i32;

        let intersect_x1 = win_x.max(mon_x);
        let intersect_y1 = win_y.max(mon_y);
        let intersect_x2 = (win_x + win_w).min(mon_x + mon_w);
        let intersect_y2 = (win_y + win_h).min(mon_y + mon_h);

        let overlap_w = (intersect_x2 - intersect_x1).max(0);
        let overlap_h = (intersect_y2 - intersect_y1).max(0);

        if overlap_w >= MIN_OVERLAP && overlap_h >= MIN_OVERLAP {
            // Vérifie que la barre de titre reste atteignable (pas au-delà du bord inférieur)
            if win_y >= mon_y - 20 && win_y < mon_y + mon_h - 40 {
                return true;
            }
        }
    }

    false
}

/// Restaure la géométrie de la fenêtre avec vérification de sécurité.
fn restore_window_state(window: &tauri::WebviewWindow, config: &AppConfig) -> WindowTracker {
    const DEFAULT_WIDTH: u32 = 1024;
    const DEFAULT_HEIGHT: u32 = 768;
    // Keep in sync with minWidth / minHeight in tauri.conf.json (logical pixels).
    // 900 = narrowest width where the toolbar with labels does not overflow.
    const MIN_WIDTH_LOGICAL: f64 = 900.0;
    const MIN_HEIGHT_LOGICAL: f64 = 500.0;

    if let Some(ref saved) = config.window_state {
        if check_window_visibility(window, saved) {
            // Saved sizes are physical pixels while the minimum (tauri.conf.json minWidth /
            // minHeight, 800x500) is logical: scale it, so a size saved by an older version
            // without a minimum cannot reopen a window smaller than the OS-enforced one.
            let scale = window.scale_factor().unwrap_or(1.0);
            let width = saved.width.max((MIN_WIDTH_LOGICAL * scale).ceil() as u32);
            let height = saved.height.max((MIN_HEIGHT_LOGICAL * scale).ceil() as u32);

            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width,
                height,
            }));
            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: saved.x,
                y: saved.y,
            }));

            if saved.is_maximized {
                let _ = window.maximize();
            }

            return WindowTracker {
                x: saved.x,
                y: saved.y,
                width,
                height,
            };
        }
    }

    // Réinitialisation de sécurité : taille par défaut et centrage sur l'écran principal
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
    }));
    let _ = window.center();

    let pos = window.outer_position().unwrap_or(tauri::PhysicalPosition { x: 100, y: 100 });
    let size = window.outer_size().unwrap_or(tauri::PhysicalSize { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });

    WindowTracker {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    }
}

/// Sauvegarde l'état actuel de la fenêtre dans config.json.
fn save_current_window_state(window: &tauri::Window, state: &AppState) {
    let is_maximized = window.is_maximized().unwrap_or(false);
    let (x, y, width, height) = match state.window_tracker.lock() {
        Ok(tracker) => (tracker.x, tracker.y, tracker.width, tracker.height),
        Err(_) => return,
    };

    let app = window.app_handle();
    let mut config = match load_config(app) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("Window state not saved: {error}");
            return;
        }
    };
    config.window_state = Some(WindowStateConfig {
        x,
        y,
        width,
        height,
        is_maximized,
    });
    if let Err(error) = save_config(app, &config) { eprintln!("Window state not saved: {error}"); }
}
/////////////////////////
/////////////////////////

fn default_data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("data");
    Ok(dir)
}

fn resolve_app_paths(app: &tauri::AppHandle) -> Result<AppDataPaths, String> {
    let config = load_config_at_startup(app);
    let default_dir = default_data_directory(app)?;
    let (base_dir, is_custom) = match config.custom_data_dir {
        Some(dir_str) if !dir_str.trim().is_empty() => (PathBuf::from(dir_str), true),
        _ => (default_dir, false),
    };
    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(base_dir.join("thumbnails")).map_err(|e| e.to_string())?;
    fs::create_dir_all(base_dir.join("raw_previews")).map_err(|e| e.to_string())?;

    // Migration transparente si une ancienne base locale existe à la racine du projet
    let legacy_db = Path::new("photos_library.db");
    let target_db = base_dir.join("photos_library.db");
    if legacy_db.is_file() && !target_db.is_file() {
        for name in ["photos_library.db", "photos_library.db-wal", "photos_library.db-shm"] {
            if let Err(error) = move_file_or_copy(Path::new(name), &base_dir.join(name)) {
                eprintln!("Legacy database file not migrated ({name}): {error}");
            }
        }
    }

    Ok(AppDataPaths::from_base(base_dir, is_custom))
}

fn thumbnail_cache_file(thumbnails_dir: &Path, source_path: &str) -> Result<PathBuf, String> {
    let metadata = fs::metadata(source_path).map_err(|error| error.to_string())?;
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let mut hash = 0xcbf29ce484222325u64;
    let size_bytes = metadata.len().to_le_bytes();
    let modified_bytes = modified.to_le_bytes();
    // Version du format de l'aperçu : à changer quand son contenu change (orientation EXIF réécrite en v2), pour que les anciens aperçus soient régénérés.
    const PREVIEW_VERSION: [u8; 1] = [2];
    for byte in source_path.as_bytes().iter().chain(size_bytes.iter()).chain(modified_bytes.iter()).chain(PREVIEW_VERSION.iter()) {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    // Le cache est réparti en 256 sous-dossiers selon les 2 premiers caractères du nom (octet de poids fort du hash, bien réparti) : un dossier unique
    // de plusieurs centaines de milliers de fichiers ralentit l'énumération (NTFS, antivirus, Explorateur) et dépasse les limites de FAT32 / exFAT.
    // L'accès à une miniature reste direct (le nom est calculé), seuls les parcours du cache doivent descendre dans les sous-dossiers (`cache_files`).
    let name = format!("{hash:016x}");
    Ok(thumbnails_dir.join(&name[..2]).join(format!("{name}.jpg")))
}

/// Tous les fichiers d'un dossier de cache (miniatures ou aperçus) : ceux des sous-dossiers de répartition, et d'éventuels fichiers à la racine.
fn cache_files(dir: &Path) -> Vec<PathBuf> {
    WalkDir::new(dir).min_depth(1).max_depth(2).into_iter().flatten()
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .collect()
}

/// Supprime les sous-dossiers de répartition devenus vides (les non vides sont conservés : `remove_dir` échoue, c'est voulu).
fn remove_empty_cache_subdirs(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.path().is_dir() { let _ = fs::remove_dir(entry.path()); }
    }
}

fn decode_thumbnail_base64(encoded: &str) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(encoded.len() * 3 / 4);
    let mut accumulator = 0u32;
    let mut bits = 0u8;
    for byte in encoded.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return Err("Données de miniature base64 invalides".into()),
        };
        accumulator = (accumulator << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((accumulator >> bits) as u8);
        }
    }
    if output.len() < 4 || !output.starts_with(&[0xff, 0xd8]) { return Err("Miniature JPEG invalide".into()); }
    Ok(output)
}

// Commandes du cache de miniatures en `async` : elles s'exécutent hors du thread principal de Tauri
// (sinon chaque accès disque bloque la boucle d'événements de la fenêtre).
#[tauri::command(async)]
fn get_cached_thumbnail_path(state: State<'_, AppState>, source_path: String) -> Result<Option<String>, String> {
    let path = thumbnail_cache_file(&state.thumbnails_dir(), &source_path)?;
    Ok(path.is_file().then(|| path.to_string_lossy().into_owned()))
}

// Version par lots : un seul aller-retour IPC pour plusieurs miniatures.
// Le résultat suit l'ordre de `source_paths` (None = pas de miniature en cache).
#[tauri::command(async)]
fn get_cached_thumbnail_paths(state: State<'_, AppState>, source_paths: Vec<String>) -> Vec<Option<String>> {
    let dir = state.thumbnails_dir();
    source_paths.iter().map(|source_path| {
        thumbnail_cache_file(&dir, source_path).ok()
            .filter(|path| path.is_file())
            .map(|path| path.to_string_lossy().into_owned())
    }).collect()
}

#[derive(serde::Serialize)]
struct GeneratedThumbnail {
    path: String,
    width: u32,
    height: u32,
}

// Génère la miniature (JPEG, RAW via son aperçu intégré, HEIC / HEIF, et image fixe d'une vidéo) directement dans le cache, hors du webview : décodage réduit,
// orientation EXIF appliquée, taille réelle renvoyée (ratio exact pour la disposition justifiée).
// Une erreur (PNG, JPEG CMYK, fichier illisible…) indique à l'interface d'utiliser sa génération de repli.
// Generations running at once: same as the interface's own limit (MAX_THUMBNAIL_GENERATIONS, 6 at most), so this is only a safety net against a
// flood of requests, not a throttle on normal use. Each one reads and decodes a whole file. The waiting happens
// on the async side (semaphore), and the work itself on the blocking pool: a backlog of requests must never occupy the runtime threads that
// serve the other commands (folder change, albums…), otherwise the whole interface freezes until the backlog is done.
const MAX_CONCURRENT_THUMBNAIL_GENERATIONS: usize = 6;
static THUMBNAIL_GENERATION_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(MAX_CONCURRENT_THUMBNAIL_GENERATIONS);

#[tauri::command]
async fn generate_thumbnail(state: State<'_, AppState>, source_path: String, max_side: Option<u32>) -> Result<GeneratedThumbnail, String> {
    let max_side = max_side.map(|s| s as usize).unwrap_or_else(|| state.thumbnail_cache_size());
    let thumbnails_dir = state.thumbnails_dir();
    let _permit = THUMBNAIL_GENERATION_GATE.acquire().await.map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || {
        let destination = thumbnail_cache_file(&thumbnails_dir, &source_path)?;
        let size = if destination.is_file() {
            thumbnails::jpeg_size(&destination)?
        } else {
            let _priority = semantic::PriorityGuard::new(); // the semantic scan waits while the grid needs thumbnails
            thumbnails::generate_thumbnail(std::path::Path::new(&source_path), &destination, max_side)?
        };
        Ok(GeneratedThumbnail { path: destination.to_string_lossy().into_owned(), width: size.width, height: size.height })
    })
    .await
    .map_err(|error| error.to_string())?
}

// Les aperçus (RAW, HEIC, vidéo) ont le même nom de cache que les miniatures (chemin, taille, date du fichier), dans leur propre dossier.
fn raw_preview_cache_file(raw_previews_dir: &Path, source_path: &str) -> Result<PathBuf, String> {
    thumbnail_cache_file(raw_previews_dir, source_path)
}

/// Dossiers du cache d'images (miniatures, aperçus extraits des RAW / HEIC / vidéos).
#[derive(Clone)]
pub(crate) struct ImageCacheDirs {
    pub thumbnails: PathBuf,
    pub raw_previews: PathBuf,
}

impl ImageCacheDirs {
    pub fn of(state: &AppState) -> Self {
        Self { thumbnails: state.thumbnails_dir(), raw_previews: state.raw_previews_dir() }
    }
}

/// Écriture de métadonnées seules (note, couleur, mots-clés, titre, zones de visage…) : l'image ne change pas, mais la taille et la date du
/// fichier, dont dépend le nom de sa miniature et de son aperçu en cache, si. Ceux-ci sont renommés pour suivre le fichier réécrit, au lieu
/// d'être régénérés au prochain affichage (redémarrage compris). Un sidecar écrit ne change pas le fichier : rien à faire.
pub(crate) fn keep_cached_images<T>(dirs: &ImageCacheDirs, path: &str, write: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _priority = semantic::PriorityGuard::new(); // every metadata write goes through here: the semantic scan waits meanwhile
    let before = [thumbnail_cache_file(&dirs.thumbnails, path).ok(), raw_preview_cache_file(&dirs.raw_previews, path).ok()];
    let result = write()?;
    let after = [thumbnail_cache_file(&dirs.thumbnails, path).ok(), raw_preview_cache_file(&dirs.raw_previews, path).ok()];
    for (old, new) in before.into_iter().zip(after) {
        // Même nom (fichier inchangé) : surtout ne pas passer par carry_cache_file, qui supprimerait le fichier en cache.
        if old.is_some() && new.is_some() && old != new { carry_cache_file(old, new); }
    }
    Ok(result)
}

/// Écrit `bytes` dans le cache sous `destination` : fichier temporaire du même dossier (préfixe `prefix`) puis renommage ; le temporaire est supprimé
/// en cas d'erreur. Un fichier déjà présent à la fin (écrit entre-temps par une autre tâche) est accepté.
fn write_cache_file(destination: &Path, prefix: &str, bytes: &[u8]) -> Result<(), String> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let parent = destination.parent().ok_or("Dossier de cache invalide")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!("{prefix}-{}-{}.tmp", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
    if let Err(error) = fs::write(&temp, bytes) {
        let _ = fs::remove_file(&temp); // écriture partielle (disque plein…)
        return Err(error.to_string());
    }
    if let Err(error) = fs::rename(&temp, destination) {
        let _ = fs::remove_file(&temp);
        if !destination.is_file() { return Err(error.to_string()); }
    }
    Ok(())
}

// Aperçu d'une vidéo : image fixe plus grande que la miniature de la grille (voir video.rs), mise en cache comme les aperçus RAW.
const VIDEO_PREVIEW_MAX_SIDE: usize = 1280;

#[tauri::command(async)]
fn get_raw_preview_path(state: State<'_, AppState>, source_path: String) -> Result<String, String> {
    let preview_path = raw_preview_cache_file(&state.raw_previews_dir(), &source_path)?;
    if preview_path.is_file() {
        return Ok(preview_path.to_string_lossy().into_owned());
    }
    if video::is_video_path(Path::new(&source_path)) {
        thumbnails::generate_video_preview(Path::new(&source_path), &preview_path, VIDEO_PREVIEW_MAX_SIDE)?;
        return Ok(preview_path.to_string_lossy().into_owned());
    }
    let jpeg_bytes = if heif::is_heif_path(Path::new(&source_path)) {
        // HEIC / HEIF : le webview ne sait pas les lire, on affiche un JPEG pleine résolution décodé en Rust (mis en cache comme les aperçus RAW).
        heif::preview_jpeg(Path::new(&source_path))?
    } else {
        // Orientation EXIF de l'aperçu alignée sur celle de la miniature (le webview applique le tag de l'aperçu lui-même).
        let source = Path::new(&source_path);
        let jpeg = thumbnails::extract_raw_preview(source)?;
        if thumbnails::is_raw_path(source) { thumbnails::preview_with_orientation(source, jpeg) } else { jpeg }
    };
    write_cache_file(&preview_path, "prev", &jpeg_bytes)?;
    Ok(preview_path.to_string_lossy().into_owned())
}

#[tauri::command(async)]
fn save_thumbnail_cache(state: State<'_, AppState>, source_path: String, data_url: String) -> Result<String, String> {
    let encoded = data_url.strip_prefix("data:image/jpeg;base64,").ok_or("Format de miniature non pris en charge")?;
    let bytes = decode_thumbnail_base64(encoded)?;
    let path = thumbnail_cache_file(&state.thumbnails_dir(), &source_path)?;
    if path.is_file() { return Ok(path.to_string_lossy().into_owned()); }
    write_cache_file(&path, "thumb", &bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

// Vidage miniatures
#[tauri::command(async)]
fn clear_thumbnail_cache(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state.thumbnails_dir();
    // Les fichiers qui ne peuvent pas être supprimés (utilisés par un autre programme) sont comptés : le vidage n'est jamais annoncé réussi à tort.
    let mut failed = 0usize;
    if dir.is_dir() {
        for path in cache_files(&dir) {
            if fs::remove_file(&path).is_err() { failed += 1; }
        }
        remove_empty_cache_subdirs(&dir);
    }
    if failed > 0 { return Err(format!("{failed} miniature(s) n'ont pas pu être supprimées (fichier utilisé par un autre programme ?)")); }
    Ok(())
}

// Supprime du cache (miniatures et aperçus RAW / vidéo) les fichiers qui ne correspondent plus à aucune photo du catalogue : photo modifiée (taille ou date
// changées, donc nom de cache différent), supprimée ou déplacée hors de l'application. Le nom de cache est recalculé pour chaque photo du catalogue
// (une lecture de taille et de date par fichier, aucun décodage d'image) ; tout fichier du cache hors de cet ensemble est supprimé. Renvoie leur nombre.
// Une photo dont le fichier a disparu n'a pas de nom attendu : son cache part aussi (il serait régénéré si elle réapparaissait). La purge est reportée
// (erreur) quand un dossier suivi est injoignable (disque externe débranché, partage coupé : les noms de cache de ses photos sont alors inconnus et
// seraient supprimés) ou quand un fichier du catalogue est illisible pour une autre raison qu'une absence.
fn purge_orphan_cache(pool: &DbPool, thumbnails_dir: &Path, raw_previews_dir: &Path) -> Result<usize, String> {
    use rayon::prelude::*;
    let _priority = semantic::PriorityGuard::new(); // the semantic scan waits while every catalogue file is checked
    if db::get_folders(pool).iter().any(|folder| !tracked_root_is_reachable(&folder.path)) {
        return Err("Un dossier suivi est injoignable (disque débranché ?) : nettoyage des miniatures reporté".to_string());
    }
    let conn = pool.get().map_err(|error| error.to_string())?;
    let photo_paths: Vec<String> = {
        let mut statement = conn.prepare("SELECT path FROM photos").map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|error| error.to_string())?
    };
    let unreadable = AtomicUsize::new(0);
    let expected: std::collections::HashSet<PathBuf> = photo_paths
        .par_iter()
        .flat_map_iter(|path| match fs::metadata(path) {
            Ok(_) => [thumbnail_cache_file(thumbnails_dir, path).ok(), raw_preview_cache_file(raw_previews_dir, path).ok()],
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound { unreadable.fetch_add(1, Ordering::Relaxed); }
                [None, None]
            }
        })
        .flatten()
        .collect();
    let unreadable = unreadable.load(Ordering::Relaxed);
    if unreadable > 0 { return Err(format!("{unreadable} fichier(s) du catalogue illisibles : nettoyage des miniatures reporté")); }
    let mut removed = 0;
    for dir in [thumbnails_dir, raw_previews_dir] {
        for path in cache_files(dir) {
            let is_cache_jpg = path.extension().map_or(false, |extension| extension == "jpg");
            if is_cache_jpg && !expected.contains(&path) && fs::remove_file(&path).is_ok() { removed += 1; }
        }
    }
    Ok(removed)
}

// Bouton « Supprimer les miniatures orphelines » (Paramètres > Stockage) ; la même purge termine le rescan complet (voir rescan_all_folders).
#[tauri::command]
async fn purge_orphan_thumbnails(state: State<'_, AppState>) -> Result<usize, String> {
    let pool = state.pool();
    let (thumbnails_dir, raw_previews_dir) = (state.thumbnails_dir(), state.raw_previews_dir());
    tokio::task::spawn_blocking(move || purge_orphan_cache(&pool, &thumbnails_dir, &raw_previews_dir))
        .await
        .map_err(|error| error.to_string())?
}

// Tailles de cache proposées. 512 px minimum : la détection des visages lit les miniatures en cache et YuNet travaille en 640 px
// (une miniature de 256 px ferait manquer les petits visages).
const THUMBNAIL_CACHE_SIZES: [u32; 3] = [512, 768, 1024];

#[tauri::command(async)]
fn set_thumbnail_cache_size(app: tauri::AppHandle, state: State<'_, AppState>, size: u32) -> Result<(), String> {
    if !THUMBNAIL_CACHE_SIZES.contains(&size) {
        return Err("Taille de miniature non valide".into());
    }
    {
        let mut guard = state.thumbnail_cache_size.write().map_err(|e| e.to_string())?;
        *guard = size;
    }
    let mut config = load_config(&app)?;
    config.thumbnail_cache_size = Some(size);
    save_config(&app, &config)?;
    Ok(())
}

/// Thumbnail quality chosen in Settings > Storage: "normal" or "high". Applies to thumbnails written from now on,
/// existing ones are kept (the user did not ask for the cache to be rebuilt).
#[tauri::command(async)]
fn set_thumbnail_quality(app: tauri::AppHandle, quality: String) -> Result<(), String> {
    let high = match quality.as_str() {
        "normal" => false,
        "high" => true,
        _ => return Err("Qualité de miniature non valide".into()),
    };
    let mut config = load_config(&app)?;
    config.thumbnail_quality = Some(quality);
    save_config(&app, &config)?;
    thumbnails::set_high_quality_thumbnails(high);
    Ok(())
}


#[tauri::command]
fn get_folders(state: State<'_, AppState>) -> Vec<TrackedFolder> {
    let pool = state.pool();
    db::get_folders(&pool)
}

#[tauri::command]
// Ajoute le dossier à la liste des dossiers suivis, sans le scanner : l'interface met le scan en file d'attente (commande `scan_folder`),
// pour que plusieurs scans ne tournent jamais en même temps.
async fn add_folder(state: State<'_, AppState>, path: String) -> Result<Vec<TrackedFolder>, String> {
    let pool = state.pool();
    db::add_folder(&pool, &path)?;
    let folders = db::get_folders(&pool);
    Ok(folders)
}

#[tauri::command]
fn remove_folder(state: State<'_, AppState>, id: i64, path: String) -> Result<Vec<TrackedFolder>, String> {
    let pool = state.pool();
    db::remove_folder(&pool, id, &path)?;
    Ok(db::get_folders(&pool))
}

#[derive(Clone, Copy)]
enum ScanMode {
    Rescan { index: usize, count: usize },
    FolderScan,
}

// Progression d'une tâche de scan, publiée dans l'événement « scan-progress » : l'interface retrouve sa tâche grâce à `taskId`
// (identifiant qu'elle a donné à la commande), ce qui évite de confondre les noms et les pourcentages de deux tâches.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    task_id: String,
    percent: u32,
}

// Drapeaux d'annulation des scans, par identifiant de tâche. Le drapeau est créé par le premier qui le demande (le scan ou la demande d'arrêt),
// donc un arrêt demandé juste au démarrage d'un scan n'est pas perdu. Le scan le retire à sa fin.
struct CancelEntry {
    flag: Arc<AtomicBool>,
    created: Instant,
}

fn scan_cancel_flags() -> &'static Mutex<HashMap<String, CancelEntry>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, CancelEntry>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn scan_cancel_flag(task_id: &str) -> Arc<AtomicBool> {
    let mut flags = scan_cancel_flags().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // Entrées orphelines (arrêt demandé alors que la tâche était déjà terminée : personne ne les retire) : supprimées après 10 minutes.
    flags.retain(|_, entry| Arc::strong_count(&entry.flag) > 1 || entry.created.elapsed() < Duration::from_secs(600));
    flags.entry(task_id.to_string()).or_insert_with(|| CancelEntry { flag: Arc::new(AtomicBool::new(false)), created: Instant::now() }).flag.clone()
}

/// Nombre de tâches de la file en cours (scan, rescan, intégrité, copie, déplacement, écriture de mots-clés, détection de visages, téléchargement
/// des modèles) : chacune garde un clone de son drapeau d'arrêt. Une entrée orpheline (arrêt demandé après la fin d'une tâche) n'en a pas.
fn running_tasks() -> usize {
    scan_cancel_flags().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).values().filter(|entry| Arc::strong_count(&entry.flag) > 1).count()
}

fn release_scan_cancel_flag(task_id: &str) {
    scan_cancel_flags().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(task_id);
}

// Arrête un scan ou une relecture en cours : le parcours cesse et les photos déjà lues restent dans le catalogue.
// Les fichiers non lus seront repris par la synchronisation incrémentale (sync_library) ou par une nouvelle relecture.
#[tauri::command]
fn cancel_scan(task_id: String) {
    scan_cancel_flag(&task_id).store(true, Ordering::SeqCst);
}

// `scan_mode` : mode de calcul de l'avancement (relecture, éventuellement d'une partie des dossiers suivis, ou découverte d'un dossier)
// `task_id` / `cancel` : identifiant de la tâche pour les événements de progression, et drapeau d'arrêt demandé par l'interface
// `resume_since`: the scan resumes a paused one first started at this time (ms): files read since then and unchanged are skipped.
// Renvoie une erreur si le parcours ou l'enregistrement a échoué (tâche en erreur, panique, lots non enregistrés) : un scan n'est jamais
// annoncé réussi alors que des photos n'ont pas été enregistrées.
async fn run_scan(app: tauri::AppHandle, pool: DbPool, scan_path: String, scan_mode: ScanMode, task_id: String, cancel: Arc<AtomicBool>, resume_since: Option<i64>) -> Result<(), String> {
    // Files already read by the paused scan (none for a scan that starts from scratch).
    let already_read = match resume_since {
        Some(since) => {
            let conn = pool.get().map_err(|error| format!("Connexion à la base impossible : {error}"))?;
            library_sync::read_since(&conn, &scan_path, since).map_err(|error| error.to_string())?
        }
        None => HashMap::new(),
    };
    let _priority = semantic::PriorityGuard::new(); // the semantic scan waits while the catalogue is read
    // Chaque photo arrive avec la date de modification de son fichier, enregistrée en base avec les métadonnées
    // pour que la synchronisation automatique ne la relise pas inutilement.
    let (tx, mut rx) = mpsc::channel::<(Photo, i64, Vec<Vec<String>>, faces::PhotoFaces)>(100);

    let pool_clone = pool.clone();
    let writer = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let mut modified_dates: Vec<(String, i64)> = Vec::new();
        // Mots-clés hiérarchiques lus dans les fichiers (chemin de la photo, chemins de mots-clés), enregistrés après l'insertion des photos.
        let mut keyword_batches: Vec<(String, Vec<Vec<String>>)> = Vec::new();
        // Orientation et zones de visage, enregistrées après les mots-clés (la liaison personne ↔ mot-clé cherche les nœuds de l'arbre).
        let mut face_batches: Vec<(String, faces::PhotoFaces)> = Vec::new();
        let conn = pool_clone.get().map_err(|error| format!("Connexion à la base impossible : {error}"))?;
        let mut failed_batches = 0usize;
        while let Some((photo, modified, keyword_paths, photo_faces)) = rx.recv().await {
            modified_dates.push((photo.path.clone(), modified));
            keyword_batches.push((photo.path.clone(), keyword_paths));
            face_batches.push((photo.path.clone(), photo_faces));
            buffer.push(photo);
            if buffer.len() >= 500 {
                if let Err(error) = library_sync::store_read_batch(&conn, &buffer, &modified_dates, &keyword_batches, &face_batches) {
                    eprintln!("Scan batch not stored: {error}");
                    failed_batches += 1;
                }
                buffer.clear();
                modified_dates.clear();
                keyword_batches.clear();
                face_batches.clear();
            }
        }
        if !buffer.is_empty() {
            if let Err(error) = library_sync::store_read_batch(&conn, &buffer, &modified_dates, &keyword_batches, &face_batches) {
                eprintln!("Scan batch not stored: {error}");
                failed_batches += 1;
            }
        }
        if failed_batches > 0 { return Err(format!("{failed_batches} lot(s) de photos n'ont pas pu être enregistrés")); }
        Ok::<(), String>(())
    });

    let progress_app = app.clone();
    let scanner = tokio::task::spawn_blocking(move || {
        // Vrai quand l'écriture s'est arrêtée (son récepteur est fermé) : le parcours cesse au lieu de lire des fichiers qui ne seront pas enregistrés.
        let writer_gone = AtomicBool::new(false);
        // Progression : `fraction` (0 à 1) est celle du dossier ; pour une relecture de plusieurs dossiers, elle est ramenée à l'ensemble.
        let publish = |fraction: f64| {
            let percent = match scan_mode {
                ScanMode::Rescan { index, count } => (index as f64 + fraction) / count.max(1) as f64 * 100.0,
                ScanMode::FolderScan => fraction * 100.0,
            };
            let _ = progress_app.emit("scan-progress", ScanProgress { task_id: task_id.clone(), percent: percent.round() as u32 });
        };
        let entries: Vec<_> = WalkDir::new(scan_path)
            .into_iter()
            .take_while(|_| !cancel.load(Ordering::Relaxed) && !writer_gone.load(Ordering::Relaxed))
            .filter_map(|e| e.ok())
            .filter(|e| !e.file_type().is_dir() && library_sync::is_photo_file(e.path()))
            .collect();

        let total = entries.len().max(1);
        let step = (total / 100).max(1);
        let done = AtomicUsize::new(0);

        if entries.is_empty() {
            publish(1.0);
        }

        entries.par_iter().for_each(|entry| {
            // Arrêt demandé : les fichiers restants ne sont pas lus (ceux déjà lus sont enregistrés normalement).
            if cancel.load(Ordering::Relaxed) || writer_gone.load(Ordering::Relaxed) { return; }
            // Progression : un événement environ tous les 1 % du dossier. Valeur approximative : l'ordre d'arrivée entre threads n'est pas garanti.
            let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
            if finished % step == 0 || finished == total {
                publish(finished as f64 / total as f64);
            }
            let path_str = entry.path().to_string_lossy().to_string();
            let Ok(metadata) = entry.metadata() else { return; };
            let file_size = metadata.len() as i64;
            let modified = library_sync::modified_millis(&metadata);
            // Resumed scan: already read before the pause (it still counts in the progress above).
            if library_sync::already_read(&already_read, &path_str, file_size, modified) { return; }
            // Même lecture que la synchronisation : un fichier illisible ou modifié pendant la lecture est sauté (repris à la synchronisation suivante),
            // jamais enregistré avec des métadonnées vides.
            let (photo, keyword_paths, photo_faces) = match library_sync::read_photo(&path_str, file_size, modified) {
                Ok(read) => read,
                Err(error) => {
                    eprintln!("File skipped by the scan ({path_str}): {error}");
                    return;
                }
            };
            if tx.blocking_send((photo, modified, keyword_paths, photo_faces)).is_err() { writer_gone.store(true, Ordering::Relaxed); }
        });
    });
    let scanned = scanner.await;
    let stored = writer.await;
    scanned.map_err(|error| format!("Le parcours du dossier a échoué : {error}"))?;
    stored.map_err(|error| format!("L'enregistrement des photos a échoué : {error}"))?
}

// Découverte d'un dossier qui vient d'être ajouté (voir add_folder) : lit les métadonnées de ses photos et rend la main quand c'est terminé.
// La progression est publiée par « scan-progress » (0 à 100 % du dossier) avec l'identifiant de la tâche.
#[tauri::command]
// `resume_since` (ms): resumes a paused scan first started at that time (see run_scan); absent for a new scan.
async fn scan_folder(app: tauri::AppHandle, state: State<'_, AppState>, path: String, task_id: String, resume_since: Option<i64>) -> Result<(), String> {
    let pool = state.pool();
    let cancel = scan_cancel_flag(&task_id);
    let outcome = run_scan(app, pool, path, ScanMode::FolderScan, task_id.clone(), cancel, resume_since).await;
    release_scan_cancel_flag(&task_id);
    outcome
}

#[tauri::command]
async fn rescan_all_folders(app: tauri::AppHandle, state: State<'_, AppState>, task_id: String, resume_since: Option<i64>) -> Result<(), String> {
    let pool = state.pool();
    let folders = db::get_folders(&pool);
    let count = folders.len();
    let cancel = scan_cancel_flag(&task_id);
    for (index, folder) in folders.into_iter().enumerate() {
        if cancel.load(Ordering::Relaxed) { break; }
        if let Err(error) = run_scan(app.clone(), pool.clone(), folder.path, ScanMode::Rescan { index, count }, task_id.clone(), cancel.clone(), resume_since).await {
            release_scan_cancel_flag(&task_id);
            return Err(error);
        }
    }
    // Rescan terminé sans arrêt demandé : le catalogue est à jour, les miniatures qui ne lui correspondent plus sont supprimées.
    if !cancel.load(Ordering::Relaxed) {
        let (thumbnails_dir, raw_previews_dir) = (state.thumbnails_dir(), state.raw_previews_dir());
        let purge_pool = pool.clone();
        match tokio::task::spawn_blocking(move || purge_orphan_cache(&purge_pool, &thumbnails_dir, &raw_previews_dir)).await {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => eprintln!("Orphan cache purge skipped: {error}"),
            Err(error) => eprintln!("Orphan cache purge failed: {error}"),
        }
    }
    release_scan_cancel_flag(&task_id);
    Ok(())
}

fn path_segments(path: &str) -> Vec<&str> {
    path.split(|character| character == '\\' || character == '/').filter(|segment| !segment.is_empty()).collect()
}

// Chemin réel d'un dossier de l'arborescence : le dossier suivi qui le contient, tel qu'il est enregistré, suivi des segments relatifs.
// L'arborescence de l'interface assemble ses chemins avec des « / » : les relire tels quels enregistrerait les photos sous un autre texte de chemin
// (« D:\Photos/2024\a.jpg » au lieu de « D:\Photos\2024\a.jpg ») et créerait des doublons en base. Renvoie None si le dossier n'est pas suivi.
fn resolve_tracked_folder(pool: &DbPool, requested: &str) -> Option<PathBuf> {
    let requested_segments = path_segments(requested);
    db::get_folders(pool).into_iter().find_map(|folder| {
        let root_segments = path_segments(&folder.path);
        let inside_root = !root_segments.is_empty()
            && requested_segments.len() >= root_segments.len()
            && root_segments.iter().zip(&requested_segments).all(|(root, part)| root.to_lowercase() == part.to_lowercase());
        if !inside_root { return None; }
        let mut resolved = PathBuf::from(&folder.path);
        for segment in &requested_segments[root_segments.len()..] { resolved.push(segment); }
        Some(resolved)
    })
}

// Rescan d'un seul dossier suivi ou d'un de ses sous-dossiers (sous-dossiers compris), comme le rescan complet : les métadonnées de chaque
// fichier sont relues. La progression est publiée par l'événement « scan-progress » (0 à 100 % du dossier) avec l'identifiant de la tâche.
#[tauri::command]
async fn rescan_folder(app: tauri::AppHandle, state: State<'_, AppState>, path: String, task_id: String, resume_since: Option<i64>) -> Result<(), String> {
    let pool = state.pool();
    let scan_path = resolve_tracked_folder(&pool, &path).ok_or_else(|| format!("Dossier non suivi : {path}"))?;
    if !scan_path.is_dir() { return Err(format!("Dossier introuvable : {path}")); }
    let cancel = scan_cancel_flag(&task_id);
    let outcome = run_scan(app, pool.clone(), scan_path.to_string_lossy().into_owned(), ScanMode::Rescan { index: 0, count: 1 }, task_id.clone(), cancel, resume_since).await;
    release_scan_cancel_flag(&task_id);
    outcome
}

// Dossier en cours d'analyse par une tâche (vérification d'intégrité), publié dans l'événement « scan-detail » à chaque changement de dossier.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanDetail {
    task_id: String,
    detail: String,
}

// Vérification d'intégrité d'un dossier de l'arborescence (voir integrity.rs) : chaque fichier est décodé (RAW : vignette JPEG intégrée) et la miniature est créée
// seulement si elle est absente du cache. Renvoie le rapport (fichiers suspects compris). La progression est publiée par « scan-progress » comme les autres tâches de la file ;
// l'arrêt (cancel_scan) rend un rapport partiel. Le catalogue n'est pas modifié.
#[tauri::command]
async fn integrity_scan(app: tauri::AppHandle, state: State<'_, AppState>, path: String, task_id: String) -> Result<integrity::IntegrityReport, String> {
    let pool = state.pool();
    let folder = resolve_tracked_folder(&pool, &path).ok_or_else(|| format!("Dossier non suivi : {path}"))?;
    if !folder.is_dir() { return Err(format!("Dossier introuvable : {path}")); }
    let thumbnails_dir = state.thumbnails_dir();
    let max_side = state.thumbnail_cache_size();
    let cancel = scan_cancel_flag(&task_id);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let publish = |fraction: f64| {
            let _ = app.emit("scan-progress", ScanProgress { task_id: worker_task_id.clone(), percent: (fraction * 100.0).round() as u32 });
        };
        let publish_folder = |folder_label: &str| {
            let _ = app.emit("scan-detail", ScanDetail { task_id: worker_task_id.clone(), detail: folder_label.to_string() });
        };
        let _priority = semantic::PriorityGuard::new();
        integrity::run(&folder, &thumbnails_dir, max_side, &cancel, &publish, &publish_folder)
    }).await;
    release_scan_cancel_flag(&task_id);
    outcome.map_err(|error| error.to_string())?
}

// Duplicate search, identical images (see duplicates.rs): the scope is resolved in the backend, only groups of paths are returned. Progress goes through
// "scan-progress" like the other queue tasks; stopping (cancel_scan) returns a report flagged `cancelled`. The catalog only gets the hash cache.
#[tauri::command]
async fn find_duplicates(app: tauri::AppHandle, state: State<'_, AppState>, request: duplicates::Request, task_id: String) -> Result<duplicates::Report, String> {
    let pool = state.pool();
    let cancel = scan_cancel_flag(&task_id);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let publish = |fraction: f64| {
            let _ = app.emit("scan-progress", ScanProgress { task_id: worker_task_id.clone(), percent: (fraction * 100.0).round() as u32 });
        };
        let _priority = semantic::PriorityGuard::new();
        duplicates::run(&pool, &request, &cancel, &publish)
    }).await;
    release_scan_cancel_flag(&task_id);
    outcome.map_err(|error| error.to_string())?
}

// Duplicate search by file name: the interface applies the name pattern (a JavaScript regular expression), so the backend only lists the photos concerned.
#[tauri::command(async)]
fn list_duplicate_candidates(state: State<'_, AppState>, scope: duplicates::Scope, compare_with_library: bool) -> Result<Vec<(String, String, bool)>, String> {
    duplicates::name_candidates(&state.pool(), &scope, compare_with_library)
}

// Duplicate search, similar images (see similar.rs): same flow as find_duplicates. Fingerprints are read from the thumbnail cache when a thumbnail exists
// (nothing is ever written there) and kept in the catalog.
#[tauri::command]
async fn find_similar_images(app: tauri::AppHandle, state: State<'_, AppState>, request: similar::Request, task_id: String) -> Result<duplicates::Report, String> {
    let pool = state.pool();
    let thumbnails_dir = state.thumbnails_dir();
    let cancel = scan_cancel_flag(&task_id);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let publish = |fraction: f64| {
            let _ = app.emit("scan-progress", ScanProgress { task_id: worker_task_id.clone(), percent: (fraction * 100.0).round() as u32 });
        };
        let _priority = semantic::PriorityGuard::new();
        similar::run(&pool, &thumbnails_dir, &request, &cancel, &publish)
    }).await;
    release_scan_cancel_flag(&task_id);
    outcome.map_err(|error| error.to_string())?
}

// Exporte le rapport d'intégrité en .txt dans le dossier choisi par l'utilisateur : texte d'en-tête fourni par l'interface, puis fichiers suspects au format CSV.
// Renvoie le chemin du fichier créé (jamais d'écrasement).
#[tauri::command(async)]
fn export_integrity_report(directory: String, preamble: String, headers: Vec<String>, rows: Vec<integrity::IntegrityIssue>) -> Result<String, String> {
    integrity::write_report(Path::new(&directory), &preamble, &headers, &rows).map(|file| file.to_string_lossy().into_owned())
}

// Ouvre un dossier de l'arborescence dans le gestionnaire de fichiers par défaut de l'OS (Explorateur Windows, Finder, gestionnaire Linux).
// Utilise le plugin opener déjà intégré, sans nouvelle dépendance.
#[tauri::command(async)]
fn open_folder_in_file_manager(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let pool = state.pool();
    let folder = resolve_tracked_folder(&pool, &path).ok_or_else(|| format!("Dossier non suivi : {path}"))?;
    if !folder.is_dir() { return Err(format!("Dossier introuvable : {path}")); }
    let native: PathBuf = folder.components().collect();
    let native = native.to_string_lossy().into_owned();
    tauri_plugin_opener::open_path(native.as_str(), None::<&str>).map_err(|error| format!("Impossible d'ouvrir {native} : {error}"))
}

// Crée un sous-dossier dans un dossier de l'arborescence (suivi ou sous-dossier d'un dossier suivi). Le nom est vérifié ici : un seul niveau,
// sans caractère interdit par Windows (le même nom reste donc valide sous Linux et macOS), et jamais d'écrasement d'un dossier ou fichier existant.
#[tauri::command(async)]
fn create_subfolder(state: State<'_, AppState>, parent: String, name: String) -> Result<(), String> {
    let name = validate_new_name(&name)?;
    let pool = state.pool();
    let parent_folder = resolve_tracked_folder(&pool, &parent).ok_or_else(|| format!("Dossier non suivi : {parent}"))?;
    if !parent_folder.is_dir() { return Err(format!("Dossier introuvable : {parent}")); }
    let target = parent_folder.join(name);
    if target.exists() { return Err(format!("« {name} » existe déjà dans ce dossier")); }
    fs::create_dir(&target).map_err(|error| format!("Création impossible : {error}"))
}

// Liste tous les sous-dossiers présents sur le disque sous les dossiers suivis. L'arborescence de l'interface est déduite des photos : cette liste
// sert à y montrer aussi les dossiers sans photo (option « Afficher les dossiers vides »), par exemple pour y déplacer ou copier des photos.
// Les dossiers cachés (nom commençant par « . ») et les dossiers système Windows (« $RECYCLE.BIN »…) sont ignorés ; les liens symboliques ne sont pas suivis.
#[tauri::command(async)]
fn list_disk_folders(state: State<'_, AppState>) -> Vec<String> {
    let pool = state.pool();
    let mut result = Vec::new();
    for tracked in db::get_folders(&pool) {
        let walker = walkdir::WalkDir::new(&tracked.path).min_depth(1).into_iter()
            .filter_entry(|entry| entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with(['.', '$']));
        for entry in walker.flatten() {
            if entry.file_type().is_dir() { result.push(entry.path().to_string_lossy().into_owned()); }
        }
    }
    result
}

/// Insère (ou met à jour) un lot de photos en une seule transaction : tout ou rien, l'erreur est renvoyée à l'appelant.
fn insert_batch(conn: &rusqlite::Connection, photos: &[Photo]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO photos
            (path, filename, date_taken, aperture, shutter_speed, iso, focal_length, manufacturer, camera_model, width, height, file_size, rating, color_flag, keywords, caption, lens_model, title, pick_flag, gps_lat, gps_lon, flash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                filename=excluded.filename, date_taken=excluded.date_taken,
                aperture=excluded.aperture, shutter_speed=excluded.shutter_speed,
                iso=excluded.iso, focal_length=excluded.focal_length, manufacturer=excluded.manufacturer,
                camera_model=excluded.camera_model, width=excluded.width,
                height=excluded.height, file_size=excluded.file_size,
                rating=excluded.rating, color_flag=excluded.color_flag,
                keywords=excluded.keywords, caption=excluded.caption, lens_model=excluded.lens_model, title=excluded.title,
                pick_flag=excluded.pick_flag, gps_lat=excluded.gps_lat, gps_lon=excluded.gps_lon, flash=excluded.flash"
        )?;

        for p in photos {
            stmt.execute(params![
                p.path, p.filename, p.date_taken, p.aperture, p.shutter_speed,
                p.iso, p.focal_length, p.manufacturer, p.camera_model, p.width, p.height, p.file_size,
                p.rating, p.color_flag, p.keywords, p.caption, p.lens_model, p.title, p.pick_flag, p.gps_lat, p.gps_lon, p.flash
            ])?;
        }
    }
    tx.commit()
}

// Catalog records of a list of paths (results of the duplicate search); unknown paths are left out.
#[tauri::command]
fn get_photos_by_paths(state: State<'_, AppState>, paths: Vec<String>) -> Vec<Photo> {
    db::get_photos_by_paths(&state.pool(), &paths).unwrap_or_else(|error| {
        eprintln!("Photos by path unavailable: {error}");
        Vec::new()
    })
}

// Catalog records of a list of photo ids (results of the content search); unknown ids are left out.
#[tauri::command]
fn get_photos_by_ids(state: State<'_, AppState>, ids: Vec<i64>) -> Vec<Photo> {
    db::get_photos_by_ids(&state.pool(), &ids).unwrap_or_else(|error| {
        eprintln!("Photos by id unavailable: {error}");
        Vec::new()
    })
}

// `sort_key` / `sort_order` (optional, default newest first): the interface sort, so that a capped list holds the right photos.
// `prefilter` (optional): filters applied before the cut on large folders (see `db::PhotoPrefilter`).
// Async: the query can take a few hundred milliseconds on a large catalogue, and must not freeze the window meanwhile.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn get_photos_paginated(state: State<'_, AppState>, offset: i32, limit: i32, folder_filter: Option<String>, recursive: bool, sort_key: Option<String>, sort_order: Option<String>, prefilter: Option<db::PhotoPrefilter>) -> Vec<Photo> {
    let pool = state.pool();
    let ascending = sort_order.as_deref() == Some("asc");
    let prefilter = prefilter.unwrap_or_default();
    // L'interface attend une liste : une erreur est tracée et donne une liste vide plutôt qu'un rejet de la commande.
    db::get_photos_filtered(&pool, offset, limit, folder_filter, recursive, sort_key.as_deref().unwrap_or("taken"), ascending, &prefilter).unwrap_or_else(|error| {
        eprintln!("Photo list unavailable: {error}");
        Vec::new()
    })
}

// Number of photos of a folder (or of the whole catalogue), optionally prefiltered: it decides whether the backend prefilters, and
// the warning shown when the list is capped. An error gives `None`: the interface then shows no number rather than a wrong one.
#[tauri::command(async)]
fn count_photos(state: State<'_, AppState>, folder_filter: Option<String>, recursive: bool, prefilter: Option<db::PhotoPrefilter>) -> Option<i64> {
    db::count_photos(&state.pool(), folder_filter, recursive, &prefilter.unwrap_or_default()).map_err(|error| eprintln!("Photo count unavailable: {error}")).ok()
}

// Photos et vidéos de chaque dossier du catalogue (niveau direct), pour l'option « Montrer le nombre de photos des dossiers ».
#[tauri::command(async)]
fn get_folder_counts(state: State<'_, AppState>) -> std::collections::HashMap<String, i64> {
    let pool = state.pool();
    db::get_folder_counts(&pool).unwrap_or_else(|error| {
        eprintln!("Folder counts unavailable: {error}");
        Default::default()
    })
}

/// Photo visée par une écriture de marquage (identifiant et chemin du catalogue).
/// Optional values of its own (undo, which gives every photo back its previous value): they replace those of the batch for this photo.
#[derive(serde::Deserialize)]
struct MarkingTarget {
    id: i64,
    path: String,
    #[serde(default)]
    rating: Option<i32>,
    #[serde(default)]
    color_flag: Option<String>,
    #[serde(default)]
    pick_flag: Option<String>,
}

#[derive(serde::Serialize)]
struct MarkingFailure {
    photo_id: i64,
    path: String,
    error: String,
}

#[derive(serde::Serialize)]
struct MarkingResult {
    /// Photos écrites (fichier et base).
    written: Vec<i64>,
    failed: Vec<MarkingFailure>,
    /// Photos laissées intactes parce que la tâche a été arrêtée.
    cancelled: usize,
}

/// Note, couleur et/ou fanion pick d'un lot de photos, en une commande (directe, ou tâche de la file avec `task_id` : progression et arrêt).
/// Seules les valeurs fournies sont modifiées : écrire la note ne touche pas au xmp:Label (qui peut contenir une valeur non reconnue par
/// l'application), ni au fanion pick, et inversement. Les écritures sur une même image sont sérialisées par exiftool::path_lock.
#[tauri::command]
async fn update_photos_marking(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    photos: Vec<MarkingTarget>,
    rating: Option<i32>,
    color_flag: Option<String>,
    pick_flag: Option<String>,
    task_id: Option<String>,
) -> Result<MarkingResult, String> {
    // Values of each photo (its own, else those of the batch), all checked before any write: an invalid value refuses the whole batch.
    struct Prepared {
        photo: MarkingTarget,
        rating: Option<i32>,
        label: Option<Option<&'static str>>,
        pick: Option<&'static str>,
        color_flag: Option<String>,
    }
    let prepared = photos
        .into_iter()
        .map(|photo| -> Result<Prepared, String> {
            let rating = photo.rating.or(rating).map(|value| value.clamp(0, 5));
            let color_flag = photo.color_flag.clone().or_else(|| color_flag.clone());
            let label = color_flag.as_deref().map(exif::label_for_color_flag).transpose()?;
            let pick = photo.pick_flag.as_deref().or(pick_flag.as_deref()).map(exif::normalize_pick_flag).transpose()?;
            Ok(Prepared { photo, rating, label, pick, color_flag })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let pool = state.pool();
    let dirs = ImageCacheDirs::of(&state);
    let cancel = task_id.as_deref().map(scan_cancel_flag);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || -> Result<MarkingResult, String> {
        let total = prepared.len().max(1);
        let done = AtomicUsize::new(0);
        let threads = rayon::ThreadPoolBuilder::new().num_threads(3).build().map_err(|error| error.to_string())?;
        // None : photo non traitée (tâche arrêtée) ; Some(Err(message)) : échec.
        let outcomes: Vec<(MarkingTarget, Option<Result<(), String>>)> = threads.install(|| {
            prepared
                .into_par_iter()
                .map(|Prepared { photo, rating, label, pick, color_flag }| {
                    if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::SeqCst)) { return (photo, None); }
                    let result = write_photo_marking(&pool, &dirs, photo.id, &photo.path, rating, label, pick, color_flag.as_deref());
                    let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
                    if let Some(id) = &worker_task_id {
                        let _ = app.emit("scan-progress", ScanProgress { task_id: id.clone(), percent: (finished * 100 / total) as u32 });
                    }
                    (photo, Some(result))
                })
                .collect()
        });
        let mut result = MarkingResult { written: Vec::new(), failed: Vec::new(), cancelled: 0 };
        for (photo, outcome) in outcomes {
            match outcome {
                None => result.cancelled += 1,
                Some(Ok(())) => result.written.push(photo.id),
                Some(Err(error)) => result.failed.push(MarkingFailure { photo_id: photo.id, path: photo.path, error }),
            }
        }
        Ok(result)
    })
    .await;
    if let Some(id) = &task_id { release_scan_cancel_flag(id); }
    outcome.map_err(|error| error.to_string())?
}

/// Marquage d'une photo : fichier (ou sidecar), puis base. `label` et `pick` déjà vérifiés ; `color_flag` : valeur enregistrée en base.
/// La miniature et l'aperçu en cache suivent le fichier réécrit (keep_cached_images).
#[allow(clippy::too_many_arguments)]
fn write_photo_marking(
    pool: &DbPool,
    dirs: &ImageCacheDirs,
    id: i64,
    path: &str,
    rating: Option<i32>,
    label: Option<Option<&'static str>>,
    pick: Option<&'static str>,
    color_flag: Option<&str>,
) -> Result<(), String> {
    if rating.is_none() && label.is_none() && pick.is_none() { return Ok(()); }
    keep_cached_images(dirs, path, || exif::write_xmp_metadata(path, exif::XmpEdit { rating, label, pick }).map_err(|e| e.to_string()))?;
    // The file is read back before the catalog is updated: a write that did not put the value where the interface reads it (ignored field,
    // read order, sidecar of another file) is a failure, never shown as written. Only the marking is read (exif::read_marking): negligible cost.
    if let Some(difference) = exif::marking_mismatch(&exif::read_marking(Path::new(path)), rating, color_flag, pick) {
        return Err(difference);
    }
    let conn = pool.get().map_err(|error| error.to_string())?;
    // Le fichier vient d'être réécrit par l'application : sa nouvelle taille et sa date sont enregistrées avec les valeurs, dans une même
    // transaction. Si l'enregistrement échoue, la base garde l'ancienne taille : la synchronisation relira le fichier et rétablira les valeurs.
    let metadata = fs::metadata(&path).map_err(|error| format!("Fichier introuvable après l'écriture : {error}"))?;
    let tx = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    tx.execute("UPDATE photos SET file_size = ?, modified = ? WHERE id = ?", params![metadata.len() as i64, library_sync::modified_millis(&metadata), id])
        .map_err(|error| error.to_string())?;
    if let Some(rating) = rating {
        tx.execute("UPDATE photos SET rating = ? WHERE id = ?", params![rating, id]).map_err(|error| error.to_string())?;
    }
    if let Some(flag) = color_flag {
        tx.execute("UPDATE photos SET color_flag = ? WHERE id = ?", params![exif::normalize_color_flag(&flag), id]).map_err(|error| error.to_string())?;
    }
    if let Some(pick) = pick {
        tx.execute("UPDATE photos SET pick_flag = ? WHERE id = ?", params![pick, id]).map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}

/// Photo turned by `rotate_photos`: its new `view_fix` (see orientation::Resolved), which the interface applies to the original it shows.
#[derive(serde::Serialize)]
struct RotatedPhoto {
    id: i64,
    view_fix: u32,
}

#[derive(serde::Serialize)]
struct RotationResult {
    written: Vec<RotatedPhoto>,
    failed: Vec<MarkingFailure>,
    /// Photos left untouched because the task was stopped.
    cancelled: usize,
}

/// Lossless rotation of a batch of photos by `quarter_turns` (1: clockwise, -1: counterclockwise, 2: 180°): only the orientation tag changes
/// (see orientation.rs). Undoing is the opposite rotation, which gives back the exact previous value. Direct command, or task of the queue with
/// `task_id` (progress and stop), like `update_photos_marking`.
#[tauri::command]
async fn rotate_photos(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    photos: Vec<MarkingTarget>,
    quarter_turns: i32,
    task_id: Option<String>,
) -> Result<RotationResult, String> {
    if quarter_turns.rem_euclid(4) == 0 { return Ok(RotationResult { written: Vec::new(), failed: Vec::new(), cancelled: 0 }); }
    let pool = state.pool();
    let dirs = ImageCacheDirs::of(&state);
    let cancel = task_id.as_deref().map(scan_cancel_flag);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || -> Result<RotationResult, String> {
        let total = photos.len().max(1);
        let done = AtomicUsize::new(0);
        let threads = rayon::ThreadPoolBuilder::new().num_threads(3).build().map_err(|error| error.to_string())?;
        let outcomes: Vec<(MarkingTarget, Option<Result<u32, String>>)> = threads.install(|| {
            photos
                .into_par_iter()
                .map(|photo| {
                    if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::SeqCst)) { return (photo, None); }
                    let result = rotate_photo(&pool, &dirs, photo.id, &photo.path, quarter_turns);
                    let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
                    if let Some(id) = &worker_task_id {
                        let _ = app.emit("scan-progress", ScanProgress { task_id: id.clone(), percent: (finished * 100 / total) as u32 });
                    }
                    (photo, Some(result))
                })
                .collect()
        });
        let mut result = RotationResult { written: Vec::new(), failed: Vec::new(), cancelled: 0 };
        for (photo, outcome) in outcomes {
            match outcome {
                None => result.cancelled += 1,
                Some(Ok(view_fix)) => result.written.push(RotatedPhoto { id: photo.id, view_fix }),
                Some(Err(error)) => result.failed.push(MarkingFailure { photo_id: photo.id, path: photo.path, error }),
            }
        }
        Ok(result)
    })
    .await;
    if let Some(id) = &task_id { release_scan_cancel_flag(id); }
    outcome.map_err(|error| error.to_string())?
}

/// Rotation of one photo: tag written, read back, cached images dropped (they are oriented), then catalog. Returns the new `view_fix`.
fn rotate_photo(pool: &DbPool, dirs: &ImageCacheDirs, id: i64, path: &str, quarter_turns: i32) -> Result<u32, String> {
    let source = Path::new(path);
    if !orientation::is_rotatable(source) { return Err("Rotation sans perte impossible pour ce format (HEIC, HEIF, vidéo)".into()); }
    // Internal writer reading the EXIF tag first: the XMP it would write could not change what is displayed. Refused before writing anything.
    if orientation::kind_of(source) == orientation::Kind::Jpeg && !exiftool::is_enabled() && !exiftool::skip_exif_metadata()
        && thumbnails::exif_orientation(source).is_some()
    {
        return Err("L'orientation EXIF de ce JPEG l'emporte sur le XMP : utilisez ExifTool, ou cochez « Ne pas lire les métadonnées EXIF » (Paramètres > Métadonnées)".into());
    }
    let wanted = orientation::rotate(orientation::read(source).stored, quarter_turns);
    let _priority = semantic::PriorityGuard::new(); // like every metadata write (keep_cached_images): the semantic scan waits meanwhile
    let cached_before = [thumbnail_cache_file(&dirs.thumbnails, path).ok(), raw_preview_cache_file(&dirs.raw_previews, path).ok()];
    orientation::write(source, wanted).map_err(|error| error.to_string())?;
    // The thumbnail and the preview are stored turned: both are dropped, under the old name (file rewritten) and the current one (sidecar
    // written, same file name), to be generated again on the next display.
    let cached_after = [thumbnail_cache_file(&dirs.thumbnails, path).ok(), raw_preview_cache_file(&dirs.raw_previews, path).ok()];
    for file in cached_before.into_iter().chain(cached_after).flatten() { let _ = fs::remove_file(file); }
    // Read back before the catalog is updated: a value that did not land where it is read is a failure, never shown as written.
    let after = orientation::read(source);
    if after.stored != wanted { return Err(format!("Orientation relue différente ({} au lieu de {wanted})", after.stored)); }
    let metadata = fs::metadata(source).map_err(|error| format!("Fichier introuvable après l'écriture : {error}"))?;
    let conn = pool.get().map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE photos SET orientation = ?1, view_fix = ?2, file_size = ?3, modified = ?4 WHERE id = ?5",
        params![after.stored, after.view_fix, metadata.len() as i64, library_sync::modified_millis(&metadata), id],
    )
    .map_err(|error| error.to_string())?;
    Ok(after.view_fix)
}

#[derive(serde::Serialize)]
struct FileFailure {
    path: String,
    error: String,
}

#[derive(serde::Serialize)]
struct DeleteResult {
    deleted: Vec<String>,
    failed: Vec<FileFailure>,
}

#[derive(serde::Serialize)]
struct CopyResult {
    copied: usize,
    // Fichiers laissés de côté sur choix de l'utilisateur (« Passer » à la question du fichier existant).
    skipped: usize,
    failed: Vec<FileFailure>,
    /// Photos copied under another name because of a sidecar already there, and the log listing them.
    renamed_for_sidecar: Vec<SidecarRename>,
    log_path: Option<String>,
}

// Fichier à copier dont le nom existe déjà dans le dossier de destination : de quoi poser la question à l'utilisateur (tailles, dates en millisecondes).
#[derive(serde::Serialize)]
struct CopyConflict {
    path: String,
    name: String,
    source_size: u64,
    source_modified: i64,
    target_size: u64,
    target_modified: i64,
}

#[derive(serde::Serialize)]
struct MovedFile {
    from: String,
    to: String,
}

#[derive(serde::Serialize)]
struct MoveResult {
    moved: Vec<MovedFile>,
    // Photos déjà dans le dossier de destination : ni déplacées, ni en échec.
    skipped: usize,
    failed: Vec<FileFailure>,
    /// Photos moved under another name because of a sidecar already there, and the log listing them.
    renamed_for_sidecar: Vec<SidecarRename>,
    log_path: Option<String>,
}

// Contenu de la fenêtre « Infos » du menu contextuel : fichier, EXIF, XMP et IPTC.
#[tauri::command(async)]
fn get_photo_details(path: String) -> exif::MetadataDetails {
    exif::read_metadata_details(Path::new(&path))
}

// Sidecar XMP à supprimer avec une photo. « photo.jpg.xmp » (extension complète + .xmp) appartient à ce seul fichier. « photo.xmp » (nom compatible
// digiKam, dernière extension remplacée) peut être partagé avec une paire RAW + JPEG : il n'est supprimé que si aucun autre fichier de même nom
// (hors .xmp) n'existe dans le dossier. Un « IMG.2024.cr2 » ne vise donc jamais « IMG.xmp ».
fn sidecar_to_trash(photo: &Path) -> Option<PathBuf> {
    let [appended, compatible] = exif::sidecar_candidates(photo);
    if appended.is_file() { return Some(appended); }
    if !compatible.is_file() { return None; }
    if has_same_stem_sibling(photo)? { None } else { Some(compatible) }
}

// Shared « photo.xmp » detection: see exif::has_same_stem_sibling.
use exif::has_same_stem_sibling;

// Nom de fichier ou de dossier saisi par l'utilisateur : un seul niveau, sans caractère interdit par Windows (le même nom reste valide sous Linux et
// macOS), ni point ou espace final, ni nom réservé de Windows (« CON », « NUL »…, avec ou sans extension).
fn validate_new_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() { return Err("Le nom ne peut pas être vide".into()); }
    if name.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c)) {
        return Err("Le nom ne peut pas contenir les caractères \\ / : * ? \" < > |".into());
    }
    if name.ends_with('.') { return Err("Le nom ne peut pas se terminer par un point".into()); }
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
    let before_dot = name.split('.').next().unwrap_or("").trim_end().to_uppercase();
    if reserved.contains(&before_dot.as_str()) { return Err(format!("« {name} » est un nom réservé par Windows")); }
    Ok(name)
}

/// True if both paths exist and are the very same file or folder: a case-only rename on Windows or macOS (`img.jpg` -> `IMG.jpg`), which is
/// valid. Compared by the paths the system resolves, not by the names: on Linux, `IMG.jpg` next to `img.jpg` is another file, never replaced.
fn same_existing_file(first: &Path, second: &Path) -> bool {
    matches!((fs::canonicalize(first), fs::canonicalize(second)), (Ok(a), Ok(b)) if a == b)
}

/// Creates `path` empty, only if nothing is there (atomic): the name is ours until a rename or copy replaces this placeholder. A file that
/// appears between a check and the rename can no longer be overwritten.
fn reserve_new_file(path: &Path) -> std::io::Result<()> {
    fs::OpenOptions::new().write(true).create_new(true).open(path).map(|_| ())
}

// Renomme une photo dans son dossier (l'extension est conservée : « IMG.2024.cr2 » + « vacances » -> « vacances.cr2 »). Son sidecar suit : « photo.jpg.xmp »
// devient « nouveau.jpg.xmp » ; un « photo.xmp » partagé avec un autre fichier du même nom (paire RAW + JPEG) est copié, sinon renommé en « nouveau.xmp ».
// Jamais d'écrasement. Comme pour un déplacement, la ligne de la base garde son id (note, couleur, mots-clés) et les miniatures en cache suivent le nouveau chemin.
#[tauri::command(async)]
fn rename_photo(state: State<'_, AppState>, path: String, new_name: String) -> Result<MovedFile, String> {
    let new_stem = validate_new_name(&new_name)?;
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let tracked: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM photos WHERE path = ?)", params![path], |row| row.get(0))
        .map_err(|error| format!("Catalogue illisible : {error}"))?;
    if !tracked { return Err("Photo absente du catalogue".into()); }
    let source = Path::new(&path);
    // Same per-file lock as metadata writes: a write in progress ends before the rename, a later one finds the file gone (never a sidecar
    // recreated under the old name).
    let _write_guard = exiftool::path_lock(source);
    if !source.is_file() { return Err("Fichier introuvable".into()); }
    let parent = source.parent().ok_or("Dossier introuvable")?;
    let new_file_name = match source.extension() {
        Some(extension) => format!("{new_stem}.{}", extension.to_string_lossy()),
        None => new_stem.to_string(),
    };
    let target = parent.join(&new_file_name);
    if target == source { return Ok(MovedFile { from: path.clone(), to: path }); }
    let case_only = same_existing_file(source, &target);
    let already_there = || format!("« {new_file_name} » existe déjà dans ce dossier");
    if target.exists() && !case_only { return Err(already_there()); }

    // Sidecar : (ancien, nouveau, copie seule). Vérifié avant de toucher à la photo, pour ne rien renommer si le sidecar ne peut pas suivre.
    let appended = PathBuf::from(format!("{}.xmp", source.display()));
    let sidecar = if appended.is_file() {
        Some((appended, PathBuf::from(format!("{}.xmp", target.display())), false))
    } else {
        let compatible = source.with_extension("xmp");
        if compatible.is_file() {
            let shared = has_same_stem_sibling(source).unwrap_or(true);
            Some((compatible, target.with_extension("xmp"), shared))
        } else {
            None
        }
    };
    let sidecar_there = |to: &Path| format!("Le sidecar XMP « {} » existe déjà", to.file_name().unwrap_or_default().to_string_lossy());
    if let Some((from, to, copy_only)) = &sidecar {
        if !copy_only && to.exists() && !same_existing_file(from, to) { return Err(sidecar_there(to)); }
    }

    let thumbnails_dir = state.thumbnails_dir();
    let raw_previews_dir = state.raw_previews_dir();
    let cache_file = thumbnail_cache_file(&thumbnails_dir, &path).ok();
    let raw_preview_file = raw_preview_cache_file(&raw_previews_dir, &path).ok();

    // New names reserved first (empty placeholders, removed on failure): nothing that appears after the checks above is ever overwritten.
    if !case_only {
        reserve_new_file(&target).map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => already_there(),
            _ => format!("Renommage impossible : {error}"),
        })?;
    }
    // Sidecar name reserved too (None: no sidecar, or a case-only rename). Already taken: an error, except for a shared `photo.xmp` that
    // the pair already has under the new name (nothing to copy).
    let sidecar_reserved = match &sidecar {
        Some((from, to, copy_only)) if !same_existing_file(from, to) => match reserve_new_file(to) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && *copy_only => false,
            Err(error) => {
                if !case_only { let _ = fs::remove_file(&target); }
                return Err(if error.kind() == std::io::ErrorKind::AlreadyExists { sidecar_there(to) } else { format!("Sidecar XMP non renommé : {error}") });
            }
        },
        _ => false,
    };
    if let Err(error) = fs::rename(source, &target) {
        if !case_only { let _ = fs::remove_file(&target); }
        if let (true, Some((_, to, _))) = (sidecar_reserved, &sidecar) { let _ = fs::remove_file(to); }
        return Err(format!("Renommage impossible : {error}"));
    }
    if let Some((from, to, copy_only)) = sidecar {
        let result = match (copy_only, sidecar_reserved) {
            (true, true) => fs::copy(&from, &to).map(|_| ()),
            (true, false) => Ok(()),
            (false, _) => fs::rename(&from, &to),
        };
        if let Err(error) = result {
            // Photo et sidecar doivent rester ensemble : la photo reprend son nom (libre : elle vient de le quitter).
            if sidecar_reserved { let _ = fs::remove_file(&to); }
            let _ = fs::rename(&target, source);
            return Err(format!("Sidecar XMP non renommé : {error}"));
        }
    }

    let new_path = target.to_string_lossy().into_owned();
    carry_cache_file(cache_file, thumbnail_cache_file(&thumbnails_dir, &new_path).ok());
    carry_cache_file(raw_preview_file, raw_preview_cache_file(&raw_previews_dir, &new_path).ok());
    let updated = conn.unchecked_transaction().and_then(|tx| {
        tx.execute("DELETE FROM photos WHERE path = ?", params![new_path])?;
        tx.execute("UPDATE photos SET path = ?, filename = ? WHERE path = ?", params![new_path, new_file_name, path])?;
        tx.commit()
    });
    updated.map_err(|error| format!("Fichier renommé en {new_path}, mais catalogue non mis à jour : {error}"))?;
    Ok(MovedFile { from: path, to: new_path })
}

// Renomme un dossier de l'arborescence (sous-dossier d'un dossier suivi) sur place. Les photos qu'il contient (sous-dossiers compris) gardent leur ligne dans
// la base (id, note, couleur, mots-clés) avec leur nouveau chemin, et leurs miniatures en cache suivent. Renvoie les anciens et nouveaux chemins des photos.
// Mêmes refus que delete_folder : dossier suivi (ou qui en contient un), dossier des données de l'application. Jamais d'écrasement.
#[tauri::command(async)]
fn rename_folder(state: State<'_, AppState>, path: String, new_name: String) -> Result<Vec<MovedFile>, String> {
    let new_name = validate_new_name(&new_name)?;
    let pool = state.pool();
    let folder = resolve_tracked_folder(&pool, &path).ok_or_else(|| format!("Dossier non suivi : {path}"))?;
    if !folder.is_dir() { return Err(format!("Dossier introuvable : {path}")); }
    let parent = folder.parent().ok_or("Une racine de disque ne peut pas être renommée")?;
    let folder_segments = lowercase_segments(&folder);
    if lowercase_segments(&state.base_dir()).starts_with(&folder_segments) {
        return Err("Ce dossier contient les données de l'application (base de données et miniatures)".into());
    }
    if db::get_folders(&pool).iter().any(|root| lowercase_segments(Path::new(&root.path)).starts_with(&folder_segments)) {
        return Err("Ce dossier est un dossier suivi, ou en contient un : renommez-le hors de l'application après l'avoir retiré de la liste des dossiers (Paramètres)".into());
    }
    let target = parent.join(new_name);
    if target.exists() && !same_existing_file(&folder, &target) { return Err(format!("« {new_name} » existe déjà dans ce dossier")); }
    if target == folder { return Ok(Vec::new()); }

    let conn = pool.get().map_err(|error| error.to_string())?;
    let prefix = format!("{}/", folder.to_string_lossy().replace('\\', "/").trim_end_matches('/'));
    let prefix_len = prefix.chars().count();
    let photo_paths: Vec<String> = {
        let mut statement = conn
            .prepare("SELECT path FROM photos WHERE lower(substr(replace(path, char(92), '/'), 1, length(?1))) = lower(?1)")
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![prefix], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
        rows.filter_map(|row| row.ok()).collect()
    };
    // Nouveau chemin de chaque photo : le dernier niveau du dossier est remplacé dans le chemin tel qu'enregistré (séparateurs et casse du reste conservés).
    let renamed: Vec<MovedFile> = photo_paths.into_iter().filter_map(|old| {
        let chars: Vec<char> = old.chars().collect();
        let folder_part: String = chars[..prefix_len.min(chars.len())].iter().collect();
        let separator = folder_part.chars().last()?;
        let head = folder_part[..folder_part.trim_end_matches(['/', '\\']).rfind(['/', '\\'])? + 1].to_string();
        let rest: String = chars[prefix_len.min(chars.len())..].iter().collect();
        Some(MovedFile { to: format!("{head}{new_name}{separator}{rest}"), from: old })
    }).collect();

    // Les noms des caches dépendent du chemin, de la taille et de la date : anciens noms calculés avant le renommage.
    let thumbnails_dir = state.thumbnails_dir();
    let raw_previews_dir = state.raw_previews_dir();
    let old_caches: Vec<(Option<PathBuf>, Option<PathBuf>)> = renamed.iter()
        .map(|item| (thumbnail_cache_file(&thumbnails_dir, &item.from).ok(), raw_preview_cache_file(&raw_previews_dir, &item.from).ok()))
        .collect();

    let native: PathBuf = folder.components().collect();
    fs::rename(&native, &target).map_err(|error| format!("Renommage impossible : {error}"))?;

    for (item, (thumbnail, raw_preview)) in renamed.iter().zip(old_caches) {
        carry_cache_file(thumbnail, thumbnail_cache_file(&thumbnails_dir, &item.to).ok());
        carry_cache_file(raw_preview, raw_preview_cache_file(&raw_previews_dir, &item.to).ok());
    }
    let updated = conn.unchecked_transaction().and_then(|tx| {
        {
            let mut delete = tx.prepare_cached("DELETE FROM photos WHERE path = ?")?;
            let mut update = tx.prepare_cached("UPDATE photos SET path = ?, filename = ? WHERE path = ?")?;
            for item in &renamed {
                let name = Path::new(&item.to).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
                delete.execute(params![item.to])?;
                update.execute(params![item.to, name, item.from])?;
            }
        }
        tx.commit()
    });
    updated.map_err(|error| format!("Dossier renommé, mais catalogue non mis à jour : {error}"))?;
    Ok(renamed)
}

// Suppression vers la corbeille de l'OS (crate `trash`) : le fichier est restaurable depuis la corbeille. Seules les photos du catalogue
// peuvent être supprimées. La photo disparaît du catalogue, avec sa miniature en cache ; son sidecar .xmp part à la corbeille avec elle.
// Si le fichier n'est pas mis à la corbeille (erreur), la photo reste dans le catalogue et l'échec est signalé : jamais de suppression définitive de repli.
#[tauri::command(async)]
fn delete_photos(state: State<'_, AppState>, paths: Vec<String>) -> Result<DeleteResult, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    let thumbnails_dir = state.thumbnails_dir();
    let raw_previews_dir = state.raw_previews_dir();

    for path in paths {
        let tracked: bool = match conn.query_row("SELECT EXISTS(SELECT 1 FROM photos WHERE path = ?)", params![path], |row| row.get(0)) {
            Ok(tracked) => tracked,
            Err(error) => {
                failed.push(FileFailure { path, error: format!("Catalogue illisible : {error}") });
                continue;
            }
        };
        if !tracked {
            failed.push(FileFailure { path, error: "Photo absente du catalogue".into() });
            continue;
        }

        // Calcule les chemins du cache miniature et preview RAW dans le bon dossier
        let cache_file = thumbnail_cache_file(&thumbnails_dir, &path).ok();
        let raw_preview_file = raw_preview_cache_file(&raw_previews_dir, &path).ok();

        // Fichier déjà absent (supprimé hors de l'application) : rien à mettre à la corbeille, on retire simplement la photo du catalogue.
        if Path::new(&path).exists() {
            let _write_guard = exiftool::path_lock(Path::new(&path)); // see rename_photo
            // Sidecar repéré avant la mise à la corbeille : la recherche d'un fichier frère a besoin que l'original soit encore là.
            let sidecar = sidecar_to_trash(Path::new(&path));
            if let Err(error) = trash::delete(&path) {
                failed.push(FileFailure { path, error: error.to_string() });
                continue;
            }
            // Le sidecar suit son fichier à la corbeille (restaurable aussi). Échec sans gravité : la photo, elle, est bien supprimée.
            if let Some(sidecar) = sidecar { let _ = trash::delete(sidecar); }
        }

        // Le fichier est à la corbeille : la photo doit quitter le catalogue. Si ce n'est pas possible, l'échec est signalé (jamais de succès
        // annoncé pour une photo qui reste dans la liste) ; la synchronisation retirera la ligne dont le fichier a disparu.
        if let Err(error) = conn.execute("DELETE FROM photos WHERE path = ?", params![path]) {
            failed.push(FileFailure { path, error: format!("Fichier mis à la corbeille, mais photo non retirée du catalogue : {error}") });
            continue;
        }

        // Nettoyage des caches correspondants
        if let Some(cache_file) = cache_file { let _ = fs::remove_file(cache_file); }
        if let Some(raw_preview_file) = raw_preview_file { let _ = fs::remove_file(raw_preview_file); }
        deleted.push(path);
    }
    Ok(DeleteResult { deleted, failed })
}

// Windows : la corbeille n'existe que sur les disques fixes (HDD et SSD, y compris les disques externes que Windows voit comme fixes). Une clé USB (support
// « amovible »), un lecteur ou partage réseau (lettre mappée ou chemin UNC), un CD/DVD ou un disque RAM n'en ont pas : la suppression y est définitive.
// Linux et macOS : la crate `trash` utilise la corbeille du volume (sous Linux, « .Trash-UID » à la racine d'un volume autre que le dossier personnel).
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq)]
enum WindowsRoot {
    Unc,
    Drive(String),
    Other,
}

// Lecteur (« D:\ ») ou partage UNC d'un chemin, avec « / » ou « \ » et préfixes « \\?\ » acceptés.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_root(path: &str) -> WindowsRoot {
    let normalized = path.replace('/', "\\");
    let normalized = if let Some(rest) = normalized.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = normalized.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        normalized.clone()
    };
    if normalized.starts_with("\\\\") { return WindowsRoot::Unc; }
    let mut characters = normalized.chars();
    match (characters.next(), characters.next()) {
        (Some(letter), Some(':')) if letter.is_ascii_alphabetic() => WindowsRoot::Drive(format!("{letter}:\\")),
        _ => WindowsRoot::Other,
    }
}

#[cfg(windows)]
fn has_trash(path: &str) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDriveTypeW(root_path_name: *const u16) -> u32;
    }
    match windows_root(path) {
        WindowsRoot::Unc => false,
        WindowsRoot::Drive(root) => {
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            // 2 = amovible (clé USB), 4 = réseau, 5 = CD/DVD, 6 = disque RAM. Les autres cas (fixe, inconnu) sont considérés avec corbeille.
            !matches!(unsafe { GetDriveTypeW(wide.as_ptr()) }, 2 | 4 | 5 | 6)
        }
        WindowsRoot::Other => true,
    }
}

#[cfg(not(windows))]
fn has_trash(_path: &str) -> bool {
    true
}

// Nombre de ces chemins (fichiers ou dossiers) que la suppression n'enverra PAS à la corbeille mais effacera définitivement, d'après leur support (voir has_trash).
// L'interface s'en sert pour afficher le bon message de confirmation. Ne touche pas au disque (sauf la question du type de lecteur à Windows).
#[tauri::command(async)]
fn count_permanent_deletions(paths: Vec<String>) -> usize {
    paths.iter().filter(|path| !has_trash(path)).count()
}

// Vrai si le dossier ne contient aucun fichier (sous-dossiers vides acceptés). Fichiers cachés compris, sauf les fichiers que l'OS recrée seul
// (Thumbs.db, desktop.ini, .DS_Store) : un dossier qui n'en contient que ces fichiers est considéré comme vide. Sert à adapter le message de suppression.
#[tauri::command(async)]
fn is_folder_empty(state: State<'_, AppState>, path: String) -> Result<bool, String> {
    let pool = state.pool();
    let folder = resolve_tracked_folder(&pool, &path).ok_or_else(|| format!("Dossier non suivi : {path}"))?;
    if !folder.is_dir() { return Err(format!("Dossier introuvable : {path}")); }
    let has_content = WalkDir::new(&folder).into_iter().filter_map(|e| e.ok()).any(|entry| {
        if entry.file_type().is_dir() { return false; }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        !matches!(name.as_str(), "thumbs.db" | "desktop.ini" | ".ds_store")
    });
    Ok(!has_content)
}

// Recense les fichiers présents dans le dossier qui ne sont ni des photos/vidéos gérées par l'application,
// ni des sidecars .xmp associés, ni des fichiers systèmes cachés (Thumbs.db, desktop.ini).
#[tauri::command(async)]
fn get_folder_unrecognized_files(state: State<'_, AppState>, path: String) -> Result<Vec<String>, String> {
    let pool = state.pool();
    let folder = resolve_tracked_folder(&pool, &path).ok_or_else(|| format!("Dossier non suivi : {path}"))?;
    if !folder.is_dir() { return Err(format!("Dossier introuvable : {path}")); }
    let mut unrecognized = Vec::new();
    for entry in WalkDir::new(&folder).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let entry_path = entry.path();
        let file_name = entry.file_name().to_string_lossy();
        let lower_name = file_name.to_ascii_lowercase();
        // 1. Ignorer les fichiers systèmes courants
        if lower_name == "thumbs.db" || lower_name == "desktop.ini" || lower_name == ".ds_store" {
            continue;
        }
        // 2. Ignorer les photos et vidéos prises en charge
        if library_sync::is_photo_file(entry_path) {
            continue;
        }
        // 3. Ignorer les métadonnées sidecars .xmp
        if entry_path.extension().map_or(false, |ext| ext.eq_ignore_ascii_case("xmp")) {
            continue;
        }
        // Fichier non géré : on conserve le chemin relatif par rapport au dossier pour un affichage lisible
        let rel_path = entry_path.strip_prefix(&folder)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| file_name.to_string());
        unrecognized.push(rel_path);
    }
    unrecognized.sort();
    Ok(unrecognized)
}

// Supprime un dossier de l'arborescence (sous-dossier d'un dossier suivi) vers la corbeille de l'OS, avec tout son contenu : sous-dossiers et
// fichiers de tout type, pas seulement les photos. Il reste restaurable depuis la corbeille quand le support en a une (voir count_permanent_deletions). Comme pour
// delete_photos, aucun repli automatique vers une suppression définitive : si la mise à la corbeille échoue, le catalogue n'est pas touché et l'erreur est renvoyée.
// Ensuite, les photos du dossier quittent le catalogue (avec leurs caches de miniatures) ; leurs chemins sont renvoyés.
// Refusé pour un dossier suivi (celui des Paramètres), pour un dossier qui en contient un, et pour un dossier qui contient les données de l'application.
// La sélection des photos se fait sur le chemin complet avec séparateur final : supprimer « D:\Photos » ne touche pas « D:\Photos2 ».
#[tauri::command(async)]
fn delete_folder(state: State<'_, AppState>, path: String) -> Result<Vec<String>, String> {
    let pool = state.pool();
    let folder = resolve_tracked_folder(&pool, &path).ok_or_else(|| format!("Dossier non suivi : {path}"))?;
    if !folder.is_dir() { return Err(format!("Dossier introuvable : {path}")); }
    if folder.parent().is_none() { return Err("Une racine de disque ne peut pas être supprimée".into()); }
    let folder_segments = lowercase_segments(&folder);
    if lowercase_segments(&state.base_dir()).starts_with(&folder_segments) {
        return Err("Ce dossier contient les données de l'application (base de données et miniatures)".into());
    }

    // Un dossier suivi se retire de la liste des Paramètres, il ne se supprime pas d'ici ; idem pour un dossier qui en contient un (il serait supprimé avec).
    if db::get_folders(&pool).iter().any(|root| lowercase_segments(Path::new(&root.path)).starts_with(&folder_segments)) {
        return Err("Ce dossier est un dossier suivi, ou en contient un : retirez-le d'abord de la liste des dossiers (Paramètres)".into());
    }

    let conn = pool.get().map_err(|error| error.to_string())?;
    let prefix = format!("{}/", folder.to_string_lossy().replace('\\', "/").trim_end_matches('/'));
    const IN_FOLDER: &str = "lower(substr(replace(path, char(92), '/'), 1, length(?1))) = lower(?1)";
    let photo_paths: Vec<String> = {
        let mut statement = conn
            .prepare(&format!("SELECT path FROM photos WHERE {IN_FOLDER}"))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![prefix], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.filter_map(|row| row.ok()).collect()
    };

    // Les noms des caches dépendent de la taille et de la date des fichiers : à calculer avant la mise à la corbeille.
    let thumbnails_dir = state.thumbnails_dir();
    let raw_previews_dir = state.raw_previews_dir();
    let cache_files: Vec<PathBuf> = photo_paths
        .iter()
        .flat_map(|photo| [thumbnail_cache_file(&thumbnails_dir, photo).ok(), raw_preview_cache_file(&raw_previews_dir, photo).ok()])
        .flatten()
        .collect();

    // Chemin natif (séparateurs de l'OS) : le dossier suivi peut avoir été enregistré avec des « / », que la corbeille de Windows n'accepte pas toujours.
    let native: PathBuf = folder.components().collect();
    trash::delete(&native).map_err(|error| format!("Mise à la corbeille impossible : {error}"))?;

    // Le dossier n'existe plus : le nettoyage du catalogue ne doit plus faire échouer l'opération (la synchronisation rattraperait un reste éventuel).
    for cache_file in cache_files { let _ = fs::remove_file(cache_file); }
    let _ = conn.execute(&format!("DELETE FROM photos WHERE {IN_FOLDER}"), params![prefix]);
    Ok(photo_paths)
}

// Un dossier suivi est « joignable » s'il existe, ou si son dossier parent existe (dossier supprimé ou renommé hors de l'application).
// Un disque externe débranché ou un partage réseau coupé n'est donc jamais pris pour une suppression de photos.
fn tracked_root_is_reachable(root: &str) -> bool {
    let root = Path::new(root);
    root.is_dir() || root.parent().map_or(false, |parent| parent.is_dir())
}

fn is_inside_folder(folder: &str, path: &str) -> bool {
    let normalize = |value: &str| value.replace('\\', "/").trim_end_matches('/').to_lowercase();
    normalize(path).starts_with(&format!("{}/", normalize(folder)))
}

// Synchronisation « paresseuse » avec le disque : l'interface signale les photos qu'elle n'arrive pas à afficher
// (miniature impossible à générer, image qui ne se charge pas). Celles dont le fichier a réellement disparu sont retirées
// du catalogue, et la liste des chemins retirés est renvoyée. Un fichier présent mais illisible est conservé, et rien n'est
// retiré si le dossier suivi est injoignable. Le sidecar .xmp et le cache de miniatures ne sont pas touchés (le nom d'une miniature
// dépend de la taille et de la date du fichier, qui ne sont plus connues).
#[tauri::command(async)]
fn remove_missing_photos(state: State<'_, AppState>, paths: Vec<String>) -> Result<Vec<String>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let reachable_roots: Vec<String> = db::get_folders(&pool)
        .into_iter()
        .map(|folder| folder.path)
        .filter(|root| tracked_root_is_reachable(root))
        .collect();
    let mut removed = Vec::new();
    for path in paths {
        let missing = matches!(fs::metadata(&path), Err(error) if error.kind() == std::io::ErrorKind::NotFound);
        if !missing || !reachable_roots.iter().any(|root| is_inside_folder(root, &path)) { continue; }
        conn.execute("DELETE FROM photos WHERE path = ?", params![path]).map_err(|error| error.to_string())?;
        removed.push(path);
    }
    Ok(removed)
}

// Synchronisation incrémentale avec le disque (voir library_sync.rs) : fichiers ajoutés, modifiés ou supprimés hors de l'application.
// Exécutée hors du thread principal et hors des threads asynchrones ; l'interface la lance au démarrage et au retour de focus.
#[tauri::command]
// `excluded`: folders of paused scans, left for the scan to read when it is resumed.
async fn sync_library(state: State<'_, AppState>, excluded: Option<Vec<String>>) -> Result<library_sync::SyncChanges, String> {
    let pool = state.pool();
    tokio::task::spawn_blocking(move || {
        let _priority = semantic::PriorityGuard::new();
        library_sync::sync_library(&pool, &excluded.unwrap_or_default())
    })
        .await
        .map_err(|error| error.to_string())?
}

// Réserve dans le dossier de destination le premier nom libre (« photo.jpg », puis « photo (1).jpg », « photo (2).jpg »…) en y créant un fichier vide :
// la création est atomique (`create_new`), donc deux tâches ou un autre programme n'obtiennent jamais le même nom, et rien n'est jamais écrasé.
// L'appelant remplace ensuite ce fichier vide (copie, renommage) et le supprime s'il échoue : il lui appartient.
/// True if a sidecar would attach to `candidate` (not created yet) although it does not belong to it: `candidate.ext.xmp` (left behind by a
/// deleted or renamed file), or a `photo.xmp` with no image of the same name next to it. A `photo.xmp` next to `photo.cr2` belongs to that
/// pair: a JPEG of the same name moved there joins it, as intended.
/// Returns that sidecar.
fn sidecar_already_taken(candidate: &Path) -> Option<PathBuf> {
    let [appended, compatible] = exif::sidecar_candidates(candidate);
    if appended.exists() { return Some(appended); }
    (compatible.exists() && !has_same_stem_sibling(candidate).unwrap_or(false)).then_some(compatible)
}

/// Name reserved by reserve_destination, and the sidecar that made the first choices unusable (to report: the photo gets another name).
struct Reserved {
    path: PathBuf,
    skipped_sidecar: Option<PathBuf>,
}

impl Reserved {
    fn sidecar_rename(&self, source: &str) -> Option<SidecarRename> {
        self.skipped_sidecar.as_ref().map(|sidecar| SidecarRename {
            path: source.to_string(),
            to: self.path.to_string_lossy().into_owned(),
            sidecar: sidecar.to_string_lossy().into_owned(),
        })
    }
}

fn reserve_destination(directory: &Path, file_name: &std::ffi::OsStr) -> std::io::Result<Reserved> {
    let name = Path::new(file_name);
    let stem = name.file_stem().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default();
    let extension = name.extension().map(|value| format!(".{}", value.to_string_lossy())).unwrap_or_default();
    let mut index = 0u32;
    let mut skipped_sidecar = None;
    loop {
        let candidate = if index == 0 { directory.join(file_name) } else { directory.join(format!("{stem} ({index}){extension}")) };
        // A name whose sidecar is already there is skipped too: the moved or copied photo would read that file's metadata as its own,
        // and its own sidecar would not be carried (never overwritten).
        if let Some(sidecar) = sidecar_already_taken(&candidate) {
            skipped_sidecar.get_or_insert(sidecar);
            index += 1;
            continue;
        }
        match fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(_) => return Ok(Reserved { path: candidate, skipped_sidecar }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => index += 1,
            Err(error) => return Err(error),
        }
    }
}

// Copie aussi le sidecar XMP (`photo.jpg.xmp` ou `photo.xmp`) : note, couleur et mots-clés des formats autres que JPEG y sont stockés.
// Un sidecar déjà présent à destination n'est écrasé qu'avec `overwrite` (copie qui remplace un fichier existant, choisie par l'utilisateur).
fn copy_sidecar(source: &Path, target: &Path, overwrite: bool) -> std::io::Result<()> {
    let appended = PathBuf::from(format!("{}.xmp", source.display()));
    let (from, to) = if appended.is_file() {
        (appended, PathBuf::from(format!("{}.xmp", target.display())))
    } else {
        let compatible = source.with_extension("xmp");
        if !compatible.is_file() { return Ok(()); }
        (compatible, target.with_extension("xmp"))
    };
    // Replacing an existing sidecar goes through copy_replacing: a direct copy would first truncate it.
    if overwrite && to.exists() { return copy_replacing(&from, &to); }
    // Name reserved first (F2): an existing sidecar, even one that appeared just now, is never overwritten.
    match reserve_new_file(&to) {
        Ok(()) => fs::copy(&from, &to).map(|_| ()).inspect_err(|_| { let _ = fs::remove_file(&to); }),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

fn lowercase_segments(path: &Path) -> Vec<String> {
    path_segments(&path.to_string_lossy()).into_iter().map(|segment| segment.to_lowercase()).collect()
}

// Vérification des déplacements entre disques (Paramètres > Stockage) : activée par défaut, l'interface envoie le choix mémorisé au démarrage.
static VERIFY_CROSS_DRIVE_MOVES: AtomicBool = AtomicBool::new(true);

#[tauri::command]
fn set_verify_cross_drive_moves(enabled: bool) {
    VERIFY_CROSS_DRIVE_MOVES.store(enabled, Ordering::Relaxed);
}

/// Asks the system to write `path` physically to its disk (data and size), not just to its write cache.
fn flush_to_disk(path: &Path) -> std::io::Result<()> {
    // Linux / macOS: fsync works on a read-only descriptor.
    #[cfg(not(windows))]
    fs::File::open(path)?.sync_all()?;
    // Windows: flushing needs a handle with write access (opened without truncation). A read-only file (attribute kept by fs::copy, frequent
    // for photos copied from a memory card) briefly loses that attribute, which is then restored.
    #[cfg(windows)]
    {
        let open_and_sync = || fs::OpenOptions::new().write(true).open(path).and_then(|file| file.sync_all());
        match open_and_sync() {
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                let permissions = fs::metadata(path)?.permissions();
                if !permissions.readonly() { return Err(error); }
                let mut writable = permissions.clone();
                #[allow(clippy::permissions_set_readonly_false)]
                writable.set_readonly(false);
                fs::set_permissions(path, writable)?;
                let synced = open_and_sync();
                let restored = fs::set_permissions(path, permissions);
                synced?;
                restored?;
            }
            other => other?,
        }
    }
    sync_parent_dir(path);
    Ok(())
}

/// Linux / macOS: a new or renamed file is durable only once its directory entry is, so the folder is flushed too (best effort: some file
/// systems refuse it). Windows (NTFS journal) has no equivalent and needs none.
fn sync_parent_dir(path: &Path) {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(dir) = fs::File::open(parent) { let _ = dir.sync_all(); }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// `fs::copy`, then the copy is flushed to the disk: once this returns, the copy survives a power cut, so the source may be deleted or replaced.
fn copy_durably(source: &Path, target: &Path) -> std::io::Result<u64> {
    let size = fs::copy(source, target)?;
    flush_to_disk(target)?;
    Ok(size)
}

// Somme SHA-256 d'un fichier, lue par blocs (jamais le fichier entier en mémoire).
fn file_sha256(path: &Path) -> std::io::Result<[u8; 32]> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher.finalize().into())
}

fn files_have_same_hash(first: &Path, second: &Path) -> std::io::Result<bool> {
    Ok(file_sha256(first)? == file_sha256(second)?)
}

// Déplace un fichier : renommage, ou copie puis suppression de l'original quand le renommage est impossible (autre disque, par exemple).
// Si la copie réussit mais que l'original ne peut pas être supprimé, la copie est retirée : le fichier n'est jamais dupliqué.
// Avec la vérification activée (Paramètres > Stockage), la copie est relue et comparée à l'original par somme SHA-256 avant toute suppression :
// en cas de différence, la copie est retirée et l'original reste en place.
// The copy is flushed to the disk (copy_durably) before the hash check and before the original is deleted: without it, the copy may still sit
// in the system write cache when the original is gone (power cut, crash, USB drive unplugged), and the hash check would only read that cache.
fn move_file(source: &Path, target: &Path) -> std::io::Result<()> {
    if fs::rename(source, target).is_ok() { return Ok(()); }
    if let Err(error) = copy_durably(source, target) {
        let _ = fs::remove_file(target);
        return Err(error);
    }
    if VERIFY_CROSS_DRIVE_MOVES.load(Ordering::Relaxed) {
        match files_have_same_hash(source, target) {
            Ok(true) => {}
            Ok(false) => {
                let _ = fs::remove_file(target);
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "La copie diffère de l'original : déplacement annulé, l'original est conservé"));
            }
            Err(error) => {
                let _ = fs::remove_file(target);
                return Err(error);
            }
        }
    }
    if let Err(error) = fs::remove_file(source) {
        let _ = fs::remove_file(target);
        return Err(error);
    }
    Ok(())
}

// Sidecar XMP d'une photo déplacée : « photo.jpg.xmp » est déplacé avec elle. Un sidecar « photo.xmp » peut être partagé avec un autre fichier du même nom
// (paire RAW + JPEG) : il est copié et l'original reste en place, pour ne pas priver l'autre fichier de ses métadonnées.
fn move_sidecar(source: &Path, target: &Path) -> std::io::Result<()> {
    let appended = PathBuf::from(format!("{}.xmp", source.display()));
    if appended.is_file() {
        let destination = PathBuf::from(format!("{}.xmp", target.display()));
        // Name reserved (F2): a sidecar that appeared since reserve_destination is never overwritten, it stays where it is.
        match reserve_new_file(&destination) {
            Ok(()) => move_file(&appended, &destination).inspect_err(|_| { let _ = fs::remove_file(&destination); }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error),
        }
    } else {
        copy_sidecar(source, target, false)
    }
}

// Suivi d'une tâche de fichiers (déplacement, copie) lancée depuis la file de l'interface : publie l'avancement dans « scan-progress » (pondéré par la taille
// des fichiers, pour qu'un gros fichier pèse plus qu'une miniature) et relaie la demande d'arrêt, vérifiée entre deux fichiers. Sans `task_id`
// (appel direct), il ne fait rien.
struct FileTaskProgress {
    app: tauri::AppHandle,
    task_id: Option<String>,
    cancel: Option<Arc<AtomicBool>>,
    total: u64,
    done: u64,
}

impl FileTaskProgress {
    fn new(app: tauri::AppHandle, task_id: Option<String>, sources: &[String]) -> Self {
        // Un fichier vide ou illisible compte pour 1 octet : l'avancement progresse tout de même.
        let total = sources.iter().map(|path| fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0).max(1)).sum::<u64>().max(1);
        let cancel = task_id.as_deref().map(scan_cancel_flag);
        Self { app, task_id, cancel, total, done: 0 }
    }

    fn cancelled(&self) -> bool {
        self.cancel.as_ref().map_or(false, |flag| flag.load(Ordering::Relaxed))
    }

    // À appeler après chaque fichier traité (réussi ou non) avec sa taille.
    fn advance(&mut self, size: u64) {
        self.done += size.max(1);
        if let Some(id) = &self.task_id {
            let percent = (self.done.min(self.total) * 100 / self.total) as u32;
            let _ = self.app.emit("scan-progress", ScanProgress { task_id: id.clone(), percent });
        }
    }
}

impl Drop for FileTaskProgress {
    fn drop(&mut self) {
        if let Some(id) = &self.task_id { release_scan_cancel_flag(id); }
    }
}

// Reporte un fichier du cache (miniature, aperçu RAW) sous son nouveau nom après un déplacement de la photo. Sans nouveau nom, ou si le renommage
// échoue, l'ancien fichier est supprimé : il ne serait plus jamais relu.
fn carry_cache_file(old: Option<PathBuf>, new: Option<PathBuf>) {
    let Some(old) = old else { return };
    if !old.is_file() { return; }
    match new {
        // Le nouveau nom peut tomber dans un autre sous-dossier de répartition, éventuellement pas encore créé.
        Some(new) if new != old && new.parent().map_or(true, |parent| fs::create_dir_all(parent).is_ok()) && fs::rename(&old, &new).is_ok() => {}
        _ => { let _ = fs::remove_file(&old); }
    }
}

// Déplace des photos du catalogue vers un dossier de l'arborescence (suivi ou sous-dossier d'un dossier suivi), par glisser-déposer.
// Un fichier de même nom n'est jamais écrasé : le fichier déplacé est renommé (« photo (1).jpg »). La ligne de la base est mise à jour (même id : note,
// couleur et mots-clés sont conservés) et la miniature du cache, qui dépend du chemin, est renommée pour suivre la photo.
// Lancé par la file des tâches (`task_id`) : avancement publié, arrêt possible entre deux fichiers (les fichiers déjà déplacés le restent).
#[tauri::command(async)]
fn move_photos(app: tauri::AppHandle, state: State<'_, AppState>, paths: Vec<String>, destination: String, task_id: Option<String>) -> Result<MoveResult, String> {
    // The semantic scan waits: it would read photos at the paths they are leaving.
    let _priority = semantic::PriorityGuard::new();
    let mut progress = FileTaskProgress::new(app, task_id, &paths);
    let pool = state.pool();
    let destination_dir = resolve_tracked_folder(&pool, &destination).ok_or_else(|| format!("Dossier non suivi : {destination}"))?;
    if !destination_dir.is_dir() { return Err(format!("Dossier de destination introuvable : {destination}")); }
    let conn = pool.get().map_err(|error| error.to_string())?;
    let destination_segments = lowercase_segments(&destination_dir);
    let mut moved = Vec::new();
    let mut skipped = 0;
    let mut failed = Vec::new();
    let mut renamed_for_sidecar = Vec::new();
    let thumbnails_dir = state.thumbnails_dir();
    let raw_previews_dir = state.raw_previews_dir();

    for path in paths {
        if progress.cancelled() { break; } // arrêt demandé : les fichiers suivants restent où ils sont
        let file_size = fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0);
        'file: {
            let tracked: bool = conn
                .query_row("SELECT EXISTS(SELECT 1 FROM photos WHERE path = ?)", params![path], |row| row.get(0))
                .unwrap_or(false);
            if !tracked {
                failed.push(FileFailure { path: path.clone(), error: "Photo absente du catalogue".into() });
                break 'file;
            }
            let source = Path::new(&path);
            let Some(file_name) = source.file_name() else {
                failed.push(FileFailure { path: path.clone(), error: "Nom de fichier invalide".into() });
                break 'file;
            };
            if source.parent().map_or(false, |parent| lowercase_segments(parent) == destination_segments) {
                skipped += 1;
                break 'file;
            }
            let _write_guard = exiftool::path_lock(source); // see rename_photo
            if !source.is_file() {
                failed.push(FileFailure { path: path.clone(), error: "Fichier introuvable".into() });
                break 'file;
            }
            // Destination réservée (fichier vide, voir reserve_destination) : move_file la remplace, ou la supprime s'il échoue.
            let (target, sidecar_rename) = match reserve_destination(&destination_dir, file_name) {
                Ok(reserved) => (reserved.path.clone(), reserved.sidecar_rename(&path)),
                Err(error) => {
                    failed.push(FileFailure { path: path.clone(), error: format!("Destination impossible à créer : {error}") });
                    break 'file;
                }
            };

            let cache_file = thumbnail_cache_file(&thumbnails_dir, &path).ok();
            let raw_preview_file = raw_preview_cache_file(&raw_previews_dir, &path).ok();

            if let Err(error) = move_file(source, &target) {
                failed.push(FileFailure { path: path.clone(), error: error.to_string() });
                break 'file;
            }
            renamed_for_sidecar.extend(sidecar_rename);
            if let Err(error) = move_sidecar(source, &target) {
                // La photo est déplacée mais pas son sidecar XMP : ses métadonnées sont restées à l'ancien emplacement, l'échec est signalé.
                failed.push(FileFailure { path: path.clone(), error: format!("Sidecar XMP non déplacé : {error}") });
            }
            let new_path = target.to_string_lossy().into_owned();
            // Les noms du cache dépendent du chemin : les miniatures existantes sont renommées vers le nouveau nom au lieu d'être régénérées.
            carry_cache_file(cache_file, thumbnail_cache_file(&thumbnails_dir, &new_path).ok());
            carry_cache_file(raw_preview_file, raw_preview_cache_file(&raw_previews_dir, &new_path).ok());

            let new_name = target.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
            let (size, modified) = fs::metadata(&target)
                .map(|metadata| (metadata.len() as i64, library_sync::modified_millis(&metadata)))
                .unwrap_or((0, 0));
            let updated = conn.unchecked_transaction().and_then(|tx| {
                tx.execute("DELETE FROM photos WHERE path = ?", params![new_path])?;
                tx.execute(
                    "UPDATE photos SET path = ?, filename = ?, file_size = ?, modified = ? WHERE path = ?",
                    params![new_path, new_name, size, modified, path],
                )?;
                tx.commit()
            });
            if let Err(error) = updated {
                // Fichier déplacé mais ligne inchangée : la photo n'est pas annoncée déplacée ; la synchronisation retirera l'ancienne ligne et ajoutera le fichier.
                failed.push(FileFailure { path: path.clone(), error: format!("Fichier déplacé vers {new_path}, mais catalogue non mis à jour : {error}") });
                break 'file;
            }
            moved.push(MovedFile { from: path.clone(), to: new_path });
        }
        progress.advance(file_size);
    }
    let log_path = log_sidecar_renames(&state.base_dir(), "move", &renamed_for_sidecar);
    Ok(MoveResult { moved, skipped, failed, renamed_for_sidecar, log_path })
}

// Fichiers à copier dont le nom existe déjà dans `destination` (le fichier de la destination et celui à copier sont décrits pour la question posée à
// l'utilisateur). Une photo copiée dans son propre dossier n'est pas un conflit : la copie y est toujours renommée (« photo (1).jpg »), jamais écrasée.
fn find_copy_conflicts(paths: &[String], destination: &Path) -> Vec<CopyConflict> {
    let destination_segments = lowercase_segments(destination);
    paths.iter().filter_map(|path| {
        let source = Path::new(path);
        let file_name = source.file_name()?;
        if source.parent().is_some_and(|parent| lowercase_segments(parent) == destination_segments) { return None; }
        let target = destination.join(file_name);
        let (source_meta, target_meta) = (fs::metadata(source).ok()?, fs::metadata(&target).ok().filter(|meta| meta.is_file())?);
        Some(CopyConflict {
            path: path.clone(),
            name: file_name.to_string_lossy().into_owned(),
            source_size: source_meta.len(),
            source_modified: library_sync::modified_millis(&source_meta),
            target_size: target_meta.len(),
            target_modified: library_sync::modified_millis(&target_meta),
        })
    }).collect()
}

// Copy that replaces an existing file: written under a temporary name in the destination folder, flushed to the disk, then renamed. A failure
// on the way (full disk…) or a power cut leaves either the old file or the complete new one, never an empty or partial file.
fn copy_replacing(source: &Path, target: &Path) -> std::io::Result<()> {
    let temp = PathBuf::from(format!("{}.photoboggan-tmp", target.display()));
    let result = copy_durably(source, &temp).and_then(|_| fs::rename(&temp, target));
    if result.is_err() { let _ = fs::remove_file(&temp); } else { sync_parent_dir(target); }
    result
}

// Copie des fichiers originaux (pas des miniatures) dans un dossier. Un fichier déjà présent n'est écrasé que si l'utilisateur l'a demandé :
// `resolutions` associe au chemin d'un fichier en conflit « replace » (écraser), « skip » (passer) ou « rename » (copie renommée « photo (1).jpg »,
// aussi le choix par défaut). Une photo copiée dans son propre dossier est toujours renommée. Les dossiers suivis ne sont pas rescannés automatiquement.
// Lancée par la file des tâches (`task_id`) : avancement publié, arrêt possible entre deux fichiers (les fichiers déjà copiés le restent).
fn copy_photos_with_progress(
    paths: Vec<String>,
    destination: &Path,
    resolutions: &std::collections::HashMap<String, String>,
    mut progress: FileTaskProgress,
) -> Result<CopyResult, String> {
    let _priority = semantic::PriorityGuard::new(); // the semantic scan waits while files are copied (disk bound)
    if !destination.is_dir() { return Err(format!("Dossier de destination introuvable : {}", destination.display())); }
    let destination_segments = lowercase_segments(destination);
    let mut copied = 0;
    let mut skipped = 0;
    let mut failed = Vec::new();
    let mut renamed_for_sidecar = Vec::new();
    for path in paths {
        if progress.cancelled() { break; }
        let source = Path::new(&path);
        let file_size = fs::metadata(source).map(|metadata| metadata.len()).unwrap_or(0);
        match source.file_name() {
            None => failed.push(FileFailure { path: path.clone(), error: "Nom de fichier invalide".into() }),
            Some(file_name) => {
                let exact = destination.join(file_name);
                let same_folder = source.parent().is_some_and(|parent| lowercase_segments(parent) == destination_segments);
                let choice = if exact.is_file() && !same_folder { resolutions.get(&path).map(String::as_str).unwrap_or("rename") } else { "rename" };
                if choice == "skip" {
                    skipped += 1;
                } else if choice == "replace" {
                    match copy_replacing(source, &exact) {
                        Ok(()) => {
                            if let Err(error) = copy_sidecar(source, &exact, true) {
                                failed.push(FileFailure { path: path.clone(), error: format!("Sidecar XMP non copié : {error}") });
                            }
                            copied += 1;
                        }
                        Err(error) => failed.push(FileFailure { path: path.clone(), error: error.to_string() }),
                    }
                } else {
                    // Destination réservée atomiquement : la copie ne peut écraser que ce fichier vide, créé par nous (supprimé si la copie échoue).
                    match reserve_destination(destination, file_name) {
                        Err(error) => failed.push(FileFailure { path: path.clone(), error: format!("Destination impossible à créer : {error}") }),
                        Ok(reserved) => match fs::copy(source, &reserved.path) {
                            Ok(_) => {
                                if let Err(error) = copy_sidecar(source, &reserved.path, false) {
                                    failed.push(FileFailure { path: path.clone(), error: format!("Sidecar XMP non copié : {error}") });
                                }
                                renamed_for_sidecar.extend(reserved.sidecar_rename(&path));
                                copied += 1;
                            }
                            Err(error) => {
                                let _ = fs::remove_file(&reserved.path);
                                failed.push(FileFailure { path: path.clone(), error: error.to_string() });
                            }
                        },
                    }
                }
            }
        }
        progress.advance(file_size);
    }
    Ok(CopyResult { copied, skipped, failed, renamed_for_sidecar, log_path: None })
}

// Question « le fichier existe déjà » avant une copie vers un dossier choisi dans la boîte de dialogue de l'OS : liste des fichiers en conflit.
#[tauri::command(async)]
fn copy_conflicts(paths: Vec<String>, destination: String) -> Vec<CopyConflict> {
    find_copy_conflicts(&paths, Path::new(&destination))
}

#[tauri::command(async)]
fn copy_photos(app: tauri::AppHandle, state: State<'_, AppState>, paths: Vec<String>, destination: String, resolutions: Option<std::collections::HashMap<String, String>>, task_id: Option<String>) -> Result<CopyResult, String> {
    let progress = FileTaskProgress::new(app, task_id, &paths);
    let mut result = copy_photos_with_progress(paths, Path::new(&destination), &resolutions.unwrap_or_default(), progress)?;
    result.log_path = log_sidecar_renames(&state.base_dir(), "copy", &result.renamed_for_sidecar);
    Ok(result)
}

// Même question pour une copie par glisser-déposer (dossier suivi ou sous-dossier).
#[tauri::command(async)]
fn tracked_copy_conflicts(state: State<'_, AppState>, paths: Vec<String>, destination: String) -> Result<Vec<CopyConflict>, String> {
    let pool = state.pool();
    let folder = resolve_tracked_folder(&pool, &destination).ok_or_else(|| format!("Dossier non suivi : {destination}"))?;
    Ok(find_copy_conflicts(&paths, &folder))
}

// Copie par glisser-déposer (Ctrl) vers un dossier de l'arborescence : même copie que « Copier vers… » (écrasement seulement sur choix de l'utilisateur,
// sidecar copié), mais la destination doit être un dossier suivi ou l'un de ses sous-dossiers, et son chemin est reconstruit comme pour les autres
// commandes de dossier. Les copies ne sont pas ajoutées au catalogue ici : l'interface lance ensuite la synchronisation incrémentale (sync_library).
#[tauri::command(async)]
fn copy_photos_to_tracked_folder(app: tauri::AppHandle, state: State<'_, AppState>, paths: Vec<String>, destination: String, resolutions: Option<std::collections::HashMap<String, String>>, task_id: Option<String>) -> Result<CopyResult, String> {
    let pool = state.pool();
    let folder = resolve_tracked_folder(&pool, &destination).ok_or_else(|| format!("Dossier non suivi : {destination}"))?;
    let progress = FileTaskProgress::new(app, task_id, &paths);
    let mut result = copy_photos_with_progress(paths, &folder, &resolutions.unwrap_or_default(), progress)?;
    result.log_path = log_sidecar_renames(&state.base_dir(), "copy", &result.renamed_for_sidecar);
    Ok(result)
}

// Redimensionne une photo selon les options de la fenêtre « Redimensionner… » (voir resize.rs) : un appel par photo, l'interface pilote le lot
// (progression, questions en cas de fichier existant) et lance quelques appels en parallèle. Le travail se fait hors du thread principal et des
// threads asynchrones. Le résultat dit si le fichier a été écrit, s'il existait déjà (politique « Ask ») ou s'il a été passé.
#[tauri::command]
async fn resize_photo(path: String, options: resize::ResizeOptions) -> Result<resize::ResizeOutcome, String> {
    tokio::task::spawn_blocking(move || {
        let _priority = semantic::PriorityGuard::new(); // the semantic scan waits while photos are resized
        resize::resize_photo(Path::new(&path), &options)
    })
        .await
        .map_err(|error| error.to_string())?
}

// ---------------------------------------------------------------------------
// Programs allowed for "Open with"
// ---------------------------------------------------------------------------
// open_with only launches a program the user chose in the OS dialog (pick_program, opened by the backend itself), remembered in config.json:
// a script running in the page could otherwise launch any executable. The list only grows (a program removed from the Settings stays
// allowed: the user chose it once).

/// Serialises the read-modify-write of config.json done here.
static PROGRAMS_CONFIG_LOCK: Mutex<()> = Mutex::new(());

fn same_program(first: &str, second: &str) -> bool {
    if cfg!(windows) { first.eq_ignore_ascii_case(second) } else { first == second }
}

fn is_allowed_program(app: &tauri::AppHandle, program: &str) -> bool {
    load_config(app).ok().and_then(|config| config.open_with_programs).is_some_and(|list| list.iter().any(|known| same_program(known, program)))
}

fn allow_programs(app: &tauri::AppHandle, programs: &[String], only_first_time: bool) -> Result<(), String> {
    let _guard = PROGRAMS_CONFIG_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut config = load_config(app)?;
    if only_first_time && config.open_with_programs.is_some() { return Ok(()); }
    let list = config.open_with_programs.get_or_insert_with(Vec::new);
    for program in programs {
        if Path::new(program).is_file() && !list.iter().any(|known| same_program(known, program)) { list.push(program.clone()); }
    }
    save_config(app, &config)
}

/// OS dialog to choose a program, opened by the backend: the chosen program is allowed for open_with. None if the user cancels.
#[tauri::command(async)]
fn pick_program(app: tauri::AppHandle, title: String, filter_name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_title(title);
    // Windows: executables only. Linux / macOS programs have no extension.
    if cfg!(windows) { dialog = dialog.add_filter(filter_name, &["exe", "bat", "cmd", "com"]); }
    if let Some(window) = app.get_webview_window("main") { dialog = dialog.set_parent(&window); }
    let Some(picked) = dialog.blocking_pick_file() else { return Ok(None) };
    let path = picked.into_path().map_err(|error| error.to_string())?.to_string_lossy().into_owned();
    allow_programs(&app, std::slice::from_ref(&path), false)?;
    Ok(Some(path))
}

/// Programs already in the Settings before this check existed: allowed once, at the first start that has no list yet; ignored afterwards.
#[tauri::command(async)]
fn register_existing_programs(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    allow_programs(&app, &paths, true)
}

// Ouvre les fichiers avec un programme externe (liste des Paramètres ou programme choisi dans la boîte de dialogue de l'OS).
#[tauri::command(async)]
fn open_with(app: tauri::AppHandle, program: String, paths: Vec<String>) -> Result<(), String> {
    let program_path = Path::new(&program);
    if !program_path.is_file() { return Err(format!("Programme introuvable : {program}")); }
    if !is_allowed_program(&app, &program) {
        return Err(format!("Programme non autorisé : {program} (choisissez-le de nouveau dans Paramètres > Ouvrir avec)"));
    }
    if let Some(missing) = paths.iter().find(|path| !Path::new(path).is_file()) { return Err(format!("Fichier introuvable : {missing}")); }
    if paths.is_empty() { return Ok(()); }
    std::process::Command::new(program_path).args(&paths).spawn().map(|_| ()).map_err(|error| format!("Impossible de lancer {program} : {error}"))
}

// Affiche le fichier dans le gestionnaire de fichiers par défaut de l'OS : dossier ouvert avec le fichier sélectionné
// (Explorateur Windows, Finder, gestionnaire de fichiers Linux). Utilise le plugin opener déjà intégré, sans nouvelle dépendance.
#[tauri::command(async)]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    if !Path::new(&path).is_file() { return Err(format!("Fichier introuvable : {path}")); }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|error| format!("Impossible d'afficher {path} : {error}"))
}

/// Writes `text` to a new file of `logs_dir` (created if needed) named `<prefix>_<date>_<time>.log` after `now`; `-2`, `-3`... are added if the
/// name is taken: an existing log is never overwritten. Returns its path.
pub(crate) fn write_timestamped_log(logs_dir: &Path, prefix: &str, text: &str, now: chrono::DateTime<chrono::Local>) -> std::io::Result<PathBuf> {
    use std::io::Write;
    fs::create_dir_all(logs_dir)?;
    let stem = format!("{prefix}_{}", now.format("%Y-%m-%d_%H-%M-%S"));
    for attempt in 1..1000 {
        let name = if attempt == 1 { format!("{stem}.log") } else { format!("{stem}-{attempt}.log") };
        let path = logs_dir.join(name);
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut log) => {
                log.write_all(text.as_bytes())?;
                log.sync_all()?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "too many logs with the same name"))
}

/// Photo moved or copied under another name because a sidecar not its own was already at the destination (see reserve_destination).
#[derive(serde::Serialize)]
struct SidecarRename {
    path: String,
    to: String,
    sidecar: String,
}

/// Log of the renames of one move or copy, in `<storage>/logs`. Returns its path (None if nothing to log, or with the error traced).
fn log_sidecar_renames(base_dir: &Path, operation: &str, renames: &[SidecarRename]) -> Option<String> {
    if renames.is_empty() { return None; }
    let now = chrono::Local::now();
    let mut text = format!(
        "photoboggan {} - {operation} - {}\n{} photo(s) got another name: a sidecar that does not belong to them was already at the destination.\nThe sidecars below were left untouched; delete or rename them by hand if they are leftovers.\n",
        env!("CARGO_PKG_VERSION"), now.format("%Y-%m-%d %H:%M:%S %:z"), renames.len()
    );
    for rename in renames {
        text.push_str(&format!("\n{}\n  New name: {}\n  Sidecar already there: {}\n", rename.path, rename.to, rename.sidecar));
    }
    match write_timestamped_log(&base_dir.join("logs"), "sidecar-conflicts", &text, now) {
        Ok(path) => Some(path.to_string_lossy().into_owned()),
        Err(error) => {
            eprintln!("Sidecar conflict log not written: {error}");
            None
        }
    }
}

/// Recoveries after failed ExifTool writes (see exiftool::recover_after_failure), reported once a write operation is over.
#[derive(serde::Serialize)]
struct WriteRecoveryReport {
    entries: Vec<exiftool::Recovery>,
    log_path: Option<String>,
    log_error: Option<String>,
}

/// Writes every recovery not yet reported to one timestamped file of `<storage folder>/logs`. None when there was nothing to report.
fn log_write_recoveries(base_dir: &Path) -> Option<WriteRecoveryReport> {
    let entries = exiftool::take_recoveries();
    if entries.is_empty() { return None; }
    let (log_path, log_error) = match exiftool::write_recovery_log(&base_dir.join("logs"), &entries, chrono::Local::now()) {
        Ok(path) => (Some(path.to_string_lossy().into_owned()), None),
        Err(error) => {
            eprintln!("Write recovery log not written: {error}");
            (None, Some(error.to_string()))
        }
    };
    Some(WriteRecoveryReport { entries, log_path, log_error })
}

/// Called by the interface after each metadata write operation: all recoveries since the last call, in a single log file and a single dialog.
#[tauri::command(async)]
fn take_write_recoveries(state: State<'_, AppState>) -> Option<WriteRecoveryReport> {
    log_write_recoveries(&state.base_dir())
}

// Ouvre une vidéo du catalogue dans le lecteur multimédia par défaut de l'OS (plugin opener déjà intégré) : l'application n'embarque aucun lecteur.
// Seules les vidéos du catalogue sont ouvertes, jamais un chemin arbitraire.
#[tauri::command(async)]
fn open_video_externally(state: State<'_, AppState>, path: String) -> Result<(), String> {
    if !video::is_video_path(Path::new(&path)) { return Err(format!("Ce fichier n'est pas une vidéo prise en charge : {path}")); }
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let tracked: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM photos WHERE path = ?)", params![path], |row| row.get(0))
        .unwrap_or(false);
    if !tracked { return Err("Vidéo absente du catalogue".into()); }
    if !Path::new(&path).is_file() { return Err(format!("Fichier introuvable : {path}")); }
    let native: PathBuf = Path::new(&path).components().collect();
    let native = native.to_string_lossy().into_owned();
    tauri_plugin_opener::open_path(native.as_str(), None::<&str>).map_err(|error| format!("Impossible d'ouvrir {native} : {error}"))
}

// Place les fichiers dans le presse-papiers de l'OS comme « Copier » dans l'explorateur de fichiers : c'est une liste de fichiers, qu'on peut
// coller dans l'explorateur, un client mail, une messagerie… Les fichiers inexistants sont ignorés ; renvoie le nombre de fichiers copiés.
// Portable (Windows, macOS, Linux) grâce à la crate clipboard-rs, sans PowerShell ni outil externe.
use clipboard_rs::{Clipboard, ClipboardContext};
static CLIPBOARD: std::sync::Mutex<Option<ClipboardContext>> = std::sync::Mutex::new(None);

#[tauri::command(async)]
fn copy_files_to_clipboard(paths: Vec<String>) -> Result<usize, String> {
    let existing: Vec<&String> = paths.iter().filter(|path| Path::new(path.as_str()).is_file()).collect();
    if existing.is_empty() {
        return Err(match paths.first() {
            Some(path) => format!("Fichier introuvable : {path}"),
            None => "Aucune photo à copier".into(),
        });
    }
    let entries: Vec<String> = existing.iter().map(|path| clipboard_entry(path)).collect();
    // Le contexte est conservé entre deux appels : sous Linux (X11), c'est le processus de l'appli qui sert le contenu du presse-papiers
    // aux autres applications, il ne doit donc pas être libéré juste après la copie.
    let mut guard = CLIPBOARD.lock().map_err(|_| "Presse-papiers indisponible".to_string())?;
    if guard.is_none() {
        *guard = Some(ClipboardContext::new().map_err(|error| format!("Presse-papiers indisponible : {error}"))?);
    }
    let clipboard = guard.as_ref().ok_or("Presse-papiers indisponible")?;
    clipboard
        .set_files(entries)
        .map_err(|error| format!("Écriture dans le presse-papiers impossible : {error}"))?;
    Ok(existing.len())
}

// Texte du presse-papiers, pour « Coller » dans le menu des champs de saisie (le navigateur intégré demanderait une autorisation pour le lire).
// Chaîne vide quand le presse-papiers ne contient pas de texte.
#[tauri::command(async)]
fn read_clipboard_text() -> Result<String, String> {
    let mut guard = CLIPBOARD.lock().map_err(|_| "Presse-papiers indisponible".to_string())?;
    if guard.is_none() {
        *guard = Some(ClipboardContext::new().map_err(|error| format!("Presse-papiers indisponible : {error}"))?);
    }
    let clipboard = guard.as_ref().ok_or("Presse-papiers indisponible")?;
    Ok(clipboard.get_text().unwrap_or_default())
}

// Copie un texte dans le presse-papiers (coordonnées du groupe Lieu) : l'écriture par le navigateur intégré peut être refusée.
#[tauri::command(async)]
fn write_clipboard_text(text: String) -> Result<(), String> {
    let mut guard = CLIPBOARD.lock().map_err(|_| "Presse-papiers indisponible".to_string())?;
    if guard.is_none() {
        *guard = Some(ClipboardContext::new().map_err(|error| format!("Presse-papiers indisponible : {error}"))?);
    }
    let clipboard = guard.as_ref().ok_or("Presse-papiers indisponible")?;
    clipboard.set_text(text).map_err(|error| format!("Presse-papiers indisponible : {error}"))
}

// Format attendu par clipboard-rs pour set_files : sous Windows, les chemins tels quels (la crate construit elle-même la liste CF_HDROP ;
// des URI y seraient écrits comme de faux chemins et le collage ne ferait rien) ; ailleurs, des URI « file:/// ».
#[cfg(windows)]
fn clipboard_entry(path: &str) -> String {
    path.replace('/', "\\")
}

#[cfg(not(windows))]
fn clipboard_entry(path: &str) -> String {
    file_uri(path)
}

// URI « file:/// » avec caractères spéciaux encodés en %XX (ex. /home/x/a b.jpg -> file:///home/x/a%20b.jpg).
#[cfg(not(windows))]
fn file_uri(path: &str) -> String {
    let mut uri = String::from("file://");
    if !path.starts_with('/') {
        uri.push('/');
    }
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => uri.push(byte as char),
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri
}

fn main() {
    tauri::Builder::default()
        // Registered first, so a second instance exits before opening the database or starting anything. It brings the open window back.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle();
            exiftool::init(handle.path().resource_dir().ok());
            private_maps::init_bundled_style(handle.path().resource_dir().ok());
            let paths = resolve_app_paths(handle).map_err(|e| format!("Erreur d'initialisation des chemins : {e}"))?;
            let db_pool = db::init_db(&paths.db_path.to_string_lossy());
            if let Ok(conn) = db_pool.get() { private_maps::migrate_legacy_files(&paths.base_dir.join("private_maps"), &conn); }
            let config = load_config_at_startup(handle);
            let cache_size = config.thumbnail_cache_size.filter(|size| THUMBNAIL_CACHE_SIZES.contains(size)).unwrap_or(512);
            thumbnails::set_high_quality_thumbnails(config.thumbnail_quality.as_deref() == Some("high"));

            // Restauration de la fenêtre au démarrage avec vérification des écrans
            let main_window = app.get_webview_window("main").ok_or("Fenêtre principale introuvable")?;
            let window_tracker = restore_window_state(&main_window, &config);

            // La fenêtre est créée masquée (tauri.conf.json) : le frontend l'affiche une fois l'interface mise en forme (main.js).
            // Filet de sécurité : si le frontend ne l'a pas fait après 10 s (erreur de chargement…), on l'affiche ici pour ne jamais la laisser invisible.
            let fallback_window = main_window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(10));
                if let Ok(false) = fallback_window.is_visible() {
                    let _ = fallback_window.show();
                }
            });

            app.manage(AppState {
                db_pool: RwLock::new(db_pool),
                paths: RwLock::new(paths),
                thumbnail_cache_size: RwLock::new(cache_size),
                window_tracker: Mutex::new(window_tracker),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                // Mémorise la taille non-maximisée en direct
                tauri::WindowEvent::Resized(size) => {
                    if let Ok(false) = window.is_maximized() {
                        if size.width > 0 && size.height > 0 {
                            if let Some(state) = window.app_handle().try_state::<AppState>() {
                                if let Ok(mut tracker) = state.window_tracker.lock() {
                                    tracker.width = size.width;
                                    tracker.height = size.height;
                                }
                            }
                        }
                    }
                }
                // Mémorise la position non-maximisée en direct
                tauri::WindowEvent::Moved(pos) => {
                    if let Ok(false) = window.is_maximized() {
                        if let Some(state) = window.app_handle().try_state::<AppState>() {
                            if let Ok(mut tracker) = state.window_tracker.lock() {
                                tracker.x = pos.x;
                                tracker.y = pos.y;
                            }
                        }
                    }
                }
                // Sauvegarde sur le disque à la fermeture
                tauri::WindowEvent::CloseRequested { .. } => {
                    if let Some(state) = window.app_handle().try_state::<AppState>() {
                        save_current_window_state(window, &state);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Déclaration des commandes
            get_storage_location,
            change_storage_location,
            clear_thumbnail_cache,
            set_thumbnail_cache_size,
            set_thumbnail_quality,
            get_folders,
            list_disk_folders,
            get_folder_counts,
            add_folder,
            scan_folder,
            cancel_scan,
            remove_folder,
            get_photos_paginated,
            get_photos_by_paths,
            get_photos_by_ids,
            count_photos,
            get_cached_thumbnail_path,
            get_cached_thumbnail_paths,
            generate_thumbnail,
            get_raw_preview_path,
            save_thumbnail_cache,
            rescan_all_folders,
            rescan_folder,
            integrity_scan,
            find_duplicates,
            find_similar_images,
            list_duplicate_candidates,
            export_integrity_report,
            open_folder_in_file_manager,
            create_subfolder,
            copy_conflicts,
            tracked_copy_conflicts,
            rename_photo,
            rename_folder,
            update_photos_marking,
            rotate_photos,
            get_photo_details,
            delete_photos,
            delete_folder,
            get_folder_unrecognized_files,
            is_folder_empty,
            purge_orphan_thumbnails,
            count_permanent_deletions,
            remove_missing_photos,
            sync_library,
            copy_photos,
            copy_photos_to_tracked_folder,
            move_photos,
            open_with,
            reveal_in_file_manager,
            open_video_externally,
            copy_files_to_clipboard,
            read_clipboard_text,
            write_clipboard_text,
            resize_photo,
            keywords::get_keyword_tree,
            keywords::get_keyword_counts,
            keywords::get_photo_keyword_ids,
            keywords::get_keyword_usage,
            keywords::apply_metadata_changes,
            keywords::create_keyword,
            keywords::get_keyword_delete_info,
            keywords::delete_keyword,
            keywords::rename_keyword,
            keywords::set_metadata_read_order,
            faces::set_face_reading,
            faces::get_persons,
            faces::get_face_index,
            faces::get_photo_faces,
            faces::link_person_keyword,
            faces::get_faces_for_photos,
            faces::get_face_scan_index,
            faces::confirm_faces,
            faces::assign_faces,
            faces::set_faces_unknown,
            faces::ignore_faces,
            faces::unignore_faces,
            faces::mark_faces_not_a_face,
            faces::unmark_faces_not_a_face,
            faces::snapshot_faces,
            faces::restore_faces,
            faces::discard_pending_face_writes,
            faces::recognize_faces,
            faces::get_pending_face_writes,
            faces::face_keyword_conflicts,
            faces::erase_face_data,
            faces::rename_person,
            faces::set_person_hidden,
            faces::set_person_cover,
            faces::person_delete_info,
            faces::delete_person,
            faces::get_person_cover,
            faces::cluster_unknown_faces, faces::merge_persons, faces::get_person_merges, faces::undo_person_merge, faces::get_persons_without_faces, faces::delete_persons, faces::add_manual_face, faces::delete_faces, faces::set_person_alias,
            face_models::get_face_model_status,
            face_models::download_face_models,
            face_models::import_face_models,
            face_models::set_internet_allowed,
            semantic_models::set_semantic_enabled,
            semantic_models::get_semantic_model_status,
            semantic_models::download_semantic_model,
            semantic_models::import_semantic_model,
            semantic_models::delete_semantic_model,
            semantic::semantic_scan,
            semantic::get_semantic_stats,
            semantic::get_analysed_photo_ids,
            semantic::delete_semantic_data,
            semantic_search::semantic_search_text,
            semantic_search::semantic_search_image,
            semantic_search::semantic_keyword_photos,
            semantic_keywords::semantic_keyword_candidates,
            semantic_keywords::semantic_photo_suggestions,
            semantic_keywords::reject_keyword_suggestion,
            albums::get_album_tree,
            albums::create_album_node,
            albums::rename_album_node,
            albums::delete_album_node,
            albums::move_album_node,
            albums::copy_album_node,
            albums::set_album_filters,
            albums::get_album_photos,
            albums::get_album_memberships,
            albums::add_photos_to_album,
            albums::remove_photos_from_album,
            albums::replace_album_photos,
            private_maps::list_private_zones,
            private_maps::estimate_private_zone,
            private_maps::add_private_zone,
            private_maps::download_private_zone,
            private_maps::rename_private_zone,
            private_maps::delete_private_zone,
            private_maps::import_private_zone,
            private_maps::get_private_tile,
            private_maps::get_private_resource,
            private_maps::has_downloaded_map_style,
            private_maps::reset_map_style,
            private_maps::recompute_private_zone_shape,
            private_maps::locate_private_points,
            private_maps::set_private_zone_privacy,
            geolocation::get_erased_location_ids,
            geolocation::erase_geolocation,
            geolocation::restore_geolocation,
            place_search::search_places,
            update_check::check_for_update,
            update_check::download_update,
            update_check::install_update,
            set_verify_cross_drive_moves,
            face_detect::set_face_settings,
            face_detect::apply_face_thresholds,
            face_detect::count_face_scan_targets,
            face_detect::detect_faces,
            exiftool::set_metadata_writer,
            take_write_recoveries,
            pick_program,
            register_existing_programs,
            exiftool::get_exiftool_status,
            exiftool::exiftool_prewarm
        ])
        .build(tauri::generate_context!())
        .expect("Erreur de lancement")
        // Fermeture de l'application : les processus ExifTool encore ouverts sont arrêtés.
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                exiftool::shutdown();
                // Recoveries the interface had no time to report (write at closing time) still get their log file.
                if let Some(state) = app.try_state::<AppState>() { log_write_recoveries(&state.base_dir()); }
            }
        });
}


// Fonctions de déplacmeents des fichiers de base
fn move_file_or_copy(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !src.exists() { return Ok(()); }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    // Secours si le déplacement traverse deux disques différents (ex: C: vers D:)
    copy_durably(src, dst)?;
    let _ = fs::remove_file(src);
    Ok(())
}

/// Fichiers et dossiers de données de l'application, dans le dossier de stockage. `models` : fichiers de la détection des visages
/// (face_models.rs), conservés avec les données pour ne pas les retélécharger. `private_maps` : tuiles et style des zones privées de la carte
/// (private_maps.rs).
const STORAGE_FILES: [&str; 3] = ["photos_library.db", "photos_library.db-wal", "photos_library.db-shm"];
const STORAGE_DIRS: [&str; 5] = ["thumbnails", "raw_previews", "models", "person_covers", "private_maps"];

/// `durable`: each copy is flushed to the disk (see copy_durably), for data that cannot be rebuilt once the old location is removed.
fn copy_dir_recursive(src: &Path, dst: &Path, durable: bool) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let destination = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &destination, durable)?;
        } else if durable {
            copy_durably(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination)?;
        }
    }
    if durable { sync_parent_dir(&dst.join(".")); }
    Ok(())
}

/// Supprime les fichiers et dossiers de données d'un dossier de stockage (au mieux : un échec est tracé, rien n'est jamais bloquant).
fn remove_storage(base: &Path) {
    for name in STORAGE_FILES {
        let path = base.join(name);
        if let Err(error) = fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound { eprintln!("Storage file not removed ({}): {error}", path.display()); }
        }
    }
    for name in STORAGE_DIRS {
        let path = base.join(name);
        if let Err(error) = fs::remove_dir_all(&path) {
            if error.kind() != std::io::ErrorKind::NotFound { eprintln!("Storage folder not removed ({}): {error}", path.display()); }
        }
    }
}

/// Copie (sans rien supprimer à la source) la base et les dossiers de données vers `to`. La base est copiée pendant qu'une transaction d'écriture
/// est tenue : aucune tâche ne peut la modifier entre-temps, et une base occupée fait refuser le changement avant toute copie.
fn copy_storage(pool: &DbPool, from: &Path, to: &Path) -> Result<(), String> {
    let conn = pool.get().map_err(|error| error.to_string())?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").map_err(|error| format!("Point de contrôle de la base impossible : {error}"))?;
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|error| format!("La base est utilisée par une tâche en cours, réessayez plus tard : {error}"))?;
    let copied = (|| -> Result<(), String> {
        for name in ["photos_library.db", "photos_library.db-wal"] {
            let source = from.join(name);
            // Le journal WAL est vide après le point de contrôle : il n'est copié que s'il contient quelque chose. Le fichier -shm se reconstruit seul.
            let empty_wal = name.ends_with("-wal") && fs::metadata(&source).map(|metadata| metadata.len() == 0).unwrap_or(true);
            if !source.is_file() || empty_wal { continue; }
            copy_durably(&source, &to.join(name)).map_err(|error| format!("Erreur lors de la copie de {name} : {error}"))?;
        }
        for name in STORAGE_DIRS {
            let source = from.join(name);
            if source.is_dir() {
                // The old location is deleted once the copy is done: everything is flushed to the disk except the thumbnail and RAW preview
                // caches, rebuilt on demand (flushing hundreds of thousands of thumbnails would make the change very slow).
                let durable = !matches!(name, "thumbnails" | "raw_previews");
                copy_dir_recursive(&source, &to.join(name), durable).map_err(|error| format!("Erreur lors de la copie de {name} : {error}"))?;
            }
        }
        Ok(())
    })();
    let _ = conn.execute_batch("ROLLBACK");
    copied
}

#[derive(serde::Serialize)]
struct StorageLocationInfo {
    current_path: String,
    is_custom: bool,
    default_path: String,
}

#[tauri::command]
fn get_storage_location(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<StorageLocationInfo, String> {
    let default_path = default_data_directory(&app)?.to_string_lossy().into_owned();
    Ok(StorageLocationInfo {
        current_path: state.base_dir().to_string_lossy().into_owned(),
        is_custom: state.is_custom(),
        default_path,
    })
}

#[tauri::command(async)]
fn change_storage_location(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    new_path: Option<String>,
) -> Result<StorageLocationInfo, String> {
    let default_dir = default_data_directory(&app)?;
    let target_dir = match &new_path {
        Some(p) if !p.trim().is_empty() => {
            let path = PathBuf::from(p.trim());
            if path == state.base_dir() {
                return Err("Le dossier choisi est identique à l'emplacement actuel".into());
            }
            path
        }
        _ => {
            if !state.is_custom() {
                return Err("L'application utilise déjà l'emplacement par défaut".into());
            }
            default_dir.clone()
        }
    };

    // Le dossier cible ne doit contenir aucune donnée de l'application : rien n'y est écrasé, et il peut être nettoyé en cas d'échec.
    let current_base = state.base_dir();
    for name in STORAGE_FILES.iter().chain(STORAGE_DIRS.iter()) {
        if target_dir.join(name).exists() {
            return Err(format!("Le dossier choisi contient déjà « {name} » : choisissez un dossier sans données de l'application"));
        }
    }
    // Le verrou d'écriture du pool est tenu pendant toute la copie et la bascule : une commande qui démarre maintenant attend, puis prend le nouveau
    // pool, au lieu d'écrire dans l'ancienne base. Une tâche déjà en cours (scan, synchronisation, écriture…) garderait l'ancienne base : refusé.
    let mut pool_guard = state.db_pool.write().unwrap_or_else(|poisoned| poisoned.into_inner());
    if running_tasks() > 0 || library_sync::is_running() {
        return Err("Une tâche est en cours (scan, synchronisation, écriture des métadonnées, copie, détection des visages…) : attendez sa fin ou arrêtez-la, puis réessayez".into());
    }
    fs::create_dir_all(&target_dir).map_err(|e| format!("Impossible de créer le dossier cible : {e}"))?;

    // 1. Copie des données (la source n'est pas touchée : en cas d'échec, l'emplacement actuel reste valable).
    let current_pool = pool_guard.clone();
    // Fichiers de tuiles des zones privées fermés : copiés puis supprimés de l'ancien emplacement sans connexion ouverte.
    private_maps::close_all_tile_files();
    if let Err(error) = copy_storage(&current_pool, &current_base, &target_dir) {
        remove_storage(&target_dir);
        return Err(error);
    }

    // 2. Ouverture de la base copiée, avant de toucher à l'état de l'application.
    let new_db_path = target_dir.join("photos_library.db");
    let opened = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| db::init_db(&new_db_path.to_string_lossy())));
    let Ok(new_pool) = opened else {
        remove_storage(&target_dir);
        return Err("La copie de la base n'a pas pu être ouverte : l'emplacement n'a pas changé".into());
    };

    // 3. Bascule de l'état de l'application.
    let is_custom = new_path.is_some() && target_dir != default_dir;
    let new_paths = AppDataPaths::from_base(target_dir.clone(), is_custom);
    let mut paths_guard = state.paths.write().unwrap_or_else(|poisoned| poisoned.into_inner());
    let old_pool = std::mem::replace(&mut *pool_guard, new_pool);
    let old_paths = std::mem::replace(&mut *paths_guard, new_paths);

    // 4. Sauvegarde dans config.json. En cas d'échec, retour à l'ancien emplacement (ses fichiers n'ont pas été touchés) : au prochain démarrage,
    // l'application retrouverait sinon un autre emplacement que celui où elle travaille.
    let saved = load_config(&app).and_then(|mut config_data| {
        config_data.custom_data_dir = if is_custom { Some(target_dir.to_string_lossy().into_owned()) } else { None };
        config_data.thumbnail_cache_size = Some(state.thumbnail_cache_size() as u32);
        save_config(&app, &config_data)
    });
    if let Err(error) = saved {
        *pool_guard = old_pool; // la base copiée est fermée ici
        *paths_guard = old_paths;
        drop(paths_guard);
        drop(pool_guard);
        remove_storage(&target_dir);
        return Err(format!("Configuration non enregistrée, l'emplacement n'a pas changé : {error}"));
    }

    // 5. Ancien emplacement nettoyé (au mieux : un processus extérieur peut encore garder la base ouverte).
    drop(paths_guard);
    drop(pool_guard);
    drop(current_pool);
    drop(old_pool);
    remove_storage(&current_base);

    Ok(StorageLocationInfo {
        current_path: target_dir.to_string_lossy().into_owned(),
        is_custom,
        default_path: default_dir.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
#[path = "tests/main.rs"]
mod tests;
