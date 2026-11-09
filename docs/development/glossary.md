<!-- verified: d9de6cb | sources: AGENTS.md, src/locales/en.json -->
# Glossary

One line per term, built from the terms used by the other docs. Module docs hold the details (link given when useful). Each term was checked against the code or the doc it links.

## Files, metadata, formats

- **In-place**: the folders on disk are the only source of truth; the catalogue and caches are rebuildable copies (`architecture.md`).
- **Sidecar**: a `.xmp` file next to an image that cannot hold metadata (RAW, PNG, video…) or when the internal writer cannot write inside it; named `photo.ext.xmp` or an existing own `photo.xmp` (`metadata-read-write.md`, `invariants.md` §2.2).
- **Internal writer / ExifTool writer**: the two metadata write paths (setting `metadataWriter`); same fields, no fallback from one to the other.
- **XMP / EXIF / IPTC**: metadata standards. XMP is the main written format; EXIF holds camera data and orientation; IPTC is also written in JPEG.
- **Pick / reject (flag)**: four states `none`, `pending`, `picked`, `rejected` (`pick_flag`), written in `digiKam:PickLabel`, `xmpDM:pick`, `xmpDM:good`.
- **Colour label / rating**: `xmp:Label` and 0–5 stars (`xmp:Rating` and compatible fields).
- **Read priority**: the user-ordered list of sources for a field (rating, colour, pick, title, GPS, keyword formats, face regions); the first source that holds data wins; a stored 0 is an answer.
- **RAW**: camera files; never demosaiced: the embedded JPEG preview is used.
- **Lossless rotation**: only the orientation tag changes (`orientation.rs`).
- **Orientation / `view_fix`**: `orientation` is the stored tag; `view_fix` is the extra transformation the UI applies because the webview honours only the EXIF tag (`thumbnails-and-previews.md`).
- **Stored image frame**: coordinates relative to the image before EXIF orientation; used by face regions (`faces.md`).
- **Image data hash**: SHA-256 (16 bytes kept) of the bytes that describe the pixels, metadata excluded (`duplicates.md`).

## Catalogue and caches

- **Catalogue**: the SQLite database `photos_library.db` (WAL mode, r2d2 pool).
- **Data dir / storage location**: folder holding the catalogue, caches, models, logs, zones; may be moved (`change_storage_location`).
- **`config.json`**: small settings file needed before the webview loads (data dir, cache size, window state…), in the OS app-config dir.
- **Thumbnail**: small JPEG in the cache (`thumbnails/<2 hex>/<hash>.jpg`) used by the grid. **Preview**: larger image from `raw_previews/` for full screen of RAW / HEIC / video.
- **`PREVIEW_VERSION`**: number in the cache key; bump when thumbnail content changes.
- **`LAYOUT_VERSION` / `ALGO_VERSION`**: versions of the image-data hash (`duplicates.rs`) and of the pHash (`phash.rs`); bump when their rules change, otherwise cached values are wrong.
- **Scope**: the set of photos a search or task covers: selection, a folder (with or without subfolders), the view on screen, or the whole library.
- **All photos**: first node of the folder tree (`renderFolderTree`, `data-all-photos`): no folder filter (`currentFolderFilter === null`) and no album, i.e. the whole catalogue; also a scope of the context menu (duplicates, rescan).
- **Album / smart album**: albums live only in the database; a smart album stores a filter state (`albums.md`).
- **Virtual folder**: an album-tree node that only groups other albums (no photos of its own); it may hold manual and smart albums (`albums.md`).
- **Offline mode**: user setting that forbids every network access from the backend (error `internet_disabled`) and the map tiles of the webview (`architecture.md`).

## Keywords

