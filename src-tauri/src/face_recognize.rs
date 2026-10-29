//! Reconnaissance des visages (lot 3) : alignement, empreinte SFace et attribution à une personne (spec dev_tools/Evolutions/
//! feat face recognition v2.md, §3 étapes 5 à 7 et §5.1).
//!
//! - Alignement : les 5 points de repère de YuNet sont ramenés sur le gabarit 112 × 112 de SFace par une similarité (rotation, échelle,
//!   translation) calculée aux moindres carrés, puis l'image est rééchantillonnée (bilinéaire).
//! - Empreinte : 128 valeurs, normalisées ; la ressemblance de deux visages est leur produit scalaire (cosinus). Entrée de SFace : RGB, 0 à 255
//!   (prétraitement d'OpenCV, vérifié sur le prototype : un peu plus discriminant que BGR).
//! - Attribution : pour chaque personne, la plus forte ressemblance avec l'un de ses visages confirmés (s1 pour la meilleure personne, s2 pour la
//!   suivante) ; « auto » si s1 ≥ seuil auto et s1 − s2 ≥ marge, « suggéré » si s1 ≥ seuil de suggestion, sinon « inconnu ». Seuls les visages
//!   confirmés servent de référence. Les personnes masquées ne reçoivent rien.

use ort::session::Session;
use ort::value::Tensor;
use rayon::prelude::*;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::sync::Mutex;

/// Modèle de reconnaissance (enregistré avec chaque empreinte et chaque scan) : une empreinte d'un autre modèle n'est pas comparable.
pub const MODEL_ID: &str = "sface-2021dec";
pub const EMBEDDING_SIZE: usize = 128;
const FACE_SIDE: usize = 112;
/// Gabarit des 5 points de repère (œil gauche de l'image, œil droit, nez, coin gauche de la bouche, coin droit) dans l'image 112 × 112.
const TEMPLATE: [[f32; 2]; 5] = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
/// Multi-centroïdes (spec §5.2) : en dessous de ce nombre de visages confirmés, chacun sert de référence ; au-delà, des centroïdes (k-means).
const MIN_FACES_FOR_CENTROIDS: usize = 10;
/// Nombre maximal de centroïdes par personne (âges, lunettes, profils…).
const MAX_CENTROIDS: usize = 5;
const KMEANS_ITERATIONS: usize = 12;

/// Points de repère approchés d'une zone sans repères (zone importée que YuNet n'a pas retrouvée) : positions du gabarit rapportées au cadre.
pub fn landmarks_from_box(rect: [f64; 4]) -> [f32; 10] {
    let mut landmarks = [0f32; 10];
    for (point, [x, y]) in TEMPLATE.iter().enumerate() {
        landmarks[point * 2] = (rect[0] + rect[2] * (*x as f64 / FACE_SIDE as f64)) as f32;
        landmarks[point * 2 + 1] = (rect[1] + rect[3] * (*y as f64 / FACE_SIDE as f64)) as f32;
    }
    landmarks
}

/// Visage aligné 112 × 112 (RGB) à partir d'une image RGB et de ses 5 points de repère en pixels.
pub fn align(rgb: &[u8], width: usize, height: usize, landmarks: &[f32; 10]) -> Vec<u8> {
    let source: Vec<[f32; 2]> = (0..5).map(|point| [landmarks[point * 2], landmarks[point * 2 + 1]]).collect();
    let mean = |points: &[[f32; 2]]| [points.iter().map(|p| p[0]).sum::<f32>() / 5.0, points.iter().map(|p| p[1]).sum::<f32>() / 5.0];
    let source_mean = mean(&source);
    let target_mean = mean(&TEMPLATE);
    // Similarité q = M (p − ms) + mt avec M = [[a, −b], [b, a]] : a et b par moindres carrés.
    let (mut numerator_a, mut numerator_b, mut denominator) = (0f32, 0f32, 0f32);
    for point in 0..5 {
        let (sx, sy) = (source[point][0] - source_mean[0], source[point][1] - source_mean[1]);
        let (tx, ty) = (TEMPLATE[point][0] - target_mean[0], TEMPLATE[point][1] - target_mean[1]);
        numerator_a += sx * tx + sy * ty;
        numerator_b += sx * ty - sy * tx;
        denominator += sx * sx + sy * sy;
    }
    let mut output = vec![0u8; FACE_SIDE * FACE_SIDE * 3];
    if denominator <= f32::EPSILON || width < 2 || height < 2 { return output; }
    let (a, b) = (numerator_a / denominator, numerator_b / denominator);
    let norm = a * a + b * b;
    if norm <= f32::EPSILON { return output; }
    // Pour chaque pixel du visage aligné : point source par la transformation inverse, échantillonnage bilinéaire (noir hors de l'image).
    for v in 0..FACE_SIDE {
        for u in 0..FACE_SIDE {
            let (qx, qy) = (u as f32 - target_mean[0], v as f32 - target_mean[1]);
            let px = (a * qx + b * qy) / norm + source_mean[0];
            let py = (-b * qx + a * qy) / norm + source_mean[1];
            if px < 0.0 || py < 0.0 || px >= (width - 1) as f32 || py >= (height - 1) as f32 { continue; }
            let (x0, y0) = (px.floor() as usize, py.floor() as usize);
            let (fx, fy) = (px.fract(), py.fract());
            for channel in 0..3 {
                let sample = |x: usize, y: usize| rgb[(y * width + x) * 3 + channel] as f32;
                let top = sample(x0, y0) * (1.0 - fx) + sample(x0 + 1, y0) * fx;
                let bottom = sample(x0, y0 + 1) * (1.0 - fx) + sample(x0 + 1, y0 + 1) * fx;
                output[(v * FACE_SIDE + u) * 3 + channel] = (top * (1.0 - fy) + bottom * fy).round() as u8;
            }
        }
    }
    output
}

