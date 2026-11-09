//! Shared ONNX Runtime environment and session builder (face detection / recognition, semantic search).
//!
//! The library is loaded dynamically (`ort` with `load-dynamic`) from the file downloaded with the models: nothing is loaded until a task
//! needs it. The environment is created once per process (constraint of the `ort` crate: the library cannot be unloaded) and kept; sessions,
//! which hold most of the memory, are created per task and dropped at its end.

use ort::environment::Environment;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// ONNX Runtime environment, created on first use from the library `runtime`, then shared by every session of the process.
pub(crate) fn environment(runtime: &Path) -> Result<Environment, String> {
    static ENVIRONMENT: OnceLock<Environment> = OnceLock::new();
    static INIT_LOCK: Mutex<()> = Mutex::new(());
    if let Some(environment) = ENVIRONMENT.get() { return Ok(environment.clone()); }
    // One attempt at a time, and only a success is kept: a failure (library not imported yet, locked…) can be retried.
    let _guard = INIT_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(environment) = ENVIRONMENT.get() { return Ok(environment.clone()); }
    let built = ort::init_from(runtime)
        .map_err(|error| format!("ONNX Runtime impossible à charger : {error}"))?
        .build()
        .map_err(|error| format!("ONNX Runtime impossible à initialiser : {error}"))?;
    Ok(ENVIRONMENT.get_or_init(|| built).clone())
}

/// Session for a background task that must not slow the application down (spec of the semantic search, §4.3): `intra_threads` threads
/// inside each operator, a single inter-operator thread, no spinning (idle ONNX Runtime threads would otherwise busy-wait and burn CPU
/// between two calls), all graph optimisations, CPU execution provider.
pub(crate) fn background_session(environment: &Environment, model: &Path, intra_threads: usize) -> Result<Session, String> {
    Session::builder(environment)
        .and_then(|builder| builder.with_optimization_level(GraphOptimizationLevel::All).map_err(Into::into))
        .and_then(|builder| builder.with_intra_threads(intra_threads.max(1)).map_err(Into::into))
        .and_then(|builder| builder.with_inter_threads(1).map_err(Into::into))
        .and_then(|builder| builder.with_intra_op_spinning(false).map_err(Into::into))
        .and_then(|builder| builder.with_inter_op_spinning(false).map_err(Into::into))
        .and_then(|mut builder| builder.commit_from_file(model))
        .map_err(|error| error.to_string())
}
