// Carte MapLibre réutilisable (panneau Info, fenêtre des zones privées, plus tard vue carte de la bibliothèque) : une seule instance par
// conteneur, créée au premier affichage et réutilisée ensuite.
//
// Accès réseau : MapLibre ne contacte jamais le fournisseur lui-même. Toutes ses ressources passent par le protocole `pbmap://`
// (map-tile-protocol.js), qui applique la règle par tuile des zones privées et le mode strict ; `transformRequest` détourne toute autre adresse
// vers une adresse locale vide. Rien n'est importé tant que `isAllowed()` est faux. `destroy()` libère le contexte WebGL.

import { MAP_PROVIDER, MAP_MAX_ZOOM, MAP_SINGLE_PHOTO_ZOOM } from './map-config.js';
import { registerMapProtocol, createTileContext, MAP_PROTOCOL } from './map-tile-protocol.js';
// Adresse du script du worker MapLibre (fichier copié tel quel par Vite) : une simple chaîne, rien n'est chargé à l'import.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

const BLOCKED_URL = 'data:application/json,{}';
const SOURCE_ID = 'photo-locations';
const ZONES_SOURCE_ID = 'private-zones';
const TILE_SOURCE_ID = 'openmaptiles';

// Bibliothèque chargée une seule fois, à la première carte réellement affichée.
let libraryPromise = null;
export function loadMapLibrary() {
  libraryPromise ??= Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl.css')]).then(([library]) => {
    library.setWorkerUrl(workerUrl);
    registerMapProtocol(library);
    return library;
  });
  return libraryPromise;
}

const isLocalUrl = url => url.startsWith(`${MAP_PROTOCOL}://`) || url.startsWith('data:') || url.startsWith('blob:');

