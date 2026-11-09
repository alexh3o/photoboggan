<!-- verified: 36a5686 | sources: src-tauri/src/thumbnails.rs, src-tauri/src/heif.rs, src-tauri/src/video.rs, src-tauri/src/orientation.rs, src-tauri/src/main.rs -->
# Thumbnails, RAW/HEIC/video previews, orientation

## Purpose
Produces the small JPEG thumbnails shown in the grid and the larger previews shown full screen for formats the webview cannot display (RAW, HEIC / HEIF, videos), keeps them in an on-disk cache that follows the files, and decides which way a picture is turned (EXIF / XMP orientation, lossless rotation). Everything is decoded in pure Rust, with the cheapest path: reduced-size JPEG decoding, embedded RAW previews (never demosaicing), one still frame for videos. How the grid asks for and displays thumbnails is in `grid-and-viewer.md`; the cache-name rules shared by all modules are in `../invariants.md` §3.

## Files
| File | Role |
|---|---|
| `thumbnails.rs` | Render pipeline (`render_thumbnail`, `generate_thumbnail`), JPEG / PNG decoding, RAW preview extraction, EXIF sources (`read_exif_sources`), orientation helpers, resize, JPEG writing |
| `heif.rs` | HEIC / HEIF decode (`heic-rs`), preview JPEG, container XMP read / write (`read_xmp`, `update_xmp`, used by metadata writes) |
| `video.rs` | Video extensions, still frame: `system_thumbnail` (Windows Shell) then `ffmpeg_frame_jpeg` |
| `orientation.rs` | Orientation algebra (`compose`, `inverse`, `rotate`), `resolve` (EXIF vs XMP), `read`, `write` |
| `main.rs` (region) | Cache naming and files, thumbnail / preview commands, `keep_cached_images`, `purge_orphan_cache`, `rotate_photos` / `rotate_photo` |

## How it works

### Cache names (`thumbnail_cache_file` in main.rs)
The file name is the 64-bit FNV-1a hash of **source path + file size + modification time (ns) + `PREVIEW_VERSION`**, stored as `<first 2 hex chars>/<hash>.jpg` (256 subfolders). Previews use the same name in their own folder (`raw_preview_cache_file` → `raw_previews/`). Consequences:
- A file that changes (any write) gets a new name; a missing source gives an error (no name).
- Changing what a thumbnail or preview *contains* needs a bump of `PREVIEW_VERSION` (currently `[2]`, a local const in `thumbnail_cache_file`, raised when the EXIF orientation was rewritten into previews). Old files become orphans.
- Listing must use `cache_files` (depth 1–2), writing must create the parent (`write_cache_file`, `write_jpeg_with_quality` do it). No migration from the old flat layout.
- `keep_cached_images(dirs, path, write)` wraps every metadata write: names before and after are computed, and when they differ the files are **renamed** (`carry_cache_file`; deleted if the rename fails) instead of regenerated. A sidecar write changes nothing, so nothing is moved. It also holds a `semantic::PriorityGuard`. ⚠ sensitive: a new write path that skips it forces regeneration of every edited photo.
- `purge_orphan_cache` (button "Delete orphan thumbnails" and end of a full rescan): recomputes the expected names of all catalogue photos (one `metadata` per file, no decoding) and deletes `.jpg` files not in that set, in both folders. It is **postponed with an error** if any tracked folder is unreachable or any catalogue file is unreadable for a reason other than absence (otherwise an unplugged drive would wipe its cache). `clear_thumbnail_cache` empties `thumbnails/` only, counting files it could not delete.

### Grid thumbnail
1. The frontend calls `get_cached_thumbnail_paths(sourcePaths)`: one IPC for many files, result in the same order (`None` = missing).
2. For misses, `generate_thumbnail(sourcePath, maxSide?)`: a semaphore (`THUMBNAIL_GENERATION_GATE`, 6 permits, awaited on the async side) then `spawn_blocking`. If the target file already exists only its size is read (`jpeg_size`); otherwise `thumbnails::generate_thumbnail` under a `PriorityGuard`. It returns `{ path, width, height }` (real size, used for the justified layout). `maxSide` defaults to the configured cache size (`state.thumbnail_cache_size()`, 512 / 768 / 1024 via `set_thumbnail_cache_size`, saved in `config.json`). 512 is the minimum because face detection reads these thumbnails (`face-detection.md`).
3. Any error (PNG, CMYK or 16-bit JPEG, corrupt file) tells the frontend to draw the thumbnail itself; it sends it back with `save_thumbnail_cache` (JPEG data URL, base64-decoded by hand, accepted only if it starts with `FFD8`; an existing file is not replaced). ⚠ sensitive: do not break this fallback (AGENTS.md §5.C).

