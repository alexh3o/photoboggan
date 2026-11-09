<!-- verified: none | sources: src-tauri/src/main.rs, src/defaults.jsonc, src/i18n.js, src-tauri/src/exif.rs, src-tauri/src/exiftool.rs, src-tauri/src/db.rs -->
# Maintenance recipes

> Status: **not written** (skeleton). Phase Opus. 200 lines max. Each recipe: ordered checklist of files to touch with the name to search in each, the test to add, and the trap. Follow `_TEMPLATE.md`.

## Planned content

- Add an IPC command (Rust fn, register in generate_handler!, JS invoke, capability if needed, thread model, test)
- Add a remembered setting (defaults.jsonc, settings-defaults, UI control, i18n, backend if needed)
- Add a metadata field to write (both writer paths, read-back, sidecar, tests)
- Add a file format (extension lists in format-filters.js, thumbnails, previews, hashing, metadata target)
- Add a DB column or table (schema and migration, pool, tests, cache version impact)
- Add a filter, a panel, a modal, a toolbar button, a translation key
- Add a long task to the queue (family, task_id, cancel, toast)
- Add a backend event and its listener
