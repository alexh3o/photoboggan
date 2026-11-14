<!-- verified: 03c1da6 | sources: src-tauri/src/privacy.rs, src/privacy.js, src/privacy.css -->

# Private photos and privacy sets

## Purpose
Hides sensitive photos across the grid, folder tree, albums, people/faces views, and duplicate searches without touching or deleting any file on disk. Scans, metadata reads/writes, and thumbnail generation still process those photos normally. The user defines named *privacy sets* in Settings > Misc and toggles them from a shield menu in the Filters header (unless locked).

## Files
| File | Role |
|---|---|
| `privacy.rs` | `PrivacySet` criteria, `ACTIVE` state, startup `restore`, `set_privacy_sets` (persisted in `config.json`), SQL helpers (`visible_condition`, `hidden_persons_sql`, `visible_person_condition`), `is_active`, `is_private_folder`, `get_privacy_hidden_keywords`. |
| `privacy.js` | Set editor (Settings > Misc), shield button and dropdown menu (`#privacy-shield`, `#privacy-menu`), `parseDateRange`, `syncPrivacyToBackend`, `onPrivacyChange`, `isHiddenKeyword`, `hasActivePrivacy`. |
| `privacy.css` | Shield icon states, fixed-position set menu (`.privacy-menu.keyword-suggestions`), and settings editor layout. |

## How it works

**Criteria and matching (`privacy.rs`, `privacy.js`).** A set combines three criteria types with **OR** (a photo is hidden as soon as it matches at least one criterion of any active set):
1. **Folder path parts** (`PathCriterion { text, partial }`): matches only the folder portion of `path` (normalized to lowercase `/`, filename excluded). Complete (`partial: false`) matches a whole folder segment (`/<text>/`); partial (`partial: true`, shown as `~<text>`) matches any substring of the folder path.
2. **Keywords**: exact, case-insensitive match against active keywords of the photo (`photo_keywords` joined with `keyword_nodes.name_key`).
3. **Date ranges** (`DateRange { start, end }`): inclusive `YYYYMMDDHHmmss` bounds (`parseDateRange` in JS; incomplete tokens expand to their full period, e.g. `2024` → `20240101000000`..`20241231235959`). Dated photos (`date_taken >= '1000'`) compare `date_taken`; undated photos compare `photos.created` (filled by `library_sync::store_dates`) or fall back to `photos.modified` when `created` is `0`.

An empty set (`PrivacySet::is_empty`) hides nothing. Multiple active sets are merged by `apply`.

**Startup and synchronization.**
1. `privacy.js` persists `privacyEnabled`, `privacyLock`, `privacySets`, and `privacyActive` in `localStorage`.
2. When `set_privacy_sets` runs (at startup via `initPrivacy` → `syncPrivacyToBackend`, and on every change via `commit`), the backend updates `ACTIVE` and saves the active list into `config.json` (`AppConfig.privacy_sets`).
3. At the next launch, `main.rs` `.setup` calls `privacy::restore(config_data.privacy_sets)` **before** the webview loads, so initial queries never expose hidden photos.
4. `commit()` awaits `syncPrivacyToBackend()` before notifying `onPrivacyChange` listeners in `main.js`, which reload `loadPhotos`, `scheduleFolderCounts`, `refreshDiskFolders`, and `refreshAlbums`.

**Where hiding is enforced.**
- **Catalogue reads (`db.rs`)**: `get_photos_filtered`, `count_photos`, `get_photos_by_paths`, `get_photos_by_ids`, and `get_folder_counts` append `visible_condition("")`.
- **Albums (`albums.rs`)**: `node_select` (manual album counts), `memberships`, and `album_photos` apply `visible_condition("")`.
- **Duplicates (`duplicates.rs`)**: `load_candidates` filters out hidden photos with `visible_condition("")` for identical, similar, and by-name searches.
- **Faces and people (`faces.rs`)**: `get_persons`, `get_face_index`, and `get_face_counts` apply `visible_condition` and `visible_person_condition` / `hidden_persons_sql` (people linked to a hidden keyword are hidden too).
- **Empty disk folders (`main.rs`)**: `list_disk_folders` skips folders matching `is_private_folder`.
- **Keyword filter UI (`main.js`)**: `keywordFilterSuggest` filters out `isHiddenKeyword(option.value)` from autocomplete suggestions (editing panels such as the Keywords tab still show all keywords).

