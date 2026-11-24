// Sidebar folder tree, counts, empty-folder disk listing, quick search, fold state persistence,
// and sticky pinned ancestor rows. `main.js` wires host state and callbacks via `initFolderTree()`.
import { invoke } from '@tauri-apps/api/core';
import { readBool, readStored } from './settings-defaults.js';
import { t, tp, normalizeSearch } from './i18n.js';
import { initSidebarSearch } from './sidebar-search.js';
import { openContextMenuAt } from './photo-actions.js';
import { getSelectedAlbum, clearAlbumSelection, isSelectedAlbumDirty, confirmLeaveAlbum } from './albums-panel.js';
import { hasSelectionEdits, resolvePendingSelection } from './metadata-writes.js';
import { pinnedFolderRows } from './sticky-folders.js';

let host = {};
let initialized = false;
let folderTree = null;

const normalizeFolderKey = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// ==========================================
// FOLDER TREE & COUNTS
// ==========================================
// Catalogue folder counts ("Show folder photo counts"): whole-catalogue photos and videos, unfiltered, computed in Rust.
// Normalized keys ("/", lowercase, no trailing "/"); `Own` = folder level only, `Tree` = folder + subfolders.
let showFolderCounts = readBool('showFolderCounts');
let folderCountsOwn = new Map();
let folderCountsTree = new Map();
let folderCountsTotal = 0;
let folderCountsSignature = '';
let folderCountsTimer = null;

// Folders of the whole catalogue (original case, "/" separators), from the same query as the counts: the tree is built from them.
let catalogFolders = [];

// Fold state of the tree (normalized paths of the unfolded folders), remembered between launches: `saveFolderTreeExpanded` runs after each draw.
const FOLDER_TREE_EXPANDED_KEY = 'folderTreeExpanded';
// Saved list of unfolded folders, or null when nothing valid is saved (first launch): the roots then start unfolded, see `folderTreeInitialized`.
function readFolderTreeExpanded() {
  const stored = readStored(FOLDER_TREE_EXPANDED_KEY);
  if (stored === null) return null;
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.every(path => typeof path === 'string')) return parsed;
  } catch { /* unreadable value: treated as nothing saved */ }
  return null;
}
const savedFolderTreeExpanded = readFolderTreeExpanded();
const folderTreeExpanded = new Set(savedFolderTreeExpanded ?? []);
let savedFolderTreeSignature = savedFolderTreeExpanded === null ? null : JSON.stringify([...folderTreeExpanded].sort());

// Writes the fold state only when it changed since the last write (the tree is redrawn often: counts, quick search…).
function saveFolderTreeExpanded() {
  const signature = JSON.stringify([...folderTreeExpanded].sort());
  if (signature === savedFolderTreeSignature) return;
  savedFolderTreeSignature = signature;
  try { localStorage.setItem(FOLDER_TREE_EXPANDED_KEY, signature); } catch { /* storage unavailable: the fold state is not remembered */ }
}

// Quick search of the Folders block (sidebar-search.js): normalized text, '' = no filter. While it is set, the tree only holds the folders whose name contains it
// and their ancestors, all unfolded; `folderSearchCollapsed` holds the ones the user folded by hand meanwhile (reset with each new text).
let folderSearchQuery = '';
const folderSearchCollapsed = new Set();
const createdFolders = new Set(); // empty subfolders created during this session (see renderFolderTree)
let showEmptyFolders = readBool('showEmptyFolders');
let diskFolders = []; // subfolders on disk, read only when `showEmptyFolders` is active
// True as soon as the roots must no longer be forced open: after the first draw, or from the start when the fold state of a previous launch was restored.
let folderTreeInitialized = savedFolderTreeExpanded !== null;

function folderCountElement(count, scope) {
  const element = document.createElement('span');
  element.className = 'folder-tree-count';
  element.textContent = String(count);
  const titleKey = scope === 'with its subfolders' ? '{count} photo or video with its subfolders' : '{count} photo or video in this folder';
  element.title = tp(titleKey, count);
  return element;
}

