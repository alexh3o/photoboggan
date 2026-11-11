<!-- verified: 60164db | sources: src/shooting-filters.js, src/format-filters.js, src/filter-suggest.js, src/filter-tags.js, src/find-raw.js, src/raw-settings.js, src/histogram.js, src/main.js, src-tauri/src/db.rs -->
# Filters and search (sidebar filters, SQL prefilter, "Find the RAW", histogram)

## Purpose
The Filters block of the sidebar narrows the displayed photos by rating, colour, pick, keywords, people, file name, date, location, gear, shooting values and format. Filtering is done **in the frontend** on the loaded list; for very large scopes the backend also applies a **SQL prefilter** before cutting the list at 50 000 photos. "Find the RAW" turns the criteria chosen in Settings into ordinary filters. The histogram overlay is a display aid that lives with them.

## Files
| File | Role |
|---|---|
| `src/main.js` | `applyPhotoFilters` (the pipeline), `captureFilterState` / `applyFilterState` / `matchesFilterState` (state saved in smart albums and used by Find RAW), rating, colour, pick, keyword, file-name, date (`parseDateFilter`), location, content-analysis filters, `prefilterFromState` / `buildSqlPrefilter`, section "TROUVER LE RAW" |
| `src/shooting-filters.js` | Gear (camera, lens) and shooting values (focal, shutter, aperture, ISO, flash): `initShootingFilters`, `matchesShootingState`, `shootingPrefilter`, `shootingStateFromPhoto` |
| `src/format-filters.js` | Format filter (RAW / Raster / Video type, RAW brand, extension): `matchesFormatState`, `formatPrefilterExtensions`; also **owns the frontend extension lists** `RAW_EXTENSIONS`, `HEIF_EXTENSIONS`, `VIDEO_EXTENSIONS`, `RASTER_EXTENSIONS` |
| `src/filter-tags.js` | `createFilterTag` (chip with ×), `addIncludeExcludeMenu` (right-click include ↔ exclude) |
| `src/filter-suggest.js` | `createFilterSuggest`: autocomplete list (accents/case ignored, shortest match first then most used; Alt+Enter / Alt+click excludes), `sortSuggestions` |
| `src/find-raw.js` | Pure helpers: `searchScope`, `buildRawSearchState`, `rawNameMatches`, `folderOf`, `stemOf` |
| `src/raw-settings.js` | Settings > Misc > RAW (`rawSearch` setting): `getRawSearchSettings`, `hasRawSearchCriteria`, `compileNamePattern`, `extractNameKey` (the regex helpers are reused by the duplicate search by name) |
| `src/histogram.js` | `initHistogram`, `syncHistogram`, `cycleHistogramState`: histogram and clipping overlay |
| `src-tauri/src/db.rs` | `PhotoPrefilter` and `prefilter_condition` (SQL side) |

## How it works

### Filter pipeline (`applyPhotoFilters`)
1. Any control change updates its own state variable (`ratingFilter`, `colorFilters`, `pickFilters`, `keywordFilters` + `excludedKeywordFilters`, `filenameFilters` + excluded, `dateFilter`, `locationFilter`, person filter, module states) and calls `applyPhotoFilters()`.
2. It starts from `loadedPhotos` (plus photos suggested by the content search when "include suggestions in keyword filtering" is on), keeps the photos satisfying **all** predicates (AND), in this order: rating, keywords (or suggested), people, file names, `pathFilter` (a fixed set of paths, e.g. failed-files list), colour, pick, date, location, content-analysis state, gear/shooting, format, Find-RAW scope (`matchesRawSearchScope`), content-search cut (`matchesSemanticCut`), smart-album inherited criteria (`matchesAlbumCriteria`) → `mapCandidatePhotos`; then "visible map area only" (`passesMapFilter`) → `photos`; then sort.
3. A filter change keeps the selected paths and active path when they still pass the new criteria (and preserves the scroll position); loading a different source explicitly passes `keepState:false`. The grid is re-laid out (`grid-and-viewer.md`), banners and the "N of M photos" counter updated, faces and map views refreshed.
4. Inside a filter type, included values of the **same** field are AND for keywords / file names / people, OR for gear entries and formats; an **excluded** value always removes the photo. Different filter types combine with AND.

