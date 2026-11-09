<!-- verified: a9ca28f | sources: src-tauri/src/face_detect.rs, src-tauri/src/face_recognize.rs, src-tauri/src/face_models.rs, src-tauri/src/model_files.rs, src-tauri/src/onnx_runtime.rs, src-tauri/face_models.json -->
# Face detection and recognition (detector, embeddings, models)

## Purpose
Finds faces in photos (YuNet), computes a 128-value fingerprint for each (SFace), and proposes a person by comparing fingerprints with already confirmed faces. Also hosts the download / import of the ONNX models and ONNX Runtime library, and the **global offline flag** (`INTERNET_ALLOWED`) that every other network access of the backend reads. What happens to the faces afterwards (review, writing to files) is in `faces.md`.

## Files
| File | Role |
|---|---|
| `face_detect.rs` | `FaceSettings` and thresholds, orientation helpers (`orient_rect`, `inverse_orientation`, `iou`), YuNet inference (`detect`), quality measures, target selection, `detect_faces` task, `store_detections`. |
| `face_recognize.rs` | Alignment on the SFace template (`align`), `embed`, `attribute_faces`, `dbscan`, embedding blobs. |
| `face_models.rs` | Manifest `face_models.json` (embedded), platform files, status, download, import, **`INTERNET_ALLOWED`** and `set_internet_allowed`. |
| `model_files.rs` | Generic verified install / download / import of a model file (also used by `semantic_models.rs`; `update_check.rs` has its own hash check). |
| `onnx_runtime.rs` | Shared ONNX Runtime environment and `background_session` (used by the semantic search). |
| `face_models.json` | Pinned release `face-models-1`: detector, recognizer, runtime library per platform: asset name, size, SHA-256, licence. |

## How it works

**Models.** Three files in `<data dir>/models/`: `face_detection_yunet_2023mar.onnx` (MIT), `face_recognition_sface_2021dec.onnx` (Apache-2.0), and the ONNX Runtime library (`onnxruntime.dll` on windows-x86_64, `.so` on linux-x86_64; other platforms: `faces_unsupported_platform`). They are not in the installer.
1. `get_face_model_status` lists files and the missing size.
2. `download_face_models` (queued task, `kind: 'face-models'`, `scan-progress`): for each missing file, checks `INTERNET_ALLOWED` **before the file** (else `internet_disabled`), then `model_files::download`.
3. `model_files::install_from` streams into `<name>.part`, checks size and SHA-256, then renames. A partial or corrupt file is never seen as installed; cancel removes the `.part`.
4. `import_face_models(directory)` (no Internet): `model_files::import_from` looks for the release name, then the local name, and verifies the same way.
5. `installed_paths` returns `face_models_missing` when a file is absent or has the wrong size (the hash is only checked at install).

**Detection task** (`detect_faces`, queued `kind: 'faces'`, args `photoIds` or `folder` + `recursive`, `onlyUnscanned`, `taskId`; `scanRaw` setting includes RAW):
1. `select_targets` picks photos (videos excluded; RAW only if `scanRaw`) and says which are already scanned (current `DETECTOR_ID` and recognition `MODEL_ID`, not `needs_review`, and no drawn region lacking a fingerprint). `count_face_scan_targets` feeds the dialog.
2. A `semantic::PriorityGuard` pauses the semantic scan; the ONNX environment and the two sessions are created for the task and dropped at its end (memory); the environment itself stays for the process.
3. Photos go by chunks of 24: `analyse` reads the **cached thumbnail** (generated and kept if missing, `thumbnails::generate_thumbnail`), runs YuNet on it (scaled to 640×640 with black padding), measures confidence, sharpness (Laplacian variance of the face resized to 112 px) and size, converts rect and 5 landmarks back to the **stored-image frame** (`inverse_orientation`), and computes the embedding. Faces smaller than 96 px in the thumbnail get their fingerprint from the original (`EmbeddingSources`).
4. `store_detections` runs in one transaction per photo (a failure only marks that photo in `report.failed`): a detection matching an existing face (IoU ≥ 0.5, or similarity ≥ 0.80 on a `needs_review` photo) keeps its identity and state and receives measures + embedding; imported / manual / confirmed / ignored faces are always kept; unconfirmed `detected` faces without match are replaced; new ones start `unknown`, or `filtered` under the thresholds. Existing faces without fingerprint (imported regions, drawn ones) get one (`pending_embeddings`).
5. After the loop `attribute_faces` runs on the scanned photos; the report gives scanned / faces / auto / suggested / failed / cancelled. Cancel (`cancel_scan` flag) stops between chunks; processed photos stay saved.

