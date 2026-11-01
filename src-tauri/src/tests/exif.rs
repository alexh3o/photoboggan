//! Tests de non-régression de l'écriture et de la lecture des métadonnées (exif.rs) : intégrité des pixels, écritures atomiques, sidecars, marquages.
//! Fichiers synthétiques dans un dossier temporaire ; les photos de l'utilisateur ne sont jamais touchées.
//! Le chemin ExifTool est testé à part (tests/exiftool.rs) : ici, uniquement les fonctions d'écriture internes, sans réglage global.

use super::*;
use crate::test_support::*;
use std::path::PathBuf;

fn write_sample(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).unwrap();
    path
}

fn keyword_update(list: &[&[&str]]) -> MetadataUpdate {
    MetadataUpdate { keywords: Some(paths(list)), ..Default::default() }
}

fn sorted(mut list: Vec<Vec<String>>) -> Vec<Vec<String>> {
    list.sort();
    list
}

/// Marquage (note, couleur, pick) d'un JPEG par le chemin interne : même enchaînement que write_xmp_metadata, sans passer par l'aiguillage
/// ExifTool (réglage global partagé entre les tests).
fn mark_jpeg(path: &Path, edit: XmpEdit) {
    let data = fs::read(path).unwrap();
    let output = jpeg_replace_xmp(&data, &|xml| update_xmp_metadata(xml, edit)).unwrap();
    if output != data { write_file_atomically(path, &output).unwrap(); }
}

/// Fichiers temporaires laissés par une écriture (interne ou ExifTool).
fn leftovers(dir: &Path) -> Vec<String> {
    fs::read_dir(dir).unwrap().filter_map(|entry| entry.ok()).map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".photoboggan-tmp") || name.ends_with("_exiftool_tmp")).collect()
}

// --- Protection des données image ---

#[test]
fn jpeg_write_never_touches_pixels_nor_foreign_segments() {
    let dir = tempfile::tempdir().unwrap();
    let exif_segment = b"Exif\0\0fake-exif-payload-0123456789";
    let icc_segment = b"ICC_PROFILE\0\x01\x01fake-icc";
    let original = with_segment(&with_segment(&jpeg_bytes(40, 30), 0xe1, exif_segment), 0xe2, icc_segment);
    let path = write_sample(dir.path(), "a.jpg", &original);

    let update = MetadataUpdate {
        keywords: Some(paths(&[&["Lieux", "France", "Paris"], &["Animaux"]])),
        title: Some("Titre".into()),
        description: Some("Une description".into()),
        ..Default::default()
    };
    write_jpeg_metadata(&path, &update).unwrap();

    let written = fs::read(&path).unwrap();
    assert_ne!(written, original, "le fichier devait changer");
    assert_eq!(scan_data(&written), scan_data(&original), "les données d'image ont changé");
    assert_eq!(decoded_pixels(&written), decoded_pixels(&original));
    assert!(contains(&written, exif_segment), "segment EXIF perdu");
    assert!(contains(&written, icc_segment), "profil ICC perdu");
    assert!(leftovers(dir.path()).is_empty());
}

#[test]
fn jpeg_metadata_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_sample(dir.path(), "a.jpg", &jpeg_bytes(32, 24));
    let update = MetadataUpdate {
        keywords: Some(paths(&[&["Lieux", "France", "Paris"], &["Animaux"]])),
        title: Some("Mon titre".into()),
        description: Some("Ma description".into()),
        ..Default::default()
    };
    write_jpeg_metadata(&path, &update).unwrap();

    let meta = read_exif(&path);
    assert_eq!(sorted(meta.keyword_paths.clone()), sorted(paths(&[&["Lieux", "France", "Paris"], &["Animaux"]])));
    assert_eq!(meta.title, "Mon titre");
    assert_eq!(meta.caption, "Ma description");
    assert_eq!((meta.width, meta.height), (32, 24));
}

#[test]
fn jpeg_identical_rewrite_leaves_file_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_sample(dir.path(), "a.jpg", &jpeg_bytes(16, 16));
    let update = keyword_update(&[&["Un"], &["Deux"]]);
    write_jpeg_metadata(&path, &update).unwrap();
    let first = fs::read(&path).unwrap();
    write_jpeg_metadata(&path, &update).unwrap();
    assert_eq!(fs::read(&path).unwrap(), first);
}

