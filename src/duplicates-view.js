// Duplicate search results mode: group indexing, banner rendering, group sorting, "Best copy" ranking,
// cleanup selection, task execution, and view snapshot entry/exit. `main.js` wires host state and callbacks via `initDuplicatesView()`.
import { invoke } from '@tauri-apps/api/core';
import { t, tp } from './i18n.js';
import { RAW_EXTENSIONS } from './format-filters.js';
import { compileNamePattern } from './raw-settings.js';
import { findNameGroups } from './duplicate-names.js';
import {
  GROUP_SORT_MODES, GROUP_SORT_LABELS, normalizeGroupSort, formatBytes, sortGroupMembers, orderGroups,
  firstPathOf, getSimilarSettings, similarRequestFields, getIdenticalSettings, mergeGroups,
  describeSearch, getKeepSettings, describeKeepOrder,
} from './duplicates.js';
import { openDuplicatesModal, toggleKeepPanel, closeKeepPanel } from './duplicates-modal.js';
import { getSelectedAlbum, clearAlbumSelection, isSelectedAlbumDirty, confirmLeaveAlbum } from './albums-panel.js';

let host = {};
let initialized = false;

// ==========================================
// DUPLICATES
// ==========================================
// Right click > "Find duplicates" (a photo, a selection, a folder or "All photos"): the backend (duplicates.rs) searches as a queue task and returns groups
// of paths. They open in the main grid in a results mode like "Find the RAW": a banner brings back the view saved before (snapshot), the filters
// are cleared, a separator heads each group, and the groups are ordered by quantity, total size or path (button of the banner).
// Navigating by hand (folder, album) ends the mode without going back.
const DUPLICATE_SORT_KEY = 'duplicateGroupSort';

let duplicateSearch = null;
const phashListeners = new Set();

export const isDuplicateSearchActive = () => duplicateSearch !== null;
export const getDuplicateSearch = () => duplicateSearch;
export function onPhashChanged(listener) {
  phashListeners.add(listener);
  return () => phashListeners.delete(listener);
}

// File format shown and compared in the duplicate results: the extension in capitals (JPEG and JFIF count as JPG).
export function photoFormat(path) {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return (extension === 'jpeg' || extension === 'jfif' ? 'jpg' : extension).toUpperCase();
}

// Position of each group in the chosen order, and group and rank of each photo (read by the grid sort).
function rankDuplicateGroups() {
  const search = duplicateSearch;
  search.position = new Map(orderGroups(search.groups, search.sortMode).map((group, index) => [group.id, index]));
  search.order = new Map();
  for (const group of search.groups) group.members.forEach((photo, rank) => search.order.set(photo.path, { group: group.id, rank }));
}

// Groups of the mode with the members found in the catalog, ranked. Called after each load of the mode's photos (loadedPhotos is up to date).
export function indexDuplicateGroups() {
  const search = duplicateSearch;
  const byPath = new Map(host.getLoadedPhotos().map(photo => [photo.path, photo]));
  search.groups = [];
  const keep = getKeepSettings(); // read once: the groups are ranked with the same settings
  search.groupPaths.forEach((paths, position) => {
    const members = sortGroupMembers(paths.map(path => byPath.get(path)).filter(Boolean), keep);
    if (members.length < 2) return; // photos removed since the search leave nothing to compare
    search.groups.push({
      id: search.groups.length,
      members,
      reasons: search.groupReasons?.[position] ?? [],
      bytes: members.reduce((sum, photo) => sum + (photo.file_size || 0), 0),
      firstPath: firstPathOf(members),
    });
  });
  // Best copies, wearing the medal. One per group; with RAW and JPEG searched together, one per format and only for a format that has several copies in
  // the group (a lone JPEG next to its RAW is not "the best" of anything).
  search.best = new Set();
  for (const group of search.groups) {
    if (!search.mixedFormats) { search.best.add(group.members[0].path); continue; }
    const byFormat = new Map();
    for (const photo of group.members) {
      const format = photoFormat(photo.path);
      byFormat.set(format, [...(byFormat.get(format) ?? []), photo]);
    }
    for (const copies of byFormat.values()) if (copies.length > 1) search.best.add(copies[0].path);
  }
  rankDuplicateGroups();
}

