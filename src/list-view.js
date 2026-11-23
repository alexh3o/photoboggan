// List panel (toolbar "List" button / L key): virtualized, multi-column sortable, customizable table of the displayed photos.
// Shares `photos`, `selectedIndices`, `lastSelectedIndex`, and context menus with the grid. Zero work runs while the panel is closed.

import './list-view.css';
import { invoke } from '@tauri-apps/api/core';
import { t, onLanguageChange } from './i18n.js';
import { DEFAULTS, readStored, writeStored } from './settings-defaults.js';
import { extensionOf, RAW_EXTENSIONS, VIDEO_EXTENSIONS } from './format-filters.js';
import { isRawPath, isVideoPath } from './file-kinds.js';
import { photoTimeKey } from './date-filter.js';
import { shotValues } from './shooting-filters.js';
import { isColorEnabled, isPickEnabled, onMarkingSettingsChange } from './marking-settings.js';
import { isSemanticEnabled, onSemanticChange, onAnalysisChanged } from './semantic-settings.js';
import { isFaceDetectionEnabled, getFaceCounts, getFaceScanIndex, isFaceScanRawEnabled } from './faces-panel.js';
import { onPhashChanged } from './duplicates-view.js';

const STORAGE_KEYS = {
  visible: 'listVisibleColumns',
  order: 'listColumnOrder',
  widths: 'listColumnWidths',
  sort: 'listSort',
};

const ROW_HEIGHT = 26; // px — matches CSS .list-row height for pixel-exact virtual scrolling
const OVERSCAN_ROWS = 15;
const MIN_COL_WIDTH = 48;
const MAX_COL_WIDTH = 800;
const MAX_SORT_LEVELS = 9;
const HEADER_DRAG_THRESHOLD = 5;

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

let host = null;
let open = false;
let initialized = false;

let panel, toggleButton, columnsButton, clearSortButton, scrollContainer, tableElement, headerElement, bodyElement, emptyMessage;

// Auxiliary status sets loaded lazily ONLY when the List panel is open and the corresponding column is visible.
let analysedIds = new Set();
let analysedLoaded = false;
let analysedToken = 0;

let phashIds = new Set();
let phashLoaded = false;
let phashToken = 0;

// Virtual list & sort state
let lastPhotosRef = null;
let visualToGrid = [];
let gridToVisual = new Int32Array(0);
let dataVersion = 0;
let columnsVersion = 0;
let renderedRows = new Map(); // visualIndex -> row DOM node
let freeRowPool = [];
let scrollFrame = 0;
let suppressNextAutoScroll = false;
let anchorVisualIndex = 0;

// Column picker popup state
let columnsMenu = null;
let menuCleanup = null;

// Header drag / resize interaction state
let activeDrag = null;

// ---------------------------------------------------------------------------
// Column definitions & persistence
// ---------------------------------------------------------------------------

function rawFilename(photo) {
  return photo.filename || photo.path.split(/[\\/]/).pop() || '';
}

function displayFilename(photo) {
  const full = rawFilename(photo);
  if (!visibleColumns.has('extension')) return full;
  const dot = full.lastIndexOf('.');
  return dot > 0 ? full.slice(0, dot) : full;
}

function facesStatusInfo(photo) {
  if (isVideoPath(photo.path)) return { text: '-', sort: null, muted: true };
  const review = getFaceScanIndex().get(photo.id);
  if (review === true) return { text: '?', sort: null, muted: true };
  const count = getFaceCounts().get(photo.id) ?? 0;
  // Unscanned photos that already carry XMP face regions are treated as scanned with that face count.
  if (count > 0) return { text: String(count), sort: count, muted: false };
  if (review === false) return { text: '0', sort: 0, muted: true };
  if (isRawPath(photo.path) && !isFaceScanRawEnabled()) return { text: '-', sort: null, muted: true };
  return { text: '?', sort: null, muted: true };
}

const colorOrderMap = new Map();
const pickOrderMap = new Map([['picked', 1], ['pending', 2], ['rejected', 3]]);

