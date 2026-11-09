<!-- verified: a9ca28f | sources: src-tauri/src/geolocation.rs, src-tauri/src/place_search.rs, src/map-view.js, src/map-mode.js, src/map-config.js, src/map-tile-protocol.js, src/maps-settings.js, src/location-panel.js, src/geo-tools.js, src/place-search.js -->
# Maps, map mode, location panel, geolocation editing, place search

## Purpose
Shows where photos were taken (small map in the Info panel, full map mode), lets the user assign a position to photos, erase or restore GPS data, and search a place by name. The map is optional and off by default; the app works fully without it. Private zones and offline map files are in `private-zones.md`.

## Files
| File | Role |
|---|---|
| `map-config.js` | Provider (OpenFreeMap) URLs, styles per theme, zoom limits, `MAP_MAX_POINTS` (500), **`isMapNetworkAllowed()`**, offline placeholder constants. |
| `map-tile-protocol.js` | The `pbmap://` protocol: every style / tile / sprite / glyph request of MapLibre goes through it; the **only code allowed to fetch the provider**. |
| `map-view.js` | Reusable MapLibre map (`createMapView`, `loadMapLibrary`, `reloadAllMaps`), WebGL check, one instance per container. |
| `location-panel.js` | Info panel group "Location": GPS of the selection (read from the database, click copies), small map, padlock for private places. |
| `map-mode.js` | Map mode (toolbar button): map beside / instead of the preview, photo points, grid filter by visible zone, pending positions. |
| `geo-tools.js` | Context-menu actions `eraseGeolocation` / `restoreGeolocation`. |
| `place-search.js`, `place_search.rs` | Place search box of the map mode, `search_places` (Nominatim). |
| `maps-settings.js` | Settings > Maps: map style refresh, `openSettingsTab` links. |
| `geolocation.rs` | Erase / restore GPS (`erase_geolocation`, `restore_geolocation`, `get_erased_location_ids`), table `erased_locations`, `gps_mismatch`. |

## How it works

**1. Network rule for tiles.** MapLibre never contacts the network itself: `transformRequest` in `map-view.js` redirects every foreign URL to an empty local one. All requests are `pbmap://<contextId>/(style|tiles|sprite|fonts)/…`, handled by `handleRequest`. Per tile (header of map-tile-protocol.js):
1. tile touches a private zone → read from disk by the backend (`get_private_tile`); missing → empty tile, **never a remote fallback**;
2. tile touches only offline (non-private) areas and one has it → disk;
3. map in *strict* mode (it shows a private place) → empty tile;
4. provider allowed (`isMapNetworkAllowed()`: setting `showMap` on **and** `offlineMode` off) → fetched from `tiles.openfreemap.org`;
5. otherwise → empty tile (a watermark placeholder tile, `OFFLINE_PLACEHOLDER`, when offline).
Style, sprite and fonts (`loadStyle`, `loadSprite`, `loadGlyphs`): local first through `get_private_resource` (the copy downloaded with a zone, else the style bundled in the installer, resource `map-style/`), then the provider by rules 3–5, else an empty style / sprite / glyph range. Only the vector source `openmaptiles` of the style is kept. Each map has a context; `setStrict(true)` aborts its in-flight remote requests. The provider host is also in the CSP `connect-src` of `tauri.conf.json` (prod and dev) and in `private_maps.rs`. ⚠ sensitive: a new map resource or host must go through this protocol, the CSP, and `isMapNetworkAllowed()`; mention it in the "Offline mode" tooltip (AGENTS.md §1).

**2. Location panel.** `refreshLocation(selection, focus)` reads `gps_lat` / `gps_lon` of the selection from loaded photos (never edited here). The map loads only if `showMap` is on: ordinary place → also needs offline mode off; place inside a private zone (`locatePrivatePoints`, private-zones.js) → strict map, disk tiles only (works offline). `onMapAccessChanged` reacts to settings changes. At most `MAP_MAX_POINTS` markers; the panel's map is disabled while map mode is open (`setMapSuppressed`: one WebGL context).

**3. Map mode.** `openMapMode` / `initMapMode` / `refreshMapMode`: points for all geolocated photos of the grid, selection highlighted. Grid filter "Visible area only": `getVisibleZone`, `passesMapFilter`, `mapPrefilter` (used by `main.js` filters). Assigning a position: Shift + drag the selection onto the map (`dragOverMap` / `dropOnMap`, called by main.js) or right-click > "Place the selection here". Positions stay **pending** (`pending`, `hasPendingPosition`) until "Write to files", written through the normal circuit: `apply_metadata_changes` with `gps` items (`KeywordWriteItem.gps` in `keywords.rs`, then re-read and `gps_mismatch`, database updated in the same transaction). Like pending faces they concern the whole library: asked on app close and on leaving the mode (`requestCloseMapMode`), never silently lost.

