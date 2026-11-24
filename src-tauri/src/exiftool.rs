//! Metadata writing via ExifTool (https://exiftool.org).
//!
//! Executable, in order: user-chosen path in Settings, bundled version (`exiftool` folder in app resources,
//! see scripts/fetch-exiftool.mjs), then `exiftool` from PATH. Windows: official distribution with embedded Perl
//! (`exiftool.exe`); Linux / macOS: pure Perl distribution, launched by the system `perl`.
//!
//! Persistent processes (`-stay_open True -@ -`): started on demand (up to MAX_PROCESSES, matching parallel writes
//! in keywords.rs), stopped after IDLE_TIMEOUT of inactivity and on app shutdown. ExifTool writes to a temporary file
//! then replaces the original (`-overwrite_original`): never writes in place. Verification read-back is done by the caller.

use std::collections::hash_map::DefaultHasher;
use std::ffi::OsString;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    custom_path: Option<PathBuf>,
}

static SETTINGS: RwLock<Settings> = RwLock::new(Settings { custom_path: None });
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

/// Sets the user-chosen ExifTool executable path (empty/None = auto-detect).
/// Changing the path stops running processes and triggers detection on the next write.
#[tauri::command]
pub fn set_metadata_writer(custom_path: Option<String>) -> Result<(), String> {
    let custom_path = custom_path.map(|path| path.trim().to_string()).filter(|path| !path.is_empty()).map(PathBuf::from);
    {
        let mut settings = SETTINGS.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        if settings.custom_path == custom_path { return Ok(()); }
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
    if lock(&POOL).running > 0 || PREWARMING.swap(true, Ordering::SeqCst) { return; }
    std::thread::spawn(|| {
        match launcher().and_then(|found| acquire(&found)) {
            Ok(process) => release(process, true),
            Err(error) => eprintln!("ExifTool prewarm failed: {error}"),
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

/// Windows : lie le processus ExifTool à la vie de l'application (objet Job « KILL_ON_JOB_CLOSE »). Si l'application s'arrête sans passer par
/// `shutdown` (processus tué, Ctrl+C du mode dev, plantage), Windows ferme le Job et tue ExifTool : sinon `exiftool.exe` (mode -stay_open)
/// survit, verrouille le dossier `exiftool` de `target` et fait échouer la compilation suivante. Au mieux : un échec est ignoré. Sans effet ailleurs.
#[cfg(windows)]
fn bind_to_app_lifetime(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // Un seul Job pour toute l'application, jamais fermé explicitement : sa fermeture est celle du processus. Poignée gardée en usize (Sync).
    static JOB: OnceLock<Option<usize>> = OnceLock::new();
    let job = JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(None, None).ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .ok()?;
        Some(job.0 as usize)
    });
    if let Some(job) = job {
        let assigned = unsafe { AssignProcessToJobObject(HANDLE(*job as *mut std::ffi::c_void), HANDLE(child.as_raw_handle())) };
        if let Err(error) = assigned { eprintln!("ExifTool not bound to the application lifetime: {error}"); }
    } else {
        eprintln!("ExifTool not bound to the application lifetime: Job object unavailable");
    }
}

#[cfg(not(windows))]
fn bind_to_app_lifetime(_child: &Child) {}

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
            #[cfg(target_os = "macos")]
            for candidate in ["/opt/homebrew/bin/exiftool", "/usr/local/bin/exiftool"] {
                let path = PathBuf::from(candidate);
                if path.is_file() {
                    match probe(path, Vec::new(), "path") {
                        Ok(found) => return Ok(found),
                        Err(err) => reasons.push(format!("{candidate} : {err}")),
                    }
                }
            }
            Err(format!("ExifTool introuvable ({})", reasons.join(" ; ")))
        }
    }
}

/// Lance `exiftool -ver` : renvoie l'exécutable avec sa version, ou la raison de l'échec (programme ou `perl` absent, réponse inattendue…).
fn probe(program: PathBuf, prefix: Vec<OsString>, source: &'static str) -> Result<Launcher, String> {
    let mut found = Launcher { program, prefix, source, version: String::new() };
    let mut command = found.command();
    command.arg("-ver").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            if found.prefix.is_empty() { "programme absent".to_string() } else { "perl introuvable".to_string() }
        } else {
            error.to_string()
        }
    })?;
    // La sortie est lue par un fil dédié ; le processus reste ici pour pouvoir être tué si le délai est dépassé.
    let stdout = child.stdout.take().ok_or_else(|| "flux indisponible".to_string())?;
    let (text_sender, text_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stdout).take(1024).read_to_string(&mut text);
        let _ = text_sender.send(text);
    });
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("pas de réponse".to_string());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
    };
    // Un processus fils qui garderait le tube ouvert ne doit pas bloquer la détection : la lecture est attendue au plus quelques secondes.
    let version = text_receiver.recv_timeout(Duration::from_secs(2)).unwrap_or_default().trim().to_string();
    if !status.success() || version.is_empty() || !version.starts_with(|c: char| c.is_ascii_digit()) {
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
        // Filenames are passed in UTF-8 (required on Windows for accented names). -ec: written values are
        // C-escaped (see assign), allowing line breaks inside a line-by-line argument stream.
        command
            .args(["-stay_open", "True", "-@", "-", "-common_args", "-charset", "filename=UTF8", "-ec"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| format!("Démarrage d'ExifTool impossible : {error}"))?;
        bind_to_app_lifetime(&child);
        let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
            let _ = child.kill();
            return Err("Démarrage d'ExifTool impossible : flux indisponibles".to_string());
        };
        Ok(Process { child, stdin, stdout: spawn_line_reader(stdout), stderr: spawn_line_reader(stderr), next_id: 1, generation })
    }

    /// Executes one command (one argument per line) and returns (stdout, stderr). On failure, the process must not be reused.
    fn execute(&mut self, args: &[String]) -> Result<(String, String), String> {
        let id = self.next_id;
        self.next_id += 1;
        let ready = format!("{{ready{id}}}");
        let mut input = String::new();
        for arg in args {
            input.push_str(arg);
            input.push('\n');
        }
        // -echo4 writes the marker to stderr once the command is processed so both streams can be read up to the same marker.
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
        if let Some(mut process) = pool.idle.pop() {
            // Un processus mort au repos (tué de l'extérieur, plantage) est écarté : il ferait échouer l'écriture à venir.
            if matches!(process.child.try_wait(), Ok(None)) { return Ok(process); }
            pool.running -= 1;
            continue;
        }
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

/// Stops idle processes; active processes are stopped when returned. Called on app exit and setting changes.
/// Does not set CLOSING because `set_metadata_writer` also calls `shutdown()`.
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

static ACTIVE_WRITES: Mutex<usize> = Mutex::new(0);
static WRITES_CHANGED: Condvar = Condvar::new();
static CLOSING: AtomicBool = AtomicBool::new(false);

/// RAII guard tracking an active `write_to` call (ExifTool execution, recovery, flush, rename).
struct ActiveWriteGuard;

impl ActiveWriteGuard {
    fn enter() -> std::io::Result<Self> {
        let mut active = lock(&ACTIVE_WRITES);
        if CLOSING.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Fermeture de l'application en cours : écriture annulée",
            ));
        }
        *active += 1;
        Ok(Self)
    }
}

