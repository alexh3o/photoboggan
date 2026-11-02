// Carte MapLibre réutilisable (panneau Info aujourd'hui, vue carte de la collection plus tard) : une seule instance par conteneur, créée à la
// première position à montrer et réutilisée ensuite.
//
// Accès réseau : rien n'est importé ni demandé tant que `isAllowed()` est faux (mode hors ligne ou option « Afficher une carte » décochée) ;
// chaque requête de MapLibre repasse par `transformRequest`, qui la détourne vers une adresse locale vide si l'accès n'est plus permis ou si
// l'hôte n'est pas celui du fournisseur. `destroy()` libère le contexte WebGL (appelé quand l'accès est retiré).

import { MAP_PROVIDER, MAP_MAX_ZOOM, MAP_SINGLE_PHOTO_ZOOM } from './map-config.js';
// Adresse du script du worker MapLibre (fichier copié tel quel par Vite) : une simple chaîne, rien n'est chargé à l'import.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

const BLOCKED_URL = 'data:application/json,{}';
const SOURCE_ID = 'photo-locations';

// Bibliothèque chargée une seule fois, à la première carte réellement affichée.
let libraryPromise = null;
function loadLibrary() {
  libraryPromise ??= Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl.css')]).then(([library]) => {
    library.setWorkerUrl(workerUrl);
    return library;
  });
  return libraryPromise;
}

