//! Generic handling of downloadable model files (face models, semantic search models, ONNX Runtime library).
//!
//! Each file is described by its release name (`asset`), its local name, its size and its SHA-256 (pinned in a manifest). A file is only
//! installed once its checksum has been verified: it is written next to its final name (`.part`) and renamed afterwards, so a partial or
//! corrupted file is never mistaken for an installed one. Sources: a GitHub release (download, refused in offline mode by the callers) or a
//! folder chosen by the user (import, no Internet needed).

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Download time limits: without them, a connection that stops answering would block the task forever.
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest time to receive one face model file (the largest is a few tens of MB): generous for a slow link, but finite.
pub(crate) const BODY_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Time without any byte received after which the download fails (connection frozen in the middle of a transfer).
pub(crate) const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Reader that gives control back even when the connection is frozen: the real read happens in a dedicated thread, this reader waits for its
/// chunks in 200 ms steps. It thus checks the stop request (`cancel`) without waiting for the next byte, and fails after `idle` without data.
/// The abandoned thread ends on its own: when the connection closes, at the latest at the body timeout, or at its next send.
pub(crate) struct IdleReader<'a> {
    chunks: std::sync::mpsc::Receiver<std::io::Result<Vec<u8>>>,
    pending: Vec<u8>,
    position: usize,
    idle: Duration,
    cancel: &'a AtomicBool,
}

impl<'a> IdleReader<'a> {
    pub(crate) fn new(mut source: Box<dyn Read + Send>, idle: Duration, cancel: &'a AtomicBool) -> Self {
        let (sender, chunks) = std::sync::mpsc::sync_channel(4);
        std::thread::spawn(move || loop {
            let mut buffer = vec![0u8; 64 * 1024];
            let message = source.read(&mut buffer).map(|count| { buffer.truncate(count); buffer });
            let finished = !matches!(&message, Ok(chunk) if !chunk.is_empty());
            if sender.send(message).is_err() || finished { break; }
        });
        IdleReader { chunks, pending: Vec::new(), position: 0, idle, cancel }
    }
}

impl Read for IdleReader<'_> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        use std::sync::mpsc::RecvTimeoutError;
        let started = std::time::Instant::now();
        while self.position >= self.pending.len() {
            if self.cancel.load(Ordering::Relaxed) { return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled")); }
            match self.chunks.recv_timeout(Duration::from_millis(200)) {
                Ok(Ok(chunk)) if chunk.is_empty() => return Ok(0),
                Ok(Ok(chunk)) => { self.pending = chunk; self.position = 0; }
                Ok(Err(error)) => return Err(error),
                Err(RecvTimeoutError::Disconnected) => return Ok(0),
                Err(RecvTimeoutError::Timeout) if started.elapsed() >= self.idle => {
                    return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, format!("aucune donnée reçue depuis {} s", self.idle.as_secs())));
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
        let count = out.len().min(self.pending.len() - self.position);
        out[..count].copy_from_slice(&self.pending[self.position..self.position + count]);
        self.position += count;
        Ok(count)
    }
}

/// One expected file, as pinned by a manifest.
#[derive(Clone, Copy)]
pub(crate) struct Expected<'a> {
    /// Name on the release (also accepted when importing from a folder).
    pub asset: &'a str,
    /// Name in the installation folder.
    pub local: &'a str,
    pub size: u64,
    pub sha256: &'a str,
}

/// Installed file: present with the expected size (its SHA-256 was checked when it was installed).
pub(crate) fn is_installed(dir: &Path, file: &Expected) -> bool {
    fs::metadata(dir.join(file.local)).is_ok_and(|metadata| metadata.is_file() && metadata.len() == file.size)
}

/// Status of one file, sent to the interface (offline installation: name, address and checksum to fetch it by hand).
#[derive(Serialize)]
pub struct ModelFileStatus {
    pub name: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub installed: bool,
}

pub(crate) fn file_status(base_url: &str, dir: &Path, file: &Expected) -> ModelFileStatus {
    ModelFileStatus {
        name: file.asset.to_string(),
        url: format!("{base_url}{}", file.asset),
        sha256: file.sha256.to_string(),
        size: file.size,
        installed: is_installed(dir, file),
    }
}

pub(crate) fn hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Copies `reader` into `<local>.part` while computing its SHA-256, then renames the file if checksum and size are the expected ones.
/// `on_bytes(n)` is called after each written block; `cancel` stops the copy (the partial file is deleted).
pub(crate) fn install_from(reader: &mut dyn Read, dir: &Path, file: &Expected, cancel: Option<&AtomicBool>, on_bytes: &mut dyn FnMut(u64)) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("Dossier des modèles impossible à créer : {error}"))?;
    let partial = dir.join(format!("{}.part", file.local));
    let result = (|| {
        let mut output = fs::File::create(&partial).map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        let mut written = 0u64;
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) { return Err("cancelled".to_string()); }
            let count = reader.read(&mut buffer).map_err(|error| {
                // A read interrupted by the stop request (IdleReader) is not a download error.
                if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) { "cancelled".to_string() } else { format!("{} : {error}", file.asset) }
            })?;
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
        // File verified but impossible to put in place (target in use, rights…): the complete `.part` must not stay in the folder.
        Ok(()) => fs::rename(&partial, dir.join(file.local)).map_err(|error| {
            let _ = fs::remove_file(&partial);
            error.to_string()
        }),
        Err(error) => {
            let _ = fs::remove_file(&partial);
            Err(error)
        }
    }
}

/// Downloads `url` and installs it as `file` in `dir` (blocking: call it off the main thread). `body_timeout` bounds the whole transfer of
/// this file; a frozen connection fails earlier (IDLE_TIMEOUT). The caller checks that Internet access is allowed.
pub(crate) fn download(url: &str, dir: &Path, file: &Expected, body_timeout: Duration, cancel: &AtomicBool, on_bytes: &mut dyn FnMut(u64)) -> Result<(), String> {
    let response = ureq::get(url)
        .config()
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_response(Some(RESPONSE_TIMEOUT))
        .timeout_recv_body(Some(body_timeout))
        .build()
        .call()
        .map_err(|error| format!("{url} : {error}"))?;
    let mut reader = IdleReader::new(Box::new(response.into_body().into_reader()), IDLE_TIMEOUT, cancel);
    install_from(&mut reader, dir, file, Some(cancel), on_bytes)
}

/// Offline installation of one file: looks in `source_dir` for its release name, then its local name, and installs it after verification.
pub(crate) fn import_from(source_dir: &Path, dir: &Path, file: &Expected) -> Result<(), String> {
    let Some(source) = [file.asset, file.local].into_iter().map(|name| source_dir.join(name)).find(|path| path.is_file()) else {
        return Err(format!("{} : introuvable", file.asset));
    };
    fs::File::open(&source)
        .map_err(|error| error.to_string())
        .and_then(|mut reader| install_from(&mut reader, dir, file, None, &mut |_| {}))
}
