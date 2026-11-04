//! Albums virtuels : arborescence de dossiers, d'albums manuels et d'albums intelligents, qui n'existent que dans la base (table `album_nodes`).
//!
//! Modèle (choisi avec l'utilisateur) :
//! - trois types de nœuds : `folder` (dossier virtuel), `manual` (contenu choisi à la main, table `album_photos`) et `smart` (filtres enregistrés
//!   dans `filters`, au format JSON propre à l'interface : critères de recherche et dossiers physiques, jamais d'identifiants de photos) ;
//! - parent_id = 0 : racine. Deux frères ne diffèrent jamais que par leur nom, casse ignorée ;
//! - un dossier virtuel peut contenir tout type de nœud. Un album manuel n'a jamais d'enfant. Un album intelligent n'a pour enfants que des
//!   albums intelligents (ils s'ajoutent à ses filtres) ; il peut aussi être enfant d'un album manuel (il filtre son contenu) ;
//! - une photo peut appartenir à plusieurs albums manuels ; supprimée du catalogue, elle quitte tous les albums (déclencheur SQL : il couvre
//!   tous les endroits du code qui suppriment des photos).

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;

use crate::AppState;

pub const KIND_FOLDER: &str = "folder";
pub const KIND_MANUAL: &str = "manual";
pub const KIND_SMART: &str = "smart";

/// Nœud envoyé à l'interface (`parent_id` 0 = racine). `count` : nombre de photos d'un album manuel ; None pour un dossier et un album
/// intelligent (leur contenu dépend des filtres, évalués par l'interface).
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct AlbumNode {
    pub id: i64,
    pub parent_id: i64,
    pub kind: String,
    pub name: String,
    pub filters: String,
    pub count: Option<i64>,
}

/// Crée les tables à l'ouverture de la base (sans toucher aux données existantes). Appelée par `db::init_db`, après la création de `photos`.
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS album_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_id INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL,
            filters TEXT NOT NULL DEFAULT '{}',
            UNIQUE(parent_id, name_key)
        );
        CREATE TABLE IF NOT EXISTS album_photos (
            album_id INTEGER NOT NULL,
            photo_id INTEGER NOT NULL,
            PRIMARY KEY (album_id, photo_id)
        );
        CREATE INDEX IF NOT EXISTS idx_album_photos_photo ON album_photos(photo_id);
        -- Une photo retirée du catalogue quitte tous les albums.
        CREATE TRIGGER IF NOT EXISTS album_photos_photo_deleted AFTER DELETE ON photos
        BEGIN
            DELETE FROM album_photos WHERE photo_id = OLD.id;
        END;
        DELETE FROM album_photos WHERE photo_id NOT IN (SELECT id FROM photos);",
    )
}

/// Clé de comparaison d'un nom : casse ignorée.
fn name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Nom accepté pour un nœud (espaces de bord retirés), ou message d'erreur affiché tel quel dans la fenêtre de saisie.
fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() { return Err("The name is empty".into()); }
    if name.chars().count() > 120 { return Err("The name is too long".into()); }
    Ok(name.to_string())
}

fn row_to_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<AlbumNode> {
    Ok(AlbumNode { id: row.get(0)?, parent_id: row.get(1)?, kind: row.get(2)?, name: row.get(3)?, filters: row.get(4)?, count: row.get(5)? })
}

const NODE_SELECT: &str = "SELECT n.id, n.parent_id, n.kind, n.name, n.filters,
    CASE n.kind WHEN 'manual' THEN (SELECT COUNT(*) FROM album_photos p WHERE p.album_id = n.id) END
    FROM album_nodes n";

/// Tous les nœuds, à plat (l'interface reconstruit l'arbre d'après `parent_id`).
pub fn list_nodes(conn: &Connection) -> rusqlite::Result<Vec<AlbumNode>> {
    conn.prepare(&format!("{NODE_SELECT} ORDER BY n.id"))?.query_map([], row_to_node)?.collect()
}

fn get_node(conn: &Connection, id: i64) -> Result<AlbumNode, String> {
    conn.query_row(&format!("{NODE_SELECT} WHERE n.id = ?1"), params![id], row_to_node)
        .optional().map_err(|e| e.to_string())?
        .ok_or_else(|| "Album not found".to_string())
}

/// Type du parent (None : racine, qui accepte tout).
fn parent_kind(conn: &Connection, parent_id: i64) -> Result<Option<String>, String> {
    if parent_id == 0 { return Ok(None); }
    Ok(Some(get_node(conn, parent_id)?.kind))
}

