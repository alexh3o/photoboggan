//! Auteur et droits : préréglages d'auteur (table `author_presets`), lecture à la demande des champs de droits des photos et liste des auteurs
//! du catalogue (filtre « Auteur »).
//!
//! Les cinq champs (auteur, mention de copyright, crédit, conditions d'utilisation, e-mail de l'auteur) sont lus dans les fichiers et écrits dans
//! les fichiers par exif.rs / exiftool.rs (voir `exif::Rights`). La base n'en est qu'un reflet : colonnes `author`, `copyright`, `credit`,
//! `usage_terms` et `author_email` de `photos`. Seul `author` voyage avec la liste des photos (`db::Photo`), pour le filtre ; les quatre autres
//! sont demandés pour la sélection par `get_photo_rights`, afin de ne pas alourdir la liste.
//!
//! Un préréglage mémorise un jeu des cinq valeurs sous un nom, à rappeler dans le panneau Description. Les noms sont uniques, casse ignorée.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;

use crate::AppState;

/// Clé d'unicité d'un nom (casse et espaces de bordure ignorés).
fn name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

fn collect_rows<T>(rows: impl Iterator<Item = rusqlite::Result<T>>) -> Result<Vec<T>, String> {
    rows.collect::<rusqlite::Result<Vec<T>>>().map_err(|error| error.to_string())
}

/// Longueur maximale (en caractères) du nom d'un préréglage.
const MAX_PRESET_NAME_CHARS: usize = 100;

/// Crée la table des préréglages et l'index des auteurs à l'ouverture de la base (sans toucher aux données existantes). Appelée par `db::init_db`,
/// après l'ajout des colonnes de `photos`.
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS author_presets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL UNIQUE,
            author TEXT NOT NULL DEFAULT '',
            copyright TEXT NOT NULL DEFAULT '',
            credit TEXT NOT NULL DEFAULT '',
            usage_terms TEXT NOT NULL DEFAULT '',
            author_email TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_photos_author ON photos(author);",
    )
}

/// Préréglage d'auteur et de droits envoyé à l'interface.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct AuthorPreset {
    pub id: i64,
    pub name: String,
    pub author: String,
    pub copyright: String,
    pub credit: String,
    pub usage_terms: String,
    pub author_email: String,
}

fn preset_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuthorPreset> {
    Ok(AuthorPreset {
        id: row.get(0)?,
        name: row.get(1)?,
        author: row.get(2)?,
        copyright: row.get(3)?,
        credit: row.get(4)?,
        usage_terms: row.get(5)?,
        author_email: row.get(6)?,
    })
}

const PRESET_COLUMNS: &str = "id, name, author, copyright, credit, usage_terms, author_email";

/// Tous les préréglages, triés par nom (casse ignorée).
pub(crate) fn list_presets(conn: &Connection) -> Result<Vec<AuthorPreset>, String> {
    let mut statement = conn
        .prepare(&format!("SELECT {PRESET_COLUMNS} FROM author_presets ORDER BY name_key"))
        .map_err(|error| error.to_string())?;
    let rows = statement.query_map([], preset_from_row).map_err(|error| error.to_string())?;
    collect_rows(rows)
}

/// Préréglage de ce nom (casse ignorée) : le préréglage existant, ou un nouveau préréglage aux valeurs vides. Erreur `invalid_name` si le nom est
/// vide ou trop long.
pub(crate) fn create_preset(conn: &Connection, name: &str) -> Result<AuthorPreset, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_PRESET_NAME_CHARS { return Err("invalid_name".to_string()); }
    let key = name_key(name);
    conn.execute("INSERT OR IGNORE INTO author_presets (name, name_key) VALUES (?1, ?2)", params![name, key]).map_err(|error| error.to_string())?;
    conn.query_row(&format!("SELECT {PRESET_COLUMNS} FROM author_presets WHERE name_key = ?1"), params![key], preset_from_row).map_err(|error| error.to_string())
}

