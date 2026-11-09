<!-- verified: d9de6cb | sources: src-tauri/src/faces.rs, src/faces-panel.js, src/faces-grid.js, src/persons-view.js -->
# Faces: data, review, people (faces.rs and UI)

## Purpose
Faces are the face regions of a photo and the people they belong to. photoboggan imports the regions written by other software (MWG, Microsoft, ACDSee), lets the user review and name faces (including faces found by the detector, see `face-detection.md`), and writes the named regions plus a keyword per person back into the files. The catalogue holds the working state; the files stay the source of truth for what other tools see.

## Files
| File | Role |
|---|---|
| `faces.rs` | XMP region parsers, schema (`init_schema`), import (`store_photo_faces`), review / person / write-plan commands. Sections are `// ----` banners (settings, parsing, database, UI commands, faces view, writing, grouping, persons, merge, manual regions). |
| `faces-panel.js` | Settings > Faces, People section of the sidebar, person filter (AND / exclude), face overlays in full screen and preview (`layoutFullscreenFaces`, `layoutPreviewFaces`), person menu, detection settings and scan dialog (`openFaceScanDialog`), `initFacesPanel`. |
| `faces-grid.js` | "Faces" management view: virtual grid of face tiles grouped by status, actions, undo, pending-write mode (`openFacesView`, `initFacesGrid`). |
| `persons-view.js` | People view: one big tile per person, search, size slider (`openPersonsView`, `initPersonsView`). |
| `tests/faces.rs`, `tests/faces_db.rs` | Region parsing; import and write-plan tests. |

## How it works

**Coordinates.** A face is `x, y, w, h` normalised (0–1), top-left corner, in the frame of the **stored** image, i.e. before EXIF orientation (the MWG / Microsoft frame). Column `orientation` / `view_fix` of `photos` is stored beside it; the UI applies the orientation when drawing (`orientRect`, `faceCropStyle` in faces-panel.js). ⚠ sensitive: never store display-frame coordinates.

**Face states** (`faces.state`): `unknown`, `auto` (attributed by recognition, awaiting review), `suggested` ("To confirm"), `confirmed`, `ignored`, `not_face`, `filtered` (rejected by the size / confidence / sharpness thresholds, hidden everywhere except the Faces view filter). Origin (`faces.origin`): `imported`, `detected`, `manual`. Only `confirmed` faces are ever written to files.

**1. Import during a scan.** `set_face_reading` (setting `faceReading`, sent at startup and on change) turns reading on; when off, `PhotoFaces.regions` is `None` and the faces tables are not touched. `exif::read_exif` returns `PhotoFaces` (format priority `REGION_PRIORITY`, set with `set_read_priority` kind `faces`; parsers `mwg_regions`, `mp_regions`, `acdsee_regions`). The scan/sync writer calls `store_photo_faces` after inserting photos and keywords (`library_sync.rs`, `keywords::run_write`). Per region, in one transaction:
1. match an existing face by overlap (`face_detect::iou` ≥ 0.5);
2. a face with `dirty = 1` (user change not yet written) is left alone;
3. an `imported` face is updated from the file: a named region → person of that name + `confirmed` (unless `ignored` / `not_face`); an unnamed region turns a `confirmed` face back to `unknown`;
4. a `detected` / `manual` face matched to a region keeps its data, except when another program renamed it;
5. no match → new `imported` face (`confirmed` if named, else `unknown`);
6. imported, non-dirty faces absent from the file are deleted; detected ones stay.
Then `auto_link_person` links each touched person to the keyword node of the same name when that node is unique and free. `mark_geometry_change` sets `photo_face_scans.needs_review` when the width / height ratio changed by more than 1 % since the scan (crop or pixel rotation).

**2. Review (Faces view).** Actions are IPC commands that only change the database and set `dirty = 1` when a confirmed face changes: `confirm_faces`, `assign_faces` (name: existing person, keyword node, or new name → new person + keyword under `facePersonRoot`; `resolve_person`), `set_faces_unknown` (`unknown_locked = 1`: recognition no longer proposes the face; the refused person goes to `rejected_person_id`), `ignore_faces` / `unignore_faces`, `mark_faces_not_a_face` / `unmark_faces_not_a_face`, `delete_faces`, `add_manual_face` (drawn in full screen). After each action the frontend re-runs `recognize_faces` (embeddings only, no ONNX). Undo (Ctrl+Z): `snapshot_faces` before the action, `restore_faces` after; it recomputes `dirty` so a restored face already written is rewritten. `cluster_unknown_faces` groups unknown faces (DBSCAN over embeddings at the auto threshold, min 2 points).

**3. Write to files.** Edits wait ("Faces pending", Write button, Ctrl+Enter, Apply of the right panel, or closing the app: `getPendingFaceWriteCount`). `get_pending_face_writes` lists photos with a dirty face or a row in `photo_face_writes` (a photo whose named face disappeared). The frontend calls `apply_metadata_changes` with `faces: true`; `keywords::run_write` calls `plan_face_write` (regions = confirmed faces named after the linked keyword, else the person name; keywords = photo's or user's list + the keyword of each present person − keywords previously added by recognition whose person left), writes, re-reads and compares (`regions_mismatch`), then `finish_face_write` (records recognition-added keywords in `face_keywords`, clears `dirty` and `photo_face_writes`). `discard_pending_face_writes` re-reads the files and drops the unwritten changes; `erase_face_data` deletes faces and scans of photos and queues their regions for removal.

