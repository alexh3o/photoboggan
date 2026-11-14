// Photos privées : ensembles de confidentialité dont les photos restent masquées (le masquage lui-même est fait côté Rust, voir privacy.rs).
//
// Un ensemble = un nom + des critères, tous insensibles à la casse (une photo est masquée dès qu'elle répond à UN critère de l'un des ensembles actifs) :
//   - paths    : parties de chemin de dossier, [{ text, partial }] (complet : élément de dossier entier ; partiel : sous-chaîne, affiché « ~texte ») ;
//   - keywords : mots-clés, correspondance exacte ;
//   - dateRanges : plages de dates inclusives, [{ text, start, end }] (`start` / `end` : AAAAMMJJHHmmss, texte saisi gardé pour l'affichage).
//
// Réglages mémorisés localement : `privacyEnabled` (fonction activée), `privacyLock` (verrou : le bouclier ne change plus d'ensemble, seuls les
// paramètres le permettent), `privacySets` (JSON des ensembles), `privacyActive` (JSON des identifiants des ensembles actifs).
// Plusieurs ensembles peuvent être actifs : leurs critères se cumulent. Le backend reçoit les ensembles actifs au démarrage et à chaque changement
// (`set_privacy_sets`) ; main.js recharge ses vues à chaque changement (`onPrivacyChange`).
import './privacy.css';
import { invoke } from '@tauri-apps/api/core';
import { t, onLanguageChange } from './i18n.js';
import { readBool, readStored, writeStored } from './settings-defaults.js';
import { createFilterTag } from './filter-tags.js';
import { openContextMenuAt, confirmDialog } from './photo-actions.js';

const KEYS = { enabled: 'privacyEnabled', lock: 'privacyLock', sets: 'privacySets', active: 'privacyActive' };
const NEW_SET = '__new';

// ---------------------------------------------------------------------------
// Dates : même saisie que le filtre de date (AAAA … AAAAMMJJHHmmss, « début-fin »)
// ---------------------------------------------------------------------------

const DATE_TOKEN = '(\\d{4}|\\d{6}|\\d{8}|\\d{10}|\\d{12}|\\d{14})';

/** Période couverte par une date incomplète, au format AAAAMMJJHHmmss (« 2024 » : de 20240101000000 à 20241231235959), ou null si elle n'existe pas. */
function periodOf(token) {
  const part = (from, to) => (token.length >= to ? Number(token.slice(from, to)) : null);
  const year = Number(token.slice(0, 4));
  const [month, day, hour, minute, second] = [part(4, 6), part(6, 8), part(8, 10), part(10, 12), part(12, 14)];
  if (month !== null && (month < 1 || month > 12)) return null;
  const lastDay = new Date(year, month ?? 12, 0).getDate();
  if (day !== null && (day < 1 || day > lastDay)) return null;
  if ((hour !== null && hour > 23) || (minute !== null && minute > 59) || (second !== null && second > 59)) return null;
  const two = value => String(value).padStart(2, '0');
  const build = (m, d, h, mi, s) => `${String(year).padStart(4, '0')}${two(m)}${two(d)}${two(h)}${two(mi)}${two(s)}`;
  return {
    start: build(month ?? 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0),
    end: build(month ?? 12, day ?? lastDay, hour ?? 23, minute ?? 59, second ?? 59),
  };
}

/** Plage de dates saisie : { text, start, end } (bornes incluses, AAAAMMJJHHmmss), ou null si le texte n'est pas valide. */
export function parseDateRange(text) {
  const compact = String(text).replace(/\s+/g, '');
  const match = new RegExp(`^${DATE_TOKEN}(?:-${DATE_TOKEN})?$`).exec(compact);
  if (!match) return null;
  const first = periodOf(match[1]);
  const last = match[2] ? periodOf(match[2]) : first;
  if (!first || !last || first.start > last.end) return null;
  return { text: compact, start: first.start, end: last.end };
}

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

