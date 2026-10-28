// Visages (lot 1, lecture seule) : réglage « Lire les données de visages » (Paramètres > Visages), section Personnes de la barre latérale,
// filtre « Personnes (&) » et zones de visage en plein écran (touche V). Les sections Dossiers et Personnes sont repliables.
// Les zones viennent des fichiers (MWG, Microsoft, ACDSee : voir src-tauri/src/faces.rs). Leurs coordonnées sont dans le repère de l'image
// STOCKÉE : l'orientation EXIF de la photo leur est appliquée ici, comme le navigateur l'applique à l'image.

import './faces.css';
import { invoke } from '@tauri-apps/api/core';
import { t, onLanguageChange } from './i18n.js';
import { openContextMenuAt, promptDialog } from './photo-actions.js';

const READING_STORAGE_KEY = 'faceReading'; // « true » : lecture des zones de visage activée
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
let refreshToken = 0;
// Plein écran : visages de la photo affichée (chargés une fois par photo).
let overlayPhotoId = null;
let overlayFaces = null; // { orientation, faces } ou null pendant le chargement
let overlayToken = 0;

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
// FILTRE PERSONNES (ET) : utilisé par applyPhotoFilters dans main.js
// ==========================================
export function hasPersonFilters() {
  return readingEnabled && personFilters.length > 0;
}

export function personFilterMatches(photo) {
  if (!hasPersonFilters()) return true;
  const photoPersons = faceIndex.get(photo.id);
  return Boolean(photoPersons) && personFilters.every(id => photoPersons.has(id));
}

// Vide le filtre sans relancer le filtrage (« Effacer tous les filtres » le fait ensuite).
export function clearPersonFilters() {
  personFilters = [];
  const input = document.getElementById('person-filter-input');
  if (input) input.value = '';
  renderPersonFilterTags();
  renderPersons();
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
  const person = persons.find(item => item.name.toLowerCase() === name);
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
  options.replaceChildren(...[...persons].sort((a, b) => a.name.localeCompare(b.name)).map(person => {
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
  try {
    [loadedPersons, pairs] = await Promise.all([invoke('get_persons'), invoke('get_face_index')]);
  } catch (error) {
    console.error('Lecture des personnes impossible', error);
    return;
  }
  if (token !== refreshToken) return;
  persons = loadedPersons;
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
  if (personFilters.length > 0 || filtersChanged) host.onFilterChange({ keepState: true });
  layoutFullscreenFaces(host.getFullscreenSlot());
}

function sortedPersons() {
  const byName = (a, b) => a.name.localeCompare(b.name);
  return [...persons].sort(sortMode === 'name' ? byName : (a, b) => b.photo_count - a.photo_count || byName(a, b));
}

function renderPersons() {
  const list = document.getElementById('persons-list');
  const empty = document.getElementById('persons-empty');
  const sortButton = document.getElementById('persons-sort');
  if (!list) return;
  sortButton.textContent = sortMode === 'name' ? t('By name') : t('By frequency');
  sortButton.title = t('Sort people by name or by number of photos');
  empty.hidden = persons.length > 0 || isCollapsed('persons');
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

function openPersonMenu(event, person) {
  event.preventDefault();
  const items = [{ label: t('Link to a keyword…'), onSelect: () => linkPersonToKeyword(person) }];
  if (person.keyword_id != null) items.push({ label: t('Unlink keyword'), onSelect: () => saveLink(person, null) });
  openContextMenuAt(event, items);
}

// Chemins complets (« A/B/C ») des nœuds de l'arbre des mots-clés, par identifiant.
async function keywordPaths() {
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
  if (name === 'persons') document.getElementById('persons-empty').hidden = collapsed || persons.length > 0;
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
    box.className = `face-box${face.person_id == null ? ' unknown' : ''}`;
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;
    const label = document.createElement('span');
    label.className = 'face-label';
    label.textContent = face.name || t('Unknown');
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

// hostApi : getThumbnailUrl(path) -> Promise<url>, onFilterChange(options), getFullscreenSlot(), isFullscreen(), showToast(message).
export function initFacesPanel(hostApi) {
  host = hostApi;
  // Le backend doit savoir avant tout scan s'il lit les zones de visage.
  invoke('set_face_reading', { enabled: readingEnabled }).catch(error => console.error('Réglage de lecture des visages refusé', error));

  const toggle = document.getElementById('face-reading-toggle');
  toggle.checked = readingEnabled;
  toggle.addEventListener('change', async () => {
    readingEnabled = toggle.checked;
    writeStorage(READING_STORAGE_KEY, String(readingEnabled));
    await invoke('set_face_reading', { enabled: readingEnabled }).catch(error => console.error('Réglage de lecture des visages refusé', error));
    // Les photos déjà cataloguées n'ont pas encore été lues avec ce réglage : la relecture de la collection est proposée.
    document.getElementById('face-reading-rescan').hidden = !readingEnabled;
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
    if (overlayFaces) renderOverlayFaces(document.getElementById('fullscreen-faces'));
  });
}
