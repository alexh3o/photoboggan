<!-- verified: a9ca28f | sources: src-tauri/src/test_support.rs, .github/workflows/tests.yml, src-tauri/Cargo.toml -->
# Testing

## Purpose
The only automated tests are Rust unit and integration tests of the backend. They exist to catch regressions in the places where a bug damages the user's files or catalogue (metadata writes, sidecars, atomic replacement, scan and sync, cache names, duplicate hashes, updates). There is no frontend test suite and the IPC commands themselves are not tested (they need a Tauri `AppHandle` / `State`): logic that must be tested lives in plain functions that tests can call. The per-module inventory is generated: `generated/tests.md` (293 tests, 20 ignored at the time of writing). The rules are AGENTS.md §5.I.

## Files
| File | Role |
|---|---|
| `src-tauri/src/tests/<module>.rs` | One test file per tested module, included at the end of the module with `#[cfg(test)] #[path = "tests/<module>.rs"] mod tests;` (nothing is compiled into the app). Exceptions: `face_detect.rs`, `face_recognize.rs` and `faces.rs` still hold an inline `#[cfg(test)] mod tests` (9 tests, listed in `generated/tests.md`); move them to `tests/` when editing those modules |
| `src-tauri/src/tests/fixtures/` | Small data files (5), including `semantic_reference.json`, the reference output of the SigLIP 2 model used by ignored parity tests |
| `src-tauri/src/test_support.rs` | Helpers compiled only for tests: synthetic images and a temporary catalogue |
| `.github/workflows/tests.yml` | CI: runs the tests on every push to `main` and every pull request |
| `src-tauri/Cargo.toml` | `tempfile` is the only `[dev-dependencies]` entry (AGENTS.md §4.7: add nothing else without a need) |

## How it works

