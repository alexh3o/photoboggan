//! Tests de main.rs : cache des miniatures et des aperçus après une écriture de métadonnées (keep_cached_images).
//! Fichiers synthétiques dans un dossier temporaire ; aucune écriture de métadonnées réelle (le contenu du fichier est simplement modifié).

use super::*;
use crate::test_support::*;

fn cache_dirs(root: &Path) -> ImageCacheDirs {
    let dirs = ImageCacheDirs { thumbnails: root.join("thumbnails"), raw_previews: root.join("raw_previews") };
    fs::create_dir_all(&dirs.thumbnails).unwrap();
    fs::create_dir_all(&dirs.raw_previews).unwrap();
    dirs
}

// Écrit un fichier de cache de test : le sous-dossier de répartition est créé comme le fait l'application à l'écriture.
fn put(file: &Path, bytes: &[u8]) {
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, bytes).unwrap();
}

#[test]
fn cache_files_are_spread_over_subfolders_and_listed_recursively() {
    let dir = tempfile::tempdir().unwrap();
    let dirs = cache_dirs(dir.path());
    let mut subfolders = std::collections::HashSet::new();
    for index in 0..40 {
        let photo = dir.path().join(format!("p{index}.jpg"));
        fs::write(&photo, jpeg_bytes(16, 16 + index)).unwrap();
        let cache = thumbnail_cache_file(&dirs.thumbnails, &photo.to_string_lossy()).unwrap();
        assert_eq!(cache.parent().unwrap().parent().unwrap(), dirs.thumbnails, "un seul niveau de sous-dossier");
        let folder = cache.parent().unwrap().file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(folder.len(), 2);
        assert!(cache.file_name().unwrap().to_string_lossy().starts_with(&folder), "le sous-dossier est le préfixe du nom");
        subfolders.insert(folder);
        put(&cache, b"miniature");
    }
    assert!(subfolders.len() > 5, "la répartition utilise plusieurs sous-dossiers");
    assert_eq!(cache_files(&dirs.thumbnails).len(), 40);
}

#[test]
fn clearing_the_cache_removes_files_in_subfolders() {
    let dir = tempfile::tempdir().unwrap();
    let dirs = cache_dirs(dir.path());
    let photo = dir.path().join("a.jpg");
    fs::write(&photo, jpeg_bytes(16, 16)).unwrap();
    let cache = thumbnail_cache_file(&dirs.thumbnails, &photo.to_string_lossy()).unwrap();
    put(&cache, b"miniature");
    for path in cache_files(&dirs.thumbnails) { fs::remove_file(path).unwrap(); }
    remove_empty_cache_subdirs(&dirs.thumbnails);
    assert!(cache_files(&dirs.thumbnails).is_empty());
    assert_eq!(fs::read_dir(&dirs.thumbnails).unwrap().count(), 0, "sous-dossiers vides retirés");
}

#[test]
fn cached_images_follow_a_rewritten_file() {
    let dir = tempfile::tempdir().unwrap();
    let dirs = cache_dirs(dir.path());
    let photo = dir.path().join("a.jpg");
    fs::write(&photo, jpeg_bytes(16, 16)).unwrap();
    let path = photo.to_string_lossy().to_string();
    let old_thumbnail = thumbnail_cache_file(&dirs.thumbnails, &path).unwrap();
    let old_preview = raw_preview_cache_file(&dirs.raw_previews, &path).unwrap();
    put(&old_thumbnail, b"miniature");
    put(&old_preview, b"apercu");

    // Écriture de métadonnées simulée : le fichier change de taille (et de date), donc de nom de cache.
    keep_cached_images(&dirs, &path, || fs::write(&photo, [jpeg_bytes(16, 16), b"xmp".to_vec()].concat()).map_err(|e| e.to_string())).unwrap();

    let new_thumbnail = thumbnail_cache_file(&dirs.thumbnails, &path).unwrap();
    assert_ne!(new_thumbnail, old_thumbnail, "le nom de cache dépend de la taille et de la date");
    assert_eq!(fs::read(&new_thumbnail).unwrap(), b"miniature", "miniature reprise, pas à régénérer");
    assert!(!old_thumbnail.exists(), "ancienne miniature renommée, pas laissée orpheline");
    assert_eq!(fs::read(raw_preview_cache_file(&dirs.raw_previews, &path).unwrap()).unwrap(), b"apercu");
    assert!(!old_preview.exists());
}

