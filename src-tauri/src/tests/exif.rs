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

/// `photo.xmp` written by the internal path for a lone `seed.png`, then renamed: a compatible-name sidecar with rating 3 and red color.
fn shared_sidecar(dir: &Path) -> PathBuf {
    let seed = write_sample(dir, "seed.png", &png_bytes(8, 8));
    write_xmp_sidecar_with(&seed, &|xml| update_xmp_metadata(xml, XmpEdit { rating: Some(3), label: Some(Some("Red")), pick: None })).unwrap();
    fs::remove_file(&seed).unwrap();
    let shared = dir.join("photo.xmp");
    fs::rename(dir.join("seed.png.xmp"), &shared).unwrap();
    shared
}

#[test]
fn shared_compatible_sidecar_is_never_written_each_image_gets_its_own() {
    let dir = tempfile::tempdir().unwrap();
    let shared = shared_sidecar(dir.path());
    let shared_bytes = fs::read(&shared).unwrap();
    let raw = write_sample(dir.path(), "photo.cr2", b"raw");
    let dng = write_sample(dir.path(), "photo.dng", b"dng");

    write_xmp_sidecar_with(&raw, &|xml| update_xmp_metadata(xml, XmpEdit { rating: Some(5), ..Default::default() })).unwrap();
    assert_eq!(fs::read(&shared).unwrap(), shared_bytes, "the shared photo.xmp was modified");
    assert!(dir.path().join("photo.cr2.xmp").exists(), "no own sidecar created");
    let meta = read_exif(&raw);
    assert_eq!((meta.rating, meta.color_flag.as_str()), (5, "red"), "values of photo.xmp not carried to the own sidecar");
    assert_eq!(read_exif(&dng).rating, 3, "the other image lost its values");

    // A removal sticks: the color no longer comes back from photo.xmp.
    write_xmp_sidecar_with(&raw, &|xml| update_xmp_metadata(xml, XmpEdit { label: Some(None), ..Default::default() })).unwrap();
    assert_eq!(read_exif(&raw).color_flag, "none");
    assert_eq!(read_exif(&dng).color_flag, "red");
    assert!(leftovers(dir.path()).is_empty());
}

