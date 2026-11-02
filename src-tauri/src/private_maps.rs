//! Zones privées de la carte : lieux (cercle ou polygone) dont les tuiles sont téléchargées à l'avance et lues uniquement sur le disque.
//!
//! - Les zones sont en base (table `private_zones`) ; les tuiles de chacune dans un fichier MBTiles (SQLite, format standard et importable)
//!   rangé dans `<données de l'application>/private_maps/`, avec le style, les icônes et les polices de la carte privée (`style/`).
//! - Règle par tuile : toute tuile qui touche une zone est lue sur le disque, ou renvoyée vide si elle manque. L'interface ne la demande jamais
//!   au fournisseur (voir `get_private_tile` et src/map-tile-protocol.js).
//! - Téléchargement (création, mise à jour) : selon les règles d'OpenFreeMap pour l'usage hors ligne (3 000 tuiles ou 50 Mo au plus par
//!   téléchargement, 4 requêtes en parallèle, User-Agent propre à l'application), refusé en mode hors ligne. Tâche de la file (progression par
//!   « scan-progress », arrêt par cancel_scan) ; le fichier n'est remplacé qu'une fois le téléchargement terminé.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::Duration;
use tauri::{Emitter, State};

use crate::AppState;

const PROVIDER: &str = "https://tiles.openfreemap.org";
/// TileJSON du jeu de tuiles vectorielles : donne l'adresse versionnée des tuiles (renouvelée chaque semaine par le fournisseur).
const TILEJSON_URL: &str = "https://tiles.openfreemap.org/planet";
/// Styles enregistrés pour la carte privée (thème clair et thème sombre, voir src/map-config.js).
const STYLES: [&str; 2] = ["liberty", "dark"];
/// Plages de caractères enregistrées pour chaque police du style : latin de base, latin étendu, ponctuation générale.
const GLYPH_RANGES: [&str; 3] = ["0-255", "256-511", "8192-8447"];

/// Limites du fournisseur pour un téléchargement hors ligne.
pub const MAX_TILES: usize = 3000;
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;
const PARALLEL_REQUESTS: usize = 4;
/// Niveaux de détail proposés (zoom maximal téléchargé) : Ville, Quartier, Rues.
pub const DETAIL_ZOOMS: [u8; 3] = [12, 13, 14];
/// Estimation de la taille avant téléchargement (la vraie taille est mesurée après), d'après une zone urbaine téléchargée : les tuiles des
/// zooms 0 à 3 (une par niveau, le monde entier) pèsent ensemble ≈ 2,1 Mo ; au-delà, ≈ 60 à 100 Ko par tuile en ville, moins à la campagne.
const ESTIMATED_LOW_ZOOM_BYTES: u64 = 2200 * 1024;
const ESTIMATED_TILE_BYTES: u64 = 80 * 1024;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

fn user_agent() -> String {
    format!("photoboggan/{} (offline private map zones)", env!("CARGO_PKG_VERSION"))
}

// ---------------------------------------------------------------------------
// Géométrie : coordonnées Web Mercator normalisées (x et y de 0 à 1, y vers le sud), celles du découpage en tuiles.
// ---------------------------------------------------------------------------

/// Forme d'une zone : cercle (centre et rayon en mètres) ou polygone (sommets [latitude, longitude], sans répéter le premier).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ZoneGeometry {
    Circle { lat: f64, lon: f64, radius: f64 },
    Polygon { points: Vec<[f64; 2]> },
}

const MAX_LATITUDE: f64 = 85.051_128_78;
const EARTH_RADIUS: f64 = 6_371_008.8;
/// Nombre de côtés du polygone qui approche un cercle ; son rayon est agrandi pour que le polygone contienne le cercle.
const CIRCLE_SIDES: usize = 64;

pub(crate) fn mercator(lat: f64, lon: f64) -> (f64, f64) {
    let lat = lat.clamp(-MAX_LATITUDE, MAX_LATITUDE).to_radians();
    let x = (lon + 180.0) / 360.0;
    let y = (1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / std::f64::consts::PI) / 2.0;
    (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0))
}

/// Point à `distance` mètres de (lat, lon) dans la direction `bearing` (radians), sur la sphère.
fn destination(lat: f64, lon: f64, distance: f64, bearing: f64) -> (f64, f64) {
    let (lat1, lon1) = (lat.to_radians(), lon.to_radians());
    let angle = distance / EARTH_RADIUS;
    let lat2 = (lat1.sin() * angle.cos() + lat1.cos() * angle.sin() * bearing.cos()).asin();
    let lon2 = lon1 + (bearing.sin() * angle.sin() * lat1.cos()).atan2(angle.cos() - lat1.sin() * lat2.sin());
    (lat2.to_degrees(), lon2.to_degrees())
}

impl ZoneGeometry {
    /// Forme valide : cercle de 50 m à 200 km, polygone d'au moins 3 sommets, coordonnées dans les bornes. Les zones qui traversent
    /// l'antiméridien ne sont pas gérées.
    pub fn validate(&self) -> Result<(), String> {
        let valid_point = |lat: f64, lon: f64| lat.is_finite() && lon.is_finite() && lat.abs() <= MAX_LATITUDE && lon.abs() <= 180.0;
        let ok = match self {
            ZoneGeometry::Circle { lat, lon, radius } => valid_point(*lat, *lon) && (50.0..=200_000.0).contains(radius),
            ZoneGeometry::Polygon { points } => points.len() >= 3 && points.len() <= 1000 && points.iter().all(|p| valid_point(p[0], p[1])),
        };
        if ok { Ok(()) } else { Err("invalid_zone_geometry".to_string()) }
    }