/// Un nœud de type `kind` peut-il être placé sous un parent de type `parent` ? Dossier virtuel ou racine : tout. Album intelligent ou manuel : seul
/// un album intelligent (qui ajoute ses filtres à ceux du parent, ou filtre le contenu du manuel).
fn can_contain(parent: Option<&str>, kind: &str) -> bool {
    match parent {
        None | Some(KIND_FOLDER) => true,
        Some(_) => kind == KIND_SMART,
    }
}

/// Vérifie qu'un nœud de type `kind` peut vivre sous `parent_id` ; message d'erreur lisible sinon.
fn check_parent(conn: &Connection, parent_id: i64, kind: &str) -> Result<(), String> {
    let parent = parent_kind(conn, parent_id)?;
    if can_contain(parent.as_deref(), kind) { Ok(()) } else { Err("This item cannot be placed here".into()) }
}

/// Le nom est-il déjà pris sous ce parent (hors le nœud `except`) ?
fn name_taken(conn: &Connection, parent_id: i64, name: &str, except: i64) -> Result<bool, String> {
    conn.query_row("SELECT COUNT(*) FROM album_nodes WHERE parent_id = ?1 AND name_key = ?2 AND id <> ?3", params![parent_id, name_key(name), except], |r| r.get::<_, i64>(0))
        .map(|n| n > 0).map_err(|e| e.to_string())
}

