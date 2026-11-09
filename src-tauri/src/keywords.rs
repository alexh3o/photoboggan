//! Mots-clés hiérarchiques : arborescence (table `keyword_nodes`) et association photo ↔ mot-clé (table `photo_keywords`).
//!
//! Modèle (choisi avec l'utilisateur) :
//! - un nœud de l'arbre = un nom sous un parent (parent_id = 0 : premier niveau) ; deux frères ne diffèrent jamais que par leur nom,
//!   casse ignorée ;
//! - une photo « porte » un mot-clé quand une ligne de `photo_keywords` le désigne : seul le dernier niveau d'un chemin lu dans un fichier
//!   est actif. Les ancêtres ne le sont que s'ils ont leur propre entrée dans le fichier ;
//! - l'arbre grandit à la lecture des fichiers (scan, relecture, synchronisation) : un chemin hiérarchique vu dans un nouveau fichier y est ajouté.
//!   Il n'est jamais élagué automatiquement (un nœud sans photo reste dans l'arbre) ;
//! - le fichier fait foi : après chaque écriture, il est relu et la base reflète ce qu'il contient réellement.

use rayon::prelude::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

use crate::db::DbPool;
use crate::AppState;

/// Nœud de l'arbre envoyé à l'interface (`parent_id` 0 = premier niveau).
#[derive(Serialize)]
pub struct KeywordNode {
    pub id: i64,
    pub parent_id: i64,
    pub name: String,
}

/// Crée les tables à l'ouverture de la base (sans toucher aux données existantes). Appelée par `db::init_db`, après la création de `photos`.
/// Une erreur est renvoyée à l'appelant : sans ces tables, aucune commande de mots-clés ne peut fonctionner.
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS keyword_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_id INTEGER NOT NULL DEFAULT 0,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL,
            UNIQUE(parent_id, name_key)
        );
        CREATE TABLE IF NOT EXISTS photo_keywords (
            photo_id INTEGER NOT NULL,
            keyword_id INTEGER NOT NULL,
            PRIMARY KEY (photo_id, keyword_id)
        );
        CREATE INDEX IF NOT EXISTS idx_photo_keywords_keyword ON photo_keywords(keyword_id);
        -- Photos retirées du catalogue : leurs associations ne servent plus (les identifiants ne sont jamais réutilisés).
        DELETE FROM photo_keywords WHERE photo_id NOT IN (SELECT id FROM photos);",
    )
}

/// Clé de comparaison d'un nom : casse ignorée (« Paris » et « paris » sont le même mot-clé sous un même parent).
pub fn name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Identifiant du nœud `name` sous `parent_id`, créé s'il n'existe pas encore.
pub(crate) fn ensure_node(conn: &Connection, parent_id: i64, name: &str) -> rusqlite::Result<i64> {
    let key = name_key(name);
    conn.prepare_cached("INSERT OR IGNORE INTO keyword_nodes (parent_id, name, name_key) VALUES (?1, ?2, ?3)")?
        .execute(params![parent_id, name.trim(), key])?;
    conn.prepare_cached("SELECT id FROM keyword_nodes WHERE parent_id = ?1 AND name_key = ?2")?
        .query_row(params![parent_id, key], |row| row.get(0))
}

/// Enregistre, pour chaque photo (identifiée par son chemin), les mots-clés hiérarchiques lus dans ses fichiers : l'arbre est complété
/// des niveaux inconnus, et les associations de la photo sont remplacées par celles du fichier (le fichier fait foi).
/// À appeler après l'insertion des photos en base (leur identifiant doit exister). Une erreur annule tout le lot (rien n'est enregistré à moitié)
/// et est tracée dans les logs. Renvoie vrai si tout est enregistré : l'appelant ne doit alors pas considérer ces photos comme lues.
pub fn store_photo_keywords(conn: &Connection, items: &[(String, Vec<Vec<String>>)]) -> bool {
    if items.is_empty() { return true; }
    if let Err(error) = conn.execute_batch("BEGIN TRANSACTION") {
        eprintln!("Keywords not stored (transaction not started): {error}");
        return false;
    }
    let result = store_photo_keywords_in(conn, items).and_then(|_| conn.execute_batch("COMMIT"));
    // After the commit, never before: a suggestion model built in between would read the old links under the new generation and stay.
    crate::semantic_keywords::on_keywords_changed();
    if let Err(error) = result {
        eprintln!("Keywords not stored for {} photos: {error}", items.len());
        let _ = conn.execute_batch("ROLLBACK");
        return false;
    }
    true
}