/// Remplace les valeurs d'un préréglage. Erreur `unknown_preset` s'il n'existe plus.
pub(crate) fn save_preset(conn: &Connection, preset: &AuthorPreset) -> Result<AuthorPreset, String> {
    let clean = |text: &str| text.trim().to_string();
    let changed = conn
        .execute(
            "UPDATE author_presets SET author = ?1, copyright = ?2, credit = ?3, usage_terms = ?4, author_email = ?5 WHERE id = ?6",
            params![clean(&preset.author), clean(&preset.copyright), clean(&preset.credit), clean(&preset.usage_terms), clean(&preset.author_email), preset.id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 { return Err("unknown_preset".to_string()); }
    conn.query_row(&format!("SELECT {PRESET_COLUMNS} FROM author_presets WHERE id = ?1"), params![preset.id], preset_from_row).map_err(|error| error.to_string())
}

/// Supprime un préréglage (les photos ne sont pas touchées : le préréglage n'est qu'un modèle de saisie).
pub(crate) fn delete_preset(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM author_presets WHERE id = ?1", params![id]).map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn list_author_presets(state: State<'_, AppState>) -> Result<Vec<AuthorPreset>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    list_presets(&conn)
}

/// Crée le préréglage `name` (valeurs vides) ou renvoie celui qui porte déjà ce nom. Erreur : `invalid_name`.
#[tauri::command(async)]
pub fn create_author_preset(state: State<'_, AppState>, name: String) -> Result<AuthorPreset, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    create_preset(&conn, &name)
}

/// Enregistre les cinq valeurs d'un préréglage. Erreur : `unknown_preset`.
#[tauri::command(async)]
pub fn save_author_preset(
    state: State<'_, AppState>,
    id: i64,
    author: String,
    copyright: String,
    credit: String,
    usage_terms: String,
    author_email: String,
) -> Result<AuthorPreset, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    save_preset(&conn, &AuthorPreset { id, name: String::new(), author, copyright, credit, usage_terms, author_email })
}

#[tauri::command(async)]
pub fn delete_author_preset(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    delete_preset(&conn, id)
}

/// Auteur et droits d'une photo, tels qu'enregistrés en base.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct PhotoRights {
    pub photo_id: i64,
    pub author: String,
    pub copyright: String,
    pub credit: String,
    pub usage_terms: String,
    pub author_email: String,
}

/// Auteur et droits des photos demandées (une sélection) : lus à la demande, ils ne font pas partie de la liste des photos.
pub(crate) fn photo_rights(conn: &Connection, photo_ids: &[i64]) -> Result<Vec<PhotoRights>, String> {
    if photo_ids.is_empty() { return Ok(Vec::new()); }
    let ids_json = serde_json::to_string(photo_ids).map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT id, COALESCE(author, ''), COALESCE(copyright, ''), COALESCE(credit, ''), COALESCE(usage_terms, ''), COALESCE(author_email, '')
             FROM photos WHERE id IN (SELECT value FROM json_each(?1))",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![ids_json], |row| {
            Ok(PhotoRights { photo_id: row.get(0)?, author: row.get(1)?, copyright: row.get(2)?, credit: row.get(3)?, usage_terms: row.get(4)?, author_email: row.get(5)? })
        })
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

#[tauri::command(async)]
pub fn get_photo_rights(state: State<'_, AppState>, photo_ids: Vec<i64>) -> Result<Vec<PhotoRights>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    photo_rights(&conn, &photo_ids)
}

/// Un auteur du catalogue et le nombre de photos qui le portent.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct AuthorCount {
    pub name: String,
    pub count: i64,
}

/// Auteurs individuels d'une liste de valeurs du champ `author` (« A; B » compte pour A et pour B), chacun avec son nombre de photos. Les noms qui ne
/// diffèrent que par la casse sont regroupés sous la première graphie rencontrée ; tri par nom, casse ignorée.
pub(crate) fn author_counts(values: &[(String, i64)]) -> Vec<AuthorCount> {
    let mut by_key: HashMap<String, AuthorCount> = HashMap::new();
    for (value, photos) in values {
        let mut seen_in_value: Vec<String> = Vec::new();
        for name in crate::exif::split_authors(value) {
            let key = name_key(&name);
            // The same name twice in one value counts the photos once.
            if seen_in_value.contains(&key) { continue; }
            seen_in_value.push(key.clone());
            by_key.entry(key).or_insert_with(|| AuthorCount { name, count: 0 }).count += photos;
        }
    }
    let mut counts: Vec<AuthorCount> = by_key.into_values().collect();
    counts.sort_by_key(|author| (name_key(&author.name), author.name.clone()));
    counts
}

/// Auteurs du catalogue (photos visibles avec l'ensemble de confidentialité actif), pour la liste du filtre « Auteur ».
#[tauri::command(async)]
pub fn get_authors(state: State<'_, AppState>) -> Result<Vec<AuthorCount>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(&format!(
            "SELECT author, COUNT(*) FROM photos WHERE author IS NOT NULL AND author != '' AND ({}) GROUP BY author",
            crate::privacy::visible_condition("")
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))).map_err(|error| error.to_string())?;
    Ok(author_counts(&collect_rows(rows)?))
}

#[cfg(test)]
#[path = "tests/rights.rs"]
mod tests;
