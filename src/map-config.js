// Configuration des cartes (panneau Info, zones privées, future vue carte) : fournisseur de tuiles, styles, adresses et limites de zoom, réunis
// ici pour pouvoir changer de fournisseur sans toucher au reste. Le même hôte figure dans la CSP de src-tauri/tauri.conf.json (connect-src) et
// dans private_maps.rs (téléchargement des zones privées).
//
// Fournisseur : OpenFreeMap (https://openfreemap.org), tuiles vectorielles issues d'OpenStreetMap, sans clé ni limite de requêtes, usage
// commercial permis ; attribution obligatoire (OpenFreeMap, OpenMapTiles, OpenStreetMap, voir MAP_ATTRIBUTION), affichée par MapLibre.
// Style, tuiles, polices et icônes sont tous servis par tiles.openfreemap.org.

export const MAP_PROVIDER = {
  name: 'OpenFreeMap',
  // Un style par thème de l'application (noms des styles du fournisseur, aussi enregistrés pour la carte privée : private_maps::STYLES).
  styles: {
    light: 'liberty',
    dark: 'dark',
  },
};

// Adresses du fournisseur utilisées par le protocole de tuiles (map-tile-protocol.js), seul endroit qui peut contacter le fournisseur.
export const PROVIDER_STYLE_URL = name => `https://tiles.openfreemap.org/styles/${name}`;
export const PROVIDER_TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
export const PROVIDER_FONT_URL = (fontstack, range) => `https://tiles.openfreemap.org/fonts/${encodeURIComponent(fontstack)}/${range}.pbf`;
export const MAP_ATTRIBUTION = '<a href="https://openfreemap.org">OpenFreeMap</a> <a href="https://www.openmaptiles.org/">© OpenMapTiles</a> '
  + 'Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// Accès au fournisseur permis : option « Afficher une carte » cochée (Paramètres > Général) et mode hors ligne désactivé.
export function isMapNetworkAllowed() {
  try {
    return localStorage.getItem('showMap') === 'true' && localStorage.getItem('offlineMode') !== 'true';
  } catch {
    return false;
  }
}

// Zoom : plafond strict (les tuiles OpenFreeMap s'arrêtent au niveau 14, au-delà elles seraient seulement agrandies) et zoom d'une photo seule.
export const MAP_MAX_ZOOM = 14;
export const MAP_SINGLE_PHOTO_ZOOM = 12;

// Zoom d'une photo seule choisi dans Paramètres > Général (7 à 14, 12 par défaut). Dans une zone privée, la carte est plafonnée au niveau de la
// zone : le niveau disponible le plus proche est alors utilisé (voir frame dans map-view.js).
export const MAP_MIN_DEFAULT_ZOOM = 7;
export function defaultMapZoom() {
  let stored = NaN;
  try { stored = Number(localStorage.getItem('mapDefaultZoom')); } catch { /* réglage illisible : valeur par défaut */ }
  return Number.isInteger(stored) && stored >= MAP_MIN_DEFAULT_ZOOM && stored <= MAP_MAX_ZOOM ? stored : MAP_SINGLE_PHOTO_ZOOM;
}

// Multi-sélection : nombre maximal de marqueurs affichés (au-delà, les premières photos géolocalisées de la sélection).
export const MAP_MAX_POINTS = 500;

// Tuiles absentes parce que le mode hors ligne est actif (zone non enregistrée sur le disque) : le protocole de tuiles renvoie une tuile
// vectorielle qui ne contient qu'un carré couvrant la tuile (couche OFFLINE_PLACEHOLDER.layer), que le style remplit avec l'image-motif
// OFFLINE_PLACEHOLDER.image (filigrane dessiné par map-view.js). Un motif suit la grille des tuiles : le texte se répète sur chacune.
export const OFFLINE_PLACEHOLDER = { layer: 'offline_placeholder', image: 'offline-watermark' };
