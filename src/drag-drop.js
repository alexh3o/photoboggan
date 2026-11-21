// Grid drag-scroll (with exponential inertia and click suppression) and photo drag-and-drop from the thumbnail grid
// onto the folder tree (including sticky pinned rows), manual albums, and the map, plus the queued folder move/copy
// drop actions. `main.js` wires host state and callbacks via `initDragDrop()`.
import { t, tp } from './i18n.js';
import { openContextMenuAt, askCopyResolutions, sidecarRenameNotice } from './photo-actions.js';
import { isWriteLocked, failureDetailsAction } from './metadata-writes.js';
import { getSelectedAlbum, addPhotosToAlbum, movePhotosToAlbum } from './albums-panel.js';
import { dragOverMap, dragLeaveMap, dropOnMap } from './map-mode.js';

let host = {};
let initialized = false;
let gridContainer = null;

// ==========================================
// GRID DRAG-SCROLL
// ==========================================
const GRID_DRAG_THRESHOLD = 5; // pixels before treating pointer motion as a drag rather than a click
let gridDrag = null;
let photoDrag = null; // photo drag-and-drop onto the folder tree, manual albums or map (see below)
let suppressGridClick = false;

// Inertia: when a fast drag is released, scrolling continues and slows smoothly (exponential decay, independent
// of display refresh rate). Total distance covered equals initial velocity * GRID_INERTIA_TIME_CONSTANT_MS.
const GRID_INERTIA_TIME_CONSTANT_MS = 325; // higher value keeps scrolling longer and further
const GRID_INERTIA_VELOCITY_WINDOW_MS = 100; // sampling window just before release
const GRID_INERTIA_MAX_IDLE_MS = 60; // pointer idle longer than this before release: no inertia
const GRID_INERTIA_MIN_VELOCITY = 0.1; // px/ms required to start inertia
const GRID_INERTIA_STOP_VELOCITY = 0.02; // px/ms below which inertia stops
const GRID_INERTIA_MAX_VELOCITY = 6; // px/ms
let gridInertia = null; // { frame, velocity, position, lastTime } while inertia is running

// Stops active inertia; returns true when the grid was still coasting.
function stopGridInertia() {
  if (!gridInertia) return false;
  cancelAnimationFrame(gridInertia.frame);
  gridInertia = null;
  return true;
}

function startGridInertia(velocity) {
  stopGridInertia();
  const state = { frame: 0, velocity, position: gridContainer.scrollTop, lastTime: performance.now() };
  gridInertia = state;
  const step = now => {
    if (gridInertia !== state) return;
    // scrollTop changed externally (scrollbar, filter or sort change, etc.): drop inertia.
    if (Math.abs(gridContainer.scrollTop - state.position) > 2) { stopGridInertia(); return; }
    const elapsed = Math.min(50, Math.max(0, now - state.lastTime));
    state.lastTime = now;
    const decay = Math.exp(-elapsed / GRID_INERTIA_TIME_CONSTANT_MS);
    state.position += state.velocity * GRID_INERTIA_TIME_CONSTANT_MS * (1 - decay);
    state.velocity *= decay;
    const maxScroll = Math.max(0, gridContainer.scrollHeight - gridContainer.clientHeight);
    const clamped = Math.max(0, Math.min(maxScroll, state.position));
    gridContainer.scrollTop = clamped;
    // Reached top/bottom of the grid, or velocity became negligible: end inertia.
    if (clamped !== state.position || Math.abs(state.velocity) < GRID_INERTIA_STOP_VELOCITY) { stopGridInertia(); return; }
    state.frame = requestAnimationFrame(step);
  };
  state.frame = requestAnimationFrame(step);
}

// Velocity measured across the last samples of the drag (pointer idle before release = no inertia).
function releaseGridInertia(samples, releaseTime) {
  const last = samples[samples.length - 1];
  if (!last || releaseTime - last.time > GRID_INERTIA_MAX_IDLE_MS) return;
  const first = samples[0];
  const duration = last.time - first.time;
  if (duration < 8) return; // too few samples to estimate a reliable velocity
  const velocity = Math.max(-GRID_INERTIA_MAX_VELOCITY, Math.min(GRID_INERTIA_MAX_VELOCITY, -(last.y - first.y) / duration));
  if (Math.abs(velocity) < GRID_INERTIA_MIN_VELOCITY) return;
  startGridInertia(velocity);
}

