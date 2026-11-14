<!-- verified: 03c1da6 | sources: src-tauri/src/private_maps.rs, src/private-zones.js, src/private-zones-modal.js, src/zone-drawing.js -->
# Private zones and offline maps

## Purpose
A *zone* is a place (circle, polygon, or the real shape of an imported file) whose map tiles are stored on disk. A **private** zone (the default) protects sensitive places such as a home: photos located inside it are shown only on a map that never contacts the tile provider, even online. A non-private zone is just an offline map: tiles come from disk when present and may be completed from the provider.

## Files
| File | Role |
|---|---|
| `private_maps.rs` | Geometry (`ZoneGeometry`, `ZoneShape`), table `private_zones`, MBTiles files, per-tile rule (`private_tile`), download task, import, style resources, `locate_private_points`. |
| `private-zones.js` | Zones list and cache on the UI side (`getZones`, `onZonesChange`), `locatePrivatePoints`, detail levels, display geometry. |
| `private-zones-modal.js` | Window "Private zones and offline maps": list, detail with local preview, creation (drawing, name, detail, estimate), import. |
| `zone-drawing.js` | Drawing a circle or polygon on a MapLibre map. |

## How it works

**Storage.** Zone definitions are rows of `private_zones` in the catalogue (name, JSON `geometry`, `max_zoom`, `source` = `download` / `import`, `tile_count`, `missing_count`, `size_bytes`, `updated_at`, `status` = `pending` / `ready` / `incomplete` / `failed`, `private`). The tiles of each zone live in a separate **MBTiles file** (a standard SQLite database, not the catalogue pool) in `<data dir>/private_maps/<slug>.mbtiles`; the file name is derived from the zone name (`zone_file_name`: lowercase, spaces → `_`, forbidden characters removed, Windows reserved names refused; same rule as `zoneFileName` in JS; two zones cannot share a file name, `check_unique_name`). Style, sprites and fonts copied from the provider are in `private_maps/style/`; the bundled style (`src-tauri/resources/map-style/`, `init_bundled_style`) is the fallback.

**Per-tile privacy rule** (`private_tile_in`, answered by `get_private_tile` as a first byte + tile bytes):
1. no zone touches the tile → `0`: the UI may ask the provider (its own rules, see `maps-and-geolocation.md`);
2. a **private** zone touches it → `1` + tile read from any zone file that has it (empty if none): **never** the provider;
3. only non-private zones touch it → `2` + tile if a file has it; `3` if absent (UI may fetch it).
A request outside `z ≤ 22` / valid range gets `1` (empty). Zones are loaded in memory (`ZONES`, `reload_zones` after every change); open file connections are cached (`TILE_FILES`) and closed before a file is replaced or deleted (`close_tile_file`) and before the data folder is moved (`close_all_tile_files`).

**Private place.** `locate_private_points(points)` returns, per `[lat, lon]`, `None` outside private zones, else the finest `max_zoom` available there (`private_zoom_in`). The UI (`location-panel.js`, `map-mode.js`) then uses a **strict** map (no remote request) capped at that zoom; the padlock in the Location group opens this window.

**Create / download.**
1. `estimate_private_zone(geometry, max_zoom)` (tile count and size estimate), detail levels `DETAIL_ZOOMS` = 12 / 13 / 14 (City, Neighbourhood, Streets).
2. `add_private_zone` stores the row (`pending`); `download_private_zone` is queued as a task (progress `scan-progress`, cancel via `cancel_scan`).
3. Task: `internet_disabled` if offline; `imported_zone` if the zone was imported; `zone_too_large` if more than `MAX_TILES` (3000) tiles; optional style download (`refresh_style`, setting `mapStyleRefresh`); tile URL template from the provider TileJSON (versioned, renewed weekly); 4 parallel requests (`PARALLEL_REQUESTS`), own User-Agent; stops past `MAX_BYTES` (50 MB). Tiles are written to `zone_<id>.part`; only when finished is it renamed over the zone file, so a stop or failure leaves the previous file intact. Status `ready`, or `incomplete` (missing tiles or size cap: the map stays empty there); a never-downloaded zone that fails becomes `failed`.
4. The mode can change while downloading: `internet_allowed()` is checked before each request.

