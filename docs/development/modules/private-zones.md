<!-- verified: none | sources: src-tauri/src/private_maps.rs, src/private-zones.js, src/private-zones-modal.js, src/zone-drawing.js -->
# Private zones and offline maps

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Rule (header of private_maps.rs and of map-tile-protocol.js): any tile touching a private zone is read from disk only (`get_private_tile` → `private_tile`), missing = empty tile, never fetched remotely.
- Zones: table `private_zones` (`init_schema`, `reload_zones` keeps them in memory), one MBTiles file per zone in `<data dir>/private_maps/` (`create_mbtiles`, `read_tile`, `zone_file_name`), legacy files `migrate_legacy_files` at startup.
- Commands: `list_private_zones`, `estimate_private_zone` (`MAX_TILES` 3000, `MAX_BYTES` 50 MB, `DETAIL_ZOOMS`), `add_private_zone`, `download_private_zone` (queued `kind: 'private-map'`, refused offline, file replaced only when complete), `rename_private_zone`, `delete_private_zone`, `import_private_zone`, `recompute_private_zone_shape`, `set_private_zone_privacy`, `get_private_resource`, style `has_downloaded_map_style` / `reset_map_style` / `init_bundled_style`, `locate_private_points`.
- Frontend: `private-zones.js` (zone cache `getZones`, geometry helpers), `initPrivateZonesModal` / `openPrivateZonesModal` (list, download, import), `startZoneDrawing` (circle / polygon).
- Trap: MBTiles files are separate SQLite databases opened directly (not the catalogue pool); OpenFreeMap offline-use limits are part of the contract.

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
