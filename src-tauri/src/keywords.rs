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

/// Crée un nouveau mot-clé sous `parent_id` (0 = premier niveau). Retourne l'identifiant du nœud créé.
#[tauri::command(async)]
pub fn create_keyword(state: State<'_, AppState>, parent_id: i64, name: String) -> Result<i64, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let trimmed = name.trim();
    if trimmed.is_empty() { return Err("Nom vide".into()); }
    // Refuser les caractères séparateurs et la virgule
    if trimmed.contains('/') || trimmed.contains('|') || trimmed.contains(',') {
        return Err("Caractères interdits : / | ,".into());
    }
    let key = name_key(trimmed);
    conn.execute("INSERT OR IGNORE INTO keyword_nodes (parent_id, name, name_key) VALUES (?1, ?2, ?3)", params![parent_id, trimmed, key])
        .map_err(|error| error.to_string())?;
    let id = conn.query_row("SELECT id FROM keyword_nodes WHERE parent_id = ?1 AND name_key = ?2", params![parent_id, key], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(id)
}

/// Supprime un mot-clé et tout son sous-arbre (récursif). Retourne le nombre de nœuds supprimés.
#[tauri::command(async)]
pub fn delete_keyword(state: State<'_, AppState>, keyword_id: i64) -> Result<i64, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let _ = conn.execute("BEGIN TRANSACTION", []);
    // Récupérer tout le sous-arbre (CTE récursif)
    let mut to_delete = Vec::new();
    let mut stmt = conn.prepare("WITH RECURSIVE subtree(id) AS (
        SELECT ?1
        UNION ALL
        SELECT kn.id FROM keyword_nodes kn JOIN subtree st ON kn.parent_id = st.id
    ) SELECT id FROM subtree")
        .map_err(|error| error.to_string())?;
    let rows = stmt.query_map(params![keyword_id], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?;
    for row in rows { if let Ok(id) = row { to_delete.push(id); } }
    // Supprimer les associations photo ↔ mot-clé pour tous ces nœuds
    if !to_delete.is_empty() {
        let placeholders = to_delete.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("DELETE FROM photo_keywords WHERE keyword_id IN ({})", placeholders);
        let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let params_vec: Vec<&dyn rusqlite::ToSql> = to_delete.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        stmt.execute(rusqlite::params_from_iter(params_vec.iter().cloned())).map_err(|error| error.to_string())?;
    }
    // Supprimer les nœuds
    if !to_delete.is_empty() {
        let placeholders = to_delete.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("DELETE FROM keyword_nodes WHERE id IN ({})", placeholders);
        let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let params_vec: Vec<&dyn rusqlite::ToSql> = to_delete.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        stmt.execute(rusqlite::params_from_iter(params_vec.iter().cloned())).map_err(|error| error.to_string())?;
    }
    let _ = conn.execute("COMMIT", []);
    Ok(to_delete.len() as i64)
}

/// Renomme un mot-clé (vérifie l'unicité sous le même parent).
#[tauri::command(async)]
pub fn rename_keyword(state: State<'_, AppState>, keyword_id: i64, name: String) -> Result<(), String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let trimmed = name.trim();
    if trimmed.is_empty() { return Err("Nom vide".into()); }
    if trimmed.contains('/') || trimmed.contains('|') || trimmed.contains(',') {
        return Err("Caractères interdits : / | ,".into());
    }
    let key = name_key(trimmed);
    // Vérifier l'unicité sous le même parent
    let parent_id: i64 = conn.query_row("SELECT parent_id FROM keyword_nodes WHERE id = ?1", params![keyword_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let exists: i64 = conn.query_row("SELECT COUNT(*) FROM keyword_nodes WHERE parent_id = ?1 AND name_key = ?2 AND id != ?3",
        params![parent_id, key, keyword_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    if exists > 0 { return Err("Un mot-clé de ce nom existe déjà sous ce parent".into()); }
    conn.execute("UPDATE keyword_nodes SET name = ?1, name_key = ?2 WHERE id = ?3", params![trimmed, key, keyword_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Écrit les mots-clés actifs dans les fichiers sélectionnés ET met à jour la base de données.
/// `items` : liste de (chemin_fichier, chemins_mots_clés_actifs) où chaque chemin_mots_clés_actifs est un Vec<Vec<String>>
/// ex. [("photo.jpg", [["Lieux", "France", "Paris"], ["Sujet", "Portrait"]])]
/// Retourne la liste des chemins ayant échoué (vide = tout réussi).
#[tauri::command(async)]
pub fn write_keywords_to_files(state: State<'_, AppState>, items: Vec<(String, Vec<Vec<String>>)>) -> Result<Vec<String>, String> {
    use crate::exif::write_keywords;
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let mut failed = Vec::new();

    for (path, keyword_paths) in items {
        // Écrire dans le fichier
        if let Err(e) = write_keywords(&path, &keyword_paths) {
            eprintln!("Échec écriture mots-clés pour {}: {}", path, e);
            failed.push(path.clone());
            continue;
        }

        // Mettre à jour la base de données pour cette photo
        let photo_id: i64 = match conn.query_row("SELECT id FROM photos WHERE path = ?1", params![&path], |row| row.get(0)) {
            Ok(id) => id,
            Err(_) => {
                failed.push(path.clone());
                continue;
            }
        };

        // Supprimer les anciennes associations pour cette photo
        let _ = conn.execute("DELETE FROM photo_keywords WHERE photo_id = ?1", params![photo_id]);

        // Insérer les nouvelles associations (seul le dernier niveau de chaque chemin est actif)
        for segments in keyword_paths {
            if segments.is_empty() { continue; }
            let mut parent_id = 0i64;
            let mut complete = true;
            for segment in segments {
                match ensure_node(&conn, parent_id, &segment) {
                    Ok(id) => parent_id = id,
                    Err(_) => { complete = false; break; }
                }
            }
            if complete {
                let _ = conn.execute("INSERT OR IGNORE INTO photo_keywords (photo_id, keyword_id) VALUES (?1, ?2)", params![photo_id, parent_id]);
            }
        }
    }

    Ok(failed)
}
