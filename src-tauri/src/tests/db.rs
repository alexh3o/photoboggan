//! Tests du catalogue SQLite (db.rs) : mode WAL, mise à niveau idempotente, dossiers suivis, pagination.

use super::*;
use crate::test_support::*;

fn count(conn: &rusqlite::Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn names(photos: Vec<Photo>) -> Vec<String> {
    let mut names: Vec<String> = photos.into_iter().map(|photo| photo.filename).collect();
    names.sort();
    names
}

#[test]
fn catalog_uses_wal_and_reopens_without_losing_data() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("catalog.db").to_string_lossy().to_string();
    {
        let pool = init_db(&file);
        let conn = pool.get().unwrap();
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        insert_photo(&conn, "C:/Photos/a.jpg");
    }
    // Deuxième ouverture : les migrations (ALTER TABLE ... ADD COLUMN) rejouées ne font ni paniquer ni perdre de données.
    let pool = init_db(&file);
    let conn = pool.get().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM photos"), 1);
}

#[test]
fn old_catalog_without_recent_columns_is_upgraded() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("old.db");
    {
        let conn = rusqlite::Connection::open(&file).unwrap();
        conn.execute_batch(
            "CREATE TABLE folders (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL);
             CREATE TABLE photos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE, filename TEXT, date_taken TEXT, aperture TEXT, shutter_speed TEXT,
                iso INTEGER, focal_length TEXT, manufacturer TEXT, camera_model TEXT, width INTEGER, height INTEGER, file_size INTEGER,
                rating INTEGER DEFAULT 0, color_flag TEXT DEFAULT 'none');
             INSERT INTO photos (path, filename, rating) VALUES ('C:/Photos/old.jpg', 'old.jpg', 4);",
        )
        .unwrap();
    }
    let pool = init_db(&file.to_string_lossy());
    let photos = get_photos(&pool, 0, 10, None, true).unwrap();
    assert_eq!(photos.len(), 1);
    assert_eq!((photos[0].rating, photos[0].pick_flag.as_str(), photos[0].keywords.as_str()), (4, "none", ""));
}

#[test]
fn rows_with_null_columns_are_never_dropped_from_the_list() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    for name in ["a", "b", "c"] { insert_photo(&conn, &format!("C:/Photos/{name}.jpg")); }
    assert_eq!(get_photos(&pool, 0, 10, None, true).unwrap().len(), 3);
    // Pagination : pages disjointes qui couvrent tout, dans un ordre stable.
    let first = get_photos(&pool, 0, 2, None, true).unwrap();
    let second = get_photos(&pool, 2, 2, None, true).unwrap();
    assert_eq!((first.len(), second.len()), (2, 1));
    assert!(first.iter().all(|a| second.iter().all(|b| a.id != b.id)));
}

#[test]
fn folder_filter_respects_recursion_and_neighbour_names() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    for path in ["C:/Photo/a.jpg", "C:/Photo/sub/b.jpg", "C:/Photo2/c.jpg"] { insert_photo(&conn, path); }
    assert_eq!(names(get_photos(&pool, 0, 10, Some("C:/Photo".into()), false).unwrap()), ["a.jpg"]);
    assert_eq!(names(get_photos(&pool, 0, 10, Some("C:\\Photo\\".into()), true).unwrap()), ["a.jpg", "b.jpg"]);
}

#[test]
fn folder_counts_are_direct_per_folder_and_normalised() {
    let (_dir, pool) = temp_catalog();
    {
        let conn = pool.get().unwrap();
        // Photos et vidéos comptées ensemble ; séparateurs Windows et POSIX regroupés ; « Photo2 » n'est pas un voisin à confondre avec « Photo ».
        for path in ["C:/Photo/a.jpg", "C:\\Photo\\b.mp4", "C:/Photo/sub/c.jpg", "C:/Photo/sub/deep/d.jpg", "C:/Photo2/e.jpg"] { insert_photo(&conn, path); }
    }
    let counts = get_folder_counts(&pool).unwrap();
    let get = |dir: &str| counts.get(dir).copied();
    assert_eq!((get("C:/Photo"), get("C:/Photo/sub"), get("C:/Photo/sub/deep"), get("C:/Photo2")), (Some(2), Some(1), Some(1), Some(1)));
    assert_eq!(counts.len(), 4);
}

#[test]
fn removing_a_folder_keeps_photos_still_covered_and_neighbours() {
    let (_dir, pool) = temp_catalog();
    let outer = add_folder(&pool, "C:/Photo").unwrap();
    add_folder(&pool, "C:/Photo/sub").unwrap();
    add_folder(&pool, "C:/Photo2").unwrap();
    {
        let conn = pool.get().unwrap();
        for path in ["C:/Photo/a.jpg", "C:/Photo/sub/b.jpg", "C:/Photo2/c.jpg"] { insert_photo(&conn, path); }
    }
    remove_folder(&pool, outer, "C:/Photo").unwrap();
    // a.jpg n'est plus dans aucun dossier suivi ; b.jpg l'est encore (dossier imbriqué suivi) ; Photo2 n'est pas un sous-dossier de Photo.
    assert_eq!(names(get_photos(&pool, 0, 10, None, true).unwrap()), ["b.jpg", "c.jpg"]);
    assert_eq!(get_folders(&pool).len(), 2);
}

#[test]
fn adding_the_same_folder_twice_keeps_one_row() {
    let (_dir, pool) = temp_catalog();
    add_folder(&pool, "C:/Photo").unwrap();
    add_folder(&pool, "C:/Photo").unwrap();
    assert_eq!(get_folders(&pool).len(), 1);
}

#[test]
fn photos_are_read_back_by_path_in_chunks() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let paths: Vec<String> = (0..1200).map(|n| format!("C:/Photos/p{n}.jpg")).collect();
    for path in &paths {
        insert_photo(&conn, path);
    }
    // More paths than one query can hold, plus an unknown one that is simply left out.
    let mut wanted = paths.clone();
    wanted.push("C:/Photos/missing.jpg".to_string());
    let found = get_photos_by_paths(&pool, &wanted).unwrap();
    assert_eq!(found.len(), 1200);
    assert!(get_photos_by_paths(&pool, &[]).unwrap().is_empty());
}
