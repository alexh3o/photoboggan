//! Écriture des métadonnées par ExifTool (https://exiftool.org), second chemin d'écriture à côté de l'écriture interne d'exif.rs.
//!
//! Choix de l'utilisateur (Paramètres, onglet Métadonnées) : mode « ExifTool » (par défaut) ou « interne ». En mode ExifTool, si l'outil est
//! introuvable, l'écriture est refusée avec un message (jamais de repli silencieux sur l'autre chemin).
//!
//! Exécutable, dans cet ordre : chemin choisi dans les Paramètres, version embarquée (dossier `exiftool` des ressources de l'application,
//! voir scripts/fetch-exiftool.mjs), puis `exiftool` du PATH. Windows : distribution officielle avec Perl embarqué (`exiftool.exe`) ;
//! Linux / macOS : distribution Perl pure, lancée par le `perl` du système.
//!
//! Processus persistants (`-stay_open True -@ -`) : démarrés à la demande (au plus MAX_PROCESSES, autant que d'écritures parallèles
//! dans keywords.rs), arrêtés après IDLE_TIMEOUT sans activité et à la fermeture de l'application. ExifTool écrit dans un fichier temporaire
//! puis remplace l'original (`-overwrite_original`) : jamais d'écriture en place. La relecture de vérification reste faite par l'appelant.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Condvar, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

/// Nombre maximal de processus ExifTool simultanés.
const MAX_PROCESSES: usize = 3;
/// Un processus inutilisé depuis ce délai est arrêté.
const IDLE_TIMEOUT: Duration = Duration::from_secs(45);
/// Délai maximal d'une commande (gros fichier sur disque lent) : au-delà, le processus est tué et l'écriture comptée en échec.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// Délai maximal de `exiftool -ver` lors de la détection.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------------------
// Réglages (envoyés par l'interface au démarrage et à chaque changement)
// ---------------------------------------------------------------------------

struct Settings {
    use_exiftool: bool,
    custom_path: Option<PathBuf>,
}