const COLUMN_DEFS = [
  {
    id: 'filename',
    label: 'Filename',
    defaultWidth: 220,
    pinned: true,
    sortType: 'string',
    sortValue: photo => rawFilename(photo) || null,
    render: (cell, photo) => {
      const text = displayFilename(photo);
      cell.textContent = text || '-';
      cell.title = photo.path || text;
    },
  },
  {
    id: 'extension',
    label: 'Extension',
    defaultWidth: 74,
    sortType: 'string',
    sortValue: photo => extensionOf(photo) || null,
    render: (cell, photo) => {
      const ext = extensionOf(photo);
      if (!ext) {
        cell.textContent = '-';
        cell.classList.add('list-cell-muted');
        return;
      }
      const kind = VIDEO_EXTENSIONS.has(ext) ? 'video' : RAW_EXTENSIONS.has(ext) ? 'raw' : 'photo';
      const pill = document.createElement('span');
      pill.className = `list-ext-pill ext-${kind}`;
      pill.textContent = ext.toUpperCase();
      cell.replaceChildren(pill);
    },
  },
  {
    id: 'date_taken',
    label: 'Date taken',
    defaultWidth: 148,
    sortType: 'number',
    sortValue: photo => photoTimeKey(photo),
    render: (cell, photo) => {
      const text = photo.date_taken || '';
      cell.textContent = text || '-';
      cell.classList.toggle('list-cell-muted', !text);
      if (text) cell.title = text;
    },
  },
  {
    id: 'manufacturer',
    label: 'Manufacturer',
    defaultWidth: 115,
    sortType: 'string',
    sortValue: photo => (photo.manufacturer || '').trim() || null,
    render: (cell, photo) => renderPlainText(cell, photo.manufacturer),
  },
  {
    id: 'camera',
    label: 'Camera',
    defaultWidth: 150,
    sortType: 'string',
    sortValue: photo => (photo.camera_model || '').trim() || null,
    render: (cell, photo) => renderPlainText(cell, photo.camera_model),
  },
  {
    id: 'lens',
    label: 'Lens',
    defaultWidth: 175,
    sortType: 'string',
    sortValue: photo => (photo.lens_model || '').trim() || null,
    render: (cell, photo) => renderPlainText(cell, photo.lens_model),
  },
  {
    id: 'author',
    label: 'Author',
    defaultWidth: 130,
    sortType: 'string',
    sortValue: photo => (photo.author || '').trim() || null,
    render: (cell, photo) => renderPlainText(cell, photo.author),
  },
  {
    id: 'aperture',
    label: 'Aperture',
    defaultWidth: 78,
    sortType: 'number',
    sortValue: photo => shotValues(photo).aperture,
    render: (cell, photo) => {
      const text = host.formatAperture(photo.aperture);
      cell.textContent = text;
      cell.classList.toggle('list-cell-muted', text === '-');
    },
  },
  {
    id: 'shutter_speed',
    label: 'Shutter Speed',
    defaultWidth: 94,
    sortType: 'number',
    sortValue: photo => shotValues(photo).shutter,
    render: (cell, photo) => {
      const text = host.formatShutterSpeed(photo.shutter_speed);
      cell.textContent = text;
      cell.classList.toggle('list-cell-muted', text === '-');
    },
  },
  {
    id: 'iso',
    label: 'ISO',
    defaultWidth: 68,
    sortType: 'number',
    sortValue: photo => shotValues(photo).iso,
    render: (cell, photo) => {
      const hasIso = photo.iso > 0;
      cell.textContent = hasIso ? String(photo.iso) : '-';
      cell.classList.toggle('list-cell-muted', !hasIso);
    },
  },
  {
    id: 'focal_length',
    label: 'Focal Length',
    defaultWidth: 88,
    sortType: 'number',
    sortValue: photo => shotValues(photo).focal,
    render: (cell, photo) => renderPlainText(cell, photo.focal_length),
  },
  {
    id: 'flash',
    label: 'Flash used',
    defaultWidth: 82,
    sortType: 'number',
    sortValue: photo => (photo.flash === true ? 1 : photo.flash === false ? 0 : null),
    render: (cell, photo) => renderBoolean(cell, photo.flash === true ? true : photo.flash === false ? false : null),
  },
  {
    id: 'rating',
    label: 'Rating',
    defaultWidth: 90,
    sortType: 'number',
    sortValue: photo => (photo.rating > 0 ? photo.rating : null),
    render: (cell, photo) => {
      const rating = photo.rating || 0;
      if (rating <= 0) {
        cell.textContent = '-';
        cell.classList.add('list-cell-muted');
        return;
      }
      const stars = document.createElement('span');
      stars.className = 'list-stars';
      stars.textContent = '★'.repeat(rating);
      cell.title = `${rating}/5`;
      cell.replaceChildren(stars);
    },
  },
  {
    id: 'color_flag',
    label: 'Color',
    defaultWidth: 68,
    available: () => isColorEnabled(),
    sortType: 'number',
    sortValue: photo => (photo.color_flag && photo.color_flag !== 'none' ? (colorOrderMap.get(photo.color_flag) ?? 99) : null),
    render: (cell, photo) => {
      const flag = photo.color_flag || 'none';
      if (flag === 'none') {
        cell.textContent = '-';
        cell.classList.add('list-cell-muted');
        return;
      }
      const dot = document.createElement('span');
      dot.className = `flag-indicator flag-${flag}`;
      const label = host.colorFlagLabels.get(flag) || flag;
      dot.title = label;
      cell.title = label;
      cell.replaceChildren(dot);
    },
  },
  {
    id: 'pick_flag',
    label: 'Pick',
    defaultWidth: 64,
    available: () => isPickEnabled(),
    sortType: 'number',
    sortValue: photo => pickOrderMap.get(photo.pick_flag) ?? null,
    render: (cell, photo) => {
      const flag = photo.pick_flag || 'none';
      if (flag === 'none') {
        cell.textContent = '-';
        cell.classList.add('list-cell-muted');
        return;
      }
      const mark = document.createElement('span');
      mark.className = `pick-indicator pick-${flag}`;
      const label = t(host.pickFlags.find(item => item.key === flag)?.label || flag);
      mark.title = label;
      cell.title = label;
      cell.replaceChildren(mark);
    },
  },
  {
    id: 'analysed',
    label: 'Analysed',
    defaultWidth: 82,
    available: () => isSemanticEnabled(),
    sortType: 'number',
    sortValue: photo => (analysedIds.has(photo.id) ? 1 : 0),
    render: (cell, photo) => renderBoolean(cell, analysedIds.has(photo.id)),
  },
  {
    id: 'faces_status',
    label: 'Faces status',
    defaultWidth: 88,
    available: () => isFaceDetectionEnabled(),
    sortType: 'number',
    sortValue: photo => facesStatusInfo(photo).sort,
    render: (cell, photo) => {
      const info = facesStatusInfo(photo);
      cell.textContent = info.text;
      cell.classList.toggle('list-cell-muted', info.muted);
    },
  },
  {
    id: 'geolocated',
    label: 'Geolocated',
    defaultWidth: 92,
    sortType: 'number',
    sortValue: photo => (Number.isFinite(photo.gps_lat) && Number.isFinite(photo.gps_lon) ? 1 : 0),
    render: (cell, photo) => renderBoolean(cell, Number.isFinite(photo.gps_lat) && Number.isFinite(photo.gps_lon)),
  },
  {
    id: 'phash',
    label: 'Similarity hash',
    defaultWidth: 96,
    sortType: 'number',
    sortValue: photo => (phashIds.has(photo.id) ? 1 : 0),
    render: (cell, photo) => renderBoolean(cell, phashIds.has(photo.id)),
  },
];

