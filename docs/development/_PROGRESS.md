<!-- Working file for the writing phase: delete or archive when every row below is "reviewed". Ignored by `npm run docs:stale`. -->
# Documentation progress

Update the status column and commit at the end of each session. One session = one row (or two small ones). Statuses: `skeleton` → `written` → `reviewed`.

## Phase plan

| # | Phase | Model | Output | Status |
|---|---|---|---|---|
| 1 | Generator + skeleton + template | Sonnet | `scripts/gen-docs.mjs`, `generated/`, empty docs | done |
| 2 | Architecture, code map, invariants, recipes; **validate the module split below** | Opus | `architecture.md`, `code-map.md`, `invariants.md`, `recipes.md`, this table, phase 2 notes in every module skeleton | done |
| 3 | Module docs, style, configuration, testing, build, troubleshooting, glossary | Sonnet, one session per row | see table below | todo |
| 4 | Cross-review: contradictions, `⚠` items, spot-check claims against the code | Opus | fixes + `reviewed` status | todo |
| 5 | Real-task test with a free-tier model using only these docs | any | list of gaps → fixes | todo |
| 6 | Hook up `AGENTS.md` (one pointer line + "update docs with the code" rule) | Sonnet | AGENTS.md diff, user validates | todo |

## Module split (validated in phase 2)

Changes from the draft, and why:
- `main.js` (~8400 lines) is split in two docs: **`main-window`** (loading, folder tree, task queue, settings modal, sync, startup) and **`grid-and-viewer`** (virtual grid, thumbnails in the grid, selection, full screen, compare, marking, sort, slideshow). Each prompt below lists the `main.js` sections it owns.
- Faces (9 files, ~6000 lines) is split: **`faces`** (data, review, people: `faces.rs` + UI) and **`face-detection`** (detection, recognition, model download, ONNX Runtime, offline flag).
- Maps (14 files) is split: **`maps-and-geolocation`** (map view, tile protocol, map mode, location panel, GPS edit, place search) and **`private-zones`** (`private_maps.rs`: private zones, MBTiles offline maps).
- `order-list.js` moved from filters to `metadata-read-write` (it is only used by Metadata settings).
- `main.rs` is listed in four docs (app-shell, library-and-database, thumbnails-and-previews, photo-operations) and `main.js` in four (main-window, grid-and-viewer, duplicates, semantic) because each holds a region of them; `code-map.md` lists the regions. A change to those files flags all four docs in `docs:stale`: check only the region of each.
- Kept as is: library-and-database, thumbnails-and-previews, metadata-read-write (dense but one subject; if it exceeds 150 lines, split "reading" and "writing"), keywords, semantic (may split search / suggestions if too long), duplicates, albums, filters-and-search, photo-operations, updates, app-shell.

Findings of phase 2, already fixed in `AGENTS.md` (§1 and §5.D):
- the keyword format order is sent with `set_metadata_read_order` (kind `keywords`), not `set_keyword_format_order` (which does not exist);
- HEIC / HEIF metadata is written inside the container (`heif::update_xmp`, ExifTool `Target::Heif`), sidecar only as internal fallback;
- map tiles are the one network access made by the webview (`map-tile-protocol.js`, gated by `isMapNetworkAllowed()`).

## Document status

| Doc | Phase | Status |
|---|---|---|
| `architecture.md` | 2 | written |
| `code-map.md` | 2 | written |
| `invariants.md` | 2 | written |
| `recipes.md` | 2 | written |
| `modules/app-shell.md` | 3 | skeleton |
| `modules/library-and-database.md` | 3 | skeleton |
| `modules/main-window.md` | 3 | skeleton |
| `modules/grid-and-viewer.md` | 3 | skeleton |
| `modules/thumbnails-and-previews.md` | 3 | skeleton |
| `modules/metadata-read-write.md` | 3 | skeleton |
| `modules/keywords.md` | 3 | skeleton |
| `modules/faces.md` | 3 | skeleton |
| `modules/face-detection.md` | 3 | skeleton |
| `modules/semantic.md` | 3 | skeleton |
| `modules/duplicates.md` | 3 | skeleton |
| `modules/maps-and-geolocation.md` | 3 | skeleton |
| `modules/private-zones.md` | 3 | skeleton |
| `modules/albums.md` | 3 | skeleton |
| `modules/filters-and-search.md` | 3 | skeleton |
| `modules/photo-operations.md` | 3 | skeleton |
| `modules/updates.md` | 3 | skeleton |
| `style.md` | 3 | skeleton |
| `configuration.md` | 3 | skeleton |
| `testing.md` | 3 | skeleton |
| `build-release.md` | 3 | skeleton |
| `troubleshooting.md` | 3 | skeleton |
| `glossary.md` | 3 | skeleton |

