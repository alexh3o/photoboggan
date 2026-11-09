<!-- verified: ef76a0e | sources: src/main.js, src/slideshow.js, src/toolbar-a11y.js, index.html -->
# Grid and viewer: virtual grid, thumbnails, selection, sort, full screen, compare, marking, slideshow (main.js, part 2)

## Purpose
What the user looks at and acts on: the virtual thumbnail grid (square, framed, justified, masonry), the thumbnails pipeline that feeds it, selection, sort and date/name separators, the preview panel with zoom and **compare mode** (up to 4 photos), full screen, the slideshow, and the marking actions (rating, colour, pick, lossless rotation) with their undo. Loading the photo list and the task queue are in `main-window.md`; the filters that build the displayed list are in `filters-and-search.md`.

## Files
| File | Role |
|---|---|
| `src/main.js` | Sections: format helpers at the top (thumbnail loading, display URLs), "VIRTUAL SCROLLING", "GESTION DU PLEIN ÉCRAN ET NAVIGATION", "SELECTION MULTIPLE", "UNDO", "LOSSLESS ROTATION", "TRI DES MINIATURES", "MARQUAGE", "APERÇU : ZOOM, DÉPLACEMENT ET MODE COMPARER", "DÉFILEMENT DE LA GRILLE AU GLISSER", "DÉPLACEMENT ET COPIE … VERS L'ARBORESCENCE" (drag and drop onto the folder tree), "MENU CONTEXTUEL DES MINIATURES" (`removePhotosFromLibrary`) |
| `src/slideshow.js` | Slideshow as a state of full screen: timer, delay / loop / random settings (`slideshowDelay`, `slideshowLoop`, `slideshowRandom`), `initSlideshow`, `startSlideshow`, `stopSlideshow`, `notifySlideshowPhotoShown`, `peekNextSlideshowPhoto` |
| `src/toolbar-a11y.js` | `initToolbarAria`: one `MutationObserver` per toolbar toggle keeps `aria-pressed` equal to the `active` class (which other modules toggle) |

## How it works

### Two lists, one grid
`loadedPhotos` is what the backend returned; `photos` is the displayed list built by `applyPhotoFilters` (filters, then sort). Every grid and viewer function indexes `photos`. `selectedIndices` (a Set of indices into `photos`) and `lastSelectedIndex` (the **active photo**: target of keyboard navigation, Info panel and full screen) are shared state. Anything that rebuilds `photos` must re-find the selection by path (`applyPhotoFilters({keepState:true})`).

### Virtual grid (⚠ sensitive, pixel-exact)
1. `updateVirtualScroller` measures `gridContainer.clientWidth − 2·GRID_SIDE_MARGIN` (8 px, room for the 3 % hover zoom without a horizontal scrollbar), computes `photoLayouts` (`{index, x, y, width, height}`) and `separatorLayouts`, and sets the height of `scrollContent`. With separators (`computePhotoGroups`: by day/week/month/year when sorted by date, by folder when sorted by name, duplicate groups in duplicate mode, none for content search) each group is laid out on its own.
2. `layoutPhotoRange` does one group: **square/framed** (columns from `thumbnailSize` capped by `devicePixelRatio`), **justified** (rows filled until the row height fits under the ceiling `thumbnailSize / ratio`; the last row of a group is **not stretched**, left-aligned, height capped), **masonry** (shortest column first, ratio clamped 0.2–5, height capped by the cache resolution `thumbnailCacheSize`, `object-fit: cover`). A photo is never displayed larger than its cached thumbnail (the cap is on the longest side).
3. `renderVisibleItems` binary-searches `photoLayouts` for the visible window plus one screen of overscan (`THUMBNAIL_OVERSCAN_SCREENS`), creates missing DOM nodes (cached in `renderedThumbnailNodes`) and only writes style/class when a value changed (`div._transform`, `_width`…). Nodes are positioned with `translate3d`; selection is a class and an outline-like `.selection-ring` element, never a size change (AGENTS.md §7: no reflow).
4. `photoAspectRatio` = ratio learnt from the loaded image, else EXIF width/height from the catalogue, else 1. When a thumbnail loads with a different ratio, `learnPhotoAspectRatio` → `scheduleJustifiedRelayout` (80 ms debounce, ignored for masonry except videos, whose size is not in the catalogue).
5. Layout rules in px are in AGENTS.md §5.A / §5.B / §7: use `rem` only outside these calculations.