const COLUMNS_BY_ID = new Map(COLUMN_DEFS.map(col => [col.id, col]));
const VALID_COLUMN_IDS = new Set(COLUMN_DEFS.map(col => col.id));

const MENU_STRUCTURE = [
  { col: 'filename' },
  { col: 'extension' },
  { col: 'date_taken' },
  { label: 'Gear', children: ['manufacturer', 'camera', 'lens'] },
  { col: 'author' },
  { label: 'Shoot settings', children: ['aperture', 'shutter_speed', 'iso', 'focal_length', 'flash'] },
  { label: 'Labels', children: ['rating', 'color_flag', 'pick_flag'] },
  { label: 'Other data', children: ['analysed', 'faces_status', 'geolocated', 'phash'] },
];

function renderPlainText(cell, value) {
  const text = String(value || '').trim();
  cell.textContent = text || '-';
  cell.classList.toggle('list-cell-muted', !text);
  if (text) cell.title = text;
}

function renderBoolean(cell, value) {
  if (value === null) {
    cell.textContent = '-';
    cell.classList.add('list-cell-muted');
    return;
  }
  cell.textContent = t(value ? 'Yes' : 'No');
  cell.classList.toggle('list-cell-yes', value);
  cell.classList.toggle('list-cell-muted', !value);
}

function readJsonStored(key, fallback) {
  const raw = readStored(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadVisibleColumns() {
  const parsed = readJsonStored(STORAGE_KEYS.visible, DEFAULTS.listVisibleColumns);
  const list = Array.isArray(parsed) ? parsed.filter(id => VALID_COLUMN_IDS.has(id)) : DEFAULTS.listVisibleColumns;
  const set = new Set(list);
  set.add('filename'); // always visible
  return set;
}

function loadColumnOrder() {
  const parsed = readJsonStored(STORAGE_KEYS.order, DEFAULTS.listColumnOrder);
  const seen = new Set(['filename']);
  const order = ['filename'];
  if (Array.isArray(parsed)) {
    for (const id of parsed) {
      if (VALID_COLUMN_IDS.has(id) && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }
  for (const col of COLUMN_DEFS) {
    if (!seen.has(col.id)) {
      seen.add(col.id);
      order.push(col.id);
    }
  }
  return order;
}

function loadColumnWidths() {
  const parsed = readJsonStored(STORAGE_KEYS.widths, DEFAULTS.listColumnWidths);
  const widths = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [id, width] of Object.entries(parsed)) {
      if (VALID_COLUMN_IDS.has(id) && Number.isFinite(width)) {
        widths[id] = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(width)));
      }
    }
  }
  return widths;
}

function loadSortState() {
  const parsed = readJsonStored(STORAGE_KEYS.sort, DEFAULTS.listSort);
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  const sort = [];
  for (const entry of parsed) {
    if (!entry || !VALID_COLUMN_IDS.has(entry.col) || seen.has(entry.col)) continue;
    if (entry.dir !== 'asc' && entry.dir !== 'desc') continue;
    seen.add(entry.col);
    sort.push({ col: entry.col, dir: entry.dir });
    if (sort.length >= MAX_SORT_LEVELS) break;
  }
  return sort;
}

let visibleColumns = loadVisibleColumns();
let columnOrder = loadColumnOrder();
let columnWidths = loadColumnWidths();
let sortSpec = loadSortState();

function saveVisibleColumns() {
  writeStored(STORAGE_KEYS.visible, JSON.stringify([...visibleColumns]));
}
function saveColumnOrder() {
  writeStored(STORAGE_KEYS.order, JSON.stringify(columnOrder));
}
function saveColumnWidths() {
  writeStored(STORAGE_KEYS.widths, JSON.stringify(columnWidths));
}
function saveSortState() {
  writeStored(STORAGE_KEYS.sort, JSON.stringify(sortSpec));
}

function isColumnAvailable(col) {
  return col.available ? col.available() : true;
}

function getActiveColumns() {
  return columnOrder
    .map(id => COLUMNS_BY_ID.get(id))
    .filter(col => col && visibleColumns.has(col.id) && isColumnAvailable(col));
}

function getColumnWidth(col) {
  return columnWidths[col.id] ?? col.defaultWidth;
}

function getEffectiveSort(activeCols = getActiveColumns()) {
  const activeIds = new Set(activeCols.map(col => col.id));
  return sortSpec.filter(entry => activeIds.has(entry.col));
}

// ---------------------------------------------------------------------------
// Lazy auxiliary datasets (analysed & phash)
// ---------------------------------------------------------------------------

async function ensureAuxiliaryData() {
  if (!open) return;
  const activeIds = new Set(getActiveColumns().map(col => col.id));

  if (activeIds.has('analysed') && isSemanticEnabled() && !analysedLoaded) {
    const token = ++analysedToken;
    try {
      const ids = await invoke('get_analysed_photo_ids');
      if (token !== analysedToken) return;
      analysedIds = new Set(ids);
      analysedLoaded = true;
      if (open) onAuxiliaryDataUpdated('analysed');
    } catch (error) {
      console.debug('List view: analysed ids unavailable', error);
    }
  }

  if (activeIds.has('phash') && !phashLoaded) {
    const token = ++phashToken;
    try {
      const ids = await invoke('get_phash_photo_ids');
      if (token !== phashToken) return;
      phashIds = new Set(ids);
      phashLoaded = true;
      if (open) onAuxiliaryDataUpdated('phash');
    } catch (error) {
      console.debug('List view: phash ids unavailable', error);
    }
  }
}

