<!-- verified: 4b5d375 | sources: src-tauri/src/db.rs, src-tauri/src/library_sync.rs, src-tauri/src/main.rs, src-tauri/src/tests/db.rs, src-tauri/src/tests/library_sync.rs -->
# Library, scan and database

## Purpose
Keeps the SQLite catalogue (`photos_library.db`) in step with the tracked folders on disk, and serves the photo list to the grid. The catalogue is a rebuildable index of metadata: a scan reads every file once, a cheap incremental sync (`size + modification time`) catches changes made outside the app, and listing commands page, sort and prefilter the rows. Rules shared with other modules (pool only, WAL, `add_column`, scan never reported successful when batches failed): `../invariants.md` §4–5; adding a column: `../recipes.md` recipe 5.

## Files
| File | Role |
|---|---|
| `db.rs` | `init_db` (pool, pragmas, `folders`, `photos`, migrations, every module's `init_schema`), `Photo`, `TrackedFolder`, `PHOTO_COLUMNS` / `photo_from_row`, listing / counting / prefilter SQL |
| `library_sync.rs` | `read_photo` (file → `Photo`), `store_read_batch`, `sync_library`, resume helpers (`read_since`, `already_read`), `is_photo_file`, `SUPPORTED_EXTENSIONS` |
| `main.rs` (region) | Folder commands, scan commands and cancel flags, `run_scan`, `insert_batch`, listing commands, `remove_missing_photos`, `sync_library` command, `is_inside_folder`, `tracked_root_is_reachable` |

## How it works

### Database startup (`db::init_db`)
Opens an r2d2 pool; every new connection runs the pragmas `journal_mode=WAL`, `synchronous=NORMAL`, `temp_store=MEMORY`, `cache_size=-64000`, `mmap_size`. Then `folders` and `photos` are created if missing, columns added after v1 by `add_column` (including `photos.created`, filled by `library_sync::store_dates` for privacy date ranges on undated photos and returned in `Photo` for the List panel, and `photos.effective_modified`, see "Modification dates" below; `add_column` panics on any error other than "duplicate column name", so the app stops rather than run on a half-migrated catalogue), five indexes (`date_taken`, `rating`, `color_flag`, `path`, plus the expression index `idx_path_norm` on `replace(path, char(92), '/')`), and every other module's `init_schema` (keywords, albums, faces, geolocation, duplicates, similar, semantic, private zones, author and rights presets, batch rename recipes; each `expect`s success). The private zones are loaded in memory right away. The pool lives in `AppState.db_pool` and must be fetched with `state.pool()` each time (`change_storage_location` swaps it, see `app-shell.md`). Tables: `../generated/db-schema.md`.

### Scanning a folder
1. **Add**: `add_folder` only inserts the path into `folders` (`INSERT OR IGNORE`: the same folder twice keeps one row). It does **not** scan; the frontend then queues `scan_folder` (one task at a time, see `main-window.md`).
2. **Run** (`run_scan`, shared by `scan_folder`, `rescan_folder`, `rescan_all_folders`): holds a `semantic::PriorityGuard` (content analysis pauses). A blocking thread walks the folder with `WalkDir`, keeping files accepted by `library_sync::is_photo_file` (extension list, plus videos), then reads them in parallel with rayon `par_iter`. Per file: size and modification time from the directory entry, skip if `already_read` (resume), else `library_sync::read_photo`, which runs `exif::read_exif` and then **checks that the file's size and mtime did not change during the read**. Unreadable or changed files are logged and **skipped, never stored with empty metadata**; the next sync will retry them.
3. Each result goes through an `mpsc` channel (capacity 100) to a writer task that accumulates **500 photos** and calls `library_sync::store_read_batch`, then once more for the remainder. The scanner stops reading if the writer disappears (`writer_gone`) or on cancel.
4. `store_read_batch` stores in order: `insert_batch` (one transaction, `INSERT … ON CONFLICT(path) DO UPDATE`), keywords (`keywords::store_photo_keywords`), orientation and faces (`faces::store_photo_faces`), and **only then** the modification dates and `scanned_at` (`store_read_dates`). If any step fails the rows of the batch get `file_size = -1`, so size and date never match the file and the next sync reads them again. The mtime is written last on purpose: otherwise a photo whose keywords or faces failed would look up to date.
5. `run_scan` returns an error if the scan task failed or any batch was not stored (`N lot(s) … n'ont pas pu être enregistrés`): a scan is never reported successful with missing photos.
6. `rescan_folder` first maps the requested path to the real tracked path (`resolve_tracked_folder`, which rejects `..` components; the UI builds paths with `/`, using them directly would store `D:\Photos/2024\a.jpg` and create duplicates). `rescan_all_folders` runs `run_scan` per tracked folder (progress scaled by `ScanMode::Rescan { index, count }`) and, if not cancelled, ends with `purge_orphan_cache` (see `thumbnails-and-previews.md`).
- Progress: event `scan-progress { taskId, percent }`, about every 1 % (approximate, thread order is not guaranteed).
- Cancel: `cancel_scan(task_id)` sets the flag from `scan_cancel_flag` (created by whoever asks first, so an early stop is not lost; orphan flags are dropped after 10 minutes). Photos already read stay in the catalogue. Each command calls `release_scan_cancel_flag` at the end. `running_tasks()` counts flags that are still held.
- Pause / resume: the frontend keeps the time the task first started (`firstStartedAt`) and passes it as `resumeSince`; `read_since` loads the files read since then (`scanned_at >= since`) inside the folder, and `already_read` skips those whose size and mtime are unchanged (and `modified != 0`). They still count in the progress.
- Removing a folder (`db::remove_folder`): one transaction deletes the folder row and the photos inside it that are not also covered by another tracked folder (nested folders), using `is_inside_folder` (case-insensitive, `/`-normalised, so `D:\Photo2` is not inside `D:\Photo`). Sidecars and caches are not touched.

### Incremental sync (`library_sync::sync_library`)
Called by the `sync_library` command (blocking thread, `PriorityGuard`) at startup and when the window regains focus (`syncLibraryWithDisk`, never while a foreground task runs). A global flag `RUNNING` makes a second call return an empty result; `is_running()` makes `change_storage_location` refuse to run meanwhile.
1. Only **reachable** roots are walked (`tracked_root_is_reachable`: the folder exists, or its parent does): an unplugged drive is never taken for deleted photos. `excluded` (folders of paused scans) are skipped entirely, so a sync does not read a paused root in the background.
2. Compare with `photos`: unknown path = added; different size = changed; stored `modified == 0` and same size = date recorded without reading (older catalogues); different mtime = changed. A path seen twice (nested tracked folders) is handled once.
3. A missing path counts as removed only if it lies in a reachable root, is not excluded **and** `fs::metadata` says `NotFound` (a read error during the walk is not enough).
4. Changed files are read by `read_photo` on a 2-thread rayon pool, stored with `store_read_batch`; skipped (unreadable) files are neither stored nor reported. Then the baseline dates are stored and removed rows deleted (`delete_photos`, one transaction). Result `SyncChanges { added, updated, removed, temp_leftovers, temp_leftovers_total, temp_leftovers_log }`; the UI reloads the grid and the keyword tree.
5. **Crash-leftover detection**: during the same `WalkDir` pass (no extra disk scan), `is_crash_temp_entry` spots files/folders matching `*_exiftool_tmp`, `.photoboggan-rename-*`, `.photoboggan-resize-backup-*`, or `.photoboggan-tmp-*` (skipping descent into leftover temp folders). Found items (capped at 50 in `temp_leftovers`, total in `temp_leftovers_total`) are logged once per distinct set to `<data dir>/logs/temp-leftovers-*.txt` (`log_temp_leftovers` in `main.rs`) and surfaced by a non-blocking toast (`notifyTempLeftovers` in `main.js`) without deleting or renaming anything.
- Lazy removal: when the UI cannot display a photo it calls `remove_missing_photos(paths)`; a row is deleted only if its file is `NotFound` and its root is reachable. Sidecar and cache are left (the cache name depends on size / mtime, now unknown).

### Author and rights columns
`photos.author`, `copyright`, `credit`, `usage_terms` and `author_email` (`TEXT NOT NULL DEFAULT ''`, added by `add_column`) mirror the file (`exif::Rights`, filled by `library_sync::read_photo` and `insert_batch`, which also updates them on conflict, and by `keywords::run_write` after a write). Only `author` (index 26), `created` (index 27) and `orientation` (index 28, both exposed for the List panel) are in `Photo` and `PHOTO_COLUMNS`: it travels with the list for the Author filter, and `PhotoPrefilter.authors` filters on it. The other four are `#[serde(skip)]` fields of `Photo` (written by `insert_batch`, never read by `photo_from_row`, never sent with the list) and are read on demand by `rights::get_photo_rights`. This is a variant of recipe 5 for columns the grid does not need. Rows read before the columns existed hold empty strings until a rescan. Details: `metadata-read-write.md`.

### Modification dates (`modified` vs `effective_modified`)
- `photos.modified` is **only the image file's own mtime**: it is the witness of `sync_library`, which compares image files only. A write that goes to a `.xmp` sidecar (RAW, PNG, WebP, videos, HEIC fallback) never changes it, and it is never set to `now()` or to the sidecar's mtime (otherwise the next sync would re-read every sidecar photo).
- `photos.effective_modified` (0 = unknown) is the later of the image's mtime and the mtime of the sidecar the image reads (`exif::active_sidecar`, same choice as `read_sidecar`; `library_sync::effective_modified_millis`). It is filled by `store_dates` whenever files are read (scan, sync, baseline) and set after every successful metadata write (`write_photo_marking`, `rotate_photo`, `keywords::run_write`, `geolocation::write_one`), which return it to the interface.
- Sort by modification date: SQL `db::EFFECTIVE_MODIFIED` = `MAX(COALESCE(modified,0), COALESCE(effective_modified,0))`, so rows read before the column existed (0) fall back to `modified`; the interface uses `photoModifiedTime` (main.js), **same rule, change both together**.
- Not covered: a sidecar edited by another program is not noticed by `sync_library` (it never looked at sidecars); a rescan reads it.

### Listing (`db.rs`, commands in `main.rs`)
- `get_photos_paginated(offset, limit, folderFilter, recursive, sortKey, sortOrder, prefilter)` → `db::get_photos_filtered`; errors are logged and give an empty list. `push_folder_condition` compares a normalised prefix with a range (`>= prefix` and `< folder_upper_bound(prefix)`, keeping `/` and excluding sibling folders with a longer name) so SQLite uses `idx_path_norm` instead of scanning the table. Sort keys: `taken` (default; on the whole catalogue, dated photos first through `idx_date`, then undated ones by id because one `ORDER BY` with an "is dated" expression would lose `idx_date` ~15× slower on 250k photos; on a specific folder, a single query keeps SQLite on `idx_path_norm`), `modified`, `name`. `get_photos_filtered`, `count_photos`, `get_photos_by_paths`, `get_photos_by_ids`, and `get_folder_counts` all append `privacy::visible_condition("")` so active privacy sets hide matching photos.
- `count_photos` uses the same statement shape and returns `None` on error (the UI then shows no number rather than a wrong one). `get_folder_counts` counts photos per direct folder. `get_photos_by_paths` / `get_photos_by_ids` read in chunks of 500 (SQLite variable limit), unknown ids skipped. `list_disk_folders` lists all subfolders on disk under tracked folders (ignores names starting with `.` or `$`, and excludes folders matching `privacy::is_private_folder`) so the tree can show empty folders.
- `PhotoPrefilter` (JS `sqlPrefilter` → Rust, camelCase): filters applied **before** the cut at the limit so a capped list holds the right photos. It must be a **superset** of what the JS filters keep (the JS filters again exactly); mapping per criterion: `filters-and-search.md`.

## Contracts
- IPC: `get_folders`, `add_folder`, `remove_folder`, `scan_folder`, `rescan_folder`, `rescan_all_folders`, `cancel_scan`, `sync_library`, `remove_missing_photos`, `get_photos_paginated`, `count_photos`, `get_folder_counts`, `get_photos_by_paths`, `get_photos_by_ids`, `list_disk_folders` (`../generated/ipc-commands.md`).
- Events: `scan-progress` (`../generated/events.md`).
- Database: owns `folders`, `photos` (`file_size = -1` means "read me again"; `scanned_at` is used only for resume); creates every other table through `init_schema`.
- Settings: none in `localStorage`; resume uses in-memory task state of `main.js`.

## Dependencies
- Uses: `exif::read_exif`, `keywords::store_photo_keywords`, `faces::store_photo_faces`, `semantic::PriorityGuard`, `video::is_video_path`.
- Used by: every module through `state.pool()`; `main.js` (scan tasks, sync, grid paging); `thumbnails` (orphan purge reads the catalogue).

## Invariants and sensitive areas
- ⚠ sensitive: in `store_read_batch` the dates must stay last, and failures must mark `file_size = -1` (test `sync_detects_added_modified_removed_and_never_trusts_a_missing_disk`, `read_photo_refuses_unreadable_or_changing_files`).
- ⚠ sensitive: never delete rows for an unreachable root or on a walk error; `sync_library` and `remove_missing_photos` both re-check (`NotFound`, reachable root).
- ⚠ sensitive: `modified` must stay the image file's mtime; sidecar dates only go to `effective_modified`.
- ⚠ sensitive: `insert_batch` lists every column twice (insert and update); a new `photos` column needs `add_column`, `PHOTO_COLUMNS` + `photo_from_row` (same order), `Photo`, `insert_batch` if file-derived, and a rescan for existing photos.
- ⚠ sensitive: the sync flag `RUNNING` is global: only one test may exercise `sync_library`.
- The prefilter must never be stricter than the JS filter; widen bounds on the JS side, not the other way.

## Tests
`tests/db.rs` (WAL and reopen, upgrade from an old schema, NULL columns, folder filter, `idx_path_norm` query plans and prefix boundaries, counts, sort with undated photos, count = uncapped list, prefilter criteria and "applies before the cut", folder removal, chunked reads) and `tests/library_sync.rs` (extensions, `read_photo` refusals, GPS re-read, sync added / modified / removed with a missing disk, resumed scan, crash-temp pattern matching, external modification timestamp checks). Gap: `run_scan` itself (needs an `AppHandle`) and `scan_folder` / `rescan_*` have no test.

## How to extend
1. New file-derived column: `../recipes.md` recipe 5, then rescan note in the UI changelog if existing photos need it.
2. New supported format: add to `SUPPORTED_EXTENSIONS` (RAW: `thumbnails::RAW_EXTENSIONS`) **and** `format-filters.js` (`../recipes.md` recipe 4); thumbnails / metadata handling per format is in other docs.
3. New listing criterion: add to `PhotoPrefilter` + `prefilter_condition` and mirror it in the JS filter (`filters-and-search.md`).
4. New long task: queue it (`../invariants.md` §6) with `scan_cancel_flag` / `release_scan_cancel_flag`.

## Open questions
none. `rescan_all_folders` passes the same `resume_since` to the `run_scan` of each tracked folder; `read_since` filters by `scanned_at` and `is_inside_folder`, so with nested tracked folders a file already read in this task is skipped in the next folder's pass (without resume it is read twice, which is harmless). Not covered by a test.
