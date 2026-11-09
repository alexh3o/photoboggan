<!-- verified: none | sources: src-tauri/src/semantic.rs, src-tauri/src/semantic_models.rs, src-tauri/src/semantic_search.rs, src-tauri/src/semantic_keywords.rs, src/semantic.js, src/semantic-settings.js, src/semantic-tagging.js, src/semantic-keywords.js, src/semantic-exclusions.js, src/main.js -->
# Semantic search and automatic keywords

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Gate: `set_semantic_enabled` (backend) and `isSemanticEnabled()` (semantic-settings.js): every request returns before `invoke` when off, and the backend refuses too; body class `no-semantic`. AGENTS.md §5.L has the rules: link it.
- Analysis: `semantic_scan` (semantic.rs; queued with `kind: 'semantic'`, own lane `pumpSemanticQueue` in main.js; `select_targets`, `store_batch_with_hashes`, pauses while `foreground_busy` / `PriorityGuard`), `get_semantic_stats`, `get_analysed_photo_ids`, `delete_semantic_data`; frontend `analyseContent`.
- Search: `semantic_search_text` / `semantic_search_image` → `semantic_search::search` (`prepare_query`, `relevance_cut`); frontend `searchText` / `searchImage` (semantic.js) and the results mode in main.js section "CONTENT SEARCH RESULTS".
- Keywords: `semantic_keyword_candidates` (keyword → photos, "Photos likely to match"), `semantic_photo_suggestions` (photo → keywords), `reject_keyword_suggestion`, `semantic_keyword_photos`; frontend `semantic-keywords.js`, `semantic-tagging.js`, exclusions `semantic-exclusions.js`. Accepting a suggestion = `addPendingKeyword` only.
- Models: `semantic_models.rs` (manifest `semantic_models.json`, `model_dir` = `models/semantic/<id>`, `download_semantic_model` / `import_semantic_model` / `delete_semantic_model`); ONNX Runtime shared with faces.
- Trap: stale responses are dropped with request counters (`requestCounter`, `candidatesCounter`, `suggestionCounter`); embeddings carry `model_id` and the image hash version (`duplicates::LAYOUT_VERSION`). Four backend + five frontend files: if it does not fit in 150 lines, split search and keyword suggestions.

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
