//! Tests of face_recognize.rs: alignment on the SFace template and embedding blobs.

use super::*;

#[test]
fn alignment_of_template_points_is_identity() {
    // Une image dont les repères sont déjà ceux du gabarit ressort inchangée.
    let mut rgb = vec![0u8; FACE_SIDE * FACE_SIDE * 3];
    for (index, value) in rgb.iter_mut().enumerate() { *value = (index % 251) as u8; }
    let mut landmarks = [0f32; 10];
    for (point, [x, y]) in TEMPLATE.iter().enumerate() { landmarks[point * 2] = *x; landmarks[point * 2 + 1] = *y; }
    let aligned = align(&rgb, FACE_SIDE, FACE_SIDE, &landmarks).expect("repères du gabarit : alignement possible");
    let center = (56 * FACE_SIDE + 56) * 3;
    assert_eq!(aligned[center], rgb[center]);
}

#[test]
fn blob_round_trip() {
    let embedding: Vec<f32> = (0..EMBEDDING_SIZE).map(|index| index as f32 / 100.0).collect();
    assert_eq!(embedding_from_blob(&embedding_blob(&embedding)), Some(embedding));
}
