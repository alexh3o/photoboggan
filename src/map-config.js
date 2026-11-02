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

// Multi-sélection : nombre maximal de marqueurs affichés (au-delà, les premières photos géolocalisées de la sélection).
export const MAP_MAX_POINTS = 500;

// Lien « Ouvrir dans OpenStreetMap » (navigateur de l'utilisateur, jamais dans l'application).
export function openStreetMapUrl(latitude, longitude, zoom = 16) {
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=${zoom}/${latitude}/${longitude}`;
}