// Re-reads the catalogue folders and their counts (once per burst of redraws), whether or not counts are shown: the tree needs
// the folder list. The tree is redrawn only when something changed.
export function scheduleFolderCounts() {
  clearTimeout(folderCountsTimer);
  folderCountsTimer = setTimeout(async () => {
    let raw;
    try {
      raw = await invoke('get_folder_counts');
    } catch (error) {
      console.debug('Folder counts unavailable', error);
      return; // keep the previous list rather than emptying the tree
    }
    const signature = JSON.stringify(raw);
    if (signature === folderCountsSignature) return;
    folderCountsSignature = signature;
    catalogFolders = Object.keys(raw).filter(Boolean);
    folderCountsOwn = new Map();
    folderCountsTree = new Map();
    folderCountsTotal = 0;
    for (const [dir, count] of Object.entries(raw)) {
      const key = normalizeFolderKey(dir);
      folderCountsOwn.set(key, (folderCountsOwn.get(key) ?? 0) + count);
      folderCountsTotal += count;
      // Each ancestor along the path also accumulates this count (subtree total).
      for (let cut = key.indexOf('/', 1); ; cut = key.indexOf('/', cut + 1)) {
        const ancestor = cut === -1 ? key : key.slice(0, cut);
        folderCountsTree.set(ancestor, (folderCountsTree.get(ancestor) ?? 0) + count);
        if (cut === -1) break;
      }
    }
    renderFolderTree({ fromCounts: true });
  }, 150);
}

// Re-reads subfolders on disk then redraws the tree; when the option is off, the list is cleared without reading disk.
export async function refreshDiskFolders() {
  try {
    diskFolders = showEmptyFolders ? await invoke('list_disk_folders') : [];
  } catch (error) {
    console.debug('Disk folder list unavailable', error);
    diskFolders = [];
  }
  renderFolderTree();
}

export function refreshDiskFoldersIfShown() {
  if (showEmptyFolders) refreshDiskFolders();
}

// Called after creating a subfolder: shows it immediately in the tree with its parent unfolded.
export function addCreatedFolder(parentPath, name) {
  createdFolders.add(`${parentPath.replace(/[\\/]+$/, '')}/${name}`);
  folderTreeExpanded.add(normalizeFolderKey(parentPath));
  renderFolderTree();
}

// Remembers the currently open folder in the tree (null = All photos), read back on startup when configured.
export function rememberCurrentFolder() {
  const current = host.getCurrentFolderFilter();
  if (current === null) localStorage.removeItem('lastFolderFilter');
  else localStorage.setItem('lastFolderFilter', current);
}

export function expandFolderAncestors(folderPath) {
  const segments = normalizeFolderKey(folderPath).split('/');
  for (let n = 1; n < segments.length; n++) folderTreeExpanded.add(segments.slice(0, n).join('/'));
}

export function forgetDeletedFolder(deletedPath) {
  const deleted = normalizeFolderKey(deletedPath);
  const isInside = value => normalizeFolderKey(value) === deleted || normalizeFolderKey(value).startsWith(`${deleted}/`);
  catalogFolders = catalogFolders.filter(folder => !isInside(folder));
  for (const created of [...createdFolders]) if (isInside(created)) createdFolders.delete(created);
  diskFolders = diskFolders.filter(folder => !isInside(folder)); // otherwise the deleted folder would stay in the tree when "show empty folders" is enabled
  for (const key of [...folderTreeExpanded]) if (isInside(key)) folderTreeExpanded.delete(key);
}

export function renameFolderInTree(oldBase, newBase) {
  const old = normalizeFolderKey(oldBase);
  const isInside = value => normalizeFolderKey(value) === old || normalizeFolderKey(value).startsWith(`${old}/`);
  const follow = value => `${newBase}${value.replace(/\/+$/, '').slice(oldBase.length)}`;
  const followKey = key => normalizeFolderKey(`${newBase}${key.slice(old.length)}`);
  catalogFolders = catalogFolders.map(folder => (isInside(folder) ? follow(folder) : folder));
  for (const created of [...createdFolders]) if (isInside(created)) { createdFolders.delete(created); createdFolders.add(follow(created)); }
  diskFolders = diskFolders.map(folder => (isInside(folder) ? follow(folder) : folder));
  for (const key of [...folderTreeExpanded]) if (isInside(key)) { folderTreeExpanded.delete(key); folderTreeExpanded.add(followKey(key)); }
}

