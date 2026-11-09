//! Tests of face_detect.rs: orientation conversions of face rectangles, and the shared defaults file (faceSettings, keys the frontend reads).

use super::*;

#[test]
fn orientation_round_trip() {
    let rect = [0.7116, 0.2423, 0.0995, 0.1441];
    for orientation in 1..=8 {
        let shown = orient_rect(rect, orientation);
        let back = orient_rect(shown, inverse_orientation(orientation));
        for index in 0..4 { assert!((back[index] - rect[index]).abs() < 1e-9, "orientation {orientation}"); }
    }
    // Orientation 8 (Explorateur Windows) : même zone que celle recalculée par digiKam après sa rotation des pixels.
    let shown = orient_rect(rect, 8);
    assert!((shown[0] - 0.2423).abs() < 1e-4 && (shown[1] - 0.1889).abs() < 1e-4);
}

/// The shared defaults file must stay parseable by both readers (comment-line stripping, then JSON).
fn defaults_json() -> serde_json::Value {
    let json: String = DEFAULTS_FILE.lines().filter(|line| !line.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    serde_json::from_str(&json).expect("src/defaults.jsonc is valid JSON once comment lines are dropped")
}

#[test]
fn default_face_settings_come_from_the_shared_file_and_are_in_range() {
    let defaults = FaceSettings::default();
    assert!((0.0..=500.0).contains(&defaults.min_size_permille));
    assert!((0.5..=1.0).contains(&defaults.min_confidence));
    assert!((0.0..=2000.0).contains(&defaults.min_sharpness));
    assert!((0.2..=1.0).contains(&defaults.auto_threshold));
    assert!((0.2..=1.0).contains(&defaults.suggestion_threshold));
    assert!(defaults.suggestion_threshold <= defaults.auto_threshold);
    assert!((0.0..=0.5).contains(&defaults.margin));
}

#[test]
fn the_defaults_file_has_every_key_the_frontend_reads() {
    let root = defaults_json();
    for key in [
        "sidebarVisible", "toolbarShowLabels", "thumbnailLayout", "thumbnailSize", "appLanguage", "checkUpdates",
        "faceReading", "slideshowDelay", "rawScope", "mapDefaultZoom", "selectionColor",
    ] {
        assert!(!root[key].is_null(), "missing default: {key}");
    }
}
