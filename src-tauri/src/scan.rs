//! Scan, integrity check, duplicate search orchestration, and task cancellation flags.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use rayon::prelude::*;
use tauri::{Emitter, State};
use tokio::sync::mpsc;
use walkdir::WalkDir;

use crate::db::{self, DbPool, Photo};
use crate::{
    duplicates, faces, hash_tasks, integrity, library_sync, purge_orphan_cache,
    resolve_tracked_folder, runtime, similar, AppState,
};

#[derive(Clone, Copy)]
enum ScanMode {
    Rescan { index: usize, count: usize },
    FolderScan,
}

// Progression d'une tâche de scan, publiée dans l'événement « scan-progress » : l'interface retrouve sa tâche grâce à `taskId`
// (identifiant qu'elle a donné à la commande), ce qui évite de confondre les noms et les pourcentages de deux tâches.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanProgress {
    pub task_id: String,
    pub percent: u32,
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

pub(crate) fn scan_cancel_flag(task_id: &str) -> Arc<AtomicBool> {
    let mut flags = scan_cancel_flags().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // Entrées orphelines (arrêt demandé alors que la tâche était déjà terminée : personne ne les retire) : supprimées après 10 minutes.
    flags.retain(|_, entry| Arc::strong_count(&entry.flag) > 1 || entry.created.elapsed() < Duration::from_secs(600));
    flags.entry(task_id.to_string()).or_insert_with(|| CancelEntry { flag: Arc::new(AtomicBool::new(false)), created: Instant::now() }).flag.clone()
}

/// Nombre de tâches de la file en cours (scan, rescan, intégrité, copie, déplacement, écriture de mots-clés, détection de visages, téléchargement
/// des modèles) : chacune garde un clone de son drapeau d'arrêt. Une entrée orpheline (arrêt demandé après la fin d'une tâche) n'en a pas.
pub(crate) fn running_tasks() -> usize {
    scan_cancel_flags().lock().unwrap_or_else(std::sync::PoisonError::into_inner).values().filter(|entry| Arc::strong_count(&entry.flag) > 1).count()
}

pub(crate) fn release_scan_cancel_flag(task_id: &str) {
    scan_cancel_flags().lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(task_id);
}

