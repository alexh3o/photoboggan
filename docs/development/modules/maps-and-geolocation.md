<!-- verified: none | sources: src-tauri/src/geolocation.rs, src-tauri/src/place_search.rs, src/map-view.js, src/map-mode.js, src/map-config.js, src/map-tile-protocol.js, src/maps-settings.js, src/location-panel.js, src/geo-tools.js, src/place-search.js -->
# Maps, map mode, location panel, geolocation editing, place search

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Map rendering: `createMapView`, `loadMapLibrary`, `reloadAllMaps` (map-view.js, MapLibre bundled); every resource goes through `pbmap://` (`registerMapProtocol`, `createTileContext` in map-tile-protocol.js): rules 1–5 in that file's header decide disk / provider / empty tile.
- Network: only `map-tile-protocol.js` contacts `tiles.openfreemap.org`, gated by `isMapNetworkAllowed()` (map-config.js: `showMap` and not `offlineMode`); this is the one network access made by the webview (see `architecture.md`).
- Panel and mode: `initLocationPanel` / `refreshLocation` (right panel), `initMapMode` (full map mode, filter `passesMapFilter` / `mapPrefilter`, drag-and-drop of photos to set a position), `initMapsSettings`.
- Writing positions: map mode sends `gps` items through `apply_metadata_changes` (keywords.rs, `KeywordWriteItem.gps`); erase / restore: `erase_geolocation` / `restore_geolocation` / `get_erased_location_ids` (geolocation.rs, backup table), frontend `geo-tools.js`.
- Place search: `search_places` (place_search.rs, refused offline) ↔ `initPlaceSearch` (place-search.js).
- Private zones and offline maps are in `private-zones.md`.

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