## Phase 3 in three parallel sessions

The 23 phase 3 docs are grouped in three sessions that can run **at the same time in this checkout**: they write disjoint files. Balanced by source volume (about 13k, 13k and 16k lines of source; B reads `main.js` by sections, A and B read regions of `main.rs`) and grouped by subject so that one session reuses what it has already read.

| Session | Docs, in this order | Theme |
|---|---|---|
| A | metadata-read-write, keywords, library-and-database, thumbnails-and-previews, photo-operations, updates, testing, build-release | Backend core: files, metadata, catalogue, caches |
| B | app-shell, main-window, grid-and-viewer, filters-and-search, albums, configuration, style | Frontend shell and main window (`main.js`, `index.html`, CSS) |
| C | faces, face-detection, semantic, duplicates, maps-and-geolocation, private-zones, troubleshooting, glossary | Optional features and the two cross-reading docs (last) |

Rules for parallel runs (already in each prompt): do not edit `_PROGRESS.md` and do not run `npm run docs:gen` (shared files); commit only your own docs with `git commit -m "…" -- <paths>`; if git reports `index.lock`, wait a few seconds and retry. Once the three sessions are done, one short step sets the 23 statuses to `written` here, runs `npm run docs:gen` and `npm run docs:stale`, and commits.

**Session A (Sonnet)**

> You are writing part of the developer documentation of photoboggan, in parallel with two other sessions working in the same checkout. Read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, `docs/development/code-map.md` and `docs/development/invariants.md` once. Then write these docs, one after the other, each by following its own prompt in `docs/development/_PROGRESS.md` (section "Session prompts"): `modules/metadata-read-write.md`, `modules/keywords.md`, `modules/library-and-database.md`, `modules/thumbnails-and-previews.md`, `modules/photo-operations.md`, `modules/updates.md`, then `testing.md` and `build-release.md` (shared prompt "other docs"). Overrides for parallel work: do NOT edit `_PROGRESS.md` (skip the "set its row" step), do NOT run `npm run docs:gen`, and after stamping each doc commit only that doc with `git commit -m "docs(dev): write <doc>" -- <doc path>` (retry after a few seconds if git reports `index.lock`). Never touch files outside your list; if you find something to change elsewhere (AGENTS.md, another doc, code), list it in your final message instead. End with a summary: docs written, `⚠ unverified` items left, size of each doc.

**Session B (Sonnet)**

> You are writing part of the developer documentation of photoboggan, in parallel with two other sessions working in the same checkout. Read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, `docs/development/code-map.md` (especially "Inside the large files": `main.js` is ~8400 lines, never read it whole) once. Then write these docs, one after the other, each by following its own prompt in `docs/development/_PROGRESS.md` (section "Session prompts"): `modules/app-shell.md`, `modules/main-window.md`, `modules/grid-and-viewer.md`, `modules/filters-and-search.md`, `modules/albums.md`, then `configuration.md` and `style.md` (shared prompt "other docs"). Overrides for parallel work: do NOT edit `_PROGRESS.md` (skip the "set its row" step), do NOT run `npm run docs:gen`, and after stamping each doc commit only that doc with `git commit -m "docs(dev): write <doc>" -- <doc path>` (retry after a few seconds if git reports `index.lock`). Never touch files outside your list; if you find something to change elsewhere (AGENTS.md, another doc, code), list it in your final message instead. End with a summary: docs written, `⚠ unverified` items left, size of each doc.

**Session C (Sonnet)**

> You are writing part of the developer documentation of photoboggan, in parallel with two other sessions working in the same checkout. Read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, `docs/development/code-map.md` once. Then write these docs, one after the other, each by following its own prompt in `docs/development/_PROGRESS.md` (section "Session prompts"): `modules/faces.md`, `modules/face-detection.md`, `modules/semantic.md`, `modules/duplicates.md`, `modules/maps-and-geolocation.md`, `modules/private-zones.md`, then `troubleshooting.md` and `glossary.md` (shared prompt "other docs"). Write these two last: use the docs already written by all sessions (`git log --oneline -- docs/development` shows them) and `AGENTS.md`; for areas still missing, read the code and mark the entries `⚠ unverified` so phase 4 completes them. Overrides for parallel work: do NOT edit `_PROGRESS.md` (skip the "set its row" step), do NOT run `npm run docs:gen`, and after stamping each doc commit only that doc with `git commit -m "docs(dev): write <doc>" -- <doc path>` (retry after a few seconds if git reports `index.lock`). Never touch files outside your list; if you find something to change elsewhere (AGENTS.md, another doc, code), list it in your final message instead. End with a summary: docs written, `⚠ unverified` items left, size of each doc.

