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
    let mock_trash_replace = |temp: &Path, target: &Path| {
        replace_file_via_trash_with(temp, target, true, |backup| fs::remove_file(backup).map_err(|e| e.to_string()))
    };
    copy_replacing_with(&from.join("a.cr2"), &to.join("a.cr2"), mock_trash_replace).unwrap();
    copy_sidecar_with(&from.join("a.cr2"), &to.join("a.cr2"), true, |src, dst| {
        copy_replacing_with(src, dst, mock_trash_replace)
    }).unwrap();
    assert_eq!(fs::read(to.join("a.cr2")).unwrap(), b"new raw");
    assert_eq!(fs::read(to.join("a.cr2.xmp")).unwrap(), b"new sidecar");
    let mut names: Vec<String> = fs::read_dir(&to).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["a.cr2", "a.cr2.xmp"], "temporary file left in the destination");
    // Without overwrite, an existing sidecar is left as is and AlreadyExists is returned (not swallowed).
    put(&from.join("a.cr2.xmp"), b"newer sidecar");
    let err = copy_sidecar(&from.join("a.cr2"), &to.join("a.cr2"), false).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
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

#[test]
fn remove_copied_target_removes_read_only_file() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("readonly.jpg");
    put(&target, b"photo");
    let mut permissions = fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&target, permissions).unwrap();

    remove_copied_target(&target);
    assert!(!target.exists(), "read-only copied target should be removed");
}

#[test]
fn move_sidecar_moves_unshared_compat_sidecar_and_copies_shared_one() {
    let dir = tempfile::tempdir().unwrap();
    let (src_dir, dst_dir) = (dir.path().join("src"), dir.path().join("dst"));
    fs::create_dir_all(&src_dir).unwrap();
    fs::create_dir_all(&dst_dir).unwrap();

    // 1. Unshared photo.xmp (source_has_sibling == Some(false)) -> moved, not left orphan.
    let src_photo = src_dir.join("solo.cr2");
    let dst_photo = dst_dir.join("solo.cr2");
    put(&src_dir.join("solo.xmp"), b"solo xmp");
    move_sidecar(&src_photo, &dst_photo, Some(false)).unwrap();
    assert!(!src_dir.join("solo.xmp").exists(), "unshared compat sidecar should be moved");
    assert_eq!(fs::read(dst_dir.join("solo.xmp")).unwrap(), b"solo xmp");

    // 2. Shared photo.xmp (Some(true)) or unreadable (None) -> copied, source stays intact.
    for (name, sibling) in [("pair_true", Some(true)), ("pair_none", None)] {
        let s_photo = src_dir.join(format!("{name}.cr2"));
        let d_photo = dst_dir.join(format!("{name}.cr2"));
        put(&src_dir.join(format!("{name}.xmp")), b"shared xmp");
        move_sidecar(&s_photo, &d_photo, sibling).unwrap();
        assert_eq!(fs::read(src_dir.join(format!("{name}.xmp"))).unwrap(), b"shared xmp");
        assert_eq!(fs::read(dst_dir.join(format!("{name}.xmp"))).unwrap(), b"shared xmp");
    }

    // 3. Existing target sidecar returns AlreadyExists and leaves target untouched.
    put(&src_dir.join("conflict.cr2.xmp"), b"new");
    put(&dst_dir.join("conflict.cr2.xmp"), b"existing");
    let err = move_sidecar(&src_dir.join("conflict.cr2"), &dst_dir.join("conflict.cr2"), Some(false)).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(dst_dir.join("conflict.cr2.xmp")).unwrap(), b"existing");
}

#[test]
fn atomic_copy_and_cross_drive_move_leave_no_temp_on_success_or_failure() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src.jpg");
    put(&src, b"jpeg payload");

    let reserved = reserve_destination(dir.path(), std::ffi::OsStr::new("copy.jpg")).unwrap();
    copy_atomically_to_reserved(&src, &reserved.path).unwrap();
    assert_eq!(fs::read(&reserved.path).unwrap(), b"jpeg payload");

    let missing_reserved = reserve_destination(dir.path(), std::ffi::OsStr::new("fail.jpg")).unwrap();
    assert!(copy_atomically_to_reserved(&dir.path().join("missing.jpg"), &missing_reserved.path).is_err());
    assert!(!missing_reserved.path.exists(), "reserved placeholder must be removed on failure");

    let moved = dir.path().join("moved.jpg");
    move_file_via_copy(&src, &moved).unwrap();
    assert!(!src.exists());
    assert_eq!(fs::read(&moved).unwrap(), b"jpeg payload");

    let names: Vec<String> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(!names.iter().any(|n| n.starts_with(".photoboggan-tmp-")), "leftover temp files: {names:?}");
}