**Shield, privacy lock, and folder deletion.** When `privacyEnabled` is on, `#privacy-shield-wrap` is shown in the Filters header (green when sets are active). With `privacyLock` checked (`isPrivacyLocked`), clicking the shield does nothing and active sets can only be changed in Settings. Folder deletion (`deleteFolderToTrash` in `main.js`, `delete_folder` in `main.rs`) is refused while any set is active (`hasActivePrivacy()` / `privacy::is_active()`), preventing unseen hidden photos from being trashed with their folder.

## Contracts
- IPC commands: `set_privacy_sets`, `get_privacy_hidden_keywords` (`../generated/ipc-commands.md`; `get_privacy_hidden_keywords` has no JS caller because `privacy.js` computes `hiddenKeywordKeys()` locally).
- Events: none.
- Database: owns no tables; reads `photos` (`id`, `path`, `date_taken`, `created`, `modified`), `photo_keywords`, `keyword_nodes`, `persons` (`../generated/db-schema.md`).
- Settings: `privacyEnabled`, `privacyLock` (`../generated/config.md`); `privacySets`, `privacyActive` in `localStorage` (no entry in `defaults.jsonc`); `AppConfig.privacy_sets` in `config.json`.

## Dependencies
- Uses: `keywords::name_key` (`privacy.rs`), `load_config` / `save_config` (`main.rs`), `filter-tags.js`, `photo-actions.js` (`openContextMenuAt`, `confirmDialog`), `settings-defaults.js`, `i18n.js`.
- Used by: `db.rs`, `albums.rs`, `duplicates.rs`, `faces.rs`, `main.rs` (`.setup`, `list_disk_folders`, `delete_folder`), `main.js`.

## Invariants and sensitive areas
- ⚠ sensitive: `visible_condition` builds raw parameterless SQL literals via `quote()` (doubles `'`, strips `\0`) so callers can append it without renumbering `?1`, `?2` parameters. Every criterion in `private_test` must stay wrapped in `COALESCE(…, 0)` so a `NULL` column never turns `NOT (NULL)` into `NULL` and hides unrelated photos.
- ⚠ sensitive: `AppConfig.privacy_sets` and `privacy::restore` must run in `.setup` before the frontend queries the catalogue; relying only on `initPrivacy` would leak hidden photos on the first load.
- ⚠ sensitive: `delete_folder` must keep refusing while `privacy::is_active()` is true, otherwise hidden photos inside a folder could be deleted unseen.
- Path criteria match only the folder portion (`rtrim` at the last `/`), never the file name; SQLite `lower()` folds ASCII only.

## Tests
None (`tests/privacy.rs` does not exist yet; `../generated/tests.md`).

## How to extend
1. New criterion kind: add fields (`#[serde(default)]`, camelCase) to `PrivacySet` in `privacy.rs`, update `cleanSet` / `syncPrivacyToBackend` / the editor in `privacy.js`, add its SQL test wrapped in `COALESCE(…, 0)` in `private_test`, and add its UI inputs in `index.html`.
2. Hide photos in another backend module (e.g. `stats.rs`, which currently does not filter by privacy): `AND` `crate::privacy::visible_condition(prefix)` (and `visible_person_condition` for persons) into its queries, then run `npm run docs:gen`.
3. Add backend unit tests in `src-tauri/src/tests/privacy.rs` covering `visible_condition` with `NULL` fields, `is_private_folder`, and `restore`.

## Open questions
none. Note: `stats.rs` and the semantic search tables (`semantic*.rs`) do not currently filter by `privacy` (`semantic_search` results shown in the grid still pass through `db::get_photos_by_ids`, which applies `visible_condition`).