**After the three sessions (any model, a few minutes)**

> In `docs/development/_PROGRESS.md`, set to `written` the row of every doc whose first line has a `verified:` hash other than `none`. Run `npm run docs:gen` and `npm run docs:stale` (report any stale doc or uncovered source file). Collect the "to change elsewhere" lists from the three session reports if I paste them, add them to the phase 4 section. Commit.

## Session prompts (copy, paste as is)

### Phase 3 — module docs (Sonnet, one session each)

Every module prompt below starts with the same instructions; only the last sentences change.

**app-shell**

> Write `docs/development/modules/app-shell.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Read the files of its `sources:` line, and only the rows of `generated/ipc-commands.md`, `generated/module-deps.md`, `generated/config.md` that concern them (search by name). Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, link `generated/` instead of copying it, 150 lines max, English. Then stamp it (`node scripts/gen-docs.mjs --stamp docs/development/modules/app-shell.md`), set its row in `docs/development/_PROGRESS.md` to `written`, commit (English message). Module-specific: in `main.rs` cover only `AppState`, `AppDataPaths`, `config.json` (`AppConfig`, `load_config_at_startup`, `save_config`), window state (`restore_window_state`, `check_window_visibility`, `save_current_window_state`), `fn main` and the storage location commands; scans, cache and file commands belong to other docs. Explain why some settings live in `config.json` and others in localStorage, and that backend statics are re-sent at startup. Link `recipes.md` §1–2 instead of repeating them.

**library-and-database**

> Write `docs/development/modules/library-and-database.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Read the files of its `sources:` line, and only the rows of `generated/ipc-commands.md`, `generated/module-deps.md`, `generated/db-schema.md` that concern them (search by name). Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, link `generated/` instead of copying it, 150 lines max, English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: in `main.rs` read only the scan commands (`add_folder`, `scan_folder`, `rescan_*`, `run_scan`, cancel flags), `insert_batch`, `remove_missing_photos`, `sync_library` and the listing commands (`get_photos_paginated`, `count_photos`…). Document pause / resume (`resume_since`, `read_since`), the 500-photo batches, and why an unreadable file is skipped. Link `invariants.md` §4–5 for the rules instead of repeating them; recipe 5 of `recipes.md` covers adding a column.

**main-window**

> Write `docs/development/modules/main-window.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, `docs/development/code-map.md` ("Inside the large files"), then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Do not read `main.js` whole: search the section banners listed in the skeleton and read those sections only. Use only the rows of `generated/ipc-commands.md` and `generated/symbols-js.md` that concern them. Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max, English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: the task queue is the core: explain `enqueueScanTask` refusal rules (`familyOf`, `taskCoversFolder`, `dedupeKey`), the single main lane vs the semantic lane, `ready` and `paused` statuses, and how modules receive `enqueueTask` by injection. Trap: families do not run in parallel, they only decide refusals.

**grid-and-viewer**

> Write `docs/development/modules/grid-and-viewer.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, `docs/development/code-map.md` ("Inside the large files"), then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Do not read `main.js` whole: search the section banners listed in the skeleton and read those sections only, plus `slideshow.js` and `toolbar-a11y.js`. Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max, English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: AGENTS.md §5.A, §5.B and §7 hold the grid invariants (px for layout, no reflow on selection, justified rows, last row not stretched): link them and point at the functions that enforce them. Describe the thumbnail pipeline of the grid (batched cache lookup, generation queue, webview fallback) and how RAW / HEIC / video reach full screen (`get_raw_preview_path`, `view_fix`).

**thumbnails-and-previews**

