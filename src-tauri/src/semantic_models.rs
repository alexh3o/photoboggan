//! Files of the semantic search (SigLIP 2, spec dev_tools/Evolutions/feat semantic search SigLIP 2.md, §3): manifest, status, download,
//! import from a folder, deletion.
//!
//! - Manifest `semantic_models.json` (prepared by scripts/prepare-semantic-models.mjs): one entry per model with its constants
//!   (image size, embedding size, normalisation, tokens, logit scale / bias, prompt template) and its files (name, size, SHA-256).
//!   v1 ships a single model, the first entry, which is the active one.
//! - Files go to `<app data>/models/semantic/<model_id>/`. The ONNX Runtime library is the one of the faces (face_models.json), kept once
//!   in `models/`: a semantic download installs it too when faces never did.
//! - Downloads are refused in offline mode (`internet_allowed()`); import from a folder works without Internet.
//! - Every command refuses with the key `semantic_disabled` until the interface has enabled the feature (`set_semantic_enabled`, sent at
//!   startup and on change, like `set_internet_allowed`): nothing related to the feature runs while it is off.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{Emitter, State};

use crate::model_files::{self, Expected, ModelFileStatus, BODY_TIMEOUT};
use crate::AppState;

#[derive(Deserialize)]
pub struct ModelFile {
    /// "vision", "text", "tokenizer" or "notice".
    pub role: String,
    /// Name on the release.
    pub asset: String,
    /// Name in the model folder.
    pub local: String,
    pub size: u64,
    pub sha256: String,
}

impl ModelFile {
    fn expected(&self) -> Expected<'_> {
        Expected { asset: &self.asset, local: &self.local, size: self.size, sha256: &self.sha256 }
    }
}

/// Constants of one model (spec §3.3). Values come from the checkpoint (Phase 0, §15.1).
#[derive(Deserialize)]
#[allow(dead_code)] // eos_id: documents the tokenizer, which appends it itself
pub struct ModelSpec {
    pub id: String,
    pub label: String,
    /// Side of the square image fed to the vision encoder.
    pub image_size: usize,
    /// Length of the embeddings (both encoders).
    pub embed_dim: usize,
    pub mean: [f32; 3],
    pub std: [f32; 3],
    /// Length of the token sequence fed to the text encoder (truncated / padded).
    pub max_text_tokens: usize,
    /// Queries are lowercased before tokenisation.
    pub lowercase: bool,
    /// Sigmoid probability of a match: sigmoid(cos × logit_scale + logit_bias) (scale already exponentiated).
    pub logit_scale: f32,
    pub logit_bias: f32,
    /// Template wrapped around short queries (`{}` = the query).
    pub template: String,
    /// Queries of at most this many words are wrapped in the template.
    pub template_max_words: usize,
    pub pad_id: u32,
    pub eos_id: u32,
    pub files: Vec<ModelFile>,
}

impl ModelSpec {
    fn file(&self, role: &str) -> Option<&ModelFile> {
        self.files.iter().find(|file| file.role == role)
    }
}

#[derive(Deserialize)]
struct Manifest {
    base_url: String,
    models: Vec<ModelSpec>,
}

fn manifest() -> &'static Manifest {
    static MANIFEST: OnceLock<Manifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        let manifest: Manifest = serde_json::from_str(include_str!("../semantic_models.json")).expect("semantic_models.json is not valid");
        assert!(!manifest.models.is_empty(), "semantic_models.json lists no model");
        manifest
    })
}

/// Model of the manifest with this id (None: a model of an older version, no longer shipped).
pub fn model_by_id(id: &str) -> Option<&'static ModelSpec> {
    manifest().models.iter().find(|model| model.id == id)
}

/// Model used by scans and searches (v1: the only one of the manifest).
pub fn active_model() -> &'static ModelSpec {
    &manifest().models[0]
}

// ---------------------------------------------------------------------------
// Gating: the feature is off until the interface says otherwise
// ---------------------------------------------------------------------------

static ENABLED: AtomicBool = AtomicBool::new(false);

/// Error key of every semantic command while the feature is disabled (translated by the interface).
pub const DISABLED_ERROR: &str = "semantic_disabled";

/// Refuses with `semantic_disabled` while the feature is off.
pub fn ensure_enabled() -> Result<(), String> {
    if ENABLED.load(Ordering::Relaxed) { Ok(()) } else { Err(DISABLED_ERROR.to_string()) }
}

