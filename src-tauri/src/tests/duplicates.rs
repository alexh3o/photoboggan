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
    Request { scope, compare_with_library, ignore_metadata, include_raw: true, threads: None }
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

// ---------------------------------------------------------------------------
// Image-data hash of one file, shared with the semantic scan (§6.4 of the semantic search spec)
// ---------------------------------------------------------------------------

#[test]
fn the_hash_of_one_file_ignores_metadata_and_is_shared_with_the_search_cache() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let original = jpeg_bytes(64, 48);
    let a = add(&pool, dir.path(), "a.jpg", &original);
    let b = add(&pool, dir.path(), "b.jpg", &with_segment(&original, 0xE1, b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>"));
    let c = add(&pool, dir.path(), "c.jpg", &jpeg_bytes(40, 30));
    let cancel = AtomicBool::new(false);
    let hash = |path: &str| image_data_hash(Path::new(path), &cancel).expect("hash");
    let (hash_a, hash_b) = (hash(&a), hash(&b));
    assert!(hash_a.tolerant);
    assert_eq!(hash_a.hash, hash_b.hash, "metadata left out");
    assert_eq!(hash_a.data_len, hash_b.data_len);
    assert_ne!(hash_a.size, hash_b.size);
    assert_ne!(hash_a.hash, hash(&c).hash);
    // Formats without a parser are hashed whole; videos are never hashed.
    let gif = add(&pool, dir.path(), "d.gif", b"GIF89a not really a gif");
    assert!(!hash(&gif).tolerant);
    assert!(is_video(Path::new("clip.MOV")) && !is_video(Path::new("a.jpg")));

    // Stored by another feature, read back for the same ids; a duplicate search then reuses it, keeps it and adds its partial hash.
    let conn = pool.get().unwrap();
    let id_of = |path: &str| -> i64 { conn.query_row("SELECT id FROM photos WHERE path = ?1", [path], |row| row.get(0)).unwrap() };
    remember_data_hash(&conn, id_of(&a), &hash_a).unwrap();
    let cached = cached_data_hashes(&conn, &[id_of(&a), id_of(&b)]).unwrap();
    assert_eq!((cached.len(), cached[&id_of(&a)]), (1, hash_a));
    let report = search(&pool, &request(Scope::All, false, true));
    assert_eq!(report.groups, vec![vec![a.clone(), b.clone()]]);
    let partial: Option<Vec<u8>> = conn.query_row("SELECT partial_hash FROM photo_hashes WHERE photo_id = ?1 AND mode = 1", [id_of(&a)], |row| row.get(0)).unwrap();
    assert!(partial.is_some());
    assert_eq!(cached_data_hashes(&conn, &[id_of(&b)]).unwrap()[&id_of(&b)].hash, hash_a.hash, "computed by the search, readable by the scan");
    // Stored again for the same file version: the partial hash is kept; for another version it is cleared.
    remember_data_hash(&conn, id_of(&a), &hash_a).unwrap();
    let partial_after = |conn: &rusqlite::Connection| -> Option<Vec<u8>> {
        conn.query_row("SELECT partial_hash FROM photo_hashes WHERE photo_id = ?1 AND mode = 1", [id_of(&a)], |row| row.get(0)).unwrap()
    };
    assert_eq!(partial_after(&conn), partial);
    remember_data_hash(&conn, id_of(&a), &DataHash { modified: hash_a.modified + 1, ..hash_a }).unwrap();
    assert_eq!(partial_after(&conn), None);
}

#[test]
fn include_raw_filters_out_raw_files_when_disabled() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let jpg_a = add(&pool, dir.path(), "a.jpg", &jpeg_bytes(40, 30));
    let jpg_b = add(&pool, dir.path(), "b.jpg", &jpeg_bytes(40, 30));
    let raw_bytes = b"not-real-raw-but-identical";
    let raw_a = add(&pool, dir.path(), "a.cr2", raw_bytes);
    let raw_b = add(&pool, dir.path(), "b.cr2", raw_bytes);

    let without_raw = search(&pool, &Request { include_raw: false, ..request(Scope::All, false, true) });
    assert_eq!(without_raw.groups, vec![vec![jpg_a.clone(), jpg_b.clone()]]);

    let with_raw = search(&pool, &Request { include_raw: true, ..request(Scope::All, false, true) });
    assert_eq!(with_raw.groups.len(), 2);
    assert!(with_raw.groups.iter().any(|g| g == &vec![raw_a.clone(), raw_b.clone()]));
}

