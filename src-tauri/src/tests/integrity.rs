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