#[test]
fn keywords_are_replaced_not_accumulated_and_none_means_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_sample(dir.path(), "a.jpg", &jpeg_bytes(16, 16));
    write_jpeg_metadata(&path, &keyword_update(&[&["Lieux", "Paris"], &["Animaux"]])).unwrap();

    // Titre seul : les mots-clés ne bougent pas.
    write_jpeg_metadata(&path, &MetadataUpdate { title: Some("T".into()), ..Default::default() }).unwrap();
    assert_eq!(sorted(read_exif(&path).keyword_paths), sorted(paths(&[&["Lieux", "Paris"], &["Animaux"]])));

    // Nouvelle liste : l'ancienne disparaît de tous les formats, IPTC compris.
    write_jpeg_metadata(&path, &keyword_update(&[&["Animaux"]])).unwrap();
    let meta = read_exif(&path);
    assert_eq!(meta.keyword_paths, paths(&[&["Animaux"]]));
    assert!(!meta.keywords.contains("Paris"), "mot-clé retiré encore présent : {}", meta.keywords);

    // Liste vide : tout est retiré.
    write_jpeg_metadata(&path, &keyword_update(&[])).unwrap();
    let meta = read_exif(&path);
    assert!(meta.keyword_paths.is_empty());
    assert!(meta.keywords.is_empty());
}

#[test]
fn empty_title_and_description_remove_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_sample(dir.path(), "a.jpg", &jpeg_bytes(16, 16));
    let set = MetadataUpdate { title: Some("T".into()), description: Some("D".into()), ..Default::default() };
    write_jpeg_metadata(&path, &set).unwrap();
    let clear = MetadataUpdate { title: Some(String::new()), description: Some(String::new()), ..Default::default() };
    write_jpeg_metadata(&path, &clear).unwrap();
    let meta = read_exif(&path);
    assert_eq!((meta.title.as_str(), meta.caption.as_str()), ("", ""));
}

#[test]
fn special_characters_survive_xml_and_iptc() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_sample(dir.path(), "a.jpg", &jpeg_bytes(16, 16));
    let wanted = paths(&[&["R&D <1> \"x\"", "Été & café"]]);
    write_jpeg_metadata(&path, &MetadataUpdate { keywords: Some(wanted.clone()), title: Some("A & B <c>".into()), ..Default::default() }).unwrap();
    let meta = read_exif(&path);
    assert_eq!(meta.keyword_paths, wanted);
    assert_eq!(meta.title, "A & B <c>");
}

#[test]
fn marking_keeps_other_metadata_and_other_marks() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_sample(dir.path(), "a.jpg", &jpeg_bytes(16, 16));
    write_jpeg_metadata(&path, &MetadataUpdate { keywords: Some(paths(&[&["Garde"]])), title: Some("Titre".into()), ..Default::default() }).unwrap();
    mark_jpeg(&path, XmpEdit { rating: Some(4), label: Some(Some("Red")), pick: None });
    // Un second marquage ne touche que ce qu'il demande.
    mark_jpeg(&path, XmpEdit { rating: Some(2), ..Default::default() });

    let meta = read_exif(&path);
    assert_eq!(meta.rating, 2);
    assert_eq!(meta.color_flag, "red");
    assert_eq!(meta.keyword_paths, paths(&[&["Garde"]]));
    assert_eq!(meta.title, "Titre");

    mark_jpeg(&path, XmpEdit { rating: Some(0), label: Some(None), pick: None });
    let meta = read_exif(&path);
    assert_eq!(meta.rating, 0);
    assert_eq!(meta.color_flag, "none");
}

#[test]
fn pick_flag_round_trip_for_each_state() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_sample(dir.path(), "a.jpg", &jpeg_bytes(16, 16));
    for state in ["picked", "rejected", "pending", "none"] {
        mark_jpeg(&path, XmpEdit { pick: Some(normalize_pick_flag(state).unwrap()), ..Default::default() });
        assert_eq!(read_exif(&path).pick_flag, state, "état {state}");
    }
}

#[test]
fn marking_removal_never_creates_a_packet() {
    let dir = tempfile::tempdir().unwrap();
    let original = jpeg_bytes(16, 16);
    let path = write_sample(dir.path(), "a.jpg", &original);
    mark_jpeg(&path, XmpEdit { rating: None, label: Some(None), pick: Some("none") });
    assert_eq!(fs::read(&path).unwrap(), original);
}

/// Une note 0 n'est qu'un retrait : sur un fichier sans XMP, ni paquet (JPEG) ni sidecar ne sont créés, comme avec ExifTool.
#[test]
fn rating_zero_on_a_file_without_xmp_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let original = jpeg_bytes(16, 16);
    let path = write_sample(dir.path(), "a.jpg", &original);
    mark_jpeg(&path, XmpEdit { rating: Some(0), ..Default::default() });
    assert!(fs::read(&path).unwrap() == original, "un paquet XMP a été créé pour une note 0");

    let raw = write_sample(dir.path(), "b.cr2", b"raw");
    write_xmp_sidecar_with(&raw, &|xml| update_xmp_metadata(xml, XmpEdit { rating: Some(0), ..Default::default() })).unwrap();
    assert!(!dir.path().join("b.cr2.xmp").exists(), "un sidecar a été créé pour une note 0");

    // Sur un fichier qui a déjà du XMP, la note 0 reste écrite explicitement.
    mark_jpeg(&path, XmpEdit { rating: Some(3), ..Default::default() });
    mark_jpeg(&path, XmpEdit { rating: Some(0), ..Default::default() });
    assert_eq!(read_exif(&path).rating, 0);
}

