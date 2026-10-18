import './styles.css';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { LANGUAGES, getLanguage, setLanguage, applyTranslations, t, tp, labelWithColon, onLanguageChange } from './i18n.js';
import { initPhotoActions, showPhotoInfo, copyPhotosTo, confirmAndDelete } from './photo-actions.js';

// AJOUT BARRE TITRE
window.addEventListener('DOMContentLoaded', () => {
  const appWindow = getCurrentWindow();
  console.log("Fenêtre Tauri initialisée pour la barre de titre");

  document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
    console.log("Clic sur Minimiser");
    appWindow.minimize().catch(err => console.error("Erreur minimize:", err));
  });

  document.getElementById('titlebar-maximize')?.addEventListener('click', async () => {
    console.log("Clic sur Maximiser");
    try {
      const isMax = await appWindow.isMaximized();
      if (isMax) {
        await appWindow.unmaximize();
      } else {
        await appWindow.maximize();
      }
    } catch (err) {
      console.error("Erreur maximize/unmaximize:", err);
    }
  });

  document.getElementById('titlebar-close')?.addEventListener('click', () => {
    console.log("Clic sur Fermer");
    appWindow.close().catch(err => console.error("Erreur close:", err));
  });
});

// ETAT
let photos = [];
let loadedPhotos = [];
let folders = [];
let folderTreePhotos = [];
let currentFolderFilter = null;
let includeSubfolders = localStorage.getItem('includeSubfolders') !== 'false';
let keywordFilters = [];
let colorFilters = new Set(); // couleurs cochées dans le filtre (vide = pas de filtre)
let selectedIndices = new Set();
let lastSelectedIndex = 0;
let isFullscreen = false;
let fullscreenRatingPinned = false;
let fullscreenRatingTimeout = null;
const fullscreenImageCache = new Map();
// Version des fichiers modifiés hors de l'application (chemin -> horodatage) : ajoutée à l'URL pour ne pas réafficher une image périmée du cache.
const photoVersions = new Map();
function photoUrl(photo) {
  const version = photoVersions.get(photo.path);
  return convertFileSrc(photo.path) + (version ? `?v=${version}` : '');
}

// COULEURS (XMP Label) : clé stockée en base, label = clé de traduction du libellé affiché. La couleur visuelle est dans le CSS (.flag-<clé>).
const COLOR_FLAGS = [
  { key: 'red', label: 'Red' },
  { key: 'orange', label: 'Orange' },
  { key: 'yellow', label: 'Yellow' },
  { key: 'green', label: 'Green' },
  { key: 'blue', label: 'Blue' },
  { key: 'magenta', label: 'Magenta' },
  { key: 'grey', label: 'Grey' },
  { key: 'black', label: 'Black' },
  { key: 'white', label: 'White' },
];
// Libellés traduits au moment de l'affichage (has/get comme une Map, pour ne pas changer les appels existants).
const colorFlagLabels = {
  has: key => COLOR_FLAGS.some(flag => flag.key === key),
  get: key => {
    const flag = COLOR_FLAGS.find(candidate => candidate.key === key);
    return flag ? t(flag.label) : undefined;
  },
};

// APPARENCE (thème et couleur de sélection, mémorisés localement)
const DEFAULT_SELECTION_COLOR = '#3498db';
let appTheme = localStorage.getItem('appTheme') === 'light' ? 'light' : 'dark';
const storedSelectionColor = localStorage.getItem('selectionColor') || '';
let selectionColor = /^#[0-9a-f]{6}$/i.test(storedSelectionColor) ? storedSelectionColor : DEFAULT_SELECTION_COLOR;
// Couleur des boutons activés (Filtres, Comparer, Aperçu, Info), distincte de la couleur de sélection des miniatures.
const DEFAULT_ACTIVE_BUTTON_COLOR = '#3498db';
const storedActiveButtonColor = localStorage.getItem('activeButtonColor') || '';
let activeButtonColor = /^#[0-9a-f]{6}$/i.test(storedActiveButtonColor) ? storedActiveButtonColor : DEFAULT_ACTIVE_BUTTON_COLOR;
// Texte noir sur les couleurs très claires (jaune…), blanc sinon, pour rester lisible sur le bouton activé.
function readableTextColor(hex) {
  const [r, g, b] = [1, 3, 5]
    .map(start => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? '#111' : '#fff';
}
function applyAppearance() {
  document.documentElement.dataset.theme = appTheme;
  document.documentElement.style.setProperty('--selected-border', selectionColor);
  document.documentElement.style.setProperty('--active-button', activeButtonColor);
  document.documentElement.style.setProperty('--active-button-text', readableTextColor(activeButtonColor));
}
applyAppearance();

// DOM
let thumbnailSize = Number(localStorage.getItem('thumbnailSize')) || 160;
thumbnailSize = Math.max(96, Math.min(512, 96 + Math.round((thumbnailSize - 96) / 16) * 16));
let columns = 1;
const storedThumbnailLayout = localStorage.getItem('thumbnailLayout');
let thumbnailLayout = ['square', 'justified', 'masonry'].includes(storedThumbnailLayout) ? storedThumbnailLayout : 'square';
let photoLayouts = [];
let layoutContentHeight = 0;
let maximumPhotoHeight = thumbnailSize;
const gridContainer = document.getElementById('grid-view');
const scrollContent = document.getElementById('virtual-scroll-content');
const previewStage = document.getElementById('preview-stage');
const fullscreenView = document.getElementById('fullscreen-view');
const fullscreenImg = document.getElementById('fullscreen-image');
const sidebarPanel = document.getElementById('sidebar-panel');
const folderTree = document.getElementById('folder-tree');
const settingsModal = document.getElementById('settings-modal');
const settingsFolderList = document.getElementById('settings-folder-list');
const renderedThumbnailNodes = new Map();
const thumbnailCacheLookups = new Map();
const thumbnailCacheWrites = new Map();
let scrollRenderPending = false;

let justifiedLayoutTimer = null;

function scheduleJustifiedRelayout() {
  clearTimeout(justifiedLayoutTimer);
  justifiedLayoutTimer = setTimeout(() => {
    if (thumbnailLayout === 'justified') updateVirtualScroller();
  }, 80);
}

// Marge de pré-rendu (en hauteurs de fenêtre de grille) de part et d'autre de la zone visible :
// les miniatures en cache sont déjà chargées quand elles arrivent à l'écran.
const THUMBNAIL_OVERSCAN_SCREENS = 1;

// Recherche dans le cache par lots : toutes les demandes d'un même rendu partent dans le même appel IPC.
const THUMBNAIL_LOOKUP_BATCH_SIZE = 128;
const pendingThumbnailLookups = new Map();
let thumbnailLookupFlushScheduled = false;

function lookupCachedThumbnail(sourcePath) {
  let lookup = thumbnailCacheLookups.get(sourcePath);
  if (lookup) return lookup;
  lookup = new Promise(resolve => pendingThumbnailLookups.set(sourcePath, resolve));
  thumbnailCacheLookups.set(sourcePath, lookup);
  if (!thumbnailLookupFlushScheduled) {
    thumbnailLookupFlushScheduled = true;
    setTimeout(flushThumbnailLookups, 0);
  }
  return lookup;
}

function flushThumbnailLookups() {
  thumbnailLookupFlushScheduled = false;
  const pending = [...pendingThumbnailLookups];
  pendingThumbnailLookups.clear();
  for (let start = 0; start < pending.length; start += THUMBNAIL_LOOKUP_BATCH_SIZE) {
    const batch = pending.slice(start, start + THUMBNAIL_LOOKUP_BATCH_SIZE);
    invoke('get_cached_thumbnail_paths', { sourcePaths: batch.map(([sourcePath]) => sourcePath) })
      .catch(() => [])
      .then(paths => batch.forEach(([, resolve], index) => resolve(paths[index] ?? null)));
  }
}

// Génération des miniatures absentes du cache (côté Rust, avec repli webview) : le nombre de tâches simultanées
// est limité pour laisser des cœurs à l'interface. Les tâches dont la miniature
// a quitté le DOM (défilement rapide) sont abandonnées tant qu'elles n'ont pas démarré, et la plus proche
// de la zone visible passe en premier.
const MAX_THUMBNAIL_GENERATIONS = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
let thumbnailGenerationQueue = [];
let activeThumbnailGenerations = 0;
let thumbnailPumpScheduled = false;

function takeNextThumbnailGeneration() {
  thumbnailGenerationQueue = thumbnailGenerationQueue.filter(job => job.image.isConnected && job.image.dataset.sourcePath === job.sourcePath);
  const viewTop = gridContainer.scrollTop;
  const viewBottom = viewTop + gridContainer.clientHeight;
  let best = -1;
  let bestDistance = Infinity;
  let bestTop = Infinity;
  thumbnailGenerationQueue.forEach((job, position) => {
    const node = job.image.closest('.thumbnail');
    const top = node?._y ?? 0;
    const bottom = top + (node?._height ?? 0);
    const distance = bottom < viewTop ? viewTop - bottom : top > viewBottom ? top - viewBottom : 0;
    if (distance < bestDistance || (distance === bestDistance && top < bestTop)) {
      best = position;
      bestDistance = distance;
      bestTop = top;
    }
  });
  return best < 0 ? null : thumbnailGenerationQueue.splice(best, 1)[0];
}

function pumpThumbnailGenerationQueue() {
  thumbnailPumpScheduled = false;
  while (activeThumbnailGenerations < MAX_THUMBNAIL_GENERATIONS) {
    const job = takeNextThumbnailGeneration();
    if (!job) return;
    activeThumbnailGenerations++;
    job.run().catch(() => {}).finally(() => {
      activeThumbnailGenerations--;
      pumpThumbnailGenerationQueue();
    });
  }
}

function enqueueThumbnailGeneration(image, sourcePath, run) {
  thumbnailGenerationQueue.push({ image, sourcePath, run });
  // Le démarrage est différé d'un tour de boucle pour choisir parmi toutes les demandes d'un même rendu.
  if (!thumbnailPumpScheduled) {
    thumbnailPumpScheduled = true;
    setTimeout(pumpThumbnailGenerationQueue, 0);
  }
}

// Apprend le ratio réel de la miniature (dimensions EXIF absentes ou fausses en base) et relance la disposition justifiée.
function learnPhotoAspectRatio(photo, ratio) {
  if (!(ratio > 0)) return;
  const previousRatio = photo.aspectRatio || (photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 0);
  // Tolérance relative de 0,2 % : l'arrondi des dimensions d'une miniature (ex. 512x341) ne doit pas relancer la disposition.
  if (Math.abs(previousRatio - ratio) > ratio * 0.002) {
    photo.aspectRatio = ratio;
    scheduleJustifiedRelayout();
  }
}

function updatePhotoAspectRatio(image, photo) {
  if (image.naturalWidth > 0 && image.naturalHeight > 0) learnPhotoAspectRatio(photo, image.naturalWidth / image.naturalHeight);
}

// Affiche une miniature du cache dans l'image et apprend son ratio réel au chargement.
function showCachedThumbnail(image, cachedPath, photo) {
  image.onload = () => {
    if (!image.isConnected) return;
    image.classList.add('loaded');
    updatePhotoAspectRatio(image, photo);
  };
  image.src = convertFileSrc(cachedPath);
}

// Repli (PNG, JPEG CMYK, fichier que le backend ne sait pas lire) : ancienne génération dans le webview,
// limitée à peu de tâches car elle décode l'original en pleine résolution.
const MAX_WEBVIEW_THUMBNAIL_FALLBACKS = 2;
let activeWebviewThumbnailFallbacks = 0;
const webviewThumbnailFallbackWaiters = [];

async function generateThumbnailInWebview(image, sourcePath, photo) {
  while (activeWebviewThumbnailFallbacks >= MAX_WEBVIEW_THUMBNAIL_FALLBACKS) {
    await new Promise(resolve => webviewThumbnailFallbackWaiters.push(resolve));
  }
  activeWebviewThumbnailFallbacks++;
  try {
    const loaded = new Promise(resolve => {
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
    });
    image.src = photoUrl(photo);
    const success = await loaded;
    image.onload = null;
    image.onerror = null;
    if (!success) return;
    image.classList.add('loaded');
    updatePhotoAspectRatio(image, photo);
    await cacheThumbnail(image, sourcePath);
  } finally {
    activeWebviewThumbnailFallbacks--;
    webviewThumbnailFallbackWaiters.shift()?.();
  }
}

function loadThumbnail(image, sourcePath, photo) {
  image.dataset.sourcePath = sourcePath;
  lookupCachedThumbnail(sourcePath).then(cachedPath => {
    if (!image.isConnected) return;
    if (cachedPath) {
      showCachedThumbnail(image, cachedPath, photo);
      return;
    }
    // Pas de miniature en cache : génération côté Rust quand une place se libère dans la file de génération.
    enqueueThumbnailGeneration(image, sourcePath, async () => {
      let generated = null;
      try {
        generated = await invoke('generate_thumbnail', { sourcePath });
      } catch {
        // Format non géré par le backend : repli ci-dessous.
      }
      if (!generated) {
        // Fichier supprimé hors de l'application ? On le retire du catalogue au lieu de laisser une miniature noire.
        if (await checkPhotoMissing(sourcePath)) return;
        await generateThumbnailInWebview(image, sourcePath, photo);
        return;
      }
      thumbnailCacheLookups.set(sourcePath, Promise.resolve(generated.path));
      if (generated.width > 0 && generated.height > 0) learnPhotoAspectRatio(photo, generated.width / generated.height);
      if (image.isConnected && image.dataset.sourcePath === sourcePath) showCachedThumbnail(image, generated.path, photo);
    });
  });
}

function cacheThumbnail(image, sourcePath) {
  if (thumbnailCacheWrites.has(sourcePath)) return thumbnailCacheWrites.get(sourcePath);
  const task = (async () => {
    let bitmap;
    try {
      await image.decode();
      bitmap = await createImageBitmap(image);
      const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.84));
      if (!blob) return;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      const cachedPath = await invoke('save_thumbnail_cache', { sourcePath, dataUrl });
      thumbnailCacheLookups.set(sourcePath, Promise.resolve(cachedPath));
      if (image.isConnected && image.dataset.sourcePath === sourcePath) {
        image.onload = null;
        image.src = convertFileSrc(cachedPath);
      }
    } catch (error) {
      console.debug('Mise en cache de miniature impossible', sourcePath, error);
    } finally {
      bitmap?.close();
      thumbnailCacheWrites.delete(sourcePath);
    }
  })();
  thumbnailCacheWrites.set(sourcePath, task);
  return task;
}

