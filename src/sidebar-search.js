// Quick search field in the title row of a sidebar block (Folders, Albums). A magnifier button (shown when the title row is hovered, like the "+" of the
// Albums block) opens a text field that grows to the left of the buttons; the caller filters its own tree live with the text typed.
// This module only owns the field (open, type, close). What the text filters is up to the caller: main.js for the folders (renderFolderTree),
// albums-panel.js for the albums. The markup is in index.html (`<name>-search`, `<name>-search-input`, `<name>-search-clear`, `<name>-search-open`).
import { normalizeSearch } from './i18n.js';

// `name`: 'folders' or 'albums' (prefix of the element ids; `<name>-toggle` is the fold button of the block).
// `onChange(query, previous)`: called each time the text changes, with the normalized text (no accents, lower case, trimmed; '' = no filter) and the
// previous one. Closing the field empties it, so it ends with `onChange('', previous)`: a caller can tell "the filter is gone" (query === '' and
// previous !== '') and put its tree back.
export function initSidebarSearch({ name, onChange }) {
  const openButton = document.getElementById(`${name}-search-open`);
  const field = document.getElementById(`${name}-search`);
  const input = document.getElementById(`${name}-search-input`);
  const clearButton = document.getElementById(`${name}-search-clear`);
  const foldButton = document.getElementById(`${name}-toggle`);
  let query = '';

  function setQuery(next) {
    if (next === query) return;
    const previous = query;
    query = next;
    onChange(query, previous);
  }

  function open() {
    // A folded block unfolds, so that the results can be seen (its own click handler remembers the state and refreshes what depends on it).
    if (foldButton.getAttribute('aria-expanded') === 'false') foldButton.click();
    field.hidden = false;
    openButton.hidden = true;
    input.focus();
  }

  function close() {
    if (field.hidden) return;
    input.value = '';
    field.hidden = true;
    openButton.hidden = false;
    openButton.focus(); // keyboard users keep their place in the title row
    setQuery('');
  }

  openButton.addEventListener('click', open); // Enter and Space on the focused button end up here too
  clearButton.addEventListener('click', close);
  input.addEventListener('input', () => setQuery(normalizeSearch(input.value.trim())));
  input.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing) return;
    // Escape only closes the search: it must not also clear the photo selection or leave the full screen handled by the global shortcuts.
    event.preventDefault();
    event.stopPropagation();
    close();
  });

  return { open, close, isOpen: () => !field.hidden };
}
