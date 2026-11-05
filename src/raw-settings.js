// Paramètres > Divers > RAW : critères de la recherche du RAW qui correspond à une image raster (« Trouver le RAW », voir main.js).
// Chaque utilisateur nomme et range ses RAW et ses JPEG à sa façon : il coche ici ce qui doit correspondre.
//
// Réglages mémorisés localement (clé `rawSearch`), sous la forme :
//   { name, date, gear, shooting: booléens, scope: 'parent' | 'current' | 'children', pattern: texte }
//   - name     : même nom de fichier, sans extension (ou la « clé » extraite par `pattern`, voir extractNameKey) ;
//   - date     : même date et heure de prise de vue (à la seconde) ;
//   - gear     : même appareil photo et même objectif ;
//   - shooting : même vitesse, ISO et ouverture ;
//   - scope    : dossier où commencer la recherche, toujours avec tous ses sous-dossiers :
//                `parent` (parent du dossier de l'image), `current` (son dossier), `children` (les sous-dossiers du dossier de l'image) ;
//   - pattern  : expression régulière appliquée au nom de l'image (vide = inactif).
import './raw-settings.css';
import { t, onLanguageChange } from './i18n.js';

const STORAGE_KEY = 'rawSearch';
const SCOPES = ['parent', 'current', 'children'];
const CRITERIA = ['name', 'date', 'gear', 'shooting'];
const DEFAULTS = { name: true, date: true, gear: true, shooting: true, scope: 'parent', pattern: '' };

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const settings = { ...DEFAULTS };
    for (const key of CRITERIA) if (typeof saved[key] === 'boolean') settings[key] = saved[key];
    if (SCOPES.includes(saved.scope)) settings.scope = saved.scope;
    if (typeof saved.pattern === 'string') settings.pattern = saved.pattern;
    return settings;
  } catch {
    return { ...DEFAULTS };
  }
}

let settings = load();

/** Réglages actuels de la recherche du RAW (copie : le modifier n'a aucun effet). */
export function getRawSearchSettings() {
  return { ...settings };
}

/** Au moins un critère de correspondance est coché (sinon « Trouver le RAW » n'a rien à comparer). */
export function hasRawSearchCriteria() {
  return CRITERIA.some(key => settings[key]);
}

// ---------------------------------------------------------------------------
// Motif du nom
// ---------------------------------------------------------------------------

/** Expression régulière du motif, `null` s'il est vide, `undefined` s'il est invalide. */
export function compileNamePattern(pattern) {
  const text = String(pattern ?? '').trim();
  if (!text) return null;
  try {
    return new RegExp(text, 'i');
  } catch {
    return undefined;
  }
}

/**
 * « Clé » du nom d'une image, celle qu'on retrouve dans le nom du RAW : le premier groupe capturé du motif (ou tout le texte reconnu s'il n'a pas de groupe).
 * Motif vide, invalide ou sans correspondance : le nom entier (`stem`, sans extension) sert de clé.
 */
export function extractNameKey(stem, pattern) {
  const regex = compileNamePattern(pattern);
  if (!regex) return stem;
  const match = regex.exec(stem);
  return match ? (match[1] ?? match[0]) || stem : stem;
}

const stemOf = fileName => fileName.replace(/\.[^./\\]*$/, '');

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

const byId = id => document.getElementById(id);

export function initRawSettings() {
  const checkboxes = Object.fromEntries(CRITERIA.map(key => [key, byId(`raw-match-${key}`)]));
  const patternInput = byId('raw-name-pattern');
  const testInput = byId('raw-pattern-test');
  const result = byId('raw-pattern-result');
  const scopeButtons = [...document.querySelectorAll('#raw-scope .location-filter-option')];

  const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));

  // Le motif ne sert que si le nom fait partie des critères.
  function updatePatternAvailability() {
    for (const input of [patternInput, testInput]) input.disabled = !settings.name;
    result.hidden = !settings.name;
  }

  // Résultat du test : la clé que le motif tire du nom saisi, ou la raison pour laquelle il ne sert à rien.
  function renderTestResult() {
    const regex = compileNamePattern(patternInput.value);
    patternInput.classList.toggle('invalid', regex === undefined);
    patternInput.setAttribute('aria-invalid', regex === undefined ? 'true' : 'false');
    result.classList.toggle('raw-pattern-error', regex === undefined);
    if (regex === undefined) result.textContent = t('Invalid pattern');
    else if (regex === null) result.textContent = t('No pattern: the whole name without extension is compared');
    else if (!testInput.value.trim()) result.textContent = t('Type a file name to test the pattern');
    else {
      const stem = stemOf(testInput.value.trim());
      const match = regex.exec(stem);
      result.textContent = match
        ? t('Key extracted: {key}', { key: (match[1] ?? match[0]) || stem })
        : t('No match: the whole name without extension is compared');
    }
  }

  for (const key of CRITERIA) {
    checkboxes[key].checked = settings[key];
    checkboxes[key].addEventListener('change', () => {
      settings[key] = checkboxes[key].checked;
      save();
      updatePatternAvailability();
    });
  }

  patternInput.value = settings.pattern;
  patternInput.addEventListener('input', () => {
    // Un motif invalide n'est pas enregistré : le dernier motif valide reste actif.
    if (compileNamePattern(patternInput.value) !== undefined) {
      settings.pattern = patternInput.value.trim();
      save();
    }
    renderTestResult();
  });
  testInput.addEventListener('input', renderTestResult);

  // Trois boutons formant un bloc, un seul actif à la fois (même mécanique que le filtre Lieu).
  const showScope = () => {
    for (const button of scopeButtons) button.setAttribute('aria-checked', String(button.dataset.value === settings.scope));
  };
  for (const button of scopeButtons) {
    button.addEventListener('click', () => {
      settings.scope = button.dataset.value;
      save();
      showScope();
    });
  }
  showScope();

  updatePatternAvailability();
  renderTestResult();
  onLanguageChange(renderTestResult);
}
