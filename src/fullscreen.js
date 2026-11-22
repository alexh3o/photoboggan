// Fullscreen photo viewer: display, off-screen decoding, neighbour preloading, optional cached-thumbnail
// preload, zoom/pan (reusing `preview-zoom.js` primitives), info overlay (D), marking bar & popovers (R),
// and external video launch. `main.js` wires host callbacks via `initFullscreen()`.
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { t, getLanguage } from './i18n.js';
import { readBool } from './settings-defaults.js';
import { isVideoPath } from './file-kinds.js';
import { photoTimeKey } from './date-filter.js';
import {
  layoutPreviewSlot, setSlotImageSize, clampPreviewCenter,
  previewAnchorAt, wheelZoomSteps, zoomPreviewSteps, showZoomIndicator,
} from './preview-zoom.js';
import {
  stopSlideshow, isSlideshowActive, notifySlideshowPhotoShown, peekNextSlideshowPhoto,
} from './slideshow.js';
import { syncHistogram } from './histogram.js';
import { layoutFullscreenFaces } from './faces-panel.js';

let host = {};
let initialized = false;

let isFullscreen = false;
let fullscreenRatingPinned = false;
let fullscreenRatingTimeout = null;
const fullscreenImageCache = new Map();

// Fullscreen zoom: same slot structure as a preview cell (see layoutPreviewSlot in preview-zoom.js); fit fills the whole window (margin 1).
const fullscreenSlot = {
  photo: null, url: '', cell: null, img: null, clip: null,
  naturalWidth: 0, naturalHeight: 0, fit: 1, fitMargin: 1, zoom: null,
  tx: 0, ty: 0, displayWidth: 0, displayHeight: 0, center: { x: 0.5, y: 0.5 },
  zoomBadge: null, zoomTimeout: null,
};
let fullscreenLoadToken = 0;
let fullscreenDrag = null;
// Direction of the last move (1 forward, -1 back). The photos ahead in that direction are the ones decoded in advance.
let fullscreenDirection = 1;
// Settings > Storage > Thumbnail cache: while the full-resolution photo decodes, show its cached thumbnail (off by default).
let fullscreenThumbnailPreload = readBool('fullscreenThumbnailPreload');
let fullscreenInfoVisible = readBool('fullscreenInfoVisible');

// Option "Use thumbnails as fast fullscreen preload": if the sharp image is not shown after this delay (it was not decoded in advance), the
// cached thumbnail takes its place so that the change of photo looks immediate.
const FULLSCREEN_THUMBNAIL_DELAY_MS = 40;

// A 40 MP JPEG weighs about 170 MB once decoded, and the decoded images are kept in a limited cache: only a few photos are decoded in advance,
// one at a time, and a photo that is no longer wanted when its turn comes is skipped.
const FULLSCREEN_DECODE_AHEAD = 2;
const FULLSCREEN_DECODE_BEHIND = 1;
let fullscreenDecodeWanted = new Set();
const fullscreenDecodeQueue = [];
let fullscreenDecodeRunning = false;

let fullscreenView = null;
let fullscreenImg = null;
let fullscreenRating = null;
let fullscreenInfo = null;
let fullscreenInfoName = null;
let fullscreenInfoRank = null;
let fullscreenInfoExifLines = [];
let fullscreenInfoDate = null;
let fullscreenInfoTitle = null;
let fullscreenInfoDescription = null;
let fullscreenColorButton = null;
let fullscreenColorPopover = null;
let fullscreenPickButton = null;
let fullscreenPickPopover = null;
let fullscreenMarking = null;
let fullscreenMarkingStars = null;
let fullscreenMarkingColor = null;
let fullscreenMarkingPick = null;

export const isFullscreenOpen = () => isFullscreen;
export const getFullscreenSlot = () => fullscreenSlot;
export function clearFullscreenImageCache() {
  fullscreenImageCache.clear();
}
export function setFullscreenDirection(dir) {
  fullscreenDirection = dir;
}

// Video: launched directly in the OS default player, never in the internal viewer.
export async function openVideoExternally(photo) {
  try {
    await invoke('open_video_externally', { path: photo.path });
  } catch (error) {
    host.showToast(t('Open failed: {error}', { error: String(error) }));
  }
}