// ==========================================
// SYNCHRONISATION « PARESSEUSE » AVEC LE DISQUE
// ==========================================
// Une photo supprimée hors de l'application reste dans le catalogue tant qu'on ne s'en aperçoit pas. Plutôt que de parcourir
// le disque, on vérifie au moment où l'affichage échoue (miniature impossible à générer, image qui ne se charge pas) :
// aucun coût tant que les fichiers sont là. Les demandes sont groupées en un seul appel ; le backend ne retire que les fichiers
// réellement introuvables dont le dossier suivi est accessible, puis la grille est mise à jour en conservant la sélection.
const MISSING_CHECK_DELAY_MS = 25;
let pendingMissingChecks = new Map(); // chemin -> fonctions à appeler avec le résultat
let missingCheckTimer = null;

// Résout à true si la photo était bien introuvable sur le disque (elle a alors été retirée du catalogue et de la grille).
function checkPhotoMissing(sourcePath) {
  return new Promise(resolve => {
    const waiters = pendingMissingChecks.get(sourcePath);
    if (waiters) waiters.push(resolve);
    else pendingMissingChecks.set(sourcePath, [resolve]);
    if (missingCheckTimer === null) missingCheckTimer = setTimeout(flushMissingChecks, MISSING_CHECK_DELAY_MS);
  });
}

async function flushMissingChecks() {
  missingCheckTimer = null;
  const batch = [...pendingMissingChecks];
  pendingMissingChecks = new Map();
  let removed = [];
  try {
    removed = await invoke('remove_missing_photos', { paths: batch.map(([path]) => path) });
  } catch (error) {
    console.debug('Vérification des fichiers manquants impossible', error);
  }
  const removedPaths = new Set(removed);
  if (removedPaths.size) removePhotosFromLibrary(removed, { keepSelection: true });
  for (const [path, waiters] of batch) for (const resolve of waiters) resolve(removedPaths.has(path));
}

// ==========================================
// CHARGEMENT PHOTOS & DOSSIERS
// ==========================================
async function loadFolders() {
  folders = await invoke('get_folders');
  renderFolderTree();
  renderSettingsFolderList();
}

async function loadPhotos() {
  loadedPhotos = await invoke('get_photos_paginated', { 
    offset: 0, 
    limit: 50000, 
    folderFilter: currentFolderFilter,
    recursive: includeSubfolders,
  });
  if (currentFolderFilter === null) folderTreePhotos = loadedPhotos;
  renderFolderTree();
  renderKeywordFilters();
  applyPhotoFilters();
}

function applyPhotoFilters({ keepState = false } = {}) {
  const ratingThreshold = Number(document.getElementById('rating-filter').value);
  // keepState : mise à jour en arrière-plan (synchronisation), la sélection et le défilement sont conservés.
  const keptPaths = keepState ? [...selectedIndices].map(index => photos[index]?.path).filter(Boolean) : [];
  const keptLastPath = keepState ? photos[lastSelectedIndex]?.path : null;
  const keptScrollTop = gridContainer.scrollTop;
  for (const node of renderedThumbnailNodes.values()) node.remove();
  renderedThumbnailNodes.clear();
  photos = loadedPhotos.filter(photo => (ratingThreshold < 0 || photo.rating > ratingThreshold)
    && keywordFilters.every(keyword => (photo.keywords || '').split(', ').includes(keyword))
    && (colorFilters.size === 0 || colorFilters.has(photo.color_flag || 'none'))
    && matchesDateFilter(photo));
  selectedIndices.clear();
  lastSelectedIndex = 0;
  gridContainer.scrollTop = 0;
  updateVirtualScroller();
  if (keepState) {
    const indexByPath = new Map(photos.map((photo, index) => [photo.path, index]));
    for (const path of keptPaths) if (indexByPath.has(path)) selectedIndices.add(indexByPath.get(path));
    lastSelectedIndex = indexByPath.get(keptLastPath) ?? selectedIndices.values().next().value ?? 0;
    gridContainer.scrollTop = keptScrollTop;
    renderVisibleItems();
  }
  if (photos.length > 0) {
    if (selectedIndices.size === 0) selectedIndices.add(0);
    updateUIOnSelection();
  } else {
    renderPreview();
    fullscreenImg.src = '';
    updateRatingAction();
    document.getElementById('exif-caption').textContent = '-';
  }
}

function renderKeywordFilters() {
  const keywords = new Set();
  for (const photo of folderTreePhotos) for (const word of (photo.keywords || '').split(', ')) if (word.trim()) keywords.add(word.trim());
  const options = document.getElementById('keyword-options');
  options.replaceChildren(...[...keywords].sort((a, b) => a.localeCompare(b)).map(keyword => {
    const option = document.createElement('option'); option.value = keyword; return option;
  }));
  const active = document.getElementById('active-keyword-filters');
  active.replaceChildren(...keywordFilters.map(keyword => {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = `${keyword} ×`; button.title = t('Remove filter {keyword}', { keyword });
    button.addEventListener('click', () => {
      keywordFilters = keywordFilters.filter(item => item !== keyword);
      renderKeywordFilters(); applyPhotoFilters();
    });
    return button;
  }));
}

function addKeywordFilter(value) {
  const keyword = value.trim();
  if (!keyword || keywordFilters.includes(keyword)) return;
  keywordFilters.push(keyword);
  document.getElementById('keyword-filter-input').value = '';
  renderKeywordFilters();
  applyPhotoFilters();
}

function decodeHtmlEntities(text) {
  const doc = new DOMParser().parseFromString(String(text || ''), 'text/html');
  return doc.documentElement.textContent;
}

// ==========================================
// ARBORESCENCE & FILTRES
// ==========================================
function renderFolderTree() {
  folderTree.innerHTML = '';
  
  const allItem = document.createElement('li');
  allItem.className = `folder-tree-item ${currentFolderFilter === null ? 'active' : ''}`;
  allItem.innerHTML = `<span>📚</span> <span>${t('All photos')}</span>`;
  allItem.addEventListener('click', () => selectFolder(null));
  folderTree.appendChild(allItem);
  const roots = folders.map(folder => ({ path: folder.path.replace(/[\\/]+$/, ''), name: folder.path.split(/[\\/]/).filter(Boolean).pop() || folder.path, children: new Map() }));
  const normalize = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  for (const photo of (folderTreePhotos.length ? folderTreePhotos : loadedPhotos)) {
    const photoPath = photo.path.replace(/\\/g, '/');
    const parent = photoPath.slice(0, photoPath.lastIndexOf('/'));
    const root = roots.find(candidate => {
      const rootPath = candidate.path.replace(/\\/g, '/').replace(/\/+$/, '');
      return normalize(parent) === normalize(rootPath) || normalize(parent).startsWith(`${normalize(rootPath)}/`);
    });
    if (!root) continue;
    const rootPath = root.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const relative = parent.slice(rootPath.length).replace(/^\//, '');
    let node = root;
    let currentPath = root.path;
    for (const segment of relative.split('/').filter(Boolean)) {
      currentPath += `/${segment}`;
      if (!node.children.has(segment)) node.children.set(segment, { path: currentPath, name: segment, children: new Map() });
      node = node.children.get(segment);
    }
  }
  const renderNode = (node, parentElement, depth, isRoot = false) => {
    const li = document.createElement('li');
    li.className = `folder-tree-item ${currentFolderFilter && normalize(currentFolderFilter) === normalize(node.path) ? 'active' : ''}`;
    li.style.paddingLeft = `${10 + depth * 16}px`;
    const hasChildren = node.children.size > 0;
    const key = normalize(node.path);
    const expanded = folderTreeExpanded.has(key) || (isRoot && !folderTreeInitialized);
    const toggle = document.createElement('button');
    toggle.className = 'folder-tree-toggle';
    toggle.textContent = hasChildren ? (expanded ? '▾' : '▸') : ' ';
    toggle.setAttribute('aria-label', t(expanded ? 'Collapse folder' : 'Expand folder'));
    toggle.addEventListener('click', event => {
      event.stopPropagation();
      if (expanded) folderTreeExpanded.delete(key); else folderTreeExpanded.add(key);
      folderTreeInitialized = true;
      renderFolderTree();
    });
    const icon = document.createElement('span'); icon.textContent = '📁';
    const label = document.createElement('span'); label.textContent = node.name; label.title = node.path;
    li.append(toggle, icon, label);
    li.addEventListener('click', () => selectFolder(node.path));
    parentElement.appendChild(li);
    if (expanded) for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) renderNode(child, parentElement, depth + 1);
  };
  for (const root of roots) {
    if (!folderTreeInitialized) folderTreeExpanded.add(normalize(root.path));
    renderNode(root, folderTree, 0, true);
  }
  folderTreeInitialized = true;
}

