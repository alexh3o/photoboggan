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
        .filter(|name| name.ends_with("_exiftool_tmp") || name.ends_with(".photoboggan-tmp") || name.contains(".photoboggan-tmp.")).collect()
}

fn sample_update() -> MetadataUpdate {
    MetadataUpdate {
        keywords: Some(paths(&[&["Lieux", "France", "Paris"], &["Animaux"]])),
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
    assert_eq!(keyword_paths, paths(&[&["Animaux"], &["Lieux", "France", "Paris"]]));
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
    std::fs::write(crate::thumbnail_cache_file(&dirs.thumbnails, &path_text).unwrap(), b"miniature").unwrap();

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
    assert_eq!(std::fs::read_dir(&dirs.thumbnails).unwrap().count(), 1, "aucune miniature orpheline");
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
