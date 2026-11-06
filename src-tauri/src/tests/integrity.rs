//! Tests de la vérification d'intégrité (integrity.rs) : un fichier sain n'est jamais signalé, un fichier corrompu l'est toujours,
//! et l'analyse ne modifie jamais le fichier examiné.

use super::*;
use crate::test_support::*;

fn check(source: &Path, thumbnails: &Path) -> Result<Outcome, String> {
    let gate = Arc::new(Gate::new(1));
    let token = Arc::new(SlotToken::default());
    check_file(source, thumbnails, 256, &gate, &token)
}

fn is_created(outcome: &Result<Outcome, String>) -> bool {
    matches!(outcome, Ok(Outcome::Healthy(Thumbnail::Created)))
}

fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn format_is_recognised_from_content_not_extension() {
    let dir = tempfile::tempdir().unwrap();
    let cases: [(&str, Vec<u8>, &str); 5] = [
        ("png", png_bytes(4, 4), "png"),
        ("webp", [&b"RIFF\x10\0\0\0WEBPVP8 "[..], &[0; 8]].concat(), "webp"),
        ("heic", [&[0, 0, 0, 24][..], b"ftypheic", &[0; 8]].concat(), "heif"),
        ("jpg", jpeg_bytes(8, 8), "other"),
        ("png", b"RIFF".to_vec(), "other"),
    ];
    for (index, (extension, bytes, expected)) in cases.into_iter().enumerate() {
        let path = write(dir.path(), &format!("f{index}.{extension}"), &bytes);
        let name = match sniff(&path) { Format::Png => "png", Format::WebP => "webp", Format::Heif => "heif", Format::Other => "other" };
        assert_eq!(name, expected, "cas {index}");
    }
    assert!(matches!(sniff(&dir.path().join("absent")), Format::Other));
}

#[test]
fn valid_images_are_healthy_and_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let thumbnails = tempfile::tempdir().unwrap();
    let originals = [("a.png", png_bytes(40, 30)), ("b.jpg", jpeg_bytes(40, 30)), ("c.png", jpeg_bytes(20, 20))];
    for (name, bytes) in &originals {
        let path = write(dir.path(), name, bytes);
        let first = check(&path, thumbnails.path());
        assert!(is_created(&first), "{name} : miniature non créée");
        // Deuxième passage : la miniature existe déjà.
        assert!(matches!(check(&path, thumbnails.path()), Ok(Outcome::Healthy(Thumbnail::Existing))), "{name}");
        assert_eq!(&fs::read(&path).unwrap(), bytes, "{name} a été modifié par l'analyse");
    }
}

#[test]
fn corrupt_files_are_reported() {
    let dir = tempfile::tempdir().unwrap();
    let thumbnails = tempfile::tempdir().unwrap();
    let png = png_bytes(64, 64);
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("coupe.png", png[..png.len() / 2].to_vec()),
        ("texte.png", b"ceci n'est pas une image".to_vec()),
        ("vide.png", Vec::new()),
        ("vide.jpg", Vec::new()),
        ("texte.jpg", b"ceci n'est pas une image".to_vec()),
        ("riff.webp", b"RIFF\x04\0\0\0WEBP".to_vec()),
    ];
    for (name, bytes) in cases {
        let path = write(dir.path(), name, &bytes);
        assert!(check(&path, thumbnails.path()).is_err(), "{name} aurait dû être signalé");
        assert_eq!(fs::read(&path).unwrap(), bytes, "{name} a été modifié par l'analyse");
    }
}

/// Progressive JPEG with a noisy gradient (so every scan carries data).
fn progressive_jpeg() -> Vec<u8> {
    let rgb = blobs_rgb(96, 64, 7);
    let mut out = Vec::new();
    let mut encoder = jpeg_encoder::Encoder::new(&mut out, 90);
    encoder.set_progressive(true);
    encoder.encode(&rgb, 96, 64, jpeg_encoder::ColorType::Rgb).expect("progressive JPEG encoding");
    out
}

/// Offsets of every SOS marker (FFDA cannot appear inside entropy data: FF is always stuffed).
fn sos_offsets(jpeg: &[u8]) -> Vec<usize> {
    (0..jpeg.len() - 1).filter(|&at| jpeg[at] == 0xff && jpeg[at + 1] == 0xda).collect()
}

#[test]
fn complete_jpegs_pass_the_structure_check() {
    let progressive = progressive_jpeg();
    assert!(sos_offsets(&progressive).len() > 2, "the test file must be multi-scan");
    assert!(check_jpeg_structure(&progressive).is_ok());
    assert!(check_jpeg_structure(&jpeg_bytes(40, 30)).is_ok());
    // Garbage and non-JPEG input are the decoder's business.
    assert!(check_jpeg_structure(b"not a jpeg").is_ok());
    assert!(check_jpeg_structure(&[0xff, 0xd8]).is_ok());
}

