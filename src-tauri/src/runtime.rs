//! Cross-cutting runtime primitives: offline gate (`INTERNET_ALLOWED`) and task priority coordination.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// Internet access allowed (Settings > General, "Offline mode" unchecked); sent by the UI at startup and on every change.
/// Denied until the UI sends it: no download can start before the setting is known.
static INTERNET_ALLOWED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn set_internet_allowed(allowed: bool) {
    INTERNET_ALLOWED.store(allowed, Ordering::Relaxed);
}

/// Internet access allowed: checked by every network access in the application.
pub fn internet_allowed() -> bool {
    INTERNET_ALLOWED.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// Priority: background tasks give way to every foreground task
// ---------------------------------------------------------------------------

/// Foreground tasks running now (library sync, catalogue scans, metadata and keyword writes, integrity check, face scan,
/// thumbnail generation). While it is above zero, both interactive duplicate searches and background tasks yield.
static FOREGROUND_TASKS: AtomicUsize = AtomicUsize::new(0);
/// Interactive duplicate searches running now (Level 1). While above zero, background tasks (content analysis, hash precomputation) pause.
static INTERACTIVE_HASH_TASKS: AtomicUsize = AtomicUsize::new(0);

/// Marks a foreground task for as long as it lives (RAII): `let _priority = crate::runtime::PriorityGuard::new();`. A single atomic
/// increment: no cost when the semantic scan is off.
pub struct PriorityGuard(());

impl PriorityGuard {
    pub fn new() -> Self {
        FOREGROUND_TASKS.fetch_add(1, Ordering::SeqCst);
        PriorityGuard(())
    }
}

impl Drop for PriorityGuard {
    fn drop(&mut self) {
        FOREGROUND_TASKS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Marks an interactive duplicate search for as long as it lives (RAII): pauses background tasks (content analysis, hash precomputation)
/// without blocking foreground UI tasks.
pub struct BackgroundPauseGuard(());

impl BackgroundPauseGuard {
    pub fn new() -> Self {
        INTERACTIVE_HASH_TASKS.fetch_add(1, Ordering::SeqCst);
        BackgroundPauseGuard(())
    }
}

impl Drop for BackgroundPauseGuard {
    fn drop(&mut self) {
        INTERACTIVE_HASH_TASKS.fetch_sub(1, Ordering::SeqCst);
    }
}

pub fn foreground_busy() -> bool {
    FOREGROUND_TASKS.load(Ordering::SeqCst) > 0
}

pub fn background_busy() -> bool {
    FOREGROUND_TASKS.load(Ordering::SeqCst) > 0 || INTERACTIVE_HASH_TASKS.load(Ordering::SeqCst) > 0
}

/// Lowers the priority of the current thread (the scan worker and its decoder are dedicated threads, never pool threads). Windows only:
/// Linux would need the `libc` crate, and the small number of threads is enough there.
#[cfg(windows)]
pub(crate) fn lower_thread_priority() {
    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL};
    // SAFETY: GetCurrentThread returns a pseudo-handle valid in the calling thread; a failure only leaves the normal priority.
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

#[cfg(not(windows))]
pub(crate) fn lower_thread_priority() {}

/// Resolves the worker thread count for duplicate hashing from the UI setting (`"auto"`, `"1"`, `"2"`, `"4"`).
pub(crate) fn resolve_hash_threads(setting: Option<&str>, interactive: bool) -> usize {
    match setting {
        Some("1") => 1,
        Some("2") => 2,
        Some("4") => 4,
        _ => {
            let cores = std::thread::available_parallelism().map_or(4, std::num::NonZero::get);
            if interactive {
                (cores / 2).clamp(2, 4)
            } else {
                2.min((cores / 2).max(1))
            }
        }
    }
}

/// Builds a Rayon thread pool whose worker threads run at lowered OS priority.
pub(crate) fn build_low_priority_pool(threads: usize) -> Result<rayon::ThreadPool, String> {
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads.max(1))
        .start_handler(|_| lower_thread_priority())
        .build()
        .map_err(|error| error.to_string())
}
