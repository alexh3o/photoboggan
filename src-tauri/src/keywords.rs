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
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{Emitter, State};

use crate::db::DbPool;
use crate::AppState;

/// Nœud de l'arbre envoyé à l'interface (`parent_id` 0 = premier niveau).
#[derive(Serialize)]
pub struct KeywordNode {
    pub id: i64,
    pub parent_id: i64,
    pub name: String,
}

/// Nombre de photos de la sélection qui portent un mot-clé (seuls les mots-clés portés par au moins une photo sont listés).
#[derive(Serialize)]
pub struct KeywordCount {
    pub keyword_id: i64,
    pub count: i64,
}

/// Crée les tables à l'ouverture de la base (sans toucher aux données existantes). Appelée par `db::init_db`, après la création de `photos`.
pub fn init_schema(conn: &Connection) {
    let _ = conn.execute_batch(
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
    );
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
/// À appeler après l'insertion des photos en base (leur identifiant doit exister).
pub fn store_photo_keywords(conn: &Connection, items: &[(String, Vec<Vec<String>>)]) {
    if items.is_empty() { return; }
    let _ = conn.execute("BEGIN TRANSACTION", []);
    for (path, keyword_paths) in items {
        let Ok(photo_id) = conn.query_row("SELECT id FROM photos WHERE path = ?1", params![path], |row| row.get::<_, i64>(0)) else { continue; };
        let _ = conn.execute("DELETE FROM photo_keywords WHERE photo_id = ?1", params![photo_id]);
        for segments in keyword_paths {
            let mut parent_id = 0i64;
            let mut complete = !segments.is_empty();
            for segment in segments {
                match ensure_node(conn, parent_id, segment) {
                    Ok(id) => parent_id = id,
                    Err(_) => { complete = false; break; }
                }
            }
            if complete {
                // Seul le dernier niveau du chemin est actif.
                let _ = conn.execute("INSERT OR IGNORE INTO photo_keywords (photo_id, keyword_id) VALUES (?1, ?2)", params![photo_id, parent_id]);
            }
        }
    }
    let _ = conn.execute("COMMIT", []);
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
    let nodes: Vec<KeywordNode> = rows.filter_map(|row| row.ok()).collect();
    Ok(nodes)
}

/// Pour une sélection de photos : combien de photos portent chaque mot-clé.
#[tauri::command(async)]
pub fn get_keyword_counts(state: State<'_, AppState>, photo_ids: Vec<i64>) -> Result<Vec<KeywordCount>, String> {
    if photo_ids.is_empty() { return Ok(Vec::new()); }
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    // Liste des identifiants passée en JSON : une seule requête, quel que soit le nombre de photos sélectionnées.
    let ids_json = serde_json::to_string(&photo_ids).map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT keyword_id, COUNT(*) FROM photo_keywords
             WHERE photo_id IN (SELECT value FROM json_each(?1))
             GROUP BY keyword_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![ids_json], |row| Ok(KeywordCount { keyword_id: row.get(0)?, count: row.get(1)? }))
        .map_err(|error| error.to_string())?;
    let counts: Vec<KeywordCount> = rows.filter_map(|row| row.ok()).collect();
    Ok(counts)
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
    let pairs: Vec<(i64, i64)> = rows.filter_map(|row| row.ok()).collect();
    Ok(pairs)
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
    let usage: Vec<(i64, i64)> = rows.filter_map(|row| row.ok()).collect();
    Ok(usage)
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
}