**4. Keyword conflict.** Before applying a keyword list, `metadata-writes.js` `resolveFaceKeywordConflicts` calls `face_keyword_conflicts`: a keyword removed from a photo while a confirmed face of its person remains opens the dialog Keep / Set the face as unknown (`set_faces_unknown`) / Cancel.

**5. People.** `get_persons` (with photo counts and cover), `get_face_index` (photo → persons, for the filter). A person linked to a keyword (`persons.keyword_node_id`) is displayed and written under the keyword's name: renaming goes through the keyword (`rename_person` returns `person_linked`); `link_person_keyword` changes the link; `set_person_alias` is display only, never written. `set_person_hidden`, `set_person_cover`, `delete_person(s)` (`person_delete_info`, `get_persons_without_faces`). `merge_persons` journals the absorbed person in `person_merges` / `person_merge_faces` so `undo_person_merge` can restore it. Covers: `get_person_cover` crops the cover face from the original file into `<data dir>/person_covers/<person>-<hash>`; the name changes with face, cache size and file, so a stale cover is never served.

## Contracts
- IPC commands: all above, in `generated/ipc-commands.md` (search `faces.rs`). Error codes returned as strings: `invalid_name`, `unknown_person`, `unknown_keyword`, `person_name_taken`, `person_linked`, `keyword_taken`, `invalid_region`, `unknown_photo`.
- Events: none (progress of scans comes from `face_detect.rs`).
- Database: `persons`, `faces`, `photo_face_scans`, `face_keywords`, `photo_face_writes`, `person_merges`, `person_merge_faces` (created in `faces::init_schema`, called by `db::init_db`), reads `keyword_nodes`, `photo_keywords`, `photos`; see `generated/db-schema.md`.
- Settings: `faceReading`, `faceDetection`, `faceSettings`, `facePersonRoot`, `faceScanFilter`, `fullscreenFacesVisible`, `faceIgnoredShown`, `faceNotFaceShown`, `personsSort`, `personsTileSize`, `facesViewStatuses`; see `generated/config.md`.

## Dependencies
- Uses: `keywords.rs` (`name_key`, `ensure_node`, `run_write`), `exif.rs` (region read/write, `RegionsUpdate`), `face_detect.rs` (`iou`, thresholds), `face_recognize.rs` (attribution, DBSCAN, `MODEL_ID`), `metadata-writes.js` (`applyPending`, `choiceDialog`), `photo-actions.js` (menus, dialogs).
- Used by: `library_sync.rs` / `keywords.rs` (`store_photo_faces`, plan / finish), `main.js` (person filter, overlays, startup settings).

## Invariants and sensitive areas
- ⚠ sensitive: the **file is the truth for imported regions**, except `dirty` faces; losing the `dirty` guard in `store_photo_faces_in` lets a rescan erase unwritten user work. Test: `rereading_a_file_updates_faces_without_duplicating_them`.
- ⚠ sensitive: `auto` / `suggested` faces must not be written (`plan_face_write` filters `state = 'confirmed'`). Test: `auto_faces_are_not_written_until_confirmed`.
- ⚠ sensitive: person ↔ keyword link. Keyword removal or rename must keep it consistent (`unlink_missing_keywords` at startup; keywords.rs handles rename / delete). Names cannot contain `/`, `|`, `,` (`valid_person_name`).
- Persons with no face are kept on purpose (they can wait for an assignment); cleanup is user-triggered.
- Rename, merge, delete mark the affected confirmed faces `dirty` in one transaction, otherwise files keep the old name.
- A database error in `store_photo_faces` is reported by `false` and nothing is stored half-way (`database_failure_is_reported`).

## Tests
`tests/faces_db.rs`: three tests (error reporting, re-reading without duplicates, auto faces not written); `tests/faces.rs` (4 tests, region parsing). Not covered: merge / undo, `restore_faces`, conflicts, `discard_pending_face_writes`, clustering, covers.

## How to extend
1. New face state: add it to the `STATUSES` list of `faces-grid.js`, to the filters of `get_photo_faces` / `get_faces_for_photos`, and decide whether `plan_face_write` writes it.
2. New region format: add a parser beside `mwg_regions`, an id in `REGION_SOURCE_IDS`, the order list in Settings (see `metadata-read-write.md`) and the write side in `exif.rs`.
3. New column on `faces`: `db::add_column` in `init_schema` (recipes.md, new column) and include it in `FaceSnapshot` if it is review state.
4. New action in the Faces view: backend command that sets `dirty`, snapshot / restore pair for undo, `generate_handler!` entry.

## Open questions
none. Checked: `get_faces_for_photos` is called only by `faces-grid.js`, `get_face_scan_index` only by `faces-panel.js`; `store_photo_faces` has two callers, `library_sync::store_read_batch` (scan / sync) and `keywords::run_write` (after a write, `face_batches`).
