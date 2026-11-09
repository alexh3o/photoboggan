//! Files of face detection and recognition: ONNX models (YuNet, SFace) and the ONNX Runtime library of the platform.
//!
//! They are downloaded on demand from a photoboggan GitHub release (manifest `face_models.json`, prepared by scripts/prepare-face-models.mjs:
//! names, sizes and SHA-256 pinned), or copied from a folder chosen by the user (no Internet). Downloads are refused in offline mode
//! (`set_internet_allowed`, also checked by every other network access of the application).
//! They live in the application data folder (`models/`), never in photo folders. The generic part (verified install, download, import)
//! is in model_files.rs; the ONNX Runtime library is shared with the semantic search (semantic_models.rs).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{Emitter, State};

use crate::model_files::{self, Expected, ModelFileStatus, BODY_TIMEOUT};
use crate::AppState;

#[derive(Deserialize)]
struct ModelFile {
    /// « detector », « recognizer » ou « runtime ».
    role: String,
    /// « any », ou la plateforme de la bibliothèque ONNX Runtime (« windows-x86_64 », « linux-x86_64 »).
    platform: String,
    /// Nom sur la release.
    asset: String,
    /// Nom dans le dossier models/.
    local: String,
    size: u64,
    sha256: String,
}

impl ModelFile {
    fn expected(&self) -> Expected<'_> {
        Expected { asset: &self.asset, local: &self.local, size: self.size, sha256: &self.sha256 }
    }
}

#[derive(Deserialize)]
struct Manifest {
    base_url: String,
    files: Vec<ModelFile>,
}

/// Accès à Internet autorisé (Paramètres > Général, « Mode hors ligne » décoché) ; envoyé par l'interface au démarrage puis à chaque changement.
/// Refusé tant que l'interface ne l'a pas envoyé : aucun téléchargement ne peut partir avant que le réglage soit connu.
static INTERNET_ALLOWED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn set_internet_allowed(allowed: bool) {
    INTERNET_ALLOWED.store(allowed, Ordering::Relaxed);
}

/// Accès à Internet autorisé : vérifié aussi par les téléchargements des zones privées (private_maps.rs).
pub fn internet_allowed() -> bool {
    INTERNET_ALLOWED.load(Ordering::Relaxed)
}

fn manifest() -> &'static Manifest {
    static MANIFEST: OnceLock<Manifest> = OnceLock::new();
    MANIFEST.get_or_init(|| serde_json::from_str(include_str!("../face_models.json")).expect("face_models.json invalide"))
}

/// Plateforme de la bibliothèque ONNX Runtime à installer ; None : pas de bibliothèque publiée pour ce système.
fn current_platform() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some("windows-x86_64")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("linux-x86_64")
    } else {
        None
    }
}

/// Fichiers nécessaires sur cette plateforme (modèles + bibliothèque ONNX Runtime).
fn platform_files() -> Vec<&'static ModelFile> {
    let platform = current_platform();
    manifest().files.iter().filter(|file| file.platform == "any" || Some(file.platform.as_str()) == platform).collect()
}

pub fn models_dir(state: &AppState) -> PathBuf {
    state.base_dir().join("models")
}

/// Installed file: present with the expected size (its SHA-256 was checked when it was installed).
fn is_installed(dir: &Path, file: &ModelFile) -> bool {
    model_files::is_installed(dir, &file.expected())
}

/// ONNX Runtime library of this platform: (base address of the release, expected file). Shared with the semantic search
/// (semantic_models.rs), which installs it in the same `models/` folder when faces never did. None: no library published for this system.
pub(crate) fn runtime_file() -> Option<(&'static str, Expected<'static>)> {
    platform_files().into_iter().find(|file| file.role == "runtime").map(|file| (manifest().base_url.as_str(), file.expected()))
}

/// Chemins des fichiers installés, utilisés par face_detect.rs.
pub struct ModelPaths {
    pub runtime: PathBuf,
    pub detector: PathBuf,
    pub recognizer: PathBuf,
}

