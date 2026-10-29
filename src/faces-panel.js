// Visages (lot 1, lecture seule) : réglage « Lire les données de visages » (Paramètres > Visages), section Personnes de la barre latérale,
// filtre « Personnes (&) » et zones de visage en plein écran (touche V). Les sections Dossiers et Personnes sont repliables.
// Les zones viennent des fichiers (MWG, Microsoft, ACDSee : voir src-tauri/src/faces.rs). Leurs coordonnées sont dans le repère de l'image
// STOCKÉE : l'orientation EXIF de la photo leur est appliquée ici, comme le navigateur l'applique à l'image.

import './faces.css';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { t, tp, onLanguageChange } from './i18n.js';
import { openContextMenuAt, promptDialog, createModal, confirmDialog } from './photo-actions.js';
import { registerEditor, writeMetadataItems, choiceDialog } from './metadata-writes.js';

const READING_STORAGE_KEY = 'faceReading'; // « true » : lecture des zones de visage activée
const DETECTION_STORAGE_KEY = 'faceDetection'; // « true » : détection et reconnaissance activées (menus « Visages », réglages du modèle)
const FACE_SETTINGS_STORAGE_KEY = 'faceSettings'; // réglages de détection (JSON), envoyés au backend (face_detect.rs, FaceSettings)
const SUBFOLDERS_STORAGE_KEY = 'faceScanSubfolders'; // « true » : toujours inclure les sous-dossiers d'un dossier scanné
// Valeurs par défaut provisoires (spec §8), à ajuster après les premiers essais.
const DEFAULT_FACE_SETTINGS = {
  scanRaw: true, minSizePermille: 10, minConfidence: 0.8, minSharpness: 50,
  autoThreshold: 0.5, suggestionThreshold: 0.36, margin: 0.05,
};
const THRESHOLD_INPUTS = {
  minSizePermille: 'face-min-size-permille', minConfidence: 'face-min-confidence', minSharpness: 'face-min-sharpness',
  autoThreshold: 'face-auto-threshold', suggestionThreshold: 'face-suggestion-threshold', margin: 'face-margin',
};
const PERSON_ROOT_STORAGE_KEY = 'facePersonRoot'; // racine des mots-clés créés pour les nouvelles personnes (« A/B », vide = premier niveau)
const SCAN_FILTER_STORAGE_KEY = 'faceScanFilter'; // filtre de la vue Photos par statut du scan : all, unscanned, scanned, review
const OVERLAY_STORAGE_KEY = 'fullscreenFacesVisible'; // zones affichées en plein écran (touche V)
const SORT_STORAGE_KEY = 'personsSort'; // « count » (fréquence, par défaut) ou « name »
const COLLAPSED_STORAGE_KEYS = { folders: 'foldersCollapsed', persons: 'personsCollapsed' };

let host = null; // fonctions fournies par main.js (voir initFacesPanel)
let readingEnabled = readStorage(READING_STORAGE_KEY) === 'true';
let overlayVisible = readStorage(OVERLAY_STORAGE_KEY) === 'true';
let sortMode = readStorage(SORT_STORAGE_KEY) === 'name' ? 'name' : 'count';
let persons = []; // [{ id, name, keyword_id, photo_count, cover }]
let faceIndex = new Map(); // identifiant de photo -> Set des identifiants de personnes
let personFilters = []; // identifiants des personnes filtrées (ET)
let scanIndex = new Map(); // identifiant de photo scannée -> à revérifier ? (get_face_scan_index)
let scanFilter = 'all';
let refreshToken = 0;
// Plein écran : visages de la photo affichée (chargés une fois par photo).
let overlayPhotoId = null;
let overlayFaces = null; // { orientation, faces } ou null pendant le chargement
let overlayToken = 0;
// Détection : réglages, état des fichiers du modèle (get_face_model_status) et reclassement différé après un changement de seuil.
let detectionEnabled = readStorage(DETECTION_STORAGE_KEY) === 'true';
let faceSettings = loadFaceSettings();
let modelStatus = null;
let reclassifyTimer = null;

function loadFaceSettings() {
  try {
    const stored = JSON.parse(readStorage(FACE_SETTINGS_STORAGE_KEY));
    if (stored && typeof stored === 'object') {
      delete stored.minSizePx; // réglage retiré (la taille relative suffit)
      // Ancien réglage en % : converti en ‰.
      if (typeof stored.minSizePercent === 'number' && typeof stored.minSizePermille !== 'number') stored.minSizePermille = stored.minSizePercent * 10;
      delete stored.minSizePercent;
      return { ...DEFAULT_FACE_SETTINGS, ...stored };
    }
  } catch { /* valeur absente ou illisible : réglages par défaut */ }
  return { ...DEFAULT_FACE_SETTINGS };
}

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* stockage indisponible : réglage non mémorisé */ }
}

// ==========================================
// ORIENTATION : repère de l'image stockée -> image affichée
// ==========================================
// Rectangle normalisé (coin haut-gauche, taille) transformé selon l'orientation EXIF (1 à 8), comme le navigateur transforme l'image.
// Ex. orientation 8 (rotation de 270° horaire) : un point (x, y) du fichier s'affiche en (y, 1 − x).
export function orientRect({ x, y, w, h }, orientation) {
  switch (orientation) {
    case 2: return { x: 1 - x - w, y, w, h };
    case 3: return { x: 1 - x - w, y: 1 - y - h, w, h };
    case 4: return { x, y: 1 - y - h, w, h };
    case 5: return { x: y, y: x, w: h, h: w };
    case 6: return { x: 1 - y - h, y: x, w: h, h: w };
    case 7: return { x: 1 - y - h, y: 1 - x - w, w: h, h: w };
    case 8: return { x: y, y: 1 - x - w, w: h, h: w };
    default: return { x, y, w, h };
  }
}