// Whole-catalogue photo count for a folder (subfolders included if the option is checked); undefined until the first counts read.
export function getFolderPhotoCount(path) {
  if (!folderCountsSignature) return undefined;
  const folder = normalizeFolderKey(path);
  return (host.getIncludeSubfolders() ? folderCountsTree : folderCountsOwn).get(folder) ?? 0;
}

export async function selectFolder(path) {
  // Modified smart album: Save / Discard / Cancel before leaving it.
  if (isSelectedAlbumDirty() && !(await confirmLeaveAlbum())) return;
  if (hasSelectionEdits() && (await resolvePendingSelection([])) === 'cancel') return;
  host.abandonRawSearch(); // manual navigation ends "Find the RAW": pre-search filters return
  host.abandonDuplicateSearch(); // same for the duplicate search
  host.abandonSemanticSearch(); // and the content search
  clearAlbumSelection(); // single active entry in the sidebar
  host.syncSmartAlbumWithSelection(); // leaving a smart album resets its filters
  host.setCurrentPhotoPage(0); // new view: first page
  host.setCurrentFolderFilter(path);
  host.setExtraFolderFilters([]);
  rememberCurrentFolder();
  updateActiveFolderRows();
  host.loadPhotos({ catalogChanged: false });
}

// Ctrl+click on a folder: adds it to the selection, or removes it if already selected. Without a current folder, behaves like a plain click.
async function toggleFolderInSelection(path) {
  const same = (a, b) => normalizeFolderKey(a) === normalizeFolderKey(b);
  let current = host.getCurrentFolderFilter();
  let extras = host.getExtraFolderFilters();
  if (current === null || getSelectedAlbum() || host.isDuplicateSearchActive() || host.isRawSearchActive() || host.isSemanticSearchActive()) {
    selectFolder(path);
    return;
  }
  if (isSelectedAlbumDirty()) { selectFolder(path); return; }
  if (same(current, path) && extras.length === 0) return; // the only selected folder stays selected
  if (hasSelectionEdits() && (await resolvePendingSelection([])) === 'cancel') return;
  if (same(current, path)) {
    // The main folder is deselected: the first extra one takes over.
    [current, ...extras] = extras;
    host.setCurrentFolderFilter(current);
    host.setExtraFolderFilters(extras);
    rememberCurrentFolder();
  } else if (extras.some(folder => same(folder, path))) {
    host.setExtraFolderFilters(extras.filter(folder => !same(folder, path)));
  } else {
    host.setExtraFolderFilters([...extras, path]);
  }
  host.setCurrentPhotoPage(0); // the folders changed: first page
  updateActiveFolderRows();
  host.loadPhotos({ catalogChanged: false });
}

// Folds / unfolds a folder row (its arrow, a double-click). `expanded`: whether the row is unfolded now. While the quick search filters the tree, only the
// temporary fold state of the search changes: the real one is kept for when the search ends.
function toggleFolderFold(key, expanded) {
  if (folderSearchQuery) {
    if (expanded) folderSearchCollapsed.add(key); else folderSearchCollapsed.delete(key);
  } else {
    if (expanded) folderTreeExpanded.delete(key); else folderTreeExpanded.add(key);
    folderTreeInitialized = true;
  }
  renderFolderTree({ fromCounts: true });
}

// Entries of the Folders menu (right-click on the "Folders" title, also appended to the "All photos" menu): fold every folder, or unfold the
// ancestors of the folders holding the selected photos. Built each time a menu opens, since the selection changes.
export function foldersMenuItems() {
  const photos = host.getPhotos();
  const selectedIndices = host.getSelectedIndices();
  const selectedFolders = new Set();
  for (const index of selectedIndices) {
    const path = photos[index]?.path;
    if (path) selectedFolders.add(normalizeFolderKey(path.slice(0, Math.max(path.search(/[\\/][^\\/]*$/), 0))));
  }
  return [
    { label: t('Collapse all'), title: t('Fold every folder'), onSelect: () => {
      folderTreeExpanded.clear();
      folderTreeInitialized = true; // otherwise the tracked folders would be unfolded again as on first display
      renderFolderTree({ fromCounts: true });
    } },
    {
      label: tp('Expand to the selected photo', selectedIndices.size),
      title: t('Unfold the folders needed to see the selected photos'),
      disabled: selectedFolders.size === 0,
      onSelect: () => {
        // Every proper ancestor of a photo's folder must be unfolded for that folder to show.
        for (const folder of selectedFolders) {
          for (let cut = folder.indexOf('/', 1); cut !== -1; cut = folder.indexOf('/', cut + 1)) folderTreeExpanded.add(folder.slice(0, cut));
        }
        folderTreeInitialized = true;
        renderFolderTree({ fromCounts: true });
      },
    },
  ];
}

