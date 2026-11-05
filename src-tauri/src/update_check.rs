//! Mises à jour (Paramètres > Général > Internet, et fenêtre « Mise à jour disponible ») : recherche, téléchargement et lancement de l'installeur.
//!
//! Source : les releases GitHub du dépôt de l'application. Les requêtes partent du backend (jamais de la WebView), n'envoient rien d'autre que le nom
//! et la version de l'application (User-Agent) et sont refusées en mode hors ligne, comme les autres accès au réseau.
//!
//! Règles de choix de la version proposée :
//! * brouillons ignorés, ainsi que les releases dont le tag n'est pas `v<x>.<y>.<z>` (ex. `face-models-1`, qui ne contient pas l'application) ;
//! * pré-releases proposées seulement si l'utilisateur l'a demandé, ou si la version installée est elle-même une beta (suffixe `-beta`, `-rc`…) ;
//! * comparaison sur les trois nombres seuls : le suffixe `-beta` du .deb Linux est ignoré, la version Windows correspondante n'en a pas.
//! La version vient toujours du tag, jamais du nom des fichiers (la release v0.4.2 contient des fichiers nommés 0.4.1).
//!
//! Téléchargement et installation : l'interface ne fournit jamais d'adresse ni de chemin. Le backend retrouve lui-même l'installeur dans la release
//! (adresse du dépôt, somme SHA-256 publiée par GitHub exigée), le télécharge dans le dossier temporaire, vérifie taille et somme, puis ne lance que ce
//! fichier vérifié (somme recalculée juste avant). Windows : installeur NSIS (ou MSI) lancé, puis l'application se ferme. Linux : le .deb est confié
//! au gestionnaire de paquets du système (`xdg-open`), l'installation demandant des droits que l'application n'a pas.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;

use crate::face_models::{hex, IdleReader, BODY_TIMEOUT, CONNECT_TIMEOUT, IDLE_TIMEOUT, RESPONSE_TIMEOUT};

/// Releases les plus récentes d'abord ; 30 suffisent largement pour trouver la dernière version de l'application.
const RELEASES_URL: &str = "https://api.github.com/repos/alexh3o/photoboggan/releases?per_page=30";
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
/// Seules adresses de téléchargement acceptées (fichiers joints aux releases du dépôt).
const DOWNLOAD_URL_PREFIX: &str = "https://github.com/alexh3o/photoboggan/releases/download/";
/// Un installeur plus gros que cela n'est pas celui de l'application.
const MAX_INSTALLER_BYTES: u64 = 500 * 1024 * 1024;

/// Version `x.y.z` avec un éventuel suffixe de pré-version (la partie après le premier « - »).
#[derive(Debug, PartialEq)]
struct Version {
    numbers: (u64, u64, u64),
    pre: Option<String>,
}

/// Lit « 1.2.3 », « v1.2.3 » ou « 1.2.3-beta.1 » ; None si le texte n'a pas cette forme (« face-models-1 »).
fn parse_version(text: &str) -> Option<Version> {
    let text = text.trim().strip_prefix('v').unwrap_or(text.trim());
    let text = text.split('+').next()?; // métadonnées de build ignorées
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) => (core, Some(pre.to_string())),
        None => (text, None),
    };
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let numbers = (parts.next()??, parts.next()??, parts.next()??);
    if parts.next().is_some() { return None; }
    Some(Version { numbers, pre })
}

