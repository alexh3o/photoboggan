//! SD card and external folder photo import: OS media detection, two-pass source scan,
//! RAM-only thumbnail/preview streaming, chronological durable copy reusing existing
//! file primitives, incremental import memory, and targeted catalogue indexing.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;

use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use walkdir::WalkDir;

use crate::db::{self, DbPool, Photo};
pub use crate::import_platform::stop_device_watcher;
use crate::import_platform::*;
use crate::{
    batch_rename, copy_atomically_to_reserved_verified, copy_replacing_verified, copy_sidecar,
    exif, files_have_same_hash, find_copy_conflicts, is_inside_folder, library_sync,
    log_sidecar_renames, lowercase_segments, privacy, release_scan_cancel_flag,
    remove_copied_target, reserve_destination, resolve_tracked_folder, same_existing_file,
    scan_cancel_flag, semantic, thumbnails, validate_new_name, video, AppState, CopyConflict,
    FileFailure, ScanProgress, SidecarRename,
};

// ---------------------------------------------------------------------------
// Configuration statics (pushed from frontend at startup and on change)
// ---------------------------------------------------------------------------

static MARKERS: OnceLock<RwLock<Vec<String>>> = OnceLock::new();
static LIST_MODE: OnceLock<RwLock<String>> = OnceLock::new();
static RETENTION_30D: AtomicBool = AtomicBool::new(false);

fn markers_lock() -> &'static RwLock<Vec<String>> {
    MARKERS.get_or_init(|| {
        RwLock::new(vec![
            "DCIM".into(),
            "PRIVATE/M4ROOT".into(),
            "MP_ROOT".into(),
            "AVCHD".into(),
        ])
    })
}

fn list_mode_lock() -> &'static RwLock<String> {
    LIST_MODE.get_or_init(|| RwLock::new("blacklist".into()))
}

