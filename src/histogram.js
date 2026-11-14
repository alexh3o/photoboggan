// Histogramme de la photo courante (canvas 2D) et surcouche d'écrêtage des ombres / hautes lumières.
//
// Calcul : sur la MINIATURE de la photo (cache de la grille), décodée par le webview puis lue dans un canvas : pas de lecture de l'original, pas d'IPC,
// et les RAW / HEIC / vidéos sont couverts puisque leur miniature est un JPEG généré par le backend (un RAW est donc calculé sur son aperçu intégré).
// Les pixels des dernières photos sont gardés en mémoire (cache LRU) : changer le réglage de plage d'écrêtage ne relit pas l'image.
//
// Affichage : un seul encadré flottant (#histogram-widget, position fixed) calé sur le coin bas droit de la zone courante (grille, aperçu ou plein
// écran, voir `getView` fourni par main.js) ; un clic bascule Luminance / RVB. Apparence et écrêtage réglables dans histogram.css.
import './histogram.css';
import { t, labelWithColon, getLanguage } from './i18n.js';
import { DEFAULTS, readStored, writeStored } from './settings-defaults.js';

const MAX_ANALYSIS_SIDE = 768;   // plus grand côté des pixels analysés (au-delà, l'image est réduite : surtout le repli sur l'image d'origine)
const PIXEL_CACHE_SIZE = 6;      // photos dont les pixels restent en mémoire
const ANALYSIS_DELAY_MS = 30;    // attente avant analyse : évite de décoder chaque miniature pendant un défilement rapide au clavier
const DEFAULT_CLIPPING_RANGE = DEFAULTS.clippingRange;
const MAX_CLIPPING_RANGE = 20;

// Réglages (Options d'affichage > Histogramme), mémorisés localement.
let showHistogram = (readStored('showHistogram') ?? String(DEFAULTS.showHistogram)) === 'true';
let showClippings = (readStored('showClippings') ?? String(DEFAULTS.showClippings)) === 'true';
let clippingMode = (readStored('clippingMode') ?? DEFAULTS.clippingMode) === 'bw' ? 'bw' : 'colors';// 'colors' : rouge / bleu fixes ; 'bw' : noir / blanc pulsant
let clippingRange = clampRange(Number(readStored('clippingRange') ?? DEFAULT_CLIPPING_RANGE));
let rgbMode = (readStored('histogramRgb') ?? String(DEFAULTS.histogramRgb)) === 'true';                         // false : luminance, true : trois courbes RVB

function clampRange(value) {
  return Number.isFinite(value) ? Math.min(MAX_CLIPPING_RANGE, Math.max(0, Math.round(value))) : DEFAULT_CLIPPING_RANGE;
}

let host = null;                 // { getView, getThumbnailUrl, getFallbackUrl, showToast, watch }
let widget = null;
let canvas = null;
let statsLabel = null;
let warningIcon = null;
let showOverlaysOf = new Set();  // surcouches actuellement visibles (pour masquer celles qui ne sont plus visées)

// ---------------------------------------------------------------------------------------------------------------------
// Analyse des pixels
// ---------------------------------------------------------------------------------------------------------------------

// Pixels de la miniature : { width, height, pixels (RGBA), hist: { l, r, g, b } (256 compteurs chacun) }.
const pixelCache = new Map();

function computeHistograms(pixels) {
  const l = new Uint32Array(256), r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256);
  for (let i = 0; i < pixels.length; i += 4) {
    const red = pixels[i], green = pixels[i + 1], blue = pixels[i + 2];
    r[red]++; g[green]++; b[blue]++;
    l[Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue)]++; // luminance Rec. 709
  }
  return { l, r, g, b };
}

// Écrêtage : un pixel est écrêté dans les ombres quand ses trois canaux sont <= plage, dans les hautes lumières quand ils sont tous >= 255 - plage.
// Renvoie les pourcentages et, si demandé, un masque (bit 1 : ombres, bit 2 : hautes lumières) pour la surcouche.
function computeClipping(entry, range, withMask) {
  const { pixels, width, height } = entry;
  const high = 255 - range;
  const mask = withMask ? new Uint8Array(width * height) : null;
  let shadows = 0, highlights = 0;
  for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
    const red = pixels[i], green = pixels[i + 1], blue = pixels[i + 2];
    if (red <= range && green <= range && blue <= range) { shadows++; if (mask) mask[p] = 1; }
    else if (red >= high && green >= high && blue >= high) { highlights++; if (mask) mask[p] = 2; }
  }
  const total = Math.max(1, width * height);
  return { shadowPct: (shadows / total) * 100, highlightPct: (highlights / total) * 100, mask };
}

