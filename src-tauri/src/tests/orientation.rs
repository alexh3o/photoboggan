//! Regression tests of the lossless rotation (orientation.rs): orientation arithmetic, which tag wins at reading, internal XMP writing.
//! Synthetic files only; the ExifTool path is covered by the ignored tests of exiftool.rs.

use super::*;
use crate::test_support::{jpeg_bytes, png_bytes, scan_data, with_segment};
use crate::thumbnails::apply_orientation;
use std::fs;

/// 3 × 2 picture whose 6 pixels are all different, to tell every orientation apart.
fn sample() -> (Vec<u8>, usize, usize) {
    ((0u8..18).collect(), 3, 2)
}

fn oriented(orientation: u32) -> (Vec<u8>, usize, usize) {
    let (rgb, width, height) = sample();
    apply_orientation(rgb, width, height, orientation)
}

#[test]
fn compose_matches_applying_both_orientations_to_pixels() {
    for first in 1..=8 {
        for then in 1..=8 {
            let (rgb, width, height) = oriented(first);
            let twice = apply_orientation(rgb, width, height, then);
            assert_eq!(twice, oriented(compose(first, then)), "compose({first}, {then})");
        }
    }
}

#[test]
fn inverse_undoes_and_rotation_turns_on_screen() {
    for orientation in 1..=8 {
        assert_eq!(compose(orientation, inverse(orientation)), 1, "inverse of {orientation}");
        assert_eq!(rotate(rotate(orientation, 1), -1), orientation, "right then left");
        assert_eq!(rotate(orientation, 4), orientation);
        assert_eq!(rotate(rotate(orientation, 2), 2), orientation);
        // Turning to the right = the displayed picture turned a quarter turn clockwise (orientation 6).
        let (rgb, width, height) = oriented(orientation);
        assert_eq!(apply_orientation(rgb, width, height, 6), oriented(rotate(orientation, 1)));
    }
    assert_eq!([rotate(1, 1), rotate(6, 1), rotate(3, 1), rotate(8, 1)], [6, 3, 8, 1]);
    assert_eq!(rotate(1, -1), 8);
    assert_eq!(rotate(1, 2), 3);
    assert_eq!(rotate(2, 1), 7, "a mirrored picture keeps its mirror");
    assert_eq!(rotate(0, 1), 6, "an invalid value counts as 1");
}

#[test]
fn reading_order_depends_on_format_and_option() {
    // JPEG: EXIF first (ExifTool, or internal writer still reading EXIF); XMP first when EXIF metadata is ignored.
    assert_eq!(resolve(Kind::Jpeg, Some(6), Some(3), false).stored, 6);
    assert_eq!(resolve(Kind::Jpeg, Some(6), Some(3), true).stored, 3);
    assert_eq!(resolve(Kind::Jpeg, None, Some(3), false).stored, 3, "without EXIF tag, the XMP one is used");
    assert_eq!(resolve(Kind::Jpeg, Some(6), None, true).stored, 6, "without XMP tag, the camera EXIF tag is used");
    // Sidecar formats: the sidecar wins over the EXIF of the file, whatever the option.
    assert_eq!(resolve(Kind::Sidecar, Some(6), Some(1), false).stored, 1);
    assert_eq!(resolve(Kind::Raw, Some(6), Some(8), false).stored, 8);
    assert_eq!(resolve(Kind::Fixed, Some(6), Some(8), false), Resolved { stored: 1, view_fix: 1 });
    assert_eq!(resolve(Kind::Jpeg, Some(0), Some(9), true).stored, 1, "invalid values are ignored");
}

#[test]
fn view_fix_completes_what_the_webview_applies() {
    for exif in 1..=8 {
        for xmp in 1..=8 {
            let resolved = resolve(Kind::Sidecar, Some(exif), Some(xmp), false);
            // The webview applies the EXIF tag, the interface then applies view_fix: together, the resolved orientation.
            assert_eq!(compose(exif, resolved.view_fix), resolved.stored, "EXIF {exif}, XMP {xmp}");
        }
    }
    assert_eq!(resolve(Kind::Jpeg, Some(6), None, false).view_fix, 1, "nothing to add when the EXIF tag wins");
    assert_eq!(resolve(Kind::Raw, Some(6), Some(3), false).view_fix, 1, "RAW: the preview carries its orientation");
}

