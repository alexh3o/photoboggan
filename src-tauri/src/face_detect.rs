//! Détection des visages (lot 2) : YuNet sur la miniature en cache de chaque photo, mesures de qualité, enregistrement en base avec fusion des
//! visages déjà connus (spec dev_tools/Evolutions/feat face recognition v2.md, §3 et §7.1).
//!
//! - Source : la miniature en cache (512 px minimum, déjà orientée, toujours à jour : le cache est indexé par chemin, taille et date du fichier).
//!   Absente, elle est générée et gardée, comme pour la grille. Le fichier photo n'est jamais modifié.
//! - YuNet a une entrée fixe de 640 × 640 : la miniature y est ramenée (plus grand côté) et complétée par du noir.
//! - Les coordonnées sont converties dans le repère de l'image STOCKÉE (avant orientation EXIF), comme les zones lues dans les fichiers (faces.rs).
//! - Les détections faibles (score < SCORE_FLOOR) sont ignorées ; au-dessus, tout est gardé avec ses mesures (confiance, netteté, taille) :
//!   les seuils réglables classent un visage « inconnu » ou « filtré », et un changement de seuil reclasse sans rescan (apply_face_thresholds).
//! - ONNX Runtime : l'environnement est créé au premier scan puis gardé (la bibliothèque ne peut pas être déchargée) ; la session du modèle,
//!   qui porte l'essentiel de la mémoire, est libérée à la fin de chaque tâche.

use ort::environment::Environment;
use ort::session::Session;
use ort::value::Tensor;
use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock, RwLock};
use tauri::{Emitter, State};

use crate::AppState;

/// Identifiant du détecteur enregistré avec chaque scan (photo_face_scans) : une photo scannée avec un autre détecteur est à rescanner.
pub const DETECTOR_ID: &str = "yunet-2023mar";
const INPUT_SIDE: usize = 640;
/// Détections plus faibles ignorées (le seuil de confiance réglable s'applique ensuite, sans rescan).
const SCORE_FLOOR: f32 = 0.5;
/// Recouvrement au-delà duquel deux détections sont le même visage (suppression des doublons).
const NMS_IOU: f32 = 0.3;
/// Recouvrement au-delà duquel une détection correspond à un visage déjà en base (spec §7.1).
const MATCH_IOU: f64 = 0.5;
/// Côté du visage ramené pour la mesure de netteté (même taille que l'entrée de SFace).
const SHARPNESS_SIDE: usize = 112;

// ---------------------------------------------------------------------------
// Réglages (Paramètres > Visages), envoyés par l'interface au démarrage et à chaque changement
// ---------------------------------------------------------------------------

#[derive(Deserialize, Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FaceSettings {
    /// Scanner les RAW (sur la miniature tirée de leur aperçu JPEG intégré).
    pub scan_raw: bool,
    /// Taille minimale du visage, en pixels de la photo d'origine (plus grand côté du visage).
    pub min_size_px: f64,
    /// Taille minimale du visage, en % du plus grand côté de la photo.
    pub min_size_percent: f64,
    /// Confiance minimale de YuNet (0 à 1).
    pub min_confidence: f64,
    /// Netteté minimale (variance du laplacien sur le visage ramené à 112 px, en niveaux de gris).
    pub min_sharpness: f64,
}

impl FaceSettings {
    const DEFAULT: FaceSettings = FaceSettings { scan_raw: true, min_size_px: 40.0, min_size_percent: 1.0, min_confidence: 0.8, min_sharpness: 50.0 };

    /// Visage retenu (« inconnu », à reconnaître) ou écarté (« filtré ») d'après ses mesures.
    fn passes(&self, score: f64, sharpness: f64, size_px: f64, size_percent: f64) -> bool {
        score >= self.min_confidence && sharpness >= self.min_sharpness && size_px >= self.min_size_px && size_percent >= self.min_size_percent
    }
}

static SETTINGS: RwLock<FaceSettings> = RwLock::new(FaceSettings::DEFAULT);

