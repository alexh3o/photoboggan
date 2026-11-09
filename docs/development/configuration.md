<!-- verified: none | sources: src/defaults.jsonc, src/settings-defaults.js, src/i18n.js, src-tauri/src/main.rs, src-tauri/src/face_detect.rs -->
# Configuration

> Status: **not written** (skeleton). Phase Sonnet. 150 lines max. Key/default table is generated: generated/config.md. Follow `_TEMPLATE.md`.

## Planned content

- Storage locations: app data folder, database, caches (thumbnails/, raw_previews/), localStorage, where the user can change them
- How a setting is added, read, defaulted (defaults.jsonc, settings-defaults.js), and sent to the backend when needed
- Backend-side settings (faceSettings, ExifTool path, keyword format order, offline flag)
- Environment variables and dev/prod config files (tauri.conf.json, tauri.dev.conf.json)
- Settings dialog sections and what each controls (pointer to modules)