**Why 512 px minimum.** The thumbnail cache is the detector input (already oriented, always current: the cache is keyed by path, size and mtime). The cache resolution setting (512 / 768 / 1024) has a floor of 512 because below it faces become too small to detect; see AGENTS.md §5.A.

**Recognition** (`face_recognize.rs`):
1. `align`: least-squares similarity maps the 5 YuNet landmarks onto the 112×112 SFace template, bilinear resampling; `None` if landmarks are degenerate or less than 75 % of the aligned face lies inside the image.
2. `embed`: SFace on RGB 0–255, 128 floats, normalised; similarity = dot product. Stored as a blob (`embedding_blob`) with `model_id`: fingerprints of another model are ignored everywhere.
3. `attribute_faces`: references = confirmed faces of non-hidden persons (from 10 faces, k-means centroids, at most 5). For each `unknown` / `suggested` / `auto` face that is not `unknown_locked`: best similarity s1 per person (skipping `rejected_person_id`), runner-up s2. `auto` if s1 ≥ auto threshold and s1 − s2 ≥ margin; `suggested` if s1 ≥ suggestion threshold; else `unknown`. It never touches `dirty`: auto faces are not written until confirmed.
4. `dbscan` groups unknown faces (used by `cluster_unknown_faces`).

**Thresholds.** `FaceSettings` (min size ‰, confidence, sharpness, auto, suggestion, margin, `scanRaw`) default from the `faceSettings` section of `src/defaults.jsonc`, read by Rust with `include_str!` (full-line `//` comments only). The UI sends them with `set_face_settings` at startup and on change; until then the defaults apply. `apply_face_thresholds` reclassifies detected, unattributed faces between `unknown` and `filtered` without a rescan.

**Offline flag.** `INTERNET_ALLOWED` starts `false`; `offlineMode` in the UI calls `set_internet_allowed`. `internet_allowed()` is read by place search, private-zone downloads, semantic models and update check as well (see `architecture.md`, "Offline mode").

## Contracts
- IPC commands: `detect_faces`, `count_face_scan_targets`, `set_face_settings`, `apply_face_thresholds`, `get_face_model_status`, `download_face_models`, `import_face_models`, `set_internet_allowed` (signatures in `generated/ipc-commands.md`).
- Events: `scan-progress` (detection and model download).
- Database: writes `faces` (embedding, landmarks, measures, `model_id`) and `photo_face_scans`; reads `photos`, `persons`.
- Settings: `faceDetection`, `faceSettings`, `faceScanSubfolders`, `offlineMode`; see `generated/config.md`. Error codes: `internet_disabled`, `face_models_missing`, `faces_unsupported_platform`.

## Dependencies
- Uses: thumbnails (`thumbnail_cache_file`, `generate_thumbnail`), `faces.rs` (`in_transaction`), `exif.rs` through the orientation stored in `photos`, `semantic::PriorityGuard`.
- Used by: `faces.rs` (thresholds, `iou`, `attribute_faces`), `exif.rs` (`orient_rect`), every network module (`internet_allowed`), `semantic_models.rs` (`runtime_file`, `model_files`).

## Invariants and sensitive areas
- ⚠ sensitive: changing `DETECTOR_ID` or `MODEL_ID` rescans everything (scan status compares them); a changed model needs a new id, or old fingerprints get compared with new ones.
- ⚠ sensitive: stored coordinates are in the stored-image frame; the thumbnail is oriented. Every conversion goes through `orient_rect` / `inverse_orientation` (test `orientation_round_trip`).
- ⚠ sensitive: `INTERNET_ALLOWED` must default to false, and the frontend must send it before any download.
- Models are never written inside photo folders. A file is installed only after its SHA-256 matches.
- Defaults must stay in `defaults.jsonc`; test `default_face_settings_come_from_the_shared_file_and_are_in_range` guards the parse.

## Tests
Inline `mod tests` (an exception to AGENTS.md §5.H, listed in `generated/tests.md`) in `face_detect.rs` (orientation round trip, defaults file, every key the frontend reads) and `face_recognize.rs` (alignment identity, blob round trip); `tests/faces_db.rs` for the database side. No test runs the models, downloads, `attribute_faces` or `select_targets`.

## How to extend
1. New recognition model: new manifest entries and release assets (`scripts/prepare-face-models.mjs`), new `MODEL_ID`; old embeddings become unusable by design.
2. New setting: add to `FaceSettings`, `defaults.jsonc`, `THRESHOLD_INPUTS` in `faces-panel.js`, and `locales/`.
3. New platform: add its runtime file to the manifest and `current_platform`.

## Open questions
none. Known limit: an installed file is recognised by name and size only (`model_files::is_installed`); the SHA-256 is checked at install, never at load, so a file corrupted later with the same size fails only when the ONNX session is created.
