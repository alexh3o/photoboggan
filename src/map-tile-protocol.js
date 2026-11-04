// Protocole de tuiles des cartes (`pbmap://`) : toutes les ressources d'une carte (style, tuiles, icônes, polices) passent par ici, et c'est
// le seul code qui peut contacter le fournisseur. MapLibre lui-même ne fait aucune requête réseau (voir transformRequest dans map-view.js).
//
// Règles, pour chaque tuile :
//   1. la tuile touche une zone privée → lue sur le disque par le backend (get_private_tile) ; manquante → tuile vide. Jamais de repli distant ;
//   2. la tuile ne touche que des cartes hors ligne (zones non privées) et l'une l'a sur le disque → lue sur le disque ;
//   3. sinon, carte en mode strict (elle montre un lieu privé) → tuile vide ;
//   4. sinon, accès au fournisseur permis (option carte cochée, mode hors ligne désactivé) → demandée au fournisseur (tuile hors zone, ou
//      manquante / plus détaillée dans une carte hors ligne) ;
//   5. sinon → tuile vide.
// Style, icônes et polices : copie locale (téléchargée avec la première zone) si elle existe, sinon fournisseur selon les règles 3 à 5.
// Chaque carte a son contexte (identifiant dans l'adresse) : passer en mode strict annule ses requêtes distantes en cours.

import { invoke } from '@tauri-apps/api/core';
import { PROVIDER_STYLE_URL, PROVIDER_TILEJSON_URL, PROVIDER_FONT_URL, MAP_ATTRIBUTION, OFFLINE_PLACEHOLDER, isMapNetworkAllowed } from './map-config.js';

export const MAP_PROTOCOL = 'pbmap';
const URL_PATTERN = /^pbmap:\/\/(\d+)\/(style|tiles|sprite|fonts)\/(.+)$/;
// Image PNG transparente de 1 × 1 pixel : icônes indisponibles sans requête distante.
const EMPTY_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), c => c.charCodeAt(0)).buffer;

const contexts = new Map(); // identifiant → { strict, inflight: Set<AbortController> }
let nextContextId = 1;
let registered = false;
let tileTemplate = null; // promesse de l'adresse versionnée des tuiles (TileJSON du fournisseur)
let remoteSpriteBase = null; // adresse des icônes donnée par le style du fournisseur

const emptyStyle = () => ({
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#8a8a8a' } }],
});

// Tuile vectorielle (protobuf MVT) d'une seule couche et d'un seul polygone : le carré qui couvre toute la tuile. Rien d'autre n'est dessiné
// dessus que le motif du style (voir OFFLINE_PLACEHOLDER) : c'est le filigrane des tuiles non chargées.
const PLACEHOLDER_TILE = (() => {
  const text = new TextEncoder().encode(OFFLINE_PLACEHOLDER.layer);
  // Géométrie : MoveTo (0, 0), LineTo (4096, 0) (0, 4096) (-4096, 0), ClosePath (valeurs en zigzag).
  const geometry = [9, 0, 0, 26, 0x80, 0x40, 0, 0, 0x80, 0x40, 0xff, 0x3f, 0, 15];
  const feature = [0x18, 3, 0x22, geometry.length, ...geometry]; // type 3 = polygone
  const layer = [0x78, 2, 0x0a, text.length, ...text, 0x12, feature.length, ...feature, 0x28, 0x80, 0x20]; // version 2, nom, entité, étendue 4096
  return new Uint8Array([0x1a, layer.length, ...layer]).buffer;
})();

// Couche du style qui remplit cette tuile de l'image-motif.
const placeholderLayer = () => ({
  id: 'offline-placeholder', type: 'fill', source: 'openmaptiles', 'source-layer': OFFLINE_PLACEHOLDER.layer,
  paint: { 'fill-pattern': OFFLINE_PLACEHOLDER.image },
});

const isOffline = () => { try { return localStorage.getItem('offlineMode') === 'true'; } catch { return false; } };

/** Enregistre le protocole auprès de MapLibre (une seule fois). */
export function registerMapProtocol(library) {
  if (registered) return;
  registered = true;
  library.addProtocol(MAP_PROTOCOL, handleRequest);
}

/**
 * Contexte d'une carte : adresses de son style, et mode strict (aucune requête distante, requêtes en cours annulées).
 * @returns {{ id: number, styleUrl(theme: string): string, setStrict(strict: boolean): void, isStrict(): boolean, dispose(): void }}
 */
export function createTileContext() {
  const id = nextContextId++;
  const context = { strict: false, inflight: new Set() };
  contexts.set(id, context);
  return {
    id,
    styleUrl: name => `${MAP_PROTOCOL}://${id}/style/${name}`,
    setStrict(strict) {
      context.strict = strict;
      if (strict) {
        for (const controller of context.inflight) controller.abort();
        context.inflight.clear();
      }
    },
    isStrict: () => context.strict,
    dispose() {
      for (const controller of context.inflight) controller.abort();
      contexts.delete(id);
    },
  };
}

async function localResource(path) {
  const buffer = await invoke('get_private_resource', { path });
  return buffer.byteLength > 0 ? buffer : null;
}