#[test]
fn region_round_trip_in_xmp() {
    let update = RegionsUpdate {
        regions: vec![RegionWrite { name: Some("Alice".into()), x: 0.25, y: 0.125, w: 0.5, h: 0.25 }],
        width: 400,
        height: 300,
    };
    let xml = update_xmp_regions("", &update);
    let read = crate::faces::parse_regions(&xml);
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].name.as_deref(), Some("Alice"));
    for (got, wanted) in [(read[0].x, 0.25), (read[0].y, 0.125), (read[0].w, 0.5), (read[0].h, 0.25)] {
        assert!((got - wanted).abs() < 1e-3, "{got} != {wanted}");
    }
}

// --- Refus des fichiers invalides, écritures atomiques ---

#[test]
fn invalid_jpeg_is_refused_and_left_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_sample(dir.path(), "faux.jpg", b"ceci n'est pas un JPEG");
    let result = write_jpeg_metadata(&path, &keyword_update(&[&["X"]]));
    assert!(result.is_err());
    assert_eq!(fs::read(&path).unwrap(), b"ceci n'est pas un JPEG");
    assert!(leftovers(dir.path()).is_empty());
}

#[test]
fn truncated_jpeg_never_panics_and_failure_leaves_it_intact() {
    let dir = tempfile::tempdir().unwrap();
    let full = jpeg_bytes(64, 64);
    for cut in [2, 5, 20, full.len() / 2, full.len() - 1] {
        let original = full[..cut].to_vec();
        let path = write_sample(dir.path(), "cut.jpg", &original);
        let update = MetadataUpdate { title: Some("T".into()), keywords: Some(paths(&[&["K"]])), ..Default::default() };
        let result = write_jpeg_metadata(&path, &update);
        let after = fs::read(&path).unwrap();
        if result.is_err() { assert_eq!(after, original, "échec mais fichier modifié (coupe à {cut})"); }
        assert!(after.starts_with(&[0xff, 0xd8]));
        assert!(leftovers(dir.path()).is_empty());
        let _ = read_exif(&path); // la lecture d'un fichier tronqué ne doit pas paniquer
    }
}

#[test]
fn atomic_write_replaces_without_leftover() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_sample(dir.path(), "a.bin", b"ancien");
    write_file_atomically(&path, b"nouveau").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"nouveau");
    assert!(leftovers(dir.path()).is_empty());
}

#[test]
fn atomic_write_failure_cleans_up_and_keeps_target() {
    let dir = tempfile::tempdir().unwrap();
    // La cible est un dossier : le remplacement échoue après l'écriture du temporaire.
    let target = dir.path().join("cible");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("contenu.txt"), b"x").unwrap();
    assert!(write_file_atomically(&target, b"octets").is_err());
    assert!(target.join("contenu.txt").exists());
    assert!(leftovers(dir.path()).is_empty());
    // Dossier parent absent : erreur nette, aucune trace.
    assert!(write_file_atomically(&dir.path().join("absent").join("f.jpg"), b"x").is_err());
}

// --- Sidecars XMP ---

#[test]
fn raw_gets_a_sidecar_and_the_original_is_never_modified() {
    let dir = tempfile::tempdir().unwrap();
    let raw = b"II*\0fake raw data \xff\xd8".to_vec();
    let path = write_sample(dir.path(), "IMG.2024.cr2", &raw);
    let update = MetadataUpdate { keywords: Some(paths(&[&["Voyage", "Rome"]])), title: Some("Colisée".into()), ..Default::default() };
    write_xmp_sidecar_with(&path, &|xml| update_xmp_all(xml, &update)).unwrap();
    write_xmp_sidecar_with(&path, &|xml| update_xmp_metadata(xml, XmpEdit { rating: Some(5), ..Default::default() })).unwrap();

    assert_eq!(fs::read(&path).unwrap(), raw);
    assert!(dir.path().join("IMG.2024.cr2.xmp").exists());
    assert!(!dir.path().join("IMG.2024.xmp").exists());
    let meta = read_exif(&path);
    assert_eq!(meta.keyword_paths, paths(&[&["Voyage", "Rome"]]));
    assert_eq!(meta.title, "Colisée");
    assert_eq!(meta.rating, 5);
    assert!(leftovers(dir.path()).is_empty());
}

