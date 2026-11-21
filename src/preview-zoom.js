// Preview panel (zoom, pan, compare mode up to 4 photos, sub-selection) and instant zoom (hold Z),
// plus the shared slot layout and zoom primitives reused by fullscreen. `main.js` wires host callbacks via `initPreviewZoom()`.
import { t } from './i18n.js';
import { orientationMatrix, swapsSides } from './orientation.js';
import { isRawPath, isVideoPath } from './file-kinds.js';

let host = {};
let initialized = false;

let previewStage = null;
let fullscreenView = null;
let mainContent = null;

// ==========================================
// PREVIEW: ZOOM, PAN AND COMPARE MODE
// ==========================================
const MAX_COMPARE = 4;
const PREVIEW_ZOOM_STEP = 1.4; // +40% per step
const PREVIEW_MAX_ZOOM = 2; // 200% of actual resolution (1 image pixel = 2 screen pixels)
const PREVIEW_FIT_MARGIN = 0.95; // fit margin around the whole view, matching the legacy preview
const PREVIEW_CLICK_DRAG_THRESHOLD = 5; // pixels before treating pointer motion as a drag rather than a click
// Lucide "circle-check-big" icon: sub-selection badge in the top-right corner of a preview cell.
const CIRCLE_CHECK_BIG_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check-big"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>';

let compareMode = false;
let previewSlots = [];
let previewSignature = '';
let previewCenter = { x: 0.5, y: 0.5 }; // image point at the viewport centre, in normalized ratios (shared across compared images)
let previewDrag = null;
let previewWheelDelta = 0;
let previewLastWheelStep = 0;
let compareDesync = false; // "Desynchronize" checkbox (compare mode only)
let previewDesynced = false; // effective state: compare mode active AND checkbox checked
let hoveredPreviewSlot = null;
// Compare sub-selection (when comparing several photos): paths in the preview that receive keyboard/sidebar rating, color and delete commands. Empty by default.
const compareSubSelection = new Set();
let suppressPreviewClick = false; // the click following a preview pan does not toggle sub-selection
let previewHiddenBeforeCompare = false; // preview was hidden before compare mode started: hide it again on exit

export const isCompareMode = () => compareMode;
export const getHoveredPreviewSlot = () => hoveredPreviewSlot;
export const getPreviewSlots = () => previewSlots;
export function invalidatePreview() {
  previewSignature = '';
}

export function canAddToSelection(index) {
  const selectedIndices = host.getSelectedIndices();
  return selectedIndices.has(index) || !compareMode || selectedIndices.size < MAX_COMPARE;
}

export function showCompareLimitToast() {
  host.showToast(t('Compare mode: {max} photos maximum', { max: MAX_COMPARE }));
}

function limitSelectionForCompare() {
  const selectedIndices = host.getSelectedIndices();
  if (selectedIndices.size <= MAX_COMPARE) return;
  const kept = new Set();
  const lastSelectedIndex = host.getLastSelectedIndex();
  if (selectedIndices.has(lastSelectedIndex)) kept.add(lastSelectedIndex);
  for (const index of [...selectedIndices].sort((a, b) => a - b)) {
    if (kept.size >= MAX_COMPARE) break;
    kept.add(index);
  }
  host.setSelectedIndices(kept);
  showCompareLimitToast();
}

// Comparing several photos: the preview cells then pick which photos receive commands.
export function isCompareMultiple() {
  return compareMode && host.getSelectedIndices().size > 1;
}

// Photo indices (in `photos`) targeted by keyboard/sidebar rating, color and delete commands.
// Outside compare mode, or with a single photo selected: the whole selection. In multi-photo compare: the sub-selection only (empty by default).
// Context-menu commands do not use this: they always target the right-clicked photo.
export function commandTargetIndices() {
  const selectedIndices = host.getSelectedIndices();
  if (!isCompareMultiple()) return [...selectedIndices];
  const photos = host.getPhotos();
  return [...selectedIndices].filter(index => compareSubSelection.has(photos[index]?.path));
}

export function commandTargetPhotos() {
  const photos = host.getPhotos();
  return commandTargetIndices().map(index => photos[index]).filter(Boolean);
}

