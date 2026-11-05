// Filtres « Matériel » (appareil photo, objectif) et « Prise de vue » (focale, vitesse, ouverture, ISO, flash) du panneau de filtres.
// Les valeurs viennent des champs déjà chargés avec chaque photo (manufacturer, camera_model, lens_model, focal_length, shutter_speed, aperture,
// iso, flash) : le filtrage se fait dans le frontend comme celui de la date, sans nouvel appel au backend.
//
// Syntaxe des champs numériques : « xxx » (valeur unique), « xxx-yyy » (plage, ordre indifférent), « >xxx » (au moins), « <xxx » (au plus).
// Toutes les bornes sont incluses. Une photo sans la donnée est écartée dès que le critère est actif.
//
// L'état est un objet simple, enregistrable tel quel dans un album intelligent :
//   { gear: { cameras: [{ text, exact }], lenses: [{ text, exact }] }, shot: { focal, shutter, aperture, iso, flash } }
// (une clé absente = critère inactif ; `exact` : valeur choisie dans la liste, sinon recherche « contient »).
import './shooting-filters.css';
import { t } from './i18n.js';

// ---------------------------------------------------------------------------
// Lecture des valeurs numériques saisies ou stockées
// ---------------------------------------------------------------------------

const DECIMAL = /^\d+(?:[.,]\d+)?$/;
const toNumber = text => Number(text.replace(',', '.'));

// Chaque lecteur renvoie un nombre, ou null si le texte n'est pas une valeur valide du champ.
function parseDecimal(text) {
  return DECIMAL.test(text) ? toNumber(text) : null;
}

function parseFocal(text) {
  return parseDecimal(text.replace(/mm$/i, ''));
}

function parseAperture(text) {
  return parseDecimal(text.replace(/^f\/?/i, ''));
}

function parseIso(text) {
  return /^\d+$/.test(text) ? Number(text) : null;
}

// Vitesse d'exposition en secondes : « 1/250 » (sous la seconde, aussi « 10/2500 » tel que stocké) ou « 2 » / « 2.5 » (au-dessus).
function parseShutter(text) {
  const clean = text.replace(/s$/i, '');
  const fraction = /^(\d+(?:[.,]\d+)?)\/(\d+(?:[.,]\d+)?)$/.exec(clean);
  if (fraction) {
    const denominator = toNumber(fraction[2]);
    return denominator > 0 ? toNumber(fraction[1]) / denominator : null;
  }
  return parseDecimal(clean);
}

// « xxx », « xxx-yyy », « >xxx » ou « <xxx » -> { min, max } (bornes incluses), `null` pour un texte vide, `undefined` si la saisie est invalide.
export function parseRange(text, parseValue) {
  const compact = String(text ?? '').replace(/\s+/g, '');
  if (!compact) return null;
  const operator = compact[0] === '>' || compact[0] === '<' ? compact[0] : '';
  const parts = compact.slice(operator.length).split('-');
  const values = parts.map(parseValue);
  if (values.some(value => value === null || Number.isNaN(value))) return undefined;
  if (operator) {
    if (values.length !== 1) return undefined;
    return operator === '>' ? { min: values[0], max: Infinity } : { min: -Infinity, max: values[0] };
  }
  if (values.length === 1) return { min: values[0], max: values[0] };
  if (values.length === 2) return { min: Math.min(...values), max: Math.max(...values) };
  return undefined;
}

// ---------------------------------------------------------------------------
// Champs numériques : lecture dans la photo et comparaison
// ---------------------------------------------------------------------------

const roundTenth = value => Math.round(value * 10) / 10;

// `photoValue` lit la valeur de la photo (null si absente) ; `fits` compare à la plage en tenant compte de la précision du champ :
// la focale est comparée en mm entiers, l'ouverture au dixième, la vitesse avec 0,5 % de tolérance (fractions non réduites, arrondis EXIF).
const RANGE_FIELDS = {
  focal: {
    parse: parseFocal,
    photoValue: photo => { const value = parseFloat(photo.focal_length); return value > 0 ? value : null; },
    fits: (value, range) => Math.round(value) >= range.min && Math.round(value) <= range.max,
    summary: text => `${text} mm`,
  },
  shutter: {
    parse: parseShutter,
    photoValue: photo => { const value = parseShutter(String(photo.shutter_speed || '').replace(/\s+/g, '')); return value > 0 ? value : null; },
    fits: (value, range) => value >= range.min * 0.995 && value <= range.max * 1.005,
    summary: text => `${text} s`,
  },
  aperture: {
    parse: parseAperture,
    photoValue: photo => { const value = parseAperture(String(photo.aperture || '').replace(/\s+/g, '')); return value > 0 ? value : null; },
    fits: (value, range) => roundTenth(value) >= roundTenth(range.min) && roundTenth(value) <= roundTenth(range.max),
    summary: text => `f/${text.replace(/^f\/?/i, '')}`,
  },
  iso: {
    parse: parseIso,
    photoValue: photo => (photo.iso > 0 ? photo.iso : null),
    fits: (value, range) => value >= range.min && value <= range.max,
    summary: text => `ISO ${text}`,
  },
};
const RANGE_KEYS = Object.keys(RANGE_FIELDS);