#[test]
fn existing_compatible_sidecar_is_reused() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_sample(dir.path(), "photo.png", &png_bytes(8, 8));
    let compatible = dir.path().join("photo.xmp");
    write_xmp_sidecar_with(&path, &|xml| update_xmp_metadata(xml, XmpEdit { rating: Some(3), ..Default::default() })).unwrap();
    fs::rename(dir.path().join("photo.png.xmp"), &compatible).unwrap();

    write_xmp_sidecar_with(&path, &|xml| update_xmp_metadata(xml, XmpEdit { rating: Some(1), ..Default::default() })).unwrap();
    assert!(compatible.exists());
    assert!(!dir.path().join("photo.png.xmp").exists(), "un second sidecar a été créé");
    assert_eq!(read_exif(&path).rating, 1);
}

#[test]
fn removal_alone_does_not_create_a_sidecar() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_sample(dir.path(), "a.cr2", b"raw");
    write_xmp_sidecar_with(&path, &|xml| update_xmp_metadata(xml, XmpEdit { rating: None, label: Some(None), pick: Some("none") })).unwrap();
    assert!(!dir.path().join("a.cr2.xmp").exists());
}

#[test]
fn sidecar_names_replace_only_the_last_extension() {
    let [appended, compatible] = sidecar_candidates(Path::new("d/IMG.2024.cr2"));
    assert_eq!(appended, PathBuf::from("d/IMG.2024.cr2.xmp"));
    assert_eq!(compatible, PathBuf::from("d/IMG.2024.xmp"));
}

// --- Fonctions pures ---

#[test]
fn color_and_pick_normalization() {
    assert_eq!(normalize_color_flag(" Purple "), "magenta");
    assert_eq!(normalize_color_flag("GRAY"), "grey");
    assert_eq!(normalize_color_flag("inconnu"), "none");
    assert_eq!(label_for_color_flag("none").unwrap(), None);
    assert!(label_for_color_flag("fuchsia").is_err());
    assert_eq!(normalize_pick_flag("").unwrap(), "none");
    assert!(normalize_pick_flag("favori").is_err());
    assert_eq!(pick_values("picked"), (3, 1, Some("True")));
    assert_eq!(pick_values("rejected"), (1, -1, Some("False")));
    assert_eq!(pick_values("pending"), (2, 0, None));
    assert_eq!(pick_values("none"), (0, 0, None));
}

#[test]
fn microsoft_rating_percentages_map_to_stars() {
    let stars: Vec<i32> = [-1, 0, 1, 12, 13, 25, 37, 38, 50, 62, 63, 75, 87, 88, 99, 100].iter().map(|p| stars_from_percent(*p)).collect();
    assert_eq!(stars, [0, 0, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5]);
}

#[test]
fn read_order_must_list_each_source_exactly_once() {
    let ids = ["a", "b", "c"];
    let order = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(order_indices(&ids, &order(&["c", "a", "b"])).unwrap(), [2, 0, 1]);
    assert!(order_indices(&ids, &order(&["a", "a", "b"])).is_err());
    assert!(order_indices(&ids, &order(&["a", "b"])).is_err());
    assert!(order_indices(&ids, &order(&["a", "b", "z"])).is_err());
}

#[test]
fn xml_entities_and_text_helpers() {
    assert_eq!(decode_xml_entities("a &amp; b &lt;c&gt; &#233; &#xE9; &inconnu; &"), "a & b <c> é é &inconnu; &");
    assert_eq!(clean_text("  a\r\nb\0 "), Some("a\nb".to_string()));
    assert_eq!(clean_text("   "), None);
    assert_eq!(clean_title("a\nb"), Some("a b".to_string()));
    assert_eq!(clean_exif_description("sony dsc"), None);
    assert_eq!(truncate_utf8("éééé", 5), "éé");
    assert_eq!(truncate_utf8("abc", 10), "abc");
}

#[test]
fn keyword_leaves_deduplicate_ignoring_case() {
    let leaves = keyword_leaves(&paths(&[&["A", "Paris"], &["B", "paris"], &["Chat"]]));
    assert_eq!(leaves, ["Paris", "Chat"]);
}

#[test]
fn acdsee_categories_round_trip() {
    let wanted = paths(&[&["Lieux", "France", "Paris"], &["Lieux", "Rome"], &["Animaux"]]);
    let value = acdsee_categories_value(&wanted);
    let xml = format!("<x:xmpmeta><rdf:RDF><rdf:Description acdsee:categories=\"{}\"/></rdf:RDF></x:xmpmeta>", xml_escape_text(&value).replace('"', "&quot;"));
    assert_eq!(sorted(acdsee_category_paths(&xml)), sorted(wanted));
}