/// Body of `store_photo_keywords`, without a transaction: the caller provides its own (see `run_write`) and calls
/// `semantic_keywords::on_keywords_changed` once it has committed.
pub(crate) fn store_photo_keywords_in(conn: &Connection, items: &[(String, Vec<Vec<String>>)]) -> rusqlite::Result<()> {
    for (path, keyword_paths) in items {
        let Some(photo_id) = conn.query_row("SELECT id FROM photos WHERE path = ?1", params![path], |row| row.get::<_, i64>(0)).optional()? else {
            eprintln!("Keywords not stored: {path} is not in the catalog");
            continue;
        };
        conn.execute("DELETE FROM photo_keywords WHERE photo_id = ?1", params![photo_id])?;
        for segments in keyword_paths.iter().filter(|segments| !segments.is_empty()) {
            let mut parent_id = 0i64;
            for segment in segments { parent_id = ensure_node(conn, parent_id, segment)?; }
            // Seul le dernier niveau du chemin est actif.
            conn.execute("INSERT OR IGNORE INTO photo_keywords (photo_id, keyword_id) VALUES (?1, ?2)", params![photo_id, parent_id])?;
        }
    }
    Ok(())
}

/// Mots-clés actifs d'une photo (identifiants triés), tels qu'enregistrés en base.
fn photo_keyword_ids(conn: &Connection, photo_id: i64) -> rusqlite::Result<Vec<i64>> {
    conn.prepare("SELECT keyword_id FROM photo_keywords WHERE photo_id = ?1 ORDER BY keyword_id")?
        .query_map(params![photo_id], |row| row.get(0))?
        .collect()
}

/// Lignes d'une requête, en erreur dès que l'une d'elles est illisible : jamais de résultat partiel présenté comme complet.
pub(crate) fn collect_rows<T, F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>(rows: rusqlite::MappedRows<'_, F>) -> Result<Vec<T>, String> {
    rows.collect::<rusqlite::Result<Vec<T>>>().map_err(|error| error.to_string())
}