#[test]
fn replace_via_trash_refuses_missing_trash_and_rolls_back_on_error() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("photo.jpg");
    put(&target, b"original");

    // 1. No trash available -> refuses and cleans up temp without touching target.
    let temp_no_trash = dir.path().join(".photoboggan-tmp-no-trash");
    put(&temp_no_trash, b"replacement");
    let err = replace_file_via_trash_with(&temp_no_trash, &target, false, |_| Ok(())).unwrap_err();
    assert!(err.contains("corbeille"), "{err}");
    assert_eq!(fs::read(&target).unwrap(), b"original");
    assert!(!temp_no_trash.exists());

    // 2. Trash fails -> rolls back target and removes temp + backup dir.
    let temp_fail = dir.path().join(".photoboggan-tmp-fail");
    put(&temp_fail, b"replacement");
    let err = replace_file_via_trash_with(&temp_fail, &target, true, |_| Err("trash error".into())).unwrap_err();
    assert!(err.contains("trash error"), "{err}");
    assert_eq!(fs::read(&target).unwrap(), b"original");
    assert!(!temp_fail.exists());

    // 3. copy_replacing_with with mock trash succeeds and leaves no temp/backup.
    let src = dir.path().join("src.jpg");
    put(&src, b"new content");
    copy_replacing_with(&src, &target, |temp, dst| {
        replace_file_via_trash_with(temp, dst, true, |backup| fs::remove_file(backup).map_err(|e| e.to_string()))
    }).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"new content");
    let mut names: Vec<String> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["photo.jpg", "src.jpg"]);
}

#[cfg(windows)]
#[test]
fn unc_share_has_no_trash_and_refuses_replacement() {
    let unc_target = Path::new(r"\\server\share\photo.jpg");
    assert!(!has_trash(&unc_target.to_string_lossy()));
    let dir = tempfile::tempdir().unwrap();
    let temp = dir.path().join("temp.jpg");
    put(&temp, b"data");
    let err = replace_file_via_trash(&temp, unc_target).unwrap_err();
    assert!(err.contains("corbeille"), "{err}");
    assert!(!temp.exists());
}

#[test]
fn resolve_tracked_folder_rejects_dot_and_parent_traversal() {
    let (_dir, pool) = temp_catalog();
    let root = "D:/Photos";
    db::add_folder(&pool, root).unwrap();

    assert_eq!(resolve_tracked_folder(&pool, "D:/Photos/2026.05"), Some(PathBuf::from(root).join("2026.05")));
    assert_eq!(resolve_tracked_folder(&pool, "D:/Photos/../Windows"), None);
    assert_eq!(resolve_tracked_folder(&pool, "D:/Photos/a/../../b"), None);
    assert_eq!(resolve_tracked_folder(&pool, "D:/Photos/."), None);
    assert_eq!(resolve_tracked_folder(&pool, "D:/Photos/./a"), None);
}

#[test]
fn delete_photos_reports_sidecar_trash_failure() {
    let (dir, pool) = temp_catalog();
    let dirs = cache_dirs(dir.path());
    let photo = dir.path().join("a.cr2");
    let sidecar = dir.path().join("a.cr2.xmp");
    put(&photo, b"raw");
    put(&sidecar, b"<x/>");
    let path_str = photo.to_string_lossy().into_owned();
    insert_photo(&pool.get().unwrap(), &path_str);

    let result = delete_photos_with(&pool, &dirs.thumbnails, &dirs.raw_previews, vec![path_str.clone()], |p| {
        if p == sidecar {
            Err("sidecar locked".into())
        } else {
            fs::remove_file(p).map_err(|e| e.to_string())
        }
    }).unwrap();

    assert_eq!(result.deleted, vec![path_str]);
    assert_eq!(result.failed.len(), 1);
    assert_eq!(result.failed[0].path, sidecar.to_string_lossy());
    assert!(result.failed[0].error.contains("sidecar locked"));
}

