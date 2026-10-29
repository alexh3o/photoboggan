//! Visages : zones de visage lues dans les fichiers (MWG Regions, Microsoft MP, ACDSee), personnes et association photo ↔ visage.
//!
//! Modèle (choisi avec l'utilisateur, voir dev_tools/Evolutions/feat face recognition v2.md) :
//! - coordonnées normalisées (0 à 1), coin haut-gauche, dans le repère de l'image STOCKÉE, avant l'orientation EXIF : c'est le repère des formats
//!   MWG et MP (une rotation par le seul tag Orientation ne les change pas). L'interface applique l'orientation à l'affichage ;
//! - lot 1 (lecture seule) : seules existent les zones importées des fichiers. Le fichier fait foi : elles sont remplacées à chaque lecture ;
//! - une personne par nom (casse ignorée). Elle est liée au nœud de l'arbre des mots-clés qui porte ce nom quand il est le seul ; sinon
//!   l'utilisateur la relie lui-même. Le nom affiché est celui du nœud lié, à défaut le nom lu dans le fichier ;
//! - la lecture n'a lieu que si l'utilisateur l'a activée (Paramètres > Visages) : désactivée, la base n'est pas touchée.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;
use tauri::State;

use crate::AppState;

/// Zone de visage lue dans un fichier : coin haut-gauche et taille normalisés, repère de l'image stockée. `name` : None pour un visage sans nom.
#[derive(Clone, Debug, PartialEq)]
pub struct FaceRegion {
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Ce que la lecture d'un fichier apprend sur ses visages : orientation EXIF (1 à 8) et zones (None : lecture des visages désactivée).
pub struct PhotoFaces {
    pub orientation: u32,
    pub regions: Option<Vec<FaceRegion>>,
}

impl Default for PhotoFaces {
    fn default() -> Self {
        PhotoFaces { orientation: 1, regions: None }
    }
}

// ---------------------------------------------------------------------------
// Réglages : lecture activée, ordre de priorité des formats
// ---------------------------------------------------------------------------

/// Formats de zones de visage (identifiants côté interface), ordre par défaut : MWG (digiKam, Lightroom, Picasa), Microsoft (Windows Photos), ACDSee.
pub const REGION_SOURCE_IDS: [&str; 3] = ["mwg", "microsoft", "acdsee"];
/// Ordre de priorité à la lecture (indices dans REGION_SOURCE_IDS), réglé par exif::set_read_priority (« faces »).
pub(crate) static REGION_PRIORITY: RwLock<[usize; 3]> = RwLock::new([0, 1, 2]);
/// Lecture des zones de visage activée (Paramètres > Visages) ; envoyée par l'interface au démarrage puis à chaque changement.
static READ_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn reading_enabled() -> bool {
    READ_ENABLED.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_face_reading(enabled: bool) {
    READ_ENABLED.store(enabled, Ordering::Relaxed);
}

// ---------------------------------------------------------------------------
// Lecture des zones dans un paquet XMP
// ---------------------------------------------------------------------------

const MWG_NS: &str = "http://www.metadataworkinggroup.com/schemas/regions/";
const MP_NS: &str = "http://ns.microsoft.com/photo/1.2/";
const ACDSEE_RS_NS: &str = "http://ns.acdsee.com/regions/";

/// Zones de visage d'un paquet XMP : le premier format qui en contient, dans l'ordre de priorité réglé, l'emporte ; les autres sont ignorés.
pub fn parse_regions(xml: &str) -> Vec<FaceRegion> {
    let priority = *REGION_PRIORITY.read().unwrap_or_else(|poisoned| poisoned.into_inner());
    for index in priority {
        let regions = match index {
            0 => mwg_regions(xml),
            1 => mp_regions(xml),
            _ => acdsee_regions(xml),
        };
        if !regions.is_empty() { return regions; }
    }
    Vec::new()
}

/// MWG : `mwg-rs:Regions` > `RegionList` > `rdf:li` (Name, Type, Area). `Area` donne le CENTRE de la zone (x, y) et sa taille (w, h).
/// Seules les zones de type Face (ou sans type) sont retenues. Unité `pixel` : convertie d'après `AppliedToDimensions`.
fn mwg_regions(xml: &str) -> Vec<FaceRegion> {
    let mut regions = Vec::new();
    for prefix in namespace_prefixes(xml, MWG_NS) {
        let Some(container) = element_by_name(xml, &format!("{prefix}:Regions")) else { continue; };
        let dimensions = element_by_local_name(container, "AppliedToDimensions").map(|scope| (number(scope, "w"), number(scope, "h")));
        let Some(list) = element_by_name(container, &format!("{prefix}:RegionList")) else { continue; };
        for item in list_items(list) {
            if !is_face_type(field_value(item, "Type")) { continue; }
            let Some(area) = element_by_local_name(item, "Area") else { continue; };
            let (Some(cx), Some(cy), Some(w), Some(h)) = (number(area, "x"), number(area, "y"), number(area, "w"), number(area, "h")) else { continue; };
            let Some((cx, cy, w, h)) = normalized(field_value(area, "unit"), dimensions, cx, cy, w, h) else { continue; };
            if let Some(region) = face_region(field_value(item, "Name"), cx - w / 2.0, cy - h / 2.0, w, h) { regions.push(region); }
        }
        if !regions.is_empty() { break; }
    }
    regions
}

/// Microsoft Photo : `MP:RegionInfo` > `Regions` > `rdf:li` (PersonDisplayName, Rectangle « x, y, w, h » avec x, y = COIN HAUT-GAUCHE).
fn mp_regions(xml: &str) -> Vec<FaceRegion> {
    let mut regions = Vec::new();
    for prefix in namespace_prefixes(xml, MP_NS) {
        let Some(container) = element_by_name(xml, &format!("{prefix}:RegionInfo")) else { continue; };
        for item in list_items(container) {
            let Some(rectangle) = field_value(item, "Rectangle") else { continue; };
            let values: Vec<f64> = rectangle.split(',').filter_map(|value| value.trim().parse().ok()).collect();
            if values.len() != 4 { continue; }
            if let Some(region) = face_region(field_value(item, "PersonDisplayName"), values[0], values[1], values[2], values[3]) { regions.push(region); }
        }
        if !regions.is_empty() { break; }
    }
    regions
}

/// ACDSee : `acdsee-rs:Regions` > `RegionList` > `rdf:li` (Name, Type, DLYArea). Repère de DLYArea non documenté : lu provisoirement comme le
/// COIN HAUT-GAUCHE (hypothèse la plus probable, à confirmer sur un fichier tagué dans ACDSee).
fn acdsee_regions(xml: &str) -> Vec<FaceRegion> {
    let mut regions = Vec::new();
    for prefix in namespace_prefixes(xml, ACDSEE_RS_NS) {
        let Some(container) = element_by_name(xml, &format!("{prefix}:Regions")) else { continue; };
        let Some(list) = element_by_name(container, &format!("{prefix}:RegionList")) else { continue; };
        for item in list_items(list) {
            if !is_face_type(field_value(item, "Type")) { continue; }
            let Some(area) = element_by_local_name(item, "DLYArea") else { continue; };
            let (Some(x), Some(y), Some(w), Some(h)) = (number(area, "x"), number(area, "y"), number(area, "w"), number(area, "h")) else { continue; };
            if let Some(region) = face_region(field_value(item, "Name"), x, y, w, h) { regions.push(region); }
        }
        if !regions.is_empty() { break; }
    }
    regions
}

fn is_face_type(region_type: Option<String>) -> bool {
    region_type.is_none_or(|value| value.trim().is_empty() || value.trim().eq_ignore_ascii_case("face"))
}

/// Coordonnées normalisées : telles quelles en unité `normalized` (ou sans unité), divisées par les dimensions en unité `pixel`.
fn normalized(unit: Option<String>, dimensions: Option<(Option<f64>, Option<f64>)>, x: f64, y: f64, w: f64, h: f64) -> Option<(f64, f64, f64, f64)> {
    match unit.as_deref().map(str::trim) {
        None | Some("") | Some("normalized") => Some((x, y, w, h)),
        Some("pixel") => match dimensions {
            Some((Some(width), Some(height))) if width > 0.0 && height > 0.0 => Some((x / width, y / height, w / width, h / height)),
            _ => None,
        },
        _ => None,
    }
}

/// Zone validée : valeurs finies, taille positive, ramenée dans l'image ; nom nettoyé (vide = sans nom).
fn face_region(name: Option<String>, x: f64, y: f64, w: f64, h: f64) -> Option<FaceRegion> {
    if ![x, y, w, h].iter().all(|value| value.is_finite()) || w <= 0.0 || h <= 0.0 { return None; }
    let x = x.clamp(0.0, 1.0);
    let y = y.clamp(0.0, 1.0);
    let w = w.min(1.0 - x);
    let h = h.min(1.0 - y);
    if w <= 0.0 || h <= 0.0 { return None; }
    let name = name.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    Some(FaceRegion { name, x, y, w, h })
}

/// Préfixes déclarés pour le namespace `uri` (`xmlns:préfixe="uri"`) : chaque logiciel choisit les siens.
pub(crate) fn namespace_prefixes(xml: &str, uri: &str) -> Vec<String> {
    let mut prefixes: Vec<String> = Vec::new();
    let mut from = 0;
    while let Some(relative) = xml[from..].find("xmlns:") {
        let start = from + relative + "xmlns:".len();
        from = start;
        let Some(equal) = xml[start..].find('=') else { break; };
        let prefix = xml[start..start + equal].trim();
        let after = xml[start + equal + 1..].trim_start();
        let Some(quote) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else { continue; };
        let body = &after[1..];
        let Some(end) = body.find(quote) else { break; };
        if &body[..end] == uri && !prefix.is_empty() && !prefixes.iter().any(|known| known == prefix) {
            prefixes.push(prefix.to_string());
        }
    }
    prefixes
}

/// Premier élément de nom qualifié `qualified` (ex. « mwg-rs:Regions »), balise ouvrante comprise (pour ses attributs).
fn element_by_name<'a>(xml: &'a str, qualified: &str) -> Option<&'a str> {
    let open = format!("<{qualified}");
    let mut from = 0;
    while let Some(relative) = xml[from..].find(&open) {
        let start = from + relative;
        let name_end = start + open.len();
        from = name_end;
        match xml.as_bytes().get(name_end) {
            Some(b'>') | Some(b'/') => {}
            Some(byte) if byte.is_ascii_whitespace() => {}
            _ => continue,
        }
        let tag_end = crate::exif::xml_tag_end(xml, start)?;
        if xml.as_bytes()[tag_end - 1] == b'/' { return Some(&xml[start..=tag_end]); }
        let close_start = tag_end + xml[tag_end..].find(&format!("</{qualified}"))?;
        let close_end = close_start + xml[close_start..].find('>')?;
        return Some(&xml[start..=close_end]);
    }
    None
}