function onAuxiliaryDataUpdated(colId) {
  dataVersion++;
  const sortedByIt = getEffectiveSort().some(entry => entry.col === colId);
  if (sortedByIt) rebuildSortOrder();
  renderVisibleRows({ forceRefresh: true });
}

// ---------------------------------------------------------------------------
// Multi-column sorting
// ---------------------------------------------------------------------------

function rebuildSortOrder() {
  const photos = host.getPhotos();
  const count = photos.length;
  const activeCols = getActiveColumns();
  const effectiveSort = getEffectiveSort(activeCols);

  if (count === 0) {
    visualToGrid = [];
    gridToVisual = new Int32Array(0);
    return;
  }

  const order = Array.from({ length: count }, (_, i) => i);
  if (effectiveSort.length > 0) {
    const comparators = effectiveSort.map(entry => ({
      col: COLUMNS_BY_ID.get(entry.col),
      desc: entry.dir === 'desc',
    }));
    order.sort((ia, ib) => {
      const photoA = photos[ia];
      const photoB = photos[ib];
      for (const { col, desc } of comparators) {
        const valA = col.sortValue(photoA);
        const valB = col.sortValue(photoB);
        const missA = valA === null || valA === undefined || valA === '';
        const missB = valB === null || valB === undefined || valB === '';
        if (missA && missB) continue;
        // Missing values always go at the end, regardless of ascending or descending order.
        if (missA) return 1;
        if (missB) return -1;
        const cmp = col.sortType === 'string'
          ? nameCollator.compare(valA, valB)
          : (valA < valB ? -1 : valA > valB ? 1 : 0);
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return ia - ib;
    });
  }

  visualToGrid = order;
  gridToVisual = new Int32Array(count);
  for (let v = 0; v < count; v++) gridToVisual[order[v]] = v;
}

function toggleColumnSort(colId, additive) {
  const effective = getEffectiveSort();
  const existingIndex = sortSpec.findIndex(entry => entry.col === colId);
  if (!additive) {
    if (effective.length === 1 && effective[0].col === colId) {
      sortSpec = effective[0].dir === 'asc' ? [{ col: colId, dir: 'desc' }] : [];
    } else {
      sortSpec = [{ col: colId, dir: 'asc' }];
    }
  } else if (existingIndex >= 0) {
    if (sortSpec[existingIndex].dir === 'asc') {
      sortSpec[existingIndex] = { col: colId, dir: 'desc' };
    } else {
      sortSpec.splice(existingIndex, 1);
    }
  } else {
    if (effective.length >= MAX_SORT_LEVELS) return;
    sortSpec.push({ col: colId, dir: 'asc' });
  }
  saveSortState();
  rebuildSortOrder();
  renderHeader();
  renderVisibleRows({ forceRefresh: true });
  if (host.getSelectedIndices().size > 0) scrollPhotoIntoList(host.getActiveIndex());
}

function clearAllSort() {
  if (sortSpec.length === 0) return;
  sortSpec = [];
  saveSortState();
  rebuildSortOrder();
  renderHeader();
  renderVisibleRows({ forceRefresh: true });
  if (host.getSelectedIndices().size > 0) scrollPhotoIntoList(host.getActiveIndex());
}

// ---------------------------------------------------------------------------
// Table dimensions, header rendering, resize & column drag-and-drop
// ---------------------------------------------------------------------------

function applyColumnWidthVars(activeCols) {
  let totalWidth = 0;
  for (const col of activeCols) {
    const width = getColumnWidth(col);
    tableElement.style.setProperty(`--col-w-${col.id}`, `${width}px`);
    totalWidth += width;
  }
  tableElement.style.setProperty('--list-table-width', `${totalWidth}px`);
}

function renderHeader() {
  if (!open) return;
  const activeCols = getActiveColumns();
  const effectiveSort = getEffectiveSort(activeCols);
  const sortMap = new Map(effectiveSort.map((entry, idx) => [entry.col, { dir: entry.dir, level: idx + 1 }]));
  const showLevelNumber = effectiveSort.length >= 2;

  clearSortButton.hidden = effectiveSort.length === 0;
  applyColumnWidthVars(activeCols);

  const cells = activeCols.map((col, index) => {
    const cell = document.createElement('div');
    cell.className = 'list-col-header';
    cell.dataset.col = col.id;
    cell.dataset.colIndex = String(index);
    cell.style.setProperty('--col-w', `var(--col-w-${col.id})`);
    cell.setAttribute('role', 'columnheader');
    cell.title = t('Click to sort, Ctrl+Click to add a sort level (up to 9). Drag to reorder columns');

    const title = document.createElement('span');
    title.className = 'list-col-title';
    title.textContent = t(col.label);
    cell.append(title);

    const sortInfo = sortMap.get(col.id);
    if (sortInfo) {
      cell.classList.add('sorted');
      cell.setAttribute('aria-sort', sortInfo.dir === 'asc' ? 'ascending' : 'descending');
      const badge = document.createElement('span');
      badge.className = 'list-sort-badge';
      const arrow = sortInfo.dir === 'asc' ? '▲' : '▼';
      badge.textContent = showLevelNumber ? `${arrow}${sortInfo.level}` : arrow;
      cell.append(badge);
    } else {
      cell.setAttribute('aria-sort', 'none');
    }

    const resizer = document.createElement('div');
    resizer.className = 'list-col-resizer';
    resizer.dataset.col = col.id;
    cell.append(resizer);
    return cell;
  });

  headerElement.replaceChildren(...cells);
}

function startColumnResize(resizer, event) {
  event.preventDefault();
  event.stopPropagation();
  const colId = resizer.dataset.col;
  const col = COLUMNS_BY_ID.get(colId);
  if (!col) return;
  const startX = event.clientX;
  const startWidth = getColumnWidth(col);
  resizer.setPointerCapture(event.pointerId);
  resizer.classList.add('dragging');

  const onMove = moveEvent => {
    const width = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(startWidth + (moveEvent.clientX - startX))));
    columnWidths[colId] = width;
    applyColumnWidthVars(getActiveColumns());
  };

  const onEnd = () => {
    resizer.classList.remove('dragging');
    resizer.removeEventListener('pointermove', onMove);
    resizer.removeEventListener('pointerup', onEnd);
    resizer.removeEventListener('pointercancel', onEnd);
    saveColumnWidths();
  };

  resizer.addEventListener('pointermove', onMove);
  resizer.addEventListener('pointerup', onEnd);
  resizer.addEventListener('pointercancel', onEnd);
}

