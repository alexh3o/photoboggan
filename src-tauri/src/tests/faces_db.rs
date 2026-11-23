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

#[test]
fn undo_manual_face_unwritten_leaves_no_pending_write() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    conn.execute("INSERT INTO persons (name, name_key) VALUES ('Alice', 'alice')", []).unwrap();
    let person = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO faces (photo_id, x, y, w, h, origin, state, person_id, dirty) VALUES (?1, 0.1, 0.1, 0.2, 0.2, 'manual', 'confirmed', ?2, 1)",
        params![photo, person],
    )
    .unwrap();
    let face = conn.last_insert_rowid();
    conn.execute("UPDATE persons SET cover_face_id = ?1 WHERE id = ?2", params![face, person]).unwrap();

    assert!(undo_manual_face_in(&conn, face).unwrap());
    let face_count: i64 = conn.query_row("SELECT COUNT(*) FROM faces WHERE id = ?1", params![face], |row| row.get(0)).unwrap();
    let pending_writes: i64 = conn.query_row("SELECT COUNT(*) FROM photo_face_writes WHERE photo_id = ?1", params![photo], |row| row.get(0)).unwrap();
    let cover: Option<i64> = conn.query_row("SELECT cover_face_id FROM persons WHERE id = ?1", params![person], |row| row.get(0)).unwrap();
    assert_eq!(face_count, 0);
    assert_eq!(pending_writes, 0);
    assert_eq!(cover, None);
    assert!(!undo_manual_face_in(&conn, face).unwrap());
}

#[test]
fn undo_manual_face_already_written_queues_removal() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    conn.execute("INSERT INTO persons (name, name_key) VALUES ('Alice', 'alice')", []).unwrap();
    let person = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO faces (photo_id, x, y, w, h, origin, state, person_id, dirty) VALUES (?1, 0.1, 0.1, 0.2, 0.2, 'manual', 'confirmed', ?2, 0)",
        params![photo, person],
    )
    .unwrap();
    let face = conn.last_insert_rowid();

    assert!(undo_manual_face_in(&conn, face).unwrap());
    let pending_writes: i64 = conn.query_row("SELECT COUNT(*) FROM photo_face_writes WHERE photo_id = ?1", params![photo], |row| row.get(0)).unwrap();
    assert_eq!(pending_writes, 1);
}

#[test]
fn restore_deleted_faces_unwritten_restores_row_cover_and_clears_pending_write() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    conn.execute("INSERT INTO persons (name, name_key) VALUES ('Alice', 'alice')", []).unwrap();
    let person = conn.last_insert_rowid();
    let emb = vec![1u8, 2, 3, 4];
    let landmarks = vec![5u8, 6, 7, 8];
    conn.execute(
        "INSERT INTO faces (photo_id, x, y, w, h, origin, state, person_id, score, margin, det_score, sharpness, size_px, size_pct, embedding, model_id, landmarks, dirty)
         VALUES (?1, 0.2, 0.3, 0.15, 0.25, 'detected', 'confirmed', ?2, 0.91, 0.12, 0.99, 120.0, 80.0, 8.0, ?3, 'sface', ?4, 0)",
        params![photo, person, emb, landmarks],
    )
    .unwrap();
    let face = conn.last_insert_rowid();
    conn.execute("UPDATE persons SET cover_face_id = ?1 WHERE id = ?2", params![face, person]).unwrap();

    let snapshots = snapshot_full_faces_in(&conn, &[face]).unwrap();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].was_cover_of, Some(person));
    assert!(!snapshots[0].had_photo_write);

    // Simulate delete_faces
    conn.execute("INSERT OR IGNORE INTO photo_face_writes (photo_id) VALUES (?1)", params![photo]).unwrap();
    conn.execute("UPDATE persons SET cover_face_id = NULL WHERE cover_face_id = ?1", params![face]).unwrap();
    conn.execute("DELETE FROM faces WHERE id = ?1", params![face]).unwrap();

    assert_eq!(restore_deleted_faces_in(&conn, &snapshots).unwrap(), 1);
    let (restored_state, restored_person, restored_dirty, restored_emb, restored_lm): (String, Option<i64>, bool, Option<Vec<u8>>, Option<Vec<u8>>) = conn
        .query_row(
            "SELECT state, person_id, dirty, embedding, landmarks FROM faces WHERE id = ?1",
            params![face],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap();
    assert_eq!(restored_state, "confirmed");
    assert_eq!(restored_person, Some(person));
    assert!(!restored_dirty);
    assert_eq!(restored_emb, Some(emb));
    assert_eq!(restored_lm, Some(landmarks));
    let pending_writes: i64 = conn.query_row("SELECT COUNT(*) FROM photo_face_writes WHERE photo_id = ?1", params![photo], |row| row.get(0)).unwrap();
    let cover: Option<i64> = conn.query_row("SELECT cover_face_id FROM persons WHERE id = ?1", params![person], |row| row.get(0)).unwrap();
    assert_eq!(pending_writes, 0);
    assert_eq!(cover, Some(face));
}

#[test]
fn restore_deleted_faces_after_write_marks_face_dirty() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    conn.execute("INSERT INTO persons (name, name_key) VALUES ('Alice', 'alice')", []).unwrap();
    let person = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO faces (photo_id, x, y, w, h, origin, state, person_id, dirty) VALUES (?1, 0.2, 0.3, 0.15, 0.25, 'detected', 'confirmed', ?2, 0)",
        params![photo, person],
    )
    .unwrap();
    let face = conn.last_insert_rowid();
    let snapshots = snapshot_full_faces_in(&conn, &[face]).unwrap();

    // Simulate delete_faces followed by a file write that flushed photo_face_writes.
    conn.execute("DELETE FROM faces WHERE id = ?1", params![face]).unwrap();

    assert_eq!(restore_deleted_faces_in(&conn, &snapshots).unwrap(), 1);
    let dirty: bool = conn.query_row("SELECT dirty FROM faces WHERE id = ?1", params![face], |row| row.get(0)).unwrap();
    assert!(dirty);
}

#[test]
fn restore_faces_recomputes_dirty_after_file_write() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    conn.execute("INSERT INTO persons (name, name_key) VALUES ('Alice', 'alice')", []).unwrap();
    let person = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO faces (photo_id, x, y, w, h, origin, state, person_id, dirty) VALUES (?1, 0.2, 0.3, 0.15, 0.25, 'detected', 'confirmed', ?2, 0)",
        params![photo, person],
    )
    .unwrap();
    let face = conn.last_insert_rowid();
    let snapshot = FaceSnapshot {
        id: face,
        state: "confirmed".into(),
        person_id: Some(person),
        suggested_person_id: None,
        rejected_person_id: None,
        unknown_locked: false,
        dirty: false,
    };

    // Simulate set_faces_unknown followed by a file write (dirty reset to 0).
    set_faces_unknown_in(&conn, &[face]).unwrap();
    conn.execute("UPDATE faces SET dirty = 0 WHERE id = ?1", params![face]).unwrap();

    assert_eq!(restore_faces_in(&conn, &[snapshot]).unwrap(), 1);
    let (state, restored_person, dirty): (String, Option<i64>, bool) = conn
        .query_row("SELECT state, person_id, dirty FROM faces WHERE id = ?1", params![face], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap();
    assert_eq!(state, "confirmed");
    assert_eq!(restored_person, Some(person));
    assert!(dirty);
}