### Commands (from the repository root; run Rust ones in `src-tauri`)
```bash
cd src-tauri && cargo test                     # fast set, about a second of run time (compilation is longer)
cd src-tauri && cargo test <module>::          # one module, e.g. keywords::
cd src-tauri && cargo test exiftool:: -- --ignored --test-threads=1   # ExifTool integration (bundled copy or PATH)
cd src-tauri && cargo test skipped_exif -- --ignored                  # a global-setting test, run alone
```
- Other ignored tests need something the fast set must not depend on: `SEMANTIC_MODEL_DIR=<folder with vision.onnx, text.onnx, tokenizer.json> cargo test semantic:: -- --ignored` (4 in `semantic.rs`, 1 in `semantic_search.rs`, ignore reason "needs the SigLIP 2 model"; ONNX Runtime from `ORT_DYLIB_PATH`; usage in each file's header comment). The other ignored tests of `semantic_keywords.rs` / `semantic_search.rs` are speed measures or need a catalogue copy (`SEMANTIC_CATALOG`); benchmarks need a real photo or folder (`PHOTOBOGGAN_BENCH_PHOTO`, `PHOTOBOGGAN_BENCH_DIR`, run with `--release --nocapture`, see the doc comments of `marking_check_cost` and `move_cost`).
- ExifTool prerequisites: `npm run fetch-exiftool` puts the pinned version in `src-tauri/vendor/exiftool/`; on Linux / macOS the system `perl` must exist.
- The CI (`tests.yml`) runs on `ubuntu-22.04` and `windows-latest`: it builds the frontend first (`npm run build`: Tauri checks at compile time that `frontendDist` exists), installs the same Linux system libraries as the release workflow, runs `cargo test`, and on Windows only fetches ExifTool and runs `cargo test exiftool:: -- --ignored --test-threads=1`. The other ignored tests (global-setting test of `exif.rs`, benchmarks, model tests) are not run by CI.
- A test that fails after being ignored documents a known gap: report it, never weaken the assertion to "fix" it (AGENTS.md §5.I).

### Helpers (`test_support.rs`)
`jpeg_bytes(w, h)` and `png_bytes(w, h)` (synthetic gradients, never a real photo), `scan_data` (the bytes after the JPEG SOS marker: must be identical before and after a metadata write), `with_segment` (insert an APPn segment), `decoded_pixels`, `contains`, `paths` (keyword paths), `temp_catalog()` (a real catalogue through `db::init_db` in a `tempfile` folder: same schema and pragmas as the app, deleted when dropped) and `insert_photo`. Further helpers in the same file build synthetic pictures for the similarity and semantic tests. Tests create files only in a `tempfile` folder; no network, no face or semantic model in the fast set.

### What each group protects
| Risk | Test file (key tests) |
|---|---|
| Pixels untouched, atomic writes, sidecar choice, markings, IPTC, regions, GPS | `tests/exif.rs` (46) |
| ExifTool writes, recovery after a failed write (never delete the only copy), per-file lock | `tests/exiftool.rs` (19, mostly ignored) |
| Catalogue: WAL, schema upgrade, paging, sort, prefilter = superset of the JS filters, folder removal | `tests/db.rs` (15) |
| Scan, sync (never trusts a missing disk), resume, unreadable files | `tests/library_sync.rs` |
| Keyword tree and links | `tests/keywords.rs` |
| Cache names, subfolders, cache follows rewritten files, durable copy, sidecar adoption at the destination | `tests/main.rs` |
| Orientation algebra and rotation | `tests/orientation.rs`; HEIC container: `tests/heif.rs`; RAW / DNG / CR3 previews: `tests/thumbnails.rs` |
| Duplicates and similar images, perceptual hash | `tests/duplicates.rs`, `tests/similar.rs`, `tests/phash.rs` |
| Integrity check | `tests/integrity.rs` |
| Albums, geolocation backup, place search, private zones | `tests/albums.rs`, `tests/geolocation.rs`, `tests/place_search.rs`, `tests/private_maps.rs` |
| Semantic search (index, search, keyword suggestions, model files) | `tests/semantic*.rs` |
| Update logic and download verification | `tests/update_check.rs` |
| Faces: database, detection settings, alignment | `tests/faces_db.rs`; inline tests of `faces.rs`, `face_detect.rs`, `face_recognize.rs` |

### Known gaps (covered only by hand)
- All frontend code (grid layout, selection, dialogs, task queue, write circuit, panels).
- IPC commands and anything needing an `AppHandle` / `State`: `run_scan`, `run_write` (keywords), `update_photos_marking`, `rotate_photos`, `delete_photos`, `rename_*`, `get_photos_paginated` wrapper, config load / save.
- Real-world files: tests use synthetic files; vendor-specific RAW, HEIC and video behaviour is checked by hand on real photos.
- Network code (releases, model downloads, place search, map tiles), `install_update`, `has_trash`.
- The `resize.rs` module has no test file.
- `tests/faces_db.rs` is included from `faces.rs` (`mod db_tests`), not from a `faces_db` module.

## Contracts
- IPC / events / database / settings: none (tests do not touch the app's data folders).

## Dependencies
- Uses: every tested module's plain functions; `tempfile`.
- Used by: CI (`tests.yml`), and the developer before each commit (AGENTS.md §4.11).

## Invariants and sensitive areas
- ⚠ sensitive: global state. `sync_library` has a global `RUNNING` flag; ExifTool, read priorities and `skip_exif` are Rust statics. Only one test may exercise each, and a fast test must never change the global writer setting (it would break parallel tests): such tests are `#[ignore = "…"]` and run alone.
- Internal-writer tests call the internal functions (`write_jpeg_metadata`, `write_xmp_sidecar_with`…): the `write_metadata` dispatcher depends on the global ExifTool setting.
- Never use a real photo and never the network.

## How to extend
1. Mandatory: any fix touching metadata writing, the database or synchronisation comes with a test that would have caught it (AGENTS.md §5.I).
2. New module: add `tests/<module>.rs`, and at the end of the module `#[cfg(test)] #[path = "tests/<module>.rs"] mod tests;`; build files with `test_support` and a `tempfile` folder.
3. Slow or tool-dependent test: `#[ignore = "reason"]` and document the command in the file's header comment.
4. Refresh the inventory with `npm run docs:gen`.

## Open questions
none. Note: `cargo test` does not build the frontend; Tauri checks at compile time that `frontendDist` (`dist/`) exists, so run `npm run build` once before the first local `cargo test` (CI does the same).
