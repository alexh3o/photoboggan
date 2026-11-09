<!-- verified: 55b2280 | sources: src-tauri/src/main.rs, src/i18n.js, src/settings-defaults.js, src/app-fonts.js, src/guide.js, src/defaults.jsonc, src-tauri/tauri.conf.json, src-tauri/capabilities/default.json -->
# Application shell: AppState, IPC registry, windows, settings, i18n, startup

## Purpose
The shell is everything that exists before and around the features: where the data lives (`AppState`, `config.json`, storage location), the single window and its geometry, the IPC registry (`generate_handler!`), and on the frontend the default settings (`defaults.jsonc`), translations (`i18n.js`), fonts and the shortcut guide. Features plug into it; it knows nothing about photos. In `main.rs` this doc covers only these parts: scans, cache and file commands belong to other docs (see `../code-map.md`).

## Files
| File | Role |
|---|---|
| `src-tauri/src/main.rs` | `AppState`, `AppDataPaths`, `AppConfig` (`config.json`), window state, `fn main`, storage location commands |
| `src-tauri/tauri.conf.json` | One window `main` (hidden, undecorated, min 900×500), CSP, asset protocol scope `**`, bundle targets (msi, deb), bundled resources |
| `src-tauri/capabilities/default.json` | Window permissions granted to the `main` window (show, minimize, maximize, close, destroy, fullscreen, drag…) |
| `src/defaults.jsonc` | Default value of every localStorage setting of a new install (also read by `face_detect.rs`, section `faceSettings`) |
| `src/settings-defaults.js` | Parses it (`DEFAULTS`) and reads saved values (`readStored`, `readBool`, `readChoice`, `readNumber`) |
| `src/i18n.js` | Translation engine: `t`, `tp`, `labelWithColon`, `applyTranslations`, `setLanguage`, `onLanguageChange`, `normalizeSearch` |
| `src/locales/en.json`, `fr.json` | Messages keyed by the English text |
| `src/app-fonts.js` | `APP_FONTS` registry, `fontStack` |
| `src/guide.js` | Keyboard-shortcut guide modal (`initGuide`), rendered from the `GROUPS` list with a search box |

## How it works
**Backend start** (`fn main` → `.setup`, order matters):
1. `tauri_plugin_single_instance` is registered first: a second launch exits and only unminimizes/shows/focuses the open window.
2. `exiftool::init`, `private_maps::init_bundled_style` receive the resource directory.
3. `resolve_app_paths` → `load_config_at_startup`: data directory is `custom_data_dir` if set, else `<app local data>/data` (`default_data_directory`); creates `thumbnails/` and `raw_previews/`; moves a legacy `photos_library.db` found in the working directory.
4. `db::init_db` opens the pool; `private_maps::migrate_legacy_files`.
5. The config is read again for the thumbnail cache size (512 / 768 / 1024, else 512; `THUMBNAIL_CACHE_SIZES`) and quality (`thumbnails::set_high_quality_thumbnails`).
6. `restore_window_state` then a 10 s fallback thread that shows the window if still hidden.
7. `app.manage(AppState { db_pool, paths, thumbnail_cache_size, window_tracker })`. Commands read it through `state.pool()`, `base_dir()`, `thumbnails_dir()`…, which clone out of the `RwLock` (never keep the guard).

**Window**: created hidden (`tauri.conf.json`). The frontend shows it after two animation frames following `DOMContentLoaded` (`main.js`, top of file), so the user never sees unstyled HTML. `.on_window_event` (label `main` only) keeps `window_tracker` = last **non-maximized** position and size (`Resized`, `Moved`), and writes it with `is_maximized` into `config.json` on `CloseRequested` (`save_current_window_state`). Restoring (`restore_window_state`): the saved rectangle must overlap a monitor by at least 100×100 px with a reachable title bar (`check_window_visibility`); otherwise 1024×768, centered. The saved size is raised to the minimum scaled by the monitor scale factor (`MIN_WIDTH_LOGICAL`/`MIN_HEIGHT_LOGICAL` = 900/500, to keep in sync with `tauri.conf.json`).

**`config.json`** (OS app-config dir, `AppConfig`): `custom_data_dir`, `thumbnail_cache_size`, `thumbnail_quality`, `window_state`, `open_with_programs`. It exists because these values are needed **before** the webview loads (database location, cache settings, window rectangle); everything else is UI state in `localStorage`. Commands change it with `load_config` → edit → `save_config`. `save_config` writes `config.json.tmp` then renames (never a half-written file). A missing file gives defaults; an unreadable/invalid one is an error for `load_config` (later writes refuse to start from it, so a damaged file is never overwritten) and `load_config_at_startup` renames it `config.json.invalid-<seconds>` and starts with defaults.