> Write `docs/development/modules/thumbnails-and-previews.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Read the files of its `sources:` line (in `main.rs`, only the cache functions and commands from `thumbnail_cache_file` to `set_thumbnail_quality`, `keep_cached_images`, `rotate_photos`), and only the rows of `generated/ipc-commands.md`, `generated/module-deps.md`, `generated/tests.md` that concern them. Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max, English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: explain the cache key and `PREVIEW_VERSION`, how RAW previews are found (CR3 vs TIFF-based), the orientation priority (`orientation::resolve`) and `view_fix`. Link `invariants.md` §3 instead of repeating it. Trap: video thumbnails differ by platform (Windows Shell vs optional ffmpeg).

**metadata-read-write**

> Write `docs/development/modules/metadata-read-write.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, `docs/development/invariants.md`, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). `exif.rs` is ~2700 lines: read its list of functions in `generated/symbols-rust.md` first, then the functions named in the notes. Read `exiftool.rs`, `metadata-writes.js`, `metadata-settings.js`, `marking-settings.js`, `order-list.js`. Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max (if it does not fit, split into `metadata-reading.md` and `metadata-writing.md` and update `_PROGRESS.md`), English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: do not repeat `invariants.md` §1–2 (link it); add the reading flow, the priority lists and their settings, the ExifTool process pool and its lifetime, and the frontend write circuit (`registerEditor`, `applyPending`, `runLocked`). Note: HEIC metadata is written in the container first (AGENTS.md says sidecar: report it as an open question, do not change AGENTS.md).

**keywords**

> Write `docs/development/modules/keywords.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Read the files of its `sources:` line, and only the rows of `generated/ipc-commands.md`, `generated/module-deps.md`, `generated/db-schema.md` (`keyword_nodes`, `photo_keywords`) that concern them. Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max, English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: `run_write` is shared by keywords, title, description, faces and GPS: describe it once, precisely. Trap: AGENTS.md §5.D names `set_keyword_format_order`, the real command is `set_metadata_read_order` (kind `keywords`); write the real name and list the mismatch in "Open questions".

**faces**

> Write `docs/development/modules/faces.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). `faces.rs` (~1900 lines) is organized in `// ----` sections (listed in `code-map.md`): read the section of each command you document rather than the whole file; same for `faces-panel.js` (~1600) and `faces-grid.js` (~1100). Use only the rows of `generated/ipc-commands.md`, `generated/db-schema.md` and `generated/tests.md` (`faces_db.rs`) that concern them. Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max, English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: explain how face regions and person keywords reach the files (`plan_face_write` + `apply_metadata_changes`) and the conflict dialog (`face_keyword_conflicts`). Detection and models are in `face-detection.md`: link, do not describe.

**face-detection**

> Write `docs/development/modules/face-detection.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Read the files of its `sources:` line, the `faceSettings` section of `src/defaults.jsonc`, and only the rows of `generated/ipc-commands.md` and `generated/module-deps.md` that concern them. Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max, English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: describe the detection task, the thumbnail input (why 512 px minimum), the recognition pipeline (align, embed, similarity, DBSCAN), model download / import with SHA-256 (`model_files.rs`, also used by semantic models and updates) and the global offline flag hosted in `face_models.rs`.

**semantic**

> Write `docs/development/modules/semantic.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, AGENTS.md §5.L, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Read the four `semantic*.rs` files (use `generated/symbols-rust.md` to target functions), the five `semantic*.js` files, and in `main.js` only the section "CONTENT SEARCH RESULTS" and `pumpSemanticQueue`. Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max (if needed, split into `semantic-search.md` and `semantic-keywords.md` and update `_PROGRESS.md`), English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: the "zero cost when disabled" gate, the own task lane and `PriorityGuard` pauses, stale-response counters, and the rule that accepting a suggestion only calls `addPendingKeyword`.

**duplicates**

> Write `docs/development/modules/duplicates.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, AGENTS.md §5.K, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Read `duplicates.rs`, `similar.rs`, `phash.rs`, the three `duplicate*.js` files, in `main.rs` only `find_duplicates`, `find_similar_images`, `list_duplicate_candidates`, and in `main.js` only the section "DUPLICATES". Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max, English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: explain when `LAYOUT_VERSION` / `ALGO_VERSION` must be bumped and that the semantic index also stores `LAYOUT_VERSION`. Do not describe cleanup actions unless you find them in the code.

**maps-and-geolocation**

> Write `docs/development/modules/maps-and-geolocation.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md` ("Offline mode"), then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Read the files of its `sources:` line (start with the header comment of `map-tile-protocol.js`), and only the rows of `generated/ipc-commands.md` and `generated/module-deps.md` that concern them. Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max, English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: the webview fetches map tiles itself through `pbmap://` (the only network access outside the backend); explain the gate `isMapNetworkAllowed()` and the CSP entry. Private zones belong to `private-zones.md`: link only.

**private-zones**