export function openFullscreen(index) {
  // Single entry point for fullscreen (double-click, keyboard): a video goes to the external player, selection stays unchanged.
  const photos = host.getPhotos();
  const target = photos[index];
  if (target && isVideoPath(target.path)) {
    openVideoExternally(target);
    return;
  }
  host.setLastSelectedIndex(index);
  const selectedIndices = host.getSelectedIndices();
  selectedIndices.clear();
  selectedIndices.add(index);
  host.updateUIOnSelection();
  // Remove the image from the previous session so it does not flash briefly while the requested photo is prepared.
  if (fullscreenSlot.photo !== target) clearFullscreenImage();
  isFullscreen = true;
  if (target) loadFullscreenPhoto(target);
  fullscreenRatingPinned = false;
  fullscreenRating.classList.add('hidden');
  fullscreenView.classList.remove('hidden');
  // Always start fitted to the window (zoom from a previous session is not kept).
  fullscreenSlot.zoom = null;
  fullscreenSlot.center = { x: 0.5, y: 0.5 };
  layoutFullscreenSlot();
  preloadFullscreenImages(index);
  updateFullscreenInfo();
  syncHistogram();
}

export function closeFullscreen() {
  stopSlideshow({ silent: true }); // Escape, F or double-click: leaving fullscreen also stops the slideshow
  isFullscreen = false;
  syncHistogram();
  fullscreenDrag = null;
  fullscreenView.classList.remove('dragging');
  fullscreenView.classList.add('hidden');
  clearTimeout(fullscreenRatingTimeout);
  fullscreenRatingPinned = false;
  closeFullscreenPopovers();
  fullscreenMarking.hidden = true;
  clearTimeout(fullscreenSlot.zoomTimeout);
  fullscreenSlot.zoomBadge?.classList.remove('visible');
  layoutFullscreenFaces(fullscreenSlot); // hide face regions
}

// Positions and zooms the fullscreen image using the same logic as the preview (no-op while hidden).
export function layoutFullscreenSlot() {
  if (!isFullscreen) return;
  layoutPreviewSlot(fullscreenSlot);
  fullscreenView.classList.toggle('zoomed', fullscreenSlot.zoom !== null);
  layoutFullscreenFaces(fullscreenSlot); // face regions aligned to the displayed image
}

// Loads `photo` into fullscreen if it is still the active photo when its display URL resolves.
export function loadFullscreenPhoto(photo) {
  host.getPhotoDisplayUrl(photo).then(url => {
    if (isFullscreen && host.getPhotos()[host.getLastSelectedIndex()] === photo) showFullscreenPhoto(photo, url);
  });
}

// Shows the photo in fullscreen. Zoom and pan reset only when the image changes (e.g. a rating change reloads the same URL).
// The previous image stays on screen until the new one is decoded, then dimensions, zoom and position are applied together.
function showFullscreenPhoto(photo, url) {
  fullscreenSlot.photo = photo;
  if (fullscreenSlot.url === url) {
    updateFullscreenInfo();
    syncHistogram();
    notifySlideshowPhotoShown(photo);
    return;
  }
  fullscreenSlot.url = url;
  const token = ++fullscreenLoadToken;
  let sharpShown = false; // the full-resolution image (or the error) has replaced the previous photo
  const apply = loaded => {
    if (token !== fullscreenLoadToken) return; // another photo was requested meanwhile
    sharpShown = true;
    setSlotImageSize(fullscreenSlot, loaded.naturalWidth, loaded.naturalHeight);
    fullscreenSlot.zoom = null;
    fullscreenSlot.center = { x: 0.5, y: 0.5 };
    updateFullscreenInfo(); // info changes at the same time as the displayed image
    fullscreenImg.src = url;
    layoutFullscreenSlot();
    syncHistogram(); // clipping overlay for the newly displayed image
    notifySlideshowPhotoShown(photo); // slideshow: delay before next photo starts from display time
  };
  // The element that preloadFullscreenImages already started loading and decoding is reused; otherwise a new one is started here.
  const photos = host.getPhotos();
  const lastSelectedIndex = host.getLastSelectedIndex();
  const index = photos[lastSelectedIndex] === photo ? lastSelectedIndex : -1;
  const preloaded = index >= 0 ? fullscreenImageCache.get(index) : null;
  const probe = preloaded?._displayUrl === url ? preloaded : new Image();
  const onUnreadable = () => {
    if (token !== fullscreenLoadToken) return;
    sharpShown = true;
    updateFullscreenInfo();
    // Unreadable image: assigning `src` triggers the error listener which checks for a missing file.
    fullscreenSlot.naturalWidth = 0;
    fullscreenSlot.naturalHeight = 0;
    fullscreenSlot.zoom = null;
    fullscreenImg.src = url;
    notifySlideshowPhotoShown(photo); // unreadable image: slideshow still advances after the delay
  };
  if (probe !== preloaded) {
    probe._displayUrl = url;
    probe.src = url;
  }
  // decode() rather than onload: the (large) image is decoded off the main thread BEFORE it replaces the previous one. Assigning it to the
  // visible <img> straight after the load made the compositor wait for the decode (about 200 ms for 40 MP), which froze the window.
  probe.decode().then(() => apply(probe), onUnreadable);
  if (fullscreenThumbnailPreload) showFullscreenThumbnail(photo, token, () => sharpShown);
}