static SETTINGS: RwLock<Settings> = RwLock::new(Settings { use_exiftool: true, custom_path: None });
/// Dossier de la version embarquée (`<ressources>/exiftool`), fixé au démarrage.
static BUNDLED_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Exécutable détecté (ou raison de l'échec), gardé jusqu'au prochain changement de réglage ou à la prochaine demande d'état.
static LAUNCHER: Mutex<Option<Result<Launcher, String>>> = Mutex::new(None);

/// À appeler au démarrage avec le dossier des ressources de l'application.
pub fn init(resource_dir: Option<PathBuf>) {
    if let Some(dir) = resource_dir {
        let _ = BUNDLED_DIR.set(dir.join("exiftool"));
    }
}

/// Vrai quand les écritures de métadonnées doivent passer par ExifTool.
pub fn is_enabled() -> bool {
    SETTINGS.read().unwrap_or_else(|poisoned| poisoned.into_inner()).use_exiftool
}

/// Règle le chemin d'écriture (`mode` : « exiftool » ou « internal ») et le chemin d'ExifTool choisi par l'utilisateur (vide : aucun).
/// Un changement arrête les processus en cours et relance la détection à la prochaine écriture.
#[tauri::command]
pub fn set_metadata_writer(mode: String, custom_path: Option<String>) -> Result<(), String> {
    let use_exiftool = match mode.as_str() {
        "exiftool" => true,
        "internal" => false,
        _ => return Err("invalid_mode".to_string()),
    };
    let custom_path = custom_path.map(|path| path.trim().to_string()).filter(|path| !path.is_empty()).map(PathBuf::from);
    {
        let mut settings = SETTINGS.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        if settings.use_exiftool == use_exiftool && settings.custom_path == custom_path { return Ok(()); }
        settings.use_exiftool = use_exiftool;
        settings.custom_path = custom_path;
    }
    *lock(&LAUNCHER) = None;
    shutdown();
    Ok(())
}

/// État affiché dans les Paramètres.
#[derive(serde::Serialize)]
pub struct ExifToolStatus {
    /// ExifTool trouvé et fonctionnel.
    pub available: bool,
    /// Origine de l'exécutable : « custom », « bundled » ou « path ».
    pub source: Option<&'static str>,
    pub path: Option<String>,
    pub version: Option<String>,
    /// Raison de l'échec de la détection.
    pub error: Option<String>,
}

/// Détecte ExifTool à nouveau (l'utilisateur a pu l'installer entre-temps) et renvoie son état.
#[tauri::command(async)]
pub fn get_exiftool_status() -> ExifToolStatus {
    *lock(&LAUNCHER) = None;
    match launcher() {
        Ok(found) => ExifToolStatus {
            available: true,
            source: Some(found.source),
            path: Some(found.display_path()),
            version: Some(found.version),
            error: None,
        },
        Err(error) => ExifToolStatus { available: false, source: None, path: None, version: None, error: Some(error) },
    }
}

/// Démarre un processus à l'avance (premier mot-clé modifié), pour que « Appliquer » ne paie pas le démarrage d'ExifTool.
/// Sans effet en mode interne ou si un processus tourne déjà.
#[tauri::command]
pub fn exiftool_prewarm() {
    static PREWARMING: AtomicBool = AtomicBool::new(false);
    if !is_enabled() || lock(&POOL).running > 0 || PREWARMING.swap(true, Ordering::SeqCst) { return; }
    std::thread::spawn(|| {
        if let Ok(found) = launcher() {
            if let Ok(process) = acquire(&found) { release(process, true); }
        }
        PREWARMING.store(false, Ordering::SeqCst);
    });
}

// ---------------------------------------------------------------------------
// Détection de l'exécutable
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Launcher {
    program: PathBuf,
    /// Arguments placés avant ceux d'ExifTool (le script, quand il est lancé par `perl`).
    prefix: Vec<OsString>,
    source: &'static str,
    version: String,
}

impl Launcher {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.prefix);
        hide_console_window(&mut command);
        command
    }

    fn display_path(&self) -> String {
        match self.prefix.first() {
            Some(script) => format!("{} {}", self.program.display(), PathBuf::from(script).display()),
            None => self.program.display().to_string(),
        }
    }
}

/// Windows : pas de fenêtre de console pour ExifTool (application sans console). Sans effet ailleurs.
#[cfg(windows)]
fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut Command) {}

/// Exécutable à utiliser (détecté une fois, puis gardé).
fn launcher() -> Result<Launcher, String> {
    let mut cached = lock(&LAUNCHER);
    if let Some(result) = cached.as_ref() { return result.clone(); }
    let result = detect();
    *cached = Some(result.clone());
    result
}

fn detect() -> Result<Launcher, String> {
    let custom_path = SETTINGS.read().unwrap_or_else(|poisoned| poisoned.into_inner()).custom_path.clone();
    // Chemin choisi par l'utilisateur : il est le seul essayé (choix explicite, pas de bascule silencieuse sur une autre version).
    if let Some(path) = custom_path {
        return probe(path.clone(), Vec::new(), "custom").map_err(|error| format!("ExifTool introuvable au chemin choisi ({}) : {error}", path.display()));
    }
    let mut reasons: Vec<String> = Vec::new();
    if let Some(dir) = BUNDLED_DIR.get() {
        let candidate = if cfg!(windows) {
            let exe = dir.join("exiftool.exe");
            exe.is_file().then(|| (exe, Vec::new()))
        } else {
            let script = dir.join("exiftool");
            script.is_file().then(|| (PathBuf::from("perl"), vec![script.into_os_string()]))
        };
        match candidate {
            Some((program, prefix)) => match probe(program, prefix, "bundled") {
                Ok(found) => return Ok(found),
                Err(error) => reasons.push(format!("version embarquée : {error}")),
            },
            None => reasons.push("version embarquée absente".to_string()),
        }
    }
    match probe(PathBuf::from("exiftool"), Vec::new(), "path") {
        Ok(found) => Ok(found),
        Err(error) => {
            reasons.push(format!("PATH : {error}"));
            Err(format!("ExifTool introuvable ({})", reasons.join(" ; ")))
        }
    }
}