// Arrête un scan ou une relecture en cours : le parcours cesse et les photos déjà lues restent dans le catalogue.
// Les fichiers non lus seront repris par la synchronisation incrémentale (sync_library) ou par une nouvelle relecture.
#[tauri::command]
pub(crate) fn cancel_scan(task_id: String) {
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
    let _priority = runtime::PriorityGuard::new(); // the semantic scan waits while the catalogue is read
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
            .filter_map(std::result::Result::ok)
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
            if finished.is_multiple_of(step) || finished == total {
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
pub(crate) async fn scan_folder(app: tauri::AppHandle, state: State<'_, AppState>, path: String, task_id: String, resume_since: Option<i64>) -> Result<(), String> {
    let pool = state.pool();
    let cancel = scan_cancel_flag(&task_id);
    let outcome = run_scan(app, pool, path, ScanMode::FolderScan, task_id.clone(), cancel, resume_since).await;
    release_scan_cancel_flag(&task_id);
    outcome
}

#[tauri::command]
pub(crate) async fn rescan_all_folders(app: tauri::AppHandle, state: State<'_, AppState>, task_id: String, resume_since: Option<i64>) -> Result<(), String> {
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

// Rescan d'un seul dossier suivi ou d'un de ses sous-dossiers (sous-dossiers compris), comme le rescan complet : les métadonnées de chaque
// fichier sont relues. La progression est publiée par l'événement « scan-progress » (0 à 100 % du dossier) avec l'identifiant de la tâche.
#[tauri::command]
pub(crate) async fn rescan_folder(app: tauri::AppHandle, state: State<'_, AppState>, path: String, task_id: String, resume_since: Option<i64>) -> Result<(), String> {
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
pub(crate) async fn integrity_scan(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    task_id: String,
    compute_hashes: Option<bool>,
    paths: Option<Vec<String>>,
) -> Result<integrity::IntegrityReport, String> {
    let pool = state.pool();
    let folder = resolve_tracked_folder(&pool, &path).ok_or_else(|| format!("Dossier non suivi : {path}"))?;
    if !folder.is_dir() { return Err(format!("Dossier introuvable : {path}")); }
    let resolved_paths: Option<Vec<PathBuf>> = match paths {
        Some(list) => {
            let mut out = Vec::with_capacity(list.len());
            for item in list {
                let candidate = PathBuf::from(&item);
                let Some(parent) = candidate.parent() else {
                    return Err(format!("Dossier non suivi : {item}"));
                };
                let resolved_parent = resolve_tracked_folder(&pool, &parent.to_string_lossy())
                    .ok_or_else(|| format!("Dossier non suivi : {item}"))?;
                if let Some(name) = candidate.file_name() {
                    out.push(resolved_parent.join(name));
                }
            }
            Some(out)
        }
        None => None,
    };
    let thumbnails_dir = state.thumbnails_dir();
    let max_side = state.thumbnail_cache_size();
    let cancel = scan_cancel_flag(&task_id);
    let worker_task_id = task_id.clone();
    let do_hashes = compute_hashes.unwrap_or(true);
    let outcome = tokio::task::spawn_blocking(move || {
        let publish = |fraction: f64| {
            let _ = app.emit("scan-progress", ScanProgress { task_id: worker_task_id.clone(), percent: (fraction * 100.0).round() as u32 });
        };
        let publish_folder = |folder_label: &str| {
            let _ = app.emit("scan-detail", ScanDetail { task_id: worker_task_id.clone(), detail: folder_label.to_string() });
        };
        let _priority = runtime::PriorityGuard::new();
        integrity::run_with_options(
            &folder,
            resolved_paths.as_deref(),
            &thumbnails_dir,
            max_side,
            Some(&pool),
            do_hashes,
            &cancel,
            &publish,
            &publish_folder,
        )
    }).await;
    release_scan_cancel_flag(&task_id);
    outcome.map_err(|error| error.to_string())?
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RichScanProgress {
    task_id: String,
    percent: u32,
    done: usize,
    total: usize,
    remaining_seconds: Option<u64>,
    paused: bool,
    phase: Option<&'static str>,
}

// Duplicate search, identical images (see duplicates.rs): pauses any background precomputation, runs at low OS priority,
// yields to strict foreground tasks, and reports rich progress + failure logs.
#[tauri::command]
pub(crate) async fn find_duplicates(app: tauri::AppHandle, state: State<'_, AppState>, request: duplicates::Request, task_id: String) -> Result<duplicates::Report, String> {
    let pool = state.pool();
    let base_dir = state.base_dir();
    let cancel = scan_cancel_flag(&task_id);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let publish = |rich: duplicates::RichProgress| {
            let _ = app.emit("scan-progress", RichScanProgress {
                task_id: worker_task_id.clone(),
                percent: rich.percent,
                done: rich.done,
                total: rich.total,
                remaining_seconds: rich.remaining_seconds,
                paused: rich.paused,
                phase: rich.phase,
            });
        };
        let _bg_pause = runtime::BackgroundPauseGuard::new();
        hash_tasks::wait_for_precompute_chunk(&cancel);
        duplicates::run_with_options(&pool, Some(&base_dir), &request, &cancel, &publish)
    }).await;
    release_scan_cancel_flag(&task_id);
    outcome.map_err(|error| error.to_string())?
}

// Duplicate search by file name: the interface applies the name pattern (a JavaScript regular expression), so the backend only lists the photos concerned.
#[tauri::command(async)]
pub(crate) fn list_duplicate_candidates(state: State<'_, AppState>, scope: duplicates::Scope, compare_with_library: bool) -> Result<Vec<(String, String, bool)>, String> {
    duplicates::name_candidates(&state.pool(), &scope, compare_with_library)
}

// Duplicate search, similar images (see similar.rs): pauses any background precomputation, runs at low OS priority,
// yields to strict foreground tasks, and reports rich progress + failure logs.
#[tauri::command]
pub(crate) async fn find_similar_images(app: tauri::AppHandle, state: State<'_, AppState>, request: similar::Request, task_id: String) -> Result<duplicates::Report, String> {
    let pool = state.pool();
    let thumbnails_dir = state.thumbnails_dir();
    let base_dir = state.base_dir();
    let cancel = scan_cancel_flag(&task_id);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let publish = |rich: duplicates::RichProgress| {
            let _ = app.emit("scan-progress", RichScanProgress {
                task_id: worker_task_id.clone(),
                percent: rich.percent,
                done: rich.done,
                total: rich.total,
                remaining_seconds: rich.remaining_seconds,
                paused: rich.paused,
                phase: rich.phase,
            });
        };
        let _bg_pause = runtime::BackgroundPauseGuard::new();
        hash_tasks::wait_for_precompute_chunk(&cancel);
        similar::run_with_options(&pool, &thumbnails_dir, Some(&base_dir), &request, &cancel, &publish)
    }).await;
    release_scan_cancel_flag(&task_id);
    outcome.map_err(|error| error.to_string())?
}
