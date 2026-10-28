// Vue Visages (lot 3) : grille virtuelle des visages des photos affichées, à la place de la grille des photos (spec §9.3).
// - Vignettes carrées découpées dans les miniatures en cache (CSS), regroupées : à valider (par personne proposée), par personne, inconnus,
//   filtrés, ignorés. Le filtre par statut n'existe que dans cette vue.
// - Sélection : clic, Ctrl + clic, Maj + clic ; Ctrl + A tout sélectionner, Échap tout désélectionner. Double-clic : photo en plein écran.
// - Actions : Valider (Entrée), Nommer… (ou taper directement le nom sur les visages sélectionnés), Inconnu, Ignorer, Ne plus ignorer,
//   N'est pas un visage (fausse détection : comme Ignorer, jamais écrit ni reproposé au rescan) et C'est un visage.
//   Après chaque action, les autres visages sont réattribués (sans ONNX).
// La base seule change : l'écriture dans les fichiers viendra au lot 4.

import { invoke } from '@tauri-apps/api/core';
import { t, tp, onLanguageChange } from './i18n.js';
import { promptDialog } from './photo-actions.js';
import { orientRect, refreshFaces, keywordPaths, getPersons, getPendingFaceWriteCount } from './faces-panel.js';
import { applyPending, isWriteLocked, onLockChange } from './metadata-writes.js';

const STATUSES_STORAGE_KEY = 'facesViewStatuses';
// Statuts dans l'ordre d'affichage des groupes, avec la clé de traduction de leur nom.
const STATUSES = [
  { id: 'suggested', label: 'To confirm' },
  { id: 'auto', label: 'Automatic' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'unknown', label: 'Unknown faces' },
  { id: 'filtered', label: 'Filtered' },
  { id: 'ignored', label: 'Ignored' },
  { id: 'not_face', label: 'Not faces' },
];
const DEFAULT_STATUSES = ['suggested', 'auto', 'confirmed', 'unknown'];
// Dimensions des vignettes : lues dans le CSS (variables de .faces-view, voir faces.css) à chaque reconstruction.
let TILE = 120; // côté d'une vignette carrée (px)
let BAR = 0; // largeur de la bande d'état, à gauche de chaque ligne (px)
let GAP = 0; // espacement entre vignettes (px)
const SEPARATOR_HEIGHT = 30;
const SIDE_MARGIN = 8;

let host = null; // fonctions fournies par main.js (voir initFacesGrid)
let open = false;
let visibleStatuses = loadStatuses();
let faces = []; // visages des photos affichées (get_faces_for_photos)
let shown = []; // visages retenus par le filtre, dans l'ordre d'affichage
let layout = []; // { kind: 'separator' | 'face', x, y, label?, index? }
let contentHeight = 0;
let selected = new Set(); // identifiants de visages
let anchorIndex = null; // dernier visage cliqué (sélection Maj + clic)
let loadToken = 0;
const renderedNodes = new Map(); // clé de l'élément de layout -> nœud
const thumbnailInfo = new Map(); // chemin de la photo -> Promise<{ url, width, height } | null>

const view = () => document.getElementById('faces-view');
const scroller = () => document.getElementById('faces-scroll');
const content = () => document.getElementById('faces-content');

function loadStatuses() {
  try {
    const stored = JSON.parse(localStorage.getItem(STATUSES_STORAGE_KEY));
    if (Array.isArray(stored)) return new Set(stored.filter(id => STATUSES.some(status => status.id === id)));
  } catch { /* valeur absente ou illisible */ }
  return new Set(DEFAULT_STATUSES);
}

function saveStatuses() {
  try { localStorage.setItem(STATUSES_STORAGE_KEY, JSON.stringify([...visibleStatuses])); } catch { /* stockage indisponible */ }
}

export function isFacesViewOpen() {
  return open;
}

// Des visages sont sélectionnés : une lettre tapée commence un nom (la touche H n'ouvre alors pas le guide, voir main.js).
export function hasFaceSelection() {
  return open && selected.size > 0;
}

