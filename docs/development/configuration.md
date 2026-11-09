<!-- verified: 36a5686 | sources: src/defaults.jsonc, src/settings-defaults.js, src/i18n.js, src-tauri/src/main.rs, src-tauri/src/face_detect.rs, src-tauri/tauri.conf.json, src-tauri/tauri.dev.conf.json -->
# Configuration

Where each kind of setting or data lives, how a setting is read and defaulted, and how backend settings get their value. The key/default table is generated: `generated/config.md` (never copy it). Step-by-step for adding a setting: `recipes.md` §2. Application shell code (config file, storage move): `modules/app-shell.md`.

## The four places a value can live

| Place | What | Lifetime | Written by |
|---|---|---|---|
| **Image files / `.xmp` sidecars** | Rating, colour, pick, keywords, title, description, faces, GPS, orientation | Permanent, source of truth | Metadata writers (`architecture.md` "Where state lives") |
| **SQLite catalogue** `<data dir>/photos_library.db` | Photo index, keyword tree, albums, persons, private zones, hashes, embeddings | Permanent, mostly rebuildable by rescan (albums are not) | `db.rs` and feature modules |
| **`config.json`** (OS app-config dir, struct `AppConfig` in `main.rs`) | `custom_data_dir`, `thumbnail_cache_size`, `thumbnail_quality`, `window_state`, `open_with_programs` | Permanent | Backend commands only (`save_config`, atomic write) |
| **Webview `localStorage`** | Every other UI preference (layout, sort, panels, language, theme, feature switches…) | Permanent per webview profile | Frontend |
| **Backend statics** (Rust `static`s) | Metadata writer and ExifTool path, read priorities, offline flag, face settings, semantic enabled, cross-drive move check | **Until exit**: the frontend resends them at each launch | Setter IPC commands |

Why `config.json` exists: its values are needed before the webview loads (database location, cache size and quality for the first thumbnails, window rectangle), and the data directory cannot be stored inside the database it locates. Why `localStorage` otherwise: no round trip, trivial to read synchronously in the UI. Details of `config.json` handling (invalid file set aside as `config.json.invalid-<seconds>`, never overwritten by defaults): `modules/app-shell.md`.

## Data locations (per user)
- **Data directory** (`AppDataPaths`): default `<app local data dir>/data` (`default_data_directory`), or the folder stored in `config.json` (`custom_data_dir`). Contents: `photos_library.db` (+ `-wal`, `-shm`), `thumbnails/`, `raw_previews/`, `models/` (face models, `models/semantic/<id>/`), `person_covers/`, `private_maps/` (MBTiles), `logs/`. The user changes it in Settings > Storage (`change_storage_location`): the whole set (`STORAGE_FILES`, `STORAGE_DIRS` in `main.rs`) is copied then the old one removed; `logs/` is not in that set and stays in the old folder. A legacy `photos_library.db` in the working directory is moved at first start.
- **Config directory** (`app_config_dir`): `config.json` only.
- **OS temp dir**: `photoboggan-update/` (downloaded installer), `photoboggan-frame-<pid>-<n>.jpg` (video frame extraction temp files).
- **Bundled resources** (read-only, from `tauri.conf.json` `bundle.resources`): `exiftool/` (from `src-tauri/vendor/exiftool/`, not versioned) and `map-style/`.
- Not stored locally by the app: model files and ONNX Runtime are downloaded into the data directory on demand (never in the installer).

## localStorage settings: read, default, write
1. **Default**: `src/defaults.jsonc` (key = localStorage key; possible values in a **full-line** `//` comment above the key; inline comments are forbidden because both parsers only drop full-line comments). `settings-defaults.js` strips those lines and parses it into the frozen `DEFAULTS`.
2. **Read**: `readBool(key)` (`"true"`/`"false"`), `readChoice(key, allowed)`, `readNumber(key, min, max)` return the stored value only if valid, otherwise `DEFAULTS[key]`; `readStored` returns the raw string or `null` and swallows storage errors. Never hard-code a default in a module (AGENTS.md §5.G).
3. **Write**: `localStorage.setItem(key, String(value))` in the owning module, wrapped in `try/catch` where the page must still work without storage.
4. **Keys without a default** (UI state, "not set" is meaningful): `exifPanelWidth`, `sidebarWidth` (width from CSS), `lastFolderFilter` ("All photos"), `keywordFilterMode`, `sidePanelTab`, `keywordsAutoApplyAsked`, `albumsExpanded`, `albumsCollapsed`, `rawSearch` (Find RAW criteria object), plus `pausedScanTasks` (queue state, default `[]`). AGENTS.md §5.G asks a default for every remembered **setting**; these are state, not settings. In `generated/config.md` the "read by" column shows `—` for keys read through a constant or variable (e.g. `colorLabelEnabled`, `metadataWriter`): a generator limit, not a missing use.
5. A language is `appLanguage` (`i18n.js`, default from `DEFAULTS.appLanguage`, supported ones in `LANGUAGES`); fonts: `appFont` with the registry in `app-fonts.js`.
6. localStorage is per webview origin: a dev build using the `.dev` identifier has its own storage and its own app data (see below).

