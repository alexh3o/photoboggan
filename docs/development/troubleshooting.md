<!-- verified: 013e661 | sources: src-tauri/src/main.rs, src-tauri/src/exiftool.rs, src-tauri/src/integrity.rs, src-tauri/src/db.rs -->
# Troubleshooting

Only problems visible in the code. Each entry: symptom → likely cause (named) → how to check → what to do. Entries that rest on a reading of one place only are marked `⚠ unverified`.

## Where to look first

| What | Where |
|---|---|
| Backend messages | `eprintln!` output of the process: run `npm run tauri dev` and read its terminal. No log file for general errors. |
| Frontend errors | Webview console (devtools in dev); many are `console.error` with a French message. |
| User-visible failures | Toasts, the "Hourglass" task list, and failure dialogs of writes (`failureDetailsAction` in `metadata-writes.js`). |
| Write recoveries | `<data dir>/logs/write-recovery_<date>_<time>.log` (`exiftool::write_recovery_log`, one file per operation, `-2`, `-3`… added if the name exists), reported by the dialog after `take_write_recoveries`. |
| Sidecar name conflicts | `<data dir>/logs/sidecar-conflicts_<date>_<time>.log` (`log_sidecar_renames`, main.rs). |
| Settings file | `config.json` in the OS app-config dir (see below). |
| Catalogue | `<data dir>/photos_library.db` (SQLite WAL: `-wal` and `-shm` files beside it are normal). |

`<data dir>` is the default app data folder or `custom_data_dir` from `config.json` (`resolve_app_paths`). More detail: `modules/app-shell.md`.

## Frequent failures

**Metadata write refused, "ExifTool not found".** Cause: writer set to ExifTool (default) and the binary is missing. Search order: path chosen in Settings (`exiftoolPath`) > bundled `exiftool/` resource > `PATH` (`exiftool.rs`, messages "ExifTool introuvable…"). There is **no fallback** to the internal writer, by design (`invariants.md` §2.1). Check Settings > Metadata (`get_exiftool_status`). In a source checkout run `npm run fetch-exiftool` (the binary is not versioned, `src-tauri/vendor/exiftool/`). Fix: install ExifTool, set its path, or switch the writer to "internal" in Settings.

**A write is reported as failed although the file changed.** Cause: after every write the file is re-read and compared (`marking_mismatch`, `text_mismatch`, `regions_mismatch`, `gps_mismatch`); a difference is a failure, never a success (`invariants.md` §1.5). Typical reason: the read-priority order makes another source win (e.g. EXIF read before XMP for GPS, or an existing sidecar read first). Check the priority lists in Settings > Metadata and the failure details dialog.

**ExifTool left a `<file>_exiftool_tmp` or the original seems gone (network share, FAT32 / exFAT).** Cause: ExifTool can delete the original before its final rename fails. `recover_after_failure` restores the only copy and never deletes it; the dialog lists the recoveries and the `logs/write-recovery_*.log` file names the files. If the original still exists the temp is removed; if the state is unclear the temp is kept (tests in `invariants.md` §1.3). Fix: check the log, keep the file it names.

**Keywords / title written to the wrong place, or a sidecar next to a RAW looks unexpected.** Cause: sidecar targeting (`sidecar_target`): `photo.ext.xmp`, or an existing `photo.xmp` that is the image's own; a `photo.xmp` shared by two sidecar-writing images (RAW + DNG, HEIC + MOV) is never written. Check `logs/sidecar-conflicts_*.log` (renames made to avoid conflicts) and `modules/metadata-read-write.md`. HEIC / HEIF are written inside the container (sidecar only as an internal-writer fallback, AGENTS.md §5.D).

**Thumbnail or preview looks stale or wrong after a code change.** Cause: the cache name is a hash of path, size, mtime and `PREVIEW_VERSION` (`thumbnail_cache_file`). After changing what a thumbnail contains, bump `PREVIEW_VERSION` (see `modules/thumbnails-and-previews.md`). To rebuild without losing data, clear the thumbnail cache (`clear_thumbnail_cache`, called only when the cache size is changed in Settings > Storage, after a confirmation; "Remove orphan thumbnails" in the same tab only removes old names, `purge_orphan_cache`); the cache holds only derived files. Never use a flat `read_dir` on the cache (256 subfolders, AGENTS.md §5.B).

**PNG / CMYK JPEG thumbnails drawn by the webview.** Not a bug: the backend fails on some formats and the webview draws the thumbnail and stores it with `save_thumbnail_cache` (`architecture.md`, flow 2).

**Video has no thumbnail on Linux.** Cause: video stills come from the Windows Shell on Windows; elsewhere `video::system_thumbnail` is a stub and the fallback is `ffmpeg`, launched by name (`Command::new("ffmpeg")`, so it must be in the `PATH`; never bundled). Fix: install ffmpeg.

**Offline mode refuses a download: "Offline mode is on (Settings > General)".** Cause: error code `internet_disabled`. The backend flag `INTERNET_ALLOWED` (`face_models.rs`) starts **false** and the UI sets it at startup from `offlineMode`. Affected: face models, semantic model, place search, private-zone downloads, update check and update download. Map tiles in the webview follow `isMapNetworkAllowed()` (`showMap` on and offline off). Check: Settings > General; if the toggle is off but errors persist, the frontend did not send `set_internet_allowed` (see `modules/face-detection.md`).

