// Content search results mode: relevance cut, banner rendering, keyword-candidate actions,
// similar-content / keyword-candidate entry points, and view snapshot entry/exit.
// `main.js` wires host state and callbacks via `initSemanticResults()`.
import { invoke } from '@tauri-apps/api/core';
import { readBool, readChoice, readNumber } from './settings-defaults.js';
import { t, tp, onLanguageChange } from './i18n.js';
import { isSemanticEnabled, onSemanticChange, analyseContent, semanticErrorMessage } from './semantic-settings.js';
import { initSemanticSearch, searchText, searchImage, currentSearchScope, semanticScope } from './semantic.js';
import { fetchKeywordCandidates, rejectKeywordSuggestion } from './semantic-tagging.js';
import { getSelectedAlbum, clearAlbumSelection, isSelectedAlbumDirty, confirmLeaveAlbum } from './albums-panel.js';
import { addPendingKeyword } from './keywords-panel.js';
import { fillSortButton } from './faces-grid.js';
import { confirmDialog } from './photo-actions.js';

let host = {};
let initialized = false;

// ==========================================
// CONTENT SEARCH RESULTS
// ==========================================
// Mode `semanticSearch`, built like `duplicateSearch` / `rawSearch`: the grid shows the photos of the backend answer sorted by relevance, a banner
// gives the query, the count, the relevance slider and "Close". Navigating by hand (folder, album, sub-folder option) ends it, and so does
// disabling the feature. The slider is a plain filter (`matchesSemanticCut`): no new request when it moves (spec §18.2).
const semanticDelta = () => readNumber('semanticRelevance', 0.005, 0.08);
let semanticSliderFrame = 0;
let semanticSortMode = readChoice('semanticKeywordSort', ['grid', 'score']); // order of the photos carrying the typed keyword
let semanticSearch = null;

export const isSemanticSearchActive = () => semanticSearch !== null;
export const getSemanticSearch = () => semanticSearch;
export const getSemanticSortMode = () => semanticSortMode;

// Position in the answer (decreasing score); the source photo of a similar-content search is -1, photos outside the answer come last.
export function semanticRankOrder(a, b) {
  const rankA = semanticSearch.rank.get(a.id) ?? Infinity;
  const rankB = semanticSearch.rank.get(b.id) ?? Infinity;
  return rankA === rankB ? 0 : rankA - rankB;
}

// The photos of the answer, read again each time the mode reloads (a rescan, a metadata write).
export function loadSemanticPhotos() {
  return invoke('get_photos_by_ids', { ids: semanticSearch.ids });
}

// Relative threshold of §7.1: a result stays while cos >= best - delta. The source photo of a similar-content search always stays.
export function matchesSemanticCut(photo) {
  if (!semanticSearch) return true;
  if (semanticSearch.keyword) return true; // keyword candidates: the backend threshold is the rule, the slider is hidden
  if (photo.id === semanticSearch.sourceId || semanticSearch.carried.has(photo.id)) return true; // tagged with the typed keyword: always kept
  const cos = semanticSearch.cos.get(photo.id);
  return cos !== undefined && cos >= semanticSearch.best - semanticDelta();
}