/// Position du préfixe d'un nom qualifié `préfixe:local` trouvé en `colon` (deux-points), ou None si ce n'est pas un nom valide
/// (pas de préfixe, déclaration `xmlns:`, nom plus long que `local`).
fn qualified_name_start(scope: &str, colon: usize, local: &str) -> Option<usize> {
    let bytes = scope.as_bytes();
    let mut start = colon;
    while start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'-' || bytes[start - 1] == b'_') { start -= 1; }
    if start == colon || start == 0 || &scope[start..colon] == "xmlns" { return None; }
    match bytes.get(colon + 1 + local.len()) {
        Some(b'>') | Some(b'/') | Some(b'=') => Some(start),
        Some(byte) if byte.is_ascii_whitespace() => Some(start),
        _ => None,
    }
}

/// Premier élément de nom local `local` dans `scope`, quel que soit son préfixe.
fn element_by_local_name<'a>(scope: &'a str, local: &str) -> Option<&'a str> {
    let needle = format!(":{local}");
    let mut from = 0;
    while let Some(relative) = scope[from..].find(&needle) {
        let colon = from + relative;
        from = colon + needle.len();
        let Some(start) = qualified_name_start(scope, colon, local) else { continue; };
        if scope.as_bytes()[start - 1] != b'<' { continue; }
        let qualified = &scope[start..colon + needle.len()];
        return element_by_name(&scope[start - 1..], qualified);
    }
    None
}

/// Valeur d'une propriété simple de nom local `local` dans `scope`, écrite en attribut (`stArea:x="0.5"`, forme d'Exiv2 / digiKam)
/// ou en élément (`<stArea:x>0.5</stArea:x>`, forme d'ExifTool). Entités XML décodées.
fn field_value(scope: &str, local: &str) -> Option<String> {
    let needle = format!(":{local}");
    let bytes = scope.as_bytes();
    let mut from = 0;
    while let Some(relative) = scope[from..].find(&needle) {
        let colon = from + relative;
        let name_end = colon + needle.len();
        from = name_end;
        let Some(start) = qualified_name_start(scope, colon, local) else { continue; };
        let before = bytes[start - 1];
        if before == b'<' {
            // Élément : texte jusqu'à la balise fermante (un élément qui contient d'autres balises est une structure, pas une valeur).
            let Some(tag_end) = crate::exif::xml_tag_end(scope, start - 1) else { return None; };
            if bytes[tag_end - 1] == b'/' { continue; }
            let body = &scope[tag_end + 1..];
            let Some(text_end) = body.find('<') else { return None; };
            if body[text_end..].starts_with("</") {
                return Some(crate::exif::decode_xml_entities(body[..text_end].trim()));
            }
        } else if before.is_ascii_whitespace() {
            // Attribut : valeur entre guillemets.
            let tail = scope[name_end..].trim_start();
            let Some(value) = tail.strip_prefix('=') else { continue; };
            let value = value.trim_start();
            let Some(quote) = value.chars().next().filter(|c| *c == '"' || *c == '\'') else { continue; };
            let body = &value[1..];
            let Some(end) = body.find(quote) else { return None; };
            return Some(crate::exif::decode_xml_entities(body[..end].trim()));
        }
    }
    None
}

fn number(scope: &str, local: &str) -> Option<f64> {
    field_value(scope, local).and_then(|value| value.trim().parse::<f64>().ok())
}

/// Éléments `rdf:li` de premier niveau de `scope`, balise ouvrante comprise (ses attributs portent parfois les champs de la zone).
fn list_items(scope: &str) -> Vec<&str> {
    const OPEN: &str = "<rdf:li";
    const CLOSE: &str = "</rdf:li>";
    let bytes = scope.as_bytes();
    let mut items = Vec::new();
    let mut depth = 0usize;
    let mut item_start = 0usize;
    let mut position = 0usize;
    while let Some(relative) = scope[position..].find('<') {
        let start = position + relative;
        let rest = &scope[start..];
        let is_open = rest.starts_with(OPEN)
            && matches!(bytes.get(start + OPEN.len()), Some(b'>') | Some(b'/') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n'));
        if is_open {
            let Some(tag_end) = crate::exif::xml_tag_end(scope, start) else { break; };
            if depth == 0 { item_start = start; }
            if bytes[tag_end - 1] == b'/' {
                if depth == 0 { items.push(&scope[start..=tag_end]); }
            } else {
                depth += 1;
            }
            position = tag_end + 1;
        } else if rest.starts_with(CLOSE) {
            if depth > 0 {
                depth -= 1;
                if depth == 0 { items.push(&scope[item_start..start + CLOSE.len()]); }
            }
            position = start + CLOSE.len();
        } else {
            position = start + 1;
        }
    }
    items
}

// ---------------------------------------------------------------------------
// Base de données
// ---------------------------------------------------------------------------

/// Crée les tables à l'ouverture de la base (sans toucher aux données existantes). Appelée par `db::init_db`, après `photos` et les mots-clés.
/// Les colonnes des lots suivants (détection, reconnaissance, écriture) sont déjà prévues pour éviter des migrations.
pub fn init_schema(conn: &Connection) {
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS persons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL UNIQUE,
            keyword_node_id INTEGER,
            cover_face_id INTEGER,
            hidden INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );
        CREATE TABLE IF NOT EXISTS faces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            photo_id INTEGER NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            w REAL NOT NULL,
            h REAL NOT NULL,
            origin TEXT NOT NULL,
            state TEXT NOT NULL,
            person_id INTEGER,
            suggested_person_id INTEGER,
            score REAL,
            margin REAL,
            det_score REAL,
            sharpness REAL,
            size_px REAL,
            size_pct REAL,
            embedding BLOB,
            model_id TEXT,
            dirty INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_faces_photo ON faces(photo_id);
        CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);
        -- Scan des visages de chaque photo (face_detect.rs) : détecteur utilisé, date, géométrie vue au scan (pour repérer une photo
        -- modifiée depuis, spec §4.2) ; model_id : modèle de reconnaissance (lot 3).
        CREATE TABLE IF NOT EXISTS photo_face_scans (
            photo_id INTEGER PRIMARY KEY,
            detector_id TEXT NOT NULL,
            model_id TEXT,
            scanned_at INTEGER NOT NULL,
            file_mtime INTEGER NOT NULL DEFAULT 0,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            orientation INTEGER NOT NULL DEFAULT 1,
            needs_review INTEGER NOT NULL DEFAULT 0
        );
        -- Photos retirées du catalogue : leurs visages ne servent plus (les identifiants ne sont jamais réutilisés).
        DELETE FROM faces WHERE photo_id NOT IN (SELECT id FROM photos);
        DELETE FROM photo_face_scans WHERE photo_id NOT IN (SELECT id FROM photos);",
    );
    // 5 points de repère de YuNet (yeux, nez, coins de la bouche), 10 flottants normalisés, repère de l'image stockée : alignement avant SFace (lot 3).
    let _ = conn.execute("ALTER TABLE faces ADD COLUMN landmarks BLOB", []);
    // Personne que l'utilisateur a refusée pour ce visage (« Inconnu ») : l'attribution ne la lui propose plus (lot 3).
    let _ = conn.execute("ALTER TABLE faces ADD COLUMN rejected_person_id INTEGER", []);
    // Écriture dans les fichiers (lot 4) :
    // - face_keywords : mots-clés activés sur une photo par la reconnaissance (et non par l'utilisateur) : seuls ceux-là sont retirés quand le
    //   dernier visage de la personne quitte la photo (spec §6.3). Le nœud de l'arbre n'est jamais supprimé par ces opérations ;
    // - photo_face_writes : photos dont les zones sont à réécrire alors qu'aucun visage n'y est marqué (visage nommé supprimé, données effacées) ;
    // - personnes reliées à un mot-clé qui n'existe plus dans l'arbre : déliées.
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS face_keywords (
            photo_id INTEGER NOT NULL,
            keyword_id INTEGER NOT NULL,
            PRIMARY KEY (photo_id, keyword_id)
        );
        CREATE TABLE IF NOT EXISTS photo_face_writes (photo_id INTEGER PRIMARY KEY);
        DELETE FROM face_keywords WHERE photo_id NOT IN (SELECT id FROM photos);
        DELETE FROM photo_face_writes WHERE photo_id NOT IN (SELECT id FROM photos);",
    );
    unlink_missing_keywords(conn);
}

