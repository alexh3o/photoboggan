<!-- verified: a9ca28f | sources: src-tauri/src/keywords.rs, src/keywords-panel.js, src/description-panel.js -->
# Hierarchical keywords and description

## Purpose
Lets the user organise photos with a tree of keywords (e.g. `Places / France / Paris`) and edit the title and description of the selection. The tree and the photo ↔ keyword links live in the catalogue, but the files remain the truth: edits stay pending in the right panel, are written into the files on Apply, then the files are re-read and the catalogue stores what was actually read. `keywords.rs` also hosts `run_write`, the one batch writer shared by keywords, title, description, faces and GPS.

## Files
| File | Role |
|---|---|
| `keywords.rs` | Tree and link tables, `run_write` (batch write + verify + catalogue update), create / rename / delete keyword, `set_metadata_read_order` |
| `keywords-panel.js` | Keywords tab of the right panel: checkbox tree, pending state, input with suggestions, context menu, create / rename / delete dialogs |
| `description-panel.js` | Description tab: title and description fields, same pending → Apply circuit |
| `metadata-writes.js` | The write circuit both tabs register in (see `metadata-read-write.md`) |

## How it works

### Data model (`keywords.rs` header)
- A node = one name under one parent (`parent_id` 0 = first level); two siblings never differ only by case (`name_key` = trimmed lowercase, `UNIQUE(parent_id, name_key)`). Homonyms under different parents are different keywords.
- A photo "carries" a keyword when a `photo_keywords` row exists. **Only the last level of a path read from a file is active**; ancestors are active only if the file lists them on their own.
- The tree grows when files are read: `store_photo_keywords` (called by `library_sync::store_read_batch` for every scan / sync batch) inserts missing nodes with `ensure_node` and replaces the photo's links by those of the file. It is one transaction per batch and returns false on error, so the caller does not consider those photos read. The tree is never pruned automatically (a node with no photo stays).
- Which format of the file wins (digiKam, Lightroom…) is decided at read time (`metadata-read-write.md`, order sent with `set_metadata_read_order`, kind `keywords`).
- Reading: `get_keyword_tree` (flat list, the UI rebuilds the tree), `get_photo_keyword_ids` (pairs photo / keyword for the selection), `get_keyword_usage` (photo count per keyword).

### Applying edits: `apply_metadata_changes` → `run_write`
Input: `KeywordWriteItem { photo_id, path, keyword_ids?, title?, description?, faces?, gps? }`; every field optional, absent = untouched, empty title / description = remove. Optional `task_id` for progress and cancel.
1. `WRITE_LOCK` (global mutex) and `semantic::PriorityGuard` (content analysis pauses) are taken: one batch at a time for keywords, rename, delete.
2. The tree is loaded once (`nodes`) so paths can be computed (`node_path`). Items whose `id` + `path` pair is not in the catalogue fail with "Photo absente du catalogue"; duplicates of one photo are merged (last value per field).
3. Faces: a photo with `faces == true` or with face changes pending (`faces::has_pending_face_write`) gets a plan from `faces::plan_face_write` (regions to write, person keywords to add or remove). A planning error fails that photo only. See `faces.md`.
4. Files are written by a rayon pool of **3 threads**: each item checks the cancel flag, turns ids into paths (an id missing from the tree **fails the photo**, ignoring it would silently remove the keyword), builds a `MetadataUpdate` and calls `exif::write_metadata` inside `keep_cached_images` (thumbnails and previews are renamed to follow the changed file, not regenerated). `scan-progress` is emitted per file.
5. Verification, in one catalogue transaction: the file is re-read with `exif::read_exif`; keywords (`normalized_paths`, case-insensitive), title / description (`text_mismatch`), face regions (`regions_mismatch`: same count and names) and GPS (`geolocation::gps_mismatch`) must match what was requested, otherwise the photo is a failure and **the catalogue is not touched** (the next sync rereads the file). On success `photos.keywords / title / caption / file_size / modified` (and GPS) are updated from the re-read, `finish_face_write` records faces, and `store_photo_keywords_in` refreshes the links. A face DB error marks the photo `file_size = -1` so the next sync rereads it.
6. Commit, then `semantic_keywords::on_keywords_changed()` (always after the commit, never before) so suggestions are rebuilt. If the commit fails every written photo is reported as failed. `faces::store_photo_faces` runs last.
Result `KeywordWriteResult { written (with the keyword ids stored after re-read), failed, cancelled, deleted, unlinked_persons }`. `written.keyword_ids` can differ from the request because faces may add or remove person keywords.

