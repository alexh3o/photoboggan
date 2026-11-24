//! Tests of the batch rename: planning (collisions, sidecars, lengths), execution (swaps, catalogue update) and saved recipes.
//! Files are made in a temporary folder, no real photo is used.

use super::*;
use crate::test_support::{insert_photo, temp_catalog};

struct TestHooks {
    cancelled: bool,
}

impl Hooks for TestHooks {
    fn cancelled(&self) -> bool { self.cancelled }
    fn advance(&mut self, _size: u64) {}
}

fn write(dir: &Path, name: &str, content: &str) -> String {
    let path = dir.join(name);
    fs::write(&path, content).expect("write file");
    path.to_string_lossy().into_owned()
}

fn read(dir: &Path, name: &str) -> Option<String> {
    fs::read_to_string(dir.join(name)).ok()
}

fn item(path: &str, new_name: &str) -> RenameItem {
    RenameItem { path: path.to_string(), new_name: new_name.to_string() }
}

/// (file name, code) of each failure.
fn failures(failed: &[RenameFailure]) -> Vec<(String, String)> {
    failed.iter().map(|failure| (file_name_of(Path::new(&failure.path)), failure.code.clone())).collect()
}

fn run(items: Vec<RenameItem>, cancelled: bool) -> (Outcome, tempfile::TempDir, crate::db::DbPool) {
    let (catalog_dir, pool) = temp_catalog();
    {
        let conn = pool.get().expect("connection");
        for item in &items { insert_photo(&conn, &item.path); }
    }
    let conn = pool.get().expect("connection");
    let plan = plan_batch(&items);
    let outcome = execute(plan, &conn, &catalog_dir.path().join("thumbnails"), &catalog_dir.path().join("raw"), &mut TestHooks { cancelled });
    drop(conn);
    (outcome, catalog_dir, pool)
}

#[test]
fn swap_of_two_names_works_and_keeps_contents() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.jpg", "contenu A");
    let b = write(dir.path(), "b.jpg", "contenu B");
    let (outcome, _catalog, _pool) = run(vec![item(&a, "b"), item(&b, "a")], false);
    assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
    assert_eq!(outcome.renamed.len(), 2);
    assert_eq!(read(dir.path(), "a.jpg").as_deref(), Some("contenu B"));
    assert_eq!(read(dir.path(), "b.jpg").as_deref(), Some("contenu A"));
    // No temporary name is left behind.
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[test]
fn chain_of_renames_is_ordered() {
    let dir = tempfile::tempdir().unwrap();
    let one = write(dir.path(), "1.jpg", "un");
    let two = write(dir.path(), "2.jpg", "deux");
    let (outcome, _catalog, _pool) = run(vec![item(&one, "2"), item(&two, "3")], false);
    assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
    assert_eq!(read(dir.path(), "1.jpg"), None);
    assert_eq!(read(dir.path(), "2.jpg").as_deref(), Some("un"));
    assert_eq!(read(dir.path(), "3.jpg").as_deref(), Some("deux"));
}

#[test]
fn case_only_rename_is_applied() {
    let dir = tempfile::tempdir().unwrap();
    let path = write(dir.path(), "photo.jpg", "x");
    let (outcome, _catalog, _pool) = run(vec![item(&path, "PHOTO")], false);
    assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
    let names: Vec<String> = fs::read_dir(dir.path()).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec!["PHOTO.jpg".to_string()]);
}

#[test]
fn two_files_to_the_same_name_are_both_left_alone_ignoring_case() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.jpg", "A");
    let b = write(dir.path(), "b.jpg", "B");
    let c = write(dir.path(), "c.jpg", "C");
    let plan = plan_batch(&[item(&a, "X"), item(&b, "x"), item(&c, "z")]);
    assert_eq!(failures(&plan.failed), vec![("a.jpg".to_string(), "collision".to_string()), ("b.jpg".to_string(), "collision".to_string())]);
    assert_eq!(plan.planned.len(), 1); // the batch goes on for the others
    assert_eq!(plan.planned[0].path, c);
}