### Rendering (`render_thumbnail`, also used by the semantic scan, which can write thumbnails it decodes)
- **Video**: `decode_video_frame` (no orientation), then `resize_to_fit`.
- **RAW**: `extract_raw_preview` once, orientation by `raw_display_orientation` of that preview, `decode_scaled_jpeg_reader`.
- **HEIC / HEIF**: `heif::decode` (full decode, the decoder already applies the container rotation, so the EXIF tag is **not** applied again: orientation forced to 1).
- **JPEG and others**: `decode_scaled_rgb`; `jpeg-decoder` DCT scaling decodes at 1/2, 1/4 or 1/8 so a 24 Mpx file is never decoded at full size (target side = 1.5 × `max_side`). Then `resize_to_fit` (area averaging) and `apply_orientation` on the small image.
- **PNG**: not rendered here (`decode_png` exists for the integrity check and other callers); the webview fallback handles the thumbnail. `MAX_DECODED_PIXELS` (250 M) rejects hostile headers before allocation.
- Writing: `write_jpeg` with the quality setting (`normal` = 60, `high` = 84, `set_thumbnail_quality`; applies to new thumbnails only), optimized Huffman tables, temp file then rename. Video and RAW/HEIC full-screen previews are always written at quality 84.

### RAW previews (`extract_raw_preview`)
Order: (1) Fujifilm RAF (`FUJIFILMCCD-RAW`): offset and length of the embedded JPEG at 0x54, validated against the file length; (2) Canon CR3: the `PRVW` box in the first 8 MB (`find_cr3_preview`); (3) TIFF-based formats and fallback: scan the first 12 MB for the largest complete JPEG stream ≥ 20 KB (`largest_jpeg_in`, streams delimited by `jpeg_stream_end`, so an embedded EXIF thumbnail does not end the preview), plus the last 8 MB when the head only gives < 500 KB (Pentax PEF); if no JPEG exists, `tiff_rgb_thumbnail_jpeg` re-encodes an uncompressed 8-bit RGB IFD0 thumbnail (phone DNG, ≤ 16 Mpx). Never a demosaic (AGENTS.md §5.C).

### Full-screen preview: `get_raw_preview_path(sourcePath)`
Returns a cached JPEG path, creating it if missing: video → `generate_video_preview` (side 1280); HEIC → `heif::preview_jpeg` (full-resolution JPEG); RAW → `extract_raw_preview` + `preview_with_orientation` (replaces the EXIF segment with a minimal one carrying the orientation, so the webview turns it like the thumbnail; pixels untouched); other → raw bytes. Written with `write_cache_file`. Videos play only in the OS player (`open_video_externally`).

### Video stills (`video.rs`)
Not the same on every platform: Windows asks the Shell (`IShellItemImageFactory`, same as Explorer, 30 s timeout, uses installed codecs); every platform then falls back to an external `ffmpeg` if it is on `PATH` (20 s timeout, never shipped). Elsewhere `system_thumbnail` is a stub returning an error, so on Linux (and macOS, not distributed) without ffmpeg there is no thumbnail and the grid shows a "play" icon.

### EXIF sources (`read_exif_sources`)
Shared with metadata reading: CR3 uses boxes CMT2 (shooting data, wrapped by `tiff_as_exif_ifd`) and CMT1 (camera, orientation); RAF uses the EXIF of the embedded JPEG; everything else is read directly, leniently (`continue_on_error`, `distill_partial_result`: a malformed RAW IFD keeps the fields read so far).