/// Arborescence complète des mots-clés (tous les nœuds, à plat : l'interface reconstruit l'arbre d'après `parent_id`).
#[tauri::command(async)]
pub fn get_keyword_tree(state: State<'_, AppState>) -> Result<Vec<KeywordNode>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare("SELECT id, parent_id, name FROM keyword_nodes ORDER BY id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok(KeywordNode { id: row.get(0)?, parent_id: row.get(1)?, name: row.get(2)? }))
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

/// Mots-clés actifs de chaque photo d'une sélection, sous forme de paires (identifiant de la photo, identifiant du mot-clé).
#[tauri::command(async)]
pub fn get_photo_keyword_ids(state: State<'_, AppState>, photo_ids: Vec<i64>) -> Result<Vec<(i64, i64)>, String> {
    if photo_ids.is_empty() { return Ok(Vec::new()); }
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let ids_json = serde_json::to_string(&photo_ids).map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare("SELECT photo_id, keyword_id FROM photo_keywords WHERE photo_id IN (SELECT value FROM json_each(?1))")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![ids_json], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

/// Nombre de photos de la photothèque portant chaque mot-clé (fréquence d'usage : tri de l'autocomplétion).
#[tauri::command(async)]
pub fn get_keyword_usage(state: State<'_, AppState>) -> Result<Vec<(i64, i64)>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT pk.keyword_id, COUNT(*) FROM photo_keywords pk
             JOIN photos p ON p.id = pk.photo_id
             GROUP BY pk.keyword_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

// ---------------------------------------------------------------------------
// Écriture des mots-clés dans les fichiers
// ---------------------------------------------------------------------------

/// Métadonnées à écrire dans une photo, chacune facultative (absente = laissée telle quelle) : l'ensemble final des mots-clés actifs
/// (identifiants de l'arbre), le titre, la description (chaîne vide = retirée).
#[derive(Deserialize)]
pub struct KeywordWriteItem {
    pub photo_id: i64,
    pub path: String,
    #[serde(default)]
    pub keyword_ids: Option<Vec<i64>>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Écrire aussi les visages de la photo (zones et mots-clés des personnes, voir faces::plan_face_write). Une photo dont des visages attendent
    /// d'être écrits les écrit de toute façon, puisqu'elle est réécrite.
    #[serde(default)]
    pub faces: Option<bool>,
    /// Mode Carte : coordonnées (latitude, longitude) à écrire, qui remplacent les anciennes (altitude et direction comprises).
    #[serde(default)]
    pub gps: Option<(f64, f64)>,
}

#[derive(Serialize)]
pub struct KeywordWritten {
    pub photo_id: i64,
    /// Mots-clés à plat de la photo tels que relus dans le fichier (colonne `keywords` de la base).
    pub keywords: String,
    /// Mots-clés actifs de la photo en base après relecture (les visages ont pu en ajouter ou en retirer) : l'état enregistré du panneau.
    pub keyword_ids: Vec<i64>,
    /// Titre et description retenus à la relecture du fichier (colonnes `title` et `caption`).
    pub title: String,
    pub description: String,
    /// Coordonnées retenues à la relecture du fichier (colonnes `gps_lat` et `gps_lon`).
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
}

#[derive(Serialize)]
pub struct KeywordFailure {
    pub photo_id: i64,
    pub path: String,
    pub error: String,
}

#[derive(Serialize)]
pub struct KeywordWriteResult {
    pub written: Vec<KeywordWritten>,
    pub failed: Vec<KeywordFailure>,
    /// Photos laissées intactes parce que la tâche a été arrêtée.
    pub cancelled: usize,
    /// Suppression d'un mot-clé : vrai quand le mot-clé (et ses descendants) a été retiré de l'arbre, c'est-à-dire quand plus aucun fichier ne le porte.
    pub deleted: bool,
    /// Suppression d'un mot-clé : personnes qui lui étaient reliées, désormais déliées (identifiant, nom) : l'interface propose de les supprimer.
    pub unlinked_persons: Vec<(i64, String)>,
}

/// Chemin complet (du premier niveau au mot-clé) d'un nœud de l'arbre.
fn node_path(nodes: &HashMap<i64, (i64, String)>, keyword_id: i64) -> Option<Vec<String>> {
    let mut names = Vec::new();
    let mut current = keyword_id;
    while current != 0 {
        let (parent_id, name) = nodes.get(&current)?;
        names.push(name.clone());
        current = *parent_id;
        if names.len() > 64 { return None; } // arbre corrompu (boucle)
    }
    names.reverse();
    Some(names)
}

/// Zones de visage relues après écriture : même nombre et mêmes noms (casse ignorée) que celles écrites, sinon message d'erreur.
fn regions_mismatch(path: &Path, written: &crate::exif::RegionsUpdate) -> Option<String> {
    let names = |list: Vec<Option<String>>| { let mut names: Vec<String> = list.into_iter().map(|name| name.unwrap_or_default().to_lowercase()).collect(); names.sort(); names };
    let read = crate::exif::read_face_regions(path);
    let expected = names(written.regions.iter().map(|region| region.name.clone()).collect());
    let found = names(read.into_iter().map(|region| region.name).collect());
    (expected != found).then(|| "Les zones de visage relues dans le fichier diffèrent de celles écrites".to_string())
}

/// Séparateur des niveaux dans les clés de comparaison de chemins (caractère de contrôle, absent des noms).
const PATH_KEY_SEPARATOR: &str = "\u{1}";

fn normalized_paths(paths: &[Vec<String>]) -> HashSet<String> {
    paths.iter().map(|segments| segments.iter().map(|segment| name_key(segment)).collect::<Vec<_>>().join(PATH_KEY_SEPARATOR)).collect()
}

/// Un seul lot d'écritures à la fois : deux commandes de mots-clés (application, renommage, suppression) ne modifient jamais le même fichier
/// en même temps (temporaires communs, écritures qui s'écraseraient).
pub(crate) static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Enregistre l'échec d'une photo : renvoyé à l'interface et tracé dans les logs.
fn push_failure(failed: &mut Vec<KeywordFailure>, photo_id: i64, path: String, error: String) {
    eprintln!("Keyword write failed for {path}: {error}");
    failed.push(KeywordFailure { photo_id, path, error });
}

fn run_write(
    app: &tauri::AppHandle,
    pool: &DbPool,
    items: Vec<KeywordWriteItem>,
    task_id: Option<String>,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<KeywordWriteResult, String> {
    let _write_guard = WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _priority = crate::semantic::PriorityGuard::new(); // the semantic scan waits while files are written
    let conn = pool.get().map_err(|error| error.to_string())?;
    let cache_dirs = crate::ImageCacheDirs::of(&app.state::<AppState>()); // miniatures et aperçus qui suivent les fichiers réécrits
    let mut nodes: HashMap<i64, (i64, String)> = HashMap::new();
    {
        let mut statement = conn.prepare("SELECT id, parent_id, name FROM keyword_nodes").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)))
            .map_err(|error| error.to_string())?;
        for row in collect_rows(rows)? { nodes.insert(row.0, (row.1, row.2)); }
    }

    // Seules les photos du catalogue sont écrites (identifiant et chemin doivent correspondre). Une photo présente plusieurs fois est fusionnée :
    // elle n'est écrite qu'une fois, avec les dernières valeurs fournies pour chaque champ.
    let mut failed: Vec<KeywordFailure> = Vec::new();
    let mut valid: Vec<KeywordWriteItem> = Vec::new();
    let mut position: HashMap<i64, usize> = HashMap::new();
    for item in items {
        let known: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM photos WHERE id = ?1 AND path = ?2)", params![item.photo_id, item.path], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if !known {
            push_failure(&mut failed, item.photo_id, item.path, "Photo absente du catalogue".to_string());
            continue;
        }
        match position.get(&item.photo_id) {
            Some(&index) => {
                let kept = &mut valid[index];
                if item.keyword_ids.is_some() { kept.keyword_ids = item.keyword_ids; }
                if item.title.is_some() { kept.title = item.title; }
                if item.description.is_some() { kept.description = item.description; }
                if item.faces == Some(true) { kept.faces = Some(true); }
                if item.gps.is_some() { kept.gps = item.gps; }
            }
            None => {
                position.insert(item.photo_id, valid.len());
                valid.push(item);
            }
        }
    }

    // Visages à écrire avec la photo (demandés, ou en attente) : zones et mots-clés des personnes, calculés avant l'écriture.
    let mut face_plans: HashMap<i64, crate::faces::FaceWritePlan> = HashMap::new();
    let mut unplanned: HashSet<i64> = HashSet::new();
    for item in &valid {
        let wanted = if item.faces == Some(true) { Ok(true) } else { crate::faces::has_pending_face_write(&conn, item.photo_id) };
        let plan = wanted.and_then(|wanted| if wanted { crate::faces::plan_face_write(&conn, item.photo_id, item.keyword_ids.as_deref()).map(Some) } else { Ok(None) });
        match plan {
            Ok(Some(plan)) => { face_plans.insert(item.photo_id, plan); }
            Ok(None) => {}
            Err(error) => {
                unplanned.insert(item.photo_id);
                push_failure(&mut failed, item.photo_id, item.path.clone(), error);
            }
        }
    }
    valid.retain(|item| !unplanned.contains(&item.photo_id));

    // Écriture des fichiers (3 en parallèle), chacun de façon atomique. Les éléments sont uniques par photo (fusionnés plus haut) et le lot
    // est protégé par WRITE_LOCK : un fichier n'est jamais écrit deux fois en même temps.
    let total = valid.len().max(1);
    let done = AtomicUsize::new(0);
    let threads = rayon::ThreadPoolBuilder::new().num_threads(3).build().map_err(|error| error.to_string())?;
    // None : photo non traitée (tâche arrêtée) ; Some(Ok(modifications écrites)) ; Some(Err(message)).
    let outcomes: Vec<(KeywordWriteItem, Option<Result<crate::exif::MetadataUpdate, String>>)> = threads.install(|| {
        valid
            .into_par_iter()
            .map(|item| {
                if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                    return (item, None);
                }
                let plan = face_plans.get(&item.photo_id);
                // Avec des visages : mots-clés du plan (ceux de l'utilisateur, plus ou moins ceux des personnes), écrits s'ils changent.
                let keyword_ids: Option<&[i64]> = match plan {
                    Some(plan) => plan.keywords_changed.then_some(plan.keyword_ids.as_slice()),
                    None => item.keyword_ids.as_deref(),
                };
                // Un mot-clé introuvable dans l'arbre fait échouer la photo : l'ignorer le retirerait du fichier sans que la relecture le voie.
                let mut keyword_paths: Option<Vec<Vec<String>>> = None;
                for id in keyword_ids.unwrap_or_default() {
                    match node_path(&nodes, *id) {
                        Some(path) => keyword_paths.get_or_insert_with(Vec::new).push(path),
                        None => {
                            let message = format!("Mot-clé inconnu dans l'arbre (identifiant {id})");
                            return (item, Some(Err(message)));
                        }
                    }
                }
                let update = crate::exif::MetadataUpdate {
                    keywords: keyword_ids.map(|_| keyword_paths.unwrap_or_default()),
                    title: item.title.clone(),
                    description: item.description.clone(),
                    regions: plan.map(|plan| plan.regions.clone()),
                    gps: item.gps.map(Some),
                };
                // Métadonnées seules : la miniature et l'aperçu en cache sont renommés pour suivre le fichier, pas régénérés.
                let result = crate::keep_cached_images(&cache_dirs, &item.path, || {
                    crate::exif::write_metadata(&item.path, &update).map_err(|error| error.to_string())
                })
                .map(|_| update);
                let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
                if let Some(id) = &task_id {
                    let _ = app.emit("scan-progress", crate::ScanProgress { task_id: id.clone(), percent: (finished * 100 / total) as u32 });
                }
                (item, Some(result))
            })
            .collect()
    });

    // Vérification et mise à jour de la base : ce qui est enregistré est ce que le fichier contient réellement après relecture.
    // Photos, visages et mots-clés sont enregistrés dans une même transaction (annulée en cas d'erreur).
    let mut written: Vec<KeywordWritten> = Vec::new();
    let mut written_paths: HashMap<i64, String> = HashMap::new();
    let mut keyword_batches: Vec<(String, Vec<Vec<String>>)> = Vec::new();
    let mut face_batches: Vec<(String, crate::faces::PhotoFaces)> = Vec::new();
    let mut cancelled = 0usize;
    let tx = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    for (item, outcome) in outcomes {
        match outcome {
            None => cancelled += 1,
            Some(Err(error)) => push_failure(&mut failed, item.photo_id, item.path, error),
            Some(Ok(update)) => {
                let meta = crate::exif::read_exif(Path::new(&item.path));
                // Le fichier est modifié mais ne contient pas ce qui était demandé : la base n'est pas touchée, la prochaine synchronisation relira le fichier.
                let mismatch = match &update.keywords {
                    Some(desired) if normalized_paths(desired) != normalized_paths(&meta.keyword_paths) => {
                        Some("Les mots-clés relus dans le fichier diffèrent de ceux écrits".to_string())
                    }
                    _ => crate::exif::text_mismatch(Path::new(&item.path), &update, &meta),
                }
                .or_else(|| update.regions.as_ref().and_then(|regions| regions_mismatch(Path::new(&item.path), regions)))
                .or_else(|| item.gps.and_then(|written| crate::geolocation::gps_mismatch(written, meta.gps)));
                if let Some(error) = mismatch {
                    push_failure(&mut failed, item.photo_id, item.path, error);
                    continue;
                }
                let stored = match std::fs::metadata(&item.path) {
                    Ok(file) => tx.execute(
                        "UPDATE photos SET keywords = ?1, title = ?2, caption = ?3, file_size = ?4, modified = ?5 WHERE id = ?6",
                        params![meta.keywords, meta.title, meta.caption, file.len() as i64, crate::library_sync::modified_millis(&file), item.photo_id],
                    ),
                    Err(_) => tx.execute(
                        "UPDATE photos SET keywords = ?1, title = ?2, caption = ?3 WHERE id = ?4",
                        params![meta.keywords, meta.title, meta.caption, item.photo_id],
                    ),
                };
                // Coordonnées écrites : la base reflète la relecture (le déclencheur de geolocation.rs retire la sauvegarde d'un GPS effacé).
                let stored = stored.and_then(|_| {
                    if item.gps.is_none() { return Ok(0); }
                    tx.execute("UPDATE photos SET gps_lat = ?1, gps_lon = ?2 WHERE id = ?3", params![meta.gps.map(|gps| gps.0), meta.gps.map(|gps| gps.1), item.photo_id])
                });
                // Fichier écrit mais base non mise à jour : jamais présenté comme un succès (la synchronisation relira le fichier).
                if let Err(error) = stored {
                    push_failure(&mut failed, item.photo_id, item.path, format!("Base de données non mise à jour : {error}"));
                    continue;
                }
                if let Some(plan) = face_plans.get(&item.photo_id) {
                    if let Err(error) = crate::faces::finish_face_write(&tx, item.photo_id, plan) {
                        // Fichier écrit mais visages non notés en base : la photo est marquée pour être relue à la prochaine synchronisation.
                        let _ = tx.execute("UPDATE photos SET file_size = -1 WHERE id = ?1", params![item.photo_id]);
                        push_failure(&mut failed, item.photo_id, item.path, format!("Base de données non mise à jour : {error}"));
                        continue;
                    }
                }
                keyword_batches.push((item.path.clone(), meta.keyword_paths));
                face_batches.push((item.path.clone(), meta.faces));
                written_paths.insert(item.photo_id, item.path);
                written.push(KeywordWritten { photo_id: item.photo_id, keywords: meta.keywords, keyword_ids: Vec::new(), title: meta.title, description: meta.caption, gps_lat: meta.gps.map(|gps| gps.0), gps_lon: meta.gps.map(|gps| gps.1) });
            }
        }
    }
    let stored = store_photo_keywords_in(&tx, &keyword_batches).and_then(|_| {
        for photo in written.iter_mut() { photo.keyword_ids = photo_keyword_ids(&tx, photo.photo_id)?; }
        Ok(())
    });
    let stored = match stored {
        Ok(()) => {
            let committed = tx.commit();
            crate::semantic_keywords::on_keywords_changed(); // after the commit (see store_photo_keywords)
            committed
        }
        Err(error) => {
            drop(tx); // annule la transaction
            Err(error)
        }
    };
    if let Err(error) = stored {
        // Rien n'est enregistré en base : les fichiers déjà modifiés sont signalés en échec, la prochaine synchronisation les relira.
        for photo in written.drain(..) {
            let path = written_paths.remove(&photo.photo_id).unwrap_or_default();
            push_failure(&mut failed, photo.photo_id, path, format!("Base de données non mise à jour : {error}"));
        }
        face_batches.clear();
    }
    crate::faces::store_photo_faces(&conn, &face_batches);
    Ok(KeywordWriteResult { written, failed, cancelled, deleted: false, unlinked_persons: Vec::new() })
}

