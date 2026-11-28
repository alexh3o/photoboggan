//! Tests des préréglages d'auteur, de la lecture des droits d'une sélection, de la liste des auteurs et du préfiltre « Auteur » (rights.rs, db.rs).

use super::*;
use crate::test_support::*;

fn preset(id: i64, author: &str, copyright: &str, credit: &str, usage_terms: &str, author_email: &str) -> AuthorPreset {
    AuthorPreset { id, name: String::new(), author: author.into(), copyright: copyright.into(), credit: credit.into(), usage_terms: usage_terms.into(), author_email: author_email.into() }
}

#[test]
fn a_new_preset_is_created_empty_and_an_existing_name_returns_the_existing_preset() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let created = create_preset(&conn, "  Mes photos  ").unwrap();
    assert_eq!(created.name, "Mes photos");
    assert_eq!((created.author.as_str(), created.copyright.as_str(), created.credit.as_str(), created.usage_terms.as_str(), created.author_email.as_str()), ("", "", "", "", ""));
    // Same name, other case: the existing preset, not a second one.
    assert_eq!(create_preset(&conn, "MES PHOTOS").unwrap(), created);
    assert_eq!(list_presets(&conn).unwrap().len(), 1);
    // Names must be neither empty nor too long.
    assert_eq!(create_preset(&conn, "   "), Err("invalid_name".to_string()));
    assert_eq!(create_preset(&conn, &"x".repeat(MAX_PRESET_NAME_CHARS + 1)), Err("invalid_name".to_string()));
    assert!(create_preset(&conn, &"x".repeat(MAX_PRESET_NAME_CHARS)).is_ok());
}

#[test]
fn saving_a_preset_replaces_its_values_and_a_vanished_preset_is_reported() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let created = create_preset(&conn, "Studio").unwrap();
    let saved = save_preset(&conn, &preset(created.id, " Ada; Bob ", "© 2026 Ada", "Agence", "Libre", "ada@example.org")).unwrap();
    assert_eq!(saved.name, "Studio");
    assert_eq!((saved.author.as_str(), saved.copyright.as_str(), saved.credit.as_str(), saved.usage_terms.as_str(), saved.author_email.as_str()), ("Ada; Bob", "© 2026 Ada", "Agence", "Libre", "ada@example.org"));
    assert_eq!(list_presets(&conn).unwrap(), vec![saved.clone()]);
    // Saved again with blank fields: blank values are real values (they empty the fields when the preset is recalled).
    let blank = save_preset(&conn, &preset(created.id, "", "", "", "", "")).unwrap();
    assert_eq!(blank.author, "");
    delete_preset(&conn, created.id).unwrap();
    assert!(list_presets(&conn).unwrap().is_empty());
    assert_eq!(save_preset(&conn, &preset(created.id, "A", "", "", "", "")), Err("unknown_preset".to_string()));
    // Deleting twice is harmless.
    delete_preset(&conn, created.id).unwrap();
}

#[test]
fn presets_are_listed_by_name_ignoring_case() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    for name in ["banane", "Cerise", "Abricot"] { create_preset(&conn, name).unwrap(); }
    let names: Vec<String> = list_presets(&conn).unwrap().into_iter().map(|preset| preset.name).collect();
    assert_eq!(names, ["Abricot", "banane", "Cerise"]);
}

#[test]
fn rights_of_a_selection_come_from_the_catalog() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let first = insert_photo(&conn, "C:/P/a.jpg");
    let second = insert_photo(&conn, "C:/P/b.jpg");
    conn.execute("UPDATE photos SET author = 'Ada', copyright = '© Ada', credit = 'Agence', usage_terms = 'Libre', author_email = 'a@b.fr' WHERE id = ?1", params![first]).unwrap();
    let mut rights = photo_rights(&conn, &[first, second, 9999]).unwrap();
    rights.sort_by_key(|rights| rights.photo_id);
    assert_eq!(rights.len(), 2, "unknown photos are left out");
    assert_eq!((rights[0].author.as_str(), rights[0].copyright.as_str(), rights[0].author_email.as_str()), ("Ada", "© Ada", "a@b.fr"));
    assert_eq!((rights[1].author.as_str(), rights[1].credit.as_str()), ("", ""), "a photo read before the columns existed has empty values");
    assert!(photo_rights(&conn, &[]).unwrap().is_empty());
}