// Photo whose rating and color are displayed in the sidebar.
export function commandReferencePhoto() {
  const indices = commandTargetIndices();
  const photos = host.getPhotos();
  const lastSelectedIndex = host.getLastSelectedIndex();
  return photos[indices.includes(lastSelectedIndex) ? lastSelectedIndex : indices[0]];
}

// Drop from sub-selection any photos no longer in the comparison (selection change, deletion, leaving compare mode).
export function pruneCompareSubSelection() {
  if (!isCompareMultiple()) {
    compareSubSelection.clear();
    return;
  }
  const photos = host.getPhotos();
  const comparedPaths = new Set([...host.getSelectedIndices()].map(index => photos[index]?.path));
  for (const path of compareSubSelection) if (!comparedPaths.has(path)) compareSubSelection.delete(path);
}

// Sync the circle-check-big badges on preview cells from the sub-selection set.
function syncPreviewSubSelection() {
  if (!initialized) return;
  previewStage.classList.toggle('sub-selectable', isCompareMultiple());
  for (const slot of previewSlots) slot.cell.classList.toggle('sub-selected', compareSubSelection.has(slot.photo.path));
}

function toggleCompareSubSelection(photo) {
  if (compareSubSelection.has(photo.path)) compareSubSelection.delete(photo.path);
  else compareSubSelection.add(photo.path);
  syncPreviewSubSelection();
  host.onSubSelectionChange();
}

// Position marks (sub-selection check, rating/color meta, and zoom badge) in the corners of the fitted/zoomed image.
function positionPreviewMarks(slot, cellWidth, cellHeight) {
  if (!slot.meta) return; // fullscreen has no preview marks and its zoom badge is CSS-pinned opposite the rank label
  const left = Math.max(0, slot.tx);
  const top = Math.max(0, slot.ty);
  if (slot.zoomBadge) {
    slot.zoomBadge.style.top = `${Math.round(top) + 6}px`;
    slot.zoomBadge.style.left = `${Math.round(left) + 6}px`;
  }
  const right = Math.min(cellWidth, slot.tx + slot.displayWidth);
  const bottom = Math.min(cellHeight, slot.ty + slot.displayHeight);
  slot.check.style.top = `${Math.round(top) + 8}px`;
  slot.check.style.right = `${Math.round(cellWidth - right) + 8}px`;
  slot.meta.style.left = `${Math.round(left)}px`;
  slot.meta.style.right = `${Math.round(cellWidth - right)}px`;
  slot.meta.style.bottom = `${Math.round(cellHeight - bottom)}px`;
}

// Show the zoom percentage badge for 2 seconds, then fade it out.
export function showZoomIndicator(slot) {
  if (!slot || !slot.zoomBadge || !(slot.naturalWidth > 0)) return;
  const scale = slot.zoom ?? slot.fit;
  slot.zoomBadge.textContent = `${Math.round(scale * 100)}%`;
  slot.zoomBadge.classList.add('visible');
  clearTimeout(slot.zoomTimeout);
  slot.zoomTimeout = setTimeout(() => {
    slot.zoomBadge.classList.remove('visible');
  }, 2000);
}

// Key A in multi-photo compare mode: sub-select all compared photos, or clear all if every one is already sub-selected.
export function toggleAllCompareSubSelection() {
  const photos = host.getPhotos();
  const paths = [...host.getSelectedIndices()].map(index => photos[index]?.path).filter(Boolean);
  if (paths.every(path => compareSubSelection.has(path))) compareSubSelection.clear();
  else for (const path of paths) compareSubSelection.add(path);
  syncPreviewSubSelection();
  host.onSubSelectionChange();
}

export function notifyNoCompareTarget() {
  host.showToast(t('Compare mode: first click one or more photos in the preview'));
}

// Scale expressed in physical screen pixels per image pixel (1 = 100%). CSS scale = scale / devicePixelRatio.
function previewCssScale(slot) {
  return (slot.zoom ?? slot.fit) / (window.devicePixelRatio || 1);
}

function previewDisplaySize(slot) {
  const scale = previewCssScale(slot);
  return { width: slot.naturalWidth * scale, height: slot.naturalHeight * scale };
}

export function clampPreviewCenter(slot, x, y) {
  const { width, height } = previewDisplaySize(slot);
  const clampAxis = (value, shown, view) => {
    if (shown <= view) return 0.5;
    const half = view / 2 / shown;
    return Math.min(1 - half, Math.max(half, value));
  };
  return { x: clampAxis(x, width, slot.cell.clientWidth), y: clampAxis(y, height, slot.cell.clientHeight) };
}

