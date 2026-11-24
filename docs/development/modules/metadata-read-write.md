<!-- verified: 202492b | sources: src-tauri/src/exif.rs, src-tauri/src/exiftool.rs, src-tauri/src/rights.rs, src/metadata-writes.js, src/metadata-settings.js, src/marking-settings.js, src/order-list.js, src/description-panel.js, src/rights-presets.js, src/info-author.js -->
# Metadata reading and writing (EXIF / IPTC / XMP, ExifTool, sidecars)

## Purpose
Reads the metadata of a photo (camera data, rating, colour, pick, title, description, GPS, keywords, face regions, orientation) from the file and its sidecar, and writes the user's edits back via ExifTool so that digiKam, Lightroom and Windows Explorer see them. The user chooses the read priority of every duplicated field. Rules that apply to all writes (pixels untouched, atomic replacement, ExifTool recovery, one write per file, sidecar naming) are in `../invariants.md` §1–2 and are not repeated here.

## Files
| File | Role |
|---|---|
| `exif.rs` | Reading (`read_exif`, `read_marking`), XMP/IPTC helpers (incl. resized-copy sidecar/XMP helpers), sidecar targeting, write dispatchers, "all metadata" view |
| `exiftool.rs` | ExifTool detection, process pool, tag arguments, recovery after failure, per-file locks |
| `metadata-writes.js` | The single write circuit of the right panel (Keywords and Description tabs, faces) |
| `metadata-settings.js` | Settings > Metadata: ExifTool path and status, read-order tables |
| `order-list.js` | Reorderable table component (drag handle / arrows), stores the order in localStorage |
| `marking-settings.js` | Settings > Metadata > marking: colours and pick on/off |
| `rights.rs` | Author and rights: presets table (`author_presets`), `get_photo_rights`, `get_authors` (see "Author and rights" below) |
| `description-panel.js` | Title, description and the five author / rights fields of the Description tab |
| `rights-presets.js` | Preset line of the Description tab (suggestions, manager window, floppy button) |
| `info-author.js` | Foldable "Author and rights" section of the Info tab (title row like "Metadata", whole row toggles when a field is filled; the "Author" row is always shown) |

## How it works

### Reading a file (`exif::read_exif`)
Called by `library_sync::read_photo` for every scan and sync. Videos go to `read_video_metadata` (sidecar only, no file read).
1. `parse_xmp` reads the XMP: the embedded packet (JPEG APP1 via `read_embedded_xmp`, with `HasExtendedXMP` fallback; HEIC via `heif::read_xmp`) and the sidecar chosen by `read_sidecar` (UTF-8 with Latin-1 fallback, never both merged for the same image). For rating, colour, pick, title and description, each source missing in the embedded packet is looked up in the sidecar; face regions come from the embedded packet, else from the sidecar.
2. `read_jpeg_fields` reads IPTC (keywords, ObjectName, Caption) and the JPEG comment. Legacy non-UTF-8 (Latin-1) IPTC blocks without `1:90` UTF-8 escape are detected by `jpeg_has_legacy_non_utf8_iptc` so writes recode them cleanly.
3. For every EXIF source returned by `thumbnails::read_exif_sources` (several for CR3 / RAF): camera data (date, aperture, ISO, lens, size, flash), GPS, orientation, and the Windows fields XPKeywords, XPTitle, XPComment, Rating, RatingPercent, ImageDescription, UserComment. A source that lacks a value never erases the one found by another (`keep`).
4. Flat keywords are merged without duplicates (XMP `dc:subject`, IPTC, XPKeywords), then `add_hierarchical_leaves`. XMP XML entities, including numeric references such as `&#39;` used for apostrophes by ExifTool, are decoded before values are compared or stored.
5. `resolve_values` picks, for rating, colour, pick, title, description and GPS, the first source with data in the user's order. `ExifMetadata` keeps every source value (`rating_sources`, `text_sources`…) so that write checks can look at one source.
6. Orientation is resolved with `orientation::resolve` (see `thumbnails-and-previews.md`); HEIC dimensions and orientation come from the container.