// Ouvre la vue Visages ; `statuses` (facultatif) : statuts à afficher (ex. depuis la section Personnes, « À valider »).
export function openFacesView(statuses = null) {
  if (statuses) {
    visibleStatuses = new Set(statuses);
    saveStatuses();
  }
  open = true;
  view().hidden = false;
  host.setPhotoGridVisible(false);
  document.getElementById('btn-toggle-faces')?.classList.add('active');
  renderStatusFilters();
  reloadFacesView();
  scroller().focus({ preventScroll: true });
}

export function closeFacesView() {
  if (!open) return;
  open = false;
  view().hidden = true;
  host.setPhotoGridVisible(true);
  document.getElementById('btn-toggle-faces')?.classList.remove('active');
}

export function toggleFacesView() {
  if (open) closeFacesView(); else openFacesView();
}

// Recharge les visages des photos affichées (changement de dossier ou de filtre, scan terminé, action de révision). Défilement conservé.
export async function reloadFacesView() {
  if (!open) return;
  const token = ++loadToken;
  const photoIds = host.getDisplayedPhotoIds();
  let loaded;
  try {
    loaded = await invoke('get_faces_for_photos', { photoIds });
  } catch (error) {
    console.error('Lecture des visages impossible', error);
    return;
  }
  if (token !== loadToken) return;
  faces = loaded;
  const known = new Set(faces.map(face => face.id));
  selected = new Set([...selected].filter(id => known.has(id)));
  rebuild();
}

// ==========================================
// FILTRE, GROUPES ET DISPOSITION
// ==========================================
function groupOf(face) {
  switch (face.state) {
    case 'suggested': return { order: 0, key: `s${face.suggested_person_id}`, label: t('To confirm: {name}', { name: face.name ?? '?' }), sortName: face.name ?? '' };
    case 'auto':
    case 'confirmed': return { order: 1, key: `p${face.person_id}`, label: face.name ?? '?', sortName: face.name ?? '' };
    case 'unknown': return { order: 2, key: 'unknown', label: t('Unknown faces'), sortName: '' };
    case 'filtered': return { order: 3, key: 'filtered', label: t('Filtered (below the thresholds)'), sortName: '' };
    case 'not_face': return { order: 5, key: 'not_face', label: t('Not faces'), sortName: '' };
    default: return { order: 4, key: 'ignored', label: t('Ignored'), sortName: '' };
  }
}

// Valeurs CSS en px (toute unité, rem compris) : mesurées sur un élément temporaire de la vue.
function readTileMetrics() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;box-sizing:content-box;'
    + 'width:var(--face-tile-size);height:var(--face-tile-gap);padding-left:var(--face-status-bar-width)';
  view().append(probe);
  const size = probe.getBoundingClientRect().width - parseFloat(getComputedStyle(probe).paddingLeft);
  const bar = parseFloat(getComputedStyle(probe).paddingLeft) || 0;
  const gap = probe.getBoundingClientRect().height;
  probe.remove();
  TILE = Math.round(size) > 0 ? Math.round(size) : 120;
  BAR = Math.round(bar);
  GAP = Math.round(gap);
}