// Size of the image of a slot (preview cell, comparison, fullscreen). The element keeps the size the webview gives it (`width` x `height`);
// naturalWidth / naturalHeight are those of the picture as displayed, after the orientation still to apply (`photo.view_fix`, see
// orientationMatrix), which layoutPreviewSlot adds to the transform. The whole layout (fit, zoom, faces) then works on the displayed picture.
// `viewFix` is the photo's by default; a cached thumbnail is already turned, so the fullscreen thumbnail passes 1.
export function setSlotImageSize(slot, width, height, viewFix = slot.photo?.view_fix ?? 1) {
  slot.viewFix = viewFix;
  slot.rawWidth = width;
  slot.rawHeight = height;
  const swapped = swapsSides(slot.viewFix);
  slot.naturalWidth = swapped ? height : width;
  slot.naturalHeight = swapped ? width : height;
  slot.img.style.width = `${width}px`;
  slot.img.style.height = `${height}px`;
}

export function layoutPreviewSlot(slot) {
  if (!(slot.naturalWidth > 0 && slot.naturalHeight > 0)) return;
  const cellWidth = slot.cell.clientWidth;
  const cellHeight = slot.cell.clientHeight;
  if (!cellWidth || !cellHeight) return;
  const dpr = window.devicePixelRatio || 1;
  const fitMargin = slot.fitMargin ?? PREVIEW_FIT_MARGIN; // fullscreen uses the whole viewport (margin 1)
  slot.fit = Math.min(1, (cellWidth * fitMargin * dpr) / slot.naturalWidth, (cellHeight * fitMargin * dpr) / slot.naturalHeight);
  if (slot.zoom !== null) {
    slot.zoom = Math.min(PREVIEW_MAX_ZOOM, Math.max(slot.fit, slot.zoom));
    if (slot.zoom <= slot.fit + 1e-6) slot.zoom = null;
  }
  const { width, height } = previewDisplaySize(slot);
  const currentCenter = previewCenterOf(slot);
  const center = clampPreviewCenter(slot, currentCenter.x, currentCenter.y);
  const snap = value => Math.round(value * dpr) / dpr;
  slot.tx = snap(width <= cellWidth ? (cellWidth - width) / 2 : cellWidth / 2 - center.x * width);
  slot.ty = snap(height <= cellHeight ? (cellHeight - height) / 2 : cellHeight / 2 - center.y * height);
  slot.displayWidth = width;
  slot.displayHeight = height;
  const matrix = orientationMatrix(slot.viewFix, slot.rawWidth, slot.rawHeight);
  slot.img.style.transform = `translate(${slot.tx}px, ${slot.ty}px) scale(${previewCssScale(slot)})${matrix ? ` matrix(${matrix.join(', ')})` : ''}`;
  if (slot.clip) { // clipping overlay (histogram.js): same dimensions and transform as the image
    slot.clip.style.width = slot.img.style.width;
    slot.clip.style.height = slot.img.style.height;
    slot.clip.style.transform = slot.img.style.transform;
  }
  positionPreviewMarks(slot, cellWidth, cellHeight);
  if (slot !== host.getFullscreenSlot()) host.layoutPreviewFaces(slot); // face regions (V key)
}

export function layoutPreviewSlots() {
  previewSlots.forEach(layoutPreviewSlot);
}

function renderPreviewTransforms() {
  layoutPreviewSlots();
  host.layoutFullscreenSlot();
}