### Thumbnail pipeline of the grid
1. `loadThumbnail(image, path, photo)` → `lookupCachedThumbnail`: all paths requested in one render are collected and sent in batches of 128 to `get_cached_thumbnail_paths` (memoised per path in `thumbnailCacheLookups`).
2. Hit: `showCachedThumbnail` (asset URL + `versionSuffix`), ratio learnt on load.
3. Miss: `enqueueThumbnailGeneration`. The queue runs at most `MAX_THUMBNAIL_GENERATIONS` = clamp(cores − 1, 2, 6) jobs; `takeNextThumbnailGeneration` drops jobs whose image left the DOM, then picks the job **closest to the viewport**; jobs of a hidden grid wait; standalone requests (faces / people views, `enqueueStandaloneThumbnailGeneration`) go first, newest first. Job: `generate_thumbnail` (backend writes the cache file, returns path and size).
4. Backend failure: file really gone → `checkPhotoMissing` (see `main-window.md`); video → empty cell with its play icon; RAW without a usable preview → `markFormatPlaceholder` (format letters shown, never demosaiced); otherwise **webview fallback** `generateThumbnailInWebview` (≤ 2 at once; decodes the original, then `cacheThumbnail` → `save_thumbnail_cache`).
5. Modified files: `photoVersions` adds `?v=<time>` to URLs so a rewritten image is not served from the webview cache.

### Orientation, `view_fix`, RAW / HEIC / video in full screen
- The webview applies only the EXIF orientation of an original. When the winning orientation is XMP (internal writer, sidecar), the backend sets `photo.view_fix` (1–8) and the frontend applies the rest (`orientationMatrix`, `swapsSides`; used in `layoutPreviewSlot`, canvas fallback). Cached thumbnails and generated previews are already turned: their `view_fix` is 1. Rules of precedence: `orientation::resolve` (see `thumbnails-and-previews.md`).
- `getPhotoDisplayUrl`: normal formats use the original (`photoUrl`); RAW, HEIC/HEIF and videos (`needsGeneratedPreview`) call `get_raw_preview_path` once per photo (promise memoised in `rawPreviewPromises`; failure is not memoised; a video never falls back to the file itself).
- Extension lists (`RAW_EXTENSIONS`, `HEIF_EXTENSIONS`, `VIDEO_EXTENSIONS`) come from `format-filters.js`. Videos are never played inside the app: `openFullscreen` sends them to `open_video_externally`.

### Full screen
`openFullscreen(index)` → selects that photo only, `loadFullscreenPhoto` → `showFullscreenPhoto` (probes the image off-screen, then applies size/zoom in one step so no stretched frame appears; `fullscreenLoadToken` discards stale loads), `preloadFullscreenImages` (±2 neighbours + the next slideshow photo, `fullscreenImageCache` keyed **by index**, so it is cleared on any re-sort). Navigation (`navigateToPhotoIndex`, arrows, wheel) just changes the selection; `updateUIOnSelection` then reloads. Zoom/pan share the preview's slot logic (`layoutPreviewSlot`, `fullscreenSlot`). An image error calls `checkPhotoMissing`. Closing stops the slideshow.

### Selection and Info panel
`handleSelection(index, event)`: Shift = range from `lastSelectedIndex` (stops at the compare limit), Ctrl = toggle, plain = replace. `canAddToSelection` enforces `MAX_COMPARE` = 4 **only in compare mode**. `updateUIOnSelection` is the single fan-out after a selection change: keywords/description/location panels, `renderVisibleItems`, rating/colour bars, `renderPreview`, Info panel fields, map, histogram.

### Preview and compare
`renderPreview` fills `previewSlots` (one per selected photo in compare mode, shared centre unless "Desynchronise"), zoom steps ×1.4 up to 200 %. In compare mode with several photos, commands (rating, colour, delete, rotation) target only the **sub-selection** (`compareSubSelection`, circle-check marks in the preview): `commandTargetPhotos`. Context-menu commands always target the right-clicked photo. Leaving compare restores the preview's previous visibility.