function clearHeaderDropMarkers() {
  for (const el of headerElement.querySelectorAll('.list-col-header')) {
    el.classList.remove('dragging', 'drop-before', 'drop-after');
  }
}

function handleHeaderPointerDown(event) {
  if (event.button !== 0) return;
  const resizer = event.target instanceof Element ? event.target.closest('.list-col-resizer') : null;
  if (resizer) {
    startColumnResize(resizer, event);
    return;
  }
  const headerCell = event.target instanceof Element ? event.target.closest('.list-col-header') : null;
  if (!headerCell) return;

  const colId = headerCell.dataset.col;
  const col = COLUMNS_BY_ID.get(colId);
  if (!col) return;

  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;
  let dropTargetIndex = -1;

  headerCell.setPointerCapture(event.pointerId);

  const computeDropTarget = clientX => {
    const headers = [...headerElement.querySelectorAll('.list-col-header')];
    clearHeaderDropMarkers();
    headerCell.classList.add('dragging');
    // Index 0 (`filename`) is permanently pinned first, so drops always land at index >= 1.
    let targetIdx = headers.length;
    for (let i = 1; i < headers.length; i++) {
      const rect = headers[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx < headers.length) headers[targetIdx].classList.add('drop-before');
    else if (headers.length > 1) headers[headers.length - 1].classList.add('drop-after');
    return targetIdx;
  };

  const onMove = moveEvent => {
    if (!dragging && !col.pinned) {
      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) >= HEADER_DRAG_THRESHOLD) {
        dragging = true;
        activeDrag = colId;
      }
    }
    if (dragging) {
      dropTargetIndex = computeDropTarget(moveEvent.clientX);
    }
  };

  const cleanup = () => {
    headerCell.removeEventListener('pointermove', onMove);
    headerCell.removeEventListener('pointerup', onUp);
    headerCell.removeEventListener('pointercancel', onCancel);
    clearHeaderDropMarkers();
    activeDrag = null;
  };

  const onUp = upEvent => {
    const wasDragging = dragging;
    const finalTarget = dropTargetIndex;
    cleanup();
    if (!wasDragging) {
      toggleColumnSort(colId, upEvent.ctrlKey || upEvent.metaKey);
      return;
    }
    if (finalTarget < 1) return;
    const activeIds = getActiveColumns().map(item => item.id);
    const fromIdx = activeIds.indexOf(colId);
    if (fromIdx < 1) return;
    let insertAt = finalTarget;
    if (insertAt > fromIdx) insertAt--;
    if (insertAt === fromIdx) return;

    // Move colId in columnOrder relative to its adjacent active neighbor while preserving hidden column slots.
    const nextActive = [...activeIds];
    nextActive.splice(fromIdx, 1);
    nextActive.splice(insertAt, 0, colId);

    const nextOrder = columnOrder.filter(id => id !== colId);
    const prevNeighborId = nextActive[insertAt - 1];
    const anchorPos = nextOrder.indexOf(prevNeighborId);
    nextOrder.splice(anchorPos + 1, 0, colId);
    // Guarantee filename stays pinned first.
    columnOrder = ['filename', ...nextOrder.filter(id => id !== 'filename')];
    saveColumnOrder();
    columnsVersion++;
    renderHeader();
    renderVisibleRows({ forceRefresh: true });
  };

  const onCancel = () => cleanup();

  headerCell.addEventListener('pointermove', onMove);
  headerCell.addEventListener('pointerup', onUp);
  headerCell.addEventListener('pointercancel', onCancel);
}

// ---------------------------------------------------------------------------
// Virtualized body rendering
// ---------------------------------------------------------------------------

function buildRowCells(rowEl, activeCols) {
  const cells = [];
  for (const col of activeCols) {
    const cell = document.createElement('div');
    cell.className = 'list-cell';
    cell.dataset.col = col.id;
    cell.style.setProperty('--col-w', `var(--col-w-${col.id})`);
    cell.setAttribute('role', 'gridcell');
    cells.push(cell);
  }
  rowEl.replaceChildren(...cells);
  rowEl._cells = cells;
  rowEl._columnsVersion = columnsVersion;
  rowEl._dataVersion = -1;
  rowEl._photo = null;
}

function updateRowContent(rowEl, photo, activeCols) {
  if (rowEl._columnsVersion !== columnsVersion) buildRowCells(rowEl, activeCols);
  if (rowEl._photo === photo && rowEl._dataVersion === dataVersion) return;
  const cells = rowEl._cells;
  for (let c = 0; c < activeCols.length; c++) {
    const cell = cells[c];
    cell.className = 'list-cell';
    cell.removeAttribute('title');
    activeCols[c].render(cell, photo);
  }
  rowEl._photo = photo;
  rowEl._dataVersion = dataVersion;
}

function releaseAllRows() {
  for (const row of renderedRows.values()) {
    row.remove();
    freeRowPool.push(row);
  }
  renderedRows.clear();
}

