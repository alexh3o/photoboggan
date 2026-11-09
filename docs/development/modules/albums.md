<!-- verified: none | sources: src-tauri/src/albums.rs, src/albums-panel.js -->
# Albums (virtual folders, manual and smart albums)

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Backend: tree of nodes (`init_schema`, `list_nodes`, `create_node`, `rename_node`, `delete_node`, `move_node` without cycles, `copy_node`), membership (`add_photos`, `remove_photos`, `replace_photos`, `album_photos`), smart album filters stored as text (`set_filters`). Commands wrap them (`get_album_tree`, `create_album_node`…).
- Albums exist only in the database: they are not rebuildable from files (see `architecture.md`, "Where state lives").
- Frontend: `initAlbumsPanel`, `refreshAlbums`, `getSelectedAlbum`, `addPhotosToAlbum` / `movePhotosToAlbum` / `removePhotosFromSelectedAlbum`, dirty state `setAlbumDirty` / `confirmLeaveAlbum`.
- Smart albums: filter state captured and restored by main.js (section "ALBUMS INTELLIGENTS : ÉTAT DES FILTRES ENREGISTRÉ", `set_album_filters`); the content-analysis filter is never saved in them.
- Tests: `tests/albums.rs` (parent rules, unique names, cycles, copy, cascade delete).

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
