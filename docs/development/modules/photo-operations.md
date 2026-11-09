<!-- verified: none | sources: src-tauri/src/resize.rs, src-tauri/src/integrity.rs, src/photo-actions.js, src-tauri/src/main.rs -->
# Photo operations: menus, copy / move / delete / rename, resize, integrity, marking and rotation commands

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Frontend (photo-actions.js): `initPhotoActions`, `openContextMenuAt`, `showPhotoInfo`, `confirmAndDelete` (`count_permanent_deletions`, `delete_photos`), `renamePhoto`, `copyPhotosTo` / `askCopyResolutions`, `copyPhotosToClipboard`, `resizePhotos`, `openWithFirstProgram`, `revealInFileManager`, `showIntegrityReport`; generic dialogs `createModal`, `confirmDialog`, `promptDialog`.
- File commands (main.rs): `move_photos`, `copy_photos`, `copy_conflicts`, `copy_photos_to_tracked_folder`, `rename_photo`, `rename_folder`, `delete_photos` (OS trash, `has_trash`), `delete_folder`, `create_subfolder`; sidecars follow their file and are never adopted at the destination; drag-and-drop to the tree is in main.js.
- Resize: `resize_photo` (main.rs) → `resize::resize_photo`; queued from JS as a `runner` task (the UI drives the loop).
- Integrity: `integrity_scan` (main.rs, queued `kind: 'integrity'`, `scan-detail` event) → `integrity::run`; report `export_integrity_report` → `integrity::write_report`.
- Marking and rotation commands: `update_photos_marking` (re-read + `marking_mismatch`), `rotate_photos` (→ orientation.rs); their UI is in `grid-and-viewer.md`.
- Other: "Open with" (`pick_program`, `register_existing_programs`, `open_with`: only registered programs may be launched), clipboard (`copy_files_to_clipboard`, `read_clipboard_text` / `write_clipboard_text`), `open_video_externally`.

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