// ==========================================
// FILTRES PERSONNES (ET) ET STATUT DU SCAN : utilisés par applyPhotoFilters dans main.js
// ==========================================
export function hasPersonFilters() {
  return readingEnabled && (personFilters.length > 0 || (detectionEnabled && scanFilter !== 'all'));
}

export function personFilterMatches(photo) {
  if (!hasPersonFilters()) return true;
  if (detectionEnabled && scanFilter !== 'all') {
    const review = scanIndex.get(photo.id);
    const status = review === undefined ? 'unscanned' : review ? 'review' : 'scanned';
    if (status !== scanFilter) return false;
  }
  if (personFilters.length === 0) return true;
  const photoPersons = faceIndex.get(photo.id);
  return Boolean(photoPersons) && personFilters.every(id => photoPersons.has(id));
}

// Vide les filtres sans relancer le filtrage (« Effacer tous les filtres » le fait ensuite).
export function clearPersonFilters() {
  personFilters = [];
  scanFilter = 'all';
  writeStorage(SCAN_FILTER_STORAGE_KEY, scanFilter);
  const input = document.getElementById('person-filter-input');
  if (input) input.value = '';
  const scanSelect = document.getElementById('face-scan-filter');
  if (scanSelect) scanSelect.value = scanFilter;
  renderPersonFilterTags();
  renderPersons();
}

// Personnes connues (vue Visages : suggestions de « Nommer »).
export function getPersons() {
  return persons;
}

// ==========================================
// ÉCRITURE DES VISAGES DANS LES FICHIERS (lot 4)
// ==========================================
// Photos dont les visages attendent d'être écrits : [photo_id, path] (get_pending_face_writes). Elles forment un « éditeur » de metadata-writes.js
// propre à toute la photothèque (scope « library ») : écrites par la vue Visages (bouton, Ctrl + Entrée) ou à la fermeture ; « Appliquer » du
// panneau de droite écrit aussi les visages des photos qu'il réécrit.
let pendingFaceWrites = [];

export function getPendingFaceWriteCount() {
  return pendingFaceWrites.length;
}

async function refreshPendingFaceWrites() {
  if (!readingEnabled) {
    pendingFaceWrites = [];
    return;
  }
  try {
    pendingFaceWrites = await invoke('get_pending_face_writes');
  } catch (error) {
    console.error('Visages en attente illisibles', error);
  }
}

const faceEditor = {
  scope: 'library',
  isDirty: () => pendingFaceWrites.length > 0,
  targetIds: () => pendingFaceWrites.map(([photoId]) => photoId),
  pendingItems: () => pendingFaceWrites.map(([photoId, path]) => ({ photo_id: photoId, path, faces: true })),
  afterWrite: () => refreshFaces(),
  discard: () => {}, // les visages restent en base, marqués : rien à abandonner
};

// « Effacer les données de visages » d'une sélection : confirmation, puis visages supprimés de la base et zones retirées des fichiers.
export async function eraseFaceData(photoIds) {
  if (!photoIds.length) return;
  const confirmed = await confirmDialog({
    title: t('Erase face data'),
    message: tp('Erase the faces of {count} photo? Their face regions are removed from the files, with the keywords set by face recognition. People and the keyword tree are kept.', photoIds.length),
    confirmLabel: t('Erase'),
    cancelLabel: t('Cancel'),
  });
  if (!confirmed) return;
  let items;
  try {
    items = await invoke('erase_face_data', { photoIds });
  } catch (error) {
    host.showToast(String(error));
    return;
  }
  await refreshFaces();
  await writeMetadataItems(items.map(([photoId, path]) => ({ photo_id: photoId, path, faces: true })));
}

// Racine des mots-clés créés pour les nouvelles personnes (Paramètres > Visages).
export function getPersonRoot() {
  return (readStorage(PERSON_ROOT_STORAGE_KEY) ?? '').trim();
}

function setPersonFilters(ids) {
  personFilters = ids;
  renderPersonFilterTags();
  renderPersons();
  host.onFilterChange();
}

// Clic sur une personne : filtre sur elle seule (un second clic l'enlève) ; Ctrl + clic : ajoutée au filtre (ou retirée).
function togglePersonFilter(id, additive) {
  if (additive) {
    setPersonFilters(personFilters.includes(id) ? personFilters.filter(item => item !== id) : [...personFilters, id]);
  } else {
    setPersonFilters(personFilters.length === 1 && personFilters[0] === id ? [] : [id]);
  }
}

function addPersonFilterByName(value) {
  const name = value.trim().toLowerCase();
  if (!name) return;
  const person = listedPersons().find(item => item.name.toLowerCase() === name);
  document.getElementById('person-filter-input').value = '';
  if (!person || personFilters.includes(person.id)) return;
  setPersonFilters([...personFilters, person.id]);
}

function personName(id) {
  return persons.find(person => person.id === id)?.name ?? '?';
}

// Étiquettes des personnes filtrées : boutons à croix quand le groupe est déplié, simples étiquettes derrière le titre quand il est replié.
function renderPersonFilterTags() {
  const expanded = document.getElementById('person-filter-tags');
  const collapsed = document.getElementById('persons-collapsed-line');
  if (!expanded || !collapsed) return;
  expanded.replaceChildren(...personFilters.map(id => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'filter-tag tag-person';
    button.textContent = `${personName(id)} ×`;
    button.title = t('Remove filter {keyword}', { keyword: personName(id) });
    button.addEventListener('click', () => setPersonFilters(personFilters.filter(item => item !== id)));
    return button;
  }));
  collapsed.querySelectorAll('.filter-tag').forEach(node => node.remove());
  collapsed.append(...personFilters.map(id => {
    const tag = document.createElement('span');
    tag.className = 'filter-tag tag-person';
    tag.textContent = personName(id);
    return tag;
  }));
  const options = document.getElementById('person-options');
  options.replaceChildren(...listedPersons().sort((a, b) => a.name.localeCompare(b.name)).map(person => {
    const option = document.createElement('option');
    option.value = person.name;
    return option;
  }));
}

