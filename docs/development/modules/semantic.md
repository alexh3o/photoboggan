<!-- verified: a9ca28f | sources: src-tauri/src/semantic.rs, src-tauri/src/semantic_models.rs, src-tauri/src/semantic_search.rs, src-tauri/src/semantic_keywords.rs, src/semantic.js, src/semantic-settings.js, src/semantic-tagging.js, src/semantic-keywords.js, src/semantic-exclusions.js, src/main.js -->
# Semantic search and automatic keywords

## Purpose
Optional "content search" (Settings > Search, off by default): a local SigLIP 2 model turns every photo into an embedding so the user can search by describing a scene, find similar photos, and get keyword help (photos that may deserve a keyword; keywords that may suit a photo). Everything is derived data in the catalogue; nothing is ever written to photo files except by the normal keyword Apply. Rules: AGENTS.md §5.L.

## Files
| File | Role |
|---|---|
| `semantic.rs` | Image preprocessing (PIL-exact bilinear), tokenizer, `VisionEncoder` / `TextEncoder`, fp16 storage, tables, low-priority scan task (`semantic_scan`), `PriorityGuard`, stats, `delete_semantic_data`. |
| `semantic_search.rs` | In-memory index (`SearchCache`, half floats), text / image search, `relevance_cut`, idle release (`IDLE_RELEASE`, 5 min), `keyword_photo_ids`. |
| `semantic_keywords.rs` | Keyword → photos (`keyword_candidates`) and photo → keywords (`photo_suggestions`), rejections. |
| `semantic_models.rs` | Manifest `semantic_models.json`, `ENABLED` gate, status / download / import / delete of model files. |
| `semantic.js` | Search field, scope toggle (`view` / `library`), `searchText`, `searchImage`. |
| `semantic-settings.js` | Setting + model install state (`isSemanticEnabled`), Settings section, `analyseContent` (queues the analysis). |
| `semantic-keywords.js` | Toolbar keyword box also finds photos by content (`syncKeywordSuggestions`, setting `semanticInKeywordSearch`). |
| `semantic-tagging.js` | "Photos likely to match" for a keyword and the "Suggestions" block of the Keywords panel. |
| `semantic-exclusions.js` | Settings list of keywords never suggested (and their subtrees). |
| `main.js` | Task lane `pumpSemanticQueue`; section "CONTENT SEARCH RESULTS" (mode `semanticSearch`). |

## How it works

**1. The gate (zero cost when disabled).** The setting `semanticSearch` is sent as `set_semantic_enabled` at startup and on change. Backend: `semantic_models::ensure_enabled` makes every command return `semantic_disabled`; disabling also calls `semantic::on_disabled` (stop the scan, `semantic_search::release_all`) and stops a model download. Frontend: `isSemanticEnabled()` = setting on **and** model installed; every function returns before `invoke` when false; body class `no-semantic` hides `.semantic-only` elements; context-menu entries are not created. No model, thread or computation exists before the first scan or search.

**2. Model files.** Manifest entry (image size, embedding size, normalisation, logit scale / bias, template) + files `vision`, `text`, `tokenizer`, `notice` in `<data dir>/models/semantic/<model_id>/`; ONNX Runtime comes from the faces manifest in `models/` (`face_models::runtime_file`). `download_semantic_model` (queued task) refuses with `internet_disabled` in offline mode; `import_semantic_model(directory)` works offline; checks via `model_files` (SHA-256). `active_model()` is the first manifest entry.

**3. Analysis (`semantic_scan`).** Queued by `analyseContent` as `kind: 'semantic'` and run by **its own lane** (`pumpSemanticQueue`, one at a time, parallel to the main queue; the backend also refuses a second one: `semantic_scan_running`, `ScanSlot`). Steps in `run_scan`:
1. `select_targets` (scope: selection / folder / library; `skip_raw`), `Standing` per photo: `Analysed` (same model, size and mtime), `Failed` (not retried until the file changes), `Pending`.
2. For pending photos with a stored key: compare the **image key** (`ImageKey` = image-data hash from `duplicates.rs` + EXIF orientation when outside the hash). Unchanged → the row is only refreshed (size / mtime), no decoding, model not loaded.
3. Others: decode pixels (`load_pixels`: cached thumbnail, else the original; thumbnails written only with `semanticWriteThumbnails`), `image_tensor`, run the vision session in batches of 16, one transaction per batch (`store_batch_with_hashes`). The loaded index is updated in place (`on_batch_stored`).
4. Runs on a dedicated thread with lowered OS priority; `threads` 1–4 (`semanticScanThreads`). Between batches it waits while `foreground_busy()`: other tasks hold a `PriorityGuard` (scans, writes, integrity, face scan, duplicates, thumbnails). Progress goes through `scan-progress` with `done`, `total`, `remainingSeconds`, `paused`. Cancel keeps stored batches. A panic while reading one photo fails only that photo (`guard_panic`).

**4. Search.** `semantic_search_text(query, scope)` / `semantic_search_image(photoId, scope)` → `semantic_search::search`: the index is built on the first search from all embeddings of the active model (contiguous fp16 array, dot products in parallel), the query is normalised (`prepare_query`, wrapped in a template when ≤ 3 words), the top `MAX_RESULTS` (2000) are returned sorted by cosine. The UI keeps `cos ≥ best − Δ` (`relevance_cut`, slider `semanticRelevance`): moving the slider filters locally (`matchesSemanticCut` in main.js), no new request. After 5 minutes without search the index and text encoder are dropped. Results display in mode `semanticSearch` of main.js (like `duplicateSearch` / `rawSearch`): banner, slider, sort; navigating by hand or disabling ends it.

