<!-- verified: none | sources: src-tauri/src/faces.rs, src/faces-panel.js, src/faces-grid.js, src/persons-view.js -->
# Faces: data, review, people (faces.rs and UI)

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Data: `faces::init_schema` (tables in `generated/db-schema.md`), regions read from files during scans (`PhotoFaces`, `store_photo_faces`), setting `set_face_reading`; the sections of faces.rs are listed in `code-map.md`.
- Review commands: `get_persons`, `get_photo_faces`, `get_faces_for_photos`, `confirm_faces`, `assign_faces`, `set_faces_unknown`, `ignore_faces`, `mark_faces_not_a_face`, `snapshot_faces` / `restore_faces` (undo), `cluster_unknown_faces`, `recognize_faces`.
- Writing to files: `plan_face_write` decides regions + person keywords for a photo; written through `apply_metadata_changes` (keywords.rs) with `faces: true`; `get_pending_face_writes`, `discard_pending_face_writes`, `face_keyword_conflicts` (frontend `resolveFaceKeywordConflicts` in metadata-writes.js), `erase_face_data`.
- People: `rename_person`, `set_person_alias`, `set_person_hidden`, `set_person_cover`, `delete_person` / `delete_persons`, `merge_persons` / `undo_person_merge`, `link_person_keyword`, `add_manual_face`.
- Frontend: `initFacesPanel` (setting, People section, person filter, face overlays `layoutFullscreenFaces`), `initFacesGrid` / `openFacesView` (virtual grid of faces), `initPersonsView` / `openPersonsView`.
- Trap: regions are stored in the frame of the stored image (before EXIF orientation, column `orientation`). Detection and models are in `face-detection.md`. Tests: `tests/faces_db.rs` (included from faces.rs).

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