/// Personnes reliées à un mot-clé supprimé de l'arbre : déliées (elles gardent leur nom et leurs visages).
pub fn unlink_missing_keywords(conn: &Connection) {
    let _ = conn.execute(
        "UPDATE persons SET keyword_node_id = NULL WHERE keyword_node_id IS NOT NULL AND keyword_node_id NOT IN (SELECT id FROM keyword_nodes)",
        [],
    );
}

/// Personne désignée par un nom lu dans une zone de visage : celle reliée au mot-clé qui porte ce nom (le nom écrit est celui du mot-clé), à défaut
/// la personne de ce nom, créée si besoin.
fn person_for_name(conn: &Connection, name: &str) -> rusqlite::Result<i64> {
    let key = crate::keywords::name_key(name);
    let linked: Vec<i64> = conn
        .prepare_cached("SELECT p.id FROM persons p JOIN keyword_nodes k ON k.id = p.keyword_node_id WHERE k.name_key = ?1")?
        .query_map(params![key], |row| row.get(0))?
        .flatten()
        .collect();
    if let [person_id] = linked[..] { return Ok(person_id); }
    ensure_person(conn, name)
}

/// Identifiant de la personne de ce nom (casse ignorée), créée si elle n'existe pas.
fn ensure_person(conn: &Connection, name: &str) -> rusqlite::Result<i64> {
    let key = crate::keywords::name_key(name);
    conn.prepare_cached("INSERT OR IGNORE INTO persons (name, name_key) VALUES (?1, ?2)")?
        .execute(params![name.trim(), key])?;
    conn.prepare_cached("SELECT id FROM persons WHERE name_key = ?1")?
        .query_row(params![key], |row| row.get(0))
}

/// Liaison automatique d'une personne non liée : au nœud de l'arbre qui porte son nom, s'il est le seul et n'est lié à aucune autre personne.
fn auto_link_person(conn: &Connection, person_id: i64) {
    let Ok((linked, key)) = conn.query_row(
        "SELECT keyword_node_id IS NOT NULL, name_key FROM persons WHERE id = ?1",
        params![person_id],
        |row| Ok((row.get::<_, bool>(0)?, row.get::<_, String>(1)?)),
    ) else { return; };
    if linked { return; }
    let Ok(mut statement) = conn.prepare_cached("SELECT id FROM keyword_nodes WHERE name_key = ?1") else { return; };
    let nodes: Vec<i64> = statement.query_map(params![key], |row| row.get(0)).map(|rows| rows.flatten().collect()).unwrap_or_default();
    let [node_id] = nodes[..] else { return; };
    let taken: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM persons WHERE keyword_node_id = ?1)", params![node_id], |row| row.get(0))
        .unwrap_or(true);
    if !taken {
        let _ = conn.execute("UPDATE persons SET keyword_node_id = ?1 WHERE id = ?2", params![node_id, person_id]);
    }
}

/// Photo relue dont les proportions ont changé depuis son scan de visages (rotation des pixels, recadrage : spec §4.2) : marquée « à revérifier ».
/// Une rotation par le seul tag Orientation ne change pas les dimensions stockées, un redimensionnement proportionnel non plus : rien à faire.
fn mark_geometry_change(conn: &Connection, photo_id: i64, width: i64, height: i64) {
    if width <= 0 || height <= 0 { return; }
    let Ok((scan_width, scan_height)) = conn.query_row(
        "SELECT width, height FROM photo_face_scans WHERE photo_id = ?1",
        params![photo_id],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    ) else { return; };
    if scan_width <= 0 || scan_height <= 0 { return; }
    let before = scan_width as f64 / scan_height as f64;
    let now = width as f64 / height as f64;
    if ((before - now) / before).abs() > 0.01 {
        let _ = conn.execute("UPDATE photo_face_scans SET needs_review = 1 WHERE photo_id = ?1", params![photo_id]);
    }
}

/// Enregistre, pour chaque photo (identifiée par son chemin), ce que la lecture de ses fichiers a appris : orientation EXIF, changement de
/// géométrie depuis le scan, et zones de visage si la lecture des visages est activée. Le fichier fait foi pour les zones importées, mais elles
/// sont rapprochées de celles déjà en base (recouvrement) pour garder leur empreinte et leurs mesures :
/// - zone nommée : personne du fichier, « confirmée » (sauf visage ignoré par l'utilisateur) ;
/// - zone sans nom : un visage confirmé redevient « inconnu » (son nom a été retiré dans l'autre logiciel), les autres gardent leur état ;
/// - zone importée absente du fichier : supprimée.
/// À appeler après l'insertion des photos et de leurs mots-clés (la liaison automatique cherche les nœuds de l'arbre).
pub fn store_photo_faces(conn: &Connection, items: &[(String, PhotoFaces)]) {
    if items.is_empty() { return; }
    let _ = conn.execute("BEGIN TRANSACTION", []);
    let mut touched: HashSet<i64> = HashSet::new();
    for (path, faces) in items {
        let Ok((photo_id, width, height)) = conn.query_row(
            "SELECT id, width, height FROM photos WHERE path = ?1",
            params![path],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0), row.get::<_, Option<i64>>(2)?.unwrap_or(0))),
        ) else { continue; };
        let _ = conn.execute("UPDATE photos SET orientation = ?1 WHERE id = ?2", params![faces.orientation, photo_id]);
        mark_geometry_change(conn, photo_id, width, height);
        let Some(regions) = &faces.regions else { continue; };
        struct Existing { id: i64, rect: [f64; 4], state: String, origin: String, person_id: Option<i64> }
        // Tous les visages de la photo : une zone relue peut être un visage détecté que photoboggan a lui-même écrit (lot 4), à ne pas dédoubler.
        let existing: Vec<Existing> = conn
            .prepare_cached("SELECT id, x, y, w, h, state, origin, person_id FROM faces WHERE photo_id = ?1")
            .and_then(|mut statement| {
                statement
                    .query_map(params![photo_id], |row| {
                        Ok(Existing {
                            id: row.get(0)?,
                            rect: [row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?],
                            state: row.get(5)?,
                            origin: row.get(6)?,
                            person_id: row.get(7)?,
                        })
                    })
                    .map(|rows| rows.flatten().collect())
            })
            .unwrap_or_default();
        let mut matched: Vec<i64> = Vec::new();
        for region in regions {
            let rect = [region.x, region.y, region.w, region.h];
            let person_id = region.name.as_deref().and_then(|name| person_for_name(conn, name).ok());
            if let Some(id) = person_id { touched.insert(id); }
            let best = existing
                .iter()
                .filter(|candidate| !matched.contains(&candidate.id))
                .map(|candidate| (candidate, crate::face_detect::iou(&candidate.rect, &rect)))
                .filter(|(_, overlap)| *overlap >= 0.5)
                .max_by(|a, b| a.1.total_cmp(&b.1));
            match best {
                Some((candidate, _)) if candidate.origin == "imported" => {
                    matched.push(candidate.id);
                    let _ = conn.execute("UPDATE faces SET x = ?1, y = ?2, w = ?3, h = ?4 WHERE id = ?5", params![rect[0], rect[1], rect[2], rect[3], candidate.id]);
                    if matches!(candidate.state.as_str(), "ignored" | "not_face") { continue; }
                    if person_id.is_some() {
                        let _ = conn.execute(
                            "UPDATE faces SET person_id = ?1, state = 'confirmed', suggested_person_id = NULL WHERE id = ?2",
                            params![person_id, candidate.id],
                        );
                    } else if candidate.state == "confirmed" {
                        let _ = conn.execute("UPDATE faces SET person_id = NULL, state = 'unknown' WHERE id = ?1", params![candidate.id]);
                    }
                }
                Some((candidate, _)) => {
                    // Visage détecté ou dessiné : sa zone écrite revient telle quelle (rien à faire), sauf si un autre logiciel l'a renommée.
                    matched.push(candidate.id);
                    if !matches!(candidate.state.as_str(), "ignored" | "not_face") && person_id.is_some() && candidate.person_id != person_id {
                        let _ = conn.execute(
                            "UPDATE faces SET person_id = ?1, state = 'confirmed', suggested_person_id = NULL WHERE id = ?2",
                            params![person_id, candidate.id],
                        );
                    }
                }
                None => {
                    // Zone nommée lue dans un fichier : validée par l'utilisateur dans l'autre logiciel. Sans nom : visage inconnu.
                    let state = if person_id.is_some() { "confirmed" } else { "unknown" };
                    let _ = conn.execute(
                        "INSERT INTO faces (photo_id, x, y, w, h, origin, state, person_id) VALUES (?1, ?2, ?3, ?4, ?5, 'imported', ?6, ?7)",
                        params![photo_id, rect[0], rect[1], rect[2], rect[3], state, person_id],
                    );
                }
            }
        }
        // Zones importées absentes du fichier : retirées (les visages détectés restent, même si leur zone n'est pas encore écrite).
        for candidate in existing.iter().filter(|candidate| candidate.origin == "imported" && !matched.contains(&candidate.id)) {
            let _ = conn.execute("DELETE FROM faces WHERE id = ?1", params![candidate.id]);
        }
    }
    for person_id in touched { auto_link_person(conn, person_id); }
    // Une personne qui n'a plus aucun visage est conservée : elle peut attendre une attribution. Le nettoyage se fera à la demande
    // (action prévue dans Paramètres > Visages).
    let _ = conn.execute("COMMIT", []);
}

