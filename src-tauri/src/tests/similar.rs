//! Tests of the similar-image search: grouping, rotations, bursts, flat pictures, cache and cancellation. Synthetic files in a temporary folder only.

use std::path::Path;

use super::*;
use crate::duplicates::Report;
use crate::test_support::{blobs_rgb, insert_photo, jpeg_from_rgb, rotate_quarter, temp_catalog};

fn settings(scope: Scope) -> Request {
    Request { scope, compare_with_library: false, max_distance: 6, rotations: false, ignore_bursts: false, burst_ms: 1000, include_raw_pairs: false }
}

fn search(pool: &DbPool, dir: &Path, request: &Request) -> Report {
    run(pool, dir, request, &AtomicBool::new(false), &|_| {}).expect("search")
}

/// Writes a blobs JPEG and registers it in the catalog; returns its path.
fn add_picture(pool: &DbPool, dir: &Path, name: &str, width: usize, height: usize, seed: u64) -> String {
    let path = dir.join(name).to_string_lossy().into_owned();
    std::fs::write(&path, jpeg_from_rgb(&blobs_rgb(width, height, seed), width, height, 85)).unwrap();
    insert_photo(&pool.get().unwrap(), &path);
    path
}

fn set_time(pool: &DbPool, path: &str, time: &str) {
    pool.get().unwrap().execute("UPDATE photos SET date_taken = ?1 WHERE path = ?2", params![time, path]).unwrap();
}

#[test]
fn resized_copies_are_grouped_and_other_pictures_are_not() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let thumbs = tempfile::tempdir().unwrap();
    let a = add_picture(&pool, dir.path(), "a.jpg", 400, 300, 1);
    let small = add_picture(&pool, dir.path(), "a_small.jpg", 100, 75, 1);
    add_picture(&pool, dir.path(), "b.jpg", 400, 300, 2);
    add_picture(&pool, dir.path(), "c.jpg", 400, 300, 3);
    let report = search(&pool, thumbs.path(), &settings(Scope::All));
    assert_eq!(report.groups, vec![vec![a, small]]);
}

#[test]
fn rotated_copies_need_the_rotation_option() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let thumbs = tempfile::tempdir().unwrap();
    let a = add_picture(&pool, dir.path(), "a.jpg", 200, 150, 7);
    let rotated = dir.path().join("a_turned.jpg").to_string_lossy().into_owned();
    std::fs::write(&rotated, jpeg_from_rgb(&rotate_quarter(&blobs_rgb(200, 150, 7), 200, 150), 150, 200, 85)).unwrap();
    insert_photo(&pool.get().unwrap(), &rotated);

    assert!(search(&pool, thumbs.path(), &settings(Scope::All)).groups.is_empty());
    let mut tolerant = settings(Scope::All);
    tolerant.rotations = true;
    assert_eq!(search(&pool, thumbs.path(), &tolerant).groups, vec![vec![a, rotated]]);
}

#[test]
fn flat_pictures_are_never_grouped() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let thumbs = tempfile::tempdir().unwrap();
    for name in ["black1.jpg", "black2.jpg"] {
        let path = dir.path().join(name).to_string_lossy().into_owned();
        std::fs::write(&path, jpeg_from_rgb(&vec![0u8; 64 * 64 * 3], 64, 64, 90)).unwrap();
        insert_photo(&pool.get().unwrap(), &path);
    }
    assert!(search(&pool, thumbs.path(), &settings(Scope::All)).groups.is_empty());
}