// ==========================================
// SECTION PERSONNES (barre latérale)
// ==========================================
// Recharge les personnes et l'index photo -> personnes (après un scan, une relecture ou une synchronisation : voir loadPhotos dans main.js).
export async function refreshFaces() {
  overlayPhotoId = null; // les zones de la photo affichée ont pu changer
  if (!readingEnabled) return;
  const token = ++refreshToken;
  let loadedPersons;
  let pairs;
  let scans;
  try {
    [loadedPersons, pairs, scans] = await Promise.all([
      invoke('get_persons'),
      invoke('get_face_index'),
      detectionEnabled ? invoke('get_face_scan_index') : Promise.resolve([]),
    ]);
  } catch (error) {
    console.error('Lecture des personnes impossible', error);
    return;
  }
  if (token !== refreshToken) return;
  persons = loadedPersons;
  scanIndex = new Map(scans);
  faceIndex = new Map();
  for (const [photoId, personId] of pairs) {
    if (!faceIndex.has(photoId)) faceIndex.set(photoId, new Set());
    faceIndex.get(photoId).add(personId);
  }
  // Une personne disparue (fichiers relus) ne reste pas dans le filtre.
  const known = new Set(persons.map(person => person.id));
  const keptFilters = personFilters.filter(id => known.has(id));
  const filtersChanged = keptFilters.length !== personFilters.length;
  personFilters = keptFilters;
  renderPersons();
  renderPersonFilterTags();
  if (hasPersonFilters() || filtersChanged) host.onFilterChange({ keepState: true });
  layoutFullscreenFaces(host.getFullscreenSlot());
  await refreshPendingFaceWrites(); // visages en attente d'écriture (bouton de la vue Visages, confirmation à la fermeture)
  host.onFacesChanged?.(); // vue Visages ouverte : rechargée
}

// Personnes sans aucune photo : absentes de la section Personnes et de la liste du filtre.
// Personnes listées (section Personnes, vue Personnes) : celles qui ont des photos ; les personnes masquées seulement si l'utilisateur les affiche.
export function listedPersons() {
  return persons.filter(person => person.photo_count > 0 && (showHiddenPersons || !person.hidden));
}

const SHOW_HIDDEN_STORAGE_KEY = 'showHiddenPersons';
let showHiddenPersons = readStorage(SHOW_HIDDEN_STORAGE_KEY) === 'true';

export function getShowHiddenPersons() {
  return showHiddenPersons;
}

export function setShowHiddenPersons(show) {
  showHiddenPersons = show;
  writeStorage(SHOW_HIDDEN_STORAGE_KEY, String(show));
  renderPersons();
  host.onFacesChanged?.();
}

function sortedPersons() {
  const byName = (a, b) => a.name.localeCompare(b.name);
  return [...listedPersons()].sort(sortMode === 'name' ? byName : (a, b) => b.photo_count - a.photo_count || byName(a, b));
}

function renderPersons() {
  const list = document.getElementById('persons-list');
  const empty = document.getElementById('persons-empty');
  const sortButton = document.getElementById('persons-sort');
  if (!list) return;
  sortButton.textContent = sortMode === 'name' ? t('By name') : t('By frequency');
  sortButton.title = t('Sort people by name or by number of photos');
  empty.hidden = listedPersons().length > 0 || isCollapsed('persons');
  list.replaceChildren(...sortedPersons().map(person => {
    const item = document.createElement('li');
    item.className = `person-item${personFilters.includes(person.id) ? ' active' : ''}`;
    item.dataset.personId = String(person.id);
    item.title = t('Filter on this person (Ctrl+click: add to the filter)');
    const avatar = document.createElement('span');
    avatar.className = 'person-avatar';
    if (person.cover) loadAvatar(avatar, person.cover);
    const name = document.createElement('span');
    name.className = 'person-name';
    name.textContent = person.name;
    const count = document.createElement('span');
    count.className = 'person-count';
    count.textContent = String(person.photo_count);
    item.append(avatar, name);
    // Personne non reliée à un mot-clé de l'arbre : repère « à relier » (menu contextuel > Relier à un mot-clé…).
    if (person.keyword_id == null) {
      const unlinked = document.createElement('span');
      unlinked.className = 'person-unlinked';
      unlinked.textContent = '?';
      unlinked.title = t('Not linked to a keyword');
      item.append(unlinked);
    }
    item.append(count);
    item.addEventListener('click', event => togglePersonFilter(person.id, event.ctrlKey || event.metaKey));
    item.addEventListener('contextmenu', event => openPersonMenu(event, person));
    return item;
  }));
}