function endGridDrag(event) {
  if (!gridDrag || event.pointerId !== gridDrag.pointerId) return;
  const { active, stoppedInertia, samples } = gridDrag;
  if (active || stoppedInertia) {
    // The click following a drag (or stopping active inertia) must not alter selection.
    suppressGridClick = true;
    setTimeout(() => { suppressGridClick = false; }, 0);
  }
  if (active) {
    gridContainer.classList.remove('dragging-scroll');
    if (event.type === 'pointerup') releaseGridInertia(samples, event.timeStamp); // no inertia on cancelled drag
  }
  gridDrag = null;
}

// ==========================================
// PHOTO DRAG-AND-DROP (FOLDER TREE, ALBUMS, MAP)
// ==========================================
// Shift + drag a thumbnail onto a folder row in the tree to move the selected photos (files moved on disk).
// With Ctrl instead of Shift, files are copied (a green "+" badge appears on the ghost). If the grabbed thumbnail
// is not selected, only that photo is dragged. Esc cancels. A plain Shift+click or Ctrl+click without dragging
// keeps its normal selection behavior (range selection, add/remove from selection).
const PHOTO_DRAG_THRESHOLD = 6; // pixels before treating pointer motion as a drag rather than a click

// Descendant selector (not `>`) so sticky pinned folder rows inside `li.folder-tree-sticky` also act as drop targets.
function folderItemAt(x, y) {
  const element = document.elementFromPoint(x, y);
  return element instanceof Element ? element.closest('#folder-tree .folder-tree-item[data-folder-path]') : null;
}

// Drag mode from the modifier keys held RIGHT NOW (Shift: move, Ctrl: copy; Shift wins), null if none.
// Keys can change mid-drag: the mode and ghost badge follow immediately.
const dragModeFrom = modifiers => (modifiers.shiftKey ? 'move' : modifiers.ctrlKey ? 'copy' : null);

// Action when dropping onto a manual album: 'copy' (add), 'move' (add to target then remove from source album),
// null (ask Copy / Move / Cancel), or 'none' (source album itself: no-op).
// Photos dragged from a disk folder are never moved into an album: always added, regardless of held modifiers.
// Photos dragged from another manual album follow modifier keys like folder drops: Shift moves, Ctrl copies, none asks.
function albumDropAction(drag) {
  if (drag.sourceAlbumId && drag.overAlbumId === drag.sourceAlbumId) return 'none';
  return drag.sourceAlbumId ? drag.mode : 'copy';
}

// Badge on the floating ghost: green "+" for copy, blue left arrow for move, none when drop will ask what to do.
// Over the map, regardless of held modifiers: a red pin, meaning the photos will be geolocated there.
function paintPhotoDragBadge(drag) {
  if (!drag.ghost) return;
  // No badge when the target refuses drops (smart album, virtual folder) or has no effect (source album).
  const action = drag.refusal ? 'none' : drag.overAlbum ? albumDropAction(drag) : drag.mode;
  drag.ghost.classList.toggle('pin', drag.overMap);
  drag.ghost.classList.toggle('copy', !drag.overMap && action === 'copy');
  drag.ghost.classList.toggle('move', !drag.overMap && action === 'move');
  // Refused target (smart album, virtual folder): display the reason below the ghost thumbnail.
  const reason = drag.overMap ? null : drag.refusal;
  if (drag.reason) { drag.reason.hidden = !reason; drag.reason.textContent = reason ? t(reason) : ''; }
}

// Recomputes what the drag targets from current modifier keys and cursor position: mode, hovered album or map,
// badge, and map drop reticle. Called on every pointermove and whenever Shift / Ctrl is pressed or released.
function updatePhotoDragState(drag, x, y, modifiers) {
  drag.mode = dragModeFrom(modifiers);
  drag.lastX = x;
  drag.lastY = y;
  const albumItem = albumItemAt(x, y);
  drag.overAlbum = Boolean(albumItem);
  drag.overAlbumId = albumItem ? Number(albumItem.dataset.albumId) : 0;
  // A non-manual album (smart album, virtual folder) cannot receive photos: explain why instead of ignoring silently.
  drag.refusal = !albumItem && albumNodeAt(x, y) ? 'Photos can only be added to a manual album' : null;
  // Over the map (with or without Shift / Ctrl): crosshair reticle, target coordinates, and ghost offset out of the way.
  drag.overMap = dragOverMap(x, y);
  document.body.classList.toggle('over-map', drag.overMap);
  paintPhotoDragBadge(drag);
  const ghostOffset = drag.overMap ? 30 : 12;
  drag.ghost.style.transform = `translate(${x + ghostOffset}px, ${y + ghostOffset}px)`;
}