// Décode l'image de `url` et en lit les pixels (réduits à MAX_ANALYSIS_SIDE). Renvoie null si l'image est illisible.
async function readPixels(url) {
  // `fetch` + blob : le bitmap n'est pas « tainted » (une <img> sur une URL asset: d'une autre origine ferait échouer getImageData). La CSP l'autorise (connect-src asset:).
  let bitmap;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bitmap = await createImageBitmap(await response.blob());
  } catch (fetchError) {
    console.warn('Histogram: fetch failed, falling back to <img>', url, fetchError);
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = url;
    await image.decode();
    bitmap = await createImageBitmap(image);
  }
  try {
    const scale = Math.min(1, MAX_ANALYSIS_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const work = document.createElement('canvas');
    work.width = width;
    work.height = height;
    const context = work.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    return { width, height, pixels, hist: computeHistograms(pixels) };
  } finally {
    bitmap.close();
  }
}

// Miniature d'abord ; à défaut (format que le backend ne gère pas), l'image affichée de la photo.
async function loadEntry(photo) {
  const cached = pixelCache.get(photo.path);
  if (cached) {
    pixelCache.delete(photo.path); // remis en fin de Map : le plus récemment utilisé
    pixelCache.set(photo.path, cached);
    return cached;
  }
  let entry = null;
  for (const getUrl of [host.getThumbnailUrl, host.getFallbackUrl]) {
    try {
      const url = await getUrl(photo);
      if (!url) continue;
      entry = await readPixels(url);
      if (entry) break;
    } catch (error) {
      console.warn('Histogram: image not readable', photo.path, error);
    }
  }
  if (entry) {
    pixelCache.set(photo.path, entry);
    if (pixelCache.size > PIXEL_CACHE_SIZE) pixelCache.delete(pixelCache.keys().next().value);
  }
  return entry;
}

// ---------------------------------------------------------------------------------------------------------------------
// Dessin
// ---------------------------------------------------------------------------------------------------------------------

const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// Couleur CSS quelconque -> [r, g, b, a (0-255)], via un canvas 1x1.
let colorProbe = null;
function parseColor(value) {
  colorProbe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  colorProbe.canvas.width = colorProbe.canvas.height = 1;
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillStyle = value;
  colorProbe.fillRect(0, 0, 1, 1);
  return colorProbe.getImageData(0, 0, 1, 1).data;
}

function drawHistogram(hist) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (width < 2 || height < 2) return; // encadré masqué : rien à dessiner
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  // Repères aux quarts de l'échelle des tons.
  context.strokeStyle = cssVar('--histogram-grid-color', 'rgba(255,255,255,0.14)');
  context.lineWidth = Math.max(1, dpr);
  context.beginPath();
  for (let quarter = 1; quarter < 4; quarter++) {
    const x = Math.round((width * quarter) / 4) + 0.5;
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  context.stroke();

  const series = rgbMode
    ? [[hist.r, '--histogram-red-color', 'rgba(255,50,50,0.8)'], [hist.g, '--histogram-green-color', 'rgba(40,220,70,0.8)'], [hist.b, '--histogram-blue-color', 'rgba(70,120,255,0.8)']]
    : [[hist.l, '--histogram-luma-color', 'rgba(240,240,240,0.85)']];
  // Échelle : plus grand compteur hors des deux extrémités (0 et 255 accumulent souvent une énorme part et écraseraient le reste de la courbe).
  let peak = 0;
  for (const [bins] of series) for (let i = 1; i < 255; i++) if (bins[i] > peak) peak = bins[i];
  if (peak === 0) for (const [bins] of series) for (let i = 0; i < 256; i++) if (bins[i] > peak) peak = bins[i];
  if (peak === 0) return;

  context.globalCompositeOperation = rgbMode ? 'lighter' : 'source-over'; // RVB : les recouvrements s'additionnent (blanc, jaune…)
  for (const [bins, variable, fallback] of series) {
    context.fillStyle = cssVar(variable, fallback);
    context.beginPath();
    context.moveTo(0, height);
    for (let x = 0; x < width; x++) {
      const bin = Math.min(255, Math.floor((x * 256) / width));
      context.lineTo(x, height - Math.min(1, bins[bin] / peak) * (height - 2));
    }
    context.lineTo(width, height);
    context.closePath();
    context.fill();
  }
  context.globalCompositeOperation = 'source-over';
}

