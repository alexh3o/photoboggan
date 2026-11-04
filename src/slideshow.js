// Diaporama : un état du plein écran (pas un mode à part). Un minuteur fait passer le plein écran à la photo suivante ; tout le reste
// (chargement, préchargement, zoom, notes, Échap) est assuré par le plein écran lui-même. main.js appelle ce module depuis closeFullscreen
// (arrêt), showFullscreenPhoto (armement du minuteur) et le clavier (F10, Espace) ; photo-actions.js y lit les réglages pour le menu contextuel.
import { t } from './i18n.js';

// ==========================================
// RÉGLAGES (mémorisés localement, partagés par le menu contextuel et Paramètres > Général)
// ==========================================
export const SLIDESHOW_DELAYS = [2, 3, 5, 10, 30]; // durées proposées par le menu contextuel (secondes) ; Paramètres accepte 1 à 60
const MIN_DELAY = 1;
const MAX_DELAY = 60;
const DEFAULT_DELAY = 5;

const storageKey = { delay: 'slideshowDelay', loop: 'slideshowLoop', random: 'slideshowRandom' };

function readStored(key) {
  try { return localStorage.getItem(storageKey[key]); } catch { return null; }
}

function clampDelay(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(MIN_DELAY, Math.min(MAX_DELAY, number)) : DEFAULT_DELAY;
}

// { delay (secondes), loop, random } : toujours lus à la source, les modifier depuis un endroit les met à jour partout.
export function getSlideshowSettings() {
  const storedDelay = readStored('delay');
  return {
    delay: storedDelay === null ? DEFAULT_DELAY : clampDelay(storedDelay),
    loop: readStored('loop') === '1',
    random: readStored('random') === '1',
  };
}

export function setSlideshowOption(key, value) {
  const stored = key === 'delay' ? String(clampDelay(value)) : (value ? '1' : '0');
  try { localStorage.setItem(storageKey[key], stored); } catch { /* stockage indisponible : le réglage vaut pour cette session seulement */ }
  refreshSettingsControls();
  // Aléatoire activé ou désactivé pendant la lecture : l'ordre est refait à partir de la photo affichée.
  if (state.active && key === 'random') rebuildFrom(state.order[state.pos], state.pool);
  if (state.active && key === 'delay') arm(); // la nouvelle durée vaut dès maintenant
}