#[test]
fn cached_images_are_kept_when_the_file_does_not_change_or_the_write_fails() {
    let dir = tempfile::tempdir().unwrap();
    let dirs = cache_dirs(dir.path());
    let photo = dir.path().join("b.cr2");
    fs::write(&photo, b"II*\0 faux raw").unwrap();
    let path = photo.to_string_lossy().to_string();
    let thumbnail = thumbnail_cache_file(&dirs.thumbnails, &path).unwrap();
    put(&thumbnail, b"miniature");

    // RAW : seul le sidecar est écrit, le fichier ne change pas : la miniature ne doit surtout pas être supprimée.
    keep_cached_images(&dirs, &path, || fs::write(dir.path().join("b.cr2.xmp"), b"<x/>").map_err(|e| e.to_string())).unwrap();
    assert_eq!(fs::read(&thumbnail).unwrap(), b"miniature");

    // Échec d'écriture : l'erreur remonte et le cache n'est pas touché.
    let error = keep_cached_images(&dirs, &path, || Err::<(), _>("refusé".to_string())).unwrap_err();
    assert_eq!(error, "refusé");
    assert_eq!(fs::read(&thumbnail).unwrap(), b"miniature");
}

// --- Durable copies (copy_durably, copy_replacing, copy_sidecar) ---
// Whether data really reaches the disk cannot be checked without cutting the power: these tests check that the flush keeps content,
// attributes and dates, and leaves nothing behind.

#[test]
fn durable_copy_of_a_read_only_photo_keeps_its_content_attribute_and_date() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("card.jpg");
    put(&source, b"photo from a memory card");
    let mut permissions = fs::metadata(&source).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&source, permissions).unwrap();
    let target = dir.path().join("copy.jpg");
    assert_eq!(copy_durably(&source, &target).unwrap(), 24);
    assert_eq!(fs::read(&target).unwrap(), b"photo from a memory card");
    assert!(fs::metadata(&target).unwrap().permissions().readonly(), "read-only attribute lost by the flush");
    assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), fs::metadata(&source).unwrap().modified().unwrap());
    for path in [&source, &target] {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions).unwrap();
    }
}

#[test]
fn replacing_copy_and_sidecar_overwrite_leave_no_temporary_file() {
    let dir = tempfile::tempdir().unwrap();
    let (from, to) = (dir.path().join("from"), dir.path().join("to"));
    fs::create_dir_all(&from).unwrap();
    fs::create_dir_all(&to).unwrap();
    put(&from.join("a.cr2"), b"new raw");
    put(&from.join("a.cr2.xmp"), b"new sidecar");
    put(&to.join("a.cr2"), b"old raw");
    put(&to.join("a.cr2.xmp"), b"old sidecar");
    copy_replacing(&from.join("a.cr2"), &to.join("a.cr2")).unwrap();
    copy_sidecar(&from.join("a.cr2"), &to.join("a.cr2"), true).unwrap();
    assert_eq!(fs::read(to.join("a.cr2")).unwrap(), b"new raw");
    assert_eq!(fs::read(to.join("a.cr2.xmp")).unwrap(), b"new sidecar");
    let mut names: Vec<String> = fs::read_dir(&to).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["a.cr2", "a.cr2.xmp"], "temporary file left in the destination");
    // Without overwrite, an existing sidecar is left as is.
    put(&from.join("a.cr2.xmp"), b"newer sidecar");
    copy_sidecar(&from.join("a.cr2"), &to.join("a.cr2"), false).unwrap();
    assert_eq!(fs::read(to.join("a.cr2.xmp")).unwrap(), b"new sidecar");
}