    /// Contour en coordonnées Mercator normalisées.
    pub fn ring(&self) -> Vec<(f64, f64)> {
        match self {
            ZoneGeometry::Circle { lat, lon, radius } => {
                let outer = radius / (std::f64::consts::PI / CIRCLE_SIDES as f64).cos();
                (0..CIRCLE_SIDES)
                    .map(|side| {
                        let (plat, plon) = destination(*lat, *lon, outer, side as f64 * std::f64::consts::TAU / CIRCLE_SIDES as f64);
                        mercator(plat, plon)
                    })
                    .collect()
            }
            ZoneGeometry::Polygon { points } => points.iter().map(|p| mercator(p[0], p[1])).collect(),
        }
    }
}

/// Contour d'une zone prêt pour les tests de géométrie (rectangle englobant précalculé).
#[derive(Clone, Debug)]
pub struct ZoneShape {
    ring: Vec<(f64, f64)>,
    min: (f64, f64),
    max: (f64, f64),
}

impl ZoneShape {
    pub fn new(geometry: &ZoneGeometry) -> Self {
        let ring = geometry.ring();
        let min = ring.iter().fold((f64::MAX, f64::MAX), |acc, p| (acc.0.min(p.0), acc.1.min(p.1)));
        let max = ring.iter().fold((f64::MIN, f64::MIN), |acc, p| (acc.0.max(p.0), acc.1.max(p.1)));
        ZoneShape { ring, min, max }
    }

    /// Point (Mercator normalisé) dans le contour : règle du rayon (nombre de croisements impair).
    fn contains(&self, point: (f64, f64)) -> bool {
        if point.0 < self.min.0 || point.0 > self.max.0 || point.1 < self.min.1 || point.1 > self.max.1 { return false; }
        let mut inside = false;
        let count = self.ring.len();
        for index in 0..count {
            let (a, b) = (self.ring[index], self.ring[(index + count - 1) % count]);
            if (a.1 > point.1) != (b.1 > point.1) && point.0 < (b.0 - a.0) * (point.1 - a.1) / (b.1 - a.1) + a.0 {
                inside = !inside;
            }
        }
        inside
    }

    pub fn contains_location(&self, lat: f64, lon: f64) -> bool {
        self.contains(mercator(lat, lon))
    }

    /// Le rectangle (Mercator normalisé) touche le contour : un sommet dedans, un coin du rectangle dans le contour, ou deux côtés qui se croisent.
    fn intersects_rect(&self, min: (f64, f64), max: (f64, f64)) -> bool {
        if self.max.0 < min.0 || self.min.0 > max.0 || self.max.1 < min.1 || self.min.1 > max.1 { return false; }
        let inside_rect = |p: &(f64, f64)| p.0 >= min.0 && p.0 <= max.0 && p.1 >= min.1 && p.1 <= max.1;
        if self.ring.iter().any(inside_rect) { return true; }
        let corners = [min, (max.0, min.1), max, (min.0, max.1)];
        if corners.iter().any(|corner| self.contains(*corner)) { return true; }
        let count = self.ring.len();
        (0..count).any(|index| {
            let (a, b) = (self.ring[index], self.ring[(index + 1) % count]);
            (0..4).any(|side| segments_cross(a, b, corners[side], corners[(side + 1) % 4]))
        })
    }

    pub fn intersects_tile(&self, z: u8, x: u32, y: u32) -> bool {
        let size = 1.0 / f64::from(1u32 << z);
        self.intersects_rect((f64::from(x) * size, f64::from(y) * size), (f64::from(x + 1) * size, f64::from(y + 1) * size))
    }

    /// Tuiles qui touchent la zone, du zoom 0 à `max_zoom` (les niveaux larges aussi : la carte d'un lieu privé est locale à tout zoom).
    pub fn covering_tiles(&self, max_zoom: u8) -> Vec<(u8, u32, u32)> {
        let mut tiles = Vec::new();
        for z in 0..=max_zoom {
            let count = 1u32 << z;
            let to_index = |value: f64| ((value * f64::from(count)).floor() as i64).clamp(0, i64::from(count) - 1) as u32;
            for x in to_index(self.min.0)..=to_index(self.max.0) {
                for y in to_index(self.min.1)..=to_index(self.max.1) {
                    if self.intersects_tile(z, x, y) { tiles.push((z, x, y)); }
                }
            }
        }
        tiles
    }
}

fn segments_cross(a: (f64, f64), b: (f64, f64), c: (f64, f64), d: (f64, f64)) -> bool {
    let orientation = |p: (f64, f64), q: (f64, f64), r: (f64, f64)| (q.0 - p.0) * (r.1 - p.1) - (q.1 - p.1) * (r.0 - p.0);
    let (d1, d2) = (orientation(c, d, a), orientation(c, d, b));
    let (d3, d4) = (orientation(a, b, c), orientation(a, b, d));
    ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0))
}

