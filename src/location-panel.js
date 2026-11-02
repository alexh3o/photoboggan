// Panneau Info, groupe « Lieu » : coordonnées GPS de la sélection (lues en base, jamais modifiées), lien OpenStreetMap et petite carte.
// La carte n'est chargée que si l'option « Afficher une carte » est cochée (Paramètres > Général, décochée par défaut) :
// - lieu ordinaire : il faut aussi que le mode hors ligne soit désactivé ;
// - lieu privé (dans une zone privée, voir private-zones.js) : carte en mode strict, uniquement avec les tuiles enregistrées sur le disque
//   (même hors ligne), sans lien OpenStreetMap.

import { openUrl } from '@tauri-apps/plugin-opener';
import { t, tp, onLanguageChange } from './i18n.js';
import { createMapView } from './map-view.js';
import { MAP_MAX_POINTS, MAP_MAX_ZOOM, openStreetMapUrl } from './map-config.js';
import { locatePrivatePoints, onZonesChange, getZones } from './private-zones.js';
import { openPrivateZonesModal, offerPrivateZonesWelcome } from './private-zones-modal.js';

const SHOW_MAP_STORAGE_KEY = 'showMap';
const MAP_UPDATE_DELAY_MS = 150; // navigation rapide au clavier : seule la dernière photo est cadrée

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function isOffline() {
  return readStorage('offlineMode') === 'true';
}

function isMapEnabled() {
  return readStorage(SHOW_MAP_STORAGE_KEY) === 'true';
}

let panel, coordsElement, osmLink, privateBadge, messageElement, mapElement, mapView;
let points = []; // positions de la sélection affichées (MAP_MAX_POINTS au plus)
let geolocatedCount = 0;
let selectedCount = 0;
let privacy = { strict: false, focusPrivate: false, maxZoom: MAP_MAX_ZOOM }; // lieux privés de la sélection affichée
let mapStatus = 'ready'; // 'ready', 'tiles-failed' ou 'unavailable' (rapporté par map-view.js)
let mapTimer = 0;
let refreshToken = 0;
let lastSelection = { selection: [], focusPhoto: undefined };

// Carte permise : option cochée, et Internet permis sauf pour un lieu privé (tuiles locales uniquement).
function isMapAllowed() {
  return isMapEnabled() && (!isOffline() || privacy.strict);
}

function hasGps(photo) {
  return Number.isFinite(photo?.gps_lat) && Number.isFinite(photo?.gps_lon);
}

function formatCoordinate(value, positive, negative) {
  return `${Math.abs(value).toFixed(5)}° ${value >= 0 ? positive : negative}`;
}

function focusPoint() {
  return points.find(point => point.focus) || points[0];
}

function renderMessage() {
  let message = '';
  if (!isMapEnabled()) message = t('Map disabled (Settings > General)');
  else if (isOffline() && !privacy.strict) message = t('Offline mode is on (Settings > General)');
  else if (mapStatus === 'unavailable') message = t('The map cannot be displayed on this computer (WebGL unavailable).');
  else if (mapStatus === 'tiles-failed' && !privacy.strict) message = t('The map could not be loaded (no connection?).');
  else if (geolocatedCount > MAP_MAX_POINTS) message = t('Only the first {count} locations are shown.', { count: MAP_MAX_POINTS });
  messageElement.textContent = message;
  messageElement.hidden = !message;
}

function renderText() {
  const focus = focusPoint();
  if (!focus) return;
  coordsElement.textContent = selectedCount > 1
    ? tp('{count} geolocated photos out of {total}', geolocatedCount, { total: selectedCount })
    : `${formatCoordinate(focus.lat, 'N', 'S')}, ${formatCoordinate(focus.lon, 'E', 'W')}`;
  coordsElement.title = `${focus.lat}, ${focus.lon}`;
  // Lieu privé : pas de lien vers OpenStreetMap (il enverrait la position au site).
  osmLink.hidden = privacy.focusPrivate;
  if (!privacy.focusPrivate) osmLink.href = openStreetMapUrl(focus.lat, focus.lon);
  privateBadge.hidden = !privacy.strict;
  renderMessage();
}

function updateMap() {
  clearTimeout(mapTimer);
  const allowed = isMapAllowed() && points.length > 0;
  mapElement.hidden = !allowed || mapStatus === 'unavailable';
  if (!allowed) {
    mapView.destroy();
    return;
  }
  // Le mode strict est transmis avec les positions : la carte le règle avant tout recadrage (voir map-view.js).
  const shown = { points, privacy };
  mapTimer = setTimeout(() => mapView.show(shown.points, { strict: shown.privacy.strict, maxZoom: shown.privacy.maxZoom }), MAP_UPDATE_DELAY_MS);
}

