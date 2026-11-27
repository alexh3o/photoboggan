<!-- verified: 5daf187 | sources: src-tauri/src/import.rs, src/import-view.js, src/import-settings.js, src/import-view.css -->
# SD Card and Folder Import

## Purpose

Imports photos and videos from removable media (SD cards, USB drives) or external folders into photoboggan's tracked library folders without ever modifying or deleting source files. Provides event-driven media detection (zero CPU at rest), two-pass source scanning, RAM-only thumbnails/previews, chronological copy with collision handling, and chained post-import workflows.

## Files

| File | Role |
|---|---|
| `src-tauri/src/import.rs` | Schema (`import_devices`, `import_history`, `import_presets`), OS device watcher (`WM_DEVICECHANGE` / `inotify`), two-pass source scan, RAM-only thumbnail/preview streaming, saved recipe CRUD, chronological copy reusing `main.rs` primitives, targeted indexing (`index_imported_photos`), disk space & ejection |
| `src/import-view.js` | Dedicated `#import-view` full-content mode (isolated from `loadedPhotos`), retained-node virtualized list/grid with prioritized thumbnail queue, right-column preview click, LRU Blob URL cache, saved recipes UI, destination/subfolder/collision UI, and post-import task chaining |
| `src/import-settings.js` | Settings > Storage > Import controls, backend watcher sync (`set_import_watcher_config`), `.mode-group` toolbar toggle/badge (`syncImportToolbarButton`), arrival toast, and device/history management modal |
| `src/import-view.css` | Layout and theme styles for `#import-view`, `--kind-*` folder icons, and report/device modals |

## How it works

1. **OS device detection (zero polling at rest)**: `set_import_watcher_config` starts/stops a dedicated OS watcher thread (hidden top-level window for `WM_DEVICECHANGE` on Windows — never `HWND_MESSAGE` which misses broadcasts; `inotify` + `poll` on Linux) when `importAutoDetect` is enabled. Drives overlapping any tracked library folder are excluded. Photo media are recognized in O(1) via user-editable marker paths (`DCIM`, `PRIVATE/M4ROOT`, `MP_ROOT`, `AVCHD`) and filtered by `importDeviceListMode` (`blacklist` / `whitelist`). Arrival/removal diffs the `(media_id, root_path, eligible)` snapshot before emitting `import-media-changed`. `identify_source` also classifies the source via `detect_storage_kind` (`"removable"`, `"internal"`, `"network"`).
2. **Two-pass source scan**:
   - **Pass 1 (`scan_import_source_fast`)**: `WalkDir` metadata-only scan builds folder counts/kinds and checks already-imported status against `import_history` (`(relative_path, file_size, file_mtime)`) and `photos` (`(filename, file_size)`) with zero SD content reads.
   - **Pass 2 (`read_import_source_exif`)**: runs on at most 2 rayon threads, reading `date_taken` & `orientation` via pure-seek `thumbnails::read_fast_exif_fields` (~4–64 KB per file instead of loading full 40+ MB RAWs) and streaming `import-exif-progress`. The UI updates mounted rows in place and re-sorts once on completion. Ambiguous `new` candidates matching a library `date_taken` are disambiguated via `duplicates::quick_partial_hash`.
3. **RAM-only thumbnails & previews**: `get_import_thumbnail` (4-permit semaphore, prioritized 4-slot frontend queue, retained DOM nodes) calls `thumbnails::render_fast_import_thumbnail_bytes` (header-seek embedded JPEG extraction for TIFF/CR3/RAF RAWs and JPEG EXIF IFD1 thumbnails, zero 12 MB linear scan when header tags exist, single-pass JPEG encoding, plus `ACTIVE_IMPORT_THUMBS` yielding in Pass 2 EXIF so thumbnails never contend with background EXIF reads). `get_import_preview` returns up to 1600 px JPEG bytes via `tauri::ipc::Response` -> `Blob` URLs (`LRU` max 300, revoked on eviction/close). SD files are never passed to `convertFileSrc` or written to disk caches.
4. **Copy & post-import pipeline**:
   - `startImport` sorts selected files chronologically, optionally runs `check_import_conflicts` + `askImportConflictResolutions`, enqueues `kind: 'import'` (`run_import_copy`) plus `blocked: true` placeholders in `task-queue.js` (`cancelTasksByGroup` / `updateWaitingTask` / `triggerTaskPumps`).
   - `run_import_copy` (`run_import_copy_with` / `run_import_copy_with_ops`) reuses `resolve_tracked_folder`, `reserve_destination`, `copy_atomically_to_reserved_verified`, `copy_replacing_verified`, `copy_sidecar`, `files_have_same_hash` (for videos when Integrity is enabled — verified on the flushed temp file *before* `replace_file_via_trash` or final rename), and `log_sidecar_renames`, deduplicating source paths, skipping `same_file`/`same_folder` targets, validating path lengths & canonical containment inside `dest_root`, lazily creating target subfolders (pruned if empty on copy failure), and committing `import_history` + `import_devices` incrementally every 10 files.
   - On copy completion: offers card ejection (`eject_media`), indexes only copied files (`index_imported_photos`), and unblocks enabled post-import tasks in fixed order: Batch Rename (`rename_photos`) -> Integrity (`integrity_scan` with `paths`) -> Faces (`detect_faces`) -> Duplicate Hashes (`precompute_hashes`) -> Content Analysis (`semantic_scan`, hidden when `!isSemanticEnabled()`). Skipped/failed/suspect items surface via `keepTaskReady` ("Import report").