// ---------------------------------------------------------------------------
// Zones en base et en mémoire
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct PrivateZone {
    pub id: i64,
    pub name: String,
    pub geometry: ZoneGeometry,
    pub max_zoom: u8,
    /// « download » (téléchargée depuis le fournisseur) ou « import » (fichier MBTiles importé).
    pub source: String,
    pub tile_count: i64,
    /// Tuiles qui n'ont pas pu être téléchargées (zone incomplète : la carte y reste vide).
    pub missing_count: i64,
    pub size_bytes: i64,
    /// Dernière mise à jour des tuiles (ms depuis 1970) ; 0 : jamais téléchargée.
    pub updated_at: i64,
    /// « pending » (pas encore téléchargée), « ready », « incomplete » ou « failed ».
    pub status: String,
    /// Zone privée (par défaut) : jamais de requête au fournisseur pour elle, mode strict pour ses photos. Sinon simple carte hors ligne : ses
    /// tuiles sont lues sur le disque quand elles y sont, le reste (tuile manquante, zoom plus fin) peut être demandé au fournisseur.
    pub private: bool,
}

pub fn init_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS private_zones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            geometry TEXT NOT NULL,
            max_zoom INTEGER NOT NULL,
            source TEXT NOT NULL DEFAULT 'download',
            tile_count INTEGER NOT NULL DEFAULT 0,
            missing_count INTEGER NOT NULL DEFAULT 0,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending'
        )",
    )?;
    // Zone privée ou simple carte hors ligne : les zones créées avant ce réglage restent privées.
    crate::db::add_column(conn, "private_zones", "private INTEGER NOT NULL DEFAULT 1");
    Ok(())
}

fn zone_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PrivateZone> {
    let geometry: String = row.get(2)?;
    let geometry = serde_json::from_str(&geometry)
        .map_err(|error| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error)))?;
    Ok(PrivateZone {
        id: row.get(0)?,
        name: row.get(1)?,
        geometry,
        max_zoom: row.get(3)?,
        source: row.get(4)?,
        tile_count: row.get(5)?,
        missing_count: row.get(6)?,
        size_bytes: row.get(7)?,
        updated_at: row.get(8)?,
        status: row.get(9)?,
        private: row.get(10)?,
    })
}

const ZONE_COLUMNS: &str = "id, name, geometry, max_zoom, source, tile_count, missing_count, size_bytes, updated_at, status, private";

pub fn list_zones(conn: &rusqlite::Connection) -> Result<Vec<PrivateZone>, String> {
    let mut stmt = conn.prepare(&format!("SELECT {ZONE_COLUMNS} FROM private_zones ORDER BY name COLLATE NOCASE, id")).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], zone_from_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

fn get_zone(conn: &rusqlite::Connection, id: i64) -> Result<PrivateZone, String> {
    conn.query_row(&format!("SELECT {ZONE_COLUMNS} FROM private_zones WHERE id = ?1"), [id], zone_from_row).map_err(|e| e.to_string())
}

/// Zones chargées en mémoire pour la règle par tuile (relues à chaque changement) et connexions ouvertes sur leurs fichiers MBTiles.
struct LoadedZone {
    id: i64,
    /// Nom du fichier MBTiles de la zone (voir zone_file_name).
    file: String,
    /// Zoom maximal téléchargé (niveau de détail).
    max_zoom: u8,
    /// Zone privée (sinon simple carte hors ligne).
    private: bool,
    shape: ZoneShape,
}

static ZONES: RwLock<Vec<LoadedZone>> = RwLock::new(Vec::new());
static TILE_FILES: Mutex<Option<HashMap<i64, rusqlite::Connection>>> = Mutex::new(None);

pub fn reload_zones(conn: &rusqlite::Connection) -> Result<(), String> {
    let loaded = load_zones(conn)?;
    *ZONES.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = loaded;
    Ok(())
}

fn load_zones(conn: &rusqlite::Connection) -> Result<Vec<LoadedZone>, String> {
    Ok(list_zones(conn)?
        .into_iter()
        .map(|zone| LoadedZone {
            id: zone.id,
            file: zone_file_name(&zone.name).unwrap_or_default(),
            max_zoom: zone.max_zoom,
            private: zone.private,
            shape: ZoneShape::new(&zone.geometry),
        })
        .collect())
}

/// Ferme la connexion ouverte sur le fichier d'une zone (avant de le remplacer ou de le supprimer).
fn close_tile_file(id: i64) {
    if let Some(files) = TILE_FILES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_mut() { files.remove(&id); }
}

/// Lieu privé : zoom maximal disponible au point, le plus fin des zones privées qui le contiennent (zones qui se recoupent : le détail présent
/// sur le disque à cet endroit) ; None si le point n'est dans aucune zone privée (les cartes hors ligne non privées ne comptent pas).
fn private_zoom_in(zones: &[LoadedZone], lat: f64, lon: f64) -> Option<u8> {
    zones.iter().filter(|zone| zone.private && zone.shape.contains_location(lat, lon)).map(|zone| zone.max_zoom).max()
}

pub fn private_maps_dir(state: &AppState) -> PathBuf {
    state.base_dir().join("private_maps")
}

/// Noms réservés par Windows, refusés comme nom de fichier (même suivis d'une extension).
const RESERVED_FILE_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Nom du fichier MBTiles d'une zone, tiré de son nom : minuscules, espaces remplacés par « _ », caractères interdits dans un nom de fichier
/// (Windows compris) retirés. Deux zones ne peuvent pas avoir le même nom de fichier (voir check_unique_name). Même règle dans
/// src/private-zones.js (zoneFileName), pour signaler un doublon pendant la saisie.
pub fn zone_file_name(name: &str) -> Result<String, String> {
    let slug: String = name
        .trim()
        .to_lowercase()
        .chars()
        .filter_map(|c| if c.is_whitespace() { Some('_') } else if c.is_control() || "<>:\"/\\|?*".contains(c) { None } else { Some(c) })
        .collect();
    let slug = slug.trim_end_matches(['.', '_']).trim_start_matches('.').to_string();
    if slug.is_empty() || RESERVED_FILE_NAMES.contains(&slug.as_str()) { return Err("invalid_zone_name".to_string()); }
    Ok(format!("{slug}.mbtiles"))
}

