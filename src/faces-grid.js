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
import { orientRect, refreshFaces, getPendingFaceWriteCount, getPendingFaceWritePhotoIds, getPersonFilterIds, promptPersonName, faceNameErrorMessage } from './faces-panel.js';
import { applyPending, isWriteLocked, onLockChange } from './metadata-writes.js';

const STATUSES_STORAGE_KEY = 'facesViewStatuses';
// Statuts dans l'ordre d'affichage des groupes, avec la clé de traduction de leur nom.
const STATUSES = [
  { id: 'suggested', label: 'To confirm' },
  { id: 'auto', label: 'Automatic', chip: 'Auto' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'unknown', label: 'Unknown faces', chip: 'Unknowns' },
  { id: 'filtered', label: 'Filtered' },
  { id: 'ignored', label: 'Ignored' },
  { id: 'not_face', label: 'Not faces', chip: 'Faces' }, // pastille courte, affichée barrée (voir faces.css) ; l'infobulle porte le nom complet
];
const DEFAULT_STATUSES = ['suggested', 'auto', 'confirmed', 'unknown'];
// Dimensions des vignettes : lues dans le CSS (variables de .faces-view, voir faces.css) à chaque reconstruction.
let TILE = 120; // côté d'une vignette carrée (px)
let BAR = 0; // largeur de la bande d'état, à gauche de chaque ligne (px)
let GAP = 0; // espacement entre vignettes (px)
let SEPARATOR_HEIGHT = 40; // hauteur d'un titre de groupe (px) : lue dans --face-separator-height (faces.css, en rem)
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
let selectionOrder = []; // identifiants dans l'ordre où ils ont été sélectionnés (le dernier sert à placer la barre d'actions verticale)
let verticalBar = false; // plus de MAX_COLUMNS_BOTTOM_BAR vignettes en largeur : barre d'actions verticale à droite (voir rebuild)
let faceRows = new Map(); // identifiant de visage -> ordonnée (px) de sa ligne dans la grille
const MAX_COLUMNS_BOTTOM_BAR = 5;
let BAR_RESERVE = 0; // largeur réservée à droite de la grille pour la barre verticale (px), lue dans --face-bar-reserve
let loadToken = 0;
// Regroupement des inconnus (DBSCAN, « Regrouper les inconnus ») : identifiant de visage -> numéro de groupe (1 = le plus grand) ; null = non regroupés.
// Gardé tant que la vue reste ouverte (les visages nommés en sortent d'eux-mêmes) ; un second clic sur le bouton l'annule.
let clusters = null;
let groupKeyOf = new Map(); // identifiant de visage -> clé de son groupe affiché
// « Visages en attente » : la vue montre les visages à écrire de toute la photothèque (au lieu de ceux des photos affichées).
let pendingMode = false;
// Filtre par origine : visages détectés, importés des fichiers, dessinés à la main.
const ORIGINS = [
  { id: 'detected', label: 'Detected' },
  { id: 'imported', label: 'Imported' },
  { id: 'manual', label: 'Manual' },
];
const ORIGINS_STORAGE_KEY = 'facesViewOrigins';
let visibleOrigins = loadOrigins();
const renderedNodes = new Map(); // clé de l'élément de layout -> nœud
const thumbnailInfo = new Map(); // chemin de la photo -> Promise<{ url, width, height } | null>

const view = () => document.getElementById('faces-view');
const scroller = () => document.getElementById('faces-scroll');
const content = () => document.getElementById('faces-content');

function loadOrigins() {
  try {
    const stored = JSON.parse(localStorage.getItem(ORIGINS_STORAGE_KEY));
    if (Array.isArray(stored)) return new Set(stored.filter(id => ORIGINS.some(origin => origin.id === id)));
  } catch { /* valeur absente ou illisible */ }
  return new Set(ORIGINS.map(origin => origin.id));
}

function renderOriginFilters() {
  const container = document.getElementById('faces-origin-filters');
  container.replaceChildren(...ORIGINS.map(origin => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `faces-status-chip faces-origin-chip${visibleOrigins.has(origin.id) ? ' active' : ''}`;
    button.setAttribute('aria-pressed', String(visibleOrigins.has(origin.id)));
    button.append(...chipContent(t(origin.label), scopedFaces().filter(face => face.origin === origin.id).length));
    button.addEventListener('click', () => {
      if (visibleOrigins.has(origin.id)) visibleOrigins.delete(origin.id); else visibleOrigins.add(origin.id);
      try { localStorage.setItem(ORIGINS_STORAGE_KEY, JSON.stringify([...visibleOrigins])); } catch { /* stockage indisponible */ }
      rebuild();
    });
    return button;
  }));
}