#[test]
fn raw_and_jpeg_pair_keeps_writing_the_compatible_sidecar() {
    // The JPEG writes in its own file: photo.xmp belongs to the RAW alone (Lightroom layout), it is updated in place.
    let dir = tempfile::tempdir().unwrap();
    let shared = shared_sidecar(dir.path());
    let before = fs::read(&shared).unwrap();
    let raw = write_sample(dir.path(), "photo.cr2", b"raw");
    write_sample(dir.path(), "photo.jpg", &jpeg_bytes(8, 8));
    write_xmp_sidecar_with(&raw, &|xml| update_xmp_metadata(xml, XmpEdit { rating: Some(5), ..Default::default() })).unwrap();
    assert!(!dir.path().join("photo.cr2.xmp").exists());
    assert_ne!(fs::read(&shared).unwrap(), before, "photo.xmp not updated");
    assert_eq!(read_exif(&raw).rating, 5);
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

// --- Coordonnées GPS (lecture seule) ---

/// Segment APP1 EXIF minimal (TIFF petit-boutiste) : IFD0 avec un pointeur vers un IFD GPS qui porte latitude et longitude en degrés,
/// minutes, secondes (rationnels) et leurs références.
fn exif_gps_segment(latitude: [(u32, u32); 3], latitude_ref: u8, longitude: [(u32, u32); 3], longitude_ref: u8) -> Vec<u8> {
    fn entry(out: &mut Vec<u8>, tag: u16, kind: u16, count: u32, value: [u8; 4]) {
        out.extend(tag.to_le_bytes());
        out.extend(kind.to_le_bytes());
        out.extend(count.to_le_bytes());
        out.extend(value);
    }
    // Disposition : en-tête (8 octets), IFD0 en 8 (1 entrée, fin en 26), IFD GPS en 26 (4 entrées, fin en 80), rationnels en 80 et 104.
    let mut tiff = b"II*\0".to_vec();
    tiff.extend(8u32.to_le_bytes());
    tiff.extend(1u16.to_le_bytes());
    entry(&mut tiff, 0x8825, 4, 1, 26u32.to_le_bytes());
    tiff.extend(0u32.to_le_bytes());
    tiff.extend(4u16.to_le_bytes());
    entry(&mut tiff, 1, 2, 2, [latitude_ref, 0, 0, 0]);
    entry(&mut tiff, 2, 5, 3, 80u32.to_le_bytes());
    entry(&mut tiff, 3, 2, 2, [longitude_ref, 0, 0, 0]);
    entry(&mut tiff, 4, 5, 3, 104u32.to_le_bytes());
    tiff.extend(0u32.to_le_bytes());
    for (numerator, denominator) in latitude.into_iter().chain(longitude) {
        tiff.extend(numerator.to_le_bytes());
        tiff.extend(denominator.to_le_bytes());
    }
    let mut segment = b"Exif\0\0".to_vec();
    segment.extend(tiff);
    segment
}

fn xmp_gps_packet(latitude: &str, longitude: &str) -> String {
    format!("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF><rdf:Description exif:GPSLatitude=\"{latitude}\" exif:GPSLongitude=\"{longitude}\"/></rdf:RDF></x:xmpmeta>")
}

fn with_xmp(jpeg: &[u8], xml: &str) -> Vec<u8> {
    let mut payload = JPEG_XMP_HEADER.to_vec();
    payload.extend(xml.as_bytes());
    with_segment(jpeg, 0xe1, &payload)
}

fn assert_gps(actual: Option<(f64, f64)>, expected: (f64, f64)) {
    let (latitude, longitude) = actual.expect("coordonnées attendues");
    assert!((latitude - expected.0).abs() < 1e-6 && (longitude - expected.1).abs() < 1e-6, "{actual:?} au lieu de {expected:?}");
}

// Paris (48°51'29.6"N 2°17'40.2"E) et Rio de Janeiro (22°54'30"S 43°11'47"W) : les références S et W donnent des valeurs négatives.
#[test]
fn exif_gps_is_converted_to_signed_decimal_degrees() {
    let dir = tempfile::tempdir().unwrap();
    let paris = with_segment(&jpeg_bytes(16, 16), 0xe1, &exif_gps_segment([(48, 1), (51, 1), (296, 10)], b'N', [(2, 1), (17, 1), (402, 10)], b'E'));
    let rio = with_segment(&jpeg_bytes(16, 16), 0xe1, &exif_gps_segment([(22, 1), (54, 1), (30, 1)], b'S', [(43, 1), (11, 1), (47, 1)], b'W'));
    assert_gps(read_exif(&write_sample(dir.path(), "paris.jpg", &paris)).gps, (48.858222, 2.294500));
    assert_gps(read_exif(&write_sample(dir.path(), "rio.jpg", &rio)).gps, (-22.908333, -43.196389));
    assert_eq!(read_exif(&write_sample(dir.path(), "none.jpg", &jpeg_bytes(16, 16))).gps, None);
}

#[test]
fn invalid_exif_gps_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    // Dénominateur nul, latitude hors bornes, position (0, 0) des appareils sans signal.
    let zero_denominator = exif_gps_segment([(48, 0), (0, 1), (0, 1)], b'N', [(2, 1), (0, 1), (0, 1)], b'E');
    let out_of_range = exif_gps_segment([(95, 1), (0, 1), (0, 1)], b'N', [(2, 1), (0, 1), (0, 1)], b'E');
    let null_island = exif_gps_segment([(0, 1), (0, 1), (0, 1)], b'N', [(0, 1), (0, 1), (0, 1)], b'E');
    for (name, segment) in [("a.jpg", zero_denominator), ("b.jpg", out_of_range), ("c.jpg", null_island)] {
        let path = write_sample(dir.path(), name, &with_segment(&jpeg_bytes(16, 16), 0xe1, &segment));
        assert_eq!(read_exif(&path).gps, None, "{name}");
    }
}

