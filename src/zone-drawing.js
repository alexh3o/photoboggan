// Dessin d'une zone privée sur une carte MapLibre, sans bibliothèque supplémentaire :
// - cercle : appuyer sur le centre, glisser jusqu'au rayon voulu, relâcher (un nouveau glissement le redessine) ;
// - polygone : un clic par sommet, double-clic ou Entrée pour fermer, Retour arrière retire le dernier sommet.
// Réutilisable par la future vue carte. Le tracé est rendu par `onChange(geometry)` (null tant qu'il n'est pas complet).

import { distanceMeters, zoneRing } from './private-zones.js';

const DRAFT_ID = 'zone-draft';
const MIN_RADIUS = 50; // mètres (voir ZoneGeometry::validate)

/**
 * @param {import('maplibre-gl').Map} map
 * @param {{ mode: 'circle' | 'polygon', onChange: (geometry: object | null) => void }} options
 * @returns {{ setMode(mode: string): void, clear(): void, stop(): void }}
 */
export function startZoneDrawing(map, { mode, onChange }) {
  let currentMode = mode;
  let center = null; // cercle : centre { lat, lon }
  let radius = 0;
  let dragging = false;
  let vertices = []; // polygone : sommets [lon, lat]
  let cursor = null; // polygone : position de la souris (aperçu du côté suivant)
  let closed = false;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--selected-border').trim() || '#1e72ad';
  const canvas = map.getCanvas();
  const previousCursor = canvas.style.cursor;
  canvas.style.cursor = 'crosshair';

  map.addSource(DRAFT_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: `${DRAFT_ID}-fill`, type: 'fill', source: DRAFT_ID, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': accent, 'fill-opacity': 0.2 } });
  map.addLayer({ id: `${DRAFT_ID}-line`, type: 'line', source: DRAFT_ID, filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': accent, 'line-width': 2 } });
  map.addLayer({ id: `${DRAFT_ID}-points`, type: 'circle', source: DRAFT_ID, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': accent, 'circle-stroke-width': 2 } });

  const geometry = () => {
    if (currentMode === 'circle') return center && radius >= MIN_RADIUS && !dragging ? { kind: 'circle', lat: center.lat, lon: center.lon, radius: Math.round(radius) } : null;
    return closed && vertices.length >= 3 ? { kind: 'polygon', points: vertices.map(([lon, lat]) => [lat, lon]) } : null;
  };

  function render() {
    const features = [];
    if (currentMode === 'circle' && center && radius > 0) {
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [zoneRing({ kind: 'circle', lat: center.lat, lon: center.lon, radius })] } });
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [center.lon, center.lat] } });
    } else if (currentMode === 'polygon' && vertices.length) {
      const line = closed ? [...vertices, vertices[0]] : cursor ? [...vertices, cursor] : vertices;
      if (closed) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [line] } });
      else if (line.length >= 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } });
      for (const vertex of vertices) features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: vertex } });
    }
    map.getSource(DRAFT_ID)?.setData({ type: 'FeatureCollection', features });
  }

  const changed = () => {
    render();
    onChange(geometry());
  };

  function clear() {
    center = null; radius = 0; dragging = false;
    vertices = []; cursor = null; closed = false;
    map.dragPan.enable();
    changed();
  }

  const onMouseDown = event => {
    if (currentMode !== 'circle' || event.originalEvent.button !== 0) return;
    event.preventDefault();
    map.dragPan.disable();
    center = { lat: event.lngLat.lat, lon: event.lngLat.lng };
    radius = 0;
    dragging = true;
    changed();
  };
  const onMouseMove = event => {
    if (currentMode === 'circle' && dragging) {
      radius = distanceMeters(center, { lat: event.lngLat.lat, lon: event.lngLat.lng });
      render();
    } else if (currentMode === 'polygon' && !closed && vertices.length) {
      cursor = [event.lngLat.lng, event.lngLat.lat];
      render();
    }
  };
  const onMouseUp = () => {
    if (currentMode !== 'circle' || !dragging) return;
    dragging = false;
    map.dragPan.enable();
    changed();
  };
  const onClick = event => {
    if (currentMode !== 'polygon') return;
    if (closed) { vertices = []; closed = false; }
    vertices.push([event.lngLat.lng, event.lngLat.lat]);
    changed();
  };
  const closePolygon = () => {
    if (currentMode !== 'polygon' || closed || vertices.length < 3) return;
    closed = true;
    cursor = null;
    changed();
  };
  const onDoubleClick = event => {
    event.preventDefault();
    // Le double-clic a d'abord ajouté deux sommets au même endroit : le second est retiré.
    if (vertices.length >= 2) {
      const [a, b] = vertices.slice(-2);
      if (a[0] === b[0] && a[1] === b[1]) vertices.pop();
    }
    closePolygon();
  };
  const onKeyDown = event => {
    if (currentMode !== 'polygon') return;
    if (event.key === 'Enter') { event.preventDefault(); closePolygon(); }
    else if (event.key === 'Backspace' && vertices.length && !closed) { event.preventDefault(); vertices.pop(); changed(); }
  };

  map.on('mousedown', onMouseDown);
  map.on('mousemove', onMouseMove);
  map.on('mouseup', onMouseUp);
  map.on('click', onClick);
  map.on('dblclick', onDoubleClick);
  canvas.addEventListener('keydown', onKeyDown);
  canvas.tabIndex = 0;

  return {
    setMode(mode) {
      currentMode = mode;
      clear();
    },
    clear,
    stop() {
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
      map.off('click', onClick);
      map.off('dblclick', onDoubleClick);
      canvas.removeEventListener('keydown', onKeyDown);
      map.dragPan.enable();
      canvas.style.cursor = previousCursor;
      for (const id of [`${DRAFT_ID}-points`, `${DRAFT_ID}-line`, `${DRAFT_ID}-fill`]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(DRAFT_ID)) map.removeSource(DRAFT_ID);
    },
  };
}