// « Regrouper les inconnus » : groupes de visages inconnus ressemblants parmi les photos affichées (second clic : annule le regroupement).
async function toggleClusters() {
  const button = document.getElementById('btn-faces-cluster');
  if (clusters) {
    clusters = null;
    button.classList.remove('active');
    rebuild();
    return;
  }
  button.disabled = true;
  let groups;
  try {
    groups = await invoke('cluster_unknown_faces', { photoIds: host.getDisplayedPhotoIds() });
  } catch (error) {
    host.showToast(String(error));
    return;
  } finally {
    button.disabled = false;
  }
  clusters = new Map();
  groups.forEach((ids, index) => { for (const id of ids) clusters.set(id, index + 1); });
  button.classList.add('active');
  if (!visibleStatuses.has('unknown')) {
    visibleStatuses.add('unknown');
    saveStatuses();
  }
  rebuild();
  host.showToast(tp('{count} group of similar unknown faces', groups.length));
}

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
  host.closePersonsView(); // une seule des deux vues (Personnes, gestion) à la fois
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
  // Le regroupement vaut pour les photos affichées à ce moment : il n'est pas conservé d'une ouverture à l'autre.
  clusters = null;
  document.getElementById('btn-faces-cluster')?.classList.remove('active');
  pendingMode = false;
  document.getElementById('btn-faces-pending')?.classList.remove('active');
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
  const photoIds = pendingMode ? getPendingFaceWritePhotoIds() : host.getDisplayedPhotoIds();
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
// Nom affiché d'un visage : l'alias de sa personne s'il est défini, sinon le nom (mot-clé). La fenêtre « Nommer » garde le nom.
const shownName = face => face.alias || face.name;

// Visages concernés avant les filtres de statut et d'origine : ceux en attente d'écriture (mode « Visages en attente ») ; sinon, si des personnes
// sont choisies (section ou filtre Personnes, « Gérer ses visages »), seulement les leurs (attribués, ou suggérés pour elles) ; sinon tous ceux des
// photos affichées.
function scopedFaces() {
  if (pendingMode) return faces.filter(face => face.dirty);
  const personIds = new Set(getPersonFilterIds());
  if (personIds.size === 0) return faces;
  return faces.filter(face => personIds.has(face.person_id) || (face.state === 'suggested' && personIds.has(face.suggested_person_id)));
}

function groupOf(face) {
  switch (face.state) {
    case 'suggested': return { order: 0, key: `s${face.suggested_person_id}`, label: t('To confirm: {name}', { name: shownName(face) ?? '?' }), sortName: shownName(face) ?? '' };
    case 'auto':
    case 'confirmed': return { order: 1, key: `p${face.person_id}`, label: shownName(face) ?? '?', sortName: shownName(face) ?? '' };
    case 'unknown': {
      // Inconnus regroupés (« Regrouper les inconnus ») : un groupe par ressemblance, du plus grand au plus petit, puis les visages isolés.
      const cluster = clusters?.get(face.id);
      if (cluster) return { order: 2, key: `c${cluster}`, label: t('Unknown no. {number}', { number: cluster }), sortName: String(cluster).padStart(6, '0') };
      return { order: 2.5, key: 'unknown', label: t(clusters ? 'Other unknown faces' : 'Unknown faces'), sortName: '' };
    }
    case 'filtered': return { order: 3, key: 'filtered', label: t('Filtered (below the thresholds)'), sortName: '' };
    case 'not_face': return { order: 5, key: 'not_face', label: t('Not faces'), sortName: '' };
    default: return { order: 4, key: 'ignored', label: t('Ignored'), sortName: '' };
  }
}

// Valeurs CSS en px (toute unité, rem compris) : mesurées sur un élément temporaire de la vue.
function readTileMetrics() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;box-sizing:content-box;'
    + 'width:var(--face-tile-size);height:var(--face-tile-gap);padding-left:var(--face-status-bar-width);padding-top:var(--face-separator-height);margin-left:var(--face-bar-reserve)';
  view().append(probe);
  const size = probe.getBoundingClientRect().width - parseFloat(getComputedStyle(probe).paddingLeft);
  const bar = parseFloat(getComputedStyle(probe).paddingLeft) || 0;
  const separator = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  BAR_RESERVE = Math.round(parseFloat(getComputedStyle(probe).marginLeft) || 0);
  const gap = probe.getBoundingClientRect().height - separator;
  probe.remove();
  if (Math.round(separator) > 0) SEPARATOR_HEIGHT = Math.round(separator);
  TILE = Math.round(size) > 0 ? Math.round(size) : 120;
  BAR = Math.round(bar);
  GAP = Math.round(gap);
}