/// Setting "Enable content search", sent by the interface at startup and on every change. Disabling cancels a running scan and frees the
/// memory held by the feature.
#[tauri::command]
pub fn set_semantic_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
    if !enabled { crate::semantic::on_disabled(); }
}

// ---------------------------------------------------------------------------
// Paths and status
// ---------------------------------------------------------------------------

/// Folder of the files of `model` (inside `models/`, next to the face models and the ONNX Runtime library).
pub fn model_dir(models_dir: &Path, model: &ModelSpec) -> PathBuf {
    models_dir.join("semantic").join(&model.id)
}

/// Paths of the installed files, used by the scan and the searches.
pub struct ModelPaths {
    pub runtime: PathBuf,
    pub vision: PathBuf,
    pub text: PathBuf,
    pub tokenizer: PathBuf,
}

/// Paths of the files of `model`, or `semantic_unsupported_platform` (no ONNX Runtime library published for this system) /
/// `semantic_model_missing` (a file is missing).
pub fn installed_paths(models_dir: &Path, model: &ModelSpec) -> Result<ModelPaths, String> {
    let (_, runtime) = crate::face_models::runtime_file().ok_or("semantic_unsupported_platform")?;
    let dir = model_dir(models_dir, model);
    let missing = || "semantic_model_missing".to_string();
    if !model_files::is_installed(models_dir, &runtime) || !model.files.iter().all(|file| model_files::is_installed(&dir, &file.expected())) {
        return Err(missing());
    }
    let path_of = |role: &str| model.file(role).map(|file| dir.join(&file.local)).ok_or_else(missing);
    Ok(ModelPaths { runtime: models_dir.join(runtime.local), vision: path_of("vision")?, text: path_of("text")?, tokenizer: path_of("tokenizer")? })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub model_id: String,
    pub label: String,
    /// An ONNX Runtime library is published for this system.
    pub supported: bool,
    /// Model files and ONNX Runtime library all installed.
    pub installed: bool,
    /// The ONNX Runtime library (shared with faces) is installed.
    pub runtime_installed: bool,
    /// Folder of the model files (shown for an installation without Internet).
    pub directory: String,
    /// Total size still to download (bytes), ONNX Runtime library included when it is missing.
    pub missing_size: u64,
    /// Total size of the model files (bytes), without the ONNX Runtime library.
    pub model_size: u64,
    /// Model files, then the ONNX Runtime library (installed in the parent `models/` folder).
    pub files: Vec<ModelFileStatus>,
}

pub fn status(models_dir: &Path, model: &ModelSpec) -> ModelStatus {
    let dir = model_dir(models_dir, model);
    let mut files: Vec<ModelFileStatus> =
        model.files.iter().map(|file| model_files::file_status(&manifest().base_url, &dir, &file.expected())).collect();
    let runtime = crate::face_models::runtime_file();
    let runtime_installed = runtime.is_some_and(|(_, file)| model_files::is_installed(models_dir, &file));
    if let Some((base_url, file)) = runtime { files.push(model_files::file_status(base_url, models_dir, &file)); }
    ModelStatus {
        model_id: model.id.clone(),
        label: model.label.clone(),
        supported: runtime.is_some(),
        installed: runtime.is_some() && files.iter().all(|file| file.installed),
        runtime_installed,
        directory: dir.to_string_lossy().into_owned(),
        missing_size: files.iter().filter(|file| !file.installed).map(|file| file.size).sum(),
        model_size: model.files.iter().map(|file| file.size).sum(),
        files,
    }
}