function rebuild() {
  readTileMetrics();
  const entries = faces.filter(face => visibleStatuses.has(face.state)).map(face => ({ face, group: groupOf(face) }));
  // Groupes : à valider, personnes (par nom), inconnus, filtrés, ignorés ; dans un groupe, les attributions automatiques avant les
  // confirmées, puis par ressemblance décroissante.
  entries.sort((a, b) => a.group.order - b.group.order
    || a.group.sortName.localeCompare(b.group.sortName)
    || a.group.key.localeCompare(b.group.key)
    || (a.face.state === 'auto' ? 0 : 1) - (b.face.state === 'auto' ? 0 : 1)
    || (b.face.score ?? 0) - (a.face.score ?? 0)
    || a.face.id - b.face.id);
  shown = entries.map(entry => entry.face);
  const width = Math.max(BAR + TILE, scroller().clientWidth - 2 * SIDE_MARGIN);
  const columns = Math.max(1, Math.floor((width - BAR + GAP) / (TILE + GAP)));
  layout = [];
  let y = 0;
  let column = 0;
  let currentGroup = null;
  let currentState = null;
  entries.forEach((entry, index) => {
    const newGroup = entry.group.key !== currentGroup;
    // Une ligne ne mêle pas les états : une nouvelle ligne commence au changement de groupe ou d'état (une seule bande colorée par ligne).
    if (newGroup || entry.face.state !== currentState) {
      if (column !== 0) { y += TILE + GAP; column = 0; }
      currentState = entry.face.state;
    }
    if (newGroup) {
      currentGroup = entry.group.key;
      const count = entries.filter(other => other.group.key === currentGroup).length;
      layout.push({ kind: 'separator', key: `g:${currentGroup}`, x: SIDE_MARGIN, y, label: `${entry.group.label} (${count})` });
      y += SEPARATOR_HEIGHT;
    }
    if (column === 0) layout.push({ kind: 'bar', key: `b:${entry.face.id}`, x: SIDE_MARGIN, y, state: entry.face.state });
    layout.push({ kind: 'face', key: `f:${entry.face.id}`, x: SIDE_MARGIN + BAR + column * (TILE + GAP), y, index });
    column += 1;
    if (column === columns) { column = 0; y += TILE + GAP; }
  });
  if (column !== 0) y += TILE + GAP;
  contentHeight = y;
  content().style.height = `${contentHeight}px`;
  for (const node of renderedNodes.values()) node.remove();
  renderedNodes.clear();
  renderVisible();
  updateToolbar();
}

function renderVisible() {
  const area = scroller();
  const top = area.scrollTop - TILE * 2;
  const bottom = area.scrollTop + area.clientHeight + TILE * 2;
  const visible = new Set();
  for (const item of layout) {
    if (item.y + TILE < top || item.y > bottom) continue;
    visible.add(item.key);
    let node = renderedNodes.get(item.key);
    if (!node) {
      node = item.kind === 'separator' ? createSeparator(item)
        : item.kind === 'bar' ? createStatusBar(item)
        : createTile(shown[item.index]);
      // `translate` (et non `transform`) : la propriété `scale` de la sélection (faces.css) s'applique alors après le déplacement, autour du
      // centre de la vignette. Avec `transform`, elle mettrait aussi la position à l'échelle (vignette décalée d'autant plus qu'elle est loin du coin).
      node.style.translate = `${item.x}px ${item.y}px`;
      renderedNodes.set(item.key, node);
      content().append(node);
    }
    if (item.kind === 'face') node.classList.toggle('selected', selected.has(shown[item.index].id));
  }
  for (const [key, node] of renderedNodes) {
    if (!visible.has(key)) { node.remove(); renderedNodes.delete(key); }
  }
}

// Bande verticale colorée à gauche d'une ligne de vignettes (couleur de l'état commun aux visages de la ligne).
function createStatusBar(item) {
  const node = document.createElement('div');
  node.className = `faces-row-bar state-${item.state}`;
  return node;
}

function createSeparator(item) {
  const node = document.createElement('div');
  node.className = 'group-separator faces-separator';
  const label = document.createElement('span');
  label.className = 'group-separator-label';
  label.textContent = item.label;
  node.append(label);
  return node;
}

const STATE_TITLES = { suggested: 'To confirm', auto: 'Automatic', confirmed: 'Confirmed', unknown: 'Unknown', filtered: 'Filtered', ignored: 'Ignored', not_face: 'Not a face' };

function createTile(face) {
  const node = document.createElement('div');
  node.className = `face-tile state-${face.state}`;
  node.dataset.faceId = String(face.id);
  const image = document.createElement('div');
  image.className = 'face-tile-image';
  loadCrop(image, face);
  const label = document.createElement('span');
  label.className = 'face-tile-label';
  label.textContent = face.state === 'suggested' ? `${face.name ?? '?'} ?` : (face.name ?? '');
  node.append(image, label);
  if (face.score != null && face.state !== 'confirmed') {
    const score = document.createElement('span');
    score.className = 'face-tile-score';
    score.textContent = face.score.toFixed(2);
    node.append(score);
  }
  node.title = `${t(STATE_TITLES[face.state] ?? face.state)}${face.name ? ` · ${face.name}` : ''}${face.score != null ? ` · ${t('similarity')} ${face.score.toFixed(2)}` : ''}`;
  node.addEventListener('click', event => onTileClick(face, event));
  node.addEventListener('dblclick', () => host.openPhotoFullscreen(face.photo_id));
  return node;
}