const folderTreeExpanded = new Set();
let folderTreeInitialized = false;
function selectFolder(path) {
  currentFolderFilter = path;
  renderFolderTree();
  loadPhotos();
}

// ==========================================
// VIRTUAL SCROLLING
// ==========================================
function updateVirtualScroller() {
  const width = Math.max(1, gridContainer.clientWidth);
  const gap = thumbnailLayout === 'justified' ? 0 : 6;
  photoLayouts = [];
  maximumPhotoHeight = thumbnailSize;
  if (thumbnailLayout === 'square') {
    columns = Math.max(1, Math.floor(width / thumbnailSize));
    const cellSize = Math.min(thumbnailSize, width / columns);
    for (let i = 0; i < photos.length; i++) photoLayouts.push({ index: i, x: (i % columns) * cellSize, y: Math.floor(i / columns) * cellSize, width: cellSize, height: cellSize });
    layoutContentHeight = Math.ceil(photos.length / columns) * cellSize;
  } else if (thumbnailLayout === 'justified') {
    let y = 0;
    let index = 0;
    const targetHeight = thumbnailSize;
    while (index < photos.length) {
      const row = [];
      let ratioSum = 0;
      let bestCount = 0;
      let bestHeight = targetHeight;
      let bestDeviation = Infinity;
      while (index + row.length < photos.length) {
        const photo = photos[index + row.length];
        const ratio = photo.aspectRatio || (photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 1);
        const count = row.length + 1;
        const candidateRatioSum = ratioSum + ratio;
        const candidateHeight = Math.max(1, (width - gap * (count - 1)) / candidateRatioSum);
        const deviation = Math.abs(candidateHeight - targetHeight);
        if (row.length && deviation > bestDeviation) break;
        row.push({ index: index + row.length, ratio });
        ratioSum = candidateRatioSum;
        bestCount = count;
        bestHeight = candidateHeight;
        bestDeviation = deviation;
        if (candidateHeight <= targetHeight) break;
      }
      // Une fois la cible atteinte, une image supplémentaire pourrait rendre la ligne trop basse.
      // Les largeurs sont calculées depuis la largeur utile, donc chaque ligne remplit exactement le conteneur.
      const available = Math.max(1, width - gap * (bestCount - 1));
      const height = available / ratioSum;
      maximumPhotoHeight = Math.max(maximumPhotoHeight, height);
      let x = 0;
      for (const item of row.slice(0, bestCount)) {
        const itemWidth = item.ratio * height;
        photoLayouts.push({ index: item.index, x, y, width: itemWidth, height });
        x += itemWidth + gap;
      }
      y += height + gap;
      index += bestCount;
    }
    layoutContentHeight = Math.max(0, y - gap);
  } else {
    columns = Math.max(1, Math.floor((width + gap) / (thumbnailSize + gap)));
    const columnWidth = (width - gap * (columns - 1)) / columns;
    const columnBottoms = Array(columns).fill(0);
    for (let i = 0; i < photos.length; i++) {
      let column = 0;
      for (let c = 1; c < columns; c++) if (columnBottoms[c] < columnBottoms[column]) column = c;
      const photo = photos[i];
      const ratio = Math.max(0.2, Math.min(5, photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 1));
      const height = columnWidth / ratio;
      const y = columnBottoms[column];
      photoLayouts.push({ index: i, x: column * (columnWidth + gap), y, width: columnWidth, height });
      columnBottoms[column] = y + height + gap;
      maximumPhotoHeight = Math.max(maximumPhotoHeight, height);
    }
    layoutContentHeight = Math.max(0, ...columnBottoms) - gap;
    photoLayouts.sort((a, b) => a.y - b.y || a.x - b.x);
  }
  scrollContent.style.height = `${Math.max(0, layoutContentHeight)}px`;
  renderVisibleItems();
}

function renderVisibleItems() {
  const scrollTop = gridContainer.scrollTop;
  const overscan = Math.round(gridContainer.clientHeight * THUMBNAIL_OVERSCAN_SCREENS);
  const top = Math.max(0, scrollTop - overscan - maximumPhotoHeight);
  const bottom = scrollTop + gridContainer.clientHeight + overscan;
  let low = 0, high = photoLayouts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (photoLayouts[middle].y < top) low = middle + 1; else high = middle;
  }
  const visible = new Set();
  for (let p = low; p < photoLayouts.length && photoLayouts[p].y < bottom; p++) {
    const layout = photoLayouts[p];
    const i = layout.index;
    const photo = photos[i];
    if (!photo) continue;
    visible.add(i);
    let div = renderedThumbnailNodes.get(i);
    if (!div) {
      div = document.createElement('div');
      div.className = 'thumbnail';
      div.dataset.index = String(i);
      const inner = document.createElement('div'); inner.className = 'thumbnail-inner';
      const thumbnailImage = document.createElement('img');
      thumbnailImage.alt = '';
      thumbnailImage.draggable = false;
      thumbnailImage.decoding = 'async';
      loadThumbnail(thumbnailImage, photo.path, photo);
      const overlay = document.createElement('div'); overlay.className = 'meta-overlay';
      const stars = document.createElement('span'); stars.className = 'thumbnail-rating';
      const flag = document.createElement('span'); flag.className = `flag-indicator flag-${photo.color_flag}`;
      overlay.append(stars, flag); inner.append(thumbnailImage, overlay); div.appendChild(inner);
      div._ratingLabel = stars; div._flag = flag; div._thumbnailImage = thumbnailImage;
      div._selected = false; div._transform = '';
      div.addEventListener('click', event => handleSelection(Number(div.dataset.index), event));
      div.addEventListener('dblclick', () => openFullscreen(Number(div.dataset.index)));
      renderedThumbnailNodes.set(i, div);
      scrollContent.appendChild(div);
    }
    const transform = `translate3d(${layout.x}px, ${layout.y}px, 0)`;
    if (div._transform !== transform) { div.style.transform = transform; div._transform = transform; }
    div._y = layout.y; // utilisé pour prioriser la génération des miniatures proches de la zone visible
    if (div._width !== layout.width) { div.style.width = `${layout.width}px`; div._width = layout.width; }
    if (div._height !== layout.height) { div.style.height = `${layout.height}px`; div._height = layout.height; }
    const padding = thumbnailLayout === 'justified' ? '0' : '4px';
    if (div._padding !== padding) { div.style.padding = padding; div._padding = padding; }
    div.classList.toggle('justified', thumbnailLayout === 'justified');
    const objectFit = thumbnailLayout === 'square' ? 'cover' : 'contain';
    if (div._objectFit !== objectFit) { div._thumbnailImage.style.objectFit = objectFit; div._objectFit = objectFit; }
    const selected = selectedIndices.has(i);
    if (div._selected !== selected) { div.classList.toggle('selected', selected); div._selected = selected; }
    const stars = '★'.repeat(photo.rating);
    if (div._ratingLabel.textContent !== stars) div._ratingLabel.textContent = stars;
    const flagClass = `flag-indicator flag-${photo.color_flag}`;
    if (div._flag.className !== flagClass) div._flag.className = flagClass;
  }
  for (const [index, node] of renderedThumbnailNodes) {
    if (!visible.has(index)) { node.remove(); renderedThumbnailNodes.delete(index); }
  }
}

gridContainer.addEventListener('scroll', () => {
  if (scrollRenderPending) return;
  scrollRenderPending = true;
  requestAnimationFrame(() => { scrollRenderPending = false; renderVisibleItems(); });
});
window.addEventListener('resize', updateVirtualScroller);

// ==========================================
// GESTION DU PLEIN ÉCRAN ET NAVIGATION
// ==========================================
function openFullscreen(index) {
  lastSelectedIndex = index;
  selectedIndices.clear();
  selectedIndices.add(index);
  updateUIOnSelection();
  isFullscreen = true;
  fullscreenRatingPinned = false;
  fullscreenRating.classList.add('hidden');
  fullscreenView.classList.remove('hidden');
  preloadFullscreenImages(index);
}

function closeFullscreen() {
  isFullscreen = false;
  fullscreenView.classList.add('hidden');
  clearTimeout(fullscreenRatingTimeout);
  fullscreenRatingPinned = false;
}

function navigatePhoto(direction) {
  navigateToPhotoIndex(lastSelectedIndex + direction);
}

function navigateToPhotoIndex(index) {
  if (photos.length === 0) return;
  const newIndex = Math.max(0, Math.min(photos.length - 1, index));
  if (newIndex === lastSelectedIndex) return;
  
  lastSelectedIndex = newIndex;
  selectedIndices.clear();
  selectedIndices.add(newIndex);
  updateUIOnSelection();
  preloadFullscreenImages(newIndex);
}

const fullscreenRating = document.getElementById('fullscreen-rating');
function showFullscreenRatingForAWhile() {
  fullscreenRating.classList.remove('hidden');
  clearTimeout(fullscreenRatingTimeout);
  if (!fullscreenRatingPinned) fullscreenRatingTimeout = setTimeout(() => fullscreenRating.classList.add('hidden'), 3000);
}

function updateFullscreenRatingStars() {
  const rating = photos[lastSelectedIndex]?.rating || 0;
  fullscreenRating.querySelectorAll('button').forEach(button => button.classList.toggle('active', Number(button.dataset.rating) <= rating));
}

function preloadFullscreenImages(index) {
  const keep = new Set();
  for (let i = Math.max(0, index - 2); i <= Math.min(photos.length - 1, index + 2); i++) {
    keep.add(i);
    if (!fullscreenImageCache.has(i)) {
      const image = new Image();
      fullscreenImageCache.set(i, image);
      const photoPath = photos[i].path;
      image.onerror = () => checkPhotoMissing(photoPath);
      image.src = photoUrl(photos[i]);
    }
  }
  for (const cachedIndex of fullscreenImageCache.keys()) if (!keep.has(cachedIndex)) fullscreenImageCache.delete(cachedIndex);
}

// Navigation à la molette en plein écran
fullscreenView.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.deltaY > 0) {
    // Molette vers le bas / droite -> Photo suivante
    navigateToPhotoIndex(lastSelectedIndex + 1);
  } else {
    // Molette vers le haut / gauche -> Photo précédente
    navigateToPhotoIndex(lastSelectedIndex - 1);
  }
}, { passive: false });