#[test]
fn concurrent_rotations_compose_cleanly_under_single_path_lock() {
    let (dir, pool) = temp_catalog();
    let dirs = cache_dirs(dir.path());
    let png = dir.path().join("turn.png");
    put(&png, &png_bytes(16, 12));
    let path_str = png.to_string_lossy().into_owned();
    let id = insert_photo(&pool.get().unwrap(), &path_str);

    let write_stub = |p: &Path, _guard: &std::sync::MutexGuard<'static, ()>, orientation: u32| -> std::io::Result<()> {
        std::thread::sleep(std::time::Duration::from_millis(30));
        let xml = format!(
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\
             <rdf:Description xmlns:tiff=\"http://ns.adobe.com/tiff/1.0/\" tiff:Orientation=\"{orientation}\"/>\
             </rdf:RDF></x:xmpmeta>"
        );
        fs::write(format!("{}.xmp", p.display()), xml)
    };

    std::thread::scope(|scope| {
        let h1 = scope.spawn(|| rotate_photo_with(&pool, &dirs, id, &path_str, 1, write_stub));
        let h2 = scope.spawn(|| rotate_photo_with(&pool, &dirs, id, &path_str, 1, write_stub));
        h1.join().unwrap().unwrap();
        h2.join().unwrap().unwrap();
    });

    assert_eq!(orientation::read(&png).stored, 3, "two +90° rotations from 1 must reach 3, never 6");
    let db_orientation: u32 = pool.get().unwrap().query_row("SELECT orientation FROM photos WHERE id = ?1", [id], |r| r.get(0)).unwrap();
    assert_eq!(db_orientation, 3);
}

#[test]
fn marking_and_rotation_mismatch_mark_photo_for_resync() {
    let (dir, pool) = temp_catalog();
    let dirs = cache_dirs(dir.path());
    let png = dir.path().join("mismatch.png");
    put(&png, &png_bytes(8, 8));
    let path_str = png.to_string_lossy().into_owned();
    let id = insert_photo(&pool.get().unwrap(), &path_str);

    let err = write_photo_marking_with(&pool, &dirs, id, &path_str, Some(5), None, None, None, |p, _| {
        fs::write(format!("{p}.xmp"), "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmp:Rating=\"1\"/></rdf:RDF></x:xmpmeta>")
    }).unwrap_err();
    assert!(err.message.contains("note"), "{}", err.message);
    assert!(err.sidecar_conflict.is_none());
    let size_after_marking: i64 = pool.get().unwrap().query_row("SELECT file_size FROM photos WHERE id = ?1", [id], |r| r.get(0)).unwrap();
    assert_eq!(size_after_marking, -1);

    pool.get().unwrap().execute("UPDATE photos SET file_size = 100 WHERE id = ?1", [id]).unwrap();
    let err = rotate_photo_with(&pool, &dirs, id, &path_str, 1, |p, _, _| {
        fs::write(format!("{}.xmp", p.display()), "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:tiff=\"http://ns.adobe.com/tiff/1.0/\" tiff:Orientation=\"8\"/></rdf:RDF></x:xmpmeta>")
    }).unwrap_err();
    assert!(err.contains("Orientation"), "{err}");
    let size_after_rotate: i64 = pool.get().unwrap().query_row("SELECT file_size FROM photos WHERE id = ?1", [id], |r| r.get(0)).unwrap();
    assert_eq!(size_after_rotate, -1);
}

#[test]
fn marking_removal_masked_by_sidecar_reports_sidecar_conflict() {
    let (dir, pool) = temp_catalog();
    let dirs = cache_dirs(dir.path());
    let jpg = dir.path().join("color.jpg");
    put(&jpg, &jpeg_bytes(16, 16));
    put(
        &dir.path().join("color.jpg.xmp"),
        b"<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmp:Label=\"Red\"/></rdf:RDF></x:xmpmeta>",
    );
    let path_str = jpg.to_string_lossy().into_owned();
    let id = insert_photo(&pool.get().unwrap(), &path_str);

    let err = write_photo_marking_with(&pool, &dirs, id, &path_str, None, Some(None), None, Some("none"), |p, _| {
        fs::write(p, jpeg_bytes(16, 16))
    })
    .unwrap_err();
    let conflict = err.sidecar_conflict.expect("sidecar conflict expected");
    assert_eq!(conflict.sidecar_name, "color.jpg.xmp");
    assert!(!conflict.shared);
}

