// "Find the RAW" results mode: scope matching, banner rendering, and view snapshot entry/exit.
// `main.js` wires host state and callbacks via `initFindRawMode()`.
import { invoke } from '@tauri-apps/api/core';
import { t, tp, onLanguageChange } from './i18n.js';
import { getRawSearchSettings, hasRawSearchCriteria } from './raw-settings.js';
import { folderOf, searchScope, buildRawSearchState, rawNameMatches } from './find-raw.js';
import { photoTimeKey } from './date-filter.js';
import { getSelectedAlbum, clearAlbumSelection, isSelectedAlbumDirty, confirmLeaveAlbum } from './albums-panel.js';

let host = {};
let initialized = false;

// ==========================================
// FIND THE RAW
// ==========================================
// Right-click on a raster image > "Find the RAW": the criteria ticked in Settings > Search > RAW search (raw-settings.js) become ordinary
// sidebar filters (name, date, gear, shooting values, plus "RAW only"), the grid opens on the chosen start folder with all its subfolders,
// and a banner offers to return to the previous view (snapshot: folder or album, filters, subfolder option, scroll, selection).
// Navigating by hand (folder, album, subfolder option) ends the mode without returning.
let rawSearch = null;

export const isRawSearchActive = () => rawSearch !== null;
export const getRawSearch = () => rawSearch;

// What filters cannot express: "Subfolders" (photos in the image's own folder do not count, while the start folder contains them)
// and loose name matching (see rawNameMatches).
export function matchesRawSearchScope(photo) {
  if (!rawSearch) return true;
  if (rawSearch.excludeDir && host.normalizeFilterPath(folderOf(photo.path)) === rawSearch.excludeDir) return false;
  return rawNameMatches(photo, rawSearch.nameStem);
}

export function renderRawSearchBanner() {
  // Elements read at each call: the function can run before this section of the module has been executed.
  const banner = document.getElementById('raw-search-banner');
  if (!banner) return;
  banner.hidden = !rawSearch;
  if (!rawSearch) return;
  const text = document.getElementById('raw-search-text');
  text.textContent = tp('RAW of {name}: {count} result', host.getPhotos().length, { name: rawSearch.name });
  text.title = rawSearch.nameStem ? t('Names compared in both directions: {name}', { name: rawSearch.nameStem }) : '';
}

// Ends the mode without reopening the previous view: restores the subfolder option and the filters from before the search
// (except smart-album filters, which returning to the album reloads by itself). The caller handles the folder or album shown next.
export function abandonRawSearch() {
  if (!rawSearch) return;
  const { snapshot } = rawSearch;
  rawSearch = null;
  host.setIncludeSubfoldersTemporarily(snapshot.includeSubfolders);
  host.resetAllFilters();
  if (snapshot.albumKind !== 'smart') host.applyFilterState(snapshot.filterState);
  renderRawSearchBanner();
}

// "Back to previous view" button and Escape.
export async function exitRawSearch() {
  if (!rawSearch) return;
  const { snapshot } = rawSearch;
  abandonRawSearch();
  await host.restoreViewSnapshot(snapshot);
}

const RAW_CRITERION_LABELS = { name: 'Filename', date: 'Date', gear: 'Gear', shooting: 'Shooting' };

export async function findRawFor(photo) {
  if (!photo) return;
  if (!hasRawSearchCriteria()) {
    host.showToast(t('Tick at least one criterion in Settings > Search > RAW search'));
    return;
  }
  const settings = getRawSearchSettings();
  const name = photo.path.split(/[\\/]/).pop();
  const { state, nameStem, used, missing } = buildRawSearchState(photo, settings, photoTimeKey(photo));
  if (used.length === 0) {
    host.showToast(t('This image has none of the data needed to find its RAW'));
    return;
  }
  // Same guard as a folder change: an edited smart album is left only after Save / Discard / Cancel.
  if (isSelectedAlbumDirty() && !(await confirmLeaveAlbum())) return;

  // Check before leaving the view: if no RAW is found, stay where we are (same criteria as the filters, see matchesFilterState).
  const { folder, excludeDir } = searchScope(photo.path, settings.scope);
  const excluded = excludeDir ? host.normalizeFilterPath(excludeDir) : null;
  const candidates = await invoke('get_photos_paginated', { offset: 0, limit: 50000, folderFilter: folder, recursive: true });
  const found = candidates.filter(candidate => host.matchesFilterState(candidate, state)
    && (!excluded || host.normalizeFilterPath(folderOf(candidate.path)) !== excluded)
    && rawNameMatches(candidate, nameStem));
  if (found.length === 0) {
    host.showToast(t('No RAW found for {name}', { name }));
    return;
  }

  if (host.isFullscreen()) host.closeFullscreen();
  const album = getSelectedAlbum();
  const snapshot = rawSearch?.snapshot ?? host.getDuplicateSearch()?.snapshot ?? host.getSemanticSearch()?.snapshot ?? host.captureViewSnapshot(album);
  host.abandonDuplicateSearch(); // a duplicate search in progress ends here; the view saved above is the one to go back to
  host.abandonSemanticSearch(); // same for a content search
  clearAlbumSelection();
  host.syncSmartAlbumWithSelection();
  host.resetAllFilters();
  host.applyFilterState(state);
  host.setIncludeSubfoldersTemporarily(true);
  host.setFolderFilter(folder);
  host.resetPage();
  rawSearch = { name, excludeDir: excluded, nameStem, snapshot };
  host.renderFolderTree();
  await host.loadPhotos();
  if (missing.length) {
    host.showToast(t('Not used (no data in this image): {list}', { list: missing.map(key => t(RAW_CRITERION_LABELS[key])).join(', ') }));
  }
}

// ==========================================
// INITIALIZATION
// ==========================================

// Wires Find-RAW banner controls and host dependencies.
export function initFindRawMode(deps) {
  if (initialized) return;
  host = deps;
  initialized = true;

  document.getElementById('raw-search-back')?.addEventListener('click', () => exitRawSearch());
  onLanguageChange(() => renderRawSearchBanner());
}
