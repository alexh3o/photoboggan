<!-- verified: 984f5c1 | sources: AGENTS.md, src-tauri/src/exif.rs, src-tauri/src/exiftool.rs, src-tauri/src/db.rs, src-tauri/src/thumbnails.rs, src-tauri/src/library_sync.rs, src-tauri/src/main.rs, src/main.js -->
# Business rules and invariants

Cross-cutting rules only: module-specific rules live in the "Invariants" section of each `modules/` doc. Each rule says why it exists, where it is enforced (by name), which test covers it (`generated/tests.md`) and what breaks if it is violated. The short form of these rules is in `AGENTS.md`; this file explains them.

## 1. Photo protection

**1.1 Image data is never rewritten.** Only metadata changes. Internal JPEG writes rebuild the file segment by segment (`jpeg_replace_xmp`, `jpeg_replace_iptc`, `jpeg_replace_comment` in exif.rs) and copy everything else unchanged; no decode / re-encode ever happens on a user file. Other formats get a sidecar; HEIC / HEIF get their XMP updated inside the container (`heif::update_xmp`), with a sidecar fallback when the structure does not allow it; ExifTool writes HEIC in the file directly (AGENTS.md §5.C).
- Tests: `raw_gets_a_sidecar_and_the_original_is_never_modified` (exif), `jpeg_is_written_without_touching_pixels` (exiftool, ignored), `sidecar_rotation_leaves_the_image_file_untouched` (orientation).
- Broken if violated: quality loss on the user's originals, irreversible.

**1.2 Never a partially written file.** Every replacement goes through a temporary file, then a rename once the write succeeded.
- Internal writer: `write_file_atomically` (exif.rs) writes `<file>.photoboggan-tmp`, `sync_all`, renames, removes the temp on any error.
- ExifTool: always `-overwrite_original` (`fn overwrite`, exiftool.rs), never `-overwrite_original_in_place`. A new sidecar is created as `<image>.photoboggan-tmp.xmp` then renamed (`write_to`).
- Also applied to non-photo files: `config.json` (`save_config`), cache files (`write_cache_file`).
- Tests: `atomic_write_replaces_without_leftover`, `atomic_write_failure_cleans_up_and_keeps_target`, `failure_is_an_error_and_leaves_no_residue` (ignored).

**1.3 After an ExifTool failure, never delete the only copy.** ⚠ sensitive. ExifTool may delete the original before its final rename fails (FAT32 / exFAT / network shares). `recover_after_failure` (exiftool.rs) deletes `<file>_exiftool_tmp` **only if the original still exists**; if the original is gone it renames the temp back (`Restored`), and if that fails or the state is unclear it keeps the temp and reports it (`OnlyCopyKept`, `TempKept`). Recoveries are collected (`take_recoveries`), logged in `<data dir>/logs/` and shown in one blocking dialog by `metadata-writes.js` (`reportWriteRecoveries` → `take_write_recoveries`).
- Tests: `only_copy_left_by_exiftool_is_restored_never_deleted`, `temporary_file_is_kept_when_the_original_state_is_unclear`, `nothing_to_do_without_temporary_file`, `recoveries_of_one_operation_go_to_a_single_timestamped_log_never_overwritten`.

**1.4 One write at a time per file.** `exiftool::path_lock` (16 striped mutexes keyed by path hash) is taken by both writers (`write_to` for ExifTool; `write_metadata` / `write_xmp_metadata` for the internal path). Keyword / title / description writes also take the global `WRITE_LOCK` (keywords.rs). Test: `same_path_writes_are_serialised_and_other_paths_are_not_blocked`, `concurrent_writes_to_one_file_leave_a_valid_file` (ignored).

**1.5 A failed write is never shown as a success.** Every write is followed by a re-read and a comparison: `marking_mismatch` (rating / colour / pick, `update_photos_marking`), `text_mismatch`, `regions_mismatch`, `gps_mismatch` (`keywords::run_write`). The catalogue reflects the re-read, not the request.