/// Installeur joint à la release pour ce système. Seuls le nom et la taille vont à l'interface.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct UpdateAsset {
    pub name: String,
    pub size: u64,
    /// L'application se ferme pour laisser l'installeur remplacer ses fichiers (Windows) ; sinon elle reste ouverte (Linux : gestionnaire de paquets).
    pub restarts: bool,
    #[serde(skip)]
    url: String,
    #[serde(skip)]
    sha256: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct UpdateInfo {
    /// Version installée (ex. « 0.6.2 » ou « 0.6.2-beta »).
    pub current: String,
    /// Dernière version éligible (sans « v »), ou la version installée si aucune release éligible n'existe.
    pub latest: String,
    /// La dernière version est strictement plus récente que celle installée.
    pub update_available: bool,
    pub prerelease: bool,
    /// Texte de la release (Markdown) : changelog généré par git-cliff.
    pub notes: String,
    /// Page de la release sur GitHub.
    pub url: String,
    pub published_at: String,
    /// Installeur de cette version pour ce système ; None : aucun (l'interface renvoie alors vers la page de la release).
    pub asset: Option<UpdateAsset>,
}

/// Système pour lequel la release publie un installeur.
fn current_platform() -> &'static str {
    if cfg!(windows) { "windows" } else if cfg!(target_os = "linux") { "linux" } else { "other" }
}

/// Nom de fichier sûr : il sert de nom dans le dossier temporaire, donc ni séparateur ni caractère inattendu.
fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 150 && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// Installeur de la release pour `platform` : Windows `*-setup.exe` (sinon `.msi`), Linux `.deb`. Exige l'adresse du dépôt, un nom sûr, une taille
/// raisonnable et la somme SHA-256 publiée par GitHub (`digest`) : sans elle l'intégrité ne serait pas vérifiable, donc pas d'installeur.
fn pick_asset(release: &serde_json::Value, platform: &str) -> Option<UpdateAsset> {
    let extensions: &[&str] = match platform {
        "windows" => &["-setup.exe", ".msi"],
        "linux" => &[".deb"],
        _ => return None,
    };
    let assets = release.get("assets")?.as_array()?;
    let text = |asset: &serde_json::Value, key: &str| asset.get(key).and_then(|value| value.as_str()).unwrap_or_default().to_string();
    for extension in extensions {
        for asset in assets {
            let name = text(asset, "name");
            let url = text(asset, "browser_download_url");
            let size = asset.get("size").and_then(|value| value.as_u64()).unwrap_or(0);
            let sha256 = text(asset, "digest").strip_prefix("sha256:").unwrap_or_default().to_ascii_lowercase();
            let valid_digest = sha256.len() == 64 && sha256.chars().all(|c| c.is_ascii_hexdigit());
            if name.ends_with(extension) && is_safe_file_name(&name) && url.starts_with(DOWNLOAD_URL_PREFIX) && size > 0 && size <= MAX_INSTALLER_BYTES && valid_digest {
                return Some(UpdateAsset { name, size, restarts: platform == "windows", url, sha256 });
            }
        }
    }
    None
}

/// Dernière release éligible dans la réponse JSON de GitHub (voir les règles en tête de fichier).
fn pick_latest(body: &[u8], installed: &Version, installed_text: &str, include_prereleases: bool) -> Result<UpdateInfo, String> {
    let releases: Vec<serde_json::Value> = serde_json::from_slice(body).map_err(|error| format!("Réponse de GitHub illisible : {error}"))?;
    let allow_prereleases = include_prereleases || installed.pre.is_some();
    let text = |release: &serde_json::Value, key: &str| release.get(key).and_then(|value| value.as_str()).unwrap_or_default().to_string();

    let best = releases
        .iter()
        .filter(|release| !release.get("draft").and_then(|value| value.as_bool()).unwrap_or(false))
        .filter(|release| allow_prereleases || !release.get("prerelease").and_then(|value| value.as_bool()).unwrap_or(false))
        .filter_map(|release| Some((parse_version(&text(release, "tag_name"))?, release)))
        .max_by_key(|(version, _)| version.numbers);

    let Some((version, release)) = best else {
        // Aucune release éligible : rien à proposer.
        return Ok(UpdateInfo { current: installed_text.to_string(), latest: installed_text.to_string(), update_available: false, prerelease: false, notes: String::new(), url: String::new(), published_at: String::new(), asset: None });
    };
    let (x, y, z) = version.numbers;
    let update_available = version.numbers > installed.numbers;
    Ok(UpdateInfo {
        current: installed_text.to_string(),
        latest: format!("{x}.{y}.{z}"),
        update_available,
        prerelease: release.get("prerelease").and_then(|value| value.as_bool()).unwrap_or(false),
        notes: text(release, "body"),
        url: text(release, "html_url"),
        published_at: text(release, "published_at"),
        asset: if update_available { pick_asset(release, current_platform()) } else { None },
    })
}

