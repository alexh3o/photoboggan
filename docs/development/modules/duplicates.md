<!-- verified: none | sources: src-tauri/src/duplicates.rs, src-tauri/src/similar.rs, src-tauri/src/phash.rs, src/duplicates.js, src/duplicate-names.js, src/duplicates-modal.js, src/main.js -->
# Duplicates (identical, similar, by name)

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Commands live in main.rs: `find_duplicates` → `duplicates::run`, `find_similar_images` → `similar::run`, `list_duplicate_candidates` → `duplicates::name_candidates`; all queued as `kind: 'duplicates'` with a `dedupeKey` (main.js, section "DUPLICATES").
- Identical (duplicates.rs): `layout_of` (which bytes are hashed per format), three stages (length, 64 KB head and tail, full hash) `image_data_hash`, cache `cached_data_hashes` / `remember_data_hash` keyed by `LAYOUT_VERSION`.
- Similar (similar.rs + phash.rs): fingerprint from the cached thumbnail if present, else reduced decode; 8 variants for rotations / mirrors; cache keyed by `ALGO_VERSION`; never writes the thumbnail cache.
- By name: `findNameGroups` (duplicate-names.js; JS regex from `compileNamePattern` in raw-settings.js), `MAX_NAME_GROUP`.
- Results UI: `orderGroups`, `sortGroupMembers`, `mergeGroups`, keep settings `getKeepSettings` (duplicates.js); window "More…" `openDuplicatesModal`; the task ends `ready` and `showReadyDuplicateResults` switches the grid (main.js).
- Rules: AGENTS.md §5.K (link it). Cleanup actions (select all but the best copy, trash) are planned, not implemented: ⚠ verify in the code before mentioning them.

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