// Separators of the grid: one per group, as groups of consecutive photos (the list is already sorted by group). The label gives the group number,
// its image count and total size as displayed (filters can hide members).
export function computeDuplicateSeparators() {
  const photos = host.getPhotos();
  const groups = [];
  let current = null;
  let currentId = null;
  for (let i = 0; i < photos.length; i++) {
    const id = duplicateSearch.order.get(photos[i].path)?.group ?? -1;
    if (current && id === currentId) continue;
    if (current) current.end = i;
    current = { start: i, end: photos.length, id };
    currentId = id;
    groups.push(current);
  }
  for (const group of groups) {
    let bytes = 0;
    for (let i = group.start; i < group.end; i++) bytes += photos[i].file_size || 0;
    const number = (duplicateSearch.position.get(group.id) ?? 0) + 1;
    // With several criteria, the label says which ones found the group.
    const reasons = duplicateSearch.groups[group.id]?.reasons ?? [];
    group.label = [
      t('Group {number}', { number }),
      tp('{count} image', group.end - group.start),
      formatBytes(bytes),
      ...(reasons.length ? [reasons.map(reason => t(DUPLICATE_REASONS[reason])).join(' + ')] : []),
    ].join(' · ');
    group.title = '';
  }
  return groups;
}

export function renderDuplicateBanner() {
  // Elements read at each call: the function can run before this section of the module has been executed.
  const banner = document.getElementById('duplicates-banner');
  if (!banner) return;
  banner.hidden = !duplicateSearch;
  if (!duplicateSearch) return;
  const photos = host.getPhotos();
  const shownGroups = new Set(photos.map(photo => duplicateSearch.order.get(photo.path)?.group)).size;
  const text = document.getElementById('duplicates-text');
  text.textContent = `${t(duplicateSearch.titleKey)} · ${duplicateSearch.label} · ${tp('{count} group', shownGroups)} · ${tp('{count} image', photos.length)}`;
  text.title = [duplicateSearch.note, t('Best copy: {list}', { list: describeKeepOrder(getKeepSettings()) || '—' })].filter(Boolean).join('\n');
  const keepButton = document.getElementById('duplicates-keep');
  keepButton.textContent = t('Best copy…');
  keepButton.title = t('Choose how the best copy of each group is picked');
  const select = document.getElementById('duplicates-select');
  select.textContent = t('Select duplicates');
  select.title = t('Select every copy except the best one of each group, then use Delete to send them to the trash');
  select.hidden = duplicateSearch.mixedFormats; // with RAW and JPEG together a cleanup could remove the only RAW: never offered
  const sort = document.getElementById('duplicates-sort');
  sort.textContent = t(GROUP_SORT_LABELS[duplicateSearch.sortMode]);
  sort.title = t('Sort the groups by number of images, total size or path');
}

// "Best copy…": the order of the criteria changes who wears the medal. The groups are ranked again at once; the selection is emptied, because the
// copies it held are no longer the ones to remove.
function rankDuplicatesAgain() {
  if (!duplicateSearch) return;
  indexDuplicateGroups();
  host.clearFullscreenImageCache(); // the preload cache is indexed by position in the list
  host.applyPhotoFilters({ keepState: true });
  const photos = host.getPhotos();
  const selectedIndices = host.getSelectedIndices();
  selectedIndices.clear();
  if (photos.length > 0) {
    const nextIndex = Math.min(host.getLastSelectedIndex(), photos.length - 1);
    host.setLastSelectedIndex(nextIndex);
    selectedIndices.add(nextIndex);
    host.renderVisibleItems();
    host.updateUIOnSelection();
  }
}

// Cleanup, first step: selects every copy except the best one of each group, among the photos displayed. Nothing is deleted here: the selection is then
// handled like any other (Delete key or context menu, with the usual confirmation and the trash). A group whose best copy is hidden by a filter is left
// alone, so a cleanup can never take away every copy of a picture.
function selectDuplicatesExceptBest() {
  if (!duplicateSearch || duplicateSearch.mixedFormats) return;
  const photos = host.getPhotos();
  const groupsWithBest = new Set();
  for (const photo of photos) {
    const info = duplicateSearch.order.get(photo.path);
    if (info?.rank === 0) groupsWithBest.add(info.group);
  }
  const selectedIndices = host.getSelectedIndices();
  selectedIndices.clear();
  photos.forEach((photo, index) => {
    const info = duplicateSearch.order.get(photo.path);
    if (info && info.rank > 0 && groupsWithBest.has(info.group)) selectedIndices.add(index);
  });
  if (selectedIndices.size === 0) {
    host.showToast(t('No duplicate to select'));
    return;
  }
  const firstIndex = Math.min(...selectedIndices);
  host.setLastSelectedIndex(firstIndex);
  host.scrollToPhotoIndex(firstIndex);
  host.renderVisibleItems();
  host.updateUIOnSelection();
  host.showToast(tp('{count} duplicate selected: the best copy of each group is kept', selectedIndices.size));
}

// Ends the mode without reopening the previous view: puts back the sub-folder option and the filters of before the search (except those of a smart
// album, which going back to the album reloads itself). The caller shows whatever comes next.
export function abandonDuplicateSearch() {
  if (!duplicateSearch) return;
  const { snapshot } = duplicateSearch;
  duplicateSearch = null;
  closeKeepPanel(); // the floating "Best copy" panel belongs to the results
  host.setIncludeSubfoldersTemporarily(snapshot.includeSubfolders);
  host.resetAllFilters();
  if (snapshot.albumKind !== 'smart') host.applyFilterState(snapshot.filterState);
  renderDuplicateBanner();
}