- **Keyword tree**: hierarchical keywords in `keyword_nodes`; one node is a name under one parent; links in `photo_keywords`.
- **Active keyword**: only the last level of a path is active on a photo; ancestors are written but not "active" (AGENTS.md §5.C, `keywords.md`).
- **Pending keyword**: a keyword edit not yet written to the files; written by Apply, Ctrl+Enter, selection change or closing.
- **Hierarchical formats**: digiKam `TagsList`, Lightroom `hierarchicalSubject`, Media Pro `CatalogSets`, Microsoft `LastKeywordXMP`, ACDSee `categories`; read in user-chosen order.
- **`name_key`**: trimmed lowercase name used to compare names ignoring case.
- **Write circuit**: frontend path `registerEditor` → `applyPending` → `runLocked` → `apply_metadata_changes` (`metadata-read-write.md`).

## Tasks and concurrency

- **Task / queue**: long operations run through `enqueueScanTask` (`main.js`): one per `task_id`, one toast each, listed in the "Running tasks" (hourglass) modal, cancellable (`cancel_scan` flag).
- **Task family** (`familyOf`): grouping that only decides which tasks are refused as duplicates; families do not run in parallel (`main-window.md`).
- **`ready` / `paused` task**: `ready` = finished search waiting for "Show" (duplicates); `paused` = user pause, resumable (`resumeSince`).
- **Semantic lane**: separate queue for content analysis (`pumpSemanticQueue`).
- **`PriorityGuard`**: RAII marker of a foreground task; the semantic scan pauses while one exists.
- **Dirty (face)**: a face edit not yet written to the files.

## Features

- **Face region**: a rectangle (MWG, Microsoft, ACDSee formats) naming a person; **imported / detected / manual** is its origin.
- **Face states**: `unknown`, `auto` (attributed, not yet confirmed), `suggested` ("To confirm"), `confirmed`, `ignored`, `not_face`, `filtered` (`faces.md`).
- **Person**: named identity linked to a keyword node; shown under the keyword's name; **alias** is display-only; **merge** is undoable.
- **Embedding / fingerprint**: vector computed by a model for a face (SFace, 128 values) or a photo (SigLIP 2); stored with `model_id`.
- **Face cluster**: group of similar unknown faces found by DBSCAN ("Group unknowns").
- **Detector / recognizer**: YuNet finds faces, SFace computes fingerprints (`face-detection.md`).
- **ONNX Runtime**: native inference library loaded dynamically and shared by faces and content search; downloaded with the models, not in the installer.
- **Semantic model / content search**: SigLIP 2 embeddings enabling search by description and keyword suggestions (`semantic.md`).
- **Relevance cut**: the slider keeps results whose score is within Δ of the best (`relevance_cut`).
- **Identical / similar / by-name duplicates**: three search kinds; similar uses a 64-bit pHash with Hamming distance (`duplicates.md`).
- **Burst**: photos taken within `burst_ms` of each other (a non-zero gap: same exact time means a copy); left out of similar groups when asked (`similar.rs`).
- **Map mode**: full map of the grid's photos; positions assigned there stay pending until written.
- **`pbmap://`**: custom protocol serving every map resource; the only webview network path (`maps-and-geolocation.md`).
- **Private zone**: place whose tiles are on disk (MBTiles); photos inside use a strict map that never reaches the provider. **Offline map**: a non-private zone.
- **MBTiles**: standard SQLite file of map tiles.
- **Strict map**: map context with no remote requests.
- **Erased location backup**: coordinates saved in `erased_locations` before GPS removal, to allow restore.

## Application

- **Single instance**: a second launch only refocuses the open window.
- **Library sync**: sync of the catalogue with the disk at startup and window focus (`syncLibraryWithDisk`) and the lazy per-photo check (`checkPhotoMissing`).
- **Injection**: feature modules receive services from `main.js` at init instead of importing it (`architecture.md`).
- **`defaults.jsonc`**: the only place for default values of settings (keys = `localStorage` keys); the backend reads its `faceSettings` section and `thumbnailCacheSize`.
- **Recipes**: step lists for common changes (`recipes.md`).
