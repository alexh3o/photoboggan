// Carte MapLibre réutilisable (panneau Info, fenêtre des zones privées, plus tard vue carte de la bibliothèque) : une seule instance par
// conteneur, créée au premier affichage et réutilisée ensuite.
//
// Accès réseau : MapLibre ne contacte jamais le fournisseur lui-même. Toutes ses ressources passent par le protocole `pbmap://`
// (map-tile-protocol.js), qui applique la règle par tuile des zones privées et le mode strict ; `transformRequest` détourne toute autre adresse
// vers une adresse locale vide. Rien n'est importé tant que `isAllowed()` est faux. `destroy()` libère le contexte WebGL.

import { MAP_PROVIDER, MAP_MAX_ZOOM, OFFLINE_PLACEHOLDER, defaultMapZoom } from './map-config.js';
import { t } from './i18n.js';
import { registerMapProtocol, createTileContext, MAP_PROTOCOL } from './map-tile-protocol.js';
// Adresse du script du worker MapLibre (fichier copié tel quel par Vite) : une simple chaîne, rien n'est chargé à l'import.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

const BLOCKED_URL = 'data:application/json,{}';
const SOURCE_ID = 'photo-locations';
const ZONES_SOURCE_ID = 'private-zones';
const TILE_SOURCE_ID = 'openmaptiles';
const BACKDROP_SOURCE_ID = 'photo-backdrop'; // toutes les photos affichées (mode Carte), discrètes, sous la sélection
// Couleurs des zones (mode Carte) : pointillés verts pour une zone privée, noirs pour une autre zone hors ligne ; un liseré clair dessous les garde
// lisibles sur le thème sombre.
const PRIVATE_ZONE_COLOR = '#2e9e4f';
const OFFLINE_ZONE_COLOR = '#000000';
const OTHER_SELECTED_COLOR = '#4da3ff'; // photos sélectionnées autres que la photo active (la photo active a la couleur de sélection)
const PENDING_COLOR = '#f59e0b'; // position en attente d'écriture
const BACKDROP_COLOR = '#8a94a6';

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

// Filigrane des tuiles non chargées (mode hors ligne) : image-motif transparente, texte incliné, clair sur le style sombre et foncé sur le clair.
// Dessinée à la demande du style (styleimagemissing), donc refaite à chaque changement de style (thème, langue au prochain chargement).
function watermarkImage() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const dark = document.documentElement.dataset.theme !== 'light';
  context.translate(size / 2, size / 2);
  context.rotate(-Math.PI / 6);
  context.textAlign = 'center';
  context.fillStyle = dark ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.4)';
  context.font = 'bold 14px sans-serif';
  context.fillText(t('Offline mode'), 0, -4);
  context.font = '12px sans-serif';
  context.fillText(t('Turn it off to load the map'), 0, 14);
  return context.getImageData(0, 0, size, size);
}

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
// Cartes existantes : le changement du mode hors ligne les concerne toutes (voir reloadAllMaps).
const mapViews = new Set();