// "Back" button and Escape.
export async function exitDuplicateSearch() {
  if (!duplicateSearch) return;
  const { snapshot } = duplicateSearch;
  abandonDuplicateSearch();
  await host.restoreViewSnapshot(snapshot);
}

// Returns false when the user declined to leave a modified smart album (nothing shown).
async function showDuplicateResults(result, titleKey, label, context) {
  if (isSelectedAlbumDirty() && !(await confirmLeaveAlbum())) return false;
  if (host.isFullscreen()) host.closeFullscreen();
  const album = getSelectedAlbum();
  const snapshot = duplicateSearch?.snapshot ?? host.getOtherSearchSnapshot() ?? host.captureViewSnapshot(album);
  host.abandonOtherSearches(); // their filters and sub-folder option are put back; the snapshot above is the view to return to
  clearAlbumSelection();
  host.syncSmartAlbumWithSelection();
  host.resetAllFilters();
  host.clearFolderFilter();
  // What the search could not do, in the tooltip of the banner.
  const note = [
    context.criteria,
    result.wholeFileExtensions?.length ? t('Metadata could not be ignored for: {list}', { list: result.wholeFileExtensions.join(', ') }) : '',
    result.unsupported > 0 ? tp('{count} photo could not be compared (format not supported)', result.unsupported) : '',
    result.skippedGroups > 0 ? tp('{count} group was left out because it was too large: lower the sensitivity', result.skippedGroups) : '',
  ].filter(Boolean).join('\n');
  duplicateSearch = {
    titleKey, label, snapshot, note, groupPaths: result.groups, groupReasons: result.reasons ?? null, mixedFormats: context.mixedFormats,
    sortMode: normalizeGroupSort(localStorage.getItem(DUPLICATE_SORT_KEY)),
    groups: [], order: new Map(), position: new Map(),
  };
  host.renderFolderTree();
  await host.loadPhotos();
  return true;
}

// "Show" (toast or tasks window): opens the results of a finished search, then the task leaves the list.
export async function showReadyDuplicateResults(task) {
  if (task.status !== 'ready' || task.showing) return;
  task.showing = true; // a double click must not open the results twice
  try {
    if (!(await showDuplicateResults(task.result, task.titleKey, task.resultLabel, task.context))) return;
    host.closeTasksModal();
    host.removeReadyTask(task);
  } finally {
    task.showing = false;
  }
}

// A task ended (onResult of the queue): `stopped` = the user stopped it, `error` = the backend failed. With groups found, the task stays in the list
// ('ready') and its toast announces the results: the view is never changed without the user's click.
async function handleDuplicatesResult(result, stopped, error, titleKey, label, task, context) {
  if (context?.kind === 'similar') {
    for (const listener of phashListeners) listener();
  }
  if (error) {
    host.showToast(t('Duplicate search failed: {error}', { error }));
    return;
  }
  if (!result || result.cancelled || stopped) return; // runScanTask announces the stop
  if (result.groups.length === 0) {
    host.showToast(tp('No duplicates found among {count} photo', result.scanned));
    return;
  }
  // A newer result for the same search replaces the one still waiting.
  host.keepTaskReady(task, { result, groupCount: result.groups.length, titleKey, resultLabel: label, context }, { replaceSameKey: true });
}

// `spec` (built by the menus of photo-actions.js): { scope, label, compareWithLibrary }, with scope = { kind: 'all' } | { kind: 'folder', path, recursive }
// | { kind: 'paths', paths }. `settings` come from the "More…" window, otherwise from the defaults saved there (duplicates.js).