#[test]
fn bursts_are_left_out_but_copies_with_the_same_time_are_kept() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let thumbs = tempfile::tempdir().unwrap();
    let a = add_picture(&pool, dir.path(), "a.jpg", 300, 200, 4);
    let b = add_picture(&pool, dir.path(), "b.jpg", 150, 100, 4);
    set_time(&pool, &a, "2024-05-04 12:00:00");
    let mut request = settings(Scope::All);
    request.ignore_bursts = true;
    request.burst_ms = 2000;

    // Same instant: a copy, not a burst.
    set_time(&pool, &b, "2024-05-04 12:00:00");
    assert_eq!(search(&pool, thumbs.path(), &request).groups.len(), 1);
    // One second apart, window of two seconds: a burst, left out.
    set_time(&pool, &b, "2024-05-04 12:00:01");
    assert!(search(&pool, thumbs.path(), &request).groups.is_empty());
    // Same gap but a window of 500 ms: too far apart to be a burst.
    request.burst_ms = 500;
    assert_eq!(search(&pool, thumbs.path(), &request).groups.len(), 1);
    // Bursts allowed again.
    request.burst_ms = 2000;
    request.ignore_bursts = false;
    set_time(&pool, &b, "2024-05-04 12:00:01");
    assert_eq!(search(&pool, thumbs.path(), &request).groups.len(), 1);
    // No date at all: nothing says it is a burst.
    set_time(&pool, &b, "");
    request.ignore_bursts = true;
    assert_eq!(search(&pool, thumbs.path(), &request).groups.len(), 1);
}

#[test]
fn a_selection_is_compared_with_the_library_only_when_asked() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let thumbs = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("new")).unwrap();
    std::fs::create_dir_all(dir.path().join("old")).unwrap();
    let new = add_picture(&pool, dir.path(), "new/a.jpg", 200, 150, 9);
    let old = add_picture(&pool, dir.path(), "old/a.jpg", 100, 75, 9);
    let scope = Scope::Paths { paths: vec![new.clone()] };
    assert!(search(&pool, thumbs.path(), &settings(scope.clone())).groups.is_empty());
    let mut request = settings(scope);
    request.compare_with_library = true;
    assert_eq!(search(&pool, thumbs.path(), &request).groups, vec![vec![new, old]]);
}

#[test]
fn fingerprints_are_cached_and_unsupported_formats_counted() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let thumbs = tempfile::tempdir().unwrap();
    add_picture(&pool, dir.path(), "a.jpg", 200, 150, 1);
    add_picture(&pool, dir.path(), "b.jpg", 200, 150, 2);
    let gif = dir.path().join("c.gif").to_string_lossy().into_owned();
    std::fs::write(&gif, b"GIF89a").unwrap();
    insert_photo(&pool.get().unwrap(), &gif);
    let report = search(&pool, thumbs.path(), &settings(Scope::All));
    assert_eq!(report.unsupported, 1);
    assert_eq!(report.scanned, 2);
    let rows: i64 = pool.get().unwrap().query_row("SELECT COUNT(*) FROM photo_phash", [], |row| row.get(0)).unwrap();
    assert_eq!(rows, 2);
    assert_eq!(search(&pool, thumbs.path(), &settings(Scope::All)).scanned, 2);
}

#[test]
fn a_loose_threshold_chains_everything_into_one_group_or_drops_it() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let thumbs = tempfile::tempdir().unwrap();
    for n in 0..4 {
        add_picture(&pool, dir.path(), &format!("p{n}.jpg"), 100 + n * 10, 75 + n * 7, 1);
    }
    let mut request = settings(Scope::All);
    request.max_distance = 64;
    let report = search(&pool, thumbs.path(), &request);
    assert_eq!(report.groups.len() + report.skipped_groups, 1);
}

#[test]
fn cancelled_search_returns_no_group() {
    let (_catalog, pool) = temp_catalog();
    let dir = tempfile::tempdir().unwrap();
    let thumbs = tempfile::tempdir().unwrap();
    add_picture(&pool, dir.path(), "a.jpg", 200, 150, 1);
    add_picture(&pool, dir.path(), "b.jpg", 100, 75, 1);
    let report = run(&pool, thumbs.path(), &settings(Scope::All), &AtomicBool::new(true), &|_| {}).unwrap();
    assert!(report.cancelled);
    assert!(report.groups.is_empty());
}
