//! Tests du chemin d'écriture ExifTool (exiftool.rs).
//! Rapides : verrous par chemin, échappement des valeurs, choix de la cible. Aucun processus ExifTool n'est lancé.
//! Intégration (`cargo test -- --ignored`) : écritures réelles avec l'ExifTool embarqué (`npm run fetch-exiftool`) ou celui du PATH ;
//! sans ExifTool disponible, ces tests s'arrêtent en le disant (ils ne passent pas pour autant en échec).

use super::*;
use crate::exif::{read_exif, MetadataUpdate, XmpEdit};
use crate::test_support::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

// --- Rapides ---

#[test]
fn value_escaping_and_deletion_convention() {
    assert_eq!(assign("XMP-dc:Title", "a\\b"), "-XMP-dc:Title=a\\\\b");
    assert_eq!(assign("XMP-dc:Title", "l1\nl2"), "-XMP-dc:Title=l1\\nl2");
    assert_eq!(assign("XMP-dc:Title", ""), "-XMP-dc:Title=", "valeur vide = balise supprimée");
    let mut args = Vec::new();
    push_list(&mut args, "XMP-dc:Subject", Vec::<String>::new());
    assert_eq!(args, ["-XMP-dc:Subject="], "liste vide = balise supprimée");
    push_list(&mut args, "IPTC:Keywords", ["a".to_string(), "b".to_string()]);
    assert_eq!(&args[1..], ["-IPTC:Keywords=a", "-IPTC:Keywords=b"]);
}

#[test]
fn target_depends_on_extension_only() {
    let kind = |name: &str| match target_of(Path::new(name)) { Target::Jpeg => "jpeg", Target::Heif => "heif", Target::Sidecar => "sidecar" };
    assert_eq!([kind("a.JPG"), kind("a.jpeg"), kind("a.HEIC"), kind("a.hif")], ["jpeg", "jpeg", "heif", "heif"]);
    assert_eq!([kind("a.cr2"), kind("a.png"), kind("a.mp4"), kind("a")], ["sidecar"; 4]);
}

#[test]
fn values_with_line_breaks_are_refused_before_any_process_starts() {
    let error = run(vec!["-Title=a\nb".to_string()]).unwrap_err();
    assert!(error.to_string().contains("retour à la ligne"), "{error}");
}

#[test]
fn same_path_writes_are_serialised_and_other_paths_are_not_blocked() {
    let path = Path::new("D:/photos/serial.jpg");
    let guard = path_lock(path);
    let entered = Arc::new(AtomicBool::new(false));
    let waiter = {
        let entered = entered.clone();
        std::thread::spawn(move || {
            let _second = path_lock(Path::new("D:/photos/serial.jpg"));
            entered.store(true, Ordering::SeqCst);
        })
    };
    std::thread::sleep(std::time::Duration::from_millis(150));
    assert!(!entered.load(Ordering::SeqCst), "deux écritures simultanées sur la même image");
    drop(guard);
    waiter.join().unwrap();
    assert!(entered.load(Ordering::SeqCst));
}

// Cleanup after a failed ExifTool write (recover_after_failure): the states ExifTool can leave behind are recreated by hand.

#[test]
fn failed_write_leftover_is_removed_when_the_original_is_still_there() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("photo.jpg");
    std::fs::write(&file, b"original").unwrap();
    std::fs::write(exiftool_temp_of(&file), b"new version").unwrap();
    assert_eq!(recover_after_failure(&file), None);
    assert_eq!(std::fs::read(&file).unwrap(), b"original");
    assert!(!exiftool_temp_of(&file).exists(), "leftover temporary file not removed");
}

#[test]
fn only_copy_left_by_exiftool_is_restored_never_deleted() {
    // ExifTool deleted the original, then failed to rename its temporary file: that file is all that remains of the photo.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("photo.jpg");
    std::fs::write(exiftool_temp_of(&file), b"only copy").unwrap();
    let recovery = recover_after_failure(&file).expect("the restoration must be reported");
    assert_eq!(recovery.kind, RecoveryKind::Restored);
    assert!(recovery.note().contains("restauré"), "{}", recovery.note());
    assert_eq!(std::fs::read(&file).unwrap(), b"only copy", "photo not restored under its own name");
    assert!(!exiftool_temp_of(&file).exists());
}