`read_marking` is the cheap version for rating / colour / pick only (the XMP in the first 64 KB of a JPEG, else the whole embedded packet; HEIC through the same `heif::read_xmp` as `read_exif`; plus the sidecar): it is the read-back used to verify a marking write.

### Read priorities
Six sources lists are in `exif.rs` as `*_SOURCE_IDS` constants with a matching `*_PRIORITY` static: `RATING`, `COLOR`, `PICK`, `TITLE`, `DESCRIPTION`, `GPS`, plus `HIERARCHY_IDS` (5 keyword formats, `HIERARCHY_PRIORITY`) and `faces::REGION_PRIORITY`. The frontend keeps each order in localStorage (`keywordFormatOrder`, `titleFormatOrder`, `descriptionFormatOrder`… one key per kind, listed in `READ_ORDERS` of `metadata-settings.js`; `resolveOrder` in `order-list.js` completes an old stored order with new ids) and sends it with `set_metadata_read_order { kind, order }` (command in `keywords.rs`, forwards to `exif::set_read_priority`; kinds `keywords`, `title`, `description`, `rating`, `color`, `pick`, `gps`, `faces`; `order` must contain each id exactly once, else `invalid_order`; unknown kind → `invalid_kind`). Orders are sent at startup (`initMetadataSettings`) and on each change; a new order only applies to files read afterwards, so the user must rescan. Value 0 is an answer; only absence falls through.

Display-only rows: flat keyword fields (`dc:subject`, IPTC, XPKeywords) have no priority.

### Writing (backend)
Entry points: `exif::write_metadata` (keywords, title, description, face regions, GPS: a `MetadataUpdate`, `None` field = untouched) and `exif::write_xmp_metadata` (rating, colour, pick: an `XmpEdit`), which delegate to `exiftool::write_to` and `exiftool::write_marking`. Callers: `keywords::run_write`, `update_photos_marking` (main.rs), `geolocation`, `faces`.
1. `exiftool::path_lock(path)` (16 striped mutexes, normalized path on Windows) is taken.
2. Read-only files are refused upfront before invoking ExifTool.
3. JPEG and HEIC / HEIF / HIF are written in the file (on JPEG, `-Photoshop:IPTCDigest=new` is recomputed, or removed when IPTC is cleared). Everything else goes to a `.xmp` sidecar (`write_to` refuses `image_gone` if the image vanished; a new sidecar is created atomically with `create_new` as a unique temp file `<image>.<pid>-<seq>.photoboggan-tmp.xmp`, flushed via `flush_to_disk` + `sync_parent_dir`, and renamed without overwriting an existing sidecar; a removal-only update on an image without XMP creates nothing). On non-Windows (`#[cfg(not(windows))]`), `sidecar_target` reuses the single `read_dir` needed for sibling checks to match case-variant existing sidecars (`IMG.CR2.XMP`, `IMG.XMP`) without adding any `read_dir` to mass reads.
4. Arguments pass `--` before the target path; `struct_value` escapes `#` and leading/trailing spaces.

ExifTool writes XMP, IPTC (on JPEG), and JPEG-only EXIF fields (XPKeywords, XPTitle, XPComment, ImageDescription, UserComment, Rating, RatingPercent). Lists of tags: doc comments of `exiftool::write_to` and `write_marking`. IPTC fields are cut to their legal length (`truncate_utf8`: ObjectName 64 bytes, Caption 2000, JPEG comment 65533); `text_mismatch` applies the same cuts when verifying.

