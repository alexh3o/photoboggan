//! Tests of resize.rs: output size (never enlarged), formats, metadata copy, conflict policies, refusals. Synthetic files only; the
//! "Replace" policy is not tested here because it sends the existing file to the real trash.

use super::*;
use crate::test_support::*;

fn options(mode: ResizeMode, value: u32, format: OutputFormat) -> ResizeOptions {
    ResizeOptions {
        mode, value, format, jpeg_quality: 85, png_compression: PngCompression::Fast, keep_metadata: true, clear_marks: false,
        destination: None, preserve_folder_structure: false, source_root: None, suffix: "_s".into(), conflict: ConflictPolicy::Ask,
    }
}

/// A 64×48 JPEG source in a fresh folder.
fn source() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("photo.jpg");
    fs::write(&path, jpeg_bytes(64, 48)).unwrap();
    (dir, path)
}

fn done(outcome: ResizeOutcome) -> (PathBuf, u32, u32) {
    match outcome {
        ResizeOutcome::Done { output, width, height } => (PathBuf::from(output), width, height),
        _ => panic!("expected a written file"),
    }
}

/// Only the source and the outputs: no `.photoboggan-resize-*.tmp` left behind.
fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[test]
fn jpeg_is_reduced_to_the_longest_side_and_the_source_is_untouched() {
    let (dir, path) = source();
    let before = fs::read(&path).unwrap();
    let (output, width, height) = done(resize_photo(&path, &options(ResizeMode::MaxSide, 16, OutputFormat::Jpeg)).unwrap());
    assert_eq!((width, height), (16, 12));
    assert_eq!(output, dir.path().join("photo_s.jpg"));
    let (_, decoded_width, decoded_height) = decoded_pixels(&fs::read(&output).unwrap());
    assert_eq!((decoded_width, decoded_height), (16, 12));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(names(dir.path()), ["photo.jpg", "photo_s.jpg"]);
}

#[test]
fn a_photo_is_never_enlarged_and_percent_scales_both_sides() {
    let (_dir, path) = source();
    let mut big = options(ResizeMode::MaxSide, 1000, OutputFormat::Jpeg);
    big.suffix = "_big".into();
    assert_eq!(done(resize_photo(&path, &big).unwrap()).1, 64);
    let (output, width, height) = done(resize_photo(&path, &options(ResizeMode::Percent, 50, OutputFormat::Png)).unwrap());
    assert_eq!((width, height), (32, 24));
    assert!(fs::read(output).unwrap().starts_with(&[0x89, b'P', b'N', b'G']));
}

#[test]
fn chosen_destination_can_recreate_the_source_folder_hierarchy() {
    let root = tempfile::tempdir().unwrap();
    let source_dir = root.path().join("un").join("deux");
    fs::create_dir_all(&source_dir).unwrap();
    let source = source_dir.join("photo.jpg");
    fs::write(&source, jpeg_bytes(64, 48)).unwrap();
    let destination = root.path().join("output");
    fs::create_dir(&destination).unwrap();

    let mut configured = options(ResizeMode::MaxSide, 16, OutputFormat::Jpeg);
    configured.destination = Some(destination.to_string_lossy().into_owned());
    configured.preserve_folder_structure = true;
    configured.source_root = Some(root.path().to_string_lossy().into_owned());

    let output = done(resize_photo(&source, &configured).unwrap()).0;
    assert_eq!(output, destination.join("un").join("deux").join("photo_s.jpg"));
    assert!(output.is_file());
}

#[test]
fn metadata_is_copied_into_a_jpeg_only_when_asked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("photo.jpg");
    let packet = b"<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'><rdf:Description xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:subject><rdf:Bag><rdf:li>KeepMe</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>";
    fs::write(&path, with_segment(&jpeg_bytes(64, 48), 0xe1, &[b"http://ns.adobe.com/xap/1.0/\0".as_slice(), packet].concat())).unwrap();

    let kept = done(resize_photo(&path, &options(ResizeMode::MaxSide, 32, OutputFormat::Jpeg)).unwrap()).0;
    assert!(contains(&fs::read(kept).unwrap(), b"KeepMe"));
    let mut bare = options(ResizeMode::MaxSide, 32, OutputFormat::Jpeg);
    bare.keep_metadata = false;
    bare.suffix = "_bare".into();
    let stripped = done(resize_photo(&path, &bare).unwrap()).0;
    assert!(!contains(&fs::read(stripped).unwrap(), b"KeepMe"));
}

#[test]
fn an_existing_target_is_asked_skipped_or_given_a_free_name_never_overwritten() {
    let (dir, path) = source();
    let target = dir.path().join("photo_s.jpg");
    fs::write(&target, b"existing").unwrap();

    let ask = resize_photo(&path, &options(ResizeMode::MaxSide, 16, OutputFormat::Jpeg)).unwrap();
    assert!(matches!(ask, ResizeOutcome::Conflict { .. }));
    let mut skip = options(ResizeMode::MaxSide, 16, OutputFormat::Jpeg);
    skip.conflict = ConflictPolicy::Skip;
    assert!(matches!(resize_photo(&path, &skip).unwrap(), ResizeOutcome::Skipped { .. }));
    assert_eq!(fs::read(&target).unwrap(), b"existing");

    let mut increment = options(ResizeMode::MaxSide, 16, OutputFormat::Jpeg);
    increment.conflict = ConflictPolicy::Increment;
    assert_eq!(done(resize_photo(&path, &increment).unwrap()).0, dir.path().join("photo_s_1.jpg"));
    assert_eq!(fs::read(&target).unwrap(), b"existing");
}

#[test]
fn invalid_options_and_the_source_as_target_are_refused() {
    let (dir, path) = source();
    let mut same = options(ResizeMode::MaxSide, 16, OutputFormat::Jpeg);
    same.suffix = String::new();
    assert!(resize_photo(&path, &same).is_err(), "would replace the original");
    assert!(resize_photo(&path, &options(ResizeMode::Percent, 0, OutputFormat::Jpeg)).is_err());
    assert!(resize_photo(&path, &options(ResizeMode::MaxSide, 0, OutputFormat::Jpeg)).is_err());
    let mut bad_suffix = options(ResizeMode::MaxSide, 16, OutputFormat::Jpeg);
    bad_suffix.suffix = "a/b".into();
    assert!(resize_photo(&path, &bad_suffix).is_err());
    let mut missing_folder = options(ResizeMode::MaxSide, 16, OutputFormat::Jpeg);
    missing_folder.destination = Some(dir.path().join("absent").to_string_lossy().into_owned());
    assert!(resize_photo(&path, &missing_folder).is_err());
    assert_eq!(names(dir.path()), ["photo.jpg"], "nothing written");
}
