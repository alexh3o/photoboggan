// Content search, search side (SigLIP 2): the toolbar field, its scope toggle and the requests to the backend.
// See dev_tools/Evolutions/feat semantic search SigLIP 2.md (§7, §9, §18). Everything here stays idle while the feature is off:
// no listener does anything and no IPC call is made (the field itself is hidden by `.semantic-only`, see semantic-settings.js).

import { invoke } from '@tauri-apps/api/core';
import { t, onLanguageChange } from './i18n.js';
import { readBool, readChoice } from './settings-defaults.js';
import { isSemanticEnabled, onSemanticChange } from './semantic-settings.js';

const SCOPE_KEY = 'semanticScope';

let host = null; // provided by main.js (see initSemanticSearch)
let requestCounter = 0; // the backend cancels nothing: an answer older than the latest request is ignored

const byId = id => document.getElementById(id);

/** "view" = the folder or collection on screen, "library" = every photo. Remembered. */
export function semanticScope() {
  return readChoice(SCOPE_KEY, ['view', 'library']);
}

/**
 * Scope sent to the backend (§18.1): { folder, recursive, photoIds, skipRaw }.
 * "view" asks main.js what is on screen (a folder, or the photo ids of the collection shown); "library" is {} plus skipRaw.
 * `skipRaw` only changes the `pending` count of the answer (RAW already analysed are always searched).
 */
export function currentSearchScope(view = host.getViewScope()) {
  const skipRaw = !readBool('semanticScanRaw');
  if (semanticScope() === 'library') return { folder: null, recursive: false, photoIds: null, skipRaw };
  return { folder: view.folder ?? null, recursive: Boolean(view.recursive), photoIds: view.photoIds ?? null, skipRaw };
}

function renderScopeToggle() {
  const button = byId('semantic-scope-toggle');
  if (!button) return;
  const library = semanticScope() === 'library';
  button.textContent = t(library ? 'Scope: library' : 'Scope: view');
  button.setAttribute('aria-pressed', String(library));
  button.title = library
    ? t('Searching the whole library. Click to search only the current folder or collection.')
    : t('Searching the current folder or collection. Click to search the whole library.');
}

function toggleScope() {
  try { localStorage.setItem(SCOPE_KEY, semanticScope() === 'library' ? 'view' : 'library'); } catch { /* storage unavailable: the choice is not remembered */ }
  renderScopeToggle();
}

/** Spinner in the field: the first text query loads the model (~1.5 s). Also used by the keyword candidates (semantic-tagging.js). */
export function setBusy(busy) {
  const spinner = byId('semantic-search-spinner');
  if (spinner) spinner.hidden = !busy;
  byId('semantic-search-input')?.classList.toggle('busy', busy);
}

/**
 * Text search. Returns the backend answer, or null when nothing was sent (disabled, empty query) or when a newer request made this one stale.
 * Errors are translated and shown as a toast; the caller never has to handle them.
 */
export async function searchText(query, scope = currentSearchScope()) {
  if (!isSemanticEnabled() || query.trim() === '') return null;
  const request = ++requestCounter;
  setBusy(true);
  try {
    const answer = await invoke('semantic_search_text', { query, scope });
    return request === requestCounter ? answer : null;
  } catch (error) {
    if (request === requestCounter) host.showToast(host.errorMessage(error));
    return null;
  } finally {
    if (request === requestCounter) setBusy(false);
  }
}

/** Similar-content search from a photo (`prob` is null in the answer). Same contract as `searchText`; the error is translated by the caller. */
export async function searchImage(photoId, scope = currentSearchScope()) {
  if (!isSemanticEnabled()) return { answer: null, error: null };
  const request = ++requestCounter;
  setBusy(true);
  try {
    const answer = await invoke('semantic_search_image', { photoId, scope });
    return { answer: request === requestCounter ? answer : null, error: null };
  } catch (error) {
    return { answer: null, error: request === requestCounter ? String(error) : null };
  } finally {
    if (request === requestCounter) setBusy(false);
  }
}

// hostApi: getViewScope() -> { folder, recursive, photoIds }, showToast(message), errorMessage(error),
// onSearch(query) (main.js opens the results mode).
export function initSemanticSearch(hostApi) {
  host = hostApi;
  const form = byId('semantic-search');
  const input = byId('semantic-search-input');
  renderScopeToggle();
  onLanguageChange(renderScopeToggle);
  byId('semantic-scope-toggle').addEventListener('click', toggleScope);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!isSemanticEnabled()) return;
    const query = input.value.trim();
    if (query === '') return; // nothing is sent for an empty query
    host.onSearch(query);
  });
  // Escape in the field: leave it (the grid shortcuts work again).
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') input.blur();
  });
  onSemanticChange(() => { if (!isSemanticEnabled()) { requestCounter++; setBusy(false); } });
}
