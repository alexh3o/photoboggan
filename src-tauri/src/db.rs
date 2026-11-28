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
    /// Fanion « pick » : none, pending (digiKam seulement), picked ou rejected (voir `exif::PICK_SOURCE_IDS`).
    pub pick_flag: String,
    pub keywords: String,
    /// Titre retenu à la lecture (voir `exif::TITLE_SOURCE_IDS`).
    pub title: String,
    /// Description retenue à la lecture (voir `exif::DESCRIPTION_SOURCE_IDS`).
    pub caption: String,
    /// Coordonnées GPS retenues à la lecture (voir `exif::GPS_SOURCE_IDS`), en degrés décimaux ; None : photo non géolocalisée.
    #[serde(default)]
    pub gps_lat: Option<f64>,
    #[serde(default)]
    pub gps_lon: Option<f64>,
    /// Flash déclenché (Some(true)), non déclenché (Some(false)) ou inconnu (None : tag absent) : voir `exif::flash_fired`.
    #[serde(default)]
    pub flash: Option<bool>,
    // Date de modification du fichier (ms depuis 1970) lue en base : sert au tri par date de modification.
    // Elle n'est pas écrite par les insertions (voir library_sync::store_modified), d'où la valeur 0 des constructions hors lecture.
    #[serde(default)]
    pub modified: i64,
    /// Effective date of the last metadata change (ms since 1970): the later of the image file's mtime and the mtime of the `.xmp` sidecar it reads.
    /// It exists because a sidecar write never touches the image, so `modified` (strictly the image file's mtime, the witness of
    /// `library_sync::sync_library`) cannot move. 0 = unknown (catalogue read before this column existed): every consumer falls back to `modified`,
    /// see `EFFECTIVE_MODIFIED` (SQL) and `photoModifiedTime` (main.js), which must stay the same rule.
    #[serde(default)]
    pub effective_modified: i64,
    /// File creation date (ms since 1970, 0 = unknown): recorded when files are read (`library_sync::store_dates`).
    #[serde(default)]
    pub created: i64,
    /// Resolved EXIF/XMP orientation (1..=8, 1 for HEIC whose container rotation is already applied to width/height).
    #[serde(default = "one")]
    pub orientation: u32,
    /// Orientation the interface applies on top of the webview's when it shows the original file (see `orientation::Resolved`).
    #[serde(default = "one")]
    pub view_fix: u32,
    /// Auteur retenu à la lecture (voir `exif::AUTHOR_SOURCE_IDS`) ; plusieurs auteurs : « A; B ». Dans la liste des photos pour le filtre « Auteur ».
    #[serde(default)]
    pub author: String,
    /// Copyright, crédit, conditions d'utilisation et e-mail de l'auteur : enregistrés avec la photo mais jamais envoyés avec la liste (l'interface les
    /// demande pour la sélection, voir `rights::get_photo_rights`). Vides sur une photo lue par `photo_from_row`.
    #[serde(skip)]
    pub copyright: String,
    #[serde(skip)]
    pub credit: String,
    #[serde(skip)]
    pub usage_terms: String,
    #[serde(skip)]
    pub author_email: String,
}

fn one() -> u32 { 1 }

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TrackedFolder {
    pub id: i64,
    pub path: String,
}

/// Adds a column to an existing table (upgrading an older catalogue without losing data).
/// "duplicate column name" is the normal idempotent case; any other error is propagated so startup stops cleanly.
pub(crate) fn add_column(conn: &rusqlite::Connection, table: &str, definition: &str) -> rusqlite::Result<()> {
    match conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {definition}"), []) {
        Ok(_) => Ok(()),
        Err(error) if error.to_string().contains("duplicate column name") => Ok(()),
        Err(error) => Err(error),
    }
}

const CONNECTION_INIT_SQL: &str =
    "PRAGMA journal_mode=WAL;
     PRAGMA synchronous=NORMAL;
     PRAGMA temp_store=MEMORY;
     PRAGMA cache_size=-64000;
     PRAGMA mmap_size=30000000000;";