#[test]
fn temporary_file_is_kept_when_the_original_state_is_unclear() {
    // The original name is now a directory: neither "original present" nor "original missing", so nothing is deleted.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("photo.jpg");
    std::fs::write(exiftool_temp_of(&file), b"only copy").unwrap();
    std::fs::create_dir(&file).unwrap();
    let recovery = recover_after_failure(&file).expect("the kept copy must be reported");
    assert_eq!(recovery.kind, RecoveryKind::TempKept);
    assert!(recovery.note().contains("_exiftool_tmp"), "{}", recovery.note());
    assert_eq!(std::fs::read(exiftool_temp_of(&file)).unwrap(), b"only copy", "the temporary file was deleted");
}

#[test]
fn nothing_to_do_without_temporary_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("photo.jpg");
    std::fs::write(&file, b"original").unwrap();
    assert_eq!(recover_after_failure(&file), None);
    assert_eq!(std::fs::read(&file).unwrap(), b"original");
}

#[test]
fn recoveries_of_one_operation_go_to_a_single_timestamped_log_never_overwritten() {
    use chrono::TimeZone;
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    let recovery = |kind, file: &str| Recovery {
        kind,
        file: file.to_string(),
        temp: format!("{file}_exiftool_tmp"),
        detail: if kind == RecoveryKind::Restored { String::new() } else { "access denied".to_string() },
        error: "Error renaming temporary file".to_string(),
    };
    let entries = [recovery(RecoveryKind::Restored, "a.jpg"), recovery(RecoveryKind::OnlyCopyKept, "b.jpg")];
    let now = chrono::Local.with_ymd_and_hms(2026, 11, 7, 14, 3, 9).unwrap();
    let first = write_recovery_log(&logs, &entries, now).unwrap();
    assert_eq!(first.file_name().unwrap(), "write-recovery_2026-11-07_14-03-09.log");
    let text = std::fs::read_to_string(&first).unwrap();
    assert!(text.contains("2 file(s)"), "{text}");
    assert!(text.contains("RESTORED") && text.contains("a.jpg"), "{text}");
    assert!(text.contains("ONLY COPY KEPT") && text.contains("b.jpg_exiftool_tmp") && text.contains("access denied"), "{text}");
    // Same second: a second file, the first one is kept as is.
    let second = write_recovery_log(&logs, &entries[..1], now).unwrap();
    assert_eq!(second.file_name().unwrap(), "write-recovery_2026-11-07_14-03-09-2.log");
    assert_eq!(std::fs::read_to_string(&first).unwrap(), text);
}

#[test]
fn struct_value_escapes_hash_edge_spaces_and_syntax_chars() {
    assert_eq!(struct_value("Alice #1"), "Alice |#1");
    assert_eq!(struct_value("  Alice  "), "| | Alice| | ");
    assert_eq!(struct_value("\tAlice\t"), "|\tAlice|\t");
    assert_eq!(struct_value(" "), "| ");
    assert_eq!(struct_value("  "), "| | ");
    assert_eq!(struct_value(""), "");
    assert_eq!(struct_value("a|b,c=d{e}f[g]h#i"), "a||b|,c|=d|{e|}f|[g|]h|#i");
}

#[test]
fn metadata_args_updates_iptc_digest_on_jpeg_iptc_writes_and_clears() {
    let jpeg = Path::new("photo.jpg");
    let raw = Path::new("photo.cr2");
    let heic = Path::new("photo.heic");

    let with_keywords = MetadataUpdate { keywords: Some(paths(&[&["Nature"]])), ..Default::default() };
    assert!(metadata_args(jpeg, &with_keywords).contains(&"-Photoshop:IPTCDigest=new".to_string()));
    assert!(!metadata_args(raw, &with_keywords).contains(&"-Photoshop:IPTCDigest=new".to_string()));
    assert!(!metadata_args(heic, &with_keywords).contains(&"-Photoshop:IPTCDigest=new".to_string()));

    let cleared = MetadataUpdate {
        keywords: Some(Vec::new()),
        title: Some(String::new()),
        description: Some(String::new()),
        author: Some(String::new()),
        copyright: Some(String::new()),
        credit: Some(String::new()),
        ..Default::default()
    };
    assert!(metadata_args(jpeg, &cleared).contains(&"-Photoshop:IPTCDigest=new".to_string()));

    let non_iptc = MetadataUpdate {
        usage_terms: Some("CC0".into()),
        author_email: Some("a@b.c".into()),
        gps: Some(Some((1.0, 2.0))),
        ..Default::default()
    };
    assert!(!metadata_args(jpeg, &non_iptc).contains(&"-Photoshop:IPTCDigest=new".to_string()));
}

