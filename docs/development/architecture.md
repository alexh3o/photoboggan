<!-- verified: feb7ab6 | sources: src-tauri/src/main.rs, src-tauri/src/db.rs, src/main.js, src-tauri/tauri.conf.json, index.html, src-tauri/src/face_models.rs, src/metadata-writes.js -->
# Architecture

## Purpose and philosophy

photoboggan is a desktop photo browser that works **in place**: the folders on disk are the only source of truth, the SQLite catalogue and the image caches are rebuildable copies, and user edits (rating, keywords, title, faces, GPS…) are written back into the files or their `.xmp` sidecars so that other tools see them. It must run without Internet: every network access is optional and can be refused globally (offline mode). The rules every change must respect are in `../../AGENTS.md`; the cross-cutting ones are explained in `invariants.md`.

## Process model

| Piece | Where | Role |
|---|---|---|
| Tauri v2 shell | `src-tauri/src/main.rs` (`fn main`) | One window, label `main`, created hidden and undecorated (`tauri.conf.json`). Plugins: single-instance (registered first: a second launch only refocuses the window), opener, dialog. |
| Rust backend | `src-tauri/src/*.rs` | All file, database, decoding and network work. Exposed to the UI as `#[tauri::command]` functions registered in `generate_handler!` (`fn main`). Full list: `generated/ipc-commands.md`. |
| Webview frontend | `index.html` + `src/*.js` (vanilla ES modules, bundled by Vite) | All UI and UI state. Talks to the backend with `invoke` only; reads image files directly through the asset protocol (`convertFileSrc`, scope `**`). |
| ExifTool | child processes, `exiftool.rs` | Default metadata writer. Up to `MAX_PROCESSES` (3) persistent `-stay_open` processes, closed after `IDLE_TIMEOUT`. Bundled from `src-tauri/vendor/exiftool/` (resource `exiftool/`). |
| SQLite | `<data dir>/photos_library.db`, `db.rs` | WAL mode, one r2d2 pool (`AppState.db_pool`, behind a `RwLock` because `change_storage_location` swaps it). |
| ONNX Runtime | `onnx_runtime.rs`, crate `ort` with `load-dynamic` | Face detection/recognition and semantic search models, loaded only when those features are used. |

Startup (`fn main` → `.setup`): `exiftool::init` and `private_maps::init_bundled_style` get the resource directory; `resolve_app_paths` picks the data directory (default, or `custom_data_dir` from `config.json`); `db::init_db` creates/migrates every table; the thumbnail size and quality come from `config.json`; the window geometry is restored (`restore_window_state`); `AppState` is managed. The frontend shows the window after its first styled paint (`main.js`, `DOMContentLoaded` + two animation frames); a thread in `.setup` shows it anyway after 10 s.

## Functional blocks and how they talk

```
             ┌──────────────────────────── webview (src/) ─────────────────────────────┐
             │ main.js: grid, viewer, selection, sort, filters, task queue, startup    │
             │   ├─ panels: keywords-panel, description-panel, faces-*, albums-panel,   │
             │   │          location-panel, histogram, semantic*, duplicates*           │
             │   ├─ metadata-writes.js  (single write circuit for the right panel)      │
             │   └─ photo-actions.js    (context menus, dialogs, copy/move/resize UI)   │
             └───────────────┬─────────────────────────────▲──────────────────────────┘
                     invoke (IPC)                 events "scan-progress", "scan-detail"
             ┌───────────────▼─────────────────────────────┴──────────────────────────┐
             │ main.rs: AppState, config.json, cache paths, scans, file operations    │
             │ library_sync · db · keywords · exif/exiftool/heif/orientation          │
             │ thumbnails/video · faces/face_* · semantic* · duplicates/similar/phash │
             │ albums · geolocation · private_maps/place_search · update_check        │
             └──────┬──────────────────┬──────────────────────┬──────────────────────┘
                 SQLite          files on disk          network (ureq, gated)
```