**1.6 No sidecar for a file that is gone.** `write_xmp_sidecar_with` and `exiftool::write_to` return `image_gone` if the image disappeared meanwhile (an orphan sidecar would remain). Test: `no_sidecar_is_created_for_an_image_that_is_gone`.

**1.7 Deletion goes through the OS trash** (`trash::delete` in `delete_photos`, the sidecar follows its file). On Windows, removable, network, optical and RAM drives and UNC paths have no trash (`has_trash`): there the deletion is permanent, and `count_permanent_deletions` lets the UI say so in the confirmation before anything happens. On other systems `has_trash` always answers true.

## 2. Metadata interoperability

**2.1 Two writer paths, same fields.** `exif::write_metadata` and `exif::write_xmp_metadata` dispatch on `exiftool::is_enabled()` (setting `metadataWriter`, pushed by `set_metadata_writer`). ExifTool writes the same XMP / IPTC fields as the internal path plus the EXIF fields of JPEG (XPKeywords, XPTitle, XPComment, ImageDescription, UserComment). The field list is in the doc comment of `exiftool::write_metadata`. Any new field must be added to **both** (`metadata_args` and `update_xmp_all` / `jpeg_replace_iptc`), see `recipes.md`.
- **No fallback**: if ExifTool is selected but not found, `exiftool::run` fails ("écriture refusée") and nothing is written by the internal path. Silently switching writers would produce files that differ from what the user configured.

**2.2 Sidecar targeting** (`sidecar_target`, `read_sidecar`, `sidecar_candidates` in exif.rs; the only place where sidecar names are built). An image writes `photo.ext.xmp`, or an existing `photo.xmp` that is its own. A `photo.xmp` shared with another sidecar-writing image (RAW + DNG, HEIC + MOV…) is never written: the image gets its own `photo.ext.xmp`, seeded from `photo.xmp`. RAW + JPEG: `photo.xmp` stays the RAW's. An image reads one sidecar only, never two merged.
- ⚠ sensitive: a mistake here silently writes one photo's keywords into another's sidecar. Tests: `existing_compatible_sidecar_is_reused`, `shared_compatible_sidecar_is_never_written_each_image_gets_its_own`, `raw_and_jpeg_pair_keeps_writing_the_compatible_sidecar`, `removal_alone_does_not_create_a_sidecar`, `sidecar_names_replace_only_the_last_extension`, `shared_compatible_sidecar_is_copied_never_written` (ignored), `a_moved_or_copied_photo_never_adopts_a_sidecar_already_at_the_destination` (main).

**2.3 Reading priority is user-defined and "first source with data wins".** Rating, colour, pick, title, description, GPS and the 5 hierarchical keyword formats each have an ordered list of sources (`*_SOURCE_IDS`, `*_PRIORITY`, `set_read_priority`, `HIERARCHY_IDS` in exif.rs), sent by the frontend at startup. A value 0 is an explicit answer; only an absent value falls through. A new order applies to files read afterwards (rescan). Settings are Rust statics: a test that changes them must be the only one doing so (AGENTS.md §5.H).

**2.4 After any write, the file is re-read and the catalogue stores what was read**, so the database never claims a value the file does not hold (see 1.5).

## 3. Caches and version numbers

**3.1 Thumbnail / preview cache name** = FNV-1a hash of (source path, file size, modification time, `PREVIEW_VERSION`) (`thumbnail_cache_file`, main.rs), stored as `<first 2 hex chars>/<hash>.jpg`. Consequences:
- Changing what a thumbnail or preview contains requires bumping `PREVIEW_VERSION`, otherwise old images stay in use.
- A metadata write changes size and mtime: `keep_cached_images` renames the cached files to their new names instead of regenerating them. Any new write path must go through it.
- Listing the cache must use `cache_files` (two levels); writing a cache file must create its parent directory (`write_cache_file` does). Test: `cache_files_are_spread_over_subfolders_and_listed_recursively`.
- Orphans (old names) are removed by `purge_orphan_cache` (button in Settings, and end of a full rescan).