// Vignette : la zone du visage (orientée comme la miniature), élargie et rendue carrée, découpée dans la miniature en cache.
function loadCrop(element, face) {
  let info = thumbnailInfo.get(face.path);
  if (!info) {
    info = host.getThumbnailUrl(face.path).then(url => new Promise(resolve => {
      if (!url) { resolve(null); return; }
      const probe = new Image();
      probe.onload = () => resolve({ url, width: probe.naturalWidth, height: probe.naturalHeight });
      probe.onerror = () => resolve(null);
      probe.src = url;
    }));
    thumbnailInfo.set(face.path, info);
  }
  info.then(thumbnail => {
    if (!thumbnail || !element.isConnected || !(thumbnail.width > 0 && thumbnail.height > 0)) return;
    const { url, width, height } = thumbnail;
    const rect = orientRect(face, face.orientation);
    const faceWidth = rect.w * width;
    const faceHeight = rect.h * height;
    const side = Math.min(Math.max(faceWidth, faceHeight) * 1.3, width, height);
    const left = Math.min(Math.max(rect.x * width + faceWidth / 2 - side / 2, 0), width - side);
    const top = Math.min(Math.max(rect.y * height + faceHeight / 2 - side / 2, 0), height - side);
    element.style.backgroundImage = `url("${url}")`;
    element.style.backgroundSize = `${(width / side) * 100}% ${(height / side) * 100}%`;
    element.style.backgroundPosition = `${width > side ? (left / (width - side)) * 100 : 0}% ${height > side ? (top / (height - side)) * 100 : 0}%`;
  });
}

// ==========================================
// SÉLECTION
// ==========================================
// Même comportement que la grille des photos : clic = ce visage seul ; Ctrl + clic = ajouté ou retiré ; Maj + clic = plage depuis le dernier
// visage cliqué AJOUTÉE à la sélection existante (sélection discontinue possible), puis ce visage devient le point de départ.
function onTileClick(face, event) {
  const index = shown.indexOf(face);
  if (event.shiftKey && anchorIndex !== null) {
    const [from, to] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
    for (let position = from; position <= to; position++) selected.add(shown[position].id);
    anchorIndex = index;
  } else if (event.ctrlKey || event.metaKey) {
    if (selected.has(face.id)) selected.delete(face.id); else selected.add(face.id);
    anchorIndex = index;
  } else {
    selected = new Set([face.id]);
    anchorIndex = index;
  }
  renderVisible();
  updateToolbar();
  // Les panneaux de droite (Info, Mots-clés) suivent les photos des visages sélectionnés.
  host.selectPhotos(selectedFaces().map(item => item.photo_id), face.photo_id);
}

function selectedFaces() {
  return shown.filter(face => selected.has(face.id));
}

// ==========================================
// BARRE D'OUTILS : FILTRE PAR STATUT, ACTIONS
// ==========================================
function renderStatusFilters() {
  const container = document.getElementById('faces-status-filters');
  container.replaceChildren(...STATUSES.map(status => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `faces-status-chip state-${status.id}${visibleStatuses.has(status.id) ? ' active' : ''}`;
    button.setAttribute('aria-pressed', String(visibleStatuses.has(status.id)));
    const count = faces.filter(face => face.state === status.id).length;
    button.textContent = `${t(status.label)} (${count})`;
    button.addEventListener('click', () => {
      if (visibleStatuses.has(status.id)) visibleStatuses.delete(status.id); else visibleStatuses.add(status.id);
      saveStatuses();
      renderStatusFilters();
      rebuild();
    });
    return button;
  }));
}