// Les valeurs d'une photo sont lues une fois, puis gardées sur l'objet photo (comme photoTimeKey pour la date).
function shotValues(photo) {
  if (!photo.shotValues) {
    photo.shotValues = {};
    for (const key of RANGE_KEYS) photo.shotValues[key] = RANGE_FIELDS[key].photoValue(photo);
  }
  return photo.shotValues;
}

// ---------------------------------------------------------------------------
// Matériel
// ---------------------------------------------------------------------------

// Appareil : fabricant + modèle, sans répéter la marque quand le modèle la contient déjà (« Canon » + « Canon EOS R5 » -> « Canon EOS R5 »).
export function cameraLabel(photo) {
  if (photo.cameraLabel === undefined) {
    const make = (photo.manufacturer || '').trim();
    const model = (photo.camera_model || '').trim();
    const brand = make.split(/\s+/)[0].toLowerCase();
    photo.cameraLabel = !model ? make : !make || (brand && model.toLowerCase().startsWith(brand)) ? model : `${make} ${model}`;
  }
  return photo.cameraLabel;
}

export const lensLabel = photo => (photo.lens_model || '').trim();

const GEAR_FIELDS = {
  cameras: { label: cameraLabel, tag: 'Camera' },
  lenses: { label: lensLabel, tag: 'Lens' },
};

// Comparaison souple (entrée `loose`, utilisée par « Trouver le RAW ») : un même objectif s'écrit différemment selon le logiciel
// (« Sony FE 28mm F2 (SEL28F20) » dans un JPEG développé, « FE 28mm F2 » dans le RAW). On compare la « clé » des deux noms : minuscules, sans code entre
// parenthèses, sans marque connue, sans espace ni ponctuation ; l'un doit contenir l'autre.
const GEAR_BRANDS = /\b(sony|canon|nikon|nikkor|sigma|tamron|tokina|zeiss|carl|fujifilm|fujinon|olympus|zuiko|panasonic|lumix|leica|samyang|rokinon|voigtlander|voigtländer)\b/g;
// Les zéros décimaux inutiles tombent aussi (« 24.0-70.0 mm » = « 24-70mm »), sans toucher à « f/2.8 ».
const looseGearKey = text => text.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/(\d)\.0+(?!\d)/g, '$1').replace(GEAR_BRANDS, ' ').replace(/[^\p{L}\p{N}]/gu, '');

function matchesGearEntries(label, entries) {
  if (!label) return false;
  const lower = label.toLowerCase();
  return entries.some(({ text, exact, loose }) => {
    if (loose) {
      const a = looseGearKey(label);
      const b = looseGearKey(text);
      return a !== '' && b !== '' && (a.includes(b) || b.includes(a));
    }
    return exact ? label === text : lower.includes(text.toLowerCase());
  });
}

// ---------------------------------------------------------------------------
// État enregistré -> critères prêts à comparer
// ---------------------------------------------------------------------------

const FLASH_VALUES = ['all', 'with', 'without'];
const compiledStates = new WeakMap();

// Critères d'un état, calculés une fois par objet d'état (les albums comparent des milliers de photos au même état).
function compile(state) {
  let compiled = compiledStates.get(state);
  if (compiled) return compiled;
  compiled = { gear: [], ranges: [], flash: FLASH_VALUES.includes(state.shot?.flash) ? state.shot.flash : 'all' };
  for (const [key, field] of Object.entries(GEAR_FIELDS)) {
    const entries = state.gear?.[key] ?? [];
    if (entries.length) compiled.gear.push({ entries, label: field.label });
  }
  for (const key of RANGE_KEYS) {
    const range = parseRange(state.shot?.[key], RANGE_FIELDS[key].parse);
    if (range) compiled.ranges.push({ key, range });
  }
  compiledStates.set(state, compiled);
  return compiled;
}