// Vignette ronde : la zone du visage (orientée comme la miniature), élargie et rendue carrée, découpée dans la miniature en cache par CSS.
async function loadAvatar(element, cover) {
  const url = await host.getThumbnailUrl(cover.path);
  if (!url || !element.isConnected) return;
  const image = new Image();
  image.onload = () => {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!(width > 0 && height > 0)) return;
    const rect = orientRect(cover, cover.orientation);
    const faceWidth = rect.w * width;
    const faceHeight = rect.h * height;
    const side = Math.min(Math.max(faceWidth, faceHeight) * 1.4, width, height);
    const left = Math.min(Math.max(rect.x * width + faceWidth / 2 - side / 2, 0), width - side);
    const top = Math.min(Math.max(rect.y * height + faceHeight / 2 - side / 2, 0), height - side);
    element.style.backgroundImage = `url("${url}")`;
    element.style.backgroundSize = `${(width / side) * 100}% ${(height / side) * 100}%`;
    element.style.backgroundPosition = `${width > side ? (left / (width - side)) * 100 : 0}% ${height > side ? (top / (height - side)) * 100 : 0}%`;
  };
  image.src = url;
}

// Menu d'une personne (section Personnes, vue Personnes) : gérer ses visages, renommer, relier / délier un mot-clé, masquer / afficher, supprimer.
export function openPersonMenu(event, person) {
  event.preventDefault();
  const items = [
    // Vue de gestion sur les visages de ses photos (grille filtrée sur elle).
    { label: t('Manage their faces'), onSelect: () => showPersonFaces(person.id) },
    { label: t('Rename…'), onSelect: () => renamePerson(person) },
    { label: t('Link to a keyword…'), onSelect: () => linkPersonToKeyword(person) },
  ];
  if (person.keyword_id != null) items.push({ label: t('Unlink keyword'), onSelect: () => saveLink(person, null) });
  items.push(
    { label: person.hidden ? t('Show this person') : t('Hide this person'), onSelect: () => setPersonHidden(person, !person.hidden) },
    { label: t('Delete this person…'), onSelect: () => confirmDeletePerson(person), danger: true },
  );
  openContextMenuAt(event, items);
}

const personErrorMessage = error => ({
  invalid_name: t('Names cannot be empty or contain "/", "|" or ","'),
  person_name_taken: t('Another person already has this name'),
  unknown_person: t('This person no longer exists'),
}[String(error)] ?? String(error));

// Renommer : une personne non reliée change de nom ; pour une personne reliée, c'est son mot-clé qui est renommé (son nom vient de lui), avec la
// réécriture des fichiers qui le portent, comme depuis le panneau Mots-clés.
async function renamePerson(person) {
  const linked = person.keyword_id != null;
  await promptDialog({
    title: t('Rename the person'),
    message: linked ? t('{name} is linked to a keyword: the keyword is renamed, in the keyword tree and in the files that carry it.', { name: person.name }) : t('New name of {name}', { name: person.name }),
    inputLabel: t('Name'),
    confirmLabel: t('Rename'),
    cancelLabel: t('Cancel'),
    value: person.name,
    onSubmit: async value => {
      const name = value.trim();
      if (!name || /[/|,]/.test(name)) return t('Names cannot be empty or contain "/", "|" or ","');
      if (name === person.name) return null;
      if (!linked) {
        try {
          await invoke('rename_person', { personId: person.id, name });
        } catch (error) {
          return personErrorMessage(error);
        }
        await refreshFaces();
        return null;
      }
      host.renameKeyword(person.keyword_id, name, person.photo_count, refreshFaces);
      return null;
    },
  });
}

async function setPersonHidden(person, hidden) {
  try {
    await invoke('set_person_hidden', { personId: person.id, hidden });
  } catch (error) {
    host.showToast(String(error));
    return;
  }
  await refreshFaces();
}

// Supprimer une personne : alerte (caractéristiques de visage effacées ; visages encore rattachés, avec « Voir » pour les traiter d'abord).
// `intro` : phrase d'introduction (ex. après la suppression de son mot-clé).
export async function confirmDeletePerson(person, intro = '') {
  let info;
  try {
    info = await invoke('person_delete_info', { personId: person.id });
  } catch (error) {
    host.showToast(personErrorMessage(error));
    return;
  }
  const lines = [];
  if (intro) lines.push(intro);
  lines.push(t('The face characteristics of {name} (references used for recognition) will be erased.', { name: info.name }));
  if (info.face_count > 0) {
    lines.push(tp('{count} face is still attached to this person, on {photos} photo: it will become unknown and its name will be removed from the files at the next write.', info.face_count, { photos: info.photo_count }));
  }
  const buttons = [{ label: t('Cancel'), value: 'cancel', cancel: true }];
  if (info.face_count > 0) buttons.push({ label: t('View'), value: 'view' });
  buttons.push({ label: t('Erase'), value: 'erase' });
  const choice = await choiceDialog({ title: t('Delete {name}?', { name: info.name }), message: lines.join('\n\n'), buttons });
  if (choice === 'view') {
    showPersonFaces(person.id);
    return;
  }
  if (choice !== 'erase') return;
  try {
    await invoke('delete_person', { personId: person.id });
  } catch (error) {
    host.showToast(personErrorMessage(error));
    return;
  }
  personFilters = personFilters.filter(id => id !== person.id);
  await refreshFaces();
  host.onFilterChange();
  host.showToast(t('{name} deleted', { name: info.name }));
}

// Mot-clé relié à des personnes supprimé (panneau Mots-clés) : proposer de supprimer aussi chacune d'elles (à défaut, elles restent, déliées).
export async function proposeDeletePersons(unlinked) {
  for (const [id, name] of unlinked) {
    await confirmDeletePerson({ id, name }, t('The keyword of {name} has been deleted. Delete the person too?', { name }));
  }
}

// Vue Personnes, clic sur une personne : la grille des photos est filtrée sur elle seule.
export function filterOnPerson(personId) {
  setPersonFilters([personId]);
}