#[tauri::command(async)]
pub fn get_semantic_model_status(state: State<'_, AppState>) -> Result<ModelStatus, String> {
    ensure_enabled()?;
    Ok(status(&crate::face_models::models_dir(&state), active_model()))
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/// A missing file: where it goes, where it comes from.
struct Missing {
    dir: PathBuf,
    base_url: &'static str,
    file: Expected<'static>,
}

/// Files of `model` still missing, ONNX Runtime library first (smallest, and needed by faces too).
fn missing_files(models_dir: &Path, model: &'static ModelSpec) -> Result<Vec<Missing>, String> {
    let (runtime_url, runtime) = crate::face_models::runtime_file().ok_or("semantic_unsupported_platform")?;
    let mut missing = Vec::new();
    if !model_files::is_installed(models_dir, &runtime) {
        missing.push(Missing { dir: models_dir.to_path_buf(), base_url: runtime_url, file: runtime });
    }
    let dir = model_dir(models_dir, model);
    for file in &model.files {
        if !model_files::is_installed(&dir, &file.expected()) {
            missing.push(Missing { dir: dir.clone(), base_url: &manifest().base_url, file: file.expected() });
        }
    }
    Ok(missing)
}

/// Longest time to receive one file: the face limit (15 min) is too short for the 565 MB text model on a slow link, so allow at least
/// 1 Mbit/s (128 KiB/s). A frozen connection still fails after 30 s without data (IDLE_TIMEOUT).
fn body_timeout(size: u64) -> Duration {
    BODY_TIMEOUT.max(Duration::from_secs(size / (128 * 1024)))
}

/// Downloads the missing files from the GitHub release (queue task: progress through "scan-progress", stop through cancel_scan). The ONNX
/// Runtime library comes from the face release when it is missing. Files already complete are kept after a stop or an error.
#[tauri::command]
pub async fn download_semantic_model(app: tauri::AppHandle, state: State<'_, AppState>, task_id: String) -> Result<(), String> {
    ensure_enabled()?;
    let models_dir = crate::face_models::models_dir(&state);
    let cancel = crate::scan_cancel_flag(&task_id);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let missing = missing_files(&models_dir, active_model())?;
        let total = missing.iter().map(|item| item.file.size).sum::<u64>().max(1);
        let mut done = 0u64;
        let mut last_percent = u32::MAX;
        for item in missing {
            // Checked before each file: going offline does not stop the current file (it completes), but the next ones are refused.
            if !crate::face_models::internet_allowed() { return Err("internet_disabled".to_string()); }
            ensure_enabled()?;
            let url = format!("{}{}", item.base_url, item.file.asset);
            model_files::download(&url, &item.dir, &item.file, body_timeout(item.file.size), &cancel, &mut |bytes| {
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
        Err(error) if error == "cancelled" => Ok(()), // stop requested: nothing half installed
        other => other,
    }
}

/// Installation without Internet: copies the missing files from `directory` (release name or local name), after verification. The ONNX
/// Runtime library is taken from the same folder when it is missing. Returns the new status, or the list of problems (one per line).
#[tauri::command(async)]
pub fn import_semantic_model(state: State<'_, AppState>, directory: String) -> Result<ModelStatus, String> {
    ensure_enabled()?;
    let models_dir = crate::face_models::models_dir(&state);
    let model = active_model();
    let source_dir = PathBuf::from(directory);
    let mut problems: Vec<String> = Vec::new();
    for item in missing_files(&models_dir, model)? {
        if let Err(error) = model_files::import_from(&source_dir, &item.dir, &item.file) { problems.push(error); }
    }
    if problems.is_empty() { Ok(status(&models_dir, model)) } else { Err(problems.join("\n")) }
}

/// Deletes the files of `model` (and partial downloads), then its folder when it is empty. The ONNX Runtime library is kept: faces may use it.
pub fn delete_model_files(models_dir: &Path, model: &ModelSpec) -> Result<(), String> {
    let dir = model_dir(models_dir, model);
    let mut problems = Vec::new();
    for file in &model.files {
        for path in [dir.join(&file.local), dir.join(format!("{}.part", file.local))] {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => problems.push(format!("{} : {error}", path.display())),
            }
        }
    }
    let _ = fs::remove_dir(&dir); // fails when other files remain: kept, as intended
    let _ = fs::remove_dir(models_dir.join("semantic"));
    if problems.is_empty() { Ok(()) } else { Err(problems.join("\n")) }
}

/// "Delete the model files" (Settings, with confirmation in the interface): stops a running scan first. Returns the new status.
#[tauri::command(async)]
pub fn delete_semantic_model(state: State<'_, AppState>) -> Result<ModelStatus, String> {
    ensure_enabled()?;
    // A running scan holds the vision model open, a search the text model (they could not be deleted on Windows): the scan is stopped
    // first, the search memory released, and no text query can load the model again until the files are gone.
    crate::semantic::stop_scan_and_wait()?;
    let models_dir = crate::face_models::models_dir(&state);
    let model = active_model();
    crate::semantic_search::release_all();
    crate::semantic_search::without_text_model(|| delete_model_files(&models_dir, model))?;
    Ok(status(&models_dir, model))
}

#[cfg(test)]
#[path = "tests/semantic_models.rs"]
mod tests;