function updateToolbar() {
  renderStatusFilters();
  const targets = selectedFaces();
  const count = document.getElementById('faces-count');
  count.textContent = targets.length > 0
    ? tp('{count} face selected', targets.length)
    : tp('{count} face shown', shown.length);
  const hasConfirmable = targets.some(face => face.state === 'suggested' || face.state === 'auto');
  document.getElementById('btn-faces-confirm').disabled = !hasConfirmable;
  document.getElementById('btn-faces-name').disabled = targets.length === 0;
  document.getElementById('btn-faces-unknown').disabled = !targets.some(face => face.person_id != null || face.suggested_person_id != null);
  const ignored = targets.filter(face => face.state === 'ignored');
  document.getElementById('btn-faces-ignore').disabled = targets.length === ignored.length;
  document.getElementById('btn-faces-unignore').hidden = ignored.length === 0;
  const notFaces = targets.filter(face => face.state === 'not_face');
  document.getElementById('btn-faces-not-face').disabled = targets.length === notFaces.length;
  document.getElementById('btn-faces-is-face').hidden = notFaces.length === 0;
  updateWriteButton();
}

// « Écrire dans les fichiers (N photos) » : visages en attente de toute la photothèque ; grisé pendant une écriture ou sans rien à écrire.
function updateWriteButton() {
  const button = document.getElementById('btn-faces-write');
  const pending = getPendingFaceWriteCount();
  button.textContent = tp('Write to files ({count} photo)', pending);
  button.disabled = pending === 0 || isWriteLocked();
}

function writeFaces() {
  if (getPendingFaceWriteCount() === 0 || isWriteLocked()) return;
  applyPending({ includeLibrary: true });
}

// Action de révision sur les visages sélectionnés, puis réattribution des autres visages des photos affichées et rechargement.
async function runAction(command, extraArgs = {}) {
  const targets = selectedFaces();
  if (targets.length === 0) return null;
  let result;
  try {
    result = await invoke(command, { faceIds: targets.map(face => face.id), ...extraArgs });
  } catch (error) {
    host.showToast(reviewErrorMessage(error));
    return null;
  }
  try {
    await invoke('recognize_faces', { photoIds: host.getDisplayedPhotoIds() });
  } catch (error) {
    console.error('Réattribution impossible', error);
  }
  await refreshFaces(); // section Personnes, filtre, et cette vue (voir faces-panel.js)
  return result;
}

function reviewErrorMessage(error) {
  const messages = {
    invalid_name: t('Names cannot be empty or contain "|" or ","'),
    person_name_taken: t('Another person already has this name'),
    keyword_taken: t('This keyword is already linked to another person'),
    unknown_person: t('This person no longer exists'),
    unknown_keyword: t('No keyword has this path'),
  };
  return messages[String(error)] ?? String(error);
}

// Nommer : une personne existante, un chemin de mot-clé de l'arbre (personne créée et reliée si besoin), ou un nouveau nom (personne reliée à
// un nouveau mot-clé sous la racine réglée dans Paramètres > Visages). « / » sépare les niveaux : « gaetan/gaetan m » crée le mot-clé
// « <racine>/gaetan/gaetan m » pour la personne « gaetan m ». `typed` : premier caractère tapé sur la vignette (saisie directe).
async function nameSelection(typed = null) {
  const targets = selectedFaces();
  if (targets.length === 0) return;
  let paths;
  try {
    paths = await keywordPaths();
  } catch {
    paths = new Map();
  }
  const persons = getPersons();
  const normalize = text => text.split('/').map(segment => segment.trim().toLowerCase()).filter(Boolean).join('/');
  // Propositions : les personnes, et les mots-clés situés sous la racine des personnes (Paramètres > Visages) ; sans racine, tout l'arbre.
  const rootKey = normalize(host.getPersonRoot());
  const keywordSuggestions = [...paths.values()].filter(path => !rootKey || normalize(path).startsWith(`${rootKey}/`));
  const suggestions = [...new Set([...persons.map(person => person.name), ...keywordSuggestions])].sort((a, b) => a.localeCompare(b));
  const proposed = typed ?? targets.find(face => face.name)?.name ?? '';
  await promptDialog({
    title: t('Name the faces'),
    message: tp('Person shown on the {count} selected face (existing person, keyword path, or new name)', targets.length),
    inputLabel: t('Name'),
    confirmLabel: t('Name'),
    cancelLabel: t('Cancel'),
    value: proposed,
    selectValue: typed === null,
    suggestions,
    onSubmit: async value => {
      const segments = value.split('/').map(segment => segment.trim()).filter(Boolean);
      if (segments.length === 0 || segments.some(segment => /[|,]/.test(segment))) return t('Names cannot be empty or contain "|" or ","');
      const wanted = segments.join('/');
      const root = host.getPersonRoot();
      const person = segments.length === 1 ? persons.find(item => item.name.toLowerCase() === wanted.toLowerCase()) : null;
      // Mot-clé existant : chemin complet, ou chemin sous la racine des personnes.
      const keyword = [...paths.entries()].find(([, path]) => normalize(path) === normalize(wanted) || (root && normalize(path) === normalize(`${root}/${wanted}`)));
      const args = person ? { personId: person.id }
        : keyword ? { keywordId: keyword[0] }
        : { name: segments.at(-1), root: [root, ...segments.slice(0, -1)].filter(Boolean).join('/') };
      try {
        await invoke('assign_faces', { faceIds: targets.map(face => face.id), ...args });
      } catch (error) {
        return reviewErrorMessage(error);
      }
      try { await invoke('recognize_faces', { photoIds: host.getDisplayedPhotoIds() }); } catch { /* réattribution facultative */ }
      await refreshFaces();
      return null;
    },
  });
}