#[test]
fn xmp_gps_coordinate_forms() {
    assert_eq!(parse_xmp_gps_coordinate("48,30.5N"), Some(48.508333333333333));
    assert_eq!(parse_xmp_gps_coordinate("48,30,30S"), Some(-48.508333333333333));
    assert_eq!(parse_xmp_gps_coordinate(" 2,15.0w "), Some(-2.25));
    assert_eq!(parse_xmp_gps_coordinate("-12.5"), Some(-12.5));
    assert_eq!(parse_xmp_gps_coordinate("48,-30N"), None);
    assert_eq!(parse_xmp_gps_coordinate("48,30,0,0N"), None);
    assert_eq!(parse_xmp_gps_coordinate("N"), None);
    assert_eq!(parse_xmp_gps_coordinate(""), None);
    assert_eq!(valid_gps(91.0, 0.0), None);
    assert_eq!(valid_gps(10.0, 181.0), None);
    assert_eq!(valid_gps(f64::NAN, 0.0), None);
    assert_eq!(valid_gps(0.0, 0.0), None);
}

#[test]
fn xmp_gps_is_read_from_the_embedded_packet_then_the_sidecar() {
    let dir = tempfile::tempdir().unwrap();
    // Paquet intégré : forme attribut.
    let embedded = write_sample(dir.path(), "a.jpg", &with_xmp(&jpeg_bytes(16, 16), &xmp_gps_packet("45,45.0N", "4,51.0E")));
    assert_gps(read_exif(&embedded).gps, (45.75, 4.85));
    // RAW : sidecar seul, forme élément.
    let raw = write_sample(dir.path(), "b.cr2", b"II*\0 faux raw");
    fs::write(dir.path().join("b.cr2.xmp"), "<x:xmpmeta><rdf:RDF><rdf:Description><exif:GPSLatitude>43,17.7N</exif:GPSLatitude>\
        <exif:GPSLongitude>5,22.2E</exif:GPSLongitude></rdf:Description></rdf:RDF></x:xmpmeta>").unwrap();
    assert_gps(read_exif(&raw).gps, (43.295, 5.37));
    // Vidéo : seul le sidecar est lu.
    let video = write_sample(dir.path(), "c.mp4", b"\0\0\0\x18ftypmp42 fausse video");
    fs::write(dir.path().join("c.mp4.xmp"), xmp_gps_packet("64,8.8N", "21,56.4W")).unwrap();
    assert_gps(read_exif(&video).gps, (64.146667, -21.94));
}

/// Seul test qui change l'ordre de lecture GPS (réglage global) : il le remet par défaut en fin de test.
#[test]
fn gps_read_order_decides_between_exif_and_xmp() {
    let dir = tempfile::tempdir().unwrap();
    let exif_segment = exif_gps_segment([(48, 1), (0, 1), (0, 1)], b'N', [(2, 1), (0, 1), (0, 1)], b'E');
    let both = with_xmp(&with_segment(&jpeg_bytes(16, 16), 0xe1, &exif_segment), &xmp_gps_packet("45,0N", "4,0E"));
    let path = write_sample(dir.path(), "a.jpg", &both);
    let order = |ids: &[&str]| ids.iter().map(|id| id.to_string()).collect::<Vec<_>>();

    // Par défaut le XMP l'emporte (la position écrite par le mode Carte est relue même si l'EXIF en contient une autre).
    assert_gps(read_exif(&path).gps, (45.0, 4.0));
    set_read_priority("gps", &order(&["exif", "xmp"])).unwrap();
    let exif_first = read_exif(&path);
    set_read_priority("gps", &order(&["xmp", "exif"])).unwrap();
    assert_gps(exif_first.gps, (48.0, 2.0));
    assert_gps(exif_first.gps_sources[0], (48.0, 2.0));
    assert_gps(exif_first.gps_sources[1], (45.0, 4.0));
    assert!(set_read_priority("gps", &order(&["exif"])).is_err());
}

