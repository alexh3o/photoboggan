//! Lossless rotation: only the orientation tag changes, never the image data (no decoding, no recompression).
//!
//! Orientation values (EXIF 0x0112 and XMP `tiff:Orientation`, 1 to 8) describe how the stored pixels must be turned to be displayed.
//! Each one is seen here as "mirror (optional), then turn clockwise by a number of quarter turns", which makes composing them simple:
//! 1 = none, 6 = 90° clockwise, 3 = 180°, 8 = 90° counterclockwise; 2, 7, 4, 5 = the same four turns after a horizontal mirror.
//!
//! Where the value is read and written (same targets as the other metadata, see exif.rs):
//! - JPEG: EXIF `Orientation` and XMP `tiff:Orientation` of the file. ExifTool writes both; the internal writer writes the XMP only, so
//!   which one wins at reading follows the "ignore EXIF metadata" option of the internal writer (`exiftool::skip_exif_metadata`).
//! - RAW, PNG, WebP…: XMP `tiff:Orientation` of the sidecar, which wins over the EXIF of the file (never modified).
//! - HEIC / HEIF, videos: not rotatable (the HEIF container carries its own rotation, which the EXIF tag must not override).

use std::path::Path;

/// Mirror flag and clockwise quarter turns of an orientation (unknown values count as 1).
fn parts(orientation: u32) -> (bool, u32) {
    match orientation {
        6 => (false, 1),
        3 => (false, 2),
        8 => (false, 3),
        2 => (true, 0),
        7 => (true, 1),
        4 => (true, 2),
        5 => (true, 3),
        _ => (false, 0),
    }
}

fn from_parts(mirrored: bool, turns: u32) -> u32 {
    match (mirrored, turns % 4) {
        (false, 0) => 1,
        (false, 1) => 6,
        (false, 2) => 3,
        (false, _) => 8,
        (true, 0) => 2,
        (true, 1) => 7,
        (true, 2) => 4,
        (true, _) => 5,
    }
}

/// Orientation that applies `first`, then `then`. A mirror reverses the direction of the turns made before it.
pub(crate) fn compose(first: u32, then: u32) -> u32 {
    let (first_mirror, first_turns) = parts(first);
    let (then_mirror, then_turns) = parts(then);
    let turns = if then_mirror { then_turns + 4 - first_turns } else { then_turns + first_turns };
    from_parts(first_mirror ^ then_mirror, turns)
}

/// Orientation that undoes `orientation`.
pub(crate) fn inverse(orientation: u32) -> u32 {
    let (mirrored, turns) = parts(orientation);
    // A mirrored orientation is its own inverse; a plain turn is undone by the opposite turn.
    if mirrored { orientation_or_one(orientation) } else { from_parts(false, 4 - turns) }
}

fn orientation_or_one(orientation: u32) -> u32 {
    if (1..=8).contains(&orientation) { orientation } else { 1 }
}

/// `orientation` turned on screen by `quarter_turns` (positive: clockwise, negative: counterclockwise).
pub(crate) fn rotate(orientation: u32, quarter_turns: i32) -> u32 {
    let turn = from_parts(false, quarter_turns.rem_euclid(4) as u32);
    compose(orientation_or_one(orientation), turn)
}

/// How the orientation of a file is stored, by format (see the module comment).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind {
    Jpeg,
    Raw,
    /// Other image formats: the sidecar carries the orientation.
    Sidecar,
    /// HEIC / HEIF and videos: never rotated by a tag.
    Fixed,
}

pub(crate) fn kind_of(path: &Path) -> Kind {
    if crate::video::is_video_path(path) || crate::heif::is_heif_path(path) { return Kind::Fixed; }
    if crate::thumbnails::is_raw_path(path) { return Kind::Raw; }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if matches!(extension.as_str(), "jpg" | "jpeg") { Kind::Jpeg } else { Kind::Sidecar }
}

/// True for the files the rotation applies to.
pub(crate) fn is_rotatable(path: &Path) -> bool {
    kind_of(path) != Kind::Fixed
}

/// Orientation of a file, from its EXIF tag (`exif`) and its XMP `tiff:Orientation` (`xmp`):
/// - `stored`: the value a rotation starts from and writes back (for a RAW, relative to its sensor data, like other software);
/// - `view_fix`: what the interface must still apply on top of the webview, which turns an image it shows by its own EXIF tag only.
///   1 for the formats shown through a generated preview (RAW, HEIC, videos), whose orientation is applied by the backend.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Resolved {
    pub stored: u32,
    pub view_fix: u32,
}

/// `skip_exif`: internal writer with the "ignore EXIF metadata" option (see `exiftool::skip_exif_metadata`): in a JPEG, the XMP it wrote
/// wins over the EXIF tag it cannot write. Otherwise the EXIF tag wins in a JPEG, as in most software.
pub(crate) fn resolve(kind: Kind, exif: Option<u32>, xmp: Option<u32>, skip_exif: bool) -> Resolved {
    let exif = exif.filter(|value| (1..=8).contains(value));
    let xmp = xmp.filter(|value| (1..=8).contains(value));
    let stored = match kind {
        Kind::Fixed => return Resolved { stored: 1, view_fix: 1 },
        Kind::Jpeg if !skip_exif => exif.or(xmp),
        _ => xmp.or(exif),
    }
    .unwrap_or(1);
    let view_fix = if kind == Kind::Raw { 1 } else { compose(inverse(exif.unwrap_or(1)), stored) };
    Resolved { stored, view_fix }
}

/// Orientation to apply to the JPEG preview of a RAW: `preview` is the one found without the sidecar (see thumbnails::raw_orientation),
/// `container` the EXIF tag of the RAW. A sidecar value replaces the container one, the preview turning by the difference.
pub(crate) fn raw_preview_orientation(preview: u32, container: u32, sidecar: Option<u32>) -> u32 {
    match sidecar.filter(|value| (1..=8).contains(value)) {
        Some(value) if value != container => compose(compose(preview, inverse(container)), value),
        _ => preview,
    }
}

/// Orientation read in the files (EXIF of the file, XMP of the file or of its sidecar), with the current reading settings.
pub(crate) fn read(path: &Path) -> Resolved {
    let kind = kind_of(path);
    if kind == Kind::Fixed { return Resolved { stored: 1, view_fix: 1 }; }
    resolve(kind, crate::thumbnails::exif_orientation(path), crate::exif::read_xmp_orientation(path), crate::exiftool::skip_exif_metadata())
}

/// Writes `orientation` where the active writer puts it (see the module comment). Refused for HEIC / HEIF and videos.
pub(crate) fn write(path: &Path, orientation: u32) -> std::io::Result<()> {
    if !is_rotatable(path) {
        return Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "Rotation not supported for this format"));
    }
    if !(1..=8).contains(&orientation) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid orientation"));
    }
    if crate::exiftool::is_enabled() { return crate::exiftool::write_orientation(path, orientation); }
    crate::exif::write_xmp_orientation(path, orientation)
}

#[cfg(test)]
#[path = "tests/orientation.rs"]
mod tests;
