//! Tests of the semantic model files: manifest, status, deletion, gating. No download, no real model: empty or fake files only.

use super::*;

#[test]
fn the_manifest_matches_the_phase_0_constants() {
    let model = active_model();
    assert_eq!(model.id, "siglip2-base-p16-224");
    assert_eq!((model.image_size, model.embed_dim, model.max_text_tokens), (224, 768, 64));
    assert_eq!((model.pad_id, model.eos_id), (0, 1));
    assert!(model.lowercase);
    assert_eq!(model.template, "this is a photo of {}.");
    assert_eq!(model.template_max_words, 3);
    // Same values as the reference fixture written by make_reference.py.
    let reference: serde_json::Value = serde_json::from_str(include_str!("fixtures/semantic_reference.json")).unwrap();
    assert!((model.logit_scale as f64 - reference["logit_scale"].as_f64().unwrap()).abs() < 1e-3);
    assert!((model.logit_bias as f64 - reference["logit_bias"].as_f64().unwrap()).abs() < 1e-3);
    for role in ["vision", "text", "tokenizer"] {
        let file = model.file(role).unwrap_or_else(|| panic!("no {role} file"));
        assert_eq!(file.sha256.len(), 64);
        assert!(file.size > 0);
    }
}

#[test]
fn an_empty_folder_reports_every_file_missing() {
    let models = tempfile::tempdir().unwrap();
    let model = active_model();
    let status = status(models.path(), model);
    assert!(!status.installed);
    assert!(!status.runtime_installed);
    assert_eq!(status.model_size, model.files.iter().map(|file| file.size).sum::<u64>());
    if status.supported {
        // Model files + ONNX Runtime library of the face release.
        assert_eq!(status.files.len(), model.files.len() + 1);
        assert!(status.missing_size > status.model_size);
    }
    assert!(Path::new(&status.directory).ends_with(Path::new("semantic").join(&model.id)));
    assert!(installed_paths(models.path(), model).is_err());
}

#[test]
fn a_file_of_the_wrong_size_is_not_installed() {
    let models = tempfile::tempdir().unwrap();
    let model = active_model();
    let dir = model_dir(models.path(), model);
    fs::create_dir_all(&dir).unwrap();
    for file in &model.files { fs::write(dir.join(&file.local), b"not the model").unwrap(); }
    assert!(status(models.path(), model).files.iter().all(|file| !file.installed));
}

#[test]
fn deleting_the_model_keeps_the_runtime_and_other_files() {
    let models = tempfile::tempdir().unwrap();
    let model = active_model();
    let dir = model_dir(models.path(), model);
    fs::create_dir_all(&dir).unwrap();
    for file in &model.files { fs::write(dir.join(&file.local), b"x").unwrap(); }
    fs::write(dir.join("text.onnx.part"), b"partial").unwrap();
    fs::write(models.path().join("onnxruntime.dll"), b"runtime").unwrap();
    delete_model_files(models.path(), model).unwrap();
    assert!(!dir.exists(), "the empty model folder is removed");
    assert!(models.path().join("onnxruntime.dll").is_file(), "the shared ONNX Runtime library stays");

    // A file the manifest does not list keeps the folder.
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("user notes.txt"), b"mine").unwrap();
    delete_model_files(models.path(), model).unwrap();
    assert!(dir.join("user notes.txt").is_file());
    // Deleting again is not an error.
    delete_model_files(models.path(), model).unwrap();
}

#[test]
fn the_text_model_gets_time_for_a_slow_link() {
    assert_eq!(body_timeout(1_000), BODY_TIMEOUT);
    // 565 MB at 1 Mbit/s: over an hour.
    assert!(body_timeout(564_862_230) > Duration::from_secs(3600));
}
