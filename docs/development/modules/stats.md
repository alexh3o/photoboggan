<!-- verified: 109c858 | sources: src-tauri/src/stats.rs, src/stats.js, src/stats.css -->
# Collection statistics

Spec: `dev_tools/Evolutions/feat stats.txt`.

## Purpose
A read-only window, opened from the chart icon next to the shortcuts guide in Settings, that summarises the catalogue: filters on top, then data blocks separated by horizontal lines.

## Files
| File | Role |
|---|---|
| `stats.rs` | `get_collection_stats(filter)`: one blocking pass over `photos`, plus grouped queries on the photos kept. `get_stats_filter_options()`: cameras, root folders and extensions offered by the filters |
| `stats.js` | Window wiring, filters, calendar (period, granularity, grouping of per-day counts), rendering |
| `stats.css` | Layout, list rows with a background bar, time chart |

## Filters
Combined with AND; nothing chosen = no filter.
- **Camera, root folder, format**: multiple choices, built like the filter panel (`createFilterSuggest` + `createFilterTag`; type to see the suggestions). Cameras use the label of `cameraLabel`; folders are rows of `folders` (a photo is in a root when its path starts with it, compared without regard to case or separator kind); formats are the catalogue of `format-filters.js` (`buildCatalog`, `extensionsOf`, both exported for this window), turned into a list of extensions sent to the backend.
- **Period**: presets "Last month", "Last year", "All time", and two native date inputs (the filter panel's calendar lives in `main.js` and cannot be reused as is). The presets are whole months ending with the last complete one (in November 2026: October 2026, and November 2025 to October 2026). Default: last year. With a period only photos with a usable date taken inside it count; without one every photo counts.
- **Granularity** of the time chart: day (period up to 62 days), week (28 days to 62 weeks), month (6 to 62 months), year (2 to 62 years), decade (30 years and more). The default is the allowed one whose number of columns is closest to 30. For "All time" the span is the one of the photos found. A choice made by hand is kept while still allowed and reset when the period changes.

## Blocks (in order)
1. Number of photos and total size.
2. Time chart (the granularity above applies to it). The backend returns non-empty days only; `stats.js` groups them (weeks start on Monday), so changing the granularity needs no request.
2b. Top 5 cameras and top 5 lenses, side by side. Each is hidden when the photos counted have a single camera (or lens), as after filtering on one camera; the whole block goes when both are hidden. Camera labels are those of the camera filter; names are grouped without regard to case.
3. Photos and size per file extension.
4. Photos per rating (always), per colour flag (only if colour labels are on in Settings) and per pick flag (only if pick labels are on).
5. The 15 most given keywords (link table, last level of each path, with the path of their ancestors).
6. Geolocated vs not (latitude and longitude both known, as in the geolocation filter).
7. People and faces, only if `isFaceDetectionEnabled()`: distinct people, faces, and the 5 people with the most faces. A face counts unless its state is `ignored`, `not_face` or `filtered`; a person counts when at least one such face is attributed to them (`person_id`). Hidden people are left out of the top 5.
8. Distribution by shooting setting (focal length, aperture, shutter speed, ISO) with a selector: fixed ranges (`FOCAL`, `APERTURE`, `SHUTTER`, `ISO` in `stats.rs`), values read like the shooting filters. All four are returned together; the selector only switches which one is drawn.
9. Content analysis (analysed vs not), only if `isSemanticEnabled()`: photos with an embedding of the active model.

A note under a list says how many of the photos counted have the information.

## Invariants
- Read-only: nothing is written to the catalogue or the files.
- The heavy part runs in `spawn_blocking`; the interface ignores an answer that arrives after a newer request or after closing.
- Escape closes this window only (capture phase), not Settings underneath; while a suggestion list is open, Escape belongs to it.

## Gotchas
- Dates are read like `extractTimeKey` in `main.js` (first `YYYY?MM?DD` of the text) but a month or day that does not exist, or a year outside 1900-2200, is no date.
- Changing a range of a shooting setting means editing its `Scale` constant only.
