<!-- verified: e0276f7 | sources: src-tauri/src/duplicates.rs, src-tauri/src/similar.rs, src-tauri/src/phash.rs, src/duplicates.js, src/duplicate-names.js, src/duplicates-modal.js, src-tauri/src/main.rs, src/main.js -->
# Duplicates (identical, similar, by name)

## Purpose
Finds groups of photos that are the same picture: identical image data (metadata ignored), visually similar (resized, recompressed, lightly edited, optionally rotated), or sharing a file-name key. Results open in the main grid as a results mode; the user decides what to do. Nothing runs and the cache tables stay empty until a search is started (AGENTS.md §5.K).

## Files
| File | Role |
|---|---|
| `duplicates.rs` | Identical search (`run`): hashed byte ranges per format, 3-stage narrowing, cache table `photo_hashes`; shared types `Scope`, `Report`, `load_candidates`, `name_candidates`; `DataHash` also used by the semantic scan. |
| `similar.rs` | Similar search (`run`): fingerprints cache `photo_phash`, pairwise comparison, bursts, grouping. |
| `phash.rs` | 64-bit perceptual hash (32×32 grey, DCT, 8×8 low frequencies), 8 rotation / mirror variants. |
| `duplicates.js` | Pure helpers: settings (identical, similar, keep criteria), group ordering, `mergeGroups`, descriptions. |
| `duplicate-names.js` | Name search in JS (`findNameGroups`). |
| `duplicates-modal.js` | "More…" window: kind, settings, scope, keep-order panel. |
| `main.js` | Section "DUPLICATES": task, results mode `duplicateSearch`, banner, `selectDuplicatesExceptBest`. Backend entry commands `find_duplicates`, `find_similar_images`, `list_duplicate_candidates` are in `main.rs`. |

## How it works

**Launch.** Context menu "Find duplicates" (photo, selection, folder, all) or the "More…" window → `findDuplicateImages(kind, spec, settings)` queues a task `kind: 'duplicates'` with `dedupeKey = <kind>:<scope>` (same kind on the same scope is refused while running or waiting, see `main-window.md`). `scope` is `All`, `Folder {path, recursive}` or `Paths`; `compareWithLibrary` also loads the rest of the library, and a group is kept only if it contains a scanned photo.

**Identical** (`find_duplicates` → `duplicates::run`, holding a `PriorityGuard`):
1. Stage 0: per file, size / mtime and the length of its *image data* from headers only (cache first). Hashed bytes (`layout_of`): JPEG = all segments except APPn / COM plus the scan; PNG = IHDR, PLTE, tRNS, IDAT, animation chunks; WebP = bitstream, alpha, animation chunks; everything else (HEIC, AVIF, GIF, BMP, RAW) whole. Videos are skipped (`is_video`). `ignoreMetadata` off = whole files (`mode` 0 vs 1 in the cache).
2. Stage 1 groups by data length; stage 2 by hash of the first + last 64 KB; stage 3 by hash of everything (`regroup`, `fill_hashes`). Only files still sharing a key go on; each stage saves new values (`save_dirty`). Hash = first 16 bytes of SHA-256.
3. A cancelled run returns no group (groups are certain only after stage 3). Result: `Report` with groups of paths, `unreadable`, `wholeFileExtensions` (formats where metadata could not be ignored). Workers: half the cores, clamped to 2–6.

**Similar** (`find_similar_images` → `similar::run`):
1. Fingerprint per photo from `photo_phash` (key: size, mtime, `ALGO_VERSION`) or computed (`phash::fingerprint_file`): the cached thumbnail when it exists, else a reduced decode; **never writes to the thumbnail cache**. Heavy full-resolution decodes are limited to 2 at once. Formats that cannot be decoded count in `unsupported`.
2. Every scanned photo is compared with the others (popcount of 64-bit words), keeping pairs within `maxDistance` (UI: strict 3 / normal 6 / loose 10 bits). Left out whatever the distance: RAW with non-RAW (unless `includeRawPairs`), proportions differing by more than 15 % (unless rotations tolerated), **flat images**, and bursts (`ignoreBursts`, `burstMs`): only a non-zero time gap counts as a burst, because a copy shares its original's time; the sub-second part is read on demand (`read_subsec_ms`).
3. Pairs are joined (union-find); groups above `MAX_GROUP` (500) are dropped and counted in `skippedGroups`.

