// Filtre « Auteur » du groupe « Plus de filtres » : les auteurs des photos (champ Auteur des métadonnées, voir rights.rs et exif::AUTHOR_SOURCE_IDS).
// La liste proposée vient de la base (commande get_authors : les auteurs existants et le nombre de leurs photos) ; le filtrage se fait dans le
// frontend sur le champ `author` de chaque photo (plusieurs auteurs : « A; B »), casse ignorée.
//
// Plusieurs auteurs choisis s'additionnent en ET (la photo doit les porter tous), comme les mots-clés ; Alt+Entrée / Alt+clic (ou le menu de
// l'étiquette) en exclut un. L'état est enregistrable tel quel dans un album intelligent :
//   { authors: ['Ada Lovelace'], excludedAuthors: ['Bob'] }   (clé absente = critère inactif)
import './author-filters.css';
import { invoke } from '@tauri-apps/api/core';
import { t, normalizeSearch } from './i18n.js';
import { createFilterTag, addIncludeExcludeMenu } from './filter-tags.js';
import { createFilterSuggest } from './filter-suggest.js';

// Mêmes règles que le backend (exif.rs, split_authors) : séparés par « ; », espaces de début et de fin retirés, entrées vides écartées.
export const splitAuthors = text => String(text ?? '').split(';').map(name => name.trim()).filter(Boolean);

const keyOf = name => name.trim().toLowerCase();

// Auteurs d'une photo (clés en minuscules), calculés une fois par valeur du champ (qui change quand une écriture met la photo à jour).
function authorKeysOf(photo) {
  if (photo.authorKeysSource !== photo.author) {
    photo.authorKeysSource = photo.author;
    photo.authorKeys = new Set(splitAuthors(photo.author).map(keyOf));
  }
  return photo.authorKeys;
}

export function matchesAuthorState(photo, state) {
  const included = state.authors ?? [];
  const excluded = state.excludedAuthors ?? [];
  if (!included.length && !excluded.length) return true;
  const keys = authorKeysOf(photo);
  return included.every(name => keys.has(keyOf(name))) && !excluded.some(name => keys.has(keyOf(name)));
}

// Auteurs à inclure dans le préfiltre du backend (`PhotoPrefilter.authors`, db.rs) : minuscules, ASCII seulement (le `lower` de SQLite ignore le
// reste). Les noms exclus et ceux qui ne sont pas en ASCII restent au filtrage de l'interface : le préfiltre est un sur-ensemble.
export function authorPrefilter(state) {
  const names = (state.authors ?? []).map(name => keyOf(name)).filter(name => name && /^[\x20-\x7e]+$/.test(name));
  return names.length ? { authors: names.sort() } : {};
}

const byId = id => document.getElementById(id);

/**
 * Branche les contrôles du filtre Auteur.
 * - onChange : appelé quand une étiquette est ajoutée ou retirée, pour relancer le filtrage.
 */