function currentStyleName() {
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
 * @param {{ isAllowed: () => boolean, onStatus?: (status: 'ready' | 'tiles-failed' | 'unavailable') => void, interactive?: boolean }} options
 */
export function createMapView(container, { isAllowed, onStatus = () => {}, interactive = true }) {
  let map = null;
  let mapReady = false;
  let creating = null;
  let pendingPoints = null; // dernière demande, appliquée quand la carte est prête et visible
  let pendingFrame = null; // cadrage demandé sans points (rectangle d'une zone)
  let zoneOutlines = null; // contours de zones affichés (fenêtre des zones privées)
  let styleName = null;
  let tilesFailed = false;
  let strict = false;
  let strictMaxZoom = MAP_MAX_ZOOM;
  let tileGeneration = 0;
  const tileContext = createTileContext();
  const readyCallbacks = [];

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

  // Couches ajoutées au style (à refaire après un changement de style) : contours des zones privées, puis positions des photos (un cercle
  // par photo, la photo active plus grande et dessinée au-dessus).
  function addOverlayLayers() {
    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue('--selected-border').trim() || '#1e72ad';
    const zoneColor = styles.getPropertyValue('--accent-text').trim() || '#4aa3df';
    if (!map.getSource(ZONES_SOURCE_ID)) {
      map.addSource(ZONES_SOURCE_ID, { type: 'geojson', data: zoneOutlines || { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: `${ZONES_SOURCE_ID}-fill`, type: 'fill', source: ZONES_SOURCE_ID,
        paint: { 'fill-color': zoneColor, 'fill-opacity': ['case', ['get', 'selected'], 0.22, 0.1] },
      });
      map.addLayer({
        id: `${ZONES_SOURCE_ID}-line`, type: 'line', source: ZONES_SOURCE_ID,
        paint: { 'line-color': zoneColor, 'line-width': ['case', ['get', 'selected'], 2.5, 1.5], 'line-dasharray': [2, 1.5] },
      });
    }
    if (!map.getSource(SOURCE_ID)) {
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
  }

  // Cadrage sans animation (jumpTo / fitBounds sans durée) : aucune tuile intermédiaire chargée pendant la navigation entre photos.
  function frame(points) {
    if (points.length === 0) return;
    const maxZoom = Math.min(MAP_MAX_ZOOM, strict ? strictMaxZoom : MAP_MAX_ZOOM);
    const first = points[0];
    const sameSpot = points.every(point => point.lat === first.lat && point.lon === first.lon);
    if (sameSpot) {
      const focus = points.find(point => point.focus) || first;
      map.jumpTo({ center: [focus.lon, focus.lat], zoom: Math.min(points.length === 1 ? MAP_SINGLE_PHOTO_ZOOM : MAP_MAX_ZOOM, maxZoom) });
      return;
    }
    let [west, south, east, north] = [first.lon, first.lat, first.lon, first.lat];
    for (const point of points) {
      west = Math.min(west, point.lon); east = Math.max(east, point.lon);
      south = Math.min(south, point.lat); north = Math.max(north, point.lat);
    }
    map.fitBounds([[west, south], [east, north]], { padding: 24, maxZoom, duration: 0 });
  }

  function apply() {
    if (!map || !mapReady || !isVisible()) return;
    map.resize();
    if (pendingPoints) {
      map.getSource(SOURCE_ID)?.setData(featureCollection(pendingPoints));
      frame(pendingPoints);
    }
    if (pendingFrame) {
      map.fitBounds(pendingFrame, { padding: 24, maxZoom: MAP_MAX_ZOOM, duration: 0 });
      pendingFrame = null;
    }
  }

  // Style rechargé (zones privées changées) : le style local, téléchargé avec la première zone, remplace le fond neutre affiché faute de style,
  // et toutes les tuiles sont redemandées selon les nouvelles zones.
  function reloadStyle() {
    if (!map) return;
    mapReady = false;
    map.setStyle(tileContext.styleUrl(styleName), { diff: false });
  }

  // Tuiles rechargées (adresse changée) : après la sortie du mode strict (les tuiles reçues vides doivent être redemandées).
  function reloadTiles() {
    tileGeneration += 1;
    map?.getSource(TILE_SOURCE_ID)?.setTiles?.([`${MAP_PROTOCOL}://${tileContext.id}/tiles/{z}/{x}/{y}#${tileGeneration}`]);
  }

  async function create() {
    const library = await loadMapLibrary();
    // L'accès a pu être retiré, ou la carte détruite, pendant le chargement de la bibliothèque.
    if (!isAllowed() || creating === null) return;
    styleName = currentStyleName();
    const focus = pendingPoints?.find(point => point.focus) || pendingPoints?.[0];
    map = new library.Map({
      container,
      style: tileContext.styleUrl(styleName),
      center: focus ? [focus.lon, focus.lat] : [2.35, 48.85],
      zoom: focus ? MAP_SINGLE_PHOTO_ZOOM : 4,
      maxZoom: strict ? strictMaxZoom : MAP_MAX_ZOOM,
      attributionControl: { compact: true },
      interactive,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      fadeDuration: 0,
      // Seul le protocole pbmap:// est servi : toute autre adresse (fournisseur compris) est détournée vers une adresse locale vide.
      transformRequest: url => (isLocalUrl(url) ? { url } : { url: BLOCKED_URL }),
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.doubleClickZoom.disable(); // double-clic réservé au dessin des zones (fenêtre des zones privées)
    // Attribution compacte repliée au départ (bouton « i ») : dépliée, elle couvrirait la moitié d'une si petite carte.
    map.once('load', () => container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
    map.on('style.load', () => {
      addOverlayLayers();
      mapReady = true;
      if (!tilesFailed) onStatus('ready');
      apply();
      for (const callback of readyCallbacks.splice(0)) callback(map);
    });
    // Tuiles ou style injoignables (hors connexion, fournisseur en panne) : message, la carte reste en place.
    map.on('error', event => {
      if (event?.error?.name === 'AbortError') return; // requête annulée (mode strict, déplacement) : pas une panne
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
    if (!map || currentStyleName() === styleName) return;
    styleName = currentStyleName();
    mapReady = false;
    map.setStyle(tileContext.styleUrl(styleName));
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // Panneau redimensionné, onglet ou panneau réaffiché : la carte reprend la taille du conteneur et la dernière demande.
  new ResizeObserver(() => {
    if (!isVisible()) return;
    if (map) apply();
    else if (pendingPoints || pendingFrame || zoneOutlines) ensureCreated();
  }).observe(container);

  function ensureCreated() {
    if (!isAllowed() || !isWebglSupported()) {
      destroy();
      if (isAllowed()) onStatus('unavailable');
      return false;
    }
    if (map) return true;
    if (!creating && isVisible()) {
      creating = create().catch(error => {
        console.error('Map unavailable', error);
        destroy();
        onStatus('unavailable');
      });
    }
    return false;
  }

  /**
   * Mode strict (la carte montre un lieu privé) : aucune requête distante, requêtes en cours annulées, zoom plafonné au détail téléchargé.
   * À appeler AVANT tout recadrage vers le lieu privé (show le fait).
   */
  function setStrict(value, maxZoom = MAP_MAX_ZOOM) {
    const leaving = strict && !value;
    strict = value;
    strictMaxZoom = maxZoom;
    tileContext.setStrict(value);
    if (map) {
      map.setMaxZoom(value ? maxZoom : MAP_MAX_ZOOM);
      if (leaving) reloadTiles();
    }
  }

  /**
   * Montre des positions (la première `focus` mise en avant).
   * @param {{lat: number, lon: number, focus?: boolean}[]} points
   * @param {{ strict?: boolean, maxZoom?: number }} [privacy] mode strict décidé par l'appelant (positions dans une zone privée)
   */
  function show(points, privacy = {}) {
    // Le mode strict passe en premier : aucun recadrage vers un lieu privé avec une carte encore autorisée à contacter le fournisseur.
    setStrict(!!privacy.strict, privacy.maxZoom ?? MAP_MAX_ZOOM);
    pendingPoints = points;
    if (!ensureCreated()) return;
    apply();
  }

  /** Contours de zones à afficher (GeoJSON, voir private-zones.js) ; `frameBounds` : rectangle à cadrer. */
  function showZones(outlines, frameBounds = null) {
    zoneOutlines = outlines;
    if (frameBounds) pendingFrame = frameBounds;
    if (!ensureCreated()) return;
    map.getSource(ZONES_SOURCE_ID)?.setData(outlines);
    apply();
  }

  /** `callback(map)` dès que la carte (style compris) est prête : sert aux outils de dessin des zones. */
  function whenReady(callback) {
    if (map && mapReady) callback(map);
    else readyCallbacks.push(callback);
  }

  return {
    show,
    showZones,
    setStrict,
    reloadTiles,
    reloadStyle,
    whenReady,
    getMap: () => map,
    destroy,
    dispose() {
      destroy();
      tileContext.dispose();
    },
  };
}
