use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::params;
use serde::{Deserialize, Serialize};

pub type DbPool = Pool<SqliteConnectionManager>;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Photo {
    pub id: i64,
    pub path: String,
    pub filename: String,
    pub date_taken: String,
    pub aperture: String,
    pub shutter_speed: String,
    pub iso: i32,
    pub focal_length: String,
    pub manufacturer: String,
    pub camera_model: String,
    pub lens_model: String,
    pub width: i32,
    pub height: i32,
    pub file_size: i64,
    pub rating: i32,
    pub color_flag: String,
    /// Fanion « pick » : none, pending (digiKam seulement), picked ou rejected (voir exif::PICK_SOURCE_IDS).
    pub pick_flag: String,
    pub keywords: String,
    /// Titre retenu à la lecture (voir exif::TITLE_SOURCE_IDS).
    pub title: String,
    /// Description retenue à la lecture (voir exif::DESCRIPTION_SOURCE_IDS).
    pub caption: String,
    /// Coordonnées GPS retenues à la lecture (voir exif::GPS_SOURCE_IDS), en degrés décimaux ; None : photo non géolocalisée.
    #[serde(default)]
    pub gps_lat: Option<f64>,
    #[serde(default)]
    pub gps_lon: Option<f64>,
    /// Flash déclenché (Some(true)), non déclenché (Some(false)) ou inconnu (None : tag absent) : voir exif::flash_fired.
    #[serde(default)]
    pub flash: Option<bool>,
    // Date de modification du fichier (ms depuis 1970) lue en base : sert au tri par date de modification.
    // Elle n'est pas écrite par les insertions (voir library_sync::store_modified), d'où la valeur 0 des constructions hors lecture.
    #[serde(default)]
    pub modified: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TrackedFolder {
    pub id: i64,
    pub path: String,
}

/// Ajoute une colonne à une table existante (mise à niveau d'un catalogue sans le perdre). « Colonne déjà présente » est le cas normal ;
/// toute autre erreur arrête le démarrage avec un message clair, plutôt que de laisser des requêtes échouer plus tard.
pub(crate) fn add_column(conn: &rusqlite::Connection, table: &str, definition: &str) {
    if let Err(error) = conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {definition}"), []) {
        if !error.to_string().contains("duplicate column name") {
            panic!("Database migration failed ({table}: {definition}): {error}");
        }
    }
}

pub fn init_db(db_path: &str) -> DbPool {
    let manager = SqliteConnectionManager::file(db_path).with_init(|c| {
        c.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA temp_store=MEMORY;
             PRAGMA cache_size=-64000;
             PRAGMA mmap_size=30000000000;"
        )?;
        Ok(())
    });

    let pool = Pool::new(manager).expect("Database pool could not be created");
    let conn = pool.get().expect("Database connection unavailable");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL
        )",
        [],
    ).unwrap();

    conn.execute(
        "CREATE TABLE IF NOT EXISTS photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE,
            filename TEXT,
            date_taken TEXT,
            aperture TEXT,
            shutter_speed TEXT,
            iso INTEGER,
            focal_length TEXT,
            manufacturer TEXT,
            camera_model TEXT,
            width INTEGER,
            height INTEGER,
            file_size INTEGER,
            rating INTEGER DEFAULT 0,
            color_flag TEXT DEFAULT 'none'
        )",
        [],
    ).unwrap();

    // Mise à niveau des catalogues existants, sans perdre les données.
    add_column(&conn, "photos", "keywords TEXT NOT NULL DEFAULT ''");
    add_column(&conn, "photos", "caption TEXT NOT NULL DEFAULT ''");
    add_column(&conn, "photos", "lens_model TEXT NOT NULL DEFAULT ''");
    add_column(&conn, "photos", "title TEXT NOT NULL DEFAULT ''");
    // Date de modification du fichier (ms depuis 1970) au moment de la dernière lecture : sert à détecter les modifications faites hors de l'application.
    add_column(&conn, "photos", "modified INTEGER NOT NULL DEFAULT 0");
    // Orientation EXIF (1 à 8) : les zones de visage sont dans le repère de l'image stockée et l'interface l'applique pour les afficher (faces.rs).
    add_column(&conn, "photos", "orientation INTEGER NOT NULL DEFAULT 1");
    // Fanion « pick » (none, pending, picked, rejected) : rempli à la lecture des fichiers (relire la collection pour les photos déjà cataloguées).
    add_column(&conn, "photos", "pick_flag TEXT NOT NULL DEFAULT 'none'");
    // Coordonnées GPS (NULL : pas de position) : remplies à la lecture des fichiers (relire la collection pour les photos déjà cataloguées).
    add_column(&conn, "photos", "gps_lat REAL");
    add_column(&conn, "photos", "gps_lon REAL");
    // Flash (1 déclenché, 0 non déclenché, NULL inconnu) : rempli à la lecture des fichiers (relire la collection pour les photos déjà cataloguées).
    add_column(&conn, "photos", "flash INTEGER");

    conn.execute("CREATE INDEX IF NOT EXISTS idx_date ON photos(date_taken)", []).unwrap();
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rating ON photos(rating)", []).unwrap();
    conn.execute("CREATE INDEX IF NOT EXISTS idx_flag ON photos(color_flag)", []).unwrap();
    conn.execute("CREATE INDEX IF NOT EXISTS idx_path ON photos(path)", []).unwrap();

    // Mots-clés hiérarchiques (arborescence et association photo ↔ mot-clé) : voir keywords.rs.
    crate::keywords::init_schema(&conn).expect("Keyword tables could not be created");
    // Albums virtuels (dossiers, albums manuels et intelligents) : voir albums.rs.
    crate::albums::init_schema(&conn).expect("Album tables could not be created");
    // Visages et personnes : voir faces.rs.
    crate::faces::init_schema(&conn).expect("Face tables could not be created");
    // Coordonnées GPS effacées (sauvegarde pour « Restaurer la géolocalisation ») : voir geolocation.rs.
    crate::geolocation::init_schema(&conn).expect("Erased locations table could not be created");
    // Cache of the file hashes used by the duplicate search: voir duplicates.rs (empty until a search is started).
    crate::duplicates::init_schema(&conn).expect("Duplicate hash table could not be created");
    // Cache of the perceptual hashes used by the similar-image search: voir similar.rs (empty until a search is started).
    crate::similar::init_schema(&conn).expect("Perceptual hash table could not be created");
    // Zones privées de la carte : voir private_maps.rs (chargées en mémoire dès l'ouverture, pour la règle par tuile).
    crate::private_maps::init_schema(&conn).expect("Private zone table could not be created");
    if let Err(error) = crate::private_maps::reload_zones(&conn) { eprintln!("Private zones unavailable: {error}"); }

    pool
}