### Sort
`photoSortValue` (name with numeric collation, modification date, taken date; missing values go last whatever the order). The list is sorted in the UI, but `get_photos_paginated` also receives `sortKey` / `sortOrder` because a capped list (50 000) must pick the right photos: `applySortChange` reloads from the backend when `photoListCap` is set, else re-applies filters and scrolls to the active photo. Persists `photoSortKey`, `photoSortOrder`, `photoDateSeparator`, `photoNameSeparator`.

### Marking, rotation, undo
1. `setSelectionRating / ColorFlag / PickFlag` pick targets, compute the final value (same value on all targets = clear it; pick buttons use `toggle:false`), then call `writeMarking(targets, fields, {apply, refilter,…})`.
2. `writeMarking` chains onto `markingChain` (writes run one after another, in key order), refuses photos of a running move, remembers the previous values, and calls `runLocked('update_photos_marking', …)` (direct under 20 photos, queued task from 20, see `metadata-read-write.md`). Only photos in `result.written` are updated in memory and in the grid (`apply`), `forgetCachedImagePaths` drops stale caches, `refilter()` re-runs the filters if one concerns the changed value. Failures are listed in the toast ("Details"), never reported as written.
3. `rotatePhotos` follows the same shape with `rotate_photos`; the backend returns each photo's new `view_fix`; `isRotatablePath` excludes video and HEIC/HEIF.
4. Undo: `pushUndo(run)` keeps 20 entries (`MAX_UNDO`); the toast button undoes its own entry, Ctrl+Z the latest; an undo is not stacked again. `undoMarking` writes the stored previous value back; `undoRotation` applies the opposite rotation.

## Contracts
- IPC commands: `get_cached_thumbnail_paths`, `generate_thumbnail`, `save_thumbnail_cache`, `get_raw_preview_path`, `update_photos_marking`, `rotate_photos`, `open_video_externally`, `remove_missing_photos` (`../generated/ipc-commands.md`).
- Events: none.
- Database: none directly (`photos` rows come back from the list commands).
- Settings: `thumbnailLayout`, `thumbnailSpacing`, `thumbnailSize`, `markingPlacement`, `dimUnselectedOnHover`, `slideshow*`, `photoSortKey`/`photoSortOrder`/`photo*Separator` (`../generated/config.md`).

## Dependencies
- Uses: `filters` (via `applyPhotoFilters`), `metadata-writes.js` (`runLocked`), `photo-actions.js` (context menu, delete/move), faces/map/histogram modules refreshed by `updateUIOnSelection`.
- Used by: all panels read `photos`, `selectedIndices`, `lastSelectedIndex`.

## Invariants and sensitive areas
- ⚠ sensitive: virtual grid layout is pixel-exact (AGENTS.md §5.A/§5.B/§7); a fractional width or a size change on hover/selection creates gaps or reflows.
- ⚠ sensitive: `photos` indices are positional: `fullscreenImageCache`, `renderedThumbnailNodes` and selection all break if the list is re-sorted without clearing/re-finding them.
- ⚠ sensitive: `view_fix` must not be applied to a thumbnail or generated preview (double rotation).
- Compare mode: selection limited to 4 only while it is active (`limitSelectionForCompare` when entering it).
- No frontend framework (AGENTS.md §4.6).

## Tests
None for this module (no frontend tests). Backend counterparts: `tests/thumbnails.rs`, `tests/orientation.rs`, `tests/main.rs` (cache paths).

## How to extend
1. New thumbnail layout: a branch in `layoutPhotoRange`, handling in `scheduleJustifiedRelayout` and `renderVisibleItems` (`object-fit`), option in `index.html` and `defaults.jsonc` (`recipes.md` §2).
2. New per-thumbnail badge: create it once in `renderVisibleItems` (lazily), update it only when the value changes.
3. New marking field: add a `MARKING_PROPERTIES` entry and a `setSelection…` function using `writeMarking`; backend field in `update_photos_marking`.
4. New viewable format: extension list in `format-filters.js` (`recipes.md` §4) and, if the webview cannot show it, `needsGeneratedPreview` + backend preview.

## Open questions
- ⚠ unverified: drag-scroll and drag-and-drop-to-tree sections, the context-menu section and `slideshow.js` beyond its header were not read in detail.
- ⚠ unverified: `computeDuplicateSeparators` and separator key logic (`separatorGroupKey`) only skimmed.