// Double-clic pour quitter le plein écran
fullscreenView.addEventListener('dblclick', closeFullscreen);
// Image qui ne se charge pas (fichier supprimé hors de l'application) : vérification puis retrait du catalogue si besoin.
// Le backend revérifie sur le disque : une erreur sur une photo qui existe encore ne retire rien.
fullscreenImg.addEventListener('error', () => {
  const path = photos[lastSelectedIndex]?.path;
  if (path && fullscreenImg.getAttribute('src')) checkPhotoMissing(path);
});
fullscreenRating.addEventListener('click', event => event.stopPropagation());
fullscreenRating.querySelectorAll('button').forEach(button => button.addEventListener('click', () => setSelectionRating(Number(button.dataset.rating))));

// ==========================================
// SELECTION MULTIPLE
// ==========================================
function handleSelection(index, event) {
  if (event.shiftKey) {
    const start = Math.min(lastSelectedIndex, index);
    const end = Math.max(lastSelectedIndex, index);
    const direction = index >= lastSelectedIndex ? 1 : -1;
    let lastAdded = lastSelectedIndex;
    let limited = false;
    for (let i = lastSelectedIndex; i >= start && i <= end; i += direction) {
      if (!canAddToSelection(i)) { limited = true; break; }
      selectedIndices.add(i);
      lastAdded = i;
    }
    if (limited) showCompareLimitToast();
    lastSelectedIndex = limited ? lastAdded : index;
  } else if (event.ctrlKey) {
    if (selectedIndices.has(index)) selectedIndices.delete(index);
    else if (canAddToSelection(index)) selectedIndices.add(index);
    else { showCompareLimitToast(); return; }
    lastSelectedIndex = index;
  } else {
    selectedIndices.clear();
    selectedIndices.add(index);
    lastSelectedIndex = index;
  }
  updateUIOnSelection();
}

function updateUIOnSelection() {
  renderVisibleItems(); 
  updateRatingAction();
  updateColorAction();
  renderPreview();
  if (selectedIndices.size > 0 && photos[lastSelectedIndex]) {
    const photo = photos[lastSelectedIndex];
    const imgUrl = photoUrl(photo);
    
    fullscreenImg.src = imgUrl;
    updateFullscreenRatingStars();
    if (isFullscreen) preloadFullscreenImages(lastSelectedIndex);

    document.getElementById('exif-filename').textContent = photo.filename || photo.path.split(/[\\/]/).pop() || '-';
    document.getElementById('exif-date').textContent = photo.date_taken || '-';
    document.getElementById('exif-manufacturer').textContent = photo.manufacturer || '-';
    document.getElementById('exif-model').textContent = photo.camera_model || '-';
    document.getElementById('exif-lens').textContent = photo.lens_model || '-';
    document.getElementById('exif-focal').textContent = photo.focal_length || '-';
    document.getElementById('exif-aperture').textContent = formatAperture(photo.aperture);
    document.getElementById('exif-shutter').textContent = formatShutterSpeed(photo.shutter_speed);
    document.getElementById('exif-iso').textContent = photo.iso ? photo.iso.toString() : '-';
    showPhotoDimensions(photo);
    document.getElementById('exif-size').textContent = `${(photo.file_size / 1024 / 1024).toFixed(2)} MB`;
    document.getElementById('exif-rating').textContent = photo.rating > 0 ? `${'★'.repeat(photo.rating)} (${photo.rating}/5)` : '-';
    document.getElementById('exif-color').textContent = colorFlagLabels.get(photo.color_flag) || '-';
    document.getElementById('exif-keywords').textContent = decodeHtmlEntities(photo.keywords) || '-';
    document.getElementById('exif-caption').textContent = decodeHtmlEntities(photo.caption) || '-';
  }
}

// Normalise ouverture (« f/4 ») et vitesse (« 1/100 s »), y compris les valeurs déjà en base avec un préfixe ou un suffixe en double.
function formatAperture(value) {
  const text = String(value || '').trim().replace(/^(f\/)+/i, '');
  return text ? `f/${text}` : '-';
}

function formatShutterSpeed(value) {
  const text = String(value || '').trim().replace(/\s*s+$/i, '');
  return text ? `${text} s` : '-';
}

// Affiche les dimensions ; si la base n'en a pas (0 x 0), on les apprend depuis l'image réelle.
function showPhotoDimensions(photo) {
  const element = document.getElementById('exif-dim');
  const fromDatabase = photo.width > 0 && photo.height > 0;
  const width = fromDatabase ? photo.width : photo.measuredWidth;
  const height = fromDatabase ? photo.height : photo.measuredHeight;
  if (width > 0 && height > 0) {
    element.textContent = `${width} x ${height} (${(width * height / 1000000).toFixed(1)} MP)`;
    return;
  }
  element.textContent = '-';
  const probe = new Image();
  probe.onload = () => {
    if (probe.naturalWidth <= 0 || probe.naturalHeight <= 0) return;
    photo.measuredWidth = probe.naturalWidth;
    photo.measuredHeight = probe.naturalHeight;
    if (photos[lastSelectedIndex] === photo) showPhotoDimensions(photo);
  };
  probe.src = photoUrl(photo);
}

function updateRatingAction() {
  const panel = document.getElementById('selection-actions');
  if (selectedIndices.size === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const selectedPhoto = photos[selectedIndices.has(lastSelectedIndex) ? lastSelectedIndex : selectedIndices.values().next().value];
  const rating = selectedPhoto?.rating || 0;
  document.querySelectorAll('#selection-rating-stars button').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.rating) <= rating);
  });
  const count = selectedIndices.size;
  document.getElementById('selection-rating-caption').textContent = count > 1
    ? t('{count} photos selected · apply to all', { count })
    : (rating > 0 ? `${labelWithColon('Current rating')} ${rating}/5` : t('Click to set a rating'));
}

let writeToastTimeout = null;

function showWriteToast(message, isWriting = false) {
  const toast = document.getElementById('write-toast');
  if (!toast) return;
  clearTimeout(writeToastTimeout);
  toast.textContent = message;
  toast.classList.remove('hidden');
  toast.classList.toggle('writing', isWriting);
  if (!isWriting) writeToastTimeout = setTimeout(() => toast.classList.add('hidden'), 3500);
}

// Carré de couleur cliquable, utilisé par la barre de filtre et par la barre d'écriture.
function createColorSquare(flag) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `color-square flag-${flag.key}`;
  button.dataset.flag = flag.key;
  button.title = t(flag.label);
  button.setAttribute('aria-label', t(flag.label));
  // Suivi du changement de langue par applyTranslations().
  button.setAttribute('data-i18n-title', flag.label);
  button.setAttribute('data-i18n-aria-label', flag.label);
  button.setAttribute('aria-pressed', 'false');
  return button;
}

function setColorSquareChecked(button, checked) {
  button.classList.toggle('checked', checked);
  button.setAttribute('aria-pressed', String(checked));
}

// Barre d'écriture : met en évidence la couleur de la photo de référence de la sélection (une seule couleur possible).
function updateColorAction() {
  if (selectedIndices.size === 0) return;
  const selectedPhoto = photos[selectedIndices.has(lastSelectedIndex) ? lastSelectedIndex : selectedIndices.values().next().value];
  const flag = selectedPhoto?.color_flag || 'none';
  document.querySelectorAll('#selection-color-flags button').forEach(button => setColorSquareChecked(button, button.dataset.flag === flag));
  const count = selectedIndices.size;
  document.getElementById('selection-color-caption').textContent = count > 1
    ? t('{count} photos selected · apply to all', { count })
    : (colorFlagLabels.has(flag) ? `${labelWithColon('Current color')} ${colorFlagLabels.get(flag)}` : t('Click to set a color'));
}

async function setSelectionColorFlag(flag) {
  const targets = [...selectedIndices].map(index => photos[index]).filter(Boolean);
  if (!targets.length) return;
  // Comme pour la note : si toutes les photos sélectionnées ont déjà cette couleur, on l'efface.
  const finalFlag = targets.every(photo => (photo.color_flag || 'none') === flag) ? 'none' : flag;
  showWriteToast(finalFlag === 'none'
    ? tp('Removing color for {count} file…', targets.length)
    : tp('Writing {count} file (color: {color})…', targets.length, { color: colorFlagLabels.get(finalFlag) }), true);
  // Seule la couleur est envoyée : la note de chaque fichier n'est pas réécrite.
  const results = await Promise.allSettled(targets.map(photo => invoke('update_photo_metadata', {
    id: photo.id,
    path: photo.path,
    colorFlag: finalFlag,
  })));
  const successful = results.flatMap((result, index) => result.status === 'fulfilled' ? [targets[index]] : []);
  const failures = results.filter(result => result.status === 'rejected');
  for (const photo of successful) photo.color_flag = finalFlag;
  updateUIOnSelection();
  const successMessage = finalFlag === 'none'
    ? tp('Color removed for {count} file', successful.length)
    : tp('{count} file modified', successful.length);
  showWriteToast(`${successMessage}${failures.length ? ` · ${tp('{count} failure', failures.length)}` : ''}`);
  if (failures.length) document.getElementById('selection-color-caption').textContent = t('Write failed: {error}', { error: failures[0].reason });
}

async function setSelectionRating(rating) {
  const targets = [...selectedIndices].map(index => photos[index]).filter(Boolean);
  if (!targets.length) return;
  // Si toutes les photos sélectionnées ont déjà exactement cette note, 
  // on considère qu'on veut l'effacer (passer à 0).
  const allAlreadyHaveRating = targets.every(photo => photo.rating === rating);
  const finalRating = allAlreadyHaveRating ? 0 : rating;
  const actionText = finalRating === 0 ? t('Removing rating') : tp('Writing {count} file (rating: {rating})…', targets.length, { rating: finalRating });
  showWriteToast(actionText, true);
  const results = await Promise.allSettled(targets.map(photo => invoke('update_photo_metadata', {
      id: photo.id,
      path: photo.path,
      rating: finalRating,
  })));
  const successful = results.flatMap((result, index) => result.status === 'fulfilled' ? [targets[index]] : []);
  const failures = results.filter(result => result.status === 'rejected');
  for (const photo of successful) photo.rating = finalRating;
  updateUIOnSelection();
  if (isFullscreen && successful.length) showFullscreenRatingForAWhile();
  updateFullscreenRatingStars();
  const successMessage = finalRating === 0 
    ? tp('Rating removed for {count} file', successful.length)
    : tp('{count} file modified', successful.length);
    showWriteToast(`${successMessage}${failures.length ? ` · ${tp('{count} failure', failures.length)}` : ''}`);
    if (failures.length) {
    const firstError = failures[0].reason;
    document.getElementById('selection-rating-caption').textContent = t('Write failed: {error}', { error: firstError });
  }
}

