<!-- verified: ad666bb | sources: src-tauri/src/albums.rs, src/albums-panel.js, src/main.js, src/sidebar-search.js -->
# Albums (virtual folders, manual albums, smart albums)

## Purpose
Albums organise photos **without touching the files**: virtual folders to group things, manual albums holding hand-picked photos, and smart albums that save a set of filter criteria and show whatever matches them. They are shown in the "Albums" block of the left panel. Unlike almost everything else, they exist **only in the database**: nothing about them is written into image files or sidecars, so they cannot be rebuilt by a rescan.

## Files
| File | Role |
|---|---|
| `src-tauri/src/albums.rs` | Table creation (`init_schema`), tree rules (`create_node`, `rename_node`, `delete_node`, `move_node`, `copy_node`), smart filters (`set_filters`), manual content (`add_photos_listed`, `remove_photos`, `replace_photos`, `album_photos`), `memberships`; the IPC commands wrap these |
| `src/albums-panel.js` | The sidebar block: tree rendering, create / rename / delete, drag and drop (move or copy), manual content actions with undo toast, the smart-album "dirty" state and leave guard (`confirmLeaveAlbum`), `getAlbumContext`, `initAlbumsPanel`, the quick search of the block (`computeSearchShown`, `visibleChildren`, `setNodeOpen`) |
| `src/sidebar-search.js` | The search field shared by the Folders, Albums and People titles (`initSidebarSearch`); this module only filters the album tree with the text it reports |
| `src/main.js` | Section "ALBUMS INTELLIGENTS : ÉTAT DES FILTRES ENREGISTRÉ": `captureFilterState`, `applyFilterState`, `syncSmartAlbumWithSelection`, `saveActiveSmartAlbum`, `saveCurrentViewInto`, `computeAlbumCounts`, `loadPhotos` branch for albums |

## How it works

### Data model (`albums.rs` header)
- Table `album_nodes` (`id`, `parent_id`, `kind`, `name`, `name_key`, `filters` JSON text, `UNIQUE(parent_id, name_key)`): `kind` is `folder`, `manual` or `smart`; `parent_id = 0` is the root. Table `album_photos (album_id, photo_id)`, a photo may be in several manual albums.
- Rules (`can_contain`): root and virtual folders accept anything; manual and smart albums accept only **smart** children: under a smart album its criteria add to the parent's, under a **manual** album it filters that album's content. Two siblings never differ only by case (`name_key` = trimmed lowercase); names are 1–120 characters.
- `move_node` forbids moving into oneself or a descendant (`is_self_or_descendant`) and name clashes; a moved smart album keeps its own filters (only what it inherits changes). `copy_node` copies recursively in one transaction (filters and manual content included); only the root of the copy is renamed `Name (copy)`, `(copy 2)`… with the translated `suffix` given by the UI. `delete_node` removes the node, its whole subtree and the memberships; photos are untouched.
- `set_filters` accepts only smart albums and only valid JSON; its content (the filter-state object) is defined by the frontend (`filters-and-search.md`, "Filter state object") and never contains photo ids.
- Cleanup: an SQL trigger `album_photos_photo_deleted` (created in `init_schema`) removes memberships when a photo leaves the catalogue, wherever in the code that happens; `init_schema` also purges orphan memberships at startup. Photos are **upserted** by path (`ON CONFLICT(path) DO UPDATE` in `main.rs`), so a rescan keeps their ids and their albums.