// ==========================================
// INITIALISATION
// ==========================================
// hostApi : getDisplayedPhotoIds(), getThumbnailUrl(path), selectPhotos(photoIds, mainPhotoId), openPhotoFullscreen(photoId), setPhotoGridVisible(visible), showToast(message),
// getPersonRoot(), isFullscreen().
export function initFacesGrid(hostApi) {
  host = hostApi;
  let scrollPending = false;
  scroller().addEventListener('scroll', () => {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => { scrollPending = false; renderVisible(); });
  });
  window.addEventListener('resize', () => { if (open) rebuild(); });
  // Clic dans une zone vide de la grille (ni vignette, ni modificateur) : tous les visages sont désélectionnés.
  scroller().addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('.face-tile')) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || selected.size === 0) return;
    selected.clear();
    anchorIndex = null;
    renderVisible();
    updateToolbar();
  });
  document.getElementById('btn-toggle-faces').addEventListener('click', toggleFacesView);
  document.getElementById('btn-faces-confirm').addEventListener('click', () => runAction('confirm_faces'));
  document.getElementById('btn-faces-name').addEventListener('click', () => nameSelection());
  document.getElementById('btn-faces-unknown').addEventListener('click', () => runAction('set_faces_unknown'));
  document.getElementById('btn-faces-ignore').addEventListener('click', () => runAction('ignore_faces'));
  document.getElementById('btn-faces-unignore').addEventListener('click', () => runAction('unignore_faces'));
  document.getElementById('btn-faces-not-face').addEventListener('click', () => runAction('mark_faces_not_a_face'));
  document.getElementById('btn-faces-is-face').addEventListener('click', () => runAction('unmark_faces_not_a_face'));
  // Clavier de la vue : Entrée valide, Ctrl + A sélectionne tout, Échap désélectionne. Les raccourcis des photos sont coupés pendant ce temps
  // (voir le gestionnaire de main.js).
  document.getElementById('btn-faces-write').addEventListener('click', writeFaces);
  onLockChange(() => { if (open) updateWriteButton(); });
  // Ctrl + Entrée : écriture des visages en attente. Écouté en phase de capture, avant le Ctrl + Entrée du panneau Mots-clés.
  window.addEventListener('keydown', event => {
    if (!open || host.isFullscreen() || document.querySelector('.modal:not(.hidden)')) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key !== 'Enter') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) writeFaces();
  }, true);
  window.addEventListener('keydown', event => {
    if (!open || host.isFullscreen() || document.querySelector('.modal:not(.hidden)')) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!document.getElementById('btn-faces-confirm').disabled) runAction('confirm_faces');
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey && selected.size > 0) {
      // Saisie directe : une lettre tapée sur les visages sélectionnés ouvre « Nommer » avec cette lettre.
      event.preventDefault();
      nameSelection(event.key);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selected = new Set(shown.map(face => face.id));
      renderVisible();
      updateToolbar();
    } else if (event.key === 'Escape' && selected.size > 0) {
      event.preventDefault();
      selected.clear();
      renderVisible();
      updateToolbar();
    }
  });
  onLanguageChange(() => { if (open) rebuild(); });
}
