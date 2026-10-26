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
fn ensure_node(conn: &Connection, parent_id: i64, name: &str) -> rusqlite::Result<i64> {
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

/// Mots-clés à donner à une photo : l'ensemble final des mots-clés actifs (identifiants de l'arbre).
#[derive(Deserialize)]
pub struct KeywordWriteItem {
    pub photo_id: i64,
    pub path: String,
    pub keyword_ids: Vec<i64>,
}

#[derive(Serialize)]
pub struct KeywordWritten {
    pub photo_id: i64,
    /// Mots-clés à plat de la photo tels que relus dans le fichier (colonne `keywords` de la base).
    pub keywords: String,
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

    // Écriture des fichiers (3 en parallèle), chacun de façon atomique. Une photo n'est jamais écrite deux fois en même temps.
    let total = valid.len().max(1);
    let done = AtomicUsize::new(0);
    let threads = rayon::ThreadPoolBuilder::new().num_threads(3).build().map_err(|error| error.to_string())?;
    // None : photo non traitée (tâche arrêtée) ; Some(Ok(chemins écrits)) ; Some(Err(message)).
    let outcomes: Vec<(KeywordWriteItem, Option<Result<Vec<Vec<String>>, String>>)> = threads.install(|| {
        valid
            .into_par_iter()
            .map(|item| {
                if cancel.as_ref().is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                    return (item, None);
                }
                let paths: Vec<Vec<String>> = item.keyword_ids.iter().filter_map(|id| node_path(&nodes, *id)).collect();
                let result = crate::exif::write_keywords(&item.path, &paths).map(|_| paths).map_err(|error| error.to_string());
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
    let mut cancelled = 0usize;
    let _ = conn.execute("BEGIN TRANSACTION", []);
    for (item, outcome) in outcomes {
        match outcome {
            None => cancelled += 1,
            Some(Err(error)) => failed.push(KeywordFailure { photo_id: item.photo_id, path: item.path, error }),
            Some(Ok(desired)) => {
                let meta = crate::exif::read_exif(Path::new(&item.path));
                if normalized_paths(&desired) != normalized_paths(&meta.keyword_paths) {
                    // Le fichier est modifié mais ne contient pas ce qui était demandé : la base n'est pas touchée, la prochaine synchronisation relira le fichier.
                    failed.push(KeywordFailure {
                        photo_id: item.photo_id,
                        path: item.path,
                        error: "Les mots-clés relus dans le fichier diffèrent de ceux écrits".to_string(),
                    });
                    continue;
                }
                match std::fs::metadata(&item.path) {
                    Ok(file) => {
                        let _ = conn.execute(
                            "UPDATE photos SET keywords = ?1, file_size = ?2, modified = ?3 WHERE id = ?4",
                            params![meta.keywords, file.len() as i64, crate::library_sync::modified_millis(&file), item.photo_id],
                        );
                    }
                    Err(_) => {
                        let _ = conn.execute("UPDATE photos SET keywords = ?1 WHERE id = ?2", params![meta.keywords, item.photo_id]);
                    }
                }
                keyword_batches.push((item.path.clone(), meta.keyword_paths));
                written.push(KeywordWritten { photo_id: item.photo_id, keywords: meta.keywords });
            }
        }
    }
    let _ = conn.execute("COMMIT", []);
    store_photo_keywords(&conn, &keyword_batches);
    Ok(KeywordWriteResult { written, failed, cancelled })
}

/// Écrit dans les fichiers l'ensemble final de mots-clés de chaque photo (XMP : dc:subject, digiKam, Lightroom, Media Pro, Microsoft ;
/// IPTC des JPEG), puis relit les fichiers pour mettre la base à jour. Avec `task_id`, la progression est publiée et l'arrêt de la tâche respecté.
#[tauri::command]
pub async fn apply_keyword_changes(
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