function createPreviewSlot(photo) {
  const cell = document.createElement('div');
  cell.className = 'preview-cell';
  cell.dataset.path = photo.path;
  if (isVideoPath(photo.path)) cell.classList.add('is-video');
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  const slot = { photo, cell, img, naturalWidth: 0, naturalHeight: 0, fit: 1, zoom: null, tx: 0, ty: 0, displayWidth: 0, displayHeight: 0, center: { x: 0.5, y: 0.5 } };
  img.addEventListener('load', () => {
    if (!previewSlots.includes(slot)) return;
    if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) return;
    setSlotImageSize(slot, img.naturalWidth, img.naturalHeight);
    cell.classList.add('loaded');
    layoutPreviewSlot(slot);
  });
  img.addEventListener('error', () => host.checkPhotoMissing(photo.path));
  img.addEventListener('error', () => { if (isRawPath(photo.path)) host.markFormatPlaceholder(cell, photo.path); });
  host.getPhotoDisplayUrl(photo).then(url => {
    if (previewSlots.includes(slot) && url) {
      img.src = url;
    }
  });
  const check = document.createElement('span');
  check.className = 'preview-check';
  check.setAttribute('aria-hidden', 'true');
  check.innerHTML = CIRCLE_CHECK_BIG_ICON;
  // Zoom percentage badge
  const zoomBadge = document.createElement('span');
  zoomBadge.className = 'preview-zoom-badge';
  slot.zoomBadge = zoomBadge;
  slot.zoomTimeout = null;
  // Rating (left) and color/pick flags (right) at the bottom of the cell.
  const meta = document.createElement('div');
  meta.className = 'preview-meta';
  slot.ratingLabel = document.createElement('span');
  slot.ratingLabel.className = 'thumbnail-rating';
  slot.flagDot = document.createElement('span');
  slot.flagDot.className = 'flag-indicator flag-none';
  slot.pickMark = document.createElement('span');
  slot.pickMark.className = 'pick-indicator pick-none';
  const flags = document.createElement('span');
  flags.className = 'meta-flags';
  flags.append(slot.pickMark, slot.flagDot);
  meta.append(slot.ratingLabel, flags);
  // Clipping overlay (hidden until histogram.js paints on it).
  const clip = document.createElement('canvas');
  clip.className = 'clipping-overlay';
  clip.hidden = true;
  clip.setAttribute('aria-hidden', 'true');
  slot.clip = clip;
  cell.append(img, clip, check, meta, zoomBadge);
  if (isVideoPath(photo.path)) cell.append(host.createVideoPlayBadge());
  slot.check = check;
  slot.meta = meta;
  return slot;
}

// Normal mode: the active photo. Compare mode: the selection (up to 4), in grid order.
function currentPreviewPhotos() {
  const photos = host.getPhotos();
  const selectedIndices = host.getSelectedIndices();
  if (compareMode) {
    return [...selectedIndices].sort((a, b) => a - b).slice(0, MAX_COMPARE).map(index => photos[index]).filter(Boolean);
  }
  if (selectedIndices.size === 0) return []; // nothing selected (Ctrl+A to deselect all): empty preview
  const photo = photos[host.getLastSelectedIndex()];
  return photo ? [photo] : [];
}

// Stars, color dot and pick mark at the bottom of preview cells, synced from current photo objects.
function syncPreviewMeta() {
  for (const slot of previewSlots) {
    const stars = '★'.repeat(slot.photo.rating || 0);
    if (slot.ratingLabel.textContent !== stars) slot.ratingLabel.textContent = stars;
    const flagClass = `flag-indicator flag-${slot.photo.color_flag || 'none'}`;
    if (slot.flagDot.className !== flagClass) slot.flagDot.className = flagClass;
    const pickClass = `pick-indicator pick-${slot.photo.pick_flag || 'none'}`;
    if (slot.pickMark.className !== pickClass) slot.pickMark.className = pickClass;
  }
}

export function renderPreview() {
  if (!initialized) return;
  pruneCompareSubSelection();
  const list = currentPreviewPhotos();
  const signature = list.map(photo => photo.path).join('|');
  // An emptied preview (signature '') must not reuse old cells: their photos may no longer exist (e.g. moved out of the view).
  if (signature === previewSignature && list.length === previewSlots.length) { // same images: keep zoom and pan
    previewSlots.forEach((slot, index) => { slot.photo = list[index]; }); // objects may be replaced after a library sync
    syncPreviewMeta();
    syncPreviewSubSelection();
    return;
  }
  previewSignature = signature;
  previewCenter = { x: 0.5, y: 0.5 };
  previewDrag = null;
  hoveredPreviewSlot = null;
  previewSlots = list.map(createPreviewSlot);
  previewStage.className = list.length ? `preview-stage count-${list.length}` : 'preview-stage';
  previewStage.replaceChildren(...previewSlots.map(slot => slot.cell));
  renderPreviewTransforms();
  syncPreviewMeta();
  syncPreviewSubSelection();
}