// The thumbnail is displayed at the size the photo will have, so the sharp image replaces it without any jump: the thumbnail keeps its ratio and
// takes the longest side of the real image (the catalogue size, whatever the orientation), or of the window when the catalogue has none.
// Cached thumbnails are already turned by the backend, hence view_fix 1 (see setSlotImageSize). Nothing is shown when the photo has no
// cached thumbnail; the grid's cache lookup is reused.
function showFullscreenThumbnail(photo, token, isSharpShown) {
  const outdated = () => token !== fullscreenLoadToken || !isFullscreen || isSharpShown();
  setTimeout(async () => {
    if (outdated()) return;
    const cachedPath = await host.lookupCachedThumbnail(photo.path);
    if (!cachedPath || outdated()) return;
    const url = convertFileSrc(cachedPath) + host.versionSuffix(photo.path);
    const thumbnail = new Image();
    thumbnail.src = url;
    try { await thumbnail.decode(); } catch { return; }
    if (outdated() || !(thumbnail.naturalWidth > 0 && thumbnail.naturalHeight > 0)) return;
    const ratio = thumbnail.naturalWidth / thumbnail.naturalHeight;
    const longest = Math.max(photo.width || 0, photo.height || 0) || Math.max(fullscreenView.clientWidth, fullscreenView.clientHeight) * (window.devicePixelRatio || 1);
    setSlotImageSize(fullscreenSlot, Math.round(ratio >= 1 ? longest : longest * ratio), Math.round(ratio >= 1 ? longest / ratio : longest), 1);
    fullscreenSlot.zoom = null;
    fullscreenSlot.center = { x: 0.5, y: 0.5 };
    updateFullscreenInfo(); // the information follows the picture on screen
    fullscreenImg.src = url;
    layoutFullscreenSlot();
  }, FULLSCREEN_THUMBNAIL_DELAY_MS);
}

export function clearFullscreenImage() {
  fullscreenLoadToken++;
  fullscreenSlot.photo = null;
  fullscreenSlot.url = '';
  fullscreenSlot.naturalWidth = 0;
  fullscreenSlot.naturalHeight = 0;
  fullscreenSlot.zoom = null;
  fullscreenImg.src = '';
  updateFullscreenInfo();
  layoutFullscreenSlot();
}

export function showFullscreenRatingForAWhile() {
  fullscreenRating.classList.remove('hidden');
  clearTimeout(fullscreenRatingTimeout);
  if (!fullscreenRatingPinned) {
    fullscreenRatingTimeout = setTimeout(() => {
      if (fullscreenPopoverOpen()) return; // a choice popover is open: keep the bar, restart 3 s countdown on close
      fullscreenRating.classList.add('hidden');
      syncFullscreenMarking();
    }, 3000);
  }
  syncFullscreenMarking();
}

