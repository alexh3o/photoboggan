// Session undo stacks ("common" for the main/fullscreen view and "faces" for the Faces management view),
// unified toast formatting, photo/video/file item-kind naming, and the Undo history modal (Ctrl+U).
import './undo.css';
import { t, tp, getLanguage, onLanguageChange } from './i18n.js';
import { isVideoPath } from './file-kinds.js';

const MAX_UNDO = 20;
const TOAST_FACE_BREAKDOWN_LIMIT = 3;
const MODAL_FACE_BREAKDOWN_LIMIT = 6;

const stacks = {
  common: { entries: [], busy: false },
  faces: { entries: [], busy: false },
};

let host = null;
let openStack = null; // 'common' | 'faces' | null while #undo-modal is visible
let previousFocus = null;
let initialized = false;

const ICON_SVG = {
  rotate: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>',
  rename: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/></svg>',
  face: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01"/><path d="M15 9h.01"/></svg>',
};

const STATE_BUCKET_KEYS = {
  unknown: 'unknown faces',
  filtered: 'filtered faces',
  ignored: 'ignored faces',
  not_face: 'non-faces',
};

export const baseName = path => String(path || '').split(/[\\/]/).pop() || '';

// Returns 'photo' when all paths are photos (raster or RAW), 'video' when all are videos, and 'file' when mixed or unknown.
export function itemKindForPaths(paths) {
  const valid = (paths ?? []).filter(Boolean);
  if (valid.length === 0) return 'file';
  let hasPhoto = false;
  let hasVideo = false;
  for (const path of valid) {
    if (isVideoPath(path)) hasVideo = true;
    else hasPhoto = true;
    if (hasPhoto && hasVideo) return 'file';
  }
  return hasVideo ? 'video' : 'photo';
}

export function formatItemCount(count, itemKind, filename = null) {
  const key = itemKind === 'photo' ? '{count} photo' : itemKind === 'video' ? '{count} video' : '{count} file';
  const base = tp(key, count);
  return count === 1 && filename ? `${base} (${filename})` : base;
}

