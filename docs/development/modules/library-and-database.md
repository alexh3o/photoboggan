<!-- verified: none | sources: src-tauri/src/db.rs, src-tauri/src/library_sync.rs, src-tauri/src/main.rs, src-tauri/src/tests/db.rs, src-tauri/src/tests/library_sync.rs -->
# Library, scan and database

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Schema and pool: `db::init_db` (WAL pragmas, `photos` / `folders`, `add_column` migrations, then every module's `init_schema`); `Photo`, `PHOTO_COLUMNS`, `photo_from_row`, `PhotoPrefilter` (SQL prefilter for large catalogues).
- Scan of a folder (main.rs): `add_folder` (no scan) → queued `scan_folder` / `rescan_folder` / `rescan_all_folders` → `run_scan`: WalkDir + `library_sync::is_photo_file`, rayon `par_iter` + `library_sync::read_photo`, `mpsc` channel to a writer storing batches of 500 with `library_sync::store_read_batch` (→ `insert_batch` in main.rs, keywords, faces).
- Pause / resume: `resume_since` + `library_sync::read_since` / `already_read` skip files read since the first start (frontend: `pauseTask` / `resumeTask` in main.js).
- Incremental sync: `library_sync::sync_library` (size + mtime only, EXIF re-read with 2 threads, global `RUNNING` flag), called by the `sync_library` command from `syncLibraryWithDisk` (main.js, startup and window focus). Lazy removal: `remove_missing_photos` (only under a reachable tracked root).
- Listing: `get_photos_paginated`, `count_photos`, `get_photos_by_paths` / `get_photos_by_ids`, `get_folder_counts`, `list_disk_folders` (main.rs).
- Trap: a scan never reports success if a batch failed; an unreadable file is skipped, never stored empty (see `invariants.md` §4–5).

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
