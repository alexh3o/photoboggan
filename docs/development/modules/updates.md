<!-- verified: none | sources: src-tauri/src/update_check.rs, src/update-check.js -->
# Update check and installer

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Commands: `check_for_update` (`fetch_info`: GitHub releases, refused offline), `download_update` (queued `kind: 'update'`; re-reads the release, `update_changed` if it moved; `copy_verified` checks size + SHA-256 while writing to the OS temp dir `photoboggan-update/`), `install_update` (re-checks, then `msiexec` on Windows / `xdg-open` on Linux).
- Asset choice: `pick_asset` (name, `DOWNLOAD_URL_PREFIX`, size limit, published `digest` required), version from the tag only (`parse_version`).
- Frontend: `initUpdateCheck` (settings checkboxes, at most once per 24 h at startup), `onUpdateAccessChanged` (offline mode), dialog with notes / download / install; the close guards run before installing on Windows.
- Rules: AGENTS.md §5.J (link it). Tests: `tests/update_check.rs`.

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