// Photos dropped without Shift or Ctrl onto a disk folder or manual album: show Copy / Move / Cancel at the drop point.
function askCopyOrMove(event, targets, onCopy, onMove) {
  const header = targets.length === 1 ? (targets[0].filename || targets[0].path.split(/[\\/]/).pop()) : tp('{count} photo selected', targets.length);
  openContextMenuAt(event, [
    { header },
    { separator: true },
    { label: t('Copy'), onSelect: onCopy },
    { label: t('Move'), onSelect: onMove },
    { label: t('Cancel'), onSelect: () => {} },
  ]);
}

// Manual album row in the Albums section under the cursor (valid photo drop target).
function albumItemAt(x, y) {
  const element = document.elementFromPoint(x, y);
  return element instanceof Element ? element.closest('#albums-list .album-item.album-manual') : null;
}

// Any row in the Albums section under the cursor (used to show refusal feedback on smart albums / virtual folders).
function albumNodeAt(x, y) {
  const element = document.elementFromPoint(x, y);
  return element instanceof Element ? element.closest('#albums-list .album-item') : null;
}

// First movement past the drag threshold: locks in the dragged photos and creates the cursor-following ghost.
function startPhotoDrag(drag) {
  if (!host.getSelectedIndices().has(drag.index)) {
    host.selectOnly(drag.index);
  }
  const photos = host.getPhotos();
  drag.targets = [...host.getSelectedIndices()].sort((a, b) => a - b).map(index => photos[index]).filter(Boolean);
  if (!drag.targets.length) return false;
  drag.active = true;
  // Photos displayed from a manual album can be moved from it to another album (see albumDropAction).
  const sourceAlbum = getSelectedAlbum();
  drag.sourceAlbumId = sourceAlbum?.kind === 'manual' ? sourceAlbum.id : 0;
  gridContainer.setPointerCapture(drag.pointerId); // keep receiving pointer events while over the tree, albums, or map
  const ghost = document.createElement('div');
  ghost.className = drag.mode === 'copy' ? 'drag-ghost copy' : 'drag-ghost';
  const source = host.getThumbnailImage(drag.index);
  if (source?.src) {
    const image = document.createElement('img');
    image.src = source.src;
    image.alt = '';
    ghost.append(image);
  }
  const badge = document.createElement('span');
  badge.textContent = String(drag.targets.length);
  ghost.append(badge);
  drag.reason = Object.assign(document.createElement('div'), { className: 'drag-reason', hidden: true });
  ghost.append(drag.reason);
  document.body.append(ghost);
  drag.ghost = ghost;
  document.body.classList.add('dragging-photos');
  return true;
}

function clearPhotoDragVisuals(drag) {
  drag.ghost?.remove();
  drag.ghost = null;
  drag.dropItem?.classList.remove('drop-target');
  drag.dropItem = null;
  drag.refusedItem?.classList.remove('drop-refused');
  drag.refusedItem = null;
  document.body.classList.remove('dragging-photos', 'over-map');
  dragLeaveMap();
}

function endPhotoDrag(event, released) {
  const drag = photoDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  photoDrag = null;
  if (!drag.active) return; // plain Shift+click or Ctrl+click: let the click handler manage selection
  clearPhotoDragVisuals(drag);
  // The click following a drag must not alter selection.
  suppressGridClick = true;
  setTimeout(() => { suppressGridClick = false; }, 0);
  if (!released || drag.cancelled) return;
  drag.mode = dragModeFrom(event); // modifier keys at the moment of release
  if (dropOnMap(event.clientX, event.clientY, drag.targets)) return; // dropped on map: position assigned
  // Dropped on a manual album: no disk files are moved or copied. From a disk folder, photos are added;
  // from another manual album, Shift also removes from the source (move), Ctrl adds only, none asks.
  const albumItem = albumItemAt(event.clientX, event.clientY);
  if (albumItem) {
    drag.overAlbumId = Number(albumItem.dataset.albumId);
    const ids = drag.targets.map(photo => photo.id).filter(id => Number.isFinite(id));
    const copy = () => addPhotosToAlbum(drag.overAlbumId, ids);
    const move = () => movePhotosToAlbum(drag.sourceAlbumId, drag.overAlbumId, ids);
    const action = albumDropAction(drag);
    if (action === 'none') return;
    if (action === 'move') move();
    else if (action === 'copy') copy();
    else askCopyOrMove(event, drag.targets, copy, move);
    return;
  }
  const folderPath = folderItemAt(event.clientX, event.clientY)?.dataset.folderPath;
  if (!folderPath) return;
  if (!drag.mode) { askCopyOrMove(event, drag.targets, () => copyPhotosToFolder(drag.targets, folderPath), () => movePhotosToFolder(drag.targets, folderPath)); return; } // ask when neither Shift nor Ctrl is held on release
  if (drag.mode === 'copy') copyPhotosToFolder(drag.targets, folderPath);
  else movePhotosToFolder(drag.targets, folderPath);
}