/// Écrit dans les fichiers, en une seule écriture par fichier, ce que chaque élément demande : l'ensemble final de ses mots-clés, son titre,
/// sa description (voir exif::write_metadata), puis relit les fichiers pour mettre la base à jour. Avec `task_id`, la progression est publiée et
/// l'arrêt de la tâche respecté.
#[tauri::command]
pub async fn apply_metadata_changes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    items: Vec<KeywordWriteItem>,
    task_id: Option<String>,
) -> Result<KeywordWriteResult, String> {
    let pool = state.pool();
    let cancel = task_id.as_deref().map(crate::scan_cancel_flag);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || run_write(&app, &pool, items, worker_task_id, cancel)).await;
    if let Some(id) = &task_id { crate::release_scan_cancel_flag(id); }
    outcome.map_err(|error| error.to_string())?
}

// ---------------------------------------------------------------------------
// Gestion de l'arborescence : création et suppression de mots-clés
// ---------------------------------------------------------------------------

/// Caractères refusés dans un nom : « / » et « | » séparent les niveaux dans les formats hiérarchiques, la virgule sépare les mots-clés du filtre.
const FORBIDDEN_NAME_CHARS: [char; 3] = ['/', '|', ','];

/// Nom nettoyé (espaces de début et de fin retirés) ; `invalid_name` s'il est vide ou contient un caractère refusé.
fn validate_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains(&FORBIDDEN_NAME_CHARS[..]) { return Err("invalid_name".to_string()); }
    Ok(trimmed.to_string())
}