/// `candidate` est-il `node_id` lui-même ou l'un de ses descendants ? (interdit de déplacer un nœud dans sa propre descendance)
fn is_self_or_descendant(conn: &Connection, node_id: i64, candidate: i64) -> Result<bool, String> {
    let mut current = candidate;
    for _ in 0..10_000 {
        if current == node_id { return Ok(true); }
        if current == 0 { return Ok(false); }
        current = conn.query_row("SELECT parent_id FROM album_nodes WHERE id = ?1", params![current], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or(0);
    }
    Err("Album tree too deep".into())
}

/// Identifiants du nœud et de tous ses descendants.
fn subtree_ids(conn: &Connection, root: i64) -> Result<Vec<i64>, String> {
    let mut ids = vec![root];
    let mut index = 0;
    while index < ids.len() {
        let children: Vec<i64> = conn.prepare("SELECT id FROM album_nodes WHERE parent_id = ?1").map_err(|e| e.to_string())?
            .query_map(params![ids[index]], |r| r.get(0)).map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?;
        ids.extend(children);
        index += 1;
    }
    Ok(ids)
}

/// Crée un nœud sous `parent_id` ; renvoie son identifiant.
pub fn create_node(conn: &Connection, parent_id: i64, kind: &str, name: &str) -> Result<i64, String> {
    if ![KIND_FOLDER, KIND_MANUAL, KIND_SMART].contains(&kind) { return Err("Unknown album type".into()); }
    let name = clean_name(name)?;
    check_parent(conn, parent_id, kind)?;
    if name_taken(conn, parent_id, &name, 0)? { return Err("An item with this name already exists here".into()); }
    conn.execute("INSERT INTO album_nodes (parent_id, kind, name, name_key) VALUES (?1, ?2, ?3, ?4)", params![parent_id, kind, name, name_key(&name)]).map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_node(conn: &Connection, id: i64, name: &str) -> Result<(), String> {
    let name = clean_name(name)?;
    let node = get_node(conn, id)?;
    if name_taken(conn, node.parent_id, &name, id)? { return Err("An item with this name already exists here".into()); }
    conn.execute("UPDATE album_nodes SET name = ?2, name_key = ?3 WHERE id = ?1", params![id, name, name_key(&name)]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Supprime le nœud et toute sa descendance (les photos ne sont pas touchées, seules les appartenances aux albums disparaissent).
pub fn delete_node(conn: &Connection, id: i64) -> Result<(), String> {
    get_node(conn, id)?;
    let ids = subtree_ids(conn, id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for node in ids {
        tx.execute("DELETE FROM album_photos WHERE album_id = ?1", params![node]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM album_nodes WHERE id = ?1", params![node]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Déplace le nœud sous `new_parent_id`. Un album intelligent déplacé garde ses propres filtres : seul son parent (donc ce dont il hérite) change.
pub fn move_node(conn: &Connection, id: i64, new_parent_id: i64) -> Result<(), String> {
    let node = get_node(conn, id)?;
    if node.parent_id == new_parent_id { return Ok(()); }
    if is_self_or_descendant(conn, id, new_parent_id)? { return Err("An item cannot be moved into itself".into()); }
    check_parent(conn, new_parent_id, &node.kind)?;
    if name_taken(conn, new_parent_id, &node.name, id)? { return Err("An item with this name already exists here".into()); }
    conn.execute("UPDATE album_nodes SET parent_id = ?2 WHERE id = ?1", params![id, new_parent_id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Premier nom libre sous `parent_id` de la forme « Nom (copie) », « Nom (copie 2) »…
fn copy_name(conn: &Connection, parent_id: i64, name: &str, suffix: &str) -> Result<String, String> {
    let mut candidate = format!("{name} ({suffix})");
    let mut number = 2;
    while name_taken(conn, parent_id, &candidate, 0)? {
        candidate = format!("{name} ({suffix} {number})");
        number += 1;
    }
    Ok(candidate)
}

/// Copie le nœud sous `new_parent_id` (récursivement pour un dossier ou un album intelligent qui a des enfants). Les filtres propres sont copiés,
/// le contenu d'un album manuel aussi. La copie prend un nom libre : « Nom (copie) ». Renvoie l'identifiant de la copie.
pub fn copy_node(conn: &Connection, id: i64, new_parent_id: i64, suffix: &str) -> Result<i64, String> {
    let node = get_node(conn, id)?;
    if is_self_or_descendant(conn, id, new_parent_id)? { return Err("An item cannot be copied into itself".into()); }
    check_parent(conn, new_parent_id, &node.kind)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let copy = copy_in(&tx, id, new_parent_id, suffix, true)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(copy)
}

fn copy_in(conn: &Connection, id: i64, parent_id: i64, suffix: &str, rename: bool) -> Result<i64, String> {
    let node = get_node(conn, id)?;
    // Seule la racine de la copie est renommée (si besoin) ; les enfants gardent leur nom dans leur nouveau parent, toujours vide.
    let name = if rename && name_taken(conn, parent_id, &node.name, 0)? { copy_name(conn, parent_id, &node.name, suffix)? } else { node.name.clone() };
    conn.execute("INSERT INTO album_nodes (parent_id, kind, name, name_key, filters) VALUES (?1, ?2, ?3, ?4, ?5)", params![parent_id, node.kind, name, name_key(&name), node.filters]).map_err(|e| e.to_string())?;
    let copy = conn.last_insert_rowid();
    conn.execute("INSERT INTO album_photos (album_id, photo_id) SELECT ?2, photo_id FROM album_photos WHERE album_id = ?1", params![id, copy]).map_err(|e| e.to_string())?;
    let children: Vec<i64> = conn.prepare("SELECT id FROM album_nodes WHERE parent_id = ?1").map_err(|e| e.to_string())?
        .query_map(params![id], |r| r.get(0)).map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?;
    for child in children { copy_in(conn, child, copy, suffix, false)?; }
    Ok(copy)
}

/// Enregistre les filtres propres d'un album intelligent (JSON fourni par l'interface).
pub fn set_filters(conn: &Connection, id: i64, filters: &str) -> Result<(), String> {
    let node = get_node(conn, id)?;
    if node.kind != KIND_SMART { return Err("Only smart albums have filters".into()); }
    serde_json::from_str::<serde_json::Value>(filters).map_err(|_| "Invalid filters".to_string())?;
    conn.execute("UPDATE album_nodes SET filters = ?2 WHERE id = ?1", params![id, filters]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Vérifie que le nœud est un album manuel (seul type qui a un contenu choisi à la main).
fn require_manual(conn: &Connection, album_id: i64) -> Result<(), String> {
    if get_node(conn, album_id)?.kind == KIND_MANUAL { Ok(()) } else { Err("Only manual albums have a chosen content".into()) }
}

/// Ajoute des photos à un album manuel ; renvoie les identifiants réellement ajoutés (ceux déjà présents ou absents du catalogue sont ignorés).
/// Cette liste permet d'annuler l'ajout sans retirer ce qui était déjà dans l'album.
pub fn add_photos_listed(conn: &Connection, album_id: i64, photo_ids: &[i64]) -> Result<Vec<i64>, String> {
    require_manual(conn, album_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut added = Vec::new();
    for photo_id in photo_ids {
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO album_photos (album_id, photo_id) SELECT ?1, id FROM photos WHERE id = ?2",
            params![album_id, photo_id],
        ).map_err(|e| e.to_string())?;
        if inserted > 0 { added.push(*photo_id); }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(added)
}

/// Comme `add_photos_listed`, mais ne renvoie que le nombre de photos ajoutées.
pub fn add_photos(conn: &Connection, album_id: i64, photo_ids: &[i64]) -> Result<usize, String> {
    add_photos_listed(conn, album_id, photo_ids).map(|added| added.len())
}

/// Retire des photos d'un album manuel (les fichiers et le catalogue ne sont pas touchés) ; renvoie le nombre de photos retirées.
pub fn remove_photos(conn: &Connection, album_id: i64, photo_ids: &[i64]) -> Result<usize, String> {
    require_manual(conn, album_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut removed = 0;
    for photo_id in photo_ids {
        removed += tx.execute("DELETE FROM album_photos WHERE album_id = ?1 AND photo_id = ?2", params![album_id, photo_id]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(removed)
}

/// Remplace tout le contenu d'un album manuel par ces photos, en une seule transaction (rien n'est perdu si l'opération échoue).
pub fn replace_photos(conn: &Connection, album_id: i64, photo_ids: &[i64]) -> Result<usize, String> {
    require_manual(conn, album_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM album_photos WHERE album_id = ?1", params![album_id]).map_err(|e| e.to_string())?;
    let mut added = 0;
    for photo_id in photo_ids {
        added += tx.execute(
            "INSERT OR IGNORE INTO album_photos (album_id, photo_id) SELECT ?1, id FROM photos WHERE id = ?2",
            params![album_id, photo_id],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(added)
}

/// Photos d'un album manuel (même colonnes que la liste d'un dossier ; l'interface applique son propre tri).
pub fn album_photos(conn: &Connection, album_id: i64) -> Result<Vec<crate::db::Photo>, String> {
    require_manual(conn, album_id)?;
    let mut statement = conn.prepare(&format!(
        "SELECT {} FROM photos WHERE id IN (SELECT photo_id FROM album_photos WHERE album_id = ?1) ORDER BY date_taken DESC, id DESC",
        crate::db::PHOTO_COLUMNS
    )).map_err(|e| e.to_string())?;
    let rows = statement.query_map(params![album_id], crate::db::photo_from_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

/// Index id → nœud (aide aux tests et au calcul d'ascendance).
#[allow(dead_code)]
pub fn by_id(nodes: Vec<AlbumNode>) -> HashMap<i64, AlbumNode> {
    nodes.into_iter().map(|node| (node.id, node)).collect()
}

// ==========================================
// COMMANDES IPC
// ==========================================
#[tauri::command(async)]
pub fn get_album_tree(state: State<'_, AppState>) -> Result<Vec<AlbumNode>, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    list_nodes(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn create_album_node(state: State<'_, AppState>, parent_id: i64, kind: String, name: String) -> Result<i64, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    create_node(&conn, parent_id, &kind, &name)
}

#[tauri::command(async)]
pub fn rename_album_node(state: State<'_, AppState>, id: i64, name: String) -> Result<(), String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    rename_node(&conn, id, &name)
}

#[tauri::command(async)]
pub fn delete_album_node(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    delete_node(&conn, id)
}

#[tauri::command(async)]
pub fn move_album_node(state: State<'_, AppState>, id: i64, new_parent_id: i64) -> Result<(), String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    move_node(&conn, id, new_parent_id)
}

/// `suffix` : mot traduit ajouté au nom d'une copie (« copie » / « copy »).
#[tauri::command(async)]
pub fn copy_album_node(state: State<'_, AppState>, id: i64, new_parent_id: i64, suffix: String) -> Result<i64, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    copy_node(&conn, id, new_parent_id, &suffix)
}

#[tauri::command(async)]
pub fn set_album_filters(state: State<'_, AppState>, id: i64, filters: String) -> Result<(), String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    set_filters(&conn, id, &filters)
}

/// Appartenances (album, photo) de tous les albums manuels : l'interface en tire les compteurs des albums intelligents et des dossiers virtuels.
pub fn memberships(conn: &Connection) -> Result<Vec<(i64, i64)>, String> {
    let mut statement = conn.prepare("SELECT album_id, photo_id FROM album_photos").map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_album_memberships(state: State<'_, AppState>) -> Result<Vec<(i64, i64)>, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    memberships(&conn)
}

#[tauri::command(async)]
pub fn get_album_photos(state: State<'_, AppState>, album_id: i64) -> Result<Vec<crate::db::Photo>, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    album_photos(&conn, album_id)
}

#[tauri::command(async)]
pub fn add_photos_to_album(state: State<'_, AppState>, album_id: i64, photo_ids: Vec<i64>) -> Result<Vec<i64>, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    add_photos_listed(&conn, album_id, &photo_ids)
}

#[tauri::command(async)]
pub fn remove_photos_from_album(state: State<'_, AppState>, album_id: i64, photo_ids: Vec<i64>) -> Result<usize, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    remove_photos(&conn, album_id, &photo_ids)
}

#[tauri::command(async)]
pub fn replace_album_photos(state: State<'_, AppState>, album_id: i64, photo_ids: Vec<i64>) -> Result<usize, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    replace_photos(&conn, album_id, &photo_ids)
}

#[cfg(test)]
#[path = "tests/albums.rs"]
mod tests;