const keyOf = text => String(text).trim().toLowerCase();
const cleanPath = text => String(text).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

function cleanSet(raw) {
  if (!raw || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    paths: (Array.isArray(raw.paths) ? raw.paths : [])
      .filter(item => item && typeof item.text === 'string' && cleanPath(item.text))
      .map(item => ({ text: cleanPath(item.text), partial: item.partial === true })),
    keywords: (Array.isArray(raw.keywords) ? raw.keywords : []).filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()),
    dateRanges: (Array.isArray(raw.dateRanges) ? raw.dateRanges : [])
      .filter(item => item && typeof item.start === 'string' && typeof item.end === 'string')
      .map(item => ({ text: String(item.text ?? ''), start: item.start, end: item.end })),
  };
}

function readJson(key) {
  try { return JSON.parse(readStored(key) ?? 'null'); } catch { return null; }
}

let enabled = readBool(KEYS.enabled);
let locked = readBool(KEYS.lock);
let sets = (Array.isArray(readJson(KEYS.sets)) ? readJson(KEYS.sets) : []).map(cleanSet).filter(Boolean);
let activeIds = new Set((Array.isArray(readJson(KEYS.active)) ? readJson(KEYS.active) : []).filter(id => typeof id === 'string'));
let hiddenKeys = null; // cache des mots-clés masqués
let selectedId = sets[0]?.id ?? null; // ensemble ouvert dans les paramètres
const listeners = new Set();

const saveSets = () => writeStored(KEYS.sets, JSON.stringify(sets));
const saveActive = () => writeStored(KEYS.active, JSON.stringify([...activeIds]));

/** La fonction est activée dans les paramètres. */
export const isPrivacyEnabled = () => enabled;
/** Le verrou est actif (fonction activée et verrou coché) : le bouclier ne change plus d'ensemble. */
export const isPrivacyLocked = () => enabled && locked;
/** Ensembles actifs (aucun si la fonction est désactivée). */
export const activeSets = () => (enabled ? sets.filter(set => activeIds.has(set.id)) : []);
/** Au moins un ensemble est actif : des photos peuvent être masquées (et les dossiers ne se suppriment plus). */
export const hasActivePrivacy = () => activeSets().length > 0;

/** Clés (minuscules) des mots-clés des ensembles actifs : à retirer des listes de filtres de mots-clés (pas des panneaux de saisie). */
export function hiddenKeywordKeys() {
  if (!hiddenKeys) hiddenKeys = new Set(activeSets().flatMap(set => set.keywords.map(keyOf)));
  return hiddenKeys;
}

/** Ce mot-clé fait-il partie d'un ensemble actif ? */
export const isHiddenKeyword = name => hiddenKeywordKeys().has(keyOf(name));

/** `fn()` est appelée à chaque changement des ensembles actifs ou des critères de l'un d'eux (le backend est déjà à jour) : recharger les vues. */
export function onPrivacyChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Envoie les ensembles actifs au backend. */
export function syncPrivacyToBackend() {
  const payload = activeSets().map(set => ({
    paths: set.paths.map(item => ({ text: item.text, partial: item.partial })),
    keywords: set.keywords,
    dateRanges: set.dateRanges.map(range => ({ start: range.start, end: range.end })),
  }));
  return invoke('set_privacy_sets', { sets: payload }).catch(error => console.error('Privacy sets rejected', error));
}

let commitChain = Promise.resolve();

/** Les ensembles actifs ou leurs critères ont changé : backend d'abord, puis les vues (dans l'ordre des changements). */
function commit() {
  hiddenKeys = null;
  updateShield();
  commitChain = commitChain.then(syncPrivacyToBackend).then(() => { for (const fn of listeners) fn(); });
  return commitChain;
}

// ---------------------------------------------------------------------------
// Bouclier et liste des ensembles (panneau Filtres)
// ---------------------------------------------------------------------------

const byId = id => document.getElementById(id);
let shieldWrap = null;
let shield = null;
let menu = null;