/// Crée un mot-clé sous `parent_id` (0 = premier niveau). Erreurs : `invalid_name`, `unknown_parent`, `duplicate` (un frère de même nom existe déjà).
/// L'arbre est modifié tout de suite ; l'activation du mot-clé sur des photos reste une modification en attente.
#[tauri::command(async)]
pub fn create_keyword(state: State<'_, AppState>, parent_id: i64, name: String) -> Result<KeywordNode, String> {
    let name = validate_name(&name)?;
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    if parent_id != 0 {
        let parent_exists: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM keyword_nodes WHERE id = ?1)", params![parent_id], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if !parent_exists { return Err("unknown_parent".to_string()); }
    }
    let key = name_key(&name);
    let duplicate: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM keyword_nodes WHERE parent_id = ?1 AND name_key = ?2)", params![parent_id, key], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if duplicate { return Err("duplicate".to_string()); }
    conn.execute("INSERT INTO keyword_nodes (parent_id, name, name_key) VALUES (?1, ?2, ?3)", params![parent_id, name, key])
        .map_err(|error| error.to_string())?;
    let id = conn.last_insert_rowid();
    crate::semantic_keywords::on_keywords_changed(); // the parent may no longer be a leaf: keyword suggestions are rebuilt
    Ok(KeywordNode { id, parent_id, name })
}