/// Cost of the flush for moves between drives: `PHOTOBOGGAN_BENCH_DIR` = a folder on another drive (USB disk…), emptied of its test files after.
/// Old way (copy, optional hash check, delete) against the new one (copy flushed to the disk first). Run with:
/// `PHOTOBOGGAN_BENCH_DIR=E:\bench cargo test --release move_cost -- --ignored --nocapture`
#[test]
#[ignore = "benchmark: needs a folder on another drive (PHOTOBOGGAN_BENCH_DIR)"]
fn move_cost_between_drives() {
    let Ok(bench_dir) = std::env::var("PHOTOBOGGAN_BENCH_DIR") else { return eprintln!("PHOTOBOGGAN_BENCH_DIR not set"); };
    let bench_dir = PathBuf::from(bench_dir);
    fs::create_dir_all(&bench_dir).unwrap();
    let count: usize = std::env::var("PHOTOBOGGAN_BENCH_COUNT").ok().and_then(|value| value.parse().ok()).unwrap_or(100);
    let size: usize = std::env::var("PHOTOBOGGAN_BENCH_MB").ok().and_then(|value| value.parse().ok()).unwrap_or(8) * 1024 * 1024;
    let source_dir = tempfile::tempdir().unwrap();
    // Pseudo-random content (not compressible, not deduplicated), different for each file.
    let make_sources = |round: usize| -> Vec<PathBuf> {
        (0..count).map(|index| {
            let mut state = (round * 1_000_003 + index) as u64 | 1;
            let bytes: Vec<u8> = (0..size).map(|_| { state ^= state << 13; state ^= state >> 7; state ^= state << 17; state as u8 }).collect();
            let path = source_dir.path().join(format!("r{round}_{index}.jpg"));
            fs::write(&path, bytes).unwrap();
            path
        }).collect()
    };
    let old_move = |source: &Path, target: &Path, verify: bool| {
        fs::copy(source, target).unwrap();
        if verify { assert!(files_have_same_hash(source, target).unwrap()); }
        fs::remove_file(source).unwrap();
    };
    let new_move = |source: &Path, target: &Path, verify: bool| {
        copy_durably(source, target).unwrap();
        if verify { assert!(files_have_same_hash(source, target).unwrap()); }
        fs::remove_file(source).unwrap();
    };
    let scenarios: [(&str, bool, bool); 4] = [("old, no check", false, false), ("new, no check", true, false), ("old, SHA-256 check", false, true), ("new, SHA-256 check", true, true)];
    eprintln!("{count} files of {} MB to {}", size / 1024 / 1024, bench_dir.display());
    for (round, (name, durable, verify)) in scenarios.into_iter().enumerate() {
        let sources = make_sources(round);
        let started = std::time::Instant::now();
        let targets: Vec<PathBuf> = sources.iter().map(|source| {
            let target = bench_dir.join(source.file_name().unwrap());
            if durable { new_move(source, &target, verify) } else { old_move(source, &target, verify) }
            target
        }).collect();
        let elapsed = started.elapsed();
        eprintln!("{name:>20}: {:>6.2} s ({:>5.0} MB/s)", elapsed.as_secs_f64(), (count * size) as f64 / 1_048_576.0 / elapsed.as_secs_f64());
        for target in targets { fs::remove_file(target).unwrap(); }
    }
}

// --- Destination names and sidecars already there (reserve_destination) ---

#[test]
fn a_moved_or_copied_photo_never_adopts_a_sidecar_already_at_the_destination() {
    let dir = tempfile::tempdir().unwrap();
    // Orphan sidecars: left by files deleted or renamed outside the application.
    put(&dir.path().join("x.cr2.xmp"), b"<other photo>");
    put(&dir.path().join("y.xmp"), b"<other photo>");
    let x = reserve_destination(dir.path(), std::ffi::OsStr::new("x.cr2")).unwrap();
    let y = reserve_destination(dir.path(), std::ffi::OsStr::new("y.cr2")).unwrap();
    assert_eq!(x.path.file_name().unwrap(), "x (1).cr2");
    assert_eq!(y.path.file_name().unwrap(), "y (1).cr2");
    assert_eq!(x.skipped_sidecar.as_deref(), Some(dir.path().join("x.cr2.xmp").as_path()), "the rename is not reported");
    assert_eq!(y.skipped_sidecar.as_deref(), Some(dir.path().join("y.xmp").as_path()));
    assert_eq!(fs::read(dir.path().join("x.cr2.xmp")).unwrap(), b"<other photo>");

    // photo.xmp of a RAW already there: the JPEG of the same name joins the pair under its own name, nothing to report.
    put(&dir.path().join("z.cr2"), b"raw");
    put(&dir.path().join("z.xmp"), b"<pair>");
    let z = reserve_destination(dir.path(), std::ffi::OsStr::new("z.jpg")).unwrap();
    assert_eq!(z.path.file_name().unwrap(), "z.jpg");
    assert!(z.skipped_sidecar.is_none());

    // One log per operation, listing every rename.
    let renames: Vec<SidecarRename> = [("D:/src/x.cr2", &x), ("D:/src/y.cr2", &y)].into_iter().filter_map(|(source, reserved)| reserved.sidecar_rename(source)).collect();
    let storage = tempfile::tempdir().unwrap();
    let log = log_sidecar_renames(storage.path(), "move", &renames).expect("no log written");
    let text = fs::read_to_string(&log).unwrap();
    assert!(Path::new(&log).starts_with(storage.path().join("logs")), "{log}");
    assert!(text.contains("2 photo(s)") && text.contains("x (1).cr2") && text.contains("y.xmp"), "{text}");
    assert!(log_sidecar_renames(storage.path(), "move", &[]).is_none(), "a log written for nothing");
}