pub fn init_db(db_path: &str) -> Result<DbPool, String> {
    // Fail fast on invalid paths or non-SQLite files instead of waiting for r2d2's 30s pool timeout.
    {
        let probe = rusqlite::Connection::open(db_path)
            .map_err(|e| format!("Database could not be opened: {e}"))?;
        probe.execute_batch(CONNECTION_INIT_SQL)
            .map_err(|e| format!("Database could not be initialized: {e}"))?;
    }

    let manager = SqliteConnectionManager::file(db_path).with_init(|c| {
        c.execute_batch(CONNECTION_INIT_SQL)?;
        Ok(())
    });

    let pool = Pool::new(manager).map_err(|e| format!("Database pool could not be created: {e}"))?;
    let conn = pool.get().map_err(|e| format!("Database connection unavailable: {e}"))?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL
        )",
        [],
    ).map_err(|e| format!("Folders table could not be created: {e}"))?;

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
    ).map_err(|e| format!("Photos table could not be created: {e}"))?;

    // Upgrade existing catalogues without losing data.
    let add_photo_col = |def: &str| add_column(&conn, "photos", def).map_err(|e| format!("Database migration failed (photos: {def}): {e}"));
    add_photo_col("keywords TEXT NOT NULL DEFAULT ''")?;
    add_photo_col("caption TEXT NOT NULL DEFAULT ''")?;
    add_photo_col("lens_model TEXT NOT NULL DEFAULT ''")?;
    add_photo_col("title TEXT NOT NULL DEFAULT ''")?;
    // File modification time (ms since 1970) at the last read: detects external changes.
    add_photo_col("modified INTEGER NOT NULL DEFAULT 0")?;
    // Later of the image's and its active sidecar's modification dates (ms since 1970, 0 = unknown, then `modified` applies): sort key of the
    // modification date. Kept apart from `modified`, which must stay the image file's own mtime for the incremental sync. Filled when files are read
    // and after each metadata write (library_sync::store_dates, and the UPDATE of each write command).
    add_photo_col("effective_modified INTEGER NOT NULL DEFAULT 0")?;
    // File creation time (ms since 1970, 0 = unknown): filled when reading files (rescan for already catalogued photos).
    // Used for privacy-set date ranges on photos without a shooting date (privacy.rs: falls back to `modified` when 0).
    add_photo_col("created INTEGER NOT NULL DEFAULT 0")?;
    // When the file's metadata was last read (ms since 1970, 0 = unknown): a paused scan resumes by skipping the files read since it first started.
    add_photo_col("scanned_at INTEGER NOT NULL DEFAULT 0")?;
    // EXIF orientation (1 to 8): face boxes are in the stored image frame and the interface applies it on display (faces.rs).
    add_photo_col("orientation INTEGER NOT NULL DEFAULT 1")?;
    // Orientation the interface applies on top of the webview's, which only knows the EXIF tag of the file (see orientation.rs): differs from 1
    // only after a lossless rotation written in XMP (internal writer, sidecar of a PNG…). Filled with `orientation`.
    add_photo_col("view_fix INTEGER NOT NULL DEFAULT 1")?;
    // Pick flag (none, pending, picked, rejected): filled when reading files (rescan for already catalogued photos).
    add_photo_col("pick_flag TEXT NOT NULL DEFAULT 'none'")?;
    // GPS coordinates (NULL = no position): filled when reading files (rescan for already catalogued photos).
    add_photo_col("gps_lat REAL")?;
    add_photo_col("gps_lon REAL")?;
    // Flash (1 fired, 0 did not fire, NULL unknown): filled when reading files (rescan for already catalogued photos).
    add_photo_col("flash INTEGER")?;
    // Author and rights (see exif::Rights): filled when reading files (rescan for already catalogued photos).
    add_photo_col("author TEXT NOT NULL DEFAULT ''")?;
    add_photo_col("copyright TEXT NOT NULL DEFAULT ''")?;
    add_photo_col("credit TEXT NOT NULL DEFAULT ''")?;
    add_photo_col("usage_terms TEXT NOT NULL DEFAULT ''")?;
    add_photo_col("author_email TEXT NOT NULL DEFAULT ''")?;

    conn.execute("CREATE INDEX IF NOT EXISTS idx_date ON photos(date_taken)", []).map_err(|e| format!("Database index could not be created: {e}"))?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rating ON photos(rating)", []).map_err(|e| format!("Database index could not be created: {e}"))?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_flag ON photos(color_flag)", []).map_err(|e| format!("Database index could not be created: {e}"))?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_path ON photos(path)", []).map_err(|e| format!("Database index could not be created: {e}"))?;
    // Expression index matching `NORM_PATH` / `push_folder_condition` so folder prefix queries do an index range scan instead of a full table scan.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_path_norm ON photos(replace(path, char(92), '/'))", []).map_err(|e| format!("Database index could not be created: {e}"))?;

    // Hierarchical keywords (tree and photo <-> keyword link): see keywords.rs.
    crate::keywords::init_schema(&conn).map_err(|e| format!("Keyword tables could not be created: {e}"))?;
    // Author presets (rights.rs).
    crate::rights::init_schema(&conn).map_err(|e| format!("Author preset table could not be created: {e}"))?;
    // Saved batch rename presets: see batch_rename.rs.
    crate::batch_rename::init_schema(&conn).map_err(|e| format!("Rename preset table could not be created: {e}"))?;
    // Virtual albums (folders, manual and smart albums): see albums.rs.
    crate::albums::init_schema(&conn).map_err(|e| format!("Album tables could not be created: {e}"))?;
    // Faces and persons: see faces.rs.
    crate::faces::init_schema(&conn).map_err(|e| format!("Face tables could not be created: {e}"))?;
    // Erased GPS coordinates (backup for "Restore geolocation"): see geolocation.rs.
    crate::geolocation::init_schema(&conn).map_err(|e| format!("Erased locations table could not be created: {e}"))?;
    // Cache of the file hashes used by the duplicate search: see duplicates.rs (empty until a search is started).
    crate::duplicates::init_schema(&conn).map_err(|e| format!("Duplicate hash table could not be created: {e}"))?;
    // Cache of the perceptual hashes used by the similar-image search: see similar.rs (empty until a search is started).
    crate::similar::init_schema(&conn).map_err(|e| format!("Perceptual hash table could not be created: {e}"))?;
    // Embeddings of the semantic search (semantic.rs): empty until the user enables the feature and starts an analysis.
    crate::semantic::init_schema(&conn).map_err(|e| format!("Semantic search tables could not be created: {e}"))?;
    // Map private zones: see private_maps.rs (loaded in memory on open for the per-tile rule).
    crate::private_maps::init_schema(&conn).map_err(|e| format!("Private zone table could not be created: {e}"))?;
    if let Err(error) = crate::private_maps::reload_zones(&conn) { crate::app_log::log_error("Private zones unavailable", error); }
    // Import history & removable media policies: see import.rs.
    crate::import::init_schema(&conn).map_err(|e| format!("Import tables could not be created: {e}"))?;

    Ok(pool)
}