/// Interroge GitHub (bloquant : à appeler hors du fil principal).
fn fetch_info(installed_text: &str, include_prereleases: bool) -> Result<UpdateInfo, String> {
    if !crate::face_models::internet_allowed() { return Err("internet_disabled".to_string()); }
    let installed = parse_version(installed_text).ok_or_else(|| format!("Version installée illisible : {installed_text}"))?;
    let response = ureq::get(RELEASES_URL)
        .header("User-Agent", &format!("photoboggan/{installed_text} (update check)"))
        .header("Accept", "application/vnd.github+json")
        .config()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .build()
        .call()
        .map_err(|error| error.to_string())?;
    if response.status().as_u16() != 200 { return Err(format!("HTTP {}", response.status().as_u16())); }
    let body = response.into_body().with_config().limit(MAX_RESPONSE_BYTES).read_to_vec().map_err(|error| error.to_string())?;
    pick_latest(&body, &installed, installed_text, include_prereleases)
}

/// Vérifie la présence d'une version plus récente. Erreur « internet_disabled » en mode hors ligne.
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle, include_prereleases: bool) -> Result<UpdateInfo, String> {
    let installed_text = app.package_info().version.to_string();
    tokio::task::spawn_blocking(move || fetch_info(&installed_text, include_prereleases)).await.map_err(|error| error.to_string())?
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Téléchargement
// ---------------------------------------------------------------------------------------------------------------------------------------------

/// Installeur téléchargé et vérifié : chemin, taille et somme attendues (recalculée avant le lancement).
static DOWNLOADED: Mutex<Option<(PathBuf, u64, String)>> = Mutex::new(None);

fn update_dir() -> PathBuf {
    std::env::temp_dir().join("photoboggan-update")
}

/// Copie `reader` dans `<target>.part` en calculant la somme SHA-256, puis renomme le fichier si taille et somme sont celles attendues.
/// `on_bytes(n)` est appelé après chaque bloc écrit ; `cancel` interrompt la copie (le fichier partiel est supprimé, erreur « cancelled »).
fn copy_verified(reader: &mut dyn Read, target: &Path, size: u64, sha256: &str, cancel: &AtomicBool, on_bytes: &mut dyn FnMut(u64)) -> Result<(), String> {
    let partial = target.with_extension("part");
    let result = (|| {
        let mut output = fs::File::create(&partial).map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        let mut written = 0u64;
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            if cancel.load(Ordering::Relaxed) { return Err("cancelled".to_string()); }
            let count = reader.read(&mut buffer).map_err(|error| if cancel.load(Ordering::Relaxed) { "cancelled".to_string() } else { error.to_string() })?;
            if count == 0 { break; }
            written += count as u64;
            if written > size { return Err("update_corrupted".to_string()); } // plus gros que annoncé : inutile d'aller plus loin
            output.write_all(&buffer[..count]).map_err(|error| error.to_string())?;
            hasher.update(&buffer[..count]);
            on_bytes(count as u64);
        }
        output.sync_all().map_err(|error| error.to_string())?;
        if written != size || hex(&hasher.finalize()) != sha256 { return Err("update_corrupted".to_string()); }
        Ok(())
    })();
    match result {
        Ok(()) => fs::rename(&partial, target).map_err(|error| {
            let _ = fs::remove_file(&partial);
            error.to_string()
        }),
        Err(error) => {
            let _ = fs::remove_file(&partial);
            Err(error)
        }
    }
}