#[test]
fn copy_durably_succeeds_when_source_is_stable() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src.bin");
    let dst = dir.path().join("dst.tmp");
    put(&src, b"stable-content");

    let copied = copy_durably(&src, &dst).unwrap();
    assert_eq!(copied, b"stable-content".len() as u64);
    assert_eq!(fs::read(&dst).unwrap(), b"stable-content");
}

#[test]
fn copy_durably_rejects_source_resized_during_copy() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src.bin");
    let dst = dir.path().join("dst.tmp");
    put(&src, b"initial");

    let err = copy_durably_with(&src, &dst, |s, d| {
        let n = fs::copy(s, d)?;
        put(s, b"initial-and-more");
        Ok(n)
    })
    .unwrap_err();

    assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    assert!(!dst.exists(), "temporary target must be removed on mismatch");
}

#[test]
fn copy_durably_rejects_same_size_source_with_changed_mtime() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src.bin");
    let dst = dir.path().join("dst.tmp");
    put(&src, b"12345678");

    let err = copy_durably_with(&src, &dst, |s, d| {
        let n = fs::copy(s, d)?;
        let file = fs::OpenOptions::new().write(true).open(s)?;
        file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5))?;
        Ok(n)
    })
    .unwrap_err();

    assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    assert!(!dst.exists(), "temporary target must be removed on mtime mismatch");
}

#[test]
fn copy_durably_rejects_copied_byte_count_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src.bin");
    let dst = dir.path().join("dst.tmp");
    put(&src, b"12345678");

    let err = copy_durably_with(&src, &dst, |s, d| {
        let _ = fs::copy(s, d)?;
        Ok(4)
    })
    .unwrap_err();

    assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    assert!(!dst.exists(), "temporary target must be removed on byte count mismatch");
}

#[test]
fn copy_replacing_rejects_same_file_and_sidecar_overwrite_protects_shared_xmp() {
    let dir = tempfile::tempdir().unwrap();
    let (src_dir, dst_dir) = (dir.path().join("src"), dir.path().join("dst"));
    fs::create_dir_all(&src_dir).unwrap();
    fs::create_dir_all(&dst_dir).unwrap();

    let self_file = src_dir.join("same.jpg");
    put(&self_file, b"keep-me");
    let err = copy_replacing_verified_with(
        &self_file,
        &self_file,
        |_, _| Ok(()),
        |_, _| Ok(()),
    )
    .unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    assert_eq!(fs::read(&self_file).unwrap(), b"keep-me");

    // Replacing a JPEG at destination must not overwrite a compatible `photo.xmp` shared with `photo.cr2`.
    let src_jpg = src_dir.join("photo.jpg");
    let src_xmp = src_dir.join("photo.xmp");
    put(&src_jpg, b"new-jpg");
    put(&src_xmp, b"jpg-xmp");

    let dst_jpg = dst_dir.join("photo.jpg");
    let dst_raw = dst_dir.join("photo.cr2");
    let dst_shared_xmp = dst_dir.join("photo.xmp");
    put(&dst_jpg, b"old-jpg");
    put(&dst_raw, b"raw-file");
    put(&dst_shared_xmp, b"shared-raw-xmp");

    copy_sidecar_with(&src_jpg, &dst_jpg, true, |s, d| {
        copy_replacing_verified_with(s, d, |_, _| Ok(()), |temp, target| {
            replace_file_via_trash_with(temp, target, true, |backup| {
                fs::remove_file(backup).map_err(|e| e.to_string())
            })
        })
    })
    .unwrap();

    assert_eq!(fs::read(&dst_shared_xmp).unwrap(), b"shared-raw-xmp");
    assert_eq!(fs::read(dst_dir.join("photo.jpg.xmp")).unwrap(), b"jpg-xmp");
}