// Pourcentage à la manière de la langue (« 5 % » en français, « 5% » en anglais) : une décimale sous 10 %, aucune au-delà.
function formatPercent(value) {
  const rounded = value < 0.05 ? 0 : value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return new Intl.NumberFormat(getLanguage(), { style: 'percent', maximumFractionDigits: 1 }).format(rounded / 100);
}

function describeClipping(clip) {
  return `${labelWithColon('Shadows')} ${formatPercent(clip.shadowPct)} · ${labelWithColon('Highlights')} ${formatPercent(clip.highlightPct)}`;
}

// Peint le masque d'écrêtage dans une surcouche (canvas de la taille des pixels analysés, étiré par le CSS sur l'image).
function paintOverlay(overlay, entry, clip) {
  const key = `${entry.width}x${entry.height}|${clippingMode}|${clippingRange}|${clip.shadowPct}|${clip.highlightPct}`;
  if (overlay.dataset.paintKey === key && !overlay.hidden) return;
  const bw = clippingMode === 'bw';
  const highlightColor = parseColor(cssVar(bw ? '--clipping-bw-highlight-color' : '--clipping-highlight-color', bw ? 'rgba(0,0,0,0.9)' : 'rgba(255,0,0,0.9)'));
  const shadowColor = parseColor(cssVar(bw ? '--clipping-bw-shadow-color' : '--clipping-shadow-color', bw ? 'rgba(255,255,255,0.9)' : 'rgba(0,90,255,0.9)'));
  overlay.width = entry.width;
  overlay.height = entry.height;
  const context = overlay.getContext('2d');
  const image = context.createImageData(entry.width, entry.height);
  const out = image.data;
  const { mask } = clip;
  for (let p = 0; p < mask.length; p++) {
    const flag = mask[p];
    if (!flag) continue;
    const color = flag === 2 ? highlightColor : shadowColor;
    const o = p * 4;
    out[o] = color[0]; out[o + 1] = color[1]; out[o + 2] = color[2]; out[o + 3] = color[3];
  }
  context.putImageData(image, 0, 0);
  overlay.dataset.paintKey = key;
}

// ---------------------------------------------------------------------------------------------------------------------
// Synchronisation avec l'interface
// ---------------------------------------------------------------------------------------------------------------------

let current = null;              // { path, entry } : dernière analyse affichée
let requestedPath = null;        // photo dont l'analyse est en cours ou terminée
let analysisTimer = null;
let analysisToken = 0;
let syncQueued = false;

// Demande une mise à jour de l'affichage (regroupée sur la prochaine image : peut être appelée sans retenue).
export function syncHistogram() {
  if (!host || syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => { syncQueued = false; runSync(); });
}

function hideOverlays() {
  for (const overlay of showOverlaysOf) overlay.hidden = true;
  showOverlaysOf = new Set();
}

function runSync() {
  const view = host.getView(); // { photo, hidden, fullscreen, anchor (Element ou null = fenêtre), isRaw, overlays }
  const visible = showHistogram && Boolean(view.photo) && !view.hidden;
  widget.classList.toggle('hidden', !visible);
  if (!visible) {
    hideOverlays();
    requestedPath = null;
    analysisToken++;
    clearTimeout(analysisTimer);
    return;
  }
  const rect = view.anchor ? view.anchor.getBoundingClientRect() : { right: window.innerWidth, bottom: window.innerHeight };
  widget.style.setProperty('--histogram-anchor-right', `${Math.max(0, window.innerWidth - rect.right)}px`);
  widget.style.setProperty('--histogram-anchor-bottom', `${Math.max(0, window.innerHeight - rect.bottom)}px`);
  widget.classList.toggle('in-fullscreen', view.fullscreen);
  warningIcon.hidden = !view.isRaw;
  if (view.photo.path !== requestedPath) requestAnalysis(view.photo);
  else render(view);
}

function requestAnalysis(photo) {
  requestedPath = photo.path;
  const token = ++analysisToken;
  clearTimeout(analysisTimer);
  const cached = pixelCache.has(photo.path);
  const run = async () => {
    const entry = await loadEntry(photo);
    if (token !== analysisToken) return; // une autre photo a été demandée entre-temps
    current = entry ? { path: photo.path, entry } : null;
    if (!entry) requestedPath = null; // nouvelle tentative au prochain affichage
    render(host.getView());
  };
  if (cached) run(); else analysisTimer = setTimeout(run, ANALYSIS_DELAY_MS);
}