#[test]
fn raw_preview_follows_the_sidecar() {
    // No sidecar value, or the same as the RAW: the preview orientation found without it.
    assert_eq!(raw_preview_orientation(6, 6, None), 6);
    assert_eq!(raw_preview_orientation(1, 6, Some(6)), 1);
    // Preview straight from the sensor (needs the RAW orientation): the sidecar value replaces it.
    assert_eq!(raw_preview_orientation(6, 6, Some(3)), 3);
    assert_eq!(raw_preview_orientation(1, 1, Some(8)), 8);
    // Preview already turned by the camera (portrait, orientation 1) for a RAW tagged 6, now turned a quarter more: one quarter turn.
    assert_eq!(raw_preview_orientation(1, 6, Some(3)), 6);
}

/// APP1 EXIF segment with only an IFD0 Orientation entry (big-endian).
fn exif_segment(orientation: u16) -> Vec<u8> {
    let mut payload = b"Exif\0\0MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01".to_vec();
    payload.extend_from_slice(&orientation.to_be_bytes());
    payload.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
    payload
}

#[test]
fn internal_jpeg_rotation_writes_xmp_only_and_keeps_image_and_exif() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("photo.jpg");
    let exif = exif_segment(1);
    let original = with_segment(&jpeg_bytes(32, 16), 0xe1, &exif);
    fs::write(&path, &original).unwrap();

    crate::exif::write_xmp_orientation(&path, 6).unwrap();
    let written = fs::read(&path).unwrap();
    assert_eq!(scan_data(&written), scan_data(&original), "image data unchanged");
    assert!(crate::test_support::contains(&written, &exif), "EXIF segment untouched");
    assert_eq!(crate::exif::read_xmp_orientation(&path), Some(6));
    assert_eq!(crate::thumbnails::exif_orientation(&path), Some(1));

    // Second rotation: the value is replaced, never duplicated.
    crate::exif::write_xmp_orientation(&path, 3).unwrap();
    let written = fs::read(&path).unwrap();
    assert_eq!(crate::exif::read_xmp_orientation(&path), Some(3));
    let text = String::from_utf8_lossy(&written);
    assert_eq!(text.matches("tiff:Orientation").count(), 1, "one tiff:Orientation only");
    assert_eq!(scan_data(&written), scan_data(&original));
}

#[test]
fn sidecar_rotation_leaves_the_image_file_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("picture.png");
    let original = png_bytes(8, 4);
    fs::write(&path, &original).unwrap();

    crate::exif::write_xmp_orientation(&path, 8).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original, "the PNG itself is never written");
    assert!(dir.path().join("picture.png.xmp").is_file());
    assert_eq!(crate::exif::read_xmp_orientation(&path), Some(8));
    assert_eq!(resolve(kind_of(&path), crate::thumbnails::exif_orientation(&path), crate::exif::read_xmp_orientation(&path), false).stored, 8);
}

#[test]
fn rotation_fixes_the_old_microsoft_namespace_like_the_other_writes() {
    let old = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:MicrosoftPhoto=\"http://ns.microsoft.com/photo/1.0\" MicrosoftPhoto:Rating=\"1\"/></rdf:RDF></x:xmpmeta>";
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.png");
    fs::write(&path, png_bytes(4, 4)).unwrap();
    fs::write(dir.path().join("old.png.xmp"), old).unwrap();

    crate::exif::write_xmp_orientation(&path, 6).unwrap();
    let written = fs::read_to_string(dir.path().join("old.png.xmp")).unwrap();
    assert!(written.contains("xmlns:MicrosoftPhoto=\"http://ns.microsoft.com/photo/1.0/\""), "{written}");
    assert!(written.contains("MicrosoftPhoto:Rating=\"1\""), "other values kept: {written}");
    assert_eq!(crate::exif::read_xmp_orientation(&path), Some(6));
}

#[test]
fn heif_and_videos_are_not_rotatable() {
    for name in ["photo.heic", "photo.HEIF", "clip.mp4", "clip.mov"] {
        assert!(!is_rotatable(Path::new(name)), "{name}");
    }
    for name in ["photo.jpg", "photo.cr3", "photo.png", "photo.webp"] {
        assert!(is_rotatable(Path::new(name)), "{name}");
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("photo.heic");
    fs::write(&path, b"not really a heic").unwrap();
    assert!(crate::exif::write_xmp_orientation(&path, 6).is_err());
    assert!(!dir.path().join("photo.heic.xmp").exists());
}
