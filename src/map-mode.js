// Mode Carte (bouton « Carte » de la barre du haut) : une carte à la place de l'aperçu (ou sous lui, les deux se partagent la hauteur) qui montre
// où sont les photos affichées et permet de géolocaliser la sélection.
// - Carte : toutes les photos géolocalisées de la grille en points discrets, la sélection en évidence (photo active = couleur de sélection,
//   autres photos sélectionnées en bleu), les zones hors ligne en pointillés (vertes si privées, noires sinon).
// - Filtre de la grille : « Toutes les photos », ou « Zone visible seulement » (seules les photos de la zone visible de la carte).
// - Affectation : Maj + glisser la sélection sur la carte (le dépôt est géré par main.js, voir dragOverMap / dropOnMap), ou clic droit sur la
//   carte > « Placer la sélection ici ». Les positions restent EN ATTENTE jusqu'à « Écrire dans les fichiers » : elles s'écrivent avec le circuit
//   des mots-clés (metadata-writes.js, commande apply_metadata_changes) et, comme les visages, concernent toute la photothèque : demandées à la
//   fermeture de l'application et en quittant le mode, jamais perdues sans question.
// Le widget carte du panneau Info est désactivé tant que ce mode est ouvert (un seul contexte WebGL).

import { t, tp, onLanguageChange } from './i18n.js';
import { createMapView } from './map-view.js';
import { ensureZonesLoaded, getZones, onZonesChange, zonesFeatureCollection } from './private-zones.js';
import { openPrivateZonesModal } from './private-zones-modal.js';
import { registerEditor, notifyPendingChange, onPendingChange, onLockChange, isWriteLocked, writeMetadataItems, choiceDialog } from './metadata-writes.js';
import { setMapSuppressed } from './location-panel.js';
import { initPlaceSearch, updatePlaceSearchAvailability } from './place-search.js';
import './map-mode.css';

const SELECTION_DELAY_MS = 120; // navigation rapide au clavier : seule la dernière sélection est montrée
const FILTER_DELAY_MS = 500;
const PLACE_SEARCH_ZOOM = 17; // niveau de la carte sur un lieu trouvé par la recherche // la grille suit la carte 500 ms après la fin du déplacement ou du dernier cran de molette
const SAME_PLACE = 1e-4; // écart toléré entre la position en attente et celle relue dans le fichier (arrondis des formats)

let host = null; // services de main.js, voir initMapMode
let open = false;
let filterMode = 'all'; // 'all' ou 'visible'
const pending = new Map(); // identifiant de photo -> { photoId, path, lat, lon, hadPosition }
let mapView = null;
let panel, canvas, message, writeButton, revertButton, pendingLabel, dropHint, toggleButton;
let selectionTimer = 0;
let filterTimer = 0;
let boundMap = null;
let lastPhotos = null;
let mapStatus = 'ready';
let firstFraming = true;

const hasGps = photo => Number.isFinite(photo?.gps_lat) && Number.isFinite(photo?.gps_lon);
const isMapEnabled = () => { try { return localStorage.getItem('showMap') === 'true'; } catch { return false; } };

/** Position à prendre en compte pour une photo : celle en attente, sinon celle de la base ; null si elle n'en a pas. */
export function positionOf(photo) {
  const waiting = pending.get(photo?.id);
  if (waiting) return { lat: waiting.lat, lon: waiting.lon };
  return hasGps(photo) ? { lat: photo.gps_lat, lon: photo.gps_lon } : null;
}

export const hasPendingPosition = photo => pending.has(photo?.id);
export const isMapModeOpen = () => open;

/** Zone visible de la carte quand le filtre « Zone visible seulement » est actif (enregistrée dans un album intelligent), sinon null. */
export function getVisibleZone() {
  if (!open || filterMode !== 'visible') return null;
  const map = mapView?.getMap();
  if (!map) return null;
  const bounds = map.getBounds();
  return { south: bounds.getSouth(), north: bounds.getNorth(), west: bounds.getWest(), east: bounds.getEast() };
}

