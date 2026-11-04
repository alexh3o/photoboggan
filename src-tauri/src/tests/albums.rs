//! Tests des albums virtuels (albums.rs) : règles de parenté, unicité des noms, déplacement sans cycle, copie, suppression en cascade.

use super::*;
use crate::test_support::*;

fn names(conn: &Connection) -> Vec<String> {
    let mut list: Vec<String> = list_nodes(conn).unwrap().into_iter().map(|n| n.name).collect();
    list.sort();
    list
}

#[test]
fn parent_rules() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let folder = create_node(&conn, 0, KIND_FOLDER, "Voyages").unwrap();
    let manual = create_node(&conn, folder, KIND_MANUAL, "Sélection").unwrap();
    let smart = create_node(&conn, folder, KIND_SMART, "Notes 5").unwrap();
    // Un album manuel n'a pas d'enfant sauf un intelligent ; un intelligent n'accepte que des intelligents.
    assert!(create_node(&conn, manual, KIND_FOLDER, "x").is_err());
    assert!(create_node(&conn, manual, KIND_MANUAL, "x").is_err());
    assert!(create_node(&conn, smart, KIND_FOLDER, "x").is_err());
    assert!(create_node(&conn, smart, KIND_MANUAL, "x").is_err());
    assert!(create_node(&conn, manual, KIND_SMART, "Filtre du manuel").is_ok());
    assert!(create_node(&conn, smart, KIND_SMART, "Enfant").is_ok());
    assert!(create_node(&conn, 0, "autre", "x").is_err());
}

#[test]
fn names_are_unique_per_parent_ignoring_case() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let a = create_node(&conn, 0, KIND_FOLDER, "A").unwrap();
    assert!(create_node(&conn, 0, KIND_SMART, " a ").is_err());
    assert!(create_node(&conn, a, KIND_SMART, "a").is_ok(), "même nom sous un autre parent");
    assert!(create_node(&conn, 0, KIND_FOLDER, "  ").is_err());
    let b = create_node(&conn, 0, KIND_FOLDER, "B").unwrap();
    assert!(rename_node(&conn, b, "A").is_err());
    assert!(rename_node(&conn, b, "b2").is_ok());
    assert!(rename_node(&conn, b, "B2").is_ok(), "renommer en changeant seulement la casse reste possible");
}

#[test]
fn move_keeps_filters_and_forbids_cycles_and_bad_parents() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let outer = create_node(&conn, 0, KIND_FOLDER, "Dehors").unwrap();
    let inner = create_node(&conn, outer, KIND_FOLDER, "Dedans").unwrap();
    let smart = create_node(&conn, inner, KIND_SMART, "S").unwrap();
    set_filters(&conn, smart, r#"{"rating":{"stars":4}}"#).unwrap();

    assert!(move_node(&conn, outer, inner).is_err(), "pas dans sa descendance");
    assert!(move_node(&conn, outer, outer).is_err(), "pas dans lui-même");
    let manual = create_node(&conn, 0, KIND_MANUAL, "M").unwrap();
    assert!(move_node(&conn, inner, manual).is_err(), "un dossier ne va pas dans un album");

    move_node(&conn, smart, 0).unwrap();
    let moved = get_node(&conn, smart).unwrap();
    assert_eq!(moved.parent_id, 0);
    assert_eq!(moved.filters, r#"{"rating":{"stars":4}}"#, "les critères ne changent pas au déplacement");
    // Sous un album manuel : possible pour un album intelligent.
    move_node(&conn, smart, manual).unwrap();
    assert_eq!(get_node(&conn, smart).unwrap().parent_id, manual);
}

#[test]
fn move_refuses_a_name_already_taken_in_the_target() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let a = create_node(&conn, 0, KIND_FOLDER, "A").unwrap();
    create_node(&conn, a, KIND_SMART, "Même").unwrap();
    let other = create_node(&conn, 0, KIND_SMART, "même").unwrap();
    assert!(move_node(&conn, other, a).is_err());
}

#[test]
fn delete_removes_the_subtree_and_memberships_but_not_photos() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    let folder = create_node(&conn, 0, KIND_FOLDER, "F").unwrap();
    let manual = create_node(&conn, folder, KIND_MANUAL, "M").unwrap();
    create_node(&conn, folder, KIND_SMART, "S").unwrap();
    conn.execute("INSERT INTO album_photos (album_id, photo_id) VALUES (?1, ?2)", params![manual, photo]).unwrap();
    assert_eq!(get_node(&conn, manual).unwrap().count, Some(1));

    delete_node(&conn, folder).unwrap();
    assert!(names(&conn).is_empty());
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM album_photos", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
    let photos: i64 = conn.query_row("SELECT COUNT(*) FROM photos", [], |r| r.get(0)).unwrap();
    assert_eq!(photos, 1);
}

#[test]
fn a_deleted_photo_leaves_every_album() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let kept = insert_photo(&conn, "C:/P/a.jpg");
    let gone = insert_photo(&conn, "C:/P/b.jpg");
    let one = create_node(&conn, 0, KIND_MANUAL, "Un").unwrap();
    let two = create_node(&conn, 0, KIND_MANUAL, "Deux").unwrap();
    for (album, photo) in [(one, kept), (one, gone), (two, gone)] {
        conn.execute("INSERT INTO album_photos (album_id, photo_id) VALUES (?1, ?2)", params![album, photo]).unwrap();
    }
    conn.execute("DELETE FROM photos WHERE path = 'C:/P/b.jpg'", []).unwrap();
    assert_eq!(get_node(&conn, one).unwrap().count, Some(1));
    assert_eq!(get_node(&conn, two).unwrap().count, Some(0));
}