pub fn get_folders(pool: &DbPool) -> Vec<TrackedFolder> {
    let conn = match pool.get() {
        Ok(conn) => conn,
        Err(error) => {
            eprintln!("Tracked folders unavailable (no connection): {error}");
            return Vec::new();
        }
    };
    let folders = (|| -> rusqlite::Result<Vec<TrackedFolder>> {
        let mut stmt = conn.prepare("SELECT id, path FROM folders ORDER BY path ASC")?;
        let rows = stmt.query_map([], |row| Ok(TrackedFolder { id: row.get(0)?, path: row.get(1)? }))?;
        rows.collect()
    })();
    folders.unwrap_or_else(|error| {
        eprintln!("Tracked folders unavailable: {error}");
        Vec::new()
    })
}

pub fn add_folder(pool: &DbPool, path: &str) -> Result<i64, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("INSERT OR IGNORE INTO folders (path) VALUES (?)", params![path])
        .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// Retire un dossier suivi et les photos qu'il contenait, en une seule transaction. Une photo qui se trouve aussi dans un autre dossier suivi
/// (dossiers imbriqués) reste au catalogue ; les dossiers voisins au nom proche (`D:\Photo2` pour `D:\Photo`) ne sont pas touchés.
pub fn remove_folder(pool: &DbPool, id: i64, folder_path: &str) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM folders WHERE id = ?", params![id]).map_err(|e| e.to_string())?;
    let remaining: Vec<String> = {
        let mut stmt = tx.prepare("SELECT path FROM folders").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
    };
    let doomed: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id, path FROM photos WHERE path IS NOT NULL").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
        let photos: Vec<(i64, String)> = rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?;
        photos
            .into_iter()
            .filter(|(_, path)| crate::is_inside_folder(folder_path, path) && !remaining.iter().any(|root| crate::is_inside_folder(root, path)))
            .map(|(id, _)| id)
            .collect()
    };
    let ids_json = serde_json::to_string(&doomed).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM photos WHERE id IN (SELECT value FROM json_each(?1))", params![ids_json]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Colonnes lues par `photo_from_row`, dans cet ordre.
pub(crate) const PHOTO_COLUMNS: &str = "id, path, filename, date_taken, aperture, shutter_speed, iso, focal_length, manufacturer, camera_model, width, height, \
     file_size, rating, color_flag, keywords, caption, lens_model, modified, title, pick_flag, gps_lat, gps_lon, flash";