// Visages d'une personne à traiter : la grille des photos est filtrée sur elle, puis la vue de gestion s'ouvre sur les visages de ces photos.
export function showPersonFaces(personId) {
  personFilters = [personId];
  renderPersonFilterTags();
  renderPersons();
  host.onFilterChange();
  host.openFacesManagement();
}

// Chemins complets (« A/B/C ») des nœuds de l'arbre des mots-clés, par identifiant.
export async function keywordPaths() {
  const nodes = await invoke('get_keyword_tree');
  const byId = new Map(nodes.map(node => [node.id, node]));
  const paths = new Map();
  const pathOf = id => {
    if (paths.has(id)) return paths.get(id);
    const node = byId.get(id);
    if (!node) return '';
    const parent = node.parent_id ? pathOf(node.parent_id) : '';
    const path = parent ? `${parent}/${node.name}` : node.name;
    paths.set(id, path);
    return path;
  };
  for (const node of nodes) pathOf(node.id);
  return paths;
}

async function linkPersonToKeyword(person) {
  let paths;
  try {
    paths = await keywordPaths();
  } catch (error) {
    host.showToast(String(error));
    return;
  }
  const suggestions = [...paths.values()].sort((a, b) => a.localeCompare(b));
  const normalize = path => path.split('/').map(segment => segment.trim().toLowerCase()).filter(Boolean).join('/');
  await promptDialog({
    title: t('Link to a keyword'),
    message: t('Keyword of {name} in the keyword tree (full path, levels separated by "/")', { name: person.name }),
    inputLabel: t('Keyword'),
    confirmLabel: t('Link'),
    cancelLabel: t('Cancel'),
    value: person.keyword_id != null ? (paths.get(person.keyword_id) ?? '') : person.name,
    suggestions,
    onSubmit: async value => {
      const wanted = normalize(value);
      const match = [...paths.entries()].find(([, path]) => normalize(path) === wanted);
      if (!match) return t('No keyword has this path');
      return saveLink(person, match[0]);
    },
  });
}

// Enregistre le lien (ou le retire) ; renvoie un message d'erreur ou null.
async function saveLink(person, keywordId) {
  try {
    await invoke('link_person_keyword', { personId: person.id, keywordId });
  } catch (error) {
    const message = String(error) === 'keyword_taken' ? t('This keyword is already linked to another person') : String(error);
    host.showToast(message);
    return message;
  }
  await refreshFaces();
  return null;
}

// ==========================================
// SECTIONS REPLIABLES (Dossiers, Personnes)
// ==========================================
function isCollapsed(name) {
  return readStorage(COLLAPSED_STORAGE_KEYS[name]) === 'true';
}

function applyCollapsed(name) {
  const collapsed = isCollapsed(name);
  const toggle = document.getElementById(`${name}-toggle`);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.querySelector('.sidebar-block-chevron').textContent = collapsed ? '▸' : '▾';
  document.getElementById(toggle.getAttribute('aria-controls')).hidden = collapsed;
  if (name === 'persons') document.getElementById('persons-empty').hidden = collapsed || listedPersons().length > 0;
}

function initCollapsibleSection(name) {
  document.getElementById(`${name}-toggle`).addEventListener('click', () => {
    writeStorage(COLLAPSED_STORAGE_KEYS[name], String(!isCollapsed(name)));
    applyCollapsed(name);
  });
  applyCollapsed(name);
}

// ==========================================
// ZONES DE VISAGE EN PLEIN ÉCRAN (touche V)
// ==========================================
// Appelée par main.js à chaque mise en page du plein écran (photo, zoom, déplacement) : le calque suit l'image affichée.
export function layoutFullscreenFaces(slot) {
  const overlay = document.getElementById('fullscreen-faces');
  if (!overlay) return;
  const photo = slot?.photo;
  if (!readingEnabled || !overlayVisible || !host?.isFullscreen() || !photo || !(slot.naturalWidth > 0)) {
    overlay.hidden = true;
    return;
  }
  if (photo.id !== overlayPhotoId) {
    overlayPhotoId = photo.id;
    overlayFaces = null;
    overlay.replaceChildren();
    const token = ++overlayToken;
    invoke('get_photo_faces', { photoId: photo.id })
      .then(info => {
        if (token !== overlayToken) return;
        overlayFaces = info;
        renderOverlayFaces(overlay);
      })
      .catch(error => console.error('Lecture des visages impossible', error));
  }
  overlay.style.left = `${slot.tx}px`;
  overlay.style.top = `${slot.ty}px`;
  overlay.style.width = `${slot.displayWidth}px`;
  overlay.style.height = `${slot.displayHeight}px`;
  overlay.hidden = false;
}

function renderOverlayFaces(overlay) {
  if (!overlayFaces) return;
  overlay.replaceChildren(...overlayFaces.faces.map(face => {
    const rect = orientRect(face, overlayFaces.orientation);
    const box = document.createElement('div');
    box.className = `face-box state-${face.state}${face.person_id == null && face.state !== 'suggested' ? ' unknown' : ''}`;
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;
    const label = document.createElement('span');
    label.className = 'face-label';
    label.textContent = face.state === 'suggested' ? `${face.name ?? '?'} ?` : (face.name || t('Unknown'));
    box.append(label);
    return box;
  }));
}

export function toggleFaceRegions() {
  if (!readingEnabled) return;
  overlayVisible = !overlayVisible;
  writeStorage(OVERLAY_STORAGE_KEY, String(overlayVisible));
  layoutFullscreenFaces(host.getFullscreenSlot());
}

// ==========================================
// DÉTECTION : MODÈLE, RÉGLAGES, LANCEMENT
// ==========================================
export function isFaceDetectionEnabled() {
  return readingEnabled && detectionEnabled;
}

