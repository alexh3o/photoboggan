// Content search, keyword filter side (SigLIP 2, Phase 5): photos suggested for the keywords of the filter.
// See dev_tools/Evolutions/feat semantic search SigLIP 2.md (§7.3, §25). Idle unless the setting "Include suggestions in keyword filtering"
// is on AND the feature is enabled: no IPC call is made otherwise.
//
// Rule (decided with the user): for every included keyword, a photo either carries it or is suggested for it ("carried or suggested" AND).
// A photo with at least one suggested keyword is shown after the photos that carry everything, fewer guesses first, with a "suggested" badge.

import { invoke } from '@tauri-apps/api/core';
import { t, tp, onLanguageChange } from './i18n.js';
import { readBool } from './settings-defaults.js';
import { isSemanticEnabled, onSemanticChange, semanticErrorMessage } from './semantic-settings.js';
import { rejectKeywordSuggestion } from './semantic-tagging.js';
import { excludedKeywordIds, excludedSubtreeIds, onExcludedKeywordsChange } from './semantic-exclusions.js';

let host = null; // provided by main.js (see initKeywordSuggestions)
let current = null; // { signature, byKeyword: Map(keyword -> Map(photoId -> info)), extra: Map(photoId -> photo), status }
let requestCounter = 0; // the backend cancels nothing: an answer older than the latest request is ignored

/** The setting AND the feature (model installed). Every call below checks it first. */
export const keywordSuggestionsOn = () => readBool('semanticInKeywordSearch') && isSemanticEnabled();

/** Suggestion of a photo for a keyword of the filter: { kind: 'examples' | 'text', examples, cos, keywordId } or undefined. */
export function suggestionFor(keyword, photoId) {
  return current?.byKeyword.get(keyword)?.get(photoId);
}

/** True once the candidates of the current filter are known (the filter has nothing to test before). */
export const suggestionsLoaded = () => (current?.byKeyword.size ?? 0) > 0;

/** Photos suggested for the filter that are not in the loaded list (fetched by id), to be added to the candidates. */
export function suggestedExtraPhotos() {
  return current?.extra ? [...current.extra.values()] : [];
}

/** Tooltip of the badge: for each guessed keyword, why the photo was suggested. */
export function describeGuesses(keywords, photoId) {
  const lines = [t('Not tagged with every keyword of the filter: suggested by the content analysis')];
  for (const keyword of keywords) {
    const suggestion = suggestionFor(keyword, photoId);
    if (!suggestion) continue;
    lines.push(suggestion.kind === 'examples'
      ? t('“{keyword}”: looks like the {count} photos you tagged with it', { keyword, count: suggestion.examples })
      : t('“{keyword}”: its content matches the keyword name', { keyword }));
  }
  return lines.join('\n');
}

// A dismissed photo leaves the suggestions of this keyword at once (no new request); a photo not in the loaded list that is suggested for no other
// keyword leaves the extra photos too. The caller filters again.
function forgetSuggestion(keyword, photoId) {
  current?.byKeyword.get(keyword)?.delete(photoId);
  if (current?.extra.has(photoId) && ![...current.byKeyword.values()].some(found => found.has(photoId))) current.extra.delete(photoId);
}

/**
 * Context-menu entries of a photo shown only by suggestion (the "Suggested" badge): for each keyword it is guessed for, "Add" (a pending keyword, like a
 * tick in the Keywords panel) and "Not this keyword" (dismissal). `keywords`: the guessed keywords of the photo; the name is in each label because a photo
 * can be guessed for several. Entries are plain { label, title, onSelect } objects (photo-actions.js builds the buttons).
 */
export function guessedKeywordEntries(keywords, photoId) {
  if (!keywordSuggestionsOn()) return [];
  const entries = [];
  for (const keyword of keywords) {
    const suggestion = suggestionFor(keyword, photoId);
    if (!suggestion) continue;
    const name = keyword;
    entries.push({
      label: t('Add keyword “{name}”', { name }),
      title: t('Add the keyword to this photo as a pending change (nothing is written until “Write to files”)'),
      onSelect: async () => {
        const count = await host.addKeyword(suggestion.keywordId);
        if (count === 0) host.showToast(t('The keyword could not be added to the selection'));
      },
    });
    entries.push({
      label: t('Not the keyword “{name}”', { name }),
      title: t('Never suggest this keyword for this photo again'),
      onSelect: async () => {
        const { error } = await rejectKeywordSuggestion([photoId], suggestion.keywordId);
        if (error) { host.showToast(semanticErrorMessage(error)); return; }
        forgetSuggestion(keyword, photoId);
        host.onChange();
      },
    });
  }
  return entries;
}

const statusElement = () => document.getElementById('keyword-suggest-status');