/// Photo d'une ligne du catalogue. Les colonnes qui acceptent NULL (catalogues anciens) prennent une valeur par défaut : une photo n'est
/// jamais écartée de la liste parce qu'une de ses colonnes est vide.
pub(crate) fn photo_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Photo> {
    fn text(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<String> {
        Ok(row.get::<_, Option<String>>(index)?.unwrap_or_default())
    }
    fn flag(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<String> {
        Ok(row.get::<_, Option<String>>(index)?.unwrap_or_else(|| "none".to_string()))
    }
    Ok(Photo {
        id: row.get(0)?,
        path: text(row, 1)?,
        filename: text(row, 2)?,
        date_taken: text(row, 3)?,
        aperture: text(row, 4)?,
        shutter_speed: text(row, 5)?,
        iso: row.get::<_, Option<i32>>(6)?.unwrap_or_default(),
        focal_length: text(row, 7)?,
        manufacturer: text(row, 8)?,
        camera_model: text(row, 9)?,
        width: row.get::<_, Option<i32>>(10)?.unwrap_or_default(),
        height: row.get::<_, Option<i32>>(11)?.unwrap_or_default(),
        file_size: row.get::<_, Option<i64>>(12)?.unwrap_or_default(),
        rating: row.get::<_, Option<i32>>(13)?.unwrap_or_default(),
        color_flag: flag(row, 14)?,
        keywords: text(row, 15)?,
        caption: text(row, 16)?,
        lens_model: text(row, 17)?,
        modified: row.get::<_, Option<i64>>(18)?.unwrap_or_default(),
        title: text(row, 19)?,
        pick_flag: flag(row, 20)?,
        gps_lat: row.get(21)?,
        gps_lon: row.get(22)?,
        flash: row.get::<_, Option<i64>>(23)?.map(|value| value != 0),
    })
}

/// Page de photos, de la plus récente à la plus ancienne (à date égale, par identifiant : l'ordre reste stable d'une page à l'autre).
/// Une erreur de lecture est renvoyée, jamais masquée par une liste incomplète. Tests only: the app calls `get_photos_filtered`.
#[cfg(test)]
pub fn get_photos(pool: &DbPool, offset: i32, limit: i32, folder_filter: Option<String>, recursive: bool) -> Result<Vec<Photo>, String> {
    get_photos_sorted(pool, offset, limit, folder_filter, recursive, "taken", false)
}

/// Folder condition shared by the list and the count: `?1` is the folder prefix (normalised, ending with "/"), `?2` the recursion flag.
/// Without a folder, `?1` is empty and every photo matches.
const FOLDER_CONDITION: &str = "(?1 = '' OR (substr(replace(path, char(92), '/'), 1, length(?1)) = ?1
     AND (?2 OR instr(substr(replace(path, char(92), '/'), length(?1) + 1), '/') = 0)))";

fn folder_prefix(folder: Option<&str>) -> String {
    folder.map(|folder| format!("{}/", folder.replace('\\', "/").trim_end_matches('/'))).unwrap_or_default()
}

/// A dated photo for the date sort: the interface ignores empty dates such as `0000:00:00` (they sort with the undated ones).
const DATED: &str = "date_taken >= '1000'";

/// Filters the backend applies BEFORE the list is cut at its limit, so a capped list holds the photos the user is looking for.
/// It may keep more photos than the interface filters (it is a superset, never a subset): the interface filters the list again exactly.
/// Empty fields filter nothing. Sent by `sqlPrefilter` (main.js).
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PhotoPrefilter {
    /// Rating at least / exactly this value; `unrated`: rating 0 only.
    pub rating_min: Option<i32>,
    pub rating_eq: Option<i32>,
    pub unrated: bool,
    /// Accepted colour labels / pick flags (`none` = no label).
    pub colors: Vec<String>,
    pub picks: Vec<String>,
    /// Keywords that must all appear in the `keywords` text (substring: superset of the interface's whole-keyword match).
    pub keywords: Vec<String>,
    /// Years of the date filter (the interface filters the exact instants).
    pub year_from: Option<i32>,
    pub year_to: Option<i32>,
    /// Persons who must all appear on the photo (named faces).
    pub persons: Vec<i64>,
    /// `true`: with GPS coordinates; `false`: without.
    pub geolocated: Option<bool>,
}