/// Lance `exiftool -ver` : renvoie l'exécutable avec sa version, ou la raison de l'échec (programme ou `perl` absent, réponse inattendue…).
fn probe(program: PathBuf, prefix: Vec<OsString>, source: &'static str) -> Result<Launcher, String> {
    let mut found = Launcher { program, prefix, source, version: String::new() };
    let mut command = found.command();
    command.arg("-ver").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            if found.prefix.is_empty() { "programme absent".to_string() } else { "perl introuvable".to_string() }
        } else {
            error.to_string()
        }
    })?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || { let _ = sender.send(child.wait_with_output()); });
    let output = match receiver.recv_timeout(PROBE_TIMEOUT) {
        Ok(output) => output.map_err(|error| error.to_string())?,
        Err(_) => return Err("pas de réponse".to_string()),
    };
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || version.is_empty() || !version.starts_with(|c: char| c.is_ascii_digit()) {
        return Err("réponse inattendue".to_string());
    }
    found.version = version;
    Ok(found)
}

// ---------------------------------------------------------------------------
// Processus persistants
// ---------------------------------------------------------------------------

struct Process {
    child: Child,
    stdin: ChildStdin,
    /// Lignes de la sortie standard et de la sortie d'erreur, lues par deux fils dédiés (pas de blocage si l'une se remplit).
    stdout: Receiver<String>,
    stderr: Receiver<String>,
    next_id: u32,
    /// Génération du pool à la création : un processus d'une génération dépassée (réglage changé) est arrêté quand il est rendu.
    generation: u64,
}

fn spawn_line_reader(stream: impl std::io::Read + Send + 'static) -> Receiver<String> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if sender.send(String::from_utf8_lossy(&line).trim_end().to_string()).is_err() { break; }
                }
            }
        }
    });
    receiver
}

impl Process {
    fn start(found: &Launcher, generation: u64) -> Result<Process, String> {
        let mut command = found.command();
        // Les noms de fichiers sont transmis en UTF-8 (indispensable sous Windows pour les noms accentués).
        command
            .args(["-stay_open", "True", "-@", "-", "-common_args", "-charset", "filename=UTF8"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| format!("Démarrage d'ExifTool impossible : {error}"))?;
        let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
            let _ = child.kill();
            return Err("Démarrage d'ExifTool impossible : flux indisponibles".to_string());
        };
        Ok(Process { child, stdin, stdout: spawn_line_reader(stdout), stderr: spawn_line_reader(stderr), next_id: 1, generation })
    }

    /// Exécute une commande (un argument par ligne) et renvoie (sortie standard, sortie d'erreur). Erreur si le processus ne répond pas :
    /// il ne doit alors plus servir.
    fn execute(&mut self, args: &[String]) -> Result<(String, String), String> {
        let id = self.next_id;
        self.next_id += 1;
        let ready = format!("{{ready{id}}}");
        let mut input = String::new();
        for arg in args {
            input.push_str(arg);
            input.push('\n');
        }
        // -echo4 écrit le repère sur la sortie d'erreur une fois la commande traitée : les deux flux se lisent ainsi jusqu'au même repère.
        input.push_str(&format!("-echo4\n{ready}\n-execute{id}\n"));
        self.stdin.write_all(input.as_bytes()).and_then(|_| self.stdin.flush()).map_err(|error| format!("ExifTool ne répond plus : {error}"))?;
        let deadline = Instant::now() + COMMAND_TIMEOUT;
        let stdout = read_until_marker(&self.stdout, &ready, deadline)?;
        let stderr = read_until_marker(&self.stderr, &ready, deadline)?;
        Ok((stdout, stderr))
    }