### JS filter and SQL prefilter must agree
On a scope of more than 50 000 photos (`largeScope`), `buildSqlPrefilter` sends a `PhotoPrefilter` with `get_photos_paginated` / `count_photos`, so the cut keeps the photos the user is looking for. **Contract: the prefilter is a superset of the JS filter, never a subset; the JS filter stays the authority** and refilters the loaded list exactly. Where each criterion lives:

| Criterion | JS (exact) | SQL (`prefilter_condition`) | Difference |
|---|---|---|---|
| Rating | `matchesRatingFilter` (`unrated` = 0, `eq` = exact, else ≥ stars) | `rating_min` / `rating_eq` / `unrated` | same |
| Colour / pick | `color_flag \|\| 'none'` | `COALESCE(NULLIF(col,''),'none') IN (…)` | same |
| Keywords (included) | whole-keyword match on `photo.keywords.split(', ')` | `instr(keywords, text) > 0` | SQL is a substring: superset. Excluded never sent |
| People | `personFilterMatches` → `photoMatchesPersonIds` (`faces-panel.js`: every included person on the photo, no excluded one) | `id IN (SELECT photo_id FROM faces WHERE person_id=…)` | excluded persons, the face-scan status filter (unscanned / to review / scanned) and the face-count filter (min / max, `get_face_counts`, counted in `personFilterMatches`) not sent |
| Date | exact instants (`dateFilter.from/to`) | years only (`year_from`/`year_to`), odd formats kept | SQL coarser |
| Location | GPS finite | `gps_lat/gps_lon IS (NOT) NULL` | same |
| File names | substring of file name | `instr(lower(filename or path), text)` | ASCII-only texts sent (`isAsciiText`); path searched: superset; excluded not sent |
| Format | extension of the path | `path LIKE '%.ext'` | only included formats sent |
| Gear / shooting | `matchesShootingState` | `cameras`, `lenses`, `focal`, `shutter`, `aperture`, `iso`, `flash` | ranges **widened** to the JS comparison precision (`widen` in `shootingPrefilter`); loose (Find RAW) and non-ASCII gear entries not sent |
| Smart-album folder / map zone | `matchesFilterState` | `folder` (lower-cased prefix), `mapZone` (antimeridian aware) | same |
| Parent albums | `albumInherited` | `and: [...]` (recursive) | same |
| Map "visible area" | `passesMapFilter` | `positioned` + `pending_positions` (≤ 500) | position only |

The prefilter key (`prefilterKey`, `pendingPositions` excluded) tells `schedulePrefilterReload` when a filter change requires rereading the list. A criterion missing from the prefilter is harmless (only less precise); one that wrongly excludes a photo is a bug: when changing a JS predicate, change its SQL side too (or stop sending it).

### Filter state object
`captureFilterState()` returns one plain object (`rating`, `colors`, `picks`, `keywords`, `excludedKeywords`, `filenames`, `excludedFilenames`, `date`, `persons`, `excludedPersons`, `location`, `gear`, `shot`, `formats`, `excludedFormats`, `folder`, `mapZone`). It is what smart albums save (`albums.md`), what "Find the RAW" builds, and what `matchesFilterState(photo, state)` tests. `applyFilterState` loads it back into the controls without filtering (the caller does). Adding a criterion means touching capture, apply, match, reset (`resetAllFilters`, `clearFilterKindsAndApply`) and the prefilter. The content-analysis filter is **never saved** in albums.