#[test]
fn authors_are_listed_one_by_one_with_their_photo_counts() {
    let counts = author_counts(&[
        ("Ada Lovelace; Bob".to_string(), 3),
        ("ada lovelace".to_string(), 2),
        ("Bob".to_string(), 1),
        ("Zoé; Zoé".to_string(), 4),
        (" ; ".to_string(), 7),
    ]);
    let summary: Vec<(&str, i64)> = counts.iter().map(|author| (author.name.as_str(), author.count)).collect();
    // « Ada Lovelace » and « ada lovelace » are one author (first spelling kept); the same name twice in one value counts its photos once.
    assert_eq!(summary, [("Ada Lovelace", 5), ("Bob", 4), ("Zoé", 4)]);
    assert!(author_counts(&[]).is_empty());
}

#[test]
fn the_author_prefilter_keeps_a_superset_of_the_matching_photos() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let ada = insert_photo(&conn, "C:/P/ada.jpg");
    let both = insert_photo(&conn, "C:/P/both.jpg");
    let nobody = insert_photo(&conn, "C:/P/nobody.jpg");
    conn.execute("UPDATE photos SET author = 'Ada Lovelace' WHERE id = ?1", params![ada]).unwrap();
    conn.execute("UPDATE photos SET author = 'Bob; Ada Lovelace' WHERE id = ?1", params![both]).unwrap();
    let ids = |authors: &[&str]| -> Vec<i64> {
        let filter = crate::db::PhotoPrefilter { authors: authors.iter().map(std::string::ToString::to_string).collect(), ..Default::default() };
        let mut ids: Vec<i64> = crate::db::get_photos_filtered(&pool, 0, 10, None, true, "name", true, &filter).unwrap().into_iter().map(|photo| photo.id).collect();
        ids.sort_unstable();
        ids
    };
    assert_eq!(ids(&["ada lovelace"]), vec![ada, both], "lowercase text, case-insensitive");
    assert_eq!(ids(&["bob", "ada lovelace"]), vec![both], "all authors must appear");
    assert_eq!(ids(&[]), vec![ada, both, nobody], "no author filter keeps everything");
    assert!(ids(&["inconnu"]).is_empty());
    assert_eq!(crate::db::count_photos(&pool, None, true, &crate::db::PhotoPrefilter { authors: vec!["bob".into()], ..Default::default() }).unwrap(), 1);
}

#[test]
fn the_catalog_upgrade_adds_the_rights_columns_once() {
    // The catalog is opened twice: the second opening must not fail on the existing columns or table, nor lose the presets.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("catalog.db").to_string_lossy().to_string();
    {
        let pool = crate::db::init_db(&file).expect("init db");
        let conn = pool.get().unwrap();
        create_preset(&conn, "Garde-moi").unwrap();
        insert_photo(&conn, "C:/P/a.jpg");
    }
    let pool = crate::db::init_db(&file).expect("reopen db");
    let conn = pool.get().unwrap();
    assert_eq!(list_presets(&conn).unwrap().len(), 1, "presets survive a reopening");
    let columns: Vec<String> = conn.prepare("SELECT name FROM pragma_table_info('photos')").unwrap().query_map([], |row| row.get(0)).unwrap().map(|name| name.unwrap()).collect();
    for column in ["author", "copyright", "credit", "usage_terms", "author_email"] {
        assert_eq!(columns.iter().filter(|name| name.as_str() == column).count(), 1, "{column}");
    }
}