pub fn installed_paths(dir: &Path) -> Result<ModelPaths, String> {
    if current_platform().is_none() { return Err("faces_unsupported_platform".to_string()); }
    let files = platform_files();
    if !files.iter().all(|file| is_installed(dir, file)) { return Err("face_models_missing".to_string()); }
    let path_of = |role: &str| files.iter().find(|file| file.role == role).map(|file| dir.join(&file.local)).ok_or_else(|| "face_models_missing".to_string());
    Ok(ModelPaths { runtime: path_of("runtime")?, detector: path_of("detector")?, recognizer: path_of("recognizer")? })
}

#[derive(Serialize)]
pub struct ModelStatus {
    /// Une bibliothèque ONNX Runtime est publiée pour ce système.
    pub supported: bool,
    pub installed: bool,
    /// Dossier où les fichiers sont rangés (indiqué pour une installation sans Internet).
    pub directory: String,
    /// Taille totale restant à télécharger (octets).
    pub missing_size: u64,
    pub files: Vec<ModelFileStatus>,
}

fn status(dir: &Path) -> ModelStatus {
    let files: Vec<ModelFileStatus> = platform_files()
        .into_iter()
        .map(|file| model_files::file_status(&manifest().base_url, dir, &file.expected()))
        .collect();
    ModelStatus {
        supported: current_platform().is_some(),
        installed: current_platform().is_some() && files.iter().all(|file| file.installed),
        directory: dir.to_string_lossy().into_owned(),
        missing_size: files.iter().filter(|file| !file.installed).map(|file| file.size).sum(),
        files,
    }
}

#[tauri::command(async)]
pub fn get_face_model_status(state: State<'_, AppState>) -> ModelStatus {
    status(&models_dir(&state))
}

/// Télécharge les fichiers manquants depuis la release GitHub (tâche de la file : progression par « scan-progress », arrêt par cancel_scan).
#[tauri::command]
pub async fn download_face_models(app: tauri::AppHandle, state: State<'_, AppState>, task_id: String) -> Result<(), String> {
    let dir = models_dir(&state);
    let cancel = crate::scan_cancel_flag(&task_id);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        if current_platform().is_none() { return Err("faces_unsupported_platform".to_string()); }
        let missing: Vec<&ModelFile> = platform_files().into_iter().filter(|file| !is_installed(&dir, file)).collect();
        let total = missing.iter().map(|file| file.size).sum::<u64>().max(1);
        let mut done = 0u64;
        let mut last_percent = u32::MAX;
        for file in missing {
            // Vérifié avant chaque fichier : passer en mode hors ligne n'interrompt pas le fichier en cours (il va jusqu'au bout), mais les suivants sont refusés.
            if !INTERNET_ALLOWED.load(Ordering::Relaxed) { return Err("internet_disabled".to_string()); }
            let url = format!("{}{}", manifest().base_url, file.asset);
            model_files::download(&url, &dir, &file.expected(), BODY_TIMEOUT, &cancel, &mut |bytes| {
                done += bytes;
                let percent = (done * 100 / total) as u32;
                if percent != last_percent {
                    last_percent = percent;
                    let _ = app.emit("scan-progress", crate::ScanProgress { task_id: worker_task_id.clone(), percent });
                }
            })?;
        }
        Ok(())
    })
    .await;
    crate::release_scan_cancel_flag(&task_id);
    match outcome.map_err(|error| error.to_string())? {
        Err(error) if error == "cancelled" => Ok(()), // arrêt demandé : rien d'installé à moitié
        other => other,
    }
}

/// Installation sans Internet : copie depuis `directory` les fichiers manquants (nom de la release ou nom local), après vérification.
#[tauri::command(async)]
pub fn import_face_models(state: State<'_, AppState>, directory: String) -> Result<ModelStatus, String> {
    let dir = models_dir(&state);
    if current_platform().is_none() { return Err("faces_unsupported_platform".to_string()); }
    let source_dir = PathBuf::from(directory);
    let mut problems: Vec<String> = Vec::new();
    for file in platform_files().into_iter().filter(|file| !is_installed(&dir, file)) {
        if let Err(error) = model_files::import_from(&source_dir, &dir, &file.expected()) { problems.push(error); }
    }
    if problems.is_empty() { Ok(status(&dir)) } else { Err(problems.join("\n")) }
}
