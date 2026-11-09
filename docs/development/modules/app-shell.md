<!-- verified: none | sources: src-tauri/src/main.rs, src/i18n.js, src/settings-defaults.js, src/app-fonts.js, src/guide.js, src/defaults.jsonc, src-tauri/tauri.conf.json, src-tauri/capabilities/default.json -->
# Application shell: AppState, IPC registry, windows, settings, i18n, startup

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Backend start: `fn main` (main.rs) → `.setup`: `exiftool::init`, `resolve_app_paths`, `db::init_db`, `load_config_at_startup`, `restore_window_state`, `app.manage(AppState)`; then `generate_handler!` lists every command.
- `config.json` (`AppConfig`, `load_config` / `save_config`, written atomically; invalid file set aside, never overwritten) holds what must exist before the UI loads: data directory, cache size and quality, window state, "Open with" programs.
- Storage location: `get_storage_location` / `change_storage_location` (end of main.rs) swap the pool in `AppState.db_pool`; frontend `refreshStorageLocationUI` (main.js, section "EMPLACEMENT DES DONNÉES ET DU CACHE").
- Window: created hidden (`tauri.conf.json`), shown by main.js after the first styled paint, 10 s fallback thread in `.setup`; geometry tracked in `.on_window_event` → `save_current_window_state`; `check_window_visibility` (saved position must still be on a screen, AGENTS.md §5.G).
- Settings and i18n: `defaults.jsonc` → `DEFAULTS`, `readBool` / `readChoice` / `readNumber` (settings-defaults.js); `t`, `tp`, `labelWithColon`, `applyTranslations`, `onLanguageChange` (i18n.js); fonts registered in `APP_FONTS` (app-fonts.js); in-app guide `initGuide` (guide.js).
- Trap: backend settings are Rust statics reset at every launch; the frontend re-sends them at startup (e.g. `sendInternetAllowed`, `set_metadata_writer`, `set_metadata_read_order`). Do not duplicate `recipes.md` §1–2: link it.

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