impl Drop for ActiveWriteGuard {
    fn drop(&mut self) {
        let mut active = lock(&ACTIVE_WRITES);
        *active = active.saturating_sub(1);
        WRITES_CHANGED.notify_all();
    }
}

/// Returns true if any `write_to` call is currently in progress.
pub fn has_active_writes() -> bool {
    *lock(&ACTIVE_WRITES) > 0
}

/// Waits up to `timeout` for active writes to reach zero. Returns true if all active writes finished.
#[cfg(test)]
fn wait_for_active_writes(timeout: Duration) -> bool {
    let active = lock(&ACTIVE_WRITES);
    let (guard, _) = WRITES_CHANGED
        .wait_timeout_while(active, timeout, |count| *count > 0)
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard == 0
}

/// Rejects any new `write_to` calls, waits up to `timeout` for in-flight writes to finish, and stops idle processes.
/// Returns true if all active writes finished before `timeout`.
pub fn begin_shutdown_and_wait(timeout: Duration) -> bool {
    let finished = {
        let active = lock(&ACTIVE_WRITES);
        CLOSING.store(true, Ordering::SeqCst);
        let (guard, _) = WRITES_CHANGED
            .wait_timeout_while(active, timeout, |count| *count > 0)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard == 0
    };
    shutdown();
    finished
}

/// Executes an ExifTool command on the persistent pool, rejecting raw newlines, checking for `Error` lines on stderr,
/// and logging any `Warning` lines. Returns `(stdout, stderr)`.
fn run_raw(args: &[String]) -> std::io::Result<(String, String)> {
    if args.iter().any(|arg| arg.contains(['\n', '\r'])) {
        return Err(std::io::Error::other("Valeur de métadonnée invalide (retour à la ligne)"));
    }
    let found = launcher().map_err(|error| std::io::Error::other(format!("{error} : écriture refusée (voir Paramètres, onglet Métadonnées)")))?;
    let mut process = acquire(&found).map_err(std::io::Error::other)?;
    let result = process.execute(args);
    release(process, result.is_ok());
    let (stdout, stderr) = result.map_err(std::io::Error::other)?;
    let errors: Vec<&str> = stderr.lines().filter(|line| line.starts_with("Error")).map(|line| line.trim_start_matches("Error:").trim()).collect();
    if !errors.is_empty() { return Err(std::io::Error::other(format!("ExifTool : {}", errors.join(" ; ")))); }
    // Avertissements (champ ignoré, format inattendu…) : l'écriture reste un succès, mais la trace aide à comprendre un champ manquant.
    for warning in stderr.lines().filter(|line| line.starts_with("Warning")) {
        eprintln!("ExifTool warning: {} ({})", warning.trim(), args.last().map(String::as_str).unwrap_or_default());
    }
    Ok((stdout, stderr))
}

/// Exécute une commande d'écriture : succès seulement si ExifTool annonce le fichier écrit (ou déjà à jour) sans erreur.
fn run(args: Vec<String>) -> std::io::Result<()> {
    let (stdout, stderr) = run_raw(&args)?;
    let done = stdout.lines().any(|line| {
        let line = line.trim();
        line.starts_with("1 ") && (line.ends_with("files updated") || line.ends_with("files unchanged") || line.ends_with("files created"))
    });
    if done { return Ok(()); }
    let detail = format!("{} {}", stdout.trim(), stderr.trim());
    Err(std::io::Error::other(format!("ExifTool n'a pas écrit le fichier : {}", detail.trim())))
}

// ---------------------------------------------------------------------------
// Écritures (mêmes cibles que l'écriture interne d'exif.rs, plus l'EXIF des JPEG)
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

/// Affectation `-TAG=valeur`, valeur échappée pour l'option -ec d'ExifTool (barre oblique inverse doublée, retour à la ligne en `\n`, retour chariot en `\r`).
/// Valeur vide : la balise est supprimée.
fn assign(tag: &str, value: &str) -> String {
    format!("-{tag}={}", value.replace('\\', "\\\\").replace('\n', "\\n").replace('\r', "\\r"))
}

/// Balise de liste : ses valeurs remplacent les anciennes ; liste vide = balise supprimée.
fn push_list(args: &mut Vec<String>, tag: &str, values: impl IntoIterator<Item = String>) {
    let before = args.len();
    for value in values { args.push(assign(tag, &value)); }
    if args.len() == before { args.push(assign(tag, "")); }
}