#[test]
fn copy_gets_a_free_name_and_copies_the_subtree() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    let folder = create_node(&conn, 0, KIND_FOLDER, "F").unwrap();
    let manual = create_node(&conn, folder, KIND_MANUAL, "M").unwrap();
    conn.execute("INSERT INTO album_photos (album_id, photo_id) VALUES (?1, ?2)", params![manual, photo]).unwrap();

    let first = copy_node(&conn, folder, 0, "copie").unwrap();
    let second = copy_node(&conn, folder, 0, "copie").unwrap();
    assert_eq!(get_node(&conn, first).unwrap().name, "F (copie)");
    assert_eq!(get_node(&conn, second).unwrap().name, "F (copie 2)");
    // Le contenu de l'album manuel est copié, les enfants gardent leur nom.
    let copied_manual: Vec<AlbumNode> = list_nodes(&conn).unwrap().into_iter().filter(|n| n.parent_id == first).collect();
    assert_eq!(copied_manual.len(), 1);
    assert_eq!(copied_manual[0].name, "M");
    assert_eq!(copied_manual[0].count, Some(1));
    assert!(copy_node(&conn, folder, folder, "copie").is_err(), "pas de copie dans soi-même");
}

#[test]
fn filters_are_only_for_smart_albums_and_must_be_json() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let smart = create_node(&conn, 0, KIND_SMART, "S").unwrap();
    let manual = create_node(&conn, 0, KIND_MANUAL, "M").unwrap();
    assert!(set_filters(&conn, smart, "{pas du json").is_err());
    assert!(set_filters(&conn, manual, "{}").is_err());
    set_filters(&conn, smart, r#"{"keywords":["Paris"]}"#).unwrap();
    assert_eq!(get_node(&conn, smart).unwrap().filters, r#"{"keywords":["Paris"]}"#);
}

#[test]
fn manual_album_content_add_remove_replace() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let a = insert_photo(&conn, "C:/P/a.jpg");
    let b = insert_photo(&conn, "C:/P/b.jpg");
    let c = insert_photo(&conn, "C:/P/c.jpg");
    let one = create_node(&conn, 0, KIND_MANUAL, "Un").unwrap();
    let two = create_node(&conn, 0, KIND_MANUAL, "Deux").unwrap();
    let smart = create_node(&conn, 0, KIND_SMART, "S").unwrap();

    assert_eq!(add_photos(&conn, one, &[a, b]).unwrap(), 2);
    assert_eq!(add_photos(&conn, one, &[b, c, 9999]).unwrap(), 1, "déjà présente et inconnue ignorées");
    assert_eq!(add_photos(&conn, two, &[a]).unwrap(), 1, "une photo peut être dans plusieurs albums");
    assert_eq!(get_node(&conn, one).unwrap().count, Some(3));

    assert_eq!(remove_photos(&conn, one, &[a, 9999]).unwrap(), 1);
    assert_eq!(album_photos(&conn, two).unwrap().len(), 1, "l'autre album ne bouge pas");
    let paths: Vec<String> = album_photos(&conn, one).unwrap().into_iter().map(|p| p.path).collect();
    assert_eq!(paths.len(), 2);
    assert!(!paths.contains(&"C:/P/a.jpg".to_string()));

    assert_eq!(replace_photos(&conn, one, &[a]).unwrap(), 1);
    assert_eq!(album_photos(&conn, one).unwrap().len(), 1);
    // Un remplacement par rien vide l'album.
    assert_eq!(replace_photos(&conn, one, &[]).unwrap(), 0);
    assert!(album_photos(&conn, one).unwrap().is_empty());

    // Seuls les albums manuels ont un contenu choisi.
    assert!(add_photos(&conn, smart, &[a]).is_err());
    assert!(album_photos(&conn, smart).is_err());
}

#[test]
fn memberships_list_every_manual_album_pair() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let a = insert_photo(&conn, "C:/P/a.jpg");
    let b = insert_photo(&conn, "C:/P/b.jpg");
    let one = create_node(&conn, 0, KIND_MANUAL, "Un").unwrap();
    let two = create_node(&conn, 0, KIND_MANUAL, "Deux").unwrap();
    add_photos(&conn, one, &[a, b]).unwrap();
    add_photos(&conn, two, &[b]).unwrap();
    let mut pairs = memberships(&conn).unwrap();
    pairs.sort();
    assert_eq!(pairs, vec![(one, a), (one, b), (two, b)]);
}

// L'annulation d'un ajout ne doit retirer que les photos réellement ajoutées, pas celles qui étaient déjà dans l'album.
#[test]
fn adding_photos_reports_only_the_ones_actually_added() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let a = insert_photo(&conn, "C:/P/a.jpg");
    let b = insert_photo(&conn, "C:/P/b.jpg");
    let album = create_node(&conn, 0, KIND_MANUAL, "Un").unwrap();

    assert_eq!(add_photos_listed(&conn, album, &[a]).unwrap(), vec![a]);
    assert_eq!(add_photos_listed(&conn, album, &[a, b, 9999]).unwrap(), vec![b], "déjà présente et inconnue absentes de la liste");
    assert!(add_photos_listed(&conn, album, &[a, b]).unwrap().is_empty());
}
