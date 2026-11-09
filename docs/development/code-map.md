<!-- verified: d9de6cb | sources: src/, src-tauri/src/, scripts/, .github/workflows/, src-tauri/Cargo.toml, package.json, vite.config.js -->
# Code map

Where things are and how the big files are organized. Sizes and the leading comment of every file: `generated/files.md`. Functions: `generated/symbols-js.md`, `generated/symbols-rust.md` (search them, do not load them whole).

## Repository tree

| Folder | Content |
|---|---|
| `/` | `index.html` (whole DOM: title bar, toolbar, panels, every modal), `package.json` (scripts: `tauri`, `docs:gen`, `docs:stale`, `fetch-exiftool`…), `vite.config.js`, `AGENTS.md` (rules for AI agents), `TODO.md` (backlog, owned by the user) |
| `src/` | Frontend: one ES module per feature, CSS files, `defaults.jsonc`, `locales/en.json` + `fr.json` |
| `src-tauri/` | Tauri app: `Cargo.toml`, `tauri.conf.json` (+ `tauri.dev.conf.json` for `npm run tauri:dev`), `capabilities/default.json` (window permissions), model manifests `face_models.json` / `semantic_models.json` (embedded with `include_str!`), `wix/*.wxl` (MSI texts), `icons/` |
| `src-tauri/src/` | Backend: one module per feature, declared in `main.rs` |
| `src-tauri/src/tests/` | One test file per module (`#[path]` include), `fixtures/` (incl. `semantic_reference.json`) |
| `src-tauri/resources/map-style/` | Bundled map style, sprites and fonts (fetched by `scripts/fetch-map-style.mjs`) |
| `src-tauri/vendor/exiftool/` | Bundled ExifTool, **not versioned** (only `README.txt`): `npm run fetch-exiftool` |
| `scripts/` | Node helpers: `fetch-exiftool.mjs`, `fetch-map-style.mjs`, `prepare-face-models.mjs`, `prepare-semantic-models.mjs` (release assets), `gen-docs.mjs` (this documentation) |
| `.github/workflows/` | `tests.yml` (cargo test on push / PR), `release.yml` (build and publish) |
| `docs/` | `USER_GUIDE.md`, `development/` (this documentation) |

## Entry points

- **Backend**: `src-tauri/src/main.rs`, `fn main`: plugins, `.setup` (paths, database, config, window, `AppState`), `.on_window_event` (window geometry), `generate_handler!` (every IPC command, grouped by module). A command missing from `generate_handler!` compiles but fails at `invoke` time.
- **Frontend**: `index.html` loads `src/main.js`, which imports every feature module, calls their `init…` functions with the services they need, and runs the startup sequence (section "DEMARRAGE": panels, startup folder, library sync, settings sent to the backend).

## Files by block

Backend (`src-tauri/src/`) and frontend (`src/`) files, grouped by the module doc that describes them (`modules/<doc>.md`, list in `_PROGRESS.md`).

| Block (doc) | Backend | Frontend |
|---|---|---|
| App shell (`app-shell`) | `main.rs` (AppState, `config.json`, storage location, window) | `i18n.js`, `settings-defaults.js`, `defaults.jsonc`, `app-fonts.js`, `guide.js`, `locales/` |
| Library & database (`library-and-database`) | `db.rs`, `library_sync.rs`, scan commands of `main.rs` | — |
| Main window: navigation & tasks (`main-window`) | — | `main.js`: loading, folder tree, task queue, settings modal, sync, startup |
| Grid & viewer (`grid-and-viewer`) | — | `main.js`: virtual grid, selection, sort, full screen, compare, marking; `slideshow.js`, `toolbar-a11y.js` |
| Thumbnails & previews (`thumbnails-and-previews`) | `thumbnails.rs`, `heif.rs`, `video.rs`, `orientation.rs`, cache commands of `main.rs` | — |
| Metadata (`metadata-read-write`) | `exif.rs`, `exiftool.rs` | `metadata-writes.js`, `metadata-settings.js`, `marking-settings.js`, `order-list.js` |
| Keywords (`keywords`) | `keywords.rs` | `keywords-panel.js`, `description-panel.js` |
| Faces (`faces`, `face-detection`) | `faces.rs`; `face_detect.rs`, `face_recognize.rs`, `face_models.rs`, `model_files.rs`, `onnx_runtime.rs` | `faces-panel.js`, `faces-grid.js`, `persons-view.js` |
| Semantic search (`semantic`) | `semantic.rs`, `semantic_search.rs`, `semantic_keywords.rs`, `semantic_models.rs` | `semantic*.js`, `main.js` section "CONTENT SEARCH RESULTS" (results mode) and `pumpSemanticQueue` (section "FILE D'ATTENTE DES TÂCHES") |
| Duplicates (`duplicates`) | `duplicates.rs`, `similar.rs`, `phash.rs` | `duplicates.js`, `duplicate-names.js`, `duplicates-modal.js`, `main.js` section "DUPLICATES" |
| Maps & geolocation (`maps-and-geolocation`) | `geolocation.rs`, `place_search.rs` | `map-view.js`, `map-mode.js`, `map-config.js`, `map-tile-protocol.js`, `maps-settings.js`, `location-panel.js`, `geo-tools.js`, `place-search.js` |
| Private zones & offline maps (`private-zones`) | `private_maps.rs` | `private-zones.js`, `private-zones-modal.js`, `zone-drawing.js` |
| Albums (`albums`) | `albums.rs` | `albums-panel.js` |
| Filters (`filters-and-search`) | — | `shooting-filters.js`, `format-filters.js` (also the extension lists), `filter-suggest.js`, `filter-tags.js`, `find-raw.js`, `raw-settings.js`, `histogram.js` |
| Photo operations (`photo-operations`) | `resize.rs`, `integrity.rs`, file commands of `main.rs` | `photo-actions.js` |
| Updates (`updates`) | `update_check.rs` | `update-check.js` |
| Styles (`style.md`) | — | `styles.css` + one CSS file per feature |
| Tests (`testing.md`) | `test_support.rs`, `tests/` | (none) |

