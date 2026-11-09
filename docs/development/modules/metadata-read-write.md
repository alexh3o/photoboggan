<!-- verified: a9ca28f | sources: src-tauri/src/exif.rs, src-tauri/src/exiftool.rs, src/metadata-writes.js, src/metadata-settings.js, src/marking-settings.js, src/order-list.js -->
# Metadata reading and writing (EXIF / IPTC / XMP, ExifTool, sidecars)

## Purpose
Reads the metadata of a photo (camera data, rating, colour, pick, title, description, GPS, keywords, face regions, orientation) from the file and its sidecar, and writes the user's edits back so that digiKam, Lightroom and Windows Explorer see them. Two writers exist (ExifTool or internal) and the user chooses the read priority of every duplicated field. Rules that apply to all writes (pixels untouched, atomic replacement, ExifTool recovery, one write per file, sidecar naming) are in `../invariants.md` §1–2 and are not repeated here.

## Files
| File | Role |
|---|---|
| `exif.rs` | Reading (`read_exif`, `read_marking`), XMP text editing (`update_xmp_*`), JPEG segment rewriting (XMP / IPTC / comment), sidecar targeting, internal write entry points, "all metadata" view |
| `exiftool.rs` | ExifTool detection, process pool, tag arguments, recovery after failure, per-file locks |
| `metadata-writes.js` | The single write circuit of the right panel (Keywords and Description tabs, faces) |
| `metadata-settings.js` | Settings > Metadata: writer choice, ExifTool path and status, read-order tables |
| `order-list.js` | Reorderable table component (drag handle / arrows), stores the order in localStorage |
| `marking-settings.js` | Settings > Metadata > marking: colours and pick on/off |

## How it works

### Reading a file (`exif::read_exif`)
Called by `library_sync::read_photo` for every scan and sync. Videos go to `read_video_metadata` (sidecar only, no file read).
1. `parse_xmp` reads the XMP: the embedded packet (JPEG APP1 via `read_embedded_xmp`, HEIC via `heif::read_xmp`) and the sidecar chosen by `read_sidecar` (never both merged for the same image). For rating, colour, pick, title and description, each source missing in the embedded packet is looked up in the sidecar; face regions come from the embedded packet, else from the sidecar.
2. `read_jpeg_fields` reads IPTC (keywords, ObjectName, Caption) and the JPEG comment.
3. For every EXIF source returned by `thumbnails::read_exif_sources` (several for CR3 / RAF): camera data (date, aperture, ISO, lens, size, flash), GPS, orientation; and, unless `exiftool::skip_exif_metadata()`, the Windows fields XPKeywords, XPTitle, XPComment, Rating, RatingPercent, ImageDescription, UserComment. A source that lacks a value never erases the one found by another (`keep`).
4. Flat keywords are merged without duplicates (XMP `dc:subject`, IPTC, XPKeywords), then `add_hierarchical_leaves`.
5. `resolve_values` picks, for rating, colour, pick, title, description and GPS, the first source with data in the user's order. `ExifMetadata` keeps every source value (`rating_sources`, `text_sources`…) so that write checks can look at one source.
6. Orientation is resolved with `orientation::resolve` (see `thumbnails-and-previews.md`); HEIC dimensions and orientation come from the container.

`read_marking` is the cheap version for rating / colour / pick only (the XMP in the first 64 KB of a JPEG, else the whole embedded packet; HEIC through the same `heif::read_xmp` as `read_exif`; plus the sidecar): it is the read-back used to verify a marking write.

### Read priorities
Six sources lists are in `exif.rs` as `*_SOURCE_IDS` constants with a matching `*_PRIORITY` static: `RATING`, `COLOR`, `PICK`, `TITLE`, `DESCRIPTION`, `GPS`, plus `HIERARCHY_IDS` (5 keyword formats, `HIERARCHY_PRIORITY`) and `faces::REGION_PRIORITY`. The frontend keeps each order in localStorage (`keywordFormatOrder`, `titleFormatOrder`, `descriptionFormatOrder`… one key per kind, listed in `READ_ORDERS` of `metadata-settings.js`; `resolveOrder` in `order-list.js` completes an old stored order with new ids) and sends it with `set_metadata_read_order { kind, order }` (command in `keywords.rs`, forwards to `exif::set_read_priority`; kinds `keywords`, `title`, `description`, `rating`, `color`, `pick`, `gps`, `faces`; `order` must contain each id exactly once, else `invalid_order`; unknown kind → `invalid_kind`). Orders are sent at startup (`initMetadataSettings`) and on each change; a new order only applies to files read afterwards, so the user must rescan. Value 0 is an answer; only absence falls through.

Display-only rows: flat keyword fields (`dc:subject`, IPTC, XPKeywords) have no priority. With the internal writer and "ignore EXIF" (`skipExifWithInternalWriter`, default on), EXIF rows are greyed (`markIgnored`) because that writer neither writes nor erases them.

