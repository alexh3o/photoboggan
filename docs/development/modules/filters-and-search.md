<!-- verified: none | sources: src/shooting-filters.js, src/format-filters.js, src/filter-suggest.js, src/filter-tags.js, src/find-raw.js, src/histogram.js, src/raw-settings.js -->
# Filters, filter tags, histogram, find RAW

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Pipeline: each filter module exposes a captured state, a `matches…State(photo, state)` used by `applyPhotoFilters` (main.js), and when possible a SQL prefilter (`shootingPrefilter`, `formatPrefilterExtensions` → `PhotoPrefilter` in db.rs); both sides must give the same result.
- Shooting / gear filters: `initShootingFilters`, `matchesShootingState` (camera, lens, focal, shutter, aperture, ISO, flash).
- Format filter: `initFormatFilters`, `matchesFormatState`; `format-filters.js` also owns the frontend extension lists (`RAW_EXTENSIONS`, `HEIF_EXTENSIONS`, `VIDEO_EXTENSIONS`, `RASTER_EXTENSIONS`).
- Building blocks: `createFilterTag` / `addIncludeExcludeMenu` (filter-tags.js), `createFilterSuggest` (filter-suggest.js, used by several panels).
- Find RAW: `buildRawSearchState`, `rawNameMatches`, `searchScope` (find-raw.js) + main.js section "TROUVER LE RAW"; settings `initRawSettings`, `getRawSearchSettings`, `compileNamePattern` (raw-settings.js, also used by the duplicate search by name).
- Histogram: `initHistogram`, `syncHistogram`, `cycleHistogramState` (histogram.js). Date, location and rating filters live in main.js (see `main-window.md`).

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