## Inside the large files

**`src/main.js`** (~8400 lines). One file, organized in sections opened by a `// ====` banner with an uppercase title (search the title). In order:
- Title bar, hover dimming, format helpers (`isRawPath`, `isVideoPath`).
- "SYNCHRONISATION « PARESSEUSE » AVEC LE DISQUE" (`checkPhotoMissing` → `remove_missing_photos`).
- "CHARGEMENT PHOTOS & DOSSIERS" (`loadedPhotos`, `get_photos_paginated`), smart-album filter state.
- "ARBORESCENCE & FILTRES" (folder tree), "TROUVER LE RAW".
- "VIRTUAL SCROLLING" — ⚠ sensitive: pixel-exact layout (AGENTS.md §5.A).
- "GESTION DU PLEIN ÉCRAN ET NAVIGATION", "SELECTION MULTIPLE", "UNDO", "LOSSLESS ROTATION", shortcuts memo.
- "MODALE PARAMÈTRES" (+ folder management, About, Guide), "BOUTONS VUES & SIDEBAR", sidebar resizing.
- "TRI DES MINIATURES" (sort; also the settings controls such as thumbnail quality live around here), "MARQUAGE".
- "FILE D'ATTENTE DES TÂCHES" (`enqueueScanTask`, `pumpScanQueue`, `pumpSemanticQueue`, `runScanTask`, pause / resume) — ⚠ sensitive: every long feature depends on it.
- "DUPLICATES", "APERÇU : ZOOM, DÉPLACEMENT ET MODE COMPARER".
- "DÉFILEMENT DE LA GRILLE AU GLISSER", "DÉPLACEMENT ET COPIE … VERS L'ARBORESCENCE" (drag and drop), then the date / location / content-analysis filters.
- "MENU CONTEXTUEL DES MINIATURES" (also `removePhotosFromLibrary` and the `init…` calls of most feature modules), "CONTENT SEARCH RESULTS".
- "SYNCHRONISATION AVEC LES MODIFICATIONS EXTERNES" (`syncLibraryWithDisk`, on startup and window focus), "DEMARRAGE", "EMPLACEMENT DES DONNÉES ET DU CACHE".
Module-level mutable state (`loadedPhotos`, `photos`, `selectedIndices`, `scanTasks`…) is shared by all sections: a change in one section can break another.

**`src-tauri/src/main.rs`** (~3000 lines): `AppState` and `AppDataPaths`; `config.json` load/save; thumbnail cache naming (`thumbnail_cache_file`, `cache_files`) and cache commands; scans (`run_scan`, cancel flags `scan_cancel_flag` / `release_scan_cancel_flag`, shared by every module's tasks); integrity and duplicate entry commands; folder commands; photo listing (`get_photos_paginated`…); marking and rotation; rename / delete / move / copy (with sidecars) and clipboard; "Open with"; write-recovery reporting; `fn main`; storage location change.

**`src-tauri/src/exif.rs`** (~2700 lines): reading (`read_exif`, `read_marking`, priorities `set_read_priority`, keyword hierarchy parsing), XMP text editing helpers (`update_xmp_*`), JPEG segment rewriting (XMP, IPTC, comment), sidecar targeting (`sidecar_target`, `read_sidecar`, `sidecar_candidates`), write entry points (`write_metadata`, `write_xmp_metadata`, `write_xmp_orientation`), atomic file replacement (`write_file_atomically`), "show all metadata" (`read_metadata_details`).

**`src-tauri/src/faces.rs`** (~1900 lines), sections opened by `// ----` banners: settings, database, UI commands, faces view, writing to files, grouping unknown faces, person management, merge and cleanup, hand-drawn regions.

**`src/photo-actions.js`** (~2100 lines): context menus, info and confirmation modals, copy / move / delete / rename, resize dialog, "Open with", integrity report. **`src/faces-panel.js`** (~1600) and **`src/keywords-panel.js`** (~1250): see their module docs.

## Not source: do not edit by hand

- `docs/development/generated/` — regenerate with `npm run docs:gen`.
- `src-tauri/vendor/exiftool/` — downloaded, pinned version and SHA-256 in `scripts/fetch-exiftool.mjs`.
- `src-tauri/resources/map-style/` — fetched by `scripts/fetch-map-style.mjs`.
- `src-tauri/gen/` — generated by Tauri (capability schemas), not versioned.
- `src-tauri/Cargo.lock`, `package-lock.json` — managed by cargo / npm.
- `src-tauri/src/tests/fixtures/semantic_reference.json` — reference output of the SigLIP 2 model, used by ignored tests.
- `dist/` (Vite output) and `src-tauri/target/` — build outputs.
- `dev_tools/` — the author's working notes, not versioned; not documentation for the code.
