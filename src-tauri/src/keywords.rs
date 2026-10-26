//! Mots-clés hiérarchiques : arborescence (table `keyword_nodes`) et association photo ↔ mot-clé (table `photo_keywords`).
//!
//! Modèle (choisi avec l'utilisateur) :
//! - un nœud de l'arbre = un nom sous un parent (parent_id = 0 : premier niveau) ; deux frères ne diffèrent jamais que par leur nom,
//!   casse ignorée ;
//! - une photo « porte » un mot-clé quand une ligne de `photo_keywords` le désigne : seul le dernier niveau d'un chemin lu dans un fichier
//!   est actif. Les ancêtres ne le sont que s'ils ont leur propre entrée dans le fichier ;
//! - l'arbre grandit à la lecture des fichiers (scan, relecture, synchronisation) : un chemin hiérarchique vu dans un nouveau fichier y est ajouté.
//!   Il n'est jamais élagué automatiquement (un nœud sans photo reste dans l'arbre).
//!
//! Étape 1 (lecture) : stockage, lecture de l'arbre et comptage par sélection. L'édition et l'écriture dans les fichiers viennent ensuite.

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

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

/// Pour une sélection de photos : combien de photos portent chaque mot-clé. L'interface en déduit l'état de chaque case
/// (toutes les photos = cochée, quelques-unes = remplie, aucune = vide).
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