// Shift or Ctrl pressed/released mid-drag while the pointer is still: update mode and badge immediately.
function onPhotoDragModifierKey(event) {
  const drag = photoDrag;
  if (!drag?.active || drag.cancelled || (event.key !== 'Shift' && event.key !== 'Control')) return;
  updatePhotoDragState(drag, drag.lastX, drag.lastY, event);
}

// ==========================================
// FOLDER DROP ACTIONS (MOVE AND COPY)
// ==========================================
// Queued move task (progress, cancellable between files; see move_photos). Files already moved stay moved if stopped.
function movePhotosToFolder(targets, folderPath) {
  if (!targets.length) return;
  // Metadata write running or queued: wait until it finishes (it targets the current paths).
  if (isWriteLocked()) { host.showToast(t('Metadata writing in progress…')); return; }
  host.enqueueTask({
    kind: 'move',
    path: null,
    command: 'move_photos',
    args: { paths: targets.map(photo => photo.path), destination: folderPath },
    labelKey: 'Moving files ({count})',
    labelParams: { count: targets.length },
    onResult: async (result, stopped, error) => {
      if (error) {
        host.showToast(t('Move failed: {error}', { error }));
        return;
      }
      if (!result) return; // removed from the queue before it started: nothing was moved
      if (result.failed.length) console.error('Move failures', result.failed);
      if (result.moved.length) await host.applyMovedPhotos(result.moved);
      const parts = [];
      if (result.moved.length) parts.push(tp('{count} file moved', result.moved.length));
      if (result.skipped) parts.push(tp('{count} file already in this folder', result.skipped));
      if (result.failed.length) parts.push(tp('{count} failure', result.failed.length));
      const renamed = sidecarRenameNotice(result);
      if (renamed.text) parts.push(renamed.text);
      // Failures: "Details" lists them all (with the renames and their log); otherwise the renames' "Show log" button.
      const action = failureDetailsAction(t('Some files could not be moved'), result.failed, { notes: [renamed.text], logPath: result.log_path }) ?? renamed.action;
      if (!stopped || renamed.text || result.failed.length) {
        host.showToast(!result.moved.length && !result.skipped && result.failed.length
          ? t('Move failed: {error}', { error: result.failed[0].error })
          : parts.join(' · '), false, action, action ? 12000 : null);
      }
    },
  });
}

async function copyPhotosToFolder(targets, folderPath) {
  if (!targets.length) return;
  const paths = targets.map(photo => photo.path);
  const resolutions = await askCopyResolutions('tracked_copy_conflicts', paths, folderPath); // ask how to resolve existing files at destination
  if (!resolutions) return; // copy cancelled
  host.enqueueTask({
    kind: 'copy',
    path: null,
    command: 'copy_photos_to_tracked_folder',
    args: { paths, destination: folderPath, resolutions },
    labelKey: 'Copying files ({count})',
    labelParams: { count: targets.length },
    onResult: async (result, stopped, error) => {
      if (error) {
        host.showToast(t('Copy failed: {error}', { error }));
        return;
      }
      if (!result) return; // removed from the queue before it started: nothing was copied
      if (result.failed.length) console.error('Copy failures', result.failed);
      if (result.copied) await host.syncAfterCopy();
      const renamed = sidecarRenameNotice(result);
      const action = failureDetailsAction(t('Some files could not be copied'), result.failed, { notes: [renamed.text], logPath: result.log_path }) ?? renamed.action;
      if (!stopped || renamed.text || result.failed.length) {
        host.showToast(!result.copied && result.failed.length
          ? t('Copy failed: {error}', { error: result.failed[0].error })
          : [tp('{count} file copied', result.copied), result.skipped ? tp('{count} file skipped', result.skipped) : '', result.failed.length ? tp('{count} failure', result.failed.length) : '', renamed.text].filter(Boolean).join(' · '),
        false, action, action ? 12000 : null);
      }
    },
  });
}

