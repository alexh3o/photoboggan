<!-- verified: none | sources: src/main.js, index.html -->
# Main window: photo loading, folder tree, task queue, settings modal, startup (main.js, part 1)

> Status: **not written** (skeleton). Follow `../_TEMPLATE.md` (rules + sections). Max 150 lines.

## Purpose

## Files

## How it works

Entry points and main flow (phase 2 notes, to be replaced by the real section):

- Scope: the `main.js` sections "CHARGEMENT PHOTOS & DOSSIERS", "ALBUMS INTELLIGENTS…", "ARBORESCENCE & FILTRES", "FILE D'ATTENTE DES TÂCHES", "MODALE PARAMÈTRES" (+ About, Guide), "BOUTONS VUES & SIDEBAR", sidebar resizing, date / location / content-analysis filters, the two sync sections, "DEMARRAGE", "EMPLACEMENT DES DONNÉES…". The grid and viewer sections are in `grid-and-viewer.md`.
- Loading: `loadFolders`, `loadPhotos` → `readDisplayedFolderPhotos` / `queryFolderPhotos` (`get_photos_paginated`), SQL prefilter for large folders (`prefilterFromState`, `buildSqlPrefilter`, `schedulePrefilterReload`), then `applyPhotoFilters` (all JS filters, see `filters-and-search.md`).
- Folder tree: `renderFolderTree`, `selectFolder`, `toggleFolderInSelection`, counts `scheduleFolderCounts` (`get_folder_counts`), disk folders `refreshDiskFolders`.
- Task queue: `enqueueScanTask` (refusal rules `familyOf`, `taskCoversFolder`, `dedupeKey`), `pumpScanQueue` (one task at a time), `pumpSemanticQueue` (own lane), `runScanTask`, `pauseTask` / `resumeTask` / `restorePausedTasks`, UI `syncTaskUI`, progress `listenToBackend('scan-progress')`, close guard `confirmCloseWithRunningTasks`. Other modules get it injected as `enqueueTask`.
- Sync and startup: `syncLibraryWithDisk` / `requestLibrarySync`, `checkPhotoMissing` → `flushMissingChecks`; startup `restorePanelsVisibility`, `restoreStartupFolder`, `sendInternetAllowed`, `sendVerifyMoves`; window shown after two animation frames (`DOMContentLoaded` handler at the top).
- Trap: module-level state (`loadedPhotos`, `folderTreePhotos`, `scanTasks`…) is shared with the grid sections; read `code-map.md` "Inside the large files" first. 150-line limit: describe the flows and link the queue rules in `invariants.md` §6.

## Contracts

## Dependencies

## Invariants and sensitive areas

## Tests

## How to extend

## Open questions