### Orientation (`orientation.rs`)
- Each orientation (1–8) is "optional mirror, then N clockwise quarter turns", so `compose`, `inverse`, `rotate` are simple.
- `Kind` by format: `Jpeg` (EXIF tag + XMP), `Raw` and `Sidecar` (XMP `tiff:Orientation` of the sidecar wins, file never modified), `Fixed` (HEIC / HEIF, videos: never rotated by a tag).
- `resolve(kind, exif, xmp, skip_exif)` returns `stored` (what a rotation starts from) and `view_fix`. In a JPEG the EXIF tag wins, except with the internal writer when "ignore EXIF" is on (then XMP wins); elsewhere XMP wins over EXIF. `view_fix = compose(inverse(exif), stored)` is what the UI must apply **on top of the webview**, which only applies the file's own EXIF tag; it is 1 for RAW, HEIC and videos (their previews are oriented by the backend). It is stored in `photos.view_fix` (filled by `faces::store_photo_faces`) and applied as a CSS transform in `main.js`.
- Preview orientation of a RAW: `raw_orientation` (preview's own tag, else the container's, depending on whether the preview is portrait), then `raw_preview_orientation` (a sidecar value replaces the container's one).
- `rotate_photos(photos, quarterTurns, taskId?)` (3 threads, queued task or direct) → `rotate_photo`: refuses non-rotatable formats; refuses before writing when the internal writer reads EXIF first and the JPEG already has an EXIF tag (the XMP could not change the display); computes `rotate(read(...).stored, turns)`; `orientation::write` (ExifTool writes EXIF + XMP, internal writes XMP only); **deletes** the cached thumbnail and preview under the old and the current names (they are stored turned); reads the orientation back and fails if it differs; updates `orientation`, `view_fix`, `file_size`, `modified` in the catalogue. Undo is the opposite rotation. Face regions are rotated by `exif::rotate_xmp_regions` (see `metadata-read-write.md`).

## Contracts
- IPC: `get_cached_thumbnail_paths`, `generate_thumbnail`, `save_thumbnail_cache`, `get_raw_preview_path`, `clear_thumbnail_cache`, `purge_orphan_thumbnails`, `set_thumbnail_cache_size`, `set_thumbnail_quality`, `rotate_photos`, `open_video_externally` (`../generated/ipc-commands.md`).
- Events: `scan-progress` during `rotate_photos` with a task id.
- Database: `photos.orientation`, `photos.view_fix` (written by `rotate_photo` and the scan).
- Settings: `thumbnailCacheSize`, `thumbnailQuality` (backend value in `config.json`, read at startup; the frontend keeps its own copy in `localStorage` and calls the setters **only on change**, never at startup), `thumbnailSize` (display only).

## Dependencies
- Uses: `exif.rs` (XMP orientation read / write, regions), `exiftool.rs` (writer, `skip_exif_metadata`), `heif.rs`, `video.rs`, `semantic::PriorityGuard`, `db` pool.
- Used by: grid and viewer (all thumbnail commands), `exif::read_exif` (`read_exif_sources`, `orientation::resolve`), `integrity.rs` (decoding), the semantic scan (`render_thumbnail`), face detection (reads cached thumbnails), `similar.rs` (reads cached thumbnails, never writes), every metadata writer (`keep_cached_images`).

## Invariants and sensitive areas
- ⚠ sensitive: name hash inputs and `PREVIEW_VERSION`; a change without a bump leaves wrong images, a bump without need regenerates the whole cache.
- ⚠ sensitive: the 256-subfolder layout; never `read_dir` a cache flat.
- ⚠ sensitive: HEIC orientation: applying the EXIF tag on top of `heic-rs` output turns pictures twice.
- ⚠ sensitive: `raw_orientation` heuristics (portrait previews, manufacturers that pre-rotate): tests `cr3_reads_orientation_from_cmt1_and_exif_from_cmt2`, `preview_orientation_comes_from_raw_when_preview_has_no_tag`.
- The purge must stay conservative (see above); the cache is rebuildable, but a wrong purge costs a full regeneration.

## Tests
`tests/thumbnails.rs` (CR3 boxes, preview orientation, DNG without JPEG, quality levels), `tests/orientation.rs` (algebra, reading order, `view_fix`, sidecar RAW preview, internal / sidecar rotation, HEIF and video refused), `tests/heif.rs` (synthetic container XMP read / write, refused rewrites, box-walker limits), `tests/main.rs` (cache subfolders, clearing, `cached_images_follow_a_rewritten_file`). Gaps: `generate_thumbnail` end to end on real JPEGs, `purge_orphan_cache`, video frames, and `get_raw_preview_path` are not tested.

## How to extend
1. New RAW family: try `extract_raw_preview` first on a sample; add a branch before the generic scan only if the container needs it; add the extension to `thumbnails::is_raw_path`, `decode_scaled_rgb`, `library_sync::SUPPORTED_EXTENSIONS` and `format-filters.js` (`../recipes.md` recipe 4).
2. Change thumbnail content (size policy, colour handling): bump `PREVIEW_VERSION`.
3. New format decoded in Rust: add to `decode_scaled_rgb`, decide its `orientation::Kind`, and keep the webview fallback for anything that errors.

## Open questions
none. Default cache size: when `config.json` holds none, `.setup` uses `startup_thumbnail_cache_size`, which reads `thumbnailCacheSize` from `src/defaults.jsonc` (`include_str!`, same rule as `faceSettings`), so backend and frontend agree on a new install (test `thumbnail_cache_size_default_is_shared_with_the_frontend`).