// ==========================================
// INITIALIZATION
// ==========================================

// Wires grid drag-scroll, click suppression, and Shift/Ctrl photo drag-and-drop listeners.
export function initDragDrop(deps) {
  if (initialized) return;
  host = deps;
  initialized = true;

  gridContainer = document.getElementById('grid-view');

  // Wheel reclaims control from active inertia.
  gridContainer.addEventListener('wheel', stopGridInertia, { passive: true });

  gridContainer.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const stoppedInertia = stopGridInertia(); // clicking a coasting grid stops it
    const bounds = gridContainer.getBoundingClientRect();
    if (event.clientX - bounds.left >= gridContainer.clientWidth) return; // scrollbar click
    // Shift + hold on a thumbnail drags photos to move them; Ctrl + hold copies them (plain drag scrolls the grid).
    const pressedThumbnail = (event.shiftKey || event.ctrlKey) && event.target instanceof Element ? event.target.closest('.thumbnail') : null;
    if (pressedThumbnail) {
      photoDrag = { pointerId: event.pointerId, mode: dragModeFrom(event), overAlbum: false, overMap: false, lastX: 0, lastY: 0, startX: event.clientX, startY: event.clientY, index: Number(pressedThumbnail.dataset.index), active: false, cancelled: false, targets: [], ghost: null, dropItem: null };
      return;
    }
    gridDrag = { pointerId: event.pointerId, startY: event.clientY, startScrollTop: gridContainer.scrollTop, active: false, stoppedInertia, samples: [] };
  });

  gridContainer.addEventListener('pointermove', event => {
    if (!gridDrag || event.pointerId !== gridDrag.pointerId) return;
    const delta = event.clientY - gridDrag.startY;
    if (!gridDrag.active) {
      if (Math.abs(delta) < GRID_DRAG_THRESHOLD) return;
      gridDrag.active = true;
      gridContainer.setPointerCapture(event.pointerId);
      gridContainer.classList.add('dragging-scroll');
    }
    gridContainer.scrollTop = gridDrag.startScrollTop - delta;
    // Keep recent drag samples to estimate release velocity.
    const samples = gridDrag.samples;
    samples.push({ time: event.timeStamp, y: event.clientY });
    while (samples.length > 1 && event.timeStamp - samples[0].time > GRID_INERTIA_VELOCITY_WINDOW_MS) samples.shift();
  });

  // Prevent native HTML drag-and-drop (ghost image, forbidden cursor) from interrupting grid drag-scroll.
  gridContainer.addEventListener('dragstart', event => event.preventDefault());
  gridContainer.addEventListener('pointerup', endGridDrag);
  gridContainer.addEventListener('pointercancel', endGridDrag);
  gridContainer.addEventListener('click', event => {
    if (!suppressGridClick) return;
    suppressGridClick = false;
    event.stopPropagation();
    event.preventDefault();
  }, true);

  gridContainer.addEventListener('pointermove', event => {
    const drag = photoDrag;
    if (!drag || drag.cancelled || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < PHOTO_DRAG_THRESHOLD) return;
      if (!startPhotoDrag(drag)) { photoDrag = null; return; }
    }
    updatePhotoDragState(drag, event.clientX, event.clientY, event);
    const item = folderItemAt(event.clientX, event.clientY) ?? albumItemAt(event.clientX, event.clientY);
    if (item !== drag.dropItem) {
      drag.dropItem?.classList.remove('drop-target');
      item?.classList.add('drop-target');
      drag.dropItem = item;
    }
    const refused = drag.refusal && !drag.overMap ? albumNodeAt(event.clientX, event.clientY) : null;
    if (refused !== drag.refusedItem) {
      drag.refusedItem?.classList.remove('drop-refused');
      refused?.classList.add('drop-refused');
      drag.refusedItem = refused;
    }
  });

  gridContainer.addEventListener('pointerup', event => endPhotoDrag(event, true));
  gridContainer.addEventListener('pointercancel', event => endPhotoDrag(event, false));
  window.addEventListener('keydown', onPhotoDragModifierKey);
  window.addEventListener('keyup', onPhotoDragModifierKey);

  // Escape mid-drag cancels the photo drag (releasing the button afterwards does nothing).
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !photoDrag?.active || photoDrag.cancelled) return;
    event.preventDefault();
    photoDrag.cancelled = true;
    clearPhotoDragVisuals(photoDrag);
  });
}