#[test]
fn xmp_gps_is_erased_and_restored_by_the_internal_writer() {
    let dir = tempfile::tempdir().unwrap();
    // JPEG : paquet XMP intégré avec position, altitude et version (toutes les propriétés exif:GPS… sont retirées).
    let packet = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description \
        xmlns:exif=\"http://ns.adobe.com/exif/1.0/\" exif:GPSLatitude=\"45,30.0N\" exif:GPSLongitude=\"4,30.0W\" exif:GPSVersionID=\"2.2.0.0\">\
        <exif:GPSAltitude>120/1</exif:GPSAltitude><dc:title>garde</dc:title></rdf:Description></rdf:RDF></x:xmpmeta>";
    let original = with_xmp(&jpeg_bytes(16, 16), packet);
    let path = write_sample(dir.path(), "a.jpg", &original);
    assert_gps(read_exif(&path).gps, (45.5, -4.5));
    write_jpeg_metadata(&path, &MetadataUpdate { gps: Some(None), ..Default::default() }).unwrap();
    let erased = fs::read(&path).unwrap();
    assert_eq!(read_exif(&path).gps, None);
    assert!(!contains(&erased, b"exif:GPS"), "aucune propriété GPS ne doit rester");
    assert!(contains(&erased, b"garde"), "les autres métadonnées sont conservées");
    assert_eq!(decoded_pixels(&erased), decoded_pixels(&original));
    // Restauration : coordonnées réécrites au format XMP de la norme EXIF, relues à l'identique (à l'arrondi près).
    write_jpeg_metadata(&path, &MetadataUpdate { gps: Some(Some((-31.920330, 115.797278))), ..Default::default() }).unwrap();
    assert_gps(read_exif(&path).gps, (-31.920330, 115.797278));

    // RAW : sidecar seulement ; un fichier sans XMP à effacer ne crée rien.
    let raw = write_sample(dir.path(), "b.cr2", b"II*\0 faux raw");
    write_xmp_sidecar_with(&raw, &|xml| update_xmp_all(xml, &MetadataUpdate { gps: Some(None), ..Default::default() })).unwrap();
    assert!(!dir.path().join("b.cr2.xmp").exists());
    write_xmp_sidecar_with(&raw, &|xml| update_xmp_all(xml, &MetadataUpdate { gps: Some(Some((43.295, 5.37))), ..Default::default() })).unwrap();
    assert_gps(read_exif(&raw).gps, (43.295, 5.37));
    assert_eq!(fs::read(&raw).unwrap(), b"II*\0 faux raw", "le RAW n'est jamais modifié");
}

#[test]
fn xmp_gps_coordinate_format() {
    assert_eq!(xmp_gps_coordinate(45.5, 'N', 'S'), "45,30.000000N");
    assert_eq!(xmp_gps_coordinate(-4.25, 'E', 'W'), "4,15.000000W");
    assert_eq!(parse_xmp_gps_coordinate(&xmp_gps_coordinate(-31.920330, 'N', 'S')).map(|value| (value * 1e6).round()), Some(-31920330.0));
}

/// Mode Carte, écriture interne : une nouvelle position remplace l'ancienne (XMP intégré), altitude et direction comprises ; relue en premier
/// (XMP avant EXIF par défaut) même quand l'EXIF du fichier contient une autre position. Pixels et autres métadonnées conservés.
#[test]
fn a_new_xmp_position_replaces_the_previous_one_and_wins_over_the_exif() {
    let dir = tempfile::tempdir().unwrap();
    let packet = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description \
        xmlns:exif=\"http://ns.adobe.com/exif/1.0/\" exif:GPSLatitude=\"45,30.0N\" exif:GPSLongitude=\"4,30.0W\" exif:GPSImgDirection=\"90/1\">\
        <exif:GPSAltitude>120/1</exif:GPSAltitude><dc:title>garde</dc:title></rdf:Description></rdf:RDF></x:xmpmeta>";
    let exif_segment = exif_gps_segment([(48, 1), (51, 1), (0, 1)], b'N', [(2, 1), (21, 1), (0, 1)], b'E');
    let original = with_xmp(&with_segment(&jpeg_bytes(16, 16), 0xe1, &exif_segment), packet);
    let path = write_sample(dir.path(), "a.jpg", &original);
    assert_gps(read_exif(&path).gps, (45.5, -4.5));

    write_jpeg_metadata(&path, &MetadataUpdate { gps: Some(Some((-31.920330, 115.797278))), ..Default::default() }).unwrap();
    let written = fs::read(&path).unwrap();
    let meta = read_exif(&path);
    assert_gps(meta.gps, (-31.920330, 115.797278));
    assert_gps(meta.gps_sources[0], (48.85, 2.35)); // l'EXIF n'est pas modifié par l'écriture interne
    assert!(!contains(&written, b"GPSAltitude") && !contains(&written, b"GPSImgDirection"), "altitude et direction retirées");
    assert!(contains(&written, b"garde"));
    assert_eq!(decoded_pixels(&written), decoded_pixels(&original));
}