### Writing (backend)
Entry points: `exif::write_metadata` (keywords, title, description, face regions, GPS: a `MetadataUpdate`, `None` field = untouched) and `exif::write_xmp_metadata` (rating, colour, pick: an `XmpEdit`). Callers: `keywords::run_write`, `update_photos_marking` (main.rs), `geolocation`, `faces`.
1. If `exiftool::is_enabled()` → `exiftool::write_metadata` / `write_marking` (see below). Otherwise internal:
2. `exiftool::path_lock(path)` (16 striped mutexes) is taken.
3. HEIC / HEIF / HIF: `heif::update_xmp` writes the container XMP; `Unsupported(reason)` falls back to the sidecar with a log line.
4. JPEG: `write_jpeg_metadata` rewrites XMP (`jpeg_replace_xmp` + `update_xmp_all`), IPTC (`jpeg_replace_iptc`: keywords, ObjectName, Caption) and the comment in one pass, then `write_file_atomically`. If the output is identical to the input nothing is written.
5. Everything else: `write_xmp_sidecar_with`, which refuses (`image_gone`) if the image vanished, builds the target with `sidecar_target` and only writes if the content changed. A removal-only update on an image without XMP creates nothing (`adds_values`).
6. EXIF is never modified by the internal path.

The same field set is written by both writers; ExifTool adds the JPEG-only EXIF fields (XPKeywords, XPTitle, XPComment, ImageDescription, UserComment, Rating, RatingPercent). Lists of tags: doc comments of `exiftool::write_metadata` and `write_marking`. IPTC fields are cut to their legal length (`truncate_utf8`: ObjectName 64 bytes, Caption 2000, JPEG comment 65533); `text_mismatch` applies the same cuts when verifying.

Details worth knowing:
- Keywords: all active paths go to six places (`dc:subject` leaves from `keyword_leaves`, and the five hierarchical formats; ACDSee as XML text); an empty list removes them.
- Title / description: empty string = remove from all sources. With ExifTool, `lang_alt_tag` replaces only the `x-default` entry and keeps translations.
- Regions: MWG and Microsoft RegionInfo (`update_xmp_regions` / `region_args`); ACDSee is read but not written. Rotation rewrites them (`rotate_xmp_regions`).
- Pick: `pick_values` maps `picked` / `rejected` / `pending` / `none` to `digiKam:PickLabel`, `xmpDM:pick`, `xmpDM:good`. Colour is written to `xmp:Label`, `photoshop:Urgency`, `digiKam:ColorLabel`.

### ExifTool (`exiftool.rs`)
- **Settings** (`set_metadata_writer`: mode `exiftool` / `internal`, custom path, `skip_exif`): Rust statics, resent by `initMetadataSettings` at startup. Changing mode or path clears the detected launcher and calls `shutdown`; changing only `skip_exif` does not.
- **Detection** (`detect`, `probe` = `exiftool -ver`): the custom path alone if set (no silent fallback), else the bundled copy (`exiftool.exe` on Windows, `perl exiftool` elsewhere), else `PATH`. The result is cached until a setting change or `get_exiftool_status`, which re-detects (the Settings tab calls it on opening).
- **Pool** (`acquire` / `release`): persistent `-stay_open` processes, at most `MAX_PROCESSES` = 3 (same as the 3 write threads of `keywords::run_write`), a caller waits on a condvar when all are busy. `watch_idle` stops processes unused for `IDLE_TIMEOUT` (45 s); `COMMAND_TIMEOUT` (120 s) kills a stuck process and counts a failure; a failed or outdated-generation process is not reused. `exiftool_prewarm` starts one process when the user edits a first keyword. `shutdown` runs at window close (`main.rs`); on Windows a Job object (`bind_to_app_lifetime`) kills ExifTool if the app dies without it.
- **A write** (`run`): refuses values containing a newline; success only if ExifTool prints "1 files updated / unchanged / created"; `Error` lines on stderr = failure; `Warning` lines are logged only. `overwrite` always adds `-overwrite_original`; on failure `recover_after_failure` pushes a `Recovery` (see `../invariants.md` §1.3); `take_write_recoveries` (main.rs) writes the log file to `<data dir>/logs/` and the frontend shows it.
- **Targets** (`target_of`): JPEG and HEIC in the file; all else in the sidecar, created through a temp name then renamed (`write_to`), or copied from the shared `photo.xmp` (`seed`) first.