/// Refuses immediately if `file` is read-only so ExifTool cannot replace it via rename (POSIX) or fail mid-write (Windows).
fn ensure_writable(file: &Path) -> std::io::Result<()> {
    if std::fs::metadata(file)?.permissions().readonly() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("Fichier en lecture seule : {}", file.display()),
        ));
    }
    Ok(())
}

/// Clears the read-only attribute on a disposable temporary file (e.g., copied from a read-only shared `seed` sidecar).
fn make_writable(path: &Path) -> std::io::Result<()> {
    let metadata = std::fs::metadata(path)?;
    let mut permissions = metadata.permissions();
    if permissions.readonly() {
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

/// Best-effort removal of a disposable temporary file, clearing Windows read-only attribute if needed.
fn remove_temp_file(path: &Path) {
    #[cfg(windows)]
    if let Ok(metadata) = std::fs::metadata(path) {
        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            let _ = std::fs::set_permissions(path, permissions);
        }
    }
    let _ = std::fs::remove_file(path);
}

/// Prevents ExifTool from interpreting a relative path starting with `-` as an option.
/// `--` cannot be used in `-stay_open True -@ -` mode because ExifTool would treat `-execute` and `-stay_open` as filenames.
fn safe_arg_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if raw.starts_with('-') {
        Path::new(".").join(path).to_string_lossy().into_owned()
    } else {
        raw.into_owned()
    }
}

/// Executes `-overwrite_original` on `file` with a dash-safe path.
/// When `track_recovery` is true, invokes `recover_after_failure` and records any `Recovery`; when false (disposable temp), cleans up silently.
fn overwrite_file(file: &Path, tag_args: Vec<String>, track_recovery: bool) -> std::io::Result<()> {
    let mut args = vec!["-overwrite_original".to_string()];
    args.extend(tag_args);
    args.push(safe_arg_path(file));
    run(args).map_err(|error| {
        if track_recovery {
            match recover_after_failure(file) {
                None => error,
                Some(mut recovery) => {
                    let message = format!("{error} ; {}", recovery.note());
                    recovery.error = error.to_string();
                    lock(&RECOVERIES).push(recovery);
                    std::io::Error::other(message)
                }
            }
        } else {
            remove_temp_file(&exiftool_temp_of(file));
            remove_temp_file(file);
            error
        }
    })
}

/// Modifies an existing file: checks writability, runs ExifTool (`<file>_exiftool_tmp` then replace), tracks recovery on failure, and flushes to disk.
fn overwrite(file: &Path, tag_args: Vec<String>) -> std::io::Result<()> {
    ensure_writable(file)?;
    overwrite_file(file, tag_args, true)?;
    let _ = crate::flush_to_disk(file);
    Ok(())
}

/// What `recover_after_failure` had to do beyond removing a leftover: these cases must reach the user (blocking dialog and log file),
/// not only the error text of one file among others.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryKind {
    /// ExifTool had erased the original: its temporary file was renamed back to the original name.
    Restored,
    /// ExifTool had erased the original and the temporary file could not be renamed back: it is the only copy of the photo.
    OnlyCopyKept,
    /// The state of the original is unclear: the temporary file is kept, just in case.
    TempKept,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Recovery {
    pub kind: RecoveryKind,
    pub file: String,
    pub temp: String,
    /// Why the temporary file was kept (rename or read error, original no longer a file); empty when restored.
    pub detail: String,
    /// ExifTool error that caused the cleanup (filled by `overwrite`).
    pub error: String,
}

impl Recovery {
    /// Text appended to the error of the file (failure lists, toasts).
    fn note(&self) -> String {
        match self.kind {
            RecoveryKind::Restored => "le fichier, effacé par ExifTool, a été restauré depuis sa copie temporaire (métadonnées à vérifier)".to_string(),
            RecoveryKind::OnlyCopyKept => format!(
                "ExifTool a effacé le fichier d'origine : sa seule copie est « {} » (non supprimée, à renommer à la main : {})", self.temp, self.detail
            ),
            RecoveryKind::TempKept => format!("copie temporaire « {} » conservée par précaution ({})", self.temp, self.detail),
        }
    }
}

/// Recoveries not yet reported to the user, taken by `take_recoveries` once a write operation is over.
static RECOVERIES: Mutex<Vec<Recovery>> = Mutex::new(Vec::new());

pub fn take_recoveries() -> Vec<Recovery> {
    std::mem::take(&mut *lock(&RECOVERIES))
}

/// Writes one log file for `recoveries` in `logs_dir` (created if needed), named after `now`: `write-recovery_<date>_<time>.log`
/// (`-2`, `-3`… added if the name is taken, an existing log is never overwritten). Returns its path.
pub fn write_recovery_log(logs_dir: &Path, recoveries: &[Recovery], now: chrono::DateTime<chrono::Local>) -> std::io::Result<PathBuf> {
    let mut text = format!(
        "photoboggan {} - metadata write recovery - {}\n{} file(s) needed attention after a failed ExifTool write.\n",
        env!("CARGO_PKG_VERSION"), now.format("%Y-%m-%d %H:%M:%S %:z"), recoveries.len()
    );
    for recovery in recoveries {
        let status = match recovery.kind {
            RecoveryKind::Restored => "RESTORED: the original had been erased by ExifTool and was restored from its temporary copy (check its metadata)",
            RecoveryKind::OnlyCopyKept => "ONLY COPY KEPT: the original was erased by ExifTool; the temporary file below is the only copy of the photo, rename it by hand",
            RecoveryKind::TempKept => "TEMPORARY FILE KEPT: the state of the original is unclear; the temporary file below was kept as a precaution",
        };
        text.push_str(&format!("\n{status}\n  File: {}\n", recovery.file));
        if recovery.kind != RecoveryKind::Restored { text.push_str(&format!("  Temporary file: {}\n", recovery.temp)); }
        if !recovery.detail.is_empty() { text.push_str(&format!("  Reason: {}\n", recovery.detail)); }
        if !recovery.error.is_empty() { text.push_str(&format!("  ExifTool error: {}\n", recovery.error)); }
    }
    crate::write_timestamped_log(logs_dir, "write-recovery", &text, now)
}

