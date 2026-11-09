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

// ---------------------------------------------------------------------------
// Batch writes (run_write, run_rename, run_delete) on real synthetic JPEG files, with the internal writer: the global writer setting is
// never changed (WriteEnv carries the writer).
// ---------------------------------------------------------------------------

fn write_env(dir: &Path) -> WriteEnv {
    let cache_dirs = crate::ImageCacheDirs { thumbnails: dir.join("thumbnails"), raw_previews: dir.join("raw_previews") };
    std::fs::create_dir_all(&cache_dirs.thumbnails).unwrap();
    std::fs::create_dir_all(&cache_dirs.raw_previews).unwrap();
    WriteEnv { cache_dirs, progress: Box::new(|_| {}), write: crate::exif::write_metadata_internal }
}

/// A synthetic JPEG in `dir`, catalogued: (photo id, path).
fn catalogued_jpeg(conn: &Connection, dir: &Path, name: &str) -> (i64, String) {
    let path = dir.join(name);
    std::fs::write(&path, jpeg_bytes(32, 24)).unwrap();
    let path = path.to_string_lossy().into_owned();
    (insert_photo(conn, &path), path)
}

fn file_paths(path: &str) -> Vec<String> {
    let mut result: Vec<String> = crate::exif::read_exif(Path::new(path)).keyword_paths.iter().map(|segments| segments.join(" > ")).collect();
    result.sort();
    result
}

fn item(photo_id: i64, path: &str, keyword_ids: Option<Vec<i64>>) -> KeywordWriteItem {
    KeywordWriteItem { photo_id, path: path.to_string(), keyword_ids, title: None, description: None, faces: None, gps: None }
}

#[test]
fn run_write_writes_the_file_then_stores_what_it_reads_back() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let (photo, path) = catalogued_jpeg(&conn, dir.path(), "a.jpg");
    let paris = ensure_node(&conn, ensure_node(&conn, 0, "Lieux").unwrap(), "Paris").unwrap();
    let pixels = scan_data(&std::fs::read(&path).unwrap()).to_vec();

    // Keywords only: the title check (text_mismatch) follows the global writer setting, which a fast test must not change.
    let result = run_write(&write_env(dir.path()), &pool, vec![item(photo, &path, Some(vec![paris]))], None).unwrap();
    assert!(result.failed.is_empty(), "{:?}", result.failed.iter().map(|f| &f.error).collect::<Vec<_>>());
    assert_eq!(result.written.len(), 1);
    assert_eq!(result.written[0].keyword_ids, vec![paris]);
    assert_eq!(file_paths(&path), ["Lieux > Paris"]);
    assert_eq!(active_paths(&conn, photo), ["Lieux > Paris"]);
    let stored: String = conn.query_row("SELECT keywords FROM photos WHERE id = ?1", params![photo], |row| row.get(0)).unwrap();
    assert!(stored.contains("Paris"), "photos.keywords comes from the re-read file");
    assert_eq!(scan_data(&std::fs::read(&path).unwrap()), pixels.as_slice(), "image data untouched");
}

#[test]
fn run_write_fails_a_photo_with_an_unknown_keyword_or_outside_the_catalogue() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let (photo, path) = catalogued_jpeg(&conn, dir.path(), "a.jpg");
    let before = std::fs::read(&path).unwrap();

    let result = run_write(&write_env(dir.path()), &pool, vec![item(photo, &path, Some(vec![9999])), item(4242, "C:/absent.jpg", Some(Vec::new()))], None).unwrap();
    assert!(result.written.is_empty());
    assert_eq!(result.failed.len(), 2);
    assert_eq!(std::fs::read(&path).unwrap(), before, "an unknown keyword must not silently drop the others from the file");
}

#[test]
fn rename_updates_the_tree_then_rewrites_every_file_carrying_the_keyword_or_a_descendant() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let (photo, path) = catalogued_jpeg(&conn, dir.path(), "a.jpg");
    let (other, other_path) = catalogued_jpeg(&conn, dir.path(), "b.jpg");
    let places = ensure_node(&conn, 0, "Lieux").unwrap();
    let paris = ensure_node(&conn, places, "Paris").unwrap();
    let env = write_env(dir.path());
    run_write(&env, &pool, vec![item(photo, &path, Some(vec![paris])), item(other, &other_path, Some(vec![places]))], None).unwrap();

    let result = run_rename(&env, &pool, places, "Endroits".into(), None).unwrap();
    assert!(result.failed.is_empty());
    assert_eq!(result.written.len(), 2);
    assert_eq!(file_paths(&path), ["Endroits > Paris"]);
    assert_eq!(file_paths(&other_path), ["Endroits"]);
    assert_eq!(active_paths(&conn, photo), ["Endroits > Paris"]);
    assert_eq!(run_rename(&env, &pool, places, "a/b".into(), None).err().as_deref(), Some("invalid_name"));
    ensure_node(&conn, 0, "Autre").unwrap();
    assert_eq!(run_rename(&env, &pool, places, " autre ".into(), None).err().as_deref(), Some("duplicate"));
}

#[test]
fn delete_removes_the_subtree_from_the_files_and_the_tree() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let (photo, path) = catalogued_jpeg(&conn, dir.path(), "a.jpg");
    let places = ensure_node(&conn, 0, "Lieux").unwrap();
    let paris = ensure_node(&conn, places, "Paris").unwrap();
    let animals = ensure_node(&conn, 0, "Animaux").unwrap();
    let env = write_env(dir.path());
    run_write(&env, &pool, vec![item(photo, &path, Some(vec![paris, animals]))], None).unwrap();

    let result = run_delete(&env, &pool, places, None).unwrap();
    assert!(result.deleted);
    assert_eq!(file_paths(&path), ["Animaux"]);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM keyword_nodes"), 1, "the keyword and its descendants leave the tree");
    assert_eq!(run_delete(&env, &pool, places, None).err().as_deref(), Some("unknown_keyword"));
}

#[test]
fn delete_keeps_the_keyword_when_a_file_could_not_be_rewritten() {
    let (dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let (photo, path) = catalogued_jpeg(&conn, dir.path(), "a.jpg");
    let places = ensure_node(&conn, 0, "Lieux").unwrap();
    let env = write_env(dir.path());
    run_write(&env, &pool, vec![item(photo, &path, Some(vec![places]))], None).unwrap();
    // A second photo carries the keyword but its file is gone: its write fails.
    let gone = insert_photo(&conn, &dir.path().join("gone.jpg").to_string_lossy());
    assert!(store_photo_keywords(&conn, &[(dir.path().join("gone.jpg").to_string_lossy().into_owned(), paths(&[&["Lieux"]]))]));

    let result = run_delete(&env, &pool, places, None).unwrap();
    assert!(!result.deleted);
    assert_eq!(result.failed.len(), 1);
    assert_eq!(result.failed[0].photo_id, gone);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM keyword_nodes"), 1, "kept: a file still carries it");
    assert!(file_paths(&path).is_empty(), "the file that could be rewritten no longer carries it");
}

