// Content search, tagging help (SigLIP 2, Phase 6): keyword -> photos and photo -> keywords.
// See dev_tools/Evolutions/feat semantic search SigLIP 2.md (§8, §23.5, §26). Nothing here writes anything: accepting a suggestion only adds a
// PENDING keyword through the Keywords panel (keywords-panel.js, addPendingKeyword), exactly as if the user had ticked it. Every function is
// idle, and makes no IPC call, while isSemanticEnabled() is false.

import { invoke } from '@tauri-apps/api/core';
import { isSemanticEnabled } from './semantic-settings.js';
import { setBusy } from './semantic.js';

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
