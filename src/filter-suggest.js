// Suggestion list of a filter field (keywords, people): same look and keys as the quick keyword input of the keyword panel (keywords-panel.js,
// keywords.css), opened below the field. Entries whose text contains the typed text (accents and case ignored), most used first and
// highlighted, nearest the field. Up / Down move the highlight, Enter or a click validates it (Alt+Enter / Alt+click: exclude instead),
// Escape closes the list.
import { t, normalizeSearch } from './i18n.js';

const MAX_SUGGESTIONS = 200;

/**
 * Wires a suggestion list to a filter field.
 * - input, list: the field and its `<ul class="keyword-suggestions below">`;
 * - getOptions(): offered entries, [{ value, label, count, search }] (`search`: text already passed through normalizeSearch);
 * - onPick(value, exclude): an entry was validated (value null: Enter with no suggestion, `text` holds what was typed);
 * - emptyText: i18n key shown when nothing matches.
 * Returns { refresh, close }: `refresh` recomputes an open list after the offered entries changed.
 */
export function createFilterSuggest({ input, list, getOptions, onPick, emptyText }) {
  let matches = [];
  let highlighted = 0;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  if (list.id) input.setAttribute('aria-controls', list.id);

  const close = () => {
    matches = [];
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };

  function render() {
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (matches.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'keyword-suggestion-empty';
      empty.textContent = t(emptyText);
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...matches.map((option, index) => {
      const row = document.createElement('li');
      row.className = 'keyword-suggestion';
      row.setAttribute('role', 'option');
      row.classList.toggle('highlighted', index === highlighted);
      row.setAttribute('aria-selected', String(index === highlighted));
      const label = document.createElement('span');
      label.textContent = option.label;
      const count = document.createElement('span');
      count.className = 'keyword-suggestion-count';
      count.textContent = String(option.count);
      row.append(label, count);
      // mousedown rather than click: the field keeps the focus (otherwise the list would close before the click).
      row.addEventListener('mousedown', event => {
        event.preventDefault();
        validate(index, event.altKey);
      });
      return row;
    }));
    list.querySelector('.highlighted')?.scrollIntoView({ block: 'nearest' });
  }

  function update() {
    const query = normalizeSearch(input.value.trim());
    if (!query) { close(); return; }
    matches = getOptions()
      .filter(option => option.search.includes(query))
      .sort((a, b) => b.count - a.count || a.search.localeCompare(b.search))
      .slice(0, MAX_SUGGESTIONS);
    highlighted = 0;
    render();
    list.scrollTop = 0;
  }

  function validate(index, exclude) {
    const text = input.value;
    const option = matches[index];
    if (!option && !text.trim()) return;
    close();
    input.value = '';
    onPick(option ? option.value : null, exclude, text);
    input.focus();
  }

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', event => {
    const open = !list.hidden && matches.length > 0;
    if (event.key === 'ArrowDown' && open) {
      event.preventDefault();
      highlighted = Math.min(highlighted + 1, matches.length - 1);
      render();
    } else if (event.key === 'ArrowUp' && open) {
      event.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
      render();
    } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      validate(open ? highlighted : -1, event.altKey);
    } else if (event.key === 'Escape' && !list.hidden) {
      event.stopPropagation();
      close();
    }
  });

  return {
    refresh() {
      if (!list.hidden && document.activeElement === input) update();
    },
    close,
  };
}