#[test]
fn failures_are_recorded_logged_and_skipped_on_rerun() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let thumbs = tempfile::tempdir().unwrap();
    let base = tempfile::tempdir().unwrap();
    let good = add(&pool, dir.path(), "good.jpg", &jpeg_bytes(32, 32));
    let bad_s = add(&pool, dir.path(), "bad.jpg", b"not-a-jpeg");
    {
        let conn = pool.get().unwrap();
        for p in [&good, &bad_s] {
            let meta = fs::metadata(p).unwrap();
            let modified = meta.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
            conn.execute("UPDATE photos SET file_size = ?1, modified = ?2 WHERE path = ?3", rusqlite::params![meta.len() as i64, modified, p]).unwrap();
        }
    }

    let mode = crate::hash_tasks::PrecomputeMode::parse("similarity").unwrap();
    let report = crate::hash_tasks::run_precompute(
        &pool,
        thumbs.path(),
        Some(base.path()),
        mode,
        false,
        None,
        Some("1"),
        &AtomicBool::new(false),
        &|_| {},
    )
    .expect("precompute");
    assert_eq!(report.failures_total, 1);
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.failures[0].path, bad_s);
    let log_path = report.log_path.as_ref().expect("log file written");
    assert!(Path::new(log_path).exists());

    // Second run skips the recorded failed file instead of failing again.
    let report2 = crate::hash_tasks::run_precompute(
        &pool,
        thumbs.path(),
        Some(base.path()),
        mode,
        false,
        None,
        Some("1"),
        &AtomicBool::new(false),
        &|_| {},
    )
    .expect("rerun");
    assert_eq!(report2.failures_total, 0);
    assert!(report2.log_path.is_none());

    // An exact-hash failure recorded in `photo_hash_failures` is also skipped by `exact_prepass`.
    {
        let conn = pool.get().unwrap();
        let bad_id: i64 = conn.query_row("SELECT id FROM photos WHERE path = ?1", [&bad_s], |r| r.get(0)).unwrap();
        let meta = fs::metadata(&bad_s).unwrap();
        let modified = meta.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        save_hash_failure(&conn, bad_id, 1, meta.len(), modified, "unreadable").unwrap();
    }
    let exact_mode = crate::hash_tasks::PrecomputeMode::parse("exact_prepass").unwrap();
    let report3 = crate::hash_tasks::run_precompute(
        &pool,
        thumbs.path(),
        Some(base.path()),
        exact_mode,
        false,
        None,
        Some("1"),
        &AtomicBool::new(false),
        &|_| {},
    )
    .expect("exact precompute");
    assert_eq!((report3.computed, report3.failures_total), (1, 0));
}

#[test]
fn image_data_hash_from_jpeg_bytes_matches_file_hash() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = with_segment(&jpeg_bytes(48, 36), 0xE1, b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>");
    let path = dir.path().join("photo.jpg");
    fs::write(&path, &bytes).unwrap();
    let from_file = image_data_hash(&path, &AtomicBool::new(false)).expect("file hash");
    let from_mem = image_data_hash_from_jpeg_bytes(&bytes, from_file.size, from_file.modified)
        .expect("mem hash");
    assert_eq!(from_file.hash, from_mem.hash);
    assert_eq!(from_file.data_len, from_mem.data_len);
    assert_eq!(from_file.tolerant, from_mem.tolerant);
}

