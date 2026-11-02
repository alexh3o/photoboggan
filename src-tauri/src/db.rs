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

    conn.execute("CREATE INDEX IF NOT EXISTS idx_date ON photos(date_taken)", []).unwrap();
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rating ON photos(rating)", []).unwrap();
    conn.execute("CREATE INDEX IF NOT EXISTS idx_flag ON photos(color_flag)", []).unwrap();
    conn.execute("CREATE INDEX IF NOT EXISTS idx_path ON photos(path)", []).unwrap();

    // Mots-clés hiérarchiques (arborescence et association photo ↔ mot-clé) : voir keywords.rs.
    crate::keywords::init_schema(&conn).expect("Keyword tables could not be created");
    // Visages et personnes : voir faces.rs.
    crate::faces::init_schema(&conn).expect("Face tables could not be created");
    // Coordonnées GPS effacées (sauvegarde pour « Restaurer la géolocalisation ») : voir geolocation.rs.
    crate::geolocation::init_schema(&conn).expect("Erased locations table could not be created");
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
const PHOTO_COLUMNS: &str = "id, path, filename, date_taken, aperture, shutter_speed, iso, focal_length, manufacturer, camera_model, width, height, \
     file_size, rating, color_flag, keywords, caption, lens_model, modified, title, pick_flag, gps_lat, gps_lon";

/// Photo d'une ligne du catalogue. Les colonnes qui acceptent NULL (catalogues anciens) prennent une valeur par défaut : une photo n'est
/// jamais écartée de la liste parce qu'une de ses colonnes est vide.
fn photo_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Photo> {
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
    })
}

/// Page de photos, de la plus récente à la plus ancienne (à date égale, par identifiant : l'ordre reste stable d'une page à l'autre).
/// Une erreur de lecture est renvoyée, jamais masquée par une liste incomplète.
pub fn get_photos(pool: &DbPool, offset: i32, limit: i32, folder_filter: Option<String>, recursive: bool) -> Result<Vec<Photo>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let photos = match folder_filter {
        Some(folder) => {
            let normalized_folder = folder.replace('\\', "/").trim_end_matches('/').to_string();
            let prefix = format!("{normalized_folder}/");
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {PHOTO_COLUMNS} FROM photos WHERE substr(replace(path, char(92), '/'), 1, length(?1)) = ?1
                     AND (?2 OR instr(substr(replace(path, char(92), '/'), length(?1) + 1), '/') = 0)
                     ORDER BY date_taken DESC, id DESC LIMIT ?3 OFFSET ?4"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![prefix, recursive, limit, offset], photo_from_row).map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<Vec<Photo>>>()
        }
        None => {
            let mut stmt = conn
                .prepare(&format!("SELECT {PHOTO_COLUMNS} FROM photos ORDER BY date_taken DESC, id DESC LIMIT ? OFFSET ?"))
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![limit, offset], photo_from_row).map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<Vec<Photo>>>()
        }
    };
    photos.map_err(|e| e.to_string())
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