/** Filtre « Zone visible seulement » : vrai si la photo reste affichée dans la grille. */
export function passesMapFilter(photo) {
  if (!open || filterMode !== 'visible') return true;
  const map = mapView?.getMap();
  const position = positionOf(photo);
  if (!position) return false;
  if (!map) return true; // carte pas encore créée : rien n'est filtré
  const bounds = map.getBounds();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const inLatitude = position.lat >= bounds.getSouth() && position.lat <= bounds.getNorth();
  const inLongitude = west <= east ? position.lon >= west && position.lon <= east : position.lon >= west || position.lon <= east;
  return inLatitude && inLongitude;
}

// ---------------------------------------------------------------------------
// Points de la carte
// ---------------------------------------------------------------------------

function selectionPoints() {
  const { selection, focus } = host.getSelection();
  const points = [];
  for (const photo of selection) {
    const position = positionOf(photo);
    if (!position) continue;
    const isFocus = photo === focus;
    points.push({ ...position, focus: isFocus, other: !isFocus, pending: pending.has(photo.id) });
  }
  if (!points.some(point => point.focus) && points[0]) { points[0].focus = true; points[0].other = false; }
  return points;
}

function refreshBackdrop() {
  if (!open) return;
  lastPhotos = host.getMapPhotos();
  const points = [];
  for (const photo of lastPhotos) {
    const position = positionOf(photo);
    if (position) points.push({ ...position, pending: pending.has(photo.id) });
  }
  mapView.setBackdrop(points);
}

function refreshSelectionNow() {
  if (!open || !mapView) return;
  const points = selectionPoints();
  // Pas de recadrage forcé : la carte ne bouge que si la sélection est hors de la zone visible, et jamais en mode « Zone visible seulement »
  // (le recadrage changerait les photos affichées, donc la sélection).
  mapView.show(points, { strict: false }, { frame: false });
  if (points.length && (firstFraming || filterMode === 'all')) mapView.frameTo(points, { onlyIfOutside: !firstFraming });
  if (points.length) firstFraming = false;
  bindMapEvents();
}

/** À appeler quand la sélection ou la liste des photos affichées a changé. */
export function refreshMapMode() {
  if (!open) return;
  if (host.getMapPhotos() !== lastPhotos) refreshBackdrop();
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(refreshSelectionNow, SELECTION_DELAY_MS);
}

function refreshAll() {
  refreshBackdrop();
  clearTimeout(selectionTimer);
  refreshSelectionNow();
  updateControls();
  host.refreshThumbnails();
  if (filterMode === 'visible') applyVisibleFilter(); // positions en attente : photos qui entrent ou sortent de la zone
}

function showZones() {
  if (!open) return;
  mapView.showZones(zonesFeatureCollection(getZones()));
}

// ---------------------------------------------------------------------------
// Événements de la carte
// ---------------------------------------------------------------------------

function normalizeLongitude(longitude) {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

function pointAt(clientX, clientY) {
  const map = mapView?.getMap();
  if (!open || !map) return null;
  const rectangle = canvas.getBoundingClientRect();
  if (clientX < rectangle.left || clientX > rectangle.right || clientY < rectangle.top || clientY > rectangle.bottom) return null;
  const position = map.unproject([clientX - rectangle.left, clientY - rectangle.top]);
  return { lat: position.lat, lon: normalizeLongitude(position.lng) };
}

// Zone visible de la carte au dernier filtrage : un événement de fin de mouvement sans changement de zone (redimensionnement, nouvelles données)
// ne relance pas le filtre, sinon la grille et la carte s'entretiendraient l'une l'autre.
let lastFilterBounds = '';
function currentBoundsKey() {
  const map = mapView?.getMap();
  return map ? map.getBounds().toArray().flat().map(value => value.toFixed(5)).join(',') : '';
}

function applyVisibleFilter() {
  lastFilterBounds = currentBoundsKey();
  host.applyPhotoFilters({ keepState: true });
}

function scheduleVisibleFilter() {
  if (filterMode !== 'visible') return;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    if (open && filterMode === 'visible' && currentBoundsKey() !== lastFilterBounds) applyVisibleFilter();
  }, FILTER_DELAY_MS);
}