/// Somme SHA-256 d'un fichier.
fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }
    Ok(hex(&hasher.finalize()))
}

/// Télécharge l'installeur de la version `version` (tâche de la file : progression par « scan-progress », arrêt par cancel_scan).
/// La release est relue ici : si la dernière version n'est plus `version`, erreur « update_changed » (l'interface relance une vérification).
#[tauri::command]
pub async fn download_update(app: tauri::AppHandle, task_id: String, version: String, include_prereleases: bool) -> Result<(), String> {
    let installed_text = app.package_info().version.to_string();
    let cancel = crate::scan_cancel_flag(&task_id);
    let worker_task_id = task_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let info = fetch_info(&installed_text, include_prereleases)?;
        if !info.update_available || info.latest != version { return Err("update_changed".to_string()); }
        let asset = info.asset.ok_or_else(|| "update_no_installer".to_string())?;
        let dir = update_dir();
        // Installeurs d'un téléchargement précédent : supprimés (un seul à la fois).
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).map_err(|error| format!("Dossier de téléchargement impossible à créer : {error}"))?;
        *DOWNLOADED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;

        let response = ureq::get(&asset.url)
            .header("User-Agent", &format!("photoboggan/{installed_text} (update download)"))
            .config()
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_recv_response(Some(RESPONSE_TIMEOUT))
            .timeout_recv_body(Some(BODY_TIMEOUT))
            .build()
            .call()
            .map_err(|error| format!("{} : {error}", asset.name))?;
        let mut reader = IdleReader::new(Box::new(response.into_body().into_reader()), IDLE_TIMEOUT, &cancel);
        let target = dir.join(&asset.name);
        let mut done = 0u64;
        let mut last_percent = u32::MAX;
        copy_verified(&mut reader, &target, asset.size, &asset.sha256, &cancel, &mut |bytes| {
            done += bytes;
            let percent = (done * 100 / asset.size.max(1)) as u32;
            if percent != last_percent {
                last_percent = percent;
                let _ = app.emit("scan-progress", crate::ScanProgress { task_id: worker_task_id.clone(), percent });
            }
        })?;
        *DOWNLOADED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((target, asset.size, asset.sha256));
        Ok(())
    })
    .await;
    crate::release_scan_cancel_flag(&task_id);
    match outcome.map_err(|error| error.to_string())? {
        Err(error) if error == "cancelled" => Ok(()), // arrêt demandé : rien de gardé
        other => other,
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------------------------------------------------------------------------

/// Lance l'installeur téléchargé, après avoir revérifié sa taille et sa somme SHA-256. Renvoie true si l'application se ferme (Windows : l'installeur
/// remplace ses fichiers) ; false si elle reste ouverte (Linux : le .deb est ouvert dans le gestionnaire de paquets). L'interface a déjà obtenu
/// l'accord de l'utilisateur pour quitter (modifications en attente).
#[tauri::command(async)]
pub fn install_update(app: tauri::AppHandle) -> Result<bool, String> {
    let (path, size, sha256) = DOWNLOADED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone().ok_or_else(|| "update_not_downloaded".to_string())?;
    if fs::metadata(&path).map(|metadata| metadata.len()).ok() != Some(size) || file_sha256(&path)? != sha256 {
        *DOWNLOADED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        return Err("update_corrupted".to_string());
    }
    #[cfg(windows)]
    {
        let mut command = if path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("msi")) {
            let mut command = std::process::Command::new("msiexec");
            command.arg("/i").arg(&path);
            command
        } else {
            std::process::Command::new(&path)
        };
        command.spawn().map_err(|error| format!("Installeur impossible à lancer : {error}"))?;
        app.exit(0);
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = &app;
        std::process::Command::new("xdg-open").arg(&path).spawn().map_err(|error| format!("Installeur impossible à ouvrir : {error}"))?;
        Ok(false)
    }
}

#[cfg(test)]
#[path = "tests/update_check.rs"]
mod tests;