function rebuild() {
  readTileMetrics();
  // En mode « Visages en attente », tous les visages à écrire sont montrés, quels que soient les filtres de statut et d'origine.
  const entries = scopedFaces()
    .filter(face => pendingMode || (visibleStatuses.has(face.state) && visibleOrigins.has(face.origin)))
    .map(face => ({ face, group: groupOf(face) }));
  groupKeyOf = new Map(entries.map(entry => [entry.face.id, entry.group.key]));
  // Groupes : à valider, personnes (par nom), inconnus, filtrés, ignorés ; dans un groupe, les attributions automatiques avant les
  // confirmées, puis par ressemblance décroissante.
  entries.sort((a, b) => a.group.order - b.group.order
    || a.group.sortName.localeCompare(b.group.sortName)
    || a.group.key.localeCompare(b.group.key)
    || (a.face.state === 'auto' ? 0 : 1) - (b.face.state === 'auto' ? 0 : 1)
    || (b.face.score ?? 0) - (a.face.score ?? 0)
    || a.face.id - b.face.id);
  shown = entries.map(entry => entry.face);
  const fullWidth = Math.max(BAR + TILE, scroller().clientWidth - 2 * SIDE_MARGIN);
  const columnsFor = available => Math.max(1, Math.floor((available - BAR + GAP) / (TILE + GAP)));
  // Plus de 5 vignettes en largeur : la barre d'actions passe à droite, à la verticale, et une marge de sa largeur lui est réservée (le nombre de
  // colonnes se calcule alors sans elle, sans que la barre revienne en bas si ce nombre tombe à 5).
  verticalBar = columnsFor(fullWidth) > MAX_COLUMNS_BOTTOM_BAR;
  document.getElementById('faces-action-bar').classList.toggle('vertical', verticalBar);
  const columns = columnsFor(verticalBar ? fullWidth - BAR_RESERVE : fullWidth);
  layout = [];
  faceRows = new Map();
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
      layout.push({ kind: 'separator', key: `g:${currentGroup}`, x: SIDE_MARGIN, y, label: entry.group.label, count, group: currentGroup });
      y += SEPARATOR_HEIGHT;
    }
    if (column === 0) layout.push({ kind: 'bar', key: `b:${entry.face.id}`, x: SIDE_MARGIN, y, state: entry.face.state });
    layout.push({ kind: 'face', key: `f:${entry.face.id}`, x: SIDE_MARGIN + BAR + column * (TILE + GAP), y, index });
    faceRows.set(entry.face.id, y);
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

// Compteur d'un titre de groupe ou d'une pastille : même présentation partout, sans parenthèses.
function countBadge(count) {
  const badge = document.createElement('span');
  badge.className = 'faces-count-badge';
  badge.textContent = String(count);
  return badge;
}

function chipContent(label, count) {
  const text = document.createElement('span');
  text.className = 'faces-chip-label';
  text.textContent = label;
  return [text, countBadge(count)];
}

function createSeparator(item) {
  const node = document.createElement('div');
  node.className = 'group-separator faces-separator';
  // Clic sur le titre d'un groupe : tous ses visages sont sélectionnés (ex. nommer d'un coup un groupe d'inconnus) ; Ctrl + clic : ajoutés.
  node.title = t('Click: select the faces of this group (Ctrl+click: add them)');
  node.addEventListener('click', event => {
    event.stopPropagation();
    const ids = shown.filter(face => groupKeyOf.get(face.id) === item.group).map(face => face.id);
    if (!(event.ctrlKey || event.metaKey)) { selected.clear(); selectionOrder = []; }
    for (const id of ids) selected.add(id);
    selectionOrder.push(...ids.slice().reverse()); // le premier visage du groupe compte comme le dernier sélectionné : la barre se place en haut du groupe
    renderVisible();
    updateToolbar();
  });
  const label = document.createElement('span');
  label.className = 'group-separator-label';
  label.textContent = item.label;
  node.append(label, countBadge(item.count));
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
  label.textContent = face.state === 'suggested' ? `${shownName(face) ?? '?'} ?` : (shownName(face) ?? '');
  node.append(image, label);
  if (face.score != null && face.state !== 'confirmed') {
    const score = document.createElement('span');
    score.className = 'face-tile-score';
    score.textContent = face.score.toFixed(2);
    node.append(score);
  }
  node.title = `${t(STATE_TITLES[face.state] ?? face.state)}${shownName(face) ? ` · ${shownName(face)}` : ''}${face.score != null ? ` · ${t('similarity')} ${face.score.toFixed(2)}` : ''}`;
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
    selectionOrder.push(face.id);
    anchorIndex = index;
  } else if (event.ctrlKey || event.metaKey) {
    if (selected.has(face.id)) selected.delete(face.id); else { selected.add(face.id); selectionOrder.push(face.id); }
    anchorIndex = index;
  } else {
    selected = new Set([face.id]);
    selectionOrder = [face.id];
    anchorIndex = index;
  }
  renderVisible();
  updateToolbar();
  // Les panneaux de droite (Info, Mots-clés) suivent les photos des visages sélectionnés.
  host.selectPhotos(selectedFaces().map(item => item.photo_id), face.photo_id);
}