#[derive(Serialize)]
pub struct KeywordWritten {
    pub photo_id: i64,
    /// Mots-clés à plat de la photo tels que relus dans le fichier (colonne `keywords` de la base).
    pub keywords: String,
    /// Titre et description retenus à la relecture du fichier (colonnes `title` et `caption`).
    pub title: String,
    pub description: String,
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

fn normalized_paths(paths: &[Vec<String>]) -> HashSet<String> {
    paths.iter().map(|segments| segments.iter().map(|segment| segment.trim().to_lowercase()).collect::<Vec<_>>().join(&char::from(1u8).to_string())).collect()
}

fn run_write(
    app: &tauri::AppHandle,
    pool: &DbPool,
    items: Vec<KeywordWriteItem>,
    task_id: Option<String>,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<KeywordWriteResult, String> {
    let conn = pool.get().map_err(|error| error.to_string())?;
    let mut nodes: HashMap<i64, (i64, String)> = HashMap::new();
    {
        let mut statement = conn.prepare("SELECT id, parent_id, name FROM keyword_nodes").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)))
            .map_err(|error| error.to_string())?;
        for row in rows.flatten() { nodes.insert(row.0, (row.1, row.2)); }
    }

    // Seules les photos du catalogue sont écrites (identifiant et chemin doivent correspondre).
    let mut failed: Vec<KeywordFailure> = Vec::new();
    let mut valid: Vec<KeywordWriteItem> = Vec::new();
    for item in items {
        let known: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM photos WHERE id = ?1 AND path = ?2)", params![item.photo_id, item.path], |row| row.get(0))
            .unwrap_or(false);
        if known {
            valid.push(item);
        } else {
            failed.push(KeywordFailure { photo_id: item.photo_id, path: item.path, error: "Photo absente du catalogue".to_string() });
        }
    }

    // Visages à écrire avec la photo (demandés, ou en attente) : zones et mots-clés des personnes, calculés avant l'écriture.
    let mut face_plans: HashMap<i64, crate::faces::FaceWritePlan> = HashMap::new();
    let mut unplanned: HashSet<i64> = HashSet::new();
    for item in &valid {
        if item.faces == Some(true) || crate::faces::has_pending_face_write(&conn, item.photo_id) {
            match crate::faces::plan_face_write(&conn, item.photo_id, item.keyword_ids.as_deref()) {
                Ok(plan) => { face_plans.insert(item.photo_id, plan); }
                Err(error) => {
                    unplanned.insert(item.photo_id);
                    failed.push(KeywordFailure { photo_id: item.photo_id, path: item.path.clone(), error });
                }
            }
        }
    }
    valid.retain(|item| !unplanned.contains(&item.photo_id));

    // Écriture des fichiers (3 en parallèle), chacun de façon atomique. Une photo n'est jamais écrite deux fois en même temps.
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
                let update = crate::exif::MetadataUpdate {
                    keywords: keyword_ids.map(|ids| ids.iter().filter_map(|id| node_path(&nodes, *id)).collect()),
                    title: item.title.clone(),
                    description: item.description.clone(),
                    regions: plan.map(|plan| plan.regions.clone()),
                };
                let result = crate::exif::write_metadata(&item.path, &update).map(|_| update).map_err(|error| error.to_string());
                let finished = done.fetch_add(1, Ordering::SeqCst) + 1;
                if let Some(id) = &task_id {
                    let _ = app.emit("scan-progress", crate::ScanProgress { task_id: id.clone(), percent: (finished * 100 / total) as u32 });
                }
                (item, Some(result))
            })
            .collect()
    });

    // Vérification et mise à jour de la base : ce qui est enregistré est ce que le fichier contient réellement après relecture.
    let mut written: Vec<KeywordWritten> = Vec::new();
    let mut keyword_batches: Vec<(String, Vec<Vec<String>>)> = Vec::new();
    let mut face_batches: Vec<(String, crate::faces::PhotoFaces)> = Vec::new();
    let mut cancelled = 0usize;
    let _ = conn.execute("BEGIN TRANSACTION", []);
    for (item, outcome) in outcomes {
        match outcome {
            None => cancelled += 1,
            Some(Err(error)) => failed.push(KeywordFailure { photo_id: item.photo_id, path: item.path, error }),
            Some(Ok(update)) => {
                let meta = crate::exif::read_exif(Path::new(&item.path));
                // Le fichier est modifié mais ne contient pas ce qui était demandé : la base n'est pas touchée, la prochaine synchronisation relira le fichier.
                let mismatch = match &update.keywords {
                    Some(desired) if normalized_paths(desired) != normalized_paths(&meta.keyword_paths) => {
                        Some("Les mots-clés relus dans le fichier diffèrent de ceux écrits".to_string())
                    }
                    _ => crate::exif::text_mismatch(Path::new(&item.path), &update, &meta),
                }
                .or_else(|| update.regions.as_ref().and_then(|regions| regions_mismatch(Path::new(&item.path), regions)));
                if let Some(error) = mismatch {
                    failed.push(KeywordFailure { photo_id: item.photo_id, path: item.path, error });
                    continue;
                }
                match std::fs::metadata(&item.path) {
                    Ok(file) => {
                        let _ = conn.execute(
                            "UPDATE photos SET keywords = ?1, title = ?2, caption = ?3, file_size = ?4, modified = ?5 WHERE id = ?6",
                            params![meta.keywords, meta.title, meta.caption, file.len() as i64, crate::library_sync::modified_millis(&file), item.photo_id],
                        );
                    }
                    Err(_) => {
                        let _ = conn.execute(
                            "UPDATE photos SET keywords = ?1, title = ?2, caption = ?3 WHERE id = ?4",
                            params![meta.keywords, meta.title, meta.caption, item.photo_id],
                        );
                    }
                }
                if let Some(plan) = face_plans.get(&item.photo_id) { crate::faces::finish_face_write(&conn, item.photo_id, plan); }
                keyword_batches.push((item.path.clone(), meta.keyword_paths));
                face_batches.push((item.path.clone(), meta.faces));
                written.push(KeywordWritten { photo_id: item.photo_id, keywords: meta.keywords, title: meta.title, description: meta.caption });
            }
        }
    }
    let _ = conn.execute("COMMIT", []);
    store_photo_keywords(&conn, &keyword_batches);
    crate::faces::store_photo_faces(&conn, &face_batches);
    Ok(KeywordWriteResult { written, failed, cancelled, deleted: false })
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
    Ok(KeywordNode { id: conn.last_insert_rowid(), parent_id, name })
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
    let ids: Vec<i64> = rows.filter_map(|row| row.ok()).collect();
    Ok(ids)
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
    for (photo_id, path, keyword_id) in rows.flatten() {
        let index = match index_of.get(&photo_id) {
            Some(index) => *index,
            None => {
                items.push(KeywordWriteItem { photo_id, path, keyword_ids: Some(Vec::new()), title: None, description: None, faces: None });
                index_of.insert(photo_id, items.len() - 1);
                items.len() - 1
            }
        };
        if !dropped.contains(&keyword_id) { items[index].keyword_ids.get_or_insert_with(Vec::new).push(keyword_id); }
    }
    Ok(items)
}