#[test]
fn progressive_jpeg_missing_scans_is_flagged_even_with_an_end_marker() {
    let progressive = progressive_jpeg();
    let scans = sos_offsets(&progressive);
    // Cut before each scan from the 2nd on and close the file properly: the decoder is happy, the structure is not.
    for (index, &at) in scans.iter().enumerate().skip(1) {
        let mut cut = progressive[..at].to_vec();
        cut.extend_from_slice(&[0xff, 0xd9]);
        assert!(check_jpeg_structure(&cut).is_err(), "file cut before scan {} not flagged", index + 1);
    }
    // Same through the real entry point, with the thumbnail cache not touched.
    let dir = tempfile::tempdir().unwrap();
    let thumbnails = tempfile::tempdir().unwrap();
    let mut cut = progressive[..scans[1]].to_vec();
    cut.extend_from_slice(&[0xff, 0xd9]);
    let path = write(dir.path(), "partiel.jpg", &cut);
    let error = check(&path, thumbnails.path()).err().expect("partial progressive JPEG must be suspect");
    assert!(error.contains("Incomplete JPEG"), "{error}");
    assert!(is_created(&check(&write(dir.path(), "entier.jpg", &progressive), thumbnails.path())));
}

#[test]
fn progressive_scan_headers_overwritten_are_flagged() {
    // Later scans lost (headers overwritten by filler) while the end marker is kept: the first scan swallows the rest.
    let progressive = progressive_jpeg();
    let scans = sos_offsets(&progressive);
    let end = progressive.len() - 2;
    let mut damaged = progressive.clone();
    damaged[scans[2]..end].fill(0x32);
    assert!(check_jpeg_structure(&damaged).is_err());
}

#[test]
fn sequential_jpeg_with_a_missing_component_scan_is_flagged() {
    // Fabricated: a 3-component frame whose single scan lists only one component.
    let mut jpeg = jpeg_bytes(16, 16);
    let sos = sos_offsets(&jpeg)[0];
    assert_eq!(jpeg[sos + 4], 3, "interleaved 3-component scan expected");
    let mut one_component = vec![0xff, 0xda, 0, 8, 1, jpeg[sos + 5], jpeg[sos + 6], 0, 63, 0];
    one_component.extend_from_slice(&[0xff, 0xd9]);
    jpeg.truncate(sos);
    jpeg.extend_from_slice(&one_component);
    assert!(check_jpeg_structure(&jpeg).is_err());
}

#[test]
fn unsupported_formats_are_skipped_not_flagged() {
    let dir = tempfile::tempdir().unwrap();
    let thumbnails = tempfile::tempdir().unwrap();
    for name in ["a.gif", "a.bmp", "a.avif", "a.mp4"] {
        let path = write(dir.path(), name, b"peu importe");
        assert!(matches!(check(&path, thumbnails.path()), Ok(Outcome::Unsupported)), "{name}");
    }
}

#[test]
fn extension_and_transparency_helpers() {
    assert_eq!(extension_of(Path::new("a/B.JPG")), "jpg");
    assert_eq!(extension_of(Path::new("a/sans")), "sans extension");
    assert_eq!(flatten([10, 20, 30], 255), [10, 20, 30]);
    assert_eq!(flatten([10, 20, 30], 0), [255, 255, 255]);
}

#[test]
fn csv_fields_cannot_turn_into_spreadsheet_formulas() {
    assert_eq!(csv_field("a\"b"), "\"a\"\"b\"");
    for dangerous in ["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx"] {
        assert!(csv_field(dangerous).starts_with("\"'"), "{dangerous:?} -> {}", csv_field(dangerous));
    }
}

#[test]
fn report_is_written_once_and_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let headers: Vec<String> = ["Nom", "Dossier", "Chemin", "Problème"].iter().map(|s| s.to_string()).collect();
    let rows = vec![IntegrityIssue { path: dir.path().join("=evil.jpg").to_string_lossy().to_string(), error: "Signature invalide".into() }];
    let first = write_report(dir.path(), "Titre\nLigne", &headers, &rows).unwrap();
    let second = write_report(dir.path(), "Titre", &headers, &rows).unwrap();
    assert_ne!(first, second, "un rapport existant a été écrasé");
    let content = fs::read_to_string(&first).unwrap();
    assert!(content.starts_with('\u{feff}'));
    assert!(content.contains("Titre\r\nLigne\r\n"));
    assert!(content.contains("\"'=evil.jpg\""), "formule non neutralisée : {content}");
    assert!(write_report(&dir.path().join("absent"), "x", &headers, &rows).is_err());
    assert!(write_report(dir.path(), "x", &headers[..2], &rows).is_err());
}

#[test]
fn full_run_flags_only_the_corrupt_file_and_honours_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    let thumbnails = tempfile::tempdir().unwrap();
    write(dir.path(), "bon.jpg", &jpeg_bytes(32, 32));
    write(dir.path(), "bon.png", &png_bytes(32, 32));
    write(dir.path(), "mauvais.png", b"corrompu");
    let cancel = AtomicBool::new(false);
    let report = run(dir.path(), thumbnails.path(), 256, &cancel, &|_| {}, &|_| {}).unwrap();
    let serialized = serde_json::to_string(&report).unwrap();
    assert!(serialized.contains("mauvais.png"), "{serialized}");
    assert!(!serialized.contains("bon.jpg") && !serialized.contains("bon.png"), "{serialized}");
    assert!(dir.path().join("mauvais.png").exists());

    // Annulation demandée avant le départ : aucun fichier signalé à tort.
    let cancel = AtomicBool::new(true);
    if let Ok(report) = run(dir.path(), thumbnails.path(), 256, &cancel, &|_| {}, &|_| {}) {
        assert!(!serde_json::to_string(&report).unwrap().contains("mauvais.png"));
    }
}
