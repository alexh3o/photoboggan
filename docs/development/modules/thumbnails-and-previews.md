<!-- verified: none | sources: src-tauri/src/thumbnails.rs, src-tauri/src/heif.rs, src-tauri/src/video.rs, src-tauri/src/orientation.rs, src-tauri/src/main.rs -->
# Thumbnails, RAW/HEIC/video previews, orientation

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Commands (main.rs): `get_cached_thumbnail_paths`, `generate_thumbnail` (semaphore of 6 + `spawn_blocking`), `get_raw_preview_path`, `save_thumbnail_cache` (webview fallback), `clear_thumbnail_cache`, `purge_orphan_thumbnails` (`purge_orphan_cache`), `set_thumbnail_cache_size`, `set_thumbnail_quality`. Frontend side: `grid-and-viewer.md`.
- Cache naming and moves: `thumbnail_cache_file` (FNV hash of path + size + mtime + `PREVIEW_VERSION`, 256 subfolders), `raw_preview_cache_file`, `cache_files`, `write_cache_file`, `keep_cached_images` / `carry_cache_file` (rename after a metadata write). See `invariants.md` §3.
- Generation (thumbnails.rs): `generate_thumbnail` → `render_thumbnail` (scaled JPEG decode `decode_scaled_jpeg_reader`, PNG `decode_png`, RAW via `extract_raw_preview` / `find_cr3_preview` / `largest_jpeg_in`, HEIC via `heif::decode`, video via `decode_video_frame`), `resize_to_fit`, `apply_orientation`, `write_jpeg_with_quality` (quality 60 / 84, `set_high_quality_thumbnails`).
- Video (video.rs): `system_thumbnail` (Windows Shell; error elsewhere) then `ffmpeg_frame_jpeg` (optional external ffmpeg, 20 s timeout). HEIC (heif.rs): `decode`, `preview_jpeg`, `read_xmp` / `update_xmp` (also used by metadata writes).
- Orientation (orientation.rs): `resolve` (EXIF vs XMP priority, `skip_exif`), `read`, `write`, `rotate`, `compose`, `raw_preview_orientation`; DB column `view_fix` for what the webview cannot apply. The rotation command `rotate_photos` is in main.rs.
- Trap: never demosaic a RAW; bump `PREVIEW_VERSION` when a thumbnail's content changes; 512 px minimum cache size because face detection reads these thumbnails.

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