## Settings that reach the backend
- **Backend statics, resent at startup and on change** by the module that owns the control. Observed in code: `set_internet_allowed` (from `offlineMode`, `main.js`; the backend flag starts **false** in `face_models.rs`, so downloads are refused until the frontend sends the value), `set_verify_cross_drive_moves` (`verifyCrossDriveMoves`, `main.js`), `set_metadata_writer` (`metadataWriter`, `exiftoolPath`, skip-EXIF option, `metadata-settings.js`), `set_metadata_read_order` (`kind` = priority list name; keyword format order uses `kind: 'keywords'`, `metadata-settings.js`), `set_face_settings` and `set_face_reading` (`faces-panel.js`), `set_semantic_enabled` (`semantic-settings.js`), `set_private_zone_privacy` (per zone, stored in the database instead). ⚠ unverified: the exact startup call site of each setter outside `main.js` (read from `generated/ipc-commands.md` callers only).
- **Settings also stored in `config.json`**: thumbnail cache size and quality (`set_thumbnail_cache_size`, `set_thumbnail_quality`); both validate input (cache size ∈ 512 / 768 / 1024, quality `normal` / `high`) and write the file; the frontend also keeps them in localStorage for its own UI (`thumbnailQuality` is the example given in `recipes.md` §2). The setters run only on change; with no value in `config.json` the backend falls back to the same `defaults.jsonc` entry (`thumbnailCacheSize`, read with `include_str!` like `faceSettings`), so both sides start equal.
- **`faceSettings`** (and the key `thumbnailCacheSize`): read by **both sides**: the frontend through `DEFAULTS`, the backend through `include_str!` in `face_detect.rs` (it panics at startup with a message naming the key if a number or boolean is missing, so edit it carefully). Value ranges are in the comments of the file.

## Application config files
- `src-tauri/tauri.conf.json`: product name `photoboggan`, identifier `com.alexh3o.photoboggan`, version, one window (`visible: false`, `decorations: false`, `minWidth` 900, `minHeight` 500), the CSP (note `connect-src` lists `tiles.openfreemap.org` for map tiles, see `architecture.md`), asset protocol enabled with scope `**`, bundle targets `msi` and `deb`, resources, WiX language files. `beforeDevCommand` runs `fetch-exiftool -- --optional` then Vite; `beforeBuildCommand` runs `fetch-exiftool` then the frontend build.
- `src-tauri/tauri.dev.conf.json`: only overrides `identifier` (`com.alexh3o.photoboggan.dev`) and `productName` (`photoboggan-dev`); used by `npm run tauri:dev`. Effect (⚠ unverified: from Tauri's behaviour, not tested): a separate config dir, local data dir and webview storage, so a dev run does not touch the installed app's catalogue. Plain `npm run tauri dev` uses the production identifier.
- `src-tauri/capabilities/default.json`: window permissions of the `main` window.
- Environment variables: the application itself reads none that change behaviour (only `std::env::temp_dir()` for temp files). Ignored tests read `SEMANTIC_MODEL_DIR`, `ORT_DYLIB_PATH`, `SEMANTIC_CATALOG`, `PHOTOBOGGAN_BENCH_*` (see `testing.md`).

## Settings dialog sections
Tabs (`index.html`, `data-tab`): **General** (language, theme, startup view, offline mode, updates), **Storage** (data location, cache size and quality, move verification), **Applications** ("Open with" programs), **Metadata** (writer, ExifTool, read priorities, keyword formats, colour/pick), **Maps**, **Faces**, **Search** (content search), **Misc** (slideshow, Find RAW criteria, …). ⚠ unverified: the exact content of each tab (only tab names and the settings listed in `defaults.jsonc` section headers were read). Owners: General/Storage/tab switcher `main.js` (`modules/main-window.md`); Metadata `metadata-settings.js`; Faces `faces-panel.js`; Search `semantic-settings.js`; Maps `maps-settings.js`; Applications `photo-actions.js` (`open-with-section`); Misc `raw-settings.js`, `slideshow.js`.

## Invariants and sensitive areas
- ⚠ sensitive: backend statics are lost at exit by design; a new backend-side setting that is not resent at startup silently reverts to its Rust default on every launch.
- ⚠ sensitive: `defaults.jsonc` is parsed in two languages with the same naive rule (drop lines starting with `//`); a trailing comment or a key with a different JSON shape on one side breaks startup (frontend `JSON.parse`, or Rust panic for `faceSettings`).
- ⚠ sensitive: `config.json` handling must stay tolerant to missing fields (`#[serde(default)]` / `Option`) so older files keep loading.
- Offline mode is a **backend flag defaulting to refuse** (`INTERNET_ALLOWED`): do not add a network access that bypasses `internet_allowed()`.

## How to extend
1. New UI setting: `recipes.md` §2.
2. Setting needed by the backend: setter command + startup call (see above); needed before the UI: field in `AppConfig`.
3. New default for faces: edit `faceSettings` and check `face_detect.rs`.
4. New settings tab: pane and button in `index.html`, locale keys, owner module (`modules/main-window.md`).

## Open questions
- ⚠ unverified: `tauri.dev.conf.json` isolation effect (Tauri derives app data and config folders from the identifier; not tested by running both builds).