function renderVisibleRows({ forceRefresh = false } = {}) {
  if (!open) return;
  const photos = host.getPhotos();
  const total = visualToGrid.length;
  bodyElement.style.height = `${total * ROW_HEIGHT}px`;
  emptyMessage.hidden = total > 0;

  if (total === 0) {
    releaseAllRows();
    return;
  }

  const viewHeight = scrollContainer.clientHeight || 300;
  const scrollTop = scrollContainer.scrollTop;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const last = Math.min(total - 1, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN_ROWS);

  for (const [visIdx, rowEl] of renderedRows) {
    if (visIdx < first || visIdx > last || forceRefresh) {
      rowEl.remove();
      freeRowPool.push(rowEl);
      renderedRows.delete(visIdx);
    }
  }

  const activeCols = getActiveColumns();
  const selected = host.getSelectedIndices();
  const activeGridIndex = host.getActiveIndex();
  const fragment = document.createDocumentFragment();

  for (let visIdx = first; visIdx <= last; visIdx++) {
    const gridIndex = visualToGrid[visIdx];
    const photo = photos[gridIndex];
    if (!photo) continue;

    let rowEl = renderedRows.get(visIdx);
    if (!rowEl) {
      rowEl = freeRowPool.pop();
      if (!rowEl) {
        rowEl = document.createElement('div');
        rowEl.className = 'list-row';
        rowEl.setAttribute('role', 'row');
        rowEl._transform = '';
        rowEl._selected = false;
        rowEl._active = false;
        rowEl._columnsVersion = -1;
      }
      renderedRows.set(visIdx, rowEl);
      fragment.append(rowEl);
    }

    const transform = `translate3d(0, ${visIdx * ROW_HEIGHT}px, 0)`;
    if (rowEl._transform !== transform) {
      rowEl.style.transform = transform;
      rowEl._transform = transform;
    }
    if (rowEl._gridIndex !== gridIndex) {
      rowEl.dataset.index = String(gridIndex);
      rowEl._gridIndex = gridIndex;
    }
    if (rowEl._visualIndex !== visIdx) {
      rowEl.dataset.visualIndex = String(visIdx);
      rowEl._visualIndex = visIdx;
    }

    updateRowContent(rowEl, photo, activeCols);

    const isSelected = selected.has(gridIndex);
    if (rowEl._selected !== isSelected) {
      rowEl.classList.toggle('selected', isSelected);
      rowEl._selected = isSelected;
    }
    const isActive = isSelected && gridIndex === activeGridIndex;
    if (rowEl._active !== isActive) {
      rowEl.classList.toggle('active', isActive);
      rowEl._active = isActive;
    }
  }

  if (fragment.childNodes.length > 0) bodyElement.append(fragment);
}

function scheduleScrollRender() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    renderVisibleRows();
  });
}

function scrollPhotoIntoList(gridIndex) {
  if (!open || gridIndex < 0 || gridIndex >= gridToVisual.length) return;
  const visIdx = gridToVisual[gridIndex];
  if (visIdx === undefined) return;
  const top = visIdx * ROW_HEIGHT;
  const bottom = top + ROW_HEIGHT;
  const headerHeight = headerElement.offsetHeight || ROW_HEIGHT;
  const viewTop = scrollContainer.scrollTop;
  const viewBottom = viewTop + scrollContainer.clientHeight - headerHeight;
  if (top < viewTop) {
    scrollContainer.scrollTop = Math.max(0, top);
  } else if (bottom > viewBottom) {
    scrollContainer.scrollTop = Math.max(0, bottom - (scrollContainer.clientHeight - headerHeight));
  }
}

// ---------------------------------------------------------------------------
// Selection & double-click in rows
// ---------------------------------------------------------------------------

function handleRowClick(event) {
  const rowEl = event.target instanceof Element ? event.target.closest('.list-row') : null;
  if (!rowEl) return;
  const visualIndex = Number(rowEl.dataset.visualIndex);
  const gridIndex = Number(rowEl.dataset.index);
  if (!Number.isFinite(visualIndex) || !Number.isFinite(gridIndex)) return;

  const selected = host.getSelectedIndices();
  let nextActive = gridIndex;

  if (event.shiftKey) {
    const currentActive = host.getActiveIndex();
    const anchor = visualToGrid[anchorVisualIndex] === currentActive
      ? anchorVisualIndex
      : (gridToVisual[currentActive] ?? visualIndex);
    const start = Math.min(anchor, visualIndex);
    const end = Math.max(anchor, visualIndex);
    const step = visualIndex >= anchor ? 1 : -1;
    let lastAdded = anchor;
    let limited = false;
    for (let v = anchor; v >= start && v <= end; v += step) {
      const targetGridIdx = visualToGrid[v];
      if (!host.canAddToSelection(targetGridIdx)) {
        limited = true;
        break;
      }
      selected.add(targetGridIdx);
      lastAdded = v;
    }
    if (limited) host.showCompareLimitToast();
    nextActive = visualToGrid[limited ? lastAdded : visualIndex];
    anchorVisualIndex = limited ? lastAdded : visualIndex;
  } else if (event.ctrlKey || event.metaKey) {
    if (selected.has(gridIndex)) selected.delete(gridIndex);
    else if (host.canAddToSelection(gridIndex)) selected.add(gridIndex);
    else {
      host.showCompareLimitToast();
      return;
    }
    anchorVisualIndex = visualIndex;
  } else {
    selected.clear();
    selected.add(gridIndex);
    anchorVisualIndex = visualIndex;
  }

  suppressNextAutoScroll = true;
  host.commitSelection(nextActive);
  host.scrollGridToPhoto(host.getActiveIndex());
}

function handleRowDoubleClick(event) {
  const rowEl = event.target instanceof Element ? event.target.closest('.list-row') : null;
  if (!rowEl) return;
  const gridIndex = Number(rowEl.dataset.index);
  if (Number.isFinite(gridIndex)) host.openFullscreen(gridIndex);
}

