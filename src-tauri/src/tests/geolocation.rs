//! Tests de l'effacement de la géolocalisation (geolocation.rs) : sauvegarde des coordonnées gardée à jour par les déclencheurs SQLite, refus
//! des photos dont le GPS de l'EXIF ne peut pas être effacé. L'écriture elle-même est testée dans tests/exif.rs (écriture interne).

use super::*;
use crate::test_support::*;

fn saved(conn: &rusqlite::Connection, photo_id: i64) -> bool {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM erased_locations WHERE photo_id = ?1)", [photo_id], |row| row.get(0)).unwrap()
}

fn save(conn: &rusqlite::Connection, photo_id: i64) {
    conn.execute("INSERT INTO erased_locations (photo_id, lat, lon, erased_at) VALUES (?1, 48.85, 2.35, 1)", [photo_id]).unwrap();
}

#[test]
fn saved_coordinates_follow_the_photo() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/Photos/a.jpg");

    // Effacement : coordonnées retirées de la photo, la sauvegarde reste.
    save(&conn, photo);
    conn.execute("UPDATE photos SET gps_lat = NULL, gps_lon = NULL WHERE id = ?1", [photo]).unwrap();
    assert!(saved(&conn, photo));
    // Photo déplacée ou renommée : la sauvegarde suit (même identifiant).
    conn.execute("UPDATE photos SET path = 'C:/Autres/b.jpg' WHERE id = ?1", [photo]).unwrap();
    assert!(saved(&conn, photo));
    // Coordonnées retrouvées (restauration, ou fichier géolocalisé par un autre logiciel puis relu) : sauvegarde supprimée.
    conn.execute("UPDATE photos SET gps_lat = 1.5, gps_lon = 2.5 WHERE id = ?1", [photo]).unwrap();
    assert!(!saved(&conn, photo));

    // Photo retirée du catalogue : sa sauvegarde aussi.
    save(&conn, photo);
    conn.execute("DELETE FROM photos WHERE id = ?1", [photo]).unwrap();
    assert!(!saved(&conn, photo));
}

#[test]
fn exif_gps_is_refused_when_it_cannot_be_erased() {
    let jpeg = Path::new("C:/Photos/a.jpg");
    let raw = Path::new("C:/Photos/a.cr2");
    // GPS seulement dans le XMP : toujours effaçable.
    assert_eq!(erase_refusal(jpeg, false, false), None);
    assert_eq!(erase_refusal(raw, false, true), None);
    // GPS dans l'EXIF : il faut ExifTool, et un format écrit directement (pas un sidecar).
    assert_eq!(erase_refusal(jpeg, true, false), Some("gps_in_exif_internal_writer"));
    assert_eq!(erase_refusal(jpeg, true, true), None);
    assert_eq!(erase_refusal(raw, true, true), Some("gps_in_exif_sidecar_format"));
    assert_eq!(erase_refusal(Path::new("C:/Photos/a.png"), true, true), Some("gps_in_exif_sidecar_format"));
}