/// Le mot-clé et tous ses descendants.
fn subtree_ids(conn: &Connection, keyword_id: i64) -> Result<Vec<i64>, String> {
    let mut statement = conn
        .prepare(
            "WITH RECURSIVE subtree(id) AS (
                SELECT id FROM keyword_nodes WHERE id = ?1
                UNION ALL
                SELECT n.id FROM keyword_nodes n JOIN subtree s ON n.parent_id = s.id
             ) SELECT id FROM subtree",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![keyword_id], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

#[derive(Serialize)]
pub struct KeywordDeleteInfo {
    /// Le mot-clé et ses descendants.
    pub keyword_count: i64,
    /// Photos qui portent au moins l'un d'eux.
    pub photo_count: i64,
}

/// Ce que supprimer un mot-clé (et son sous-arbre) entraînerait : de quoi remplir la fenêtre de confirmation.
#[tauri::command(async)]
pub fn get_keyword_delete_info(state: State<'_, AppState>, keyword_id: i64) -> Result<KeywordDeleteInfo, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let ids = subtree_ids(&conn, keyword_id)?;
    if ids.is_empty() { return Err("unknown_keyword".to_string()); }
    let ids_json = serde_json::to_string(&ids).map_err(|error| error.to_string())?;
    let photo_count: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT pk.photo_id) FROM photo_keywords pk JOIN photos p ON p.id = pk.photo_id
             WHERE pk.keyword_id IN (SELECT value FROM json_each(?1))",
            params![ids_json],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(KeywordDeleteInfo { keyword_count: ids.len() as i64, photo_count })
}

/// Photos du catalogue qui portent au moins un des mots-clés `ids`, chacune avec l'ensemble de ses mots-clés actifs moins ceux de `dropped`
/// (vide pour un renommage, le sous-arbre pour une suppression) : de quoi réécrire leurs fichiers.
fn photos_carrying(conn: &Connection, ids: &[i64], dropped: &HashSet<i64>) -> Result<Vec<KeywordWriteItem>, String> {
    let ids_json = serde_json::to_string(ids).map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT p.id, p.path, pk.keyword_id FROM photo_keywords pk JOIN photos p ON p.id = pk.photo_id
             WHERE pk.photo_id IN (SELECT photo_id FROM photo_keywords WHERE keyword_id IN (SELECT value FROM json_each(?1)))
             ORDER BY p.id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![ids_json], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))
        .map_err(|error| error.to_string())?;
    let mut items: Vec<KeywordWriteItem> = Vec::new();
    let mut index_of: HashMap<i64, usize> = HashMap::new();
    for (photo_id, path, keyword_id) in collect_rows(rows)? {
        let index = match index_of.get(&photo_id) {
            Some(index) => *index,
            None => {
                items.push(KeywordWriteItem { photo_id, path, keyword_ids: Some(Vec::new()), title: None, description: None, faces: None, gps: None });
                index_of.insert(photo_id, items.len() - 1);
                items.len() - 1
            }
        };
        if !dropped.contains(&keyword_id) { items[index].keyword_ids.get_or_insert_with(Vec::new).push(keyword_id); }
    }
    Ok(items)
}