fn zone_file(dir: &Path, name: &str) -> Result<PathBuf, String> {
    Ok(dir.join(zone_file_name(name)?))
}

/// Fichiers des premières versions (`zone_<id>.mbtiles`) renommés d'après le nom de leur zone, au démarrage. Un fichier dont la cible existe
/// déjà est laissé tel quel (signalé dans la console).
pub fn migrate_legacy_files(dir: &Path, conn: &rusqlite::Connection) {
    let Ok(zones) = list_zones(conn) else { return; };
    for zone in zones {
        let legacy = dir.join(format!("zone_{}.mbtiles", zone.id));
        let Ok(target) = zone_file(dir, &zone.name) else { continue; };
        if !legacy.is_file() || legacy == target { continue; }
        if target.exists() {
            eprintln!("Private zone file not renamed, target exists: {}", target.display());
            continue;
        }
        close_tile_file(zone.id);
        if let Err(error) = fs::rename(&legacy, &target) { eprintln!("Private zone file not renamed ({}): {error}", legacy.display()); }
    }
}

/// Ferme toutes les connexions aux fichiers de tuiles (avant de déplacer le dossier de données).
pub fn close_all_tile_files() {
    *TILE_FILES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

/// Nom libre : aucune autre zone (sauf `except_id`, la zone renommée) n'a le même nom de fichier.
fn check_unique_name(conn: &rusqlite::Connection, name: &str, except_id: Option<i64>) -> Result<(), String> {
    let file = zone_file_name(name)?;
    let taken = list_zones(conn)?.iter().any(|zone| Some(zone.id) != except_id && zone_file_name(&zone.name).ok().as_deref() == Some(file.as_str()));
    if taken { Err("zone_name_taken".to_string()) } else { Ok(()) }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as i64).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Fichiers MBTiles : table `tiles` (rangées TMS, y inversé) et table `metadata`.
// ---------------------------------------------------------------------------

fn create_mbtiles(path: &Path, name: &str, max_zoom: u8) -> Result<rusqlite::Connection, String> {
    let _ = fs::remove_file(path);
    let conn = rusqlite::Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE metadata (name TEXT, value TEXT);
         CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
         CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);",
    )
    .map_err(|e| e.to_string())?;
    for (key, value) in [("name", name.to_string()), ("format", "pbf".to_string()), ("minzoom", "0".to_string()), ("maxzoom", max_zoom.to_string())] {
        conn.execute("INSERT INTO metadata (name, value) VALUES (?1, ?2)", (key, value)).map_err(|e| e.to_string())?;
    }
    Ok(conn)
}

fn tms_row(z: u8, y: u32) -> u32 {
    (1u32 << z) - 1 - y
}

/// Tuile d'un fichier MBTiles : Some(octets) si présente (éventuellement vide : tuile connue sans contenu), None si absente.
fn read_tile(conn: &rusqlite::Connection, z: u8, x: u32, y: u32) -> Option<Vec<u8>> {
    conn.query_row(
        "SELECT tile_data FROM tiles WHERE zoom_level = ?1 AND tile_column = ?2 AND tile_row = ?3",
        (z, x, tms_row(z, y)),
        |row| row.get::<_, Vec<u8>>(0),
    )
    .ok()
}

/// Résultat de la règle par tuile.
#[derive(Debug, PartialEq)]
pub enum TileAnswer {
    /// La tuile ne touche aucune zone : l'interface peut la demander au fournisseur (selon ses propres règles).
    Outside,
    /// La tuile touche une zone privée : lue sur le disque, vide si aucune zone ne l'a. Jamais demandée au fournisseur.
    Private(Vec<u8>),
    /// La tuile ne touche que des cartes hors ligne non privées : lue sur le disque si une zone l'a (Some, éventuellement vide : tuile connue
    /// sans contenu) ; None si elle manque, et l'interface peut alors la demander au fournisseur.
    Offline(Option<Vec<u8>>),
}

pub fn private_tile(dir: &Path, z: u8, x: u32, y: u32) -> TileAnswer {
    let zones = ZONES.read().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut files = TILE_FILES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    private_tile_in(&zones, files.get_or_insert_with(HashMap::new), dir, z, x, y)
}

/// Règle par tuile sur une liste de zones et un cache de connexions donnés (séparés de l'état global pour les tests).
/// Une zone privée qui touche la tuile l'emporte sur les cartes hors ligne : la tuile est alors lue dans n'importe quel fichier de zone qui l'a
/// (privée ou non), jamais ailleurs.
fn private_tile_in(zones: &[LoadedZone], files: &mut HashMap<i64, rusqlite::Connection>, dir: &Path, z: u8, x: u32, y: u32) -> TileAnswer {
    let touching: Vec<&LoadedZone> = zones.iter().filter(|zone| zone.shape.intersects_tile(z, x, y)).collect();
    if touching.is_empty() { return TileAnswer::Outside; }
    let mut known_empty = false;
    let mut found = None;
    for zone in &touching {
        let id = zone.id;
        if !files.contains_key(&id) {
            let path = dir.join(&zone.file);
            if !path.is_file() { continue; }
            let Ok(conn) = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { continue; };
            files.insert(id, conn);
        }
        match files.get(&id).and_then(|conn| read_tile(conn, z, x, y)) {
            Some(tile) if !tile.is_empty() => { found = Some(tile); break; }
            Some(_) => known_empty = true,
            None => {}
        }
    }
    if touching.iter().any(|zone| zone.private) { return TileAnswer::Private(found.unwrap_or_default()); }
    TileAnswer::Offline(found.or(known_empty.then(Vec::new)))
}

