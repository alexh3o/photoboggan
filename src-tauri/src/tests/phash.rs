//! Tests of the perceptual hash: stability under resizing and recompression, difference between pictures, rotations, mirrors and flat pictures.

use super::*;
use crate::test_support::{blobs_rgb, jpeg_from_rgb, mirror, rotate_quarter};

fn print(rgb: &[u8], width: usize, height: usize) -> Fingerprint {
    fingerprint_rgb(rgb, width, height).expect("fingerprint")
}

#[test]
fn a_resized_copy_is_a_few_bits_away() {
    let big = print(&blobs_rgb(400, 300, 1), 400, 300);
    let small = print(&blobs_rgb(100, 75, 1), 100, 75);
    assert!(distance(big.hashes[0], small.hashes[0]) <= 4, "distance {}", distance(big.hashes[0], small.hashes[0]));
}

#[test]
fn a_recompressed_copy_is_a_few_bits_away() {
    let rgb = blobs_rgb(320, 240, 2);
    let jpeg = jpeg_from_rgb(&rgb, 320, 240, 30);
    let (decoded, width, height) = crate::test_support::decoded_pixels(&jpeg);
    let original = print(&rgb, 320, 240);
    let compressed = print(&decoded, width as usize, height as usize);
    assert!(distance(original.hashes[0], compressed.hashes[0]) <= 4);
}

#[test]
fn different_pictures_are_far_apart() {
    let reference = print(&blobs_rgb(200, 150, 1), 200, 150);
    for seed in 2..12 {
        let other = print(&blobs_rgb(200, 150, seed), 200, 150);
        assert!(distance(reference.hashes[0], other.hashes[0]) >= 12, "seed {seed}: {}", distance(reference.hashes[0], other.hashes[0]));
    }
}

#[test]
fn a_rotated_or_mirrored_copy_is_found_among_the_variants() {
    let rgb = blobs_rgb(200, 150, 5);
    let original = print(&rgb, 200, 150);
    let rotated = print(&rotate_quarter(&rgb, 200, 150), 150, 200);
    let mirrored = print(&mirror(&rgb, 200, 150), 200, 150);
    for (name, copy) in [("rotated", rotated), ("mirrored", mirrored)] {
        // Far from the identity hash, close to one of the variants.
        assert!(distance(original.hashes[0], copy.hashes[0]) >= 12, "{name} looks like the original without a variant");
        let best = original.hashes.iter().map(|&hash| distance(hash, copy.hashes[0])).min().unwrap();
        assert!(best <= 4, "{name}: best distance {best}");
    }
}

#[test]
fn flat_pictures_are_flagged() {
    assert!(print(&vec![0u8; 64 * 64 * 3], 64, 64).flat);
    assert!(print(&vec![255u8; 64 * 64 * 3], 64, 64).flat);
    assert!(!print(&blobs_rgb(64, 64, 3), 64, 64).flat);
}

#[test]
fn bad_dimensions_give_no_fingerprint() {
    assert!(fingerprint_rgb(&[], 0, 0).is_none());
    assert!(fingerprint_rgb(&[0, 0, 0], 2, 2).is_none());
}
