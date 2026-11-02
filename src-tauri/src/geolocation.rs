//! Effacement et restauration de la géolocalisation des photos (menu contextuel) : seules écritures du GPS dans les fichiers.
//!
//! - Effacer : les coordonnées sont d'abord sauvegardées en base (table `erased_locations`), puis retirées du fichier : EXIF et XMP avec
//!   ExifTool (fichiers écrits directement : JPEG, HEIC), XMP seul avec l'écriture interne. Une photo dont le GPS est dans l'EXIF est refusée
//!   quand cet EXIF ne peut pas être modifié (écriture interne, ou format écrit dans un sidecar : RAW, PNG, WebP…) : elle resterait géolocalisée.
//! - Restaurer : les coordonnées sauvegardées sont réécrites par le chemin d'écriture actif.
//! - La sauvegarde disparaît dès que la photo retrouve des coordonnées (restauration, ou relecture d'un fichier géolocalisé entre-temps par un
//!   autre logiciel) et avec la photo : déclencheurs SQLite sur la table `photos`, qui couvrent tous les chemins d'écriture de la base.
//! Après écriture, le fichier est relu et la base reflète cette relecture ; un écart est signalé comme un échec.

use rusqlite::params;
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

use crate::db::DbPool;
use crate::AppState;

pub fn init_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS erased_locations (
            photo_id INTEGER PRIMARY KEY,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            erased_at INTEGER NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS erased_locations_relocated AFTER UPDATE OF gps_lat ON photos WHEN NEW.gps_lat IS NOT NULL
        BEGIN DELETE FROM erased_locations WHERE photo_id = NEW.id; END;
        CREATE TRIGGER IF NOT EXISTS erased_locations_removed AFTER DELETE ON photos
        BEGIN DELETE FROM erased_locations WHERE photo_id = OLD.id; END;",
    )
}

#[derive(Serialize, Debug)]
pub struct GeoPhoto {
    pub photo_id: i64,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
}

#[derive(Serialize, Debug)]
pub struct GeoFailure {
    pub photo_id: i64,
    pub path: String,
    /// Code (« gps_in_exif_internal_writer », « gps_in_exif_sidecar_format ») ou message d'erreur.
    pub error: String,
}

#[derive(Serialize, Debug, Default)]
pub struct GeoWriteResult {
    /// Photos écrites, avec leurs coordonnées relues (None après un effacement).
    pub updated: Vec<GeoPhoto>,
    /// Photos refusées sans écriture (GPS de l'EXIF impossible à effacer par le chemin actif).
    pub refused: Vec<GeoFailure>,
    pub failed: Vec<GeoFailure>,
    /// Photos non traitées (tâche arrêtée).
    pub cancelled: usize,
}

/// Photos dont les coordonnées effacées sont sauvegardées (menu « Restaurer la géolocalisation »).
#[tauri::command(async)]
pub fn get_erased_location_ids(state: State<'_, AppState>) -> Result<Vec<i64>, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT photo_id FROM erased_locations").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

/// Raison pour laquelle le GPS de ce fichier ne peut pas être effacé par le chemin d'écriture actif, s'il y en a une.
pub fn erase_refusal(path: &Path, exif_gps: bool, exiftool: bool) -> Option<&'static str> {
    if !exif_gps { return None; }
    if !exiftool { return Some("gps_in_exif_internal_writer"); }
    if !crate::exiftool::writes_in_file(path) { return Some("gps_in_exif_sidecar_format"); }
    None
}

fn now_millis() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as i64).unwrap_or(0)
}

const SAME_PLACE: f64 = 1e-5; // ≈ 1 m : écart toléré entre les coordonnées écrites et relues (arrondis des formats)

/// Écriture d'une photo, puis relecture et mise à jour de la base. `restore` : Some(coordonnées) pour restaurer, None pour effacer.
fn write_one(conn: &rusqlite::Connection, cache_dirs: &crate::ImageCacheDirs, photo_id: i64, path: &str, restore: Option<(f64, f64)>) -> Result<GeoPhoto, String> {
    let update = crate::exif::MetadataUpdate { gps: Some(restore), ..Default::default() };
    crate::keep_cached_images(cache_dirs, path, || crate::exif::write_metadata(path, &update).map_err(|error| error.to_string()))?;
    let meta = crate::exif::read_exif(Path::new(path));
    match (restore, meta.gps) {
        (None, Some(_)) => return Err("Le fichier relu est encore géolocalisé".to_string()),
        (Some(_), None) => return Err("Les coordonnées relues dans le fichier sont absentes".to_string()),
        (Some((lat, lon)), Some((read_lat, read_lon))) if (lat - read_lat).abs() > SAME_PLACE || (lon - read_lon).abs() > SAME_PLACE => {
            return Err("Les coordonnées relues dans le fichier diffèrent de celles écrites".to_string());
        }
        _ => {}
    }
    let (gps_lat, gps_lon) = (meta.gps.map(|gps| gps.0), meta.gps.map(|gps| gps.1));
    // La base reflète la relecture ; une restauration (coordonnées présentes) supprime la sauvegarde (déclencheur erased_locations_relocated).
    let stored = match std::fs::metadata(path) {
        Ok(file) => conn.execute(
            "UPDATE photos SET gps_lat = ?1, gps_lon = ?2, file_size = ?3, modified = ?4 WHERE id = ?5",
            params![gps_lat, gps_lon, file.len() as i64, crate::library_sync::modified_millis(&file), photo_id],
        ),
        Err(_) => conn.execute("UPDATE photos SET gps_lat = ?1, gps_lon = ?2 WHERE id = ?3", params![gps_lat, gps_lon, photo_id]),
    };
    stored.map_err(|error| format!("Base de données non mise à jour : {error}"))?;
    Ok(GeoPhoto { photo_id, gps_lat, gps_lon })
}

