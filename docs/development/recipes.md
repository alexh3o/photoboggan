<!-- verified: d1a290d | sources: src-tauri/src/main.rs, src/defaults.jsonc, src/i18n.js, src-tauri/src/exif.rs, src-tauri/src/exiftool.rs, src-tauri/src/db.rs, src/settings-defaults.js, src/main.js, src/format-filters.js, src-tauri/src/library_sync.rs, src-tauri/capabilities/default.json -->
# Maintenance recipes

Ordered checklists for the most common changes. Each recipe names a **traced example** (an existing feature built that way: read it first and copy its shape), the files to touch with the name to search, the test to add and the traps. Rules behind them: `invariants.md`.

## 1. Add an IPC command

Example: `set_thumbnail_quality` (main.rs) called from `main.js` (search `thumbnail-quality-select`).
1. Write the function with `#[tauri::command(async)]` (or `async fn`) in the module that owns the feature. Return `Result<T, String>`; `T: Serialize`. Injected parameters (`State<'_, AppState>`, `tauri::AppHandle`) are free.
2. Heavy work (disk, decoding, database loops): wrap it in `tokio::task::spawn_blocking`, see `generate_thumbnail`.
3. Register it in `generate_handler![…]` in `fn main` (main.rs), next to its module's other commands. Forgetting this compiles fine and fails only at `invoke` time.
4. Call it from JS: `invoke('my_command', { camelCaseArg })`. Rust `snake_case` arguments are passed in camelCase (`max_side` → `maxSide`).
5. Errors meant for the user: return a stable code (`"internet_disabled"`, `"invalid_name"`) and translate it in JS (e.g. `update-check.js` maps `internet_disabled` to a message). Raw French/English strings reach the user as-is.
6. Test the inner function (not the command) in `src-tauri/src/tests/<module>.rs`; IPC is not tested (AGENTS.md §5.H).
7. Run `npm run docs:gen`: the command appears in `generated/ipc-commands.md`.
- Trap: plain `#[tauri::command] fn` runs on the main thread and freezes the window while it works (listed as "main thread" in `generated/ipc-commands.md`). Several old commands (`get_folders`, `cancel_scan`, `set_internet_allowed`) are deliberately trivial.
- Trap: app commands need no entry in `capabilities/default.json` (it only lists core and plugin permissions); a new **core / plugin** API used from JS (window, dialog, opener…) does (e.g. `core:window:allow-destroy` for closing).

## 2. Add a remembered setting

Examples: `keywordsAutoApply` (frontend only, `metadata-writes.js`), `thumbnailQuality` (frontend + backend + `config.json`), `offlineMode` (frontend, pushed to the backend at startup).
1. `src/defaults.jsonc`: add the key (= localStorage key) with its default, possible values in a **full-line** comment above it (inline comments break both parsers).
2. Read it with `readBool` / `readChoice(key, allowed)` / `readNumber(key, min, max)` from `settings-defaults.js`; never hard-code the default.
3. UI control: in `index.html` (Settings modal `#settings-modal`, one `settings-tab-…` per tab), wired in the owning module (or `main.js`, section "MODALE PARAMÈTRES"); save with `localStorage.setItem(key, String(value))`.
4. Labels: `data-i18n` keys in `en.json` and `fr.json` (recipe 7).
5. Backend needs it? Add a setter command (recipe 1) and call it **at startup and on change** (see `offlineMode` → `set_internet_allowed` in main.js). Backend statics reset at every launch.
6. Backend needs it **before the UI loads** (e.g. thumbnail quality for the first thumbnails)? Store it also in `config.json`: field in `AppConfig` (`#[serde(default)]`), read in `.setup`, written by the setter with `load_config` + `save_config` (see `set_thumbnail_quality`).
7. Face detection settings are the exception: section `faceSettings` of `defaults.jsonc`, also read by Rust (`face_detect.rs`, `include_str!`).
- Trap: `npm run docs:gen` lists it in `generated/config.md`; a key absent from `defaults.jsonc` reads as `undefined`.

## 3. Add a metadata field to write

Example: **title** (`MetadataUpdate.title`). Read `invariants.md` §1–2 first.
1. Data path: `KeywordWriteItem` (keywords.rs) → `MetadataUpdate` (exif.rs) → both writers. Add the field to both structs and to `MetadataUpdate::adds_values` (it decides whether a missing sidecar is created).
2. **Internal writer** (exif.rs): XMP in `update_xmp_all` (title: `update_xmp_texts`, `XMP_TITLE_PROPERTIES`); for JPEG also IPTC in `write_jpeg_metadata` (`IptcChanges`, truncated with `truncate_utf8`).
3. **ExifTool writer** (exiftool.rs): `metadata_args` (title: `XMP-dc:Title` lang-alt, `XMP-acdsee:Caption`, JPEG `IPTC:ObjectName` 64 bytes, `EXIF:XPTitle`). Update the doc comment of `exiftool::write_metadata`.
4. **Reading**: sources and priority (`TITLE_SOURCE_IDS`, `TITLE_PRIORITY`, `set_read_priority`) and `read_exif`; a new catalogue column if it is shown or filtered (recipe 5).
5. **Verification after write**: extend `text_mismatch` (or add a `*_mismatch`) so a value the file did not keep is a failure.
6. **Frontend**: pending value in the editor (`description-panel.js` for title), sent through `applyPending` / `apply_metadata_changes` (`metadata-writes.js`). Never write outside that circuit.
7. Tests: internal path in `tests/exif.rs` calling `write_jpeg_metadata` / `write_xmp_sidecar_with` directly (e.g. `empty_title_and_description_remove_them`); ExifTool path in `tests/exiftool.rs` with `#[ignore = "intégration : lance ExifTool"]`. Never toggle the global writer setting in a fast test.
- Trap: forgetting one writer gives files that differ by setting; AGENTS.md §5.C requires both.