// `fromCounts`: redraw that must not ask for the folder counts again (new counts have just arrived, or the text of the quick search changed).
export function renderFolderTree({ fromCounts = false } = {}) {
  folderTree.innerHTML = '';
  folderTree.appendChild(stickyFolderLayer); // first child: the zero-height layer of the pinned ancestor rows (see STICKY FOLDERS)
  if (!fromCounts) scheduleFolderCounts(); // photos may have changed (scan, move, deletion…): re-read the catalogue folders

  const currentFolderFilter = host.getCurrentFolderFilter();
  const extraFolderFilters = host.getExtraFolderFilters();
  const includeSubfolders = host.getIncludeSubfolders();
  const folders = host.getFolders();
  const folderTreePhotos = host.getFolderTreePhotos();
  const loadedPhotos = host.getLoadedPhotos();

  const allItem = document.createElement('li');
  allItem.className = `folder-tree-item folder-tree-pinned ${currentFolderFilter === null && !getSelectedAlbum() ? 'active' : ''}`;
  allItem.dataset.allPhotos = '1'; // read by the context menu (photo-actions.js)
  allItem.innerHTML = `<span>📚</span> <span class="folder-tree-name">${t('All photos')}</span>`;
  if (showFolderCounts) allItem.append(folderCountElement(folderCountsTotal, 'in this folder'));
  allItem.addEventListener('click', () => selectFolder(null));
  folderTree.appendChild(allItem);

  const roots = folders.map(folder => {
    const path = folder.path.replace(/[\\/]+$/, '');
    const normPath = path.replace(/\\/g, '/');
    const normKey = normPath.toLowerCase();
    return {
      path,
      name: folder.path.split(/[\\/]/).filter(Boolean).pop() || folder.path,
      children: new Map(),
      normPath,
      normKey,
      normKeyPrefix: `${normKey}/`,
    };
  });
  // `empty`: folder with no photo; only nodes created by this call are marked (those already inferred from photos never are).
  const addFolderToTree = (parent, empty = false) => {
    const parentSlash = parent.replace(/\\/g, '/').replace(/\/+$/, '');
    const parentKey = parentSlash.toLowerCase();
    const root = roots.find(candidate => parentKey === candidate.normKey || parentKey.startsWith(candidate.normKeyPrefix));
    if (!root) return;
    const relative = parentSlash.slice(root.normPath.length).replace(/^\//, '');
    let node = root;
    let currentPath = root.path;
    for (const segment of relative.split('/').filter(Boolean)) {
      currentPath += `/${segment}`;
      if (!node.children.has(segment)) node.children.set(segment, { path: currentPath, name: segment, children: new Map(), empty });
      node = node.children.get(segment);
    }
  };
  // Every folder holding at least one catalogued photo, read from the whole catalogue: the loaded photo list is capped
  // (50,000 most recent), so older folders would otherwise be missing, or shown as empty by the disk listing below.
  if (catalogFolders.length > 0) {
    for (const folderPath of catalogFolders) addFolderToTree(folderPath);
  } else {
    // Loaded photos draw the tree right away before the first catalogue read answers.
    const seenFolders = new Set();
    for (const photo of (folderTreePhotos.length ? folderTreePhotos : loadedPhotos)) {
      const cut = Math.max(photo.path.lastIndexOf('/'), photo.path.lastIndexOf('\\'));
      const dir = cut >= 0 ? photo.path.slice(0, cut) : '';
      if (dir && !seenFolders.has(dir)) {
        seenFolders.add(dir);
        addFolderToTree(dir);
      }
    }
  }
  // Folders created from the app and still empty: the tree is inferred from photos, so they would not appear otherwise.
  for (const folderPath of createdFolders) addFolderToTree(folderPath.replace(/\\/g, '/').replace(/\/+$/, ''));
  // "Show folders without photos" option: all folders on disk (listed by `refreshDiskFolders`).
  if (showEmptyFolders) for (const folderPath of diskFolders) addFolderToTree(folderPath.replace(/\\/g, '/').replace(/\/+$/, ''), true);
  // Quick search of the Folders block (sidebar-search.js): a folder is kept when its name contains the text, or when one of its descendants does (the
  // hierarchy above a result stays). The subfolders of a match are not kept unless they match too.
  const searching = folderSearchQuery !== '';
  const markSearchResults = node => {
    const keptChildren = [...node.children.values()].map(child => markSearchResults(child)); // every child is marked, even when the node itself matches
    node.searchShown = normalizeSearch(node.name).includes(folderSearchQuery) || keptChildren.some(Boolean);
    return node.searchShown;
  };
  if (searching) roots.forEach(markSearchResults);
  const renderNode = (node, parentElement, depth, isRoot = false) => {
    if (searching && !node.searchShown) return;
    const li = document.createElement('li');
    const isActiveFolder = !getSelectedAlbum() && [currentFolderFilter, ...extraFolderFilters].some(folder => folder && normalizeFolderKey(folder) === normalizeFolderKey(node.path));
    li.className = `folder-tree-item ${isActiveFolder ? 'active' : ''} ${node.empty ? 'folder-empty' : ''}`;
    li.dataset.folderPath = node.path; // read by the tree context menu (photo-actions.js)
    li.dataset.folderDepth = String(depth); // indentation level (0 = tracked folder), read by the sticky folders
    if (isRoot) li.dataset.folderRoot = '1'; // tracked root folder (not a subfolder): deletion confirmation wording
    li.style.paddingLeft = `${10 + depth * 16}px`;
    const key = normalizeFolderKey(node.path);
    // While the quick search filters the tree, only the folders it keeps count, unfolded unless folded by hand since the text last changed.
    // The real fold state (`folderTreeExpanded`) is left alone: it is back as soon as the search ends.
    const hasChildren = searching ? [...node.children.values()].some(child => child.searchShown) : node.children.size > 0;
    const expanded = searching ? hasChildren && !folderSearchCollapsed.has(key) : folderTreeExpanded.has(key) || (isRoot && !folderTreeInitialized);
    const toggle = document.createElement('button');
    toggle.className = 'folder-tree-toggle';
    toggle.textContent = hasChildren ? (expanded ? '▾' : '▸') : ' ';
    toggle.setAttribute('aria-label', t(expanded ? 'Collapse folder' : 'Expand folder'));
    toggle.addEventListener('click', event => {
      event.stopPropagation();
      toggleFolderFold(key, expanded);
    });
    const icon = document.createElement('span'); icon.className = `folder-tree-icon${isRoot ? ' folder-tree-icon-root' : ''}`; icon.textContent = '📁';
    const label = document.createElement('span'); label.className = 'folder-tree-name'; label.textContent = node.name; label.title = node.path;
    li.append(toggle, icon, label);
    if (showFolderCounts) {
      // Folded folder with "include subfolders": the count summarizes what is hidden; otherwise, only this folder's level
      // (when unfolded, its subfolders show their own counts).
      const summarizesChildren = hasChildren && !expanded && includeSubfolders;
      li.append(summarizesChildren
        ? folderCountElement(folderCountsTree.get(key) ?? 0, 'with its subfolders')
        : folderCountElement(folderCountsOwn.get(key) ?? 0, 'in this folder'));
    }
    // Ctrl (Cmd on macOS) + click adds the folder to / removes it from the multiple selection.
    li.addEventListener('click', event => {
      if (event.ctrlKey || event.metaKey) toggleFolderInSelection(node.path); else selectFolder(node.path);
    });
    parentElement.appendChild(li);
    if (expanded) for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) renderNode(child, parentElement, depth + 1);
  };
  for (const root of roots) {
    if (!folderTreeInitialized) folderTreeExpanded.add(normalizeFolderKey(root.path));
    renderNode(root, folderTree, 0, true);
  }
  folderTreeInitialized = true;
  saveFolderTreeExpanded(); // the real fold state (never the temporary one of the quick search) survives a restart
  // Quick search without any result ("All photos" stays, it is the pinned row of the list).
  if (searching && folders.length > 0 && !roots.some(root => root.searchShown)) {
    const none = document.createElement('li');
    none.className = 'folder-tree-empty';
    const message = document.createElement('p');
    message.textContent = t('No matching folder');
    none.append(message);
    folderTree.appendChild(none);
  }
  // No tracked folder (first launch): offer adding one directly from the tree, without opening Settings.
  if (folders.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'folder-tree-empty';
    const message = document.createElement('p');
    message.textContent = t('No folder yet. Add a folder to start.');
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'btn-highlight';
    addButton.textContent = t('Add folder');
    addButton.addEventListener('click', () => document.getElementById('btn-add-folder').click());
    empty.append(message, addButton);
    folderTree.appendChild(empty);
  }
  indexStickyFolders(); // the rows are new: pin the ancestors of the first visible one
}