    /// Demande à ExifTool de se terminer ; le tue s'il ne l'a pas fait après quelques secondes.
    fn stop(mut self) {
        let _ = self.stdin.write_all(b"-stay_open\nFalse\n").and_then(|_| self.stdin.flush());
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() { return; }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read_until_marker(lines: &Receiver<String>, marker: &str, deadline: Instant) -> Result<String, String> {
    let mut text = String::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match lines.recv_timeout(remaining) {
            Ok(line) if line == marker => return Ok(text),
            Ok(line) => {
                text.push_str(&line);
                text.push('\n');
            }
            Err(RecvTimeoutError::Timeout) => return Err("ExifTool ne répond pas (délai dépassé)".to_string()),
            Err(RecvTimeoutError::Disconnected) => return Err("ExifTool s'est arrêté de façon inattendue".to_string()),
        }
    }
}

struct Pool {
    idle: Vec<Process>,
    /// Processus existants, au travail ou au repos.
    running: usize,
    last_used: Option<Instant>,
    generation: u64,
}

static POOL: Mutex<Pool> = Mutex::new(Pool { idle: Vec::new(), running: 0, last_used: None, generation: 0 });
static POOL_CHANGED: Condvar = Condvar::new();
static IDLE_WATCHER: OnceLock<()> = OnceLock::new();

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Un processus libre, ou un nouveau si la limite n'est pas atteinte ; sinon attend qu'un processus soit rendu.
fn acquire(found: &Launcher) -> Result<Process, String> {
    let mut pool = lock(&POOL);
    loop {
        if let Some(process) = pool.idle.pop() { return Ok(process); }
        if pool.running < MAX_PROCESSES {
            pool.running += 1;
            let generation = pool.generation;
            drop(pool);
            IDLE_WATCHER.get_or_init(|| { std::thread::spawn(watch_idle); });
            return Process::start(found, generation).inspect_err(|_| {
                lock(&POOL).running -= 1;
                POOL_CHANGED.notify_one();
            });
        }
        pool = POOL_CHANGED.wait(pool).unwrap_or_else(|poisoned| poisoned.into_inner());
    }
}

/// Rend un processus au pool ; il est arrêté s'il a échoué ou si les réglages ont changé depuis son démarrage.
fn release(process: Process, healthy: bool) {
    let mut pool = lock(&POOL);
    pool.last_used = Some(Instant::now());
    if healthy && process.generation == pool.generation {
        pool.idle.push(process);
        drop(pool);
    } else {
        pool.running -= 1;
        drop(pool);
        process.stop();
    }
    POOL_CHANGED.notify_one();
}

/// Arrête les processus au repos depuis IDLE_TIMEOUT (fil unique, vivant tant que l'application tourne).
fn watch_idle() {
    loop {
        std::thread::sleep(Duration::from_secs(5));
        let stale: Vec<Process> = {
            let mut pool = lock(&POOL);
            if pool.idle.is_empty() || pool.last_used.is_some_and(|last| last.elapsed() < IDLE_TIMEOUT) { continue; }
            let stale: Vec<Process> = std::mem::take(&mut pool.idle);
            pool.running -= stale.len();
            stale
        };
        for process in stale { process.stop(); }
    }
}

/// Arrête les processus au repos ; ceux au travail le seront quand ils seront rendus. Appelée à la fermeture et au changement de réglage.
pub fn shutdown() {
    let idle: Vec<Process> = {
        let mut pool = lock(&POOL);
        pool.generation += 1;
        let idle: Vec<Process> = std::mem::take(&mut pool.idle);
        pool.running -= idle.len();
        idle
    };
    for process in idle { process.stop(); }
}

/// Exécute une commande d'écriture : succès seulement si ExifTool annonce le fichier écrit (ou déjà à jour) sans erreur.
fn run(args: Vec<String>) -> std::io::Result<()> {
    if args.iter().any(|arg| arg.contains(['\n', '\r'])) {
        return Err(std::io::Error::other("Valeur de métadonnée invalide (retour à la ligne)"));
    }
    let found = launcher().map_err(|error| std::io::Error::other(format!("{error} : écriture refusée (voir Paramètres, onglet Métadonnées)")))?;
    let mut process = acquire(&found).map_err(std::io::Error::other)?;
    let result = process.execute(&args);
    release(process, result.is_ok());
    let (stdout, stderr) = result.map_err(std::io::Error::other)?;
    let errors: Vec<&str> = stderr.lines().filter(|line| line.starts_with("Error")).map(|line| line.trim_start_matches("Error:").trim()).collect();
    if !errors.is_empty() { return Err(std::io::Error::other(format!("ExifTool : {}", errors.join(" ; ")))); }
    let done = stdout.lines().any(|line| {
        let line = line.trim();
        line.starts_with("1 ") && (line.ends_with("files updated") || line.ends_with("files unchanged") || line.ends_with("files created"))
    });
    if done { return Ok(()); }
    let detail = format!("{} {}", stdout.trim(), stderr.trim());
    Err(std::io::Error::other(format!("ExifTool n'a pas écrit le fichier : {}", detail.trim())))
}

// ---------------------------------------------------------------------------
// Écritures (mêmes cibles que l'écriture interne d'exif.rs, plus XPKeywords dans les JPEG)
// ---------------------------------------------------------------------------

enum Target {
    /// JPEG : XMP, IPTC et EXIF du fichier.
    Jpeg,
    /// HEIC / HEIF : XMP du fichier.
    Heif,
    /// Autres formats (RAW, PNG, vidéos…) : sidecar XMP.
    Sidecar,
}

fn target_of(path: &Path) -> Target {
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => Target::Jpeg,
        "heic" | "heif" | "hif" => Target::Heif,
        _ => Target::Sidecar,
    }
}