### Author and rights
Five fields, each read from several schemes (first one with data in the user's order wins) and written to all of them by ExifTool (a field set to `None` in `MetadataUpdate` is untouched, `Some("")` removes it everywhere):

| Field (`MetadataUpdate` / column) | XMP | IPTC | EXIF (ExifTool, JPEG only) | Source ids |
|---|---|---|---|---|
| Author (`author`) | `dc:creator` (`rdf:Seq`, one item per author), `tiff:Artist` | By-line 2:80 (one dataset per author, 32 bytes) | `Artist` | `xmp-dc`, `xmp-tiff`, `iptc`, `exif` |
| Copyright notice (`copyright`) | `dc:rights`, `tiff:Copyright` (`©` kept) | CopyrightNotice 2:116 (128 bytes) | `Copyright` (`©` becomes `(c)`) | same four |
| Credit (`credit`) | `photoshop:Credit` | Credit 2:110 (32 bytes) | - | `xmp-photoshop`, `iptc` |
| Usage terms (`usage_terms`) | `xmpRights:UsageTerms` | - | - | `xmp-rights` |
| Author e-mail (`author_email`) | `Iptc4xmpCore:CreatorContactInfo` / `CiEmailWork` | - | - | `xmp-iptc-core` |

- Several authors are typed separated by `;` (`split_authors`: trimmed, empty entries dropped) and shown `A; B`. `dc:creator` and By-line get one item per author; `tiff:Artist` and EXIF `Artist` get the joined string.
- `dc:rights` and `xmpRights:UsageTerms`: only `x-default` is written, every other language is erased (ExifTool writes the tag without a language suffix). The translations of `tiff:Copyright` are kept.
- `CreatorContactInfo` is read whole (`parse_contact_info`: element or nested `rdf:Description` attribute forms, any prefix) into `ExifMetadata::contact`; ExifTool merges `XMP-iptcCore:CreatorWorkEmail` into the existing structure itself.
- `ExifMetadata::rights` is the resolved value (`Rights`), `rights_sources` keeps each source (`RightsSources`) for `rights_mismatch`, called at the end of `text_mismatch` with the same source rules as the title (XMP always, IPTC and EXIF for a JPEG), IPTC cuts and the `©` -> `(c)` conversion.
- Reading priorities: kinds `author`, `copyright`, `credit`, `usageTerms`, `authorEmail` of `set_metadata_read_order` (storage keys `authorFormatOrder`… in `READ_ORDERS`).

Storage (`db.rs`, `library_sync::read_photo`, `keywords::run_write`): five `photos` columns. Only `author` is part of `Photo` and `PHOTO_COLUMNS` (it travels with the photo list for the Author filter); the other four are `#[serde(skip)]` on `Photo` and read on demand by `rights::get_photo_rights` for the selection. `run_write` stores the values read back from the file in the same transaction as title and description and returns them in `KeywordWritten` (flattened `rights`). Photos read before these columns existed have empty values until a rescan.

Presets (`rights.rs`): table `author_presets` (unique `name_key`, five value columns). `create_author_preset` returns the existing preset when the name exists (case ignored) and creates an empty one otherwise; `save_author_preset` replaces the five values; `delete_author_preset` only removes the preset. `get_authors` lists the individual authors of the catalogue (visible photos only, `A; B` counted for both, case variants merged) for the filter.

Frontend: `description-panel.js` handles the five fields exactly like the title (null = untouched, `Multiple values`, pending dot on the Description tab, same Apply / Discard circuit through `metadata-writes.js`; items carry `author`, `copyright`, `credit`, `usage_terms`, `author_email`). Copyright and usage terms are `.rights-textarea` fields: they grow from one to three lines with the text (`autoGrow`, measured again by a `ResizeObserver` when the tab is shown or resized) but stay single-line values (Enter does nothing, a pasted line break becomes a space). `rights-presets.js` owns the preset line: choosing a preset fills all five fields as pending edits (blank values included), a new preset empties them, the floppy button replaces the selected preset (after confirmation) or creates one, and turns amber (`--pending-color`, like the pending dots) when a field differs from the selected preset (from the files when none is selected). The line is labelled "Author and rights presets". `info-author.js` renders the "Author and rights" section of the Info tab: a section title styled like "Metadata" whose whole row folds / unfolds the copyright, credit, usage terms and e-mail rows (shown only when filled; fold state: `infoAuthorOpen` in `defaults.jsonc`). The chevron is shown only when at least one of those fields is filled for the active photo; otherwise the title is a plain heading (class `no-details`, no `role="button"`). The "Author" row stays visible and, like the other rows, is a whole clickable row (`exif-editable`, highlighted on hover like the section title: a `::before` wider than the row) that opens the Description tab with the cursor in the matching field (`openDescriptionAt`, input ids in `EDIT_INPUT_IDS`). `author-filters.js` is the Author filter (see `filters-and-search.md`).

Details worth knowing:
- Keywords: all active paths go to six places (`dc:subject` leaves from `keyword_leaves`, and the five hierarchical formats; ACDSee as XML text); an empty list removes them.
- Title / description: empty string = remove from all sources. With ExifTool, `lang_alt_tag` replaces only the `x-default` entry and keeps translations.
- Regions: MWG and Microsoft RegionInfo (`region_args` in `exiftool.rs`); ACDSee is read but not written. Non-face MWG regions (`Pet`, `Focus`, `BarCode`…) are preserved when writing faces (`regions: None` leaves existing regions untouched). Rotation rewrites them (`rotate_xmp_regions`).
- Pick: `pick_values` maps `picked` / `rejected` / `pending` / `none` to `digiKam:PickLabel`, `xmpDM:pick`, `xmpDM:good`. Colour is written to `xmp:Label`, `photoshop:Urgency`, `digiKam:ColorLabel`.

### Written fields (reference)
- Rating: `xmp:Rating` (0–5), `MicrosoftPhoto:Rating`, `acdsee:rating`. Colour: `xmp:Label` (Red, Orange, Yellow, Green, Blue, Magenta, Grey, Black, White or empty), `photoshop:Urgency`, `digiKam:ColorLabel`.
- Pick (`pick_flag`): `none`, `pending` (digiKam only: `PickLabel=2`, `pick=0`, no `good`), `picked`, `rejected`, written to `digiKam:PickLabel` (0 none, 1 rejected, 2 pending, 3 picked), `xmpDM:pick` (−1, 0, 1), `xmpDM:good` (True / False, removed without flag). The first source of the pick read order decides the buttons offered (digiKam: none / pending / picked / rejected; `xmpDM:*`: none / picked / rejected), shown as a white / yellow / green / red flag.
- Keywords: active paths replace `dc:subject`, `digiKam:TagsList`, `lr:hierarchicalSubject`, `mediapro:CatalogSets`, `MicrosoftPhoto:LastKeywordXMP`, `acdsee:categories` (XML tree as text, `Assigned="1"` = active) and IPTC 2:25 of JPEGs. XPKeywords is read and written on JPEG (names containing `;` left out). Reading: embedded XMP before sidecar, default hierarchy order digiKam > Lightroom > Media Pro > Microsoft > ACDSee; the flat fields never change the tree.

### ExifTool (`exiftool.rs`)
- **Settings** (`set_metadata_writer`: custom `exiftoolPath`): Rust static, resent by `initMetadataSettings` at startup. Changing the path clears the detected launcher and calls `shutdown`.
- **Detection** (`detect`, `probe` = `exiftool -ver`): the custom path alone if set (no silent fallback), else the bundled copy (`exiftool.exe` on Windows, `perl exiftool` elsewhere), else `PATH` (also checks Homebrew paths on macOS). `probe` parses the version (`parse_version`) and requires at least `12.00` (`MIN_VERSION`, where HEIC/XMP/UTF-8 support is mature), refusing older custom/system binaries with an explicit version message. The result is cached until a setting change or `get_exiftool_status`, which re-detects (the Settings tab calls it on opening).
- **Pool** (`acquire` / `release`): persistent `-stay_open` processes, at most `MAX_PROCESSES` = 3 (same as the 3 write threads of `keywords::run_write`), a caller waits on a condvar when all are busy. `watch_idle` stops processes unused for `IDLE_TIMEOUT` (45 s); `COMMAND_TIMEOUT` (120 s) kills a stuck process and counts a failure; a failed or outdated-generation process is not reused. `exiftool_prewarm` starts one process when the user edits a first keyword. `shutdown` runs at window close (`RunEvent::ExitRequested` in `main.rs`, with `CLOSING` flag and a bounded drain of active writes); on Windows a Job object (`bind_to_app_lifetime`) kills ExifTool if the app dies without it.
- **A write** (`run`): refuses values containing a newline; success only if ExifTool prints "1 files updated / unchanged / created"; `Error` lines on stderr = failure; `Warning` lines are logged only. `overwrite` always adds `-overwrite_original`; on failure `recover_after_failure` pushes a `Recovery` (see `../invariants.md` §1.3); `take_write_recoveries` (main.rs) writes the log file to `<data dir>/logs/` and the frontend shows it.
- **Targets** (`target_of`): JPEG and HEIC in the file; all else in the sidecar, created through a unique temp name then renamed (`write_to`), or seeded from a shared `photo.xmp` (`seed`, without recording a false `Recovery`).

### Frontend write circuit (`metadata-writes.js`)
1. Each right-panel tab calls `registerEditor({ isDirty, pendingItems, afterWrite, discard, keepOnlyTargets?, … })`; edits stay pending until Apply, Ctrl+Enter, selection/view change (confirmation via `resolvePendingSelection`, guarded before `selectFolder`, `toggleFolderInSelection`, `selectAlbum`, `recursive-folder-toggle` and `showPhotoInItsFolder`, or automatic with `keywordsAutoApply`) or app close. The faces editor has `scope: 'library'` (pending across the whole library: no question on selection change, written only on explicit request or at close).
2. `applyPending` merges all editors' items per photo (`photo_id`), runs `resolveFaceKeywordConflicts` (`face_keyword_conflicts`; the user keeps the keyword or turns the face to unknown), then `runWrite` (capturing `sourceSnapshot`) → `runLocked('apply_metadata_changes', { items }, count, finish)`.
3. `runLocked`: `count >= QUEUE_THRESHOLD` (20) goes through `host.enqueueKeywordTask` (cancellable task); below, a direct `invoke`. Either way a counter (`directWrites` / `queuedWrites`) locks the UI (`isWriteLocked`, `onLockChange`), and `reportWriteRecoveries` is awaited (calls serialized, one blocking dialog each) before `finish`.
4. `finishWrite` updates the UI from the result (`afterWrite` of each editor) and lists failed files (`showFailureDialog` → `failureListDialog`, scrollable with pagination above 50 items). "Show failed files" keeps pending edits (`keepOnlyTargets`) and restores `sourceSnapshot` / loads via `get_photos_by_paths` if needed; "Discard changes" explicitly drops failed photos' pending edits; "Close" leaves them pending. When a JPEG/HEIC write/erasure is masked by an untouched `.xmp` sidecar (`exif::detect_sidecar_conflict`, `sidecar_conflict` on `KeywordFailure`, `GeoFailure`, `MarkingFailure`), the dialog explains why and offers "Show sidecar" (`reveal_in_file_manager`).

Marking (rating / colour / pick) does not use this circuit: it goes through `update_photos_marking` (see `photo-operations.md`, `../architecture.md` flow 3), which verifies with `read_marking` + `marking_mismatch`.

`marking-settings.js` only toggles `colorLabelEnabled` (default true) and `pickLabelEnabled` (default false) and sets the body classes `no-color-labels` / `no-pick-labels`; values stay read and stored when disabled.

## Contracts
- IPC: `set_metadata_writer`, `get_exiftool_status`, `exiftool_prewarm` (exiftool.rs); `set_metadata_read_order` (keywords.rs); `get_photo_details` (→ `read_metadata_details`, the "all metadata" view: EXIF, XMP properties, IPTC, active `sidecar` filename when present, values capped at 1000 chars); `get_photo_sidecar` (main.rs, Info tab sidecar row); `take_write_recoveries`, `update_photos_marking` (main.rs); `apply_metadata_changes` (keywords.rs, see `keywords.md`). Signatures: `../generated/ipc-commands.md`.
- Events: none.
- Database: none directly (callers store what `read_exif` returns).
- Settings: `exiftoolPath`, `metadataOrderKind`, `<kind>FormatOrder` keys, `keywordsAutoApply`, `keywordsAutoApplyAsked`, `colorLabelEnabled`, `pickLabelEnabled` (`../generated/config.md`).

## Dependencies
- Uses: `heif.rs` (HEIC XMP), `thumbnails::read_exif_sources`, `orientation.rs`, `faces` (region types, `reading_enabled`), `video` (`is_video_path`), `library_sync::is_photo_file`.
- Used by: `library_sync` (read), `keywords::run_write`, `main.rs` marking / rotation, `geolocation`, `faces`, `orientation` (`write_xmp_orientation`, ExifTool rotation args).

## Invariants and sensitive areas
- ⚠ sensitive: any new written field must be added to `exiftool::metadata_args` and to the read-back checks, or writes fail with a mismatch (`../recipes.md`).
- ⚠ sensitive: `sidecar_target` / `read_sidecar` / `sidecar_candidates` are the only place sidecar names are built; reading and writing must stay in step (`../invariants.md` §2.2).
- ⚠ sensitive: read priorities are process-wide statics; a test touching them must be the only one (AGENTS.md §5.H).
- Marking writes verify only the sources the file can hold: a RAW whose EXIF rating comes first in the order is not checked on that source (doc of `read_marking`).
- Every write (`update_photos_marking`, `rotate_photos`, `apply_metadata_changes`, geolocation erase / restore) records `photos.effective_modified` (later of the image's and its active sidecar's mtime) and returns it to the interface (`dates` of `MarkingResult`, `RotatedPhoto`, `KeywordWritten`, `GeoPhoto`: field `effective_modified`). `photos.modified` is still only the image's mtime, so a sidecar write never makes `sync_library` re-read the photo (`library-and-database.md`). A removal on an image without sidecar writes nothing, and the recorded date is unchanged.

## Tests
`tests/exif.rs` (fast tests: reading, sidecars including case-insensitive matching, markings, IPTC cuts, regions) and `tests/exiftool.rs` (`cargo test exiftool:: -- --ignored --test-threads=1`; version parser/minimum, recovery, lock and escaping tests are fast). Lists: `../generated/tests.md`. Gap: no test of the frontend circuit (AGENTS.md §5.H), nor of `order-list.js`.

## How to extend
1. New written field: add it in `MetadataUpdate` / `XmpEdit` and in `exiftool::metadata_args`, then verify it in `keywords::run_write` read-back and add tests in `tests/exif.rs` / `tests/exiftool.rs` (`../recipes.md`).
2. New readable source for an existing field: add its id to the `*_SOURCE_IDS` array (extend the `[usize; N]` statics), fill the slot in `read_exif` / `parse_xmp`, add the row to `READ_ORDERS` in `metadata-settings.js` and locale keys in `en.json` / `fr.json`.
3. New editor tab: `registerEditor` with `pendingItems` returning items for `apply_metadata_changes`.

## Open questions
none (HEIC: written in the container, AGENTS.md §5.C now says so; `read_marking` and `read_exif` read the same HEIC XMP).