// ---------------------------------------------------------------------------
// Commandes de l'interface
// ---------------------------------------------------------------------------

/// Visage représentatif d'une personne : de quoi découper sa vignette dans la miniature de la photo (orientation à appliquer à la zone).
#[derive(Serialize)]
pub struct FaceCover {
    pub face_id: i64,
    pub photo_id: i64,
    pub path: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub orientation: u32,
}

#[derive(Serialize)]
pub struct PersonInfo {
    pub id: i64,
    /// Nom affiché : celui du nœud lié, à défaut celui lu dans les fichiers.
    pub name: String,
    pub keyword_id: Option<i64>,
    pub photo_count: i64,
    pub cover: Option<FaceCover>,
    /// Personne masquée : ni attribuée, ni proposée ; absente des listes sauf si l'utilisateur affiche les personnes masquées.
    pub hidden: bool,
}

/// Toutes les personnes, avec leur nombre de photos au catalogue (0 pour une personne en attente d'attribution) et leur visage représentatif
/// (choisi par l'utilisateur, à défaut la plus grande zone).
#[tauri::command(async)]
pub fn get_persons(state: State<'_, AppState>) -> Result<Vec<PersonInfo>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    // person_id -> (photos distinctes, meilleur visage (choisi ?, aire, couverture))
    let mut photos_by_person: HashMap<i64, HashSet<i64>> = HashMap::new();
    let mut covers: HashMap<i64, (bool, f64, FaceCover)> = HashMap::new();
    {
        let mut statement = conn
            .prepare(
                "SELECT f.person_id, f.photo_id, p.path, f.x, f.y, f.w, f.h, p.orientation, f.id = pr.cover_face_id, f.id
                 FROM faces f JOIN photos p ON p.id = f.photo_id JOIN persons pr ON pr.id = f.person_id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    FaceCover {
                        face_id: row.get(9)?,
                        photo_id: row.get(1)?,
                        path: row.get(2)?,
                        x: row.get(3)?,
                        y: row.get(4)?,
                        w: row.get(5)?,
                        h: row.get(6)?,
                        orientation: row.get::<_, Option<u32>>(7)?.unwrap_or(1),
                    },
                    row.get::<_, Option<bool>>(8)?.unwrap_or(false),
                ))
            })
            .map_err(|error| error.to_string())?;
        for (person_id, cover, chosen) in rows.flatten() {
            photos_by_person.entry(person_id).or_default().insert(cover.photo_id);
            let area = cover.w * cover.h;
            let better = match covers.get(&person_id) {
                None => true,
                Some((best_chosen, best_area, _)) => (chosen && !best_chosen) || (chosen == *best_chosen && area > *best_area),
            };
            if better { covers.insert(person_id, (chosen, area, cover)); }
        }
    }
    let mut statement = conn
        .prepare("SELECT pr.id, COALESCE(k.name, pr.name), pr.keyword_node_id, pr.hidden FROM persons pr LEFT JOIN keyword_nodes k ON k.id = pr.keyword_node_id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?, row.get::<_, bool>(3)?)))
        .map_err(|error| error.to_string())?;
    let persons = rows
        .flatten()
        .map(|(id, name, keyword_id, hidden)| {
            let photo_count = photos_by_person.get(&id).map_or(0, |photos| photos.len() as i64);
            PersonInfo { id, name, keyword_id, photo_count, cover: covers.remove(&id).map(|(_, _, cover)| cover), hidden }
        })
        .collect();
    Ok(persons)
}

/// Paires (photo, personne) de tout le catalogue : sert au filtre « Personnes » de la grille.
#[tauri::command(async)]
pub fn get_face_index(state: State<'_, AppState>) -> Result<Vec<(i64, i64)>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare("SELECT DISTINCT photo_id, person_id FROM faces WHERE person_id IS NOT NULL")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|error| error.to_string())?;
    let pairs: Vec<(i64, i64)> = rows.flatten().collect();
    Ok(pairs)
}

#[derive(Serialize)]
pub struct FaceInfo {
    pub id: i64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub person_id: Option<i64>,
    pub name: Option<String>,
    pub state: String,
}

#[derive(Serialize)]
pub struct PhotoFacesInfo {
    /// Orientation EXIF de la photo (1 à 8), à appliquer aux zones pour les afficher sur l'image orientée.
    pub orientation: u32,
    pub faces: Vec<FaceInfo>,
}