fn run_delete(
    app: &tauri::AppHandle,
    pool: &DbPool,
    keyword_id: i64,
    task_id: Option<String>,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<KeywordWriteResult, String> {
    // Pour chaque photo qui porte le mot-clé ou l'un de ses descendants : ses mots-clés actifs moins ceux-là.
    let items = {
        let conn = pool.get().map_err(|error| error.to_string())?;
        let ids = subtree_ids(&conn, keyword_id)?;
        if ids.is_empty() { return Err("unknown_keyword".to_string()); }
        let removed: HashSet<i64> = ids.iter().copied().collect();
        // Personnes reliées à ces mots-clés : déliées d'abord (elles gardent leur nom et leurs visages), sinon l'écriture de leurs visages
        // remettrait le mot-clé dans les fichiers (voir faces::plan_face_write).
        let ids_json = serde_json::to_string(&ids).map_err(|error| error.to_string())?;
        let _ = conn.execute("UPDATE persons SET keyword_node_id = NULL WHERE keyword_node_id IN (SELECT value FROM json_each(?1))", params![ids_json]);
        photos_carrying(&conn, &ids, &removed)?
    };

    // Écriture des fichiers (même mécanisme que l'application des modifications : écriture atomique, relecture, base mise à jour).
    let mut result = run_write(app, pool, items, task_id, cancel)?;

    // Le mot-clé ne quitte l'arbre que si plus aucun fichier ne le porte : en cas d'échec ou d'arrêt, il reste pour les fichiers concernés.
    if result.failed.is_empty() && result.cancelled == 0 {
        let conn = pool.get().map_err(|error| error.to_string())?;
        let ids = subtree_ids(&conn, keyword_id)?;
        let ids_json = serde_json::to_string(&ids).map_err(|error| error.to_string())?;
        let _ = conn.execute("DELETE FROM photo_keywords WHERE keyword_id IN (SELECT value FROM json_each(?1))", params![ids_json]);
        conn.execute("DELETE FROM keyword_nodes WHERE id IN (SELECT value FROM json_each(?1))", params![ids_json])
            .map_err(|error| error.to_string())?;
        result.deleted = true;
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
        }
        // Personne reliée à ce mot-clé : ses zones de visage portent le nom du mot-clé, elles sont à réécrire (avec cette écriture pour les photos
        // qui portent le mot-clé, à la prochaine écriture des visages pour les autres).
        let _ = conn.execute(
            "UPDATE faces SET dirty = 1 WHERE state IN ('auto', 'confirmed') AND person_id IN (SELECT id FROM persons WHERE keyword_node_id = ?1)",
            params![keyword_id],
        );
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

/// Règle l'ordre de priorité à la lecture d'un type de métadonnée (`kind` : « keywords », « title », « description », « rating » ou « color ») :
/// `order` liste une fois chacun des identifiants de ses sources, du plus au moins prioritaire (voir exif::set_read_priority). Il s'applique
/// aux prochaines lectures de fichiers (scan, relecture, synchronisation).
#[tauri::command]
pub fn set_metadata_read_order(kind: String, order: Vec<String>) -> Result<(), String> {
    crate::exif::set_read_priority(&kind, &order)
}
