<!-- verified: none | sources: AGENTS.md, src-tauri/src/exif.rs, src-tauri/src/exiftool.rs, src-tauri/src/db.rs, src-tauri/src/thumbnails.rs, src-tauri/src/library_sync.rs -->
# Business rules and invariants

> Status: **not written** (skeleton). Phase Opus. 200 lines max. Cross-cutting rules only; module-specific ones live in the module docs. Follow `_TEMPLATE.md`.

## Planned content

- Photo protection: image data never touched; temp file + replace; ExifTool -overwrite_original; failure recovery
- Metadata: two writer paths always in sync; sidecar targeting rules; reading priority; what is written where
- Cache layout and hashing (LAYOUT_VERSION, ALGO_VERSION): when a bump is mandatory
- Database: pool only, WAL, schema migrations
- Tasks: everything long goes through the queue; families; cancel
- Offline mode
- Portability (Windows / Linux)
- For each rule: why it exists, where it is enforced (name), which test covers it, what breaks if violated