**Import.** `import_private_zone(path, name, geometry?)`: validates an MBTiles file (`inspect_mbtiles`: vector tiles only, max zoom up to 15), derives the shape from the tiles present (`mbtiles_footprint`) or the bounds rectangle, copies it to the zones folder through a `.part` file (row removed if the copy fails). `recompute_private_zone_shape` rebuilds the shape. No network.

**Other commands.** `list_private_zones`, `rename_private_zone` (renames the file too), `delete_private_zone`, `set_private_zone_privacy` (toggle `private`), `get_private_resource` (style files, path components checked by `safe_component`), `has_downloaded_map_style`, `reset_map_style`. `migrate_legacy_files` renames old `zone_<id>.mbtiles` files at startup.

## Contracts
- IPC commands: those above (`generated/ipc-commands.md`, search `private_maps.rs`).
- Events: `scan-progress` (download).
- Database: `private_zones` (`generated/db-schema.md`). Not rebuildable from photos (see `architecture.md`, "Where state lives"). Files: `<data dir>/private_maps/`.
- Settings: `mapStyleRefresh`, `showMap`, `offlineMode`; error codes `internet_disabled`, `zone_too_large`, `imported_zone`, `invalid_zone_name`, `mbtiles_without_bounds`.

## Dependencies
- Uses: `face_models::internet_allowed`, the catalogue pool (rows only), `ureq`, `rusqlite` (MBTiles), `main.rs` (startup migration, data folder move).
- Used by: `map-tile-protocol.js` (`get_private_tile`, `get_private_resource`), `location-panel.js`, `map-mode.js`, `map-view.js` (strict mode), `maps-settings.js`.

## Invariants and sensitive areas
- ⚠ sensitive: **a private zone never causes a provider request** for any tile it touches (rule 2). Test: `tile_rule_serves_private_tiles_from_disk_and_never_falls_back`. Also checked on the frontend (`map-tile-protocol.js` rule 1) and by strict mode.
- ⚠ sensitive: provider limits (3000 tiles / 50 MB per download, 4 parallel requests, identifying User-Agent) follow OpenFreeMap's offline-use rules; do not raise them. The same limits appear in `private-zones.js` (`MAX_ZONE_TILES`, `MAX_ZONE_BYTES`).
- A file is replaced only after a complete download (`.part` + rename); the open connection is closed first.
- `private_zones` rows are not rebuildable: "Change storage location" moves `private_maps/` with the catalogue (`STORAGE_DIRS`); a lost catalogue loses the zone definitions (the MBTiles files remain).
- The protection geometry is computed by the backend; the JS geometry is display-only.
- Overlapping zones: the finest available zoom wins (test `overlapping_zones_give_the_finest_available_zoom`).

## Tests
`tests/private_maps.rs` (18 tests: geometry validation, point in zone, covering tiles, TMS rows, import validation, tile rule, offline refusal without any request, file naming, legacy rename, overlapping zones, style fallback, imported shapes). Gap: the download itself and the frontend window.

## How to extend
1. New detail level: `DETAIL_ZOOMS` (Rust) and `DETAIL_LEVELS` (JS) together, with locale keys.
2. New zone shape: variant of `ZoneGeometry`, `ZoneShape` support (`contains_location`, `intersects_tile`, `covering_tiles`), drawing in `zone-drawing.js`.
3. New provider: see `maps-and-geolocation.md` how to extend; here change `PROVIDER`, `TILEJSON_URL`, `STYLES`.

## Open questions
none. Zones are first loaded by `db::init_db` (`reload_zones` after the schema is created), then after every zone change.
