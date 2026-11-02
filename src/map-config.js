// Configuration de la carte (panneau Info, groupe Lieu) : fournisseur de tuiles, styles, hôtes autorisés et limites de zoom, réunis ici pour
// pouvoir changer de fournisseur sans toucher au reste. Les mêmes hôtes figurent dans la CSP de src-tauri/tauri.conf.json (connect-src, img-src).
//
// Fournisseur : OpenFreeMap (https://openfreemap.org), tuiles vectorielles issues d'OpenStreetMap, sans clé ni limite de requêtes, usage
// commercial permis ; attribution obligatoire (OpenFreeMap, OpenMapTiles, OpenStreetMap), fournie par le TileJSON et affichée par MapLibre.
// Style, tuiles, polices et icônes sont tous servis par tiles.openfreemap.org.

export const MAP_PROVIDER = {
  name: 'OpenFreeMap',
  // Un style par thème de l'application.
  styles: {
    light: 'https://tiles.openfreemap.org/styles/liberty',
    dark: 'https://tiles.openfreemap.org/styles/dark',
  },
  // Seules origines que la carte peut contacter (vérifiées à chaque requête, voir map-view.js).
  allowedOrigins: ['https://tiles.openfreemap.org'],
};

// Zoom : plafond strict (les tuiles OpenFreeMap s'arrêtent au niveau 14, au-delà elles seraient seulement agrandies) et zoom d'une photo seule.
export const MAP_MAX_ZOOM = 14;
export const MAP_SINGLE_PHOTO_ZOOM = 12;

// Multi-sélection : nombre maximal de marqueurs affichés (au-delà, les premières photos géolocalisées de la sélection).
export const MAP_MAX_POINTS = 500;

// Lien « Ouvrir dans OpenStreetMap » (navigateur de l'utilisateur, jamais dans l'application).
export function openStreetMapUrl(latitude, longitude, zoom = 16) {
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=${zoom}/${latitude}/${longitude}`;
}