### Create, rename, delete
- `create_keyword(parent_id, name)`: `validate_name` (not empty, none of `/ | ,`; error `invalid_name`), then `unknown_parent` or `duplicate`. The tree changes at once; activating it on photos is a normal pending edit.
- `rename_keyword` → `run_rename`: renames the node **first** (paths written to files come from the tree), marks the confirmed faces of the linked person `dirty`, then rewrites every photo carrying the keyword or a descendant with an unchanged set (`photos_carrying`) through `run_write`. Already up-to-date files are untouched, so "Retry" after a failure only rewrites what remains. A rename that changes only the case is allowed.
- `get_keyword_delete_info` gives the counts for the confirmation; `delete_keyword` → `run_delete`: persons linked to the subtree are unlinked first (otherwise writing their faces would put the keyword back), photos are rewritten without the subtree, and `delete_subtree` removes nodes, links and `keyword_suggestion_rejections` **only if no photo failed and nothing was cancelled**. Otherwise the persons are relinked (`restore_person_links`) and the keyword stays. On success `unlinked_persons` lets the UI offer to delete those persons.
- Both go through `runLocked` in the UI: from 20 photos they are queued tasks (see `metadata-read-write.md`).

### Keywords panel (`keywords-panel.js`)
- State: `baseline` (stored ids per selected photo, from `get_photo_keyword_ids`) and `working` (pending copy). Checkbox: all selected photos carry it = checked, some = partial. Click toggles for all selected photos; Shift also activates ancestors / deactivates descendants (`toggleKeyword`); "Unify" gives every photo the union (`unifySelection`); "Reset" returns to `baseline`. `dirtyIds` lists photos to write.
- `refreshKeywordsPanel` is called on selection change (deferred to one per frame, only when the tab is visible). With edits pending, `resolvePendingSelection` (`metadata-writes.js`) asks Apply / Ignore / Cancel. Counter `reloadToken` drops stale answers; `writeEpoch` redoes a read that overlapped a write. After files are re-read by a sync, `invalidateKeywordTree` bumps `treeVersion`; the saved state is reloaded and pending edits are rebased on it (`rebase`), so Apply does not erase what another program added.
- Registers `keywordEditor` in `metadata-writes.js`: `pendingItems` sends the full final id set per dirty photo; `afterWrite` → `adoptWritten` makes the re-read ids the new baseline and keeps edits made since sending as pending.
- `addPendingKeyword(keywordId)` is the **only** way content-search suggestions add a keyword: it opens the tab, waits until the selection is loaded, then `activateKeyword`; nothing is written until Apply (AGENTS.md §5.I).
- Compare mode: `setKeywordsCompareMode` makes the Keywords and Description tabs unavailable. Last tab: `sidePanelTab`.
- Context menu and dialogs: create / rename / delete (`createKeywordFlow`, `renameKeywordFlow`, `deleteKeywordFlow`, homonym confirmation `confirmHomonyms`). `renameKeywordById` is used by the faces panel.

### Description tab (`description-panel.js`)
Title and description come from the catalogue columns `title` and `caption` (already resolved by read priority). With several photos of different values the field is empty ("Multiple values"); typing replaces the value on all photos; a field returned to its initial text is untouched again. A field never touched is never written. First edit calls `exiftool_prewarm`. Ctrl+Enter applies everything pending, including keywords.

