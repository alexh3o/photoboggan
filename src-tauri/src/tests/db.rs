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
fn folder_list_covers_folders_beyond_the_photo_page() {
    // The interface loads a capped page of the most recent photos but builds its folder tree from `get_folder_counts`:
    // a folder whose photos are all older than the page must still be listed, with its full count.
    let (_dir, pool) = temp_catalog();
    {
        let conn = pool.get().unwrap();
        for (path, date) in [("C:/Photos/2024/a.jpg", "2024:01:01 10:00:00"), ("C:/Photos/2024/b.jpg", "2024:01:02 10:00:00"),
                             ("C:/Photos/2014/old1.jpg", "2014:01:01 10:00:00"), ("C:/Photos/2014/old2.jpg", "2014:01:02 10:00:00")] {
            let id = insert_photo(&conn, path);
            conn.execute("UPDATE photos SET date_taken = ?1 WHERE id = ?2", rusqlite::params![date, id]).unwrap();
        }
    }
    let page = get_photos(&pool, 0, 2, None, true).unwrap();
    assert!(page.iter().all(|photo| photo.path.contains("/2024/")), "the page holds only the most recent photos");
    let counts = get_folder_counts(&pool).unwrap();
    assert_eq!((counts.get("C:/Photos/2024").copied(), counts.get("C:/Photos/2014").copied()), (Some(2), Some(2)));
}

/// Catalogue for the sort tests: three dated photos, one without date, one with an empty date, one in another folder.
fn sort_catalog() -> (tempfile::TempDir, DbPool) {
    let (dir, pool) = temp_catalog();
    {
        let conn = pool.get().unwrap();
        for (path, date, modified) in [("C:/P/b2010.jpg", Some("2010:05:01 10:00:00"), 3), ("C:/P/a2000.jpg", Some("2000:01:01 10:00:00"), 1),
                                       ("C:/P/c2020.jpg", Some("2020:01:01 10:00:00"), 2), ("C:/P/nodate.jpg", None, 0),
                                       ("C:/P/zero.jpg", Some("0000:00:00 00:00:00"), 5), ("C:/Q/q2015.jpg", Some("2015:01:01 10:00:00"), 4)] {
            let id = insert_photo(&conn, path);
            conn.execute("UPDATE photos SET date_taken = ?1, modified = ?2 WHERE id = ?3", rusqlite::params![date, modified, id]).unwrap();
        }
    }
    (dir, pool)
}

fn ordered(photos: Vec<Photo>) -> Vec<String> {
    photos.into_iter().map(|photo| photo.filename).collect()
}

#[test]
fn capped_list_follows_the_interface_sort_with_undated_photos_last() {
    let (_dir, pool) = sort_catalog();
    let folder = || Some("C:/P".to_string());
    // Ascending by date: a capped list starts with the OLDEST photos (the bug: it used to hold the newest ones, merely reversed).
    assert_eq!(ordered(get_photos_sorted(&pool, 0, 2, folder(), true, "taken", true).unwrap()), ["a2000.jpg", "b2010.jpg"]);
    // Undated and empty dates (0000:00:00) come last in both directions.
    let ascending = ordered(get_photos_sorted(&pool, 0, 10, folder(), true, "taken", true).unwrap());
    assert_eq!(ascending[..3], ["a2000.jpg", "b2010.jpg", "c2020.jpg"]);
    let descending = ordered(get_photos_sorted(&pool, 0, 10, folder(), true, "taken", false).unwrap());
    assert_eq!(descending[..3], ["c2020.jpg", "b2010.jpg", "a2000.jpg"]);
    for list in [&ascending, &descending] {
        let mut tail = list[3..].to_vec();
        tail.sort();
        assert_eq!(tail, ["nodate.jpg", "zero.jpg"]);
    }
    // Pages across the dated / undated boundary: disjoint and complete.
    let pages: Vec<String> = (0..3).flat_map(|page| ordered(get_photos_sorted(&pool, page * 2, 2, folder(), true, "taken", true).unwrap())).collect();
    assert_eq!(pages, ascending);
    assert!(get_photos_sorted(&pool, 10, 2, folder(), true, "taken", true).unwrap().is_empty());
    // Modification date (missing = 0, last) and name.
    assert_eq!(ordered(get_photos_sorted(&pool, 0, 10, folder(), true, "modified", true).unwrap()), ["a2000.jpg", "c2020.jpg", "b2010.jpg", "zero.jpg", "nodate.jpg"]);
    assert_eq!(ordered(get_photos_sorted(&pool, 0, 2, folder(), true, "name", false).unwrap()), ["zero.jpg", "nodate.jpg"]);
    // Without a folder, the whole catalogue; the default query keeps newest first.
    assert_eq!(ordered(get_photos(&pool, 0, 2, None, true).unwrap()), ["c2020.jpg", "q2015.jpg"]);
}

#[test]
fn photo_count_matches_the_uncapped_list() {
    let (_dir, pool) = sort_catalog();
    assert_eq!(count_photos(&pool, None, true).unwrap(), 6);
    assert_eq!(count_photos(&pool, Some("C:\\P\\".into()), false).unwrap(), 5);
    assert_eq!(count_photos(&pool, Some("C:/P".into()), true).unwrap(), 5);
    assert_eq!(count_photos(&pool, Some("C:/".into()), false).unwrap(), 0);
    assert_eq!(count_photos(&pool, Some("C:/".into()), true).unwrap(), 6);
}

#[test]
fn photos_are_read_back_by_id_in_chunks() {
    let (_dir, pool) = temp_catalog();
    let ids: Vec<i64> = {
        let conn = pool.get().unwrap();
        (0..1200).map(|n| insert_photo(&conn, &format!("C:/Photos/{n}.jpg"))).collect()
    };
    let wanted: Vec<i64> = ids.iter().copied().step_by(2).chain([999_999]).collect();
    let found = get_photos_by_ids(&pool, &wanted).unwrap();
    assert_eq!(found.len(), 600, "every known id across chunks, unknown ids skipped");
    assert!(get_photos_by_ids(&pool, &[]).unwrap().is_empty());
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