// Codes d'erreur du backend (face_models.rs) traduits ; les autres messages sont affichés tels quels.
function faceErrorMessage(error) {
  const text = String(error);
  if (text === 'face_models_missing') return t('Download the face model first (Settings > Faces)');
  if (text === 'faces_unsupported_platform') return t('Face detection is not available on this system');
  return text;
}

function formatMegabytes(bytes) {
  const megabytes = bytes / 1e6;
  return t('{size} MB', { size: megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes) });
}

async function refreshModelStatus() {
  try {
    modelStatus = await invoke('get_face_model_status');
  } catch (error) {
    console.error('État du modèle de visages illisible', error);
    modelStatus = null;
  }
  renderModelStatus();
  return modelStatus;
}

// État des fichiers du modèle, bouton de téléchargement et liste des fichiers (liens et sommes SHA-256 pour une installation sans Internet).
function renderModelStatus() {
  const status = document.getElementById('face-model-status');
  const download = document.getElementById('btn-face-model-download');
  const importButton = document.getElementById('btn-face-model-import');
  const list = document.getElementById('face-model-files');
  if (!status) return;
  if (!modelStatus) {
    status.textContent = t('Checking the face model…');
    download.hidden = true;
    list.replaceChildren();
    return;
  }
  importButton.hidden = !modelStatus.supported;
  download.hidden = !modelStatus.supported || modelStatus.installed;
  if (!modelStatus.supported) status.textContent = t('Face detection is not available on this system');
  else if (modelStatus.installed) status.textContent = t('Face model installed in {folder}', { folder: modelStatus.directory });
  else status.textContent = t('The face model must be downloaded ({size}). It is stored in {folder}.', { size: formatMegabytes(modelStatus.missing_size), folder: modelStatus.directory });
  download.textContent = t('Download ({size})', { size: formatMegabytes(modelStatus.missing_size) });
  list.replaceChildren(...modelStatus.files.map(file => {
    const item = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = `${file.installed ? '✓ ' : ''}${file.name} (${formatMegabytes(file.size)})`;
    const url = document.createElement('code');
    url.textContent = file.url;
    const sha = document.createElement('code');
    sha.textContent = `SHA-256 ${file.sha256}`;
    item.append(name, url, sha);
    return item;
  }));
}

function downloadModels() {
  host.enqueueTask({
    kind: 'face-models',
    path: null,
    command: 'download_face_models',
    args: {},
    labelKey: 'Face model download',
    onResult: async (_result, stopped, error) => {
      if (error) host.showToast(t('Face model download failed: {error}', { error: faceErrorMessage(error) }));
      await refreshModelStatus();
      if (!error && !stopped && modelStatus?.installed) host.showToast(t('Face model installed'));
    },
  });
}

async function importModels() {
  const directory = await open({ directory: true, multiple: false, title: t('Folder containing the face model files') });
  if (typeof directory !== 'string' || !directory) return;
  try {
    modelStatus = await invoke('import_face_models', { directory });
    renderModelStatus();
    host.showToast(t('Face model installed'));
  } catch (error) {
    host.showToast(faceErrorMessage(error));
    refreshModelStatus();
  }
}

function sendFaceSettings() {
  return invoke('set_face_settings', { settings: faceSettings }).catch(error => console.error('Réglages de détection refusés', error));
}

// Un seuil a changé : les visages déjà détectés sont reclassés (inconnu / filtré) sans nouveau scan, un court instant après la dernière saisie.
function scheduleReclassify() {
  clearTimeout(reclassifyTimer);
  reclassifyTimer = setTimeout(async () => {
    try {
      // Seuils de détection : inconnu ↔ filtré ; seuils de reconnaissance : nouvelle attribution de tous les visages non confirmés.
      await invoke('apply_face_thresholds');
      await invoke('recognize_faces', { photoIds: null });
      refreshFaces();
    } catch (error) {
      console.error('Reclassement des visages impossible', error);
    }
  }, 400);
}

function initDetectionSettings() {
  const raw = document.getElementById('face-scan-raw');
  raw.checked = faceSettings.scanRaw;
  raw.addEventListener('change', () => {
    faceSettings.scanRaw = raw.checked;
    writeStorage(FACE_SETTINGS_STORAGE_KEY, JSON.stringify(faceSettings));
    sendFaceSettings();
  });
  for (const [key, id] of Object.entries(THRESHOLD_INPUTS)) {
    const input = document.getElementById(id);
    input.value = String(faceSettings[key]);
    input.addEventListener('change', () => {
      const value = Number(input.value);
      const min = Number(input.min);
      const max = Number(input.max);
      if (!Number.isFinite(value)) {
        input.value = String(faceSettings[key]);
        return;
      }
      faceSettings[key] = Math.min(max, Math.max(min, value));
      input.value = String(faceSettings[key]);
      writeStorage(FACE_SETTINGS_STORAGE_KEY, JSON.stringify(faceSettings));
      sendFaceSettings().then(scheduleReclassify);
    });
  }
  const subfolders = document.getElementById('face-scan-subfolders');
  subfolders.checked = readStorage(SUBFOLDERS_STORAGE_KEY) === 'true';
  subfolders.addEventListener('change', () => writeStorage(SUBFOLDERS_STORAGE_KEY, String(subfolders.checked)));
  document.getElementById('btn-face-model-download').addEventListener('click', downloadModels);
  document.getElementById('btn-face-model-import').addEventListener('click', importModels);
  document.querySelector('.settings-tab-btn[data-tab="faces"]').addEventListener('click', () => { if (detectionEnabled) refreshModelStatus(); });
  const root = document.getElementById('face-person-root');
  root.value = getPersonRoot();
  root.addEventListener('change', () => {
    // Mêmes règles que les mots-clés : pas de « | » ni de « , » ; « / » sépare les niveaux.
    root.value = root.value.replace(/[|,]/g, '').split('/').map(segment => segment.trim()).filter(Boolean).join('/');
    writeStorage(PERSON_ROOT_STORAGE_KEY, root.value);
  });
  const scanSelect = document.getElementById('face-scan-filter');
  scanFilter = ['unscanned', 'scanned', 'review'].includes(readStorage(SCAN_FILTER_STORAGE_KEY)) ? readStorage(SCAN_FILTER_STORAGE_KEY) : 'all';
  scanSelect.value = scanFilter;
  scanSelect.addEventListener('change', () => {
    scanFilter = scanSelect.value;
    writeStorage(SCAN_FILTER_STORAGE_KEY, scanFilter);
    host.onFilterChange();
  });
}