// ==========================================
// ORDRE DE LECTURE
// ==========================================
function shuffle(list) {
  const result = [...list];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Ordre de lecture de `pool` (photos, sans vidéo) à partir de `start`. Normal : l'ordre de la vue, `pos` repérant `start`.
// Aléatoire : permutation où `start` passe en premier, chaque photo n'apparaissant qu'une fois par cycle.
export function buildSlideshowOrder(pool, start, random) {
  if (!random) return { order: pool, pos: Math.max(0, pool.indexOf(start)) };
  const others = shuffle(pool.filter(photo => photo !== start));
  return { order: pool.includes(start) ? [start, ...others] : others, pos: 0 };
}

// ==========================================
// ÉTAT ET MINUTEUR
// ==========================================
const state = {
  active: false,
  paused: false,
  pool: [],      // photos concernées (la vue entière ou la sélection), sans vidéo
  order: [],     // ordre de lecture
  pos: 0,        // position de la photo affichée dans `order`
  timer: null,
  shown: null,   // dernière photo vue affichée : un nouveau rendu de la même photo (changement de note) ne relance pas le minuteur
};

let deps = null;
let fullscreenView = null;
let indicator = null;
let indicatorTimeout = null;
let cursorTimeout = null;

const PLAY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
const PAUSE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>';

const STOP_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>';

export function isSlideshowActive() {
  return state.active;
}

export function isSlideshowPaused() {
  return state.active && state.paused;
}

// deps : getPhotos, getSelectedIndices, getCurrentIndex, isVideo(photo), isZoomed(), openFullscreen(index), isFullscreen(), goToIndex(index), showToast(message)
export function initSlideshow(options) {
  deps = options;
  fullscreenView = document.getElementById('fullscreen-view');
  indicator = document.getElementById('slideshow-indicator');
  // Curseur masqué après 2 s sans mouvement pendant la lecture.
  fullscreenView.addEventListener('pointermove', wakeCursor);
  bindSettingsControls();
}

function arm() {
  clearTimeout(state.timer);
  state.timer = null;
  if (!state.active || state.paused) return;
  state.timer = setTimeout(tick, getSlideshowSettings().delay * 1000);
}

function disarm() {
  clearTimeout(state.timer);
  state.timer = null;
}

// Photo `photo` de la vue : index courant dans `photos` (-1 si elle n'y est plus, par exemple après une suppression).
function viewIndexOf(photo) {
  return deps.getPhotos().indexOf(photo);
}

// Le délai est écoulé : photo suivante, ou pause si l'utilisateur a zoomé pour examiner un détail.
function tick() {
  state.timer = null;
  if (!state.active || state.paused) return;
  if (deps.isZoomed()) { setPaused(true); return; }
  advance();
}

function advance() {
  const { loop, random } = getSlideshowSettings();
  // Les photos retirées de la vue depuis le lancement (suppression) sont sautées.
  for (let guard = 0; guard <= state.order.length; guard++) {
    let next = state.pos + 1;
    if (next >= state.order.length) {
      if (!loop) { finish(); return; }
      if (random) {
        // Nouveau cycle : autre permutation, sans que la photo qui vient de s'afficher ouvre le cycle.
        const last = state.order[state.order.length - 1];
        let order = shuffle(state.pool);
        if (order.length > 1 && order[0] === last) [order[0], order[1]] = [order[1], order[0]];
        state.order = order;
      }
      next = 0;
    }
    state.pos = next;
    const index = viewIndexOf(state.order[next]);
    if (index >= 0) {
      deps.goToIndex(index);
      arm(); // filet de sécurité si l'image n'est jamais signalée affichée ; notifySlideshowPhotoShown relance ensuite le délai
      return;
    }
  }
  finish();
}

// Fin sans bouclage : le diaporama s'arrête, la dernière photo reste affichée en plein écran.
function finish() {
  stopSlideshow();
  deps.showToast(t('End of the slideshow'));
}

// Photo à précharger après celle qui s'affiche (null si inconnue : la prochaine permutation n'existe pas encore).
export function peekNextSlideshowPhoto() {
  if (!state.active) return null;
  if (state.pos + 1 < state.order.length) return state.order[state.pos + 1];
  return getSlideshowSettings().loop && !getSlideshowSettings().random ? state.order[0] ?? null : null;
}

// Appelé quand le plein écran vient d'afficher `photo` (ou n'a pas pu la charger) : le délai compte à partir de maintenant.
export function notifySlideshowPhotoShown(photo) {
  if (!state.active || photo === state.shown) return;
  state.shown = photo;
  // L'utilisateur a changé de photo à la main (flèches, molette) : la lecture reprend à partir de celle-ci.
  if (state.order[state.pos] !== photo) {
    const found = state.order.indexOf(photo);
    if (found >= 0) state.pos = found;
    else rebuildFrom(photo, deps.getPhotos().filter(candidate => !deps.isVideo(candidate)));
  }
  arm();
}

// Reconstruit l'ordre autour de `photo` (ordre aléatoire basculé, ou photo hors de la sélection d'origine).
function rebuildFrom(photo, pool) {
  state.pool = pool;
  const { order, pos } = buildSlideshowOrder(pool, photo, getSlideshowSettings().random);
  state.order = order;
  state.pos = pos;
}

// ==========================================
// LANCEMENT, PAUSE, ARRÊT
// ==========================================
// Lance le diaporama depuis la photo courante, sur la sélection si elle compte 2 photos ou plus (hors plein écran), sinon sur toute la vue.
export function startSlideshow() {
  const photos = deps.getPhotos();
  if (state.active) return;
  const fullscreen = deps.isFullscreen();
  const selected = fullscreen ? [] : [...deps.getSelectedIndices()].sort((a, b) => a - b);
  const source = selected.length >= 2 ? selected.map(index => photos[index]) : photos;
  const pool = source.filter(photo => photo && !deps.isVideo(photo));
  if (pool.length < 2) {
    deps.showToast(t('The slideshow needs at least 2 photos'));
    return;
  }
  // Départ : la photo courante si elle est dans le lot, sinon la première photo du lot qui la suit (ou la première).
  const current = photos[deps.getCurrentIndex()];
  let start = pool.includes(current) ? current : null;
  if (!start) start = pool.find(photo => photos.indexOf(photo) > deps.getCurrentIndex()) ?? pool[0];

  state.active = true;
  state.paused = false;
  state.shown = null;
  rebuildFrom(start, pool);
  fullscreenView.classList.add('slideshow');
  if (!fullscreen) deps.openFullscreen(photos.indexOf(start));
  else deps.goToIndex(photos.indexOf(start));
  renderIndicator(true);
  arm(); // filet de sécurité, voir advance()
  wakeCursor();
}

// Arrête le diaporama et affiche un instant l'icône ■ au même endroit que ▶ / ⏸, sauf `{ silent: true }` (sortie du plein écran : rien à montrer).
export function stopSlideshow(options) {
  if (!state.active) return;
  const silent = options?.silent === true;
  state.active = false;
  state.paused = false;
  state.shown = null;
  state.order = [];
  state.pool = [];
  disarm();
  clearTimeout(indicatorTimeout);
  clearTimeout(cursorTimeout);
  fullscreenView.classList.remove('slideshow', 'slideshow-paused', 'cursor-idle');
  if (silent) {
    indicator.hidden = true;
    return;
  }
  indicator.innerHTML = STOP_ICON;
  indicator.title = t('Slideshow stopped');
  indicator.hidden = false;
  indicator.classList.add('visible');
  indicatorTimeout = setTimeout(() => indicator.classList.remove('visible'), 1500);
}

function setPaused(paused) {
  if (!state.active || state.paused === paused) return;
  state.paused = paused;
  if (paused) disarm();
  else arm();
  renderIndicator(true);
  wakeCursor();
}

// Espace : pause / lecture. Sans effet si le diaporama n'est pas lancé.
export function toggleSlideshowPause() {
  if (state.active) setPaused(!state.paused);
}

// ==========================================
// INDICATEUR (coin haut gauche du plein écran) ET CURSEUR
// ==========================================
// En pause, l'icône ⏸ reste affichée. En lecture, l'icône ▶ n'apparaît qu'un instant après le lancement ou la reprise.
function renderIndicator(flash) {
  clearTimeout(indicatorTimeout);
  indicator.innerHTML = state.paused ? PAUSE_ICON : PLAY_ICON;
  indicator.title = state.paused ? t('Slideshow paused') : t('Slideshow playing');
  fullscreenView.classList.toggle('slideshow-paused', state.paused);
  indicator.hidden = false;
  indicator.classList.add('visible');
  if (!state.paused && flash) indicatorTimeout = setTimeout(() => indicator.classList.remove('visible'), 1500);
}

function wakeCursor() {
  if (!state.active) return;
  fullscreenView.classList.remove('cursor-idle');
  clearTimeout(cursorTimeout);
  if (!state.paused) cursorTimeout = setTimeout(() => fullscreenView.classList.add('cursor-idle'), 2000);
}

// ==========================================
// PARAMÈTRES > GÉNÉRAL
// ==========================================
function bindSettingsControls() {
  const delayInput = document.getElementById('slideshow-delay');
  const loopInput = document.getElementById('slideshow-loop');
  const randomInput = document.getElementById('slideshow-random');
  if (!delayInput || !loopInput || !randomInput) return;
  delayInput.addEventListener('change', () => setSlideshowOption('delay', delayInput.value));
  loopInput.addEventListener('change', () => setSlideshowOption('loop', loopInput.checked));
  randomInput.addEventListener('change', () => setSlideshowOption('random', randomInput.checked));
  refreshSettingsControls();
}

// Remet les champs de Paramètres d'accord avec les réglages (modifiés aussi par le menu contextuel).
function refreshSettingsControls() {
  const settings = getSlideshowSettings();
  const delayInput = document.getElementById('slideshow-delay');
  const loopInput = document.getElementById('slideshow-loop');
  const randomInput = document.getElementById('slideshow-random');
  if (delayInput) delayInput.value = String(settings.delay);
  if (loopInput) loopInput.checked = settings.loop;
  if (randomInput) randomInput.checked = settings.random;
}
