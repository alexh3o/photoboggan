#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod exif;
mod library_sync;
mod thumbnails;

use tauri::{State, Emitter, Manager};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;
use rayon::prelude::*;
use db::{DbPool, Photo, TrackedFolder};
use tokio::sync::mpsc;
use rusqlite::params;

struct AppState {
    db_pool: DbPool,
}

fn thumbnail_cache_file(app: &tauri::AppHandle, source_path: &str) -> Result<PathBuf, String> {
    let metadata = fs::metadata(source_path).map_err(|error| error.to_string())?;
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let mut hash = 0xcbf29ce484222325u64;
    let size_bytes = metadata.len().to_le_bytes();
    let modified_bytes = modified.to_le_bytes();
    for byte in source_path.as_bytes().iter().chain(size_bytes.iter()).chain(modified_bytes.iter()) {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let cache_dir = app.path().app_cache_dir().map_err(|error| error.to_string())?.join("thumbnails");
    Ok(cache_dir.join(format!("{hash:016x}.jpg")))
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
fn get_cached_thumbnail_path(app: tauri::AppHandle, source_path: String) -> Result<Option<String>, String> {
    let path = thumbnail_cache_file(&app, &source_path)?;
    Ok(path.is_file().then(|| path.to_string_lossy().into_owned()))
}

// Version par lots : un seul aller-retour IPC pour plusieurs miniatures.
// Le résultat suit l'ordre de `source_paths` (None = pas de miniature en cache).
#[tauri::command(async)]
fn get_cached_thumbnail_paths(app: tauri::AppHandle, source_paths: Vec<String>) -> Vec<Option<String>> {
    source_paths.iter().map(|source_path| {
        thumbnail_cache_file(&app, source_path).ok()
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

// Génère la miniature (JPEG uniquement) directement dans le cache, hors du webview : décodage réduit,
// orientation EXIF appliquée, taille réelle renvoyée (ratio exact pour la disposition justifiée).
// Une erreur (PNG, JPEG CMYK, fichier illisible…) indique à l'interface d'utiliser sa génération de repli.
#[tauri::command(async)]
fn generate_thumbnail(app: tauri::AppHandle, source_path: String) -> Result<GeneratedThumbnail, String> {
    let destination = thumbnail_cache_file(&app, &source_path)?;
    let size = if destination.is_file() {
        thumbnails::jpeg_size(&destination)?
    } else {
        thumbnails::generate_thumbnail(std::path::Path::new(&source_path), &destination)?
    };
    Ok(GeneratedThumbnail { path: destination.to_string_lossy().into_owned(), width: size.width, height: size.height })
}

#[tauri::command(async)]
fn save_thumbnail_cache(app: tauri::AppHandle, source_path: String, data_url: String) -> Result<String, String> {
    let encoded = data_url.strip_prefix("data:image/jpeg;base64,").ok_or("Format de miniature non pris en charge")?;
    let bytes = decode_thumbnail_base64(encoded)?;
    let path = thumbnail_cache_file(&app, &source_path)?;
    if path.is_file() { return Ok(path.to_string_lossy().into_owned()); }
    let parent = path.parent().ok_or("Dossier de cache invalide")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!("thumb-{}-{}.tmp", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()));
    fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temp, &path) {
        let _ = fs::remove_file(&temp);
        if !path.is_file() { return Err(error.to_string()); }
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn get_folders(state: State<'_, AppState>) -> Vec<TrackedFolder> {
    db::get_folders(&state.db_pool)
}

#[tauri::command]
async fn add_folder_and_scan(app: tauri::AppHandle, state: State<'_, AppState>, path: String) -> Result<Vec<TrackedFolder>, String> {
    db::add_folder(&state.db_pool, &path)?;
    run_scan(app, state.db_pool.clone(), path, None).await;
    Ok(db::get_folders(&state.db_pool))
}

#[tauri::command]
fn remove_folder(state: State<'_, AppState>, id: i64, path: String) -> Result<Vec<TrackedFolder>, String> {
    db::remove_folder(&state.db_pool, id, &path)?;
    Ok(db::get_folders(&state.db_pool))
}

// `progress` : (rang du dossier, nombre de dossiers) pour publier l'avancement (rescan complet) ; None = pas d'événement.
async fn run_scan(app: tauri::AppHandle, pool: DbPool, scan_path: String, progress: Option<(usize, usize)>) {
    // Chaque photo arrive avec la date de modification de son fichier, enregistrée en base avec les métadonnées
    // pour que la synchronisation automatique ne la relise pas inutilement.
    let (tx, mut rx) = mpsc::channel::<(Photo, i64)>(100);

    let pool_clone = pool.clone();
    let writer = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let mut modified_dates: Vec<(String, i64)> = Vec::new();
        let conn = pool_clone.get().unwrap();
        while let Some((photo, modified)) = rx.recv().await {
            modified_dates.push((photo.path.clone(), modified));
            buffer.push(photo);
            if buffer.len() >= 500 {
                insert_batch(&conn, &buffer);
                library_sync::store_modified(&conn, &modified_dates);
                buffer.clear();
                modified_dates.clear();
            }
        }
        if !buffer.is_empty() {
            insert_batch(&conn, &buffer);
            library_sync::store_modified(&conn, &modified_dates);
        }
    });

    let progress_app = app.clone();
    let scanner = tokio::task::spawn_blocking(move || {
        let entries: Vec<_> = WalkDir::new(scan_path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let p = e.path().to_string_lossy().to_lowercase();
                p.ends_with(".jpg") || p.ends_with(".jpeg") || p.ends_with(".png") || p.ends_with(".raw")
            })
            .collect();

        let total = entries.len().max(1);
        let step = (total / 100).max(1);
        let done = AtomicUsize::new(0);

        entries.par_iter().for_each(|entry| {
            // Progression (rescan complet seulement) : un événement environ tous les 1 % du dossier, ramené à l'ensemble
            // des dossiers suivis. Valeur approximative : l'ordre d'arrivée entre threads n'est pas garanti.
            let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
            if let Some((index, count)) = progress {
                if finished % step == 0 || finished == total {
                    let percent = (index as f64 + finished as f64 / total as f64) / count.max(1) as f64 * 100.0;
                    let _ = progress_app.emit("rescan-progress", percent.round() as u32);
                }
            }
            let path_str = entry.path().to_string_lossy().to_string();
            let Ok(metadata) = entry.metadata() else { return; };
            let file_size = metadata.len() as i64;
            let modified = library_sync::modified_millis(&metadata);
            let filename = entry.file_name().to_string_lossy().to_string();
            let exif_data = exif::read_exif(entry.path());

            let photo = Photo {
                id: 0,
                path: path_str,
                filename,
                date_taken: exif_data.date_taken,
                aperture: exif_data.aperture,
                shutter_speed: exif_data.shutter_speed,
                iso: exif_data.iso,
                focal_length: exif_data.focal_length,
                manufacturer: exif_data.manufacturer,
                camera_model: exif_data.camera_model,
                lens_model: exif_data.lens_model,
                width: exif_data.width,
                height: exif_data.height,
                file_size,
                rating: exif_data.rating,
                color_flag: exif_data.color_flag,
                keywords: exif_data.keywords,
                caption: exif_data.caption,
                modified,
            };

            let _ = tx.blocking_send((photo, modified));
        });
    });
    let _ = scanner.await;
    let _ = writer.await;
    let _ = app.emit("scan-complete", ());
}

#[tauri::command]
async fn rescan_all_folders(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let folders = db::get_folders(&state.db_pool);
    let count = folders.len();
    for (index, folder) in folders.into_iter().enumerate() {
        run_scan(app.clone(), state.db_pool.clone(), folder.path, Some((index, count))).await;
    }
    Ok(())
}

fn insert_batch(conn: &r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>, photos: &[Photo]) {
    let _ = conn.execute("BEGIN TRANSACTION", []);
    {
        let mut stmt = conn.prepare_cached(
            "INSERT INTO photos 
            (path, filename, date_taken, aperture, shutter_speed, iso, focal_length, manufacturer, camera_model, width, height, file_size, rating, color_flag, keywords, caption, lens_model) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                filename=excluded.filename, date_taken=excluded.date_taken,
                aperture=excluded.aperture, shutter_speed=excluded.shutter_speed,
                iso=excluded.iso, focal_length=excluded.focal_length, manufacturer=excluded.manufacturer,
                camera_model=excluded.camera_model, width=excluded.width,
                height=excluded.height, file_size=excluded.file_size,
                rating=excluded.rating, color_flag=excluded.color_flag,
                keywords=excluded.keywords, caption=excluded.caption, lens_model=excluded.lens_model"
        ).unwrap();

        for p in photos {
            let _ = stmt.execute(params![
                p.path, p.filename, p.date_taken, p.aperture, p.shutter_speed, 
                p.iso, p.focal_length, p.manufacturer, p.camera_model, p.width, p.height, p.file_size,
                p.rating, p.color_flag, p.keywords, p.caption, p.lens_model
            ]);
        }
    }
    let _ = conn.execute("COMMIT", []);
}

#[tauri::command]
fn get_photos_paginated(state: State<'_, AppState>, offset: i32, limit: i32, folder_filter: Option<String>, recursive: bool) -> Vec<Photo> {
    db::get_photos(&state.db_pool, offset, limit, folder_filter, recursive)
}

#[tauri::command]
fn update_photo_metadata(state: State<'_, AppState>, id: i64, path: String, rating: Option<i32>, color_flag: Option<String>) -> Result<(), String> {
    // Seules les valeurs fournies sont modifiées : écrire la note ne touche pas au xmp:Label (qui peut contenir
    // une valeur non reconnue par l'application), et inversement.
    let rating = rating.map(|value| value.clamp(0, 5));
    let label = match color_flag.as_deref() {
        Some(flag) => Some(exif::label_for_color_flag(flag)?),
        None => None,
    };
    if rating.is_none() && label.is_none() { return Ok(()); }
    exif::write_xmp_metadata(&path, rating, label).map_err(|e| e.to_string())?;
    let conn = state.db_pool.get().unwrap();
    // Le fichier vient d'être réécrit par l'application : on enregistre sa nouvelle taille et sa date pour que la
    // synchronisation ne le prenne pas pour une modification externe.
    if let Ok(metadata) = fs::metadata(&path) {
        let _ = conn.execute("UPDATE photos SET file_size = ?, modified = ? WHERE id = ?", params![metadata.len() as i64, library_sync::modified_millis(&metadata), id]);
    }
    if let Some(rating) = rating {
        conn.execute("UPDATE photos SET rating = ? WHERE id = ?", params![rating, id]).map_err(|e| e.to_string())?;
    }
    if let Some(flag) = color_flag {
        conn.execute("UPDATE photos SET color_flag = ? WHERE id = ?", params![exif::normalize_color_flag(&flag), id]).map_err(|e| e.to_string())?;
    }

    Ok(())
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
    failed: Vec<FileFailure>,
}

// Contenu de la fenêtre « Infos » du menu contextuel : fichier, EXIF, XMP et IPTC.
#[tauri::command(async)]
fn get_photo_details(path: String) -> exif::MetadataDetails {
    exif::read_metadata_details(Path::new(&path))
}

// Suppression définitive (pas de corbeille : ça demanderait une dépendance supplémentaire). Seules les photos du catalogue
// peuvent être supprimées. Le fichier, sa miniature en cache et sa ligne en base disparaissent ; un éventuel sidecar .xmp est conservé.
#[tauri::command(async)]
fn delete_photos(app: tauri::AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> Result<DeleteResult, String> {
    let conn = state.db_pool.get().map_err(|error| error.to_string())?;
    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    for path in paths {
        let tracked: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM photos WHERE path = ?)", params![path], |row| row.get(0))
            .unwrap_or(false);
        if !tracked {
            failed.push(FileFailure { path, error: "Photo absente du catalogue".into() });
            continue;
        }
        let cache_file = thumbnail_cache_file(&app, &path).ok();
        match fs::remove_file(&path) {
            Ok(()) => {}
            // Fichier déjà disparu : on nettoie simplement le catalogue.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                failed.push(FileFailure { path, error: error.to_string() });
                continue;
            }
        }
        if let Some(cache_file) = cache_file { let _ = fs::remove_file(cache_file); }
        let _ = conn.execute("DELETE FROM photos WHERE path = ?", params![path]);
        deleted.push(path);
    }
    Ok(DeleteResult { deleted, failed })
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
    let conn = state.db_pool.get().map_err(|error| error.to_string())?;
    let reachable_roots: Vec<String> = db::get_folders(&state.db_pool)
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
async fn sync_library(state: State<'_, AppState>) -> Result<library_sync::SyncChanges, String> {
    let pool = state.db_pool.clone();
    tokio::task::spawn_blocking(move || library_sync::sync_library(&pool))
        .await
        .map_err(|error| error.to_string())?
}

// Nom libre dans le dossier de destination : « photo.jpg », puis « photo (1).jpg », « photo (2).jpg »… (jamais d'écrasement).
fn unique_destination(directory: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let candidate = directory.join(file_name);
    if !candidate.exists() { return candidate; }
    let name = Path::new(file_name);
    let stem = name.file_stem().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default();
    let extension = name.extension().map(|value| format!(".{}", value.to_string_lossy())).unwrap_or_default();
    let mut index = 1u32;
    loop {
        let candidate = directory.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() { return candidate; }
        index += 1;
    }
}

// Copie aussi le sidecar XMP (`photo.jpg.xmp` ou `photo.xmp`) : note, couleur et mots-clés des formats autres que JPEG y sont stockés.
fn copy_sidecar(source: &Path, target: &Path) {
    let appended = PathBuf::from(format!("{}.xmp", source.display()));
    let (from, to) = if appended.is_file() {
        (appended, PathBuf::from(format!("{}.xmp", target.display())))
    } else {
        let compatible = source.with_extension("xmp");
        if !compatible.is_file() { return; }
        (compatible, target.with_extension("xmp"))
    };
    if !to.exists() { let _ = fs::copy(from, to); }
}

// Copie des fichiers originaux (pas des miniatures) dans un dossier. Un fichier déjà présent n'est jamais écrasé :
// la copie est renommée (« photo (1).jpg »). Les dossiers suivis ne sont pas rescannés automatiquement.
#[tauri::command(async)]
fn copy_photos(paths: Vec<String>, destination: String) -> Result<CopyResult, String> {
    let destination_dir = Path::new(&destination);
    if !destination_dir.is_dir() { return Err(format!("Dossier de destination introuvable : {destination}")); }
    let mut copied = 0;
    let mut failed = Vec::new();
    for path in paths {
        let source = Path::new(&path);
        let Some(file_name) = source.file_name() else {
            failed.push(FileFailure { path: path.clone(), error: "Nom de fichier invalide".into() });
            continue;
        };
        let target = unique_destination(destination_dir, file_name);
        match fs::copy(source, &target) {
            Ok(_) => {
                copy_sidecar(source, &target);
                copied += 1;
            }
            Err(error) => {
                let _ = fs::remove_file(&target);
                failed.push(FileFailure { path: path.clone(), error: error.to_string() });
            }
        }
    }
    Ok(CopyResult { copied, failed })
}

// Ouvre les fichiers avec un programme externe (liste des Paramètres ou programme choisi dans la boîte de dialogue de l'OS).
#[tauri::command(async)]
fn open_with(program: String, paths: Vec<String>) -> Result<(), String> {
    let program_path = Path::new(&program);
    if !program_path.is_file() { return Err(format!("Programme introuvable : {program}")); }
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

// Place les fichiers dans le presse-papiers de l'OS comme « Copier » dans l'Explorateur : c'est une liste de fichiers, qu'on peut
// coller dans l'Explorateur, un client mail, une messagerie… Les fichiers inexistants sont ignorés ; renvoie le nombre de fichiers copiés.
#[tauri::command(async)]
fn copy_files_to_clipboard(paths: Vec<String>) -> Result<usize, String> {
    let existing: Vec<&String> = paths.iter().filter(|path| Path::new(path.as_str()).is_file()).collect();
    if existing.is_empty() {
        return Err(match paths.first() {
            Some(path) => format!("Fichier introuvable : {path}"),
            None => "Aucune photo à copier".into(),
        });
    }
    set_clipboard_files(&existing)?;
    Ok(existing.len())
}

// Windows : PowerShell (`Set-Clipboard -LiteralPath`), présent sur toutes les versions de Windows prises en charge, donc sans nouvelle
// dépendance ni DLL à distribuer. La liste passe par un fichier temporaire UTF-8 (et non par la ligne de commande) pour gérer les
// accents et les sélections de plusieurs centaines de photos ; le chemin de ce fichier est transmis par une variable d'environnement.
#[cfg(windows)]
fn set_clipboard_files(paths: &[&String]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000; // pas de fenêtre console qui clignote

    let list_file = std::env::temp_dir().join(format!(
        "photofile-clipboard-{}-{}.txt",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()
    ));
    let mut content = String::new();
    for path in paths {
        content.push_str(path);
        content.push('\n');
    }
    fs::write(&list_file, content.as_bytes()).map_err(|error| error.to_string())?;
    let script = "$ErrorActionPreference = 'Stop'; \
        $files = [System.IO.File]::ReadAllLines($env:PHOTOFILE_CLIPBOARD_LIST, [System.Text.Encoding]::UTF8) | Where-Object { $_ }; \
        Set-Clipboard -LiteralPath $files";
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Sta", "-Command", script])
        .env("PHOTOFILE_CLIPBOARD_LIST", &list_file)
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let _ = fs::remove_file(&list_file);
    let output = output.map_err(|error| format!("Impossible de lancer PowerShell : {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("Écriture dans le presse-papiers impossible : {}", String::from_utf8_lossy(&output.stderr).trim()))
    }
}

#[cfg(not(windows))]
fn set_clipboard_files(_paths: &[&String]) -> Result<(), String> {
    Err("La copie de fichiers dans le presse-papiers n'est disponible que sous Windows pour le moment".into())
}

fn main() {
    let db_path = "photos_library.db"; 
    let db_pool = db::init_db(db_path);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { db_pool })
        .invoke_handler(tauri::generate_handler![
            get_folders,
            add_folder_and_scan,
            remove_folder,
            get_photos_paginated,
            get_cached_thumbnail_path,
            get_cached_thumbnail_paths,
            generate_thumbnail,
            save_thumbnail_cache,
            rescan_all_folders,
            update_photo_metadata,
            get_photo_details,
            delete_photos,
            remove_missing_photos,
            sync_library,
            copy_photos,
            open_with,
            reveal_in_file_manager,
            copy_files_to_clipboard
        ])
        .run(tauri::generate_context!())
        .expect("Erreur de lancement");
}
