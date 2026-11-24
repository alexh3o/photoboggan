//! Regression tests for metadata reading, normalization, priorities, and XMP helpers (exif.rs).
//! Synthetic files in a temporary folder; ExifTool writes are tested in tests/exiftool.rs.

use super::*;
use crate::test_support::*;
use std::path::PathBuf;

fn sorted(mut list: Vec<Vec<String>>) -> Vec<Vec<String>> {
    list.sort();
    list
}

fn write_sample(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).unwrap();
    path
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

#[test]
fn sidecar_names_replace_only_the_last_extension() {
    let [appended, compatible] = sidecar_candidates(Path::new("d/IMG.2024.cr2"));
    assert_eq!(appended, PathBuf::from("d/IMG.2024.cr2.xmp"));
    assert_eq!(compatible, PathBuf::from("d/IMG.2024.xmp"));
}

#[test]
fn sidecar_target_from_entries_matches_case_insensitively() {
    let image = Path::new("d/IMG_001.CR2");
    let [appended, compatible] = sidecar_candidates(image);

    // Case-variant appended sidecar (`IMG_001.CR2.XMP`) is reused in place.
    let entries = vec![image.to_path_buf(), PathBuf::from("d/IMG_001.CR2.XMP")];
    let target = sidecar_target_from_dir_entries(image, &appended, &compatible, Some(&entries));
    assert_eq!(target.path, PathBuf::from("d/IMG_001.CR2.XMP"));
    assert!(target.exists);
    assert_eq!(target.seed, None);

    // Case-variant compatible sidecar (`IMG_001.XMP`) without sibling is reused in place.
    let entries = vec![image.to_path_buf(), PathBuf::from("d/IMG_001.XMP")];
    let target = sidecar_target_from_dir_entries(image, &appended, &compatible, Some(&entries));
    assert_eq!(target.path, PathBuf::from("d/IMG_001.XMP"));
    assert!(target.exists);
    assert_eq!(target.seed, None);

    // Case-variant compatible sidecar shared with another sidecar writer seeds `IMG_001.CR2.xmp`.
    let entries = vec![image.to_path_buf(), PathBuf::from("d/IMG_001.DNG"), PathBuf::from("d/IMG_001.XMP")];
    let target = sidecar_target_from_dir_entries(image, &appended, &compatible, Some(&entries));
    assert_eq!(target.path, appended);
    assert!(!target.exists);
    assert_eq!(target.seed, Some(PathBuf::from("d/IMG_001.XMP")));

    // Case-variant compatible sidecar paired only with a JPEG stays shared as intended.
    let entries = vec![image.to_path_buf(), PathBuf::from("d/IMG_001.JPG"), PathBuf::from("d/IMG_001.XMP")];
    let target = sidecar_target_from_dir_entries(image, &appended, &compatible, Some(&entries));
    assert_eq!(target.path, PathBuf::from("d/IMG_001.XMP"));
    assert!(target.exists);
    assert_eq!(target.seed, None);
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
    assert_eq!(decode_xml_entities("a &amp; b &lt;c&gt; &#233; &#xE9; &#39; &inconnu; &"), "a & b <c> é é ' &inconnu; &");
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
fn strip_xmp_marks_removes_rating_color_and_pick_but_keeps_the_rest() {
    let xml = r#"<x:xmpmeta><rdf:RDF><rdf:Description xmp:Rating="4" xmp:Label="Red" digiKam:PickLabel="3" xmpDM:pick="1" dc:creator="moi"><xmpDM:good>True</xmpDM:good><acdsee:rating>4</acdsee:rating></rdf:Description></rdf:RDF></x:xmpmeta>"#;
    let stripped = strip_xmp_marks(xml);
    for mark in ["xmp:Rating", "xmp:Label", "PickLabel", "xmpDM:pick", "xmpDM:good", "acdsee:rating"] {
        assert!(!stripped.contains(mark), "{mark} devrait être retiré : {stripped}");
    }
    assert!(stripped.contains(r#"dc:creator="moi""#));
}

#[test]
fn strip_xmp_marks_handles_gt_inside_attribute_values() {
    let xml = r#"<x:xmpmeta><rdf:RDF><rdf:Description dc:creator="moi"><xmpDM:good custom="a>b">True</xmpDM:good><xmp:Rating xml:lang='x>y'>4</xmp:Rating></rdf:Description></rdf:RDF></x:xmpmeta>"#;
    let stripped = strip_xmp_marks(xml);
    assert!(!stripped.contains("xmpDM:good"), "{stripped}");
    assert!(!stripped.contains("True"), "{stripped}");
    assert!(!stripped.contains("xmp:Rating"), "{stripped}");
    assert!(stripped.contains(r#"dc:creator="moi""#), "{stripped}");
}

#[test]
fn update_xmp_regions_inserts_into_root_description_not_nested_one() {
    let xml = concat!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">"#,
        r#"<rdf:Description rdf:about=""><dc:subject><rdf:Description xmp:Rating="5"/></dc:subject>"#,
        r#"<other:Wrap><rdf:Description><other:Val>1</other:Val></rdf:Description></other:Wrap>"#,
        r#"</rdf:Description></rdf:RDF></x:xmpmeta>"#,
    );
    let updated = update_xmp_regions(xml, &RegionsUpdate {
        regions: vec![RegionWrite { name: Some("Alice".into()), x: 0.1, y: 0.2, w: 0.3, h: 0.4 }],
        width: 100,
        height: 100,
    });
    let wrap_end = updated.find("</other:Wrap>").unwrap();
    let regions_pos = updated.find("<mwg-rs:Regions").unwrap();
    assert!(regions_pos > wrap_end, "regions inserted inside nested rdf:Description: {updated}");
    let read = crate::faces::parse_regions(&updated);
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].name.as_deref(), Some("Alice"));
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

#[test]
fn marking_check_reports_each_value_the_file_does_not_show() {
    let mut meta = ExifMetadata::default();
    meta.rating = 4;
    meta.color_flag = "red".into();
    meta.pick_flag = "picked".into();
    assert_eq!(marking_mismatch(&meta, Some(4), Some("Red"), Some("picked")), None);
    assert_eq!(marking_mismatch(&meta, None, None, None), None);
    let difference = marking_mismatch(&meta, Some(5), Some("none"), Some("rejected")).expect("differences not reported");
    assert!(difference.contains("note 4") && difference.contains("couleur") && difference.contains("fanion"), "{difference}");
}

#[test]
fn light_marking_read_matches_the_full_read() {
    // read_marking must give exactly what read_exif shows: JPEG packet, RAW sidecar, JPEG with a sidecar for the missing sources.
    let dir = tempfile::tempdir().unwrap();
    let jpeg_xmp = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:xmpDM=\"http://ns.adobe.com/xmp/1.0/DynamicMedia/\" xmp:Rating=\"4\" xmp:Label=\"Blue\" xmpDM:pick=\"1\" xmpDM:good=\"True\"/></rdf:RDF></x:xmpmeta>";
    let jpeg = write_sample(dir.path(), "a.jpg", &with_xmp(&jpeg_bytes(16, 16), jpeg_xmp));
    let raw = write_sample(dir.path(), "b.cr2", b"raw");
    let raw_xmp = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:xmpDM=\"http://ns.adobe.com/xmp/1.0/DynamicMedia/\" xmp:Rating=\"2\" xmp:Label=\"Red\" xmpDM:pick=\"-1\" xmpDM:good=\"False\"/></rdf:RDF></x:xmpmeta>";
    fs::write(dir.path().join("b.cr2.xmp"), raw_xmp).unwrap();
    let mixed_xmp = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmp:Rating=\"5\"/></rdf:RDF></x:xmpmeta>";
    let mixed = write_sample(dir.path(), "c.jpg", &with_xmp(&jpeg_bytes(16, 16), mixed_xmp));
    fs::copy(dir.path().join("b.cr2.xmp"), dir.path().join("c.jpg.xmp")).unwrap();
    let bare = write_sample(dir.path(), "d.png", &png_bytes(8, 8));
    for path in [&jpeg, &raw, &mixed, &bare] {
        let (light, full) = (read_marking(path), read_exif(path));
        assert_eq!((light.rating, &light.color_flag, &light.pick_flag), (full.rating, &full.color_flag, &full.pick_flag), "{}", path.display());
    }
    assert_eq!((read_marking(&mixed).rating, read_marking(&mixed).color_flag.as_str()), (5, "red"));
}