/// Visages d'une photo (repère de l'image stockée) et son orientation EXIF.
#[tauri::command(async)]
pub fn get_photo_faces(state: State<'_, AppState>, photo_id: i64) -> Result<PhotoFacesInfo, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let orientation = conn
        .query_row("SELECT orientation FROM photos WHERE id = ?1", params![photo_id], |row| row.get::<_, Option<u32>>(0))
        .ok()
        .flatten()
        .unwrap_or(1);
    let mut statement = conn
        .prepare(
            "SELECT f.id, f.x, f.y, f.w, f.h, f.person_id, COALESCE(k.name, pr.name, ks.name, ps.name), f.state
             FROM faces f LEFT JOIN persons pr ON pr.id = f.person_id LEFT JOIN keyword_nodes k ON k.id = pr.keyword_node_id
             LEFT JOIN persons ps ON ps.id = f.suggested_person_id LEFT JOIN keyword_nodes ks ON ks.id = ps.keyword_node_id
             WHERE f.photo_id = ?1 AND f.state NOT IN ('filtered', 'ignored', 'not_face') ORDER BY f.x",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![photo_id], |row| {
            Ok(FaceInfo {
                id: row.get(0)?,
                x: row.get(1)?,
                y: row.get(2)?,
                w: row.get(3)?,
                h: row.get(4)?,
                person_id: row.get(5)?,
                name: row.get(6)?,
                state: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let faces: Vec<FaceInfo> = rows.flatten().collect();
    Ok(PhotoFacesInfo { orientation, faces })
}

/// Relie une personne à un nœud de l'arbre des mots-clés (None : la délie). Un nœud ne peut être lié qu'à une seule personne
/// (erreur `keyword_taken`). Lot 1 : la base seule change, les fichiers ne sont pas réécrits.
#[tauri::command(async)]
pub fn link_person_keyword(state: State<'_, AppState>, person_id: i64, keyword_id: Option<i64>) -> Result<(), String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    if let Some(node_id) = keyword_id {
        let exists: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM keyword_nodes WHERE id = ?1)", params![node_id], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if !exists { return Err("unknown_keyword".to_string()); }
        let taken: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM persons WHERE keyword_node_id = ?1 AND id <> ?2)", params![node_id, person_id], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if taken { return Err("keyword_taken".to_string()); }
    }
    conn.execute("UPDATE persons SET keyword_node_id = ?1 WHERE id = ?2", params![keyword_id, person_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Vue Visages (lot 3) : liste des visages, statut de scan, révision
// ---------------------------------------------------------------------------

/// Visage de la vue Visages : de quoi découper sa vignette (chemin de la photo, orientation), son état et son nom (personne attribuée,
/// à défaut personne suggérée).
#[derive(Serialize)]
pub struct FaceItem {
    pub id: i64,
    pub photo_id: i64,
    pub path: String,
    pub orientation: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub state: String,
    pub origin: String,
    pub person_id: Option<i64>,
    pub suggested_person_id: Option<i64>,
    pub name: Option<String>,
    pub score: Option<f64>,
}

/// Visages des photos `photo_ids` (celles affichées dans la vue Photos). Les photos « à revérifier » sont écartées jusqu'à leur rescan (§4.2).
#[tauri::command(async)]
pub fn get_faces_for_photos(state: State<'_, AppState>, photo_ids: Vec<i64>) -> Result<Vec<FaceItem>, String> {
    if photo_ids.is_empty() { return Ok(Vec::new()); }
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let ids_json = serde_json::to_string(&photo_ids).map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT f.id, f.photo_id, p.path, p.orientation, f.x, f.y, f.w, f.h, f.state, f.origin, f.person_id, f.suggested_person_id,
                    COALESCE(k.name, pr.name, ks.name, ps.name), f.score
             FROM faces f JOIN photos p ON p.id = f.photo_id
             LEFT JOIN persons pr ON pr.id = f.person_id LEFT JOIN keyword_nodes k ON k.id = pr.keyword_node_id
             LEFT JOIN persons ps ON ps.id = f.suggested_person_id LEFT JOIN keyword_nodes ks ON ks.id = ps.keyword_node_id
             WHERE f.photo_id IN (SELECT value FROM json_each(?1))
               AND NOT EXISTS (SELECT 1 FROM photo_face_scans s WHERE s.photo_id = f.photo_id AND s.needs_review = 1)
             ORDER BY f.photo_id, f.x",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![ids_json], |row| {
            Ok(FaceItem {
                id: row.get(0)?,
                photo_id: row.get(1)?,
                path: row.get(2)?,
                orientation: row.get::<_, Option<u32>>(3)?.unwrap_or(1),
                x: row.get(4)?,
                y: row.get(5)?,
                w: row.get(6)?,
                h: row.get(7)?,
                state: row.get(8)?,
                origin: row.get(9)?,
                person_id: row.get(10)?,
                suggested_person_id: row.get(11)?,
                name: row.get(12)?,
                score: row.get(13)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let faces: Vec<FaceItem> = rows.flatten().collect();
    Ok(faces)
}

/// Statut de scan des photos (filtre de la vue Photos) : (photo, à revérifier ?) pour les photos scannées avec le modèle actuel ou à revérifier.
/// Une photo absente de la liste n'est pas scannée.
#[tauri::command(async)]
pub fn get_face_scan_index(state: State<'_, AppState>) -> Result<Vec<(i64, bool)>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare("SELECT photo_id, needs_review FROM photo_face_scans WHERE needs_review = 1 OR (detector_id = ?1 AND model_id = ?2)")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![crate::face_detect::DETECTOR_ID, crate::face_recognize::MODEL_ID], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)))
        .map_err(|error| error.to_string())?;
    let pairs: Vec<(i64, bool)> = rows.flatten().collect();
    Ok(pairs)
}

fn ids_json(ids: &[i64]) -> Result<String, String> {
    serde_json::to_string(ids).map_err(|error| error.to_string())
}

/// Valider : les visages attribués automatiquement ou suggérés deviennent « confirmés » pour leur personne. Renvoie le nombre de visages validés.
#[tauri::command(async)]
pub fn confirm_faces(state: State<'_, AppState>, face_ids: Vec<i64>) -> Result<usize, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE faces SET state = 'confirmed', person_id = COALESCE(person_id, suggested_person_id), suggested_person_id = NULL,
                rejected_person_id = NULL, dirty = 1
         WHERE id IN (SELECT value FROM json_each(?1)) AND state IN ('auto', 'suggested', 'confirmed')
           AND COALESCE(person_id, suggested_person_id) IS NOT NULL",
        params![ids_json(&face_ids)?],
    )
    .map_err(|error| error.to_string())
}

/// Caractères refusés dans un nom de personne (mêmes règles que les mots-clés : séparateurs de niveaux et de liste).
fn valid_person_name(name: &str) -> Option<String> {
    let name = name.trim();
    (!name.is_empty() && !name.contains(['/', '|', ','])).then(|| name.to_string())
}

/// Personne désignée pour « Nommer » : une personne existante (`person_id`), la personne d'un mot-clé de l'arbre (`keyword_id` : créée et reliée
/// au mot-clé si besoin), ou un nom (`name` : personne existante de ce nom, sinon nouvelle personne reliée à un nouveau mot-clé sous la racine
/// `root`, chemin « A/B » ; racine vide : mot-clé de premier niveau). Erreurs : `invalid_name`, `unknown_person`, `unknown_keyword`,
/// `person_name_taken` (une autre personne porte déjà ce nom), `keyword_taken` (mot-clé déjà relié à une autre personne).
fn resolve_person(conn: &Connection, person_id: Option<i64>, keyword_id: Option<i64>, name: Option<&str>, root: &str) -> Result<i64, String> {
    if let Some(id) = person_id {
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM persons WHERE id = ?1)", params![id], |row| row.get(0)).map_err(|error| error.to_string())?;
        return if exists { Ok(id) } else { Err("unknown_person".to_string()) };
    }
    let link_or_create = |node_id: i64, name: &str| -> Result<i64, String> {
        if let Ok(id) = conn.query_row("SELECT id FROM persons WHERE keyword_node_id = ?1", params![node_id], |row| row.get::<_, i64>(0)) {
            return Ok(id);
        }
        let key = crate::keywords::name_key(name);
        match conn.query_row("SELECT id, keyword_node_id FROM persons WHERE name_key = ?1", params![key], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?))) {
            Ok((id, None)) => {
                conn.execute("UPDATE persons SET keyword_node_id = ?1 WHERE id = ?2", params![node_id, id]).map_err(|error| error.to_string())?;
                Ok(id)
            }
            Ok(_) => Err("person_name_taken".to_string()),
            Err(_) => {
                conn.execute("INSERT INTO persons (name, name_key, keyword_node_id) VALUES (?1, ?2, ?3)", params![name.trim(), key, node_id])
                    .map_err(|error| error.to_string())?;
                Ok(conn.last_insert_rowid())
            }
        }
    };
    if let Some(node_id) = keyword_id {
        let node_name: String = conn
            .query_row("SELECT name FROM keyword_nodes WHERE id = ?1", params![node_id], |row| row.get(0))
            .map_err(|_| "unknown_keyword".to_string())?;
        return link_or_create(node_id, &node_name);
    }
    let name = name.and_then(valid_person_name).ok_or_else(|| "invalid_name".to_string())?;
    if let Ok(id) = conn.query_row("SELECT id FROM persons WHERE name_key = ?1", params![crate::keywords::name_key(&name)], |row| row.get::<_, i64>(0)) {
        return Ok(id);
    }
    let mut parent_id = 0i64;
    for segment in root.split('/').map(str::trim).filter(|segment| !segment.is_empty()) {
        parent_id = crate::keywords::ensure_node(conn, parent_id, segment).map_err(|error| error.to_string())?;
    }
    let node_id = crate::keywords::ensure_node(conn, parent_id, &name).map_err(|error| error.to_string())?;
    let taken: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM persons WHERE keyword_node_id = ?1)", params![node_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if taken { return Err("keyword_taken".to_string()); }
    link_or_create(node_id, &name)
}

/// Nommer : les visages deviennent « confirmés » pour la personne désignée (voir resolve_person). Renvoie l'identifiant de la personne.
/// Lot 3 : la base seule change (visages marqués à réécrire) ; l'écriture dans les fichiers et l'activation du mot-clé viendront au lot 4.
#[tauri::command(async)]
pub fn assign_faces(
    state: State<'_, AppState>,
    face_ids: Vec<i64>,
    person_id: Option<i64>,
    keyword_id: Option<i64>,
    name: Option<String>,
    root: Option<String>,
) -> Result<i64, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let _ = conn.execute("BEGIN TRANSACTION", []);
    let result = resolve_person(&conn, person_id, keyword_id, name.as_deref(), root.as_deref().unwrap_or("")).and_then(|person| {
        conn.execute(
            "UPDATE faces SET person_id = ?1, state = 'confirmed', suggested_person_id = NULL, rejected_person_id = NULL, dirty = 1
             WHERE id IN (SELECT value FROM json_each(?2))",
            params![person, ids_json(&face_ids)?],
        )
        .map_err(|error| error.to_string())?;
        Ok(person)
    });
    let _ = conn.execute(if result.is_ok() { "COMMIT" } else { "ROLLBACK" }, []);
    result
}

/// Inconnu : la personne attribuée ou suggérée est retirée (et ne sera plus proposée pour ce visage).
#[tauri::command(async)]
pub fn set_faces_unknown(state: State<'_, AppState>, face_ids: Vec<i64>) -> Result<usize, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE faces SET rejected_person_id = COALESCE(person_id, suggested_person_id, rejected_person_id), person_id = NULL,
                suggested_person_id = NULL, state = 'unknown', dirty = CASE WHEN person_id IS NOT NULL THEN 1 ELSE dirty END
         WHERE id IN (SELECT value FROM json_each(?1)) AND state <> 'filtered'",
        params![ids_json(&face_ids)?],
    )
    .map_err(|error| error.to_string())
}

/// Ignorer : visage écarté volontairement (inconnu dans la foule, faux visage) ; il n'est plus attribué ni proposé.
#[tauri::command(async)]
pub fn ignore_faces(state: State<'_, AppState>, face_ids: Vec<i64>) -> Result<usize, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE faces SET state = 'ignored', person_id = NULL, suggested_person_id = NULL,
                dirty = CASE WHEN person_id IS NOT NULL THEN 1 ELSE dirty END
         WHERE id IN (SELECT value FROM json_each(?1))",
        params![ids_json(&face_ids)?],
    )
    .map_err(|error| error.to_string())
}

/// Ne plus ignorer : le visage redevient « inconnu » (la prochaine attribution peut le reconnaître).
#[tauri::command(async)]
pub fn unignore_faces(state: State<'_, AppState>, face_ids: Vec<i64>) -> Result<usize, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE faces SET state = 'unknown' WHERE id IN (SELECT value FROM json_each(?1)) AND state = 'ignored'",
        params![ids_json(&face_ids)?],
    )
    .map_err(|error| error.to_string())
}

/// N'est pas un visage : fausse détection. Comme « ignoré », le visage n'est ni attribué, ni proposé, ni écrit dans les fichiers (une zone déjà
/// écrite pour une personne est retirée à la prochaine écriture) ; un rescan le retrouve à sa place et lui garde cet état.
#[tauri::command(async)]
pub fn mark_faces_not_a_face(state: State<'_, AppState>, face_ids: Vec<i64>) -> Result<usize, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE faces SET state = 'not_face', person_id = NULL, suggested_person_id = NULL,
                dirty = CASE WHEN person_id IS NOT NULL THEN 1 ELSE dirty END
         WHERE id IN (SELECT value FROM json_each(?1))",
        params![ids_json(&face_ids)?],
    )
    .map_err(|error| error.to_string())
}

