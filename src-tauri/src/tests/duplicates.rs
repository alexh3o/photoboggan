//! Tests of the identical-image search: metadata-insensitive hashing, scopes, cache and cancellation. Synthetic files in a temporary folder only.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use super::*;
use crate::test_support::{insert_photo, jpeg_bytes, png_bytes, temp_catalog, with_segment};

fn no_progress(_: f64) {}

/// Writes a file and registers it in the catalog; returns its path.
fn add(pool: &DbPool, dir: &Path, name: &str, bytes: &[u8]) -> String {
    let path: PathBuf = dir.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    let path = path.to_string_lossy().into_owned();
    insert_photo(&pool.get().unwrap(), &path);
    path
}

fn request(scope: Scope, compare_with_library: bool, ignore_metadata: bool) -> Request {
    Request { scope, compare_with_library, ignore_metadata }
}

fn search(pool: &DbPool, request: &Request) -> Report {
    run(pool, request, &AtomicBool::new(false), &no_progress).expect("search")
}

/// Inserts a PNG chunk (CRC included) just before IEND.
fn png_with_chunk(png: &[u8], kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let iend = png.len() - 12;
    let mut crc_input = kind.to_vec();
    crc_input.extend_from_slice(data);
    let mut crc: u32 = 0xFFFF_FFFF;
    for byte in &crc_input {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    let mut out = png[..iend].to_vec();
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&(!crc).to_be_bytes());
    out.extend_from_slice(&png[iend..]);
    out
}

#[test]
fn jpeg_copies_with_different_metadata_are_identical() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let original = jpeg_bytes(64, 48);
    let tagged = with_segment(&original, 0xE1, b"Exif\0\0some metadata that changes the file size");
    let a = add(&pool, dir.path(), "a.jpg", &original);
    let b = add(&pool, dir.path(), "b.jpg", &tagged);
    add(&pool, dir.path(), "other.jpg", &jpeg_bytes(40, 30));

    let report = search(&pool, &request(Scope::All, false, true));
    assert_eq!(report.groups, vec![vec![a.clone(), b.clone()]]);

    // Metadata taken into account: the two files differ.
    let strict = search(&pool, &request(Scope::All, false, false));
    assert!(strict.groups.is_empty());
}

#[test]
fn byte_identical_copies_are_found_in_both_modes() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let bytes = jpeg_bytes(64, 48);
    let a = add(&pool, dir.path(), "a.jpg", &bytes);
    let b = add(&pool, dir.path(), "copy/b.jpg", &bytes);
    for ignore in [true, false] {
        assert_eq!(search(&pool, &request(Scope::All, false, ignore)).groups, vec![vec![a.clone(), b.clone()]]);
    }
}

#[test]
fn png_text_chunks_are_ignored() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let original = png_bytes(16, 16);
    let tagged = png_with_chunk(&original, b"tEXt", b"Comment\0written later");
    let a = add(&pool, dir.path(), "a.png", &original);
    let b = add(&pool, dir.path(), "b.png", &tagged);
    assert_eq!(search(&pool, &request(Scope::All, false, true)).groups, vec![vec![a, b]]);
}

#[test]
fn formats_without_metadata_tolerance_are_reported() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    add(&pool, dir.path(), "a.bmp", b"same bytes, not an image the parser knows");
    add(&pool, dir.path(), "b.bmp", b"same bytes, not an image the parser knows");
    let report = search(&pool, &request(Scope::All, false, true));
    assert_eq!(report.groups.len(), 1);
    assert_eq!(report.whole_file_extensions, vec!["bmp".to_string()]);
}

#[test]
fn different_images_of_the_same_length_are_not_grouped() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    // Same length, different content: only the hash stages can tell them apart.
    add(&pool, dir.path(), "a.bmp", &[1u8; 200_000]);
    add(&pool, dir.path(), "b.bmp", &[2u8; 200_000]);
    let mut changed_in_the_middle = vec![1u8; 200_000];
    changed_in_the_middle[100_000] = 9;
    add(&pool, dir.path(), "c.bmp", &changed_in_the_middle);
    assert!(search(&pool, &request(Scope::All, false, false)).groups.is_empty());
}

#[test]
fn scope_and_library_comparison() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let bytes = jpeg_bytes(64, 48);
    let inside = add(&pool, dir.path(), "album/a.jpg", &bytes);
    let outside = add(&pool, dir.path(), "other/a.jpg", &bytes);
    let folder = Scope::Folder { path: dir.path().join("album").to_string_lossy().into_owned(), recursive: true };

    // Inside the folder only: nothing to compare with.
    assert!(search(&pool, &request(folder.clone(), false, true)).groups.is_empty());
    // With the library: the copy outside the folder is found.
    assert_eq!(search(&pool, &request(folder, true, true)).groups, vec![vec![inside.clone(), outside.clone()]]);
    // A single photo is looked up in the library.
    let single = Scope::Paths { paths: vec![inside.clone()] };
    assert_eq!(search(&pool, &request(single, true, true)).groups, vec![vec![inside, outside]]);
}