function bindMapEvents() {
  mapView.whenReady(map => {
    if (map === boundMap) return;
    boundMap = map;
    // La grille suit la carte une fois le déplacement ou le zoom terminé (clic relâché, ou molette immobile), pas pendant : recalculer la grille
    // à chaque image rendrait la carte saccadée.
    map.on('movestart', () => clearTimeout(filterTimer));
    map.on('moveend', scheduleVisibleFilter);
    map.on('contextmenu', event => openMapMenu(event.originalEvent.clientX, event.originalEvent.clientY, event.lngLat));
    // Une première carte prête dans ce mode : la grille a pu être filtrée avant d'avoir une zone visible.
    if (filterMode === 'visible') applyVisibleFilter();
  });
}

// Menu du clic droit sur la carte.
let menu = null;
function closeMenu() {
  menu?.remove();
  menu = null;
  document.removeEventListener('pointerdown', onOutsideMenu, true);
  document.removeEventListener('keydown', onMenuKey, true);
}
function onOutsideMenu(event) {
  if (menu && !(event.target instanceof Node && menu.contains(event.target))) closeMenu();
}
function onMenuKey(event) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
}
function openMapMenu(x, y, lngLat) {
  closeMenu();
  const { selection } = host.getSelection();
  const point = { lat: lngLat.lat, lon: normalizeLongitude(lngLat.lng) };
  menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'context-menu-item';
  item.setAttribute('role', 'menuitem');
  item.textContent = tp('Place the selection here ({count} photo)', selection.length);
  item.disabled = selection.length === 0;
  item.addEventListener('click', () => { closeMenu(); assignLocation(selection, point); });
  // Gestion des zones hors ligne / privées, après un séparateur.
  const separator = document.createElement('div');
  separator.className = 'context-menu-separator';
  const zones = document.createElement('button');
  zones.type = 'button';
  zones.className = 'context-menu-item';
  zones.setAttribute('role', 'menuitem');
  zones.textContent = t('Offline / private zones…');
  zones.addEventListener('click', () => { closeMenu(); openPrivateZonesModal(); });
  menu.append(item, separator, zones);
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - bounds.width))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - bounds.height))}px`;
  document.addEventListener('pointerdown', onOutsideMenu, true);
  document.addEventListener('keydown', onMenuKey, true);
}

// ---------------------------------------------------------------------------
// Glisser-déposer des photos sur la carte (le geste est suivi par main.js : Maj + glisser, voir startPhotoDrag)
// ---------------------------------------------------------------------------

/** Le curseur est au-dessus de la carte : indique les coordonnées visées et renvoie vrai. */
export function dragOverMap(clientX, clientY) {
  const point = pointAt(clientX, clientY);
  dropHint.hidden = !point;
  if (point) dropHint.textContent = `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
  return !!point;
}

export function dragLeaveMap() {
  if (dropHint) dropHint.hidden = true;
}

/** Dépôt de `photos` sur la carte : leur position (en attente) devient celle du point visé. Renvoie vrai si le dépôt a eu lieu sur la carte. */
export function dropOnMap(clientX, clientY, photos) {
  dragLeaveMap();
  const point = pointAt(clientX, clientY);
  if (!point) return false;
  assignLocation(photos, point);
  return true;
}

// ---------------------------------------------------------------------------
// Positions en attente et écriture
// ---------------------------------------------------------------------------

function assignLocation(photos, point) {
  if (!photos.length) return;
  for (const photo of photos) {
    const previous = pending.get(photo.id);
    pending.set(photo.id, { photoId: photo.id, path: photo.path, lat: point.lat, lon: point.lon, hadPosition: previous?.hadPosition ?? hasGps(photo) });
  }
  host.showToast(tp('Location set for {count} photo (not written yet)', photos.length));
  notifyPendingChange();
  refreshAll();
}

const toItem = entry => ({ photo_id: entry.photoId, path: entry.path, gps: [entry.lat, entry.lon] });

function updateControls() {
  const count = pending.size;
  writeButton.disabled = count === 0 || isWriteLocked();
  writeButton.classList.toggle('pending', count > 0);
  revertButton.disabled = count === 0 || isWriteLocked();
  pendingLabel.textContent = count ? tp('{count} photo with a location to write', count) : '';
  document.getElementById('map-changes').hidden = count === 0; // « Modifications » : seulement si des positions attendent
  for (const button of panel.querySelectorAll('.map-filter button')) button.setAttribute('aria-pressed', String(button.dataset.filter === filterMode));
  renderMessage();
}

