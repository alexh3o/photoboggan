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

#[test]
fn cached_images_follow_a_rewritten_file() {
    let dir = tempfile::tempdir().unwrap();
    let dirs = cache_dirs(dir.path());
    let photo = dir.path().join("a.jpg");
    fs::write(&photo, jpeg_bytes(16, 16)).unwrap();
    let path = photo.to_string_lossy().to_string();
    let old_thumbnail = thumbnail_cache_file(&dirs.thumbnails, &path).unwrap();
    let old_preview = raw_preview_cache_file(&dirs.raw_previews, &path).unwrap();
    fs::write(&old_thumbnail, b"miniature").unwrap();
    fs::write(&old_preview, b"apercu").unwrap();

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
    fs::write(&thumbnail, b"miniature").unwrap();

    // RAW : seul le sidecar est écrit, le fichier ne change pas : la miniature ne doit surtout pas être supprimée.
    keep_cached_images(&dirs, &path, || fs::write(dir.path().join("b.cr2.xmp"), b"<x/>").map_err(|e| e.to_string())).unwrap();
    assert_eq!(fs::read(&thumbnail).unwrap(), b"miniature");

    // Échec d'écriture : l'erreur remonte et le cache n'est pas touché.
    let error = keep_cached_images(&dirs, &path, || Err::<(), _>("refusé".to_string())).unwrap_err();
    assert_eq!(error, "refusé");
    assert_eq!(fs::read(&thumbnail).unwrap(), b"miniature");
}