/// Annule « N'est pas un visage » : le visage redevient « inconnu » (la prochaine attribution peut le reconnaître).
#[tauri::command(async)]
pub fn unmark_faces_not_a_face(state: State<'_, AppState>, face_ids: Vec<i64>) -> Result<usize, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE faces SET state = 'unknown' WHERE id IN (SELECT value FROM json_each(?1)) AND state = 'not_face'",
        params![ids_json(&face_ids)?],
    )
    .map_err(|error| error.to_string())
}

/// Attribution sans nouveau scan (après une révision ou un changement de seuil) : seulement les empreintes en base, pas d'ONNX.
/// `photo_ids` : photos concernées (toutes si absent).
#[tauri::command(async)]
pub fn recognize_faces(state: State<'_, AppState>, photo_ids: Option<Vec<i64>>) -> Result<crate::face_recognize::AttributionSummary, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    crate::face_recognize::attribute_faces(&conn, photo_ids.as_deref(), crate::face_detect::settings().thresholds())
}

// ---------------------------------------------------------------------------
// Écriture dans les fichiers (lot 4) : zones de visage et mots-clés des personnes (spec §6.2 à §6.4)
// ---------------------------------------------------------------------------

/// Ce qu'une écriture doit mettre dans un fichier pour ses visages : zones nommées et mots-clés actifs qui en découlent.
pub struct FaceWritePlan {
    pub regions: crate::exif::RegionsUpdate,
    /// Mots-clés actifs à écrire (identifiants de l'arbre).
    pub keyword_ids: Vec<i64>,
    /// Les mots-clés écrits diffèrent de ceux de la photo (ou ont été fournis par l'utilisateur) : ils sont à écrire.
    pub keywords_changed: bool,
    /// Mots-clés activés par la reconnaissance lors de cette écriture (à noter dans face_keywords).
    added_by_faces: Vec<i64>,
    /// Mots-clés posés par la reconnaissance dont la personne n'a plus de visage sur la photo : retirés de la photo (pas de l'arbre).
    released: Vec<i64>,
}

/// La photo a des visages à écrire (visage modifié, ou zone à retirer).
pub fn has_pending_face_write(conn: &Connection, photo_id: i64) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM faces WHERE photo_id = ?1 AND dirty = 1) OR EXISTS(SELECT 1 FROM photo_face_writes WHERE photo_id = ?1)",
        params![photo_id],
        |row| row.get(0),
    )
    .unwrap_or(false)
}

fn id_set(conn: &Connection, sql: &str, photo_id: i64) -> Result<HashSet<i64>, String> {
    let mut statement = conn.prepare_cached(sql).map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![photo_id], |row| row.get::<_, i64>(0)).map_err(|error| error.to_string())?;
    Ok(rows.flatten().collect())
}

/// Plan d'écriture des visages d'une photo :
/// - zones : visages nommés (attribués automatiquement ou confirmés), sous le nom du mot-clé lié, à défaut celui de la personne ;
/// - mots-clés : ceux fournis par l'utilisateur (`explicit`, panneau Mots-clés) ou ceux de la photo, plus le mot-clé de chaque personne présente
///   (noté « posé par la reconnaissance » s'il n'y était pas), moins les mots-clés posés par la reconnaissance dont la personne n'a plus de visage.
pub fn plan_face_write(conn: &Connection, photo_id: i64, explicit: Option<&[i64]>) -> Result<FaceWritePlan, String> {
    let (width, height): (i64, i64) = conn
        .query_row("SELECT COALESCE(width, 0), COALESCE(height, 0) FROM photos WHERE id = ?1", params![photo_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| error.to_string())?;
    let mut regions = Vec::new();
    let mut wanted: HashSet<i64> = HashSet::new();
    {
        let mut statement = conn
            .prepare_cached(
                "SELECT f.x, f.y, f.w, f.h, COALESCE(k.name, p.name), p.keyword_node_id FROM faces f
                 JOIN persons p ON p.id = f.person_id LEFT JOIN keyword_nodes k ON k.id = p.keyword_node_id
                 WHERE f.photo_id = ?1 AND f.state IN ('auto', 'confirmed') ORDER BY f.x",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![photo_id], |row| {
                Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?, row.get::<_, f64>(2)?, row.get::<_, f64>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<i64>>(5)?))
            })
            .map_err(|error| error.to_string())?;
        for (x, y, w, h, name, keyword_id) in rows.flatten() {
            regions.push(crate::exif::RegionWrite { name: Some(name), x, y, w, h });
            if let Some(id) = keyword_id { wanted.insert(id); }
        }
    }
    let current = id_set(conn, "SELECT keyword_id FROM photo_keywords WHERE photo_id = ?1", photo_id)?;
    let recorded = id_set(conn, "SELECT keyword_id FROM face_keywords WHERE photo_id = ?1", photo_id)?;
    let base: Vec<i64> = explicit.map(<[i64]>::to_vec).unwrap_or_else(|| current.iter().copied().collect());
    let released: Vec<i64> = recorded.iter().copied().filter(|id| !wanted.contains(id)).collect();
    let added_by_faces: Vec<i64> = wanted.iter().copied().filter(|id| !base.contains(id)).collect();
    let mut keyword_ids: Vec<i64> = base.into_iter().filter(|id| !released.contains(id)).collect();
    keyword_ids.extend(added_by_faces.iter().copied());
    let keywords_changed = explicit.is_some() || keyword_ids.iter().copied().collect::<HashSet<i64>>() != current;
    Ok(FaceWritePlan { regions: crate::exif::RegionsUpdate { regions, width, height }, keyword_ids, keywords_changed, added_by_faces, released })
}

/// Après une écriture vérifiée : mots-clés posés par la reconnaissance notés (ou oubliés), visages de la photo écrits.
pub fn finish_face_write(conn: &Connection, photo_id: i64, plan: &FaceWritePlan) {
    for keyword_id in &plan.added_by_faces {
        let _ = conn.execute("INSERT OR IGNORE INTO face_keywords (photo_id, keyword_id) VALUES (?1, ?2)", params![photo_id, keyword_id]);
    }
    for keyword_id in &plan.released {
        let _ = conn.execute("DELETE FROM face_keywords WHERE photo_id = ?1 AND keyword_id = ?2", params![photo_id, keyword_id]);
    }
    let _ = conn.execute("UPDATE faces SET dirty = 0 WHERE photo_id = ?1", params![photo_id]);
    let _ = conn.execute("DELETE FROM photo_face_writes WHERE photo_id = ?1", params![photo_id]);
}

/// Photo dont un visage nommé disparaît de la base (rescan, effacement) : sa zone est à retirer du fichier.
pub fn mark_photo_for_write(conn: &Connection, photo_id: i64) {
    let _ = conn.execute("INSERT OR IGNORE INTO photo_face_writes (photo_id) VALUES (?1)", params![photo_id]);
}

/// Photos dont les visages attendent d'être écrits dans les fichiers : (identifiant, chemin).
#[tauri::command(async)]
pub fn get_pending_face_writes(state: State<'_, AppState>) -> Result<Vec<(i64, String)>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT p.id, p.path FROM photos p
             WHERE p.id IN (SELECT photo_id FROM faces WHERE dirty = 1 UNION SELECT photo_id FROM photo_face_writes) ORDER BY p.path",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))).map_err(|error| error.to_string())?;
    let pending: Vec<(i64, String)> = rows.flatten().collect();
    Ok(pending)
}

#[derive(serde::Deserialize)]
pub struct KeywordChange {
    pub photo_id: i64,
    pub keyword_ids: Vec<i64>,
}

/// Mot-clé d'une personne retiré à la main d'une photo alors qu'un de ses visages nommés y reste (spec §6.3).
#[derive(Serialize)]
pub struct FaceKeywordConflict {
    pub photo_id: i64,
    pub keyword_id: i64,
    pub name: String,
    pub face_ids: Vec<i64>,
}