**4. Erase / restore** (`geolocation.rs`, queued from `geo-tools.js` with `runLocked`):
1. `erase_refusal`: a photo whose GPS is in EXIF is refused when that EXIF cannot be modified (`gps_in_exif_internal_writer`, `gps_in_exif_sidecar_format`: RAW, PNG, WebP…), because it would stay geolocated.
2. Erase: coordinates saved in `erased_locations`, then removed from the file (`write_one`: `keep_cached_images` → `exif::write_metadata`, re-read, database updated from the re-read). Restore: saved coordinates rewritten by the active writer.
3. The backup disappears by itself: SQLite triggers `erased_locations_relocated` (photo gets coordinates again, including by a rescan) and `erased_locations_removed` (photo deleted).
Result `GeoWriteResult` = `updated`, `refused`, `failed`, `cancelled`.

**5. Place search.** The box is shown only when offline mode is off; search starts on Enter, never while typing (provider policy: one request per second, own User-Agent). `search_places` (backend only, never the webview): `internet_disabled` if offline, Nominatim `SEARCH_URL`, 6 results max, response capped at 1 MB, invalid coordinates dropped (`exif::valid_gps`).

## Contracts
- IPC commands: `erase_geolocation`, `restore_geolocation`, `get_erased_location_ids`, `search_places`, plus `get_private_tile`, `get_private_resource` (see `private-zones.md`) and `apply_metadata_changes` for positions (`generated/ipc-commands.md`).
- Events: `scan-progress` for erase / restore tasks.
- Database: `erased_locations`; `photos.gps_lat`, `gps_lon` (`generated/db-schema.md`).
- Settings: `showMap`, `showInfoMapWidget`, `mapDefaultZoom` (7–14, default 12), `mapStyleRefresh`, `offlineMode`; see `generated/config.md`. Error code: `internet_disabled`.

## Dependencies
- Uses: MapLibre GL (bundled, worker file via Vite `?url`), `private-zones.js`, `metadata-writes.js` (`runLocked`, apply circuit), `keywords.rs` (`run_write`), `exiftool.rs` (`writes_in_file`), `face_models::internet_allowed`.
- Used by: `main.js` (drag and drop onto the map, filters, close confirmation), `private-zones-modal.js` (`createMapView`).

## Invariants and sensitive areas
- ⚠ sensitive: rule 1 of the tile protocol (private tiles never fall back to the provider) protects the user's private places; a leak would send their locations to a third party. See `private-zones.md`.
- ⚠ sensitive: the provider host appears in three places (`map-config.js`, CSP, `private_maps.rs`); keep them in sync.
- Positions are never written without "Write to files"; GPS erase is the only direct write of GPS (menu action).
- Max zoom: provider tiles stop at level 14; the map over-zooms up to 4 levels (`mapMaxZoom`), imported files may reach 15.
- A failed write or a mismatching re-read is never shown as success (`gps_mismatch`, tolerance 1e-5° ≈ 1 m).

## Tests
`tests/geolocation.rs` (backup follows the photo through triggers, refusal rules, read-back check), `tests/place_search.rs` (URL encoding, parsing). Not tested: the tile protocol, map view and map mode (frontend).

## How to extend
1. Change the provider: edit `map-config.js` URLs and styles, the CSP in `tauri.conf.json` (both configs), the host check in `private_maps.rs`, then the attribution constant.
2. New map overlay: add it in `map-mode.js` as a MapLibre layer fed by loaded photos; no network.
3. New GPS write path: reuse `apply_metadata_changes` with `gps` items so the re-read check and the database update apply; mark it pending as in map mode.

## Open questions
none. "Write to files" (`writeNow` in `map-mode.js`): if some photos already had a position, a dialog asks to replace them; then the pending items go through `writeMetadataItems` (the normal circuit). `afterWrite` removes a pending position only if the re-read coordinates match it (`SAME_PLACE`); a failure keeps it pending. Leaving the mode with pending positions asks Write / Discard / Cancel (`requestCloseMapMode`); after a write with failures the mode stays open. Pending positions follow moved photos (`photosMoved`) and disappear with removed ones (`photosRemoved`).