export function initAuthorFilters({ onChange }) {
  const input = byId('author-filter-input');
  const list = byId('author-filter-suggestions');
  const error = byId('author-error');
  let selected = []; // auteurs inclus, dans l'ordre d'ajout
  let excluded = []; // auteurs exclus ; jamais dans les deux listes
  let known = []; // [{ name, count }] : auteurs de la base

  let cachedState = null;
  const currentState = () => (cachedState ??= capture());
  const changed = () => { cachedState = null; renderSummaries(); onChange(); };

  const isChosen = name => [...selected, ...excluded].some(item => keyOf(item) === keyOf(name));
  const tagText = (name, isExcluded) => `${isExcluded ? '-' : ''}${name}`;

  // Auteurs de la base : relus quand la collection a pu changer (scan, écriture de métadonnées, ensemble de confidentialité).
  let loadToken = 0;
  async function refreshAuthors() {
    const token = ++loadToken;
    try {
      const authors = await invoke('get_authors');
      if (token === loadToken) { known = authors; suggest.refresh(); }
    } catch (failure) {
      console.error('Liste des auteurs indisponible', failure);
    }
  }

  const authorOptions = () => known
    .filter(author => !isChosen(author.name))
    .map(author => ({ value: author.name, label: author.name, count: author.count, search: normalizeSearch(author.name) }));

  function setError(message) {
    input.classList.toggle('invalid', Boolean(message));
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    error.textContent = message;
  }

  // Met un auteur dans la liste incluse ou exclue (et hors de l'autre), puis relance le filtrage.
  function setAuthor(name, exclude) {
    const key = keyOf(name);
    if ((exclude ? excluded : selected).some(item => keyOf(item) === key)) return;
    selected = selected.filter(item => keyOf(item) !== key);
    excluded = excluded.filter(item => keyOf(item) !== key);
    (exclude ? excluded : selected).push(name);
    changed();
  }

  // Entrée sans suggestion : le texte doit désigner exactement un auteur de la base, sinon il reste dans le champ avec un message.
  function addFromText(text, exclude) {
    const match = known.find(author => keyOf(author.name) === keyOf(text));
    if (!match) {
      input.value = text;
      setError(t('Unknown author'));
      return;
    }
    setError('');
    setAuthor(match.name, exclude);
  }

  const suggest = createFilterSuggest({
    input,
    list,
    getOptions: authorOptions,
    onPick: (name, exclude, text) => {
      if (name === null) { addFromText(text, exclude); return; }
      setError('');
      setAuthor(name, exclude);
    },
    emptyText: 'No matching author',
  });
  input.addEventListener('input', () => setError(''));

  // --- État enregistrable (albums intelligents) ---
  function capture() {
    const state = {};
    if (selected.length) state.authors = [...selected];
    if (excluded.length) state.excludedAuthors = [...excluded];
    return state;
  }

  // Charge un état enregistré dans les contrôles sans relancer le filtrage.
  function apply(state = {}) {
    selected = (Array.isArray(state.authors) ? state.authors : []).filter(name => typeof name === 'string' && name.trim());
    excluded = (Array.isArray(state.excludedAuthors) ? state.excludedAuthors : [])
      .filter(name => typeof name === 'string' && name.trim() && !selected.some(item => keyOf(item) === keyOf(name)));
    cachedState = null;
    input.value = '';
    setError('');
    renderSummaries();
  }

  const reset = () => apply({});

  // --- Étiquettes : boutons à croix quand le groupe est déplié, simples étiquettes sur la ligne repliée ---
  function renderSummaries() {
    const entries = [...selected.map(name => ({ name, isExcluded: false })), ...excluded.map(name => ({ name, isExcluded: true }))];
    const remove = ({ name, isExcluded }) => {
      if (isExcluded) excluded = excluded.filter(item => item !== name);
      else selected = selected.filter(item => item !== name);
      changed();
    };
    const addMenu = (node, { name, isExcluded }) => addIncludeExcludeMenu(node, {
      label: tagText(name, isExcluded),
      excluded: isExcluded,
      onToggle: () => setAuthor(name, !isExcluded),
    });
    byId('author-tags').replaceChildren(...entries.map(entry => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'filter-tag tag-author';
      button.textContent = `${tagText(entry.name, entry.isExcluded)} ×`;
      button.title = t('Remove filter {keyword}', { keyword: tagText(entry.name, entry.isExcluded) });
      button.addEventListener('click', () => remove(entry));
      addMenu(button, entry);
      return button;
    }));
    byId('author-summary').replaceChildren(...entries.map(entry => {
      const tag = createFilterTag({ kind: 'author', text: tagText(entry.name, entry.isExcluded), onRemove: () => remove(entry) });
      addMenu(tag, entry);
      return tag;
    }));
    suggest.refresh();
  }

  refreshAuthors();
  return {
    matches: photo => matchesAuthorState(photo, currentState()),
    hasAuthors: () => selected.length > 0 || excluded.length > 0,
    prefilter: authorPrefilter,
    capture, apply, reset, renderSummaries, refreshAuthors,
  };
}