/// Photos visées : (identifiant, chemin, coordonnées en base).
fn load_targets(conn: &rusqlite::Connection, photo_ids: &[i64]) -> Result<Vec<(i64, String, Option<(f64, f64)>)>, String> {
    let ids = serde_json::to_string(photo_ids).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, path, gps_lat, gps_lon FROM photos WHERE id IN (SELECT value FROM json_each(?1))")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([ids], |row| {
            let (lat, lon): (Option<f64>, Option<f64>) = (row.get(2)?, row.get(3)?);
            Ok((row.get(0)?, row.get(1)?, lat.zip(lon)))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

fn run(app: &tauri::AppHandle, pool: &DbPool, photo_ids: Vec<i64>, restore: bool, task_id: Option<String>, cancel: Option<Arc<AtomicBool>>) -> Result<GeoWriteResult, String> {
    // Même verrou que les écritures de mots-clés : jamais deux écritures de métadonnées en même temps sur un fichier.
    let _write_guard = crate::keywords::WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let cache_dirs = crate::ImageCacheDirs::of(&app.state::<AppState>());
    let conn = pool.get().map_err(|e| e.to_string())?;
    let targets = load_targets(&conn, &photo_ids)?;
    let exiftool = crate::exiftool::is_enabled();
    let mut result = GeoWriteResult::default();
    let total = targets.len().max(1);
    let done = AtomicUsize::new(0);
    for (photo_id, path, located) in targets {
        if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            result.cancelled += 1;
            continue;
        }
        let outcome = if restore {
            let saved: Option<(f64, f64)> = conn
                .query_row("SELECT lat, lon FROM erased_locations WHERE photo_id = ?1", [photo_id], |row| Ok((row.get(0)?, row.get(1)?)))
                .ok();
            match saved {
                Some(coordinates) => Some(write_one(&conn, &cache_dirs, photo_id, &path, Some(coordinates))),
                None => None, // rien à restaurer
            }
        } else {
            // Coordonnées lues dans le fichier (la base peut avoir du retard) ; sans GPS, rien à effacer.
            let meta = crate::exif::read_exif(Path::new(&path));
            match meta.gps.or(located) {
                None => None,
                Some(coordinates) => match erase_refusal(Path::new(&path), meta.gps_sources[0].is_some(), exiftool) {
                    Some(reason) => {
                        result.refused.push(GeoFailure { photo_id, path: path.clone(), error: reason.to_string() });
                        None
                    }
                    None => {
                        // Sauvegarde AVANT l'écriture : les coordonnées ne sont jamais perdues ; retirée si l'effacement échoue.
                        let saved = conn.execute(
                            "INSERT OR REPLACE INTO erased_locations (photo_id, lat, lon, erased_at) VALUES (?1, ?2, ?3, ?4)",
                            params![photo_id, coordinates.0, coordinates.1, now_millis()],
                        );
                        Some(match saved {
                            Err(error) => Err(format!("Sauvegarde des coordonnées impossible : {error}")),
                            Ok(_) => write_one(&conn, &cache_dirs, photo_id, &path, None).inspect_err(|_| {
                                let still_located = crate::exif::read_exif(Path::new(&path)).gps.is_some();
                                if still_located { let _ = conn.execute("DELETE FROM erased_locations WHERE photo_id = ?1", [photo_id]); }
                            }),
                        })
                    }
                },
            }
        };
        match outcome {
            Some(Ok(photo)) => result.updated.push(photo),
            Some(Err(error)) => result.failed.push(GeoFailure { photo_id, path, error }),
            None => {}
        }
        let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(id) = &task_id {
            let _ = app.emit("scan-progress", crate::ScanProgress { task_id: id.clone(), percent: (finished * 100 / total) as u32 });
        }
    }
    Ok(result)
}

async fn run_command(app: tauri::AppHandle, state: State<'_, AppState>, photo_ids: Vec<i64>, restore: bool, task_id: Option<String>) -> Result<GeoWriteResult, String> {
    let pool = state.pool();
    let cancel = task_id.as_deref().map(crate::scan_cancel_flag);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || run(&app, &pool, photo_ids, restore, worker_task_id, cancel)).await;
    if let Some(id) = &task_id { crate::release_scan_cancel_flag(id); }
    outcome.map_err(|error| error.to_string())?
}

/// Efface la géolocalisation des photos (coordonnées sauvegardées avant). Avec `task_id`, tâche de la file (progression, arrêt).
#[tauri::command]
pub async fn erase_geolocation(app: tauri::AppHandle, state: State<'_, AppState>, photo_ids: Vec<i64>, task_id: Option<String>) -> Result<GeoWriteResult, String> {
    run_command(app, state, photo_ids, false, task_id).await
}

/// Réécrit les coordonnées sauvegardées des photos. Avec `task_id`, tâche de la file (progression, arrêt).
#[tauri::command]
pub async fn restore_geolocation(app: tauri::AppHandle, state: State<'_, AppState>, photo_ids: Vec<i64>, task_id: Option<String>) -> Result<GeoWriteResult, String> {
    run_command(app, state, photo_ids, true, task_id).await
}

#[cfg(test)]
#[path = "tests/geolocation.rs"]
mod tests;