export function previewSlotFromEvent(event) {
  const cell = event.target instanceof Element ? event.target.closest('.preview-cell') : null;
  return cell ? previewSlots.find(slot => slot.cell === cell) || null : null;
}

// Image point under the cursor (as proportions of the image), used as zoom anchor.
export function previewAnchorAt(slot, clientX, clientY) {
  const rect = slot.cell.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const clamp01 = value => Math.min(1, Math.max(0, value));
  return {
    slot, px, py,
    u: slot.displayWidth > 0 ? clamp01((px - slot.tx) / slot.displayWidth) : 0.5,
    v: slot.displayHeight > 0 ? clamp01((py - slot.ty) / slot.displayHeight) : 0.5,
  };
}

// Displayed viewport centre: per-image when desynchronized, otherwise shared.
// Fullscreen always owns its own centre (single image, independent from the preview).
function previewCenterOf(slot) {
  return previewDesynced || slot === host.getFullscreenSlot() ? slot.center : previewCenter;
}

function setPreviewCenter(slot, center) {
  if (previewDesynced || slot === host.getFullscreenSlot()) slot.center = center;
  else previewCenter = center;
}

// When desynchronized, an action targets the hovered image; otherwise it applies to every loaded image.
function previewSlotsToAffect(targetSlot) {
  // Fullscreen open: + / - / * keys (and zoom in general) target only its image.
  if (host.isFullscreen()) {
    const fullscreenSlot = host.getFullscreenSlot();
    return fullscreenSlot.naturalWidth > 0 ? [fullscreenSlot] : [];
  }
  const loaded = previewSlots.filter(slot => slot.naturalWidth > 0);
  return previewDesynced && targetSlot ? loaded.filter(slot => slot === targetSlot) : loaded;
}

// Switch between synchronized and desynchronized compare without moving images on screen.
function updatePreviewSyncMode() {
  const desynced = compareMode && compareDesync;
  if (desynced === previewDesynced) return;
  if (desynced) {
    for (const slot of previewSlots) slot.center = { ...previewCenter };
  } else {
    const reference = previewSlots.find(slot => slot.zoom !== null) || previewSlots[0];
    if (reference) previewCenter = { ...reference.center };
  }
  previewDesynced = desynced;
  renderPreviewTransforms();
}

// `computeTarget(slot, currentScale)` returns the new scale, or null to reset to fit-to-view.
function zoomPreview(computeTarget, anchor, targetSlot = null) {
  const slots = previewSlotsToAffect(targetSlot);
  if (!slots.length) return;
  for (const slot of slots) {
    const target = computeTarget(slot, slot.zoom ?? slot.fit);
    slot.zoom = target === null || target <= slot.fit + 1e-6 ? null : Math.min(PREVIEW_MAX_ZOOM, target);
  }
  if (previewDesynced || host.isFullscreen()) {
    for (const slot of slots) if (slot.zoom === null) slot.center = { x: 0.5, y: 0.5 };
  } else if (slots.every(slot => slot.zoom === null)) {
    previewCenter = { x: 0.5, y: 0.5 };
  }
  if (anchor && anchor.slot.zoom !== null && slots.includes(anchor.slot)) {
    const { width, height } = previewDisplaySize(anchor.slot);
    if (width > 0 && height > 0) {
      setPreviewCenter(anchor.slot, clampPreviewCenter(
        anchor.slot,
        anchor.u + (anchor.slot.cell.clientWidth / 2 - anchor.px) / width,
        anchor.v + (anchor.slot.cell.clientHeight / 2 - anchor.py) / height,
      ));
    }
  }
  renderPreviewTransforms();
  slots.forEach(showZoomIndicator); // Trigger the zoom badge on each affected cell
}

export function zoomPreviewSteps(steps, anchor, targetSlot = null) {
  zoomPreview((slot, current) => current * Math.pow(PREVIEW_ZOOM_STEP, steps), anchor, targetSlot);
}

// Toggle 100% zoom (1 image pixel = 1 screen pixel); if every target is already at 100%, return to fit-to-view.
export function togglePreviewActualSize(anchor, targetSlot = null) {
  const slots = previewSlotsToAffect(targetSlot);
  if (!slots.length) return;
  const atActualSize = slots.every(slot => Math.abs((slot.zoom ?? slot.fit) - 1) < 0.005);
  zoomPreview(() => (atActualSize ? null : 1), anchor, targetSlot);
}