**By name** (no file read): `list_duplicate_candidates` returns `(path, dateTaken, inScope)`; `findNameGroups` (JS, since the pattern is a JS regex) builds keys (first capture group, or the name without extension), compares ignoring case with "contains" in both directions through an index of rare 3/4-letter pieces, never pair by pair; minimum key length and `MAX_NAME_GROUP` (500) stop permissive patterns. `runIdenticalSearch` can combine name + hash (`mergeGroups`, reasons "Same file name" / "Same image data").

**Results mode** (`showDuplicateResults`): a snapshot of the view is saved, filters cleared, a banner offers group sorting (count / size / path, remembered in `duplicateGroupSort`), the keep-order panel (`duplicateKeepSettings`: ordered criteria pixels, size, rating, date, short name, path last; applied at once, no new search) and "Select all but the best" (`selectDuplicatesExceptBest`): it only selects, deletion is the normal Delete with trash and confirmation. A finished search stays `ready` in the task list until "Show" or "Ignore"; the grid never changes without a click. Navigating by hand ends the mode.

## Contracts
- IPC commands: `find_duplicates`, `find_similar_images`, `list_duplicate_candidates` (`generated/ipc-commands.md`).
- Events: `scan-progress` (fraction ×100).
- Database: `photo_hashes` (photo_id, mode, version, size, modified, data_len, tolerant, partial_hash, full_hash), `photo_phash` (8 hashes blob + version); rows of removed photos are deleted at each run; see `generated/db-schema.md`.
- Settings: `identicalSearchSettings`, `similarSearchSettings`, `duplicateGroupSort`, `duplicateKeepSettings`.

## Dependencies
- Uses: `db.rs` pool, `thumbnails` / `integrity` decoders (via `phash.rs`), `raw-settings.js` (name pattern), task queue of `main.js`, `semantic::PriorityGuard`.
- Used by: `semantic.rs` (`duplicates::DataHash`, `LAYOUT_VERSION`, `is_video`) for the image key.

## Invariants and sensitive areas
- ⚠ sensitive: **`LAYOUT_VERSION`** (duplicates.rs) must be incremented whenever the set of hashed bytes changes (`layout_of`, `jpeg_ranges`, `png_ranges`, `webp_ranges`, partial size, hash truncation). Otherwise `photo_hashes` returns false matches. The semantic scan stores it as `hash_version` next to its own copy of the hash: a bump makes every embedding row be re-analysed once (see `semantic.md`). Do not bump it for no reason.
- ⚠ sensitive: **`ALGO_VERSION`** (phash.rs) must be incremented when the pHash algorithm or the way pixels are obtained changes (cached fingerprints are otherwise wrong).
- Cache validity is size + mtime: a file modified without these changing is not noticed.
- Mixed RAW + JPEG results (`mixedFormats`) never offer cleanup: it could remove the only RAW.
- A group whose best copy is hidden by a filter is not selected: cleanup can never remove every copy.
- Zero impact at rest: no thread, tables empty until the first search.

## Tests
`tests/duplicates.rs` (metadata ignored, PNG text chunks, whole-file formats, scopes, cache reuse / invalidation, cancel, videos, shared `DataHash`), `tests/similar.rs` (resized, rotation option, flat, bursts, cache, loose threshold chain), `tests/phash.rs`. Gap: name search and the results mode (JS) are not tested.

## How to extend
1. New format with metadata tolerance: add a `*_ranges` parser in `layout_of`, bump `LAYOUT_VERSION`, add a test beside `png_text_chunks_are_ignored`.
2. New similarity filter: add a field to `similar::Request` and `similarRequestFields` in duplicates.js, a condition in `run`.
3. New keep criterion: `KEEP_CRITERIA` and `sortGroupMembers` in duplicates.js.
4. New search kind: entry in `DUPLICATE_KINDS` (main.js) and a command in `main.rs` (`generate_handler!`).

## Open questions
none. The `photo_phash` key is size + mtime + `ALGO_VERSION` only: changing the thumbnail cache size does not invalidate fingerprints. This is acceptable because the hash is computed on a 32×32 reduction (any cached thumbnail is ≥ 512 px), but fingerprints computed from a thumbnail and from the original may differ by a few bits.
