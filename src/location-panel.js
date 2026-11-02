// Panneau Info, groupe « Lieu » : coordonnées GPS de la sélection (lues en base, jamais modifiées), lien OpenStreetMap et petite carte.
// La carte n'est chargée que si l'option « Afficher une carte » est cochée (Paramètres > Général, décochée par défaut) et que le mode hors
// ligne est désactivé : sinon, aucune requête réseau, seules les coordonnées et le lien restent affichés.

import { openUrl } from '@tauri-apps/plugin-opener';
import { t, tp, onLanguageChange } from './i18n.js';
import { createMapView } from './map-view.js';
import { MAP_MAX_POINTS, openStreetMapUrl } from './map-config.js';

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

function isMapAllowed() {
  return isMapEnabled() && !isOffline();
}

let panel, coordsElement, osmLink, messageElement, mapElement, mapView;
let points = []; // positions de la sélection affichées (MAP_MAX_POINTS au plus)
let geolocatedCount = 0;
let selectedCount = 0;
let mapStatus = 'ready'; // 'ready', 'tiles-failed' ou 'unavailable' (rapporté par map-view.js)
let mapTimer = 0;

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
  if (isOffline()) message = t('Offline mode is on (Settings > General)');
  else if (!isMapEnabled()) message = t('Map disabled (Settings > General)');
  else if (mapStatus === 'unavailable') message = t('The map cannot be displayed on this computer (WebGL unavailable).');
  else if (mapStatus === 'tiles-failed') message = t('The map could not be loaded (no connection?).');
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
  osmLink.href = openStreetMapUrl(focus.lat, focus.lon);
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
  mapTimer = setTimeout(() => mapView.show(points), MAP_UPDATE_DELAY_MS);
}

/**
 * Affiche le lieu de la sélection.
 * @param {object[]} selection photos sélectionnées (champs gps_lat / gps_lon de la base)
 * @param {object | undefined} focusPhoto photo active (mise en avant sur la carte, et seule décrite par le texte et le lien)
 */
export function refreshLocation(selection, focusPhoto) {
  if (!panel) return;
  selectedCount = selection.length;
  const geolocated = selection.filter(hasGps);
  geolocatedCount = geolocated.length;
  // La photo active vient en tête : elle reste affichée même au-delà du plafond de marqueurs.
  const ordered = hasGps(focusPhoto) ? [focusPhoto, ...geolocated.filter(photo => photo !== focusPhoto)] : geolocated;
  points = ordered.slice(0, MAP_MAX_POINTS).map(photo => ({ lat: photo.gps_lat, lon: photo.gps_lon, focus: photo === focusPhoto }));
  if (!points.some(point => point.focus) && points[0]) points[0].focus = true;
  panel.hidden = points.length === 0;
  if (panel.hidden) {
    clearTimeout(mapTimer);
    return; // la carte reste créée (cachée) pour la prochaine photo géolocalisée
  }
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

  const toggle = document.getElementById('show-map-toggle');
  toggle.checked = isMapEnabled();
  toggle.addEventListener('change', () => {
    try { localStorage.setItem(SHOW_MAP_STORAGE_KEY, String(toggle.checked)); } catch { /* réglage non mémorisé */ }
    onMapAccessChanged();
  });

  onLanguageChange(() => { if (!panel.hidden) renderText(); });
}
