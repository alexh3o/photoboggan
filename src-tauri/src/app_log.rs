//! Minimal persistent error log (`<data_dir>/logs/app.log`) for critical backend failures.
//! Release Windows builds use `windows_subsystem = "windows"` (no stderr), so errors written here stay diagnosable.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

const MAX_LOG_BYTES: u64 = 512 * 1024;
static LOGS_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Sets the directory where `app.log` is written (called at startup and on storage location change).
pub fn set_logs_dir(dir: PathBuf) {
    *LOGS_DIR.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(dir);
}

/// Logs an error to stderr (debug builds only) and appends a timestamped line to `<logs_dir>/app.log`.
pub fn log_error(context: &str, error: impl std::fmt::Display) {
    #[cfg(debug_assertions)]
    eprintln!("{context}: {error}");
    let dir = LOGS_DIR.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    if let Some(dir) = dir {
        write_to_dir(&dir, context, &error);
    }
}

fn write_to_dir(dir: &Path, context: &str, error: &dyn std::fmt::Display) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if fs::create_dir_all(dir).is_err() { return; }
    let path = dir.join("app.log");
    if fs::metadata(&path).map_or(false, |m| m.len() > MAX_LOG_BYTES) {
        let old = dir.join("app.log.old");
        let _ = fs::remove_file(&old);
        let _ = fs::rename(&path, &old);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = writeln!(file, "{now} | {context}: {error}");
    }
}

#[cfg(test)]
#[path = "tests/app_log.rs"]
mod tests;
