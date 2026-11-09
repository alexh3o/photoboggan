// Content search, tagging help (SigLIP 2, Phase 6): keyword -> photos and photo -> keywords.
// See dev_tools/Evolutions/feat semantic search SigLIP 2.md (§8, §23.5, §26). Nothing here writes anything: accepting a suggestion only adds a
// PENDING keyword through the Keywords panel (keywords-panel.js, addPendingKeyword), exactly as if the user had ticked it. Every function is
// idle, and makes no IPC call, while isSemanticEnabled() is false.

import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n.js';
import { readBool } from './settings-defaults.js';
import { isSemanticEnabled, onSemanticChange, semanticErrorMessage, analyseContent } from './semantic-settings.js';
import { setBusy } from './semantic.js';
import { excludedKeywordIds, onExcludedKeywordsChange } from './semantic-exclusions.js';

let candidatesCounter = 0; // the backend cancels nothing: an answer older than the latest request is ignored

/**
 * Photos that may deserve the keyword (spec §23.5). Resolves { answer, error }: `answer` is null when disabled or when a newer request made
 * this one stale; `error` is the raw backend key (the caller translates it with semanticErrorMessage). The first call for a keyword with fewer
 * than 5 analysed photos loads the text model (~1.5 s): the spinner of the search field is shown meanwhile.
 */
export async function fetchKeywordCandidates(keywordId, scope) {
  if (!isSemanticEnabled()) return { answer: null, error: null };
  const request = ++candidatesCounter;
  setBusy(true);
  try {
    const answer = await invoke('semantic_keyword_candidates', { keywordId, scope });
    return { answer: request === candidatesCounter ? answer : null, error: null };
  } catch (error) {
    return { answer: null, error: request === candidatesCounter ? String(error) : null };
  } finally {
    if (request === candidatesCounter) setBusy(false);
  }
}

/** "Not this keyword": the photos are never suggested for it again (keyword_suggestion_rejections). Resolves { error } (null on success). */
export async function rejectKeywordSuggestion(photoIds, keywordId) {
  if (!isSemanticEnabled()) return { error: 'semantic_disabled' };
  try {
    await invoke('reject_keyword_suggestion', { photoIds, keywordId });
    return { error: null };
  } catch (error) {
    return { error: String(error) };
  }
}

// ---------------------------------------------------------------------------
// Photo -> keywords: the "Suggestions" block of the Keywords tab
// ---------------------------------------------------------------------------

const OPEN_KEY = 'keywordSuggestionsOpen';
let host = null; // provided by keywords-panel.js (see initPhotoSuggestions)
let suggestionCounter = 0; // stale answers (the selection moved on) are ignored, as in semantic.js
let shown = null; // { photoId, items: [{ keywordId, name, path, examples }], eligible, status: 'ready' | 'not-analysed' | 'error', message }
const byId = id => document.getElementById(id);

function hideBlock() {
  suggestionCounter++; // an answer on its way is now stale
  shown = null;
  const block = byId('keyword-photo-suggestions');
  if (block) block.hidden = true;
}

/** Draws `shown` (again after each pending edit: a keyword already ticked in the tree is not offered a second time). */
export function renderPhotoSuggestions() {
  const block = byId('keyword-photo-suggestions');
  if (!block) return;
  if (!shown || !isSemanticEnabled()) { block.hidden = true; return; }
  block.hidden = false;
  block.classList.remove('loading');
  const list = byId('keyword-photo-suggestions-list');
  const note = byId('keyword-photo-suggestions-note');
  const items = shown.status === 'ready' ? shown.items.filter(item => !host.isActive(item.keywordId)) : [];
  list.replaceChildren(...items.map(item => {
    const row = document.createElement('li');
    row.className = 'keyword-photo-suggestion';
    const name = Object.assign(document.createElement('span'), { className: 'keyword-photo-suggestion-name', textContent: item.name, title: item.path });
    const add = Object.assign(document.createElement('button'), { type: 'button', textContent: t('Add'), title: t('Add the keyword to this photo as a pending change (nothing is written until “Write to files”)') });
    add.addEventListener('click', () => acceptSuggestion(item));
    const ignore = Object.assign(document.createElement('button'), { type: 'button', textContent: t('Ignore'), title: t('Never suggest this keyword for this photo again') });
    ignore.addEventListener('click', () => dismissSuggestion(item));
    row.append(name, add, ignore);
    return row;
  }));
  let message = '';
  if (shown.status === 'not-analysed') message = t('This photo has not been analysed yet, so no keyword can be suggested.');
  else if (shown.status === 'error') message = shown.message;
  else if (items.length === 0) message = shown.eligible === 0 ? t('To get suggestions, tag at least 5 analysed photos with a keyword.') : t('No keyword to suggest for this photo.');
  note.textContent = message;
  note.hidden = !message;
  byId('keyword-photo-suggestions-analyse').hidden = shown.status !== 'not-analysed';
}