/// Avant d'appliquer des mots-clés modifiés : retraits qui contredisent un visage nommé (mot-clé présent sur la photo, absent de la nouvelle liste,
/// et la personne y a encore un visage attribué ou confirmé). L'interface demande alors Garder ou Passer le visage en inconnu.
#[tauri::command(async)]
pub fn face_keyword_conflicts(state: State<'_, AppState>, changes: Vec<KeywordChange>) -> Result<Vec<FaceKeywordConflict>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let mut conflicts = Vec::new();
    for change in changes {
        let current = id_set(&conn, "SELECT keyword_id FROM photo_keywords WHERE photo_id = ?1", change.photo_id)?;
        let mut statement = conn
            .prepare_cached(
                "SELECT f.id, p.keyword_node_id, COALESCE(k.name, p.name) FROM faces f JOIN persons p ON p.id = f.person_id
                 JOIN keyword_nodes k ON k.id = p.keyword_node_id WHERE f.photo_id = ?1 AND f.state IN ('auto', 'confirmed')",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![change.photo_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)))
            .map_err(|error| error.to_string())?;
        let mut by_keyword: HashMap<i64, FaceKeywordConflict> = HashMap::new();
        for (face_id, keyword_id, name) in rows.flatten() {
            if !current.contains(&keyword_id) || change.keyword_ids.contains(&keyword_id) { continue; }
            by_keyword
                .entry(keyword_id)
                .or_insert_with(|| FaceKeywordConflict { photo_id: change.photo_id, keyword_id, name, face_ids: Vec::new() })
                .face_ids
                .push(face_id);
        }
        conflicts.extend(by_keyword.into_values());
    }
    Ok(conflicts)
}

/// « Effacer les données de visages » : les visages des photos sont supprimés de la base, les photos redeviennent « non scannées » et sont
/// marquées pour que leurs zones (et les mots-clés posés par la reconnaissance) soient retirées des fichiers. Personnes et mots-clés de l'arbre
/// conservés. Renvoie les photos à écrire : (identifiant, chemin).
#[tauri::command(async)]
pub fn erase_face_data(state: State<'_, AppState>, photo_ids: Vec<i64>) -> Result<Vec<(i64, String)>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let ids = ids_json(&photo_ids)?;
    let _ = conn.execute("BEGIN TRANSACTION", []);
    let result = (|| -> rusqlite::Result<Vec<(i64, String)>> {
        conn.execute("DELETE FROM faces WHERE photo_id IN (SELECT value FROM json_each(?1))", params![ids])?;
        conn.execute("DELETE FROM photo_face_scans WHERE photo_id IN (SELECT value FROM json_each(?1))", params![ids])?;
        conn.execute("INSERT OR IGNORE INTO photo_face_writes (photo_id) SELECT value FROM json_each(?1)", params![ids])?;
        let mut statement = conn.prepare("SELECT id, path FROM photos WHERE id IN (SELECT value FROM json_each(?1))")?;
        let rows = statement.query_map(params![ids], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?;
        Ok(rows.flatten().collect())
    })();
    let _ = conn.execute(if result.is_ok() { "COMMIT" } else { "ROLLBACK" }, []);
    result.map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Regroupement des visages inconnus (lot 5b, spec §5.3)
// ---------------------------------------------------------------------------

/// Nombre minimal de visages (cœur compris) pour former un groupe d'inconnus.
const CLUSTER_MIN_POINTS: usize = 2;

/// Groupes de visages inconnus qui se ressemblent, parmi ceux des photos `photo_ids` (vue de gestion) : DBSCAN sur leurs empreintes. Deux visages
/// sont voisins à partir du seuil d'attribution automatique (plus strict que la suggestion, pour ne pas enchaîner des personnes proches, comme
/// des frères et sœurs). Renvoie les groupes du plus grand au plus petit ; les visages isolés n'y figurent pas.
#[tauri::command(async)]
pub fn cluster_unknown_faces(state: State<'_, AppState>, photo_ids: Vec<i64>) -> Result<Vec<Vec<i64>>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT id, embedding FROM faces WHERE photo_id IN (SELECT value FROM json_each(?1))
             AND state = 'unknown' AND embedding IS NOT NULL AND model_id = ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![ids_json(&photo_ids)?, crate::face_recognize::MODEL_ID], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)))
        .map_err(|error| error.to_string())?;
    let faces: Vec<(i64, Vec<f32>)> = rows
        .flatten()
        .filter_map(|(id, blob)| crate::face_recognize::embedding_from_blob(&blob).map(|embedding| (id, embedding)))
        .collect();
    let min_similarity = crate::face_detect::settings().auto_threshold as f32;
    Ok(crate::face_recognize::dbscan(&faces, min_similarity, CLUSTER_MIN_POINTS))
}

// ---------------------------------------------------------------------------
// Gestion des personnes (lot 5a) : renommer, masquer, visage représentatif, supprimer, vignette de la vue Personnes
// ---------------------------------------------------------------------------

/// Renomme une personne non reliée à un mot-clé (pour une personne reliée, le nom affiché et écrit est celui du mot-clé : c'est lui qu'on renomme,
/// voir keywords::rename_keyword). Erreurs : `invalid_name`, `person_linked`, `person_name_taken`, `unknown_person`.
#[tauri::command(async)]
pub fn rename_person(state: State<'_, AppState>, person_id: i64, name: String) -> Result<(), String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let name = valid_person_name(&name).ok_or_else(|| "invalid_name".to_string())?;
    let linked: bool = conn
        .query_row("SELECT keyword_node_id IS NOT NULL FROM persons WHERE id = ?1", params![person_id], |row| row.get(0))
        .map_err(|_| "unknown_person".to_string())?;
    if linked { return Err("person_linked".to_string()); }
    let key = crate::keywords::name_key(&name);
    let taken: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM persons WHERE name_key = ?1 AND id <> ?2)", params![key, person_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if taken { return Err("person_name_taken".to_string()); }
    conn.execute("UPDATE persons SET name = ?1, name_key = ?2 WHERE id = ?3", params![name, key, person_id]).map_err(|error| error.to_string())?;
    // Les zones écrites portent l'ancien nom : visages de la personne à réécrire.
    let _ = conn.execute("UPDATE faces SET dirty = 1 WHERE person_id = ?1 AND state IN ('auto', 'confirmed')", params![person_id]);
    Ok(())
}

/// Masque ou affiche une personne : masquée, elle n'est plus attribuée ni proposée (face_recognize::attribute_faces), et l'interface la cache.
#[tauri::command(async)]
pub fn set_person_hidden(state: State<'_, AppState>, person_id: i64, hidden: bool) -> Result<(), String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    conn.execute("UPDATE persons SET hidden = ?1 WHERE id = ?2", params![hidden, person_id]).map_err(|error| error.to_string())?;
    Ok(())
}

/// Visage représentatif choisi par l'utilisateur (vue de gestion) : il doit être attribué à cette personne.
#[tauri::command(async)]
pub fn set_person_cover(state: State<'_, AppState>, person_id: i64, face_id: i64) -> Result<(), String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let belongs: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM faces WHERE id = ?1 AND person_id = ?2)", params![face_id, person_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if !belongs { return Err("face_not_of_person".to_string()); }
    conn.execute("UPDATE persons SET cover_face_id = ?1 WHERE id = ?2", params![face_id, person_id]).map_err(|error| error.to_string())?;
    Ok(())
}

/// Ce que la suppression d'une personne touche (fenêtre d'alerte) : visages encore rattachés et photos qui les portent.
#[derive(Serialize)]
pub struct PersonDeleteInfo {
    pub name: String,
    pub face_count: i64,
    pub photo_count: i64,
}

#[tauri::command(async)]
pub fn person_delete_info(state: State<'_, AppState>, person_id: i64) -> Result<PersonDeleteInfo, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let name: String = conn
        .query_row(
            "SELECT COALESCE(k.name, p.name) FROM persons p LEFT JOIN keyword_nodes k ON k.id = p.keyword_node_id WHERE p.id = ?1",
            params![person_id],
            |row| row.get(0),
        )
        .map_err(|_| "unknown_person".to_string())?;
    let (face_count, photo_count): (i64, i64) = conn
        .query_row("SELECT COUNT(*), COUNT(DISTINCT photo_id) FROM faces WHERE person_id = ?1", params![person_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| error.to_string())?;
    Ok(PersonDeleteInfo { name, face_count, photo_count })
}

/// Supprime une personne et ses caractéristiques de reconnaissance (ses visages confirmés ne servent plus de référence). Ses visages restants
/// deviennent « inconnus » et sont à réécrire (zone sans nom retirée, mot-clé retiré seulement s'il a été posé par la reconnaissance) ; les
/// suggestions et refus qui la visaient sont oubliés. Le mot-clé de l'arbre n'est pas supprimé. Renvoie le nombre de visages libérés.
#[tauri::command(async)]
pub fn delete_person(state: State<'_, AppState>, person_id: i64) -> Result<usize, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let _ = conn.execute("BEGIN TRANSACTION", []);
    let result = (|| -> rusqlite::Result<usize> {
        let released = conn.execute(
            "UPDATE faces SET state = CASE WHEN state IN ('auto', 'confirmed') THEN 'unknown' ELSE state END, person_id = NULL, dirty = 1 WHERE person_id = ?1",
            params![person_id],
        )?;
        conn.execute(
            "UPDATE faces SET state = CASE WHEN state = 'suggested' THEN 'unknown' ELSE state END, suggested_person_id = NULL WHERE suggested_person_id = ?1",
            params![person_id],
        )?;
        conn.execute("UPDATE faces SET rejected_person_id = NULL WHERE rejected_person_id = ?1", params![person_id])?;
        conn.execute("DELETE FROM persons WHERE id = ?1", params![person_id])?;
        Ok(released)
    })();
    let _ = conn.execute(if result.is_ok() { "COMMIT" } else { "ROLLBACK" }, []);
    let released = result.map_err(|error| error.to_string())?;
    remove_person_covers(&person_covers_dir(&state), person_id, None);
    Ok(released)
}

/// Dossier des vignettes de la vue Personnes (dans les données de l'application, déplacé avec elles).
pub fn person_covers_dir(state: &AppState) -> std::path::PathBuf {
    state.base_dir().join("person_covers")
}

/// Supprime les vignettes d'une personne, sauf `keep` (la vignette à jour).
fn remove_person_covers(dir: &std::path::Path, person_id: i64, keep: Option<&std::path::Path>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return; };
    let prefix = format!("{person_id}-");
    for entry in entries.flatten() {
        let path = entry.path();
        if keep.is_some_and(|kept| kept == path) { continue; }
        if path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(&prefix)) { let _ = std::fs::remove_file(path); }
    }
}

