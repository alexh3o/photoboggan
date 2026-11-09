<!-- verified: none | sources: src/, src-tauri/src/, scripts/, .github/workflows/, src-tauri/Cargo.toml, package.json, vite.config.js -->
# Code map

> Status: **not written** (skeleton). Phase Opus. 200 lines max. Complements generated/files.md (sizes and leading comments). Follow `_TEMPLATE.md`.

## Planned content

- Repository tree, one line per folder
- Role of each significant file, grouped by block (link to the matching modules/ doc)
- Entry points: backend (main.rs: setup, generate_handler!), frontend (index.html, then src/main.js)
- Files that are large or central (main.js regions, exif.rs, main.rs, faces.rs): how they are organized inside, and which regions are risky
- Files that are NOT source (vendored, generated, resources) and must not be edited
