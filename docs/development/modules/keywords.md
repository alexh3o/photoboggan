<!-- verified: none | sources: src-tauri/src/keywords.rs, src/keywords-panel.js, src/description-panel.js -->
# Hierarchical keywords and description

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Tree in the database: `init_schema` (`keyword_nodes`, `photo_keywords`), `ensure_node`, `store_photo_keywords` (filled by scans from the file's hierarchy), commands `get_keyword_tree`, `get_photo_keyword_ids`, `get_keyword_usage`, `create_keyword` (`validate_name`: no `/`, `|`, `,`).
- Write: `apply_metadata_changes` → `run_write` (global `WRITE_LOCK`, 3 rayon threads, `keep_cached_images` + `exif::write_metadata`, re-read + `text_mismatch` / `regions_mismatch` / `gps_mismatch`, DB updated in one transaction, `semantic_keywords::on_keywords_changed`). `KeywordWriteItem` also carries title, description, faces and GPS.
- Delete / rename a keyword everywhere: `get_keyword_delete_info`, `delete_keyword` → `run_delete` (`photos_carrying`, `delete_subtree`, `restore_person_links`), `rename_keyword` → `run_rename`. Read order of keyword formats: `set_metadata_read_order` with kind `keywords` (AGENTS.md §5.D still names a `set_keyword_format_order` command that no longer exists).
- Panel (keywords-panel.js): `initKeywordsPanel`, `refreshKeywordsPanel`, `addPendingKeyword` (also the only way semantic suggestions add keywords), `invalidateKeywordTree`, `renameKeywordById`, compare mode `setKeywordsCompareMode`; registers itself as an editor in `metadata-writes.js`.
- Description tab (description-panel.js): `initDescriptionPanel`, `refreshDescriptionPanel`; title and description stay pending until Apply, same circuit.
- Trap: only the last level of a path is active; `acdsee:categories`, IPTC and XPKeywords rules are in AGENTS.md §5.D: link, do not copy.

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