/// Personne reliée à un mot-clé supprimé : (identifiant, identifiant du nœud, nom du mot-clé).
type PersonLink = (i64, i64, String);

/// Relie de nouveau les personnes déliées par une suppression qui n'a pas abouti (le mot-clé reste dans l'arbre). Au mieux : un échec est tracé.
fn restore_person_links(pool: &DbPool, linked: &[PersonLink]) {
    let conn = match pool.get() {
        Ok(conn) => conn,
        Err(error) => {
            eprintln!("Persons not relinked to their keywords: {error}");
            return;
        }
    };
    for (person_id, keyword_id, _) in linked {
        let restored = conn.execute("UPDATE persons SET keyword_node_id = ?1 WHERE id = ?2 AND keyword_node_id IS NULL", params![keyword_id, person_id]);
        if let Err(error) = restored { eprintln!("Person {person_id} not relinked to keyword {keyword_id}: {error}"); }
    }
}

/// Retire de l'arbre le mot-clé et ses descendants, avec leurs associations (une seule transaction).
pub(crate) fn delete_subtree(pool: &DbPool, keyword_id: i64) -> Result<(), String> {
    let conn = pool.get().map_err(|error| error.to_string())?;
    let ids = subtree_ids(&conn, keyword_id)?;
    let ids_json = serde_json::to_string(&ids).map_err(|error| error.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM photo_keywords WHERE keyword_id IN (SELECT value FROM json_each(?1))", params![ids_json]).map_err(|error| error.to_string())?;
    // Dismissed semantic suggestions of these keywords (semantic.rs) go with them.
    tx.execute("DELETE FROM keyword_suggestion_rejections WHERE keyword_id IN (SELECT value FROM json_each(?1))", params![ids_json])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM keyword_nodes WHERE id IN (SELECT value FROM json_each(?1))", params![ids_json]).map_err(|error| error.to_string())?;
    let committed = tx.commit().map_err(|error| error.to_string());
    crate::semantic_keywords::on_keywords_changed(); // the tree changed: keyword suggestions are rebuilt
    committed
}

fn run_delete(
    app: &tauri::AppHandle,
    pool: &DbPool,
    keyword_id: i64,
    task_id: Option<String>,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<KeywordWriteResult, String> {
    // Pour chaque photo qui porte le mot-clé ou l'un de ses descendants : ses mots-clés actifs moins ceux-là.
    let (items, linked) = {
        let conn = pool.get().map_err(|error| error.to_string())?;
        let ids = subtree_ids(&conn, keyword_id)?;
        if ids.is_empty() { return Err("unknown_keyword".to_string()); }
        let removed: HashSet<i64> = ids.iter().copied().collect();
        let items = photos_carrying(&conn, &ids, &removed)?;
        // Personnes reliées à ces mots-clés : déliées d'abord (elles gardent leur nom et leurs visages), sinon l'écriture de leurs visages
        // remettrait le mot-clé dans les fichiers (voir faces::plan_face_write). Si la suppression n'aboutit pas, elles sont reliées de nouveau.
        let ids_json = serde_json::to_string(&ids).map_err(|error| error.to_string())?;
        let linked: Vec<PersonLink> = {
            let mut statement = conn
                .prepare("SELECT p.id, p.keyword_node_id, COALESCE(k.name, p.name) FROM persons p JOIN keyword_nodes k ON k.id = p.keyword_node_id WHERE p.keyword_node_id IN (SELECT value FROM json_each(?1))")
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![ids_json], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(|error| error.to_string())?;
            collect_rows(rows)?
        };
        conn.execute("UPDATE persons SET keyword_node_id = NULL WHERE keyword_node_id IN (SELECT value FROM json_each(?1))", params![ids_json])
            .map_err(|error| error.to_string())?;
        (items, linked)
    };

    // Écriture des fichiers (même mécanisme que l'application des modifications : écriture atomique, relecture, base mise à jour).
    let mut result = match run_write(app, pool, items, task_id, cancel) {
        Ok(result) => result,
        Err(error) => {
            restore_person_links(pool, &linked);
            return Err(error);
        }
    };

    // Le mot-clé ne quitte l'arbre que si plus aucun fichier ne le porte : en cas d'échec ou d'arrêt, il reste pour les fichiers concernés.
    if result.failed.is_empty() && result.cancelled == 0 {
        if let Err(error) = delete_subtree(pool, keyword_id) {
            restore_person_links(pool, &linked);
            return Err(error);
        }
        result.deleted = true;
        result.unlinked_persons = linked.into_iter().map(|(id, _, name)| (id, name)).collect();
    } else {
        restore_person_links(pool, &linked);
    }
    Ok(result)
}

/// Supprime un mot-clé et son sous-arbre : il est retiré des fichiers de toutes les photos qui le portent, puis de l'arbre.
/// Avec `task_id`, la progression est publiée et l'arrêt de la tâche respecté.
#[tauri::command]
pub async fn delete_keyword(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    keyword_id: i64,
    task_id: Option<String>,
) -> Result<KeywordWriteResult, String> {
    let pool = state.pool();
    let cancel = task_id.as_deref().map(crate::scan_cancel_flag);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || run_delete(&app, &pool, keyword_id, worker_task_id, cancel)).await;
    if let Some(id) = &task_id { crate::release_scan_cancel_flag(id); }
    outcome.map_err(|error| error.to_string())?
}

fn run_rename(
    app: &tauri::AppHandle,
    pool: &DbPool,
    keyword_id: i64,
    name: String,
    task_id: Option<String>,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<KeywordWriteResult, String> {
    let name = validate_name(&name)?;
    let items = {
        let conn = pool.get().map_err(|error| error.to_string())?;
        let (parent_id, current_name): (i64, String) = conn
            .query_row("SELECT parent_id, name FROM keyword_nodes WHERE id = ?1", params![keyword_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|_| "unknown_keyword".to_string())?;
        // Un frère de même nom (casse ignorée) bloque le renommage ; changer seulement la casse du mot-clé lui-même est permis.
        let key = name_key(&name);
        let duplicate: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM keyword_nodes WHERE parent_id = ?1 AND name_key = ?2 AND id != ?3)",
                params![parent_id, key, keyword_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if duplicate { return Err("duplicate".to_string()); }
        // L'arbre est renommé d'abord : les chemins écrits dans les fichiers sont calculés d'après l'arbre. Appel répété (« Retenter ») sans effet ici.
        if current_name != name {
            conn.execute("UPDATE keyword_nodes SET name = ?1, name_key = ?2 WHERE id = ?3", params![name, key, keyword_id])
                .map_err(|error| error.to_string())?;
            // The name is read at each keyword → photos request (no stored text embedding); the suggestion model is rebuilt anyway.
            crate::semantic_keywords::on_keywords_changed();
        }
        // Personne reliée à ce mot-clé : ses zones de visage portent le nom du mot-clé, elles sont à réécrire (avec cette écriture pour les photos
        // qui portent le mot-clé, à la prochaine écriture des visages pour les autres).
        conn.execute(
            "UPDATE faces SET dirty = 1 WHERE state = 'confirmed' AND person_id IN (SELECT id FROM persons WHERE keyword_node_id = ?1)",
            params![keyword_id],
        )
        .map_err(|error| error.to_string())?;
        // Tous les fichiers dont un chemin passe par ce mot-clé (lui-même ou un descendant) portent l'ancien nom : ils sont réécrits, ensembles de mots-clés inchangés.
        let ids = subtree_ids(&conn, keyword_id)?;
        photos_carrying(&conn, &ids, &HashSet::new())?
    };
    run_write(app, pool, items, task_id, cancel)
}

/// Renomme un mot-clé dans l'arbre et réécrit les fichiers des photos qui le portent, lui ou l'un de ses descendants (même mécanisme que l'application
/// des modifications : écriture atomique, relecture, base mise à jour). Les fichiers déjà à jour sont laissés intacts, donc la relancer après un
/// échec ne réécrit que ce qui reste. Erreurs : `invalid_name`, `unknown_keyword`, `duplicate`.
#[tauri::command]
pub async fn rename_keyword(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    keyword_id: i64,
    name: String,
    task_id: Option<String>,
) -> Result<KeywordWriteResult, String> {
    let pool = state.pool();
    let cancel = task_id.as_deref().map(crate::scan_cancel_flag);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || run_rename(&app, &pool, keyword_id, name, worker_task_id, cancel)).await;
    if let Some(id) = &task_id { crate::release_scan_cancel_flag(id); }
    outcome.map_err(|error| error.to_string())?
}

/// Sets the reading priority of one metadata kind (`kind`: "keywords", "title", "description", "rating", "color", "pick", "gps" or "faces"):
/// `order` lists each of its source ids once, most important first (see exif::set_read_priority). It applies to the next file reads
/// (scan, rescan, sync).
#[tauri::command]
pub fn set_metadata_read_order(kind: String, order: Vec<String>) -> Result<(), String> {
    crate::exif::set_read_priority(&kind, &order)
}

#[cfg(test)]
#[path = "tests/keywords.rs"]
mod tests;