/// Balise de liste : ses valeurs remplacent les anciennes ; liste vide = balise supprimée.
fn push_list(args: &mut Vec<String>, tag: &str, values: impl IntoIterator<Item = String>) {
    let before = args.len();
    for value in values { args.push(format!("-{tag}={value}")); }
    if args.len() == before { args.push(format!("-{tag}=")); }
}

/// Modifie un fichier existant : ExifTool écrit `<fichier>_exiftool_tmp` puis remplace l'original. Si le remplacement échoue (fichier en lecture
/// seule…), ExifTool laisse ce fichier temporaire : il est supprimé pour ne rien laisser dans le dossier de l'utilisateur.
fn overwrite(file: &Path, tag_args: Vec<String>) -> std::io::Result<()> {
    let mut args = vec!["-overwrite_original".to_string()];
    args.extend(tag_args);
    args.push(file.to_string_lossy().into_owned());
    run(args).inspect_err(|_| {
        let temp = PathBuf::from(format!("{}_exiftool_tmp", file.display()));
        if !temp.exists() { return; }
        // Windows : ExifTool reprend l'attribut lecture seule de l'original, et un fichier en lecture seule ne se supprime pas tel quel.
        #[cfg(windows)]
        if let Ok(metadata) = std::fs::metadata(&temp) {
            let mut permissions = metadata.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            let _ = std::fs::set_permissions(&temp, permissions);
        }
        let _ = std::fs::remove_file(&temp);
    })
}

/// Écrit `tag_args` dans le fichier, ou dans son sidecar XMP selon le format. `has_values` : faux quand la commande ne fait que supprimer,
/// auquel cas un sidecar absent n'est pas créé.
fn write_to(image_path: &Path, tag_args: Vec<String>, has_values: bool) -> std::io::Result<()> {
    if !matches!(target_of(image_path), Target::Sidecar) { return overwrite(image_path, tag_args); }
    let (sidecar, exists) = crate::exif::sidecar_target(image_path);
    if exists { return overwrite(&sidecar, tag_args); }
    if !has_values { return Ok(()); }
    // Nouveau sidecar : créé sous un nom temporaire (extension .xmp conservée, ExifTool en déduit le format), puis renommé.
    let temp = PathBuf::from(format!("{}.photoboggan-tmp.xmp", image_path.display()));
    let _ = std::fs::remove_file(&temp);
    let mut args = vec!["-o".to_string(), temp.to_string_lossy().into_owned()];
    args.extend(tag_args);
    if let Err(error) = run(args) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    std::fs::rename(&temp, &sidecar).inspect_err(|_| { let _ = std::fs::remove_file(&temp); })
}

