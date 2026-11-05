// Filtre « Format » du panneau de filtres : type de fichier (RAW, Raster, Vidéo), marque de RAW (« RAW Sony (ARW) ») ou extension (« .JPG »).
// Le filtrage se fait dans le frontend sur l'extension du chemin, comme les autres filtres : aucun appel au backend.
//
// Plusieurs étiquettes s'additionnent en OU (un fichier n'est jamais à la fois RAW et Raster, ni .ARW et .CR3) ; ce filtre se combine en ET avec tous les autres.
//
// L'état est une liste d'identifiants, enregistrable tel quel dans un album intelligent :
//   { formats: ['raw', 'brand:sony', 'ext:jpg'] }   (clé absente = critère inactif)
import './format-filters.css';
import { t } from './i18n.js';

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

// Extensions retenues par une liste d'identifiants (union), calculées une fois par objet d'état.
const compiledStates = new WeakMap();
function compile(state) {
  let compiled = compiledStates.get(state);
  if (!compiled) {
    const wanted = new Set(state.formats);
    compiled = new Set();
    // Le catalogue sert ici uniquement pour ses extensions : sa langue n'a pas d'importance.
    for (const entry of buildCatalog()) if (wanted.has(entry.id)) for (const extension of entry.extensions) compiled.add(extension);
    compiledStates.set(state, compiled);
  }
  return compiled;
}

export function matchesFormatState(photo, state) {
  if (!state.formats?.length) return true;
  return compile(state).has(extensionOf(photo));
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

const byId = id => document.getElementById(id);

/**
 * Branche les contrôles du groupe Format.
 * - onChange : appelé quand une étiquette est ajoutée ou retirée, pour relancer le filtrage.
 */
export function initFormatFilters({ onChange }) {
  const input = byId('format-filter-input');
  const list = byId('format-options');
  const error = byId('format-error');
  let selected = []; // identifiants, dans l'ordre d'ajout
  let catalog = buildCatalog();

  // État courant, calculé une fois par changement (le filtrage le compare à chaque photo).
  let cachedState = null;
  const currentState = () => (cachedState ??= capture());
  const changed = () => { cachedState = null; renderSummaries(); onChange(); };

  const labelOf = id => catalog.find(entry => entry.id === id)?.label ?? id;

  function refreshOptions() {
    catalog = buildCatalog();
    list.replaceChildren(...catalog.map(entry => {
      const option = document.createElement('option');
      option.value = entry.label;
      return option;
    }));
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

  // `report` : Entrée, la saisie est finie, on signale ce qu'on ne comprend pas ; à la sortie du champ on laisse le texte tel quel.
  function addFromInput({ report }) {
    const text = input.value;
    if (!text.trim()) { setError(''); return; }
    const entry = resolve(text);
    if (!entry) {
      if (report) setError(t('Unknown format'));
      return;
    }
    input.value = '';
    setError('');
    if (selected.includes(entry.id)) return;
    selected.push(entry.id);
    changed();
  }

  input.addEventListener('change', () => addFromInput({ report: false }));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); addFromInput({ report: true }); }
  });
  input.addEventListener('input', () => setError(''));

  // --- État enregistrable (albums intelligents) ---
  function capture() {
    return selected.length ? { formats: [...selected] } : {};
  }

  // Charge un état enregistré dans les contrôles sans relancer le filtrage. Les identifiants inconnus sont ignorés.
  function apply(state = {}) {
    const known = new Set(buildCatalog().map(entry => entry.id));
    selected = (Array.isArray(state.formats) ? state.formats : []).filter(id => known.has(id));
    cachedState = null;
    input.value = '';
    setError('');
    renderSummaries();
  }

  const reset = () => apply({});

  // --- Étiquettes : boutons à croix quand le groupe est déplié, simples étiquettes sur la ligne repliée ---
  function renderSummaries() {
    refreshOptions();
    byId('format-tags').replaceChildren(...selected.map(id => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'filter-tag tag-format';
      button.textContent = `${labelOf(id)} ×`;
      button.title = t('Remove filter {keyword}', { keyword: labelOf(id) });
      button.addEventListener('click', () => {
        selected = selected.filter(item => item !== id);
        changed();
      });
      return button;
    }));
    byId('format-summary').replaceChildren(...selected.map(id => {
      const tag = document.createElement('span');
      tag.className = 'filter-tag tag-format';
      tag.textContent = labelOf(id);
      return tag;
    }));
  }

  refreshOptions();

  return {
    matches: photo => matchesFormatState(photo, currentState()),
    hasFormats: () => selected.length > 0,
    capture, apply, reset, renderSummaries,
  };
}