#[cfg(windows)]
#[test]
fn path_lock_normalizes_case_separators_and_extended_prefix() {
    let a = normalized_lock_key(Path::new(r"C:\Photos\A.JPG"));
    let b = normalized_lock_key(Path::new("c:/photos/a.jpg"));
    let c = normalized_lock_key(Path::new(r"\\?\C:\Photos\A.JPG"));
    assert_eq!(a, "c:/photos/a.jpg");
    assert_eq!(a, b);
    assert_eq!(a, c);

    let unc_ext = normalized_lock_key(Path::new(r"\\?\UNC\Server\Share\A.JPG"));
    let unc_std = normalized_lock_key(Path::new(r"\\server\share\a.jpg"));
    assert_eq!(unc_ext, "//server/share/a.jpg");
    assert_eq!(unc_ext, unc_std);
}

#[test]
fn active_write_guard_tracks_in_flight_writes_and_notifies_waiters() {
    let guard = ActiveWriteGuard::enter().unwrap();
    assert!(has_active_writes());
    assert!(!wait_for_active_writes(Duration::from_millis(50)));

    let dropper = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(40));
        drop(guard);
    });
    assert!(wait_for_active_writes(Duration::from_secs(2)));
    dropper.join().unwrap();
}

#[test]
fn safe_arg_path_prefixes_leading_dash_only() {
    let dashed = safe_arg_path(Path::new("-dash.jpg"));
    assert!(!dashed.starts_with('-'), "got {dashed:?}");
    assert!(dashed.ends_with("-dash.jpg"), "got {dashed:?}");
    assert_eq!(safe_arg_path(Path::new("normal.jpg")), "normal.jpg");
    assert_eq!(safe_arg_path(Path::new("C:/photos/-dash.jpg")), "C:/photos/-dash.jpg");
}

// --- Intégration (ExifTool réel) ---

/// Prépare ExifTool : version embarquée du dépôt si elle est présente (Windows), sinon celui du PATH. Faux (avec un message) s'il est introuvable.
fn exiftool_available() -> bool {
    let vendored = Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor").join("exiftool").join("exiftool.exe");
    if cfg!(windows) && vendored.is_file() {
        SETTINGS.write().unwrap_or_else(|poisoned| poisoned.into_inner()).custom_path = Some(vendored);
        *lock(&LAUNCHER) = None;
    }
    match launcher() {
        Ok(found) => { eprintln!("ExifTool utilisé : {}", found.display_path()); true }
        Err(reason) => { eprintln!("Test d'intégration ignoré, ExifTool introuvable : {reason}"); false }
    }
}

fn leftovers(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| {
            name.ends_with("_exiftool_tmp")
                || name.ends_with(".photoboggan-tmp")
                || name.contains(".photoboggan-tmp.")
                || name.contains(".photoboggan-")
                || name.ends_with(".tmp.xmp")
        })
        .collect()
}