**3.2 Hash layouts.** `duplicates::LAYOUT_VERSION` (which bytes of a file are hashed) and `phash::ALGO_VERSION` (perceptual hash algorithm) are stored with each cached hash; rows with another version are ignored. Changing the hashed bytes or the algorithm **requires** a bump, otherwise duplicate results are silently wrong. The semantic index also re-analyses rows "with another hash version" (it stores `duplicates::LAYOUT_VERSION` as `hash_version`, so a layout bump also re-analyses images; test `rows_without_a_hash_or_with_another_hash_version_are_analysed_again_then_hashed`). Embeddings carry their `model_id`.

## 4. Database

- **Pool only**: every catalogue access goes through `state.pool()` (r2d2). Never keep a connection across an `.await`, never open `photos_library.db` directly. (MBTiles files of `private_maps.rs` are separate SQLite files opened with `rusqlite::Connection::open`; that is not the catalogue.)
- **WAL**: set in the connection initializer of `init_db` (`journal_mode=WAL`, `synchronous=NORMAL`). Test: `catalog_uses_wal_and_reopens_without_losing_data`.
- **Schema evolution** without migration files: tables are `CREATE TABLE IF NOT EXISTS` (in `init_db` or a module's `init_schema` called from it); new columns use `db::add_column`, which ignores "duplicate column name" and **panics** on any other error (startup stops rather than running on a half-migrated catalogue). Columns are never dropped or renamed. New columns filled from files need a rescan for existing photos.
- **Storage change**: `change_storage_location` swaps the pool inside `AppState.db_pool`; code must call `state.pool()` each time, never cache a pool in a static.

## 5. Library scan and sync

- A scan is never reported successful when photos were not stored (`run_scan` returns an error if a batch failed). A file unreadable or changing during the read is skipped, never stored with empty metadata (`library_sync::read_photo`); it is retried by the next sync.
- The incremental sync (`sync_library`) compares size + modification time only; it runs at startup and when the window regains focus, never while a foreground task runs (`syncLibraryWithDisk`, main.js). Its global flag (`library_sync::RUNNING`) means only one test may exercise it.
- Photos missing on disk are removed lazily, when displaying them fails (`checkPhotoMissing` → `remove_missing_photos`), and only if their tracked folder is reachable.

## 6. Long tasks

- Every scan, rescan, integrity check, copy / move / resize, keyword write of 20+ photos, face detection, model download, duplicate search, private-zone download, update download and content analysis goes through `enqueueScanTask` (main.js), never a bare `invoke` with its own progress UI.
- Each task has a unique id (`scan-<time>-<n>`) passed as `taskId`; the backend reports progress with `scan-progress` for that id and checks `scan_cancel_flag(task_id)`; it must call `release_scan_cancel_flag` when done. A stopped task keeps what was done (no rollback) and must leave no half-installed file.
- Heavy backend work runs in `spawn_blocking` / rayon, never in a plain `#[tauri::command] fn` (main thread).

## 7. Offline mode

The backend flag starts false and is set by `set_internet_allowed`; every backend download checks `internet_allowed()` and fails with `internet_disabled`; the webview's map tiles check `isMapNetworkAllowed()`. Details: `architecture.md`. A new network access that skips the check breaks the promise that offline mode sends nothing.

## 8. Portability

Code must build and run on Windows and Linux. Platform-specific code is isolated behind `#[cfg(windows)]` / `#[cfg(not(windows))]` pairs, e.g. `hide_console_window` and `bind_to_app_lifetime` (exiftool.rs), `video::system_thumbnail` (Windows Shell; a stub elsewhere, with an optional `ffmpeg` in the PATH as fallback on every platform), installer launch (`msiexec` / `xdg-open`, `install_update`). Paths come from Tauri (`app.path()`) and `PathBuf`; no shell (cmd.exe, PowerShell) and no registry. The `windows` crate is a Windows-only dependency (`Cargo.toml`).

## 9. Configuration file

`config.json` is never overwritten from an invalid state: at startup an unreadable file is set aside as `config.json.invalid-<seconds>` and defaults are used (`load_config_at_startup`); later writes refuse to start from an invalid file (`load_config` returns an error). Losing it would lose the custom data directory, i.e. the user's catalogue location.