// Number of zoom steps for a wheel event, or 0 if no threshold is reached: a notched wheel yields one step per event
// (with a short debounce), while a touchpad sends small deltas that accumulate. Shared by preview and fullscreen.
export function wheelZoomSteps(event) {
  const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 33 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1);
  if (Math.abs(delta) >= 50) {
    const now = performance.now();
    if (now - previewLastWheelStep < 40) return 0;
    previewLastWheelStep = now;
    previewWheelDelta = 0;
    return Math.sign(delta);
  }
  previewWheelDelta += delta;
  const steps = Math.trunc(previewWheelDelta / 100);
  previewWheelDelta -= steps * 100;
  return steps;
}

function endPreviewDrag(event) {
  if (!previewDrag || event.pointerId !== previewDrag.pointerId) return;
  if (previewDrag.moved) {
    // The click following a drag pan must not toggle sub-selection.
    suppressPreviewClick = true;
    setTimeout(() => { suppressPreviewClick = false; }, 0);
  }
  previewDrag.slot.cell.classList.remove('dragging');
  previewDrag = null;
}

// ==========================================
// INSTANT ZOOM (HOLD Z)
// ==========================================
// Holding Z over an image of the preview (compare mode included) or over the fullscreen photo shows it at 1 image pixel = 1 screen pixel. While the key
// is held, the mouse position chooses the displayed area (the whole image is reachable by moving across the fitted image) and the wheel changes the
// zoom. Releasing Z puts back the zoom level and the centre that were active before. In compare mode every loaded preview follows (same rule as the
// + / - / * keys: only the hovered one when "Desynchronize" is on).
const INSTANT_ZOOM_LEVEL = 1; // 1:1, same value as togglePreviewActualSize
let instantZoom = null; // while Z is held: { target, photoPath, saved, sharedCenter, signature, fullscreen }
let instantZoomPointer = null; // last known pointer position (a key event carries none)
let instantZoomFrame = 0; // pending animation frame of the pan

function isTextEntryFocused() {
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement
    || (active instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'range', 'color', 'file'].includes(active.type))
    || (active instanceof HTMLElement && active.isContentEditable);
}

// Slot under the pointer: the fullscreen photo when fullscreen is open, else the preview cell hovered (null if none).
function instantZoomSlotUnderPointer() {
  if (!instantZoomPointer) return null;
  const element = document.elementFromPoint(instantZoomPointer.x, instantZoomPointer.y);
  if (!(element instanceof Element)) return null;
  if (host.isFullscreen()) {
    const fullscreenSlot = host.getFullscreenSlot();
    return fullscreenView.contains(element) && fullscreenSlot.naturalWidth > 0 ? fullscreenSlot : null;
  }
  const cell = element.closest('.preview-cell');
  const slot = cell ? previewSlots.find(candidate => candidate.cell === cell) : null;
  return slot && slot.naturalWidth > 0 ? slot : null;
}

// The photo shown changed (arrows, new selection, fullscreen closed) while the key was held: there is nothing left to drive or to restore.
function isInstantZoomValid() {
  const isFullscreen = host.isFullscreen();
  if (!instantZoom || instantZoom.fullscreen !== isFullscreen) return false;
  return isFullscreen ? host.getFullscreenSlot().photo?.path === instantZoom.photoPath : previewSlots.includes(instantZoom.target);
}

// Pointer position -> point of the image (proportions). The mapping is absolute over the image fitted in its cell, so that at press time the point
// under the cursor is the one shown at the centre, and moving across the fitted image sweeps the whole picture.
function instantZoomCenterAt(clientX, clientY) {
  const slot = instantZoom.target;
  const rect = slot.cell.getBoundingClientRect();
  const fitScale = slot.fit / (window.devicePixelRatio || 1);
  const fitWidth = slot.naturalWidth * fitScale;
  const fitHeight = slot.naturalHeight * fitScale;
  if (!(fitWidth > 0 && fitHeight > 0)) return null;
  const clamp01 = value => Math.min(1, Math.max(0, value));
  return {
    x: clamp01((clientX - rect.left - (rect.width - fitWidth) / 2) / fitWidth),
    y: clamp01((clientY - rect.top - (rect.height - fitHeight) / 2) / fitHeight),
  };
}