fn sample_update() -> MetadataUpdate {
    MetadataUpdate {
        keywords: Some(paths(&[&["Lieux", "France", "Paris"], &["Animaux"], &["People", "lu think yin's father"]])),
        title: Some("Titre é & <b>".into()),
        description: Some("Description".into()),
        ..Default::default()
    }
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn jpeg_is_written_without_touching_pixels() {
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();
    let original = jpeg_bytes(40, 30);
    let path = dir.path().join("a.jpg");
    std::fs::write(&path, &original).unwrap();

    write_metadata(&path, &sample_update()).unwrap();

    let written = std::fs::read(&path).unwrap();
    assert_ne!(written, original);
    assert_eq!(decoded_pixels(&written), decoded_pixels(&original), "pixels modifiés");
    assert_eq!(scan_data(&written), scan_data(&original), "données d'image modifiées");
    let meta = read_exif(&path);
    let mut keyword_paths = meta.keyword_paths.clone();
    keyword_paths.sort();
    assert_eq!(keyword_paths, paths(&[&["Animaux"], &["Lieux", "France", "Paris"], &["People", "lu think yin's father"]]));
    assert_eq!((meta.title.as_str(), meta.caption.as_str()), ("Titre é & <b>", "Description"));
    assert!(crate::exif::text_mismatch(&path, &sample_update(), &meta).is_none());
    assert!(leftovers(dir.path()).is_empty(), "{:?}", leftovers(dir.path()));
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn marking_round_trip_and_raw_sidecar() {
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();
    let jpeg = dir.path().join("a.jpg");
    std::fs::write(&jpeg, jpeg_bytes(16, 16)).unwrap();
    write_marking(&jpeg, XmpEdit { rating: Some(3), label: Some(Some("Green")), pick: Some("picked") }).unwrap();
    let meta = read_exif(&jpeg);
    assert_eq!((meta.rating, meta.color_flag.as_str(), meta.pick_flag.as_str()), (3, "green", "picked"));

    // RAW : l'original ne change jamais, tout va dans le sidecar.
    let raw_bytes = b"II*\0 faux raw".to_vec();
    let raw = dir.path().join("b.cr2");
    std::fs::write(&raw, &raw_bytes).unwrap();
    write_metadata(&raw, &sample_update()).unwrap();
    assert_eq!(std::fs::read(&raw).unwrap(), raw_bytes);
    assert!(dir.path().join("b.cr2.xmp").exists());
    assert_eq!(read_exif(&raw).title, "Titre é & <b>");
    assert!(leftovers(dir.path()).is_empty(), "{:?}", leftovers(dir.path()));
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn shared_compatible_sidecar_is_copied_never_written() {
    // photo.cr2 + photo.dng share photo.xmp: ExifTool writes photo.cr2.xmp, created from photo.xmp, which stays untouched.
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();
    let seed = dir.path().join("seed.cr2");
    std::fs::write(&seed, b"raw").unwrap();
    write_marking(&seed, XmpEdit { rating: Some(3), label: Some(Some("Red")), pick: None }).unwrap();
    let shared = dir.path().join("photo.xmp");
    std::fs::rename(dir.path().join("seed.cr2.xmp"), &shared).unwrap();
    std::fs::remove_file(&seed).unwrap();
    let shared_bytes = std::fs::read(&shared).unwrap();
    let raw = dir.path().join("photo.cr2");
    let dng = dir.path().join("photo.dng");
    std::fs::write(&raw, b"raw").unwrap();
    std::fs::write(&dng, b"dng").unwrap();

    write_marking(&raw, XmpEdit { rating: Some(5), ..Default::default() }).unwrap();
    assert_eq!(std::fs::read(&shared).unwrap(), shared_bytes, "the shared photo.xmp was modified");
    let meta = read_exif(&raw);
    assert_eq!((meta.rating, meta.color_flag.as_str()), (5, "red"));
    assert_eq!(read_exif(&dng).rating, 3);
    // A removal alone also creates the own sidecar, and sticks.
    write_marking(&dng, XmpEdit { label: Some(None), ..Default::default() }).unwrap();
    assert_eq!(read_exif(&dng).color_flag, "none");
    assert_eq!(read_exif(&dng).rating, 3);
    assert_eq!(std::fs::read(&shared).unwrap(), shared_bytes);
    assert!(leftovers(dir.path()).is_empty(), "{:?}", leftovers(dir.path()));
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn failure_is_an_error_and_leaves_no_residue() {
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("faux.jpg");
    std::fs::write(&path, b"ceci n'est pas un JPEG").unwrap();
    assert!(write_metadata(&path, &sample_update()).is_err(), "un échec ne doit jamais passer pour un succès");
    assert_eq!(std::fs::read(&path).unwrap(), b"ceci n'est pas un JPEG");
    assert!(leftovers(dir.path()).is_empty(), "{:?}", leftovers(dir.path()));
    assert!(write_metadata(&dir.path().join("absent.jpg"), &sample_update()).is_err());
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn concurrent_writes_to_one_file_leave_a_valid_file() {
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();
    let original = jpeg_bytes(32, 32);
    let path = dir.path().join("a.jpg");
    std::fs::write(&path, &original).unwrap();
    let titles: Vec<String> = (0..6).map(|index| format!("Titre {index}")).collect();
    let handles: Vec<_> = titles.iter().cloned().map(|title| {
        let path = path.clone();
        std::thread::spawn(move || write_metadata(&path, &MetadataUpdate { title: Some(title), ..Default::default() }))
    }).collect();
    for handle in handles { handle.join().unwrap().unwrap(); }
    let written = std::fs::read(&path).unwrap();
    assert_eq!(decoded_pixels(&written), decoded_pixels(&original));
    assert!(titles.contains(&read_exif(&path).title), "titre inattendu : {}", read_exif(&path).title);
    assert!(leftovers(dir.path()).is_empty());
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn marking_writes_file_then_catalog_and_keeps_other_values() {
    // write_photo_marking (main.rs, commande update_photos_marking) : le fichier puis la base ; la note seule ne touche ni couleur ni pick.
    if !exiftool_available() { return; }
    let (dir, pool) = temp_catalog();
    let path = dir.path().join("a.jpg");
    std::fs::write(&path, jpeg_bytes(16, 16)).unwrap();
    let path_text = path.to_string_lossy().to_string();
    let id = insert_photo(&pool.get().unwrap(), &path_text);
    let dirs = crate::ImageCacheDirs { thumbnails: dir.path().join("thumbnails"), raw_previews: dir.path().join("raw_previews") };
    std::fs::create_dir_all(&dirs.thumbnails).unwrap();
    std::fs::create_dir_all(&dirs.raw_previews).unwrap();
    let initial_thumbnail = crate::thumbnail_cache_file(&dirs.thumbnails, &path_text).unwrap();
    std::fs::create_dir_all(initial_thumbnail.parent().unwrap()).unwrap();
    std::fs::write(initial_thumbnail, b"miniature").unwrap();

    crate::write_photo_marking(&pool, &dirs, id, &path_text, None, Some(Some("Green")), Some("picked"), Some("green")).unwrap();
    crate::write_photo_marking(&pool, &dirs, id, &path_text, Some(4), None, None, None).unwrap();

    let meta = read_exif(&path);
    assert_eq!((meta.rating, meta.color_flag.as_str(), meta.pick_flag.as_str()), (4, "green", "picked"));
    let stored: (i32, String, String, i64) = pool.get().unwrap()
        .query_row("SELECT rating, color_flag, pick_flag, file_size FROM photos WHERE id = ?1", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .unwrap();
    assert_eq!((stored.0, stored.1.as_str(), stored.2.as_str()), (4, "green", "picked"));
    assert_eq!(stored.3, std::fs::metadata(&path).unwrap().len() as i64, "taille du fichier écrit enregistrée");
    // Le fichier a changé de taille : sa miniature en cache a suivi (pas de régénération au prochain démarrage).
    let thumbnail = crate::thumbnail_cache_file(&dirs.thumbnails, &path_text).unwrap();
    assert_eq!(std::fs::read(&thumbnail).unwrap(), b"miniature");
    assert_eq!(crate::cache_files(&dirs.thumbnails).len(), 1, "aucune miniature orpheline");
    assert!(leftovers(dir.path()).is_empty());
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn gps_is_erased_from_exif_and_xmp_then_restored() {
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();
    let original = jpeg_bytes(16, 16);
    let path = dir.path().join("a.jpg");
    std::fs::write(&path, &original).unwrap();
    // Restauration sur un JPEG sans GPS : EXIF et XMP écrits.
    write_metadata(&path, &MetadataUpdate { gps: Some(Some((-31.92033, 115.797278))), ..Default::default() }).unwrap();
    let meta = read_exif(&path);
    let (exif, xmp) = (meta.gps_sources[0].expect("GPS EXIF écrit"), meta.gps_sources[1].expect("GPS XMP écrit"));
    for (lat, lon) in [exif, xmp] { assert!((lat + 31.92033).abs() < 1e-5 && (lon - 115.797278).abs() < 1e-5, "{lat} {lon}"); }
    // Effacement : plus aucune source, pixels intacts.
    write_metadata(&path, &MetadataUpdate { gps: Some(None), ..Default::default() }).unwrap();
    assert_eq!(read_exif(&path).gps_sources, [None, None]);
    assert_eq!(decoded_pixels(&std::fs::read(&path).unwrap()), decoded_pixels(&original));
    assert!(leftovers(dir.path()).is_empty(), "{:?}", leftovers(dir.path()));
}

/// Same as exif::tests::marking_check_cost with the ExifTool writer.
#[test]
#[ignore = "benchmark: needs a photo (PHOTOBOGGAN_BENCH_PHOTO) and ExifTool"]
fn marking_check_cost_with_exiftool() {
    let Ok(photo) = std::env::var("PHOTOBOGGAN_BENCH_PHOTO") else { return eprintln!("PHOTOBOGGAN_BENCH_PHOTO not set"); };
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();
    let name = Path::new(&photo).file_name().unwrap();
    let copies: Vec<PathBuf> = (0..40).map(|index| {
        let path = dir.path().join(format!("{index}_{}", name.to_string_lossy()));
        std::fs::copy(&photo, &path).unwrap();
        path
    }).collect();
    write_marking(&copies[0], XmpEdit { rating: Some(1), ..Default::default() }).unwrap(); // ExifTool process started outside the timing
    let started = std::time::Instant::now();
    for (index, path) in copies.iter().enumerate() {
        write_marking(path, XmpEdit { rating: Some((index % 5) as i32 + 1), ..Default::default() }).unwrap();
    }
    let write = started.elapsed();
    let started = std::time::Instant::now();
    for path in &copies { std::hint::black_box(crate::exif::read_marking(path)); }
    let check = started.elapsed();
    for path in &copies {
        let (light, full) = (crate::exif::read_marking(path), read_exif(path));
        assert_eq!((light.rating, light.color_flag, light.pick_flag), (full.rating, full.color_flag, full.pick_flag), "{}", path.display());
    }
    eprintln!("ExifTool write: {:.1} ms/file, check (read_marking): {:.2} ms/file, +{:.1} %",
        write.as_secs_f64() * 25.0, check.as_secs_f64() * 25.0, check.as_secs_f64() / write.as_secs_f64() * 100.0);
}

#[test]
fn orientation_is_written_in_xmp_and_in_the_exif_of_jpeg_only() {
    assert_eq!(orientation_args(Path::new("a.JPG"), 6), ["-XMP-tiff:Orientation#=6", "-IFD0:Orientation#=6"]);
    assert_eq!(orientation_args(Path::new("a.cr2"), 8), ["-XMP-tiff:Orientation#=8"], "RAW: sidecar only, the RAW is never written");
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn lossless_rotation_changes_only_the_orientation_tags() {
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();
    let original = jpeg_bytes(40, 30);
    let path = dir.path().join("turned.jpg");
    std::fs::write(&path, &original).unwrap();
    let raw = dir.path().join("turned.cr2");
    std::fs::write(&raw, b"not a real raw, never written").unwrap();

    write_orientation(&path, 6).unwrap();
    write_orientation(&raw, 8).unwrap();

    let written = std::fs::read(&path).unwrap();
    assert_eq!(scan_data(&written), scan_data(&original), "données d'image modifiées");
    assert_eq!(crate::thumbnails::exif_orientation(&path), Some(6));
    assert_eq!(crate::exif::read_xmp_orientation(&path), Some(6));
    assert_eq!(std::fs::read(&raw).unwrap(), b"not a real raw, never written");
    assert_eq!(crate::exif::read_xmp_orientation(&raw), Some(8));
    assert!(leftovers(dir.path()).is_empty(), "{:?}", leftovers(dir.path()));
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn missing_sidecar_image_creates_no_orphan_sidecar() {
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();
    let missing_raw = dir.path().join("absent.cr2");
    assert!(write_metadata(&missing_raw, &sample_update()).is_err());
    assert!(!dir.path().join("absent.cr2.xmp").exists());
    assert!(!dir.path().join("absent.xmp").exists());
    assert!(write_marking(&missing_raw, XmpEdit { rating: Some(4), ..Default::default() }).is_err());
    assert!(!dir.path().join("absent.cr2.xmp").exists());
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn rights_round_trip_in_jpeg_preserves_pixels_and_clears_cleanly() {
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();
    let original = jpeg_bytes(40, 30);
    let path = dir.path().join("rights.jpg");
    std::fs::write(&path, &original).unwrap();
    let update = MetadataUpdate {
        author: Some("Ada Lovelace; Bob".into()),
        copyright: Some("© 2026 Ada Lovelace".into()),
        credit: Some("Agence".into()),
        usage_terms: Some("Usage libre".into()),
        author_email: Some("ada@example.org".into()),
        ..Default::default()
    };
    write_metadata(&path, &update).unwrap();
    let meta = read_exif(&path);
    assert_eq!(meta.rights.author, "Ada Lovelace; Bob");
    assert_eq!(meta.rights.copyright, "© 2026 Ada Lovelace");
    assert_eq!(meta.rights.credit, "Agence");
    assert_eq!(meta.rights.usage_terms, "Usage libre");
    assert_eq!(meta.rights.author_email, "ada@example.org");
    assert!(crate::exif::text_mismatch(&path, &update, &meta).is_none());
    assert_eq!(decoded_pixels(&std::fs::read(&path).unwrap()), decoded_pixels(&original));

    let clear = MetadataUpdate {
        author: Some(String::new()),
        copyright: Some(String::new()),
        credit: Some(String::new()),
        usage_terms: Some(String::new()),
        author_email: Some(String::new()),
        ..Default::default()
    };
    write_metadata(&path, &clear).unwrap();
    let after = read_exif(&path);
    assert_eq!(after.rights, crate::exif::Rights::default());
    assert!(leftovers(dir.path()).is_empty(), "{:?}", leftovers(dir.path()));
}

fn query_exiftool_tag(path: &Path, tag: &str) -> String {
    let output = launcher()
        .unwrap()
        .command()
        .args(["-s3", &format!("-{tag}")])
        .arg("--")
        .arg(path)
        .output()
        .unwrap();
    assert!(output.status.success(), "ExifTool query failed: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn iptc_digest_stays_consistent_on_update_and_clear() {
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("digest.jpg");
    std::fs::write(&path, jpeg_bytes(32, 32)).unwrap();

    // 1. Write initial IPTC fields -> valid 32-hex IPTCDigest matching CurrentIPTCDigest.
    write_metadata(&path, &sample_update()).unwrap();
    let digest_initial = query_exiftool_tag(&path, "Photoshop:IPTCDigest");
    let current_initial = query_exiftool_tag(&path, "CurrentIPTCDigest");
    assert_eq!(digest_initial.len(), 32, "expected 32-hex IPTCDigest, got {digest_initial:?}");
    assert_eq!(digest_initial, current_initial);

    // 2. Update keywords and title -> digest updates and still matches CurrentIPTCDigest.
    let updated = MetadataUpdate {
        keywords: Some(paths(&[&["Voyage", "Lyon"]])),
        title: Some("Nouveau titre".into()),
        ..Default::default()
    };
    write_metadata(&path, &updated).unwrap();
    let digest_updated = query_exiftool_tag(&path, "Photoshop:IPTCDigest");
    let current_updated = query_exiftool_tag(&path, "CurrentIPTCDigest");
    assert_eq!(digest_updated.len(), 32);
    assert_ne!(digest_updated, digest_initial);
    assert_eq!(digest_updated, current_updated);

    // 3. Clear all written IPTC fields -> no error, no stale/mismatched digest.
    let cleared = MetadataUpdate {
        keywords: Some(Vec::new()),
        title: Some(String::new()),
        description: Some(String::new()),
        author: Some(String::new()),
        copyright: Some(String::new()),
        credit: Some(String::new()),
        ..Default::default()
    };
    write_metadata(&path, &cleared).unwrap();
    let digest_cleared = query_exiftool_tag(&path, "Photoshop:IPTCDigest");
    let current_cleared = query_exiftool_tag(&path, "CurrentIPTCDigest");
    eprintln!("After clearing IPTC: Photoshop:IPTCDigest={digest_cleared:?}, CurrentIPTCDigest={current_cleared:?}");
    assert_eq!(digest_cleared, current_cleared);
    assert_ne!(digest_cleared, digest_updated);
    assert!(leftovers(dir.path()).is_empty(), "{:?}", leftovers(dir.path()));
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn face_region_with_hash_special_chars_and_edge_spaces_round_trips() {
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("faces.jpg");
    std::fs::write(&path, jpeg_bytes(100, 100)).unwrap();

    let update = MetadataUpdate {
        regions: Some(crate::exif::RegionsUpdate {
            width: 100,
            height: 100,
            regions: vec![
                crate::exif::RegionWrite { name: Some("Alice #1".into()), x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
                crate::exif::RegionWrite { name: Some("Bob, {C} = [D]|E".into()), x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
                crate::exif::RegionWrite { name: Some("  Edge #2  ".into()), x: 0.7, y: 0.7, w: 0.2, h: 0.2 },
            ],
        }),
        ..Default::default()
    };
    write_metadata(&path, &update).unwrap();

    let was_enabled = crate::faces::reading_enabled();
    crate::faces::set_face_reading(true);
    let meta = read_exif(&path);
    crate::faces::set_face_reading(was_enabled);
    let names: Vec<&str> = meta.faces.regions.as_deref().unwrap_or_default().iter().filter_map(|r| r.name.as_deref()).collect();
    assert!(names.contains(&"Alice #1"), "got {names:?}");
    assert!(names.contains(&"Bob, {C} = [D]|E"), "got {names:?}");

    // Also verify raw XMP-mwg-rs:RegionName via ExifTool JSON (plain text -s3 trims trailing whitespace on output).
    let output = launcher()
        .unwrap()
        .command()
        .args(["-j", "-XMP-mwg-rs:RegionName"])
        .arg("--")
        .arg(&path)
        .output()
        .unwrap();
    let raw_names = String::from_utf8_lossy(&output.stdout);
    assert!(raw_names.contains("\"  Edge #2  \""), "expected edge spaces preserved in {raw_names:?}");
    assert!(leftovers(dir.path()).is_empty(), "{:?}", leftovers(dir.path()));
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn readonly_file_is_refused_without_running_exiftool() {
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();

    // 1. Read-only JPEG
    let jpeg = dir.path().join("ro.jpg");
    let original_jpeg = jpeg_bytes(16, 16);
    std::fs::write(&jpeg, &original_jpeg).unwrap();
    let mut perms = std::fs::metadata(&jpeg).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&jpeg, perms).unwrap();

    let err = write_metadata(&jpeg, &sample_update()).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied, "{err}");
    assert_eq!(std::fs::read(&jpeg).unwrap(), original_jpeg);

    // 2. Read-only existing sidecar
    let raw = dir.path().join("ro.cr2");
    std::fs::write(&raw, b"raw").unwrap();
    write_marking(&raw, XmpEdit { rating: Some(2), ..Default::default() }).unwrap();
    let sidecar = dir.path().join("ro.cr2.xmp");
    let original_sidecar = std::fs::read(&sidecar).unwrap();
    let mut sc_perms = std::fs::metadata(&sidecar).unwrap().permissions();
    sc_perms.set_readonly(true);
    std::fs::set_permissions(&sidecar, sc_perms).unwrap();

    let err = write_marking(&raw, XmpEdit { rating: Some(5), ..Default::default() }).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied, "{err}");
    assert_eq!(std::fs::read(&sidecar).unwrap(), original_sidecar);

    // Restore writable permissions so tempdir cleans up cleanly on Windows.
    #[allow(clippy::permissions_set_readonly_false)]
    {
        let mut p1 = std::fs::metadata(&jpeg).unwrap().permissions();
        p1.set_readonly(false);
        std::fs::set_permissions(&jpeg, p1).unwrap();
        let mut p2 = std::fs::metadata(&sidecar).unwrap().permissions();
        p2.set_readonly(false);
        std::fs::set_permissions(&sidecar, p2).unwrap();
    }
    assert!(leftovers(dir.path()).is_empty(), "{:?}", leftovers(dir.path()));
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn filename_starting_with_dash_is_written_and_read_back() {
    if !exiftool_available() { return; }
    let dir = tempfile::tempdir().unwrap();
    let original = jpeg_bytes(32, 32);
    let path = dir.path().join("-dash.jpg");
    std::fs::write(&path, &original).unwrap();

    write_metadata(&path, &sample_update()).unwrap();

    let written = std::fs::read(&path).unwrap();
    assert_eq!(decoded_pixels(&written), decoded_pixels(&original));
    let meta = read_exif(&path);
    assert_eq!(meta.title, "Titre é & <b>");
    assert!(leftovers(dir.path()).is_empty(), "{:?}", leftovers(dir.path()));
}

#[test]
#[ignore = "intégration : lance ExifTool"]
fn failed_seed_sidecar_write_records_no_false_recovery() {
    if !exiftool_available() { return; }
    let _ = take_recoveries();
    let dir = tempfile::tempdir().unwrap();
    let raw = dir.path().join("photo.cr2");
    let dng = dir.path().join("photo.dng");
    let shared = dir.path().join("photo.xmp");
    std::fs::write(&raw, b"raw").unwrap();
    std::fs::write(&dng, b"dng").unwrap();
    let corrupt_xmp = b"not valid xmp xml at all <<<";
    std::fs::write(&shared, corrupt_xmp).unwrap();

    let result = write_marking(&raw, XmpEdit { rating: Some(4), ..Default::default() });
    assert!(result.is_err(), "expected corrupt seed XMP update to fail");
    assert!(take_recoveries().is_empty(), "seed temp failure must not record a Recovery");
    assert_eq!(std::fs::read(&shared).unwrap(), corrupt_xmp);
    assert!(!dir.path().join("photo.cr2.xmp").exists());
    assert!(leftovers(dir.path()).is_empty(), "{:?}", leftovers(dir.path()));
}