fn current_markers() -> Vec<String> {
    markers_lock()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn current_list_mode() -> String {
    list_mode_lock()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

// ---------------------------------------------------------------------------
// SQLite schema
// ---------------------------------------------------------------------------

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS import_devices (
            media_id TEXT PRIMARY KEY,
            last_label TEXT NOT NULL DEFAULT '',
            last_root_path TEXT NOT NULL DEFAULT '',
            policy TEXT NOT NULL DEFAULT 'normal',
            last_seen_at INTEGER NOT NULL DEFAULT 0,
            last_import_at INTEGER NOT NULL DEFAULT 0,
            last_imported_file_dt TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS import_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id TEXT NOT NULL,
            root_folder TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            filename TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            file_mtime INTEGER NOT NULL,
            date_taken TEXT NOT NULL DEFAULT '',
            dest_path TEXT NOT NULL,
            imported_at INTEGER NOT NULL,
            UNIQUE(media_id, relative_path, file_size, file_mtime)
        );
        CREATE INDEX IF NOT EXISTS idx_import_history_media ON import_history(media_id);
        CREATE INDEX IF NOT EXISTS idx_import_history_imported_at ON import_history(imported_at);
        CREATE TABLE IF NOT EXISTS import_presets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL UNIQUE,
            config TEXT NOT NULL DEFAULT '{}'
        );",
    )
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DetectedMedia {
    pub media_id: String,
    pub label: String,
    pub root_path: String,
    pub has_marker: bool,
    pub policy: String,
    pub eligible: bool,
    pub last_import_at: i64,
    pub last_imported_file_dt: String,
    pub ejectable: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaChangedPayload {
    pub devices: Vec<DetectedMedia>,
    pub arrived: Option<DetectedMedia>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationInfo {
    pub valid: bool,
    pub resolved_path: String,
    pub free_bytes: u64,
    pub is_private: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub media_id: String,
    pub label: String,
    pub root_path: String,
    pub ejectable: bool,
    pub storage_kind: String,
    pub last_import_at: i64,
    pub last_imported_file_dt: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportFolderEntry {
    pub path: String,
    pub relative_path: String,
    pub name: String,
    pub raw_count: usize,
    pub raster_count: usize,
    pub video_count: usize,
    pub total_count: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportSourceFile {
    pub path: String,
    pub relative_path: String,
    pub folder_path: String,
    pub filename: String,
    pub extension: String,
    pub kind: String,
    pub size: u64,
    pub mtime: i64,
    pub date_taken: String,
    pub orientation: u32,
    pub status: String,
    pub existing_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScanResult {
    pub folders: Vec<ImportFolderEntry>,
    pub files: Vec<ImportSourceFile>,
    pub total_size: u64,
    pub last_import_at: i64,
    pub last_imported_file_dt: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportExifEntry {
    pub path: String,
    pub date_taken: String,
    pub orientation: u32,
    pub status: Option<String>,
    pub existing_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImportExifProgress {
    task_id: String,
    entries: Vec<ImportExifEntry>,
    done: usize,
    total: usize,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportCopyItem {
    pub source_path: String,
    pub relative_path: String,
    pub filename: String,
    pub kind: String,
    pub size: u64,
    pub mtime: i64,
    pub date_taken: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportSubfolderOptions {
    pub base_destination: String,
    pub subfolder_mode: String,
    pub custom_subfolder: String,
    pub split_by_type: bool,
    pub subfolder_raw: String,
    pub subfolder_raster: String,
    pub subfolder_video: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportConflict {
    #[serde(flatten)]
    pub conflict: CopyConflict,
    pub target_dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCopyRequest {
    pub media_id: String,
    pub root_folder: String,
    pub items: Vec<ImportCopyItem>,
    pub options: ImportSubfolderOptions,
    pub collision_policy: String,
    pub resolutions: HashMap<String, String>,
    pub verify_videos: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopiedImportFile {
    pub source_path: String,
    pub dest_path: String,
    pub filename: String,
    pub kind: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportFileNote {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCopyResult {
    pub copied: Vec<CopiedImportFile>,
    pub skipped: Vec<ImportFileNote>,
    pub failed: Vec<FileFailure>,
    pub cancelled: bool,
    pub renamed_for_sidecar: Vec<SidecarRename>,
    pub log_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDeviceRecord {
    pub media_id: String,
    pub last_label: String,
    pub last_root_path: String,
    pub policy: String,
    pub last_seen_at: i64,
    pub last_import_at: i64,
    pub last_imported_file_dt: String,
    pub history_count: i64,
}

// ---------------------------------------------------------------------------
// Path & format helpers
// ---------------------------------------------------------------------------

pub(crate) fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

fn file_kind(path: &Path) -> &'static str {
    if video::is_video_path(path) {
        "video"
    } else if thumbnails::is_raw_path(path) {
        "raw"
    } else {
        "raster"
    }
}

fn has_photo_marker(root: &Path, markers: &[String]) -> bool {
    for raw_marker in markers {
        let trimmed = raw_marker.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut candidate = root.to_path_buf();
        for seg in trimmed.split(['/', '\\']).filter(|s| !s.is_empty()) {
            candidate.push(seg);
        }
        if candidate.exists() {
            return true;
        }
        // Case-insensitive check on top-level entries for Linux mounts on FAT32/exFAT.
        if !trimmed.contains(['/', '\\']) {
            if let Ok(entries) = fs::read_dir(root) {
                if entries
                    .filter_map(std::result::Result::ok)
                    .any(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(trimmed))
                {
                    return true;
                }
            }
        }
    }
    false
}

fn format_dt_14_from_exif_or_mtime(date_taken: &str, mtime_ms: i64) -> String {
    let digits: String = date_taken.chars().filter(char::is_ascii_digit).take(14).collect();
    if digits.len() >= 8 && !digits.starts_with("0000") {
        return format!("{digits:0<14}");
    }
    if mtime_ms > 0 {
        if let Some(dt) = chrono::DateTime::from_timestamp_millis(mtime_ms) {
            let local: chrono::DateTime<chrono::Local> = dt.into();
            return local.format("%Y%m%d%H%M%S").to_string();
        }
    }
    String::new()
}

// ---------------------------------------------------------------------------
// Media enumeration + policy
// ---------------------------------------------------------------------------

fn read_device_import_state(conn: &Connection, media_id: &str) -> (String, i64, String) {
    conn.query_row(
        "SELECT policy, last_import_at, last_imported_file_dt FROM import_devices WHERE media_id = ?1",
        params![media_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .unwrap_or_else(|_| ("normal".into(), 0, String::new()))
}

fn collect_detected_media(pool: &DbPool) -> Vec<DetectedMedia> {
    let tracked_folders = db::get_folders(pool);
    let markers = current_markers();
    let mode = current_list_mode();
    let volumes = enumerate_removable_volumes();
    let now = library_sync::now_millis();
    let Ok(conn) = pool.get() else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for vol in volumes {
        // Never propose a drive that contains or is inside a tracked library folder.
        let overlaps_library = tracked_folders.iter().any(|tf| {
            let norm_tf = normalize_path(&tf.path);
            let norm_root = normalize_path(&vol.root_path);
            norm_tf.eq_ignore_ascii_case(&norm_root)
                || is_inside_folder(&vol.root_path, &tf.path)
                || is_inside_folder(&tf.path, &vol.root_path)
        });
        if overlaps_library {
            continue;
        }
        let has_marker = has_photo_marker(Path::new(&vol.root_path), &markers);
        let _ = conn.execute(
            "INSERT INTO import_devices (media_id, last_label, last_root_path, last_seen_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(media_id) DO UPDATE SET
               last_label = excluded.last_label,
               last_root_path = excluded.last_root_path,
               last_seen_at = excluded.last_seen_at",
            params![vol.media_id, vol.label, vol.root_path, now],
        );
        let (policy, last_import_at, last_imported_file_dt) = read_device_import_state(&conn, &vol.media_id);

        let eligible = has_marker
            && if mode == "whitelist" {
                policy == "whitelist"
            } else {
                policy != "blacklist"
            };

        out.push(DetectedMedia {
            media_id: vol.media_id,
            label: vol.label,
            root_path: vol.root_path,
            has_marker,
            policy,
            eligible,
            last_import_at,
            last_imported_file_dt,
            ejectable: true,
        });
    }
    out
}

#[tauri::command(async)]
pub fn list_detected_media(state: State<'_, AppState>) -> Vec<DetectedMedia> {
    collect_detected_media(&state.pool())
}

// ---------------------------------------------------------------------------
// Device watcher snapshot & config
// ---------------------------------------------------------------------------

type MediaSnapshot = Vec<(String, String, bool)>;

fn media_snapshot(devices: &[DetectedMedia]) -> MediaSnapshot {
    devices
        .iter()
        .map(|d| (d.media_id.clone(), d.root_path.clone(), d.eligible))
        .collect()
}

fn emit_media_change(app: &tauri::AppHandle, prev_snapshot: &mut MediaSnapshot) {
    let Some(app_state) = app.try_state::<AppState>() else {
        return;
    };
    let devices = collect_detected_media(&app_state.pool());
    let next_snapshot = media_snapshot(&devices);
    if next_snapshot == *prev_snapshot {
        return;
    }
    let prev_ids: HashSet<&str> = prev_snapshot.iter().map(|(id, _, _)| id.as_str()).collect();
    let arrived = devices
        .iter()
        .find(|d| d.eligible && !prev_ids.contains(d.media_id.as_str()))
        .cloned();
    *prev_snapshot = next_snapshot;
    let _ = app.emit("import-media-changed", MediaChangedPayload { devices, arrived });
}

#[tauri::command(async)]
pub fn set_import_watcher_config(
    app: tauri::AppHandle,
    enabled: bool,
    markers: Vec<String>,
    list_mode: String,
    retention_30d: bool,
) {
    *markers_lock().write().unwrap_or_else(std::sync::PoisonError::into_inner) = markers
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    *list_mode_lock().write().unwrap_or_else(std::sync::PoisonError::into_inner) = if list_mode == "whitelist" {
        "whitelist".into()
    } else {
        "blacklist".into()
    };
    RETENTION_30D.store(retention_30d, Ordering::Relaxed);

    let is_running = is_watcher_running();
    if enabled && !is_running {
        let mut prev_snapshot: MediaSnapshot = app
            .try_state::<AppState>()
            .map(|s| media_snapshot(&collect_detected_media(&s.pool())))
            .unwrap_or_default();
        start_device_watcher(move || {
            emit_media_change(&app, &mut prev_snapshot);
        });
    } else if !enabled && is_running {
        stop_device_watcher();
    }
}

// ---------------------------------------------------------------------------
// Destination validation & ejection
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn check_destination_info(state: State<'_, AppState>, path: String) -> Result<DestinationInfo, String> {
    let pool = state.pool();
    let Some(resolved) = resolve_tracked_folder(&pool, &path) else {
        return Ok(DestinationInfo {
            valid: false,
            resolved_path: path,
            free_bytes: 0,
            is_private: false,
        });
    };
    let resolved_str = resolved.to_string_lossy().into_owned();
    let free_bytes = disk_free_space(&resolved).unwrap_or(0);
    let is_private = privacy::is_private_folder(&resolved_str);
    Ok(DestinationInfo {
        valid: resolved.is_dir(),
        resolved_path: resolved_str,
        free_bytes,
        is_private,
    })
}

static ACTIVE_IMPORT_SOURCES: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();

fn active_import_sources_lock() -> &'static Mutex<Vec<PathBuf>> {
    ACTIVE_IMPORT_SOURCES.get_or_init(|| Mutex::new(Vec::new()))
}

struct ActiveImportSourceGuard {
    path: PathBuf,
}

impl ActiveImportSourceGuard {
    fn new(path: PathBuf) -> Self {
        if let Ok(mut list) = active_import_sources_lock().lock() {
            list.push(path.clone());
        }
        Self { path }
    }
}

impl Drop for ActiveImportSourceGuard {
    fn drop(&mut self) {
        if let Ok(mut list) = active_import_sources_lock().lock() {
            if let Some(pos) = list.iter().position(|p| p == &self.path) {
                list.remove(pos);
            }
        }
    }
}

fn paths_overlap(a: &str, b: &str) -> bool {
    let norm_a = normalize_path(a);
    let norm_b = normalize_path(b);
    if norm_a.is_empty() || norm_b.is_empty() {
        return false;
    }
    norm_a.eq_ignore_ascii_case(&norm_b)
        || is_inside_folder(&norm_a, &norm_b)
        || is_inside_folder(&norm_b, &norm_a)
}

pub(crate) fn validate_eject_target(
    root_path: &str,
    volumes: &[RawRemovableVolume],
    tracked_folders: &[db::TrackedFolder],
    app_data_dir: &Path,
    active_import_sources: &[PathBuf],
) -> Result<RawRemovableVolume, String> {
    let trimmed = root_path.trim();
    if trimmed.is_empty()
        || trimmed
            .split(['\\', '/'])
            .any(|seg| matches!(seg, "." | ".."))
    {
        return Err("Chemin de support invalide".into());
    }
    let norm = normalize_path(trimmed);
    let matched = volumes
        .iter()
        .find(|v| {
            let v_norm = normalize_path(&v.root_path);
            !v_norm.is_empty()
                && (v_norm.eq_ignore_ascii_case(&norm) || is_inside_folder(&v.root_path, trimmed))
        })
        .cloned()
        .ok_or_else(|| "Ce support n'est pas un lecteur amovible éjectable".to_string())?;

    if tracked_folders
        .iter()
        .any(|tf| paths_overlap(&matched.root_path, &tf.path))
    {
        return Err("Éjection refusée : ce support contient un dossier suivi".into());
    }
    if paths_overlap(&matched.root_path, &app_data_dir.to_string_lossy()) {
        return Err("Éjection refusée : ce support contient les données de l'application".into());
    }
    if active_import_sources
        .iter()
        .any(|src| paths_overlap(&matched.root_path, &src.to_string_lossy()))
    {
        return Err("Éjection refusée : un import est en cours depuis ce support".into());
    }
    Ok(matched)
}

#[tauri::command(async)]
pub fn eject_media(state: State<'_, AppState>, root_path: String) -> Result<(), String> {
    let volumes = enumerate_removable_volumes();
    let tracked = db::get_folders(&state.pool());
    let app_data = state.base_dir();
    let active = active_import_sources_lock()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    let matched = validate_eject_target(&root_path, &volumes, &tracked, &app_data, &active)?;
    eject_removable_volume(&matched.root_path)
}

// ---------------------------------------------------------------------------
// Source identification & two-pass scan
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn identify_source(state: State<'_, AppState>, path: String) -> Result<SourceInfo, String> {
    let target = Path::new(&path);
    if !target.is_dir() {
        return Err(format!("Source introuvable : {path}"));
    }
    let norm = normalize_path(&path);
    let removable = enumerate_removable_volumes().into_iter().find(|v| {
        let v_norm = normalize_path(&v.root_path);
        norm.eq_ignore_ascii_case(&v_norm) || is_inside_folder(&v.root_path, &path)
    });
    let (media_id, label, ejectable) = if let Some(vol) = removable { (vol.media_id, vol.label, true) } else {
        let label = target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| path.clone());
        (format!("folder:{}", norm.to_lowercase()), label, false)
    };
    let pool = state.pool();
    let conn = pool.get().map_err(|e| e.to_string())?;
    let (_, last_import_at, last_imported_file_dt) = read_device_import_state(&conn, &media_id);

    let storage_kind = detect_storage_kind(target).to_string();
    Ok(SourceInfo {
        media_id,
        label,
        root_path: path,
        ejectable,
        storage_kind,
        last_import_at,
        last_imported_file_dt,
    })
}

#[cfg(test)]
pub(crate) fn scan_source_fast_with_conn(
    conn: &Connection,
    root_path: &str,
    media_id: &str,
    cancel: &AtomicBool,
) -> Result<ImportScanResult, String> {
    scan_source_fast_with_root(conn, root_path, None, media_id, cancel)
}

pub(crate) fn scan_source_fast_with_root(
    conn: &Connection,
    root_path: &str,
    history_root: Option<&str>,
    media_id: &str,
    cancel: &AtomicBool,
) -> Result<ImportScanResult, String> {
    let root = Path::new(root_path);
    if !root.is_dir() {
        return Err(format!("Source introuvable : {root_path}"));
    }
    let history_base = history_root.map(Path::new).filter(|p| is_inside_folder(&p.to_string_lossy(), root_path));

    // Load import memory for this media_id once: (relative_path, file_size, file_mtime) -> dest_path
    let mut memory_set: HashMap<(String, i64, i64), String> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT relative_path, file_size, file_mtime, dest_path FROM import_history WHERE media_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![media_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            memory_set.insert((row.0.to_lowercase(), row.1, row.2), row.3);
        }
    }

    // Load (lowercase filename, file_size) -> existing path from visible catalogue photos.
    let mut library_index: HashMap<(String, i64), String> = HashMap::new();
    {
        let visible = privacy::visible_condition("");
        let sql = format!(
            "SELECT filename, file_size, path FROM photos WHERE filename IS NOT NULL AND file_size > 0 AND ({visible})"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            library_index.entry((row.0.to_lowercase(), row.1)).or_insert(row.2);
        }
    }

    let (_, last_import_at, last_imported_file_dt) = read_device_import_state(conn, media_id);

    let mut folder_map: HashMap<String, ImportFolderEntry> = HashMap::new();
    let mut files = Vec::new();
    let mut total_size = 0u64;

    for entry in WalkDir::new(root).into_iter().filter_map(std::result::Result::ok) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map(|r| normalize_path(&r.to_string_lossy()))
            .unwrap_or_default();

        if entry.file_type().is_dir() {
            let folder_key = normalize_path(&path.to_string_lossy());
            let name = if rel.is_empty() {
                root.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| root_path.to_string())
            } else {
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            };
            folder_map.entry(folder_key.clone()).or_insert(ImportFolderEntry {
                path: folder_key,
                relative_path: rel,
                name,
                raw_count: 0,
                raster_count: 0,
                video_count: 0,
                total_count: 0,
            });
            continue;
        }

        if !library_sync::is_photo_file(path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let size = meta.len();
        let mtime = library_sync::modified_millis(&meta);
        total_size += size;

        let kind = file_kind(path);
        let parent_key = path
            .parent().map_or_else(|| normalize_path(root_path), |p| normalize_path(&p.to_string_lossy()));
        if let Some(folder) = folder_map.get_mut(&parent_key) {
            match kind {
                "raw" => folder.raw_count += 1,
                "video" => folder.video_count += 1,
                _ => folder.raster_count += 1,
            }
            folder.total_count += 1;
        }

        let filename = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let extension = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();

        // When scanning a subfolder of a removable volume, compute the file's relative path
        // from the volume root so import_history stays consistent with root-level scans.
        let history_rel = history_base
            .and_then(|base| path.strip_prefix(base).ok()).map_or_else(|| rel.clone(), |r| normalize_path(&r.to_string_lossy()));

        let (status, existing_path) = if let Some(dest) =
            memory_set.get(&(history_rel.to_lowercase(), size as i64, mtime))
        {
            ("imported_memory".to_string(), Some(dest.clone()))
        } else if let Some(lib_path) = library_index.get(&(filename.to_lowercase(), size as i64)) {
            ("in_library".to_string(), Some(lib_path.clone()))
        } else {
            ("new".to_string(), None)
        };

        files.push(ImportSourceFile {
            path: path.to_string_lossy().into_owned(),
            relative_path: history_rel,
            folder_path: parent_key,
            filename,
            extension,
            kind: kind.to_string(),
            size,
            mtime,
            date_taken: String::new(),
            orientation: 1,
            status,
            existing_path,
        });
    }

    let mut folders: Vec<ImportFolderEntry> = folder_map.into_values().collect();
    folders.sort_by_key(|a| a.relative_path.to_lowercase());

    Ok(ImportScanResult {
        folders,
        files,
        total_size,
        last_import_at,
        last_imported_file_dt,
    })
}

#[tauri::command]
pub async fn scan_import_source_fast(
    state: State<'_, AppState>,
    root_path: String,
    media_id: String,
    task_id: String,
) -> Result<ImportScanResult, String> {
    let pool = state.pool();
    let cancel = scan_cancel_flag(&task_id);
    let outcome = tokio::task::spawn_blocking(move || {
        let history_root = enumerate_removable_volumes()
            .into_iter()
            .find(|v| v.media_id == media_id && is_inside_folder(&v.root_path, &root_path))
            .map(|v| v.root_path);
        let conn = pool.get().map_err(|e| e.to_string())?;
        scan_source_fast_with_root(&conn, &root_path, history_root.as_deref(), &media_id, &cancel)
    })
    .await;
    release_scan_cancel_flag(&task_id);
    outcome.map_err(|e| e.to_string())?
}

/// Normalizes `YYYY:MM:DD HH:MM:SS` and `YYYY-MM-DD HH:MM:SS` to `YYYY-MM-DD...` so EXIF dates
/// from `read_fast_exif_fields` match `photos.date_taken` stored in SQLite.
fn normalize_exif_date(raw: &str) -> String {
    let trimmed = raw.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 10 && bytes[4] == b':' && bytes[7] == b':' {
        let mut s = trimmed.to_string();
        // Safe because indices 4 and 7 are ASCII ':'.
        unsafe {
            let b = s.as_bytes_mut();
            b[4] = b'-';
            b[7] = b'-';
        }
        return s;
    }
    trimmed.to_string()
}

/// Pass 2: lightweight EXIF reading on up to 2 threads + optional partial-hash disambiguation
/// for ambiguous `new` files whose `date_taken` matches an existing library photo.
pub(crate) fn read_source_exif_with_pool(
    pool: &DbPool,
    paths: &[String],
    check_ambiguous: bool,
    cancel: &AtomicBool,
    on_batch: impl Fn(Vec<ImportExifEntry>, usize, usize) + Sync,
) -> Result<Vec<ImportExifEntry>, String> {
    // Load visible library photos indexed by normalized date_taken for ambiguous-candidate lookup.
    let mut by_date: HashMap<String, Vec<(i64, String, Option<Vec<u8>>)>> = HashMap::new();
    if check_ambiguous {
        if let Ok(conn) = pool.get() {
            let visible = privacy::visible_condition("p.");
            let sql = format!(
                "SELECT p.id, p.path, p.date_taken, h.partial_hash
                 FROM photos p
                 LEFT JOIN photo_hashes h
                   ON h.photo_id = p.id
                  AND h.mode = 1
                  AND h.version = ?1
                  AND h.size = COALESCE(p.file_size, 0)
                  AND h.modified = COALESCE(p.modified, 0)
                 WHERE p.date_taken IS NOT NULL AND p.date_taken >= '1000' AND ({visible})"
            );
            if let Ok(mut stmt) = conn.prepare(&sql) {
                if let Ok(rows) = stmt.query_map(params![crate::duplicates::LAYOUT_VERSION], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<Vec<u8>>>(3)?,
                    ))
                }) {
                    for row in rows.flatten() {
                        let norm_dt = normalize_exif_date(&row.2);
                        if !norm_dt.is_empty() {
                            by_date.entry(norm_dt).or_default().push((row.0, row.1, row.3));
                        }
                    }
                }
            }
        }
    }

    let total = paths.len();
    let done = std::sync::atomic::AtomicUsize::new(0);
    let thread_pool = rayon::ThreadPoolBuilder::new()
        .num_threads(2)
        .build()
        .map_err(|e| e.to_string())?;

    let entries: Vec<ImportExifEntry> = thread_pool.install(|| {
        let mut all = Vec::with_capacity(total);
        for chunk in paths.chunks(40) {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let batch: Vec<ImportExifEntry> = chunk
                .par_iter()
                .filter_map(|path_str| {
                    if cancel.load(Ordering::Relaxed) {
                        return None;
                    }
                    let path = Path::new(path_str);
                    if video::is_video_path(path) {
                        return None;
                    }
                    // Yield briefly while interactive thumbnail requests are reading from the SD card.
                    for _ in 0..40 {
                        if cancel.load(Ordering::Relaxed) || ACTIVE_IMPORT_THUMBS.load(Ordering::Relaxed) == 0 {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    let (date_taken, orientation) = thumbnails::read_fast_exif_fields(path);
                    let mut status = None;
                    let mut existing_path = None;
                    if check_ambiguous && !date_taken.is_empty() {
                        let norm_dt = normalize_exif_date(&date_taken);
                        if let Some(candidates) = by_date.get(&norm_dt) {
                            if let Ok((_, src_partial)) = crate::duplicates::quick_partial_hash(path) {
                                for (_id, lib_path, cached_partial) in candidates {
                                    let lib_hash = if let Some(bytes) = cached_partial {
                                        bytes.as_slice().try_into().ok()
                                    } else {
                                        crate::duplicates::quick_partial_hash(Path::new(lib_path))
                                            .ok()
                                            .map(|(_, h)| h)
                                    };
                                    if lib_hash == Some(src_partial) {
                                        status = Some("in_library".to_string());
                                        existing_path = Some(lib_path.clone());
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    Some(ImportExifEntry {
                        path: path_str.clone(),
                        date_taken,
                        orientation,
                        status,
                        existing_path,
                    })
                })
                .collect();
            let current = (done.fetch_add(chunk.len(), Ordering::Relaxed) + chunk.len()).min(total);
            if !batch.is_empty() || (current >= total && !cancel.load(Ordering::Relaxed)) {
                on_batch(batch.clone(), current, total);
                all.extend(batch);
            }
        }
        all
    });
    Ok(entries)
}

#[tauri::command]
pub async fn read_import_source_exif(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    check_ambiguous: bool,
    task_id: String,
) -> Result<Vec<ImportExifEntry>, String> {
    let pool = state.pool();
    let cancel = scan_cancel_flag(&task_id);
    let worker_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        read_source_exif_with_pool(&pool, &paths, check_ambiguous, &cancel, |entries, done, total| {
            let _ = app.emit(
                "import-exif-progress",
                ImportExifProgress {
                    task_id: worker_id.clone(),
                    entries,
                    done,
                    total,
                },
            );
        })
    })
    .await;
    release_scan_cancel_flag(&task_id);
    outcome.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// RAM-only thumbnails & previews (never touches disk cache or WebView file locks)
// ---------------------------------------------------------------------------

static IMPORT_THUMB_GATE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
static ACTIVE_IMPORT_THUMBS: AtomicUsize = AtomicUsize::new(0);

struct ThumbActiveGuard;

impl ThumbActiveGuard {
    fn new() -> Self {
        ACTIVE_IMPORT_THUMBS.fetch_add(1, Ordering::Relaxed);
        Self
    }
}

impl Drop for ThumbActiveGuard {
    fn drop(&mut self) {
        ACTIVE_IMPORT_THUMBS.fetch_sub(1, Ordering::Relaxed);
    }
}

fn import_thumb_gate() -> &'static tokio::sync::Semaphore {
    IMPORT_THUMB_GATE.get_or_init(|| tokio::sync::Semaphore::new(4))
}

#[tauri::command]
pub async fn get_import_thumbnail(
    source_path: String,
    max_side: Option<u32>,
) -> Result<tauri::ipc::Response, String> {
    let _active = ThumbActiveGuard::new();
    let _permit = import_thumb_gate()
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let side = max_side.unwrap_or(270).clamp(128, 512) as usize;
    let bytes = tokio::task::spawn_blocking(move || {
        thumbnails::render_fast_import_thumbnail_bytes(Path::new(&source_path), side, 75)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn get_import_preview(source_path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tokio::task::spawn_blocking(move || {
        thumbnails::render_preview_jpeg_bytes(Path::new(&source_path))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

// ---------------------------------------------------------------------------
// Destination subfolder computation, conflict detection & chronological copy
// ---------------------------------------------------------------------------

pub(crate) fn compute_target_dir(
    base_dir: &Path,
    item: &ImportCopyItem,
    options: &ImportSubfolderOptions,
) -> Result<PathBuf, String> {
    let mut dir = base_dir.to_path_buf();
    let dt = format_dt_14_from_exif_or_mtime(&item.date_taken, item.mtime);
    let y = dt.get(0..4).unwrap_or("0000");
    let m = dt.get(4..6).unwrap_or("00");
    let d = dt.get(6..8).unwrap_or("00");

    let push_validated = |target: &mut PathBuf, segment: &str| -> Result<(), String> {
        let valid = validate_new_name(segment)?;
        if batch_rename::text_units(valid) > batch_rename::MAX_NAME_UNITS {
            return Err("Nom de sous-dossier trop long".into());
        }
        let mut comps = Path::new(valid).components();
        if !matches!(
            (comps.next(), comps.next()),
            (Some(std::path::Component::Normal(_)), None)
        ) {
            return Err("Segment de sous-dossier invalide".into());
        }
        target.push(valid);
        Ok(())
    };

    match options.subfolder_mode.as_str() {
        "custom" => {
            if !options.custom_subfolder.trim().is_empty() {
                push_validated(&mut dir, &options.custom_subfolder)?;
            }
        }
        "yyyy_mm_dd" => push_validated(&mut dir, &format!("{y}-{m}-{d}"))?,
        "yyyy/yyyy_mm_dd" => {
            push_validated(&mut dir, y)?;
            push_validated(&mut dir, &format!("{y}-{m}-{d}"))?;
        }
        "yyyy/mm" => {
            push_validated(&mut dir, y)?;
            push_validated(&mut dir, m)?;
        }
        "yyyy_mm_dd_custom" => {
            let suffix = options.custom_subfolder.trim();
            let folder_name = if suffix.is_empty() {
                format!("{y}-{m}-{d}")
            } else {
                format!("{y}-{m}-{d}_{suffix}")
            };
            push_validated(&mut dir, &folder_name)?;
        }
        _ => {}
    }

    if options.split_by_type {
        let type_name = match item.kind.as_str() {
            "raw" => options.subfolder_raw.trim(),
            "video" => options.subfolder_video.trim(),
            _ => options.subfolder_raster.trim(),
        };
        if !type_name.is_empty() {
            push_validated(&mut dir, type_name)?;
        }
    }

    // Lexical containment: ensure every relative component is Normal inside `base_dir`.
    let rel = dir
        .strip_prefix(base_dir)
        .map_err(|_| "Le dossier cible sort du dossier de destination suivi".to_string())?;
    if !rel
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)))
    {
        return Err("Le dossier cible sort du dossier de destination suivi".into());
    }

    // Canonical containment when `base_dir` exists on disk (blocks symlink/junction escapes).
    if let Ok(canon_base) = fs::canonicalize(base_dir) {
        let mut probe = dir.as_path();
        while !probe.exists() {
            let Some(parent) = probe.parent() else {
                break;
            };
            probe = parent;
        }
        if let Ok(canon_existing) = fs::canonicalize(probe) {
            if !canon_existing.starts_with(&canon_base) {
                return Err("Le dossier cible sort du dossier de destination suivi".into());
            }
        }
    }

    if batch_rename::text_units(&dir.to_string_lossy()) > batch_rename::max_path_units() {
        return Err("Chemin cible trop long".into());
    }
    Ok(dir)
}

fn check_target_path_limits(
    target_dir: &Path,
    file_name: &str,
    source: &Path,
) -> Result<(), String> {
    if batch_rename::too_long(target_dir, file_name) {
        return Err(format!("Chemin cible trop long : {file_name}"));
    }
    let [src_appended, src_compat] = exif::sidecar_candidates(source);
    let sidecar_name = if src_appended.is_file() {
        Some(format!("{file_name}.xmp"))
    } else if src_compat.is_file() {
        let stem = Path::new(file_name)
            .file_stem().map_or_else(|| file_name.to_string(), |s| s.to_string_lossy().into_owned());
        Some(format!("{stem}.xmp"))
    } else {
        None
    };
    if let Some(name) = sidecar_name {
        if batch_rename::too_long(target_dir, &name) {
            return Err(format!("Chemin du sidecar XMP trop long : {name}"));
        }
    }
    Ok(())
}

/// Lazily creates `target_dir` and returns the shallowest ancestor directory that was newly created
/// strictly inside `dest_root` (None if `target_dir` already existed).
fn ensure_target_dir(dest_root: &Path, target_dir: &Path) -> std::io::Result<Option<PathBuf>> {
    if target_dir.is_dir() {
        return Ok(None);
    }
    let mut missing_top: Option<PathBuf> = None;
    let mut cur = target_dir;
    while cur != dest_root && cur.starts_with(dest_root) {
        if cur.exists() {
            break;
        } else {
            missing_top = Some(cur.to_path_buf());
        }
        let Some(parent) = cur.parent() else {
            break;
        };
        cur = parent;
    }
    fs::create_dir_all(target_dir)?;
    Ok(missing_top)
}

/// Removes empty directories created for a failed copy from `target_dir` up to `stop_at` (inclusive).
fn cleanup_created_empty_dirs(target_dir: &Path, stop_at: Option<&Path>) {
    let Some(stop) = stop_at else {
        return;
    };
    let mut cur = Some(target_dir);
    while let Some(dir) = cur {
        if !dir.starts_with(stop) {
            break;
        }
        if fs::remove_dir(dir).is_err() {
            break;
        }
        if dir == stop {
            break;
        }
        cur = dir.parent();
    }
}

pub(crate) fn check_import_conflicts_with(
    pool: &DbPool,
    items: &[ImportCopyItem],
    options: &ImportSubfolderOptions,
) -> Result<Vec<ImportConflict>, String> {
    let base_dir = resolve_tracked_folder(pool, &options.base_destination)
        .ok_or_else(|| format!("Dossier non suivi : {}", options.base_destination))?;
    if !base_dir.is_dir() {
        return Err(format!(
            "Dossier de destination introuvable : {}",
            base_dir.display()
        ));
    }
    let mut by_dir: HashMap<PathBuf, Vec<String>> = HashMap::new();
    for item in items {
        let target_dir = compute_target_dir(&base_dir, item, options)?;
        by_dir
            .entry(target_dir)
            .or_default()
            .push(item.source_path.clone());
    }
    let mut conflicts = Vec::new();
    for (dir, paths) in by_dir {
        if !dir.is_dir() {
            continue;
        }
        let dir_str = dir.to_string_lossy().into_owned();
        for c in find_copy_conflicts(&paths, &dir) {
            conflicts.push(ImportConflict {
                conflict: c,
                target_dir: dir_str.clone(),
            });
        }
    }
    conflicts.sort_by(|a, b| {
        a.target_dir
            .cmp(&b.target_dir)
            .then_with(|| a.conflict.name.cmp(&b.conflict.name))
            .then_with(|| a.conflict.path.cmp(&b.conflict.path))
    });
    Ok(conflicts)
}

#[tauri::command(async)]
pub fn check_import_conflicts(
    state: State<'_, AppState>,
    items: Vec<ImportCopyItem>,
    options: ImportSubfolderOptions,
) -> Result<Vec<ImportConflict>, String> {
    let pool = state.pool();
    check_import_conflicts_with(&pool, &items, &options)
}

pub(crate) fn run_import_copy_with(
    pool: &DbPool,
    base_dir: &Path,
    request: ImportCopyRequest,
    cancel: &AtomicBool,
    on_progress: impl Fn(u32),
) -> Result<ImportCopyResult, String> {
    run_import_copy_with_ops(
        pool,
        base_dir,
        request,
        cancel,
        on_progress,
        files_have_same_hash,
        |src, dst, verify| copy_replacing_verified(src, dst, verify),
        copy_sidecar,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_import_copy_with_ops(
    pool: &DbPool,
    base_dir: &Path,
    request: ImportCopyRequest,
    cancel: &AtomicBool,
    on_progress: impl Fn(u32),
    verify_hash: impl Fn(&Path, &Path) -> std::io::Result<bool>,
    replace_existing: impl Fn(&Path, &Path, &dyn Fn(&Path, &Path) -> std::io::Result<()>) -> std::io::Result<()>,
    copy_sidecar_op: impl Fn(&Path, &Path, bool) -> std::io::Result<()>,
) -> Result<ImportCopyResult, String> {
    let _priority = semantic::PriorityGuard::new();
    let dest_root = resolve_tracked_folder(pool, &request.options.base_destination)
        .ok_or_else(|| format!("Dossier non suivi : {}", request.options.base_destination))?;
    if !dest_root.is_dir() {
        return Err(format!(
            "Dossier de destination introuvable : {}",
            dest_root.display()
        ));
    }

    let _active_source = ActiveImportSourceGuard::new(PathBuf::from(&request.root_folder));

    // Deduplicate by normalized source path, then sort chronologically ascending so pause/stop and resume stay consistent.
    let mut seen_sources = HashSet::new();
    let mut items: Vec<ImportCopyItem> = request
        .items
        .into_iter()
        .filter(|item| {
            let norm = normalize_path(&item.source_path);
            let key = if cfg!(windows) { norm.to_lowercase() } else { norm };
            seen_sources.insert(key)
        })
        .collect();
    items.sort_by(|a, b| {
        let ka = format_dt_14_from_exif_or_mtime(&a.date_taken, a.mtime);
        let kb = format_dt_14_from_exif_or_mtime(&b.date_taken, b.mtime);
        ka.cmp(&kb).then_with(|| a.source_path.cmp(&b.source_path))
    });

    let total_bytes: u64 = items.iter().map(|i| i.size.max(1)).sum::<u64>().max(1);
    let mut done_bytes = 0u64;

    let mut copied = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    let mut renamed_for_sidecar = Vec::new();
    let mut pending_history: Vec<(ImportCopyItem, String, i64)> = Vec::new();
    let mut latest_dt = String::new();
    let mut cancelled = false;
    let norm_root = normalize_path(&request.root_folder);

    let flush_history = |batch: &mut Vec<(ImportCopyItem, String, i64)>, latest: &str| {
        if batch.is_empty() {
            return;
        }
        let conn = match pool.get() {
            Ok(c) => c,
            Err(error) => {
                eprintln!("Import history flush skipped (pool error): {error}");
                return;
            }
        };
        let now = library_sync::now_millis();
        let tx = match conn.unchecked_transaction() {
            Ok(tx) => tx,
            Err(error) => {
                eprintln!("Import history transaction failed: {error}");
                return;
            }
        };
        let write_result = (|| -> rusqlite::Result<()> {
            for (item, dest_path, imported_at) in batch.iter() {
                tx.execute(
                    "INSERT OR REPLACE INTO import_history
                     (media_id, root_folder, relative_path, filename, file_size, file_mtime, date_taken, dest_path, imported_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        request.media_id,
                        norm_root,
                        item.relative_path,
                        item.filename,
                        item.size as i64,
                        item.mtime,
                        item.date_taken,
                        dest_path,
                        imported_at
                    ],
                )?;
            }
            tx.execute(
                "INSERT INTO import_devices (media_id, last_import_at, last_imported_file_dt)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(media_id) DO UPDATE SET
                   last_import_at = excluded.last_import_at,
                   last_imported_file_dt = CASE
                     WHEN excluded.last_imported_file_dt > import_devices.last_imported_file_dt
                     THEN excluded.last_imported_file_dt
                     ELSE import_devices.last_imported_file_dt
                   END",
                params![request.media_id, now, latest],
            )?;
            if RETENTION_30D.load(Ordering::Relaxed) {
                let cutoff = now - 30 * 86_400_000;
                tx.execute(
                    "DELETE FROM import_history WHERE media_id = ?1 AND imported_at < ?2",
                    params![request.media_id, cutoff],
                )?;
            }
            tx.commit()
        })();
        match write_result {
            Ok(()) => batch.clear(),
            Err(error) => eprintln!("Import history commit failed: {error}"),
        }
    };

    for item in items {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let item_size = item.size.max(1);
        'item: {
            let source = Path::new(&item.source_path);
            if !source.is_file() {
                failed.push(FileFailure {
                    path: item.source_path.clone(),
                    error: "Fichier source introuvable".into(),
                });
                break 'item;
            }
            let Some(file_name) = source.file_name() else {
                failed.push(FileFailure {
                    path: item.source_path.clone(),
                    error: "Nom de fichier invalide".into(),
                });
                break 'item;
            };
            let target_dir = match compute_target_dir(&dest_root, &item, &request.options) {
                Ok(d) => d,
                Err(error) => {
                    failed.push(FileFailure {
                        path: item.source_path.clone(),
                        error,
                    });
                    break 'item;
                }
            };

            let exact = target_dir.join(file_name);
            let target_segments = lowercase_segments(&target_dir);
            let same_dir = source.parent().is_some_and(|parent| {
                lowercase_segments(parent) == target_segments || same_existing_file(parent, &target_dir)
            });
            if same_dir || same_existing_file(source, &exact) {
                skipped.push(ImportFileNote {
                    path: item.source_path.clone(),
                    reason: "same_file".into(),
                });
                break 'item;
            }

            let res_choice = request.resolutions.get(&item.source_path).map(String::as_str);
            if res_choice == Some("skip") {
                skipped.push(ImportFileNote {
                    path: item.source_path.clone(),
                    reason: "already_exists".into(),
                });
                break 'item;
            }
            let policy = if exact.is_file() {
                res_choice.unwrap_or(request.collision_policy.as_str())
            } else {
                "rename"
            };
            if policy == "skip" {
                skipped.push(ImportFileNote {
                    path: item.source_path.clone(),
                    reason: "already_exists".into(),
                });
                break 'item;
            }

            let file_name_str = file_name.to_string_lossy();
            if let Err(error) = check_target_path_limits(&target_dir, &file_name_str, source) {
                failed.push(FileFailure {
                    path: item.source_path.clone(),
                    error,
                });
                break 'item;
            }

            let created_top = match ensure_target_dir(&dest_root, &target_dir) {
                Ok(top) => top,
                Err(error) => {
                    failed.push(FileFailure {
                        path: item.source_path.clone(),
                        error: format!("Impossible de créer le dossier cible : {error}"),
                    });
                    break 'item;
                }
            };

            let verify_copy = |src: &Path, temp: &Path| -> std::io::Result<()> {
                if request.verify_videos && video::is_video_path(src) {
                    let matched = verify_hash(src, temp).unwrap_or(false);
                    if !matched {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "Vérification SHA-256 échouée avant finalisation de la copie vidéo",
                        ));
                    }
                }
                Ok(())
            };

            let is_replace = policy == "replace";
            let copy_outcome: Result<(PathBuf, Option<SidecarRename>), String> = if is_replace {
                replace_existing(source, &exact, &verify_copy)
                    .map(|()| (exact, None))
                    .map_err(|error| error.to_string())
            } else {
                match reserve_destination(&target_dir, file_name) {
                    Err(error) => Err(format!("Destination impossible à créer : {error}")),
                    Ok(reserved) => {
                        let reserved_name = reserved
                            .path
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        if batch_rename::too_long(&target_dir, &reserved_name) {
                            remove_copied_target(&reserved.path);
                            Err(format!("Chemin cible trop long : {reserved_name}"))
                        } else {
                            copy_atomically_to_reserved_verified(source, &reserved.path, verify_copy)
                                .map(|()| {
                                    let sr = reserved.sidecar_rename(&item.source_path);
                                    (reserved.path, sr)
                                })
                                .map_err(|error| error.to_string())
                        }
                    }
                }
            };

            let (dest_path, sidecar_rename) = match copy_outcome {
                Ok(outcome) => outcome,
                Err(error) => {
                    cleanup_created_empty_dirs(&target_dir, created_top.as_deref());
                    failed.push(FileFailure {
                        path: item.source_path.clone(),
                        error,
                    });
                    break 'item;
                }
            };

            if let Err(error) = copy_sidecar_op(source, &dest_path, is_replace) {
                failed.push(FileFailure {
                    path: item.source_path.clone(),
                    error: format!("Sidecar XMP non copié : {error}"),
                });
            }
            renamed_for_sidecar.extend(sidecar_rename);

            let dest_str = dest_path.to_string_lossy().into_owned();
            let dest_filename = dest_path
                .file_name().map_or_else(|| item.filename.clone(), |n| n.to_string_lossy().into_owned());
            let dt = format_dt_14_from_exif_or_mtime(&item.date_taken, item.mtime);
            if dt > latest_dt {
                latest_dt = dt;
            }
            copied.push(CopiedImportFile {
                source_path: item.source_path.clone(),
                dest_path: dest_str.clone(),
                filename: dest_filename,
                kind: item.kind.clone(),
            });
            pending_history.push((item, dest_str, library_sync::now_millis()));
        }

        if pending_history.len() >= 10 {
            flush_history(&mut pending_history, &latest_dt);
        }
        done_bytes += item_size;
        on_progress(((done_bytes.min(total_bytes) * 100) / total_bytes) as u32);
    }

    flush_history(&mut pending_history, &latest_dt);
    let log_path = log_sidecar_renames(base_dir, "import", &renamed_for_sidecar);
    Ok(ImportCopyResult {
        copied,
        skipped,
        failed,
        cancelled,
        renamed_for_sidecar,
        log_path,
    })
}

#[tauri::command]
pub async fn run_import_copy(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: ImportCopyRequest,
    task_id: String,
) -> Result<ImportCopyResult, String> {
    let pool = state.pool();
    let base_dir = state.base_dir();
    let cancel = scan_cancel_flag(&task_id);
    let worker_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        run_import_copy_with(&pool, &base_dir, request, &cancel, |percent| {
            let _ = app.emit(
                "scan-progress",
                ScanProgress {
                    task_id: worker_id.clone(),
                    percent,
                },
            );
        })
    })
    .await;
    release_scan_cancel_flag(&task_id);
    outcome.map_err(|e| e.to_string())?
}

/// Indexes only the newly imported destination files using `library_sync::read_photo` and `store_read_batch`,
/// returning the resulting `Photo` rows (with SQLite IDs) for immediate post-import tasks.
pub(crate) fn index_paths_with_pool(pool: &DbPool, paths: &[String]) -> Result<Vec<Photo>, String> {
    let _priority = semantic::PriorityGuard::new();
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let thread_pool = rayon::ThreadPoolBuilder::new()
        .num_threads(2)
        .build()
        .map_err(|e| e.to_string())?;
    let read_results: Vec<(Photo, i64, Vec<Vec<String>>, crate::faces::PhotoFaces)> = thread_pool.install(|| {
        paths
            .par_iter()
            .filter_map(|p| {
                let meta = fs::metadata(p).ok()?;
                let size = meta.len() as i64;
                let modified = library_sync::modified_millis(&meta);
                let (photo, keywords, faces) = library_sync::read_photo(p, size, modified).ok()?;
                Some((photo, modified, keywords, faces))
            })
            .collect()
    });

    if !read_results.is_empty() {
        let conn = pool.get().map_err(|e| e.to_string())?;
        let mut iter = read_results.into_iter();
        loop {
            let mut photos_batch = Vec::new();
            let mut modified_batch = Vec::new();
            let mut keyword_batch = Vec::new();
            let mut face_batch = Vec::new();
            for (photo, modified, keywords, faces) in iter.by_ref().take(500) {
                modified_batch.push((photo.path.clone(), modified));
                keyword_batch.push((photo.path.clone(), keywords));
                face_batch.push((photo.path.clone(), faces));
                photos_batch.push(photo);
            }
            if photos_batch.is_empty() {
                break;
            }
            library_sync::store_read_batch(&conn, &photos_batch, &modified_batch, &keyword_batch, &face_batch)?;
        }
    }

    let mut out = db::get_photos_by_paths(pool, paths)?;
    let order: HashMap<String, usize> = paths
        .iter()
        .enumerate()
        .map(|(i, p)| (normalize_path(p), i))
        .collect();
    out.sort_by_key(|p| {
        order
            .get(&normalize_path(&p.path))
            .copied()
            .unwrap_or(usize::MAX)
    });
    Ok(out)
}

#[tauri::command]
pub async fn index_imported_photos(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<Photo>, String> {
    let pool = state.pool();
    tokio::task::spawn_blocking(move || index_paths_with_pool(&pool, &paths))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Device & history management (Settings)
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn list_import_devices(state: State<'_, AppState>) -> Result<Vec<ImportDeviceRecord>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT d.media_id, d.last_label, d.last_root_path, d.policy, d.last_seen_at,
                    d.last_import_at, d.last_imported_file_dt, COUNT(h.id)
             FROM import_devices d
             LEFT JOIN import_history h ON h.media_id = d.media_id
             GROUP BY d.media_id
             ORDER BY d.last_seen_at DESC, d.last_label ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ImportDeviceRecord {
                media_id: row.get(0)?,
                last_label: row.get(1)?,
                last_root_path: row.get(2)?,
                policy: row.get(3)?,
                last_seen_at: row.get(4)?,
                last_import_at: row.get(5)?,
                last_imported_file_dt: row.get(6)?,
                history_count: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn set_import_device_policy(
    state: State<'_, AppState>,
    media_id: String,
    policy: String,
) -> Result<(), String> {
    let clean_policy = match policy.as_str() {
        "whitelist" | "blacklist" | "normal" => policy,
        _ => return Err("Politique invalide".into()),
    };
    let pool = state.pool();
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO import_devices (media_id, policy) VALUES (?1, ?2)
         ON CONFLICT(media_id) DO UPDATE SET policy = excluded.policy",
        params![media_id, clean_policy],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn delete_import_device(state: State<'_, AppState>, media_id: String) -> Result<(), String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM import_history WHERE media_id = ?1", params![media_id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM import_devices WHERE media_id = ?1", params![media_id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub(crate) fn purge_import_history_with_conn(
    conn: &Connection,
    media_id: Option<&str>,
    older_than_days: Option<u32>,
) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let deleted = match (media_id, older_than_days) {
        (Some(id), Some(days)) => {
            let cutoff = library_sync::now_millis() - i64::from(days) * 86_400_000;
            tx.execute(
                "DELETE FROM import_history WHERE media_id = ?1 AND imported_at < ?2",
                params![id, cutoff],
            )
            .map_err(|e| e.to_string())?
        }
        (Some(id), None) => tx
            .execute("DELETE FROM import_history WHERE media_id = ?1", params![id])
            .map_err(|e| e.to_string())?,
        (None, Some(days)) => {
            let cutoff = library_sync::now_millis() - i64::from(days) * 86_400_000;
            tx.execute("DELETE FROM import_history WHERE imported_at < ?1", params![cutoff])
                .map_err(|e| e.to_string())?
        }
        (None, None) => tx
            .execute("DELETE FROM import_history", [])
            .map_err(|e| e.to_string())?,
    };

    // Recompute last_import_at and last_imported_file_dt for affected devices from remaining history.
    let target_ids: Vec<String> = if let Some(id) = media_id { vec![id.to_string()] } else {
        let mut stmt = tx
            .prepare("SELECT media_id FROM import_devices")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };

    for id in target_ids {
        let mut max_imported_at = 0i64;
        let mut max_dt = String::new();
        {
            let mut stmt = tx
                .prepare(
                    "SELECT imported_at, date_taken, file_mtime FROM import_history WHERE media_id = ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for (imp_at, dt, mtime) in rows.flatten() {
                if imp_at > max_imported_at {
                    max_imported_at = imp_at;
                }
                let dt14 = format_dt_14_from_exif_or_mtime(&dt, mtime);
                if dt14 > max_dt {
                    max_dt = dt14;
                }
            }
        }
        tx.execute(
            "UPDATE import_devices SET last_import_at = ?2, last_imported_file_dt = ?3 WHERE media_id = ?1",
            params![id, max_imported_at, max_dt],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(deleted)
}

#[tauri::command(async)]
pub fn purge_import_history(
    state: State<'_, AppState>,
    media_id: Option<String>,
    older_than_days: Option<u32>,
) -> Result<usize, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|e| e.to_string())?;
    purge_import_history_with_conn(&conn, media_id.as_deref(), older_than_days)
}

// ---------------------------------------------------------------------------
// Saved import recipes (Subfolders + After copy)
// ---------------------------------------------------------------------------

const MAX_IMPORT_PRESET_NAME: usize = 100;
const MAX_IMPORT_PRESET_CONFIG: usize = 64_000;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreset {
    pub id: i64,
    pub name: String,
    pub config: String,
}

pub(crate) fn list_presets_with_conn(conn: &Connection) -> Result<Vec<ImportPreset>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, config FROM import_presets ORDER BY name_key")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ImportPreset {
                id: row.get(0)?,
                name: row.get(1)?,
                config: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub(crate) fn save_preset_with_conn(
    conn: &Connection,
    name: &str,
    config: &str,
) -> Result<Vec<ImportPreset>, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("empty_name".into());
    }
    if trimmed.chars().count() > MAX_IMPORT_PRESET_NAME {
        return Err("name_too_long".into());
    }
    if config.len() > MAX_IMPORT_PRESET_CONFIG || !config.trim_start().starts_with('{') {
        return Err("invalid_config".into());
    }
    conn.execute(
        "INSERT INTO import_presets (name, name_key, config) VALUES (?1, ?2, ?3)
         ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, config = excluded.config",
        params![trimmed, trimmed.to_lowercase(), config],
    )
    .map_err(|e| e.to_string())?;
    list_presets_with_conn(conn)
}

pub(crate) fn delete_preset_with_conn(conn: &Connection, id: i64) -> Result<Vec<ImportPreset>, String> {
    conn.execute("DELETE FROM import_presets WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    list_presets_with_conn(conn)
}

#[tauri::command(async)]
pub fn list_import_presets(state: State<'_, AppState>) -> Result<Vec<ImportPreset>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|e| e.to_string())?;
    list_presets_with_conn(&conn)
}

#[tauri::command(async)]
pub fn save_import_preset(
    state: State<'_, AppState>,
    name: String,
    config: String,
) -> Result<Vec<ImportPreset>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|e| e.to_string())?;
    save_preset_with_conn(&conn, &name, &config)
}

#[tauri::command(async)]
pub fn delete_import_preset(state: State<'_, AppState>, id: i64) -> Result<Vec<ImportPreset>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|e| e.to_string())?;
    delete_preset_with_conn(&conn, id)
}

#[cfg(test)]
#[path = "tests/import.rs"]
mod tests;