// ==========================================
// STICKY FOLDERS (pinned ancestors of the first visible row)
// ==========================================
// While a big folder is scrolled, its ancestors stay pinned at the top of the tree, one row per level and indented like in the tree, so the user
// always knows which folders they are under. The tree is a flat list of rows (the indentation is `data-folder-depth`), so CSS `position: sticky` cannot
// stack the levels; a layer of copies of the ancestor rows is drawn over the top of the list instead. The layer is a sticky <li> without height (same
// trick as the marking bar of the grid), so it never changes the layout of the real rows, which stay the only ones in the flow.
// Level n is pinned in slot n, as nested sticky boxes would be, and its end pushes it up as the end of its subtree reaches it. When the panel is too short
// for all the levels, the deepest ones are kept. Clicks on a copy are forwarded to the real row (select, Ctrl + click, fold); the context menu, the
// double-click fold and the photo drop target work on the copies as they carry the same `data-folder-*` attributes.
const STICKY_FOLDERS_MAX_SHARE = 0.4; // the pinned rows never take more than this share of the height of the tree
const stickyFolderLayer = document.createElement('li');
stickyFolderLayer.className = 'folder-tree-sticky';
stickyFolderLayer.setAttribute('aria-hidden', 'true'); // the real rows stay in the DOM: assistive technologies do not need the copies
let stickyFolderIndex = null; // structure of the rows of the last render: { rows, depths, parents, ends }
const stickyFolderCopies = new Map(); // row index -> its copy, created on demand and dropped by every render
const stickyFolderSources = new WeakMap(); // copy -> real row
let stickyFolderFrame = 0;

