<!-- verified: none | sources: src-tauri/src/exif.rs, src-tauri/src/exiftool.rs, src/metadata-writes.js, src/metadata-settings.js, src/marking-settings.js, src/order-list.js -->
# Metadata reading and writing (EXIF / IPTC / XMP, ExifTool, sidecars)

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Reading: `exif::read_exif` (full read during scans), `read_marking` (rating / colour / pick only), priorities `set_read_priority` + `*_SOURCE_IDS` / `*_PRIORITY`, keyword formats `HIERARCHY_IDS` / `parse_hierarchical_keywords`, sidecar `read_sidecar`; "show all metadata" `read_metadata_details` (`get_photo_details`).
- Write dispatch: `exif::write_metadata` (keywords, title, description, regions, GPS) and `exif::write_xmp_metadata` (marking) → `exiftool::write_metadata` / `write_marking` when `exiftool::is_enabled()`, else internal: `jpeg_replace_xmp` + `jpeg_replace_iptc` + comment, `heif::update_xmp`, or `write_xmp_sidecar_with` (`sidecar_target`). All end in `write_file_atomically` or ExifTool `-overwrite_original`.
- ExifTool process management: `launcher` / `detect` / `probe` (chosen path > bundled > PATH), pool `acquire` / `release` (3 processes, idle watcher), `run`, `overwrite`, `write_to`, `recover_after_failure`, `take_recoveries`, `path_lock`. Commands: `set_metadata_writer`, `get_exiftool_status`, `exiftool_prewarm`.
- Frontend: `metadata-writes.js` is the single write circuit of the right panel (`registerEditor`, `applyPending`, `runLocked` with `QUEUE_THRESHOLD` 20, `showFailureDialog`, `reportWriteRecoveries`, `confirmCloseWithPendingEdits`); settings UI `initMetadataSettings` (writer, read orders via `order-list.js`, `set_metadata_read_order`); `initMarkingSettings` (colour / pick on or off, body classes).
- Must cover `invariants.md` §1–2 without copying it: link it and add what is module-specific (XMP text helpers `update_xmp_*`, MWG regions, IPTC truncation `truncate_utf8`).
- Tests: `tests/exif.rs` (fast, internal writer) and `tests/exiftool.rs` (many `#[ignore]` integration tests: `cargo test exiftool:: -- --ignored --test-threads=1`).

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