function updateShield() {
  if (!shield) return;
  shieldWrap.hidden = !enabled;
  const names = activeSets().map(set => set.name.trim() || t('Privacy set {number}', { number: sets.indexOf(set) + 1 }));
  const label = t('Private photos: {sets}', { sets: names.length ? names.join(', ') : t('Off') });
  shield.classList.toggle('active', names.length > 0);
  shield.classList.toggle('locked', isPrivacyLocked());
  shield.title = label;
  shield.setAttribute('aria-label', label);
  if (!menu.hidden && isPrivacyLocked()) closeMenu();
}

const displayName = set => set.name.trim() || t('Privacy set {number}', { number: sets.indexOf(set) + 1 });

function renderMenu() {
  const row = (label, checked, onClick) => {
    const item = document.createElement('li');
    item.className = 'keyword-suggestion';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(checked));
    const mark = document.createElement('span');
    mark.className = 'privacy-check';
    mark.textContent = checked ? '✓' : '';
    const name = document.createElement('span');
    name.className = 'privacy-name';
    name.textContent = label;
    item.append(mark, name);
    item.addEventListener('click', onClick);
    return item;
  };
  const rows = [row(t('Off'), activeSets().length === 0, () => {
    activeIds.clear();
    saveActive();
    commit();
    closeMenu();
  })];
  for (const set of sets) {
    rows.push(row(displayName(set), activeIds.has(set.id), () => {
      if (activeIds.has(set.id)) activeIds.delete(set.id); else activeIds.add(set.id);
      saveActive();
      commit();
      renderMenu(); // la liste reste ouverte : plusieurs ensembles peuvent être cochés
      renderSettings();
    }));
  }
  menu.replaceChildren(...rows);
}

function openMenu() {
  if (isPrivacyLocked()) return; // verrou : rien ne se passe, tout se règle dans les paramètres
  renderMenu();
  menu.hidden = false;
  shield.setAttribute('aria-expanded', 'true');
  const rect = shield.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  document.addEventListener('mousedown', onOutsideMouseDown, true);
  document.addEventListener('keydown', onMenuKeyDown, true);
}

function closeMenu() {
  menu.hidden = true;
  shield.setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', onOutsideMouseDown, true);
  document.removeEventListener('keydown', onMenuKeyDown, true);
}

function onOutsideMouseDown(event) {
  if (!shieldWrap.contains(event.target)) closeMenu();
}

function onMenuKeyDown(event) {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  closeMenu();
  shield.focus();
}

// ---------------------------------------------------------------------------
// Paramètres > Divers > Photos privées
// ---------------------------------------------------------------------------

let ui = null;

const currentSet = () => sets.find(set => set.id === selectedId) ?? null;

/** Les critères de `set` ont changé : mémorisation, affichage, et rechargement des vues si l'ensemble est actif. */
function criteriaChanged(set) {
  saveSets();
  renderCriteria(set);
  if (enabled && activeIds.has(set.id)) commit();
}

function makeRemovable(tag, remove) {
  // Clic du milieu : ferme l'étiquette comme la croix.
  tag.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
  tag.addEventListener('auxclick', event => {
    if (event.button !== 1) return;
    event.preventDefault();
    remove();
  });
  return tag;
}