// --- Renames and reserved names (F1, F2) ---

#[test]
fn a_rename_is_only_allowed_onto_the_same_file() {
    let dir = tempfile::tempdir().unwrap();
    let photo = dir.path().join("img_1.jpg");
    put(&photo, b"photo");
    // Same name in another case: the same file on Windows / macOS, another file name on Linux (it does not exist there).
    let other_case = dir.path().join("IMG_1.jpg");
    assert_eq!(same_existing_file(&photo, &other_case), other_case.exists());
    // Two different files are never the same, whatever their names.
    let other = dir.path().join("img_2.jpg");
    put(&other, b"another photo");
    assert!(!same_existing_file(&photo, &other));
    assert!(!same_existing_file(&photo, &dir.path().join("missing.jpg")));
}

#[test]
fn a_reserved_name_is_never_taken_twice() {
    let dir = tempfile::tempdir().unwrap();
    let name = dir.path().join("new.jpg");
    reserve_new_file(&name).unwrap();
    assert_eq!(reserve_new_file(&name).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
    put(&dir.path().join("taken.jpg"), b"photo");
    assert_eq!(reserve_new_file(&dir.path().join("taken.jpg")).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(dir.path().join("taken.jpg")).unwrap(), b"photo", "an existing file was truncated");
}

/// The backend default cache size comes from defaults.jsonc like the frontend's (a new install once generated 512 px thumbnails while the
/// grid believed they were 1024 px); a valid saved size wins, an invalid one falls back to that default.
#[test]
fn thumbnail_cache_size_default_is_shared_with_the_frontend() {
    let json: String = include_str!("../../../src/defaults.jsonc").lines().filter(|line| !line.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    let frontend: serde_json::Value = serde_json::from_str(&json).unwrap();
    let expected = frontend["thumbnailCacheSize"].as_u64().unwrap() as u32;
    assert!(THUMBNAIL_CACHE_SIZES.contains(&expected), "defaults.jsonc thumbnailCacheSize must be one of {THUMBNAIL_CACHE_SIZES:?}");
    assert_eq!(default_thumbnail_cache_size(), expected);
    assert_eq!(startup_thumbnail_cache_size(None), expected);
    assert_eq!(startup_thumbnail_cache_size(Some(768)), 768);
    assert_eq!(startup_thumbnail_cache_size(Some(300)), expected);
}

/// Changing the storage location carries every data folder, logs included (they may name the only copy of a photo left by ExifTool),
/// and the old location is then emptied of them.
#[test]
fn storage_copy_carries_the_logs_and_cleanup_removes_them() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    let pool = crate::db::init_db(&from.path().join("photos_library.db").to_string_lossy());
    put(&from.path().join("logs").join("write-recovery_2026-01-01_10-00-00.log"), b"recovered");
    put(&from.path().join("models").join("model.onnx"), b"model");

    copy_storage(&pool, from.path(), to.path()).unwrap();
    assert!(to.path().join("photos_library.db").is_file());
    assert_eq!(fs::read(to.path().join("logs").join("write-recovery_2026-01-01_10-00-00.log")).unwrap(), b"recovered");
    assert!(to.path().join("models").join("model.onnx").is_file());

    drop(pool);
    remove_storage(from.path());
    assert!(!from.path().join("logs").exists());
    assert!(!from.path().join("models").exists());
}