function panInstantZoom() {
  if (!instantZoomPointer || !isInstantZoomValid()) return;
  const center = instantZoomCenterAt(instantZoomPointer.x, instantZoomPointer.y);
  if (!center) return;
  setPreviewCenter(instantZoom.target, clampPreviewCenter(instantZoom.target, center.x, center.y)); // shared centre, or the slot's own one
  renderPreviewTransforms();
}

function startInstantZoom() {
  const target = instantZoomSlotUnderPointer();
  if (!target) return false;
  const slots = previewSlotsToAffect(target);
  if (!slots.length) return false;
  instantZoom = {
    target,
    saved: slots.map(slot => ({ slot, photoPath: slot.photo?.path, zoom: slot.zoom, center: { ...slot.center } })),
    photoPath: target.photo?.path, // the fullscreen slot is reused from photo to photo: identify the photo by its path
    sharedCenter: { ...previewCenter },
    signature: previewSignature,
    fullscreen: host.isFullscreen(),
  };
  zoomPreview(() => INSTANT_ZOOM_LEVEL, null, target);
  panInstantZoom();
  return true;
}

// Puts back the zoom level and centre of before the key was pressed (only for photos still displayed).
function endInstantZoom() {
  if (!instantZoom) return;
  const state = instantZoom;
  const valid = isInstantZoomValid();
  instantZoom = null;
  cancelAnimationFrame(instantZoomFrame);
  instantZoomFrame = 0;
  if (!valid) return;
  const fullscreenSlot = host.getFullscreenSlot();
  for (const { slot, photoPath, zoom, center } of state.saved) {
    if (slot.photo?.path !== photoPath || (slot !== fullscreenSlot && !previewSlots.includes(slot))) continue;
    slot.zoom = zoom;
    slot.center = center;
  }
  if (previewSignature === state.signature) previewCenter = state.sharedCenter;
  renderPreviewTransforms();
  state.saved.forEach(({ slot }) => showZoomIndicator(slot));
}

// ==========================================
// INITIALIZATION
// ==========================================