- **IPC**: every frontend → backend call is `invoke('<command>', {camelCaseArgs})`. Who calls what: `generated/ipc-commands.md`; static module dependencies: `generated/module-deps.md`.
- **Events**: the backend only emits progress. `scan-progress` (`{task_id, percent}`) is used by every queued task; `scan-detail` by the integrity check. Both are listened to once, in `main.js` (`listenToBackend`). See `generated/events.md`.
- **Dependency injection in the frontend**: feature modules do not import `main.js` services; `main.js` passes them at init (e.g. `initMetadataWrites(hostApi)`, `initPrivateZonesModal({ enqueueTask, showToast })`). Only `photo-actions.js` imports `main.js` directly.
- **Map tiles** are the one network access made by the webview: `map-tile-protocol.js` serves `pbmap://` URLs to MapLibre and is the only code allowed to fetch `tiles.openfreemap.org` (also allowed by the CSP `connect-src`), after checking `isMapNetworkAllowed()` (map enabled and offline mode off). Private-zone tiles come from the backend (`get_private_tile`).

## End-to-end flows

**1. Add a folder, scan, show the grid**
1. Settings > folders: `main.js` calls `add_folder` (stores the folder, does not scan), then `enqueueScanTask({ kind: 'add', command: 'scan_folder' })`.
2. `scan_folder` → `run_scan` (main.rs): `WalkDir` + `library_sync::is_photo_file` on a blocking thread, `rayon` `par_iter` over the files, `library_sync::read_photo` per file (EXIF/XMP/keywords/faces), results sent through an `mpsc` channel to a writer task that stores batches of 500 (`library_sync::store_read_batch`). Progress → `scan-progress`; stop → `cancel_scan` sets the task's flag.
3. When the task ends, `runScanTask` calls `reloadPhotosAfterRescan`; the grid pages through `get_photos_paginated` and renders with virtual scrolling (`main.js`, section "VIRTUAL SCROLLING").

**2. Thumbnail request**
1. The grid asks `get_cached_thumbnail_paths` for many paths at once; hits are displayed with `convertFileSrc`.
2. Misses call `generate_thumbnail` (at most 6 at a time, `THUMBNAIL_GENERATION_GATE`): `thumbnails::generate_thumbnail` writes the JPEG into the cache (RAW: embedded preview, never demosaiced; HEIC: `heif.rs`; video: one frame, `video.rs`).
3. If the backend fails (e.g. PNG, CMYK JPEG), the webview draws the thumbnail itself and stores it with `save_thumbnail_cache` (data URL).
4. Full screen of RAW / HEIC / video uses `get_raw_preview_path` (separate `raw_previews/` cache).

**3. Metadata write (rating, colour, pick)**: `update_photos_marking` (main.rs) → `keep_cached_images` → `exif::write_xmp_metadata` → `exiftool::write_marking` (ExifTool mode) or internal XMP edit; the marking is re-read (`exif::read_marking`) and any difference (`marking_mismatch`) is reported as a failure, never as written. Rotation follows the same shape (`rotate_photos` → `orientation.rs`).

**4. Keyword / title / description apply**
1. Edits stay pending in the right-panel editors (`registerEditor`, `metadata-writes.js`) until Apply, Ctrl+Enter, a selection change or closing.
2. `applyPending` merges all pending items per photo and calls `runLocked('apply_metadata_changes', …)`: direct `invoke` under 20 photos, a queued task (`kind: 'keywords'`) from 20 (`QUEUE_THRESHOLD`).
3. Backend `keywords::run_write`: one global `WRITE_LOCK`, 3 rayon threads, each file written through `keep_cached_images` → `exif::write_metadata` (or ExifTool), re-read with `exif::read_exif`, compared (`text_mismatch`, `regions_mismatch`, `gps_mismatch`), then the catalogue is updated in one transaction.
4. The frontend shows failures and, via `take_write_recoveries`, any ExifTool recovery (see `invariants.md`).

**5. Duplicate search**: `main.js` (section "DUPLICATES") queues a `kind: 'duplicates'` task calling `find_duplicates`, `find_similar_images` or `list_duplicate_candidates` (name search, computed in JS by `duplicate-names.js`); the task ends `ready` and the grid only switches to results when the user clicks "Show".

