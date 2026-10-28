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
fn namespace_prefixes(xml: &str, uri: &str) -> Vec<String> {
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
        let existing: Vec<(i64, [f64; 4], String)> = conn
            .prepare_cached("SELECT id, x, y, w, h, state FROM faces WHERE photo_id = ?1 AND origin = 'imported'")
            .and_then(|mut statement| {
                statement
                    .query_map(params![photo_id], |row| Ok((row.get(0)?, [row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?], row.get(5)?)))
                    .map(|rows| rows.flatten().collect())
            })
            .unwrap_or_default();
        let mut matched: Vec<i64> = Vec::new();
        for region in regions {
            let rect = [region.x, region.y, region.w, region.h];
            let person_id = region.name.as_deref().and_then(|name| ensure_person(conn, name).ok());
            if let Some(id) = person_id { touched.insert(id); }
            let best = existing
                .iter()
                .filter(|(id, _, _)| !matched.contains(id))
                .map(|candidate| (candidate, crate::face_detect::iou(&candidate.1, &rect)))
                .filter(|(_, overlap)| *overlap >= 0.5)
                .max_by(|a, b| a.1.total_cmp(&b.1));
            match best {
                Some(((id, _, old_state), _)) => {
                    matched.push(*id);
                    let _ = conn.execute("UPDATE faces SET x = ?1, y = ?2, w = ?3, h = ?4 WHERE id = ?5", params![rect[0], rect[1], rect[2], rect[3], id]);
                    if old_state == "ignored" { continue; }
                    if person_id.is_some() {
                        let _ = conn.execute(
                            "UPDATE faces SET person_id = ?1, state = 'confirmed', suggested_person_id = NULL WHERE id = ?2",
                            params![person_id, id],
                        );
                    } else if old_state == "confirmed" {
                        let _ = conn.execute("UPDATE faces SET person_id = NULL, state = 'unknown' WHERE id = ?1", params![id]);
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
        for (id, _, _) in existing.iter().filter(|(id, _, _)| !matched.contains(id)) {
            let _ = conn.execute("DELETE FROM faces WHERE id = ?1", params![id]);
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
                "SELECT f.person_id, f.photo_id, p.path, f.x, f.y, f.w, f.h, p.orientation, f.id = pr.cover_face_id
                 FROM faces f JOIN photos p ON p.id = f.photo_id JOIN persons pr ON pr.id = f.person_id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    FaceCover {
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
        .prepare("SELECT pr.id, COALESCE(k.name, pr.name), pr.keyword_node_id FROM persons pr LEFT JOIN keyword_nodes k ON k.id = pr.keyword_node_id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?)))
        .map_err(|error| error.to_string())?;
    let persons = rows
        .flatten()
        .map(|(id, name, keyword_id)| {
            let photo_count = photos_by_person.get(&id).map_or(0, |photos| photos.len() as i64);
            PersonInfo { id, name, keyword_id, photo_count, cover: covers.remove(&id).map(|(_, _, cover)| cover) }
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
             WHERE f.photo_id = ?1 AND f.state NOT IN ('filtered', 'ignored') ORDER BY f.x",
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

/// Attribution sans nouveau scan (après une révision ou un changement de seuil) : seulement les empreintes en base, pas d'ONNX.
/// `photo_ids` : photos concernées (toutes si absent).
#[tauri::command(async)]
pub fn recognize_faces(state: State<'_, AppState>, photo_ids: Option<Vec<i64>>) -> Result<crate::face_recognize::AttributionSummary, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    crate::face_recognize::attribute_faces(&conn, photo_ids.as_deref(), crate::face_detect::settings().thresholds())
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