pub fn get_folders(pool: &DbPool) -> Vec<TrackedFolder> {
    let conn = match pool.get() {
        Ok(conn) => conn,
        Err(error) => {
            crate::app_log::log_error("Tracked folders unavailable (no connection)", error);
            return Vec::new();
        }
    };
    let folders = (|| -> rusqlite::Result<Vec<TrackedFolder>> {
        let mut stmt = conn.prepare("SELECT id, path FROM folders ORDER BY path ASC")?;
        let rows = stmt.query_map([], |row| Ok(TrackedFolder { id: row.get(0)?, path: row.get(1)? }))?;
        rows.collect()
    })();
    folders.unwrap_or_else(|error| {
        crate::app_log::log_error("Tracked folders unavailable", error);
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
     file_size, rating, color_flag, keywords, caption, lens_model, modified, title, pick_flag, gps_lat, gps_lon, flash, view_fix, effective_modified, author, created, orientation";

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
        view_fix: row.get::<_, Option<u32>>(24)?.filter(|value| (1..=8).contains(value)).unwrap_or(1),
        effective_modified: row.get::<_, Option<i64>>(25)?.unwrap_or_default(),
        author: text(row, 26)?,
        created: row.get::<_, Option<i64>>(27)?.unwrap_or_default(),
        orientation: row.get::<_, Option<u32>>(28)?.filter(|value| (1..=8).contains(value)).unwrap_or(1),
        copyright: String::new(),
        credit: String::new(),
        usage_terms: String::new(),
        author_email: String::new(),
    })
}

