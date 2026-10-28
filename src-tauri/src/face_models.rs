//! Fichiers de la détection et de la reconnaissance des visages : modèles ONNX (YuNet, SFace) et bibliothèque ONNX Runtime de la plateforme.
//!
//! Ils sont téléchargés à la demande depuis une release GitHub de photoboggan (manifeste `face_models.json`, préparé par
//! scripts/prepare-face-models.mjs : noms, tailles et SHA-256 figés), ou copiés depuis un dossier choisi par l'utilisateur (sans Internet).
//! Ils sont rangés dans le dossier de données de l'application (`models/`), jamais dans les dossiers de photos. Un fichier n'est installé
//! qu'une fois sa somme SHA-256 vérifiée : il est écrit à côté (`.part`) puis renommé.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{Emitter, State};

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

#[derive(Deserialize)]
struct Manifest {
    base_url: String,
    files: Vec<ModelFile>,
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

/// Fichier installé : présent avec la taille attendue (la somme SHA-256 a été vérifiée à l'installation).
fn is_installed(dir: &Path, file: &ModelFile) -> bool {
    fs::metadata(dir.join(&file.local)).is_ok_and(|metadata| metadata.is_file() && metadata.len() == file.size)
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
pub struct ModelFileStatus {
    pub name: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub installed: bool,
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
        .map(|file| ModelFileStatus {
            name: file.asset.clone(),
            url: format!("{}{}", manifest().base_url, file.asset),
            sha256: file.sha256.clone(),
            size: file.size,
            installed: is_installed(dir, file),
        })
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

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Copie `reader` dans `<local>.part` en calculant la somme SHA-256, puis renomme le fichier si la somme et la taille sont celles attendues.
/// `on_bytes(n)` est appelé après chaque bloc écrit ; `cancel` interrompt la copie (le fichier partiel est supprimé).
fn install_from(reader: &mut dyn Read, dir: &Path, file: &ModelFile, cancel: Option<&AtomicBool>, on_bytes: &mut dyn FnMut(u64)) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("Dossier des modèles impossible à créer : {error}"))?;
    let partial = dir.join(format!("{}.part", file.local));
    let result = (|| {
        let mut output = fs::File::create(&partial).map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        let mut written = 0u64;
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) { return Err("cancelled".to_string()); }
            let count = reader.read(&mut buffer).map_err(|error| format!("{} : {error}", file.asset))?;
            if count == 0 { break; }
            output.write_all(&buffer[..count]).map_err(|error| error.to_string())?;
            hasher.update(&buffer[..count]);
            written += count as u64;
            on_bytes(count as u64);
        }
        output.sync_all().map_err(|error| error.to_string())?;
        if written != file.size || hex(&hasher.finalize()) != file.sha256 {
            return Err(format!("{} : fichier corrompu (taille ou somme SHA-256 inattendue)", file.asset));
        }
        Ok(())
    })();
    match result {
        Ok(()) => fs::rename(&partial, dir.join(&file.local)).map_err(|error| error.to_string()),
        Err(error) => {
            let _ = fs::remove_file(&partial);
            Err(error)
        }
    }
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
            let url = format!("{}{}", manifest().base_url, file.asset);
            let response = ureq::get(&url).call().map_err(|error| format!("{url} : {error}"))?;
            let mut reader = response.into_body().into_reader();
            install_from(&mut reader, &dir, file, Some(&cancel), &mut |bytes| {
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
        let Some(source) = [&file.asset, &file.local].into_iter().map(|name| source_dir.join(name)).find(|path| path.is_file()) else {
            problems.push(format!("{} : introuvable", file.asset));
            continue;
        };
        let result = fs::File::open(&source)
            .map_err(|error| error.to_string())
            .and_then(|mut reader| install_from(&mut reader, &dir, file, None, &mut |_| {}));
        if let Err(error) = result { problems.push(error); }
    }
    if problems.is_empty() { Ok(status(&dir)) } else { Err(problems.join("\n")) }
}