/// SQL condition of a prefilter (`1` when it filters nothing). Its parameters are appended to `values`; placeholders are numbered after
/// the `first` fixed ones of the statement.
fn prefilter_condition(filter: &PhotoPrefilter, first: usize, values: &mut Vec<rusqlite::types::Value>) -> String {
    use rusqlite::types::Value;
    let push = |value: Value, values: &mut Vec<Value>| {
        values.push(value);
        format!("?{}", first + values.len())
    };
    let mut parts: Vec<String> = Vec::new();
    if filter.unrated {
        parts.push("COALESCE(rating, 0) = 0".into());
    } else if let Some(stars) = filter.rating_eq {
        parts.push(format!("COALESCE(rating, 0) = {}", push(Value::Integer(stars.into()), values)));
    } else if let Some(stars) = filter.rating_min {
        parts.push(format!("COALESCE(rating, 0) >= {}", push(Value::Integer(stars.into()), values)));
    }
    // Labels as the interface reads them: an empty or missing value is "none".
    for (column, accepted) in [("color_flag", &filter.colors), ("pick_flag", &filter.picks)] {
        if accepted.is_empty() {
            continue;
        }
        let marks: Vec<String> = accepted.iter().map(|value| push(Value::Text(value.clone()), values)).collect();
        parts.push(format!("COALESCE(NULLIF({column}, ''), 'none') IN ({})", marks.join(", ")));
    }
    for keyword in filter.keywords.iter().filter(|keyword| !keyword.is_empty()) {
        parts.push(format!("instr(COALESCE(keywords, ''), {}) > 0", push(Value::Text(keyword.clone()), values)));
    }
    if filter.year_from.is_some() || filter.year_to.is_some() {
        // A date that does not start with its year (unusual format) is kept: the interface decides.
        let from = push(Value::Integer(filter.year_from.unwrap_or(0).into()), values);
        let to = push(Value::Integer(filter.year_to.unwrap_or(9999).into()), values);
        parts.push(format!(
            "date_taken IS NOT NULL AND (date_taken NOT GLOB '[0-9][0-9][0-9][0-9]*' OR CAST(substr(date_taken, 1, 4) AS INTEGER) BETWEEN {from} AND {to})"
        ));
    }
    for person in &filter.persons {
        parts.push(format!("id IN (SELECT photo_id FROM faces WHERE person_id = {})", push(Value::Integer(*person), values)));
    }
    match filter.geolocated {
        Some(true) => parts.push("gps_lat IS NOT NULL AND gps_lon IS NOT NULL".into()),
        Some(false) => parts.push("(gps_lat IS NULL OR gps_lon IS NULL)".into()),
        None => {}
    }
    if parts.is_empty() {
        "1".into()
    } else {
        parts.iter().map(|part| format!("({part})")).collect::<Vec<_>>().join(" AND ")
    }
}

/// Page of photos in the interface sort order (`taken`, `modified` or `name`; unknown keys sort by date taken), optionally limited to a
/// folder (with or without its subfolders). Photos without the sort value come last in both directions, like the interface sort; ties keep
/// a stable order. When the list is capped, this decides WHICH photos are loaded: ascending by date must start with the oldest ones.
#[cfg(test)]
pub fn get_photos_sorted(pool: &DbPool, offset: i32, limit: i32, folder_filter: Option<String>, recursive: bool, sort_key: &str, ascending: bool) -> Result<Vec<Photo>, String> {
    get_photos_filtered(pool, offset, limit, folder_filter, recursive, sort_key, ascending, &PhotoPrefilter::default())
}

/// Fixed placeholders of the list and count statements: ?1 folder prefix, ?2 recursion, ?3 limit, ?4 offset; the prefilter's follow.
const FIXED_PARAMS: usize = 4;