// `pinnedFolderRows` (which rows are pinned for a scroll position) is a pure function: see sticky-folders.js.

// Size of the rows of the tree: `height` of a row, `pitch` = distance between two rows (height + margin), `maxSlots` = pinned rows the panel can afford.
function stickyFolderMetrics(row) {
  const height = row.offsetHeight;
  const pitch = height + (parseFloat(getComputedStyle(row).marginBottom) || 0);
  const maxSlots = pitch > 0 ? Math.floor(folderTree.clientHeight * STICKY_FOLDERS_MAX_SHARE / pitch) : 0;
  return { height, pitch, maxSlots };
}

// Copy of a real row for the layer. Its buttons leave the tab order (the real row is the one to reach by keyboard).
function makeStickyFolderCopy(row) {
  const copy = row.cloneNode(true);
  copy.classList.add('folder-tree-sticky-row');
  for (const button of copy.querySelectorAll('button')) button.tabIndex = -1;
  stickyFolderSources.set(copy, row);
  return copy;
}

// Draws the pinned rows for the current scroll position. Cheap enough to run on every scroll frame: a few binary searches, copies are reused.
function updateStickyFolders() {
  const index = stickyFolderIndex;
  if (!index || !index.rows.length || !folderTree.clientHeight) {
    stickyFolderLayer.replaceChildren(); // nothing to pin (no folder, or the tree is folded away)
    return;
  }
  const { rows, depths, parents, ends } = index;
  const { pitch, maxSlots } = stickyFolderMetrics(rows[0]);
  stickyFolderLayer.style.top = `${pitch}px`; // the pinned ancestors sit right under the "All photos" row, which is itself pinned (.folder-tree-pinned)
  const lastRow = rows[rows.length - 1];
  const pinned = maxSlots < 1 ? [] : pinnedFolderRows({
    depths, parents, ends, pitch, maxSlots,
    topOf: position => rows[position].offsetTop,
    listEnd: lastRow.offsetTop + pitch,
    scrollTop: folderTree.scrollTop + pitch, // slots start under the pinned "All photos" row
  });
  const copies = pinned.map(({ index: rowIndex, slot, pushed }, position) => {
    let copy = stickyFolderCopies.get(rowIndex);
    if (!copy) {
      copy = makeStickyFolderCopy(rows[rowIndex]);
      stickyFolderCopies.set(rowIndex, copy);
    }
    copy.style.height = `${pitch}px`; // a full pitch, so that the rows of the list do not show through the margin between two copies
    copy.style.transform = `translateY(${slot * pitch + pushed}px)`;
    copy.style.zIndex = String(pinned.length - position); // a parent stays above its children: a child pushed out by the end of its subtree slides under it
    copy.classList.toggle('is-last', position === pinned.length - 1); // the last one carries the separator under the pinned block
    return copy;
  });
  const current = stickyFolderLayer.children;
  if (copies.length !== current.length || copies.some((copy, position) => copy !== current[position])) stickyFolderLayer.replaceChildren(...copies);
}