/// Temporary file ExifTool writes next to `file` with `-overwrite_original`.
fn exiftool_temp_of(file: &Path) -> PathBuf {
    PathBuf::from(format!("{}_exiftool_tmp", file.display()))
}

/// Cleanup after a failed ExifTool write on `file`. Returns what was done when something beyond a plain failure happened.
///
/// When its first rename fails, ExifTool deletes the original and renames again; if that second rename fails too, the temporary file is the
/// only copy left (seen on volumes without POSIX delete semantics: FAT32 / exFAT, network shares, with the file held open by another program).
/// So the temporary file is deleted only when the original is known to still exist:
/// - original present: the temporary file is a leftover, it is deleted (nothing left in the user's folder);
/// - original missing: the temporary file (complete, written by ExifTool before the rename) is renamed back to the original name;
/// - anything else (state unknown, rename impossible): the temporary file is kept and its path is reported. Never deleted in doubt.
fn recover_after_failure(file: &Path) -> Option<Recovery> {
    let temp = exiftool_temp_of(file);
    if std::fs::symlink_metadata(&temp).is_err() { return None; }
    let recovery = |kind: RecoveryKind, detail: String| Some(Recovery {
        kind,
        file: file.display().to_string(),
        temp: temp.display().to_string(),
        detail,
        error: String::new(),
    });
    match std::fs::symlink_metadata(file) {
        Ok(metadata) if !metadata.is_file() => recovery(RecoveryKind::TempKept, format!("« {} » n'est plus un fichier", file.display())),
        Ok(_) => {
            // Windows: ExifTool copies the original's read-only attribute, and a read-only file cannot be deleted as is.
            #[cfg(windows)]
            if let Ok(metadata) = std::fs::metadata(&temp) {
                let mut permissions = metadata.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                permissions.set_readonly(false);
                let _ = std::fs::set_permissions(&temp, permissions);
            }
            let _ = std::fs::remove_file(&temp);
            None
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => match std::fs::rename(&temp, file) {
            Ok(()) => {
                eprintln!("ExifTool erased {} before failing: restored from its temporary file", file.display());
                recovery(RecoveryKind::Restored, String::new())
            }
            Err(rename_error) => recovery(RecoveryKind::OnlyCopyKept, rename_error.to_string()),
        },
        Err(error) => recovery(RecoveryKind::TempKept, format!("fichier d'origine illisible : {error}")),
    }
}

#[cfg(windows)]
fn normalized_lock_key(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let stripped = if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw.into_owned()
    };
    stripped.replace('\\', "/").to_ascii_lowercase()
}

/// Verrous par « tranche » de chemin, aussi pris par les écritures internes d'exif.rs (HEIC, JPEG, sidecars) : deux écritures sur la même image
/// (ou son sidecar) ne se font jamais en même temps (lecture-modification-remplacement qui s'écraseraient, fichiers temporaires communs, sidecar créé deux fois), alors que des photos différentes restent écrites en parallèle (sauf rencontre de tranche, sans conséquence).
pub(crate) fn path_lock(path: &Path) -> std::sync::MutexGuard<'static, ()> {
    #[allow(clippy::declare_interior_mutable_const)]
    const UNLOCKED: Mutex<()> = Mutex::new(());
    static LOCKS: [Mutex<()>; 16] = [UNLOCKED; 16];
    let mut hasher = DefaultHasher::new();
    #[cfg(windows)]
    normalized_lock_key(path).hash(&mut hasher);
    #[cfg(not(windows))]
    path.hash(&mut hasher);
    lock(&LOCKS[(hasher.finish() % LOCKS.len() as u64) as usize])
}

/// Unique temporary sidecar path preserving the `.xmp` extension so ExifTool infers XMP format.
fn temp_sidecar_path(image_path: &Path) -> PathBuf {
    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);
    let n = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    PathBuf::from(format!("{}.photoboggan-{}-{n}.tmp.xmp", image_path.display(), std::process::id()))
}

/// Writes `tag_args` to the file or its already-resolved XMP sidecar target under `ActiveWriteGuard` + `path_lock`.
/// `has_values`: false when only deleting, in which case a missing sidecar (without `seed`) is not created.
fn write_to_resolved(
    image_path: &Path,
    target: Target,
    sidecar: Option<crate::exif::SidecarTarget>,
    tag_args: Vec<String>,
    has_values: bool,
) -> std::io::Result<()> {
    if !matches!(target, Target::Sidecar) { return overwrite(image_path, tag_args); }
    // See exif::write_xmp_sidecar_with: never a sidecar for an image that is no longer there.
    if !image_path.is_file() { return Err(crate::exif::image_gone(image_path)); }
    let crate::exif::SidecarTarget { path: sidecar, exists, seed } = sidecar.unwrap_or_else(|| crate::exif::sidecar_target(image_path));
    if exists { return overwrite(&sidecar, tag_args); }
    let temp = temp_sidecar_path(image_path);
    remove_temp_file(&temp);
    if let Some(seed) = seed {
        // Own sidecar created from the shared `photo.xmp` (see exif::sidecar_target), even for a removal: the value to remove may come from
        // `photo.xmp`, which the image would otherwise keep reading. Copy, update, flush, then rename: `photo.xmp` is never modified.
        let created = std::fs::copy(&seed, &temp)
            .and_then(|_| make_writable(&temp))
            .and_then(|_| overwrite_file(&temp, tag_args, false))
            .and_then(|_| crate::flush_to_disk(&temp))
            .and_then(|_| std::fs::rename(&temp, &sidecar));
        if created.is_err() {
            remove_temp_file(&exiftool_temp_of(&temp));
            remove_temp_file(&temp);
        } else {
            crate::sync_parent_dir(&sidecar);
        }
        return created;
    }
    if !has_values { return Ok(()); }
    // New sidecar: created under a temporary name (.xmp extension kept so ExifTool infers format), flushed, then renamed.
    let mut args = vec!["-o".to_string(), safe_arg_path(&temp)];
    args.extend(tag_args);
    if let Err(error) = run(args) {
        remove_temp_file(&temp);
        return Err(error);
    }
    if let Err(error) = crate::flush_to_disk(&temp).and_then(|_| std::fs::rename(&temp, &sidecar)) {
        remove_temp_file(&temp);
        return Err(error);
    }
    crate::sync_parent_dir(&sidecar);
    Ok(())
}