function render(view) {
  if (widget.classList.contains('hidden')) return;
  const entry = current && view.photo && current.path === view.photo.path ? current.entry : null;
  if (!entry) {
    // Analyse en cours (ou image illisible) : l'ancienne courbe reste affichée tant que la nouvelle n'est pas prête, sauf si la photo n'a plus rien d'analysable.
    if (!current) { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); statsLabel.textContent = requestedPath ? '' : '—'; }
    hideOverlays();
    return;
  }
  drawHistogram(entry.hist);
  const clippingsOn = showClippings;
  const targets = clippingsOn ? view.overlays : [];
  const clip = computeClipping(entry, clippingRange, targets.length > 0);
  statsLabel.textContent = describeClipping(clip);
  widget.title = t('Click to switch between luminance and RGB');
  const next = new Set();
  for (const overlay of targets) {
    paintOverlay(overlay, entry, clip);
    overlay.classList.toggle('clipping-pulse', clippingMode === 'bw');
    overlay.hidden = false;
    next.add(overlay);
  }
  for (const overlay of showOverlaysOf) if (!next.has(overlay)) overlay.hidden = true;
  showOverlaysOf = next;
}

// ---------------------------------------------------------------------------------------------------------------------
// Réglages et clavier
// ---------------------------------------------------------------------------------------------------------------------

let controls = {};

function syncControls() {
  controls.show.checked = showHistogram;
  controls.clippings.checked = showClippings;
  controls.clippings.disabled = !showHistogram;
  controls.mode.value = clippingMode;
  controls.range.value = String(clippingRange);
}

// Touche H : Désactivé -> Histogramme -> Histogramme + écrêtage -> Désactivé. Un toast indique le nouvel état.
export function cycleHistogramState() {
  const state = !showHistogram ? 0 : showClippings ? 2 : 1;
  const next = (state + 1) % 3;
  showHistogram = next > 0;
  showClippings = next === 2;
  writeStored('showHistogram', showHistogram);
  writeStored('showClippings', showClippings);
  syncControls();
  syncHistogram();
  host.showToast(t(['Histogram: off', 'Histogram: displayed', 'Histogram and clippings: displayed'][next]));
}

export function initHistogram(options) {
  host = options;
  widget = document.getElementById('histogram-widget');
  canvas = document.getElementById('histogram-canvas');
  statsLabel = document.getElementById('histogram-stats');
  warningIcon = document.getElementById('histogram-warning');
  controls = {
    show: document.getElementById('show-histogram-toggle'),
    clippings: document.getElementById('show-clippings-toggle'),
    mode: document.getElementById('clipping-display-select'),
    range: document.getElementById('clipping-range-input'),
  };
  syncControls();

  controls.show.addEventListener('change', () => {
    showHistogram = controls.show.checked;
    writeStored('showHistogram', showHistogram);
    syncControls();
    syncHistogram();
  });
  controls.clippings.addEventListener('change', () => {
    showClippings = controls.clippings.checked;
    writeStored('showClippings', showClippings);
    syncHistogram();
  });
  controls.mode.addEventListener('change', () => {
    clippingMode = controls.mode.value === 'bw' ? 'bw' : 'colors';
    writeStored('clippingMode', clippingMode);
    syncHistogram();
  });
  controls.range.addEventListener('change', () => {
    clippingRange = clampRange(Number(controls.range.value));
    controls.range.value = String(clippingRange);
    writeStored('clippingRange', clippingRange);
    syncHistogram();
  });

  // Clic : Luminance <-> RVB (mémorisé). Le bouton rend aussitôt le focus pour ne pas capter les raccourcis clavier.
  widget.addEventListener('click', event => {
    event.stopPropagation();
    rgbMode = !rgbMode;
    writeStored('histogramRgb', rgbMode);
    if (current) drawHistogram(current.entry.hist);
    widget.blur();
  });
  for (const type of ['dblclick', 'contextmenu', 'pointerdown', 'mousedown']) widget.addEventListener(type, event => event.stopPropagation());

  // Position et visibilité suivent les zones surveillées (redimensionnement, ouverture du panneau Info, mode Carte / Personnes…).
  const resizeObserver = new ResizeObserver(() => syncHistogram());
  const mutationObserver = new MutationObserver(() => syncHistogram());
  for (const element of host.watch) {
    if (!element) continue;
    resizeObserver.observe(element);
    mutationObserver.observe(element, { attributes: true, attributeFilter: ['class', 'hidden'] });
  }
  window.addEventListener('resize', syncHistogram);
  syncHistogram();
}