> Write `docs/development/modules/private-zones.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Read the files of its `sources:` line (start with the module comment of `private_maps.rs`), the header of `src/map-tile-protocol.js`, and only the rows of `generated/ipc-commands.md`, `generated/db-schema.md` (`private_zones`) and `generated/tests.md` that concern them. Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max, English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: the per-tile privacy rule, the MBTiles files (separate SQLite databases, not the catalogue pool), the provider limits (`MAX_TILES`, `MAX_BYTES`) and the download task.

**albums**

> Write `docs/development/modules/albums.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Read `albums.rs`, `albums-panel.js`, in `main.js` only the section "ALBUMS INTELLIGENTS : ÉTAT DES FILTRES ENREGISTRÉ", and the album rows of `generated/ipc-commands.md`, `generated/db-schema.md`, `generated/tests.md`. Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max (this one should be well under), English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: albums live only in the database (not rebuildable from files): say what that implies for "change storage location" and for a lost catalogue.

**filters-and-search**

> Write `docs/development/modules/filters-and-search.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, `recipes.md` §6, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Read the files of its `sources:` line, in `main.js` only `applyPhotoFilters`, `prefilterFromState`, `buildSqlPrefilter` and the section "TROUVER LE RAW", and in `db.rs` only `PhotoPrefilter` and its SQL. Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max, English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: the JS filter and the SQL prefilter must agree: show where each criterion is implemented on both sides. `format-filters.js` also holds the frontend extension lists (see `recipes.md` §4).

**photo-operations**

> Write `docs/development/modules/photo-operations.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, `docs/development/invariants.md` §1, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Read `resize.rs`, `integrity.rs`, `photo-actions.js` (~2100 lines: use `generated/symbols-js.md` to target functions), and in `main.rs` only the commands named in the notes (file operations, marking, rotation, "Open with", clipboard). Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max, English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: how sidecars follow a moved / copied / renamed / deleted photo, the copy conflict resolution, permanent deletion on drives without a trash (`has_trash`, `count_permanent_deletions`), and why "Open with" only launches registered programs.

**updates**

> Write `docs/development/modules/updates.md`. First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, AGENTS.md §5.J, then the skeleton (its "How it works" holds phase 2 notes naming the entry points: verify each, then replace them by the real section). Read `update_check.rs`, `update-check.js`, `tests/update_check.rs`, and the update rows of `generated/ipc-commands.md`. Rules: facts only, `⚠ unverified:` when unsure, `⚠ sensitive:` for regression-prone areas, names not line numbers, 150 lines max (this one should be well under), English. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Module-specific: the security chain (asset filter, published digest, hash checked at download and again before launch, the UI never passes a URL or path).

### Phase 3 — other docs (Sonnet, one session each, or two small ones together)

> Write `docs/development/<DOC>.md` (one of: `style`, `configuration`, `testing`, `build-release`, `troubleshooting`, `glossary`). First read `docs/development/_TEMPLATE.md`, `docs/development/architecture.md`, then the skeleton and its "Planned content". Read the files of its `sources:` line and the matching generated table (`generated/css.md` for style, `generated/config.md` for configuration, `generated/tests.md` for testing; search, do not load whole). Rules: facts only, `⚠ unverified:` when unsure, names not line numbers, link `generated/` instead of copying it, size limit of the skeleton, English. Replace the status note and "Planned content" by the real content. Then stamp it, set its row in `_PROGRESS.md` to `written`, commit. Hints: configuration — `config.json` (`AppConfig` in main.rs) vs localStorage vs backend statics (see `architecture.md` "Where state lives"), and `recipes.md` §2; build-release — ExifTool is not versioned (`npm run fetch-exiftool`), `tauri.dev.conf.json` is used by `npm run tauri:dev`; troubleshooting — only problems visible in code (error codes such as `internet_disabled`, ExifTool recovery dialog and `<data dir>/logs/`, `config.json.invalid-*`); glossary — write it last, from the terms used by the other docs.

### Phase 4 (Opus, one session)

> Review every `written` doc in `docs/development/`: contradictions between docs, claims that do not match the code (check at least 5 per doc against the source), missing sensitive areas, links to generated tables that do not exist, files over the size limit, and the "to change elsewhere" items reported by the phase 3 sessions (added below by the final step). Fix them, mark docs `reviewed`, list what remains uncertain.

### Phase 5 (free-tier model)

> Using ONLY `docs/development/` (and the source files it points to), explain how you would add <a small realistic feature>. List every step and file. Say which statement of the docs was missing or unclear.