export function toggleFullscreenRatingPinned() {
  fullscreenRatingPinned = !fullscreenRatingPinned;
  clearTimeout(fullscreenRatingTimeout);
  if (fullscreenRatingPinned) fullscreenRating.classList.remove('hidden');
  else fullscreenRating.classList.add('hidden');
  syncFullscreenMarking();
}

export function updateFullscreenRatingStars() {
  const rating = host.getPhotos()[host.getLastSelectedIndex()]?.rating || 0;
  fullscreenRating.querySelectorAll('button[data-rating]').forEach(button => button.classList.toggle('active', Number(button.dataset.rating) <= rating));
  if (isFullscreen) syncFullscreenMarking();
}

// Formats the date taken in words (time is added only when the EXIF date carries one).
function formatFullscreenDate(photo) {
  const key = photoTimeKey(photo);
  if (key === null || key === undefined) return '';
  const text = String(key).padStart(14, '0');
  const language = getLanguage();
  const date = new Date(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
  const day = date.toLocaleDateString(language, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const hasTime = /\d{4}\D?\d{2}\D?\d{2}\D+\d{2}/.test(String(photo.date_taken || ''));
  if (!hasTime) return day;
  const hour = text.slice(8, 10);
  const minute = text.slice(10, 12);
  return `${day}, ${language === 'fr' ? `${Number(hour)}h${minute}` : `${hour}:${minute}`}`;
}

// Manufacturer + model, without repeating the manufacturer when the model already starts with it.
function fullscreenCameraName(photo) {
  const make = (photo.manufacturer || '').trim();
  const model = (photo.camera_model || '').trim();
  if (!model) return make;
  const makeWord = make.split(/\s+/)[0].toLowerCase();
  return make && !model.toLowerCase().startsWith(makeWord) ? `${make} ${model}` : model;
}

export function updateFullscreenInfo() {
  fullscreenView.classList.toggle('show-info', fullscreenInfoVisible);
  fullscreenInfo.classList.toggle('hidden', !fullscreenInfoVisible);
  if (!fullscreenInfoVisible) { syncFullscreenMarking(); return; }
  const photo = fullscreenSlot.photo;
  if (!photo) {
    fullscreenInfoName.textContent = fullscreenInfoRank.textContent = fullscreenInfoDate.textContent = '';
    fullscreenInfoTitle.textContent = fullscreenInfoDescription.textContent = '';
    fullscreenInfoTitle.hidden = fullscreenInfoDescription.hidden = true;
    fullscreenInfoExifLines.forEach(line => { line.textContent = ''; line.hidden = true; });
    syncFullscreenMarking();
    return;
  }
  const photos = host.getPhotos();
  const lastSelectedIndex = host.getLastSelectedIndex();
  fullscreenInfoName.textContent = photo.filename || photo.path.split(/[\\/]/).pop() || '';
  const index = photos[lastSelectedIndex] === photo ? lastSelectedIndex : photos.indexOf(photo);
  fullscreenInfoRank.textContent = index >= 0 ? `${index + 1}/${photos.length}` : '';
  // The slideshow icon sits right before the rank: its offset follows the rank's width (see .slideshow-indicator in styles.css).
  const rankWidth = fullscreenInfoRank.offsetWidth;
  if (rankWidth > 0) fullscreenView.style.setProperty('--fullscreen-rank-width', `${rankWidth}px`);
  fullscreenInfoDate.textContent = formatFullscreenDate(photo);
  // Title (one line, bold) and description (three lines at most) above the date, only when the metadata holds them.
  const title = (photo.title || '').trim();
  const description = (photo.caption || '').trim();
  fullscreenInfoTitle.textContent = title;
  fullscreenInfoTitle.hidden = !title;
  fullscreenInfoDescription.textContent = description;
  fullscreenInfoDescription.hidden = !description;
  const lines = [
    [fullscreenCameraName(photo), (photo.lens_model || '').trim()],
    [photo.focal_length, photo.shutter_speed ? host.formatShutterSpeed(photo.shutter_speed) : '', photo.iso ? `ISO ${photo.iso}` : ''],
  ].map(parts => parts.filter(Boolean).join(' · '));
  fullscreenInfoExifLines.forEach((line, i) => { line.textContent = lines[i] || ''; line.hidden = !lines[i]; });
  syncFullscreenMarking();
}

function fullscreenPopoverOpen() {
  return !fullscreenColorPopover.hidden || !fullscreenPickPopover.hidden;
}

function closeFullscreenPopovers() {
  fullscreenColorPopover.hidden = fullscreenPickPopover.hidden = true;
  fullscreenColorButton.setAttribute('aria-expanded', 'false');
  fullscreenPickButton.setAttribute('aria-expanded', 'false');
}

// Opens `popover` (closing the other one); the 3 s countdown of the row is suspended while a popover is open.
function toggleFullscreenPopover(button, popover) {
  const open = popover.hidden;
  closeFullscreenPopovers();
  popover.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  clearTimeout(fullscreenRatingTimeout);
  if (!open) showFullscreenRatingForAWhile();
}

// Brings the dot, the flag, the summary and its visibility in line with the current photo.
export function syncFullscreenMarking() {
  const photo = host.getPhotos()[host.getLastSelectedIndex()];
  const rating = photo?.rating || 0;
  const colorFlag = photo?.color_flag || 'none';
  const pickFlag = photo?.pick_flag || 'none';
  const rowShown = !fullscreenRating.classList.contains('hidden');
  if (!rowShown) closeFullscreenPopovers();
  fullscreenColorButton.className = `fullscreen-color-dot flag-${colorFlag}`;
  fullscreenPickButton.className = `fullscreen-pick-flag pick-${pickFlag}`;
  fullscreenMarkingStars.firstElementChild.textContent = '★'.repeat(rating); // filled stars; the empty ones are the same glyph, faded (CSS)
  fullscreenMarkingStars.lastElementChild.textContent = '★'.repeat(5 - rating);
  fullscreenView.classList.toggle('rating-shown', rowShown); // the title and description make room for the row (CSS)
  fullscreenMarkingColor.className = `fullscreen-color-dot fullscreen-color-item flag-${colorFlag}`;
  fullscreenMarkingPick.className = `fullscreen-pick-flag fullscreen-pick-item pick-${pickFlag}`;
  fullscreenMarking.hidden = !(isFullscreen && fullscreenInfoVisible && !rowShown && photo);
}

export function toggleFullscreenInfo() {
  fullscreenInfoVisible = !fullscreenInfoVisible;
  try { localStorage.setItem('fullscreenInfoVisible', String(fullscreenInfoVisible)); } catch { /* not persisted */ }
  updateFullscreenInfo();
}

export function preloadFullscreenImages(index) {
  const photos = host.getPhotos();
  const keep = new Set();
  const wanted = [];
  for (let i = Math.max(0, index - 2); i <= Math.min(photos.length - 1, index + 2); i++) wanted.push(i);
  // Slideshow: the next photo is not necessarily adjacent (random order), so preload it too.
  const nextSlideshowIndex = isSlideshowActive() ? photos.indexOf(peekNextSlideshowPhoto()) : -1;
  if (nextSlideshowIndex >= 0) wanted.push(nextSlideshowIndex);
  for (const i of wanted) {
    keep.add(i);
    if (!fullscreenImageCache.has(i)) {
      const image = new Image();
      fullscreenImageCache.set(i, image);
      const photoPath = photos[i].path;
      const photo = photos[i];
      image.onerror = () => host.checkPhotoMissing(photoPath);
      host.getPhotoDisplayUrl(photo).then(url => {
        if (url && fullscreenImageCache.get(i) === image) {
          image._displayUrl = url;
          image.src = url;
          queueFullscreenDecode(image);
        }
      });
    }
  }
  for (const cachedIndex of fullscreenImageCache.keys()) if (!keep.has(cachedIndex)) fullscreenImageCache.delete(cachedIndex);
  // Loading is not enough: Chromium decodes lazily, when the image is first painted. The photos in the direction of travel are decoded now.
  const offsets = [];
  for (let step = 1; step <= FULLSCREEN_DECODE_AHEAD; step++) offsets.push(step * fullscreenDirection);
  for (let step = 1; step <= FULLSCREEN_DECODE_BEHIND; step++) offsets.push(-step * fullscreenDirection);
  fullscreenDecodeWanted = new Set(offsets.map(offset => fullscreenImageCache.get(index + offset)).filter(Boolean));
  fullscreenDecodeWanted.forEach(queueFullscreenDecode);
}

function queueFullscreenDecode(image) {
  if (!image._displayUrl || image._decodeQueued || !fullscreenDecodeWanted.has(image)) return;
  image._decodeQueued = true;
  fullscreenDecodeQueue.push(image);
  pumpFullscreenDecodes();
}

async function pumpFullscreenDecodes() {
  if (fullscreenDecodeRunning) return;
  fullscreenDecodeRunning = true;
  try {
    let image;
    while ((image = fullscreenDecodeQueue.shift())) {
      if (!fullscreenDecodeWanted.has(image)) { image._decodeQueued = false; continue; } // may be wanted again later
      try { await image.decode(); } catch { /* unreadable image: the error handler of the element reports a missing file */ }
    }
  } finally {
    fullscreenDecodeRunning = false;
  }
}

// ==========================================
// INITIALIZATION
// ==========================================

// Wires fullscreen viewer DOM references, wheel/drag/resize listeners, marking bar & popovers, and the thumbnail-preload setting.
export function initFullscreen(deps) {
  if (initialized) return;
  host = deps;
  initialized = true;

  fullscreenView = document.getElementById('fullscreen-view');
  fullscreenImg = document.getElementById('fullscreen-image');
  fullscreenSlot.cell = fullscreenView;
  fullscreenSlot.img = fullscreenImg;
  fullscreenSlot.clip = document.getElementById('fullscreen-clipping');
  fullscreenSlot.zoomBadge = document.getElementById('fullscreen-zoom-badge');

  fullscreenRating = document.getElementById('fullscreen-rating');
  fullscreenInfo = document.getElementById('fullscreen-info');
  fullscreenInfoName = document.getElementById('fullscreen-info-name');
  fullscreenInfoRank = document.getElementById('fullscreen-info-rank');
  fullscreenInfoExifLines = [...document.querySelectorAll('#fullscreen-info-exif > div')];
  fullscreenInfoDate = document.getElementById('fullscreen-info-date');
  fullscreenInfoTitle = document.getElementById('fullscreen-info-title');
  fullscreenInfoDescription = document.getElementById('fullscreen-info-description');
  fullscreenColorButton = document.getElementById('fullscreen-color-button');
  fullscreenColorPopover = document.getElementById('fullscreen-color-popover');
  fullscreenPickButton = document.getElementById('fullscreen-pick-button');
  fullscreenPickPopover = document.getElementById('fullscreen-pick-popover');
  fullscreenMarking = document.getElementById('fullscreen-marking');
  fullscreenMarkingStars = document.getElementById('fullscreen-marking-stars');
  fullscreenMarkingColor = document.getElementById('fullscreen-marking-color');
  fullscreenMarkingPick = document.getElementById('fullscreen-marking-pick');

  // Wheel navigation in fullscreen; with Ctrl, wheel zooms around the cursor (as in the preview) instead of changing photo.
  fullscreenView.addEventListener('wheel', event => {
    event.preventDefault();
    if (event.ctrlKey) {
      const steps = wheelZoomSteps(event);
      if (steps) zoomPreviewSteps(-steps, previewAnchorAt(fullscreenSlot, event.clientX, event.clientY), fullscreenSlot);
      return;
    }
    const lastSelectedIndex = host.getLastSelectedIndex();
    if (event.deltaY > 0) host.navigateToPhotoIndex(lastSelectedIndex + 1);
    else host.navigateToPhotoIndex(lastSelectedIndex - 1);
  }, { passive: false });

  // Double-click to exit fullscreen.
  fullscreenView.addEventListener('dblclick', closeFullscreen);

  // Zoomed fullscreen: pan the image by dragging with the mouse (zoom is controlled by + / - / * or Ctrl + wheel).
  fullscreenView.addEventListener('pointerdown', event => {
    if (event.button !== 0 || fullscreenSlot.zoom === null) return;
    if (event.target instanceof Element && event.target.closest('#fullscreen-rating')) return;
    fullscreenDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    fullscreenView.setPointerCapture(event.pointerId);
    fullscreenView.classList.add('dragging');
  });
  fullscreenView.addEventListener('pointermove', event => {
    if (!fullscreenDrag || event.pointerId !== fullscreenDrag.pointerId) return;
    const dx = event.clientX - fullscreenDrag.x;
    const dy = event.clientY - fullscreenDrag.y;
    fullscreenDrag.x = event.clientX;
    fullscreenDrag.y = event.clientY;
    const slot = fullscreenSlot;
    if (slot.zoom === null || !(slot.displayWidth > 0 && slot.displayHeight > 0)) return;
    slot.center = clampPreviewCenter(slot, slot.center.x - dx / slot.displayWidth, slot.center.y - dy / slot.displayHeight);
    layoutFullscreenSlot();
    showZoomIndicator(fullscreenSlot);
  });
  const endFullscreenDrag = event => {
    if (!fullscreenDrag || event.pointerId !== fullscreenDrag.pointerId) return;
    fullscreenDrag = null;
    fullscreenView.classList.remove('dragging');
  };
  fullscreenView.addEventListener('pointerup', endFullscreenDrag);
  fullscreenView.addEventListener('pointercancel', endFullscreenDrag);

  // Window resize during fullscreen: recompute fit and pan centre.
  new ResizeObserver(() => layoutFullscreenSlot()).observe(fullscreenView);

  // Image fails to load (file deleted outside the app): check on disk and remove from catalogue if needed.
  fullscreenImg.addEventListener('error', () => {
    const path = host.getPhotos()[host.getLastSelectedIndex()]?.path;
    if (path && fullscreenImg.getAttribute('src')) host.checkPhotoMissing(path);
  });

  fullscreenRating.addEventListener('click', event => event.stopPropagation());
  fullscreenRating.querySelectorAll('button[data-rating]').forEach(button => {
    button.addEventListener('click', () => host.setSelectionRating(Number(button.dataset.rating)));
  });

  // Full screen (Settings > Storage > Thumbnail cache): show the cached thumbnail while the sharp photo decodes. Off by default.
  const fullscreenThumbnailPreloadToggle = document.getElementById('fullscreen-thumbnail-preload-toggle');
  if (fullscreenThumbnailPreloadToggle) {
    fullscreenThumbnailPreloadToggle.checked = fullscreenThumbnailPreload;
    fullscreenThumbnailPreloadToggle.addEventListener('change', () => {
      fullscreenThumbnailPreload = fullscreenThumbnailPreloadToggle.checked;
      localStorage.setItem('fullscreenThumbnailPreload', String(fullscreenThumbnailPreload));
    });
  }

  // Fullscreen row (R): the same choices as the marking bar, in popovers opening downwards (see syncFullscreenMarking).
  fullscreenColorPopover.append(host.createMarkingColors());
  fullscreenPickPopover.append(host.createMarkingPick());
  fullscreenColorButton.addEventListener('click', () => toggleFullscreenPopover(fullscreenColorButton, fullscreenColorPopover));
  fullscreenPickButton.addEventListener('click', () => toggleFullscreenPopover(fullscreenPickButton, fullscreenPickPopover));
  for (const popover of [fullscreenColorPopover, fullscreenPickPopover]) {
    popover.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('.color-square, .pick-square')) {
        closeFullscreenPopovers();
        showFullscreenRatingForAWhile();
      }
    });
  }
  document.addEventListener('pointerdown', event => {
    if (fullscreenPopoverOpen() && !(event.target instanceof Element && event.target.closest('.fullscreen-popover-wrap'))) {
      closeFullscreenPopovers();
      showFullscreenRatingForAWhile();
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !fullscreenPopoverOpen()) return;
    closeFullscreenPopovers();
    showFullscreenRatingForAWhile();
    event.stopImmediatePropagation(); // Escape closes the popover only, not the fullscreen view
  }, true);
}