// Détection activée : réglages du modèle, bouton « Visages » de la barre du haut, filtre du statut de scan, raccourcis de la section Personnes.
function applyDetectionEnabled() {
  document.getElementById('face-detection-settings').hidden = !detectionEnabled;
  document.getElementById('btn-toggle-faces').hidden = !isFaceDetectionEnabled();
  document.getElementById('face-scan-filter-row').hidden = !isFaceDetectionEnabled();
  if (!isFaceDetectionEnabled()) host.closeFacesView?.();
  renderPersons();
  if (detectionEnabled) {
    refreshModelStatus();
    refreshFaces();
  }
}

function setDetectionEnabled(enabled) {
  detectionEnabled = enabled;
  writeStorage(DETECTION_STORAGE_KEY, String(enabled));
  document.getElementById('face-detection-toggle').checked = enabled;
  applyDetectionEnabled();
}

function checkbox(label, checked) {
  const row = document.createElement('label');
  row.className = 'settings-row settings-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  const text = document.createElement('span');
  text.textContent = label;
  row.append(input, text);
  return { row, input };
}

function dialogButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  if (className) button.className = className;
  button.textContent = label;
  button.disabled = true; // activé une fois les photos comptées
  button.addEventListener('click', onClick);
  return button;
}

// Met le scan en file : `recursive` = sous-dossiers compris (dossier seulement).
function enqueueFaceScan(scope, recursive) {
  const isFolder = Boolean(scope.folder);
  const folderName = isFolder ? scope.folder.split(/[\/]/).filter(Boolean).pop() : '';
  host.enqueueTask({
    kind: isFolder ? 'faces' : 'faces-selection',
    path: isFolder ? scope.folder : null,
    command: 'detect_faces',
    args: { photoIds: scope.photoIds ?? null, folder: scope.folder ?? null, recursive, onlyUnscanned: Boolean(scope.onlyUnscanned) },
    labelKey: isFolder ? 'Face detection: {folder}' : 'Face detection ({count} photos)',
    labelParams: isFolder ? { folder: folderName } : { count: scope.photoIds.length },
    onResult: async (report, _stopped, error) => {
      if (error) {
        host.showToast(t('Face detection failed: {error}', { error: faceErrorMessage(error) }));
        return;
      }
      if (report) {
        let message = tp('{count} photo scanned, {faces} faces found', report.scanned, { faces: report.faces });
        if (report.auto > 0 || report.suggested > 0) message += ` · ${t('{auto} recognized, {suggested} to confirm', { auto: report.auto, suggested: report.suggested })}`;
        if (report.failed.length > 0) {
          message += ` · ${tp('{count} unreadable photo', report.failed.length)}`;
          console.warn('Photos non analysées', report.failed);
        }
        host.showToast(message);
      }
      await refreshFaces();
    },
  });
}