function renderMessage() {
  let text = '';
  if (!isMapEnabled()) text = t('Map disabled (Settings > General)');
  else if (mapStatus === 'unavailable') text = t('The map cannot be displayed on this computer (WebGL unavailable).');
  else if (mapStatus === 'tiles-failed') text = t('The map could not be loaded (no connection?).');
  message.textContent = text;
  message.hidden = !text;
  canvas.hidden = !isMapEnabled() || mapStatus === 'unavailable';
}

/** Écrit les positions en attente. Renvoie faux si rien n'a été lancé (annulé par l'utilisateur, écriture déjà en cours). */
async function writeNow() {
  if (!pending.size || isWriteLocked()) return false;
  const replaced = [...pending.values()].filter(entry => entry.hadPosition).length;
  if (replaced) {
    const choice = await choiceDialog({
      title: t('Replace locations'),
      message: tp('{count} photo already has a location in its file: it will be replaced.', replaced),
      buttons: [
        { label: t('Write to files'), value: 'write', primary: true },
        { label: t('Cancel'), value: 'cancel', cancel: true },
      ],
    });
    if (choice !== 'write') return false;
  }
  return writeMetadataItems([...pending.values()].map(toItem));
}

function revertAll() {
  if (!pending.size || isWriteLocked()) return;
  pending.clear();
  notifyPendingChange();
  refreshAll();
}

// Éditeur de metadata-writes.js : les positions en attente suivent les mêmes règles que les visages (toute la photothèque, écrites à la demande
// ou à la fermeture, jamais perdues sans question).
registerEditor({
  scope: 'library',
  isDirty: () => pending.size > 0,
  targetIds: () => [...pending.keys()],
  pendingItems: () => [...pending.values()].map(toItem),
  pendingKinds: () => (pending.size ? ['gps'] : []),
  afterWrite(result) {
    // Seules les positions relues dans le fichier retirent l'attente (une position changée entre-temps reste en attente).
    for (const written of result.written) {
      const entry = pending.get(written.photo_id);
      if (entry && Number.isFinite(written.gps_lat) && Math.abs(entry.lat - written.gps_lat) < SAME_PLACE && Math.abs(entry.lon - written.gps_lon) < SAME_PLACE) {
        pending.delete(written.photo_id);
      }
    }
    // Reporté d'un tour : les positions relues sont reportées dans les photos (publishWritten) juste après cet appel.
    setTimeout(changedOutsideMode, 0);
  },
  discard(photoIds) {
    if (photoIds) for (const id of photoIds) pending.delete(id);
    else pending.clear();
    changedOutsideMode();
  },
  photosMoved(destinations) {
    for (const entry of pending.values()) entry.path = destinations.get(entry.path) ?? entry.path;
  },
  photosRemoved(paths) {
    for (const [id, entry] of pending) if (paths.has(entry.path)) pending.delete(id);
    changedOutsideMode();
  },
});

// Attente changée par une écriture, un abandon ou une photo retirée : l'interface suit (avec ou sans le mode ouvert).
function changedOutsideMode() {
  if (panel) updateControls();
  if (open) {
    refreshBackdrop();
    clearTimeout(selectionTimer);
    refreshSelectionNow();
    if (filterMode === 'visible') applyVisibleFilter();
  }
  host.refreshThumbnails();
}

// ---------------------------------------------------------------------------
// Ouverture et fermeture du mode
// ---------------------------------------------------------------------------

function setFilter(value) {
  if (filterMode === value) return;
  filterMode = value;
  updateControls();
  applyVisibleFilter();
}

export function openMapMode() {
  if (open) return;
  host.closePersonsView(); // une seule vue à la fois : Personnes, gestion des visages ou Carte
  host.closeFacesView();
  open = true;
  firstFraming = true;
  panel.hidden = false;
  host.setMapLayout(true);
  toggleButton.classList.add('active');
  setMapSuppressed(true);
  mapStatus = 'ready';
  updatePlaceSearchAvailability();
  updateControls();
  refreshBackdrop();
  ensureZonesLoaded().then(showZones);
  // Aucune photo sélectionnée géolocalisée : la carte s'ouvre sur l'ensemble des photos affichées.
  if (!selectionPoints().length) mapView.frameTo(host.getMapPhotos().map(positionOf).filter(Boolean));
  refreshSelectionNow();
  host.layoutPreview();
}