function renderCriteria(set) {
  ui.pathTags.replaceChildren(...set.paths.map(item => {
    const text = (item.partial ? '~' : '') + item.text;
    const tag = createFilterTag({
      kind: 'filename',
      text,
      onRemove: () => { set.paths = set.paths.filter(other => other !== item); criteriaChanged(set); },
    });
    tag.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      openContextMenuAt(event, [
        { header: text },
        { label: t(item.partial ? 'Make complete' : 'Make partial'), onSelect: () => { item.partial = !item.partial; criteriaChanged(set); } },
      ]);
    });
    return makeRemovable(tag, () => { set.paths = set.paths.filter(other => other !== item); criteriaChanged(set); });
  }));
  ui.keywordTags.replaceChildren(...set.keywords.map(keyword => makeRemovable(createFilterTag({
    kind: 'keyword',
    text: keyword,
    onRemove: () => { set.keywords = set.keywords.filter(other => other !== keyword); criteriaChanged(set); },
  }), () => { set.keywords = set.keywords.filter(other => other !== keyword); criteriaChanged(set); })));
  ui.dateTags.replaceChildren(...set.dateRanges.map(range => makeRemovable(createFilterTag({
    kind: 'date',
    text: range.text || `${range.start}-${range.end}`,
    title: `${range.start} → ${range.end}`,
    onRemove: () => { set.dateRanges = set.dateRanges.filter(other => other !== range); criteriaChanged(set); },
  }), () => { set.dateRanges = set.dateRanges.filter(other => other !== range); criteriaChanged(set); })));
}

function renderSetSelect() {
  const options = sets.map(set => new Option(displayName(set), set.id));
  if (!currentSet()) options.unshift(new Option('', ''));
  options.push(new Option(t('New privacy set…'), NEW_SET));
  ui.select.replaceChildren(...options);
  ui.select.value = currentSet()?.id ?? '';
}

function renderSettings() {
  if (!ui) return;
  ui.enabled.checked = enabled;
  ui.lock.checked = locked;
  ui.lock.disabled = !enabled;
  ui.editor.hidden = !enabled;
  if (!currentSet()) selectedId = sets[0]?.id ?? null;
  renderSetSelect();
  const set = currentSet();
  ui.body.hidden = !set;
  if (!set) return;
  if (document.activeElement !== ui.name) ui.name.value = set.name;
  ui.active.checked = activeIds.has(set.id);
  renderCriteria(set);
}

function addPath(text, partial) {
  const set = currentSet();
  const cleaned = cleanPath(text);
  if (!set || !cleaned) return;
  const same = set.paths.find(item => keyOf(item.text) === keyOf(cleaned));
  if (same) same.partial = partial; // même texte : seul le mode change
  else set.paths.push({ text: cleaned, partial });
  criteriaChanged(set);
}

function addKeyword(text) {
  const set = currentSet();
  const keyword = String(text).trim();
  if (!set || !keyword || set.keywords.some(other => keyOf(other) === keyOf(keyword))) return;
  set.keywords.push(keyword);
  criteriaChanged(set);
}

function showDateError(message) {
  ui.dateError.hidden = !message;
  ui.dateError.textContent = message ?? '';
  ui.dateInput.classList.toggle('invalid', Boolean(message));
  ui.dateInput.setAttribute('aria-invalid', message ? 'true' : 'false');
}

/** Ajoute la plage saisie ; renvoie false (et signale l'erreur) si elle n'est pas valide. */
function addDateRange(text) {
  const set = currentSet();
  if (!set) return false;
  const range = parseDateRange(text);
  if (!range) { showDateError(t('Invalid date range')); return false; }
  showDateError(null);
  if (!set.dateRanges.some(other => other.start === range.start && other.end === range.end)) set.dateRanges.push(range);
  criteriaChanged(set);
  return true;
}

async function deleteSelectedSet() {
  const set = currentSet();
  if (!set) return;
  const confirmed = await confirmDialog({
    title: t('Delete this set'),
    message: t('Delete the privacy set {name}? Its criteria will be lost.', { name: displayName(set) }),
    confirmLabel: t('Yes'),
    cancelLabel: t('No'),
    focusCancel: true,
  });
  if (!confirmed) return;
  const wasActive = activeIds.delete(set.id);
  sets = sets.filter(other => other !== set);
  selectedId = sets[0]?.id ?? null;
  saveSets();
  saveActive();
  renderSettings();
  updateShield();
  if (wasActive) commit();
}