/// Mots-clés actifs `paths` (un chemin par mot-clé, ex. ["Lieux", "France", "Paris"]) : remplacent dc:subject, digiKam TagsList,
/// Lightroom hierarchicalSubject, Media Pro CatalogSets, Microsoft LastKeywordXMP, ACDSee categories ; dans les JPEG, aussi IPTC Keywords
/// et EXIF XPKeywords.
pub fn write_keywords(image_path: &Path, paths: &[Vec<String>]) -> std::io::Result<()> {
    let mut leaves: Vec<String> = Vec::new();
    for segments in paths {
        if let Some(leaf) = segments.last() {
            if !leaves.iter().any(|word| word.to_lowercase() == leaf.to_lowercase()) { leaves.push(leaf.clone()); }
        }
    }
    let joined = |separator: &str| paths.iter().map(|segments| segments.join(separator)).collect::<Vec<_>>();
    let mut args = Vec::new();
    push_list(&mut args, "XMP-dc:Subject", leaves.clone());
    push_list(&mut args, "XMP-digiKam:TagsList", joined("/"));
    push_list(&mut args, "XMP-lr:HierarchicalSubject", joined("|"));
    push_list(&mut args, "XMP-mediapro:CatalogSets", joined("|"));
    push_list(&mut args, "XMP-microsoft:LastKeywordXMP", joined("/"));
    // Catégories ACDSee : une seule valeur texte (l'arbre XML), qu'ExifTool échappe lui-même dans le paquet.
    let categories = if paths.is_empty() { String::new() } else { crate::exif::acdsee_categories_value(paths) };
    args.push(format!("-XMP-acdsee:Categories={categories}"));
    if matches!(target_of(image_path), Target::Jpeg) {
        // IPTC : 64 octets au plus par mot-clé (coupés comme l'écriture interne) ; UTF-8 déclaré quand un mot-clé n'est pas en ASCII.
        push_list(&mut args, "IPTC:Keywords", leaves.iter().map(|word| crate::exif::truncate_utf8(word, 64).to_string()));
        if leaves.iter().any(|word| !word.is_ascii()) { args.push("-IPTC:CodedCharacterSet=UTF8".to_string()); }
        // XPKeywords : mots séparés par « ; », donc les noms qui en contiennent sont omis de ce seul champ.
        let xp: Vec<&str> = leaves.iter().map(String::as_str).filter(|word| !word.contains(';')).collect();
        args.push(format!("-EXIF:XPKeywords={}", xp.join(";")));
    }
    write_to(image_path, args, !paths.is_empty())
}

/// Note (`xmp:Rating`, `acdsee:rating`, `MicrosoftPhoto:Rating`) et/ou couleur (`xmp:Label`, `photoshop:Urgency`, `digiKam:ColorLabel`) :
/// seules les valeurs fournies sont modifiées ; `Some(None)` retire la couleur. Mêmes valeurs que l'écriture interne.
pub fn write_rating_label(image_path: &Path, rating: Option<i32>, label: Option<Option<&str>>) -> std::io::Result<()> {
    let mut args = Vec::new();
    let mut has_values = false;
    if let Some(rating) = rating {
        let rating = rating.clamp(0, 5);
        let microsoft_rating = match rating { 0 => 0, 1 => 1, 2 => 25, 3 => 50, 4 => 75, _ => 99 };
        args.push(format!("-XMP-xmp:Rating={rating}"));
        args.push(format!("-XMP-acdsee:Rating={rating}"));
        args.push(format!("-XMP-microsoft:RatingPercent={microsoft_rating}"));
        has_values |= rating > 0;
    }
    if let Some(label) = label {
        let number = label.and_then(crate::exif::color_to_urgency_and_digikam).map(|value| value.to_string()).unwrap_or_default();
        args.push(format!("-XMP-xmp:Label={}", label.unwrap_or_default()));
        args.push(format!("-XMP-photoshop:Urgency={number}"));
        args.push(format!("-XMP-digiKam:ColorLabel={number}"));
        has_values |= label.is_some();
    }
    if args.is_empty() { return Ok(()); }
    write_to(image_path, args, has_values)
}