/// Page de photos, de la plus récente à la plus ancienne (à date égale, par identifiant : l'ordre reste stable d'une page à l'autre).
/// Une erreur de lecture est renvoyée, jamais masquée par une liste incomplète. Tests only: the app calls `get_photos_filtered`.
#[cfg(test)]
pub fn get_photos(pool: &DbPool, offset: i32, limit: i32, folder_filter: Option<String>, recursive: bool) -> Result<Vec<Photo>, String> {
    get_photos_sorted(pool, offset, limit, folder_filter, recursive, "taken", false)
}

/// Normalised path expression shared by `idx_path_norm` and `push_folder_condition`: both must stay identical for SQLite to match the index.
const NORM_PATH: &str = "replace(path, char(92), '/')";

fn folder_prefix(folder: Option<&str>) -> String {
    folder.map(|folder| format!("{}/", folder.replace('\\', "/").trim_end_matches('/'))).unwrap_or_default()
}

/// Strict upper bound for prefix range queries on normalised paths ending with `/` (ASCII 0x2F):
/// replacing the trailing `/` with `0` (ASCII 0x30) matches every path starting with `prefix`
/// while excluding sibling folders with a longer name (`C:/Photo2/...`) and `C:/Photo` itself.
fn folder_upper_bound(prefix: &str) -> String {
    let stem = prefix.strip_suffix('/').unwrap_or(prefix);
    format!("{stem}0")
}

/// Builds the SQL folder predicate and appends its bound parameters (0 when unfiltered, 2 when filtered).
/// Avoids `?1 = '' OR (...)` so SQLite can perform an index range scan on `idx_path_norm`.
fn push_folder_condition(prefix: &str, recursive: bool, values: &mut Vec<rusqlite::types::Value>) -> String {
    if prefix.is_empty() {
        return "1".into();
    }
    values.push(prefix.to_string().into());
    let start = values.len();
    values.push(folder_upper_bound(prefix).into());
    let end = values.len();
    if recursive {
        format!("({NORM_PATH} >= ?{start} AND {NORM_PATH} < ?{end})")
    } else {
        format!("({NORM_PATH} >= ?{start} AND {NORM_PATH} < ?{end} AND instr(substr({NORM_PATH}, length(?{start}) + 1), '/') = 0)")
    }
}

/// A dated photo for the date sort: the interface ignores empty dates such as `0000:00:00` (they sort with the undated ones).
const DATED: &str = "date_taken >= '1000'";

