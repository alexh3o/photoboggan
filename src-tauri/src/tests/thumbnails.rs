//! Tests de non-régression de l'orientation et de l'EXIF des RAW (thumbnails.rs).
//! Aucun vrai RAW : un CR3 minimal (boîtes CMT1 / CMT2) et des JPEG synthétiques sont fabriqués à la main.

use super::*;
use crate::test_support::{jpeg_bytes, with_segment};

/// Bloc TIFF petit-boutiste avec une seule entrée SHORT.
fn tiff_with_short(tag: u16, value: u16) -> Vec<u8> {
    let mut out = b"II*\0\x08\0\0\0".to_vec();
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&tag.to_le_bytes());
    out.extend_from_slice(&3u16.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&[value as u8, (value >> 8) as u8, 0, 0]);
    out.extend_from_slice(&0u32.to_le_bytes());
    out
}

fn bx(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

#[test]
fn cr3_reads_orientation_from_cmt1_and_exif_from_cmt2() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("photo.cr3");
    let mut data = bx(b"ftyp", b"crx \0\0\0\0crx isom");
    data.extend(bx(b"CMT1", &tiff_with_short(0x0112, 8)));
    data.extend(bx(b"CMT2", &tiff_with_short(0x8827, 400)));
    fs::write(&path, data).unwrap();

    let sources = read_exif_sources(&path);
    assert_eq!(sources.iter().find_map(orientation_of), Some(8));
    let iso = sources.iter().find_map(|exif| exif.get_field(Tag::PhotographicSensitivity, In::PRIMARY)).and_then(|field| field.value.get_uint(0));
    assert_eq!(iso, Some(400), "l'IFD de CMT2 doit être lu comme un IFD Exif");
}

#[test]
fn preview_orientation_comes_from_raw_when_preview_has_no_tag() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("photo.cr3");
    let mut data = bx(b"ftyp", b"crx \0\0\0\0crx isom");
    data.extend(bx(b"CMT1", &tiff_with_short(0x0112, 6)));
    fs::write(&path, data).unwrap();

    // Aperçu paysage sans tag : l'orientation du RAW s'applique ; le webview la recevra par un segment EXIF ajouté.
    let landscape = jpeg_bytes(40, 20);
    assert_eq!(raw_orientation(&path, &landscape), 6);
    let tagged = preview_with_orientation(&path, landscape);
    assert_eq!(lenient_exif(Reader::new().read_from_container(&mut Cursor::new(&tagged[..]))).as_ref().and_then(orientation_of), Some(6));

    // Aperçu déjà en portrait : déjà pivoté par l'appareil, rien à appliquer.
    let portrait = jpeg_bytes(20, 40);
    assert_eq!(raw_orientation(&path, &portrait), 1);
    assert_eq!(preview_with_orientation(&path, portrait.clone()), portrait);
}

#[test]
fn preview_own_orientation_tag_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("photo.raf");
    fs::write(&path, b"FUJIFILMCCD-RAW 0201 padding to be long enough for the header read.........................").unwrap();
    let mut exif = b"Exif\0\0".to_vec();
    exif.extend(tiff_with_short(0x0112, 8));
    let jpeg = with_segment(&jpeg_bytes(40, 20), 0xe1, &exif);
    assert_eq!(raw_orientation(&path, &jpeg), 8);
    assert_eq!(preview_with_orientation(&path, jpeg.clone()), jpeg);
}

/// DNG de téléphone : aucun JPEG, seulement une vignette RGB non compressée de 2 × 2 pixels dans l'IFD0.
#[test]
fn dng_without_jpeg_uses_uncompressed_rgb_thumbnail() {
    let entry = |tag: u16, kind: u16, value: u32| {
        let mut out = tag.to_le_bytes().to_vec();
        out.extend_from_slice(&kind.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&value.to_le_bytes());
        out
    };
    let mut data = b"II*\0\x08\0\0\0".to_vec();
    data.extend_from_slice(&8u16.to_le_bytes());
    data.extend(entry(0x100, 3, 2));
    data.extend(entry(0x101, 3, 2));
    let mut bits = entry(0x102, 3, 110);
    bits[4..8].copy_from_slice(&3u32.to_le_bytes());
    data.extend(bits);
    data.extend(entry(0x103, 3, 1));
    data.extend(entry(0x106, 3, 2));
    data.extend(entry(0x111, 4, 116));
    data.extend(entry(0x115, 3, 3));
    data.extend(entry(0x117, 4, 12));
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&[8, 0, 8, 0, 8, 0]);
    data.extend_from_slice(&[255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    data.resize(256, 0);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("phone.dng");
    fs::write(&path, data).unwrap();

    let jpeg = extract_raw_preview(&path).unwrap();
    let (_, width, height) = decode_scaled_jpeg_reader(Cursor::new(jpeg), 64).unwrap();
    assert_eq!((width, height), (2, 2));
}
