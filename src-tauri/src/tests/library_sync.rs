//! Tests de la synchronisation incrémentale (library_sync.rs) : détection des ajouts, modifications et suppressions, sans jamais prendre
//! un disque absent pour une suppression.

use super::*;
use crate::db::{add_folder, get_photos};
use crate::test_support::*;
use std::path::PathBuf;

fn photo_count(pool: &DbPool) -> i64 {
    pool.get().unwrap().query_row("SELECT COUNT(*) FROM photos", [], |row| row.get(0)).unwrap()
}

fn sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort();
    list
}

/// Chemins complets (séparateurs de l'OS) des fichiers `names` (séparés par « / ») du dossier `dir`.
fn full_paths(dir: &Path, names: &[&str]) -> Vec<String> {
    sorted(names.iter().map(|name| names_path(dir, name)).collect())
}

fn names_path(dir: &Path, name: &str) -> String {
    name.split('/').fold(dir.to_path_buf(), |path, part| path.join(part)).to_string_lossy().to_string()
}

#[test]
fn supported_extensions_ignore_case_and_sidecars() {
    for name in ["a.jpg", "a.JPG", "a.CR2", "a.heic", "a.mp4"] { assert!(is_photo_file(Path::new(name)), "{name}"); }
    for name in ["a.xmp", "a.txt", "a", "a.jpg.xmp", "Thumbs.db"] { assert!(!is_photo_file(Path::new(name)), "{name}"); }
}

#[test]
fn read_photo_refuses_unreadable_or_changing_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.jpg");
    fs::write(&path, jpeg_bytes(16, 16)).unwrap();
    let metadata = fs::metadata(&path).unwrap();
    let (size, modified) = (metadata.len() as i64, modified_millis(&metadata));
    let (photo, _, _) = read_photo(&path.to_string_lossy(), size, modified).unwrap();
    assert_eq!((photo.filename.as_str(), photo.width, photo.height, photo.file_size), ("a.jpg", 16, 16, size));
    // Taille ou date différentes de celles du parcours : le fichier a changé pendant la lecture, il ne doit pas être enregistré.
    assert!(read_photo(&path.to_string_lossy(), size + 1, modified).is_err());
    assert!(read_photo(&path.to_string_lossy(), size, modified + 1).is_err());
    assert!(read_photo(&dir.path().join("absente.jpg").to_string_lossy(), 0, 0).is_err());
}

/// Coordonnées GPS : lues avec la photo, enregistrées en base, et effacées à la relecture d'un fichier qui n'en a plus.
#[test]
fn gps_is_stored_and_cleared_by_a_re_read() {
    let dir = tempfile::tempdir().unwrap();
    let (_catalog_dir, pool) = temp_catalog();
    let path = dir.path().join("a.jpg");
    let read_and_store = |bytes: &[u8]| {
        fs::write(&path, bytes).unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let (photo, _, _) = read_photo(&path.to_string_lossy(), metadata.len() as i64, modified_millis(&metadata)).unwrap();
        crate::insert_batch(&pool.get().unwrap(), &[photo]).unwrap();
        let photos = crate::db::get_photos(&pool, 0, 10, None, true).unwrap();
        (photos[0].gps_lat, photos[0].gps_lon)
    };
    let mut xmp = b"http://ns.adobe.com/xap/1.0/\0".to_vec();
    xmp.extend(b"<x:xmpmeta><rdf:RDF><rdf:Description exif:GPSLatitude=\"45,30.0N\" exif:GPSLongitude=\"4,30.0W\"/></rdf:RDF></x:xmpmeta>");
    assert_eq!(read_and_store(&with_segment(&jpeg_bytes(16, 16), 0xe1, &xmp)), (Some(45.5), Some(-4.5)));
    assert_eq!(read_and_store(&jpeg_bytes(16, 16)), (None, None));
}

/// Un seul scénario : `sync_library` n'accepte qu'un passage à la fois (verrou global), des tests parallèles s'annuleraient mutuellement.
#[test]
fn sync_detects_added_modified_removed_and_never_trusts_a_missing_disk() {
    let (_catalog, pool) = temp_catalog();
    let photos = tempfile::tempdir().unwrap();
    let root = photos.path();
    fs::write(root.join("a.jpg"), jpeg_bytes(16, 16)).unwrap();
    fs::write(root.join("b.jpg"), jpeg_bytes(24, 24)).unwrap();
    fs::write(root.join("notes.txt"), b"pas une photo").unwrap();
    add_folder(&pool, &root.to_string_lossy()).unwrap();

    let first = sync_library(&pool).unwrap();
    assert_eq!(sorted(first.added), full_paths(root, &["a.jpg", "b.jpg"]));
    assert!(first.updated.is_empty() && first.removed.is_empty());
    assert_eq!(photo_count(&pool), 2);

    let again = sync_library(&pool).unwrap();
    assert!(again.added.is_empty() && again.updated.is_empty() && again.removed.is_empty(), "une synchro sans changement ne doit rien relire");

    // Fichier modifié (taille différente) : relu.
    fs::write(root.join("a.jpg"), jpeg_bytes(48, 48)).unwrap();
    let modified = sync_library(&pool).unwrap();
    assert_eq!(modified.updated, full_paths(root, &["a.jpg"]));
    let stored = get_photos(&pool, 0, 10, None, true).unwrap();
    assert_eq!(stored.iter().find(|photo| photo.filename == "a.jpg").map(|photo| photo.width), Some(48));

    // Fichier supprimé et nouveau fichier dans un sous-dossier.
    fs::remove_file(root.join("b.jpg")).unwrap();
    fs::create_dir(root.join("sub")).unwrap();
    fs::write(root.join("sub").join("c.jpg"), jpeg_bytes(16, 16)).unwrap();
    let changes = sync_library(&pool).unwrap();
    assert_eq!(changes.removed, full_paths(root, &["b.jpg"]));
    assert_eq!(changes.added, full_paths(root, &["sub/c.jpg"]));
    assert_eq!(photo_count(&pool), 2);

    // Dossier suivi injoignable (disque débranché : même le dossier parent est absent) : ses photos restent au catalogue.
    let other_disk = tempfile::tempdir().unwrap();
    let ghost_root: PathBuf = other_disk.path().join("disque-absent").join("Photos");
    let ghost_path = ghost_root.join("x.jpg").to_string_lossy().to_string();
    add_folder(&pool, &ghost_root.to_string_lossy()).unwrap();
    insert_photo(&pool.get().unwrap(), &ghost_path);
    let unplugged = sync_library(&pool).unwrap();
    assert!(unplugged.removed.is_empty(), "photos du disque absent retirées : {:?}", unplugged.removed);
    assert_eq!(photo_count(&pool), 3);
}