**Change storage location** (`get_storage_location`, `change_storage_location`; UI `refreshStorageLocationUI` and the two buttons in `main.js`, section "EMPLACEMENT DES DONNÉES ET DU CACHE"): a null `newPath` means "back to default". Steps: refuse if the target equals the current one or already contains any of `STORAGE_FILES` / `STORAGE_DIRS` (db files, `thumbnails`, `raw_previews`, `models`, `person_covers`, `private_maps`); take the **write lock of `db_pool`** and refuse if `running_tasks() > 0` or `library_sync::is_running()`; close private tile files; `copy_storage` (WAL checkpoint, then `BEGIN IMMEDIATE` held during the copy, durable copy except the two image caches); open the copy with `db::init_db`; swap pool and paths; save `config.json`; if that fails, swap back and delete the copy; finally `remove_storage` on the old location (best effort). The old data is only deleted after everything succeeded. The frontend then calls `loadPhotos()`.

**Frontend defaults and i18n**: `DEFAULTS` is `defaults.jsonc` with full-line `//` comments removed; `readBool/readChoice/readNumber` return the saved value only if valid, else the default (so a corrupted value never breaks startup). `t(key)` falls back to English, then to the key. `tp(key, count)` picks `Key` or `Key|other` using `Intl.PluralRules` (French: 0 and 1 singular). `applyTranslations` handles `data-i18n` and `data-i18n-title|aria-label|placeholder|alt`; texts built in JS are regenerated by listeners registered with `onLanguageChange`. Add a font: the 4 steps in the header of `app-fonts.js`. Add a UI text: `recipes.md` §1; add a setting: `recipes.md` §2.

**Backend statics are not persistent**: settings held in Rust statics are pushed by the frontend at every startup and on change (examples seen in code: `set_internet_allowed` and `set_verify_cross_drive_moves` from `main.js`; `set_metadata_writer`, `set_metadata_read_order` from `metadata-settings.js`; `set_face_settings`, `set_face_reading` from `faces-panel.js`; `set_semantic_enabled` from `semantic-settings.js`). `INTERNET_ALLOWED` starts **false** (`face_models.rs`) until the frontend sends it. Cache size/quality are the exception: stored in `config.json`, so they apply before the frontend speaks.

## Contracts
- IPC commands: `get_storage_location`, `change_storage_location`, `set_thumbnail_cache_size`, `set_thumbnail_quality` (both validate then write `config.json`); every command must also be listed in `generate_handler!` or `invoke` fails at runtime. Signatures: `../generated/ipc-commands.md`.
- Events: none emitted by the shell itself (`../generated/events.md`).
- Database: none owned; `change_storage_location` copies the whole file.
- Settings: localStorage keys and defaults in `../generated/config.md`; `appLanguage` (`i18n.js`), `appFont`.

## Dependencies
- Uses: `db.rs` (`init_db`, pool), `exiftool`, `private_maps` (init, close files), `thumbnails` (quality), `library_sync::is_running` and `running_tasks` (refusal while work runs).
- Used by: every module (`AppState`, `settings-defaults.js`, `i18n.js`).

## Invariants and sensitive areas
- ⚠ sensitive: `change_storage_location` holds the pool write lock for the whole copy; a command that started before it keeps the old pool. Any new long-running task type must be counted by `running_tasks()` or the move can run underneath it. Add a new data folder to `STORAGE_DIRS` or it is silently left behind and lost on cleanup.
- ⚠ sensitive: `config.json` is never rewritten from defaults after a read error (see above); keep that when adding fields (`#[serde(default)]` / `Option`).
- ⚠ sensitive: the single-instance plugin must stay first in `fn main`.
- Window geometry minimums exist in two places (`tauri.conf.json`, `restore_window_state`).
- Window permissions: a new `getCurrentWindow()` call needs the matching `core:window:allow-*` in `capabilities/default.json` (AGENTS.md §5.G mentions `allow-destroy`).
- No comma-after-value comments in `defaults.jsonc` (both parsers only drop full-line `//`).

## Tests
`src-tauri/src/tests/main.rs` covers cache subfolders, copy and move helpers, not the shell items above (⚠ unverified: no test of `config.json` handling or `change_storage_location` was found; check `generated/tests.md`). No frontend tests.

## How to extend
1. New persisted UI setting: `recipes.md` §2 (default in `defaults.jsonc`, `readBool`…).
2. New value needed before the UI loads: add an `Option` field to `AppConfig`, read it in `.setup`, write it through `load_config`/`save_config`.
3. New backend runtime setting: a command plus a `send…()` call at frontend startup (pattern of `sendInternetAllowed`).
4. New IPC command: `recipes.md` §1 (do not forget `generate_handler!`).
5. New data folder in the data directory: add to `STORAGE_DIRS`.
6. New shortcut in the guide: add a row to `GROUPS` in `guide.js` with `en.json`/`fr.json` keys.

## Open questions
- ⚠ unverified: whether `open_with_programs` migration (`register_existing_programs`) is documented elsewhere; belongs to photo-operations.
- ⚠ unverified: `tauri.dev.conf.json` differences (not read), see `build-release.md`.