**Face detection says models are missing.** Codes: `face_models_missing` (a file is absent or has the wrong size), `faces_unsupported_platform` (no ONNX Runtime library published for this OS / architecture: only windows-x86_64 and linux-x86_64). Fix: download in Settings > Faces, or import from a folder (works offline). Files go to `<data dir>/models/`; a download writes `<name>.part` and renames after the SHA-256 matches, so a leftover `.part` is an interrupted download (`modules/face-detection.md`).

**Content search disabled or erroring.** Codes: `semantic_disabled` (feature off, or the frontend has not yet sent `set_semantic_enabled`), `semantic_model_missing`, `semantic_scan_running` (only one analysis at a time), `semantic_photo_not_analysed`, `semantic_empty_query`. The feature is "on" in the UI only if the setting is on **and** the model is installed (`isSemanticEnabled`). On Windows a loaded model file cannot be deleted: stop the scan / disable first (`modules/semantic.md`).

**Analysis seems stuck or slow.** The semantic scan pauses between batches while any foreground task holds a `PriorityGuard` (scans, writes, integrity, face scan, duplicates, thumbnails); its progress events carry a `paused` flag (not the user pause of the task list). Check the Hourglass list.

**A queued task is refused with a toast ("…already in progress or waiting").** Cause: `enqueueScanTask` refusal rules: same `dedupeKey`, or a covering task of the same family (`taskCoversFolder`). Not a failure. Families do not run concurrently; the main lane runs one task at a time (`modules/main-window.md`).

**Update says "no installer", "corrupted" or "changed".** Codes `update_no_installer`, `update_corrupted`, `update_changed`, `update_not_downloaded` (`update_check.rs`): the release lacks an `.msi` / `.deb` with a published SHA-256, the hash differs, the release changed since the download, or nothing was downloaded. Fix: retry the download, or use the GitHub release page. See `modules/updates.md`.

**Private map empty, zone "incomplete" / "failed".** Cause: download stopped at 50 MB or missing tiles (`incomplete`), or failed before any tile (`failed`); `zone_too_large` above 3000 tiles. Re-run the download from the zones window; the old file stays intact until a download completes. A private place never falls back to the provider, so its map stays blank without tiles (`modules/private-zones.md`).

**Place search says it failed.** Needs Internet (not offline) and returns at most 6 results; the provider limit is one request per second (`place_search.rs`). Errors show the HTTP status.

**GPS cannot be erased for some photos.** Codes `gps_in_exif_internal_writer`, `gps_in_exif_sidecar_format`: the GPS is in EXIF and the active writer cannot change it (internal writer, or RAW / PNG / WebP written in a sidecar). Use ExifTool on a JPEG / HEIC (`modules/maps-and-geolocation.md`).

**Face names or keywords are not in the file yet.** Face edits are `dirty` until written (button, Ctrl+Enter, Apply, or on closing the app). "Pending faces" lists them; `discard_pending_face_writes` drops them (`modules/faces.md`).

**Window opens off-screen or does not appear.** The frontend shows the window after its first styled paint; a backend timer shows it after 10 s anyway. At startup `restore_window_state` applies the saved rectangle only if `check_window_visibility` finds it intersecting an active screen (size raised to the 900×500 minimum); otherwise the window is centred at 1024×768.

**App starts with default settings and a lost custom data folder.** Cause: `config.json` was invalid; it is set aside as `config.json.invalid-<seconds>` (never deleted) and defaults are used (`load_config_at_startup`). Fix: repair the copy and put it back, or re-set the storage location. Later writes refuse to start from an invalid file.

**Database: "database is locked" / failures after moving the data folder.** The catalogue is SQLite in WAL mode, accessed only through the r2d2 pool (`AppState.db_pool`, swapped by `change_storage_location`). Cause candidates: a second process on the same file, or code opening its own connection (an anti-pattern, AGENTS.md §7). The connection initializer of `init_db` sets WAL, `synchronous=NORMAL` and cache pragmas but no `busy_timeout` (rusqlite's default of 5 s applies).

## Reproducing with a clean state, without touching photos

1. Point the app to a new data folder (Settings, "Application data location", or a fresh OS user profile): the catalogue, caches, models and zones start empty; photo folders are untouched (the files on disk are the source of truth).
2. Or delete only derived data: thumbnails / previews (change the cache size in Settings > Storage, or delete `thumbnails/` and `raw_previews/` while the app is closed). Do **not** delete `photos_library.db` casually: albums, keyword nodes absent from files, private zone definitions and erased-GPS backups are not rebuildable (`architecture.md`, "Where state lives").
3. For ExifTool tests use `cargo test exiftool:: -- --ignored --test-threads=1`; for semantic parity tests `SEMANTIC_MODEL_DIR=<dir> cargo test semantic:: -- --ignored`.
4. Use copies of photos, never real ones (AGENTS.md §5.I).

## Known issues

The backlog is `TODO.md` at the repository root (owned by the user, do not edit it from docs work). `dev_tools/` holds the author's own notes and is not part of the documentation. There is no list of known bugs in the repository.