// ---------------------------------------------------------------------------
// Columns picker menu (stays open until Esc or outside click)
// ---------------------------------------------------------------------------

function closeColumnsMenu() {
  if (menuCleanup) {
    menuCleanup();
    menuCleanup = null;
  }
  if (columnsMenu) {
    columnsMenu.remove();
    columnsMenu = null;
  }
  columnsButton?.setAttribute('aria-expanded', 'false');
}

function availableChildren(entry) {
  return entry.children.filter(id => {
    const col = COLUMNS_BY_ID.get(id);
    return col && isColumnAvailable(col);
  });
}

function applyColumnsChanged() {
  columnsVersion++;
  dataVersion++;
  rebuildSortOrder();
  renderHeader();
  renderVisibleRows({ forceRefresh: true });
  ensureAuxiliaryData();
}

function toggleColumnVisibility(colId) {
  const col = COLUMNS_BY_ID.get(colId);
  if (!col || col.pinned) return;
  if (visibleColumns.has(colId)) {
    visibleColumns.delete(colId);
    // Remove sorting from a newly hidden column.
    const nextSort = sortSpec.filter(entry => entry.col !== colId);
    if (nextSort.length !== sortSpec.length) {
      sortSpec = nextSort;
      saveSortState();
    }
  } else {
    visibleColumns.add(colId);
  }
  saveVisibleColumns();
  applyColumnsChanged();
}

function toggleGroupVisibility(entry) {
  const children = availableChildren(entry);
  if (children.length === 0) return;
  const allActive = children.every(id => visibleColumns.has(id));
  if (allActive) {
    for (const id of children) visibleColumns.delete(id);
    const hiddenSet = new Set(children);
    const nextSort = sortSpec.filter(item => !hiddenSet.has(item.col));
    if (nextSort.length !== sortSpec.length) {
      sortSpec = nextSort;
      saveSortState();
    }
  } else {
    for (const id of children) visibleColumns.add(id);
  }
  saveVisibleColumns();
  applyColumnsChanged();
}

function updateMenuIndicators(menu) {
  for (const item of menu.querySelectorAll('[data-col]')) {
    const colId = item.dataset.col;
    const checked = visibleColumns.has(colId);
    item.setAttribute('aria-checked', String(checked));
    item.classList.toggle('checked', checked);
    item.querySelector('.list-menu-check').textContent = checked ? '✓' : '';
  }
  for (const parentBtn of menu.querySelectorAll('[data-group-idx]')) {
    const entry = MENU_STRUCTURE[Number(parentBtn.dataset.groupIdx)];
    const children = availableChildren(entry);
    const activeCount = children.filter(id => visibleColumns.has(id)).length;
    const allActive = activeCount > 0 && activeCount === children.length;
    const partial = activeCount > 0 && activeCount < children.length;
    parentBtn.setAttribute('aria-checked', partial ? 'mixed' : String(allActive));
    parentBtn.classList.toggle('checked', allActive);
    parentBtn.classList.toggle('indeterminate', partial);
    parentBtn.querySelector('.list-menu-check').textContent = allActive ? '✓' : partial ? '–' : '';
  }
}

function createMenuCheckboxItem(label, { colId = null, disabled = false } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'context-menu-item list-menu-item';
  btn.setAttribute('role', 'menuitemcheckbox');
  if (colId) btn.dataset.col = colId;
  if (disabled) {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
  }
  const check = document.createElement('span');
  check.className = 'list-menu-check';
  check.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'list-menu-label';
  text.textContent = label;
  btn.append(check, text);
  return btn;
}

function positionSubmenu(wrapper) {
  const submenu = wrapper.querySelector('.context-submenu');
  if (!submenu) return;
  submenu.style.top = '';
  submenu.style.bottom = '';
  if (submenu.getBoundingClientRect().bottom > window.innerHeight - 4) {
    submenu.style.top = 'auto';
    submenu.style.bottom = '-5px';
  }
}

function openColumnsMenu(positionOrAnchor) {
  closeColumnsMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu list-columns-menu';
  menu.setAttribute('role', 'menu');

  MENU_STRUCTURE.forEach((entry, groupIdx) => {
    if (entry.col) {
      const col = COLUMNS_BY_ID.get(entry.col);
      if (!col || !isColumnAvailable(col)) return;
      const item = createMenuCheckboxItem(t(col.label), { colId: col.id, disabled: Boolean(col.pinned) });
      if (!col.pinned) {
        item.addEventListener('click', () => {
          toggleColumnVisibility(col.id);
          updateMenuIndicators(menu);
        });
      }
      menu.append(item);
      return;
    }

    const children = availableChildren(entry);
    if (children.length === 0) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'context-menu-sub';

    const trigger = createMenuCheckboxItem(t(entry.label));
    trigger.classList.add('has-submenu');
    trigger.dataset.groupIdx = String(groupIdx);
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', () => {
      toggleGroupVisibility(entry);
      updateMenuIndicators(menu);
    });

    const submenu = document.createElement('div');
    submenu.className = 'context-submenu';
    submenu.setAttribute('role', 'menu');
    for (const childId of children) {
      const col = COLUMNS_BY_ID.get(childId);
      const childBtn = createMenuCheckboxItem(t(col.label), { colId: col.id });
      childBtn.addEventListener('click', () => {
        toggleColumnVisibility(col.id);
        updateMenuIndicators(menu);
      });
      submenu.append(childBtn);
    }

    wrapper.append(trigger, submenu);
    wrapper.addEventListener('mouseenter', () => {
      wrapper.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      positionSubmenu(wrapper);
    });
    wrapper.addEventListener('mouseleave', () => {
      wrapper.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    });
    menu.append(wrapper);
  });

  updateMenuIndicators(menu);
  document.body.append(menu);
  columnsMenu = menu;
  columnsButton.setAttribute('aria-expanded', 'true');

  const rect = positionOrAnchor instanceof Element ? positionOrAnchor.getBoundingClientRect() : null;
  const x = rect ? rect.left : positionOrAnchor.clientX;
  const y = rect ? rect.bottom + 4 : positionOrAnchor.clientY;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  if (left + width + 220 > window.innerWidth) menu.classList.add('submenu-left');

  const onOutsidePointer = event => {
    const target = event.target instanceof Node ? event.target : null;
    if (menu.contains(target) || columnsButton.contains(target)) return;
    closeColumnsMenu();
  };
  const onMenuKey = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeColumnsMenu();
    }
  };
  document.addEventListener('pointerdown', onOutsidePointer, true);
  window.addEventListener('keydown', onMenuKey, true);
  window.addEventListener('blur', closeColumnsMenu);
  menuCleanup = () => {
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    window.removeEventListener('keydown', onMenuKey, true);
    window.removeEventListener('blur', closeColumnsMenu);
  };
}

