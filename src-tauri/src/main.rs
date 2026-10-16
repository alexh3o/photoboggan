#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod exif;

use tauri::{State, Emitter, Manager};
use std::fs;
use std::path::PathBuf;
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
    run_scan(app, state.db_pool.clone(), path).await;
    Ok(db::get_folders(&state.db_pool))
}

#[tauri::command]
fn remove_folder(state: State<'_, AppState>, id: i64, path: String) -> Result<Vec<TrackedFolder>, String> {
    db::remove_folder(&state.db_pool, id, &path)?;
    Ok(db::get_folders(&state.db_pool))
}

async fn run_scan(app: tauri::AppHandle, pool: DbPool, scan_path: String) {
    let (tx, mut rx) = mpsc::channel(100);

    let pool_clone = pool.clone();
    let writer = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let conn = pool_clone.get().unwrap();
        while let Some(photo) = rx.recv().await {
            buffer.push(photo);
            if buffer.len() >= 500 {
                insert_batch(&conn, &buffer);
                buffer.clear();
            }
        }
        if !buffer.is_empty() {
            insert_batch(&conn, &buffer);
        }
    });

    let scanner = tokio::task::spawn_blocking(move || {
        let entries: Vec<_> = WalkDir::new(scan_path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let p = e.path().to_string_lossy().to_lowercase();
                p.ends_with(".jpg") || p.ends_with(".jpeg") || p.ends_with(".png") || p.ends_with(".raw")
            })
            .collect();

        entries.par_iter().for_each(|entry| {
            let path_str = entry.path().to_string_lossy().to_string();
            let metadata = entry.metadata().unwrap();
            let file_size = metadata.len() as i64;
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
            };

            let _ = tx.blocking_send(photo);
        });
    });
    let _ = scanner.await;
    let _ = writer.await;
    let _ = app.emit("scan-complete", ());
}

#[tauri::command]
async fn rescan_all_folders(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let folders = db::get_folders(&state.db_pool);
    for folder in folders {
        run_scan(app.clone(), state.db_pool.clone(), folder.path).await;
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
    if let Some(rating) = rating {
        conn.execute("UPDATE photos SET rating = ? WHERE id = ?", params![rating, id]).map_err(|e| e.to_string())?;
    }
    if let Some(flag) = color_flag {
        conn.execute("UPDATE photos SET color_flag = ? WHERE id = ?", params![exif::normalize_color_flag(&flag), id]).map_err(|e| e.to_string())?;
    }

    Ok(())
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
            save_thumbnail_cache,
            rescan_all_folders,
            update_photo_metadata
        ])
        .run(tauri::generate_context!())
        .expect("Erreur de lancement");
}