/// Empreinte SFace (normalisée) d'un visage aligné 112 × 112 RGB.
pub fn embed(session: &Mutex<Session>, face: &[u8]) -> Result<Vec<f32>, String> {
    let plane = FACE_SIDE * FACE_SIDE;
    let mut input = vec![0f32; 3 * plane];
    for pixel in 0..plane {
        for channel in 0..3 {
            input[channel * plane + pixel] = face[pixel * 3 + channel] as f32;
        }
    }
    let tensor = Tensor::from_array(([1usize, 3, FACE_SIDE, FACE_SIDE], input)).map_err(|error| error.to_string())?;
    let mut session = session.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let outputs = session.run(ort::inputs!["data" => tensor]).map_err(|error| format!("Reconnaissance impossible : {error}"))?;
    let (_, values) = outputs["fc1"].try_extract_tensor::<f32>().map_err(|error| error.to_string())?;
    let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();
    if values.len() != EMBEDDING_SIZE || norm <= f32::EPSILON { return Err("Empreinte de visage invalide".to_string()); }
    Ok(values.iter().map(|value| value / norm).collect())
}

pub fn embedding_blob(embedding: &[f32]) -> Vec<u8> {
    embedding.iter().flat_map(|value| value.to_le_bytes()).collect()
}

pub fn embedding_from_blob(blob: &[u8]) -> Option<Vec<f32>> {
    (blob.len() == EMBEDDING_SIZE * 4).then(|| blob.chunks_exact(4).map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])).collect())
}

