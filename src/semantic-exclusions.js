// Content search: keywords never suggested (Settings > Content search). Camera gear, lenses and other keywords that the content of a photo
// cannot tell give poor suggestions: the user lists them here, and neither they nor any keyword below them (at any depth) is ever suggested,
// in the "Suggestions" block of the Keywords tab (photo -> keywords, filtered by the backend) or in the keyword filter (keyword -> photos,
// filtered by semantic-keywords.js). The explicit "Find photos that may match" of a keyword is not affected: the user asked for it.
// Stored as keyword ids (they survive a rename); a keyword deleted from the tree leaves the list the next time the tree is read.

import { invoke } from '@tauri-apps/api/core';
import { t, normalizeSearch, onLanguageChange } from './i18n.js';
import { readStored, DEFAULTS } from './settings-defaults.js';
import { createFilterSuggest } from './filter-suggest.js';

const STORAGE_KEY = 'semanticExcludedKeywords';
const ROOT_ID = 0; // parent of the top-level keywords (keywords-panel.js)

const isKeywordId = value => Number.isInteger(value) && value > 0;

function readIds() {
  try {
    const stored = JSON.parse(readStored(STORAGE_KEY) ?? 'null');
    if (Array.isArray(stored)) return [...new Set(stored.filter(isKeywordId))];
  } catch { /* unreadable: the default */ }
  return [...DEFAULTS[STORAGE_KEY]];
}

let excluded = readIds();
const listeners = new Set();

/** Ids of the excluded keywords (their descendants are excluded too). Sent to the backend with each request for suggestions of a photo. */
export function excludedKeywordIds() {
  return [...excluded];
}

/** `listener()` is called after the list changed. Returns the function that removes it. */
export function onExcludedKeywordsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ids of the excluded keywords and of every keyword below them, from a tree read by `get_keyword_tree` ([{ id, parent_id }]). */
export function excludedSubtreeIds(tree) {
  const result = new Set();
  if (excluded.length === 0) return result;
  const childrenOf = new Map();
  for (const node of tree) {
    if (!childrenOf.has(node.parent_id)) childrenOf.set(node.parent_id, []);
    childrenOf.get(node.parent_id).push(node.id);
  }
  const stack = excluded.filter(id => tree.some(node => node.id === id));
  while (stack.length) {
    const id = stack.pop();
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...(childrenOf.get(id) || []));
  }
  return result;
}

function save(ids) {
  excluded = ids;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ids)); } catch { /* storage unavailable: setting not remembered */ }
  for (const listener of listeners) {
    try { listener(); } catch (error) { console.error('Excluded keywords listener failed', error); }
  }
}

// ---------------------------------------------------------------------------
// Settings section: a field with the keyword list (as the quick input of the Keywords tab), and the chosen keywords as chips below it
// ---------------------------------------------------------------------------

let nodeById = new Map(); // id -> { id, name, parent_id }
let usageById = new Map(); // id -> photos carrying the keyword
let treeLoaded = false;
let chips = null;
let suggest = null;

function pathLabel(id) {
  const names = [];
  for (let node = nodeById.get(id); node; node = node.parent_id === ROOT_ID ? null : nodeById.get(node.parent_id)) names.unshift(node.name);
  return names.join(' › ');
}

// Read when the section is shown and when the field gets the focus: the tree may have changed since (files read, keyword created).
async function loadTree() {
  try {
    const [nodes, usage] = await Promise.all([invoke('get_keyword_tree'), invoke('get_keyword_usage')]);
    nodeById = new Map(nodes.map(node => [node.id, node]));
    usageById = new Map(usage);
    treeLoaded = true;
  } catch (error) {
    console.error('Keyword tree unreadable', error);
    return;
  }
  // Keywords deleted from the tree leave the list.
  const kept = excluded.filter(id => nodeById.has(id));
  if (kept.length !== excluded.length) save(kept);
  renderChips();
  suggest?.refresh();
}

function renderChips() {
  if (!chips) return;
  // Before the tree is read the names are unknown: nothing is drawn rather than bare ids.
  const shown = treeLoaded ? excluded.filter(id => nodeById.has(id)) : [];
  chips.replaceChildren(...shown
    .map(id => ({ id, label: pathLabel(id) }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(({ id, label }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'filter-tag tag-keyword';
      button.textContent = `${label} ×`;
      button.title = t('Suggest {keyword} again', { keyword: label });
      button.addEventListener('click', () => {
        save(excluded.filter(other => other !== id));
        renderChips();
      });
      return button;
    }));
}

// Offered keywords: every keyword of the tree not excluded yet, with its full path (searched on the path, so "Gear" finds its children too).
function options() {
  const taken = new Set(excluded);
  return [...nodeById.values()]
    .filter(node => !taken.has(node.id))
    .map(node => {
      const label = pathLabel(node.id);
      return { value: node.id, label, count: usageById.get(node.id) || 0, search: normalizeSearch(label) };
    });
}

/** Wires the field, its list and the chips of Settings > Content search. `sectionButton`: the settings tab button that shows the section. */
export function initExcludedKeywordsSetting(sectionButton) {
  const input = document.getElementById('semantic-excluded-keyword-input');
  const list = document.getElementById('semantic-excluded-keyword-suggestions');
  chips = document.getElementById('semantic-excluded-keywords');
  if (!input || !list || !chips) return;
  suggest = createFilterSuggest({
    input,
    list,
    getOptions: options,
    // Enter or a click on a keyword adds it; Enter with nothing matching does nothing (only existing keywords can be excluded).
    onPick: value => {
      if (!isKeywordId(value) || excluded.includes(value)) return;
      save([...excluded, value]);
      renderChips();
    },
    emptyText: 'No matching keyword',
  });
  input.addEventListener('focus', () => { loadTree(); });
  sectionButton?.addEventListener('click', () => { loadTree(); });
  onLanguageChange(renderChips);
}