## Contracts
- IPC: `get_keyword_tree`, `get_photo_keyword_ids`, `get_keyword_usage`, `apply_metadata_changes`, `create_keyword`, `get_keyword_delete_info`, `delete_keyword`, `rename_keyword`, `set_metadata_read_order`, `exiftool_prewarm`: `../generated/ipc-commands.md`. Error codes: `invalid_name`, `unknown_parent`, `unknown_keyword`, `duplicate`.
- Events: `scan-progress` (per task id) during writes.
- Database: `keyword_nodes`, `photo_keywords` (created by `init_schema`, called from `db::init_db`; orphan links of removed photos are deleted at each start); touches `photos` (`keywords`, `title`, `caption`, `file_size`, `modified`, GPS), `persons.keyword_node_id`, `faces.dirty`, `keyword_suggestion_rejections`.
- Settings: `keywordsAutoApply`, `keywordsAutoApplyAsked`, `keywordFilterMode`, `sidePanelTab`, `keywordSuggestionsOpen` (`../generated/config.md`).

## Dependencies
- Uses: `exif.rs` (write, read-back, mismatch checks), `faces.rs` (plans, persons), `geolocation.rs`, `semantic_keywords` (invalidation), `semantic::PriorityGuard`, `main.rs` (`keep_cached_images`, cancel flags).
- Used by: `library_sync` (`store_photo_keywords`), `faces` (`delete_subtree`, tree), the semantic modules (tree, suggestions), `main.js` (initialisation, selection), the faces panel (conflicts, rename).

## Invariants and sensitive areas
- ⚠ sensitive: `run_write` is the single place where write → re-read → verify → catalogue happens; every new writable field must be verified there (a failed write must never show as success, `../invariants.md` §1.5).
- ⚠ sensitive: rename must update the tree before computing paths, and delete must keep the node when any file failed (tests `rename_updates_the_tree_then_rewrites_every_file_carrying_the_keyword_or_a_descendant`, `delete_keeps_the_keyword_when_a_file_could_not_be_rewritten`).
- ⚠ sensitive: `WRITE_LOCK` and the 3 threads: do not add another path that writes keywords without it.
- Names may not contain `/`, `|`, `,` (hierarchy separators and filter separator): enforced in `validate_name`; the UI repeats the check (`validateKeywordName`).
- Format and field rules (`dc:subject`, `digiKam:TagsList`, `acdsee:categories`, IPTC, XPKeywords): `metadata-read-write.md` ("Written fields").

## Tests
`tests/keywords.rs` (11): case-insensitive uniqueness, only the leaf active and the file wins, stored ids after re-read, unknown photo skipped, database failure reported, name validation; and on synthetic JPEGs: `run_write` writes then stores the re-read (pixels untouched), unknown keyword or photo fails without touching the file, rename rewrites every file of the subtree, delete removes the subtree, delete keeps the node when a file fails. `run_write` / `run_rename` / `run_delete` take a `WriteEnv` (cache dirs, progress callback, writer function; built from the `AppHandle` by `WriteEnv::of`), so tests pass the internal writer (`exif::write_metadata_internal`) without touching the global setting. Gaps: title / description / faces / GPS through `run_write` (their check follows the global writer setting), the frontend.

## How to extend
1. New field written with the keywords (like title): add it to `KeywordWriteItem`, `MetadataUpdate`, both writers, the verification step in `run_write`, and a pending editor in the frontend (`registerEditor`); see `../recipes.md`.
2. New tree operation (move, merge): compute affected photos with `photos_carrying`, write through `run_write` before changing the tree, and call `semantic_keywords::on_keywords_changed`.
3. New keyword source format: see `metadata-read-write.md` (read priorities).

## Open questions
none. `keywordFilterMode` and `sidePanelTab` are UI state without a default in `defaults.jsonc` (see `../configuration.md`).