export function renderSemanticBanner() {
  // Elements read at each call: the function can run before this section of the module has been executed.
  const banner = document.getElementById('semantic-banner');
  if (!banner) return;
  banner.hidden = !semanticSearch;
  if (!semanticSearch) return;
  const search = semanticSearch;
  const photos = host.getPhotos();
  const shown = photos.filter(photo => photo.id !== search.sourceId).length;
  const parts = [search.label, tp('{count} result', shown)];
  const carriedShown = photos.filter(photo => search.carried.has(photo.id)).length;
  if (carriedShown > 0) parts.push(tp('{count} tagged with this keyword', carriedShown, { count: carriedShown.toLocaleString() }));
  const sortButton = document.getElementById('semantic-sort');
  sortButton.hidden = search.carried.size === 0;
  fillSortButton(sortButton, semanticSortMode);
  if (search.keyword) parts.splice(1, 0, search.keyword.kind === 'examples' ? tp('like your {count} photo tagged with it', search.keyword.examples) : t('from the keyword name'));
  // More than the cap was scored and the cut did not stop before it: say that the list is the best part only.
  const cut = search.best - semanticDelta();
  if (!search.keyword && search.capped && search.lastCos >= cut) parts.push(t('The {count} best results only', { count: search.ids.length - (search.sourceId === null ? 0 : 1) }));
  document.getElementById('semantic-text').textContent = parts.join(' · ');
  const slider = document.getElementById('semantic-relevance');
  slider.closest('.semantic-relevance').hidden = Boolean(search.keyword); // the slider counts text cosines: not for keyword candidates
  renderSemanticKeywordActions();
  if (Number(slider.value) !== semanticDelta()) slider.value = String(semanticDelta());
  // Photos of the scope the analysis would still handle (never analysed, or changed since): the answer's `pending`, no other call.
  const pendingRow = document.getElementById('semantic-pending-row');
  pendingRow.hidden = !(search.pending > 0);
  if (search.pending > 0) {
    const where = t(search.scopeKind === 'folder' ? 'this folder' : search.scopeKind === 'library' ? 'the library' : 'the current view');
    document.getElementById('semantic-pending-text').textContent = tp('{count} photo of {where} is not analysed yet, or changed since its analysis', search.pending, { count: search.pending.toLocaleString(), where });
  }
}

// Keyword -> photos: actions on the selected photos. Disabled while nothing is selected.
export function renderSemanticKeywordActions() {
  const row = document.getElementById('semantic-keyword-row');
  if (!row) return;
  const keyword = semanticSearch?.keyword ?? null;
  row.hidden = !keyword;
  if (!keyword) return;
  const count = host.getSelectedPhotos().length;
  const add = document.getElementById('semantic-keyword-add');
  add.textContent = t('Add keyword “{name}”', { name: keyword.name });
  add.title = t('Add the keyword to the selected photos as a pending change (nothing is written until “Write to files”)');
  add.disabled = count === 0;
  document.getElementById('semantic-keyword-reject').disabled = count === 0;
  document.getElementById('semantic-keyword-hint').textContent = count === 0 ? t('Select photos to tag them') : tp('{count} photo selected', count, { count: count.toLocaleString() });
}

// Ends the mode without reopening the previous view (same contract as abandonDuplicateSearch).
export function abandonSemanticSearch() {
  if (!semanticSearch) return;
  const { snapshot } = semanticSearch;
  semanticSearch = null;
  host.setIncludeSubfoldersTemporarily(snapshot.includeSubfolders);
  host.resetAllFilters();
  if (snapshot.albumKind !== 'smart') host.applyFilterState(snapshot.filterState);
  renderSemanticBanner();
}

// "Close" and Escape.
export async function exitSemanticSearch() {
  if (!semanticSearch) return;
  const { snapshot } = semanticSearch;
  abandonSemanticSearch();
  await host.restoreViewSnapshot(snapshot);
}