**6. Update install**: `update-check.js` → `check_for_update` reads GitHub releases; `download_update` (queued task) re-reads the release, downloads the `.msi`/`.deb` and checks its SHA-256 (`copy_verified`); `install_update` re-checks size and hash, then runs `msiexec` (Windows) or `xdg-open` (Linux).

## Where state lives

| State | Location | Rebuildable? |
|---|---|---|
| User metadata (rating, keywords, title, faces, GPS, orientation) | The image files and `.xmp` sidecars | — (source of truth) |
| Catalogue (photos, keyword tree, albums, persons, zones, hashes, embeddings) | SQLite `photos_library.db` (tables: `generated/db-schema.md`) | Mostly yes, by rescan. **Not** rebuildable: albums, keyword nodes not present in any file, person ↔ keyword links, private zone definitions, erased GPS backups (`geolocation`). ⚠ unverified: complete list, check each `init_schema`. |
| Thumbnails, RAW/HEIC/video previews | `<data dir>/thumbnails/`, `raw_previews/` | Yes (deleted with "Clear cache"; orphans purged by `purge_orphan_cache`) |
| Models | `<data dir>/models/` (faces), `models/semantic/<id>/` | Yes (re-download / import) |
| Offline map tiles | `<data dir>/private_maps/*.mbtiles` | Yes, if online |
| Logs of write recoveries / sidecar conflicts | `<data dir>/logs/` | — |
| App config (data dir, cache size, thumbnail quality, window state, "Open with" programs) | `config.json` in the OS app-config dir (`AppConfig`, written atomically) | Defaults if missing; set aside as `config.json.invalid-<time>` if invalid |
| UI settings | webview `localStorage`, defaults in `src/defaults.jsonc` (`generated/config.md`) | Defaults |
| Backend runtime settings (metadata writer, read priorities, internet allowed, face settings…) | Rust statics, pushed by the frontend at startup and on change | Lost at exit by design: the frontend resends them |
| Downloaded installer | OS temp dir `photoboggan-update/` | Yes |

## Concurrency model

- **Frontend queue** (`main.js`, section "FILE D'ATTENTE DES TÂCHES"): `enqueueScanTask` adds a task; `pumpScanQueue` runs the main queue **one task at a time** in request order; `pumpSemanticQueue` runs the content analysis (`kind: 'semantic'`) in its own lane, in parallel. "Families" (`familyOf`) only decide which tasks are refused as duplicates of a running/waiting one (same folder covered, same `dedupeKey`); they do not run concurrently. Each task gets a unique id passed to the backend as `taskId`.
- **Backend cancel**: `scan_cancel_flag(task_id)` creates or returns an `Arc<AtomicBool>`; `cancel_scan` sets it; the command calls `release_scan_cancel_flag` at the end.
- **Threads**: commands are `#[tauri::command(async)]` / `async fn` (Tauri async pool) and push heavy work into `tokio::task::spawn_blocking`, often with `rayon` inside. Plain `#[tauri::command] fn` runs on the main thread (marked "main thread" in `generated/ipc-commands.md`): keep those trivial.
- **Throttles**: thumbnail generation 6 at once; keyword writes 3 threads; incremental sync reads EXIF with 2 threads at most (`library_sync.rs` header); ExifTool 3 processes; `semantic::PriorityGuard` makes the semantic analysis pause while thumbnails are generated, a scan runs or metadata is written.
- **Per-file write lock**: `exiftool::path_lock` (16 striped mutexes) serialises writes to the same image, for both writers.

## Offline mode and network rule

`offlineMode` (localStorage) is sent at startup and on change as `set_internet_allowed(!offline)`; the backend flag `INTERNET_ALLOWED` (`face_models.rs`) starts **false**. Every backend download checks `internet_allowed()` and returns the error code `internet_disabled`: face models (before each file), semantic model, place search, private-zone tiles, update check (and therefore update download). All use the `ureq` client. The webview's only network access is the map protocol above, gated by `isMapNetworkAllowed()`. A new network access must follow this rule and be listed in the "Offline mode" tooltip (AGENTS.md §1).