#[test]
fn name_taken_by_a_file_outside_the_batch_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.jpg", "A");
    write(dir.path(), "Taken.jpg", "autre");
    let plan = plan_batch(&[item(&a, "taken")]);
    assert_eq!(failures(&plan.failed), vec![("a.jpg".to_string(), "exists".to_string())]);
    assert!(plan.planned.is_empty());
}

#[test]
fn name_taken_by_a_batch_file_that_keeps_its_name_is_a_collision() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.jpg", "A");
    let b = write(dir.path(), "b.jpg", "B");
    // b.jpg is not renamed (same name): a.jpg cannot take its name.
    let plan = plan_batch(&[item(&a, "b"), item(&b, "b")]);
    assert_eq!(failures(&plan.failed), vec![("a.jpg".to_string(), "collision".to_string())]);
    assert_eq!(plan.unchanged, vec![b]);
}

#[test]
fn a_refused_file_keeps_its_name_and_blocks_the_one_that_wanted_it() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.jpg", "A");
    let b = write(dir.path(), "b.jpg", "B");
    let c = write(dir.path(), "c.jpg", "C");
    // b.jpg wants x like c.jpg (collision), so b.jpg keeps its name and a.jpg cannot take it.
    let plan = plan_batch(&[item(&a, "b"), item(&b, "x"), item(&c, "x")]);
    let names = failures(&plan.failed);
    assert_eq!(names.len(), 3, "{names:?}");
    assert!(plan.planned.is_empty());
}

#[test]
fn invalid_missing_and_duplicated_items_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.jpg", "A");
    let missing = dir.path().join("missing.jpg").to_string_lossy().into_owned();
    let plan = plan_batch(&[item(&a, "bad/name"), item(&missing, "x"), item(&a, "ok")]);
    let codes: Vec<String> = plan.failed.iter().map(|failure| failure.code.clone()).collect();
    assert_eq!(codes, vec!["invalid_name", "not_found", "duplicate"]);
}

#[test]
fn too_long_names_are_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.jpg", "A");
    let plan = plan_batch(&[item(&a, &"n".repeat(300))]);
    assert_eq!(failures(&plan.failed), vec![("a.jpg".to_string(), "too_long".to_string())]);
    // Name and whole path are both counted.
    assert!(exceeds_limits(Path::new("/dossier"), &"n".repeat(256), 255, 4095));
    assert!(!exceeds_limits(Path::new("/dossier"), &"n".repeat(255), 255, 4095));
    assert!(exceeds_limits(Path::new("/dossier"), "photo.jpg", 255, 12));
    assert!(!exceeds_limits(Path::new("/dossier"), "photo.jpg", 255, 19));
}

#[test]
fn own_sidecar_follows_its_photo() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.jpg", "A");
    write(dir.path(), "a.jpg.xmp", "xmp");
    let (outcome, _catalog, _pool) = run(vec![item(&a, "b")], false);
    assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
    assert_eq!(read(dir.path(), "b.jpg.xmp").as_deref(), Some("xmp"));
    assert_eq!(read(dir.path(), "a.jpg.xmp"), None);
}

#[test]
fn shared_sidecar_of_a_pair_renamed_to_the_same_name_is_moved_once() {
    let dir = tempfile::tempdir().unwrap();
    let raw = write(dir.path(), "a.cr2", "raw");
    let jpg = write(dir.path(), "a.jpg", "jpg");
    write(dir.path(), "a.xmp", "xmp");
    let (outcome, _catalog, _pool) = run(vec![item(&raw, "x"), item(&jpg, "x")], false);
    assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
    assert_eq!(read(dir.path(), "x.xmp").as_deref(), Some("xmp"));
    assert_eq!(read(dir.path(), "a.xmp"), None);
    assert_eq!(read(dir.path(), "x.cr2").as_deref(), Some("raw"));
    assert_eq!(read(dir.path(), "x.jpg").as_deref(), Some("jpg"));
}