// Critères « Trouver le RAW » : l'état (gear et/ou shot) qui retrouve les photos prises avec le même appareil et objectif (`gear`) et les mêmes
// vitesse, ISO et ouverture (`shooting`) que cette photo. Une donnée absente de la photo n'ajoute aucun critère.
export function shootingStateFromPhoto(photo, { gear = false, shooting = false } = {}) {
  const state = {};
  if (gear) {
    const camera = cameraLabel(photo);
    const lens = lensLabel(photo);
    const entries = {};
    if (camera) entries.cameras = [{ text: camera, exact: true }];
    if (lens) entries.lenses = [{ text: lens, exact: false, loose: true }]; // comparaison souple : voir looseGearKey
    if (Object.keys(entries).length) state.gear = entries;
  }
  if (shooting) {
    const shot = {};
    // Même lecture que le filtrage : la valeur est écrite telle que stockée (« 1/250 », « f/2.8 »), le filtre sait la relire.
    for (const key of ['shutter', 'aperture']) {
      if (RANGE_FIELDS[key].photoValue(photo) !== null) shot[key] = String(photo[key === 'shutter' ? 'shutter_speed' : 'aperture']).replace(/\s+/g, '');
    }
    if (RANGE_FIELDS.iso.photoValue(photo) !== null) shot.iso = String(photo.iso);
    if (Object.keys(shot).length) state.shot = shot;
  }
  return state;
}