// Opens the mode on a backend answer. `spec`: { label, answer, scope, viewScope, sourcePhoto }. Returns false when the user declined to leave a
// modified smart album. A new search from inside the mode replaces the results and keeps the view to go back to.
async function showSemanticResults({ label, answer, scope, viewScope, sourcePhoto = null, keyword = null, carriedIds = [] }) {
  if (isSelectedAlbumDirty() && !(await confirmLeaveAlbum())) return false;
  if (host.isFullscreen()) host.closeFullscreen();
  const album = getSelectedAlbum();
  const snapshot = semanticSearch?.snapshot ?? host.getOtherSearchSnapshot() ?? host.captureViewSnapshot(album);
  host.abandonOtherSearches(); // both put back the filters of before their search; the snapshot above is the view to go back to
  clearAlbumSelection();
  host.syncSmartAlbumWithSelection();
  host.resetAllFilters();
  // A search over a folder keeps it highlighted in the tree (the list itself no longer depends on it); other scopes show "All photos".
  host.setFolderFilter(scope.folder ?? null);
  const sourceId = sourcePhoto?.id ?? null;
  const search = {
    label, snapshot, scope, viewScope, sourceId, keyword, scopeKind: scope.folder ? 'folder' : semanticScope() === 'library' ? 'library' : 'view',
    best: answer.best, capped: answer.capped, pending: answer.pending, total: answer.total,
    lastCos: answer.results.length ? answer.results[answer.results.length - 1].cos : Infinity,
    ids: answer.results.map(result => result.photoId), cos: new Map(), prob: new Map(), rank: new Map(),
  };
  answer.results.forEach((result, index) => { search.cos.set(result.photoId, result.cos); search.prob.set(result.photoId, result.prob); search.rank.set(result.photoId, index); });
  if (sourceId !== null) { search.ids.push(sourceId); search.rank.set(sourceId, -1); } // the source photo is not in the results: shown first
  // Photos tagged with the typed keyword (toolbar box): always listed, before the content results; some may be outside the answer (no score).
  search.carried = new Set(carriedIds);
  const known = new Set(search.ids);
  for (const id of carriedIds) if (!known.has(id)) search.ids.push(id);
  semanticSearch = search;
  host.renderFolderTree();
  await host.loadPhotos();
  return true;
}

// "Find similar content" (menu of one photo). The interface does not know whether the photo has an embedding: the backend says so, and the user is
// offered to analyse it. The photo itself is not in the results: it is shown first, marked as the source.
export async function findSimilarContent(photo) {
  if (!photo || !isSemanticEnabled()) return;
  const viewScope = host.currentViewScope();
  const scope = currentSearchScope(viewScope);
  const { answer, error } = await searchImage(photo.id, scope);
  if (error === 'semantic_photo_not_analysed') {
    const analyse = await confirmDialog({
      title: t('Photo not analysed'),
      message: t('This photo has not been analysed yet, so similar content cannot be found. Analyse it now? It only takes a moment; search again once the analysis is done.'),
      confirmLabel: t('Analyse'),
      cancelLabel: t('Cancel'),
    });
    if (analyse) analyseContent({ photoIds: [photo.id] });
    return;
  }
  if (error) { host.showToast(semanticErrorMessage(error)); return; }
  if (!answer) return; // a newer search made this answer stale
  // Image-to-image cosines are not on the scale of text ones (spec §18.3, §14-5): the values the relevance slider has to work with, for tuning.
  const at = rank => answer.results[rank - 1]?.cos;
  console.debug('Similar content cosines', { best: answer.best, rank10: at(10), rank50: at(50), rank200: at(200), count: answer.results.length });
  await showSemanticResults({ label: t('Content similar to {name}', { name: photo.path.split(/[\\/]/).pop() }), answer, scope, viewScope, sourcePhoto: photo });
}

// "Find photos that may match" (menu of a keyword): the candidates of the backend (examples or name score, threshold already applied, never the
// photos that carry the keyword nor the dismissed ones) in the results mode, with the scope of the search toggle like the other entries.
export async function findKeywordCandidates({ id, name }) {
  if (!isSemanticEnabled()) return;
  const viewScope = host.currentViewScope();
  const scope = currentSearchScope(viewScope);
  const { answer, error } = await fetchKeywordCandidates(id, scope);
  if (error) { host.showToast(semanticErrorMessage(error)); return; }
  if (!answer) return; // a newer request made this answer stale
  await showSemanticResults({
    label: t('Photos that may deserve “{name}”', { name }), answer, scope, viewScope,
    keyword: { id, name, kind: answer.kind, examples: answer.examples },
  });
}

// ==========================================
// INITIALIZATION
// ==========================================