### Frontend flows
1. **Startup / refresh**: `initAlbumsPanel` → `refreshAlbums` (`get_album_tree`, a flat list; the tree is rebuilt from `parent_id`). Expanded and collapsed state: localStorage `albumsExpanded`, `albumsCollapsed`.
2. **Open an album**: `selectAlbum` (a virtual folder only expands/collapses); leaving a **dirty** smart album first asks Save / Discard / Cancel (`confirmLeaveAlbum`, also checked when selecting a disk folder and on window close, `main-window.md`). Then `host.onSelectionChange` → `main.js` `syncSmartAlbumWithSelection` and `loadPhotos`.
3. **What the grid shows** (`loadPhotos`): a manual album → `get_album_photos` (never capped, ordered by date taken desc); a smart album → the whole library (or its parent manual album's content, `baseManualId`) and the filters do the rest, in the normal pipeline: own criteria are loaded into the sidebar controls (`applyFilterState`), parent criteria are kept read-only in `albumInherited` and applied by `matchesAlbumCriteria`; the album's disk folder and map zone are kept as `albumFolder` / `albumMapZone` (no control). Leaving a smart album resets all filters.
4. **Dirty state**: `applyPhotoFilters` compares `filterStateSignature()` with `albumSavedSignature`; a difference lights the save icon (`setAlbumDirty`). Save → `saveActiveSmartAlbum` → `set_album_filters` with `captureFilterState()` (own criteria only). "Save current view into this album" → `saveCurrentViewInto` (`captureCurrentView` also adds the displayed disk folder and the visible map zone), after a confirmation that can be disabled (`albumOverwriteWarning`).
5. **Manual content**: add (`add_photos_to_album` returns the ids really added; the toast's Undo removes only those), move between albums (add then remove, undo reverses both), replace with the selection (confirmation), remove from the displayed album. All are saved immediately and followed by `refreshAlbums`, which reloads the grid if the displayed album changed.
6. **Counts**: manual albums come with a count; smart albums and virtual folders are counted by `computeAlbumCounts` (500 ms debounce, only when the Albums block is expanded, one run at a time): it reads the whole catalogue (50 000) and `get_album_memberships` and evaluates each smart album with `matchesFilterState`. A smart album starts from its parent's set (manual or smart) or the whole library under a folder/root; a virtual folder counts the union of its children. Counts are therefore approximate on catalogues above 50 000 photos (photos beyond the cut are ignored).
7. **Drag and drop** in the tree: `startDrag` after 5 px, `dropRefusal` mirrors the backend rules for early feedback, `askMoveOrCopy` chooses move or copy; the backend re-checks everything.
8. **Quick search** (magnifier in the title row, shown on hover, left of the "+"): `initAlbumsPanel` calls `initSidebarSearch({ name: 'albums', onChange })`. The module owns the field (open with click or Enter, which also unfolds a collapsed block, close with × or Esc) and reports the text normalized by `normalizeSearch` (no case, no accents, trimmed). `render` then calls `computeSearchShown`: the ids of the nodes whose name contains the text **plus all their ancestors** (the subfolders of a match are not kept unless they match). `visibleChildren` filters every level, and while a search is active `isNodeOpen` unfolds every node that has a kept child, except those folded by hand since the text last changed (`searchCollapsed`, cleared on each new text). `setNodeOpen` (arrow, click on a virtual folder) writes to `searchCollapsed` during a search and to `expanded` otherwise, so the **real fold state (`albumsExpanded`) is never touched by a search**. When the text becomes empty again (field closed with × / Esc, or emptied by hand), the ancestors of the open album are added to `expanded` and the active row is scrolled into view; the selected album itself never changes. Navigation is unchanged while filtering (click, menus, drag and drop work on the kept rows). No result: the list shows "No matching album".

## Contracts
- IPC commands: `get_album_tree`, `create_album_node`, `rename_album_node`, `delete_album_node`, `move_album_node`, `copy_album_node`, `set_album_filters`, `get_album_memberships`, `get_album_photos`, `add_photos_to_album`, `remove_photos_from_album`, `replace_album_photos` (`../generated/ipc-commands.md`). Backend error strings are English sentences (`"An item with this name already exists here"`…) that the UI translates with `t(...)` where a key exists.
- Events: none.
- Database: `album_nodes`, `album_photos`, trigger `album_photos_photo_deleted`, index `idx_album_photos_photo` (`../generated/db-schema.md`).
- Settings: `albumsExpanded`, `albumsCollapsed`, `albumOverwriteWarning` (localStorage). The text of the quick search is not remembered.

## Dependencies
- Uses: `db.rs` (`PHOTO_COLUMNS`, `photo_from_row`, `init_db` calls `albums::init_schema`), `photo-actions.js` dialogs (`promptDialog`, `confirmDialog`, `createModal`, `openContextMenuAt`), `sidebar-search.js` and `i18n.js` `normalizeSearch` (quick search), the filter modules through `main.js`.
- Used by: `main.js` (loading, filters, counts), `photo-actions.js` (add to album, remove from album menu entries via `addPhotosToAlbum` / `removePhotosFromSelectedAlbum`).

## Invariants and sensitive areas
- ⚠ sensitive: **albums are not rebuildable.** They live in `photos_library.db`. Consequences: (a) `change_storage_location` copies the database file and the albums come along (it copies the whole database under a write transaction, see `app-shell.md`); (b) deleting the database, or a failed copy, loses every album and its photo memberships, whereas photo metadata is untouched; (c) a manual album stores catalogue **ids**: after the catalogue is rebuilt from scratch (new database), ids differ and old memberships cannot be restored; (d) smart albums only hold criteria, so they survive any re-index, but folder criteria are paths and break if the folder moves.
- ⚠ sensitive: a smart album stores its filter-state JSON, which is also produced and consumed by `captureFilterState` / `applyFilterState`: changing the shape of a criterion breaks saved albums (keep old shapes readable). The content-analysis filter is deliberately never saved.
- Never write photo ids into a smart album (stated in the `albums.rs` header).
- Remove-from-album never deletes files; deleting an album never deletes photos.
- The trigger is the only thing keeping memberships clean when photos are removed; do not delete photos through a path that bypasses SQL `DELETE` (e.g. dropping the table).

## Tests
`src-tauri/src/tests/albums.rs` (11 tests, listed in `../generated/tests.md`): parent rules, per-parent name uniqueness ignoring case, move without cycles keeping filters, name clash on move, subtree delete, photo deletion leaving every album, copy with free name and subtree, filters only for smart albums and valid JSON, add/remove/replace, memberships, "added" list. `tests/db.rs` has a prefilter test for album criteria (`prefilter_covers_file_gear_shooting_and_album_criteria`). No frontend tests.

## How to extend
1. New node rule: change `can_contain` (backend) **and** `canContain` / `dropRefusal` in `albums-panel.js` so the UI gives early feedback; add a case to `parent_rules`.
2. New criterion saved in smart albums: add it to `captureFilterState`, `applyFilterState`, `matchesFilterState`, the reset functions and, if possible, the prefilter (`filters-and-search.md`); no backend change (filters are opaque JSON).
3. New album IPC command: `recipes.md` §1; keep logic in a plain `fn` taking `&Connection` so it is testable with `test_support`.
4. New column/table: `recipes.md` §5, in `albums::init_schema` with `IF NOT EXISTS`.

## Open questions
none. Context menu (`openNodeMenu`): a manual album offers "Add selection to this album (n)" and "Replace content with selection…" (`selectionItems`) but no creation under it; a smart album offers creation of a smart child plus "Save changes" (greyed without changes) and "Save current view in this album…" (`smartItems`); every node offers Rename and Delete. A smart album can still be dropped into a manual album (`canContain`).