/**
 * Affiche le lieu de la sélection.
 * @param {object[]} selection photos sélectionnées (champs gps_lat / gps_lon de la base)
 * @param {object | undefined} focusPhoto photo active (mise en avant sur la carte, et seule décrite par le texte et le lien)
 */
export async function refreshLocation(selection, focusPhoto) {
  if (!panel) return;
  lastSelection = { selection, focusPhoto };
  const token = ++refreshToken;
  const geolocated = selection.filter(hasGps);
  // La photo active vient en tête : elle reste affichée même au-delà du plafond de marqueurs.
  const ordered = hasGps(focusPhoto) ? [focusPhoto, ...geolocated.filter(photo => photo !== focusPhoto)] : geolocated;
  const nextPoints = ordered.slice(0, MAP_MAX_POINTS).map(photo => ({ lat: photo.gps_lat, lon: photo.gps_lon, focus: photo === focusPhoto }));
  if (!nextPoints.some(point => point.focus) && nextPoints[0]) nextPoints[0].focus = true;
  if (nextPoints.length === 0) {
    points = [];
    panel.hidden = true;
    clearTimeout(mapTimer);
    return; // la carte reste créée (cachée) pour la prochaine photo géolocalisée
  }
  // Lieux privés décidés par le backend, avant tout affichage de la carte : en attendant, la carte précédente ne bouge pas.
  let zoneIds;
  try {
    zoneIds = await locatePrivatePoints(nextPoints);
  } catch (error) {
    console.error('Private zones check failed', error);
    zoneIds = nextPoints.map(() => -1); // doute : traité comme privé (carte locale uniquement)
  }
  if (token !== refreshToken) return; // sélection changée entre-temps
  const zoomOf = id => getZones().find(zone => zone.id === id)?.max_zoom ?? MAP_MAX_ZOOM;
  const privateIds = zoneIds.filter(id => id !== null);
  privacy = {
    strict: privateIds.length > 0,
    focusPrivate: zoneIds[nextPoints.findIndex(point => point.focus)] !== null,
    maxZoom: privateIds.length ? Math.min(...privateIds.map(zoomOf)) : MAP_MAX_ZOOM,
  };
  points = nextPoints;
  selectedCount = selection.length;
  geolocatedCount = geolocated.length;
  panel.hidden = false;
  renderText();
  updateMap();
}

// Mode hors ligne ou option « Afficher une carte » changés : effet immédiat, sans redémarrage.
export function onMapAccessChanged() {
  if (!panel) return;
  mapStatus = 'ready';
  if (!panel.hidden) renderMessage();
  updateMap();
}

export function initLocationPanel() {
  panel = document.getElementById('location-panel');
  coordsElement = document.getElementById('location-coords');
  osmLink = document.getElementById('location-osm');
  privateBadge = document.getElementById('location-private');
  messageElement = document.getElementById('location-message');
  mapElement = document.getElementById('location-map');
  mapView = createMapView(mapElement, {
    isAllowed: isMapAllowed,
    onStatus: status => {
      mapStatus = status;
      if (status === 'unavailable') mapElement.hidden = true;
      if (!panel.hidden) renderMessage();
    },
  });

  // Lien OpenStreetMap et liens d'attribution de la carte : ouverts dans le navigateur de l'utilisateur, jamais dans la fenêtre de l'application.
  panel.addEventListener('click', async event => {
    const link = event.target instanceof Element ? event.target.closest('a[href^="http"]') : null;
    if (!link) return;
    event.preventDefault();
    try {
      await openUrl(link.href);
    } catch (error) {
      console.error('Could not open the link:', error);
    }
  });

  // Zones privées : bouton du groupe Lieu et de Paramètres > Général ; à la première activation de la carte, accueil si aucune zone.
  document.getElementById('btn-location-private-zones').addEventListener('click', () => openPrivateZonesModal());
  document.getElementById('btn-settings-private-zones').addEventListener('click', () => openPrivateZonesModal());
  const toggle = document.getElementById('show-map-toggle');
  toggle.checked = isMapEnabled();
  toggle.addEventListener('change', () => {
    try { localStorage.setItem(SHOW_MAP_STORAGE_KEY, String(toggle.checked)); } catch { /* réglage non mémorisé */ }
    onMapAccessChanged();
    if (toggle.checked) offerPrivateZonesWelcome();
  });

  // Zones ajoutées, supprimées ou téléchargées : style et tuiles redemandés (les zones changent la règle par tuile et apportent le style local)
  // et lieu de la sélection recalculé.
  onZonesChange(() => {
    mapView.reloadStyle();
    refreshLocation(lastSelection.selection, lastSelection.focusPhoto);
  });

  onLanguageChange(() => { if (!panel.hidden) renderText(); });
}
