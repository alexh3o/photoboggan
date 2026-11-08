// Filtre « Format » du panneau de filtres : type de fichier (RAW, Raster, Vidéo), marque de RAW (« RAW Sony (ARW) ») ou extension (« .JPG »).
// Le filtrage se fait dans le frontend sur l'extension du chemin, comme les autres filtres : aucun appel au backend.
//
// Plusieurs étiquettes s'additionnent en OU (un fichier n'est jamais à la fois RAW et Raster, ni .ARW et .CR3) ; ce filtre se combine en ET avec tous les autres.
//
// L'état est une liste d'identifiants, enregistrable tel quel dans un album intelligent :
//   { formats: ['raw', 'brand:sony', 'ext:jpg'], excludedFormats: ['ext:dng'] }   (clé absente = critère inactif)
// Excluded formats (Alt+Enter / Alt+click, or the chip's context menu): a file of one of them is left out, whatever the included ones.
import './format-filters.css';
import { t, normalizeSearch } from './i18n.js';
import { createFilterTag, addIncludeExcludeMenu } from './filter-tags.js';
import { createFilterSuggest } from './filter-suggest.js';

// ---------------------------------------------------------------------------
// Extensions connues (source unique pour le frontend ; la liste Rust est dans thumbnails.rs / video.rs)
// ---------------------------------------------------------------------------

// RAW : jamais dématricés, on affiche le JPEG intégré.
export const RAW_EXTENSIONS = new Set(['arw', 'cr2', 'cr3', 'nef', 'nrw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'raw']);
// HEIC / HEIF : le webview ne sait pas les afficher, le backend en fait un JPEG.
export const HEIF_EXTENSIONS = new Set(['heic', 'heif', 'hif']);
// Vidéos : miniature fixe uniquement (liste alignée sur video.rs).
export const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv']);
// Images « raster » : tout ce qui n'est ni RAW ni vidéo.
export const RASTER_EXTENSIONS = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'avif', 'gif', 'bmp', ...HEIF_EXTENSIONS]);

// Marques de RAW proposées dans la liste : taper « sony » propose « RAW Sony (ARW) ». `raw` seul reste sélectionnable comme extension.
const RAW_BRANDS = [
  { id: 'sony', name: 'Sony', extensions: ['arw'] },
  { id: 'canon', name: 'Canon', extensions: ['cr2', 'cr3'] },
  { id: 'nikon', name: 'Nikon', extensions: ['nef', 'nrw'] },
  { id: 'fujifilm', name: 'Fujifilm', extensions: ['raf'] },
  { id: 'olympus', name: 'Olympus / OM System', extensions: ['orf'] },
  { id: 'panasonic', name: 'Panasonic', extensions: ['rw2'] },
  { id: 'pentax', name: 'Pentax', extensions: ['pef'] },
  { id: 'dng', name: 'Adobe DNG', extensions: ['dng'] },
];

// ---------------------------------------------------------------------------
// Catalogue des étiquettes possibles : id -> { label affiché, extensions, mots qui la désignent à la saisie }
// ---------------------------------------------------------------------------

const upper = list => list.map(extension => extension.toUpperCase()).join(', ');