// Hash of the image data and/or file name, as one task. The name search runs here (its pattern is a JavaScript regular expression, the backend only lists
// the photos); the hash search is a backend command stopped through the task's identifier. Groups found by both are joined, each with its reasons.
async function runIdenticalSearch({ scope, compareWithLibrary }, settings, task, setPercent) {
  if (settings.name && compileNamePattern(settings.pattern) === undefined) throw t('Invalid pattern');
  const parts = [];
  let nameReport = null;
  let hashReport = null;
  if (settings.name) {
    const rows = await invoke('list_duplicate_candidates', { scope, compareWithLibrary });
    if (task.stopRequested) return { groups: [], scanned: 0, cancelled: true };
    const candidates = rows.map(([path, dateTaken, inScope]) => ({ path, dateTaken, inScope, isRaw: RAW_EXTENSIONS.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase()) }));
    // With the hash search to come, the name search only fills the first tenth of the progress bar.
    nameReport = await findNameGroups(candidates, settings, { shouldStop: () => task.stopRequested, onProgress: percent => setPercent(settings.hash ? percent / 10 : percent) });
    if (nameReport.cancelled) return nameReport;
    parts.push({ reason: 'name', groups: nameReport.groups });
  }
  if (settings.hash) {
    hashReport = await invoke('find_duplicates', { request: { scope, compareWithLibrary, ignoreMetadata: settings.ignoreMetadata }, taskId: task.id });
    if (hashReport.cancelled) return hashReport;
    parts.push({ reason: 'hash', groups: hashReport.groups });
  }
  const report = {
    scanned: Math.max(nameReport?.scanned ?? 0, hashReport?.scanned ?? 0),
    unsupported: 0,
    skippedGroups: nameReport?.skippedGroups ?? 0,
    wholeFileExtensions: hashReport?.wholeFileExtensions ?? [],
    cancelled: false,
  };
  if (parts.length === 1) return { ...report, groups: parts[0].groups }; // one criterion: no reason to show
  return { ...report, ...mergeGroups(parts) };
}

const DUPLICATE_REASONS = { hash: 'Same image data', name: 'Same file name' };

const DUPLICATE_KINDS = {
  identical: {
    settings: getIdenticalSettings,
    // Title of the results: the image data is the main criterion; the name alone has its own title.
    titleKey: settings => (settings.hash ? 'Identical images' : 'Same file name'),
    labelKey: settings => (settings.hash ? 'Identical images: {scope}' : 'Same file name: {scope}'),
    runner: (spec, settings, task, setPercent) => runIdenticalSearch(spec, settings, task, setPercent),
  },
  similar: {
    settings: getSimilarSettings,
    titleKey: () => 'Similar images',
    labelKey: () => 'Similar images: {scope}',
    command: 'find_similar_images',
    request: settings => similarRequestFields(settings),
  },
};

// `kind`: 'identical' | 'similar'.
export function findDuplicateImages(kind, { scope, label, compareWithLibrary }, settings) {
  const definition = DUPLICATE_KINDS[kind];
  settings = settings ?? definition.settings();
  // Same kind of search on the same scope (same folder, same photos, whole library): refused while another one is running or waiting.
  const scopeKey = scope.kind === 'folder' ? `folder:${host.normalizeFilterPath(scope.path)}:${scope.recursive}`
    : scope.kind === 'paths' ? `paths:${[...scope.paths].sort().join('|')}` : 'all';
  return host.enqueueTask({
    kind: 'duplicates', path: null, dedupeKey: `${kind}:${scopeKey}`,
    ...(definition.runner
      ? { runner: (task, setPercent) => definition.runner({ scope, compareWithLibrary }, settings, task, setPercent) }
      : { command: definition.command, args: { request: { scope, compareWithLibrary, ...definition.request(settings) } } }),
    labelKey: definition.labelKey(settings), labelParams: { scope: label },
    onResult: (result, stopped, error, task) => handleDuplicatesResult(result, stopped, error, definition.titleKey(settings), label, task, {
      kind,
      criteria: describeSearch(kind, settings, { scope, compareWithLibrary }),
      // RAW and JPEG searched together: results are shown per format and never offered for cleanup. (The hash search never pairs them: only the name does.)
      mixedFormats: kind === 'identical' ? Boolean(settings.name && settings.includeRawPairs) : Boolean(settings.includeRawPairs),
    }),
  });
}

// "More…" window (duplicates-modal.js): the user picks the kind and the settings, then the search starts with them.
export function openDuplicatesDialog(spec) {
  openDuplicatesModal(spec, (kind, chosenSpec, settings) => findDuplicateImages(kind, chosenSpec, settings));
}

// ==========================================
// INITIALIZATION
// ==========================================

// Wires duplicate results banner controls and host dependencies.
export function initDuplicatesView(deps) {
  if (initialized) return;
  host = deps;
  initialized = true;

  document.getElementById('duplicates-back')?.addEventListener('click', () => exitDuplicateSearch());
  document.getElementById('duplicates-keep')?.addEventListener('click', () => toggleKeepPanel(rankDuplicatesAgain));
  document.getElementById('duplicates-select')?.addEventListener('click', selectDuplicatesExceptBest);
  document.getElementById('duplicates-sort')?.addEventListener('click', () => {
    if (!duplicateSearch) return;
    duplicateSearch.sortMode = GROUP_SORT_MODES[(GROUP_SORT_MODES.indexOf(duplicateSearch.sortMode) + 1) % GROUP_SORT_MODES.length];
    localStorage.setItem(DUPLICATE_SORT_KEY, duplicateSearch.sortMode);
    rankDuplicateGroups();
    host.clearFullscreenImageCache(); // the preload cache is indexed by position in the list
    host.applyPhotoFilters({ keepState: true });
  });
}