function scheduleStickyFolders() {
  if (stickyFolderFrame) return;
  stickyFolderFrame = requestAnimationFrame(() => {
    stickyFolderFrame = 0;
    updateStickyFolders();
  });
}

// Called by every render of the tree: reads the structure of the new rows (depths, parent and end of each subtree), then draws the layer.
function indexStickyFolders() {
  stickyFolderCopies.clear();
  stickyFolderLayer.replaceChildren();
  const rows = [...folderTree.querySelectorAll(':scope > li[data-folder-path]')]; // "All photos" is no folder row; the copies are not direct children
  const depths = rows.map(row => Number(row.dataset.folderDepth) || 0);
  const parents = new Array(rows.length).fill(-1);
  const ends = new Array(rows.length).fill(rows.length);
  const open = []; // rows whose subtree is still being read, outermost first
  depths.forEach((depth, position) => {
    while (open.length && depths[open[open.length - 1]] >= depth) ends[open.pop()] = position;
    parents[position] = open.length ? open[open.length - 1] : -1;
    open.push(position);
  });
  stickyFolderIndex = { rows, depths, parents, ends };
  updateStickyFolders();
}

// Scrolls a row into view below the pinned rows that would otherwise hide it (`scroll-padding-top` is honoured by scrollIntoView).
function revealFolderRow(row) {
  if (!row) return;
  const { pitch, maxSlots } = stickyFolderMetrics(stickyFolderIndex?.rows[0] ?? row);
  folderTree.style.scrollPaddingTop = `${(Math.min(Number(row.dataset.folderDepth) || 0, maxSlots) + 1) * pitch}px`;
  row.scrollIntoView({ block: 'nearest' });
  folderTree.style.scrollPaddingTop = '';
}

export function revealActiveFolderRow() {
  revealFolderRow(folderTree.querySelector(':scope > .folder-tree-item.active')); // direct children only: the pinned copies are not the real row
}

