//! Tests de l'arbre des mots-clés et de leur association aux photos (keywords.rs) : le fichier fait foi, l'arbre ne rétrécit jamais.

use super::*;
use crate::test_support::*;

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

/// Mots-clés actifs d'une photo, sous forme de chemins « A > B > C ».
fn active_paths(conn: &Connection, photo_id: i64) -> Vec<String> {
    let nodes: HashMap<i64, (i64, String)> = conn
        .prepare("SELECT id, parent_id, name FROM keyword_nodes").unwrap()
        .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?)))).unwrap()
        .map(|row| row.unwrap()).collect();
    let mut result: Vec<String> = conn
        .prepare("SELECT keyword_id FROM photo_keywords WHERE photo_id = ?1").unwrap()
        .query_map(params![photo_id], |row| row.get::<_, i64>(0)).unwrap()
        .map(|id| node_path(&nodes, id.unwrap()).unwrap().join(" > ")).collect();
    result.sort();
    result
}

#[test]
fn nodes_are_unique_per_parent_ignoring_case() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let paris = ensure_node(&conn, 0, "Paris").unwrap();
    assert_eq!(ensure_node(&conn, 0, " paris ").unwrap(), paris);
    let france = ensure_node(&conn, 0, "France").unwrap();
    assert_ne!(ensure_node(&conn, france, "Paris").unwrap(), paris, "même nom sous un autre parent = autre mot-clé");
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM keyword_nodes"), 3);
}

#[test]
fn only_the_leaf_is_active_and_the_file_wins() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    let other = insert_photo(&conn, "C:/P/b.jpg");

    assert!(store_photo_keywords(&conn, &[("C:/P/a.jpg".into(), paths(&[&["Lieux", "France", "Paris"]])), ("C:/P/b.jpg".into(), paths(&[&["Lieux"]]))]));
    assert_eq!(active_paths(&conn, photo), ["Lieux > France > Paris"]);
    assert_eq!(active_paths(&conn, other), ["Lieux"]);

    // Relecture du fichier : ses mots-clés remplacent ceux de la base ; l'arbre, lui, n'est jamais élagué.
    assert!(store_photo_keywords(&conn, &[("C:/P/a.jpg".into(), paths(&[&["Animaux"], &[], &["Animaux"]]))]));
    assert_eq!(active_paths(&conn, photo), ["Animaux"]);
    assert_eq!(active_paths(&conn, other), ["Lieux"], "une autre photo ne doit pas bouger");
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM keyword_nodes"), 4);
}

#[test]
fn written_keyword_ids_are_those_stored_after_reading() {
    // Ce que run_write renvoie au panneau (KeywordWritten::keyword_ids) : les mots-clés actifs relus, pas ceux demandés.
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    insert_photo(&conn, "C:/P/b.jpg");
    assert!(store_photo_keywords(&conn, &[
        ("C:/P/a.jpg".into(), paths(&[&["Personnes", "Alice"], &["Lieux"]])),
        ("C:/P/b.jpg".into(), paths(&[&["Autre"]])),
    ]));
    let alice = ensure_node(&conn, ensure_node(&conn, 0, "Personnes").unwrap(), "Alice").unwrap();
    let lieux = ensure_node(&conn, 0, "Lieux").unwrap();
    let mut expected = vec![alice, lieux];
    expected.sort();
    assert_eq!(photo_keyword_ids(&conn, photo).unwrap(), expected, "seuls les derniers niveaux, et seulement ceux de cette photo");
    assert!(store_photo_keywords(&conn, &[("C:/P/a.jpg".into(), Vec::new())]));
    assert!(photo_keyword_ids(&conn, photo).unwrap().is_empty());
}

#[test]
fn unknown_photo_is_skipped_without_failing_the_batch() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let photo = insert_photo(&conn, "C:/P/a.jpg");
    assert!(store_photo_keywords(&conn, &[("C:/P/absente.jpg".into(), paths(&[&["X"]])), ("C:/P/a.jpg".into(), paths(&[&["Y"]]))]));
    assert_eq!(active_paths(&conn, photo), ["Y"]);
    assert!(store_photo_keywords(&conn, &[]));
}

#[test]
fn database_failure_is_reported_not_swallowed() {
    // Base sans aucune table : l'enregistrement doit échouer proprement (faux), sans panique ni demi-lot.
    let conn = Connection::open_in_memory().unwrap();
    assert!(!store_photo_keywords(&conn, &[("C:/P/a.jpg".into(), paths(&[&["X"]]))]));
}

#[test]
fn name_validation() {
    assert_eq!(validate_name("  Paris ").unwrap(), "Paris");
    for bad in ["", "   ", "a/b", "a|b", "a,b"] { assert_eq!(validate_name(bad), Err("invalid_name".to_string()), "{bad:?}"); }
    assert_eq!(name_key("  ÉTÉ "), "été");
}