fn settings() -> FaceSettings {
    *SETTINGS.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
pub fn set_face_settings(settings: FaceSettings) {
    *SETTINGS.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = settings;
}

/// Reclasse les visages détectés non attribués (« inconnu » ↔ « filtré ») d'après les seuils actuels, sans rescan. Renvoie le nombre de visages changés.
#[tauri::command(async)]
pub fn apply_face_thresholds(state: State<'_, AppState>) -> Result<usize, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let current = settings();
    let rows: Vec<(i64, String, f64, f64, f64, f64)> = {
        let mut statement = conn
            .prepare(
                "SELECT id, state, COALESCE(det_score, 0), COALESCE(sharpness, 0), COALESCE(size_px, 0), COALESCE(size_pct, 0) FROM faces
                 WHERE origin = 'detected' AND person_id IS NULL AND state IN ('unknown', 'filtered')",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)))
            .map_err(|error| error.to_string())?;
        rows.flatten().collect()
    };
    let _ = conn.execute("BEGIN TRANSACTION", []);
    let mut changed = 0usize;
    for (id, face_state, score, sharpness, size_px, size_percent) in rows {
        let wanted = if current.passes(score, sharpness, size_px, size_percent) { "unknown" } else { "filtered" };
        if wanted != face_state {
            let _ = conn.execute("UPDATE faces SET state = ?1 WHERE id = ?2", params![wanted, id]);
            changed += 1;
        }
    }
    let _ = conn.execute("COMMIT", []);
    Ok(changed)
}

// ---------------------------------------------------------------------------
// Orientation : image orientée (miniature) -> image stockée (base, fichiers)
// ---------------------------------------------------------------------------

/// Point normalisé de l'image stockée vers l'image affichée selon l'orientation EXIF (même transformation que orientRect dans faces-panel.js).
fn orient_point(x: f64, y: f64, orientation: u32) -> (f64, f64) {
    match orientation {
        2 => (1.0 - x, y),
        3 => (1.0 - x, 1.0 - y),
        4 => (x, 1.0 - y),
        5 => (y, x),
        6 => (1.0 - y, x),
        7 => (1.0 - y, 1.0 - x),
        8 => (y, 1.0 - x),
        _ => (x, y),
    }
}

/// Orientation inverse : celle qui ramène l'image affichée à l'image stockée (6 et 8 s'échangent, les autres sont leur propre inverse).
fn inverse_orientation(orientation: u32) -> u32 {
    match orientation {
        6 => 8,
        8 => 6,
        other => other,
    }
}

/// Rectangle normalisé (x, y, w, h) transformé par une orientation : ses deux coins opposés sont transformés, puis remis dans l'ordre.
fn orient_rect(rect: [f64; 4], orientation: u32) -> [f64; 4] {
    let (x1, y1) = orient_point(rect[0], rect[1], orientation);
    let (x2, y2) = orient_point(rect[0] + rect[2], rect[1] + rect[3], orientation);
    [x1.min(x2), y1.min(y2), (x2 - x1).abs(), (y2 - y1).abs()]
}

// ---------------------------------------------------------------------------
// Moteur : ONNX Runtime et YuNet
// ---------------------------------------------------------------------------

/// Environnement ONNX Runtime, créé une seule fois par processus (contrainte de la crate ort) et gardé ensuite.
fn environment(runtime: &Path) -> Result<Environment, String> {
    static ENVIRONMENT: OnceLock<Result<Environment, String>> = OnceLock::new();
    ENVIRONMENT
        .get_or_init(|| {
            ort::init_from(runtime)
                .map_err(|error| format!("ONNX Runtime impossible à charger : {error}"))?
                .build()
                .map_err(|error| format!("ONNX Runtime impossible à initialiser : {error}"))
        })
        .clone()
}

/// Visage détecté, en coordonnées normalisées de l'image orientée (la miniature).
struct Detection {
    score: f32,
    rect: [f32; 4],
    landmarks: [f32; 10],
}

/// Détecte les visages d'une image RGB orientée. Prétraitement de YuNet : image ramenée à 640 px (plus grand côté), complétée par du noir,
/// canaux BGR, valeurs 0 à 255, format NCHW. Post-traitement d'OpenCV (FaceDetectorYN) : trois échelles (pas de 8, 16, 32 px), score = √(cls × obj),
/// boîte = centre décalé dans la cellule et taille exponentielle, 5 points de repère ; puis suppression des doublons.
fn detect(session: &Mutex<Session>, rgb: &[u8], width: usize, height: usize) -> Result<Vec<Detection>, String> {
    let scale = INPUT_SIDE as f32 / width.max(height) as f32;
    let scaled_width = ((width as f32 * scale).round() as usize).clamp(1, INPUT_SIDE);
    let scaled_height = ((height as f32 * scale).round() as usize).clamp(1, INPUT_SIDE);
    let plane = INPUT_SIDE * INPUT_SIDE;
    let mut input = vec![0f32; 3 * plane];
    // Rééchantillonnage bilinéaire.
    for y in 0..scaled_height {
        let source_y = ((y as f32 + 0.5) / scale - 0.5).clamp(0.0, (height - 1) as f32);
        let (y0, fy) = (source_y.floor() as usize, source_y.fract());
        let y1 = (y0 + 1).min(height - 1);
        for x in 0..scaled_width {
            let source_x = ((x as f32 + 0.5) / scale - 0.5).clamp(0.0, (width - 1) as f32);
            let (x0, fx) = (source_x.floor() as usize, source_x.fract());
            let x1 = (x0 + 1).min(width - 1);
            for channel in 0..3 {
                let sample = |sx: usize, sy: usize| rgb[(sy * width + sx) * 3 + channel] as f32;
                let top = sample(x0, y0) * (1.0 - fx) + sample(x1, y0) * fx;
                let bottom = sample(x0, y1) * (1.0 - fx) + sample(x1, y1) * fx;
                // BGR : le canal bleu (2) en premier.
                input[(2 - channel) * plane + y * INPUT_SIDE + x] = top * (1.0 - fy) + bottom * fy;
            }
        }
    }
    let tensor = Tensor::from_array(([1usize, 3, INPUT_SIDE, INPUT_SIDE], input)).map_err(|error| error.to_string())?;
    let mut candidates: Vec<Detection> = Vec::new();
    {
        let mut session = session.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let outputs = session.run(ort::inputs!["input" => tensor]).map_err(|error| format!("Détection impossible : {error}"))?;
        for stride in [8usize, 16, 32] {
            let output = |name: &str| -> Result<&[f32], String> {
                let key = format!("{name}_{stride}");
                let value = outputs.get(key.as_str()).ok_or_else(|| format!("Sortie {key} absente du modèle"))?;
                value.try_extract_tensor::<f32>().map(|(_, data)| data).map_err(|error| error.to_string())
            };
            let (cls, obj, bbox, kps) = (output("cls")?, output("obj")?, output("bbox")?, output("kps")?);
            let columns = INPUT_SIDE / stride;
            let step = stride as f32;
            for index in 0..cls.len().min(obj.len()) {
                let score = (cls[index].clamp(0.0, 1.0) * obj[index].clamp(0.0, 1.0)).sqrt();
                if score < SCORE_FLOOR { continue; }
                let (row, column) = ((index / columns) as f32, (index % columns) as f32);
                let center_x = (column + bbox[index * 4]) * step;
                let center_y = (row + bbox[index * 4 + 1]) * step;
                let box_width = bbox[index * 4 + 2].exp() * step;
                let box_height = bbox[index * 4 + 3].exp() * step;
                let mut landmarks = [0f32; 10];
                for point in 0..5 {
                    landmarks[point * 2] = (kps[index * 10 + point * 2] + column) * step;
                    landmarks[point * 2 + 1] = (kps[index * 10 + point * 2 + 1] + row) * step;
                }
                candidates.push(Detection { score, rect: [center_x - box_width / 2.0, center_y - box_height / 2.0, box_width, box_height], landmarks });
            }
        }
    }
    // Suppression des doublons : la détection la plus sûre l'emporte sur celles qui la recouvrent.
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for candidate in candidates {
        if kept.iter().all(|other| iou(&other.rect.map(f64::from), &candidate.rect.map(f64::from)) < NMS_IOU as f64) { kept.push(candidate); }
    }
    // Coordonnées en pixels de l'entrée (640) -> normalisées dans l'image orientée, ramenées dans l'image.
    let (shown_width, shown_height) = (scaled_width as f32, scaled_height as f32);
    for detection in &mut kept {
        let x1 = (detection.rect[0] / shown_width).clamp(0.0, 1.0);
        let y1 = (detection.rect[1] / shown_height).clamp(0.0, 1.0);
        let x2 = ((detection.rect[0] + detection.rect[2]) / shown_width).clamp(0.0, 1.0);
        let y2 = ((detection.rect[1] + detection.rect[3]) / shown_height).clamp(0.0, 1.0);
        detection.rect = [x1, y1, x2 - x1, y2 - y1];
        for point in 0..5 {
            detection.landmarks[point * 2] = (detection.landmarks[point * 2] / shown_width).clamp(0.0, 1.0);
            detection.landmarks[point * 2 + 1] = (detection.landmarks[point * 2 + 1] / shown_height).clamp(0.0, 1.0);
        }
    }
    kept.retain(|detection| detection.rect[2] > 0.0 && detection.rect[3] > 0.0);
    Ok(kept)
}

/// Recouvrement (intersection / union) de deux rectangles (x, y, w, h).
fn iou(a: &[f64; 4], b: &[f64; 4]) -> f64 {
    let x1 = a[0].max(b[0]);
    let y1 = a[1].max(b[1]);
    let x2 = (a[0] + a[2]).min(b[0] + b[2]);
    let y2 = (a[1] + a[3]).min(b[1] + b[3]);
    let intersection = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
    let union = a[2] * a[3] + b[2] * b[3] - intersection;
    if union > 0.0 { intersection / union } else { 0.0 }
}

/// Netteté d'une zone (rectangle normalisé) : variance du laplacien sur la zone ramenée à 112 × 112 px en niveaux de gris.
/// Un visage flou a peu de contours marqués, donc une variance faible.
fn sharpness(rgb: &[u8], width: usize, height: usize, rect: [f32; 4]) -> f64 {
    let side = SHARPNESS_SIDE;
    let left = rect[0] * width as f32;
    let top = rect[1] * height as f32;
    let step_x = rect[2] * width as f32 / side as f32;
    let step_y = rect[3] * height as f32 / side as f32;
    let mut gray = vec![0f64; side * side];
    for y in 0..side {
        let source_y = ((top + (y as f32 + 0.5) * step_y) as usize).min(height - 1);
        for x in 0..side {
            let source_x = ((left + (x as f32 + 0.5) * step_x) as usize).min(width - 1);
            let pixel = (source_y * width + source_x) * 3;
            gray[y * side + x] = 0.299 * rgb[pixel] as f64 + 0.587 * rgb[pixel + 1] as f64 + 0.114 * rgb[pixel + 2] as f64;
        }
    }
    let mut values = Vec::with_capacity((side - 2) * (side - 2));
    for y in 1..side - 1 {
        for x in 1..side - 1 {
            let center = gray[y * side + x];
            values.push(gray[(y - 1) * side + x] + gray[(y + 1) * side + x] + gray[y * side + x - 1] + gray[y * side + x + 1] - 4.0 * center);
        }
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    values.iter().map(|value| (value - mean).powi(2)).sum::<f64>() / values.len() as f64
}

/// Miniature JPEG du cache décodée en RGB.
fn decode_thumbnail(path: &Path) -> Result<(Vec<u8>, usize, usize), String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut decoder = jpeg_decoder::Decoder::new(BufReader::new(file));
    let pixels = decoder.decode().map_err(|error| format!("Miniature illisible : {error}"))?;
    let info = decoder.info().ok_or("Miniature illisible")?;
    let (width, height) = (info.width as usize, info.height as usize);
    let rgb = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => pixels,
        jpeg_decoder::PixelFormat::L8 => pixels.iter().flat_map(|&value| [value, value, value]).collect(),
        _ => return Err("Format de miniature non pris en charge".to_string()),
    };
    if width < 2 || height < 2 || rgb.len() != width * height * 3 { return Err("Miniature illisible".to_string()); }
    Ok((rgb, width, height))
}

// ---------------------------------------------------------------------------
// Photos à scanner
// ---------------------------------------------------------------------------

/// Photo visée par un scan : chemin, dimensions de l'image stockée (EXIF), orientation, date de modification du fichier.
struct Target {
    photo_id: i64,
    path: String,
    width: i64,
    height: i64,
    orientation: u32,
    modified: i64,
}

fn is_raw_path(path: &str) -> bool {
    let extension = Path::new(path).extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    matches!(extension.as_str(), "arw" | "cr2" | "cr3" | "nef" | "nrw" | "dng" | "raf" | "orf" | "rw2" | "raw")
}

/// Photos visées : une sélection (`photo_ids`) ou un dossier (`folder`, sous-dossiers compris si `recursive`). Les vidéos sont exclues, les RAW
/// aussi si le réglage l'indique. Renvoie (photo, déjà scannée avec le détecteur actuel ?).
fn select_targets(conn: &Connection, photo_ids: Option<&[i64]>, folder: Option<&str>, recursive: bool) -> Result<Vec<(Target, bool)>, String> {
    let columns = "SELECT p.id, p.path, p.width, p.height, p.orientation, p.modified,
                   EXISTS(SELECT 1 FROM photo_face_scans s WHERE s.photo_id = p.id AND s.detector_id = ?1)
                   FROM photos p WHERE p.path IS NOT NULL AND ";
    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<(Target, bool)> {
        Ok((
            Target {
                photo_id: row.get(0)?,
                path: row.get(1)?,
                width: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                height: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                orientation: row.get::<_, Option<u32>>(4)?.unwrap_or(1),
                modified: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
            },
            row.get(6)?,
        ))
    };
    let rows: Vec<(Target, bool)> = if let Some(ids) = photo_ids {
        let ids_json = serde_json::to_string(ids).map_err(|error| error.to_string())?;
        let mut statement = conn
            .prepare(&format!("{columns} p.id IN (SELECT value FROM json_each(?2))"))
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![DETECTOR_ID, ids_json], map_row).map_err(|error| error.to_string())?;
        rows.flatten().collect()
    } else {
        // Même critère que db::get_photos : chemins comparés avec des « / », sous-dossiers selon `recursive`.
        let folder = folder.ok_or("Aucune photo visée")?;
        let prefix = format!("{}/", folder.replace('\\', "/").trim_end_matches('/'));
        let mut statement = conn
            .prepare(&format!(
                "{columns} substr(replace(p.path, char(92), '/'), 1, length(?2)) = ?2
                 AND (?3 OR instr(substr(replace(p.path, char(92), '/'), length(?2) + 1), '/') = 0)"
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement.query_map(params![DETECTOR_ID, prefix, recursive], map_row).map_err(|error| error.to_string())?;
        rows.flatten().collect()
    };
    let scan_raw = settings().scan_raw;
    Ok(rows
        .into_iter()
        .filter(|(target, _)| !crate::video::is_video_path(Path::new(&target.path)) && (scan_raw || !is_raw_path(&target.path)))
        .collect())
}

#[derive(Serialize)]
pub struct ScanTargetCount {
    pub total: usize,
    pub unscanned: usize,
}

/// Nombre de photos visées (fenêtre de lancement) : toutes, et celles qui n'ont pas encore été scannées avec le détecteur actuel.
#[tauri::command(async)]
pub fn count_face_scan_targets(state: State<'_, AppState>, photo_ids: Option<Vec<i64>>, folder: Option<String>, recursive: bool) -> Result<ScanTargetCount, String> {
    let pool = state.pool();
    let conn = pool.get().map_err(|error| error.to_string())?;
    let targets = select_targets(&conn, photo_ids.as_deref(), folder.as_deref(), recursive)?;
    Ok(ScanTargetCount { total: targets.len(), unscanned: targets.iter().filter(|(_, scanned)| !scanned).count() })
}

// ---------------------------------------------------------------------------
// Scan et enregistrement
// ---------------------------------------------------------------------------

/// Visage mesuré, en coordonnées de l'image STOCKÉE.
struct MeasuredFace {
    rect: [f64; 4],
    landmarks: [f32; 10],
    score: f64,
    sharpness: f64,
    size_px: f64,
    size_percent: f64,
}

/// Analyse d'une photo : miniature (générée si absente), détection, mesures, conversion vers le repère de l'image stockée.
fn analyse(target: &Target, thumbnails_dir: &Path, cache_size: usize, session: &Mutex<Session>) -> Result<Vec<MeasuredFace>, String> {
    let source = Path::new(&target.path);
    let thumbnail = crate::thumbnail_cache_file(thumbnails_dir, &target.path)?;
    if !thumbnail.is_file() {
        crate::thumbnails::generate_thumbnail(source, &thumbnail, cache_size)?;
    }
    let (rgb, width, height) = decode_thumbnail(&thumbnail)?;
    let detections = detect(session, &rgb, width, height)?;
    // Dimensions de la photo d'origine, orientée comme la miniature (à défaut : celles de la miniature).
    let (original_width, original_height) = if target.width > 0 && target.height > 0 {
        if target.orientation >= 5 { (target.height as f64, target.width as f64) } else { (target.width as f64, target.height as f64) }
    } else {
        (width as f64, height as f64)
    };
    let back = inverse_orientation(target.orientation);
    Ok(detections
        .into_iter()
        .map(|detection| {
            let shown = detection.rect.map(f64::from);
            let size_px = (shown[2] * original_width).max(shown[3] * original_height);
            let mut landmarks = [0f32; 10];
            for point in 0..5 {
                let (x, y) = orient_point(detection.landmarks[point * 2] as f64, detection.landmarks[point * 2 + 1] as f64, back);
                landmarks[point * 2] = x as f32;
                landmarks[point * 2 + 1] = y as f32;
            }
            MeasuredFace {
                rect: orient_rect(shown, back),
                landmarks,
                score: detection.score as f64,
                sharpness: sharpness(&rgb, width, height, detection.rect),
                size_px,
                size_percent: size_px / original_width.max(original_height) * 100.0,
            }
        })
        .collect())
}

fn landmarks_blob(landmarks: &[f32; 10]) -> Vec<u8> {
    landmarks.iter().flat_map(|value| value.to_le_bytes()).collect()
}

/// Enregistre les visages détectés d'une photo, fusionnés avec ceux déjà en base (spec §7.1) :
/// - une détection qui recouvre un visage existant (IoU ≥ 0,5) en garde l'identité et l'état ; ce visage reçoit les mesures. Les coordonnées
///   des zones importées ou manuelles ne changent pas ;
/// - les zones importées ou manuelles, et les visages confirmés ou ignorés, sont toujours conservés ;
/// - les détections automatiques non confirmées sans correspondance sont remplacées ; les nouvelles détections arrivent « inconnues »
///   (ou « filtrées » sous les seuils).
fn store_detections(conn: &Connection, target: &Target, faces: &[MeasuredFace], current: &FaceSettings) {
    struct Existing { id: i64, rect: [f64; 4], origin: String, state: String, person_id: Option<i64> }
    let existing: Vec<Existing> = conn
        .prepare_cached("SELECT id, x, y, w, h, origin, state, person_id FROM faces WHERE photo_id = ?1")
        .and_then(|mut statement| {
            statement
                .query_map(params![target.photo_id], |row| {
                    Ok(Existing { id: row.get(0)?, rect: [row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?], origin: row.get(5)?, state: row.get(6)?, person_id: row.get(7)? })
                })
                .map(|rows| rows.flatten().collect())
        })
        .unwrap_or_default();
    let mut matched: Vec<i64> = Vec::new();
    for face in faces {
        let measured_state = if current.passes(face.score, face.sharpness, face.size_px, face.size_percent) { "unknown" } else { "filtered" };
        let best = existing
            .iter()
            .filter(|candidate| !matched.contains(&candidate.id))
            .map(|candidate| (candidate, iou(&candidate.rect, &face.rect)))
            .filter(|(_, overlap)| *overlap >= MATCH_IOU)
            .max_by(|a, b| a.1.total_cmp(&b.1));
        match best {
            Some((candidate, _)) => {
                matched.push(candidate.id);
                let detected = candidate.origin == "detected";
                // Seul un visage détecté encore sans personne change d'état d'après ses nouvelles mesures.
                let state = if detected && candidate.person_id.is_none() && (candidate.state == "unknown" || candidate.state == "filtered") {
                    measured_state.to_string()
                } else {
                    candidate.state.clone()
                };
                let rect = if detected { face.rect } else { candidate.rect };
                let _ = conn.execute(
                    "UPDATE faces SET x = ?1, y = ?2, w = ?3, h = ?4, state = ?5, det_score = ?6, sharpness = ?7, size_px = ?8, size_pct = ?9, landmarks = ?10
                     WHERE id = ?11",
                    params![rect[0], rect[1], rect[2], rect[3], state, face.score, face.sharpness, face.size_px, face.size_percent, landmarks_blob(&face.landmarks), candidate.id],
                );
            }
            None => {
                let _ = conn.execute(
                    "INSERT INTO faces (photo_id, x, y, w, h, origin, state, det_score, sharpness, size_px, size_pct, landmarks)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'detected', ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![target.photo_id, face.rect[0], face.rect[1], face.rect[2], face.rect[3], measured_state, face.score, face.sharpness, face.size_px, face.size_percent, landmarks_blob(&face.landmarks)],
                );
            }
        }
    }
    for candidate in existing.iter().filter(|candidate| !matched.contains(&candidate.id)) {
        let replaceable = candidate.origin == "detected" && matches!(candidate.state.as_str(), "unknown" | "filtered" | "suggested" | "auto");
        if replaceable { let _ = conn.execute("DELETE FROM faces WHERE id = ?1", params![candidate.id]); }
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|duration| duration.as_secs() as i64).unwrap_or(0);
    let _ = conn.execute(
        "INSERT OR REPLACE INTO photo_face_scans (photo_id, detector_id, scanned_at, file_mtime, width, height, orientation, needs_review)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
        params![target.photo_id, DETECTOR_ID, now, target.modified, target.width, target.height, target.orientation],
    );
}

#[derive(Serialize)]
pub struct ScanFailure {
    pub path: String,
    pub error: String,
}

#[derive(Serialize, Default)]
pub struct DetectionReport {
    pub scanned: usize,
    pub faces: usize,
    pub failed: Vec<ScanFailure>,
    pub cancelled: bool,
}

/// Scan des visages d'une sélection (`photo_ids`) ou d'un dossier (`folder`, sous-dossiers selon `recursive`) ; `only_unscanned` : seulement les
/// photos pas encore scannées avec le détecteur actuel. Tâche de la file : progression par « scan-progress », arrêt par cancel_scan
/// (les photos déjà traitées restent enregistrées).
#[tauri::command]
pub async fn detect_faces(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    photo_ids: Option<Vec<i64>>,
    folder: Option<String>,
    recursive: bool,
    only_unscanned: bool,
    task_id: String,
) -> Result<DetectionReport, String> {
    let pool = state.pool();
    let models_dir = crate::face_models::models_dir(&state);
    let thumbnails_dir = state.thumbnails_dir();
    let cache_size = state.thumbnail_cache_size();
    let cancel = crate::scan_cancel_flag(&task_id);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || -> Result<DetectionReport, String> {
        let paths = crate::face_models::installed_paths(&models_dir)?;
        let conn = pool.get().map_err(|error| error.to_string())?;
        let targets: Vec<Target> = select_targets(&conn, photo_ids.as_deref(), folder.as_deref(), recursive)?
            .into_iter()
            .filter(|(_, scanned)| !only_unscanned || !scanned)
            .map(|(target, _)| target)
            .collect();
        let mut report = DetectionReport::default();
        if targets.is_empty() { return Ok(report); }
        let environment = environment(&paths.runtime)?;
        let session = Session::builder(&environment)
            .and_then(|builder| builder.with_intra_threads(2).map_err(Into::into))
            .and_then(|mut builder| builder.commit_from_file(&paths.detector))
            .map_err(|error| format!("Modèle de détection impossible à charger : {error}"))?;
        let session = Mutex::new(session);
        // Moitié des cœurs pour lire les miniatures (le reste pour l'interface) ; l'inférence, rapide, passe une photo à la fois.
        let threads = std::thread::available_parallelism().map(|count| (count.get() / 2).max(1)).unwrap_or(2);
        let pool_threads = rayon::ThreadPoolBuilder::new().num_threads(threads).build().map_err(|error| error.to_string())?;
        let current = settings();
        let total = targets.len();
        for (chunk_index, chunk) in targets.chunks(24).enumerate() {
            if cancel.load(Ordering::Relaxed) { report.cancelled = true; break; }
            let results: Vec<Result<Vec<MeasuredFace>, String>> =
                pool_threads.install(|| chunk.par_iter().map(|target| analyse(target, &thumbnails_dir, cache_size, &session)).collect());
            let _ = conn.execute("BEGIN TRANSACTION", []);
            for (target, result) in chunk.iter().zip(results) {
                match result {
                    Ok(faces) => {
                        store_detections(&conn, target, &faces, &current);
                        report.scanned += 1;
                        report.faces += faces.len();
                    }
                    Err(error) => report.failed.push(ScanFailure { path: target.path.clone(), error }),
                }
            }
            let _ = conn.execute("COMMIT", []);
            let done = (chunk_index * 24 + chunk.len()).min(total);
            let _ = app.emit("scan-progress", crate::ScanProgress { task_id: worker_task_id.clone(), percent: (done * 100 / total) as u32 });
        }
        Ok(report)
    })
    .await;
    crate::release_scan_cancel_flag(&task_id);
    outcome.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
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
}
