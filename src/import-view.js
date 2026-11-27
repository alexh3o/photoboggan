// Dedicated full-content Import view (import-view.js): completely isolated from main.js `loadedPhotos`.
// Handles source selection, 2-pass scan, RAM-only thumbnails/previews, destination & subfolder rules,
// chronological copy, targeted indexing, and chained post-import tasks.
import './import-view.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { DEFAULTS, readBool, readChoice, readNumber, readStored, writeStored } from './settings-defaults.js';
import { t, tp, labelWithColon, normalizeSearch, onLanguageChange } from './i18n.js';
import { createDateFilterControl, extractTimeKey, parseDateFilter } from './date-filter.js';
import { evaluate, splitFileName } from './batch-rename-engine.js';
import { createFilterSuggest } from './filter-suggest.js';
import { buildMultiColumnComparator, cycleMultiColumnSort, formatSortBadge } from './list-view.js';
import { getDetectedMedia, refreshDetectedMedia, syncImportToolbarButton } from './import-settings.js';
import {
  askImportConflictResolutions,
  confirmDialog,
  createModal,
  openContextMenuAt,
  promptDialog,
  sidecarRenameNotice,
} from './photo-actions.js';
import { refreshFaces } from './faces-panel.js';
import { notifyPhashChanged } from './duplicates-view.js';
import { notifyExactHashChanged, refreshDuplicateHashStats } from './duplicates-settings.js';
import { notifyAnalysisChanged, semanticScanThreads } from './semantic-settings.js';
import {
  cancelTasksByGroup,
  removeWaitingTask,
  triggerTaskPumps,
  updateWaitingTask,
} from './task-queue.js';

const IMPORT_THUMB_MIN = 100;
const IMPORT_THUMB_MAX = 300;
const IMPORT_SUBFOLDER_MODES = ['none', 'custom', 'yyyy_mm_dd', 'yyyy/yyyy_mm_dd', 'yyyy/mm', 'yyyy_mm_dd_custom'];

let host = {};
let openState = false;
let currentSource = null; // { mediaId, label, rootPath, ejectable, lastImportAt, lastImportedFileDt }
let currentExifTaskId = null;
let allFolders = [];
let allFiles = [];
let filesByPath = new Map();
let filteredFiles = [];
let layoutEntries = []; // { type: 'group'|'row'|'card', ... }
let totalLayoutHeight = 0;
let selectedPaths = new Set();
let activePath = null;
let selectedFolderPath = null; // null = root
let activeKinds = new Set(['raw', 'raster', 'video']);
let dateControl = null;
let destInfo = { valid: false, resolvedPath: '', freeBytes: 0, isPrivate: false };

// RAM-only Blob URL LRU cache for SD card thumbnails (never writes disk cache, never holds WebView file locks)
const THUMB_LRU_MAX = 300;
const THUMB_MAX_CONCURRENT = 4;
const thumbUrlCache = new Map(); // path -> objectUrl
const thumbQueue = new Map(); // path -> { file, y }
const thumbActive = new Set(); // path
const renderedNodes = new Map(); // key ('g:idx' | file.path) -> { el, type, ... }
let renderedViewMode = null;
let previewBlobUrl = null;
let previewRequestSeq = 0;
let importPresets = [];
let selectedImportPreset = null;
let importPresetSuggest = null;
let collapsedFolders = new Set();

function revokeAllBlobs() {
  for (const url of thumbUrlCache.values()) URL.revokeObjectURL(url);
  thumbUrlCache.clear();
  thumbQueue.clear();
  thumbActive.clear();
  if (previewBlobUrl) {
    URL.revokeObjectURL(previewBlobUrl);
    previewBlobUrl = null;
  }
}

function clearRenderedViewport() {
  renderedNodes.clear();
  thumbQueue.clear();
  const canvas = document.getElementById('import-files-canvas');
  if (canvas) canvas.innerHTML = '';
}

function setThumbCached(path, url) {
  if (thumbUrlCache.has(path)) {
    thumbUrlCache.delete(path);
  } else if (thumbUrlCache.size >= THUMB_LRU_MAX) {
    const oldestKey = thumbUrlCache.keys().next().value;
    const oldestUrl = thumbUrlCache.get(oldestKey);
    thumbUrlCache.delete(oldestKey);
    if (oldestUrl) URL.revokeObjectURL(oldestUrl);
  }
  thumbUrlCache.set(path, url);
}

async function fetchImportBlob(command, args) {
  const bytes = await invoke(command, args);
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return URL.createObjectURL(new Blob([u8], { type: 'image/jpeg' }));
}

function currentImportThumbMaxSide() {
  const size = readNumber('importThumbnailSize', IMPORT_THUMB_MIN, IMPORT_THUMB_MAX);
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  return Math.min(360, Math.max(160, Math.round(size * dpr)));
}

function enqueueImportThumbnail(file, centerY, imgEl) {
  const cached = thumbUrlCache.get(file.path);
  if (cached) {
    setThumbCached(file.path, cached); // touch LRU
    if (imgEl.src !== cached) imgEl.src = cached;
    return;
  }
  if (thumbActive.has(file.path)) return;
  thumbQueue.set(file.path, { file, y: centerY });
}

function pumpThumbQueue() {
  if (!openState) return;
  const scroll = document.getElementById('import-files-scroll');
  const viewportCenter = scroll ? scroll.scrollTop + scroll.clientHeight / 2 : 0;
  const maxSide = currentImportThumbMaxSide();

  while (thumbActive.size < THUMB_MAX_CONCURRENT && thumbQueue.size > 0) {
    let bestPath = null;
    let bestDist = Infinity;
    for (const [path, job] of thumbQueue) {
      const dist = Math.abs(job.y - viewportCenter);
      if (dist < bestDist) {
        bestDist = dist;
        bestPath = path;
      }
    }
    if (!bestPath) break;
    const { file } = thumbQueue.get(bestPath);
    thumbQueue.delete(bestPath);
    thumbActive.add(bestPath);

    fetchImportBlob('get_import_thumbnail', { sourcePath: file.path, maxSide })
      .then(url => {
        if (!openState) {
          URL.revokeObjectURL(url);
          return;
        }
        setThumbCached(file.path, url);
        const node = renderedNodes.get(file.path);
        if (node?.img && node.img.isConnected) node.img.src = url;
      })
      .catch(() => {})
      .finally(() => {
        thumbActive.delete(file.path);
        pumpThumbQueue();
      });
  }
}

async function updatePreviewPane(file) {
  const pane = document.getElementById('import-preview-pane');
  const resizer = document.getElementById('import-preview-resizer');
  const img = document.getElementById('import-preview-img');
  const meta = document.getElementById('import-preview-meta');
  if (!pane || !img || !meta) return;
  const showPreview = readBool('importShowPreview');
  pane.hidden = !showPreview;
  if (resizer) resizer.hidden = !showPreview;
  if (!showPreview || !file) {
    img.classList.remove('fading-out');
    img.hidden = true;
    img.removeAttribute('src');
    meta.textContent = file ? '' : t('Select a file to preview');
    return;
  }
  const seq = ++previewRequestSeq;
  meta.textContent = `${file.filename} · ${formatImportBytes(file.size)}`;
  if (!img.hidden && img.getAttribute('src')) {
    img.classList.add('fading-out');
  } else {
    img.hidden = true;
  }
  try {
    const url = await fetchImportBlob('get_import_preview', { sourcePath: file.path });
    if (seq !== previewRequestSeq || !openState) {
      URL.revokeObjectURL(url);
      return;
    }
    const pre = new Image();
    pre.src = url;
    await pre.decode().catch(() => {});
    if (seq !== previewRequestSeq || !openState) {
      URL.revokeObjectURL(url);
      return;
    }
    if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
    previewBlobUrl = url;
    img.src = url;
    img.hidden = false;
    img.classList.remove('fading-out');
  } catch {
    if (seq === previewRequestSeq) {
      img.classList.remove('fading-out');
      img.hidden = true;
      img.removeAttribute('src');
    }
  }
}

export function isImportViewOpen() {
  return openState;
}