/// Writes `tag_args` to the file or its XMP sidecar depending on format. `has_values`: false when only deleting,
/// in which case a missing sidecar is not created.
fn write_to(image_path: &Path, tag_args: Vec<String>, has_values: bool) -> std::io::Result<()> {
    let _active_write = ActiveWriteGuard::enter()?;
    let _guard = path_lock(image_path);
    write_to_resolved(image_path, target_of(image_path), None, tag_args, has_values)
}

/// Preserved non-face MWG regions read from the target's existing `XMP-mwg-rs:RegionInfo`.
#[derive(Clone, Debug, Default, PartialEq)]
struct PreservedMwgRegions {
    regions: Vec<serde_json::Value>,
    applied_to_dimensions: Option<serde_json::Value>,
}

/// Returns true if a JSON MWG region object has a present, non-empty `Type` different from `Face` (case-insensitive).
fn is_non_face_region_json(item: &serde_json::Value) -> bool {
    item.as_object()
        .and_then(|map| map.get("Type"))
        .and_then(|value| value.as_str())
        .is_some_and(|region_type| {
            let trimmed = region_type.trim();
            !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("face")
        })
}

/// Parses ExifTool `-j -struct -n -XMP-mwg-rs:RegionInfo` output and keeps only non-face MWG regions.
fn parse_preserved_mwg_regions(json: &str) -> std::io::Result<PreservedMwgRegions> {
    let root: serde_json::Value = serde_json::from_str(json)
        .map_err(|error| std::io::Error::other(format!("Impossible de lire les régions MWG existantes (JSON invalide) : {error}")))?;
    let region_info = root
        .as_array()
        .and_then(|items| items.first())
        .and_then(|entry| entry.as_object())
        .and_then(|entry| entry.get("RegionInfo"))
        .and_then(|info| info.as_object())
        .ok_or_else(|| std::io::Error::other("Impossible de lire les régions MWG existantes : structure RegionInfo absente"))?;
    let applied_to_dimensions = region_info.get("AppliedToDimensions").filter(|value| value.is_object()).cloned();
    let regions = match region_info.get("RegionList") {
        Some(serde_json::Value::Array(items)) => items.iter().filter(|item| is_non_face_region_json(item)).cloned().collect(),
        Some(single @ serde_json::Value::Object(_)) => {
            if is_non_face_region_json(single) { vec![single.clone()] } else { Vec::new() }
        }
        _ => return Err(std::io::Error::other("Impossible de lire les régions MWG existantes : RegionList absent ou invalide")),
    };
    Ok(PreservedMwgRegions { regions, applied_to_dimensions })
}

/// Reads `XMP-mwg-rs:RegionInfo` from `source` via the persistent ExifTool pool using `-j -struct -n`.
fn read_preserved_mwg_regions(source: &Path) -> std::io::Result<PreservedMwgRegions> {
    let args = vec![
        "-j".to_string(),
        "-struct".to_string(),
        "-n".to_string(),
        "-XMP-mwg-rs:RegionInfo".to_string(),
        safe_arg_path(source),
    ];
    let (stdout, _) = run_raw(&args)?;
    parse_preserved_mwg_regions(&stdout)
}