/** Style et tuiles redemandés pour toutes les cartes : à appeler quand le mode hors ligne ou l'option « Afficher une carte » change. */
export function reloadAllMaps() {
  for (const view of mapViews) view.reloadStyle();
}

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
  let sizedWidth = 0;
  let sizedHeight = 0;
  let frameOnApply = true; // le mode Carte règle lui-même le cadrage (frameTo) : show() ne recadre alors pas
  let backdropPoints = [];
  let tileGeneration = 0;
  const tileContext = createTileContext();
  const readyCallbacks = [];

  const isVisible = () => container.clientWidth > 0 && container.clientHeight > 0;

  function featureCollection(points) {
    return {
      type: 'FeatureCollection',
      features: points.map(point => ({
        type: 'Feature',
        properties: { focus: !!point.focus, other: !!point.other, pending: !!point.pending },
        geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
      })),
    };
  }

  // Couches ajoutées au style (à refaire après un changement de style) : contours des zones privées, puis positions des photos (un cercle
  // par photo, la photo active plus grande et dessinée au-dessus).
  function addOverlayLayers() {
    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue('--selected-border').trim() || '#1e72ad';
    const zoneColor = ['case', ['==', ['get', 'private'], false], OFFLINE_ZONE_COLOR, PRIVATE_ZONE_COLOR];
    if (!map.getSource(ZONES_SOURCE_ID)) {
      map.addSource(ZONES_SOURCE_ID, { type: 'geojson', data: zoneOutlines || { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: `${ZONES_SOURCE_ID}-fill`, type: 'fill', source: ZONES_SOURCE_ID,
        paint: { 'fill-color': zoneColor, 'fill-opacity': ['case', ['get', 'selected'], 0.22, 0.08] },
      });
      map.addLayer({
        id: `${ZONES_SOURCE_ID}-casing`, type: 'line', source: ZONES_SOURCE_ID,
        paint: { 'line-color': 'rgba(255, 255, 255, 0.85)', 'line-width': ['case', ['get', 'selected'], 5, 4] },
      });
      map.addLayer({
        id: `${ZONES_SOURCE_ID}-line`, type: 'line', source: ZONES_SOURCE_ID,
        paint: { 'line-color': zoneColor, 'line-width': ['case', ['get', 'selected'], 2.5, 1.5], 'line-dasharray': [2, 1.5] },
      });
    }
    if (!map.getSource(BACKDROP_SOURCE_ID)) {
      map.addSource(BACKDROP_SOURCE_ID, { type: 'geojson', data: featureCollection(backdropPoints) });
      map.addLayer({
        id: BACKDROP_SOURCE_ID, type: 'circle', source: BACKDROP_SOURCE_ID,
        paint: {
          'circle-radius': 3.5,
          'circle-color': ['case', ['get', 'pending'], PENDING_COLOR, BACKDROP_COLOR],
          'circle-opacity': 0.75,
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 0.75,
          'circle-stroke-opacity': 0.6,
        },
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
          'circle-color': ['case', ['get', 'focus'], accent, ['get', 'other'], OTHER_SELECTED_COLOR, accent],
          'circle-stroke-color': ['case', ['get', 'pending'], PENDING_COLOR, '#fff'],
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
      map.jumpTo({ center: [focus.lon, focus.lat], zoom: Math.min(points.length === 1 ? defaultMapZoom() : MAP_MAX_ZOOM, maxZoom) });
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
    // resize() déclenche des événements de mouvement (movestart / moveend) : seulement si la taille a changé, sinon chaque mise à jour des points
    // relancerait ceux qui l'ont provoquée (filtre « Zone visible seulement » du mode Carte).
    if (container.clientWidth !== sizedWidth || container.clientHeight !== sizedHeight) {
      sizedWidth = container.clientWidth;
      sizedHeight = container.clientHeight;
      map.resize();
    }
    if (pendingPoints) {
      map.getSource(SOURCE_ID)?.setData(featureCollection(pendingPoints));
      if (frameOnApply) frame(pendingPoints);
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
      zoom: focus ? Math.min(defaultMapZoom(), strict ? strictMaxZoom : MAP_MAX_ZOOM) : 4,
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
    map.on('styleimagemissing', event => {
      if (event.id === OFFLINE_PLACEHOLDER.image && !map.hasImage(event.id)) map.addImage(event.id, watermarkImage(), { pixelRatio: 1 });
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
    // Contexte perdu pour de bon (pilote, mémoire). Une destruction voulue (destroy) le perd aussi : elle n'est pas une panne, la carte a déjà été
    // retirée (et remplacée, ou non) à ce moment-là.
    const createdMap = map;
    createdMap.getCanvas().addEventListener('webglcontextlost', () => {
      if (map !== createdMap) return;
      destroy();
      onStatus('unavailable');
    });
  }

  function destroy() {
    creating = null;
    mapReady = false;
    sizedWidth = 0;
    sizedHeight = 0;
    tilesFailed = false;
    if (map) {
      const removed = map;
      map = null; // avant remove() : l'événement de perte de contexte qu'il provoque ne doit pas passer pour une panne
      removed.remove(); // annule les requêtes en cours et libère le contexte WebGL
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
  function show(points, privacy = {}, { frame: reframe = true } = {}) {
    frameOnApply = reframe;
    // Le mode strict passe en premier : aucun recadrage vers un lieu privé avec une carte encore autorisée à contacter le fournisseur.
    setStrict(!!privacy.strict, privacy.maxZoom ?? MAP_MAX_ZOOM);
    pendingPoints = points;
    if (!ensureCreated()) return;
    apply();
  }

  /** Toutes les photos affichées (mode Carte) : points discrets sous la sélection ; `pending` : position en attente d'écriture. */
  function setBackdrop(points) {
    backdropPoints = points;
    map?.getSource(BACKDROP_SOURCE_ID)?.setData(featureCollection(points));
  }

  /**
   * Cadrage sur ces positions (mode Carte), sans animation. `onlyIfOutside` : seulement si l'une d'elles est hors de la zone visible, ce qui
   * évite de déplacer la carte sous l'utilisateur qui la parcourt.
   */
  function frameTo(points, { onlyIfOutside = false } = {}) {
    whenReady(() => {
      if (!isVisible() || points.length === 0) return;
      if (onlyIfOutside) {
        const bounds = map.getBounds();
        if (points.every(point => bounds.contains([point.lon, point.lat]))) return;
      }
      frame(points);
    });
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

  const view = {
    show,
    showZones,
    setBackdrop,
    frameTo,
    setStrict,
    reloadTiles,
    reloadStyle,
    whenReady,
    getMap: () => map,
    destroy,
    dispose() {
      mapViews.delete(view);
      destroy();
      tileContext.dispose();
    },
  };
  mapViews.add(view);
  return view;
}