// Requête au fournisseur, annulée si la carte passe en mode strict ou si MapLibre n'en veut plus.
async function remoteFetch(context, url, abortController) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  abortController.signal.addEventListener('abort', abort);
  context.inflight.add(controller);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 204 || response.status === 404) return new ArrayBuffer(0);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return await response.arrayBuffer();
  } finally {
    context.inflight.delete(controller);
    abortController.signal.removeEventListener('abort', abort);
  }
}

// Tuiles d'un fichier importé : souvent compressées en gzip (format MBTiles) ; MapLibre attend des tuiles décompressées.
async function gunzipIfNeeded(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buffer;
  return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

const remoteAllowed = context => !context.strict && isMapNetworkAllowed();

async function handleRequest(params, abortController) {
  const match = URL_PATTERN.exec(params.url);
  const context = match && contexts.get(Number(match[1]));
  if (!context) throw new Error(`Unknown map resource: ${params.url}`);
  const [, , kind, rest] = match;
  if (kind === 'style') return { data: await loadStyle(context, Number(match[1]), rest, abortController) };
  if (kind === 'tiles') return { data: await loadTile(context, rest, abortController) };
  if (kind === 'sprite') return { data: await loadSprite(context, rest, params.type, abortController) };
  return { data: await loadGlyphs(context, rest, abortController) };
}

// Style : copie locale si elle existe (aucune requête), sinon celui du fournisseur ; ses sources et adresses sont réécrites vers ce protocole.
async function loadStyle(context, id, name, abortController) {
  let style = null;
  const local = await localResource(`styles/${name}.json`);
  if (local) style = JSON.parse(new TextDecoder().decode(local));
  else if (remoteAllowed(context)) style = JSON.parse(new TextDecoder().decode(await remoteFetch(context, PROVIDER_STYLE_URL(name), abortController)));
  if (!style) return emptyStyle();
  if (typeof style.sprite === 'string' && style.sprite.startsWith('https://')) remoteSpriteBase ??= style.sprite;
  // Seule la source vectorielle est gardée (le relief raster des petits zooms est abandonné : une source de moins à protéger).
  style.layers = style.layers.filter(layer => !layer.source || layer.source === 'openmaptiles');
  style.sources = {
    openmaptiles: {
      type: 'vector',
      tiles: [`${MAP_PROTOCOL}://${id}/tiles/{z}/{x}/{y}`],
      minzoom: 0,
      maxzoom: 14,
      attribution: MAP_ATTRIBUTION,
    },
  };
  style.layers.push(placeholderLayer());
  style.sprite = `${MAP_PROTOCOL}://${id}/sprite/sprite`;
  style.glyphs = `${MAP_PROTOCOL}://${id}/fonts/{fontstack}/{range}.pbf`;
  return style;
}

async function loadTile(context, path, abortController) {
  // `#n` en fin d'adresse : génération des tuiles (voir reloadTiles dans map-view.js), sans effet sur la tuile demandée.
  const [z, x, y] = path.split('#')[0].split('/').map(Number);
  const answer = new Uint8Array(await invoke('get_private_tile', { z, x, y }));
  // 1 : tuile privée (disque uniquement) ; 2 : tuile d'une carte hors ligne présente sur le disque ; 0 et 3 : le fournisseur peut être sollicité.
  if (answer[0] === 1 || answer[0] === 2) return gunzipIfNeeded(answer.slice(1).buffer);
  if (!remoteAllowed(context)) return !context.strict && isOffline() ? PLACEHOLDER_TILE.slice(0) : new ArrayBuffer(0); // hors ligne : filigrane (lieu privé : vide)
  tileTemplate ??= remoteFetch(context, PROVIDER_TILEJSON_URL, new AbortController())
    .then(buffer => JSON.parse(new TextDecoder().decode(buffer)).tiles[0])
    .catch(error => { tileTemplate = null; throw error; });
  const template = await tileTemplate;
  // Vérifié à nouveau : la carte a pu passer en mode strict pendant l'attente.
  if (!remoteAllowed(context)) return new ArrayBuffer(0);
  return remoteFetch(context, template.replace('{z}', z).replace('{x}', x).replace('{y}', y), abortController);
}

async function loadSprite(context, file, type, abortController) {
  const local = await localResource(`sprites/${file}`);
  const isJson = file.endsWith('.json');
  let buffer = local;
  if (!buffer && remoteAllowed(context) && remoteSpriteBase) {
    buffer = await remoteFetch(context, `${remoteSpriteBase}${file.slice('sprite'.length)}`, abortController);
  }
  if (!buffer || buffer.byteLength === 0) return isJson ? {} : EMPTY_PNG;
  return isJson || type === 'json' ? JSON.parse(new TextDecoder().decode(buffer)) : buffer;
}

async function loadGlyphs(context, path, abortController) {
  const slash = path.lastIndexOf('/');
  const fontstack = decodeURIComponent(path.slice(0, slash));
  const range = path.slice(slash + 1).replace(/\.pbf$/, '');
  // Pile de polices : la première de la liste suffit (le style n'en utilise qu'une par pile).
  const font = fontstack.split(',')[0].trim();
  const local = await localResource(`fonts/${font}/${range}.pbf`);
  if (local) return local;
  if (!remoteAllowed(context)) return new ArrayBuffer(0);
  return remoteFetch(context, PROVIDER_FONT_URL(font, range), abortController);
}