// ---------------------------------------------------------------------------
// Open, close, and refresh API
// ---------------------------------------------------------------------------

export const isListViewOpen = () => open;

export function openListView() {
  if (open || !initialized) return;
  host.closePersonsView();
  host.closeFacesView();
  open = true;
  panel.hidden = false;
  host.setListLayout(true);
  toggleButton.classList.add('active');
  lastPhotosRef = host.getPhotos();
  rebuildSortOrder();
  renderHeader();
  renderVisibleRows({ forceRefresh: true });
  ensureAuxiliaryData();
  if (host.getSelectedIndices().size > 0) scrollPhotoIntoList(host.getActiveIndex());
  host.layoutPreview();
}

export function closeListView() {
  if (!open) return;
  open = false;
  closeColumnsMenu();
  cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
  releaseAllRows();
  panel.hidden = true;
  host.setListLayout(false);
  toggleButton.classList.remove('active');
  host.layoutPreview();
}

export function refreshListView({ dataChanged = false, selectionOnly = false } = {}) {
  if (!open || !initialized) return;
  const photos = host.getPhotos();
  const photosChanged = photos !== lastPhotosRef;
  if (photosChanged || dataChanged) {
    lastPhotosRef = photos;
    dataVersion++;
    rebuildSortOrder();
    ensureAuxiliaryData();
    renderVisibleRows({ forceRefresh: true });
  } else {
    renderVisibleRows();
  }
  if (!suppressNextAutoScroll && host.getSelectedIndices().size > 0) {
    scrollPhotoIntoList(host.getActiveIndex());
  }
  suppressNextAutoScroll = false;
  if (selectionOnly) return;
}

export function onFacesDataChanged() {
  if (!open) return;
  columnsVersion++;
  dataVersion++;
  rebuildSortOrder();
  renderHeader();
  renderVisibleRows({ forceRefresh: true });
  if (columnsMenu) closeColumnsMenu();
}

function handleFeatureToggleChanged() {
  if (!open) return;
  columnsVersion++;
  dataVersion++;
  rebuildSortOrder();
  renderHeader();
  renderVisibleRows({ forceRefresh: true });
  ensureAuxiliaryData();
  if (columnsMenu) closeColumnsMenu();
}

export function initListView(hostApi) {
  if (initialized) return;
  host = hostApi;
  panel = document.getElementById('list-panel');
  toggleButton = document.getElementById('btn-toggle-list');
  columnsButton = document.getElementById('btn-list-columns');
  clearSortButton = document.getElementById('btn-list-clear-sort');
  scrollContainer = document.getElementById('list-scroll');
  tableElement = document.getElementById('list-table');
  headerElement = document.getElementById('list-header');
  bodyElement = document.getElementById('list-body');
  emptyMessage = document.getElementById('list-empty');
  if (!panel || !toggleButton || !scrollContainer || !headerElement || !bodyElement) return;
  initialized = true;

  host.colorFlags.forEach((flag, idx) => colorOrderMap.set(flag.key, idx));

  toggleButton.addEventListener('click', async () => {
    if (open) {
      closeListView();
      return;
    }
    if (!(await host.requestCloseFacesView())) return;
    if (!(await host.requestCloseMapMode())) return;
    openListView();
  });

  columnsButton.addEventListener('click', () => {
    if (columnsMenu) closeColumnsMenu();
    else openColumnsMenu(columnsButton);
  });

  clearSortButton.addEventListener('click', clearAllSort);

  headerElement.addEventListener('pointerdown', handleHeaderPointerDown);
  headerElement.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
    if (activeDrag) return;
    openColumnsMenu(event);
  });

  scrollContainer.addEventListener('scroll', scheduleScrollRender, { passive: true });
  bodyElement.addEventListener('click', handleRowClick);
  bodyElement.addEventListener('dblclick', handleRowDoubleClick);

  new ResizeObserver(() => {
    if (open) renderVisibleRows();
  }).observe(scrollContainer);

  onLanguageChange(() => {
    if (!open) return;
    columnsVersion++;
    dataVersion++;
    renderHeader();
    renderVisibleRows({ forceRefresh: true });
    if (columnsMenu) closeColumnsMenu();
  });

  onMarkingSettingsChange(handleFeatureToggleChanged);

  onSemanticChange(() => {
    if (!isSemanticEnabled()) {
      analysedIds = new Set();
      analysedLoaded = false;
    }
    handleFeatureToggleChanged();
  });

  onAnalysisChanged(() => {
    analysedLoaded = false;
    if (open) ensureAuxiliaryData();
  });

  onPhashChanged(() => {
    phashLoaded = false;
    if (open) ensureAuxiliaryData();
  });
}