// Fenêtre de lancement d'un scan (menu contextuel > Visages) : `scope` = { folder } ou { photoIds }, et `onlyUnscanned`.
// Dossier : question « Inclure les sous-dossiers ? », réponses « Non » / « Inclure », et au-dessus la case « Toujours inclure les sous-dossiers »
// (réglage de Paramètres > Métadonnées ; cochée, seule « Inclure » reste possible). Le nombre de photos à scanner est donné pour les deux réponses.
// Pas de question quand aucun sous-dossier ne contient de photo cataloguée : comme pour une sélection, nombre de photos puis « Annuler » / « Lancer ».
export async function openFaceScanDialog(scope) {
  if (!isFaceDetectionEnabled()) return;
  await refreshModelStatus();
  if (!modelStatus?.installed) {
    host.showToast(faceErrorMessage(modelStatus?.supported === false ? 'faces_unsupported_platform' : 'face_models_missing'));
    return;
  }
  const isFolder = Boolean(scope.folder);
  const modal = createModal({ title: t('Detect faces'), cardClass: 'confirm-card face-scan-card' });
  const question = document.createElement('p');
  question.className = 'confirm-message face-scan-question';
  const summary = document.createElement('p');
  summary.className = 'confirm-message';
  summary.textContent = t('Counting photos…');
  const actions = document.createElement('div');
  actions.className = 'confirm-actions';
  const launch = recursive => {
    modal.close();
    enqueueFaceScan(scope, recursive);
  };
  const countOf = counted => (scope.onlyUnscanned ? counted.unscanned : counted.total);
  const count = recursive => invoke('count_face_scan_targets', { photoIds: scope.photoIds ?? null, folder: scope.folder ?? null, recursive });

  modal.body.append(summary);
  let folderOnly;
  let recursive = null;
  try {
    // Dossier : comptés avec et sans sous-dossiers. Aucune photo cataloguée dans ses sous-dossiers (ou pas de sous-dossier) : pas de question.
    [folderOnly, recursive] = await Promise.all([count(false), isFolder ? count(true) : Promise.resolve(null)]);
  } catch (error) {
    summary.textContent = faceErrorMessage(error);
    return;
  }
  if (!summary.isConnected) return; // fenêtre fermée pendant le comptage

  if (!isFolder || recursive.total === folderOnly.total) {
    const photosToScan = countOf(folderOnly);
    summary.textContent = scope.onlyUnscanned
      ? tp('{count} photo to scan (not scanned yet), out of {total}', photosToScan, { total: folderOnly.total })
      : tp('{count} photo to scan', photosToScan);
    const cancel = dialogButton(t('Cancel'), '', modal.close);
    cancel.disabled = false;
    const start = dialogButton(t('Start'), 'btn-primary', () => launch(false));
    start.disabled = photosToScan === 0;
    actions.append(cancel, start);
    modal.body.append(actions);
    (start.disabled ? cancel : start).focus();
    return;
  }

  const here = countOf(folderOnly);
  const withSubfolders = countOf(recursive);
  question.textContent = t('Include subfolders?');
  summary.textContent = t('Photos to scan: {here} in this folder, {all} with its subfolders.', { here, all: withSubfolders });
  const always = checkbox(t('Always include subfolders'), readStorage(SUBFOLDERS_STORAGE_KEY) === 'true');
  // « Non » est la réponse proposée (bouton bleu, focus) ; « Inclure » reste à un clic.
  const no = dialogButton(t('No'), 'btn-primary', () => launch(false));
  const include = dialogButton(t('Include'), '', () => launch(true));
  actions.append(no, include);
  modal.body.prepend(question);
  modal.body.append(always.row, actions);
  const updateButtons = () => {
    no.disabled = always.input.checked || here === 0;
    include.disabled = withSubfolders === 0;
  };
  always.input.addEventListener('change', () => {
    writeStorage(SUBFOLDERS_STORAGE_KEY, String(always.input.checked));
    const setting = document.getElementById('face-scan-subfolders');
    if (setting) setting.checked = always.input.checked;
    updateButtons();
  });
  updateButtons();
  (no.disabled ? include : no).focus();
}

// ==========================================
// RÉGLAGE ET INITIALISATION
// ==========================================
// Lecture activée : section Personnes, filtre et zones visibles ; désactivée : tout est masqué et le filtre retiré.
function applyReadingEnabled() {
  document.getElementById('persons-section').hidden = !readingEnabled;
  document.getElementById('filter-group-persons').hidden = !readingEnabled;
  if (!readingEnabled) {
    persons = [];
    faceIndex = new Map();
    personFilters = [];
    renderPersons();
    renderPersonFilterTags();
  }
  layoutFullscreenFaces(host.getFullscreenSlot());
}

// hostApi : getThumbnailUrl(path) -> Promise<url>, onFilterChange(options), getFullscreenSlot(), isFullscreen(), showToast(message),
// enqueueTask({ kind, path, command, args, labelKey, labelParams, onResult }) (file des tâches de main.js).
export function initFacesPanel(hostApi) {
  host = hostApi;
  registerEditor(faceEditor);
  // Le backend doit savoir avant tout scan s'il lit les zones de visage, et avec quels réglages il détecte.
  invoke('set_face_reading', { enabled: readingEnabled }).catch(error => console.error('Réglage de lecture des visages refusé', error));
  sendFaceSettings();
  // La détection suppose la lecture des visages : l'activer coche aussi la lecture.
  const detectionToggle = document.getElementById('face-detection-toggle');
  if (detectionEnabled && !readingEnabled) detectionEnabled = false;
  detectionToggle.checked = detectionEnabled;
  detectionToggle.addEventListener('change', () => {
    setDetectionEnabled(detectionToggle.checked);
    const readingToggle = document.getElementById('face-reading-toggle');
    if (detectionEnabled && !readingToggle.checked) {
      readingToggle.checked = true;
      readingToggle.dispatchEvent(new Event('change'));
    }
  });
  initDetectionSettings();
  applyDetectionEnabled();

  const toggle = document.getElementById('face-reading-toggle');
  toggle.checked = readingEnabled;
  toggle.addEventListener('change', async () => {
    readingEnabled = toggle.checked;
    writeStorage(READING_STORAGE_KEY, String(readingEnabled));
    await invoke('set_face_reading', { enabled: readingEnabled }).catch(error => console.error('Réglage de lecture des visages refusé', error));
    // Les photos déjà cataloguées n'ont pas encore été lues avec ce réglage : la relecture de la collection est proposée.
    document.getElementById('face-reading-rescan').hidden = !readingEnabled;
    if (!readingEnabled && detectionEnabled) setDetectionEnabled(false);
    applyReadingEnabled();
    host.onFilterChange();
    if (readingEnabled) refreshFaces();
  });
  document.getElementById('btn-face-rescan').addEventListener('click', () => document.getElementById('btn-rescan-folders').click());

  document.getElementById('persons-sort').addEventListener('click', () => {
    sortMode = sortMode === 'name' ? 'count' : 'name';
    writeStorage(SORT_STORAGE_KEY, sortMode);
    renderPersons();
  });
  const filterInput = document.getElementById('person-filter-input');
  filterInput.addEventListener('change', () => addPersonFilterByName(filterInput.value));
  filterInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addPersonFilterByName(filterInput.value);
  });

  initCollapsibleSection('folders');
  initCollapsibleSection('persons');
  applyReadingEnabled();
  onLanguageChange(() => {
    renderPersons();
    renderPersonFilterTags();
    renderModelStatus();
    if (overlayFaces) renderOverlayFaces(document.getElementById('fullscreen-faces'));
  });
}