// ==========================================
// TOUCHES CLAVIER
// ==========================================
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  // Show rating bar Shortcut
  if (e.key.toLowerCase() === 'r' && isFullscreen) {
    fullscreenRatingPinned = !fullscreenRatingPinned;
    clearTimeout(fullscreenRatingTimeout);
    if (fullscreenRatingPinned) fullscreenRating.classList.remove('hidden');
    else fullscreenRating.classList.add('hidden');
    return;
  }
  // Modale info
  if (e.key.toLowerCase() === 'i') {
    console.log("Touche I pressée, photo active :", photos[lastSelectedIndex], lastSelectedIndex);
    console.log("lasSelectedIndex :", lastSelectedIndex);
    if (typeof lastSelectedIndex !== 'undefined' && photos[lastSelectedIndex]) {
      showPhotoInfo(photos[lastSelectedIndex]);
      return;
    }
  }
  // Copie vers
  if (e.key.toLowerCase() === 'c') {
    console.log("Touche C pressée, indice photos actives:", selectedIndices);
    if (typeof selectedIndices !== 'undefined' && selectedIndices.size > 0) {
      const selectedPhotos = Array.from(selectedIndices).map(index => photos[index]).filter(Boolean);
      if (selectedPhotos.length > 0) {
        copyPhotosTo(selectedPhotos);
        return;
      }
    }
  }
  // Copie vers
  if (e.key.toLowerCase() === 'c') {
    console.log("Touche C pressée, indice photos actives:", selectedIndices);
    if (typeof selectedIndices !== 'undefined' && selectedIndices.size > 0) {
      const selectedPhotos = Array.from(selectedIndices).map(index => photos[index]).filter(Boolean);
      if (selectedPhotos.length > 0) {
        copyPhotosTo(selectedPhotos);
        return;
      }
    }
  }
  // Suppression
  if (e.key === 'Delete') {
    // Votre code ici 
    console.log("Touche SUPPR pressée, indice photos actives:", selectedIndices);
    if (typeof selectedIndices !== 'undefined' && selectedIndices.size > 0) {
      const selectedPhotos = Array.from(selectedIndices).map(index => photos[index]).filter(Boolean);
      if (selectedPhotos.length > 0) {
        confirmAndDelete(selectedPhotos);
        return;
      }
    }
  }
  // Rating shortcuts
  if (/^[0-5]$/.test(e.key) && selectedIndices.size > 0) {
    e.preventDefault();
    setSelectionRating(Number(e.key));
    return;
  }
  // Zoom de l'aperçu (+ / - / *), hors plein écran
  if (!isFullscreen && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomPreviewSteps(1, null, hoveredPreviewSlot); return; }
    if (e.key === '-') { e.preventDefault(); zoomPreviewSteps(-1, null, hoveredPreviewSlot); return; }
    if (e.key === '*') { e.preventDefault(); togglePreviewActualSize(null, hoveredPreviewSlot); return; }
  }
  // Navigation
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    navigatePhoto(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    navigatePhoto(-1);
  } else if (e.key === 'Escape') {
    if (isFullscreen) closeFullscreen();
  } else if (e.key.toLowerCase() === 'f' || e.key === 'F11') {
    e.preventDefault();
    if (isFullscreen) closeFullscreen();
    else if (photos.length > 0) openFullscreen(lastSelectedIndex);
  }
});

// ==========================================
// MODALE PARAMÈTRES (Gestion des dossiers)
// ==========================================
function renderSettingsFolderList() {
  settingsFolderList.innerHTML = '';
  for (let f of folders) {
    const li = document.createElement('li');
    li.className = 'settings-folder-item';
    li.innerHTML = `
      <span title="${f.path}">${f.path}</span>
      <button class="btn-delete-folder">${t('Delete')}</button>
    `;
    li.querySelector('.btn-delete-folder').addEventListener('click', async () => {
      folders = await invoke('remove_folder', { id: f.id, path: f.path });
      if (currentFolderFilter === f.path) currentFolderFilter = null;
      renderFolderTree();
      renderSettingsFolderList();
      loadPhotos();
    });
    settingsFolderList.appendChild(li);
  }
}

document.getElementById('btn-open-settings').addEventListener('click', () => {
  settingsModal.classList.remove('hidden');
});
document.getElementById('btn-close-settings').addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

// ==========================================
// MODALE À PROPOS (ouverte depuis les Paramètres)
// ==========================================
const aboutModal = document.getElementById('about-modal');
const aboutVersion = document.getElementById('about-version');
async function openAbout() {
  aboutModal.classList.remove('hidden');
  if (aboutVersion.dataset.loaded) return;
  try {
    aboutVersion.textContent = await getVersion();
    aboutVersion.dataset.loaded = 'true';
  } catch (error) {
    console.error('Version indisponible', error);
  }
}
function closeAbout() {
  aboutModal.classList.add('hidden');
}
document.getElementById('btn-open-about').addEventListener('click', openAbout);
document.getElementById('btn-close-about').addEventListener('click', closeAbout);

document.getElementById('about-github-link').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
        await openUrl('https://github.com/alexh3o/photofile');
    } catch (err) {
        console.error("Impossible d'ouvrir le lien :", err);
    }
});

// ESC ferme la fenêtre la plus haute (À propos, puis Paramètres), même si un champ des paramètres a le focus.
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!aboutModal.classList.contains('hidden')) {
    event.preventDefault();
    closeAbout();
  } else if (!settingsModal.classList.contains('hidden')) {
    event.preventDefault();
    settingsModal.classList.add('hidden');
  }
});


// ==========================================
// MODALE Guide (ouverte depuis les Paramètres)
// ==========================================
const guideModal = document.getElementById('guide-modal');
const guideVersion = document.getElementById('guide-version');
async function openGuide() {
  guideModal.classList.remove('hidden');
  if (guideVersion.dataset.loaded) return;
  try {
    guideVersion.textContent = await getVersion();
    guideVersion.dataset.loaded = 'true';
  } catch (error) {
    console.error('Version indisponible', error);
  }
}
function closeGuide() {
  guideModal.classList.add('hidden');
}
document.getElementById('btn-open-guide').addEventListener('click', openGuide);
document.getElementById('btn-close-guide').addEventListener('click', closeGuide);



// ESC ferme la fenêtre la plus haute (À propos, puis Paramètres), même si un champ des paramètres a le focus.
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!guideModal.classList.contains('hidden')) {
    event.preventDefault();
    closeGuide();
  } else if (!settingsModal.classList.contains('hidden')) {
    event.preventDefault();
    settingsModal.classList.add('hidden');
  }
});


document.getElementById('btn-add-folder').addEventListener('click', async () => {
  const dir = await open({ directory: true });
  if (dir) {
    folders = await invoke('add_folder_and_scan', { path: dir });
    renderFolderTree();
    renderSettingsFolderList();
    setTimeout(loadPhotos, 1000);
  }
});

// ==========================================
// BOUTONS VUES & SIDEBAR
// ==========================================
document.getElementById('btn-toggle-sidebar').addEventListener('click', event => {
  const sidebarVisible = sidebarPanel.classList.toggle('hidden') === false;
  event.currentTarget.classList.toggle('active', sidebarVisible);
  setTimeout(updateVirtualScroller, 300);
});

const previewResizer = document.getElementById('preview-resizer');
const mainContent = document.querySelector('.main-content');
document.getElementById('btn-toggle-preview').addEventListener('click', event => {
  const visible = mainContent.classList.toggle('preview-hidden') === false;
  event.currentTarget.classList.toggle('active', visible);
  requestAnimationFrame(updateVirtualScroller);
});
document.getElementById('thumbnail-layout').value = thumbnailLayout;
document.getElementById('thumbnail-layout').addEventListener('change', event => {
  thumbnailLayout = event.target.value;
  localStorage.setItem('thumbnailLayout', thumbnailLayout);
  updateVirtualScroller();
});
const themeSelect = document.getElementById('theme-select');
const selectionColorInput = document.getElementById('accent-color');
const selectionColorSwatches = document.querySelectorAll('.accent-swatch');
const activeButtonColorInput = document.getElementById('active-button-color');
const activeButtonColorSwatches = document.querySelectorAll('.button-swatch');
function syncAppearanceControls() {
  themeSelect.value = appTheme;
  selectionColorInput.value = selectionColor;
  selectionColorSwatches.forEach(swatch => swatch.classList.toggle('active', swatch.dataset.color.toLowerCase() === selectionColor.toLowerCase()));
  activeButtonColorInput.value = activeButtonColor;
  activeButtonColorSwatches.forEach(swatch => swatch.classList.toggle('active', swatch.dataset.color.toLowerCase() === activeButtonColor.toLowerCase()));
}
function setActiveButtonColor(color) {
  activeButtonColor = color;
  localStorage.setItem('activeButtonColor', color);
  applyAppearance();
  syncAppearanceControls();
}
function setSelectionColor(color) {
  selectionColor = color;
  localStorage.setItem('selectionColor', color);
  applyAppearance();
  syncAppearanceControls();
}
themeSelect.addEventListener('change', event => {
  appTheme = event.target.value === 'light' ? 'light' : 'dark';
  localStorage.setItem('appTheme', appTheme);
  applyAppearance();
});
selectionColorInput.addEventListener('input', event => setSelectionColor(event.target.value));
selectionColorSwatches.forEach(swatch => swatch.addEventListener('click', () => setSelectionColor(swatch.dataset.color)));
activeButtonColorInput.addEventListener('input', event => setActiveButtonColor(event.target.value));
activeButtonColorSwatches.forEach(swatch => swatch.addEventListener('click', () => setActiveButtonColor(swatch.dataset.color)));
syncAppearanceControls();

// LANGUE (mémorisée localement) : le français est la langue par défaut.
const languageSelect = document.getElementById('language-select');
languageSelect.replaceChildren(...Object.entries(LANGUAGES).map(([code, { label }]) => new Option(label, code)));
languageSelect.value = getLanguage();
languageSelect.addEventListener('change', event => setLanguage(event.target.value));
applyTranslations();
// Textes construits en JavaScript : régénérés quand la langue change (les éléments data-i18n le sont par applyTranslations).
onLanguageChange(() => {
  renderFolderTree();
  renderSettingsFolderList();
  renderKeywordFilters();
  updateUIOnSelection();
  updateDateFilterUI(parseDateFilter(dateFilterInput.value).error);
  datePicker.setAttribute('aria-label', t('Choose a date or a range'));
  if (isDatePickerOpen()) {
    renderDatePicker();
    positionDatePicker();
  }
});