## 4. Add a file format

Lists to update (search the extension `"cr2"` to find them all, there is no single list):
1. Backend catalogue: `SUPPORTED_EXTENSIONS` (library_sync.rs) for standard formats; videos: `VIDEO_EXTENSIONS` (video.rs, also used by duplicates.rs).
2. RAW: the single backend list `thumbnails::RAW_EXTENSIONS` (`is_raw_extension`, `is_raw_path`), used by the catalogue, previews, faces, resize and content search.
3. Frontend: `RAW_EXTENSIONS` / `HEIF_EXTENSIONS` / `VIDEO_EXTENSIONS` / `RASTER_EXTENSIONS` (format-filters.js), used by `isRawPath` / `isVideoPath` (main.js).
4. Thumbnail: `thumbnails::render_thumbnail` must decode it, or return an error so the webview fallback (`save_thumbnail_cache`) is used. Full screen: if the webview cannot show it, route it through `get_raw_preview_path`.
5. Metadata target: `exif::write_metadata` / `exiftool::target_of` decide in-file vs sidecar; a new non-JPEG format defaults to a sidecar.
6. Duplicates: decide which bytes `duplicates::layout_of` hashes; changing it requires `LAYOUT_VERSION` + 1.
7. Integrity check (`integrity.rs`) and resize (`resize.rs`): check what they do with the extension.
8. Tests `supported_extensions_ignore_case_and_sidecars` (library_sync) and `raw_extensions_match_the_frontend` (thumbnails: backend and frontend RAW lists must be equal); the user-facing list of formats is `docs/USER_GUIDE.md`.

## 5. Add a database column or table

Example: column `flash` of `photos`.
1. Column: `add_column(&conn, "photos", "flash INTEGER")` at the end of the list in `init_db` (db.rs), with a comment. Never `ALTER` another way, never drop or rename.
2. Table: `CREATE TABLE IF NOT EXISTS` in the owning module's `init_schema`, called from `init_db` (see `crate::duplicates::init_schema`). Empty until the feature is used (AGENTS.md "zero cost at rest").
3. `Photo` struct (db.rs, `#[serde(default)]` if optional), `PHOTO_COLUMNS` and `photo_from_row` (same order!), the insert / upsert `insert_batch` (main.rs, called by `library_sync::store_read_batch`), the read `library_sync::read_photo`.
4. Filterable? `PhotoPrefilter` and its SQL in db.rs (see `filter.flash`), plus the JS side (recipe 6).
5. Existing photos need a rescan to fill it: say so in the release notes / UI.
6. Test in `tests/db.rs` with `test_support` (temporary catalogue); `npm run docs:gen` updates `generated/db-schema.md`.
- Trap: `PHOTO_COLUMNS` order and `photo_from_row` indices must match; a shift silently mixes fields.

## 6. Add a filter

Example: flash filter (`shooting-filters.js`).
1. UI and state in a filter module: `capture()` / restore of its state (smart albums save it: `main.js`, section "ALBUMS INTELLIGENTS"), `matches…State(photo)` used by `applyPhotoFilters` (main.js).
2. Large catalogues are prefiltered in SQL: `shootingPrefilter` → `PhotoPrefilter` (db.rs). Both sides must give the same result.
3. Filter chips and include / exclude menus: `filter-tags.js`; autocomplete: `filter-suggest.js`.

## 7. Add a translation key, a modal, a panel, a toolbar button

1. Text: English key in `src/locales/en.json` **and** French in `fr.json`. HTML: `data-i18n="Key"` (content) or `data-i18n-title` / `-aria-label` / `-placeholder` / `-alt`. JS: `t('Key', {param})`, plurals `tp('Key', count)` with a `Key|other` entry, labels with colon `labelWithColon('Key')`. Text built in JS must be rebuilt on `onLanguageChange`.
2. Modal / panel / button: DOM in `index.html`, styles in the feature's CSS (rem except fine borders, AGENTS.md §5.A; see `style.md`), behaviour in the feature module with an `init…` function called by `main.js`. Reuse `keepFocusInModal` and `choiceDialog` (`metadata-writes.js`) for focus trapping and simple choices.
- Trap: a missing French key silently shows English (`t` falls back to `en` then to the key).

## 8. Add a long task to the queue

Example: integrity check (`checkFolderIntegrity` in main.js → `integrity_scan` in main.rs).
1. JS: `enqueueScanTask({ kind, path, command, args, labelKey, labelParams, onResult, dedupeKey })` (main.js). Modules receive it as an injected `enqueueTask`. Add the kind to `familyOf` if it must not be refused as a duplicate of scans.
2. Rust command takes `task_id: String`; `let cancel = crate::scan_cancel_flag(&task_id);`; work in `spawn_blocking`, checking `cancel` between items; progress with `app.emit("scan-progress", ScanProgress { task_id, percent })`; `crate::release_scan_cancel_flag(&task_id)` at the end, also on error.
3. A stop must leave no half-written output (see `download_face_models`: "cancelled" is not an error, nothing installed).
4. Result handling in `onResult(result, stopped, error, task)`; translate error codes.
- Trap: the main queue runs one task at a time; a task that never resolves blocks every scan.

## 9. Add a backend event

Only `scan-progress` and `scan-detail` exist; prefer reusing them with a `task_id`.
1. Rust: `app.emit("event-name", payload)` with a `#[derive(Clone, serde::Serialize)]` payload (see `ScanDetail`, main.rs).
2. JS: one `listenToBackend('event-name', handler)` (main.js, next to `scan-detail`); dispatch to modules from there.
3. `npm run docs:gen` lists it in `generated/events.md`.