#[test]
fn restamp_photo_caches_preserves_uptodate_entries_and_leaves_expired_untouched() {
    let (_catalog, pool) = temp_catalog();
    let conn = pool.get().unwrap();
    let id_ok = insert_photo(&conn, "C:/photos/ok.jpg");
    let id_expired = insert_photo(&conn, "C:/photos/expired.jpg");
    let id_strict = insert_photo(&conn, "C:/photos/strict.jpg");

    conn.execute("UPDATE photos SET file_size = 1000, modified = 2000 WHERE id = ?1", rusqlite::params![id_ok]).unwrap();
    conn.execute("UPDATE photos SET file_size = 1000, modified = 2000 WHERE id = ?1", rusqlite::params![id_expired]).unwrap();
    conn.execute("UPDATE photos SET file_size = 1000, modified = 2000 WHERE id = ?1", rusqlite::params![id_strict]).unwrap();

    // Up-to-date entries for id_ok (mode=1 tolerant=1, phash, embedding).
    conn.execute(
        "INSERT INTO photo_hashes (photo_id, mode, version, size, modified, tolerant, data_len) VALUES (?1, 1, ?2, 1000, 2000, 1, 900)",
        rusqlite::params![id_ok, LAYOUT_VERSION],
    ).unwrap();
    conn.execute(
        "INSERT INTO photo_phash (photo_id, size, modified, algo, flat, hashes) VALUES (?1, 1000, 2000, ?2, 0, ?3)",
        rusqlite::params![id_ok, crate::phash::ALGO_VERSION, vec![0u8; 64]],
    ).unwrap();
    conn.execute(
        "INSERT INTO photo_embeddings (photo_id, model_id, file_size, file_mtime, vec) VALUES (?1, 'siglip2', 1000, 2000, X'00000000')",
        rusqlite::params![id_ok],
    ).unwrap();

    // Already-expired entry for id_expired (size = 999 != 1000).
    conn.execute(
        "INSERT INTO photo_hashes (photo_id, mode, version, size, modified, tolerant, data_len) VALUES (?1, 1, ?2, 999, 2000, 1, 900)",
        rusqlite::params![id_expired, LAYOUT_VERSION],
    ).unwrap();

    // mode=0 entry for id_strict must not be restamped.
    conn.execute(
        "INSERT INTO photo_hashes (photo_id, mode, version, size, modified, tolerant, data_len) VALUES (?1, 0, ?2, 1000, 2000, 1, 1000)",
        rusqlite::params![id_strict, LAYOUT_VERSION],
    ).unwrap();

    crate::restamp_photo_caches(&conn, id_ok, 1000, 2000, 1050, 3000);
    crate::restamp_photo_caches(&conn, id_expired, 1000, 2000, 1050, 3000);
    crate::restamp_photo_caches(&conn, id_strict, 1000, 2000, 1050, 3000);

    let (h_size, h_mod): (i64, i64) = conn
        .query_row("SELECT size, modified FROM photo_hashes WHERE photo_id = ?1 AND mode = 1", rusqlite::params![id_ok], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!((h_size, h_mod), (1050, 3000));
    let (p_size, p_mod): (i64, i64) = conn
        .query_row("SELECT size, modified FROM photo_phash WHERE photo_id = ?1", rusqlite::params![id_ok], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!((p_size, p_mod), (1050, 3000));
    let (e_size, e_mod): (i64, i64) = conn
        .query_row("SELECT file_size, file_mtime FROM photo_embeddings WHERE photo_id = ?1", rusqlite::params![id_ok], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!((e_size, e_mod), (1050, 3000));

    let exp_size: i64 = conn
        .query_row("SELECT size FROM photo_hashes WHERE photo_id = ?1 AND mode = 1", rusqlite::params![id_expired], |r| r.get(0))
        .unwrap();
    assert_eq!(exp_size, 999);
    let strict_size: i64 = conn
        .query_row("SELECT size FROM photo_hashes WHERE photo_id = ?1 AND mode = 0", rusqlite::params![id_strict], |r| r.get(0))
        .unwrap();
    assert_eq!(strict_size, 1000);
}

#[test]
fn hash_tasks_precompute_stats_work_count_states_and_delete() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let thumbs = tempfile::tempdir().unwrap();
    let base = tempfile::tempdir().unwrap();
    let jpg = add(&pool, dir.path(), "a.jpg", &jpeg_bytes(64, 48));
    let raw = add(&pool, dir.path(), "b.cr2", b"synthetic-raw");
    {
        let conn = pool.get().unwrap();
        for p in [&jpg, &raw] {
            let meta = fs::metadata(p).unwrap();
            let modified = meta.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
            conn.execute("UPDATE photos SET file_size = ?1, modified = ?2 WHERE path = ?3", rusqlite::params![meta.len() as i64, modified, p]).unwrap();
        }
    }

    let work_before = crate::hash_tasks::compute_work_count(&pool.get().unwrap(), Some(thumbs.path()), "identical", &Scope::All, false, true, true, false).unwrap();
    assert_eq!((work_before.total, work_before.missing, work_before.missing_raw), (2, 2, 1));

    // Pre-pass only, excluding RAW.
    let mode_prepass = crate::hash_tasks::PrecomputeMode::parse("exact_prepass").unwrap();
    let rep1 = crate::hash_tasks::run_precompute(&pool, thumbs.path(), Some(base.path()), mode_prepass, false, None, Some("1"), &AtomicBool::new(false), &|_| {}).unwrap();
    assert_eq!((rep1.computed, rep1.failures_total), (1, 0));

    let states1 = crate::hash_tasks::exact_hash_states(&pool.get().unwrap()).unwrap();
    assert_eq!((states1.prepass.len(), states1.full.len()), (1, 0));

    // Full exact pass, including RAW (both succeed).
    let mode_full = crate::hash_tasks::PrecomputeMode::parse("exact_full").unwrap();
    let rep2 = crate::hash_tasks::run_precompute(&pool, thumbs.path(), Some(base.path()), mode_full, true, None, Some("1"), &AtomicBool::new(false), &|_| {}).unwrap();
    assert_eq!((rep2.computed, rep2.failures_total), (2, 0));

    let states2 = crate::hash_tasks::exact_hash_states(&pool.get().unwrap()).unwrap();
    assert_eq!((states2.prepass.len(), states2.full.len(), states2.expired.len()), (0, 2, 0));

    // Marking one photo's file_size stale moves it into `expired`.
    {
        let conn = pool.get().unwrap();
        conn.execute("UPDATE photos SET file_size = file_size + 1 WHERE path = ?1", rusqlite::params![&raw]).unwrap();
        let states_exp = crate::hash_tasks::exact_hash_states(&conn).unwrap();
        assert_eq!((states_exp.prepass.len(), states_exp.full.len(), states_exp.expired.len()), (0, 1, 1));
        conn.execute("UPDATE photos SET file_size = file_size - 1 WHERE path = ?1", rusqlite::params![&raw]).unwrap();
    }

    // Similarity pass excluding RAW (a.jpg succeeds).
    let mode_sim = crate::hash_tasks::PrecomputeMode::parse("similarity").unwrap();
    let rep3 = crate::hash_tasks::run_precompute(&pool, thumbs.path(), Some(base.path()), mode_sim, false, None, Some("1"), &AtomicBool::new(false), &|_| {}).unwrap();
    assert_eq!((rep3.computed, rep3.failures_total), (1, 0));

    let stats = crate::hash_tasks::compute_duplicate_hash_stats(&pool.get().unwrap()).unwrap();
    assert_eq!(stats.exact_prepass.up_to_date, 2);
    assert_eq!(stats.exact_full.up_to_date, 2);
    assert_eq!(stats.similarity.up_to_date, 1);
    assert!(stats.bytes > 0);

    crate::hash_tasks::delete_all_hashes(&pool.get().unwrap()).unwrap();
    let stats_after = crate::hash_tasks::compute_duplicate_hash_stats(&pool.get().unwrap()).unwrap();
    assert_eq!((stats_after.exact_prepass.up_to_date, stats_after.exact_full.up_to_date, stats_after.similarity.up_to_date), (0, 0, 0));
}