pub fn similarity(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Références d'une personne : ses visages confirmés, ou au-delà de MIN_FACES_FOR_CENTROIDS des centroïdes (un tous les 10 visages, au plus
/// MAX_CENTROIDS) : la personne est représentée par ses « apparences » (âges, lunettes…) sans comparer chaque visage à des centaines d'autres.
fn person_references(embeddings: Vec<Vec<f32>>) -> Vec<Vec<f32>> {
    if embeddings.len() < MIN_FACES_FOR_CENTROIDS { return embeddings; }
    let count = (embeddings.len() / MIN_FACES_FOR_CENTROIDS + 1).min(MAX_CENTROIDS);
    kmeans(&embeddings, count)
}

fn normalized(mut vector: Vec<f32>) -> Vec<f32> {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > f32::EPSILON { for value in &mut vector { *value /= norm; } }
    vector
}

/// k-means sur la sphère (ressemblance cosinus), déterministe : premier centre = visage le plus proche de la moyenne, suivants = visage le plus
/// éloigné des centres déjà choisis ; puis affectations et moyennes renormalisées, KMEANS_ITERATIONS fois (un groupe vide garde son centre).
pub(crate) fn kmeans(points: &[Vec<f32>], count: usize) -> Vec<Vec<f32>> {
    let count = count.clamp(1, points.len().max(1));
    if points.is_empty() { return Vec::new(); }
    let dimension = points[0].len();
    let mut mean = vec![0f32; dimension];
    for point in points { for (sum, value) in mean.iter_mut().zip(point) { *sum += value; } }
    let mean = normalized(mean);
    let first = (0..points.len()).max_by(|&a, &b| similarity(&points[a], &mean).total_cmp(&similarity(&points[b], &mean))).unwrap_or(0);
    let mut centers = vec![points[first].clone()];
    while centers.len() < count {
        let farthest = (0..points.len())
            .min_by(|&a, &b| {
                let closest = |index: usize| centers.iter().map(|center| similarity(&points[index], center)).fold(f32::MIN, f32::max);
                closest(a).total_cmp(&closest(b))
            })
            .unwrap_or(0);
        centers.push(points[farthest].clone());
    }
    for _ in 0..KMEANS_ITERATIONS {
        let mut sums = vec![vec![0f32; dimension]; centers.len()];
        let mut sizes = vec![0usize; centers.len()];
        for point in points {
            let nearest = (0..centers.len()).max_by(|&a, &b| similarity(point, &centers[a]).total_cmp(&similarity(point, &centers[b]))).unwrap_or(0);
            for (sum, value) in sums[nearest].iter_mut().zip(point) { *sum += value; }
            sizes[nearest] += 1;
        }
        for (index, sum) in sums.into_iter().enumerate() {
            if sizes[index] > 0 { centers[index] = normalized(sum); }
        }
    }
    centers
}

/// Regroupement DBSCAN (spec §5.3) : deux visages sont voisins si leur ressemblance atteint `min_similarity` ; un visage qui a au moins
/// `min_points` voisins (lui compris) est un cœur, et les groupes réunissent les cœurs voisins et leurs voisins. Les visages isolés ne sont
/// dans aucun groupe. Renvoie les groupes (identifiants), du plus grand au plus petit.
pub fn dbscan(faces: &[(i64, Vec<f32>)], min_similarity: f32, min_points: usize) -> Vec<Vec<i64>> {
    let neighbors: Vec<Vec<usize>> = (0..faces.len())
        .into_par_iter()
        .map(|index| (0..faces.len()).filter(|&other| similarity(&faces[index].1, &faces[other].1) >= min_similarity).collect())
        .collect();
    let mut cluster_of: Vec<Option<usize>> = vec![None; faces.len()];
    let mut clusters: Vec<Vec<i64>> = Vec::new();
    for start in 0..faces.len() {
        if cluster_of[start].is_some() || neighbors[start].len() < min_points { continue; }
        let cluster = clusters.len();
        clusters.push(Vec::new());
        let mut queue = vec![start];
        cluster_of[start] = Some(cluster);
        while let Some(current) = queue.pop() {
            clusters[cluster].push(faces[current].0);
            // Seul un cœur étend le groupe ; un voisin non cœur y entre sans l'étendre.
            if neighbors[current].len() < min_points { continue; }
            for &next in &neighbors[current] {
                if cluster_of[next].is_none() {
                    cluster_of[next] = Some(cluster);
                    queue.push(next);
                }
            }
        }
    }
    clusters.sort_by(|a, b| b.len().cmp(&a.len()));
    clusters
}

/// Seuils d'attribution (Paramètres > Visages).
#[derive(Clone, Copy)]
pub struct Thresholds {
    pub auto: f64,
    pub suggestion: f64,
    pub margin: f64,
}

#[derive(Default, serde::Serialize)]
pub struct AttributionSummary {
    pub auto: usize,
    pub suggested: usize,
}

/// Attribue les visages non confirmés qui ont une empreinte (« inconnu », « suggéré », « auto ») : ceux des photos `photo_ids`, ou tous.
/// Un visage dont l'utilisateur a refusé une personne (`rejected_person_id`) ne lui est plus proposé.
pub fn attribute_faces(conn: &Connection, photo_ids: Option<&[i64]>, thresholds: Thresholds) -> Result<AttributionSummary, String> {
    // Références : visages confirmés des personnes visibles (chacun, ou des centroïdes au-delà de MIN_FACES_FOR_CENTROIDS).
    let mut by_person: HashMap<i64, Vec<Vec<f32>>> = HashMap::new();
    {
        let mut statement = conn
            .prepare(
                "SELECT f.person_id, f.embedding FROM faces f JOIN persons p ON p.id = f.person_id
                 WHERE f.state = 'confirmed' AND f.embedding IS NOT NULL AND f.model_id = ?1 AND p.hidden = 0 ORDER BY f.id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![MODEL_ID], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)))
            .map_err(|error| error.to_string())?;
        for (person_id, blob) in rows.flatten() {
            if let Some(embedding) = embedding_from_blob(&blob) { by_person.entry(person_id).or_default().push(embedding); }
        }
    }
    let references: Vec<(i64, Vec<f32>)> = by_person
        .into_iter()
        .flat_map(|(person_id, embeddings)| person_references(embeddings).into_iter().map(move |embedding| (person_id, embedding)).collect::<Vec<_>>())
        .collect();

    struct Candidate { id: i64, embedding: Vec<f32>, state: String, person_id: Option<i64>, suggested: Option<i64>, rejected: Option<i64> }
    let candidates: Vec<Candidate> = {
        let base = "SELECT id, embedding, state, person_id, suggested_person_id, rejected_person_id FROM faces
                    WHERE embedding IS NOT NULL AND model_id = ?1 AND state IN ('unknown', 'suggested', 'auto')";
        let map = |row: &rusqlite::Row| -> rusqlite::Result<(i64, Vec<u8>, String, Option<i64>, Option<i64>, Option<i64>)> {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))
        };
        let rows: Vec<_> = match photo_ids {
            Some(ids) => {
                let ids_json = serde_json::to_string(ids).map_err(|error| error.to_string())?;
                let mut statement = conn.prepare(&format!("{base} AND photo_id IN (SELECT value FROM json_each(?2))")).map_err(|error| error.to_string())?;
                let rows = statement.query_map(params![MODEL_ID, ids_json], map).map_err(|error| error.to_string())?;
                rows.flatten().collect()
            }
            None => {
                let mut statement = conn.prepare(base).map_err(|error| error.to_string())?;
                let rows = statement.query_map(params![MODEL_ID], map).map_err(|error| error.to_string())?;
                rows.flatten().collect()
            }
        };
        rows.into_iter()
            .filter_map(|(id, blob, state, person_id, suggested, rejected)| {
                embedding_from_blob(&blob).map(|embedding| Candidate { id, embedding, state, person_id, suggested, rejected })
            })
            .collect()
    };

    // Calcul en parallèle : (identifiant, état, personne, personne suggérée, s1, s1 − s2).
    let decisions: Vec<(i64, &'static str, Option<i64>, Option<i64>, f64, f64)> = candidates
        .par_iter()
        .map(|candidate| {
            let mut best: HashMap<i64, f32> = HashMap::new();
            for (person_id, reference) in &references {
                if Some(*person_id) == candidate.rejected { continue; }
                let score = similarity(&candidate.embedding, reference);
                let entry = best.entry(*person_id).or_insert(f32::MIN);
                if score > *entry { *entry = score; }
            }
            let mut ranked: Vec<(i64, f32)> = best.into_iter().collect();
            ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
            let (first, s1) = ranked.first().copied().map(|(person, score)| (Some(person), score as f64)).unwrap_or((None, 0.0));
            let s2 = ranked.get(1).map(|(_, score)| *score as f64).unwrap_or(0.0);
            let margin = s1 - s2;
            if first.is_some() && s1 >= thresholds.auto && margin >= thresholds.margin {
                (candidate.id, "auto", first, None, s1, margin)
            } else if first.is_some() && s1 >= thresholds.suggestion {
                (candidate.id, "suggested", None, first, s1, margin)
            } else {
                (candidate.id, "unknown", None, None, s1, margin)
            }
        })
        .collect();

    let previous: HashMap<i64, (&str, Option<i64>, Option<i64>)> =
        candidates.iter().map(|candidate| (candidate.id, (candidate.state.as_str(), candidate.person_id, candidate.suggested))).collect();
    let mut summary = AttributionSummary::default();
    let _ = conn.execute("BEGIN TRANSACTION", []);
    for (id, state, person_id, suggested, score, margin) in decisions {
        match state {
            "auto" => summary.auto += 1,
            "suggested" => summary.suggested += 1,
            _ => {}
        }
        let (old_state, old_person, old_suggested) = previous[&id];
        // Une personne attribuée (ou retirée) change ce qui sera écrit dans le fichier : visage à réécrire.
        let dirty = old_person != person_id;
        if old_state != state || old_person != person_id || old_suggested != suggested || dirty {
            let _ = conn.execute(
                "UPDATE faces SET state = ?1, person_id = ?2, suggested_person_id = ?3, score = ?4, margin = ?5, dirty = MAX(dirty, ?6) WHERE id = ?7",
                params![state, person_id, suggested, score, margin, dirty, id],
            );
        } else {
            let _ = conn.execute("UPDATE faces SET score = ?1, margin = ?2 WHERE id = ?3", params![score, margin, id]);
        }
    }
    let _ = conn.execute("COMMIT", []);
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alignment_of_template_points_is_identity() {
        // Une image dont les repères sont déjà ceux du gabarit ressort inchangée.
        let mut rgb = vec![0u8; FACE_SIDE * FACE_SIDE * 3];
        for (index, value) in rgb.iter_mut().enumerate() { *value = (index % 251) as u8; }
        let mut landmarks = [0f32; 10];
        for (point, [x, y]) in TEMPLATE.iter().enumerate() { landmarks[point * 2] = *x; landmarks[point * 2 + 1] = *y; }
        let aligned = align(&rgb, FACE_SIDE, FACE_SIDE, &landmarks);
        let center = (56 * FACE_SIDE + 56) * 3;
        assert_eq!(aligned[center], rgb[center]);
    }

    #[test]
    fn blob_round_trip() {
        let embedding: Vec<f32> = (0..EMBEDDING_SIZE).map(|index| index as f32 / 100.0).collect();
        assert_eq!(embedding_from_blob(&embedding_blob(&embedding)), Some(embedding));
    }
}