#[test]
fn shared_sidecar_is_copied_when_another_reader_stays() {
    let dir = tempfile::tempdir().unwrap();
    let raw = write(dir.path(), "a.cr2", "raw");
    write(dir.path(), "a.jpg", "jpg");
    write(dir.path(), "a.xmp", "xmp");
    let (outcome, _catalog, _pool) = run(vec![item(&raw, "x")], false);
    assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
    assert_eq!(read(dir.path(), "x.xmp").as_deref(), Some("xmp"));
    assert_eq!(read(dir.path(), "a.xmp").as_deref(), Some("xmp")); // the JPEG that stays still reads it
    let has_temp = fs::read_dir(dir.path()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(".photoboggan-tmp-"));
    assert!(!has_temp, "no temporary file left behind");
}

#[test]
fn shared_sidecar_of_a_pair_renamed_to_different_names_is_copied_then_moved() {
    let dir = tempfile::tempdir().unwrap();
    let raw = write(dir.path(), "a.cr2", "raw");
    let jpg = write(dir.path(), "a.jpg", "jpg");
    write(dir.path(), "a.xmp", "xmp");
    let (outcome, _catalog, _pool) = run(vec![item(&raw, "x"), item(&jpg, "y")], false);
    assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
    assert_eq!(read(dir.path(), "x.xmp").as_deref(), Some("xmp"));
    assert_eq!(read(dir.path(), "y.xmp").as_deref(), Some("xmp"));
    assert_eq!(read(dir.path(), "a.xmp"), None);
}

#[test]
fn two_sidecars_reaching_the_same_name_take_the_extension_format() {
    let dir = tempfile::tempdir().unwrap();
    let raw = write(dir.path(), "a.cr2", "raw");
    let jpg = write(dir.path(), "b.jpg", "jpg");
    write(dir.path(), "a.xmp", "xmp A");
    write(dir.path(), "b.xmp", "xmp B");
    let (outcome, _catalog, _pool) = run(vec![item(&raw, "x"), item(&jpg, "x")], false);
    assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
    assert_eq!(read(dir.path(), "x.cr2.xmp").as_deref(), Some("xmp A"));
    assert_eq!(read(dir.path(), "x.jpg.xmp").as_deref(), Some("xmp B"));
    assert_eq!(read(dir.path(), "x.xmp"), None);
    assert_eq!(read(dir.path(), "a.xmp"), None);
    assert_eq!(read(dir.path(), "b.xmp"), None);
}

#[test]
fn photo_without_sidecar_does_not_adopt_a_stray_one() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.jpg", "A");
    write(dir.path(), "x.jpg.xmp", "autre");
    let plan = plan_batch(&[item(&a, "x")]);
    assert_eq!(failures(&plan.failed), vec![("a.jpg".to_string(), "sidecar_taken".to_string())]);
    assert!(plan.planned.is_empty());
}

#[test]
fn catalogue_row_keeps_its_id_and_follows_the_new_path() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.jpg", "A");
    let (outcome, _catalog, pool) = run(vec![item(&a, "nouveau")], false);
    assert_eq!(outcome.renamed.len(), 1);
    let conn = pool.get().unwrap();
    let (path, filename): (String, String) = conn.query_row("SELECT path, filename FROM photos", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!(filename, "nouveau.jpg");
    assert_eq!(Path::new(&path), dir.path().join("nouveau.jpg"));
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM photos", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 1);
}

#[test]
fn stop_requested_before_the_start_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.jpg", "A");
    let b = write(dir.path(), "b.jpg", "B");
    let (outcome, _catalog, _pool) = run(vec![item(&a, "x"), item(&b, "y")], true);
    assert_eq!(outcome.not_processed, 2);
    assert!(outcome.renamed.is_empty());
    assert_eq!(read(dir.path(), "a.jpg").as_deref(), Some("A"));
    assert_eq!(read(dir.path(), "b.jpg").as_deref(), Some("B"));
}

