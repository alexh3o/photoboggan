//! Regression tests of the lossless rotation (orientation.rs): orientation arithmetic, which tag wins at reading, internal XMP writing.
//! Synthetic files only; the ExifTool path is covered by the ignored tests of exiftool.rs.

use super::*;
use crate::thumbnails::apply_orientation;

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
fn reading_order_depends_on_format() {
    // JPEG: EXIF first, as in most software; XMP as fallback.
    assert_eq!(resolve(Kind::Jpeg, Some(6), Some(3)).stored, 6);
    assert_eq!(resolve(Kind::Jpeg, None, Some(3)).stored, 3, "without EXIF tag, the XMP one is used");
    assert_eq!(resolve(Kind::Jpeg, Some(6), None).stored, 6, "without XMP tag, the camera EXIF tag is used");
    // Sidecar formats: the sidecar wins over the EXIF of the file.
    assert_eq!(resolve(Kind::Sidecar, Some(6), Some(1)).stored, 1);
    assert_eq!(resolve(Kind::Raw, Some(6), Some(8)).stored, 8);
    assert_eq!(resolve(Kind::Fixed, Some(6), Some(8)), Resolved { stored: 1, view_fix: 1 });
    assert_eq!(resolve(Kind::Jpeg, Some(0), Some(9)).stored, 1, "invalid values are ignored");
}

#[test]
fn view_fix_completes_what_the_webview_applies() {
    for exif in 1..=8 {
        for xmp in 1..=8 {
            let resolved = resolve(Kind::Sidecar, Some(exif), Some(xmp));
            // The webview applies the EXIF tag, the interface then applies view_fix: together, the resolved orientation.
            assert_eq!(compose(exif, resolved.view_fix), resolved.stored, "EXIF {exif}, XMP {xmp}");
        }
    }
    assert_eq!(resolve(Kind::Jpeg, Some(6), None).view_fix, 1, "nothing to add when the EXIF tag wins");
    assert_eq!(resolve(Kind::Raw, Some(6), Some(3)).view_fix, 1, "RAW: the preview carries its orientation");
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
    std::fs::write(&path, b"not really a heic").unwrap();
    assert!(write(&path, 6).is_err());
    assert!(!dir.path().join("photo.heic.xmp").exists());
}