/// `get_photos_sorted` restricted by a prefilter (see `PhotoPrefilter`).
#[allow(clippy::too_many_arguments)]
pub fn get_photos_filtered(pool: &DbPool, offset: i32, limit: i32, folder_filter: Option<String>, recursive: bool, sort_key: &str, ascending: bool, filter: &PhotoPrefilter) -> Result<Vec<Photo>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let prefix = folder_prefix(folder_filter.as_deref());
    let direction = if ascending { "ASC" } else { "DESC" };
    let mut filter_values = Vec::new();
    let filter_sql = prefilter_condition(filter, FIXED_PARAMS, &mut filter_values);
    let statement_values = |limit: i32, offset: i32| {
        let mut values = vec![prefix.clone().into(), recursive.into(), limit.into(), offset.into()];
        values.extend(filter_values.iter().cloned());
        values
    };
    let page = |condition: &str, order: &str, limit: i32, offset: i32| -> Result<Vec<Photo>, String> {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {PHOTO_COLUMNS} FROM photos WHERE {FOLDER_CONDITION} AND ({condition}) AND ({filter_sql}) ORDER BY {order} LIMIT ?3 OFFSET ?4"
            ))
            .map_err(|e| e.to_string())?;
        let values: Vec<rusqlite::types::Value> = statement_values(limit, offset);
        let rows = stmt.query_map(rusqlite::params_from_iter(values), photo_from_row).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<Photo>>>().map_err(|e| e.to_string())
    };
    match sort_key {
        "modified" => page("1", &format!("modified <= 0, modified {direction}, id {direction}"), limit, offset),
        "name" => page("1", &format!("filename COLLATE NOCASE {direction}, path {direction}, id {direction}"), limit, offset),
        _ => {
            // Dated photos first, read through the `date_taken` index, then the undated ones. A single ORDER BY starting with an
            // "is dated" expression gives the same order but loses the index: ~15 times slower on a 250,000-photo catalogue.
            let mut photos = page(DATED, &format!("date_taken {direction}, id {direction}"), limit, offset)?;
            let missing = limit - photos.len() as i32;
            if missing > 0 {
                // The page ends past the dated photos: the undated ones fill it. Offset among them = what the offset skips beyond the dated ones.
                let skip = if photos.is_empty() && offset > 0 {
                    let dated = count_matching(&conn, &prefix, recursive, DATED, &filter_sql, &filter_values)?;
                    (offset as i64 - dated).max(0) as i32
                } else {
                    0
                };
                photos.extend(page(&format!("NOT ({DATED}) OR date_taken IS NULL"), &format!("id {direction}"), missing, skip)?);
            }
            Ok(photos)
        }
    }
}

/// Photos matching the folder, an extra condition and a prefilter condition (with its values), counted with the same statement shape.
fn count_matching(conn: &rusqlite::Connection, prefix: &str, recursive: bool, condition: &str, filter_sql: &str, filter_values: &[rusqlite::types::Value]) -> Result<i64, String> {
    let mut values: Vec<rusqlite::types::Value> = vec![prefix.to_string().into(), recursive.into(), (-1i64).into(), 0i64.into()];
    values.extend(filter_values.iter().cloned());
    conn.query_row(
        &format!("SELECT COUNT(*) FROM (SELECT 1 FROM photos WHERE {FOLDER_CONDITION} AND ({condition}) AND ({filter_sql}) LIMIT ?3 OFFSET ?4)"),
        rusqlite::params_from_iter(values),
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Number of photos the same query would return without a limit: the interface tells the user when its list is capped.
pub fn count_photos(pool: &DbPool, folder_filter: Option<String>, recursive: bool, filter: &PhotoPrefilter) -> Result<i64, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut filter_values = Vec::new();
    let filter_sql = prefilter_condition(filter, FIXED_PARAMS, &mut filter_values);
    count_matching(&conn, &folder_prefix(folder_filter.as_deref()), recursive, "1", &filter_sql, &filter_values)
}

/// Photos of the given paths (duplicate search results), in chunks to stay under the SQLite variable limit. Unknown paths are skipped.
pub fn get_photos_by_paths(pool: &DbPool, paths: &[String]) -> Result<Vec<Photo>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut photos = Vec::with_capacity(paths.len());
    for chunk in paths.chunks(500) {
        let marks = vec!["?"; chunk.len()].join(",");
        let mut stmt = conn.prepare(&format!("SELECT {PHOTO_COLUMNS} FROM photos WHERE path IN ({marks})")).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params_from_iter(chunk.iter()), photo_from_row).map_err(|e| e.to_string())?;
        for row in rows {
            photos.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(photos)
}

/// Nombre de photos et vidéos par dossier (niveau direct, sans les sous-dossiers), sur tout le catalogue et sans filtre.
/// Les chemins sont normalisés en « / » sans « / » final : l'interface en tire les totaux de chaque sous-arbre.
/// Le dossier est le chemin privé de son dernier segment (`rtrim(p, replace(p, '/', ''))` retire tout ce qui suit le dernier « / »).
pub fn get_folder_counts(pool: &DbPool) -> Result<std::collections::HashMap<String, i64>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT rtrim(p, replace(p, '/', '')) AS dir, COUNT(*)
             FROM (SELECT replace(path, char(92), '/') AS p FROM photos) GROUP BY dir",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut counts = std::collections::HashMap::new();
    for row in rows {
        let (dir, count) = row.map_err(|e| e.to_string())?;
        counts.insert(dir.trim_end_matches('/').to_string(), count);
    }
    Ok(counts)
}

#[cfg(test)]
#[path = "tests/db.rs"]
mod tests;