#[test]
fn copy_sidecar_non_overwrite_redirects_away_from_shared_destination_xmp() {
    let dir = tempfile::tempdir().unwrap();
    let (src_dir, dst_dir) = (dir.path().join("src"), dir.path().join("dst"));
    fs::create_dir_all(&src_dir).unwrap();
    fs::create_dir_all(&dst_dir).unwrap();

    let src_raw = src_dir.join("photo.cr2");
    put(&src_raw, b"raw");
    put(&src_dir.join("photo.xmp"), b"incoming-xmp");

    let dst_raw = dst_dir.join("photo.cr2");
    put(&dst_dir.join("photo.jpg"), b"existing-jpg");
    put(&dst_dir.join("photo.xmp"), b"existing-jpg-xmp");

    copy_sidecar(&src_raw, &dst_raw, false).unwrap();

    assert_eq!(fs::read(dst_dir.join("photo.xmp")).unwrap(), b"existing-jpg-xmp");
    assert_eq!(fs::read(dst_dir.join("photo.cr2.xmp")).unwrap(), b"incoming-xmp");
}

#[test]
fn move_photo_with_sidecar_stages_sidecar_first_and_redirects_shared_xmp() {
    let dir = tempfile::tempdir().unwrap();
    let (src_dir, dst_dir) = (dir.path().join("src"), dir.path().join("dst"));
    fs::create_dir_all(&src_dir).unwrap();
    fs::create_dir_all(&dst_dir).unwrap();

    // 1. Unshared src/photo.xmp with dst/photo.jpg + dst/photo.xmp -> redirects to dst/photo.cr2.xmp and removes src/photo.xmp.
    let src_raw = src_dir.join("photo.cr2");
    let dst_raw = dst_dir.join("photo.cr2");
    put(&src_raw, b"raw-1");
    put(&src_dir.join("photo.xmp"), b"raw-1-xmp");
    put(&dst_dir.join("photo.jpg"), b"dst-jpg");
    put(&dst_dir.join("photo.xmp"), b"dst-jpg-xmp");
    reserve_new_file(&dst_raw).unwrap();

    let warning = move_photo_with_sidecar_using(&src_raw, &dst_raw, Some(false), move_file).unwrap();
    assert!(warning.is_none());
    assert!(!src_raw.exists());
    assert!(!src_dir.join("photo.xmp").exists());
    assert_eq!(fs::read(&dst_raw).unwrap(), b"raw-1");
    assert_eq!(fs::read(dst_dir.join("photo.xmp")).unwrap(), b"dst-jpg-xmp");
    assert_eq!(fs::read(dst_dir.join("photo.cr2.xmp")).unwrap(), b"raw-1-xmp");

    // 2. Shared src/pair.xmp (source_has_sibling == Some(true)) -> keeps src/pair.xmp intact.
    let src_pair = src_dir.join("pair.cr2");
    let dst_pair = dst_dir.join("pair.cr2");
    put(&src_pair, b"pair-raw");
    put(&src_dir.join("pair.xmp"), b"pair-xmp");
    reserve_new_file(&dst_pair).unwrap();
    move_photo_with_sidecar_using(&src_pair, &dst_pair, Some(true), move_file).unwrap();
    assert_eq!(fs::read(src_dir.join("pair.xmp")).unwrap(), b"pair-xmp");
    assert_eq!(fs::read(dst_dir.join("pair.xmp")).unwrap(), b"pair-xmp");

    // 3. Sidecar staging fails (dst/fail.cr2.xmp already exists) -> photo stays at source and reserved placeholder is removed.
    let src_fail = src_dir.join("fail.cr2");
    let dst_fail = dst_dir.join("fail.cr2");
    put(&src_fail, b"fail-raw");
    put(&src_dir.join("fail.cr2.xmp"), b"new-xmp");
    put(&dst_dir.join("fail.cr2.xmp"), b"existing-xmp");
    reserve_new_file(&dst_fail).unwrap();
    let err = move_photo_with_sidecar_using(&src_fail, &dst_fail, Some(false), move_file).unwrap_err();
    assert!(err.contains("Sidecar XMP"), "{err}");
    assert_eq!(fs::read(&src_fail).unwrap(), b"fail-raw");
    assert!(!dst_fail.exists(), "reserved placeholder must be removed when sidecar staging fails");
    assert_eq!(fs::read(dst_dir.join("fail.cr2.xmp")).unwrap(), b"existing-xmp");

    // 4. Photo move fails after sidecar staging -> staged destination sidecar is removed and source remains intact.
    let src_io = src_dir.join("iofail.cr2");
    let dst_io = dst_dir.join("iofail.cr2");
    put(&src_io, b"io-raw");
    put(&src_io.with_extension("cr2.xmp"), b"io-xmp");
    reserve_new_file(&dst_io).unwrap();
    let err = move_photo_with_sidecar_using(&src_io, &dst_io, Some(false), |_, _| {
        Err(std::io::Error::other("disk error"))
    })
    .unwrap_err();
    assert!(err.contains("disk error"), "{err}");
    assert_eq!(fs::read(&src_io).unwrap(), b"io-raw");
    assert_eq!(fs::read(src_io.with_extension("cr2.xmp")).unwrap(), b"io-xmp");
    assert!(!dst_io.exists());
    assert!(!dst_dir.join("iofail.cr2.xmp").exists());
}

