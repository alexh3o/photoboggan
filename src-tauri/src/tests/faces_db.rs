//! Tests de l'enregistrement des visages en base (faces.rs) : une erreur de base est remontée, jamais avalée.
//! (Reading regions from XMP packets is tested in tests/faces.rs.)

use super::*;
use crate::test_support::*;

fn faces_of(regions: Option<Vec<FaceRegion>>) -> PhotoFaces {
    PhotoFaces { orientation: 6, view_fix: 1, regions }
}

fn region(name: Option<&str>, x: f64) -> FaceRegion {
    FaceRegion { name: name.map(str::to_string), x, y: 0.1, w: 0.2, h: 0.2 }
}

#[test]
fn database_failure_is_reported() {
    let conn = Connection::open_in_memory().unwrap();
    assert!(!store_photo_faces(&conn, &[("C:/P/a.jpg".into(), faces_of(Some(vec![])))]));
    assert!(store_photo_faces(&conn, &[]));
}

#[test]
fn rereading_a_file_updates_faces_without_duplicating_them() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    let count = |conn: &Connection| -> i64 { conn.query_row("SELECT COUNT(*) FROM faces WHERE photo_id = ?1", params![photo], |row| row.get(0)).unwrap() };

    let first = vec![region(Some("Alice"), 0.1), region(None, 0.6)];
    assert!(store_photo_faces(&conn, &[("C:/P/a.jpg".into(), faces_of(Some(first.clone())))]));
    assert_eq!(count(&conn), 2);
    let orientation: i64 = conn.query_row("SELECT orientation FROM photos WHERE id = ?1", params![photo], |row| row.get(0)).unwrap();
    assert_eq!(orientation, 6);

    // Même contenu relu : pas de doublon.
    assert!(store_photo_faces(&conn, &[("C:/P/a.jpg".into(), faces_of(Some(first)))]));
    assert_eq!(count(&conn), 2);

    // Lecture des visages désactivée (None) : les visages connus ne sont pas effacés.
    assert!(store_photo_faces(&conn, &[("C:/P/a.jpg".into(), faces_of(None))]));
    assert_eq!(count(&conn), 2);
}

#[test]
fn filtered_faces_can_be_set_to_unknown() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    conn.execute(
        "INSERT INTO faces (photo_id, x, y, w, h, origin, state) VALUES (?1, 0.1, 0.1, 0.2, 0.2, 'detected', 'filtered')",
        params![photo],
    )
    .unwrap();
    let face = conn.last_insert_rowid();

    // A filtered face (below the detection thresholds) is promoted to "unknown" from the Faces view.
    assert_eq!(set_faces_unknown_in(&conn, &[face]).unwrap(), 1);
    let (state, locked, dirty): (String, i64, i64) = conn
        .query_row("SELECT state, unknown_locked, dirty FROM faces WHERE id = ?1", params![face], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert_eq!(state, "unknown");
    assert_eq!(locked, 1); // recognition no longer proposes it
    assert_eq!(dirty, 0); // never a confirmed face: nothing to write back to the file
}

#[test]
fn auto_faces_are_not_written_until_confirmed() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    conn.execute("INSERT INTO persons (name, name_key) VALUES ('Alice', 'alice')", []).unwrap();
    let person = conn.last_insert_rowid();
    for (x, state) in [(0.1, "auto"), (0.6, "confirmed")] {
        conn.execute(
            "INSERT INTO faces (photo_id, x, y, w, h, origin, state, person_id) VALUES (?1, ?2, 0.1, 0.2, 0.2, 'detected', ?3, ?4)",
            params![photo, x, state, person],
        )
        .unwrap();
    }
    // Only the confirmed face becomes a region in the file.
    let plan = plan_face_write(&conn, photo, None).unwrap();
    assert_eq!(plan.regions.regions.len(), 1);
    assert!((plan.regions.regions[0].x - 0.6).abs() < 1e-9);
    // Confirming the automatic face makes it part of the next write.
    conn.execute("UPDATE faces SET state = 'confirmed' WHERE state = 'auto'", []).unwrap();
    assert_eq!(plan_face_write(&conn, photo, None).unwrap().regions.regions.len(), 2);
}