const thumbnailSizeInput = document.getElementById('thumbnail-size');
const thumbnailSizeValue = document.getElementById('thumbnail-size-value');
thumbnailSizeInput.value = String(thumbnailSize);
thumbnailSizeValue.textContent = `${thumbnailSize} px`;
thumbnailSizeInput.addEventListener('input', event => {
  thumbnailSizeValue.textContent = `${event.target.value} px`;
});
thumbnailSizeInput.addEventListener('change', event => {
  thumbnailSize = Number(event.target.value);
  localStorage.setItem('thumbnailSize', String(thumbnailSize));
  requestAnimationFrame(updateVirtualScroller);
});
previewResizer.addEventListener('pointerdown', event => {
  if (mainContent.classList.contains('preview-hidden')) return;
  previewResizer.setPointerCapture(event.pointerId);
  previewResizer.classList.add('dragging');
  let resizeFrame = null;
  let latestPointerEvent = event;
  const resize = pointerEvent => {
    latestPointerEvent = pointerEvent;
    if (resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      const gridBounds = gridContainer.getBoundingClientRect();
      const mainWidth = mainContent.clientWidth;
      const fixedWidth = sidebarPanel.getBoundingClientRect().width
        + document.getElementById('exif-panel').getBoundingClientRect().width
        + previewResizer.getBoundingClientRect().width;
      const maxGridWidth = Math.max(160, mainWidth - fixedWidth - 160);
      const gridWidth = Math.max(160, Math.min(maxGridWidth, latestPointerEvent.clientX - gridBounds.left));
      mainContent.style.setProperty('--grid-width', `${gridWidth}px`);
      mainContent.classList.add('split-custom');
    });
  };
  const stop = event => {
    if (Number.isFinite(event?.clientX)) latestPointerEvent = event;
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    if (Number.isFinite(latestPointerEvent.clientX)) {
      const gridBounds = gridContainer.getBoundingClientRect();
      const mainWidth = mainContent.clientWidth;
      const fixedWidth = sidebarPanel.getBoundingClientRect().width
        + document.getElementById('exif-panel').getBoundingClientRect().width
        + previewResizer.getBoundingClientRect().width;
      const maxGridWidth = Math.max(160, mainWidth - fixedWidth - 160);
      const gridWidth = Math.max(160, Math.min(maxGridWidth, latestPointerEvent.clientX - gridBounds.left));
      mainContent.style.setProperty('--grid-width', `${gridWidth}px`);
      mainContent.classList.add('split-custom');
    }
    previewResizer.classList.remove('dragging');
    previewResizer.removeEventListener('pointermove', resize);
    previewResizer.removeEventListener('pointerup', stop);
    previewResizer.removeEventListener('pointercancel', stop);
    updateVirtualScroller();
  };
  previewResizer.addEventListener('pointermove', resize);
  previewResizer.addEventListener('pointerup', stop);
  previewResizer.addEventListener('pointercancel', stop);
});
previewResizer.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const fixedWidth = sidebarPanel.getBoundingClientRect().width
    + document.getElementById('exif-panel').getBoundingClientRect().width
    + previewResizer.getBoundingClientRect().width;
  const maxGridWidth = Math.max(160, mainContent.clientWidth - fixedWidth - 160);
  const change = event.key === 'ArrowRight' ? 20 : -20;
  const width = Math.max(160, Math.min(maxGridWidth, gridContainer.clientWidth + change));
  mainContent.style.setProperty('--grid-width', `${width}px`);
  mainContent.classList.add('split-custom');
  updateVirtualScroller();
});

document.getElementById('btn-toggle-exif').addEventListener('click', event => {
  const exifVisible = document.getElementById('exif-panel').classList.toggle('hidden') === false;
  event.currentTarget.classList.toggle('active', exifVisible);
  setTimeout(updateVirtualScroller, 300);
});

document.getElementById('rating-filter').addEventListener('change', applyPhotoFilters);

// Filtre par couleur : plusieurs carrés peuvent être cochés (une photo est affichée si elle a l'une des couleurs cochées).
const colorFilterBar = document.getElementById('color-filter-bar');
colorFilterBar.replaceChildren(...COLOR_FLAGS.map(createColorSquare));
colorFilterBar.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest('.color-square') : null;
  if (!button) return;
  const key = button.dataset.flag;
  if (colorFilters.has(key)) colorFilters.delete(key); else colorFilters.add(key);
  setColorSquareChecked(button, colorFilters.has(key));
  applyPhotoFilters();
});

// Écriture de la couleur sur la sélection : une seule couleur, un nouveau clic sur la couleur active l'efface.
const selectionColorBar = document.getElementById('selection-color-flags');
selectionColorBar.replaceChildren(...COLOR_FLAGS.map(createColorSquare));
selectionColorBar.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest('.color-square') : null;
  if (button) setSelectionColorFlag(button.dataset.flag);
});
document.getElementById('keyword-filter-input').addEventListener('change', event => addKeywordFilter(event.target.value));
document.getElementById('keyword-filter-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); addKeywordFilter(event.target.value); }
});
document.getElementById('recursive-folder-toggle').checked = includeSubfolders;
document.getElementById('recursive-folder-toggle').addEventListener('change', event => {
  includeSubfolders = event.target.checked;
  localStorage.setItem('includeSubfolders', String(includeSubfolders));
  loadPhotos();
});
document.querySelectorAll('#selection-rating-stars button').forEach(button => {
  button.addEventListener('click', () => setSelectionRating(Number(button.dataset.rating)));
});
document.getElementById('btn-rescan-folders').addEventListener('click', async () => {
  await invoke('rescan_all_folders');
  await loadPhotos();
});

// ==========================================
// APERÇU : ZOOM, DÉPLACEMENT ET MODE COMPARER
// ==========================================
const MAX_COMPARE = 4;
const PREVIEW_ZOOM_STEP = 1.4; // +40 % par cran
const PREVIEW_MAX_ZOOM = 2; // 200 % de la résolution réelle (1 pixel image = 2 pixels écran)
const PREVIEW_FIT_MARGIN = 0.95; // marge de la vue entière, comme l'ancien aperçu
let compareMode = false;
let previewSlots = [];
let previewSignature = '';
let previewCenter = { x: 0.5, y: 0.5 }; // point de l'image au centre de la zone, en proportion (partagé entre les images)
let previewDrag = null;
let previewWheelDelta = 0;
let previewLastWheelStep = 0;
let compareDesync = false; // case « Désynchroniser » (mode Comparer uniquement)
let previewDesynced = false; // état réellement appliqué : mode Comparer actif ET case cochée
let hoveredPreviewSlot = null;

function canAddToSelection(index) {
  return selectedIndices.has(index) || !compareMode || selectedIndices.size < MAX_COMPARE;
}

function showCompareLimitToast() {
  showWriteToast(t('Compare mode: {max} photos maximum', { max: MAX_COMPARE }));
}

function limitSelectionForCompare() {
  if (selectedIndices.size <= MAX_COMPARE) return;
  const kept = new Set();
  if (selectedIndices.has(lastSelectedIndex)) kept.add(lastSelectedIndex);
  for (const index of [...selectedIndices].sort((a, b) => a - b)) {
    if (kept.size >= MAX_COMPARE) break;
    kept.add(index);
  }
  selectedIndices = kept;
  showCompareLimitToast();
}

// Échelle exprimée en pixels écran réels par pixel image (1 = 100 %). Échelle CSS = échelle / devicePixelRatio.
function previewCssScale(slot) {
  return (slot.zoom ?? slot.fit) / (window.devicePixelRatio || 1);
}

function previewDisplaySize(slot) {
  const scale = previewCssScale(slot);
  return { width: slot.naturalWidth * scale, height: slot.naturalHeight * scale };
}

function clampPreviewCenter(slot, x, y) {
  const { width, height } = previewDisplaySize(slot);
  const clampAxis = (value, shown, view) => {
    if (shown <= view) return 0.5;
    const half = view / 2 / shown;
    return Math.min(1 - half, Math.max(half, value));
  };
  return { x: clampAxis(x, width, slot.cell.clientWidth), y: clampAxis(y, height, slot.cell.clientHeight) };
}

function layoutPreviewSlot(slot) {
  if (!(slot.naturalWidth > 0 && slot.naturalHeight > 0)) return;
  const cellWidth = slot.cell.clientWidth;
  const cellHeight = slot.cell.clientHeight;
  if (!cellWidth || !cellHeight) return;
  const dpr = window.devicePixelRatio || 1;
  slot.fit = Math.min(1, (cellWidth * PREVIEW_FIT_MARGIN * dpr) / slot.naturalWidth, (cellHeight * PREVIEW_FIT_MARGIN * dpr) / slot.naturalHeight);
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
  slot.img.style.transform = `translate(${slot.tx}px, ${slot.ty}px) scale(${previewCssScale(slot)})`;
}

function renderPreviewTransforms() {
  previewSlots.forEach(layoutPreviewSlot);
}

function createPreviewSlot(photo) {
  const cell = document.createElement('div');
  cell.className = 'preview-cell';
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  const slot = { photo, cell, img, naturalWidth: 0, naturalHeight: 0, fit: 1, zoom: null, tx: 0, ty: 0, displayWidth: 0, displayHeight: 0, center: { x: 0.5, y: 0.5 } };
  img.addEventListener('load', () => {
    if (!previewSlots.includes(slot)) return;
    if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) return;
    slot.naturalWidth = img.naturalWidth;
    slot.naturalHeight = img.naturalHeight;
    img.style.width = `${slot.naturalWidth}px`;
    img.style.height = `${slot.naturalHeight}px`;
    cell.classList.add('loaded');
    layoutPreviewSlot(slot);
  });
  img.addEventListener('error', () => checkPhotoMissing(photo.path));
  img.src = photoUrl(photo);
  cell.appendChild(img);
  return slot;
}

// Mode normal : la photo courante. Mode Comparer : la sélection (4 max), dans l'ordre de la grille.
function currentPreviewPhotos() {
  if (compareMode) {
    return [...selectedIndices].sort((a, b) => a - b).slice(0, MAX_COMPARE).map(index => photos[index]).filter(Boolean);
  }
  const photo = photos[lastSelectedIndex];
  return photo ? [photo] : [];
}

function renderPreview() {
  const list = currentPreviewPhotos();
  const signature = list.map(photo => photo.path).join('|');
  if (signature === previewSignature) return; // mêmes images : on garde zoom et position
  previewSignature = signature;
  previewCenter = { x: 0.5, y: 0.5 };
  previewDrag = null;
  hoveredPreviewSlot = null;
  previewSlots = list.map(createPreviewSlot);
  previewStage.className = list.length ? `preview-stage count-${list.length}` : 'preview-stage';
  previewStage.replaceChildren(...previewSlots.map(slot => slot.cell));
  renderPreviewTransforms();
}

function previewSlotFromEvent(event) {
  const cell = event.target instanceof Element ? event.target.closest('.preview-cell') : null;
  return cell ? previewSlots.find(slot => slot.cell === cell) || null : null;
}