#[test]
fn replace_file_via_backup_reports_backup_path_when_rollback_fails() {
    let dir = tempfile::tempdir().unwrap();

    // Branch 1: forward rename(temp, target) fails AND rollback rename(backup, target) fails.
    let target1 = dir.path().join("photo1.jpg");
    let temp1 = dir.path().join(".photoboggan-tmp-1");
    put(&target1, b"original-1");
    put(&temp1, b"new-1");
    let err1 = replace_file_via_backup_with_rename(
        &temp1,
        &target1,
        |_| Ok(()),
        |from, to| {
            if from == temp1 {
                Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "locked"))
            } else {
                fs::rename(from, to)
            }
        },
        |_from, _to| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "restore locked")),
    )
    .unwrap_err();
    assert!(err1.contains(".photoboggan-backup-"), "{err1}");
    assert!(err1.contains("photo1.jpg"), "{err1}");
    assert!(!temp1.exists());
    let backup_entry1 = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.file_name().unwrap().to_string_lossy().starts_with(".photoboggan-backup-"))
        .expect("backup dir must be preserved when rollback fails");
    assert_eq!(fs::read(backup_entry1.join("photo1.jpg")).unwrap(), b"original-1");
    fs::remove_dir_all(&backup_entry1).unwrap();

    // Branch 2: trash fails AND rollback rename(target, temp) fails.
    let target2 = dir.path().join("photo2.jpg");
    let temp2 = dir.path().join(".photoboggan-tmp-2");
    put(&target2, b"original-2");
    put(&temp2, b"new-2");
    let err2 = replace_file_via_backup_with_rename(
        &temp2,
        &target2,
        |_| Err("trash disabled".into()),
        |from, to| fs::rename(from, to),
        |_from, _to| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "rollback locked")),
    )
    .unwrap_err();
    assert!(err2.contains(".photoboggan-backup-"), "{err2}");
    assert!(!err2.contains("il n'est pas remplacé"), "must not falsely claim target was not replaced: {err2}");
    let backup_entry2 = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.file_name().unwrap().to_string_lossy().starts_with(".photoboggan-backup-"))
        .expect("backup dir must be preserved when rollback fails");
    assert_eq!(fs::read(backup_entry2.join("photo2.jpg")).unwrap(), b"original-2");
}

#[test]
fn recycle_guard_and_windows_shell_path_work_as_expected() {
    assert!(will_recycle_from_pre_delete_flags(TSF_DELETE_RECYCLE_IF_POSSIBLE_FLAG));
    assert!(will_recycle_from_pre_delete_flags(0x04 | TSF_DELETE_RECYCLE_IF_POSSIBLE_FLAG));
    assert!(!will_recycle_from_pre_delete_flags(0));
    assert!(!will_recycle_from_pre_delete_flags(0x04));

    assert_eq!(
        windows_shell_path(Path::new(r"\\?\D:\Photos\a.jpg")).unwrap(),
        PathBuf::from(r"D:\Photos\a.jpg")
    );
    assert_eq!(
        windows_shell_path(Path::new(r"\\?\UNC\server\share\a.jpg")).unwrap(),
        PathBuf::from(r"\\server\share\a.jpg")
    );

    #[cfg(windows)]
    {
        assert!(!has_trash(r"Q:\nonexistent\photo.jpg"));
        assert_eq!(
            count_permanent_deletions(vec![
                r"\\server\share\a.jpg".to_string(),
                r"\\server\share\b.jpg".to_string(),
            ]),
            2
        );
    }
}