// Wires preview-stage interactions, compare mode toggles and instant-zoom (hold Z) global listeners.
export function initPreviewZoom(deps) {
  if (initialized) return;
  host = deps;
  initialized = true;

  previewStage = document.getElementById('preview-stage');
  fullscreenView = document.getElementById('fullscreen-view');
  mainContent = document.querySelector('.main-content');
  const compareDesyncToggle = document.getElementById('compare-desync-toggle');
  const compareDesyncOption = document.getElementById('compare-desync');
  const compareToggleBtn = document.getElementById('btn-toggle-compare');
  const previewToggleBtn = document.getElementById('btn-toggle-preview');

  previewStage.addEventListener('wheel', event => {
    const slot = previewSlotFromEvent(event);
    if (!slot) return;
    event.preventDefault();
    const steps = wheelZoomSteps(event);
    if (steps) zoomPreviewSteps(-steps, previewAnchorAt(slot, event.clientX, event.clientY), slot);
  }, { passive: false });

  previewStage.addEventListener('dblclick', event => {
    const slot = previewSlotFromEvent(event);
    if (slot) togglePreviewActualSize(previewAnchorAt(slot, event.clientX, event.clientY), slot);
  });

  previewStage.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const slot = previewSlotFromEvent(event);
    if (!slot) return;
    previewDrag = { slot, pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
    slot.cell.setPointerCapture(event.pointerId);
    slot.cell.classList.add('dragging');
  });

  previewStage.addEventListener('pointermove', event => {
    if (!previewDrag || event.pointerId !== previewDrag.pointerId) return;
    const { slot } = previewDrag;
    if (!previewDrag.moved && Math.hypot(event.clientX - previewDrag.startX, event.clientY - previewDrag.startY) >= PREVIEW_CLICK_DRAG_THRESHOLD) previewDrag.moved = true;
    const dx = event.clientX - previewDrag.x;
    const dy = event.clientY - previewDrag.y;
    previewDrag.x = event.clientX;
    previewDrag.y = event.clientY;
    if (slot.zoom === null || !(slot.displayWidth > 0 && slot.displayHeight > 0)) return;
    const currentCenter = previewCenterOf(slot);
    setPreviewCenter(slot, clampPreviewCenter(slot, currentCenter.x - dx / slot.displayWidth, currentCenter.y - dy / slot.displayHeight));
    renderPreviewTransforms();
    previewSlotsToAffect(slot).forEach(showZoomIndicator); // Trigger the badge while panning
  });

  previewStage.addEventListener('pointerup', endPreviewDrag);
  previewStage.addEventListener('pointercancel', endPreviewDrag);

  // Multi-photo compare: clicking a preview cell adds or removes its photo from the sub-selection.
  // A double-click (1:1 zoom) fires two clicks and therefore leaves the sub-selection unchanged.
  previewStage.addEventListener('click', event => {
    if (suppressPreviewClick) {
      suppressPreviewClick = false;
      return;
    }
    if (!isCompareMultiple()) return;
    const slot = previewSlotFromEvent(event);
    if (slot) toggleCompareSubSelection(slot.photo);
  });

  new ResizeObserver(() => renderPreviewTransforms()).observe(previewStage);

  // Hovered image: target of the + / - / * keys when desynchronized
  previewStage.addEventListener('pointerover', event => {
    const slot = previewSlotFromEvent(event);
    if (slot) hoveredPreviewSlot = slot;
  });
  previewStage.addEventListener('pointerleave', () => { hoveredPreviewSlot = null; });

  compareDesyncToggle.addEventListener('change', event => {
    compareDesync = event.target.checked;
    updatePreviewSyncMode();
    event.target.blur(); // otherwise + / - / * keys would be ignored while the checkbox keeps focus
  });

  compareToggleBtn.addEventListener('click', event => {
    compareMode = !compareMode;
    event.currentTarget.classList.toggle('active', compareMode);
    host.onCompareModeChange(compareMode); // Keywords and Description tabs are unavailable in compare mode
    previewToggleBtn.disabled = compareMode; // the preview stays visible while compare mode is active
    compareDesyncOption.classList.toggle('hidden', !compareMode);
    updatePreviewSyncMode();
    if (compareMode) {
      previewHiddenBeforeCompare = mainContent.classList.contains('preview-hidden');
      if (previewHiddenBeforeCompare) {
        mainContent.classList.remove('preview-hidden');
        previewToggleBtn.classList.add('active');
        requestAnimationFrame(() => host.updateVirtualScroller());
      }
      limitSelectionForCompare();
    } else if (previewHiddenBeforeCompare) {
      previewHiddenBeforeCompare = false;
      mainContent.classList.add('preview-hidden');
      previewToggleBtn.classList.remove('active');
      requestAnimationFrame(() => host.updateVirtualScroller());
    }
    host.updateUIOnSelection();
  });

  // Capture phase: the key must win over the other handlers (e.g. the letter keys of the Faces view) once it has been taken.
  window.addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 'z' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return; // Ctrl+Z stays the undo
    if (instantZoom) { // key repeat while held
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.repeat || document.querySelector('.modal:not(.hidden)')) return;
    if (!host.isFullscreen() && isTextEntryFocused()) return; // typing a "z" in a text field
    if (startInstantZoom()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  window.addEventListener('keyup', event => {
    if (event.key.toLowerCase() === 'z') endInstantZoom();
  }, true);
  window.addEventListener('blur', endInstantZoom); // focus lost while held: no keyup will come
  document.addEventListener('visibilitychange', () => { if (document.hidden) endInstantZoom(); });

  window.addEventListener('pointermove', event => {
    instantZoomPointer = { x: event.clientX, y: event.clientY };
    if (!instantZoom || event.buttons !== 0) return; // a button held: the usual drag panning keeps the hand
    if (!isInstantZoomValid()) { endInstantZoom(); return; }
    if (!instantZoomFrame) {
      instantZoomFrame = requestAnimationFrame(() => { instantZoomFrame = 0; panInstantZoom(); });
    }
  }, { capture: true, passive: true });

  // The wheel zooms instead of changing photo (fullscreen) or zooming around the cursor (preview), and keeps the same limits as the + / - keys.
  window.addEventListener('wheel', event => {
    if (!instantZoom) return;
    if (!isInstantZoomValid()) { endInstantZoom(); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    const steps = wheelZoomSteps(event);
    if (!steps) return;
    zoomPreviewSteps(-steps, null, instantZoom.target);
    panInstantZoom(); // zoomPreview resets the centre when the fitted view comes back
  }, { capture: true, passive: false });
}