/// Écrit les modifications `update` en une seule commande ExifTool :
/// - mots-clés actifs (un chemin par mot-clé) : dc:subject, digiKam TagsList, Lightroom hierarchicalSubject, Media Pro CatalogSets,
///   Microsoft LastKeywordXMP, ACDSee categories ; dans les JPEG, aussi IPTC Keywords et EXIF XPKeywords ;
/// - titre : XMP dc:title et acdsee:caption ; dans les JPEG, aussi IPTC ObjectName et EXIF XPTitle ;
/// - description : XMP dc:description, exif:UserComment, tiff:ImageDescription, acdsee:notes ; dans les JPEG, aussi le commentaire JPEG,
///   EXIF ImageDescription, UserComment et XPComment, et IPTC Caption ;
/// - auteur : XMP dc:creator et tiff:Artist ; dans les JPEG, aussi IPTC By-line et EXIF Artist ;
/// - copyright : XMP dc:rights et tiff:Copyright ; dans les JPEG, aussi IPTC CopyrightNotice et EXIF Copyright (« © » devient « (c) ») ;
/// - crédit : XMP photoshop:Credit ; dans les JPEG, aussi IPTC Credit ; conditions d'utilisation : XMP xmpRights:UsageTerms ;
///   e-mail de l'auteur : XMP Iptc4xmpCore:CreatorContactInfo / CiEmailWork ;
/// - zones de visage : MWG RegionInfo et Microsoft RegionInfoMP (mêmes champs que exif::update_xmp_regions ; ACDSee non écrit).
///   When writing face regions, existing non-face MWG regions (`Pet`, `Focus`, `BarCode`, etc.) are preserved.
pub fn write_metadata(image_path: &Path, update: &crate::exif::MetadataUpdate) -> std::io::Result<()> {
    let mut args = metadata_args(image_path, update);
    let Some(regions) = &update.regions else {
        if args.is_empty() { return Ok(()); }
        return write_to(image_path, args, update.adds_values());
    };

    let _active_write = ActiveWriteGuard::enter()?;
    let _guard = path_lock(image_path);
    let target = target_of(image_path);
    let mut sidecar_target: Option<crate::exif::SidecarTarget> = None;
    let (source, raw_xmp): (Option<PathBuf>, Option<String>) = match target {
        Target::Jpeg => {
            ensure_writable(image_path)?;
            (Some(image_path.to_path_buf()), crate::exif::read_embedded_jpeg_xmp(image_path))
        }
        Target::Heif => {
            ensure_writable(image_path)?;
            (Some(image_path.to_path_buf()), crate::heif::read_xmp(image_path))
        }
        Target::Sidecar => {
            if !image_path.is_file() { return Err(crate::exif::image_gone(image_path)); }
            let sc = crate::exif::sidecar_target(image_path);
            if sc.exists { ensure_writable(&sc.path)?; }
            let src = if sc.exists { Some(sc.path.clone()) } else { sc.seed.clone() };
            let xml = src.as_deref().and_then(|path| std::fs::read_to_string(path).ok());
            sidecar_target = Some(sc);
            (src, xml)
        }
    };
    let preserved = if raw_xmp.as_deref().is_some_and(crate::faces::has_non_face_mwg_regions) {
        let source_path = source.as_deref().ok_or_else(|| std::io::Error::other("Source XMP introuvable pour préserver les régions"))?;
        Some(read_preserved_mwg_regions(source_path)?)
    } else {
        None
    };
    let has_preserved = preserved.as_ref().is_some_and(|item| !item.regions.is_empty());
    args.extend(region_args(regions, preserved.as_ref()));
    write_to_resolved(image_path, target, sidecar_target, args, update.adds_values() || has_preserved)
}

/// Escapes a value inside an ExifTool structure (`{Field=value,...}`): syntax characters, `#` (comment start),
/// and leading/trailing whitespace (otherwise trimmed by ExifTool's struct parser) are prefixed with `|`.
fn struct_value(value: &str) -> String {
    let trimmed_start = value.len() - value.trim_start_matches([' ', '\t', '\n', '\r']).len();
    let trimmed_end = value.trim_end_matches([' ', '\t', '\n', '\r']).len();
    let mut escaped = String::with_capacity(value.len());
    for (index, character) in value.char_indices() {
        let is_edge_space = matches!(character, ' ' | '\t' | '\n' | '\r') && (index < trimmed_start || index >= trimmed_end);
        if is_edge_space || matches!(character, '|' | ',' | '=' | '{' | '}' | '[' | ']' | '#') {
            escaped.push('|');
        }
        escaped.push(character);
    }
    escaped
}