// Point de l'image situé sous le curseur (en proportion de l'image), pour zoomer autour de lui.
function previewAnchorAt(slot, clientX, clientY) {
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

// Centre de la zone affichée : propre à chaque image en mode désynchronisé, sinon partagé.
function previewCenterOf(slot) {
  return previewDesynced ? slot.center : previewCenter;
}

function setPreviewCenter(slot, center) {
  if (previewDesynced) slot.center = center;
  else previewCenter = center;
}

// En mode désynchronisé, une action vise l'image concernée ; sinon elle s'applique à toutes.
function previewSlotsToAffect(targetSlot) {
  const loaded = previewSlots.filter(slot => slot.naturalWidth > 0);
  return previewDesynced && targetSlot ? loaded.filter(slot => slot === targetSlot) : loaded;
}

// Applique le passage synchronisé / désynchronisé sans déplacer les images à l'écran.
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

// computeTarget(slot, échelleActuelle) renvoie la nouvelle échelle, ou null pour la vue entière.
function zoomPreview(computeTarget, anchor, targetSlot = null) {
  const slots = previewSlotsToAffect(targetSlot);
  if (!slots.length) return;
  for (const slot of slots) {
    const target = computeTarget(slot, slot.zoom ?? slot.fit);
    slot.zoom = target === null || target <= slot.fit + 1e-6 ? null : Math.min(PREVIEW_MAX_ZOOM, target);
  }
  if (previewDesynced) {
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
}

function zoomPreviewSteps(steps, anchor, targetSlot = null) {
  zoomPreview((slot, current) => current * Math.pow(PREVIEW_ZOOM_STEP, steps), anchor, targetSlot);
}

// 100 % (1 pixel image = 1 pixel écran) ; si toutes les images y sont déjà, retour à la vue entière.
function togglePreviewActualSize(anchor, targetSlot = null) {
  const slots = previewSlotsToAffect(targetSlot);
  if (!slots.length) return;
  const atActualSize = slots.every(slot => Math.abs((slot.zoom ?? slot.fit) - 1) < 0.005);
  zoomPreview(() => (atActualSize ? null : 1), anchor, targetSlot);
}

previewStage.addEventListener('wheel', event => {
  const slot = previewSlotFromEvent(event);
  if (!slot) return;
  event.preventDefault();
  const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 33 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 400 : 1);
  let steps = 0;
  if (Math.abs(delta) >= 50) {
    const now = performance.now();
    if (now - previewLastWheelStep < 40) return;
    previewLastWheelStep = now;
    previewWheelDelta = 0;
    steps = Math.sign(delta);
  } else {
    previewWheelDelta += delta;
    steps = Math.trunc(previewWheelDelta / 100);
    previewWheelDelta -= steps * 100;
  }
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
  previewDrag = { slot, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  slot.cell.setPointerCapture(event.pointerId);
  slot.cell.classList.add('dragging');
});

previewStage.addEventListener('pointermove', event => {
  if (!previewDrag || event.pointerId !== previewDrag.pointerId) return;
  const { slot } = previewDrag;
  const dx = event.clientX - previewDrag.x;
  const dy = event.clientY - previewDrag.y;
  previewDrag.x = event.clientX;
  previewDrag.y = event.clientY;
  if (slot.zoom === null || !(slot.displayWidth > 0 && slot.displayHeight > 0)) return;
  const currentCenter = previewCenterOf(slot);
  setPreviewCenter(slot, clampPreviewCenter(slot, currentCenter.x - dx / slot.displayWidth, currentCenter.y - dy / slot.displayHeight));
  renderPreviewTransforms();
});

function endPreviewDrag(event) {
  if (!previewDrag || event.pointerId !== previewDrag.pointerId) return;
  previewDrag.slot.cell.classList.remove('dragging');
  previewDrag = null;
}
previewStage.addEventListener('pointerup', endPreviewDrag);
previewStage.addEventListener('pointercancel', endPreviewDrag);

new ResizeObserver(() => renderPreviewTransforms()).observe(previewStage);

// Image survolée : cible des touches + / - / * en mode désynchronisé
previewStage.addEventListener('pointerover', event => {
  const slot = previewSlotFromEvent(event);
  if (slot) hoveredPreviewSlot = slot;
});
previewStage.addEventListener('pointerleave', () => { hoveredPreviewSlot = null; });

document.getElementById('compare-desync-toggle').addEventListener('change', event => {
  compareDesync = event.target.checked;
  updatePreviewSyncMode();
  event.target.blur(); // sinon les touches + / - / * seraient ignorées tant que la case a le focus
});

document.getElementById('btn-toggle-compare').addEventListener('click', event => {
  compareMode = !compareMode;
  event.currentTarget.classList.toggle('active', compareMode);
  const desyncOption = document.getElementById('compare-desync');
  desyncOption.classList.toggle('hidden', !compareMode);
  desyncOption.style.display = compareMode ? '' : 'none';
  updatePreviewSyncMode();
  if (compareMode) {
    if (mainContent.classList.contains('preview-hidden')) {
      mainContent.classList.remove('preview-hidden');
      document.getElementById('btn-toggle-preview').classList.add('active');
      requestAnimationFrame(updateVirtualScroller);
    }
    limitSelectionForCompare();
  }
  updateUIOnSelection();
});

// ==========================================
// DÉFILEMENT DE LA GRILLE AU GLISSER
// ==========================================
const GRID_DRAG_THRESHOLD = 5; // pixels avant de considérer un glissement (sinon c'est un clic)
let gridDrag = null;
let suppressGridClick = false;

gridContainer.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.pointerType === 'touch') return;
  const bounds = gridContainer.getBoundingClientRect();
  if (event.clientX - bounds.left >= gridContainer.clientWidth) return; // barre de défilement
  gridDrag = { pointerId: event.pointerId, startY: event.clientY, startScrollTop: gridContainer.scrollTop, active: false };
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
});

function endGridDrag(event) {
  if (!gridDrag || event.pointerId !== gridDrag.pointerId) return;
  if (gridDrag.active) {
    suppressGridClick = true; // le clic qui suit un glissement ne doit pas changer la sélection
    setTimeout(() => { suppressGridClick = false; }, 0);
    gridContainer.classList.remove('dragging-scroll');
  }
  gridDrag = null;
}
// Bloque le glisser-déposer natif (image fantôme, icône « interdit ») qui interrompt le défilement
gridContainer.addEventListener('dragstart', event => event.preventDefault());
gridContainer.addEventListener('pointerup', endGridDrag);
gridContainer.addEventListener('pointercancel', endGridDrag);
gridContainer.addEventListener('click', event => {
  if (!suppressGridClick) return;
  suppressGridClick = false;
  event.stopPropagation();
  event.preventDefault();
}, true);

// ==========================================
// FILTRE DE DATE (date de prise de vue EXIF)
// ==========================================
let dateFilter = null; // { from, to } au format AAAAMMJJHHmmss (nombres), ou null = aucun filtre
const dateFilterInput = document.getElementById('date-filter-input');
const dateFilterClear = document.getElementById('date-filter-clear');
const dateFilterCalendar = document.getElementById('date-filter-calendar');
const dateFilterError = document.getElementById('date-filter-error');

// Extrait la date et l'heure d'un texte EXIF quel que soit le séparateur (« 2026:08:12 14:30:00 », « 2026-08-12 14:30:00 »…).
// Renvoie un nombre AAAAMMJJHHmmss (heure à 00:00:00 si absente), ou null.
function extractTimeKey(text) {
  const match = /(\d{4})\D?(\d{2})\D?(\d{2})(?:\D+(\d{2})\D?(\d{2})(?:\D?(\d{2}))?)?/.exec(String(text || ''));
  if (!match) return null;
  if (Number(match[1] + match[2] + match[3]) < 10000101) return null; // ignore les dates vides du type 0000:00:00
  return Number(`${match[1]}${match[2]}${match[3]}${match[4] || '00'}${match[5] || '00'}${match[6] || '00'}`);
}

function photoTimeKey(photo) {
  if (photo.timeKey === undefined) photo.timeKey = extractTimeKey(photo.date_taken);
  return photo.timeKey;
}

// Jour de prise de vue au format AAAAMMJJ, ou null.
function photoDateKey(photo) {
  const key = photoTimeKey(photo);
  return key === null ? null : Math.floor(key / 1000000);
}

// Le filtre couvre du premier au dernier instant de la période saisie, bornes incluses.
function matchesDateFilter(photo) {
  if (!dateFilter) return true;
  const key = photoTimeKey(photo);
  return key !== null && key >= dateFilter.from && key <= dateFilter.to;
}

function isValidDateKey(key) {
  const year = Math.floor(key / 10000);
  const month = Math.floor(key / 100) % 100;
  const day = key % 100;
  const date = new Date(year, month - 1, day);
  return year >= 1000 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// Un jeton AAAA, AAAAMM, AAAAMMJJ, AAAAMMJJHH ou AAAAMMJJHHmm : renvoie le premier et le dernier instant
// (AAAAMMJJHHmmss) de la période. Les parties absentes valent le début (01, 00) ou la fin (12, 31, 23, 59, 59).
function parseDateToken(token) {
  const year = Number(token.slice(0, 4));
  const month = token.length >= 6 ? Number(token.slice(4, 6)) : null;
  const day = token.length >= 8 ? Number(token.slice(6, 8)) : null;
  const hour = token.length >= 10 ? Number(token.slice(8, 10)) : null;
  const minute = token.length >= 12 ? Number(token.slice(10, 12)) : null;
  if (year < 1000) return null;
  if (month !== null && (month < 1 || month > 12)) return null;
  if (day !== null && !isValidDateKey(year * 10000 + month * 100 + day)) return null;
  if (hour !== null && hour > 23) return null;
  if (minute !== null && minute > 59) return null;
  const pad = value => String(value).padStart(2, '0');
  const build = (m, d, h, mi, s) => Number(`${year}${pad(m)}${pad(d)}${pad(h)}${pad(mi)}${pad(s)}`);
  return {
    start: build(month ?? 1, day ?? 1, hour ?? 0, minute ?? 0, 0),
    end: build(month ?? 12, day ?? 31, hour ?? 23, minute ?? 59, 59),
  };
}

function parseDateFilter(text) {
  const compact = text.replace(/\s+/g, '');
  if (!compact) return { filter: null };
  const token = '(\\d{4}|\\d{6}|\\d{8}|\\d{10}|\\d{12})';
  const match = new RegExp(`^${token}(?:-${token})?$`).exec(compact);
  if (!match) return { error: t('Date format error') };
  const first = parseDateToken(match[1]);
  const second = match[2] ? parseDateToken(match[2]) : first;
  if (!first || !second) return { error: t('Invalid date') };
  if (!match[2]) return { filter: { from: first.start, to: first.end } };
  // Plage : début du premier jeton → fin du second. Si c'est à l'envers, on inverse les deux jetons.
  const [begin, finish] = first.start <= second.end ? [first, second] : [second, first];
  return { filter: { from: begin.start, to: finish.end } };
}

function updateDateFilterUI(error = '') {
  dateFilterClear.classList.toggle('has-value', dateFilterInput.value.trim() !== '');
  dateFilterInput.classList.toggle('invalid', Boolean(error));
  dateFilterInput.setAttribute('aria-invalid', error ? 'true' : 'false');
  dateFilterError.textContent = error;
}

// Applique le contenu du champ : vide = pas de filtre ; saisie incomplète ou invalide = filtre précédent conservé.
function setDateFilterFromInput() {
  const result = parseDateFilter(dateFilterInput.value);
  updateDateFilterUI(result.error);
  if (result.error) return;
  const next = result.filter;
  const unchanged = next === dateFilter || (next && dateFilter && next.from === dateFilter.from && next.to === dateFilter.to);
  if (unchanged) return;
  dateFilter = next;
  applyPhotoFilters();
}

dateFilterInput.addEventListener('input', () => {
  closeDatePicker();
  setDateFilterFromInput();
});

dateFilterClear.addEventListener('click', () => {
  dateFilterInput.value = '';
  closeDatePicker();
  setDateFilterFromInput();
});

// --- Calendrier (date unique ou plage) ---
const datePicker = document.createElement('div');
datePicker.className = 'date-picker';
datePicker.setAttribute('role', 'dialog');
datePicker.setAttribute('aria-label', t('Choose a date or a range'));
datePicker.style.display = 'none';
document.body.appendChild(datePicker);
// Initiales des jours (semaine commençant le lundi) et mois, selon la langue courante : le 1er janvier 2024 est un lundi.
const weekdayLabels = () => Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(getLanguage(), { weekday: 'narrow' }).format(new Date(2024, 0, 1 + day)));
const pickerMonthFormatter = () => new Intl.DateTimeFormat(getLanguage(), { month: 'long', year: 'numeric' });
let pickerYear = 0;
let pickerMonth = 0; // 0-11
let pickStart = null;
let pickEnd = null;
let pickAwaitingEnd = false;