/// Sort value of the modification date: the later of `modified` (image file) and `effective_modified` (image or sidecar, 0 on rows read before the
/// column existed). Same rule as `photoModifiedTime` in main.js: change both together.
pub(crate) const EFFECTIVE_MODIFIED: &str = "MAX(COALESCE(modified, 0), COALESCE(effective_modified, 0))";

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
    /// Keywords included with their children (`~` mode): match either `keywords` text or any descendant in `photo_keywords`.
    pub keywords_with_children: Vec<String>,
    /// Years of the date filter (the interface filters the exact instants).
    pub year_from: Option<i32>,
    pub year_to: Option<i32>,
    /// Persons who must all appear on the photo (named faces).
    pub persons: Vec<i64>,
    /// `true`: with GPS coordinates; `false`: without.
    pub geolocated: Option<bool>,
    /// Lowercase texts that must all appear in the file name (the path is searched: superset). ASCII only: SQLite `lower` ignores the rest.
    pub filenames: Vec<String>,
    /// Lowercase authors that must all appear in the `author` text (substring: superset of the interface's whole-name match). ASCII only.
    pub authors: Vec<String>,
    /// Accepted file extensions, lowercase, without the dot (any one of them).
    pub extensions: Vec<String>,
    /// Gear: the camera ("make model") / the lens must contain one of these lowercase texts.
    pub cameras: Vec<String>,
    pub lenses: Vec<String>,
    /// Shooting values, bounds already widened by the interface to the precision it compares with (see `shootingPrefilter`).
    pub focal: Option<ValueRange>,
    pub shutter: Option<ValueRange>,
    pub aperture: Option<ValueRange>,
    pub iso: Option<ValueRange>,
    /// `true`: flash fired; `false`: flash known not fired.
    pub flash: Option<bool>,
    /// Disk folder saved in a smart album (lowercase path ending with "/").
    pub folder: Option<FolderCriterion>,
    /// Map area saved in a smart album (degrees; `west > east` crosses the antimeridian).
    pub map_zone: Option<MapZone>,
    /// Criteria of the parent smart albums, each one a prefilter of its own (all must hold).
    pub and: Vec<PhotoPrefilter>,
    /// "Visible area only" on the map: GPS coordinates, or a position placed on the map and not written yet (`pending_positions`).
    pub positioned: bool,
    pub pending_positions: Vec<i64>,
}

/// Beyond this many pending positions, "positioned" filters nothing (it is only a prefilter): keeps the statement small.
const MAX_PENDING_POSITIONS: usize = 500;