// Updates `.active` in place on the existing tree rows and sticky copies during navigation without rebuilding the DOM or re-fetching counts.
export function updateActiveFolderRows() {
  if (!folderTree) return;
  const albumSelected = Boolean(getSelectedAlbum());
  const currentFolderFilter = host.getCurrentFolderFilter();
  const extraFolderFilters = host.getExtraFolderFilters();
  const activeKeys = albumSelected
    ? new Set()
    : new Set([currentFolderFilter, ...extraFolderFilters].filter(Boolean).map(normalizeFolderKey));
  folderTree.querySelector(':scope > li[data-all-photos="1"]')?.classList.toggle('active', !albumSelected && currentFolderFilter === null);
  for (const row of folderTree.querySelectorAll(':scope > li[data-folder-path]')) {
    row.classList.toggle('active', activeKeys.has(normalizeFolderKey(row.dataset.folderPath)));
  }
  for (const copy of stickyFolderCopies.values()) {
    copy.classList.toggle('active', activeKeys.has(normalizeFolderKey(copy.dataset.folderPath)));
  }
}

// ==========================================
// INITIALIZATION
// ==========================================
export function initFolderTree(hostCallbacks) {
  if (initialized) return;
  initialized = true;
  host = hostCallbacks;
  folderTree = document.getElementById('folder-tree');

  const emptyFoldersToggle = document.getElementById('show-empty-folders-toggle');
  emptyFoldersToggle.checked = showEmptyFolders;
  emptyFoldersToggle.addEventListener('change', event => {
    showEmptyFolders = event.target.checked;
    localStorage.setItem('showEmptyFolders', String(showEmptyFolders));
    refreshDiskFolders();
  });
  if (showEmptyFolders) refreshDiskFolders();

  const folderCountsToggle = document.getElementById('show-folder-counts-toggle');
  folderCountsToggle.checked = showFolderCounts;
  folderCountsToggle.addEventListener('change', event => {
    showFolderCounts = event.target.checked;
    localStorage.setItem('showFolderCounts', String(showFolderCounts));
    folderCountsSignature = ''; // force a re-read on the next activation
    renderFolderTree();
  });

  // Quick search of the Folders block: filters the tree live (see renderFolderTree). Once the filter is gone (field closed or emptied), the tree is back to its
  // real fold state, with the ancestors of the selected folders unfolded and the selected folder scrolled into view if needed.
  initSidebarSearch({
    name: 'folders',
    onChange: (query, previous) => {
      folderSearchQuery = query;
      folderSearchCollapsed.clear();
      const filterEnded = !query && Boolean(previous);
      if (filterEnded && !getSelectedAlbum()) {
        for (const folder of [host.getCurrentFolderFilter(), ...host.getExtraFolderFilters()]) {
          if (folder) expandFolderAncestors(folder);
        }
      }
      renderFolderTree({ fromCounts: true }); // the counts do not change with the text: no new request
      if (filterEnded) revealActiveFolderRow();
    },
  });

  document.getElementById('folders-toggle').addEventListener('contextmenu', event => {
    openContextMenuAt(event, [{ header: t('Folders') }, ...foldersMenuItems()]);
  });

  // Double-click on a folder row folds / unfolds it (same as its arrow). The tree is redrawn by the first click (and again when the photos load), so the
  // row under the second click is a new element and the browser may never fire `dblclick` on it: the second `mousedown` (detail 2) is used instead.
  folderTree.addEventListener('mousedown', event => {
    if (event.detail !== 2 || event.button !== 0 || event.ctrlKey || event.metaKey || event.target.closest('.folder-tree-toggle')) return;
    event.preventDefault(); // no text selection on a double-click
    const row = event.target.closest('li[data-folder-path]');
    if (!row) return;
    const key = normalizeFolderKey(row.dataset.folderPath);
    const arrow = row.querySelector('.folder-tree-toggle')?.textContent.trim();
    if (!arrow) return; // no subfolder
    toggleFolderFold(key, arrow === '▾'); // the arrow tells whether the row is unfolded, also while a search filters the tree
  });

  folderTree.addEventListener('scroll', scheduleStickyFolders, { passive: true });
  new ResizeObserver(scheduleStickyFolders).observe(folderTree); // panel resized, or folded away and shown again

  // A click on a pinned row does what a click on the real row does, with the same modifier keys (Ctrl + click: multiple selection).
  stickyFolderLayer.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    const row = stickyFolderSources.get(target?.closest('.folder-tree-sticky-row'));
    if (!row?.isConnected) return;
    const destination = target.closest('.folder-tree-toggle') ? row.querySelector('.folder-tree-toggle') : row;
    destination.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey,
    }));
  });
}