/// Serializes a `serde_json::Value` into ExifTool's `{Key=val,...}` / `[...]` struct syntax.
fn json_to_exiftool_struct(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => struct_value(s),
        serde_json::Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(json_to_exiftool_struct).collect();
            format!("[{}]", parts.join(","))
        }
        serde_json::Value::Object(map) => {
            let parts: Vec<String> = map.iter().map(|(key, val)| format!("{key}={}", json_to_exiftool_struct(val))).collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

/// Zones de visage : la structure entière est remplacée (liste vide : supprimée, sauf si des régions MWG non-visage sont préservées).
/// MWG : centre de la zone ; Microsoft : coin haut-gauche, valeurs séparées par des virgules (échappées dans la structure).
fn region_args(update: &crate::exif::RegionsUpdate, preserved: Option<&PreservedMwgRegions>) -> Vec<String> {
    let number = |value: f64| format!("{:.6}", value.clamp(0.0, 1.0));
    let mut mwg_regions: Vec<String> = update.regions.iter().map(|region| {
        let name = region.name.as_deref().map(|name| format!(",Name={}", struct_value(name))).unwrap_or_default();
        format!(
            "{{Area={{X={},Y={},W={},H={},Unit=normalized}}{name},Type=Face}}",
            number(region.x + region.w / 2.0), number(region.y + region.h / 2.0), number(region.w), number(region.h)
        )
    }).collect();
    if let Some(preserved) = preserved {
        mwg_regions.extend(preserved.regions.iter().map(json_to_exiftool_struct));
    }

    let mwg_arg = if mwg_regions.is_empty() {
        assign("XMP-mwg-rs:RegionInfo", "")
    } else {
        let dimensions = if update.width > 0 && update.height > 0 {
            format!("AppliedToDimensions={{W={},H={},Unit=pixel}},", update.width, update.height)
        } else if let Some(dims) = preserved.and_then(|item| item.applied_to_dimensions.as_ref()) {
            format!("AppliedToDimensions={},", json_to_exiftool_struct(dims))
        } else {
            String::new()
        };
        assign("XMP-mwg-rs:RegionInfo#", &format!("{{{dimensions}RegionList=[{}]}}", mwg_regions.join(",")))
    };

    let microsoft_arg = if update.regions.is_empty() {
        assign("XMP-MP:RegionInfoMP", "")
    } else {
        let microsoft_regions: Vec<String> = update.regions.iter().map(|region| {
            let name = region.name.as_deref().map(|name| format!("PersonDisplayName={},", struct_value(name))).unwrap_or_default();
            format!("{{{name}Rectangle={}|, {}|, {}|, {}}}", number(region.x), number(region.y), number(region.w), number(region.h))
        }).collect();
        assign("XMP-MP:RegionInfoMP", &format!("{{Regions=[{}]}}", microsoft_regions.join(",")))
    };

    vec![mwg_arg, microsoft_arg]
}

/// Nom d'une propriété XMP « liste de langues » à écrire. Valeur non vide : seule l'entrée `x-default` est remplacée, les traductions
/// (digiKam…) sont conservées, alors qu'écrire sans langue les supprime. Valeur vide : propriété retirée avec toutes ses langues.
fn lang_alt_tag(tag: &str, value: &str) -> String {
    if value.is_empty() { tag.to_string() } else { format!("{tag}-x-default") }
}

/// Arguments ExifTool des mots-clés, du titre et de la description de `update`.
fn metadata_args(image_path: &Path, update: &crate::exif::MetadataUpdate) -> Vec<String> {
    let jpeg = matches!(target_of(image_path), Target::Jpeg);
    let mut args = Vec::new();
    // Written IPTC values: declare UTF-8 when any value is non-ASCII.
    let mut iptc_values: Vec<String> = Vec::new();
    // Track any IPTC tag write or deletion on JPEG so Photoshop:IPTCDigest is recalculated.
    let mut wrote_iptc = false;
    if let Some(paths) = &update.keywords {
        let leaves = crate::exif::keyword_leaves(paths);
        let joined = |separator: &str| paths.iter().map(|segments| segments.join(separator)).collect::<Vec<_>>();
        push_list(&mut args, "XMP-dc:Subject", leaves.clone());
        push_list(&mut args, "XMP-digiKam:TagsList", joined("/"));
        push_list(&mut args, "XMP-lr:HierarchicalSubject", joined("|"));
        push_list(&mut args, "XMP-mediapro:CatalogSets", joined("|"));
        push_list(&mut args, "XMP-microsoft:LastKeywordXMP", joined("/"));
        // Catégories ACDSee : une seule valeur texte (l'arbre XML), qu'ExifTool échappe lui-même dans le paquet.
        let categories = if paths.is_empty() { String::new() } else { crate::exif::acdsee_categories_value(paths) };
        args.push(assign("XMP-acdsee:Categories", &categories));
        if jpeg {
            // IPTC : 64 octets au plus par mot-clé (coupés comme l'écriture interne).
            let iptc: Vec<String> = leaves.iter().map(|word| crate::exif::truncate_utf8(word, 64).to_string()).collect();
            push_list(&mut args, "IPTC:Keywords", iptc.clone());
            iptc_values.extend(iptc);
            wrote_iptc = true;
            // XPKeywords : mots séparés par « ; », donc les noms qui en contiennent sont omis de ce seul champ.
            let xp: Vec<&str> = leaves.iter().map(String::as_str).filter(|word| !word.contains(';')).collect();
            args.push(assign("EXIF:XPKeywords", &xp.join(";")));
        }
    }
    if let Some(title) = update.clean_title() {
        args.push(assign(&lang_alt_tag("XMP-dc:Title", &title), &title));
        args.push(assign("XMP-acdsee:Caption", &title));
        if jpeg {
            let object_name = crate::exif::truncate_utf8(&title, 64).to_string();
            args.push(assign("IPTC:ObjectName", &object_name));
            iptc_values.push(object_name);
            wrote_iptc = true;
            args.push(assign("EXIF:XPTitle", &title));
        }
    }
    if let Some(description) = update.clean_description() {
        for tag in ["XMP-dc:Description", "XMP-exif:UserComment", "XMP-tiff:ImageDescription"] {
            args.push(assign(&lang_alt_tag(tag, &description), &description));
        }
        args.push(assign("XMP-acdsee:Notes", &description));
        if jpeg {
            for tag in ["File:Comment", "EXIF:ImageDescription", "EXIF:UserComment", "EXIF:XPComment"] {
                args.push(assign(tag, &description));
            }
            let caption = crate::exif::truncate_utf8(&description, 2000).to_string();
            args.push(assign("IPTC:Caption-Abstract", &caption));
            iptc_values.push(caption);
            wrote_iptc = true;
        }
    }
    // Auteur et droits (exif::update_xmp_rights pour le XMP). Les valeurs IPTC sont coupées à la longueur de la norme comme à l'écriture interne.
    if let Some(authors) = update.author_list() {
        let joined = authors.join("; ");
        push_list(&mut args, "XMP-dc:Creator", authors.clone());
        args.push(assign("XMP-tiff:Artist", &joined));
        if jpeg {
            let by_lines: Vec<String> = authors.iter().map(|name| crate::exif::truncate_utf8(name, 32).to_string()).collect();
            push_list(&mut args, "IPTC:By-line", by_lines.clone());
            iptc_values.extend(by_lines);
            wrote_iptc = true;
            args.push(assign("EXIF:Artist", &joined));
        }
    }
    if let Some(copyright) = update.clean_copyright() {
        // Sans suffixe de langue : seule l'entrée x-default est écrite, les autres langues de dc:rights sont effacées.
        args.push(assign("XMP-dc:Rights", &copyright));
        args.push(assign(&lang_alt_tag("XMP-tiff:Copyright", &copyright), &copyright));
        if jpeg {
            let notice = crate::exif::truncate_utf8(&copyright, 128).to_string();
            args.push(assign("IPTC:CopyrightNotice", &notice));
            iptc_values.push(notice);
            wrote_iptc = true;
            // L'EXIF Copyright est de l'ASCII : « © » devient « (c) ».
            args.push(assign("EXIF:Copyright", &copyright.replace('©', "(c)")));
        }
    }
    if let Some(credit) = update.clean_credit() {
        args.push(assign("XMP-photoshop:Credit", &credit));
        if jpeg {
            let iptc = crate::exif::truncate_utf8(&credit, 32).to_string();
            args.push(assign("IPTC:Credit", &iptc));
            iptc_values.push(iptc);
            wrote_iptc = true;
        }
    }
    if let Some(terms) = update.clean_usage_terms() {
        args.push(assign("XMP-xmpRights:UsageTerms", &terms)); // sans langue : les autres langues sont effacées
    }
    if let Some(email) = update.clean_author_email() {
        // Champ de la structure CreatorContactInfo : ExifTool fusionne avec la structure existante, les autres champs sont conservés.
        args.push(assign("XMP-iptcCore:CreatorWorkEmail", &email));
    }
    if iptc_values.iter().any(|value| !value.is_ascii()) { args.push("-IPTC:CodedCharacterSet=UTF8".to_string()); }
    if wrote_iptc { args.push("-Photoshop:IPTCDigest=new".to_string()); }
    // Coordonnées GPS (geolocation.rs) : XMP exif:GPS… et, quand le fichier lui-même est écrit (JPEG, HEIC), le bloc GPS de l'EXIF.
    if let Some(gps) = update.gps {
        let in_file = !matches!(target_of(image_path), Target::Sidecar);
        match gps {
            None => {
                args.push("-XMP-exif:GPS*=".to_string());
                if in_file { args.push("-GPS:All=".to_string()); }
            }
            Some((latitude, longitude)) => {
                args.push(assign("XMP-exif:GPSLatitude", &format!("{latitude:.7}")));
                args.push(assign("XMP-exif:GPSLongitude", &format!("{longitude:.7}")));
                if in_file {
                    args.push(assign("GPS:GPSLatitude", &format!("{:.7}", latitude.abs())));
                    args.push(assign("GPS:GPSLatitudeRef", if latitude < 0.0 { "S" } else { "N" }));
                    args.push(assign("GPS:GPSLongitude", &format!("{:.7}", longitude.abs())));
                    args.push(assign("GPS:GPSLongitudeRef", if longitude < 0.0 { "W" } else { "E" }));
                }
            }
        }
    }
    args
}

/// Le fichier lui-même est écrit (JPEG, HEIC), et pas un sidecar XMP : seul ce cas permet d'effacer le GPS de l'EXIF.
pub fn writes_in_file(image_path: &Path) -> bool {
    !matches!(target_of(image_path), Target::Sidecar)
}

/// Note (`xmp:Rating`, `acdsee:rating`, `MicrosoftPhoto:Rating` ; dans les JPEG, aussi EXIF `Rating` et `RatingPercent` de Windows) et/ou
/// couleur (`xmp:Label`, `photoshop:Urgency`, `digiKam:ColorLabel`) et/ou fanion pick (`digiKam:PickLabel`, `xmpDM:pick`, `xmpDM:good`) : seules
/// les valeurs fournies sont modifiées ; `Some(None)` retire la couleur. Mêmes valeurs que l'écriture interne, qui ne touche pas à l'EXIF.
pub fn write_marking(image_path: &Path, edit: crate::exif::XmpEdit) -> std::io::Result<()> {
    let crate::exif::XmpEdit { rating, label, pick } = edit;
    let mut args = Vec::new();
    let has_values = edit.adds_values();
    if let Some(rating) = rating {
        let rating = rating.clamp(0, 5);
        let microsoft_rating = match rating { 0 => 0, 1 => 1, 2 => 25, 3 => 50, 4 => 75, _ => 99 };
        args.push(assign("XMP-xmp:Rating", &rating.to_string()));
        args.push(assign("XMP-acdsee:Rating", &rating.to_string()));
        args.push(assign("XMP-microsoft:RatingPercent", &microsoft_rating.to_string()));
        if matches!(target_of(image_path), Target::Jpeg) {
            args.push(assign("EXIF:Rating", &rating.to_string()));
            args.push(assign("EXIF:RatingPercent", &microsoft_rating.to_string()));
        }
    }
    if let Some(label) = label {
        let number = label.and_then(crate::exif::color_to_urgency_and_digikam).map(|value| value.to_string()).unwrap_or_default();
        args.push(assign("XMP-xmp:Label", label.unwrap_or_default()));
        args.push(assign("XMP-photoshop:Urgency", &number));
        args.push(assign("XMP-digiKam:ColorLabel", &number));
    }
    if let Some(pick) = pick {
        let (digikam, xmpdm_pick, xmpdm_good) = crate::exif::pick_values(pick);
        args.push(assign("XMP-digiKam:PickLabel", &digikam.to_string()));
        args.push(assign("XMP-xmpDM:Pick", &xmpdm_pick.to_string()));
        args.push(assign("XMP-xmpDM:Good", xmpdm_good.unwrap_or_default())); // valeur vide : balise supprimée
    }
    if args.is_empty() { return Ok(()); }
    write_to(image_path, args, has_values)
}

/// Arguments of a lossless rotation (see orientation.rs): XMP `tiff:Orientation` always, and in a JPEG the EXIF `Orientation` of IFD0 too.
/// Numeric values (`#`): ExifTool would otherwise expect the printed names ("Rotate 90 CW"…).
fn orientation_args(image_path: &Path, orientation: u32) -> Vec<String> {
    let mut args = vec![format!("-XMP-tiff:Orientation#={orientation}")];
    if matches!(target_of(image_path), Target::Jpeg) { args.push(format!("-IFD0:Orientation#={orientation}")); }
    args
}

/// Lossless rotation: only the orientation tags change (see `orientation_args`), the image data is never touched.
pub fn write_orientation(image_path: &Path, orientation: u32) -> std::io::Result<()> {
    write_to(image_path, orientation_args(image_path, orientation), true)
}

#[cfg(test)]
#[path = "tests/exiftool.rs"]
mod tests;

#[cfg(test)]
#[path = "tests/exiftool_rights.rs"]
mod rights_tests;
