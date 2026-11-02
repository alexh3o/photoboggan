// Zones privées de la carte (côté interface) : liste des zones (lue dans le backend, private_maps.rs), lieux privés, contours à dessiner et
// niveaux de détail. Partagé par le panneau Info, la fenêtre de gestion des zones et la future vue carte de la bibliothèque.
// La géométrie qui protège (règle par tuile, lieu privé ou non) est calculée par le backend ; celle d'ici ne sert qu'à l'affichage.

import { invoke } from '@tauri-apps/api/core';

// Niveaux de détail téléchargeables : zoom maximal (voir private_maps::DETAIL_ZOOMS) et clé de traduction.
export const DETAIL_LEVELS = [
  { zoom: 12, labelKey: 'City' },
  { zoom: 13, labelKey: 'Neighbourhood' },
  { zoom: 14, labelKey: 'Streets' },
];

// Limites du fournisseur pour un téléchargement hors ligne (voir private_maps::MAX_TILES et MAX_BYTES).
export const MAX_ZONE_TILES = 3000;
export const MAX_ZONE_BYTES = 50 * 1024 * 1024;

let zones = [];
let loaded = null;
const listeners = new Set();

/** Zones connues (dernière liste lue). */
export function getZones() {
  return zones;
}

/** Relit la liste des zones dans le backend et prévient les abonnés. */
export async function reloadZones() {
  zones = await invoke('list_private_zones');
  loaded = Promise.resolve(zones);
  for (const listener of listeners) listener(zones);
  return zones;
}

/** Liste des zones, lue une fois au premier besoin. */
export function ensureZonesLoaded() {
  loaded ??= reloadZones().catch(error => {
    console.error('Private zones unavailable', error);
    loaded = null;
    return [];
  });
  return loaded;
}

/** `listener(zones)` est appelé à chaque changement de la liste. Renvoie la fonction de désabonnement. */
export function onZonesChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Zone privée de chaque position (identifiant ou null), décidée par le backend.
 * @param {{lat: number, lon: number}[]} points
 */
export async function locatePrivatePoints(points) {
  if (points.length === 0) return [];
  await ensureZonesLoaded();
  if (zones.length === 0) return points.map(() => null);
  return invoke('locate_private_points', { points: points.map(point => [point.lat, point.lon]) });
}

/**
 * Nom du fichier de tuiles d'une zone, tiré de son nom (même règle que private_maps::zone_file_name) : minuscules, espaces remplacés par
 * « _ », caractères interdits retirés. Null si le nom ne donne aucun nom de fichier utilisable.
 */
export function zoneFileName(name) {
  const slug = [...String(name).trim().toLowerCase()]
    .map(c => (/\s/.test(c) ? '_' : /[\p{Cc}<>:"/\\|?*]/u.test(c) ? '' : c))
    .join('')
    .replace(/[._]+$/, '')
    .replace(/^\.+/, '');
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
  return slug && !reserved.test(slug) ? `${slug}.mbtiles` : null;
}

/** Le nom donnerait le même fichier qu'une autre zone (sauf `exceptId`, la zone renommée). */
export function isZoneNameTaken(name, exceptId = null) {
  const file = zoneFileName(name);
  return !!file && zones.some(zone => zone.id !== exceptId && zoneFileName(zone.name) === file);
}

/** Estimation avant téléchargement : { tiles, bytes, within_limits }. */
export function estimateZone(geometry, maxZoom) {
  return invoke('estimate_private_zone', { geometry, maxZoom });
}

// Point à `distance` mètres de (lat, lon) dans la direction `bearing` (radians), sur la sphère : même formule que le backend.
const EARTH_RADIUS = 6371008.8;
function destination(lat, lon, distance, bearing) {
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const angle = distance / EARTH_RADIUS;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angle) + Math.cos(lat1) * Math.sin(angle) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angle) * Math.cos(lat1), Math.cos(angle) - Math.sin(lat1) * Math.sin(lat2));
  return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI];
}

export function distanceMeters(a, b) {
  const toRadians = value => value * Math.PI / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}

/** Contour d'une zone en GeoJSON (anneau fermé de [longitude, latitude]), pour l'afficher sur une carte. */
export function zoneRing(geometry) {
  const ring = geometry.kind === 'circle'
    ? Array.from({ length: 64 }, (_, side) => destination(geometry.lat, geometry.lon, geometry.radius, side * 2 * Math.PI / 64))
    : geometry.points.map(([lat, lon]) => [lon, lat]);
  return ring.length ? [...ring, ring[0]] : ring;
}

/** Rectangle englobant [[ouest, sud], [est, nord]] d'une zone. */
export function zoneBounds(geometry) {
  const ring = zoneRing(geometry);
  const lons = ring.map(point => point[0]);
  const lats = ring.map(point => point[1]);
  return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
}

/** Contours des zones en GeoJSON (une entité par zone, propriété `selected`), pour une couche de carte. */
export function zonesFeatureCollection(list, selectedId = null) {
  return {
    type: 'FeatureCollection',
    features: list.map(zone => ({
      type: 'Feature',
      properties: { id: zone.id, selected: zone.id === selectedId },
      geometry: { type: 'Polygon', coordinates: [zoneRing(zone.geometry)] },
    })),
  };
}
