<!-- verified: none | sources: src/main.js, src/slideshow.js, src/toolbar-a11y.js, index.html -->
# Grid and viewer: virtual grid, thumbnails, selection, sort, full screen, compare, marking, slideshow (main.js, part 2)

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Scope: `main.js` top helpers (thumbnail loading), "VIRTUAL SCROLLING", "GESTION DU PLEIN ÉCRAN ET NAVIGATION", "SELECTION MULTIPLE", "UNDO", "LOSSLESS ROTATION", shortcuts memo, "TRI DES MINIATURES", "MARQUAGE", "APERÇU : ZOOM, DÉPLACEMENT ET MODE COMPARER", drag scroll and drag-and-drop to the tree, "MENU CONTEXTUEL DES MINIATURES" (`removePhotosFromLibrary`); plus `slideshow.js`, `toolbar-a11y.js`.
- Layout: `layoutPhotoRange` (square / justified / masonry), `updateVirtualScroller`, `renderVisibleItems`, `renderVisibleSeparators`, `photoAspectRatio`. ⚠ sensitive: pixel-exact (AGENTS.md §5.A, §5.B, §7 reflows).
- Thumbnails in the grid: `loadThumbnail` → `lookupCachedThumbnail` / `flushThumbnailLookups` (`get_cached_thumbnail_paths`, batched) → `enqueueThumbnailGeneration` / `pumpThumbnailGenerationQueue` (`MAX_THUMBNAIL_GENERATIONS`, `generate_thumbnail`) → fallback `generateThumbnailInWebview` + `cacheThumbnail` (`save_thumbnail_cache`).
- Selection and viewer: `handleSelection`, `toggleSelectAllPhotos`, `updateUIOnSelection`; full screen `openFullscreen`, `showFullscreenPhoto`, `navigatePhoto`, `preloadFullscreenImages` (RAW / HEIC / video via `get_raw_preview_path`); compare `renderPreview`, `toggleCompareSubSelection`, `limitSelectionForCompare`.
- Marking and undo: `setSelectionColorFlag`, `setSelectionPickFlag`, `writeMarking` (`update_photos_marking`), `undoMarking`; rotation `isRotatablePath` + `rotate_photos`; sort `photoSortValue`, `applySortChange`.
- Slideshow: `initSlideshow`, `startSlideshow`, `peekNextSlideshowPhoto` (slideshow.js); toolbar ARIA: `initToolbarAria`.

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