/** Ferme le mode sans rien demander : les positions en attente sont gardées (voir requestCloseMapMode pour la question). */
export function closeMapModeNow() {
  if (!open) return;
  open = false;
  clearTimeout(selectionTimer);
  clearTimeout(filterTimer);
  closeMenu();
  dragLeaveMap();
  panel.hidden = true;
  host.setMapLayout(false);
  toggleButton.classList.remove('active');
  mapView.destroy();
  boundMap = null;
  setMapSuppressed(false);
  if (filterMode !== 'all') {
    filterMode = 'all'; // la grille retrouve toutes ses photos
    host.applyPhotoFilters({ keepState: true });
  }
  host.layoutPreview();
}

/** Quitte le mode en demandant quoi faire des positions en attente. Renvoie vrai si le mode est fermé. */
export async function requestCloseMapMode() {
  if (!open) return true;
  if (pending.size) {
    const choice = await choiceDialog({
      title: t('Pending changes'),
      message: tp('{count} photo has a location that is not written to its file yet. Write it before leaving the map?', pending.size),
      buttons: [
        { label: t('Write to files'), value: 'write', primary: true },
        { label: t('Discard the changes'), value: 'discard' },
        { label: t('Cancel'), value: 'cancel', cancel: true },
      ],
    });
    if (choice === 'cancel') return false;
    if (choice === 'discard') {
      pending.clear();
      notifyPendingChange();
    } else {
      if (!(await writeNow())) return false;
      if (pending.size && !isWriteLocked()) return false; // écriture terminée avec des échecs : le mode reste ouvert
    }
  }
  closeMapModeNow();
  host.refreshThumbnails();
  return true;
}

/**
 * @param {object} hostApi services de main.js : getPhotos(), getMapPhotos(), getSelection() ({ selection, focus }), applyPhotoFilters(options), refreshThumbnails(),
 *   showToast(message), closePersonsView(), closeFacesView(), requestCloseFacesView() (vrai si la vue Visages est fermée), setMapLayout(open), layoutPreview(), setPhotoGridVisible?
 */
export function initMapMode(hostApi) {
  host = hostApi;
  panel = document.getElementById('map-panel');
  canvas = document.getElementById('map-canvas');
  message = document.getElementById('map-message');
  writeButton = document.getElementById('btn-map-write');
  revertButton = document.getElementById('btn-map-revert');
  pendingLabel = document.getElementById('map-pending');
  dropHint = document.getElementById('map-drop-hint');
  toggleButton = document.getElementById('btn-toggle-map');

  mapView = createMapView(canvas, {
    isAllowed: isMapEnabled,
    onStatus: status => { mapStatus = status; if (open) renderMessage(); },
  });

  toggleButton.addEventListener('click', async () => {
    if (open) requestCloseMapMode();
    else if (await host.requestCloseFacesView()) openMapMode(); // la vue Visages ouverte se ferme d'abord (visages en attente : question)
  });
  for (const button of panel.querySelectorAll('.map-filter button')) button.addEventListener('click', () => setFilter(button.dataset.filter));
  writeButton.addEventListener('click', () => { writeNow(); });
  revertButton.addEventListener('click', revertAll);
  initPlaceSearch({
    goTo: place => { mapView.frameTo([{ lat: place.lat, lon: place.lon, focus: true }], { zoom: PLACE_SEARCH_ZOOM }); },
    showToast: message => host.showToast(message),
  });

  onPendingChange(() => { if (panel) updateControls(); });
  onLockChange(() => { if (panel) updateControls(); });
  onZonesChange(() => { mapView.reloadStyle(); showZones(); });
  onLanguageChange(() => { if (open) updateControls(); });
  window.addEventListener('storage', () => { if (open) updateControls(); });
}

/** Réglage « Afficher une carte » ou mode hors ligne changé (voir onMapAccessChanged de main.js). */
export function onMapModeAccessChanged() {
  updatePlaceSearchAvailability();
  if (!open) return;
  updateControls();
  refreshSelectionNow();
}
