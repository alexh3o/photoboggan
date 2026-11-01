//! Synchronisation incrémentale du catalogue avec le disque : fichiers ajoutés, modifiés ou supprimés hors de l'application.
//!
//! Le parcours des dossiers ne lit que la taille et la date de modification (fournies par l'énumération des dossiers,
//! sans ouvrir les fichiers). L'EXIF n'est relu que pour les fichiers nouveaux ou modifiés, avec 2 threads au plus
//! pour ne pas gêner l'interface.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use rayon::prelude::*;
use rusqlite::params;
use serde::Serialize;
use walkdir::WalkDir;

use crate::db::{self, DbPool, Photo};
use crate::{is_inside_folder, tracked_root_is_reachable};

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Une synchronisation est en cours (le changement d'emplacement des données est alors refusé).
pub fn is_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

struct RunningGuard;

impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Chemins concernés par la synchronisation ; l'interface recharge ensuite la liste des photos.
#[derive(Serialize, Default)]
pub struct SyncChanges {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
}

/// Date de modification en millisecondes depuis 1970 (0 si le système ne la fournit pas).
pub fn modified_millis(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Enregistre la date de modification (ms) des fichiers qui viennent d'être lus, par chemin (une transaction : tout ou rien).
pub fn store_modified(conn: &rusqlite::Connection, items: &[(String, i64)]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut update = tx.prepare_cached("UPDATE photos SET modified = ? WHERE path = ?")?;
        for (path, modified) in items {
            update.execute(params![modified, path])?;
        }
    }
    tx.commit()
}

/// Enregistre un lot de photos lues : lignes, mots-clés, visages, puis dates de modification. Les dates ne sont écrites que si tout le reste
/// l'est : sinon la photo serait prise pour lue (taille et date identiques) alors que ses mots-clés ou ses visages manquent. En cas d'échec,
/// les lignes du lot sont marquées (taille -1) pour être relues à la prochaine synchronisation.
pub fn store_read_batch(
    conn: &rusqlite::Connection,
    photos: &[Photo],
    modified: &[(String, i64)],
    keyword_batches: &[(String, Vec<Vec<String>>)],
    face_batches: &[(String, crate::faces::PhotoFaces)],
) -> Result<(), String> {
    let stored = crate::insert_batch(conn, photos)
        .map_err(|error| format!("photos not stored: {error}"))
        .and_then(|_| if crate::keywords::store_photo_keywords(conn, keyword_batches) { Ok(()) } else { Err("keywords not stored".to_string()) })
        .and_then(|_| if crate::faces::store_photo_faces(conn, face_batches) { Ok(()) } else { Err("faces not stored".to_string()) })
        .and_then(|_| store_modified(conn, modified).map_err(|error| format!("modification dates not stored: {error}")));
    if let Err(error) = &stored {
        let marked = conn.unchecked_transaction().and_then(|tx| {
            for photo in photos { tx.execute("UPDATE photos SET file_size = -1 WHERE path = ?1", params![photo.path])?; }
            tx.commit()
        });
        if let Err(mark_error) = marked { eprintln!("Photos not marked for re-reading ({error}): {mark_error}"); }
    }
    stored
}

/// Retire des photos du catalogue, par chemin (une transaction : tout ou rien).
fn delete_photos(conn: &rusqlite::Connection, paths: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for path in paths { tx.execute("DELETE FROM photos WHERE path = ?", params![path])?; }
    tx.commit()
}

// Formats pris en charge (scan initial et synchronisation).
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    // Formats standards
    "jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "jfif",
    // HEIC / HEIF (décodage et métadonnées : heif.rs)
    "heic", "heif", "hif",
    // Formats RAW
    "arw", "cr2", "cr3", "nef", "nrw", "dng", "raf", "orf", "rw2", "raw",
    // Essayés puis retirés :
    // jp2 (ne fonctionne pas), svg (miniature seulement)
];
pub fn is_photo_file(path: &Path) -> bool {
    // Les vidéos (video.rs) sont cataloguées comme les photos : même scan, même synchronisation incrémentale.
    crate::video::is_video_path(path) || path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext_lower = ext.to_ascii_lowercase();
            SUPPORTED_EXTENSIONS.contains(&ext_lower.as_str())
        })
        .unwrap_or(false)
}

/// Photo relue depuis son fichier, avec les chemins de ses mots-clés hiérarchiques et ses visages (enregistrés à part, voir keywords.rs et faces.rs).
/// Erreur si le fichier est illisible ou a changé pendant la lecture (copie en cours, fichier verrouillé…) : ses métadonnées seraient vides
/// ou incomplètes, et l'enregistrer le ferait passer pour lu. Il sera relu à la prochaine synchronisation.
pub(crate) fn read_photo(path: &str, file_size: i64, modified: i64) -> Result<(Photo, Vec<Vec<String>>, crate::faces::PhotoFaces), String> {
    let source = Path::new(path);
    fs::File::open(source).map_err(|error| format!("file not readable: {error}"))?;
    let exif_data = crate::exif::read_exif(source);
    let after = fs::metadata(source).map_err(|error| format!("file not readable after the read: {error}"))?;
    if after.len() as i64 != file_size || modified_millis(&after) != modified {
        return Err("file changed during the read".to_string());
    }
    let photo = Photo {
        id: 0,
        path: path.to_string(),
        filename: source.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
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
        pick_flag: exif_data.pick_flag,
        keywords: exif_data.keywords,
        title: exif_data.title,
        caption: exif_data.caption,
        modified: 0, // non utilisé : la date est enregistrée séparément par store_read_batch
    };
    Ok((photo, exif_data.keyword_paths, exif_data.faces))
}