#[test]
fn microsoft_namespace_has_trailing_slash_and_old_packets_are_fixed() {
    // Nouveau paquet : l'URI porte le « / » final (sinon ExifTool signale « Fixed incorrect URI for xmlns:MicrosoftPhoto »).
    let created = update_xmp_rating("", 3);
    assert!(created.contains("xmlns:MicrosoftPhoto=\"http://ns.microsoft.com/photo/1.0/\""), "{created}");
    // Paquet écrit par une ancienne version (sans « / ») : corrigé à la prochaine écriture, par le chemin des mots-clés comme par celui de la note.
    let old = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:MicrosoftPhoto=\"http://ns.microsoft.com/photo/1.0\" MicrosoftPhoto:Rating=\"1\"/></rdf:RDF></x:xmpmeta>";
    let rated = update_xmp_rating(old, 5);
    assert!(rated.contains("photo/1.0/\""), "{rated}");
    assert!(!rated.contains("photo/1.0\""), "{rated}");
    let update = MetadataUpdate { title: Some("t".to_string()), ..Default::default() };
    let titled = update_xmp_all(old, &update);
    assert!(titled.contains("photo/1.0/\"") && !titled.contains("photo/1.0\""), "{titled}");
}

#[test]
fn strip_xmp_marks_removes_rating_color_and_pick_but_keeps_the_rest() {
    let xml = r#"<x:xmpmeta><rdf:RDF><rdf:Description xmp:Rating="4" xmp:Label="Red" digiKam:PickLabel="3" xmpDM:pick="1" dc:creator="moi"><xmpDM:good>True</xmpDM:good><acdsee:rating>4</acdsee:rating></rdf:Description></rdf:RDF></x:xmpmeta>"#;
    let stripped = strip_xmp_marks(xml);
    for mark in ["xmp:Rating", "xmp:Label", "PickLabel", "xmpDM:pick", "xmpDM:good", "acdsee:rating"] {
        assert!(!stripped.contains(mark), "{mark} devrait être retiré : {stripped}");
    }
    assert!(stripped.contains(r#"dc:creator="moi""#));
}

// --- Flash ---

/// APP1 Exif minimal (petit-boutien) dont l'IFD Exif ne contient que le tag Flash (0x9209).
fn exif_segment_with_flash(value: u16) -> Vec<u8> {
    let mut tiff = vec![b'I', b'I', 0x2a, 0x00, 8, 0, 0, 0];
    // IFD0 : un seul tag, le pointeur vers l'IFD Exif (0x8769), placé juste après (offset 26).
    tiff.extend_from_slice(&[1, 0, 0x69, 0x87, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0]);
    // IFD Exif : Flash, type SHORT.
    tiff.extend_from_slice(&[1, 0, 0x09, 0x92, 3, 0, 1, 0, 0, 0]);
    tiff.extend_from_slice(&value.to_le_bytes());
    tiff.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(&tiff);
    payload
}

#[test]
fn flash_bit_zero_decides_whether_the_flash_fired() {
    for fired in [0x01, 0x05, 0x09, 0x19, 0x41, 0x59] { assert!(flash_fired(fired), "{fired:#x} : flash déclenché"); }
    for silent in [0x00, 0x10, 0x18, 0x20, 0x30] { assert!(!flash_fired(silent), "{silent:#x} : flash non déclenché"); }
}

#[test]
fn flash_is_read_from_the_exif_tag() {
    let dir = tempfile::tempdir().unwrap();
    for (value, expected) in [(0x19u16, Some(true)), (0x10, Some(false)), (0x20, Some(false))] {
        let jpeg = with_segment(&jpeg_bytes(16, 16), 0xe1, &exif_segment_with_flash(value));
        let path = write_sample(dir.path(), &format!("flash-{value}.jpg"), &jpeg);
        assert_eq!(read_exif(&path).flash, expected, "tag Flash {value:#x}");
    }
}

#[test]
fn flash_is_unknown_without_exif_tag_and_falls_back_on_xmp() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_sample(dir.path(), "plain.jpg", &jpeg_bytes(16, 16));
    assert_eq!(read_exif(&path).flash, None, "aucune information : inconnu, pas « sans flash »");

    // XMP sidecar : exif:Fired en élément, puis en attribut.
    fs::write(dir.path().join("plain.jpg.xmp"), "<x:xmpmeta><rdf:Description><exif:Flash rdf:parseType=\"Resource\"><exif:Fired>True</exif:Fired></exif:Flash></rdf:Description></x:xmpmeta>").unwrap();
    assert_eq!(read_exif(&path).flash, Some(true));
    fs::write(dir.path().join("plain.jpg.xmp"), "<x:xmpmeta><rdf:Description><exif:Flash exif:Fired=\"False\"/></rdf:Description></x:xmpmeta>").unwrap();
    assert_eq!(read_exif(&path).flash, Some(false));

    // Le tag EXIF fait foi sur le XMP.
    let jpeg = with_segment(&jpeg_bytes(16, 16), 0xe1, &exif_segment_with_flash(0x01));
    let with_tag = write_sample(dir.path(), "tagged.jpg", &jpeg);
    fs::write(dir.path().join("tagged.jpg.xmp"), "<x:xmpmeta><rdf:Description><exif:Fired>False</exif:Fired></rdf:Description></x:xmpmeta>").unwrap();
    assert_eq!(read_exif(&with_tag).flash, Some(true));
}

/// TIFF/EXIF segment holding only IFD0 ImageDescription (ASCII, 4 bytes stored inline in the entry).
fn exif_image_description_segment(text: [u8; 4]) -> Vec<u8> {
    let mut tiff = b"II*\0".to_vec();
    tiff.extend(8u32.to_le_bytes());
    tiff.extend(1u16.to_le_bytes());
    tiff.extend(0x010eu16.to_le_bytes());
    tiff.extend(2u16.to_le_bytes());
    tiff.extend(4u32.to_le_bytes());
    tiff.extend(text);
    tiff.extend(0u32.to_le_bytes());
    let mut segment = b"Exif\0\0".to_vec();
    segment.extend(tiff);
    segment
}

// Internal writer + "do not read EXIF metadata": the EXIF description is ignored, camera data stays. Changes the global writer setting, so it
// does not run with the fast tests: `cargo test skipped_exif -- --ignored`.
#[test]
#[ignore = "changes the global metadata writer setting"]
fn skipped_exif_metadata_is_not_read_with_the_internal_writer() {
    let dir = tempfile::tempdir().unwrap();
    let jpeg = with_segment(&jpeg_bytes(16, 16), 0xe1, &exif_image_description_segment(*b"Hey\0"));
    let path = write_sample(dir.path(), "described.jpg", &jpeg);
    crate::exiftool::set_metadata_writer("internal".into(), None, false).unwrap();
    assert_eq!(read_exif(&path).caption, "Hey", "internal writer, option off: EXIF description read");
    crate::exiftool::set_metadata_writer("internal".into(), None, true).unwrap();
    assert_eq!(read_exif(&path).caption, "", "internal writer, option on: EXIF description ignored");
    crate::exiftool::set_metadata_writer("exiftool".into(), None, true).unwrap();
    assert_eq!(read_exif(&path).caption, "Hey", "ExifTool active: the option has no effect");
}