// Barre d'actions verticale (à droite) : son haut est aligné avec la dernière vignette sélectionnée dans le temps ; elle suit donc la sélection et
// le défilement, en restant entièrement visible. Barre du bas : aucun placement à calculer.
function positionActionBar() {
  const bar = document.getElementById('faces-action-bar');
  if (!verticalBar || bar.hidden) { bar.style.removeProperty('top'); return; }
  const area = scroller();
  let id = null;
  for (let index = selectionOrder.length - 1; index >= 0 && id === null; index--) if (selected.has(selectionOrder[index])) id = selectionOrder[index];
  if (id === null) id = shown.find(face => selected.has(face.id))?.id ?? null;
  const row = id === null ? undefined : faceRows.get(id);
  if (row === undefined) return;
  // Écart entre la barre de défilement et le bord droit de la vue : la barre se place à gauche de la barre de défilement.
  bar.style.setProperty('--face-bar-scrollbar', `${area.offsetWidth - area.clientWidth}px`);
  const wanted = area.offsetTop + row - area.scrollTop;
  const lowest = area.offsetTop + area.clientHeight - bar.offsetHeight - 8;
  bar.style.top = `${Math.max(area.offsetTop + 8, Math.min(wanted, lowest))}px`;
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
    const count = scopedFaces().filter(face => face.state === status.id).length;
    button.append(...chipContent(t(status.chip ?? status.label), count));
    // Pastille raccourcie : le nom complet reste disponible en infobulle et pour les lecteurs d'écran.
    if (status.chip) {
      button.title = t(status.label);
      button.setAttribute('aria-label', `${t(status.label)} : ${count}`);
    }
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
  renderOriginFilters();
  const targets = selectedFaces();
  document.getElementById('faces-count').textContent = tp('{count} face shown', shown.length);
  // Barre d'actions flottante : visible seulement quand des visages sont sélectionnés.
  const actionBar = document.getElementById('faces-action-bar');
  actionBar.hidden = targets.length === 0;
  document.getElementById('faces-selection-label').textContent = tp('{count} face selected', targets.length);
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
  // Visage représentatif : un seul visage, attribué à une personne (automatiquement ou confirmé).
  document.getElementById('btn-faces-cover').disabled = !(targets.length === 1 && targets[0].person_id != null);
  positionActionBar();
  updateWriteButton();
}

// « Visage représentatif » : ce visage devient l'image de sa personne (section et vue Personnes ; vignette régénérée depuis la photo d'origine).
async function useAsCover() {
  const [face] = selectedFaces();
  if (!face || face.person_id == null) return;
  try {
    await invoke('set_person_cover', { personId: face.person_id, faceId: face.id });
  } catch (error) {
    host.showToast(String(error));
    return;
  }
  await refreshFaces();
  host.showToast(t('Cover face of {name} changed', { name: shownName(face) ?? '?' }));
}

// « Écrire dans les fichiers » (toujours présent, grisé pendant une écriture ou sans rien à écrire) suivi, s'il y a des visages en attente de
// toute la photothèque, du bouton « N photos » (vert, comme Confirmé) qui bascule l'affichage de ces visages.
function updateWriteButton() {
  const button = document.getElementById('btn-faces-write');
  const pending = getPendingFaceWriteCount();
  button.disabled = pending === 0 || isWriteLocked();
  const pendingButton = document.getElementById('btn-faces-pending');
  if (pending === 0 && pendingMode) setPendingMode(false);
  pendingButton.textContent = tp('{count} photo', pending);
  pendingButton.hidden = pending === 0;
}