/// Inclusive bounds; a missing bound is open.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct ValueRange {
    pub min: Option<f64>,
    pub max: Option<f64>,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct FolderCriterion {
    pub prefix: String,
    pub recursive: bool,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct MapZone {
    pub south: f64,
    pub north: f64,
    pub west: f64,
    pub east: f64,
}

/// Shooting values read like the interface reads them (shooting-filters.js): a leading number, "f/" dropped from the aperture,
/// a fraction for the shutter speed. Spaces are removed and a decimal comma becomes a point.
const FOCAL_VALUE: &str = "CAST(ltrim(focal_length) AS REAL)";
const APERTURE_VALUE: &str = "CAST(replace(ltrim(replace(replace(replace(lower(aperture), ' ', ''), char(9), ''), 'f/', 'f'), 'f'), ',', '.') AS REAL)";
const SHUTTER_TEXT: &str = "replace(replace(replace(lower(shutter_speed), ' ', ''), char(9), ''), ',', '.')";
const ISO_VALUE: &str = "iso";

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
    for keyword in filter.keywords_with_children.iter().filter(|keyword| !keyword.is_empty()) {
        let text_param = push(Value::Text(keyword.clone()), values);
        let key_param = push(Value::Text(crate::keywords::name_key(keyword)), values);
        parts.push(format!(
            "instr(COALESCE(keywords, ''), {text_param}) > 0 OR id IN (\
                WITH RECURSIVE descendants(id) AS (\
                    SELECT id FROM keyword_nodes WHERE name_key = {key_param} \
                    UNION \
                    SELECT n.id FROM keyword_nodes n JOIN descendants d ON n.parent_id = d.id\
                ) SELECT pk.photo_id FROM photo_keywords pk WHERE pk.keyword_id IN (SELECT id FROM descendants)\
            )"
        ));
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
    for text in filter.filenames.iter().filter(|text| !text.is_empty()) {
        parts.push(format!("instr(lower(COALESCE(NULLIF(filename, ''), path)), {}) > 0", push(Value::Text(text.clone()), values)));
    }
    for author in filter.authors.iter().filter(|author| !author.is_empty()) {
        parts.push(format!("instr(lower(COALESCE(author, '')), {}) > 0", push(Value::Text(author.clone()), values)));
    }
    if !filter.extensions.is_empty() {
        // LIKE ignores ASCII case, as the interface lowercases the extension.
        let tests: Vec<String> = filter.extensions.iter().map(|extension| format!("path LIKE {}", push(Value::Text(format!("%.{extension}")), values))).collect();
        parts.push(tests.join(" OR "));
    }
    // Camera label of the interface: make and model, the make dropped when the model repeats it; it is always part of "make model".
    const CAMERA_TEXT: &str = "lower(trim(COALESCE(manufacturer, ''), char(9, 10, 11, 12, 13, 32, 160)) || ' ' || trim(COALESCE(camera_model, ''), char(9, 10, 11, 12, 13, 32, 160)))";
    for (text_sql, accepted) in [(CAMERA_TEXT, &filter.cameras), ("lower(COALESCE(lens_model, ''))", &filter.lenses)] {
        if accepted.is_empty() {
            continue;
        }
        let tests: Vec<String> = accepted.iter().map(|text| format!("instr({text_sql}, {}) > 0", push(Value::Text(text.clone()), values))).collect();
        parts.push(tests.join(" OR "));
    }
    let shutter_value = format!(
        "(CASE WHEN instr({SHUTTER_TEXT}, '/') > 0 THEN CAST(substr({SHUTTER_TEXT}, 1, instr({SHUTTER_TEXT}, '/') - 1) AS REAL) \
         / NULLIF(CAST(substr({SHUTTER_TEXT}, instr({SHUTTER_TEXT}, '/') + 1) AS REAL), 0) ELSE CAST({SHUTTER_TEXT} AS REAL) END)"
    );
    for (value_sql, range) in [(FOCAL_VALUE, &filter.focal), (APERTURE_VALUE, &filter.aperture), (shutter_value.as_str(), &filter.shutter), (ISO_VALUE, &filter.iso)] {
        let Some(range) = range else { continue };
        // A missing value (0 or unreadable) never matches, as in the interface.
        let mut tests = vec![format!("{value_sql} > 0")];
        if let Some(min) = range.min.filter(|min| min.is_finite()) {
            tests.push(format!("{value_sql} >= {}", push(Value::Real(min), values)));
        }
        if let Some(max) = range.max.filter(|max| max.is_finite()) {
            tests.push(format!("{value_sql} <= {}", push(Value::Real(max), values)));
        }
        parts.push(tests.join(" AND "));
    }
    match filter.flash {
        Some(true) => parts.push("flash = 1".into()),
        Some(false) => parts.push("flash = 0".into()),
        None => {}
    }
    if let Some(folder) = &filter.folder {
        // Same test as FOLDER_CONDITION, on the lowercase path (the interface compares folders without case).
        let prefix = push(Value::Text(folder.prefix.clone()), values);
        let path = "lower(replace(path, char(92), '/'))";
        let mut test = format!("substr({path}, 1, length({prefix})) = {prefix}");
        if !folder.recursive {
            test.push_str(&format!(" AND instr(substr({path}, length({prefix}) + 1), '/') = 0"));
        }
        parts.push(test);
    }
    if let Some(zone) = &filter.map_zone {
        let [south, north, west, east] = [zone.south, zone.north, zone.west, zone.east].map(|bound| push(Value::Real(bound), values));
        let longitude = if zone.west <= zone.east {
            format!("gps_lon BETWEEN {west} AND {east}")
        } else {
            format!("(gps_lon >= {west} OR gps_lon <= {east})")
        };
        parts.push(format!("gps_lat IS NOT NULL AND gps_lon IS NOT NULL AND gps_lat BETWEEN {south} AND {north} AND {longitude}"));
    }
    if filter.positioned && filter.pending_positions.len() <= MAX_PENDING_POSITIONS {
        let mut test = "gps_lat IS NOT NULL AND gps_lon IS NOT NULL".to_string();
        if !filter.pending_positions.is_empty() {
            let marks: Vec<String> = filter.pending_positions.iter().map(|id| push(Value::Integer(*id), values)).collect();
            test = format!("({test}) OR id IN ({})", marks.join(", "));
        }
        parts.push(test);
    }
    for inherited in &filter.and {
        let condition = prefilter_condition(inherited, first, values);
        if condition != "1" {
            parts.push(condition);
        }
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

struct FolderQueryParts {
    prefix: String,
    folder_sql: String,
    prefix_values: Vec<rusqlite::types::Value>,
    filter_sql: String,
    filter_values: Vec<rusqlite::types::Value>,
}

fn build_folder_query_parts(folder_filter: Option<&str>, recursive: bool, filter: &PhotoPrefilter) -> FolderQueryParts {
    let prefix = folder_prefix(folder_filter);
    let mut prefix_values = Vec::new();
    let folder_sql = push_folder_condition(&prefix, recursive, &mut prefix_values);
    let mut filter_values = Vec::new();
    let prefilter_sql = prefilter_condition(filter, prefix_values.len(), &mut filter_values);
    // Photos hidden by the active privacy set never leave the catalogue (privacy.rs); `1` when no set is active.
    let filter_sql = format!("({prefilter_sql}) AND ({})", crate::privacy::visible_condition(""));
    FolderQueryParts { prefix, folder_sql, prefix_values, filter_sql, filter_values }
}

fn list_query_sql(parts: &FolderQueryParts, condition: &str, order: &str) -> (String, usize, usize) {
    let limit_param = parts.prefix_values.len() + parts.filter_values.len() + 1;
    let offset_param = limit_param + 1;
    let sql = format!(
        "SELECT {PHOTO_COLUMNS} FROM photos WHERE {} AND ({condition}) AND ({}) ORDER BY {order} LIMIT ?{limit_param} OFFSET ?{offset_param}",
        parts.folder_sql, parts.filter_sql
    );
    (sql, limit_param, offset_param)
}

fn count_query_sql(parts: &FolderQueryParts, condition: &str) -> String {
    format!(
        "SELECT COUNT(*) FROM photos WHERE {} AND ({condition}) AND ({})",
        parts.folder_sql, parts.filter_sql
    )
}

/// `get_photos_sorted` restricted by a prefilter (see `PhotoPrefilter`).
#[allow(clippy::too_many_arguments)]
pub fn get_photos_filtered(pool: &DbPool, offset: i32, limit: i32, folder_filter: Option<String>, recursive: bool, sort_key: &str, ascending: bool, filter: &PhotoPrefilter) -> Result<Vec<Photo>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let parts = build_folder_query_parts(folder_filter.as_deref(), recursive, filter);
    let direction = if ascending { "ASC" } else { "DESC" };
    let page = |condition: &str, order: &str, limit: i32, offset: i32| -> Result<Vec<Photo>, String> {
        let (sql, _, _) = list_query_sql(&parts, condition, order);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut values = parts.prefix_values.clone();
        values.extend(parts.filter_values.iter().cloned());
        values.push(limit.into());
        values.push(offset.into());
        let rows = stmt.query_map(rusqlite::params_from_iter(values), photo_from_row).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<Photo>>>().map_err(|e| e.to_string())
    };
    match sort_key {
        "modified" => page("1", &format!("{EFFECTIVE_MODIFIED} <= 0, {EFFECTIVE_MODIFIED} {direction}, id {direction}"), limit, offset),
        "name" => page("1", &format!("filename COLLATE NOCASE {direction}, path {direction}, id {direction}"), limit, offset),
        _ => {
            if !parts.prefix.is_empty() {
                // Folder view: keep SQLite on `idx_path_norm` and fetch dated + undated photos in a single query instead of scanning `idx_date`.
                return page(
                    "1",
                    &format!("CASE WHEN {DATED} THEN 0 ELSE 1 END, CASE WHEN {DATED} THEN date_taken END {direction}, id {direction}"),
                    limit,
                    offset,
                );
            }
            // Whole catalogue: dated photos first, read through the `date_taken` index, then the undated ones. A single ORDER BY starting with an
            // "is dated" expression gives the same order but loses the index: ~15 times slower on a 250,000-photo catalogue.
            let mut photos = page(DATED, &format!("date_taken {direction}, id {direction}"), limit, offset)?;
            let missing = limit - photos.len() as i32;
            if missing > 0 {
                // The page ends past the dated photos: the undated ones fill it. Offset among them = what the offset skips beyond the dated ones.
                let skip = if photos.is_empty() && offset > 0 {
                    let dated = count_matching(&conn, &parts, DATED)?;
                    (i64::from(offset) - dated).max(0) as i32
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
fn count_matching(conn: &rusqlite::Connection, parts: &FolderQueryParts, condition: &str) -> Result<i64, String> {
    let mut values = parts.prefix_values.clone();
    values.extend(parts.filter_values.iter().cloned());
    conn.query_row(
        &count_query_sql(parts, condition),
        rusqlite::params_from_iter(values),
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Number of photos the same query would return without a limit: the interface tells the user when its list is capped.
pub fn count_photos(pool: &DbPool, folder_filter: Option<String>, recursive: bool, filter: &PhotoPrefilter) -> Result<i64, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let parts = build_folder_query_parts(folder_filter.as_deref(), recursive, filter);
    count_matching(&conn, &parts, "1")
}

#[cfg(test)]
pub(crate) fn explain_folder_query(
    pool: &DbPool,
    folder_filter: Option<String>,
    recursive: bool,
    sort_key: &str,
    ascending: bool,
    filter: &PhotoPrefilter,
    count_only: bool,
) -> Result<Vec<String>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let parts = build_folder_query_parts(folder_filter.as_deref(), recursive, filter);
    let direction = if ascending { "ASC" } else { "DESC" };
    let (sql, mut values) = if count_only {
        let mut values = parts.prefix_values.clone();
        values.extend(parts.filter_values.iter().cloned());
        (count_query_sql(&parts, "1"), values)
    } else {
        let (condition, order) = match sort_key {
            "modified" => ("1", format!("{EFFECTIVE_MODIFIED} <= 0, {EFFECTIVE_MODIFIED} {direction}, id {direction}")),
            "name" => ("1", format!("filename COLLATE NOCASE {direction}, path {direction}, id {direction}")),
            _ if !parts.prefix.is_empty() => (
                "1",
                format!("CASE WHEN {DATED} THEN 0 ELSE 1 END, CASE WHEN {DATED} THEN date_taken END {direction}, id {direction}"),
            ),
            _ => (DATED, format!("date_taken {direction}, id {direction}")),
        };
        let (sql, _, _) = list_query_sql(&parts, condition, &order);
        let mut values = parts.prefix_values.clone();
        values.extend(parts.filter_values.iter().cloned());
        values.push(50000i32.into());
        values.push(0i32.into());
        (sql, values)
    };
    let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(values.drain(..)), |row| row.get::<_, String>(3))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<String>>>().map_err(|e| e.to_string())
}

/// Photos of the given paths (duplicate search results), in chunks to stay under the SQLite variable limit. Unknown paths are skipped.
pub fn get_photos_by_paths(pool: &DbPool, paths: &[String]) -> Result<Vec<Photo>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut photos = Vec::with_capacity(paths.len());
    for chunk in paths.chunks(500) {
        let marks = vec!["?"; chunk.len()].join(",");
        let mut stmt = conn.prepare(&format!("SELECT {PHOTO_COLUMNS} FROM photos WHERE path IN ({marks}) AND ({})", crate::privacy::visible_condition(""))).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params_from_iter(chunk.iter()), photo_from_row).map_err(|e| e.to_string())?;
        for row in rows {
            photos.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(photos)
}

/// Catalog records of a list of photo ids (results of the content search); unknown ids are left out. Order is unspecified.
pub fn get_photos_by_ids(pool: &DbPool, ids: &[i64]) -> Result<Vec<Photo>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut photos = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(500) {
        let marks = vec!["?"; chunk.len()].join(",");
        let mut stmt = conn.prepare(&format!("SELECT {PHOTO_COLUMNS} FROM photos WHERE id IN ({marks}) AND ({})", crate::privacy::visible_condition(""))).map_err(|e| e.to_string())?;
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
        .prepare(&format!(
            // Photos hidden by the active privacy set are not counted: a folder with no visible photo leaves the tree (privacy.rs).
            "SELECT rtrim(p, replace(p, '/', '')) AS dir, COUNT(*)
             FROM (SELECT replace(path, char(92), '/') AS p FROM photos WHERE {}) GROUP BY dir",
            crate::privacy::visible_condition("")
        ))
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