// Wires content search results banner controls, toolbar search field, and host dependencies.
export function initSemanticResults(deps) {
  if (initialized) return;
  host = deps;
  initialized = true;

  document.getElementById('semantic-close')?.addEventListener('click', () => exitSemanticSearch());
  // "Grid" / "Score": order of the photos carrying the typed keyword (same button as the Faces view). Sorting again keeps selection and scroll.
  document.getElementById('semantic-sort')?.addEventListener('click', () => {
    semanticSortMode = semanticSortMode === 'score' ? 'grid' : 'score';
    try { localStorage.setItem('semanticKeywordSort', semanticSortMode); } catch { /* storage unavailable: the choice is not remembered */ }
    renderSemanticBanner();
    if (!semanticSearch) return;
    host.clearFullscreenImageCache(); // the preload cache is indexed by position in the list
    host.applyPhotoFilters({ keepState: true });
  });
  onLanguageChange(() => renderSemanticBanner());
  document.getElementById('semantic-relevance')?.addEventListener('input', event => {
    try { localStorage.setItem('semanticRelevance', event.target.value); } catch { /* storage unavailable: the choice is not remembered */ }
    if (!semanticSearch) return;
    // One refresh per frame while the slider is dragged.
    cancelAnimationFrame(semanticSliderFrame);
    semanticSliderFrame = requestAnimationFrame(() => {
      host.clearFullscreenImageCache(); // the preload cache is indexed by position in the list
      host.applyPhotoFilters({ keepState: true });
    });
  });
  // "Analyse": the same scope as the search, in the semantic lane of the queue. The results are not refreshed by themselves: the user searches again.
  document.getElementById('semantic-analyse')?.addEventListener('click', () => {
    if (!semanticSearch) return;
    const { folder, recursive, photoIds } = semanticSearch.scope;
    analyseContent({ folder, recursive, photoIds });
  });

  // "Add keyword": a pending keyword on the selection through the Keywords panel; the photos stay in the list until the user writes it.
  document.getElementById('semantic-keyword-add')?.addEventListener('click', async () => {
    const keyword = semanticSearch?.keyword;
    if (!keyword) return;
    const count = await addPendingKeyword(keyword.id);
    host.showToast(count > 0
      ? tp('Keyword “{name}” added to {count} photo: click “Write to files” to save it', count, { name: keyword.name })
      : t('The keyword could not be added to the selection'));
  });

  // "Not this keyword": the selected photos are never suggested for it again; they leave the list at once (no new request).
  document.getElementById('semantic-keyword-reject')?.addEventListener('click', async () => {
    const search = semanticSearch;
    if (!search?.keyword) return;
    const ids = host.getSelectedPhotos().map(photo => photo.id).filter(id => Number.isFinite(id) && id > 0);
    if (ids.length === 0) return;
    const { error } = await rejectKeywordSuggestion(ids, search.keyword.id);
    if (error) { host.showToast(semanticErrorMessage(error)); return; }
    if (semanticSearch !== search) return; // the mode was closed or replaced meanwhile
    const gone = new Set(ids);
    search.ids = search.ids.filter(id => !gone.has(id));
    for (const id of gone) { search.cos.delete(id); search.prob.delete(id); search.rank.delete(id); search.carried.delete(id); }
    host.setLoadedPhotos(host.getLoadedPhotos().filter(photo => !gone.has(photo.id)));
    host.clearFullscreenImageCache();
    host.applyPhotoFilters({ keepState: true });
    host.showToast(tp('{count} photo will no longer be suggested for “{name}”', ids.length, { name: search.keyword.name }));
  });

  // Content search field of the toolbar (see semantic.js).
  initSemanticSearch({
    getViewScope: () => host.currentViewScope(),
    showToast: message => host.showToast(message),
    errorMessage: semanticErrorMessage,
    onSearch: async query => {
      const viewScope = host.currentViewScope(); // read before the mode changes the view
      const scope = currentSearchScope(viewScope);
      // The box is shared with the keyword search: the photos tagged with the typed text come first, then the content results.
      const [answer, carriedIds] = await Promise.all([
        searchText(query, scope),
        readBool('semanticKeywordsInSearch') ? invoke('semantic_keyword_photos', { query, scope }).catch(() => []) : [],
      ]);
      if (!answer) return;
      await showSemanticResults({ label: `“${query}”`, answer, scope, viewScope, carriedIds });
    },
  });
  onSemanticChange(() => { if (semanticSearch && !isSemanticEnabled()) exitSemanticSearch(); }); // disabled, or the model deleted
}