// Bouton « N photos » : bascule entre les visages à écrire de toute la photothèque et ceux des photos affichées.
function setPendingMode(enabled) {
  pendingMode = enabled;
  const button = document.getElementById('btn-faces-pending');
  button.classList.toggle('active', enabled);
  button.setAttribute('aria-pressed', String(enabled));
  selected.clear();
  selectionOrder = [];
  anchorIndex = null;
  reloadFacesView();
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
    host.showToast(faceNameErrorMessage(error));
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

// Nommer les visages sélectionnés (fenêtre partagée avec le plein écran : faces-panel.js, promptPersonName). `typed` : premier caractère tapé
// sur la vignette (saisie directe).
async function nameSelection(typed = null) {
  const targets = selectedFaces();
  if (targets.length === 0) return;
  await promptPersonName({
    title: t('Name the faces'),
    message: tp('Person shown on the {count} selected face (existing person, keyword path, or new name)', targets.length),
    proposed: typed ?? targets.find(face => face.name)?.name ?? '',
    selectValue: typed === null,
    submit: async args => {
      await invoke('assign_faces', { faceIds: targets.map(face => face.id), ...args });
      try { await invoke('recognize_faces', { photoIds: host.getDisplayedPhotoIds() }); } catch { /* réattribution facultative */ }
      await refreshFaces();
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
    requestAnimationFrame(() => { scrollPending = false; renderVisible(); positionActionBar(); });
  });
  window.addEventListener('resize', () => { if (open) rebuild(); });
  // La largeur de la vue change aussi sans que la fenêtre bouge (aperçu ou panneaux affichés ou masqués) : les vignettes sont alors replacées.
  // On observe la vue entière (sa largeur ne dépend pas de la barre de défilement) et on ne réagit qu'à un vrai changement de largeur.
  const facesView = document.getElementById('faces-view');
  let observedWidth = facesView.clientWidth;
  new ResizeObserver(() => {
    const width = facesView.clientWidth;
    if (width === observedWidth) return;
    observedWidth = width;
    if (open && width > 0) rebuild();
  }).observe(facesView);
  // Clic dans une zone vide de la grille (ni vignette, ni modificateur) : tous les visages sont désélectionnés.
  scroller().addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('.face-tile')) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || selected.size === 0) return;
    selected.clear();
    selectionOrder = [];
    anchorIndex = null;
    renderVisible();
    updateToolbar();
  });
  // Le bouton « Visages » de la barre du haut ouvre la vue Personnes (main.js) ; cette vue a son bouton de retour vers elle.
  document.getElementById('btn-faces-persons').addEventListener('click', () => host.openPersonsView());
  // Après un clic dans la barre d'actions, le focus revient à la grille : sinon Entrée (valider) activerait aussi le bouton resté actif.
  document.getElementById('faces-action-bar').addEventListener('click', () => scroller().focus({ preventScroll: true }));
  document.getElementById('btn-faces-cover').addEventListener('click', useAsCover);
  document.getElementById('btn-faces-cluster').addEventListener('click', toggleClusters);
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
  document.getElementById('btn-faces-pending').addEventListener('click', () => setPendingMode(!pendingMode));
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
    } else if (['-', '/', 'Delete'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // - : Inconnu ; / : Ignorer ; Suppr : Pas un visage. Même effet que les boutons de la barre d'actions (et seulement s'ils sont actifs) ; ces
      // touches ne sont pas prises pour le début d'un nom. Inactives pendant la fenêtre « Nommer » (fenêtre modale : voir le garde plus haut).
      event.preventDefault();
      const button = document.getElementById({ '-': 'btn-faces-unknown', '/': 'btn-faces-ignore', Delete: 'btn-faces-not-face' }[event.key]);
      if (!event.repeat && selected.size > 0 && !button.disabled) button.click();
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey && selected.size > 0) {
      // Saisie directe : une lettre tapée sur les visages sélectionnés ouvre « Nommer » avec cette lettre.
      event.preventDefault();
      nameSelection(event.key);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selected = new Set(shown.map(face => face.id));
      selectionOrder = shown.map(face => face.id).reverse();
      renderVisible();
      updateToolbar();
    } else if (event.key === 'Escape' && selected.size > 0) {
      event.preventDefault();
      selected.clear();
      selectionOrder = [];
      renderVisible();
      updateToolbar();
    }
  });
  onLanguageChange(() => { if (open) rebuild(); });
}