### Find the RAW (context menu on a raster image)
1. `findRawFor(photo)`: needs at least one ticked criterion (`hasRawSearchCriteria`) and data in the image; `buildRawSearchState` converts name (stem or regex key `extractNameKey`), date (to the second), gear and shooting values into a filter state plus `nameStem`.
2. `searchScope` picks the start folder (`parent` / `current` / `children`; always with subfolders; `excludeDir` removes the image's own folder for "children").
3. A dry run queries the folder (`get_photos_paginated`, 50 000) and applies `matchesFilterState` + `rawNameMatches` (names compared in both directions); no result → toast and **stay in the current view**.
4. Otherwise the view snapshot (folder or album, filters, scroll, selection: `captureViewSnapshot`) is stored in `rawSearch`, filters are reset then loaded with the state, subfolders forced on temporarily (not remembered), `loadPhotos`; `matchesRawSearchScope` adds what filters cannot express. A banner shows "RAW of …"; "Back" / Esc → `exitRawSearch` → `restoreViewSnapshot`; navigating by hand ends the mode without returning (`abandonRawSearch`).
5. Duplicate and content-search modes use the same snapshot pattern (`duplicateSearch`, `semanticSearch`); starting Find RAW ends them.

### Histogram
Computed in a canvas from the grid **thumbnail** (so RAW/HEIC/video use their generated JPEG; no IPC, no original read), last 6 photos' pixels cached (`PIXEL_CACHE_SIZE`), analysis side ≤ 768 px. One floating widget; click toggles luminance / RGB; `syncHistogram` is called on selection change, full screen and preview changes.

## Contracts
- IPC commands: `get_photos_paginated`, `count_photos` (both take `prefilter`); `get_photos_by_paths` is unrelated. See `../generated/ipc-commands.md`.
- Events: none.
- Database: reads `photos` columns (`rating`, `color_flag`, `pick_flag`, `keywords`, `date_taken`, `gps_lat/lon`, `filename`, `path`, `manufacturer`, `camera_model`, `lens_model`, `focal_length`, `shutter_speed`, `aperture`, `iso`, `flash`) and `faces`; `../generated/db-schema.md`.
- Settings: `rawSearch` (Find RAW criteria, localStorage, no entry in defaults.jsonc), `showHistogram`, `showClippings`, `clippingMode`, `clippingRange`, `histogramRgb` (`../generated/config.md`).

## Dependencies
- Uses: `main.js` services passed at init (`getPhotos`, `onChange`), `photo-actions.js` (`openContextMenuAt` in `filter-tags.js`), `i18n.js`.
- Used by: smart albums (state object), duplicate search by name (`raw-settings.js` regex helpers), grid (`applyPhotoFilters`).

## Invariants and sensitive areas
- ⚠ sensitive: prefilter ⊇ JS filter (see table). SQLite `lower()` folds ASCII only: never send non-ASCII text; shooting ranges are compared as parsed text in SQL (`FOCAL_VALUE`, `APERTURE_VALUE`, shutter fraction): a new display format of these fields must be mirrored there.
- ⚠ sensitive: `matchesFilterState` is also used for Find RAW's dry run and parent albums; it must keep the same meaning as the live controls.
- Excluded filters (`exclude*`) are never prefiltered; a field with only excluded entries sends nothing.
- Filter-state shapes are persisted in smart albums: keep old shapes readable when changing them.
- The Find-RAW "subfolders" option is temporary: do not persist it.

## Tests
No frontend tests. Backend: `tests/db.rs` has `prefilter_keeps_what_the_interface_filters_would_keep`, `prefilter_covers_file_gear_shooting_and_album_criteria` and `prefilter_applies_before_the_cut` (see `../generated/tests.md`); they protect the superset contract on the SQL side only, nothing compares them with the JS predicates automatically.

## How to extend
1. New filter: `recipes.md` §6 (module with `capture`/`matches`/`prefilter`, control in `index.html`, add to `applyPhotoFilters`, capture/apply/reset, locale keys).
2. Make it prefiltered: add a field to `PhotoPrefilter` (`#[serde(default)]`, camelCase) and its condition in `prefilter_condition`; send it from `prefilterFromState`; keep it a superset.
3. New file format in the Format filter: extension lists in `format-filters.js` (`recipes.md` §4); the prefilter picks them up through `formatPrefilterExtensions`.
4. New Find-RAW criterion: setting in `raw-settings.js`, state building in `buildRawSearchState`.

## Open questions
none. Checked: the person and rating predicates match the table; the location filter is saved as `state.location` (`geolocated` / `not-geolocated`) and sent as `geolocated: true / false`, matching `matchesFilterState`.