// ---------------------------------------------------------------------------
// Téléchargement depuis le fournisseur
// ---------------------------------------------------------------------------

fn http_get(url: &str) -> Result<Option<Vec<u8>>, String> {
    let response = ureq::get(url)
        .header("User-Agent", &user_agent())
        .config()
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_response(Some(RESPONSE_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .call()
        .map_err(|error| format!("{url} : {error}"))?;
    match response.status().as_u16() {
        200 => response.into_body().with_config().limit(MAX_BYTES).read_to_vec().map(Some).map_err(|error| format!("{url} : {error}")),
        // Tuile sans contenu (mer, désert) : connue et vide.
        204 | 404 => Ok(None),
        status => Err(format!("{url} : HTTP {status}")),
    }
}

/// Nom de fichier sûr pour une ressource du style (police, icônes) : lettres, chiffres, espace, tiret, point, virgule, arobase.
fn safe_component(text: &str) -> Option<String> {
    let ok = !text.is_empty() && text != "." && text != ".." && text.chars().all(|c| c.is_alphanumeric() || " -_.,@".contains(c));
    ok.then(|| text.to_string())
}

/// Ressources de la carte privée : styles (sources et adresses réécrites par l'interface), icônes et polices utilisées par les styles.
fn download_style_resources(style_dir: &Path, cancel: &AtomicBool) -> Result<(), String> {
    let partial = style_dir.with_extension("part");
    let _ = fs::remove_dir_all(&partial);
    let result = (|| -> Result<(), String> {
        let mut fonts: Vec<String> = Vec::new();
        let mut sprites: Vec<String> = Vec::new();
        for style in STYLES {
            let bytes = http_get(&format!("{PROVIDER}/styles/{style}"))?.ok_or_else(|| format!("style {style} introuvable"))?;
            let json: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if let Some(sprite) = json.get("sprite").and_then(|value| value.as_str()) {
                if !sprites.iter().any(|known| known == sprite) { sprites.push(sprite.to_string()); }
            }
            for layer in json.get("layers").and_then(|value| value.as_array()).into_iter().flatten() {
                for font in layer.pointer("/layout/text-font").and_then(|value| value.as_array()).into_iter().flatten() {
                    if let Some(font) = font.as_str() { if !fonts.iter().any(|known| known == font) { fonts.push(font.to_string()); } }
                }
            }
            fs::create_dir_all(partial.join("styles")).map_err(|e| e.to_string())?;
            fs::write(partial.join("styles").join(format!("{style}.json")), &bytes).map_err(|e| e.to_string())?;
        }
        // Icônes : un seul jeu (le même pour les deux styles), aux deux résolutions.
        let sprite = sprites.first().ok_or("style sans icônes")?;
        fs::create_dir_all(partial.join("sprites")).map_err(|e| e.to_string())?;
        for suffix in ["", "@2x"] {
            for extension in ["json", "png"] {
                if cancel.load(Ordering::Relaxed) { return Err("cancelled".to_string()); }
                if let Some(bytes) = http_get(&format!("{sprite}{suffix}.{extension}"))? {
                    fs::write(partial.join("sprites").join(format!("sprite{suffix}.{extension}")), bytes).map_err(|e| e.to_string())?;
                }
            }
        }
        for font in &fonts {
            let Some(folder) = safe_component(font) else { continue; };
            fs::create_dir_all(partial.join("fonts").join(&folder)).map_err(|e| e.to_string())?;
            for range in GLYPH_RANGES {
                if cancel.load(Ordering::Relaxed) { return Err("cancelled".to_string()); }
                let url = format!("{PROVIDER}/fonts/{}/{range}.pbf", font.replace(' ', "%20"));
                if let Some(bytes) = http_get(&url)? {
                    fs::write(partial.join("fonts").join(&folder).join(format!("{range}.pbf")), bytes).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            let _ = fs::remove_dir_all(style_dir);
            fs::rename(&partial, style_dir).map_err(|e| e.to_string())
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&partial);
            Err(error)
        }
    }
}

/// Adresse des tuiles vectorielles (modèle `{z}/{x}/{y}`), lue dans le TileJSON du fournisseur.
fn tile_url_template() -> Result<String, String> {
    let bytes = http_get(TILEJSON_URL)?.ok_or("TileJSON introuvable")?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let template = json.pointer("/tiles/0").and_then(|value| value.as_str()).ok_or("TileJSON sans adresse de tuiles")?;
    if !template.starts_with(PROVIDER) { return Err("adresse de tuiles inattendue".to_string()); }
    Ok(template.to_string())
}

/// Bilan d'un téléchargement de tuiles.
struct DownloadOutcome {
    stored: usize,
    missing: usize,
    over_size: bool,
}

/// Télécharge `tiles` dans le fichier MBTiles `conn` : 4 requêtes en parallèle, écriture par le fil appelant. S'arrête à la demande (`cancel`)
/// ou quand le total dépasse MAX_BYTES (zone incomplète).
fn download_tiles(
    conn: &mut rusqlite::Connection,
    template: &str,
    tiles: &[(u8, u32, u32)],
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(usize),
) -> Result<DownloadOutcome, String> {
    let next = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let (sender, receiver) = std::sync::mpsc::channel::<((u8, u32, u32), Result<Option<Vec<u8>>, String>)>();
    let mut outcome = DownloadOutcome { stored: 0, missing: 0, over_size: false };
    let mut total_bytes = 0u64;
    std::thread::scope(|scope| -> Result<(), String> {
        for _ in 0..PARALLEL_REQUESTS {
            let sender = sender.clone();
            let (next, stop) = (&next, &stop);
            scope.spawn(move || loop {
                if stop.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) || !crate::face_models::internet_allowed() { break; }
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(&(z, x, y)) = tiles.get(index) else { break; };
                let url = template.replace("{z}", &z.to_string()).replace("{x}", &x.to_string()).replace("{y}", &y.to_string());
                if sender.send(((z, x, y), http_get(&url))).is_err() { break; }
            });
        }
        drop(sender);
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for ((z, x, y), result) in receiver {
            match result {
                Ok(data) => {
                    let data = data.unwrap_or_default();
                    total_bytes += data.len() as u64;
                    tx.execute("INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?1, ?2, ?3, ?4)", (z, x, tms_row(z, y), data))
                        .map_err(|e| e.to_string())?;
                    outcome.stored += 1;
                }
                Err(error) => {
                    eprintln!("Private map tile not downloaded: {error}");
                    outcome.missing += 1;
                }
            }
            if total_bytes > MAX_BYTES {
                outcome.over_size = true;
                stop.store(true, Ordering::Relaxed);
            }
            progress(outcome.stored + outcome.missing);
        }
        tx.commit().map_err(|e| e.to_string())
    })?;
    if cancel.load(Ordering::Relaxed) { return Err("cancelled".to_string()); }
    if !crate::face_models::internet_allowed() { return Err("internet_disabled".to_string()); }
    // Tuiles jamais demandées (arrêt pour taille) : comptées comme manquantes.
    outcome.missing = tiles.len() - outcome.stored;
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

/// Zones privées, par ordre alphabétique.
#[tauri::command(async)]
pub fn list_private_zones(state: State<'_, AppState>) -> Result<Vec<PrivateZone>, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    reload_zones(&conn)?;
    list_zones(&conn)
}

#[derive(Serialize)]
pub struct ZoneEstimate {
    pub tiles: usize,
    pub bytes: u64,
    pub within_limits: bool,
}

pub fn estimate(geometry: &ZoneGeometry, max_zoom: u8) -> ZoneEstimate {
    let covering = ZoneShape::new(geometry).covering_tiles(max_zoom);
    let tiles = covering.len();
    let detailed = covering.iter().filter(|tile| tile.0 >= 4).count() as u64;
    let bytes = ESTIMATED_LOW_ZOOM_BYTES + detailed * ESTIMATED_TILE_BYTES;
    ZoneEstimate { tiles, bytes, within_limits: tiles <= MAX_TILES && bytes <= MAX_BYTES }
}

fn check_detail(max_zoom: u8) -> Result<(), String> {
    if DETAIL_ZOOMS.contains(&max_zoom) { Ok(()) } else { Err("invalid_detail_level".to_string()) }
}

/// Estimation avant téléchargement : nombre de tuiles, taille approximative, et respect des limites du fournisseur.
#[tauri::command(async)]
pub fn estimate_private_zone(geometry: ZoneGeometry, max_zoom: u8) -> Result<ZoneEstimate, String> {
    geometry.validate()?;
    check_detail(max_zoom)?;
    Ok(estimate(&geometry, max_zoom))
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 { Err("invalid_zone_name".to_string()) } else { Ok(name.to_string()) }
}

/// Enregistre une zone à télécharger (statut « pending ») ; le téléchargement est une tâche à part (`download_private_zone`). Elle protège
/// déjà la carte : ses tuiles sont considérées comme locales (vides tant qu'elles ne sont pas téléchargées).
#[tauri::command(async)]
pub fn add_private_zone(state: State<'_, AppState>, name: String, geometry: ZoneGeometry, max_zoom: u8, private: bool) -> Result<PrivateZone, String> {
    geometry.validate()?;
    check_detail(max_zoom)?;
    let name = clean_name(&name)?;
    if !estimate(&geometry, max_zoom).within_limits { return Err("zone_too_large".to_string()); }
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    check_unique_name(&conn, &name, None)?;
    let json = serde_json::to_string(&geometry).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO private_zones (name, geometry, max_zoom, private) VALUES (?1, ?2, ?3, ?4)", (&name, &json, max_zoom, private))
        .map_err(|e| e.to_string())?;
    let zone = get_zone(&conn, conn.last_insert_rowid())?;
    reload_zones(&conn)?;
    Ok(zone)
}

/// Télécharge (ou met à jour) les tuiles d'une zone, et les ressources du style s'il le faut. Tâche de la file : progression par
/// « scan-progress », arrêt par cancel_scan. L'ancien fichier n'est remplacé qu'à la fin ; un arrêt le laisse intact.
#[tauri::command]
pub async fn download_private_zone(app: tauri::AppHandle, state: State<'_, AppState>, zone_id: i64, task_id: String) -> Result<PrivateZone, String> {
    let dir = private_maps_dir(&state);
    let pool = state.pool();
    let cancel = crate::scan_cancel_flag(&task_id);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || -> Result<PrivateZone, String> {
        if !crate::face_models::internet_allowed() { return Err("internet_disabled".to_string()); }
        let conn = pool.get().map_err(|e| e.to_string())?;
        let zone = get_zone(&conn, zone_id)?;
        if zone.source == "import" { return Err("imported_zone".to_string()); }
        let tiles = ZoneShape::new(&zone.geometry).covering_tiles(zone.max_zoom);
        if tiles.len() > MAX_TILES { return Err("zone_too_large".to_string()); }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let emit = |percent: u32| { let _ = app.emit("scan-progress", crate::ScanProgress { task_id: worker_task_id.clone(), percent }); };
        // Ressources du style : téléchargées avec la première zone, renouvelées à chaque mise à jour.
        download_style_resources(&dir.join("style"), &cancel)?;
        emit(2);
        let template = tile_url_template()?;
        // Fichier temporaire nommé d'après l'identifiant : la zone peut être renommée pendant le téléchargement.
        let partial = dir.join(format!("zone_{zone_id}.part"));
        let mut file = create_mbtiles(&partial, &zone.name, zone.max_zoom)?;
        let total = tiles.len().max(1);
        let mut last_percent = 0u32;
        let result = download_tiles(&mut file, &template, &tiles, &cancel, &mut |done| {
            let percent = 2 + (done * 98 / total) as u32;
            if percent != last_percent { last_percent = percent; emit(percent); }
        });
        drop(file);
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(error) => {
                let _ = fs::remove_file(&partial);
                return Err(error);
            }
        };
        close_tile_file(zone_id);
        // Nom relu à la fin : celui en vigueur maintenant (renommage pendant le téléchargement).
        let target = zone_file(&dir, &get_zone(&conn, zone_id)?.name)?;
        fs::rename(&partial, &target).map_err(|error| {
            let _ = fs::remove_file(&partial);
            error.to_string()
        })?;
        let size = fs::metadata(&target).map(|metadata| metadata.len() as i64).unwrap_or(0);
        let status = if outcome.missing == 0 && !outcome.over_size { "ready" } else { "incomplete" };
        conn.execute(
            "UPDATE private_zones SET tile_count = ?1, missing_count = ?2, size_bytes = ?3, updated_at = ?4, status = ?5 WHERE id = ?6",
            (outcome.stored as i64, outcome.missing as i64, size, now_millis(), status, zone_id),
        )
        .map_err(|e| e.to_string())?;
        get_zone(&conn, zone_id)
    })
    .await;
    crate::release_scan_cancel_flag(&task_id);
    let outcome = outcome.map_err(|error| error.to_string())?;
    // Échec d'une zone jamais téléchargée : signalé dans la liste (« failed ») pour que l'utilisateur la relance ou la supprime.
    if outcome.is_err() {
        if let Ok(conn) = state.pool().get() {
            let _ = conn.execute("UPDATE private_zones SET status = 'failed' WHERE id = ?1 AND updated_at = 0", [zone_id]);
        }
    }
    outcome
}

/// Renomme la zone et son fichier de tuiles (le fichier suit le nom, voir zone_file_name).
#[tauri::command(async)]
pub fn rename_private_zone(state: State<'_, AppState>, zone_id: i64, name: String) -> Result<PrivateZone, String> {
    let name = clean_name(&name)?;
    let dir = private_maps_dir(&state);
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    check_unique_name(&conn, &name, Some(zone_id))?;
    let old = zone_file(&dir, &get_zone(&conn, zone_id)?.name)?;
    let new = zone_file(&dir, &name)?;
    if old != new && old.is_file() {
        close_tile_file(zone_id);
        fs::rename(&old, &new).map_err(|e| e.to_string())?;
    }
    if let Err(error) = conn.execute("UPDATE private_zones SET name = ?1 WHERE id = ?2", (&name, zone_id)) {
        if old != new && new.is_file() { let _ = fs::rename(&new, &old); }
        return Err(error.to_string());
    }
    reload_zones(&conn)?;
    get_zone(&conn, zone_id)
}

/// Supprime la zone et son fichier de tuiles. Le style partagé est supprimé avec la dernière zone.
#[tauri::command(async)]
pub fn delete_private_zone(state: State<'_, AppState>, zone_id: i64) -> Result<(), String> {
    let dir = private_maps_dir(&state);
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    let file = zone_file(&dir, &get_zone(&conn, zone_id)?.name);
    conn.execute("DELETE FROM private_zones WHERE id = ?1", [zone_id]).map_err(|e| e.to_string())?;
    reload_zones(&conn)?;
    close_tile_file(zone_id);
    if let Ok(file) = file { let _ = fs::remove_file(file); }
    if list_zones(&conn)?.is_empty() { let _ = fs::remove_dir_all(dir.join("style")); }
    Ok(())
}

/// Vérifie un fichier MBTiles à importer : tuiles vectorielles (`format` = pbf) et au moins une tuile. Renvoie son zoom maximal et ses bornes
/// (ouest, sud, est, nord) si le fichier les donne.
pub fn inspect_mbtiles(path: &Path) -> Result<(u8, Option<[f64; 4]>), String> {
    let conn = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| "invalid_mbtiles".to_string())?;
    let metadata = |key: &str| conn.query_row("SELECT value FROM metadata WHERE name = ?1", [key], |row| row.get::<_, String>(0)).ok();
    if metadata("format").as_deref() != Some("pbf") { return Err("mbtiles_not_vector".to_string()); }
    let max_zoom: Option<u8> = conn.query_row("SELECT MAX(zoom_level) FROM tiles", [], |row| row.get(0)).map_err(|_| "invalid_mbtiles".to_string())?;
    let max_zoom = max_zoom.ok_or("invalid_mbtiles")?.min(14);
    let bounds = metadata("bounds").and_then(|text| {
        let values: Vec<f64> = text.split(',').filter_map(|part| part.trim().parse().ok()).collect();
        (values.len() == 4).then(|| [values[0], values[1], values[2], values[3]])
    });
    Ok((max_zoom, bounds))
}

/// Importe un fichier MBTiles obtenu ailleurs (aucune requête réseau) : copié dans le dossier des zones. Sans `geometry`, la zone est le
/// rectangle des bornes du fichier.
#[tauri::command(async)]
pub fn import_private_zone(state: State<'_, AppState>, path: String, name: String, geometry: Option<ZoneGeometry>) -> Result<PrivateZone, String> {
    let name = clean_name(&name)?;
    zone_file_name(&name)?;
    let source = PathBuf::from(&path);
    let (max_zoom, bounds) = inspect_mbtiles(&source)?;
    let geometry = match geometry {
        Some(geometry) => geometry,
        None => {
            let [west, south, east, north] = bounds.ok_or("mbtiles_without_bounds")?;
            ZoneGeometry::Polygon { points: vec![[south, west], [south, east], [north, east], [north, west]] }
        }
    };
    geometry.validate()?;
    let dir = private_maps_dir(&state);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    check_unique_name(&conn, &name, None)?;
    let json = serde_json::to_string(&geometry).map_err(|e| e.to_string())?;
    let size = fs::metadata(&source).map(|metadata| metadata.len() as i64).map_err(|e| e.to_string())?;
    let tile_count: i64 = rusqlite::Connection::open_with_flags(&source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|file| file.query_row("SELECT COUNT(*) FROM tiles", [], |row| row.get(0)))
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO private_zones (name, geometry, max_zoom, source, tile_count, size_bytes, updated_at, status) VALUES (?1, ?2, ?3, 'import', ?4, ?5, ?6, 'ready')",
        (&name, &json, max_zoom, tile_count, size, now_millis()),
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    let target = zone_file(&dir, &name)?;
    let partial = dir.join(format!("zone_{id}.part"));
    if let Err(error) = fs::copy(&source, &partial).and_then(|_| fs::rename(&partial, &target)) {
        let _ = fs::remove_file(&partial);
        let _ = conn.execute("DELETE FROM private_zones WHERE id = ?1", [id]);
        return Err(error.to_string());
    }
    reload_zones(&conn)?;
    get_zone(&conn, id)
}

/// Tuile pour la carte (règle par tuile, voir TileAnswer), premier octet :
/// 0 : aucune zone (l'interface peut la demander au fournisseur, selon ses propres règles) ;
/// 1 + tuile : zone privée, tuile lue sur le disque (rien si elle manque), jamais demandée au fournisseur ;
/// 2 + tuile : carte hors ligne, tuile lue sur le disque ;
/// 3 : carte hors ligne, tuile absente du disque (l'interface peut la demander au fournisseur, selon ses propres règles).
#[tauri::command(async)]
pub fn get_private_tile(state: State<'_, AppState>, z: u8, x: u32, y: u32) -> tauri::ipc::Response {
    if z > 22 || x >= (1u32 << z) || y >= (1u32 << z) { return tauri::ipc::Response::new(vec![1]); }
    let with_tile = |flag: u8, tile: Vec<u8>| {
        let mut body = Vec::with_capacity(tile.len() + 1);
        body.push(flag);
        body.extend(tile);
        body
    };
    let body = match private_tile(&private_maps_dir(&state), z, x, y) {
        TileAnswer::Outside => vec![0],
        TileAnswer::Private(tile) => with_tile(1, tile),
        TileAnswer::Offline(Some(tile)) => with_tile(2, tile),
        TileAnswer::Offline(None) => vec![3],
    };
    tauri::ipc::Response::new(body)
}

/// Zone privée ou simple carte hors ligne (case « Privée » de la fenêtre des zones).
#[tauri::command(async)]
pub fn set_private_zone_privacy(state: State<'_, AppState>, zone_id: i64, private: bool) -> Result<PrivateZone, String> {
    let conn = state.pool().get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE private_zones SET private = ?1 WHERE id = ?2", (private, zone_id)).map_err(|e| e.to_string())?;
    reload_zones(&conn)?;
    get_zone(&conn, zone_id)
}

/// Ressource du style privé (`styles/<nom>.json`, `sprites/sprite[@2x].json|png`, `fonts/<police>/<plage>.pbf`) ; vide si absente.
#[tauri::command(async)]
pub fn get_private_resource(state: State<'_, AppState>, path: String) -> tauri::ipc::Response {
    let parts: Option<Vec<String>> = path.split('/').map(safe_component).collect();
    let file = parts.filter(|parts| (2..=3).contains(&parts.len())).map(|parts| {
        parts.iter().fold(private_maps_dir(&state).join("style"), |dir, part| dir.join(part))
    });
    tauri::ipc::Response::new(file.and_then(|file| fs::read(file).ok()).unwrap_or_default())
}

/// Pour chaque position ([latitude, longitude]) : None si elle n'est dans aucune zone privée, sinon le zoom maximal disponible à cet endroit
/// (voir private_zoom_in), qui plafonne la carte en mode strict.
#[tauri::command(async)]
pub fn locate_private_points(points: Vec<[f64; 2]>) -> Vec<Option<u8>> {
    let zones = ZONES.read().unwrap_or_else(|poisoned| poisoned.into_inner());
    points.iter().map(|point| private_zoom_in(&zones, point[0], point[1])).collect()
}

#[cfg(test)]
#[path = "tests/private_maps.rs"]
mod tests;