## Contracts

- IPC commands: `list_detected_media`, `set_import_watcher_config`, `check_destination_info`, `eject_media`, `identify_source`, `scan_import_source_fast`, `read_import_source_exif`, `get_import_thumbnail`, `get_import_preview`, `check_import_conflicts`, `run_import_copy`, `index_imported_photos`, `list_import_devices`, `set_import_device_policy`, `delete_import_device`, `purge_import_history`, `list_import_presets`, `save_import_preset`, `delete_import_preset` (`../generated/ipc-commands.md`).
- Events: `import-media-changed`, `import-exif-progress`, `scan-progress` (`../generated/events.md`).
- Database: `import_devices`, `import_history`, `import_presets` (`../generated/db-schema.md`).
- Settings: `importAutoDetect`, `importAutoOpen`, `importMediaMarkers`, `importDeviceListMode`, `importHistoryRetention30d`, `importLastDestination`, `importRecentDestinations`, `importFavoriteDestinations`, `importViewMode`, `importThumbnailLayout`, `importThumbnailSize`, `importSidebarWidth`, `importDestWidth`, `importPreviewWidth`, `importShowPreview`, `importIncludeSubfolders`, `importHideEmptyFolders`, `importAutoSelectNew`, `importSortKey`, `importSortOrder`, `importGroupBy`, `importCollisionPolicy`, `importSubfolderMode`, `importCustomSubfolder`, `importSplitByType`, `importSubfolderRaw`, `importSubfolderRaster`, `importSubfolderVideo`, `importPostRename`, `importPostRenamePreset`, `importPostIntegrity`, `importPostFaces`, `importPostHashes`, `importPostSemantic` (`../generated/config.md`).

## Dependencies

- Uses: `main.rs` durable copy/conflict/sidecar/cancel primitives, `thumbnails.rs` RAM JPEG encoding, `duplicates::quick_partial_hash`, `library_sync::read_photo` & `store_read_batch`, `privacy::is_private_folder`, `date-filter.js` (`createDateFilterControl`), `batch-rename-engine.js`, `task-queue.js`, `photo-actions.js`.
- Used by: `main.js` (view mode & menus), `photo-actions.js` ("Import photos here…").

## Invariants and sensitive areas

- ⚠ sensitive: Never write, rename, or delete files on the source media, and never pass source paths to `convertFileSrc` (WebView file locks block ejection on Windows).
- ⚠ sensitive: `#import-view` must stay isolated from `loadedPhotos`/`photos` and main-window keyboard shortcuts.
- ⚠ sensitive: `run_import_copy` must only write inside `resolve_tracked_folder` (verified lexically, canonically, and within OS path-length limits), never overwrite `same_file` / `same_folder` sources, verify video SHA-256 on the temp file before replacing or finalizing, and reuse existing atomic copy/replace primitives.
- ⚠ sensitive: `eject_media` (`validate_eject_target`) must refuse volumes that overlap any tracked library folder, the app data directory, or an active import source.
- ⚠ sensitive: Content analysis post-import option must stay hidden and trigger zero IPC when `!isSemanticEnabled()` (AGENTS.md §5.I).

## Tests

`src-tauri/src/tests/import.rs` (19 tests: schema/device policy, history retention purge, purge device timestamp reset, fast scan counts & memory/library matching, subfolder volume-root history matching, ambiguous partial-hash match, subfolder target computation, chronological copy with collision/incremental history, video SHA-256 verification on valid copy, SHA-256 failure in replace mode preserving original with no temp, SHA-256 failure in rename mode cleaning up empty subfolder/temp, same source/destination protection, skip policy creating no empty dated subfolders, mid-batch cancellation preserving partial history, target path length/containment & `validate_eject_target` guardrails, targeted indexing, import presets CRUD/upsert, fast TIFF RAW & JPEG EXIF thumbnail extraction, pure-seek EXIF reader & storage kind detection) + `integrity_scan_with_explicit_paths_checks_only_listed_files` in `tests/integrity.rs`. Gap: OS device watcher events and OS-level `eject_removable_volume` ioctl/udisksctl calls are not unit-tested.

## How to extend

1. New subfolder pattern: add option in `index.html` (`#import-subfolder-mode`), `compute_target_dir` (`import.rs`), and `updateTargetPreview` (`import-view.js`).
2. New post-import task: add checkbox + `defaults.jsonc` key, enqueue blocked placeholder in `startImport`, and unblock with copied/renamed paths or IDs after `index_imported_photos`.
3. New device policy rule: update `collect_detected_media` (`import.rs`) and `import-settings.js`.

## Open questions

none.
