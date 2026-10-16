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
    pub keywords: String,
    pub caption: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TrackedFolder {
    pub id: i64,
    pub path: String,
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

    let pool = Pool::new(manager).expect("Erreur pool DB");
    let conn = pool.get().unwrap();

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

    // Upgrade existing libraries without discarding the catalog.
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN keywords TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN caption TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE photos ADD COLUMN lens_model TEXT NOT NULL DEFAULT ''", []);

    conn.execute("CREATE INDEX IF NOT EXISTS idx_date ON photos(date_taken)", []).unwrap();
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rating ON photos(rating)", []).unwrap();
    conn.execute("CREATE INDEX IF NOT EXISTS idx_flag ON photos(color_flag)", []).unwrap();
    conn.execute("CREATE INDEX IF NOT EXISTS idx_path ON photos(path)", []).unwrap();

    pool
}

pub fn get_folders(pool: &DbPool) -> Vec<TrackedFolder> {
    let conn = pool.get().unwrap();
    let mut stmt = conn.prepare("SELECT id, path FROM folders ORDER BY path ASC").unwrap();
    let rows = stmt.query_map([], |row| {
        Ok(TrackedFolder {
            id: row.get(0)?,
            path: row.get(1)?,
        })
    }).unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

pub fn add_folder(pool: &DbPool, path: &str) -> Result<i64, String> {
    let conn = pool.get().unwrap();
    conn.execute("INSERT OR IGNORE INTO folders (path) VALUES (?)", params![path])
        .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn remove_folder(pool: &DbPool, id: i64, folder_path: &str) -> Result<(), String> {
    let conn = pool.get().unwrap();
    conn.execute("DELETE FROM folders WHERE id = ?", params![id]).map_err(|e| e.to_string())?;
    let prefix = format!("{}%", folder_path);
    conn.execute("DELETE FROM photos WHERE path LIKE ?", params![prefix]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_photos(pool: &DbPool, offset: i32, limit: i32, folder_filter: Option<String>, recursive: bool) -> Vec<Photo> {
    let conn = pool.get().unwrap();

    let sql = if folder_filter.is_some() {
        "SELECT id, path, filename, date_taken, aperture, shutter_speed, iso, 
         focal_length, manufacturer, camera_model, width, height, file_size, rating, color_flag, keywords, caption, lens_model 
         FROM photos WHERE substr(replace(path, char(92), '/'), 1, length(?1)) = ?1
         AND (?2 OR instr(substr(replace(path, char(92), '/'), length(?1) + 1), '/') = 0)
         ORDER BY date_taken DESC LIMIT ?3 OFFSET ?4"
    } else {
        "SELECT id, path, filename, date_taken, aperture, shutter_speed, iso, 
         focal_length, manufacturer, camera_model, width, height, file_size, rating, color_flag, keywords, caption, lens_model 
         FROM photos ORDER BY date_taken DESC LIMIT ? OFFSET ?"
    };

    let mut stmt = conn.prepare(sql).unwrap();

    if let Some(folder) = folder_filter {
        let normalized_folder = folder.replace('\\', "/").trim_end_matches('/').to_string();
        let prefix = format!("{normalized_folder}/");
        let photo_iter = stmt.query_map(params![prefix, recursive, limit, offset], |row| {
            Ok(Photo {
                id: row.get(0)?,
                path: row.get(1)?,
                filename: row.get(2)?,
                date_taken: row.get(3)?,
                aperture: row.get(4)?,
                shutter_speed: row.get(5)?,
                iso: row.get(6)?,
                focal_length: row.get(7)?,
                manufacturer: row.get(8)?,
                camera_model: row.get(9)?,
                lens_model: row.get(17)?,
                width: row.get(10)?,
                height: row.get(11)?,
                file_size: row.get(12)?,
                rating: row.get(13)?,
                color_flag: row.get(14)?,
                keywords: row.get(15)?,
                caption: row.get(16)?,
            })
        }).unwrap();
        photo_iter.filter_map(|p| p.ok()).collect()
    } else {
        let photo_iter = stmt.query_map(params![limit, offset], |row| {
            Ok(Photo {
                id: row.get(0)?,
                path: row.get(1)?,
                filename: row.get(2)?,
                date_taken: row.get(3)?,
                aperture: row.get(4)?,
                shutter_speed: row.get(5)?,
                iso: row.get(6)?,
                focal_length: row.get(7)?,
                manufacturer: row.get(8)?,
                camera_model: row.get(9)?,
                lens_model: row.get(17)?,
                width: row.get(10)?,
                height: row.get(11)?,
                file_size: row.get(12)?,
                rating: row.get(13)?,
                color_flag: row.get(14)?,
                keywords: row.get(15)?,
                caption: row.get(16)?,
            })
        }).unwrap();
        photo_iter.filter_map(|p| p.ok()).collect()
    }
}