function isProviderUrl(url) {
  try {
    return MAP_PROVIDER.allowedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function currentStyleUrl() {
  return document.documentElement.dataset.theme === 'light' ? MAP_PROVIDER.styles.light : MAP_PROVIDER.styles.dark;
}

// WebGL disponible (absent de certaines configurations Linux / WebKitGTK) : testé une fois, sans créer de carte.
let webglSupport = null;
export function isWebglSupported() {
  if (webglSupport === null) {
    try {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
      webglSupport = !!context;
      context?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      webglSupport = false;
    }
  }
  return webglSupport;
}

/**
 * Crée la carte d'un conteneur.
 * @param {HTMLElement} container élément qui reçoit la carte
 * @param {{ isAllowed: () => boolean, onStatus: (status: 'ready' | 'tiles-failed' | 'unavailable') => void }} options
 * @returns {{ show(points: {lat: number, lon: number, focus?: boolean}[]): void, destroy(): void }}
 */
export function createMapView(container, { isAllowed, onStatus }) {
  let map = null;
  let mapReady = false;
  let creating = null;
  let pendingPoints = null; // dernière demande, appliquée quand la carte est prête et visible
  let styleUrl = null;
  let tilesFailed = false;

  const isVisible = () => container.clientWidth > 0 && container.clientHeight > 0;

  function featureCollection(points) {
    return {
      type: 'FeatureCollection',
      features: points.map(point => ({
        type: 'Feature',
        properties: { focus: !!point.focus },
        geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
      })),
    };
  }

  // Source et couche des positions : un cercle par photo, la photo active plus grande et dessinée au-dessus.
  function addLocationLayers() {
    if (map.getSource(SOURCE_ID)) return;
    // Couleur de sélection des miniatures (réglable dans les options d'affichage).
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--selected-border').trim() || '#1e72ad';
    map.addSource(SOURCE_ID, { type: 'geojson', data: featureCollection(pendingPoints || []) });
    map.addLayer({
      id: SOURCE_ID,
      type: 'circle',
      source: SOURCE_ID,
      layout: { 'circle-sort-key': ['case', ['get', 'focus'], 1, 0] },
      paint: {
        'circle-radius': ['case', ['get', 'focus'], 7, 5],
        'circle-color': accent,
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 2,
      },
    });
  }

  // Cadrage sans animation (jumpTo / fitBounds sans durée) : aucune tuile intermédiaire chargée pendant la navigation entre photos.
  function frame(points) {
    if (points.length === 0) return;
    const first = points[0];
    const sameSpot = points.every(point => point.lat === first.lat && point.lon === first.lon);
    if (sameSpot) {
      const focus = points.find(point => point.focus) || first;
      map.jumpTo({ center: [focus.lon, focus.lat], zoom: points.length === 1 ? MAP_SINGLE_PHOTO_ZOOM : MAP_MAX_ZOOM });
      return;
    }
    let [west, south, east, north] = [first.lon, first.lat, first.lon, first.lat];
    for (const point of points) {
      west = Math.min(west, point.lon); east = Math.max(east, point.lon);
      south = Math.min(south, point.lat); north = Math.max(north, point.lat);
    }
    map.fitBounds([[west, south], [east, north]], { padding: 24, maxZoom: MAP_MAX_ZOOM, duration: 0 });
  }

  function apply() {
    if (!map || !mapReady || !pendingPoints || !isVisible()) return;
    map.resize();
    map.getSource(SOURCE_ID)?.setData(featureCollection(pendingPoints));
    frame(pendingPoints);
  }

  async function create() {
    const library = await loadLibrary();
    // L'accès a pu être retiré, ou la carte détruite, pendant le chargement de la bibliothèque.
    if (!isAllowed() || creating === null) return;
    styleUrl = currentStyleUrl();
    const focus = pendingPoints?.find(point => point.focus) || pendingPoints?.[0];
    map = new library.Map({
      container,
      style: styleUrl,
      center: focus ? [focus.lon, focus.lat] : [0, 0],
      zoom: MAP_SINGLE_PHOTO_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      fadeDuration: 0,
      // Chaque requête (style, TileJSON, tuiles, polices, icônes) est vérifiée : accès permis et hôte du fournisseur, sinon adresse locale vide.
      transformRequest: url => (isAllowed() && isProviderUrl(url) ? { url } : { url: BLOCKED_URL }),
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    // Attribution compacte repliée au départ (bouton « i ») : dépliée, elle couvrirait la moitié d'une si petite carte.
    map.once('load', () => container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
    map.on('style.load', () => {
      addLocationLayers();
      mapReady = true;
      if (!tilesFailed) onStatus('ready');
      apply();
    });
    // Tuiles ou style injoignables (hors connexion, fournisseur en panne) : message, la carte reste en place et réessaie au prochain cadrage.
    map.on('error', () => {
      tilesFailed = true;
      onStatus('tiles-failed');
    });
    map.on('data', event => {
      if (tilesFailed && event.dataType === 'source' && event.isSourceLoaded) {
        tilesFailed = false;
        onStatus('ready');
      }
    });
    map.getCanvas().addEventListener('webglcontextlost', () => {
      destroy();
      onStatus('unavailable');
    });
  }

  function destroy() {
    creating = null;
    mapReady = false;
    tilesFailed = false;
    if (map) {
      map.remove(); // annule les requêtes en cours et libère le contexte WebGL
      map = null;
    }
  }

  // Thème changé : le style suit (rechargé une seule fois, et seulement si la carte existe).
  new MutationObserver(() => {
    if (!map || currentStyleUrl() === styleUrl) return;
    styleUrl = currentStyleUrl();
    mapReady = false;
    map.setStyle(styleUrl);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // Panneau redimensionné, onglet ou panneau réaffiché : la carte reprend la taille du conteneur et la dernière position demandée.
  new ResizeObserver(() => {
    if (!isVisible()) return;
    if (map) apply();
    else if (pendingPoints) show(pendingPoints);
  }).observe(container);

  function show(points) {
    pendingPoints = points;
    if (!isAllowed() || !isWebglSupported()) {
      destroy();
      if (isAllowed()) onStatus('unavailable');
      return;
    }
    if (map) { apply(); return; }
    // Création différée jusqu'à ce que le conteneur soit visible (onglet Info affiché, panneau ouvert).
    if (creating || !isVisible() || points.length === 0) return;
    creating = create().catch(error => {
      console.error('Map unavailable', error);
      destroy();
      onStatus('unavailable');
    });
  }

  return { show, destroy };
}