// Groups faces by displayed person name/alias, or by their current review state when unnamed, sorted largest group first.
export function buildFaceBreakdown(faceList) {
  const counts = new Map();
  for (const face of faceList ?? []) {
    const name = face?.alias || face?.name || null;
    const state = face?.state || 'unknown';
    const key = name ? `p:${name.toLowerCase()}` : `s:${state}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { name, state, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return (a.name || a.state).localeCompare(b.name || b.state);
  });
}

function formatFaceBreakdown(breakdown, { maxItems = Infinity } = {}) {
  if (!breakdown || breakdown.length === 0) return '';
  const bucketLabel = item => (item.name ? item.name : t(STATE_BUCKET_KEYS[item.state] ?? 'unnamed faces'));
  if (breakdown.length === 1) return bucketLabel(breakdown[0]);
  const shown = breakdown.slice(0, maxItems).map(item => `${bucketLabel(item)} (${item.count})`);
  if (breakdown.length > maxItems) {
    shown.push(t('+{count} more', { count: breakdown.length - maxItems }));
  }
  return shown.join(', ');
}

function pickLabel(value) {
  const flag = host?.pickFlags?.find(candidate => candidate.key === value);
  return flag ? t(flag.label) : value;
}

function colorLabel(value) {
  return host?.colorFlagLabels?.get(value) ?? value;
}

function capitalizeFirst(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function formatFaceAction(meta, { forToast }) {
  const count = meta.count ?? 1;
  const facesLabel = tp('{count} face', count);
  const maxItems = forToast ? TOAST_FACE_BREAKDOWN_LIMIT : MODAL_FACE_BREAKDOWN_LIMIT;
  const sources = formatFaceBreakdown(meta.breakdown, { maxItems });
  const fullSources = formatFaceBreakdown(meta.breakdown);
  const photoSuffix = forToast && meta.photoFilename ? ` · ${meta.photoFilename}` : '';
  let text = '';
  let detail = '';
  let fullDetail = '';

  switch (meta.command) {
    case 'confirm_faces':
      text = sources
        ? t('confirmation of {faces} — {sources}', { faces: facesLabel, sources })
        : t('confirmation of {faces}', { faces: facesLabel });
      if (photoSuffix) text += photoSuffix;
      if (!forToast && meta.photoFilename) detail = meta.photoFilename;
      if (fullSources && fullSources !== sources) fullDetail = fullSources;
      break;
    case 'assign_faces':
      text = meta.targetName
        ? t('named to {name} — {faces}', { name: meta.targetName, faces: facesLabel })
        : t('naming of {faces}', { faces: facesLabel });
      if (photoSuffix) text += photoSuffix;
      if (!forToast) {
        const parts = [];
        if (sources) parts.push(t('from {sources}', { sources }));
        if (meta.photoFilename) parts.push(meta.photoFilename);
        detail = parts.join(' · ');
        if (fullSources) fullDetail = t('from {sources}', { sources: fullSources });
      }
      break;
    case 'set_faces_unknown':
      text = sources
        ? tp('{count} face set as unknown from {sources}', count, { sources })
        : tp('{count} face set as unknown', count);
      if (photoSuffix) text += photoSuffix;
      if (!forToast && meta.photoFilename) detail = meta.photoFilename;
      if (fullSources && fullSources !== sources) fullDetail = fullSources;
      break;
    case 'ignore_faces':
      text = sources
        ? tp('{count} face ignored from {sources}', count, { sources })
        : tp('{count} face ignored', count);
      if (photoSuffix) text += photoSuffix;
      if (!forToast && meta.photoFilename) detail = meta.photoFilename;
      if (fullSources && fullSources !== sources) fullDetail = fullSources;
      break;
    case 'unignore_faces':
      text = tp('{count} face no longer ignored', count);
      if (photoSuffix) text += photoSuffix;
      if (!forToast && meta.photoFilename) detail = meta.photoFilename;
      break;
    case 'mark_faces_not_a_face':
      text = sources
        ? tp('{count} face marked as not a face from {sources}', count, { sources })
        : tp('{count} face marked as not a face', count);
      if (photoSuffix) text += photoSuffix;
      if (!forToast && meta.photoFilename) detail = meta.photoFilename;
      if (fullSources && fullSources !== sources) fullDetail = fullSources;
      break;
    case 'unmark_faces_not_a_face':
      text = tp('{count} face marked as a face', count);
      if (photoSuffix) text += photoSuffix;
      if (!forToast && meta.photoFilename) detail = meta.photoFilename;
      break;
    case 'add_manual_face':
      text = meta.targetName
        ? t('manual face {name} added', { name: meta.targetName })
        : t('manual face added');
      if (forToast && meta.photoFilename) text += ` — ${meta.photoFilename}`;
      if (!forToast && meta.photoFilename) detail = meta.photoFilename;
      break;
    case 'delete_faces':
      text = sources
        ? t('face area deleted ({sources})', { sources })
        : t('face area deleted');
      if (forToast && meta.photoFilename) text += ` — ${meta.photoFilename}`;
      if (!forToast && meta.photoFilename) detail = meta.photoFilename;
      break;
    default:
      text = facesLabel;
      break;
  }

  return { text, detail, fullTitle: fullDetail || (detail || text) };
}

function formatActionDescription(meta, { forToast = false, count = null, paths = null } = {}) {
  if (!meta) return { text: '', detail: '', fullTitle: '' };
  if (meta.kind === 'face') return formatFaceAction(meta, { forToast });

  const itemCount = count ?? meta.count ?? 1;
  const itemKind = paths?.length ? itemKindForPaths(paths) : (meta.itemKind ?? 'file');
  const filename = itemCount === 1 ? (paths?.length === 1 ? baseName(paths[0]) : meta.filename) : null;
  const target = formatItemCount(itemCount, itemKind, filename);

  switch (meta.kind) {
    case 'rating': {
      const text = meta.value > 0
        ? t('rating {value} ★ — {target}', { value: meta.value, target })
        : t('rating removed — {target}', { target });
      return { text, detail: '', fullTitle: text };
    }
    case 'color': {
      const text = meta.value && meta.value !== 'none'
        ? t('color {color} — {target}', { color: colorLabel(meta.value), target })
        : t('color removed — {target}', { target });
      return { text, detail: '', fullTitle: text };
    }
    case 'pick': {
      const text = meta.value && meta.value !== 'none'
        ? t('pick flag {flag} — {target}', { flag: pickLabel(meta.value), target })
        : t('pick flag removed — {target}', { target });
      return { text, detail: '', fullTitle: text };
    }
    case 'rotation': {
      const direction = meta.quarterTurns === 1 ? t('rotation right') : meta.quarterTurns === -1 ? t('rotation left') : '180°';
      const text = t('rotation ({direction}) — {target}', { direction, target });
      return { text, detail: '', fullTitle: text };
    }
    case 'rename': {
      const plainTarget = formatItemCount(itemCount, itemKind);
      if (meta.single || itemCount === 1) {
        if (forToast && meta.sampleFrom && meta.sampleTo) {
          const text = t('renaming of {target} — {from} → {to}', { target: plainTarget, from: meta.sampleFrom, to: meta.sampleTo });
          return { text, detail: '', fullTitle: text };
        }
        const text = t('renaming of {target}', { target: plainTarget });
        const detail = meta.sampleFrom && meta.sampleTo ? `${meta.sampleFrom} → ${meta.sampleTo}` : '';
        return { text, detail, fullTitle: detail || text };
      }
      const text = t('batch renaming of {target}', { target: plainTarget });
      const detail = !forToast && meta.sampleFrom && meta.sampleTo ? t('e.g. {from} → {to}', { from: meta.sampleFrom, to: meta.sampleTo }) : '';
      return { text, detail, fullTitle: detail || text };
    }
    default:
      return { text: target, detail: '', fullTitle: target };
  }
}

export function formatUndoToast(meta, overrides = {}) {
  const { text } = formatActionDescription(meta, { forToast: true, ...overrides });
  return t('Undone: {detail}', { detail: text });
}

export function activeUndoStack() {
  return host?.isFacesViewOpen?.() && !host?.isFullscreen?.() ? 'faces' : 'common';
}

export function pushUndo(stackName, { meta, run, canRun = null }) {
  const stack = stacks[stackName];
  const entry = { meta, run, canRun, timestamp: Date.now() };
  stack.entries.push(entry);
  if (stack.entries.length > MAX_UNDO) stack.entries.shift();
  if (openStack === stackName) renderUndoModal();
  return entry;
}

export function hasUndo(stackName) {
  return stacks[stackName].entries.length > 0;
}

export function clearUndo(stackName) {
  stacks[stackName].entries.length = 0;
  if (openStack === stackName) renderUndoModal();
}

// Drops face-overlay undo entries from the common stack when pending face writes are discarded or erased.
export function dropFaceUndoFromCommon() {
  stacks.common.entries = stacks.common.entries.filter(entry => entry.meta?.kind !== 'face');
  if (openStack === 'common') renderUndoModal();
}

// Undoes `targetEntry` (default: the most recent entry on `stackName`) once. Keeps the entry in the stack if `canRun()` refuses.
export async function runUndo(stackName, targetEntry = null) {
  const stack = stacks[stackName];
  if (stack.busy) return false;
  const index = targetEntry ? stack.entries.lastIndexOf(targetEntry) : stack.entries.length - 1;
  if (index < 0) {
    if (!targetEntry) host?.showToast?.(t('Nothing to undo'));
    return false;
  }
  const entry = stack.entries[index];
  if (entry.canRun && entry.canRun() === false) return false;
  const modal = document.getElementById('undo-modal');
  const keepModalFocus = openStack === stackName && isUndoModalOpen() && modal
    && (modal.contains(document.activeElement) || document.activeElement === document.body);
  stack.entries.splice(index, 1);
  stack.busy = true;
  if (openStack === stackName) renderUndoModal();
  try {
    await entry.run();
  } finally {
    stack.busy = false;
    if (openStack === stackName) renderUndoModal();
    if (keepModalFocus && isUndoModalOpen() && !modal.contains(document.activeElement)) {
      const nextFocus = modal.querySelector('.undo-item-btn') ?? document.getElementById('btn-close-undo');
      nextFocus?.focus();
    }
  }
  return true;
}

export function historyToastAction() {
  return { label: t('History'), title: t('Undo history (Ctrl+U)'), link: true, onClick: () => openUndoModal() };
}

export function undoToastActions(stackName, entry) {
  return [
    { label: t('Undo'), onClick: () => runUndo(stackName, entry) },
    historyToastAction(),
  ];
}

function buildEntryIcon(meta) {
  const icon = document.createElement('span');
  icon.className = 'undo-item-icon';
  icon.setAttribute('aria-hidden', 'true');
  if (meta?.kind === 'rating') {
    icon.classList.add('stars');
    if (meta.value === 0) icon.classList.add('removed');
    icon.textContent = meta.value > 0 ? '★' : '☆';
  } else if (meta?.kind === 'color') {
    if (meta.value && meta.value !== 'none') {
      const dot = document.createElement('span');
      dot.className = `flag-indicator flag-${meta.value}`;
      icon.append(dot);
    } else {
      const empty = document.createElement('span');
      empty.className = 'undo-color-none';
      icon.append(empty);
    }
  } else if (meta?.kind === 'pick') {
    const glyph = document.createElement('span');
    glyph.className = `undo-pick-glyph pick-${meta.value || 'none'}`;
    glyph.textContent = '⚑';
    icon.append(glyph);
  } else if (meta?.kind === 'rotation') {
    icon.innerHTML = ICON_SVG.rotate;
  } else if (meta?.kind === 'rename') {
    icon.innerHTML = ICON_SVG.rename;
  } else {
    icon.innerHTML = ICON_SVG.face;
  }
  return icon;
}

function formatEntryTime(timestamp) {
  try {
    return new Intl.DateTimeFormat(getLanguage(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleTimeString();
  }
}

export function isUndoModalOpen() {
  const modal = document.getElementById('undo-modal');
  return Boolean(modal && !modal.classList.contains('hidden'));
}

export function openUndoModal() {
  const modal = document.getElementById('undo-modal');
  if (!modal) return;
  if (isUndoModalOpen()) {
    renderUndoModal();
    return;
  }
  const activeModal = document.querySelector('.modal:not(.hidden)');
  if (activeModal && activeModal !== modal) return;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  openStack = activeUndoStack();
  renderUndoModal();
  modal.classList.remove('hidden');
  const firstAction = modal.querySelector('.undo-item-btn') ?? document.getElementById('btn-close-undo');
  firstAction?.focus();
}

export function closeUndoModal() {
  const modal = document.getElementById('undo-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  openStack = null;
  if (previousFocus?.isConnected && !previousFocus.closest('.hidden')) {
    previousFocus.focus();
  }
  previousFocus = null;
}

function renderUndoModal() {
  if (!openStack) return;
  const modal = document.getElementById('undo-modal');
  const heading = document.getElementById('undo-modal-heading');
  const note = document.getElementById('undo-modal-note');
  const list = document.getElementById('undo-list');
  const empty = document.getElementById('undo-empty');
  if (!modal || !heading || !list || !empty) return;

  heading.textContent = t(openStack === 'faces' ? 'Undo history — Faces' : 'Undo history');
  const stack = stacks[openStack];
  const entries = [...stack.entries].reverse();
  if (note) note.hidden = entries.length === 0;
  list.hidden = entries.length === 0;
  empty.hidden = entries.length > 0;

  list.replaceChildren(...entries.map((entry, idx) => {
    const li = document.createElement('li');
    li.className = `undo-item${idx === 0 ? ' latest' : ''}`;
    const { text, detail, fullTitle } = formatActionDescription(entry.meta, { forToast: false });
    if (fullTitle) li.title = fullTitle;

    const content = document.createElement('div');
    content.className = 'undo-item-content';
    const title = document.createElement('span');
    title.className = 'undo-item-title';
    title.textContent = capitalizeFirst(text);
    content.append(title);
    if (detail) {
      const sub = document.createElement('span');
      sub.className = 'undo-item-detail';
      sub.textContent = detail;
      content.append(sub);
    }

    const right = document.createElement('div');
    right.className = 'undo-item-right';
    const time = document.createElement('span');
    time.className = 'undo-item-time';
    time.textContent = formatEntryTime(entry.timestamp);
    right.append(time);

    if (idx === 0) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-primary undo-item-btn';
      button.textContent = t('Undo');
      button.disabled = stack.busy;
      button.addEventListener('click', () => runUndo(openStack, entry));
      right.append(button);
    }

    li.append(buildEntryIcon(entry.meta), content, right);
    return li;
  }));
}

function isTextEntry(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

export function initUndo(hostApi) {
  host = hostApi;
  if (initialized) return;
  initialized = true;

  const modal = document.getElementById('undo-modal');
  document.getElementById('btn-close-undo')?.addEventListener('click', closeUndoModal);
  modal?.addEventListener('click', event => {
    if (event.target === modal) closeUndoModal();
  });

  // Capture phase so Ctrl+U always blocks the browser's View Source shortcut, and Ctrl+Z / Esc inside the modal are handled before background views.
  window.addEventListener('keydown', event => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'u') {
      event.preventDefault();
      if (event.repeat) return;
      if (isUndoModalOpen()) {
        event.stopImmediatePropagation();
        closeUndoModal();
        return;
      }
      if (document.querySelector('.modal:not(.hidden)') || isTextEntry(event.target)) return;
      event.stopImmediatePropagation();
      openUndoModal();
      return;
    }

    if (!isUndoModalOpen()) return;
    const topModal = [...document.querySelectorAll('.modal:not(.hidden)')].at(-1);
    if (topModal !== modal) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeUndoModal();
    } else if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) runUndo(openStack);
    }
  }, true);

  onLanguageChange(() => {
    if (isUndoModalOpen()) renderUndoModal();
  });
}