/// Compare les dossiers suivis au catalogue :
/// - nouveau fichier : ajouté ;
/// - taille ou date de modification différentes : métadonnées relues ;
/// - fichier introuvable (dossier suivi joignable) : retiré ;
/// - ligne sans date enregistrée (catalogue antérieur à cette colonne ou scan manuel) : on enregistre simplement la date
///   si la taille n'a pas changé, sans relire le fichier.
/// Un seul passage à la fois : un appel pendant une synchronisation en cours ne fait rien.
pub fn sync_library(pool: &DbPool) -> Result<SyncChanges, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(SyncChanges::default());
    }
    let _guard = RunningGuard;
    let conn = pool.get().map_err(|error| error.to_string())?;
    // Un disque débranché ou un partage coupé n'est jamais pris pour une suppression : seuls les dossiers joignables sont parcourus.
    let roots: Vec<String> = db::get_folders(pool)
        .into_iter()
        .map(|folder| folder.path)
        .filter(|root| tracked_root_is_reachable(root))
        .collect();
    if roots.is_empty() {
        return Ok(SyncChanges::default());
    }

    // chemin -> (taille, date de modification) tels qu'enregistrés
    let mut known: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut statement = conn
            .prepare("SELECT path, file_size, modified FROM photos WHERE path IS NOT NULL")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (path, size, modified) = row.map_err(|error| error.to_string())?;
            known.insert(path, (size, modified));
        }
    }

    let mut seen: HashSet<String> = HashSet::new();
    // (chemin, taille, date de modification, nouveau fichier ?)
    let mut changed: Vec<(String, i64, i64, bool)> = Vec::new();
    let mut baseline: Vec<(String, i64)> = Vec::new();
    for root in &roots {
        for entry in WalkDir::new(root).into_iter().filter_map(|entry| entry.ok()) {
            if entry.file_type().is_dir() || !is_photo_file(entry.path()) {
                continue;
            }
            let path = entry.path().to_string_lossy().to_string();
            if !seen.insert(path.clone()) {
                continue; // dossiers suivis imbriqués : un fichier n'est traité qu'une fois
            }
            let Ok(metadata) = entry.metadata() else { continue; };
            let size = metadata.len() as i64;
            let modified = modified_millis(&metadata);
            match known.get(&path) {
                None => changed.push((path, size, modified, true)),
                Some(&(known_size, known_modified)) => {
                    if known_size != size {
                        changed.push((path, size, modified, false));
                    } else if known_modified == 0 {
                        baseline.push((path, modified));
                    } else if known_modified != modified {
                        changed.push((path, size, modified, false));
                    }
                }
            }
        }
    }

    // Absent du parcours ne suffit pas (erreur de lecture pendant le parcours) : on confirme que le fichier est bien introuvable.
    let removed: Vec<String> = known
        .keys()
        .filter(|path| !seen.contains(path.as_str()) && roots.iter().any(|root| is_inside_folder(root, path.as_str())))
        .filter(|path| matches!(fs::metadata(path.as_str()), Err(error) if error.kind() == std::io::ErrorKind::NotFound))
        .cloned()
        .collect();

    if changed.is_empty() && baseline.is_empty() && removed.is_empty() {
        return Ok(SyncChanges::default());
    }

    if !changed.is_empty() {
        let threads = rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .build()
            .map_err(|error| error.to_string())?;
        let read: Vec<Result<(Photo, Vec<Vec<String>>, crate::faces::PhotoFaces), String>> = threads.install(|| {
            changed.par_iter().map(|(path, size, modified, _)| read_photo(path, *size, *modified)).collect()
        });
        let mut photos: Vec<Photo> = Vec::with_capacity(read.len());
        let mut modified_dates: Vec<(String, i64)> = Vec::with_capacity(read.len());
        let mut keyword_batches: Vec<(String, Vec<Vec<String>>)> = Vec::with_capacity(read.len());
        let mut face_batches: Vec<(String, crate::faces::PhotoFaces)> = Vec::with_capacity(read.len());
        // Fichiers non lus (illisibles, ou modifiés pendant la lecture) : ni enregistrés ni signalés, relus à la prochaine synchronisation.
        let mut unread: HashSet<String> = HashSet::new();
        for ((path, _, modified, _), outcome) in changed.iter().zip(read) {
            match outcome {
                Ok((photo, keyword_paths, faces)) => {
                    modified_dates.push((path.clone(), *modified));
                    keyword_batches.push((path.clone(), keyword_paths));
                    face_batches.push((path.clone(), faces));
                    photos.push(photo);
                }
                Err(error) => {
                    eprintln!("File skipped by the synchronization ({path}): {error}");
                    unread.insert(path.clone());
                }
            }
        }
        changed.retain(|(path, _, _, _)| !unread.contains(path));
        store_read_batch(&conn, &photos, &modified_dates, &keyword_batches, &face_batches)
            .map_err(|error| format!("Synchronization stopped: {error}"))?;
    }

    // Lignes sans date enregistrée (taille inchangée) et fichiers disparus.
    store_modified(&conn, &baseline).map_err(|error| error.to_string())?;
    delete_photos(&conn, &removed).map_err(|error| error.to_string())?;

    let (added, updated): (Vec<(String, i64, i64, bool)>, Vec<(String, i64, i64, bool)>) =
        changed.into_iter().partition(|item| item.3);
    Ok(SyncChanges {
        added: added.into_iter().map(|item| item.0).collect(),
        updated: updated.into_iter().map(|item| item.0).collect(),
        removed,
    })
}

#[cfg(test)]
#[path = "tests/library_sync.rs"]
mod tests;
