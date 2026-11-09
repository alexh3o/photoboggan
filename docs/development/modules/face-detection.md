<!-- verified: none | sources: src-tauri/src/face_detect.rs, src-tauri/src/face_recognize.rs, src-tauri/src/face_models.rs, src-tauri/src/model_files.rs, src-tauri/src/onnx_runtime.rs -->
# Face detection, recognition and models

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Detection task: `count_face_scan_targets`, `detect_faces` (queued, kinds `faces` / `faces-selection`, progress `scan-progress`), settings `set_face_settings` / `apply_face_thresholds`; defaults from the `faceSettings` section of `src/defaults.jsonc` (`include_str!`).
- Input images: cached thumbnails (hence the 512 px minimum cache size); face_detect.rs has its own RAW extension list (one of the duplicated lists, see `recipes.md` §4).
- Recognition (face_recognize.rs): `landmarks_from_box`, `align`, `embed`, `similarity`, `dbscan` (grouping unknown faces), `attribute_faces`; called from faces.rs (`recognize_faces`, `cluster_unknown_faces`).
- Models: `face_models.rs` (manifest `face_models.json`, `models_dir` = `<data dir>/models`, `get_face_model_status`, `download_face_models` checks `INTERNET_ALLOWED` before each file, `import_face_models`); `model_files.rs` (`download`, `install_from`, `import_from`, SHA-256 checked, shared with the semantic models and the update check); `onnx_runtime.rs` (dynamic loading of ONNX Runtime, shared with semantic).
- `face_models.rs` also hosts the global offline flag (`set_internet_allowed`, `internet_allowed`) used by every backend network access: document it here and link `architecture.md`.
- Tests: ⚠ check `generated/tests.md` for which of these files have tests; never a real model in fast tests (AGENTS.md §5.I).

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