export function matchesShootingState(photo, state) {
  if (!state.gear && !state.shot) return true;
  const { gear, ranges, flash } = compile(state);
  if (!gear.every(({ entries, label }) => matchesGearEntries(label(photo), entries))) return false;
  if (flash === 'with' && photo.flash !== true) return false;
  if (flash === 'without' && photo.flash !== false) return false;
  if (ranges.length === 0) return true;
  const values = shotValues(photo);
  return ranges.every(({ key, range }) => values[key] !== null && RANGE_FIELDS[key].fits(values[key], range));
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

const byId = id => document.getElementById(id);

/**
 * Branche les contrôles des deux groupes.
 * - getPhotos : photos qui alimentent les listes d'appareils et d'objectifs (celles de la collection, comme pour les mots-clés) ;
 * - onChange : appelé quand un critère change, pour relancer le filtrage (qui rappelle renderSummaries).
 */
export function initShootingFilters({ getPhotos, onChange }) {
  const gear = { cameras: [], lenses: [] };
  const shot = { focal: '', shutter: '', aperture: '', iso: '', flash: 'all' };
  const gearInputs = { cameras: byId('camera-filter-input'), lenses: byId('lens-filter-input') };
  const gearLists = { cameras: byId('camera-options'), lenses: byId('lens-options') };
  const shotInputs = Object.fromEntries(RANGE_KEYS.map(key => [key, byId(`shot-${key}-input`)]));
  const flashSelect = byId('shot-flash-select');
  let optionsSource = null;

  // État courant, calculé une fois par changement : le filtrage le compare à chaque photo (voir matchesShootingState et son cache).
  let cachedState = null;
  const currentState = () => (cachedState ??= capture());
  const changed = () => { cachedState = null; onChange(); };

  // Texte validé de chaque champ numérique (le précédent est conservé tant que la saisie est invalide, comme pour la date).
  const applied = { focal: '', shutter: '', aperture: '', iso: '' };

  const hasGear = () => gear.cameras.length > 0 || gear.lenses.length > 0;
  const hasShot = () => RANGE_KEYS.some(key => applied[key]) || shot.flash !== 'all';

  // --- Listes déroulantes, classées par fréquence décroissante ---
  function refreshOptions() {
    const photos = getPhotos();
    if (optionsSource && optionsSource.photos === photos && optionsSource.length === photos.length) return;
    optionsSource = { photos, length: photos.length };
    for (const [key, field] of Object.entries(GEAR_FIELDS)) {
      const counts = new Map();
      for (const photo of photos) {
        const label = field.label(photo);
        if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      gearLists[key].replaceChildren(...sorted.map(([label, count]) => {
        const option = document.createElement('option');
        option.value = label;
        option.label = String(count);
        return option;
      }));
    }
  }

  // --- Matériel ---
  // Une valeur de la liste donne un filtre exact ; tout autre texte (Entrée ou sortie du champ) un filtre « contient ».
  function addGear(key, value) {
    const text = value.trim();
    gearInputs[key].value = '';
    if (!text) return;
    const known = [...gearLists[key].options].find(option => option.value.toLowerCase() === text.toLowerCase());
    const entry = known ? { text: known.value, exact: true } : { text, exact: false };
    if (gear[key].some(item => item.text.toLowerCase() === entry.text.toLowerCase() && item.exact === entry.exact)) return;
    gear[key].push(entry);
    changed();
  }

  for (const key of Object.keys(gearInputs)) {
    gearInputs[key].addEventListener('change', event => addGear(key, event.target.value));
    gearInputs[key].addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); addGear(key, event.target.value); }
    });
  }

  // --- Prise de vue ---
  function setError(key, message) {
    shotInputs[key].classList.toggle('invalid', Boolean(message));
    shotInputs[key].setAttribute('aria-invalid', message ? 'true' : 'false');
    byId(`shot-${key}-error`).textContent = message;
  }

  // Applique le contenu d'un champ : vide = pas de critère ; saisie invalide = critère précédent conservé et message affiché.
  function applyRangeInput(key) {
    const text = shotInputs[key].value.trim();
    const range = parseRange(text, RANGE_FIELDS[key].parse);
    setError(key, range === undefined ? t('Invalid value') : '');
    if (range === undefined || applied[key] === text) return;
    applied[key] = text;
    changed();
  }

  for (const key of RANGE_KEYS) shotInputs[key].addEventListener('input', () => applyRangeInput(key));
  flashSelect.addEventListener('change', () => {
    shot.flash = FLASH_VALUES.includes(flashSelect.value) ? flashSelect.value : 'all';
    changed();
  });

  // --- État enregistrable (albums intelligents) ---
  function capture() {
    const state = {};
    if (hasGear()) {
      state.gear = {};
      for (const key of Object.keys(gear)) if (gear[key].length) state.gear[key] = gear[key].map(entry => ({ ...entry }));
    }
    if (hasShot()) {
      state.shot = {};
      for (const key of RANGE_KEYS) if (applied[key]) state.shot[key] = applied[key];
      if (shot.flash !== 'all') state.shot.flash = shot.flash;
    }
    return state;
  }

  // Charge un état enregistré dans les contrôles sans relancer le filtrage.
  function apply(state = {}) {
    for (const key of Object.keys(gear)) {
      gear[key] = (state.gear?.[key] ?? []).map(entry => ({ text: String(entry.text), exact: Boolean(entry.exact), ...(entry.loose ? { loose: true } : {}) }));
    }
    for (const key of RANGE_KEYS) {
      applied[key] = String(state.shot?.[key] ?? '');
      shotInputs[key].value = applied[key];
      setError(key, '');
    }
    shot.flash = FLASH_VALUES.includes(state.shot?.flash) ? state.shot.flash : 'all';
    flashSelect.value = shot.flash;
    cachedState = null;
    for (const input of Object.values(gearInputs)) input.value = '';
    renderSummaries();
  }

  const reset = () => apply({});

  // --- Étiquettes : boutons à croix quand le groupe est déplié, simples étiquettes sur la ligne repliée ---
  function gearEntryText(entry) {
    return entry.exact ? entry.text : `~${entry.text}`;
  }

  function renderGearTags() {
    const entries = Object.keys(GEAR_FIELDS).flatMap(key => gear[key].map(entry => ({ key, entry })));
    byId('gear-tags').replaceChildren(...entries.map(({ key, entry }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'filter-tag tag-gear';
      button.textContent = `${gearEntryText(entry)} ×`;
      button.title = t('Remove filter {keyword}', { keyword: entry.text });
      button.addEventListener('click', () => {
        gear[key] = gear[key].filter(item => item !== entry);
        changed();
      });
      return button;
    }));
    byId('gear-summary').replaceChildren(...entries.map(({ key, entry }) => {
      const tag = document.createElement('span');
      tag.className = 'filter-tag tag-gear';
      tag.textContent = gearEntryText(entry);
      tag.title = `${t(GEAR_FIELDS[key].tag)} : ${entry.text}`;
      return tag;
    }));
  }

  function renderShotSummary() {
    const tags = RANGE_KEYS.filter(key => applied[key]).map(key => RANGE_FIELDS[key].summary(applied[key]));
    if (shot.flash !== 'all') tags.push(shot.flash === 'with' ? t('Flash') : t('No flash'));
    byId('shot-summary').replaceChildren(...tags.map(text => {
      const tag = document.createElement('span');
      tag.className = 'filter-tag tag-shot';
      tag.textContent = text;
      return tag;
    }));
  }

  function renderSummaries() {
    refreshOptions();
    renderGearTags();
    renderShotSummary();
  }

  return {
    matches: photo => matchesShootingState(photo, currentState()),
    hasGear, hasShot, capture, apply, reset, refreshOptions, renderSummaries,
  };
}