async function acceptSuggestion(item) {
  const count = await host.addKeyword(item.keywordId); // pending keyword, exactly as a click on its checkbox
  if (count === 0) host.showToast(t('The keyword could not be added to the selection'));
}

async function dismissSuggestion(item) {
  if (!shown) return;
  const photoId = shown.photoId;
  const { error } = await rejectKeywordSuggestion([photoId], item.keywordId);
  if (error) { host.showToast(semanticErrorMessage(error)); return; }
  if (shown?.photoId !== photoId) return; // the selection moved on meanwhile
  shown.items = shown.items.filter(other => other.keywordId !== item.keywordId);
  renderPhotoSuggestions();
}

async function loadPhotoSuggestions(photoId) {
  const request = ++suggestionCounter;
  const block = byId('keyword-photo-suggestions');
  if (block && !block.hidden) block.classList.add('loading'); // buttons off until the answer: they belong to the previous photo
  let state;
  try {
    const answer = await invoke('semantic_photo_suggestions', { photoId, excludedKeywordIds: excludedKeywordIds() });
    if (request !== suggestionCounter) return;
    await host.ensureTree(); // names of the keywords (the tree may not be loaded yet)
    if (request !== suggestionCounter) return;
    const items = [];
    for (const suggestion of answer.suggestions) {
      const label = host.keywordLabel(suggestion.keywordId);
      if (label) items.push({ keywordId: suggestion.keywordId, name: label.name, path: label.path, examples: suggestion.examples });
    }
    state = { photoId, items, eligible: answer.eligible, status: 'ready' };
  } catch (error) {
    if (request !== suggestionCounter) return;
    const key = String(error);
    state = { photoId, items: [], eligible: 0, status: key === 'semantic_photo_not_analysed' ? 'not-analysed' : 'error', message: semanticErrorMessage(key) };
  }
  shown = state;
  renderPhotoSuggestions();
}

/**
 * Called by the Keywords tab each time its selection may have changed (the tab is visible). One photo selected: its suggestions are requested
 * (again only when the photo changes, or with `force` after a write); none or several: the block is hidden (v1). No IPC call while disabled.
 */
export function syncPhotoSuggestions({ force = false } = {}) {
  if (!host) return;
  const selected = host.getSelectedPhotos();
  if (!isSemanticEnabled() || selected.length !== 1 || !(selected[0].id > 0)) {
    if (shown || !byId('keyword-photo-suggestions')?.hidden) hideBlock();
    return;
  }
  if (!force && shown?.photoId === selected[0].id) return;
  loadPhotoSuggestions(selected[0].id);
}

// hostApi (keywords-panel.js): getSelectedPhotos(), keywordLabel(id) -> { name, path } | null, ensureTree() -> Promise, isActive(id) (ticked in the
// tree, pending or written), addKeyword(id) -> Promise<number of photos>, showToast(message).
export function initPhotoSuggestions(hostApi) {
  host = hostApi;
  const block = byId('keyword-photo-suggestions');
  if (!block) return;
  block.open = readBool(OPEN_KEY);
  block.addEventListener('toggle', () => { try { localStorage.setItem(OPEN_KEY, String(block.open)); } catch { /* storage unavailable: not remembered */ } });
  byId('keyword-photo-suggestions-analyse').addEventListener('click', () => {
    if (shown?.status === 'not-analysed') analyseContent({ photoIds: [shown.photoId] });
  });
  onSemanticChange(() => { if (!isSemanticEnabled()) hideBlock(); }); // disabled or model deleted: the block goes at once
  onExcludedKeywordsChange(() => { if (shown) syncPhotoSuggestions({ force: true }); }); // Settings > Content search: keywords never suggested
}