### Frontend write circuit (`metadata-writes.js`)
1. Each right-panel tab calls `registerEditor({ isDirty, pendingItems, afterWrite, discard, … })`; edits stay pending until Apply, Ctrl+Enter, selection change (confirmation, or automatic with `keywordsAutoApply`) or app close. The faces editor has `scope: 'library'` (pending across the whole library: no question on selection change, written only on explicit request or at close).
2. `applyPending` merges all editors' items per photo (`photo_id`), runs `resolveFaceKeywordConflicts` (`face_keyword_conflicts`; the user keeps the keyword or turns the face to unknown), then `runWrite` → `runLocked('apply_metadata_changes', { items }, count, finish)`.
3. `runLocked`: `count >= QUEUE_THRESHOLD` (20) goes through `host.enqueueKeywordTask` (cancellable task); below, a direct `invoke`. Either way a counter (`directWrites` / `queuedWrites`) locks the UI (`isWriteLocked`, `onLockChange`), and `reportWriteRecoveries` is awaited (calls serialized, one blocking dialog each) before `finish`.
4. `finishWrite` updates the UI from the result (`afterWrite` of each editor) and lists failed files (`showFailedFiles`).

Marking (rating / colour / pick) does not use this circuit: it goes through `update_photos_marking` (see `photo-operations.md`, `../architecture.md` flow 3), which verifies with `read_marking` + `marking_mismatch`.

`marking-settings.js` only toggles `colorLabelEnabled` (default true) and `pickLabelEnabled` (default false) and sets the body classes `no-color-labels` / `no-pick-labels`; values stay read and stored when disabled.

## Contracts
- IPC: `set_metadata_writer`, `get_exiftool_status`, `exiftool_prewarm` (exiftool.rs); `set_metadata_read_order` (keywords.rs); `get_photo_details` (→ `read_metadata_details`, the "all metadata" view: EXIF, XMP properties, IPTC, values capped at 1000 chars); `take_write_recoveries`, `update_photos_marking` (main.rs); `apply_metadata_changes` (keywords.rs, see `keywords.md`). Signatures: `../generated/ipc-commands.md`.
- Events: none.
- Database: none directly (callers store what `read_exif` returns).
- Settings: `metadataWriter`, `exiftoolPath`, `skipExifWithInternalWriter`, `metadataOrderKind`, `<kind>FormatOrder` keys, `keywordsAutoApply`, `keywordsAutoApplyAsked`, `colorLabelEnabled`, `pickLabelEnabled` (`../generated/config.md`).

## Dependencies
- Uses: `heif.rs` (HEIC XMP), `thumbnails::read_exif_sources`, `orientation.rs`, `faces` (region types, `reading_enabled`), `video` (`is_video_path`), `library_sync::is_photo_file`.
- Used by: `library_sync` (read), `keywords::run_write`, `main.rs` marking / rotation, `geolocation`, `faces`, `orientation` (`write_xmp_orientation`, ExifTool rotation args).

## Invariants and sensitive areas
- ⚠ sensitive: any new written field must be added to both writers (`metadata_args` / `update_xmp_all` / `jpeg_replace_iptc`) and to the read-back checks, or one writer silently diverges (`../recipes.md`).
- ⚠ sensitive: `sidecar_target` / `read_sidecar` / `sidecar_candidates` are the only place sidecar names are built; reading and writing must stay in step (`../invariants.md` §2.2).
- ⚠ sensitive: read priorities, `skip_exif`, and the writer mode are process-wide statics; a test touching them must be the only one (AGENTS.md §5.I).
- ⚠ sensitive: `jpeg_replace_*` parse JPEG segments by hand; `check_jpeg_structure` rejects broken files rather than guessing.
- Marking writes verify only the sources the file can hold: a RAW whose EXIF rating comes first in the order is not checked on that source (doc of `read_marking`).

## Tests
`tests/exif.rs` (46 fast tests: internal writer, sidecars, markings, atomic write, IPTC, regions) and `tests/exiftool.rs` (19, mostly `#[ignore]`: run `cargo test exiftool:: -- --ignored --test-threads=1`; the recovery tests are fast). Lists: `../generated/tests.md`. Gap: no test of the frontend circuit (AGENTS.md §5.I), nor of `order-list.js`.

## How to extend
1. New written field: add it in `MetadataUpdate` / `XmpEdit`, in `update_xmp_all` (+ IPTC if relevant) and in `exiftool::metadata_args`, then verify it in `keywords::run_write` read-back and add a test in `tests/exif.rs` (`../recipes.md`).
2. New readable source for an existing field: add its id to the `*_SOURCE_IDS` array (extend the `[usize; N]` statics), fill the slot in `read_exif` / `parse_xmp`, add the row to `READ_ORDERS` in `metadata-settings.js` and locale keys in `en.json` / `fr.json`.
3. New editor tab: `registerEditor` with `pendingItems` returning items for `apply_metadata_changes`.

## Open questions
none (HEIC: written in the container, AGENTS.md §5.D now says so; `read_marking` and `read_exif` read the same HEIC XMP).