function initSettings() {
  ui = {
    enabled: byId('privacy-enabled-toggle'), lock: byId('privacy-lock-toggle'), editor: byId('privacy-editor'),
    select: byId('privacy-set-select'), body: byId('privacy-set-body'), name: byId('privacy-set-name'), active: byId('privacy-set-active'),
    pathInput: byId('privacy-path-input'), pathTags: byId('privacy-path-tags'),
    keywordInput: byId('privacy-keyword-input'), keywordTags: byId('privacy-keyword-tags'),
    dateInput: byId('privacy-date-input'), dateTags: byId('privacy-date-tags'), dateError: byId('privacy-date-error'),
    calendarButton: byId('privacy-date-calendar'), picker: byId('privacy-date-picker'),
    pickerFrom: byId('privacy-date-from'), pickerTo: byId('privacy-date-to'), pickerAdd: byId('privacy-date-add'),
    remove: byId('privacy-set-delete'),
  };

  ui.enabled.addEventListener('change', () => {
    enabled = ui.enabled.checked;
    writeStored(KEYS.enabled, enabled);
    renderSettings();
    updateShield();
    commit();
  });
  ui.lock.addEventListener('change', () => {
    locked = ui.lock.checked;
    writeStored(KEYS.lock, locked);
    updateShield();
  });

  ui.select.addEventListener('change', () => {
    if (ui.select.value === NEW_SET) {
      const set = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, name: '', paths: [], keywords: [], dateRanges: [] };
      set.name = t('Privacy set {number}', { number: sets.length + 1 });
      sets.push(set);
      selectedId = set.id;
      saveSets();
    } else if (ui.select.value) {
      selectedId = ui.select.value;
    }
    renderSettings();
  });
  ui.name.addEventListener('input', () => {
    const set = currentSet();
    if (!set) return;
    set.name = ui.name.value;
    saveSets();
    renderSetSelect();
    updateShield();
  });
  ui.name.addEventListener('blur', () => {
    const set = currentSet();
    if (set && !set.name.trim()) { set.name = t('Privacy set {number}', { number: sets.indexOf(set) + 1 }); saveSets(); renderSettings(); updateShield(); }
  });
  ui.active.addEventListener('change', () => {
    const set = currentSet();
    if (!set) return;
    if (ui.active.checked) activeIds.add(set.id); else activeIds.delete(set.id);
    saveActive();
    commit();
  });
  ui.remove.addEventListener('click', deleteSelectedSet);

  // Entrée : élément de chemin complet ; Alt+Entrée : partie de chemin (étiquette « ~texte »).
  ui.pathInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addPath(ui.pathInput.value, event.altKey);
    ui.pathInput.value = '';
  });
  ui.keywordInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addKeyword(ui.keywordInput.value);
    ui.keywordInput.value = '';
  });
  ui.dateInput.addEventListener('input', () => showDateError(null));
  ui.dateInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!ui.dateInput.value.trim()) return;
    if (addDateRange(ui.dateInput.value)) ui.dateInput.value = '';
  });
  ui.calendarButton.addEventListener('click', () => { ui.picker.hidden = !ui.picker.hidden; });
  ui.pickerAdd.addEventListener('click', () => {
    const from = ui.pickerFrom.value.replace(/-/g, '');
    const to = ui.pickerTo.value.replace(/-/g, '');
    const text = from && to && to !== from ? `${from}-${to}` : from || to;
    if (!text) return;
    if (addDateRange(text)) { ui.pickerFrom.value = ''; ui.pickerTo.value = ''; ui.picker.hidden = true; }
  });

  renderSettings();
}

/** À appeler une fois au démarrage (main.js) : branche le bouclier et les paramètres, envoie les ensembles actifs au backend. */
export function initPrivacy() {
  shieldWrap = byId('privacy-shield-wrap');
  shield = byId('privacy-shield');
  menu = byId('privacy-menu');
  shield.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  initSettings();
  updateShield();
  onLanguageChange(() => { renderSettings(); updateShield(); if (!menu.hidden) renderMenu(); });
  return syncPrivacyToBackend();
}