#[test]
fn groups_made_only_of_library_photos_are_dropped() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let bytes = jpeg_bytes(64, 48);
    add(&pool, dir.path(), "x/a.jpg", &bytes);
    add(&pool, dir.path(), "x/b.jpg", &bytes);
    let lone = add(&pool, dir.path(), "y/c.jpg", &jpeg_bytes(30, 30));
    let scope = Scope::Paths { paths: vec![lone] };
    assert!(search(&pool, &request(scope, true, true)).groups.is_empty());
}

#[test]
fn non_recursive_folder_scope_skips_subfolders() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let bytes = jpeg_bytes(64, 48);
    add(&pool, dir.path(), "top/a.jpg", &bytes);
    add(&pool, dir.path(), "top/sub/b.jpg", &bytes);
    let top = dir.path().join("top").to_string_lossy().into_owned();
    assert!(search(&pool, &request(Scope::Folder { path: top.clone(), recursive: false }, false, true)).groups.is_empty());
    assert_eq!(search(&pool, &request(Scope::Folder { path: top, recursive: true }, false, true)).groups.len(), 1);
}

#[test]
fn cache_is_reused_and_invalidated_when_a_file_changes() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let bytes = jpeg_bytes(64, 48);
    let a = add(&pool, dir.path(), "a.jpg", &bytes);
    let b = add(&pool, dir.path(), "b.jpg", &bytes);
    let all = request(Scope::All, false, true);
    assert_eq!(search(&pool, &all).groups.len(), 1);
    let rows: i64 = pool.get().unwrap().query_row("SELECT COUNT(*) FROM photo_hashes WHERE full_hash IS NOT NULL", [], |row| row.get(0)).unwrap();
    assert_eq!(rows, 2);
    // Unchanged files: same answer, same rows.
    assert_eq!(search(&pool, &all).groups.len(), 1);

    // b is replaced by another image (different size): the cached hash must not be used.
    fs::write(&b, jpeg_bytes(80, 60)).unwrap();
    assert!(search(&pool, &all).groups.is_empty());
    assert!(Path::new(&a).exists());
}

#[test]
fn cancelled_search_returns_no_group() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let bytes = jpeg_bytes(64, 48);
    add(&pool, dir.path(), "a.jpg", &bytes);
    add(&pool, dir.path(), "b.jpg", &bytes);
    let cancel = AtomicBool::new(true);
    let report = run(&pool, &request(Scope::All, false, true), &cancel, &no_progress).unwrap();
    assert!(report.cancelled);
    assert!(report.groups.is_empty());
}

#[test]
fn videos_and_unreadable_files_are_skipped() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    add(&pool, dir.path(), "a.mp4", b"video bytes");
    add(&pool, dir.path(), "b.mp4", b"video bytes");
    insert_photo(&pool.get().unwrap(), &dir.path().join("missing.jpg").to_string_lossy());
    let report = search(&pool, &request(Scope::All, false, true));
    assert!(report.groups.is_empty());
    assert_eq!(report.unreadable, 1);
}

#[test]
fn folder_and_selection_scopes_accept_any_separator_style() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let bytes = jpeg_bytes(64, 48);
    let root = dir.path().to_string_lossy().into_owned();
    // The catalog can hold mixed separators (a tracked folder joined with the names the scan found).
    let a = add(&pool, dir.path(), "album/a.jpg", &bytes);
    let b = add(&pool, dir.path(), "album/sub/b.jpg", &bytes);
    let slashed = root.replace('\\', "/");
    for folder in [format!("{root}\\album"), format!("{slashed}/album"), format!("{slashed}/album/")] {
        let report = search(&pool, &request(Scope::Folder { path: folder.clone(), recursive: true }, false, true));
        assert_eq!(report.groups.len(), 1, "folder {folder}");
        assert_eq!(report.scanned, 2, "folder {folder}");
    }
    // A selection of two photos compares them with each other.
    let both = search(&pool, &request(Scope::Paths { paths: vec![a.clone(), b.clone()] }, false, true));
    assert_eq!(both.groups, vec![vec![a, b]]);
}

#[test]
fn name_candidates_list_the_scope_then_the_library() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let inside = add(&pool, dir.path(), "album/a.jpg", b"x");
    let outside = add(&pool, dir.path(), "other/b.jpg", b"y");
    add(&pool, dir.path(), "other/clip.mp4", b"video");
    pool.get().unwrap().execute("UPDATE photos SET date_taken = '2024-05-04 12:00:00' WHERE path = ?1", [&inside]).unwrap();
    let folder = Scope::Folder { path: dir.path().join("album").to_string_lossy().into_owned(), recursive: true };

    let scoped = name_candidates(&pool, &folder, false).unwrap();
    assert_eq!(scoped, vec![(inside.clone(), "2024-05-04 12:00:00".to_string(), true)]);
    let mut with_library = name_candidates(&pool, &folder, true).unwrap();
    with_library.sort();
    // The video is left out; the photo outside the folder is there, flagged as not in the scope.
    assert_eq!(with_library.len(), 2);
    assert!(with_library.contains(&(outside, String::new(), false)));
}