#[test]
fn undo_is_the_reverse_batch() {
    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.jpg", "A");
    let b = write(dir.path(), "b.jpg", "B");
    let (outcome, catalog, pool) = run(vec![item(&a, "b"), item(&b, "a")], false);
    assert_eq!(outcome.renamed.len(), 2);
    // Undo: each photo, now at its new path, takes back the name it had.
    let reverse: Vec<RenameItem> = outcome
        .renamed
        .iter()
        .map(|(from, to)| item(to, Path::new(from).file_stem().unwrap().to_str().unwrap()))
        .collect();
    let conn = pool.get().unwrap();
    let undone = execute(plan_batch(&reverse), &conn, &catalog.path().join("thumbnails"), &catalog.path().join("raw"), &mut TestHooks { cancelled: false });
    assert!(undone.failed.is_empty(), "{:?}", undone.failed);
    assert_eq!(read(dir.path(), "a.jpg").as_deref(), Some("A"));
    assert_eq!(read(dir.path(), "b.jpg").as_deref(), Some("B"));
}

#[test]
fn presets_are_saved_replaced_ignoring_case_and_deleted() {
    let (_dir, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let list = save_preset(&conn, "  Sony  ", "[]").unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "Sony");
    let list = save_preset(&conn, "sony", "[{\"type\":\"insert\"}]").unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "sony");
    assert_eq!(list[0].steps, "[{\"type\":\"insert\"}]");
    assert!(save_preset(&conn, "   ", "[]").is_err());
    assert!(save_preset(&conn, "x", "pas du json").is_err());
    let list = save_preset(&conn, "Autre", "[]").unwrap();
    assert_eq!(list.len(), 2);
    let list = delete_preset(&conn, list[0].id).unwrap();
    assert_eq!(list.len(), 1);
}

#[test]
fn swap_rollback_on_sidecar_failure_never_overwrites_the_other_photo() {
    struct SabotageParkedSidecar {
        dir: PathBuf,
        done: bool,
    }
    impl Hooks for SabotageParkedSidecar {
        fn cancelled(&self) -> bool { false }
        fn advance(&mut self, _size: u64) {
            if self.done { return; }
            self.done = true;
            // Remove the parked sidecar right after B takes A's name, so A's final sidecar rename fails.
            for entry in fs::read_dir(&self.dir).unwrap().flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(".photoboggan-rename-") && name.ends_with(".xmp") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let a = write(dir.path(), "a.jpg", "contenu A");
    write(dir.path(), "a.jpg.xmp", "xmp A");
    let b = write(dir.path(), "b.jpg", "contenu B");

    let items = vec![item(&a, "b"), item(&b, "a")];
    let (catalog_dir, pool) = temp_catalog();
    {
        let conn = pool.get().unwrap();
        for it in &items { insert_photo(&conn, &it.path); }
    }
    let conn = pool.get().unwrap();
    let mut hooks = SabotageParkedSidecar { dir: dir.path().to_path_buf(), done: false };
    let outcome = execute(plan_batch(&items), &conn, &catalog_dir.path().join("thumbnails"), &catalog_dir.path().join("raw"), &mut hooks);

    assert_eq!(outcome.renamed.len(), 1);
    assert_eq!(outcome.failed.len(), 1);
    // Photo B moved to a.jpg and was never overwritten by Photo A.
    assert_eq!(read(dir.path(), "a.jpg").as_deref(), Some("contenu B"));
    assert_eq!(read(dir.path(), "b.jpg"), None);

    // Photo A stayed intact at its parked temporary path.
    let parked_a: Vec<PathBuf> = fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.file_name().unwrap().to_string_lossy().starts_with(".photoboggan-rename-"))
        .collect();
    assert_eq!(parked_a.len(), 1, "expected parked photo A, found {parked_a:?}");
    assert_eq!(fs::read_to_string(&parked_a[0]).ok().as_deref(), Some("contenu A"));

    // Database paths match the files on disk.
    let mut db_paths: Vec<String> = Vec::new();
    let mut stmt = conn.prepare("SELECT path FROM photos ORDER BY path").unwrap();
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
    for row in rows { db_paths.push(row.unwrap()); }
    let mut expected = vec![dir.path().join("a.jpg").to_string_lossy().into_owned(), parked_a[0].to_string_lossy().into_owned()];
    expected.sort();
    db_paths.sort();
    assert_eq!(db_paths, expected);
}