function isDatePickerOpen() {
  return datePicker.style.display !== 'none';
}

function closeDatePicker() {
  datePicker.style.display = 'none';
}

function todayDateKey() {
  const now = new Date();
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

function latestPhotoDateKey() {
  let latest = null;
  for (const photo of loadedPhotos) {
    const key = photoDateKey(photo);
    if (key !== null && (latest === null || key > latest)) latest = key;
  }
  return latest;
}

function positionDatePicker() {
  const rect = dateFilterCalendar.getBoundingClientRect();
  const width = datePicker.offsetWidth;
  const height = datePicker.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  datePicker.style.left = `${left}px`;
  datePicker.style.top = `${top}px`;
}

function renderDatePicker() {
  const first = new Date(pickerYear, pickerMonth, 1);
  const offset = (first.getDay() + 6) % 7; // la semaine commence le lundi
  const daysInMonth = new Date(pickerYear, pickerMonth + 1, 0).getDate();
  const today = todayDateKey();
  const low = pickStart === null ? null : Math.min(pickStart, pickEnd ?? pickStart);
  const high = pickStart === null ? null : Math.max(pickStart, pickEnd ?? pickStart);
  let cells = weekdayLabels().map(label => `<span class="date-picker-weekday">${label}</span>`).join('');
  for (let i = 0; i < offset; i++) cells += '<span></span>';
  for (let day = 1; day <= daysInMonth; day++) {
    const key = pickerYear * 10000 + (pickerMonth + 1) * 100 + day;
    const classes = ['date-picker-day'];
    if (key === today) classes.push('today');
    if (low !== null && key > low && key < high) classes.push('in-range');
    if (key === low || key === high) classes.push('selected');
    cells += `<button type="button" class="${classes.join(' ')}" data-key="${key}">${day}</button>`;
  }
  datePicker.innerHTML = `
    <div class="date-picker-header">
      <button type="button" data-nav="-12" title="${t('Previous year')}" aria-label="${t('Previous year')}">«</button>
      <button type="button" data-nav="-1" title="${t('Previous month')}" aria-label="${t('Previous month')}">‹</button>
      <span class="date-picker-title">${pickerMonthFormatter().format(first)}</span>
      <button type="button" data-nav="1" title="${t('Next month')}" aria-label="${t('Next month')}">›</button>
      <button type="button" data-nav="12" title="${t('Next year')}" aria-label="${t('Next year')}">»</button>
    </div>
    <div class="date-picker-grid">${cells}</div>
    <div class="date-picker-hint">${t('Click a day, then a second one for a range.')}</div>`;
}

function openDatePicker() {
  const fromDay = dateFilter ? Math.floor(dateFilter.from / 1000000) : null;
  const toDay = dateFilter ? Math.floor(dateFilter.to / 1000000) : null;
  const key = fromDay ?? latestPhotoDateKey() ?? todayDateKey();
  pickerYear = Math.floor(key / 10000);
  pickerMonth = (Math.floor(key / 100) % 100) - 1;
  pickStart = fromDay;
  pickEnd = fromDay !== null && toDay !== fromDay ? toDay : null;
  pickAwaitingEnd = false;
  datePicker.style.display = 'block';
  renderDatePicker();
  positionDatePicker();
}

function applyPickerSelection() {
  const low = Math.min(pickStart, pickEnd ?? pickStart);
  const high = Math.max(pickStart, pickEnd ?? pickStart);
  dateFilterInput.value = low === high ? String(low) : `${low}-${high}`;
  setDateFilterFromInput();
}

// 1er clic : jour unique (filtre appliqué tout de suite). 2e clic : plage, ou même jour pour valider le jour unique.
function pickDate(key) {
  if (!pickAwaitingEnd) {
    pickStart = key;
    pickEnd = null;
    pickAwaitingEnd = true;
    applyPickerSelection();
    renderDatePicker();
    return;
  }
  pickAwaitingEnd = false;
  if (key !== pickStart) {
    pickEnd = key;
    applyPickerSelection();
  }
  closeDatePicker();
}

datePicker.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest('button') : null;
  if (!button) return;
  if (button.dataset.nav) {
    const shifted = new Date(pickerYear, pickerMonth + Number(button.dataset.nav), 1);
    pickerYear = shifted.getFullYear();
    pickerMonth = shifted.getMonth();
    renderDatePicker();
    positionDatePicker();
  } else if (button.dataset.key) {
    pickDate(Number(button.dataset.key));
  }
});

dateFilterCalendar.addEventListener('click', () => {
  if (isDatePickerOpen()) closeDatePicker();
  else openDatePicker();
});

document.addEventListener('pointerdown', event => {
  if (!isDatePickerOpen()) return;
  const target = event.target;
  if (target instanceof Node && (datePicker.contains(target) || dateFilterCalendar.contains(target))) return;
  closeDatePicker();
}, true);
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && isDatePickerOpen()) closeDatePicker();
});
window.addEventListener('resize', closeDatePicker);

// ==========================================
// MENU CONTEXTUEL DES MINIATURES (voir photo-actions.js)
// ==========================================
// Retire de l'affichage les photos dont le fichier vient d'être supprimé, sans recharger la bibliothèque ni remonter la grille.
// La sélection passe à la photo qui prend la place de la première supprimée.
function removePhotosFromLibrary(paths, { keepSelection = false } = {}) {
  const removed = new Set(paths);
  if (removed.size === 0) return;
  const firstRemovedIndex = photos.findIndex(photo => removed.has(photo.path));
  // Retrait en arrière-plan (fichier disparu détecté à l'affichage) : la sélection en cours est conservée si elle n'est pas concernée.
  const keptPaths = keepSelection ? [...selectedIndices].map(index => photos[index]?.path).filter(path => path && !removed.has(path)) : [];
  const keptLastPath = keptPaths.length && !removed.has(photos[lastSelectedIndex]?.path) ? photos[lastSelectedIndex]?.path : null;
  for (const path of removed) thumbnailCacheLookups.delete(path);
  const treeSharesLibrary = folderTreePhotos === loadedPhotos;
  loadedPhotos = loadedPhotos.filter(photo => !removed.has(photo.path));
  folderTreePhotos = treeSharesLibrary ? loadedPhotos : folderTreePhotos.filter(photo => !removed.has(photo.path));
  fullscreenImageCache.clear();
  renderFolderTree();
  renderKeywordFilters();
  if (loadedPhotos.length === 0) {
    applyPhotoFilters(); // plus aucune photo : même traitement que des filtres sans résultat
    return;
  }
  photos = photos.filter(photo => !removed.has(photo.path));
  for (const node of renderedThumbnailNodes.values()) node.remove();
  renderedThumbnailNodes.clear();
  selectedIndices.clear();
  if (keptPaths.length > 0) {
    const indexByPath = new Map(photos.map((photo, index) => [photo.path, index]));
    for (const path of keptPaths) if (indexByPath.has(path)) selectedIndices.add(indexByPath.get(path));
    lastSelectedIndex = indexByPath.get(keptLastPath) ?? selectedIndices.values().next().value ?? 0;
  } else if (photos.length > 0) {
    lastSelectedIndex = Math.max(0, Math.min(firstRemovedIndex < 0 ? lastSelectedIndex : firstRemovedIndex, photos.length - 1));
    selectedIndices.add(lastSelectedIndex);
  } else {
    lastSelectedIndex = 0;
  }
  updateVirtualScroller();
  if (photos.length > 0) {
    updateUIOnSelection();
  } else {
    renderPreview();
    fullscreenImg.src = '';
    updateRatingAction();
  }
}

initPhotoActions({
  getPhotos: () => photos,
  getSelectedIndices: () => selectedIndices,
  selectOnly: index => {
    selectedIndices.clear();
    selectedIndices.add(index);
    lastSelectedIndex = index;
    updateUIOnSelection();
  },
  removePhotos: removePhotosFromLibrary,
  showToast: showWriteToast,
});

// ==========================================
// SYNCHRONISATION AVEC LES MODIFICATIONS EXTERNES (ajouts, éditions, métadonnées, suppressions)
// ==========================================
// Lancée au démarrage et quand la fenêtre reprend le focus (on revient en général d'un autre programme après une édition) :
// aucun minuteur. Le backend compare taille et date de modification et ne relit que les fichiers concernés. Pour rester
// légère, l'intervalle minimal entre deux passages vaut 10 fois la durée du dernier (au moins 10 s).
const LIBRARY_SYNC_MIN_INTERVAL_MS = 10000;
let librarySyncRunning = false;
let librarySyncNotBefore = 0;

async function syncLibraryWithDisk() {
  if (librarySyncRunning || Date.now() < librarySyncNotBefore) return;
  librarySyncRunning = true;
  const startedAt = Date.now();
  try {
    const changes = await invoke('sync_library');
    if (changes.added.length || changes.updated.length || changes.removed.length) await refreshLibraryAfterSync(changes);
  } catch (error) {
    console.debug('Synchronisation avec le disque impossible', error);
  } finally {
    librarySyncNotBefore = Date.now() + Math.max(LIBRARY_SYNC_MIN_INTERVAL_MS, (Date.now() - startedAt) * 10);
    librarySyncRunning = false;
  }
}

// Recharge la liste depuis la base sans remonter la grille ni perdre la sélection (retrouvée par chemin).
async function refreshLibraryAfterSync(changes) {
  const folderAtStart = currentFolderFilter;
  const known = new Map(loadedPhotos.map(photo => [photo.path, photo]));
  const modified = new Set(changes.updated);
  const query = folderFilter => invoke('get_photos_paginated', { offset: 0, limit: 50000, folderFilter, recursive: includeSubfolders });
  const [fresh, everything] = await Promise.all([query(folderAtStart), folderAtStart === null ? null : query(null)]);
  if (folderAtStart !== currentFolderFilter) return; // dossier changé pendant le chargement : le rechargement normal fait foi
  for (const photo of fresh) {
    const previous = known.get(photo.path);
    if (!previous || modified.has(photo.path)) continue;
    // Ratio et dimensions appris depuis les images : conservés pour ne pas redéclencher la disposition.
    if (previous.aspectRatio) photo.aspectRatio = previous.aspectRatio;
    if (previous.measuredWidth) { photo.measuredWidth = previous.measuredWidth; photo.measuredHeight = previous.measuredHeight; }
  }
  for (const path of modified) {
    photoVersions.set(path, Date.now());
    thumbnailCacheLookups.delete(path); // la miniature du cache change de nom avec la taille et la date du fichier
  }
  if (modified.size) {
    previewSignature = ''; // force le rechargement de l'aperçu
    fullscreenImageCache.clear();
  }
  loadedPhotos = fresh;
  folderTreePhotos = everything ?? fresh;
  renderFolderTree();
  renderKeywordFilters();
  applyPhotoFilters({ keepState: true });
}

window.addEventListener('focus', () => { syncLibraryWithDisk(); });

// DÉMARRAGE
loadFolders();
loadPhotos().then(() => setTimeout(syncLibraryWithDisk, 2000)); // délai : laisse d'abord se charger les premières miniatures