// Les libellés dépendent de la langue : le catalogue est reconstruit à chaque ouverture de la liste (voir refreshOptions).
function buildCatalog() {
  const entries = [
    { id: 'raw', label: 'RAW', extensions: RAW_EXTENSIONS, keys: ['raw'] },
    { id: 'raster', label: t('Raster'), extensions: RASTER_EXTENSIONS, keys: ['raster'] },
    { id: 'video', label: t('Video'), extensions: VIDEO_EXTENSIONS, keys: ['video', 'vidéo'] },
  ];
  for (const brand of RAW_BRANDS) {
    entries.push({ id: `brand:${brand.id}`, label: `RAW ${brand.name} (${upper(brand.extensions)})`, extensions: new Set(brand.extensions), keys: [brand.id, brand.name.toLowerCase()] });
  }
  for (const extension of [...RASTER_EXTENSIONS, ...VIDEO_EXTENSIONS, ...RAW_EXTENSIONS]) {
    entries.push({ id: `ext:${extension}`, label: `.${extension.toUpperCase()}`, extensions: new Set([extension]), keys: [extension, `.${extension}`] });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Comparaison
// ---------------------------------------------------------------------------

const extensionOf = photo => {
  if (photo.fileExtension === undefined) {
    const path = photo.path || '';
    const dot = path.lastIndexOf('.');
    photo.fileExtension = dot > path.lastIndexOf('/') && dot > path.lastIndexOf('\\') ? path.slice(dot + 1).toLowerCase() : '';
  }
  return photo.fileExtension;
};

// Extensions of a list of identifiers (union). The catalogue is only used for its extensions here: its language does not matter.
function extensionsOf(ids) {
  const wanted = new Set(ids);
  const extensions = new Set();
  for (const entry of buildCatalog()) if (wanted.has(entry.id)) for (const extension of entry.extensions) extensions.add(extension);
  return extensions;
}

// Included and excluded extensions of a state, computed once per state object.
const compiledStates = new WeakMap();
function compile(state) {
  let compiled = compiledStates.get(state);
  if (!compiled) {
    compiled = { included: extensionsOf(state.formats ?? []), excluded: extensionsOf(state.excludedFormats ?? []) };
    compiledStates.set(state, compiled);
  }
  return compiled;
}

// Accepted extensions of a state, for the backend prefilter (`PhotoPrefilter` in db.rs); null when the state accepts every format.
// Excluded formats are left to the interface: the prefilter stays a superset.
export function formatPrefilterExtensions(state) {
  return state.formats?.length ? [...compile(state).included].sort() : null;
}

export function matchesFormatState(photo, state) {
  if (!state.formats?.length && !state.excludedFormats?.length) return true;
  const { included, excluded } = compile(state);
  const extension = extensionOf(photo);
  return (!state.formats?.length || included.has(extension)) && !excluded.has(extension);
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

const byId = id => document.getElementById(id);

/**
 * Branche les contrôles du groupe Format.
 * - getPhotos : photos whose extensions give the counts of the suggestion list (the collection, as for keywords);
 * - onChange : appelé quand une étiquette est ajoutée ou retirée, pour relancer le filtrage.
 */
export function initFormatFilters({ getPhotos = () => [], onChange }) {
  const input = byId('format-filter-input');
  const list = byId('format-filter-suggestions');
  const error = byId('format-error');
  let selected = []; // included identifiers, in the order they were added
  let excluded = []; // excluded identifiers (Alt+Enter / Alt+click, or the chip's context menu); never in both lists
  let catalog = buildCatalog();

  // État courant, calculé une fois par changement (le filtrage le compare à chaque photo).
  let cachedState = null;
  const currentState = () => (cachedState ??= capture());
  const changed = () => { cachedState = null; renderSummaries(); onChange(); };

  const labelOf = id => catalog.find(entry => entry.id === id)?.label ?? id;
  const tagText = (id, isExcluded) => `${isExcluded ? '-' : ''}${labelOf(id)}`;

  // Photo count per extension, recomputed only when the collection changed (read when the list opens).
  let countSource = null;
  let extensionCounts = new Map();
  function countsByExtension() {
    const photos = getPhotos();
    if (!countSource || countSource.photos !== photos || countSource.length !== photos.length) {
      countSource = { photos, length: photos.length };
      extensionCounts = new Map();
      for (const photo of photos) {
        const extension = extensionOf(photo);
        if (extension) extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
      }
    }
    return extensionCounts;
  }

  // Suggestions: catalogue entries present in the collection and not already in the filter, searched by label and by the words that
  // designate them (« sony », « jpg », « vidéo »). An entry with no photo is not offered, but its word still works with Enter.
  function formatOptions() {
    const counts = countsByExtension();
    return catalog
      .filter(entry => !selected.includes(entry.id) && !excluded.includes(entry.id))
      .map(entry => ({
        value: entry.id,
        label: entry.label,
        count: [...entry.extensions].reduce((sum, extension) => sum + (counts.get(extension) ?? 0), 0),
        search: normalizeSearch([entry.label, ...entry.keys].join(' ')),
      }))
      .filter(option => option.count > 0);
  }

  function refreshOptions() {
    catalog = buildCatalog(); // labels follow the language
  }

  function setError(message) {
    input.classList.toggle('invalid', Boolean(message));
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    error.textContent = message;
  }

  // Texte saisi -> étiquette : libellé exact de la liste, sinon un mot qui la désigne exactement (« sony », « jpg », « .cr3 », « vidéo »).
  function resolve(text) {
    const lower = text.trim().toLowerCase();
    if (!lower) return null;
    return catalog.find(entry => entry.label.toLowerCase() === lower) ?? catalog.find(entry => entry.keys.includes(lower)) ?? null;
  }

  // Puts an identifier in the included or excluded list (and out of the other one), then filters again.
  function setFormat(id, exclude) {
    if ((exclude ? excluded : selected).includes(id)) return;
    selected = selected.filter(item => item !== id);
    excluded = excluded.filter(item => item !== id);
    (exclude ? excluded : selected).push(id);
    changed();
  }

  // Enter with no suggestion: the typed text must designate an entry exactly, otherwise it stays in the field with a message.
  function addFromText(text, exclude) {
    const entry = resolve(text);
    if (!entry) {
      input.value = text;
      setError(t('Unknown format'));
      return;
    }
    setError('');
    setFormat(entry.id, exclude);
  }

  const suggest = createFilterSuggest({
    input,
    list,
    getOptions: formatOptions,
    onPick: (id, exclude, text) => {
      if (id === null) { addFromText(text, exclude); return; }
      setError('');
      setFormat(id, exclude);
    },
    emptyText: 'No matching format',
  });
  input.addEventListener('input', () => setError(''));

  // --- État enregistrable (albums intelligents) ---
  function capture() {
    const state = {};
    if (selected.length) state.formats = [...selected];
    if (excluded.length) state.excludedFormats = [...excluded];
    return state;
  }

  // Charge un état enregistré dans les contrôles sans relancer le filtrage. Les identifiants inconnus sont ignorés.
  function apply(state = {}) {
    const known = new Set(buildCatalog().map(entry => entry.id));
    selected = (Array.isArray(state.formats) ? state.formats : []).filter(id => known.has(id));
    excluded = (Array.isArray(state.excludedFormats) ? state.excludedFormats : []).filter(id => known.has(id) && !selected.includes(id));
    cachedState = null;
    input.value = '';
    setError('');
    renderSummaries();
  }

  const reset = () => apply({});

  // --- Étiquettes : boutons à croix quand le groupe est déplié, simples étiquettes sur la ligne repliée ---
  // Excluded format: text starting with "-" (violet chip); a right-click on a chip switches it between "include" and "exclude".
  function renderSummaries() {
    refreshOptions();
    const entries = [...selected.map(id => ({ id, isExcluded: false })), ...excluded.map(id => ({ id, isExcluded: true }))];
    const remove = ({ id, isExcluded }) => {
      if (isExcluded) excluded = excluded.filter(item => item !== id);
      else selected = selected.filter(item => item !== id);
      changed();
    };
    const addMenu = (node, { id, isExcluded }) => addIncludeExcludeMenu(node, {
      label: tagText(id, isExcluded),
      excluded: isExcluded,
      onToggle: () => setFormat(id, !isExcluded),
    });
    byId('format-tags').replaceChildren(...entries.map(entry => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'filter-tag tag-format';
      button.textContent = `${tagText(entry.id, entry.isExcluded)} ×`;
      button.title = t('Remove filter {keyword}', { keyword: tagText(entry.id, entry.isExcluded) });
      button.addEventListener('click', () => remove(entry));
      addMenu(button, entry);
      return button;
    }));
    byId('format-summary').replaceChildren(...entries.map(entry => {
      const tag = createFilterTag({ kind: 'format', text: tagText(entry.id, entry.isExcluded), onRemove: () => remove(entry) });
      addMenu(tag, entry);
      return tag;
    }));
    suggest.refresh();
  }

  return {
    matches: photo => matchesFormatState(photo, currentState()),
    hasFormats: () => selected.length > 0 || excluded.length > 0,
    capture, apply, reset, renderSummaries,
  };
}