**5. Keyword help.** `semantic_keyword_candidates(keywordId, scope)`: with ≥ 5 (`MIN_EXAMPLES`) analysed tagged photos, score = mean cosine with the 5 nearest tagged photos (up to 256 examples), threshold = 10 % quantile of the keyword's own scores; fewer examples → cosine with the keyword name against `TEXT_THRESHOLD`. `semantic_photo_suggestions(photoId, excludedKeywordIds)`: up to 5 eligible leaf keywords with score ≥ 0.80 (`SUGGESTION_THRESHOLD`). `reject_keyword_suggestion` stores a row in `keyword_suggestion_rejections`. `keyword_photo_ids` / `semantic_keyword_photos` serve the toolbar box. **Accepting a suggestion only calls `addPendingKeyword`** (keywords-panel.js): a pending keyword, written by the normal Apply.

## Contracts
- IPC commands: `set_semantic_enabled`, `get_semantic_model_status`, `download_semantic_model`, `import_semantic_model`, `delete_semantic_model`, `semantic_scan`, `get_semantic_stats`, `get_analysed_photo_ids`, `delete_semantic_data`, `semantic_search_text`, `semantic_search_image`, `semantic_keyword_photos`, `semantic_keyword_candidates`, `semantic_photo_suggestions`, `reject_keyword_suggestion` (`generated/ipc-commands.md`).
- Events: `scan-progress` (scan and download).
- Database: `photo_embeddings` (vec fp16, `model_id`, size, mtime, `data_hash`, `hash_version`, `orientation`), `photo_embedding_failures`, `keyword_suggestion_rejections`; orphans purged by `remove_orphans` (`generated/db-schema.md`).
- Settings: `semanticSearch`, `semanticScanRaw`, `semanticWriteThumbnails`, `semanticScanThreads`, `semanticRelevance`, `semanticInKeywordSearch`, `semanticKeywordsInSearch`, `semanticKeywordSort`, `semanticShowScore`, `semanticScope`, `semanticExcludedKeywords`, `keywordSuggestionsOpen` (`generated/config.md`). Error keys: `semantic_disabled`, `semantic_scan_running`, `semantic_model_missing`, `semantic_unsupported_platform`, `semantic_photo_not_analysed`, `semantic_empty_query`, `unknown_keyword`, `internet_disabled`.

## Dependencies
- Uses: `duplicates.rs` (image-data hash: `LAYOUT_VERSION`), thumbnails cache, `onnx_runtime.rs`, `model_files.rs`, `face_models.rs` (`models_dir`, `internet_allowed`, runtime file), `keywords.rs` (`collect_rows`, tree), `keywords-panel.js` (`addPendingKeyword`).
- Used by: `main.js` (queue lane, results mode, context menus), `keywords-panel.js` (Suggestions block); other tasks call `PriorityGuard::new()`.

## Invariants and sensitive areas
- ⚠ sensitive: **never write on a suggestion click.** Only `addPendingKeyword`; no other write path (AGENTS.md §5.L).
- ⚠ sensitive: **stale answers.** The backend cancels nothing; each request does `++counter` and ignores its answer when a newer one exists (`requestCounter` in semantic.js / semantic-keywords.js, `candidatesCounter`, `suggestionCounter` in semantic-tagging.js). A new async call must follow it.
- ⚠ sensitive: embeddings carry `model_id`; changing model invalidates them. The refresh shortcut depends on `duplicates::LAYOUT_VERSION`: when it is bumped, `hash_version` differs and every row is analysed again, then re-hashed (test `rows_without_a_hash_or_with_another_hash_version_are_analysed_again_then_hashed`). See `duplicates.md`.
- ⚠ sensitive: a loaded model file cannot be deleted on Windows: `delete_semantic_model` / disabling must release sessions first (`release_all`, `stop_scan_and_wait`).
- Every new foreground task that could be slowed by the scan should hold a `PriorityGuard`.

## Tests
`tests/semantic.rs` (half-float round trip, PIL parity on fixtures, scan standing, failures, refresh without re-analysis, orientation key, priority and stop, gate), `tests/semantic_keywords.rs` (examples score, thresholds, exclusions), `tests/semantic_models.rs`, plus `semantic_search` cases. Tests needing the real model are `#[ignore]` (`SEMANTIC_MODEL_DIR=…`; fixtures `semantic_reference.json`). Gap: frontend (not tested by design).

## How to extend
1. New model: add a manifest entry (`scripts/prepare-semantic-models.mjs`), new id; old embeddings are ignored.
2. New search entry point: command in `semantic_search.rs` using `ensure_enabled`, counter pattern on the frontend, register in `generate_handler!`.
3. New setting: `defaults.jsonc` + settings UI + `locales/`; keep it idle when disabled.
4. New foreground task: add `let _priority = crate::semantic::PriorityGuard::new();`.

## Open questions
none. Holders of `PriorityGuard` (checked): in `main.rs` `generate_thumbnail`, `keep_cached_images` (every metadata write), `purge_orphan_cache`, `run_scan`, `integrity_scan`, `find_duplicates`, `find_similar_images`, `rotate_photo`, `sync_library`, `move_photos`, `copy_photos_with_progress`, `resize_photo`; plus `keywords::run_write` and `face_detect::detect_faces`. Restart: a semantic task is not in `RESUMABLE_TASK_KINDS` and is not restored; running the analysis again skips photos already `Analysed`, so nothing is recomputed.