/// Vignette d'une personne pour la vue Personnes : son visage représentatif (choisi, à défaut le plus grand), recadré en carré autour du visage
/// depuis la photo d'ORIGINE (aperçu JPEG pour un RAW) et réduit à la taille du cache des miniatures (Paramètres > Données), orientation appliquée.
/// Gardée dans `person_covers/` sous un nom qui change avec le visage, la taille du cache et le fichier (chemin, taille, date) : une vignette
/// périmée n'est jamais resservie. Renvoie son chemin, ou None pour une personne sans visage.
#[tauri::command(async)]
pub fn get_person_cover(state: State<'_, AppState>, person_id: i64) -> Result<Option<String>, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let found = conn.query_row(
        "SELECT f.id, p.path, f.x, f.y, f.w, f.h, COALESCE(p.orientation, 1), COALESCE(p.width, 0), COALESCE(p.height, 0)
         FROM faces f JOIN photos p ON p.id = f.photo_id JOIN persons pr ON pr.id = f.person_id
         WHERE f.person_id = ?1 ORDER BY (f.id = pr.cover_face_id) DESC, f.w * f.h DESC LIMIT 1",
        params![person_id],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, [row.get::<_, f64>(2)?, row.get(3)?, row.get(4)?, row.get(5)?], row.get::<_, u32>(6)?, row.get::<_, i64>(7)?, row.get::<_, i64>(8)?)),
    );
    let Ok((face_id, path, rect, orientation, width, height)) = found else { return Ok(None); };
    drop(conn);
    let side = state.thumbnail_cache_size();
    let dir = person_covers_dir(&state);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    // Empreinte du fichier (chemin, taille, date) : même calcul que le cache des miniatures.
    let fingerprint = crate::thumbnail_cache_file(&dir, &path)?;
    let stem = fingerprint.file_stem().and_then(|stem| stem.to_str()).unwrap_or("0").to_string();
    let destination = dir.join(format!("{person_id}-{face_id}-{side}-{stem}.jpg"));
    if destination.is_file() { return Ok(Some(destination.to_string_lossy().into_owned())); }
    render_face_cover(std::path::Path::new(&path), rect, orientation, width, height, side, &destination)?;
    remove_person_covers(&dir, person_id, Some(&destination));
    Ok(Some(destination.to_string_lossy().into_owned()))
}

/// Recadre le visage `rect` (normalisé, repère de l'image stockée) dans un carré de 1,6 fois son plus grand côté, depuis l'original décodé à une
/// échelle suffisante pour que ce carré atteigne `side` px, puis réduit à `side` px au plus, applique l'orientation et écrit le JPEG.
fn render_face_cover(source: &std::path::Path, rect: [f64; 4], orientation: u32, width: i64, height: i64, side: usize, destination: &std::path::Path) -> Result<(), String> {
    const MARGIN: f64 = 1.6;
    // Côté du carré en pixels de l'original (dimensions EXIF, repère stocké) : de quoi choisir l'échelle de décodage.
    let wanted_max_side = if width > 0 && height > 0 {
        let square = ((rect[2] * width as f64).max(rect[3] * height as f64) * MARGIN).min(width.min(height) as f64).max(1.0);
        ((width.max(height) as f64) * side as f64 / square).ceil() as usize
    } else {
        side * 4
    };
    let (rgb, decoded_width, decoded_height) = crate::thumbnails::decode_scaled_rgb(source, wanted_max_side.clamp(side, 8000))?;
    let square = ((rect[2] * decoded_width as f64).max(rect[3] * decoded_height as f64) * MARGIN)
        .min(decoded_width.min(decoded_height) as f64)
        .max(1.0) as usize;
    let center_x = (rect[0] + rect[2] / 2.0) * decoded_width as f64;
    let center_y = (rect[1] + rect[3] / 2.0) * decoded_height as f64;
    let left = (center_x - square as f64 / 2.0).clamp(0.0, (decoded_width - square) as f64) as usize;
    let top = (center_y - square as f64 / 2.0).clamp(0.0, (decoded_height - square) as f64) as usize;
    let mut crop = Vec::with_capacity(square * square * 3);
    for row in top..top + square {
        let start = (row * decoded_width + left) * 3;
        crop.extend_from_slice(&rgb[start..start + square * 3]);
    }
    let output_side = square.min(side).max(1);
    let resized = if output_side == square { crop } else { crate::thumbnails::resize_area(&crop, square, square, output_side, output_side) };
    let (oriented, oriented_width, oriented_height) = crate::thumbnails::apply_orientation(resized, output_side, output_side, orientation);
    crate::thumbnails::write_jpeg(destination, &oriented, oriented_width, oriented_height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_mwg_written_by_exiftool_as_top_left() {
        let xml = r#"<rdf:Description rdf:about='' xmlns:mwg-rs='http://www.metadataworkinggroup.com/schemas/regions/' xmlns:stArea='http://ns.adobe.com/xmp/sType/Area#'>
  <mwg-rs:Regions rdf:parseType='Resource'><mwg-rs:RegionList><rdf:Bag><rdf:li rdf:parseType='Resource'>
   <mwg-rs:Area rdf:parseType='Resource'><stArea:h>0.2</stArea:h><stArea:unit>normalized</stArea:unit><stArea:w>0.1</stArea:w><stArea:x>0.5</stArea:x><stArea:y>0.4</stArea:y></mwg-rs:Area>
   <mwg-rs:Name>birdy</mwg-rs:Name><mwg-rs:Type>Face</mwg-rs:Type></rdf:li></rdf:Bag></mwg-rs:RegionList></mwg-rs:Regions></rdf:Description>"#;
        let regions = mwg_regions(xml);
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].name.as_deref(), Some("birdy"));
        assert!((regions[0].x - 0.45).abs() < 1e-9 && (regions[0].y - 0.3).abs() < 1e-9);
    }

    #[test]
    fn reads_mwg_written_by_exiv2_in_attributes() {
        let xml = r#"<rdf:Description rdf:about="" xmlns:mwg-rs="http://www.metadataworkinggroup.com/schemas/regions/" xmlns:stArea="http://ns.adobe.com/xmp/sType/Area#" xmlns:x="adobe:ns:meta/">
  <mwg-rs:Regions rdf:parseType="Resource"><mwg-rs:RegionList><rdf:Bag>
   <rdf:li><rdf:Description mwg-rs:Name="Jean &amp; Co" mwg-rs:Type="Face"><mwg-rs:Area stArea:x="0.5" stArea:y="0.5" stArea:w="0.2" stArea:h="0.2" stArea:unit="normalized"/></rdf:Description></rdf:li>
   <rdf:li><rdf:Description mwg-rs:Type="Focus"><mwg-rs:Area stArea:x="0.5" stArea:y="0.5" stArea:w="0.2" stArea:h="0.2" stArea:unit="normalized"/></rdf:Description></rdf:li>
  </rdf:Bag></mwg-rs:RegionList></mwg-rs:Regions></rdf:Description>"#;
        let regions = mwg_regions(xml);
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].name.as_deref(), Some("Jean & Co"));
        assert!((regions[0].x - 0.4).abs() < 1e-9);
    }

    #[test]
    fn reads_microsoft_rectangle_and_respects_priority() {
        let xml = r#"<rdf:Description xmlns:MP='http://ns.microsoft.com/photo/1.2/' xmlns:MPRI='http://ns.microsoft.com/photo/1.2/t/RegionInfo#' xmlns:MPReg='http://ns.microsoft.com/photo/1.2/t/Region#'>
  <MP:RegionInfo rdf:parseType='Resource'><MPRI:Regions><rdf:Bag><rdf:li rdf:parseType='Resource'>
   <MPReg:PersonDisplayName>birdy</MPReg:PersonDisplayName><MPReg:Rectangle>0.71164, 0.242312, 0.099537, 0.144097</MPReg:Rectangle>
  </rdf:li></rdf:Bag></MPRI:Regions></MP:RegionInfo></rdf:Description>"#;
        let regions = mp_regions(xml);
        assert_eq!(regions.len(), 1);
        assert!((regions[0].x - 0.71164).abs() < 1e-9 && (regions[0].h - 0.144097).abs() < 1e-9);
        // Aucun MWG dans ce paquet : le format suivant (Microsoft) est retenu.
        assert_eq!(parse_regions(xml), regions);
    }

    #[test]
    fn keeps_unnamed_faces() {
        let xml = r#"<rdf:Description xmlns:mwg-rs='http://www.metadataworkinggroup.com/schemas/regions/' xmlns:stArea='http://ns.adobe.com/xmp/sType/Area#'>
  <mwg-rs:Regions rdf:parseType='Resource'><mwg-rs:RegionList><rdf:Bag><rdf:li rdf:parseType='Resource'>
   <mwg-rs:Area rdf:parseType='Resource'><stArea:h>0.2</stArea:h><stArea:w>0.1</stArea:w><stArea:x>0.5</stArea:x><stArea:y>0.4</stArea:y></mwg-rs:Area>
   <mwg-rs:Type>Face</mwg-rs:Type></rdf:li></rdf:Bag></mwg-rs:RegionList></mwg-rs:Regions></rdf:Description>"#;
        let regions = mwg_regions(xml);
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].name, None);
    }
}
