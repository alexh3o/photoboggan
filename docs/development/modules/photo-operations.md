<!-- verified: dae2f14 | sources: src-tauri/src/resize.rs, src-tauri/src/integrity.rs, src/photo-actions.js, src-tauri/src/main.rs, src-tauri/src/batch_rename.rs, src/batch-rename.js, src/batch-rename-engine.js -->

# Photo operations: menus, copy / move / delete / rename, resize, integrity, marking and rotation commands

## Purpose

Everything the user does to photo *files* from menus and drag-and-drop: rename, move, copy, delete (to the trash), resize copies, open with another program, copy to the clipboard, verify file integrity, and write rating / colour / pick. Each operation keeps three things consistent: the file, its `.xmp` sidecar, and the catalogue row (same `id`, so rating, keywords and albums survive a move). The rules on never touching pixels, atomic replacement and sidecar naming are in `../invariants.md` §1–2; the metadata writers themselves are in `metadata-read-write.md`.

## Files

| File               | Role                                                                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.rs` (region) | `update_photos_marking`, `rename_photo`, `rename_folder`, `delete_photos`, `delete_folder`, `move_photos`, `copy_photos*`, `resize_photo`, "Open with", clipboard, `integrity_scan`, sidecar helpers, durable copy / move helpers |
| `resize.rs`        | One-photo resize to a new JPEG / PNG, keeping selected metadata                                                                                                                                                                   |
| `integrity.rs`     | Decodes every file of a folder to detect corruption and fills missing thumbnails; report and CSV export                                                                                                                           |
| `batch_rename.rs`  | Batch rename backend: planning (collisions, sidecars, lengths), execution (swaps, undo), saved recipes table and commands                                                                                                         |
| `batch-rename.js`  | Batch rename dialog (steps editor, saved recipes, paginated preview), task / direct run, undo; `batch-rename-engine.js` is the pure recipe engine (testable with Node)                                                           |
| `photo-actions.js` | Context menus (thumbnail, folder, text field), generic dialogs (`createModal`, `confirmDialog`, `promptDialog`), and the UI flow of every operation above                                                                         |

## How it works

### Names that never overwrite

- `reserve_destination(dir, name)` atomically creates an empty file with `create_new` at the first free name (`photo.jpg`, `photo (1).jpg`…). A name is also skipped when `sidecar_already_taken` says a sidecar not belonging to this photo is already there (`photo.jpg.xmp`, or a `photo.xmp` with no image of that name): otherwise the moved photo would read someone else's metadata and its own sidecar could not be carried. Such renames are reported in `renamed_for_sidecar` and written to a log in `<data dir>/logs/` (`log_sidecar_renames`). The caller then replaces the placeholder (copy, move) and removes it on failure.
- `reserve_new_file` does the same for sidecars; a sidecar that appeared meanwhile stays untouched.
- `validate_new_name`: one level, no Windows-forbidden characters, no reserved names (CON, NUL…), no trailing dot or space, so the name is valid on every OS.

### How sidecars follow

- `photo.ext.xmp` always belongs to that one file and moves / renames / is trashed with it.
- `photo.xmp` (compatible name) may be shared by a RAW + JPEG pair: it is **copied, never moved**, when another file of the same stem exists (`has_same_stem_sibling`), moved / renamed otherwise; deletion (`sidecar_to_trash`) trashes it only when no sibling remains. `IMG.2024.cr2` never targets `IMG.xmp` (names are built by `exif::sidecar_candidates` only).
- A failure to carry the sidecar is reported (`Sidecar XMP non déplacé / non copié`) but the photo operation stands.

### Move (`move_photos`, drag-and-drop to the tree)

Queued task with `task_id` (`FileTaskProgress`: progress weighted by file size, cancel checked between files; files already moved stay moved). Per file: must be in the catalogue; a photo already in the destination is `skipped`; per-file lock `exiftool::path_lock` (a metadata write finishes first); `reserve_destination`; `move_file` = `rename`, else durable copy (`copy_durably`: flush to disk) + optional **SHA-256 verification of the copy** (setting `verifyCrossDriveMoves`, sent with `set_verify_cross_drive_moves`, default on; a mismatch deletes the copy and keeps the original) + delete source; `move_sidecar`; cache files are renamed to the new cache name (`carry_cache_file`, the name depends on the path); catalogue `UPDATE photos SET path, filename, file_size, modified` in a transaction after deleting any row already at the new path. If the file moved but the row did not, the photo is reported failed and the next sync fixes the catalogue. The UI updates open editors (`photosMoved` in `metadata-writes.js`). Destination must be a tracked folder or inside one (`resolve_tracked_folder`).

### Copy (`copy_photos`, `copy_photos_to_tracked_folder`, `copy_conflicts`, `tracked_copy_conflicts`)

Same task wrapper. The UI first asks for conflicts (`copy_conflicts` lists files whose name already exists, with sizes and dates; `askCopyResolutions` shows the dialog), then sends `resolutions` per source path: `replace`, `skip`, or `rename` (default). A photo copied into its own folder is never a conflict: it is always renamed. `replace` goes through `copy_replacing` (temp file `.photoboggan-tmp`, flush, rename: the old or the complete new file, never a partial one) and overwrites the sidecar too. Copies into a tracked folder are not added to the catalogue here: the UI then runs `sync_library`.

### Rename and delete

- `rename_photo`: keeps the extension (`IMG.2024.cr2` + `vacances` → `vacances.cr2`), refuses an existing name except a case-only change (`same_existing_file`), checks the sidecar can follow **before** renaming, takes `path_lock`, keeps the row `id`, renames cache files. `rename_folder` renames a subfolder of a tracked folder in place and updates every row under it (ids kept, cache files renamed); it refuses a tracked folder (or one containing one) and the app data folder, like `delete_folder`.
- `delete_photos`: only photos of the catalogue; `trash::delete` for the file, then its sidecar; on a trash failure the photo stays and the failure is reported, **never a permanent fallback**. A file already gone only loses its row. Cache files are removed. The row is deleted after the trash; if the row delete fails, the failure is reported. `delete_folder` / `is_folder_empty` / `get_folder_unrecognized_files` ask the user first about files the app does not catalogue; `delete_folder` is refused while any privacy set is active (`privacy::is_active()`) to prevent hidden photos inside from being trashed unseen.
- `has_trash(path)` (Windows): false for UNC paths and drives of type removable, network, optical or RAM (`GetDriveTypeW`); true elsewhere and on other OSes. `count_permanent_deletions` counts paths without trash; `confirmAndDelete` (JS) uses it to word the confirmation ("Permanently delete…" / "some… permanently deleted") **before** anything happens. It refuses while a metadata write runs (`isWriteLocked`), because ExifTool could recreate a trashed file.

### Batch rename (`batch_rename.rs`, `batch-rename.js`, `batch-rename-engine.js`)

F2 or "Rename…" of the context menu on **several** photos (one photo keeps the plain `rename_photo` flow above).

- **Recipe (frontend only).** Ordered steps, each applied to the result of the previous one, on the name without extension: *start blank* (erases the current name; at most once, always forced to the first place by `normalizeSteps`, offered only while the recipe does not have it; used alone it leaves empty names, which are refused like any other empty name), *replace* (case-sensitive, empty search refused, optional n-th occurrence), *insert* (position counted from the start or the end, clamped to the name), *delete* (start, length, direction; a step that would leave nothing, or go beyond the name, leaves that photo unrenamed and reports it). Texts hold variables `{filename}` (original name), `{date_taken(format;default)}`, `{camera(default)}` (EXIF model), `{lens(default)}`, `{counter(digits;start)}`, `{author(format;space;separator;default)}`; parameters are separated by `;`, `\` escapes the next character, unspecified parameters are empty. Dates use ISO 8601 symbols (`YYYY MM DD hh mm ss`, `T` kept as is; `yyyy dd HH SS` accepted); the format is required. `{counter}` follows the grid order and the whole recipe is refused when `digits` cannot hold the number of photos. `{author}` gives initials (`Jean-Pierre Dupont` → `JpD`) or full names. Characters a file name cannot hold are removed from variable values; invalid literal text is a recipe error. `batch-rename-engine.js` has no DOM or Tauri import, so it can be tried with plain Node. The backend never replays a recipe: it receives `{ path, newName }` pairs.
- **Dialog (`openBatchRename`).** Steps editor (drag handle, ↑ ↓, tooltip help), saved recipes (table `rename_presets`: `name_key` is the lower-cased name, saving under an existing name replaces it, steps stored as JSON), example line on the last selected photo, preview list of before → after (10 per page). The preview asks `preview_rename_batch` (debounced, stale answers ignored) so collisions with files on the disk, long paths and sidecar conflicts show before applying. Refused while `isWriteLocked()` or a file task runs. From 20 photos the batch is a queue task (`kind: 'rename'`, in `FILE_TASK_KINDS`, never resumed after a restart, its paths protected from metadata writes like a move); below, it runs at once under `photoMoveRunning`.
- **Planning (`plan_batch`, no disk change).** Each name is re-validated (`validate_new_name`, name and full path length: 255 and 259 units on Windows). Collisions are compared ignoring case: two photos to the same name, a target held by a file of the batch that keeps its name or fails, or by an existing file outside the batch → **none** of the files concerned is renamed, the rest of the batch goes on (a failed photo keeps its name and can block another, so this repeats until stable). Swaps and chains are allowed. Sidecars follow: `photo.ext.xmp` always moves; a shared `photo.xmp` moves once when every file that reads it goes to the same new name, is copied otherwise (the last copy target receives the file itself when all readers leave); two sidecars of different origin reaching the same name, or a name already taken, switch to `photo.ext.xmp`; a photo without sidecar does not adopt a stray one under its new name.
- **Execution (`execute`).** One unit = photo + sidecar, rolled back together if the sidecar fails. Units wait for their target to be free; when nothing can move (swap, case-only change on Windows) one unit is **parked** under `.photoboggan-rename-<pid>-<n><ext>` (same extension, so it stays a photo for the catalogue; its moved sidecar becomes `<temp>.xmp`; its catalogue row follows, `db_path`) and finishes later. Stop is honoured between units, never while a unit is parked. Per unit: `exiftool::path_lock`, `reserve_new_file` for the targets, rename, then catalogue update in a transaction (same row `id`) and `carry_cache_file` for the thumbnail and the RAW preview (their names depend on the path). Everything else (albums, keywords, faces, hashes, semantic data) is tied to `photo_id`, size and mtime, which a rename keeps.
- **Result and undo.** `renamed` (`from` / `to`), `unchanged`, `failed` (`path`, stable `code`, `detail`; `code` is translated by the UI), `not_processed` (stopped). `finishBatch` updates the grid with `applyMovedPhotos` (a photo object is renamed once per call, so chains and swaps are safe), pushes an undo entry (Ctrl+Z, or the toast button) that runs the reverse batch through the same backend, and keeps the failures in the tasks window as a `ready` task ("Show errors" opens the usual failures dialog, "Dismiss" removes the entry; `keepTaskReady`), instead of a toast that closes by itself. Stopping a batch keeps what was done; Ctrl+Z undoes it.

### Marking and rotation commands

- `update_photos_marking(photos, rating, colorFlag, pickFlag, taskId?)`: each photo may carry its own values (undo); all values are validated before any write (one invalid value refuses the batch); 3 rayon threads; per photo `write_photo_marking`: `keep_cached_images` + `exif::write_xmp_metadata`, then **read back** with `exif::read_marking` + `marking_mismatch`; on a difference the photo fails and the catalogue is untouched;  otherwise one transaction updates `rating`, `color_flag`, `pick_flag`, `file_size`, `modified` (image file's own mtime) and `effective_modified` (later of the image's and active sidecar's mtime). Direct command or queued task, result { `written`, `dates`, `failed`, `cancelled` } (`dates`: { `id`, `effective_modified` } pairs).
- `rotate_photos`: see `thumbnails-and-previews.md` (orientation section). UI of both: `grid-and-viewer.md`.

### Resize (`resize_photo`, `resize.rs`)

The UI drives the batch (`runResizeBatch`: up to 4 parallel `invoke('resize_photo')` calls, one per photo, stop checked between photos, conflict questions asked one at a time with "apply to all"). Options: max side or percent (never enlarges), JPEG quality or PNG compression, keep metadata, `clearMarks` (drop rating / colour / pick; sent only with ExifTool on), destination folder (default: the photo's folder), optional relative folder hierarchy below the chosen destination (the most-specific tracked root is used per photo; nested output folders are created only when writing), suffix, conflict policy `ask` / `replace` / `increment` / `skip`. The destination is remembered for the next dialog; the "Last destination" button restores it. The hierarchy preference is remembered with the other resize settings and defaults to off. Flow: validate, `target_path` (`<stem><suffix>.jpg|png`), refuse when the target is the source (`is_same_file`), resolve the conflict **before** computing (a skip or question costs no encoding), `render` (JPEG decoded at reduced scale when the target is much smaller; PNG; RAW via the embedded preview; HEIC via `heic-rs`; area-average resize; EXIF / XMP / IPTC / ICC copied from a JPEG source with patched size and orientation), write to `.photoboggan-resize-*.tmp` + flush, then under `COMMIT_LOCK` resolve the conflict again (another file of the batch may have taken the name) and rename. **Replace** sends the existing file to the trash (`trash::delete`) and refuses to replace when that fails. Result `done` / `conflict` / `skipped`; new files in tracked folders join the catalogue through the UI's sync.

### Integrity (`integrity_scan` → `integrity::run`)

Queued task (`kind: 'integrity'`), events `scan-progress` and `scan-detail` (current folder). Every file of the folder is decoded (JPEG at reduced scale plus `check_jpeg_structure` for truncated progressive files, PNG with CRC / end check, WebP, HEIC, RAW via embedded preview only); failure = suspect; a decoder that panics counts as a failure; a file that does not answer within `FILE_TIMEOUT` (120 s, e.g. dead network share) is reported suspect. A missing thumbnail is written from the already decoded image; an existing one is left alone. Videos, GIF, BMP, AVIF are counted as "not verified", never as corrupt. Threads = half the cores (2–6); heavy decoders (PNG, WebP, HEIC) are limited to 2 at once (`HEAVY_DECODES`). The catalogue is not modified. `export_integrity_report` writes a `.txt` (preamble + CSV) and never overwrites.

### "Open with", reveal, clipboard

- `open_with(program, paths)` only launches a program that the **backend itself** registered: `pick_program` opens the OS dialog from Rust and adds the chosen path to `config.json` (`open_with_programs`, only grows; `PROGRAMS_CONFIG_LOCK`); `register_existing_programs` imports an older list once. Otherwise a script running in the page could launch any executable. Files must exist; the process is spawned directly with the paths as arguments, no shell.
- `reveal_in_file_manager` and `open_folder_in_file_manager` use the opener plugin; `open_video_externally` (catalogued videos only). `copy_files_to_clipboard` (file list via `clipboard-rs`; the context is kept in a static so the Linux X11 process keeps serving it), `read_clipboard_text`, `write_clipboard_text`.

### Frontend (`photo-actions.js`)

`initPhotoActions(options)` receives the app services (`api`); menus are built by `openThumbnailMenu` (single and multiple selection), `openFolderMenu`, `openTextFieldMenu`; `openContextMenuAt` lets other modules reuse the menu. Dialog helpers are exported for other modules. Per-section "Open with" program lists (`programSection`, stored in localStorage and drag-reorderable) are only a UI list: the real permission is the backend allow-list.

## Contracts

- IPC: file commands above; list in `../generated/ipc-commands.md` (`move_photos`, `copy_photos`, `copy_conflicts`, `copy_photos_to_tracked_folder`, `tracked_copy_conflicts`, `rename_photo`, `rename_folder`, `preview_rename_batch`, `rename_photos`, `list_rename_presets`, `save_rename_preset`, `delete_rename_preset`, `delete_photos`, `delete_folder`, `count_permanent_deletions`, `create_subfolder`, `resize_photo`, `integrity_scan`, `export_integrity_report`, `update_photos_marking`, `rotate_photos`, `open_with`, `pick_program`, `register_existing_programs`, `reveal_in_file_manager`, `copy_files_to_clipboard`, `set_verify_cross_drive_moves`).
- Events: `scan-progress`, `scan-detail`.
- Database: `photos` rows (`path`, `filename`, `file_size`, `modified`, `effective_modified`, `rating`, `color_flag`, `pick_flag`, `orientation`, `view_fix`); `rename_presets` (`id`, `name`, `name_key` unique, `steps` JSON); `config.json` open_with_programs.
- Settings: `verifyCrossDriveMoves`, per-section program lists, resize dialog values (`loadResizeSettings`; `../generated/config.md`).

## Dependencies

- Uses: `exif.rs` (writes, `sidecar_candidates`), `exiftool::path_lock`, `thumbnails.rs` (decoders, `resize_area`), `heif.rs`, cache helpers (`thumbnails-and-previews.md`), `library_sync`, `trash`, `clipboard-rs`.
- Used by: `main.js` (shortcuts, marking UI, file/folder operations), `drag-drop.js` (drag-and-drop move/copy to folder tree), keywords / faces modules (they reuse the dialogs), the semantic scan (`PriorityGuard` pauses during all of these).

## Invariants and sensitive areas

- ⚠ sensitive: never overwrite (reserved names, `copy_replacing`, trash before replace); tests `a_moved_or_copied_photo_never_adopts_a_sidecar_already_at_the_destination`, `a_reserved_name_is_never_taken_twice`, `replacing_copy_and_sidecar_overwrite_leave_no_temporary_file`.
- ⚠ sensitive: shared `photo.xmp` must be copied, not moved or deleted, while a sibling exists.
- ⚠ sensitive: a catalogue update must follow the file operation in the same call; a failure in between is reported and left to `sync_library`, never presented as success.
- ⚠ sensitive: the batch rename never overwrites and never leaves a photo apart from its sidecar; collisions (ignoring case) rename none of the files concerned; a parked file is never left under a temporary name by a stop request; the catalogue row follows a parked file (otherwise a swap would delete a row). Known limits: undoing a shared `photo.xmp` that became `photo.ext.xmp` restores `photo.ext.xmp` names, not the original sidecar; a crash in the middle of a swap (or of a case-only change on Windows) can leave a file named `.photoboggan-rename-*` : it is still a catalogued photo under that name, with its sidecar, nothing is lost, it only has to be renamed back by hand.
- ⚠ sensitive: the "Open with" allow-list is the only barrier against launching arbitrary programs.
- `has_trash` changes the wording of the deletion dialog: a new delete path must call `count_permanent_deletions` first.
- ⚠ sensitive: `delete_folder` must refuse while `privacy::is_active()` is true so photos hidden by privacy sets are not deleted unseen.

## Tests

`tests/main.rs` (12: durable copy keeps attributes, replacing copy leaves no temp, move cost between drives, sidecar adoption, rename onto the same file, reserved names, cache follow), `tests/batch_rename.rs` (swaps and chains, case-only change, collisions ignoring case, existing files, invalid / missing / duplicated items, length limits, own / shared / conflicting sidecars, stray sidecar, catalogue row and id, stop, undo, saved recipes), `tests/integrity.rs` (12), `tests/resize.rs` (6: longest side, never enlarged, PNG output, metadata copied only when asked, conflict policies ask / skip / increment, refusals; "Replace" untested because it uses the real trash). Gaps: no test of `delete_photos`, `has_trash`, `rename_photo`, `rename_folder`, `update_photos_marking` (they need an `AppHandle` / `State`), nor of the frontend.

## How to extend

1. New file operation: queue it (`../invariants.md` §6) with `FileTaskProgress`, lock the file with `exiftool::path_lock`, reserve names with `reserve_destination`, carry the sidecar and the cache files, update the catalogue in one transaction, and report failures per file.
2. New context-menu entry: add it in `openThumbnailMenu` (and its shortcut in `main.js`); i18n keys in `en.json` / `fr.json`.
3. New resize option: `ResizeOptions` (serde camelCase) + `resizeOptionsDialog` + `loadResizeSettings`.
4. New batch rename step or variable: `batch-rename-engine.js` (`checkStep` + `applyStep`, or `VARIABLES` with `check` / `value`), its dialog fields in `batch-rename.js`, error codes in `recipeErrorText`, keys in `en.json` / `fr.json`. A new backend failure code goes in `batch_rename.rs` (and `backendFailureText`).

## Open questions

none. PNG outputs of `resize.rs` carry only the ICC profile (`encode_png`); EXIF / XMP / IPTC are copied into JPEG outputs only.