function formatImportBytes(bytes) {
  const units = [t('B unit'), t('KB'), t('MB unit'), t('GB unit'), t('TB unit')];
  let val = Math.max(0, Number(bytes) || 0);
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  const numStr = idx === 0 || val >= 10
    ? Math.round(val).toLocaleString()
    : val.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${numStr} ${units[idx]}`;
}

const importCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const IMPORT_LIST_COLUMNS = [
  { id: 'selected', literalLabel: 'x', className: 'col-sel', sortType: 'number', sortValue: f => (selectedPaths.has(f.path) ? 0 : 1) },
  { id: 'extension', labelKey: 'Extension', className: 'col-ext', sortType: 'string', sortValue: f => (f.extension || '').toUpperCase() || null },
  { id: 'filename', labelKey: 'Filename', className: 'col-name', sortType: 'string', sortValue: f => f.filename || null },
  { id: 'status', labelKey: 'Status', className: 'col-status', sortType: 'number', sortValue: f => (f.status === 'new' ? 0 : f.status === 'in_library' ? 1 : 2) },
  { id: 'date', labelKey: 'Date', className: 'col-date', sortType: 'number', sortValue: f => fileTimeKey(f) || null },
  { id: 'size', labelKey: 'Size', className: 'col-size', sortType: 'number', sortValue: f => f.size },
];
const IMPORT_COLUMNS_BY_ID = new Map(IMPORT_LIST_COLUMNS.map(col => [col.id, col]));
let importListSort = [];

function loadImportListSort() {
  return readJsonList('importListSort')
    .filter(e => e && IMPORT_COLUMNS_BY_ID.has(e.col) && (e.dir === 'asc' || e.dir === 'desc'))
    .slice(0, 9);
}

function saveImportListSort() {
  writeJsonList('importListSort', importListSort);
}

function readJsonList(key) {
  try {
    const parsed = JSON.parse(readStored(key) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonList(key, list) {
  writeStored(key, JSON.stringify(list));
}

function fileTimeKey(file) {
  const parsed = extractTimeKey(file.dateTaken);
  if (parsed !== null) return parsed;
  if (file.mtime > 0) {
    const d = new Date(file.mtime);
    const pad = n => String(n).padStart(2, '0');
    return Number(`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`);
  }
  return 0;
}

function formatFileDate(file) {
  if (file.dateTaken) return file.dateTaken.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  if (file.mtime > 0) return new Date(file.mtime).toLocaleString();
  return '-';
}

function folderKindClass(folder) {
  const kinds = [
    folder.rawCount > 0 ? 'raw' : null,
    folder.rasterCount > 0 ? 'raster' : null,
    folder.videoCount > 0 ? 'video' : null,
  ].filter(Boolean);
  if (kinds.length === 0) return 'kind-empty';
  if (kinds.length > 1) return 'kind-mixed';
  return `kind-${kinds[0]}`;
}

function folderTooltip(folder) {
  const parts = [];
  if (folder.rawCount > 0) parts.push(`${folder.rawCount} RAW`);
  if (folder.rasterCount > 0) parts.push(`${folder.rasterCount} ${t('Raster')}`);
  if (folder.videoCount > 0) parts.push(`${folder.videoCount} ${t('Videos')}`);
  return parts.length ? parts.join(' · ') : t('No media files');
}

function computeFolderTreeMeta() {
  const subtreeCounts = new Map();
  for (const folder of allFolders) subtreeCounts.set(folder.path, folder.totalCount);
  for (let i = 0; i < allFolders.length; i++) {
    const child = allFolders[i];
    if (child.totalCount === 0) continue;
    const childLower = child.path.toLowerCase();
    for (let j = 0; j < i; j++) {
      const anc = allFolders[j];
      const ancLower = anc.path.toLowerCase();
      if (childLower.startsWith(`${ancLower}/`)) {
        subtreeCounts.set(anc.path, (subtreeCounts.get(anc.path) || 0) + child.totalCount);
      }
    }
  }
  const hideEmpty = readBool('importHideEmptyFolders');
  const visibleFolders = hideEmpty
    ? allFolders.filter(f => (subtreeCounts.get(f.path) || 0) > 0)
    : allFolders;
  const visibleSet = new Set(visibleFolders.map(f => f.path.toLowerCase()));
  const hasChildren = new Map();
  for (let i = 0; i < visibleFolders.length; i++) {
    const f = visibleFolders[i];
    const fLower = f.path.toLowerCase();
    const child = visibleFolders.some((other, j) => j !== i && other.path.toLowerCase().startsWith(`${fLower}/`));
    hasChildren.set(f.path, child);
  }
  return { visibleFolders, visibleSet, hasChildren, subtreeCounts };
}

function openFolderTreeContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  const { visibleFolders, hasChildren, subtreeCounts } = computeFolderTreeMeta();
  const collapsible = visibleFolders.filter(f => hasChildren.get(f.path));
  if (collapsible.length === 0) {
    openContextMenuAt(event, [{ label: t('Collapse all'), disabled: true }]);
    return;
  }
  const anyExpanded = collapsible.some(f => !collapsedFolders.has(f.path));
  const items = anyExpanded
    ? [{
        label: t('Collapse all'),
        onSelect: () => {
          for (const f of collapsible) collapsedFolders.add(f.path);
          renderFolderTree();
        },
      }]
    : [{
        label: t('Expand to non-empty folders'),
        onSelect: () => {
          collapsedFolders.clear();
          for (const f of collapsible) {
            if ((subtreeCounts.get(f.path) || 0) === 0) collapsedFolders.add(f.path);
          }
          renderFolderTree();
        },
      }];
  openContextMenuAt(event, items);
}

function renderFolderTree() {
  const tree = document.getElementById('import-folder-tree');
  if (!tree) return;
  tree.innerHTML = '';
  const { visibleFolders, hasChildren } = computeFolderTreeMeta();
  const activePathNorm = selectedFolderPath ?? currentSource?.rootPath?.replace(/\\/g, '/').replace(/\/+$/, '');

  for (const folder of visibleFolders) {
    const fLower = folder.path.toLowerCase();
    const hiddenByAncestor = Array.from(collapsedFolders).some(c => {
      const cLower = c.toLowerCase();
      return fLower !== cLower && fLower.startsWith(`${cLower}/`);
    });
    if (hiddenByAncestor) continue;

    const li = document.createElement('li');
    li.className = 'import-folder-item';
    if (activePathNorm === folder.path) li.classList.add('active');
    const depth = folder.relativePath ? folder.relativePath.split('/').length : 0;
    li.style.paddingLeft = `${0.35 + depth * 0.75}rem`;
    li.title = folderTooltip(folder);

    const hasSub = hasChildren.get(folder.path) || false;
    const isCollapsed = collapsedFolders.has(folder.path);
    const chevron = document.createElement('button');
    chevron.type = 'button';
    chevron.className = hasSub ? 'import-folder-chevron' : 'import-folder-chevron leaf';
    chevron.textContent = isCollapsed ? '▸' : '▾';
    chevron.title = isCollapsed ? t('Expand folder') : t('Collapse folder');
    chevron.setAttribute('aria-label', chevron.title);
    if (hasSub) {
      chevron.addEventListener('click', e => {
        e.stopPropagation();
        if (collapsedFolders.has(folder.path)) collapsedFolders.delete(folder.path);
        else collapsedFolders.add(folder.path);
        renderFolderTree();
      });
    }

    const icon = document.createElement('span');
    icon.className = `import-folder-icon ${folderKindClass(folder)}`;
    const name = document.createElement('span');
    name.className = 'import-folder-name';
    name.textContent = folder.name;
    const count = document.createElement('span');
    count.className = 'import-folder-count';
    count.textContent = String(folder.totalCount);

    li.append(chevron, icon, name, count);
    if (folder.relativePath === '') {
      li.addEventListener('contextmenu', openFolderTreeContextMenu);
    }
    li.addEventListener('click', () => {
      selectedFolderPath = folder.relativePath === '' ? null : folder.path;
      renderFolderTree();
      applyImportFilters();
    });
    tree.append(li);
  }
}

function applyImportFilters() {
  const includeSub = readBool('importIncludeSubfolders');
  const rootNorm = currentSource?.rootPath?.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ?? '';
  const folderNorm = selectedFolderPath ? selectedFolderPath.toLowerCase() : rootNorm;
  const dateFilter = dateControl?.getFilter() ?? null;

  filteredFiles = allFiles.filter(file => {
    if (!activeKinds.has(file.kind)) return false;
    const fDir = file.folderPath.toLowerCase();
    if (includeSub) {
      if (fDir !== folderNorm && !fDir.startsWith(`${folderNorm}/`)) return false;
    } else if (fDir !== folderNorm) {
      return false;
    }
    if (dateFilter) {
      const tk = fileTimeKey(file);
      if (tk < dateFilter.from || tk > dateFilter.to) return false;
    }
    return true;
  });

  const sortKey = readChoice('importSortKey', ['date', 'name']);
  const sortOrder = readChoice('importSortOrder', ['asc', 'desc']);
  const dir = sortOrder === 'desc' ? -1 : 1;
  const fallbackSort = (a, b) => {
    if (sortKey === 'name') return dir * importCollator.compare(a.filename, b.filename);
    const diff = fileTimeKey(a) - fileTimeKey(b);
    return diff !== 0 ? dir * diff : dir * importCollator.compare(a.filename, b.filename);
  };
  const viewMode = readChoice('importViewMode', ['list', 'thumbnails']);
  const colComparator = viewMode === 'list' && importListSort.length > 0
    ? buildMultiColumnComparator(importListSort, IMPORT_COLUMNS_BY_ID, importCollator)
    : null;
  filteredFiles.sort((a, b) => (colComparator ? colComparator(a, b) : 0) || fallbackSort(a, b));

  rebuildLayout();
  renderVisibleViewport();
  updateSummaryFooter();
}

function groupKeyForFile(file, groupBy) {
  if (groupBy === 'folder') return file.folderPath;
  const tk = fileTimeKey(file);
  if (!tk) return t('Unknown date');
  const s = String(tk);
  if (groupBy === 'day') return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (groupBy === 'month') return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
  return '';
}

function rebuildLayout() {
  const viewMode = readChoice('importViewMode', ['list', 'thumbnails']);
  const groupBy = readChoice('importGroupBy', ['none', 'day', 'month', 'folder']);
  const scroll = document.getElementById('import-files-scroll');
  const width = Math.max(240, (scroll?.clientWidth || 600) - 16);
  layoutEntries = [];
  let y = 0;

  if (viewMode === 'list') {
    const ROW_H = 28;
    const GROUP_H = 26;
    let lastGroup = null;
    for (let i = 0; i < filteredFiles.length; i++) {
      const file = filteredFiles[i];
      if (groupBy !== 'none') {
        const g = groupKeyForFile(file, groupBy);
        if (g !== lastGroup) {
          lastGroup = g;
          layoutEntries.push({ type: 'group', label: g, y, h: GROUP_H });
          y += GROUP_H;
        }
      }
      layoutEntries.push({ type: 'row', file, index: i, y, h: ROW_H });
      y += ROW_H;
    }
  } else {
    const size = readNumber('importThumbnailSize', IMPORT_THUMB_MIN, IMPORT_THUMB_MAX);
    const gap = 8;
    const cols = Math.max(1, Math.floor((width + gap) / (size + gap)));
    const cellW = Math.floor((width - gap * (cols - 1)) / cols);
    const cellH = cellW;
    const GROUP_H = 26;
    let lastGroup = null;
    let col = 0;
    let rowY = 0;
    for (let i = 0; i < filteredFiles.length; i++) {
      const file = filteredFiles[i];
      if (groupBy !== 'none') {
        const g = groupKeyForFile(file, groupBy);
        if (g !== lastGroup) {
          if (col > 0) {
            rowY += cellH + gap;
            col = 0;
          }
          lastGroup = g;
          layoutEntries.push({ type: 'group', label: g, y: rowY, h: GROUP_H });
          rowY += GROUP_H + gap;
        }
      }
      const x = 8 + col * (cellW + gap);
      layoutEntries.push({ type: 'card', file, index: i, x, y: rowY, w: cellW, h: cellH });
      col += 1;
      if (col >= cols) {
        col = 0;
        rowY += cellH + gap;
      }
    }
    y = col > 0 ? rowY + cellH + gap : rowY;
  }

  totalLayoutHeight = y;
  const canvas = document.getElementById('import-files-canvas');
  const empty = document.getElementById('import-files-empty');
  if (canvas) canvas.style.height = `${totalLayoutHeight}px`;
  if (empty) empty.hidden = filteredFiles.length > 0;
}

function statusBadgeText(status) {
  if (status === 'imported_memory') return t('Imported');
  if (status === 'in_library') return t('In library');
  return t('New');
}

function syncItemNodeState(node, file = filesByPath.get(node.path)) {
  const selected = selectedPaths.has(node.path);
  node.el.classList.toggle('selected', selected);
  node.el.classList.toggle('active', activePath === node.path);
  if (node.cb) node.cb.checked = selected;
  if (!file) return;
  if (node.badge) {
    node.badge.className = `import-status-badge ${file.status}`;
    node.badge.textContent = statusBadgeText(file.status);
    node.badge.title = file.existingPath || '';
  }
  if (node.dateEl) node.dateEl.textContent = formatFileDate(file);
}

function renderVisibleViewport() {
  const scroll = document.getElementById('import-files-scroll');
  const canvas = document.getElementById('import-files-canvas');
  if (!scroll || !canvas) return;
  const viewMode = readChoice('importViewMode', ['list', 'thumbnails']);
  if (renderedViewMode !== viewMode) {
    clearRenderedViewport();
    renderedViewMode = viewMode;
  }

  const top = Math.max(0, scroll.scrollTop - 250);
  const bottom = scroll.scrollTop + scroll.clientHeight + 250;
  const layoutMode = readChoice('importThumbnailLayout', ['square', 'framed']);
  const visibleKeys = new Set();
  const frag = document.createDocumentFragment();

  for (let i = 0; i < layoutEntries.length; i++) {
    const entry = layoutEntries[i];
    if (entry.y + entry.h < top || entry.y > bottom) continue;
    const key = entry.type === 'group' ? `g:${i}:${entry.label}` : entry.file.path;
    visibleKeys.add(key);

    const existing = renderedNodes.get(key);
    if (existing) {
      if (entry.type === 'group') {
        existing.el.style.top = `${entry.y}px`;
      } else if (entry.type === 'row') {
        existing.el.style.top = `${entry.y}px`;
        existing.index = entry.index;
        syncItemNodeState(existing, entry.file);
      } else {
        const f = entry.file;
        existing.el.className = `import-thumb-card layout-${layoutMode}`;
        existing.el.style.transform = `translate3d(${entry.x}px, ${entry.y}px, 0)`;
        existing.el.style.width = `${entry.w}px`;
        existing.el.style.height = `${entry.h}px`;
        existing.index = entry.index;
        syncItemNodeState(existing, f);
        enqueueImportThumbnail(f, entry.y + entry.h / 2, existing.img);
      }
      continue;
    }

    if (entry.type === 'group') {
      const div = document.createElement('div');
      div.className = 'import-group-header';
      div.style.top = `${entry.y}px`;
      div.textContent = entry.label;
      renderedNodes.set(key, { el: div, type: 'group' });
      frag.append(div);
    } else if (entry.type === 'row') {
      const f = entry.file;
      const row = document.createElement('div');
      row.className = 'import-list-row';
      row.style.top = `${entry.y}px`;

      const selCell = document.createElement('span');
      selCell.className = 'import-list-cell-sel';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.addEventListener('click', e => {
        e.stopPropagation();
        togglePathSelection(f.path, cb.checked);
      });
      selCell.append(cb);

      const extCell = document.createElement('span');
      extCell.className = 'import-list-cell-ext';
      const pill = document.createElement('span');
      pill.className = `list-ext-pill ext-${f.kind === 'raw' ? 'raw' : f.kind === 'video' ? 'video' : 'photo'}`;
      pill.textContent = f.extension.toUpperCase();
      extCell.append(pill);

      const name = document.createElement('span');
      name.className = 'import-list-name';
      name.textContent = f.filename;
      name.title = f.relativePath;

      const right = document.createElement('div');
      right.className = 'import-list-right';
      right.title = t('Click to preview without changing selection');

      const statusCell = document.createElement('span');
      statusCell.className = 'import-list-cell-status';
      const badge = document.createElement('span');
      statusCell.append(badge);

      const dateEl = document.createElement('span');
      dateEl.className = 'import-list-date';

      const sizeEl = document.createElement('span');
      sizeEl.className = 'import-list-size';
      sizeEl.textContent = formatImportBytes(f.size);

      right.append(statusCell, dateEl, sizeEl);
      row.append(selCell, extCell, name, right);
      const nodeRec = { el: row, type: 'row', path: f.path, cb, badge, dateEl, index: entry.index };
      syncItemNodeState(nodeRec, f);
      row.addEventListener('click', e => {
        if (e.target.closest('.import-list-right')) {
          previewOnlyFile(f);
          return;
        }
        handleFileClick(f, nodeRec.index, e);
      });
      renderedNodes.set(key, nodeRec);
      frag.append(row);
    } else {
      const f = entry.file;
      const card = document.createElement('div');
      card.className = `import-thumb-card layout-${layoutMode}`;
      card.style.transform = `translate3d(${entry.x}px, ${entry.y}px, 0)`;
      card.style.width = `${entry.w}px`;
      card.style.height = `${entry.h}px`;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'import-thumb-check';
      cb.addEventListener('click', e => {
        e.stopPropagation();
        togglePathSelection(f.path, cb.checked);
      });

      const img = document.createElement('img');
      img.alt = f.filename;
      img.dataset.path = f.path;

      const badge = document.createElement('span');

      const label = document.createElement('span');
      label.className = 'import-thumb-label';
      label.textContent = f.filename;

      card.append(cb, img, badge, label);
      const nodeRec = { el: card, type: 'card', path: f.path, cb, img, badge, index: entry.index };
      syncItemNodeState(nodeRec, f);
      card.addEventListener('click', e => handleFileClick(f, nodeRec.index, e));
      renderedNodes.set(key, nodeRec);
      frag.append(card);
      enqueueImportThumbnail(f, entry.y + entry.h / 2, img);
    }
  }

  for (const [key, node] of renderedNodes) {
    if (!visibleKeys.has(key)) {
      node.el.remove();
      renderedNodes.delete(key);
      if (node.path) thumbQueue.delete(node.path);
    }
  }
  if (frag.childNodes.length > 0) canvas.append(frag);
  if (viewMode === 'thumbnails') pumpThumbQueue();
}

function syncSelectionAndActiveClasses() {
  for (const node of renderedNodes.values()) {
    if (node.type === 'group') continue;
    syncItemNodeState(node, null);
  }
}

function previewOnlyFile(file) {
  activePath = file.path;
  updatePreviewPane(file);
  syncSelectionAndActiveClasses();
}

function togglePathSelection(path, checked) {
  if (checked) selectedPaths.add(path);
  else selectedPaths.delete(path);
  activePath = path;
  const f = filteredFiles.find(item => item.path === path) || null;
  updatePreviewPane(f);
  syncSelectionAndActiveClasses();
  updateSummaryFooter();
}

function handleFileClick(file, index, event) {
  if (event.shiftKey && activePath) {
    const prevIdx = filteredFiles.findIndex(item => item.path === activePath);
    if (prevIdx >= 0) {
      const [lo, hi] = prevIdx < index ? [prevIdx, index] : [index, prevIdx];
      for (let i = lo; i <= hi; i++) selectedPaths.add(filteredFiles[i].path);
    }
  } else {
    if (selectedPaths.has(file.path)) selectedPaths.delete(file.path);
    else selectedPaths.add(file.path);
  }
  activePath = file.path;
  updatePreviewPane(file);
  syncSelectionAndActiveClasses();
  updateSummaryFooter();
}

// Same date range as the "Since last import" filter button (#btn-import-recall-date).
function recentImportRange() {
  const dt = currentSource?.lastImportedFileDt;
  if (!dt) return null;
  return parseDateFilter(`${dt}-99991231235959`).filter || null;
}

function updateSummaryFooter() {
  const summaryEl = document.getElementById('import-selection-summary');
  const spaceEl = document.getElementById('import-dest-space');
  const startBtn = document.getElementById('btn-import-start');
  let selectedBytes = 0;
  let selectedCount = 0;
  for (const f of allFiles) {
    if (selectedPaths.has(f.path)) {
      selectedCount += 1;
      selectedBytes += f.size;
    }
  }
  if (summaryEl) {
    const selStr = selectedCount.toLocaleString();
    const totStr = filteredFiles.length.toLocaleString();
    summaryEl.textContent = selectedCount > 0
      ? t('{selected} / {total} files selected ({size})', { selected: selStr, total: totStr, size: formatImportBytes(selectedBytes) })
      : t('{selected} / {total} files selected', { selected: selStr, total: totStr });
  }
  const insufficient = destInfo.valid && destInfo.freeBytes > 0 && selectedBytes > destInfo.freeBytes;
  if (spaceEl) {
    spaceEl.classList.toggle('insufficient', insufficient);
    spaceEl.textContent = destInfo.valid && destInfo.freeBytes > 0
      ? `(${t('Free space: {size}', { size: formatImportBytes(destInfo.freeBytes) })}${insufficient ? ` · ${t('Insufficient space')}` : ''})`
      : '';
  }
  if (startBtn) startBtn.disabled = selectedCount === 0 || !destInfo.valid || insufficient;

  const recentRange = recentImportRange();
  let filteredSelected = 0;
  let filteredNewCount = 0;
  let filteredNewSelected = 0;
  let filteredRecentCount = 0;
  let filteredRecentSelected = 0;
  for (const f of filteredFiles) {
    const isSel = selectedPaths.has(f.path);
    if (isSel) filteredSelected += 1;
    if (f.status === 'new') {
      filteredNewCount += 1;
      if (isSel) filteredNewSelected += 1;
    }
    if (recentRange) {
      const tk = fileTimeKey(f);
      if (tk >= recentRange.from && tk <= recentRange.to) {
        filteredRecentCount += 1;
        if (isSel) filteredRecentSelected += 1;
      }
    }
  }
  const allOn = filteredFiles.length > 0 && filteredSelected === filteredFiles.length;
  const noneOn = filteredSelected === 0;
  const newOn = !allOn && !noneOn && filteredNewCount > 0 && filteredNewSelected === filteredNewCount && filteredSelected === filteredNewCount;
  const recentOn = !allOn && !noneOn && filteredRecentCount > 0 && filteredRecentSelected === filteredRecentCount && filteredSelected === filteredRecentCount;
  document.getElementById('btn-import-select-all')?.setAttribute('aria-pressed', String(allOn));
  document.getElementById('btn-import-select-new')?.setAttribute('aria-pressed', String(newOn));
  const recentBtn = document.getElementById('btn-import-select-recent');
  if (recentBtn) {
    recentBtn.disabled = !recentRange;
    recentBtn.setAttribute('aria-pressed', String(recentOn));
  }
  document.getElementById('btn-import-select-none')?.setAttribute('aria-pressed', String(noneOn));
}

function populateSourceSelect(selectedPath) {
  const select = document.getElementById('import-source-select');
  if (!select) return;
  select.innerHTML = '';
  const detected = getDetectedMedia();
  for (const dev of detected) {
    const opt = document.createElement('option');
    opt.value = dev.rootPath;
    opt.textContent = `${dev.label} (${dev.rootPath})`;
    select.append(opt);
  }
  if (selectedPath && !detected.some(d => d.rootPath.toLowerCase() === selectedPath.toLowerCase())) {
    const opt = document.createElement('option');
    opt.value = selectedPath;
    opt.textContent = selectedPath;
    select.append(opt);
  }
  if (selectedPath) select.value = selectedPath;
}

function resetSourceState() {
  if (currentExifTaskId) {
    invoke('cancel_scan', { taskId: currentExifTaskId }).catch(() => {});
    currentExifTaskId = null;
  }
  revokeAllBlobs();
  clearRenderedViewport();
  const storageBadge = document.getElementById('import-storage-badge');
  if (storageBadge) storageBadge.hidden = true;
  const exifStatus = document.getElementById('import-exif-status');
  if (exifStatus) exifStatus.hidden = true;
  const ejectBtn = document.getElementById('btn-import-eject');
  if (ejectBtn) ejectBtn.hidden = true;
  const statusEl = document.getElementById('import-media-status');
  if (statusEl) statusEl.textContent = '';
  const lastInfoEl = document.getElementById('import-last-import-info');
  if (lastInfoEl) lastInfoEl.textContent = '';
  const recallBtn = document.getElementById('btn-import-recall-date');
  if (recallBtn) recallBtn.hidden = true;
  const recentSelBtn = document.getElementById('btn-import-select-recent');
  if (recentSelBtn) recentSelBtn.disabled = true;

  currentSource = null;
  selectedPaths.clear();
  collapsedFolders.clear();
  activePath = null;
  selectedFolderPath = null;
  allFolders = [];
  allFiles = [];
  filesByPath.clear();
  filteredFiles = [];
  dateControl?.clear?.();
  renderFolderTree();
  rebuildLayout();
  renderVisibleViewport();
  updateSummaryFooter();
  updatePreviewPane(null);
}

async function loadSource(sourcePath) {
  if (!sourcePath) return;
  resetSourceState();

  try {
    currentSource = await invoke('identify_source', { path: sourcePath });
  } catch (error) {
    host.showToast?.(t('Cannot read source: {error}', { error }));
    return;
  }
  populateSourceSelect(currentSource.rootPath);

  const ejectBtn = document.getElementById('btn-import-eject');
  if (ejectBtn) ejectBtn.hidden = !currentSource.ejectable;

  const statusEl = document.getElementById('import-media-status');
  if (statusEl) statusEl.textContent = `${currentSource.label} (${currentSource.rootPath})`;

  const storageBadge = document.getElementById('import-storage-badge');
  if (storageBadge) {
    const kind = currentSource.storageKind || 'internal';
    const labelKey = kind === 'removable'
      ? 'Removable Disk'
      : kind === 'network'
        ? 'Network Disk'
        : 'Internal Disk';
    storageBadge.textContent = t(labelKey);
    storageBadge.className = `import-storage-badge storage-${kind}`;
    storageBadge.hidden = false;
  }

  const lastInfoEl = document.getElementById('import-last-import-info');
  if (lastInfoEl) {
    lastInfoEl.textContent = currentSource.lastImportAt > 0
      ? t('Last import: {date}', { date: new Date(currentSource.lastImportAt).toLocaleString() })
      : t('First import from this media');
  }
  const recallBtn = document.getElementById('btn-import-recall-date');
  if (recallBtn) recallBtn.hidden = !currentSource.lastImportedFileDt;
  const recentSelBtn = document.getElementById('btn-import-select-recent');
  if (recentSelBtn) recentSelBtn.disabled = !currentSource.lastImportedFileDt;

  const scanId = `import-fast-${Date.now()}`;
  const scan = await invoke('scan_import_source_fast', {
    rootPath: currentSource.rootPath,
    mediaId: currentSource.mediaId,
    taskId: scanId,
  });
  if (!openState) return;
  allFolders = scan.folders;
  allFiles = scan.files;
  filesByPath = new Map(allFiles.map(f => [f.path, f]));
  if (readBool('importAutoSelectNew')) {
    for (const f of allFiles) {
      if (f.status === 'new') selectedPaths.add(f.path);
    }
  }
  renderFolderTree();
  applyImportFilters();
  if (filteredFiles.length > 0) {
    activePath = filteredFiles[0].path;
    updatePreviewPane(filteredFiles[0]);
  }

  // Pass 2: lightweight EXIF reading (max 2 threads) + ambiguous duplicate disambiguation
  const exifPaths = allFiles.filter(f => f.kind !== 'video').map(f => f.path);
  if (exifPaths.length > 0) {
    const exifId = `import-exif-${Date.now()}`;
    currentExifTaskId = exifId;
    const exifStatus = document.getElementById('import-exif-status');
    if (exifStatus) {
      exifStatus.hidden = false;
      exifStatus.textContent = t('Reading EXIF…');
    }
    invoke('read_import_source_exif', {
      paths: exifPaths,
      checkAmbiguous: true,
      taskId: exifId,
    })
      .then(() => {
        if (currentExifTaskId === exifId && exifStatus) exifStatus.hidden = true;
      })
      .catch(() => {
        if (currentExifTaskId === exifId && exifStatus) exifStatus.hidden = true;
      });
  }
}

async function setDestination(path) {
  if (!path) {
    destInfo = { valid: false, resolvedPath: '', freeBytes: 0, isPrivate: false };
    updateDestinationUI();
    return;
  }
  try {
    const info = await invoke('check_destination_info', { path });
    destInfo = info;
    if (info.valid) writeStored('importLastDestination', info.resolvedPath);
  } catch {
    destInfo = { valid: false, resolvedPath: path, freeBytes: 0, isPrivate: false };
  }
  updateDestinationUI();
}

function updateDestinationUI() {
  const pathEl = document.getElementById('import-dest-path');
  const warnEl = document.getElementById('import-privacy-warning');
  const favBtn = document.getElementById('btn-import-add-fav');
  if (pathEl) pathEl.textContent = destInfo.valid ? destInfo.resolvedPath : t('Choose a folder in the library…');
  if (warnEl) warnEl.hidden = !destInfo.isPrivate;
  const favs = readJsonList('importFavoriteDestinations');
  if (favBtn) {
    const isFav = destInfo.valid && favs.some(p => p.toLowerCase() === destInfo.resolvedPath.toLowerCase());
    favBtn.classList.toggle('is-fav', isFav);
    const label = isFav ? t('Remove from favorites') : t('Add to favorites');
    favBtn.title = label;
    favBtn.setAttribute('aria-label', label);
  }
  updateTargetPreview();
  updateSummaryFooter();
}

function updateTargetPreview() {
  const preview = document.getElementById('import-target-preview');
  const summary = document.getElementById('import-subfolders-summary');
  const mode = readChoice('importSubfolderMode', IMPORT_SUBFOLDER_MODES);
  const custom = (readStored('importCustomSubfolder') ?? '').trim();
  const split = readBool('importSplitByType');
  const rawName = (readStored('importSubfolderRaw') ?? DEFAULTS.importSubfolderRaw).trim();

  const customInput = document.getElementById('import-custom-subfolder');
  if (customInput) customInput.hidden = mode !== 'custom' && mode !== 'yyyy_mm_dd_custom';
  const splitFields = document.getElementById('import-split-type-fields');
  if (splitFields) splitFields.hidden = !split;

  const parts = [];
  if (mode === 'custom' && custom) parts.push(custom);
  else if (mode === 'yyyy_mm_dd') parts.push('2026-11-27');
  else if (mode === 'yyyy/yyyy_mm_dd') parts.push('2026', '2026-11-27');
  else if (mode === 'yyyy/mm') parts.push('2026', '11');
  else if (mode === 'yyyy_mm_dd_custom') parts.push(custom ? `2026-11-27_${custom}` : '2026-11-27');
  if (split && rawName) parts.push(rawName);
  parts.push('IMG_0001.CR3');

  if (preview) preview.textContent = `${t('Example:')} ${parts.join('/')}`;
  if (summary) summary.textContent = parts.length > 1 ? parts.slice(0, -1).join('/') : t('None');
}

function pushRecentDestination(path) {
  const norm = path.toLowerCase();
  const list = readJsonList('importRecentDestinations').filter(p => p.toLowerCase() !== norm);
  list.unshift(path);
  writeJsonList('importRecentDestinations', list.slice(0, 5));
}

async function addFavoriteDestination() {
  if (!destInfo.valid) return;
  const path = destInfo.resolvedPath;
  let favs = readJsonList('importFavoriteDestinations');
  const existingIdx = favs.findIndex(p => p.toLowerCase() === path.toLowerCase());
  if (existingIdx >= 0) {
    favs.splice(existingIdx, 1);
    writeJsonList('importFavoriteDestinations', favs);
    updateDestinationUI();
    return;
  }
  if (favs.length >= 10) {
    const toRemove = await askFavoriteToReplace(favs);
    if (!toRemove) return;
    favs = favs.filter(p => p !== toRemove);
  }
  favs.push(path);
  favs.sort((a, b) => a.localeCompare(b));
  writeJsonList('importFavoriteDestinations', favs);
  updateDestinationUI();
}

function askFavoriteToReplace(favs) {
  return new Promise(resolve => {
    let chosen = null;
    const modal = createModal({ title: t('Favorites full (10 max)'), cardClass: 'confirm-card', onClose: () => resolve(chosen) });
    const msg = makeEl('p', 'confirm-message', t('Choose a favorite to remove before adding this one:'));
    const list = makeEl('div', 'import-devices-list');
    const okBtn = makeEl('button', 'btn-primary', t('OK'));
    okBtn.type = 'button';
    okBtn.disabled = true;
    let selectedItem = null;
    for (const fav of favs) {
      const btn = makeEl('button', 'import-device-row', fav);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        selectedItem = fav;
        okBtn.disabled = false;
        for (const child of list.children) child.classList.toggle('active', child === btn);
      });
      list.append(btn);
    }
    okBtn.addEventListener('click', () => {
      chosen = selectedItem;
      modal.close();
    });
    const cancelBtn = makeEl('button', '', t('Cancel'));
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => modal.close());
    const actions = makeEl('div', 'confirm-actions');
    actions.append(okBtn, cancelBtn);
    modal.body.append(msg, list, actions);
  });
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function showImportReportModal(report) {
  const modal = createModal({ title: t('Import report'), cardClass: 'confirm-card' });
  const tabs = makeEl('div', 'import-report-tabs');
  const list = makeEl('ul', 'import-report-list');
  const sections = [
    { key: 'skipped', label: `${t('Skipped')} (${report.skipped.length})`, items: report.skipped.map(s => `${s.path} — ${t('Already exists')}`) },
    { key: 'failed', label: `${t('Copy errors')} (${report.failed.length})`, items: report.failed.map(f => `${f.path} — ${f.error}`) },
    { key: 'integrity', label: `${t('Integrity issues')} (${report.integrityIssues.length})`, items: report.integrityIssues.map(i => `${i.path} — ${i.error}`) },
  ];
  const showTab = key => {
    for (const btn of tabs.children) btn.classList.toggle('active', btn.dataset.key === key);
    list.innerHTML = '';
    const sec = sections.find(s => s.key === key);
    if (!sec || sec.items.length === 0) {
      list.append(makeEl('li', 'import-note', t('Nothing to report')));
      return;
    }
    for (const text of sec.items) list.append(makeEl('li', '', text));
  };
  for (const sec of sections) {
    const btn = makeEl('button', '', sec.label);
    btn.type = 'button';
    btn.dataset.key = sec.key;
    btn.addEventListener('click', () => showTab(sec.key));
    tabs.append(btn);
  }
  const firstNonEmpty = sections.find(s => s.items.length > 0)?.key ?? 'skipped';
  modal.body.append(tabs, list);
  showTab(firstNonEmpty);
}

async function startImport() {
  if (!currentSource || !destInfo.valid) return;
  const selected = allFiles.filter(f => selectedPaths.has(f.path));
  if (selected.length === 0) return;

  // Chronological order ascending
  selected.sort((a, b) => {
    const d = fileTimeKey(a) - fileTimeKey(b);
    return d !== 0 ? d : a.path.localeCompare(b.path);
  });

  const options = {
    baseDestination: destInfo.resolvedPath,
    subfolderMode: readChoice('importSubfolderMode', IMPORT_SUBFOLDER_MODES),
    customSubfolder: readStored('importCustomSubfolder') ?? '',
    splitByType: readBool('importSplitByType'),
    subfolderRaw: readStored('importSubfolderRaw') ?? DEFAULTS.importSubfolderRaw,
    subfolderRaster: readStored('importSubfolderRaster') ?? DEFAULTS.importSubfolderRaster,
    subfolderVideo: readStored('importSubfolderVideo') ?? DEFAULTS.importSubfolderVideo,
  };
  const items = selected.map(f => ({
    sourcePath: f.path,
    relativePath: f.relativePath,
    filename: f.filename,
    kind: f.kind,
    size: f.size,
    mtime: f.mtime,
    dateTaken: f.dateTaken,
  }));

  const collisionPolicy = readChoice('importCollisionPolicy', ['skip', 'rename', 'ask']);
  let resolutions = {};
  if (collisionPolicy === 'ask') {
    const conflicts = await invoke('check_import_conflicts', { items, options });
    if (conflicts.length > 0) {
      const answered = await askImportConflictResolutions(conflicts);
      if (answered === null) return;
      resolutions = answered;
    }
  }

  const postRename = readBool('importPostRename');
  const presetSel = document.getElementById('import-post-rename-preset');
  const postRenamePresetName = readStored('importPostRenamePreset') || presetSel?.value || '';
  const postIntegrity = readBool('importPostIntegrity');
  const postFaces = readBool('importPostFaces') && host.isFaceDetectionEnabled?.();
  const postHashes = readBool('importPostHashes');
  const postSemantic = readBool('importPostSemantic') && host.isSemanticEnabled?.();
  const computeIntegrityHashes = !postHashes && readBool('duplicateHashOnIntegrity');

  let renameSteps = null;
  if (postRename && postRenamePresetName) {
    const presets = await invoke('list_rename_presets').catch(() => []);
    const found = presets.find(p => p.name === postRenamePresetName);
    if (found) {
      try { renameSteps = JSON.parse(found.steps); } catch { renameSteps = null; }
    }
  }

  pushRecentDestination(destInfo.resolvedPath);
  const sourceSnapshot = { ...currentSource };
  const importGroupId = `import-grp-${Date.now()}`;
  const report = { skipped: [], failed: [], integrityIssues: [] };

  // Pre-enqueue blocked placeholders for optional post-import workflows
  const placeholders = {};
  if (postRename && renameSteps) {
    placeholders.rename = host.enqueueTask({
      kind: 'rename',
      path: destInfo.resolvedPath,
      command: 'rename_photos',
      args: { items: [] },
      labelKey: 'Import · Batch rename',
      blocked: true,
      importGroupId,
    });
  }
  if (postIntegrity) {
    placeholders.integrity = host.enqueueTask({
      kind: 'integrity',
      path: destInfo.resolvedPath,
      command: 'integrity_scan',
      args: { path: destInfo.resolvedPath, computeHashes: computeIntegrityHashes, paths: [] },
      labelKey: 'Import · Integrity check',
      blocked: true,
      importGroupId,
    });
  }
  if (postFaces) {
    placeholders.faces = host.enqueueTask({
      kind: 'faces-selection',
      path: destInfo.resolvedPath,
      command: 'detect_faces',
      args: { photoIds: [], folder: null, recursive: false, onlyUnscanned: true },
      labelKey: 'Import · Face detection',
      blocked: true,
      importGroupId,
    });
  }
  if (postHashes) {
    const hashKind = readChoice('duplicatePrecomputeExactMode', ['prepass', 'full']) === 'full' ? 'both_full' : 'both_prepass';
    const hashThreads = readChoice('duplicateHashThreads', ['auto', '1', '2', '4']);
    placeholders.hashes = host.enqueueTask({
      kind: 'hash-precompute',
      path: destInfo.resolvedPath,
      command: 'precompute_hashes',
      args: { kind: hashKind, includeRaw: true, scope: { kind: 'paths', paths: [] }, threads: hashThreads },
      labelKey: 'Import · Duplicate hashes',
      blocked: true,
      importGroupId,
    });
  }
  if (postSemantic) {
    placeholders.semantic = host.enqueueTask({
      kind: 'semantic',
      path: destInfo.resolvedPath,
      command: 'semantic_scan',
      args: { photoIds: [], folder: null, recursive: false },
      labelKey: 'Import · Content analysis',
      blocked: true,
      importGroupId,
    });
  }

  const finalizeReportIfNeeded = () => {
    if (report.skipped.length || report.failed.length || report.integrityIssues.length) {
      host.keepTaskReady?.(null, {
        kind: 'import',
        labelKey: 'Import report',
        readyText: `${tp('{count} skipped', report.skipped.length)} · ${tp('{count} error', report.failed.length + report.integrityIssues.length)}`,
        showLabel: t('Show report'),
        onShow: () => showImportReportModal(report),
      });
    }
  };

  host.enqueueTask({
    kind: 'import',
    path: destInfo.resolvedPath,
    command: 'run_import_copy',
    args: {
      request: {
        mediaId: sourceSnapshot.mediaId,
        rootFolder: sourceSnapshot.rootPath,
        items,
        options,
        collisionPolicy: collisionPolicy === 'ask' ? 'rename' : collisionPolicy,
        resolutions,
        verifyVideos: postIntegrity,
      },
    },
    labelKey: 'Importing ({count})',
    labelParams: { count: items.length },
    onResult: async (result, _stopped, error) => {
      if (error || !result || result.copied.length === 0) {
        cancelTasksByGroup(importGroupId);
        if (error) host.showToast?.(t('Import failed: {error}', { error }));
        else if (result) {
          report.skipped.push(...result.skipped);
          report.failed.push(...result.failed);
          finalizeReportIfNeeded();
        }
        return;
      }

      report.skipped.push(...result.skipped);
      report.failed.push(...result.failed);

      // Offer card ejection right after copy finishes + surface any sidecar collision renames
      const renamed = sidecarRenameNotice({
        renamed_for_sidecar: result.renamedForSidecar,
        log_path: result.logPath,
      });
      const toastText = [tp('{count} file imported', result.copied.length), renamed.text]
        .filter(Boolean)
        .join(' · ');
      const toastActions = [];
      if (sourceSnapshot.ejectable) {
        toastActions.push({
          label: t('Eject media'),
          onClick: async () => {
            try {
              await invoke('eject_media', { rootPath: sourceSnapshot.rootPath });
              host.showToast?.(t('Media ejected safely'));
              await refreshDetectedMedia();
            } catch (err) {
              host.showToast?.(t('Eject failed: {error}', { error: err }));
            }
          },
        });
      }
      if (renamed.action) toastActions.push(renamed.action);
      host.showToast?.(
        toastText,
        toastActions.length ? toastActions : undefined,
        toastActions.length ? 12000 : undefined,
      );

      // Targeted indexing of ONLY copied paths, preserving chronological copy order for {counter}
      const copiedPaths = result.copied.map(c => c.destPath);
      let indexedPhotos = [];
      try {
        indexedPhotos = await invoke('index_imported_photos', { paths: copiedPaths });
      } catch (err) {
        console.error('Targeted indexing failed:', err);
      }
      const normPath = p => p.replace(/\\/g, '/').toLowerCase();
      const pathOrder = new Map(copiedPaths.map((p, idx) => [normPath(p), idx]));
      indexedPhotos.sort(
        (a, b) => (pathOrder.get(normPath(a.path)) ?? Infinity) - (pathOrder.get(normPath(b.path)) ?? Infinity),
      );
      await host.onImportIndexed?.();

      let currentPaths = [...copiedPaths];
      const importedIds = indexedPhotos.map(p => p.id);

      const hashKind = readChoice('duplicatePrecomputeExactMode', ['prepass', 'full']) === 'full' ? 'both_full' : 'both_prepass';
      const hashThreads = readChoice('duplicateHashThreads', ['auto', '1', '2', '4']);

      const unblockPostRenameTasks = paths => {
        if (placeholders.integrity) {
          updateWaitingTask(placeholders.integrity, {
            blocked: false,
            args: { path: options.baseDestination, computeHashes: computeIntegrityHashes, paths },
            onResult: (intRes) => {
              if (intRes?.suspects?.length) report.integrityIssues.push(...intRes.suspects);
              finalizeReportIfNeeded();
            },
          });
        } else {
          finalizeReportIfNeeded();
        }

        if (placeholders.faces) {
          if (importedIds.length > 0) {
            updateWaitingTask(placeholders.faces, {
              blocked: false,
              args: { photoIds: importedIds, folder: null, recursive: false, onlyUnscanned: true },
              onResult: async (_res, _stopped, err) => {
                if (err) host.showToast?.(t('Face detection failed: {error}', { error: String(err) }));
                await refreshFaces();
              },
            });
          } else {
            removeWaitingTask(placeholders.faces);
          }
        }

        if (placeholders.hashes) {
          updateWaitingTask(placeholders.hashes, {
            blocked: false,
            args: { kind: hashKind, includeRaw: true, scope: { kind: 'paths', paths }, threads: hashThreads },
            onResult: (_res, _stopped, err) => {
              notifyPhashChanged();
              notifyExactHashChanged();
              refreshDuplicateHashStats();
              if (err) host.showToast?.(t('Hash computation failed: {error}', { error: String(err) }));
            },
          });
        }

        if (placeholders.semantic) {
          if (importedIds.length > 0) {
            updateWaitingTask(placeholders.semantic, {
              blocked: false,
              args: {
                photoIds: importedIds,
                folder: null,
                recursive: false,
                threads: semanticScanThreads(),
                skipRaw: !readBool('semanticScanRaw'),
                writeThumbnails: readBool('semanticWriteThumbnails'),
                computePhash: readBool('duplicateHashOnSemantic'),
              },
              onResult: (_res, _stopped, err) => {
                notifyAnalysisChanged();
                notifyPhashChanged();
                notifyExactHashChanged();
                refreshDuplicateHashStats();
                if (err) host.showToast?.(t('Content analysis failed: {error}', { error: String(err) }));
              },
            });
          } else {
            removeWaitingTask(placeholders.semantic);
          }
        }

        triggerTaskPumps();
      };

      if (placeholders.rename) {
        const renameItems = [];
        indexedPhotos.forEach((photo, index) => {
          const { stem } = splitFileName(photo.filename);
          const res = evaluate(renameSteps, { stem, photo, index, count: indexedPhotos.length });
          if (res.name) renameItems.push({ path: photo.path, newName: res.name });
        });
        if (renameItems.length > 0) {
          updateWaitingTask(placeholders.rename, {
            blocked: false,
            args: { items: renameItems },
            onResult: (renRes) => {
              if (renRes?.renamed?.length) {
                const map = new Map(renRes.renamed.map(r => [r.from, r.to]));
                currentPaths = currentPaths.map(p => map.get(p) ?? p);
                host.onImportIndexed?.();
              }
              if (renRes?.failed?.length) {
                report.failed.push(...renRes.failed.map(f => ({ path: f.path, error: f.detail || f.code })));
              }
              unblockPostRenameTasks(currentPaths);
            },
          });
          triggerTaskPumps();
          return;
        }
        removeWaitingTask(placeholders.rename);
      }

      unblockPostRenameTasks(currentPaths);
    },
  });

  closeImportView();
}

export async function openImportView({ sourcePath = null, destination = null } = {}) {
  if (!(await host.prepareOpenImport?.())) return;
  openState = true;
  document.querySelector('.main-content')?.classList.add('import-mode');
  const view = document.getElementById('import-view');
  if (view) view.hidden = false;
  const previewResizer = document.getElementById('import-preview-resizer');
  if (previewResizer) previewResizer.hidden = !readBool('importShowPreview');
  syncImportToolbarButton();

  await refreshDetectedMedia();
  const initialSource = sourcePath || getDetectedMedia().find(d => d.eligible)?.rootPath || '';
  resetSourceState();
  populateSourceSelect(initialSource);
  await setDestination(destination || readStored('importLastDestination') || '');
  await refreshRenamePresetsDropdown();
  await refreshImportPresetsDropdown();
  renderImportSortButton();
  renderImportListHeader();
  updatePostTasksVisibility();
  if (initialSource) await loadSource(initialSource);
}

export function closeImportView() {
  if (!openState) return;
  openState = false;
  if (currentExifTaskId) {
    invoke('cancel_scan', { taskId: currentExifTaskId }).catch(() => {});
    currentExifTaskId = null;
  }
  revokeAllBlobs();
  clearRenderedViewport();
  const view = document.getElementById('import-view');
  if (view) view.hidden = true;
  document.querySelector('.main-content')?.classList.remove('import-mode');
  syncImportToolbarButton();
  host.onImportClosed?.();
}

function collectImportRecipeConfig() {
  return {
    subfolderMode: readChoice('importSubfolderMode', IMPORT_SUBFOLDER_MODES),
    customSubfolder: readStored('importCustomSubfolder') ?? '',
    splitByType: readBool('importSplitByType'),
    subfolderRaw: readStored('importSubfolderRaw') ?? DEFAULTS.importSubfolderRaw,
    subfolderRaster: readStored('importSubfolderRaster') ?? DEFAULTS.importSubfolderRaster,
    subfolderVideo: readStored('importSubfolderVideo') ?? DEFAULTS.importSubfolderVideo,
    collisionPolicy: readChoice('importCollisionPolicy', ['skip', 'rename', 'ask']),
    postRename: readBool('importPostRename'),
    postRenamePreset: readStored('importPostRenamePreset') ?? '',
    postIntegrity: readBool('importPostIntegrity'),
    postFaces: readBool('importPostFaces'),
    postHashes: readBool('importPostHashes'),
    postSemantic: readBool('importPostSemantic'),
  };
}

async function applyImportRecipeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = Boolean(val); };

  if (typeof cfg.subfolderMode === 'string') {
    writeStored('importSubfolderMode', cfg.subfolderMode);
    setVal('import-subfolder-mode', cfg.subfolderMode);
  }
  if (typeof cfg.customSubfolder === 'string') {
    writeStored('importCustomSubfolder', cfg.customSubfolder);
    setVal('import-custom-subfolder', cfg.customSubfolder);
  }
  if (typeof cfg.splitByType === 'boolean') {
    writeStored('importSplitByType', cfg.splitByType);
    setChk('import-split-by-type', cfg.splitByType);
  }
  if (typeof cfg.collisionPolicy === 'string') {
    writeStored('importCollisionPolicy', cfg.collisionPolicy);
    setVal('import-collision-policy', cfg.collisionPolicy);
  }
  for (const [field, key, id] of [
    ['subfolderRaw', 'importSubfolderRaw', 'import-subfolder-raw'],
    ['subfolderRaster', 'importSubfolderRaster', 'import-subfolder-raster'],
    ['subfolderVideo', 'importSubfolderVideo', 'import-subfolder-video'],
  ]) {
    if (typeof cfg[field] === 'string') {
      writeStored(key, cfg[field]);
      setVal(id, cfg[field]);
    }
  }
  for (const [field, key, id] of [
    ['postRename', 'importPostRename', 'import-post-rename'],
    ['postIntegrity', 'importPostIntegrity', 'import-post-integrity'],
    ['postFaces', 'importPostFaces', 'import-post-faces'],
    ['postHashes', 'importPostHashes', 'import-post-hashes'],
    ['postSemantic', 'importPostSemantic', 'import-post-semantic'],
  ]) {
    if (typeof cfg[field] === 'boolean') {
      writeStored(key, cfg[field]);
      setChk(id, cfg[field]);
    }
  }
  if (typeof cfg.postRenamePreset === 'string') {
    writeStored('importPostRenamePreset', cfg.postRenamePreset);
  }
  await refreshRenamePresetsDropdown();
  updateTargetPreview();
  updatePostTasksVisibility();
}

function isImportRecipeModified() {
  if (!selectedImportPreset) return false;
  try {
    const saved = JSON.parse(selectedImportPreset.config || '{}');
    const current = collectImportRecipeConfig();
    for (const key of Object.keys(current)) {
      if (key in saved && saved[key] !== current[key]) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function syncImportRecipeUi() {
  const saveBtn = document.getElementById('btn-import-preset-save');
  if (!saveBtn) return;
  const modified = isImportRecipeModified();
  saveBtn.classList.toggle('modified', modified);
  const label = modified
    ? t('Save current settings in the recipe (modified)')
    : t('Save current settings in the recipe');
  saveBtn.title = label;
  saveBtn.setAttribute('aria-label', label);
}

async function selectImportPreset(preset, { apply = true } = {}) {
  selectedImportPreset = preset;
  const input = document.getElementById('import-preset-input');
  if (input) input.value = preset ? preset.name : '';
  if (preset && apply) {
    try {
      await applyImportRecipeConfig(JSON.parse(preset.config));
    } catch (err) {
      console.error('Saved import recipe unreadable:', err);
    }
  }
  syncImportRecipeUi();
}

const IMPORT_SORT_MODES = [
  { key: 'date', order: 'desc', titleKey: 'Date (newest first)' },
  { key: 'date', order: 'asc', titleKey: 'Date (oldest first)' },
  { key: 'name', order: 'asc', titleKey: 'Name (A-Z)' },
  { key: 'name', order: 'desc', titleKey: 'Name (Z-A)' },
];

const SORT_ARROW_UP = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="preview-icon" aria-hidden="true"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>';
const SORT_ARROW_DOWN = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="preview-icon" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>';

function renderImportSortButton() {
  const button = document.getElementById('btn-import-sort');
  if (!button) return;
  const key = readChoice('importSortKey', ['date', 'name']);
  const order = readChoice('importSortOrder', ['asc', 'desc']);
  const prefix = document.createElement('span');
  prefix.className = 'faces-sort-prefix';
  prefix.textContent = labelWithColon('Sort');
  const values = document.createElement('span');
  values.className = 'faces-sort-values';
  for (const [k, label] of [['date', 'Date'], ['name', 'Name noun']]) {
    const option = document.createElement('span');
    option.className = `faces-sort-option${k === key ? ' current' : ''}`;
    option.textContent = t(label);
    values.append(option);
  }
  const caret = document.createElement('span');
  caret.className = 'import-sort-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '▾';
  button.innerHTML = order === 'asc' ? SORT_ARROW_UP : SORT_ARROW_DOWN;
  button.append(prefix, values, caret);
  const viewMode = readChoice('importViewMode', ['list', 'thumbnails']);
  button.classList.toggle('overridden', viewMode === 'list' && importListSort.length > 0);
  const mode = IMPORT_SORT_MODES.find(m => m.key === key && m.order === order) ?? IMPORT_SORT_MODES[0];
  button.title = t(mode.titleKey);
}

function renderImportListHeader() {
  const header = document.getElementById('import-list-header');
  if (!header) return;
  const viewMode = readChoice('importViewMode', ['list', 'thumbnails']);
  header.hidden = viewMode !== 'list';
  if (header.hidden) return;
  const sortMap = new Map(importListSort.map((e, idx) => [e.col, { dir: e.dir, level: idx + 1 }]));
  const showLevel = importListSort.length >= 2;
  const cells = IMPORT_LIST_COLUMNS.map(col => {
    const cell = document.createElement('div');
    cell.className = `import-col-header ${col.className}`;
    cell.setAttribute('role', 'columnheader');
    cell.title = t('Click to sort, Ctrl+Click to add a sort level (up to 9)');
    const title = document.createElement('span');
    title.className = 'list-col-title';
    title.textContent = col.literalLabel ?? t(col.labelKey);
    cell.append(title);
    const info = sortMap.get(col.id);
    if (info) {
      cell.classList.add('sorted');
      cell.setAttribute('aria-sort', info.dir === 'asc' ? 'ascending' : 'descending');
      const badge = document.createElement('span');
      badge.className = 'list-sort-badge';
      badge.textContent = formatSortBadge(info.dir, info.level, showLevel);
      cell.append(badge);
    } else {
      cell.setAttribute('aria-sort', 'none');
    }
    cell.addEventListener('click', e => {
      importListSort = cycleMultiColumnSort(importListSort, col.id, e.ctrlKey || e.metaKey);
      saveImportListSort();
      renderImportListHeader();
      renderImportSortButton();
      applyImportFilters();
    });
    return cell;
  });
  header.replaceChildren(...cells);
}

async function refreshImportPresetsDropdown() {
  importPresets = await invoke('list_import_presets').catch(() => []);
  if (selectedImportPreset) {
    selectedImportPreset = importPresets.find(p => p.id === selectedImportPreset.id) ?? null;
  }
  syncImportRecipeUi();
}

function openImportRecipesModal() {
  const modal = createModal({
    title: t('Import recipes'),
    cardClass: 'rights-presets-card',
    focusSelector: 'button:not([disabled]), input:not([disabled])',
  });
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'keyword-input';
  nameInput.maxLength = 100;
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameInput.placeholder = t('Type a new recipe name and hit Enter');
  nameInput.setAttribute('aria-label', t('Recipe name'));
  const errorLine = document.createElement('p');
  errorLine.className = 'keyword-dialog-error';
  errorLine.setAttribute('role', 'alert');
  const listEl = document.createElement('ul');
  listEl.className = 'rights-preset-list';
  const emptyLine = document.createElement('p');
  emptyLine.className = 'sort-note';
  emptyLine.textContent = t('No saved recipe');
  modal.body.append(nameInput, errorLine, listEl, emptyLine);

  function renderList() {
    emptyLine.hidden = importPresets.length > 0;
    listEl.replaceChildren(...importPresets.map(preset => {
      const row = document.createElement('li');
      row.className = 'rights-preset-item';
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.className = 'rights-preset-name';
      choose.textContent = preset.name;
      choose.title = preset.name;
      choose.addEventListener('click', () => { modal.close(); selectImportPreset(preset); });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-danger';
      remove.textContent = t('Delete');
      remove.title = t('Delete recipe');
      remove.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: t('Delete recipe'),
          message: t('Delete the recipe “{name}”?', { name: preset.name }),
          confirmLabel: t('Delete'),
          cancelLabel: t('Cancel'),
        });
        if (!ok) return;
        importPresets = await invoke('delete_import_preset', { id: preset.id }).catch(() => importPresets);
        if (selectedImportPreset?.id === preset.id) {
          await selectImportPreset(null, { apply: false });
        }
        renderList();
      });
      row.append(choose, remove);
      return row;
    }));
  }

  nameInput.addEventListener('input', () => { errorLine.textContent = ''; });
  nameInput.addEventListener('keydown', async event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    try {
      importPresets = await invoke('save_import_preset', {
        name,
        config: JSON.stringify(collectImportRecipeConfig()),
      });
      const saved = importPresets.find(p => p.name.toLowerCase() === name.toLowerCase()) ?? null;
      modal.close();
      await selectImportPreset(saved, { apply: false });
      host.showToast?.(t('Recipe “{name}” saved', { name: saved?.name ?? name }));
    } catch (error) {
      const code = String(error);
      if (code.includes('empty_name')) errorLine.textContent = t('Enter a name for the recipe');
      else if (code.includes('name_too_long')) errorLine.textContent = t('The name of the recipe is too long');
      else errorLine.textContent = t('The recipe could not be saved');
    }
  });
  renderList();
  nameInput.focus();
}

async function refreshRenamePresetsDropdown() {
  const select = document.getElementById('import-post-rename-preset');
  if (!select) return;
  const presets = await invoke('list_rename_presets').catch(() => []);
  select.innerHTML = '';
  for (const p of presets) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    select.append(opt);
  }
  const saved = readStored('importPostRenamePreset') ?? '';
  if (saved && presets.some(p => p.name === saved)) {
    select.value = saved;
  } else if (presets.length > 0) {
    select.value = presets[0].name;
    writeStored('importPostRenamePreset', presets[0].name);
  }
  select.hidden = !readBool('importPostRename') || presets.length === 0;
}

function updatePostTasksVisibility() {
  const facesRow = document.getElementById('import-post-faces-row');
  if (facesRow) facesRow.hidden = !host.isFaceDetectionEnabled?.();
  const semRow = document.getElementById('import-post-semantic-row');
  if (semRow) semRow.hidden = !host.isSemanticEnabled?.();
  const summary = document.getElementById('import-post-tasks-summary');
  if (summary) {
    const count = [
      readBool('importPostRename'),
      readBool('importPostIntegrity'),
      readBool('importPostFaces') && host.isFaceDetectionEnabled?.(),
      readBool('importPostHashes'),
      readBool('importPostSemantic') && host.isSemanticEnabled?.(),
    ].filter(Boolean).length;
    summary.textContent = count > 0 ? tp('{count} active', count) : t('None');
  }
}

export function initImportView(deps) {
  host = deps;
  importListSort = loadImportListSort();

  dateControl = createDateFilterControl({
    input: document.getElementById('import-date-input'),
    calendarBtn: document.getElementById('import-date-calendar'),
    clearBtn: document.getElementById('import-date-clear'),
    errorEl: document.getElementById('import-date-error'),
    getReferenceDateKey: () => {
      const last = allFiles[0] ? fileTimeKey(allFiles[0]) : 0;
      return last ? Math.floor(last / 1000000) : null;
    },
    onChange: () => applyImportFilters(),
  });

  document.getElementById('btn-import-close')?.addEventListener('click', closeImportView);
  document.getElementById('btn-import-eject')?.addEventListener('click', async () => {
    if (!currentSource?.ejectable) return;
    try {
      await invoke('eject_media', { rootPath: currentSource.rootPath });
      host.showToast?.(t('Media ejected safely'));
      closeImportView();
      await refreshDetectedMedia();
    } catch (err) {
      host.showToast?.(t('Eject failed: {error}', { error: err }));
    }
  });

  document.getElementById('import-source-select')?.addEventListener('change', e => loadSource(e.target.value));
  document.getElementById('btn-import-refresh-source')?.addEventListener('click', () => loadSource(currentSource?.rootPath));
  document.getElementById('btn-import-browse-source')?.addEventListener('click', async () => {
    const picked = await open({ directory: true, multiple: false, title: t('Choose import source folder') });
    if (typeof picked === 'string' && picked) await loadSource(picked);
  });

  const subCheck = document.getElementById('import-include-subfolders');
  if (subCheck) {
    subCheck.checked = readBool('importIncludeSubfolders');
    subCheck.addEventListener('change', () => { writeStored('importIncludeSubfolders', subCheck.checked); applyImportFilters(); });
  }
  const hideEmptyBtn = document.getElementById('btn-import-hide-empty');
  if (hideEmptyBtn) {
    hideEmptyBtn.setAttribute('aria-pressed', String(readBool('importHideEmptyFolders')));
    hideEmptyBtn.addEventListener('click', () => {
      const next = !readBool('importHideEmptyFolders');
      writeStored('importHideEmptyFolders', next);
      hideEmptyBtn.setAttribute('aria-pressed', String(next));
      renderFolderTree();
    });
  }
  document.getElementById('import-folders-head')?.addEventListener('contextmenu', openFolderTreeContextMenu);
  const autoSelCheck = document.getElementById('import-autoselect-new');
  if (autoSelCheck) {
    autoSelCheck.checked = readBool('importAutoSelectNew');
    autoSelCheck.addEventListener('change', () => writeStored('importAutoSelectNew', autoSelCheck.checked));
  }

  for (const chip of document.querySelectorAll('.import-type-chip')) {
    chip.addEventListener('click', () => {
      const kind = chip.dataset.kind;
      if (activeKinds.has(kind)) activeKinds.delete(kind);
      else activeKinds.add(kind);
      const on = activeKinds.has(kind);
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', String(on));
      applyImportFilters();
    });
  }

  document.getElementById('btn-import-recall-date')?.addEventListener('click', () => {
    if (currentSource?.lastImportedFileDt) dateControl.setValue(`${currentSource.lastImportedFileDt}-99991231235959`);
  });

  document.getElementById('btn-import-select-new')?.addEventListener('click', () => {
    selectedPaths.clear();
    for (const f of filteredFiles) if (f.status === 'new') selectedPaths.add(f.path);
    syncSelectionAndActiveClasses();
    updateSummaryFooter();
  });
  document.getElementById('btn-import-select-recent')?.addEventListener('click', () => {
    const range = recentImportRange();
    if (!range) return;
    selectedPaths.clear();
    for (const f of filteredFiles) {
      const tk = fileTimeKey(f);
      if (tk >= range.from && tk <= range.to) selectedPaths.add(f.path);
    }
    syncSelectionAndActiveClasses();
    updateSummaryFooter();
  });
  document.getElementById('btn-import-select-all')?.addEventListener('click', () => {
    for (const f of filteredFiles) selectedPaths.add(f.path);
    syncSelectionAndActiveClasses();
    updateSummaryFooter();
  });
  document.getElementById('btn-import-select-none')?.addEventListener('click', () => {
    selectedPaths.clear();
    syncSelectionAndActiveClasses();
    updateSummaryFooter();
  });

  renderImportSortButton();
  renderImportListHeader();
  onLanguageChange(() => {
    renderImportSortButton();
    renderImportListHeader();
  });
  document.getElementById('btn-import-sort')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-import-sort');
    if (!btn) return;
    const key = readChoice('importSortKey', ['date', 'name']);
    const order = readChoice('importSortOrder', ['asc', 'desc']);
    const rect = btn.getBoundingClientRect();
    openContextMenuAt(
      { clientX: rect.left, clientY: rect.bottom + 2 },
      IMPORT_SORT_MODES.map(mode => ({
        label: t(mode.titleKey),
        checked: importListSort.length === 0 && mode.key === key && mode.order === order,
        onSelect: () => {
          importListSort = [];
          saveImportListSort();
          writeStored('importSortKey', mode.key);
          writeStored('importSortOrder', mode.order);
          renderImportSortButton();
          renderImportListHeader();
          applyImportFilters();
        },
      })),
    );
  });
  document.getElementById('import-list-header')?.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
    openContextMenuAt(event, [{
      label: t('Clear sort'),
      disabled: importListSort.length === 0,
      onSelect: () => {
        importListSort = [];
        saveImportListSort();
        renderImportListHeader();
        renderImportSortButton();
        applyImportFilters();
      },
    }]);
  });
  const groupSel = document.getElementById('import-group-select');
  if (groupSel) {
    groupSel.value = readChoice('importGroupBy', ['none', 'day', 'month', 'folder']);
    groupSel.addEventListener('change', () => {
      writeStored('importGroupBy', groupSel.value);
      rebuildLayout();
      renderVisibleViewport();
    });
  }

  const syncViewControls = () => {
    const mode = readChoice('importViewMode', ['list', 'thumbnails']);
    document.getElementById('btn-import-view-list')?.classList.toggle('active', mode === 'list');
    document.getElementById('btn-import-view-grid')?.classList.toggle('active', mode === 'thumbnails');
    const layoutEl = document.getElementById('import-layout-select');
    const sizeEl = document.getElementById('import-thumb-size');
    if (layoutEl) layoutEl.hidden = mode !== 'thumbnails';
    if (sizeEl) sizeEl.hidden = mode !== 'thumbnails';
  };
  syncViewControls();
  document.getElementById('btn-import-view-list')?.addEventListener('click', () => {
    writeStored('importViewMode', 'list');
    syncViewControls();
    renderImportListHeader();
    renderImportSortButton();
    applyImportFilters();
  });
  document.getElementById('btn-import-view-grid')?.addEventListener('click', () => {
    writeStored('importViewMode', 'thumbnails');
    syncViewControls();
    renderImportListHeader();
    renderImportSortButton();
    applyImportFilters();
  });

  const layoutSel = document.getElementById('import-layout-select');
  if (layoutSel) {
    layoutSel.value = readChoice('importThumbnailLayout', ['square', 'framed']);
    layoutSel.addEventListener('change', () => { writeStored('importThumbnailLayout', layoutSel.value); renderVisibleViewport(); });
  }
  const sizeSlider = document.getElementById('import-thumb-size');
  if (sizeSlider) {
    sizeSlider.value = String(readNumber('importThumbnailSize', IMPORT_THUMB_MIN, IMPORT_THUMB_MAX));
    sizeSlider.addEventListener('input', () => { writeStored('importThumbnailSize', sizeSlider.value); rebuildLayout(); renderVisibleViewport(); });
  }

  const previewBtn = document.getElementById('btn-import-preview-toggle');
  if (previewBtn) {
    previewBtn.classList.toggle('active', readBool('importShowPreview'));
    previewBtn.addEventListener('click', () => {
      const next = !readBool('importShowPreview');
      writeStored('importShowPreview', next);
      previewBtn.classList.toggle('active', next);
      updatePreviewPane(filteredFiles.find(f => f.path === activePath) ?? null);
    });
  }

  document.getElementById('import-files-scroll')?.addEventListener('scroll', renderVisibleViewport);
  window.addEventListener('resize', () => { if (openState) { rebuildLayout(); renderVisibleViewport(); } });

  document.getElementById('btn-import-pick-dest')?.addEventListener('click', async () => {
    const picked = await open({ directory: true, multiple: false, defaultPath: destInfo.valid ? destInfo.resolvedPath : undefined, title: t('Choose destination folder in library') });
    if (typeof picked === 'string' && picked) {
      const check = await invoke('check_destination_info', { path: picked });
      if (!check.valid) {
        host.showToast?.(t('Destination must be inside a tracked library folder.'));
        return;
      }
      await setDestination(check.resolvedPath);
    }
  });
  document.getElementById('btn-import-new-subfolder')?.addEventListener('click', async () => {
    if (!destInfo.valid) return;
    const parentPath = destInfo.resolvedPath;
    const folderLabel = parentPath.split(/[\\/]/).filter(Boolean).pop() || parentPath;
    await promptDialog({
      title: t('New subfolder'),
      message: t('Name of the new subfolder in {folder}', { folder: folderLabel }),
      inputLabel: t('Subfolder name'),
      confirmLabel: t('Create'),
      cancelLabel: t('Cancel'),
      onSubmit: async name => {
        try {
          await invoke('create_subfolder', { parent: parentPath, name });
        } catch (err) {
          return String(err);
        }
        const sep = parentPath.includes('\\') ? '\\' : '/';
        await setDestination(`${parentPath}${sep}${name.trim()}`);
        return null;
      },
    });
  });

  document.getElementById('btn-import-recent')?.addEventListener('click', e => {
    const recents = readJsonList('importRecentDestinations');
    const items = recents.length ? recents.map(p => ({ label: p, onSelect: () => setDestination(p) })) : [{ label: t('No recent destinations'), disabled: true }];
    openContextMenuAt(e, items);
  });
  document.getElementById('btn-import-favorites')?.addEventListener('click', e => {
    const favs = readJsonList('importFavoriteDestinations');
    const items = favs.length ? favs.map(p => ({ label: p, onSelect: () => setDestination(p) })) : [{ label: t('No favorite destinations'), disabled: true }];
    openContextMenuAt(e, items);
  });
  document.getElementById('btn-import-add-fav')?.addEventListener('click', addFavoriteDestination);

  const subModeSel = document.getElementById('import-subfolder-mode');
  if (subModeSel) {
    subModeSel.value = readChoice('importSubfolderMode', IMPORT_SUBFOLDER_MODES);
    subModeSel.addEventListener('change', () => { writeStored('importSubfolderMode', subModeSel.value); updateTargetPreview(); syncImportRecipeUi(); });
  }
  const customSub = document.getElementById('import-custom-subfolder');
  if (customSub) {
    customSub.value = readStored('importCustomSubfolder') ?? '';
    customSub.addEventListener('input', () => { writeStored('importCustomSubfolder', customSub.value); updateTargetPreview(); syncImportRecipeUi(); });
  }
  const splitCheck = document.getElementById('import-split-by-type');
  if (splitCheck) {
    splitCheck.checked = readBool('importSplitByType');
    splitCheck.addEventListener('change', () => { writeStored('importSplitByType', splitCheck.checked); updateTargetPreview(); syncImportRecipeUi(); });
  }
  for (const [id, key] of [
    ['import-subfolder-raw', 'importSubfolderRaw'],
    ['import-subfolder-raster', 'importSubfolderRaster'],
    ['import-subfolder-video', 'importSubfolderVideo'],
  ]) {
    const el = document.getElementById(id);
    if (el) {
      el.value = readStored(key) ?? DEFAULTS[key];
      el.addEventListener('input', () => { writeStored(key, el.value); updateTargetPreview(); syncImportRecipeUi(); });
    }
  }

  const colSel = document.getElementById('import-collision-policy');
  if (colSel) {
    colSel.value = readChoice('importCollisionPolicy', ['skip', 'rename', 'ask']);
    colSel.addEventListener('change', () => { writeStored('importCollisionPolicy', colSel.value); syncImportRecipeUi(); });
  }

  for (const [id, key] of [
    ['import-post-rename', 'importPostRename'],
    ['import-post-integrity', 'importPostIntegrity'],
    ['import-post-faces', 'importPostFaces'],
    ['import-post-hashes', 'importPostHashes'],
    ['import-post-semantic', 'importPostSemantic'],
  ]) {
    const el = document.getElementById(id);
    if (el) {
      el.checked = readBool(key);
      el.addEventListener('change', () => {
        writeStored(key, el.checked);
        if (key === 'importPostRename') refreshRenamePresetsDropdown();
        updatePostTasksVisibility();
        syncImportRecipeUi();
      });
    }
  }
  const presetSel = document.getElementById('import-post-rename-preset');
  presetSel?.addEventListener('change', () => { writeStored('importPostRenamePreset', presetSel.value); syncImportRecipeUi(); });

  const recipeInput = document.getElementById('import-preset-input');
  const recipeList = document.getElementById('import-preset-suggestions');
  if (recipeInput && recipeList) {
    importPresetSuggest = createFilterSuggest({
      input: recipeInput,
      list: recipeList,
      getOptions: () => importPresets.map(p => ({
        value: p.id,
        label: p.name,
        count: 0,
        hideCount: true,
        search: normalizeSearch(p.name),
      })),
      onPick: (id, _exclude, text) => {
        const preset = id === null
          ? importPresets.find(p => normalizeSearch(p.name) === normalizeSearch(text))
          : importPresets.find(p => p.id === id);
        if (preset) selectImportPreset(preset);
        else recipeInput.value = text;
      },
      emptyText: 'No matching recipe',
    });
    recipeInput.addEventListener('input', () => {
      if (selectedImportPreset && recipeInput.value !== selectedImportPreset.name) {
        selectedImportPreset = null;
        syncImportRecipeUi();
      }
    });
  }

  document.getElementById('btn-import-presets-manage')?.addEventListener('click', openImportRecipesModal);

  document.getElementById('btn-import-preset-save')?.addEventListener('click', async () => {
    const cfg = JSON.stringify(collectImportRecipeConfig());
    if (selectedImportPreset) {
      const ok = await confirmDialog({
        title: t('Save recipe'),
        message: t('Replace the recipe “{name}” with the current settings?', { name: selectedImportPreset.name }),
        confirmLabel: t('Save'),
        cancelLabel: t('Cancel'),
      });
      if (!ok) return;
      try {
        importPresets = await invoke('save_import_preset', { name: selectedImportPreset.name, config: cfg });
        const updated = importPresets.find(p => p.id === selectedImportPreset.id) ?? selectedImportPreset;
        await selectImportPreset(updated, { apply: false });
        host.showToast?.(t('Recipe “{name}” saved', { name: updated.name }));
      } catch (err) {
        host.showToast?.(String(err));
      }
      return;
    }
    const typed = recipeInput?.value.trim() ?? '';
    promptDialog({
      title: t('Save recipe'),
      message: t('Name of the recipe (an existing recipe with the same name is replaced)'),
      inputLabel: t('Recipe name'),
      confirmLabel: t('Save'),
      cancelLabel: t('Cancel'),
      value: typed,
      onSubmit: async name => {
        try {
          importPresets = await invoke('save_import_preset', { name, config: cfg });
        } catch (error) {
          const code = String(error);
          if (code.includes('empty_name')) return t('Enter a name for the recipe');
          if (code.includes('name_too_long')) return t('The name of the recipe is too long');
          return t('The recipe could not be saved');
        }
        const saved = importPresets.find(p => p.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
        await selectImportPreset(saved, { apply: false });
        host.showToast?.(t('Recipe “{name}” saved', { name: saved?.name ?? name.trim() }));
        return null;
      },
    });
  });

  document.getElementById('btn-import-start')?.addEventListener('click', startImport);

  // Pass 2 incremental EXIF updates (Option B: update mounted rows in place, re-sort only on completion)
  listen('import-exif-progress', event => {
    const payload = event.payload || {};
    if (!openState || payload.taskId !== currentExifTaskId) return;
    let selectionChanged = false;
    for (const entry of payload.entries || []) {
      const f = filesByPath.get(entry.path);
      if (!f) continue;
      if (entry.dateTaken) f.dateTaken = entry.dateTaken;
      if (entry.orientation) f.orientation = entry.orientation;
      const statusUpdated = Boolean(entry.status) && f.status !== 'imported_memory';
      if (statusUpdated) {
        f.status = entry.status;
        f.existingPath = entry.existingPath;
        if (readBool('importAutoSelectNew') && entry.status !== 'new' && selectedPaths.delete(f.path)) {
          selectionChanged = true;
        }
      }
      const node = renderedNodes.get(f.path);
      if (node) syncItemNodeState(node, f);
    }
    if (selectionChanged) {
      syncSelectionAndActiveClasses();
      updateSummaryFooter();
    }
    const statusEl = document.getElementById('import-exif-status');
    if (statusEl && payload.total > 0) {
      statusEl.textContent = t('Reading EXIF ({done}/{total})', { done: payload.done, total: payload.total });
    }
    if (payload.total > 0 && payload.done >= payload.total) {
      applyImportFilters();
    }
  }).catch(() => {});

  const wireImportResizer = ({ resizerId, panelSelector, cssVar, storageKey, direction, maxVwRatio }) => {
    const resizer = document.getElementById(resizerId);
    const panel = document.querySelector(panelSelector);
    const view = document.getElementById('import-view');
    if (!resizer || !panel || !view) return;
    const saved = Number(readStored(storageKey));
    if (Number.isFinite(saved) && saved > 0) {
      view.style.setProperty(cssVar, `${saved}px`);
    }
    let rafId = 0;
    const scheduleReflow = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (openState) {
          rebuildLayout();
          renderVisibleViewport();
        }
      });
    };
    resizer.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      resizer.classList.add('dragging');
      const startX = e.clientX;
      const startWidth = panel.getBoundingClientRect().width;
      const cs = getComputedStyle(panel);
      const minW = parseFloat(cs.minWidth) || 200;
      const cssMaxW = parseFloat(cs.maxWidth);
      const ratioMax = window.innerWidth * maxVwRatio;
      const maxW = Number.isFinite(cssMaxW) ? Math.min(cssMaxW, ratioMax) : ratioMax;

      const onMove = ev => {
        const delta = (ev.clientX - startX) * direction;
        const scrollEl = document.getElementById('import-files-scroll');
        const currentScrollW = scrollEl ? scrollEl.getBoundingClientRect().width : 400;
        const maxAllowedByCenter = startWidth + Math.max(0, currentScrollW - 200);
        const nextW = Math.round(Math.max(minW, Math.min(maxW, maxAllowedByCenter, startWidth + delta)));
        view.style.setProperty(cssVar, `${nextW}px`);
        scheduleReflow();
      };
      const onEnd = () => {
        resizer.classList.remove('dragging');
        resizer.removeEventListener('pointermove', onMove);
        resizer.removeEventListener('pointerup', onEnd);
        resizer.removeEventListener('pointercancel', onEnd);
        const finalW = Math.round(panel.getBoundingClientRect().width);
        if (finalW > 0) writeStored(storageKey, finalW);
      };
      resizer.addEventListener('pointermove', onMove);
      resizer.addEventListener('pointerup', onEnd);
      resizer.addEventListener('pointercancel', onEnd);
    });
  };

  wireImportResizer({
    resizerId: 'import-sidebar-resizer',
    panelSelector: '.import-sidebar',
    cssVar: '--import-sidebar-width',
    storageKey: 'importSidebarWidth',
    direction: 1,
    maxVwRatio: 0.35,
  });
  wireImportResizer({
    resizerId: 'import-dest-resizer',
    panelSelector: '.import-dest-panel',
    cssVar: '--import-dest-width',
    storageKey: 'importDestWidth',
    direction: -1,
    maxVwRatio: 0.35,
  });
  wireImportResizer({
    resizerId: 'import-preview-resizer',
    panelSelector: '#import-preview-pane',
    cssVar: '--import-preview-width',
    storageKey: 'importPreviewWidth',
    direction: -1,
    maxVwRatio: 0.4,
  });

  window.addEventListener('keydown', event => {
    if (!openState || event.key !== 'Escape') return;
    if (
      document.querySelector('.modal:not(.hidden), .context-menu')
      || [...document.querySelectorAll('.date-picker')].some(el => el.style.display !== 'none')
    ) {
      return;
    }
    event.preventDefault();
    closeImportView();
  }, true);
}