// Discreet line under the keyword chips: loading, the number of suggested photos, or the translated error (never a blocking alert).
function renderStatus() {
  const element = statusElement();
  if (!element) return;
  const status = current?.status;
  let text = '';
  if (status?.error) text = semanticErrorMessage(status.error);
  else if (status?.loading) text = t('Looking for suggested photos…');
  else if (status?.count > 0) text = tp('{count} suggested photo', status.count, { count: status.count.toLocaleString() });
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle('loading', Boolean(status?.loading));
  element.classList.toggle('error', Boolean(status?.error));
}

function reset() {
  requestCounter++; // any answer on its way is now stale
  current = null;
  renderStatus();
}

// Nodes of the tree that carry the keyword name (several parents can share a name): the interface filters on names, the backend on node ids.
function nodeIdsOf(tree, keyword) {
  const key = keyword.trim().toLowerCase();
  return tree.filter(node => node.name.trim().toLowerCase() === key).map(node => node.id);
}

// Examples scores are worth more than a name match; within the same kind the higher cosine wins (homonym nodes).
function better(candidate, known) {
  if (!known) return true;
  if (candidate.kind !== known.kind) return candidate.kind === 'examples';
  return candidate.cos > known.cos;
}

async function run(state, keywords, scope, request) {
  let firstError = null;
  const stale = () => request !== requestCounter;
  try {
    let tree = [];
    try { tree = await invoke('get_keyword_tree'); } catch (error) { firstError = String(error); }
    const neverSuggested = excludedSubtreeIds(tree); // Settings > Content search: these keywords get no suggested photos
    for (const keyword of keywords) {
      const found = new Map();
      for (const keywordId of nodeIdsOf(tree, keyword).filter(id => !neverSuggested.has(id))) {
        try {
          const answer = await invoke('semantic_keyword_candidates', { keywordId, scope });
          if (stale()) return;
          for (const result of answer.results) {
            const suggestion = { kind: answer.kind, examples: answer.examples, cos: result.cos, keywordId };
            if (better(suggestion, found.get(result.photoId))) found.set(result.photoId, suggestion);
          }
        } catch (error) {
          if (stale()) return;
          firstError ??= String(error);
        }
      }
      state.byKeyword.set(keyword, found);
    }
    // Candidates that are not in the loaded list (large folder prefiltered on the keywords, or simply not carrying them) are read by id.
    const loaded = host.loadedIds();
    const wanted = new Set();
    for (const found of state.byKeyword.values()) for (const id of found.keys()) if (!loaded.has(id)) wanted.add(id);
    const extra = wanted.size ? await invoke('get_photos_by_ids', { ids: [...wanted] }) : [];
    if (stale()) return;
    state.extra = new Map(extra.map(photo => [photo.id, photo]));
  } catch (error) {
    if (stale()) return;
    firstError ??= String(error);
  }
  state.status = { loading: false, error: firstError, count: 0 };
  host.onChange(); // re-filters; the count of suggested photos comes from there (setSuggestedCount)
}

/**
 * Called by main.js at the start of each filtering. Starts (or restarts) the search of suggestions when the filter or the view changed,
 * and drops them when the setting, the feature or the keywords are gone. Never awaits: the photos carrying the keywords are shown at once.
 * `keywords`: the included keywords of the filter. `viewKey`: a cheap string that changes with the view, or null when the view is not a
 * plain one (results modes). `getScope()`: the scope sent to the backend, only built when a search starts (it may list photo ids).
 */
export function syncKeywordSuggestions(keywords, viewKey, getScope) {
  if (!keywordSuggestionsOn() || keywords.length === 0 || viewKey === null) {
    if (current) reset();
    return;
  }
  const signature = JSON.stringify([[...keywords].sort(), viewKey, excludedKeywordIds()]);
  if (current?.signature === signature) return;
  const request = ++requestCounter;
  current = { signature, byKeyword: new Map(), extra: new Map(), status: { loading: true, error: null, count: 0 } };
  renderStatus();
  run(current, [...keywords], getScope(), request);
}

/** Number of suggested photos shown (known only after filtering): the status line. */
export function setSuggestedCount(count) {
  if (!current || current.status.loading) return;
  current.status.count = count;
  renderStatus();
}

// hostApi: loadedIds() -> Set of the photo ids of the loaded list, onChange() (main.js filters again, keeping selection and scroll),
// addKeyword(keywordId) -> Promise<number of photos> (pending keyword on the selection), showToast(message).
export function initKeywordSuggestions(hostApi) {
  host = hostApi;
  const dropIfOff = () => { if (current && !keywordSuggestionsOn()) { reset(); host.onChange(); } };
  onSemanticChange(dropIfOff); // feature disabled or model deleted: the suggestions leave the grid at once
  onExcludedKeywordsChange(() => { if (current) host.onChange(); }); // a new signature: the suggestions are searched again
  document.getElementById('semantic-in-keyword-search')?.addEventListener('change', () => (keywordSuggestionsOn() ? host.onChange() : dropIfOff()));
  onLanguageChange(renderStatus);
}
