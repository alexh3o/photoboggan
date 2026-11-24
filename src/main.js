import './styles.css';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { DEFAULTS, readBool, readChoice, readNumber, readStored } from './settings-defaults.js';
import { APP_FONTS, APP_FONT_IDS, fontStack } from './app-fonts.js';
import { LANGUAGES, getLanguage, setLanguage, applyTranslations, t, tp, labelWithColon, onLanguageChange, normalizeSearch } from './i18n.js';
import { initPhotoActions, showPhotoInfo, copyPhotosTo, copyPhotosToClipboard, resizePhotos, confirmAndDelete, renamePhoto, revealInFileManager, openWithFirstProgram, confirmDialog, openContextMenuAt, showIntegrityReport } from './photo-actions.js';
import { initMetadataSettings, topPickFormat, onPickOrderChange } from './metadata-settings.js';
import { initSemanticSettings, onSemanticOfflineChanged, onSemanticChange, onAnalysisChanged, isSemanticEnabled, analyseContent } from './semantic-settings.js';
import {
  initSemanticResults, isSemanticSearchActive, getSemanticSearch, getSemanticSortMode,
  semanticRankOrder, loadSemanticPhotos, matchesSemanticCut, renderSemanticBanner,
  renderSemanticKeywordActions, abandonSemanticSearch, exitSemanticSearch,
  findSimilarContent, findKeywordCandidates,
} from './semantic-results.js';
import { initKeywordSuggestions, guessedKeywordEntries, syncKeywordSuggestions, suggestionFor, suggestionsLoaded, suggestedExtraPhotos, describeGuesses, setSuggestedCount } from './semantic-keywords.js';
import { initRawSettings, hasRawSearchCriteria } from './raw-settings.js';
import { folderOf } from './find-raw.js';
import {
  initFindRawMode, isRawSearchActive, getRawSearch, matchesRawSearchScope,
  renderRawSearchBanner, abandonRawSearch, exitRawSearch, findRawFor,
} from './find-raw-mode.js';
import { initMarkingSettings, isColorEnabled, isPickEnabled, onMarkingSettingsChange } from './marking-settings.js';
import { initMetadataWrites, confirmCloseWithPendingEdits, hasSelectionEdits, resolvePendingSelection, runLocked, isWriteLocked, photosMoved, photosRemoved, keepFocusInModal, failureDetailsAction } from './metadata-writes.js';
import { initGuide } from './guide.js';
import { initBatchRename, openBatchRename } from './batch-rename.js';
import { splitFileName } from './batch-rename-engine.js';
import { initUndo, pushUndo, runUndo, hasUndo, undoToastActions, historyToastAction, formatUndoToast, itemKindForPaths, baseName } from './undo.js';
import { initStats } from './stats.js';
import { initKeywordsPanel, refreshKeywordsPanel, addPendingKeyword, invalidateKeywordTree, handleSideTabShortcut, focusSideTabField, setKeywordsCompareMode, renameKeywordById, openSideTab } from './keywords-panel.js';
import { initInfoAuthor, renderInfoAuthor } from './info-author.js';
import { initFileDates, renderFileDates } from './file-dates.js';
import { initAuthorFilters } from './author-filters.js';
import { initDescriptionPanel, refreshDescriptionPanel } from './description-panel.js';
import { initLocationPanel, refreshLocation, onMapAccessChanged } from './location-panel.js';
import { reloadAllMaps } from './map-view.js';
import { initMapsSettings } from './maps-settings.js';
import { initUpdateCheck, onUpdateAccessChanged } from './update-check.js';
import { initMapMode, getVisibleZone, isMapModeOpen, isMapZoneFilterActive, clearMapZoneFilter, requestCloseMapMode, closeMapModeNow, refreshMapMode, passesMapFilter, mapPrefilter, hasPendingPosition, onMapModeAccessChanged } from './map-mode.js';
import { initListView, closeListView, refreshListView, onFacesDataChanged, isListGridSortActive, getListGridComparator, formatListGridScrollPosition, clearListSortForGridSort } from './list-view.js';
import { initPrivateZonesModal } from './private-zones-modal.js';
import { initGeoTools, eraseGeolocation, restoreGeolocation, hasErasedLocation, hasGps } from './geo-tools.js';
import { createFilterTag, addIncludeExcludeMenu } from './filter-tags.js';
import { createFilterSuggest } from './filter-suggest.js';
import { initFacesPanel, refreshFaces, hasPersonFilters, personFilterMatches, clearPersonFilters, setPersonFilterIds, photoMatchesPersonIds, getPersonFilterIds, getExcludedPersonFilterIds, layoutPreviewFaces, toggleFaceRegions, getFaceDisplay, setFaceDisplayMode, setFaceDisplayExtra, armFaceDrawing, isFaceDetectionEnabled, openFaceScanDialog, getPersonRoot, eraseFaceData, proposeDeletePersons, clearPersonSelection, onOfflineModeChanged } from './faces-panel.js';
import { fillSortButton, initFacesGrid, isFacesViewOpen, hasFaceSelection, openFacesView, closeFacesView, requestCloseFacesView, reloadFacesView, restoreFaceSelection } from './faces-grid.js';
import { initAlbumsPanel, clearAlbumSelection, getSelectedAlbum, getAlbumContext, removePhotosFromSelectedAlbum, refreshAlbums, getAlbumNodes, isAlbumsSectionExpanded, setAlbumCount, setAlbumCounts, setAlbumDirty, isSelectedAlbumDirty, confirmLeaveAlbum, restoreAlbumSelection } from './albums-panel.js';
import { initPersonsView, isPersonsViewOpen, openPersonsView, closePersonsView, reloadPersonsView } from './persons-view.js';
import { initHistogram, syncHistogram, cycleHistogramState } from './histogram.js';
import { initShootingFilters, matchesShootingState, shootingPrefilter } from './shooting-filters.js';
import { initFormatFilters, matchesFormatState, formatPrefilterExtensions, RAW_EXTENSIONS, HEIF_EXTENSIONS, VIDEO_EXTENSIONS } from './format-filters.js';
import { formatBytes } from './duplicates.js';
import { initDuplicatesModal } from './duplicates-modal.js';
import {
  initDuplicatesView, isDuplicateSearchActive, getDuplicateSearch, photoFormat,
  indexDuplicateGroups, computeDuplicateSeparators, renderDuplicateBanner,
  abandonDuplicateSearch, exitDuplicateSearch, showReadyDuplicateResults,
  findDuplicateImages, openDuplicatesDialog,
} from './duplicates-view.js';
import { initSlideshow, startSlideshow, stopSlideshow, toggleSlideshowPause, isSlideshowActive } from './slideshow.js';
import { initToolbarAria } from './toolbar-a11y.js';
import { initPrivacy, onPrivacyChange, isHiddenKeyword, hasActivePrivacy } from './privacy.js';
import { initTitleBar } from './titlebar.js';
import { orientationMatrix, swapsSides } from './orientation.js';
import {
  initFolderTree, renderFolderTree, updateActiveFolderRows, scheduleFolderCounts, refreshDiskFoldersIfShown,
  addCreatedFolder, selectFolder, rememberCurrentFolder, foldersMenuItems,
  getFolderPhotoCount, expandFolderAncestors, revealActiveFolderRow,
  forgetDeletedFolder, renameFolderInTree,
} from './folder-tree.js';
import { isRawPath, isVideoPath } from './file-kinds.js';
import { dateFilter, dateFilterInput, setDateFilter, matchesDateFilter, parseDateFilter, photoTimeKey, photoDateKey, isValidDateKey, updateDateFilterUI, closeDatePicker, isDatePickerOpen, refreshDatePickerLanguage, initDateFilter } from './date-filter.js';
import {
  initTaskQueue, enqueueScanTask, folderBaseName, foregroundTaskCount, hasFileTask,
  queuedPathsBeingChanged, pausedScanFolders, dropScanTasksForFolder, stopSemanticTasks,
  confirmCloseWithRunningTasks, restorePausedTasks, showTaskToast, hideTaskToast,
  closeTasksModal, keepTaskReady, removeReadyTask, checkFolderIntegrity, rescanFolder,
} from './task-queue.js';
import {
  initPreviewZoom, isCompareMode, isCompareMultiple, canAddToSelection, showCompareLimitToast,
  commandTargetIndices, commandTargetPhotos, commandReferencePhoto, pruneCompareSubSelection,
  toggleAllCompareSubSelection, notifyNoCompareTarget,
  layoutPreviewSlots, renderPreview, invalidatePreview,
  previewSlotFromEvent, zoomPreviewSteps, togglePreviewActualSize,
  getHoveredPreviewSlot, getPreviewSlots,
} from './preview-zoom.js';
import { initDragDrop } from './drag-drop.js';
import {
  initFullscreen, isFullscreenOpen, getFullscreenSlot, clearFullscreenImageCache, setFullscreenDirection,
  openFullscreen, closeFullscreen, layoutFullscreenSlot, loadFullscreenPhoto, clearFullscreenImage,
  preloadFullscreenImages, updateFullscreenInfo, toggleFullscreenInfo,
  showFullscreenRatingForAWhile, toggleFullscreenRatingPinned, updateFullscreenRatingStars,
} from './fullscreen.js';

// WINDOW CHROME (titlebar.js): first display of the window, title bar buttons and immersive mode (F11).
// Closing by any means (button, Alt+F4, system menu) asks first about unfinished work, in this order: running queue tasks, unsaved filters of a smart
// album, then unwritten keywords, titles or descriptions or a write in progress (see metadata-writes.js).
initTitleBar({
  confirmClose: async () => {
    if (!(await confirmCloseWithRunningTasks())) return false;
    if (isSelectedAlbumDirty() && !(await confirmLeaveAlbum())) return false;
    return confirmCloseWithPendingEdits();
  },
  exposeImmersiveToggle: toggle => { toggleImmersiveFromMenu = toggle; }, // called once the DOM is ready (see `toggleImmersiveFromMenu` below)
});

// ETAT
let photos = [];
let loadedPhotos = [];
let folders = [];
let folderTreePhotos = [];
// Filters for Gear (camera, lens) and Shoot Settings (focal, shutter speed, aperture, ISO, flash) : see shooting-filters.js.
const shootingFilters = initShootingFilters({ getPhotos: () => folderTreePhotos, onChange: () => applyPhotoFilters() });
// Filtre Format (type, marque de RAW, extension) : voir format-filters.js, qui porte aussi les listes d'extensions.
const formatFilters = initFormatFilters({ getPhotos: () => folderTreePhotos, onChange: () => applyPhotoFilters() });
// Filter: Author : see author-filters.js.
const authorFilters = initAuthorFilters({ onChange: () => applyPhotoFilters() });
let currentFolderFilter = null;
// Folders added to `currentFolderFilter` by Ctrl+click in the tree: the grid shows the photos of all of them (not persisted, reset by a plain click).
let extraFolderFilters = [];
// Startup view (Settings > Genéral) : « all » for all photos (default), « last » for last folder.
let startupView = readChoice('startupView', ['last', 'all']);
let includeSubfolders = readBool('includeSubfolders');
let keywordFilters = [];
// Keywords a photo must NOT carry (Alt+Enter / Alt+click in the keyword list, or the chip's context menu). A keyword is never in both lists.
let excludedKeywordFilters = [];
// Keywords in `keywordFilters` / `excludedKeywordFilters` that also match all strict descendants (`~` suffix on the chip).
let keywordChildrenFilters = new Set();
let excludedKeywordChildrenFilters = new Set();
const keywordKey = text => String(text ?? '').trim().toLowerCase();
const keywordGuesses = new Map(); // photo id -> included keywords it only has by content-search suggestion (see matchesKeywordFiltersOrSuggested)
let pathFilter = null; // chemins à montrer uniquement (fichiers dont l'écriture de mots-clés a échoué) ; null = pas de filtre
let filenameFilters = []; // chaînes à retrouver dans le nom de fichier (toutes doivent y figurer, casse ignorée)
let excludedFilenameFilters = []; // texts the file name must NOT contain (Alt+Enter, or the chip's context menu)
let colorFilters = new Set(); // couleurs cochées dans le filtre (vide = pas de filtre)
let pickFilters = new Set(); // fanions pick cochés dans le filtre (vide = pas de filtre)
// Filtre de note : étoiles (0 = aucune), mode « au moins » (gte) ou « exactement » (eq), ou photos non notées (exclusif avec les étoiles). Actif si stars > 0 ou unrated.
const ratingFilter = { stars: 0, mode: 'gte', unrated: false };
let selectedIndices = new Set();
let lastSelectedIndex = 0;
// Version des fichiers modifiés hors de l'application (chemin -> horodatage) : ajoutée à l'URL pour ne pas réafficher une image périmée du cache.
const photoVersions = new Map();
function photoUrl(photo) {
  return convertFileSrc(photo.path) + versionSuffix(photo.path);
}
// Same suffix on the cached images (thumbnail, extracted preview): a lossless rotation written in a sidecar regenerates them under the same name.
function versionSuffix(path) {
  const version = photoVersions.get(path);
  return version ? `?v=${version}` : '';
}

// RAW without embedded JPEG : extension letters are displayed in big on thumbnail and preview (see .format-placeholder in styles.css). Read by ::after on its element (.thumbnail-inner for the grid).
function markFormatPlaceholder(element, path) {
  if (!element) return;
  const format = (path || '').split('.').pop()?.toLowerCase() ?? '';
  element.classList.add('format-placeholder');
  for (const target of [element, element.querySelector(':scope > .thumbnail-inner')]) if (target) target.dataset.format = format;
}

// HEIC / HEIF : le webview ne sait pas les afficher. Le backend en fait un JPEG pleine résolution (même commande et même cache que l'aperçu RAW).
// Liste des extensions : format-filters.js.

// VIDEOS (`isVideoPath`: file-kinds.js): indexed like photos, but never displayed or played inside the app. The backend extracts a still image (grid
// thumbnail and preview, same cache as the photos); a double-click opens them in the default player of the OS (see openVideoExternally).
// Visual markers: class .is-video (thumbnail and preview cell) and .video-play-badge (Play icon), adjustable in styles.css.
const VIDEO_PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
function createVideoPlayBadge() {
  const badge = document.createElement('span');
  badge.className = 'video-play-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.innerHTML = VIDEO_PLAY_ICON;
  return badge;
}

// Le webview ne sait pas afficher les RAW, les HEIC / HEIF ni lire les vidéos : le backend fournit une image JPEG (aperçu RAW / HEIC, image fixe de la vidéo).
function needsGeneratedPreview(path) {
  const ext = (path || '').split('.').pop()?.toLowerCase();
  return RAW_EXTENSIONS.has(ext) || HEIF_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
}

const rawPreviewPromises = new Map();
async function getPhotoDisplayUrl(photo) {
  if (!photo) return '';
  if (!needsGeneratedPreview(photo.path)) {
    return photoUrl(photo);
  }
  let promise = rawPreviewPromises.get(photo.path);
  if (!promise) {
    promise = invoke('get_raw_preview_path', { sourcePath: photo.path })
      .then(cachedPath => convertFileSrc(cachedPath) + versionSuffix(photo.path))
      .catch(err => {
        console.error('RAW preview extraction failed', photo.path, err);
        rawPreviewPromises.delete(photo.path); // échec non mémorisé : nouvelle tentative au prochain affichage
        // Vidéo : jamais le fichier vidéo lui-même comme image (case laissée vide, avec son icône Play).
        return isVideoPath(photo.path) ? '' : photoUrl(photo);
      });
    rawPreviewPromises.set(photo.path, promise);
  }
  return promise;
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

// FANIONS PICK (digiKam:PickLabel, xmpDM:pick, xmpDM:good) : clé stockée en base, label = clé de traduction, glyph = symbole affiché.
// « pending » (en attente) n'existe que dans digiKam : il n'est proposé à la pose que si digiKam est le format de tête (voir PICK_CHOICES).
const PICK_FLAGS = [
  { key: 'picked', label: 'Picked', glyph: '⚑' },
  { key: 'rejected', label: 'Rejected', glyph: '✖' },
  { key: 'pending', label: 'Pending', glyph: '◔' },
  { key: 'none', label: 'No flag', glyph: '○' },
];

// APPARENCE (thème et couleur de sélection, mémorisés localement)
const DEFAULT_SELECTION_COLOR = DEFAULTS.selectionColor;
// Theme choice: "system" follows the light / dark setting of the OS, "dark" and "light" force one. `appTheme` holds the choice, while
// data-theme on <html> (read by the CSS and by map-view.js) always holds the resolved "dark" | "light" (see resolvedTheme).
const APP_THEMES = ['system', 'dark', 'light'];
let appTheme = readChoice('appTheme', APP_THEMES);
const systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const resolvedTheme = () => (appTheme === 'system' ? (systemDarkQuery.matches ? 'dark' : 'light') : appTheme);
const storedSelectionColor = localStorage.getItem('selectionColor') || '';
let selectionColor = /^#[0-9a-f]{6}$/i.test(storedSelectionColor) ? storedSelectionColor : DEFAULT_SELECTION_COLOR;
// Couleur des boutons activés (Filtres, Comparer, Aperçu, Info), distincte de la couleur de sélection des miniatures.
const DEFAULT_ACTIVE_BUTTON_COLOR = DEFAULTS.activeButtonColor;
const storedActiveButtonColor = localStorage.getItem('activeButtonColor') || '';
let activeButtonColor = /^#[0-9a-f]{6}$/i.test(storedActiveButtonColor) ? storedActiveButtonColor : DEFAULT_ACTIVE_BUTTON_COLOR;
// Texte noir ou blanc, selon celui qui contraste le plus avec la couleur du bouton activé (rapport WCAG ≥ 4,5:1 pour toutes les couleurs
// proposées sauf quelques tons moyens, où le meilleur des deux est retenu). Le seuil de luminance est celui où les deux contrastes s'égalent.
function readableTextColor(hex) {
  const [r, g, b] = [1, 3, 5]
    .map(start => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#111' : '#fff';
}
function applyAppearance() {
  document.documentElement.dataset.theme = resolvedTheme();
  document.documentElement.style.setProperty('--selected-border', selectionColor);
  document.documentElement.style.setProperty('--selected-contrast', readableTextColor(selectionColor)); // marker of the active photo, drawn on the selection colour
  document.documentElement.style.setProperty('--active-button', activeButtonColor);
  document.documentElement.style.setProperty('--active-button-text', readableTextColor(activeButtonColor));
}
applyAppearance();
// "System" theme: follow the OS when it switches between light and dark while the application is running.
systemDarkQuery.addEventListener('change', () => { if (appTheme === 'system') applyAppearance(); });

// ASSOMBRISSEMENT DES HORS-SÉLECTIONS AU SURVOL
let dimUnselected = localStorage.getItem('dimUnselectedOnHover') || DEFAULTS.dimUnselectedOnHover;
function applyDimUnselected() {
  const active = dimUnselected !== 'none';
  document.body.classList.toggle('dim-unselected-active', active);
  if (active) {
    document.documentElement.style.setProperty('--dim-unselected-brightness', dimUnselected);
  }
  const select = document.getElementById('dim-unselected-select');
  if (select) select.value = dimUnselected;
}
applyDimUnselected();
document.getElementById('dim-unselected-select')?.addEventListener('change', event => {
  dimUnselected = event.target.value;
  localStorage.setItem('dimUnselectedOnHover', dimUnselected);
  applyDimUnselected();
});

// TAILLE DES TEXTES (Paramètres / Affichage, mémorisée localement) : pourcentage de la taille de police de base du document.
// Toute la typographie et les espacements étant en rem (voir styles.css), un seul réglage sur <html> met l'interface à l'échelle ;
// les dimensions en px (grille de miniatures, bordures, icônes SVG) ne changent pas. 100 % = 17,6 px (voir UI_BASE_PERCENT).
// Slider from 80 to 140 %, in steps of 5 (older saved values 90 / 100 / 110 / 120 stay valid).
const TEXT_SIZE_MIN = 80, TEXT_SIZE_MAX = 140, TEXT_SIZE_STEP = 5;
const snapTextSize = value => Math.max(TEXT_SIZE_MIN, Math.min(TEXT_SIZE_MAX,
  TEXT_SIZE_MIN + Math.round((value - TEXT_SIZE_MIN) / TEXT_SIZE_STEP) * TEXT_SIZE_STEP));
let textSize = snapTextSize(readNumber('textSize', TEXT_SIZE_MIN, TEXT_SIZE_MAX));
// The displayed 100 % is 110 % of the browser base size (17.6 px): the former "110 %" became the reference size.
// Everything is in rem, so this single factor rebalances every font-size, spacing and icon at once.
const UI_BASE_PERCENT = 110;
function applyTextSize() {
  document.documentElement.style.fontSize = `${(textSize * UI_BASE_PERCENT) / 100}%`;
  const label = document.getElementById('text-size-value');
  if (label) label.textContent = `${textSize} %`;
  const down = document.getElementById('text-size-down');
  const up = document.getElementById('text-size-up');
  if (down) down.disabled = textSize <= TEXT_SIZE_MIN;
  if (up) up.disabled = textSize >= TEXT_SIZE_MAX;
}
applyTextSize();
// « − » / « + » instead of a slider: the settings window is sized in rem, so it resizes with the text and would move
// a slider thumb away from the pointer while dragging.
function stepTextSize(delta) {
  const next = snapTextSize(textSize + delta);
  if (next === textSize) return;
  textSize = next;
  localStorage.setItem('textSize', String(textSize));
  applyTextSize();
  // Les largeurs en rem (barre latérale, panneaux) changent : la grille virtuelle est recalculée sur sa nouvelle largeur.
  requestAnimationFrame(() => updateVirtualScroller());
}
document.getElementById('text-size-down')?.addEventListener('click', () => stepTextSize(-TEXT_SIZE_STEP));
document.getElementById('text-size-up')?.addEventListener('click', () => stepTextSize(TEXT_SIZE_STEP));

// POLICE DE L'INTERFACE (Paramètres / Apparence, mémorisée localement) : la liste des polices est dans app-fonts.js.
let appFont = readChoice('appFont', APP_FONT_IDS);
function applyAppFont() {
  document.documentElement.style.setProperty('--app-font', fontStack(appFont));
  const select = document.getElementById('app-font-select');
  if (select) select.value = appFont;
}
const appFontSelect = document.getElementById('app-font-select');
if (appFontSelect) {
  for (const font of APP_FONTS) appFontSelect.add(new Option(font.label, font.id));
}
applyAppFont();
appFontSelect?.addEventListener('change', event => {
  if (!APP_FONT_IDS.includes(event.target.value)) return;
  appFont = event.target.value;
  localStorage.setItem('appFont', appFont);
  applyAppFont();
  // Les chasses des polices diffèrent : la grille virtuelle (légendes) est recalculée.
  requestAnimationFrame(() => updateVirtualScroller());
});

// DOM
let thumbnailCacheSize = Number(localStorage.getItem('thumbnailCacheSize')) || DEFAULTS.thumbnailCacheSize;
// 512 px minimum : la détection des visages lit les miniatures en cache.
if (![512, 768, 1024].includes(thumbnailCacheSize)) thumbnailCacheSize = DEFAULTS.thumbnailCacheSize;
let thumbnailSize = Number(localStorage.getItem('thumbnailSize')) || DEFAULTS.thumbnailSize;
thumbnailSize = Math.max(96, Math.min(thumbnailCacheSize, 96 + Math.round((thumbnailSize - 96) / 16) * 16));
let columns = 1;
const storedThumbnailLayout = localStorage.getItem('thumbnailLayout');
// Encadrée (framed) : grille carrée où chaque photo entière (non recadrée) s'inscrit dans sa case ; portrait et paysage de même ratio ont la même taille.
let thumbnailLayout = ['square', 'framed', 'justified', 'masonry'].includes(storedThumbnailLayout) ? storedThumbnailLayout : DEFAULTS.thumbnailLayout;
// Thumbnail spacing is shared by every layout: none, small (0.25 rem), or normal (the historic masonry margin and frame).
// Without a saved choice, preserve the previous appearance: no gap for justified layout, spacing for other layouts.
const THUMBNAIL_SPACINGS = ['none', 'small', 'normal'];
const storedThumbnailSpacing = localStorage.getItem('thumbnailSpacing');
let thumbnailSpacing = THUMBNAIL_SPACINGS.includes(storedThumbnailSpacing) ? storedThumbnailSpacing
  : DEFAULTS.thumbnailSpacing !== 'auto' ? DEFAULTS.thumbnailSpacing : (thumbnailLayout === 'justified' ? 'none' : 'normal');
let thumbnailCorners = readChoice('thumbnailCorners', ['no', 'light', 'medium', 'strong', 'max']);
document.documentElement.dataset.thumbnailCorners = thumbnailCorners;
// TRI DES MINIATURES (critère et ordre mémorisés localement). Par défaut : date de prise de vue, de la plus récente à la plus ancienne (ordre historique de la grille).
const SORT_KEYS = ['taken', 'modified', 'name'];
const storedSortKey = localStorage.getItem('photoSortKey');
let sortKey = SORT_KEYS.includes(storedSortKey) ? storedSortKey : DEFAULTS.photoSortKey;
let sortOrder = readChoice('photoSortOrder', ['asc', 'desc']);
// SÉPARATEURS DE LA GRILLE (mémorisés localement, un choix par famille de tri) : par défaut aucun. Dates (tri par date de prise de vue ou de modification) :
// par jour, semaine, mois ou année. Nom de fichier : par dossier (le tri par nom se fait alors au sein de chaque dossier).
const DATE_SEPARATORS = ['none', 'day', 'week', 'month', 'year'];
const NAME_SEPARATORS = ['none', 'folder'];
const storedDateSeparator = localStorage.getItem('photoDateSeparator');
let dateSeparator = DATE_SEPARATORS.includes(storedDateSeparator) ? storedDateSeparator : DEFAULTS.photoDateSeparator;
const storedNameSeparator = localStorage.getItem('photoNameSeparator');
let nameSeparator = NAME_SEPARATORS.includes(storedNameSeparator) ? storedNameSeparator : DEFAULTS.photoNameSeparator;
let photoLayouts = [];
let separatorLayouts = []; // { group, y, height, label, title } : lignes de séparation, dans l'ordre de la grille
const renderedSeparatorNodes = new Map();
let layoutContentHeight = 0;
let maximumPhotoHeight = thumbnailSize;
const gridContainer = document.getElementById('grid-view');
const scrollContent = document.getElementById('virtual-scroll-content');
const gridScrollPosition = document.getElementById('grid-scroll-position');
const previewStage = document.getElementById('preview-stage');
const sidebarPanel = document.getElementById('sidebar-panel');
const settingsModal = document.getElementById('settings-modal');
const settingsFolderList = document.getElementById('settings-folder-list');
const renderedThumbnailNodes = new Map();
const thumbnailCacheLookups = new Map();
const thumbnailCacheWrites = new Map();

// Fichiers dont seules les métadonnées viennent d'être réécrites : côté Rust, leur miniature et leur aperçu en cache ont été renommés pour
// suivre la nouvelle taille et la nouvelle date (keep_cached_images, aucune régénération) ; les anciens chemins mémorisés ici sont oubliés.
function forgetCachedImagePaths(paths) {
  for (const path of paths) {
    thumbnailCacheLookups.delete(path);
    rawPreviewPromises.delete(path);
  }
  if (paths.length) clearFullscreenImageCache();
}
let scrollRenderPending = false;

let justifiedLayoutTimer = null;

// Marge latérale de la grille : au survol, une miniature grossit de 3 % (voir .thumbnail:hover) et dépasserait de la zone, ce qui ferait
// apparaître une barre de défilement horizontale. 8 px couvrent l'agrandissement d'une miniature de 512 px (la taille maximale).
const GRID_SIDE_MARGIN = 8;
scrollContent.style.left = `${GRID_SIDE_MARGIN}px`;
scrollContent.style.width = `calc(100% - ${2 * GRID_SIDE_MARGIN}px)`;

function scheduleJustifiedRelayout(photo = null) {
  // Cascade : seules les vidéos (dimensions absentes du catalogue) changent de disposition quand leur ratio est appris.
  if (thumbnailLayout === 'masonry' && !(photo && isVideoPath(photo.path))) return;
  clearTimeout(justifiedLayoutTimer);
  justifiedLayoutTimer = setTimeout(() => {
    if (thumbnailLayout !== 'square' && thumbnailLayout !== 'framed') updateVirtualScroller();
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
      .catch(error => {
        console.debug('Cached thumbnail lookup failed', error);
        return [];
      })
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

let thumbnailJobSequence = 0;

function takeNextThumbnailGeneration() {
  // Jobs nobody waits for any more are dropped (their owner is told, so it can stop waiting).
  const kept = [];
  for (const job of thumbnailGenerationQueue) {
    if (job.isWanted()) kept.push(job); else job.onDrop?.();
  }
  thumbnailGenerationQueue = kept;
  const viewTop = gridContainer.scrollTop;
  const viewBottom = viewTop + gridContainer.clientHeight;
  let best = -1;
  let bestDistance = Infinity;
  let bestTop = Infinity;
  thumbnailGenerationQueue.forEach((job, position) => {
    // Requests from the Faces / People views (no grid image): what the user is looking at, newest first.
    if (!job.image) {
      if (bestDistance > -1 || -job.sequence < bestTop) { best = position; bestDistance = -1; bestTop = -job.sequence; }
      return;
    }
    // Grid hidden (People / Faces view): its jobs wait, they are neither dropped nor run.
    if (gridContainer.hidden) return;
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
    job.run().catch(error => console.debug('Thumbnail generation failed', error)).finally(() => {
      activeThumbnailGenerations--;
      pumpThumbnailGenerationQueue();
    });
  }
}

function schedulePump() {
  // Le démarrage est différé d'un tour de boucle pour choisir parmi toutes les demandes d'un même rendu.
  if (!thumbnailPumpScheduled) {
    thumbnailPumpScheduled = true;
    setTimeout(pumpThumbnailGenerationQueue, 0);
  }
}

function enqueueThumbnailGeneration(image, sourcePath, run) {
  thumbnailGenerationQueue.push({ image, sourcePath, run, sequence: ++thumbnailJobSequence, isWanted: () => image.isConnected && image.dataset.sourcePath === sourcePath });
  schedulePump();
}

// Generation requested outside the grid (face crops, people avatars): same queue and same concurrency limit, so that a view showing thousands
// of faces cannot flood the backend. `isWanted` tells when nobody waits for the result any more; `onDrop` is then called instead of `run`.
function enqueueStandaloneThumbnailGeneration(isWanted, run, onDrop) {
  thumbnailGenerationQueue.push({ image: null, run, isWanted, onDrop, sequence: ++thumbnailJobSequence });
  schedulePump();
}

// Apprend le ratio réel de la miniature (dimensions EXIF absentes ou fausses en base) et relance la disposition justifiée.
function learnPhotoAspectRatio(photo, ratio) {
  if (!(ratio > 0)) return;
  const previousRatio = photo.aspectRatio || (photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 0);
  // Tolérance relative de 0,2 % : l'arrondi des dimensions d'une miniature (ex. 512x341) ne doit pas relancer la disposition.
  if (Math.abs(previousRatio - ratio) > ratio * 0.002) {
    photo.aspectRatio = ratio;
    scheduleJustifiedRelayout(photo);
  }
}

// `original`: the image is the original file shown by the webview, still to be turned by `photo.view_fix` (cached thumbnails already are).
function updatePhotoAspectRatio(image, photo, original = false) {
  if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) return;
  const ratio = image.naturalWidth / image.naturalHeight;
  learnPhotoAspectRatio(photo, original && swapsSides(photo.view_fix) ? 1 / ratio : ratio);
}

// Affiche une miniature du cache dans l'image et apprend son ratio réel au chargement.
function showCachedThumbnail(image, cachedPath, photo) {
  image.onload = () => {
    if (!image.isConnected) return;
    image.classList.add('loaded');
    updatePhotoAspectRatio(image, photo);
  };
  image.src = convertFileSrc(cachedPath) + versionSuffix(photo.path);
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
    updatePhotoAspectRatio(image, photo, true);
    await cacheThumbnail(image, sourcePath, photo.view_fix);
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
        generated = await invoke('generate_thumbnail', { sourcePath, maxSide: thumbnailCacheSize });
      } catch {
        // Format non géré par le backend : repli ci-dessous.
      }
      if (!generated) {
        // Fichier supprimé hors de l'application ? On le retire du catalogue au lieu de laisser une miniature noire.
        if (await checkPhotoMissing(sourcePath)) return;
        // Vidéo sans image extractible (codec absent, pas de ffmpeg) : pas de repli webview (il ne sait pas lire la vidéo), la case reste avec son icône Play.
        if (isVideoPath(sourcePath)) {
          image.closest('.thumbnail')?.classList.add('no-thumbnail');
          return;
        }
        // RAW sans aperçu intégré : le webview ne sait pas le lire, la case reste avec le nom du format.
        if (isRawPath(sourcePath)) {
          markFormatPlaceholder(image.closest('.thumbnail'), sourcePath);
          return;
        }
        await generateThumbnailInWebview(image, sourcePath, photo);
        return;
      }
      thumbnailCacheLookups.set(sourcePath, Promise.resolve(generated.path));
      if (generated.width > 0 && generated.height > 0) learnPhotoAspectRatio(photo, generated.width / generated.height);
      if (image.isConnected && image.dataset.sourcePath === sourcePath) showCachedThumbnail(image, generated.path, photo);
    });
  });
}

// `viewFix`: orientation still to apply to the image (see orientationMatrix): the cached thumbnail is stored turned, like the backend ones.
function cacheThumbnail(image, sourcePath, viewFix = 1) {
  if (thumbnailCacheWrites.has(sourcePath)) return thumbnailCacheWrites.get(sourcePath);
  const task = (async () => {
    let bitmap;
    try {
      await image.decode();
      bitmap = await createImageBitmap(image);
      const scale = Math.min(1, thumbnailCacheSize / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = swapsSides(viewFix) ? height : width;
      canvas.height = swapsSides(viewFix) ? width : height;
      const context = canvas.getContext('2d', { alpha: false });
      const matrix = orientationMatrix(viewFix, width, height);
      if (matrix) context.setTransform(...matrix);
      context.drawImage(bitmap, 0, 0, width, height);
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
        image.src = convertFileSrc(cachedPath) + versionSuffix(sourcePath);
      }
    } catch (error) {
      console.debug('Thumbnail caching failed', sourcePath, error);
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
    console.debug('Missing files check failed', error);
  }
  const removedPaths = new Set(removed);
  if (removedPaths.size) removePhotosFromLibrary(removed, { keepSelection: true });
  for (const [path, waiters] of batch) for (const resolve of waiters) resolve(removedPaths.has(path));
}

// ==========================================
// CHARGEMENT PHOTOS & DOSSIERS
// ==========================================
// Display order of the root folders in the tree: list of folder paths kept in localStorage, reorderable in Settings > General
// (drag handle and arrows, like the "Open with" programs). Empty (default) = database order (by path).
const FOLDER_ORDER_KEY = 'folderOrder';
const normalizeFolderPath = path => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
// Saved order (normalized paths): array of strings, the default when absent or unreadable.
function readFolderOrder() {
  const stored = readStored(FOLDER_ORDER_KEY);
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed.filter(path => typeof path === 'string' && path).map(normalizeFolderPath);
    } catch {
      // unreadable value: default order
    }
  }
  return [...DEFAULTS.folderOrder].map(normalizeFolderPath);
}
// `list` (folders returned by the backend) in display order: the saved order first, then the folders unknown to it (added since),
// at the end in database order. Stable sort: equal ranks keep the order of `list`.
function applyFolderOrder(list) {
  const rank = new Map(readFolderOrder().map((path, index) => [path, index]));
  return [...list].sort((a, b) => (rank.get(normalizeFolderPath(a.path)) ?? rank.size) - (rank.get(normalizeFolderPath(b.path)) ?? rank.size));
}
// Saves the current order of `folders`; called only after an explicit reorder (adding/removing a folder keeps the saved order as is).
function saveFolderOrder() {
  localStorage.setItem(FOLDER_ORDER_KEY, JSON.stringify(folders.map(folder => folder.path)));
}

async function loadFolders() {
  folders = applyFolderOrder(await invoke('get_folders'));
  renderFolderTree();
  renderSettingsFolderList();
}

// The grid loads at most this many photos per folder. The backend picks them in the current sort (ascending by date = the oldest ones);
// on larger folders it also pre-applies the filters it can (`sqlPrefilter`), and `photoListCap` warns the user when the list is still cut.
const PHOTO_LOAD_LIMIT = 50000;
// `offset`: first photo of the page (0 for the first page; the grid pages through views larger than PHOTO_LOAD_LIMIT, see "PAGINATION DE LA GRILLE").
const queryPhotoPage = (folderFilter, prefilter = null, offset = 0) => invoke('get_photos_paginated', {
  offset, limit: PHOTO_LOAD_LIMIT, folderFilter, recursive: includeSubfolders, sortKey, sortOrder, prefilter,
});
// Loaded list cut at PHOTO_LOAD_LIMIT: { total } = matching photos of the displayed folders in the catalogue; null when everything is loaded.
let photoListCap = null;
// Displayed folders hold more than PHOTO_LOAD_LIMIT photos: filters are pre-applied by the backend before the cut.
let largeScope = false;
// Prefilter the loaded list was read with (JSON, '' = none): a filter change that alters it reloads the list (see applyPhotoFilters).
let loadedPrefilterKey = '';
let photoLoadGeneration = 0; // a newer load (folder change, filter reload) makes the answer of an older one obsolete

// Photos of a folder; for the folder being displayed, the Ctrl+click extra folders are merged in (duplicates removed when one contains another).
// `capped` is set on the returned list when one of the queries reached PHOTO_LOAD_LIMIT; the interface sorts the list itself.
// `offset` only applies to a single folder: merged Ctrl+click folders cannot be paged (no common order to cut), see readDisplayedFolderPhotos.
async function queryFolderPhotos(folder, prefilter = null, offset = 0) {
  const folderList = folder === null || folder !== currentFolderFilter ? [folder] : [folder, ...extraFolderFilters];
  const lists = await Promise.all(folderList.map(item => queryPhotoPage(item, prefilter, folderList.length === 1 ? offset : 0)));
  const capped = lists.some(list => list.length >= PHOTO_LOAD_LIMIT);
  let merged = lists[0];
  if (lists.length > 1) {
    const seen = new Set();
    merged = [];
    for (const list of lists) for (const photo of list) if (!seen.has(photo.path)) { seen.add(photo.path); merged.push(photo); }
  }
  merged.capped = capped;
  return merged;
}

// Displayed folders (null = whole catalogue), as queried by `queryFolderPhotos` for the current view.
function displayedPhotoFolders() {
  return getSelectedAlbum() || currentFolderFilter === null ? [null] : [currentFolderFilter, ...extraFolderFilters];
}

// Photos of the displayed folders in the catalogue (optionally prefiltered), or null if a count failed.
// Overlapping Ctrl+click folders may be counted twice: the number decides "more than the limit" and feeds the warning, nothing else.
async function countDisplayedPhotos(prefilter = null) {
  const counts = await Promise.all(displayedPhotoFolders().map(folderFilter => invoke('count_photos', { folderFilter, recursive: includeSubfolders, prefilter }).catch(() => null)));
  return counts.every(Number.isFinite) ? counts.reduce((sum, count) => sum + count, 0) : null;
}

// SQLite's lower() only folds ASCII letters: a text with other characters is left to the interface (the prefilter must never miss a photo).
const isAsciiText = text => /^[\x00-\x7f]*$/.test(text);

// Prefilter of a filter state (`captureFilterState` form): the conditions the backend applies before the cut, a superset of
// `matchesFilterState` (see `PhotoPrefilter` in db.rs). `dateRange` overrides the date text (the controls keep the last valid range).
function prefilterFromState(state, dateRange = state.date ? parseDateFilter(state.date).filter : null) {
  const filter = {};
  const rating = state.rating;
  if (rating?.unrated) filter.unrated = true;
  else if (rating?.stars > 0) filter[rating.mode === 'eq' ? 'ratingEq' : 'ratingMin'] = rating.stars;
  if (state.colors?.length) filter.colors = [...state.colors].sort();
  if (state.picks?.length) filter.picks = [...state.picks].sort();
  if (state.keywords?.length) {
    const withChildren = new Set(state.keywordsWithChildren ?? []);
    const plain = state.keywords.filter(keyword => !withChildren.has(keyword)).sort();
    const children = state.keywords.filter(keyword => withChildren.has(keyword)).sort();
    if (plain.length) filter.keywords = plain;
    if (children.length) filter.keywordsWithChildren = children;
  }
  if (dateRange) {
    filter.yearFrom = Math.floor(dateRange.from / 1e10); // AAAAMMJJHHmmss -> AAAA
    filter.yearTo = Math.floor(dateRange.to / 1e10);
  }
  if (state.persons?.length) filter.persons = [...state.persons].sort((a, b) => a - b);
  if (state.location) filter.geolocated = state.location === 'geolocated';
  const filenames = (state.filenames ?? []).map(text => text.toLowerCase()).filter(text => text && isAsciiText(text));
  if (filenames.length) filter.filenames = filenames.sort();
  const extensions = formatPrefilterExtensions(state);
  if (extensions) filter.extensions = extensions;
  Object.assign(filter, shootingPrefilter(state)); // gear and shooting values
  Object.assign(filter, authorFilters.prefilter(state)); // authors (lowercase ASCII names only)
  if (state.folder?.path) {
    const prefix = `${normalizeFilterPath(state.folder.path)}/`;
    if (isAsciiText(prefix)) filter.folder = { prefix, recursive: Boolean(state.folder.recursive) };
  }
  if (state.mapZone) {
    const { south, north, west, east } = state.mapZone;
    if ([south, north, west, east].every(Number.isFinite)) filter.mapZone = { south, north, west, east };
  }
  return filter;
}

// Filters the backend can apply before the cut: the sidebar filters, the folder and map area of the open smart album, and the criteria of its
// parent albums, and "Visible area only" as "has a position". The map area itself and the failed-files list stay in the interface.
// Null when none applies.
function buildSqlPrefilter() {
  const filter = prefilterFromState(captureFilterState(), dateFilter);
  const inherited = albumInherited.map(({ state }) => prefilterFromState(state)).filter(item => Object.keys(item).length);
  if (inherited.length) filter.and = inherited;
  const map = mapPrefilter();
  if (map) {
    filter.positioned = true;
    filter.pendingPositions = map.pendingIds;
  }
  return Object.keys(filter).length ? filter : null;
}
const sqlPrefilter = () => (largeScope ? buildSqlPrefilter() : null);
// Pending positions stay out of the key: a photo placed on the map is already loaded, so placing one must not read the list again.
const prefilterKey = prefilter => (prefilter ? JSON.stringify({ ...prefilter, pendingPositions: undefined }) : '');

// Reads the displayed folders: on a large folder, prefiltered (counted first to know). Returns { list, cap, large, key, page, pageCount }.
// A view with more matching photos than PHOTO_LOAD_LIMIT (after the prefilter) is cut in pages of that size: `page` (0-based, `currentPhotoPage`
// clamped to what exists) is the one read, `pageCount` how many there are. `cap` (the "list is cut" warning) only remains when paging is not possible.
async function readDisplayedFolderPhotos(folder) {
  const wanted = buildSqlPrefilter();
  const queriedOffset = photoPageOffset(currentPhotoPage);
  let total;
  let list;
  if (wanted) {
    total = await countDisplayedPhotos();
  } else if (queriedOffset === 0) {
    list = await queryFolderPhotos(folder, null, 0);
    // Below PHOTO_LOAD_LIMIT on page 1, the returned list is already complete: no separate COUNT(*) needed.
    total = list.capped ? await countDisplayedPhotos() : list.length;
  } else {
    [total, list] = await Promise.all([countDisplayedPhotos(), queryFolderPhotos(folder, null, queriedOffset)]); // usual case: no wait for the count
  }
  const large = total === null ? Boolean(list?.capped) || largeScope : total > PHOTO_LOAD_LIMIT;
  const prefilter = large ? wanted : null;
  // Photos matching once the prefilter is applied: what the pages split. Several Ctrl+click folders (or a failed count) cannot be paged.
  const matching = prefilter ? await countDisplayedPhotos(prefilter) : total;
  const pageable = displayedPhotoFolders().length === 1 && Number.isFinite(matching);
  const pageCount = pageable ? Math.max(1, Math.ceil(matching / PHOTO_LOAD_LIMIT)) : 1;
  const page = Math.min(currentPhotoPage, pageCount - 1);
  const offset = photoPageOffset(page);
  if (!list || offset !== queriedOffset) list = await queryFolderPhotos(folder, prefilter, offset);
  const cap = list.capped && pageCount <= 1 ? { total: matching } : null;
  return { list, cap, large, key: prefilterKey(prefilter), page, pageCount, total: pageCount > 1 ? matching : null };
}

// Adopts what readDisplayedFolderPhotos (or another source: albums, searches) returned: cap warning, large scope, prefilter, current page.
function adoptListResult(result) {
  ({ cap: photoListCap, large: largeScope, key: loadedPrefilterKey } = result);
  currentPhotoPage = result.page ?? 0;
  photoPageCount = result.pageCount ?? 1;
  photoPageTotal = result.total ?? null;
  renderPhotoPager();
}

// ==========================================
// PAGINATION DE LA GRILLE
// ==========================================
// A view (folder, prefilter applied) with more photos than PHOTO_LOAD_LIMIT is shown page by page: the backend returns the slice
// [page × PHOTO_LOAD_LIMIT, +PHOTO_LOAD_LIMIT) of the current sort (`offset` of get_photos_paginated). The JS filters, selection and layout only ever
// see the loaded page. The bar stays hidden for any view that fits in one page (and for albums, searches and several Ctrl+click folders).
let currentPhotoPage = 0; // 0-based
let photoPageCount = 1;
let photoPageTotal = null; // photos of the whole paged view (prefilter applied); null when the view is not paged
let photoPagerBuiltCount = 0; // number of options currently in the page menu
let photoPageBusy = false; // a page change (question, then reload) is under way
const photoPager = document.getElementById('photo-pager');
const photoPagerPrev = document.getElementById('photo-pager-prev');
const photoPagerNext = document.getElementById('photo-pager-next');
const photoPagerLabel = document.getElementById('photo-pager-label');
const photoPagerLive = document.getElementById('photo-pager-live'); // visually hidden: announces "Page 2 of 3" to screen readers
const photoPagerSelect = document.getElementById('photo-pager-select');

function photoPageOffset(page) {
  return page * PHOTO_LOAD_LIMIT;
}

function renderPhotoPager() {
  if (!photoPager) return;
  const paged = photoPageCount > 1;
  photoPager.hidden = !paged;
  if (!paged) return;
  const format = value => value.toLocaleString(getLanguage());
  // Menu rebuilt only when the number of pages (or the language) changed: it can hold a few dozen entries.
  if (photoPagerBuiltCount !== photoPageCount) {
    photoPagerSelect.replaceChildren(...Array.from({ length: photoPageCount }, (_, index) => new Option(t('Photo page option {page}', { page: format(index + 1) }), String(index))));
    photoPagerBuiltCount = photoPageCount;
  }
  photoPagerSelect.value = String(currentPhotoPage);
  // The menu shows the current page, the label only completes it ("of 3"); the hidden live region carries the full sentence.
  photoPagerLabel.textContent = t('Photo pages total {total}', { total: format(photoPageCount) });
  photoPagerLive.textContent = t('Photo page {page} of {total}', { page: format(currentPhotoPage + 1), total: format(photoPageCount) });
  // A page change is under way (question, then reading the page): the bar is greyed and cannot be used again until it ends.
  photoPager.classList.toggle('busy', photoPageBusy);
  photoPager.setAttribute('aria-busy', String(photoPageBusy));
  photoPagerSelect.disabled = photoPageBusy;
  photoPagerPrev.disabled = photoPageBusy || currentPhotoPage <= 0;
  photoPagerNext.disabled = photoPageBusy || currentPhotoPage >= photoPageCount - 1;
  // Tooltip: which photos of the view this page holds (the real total of the view is known: photoPageTotal).
  const from = photoPageOffset(currentPhotoPage) + 1;
  const total = Number.isFinite(photoPageTotal) ? photoPageTotal : photoPageOffset(photoPageCount - 1) + loadedPhotos.length;
  photoPagerLabel.title = t('Photos {from} to {to} of {total}', { from: format(from), to: format(Math.min(total, photoPageOffset(currentPhotoPage) + loadedPhotos.length)), total: format(total) });
}
// The menu text follows the language.
onLanguageChange(() => { photoPagerBuiltCount = 0; renderPhotoPager(); });

// Goes to another page: pending keyword / title / description edits are applied or dropped first (same question as a selection change, Cancel stays
// on the page), then the selection is cleared, the page read and the grid put back on top.
async function goToPhotoPage(target) {
  const page = Math.max(0, Math.min(photoPageCount - 1, target));
  if (photoPageCount <= 1 || photoPageBusy) return;
  if (page === currentPhotoPage) { renderPhotoPager(); return; }
  photoPageBusy = true;
  renderPhotoPager(); // greyed while the question and the reading last
  try {
    if (hasSelectionEdits() && (await resolvePendingSelection([])) === 'cancel') {
      renderPhotoPager(); // menu back on the current page
      return;
    }
    selectedIndices.clear();
    updateUIOnSelection();
    currentPhotoPage = page;
    clearFullscreenImageCache(); // keyed by index in the list, which the new page replaces
    await loadPhotos({ catalogChanged: false }); // reads the page at offset currentPhotoPage × PHOTO_LOAD_LIMIT
    gridContainer.scrollTop = 0;
  } finally {
    photoPageBusy = false;
    renderPhotoPager();
  }
}

photoPagerPrev?.addEventListener('click', () => goToPhotoPage(currentPhotoPage - 1));
photoPagerNext?.addEventListener('click', () => goToPhotoPage(currentPhotoPage + 1));
photoPagerSelect?.addEventListener('change', () => goToPhotoPage(Number(photoPagerSelect.value)));

// Alt+PageUp / Alt+PageDown: previous / next page. Not in full screen, behind a window, or in the Faces / People views (the grid is hidden there).
window.addEventListener('keydown', event => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== 'PageUp' && event.key !== 'PageDown')) return;
  if (photoPageCount <= 1 || isFullscreenOpen() || document.querySelector('.modal:not(.hidden)') || isFacesViewOpen() || isPersonsViewOpen()) return;
  event.preventDefault();
  if (!event.repeat) goToPhotoPage(currentPhotoPage + (event.key === 'PageUp' ? -1 : 1));
});

// A filter changed on a large folder: the list is read again with the new prefilter (grouped over a burst of changes).
let prefilterReloadTimer = null;
function schedulePrefilterReload() {
  clearTimeout(prefilterReloadTimer);
  prefilterReloadTimer = setTimeout(async () => {
    if (!largeScope || prefilterKey(sqlPrefilter()) === loadedPrefilterKey) return;
    currentPhotoPage = 0; // another set of photos: back to the first page
    const generation = ++photoLoadGeneration;
    const result = await readDisplayedFolderPhotos(getSelectedAlbum() ? null : currentFolderFilter);
    if (generation !== photoLoadGeneration) return;
    adoptListResult(result);
    loadedPhotos = result.list;
    applyPhotoFilters(); // same reset (scroll, selection) as any filter change
  }, 200);
}

async function loadPhotos({ catalogChanged = true } = {}) {
  // Album virtuel affiché : un album manuel montre son contenu ; un album intelligent part de toute la photothèque (ses filtres viennent ensuite).
  // Dans les deux cas le dossier du disque n'intervient plus.
  const album = getSelectedAlbum();
  const baseAlbumId = album?.kind === 'manual' ? album.id : album?.kind === 'smart' ? getAlbumContext(album.id).baseManualId : 0;
  const generation = ++photoLoadGeneration;
  const duplicateSearch = getDuplicateSearch();
  let result;
  if (duplicateSearch) {
    // Duplicate results: only the photos of the groups, never the folder or album view (also used when the mode reloads after a rescan).
    result = { list: await invoke('get_photos_by_paths', { paths: duplicateSearch.groupPaths.flat() }), cap: null, large: false, key: '' };
  } else if (isSemanticSearchActive()) {
    // Content search results: only the photos of the answer (the slider cut is a filter, see matchesSemanticCut).
    result = { list: await loadSemanticPhotos(), cap: null, large: false, key: '' };
  } else if (baseAlbumId) {
    result = { list: await invoke('get_album_photos', { albumId: baseAlbumId }), cap: null, large: false, key: '' }; // never capped
  } else {
    result = await readDisplayedFolderPhotos(album ? null : currentFolderFilter);
  }
  if (generation !== photoLoadGeneration) return; // a newer load is under way and will show its own list
  adoptListResult(result);
  loadedPhotos = result.list;
  if (duplicateSearch) indexDuplicateGroups();
  photosLoadedOnce = true;
  // The whole-catalogue list feeds the keyword suggestions and gear lists: never a prefiltered one.
  let treeSourceUpdated = false;
  if (!album && currentFolderFilter === null && !duplicateSearch && !isSemanticSearchActive() && !loadedPrefilterKey && (catalogChanged || folderTreePhotos.length === 0)) {
    folderTreePhotos = loadedPhotos;
    treeSourceUpdated = true;
  }
  if (catalogChanged) {
    renderFolderTree();
    renderKeywordFilters({ force: true });
    invalidateKeywordTree(); // les fichiers ont pu changer l'arborescence des mots-clés (scan, relecture)
  } else if (treeSourceUpdated) {
    renderKeywordFilters();
  }
  const neededChildren = activeChildrenKeywords();
  if (neededChildren.length) await ensureKeywordDescendantPhotos(neededChildren);
  applyPhotoFilters({ keepState: false });
  if (catalogChanged) {
    refreshFaces(); // et les personnes lues dans les zones de visage (voir faces-panel.js)
    scheduleAlbumCounts(); // les photos ont pu changer : compteurs des albums
  }
}

function isRatingFilterActive() {
  return ratingFilter.stars > 0 || ratingFilter.unrated;
}

// Une photo passe si elle est non notée (pastille cochée) ou si sa note correspond aux étoiles choisies (au moins N ou exactement N).
function matchesRatingFilter(photo, filter = ratingFilter) {
  if (!(filter.stars > 0 || filter.unrated)) return true;
  const rating = photo.rating || 0;
  if (filter.unrated) return rating === 0;
  return filter.mode === 'eq' ? rating === filter.stars : rating >= filter.stars;
}

function hasActiveFilters() {
  const hasRating = isRatingFilterActive();
  const hasColor = colorFilters.size > 0 || pickFilters.size > 0;
  const hasKeywords = hasKeywordFilters();
  const hasFilename = hasFilenameFilters();
  const hasDate = dateFilter !== null || Boolean(dateFilterInput?.value.trim());
  return hasRating || hasColor || hasKeywords || hasFilename || hasDate || pathFilter !== null || hasPersonFilters() || locationFilter !== 'all' || analysisFilter !== 'all'
    || isMapZoneFilterActive() || shootingFilters.hasGear() || shootingFilters.hasShot() || formatFilters.hasFormats() || authorFilters.hasAuthors()
    || albumFolder !== null || albumMapZone !== null || albumInherited.length > 0;
}

// Grille vide : message centré selon la cause. Dossier sans photo ; photos présentes mais toutes écartées par les filtres ; sinon un message neutre.
// Rien n'est affiché avant la fin du premier chargement : sinon « rien à voir ici » clignoterait au démarrage.
let photosLoadedOnce = false;
function updateGridEmptyState() {
  const element = document.getElementById('grid-empty');
  if (!element) return;
  element.hidden = !photosLoadedOnce || photos.length > 0;
  if (element.hidden) return;
  const key = isSemanticSearchActive() ? 'No photo matches this search'
    : loadedPhotos.length === 0 ? 'Nothing to show here'
    : hasActiveFilters() ? 'A little too selective! Try adjusting your filters'
    : 'Hmm, no photos here...';
  element.textContent = t(key);
}

// Nombre de photos affichées, dans l'en-tête du bloc Filtres : « 12 480 photos » sans filtre, « 342 sur 12 480 photos » avec (le total donne le contexte).
// Le nombre est en gras ; le style change avec l'état (filtré : pastille d'accent ; aucun résultat : couleur d'alerte).
function updateFilteredPhotosCount() {
  const countElement = document.getElementById('filtered-photos-count');
  const clearBtn = document.getElementById('btn-clear-all-filters');
  const isFiltered = hasActiveFilters();

  if (clearBtn) {
    clearBtn.classList.toggle('hidden', !isFiltered);
  }

  if (countElement) {
    const total = photoPageCount > 1 && Number.isFinite(photoPageTotal) ? photoPageTotal : loadedPhotos.length; // paged view: the photos of every page
    const format = value => value.toLocaleString(getLanguage()); // séparateur de milliers de la langue
    const number = format(photos.length);
    // Texte court (la barre latérale est étroite) : « 12 480 photos » ou « 342 sur 12 480 » ; la phrase complète est en infobulle.
    // Le pluriel suit le total (« 1 sur 12 photos ») ; les nombres affichés sont les valeurs mises en forme.
    const narrowed = (isFiltered || total !== loadedPhotos.length) && photos.length !== total; // a paged view always reads "shown of total"
    const text = narrowed
      ? t('{shown} of {count}', { shown: number, count: format(total) })
      : tp('{count} photo', photos.length, { count: number });
    countElement.title = narrowed ? tp('{shown} of {count} photo', total, { shown: number, count: format(total) }) : '';
    // Le nombre des photos affichées (le premier du texte, quelle que soit la langue) est mis en valeur.
    const at = text.indexOf(number);
    const parts = at < 0 ? [text] : [text.slice(0, at), Object.assign(document.createElement('strong'), { textContent: number }), text.slice(at + number.length)];
    countElement.replaceChildren(...parts);
    // Capped list: amber mark, its tooltip says how many photos exist and what the filters cover.
    if (photoListCap) {
      const params = { loaded: format(PHOTO_LOAD_LIMIT), total: format(photoListCap.total ?? 0) };
      const warning = Object.assign(document.createElement('span'), { className: 'photo-cap-warning', textContent: '⚠' });
      warning.title = t(Number.isFinite(photoListCap.total)
        ? 'Only the first {loaded} of the {total} matching photos here are loaded, in the current sort order. The filters are applied before this cut: narrow them to see every matching photo.'
        : 'Only the first {loaded} matching photos here are loaded, in the current sort order. The filters are applied before this cut: narrow them to see every matching photo.', params);
      warning.setAttribute('aria-label', warning.title);
      countElement.append(warning);
      if (!countElement.title) countElement.title = warning.title;
    }
    countElement.classList.toggle('is-filtered', isFiltered);
    countElement.classList.toggle('is-empty', photos.length === 0);
  }
  updateGridEmptyState();
}

let mapCandidatePhotos = [];
function applyPhotoFilters({ keepState = true } = {}) {
  // A filter only narrows the current view: keep the selected photos that are still present. Loading a different source explicitly resets this state.
  const keptPaths = keepState ? [...selectedIndices].map(index => photos[index]?.path).filter(Boolean) : [];
  const keptLastPath = keepState ? photos[lastSelectedIndex]?.path : null;
  const keptScrollTop = gridContainer.scrollTop;
  for (const node of renderedThumbnailNodes.values()) node.remove();
  renderedThumbnailNodes.clear();
  // Content search suggestions for the keyword filter (setting off: nothing is requested and the lists below stay empty).
  syncKeywordSuggestions(keywordFilters, keywordSuggestionViewKey(), keywordSuggestionScope);
  const suggestedPhotos = suggestedExtraPhotos();
  keywordGuesses.clear();
  // Photos avant le filtre « Zone visible seulement » du mode Carte : la carte garde tous leurs points, même hors de la zone visible.
  mapCandidatePhotos = (suggestedPhotos.length ? loadedPhotos.concat(suggestedPhotos) : loadedPhotos).filter(photo => matchesRatingFilter(photo)
    && matchesKeywordFiltersOrSuggested(photo)
    && personFilterMatches(photo)
    && matchesFilenameFilters(photo)
    && (pathFilter === null || pathFilter.has(photo.path))
    && (colorFilters.size === 0 || colorFilters.has(photo.color_flag || 'none'))
    && (pickFilters.size === 0 || pickFilters.has(photo.pick_flag || 'none'))
    && matchesDateFilter(photo)
    && matchesLocationFilter(photo)
    && matchesAnalysisFilter(photo)
    && shootingFilters.matches(photo)
    && formatFilters.matches(photo)
    && authorFilters.matches(photo)
    && matchesRawSearchScope(photo)
    && matchesSemanticCut(photo)
    && matchesAlbumCriteria(photo));
  photos = mapCandidatePhotos.filter(passesMapFilter);
  setSuggestedCount(photos.filter(photo => keywordGuesses.has(photo.id)).length);
  if (activeSmartAlbumId) {
    const dirty = filterStateSignature() !== albumSavedSignature;
    setAlbumDirty(dirty); // disquette de l'album intelligent ouvert
    // Album ouvert et à jour : la grille donne son compteur sans calcul (on évite aussi qu'il reste périmé après une écriture de métadonnées).
    if (!dirty && pathFilter === null) setAlbumCount(activeSmartAlbumId, mapCandidatePhotos.length);
  }
  const listComparator = getListGridComparator();
  photos.sort((a, b) => comparePhotosForSort(a, b, listComparator)); // même liste pour la grille et la navigation en plein écran
  renderFilterSummaries();
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
    clearFullscreenImage();
    updateRatingAction();
    document.getElementById('exif-title').textContent = '-';
    document.getElementById('exif-caption').textContent = '-';
    renderInfoAuthor(null);
    renderFileDates(null);
    updateInfoFolder(null);
    refreshInfoRows();
  }
  updateFilteredPhotosCount();
  renderRawSearchBanner(); // mode « Trouver le RAW » : le nombre de résultats suit les filtres
  renderDuplicateBanner(); // duplicate search: the counts follow the filters
  renderSemanticBanner(); // content search: same
  reloadFacesView(); // vue Visages ouverte : visages des photos désormais affichées
  refreshMapMode(); // mode Carte ouvert : points des photos désormais affichées
  refreshListView({ dataChanged: true });
  // Large folder: the loaded list was prefiltered by the backend; a change of those filters reads it again.
  if (largeScope && prefilterKey(sqlPrefilter()) !== loadedPrefilterKey) schedulePrefilterReload();
}

// Mots-clés du panneau d'infos sous forme d'étiquettes cliquables (même aspect que celles du filtre) : un clic remplace les mots-clés filtrés
// par celui-ci, Ctrl + clic l'ajoute à ceux déjà filtrés. Les autres filtres (note, couleur, nom de fichier, date) ne sont pas touchés.
// Le filtre compare les mots-clés tels que stockés : on filtre sur la valeur brute et on n'affiche décodé que le texte (entités HTML).
function renderInfoKeywords(photo) {
  const container = document.getElementById('exif-keywords');
  const words = (photo.keywords || '').split(', ').map(word => word.trim()).filter(Boolean);
  if (words.length === 0) {
    container.textContent = '-';
    return;
  }
  container.replaceChildren(...words.map(word => {
    const button = document.createElement('button');
    button.type = 'button';
    const active = keywordFilters.includes(word);
    button.className = `filter-tag tag-keyword${active ? ' active' : ''}`;
    button.setAttribute('aria-pressed', String(active));
    button.textContent = decodeHtmlEntities(word);
    button.title = t('Filter on this keyword (Ctrl+click: add to the filter, Alt+click: exclude it)');
    button.addEventListener('click', event => {
      if (event.altKey) {
        setKeywordFilter(word, true); // exclusion added to the current keyword filters
      } else if (event.ctrlKey || event.metaKey) {
        setKeywordFilter(word, false);
      } else {
        keywordFilters = [word];
        excludedKeywordFilters = [];
        keywordChildrenFilters.clear();
        excludedKeywordChildrenFilters.clear();
      }
      renderKeywordFilters();
      applyPhotoFilters();
    });
    return button;
  }));
}

// Efface un type de filtre (contrôles compris) sans relancer le filtrage : l'appelant le fait. Servent à « Effacer tous les filtres »,
// au × d'un groupe replié (clearFilterGroup) et au × des badges du bloc replié.
const clearFilterKinds = {
  rating() {
    Object.assign(ratingFilter, { stars: 0, unrated: false }); // le mode (≥ / =) reste celui choisi par l'utilisateur
    updateRatingFilterControls();
  },
  color() {
    colorFilters.clear();
    document.querySelectorAll('#color-filter-bar .color-square').forEach(btn => setColorSquareChecked(btn, false));
  },
  pick() {
    pickFilters.clear();
    document.querySelectorAll('#pick-filter-bar .pick-square').forEach(btn => setColorSquareChecked(btn, false));
  },
  keyword() {
    keywordFilters = [];
    excludedKeywordFilters = [];
    keywordChildrenFilters.clear();
    excludedKeywordChildrenFilters.clear();
    const keywordInput = document.getElementById('keyword-filter-input');
    if (keywordInput) keywordInput.value = '';
    renderKeywordFilters();
  },
  filename() {
    filenameFilters = [];
    excludedFilenameFilters = [];
    const filenameInput = document.getElementById('filename-filter-input');
    if (filenameInput) filenameInput.value = '';
    renderFilenameFilters();
  },
  failed() {
    pathFilter = null;
    renderFilterTags();
  },
  person: () => clearPersonFilters(),
  date() {
    dateFilterInput.value = '';
    setDateFilter(null);
    updateDateFilterUI('');
    closeDatePicker();
  },
  location: () => setLocationFilter('all', { apply: false }),
  'map-zone': () => clearMapZoneFilter({ apply: false }),
  analysis: () => setAnalysisFilter('all', { apply: false }),
  gear: () => shootingFilters.clearGear(),
  shot: () => shootingFilters.clearShot(),
  format: () => formatFilters.reset(),
  author: () => authorFilters.reset(),
};

// Types de filtre de chaque groupe de l'accordéon (data-filter-group), pour le × d'un groupe.
const filterGroupKinds = {
  'rating-color': ['rating', 'color', 'pick'],
  tags: ['keyword', 'filename', 'failed'],
  persons: ['person'],
  date: ['date'],
  gear: ['gear'],
  shooting: ['shot'],
  more: ['format', 'author', 'location', 'map-zone', 'analysis'],
};

// Remet tous les filtres à zéro (contrôles compris) sans relancer le filtrage : l'appelant le fait. Les filtres hérités d'un album parent restent.
function resetAllFilters() {
  albumFolder = null;
  albumMapZone = null;
  for (const clear of Object.values(clearFilterKinds)) clear();
}

// Efface les filtres d'un groupe (ou d'un seul type pour un badge) puis relance le filtrage une seule fois.
function clearFilterKindsAndApply(kinds) {
  for (const kind of kinds) clearFilterKinds[kind]();
  applyPhotoFilters();
}

function clearAllFilters() {
  resetAllFilters();
  // Réapplique la liste sans aucun filtre
  applyPhotoFilters();
}

document.getElementById('btn-clear-all-filters')?.addEventListener('click', clearAllFilters);

// ==========================================
// ALBUMS INTELLIGENTS : ÉTAT DES FILTRES ENREGISTRÉ (voir albums-panel.js)
// ==========================================
// Un album intelligent enregistre ses PROPRES critères (jamais d'identifiants de photos) : note, couleurs, pick, mots-clés, noms de fichier, date,
// personnes, lieu, dossier du disque et zone de carte. Les critères des albums intelligents parents s'y ajoutent sans pouvoir être modifiés ici.
let albumInherited = []; // [{ name, state }] critères des albums intelligents parents, du plus éloigné au plus proche
let albumFolder = null; // { path, recursive } : dossier du disque enregistré dans l'album ouvert (critère propre, retirable)
let albumMapZone = null; // { south, north, west, east } : zone de carte enregistrée dans l'album ouvert
let activeSmartAlbumId = 0; // album intelligent dont les filtres sont chargés dans l'interface (0 : aucun)
let albumSavedSignature = ''; // état enregistré de cet album : l'écart avec l'état courant allume la disquette

const normalizeFilterPath = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const lastPathSegment = path => path.split(/[\\/]/).filter(Boolean).pop() || path;

// Critères propres affichés par les contrôles de filtrage, plus le dossier et la zone de carte déjà enregistrés dans l'album ouvert.
function captureFilterState() {
  const state = {};
  if (isRatingFilterActive()) state.rating = { stars: ratingFilter.stars, mode: ratingFilter.mode, unrated: ratingFilter.unrated };
  if (colorFilters.size) state.colors = [...colorFilters].sort();
  if (pickFilters.size) state.picks = [...pickFilters].sort();
  if (keywordFilters.length) state.keywords = [...keywordFilters];
  const keywordsWithChildren = [...keywordChildrenFilters].filter(keyword => keywordFilters.includes(keyword)).sort();
  if (keywordsWithChildren.length) state.keywordsWithChildren = keywordsWithChildren;
  if (excludedKeywordFilters.length) state.excludedKeywords = [...excludedKeywordFilters];
  const excludedKeywordsWithChildren = [...excludedKeywordChildrenFilters].filter(keyword => excludedKeywordFilters.includes(keyword)).sort();
  if (excludedKeywordsWithChildren.length) state.excludedKeywordsWithChildren = excludedKeywordsWithChildren;
  if (filenameFilters.length) state.filenames = [...filenameFilters];
  if (excludedFilenameFilters.length) state.excludedFilenames = [...excludedFilenameFilters];
  const dateText = dateFilterInput.value.trim();
  if (dateFilter && dateText) state.date = dateText;
  const persons = getPersonFilterIds();
  if (persons.length) state.persons = persons;
  const excludedPersons = getExcludedPersonFilterIds();
  if (excludedPersons.length) state.excludedPersons = excludedPersons;
  if (locationFilter !== 'all') state.location = locationFilter;
  Object.assign(state, shootingFilters.capture()); // gear (appareil, objectif) et shot (focale, vitesse, ouverture, ISO, flash)
  Object.assign(state, formatFilters.capture()); // formats (type, marque de RAW, extensions)
  Object.assign(state, authorFilters.capture()); // authors, excludedAuthors
  if (albumFolder) state.folder = albumFolder;
  if (albumMapZone) state.mapZone = albumMapZone;
  return state;
}

const filterStateSignature = () => JSON.stringify(captureFilterState());

// « Vue actuelle » à enregistrer dans un album : hors album, le dossier affiché et la zone visible de la carte en font partie.
function captureCurrentView() {
  const state = captureFilterState();
  if (!getSelectedAlbum()) {
    if (currentFolderFilter !== null) state.folder = { path: currentFolderFilter, recursive: includeSubfolders };
    const zone = getVisibleZone();
    if (zone) state.mapZone = zone;
  }
  return state;
}

// Une photo satisfait-elle tous les critères d'un état enregistré ? (même sens que les filtres de la barre latérale)
function matchesFilterState(photo, state) {
  if (state.rating && !matchesRatingFilter(photo, state.rating)) return false;
  if (state.colors && !state.colors.includes(photo.color_flag || 'none')) return false;
  if (state.picks && !state.picks.includes(photo.pick_flag || 'none')) return false;
  if ((state.keywords || state.excludedKeywords) && !matchesKeywordFilters(photo, state.keywords, state.excludedKeywords, state.keywordsWithChildren, state.excludedKeywordsWithChildren)) return false;
  if ((state.filenames || state.excludedFilenames) && !matchesFilenameFilters(photo, state.filenames, state.excludedFilenames)) return false;
  if (state.date) {
    const range = parseDateFilter(state.date).filter;
    const key = photoTimeKey(photo);
    if (range && (key === null || key < range.from || key > range.to)) return false;
  }
  if ((state.persons || state.excludedPersons) && !photoMatchesPersonIds(photo, state.persons, state.excludedPersons)) return false;
  if (state.location) {
    const located = Number.isFinite(photo.gps_lat) && Number.isFinite(photo.gps_lon);
    if ((state.location === 'geolocated') !== located) return false;
  }
  if (!matchesShootingState(photo, state)) return false;
  if (!matchesFormatState(photo, state)) return false;
  if (state.folder?.path) {
    const folder = normalizeFilterPath(state.folder.path);
    const path = photo.path.replace(/\\/g, '/').toLowerCase();
    const directory = path.slice(0, path.lastIndexOf('/'));
    if (!(state.folder.recursive ? directory === folder || directory.startsWith(`${folder}/`) : directory === folder)) return false;
  }
  if (state.mapZone) {
    const { south, north, west, east } = state.mapZone;
    if (!Number.isFinite(photo.gps_lat) || !Number.isFinite(photo.gps_lon)) return false;
    const inLatitude = photo.gps_lat >= south && photo.gps_lat <= north;
    const inLongitude = west <= east ? photo.gps_lon >= west && photo.gps_lon <= east : photo.gps_lon >= west || photo.gps_lon <= east;
    if (!inLatitude || !inLongitude) return false;
  }
  return true;
}

// Critères d'album qui s'ajoutent aux filtres de la barre latérale : ceux des parents et les critères propres sans contrôle (dossier, zone de carte).
function matchesAlbumCriteria(photo) {
  if (albumInherited.length && !albumInherited.every(({ state }) => matchesFilterState(photo, state))) return false;
  return (!albumFolder && !albumMapZone) || matchesFilterState(photo, { folder: albumFolder ?? undefined, mapZone: albumMapZone ?? undefined });
}

// Charge un état enregistré dans les contrôles (ils ont été remis à zéro avant) sans relancer le filtrage.
function applyFilterState(state) {
  if (state.rating) Object.assign(ratingFilter, { stars: state.rating.stars || 0, mode: state.rating.mode === 'eq' ? 'eq' : 'gte', unrated: Boolean(state.rating.unrated) });
  updateRatingFilterControls();
  for (const key of state.colors ?? []) colorFilters.add(key);
  document.querySelectorAll('#color-filter-bar .color-square').forEach(button => setColorSquareChecked(button, colorFilters.has(button.dataset.flag)));
  for (const key of state.picks ?? []) pickFilters.add(key);
  document.querySelectorAll('#pick-filter-bar .pick-square').forEach(button => setColorSquareChecked(button, pickFilters.has(button.dataset.pick)));
  keywordFilters = [...(state.keywords ?? [])];
  excludedKeywordFilters = [...(state.excludedKeywords ?? [])].filter(keyword => !keywordFilters.includes(keyword));
  keywordChildrenFilters = new Set((state.keywordsWithChildren ?? []).filter(keyword => keywordFilters.includes(keyword)));
  excludedKeywordChildrenFilters = new Set((state.excludedKeywordsWithChildren ?? []).filter(keyword => excludedKeywordFilters.includes(keyword)));
  renderKeywordFilters();
  filenameFilters = [...(state.filenames ?? [])];
  excludedFilenameFilters = [...(state.excludedFilenames ?? [])];
  renderFilenameFilters();
  if (state.date) {
    dateFilterInput.value = state.date;
    setDateFilter(parseDateFilter(state.date).filter ?? null);
    updateDateFilterUI('');
  }
  setPersonFilterIds(state.persons ?? [], state.excludedPersons ?? []);
  setLocationFilter(state.location ?? 'all', { apply: false });
  shootingFilters.apply(state);
  formatFilters.apply(state);
  authorFilters.apply(state);
  albumFolder = state.folder ?? null;
  albumMapZone = state.mapZone ?? null;
}

// Appelée quand l'album affiché change : entre dans un album intelligent (ses filtres remplacent tout filtre précédent) ou en sort (filtres remis à zéro).
function syncSmartAlbumWithSelection() {
  const album = getSelectedAlbum();
  const smartId = album?.kind === 'smart' ? album.id : 0;
  if (smartId === activeSmartAlbumId) return;
  resetAllFilters();
  albumInherited = [];
  activeSmartAlbumId = smartId;
  if (smartId) {
    const context = getAlbumContext(smartId);
    albumInherited = context.inherited;
    applyFilterState(context.own);
  }
  albumSavedSignature = filterStateSignature();
  setAlbumDirty(false);
}

// Disquette : enregistre les modifications de l'album ouvert (critères propres seulement). Renvoie vrai si c'est enregistré.
async function saveActiveSmartAlbum() {
  if (!activeSmartAlbumId) return true;
  try {
    await invoke('set_album_filters', { id: activeSmartAlbumId, filters: JSON.stringify(captureFilterState()) });
  } catch (error) {
    showWriteToast(t(String(error?.message ?? error)));
    return false;
  }
  albumSavedSignature = filterStateSignature();
  setAlbumDirty(false);
  await refreshAlbums();
  return true;
}

// « Enregistrer la vue actuelle dans cet album » : écrase les critères d'un album intelligent par ceux de la vue affichée.
async function saveCurrentViewInto(albumId) {
  const state = captureCurrentView();
  try {
    await invoke('set_album_filters', { id: albumId, filters: JSON.stringify(state) });
  } catch (error) {
    showWriteToast(t(String(error?.message ?? error)));
    return;
  }
  await refreshAlbums();
  if (albumId === activeSmartAlbumId) {
    // L'album ouvert prend la vue enregistrée : plus rien n'est en attente.
    resetAllFilters();
    applyFilterState(state);
    albumSavedSignature = filterStateSignature();
    setAlbumDirty(false);
    const neededChildren = activeChildrenKeywords();
    if (neededChildren.length) await ensureKeywordDescendantPhotos(neededChildren);
    applyPhotoFilters();
  }
}

// Smart album and virtual folder counters. A smart album counts photos from the entire library (or from the content of its
// manual or smart parent) that meet its saved criteria; a virtual folder counts the DISTINCT photos of everything it contains.
// The calculation re-reads the full photo list: it is deferred and batched (only one execution at a time), and unnecessary without any albums.
let albumCountsTimer = null;
let albumCountsRunning = false;
let albumCountsAgain = false;

function scheduleAlbumCounts() {
  clearTimeout(albumCountsTimer);
  albumCountsTimer = setTimeout(computeAlbumCounts, 500);
}

async function computeAlbumCounts() {
  const nodes = getAlbumNodes();
  if (!nodes.some(node => node.kind !== 'manual')) return; // les albums manuels viennent déjà avec leur compteur
  if (!isAlbumsSectionExpanded()) return; // bloc replié : rien à afficher, le calcul se fait à la prochaine ouverture
  if (albumCountsRunning) { albumCountsAgain = true; return; }
  albumCountsRunning = true;
  try {
    const [everything, pairs] = await Promise.all([
      invoke('get_photos_paginated', { offset: 0, limit: 50000, folderFilter: null, recursive: true }),
      invoke('get_album_memberships'),
    ]);
    const byId = new Map(everything.map(photo => [photo.id, photo]));
    const members = new Map();
    for (const [albumId, photoId] of pairs) {
      if (!byId.has(photoId)) continue;
      if (!members.has(albumId)) members.set(albumId, new Set());
      members.get(albumId).add(photoId);
    }
    const children = new Map();
    for (const node of nodes) children.set(node.parent_id, [...(children.get(node.parent_id) ?? []), node]);
    const parsedFilters = new Map();
    const descendantKeywords = [];
    for (const node of nodes) {
      if (node.kind !== 'smart') continue;
      let own = {};
      try { own = JSON.parse(node.filters) || {}; } catch { /* critères illisibles : album sans filtre */ }
      parsedFilters.set(node.id, own);
      for (const word of own.keywordsWithChildren ?? []) descendantKeywords.push(word);
      for (const word of own.excludedKeywordsWithChildren ?? []) descendantKeywords.push(word);
    }
    if (descendantKeywords.length) await ensureKeywordDescendantPhotos(descendantKeywords);
    const sets = new Map();
    const setOf = node => {
      if (sets.has(node.id)) return sets.get(node.id);
      const result = new Set();
      if (node.kind === 'manual') {
        for (const id of members.get(node.id) ?? []) result.add(id);
      } else if (node.kind === 'smart') {
        // Point de départ : le contenu du parent (manuel ou intelligent, qui a déjà ses propres critères), sinon toute la photothèque.
        const parent = nodes.find(candidate => candidate.id === node.parent_id);
        const start = parent && parent.kind !== 'folder' ? setOf(parent) : byId.keys();
        const own = parsedFilters.get(node.id) ?? {};
        for (const id of start) if (matchesFilterState(byId.get(id), own)) result.add(id);
      } else {
        for (const child of children.get(node.id) ?? []) for (const id of setOf(child)) result.add(id);
      }
      sets.set(node.id, result);
      return result;
    };
    setAlbumCounts(new Map(nodes.map(node => [node.id, setOf(node).size])));
  } catch (error) {
    console.error('Album counts unavailable:', error);
  } finally {
    albumCountsRunning = false;
    if (albumCountsAgain) { albumCountsAgain = false; scheduleAlbumCounts(); }
  }
}

// Libellés courts des critères d'un état, pour les étiquettes grisées des filtres hérités.
function describeFilterState(state) {
  const labels = [];
  if (state.rating) labels.push([state.rating.unrated ? '∅' : '', state.rating.stars > 0 ? `${state.rating.mode === 'eq' ? '=' : '≥'} ${state.rating.stars} ★` : ''].filter(Boolean).join(' + '));
  for (const key of state.colors ?? []) labels.push(colorFlagLabels.get(key) ?? key);
  for (const key of state.picks ?? []) labels.push(t(PICK_FLAGS.find(flag => flag.key === key)?.label ?? key));
  const includedChildren = new Set(state.keywordsWithChildren ?? []);
  const excludedChildren = new Set(state.excludedKeywordsWithChildren ?? []);
  labels.push(
    ...(state.keywords ?? []).map(keyword => `${keyword}${includedChildren.has(keyword) ? '~' : ''}`),
    ...(state.excludedKeywords ?? []).map(keyword => `-${keyword}${excludedChildren.has(keyword) ? '~' : ''}`),
    ...(state.filenames ?? []),
    ...(state.excludedFilenames ?? []).map(text => `-${text}`),
  );
  if (state.date) labels.push(state.date);
  if (state.persons?.length) labels.push(`${t('People')} (${state.persons.length})`);
  if (state.excludedPersons?.length) labels.push(`-${t('People')} (${state.excludedPersons.length})`);
  if (state.location) labels.push(t(state.location === 'geolocated' ? 'Geolocated' : 'Not geolocated'));
  if (state.folder?.path) labels.push(t('Folder: {name}', { name: lastPathSegment(state.folder.path) }));
  if (state.mapZone) labels.push(t('Map area'));
  return labels;
}

// Bloc sous les badges des filtres : critères hérités des parents (grisés, non modifiables) et critères propres sans contrôle (dossier, zone de carte).
function renderAlbumFilterInfo() {
  const container = document.getElementById('album-filter-info');
  if (!container) return;
  const rows = [];
  for (const { name, state } of albumInherited) {
    const labels = describeFilterState(state);
    if (!labels.length) continue;
    const row = document.createElement('div');
    row.className = 'album-filter-row inherited';
    row.title = t('Inherited from "{name}": these filters cannot be changed here', { name });
    const title = document.createElement('span');
    title.className = 'album-filter-title';
    title.textContent = t('Inherited from "{name}"', { name });
    row.append(title, ...labels.map(text => Object.assign(document.createElement('span'), { className: 'filter-tag tag-muted', textContent: text })));
    rows.push(row);
  }
  const own = [];
  if (albumFolder) own.push([() => { albumFolder = null; }, t('Folder: {name}', { name: lastPathSegment(albumFolder.path) }), albumFolder.path]);
  if (albumMapZone) own.push([() => { albumMapZone = null; }, t('Map area'), t('Map area saved in this album')]);
  if (own.length) {
    const row = document.createElement('div');
    row.className = 'album-filter-row';
    for (const [clear, text, title] of own) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'filter-tag tag-location';
      button.textContent = `${text} ×`;
      button.title = title;
      button.addEventListener('click', () => { clear(); applyPhotoFilters(); });
      row.append(button);
    }
    rows.push(row);
  }
  container.replaceChildren(...rows);
  container.hidden = rows.length === 0;
}

// Keywords of the catalogue offered by the keyword filter field, with their photo count, and its suggestion list (filter-suggest.js,
// wired at startup). Keywords already in the filter are not offered again: their chip's context menu switches them.
let keywordFilterOptions = [];
let keywordFilterSuggest = null;
let keywordOptionsSource = null;
let keywordTreeNodes = [];
let keywordActiveIds = new Set();
let keywordHasChildrenKeys = new Set(); // lowercase keyword names that have at least one child node in the tree
let keywordTreeLoaded = false;
let keywordTreeGeneration = 0;
let keywordDescendantPhotos = new Map(); // lowercase keyword name -> Set<photoId> carrying strict descendants
let keywordDescendantsGeneration = 0;

function activeChildrenKeywords() {
  const words = [...keywordChildrenFilters, ...excludedKeywordChildrenFilters];
  for (const { state } of albumInherited) {
    for (const word of state.keywordsWithChildren ?? []) words.push(word);
    for (const word of state.excludedKeywordsWithChildren ?? []) words.push(word);
  }
  return [...new Set(words)];
}

async function ensureKeywordDescendantPhotos(keywords, { reapply = false } = {}) {
  const missing = [];
  const seenKeys = new Set();
  for (const word of keywords) {
    const key = keywordKey(word);
    if (!key || seenKeys.has(key) || keywordDescendantPhotos.has(key)) continue;
    seenKeys.add(key);
    missing.push(word);
  }
  if (missing.length === 0) return;
  const generation = keywordDescendantsGeneration;
  try {
    const map = await invoke('get_keyword_descendant_photos', { keywords: missing });
    if (generation !== keywordDescendantsGeneration) return;
    for (const word of missing) {
      const key = keywordKey(word);
      keywordDescendantPhotos.set(key, new Set(map[key] ?? []));
    }
    if (reapply) applyPhotoFilters({ keepState: true });
  } catch (error) {
    console.debug('Keyword descendant lookup failed', error);
  }
}

function rebuildKeywordFilterOptions() {
  const counts = new Map();
  for (const photo of folderTreePhotos) {
    if (!photo.keywords) continue;
    const seen = new Set();
    for (const raw of photo.keywords.split(', ')) {
      const word = raw.trim();
      if (!word || seen.has(word)) continue;
      seen.add(word);
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  // Inactive parent keywords (0 direct photos, >= 1 active descendant) appear in suggestions with count 0 so Shift+Click/Enter can pick them.
  if (keywordTreeNodes.length && keywordActiveIds.size) {
    const nodeById = new Map(keywordTreeNodes.map(node => [node.id, node]));
    const presentKeys = new Set([...counts.keys()].map(keywordKey));
    const visited = new Set();
    for (const activeId of keywordActiveIds) {
      let current = nodeById.get(activeId);
      while (current && current.parent_id !== 0) {
        current = nodeById.get(current.parent_id);
        if (!current || visited.has(current.id)) break;
        visited.add(current.id);
        const key = keywordKey(current.name);
        if (!key || presentKeys.has(key)) continue;
        presentKeys.add(key);
        counts.set(current.name, 0);
      }
    }
  }
  keywordFilterOptions = [...counts].map(([word, count]) => {
    const label = decodeHtmlEntities(word);
    return { value: word, label, count, search: normalizeSearch(label) };
  });
  keywordFilterSuggest?.refresh();
}

async function refreshKeywordFilterTree() {
  const treeGen = ++keywordTreeGeneration;
  keywordDescendantsGeneration++;
  keywordDescendantPhotos.clear();
  try {
    const { nodes, active_ids: activeIds } = await invoke('get_keyword_filter_tree');
    if (treeGen !== keywordTreeGeneration) return;
    keywordTreeNodes = nodes;
    keywordActiveIds = new Set(activeIds);
    const parentIds = new Set(nodes.map(node => node.parent_id).filter(id => id !== 0));
    const hasChildren = new Set();
    for (const node of nodes) if (parentIds.has(node.id)) hasChildren.add(keywordKey(node.name));
    keywordHasChildrenKeys = hasChildren;
    keywordTreeLoaded = true;
    rebuildKeywordFilterOptions();
    renderFilterTags();
    const needed = activeChildrenKeywords();
    if (needed.length) await ensureKeywordDescendantPhotos(needed, { reapply: true });
  } catch (error) {
    console.debug('Keyword filter tree unavailable', error);
  }
}

function renderKeywordFilters({ force = false } = {}) {
  const sourceChanged = force || keywordOptionsSource?.photos !== folderTreePhotos || keywordOptionsSource?.length !== folderTreePhotos.length;
  if (sourceChanged) {
    keywordOptionsSource = { photos: folderTreePhotos, length: folderTreePhotos.length };
    rebuildKeywordFilterOptions();
    shootingFilters.refreshOptions(); // listes des appareils et objectifs : la collection a pu changer
    authorFilters.refreshAuthors(); // liste des auteurs de la base : idem
  }
  if (force || !keywordTreeLoaded) refreshKeywordFilterTree();
  keywordFilterSuggest?.refresh();
  renderFilterTags();
}

const hasKeywordFilters = () => keywordFilters.length > 0 || excludedKeywordFilters.length > 0;
const hasKeywordChildFlag = (collection, item) => (collection instanceof Set ? collection.has(item) : Boolean(collection?.includes(item)));

function matchesSingleKeyword(photo, words, keyword, withChildren) {
  if (words.includes(keyword)) return true;
  if (!withChildren) return false;
  return keywordDescendantPhotos.get(keywordKey(keyword))?.has(photo.id) ?? false;
}

// A photo passes if it carries every included keyword (or a descendant when `~` is active) and none of the excluded ones.
// Excluded keywords are never sent to the backend prefilter: it stays a superset of this test.
function matchesKeywordFilters(
  photo,
  included = keywordFilters,
  excluded = excludedKeywordFilters,
  includedChildren = keywordChildrenFilters,
  excludedChildren = excludedKeywordChildrenFilters,
) {
  if (!included?.length && !excluded?.length) return true;
  const words = (photo.keywords || '').split(', ');
  return (included ?? []).every(keyword => matchesSingleKeyword(photo, words, keyword, hasKeywordChildFlag(includedChildren, keyword)))
    && !(excluded ?? []).some(keyword => matchesSingleKeyword(photo, words, keyword, hasKeywordChildFlag(excludedChildren, keyword)));
}

// Keyword filter with content-search suggestions (semantic-keywords.js, setting "Include suggestions in keyword filtering"): every included keyword is
// carried or suggested, nothing excluded is carried. `keywordGuesses` (rebuilt by each filtering) maps a photo id to the included keywords it only
// has by suggestion; a photo carrying everything is not in it.
function matchesKeywordFiltersOrSuggested(photo) {
  if (matchesKeywordFilters(photo)) return true;
  if (!suggestionsLoaded() || keywordFilters.length === 0) return false;
  const words = (photo.keywords || '').split(', ');
  if (excludedKeywordFilters.some(keyword => matchesSingleKeyword(photo, words, keyword, excludedKeywordChildrenFilters.has(keyword)))) return false;
  const guessed = [];
  for (const keyword of keywordFilters) {
    if (matchesSingleKeyword(photo, words, keyword, keywordChildrenFilters.has(keyword))) continue;
    if (!suggestionFor(keyword, photo.id)) return false;
    guessed.push(keyword);
  }
  keywordGuesses.set(photo.id, guessed);
  return true;
}

// Cheap key of "the view" for the suggestions: they are searched again only when the filter or this key changes (never null in a plain view).
function keywordSuggestionViewKey() {
  if (isRawSearchActive() || isDuplicateSearchActive() || isSemanticSearchActive()) return null; // results modes: no suggestions
  return `${currentFolderFilter}|${includeSubfolders}|${getSelectedAlbum()?.id ?? ''}|${extraFolderFilters.join('\n')}`;
}

// Scope of the suggestions = the view (same as the content search); filters are not part of it, they apply to the suggested photos afterwards.
function keywordSuggestionScope() {
  const { folder, recursive, photoIds } = currentViewScope();
  return { folder: folder ?? null, recursive: Boolean(recursive), photoIds: photoIds ?? null, skipRaw: !readBool('semanticScanRaw') };
}

// Puts a keyword in the included or excluded list (and out of the other one). When `includeChildren` is null, preserves the existing `~` mode.
// Neither re-renders nor filters: the caller does.
function setKeywordFilter(keyword, exclude, includeChildren = null) {
  const wasWithChildren = keywordChildrenFilters.has(keyword) || excludedKeywordChildrenFilters.has(keyword);
  const keepChildren = includeChildren === null ? wasWithChildren : Boolean(includeChildren);
  keywordFilters = keywordFilters.filter(item => item !== keyword);
  excludedKeywordFilters = excludedKeywordFilters.filter(item => item !== keyword);
  keywordChildrenFilters.delete(keyword);
  excludedKeywordChildrenFilters.delete(keyword);
  (exclude ? excludedKeywordFilters : keywordFilters).push(keyword);
  if (keepChildren) (exclude ? excludedKeywordChildrenFilters : keywordChildrenFilters).add(keyword);
}

async function addKeywordFilter(value, exclude = false, includeChildren = false) {
  const keyword = value.trim();
  if (!keyword) return;
  document.getElementById('keyword-filter-input').value = '';
  const targetList = exclude ? excludedKeywordFilters : keywordFilters;
  const targetChildren = exclude ? excludedKeywordChildrenFilters : keywordChildrenFilters;
  if (targetList.includes(keyword) && targetChildren.has(keyword) === includeChildren) return;
  setKeywordFilter(keyword, exclude, includeChildren);
  renderKeywordFilters();
  if (includeChildren) await ensureKeywordDescendantPhotos([keyword]);
  applyPhotoFilters();
}

async function toggleKeywordChildren(keyword, excluded) {
  const childrenSet = excluded ? excludedKeywordChildrenFilters : keywordChildrenFilters;
  const enable = !childrenSet.has(keyword);
  if (enable) childrenSet.add(keyword);
  else childrenSet.delete(keyword);
  renderFilterTags();
  if (enable) await ensureKeywordDescendantPhotos([keyword]);
  applyPhotoFilters();
}

// FILTRE PAR NOM DE FICHIER : chaque chaîne validée (Entrée) doit figurer dans le nom du fichier (extension comprise), sans tenir compte de la casse.
const FILENAME_FILTER_PATTERN = /^[\p{L}\p{N}._-]{3,}$/u;

const hasFilenameFilters = () => filenameFilters.length > 0 || excludedFilenameFilters.length > 0;

// Every included text in the file name, and none of the excluded ones (case ignored). Excluded texts never reach the backend prefilter.
function matchesFilenameFilters(photo, included = filenameFilters, excluded = excludedFilenameFilters) {
  if (!included?.length && !excluded?.length) return true;
  const name = (photo.filename || photo.path.split(/[\\/]/).pop() || '').toLowerCase();
  return (included ?? []).every(text => name.includes(text.toLowerCase())) && !(excluded ?? []).some(text => name.includes(text.toLowerCase()));
}

function renderFilenameFilters() {
  renderFilterTags();
}

// Puts a text in the included or excluded filename list (and out of the other one). Neither re-renders nor filters: the caller does.
function setFilenameFilter(text, exclude) {
  const other = item => item.toLowerCase() !== text.toLowerCase();
  filenameFilters = filenameFilters.filter(other);
  excludedFilenameFilters = excludedFilenameFilters.filter(other);
  (exclude ? excludedFilenameFilters : filenameFilters).push(text);
}

// `exclude` (Alt+Enter): the file name must not contain the text.
function addFilenameFilter(value, exclude = false) {
  const text = value.trim();
  if (!text) return;
  if (!FILENAME_FILTER_PATTERN.test(text)) {
    showWriteToast(t('Only words of at least 3 characters made of letters, digits and the characters "-", "_" and "." are accepted'));
    return;
  }
  document.getElementById('filename-filter-input').value = '';
  if ((exclude ? excludedFilenameFilters : filenameFilters).some(item => item.toLowerCase() === text.toLowerCase())) return;
  setFilenameFilter(text, exclude);
  renderFilenameFilters();
  applyPhotoFilters();
}

// ACCORDÉON DES FILTRES : un clic déplie un groupe et replie les autres ; Maj + clic déplie ou replie un groupe sans toucher aux autres
// (on peut ainsi en garder plusieurs ouverts ; le clic suivant sans Maj sur un autre groupe ne laisse ouvert que celui-là).
// Replié, un groupe tient sur une ligne compacte (titre + résumé / étiquettes) cliquable pour le déplier ; un clic hors de la zone des filtres replie tout.
// Le × d'un groupe actif efface ses filtres sans le déplier.
const filterGroups = [...document.querySelectorAll('.photo-filters .filter-group')];

// `names` : groupes (data-filter-group) à laisser dépliés ; tous les autres sont repliés.
function setExpandedFilterGroups(names) {
  const open = new Set(names);
  for (const group of filterGroups) {
    const expanded = open.has(group.dataset.filterGroup);
    group.classList.toggle('expanded', expanded);
    group.querySelector('.filter-group-toggle').setAttribute('aria-expanded', String(expanded));
    group.querySelector('.filter-group-body').hidden = !expanded;
  }
  if (!open.has('date')) closeDatePicker();
  fitCollapsedTags(); // la ligne repliée vient d'apparaître ou de disparaître : on la mesure à nouveau
}

for (const group of filterGroups) {
  const name = group.dataset.filterGroup;
  // Tout l'en-tête est cliquable (le bouton de bascule, sans texte, porte le focus clavier et l'état ARIA) ; les croix gardent leur propre clic.
  group.querySelector('.filter-group-header').addEventListener('click', event => {
    if (event.target.closest('.filter-group-clear, .filter-tag-clear')) return;
    const open = new Set(filterGroups.filter(item => item.classList.contains('expanded')).map(item => item.dataset.filterGroup));
    if (open.has(name)) {
      open.delete(name); // un groupe ouvert se replie, avec ou sans Maj, les autres restent comme ils sont
    } else {
      if (!event.shiftKey) open.clear(); // clic simple sur un groupe replié : il s'ouvre, tous les autres se ferment
      open.add(name);
    }
    setExpandedFilterGroups(open);
  });
  group.querySelector('.filter-group-clear')?.addEventListener('click', () => clearFilterKindsAndApply(filterGroupKinds[name] ?? []));
}

// Le calendrier est placé dans <body> : il fait partie de la zone des filtres pour ce test. Il en va de même du menu contextuel d'un champ de filtre
// (voir openTextFieldMenu, photo-actions.js) : cliquer sur l'une de ses lignes ne doit pas replier le groupe, sinon le champ disparaît avant l'action
// (coller, effacer) et le calendrier s'ouvrirait en haut de la fenêtre, son bouton n'étant plus affiché.
document.addEventListener('pointerdown', event => {
  if (!filterGroups.some(group => group.classList.contains('expanded'))) return;
  const target = event.target;
  if (target instanceof Element && (target.closest('.photo-filters') || target.closest('.date-picker') || target.closest('.context-menu'))) return;
  setExpandedFilterGroups([]);
}, true);

// Shift+K: shows the library panel, the Filters block and the Keywords / Name group (others stay as they are), then the keyword filter field.
function focusKeywordFilterField() {
  if (document.getElementById('sidebar-panel')?.classList.contains('hidden')) document.getElementById('btn-toggle-sidebar')?.click();
  const filtersToggle = document.getElementById('filters-toggle');
  if (filtersToggle?.getAttribute('aria-expanded') === 'false') filtersToggle.click();
  const open = filterGroups.filter(group => group.classList.contains('expanded')).map(group => group.dataset.filterGroup);
  setExpandedFilterGroups([...open, 'tags']);
  const input = document.getElementById('keyword-filter-input');
  input?.scrollIntoView({ block: 'nearest' });
  input?.focus();
  input?.select();
}

// Middle-click on a filter chip removes it, in an open group as on a folded line or a badge of the folded Filters block. The chip's own × (or,
// for an open group, the chip button itself) does the removal; chips with no removal ("…", inherited album criteria) are left alone.
const removableFilterTag = target => (target instanceof Element ? target.closest('.photo-filters .filter-tag:not(.tag-more):not(.tag-muted)') : null);
document.addEventListener('mousedown', event => {
  if (event.button === 1 && removableFilterTag(event.target)) event.preventDefault(); // no auto-scroll
});
document.addEventListener('auxclick', event => {
  if (event.button !== 1) return;
  const tag = removableFilterTag(event.target);
  if (!tag) return;
  event.preventDefault();
  event.stopPropagation();
  const clear = tag.querySelector('.filter-tag-clear');
  if (clear) clear.click();
  else if (tag instanceof HTMLButtonElement) tag.click();
});

// Keyword (blue) and filename (green) filter chips, shared row: buttons with × when expanded, tags after the group title when collapsed.
function renderFilterTags() {
  const expandedContainer = document.getElementById('filter-tags');
  const collapsedLine = document.getElementById('tags-collapsed-line');
  if (!expandedContainer || !collapsedLine) return;
  const entries = [
    ...(pathFilter !== null ? [{ kind: 'failed', text: t('Failed files') }] : []),
    ...keywordFilters.map(text => ({ kind: 'keyword', text, withChildren: keywordChildrenFilters.has(text) })),
    ...excludedKeywordFilters.map(text => ({ kind: 'keyword', text, excluded: true, withChildren: excludedKeywordChildrenFilters.has(text) })),
    ...filenameFilters.map(text => ({ kind: 'filename', text })),
    ...excludedFilenameFilters.map(text => ({ kind: 'filename', text, excluded: true })),
  ];
  // Remove a chip (expanded group buttons as well as collapsed tag × buttons) then re-filter.
  const removeEntry = (kind, text, excluded = false) => {
    if (kind === 'keyword' && excluded) {
      excludedKeywordFilters = excludedKeywordFilters.filter(item => item !== text);
      excludedKeywordChildrenFilters.delete(text);
    } else if (kind === 'keyword') {
      keywordFilters = keywordFilters.filter(item => item !== text);
      keywordChildrenFilters.delete(text);
    } else if (kind === 'failed') {
      pathFilter = null;
    } else if (excluded) {
      excludedFilenameFilters = excludedFilenameFilters.filter(item => item !== text);
    } else {
      filenameFilters = filenameFilters.filter(item => item !== text);
    }
    renderFilterTags();
    applyPhotoFilters();
  };
  // Excluded chips start with "-"; keywords with children mode enabled end with "~".
  const label = (text, excluded, withChildren = false) => `${excluded ? '-' : ''}${text}${withChildren ? '~' : ''}`;
  const addKeywordMenu = (node, kind, text, excluded, withChildren = false) => {
    if (kind !== 'keyword' && kind !== 'filename') return;
    const extraItems = [];
    if (kind === 'keyword' && (withChildren || keywordHasChildrenKeys.has(keywordKey(text)))) {
      const childrenLabel = excluded
        ? (withChildren ? 'Stop excluding children' : 'Also exclude children')
        : (withChildren ? 'Do not include children' : 'Include children');
      extraItems.push({ label: t(childrenLabel), onSelect: () => toggleKeywordChildren(text, excluded) });
    }
    addIncludeExcludeMenu(node, {
      label: label(text, excluded, withChildren),
      excluded,
      onToggle: () => {
        (kind === 'keyword' ? setKeywordFilter : setFilenameFilter)(text, !excluded);
        renderFilterTags();
        applyPhotoFilters();
      },
      extraItems,
    });
  };
  expandedContainer.replaceChildren(...entries.map(({ kind, text, excluded = false, withChildren = false }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `filter-tag tag-${kind}${withChildren ? ' with-children' : ''}`;
    const chipLabel = label(text, excluded, withChildren);
    button.textContent = `${chipLabel} ×`;
    button.title = t('Remove filter {keyword}', { keyword: chipLabel });
    button.addEventListener('click', () => removeEntry(kind, text, excluded));
    addKeywordMenu(button, kind, text, excluded, withChildren);
    return button;
  }));
  collapsedLine.querySelectorAll('.filter-tag').forEach(node => node.remove());
  collapsedLine.append(...entries.map(({ kind, text, excluded = false, withChildren = false }) => {
    const chipLabel = label(text, excluded, withChildren);
    const titleKey = kind === 'keyword'
      ? (excluded
        ? (withChildren ? 'Excluded keyword (with children): {text}' : 'Excluded keyword: {text}')
        : (withChildren ? 'Keyword (with children): {text}' : 'Keyword: {text}'))
      : kind === 'failed'
        ? 'Files whose keywords could not be written'
        : excluded ? 'Filename without: {text}' : 'Filename: {text}';
    const tag = createFilterTag({
      kind,
      text: chipLabel,
      title: t(titleKey, { text }),
      onRemove: () => removeEntry(kind, text, excluded),
    });
    if (withChildren) tag.classList.add('with-children');
    addKeywordMenu(tag, kind, text, excluded, withChildren);
    return tag;
  }));
  fitCollapsedTags();
}

// Lignes repliées (classe fit-lines) : au plus deux lignes. Si les étiquettes ne tiennent pas, les dernières sont masquées et remplacées par une
// étiquette « … » (d'une autre couleur) qui termine la deuxième ligne. Les lignes sont comptées d'après la position verticale des éléments
// (tous de même hauteur), ce qui suppose la ligne visible : une ligne masquée (groupe déplié) est mesurée quand elle réapparaît.
function fitCollapsedTags() {
  document.querySelectorAll('.filter-collapsed-line.fit-lines').forEach(fitCollapsedLine);
}

function fitCollapsedLine(line) {
  line.querySelectorAll('.tag-more').forEach(node => node.remove());
  const tags = [...line.querySelectorAll('.filter-tag')];
  tags.forEach(tag => { tag.hidden = false; });
  if (!line.offsetParent || tags.length === 0) return;
  const title = line.querySelector('.filter-group-title');
  const countRows = nodes => new Set(nodes.map(node => node.offsetTop)).size;
  if (countRows([title, ...tags]) <= 2) return;
  const more = document.createElement('span');
  more.className = 'filter-tag tag-more';
  more.textContent = '…';
  line.append(more);
  let visibleCount = tags.length;
  while (visibleCount > 0 && countRows([title, ...tags.slice(0, visibleCount), more]) > 2) {
    visibleCount--;
    tags[visibleCount].hidden = true;
  }
  more.title = tags.slice(visibleCount).map(tag => tag.dataset.label ?? tag.textContent).join(', ');
}

// La largeur d'une ligne change avec la barre latérale (redimensionnement, repli) ou quand son groupe est replié : ses étiquettes sont réparties à nouveau.
if (typeof ResizeObserver !== 'undefined') {
  const lineWidths = new WeakMap();
  const observer = new ResizeObserver(entries => {
    for (const { target } of entries) {
      if (target.clientWidth === lineWidths.get(target)) continue;
      lineWidths.set(target, target.clientWidth);
      fitCollapsedLine(target);
    }
  });
  document.querySelectorAll('.filter-collapsed-line.fit-lines').forEach(line => observer.observe(line));
}

// Bornes du filtre de date au format AAAAMMJJHHmmss -> « 01/05/2024 » ; l'heure n'est ajoutée que si elle diffère de celle par défaut de la borne (00:00:00 au début, 23:59:59 à la fin).
function formatDateFilterBound(key, isEnd) {
  const text = String(key).padStart(14, '0');
  const date = new Date(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
  const time = text.slice(8);
  const showTime = time !== (isEnd ? '235959' : '000000');
  return date.toLocaleDateString(getLanguage()) + (showTime ? ` ${time.slice(0, 2)}:${time.slice(2, 4)}` : '');
}

// Résumés affichés sur les lignes repliées : note (badge) et couleurs (pastilles), dates de début et de fin, étiquettes.
function renderFilterSummaries() {
  updateRatingFilterControls();
  const ratingColorNodes = [];
  if (isRatingFilterActive()) {
    const parts = [];
    if (ratingFilter.unrated) parts.push('∅');
    if (ratingFilter.stars > 0) parts.push(`${ratingFilter.mode === 'eq' ? '=' : '≥'} ${ratingFilter.stars} ★`);
    ratingColorNodes.push(createFilterTag({
      kind: 'rating',
      text: parts.join(' + '),
      title: ratingFilterDescription(),
      onRemove: () => clearFilterKindsAndApply(['rating']),
    }));
  }
  for (const key of colorFilters) {
    const dot = document.createElement('span');
    dot.className = `flag-indicator flag-${key}`;
    dot.title = colorFlagLabels.get(key) ?? key;
    ratingColorNodes.push(dot);
  }
  for (const key of pickFilters) {
    const mark = document.createElement('span');
    mark.className = `pick-indicator pick-${key}`;
    mark.title = t(PICK_FLAGS.find(flag => flag.key === key)?.label ?? key);
    ratingColorNodes.push(mark);
  }
  document.getElementById('rating-color-summary').replaceChildren(...ratingColorNodes);

  // Dates de début et de fin réunies en une seule étiquette (« Du 01/01/2024 au 31/12/2024 ») ; « Le 01/05/2024 » quand la période tient dans un jour.
  const dateNodes = dateFilter ? (() => {
    const from = formatDateFilterBound(dateFilter.from, false);
    const to = formatDateFilterBound(dateFilter.to, true);
    return [createFilterTag({
      kind: 'date',
      text: from === to ? t('On {date}', { date: from }) : t('From {from} to {to}', { from, to }),
      onRemove: () => clearFilterKindsAndApply(['date']),
    })];
  })() : [];
  document.getElementById('date-summary').replaceChildren(...dateNodes);

  const locationNodes = locationFilter === 'all' ? [] : [createFilterTag({
    kind: 'location',
    text: t(locationFilter === 'geolocated' ? 'Geolocated' : 'Not geolocated'),
    title: t('Geolocation'),
    onRemove: () => clearFilterKindsAndApply(['location']),
  })];
  document.getElementById('location-summary').replaceChildren(...locationNodes);

  const createMapZoneTag = () => createFilterTag({
    kind: 'map-zone',
    text: t('Map zone'),
    onRemove: () => clearFilterKindsAndApply(['map-zone']),
  });
  const mapZoneActive = isMapZoneFilterActive();
  document.getElementById('map-zone-summary').replaceChildren(...(mapZoneActive ? [createMapZoneTag()] : []));
  document.getElementById('map-zone-expanded-summary').replaceChildren(...(mapZoneActive ? [createMapZoneTag()] : []));

  const analysisNodes = analysisFilter === 'all' ? [] : [createFilterTag({
    kind: 'analysis',
    text: t(analysisFilter === 'analysed' ? 'Analysed' : 'Not analysed'),
    title: t('Content analysis'),
    onRemove: () => clearFilterKindsAndApply(['analysis']),
  })];
  document.getElementById('analysis-summary').replaceChildren(...analysisNodes);

  shootingFilters.renderSummaries();
  formatFilters.renderSummaries();
  authorFilters.renderSummaries();
  renderFilterTags();
  renderActiveFilterBadges();
  renderAlbumFilterInfo();
  updateFilterGroupStates();
}

// Marque chaque groupe de l'accordéon actif ou non (data-active) : seuls les groupes actifs montrent leur × d'effacement.
function updateFilterGroupStates() {
  const active = {
    'rating-color': isRatingFilterActive() || colorFilters.size > 0 || pickFilters.size > 0,
    tags: hasKeywordFilters() || hasFilenameFilters() || pathFilter !== null,
    persons: hasPersonFilters(),
    date: dateFilter !== null,
    gear: shootingFilters.hasGear(),
    shooting: shootingFilters.hasShot(),
    more: formatFilters.hasFormats() || authorFilters.hasAuthors() || locationFilter !== 'all' || isMapZoneFilterActive() || analysisFilter !== 'all',
  };
  for (const group of filterGroups) group.dataset.active = String(Boolean(active[group.dataset.filterGroup]));
}

// Badges du bloc Filtres replié : un par type de filtre actif (note, couleur, mots-clés, nom de fichier, personnes, date, fichiers en échec),
// avec la couleur de l'étiquette correspondante. Le CSS ne les affiche que quand le bloc est replié.
function renderActiveFilterBadges() {
  const container = document.getElementById('active-filter-badges');
  if (!container) return;
  const kinds = [
    [isRatingFilterActive(), 'rating', 'Rating'],
    [colorFilters.size > 0, 'color', 'Color'],
    [pickFilters.size > 0, 'pick', 'Pick'],
    [hasKeywordFilters(), 'keyword', 'Keywords'],
    [hasFilenameFilters(), 'filename', 'Filename'],
    [hasPersonFilters(), 'person', 'People'],
    [dateFilter !== null, 'date', 'Date'],
    [locationFilter !== 'all', 'location', 'Geolocation'],
    [isMapZoneFilterActive(), 'map-zone', 'Map'],
    [analysisFilter !== 'all', 'analysis', 'Content analysis'],
    [shootingFilters.hasGear(), 'gear', 'Gear'],
    [shootingFilters.hasShot(), 'shot', 'Shooting'],
    [formatFilters.hasFormats(), 'format', 'Format'],
    [authorFilters.hasAuthors(), 'author', 'Author'],
    [pathFilter !== null, 'failed', 'Failed files'],
  ];
  // Chaque badge a sa croix : elle efface ce type de filtre sans déplier le bloc (les clés de `clearFilterKinds` sont les types ci-dessus).
  container.replaceChildren(...kinds.filter(([active]) => active).map(([, kind, label]) => createFilterTag({
    kind,
    text: t(label),
    onRemove: () => clearFilterKindsAndApply([kind]),
  })));
}

let htmlEntityDecoder = null;
function decodeHtmlEntities(text) {
  const str = String(text || '');
  if (!str.includes('&')) return str;
  htmlEntityDecoder ??= document.createElement('textarea');
  htmlEntityDecoder.innerHTML = str;
  return htmlEntityDecoder.value;
}

// Pastille des photos géolocalisées sur les miniatures (Options d'affichage, désactivée par défaut) : simple classe sur <body>.
const GEO_BADGE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>';
const showGeoBadgesToggle = document.getElementById('show-geo-badges-toggle');
showGeoBadgesToggle.checked = readBool('showGeoBadges');
document.body.classList.toggle('show-geo-badges', showGeoBadgesToggle.checked);
showGeoBadgesToggle.addEventListener('change', () => {
  localStorage.setItem('showGeoBadges', String(showGeoBadgesToggle.checked));
  document.body.classList.toggle('show-geo-badges', showGeoBadgesToggle.checked);
});

// Badge on RAW photos (Display options): simple class on <body>.
const showRawBadgesToggle = document.getElementById('show-raw-badges-toggle');
showRawBadgesToggle.checked = readBool('showRawBadges');
document.body.classList.toggle('show-raw-badges', showRawBadgesToggle.checked);
showRawBadgesToggle.addEventListener('change', () => {
  localStorage.setItem('showRawBadges', String(showRawBadgesToggle.checked));
  document.body.classList.toggle('show-raw-badges', showRawBadgesToggle.checked);
});

// ==========================================
// VIEW SNAPSHOTS & RESULTS NAVIGATION
// ==========================================
// Shared by results modes (find-raw-mode.js, duplicates-view.js, semantic-results.js) to save and restore the previous view.

// Changes "Include subfolders" without persisting it: temporary setting of a results mode, not a user choice.
function setIncludeSubfoldersTemporarily(value) {
  includeSubfolders = value;
  document.getElementById('recursive-folder-toggle').checked = value;
}

// Reopens the view saved before a results mode (folder or album, scroll, selection). The caller has already left the mode.
async function restoreViewSnapshot(snapshot) {
  currentPhotoPage = 0; // back to the first page of the view
  if (snapshot.albumId) {
    restoreAlbumSelection(snapshot.albumId);
    syncSmartAlbumWithSelection(); // album intelligent : ses filtres reviennent
  } else {
    currentFolderFilter = snapshot.folder; extraFolderFilters = [];
  }
  renderFolderTree({ fromCounts: true });
  await loadPhotos({ catalogChanged: false });
  const indexByPath = new Map(photos.map((photo, index) => [photo.path, index]));
  selectedIndices.clear();
  for (const path of snapshot.selectedPaths) if (indexByPath.has(path)) selectedIndices.add(indexByPath.get(path));
  lastSelectedIndex = indexByPath.get(snapshot.lastPath) ?? selectedIndices.values().next().value ?? 0;
  if (selectedIndices.size === 0 && photos.length > 0) selectedIndices.add(0);
  gridContainer.scrollTop = snapshot.scrollTop;
  renderVisibleItems();
  if (photos.length > 0) updateUIOnSelection();
}

// "Show in its folder" (context menu of a photo in a results grid): leaves the search without returning to the previous view, opens the file's
// folder in the tree, with no filter, with the file selected and visible in the grid.
// Also used from "All photos" (context menu, one photo): there the current filters are kept, since the photo passes them and the user did not leave a search.
// What the content search calls "the view" (semantic.js): a folder (with its subfolders when the view includes them), otherwise the photos of the
// collection on screen (album, several folders, a results mode), otherwise the whole library. Filters are not part of the scope.
function currentViewScope() {
  const semanticSearch = getSemanticSearch();
  if (semanticSearch) return semanticSearch.viewScope; // a new search from inside the results mode searches the same view
  const album = getSelectedAlbum();
  if (!album && !isRawSearchActive() && !isDuplicateSearchActive() && extraFolderFilters.length === 0) {
    if (currentFolderFilter !== null) return { folder: currentFolderFilter, recursive: includeSubfolders, photoIds: null };
    return { folder: null, recursive: false, photoIds: null }; // "All photos"
  }
  return { folder: null, recursive: false, photoIds: loadedPhotos.map(photo => photo.id) };
}

function isAllPhotosView() { return currentFolderFilter === null && !getSelectedAlbum() && !isRawSearchActive() && !isDuplicateSearchActive() && !isSemanticSearchActive(); }
// `anyView`: also allowed from a folder view with subfolders included (Info panel "Folder" link), where the photo may lie below the open folder.
async function showPhotoInItsFolder(photo, { anyView = false } = {}) {
  const fromResults = isRawSearchActive() || isDuplicateSearchActive() || isSemanticSearchActive();
  if (!photo || !(fromResults || anyView || isAllPhotosView())) return;
  if (isFullscreenOpen()) closeFullscreen();
  abandonRawSearch(); // option sous-dossiers d'avant la recherche
  abandonDuplicateSearch();
  abandonSemanticSearch();
  if (fromResults) resetAllFilters(); // aucun filtre dans le dossier du fichier, pas même ceux d'avant la recherche
  clearAlbumSelection();
  syncSmartAlbumWithSelection();
  const folder = folderOf(photo.path);
  currentFolderFilter = folder; extraFolderFilters = [];
  currentPhotoPage = 0;
  rememberCurrentFolder();
  // Dossiers parents dépliés pour que le dossier soit visible dans l'arbre (comme à la reprise du dernier dossier au démarrage).
  expandFolderAncestors(folder);
  renderFolderTree({ fromCounts: true });
  await loadPhotos({ catalogChanged: false });
  const index = photos.findIndex(candidate => candidate.path === photo.path);
  if (index >= 0) {
    selectedIndices.clear();
    selectedIndices.add(index);
    lastSelectedIndex = index;
    scrollToPhotoIndex(index);
    renderVisibleItems();
    updateUIOnSelection();
  }
  revealActiveFolderRow();
}

// Everything needed to come back to the current view after a results mode (folder or album, filters, scroll, selection).
function captureViewSnapshot(album = getSelectedAlbum()) {
  return {
    folder: currentFolderFilter,
    includeSubfolders,
    albumId: album?.id ?? 0,
    albumKind: album?.kind ?? null,
    filterState: captureFilterState(),
    scrollTop: gridContainer.scrollTop,
    selectedPaths: [...selectedIndices].map(index => photos[index]?.path).filter(Boolean),
    lastPath: photos[lastSelectedIndex]?.path,
  };
}

// ==========================================
// VIRTUAL SCROLLING
// ==========================================
// Ratio largeur/hauteur d'une photo : ratio appris depuis l'image chargée, sinon dimensions EXIF de la base, sinon 1.
function photoAspectRatio(photo) {
  return photo.aspectRatio || (photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 1);
}
// Dispose les photos [start, end[ (indices dans photos) à partir de la hauteur offsetY ; renvoie la hauteur occupée par ce groupe.
// Sans séparateur, c'est une seule plage couvrant toutes les photos ; avec des séparateurs, chaque groupe est disposé séparément (les lignes justifiées, les colonnes de la cascade et la grille carrée repartent à zéro).
// Taille maximale d'affichage : le plus grand côté d'une miniature ne dépasse jamais thumbnailSize (taille de la miniature en cache, au-delà elle serait floue).
function layoutPhotoRange(start, end, offsetY, width, gap) {
  if (end <= start) return 0;
  const count = end - start;
  const thumbailSizeCorrected = Math.floor(thumbnailSize / (window.devicePixelRatio || 1));
  if (thumbnailLayout === 'square' || thumbnailLayout === 'framed') {
    columns = Math.max(1, Math.floor((width + gap) / (thumbailSizeCorrected + gap)));
    const cellSize = Math.min(thumbailSizeCorrected, (width - gap * (columns - 1)) / columns);
    const step = cellSize + gap;
    for (let n = 0; n < count; n++) photoLayouts.push({ index: start + n, x: (n % columns) * step, y: offsetY + Math.floor(n / columns) * step, width: cellSize, height: cellSize });
    return Math.ceil(count / columns) * step - gap;
  } else if (thumbnailLayout === 'justified') {
    let y = offsetY;
    let index = start;
    while (index < end) {
      // Une photo de ratio r (largeur/hauteur) ne doit pas dépasser thumbnailSize sur son plus grand côté : sa hauteur est donc limitée à
      // thumbnailSize / r en paysage et à thumbnailSize en portrait. Le plafond de la ligne est le plus bas de ses photos.
      // On ajoute des photos jusqu'à ce que la hauteur qui remplit toute la largeur passe sous ce plafond : la hauteur des lignes
      // varie un peu sous thumbnailSize, mais aucune miniature n'est agrandie au-delà de sa taille réelle.
      const row = [];
      let ratioSum = 0;
      let rowMaxHeight = Infinity;
      while (index + row.length < end) {
        const ratio = photoAspectRatio(photos[index + row.length]);
        row.push({ index: index + row.length, ratio });
        ratioSum += ratio;
        rowMaxHeight = Math.min(rowMaxHeight, thumbailSizeCorrected / Math.max(1, ratio));
        if ((width - gap * (row.length - 1)) / ratioSum <= rowMaxHeight + 0.01) break;
      }
      // Ligne complète : les largeurs sont calculées depuis la largeur utile, donc la ligne remplit exactement le conteneur.
      // Dernière ligne d'un groupe, avec trop peu de photos pour atteindre le plafond : elle n'est pas étirée, sa hauteur est plafonnée et ses photos restent alignées à gauche.
      const available = Math.max(1, width - gap * (row.length - 1));
      const fillHeight = available / ratioSum;
      const height = fillHeight <= rowMaxHeight + 0.01 ? fillHeight : rowMaxHeight;
      maximumPhotoHeight = Math.max(maximumPhotoHeight, height);
      let x = 0;
      for (const item of row) {
        const itemWidth = item.ratio * height;
        photoLayouts.push({ index: item.index, x, y, width: itemWidth, height });
        x += itemWidth + gap;
      }
      y += height + gap;
           index += row.length;
          }
    return Math.max(0, y - offsetY - gap);
  } else {
    // Nombre de colonnes arrondi au-dessus : la largeur d'une colonne ne dépasse jamais thumbnailSize.
    columns = Math.max(1, Math.ceil((width + gap) / (thumbailSizeCorrected + gap)));
    const columnWidth = (width - gap * (columns - 1)) / columns;
    // Hauteur maximale d'une case : la résolution du cache (au-delà, la miniature serait agrandie et floue).
    const maxItemHeight = Math.floor(thumbnailCacheSize / (window.devicePixelRatio || 1));
    const columnBottoms = Array(columns).fill(0);
    const placed = [];
    for (let i = start; i < end; i++) {
      let column = 0;
      for (let c = 1; c < columns; c++) if (columnBottoms[c] < columnBottoms[column]) column = c;
      const photo = photos[i];
      // Les dimensions des vidéos ne sont pas dans le catalogue : leur ratio vient de la miniature (voir learnPhotoAspectRatio).
      const knownRatio = isVideoPath(photo.path) ? photoAspectRatio(photo) : (photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 1);
      const ratio = Math.max(0.2, Math.min(5, knownRatio));
      // Chaque photo occupe toute la largeur de sa colonne (aucun fond visible entre les colonnes). Une photo très haute dont la hauteur
      // dépasserait la résolution du cache est plafonnée, et recadrée en haut et en bas (object-fit: cover, voir renderVisibleItems).
      const height = Math.min(columnWidth / ratio, maxItemHeight);
      const y = columnBottoms[column];
      placed.push({ index: i, x: column * (columnWidth + gap), y: offsetY + y, width: columnWidth, height });
      columnBottoms[column] = y + height + gap;
      maximumPhotoHeight = Math.max(maximumPhotoHeight, height);
    }
    placed.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const item of placed) photoLayouts.push(item);
    return Math.max(0, ...columnBottoms) - gap;
  }
}

// Hauteur d'une ligne de séparation en pixels : mesurée sur un élément invisible pour accepter n'importe quelle unité CSS dans --group-separator-height.
let separatorProbe = null;
function separatorHeight() {
  if (!separatorProbe) {
    separatorProbe = document.createElement('div');
    separatorProbe.className = 'group-separator-probe';
    separatorProbe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(separatorProbe);
  }
  return Math.max(1, separatorProbe.offsetHeight);
}

// Espace entre deux cases de la grille, en pixels. « Normal » : 6 px entre les cases, auxquels s'ajoute la marge intérieure de 4 px de chaque case
// (voir renderVisibleItems). « Petit » : 0,25 rem converti en pixels, recalculé à chaque disposition pour suivre la taille du texte.
function thumbnailGap() {
  if (thumbnailSpacing === 'normal') return 6;
  if (thumbnailSpacing === 'small') return Math.round(0.25 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16));
  return 0;
}

function updateVirtualScroller() {
  const width = Math.max(1, gridContainer.clientWidth - 2 * GRID_SIDE_MARGIN);
  const gap = thumbnailGap();
  photoLayouts = [];
  separatorLayouts = [];
  maximumPhotoHeight = thumbnailSize;
  const groups = computePhotoGroups();
  const headerHeight = groups.length ? separatorHeight() : 0;
  let y = 0;
  if (!groups.length) {
    y = layoutPhotoRange(0, photos.length, 0, width, gap);
  } else {
    groups.forEach((group, groupIndex) => {
      separatorLayouts.push({ group: groupIndex, y, height: headerHeight, label: group.label, title: group.title });
      y += headerHeight;
      y += layoutPhotoRange(group.start, group.end, y, width, gap);
      if (groupIndex < groups.length - 1) y += gap;
    });
  }
  layoutContentHeight = y;
  scrollContent.style.height = `${Math.max(0, layoutContentHeight)}px`;
  renderVisibleItems();
}

// Medal of the best copy in the duplicate results.
const BEST_BADGE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2h4l1.2 6.2-3.4 1.8zM17 2h-4l-1.2 6.2 3.4 1.8z" fill="currentColor" opacity="0.65"/><circle cx="12" cy="15" r="6.5" fill="currentColor"/><path d="M12 11.2l1.1 2.3 2.5.3-1.8 1.7.5 2.5-2.3-1.2-2.3 1.2.5-2.5-1.8-1.7 2.5-.3z" fill="#e6b422"/></svg>';
function createBestBadge() {
  const badge = document.createElement('span');
  badge.className = 'best-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.innerHTML = BEST_BADGE_ICON;
  return badge;
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
  const duplicateSearch = getDuplicateSearch();
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
      const pick = document.createElement('span'); pick.className = 'pick-indicator pick-none';
      const flags = document.createElement('span'); flags.className = 'meta-flags'; flags.append(pick, flag);
      // Selection frame (styled in styles.css, shown only on .selected): a dedicated element, because ::before/::after are already taken (RAW placeholder, corner mark).
      const selectionRing = document.createElement('span'); selectionRing.className = 'selection-ring';
      overlay.append(stars, flags); inner.append(thumbnailImage, selectionRing, overlay); div.appendChild(inner);
      if (isVideoPath(photo.path)) { div.classList.add('is-video'); inner.append(createVideoPlayBadge()); }
      // Badge on RAW photos (Display options, shown via body.show-raw-badges).
      if (isRawPath(photo.path)) {
        div.classList.add('is-raw');
        const rawBadge = document.createElement('span');
        rawBadge.className = 'raw-badge';
        rawBadge.setAttribute('aria-hidden', 'true');
        rawBadge.textContent = 'r';
        inner.append(rawBadge);
      }
      // Pastille des photos géolocalisées (option d'affichage, visible par la classe show-geo-badges sur <body>).
      const geoBadge = document.createElement('span'); geoBadge.className = 'geo-badge'; geoBadge.innerHTML = GEO_BADGE_ICON;
      inner.append(geoBadge);
      div._ratingLabel = stars; div._flag = flag; div._pick = pick; div._thumbnailImage = thumbnailImage;
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
    // Espacement « Normal » : marge intérieure et cadre arrondi ; « Petit » et « Aucun » : la photo occupe toute sa case, sans cadre.
    const padding = thumbnailSpacing === 'normal' ? '4px' : '0';
    if (div._padding !== padding) { div.style.padding = padding; div._padding = padding; }
    div.classList.toggle('frameless', thumbnailSpacing !== 'normal');
    // Cascade : la case a déjà le ratio de la photo ; « cover » évite tout fond visible si ce ratio est approximatif ou plafonné.
    // Encadrée : la photo entière s'inscrit dans sa case carrée, le fond de la case forme le cadre.
    const objectFit = thumbnailLayout === 'justified' || thumbnailLayout === 'framed' ? 'contain' : 'cover';
    if (div._objectFit !== objectFit) { div._thumbnailImage.style.objectFit = objectFit; div._objectFit = objectFit; }
    const selected = selectedIndices.has(i);
    if (div._selected !== selected) { div.classList.toggle('selected', selected); div._selected = selected; }
    // The active photo (last clicked, target of keyboard navigation and of the Info panel) gets a marker in its corner triangle to tell it apart from the rest of the selection.
    const activePhoto = selected && i === lastSelectedIndex;
    if (div._activePhoto !== activePhoto) { div.classList.toggle('active-photo', activePhoto); div._activePhoto = activePhoto; }
    const stars = '★'.repeat(photo.rating);
    if (div._ratingLabel.textContent !== stars) div._ratingLabel.textContent = stars;
    const flagClass = `flag-indicator flag-${photo.color_flag}`;
    if (div._flag.className !== flagClass) div._flag.className = flagClass;
    const pickClass = `pick-indicator pick-${photo.pick_flag || 'none'}`;
    if (div._pick.className !== pickClass) div._pick.className = pickClass;
    // Duplicate results: the path on hover, to tell the copies apart (the same name can sit in several folders).
    // The best copy of each group (first of its group) also wears a medal, created only in this mode.
    const isBest = duplicateSearch ? duplicateSearch.best?.has(photo.path) === true : false;
    if (div._best !== isBest) {
      if (isBest && !div._bestBadge) {
        div._bestBadge = createBestBadge();
        div.querySelector('.thumbnail-inner').append(div._bestBadge);
      }
      if (div._bestBadge) div._bestBadge.hidden = !isBest;
      div._best = isBest;
    }
    // Duplicate results: dimensions and size on the thumbnail, to choose between the copies (created only in this mode).
    if (duplicateSearch && !div._dupMeta) {
      div._dupMeta = Object.assign(document.createElement('span'), { className: 'duplicate-meta' });
      div.querySelector('.thumbnail-inner').append(div._dupMeta);
    }
    if (div._dupMeta) {
      const text = duplicateSearch ? [duplicateSearch.mixedFormats ? photoFormat(photo.path) : '', photo.width > 0 && photo.height > 0 ? `${photo.width}×${photo.height}` : '', photo.file_size > 0 ? formatBytes(photo.file_size) : ''].filter(Boolean).join(' · ') : '';
      if (div._dupMeta.textContent !== text) div._dupMeta.textContent = text;
      div._dupMeta.hidden = !text;
    }
    // Content search results: the score of the text query on the thumbnail (setting "Show the score on results"; image queries have none), and a mark
    // on the source photo of a similar-content search. Created only in this mode.
    const semanticSearch = getSemanticSearch();
    const score = semanticSearch && readBool('semanticShowScore') ? semanticSearch.prob.get(photo.id) : null;
    if (score != null && !div._semanticScore) {
      div._semanticScore = Object.assign(document.createElement('span'), { className: 'semantic-score' });
      div.querySelector('.thumbnail-inner').append(div._semanticScore);
    }
    if (div._semanticScore) {
      const text = score == null ? '' : score > 0 && score < 0.01 ? '<1 %' : `${Math.round(score * 100)} %`;
      if (div._semanticScore.textContent !== text) div._semanticScore.textContent = text;
      div._semanticScore.hidden = !text;
    }
    const isSemanticSource = semanticSearch !== null && photo.id === semanticSearch.sourceId;
    if (div._semanticSource !== isSemanticSource) { div.classList.toggle('semantic-source', isSemanticSource); div._semanticSource = isSemanticSource; }
    // Keyword filter with suggestions: a "suggested" badge on the photos that do not carry every keyword (created only for them).
    const guessed = keywordGuesses.get(photo.id);
    const guessKey = guessed ? guessed.join('\n') : '';
    if (div._guessKey !== guessKey) {
      if (guessed && !div._guessBadge) {
        div._guessBadge = Object.assign(document.createElement('span'), { className: 'semantic-suggested semantic-only', textContent: t('Suggested') });
        div.querySelector('.thumbnail-inner').append(div._guessBadge);
      }
      if (div._guessBadge) {
        div._guessBadge.hidden = !guessed;
        if (guessed) div._guessBadge.title = describeGuesses(guessed, photo.id);
      }
      div._guessKey = guessKey;
    }
    // Content search shared with the keyword search: a "Keywords" badge (same look as "Suggested") on the photos found by their keywords.
    const byKeywords = semanticSearch?.carried.has(photo.id) === true;
    if (div._byKeywords !== byKeywords) {
      if (byKeywords && !div._keywordBadge) {
        div._keywordBadge = Object.assign(document.createElement('span'), { className: 'semantic-suggested semantic-only', textContent: t('Keywords') });
        div.querySelector('.thumbnail-inner').append(div._keywordBadge);
      }
      if (div._keywordBadge) {
        div._keywordBadge.hidden = !byKeywords;
        if (byKeywords) div._keywordBadge.title = t('Found by its keywords: tagged with the text typed in the search box');
      }
      div._byKeywords = byKeywords;
    }
    const hoverTitle = isSemanticSource ? `${photo.path}\n${t('Source photo of the search')}` : duplicateSearch ? (isBest ? `${photo.path}\n${t('Best copy of the group, according to the order set in "Best copy…"')}` : photo.path) : '';
    if (div._hoverTitle !== hoverTitle) { div.title = hoverTitle; div._hoverTitle = hoverTitle; }
    const located = hasGps(photo);
    if (div._located !== located) { div.classList.toggle('has-gps', located); div._located = located; }
    // Position choisie dans le mode Carte, pas encore écrite dans le fichier : pastille orange.
    const waitingLocation = hasPendingPosition(photo);
    if (div._geoPending !== waitingLocation) { div.classList.toggle('gps-pending', waitingLocation); div._geoPending = waitingLocation; }
  }
  renderVisibleSeparators(top, bottom);
  for (const [index, node] of renderedThumbnailNodes) {
    if (!visible.has(index)) { node.remove(); renderedThumbnailNodes.delete(index); }
  }
}

// Lignes de séparation visibles (dates ou dossiers) : créées à l'arrivée dans la zone affichée, retirées quand elles en sortent, comme les miniatures.
// Les nœuds sont indexés par numéro de groupe et mis à jour si le texte ou la position change (changement de tri, de filtre ou de langue).
function renderVisibleSeparators(top, bottom) {
  const visible = new Set();
  const duplicateActive = isDuplicateSearchActive();
  for (const separator of separatorLayouts) {
    if (separator.y + separator.height < top) continue;
    if (separator.y > bottom) break;
    visible.add(separator.group);
    let node = renderedSeparatorNodes.get(separator.group);
    if (!node) {
      node = document.createElement('div');
      node.className = 'group-separator';
      node._text = document.createElement('span');
      node._text.className = 'group-separator-label';
      node.appendChild(node._text);
      renderedSeparatorNodes.set(separator.group, node);
      scrollContent.appendChild(node);
    }
    node.classList.toggle('duplicate-group', duplicateActive); // stronger look for the groups of the duplicate results
    if (node._label !== separator.label) { node._text.textContent = separator.label; node._label = separator.label; }
    if (node._title !== separator.title) { node.title = separator.title; node._title = separator.title; }
    const transform = `translate3d(0, ${separator.y}px, 0)`;
    if (node._transform !== transform) { node.style.transform = transform; node._transform = transform; }
    if (node._height !== separator.height) { node.style.height = `${separator.height}px`; node._height = separator.height; }
  }
  for (const [group, node] of renderedSeparatorNodes) {
    if (!visible.has(group)) { node.remove(); renderedSeparatorNodes.delete(group); }
  }
}

let gridScrollPositionTimeout = null;

function formatGridScrollPosition(photo) {
  if (!photo) return t('Unknown date');
  if (isListGridSortActive()) return formatListGridScrollPosition(photo);
  if (sortKey === 'name') return photo.filename || photo.path.split(/[\\/]/).pop() || t('Unknown');
  if (sortKey === 'modified') {
    const modified = photoModifiedTime(photo);
    if (!(modified > 0)) return t('Unknown date');
    return new Date(modified).toLocaleDateString(getLanguage(), { year: 'numeric', month: 'long', day: 'numeric' });
  }
  const key = photoTimeKey(photo);
  if (key === null || key === undefined) return t('Unknown date');
  const text = String(key).padStart(14, '0');
  return new Date(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8))).toLocaleDateString(getLanguage(), { year: 'numeric', month: 'long', day: 'numeric' });
}

function updateGridScrollPosition() {
  const scrollTop = gridContainer.scrollTop;
  const viewBottom = scrollTop + gridContainer.clientHeight;
  let low = 0, high = photoLayouts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (photoLayouts[middle].y < scrollTop) low = middle + 1; else high = middle;
  }
  let text = '';
  for (let index = low; index < photoLayouts.length && photoLayouts[index].y < viewBottom; index++) {
    text = formatGridScrollPosition(photos[photoLayouts[index].index]);
    if (text) break;
  }
  for (let index = low - 1; !text && index >= 0 && photoLayouts[index].y + maximumPhotoHeight > scrollTop; index--) {
    if (photoLayouts[index].y + photoLayouts[index].height <= scrollTop) continue;
    text = formatGridScrollPosition(photos[photoLayouts[index].index]);
  }
  gridScrollPosition.textContent = text;
  const bounds = gridContainer.getBoundingClientRect();
  const scrollbarWidth = gridContainer.offsetWidth - gridContainer.clientWidth;
  gridScrollPosition.style.top = `${Math.round(bounds.top + 12)}px`;
  gridScrollPosition.style.right = `${Math.round(window.innerWidth - bounds.right + scrollbarWidth + 16)}px`;
  gridScrollPosition.hidden = !text;
  clearTimeout(gridScrollPositionTimeout);
  if (text) gridScrollPositionTimeout = setTimeout(() => { gridScrollPosition.hidden = true; }, 2000);
}

gridContainer.addEventListener('scroll', () => {
  updateGridScrollPosition();
  if (scrollRenderPending) return;
  scrollRenderPending = true;
  requestAnimationFrame(() => { scrollRenderPending = false; renderVisibleItems(); });
});
window.addEventListener('resize', updateVirtualScroller);

// ==========================================
// NAVIGATION (GRID & FULLSCREEN)
// ==========================================

function navigatePhoto(direction) {
  navigateToPhotoIndex(lastSelectedIndex + direction);
}

// Up / Down arrow in the grid: selects the photo above (step -1) or below (step 1) the current one. Works with every layout (square, justified,
// masonry) from the computed boxes: among the photos entirely past the current one's middle, keep those whose facing edge is nearest (the next row,
// or the next photos of the neighbouring columns), then take the one horizontally closest to the current photo. Without selection, the first
// photo is selected. Nothing happens on the first / last row.
function navigateGridRow(step) {
  if (photos.length === 0) return;
  const current = photoLayouts.find(item => item.index === lastSelectedIndex);
  if (!current || selectedIndices.size === 0) { navigateToPhotoIndex(0); scrollPhotoIntoView(0); return; }
  const centerX = current.x + current.width / 2;
  const middleY = current.y + current.height / 2;
  const candidates = [];
  for (const item of photoLayouts) {
    if (item.index === current.index) continue;
    // Gap between the facing edges (negative when the boxes overlap vertically).
    const edge = step > 0 ? item.y - (current.y + current.height) : current.y - (item.y + item.height);
    const beyond = step > 0 ? item.y >= middleY : item.y + item.height <= middleY;
    if (beyond) candidates.push({ item, edge: Math.max(0, edge) });
  }
  if (candidates.length === 0) return;
  const nearest = Math.min(...candidates.map(candidate => candidate.edge));
  let best = null;
  let bestDistance = Infinity;
  for (const { item, edge } of candidates) {
    if (edge > nearest + current.height * 0.5) continue; // a farther row
    const distance = Math.abs(item.x + item.width / 2 - centerX);
    if (distance < bestDistance) { best = item; bestDistance = distance; }
  }
  if (!best) return;
  navigateToPhotoIndex(best.index);
  scrollPhotoIntoView(best.index);
}

// Scrolls the grid the minimum needed to show the whole thumbnail of photo `index`.
function scrollPhotoIntoView(index) {
  const layout = photoLayouts.find(item => item.index === index);
  if (!layout) return;
  const viewTop = gridContainer.scrollTop;
  const viewBottom = viewTop + gridContainer.clientHeight;
  if (layout.y < viewTop) gridContainer.scrollTop = Math.max(0, layout.y - 4);
  else if (layout.y + layout.height > viewBottom) gridContainer.scrollTop = layout.y + layout.height - gridContainer.clientHeight + 4;
  else return;
  renderVisibleItems();
}

function navigateToPhotoIndex(index) {
  if (photos.length === 0) return;
  const newIndex = Math.max(0, Math.min(photos.length - 1, index));
  if (newIndex === lastSelectedIndex) return;
  setFullscreenDirection(newIndex > lastSelectedIndex ? 1 : -1);

  lastSelectedIndex = newIndex;
  selectedIndices.clear();
  selectedIndices.add(newIndex);
  updateUIOnSelection();
  if (!isFullscreenOpen()) scrollPhotoIntoView(newIndex);
  preloadFullscreenImages(newIndex);
}

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

// Ctrl+A (hors mode Comparer) : sélectionne toutes les photos affichées dans la grille, ou les désélectionne toutes si elles le sont déjà.
function toggleSelectAllPhotos() {
  if (photos.length === 0) return;
  if (selectedIndices.size === photos.length) {
    selectedIndices.clear();
  } else {
    for (let index = 0; index < photos.length; index++) selectedIndices.add(index);
    if (!selectedIndices.has(lastSelectedIndex)) lastSelectedIndex = 0;
  }
  updateUIOnSelection();
}

// Bouton « Tout désélectionner » de la barre de marquage flottante : vide la sélection, ce qui masque la barre (voir updateRatingAction).
document.getElementById('btn-clear-selection')?.addEventListener('click', () => {
  if (selectedIndices.size === 0) return;
  selectedIndices.clear();
  updateUIOnSelection();
});

function updateUIOnSelection() {
  refreshKeywordsPanel();
  if (getSemanticSearch()?.keyword) renderSemanticKeywordActions();
  refreshDescriptionPanel();
  pruneCompareSubSelection();
  renderVisibleItems(); 
  updateRatingAction();
  updateColorAction();
  renderPreview();
  if (selectedIndices.size > 0 && photos[lastSelectedIndex]) {
    const photo = photos[lastSelectedIndex];
    // Image pleine résolution (et extraction de l'aperçu d'un RAW) seulement plein écran ouvert : openFullscreen la charge à l'ouverture.
    if (isFullscreenOpen()) loadFullscreenPhoto(photo);

    updateFullscreenRatingStars();
    if (isFullscreenOpen()) preloadFullscreenImages(lastSelectedIndex);

    document.getElementById('exif-filename').textContent = photo.filename || photo.path.split(/[\\/]/).pop() || '-';
    updateInfoFolder(photo);
    renderFileDates(photo);
    document.getElementById('exif-date').textContent = photo.date_taken || '-';
    // Fabricant et modèle regroupés en un seul champ « Camera », séparés par une espace.
    document.getElementById('exif-camera').textContent =
      [photo.manufacturer, photo.camera_model].map(v => (v || '').trim()).filter(Boolean).join(' ') || '-';
    document.getElementById('exif-lens').textContent = photo.lens_model || '-';
    document.getElementById('exif-focal').textContent = photo.focal_length || '-';
    document.getElementById('exif-aperture').textContent = formatAperture(photo.aperture);
    document.getElementById('exif-shutter').textContent = formatShutterSpeed(photo.shutter_speed);
    document.getElementById('exif-iso').textContent = photo.iso ? photo.iso.toString() : '-';
    showPhotoDimensions(photo);
    document.getElementById('exif-size').textContent = `${(photo.file_size / 1024 / 1024).toFixed(2)} MB`;
    renderInfoKeywords(photo);
    document.getElementById('exif-title').textContent = photo.title || '-';
    document.getElementById('exif-caption').textContent = decodeHtmlEntities(photo.caption) || '-';
    renderInfoAuthor(photo);
  }
  // Groupe Lieu : positions de toute la sélection, la photo active mise en avant (voir location-panel.js).
  refreshLocation([...selectedIndices].map(index => photos[index]).filter(Boolean), photos[lastSelectedIndex]);
  refreshMapMode(); // mode Carte ouvert : sélection mise en évidence sur la carte
  refreshListView({ selectionOnly: true });
  refreshInfoRows();
  syncHistogram(); // histogramme de la photo courante
}

// Info tab "Folder" row: the folder of the active photo, shown when the folder view does not already tell it ("All photos", subfolders
// included, or an album view). Otherwise the text stays "-" and refreshInfoRows hides the row. The tooltip is the full folder path (file name
// excluded, same separators as the catalogue); a click opens that folder in the tree (see showPhotoInItsFolder).
function updateInfoFolder(photo) {
  const button = document.getElementById('exif-folder');
  const folder = photo && (currentFolderFilter === null || includeSubfolders || getSelectedAlbum()) ? folderOf(photo.path) : '';
  const name = folder.split(/[\\/]/).filter(Boolean).pop() || '';
  button.textContent = name || '-';
  button.title = name ? folder : '';
  button.disabled = !name;
}
document.getElementById('exif-folder').addEventListener('click', async () => {
  const photo = photos[lastSelectedIndex];
  if (!photo) return;
  // Same guard as a folder change: an edited smart album is left only after Save / Discard / Cancel.
  if (isSelectedAlbumDirty() && !(await confirmLeaveAlbum())) return;
  showPhotoInItsFolder(photo, { anyView: true });
});

// Onglet Info : les lignes sans valeur sont masquées (sauf Fichier, Mots-clés, Titre et Description, toujours présents), et un titre de groupe
// (Appareil photo, Exposition, Métadonnées) disparaît quand aucune de ses lignes n'est affichée.
function refreshInfoRows() {
  const rows = [...document.querySelectorAll('#exif-data li:not(.exif-group-title)')];
  for (const row of rows) {
    const value = row.querySelector('span')?.textContent.trim();
    row.hidden = !row.hasAttribute('data-always') && (!value || value === '-');
  }
  for (const heading of document.querySelectorAll('#exif-data .exif-group-title')) {
    heading.hidden = !rows.some(row => !row.hidden && row.dataset.group === heading.dataset.groupTitle);
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
  // Vidéo : les dimensions réelles ne sont pas lues (l'image extraite n'a pas la taille de la vidéo) : on n'affiche rien plutôt qu'une valeur fausse.
  if (isVideoPath(photo.path)) {
    element.textContent = '-';
    return;
  }
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
  // URL d'affichage (aperçu JPEG extrait pour un RAW ou un HEIC, que le Webview ne lit pas).
  getPhotoDisplayUrl(photo).then(url => {
    probe.src = url;
  });
}


// Met à jour les contrôles de marquage (panneau Info et barre flottante) d'après la sélection : nombre de photos, étoiles, couleur, emplacement affiché.
function updateRatingAction() {
  const count = selectedIndices.size;
  if (count > 0) {
    // Same look as the Filters count: the number in bold, the rest of the text muted.
    const number = count.toLocaleString(getLanguage());
    const label = tp('{count} photo selected', count, { count: number });
    const at = label.indexOf(number);
    document.querySelectorAll('.marking-count').forEach(element => {
      element.replaceChildren(...(at < 0 ? [label] : [label.slice(0, at), Object.assign(document.createElement('strong'), { textContent: number }), label.slice(at + number.length)]));
    });
    const rating = commandReferencePhoto()?.rating || 0; // en mode Comparer avec plusieurs photos : celle de la sous-sélection
    document.querySelectorAll('.marking-stars button').forEach(button => {
      button.classList.toggle('active', Number(button.dataset.rating) <= rating);
    });
  }
  updateMarkingPlacement();
}

let writeToastTimeout = null;

// `action` (optional): { label, onClick, title?, link? } or array of actions added to the toast (keeps it visible longer).
function showWriteToast(message, isWriting = false, action = null, duration = null) {
  const toast = document.getElementById('write-toast');
  if (!toast) return;
  clearTimeout(writeToastTimeout);
  toast.textContent = message;
  const actions = (Array.isArray(action) ? action : [action]).filter(Boolean);
  if (actions.length) {
    const group = document.createElement('span');
    group.className = 'toast-actions';
    for (const item of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `toast-action${item.link ? ' toast-link' : ''}`;
      button.textContent = item.label;
      if (item.title) button.title = item.title;
      button.addEventListener('click', () => {
        toast.classList.add('hidden');
        item.onClick();
      });
      group.append(button);
    }
    toast.append(group);
  }
  toast.classList.remove('hidden');
  toast.classList.toggle('writing', isWriting);
  if (!isWriting) writeToastTimeout = setTimeout(() => toast.classList.add('hidden'), duration ?? (actions.length ? 8000 : 3500));
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

// Contrôles de marquage : met en évidence la couleur de la photo de référence de la sélection (une seule couleur possible).
function updateColorAction() {
  if (selectedIndices.size === 0) return;
  const selectedPhoto = commandReferencePhoto();
  const flag = selectedPhoto?.color_flag || 'none';
  document.querySelectorAll('.marking-colors .color-square').forEach(button => setColorSquareChecked(button, button.dataset.flag === flag));
  // Pastille de la barre flottante : couleur de la photo de référence (arc-en-ciel quand elle n'en a pas)
  const colorButton = document.getElementById('marking-color-button');
  if (colorButton) colorButton.className = `marking-color-button${flag === 'none' ? '' : ` flag-${flag}`}`;
  updatePickAction();
}

// Met en évidence le fanion pick de la photo de référence de la sélection (un seul possible) ; le drapeau de la barre flottante en prend la couleur.
function updatePickAction() {
  const flag = commandReferencePhoto()?.pick_flag || 'none';
  document.querySelectorAll('.marking-pick .pick-square').forEach(button => setColorSquareChecked(button, button.dataset.pick === flag));
  const pickButton = document.getElementById('marking-pick-button');
  if (pickButton) pickButton.className = `marking-pick-button pick-square pick-${flag}`;
}

// `explicitTargets` (menu contextuel) : photos précises à marquer, à la place de la sélection.
async function setSelectionColorFlag(flag, explicitTargets = null) {
  if (!isColorEnabled()) return; // couleurs désactivées (Paramètres > Métadonnées) : jamais modifiées
  const targets = explicitTargets ?? commandTargetPhotos(); // en mode Comparer avec plusieurs photos : la sous-sélection uniquement
  if (!targets.length) {
    if (!explicitTargets && isCompareMultiple()) notifyNoCompareTarget();
    return;
  }
  // Comme pour la note : si toutes les photos sélectionnées ont déjà cette couleur, on l'efface.
  const finalFlag = targets.every(photo => (photo.color_flag || 'none') === flag) ? 'none' : flag;
  // Seule la couleur est envoyée : la note de chaque fichier n'est pas réécrite.
  await writeMarking(targets, { colorFlag: finalFlag }, {
    startMessage: finalFlag === 'none'
      ? tp('Removing color for {count} file…', targets.length)
      : tp('Writing {count} file (color: {color})…', targets.length, { color: colorFlagLabels.get(finalFlag) }),
    doneMessage: count => (finalFlag === 'none' ? tp('Color removed for {count} file', count) : tp('{count} file modified', count)),
    apply: photo => { photo.color_flag = finalFlag; },
    refilter: () => colorFilters.size > 0,
    undoMeta: { kind: 'color', value: finalFlag },
  });
}

// Fanion pick de la sélection. `toggle` (raccourcis Maj+P / Maj+X) : si toutes les photos visées ont déjà ce fanion, il est retiré ; sans `toggle`
// (boutons, qui proposent « aucun »), le fanion choisi est posé tel quel. Les photos qui l'ont déjà ne sont pas réécrites.
// Seul le fanion est envoyé : la note et la couleur de chaque fichier ne sont pas réécrites.
// `photos` (menu contextuel) : photos précises à marquer, à la place de la sélection.
async function setSelectionPickFlag(flag, { toggle = true, photos: explicitTargets = null } = {}) {
  if (!isPickEnabled()) return; // pick désactivé (Paramètres > Métadonnées) : jamais modifié
  const selected = explicitTargets ?? commandTargetPhotos(); // en mode Comparer avec plusieurs photos : la sous-sélection uniquement
  if (!selected.length) {
    if (!explicitTargets && isCompareMultiple()) notifyNoCompareTarget();
    return;
  }
  const finalFlag = toggle && selected.every(photo => (photo.pick_flag || 'none') === flag) ? 'none' : flag;
  const targets = selected.filter(photo => (photo.pick_flag || 'none') !== finalFlag);
  if (!targets.length) return;
  await writeMarking(targets, { pickFlag: finalFlag }, {
    startMessage: finalFlag === 'none'
      ? tp('Removing flag for {count} file…', targets.length)
      : tp('Writing {count} file (flag: {flag})…', targets.length, { flag: t(PICK_FLAGS.find(candidate => candidate.key === finalFlag).label) }),
    doneMessage: count => (finalFlag === 'none' ? tp('Flag removed for {count} file', count) : tp('{count} file modified', count)),
    apply: photo => { photo.pick_flag = finalFlag; },
    refilter: () => pickFilters.size > 0,
    undoMeta: { kind: 'pick', value: finalFlag },
  });
}

// Échecs d'écriture de la note, de la couleur ou du fanion : leur nombre et la raison du premier (ex. ExifTool introuvable).
function failureSummary(failures) {
  return failures.length ? ` · ${tp('{count} failure', failures.length)} (${failures[0].error})` : '';
}

// Checks whether a queued file task or an active move/rename currently touches any of `entries`,
// and whether any target file (or its active sidecar) was modified externally since the original action.
async function canUndoFileTargets(entries) {
  const byId = new Map(loadedPhotos.map(photo => [photo.id, photo]));
  const moving = queuedPathsBeingChanged();
  if (photoMoveRunning || entries.some(entry => moving.has(byId.get(entry.id)?.path ?? entry.path))) {
    showWriteToast(t('Wait for the running file task to finish.'));
    return false;
  }
  const targets = entries
    .map(entry => ({
      path: byId.get(entry.id)?.path ?? entry.path,
      expected_effective_modified: entry.effectiveModified ?? 0,
    }))
    .filter(target => target.expected_effective_modified > 0);
  if (targets.length > 0) {
    try {
      const modifiedExternally = await invoke('check_external_modifications', { targets });
      if (modifiedExternally.length > 0) {
        const confirmed = await confirmDialog({
          title: t('External modification detected'),
          message: tp('{count} file was modified outside photoboggan since this action. Undoing will overwrite those external changes. Continue?', modifiedExternally.length),
          confirmLabel: t('Undo anyway'),
          cancelLabel: t('Cancel'),
          focusCancel: true,
        });
        if (!confirmed) return false;
      }
    } catch (error) {
      console.debug('External modification check failed', error);
    }
  }
  return true;
}

// Écriture de la note, de la couleur ou du fanion pick (`fields` : { rating } | { colorFlag } | { pickFlag }) de `targets`, lues avant tout
// await : une seule commande pour le lot (update_photos_marking), par la file des tâches à partir de 20 photos (progression, arrêt), et comptée
// dans le verrou d'écriture (fermeture de l'application, renommages et déplacements refusés pendant ce temps). Les écritures de marquage
// partent l'une après l'autre, dans l'ordre des touches. `apply(photo)` reporte la valeur sur chaque photo écrite ; `refilter()` : un filtre
// porte sur cette valeur, la grille est refiltrée (une photo qui n'y répond plus disparaît).
// Undo (Ctrl+Z, "Undo" in the toast): the value each photo had just before the write is kept, and written back to it by `undoMarking`.
// `restore` (undo itself): Map photo id -> value of `property` to write back, one per photo (`fields` is then empty).
let markingChain = Promise.resolve();
// Photo property of each field of update_photos_marking, and its value when the photo has none. The per-photo values of an undo use the
// same names (MarkingTarget in main.rs).
const MARKING_PROPERTIES = { rating: ['rating', 0], colorFlag: ['color_flag', 'none'], pickFlag: ['pick_flag', 'none'] };
function writeMarking(targets, fields, { startMessage, doneMessage, apply, refilter, property = null, restore = null, undoMeta = null }) {
  const [markedProperty, emptyValue] = property ? [property, null] : MARKING_PROPERTIES[Object.keys(fields)[0]];
  const photosArg = targets.map(photo => (restore
    ? { id: photo.id, path: photo.path, [markedProperty]: restore.get(photo.id) }
    : { id: photo.id, path: photo.path }));
  let previous = null; // id -> value before this write (read when the write starts, after the writes queued before it)
  const finish = (result, error) => {
    if (!result) {
      if (error) showWriteToast(t('Metadata writing failed: {error}', { error: String(error) }));
      return;
    }
    const written = new Set(result.written);
    const successful = targets.filter(photo => written.has(photo.id));
    for (const photo of successful) apply(photo);
    // Modification dates of the rewritten files or sidecars: the sort by modification date moves the photos written just now to the top.
    const reordered = applyEffectiveModified((result.dates ?? []).map(entry => [entry.id, entry.effective_modified]));
    forgetCachedImagePaths(successful.map(photo => photo.path));
    if (successful.length && (refilter() || reordered)) applyPhotoFilters({ keepState: true });
    else { updateUIOnSelection(); if (successful.length) refreshListView({ dataChanged: true }); }
    if (markedProperty === 'rating') updateFullscreenRatingStars();
    // Only the photos actually written can be given their previous value back.
    let undoEntry = null;
    if (!restore && successful.length && undoMeta) {
      const dateById = new Map((result.dates ?? []).map(entry => [entry.id, entry.effective_modified]));
      const paths = successful.map(photo => photo.path);
      const entries = successful.map(photo => ({
        id: photo.id,
        path: photo.path,
        value: previous.get(photo.id),
        effectiveModified: dateById.get(photo.id) ?? photo.effective_modified ?? 0,
      }));
      const meta = {
        ...undoMeta,
        count: successful.length,
        itemKind: itemKindForPaths(paths),
        filename: successful.length === 1 ? baseName(paths[0]) : null,
      };
      undoEntry = pushUndo('common', {
        meta,
        canRun: () => canUndoFileTargets(entries),
        run: () => undoMarking(markedProperty, entries, refilter, meta),
      });
    }
    const stopped = result.cancelled ? ` · ${t('Metadata writing stopped: {count} not processed', { count: result.cancelled })}` : '';
    // Failures: the toast names the first one, its "Details" button lists them all. Otherwise "Undo" + "History" (or "History" after an undo).
    const action = failureDetailsAction(t('Metadata could not be written to some files'), result.failed)
      ?? (undoEntry ? undoToastActions('common', undoEntry) : restore && hasUndo('common') ? historyToastAction() : null);
    showWriteToast(`${doneMessage(successful.length, successful)}${failureSummary(result.failed)}${stopped}`, false, action);
  };
  const run = () => {
    // Photos of a move in progress or waiting would change path while being written (the backend lock makes the write fail cleanly
    // anyway): refused with the same message as the other file operations. Only those photos: the others stay editable during a long
    // transfer. A rename (photoMoveRunning, no path list, a split second) blocks everything. Copies and resizing do not move files.
    const moving = queuedPathsBeingChanged();
    if (photoMoveRunning || photosArg.some(photo => moving.has(photo.path))) {
      showWriteToast(t('Wait for the running file task to finish.'));
      return undefined;
    }
    previous = new Map(targets.map(photo => [photo.id, photo[markedProperty] ?? emptyValue]));
    showWriteToast(startMessage, true);
    return runLocked('update_photos_marking', { photos: photosArg, ...fields }, targets.length, finish);
  };
  markingChain = markingChain.then(run, run);
  return markingChain;
}

// Gives each photo of an earlier marking write its previous value back (`entries`: { id, path, value }), in one command. The photos are
// looked up in the whole list: they may have left the view (filter on that value) or be shown in another order.
function undoMarking(property, entries, refilter, originalMeta) {
  const byId = new Map(loadedPhotos.map(photo => [photo.id, photo]));
  const targets = entries.map(entry => byId.get(entry.id) ?? { id: entry.id, path: entry.path });
  const values = new Map(entries.map(entry => [entry.id, entry.value]));
  return writeMarking(targets, {}, {
    property,
    restore: values,
    startMessage: t('Undoing…'),
    doneMessage: (count, successful) => formatUndoToast(originalMeta, { count, paths: successful.map(photo => photo.path) }),
    apply: photo => { photo[property] = values.get(photo.id); },
    refilter,
  });
}

// `explicitTargets` (menu contextuel) : photos précises à noter, à la place de la sélection.
async function setSelectionRating(rating, explicitTargets = null) {
  const targets = explicitTargets ?? commandTargetPhotos(); // en mode Comparer avec plusieurs photos : la sous-sélection uniquement
  if (!targets.length) {
    if (!explicitTargets && isCompareMultiple()) notifyNoCompareTarget();
    return;
  }
  // Si toutes les photos sélectionnées ont déjà exactement cette note, 
  // on considère qu'on veut l'effacer (passer à 0).
  const allAlreadyHaveRating = targets.every(photo => photo.rating === rating);
  const finalRating = allAlreadyHaveRating ? 0 : rating;
  let anyWritten = false;
  await writeMarking(targets, { rating: finalRating }, {
    startMessage: finalRating === 0 ? t('Removing rating') : tp('Writing {count} file (rating: {rating})…', targets.length, { rating: finalRating }),
    doneMessage: count => (finalRating === 0 ? tp('Rating removed for {count} file', count) : tp('{count} file modified', count)),
    apply: photo => { photo.rating = finalRating; anyWritten = true; },
    refilter: isRatingFilterActive,
    undoMeta: { kind: 'rating', value: finalRating },
  });
  if (isFullscreenOpen() && anyWritten) showFullscreenRatingForAWhile();
  updateFullscreenRatingStars();
}

// ==========================================
// LOSSLESS ROTATION (orientation.rs)
// ==========================================
// Only the orientation tag changes (EXIF and / or XMP, through the active writer): the image is never decoded nor recompressed.
// HEIC / HEIF and videos are left out (their container carries the rotation). Ctrl+R turns right, Shift+R left; Ctrl+Z, or "Undo" in the
// toast, turns the last rotations back (the opposite rotation gives back the exact previous value).
export function isRotatablePath(path) {
  const ext = (path || '').split('.').pop()?.toLowerCase();
  return !VIDEO_EXTENSIONS.has(ext) && !HEIF_EXTENSIONS.has(ext);
}

// `quarterTurns`: 1 right, -1 left, 2 for 180°. `explicitTargets` (context menu): photos to turn, instead of the selection.
// `undo`: the rotation turns back a previous one (not stacked again, other toast).
function rotatePhotos(quarterTurns, explicitTargets = null, { undo = false, undoMeta = null } = {}) {
  const selected = explicitTargets ?? commandTargetPhotos(); // compare mode with several photos: the sub-selection only
  if (!selected.length) {
    if (!explicitTargets && isCompareMultiple()) notifyNoCompareTarget();
    return markingChain;
  }
  const targets = selected.filter(photo => isRotatablePath(photo.path));
  if (!targets.length) {
    showWriteToast(t('Lossless rotation is not possible for HEIC, HEIF and video files'));
    return markingChain;
  }
  const photosArg = targets.map(photo => ({ id: photo.id, path: photo.path }));
  const finish = (result, error) => {
    if (!result) {
      if (error) showWriteToast(t('Metadata writing failed: {error}', { error: String(error) }));
      return;
    }
    const written = new Map(result.written.map(entry => [entry.id, entry]));
    const turned = targets.filter(photo => written.has(photo.id));
    for (const photo of turned) {
      const entry = written.get(photo.id);
      photo.view_fix = entry.view_fix;
      photo.orientation = entry.orientation;
    }
    const reordered = applyEffectiveModified(result.written.map(entry => [entry.id, entry.effective_modified]));
    refreshRotatedPhotos(turned, quarterTurns, reordered);
    const turnedEntries = turned.map(photo => ({
      id: photo.id,
      path: photo.path,
      effectiveModified: written.get(photo.id)?.effective_modified ?? photo.effective_modified ?? 0,
    }));
    let undoEntry = null;
    if (turned.length && !undo) {
      const paths = turned.map(photo => photo.path);
      const meta = {
        kind: 'rotation',
        quarterTurns,
        count: turned.length,
        itemKind: itemKindForPaths(paths),
        filename: turned.length === 1 ? baseName(paths[0]) : null,
      };
      undoEntry = pushUndo('common', {
        meta,
        canRun: () => canUndoFileTargets(turnedEntries),
        run: () => undoRotation(turnedEntries, quarterTurns, meta),
      });
    }
    const stopped = result.cancelled ? ` · ${t('Metadata writing stopped: {count} not processed', { count: result.cancelled })}` : '';
    const baseMessage = undo
      ? formatUndoToast(undoMeta, { count: turned.length, paths: turned.map(photo => photo.path) })
      : tp('{count} photo turned', turned.length);
    const message = `${baseMessage}${failureSummary(result.failed)}${stopped}`;
    // Failures take the toast button (their details); otherwise "Undo" + "History" (or "History" after an undo).
    const action = failureDetailsAction(t('Metadata could not be written to some files'), result.failed)
      ?? (undoEntry ? undoToastActions('common', undoEntry) : undo && hasUndo('common') ? historyToastAction() : null);
    showWriteToast(message, false, action);
  };
  const run = () => {
    // Same rule as the other metadata writes (see writeMarking): photos of a move in progress are not written.
    const moving = queuedPathsBeingChanged();
    if (photoMoveRunning || photosArg.some(photo => moving.has(photo.path))) {
      showWriteToast(t('Wait for the running file task to finish.'));
      return undefined;
    }
    showWriteToast(undo ? t('Undoing rotation…') : tp('Turning {count} photo…', targets.length), true);
    return runLocked('rotate_photos', { photos: photosArg, quarterTurns }, targets.length, finish);
  };
  markingChain = markingChain.then(run, run);
  return markingChain;
}

// Undo of a rotation (see runUndo): the opposite rotation, on its photos wherever the view is now.
function undoRotation(entries, quarterTurns, originalMeta) {
  const byId = new Map(loadedPhotos.map(photo => [photo.id, photo]));
  const targets = entries.map(entry => byId.get(entry.id) ?? entry);
  return rotatePhotos(-quarterTurns, targets, { undo: true, undoMeta: originalMeta });
}

// Turned photos: their cached images are regenerated by the backend; the grid, the preview and the fullscreen view load them again.
// `reordered`: the new modification dates change the order of the grid (see applyEffectiveModified), so the list is rebuilt and sorted again.
function refreshRotatedPhotos(turned, quarterTurns, reordered = false) {
  if (!turned.length) return;
  const paths = turned.map(photo => photo.path);
  const now = Date.now();
  for (const path of paths) photoVersions.set(path, now); // new URLs: the webview must not show its cached copy
  forgetCachedImagePaths(paths);
  // A quarter turn exchanges width and height: the layout follows at once, the new thumbnail confirms the exact ratio.
  if (quarterTurns % 2 !== 0) {
    for (const photo of turned) {
      const ratio = photo.aspectRatio || (photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 0);
      if (ratio > 0) photo.aspectRatio = 1 / ratio;
    }
  }
  const turnedPaths = new Set(paths);
  for (const [index, node] of renderedThumbnailNodes) {
    if (turnedPaths.has(photos[index]?.path)) { node.remove(); renderedThumbnailNodes.delete(index); }
  }
  invalidatePreview(); // the preview cells are created again
  if (reordered) {
    applyPhotoFilters({ keepState: true }); // sorts again, keeps the selection by path, redraws the grid and the panels
  } else {
    updateVirtualScroller();
    updateUIOnSelection();
    refreshListView({ dataChanged: true });
  }
  if (isFullscreenOpen() && turnedPaths.has(photos[lastSelectedIndex]?.path)) loadFullscreenPhoto(photos[lastSelectedIndex]);
}

// ==========================================
// Keyboard shortcuts Memo
// ==========================================
// +      : Zoom in
// -      : Zoom out
// *      : Zoom to full size / Fit to window
// 0-5    : Rate
// 6-9    : Color label
// Alt+0-9 : Rate / color, then next photo (fullscreen or single selection)
// A      : Select / deselect all in compare mode
// Ctrl+A : Select/Deselect All
// C      : Copy to
// Ctrl+C : copy to clipboard
// D      : Info display in fullscreen
// Ctrl+D : Debug to console
// E      : Show in explorer
// F      : Fullscreen toggle
// G      : Shortcut guide
// H      : Histogram and clippings: displayed / both / clippings only / off
// I      : Info panel
// J      : Info sheet
// K      : Keywords panel
// Ctrl+K : Keywords panel: all keywords / keywords of the selection
// L      : List panel
// N      : panneau Bibliothèque
// P      : Preview panel
// R      : Rating bar in fullscreen
// Ctrl+R : Lossless rotation to the right, Shift+R to the left
// Ctrl+Z : Undo the latest rating, color, pick flag or lossless rotation
// S      : Resize
// T      : Show / Hide the top toolbar
// X      : Compare mode
// F11    : Immersive mode
// Del    : Delete
// Alt+V : « Ajouter un visage » (le prochain glisser sur la photo trace une zone, sans Maj). Gestionnaire à part, avant celui des raccourcis des photos :
// celui-ci s'arrête quand la vue Visages ou la vue Personnes est ouverte, alors que leur aperçu permet aussi de dessiner une zone.
// (e.code : indépendant de la disposition du clavier ; e.repeat : une touche maintenue n'arme et ne désarme pas en boucle)
// Shortcuts that put the cursor in an input: Alt+K quick keyword input of the Keywords tab, Alt+D title of the Description tab, Shift+K keyword
// filter field of the sidebar. Alt+K / Alt+D also work from another field (Alt+letter types nothing); Shift+K types a "K" there, so it only
// applies outside text fields. Handled before the photo shortcuts below, where K alone (with or without Shift) switches the Keywords tab.
window.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || isFullscreenOpen() || document.querySelector('.modal:not(.hidden)')) return;
  const key = e.code === 'KeyK' ? 'k' : e.code === 'KeyD' ? 'd' : e.key.toLowerCase();
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement
    || (e.target instanceof HTMLElement && e.target.isContentEditable);
  let action = null;
  if (e.altKey && !e.shiftKey && key === 'k') action = () => focusSideTabField('keywords');
  else if (e.altKey && !e.shiftKey && key === 'd') action = () => focusSideTabField('description');
  else if (e.shiftKey && !e.altKey && key === 'k' && !typing) action = focusKeywordFilterField;
  if (!action) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!e.repeat) action();
});

window.addEventListener('keydown', e => {
  if (!e.altKey || e.ctrlKey || e.metaKey || !(e.key.toLowerCase() === 'v' || e.code === 'KeyV')) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (document.querySelector('.modal:not(.hidden)')) return;
  e.preventDefault();
  if (!e.repeat) armFaceDrawing();
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  // Vue Visages ouverte (hors plein écran) : les raccourcis des photos (suppression, note, copie…) ne s'appliquent pas à la grille masquée ;
  // seul le guide (G) reste disponible, et seulement sans visage sélectionné (une lettre tapée commence alors un nom). Les touches de la vue
  // sont gérées par faces-grid.js.
  if (isFacesViewOpen() && !isFullscreenOpen() && (e.key.toLowerCase() !== 'g' || hasFaceSelection())) return;
  if (isPersonsViewOpen() && !isFullscreenOpen() && e.key.toLowerCase() !== 'g') return; // vue Personnes : idem
  // Ctrl+C : copie les photos sélectionnées dans le presse-papiers de l'OS. Traité avant le raccourci « C » seul (Copier vers…),
  // qui ne doit pas s'ouvrir sur Ctrl+C. Ignoré quand une fenêtre (Paramètres, Guide, Tri…) est ouverte.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
    if (!document.querySelector('.modal:not(.hidden)')) {
      const selectedPhotos = commandTargetIndices().sort((a, b) => a - b).map(index => photos[index]).filter(Boolean); // mode Comparer avec plusieurs photos : sous-sélection
      if (selectedPhotos.length > 0) {
        e.preventDefault();
        copyPhotosToClipboard(selectedPhotos);
      } else if (isCompareMultiple()) {
        e.preventDefault();
        notifyNoCompareTarget();
      }
    }
    return;
  }
  // Ctrl+A : tout sélectionner / tout désélectionner dans la grille. Sans effet en mode Comparer (A seul y gère la sous-sélection), en plein écran ou derrière une fenêtre ouverte.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    if (!isCompareMode() && !isFullscreenOpen() && !document.querySelector('.modal:not(.hidden)')) toggleSelectAllPhotos();
    return;
  }
  // Lossless rotation: Ctrl+R to the right, Shift+R to the left (selection, sub-selection in compare mode, or the fullscreen photo). Ctrl+R is
  // always caught so that it never reloads the window. Handled before R alone (rating bar of the fullscreen view). Not behind an open window.
  const rotationKey = e.key.toLowerCase() === 'r' && !e.altKey && !e.metaKey
    && ((e.ctrlKey && !e.shiftKey) || (e.shiftKey && !e.ctrlKey));
  if (rotationKey) {
    e.preventDefault();
    if (!e.repeat && selectedIndices.size > 0 && !document.querySelector('.modal:not(.hidden)')) rotatePhotos(e.ctrlKey ? 1 : -1);
    return;
  }
  // Ctrl+Z: undoes the latest rating, color, pick flag, rotation, rename or fullscreen face change (text fields keep their own Ctrl+Z: this handler ignores them).
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
    if (document.querySelector('.modal:not(.hidden)')) return;
    e.preventDefault();
    if (!e.repeat) runUndo('common');
    return;
  }
  // CTrl+D debug to console
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'd') {
    console.log("Display Scaling Ratio: ", window.devicePixelRatio);
  }
  // Fanion pick : Maj+P retient, Maj+X rejette (même touche une seconde fois : fanion retiré, voir setSelectionPickFlag). Traité avant P et X seuls
  // (aperçu, mode Comparer). Fanion désactivé dans les Paramètres : la touche garde son comportement d'avant.
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && isPickEnabled() && (e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'x')) {
    e.preventDefault();
    if (selectedIndices.size > 0 && !e.repeat && !document.querySelector('.modal:not(.hidden)')) {
      setSelectionPickFlag(e.key.toLowerCase() === 'p' ? 'picked' : 'rejected');
    }
    return;
  }
  // Show rating bar Shortcut
  if (e.key.toLowerCase() === 'r' && isFullscreenOpen()) {
    toggleFullscreenRatingPinned();
    return;
  }
  // F10 : lance le diaporama, ou l'arrête s'il est en cours (plein écran, ou grille : sur la sélection si elle compte 2 photos ou plus, sinon sur toute la vue).
  // Toujours intercepté pour que la touche ne recharge pas la page.
  if (e.key === 'F10' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (!e.repeat && !document.querySelector('.modal:not(.hidden)')) {
      if (isSlideshowActive()) stopSlideshow(); // diaporama en cours : F10 l'arrête, la photo reste affichée en plein écran
      else if (photos.length > 0) startSlideshow();
    }
    return;
  }
  // Espace : pause / lecture du diaporama (sans effet quand il n'est pas lancé, ou derrière une fenêtre ouverte)
  if (e.key === ' ' && isSlideshowActive() && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector('.modal:not(.hidden)')) {
    e.preventDefault();
    if (!e.repeat) toggleSlideshowPause();
    return;
  }
  // G : affiche / masque le guide des raccourcis (la modale ouverte aussi depuis les Paramètres) ; il se ferme avec G même s'il est ouvert par-dessus les Paramètres.
  if (e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
    if (!guideModal.classList.contains('hidden')) { e.preventDefault(); closeGuide(); return; }
    if (!document.querySelector('.modal:not(.hidden)')) { e.preventDefault(); openGuide(); return; }
  }
  // H : cycles histogram -> histogram + clippings -> clippings only -> off (Display options), with a toast. Inactive behind an open modal.
  if (e.key.toLowerCase() === 'h' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.repeat && !document.querySelector('.modal:not(.hidden)')) {
    e.preventDefault();
    cycleHistogramState();
    return;
  }
  // Informations sur la photo (nom, date, EXIF, rang) en plein écran
  if (e.key.toLowerCase() === 'd' && isFullscreenOpen() && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector('.modal:not(.hidden)')) {
    toggleFullscreenInfo();
    return;
  }
  // Zones de visage en plein écran et dans l'aperçu (lecture des visages activée dans les Paramètres)
  if (e.key.toLowerCase() === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector('.modal:not(.hidden)')) {
    if (toggleFaceRegions()) return;
  }
  // J, E, C et Suppr : sans modificateur, et jamais derrière une fenêtre ouverte (Paramètres, question…), où elles viseraient les photos masquées.
  const modalOpen = Boolean(document.querySelector('.modal:not(.hidden)'));
  const plainKey = !e.ctrlKey && !e.metaKey && !e.altKey && !modalOpen;
  // Modale info
  if (e.key.toLowerCase() === 'j' && plainKey) {
    if (photos[lastSelectedIndex]) {
      showPhotoInfo(photos[lastSelectedIndex]);
      return;
    }
  }
  // Ouvrir dans l'explorateur OS
  if (e.key.toLowerCase() === 'e' && plainKey) {
    if (photos[lastSelectedIndex]) {
      revealInFileManager(photos[lastSelectedIndex]);
      return;
    }
  }
  // O : ouvre la sélection avec le premier programme « Ouvrir avec » du type de fichier (Paramètres > Ouvrir avec)
  if (e.key.toLowerCase() === 'o' && plainKey && !e.shiftKey && selectedIndices.size > 0) {
    e.preventDefault();
    if (e.repeat) return;
    const selectedPhotos = commandTargetPhotos();
    if (selectedPhotos.length > 0) openWithFirstProgram(selectedPhotos);
    else if (isCompareMultiple()) notifyNoCompareTarget();
    return;
  }
  // Copie vers
  if (e.key.toLowerCase() === 'c' && plainKey) {
    if (selectedIndices.size > 0) {
      const selectedPhotos = commandTargetPhotos(); // mode Comparer avec plusieurs photos : sous-sélection
      if (selectedPhotos.length > 0) {
        copyPhotosTo(selectedPhotos);
        return;
      }
      if (isCompareMultiple()) {
        notifyNoCompareTarget();
        return;
      }
    }
  }
  // Redimensionner par lot (S) : sur la sélection uniquement (sous-sélection en mode Comparer avec plusieurs photos). Sans effet derrière une fenêtre
  // ouverte, avec Ctrl / Alt / ⌘ (Ctrl+S reste libre) ou en touche maintenue.
  if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey && selectedIndices.size > 0) {
    if (document.querySelector('.modal:not(.hidden)')) return;
    e.preventDefault();
    if (e.repeat) return;
    const selectedPhotos = commandTargetPhotos();
    if (selectedPhotos.length > 0) {
      resizePhotos(selectedPhotos);
    } else if (isCompareMultiple()) {
      notifyNoCompareTarget();
    }
    return;
  }
  // F2: renames the selected photo, like "Rename…" of the context menu; several photos: batch rename (batch-rename.js).
  // Folders can only be renamed from the context menu (with a preview open, F2 would target the previewed photo).
  if (e.key === 'F2' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (e.repeat || document.querySelector('.modal:not(.hidden)')) return;
    const targetPhotos = commandTargetPhotos();
    if (targetPhotos.length === 1) renamePhoto(targetPhotos[0]);
    else if (targetPhotos.length > 1) openBatchRename(targetPhotos);
    return;
  }
  // Suppression
  if (e.key === 'Delete' && plainKey) {
    if (selectedIndices.size > 0) {
      // Mode comparaison : seule la photo unique ou les photos de la sous-sélection sont visées, jamais toute la comparaison.
      const targetPhotos = commandTargetPhotos();
      if (targetPhotos.length > 0) {
        confirmAndDelete(targetPhotos);
        return;
      }
      if (isCompareMultiple()) {
        notifyNoCompareTarget();
        return;
      }
    }
  }
  // T : masque / affiche la barre d'outils du haut (Filtres, Paramètres, Options d'affichage, Comparer, Aperçu, Info).
  // Réglage mémorisé (`toolbarAutoHide`) : la barre masquée reste masquée au démarrage (elle réapparaît au survol du haut). Les raccourcis N, P, J et X restent actifs barre masquée.
  // Inactif en plein écran ou lorsqu'une fenêtre modale est ouverte (comme les autres bascules de panneaux).
  if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey && !e.altKey && !isFullscreenOpen() && !document.querySelector('.modal:not(.hidden)')) {
    e.preventDefault();
    if (!e.repeat) toggleTopBar();
    return;
  }
  // Bascule des panneaux et modes :
  // X : mode Comparer | P : aperçu | N : panneau Filtres (gauche) | I : panneau Info (droite)
  // Inactif en plein écran ou lorsqu'une fenêtre modale est ouverte.
  // I / K / D : panneau de droite, onglet Info, Mots-clés ou Description (voir keywords-panel.js). Inactif en plein écran (où D affiche les
  // informations de la photo, ci-dessus) ou lorsqu'une fenêtre modale est ouverte.
  const sideTabByKey = { i: 'info', k: 'keywords', d: 'description' };
  const sideTab = sideTabByKey[e.key.toLowerCase()];
  if (sideTab && !e.ctrlKey && !e.metaKey && !e.altKey && !isFullscreenOpen() && !document.querySelector('.modal:not(.hidden)')) {
    e.preventDefault();
    if (!e.repeat) handleSideTabShortcut(sideTab);
    return;
  }
  const panelToggleButtons = {
    x: 'btn-toggle-compare',
    p: 'btn-toggle-preview',
    n: 'btn-toggle-sidebar',
    l: 'btn-toggle-list',
  };
  const targetToggleBtnId = panelToggleButtons[e.key.toLowerCase()];
  if (targetToggleBtnId && !e.ctrlKey && !e.metaKey && !e.altKey && !isFullscreenOpen() && !document.querySelector('.modal:not(.hidden)')) {
    e.preventDefault();
    if (!e.repeat) document.getElementById(targetToggleBtnId)?.click();
    return;
  }
  // Mode Comparer, plusieurs photos : A sous-sélectionne toutes les photos (ou aucune si elles le sont déjà)
  if (e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey && isCompareMultiple()) {
    e.preventDefault();
    toggleAllCompareSubSelection();
    return;
  }
  // Alt + note ou couleur : la photo passe ensuite à la suivante, pour noter une série d'affilée. Seulement en plein écran ou avec
  // une seule photo sélectionnée ; sinon, Alt est sans effet et la touche note simplement la sélection. (Maj est écarté : sur le pavé
  // numérique, il transforme les chiffres en Fin, Inser…) Ctrl est exclu pour ne pas confondre avec AltGr (Ctrl+Alt sous Windows).
  const altAdvance = e.altKey && !e.ctrlKey && !e.metaKey;
  // Chiffre tapé pour la note ou la couleur. Avec Alt, e.key ne donne pas toujours le chiffre (rangée du haut en AZERTY…) : on le lit
  // alors sur la touche physique (e.code), rangée du haut ou pavé numérique.
  const digitKey = /^[0-9]$/.test(e.key) ? e.key
    : (altAdvance && /^(Digit|Numpad)[0-9]$/.test(e.code) ? e.code.slice(-1) : null);
  const advanceAfter = altAdvance && (isFullscreenOpen() || selectedIndices.size === 1);
  // Note et couleur : jamais avec Ctrl / ⌘ (Ctrl+0 « zoom 100 % » effacerait les notes), ni derrière une fenêtre ouverte (question en attente,
  // Paramètres…), ni en touche maintenue (la même touche une seconde fois retire la valeur : elle alternerait).
  const markingKey = digitKey !== null && !e.ctrlKey && !e.metaKey && selectedIndices.size > 0;
  if (markingKey && (e.repeat || modalOpen)) {
    e.preventDefault();
    return;
  }
  // Rating shortcuts
  if (markingKey && digitKey <= '5') {
    e.preventDefault();
    // Les photos visées sont lues avant tout await : passer à la suivante tout de suite n'affecte pas l'écriture en cours.
    setSelectionRating(Number(digitKey));
    if (advanceAfter) navigatePhoto(1);
    return;
  }
  // Couleurs : 6 rouge, 7 jaune, 8 vert, 9 bleu (même touche une seconde fois : couleur retirée, voir setSelectionColorFlag)
  const colorByKey = { 6: 'red', 7: 'yellow', 8: 'green', 9: 'blue' };
  if (markingKey && colorByKey[digitKey] && isColorEnabled()) {
    e.preventDefault();
    setSelectionColorFlag(colorByKey[digitKey]);
    if (advanceAfter) navigatePhoto(1);
    return;
  }
  // Zoom (+ / - / *) : sur l'aperçu (ou l'image survolée en mode désynchronisé), ou sur l'image du plein écran quand il est ouvert
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const zoomTarget = isFullscreenOpen() ? null : getHoveredPreviewSlot();
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomPreviewSteps(1, null, zoomTarget); return; }
    if (e.key === '-') { e.preventDefault(); zoomPreviewSteps(-1, null, zoomTarget); return; }
    if (e.key === '*') { e.preventDefault(); togglePreviewActualSize(null, zoomTarget); return; }
  }
  // Navigation
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    navigatePhoto(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    navigatePhoto(-1);
  } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    && !isFullscreenOpen() && !isCompareMode() && !document.querySelector('.modal:not(.hidden)')) {
    // Up / Down: the photo above / below in the thumbnail grid (any layout), scrolled into view.
    e.preventDefault();
    navigateGridRow(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Escape') {
    if (isFullscreenOpen() && guideModal.classList.contains('hidden')) closeFullscreen(); // guide ouvert par-dessus le plein écran : Échap ne ferme que le guide
    else if (!isFullscreenOpen() && isRawSearchActive() && !document.querySelector('.modal:not(.hidden)') && !isDatePickerOpen()) exitRawSearch(); // « Trouver le RAW » : retour à la vue d'avant
    else if (!isFullscreenOpen() && isDuplicateSearchActive() && !document.querySelector('.modal:not(.hidden)') && !isDatePickerOpen()) exitDuplicateSearch(); // duplicate search: back to the previous view
    else if (!isFullscreenOpen() && isSemanticSearchActive() && !document.querySelector('.modal:not(.hidden)') && !isDatePickerOpen()) exitSemanticSearch(); // content search: same
  } else if (e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (isFullscreenOpen()) closeFullscreen();
    else if (photos.length > 0) openFullscreen(lastSelectedIndex);
  }
});

// ==========================================
// MODALE PARAMÈTRES
// ==========================================
// GESTION DES ONGLETS DE LA MODALE PARAMÈTRES
document.querySelectorAll('.settings-tab-btn').forEach(button => {
  button.addEventListener('click', () => {
    const targetTab = button.dataset.tab;
    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
      const active = btn === button;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.settings-tab-pane').forEach(pane => {
      const active = pane.id === `settings-tab-${targetTab}`;
      pane.classList.toggle('active', active);
      pane.hidden = !active;
    });
  });
});

// ==========================================
// MODALE PARAMÈTRES (Gestion des dossiers)
// ==========================================
function renderSettingsFolderList() {
  settingsFolderList.innerHTML = '';
  const moveButton = (symbol, label, disabled, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'keyword-format-move';
    button.textContent = symbol;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    button.addEventListener('click', action);
    return button;
  };
  // Reorders `folders`, saves the order and redraws the tree and the list.
  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= folders.length) return;
    const reordered = [...folders];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    folders = reordered;
    saveFolderOrder();
    renderFolderTree();
    renderSettingsFolderList();
  };
  for (let index = 0; index < folders.length; index++) {
    const f = folders[index];
    const li = document.createElement('li');
    li.className = 'settings-folder-item';
    li.dataset.folderPath = f.path;
    const handle = document.createElement('span');
    handle.className = 'keyword-format-handle';
    handle.textContent = '⠿';
    handle.title = t('Drag to reorder');
    handle.addEventListener('pointerdown', event => startFolderDrag(event, li, handle));
    const rank = document.createElement('span');
    rank.className = 'keyword-format-rank';
    rank.textContent = `${index + 1}.`;
    // Built as elements: a folder path is text, never markup (a folder may be named "<img …>").
    const label = document.createElement('span');
    label.className = 'settings-folder-path';
    label.title = f.path;
    label.textContent = f.path;
    const remove = document.createElement('button');
    remove.className = 'btn-remove-folder';
    remove.textContent = t('Remove');
    li.append(
      handle,
      rank,
      label,
      moveButton('↑', t('Move up'), index === 0, () => move(index, -1)),
      moveButton('↓', t('Move down'), index === folders.length - 1, () => move(index, 1)),
      remove,
    );
    remove.addEventListener('click', async () => {
      dropScanTasksForFolder(f.path); // un dossier retiré ne doit plus être scanné
      folders = applyFolderOrder(await invoke('remove_folder', { id: f.id, path: f.path }));
      if (currentFolderFilter === f.path) { currentFolderFilter = null; currentPhotoPage = 0; rememberCurrentFolder(); }
      renderFolderTree();
      renderSettingsFolderList();
      loadPhotos();
    });
    settingsFolderList.appendChild(li);
  }
}

// Dragging the handle: the row changes place as soon as the pointer passes the middle of a neighbour; the order is saved on release
// (same pointer events as photo-actions.js: HTML5 drag-and-drop is intercepted by the Tauri window's file drop).
function startFolderDrag(event, item, handle) {
  if (event.button !== 0) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  item.classList.add('dragging');
  const onMove = moveEvent => {
    const previous = item.previousElementSibling;
    const next = item.nextElementSibling;
    if (previous && moveEvent.clientY < previous.getBoundingClientRect().top + previous.offsetHeight / 2) settingsFolderList.insertBefore(item, previous);
    if (next && moveEvent.clientY > next.getBoundingClientRect().top + next.offsetHeight / 2) settingsFolderList.insertBefore(next, item);
  };
  const onEnd = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onEnd);
    handle.removeEventListener('pointercancel', onEnd);
    item.classList.remove('dragging');
    const newOrder = [...settingsFolderList.children].map(child => child.dataset.folderPath);
    const changed = newOrder.length === folders.length && newOrder.some((path, index) => path !== folders[index].path);
    if (changed) {
      folders = newOrder.map(path => folders.find(folder => folder.path === path)).filter(Boolean);
      saveFolderOrder();
      renderFolderTree();
    }
    renderSettingsFolderList();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onEnd);
  handle.addEventListener('pointercancel', onEnd);
}

document.getElementById('btn-open-settings').addEventListener('click', () => {
  refreshStorageLocationUI();
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
    console.error('Version unavailable', error);
  }
}
function closeAbout() {
  aboutModal.classList.add('hidden');
}
document.getElementById('btn-open-about').addEventListener('click', openAbout);
document.getElementById('btn-close-about').addEventListener('click', closeAbout);

// Liens de « À propos » : ouverts dans le navigateur de l'utilisateur, jamais dans la fenêtre de l'application (clic, clic molette, Maj + clic).
for (const link of document.querySelectorAll('#about-modal a[href^="http"]')) {
  const openInBrowser = async event => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    event.preventDefault();
    try {
      await openUrl(link.href);
    } catch (err) {
      console.error('Could not open the link:', err);
    }
  };
  link.addEventListener('click', openInBrowser);
  link.addEventListener('auxclick', openInBrowser);
}

// Fenêtres de l'interface (Paramètres, À propos, Guide, Affichage, Tri, Tâches) : Tab reste dans la fenêtre du dessus (sinon Tab puis Entrée
// activerait un bouton de l'interface derrière elle). Les fenêtres créées en JavaScript gèrent Tab elles-mêmes.
const STATIC_MODALS = '#settings-modal, #about-modal, #update-modal, #guide-modal, #stats-modal, #display-modal, #sort-modal, #tasks-modal, #undo-modal';
document.addEventListener('keydown', event => {
  const top = [...document.querySelectorAll('.modal:not(.hidden)')].at(-1);
  if (top?.matches(STATIC_MODALS)) keepFocusInModal(top, event);
}, true);

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
initGuide();
initStats();
function openGuide() {
  guideModal.classList.remove('hidden');
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

    // Le dossier est ajouté tout de suite à la liste (arborescence et Paramètres) ; son scan passe par la file d'attente des tâches.
    try {
      folders = applyFolderOrder(await invoke('add_folder', { path: dir }));
      renderFolderTree();
      renderSettingsFolderList();
    } catch (error) {
      console.error('Adding folder failed', error);
      showWriteToast(t('Unable to read metadata: {error}', { error }));
      return;
    }
    enqueueScanTask({ kind: 'add', path: dir, command: 'scan_folder', args: { path: dir }, labelKey: 'Scanning folder {folder}…', labelParams: { folder: folderBaseName(dir) } });
  }
});

// ==========================================
// BOUTONS VUES & SIDEBAR
// ==========================================
// Barre d'outils du haut (touche T ou menu de la barre) : masquée ou affichée, le choix est mémorisé (`toolbarAutoHide`).
function toggleTopBar() {
  const topBar = document.getElementById('top-bar');
  if (!topBar) return;
  topBar.classList.remove('peek', 'peek-out'); // T annule l'apparition au survol : la barre devient visible (ou masquée) pour de bon
  const hidden = topBar.classList.toggle('hidden');
  try { localStorage.setItem('toolbarAutoHide', String(hidden)); } catch { /* storage unavailable: the choice just isn't remembered */ }
  requestAnimationFrame(updateVirtualScroller); // la grille gagne ou perd la hauteur de la barre : recalcul de la zone visible
}

let toggleImmersiveFromMenu = () => {}; // set by initTitleBar (see the top of this file): immersive mode lives in the scope of titlebar.js
// Toolbar context menu (right-click on the bar): auto-hide (same as the T key) and labels on the central buttons.
// Both choices are remembered (`toolbarAutoHide`, `toolbarShowLabels`); a hidden bar still appears on hover (peek).
const topBarEl = document.getElementById('top-bar');
function setToolbarLabels(show) {
  topBarEl?.classList.toggle('show-labels', show);
  document.body.classList.toggle('show-toolbar-labels', show); // lets views outside the bar (Faces sort button) follow the same choice
  try { localStorage.setItem('toolbarShowLabels', String(show)); } catch { /* storage unavailable: the choice just isn't remembered */ }
  fitToolbar();
}
setToolbarLabels(readBool('toolbarShowLabels'));

// Narrow window: the bar drops every button label and keeps the icons (`.compact`). The decision is "do the buttons, with their labels, fit?",
// measured with the shrinkable parts frozen at their natural width (`.measuring`): it flips at the same width in both directions, whatever the
// font size, language or "Show all labels" choice.
function fitToolbar() {
  if (!topBarEl || topBarEl.classList.contains('hidden') && !topBarEl.classList.contains('peek')) return;
  topBarEl.classList.remove('compact');
  topBarEl.classList.add('measuring');
  const overflows = topBarEl.scrollWidth > topBarEl.clientWidth;
  topBarEl.classList.remove('measuring');
  topBarEl.classList.toggle('compact', overflows);
}
if (topBarEl) {
  new ResizeObserver(() => fitToolbar()).observe(topBarEl);
  onLanguageChange(fitToolbar);
  onSemanticChange(fitToolbar); // the content search field appears or disappears
  new MutationObserver(() => requestAnimationFrame(fitToolbar)).observe(topBarEl, { subtree: true, attributes: true, attributeFilter: ['hidden'] }); // buttons shown or hidden
}
if (readBool('toolbarAutoHide')) topBarEl?.classList.add('hidden'); // restored before the first layout: the grid starts at full height
topBarEl?.addEventListener('contextmenu', event => {
  event.preventDefault();
  event.stopPropagation(); // the global photo menu handler must not also react
  openContextMenuAt(event, [
    { label: t('Immersive mode item'), title: t('Immersive mode'), shortcut: 'F11', onSelect: () => toggleImmersiveFromMenu() },
    { separator: true },
    { header: t('Toolbar') },
    { label: t('Auto-hide'), shortcut: 'T', checked: topBarEl.classList.contains('hidden'), onSelect: toggleTopBar },
    { label: t('Show all labels'), checked: topBarEl.classList.contains('show-labels'), onSelect: () => setToolbarLabels(!topBarEl.classList.contains('show-labels')) },
    { separator: true },
    { header: t('Panels') },
    ...[['btn-toggle-sidebar', 'Library panel', 'N'], ['btn-toggle-preview', 'Preview', 'P'], ['btn-toggle-exif', 'Info panel', 'J']].map(([id, key, shortcut]) => {
      const button = document.getElementById(id);
      return { label: t(key), shortcut, checked: button.classList.contains('active'), disabled: button.disabled, onSelect: () => button.click() };
    }),
  ]);
});

// Barre masquée : un survol du haut de la fenêtre (bande tout en haut de l'application ou barre de titre) la fait apparaître en surimpression (classe « peek », sans décaler la grille).
// Elle reste affichée tant que la souris est sur elle ou sur la barre de titre, puis glisse vers le haut (classe « peek-out ») quand la souris descend ou quitte la fenêtre.
// Durées réglables dans styles.css (--top-bar-slide-duration et --top-bar-slide-out-duration).
// Pas d'apparition pendant un glisser (défilement, déplacement de photos ou de la fenêtre), en plein écran ou avec une fenêtre ouverte.
const TOP_BAR_HOVER_ZONE_PX = 8;
function hideTopBarPeek() {
  const topBar = document.getElementById('top-bar');
  if (!topBar || !topBar.classList.contains('peek') || topBar.classList.contains('peek-out')) return;
  topBar.classList.add('peek-out');
  // Durée nulle : pas d'animation à attendre, la barre se retire tout de suite.
  if ((parseFloat(getComputedStyle(topBar).animationDuration) || 0) === 0) topBar.classList.remove('peek', 'peek-out');
}
document.getElementById('top-bar')?.addEventListener('animationend', event => {
  // Fin de la glissade vers le haut : la barre est retirée (la fin de la glissade d'apparition ne fait rien).
  if (event.currentTarget.classList.contains('peek-out')) event.currentTarget.classList.remove('peek', 'peek-out');
});
window.addEventListener('mousemove', event => {
  const topBar = document.getElementById('top-bar');
  if (!topBar || !topBar.classList.contains('hidden') || event.buttons !== 0) return;
  const appTop = document.getElementById('app').getBoundingClientRect().top;
  if (topBar.classList.contains('peek')) {
    // Hauteur sans transformation : pendant la glissade, la position réelle de la barre bouge.
    if (event.clientY > appTop + topBar.offsetHeight) hideTopBarPeek();
    else topBar.classList.remove('peek-out'); // la souris revient pendant la disparition : la barre reste
    return;
  }
  if (isFullscreenOpen() || document.querySelector('.modal:not(.hidden)')) return;
  if (event.clientY <= appTop + TOP_BAR_HOVER_ZONE_PX) topBar.classList.add('peek'); // inclut la barre de titre, au-dessus de l'application
});
// Zone de déplacement de la fenêtre (barre de titre) : le webview n'envoie plus aucun événement souris à la page quand le curseur y entre, il signale seulement que la souris quitte le document.
// Une sortie par le haut (vers la barre de titre) fait donc apparaître la barre d'outils ou la maintient ; une sortie par un côté de la fenêtre la cache.
document.documentElement.addEventListener('mouseleave', event => {
  const topBar = document.getElementById('top-bar');
  if (!topBar || !topBar.classList.contains('hidden')) return;
  const peeking = topBar.classList.contains('peek');
  const appTop = document.getElementById('app').getBoundingClientRect().top;
  const exitsByTop = event.clientY <= appTop + (peeking ? topBar.offsetHeight : TOP_BAR_HOVER_ZONE_PX);
  const exitsBySide = event.clientX <= 1 || event.clientX >= window.innerWidth - 1;
  if (!exitsByTop || exitsBySide) { hideTopBarPeek(); return; }
  if (peeking) topBar.classList.remove('peek-out'); // déjà affichée (ou en train de remonter) : elle reste
  else if (event.buttons === 0 && !isFullscreenOpen() && !document.querySelector('.modal:not(.hidden)')) topBar.classList.add('peek');
});
window.addEventListener('blur', hideTopBarPeek); // fenêtre désactivée (Alt+Tab, clic ailleurs) : la barre ne doit pas rester affichée

document.getElementById('btn-toggle-sidebar').addEventListener('click', event => {
  const sidebarVisible = sidebarPanel.classList.toggle('hidden') === false;
  event.currentTarget.classList.toggle('active', sidebarVisible);
  localStorage.setItem('sidebarVisible', String(sidebarVisible)); // Mémorisation de l'état

  if (sidebarVisible) {
    if (sidebarWidth > 0) sidebarPanel.style.width = `${sidebarWidth}px`;
  } else {
    sidebarPanel.style.removeProperty('width');
  }

  setTimeout(updateVirtualScroller, 300);
});


// ==========================================
// REDIMENSIONNEMENT DU PANNEAU LATÉRAL GAUCHE
// ==========================================
const sidebarResizer = document.getElementById('sidebar-resizer');
let sidebarWidth = Number(localStorage.getItem('sidebarWidth')) || 0;
if (sidebarWidth > 0) {
  sidebarPanel.style.width = `${sidebarWidth}px`;
}

sidebarResizer?.addEventListener('pointerdown', event => {
  if (sidebarPanel.classList.contains('hidden')) return;
  sidebarResizer.setPointerCapture(event.pointerId);
  sidebarResizer.classList.add('dragging');
  sidebarPanel.classList.add('resizing');
  let resizeFrame = null;
  let latestPointerEvent = event;

  const resize = pointerEvent => {
    latestPointerEvent = pointerEvent;
    if (resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      const mainLeft = mainContent.getBoundingClientRect().left;
      const minSidebarWidth = 175; // ~11rem
      const maxSidebarWidth = Math.max(minSidebarWidth, mainContent.clientWidth - 300);
      const newWidth = Math.max(minSidebarWidth, Math.min(maxSidebarWidth, latestPointerEvent.clientX - mainLeft));
      sidebarPanel.style.width = `${newWidth}px`;
      sidebarWidth = newWidth;
      updateVirtualScroller();
    });
  };

  const stop = event => {
    if (Number.isFinite(event?.clientX)) latestPointerEvent = event;
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    if (Number.isFinite(latestPointerEvent.clientX)) {
      const mainLeft = mainContent.getBoundingClientRect().left;
      const minSidebarWidth = 175;
      const maxSidebarWidth = Math.max(minSidebarWidth, mainContent.clientWidth - 300);
      const newWidth = Math.max(minSidebarWidth, Math.min(maxSidebarWidth, latestPointerEvent.clientX - mainLeft));
      sidebarPanel.style.width = `${newWidth}px`;
      sidebarWidth = newWidth;
      localStorage.setItem('sidebarWidth', String(newWidth));
    }
    sidebarResizer.classList.remove('dragging');
    sidebarPanel.classList.remove('resizing');
    sidebarResizer.removeEventListener('pointermove', resize);
    sidebarResizer.removeEventListener('pointerup', stop);
    sidebarResizer.removeEventListener('pointercancel', stop);
    updateVirtualScroller();
  };

  sidebarResizer.addEventListener('pointermove', resize);
  sidebarResizer.addEventListener('pointerup', stop);
  sidebarResizer.addEventListener('pointercancel', stop);
});

// Accessibilité clavier (flèches gauche / droite sur la poignée)
sidebarResizer?.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const currentWidth = sidebarPanel.getBoundingClientRect().width;
  const change = event.key === 'ArrowRight' ? 20 : -20;
  const minSidebarWidth = 175;
  const maxSidebarWidth = Math.max(minSidebarWidth, mainContent.clientWidth - 300);
  const newWidth = Math.max(minSidebarWidth, Math.min(maxSidebarWidth, currentWidth + change));
  sidebarPanel.style.width = `${newWidth}px`;
  sidebarWidth = newWidth;
  localStorage.setItem('sidebarWidth', String(newWidth));
  updateVirtualScroller();
});

const previewResizer = document.getElementById('preview-resizer');
const mainContent = document.querySelector('.main-content');
document.getElementById('btn-toggle-preview').addEventListener('click', event => {
  const visible = mainContent.classList.toggle('preview-hidden') === false;
  event.currentTarget.classList.toggle('active', visible);
  localStorage.setItem('previewVisible', String(visible)); // Mémorisation
  requestAnimationFrame(updateVirtualScroller);
});
const thumbnailSpacingSelect = document.getElementById('thumbnail-spacing');
const thumbnailCornersSelect = document.getElementById('thumbnail-corners');
thumbnailCornersSelect.value = thumbnailCorners;
function syncThumbnailSpacingWithLayout() {
  const requiresGap = thumbnailLayout === 'framed' || thumbnailCorners !== 'no';
  thumbnailSpacingSelect.querySelector('option[value="none"]').disabled = requiresGap;
  if (requiresGap && thumbnailSpacing === 'none') {
    thumbnailSpacing = 'small';
    localStorage.setItem('thumbnailSpacing', thumbnailSpacing);
  }
  thumbnailSpacingSelect.value = thumbnailSpacing;
}
document.getElementById('thumbnail-layout').value = thumbnailLayout;
document.getElementById('thumbnail-layout').addEventListener('change', event => {
  thumbnailLayout = event.target.value;
  localStorage.setItem('thumbnailLayout', thumbnailLayout);
  syncThumbnailSpacingWithLayout();
  updateVirtualScroller();
});
syncThumbnailSpacingWithLayout();
thumbnailSpacingSelect.addEventListener('change', event => {
  thumbnailSpacing = event.target.value;
  localStorage.setItem('thumbnailSpacing', thumbnailSpacing);
  updateVirtualScroller();
});
thumbnailCornersSelect.addEventListener('change', event => {
  thumbnailCorners = event.target.value;
  localStorage.setItem('thumbnailCorners', thumbnailCorners);
  document.documentElement.dataset.thumbnailCorners = thumbnailCorners;
  syncThumbnailSpacingWithLayout();
  updateVirtualScroller();
});
// ==========================================
// TRI DES MINIATURES
// ==========================================
// Le tri s'applique à la liste affichée (photos, voir applyPhotoFilters) : il détermine donc à la fois l'ordre de la grille et celui du
// défilement en plein écran. Il est fait côté interface : la date de modification vient de la base, la date de prise de vue est celle du filtre de date.
const sortModal = document.getElementById('sort-modal');
const sortButton = document.getElementById('btn-open-sort');
const SORT_KEY_LABELS = { taken: 'Date taken', modified: 'Date modified', name: 'Filename' };
const sortNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }); // « IMG_2 » avant « IMG_10 », comme l'Explorateur

// Modification date of a photo for the sort, the separators and the position pill: the later of the image file's own date (`modified`) and
// `effective_modified` (image or `.xmp` sidecar, recorded by the backend after each metadata write; 0 on rows read before that column existed).
// Same rule as EFFECTIVE_MODIFIED in db.rs (the backend sorts capped and paged lists with it): change both together. 0 = unknown.
function photoModifiedTime(photo) {
  return Math.max(photo.modified > 0 ? photo.modified : 0, photo.effective_modified > 0 ? photo.effective_modified : 0);
}

// Reports the effective modification dates returned by a metadata write (`entries`: [photoId, date] pairs, 0 or missing = unknown and ignored) onto the
// photo objects of every list that holds them. Returns true when the order of the grid now depends on a date that changed (sort by modification
// date): the caller then re-runs `applyPhotoFilters({ keepState: true })`, which keeps the selection by path (so Alt + rating keeps advancing from the
// right photo). The full screen preload is indexed by position, so it is dropped here. On a capped or paged view only the loaded page is re-sorted:
// the photo moves to the top of the page it is on, and the exact global order comes back with the next page load or sort change.
function applyEffectiveModified(entries) {
  const dates = new Map(entries.filter(([, date]) => date > 0));
  if (!dates.size) return false;
  let moved = false;
  for (const list of new Set([loadedPhotos, folderTreePhotos, photos])) {
    for (const photo of list) {
      const date = dates.get(photo.id);
      if (date === undefined || photo.effective_modified === date) continue;
      const before = photoModifiedTime(photo);
      photo.effective_modified = date;
      if (photoModifiedTime(photo) !== before) moved = true;
    }
  }
  if (!moved || sortKey !== 'modified' || isListGridSortActive()) return false;
  clearFullscreenImageCache();
  return true;
}

// Valeur de tri d'une photo ; null = information absente (ces photos restent en fin de liste, quel que soit l'ordre).
function photoSortValue(photo) {
  if (sortKey === 'name') return photo.filename || photo.path.split(/[\\/]/).pop() || '';
  if (sortKey === 'modified') { const modified = photoModifiedTime(photo); return modified > 0 ? modified : null; }
  return photoTimeKey(photo);
}

// Séparateur actif selon le critère de tri : 'none', 'day', 'week', 'month', 'year' (tri par date) ou 'folder' (tri par nom de fichier).
function activeSeparator() {
  return sortKey === 'name' ? nameSeparator : dateSeparator;
}

// Dossier d'une photo (chemin sans le nom de fichier) et ses segments, calculés une fois pour le tri et le regroupement.
function photoFolder(photo) {
  if (photo.folderPath === undefined) {
    const cut = Math.max(photo.path.lastIndexOf('\\'), photo.path.lastIndexOf('/'));
    photo.folderPath = cut >= 0 ? photo.path.slice(0, cut) : '';
    photo.folderSegments = photo.folderPath.split(/[\\/]+/).filter(Boolean);
  }
  return photo.folderPath;
}

// Compare les dossiers segment par segment (le dossier parent passe avant ses sous-dossiers), avec le même ordre naturel que les noms de fichiers.
function compareFolders(a, b) {
  photoFolder(a);
  photoFolder(b);
  const segmentsA = a.folderSegments;
  const segmentsB = b.folderSegments;
  const shared = Math.min(segmentsA.length, segmentsB.length);
  for (let i = 0; i < shared; i++) {
    const result = sortNameCollator.compare(segmentsA[i], segmentsB[i]);
    if (result) return result;
  }
  if (segmentsA.length !== segmentsB.length) return segmentsA.length - segmentsB.length;
  return a.folderPath < b.folderPath ? -1 : a.folderPath > b.folderPath ? 1 : 0;
}

// Jour de la photo pour le critère de tri par date (prise de vue ou modification), ou null si la date est absente ou invalide.
function photoSortDateParts(photo) {
  let dayKey;
  if (sortKey === 'modified') {
    const modified = photoModifiedTime(photo);
    if (!(modified > 0)) return null;
    const date = new Date(modified);
    dayKey = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  } else {
    dayKey = photoDateKey(photo);
  }
  if (dayKey === null || !isValidDateKey(dayKey)) return null;
  return { year: Math.floor(dayKey / 10000), month: Math.floor(dayKey / 100) % 100, day: dayKey % 100 };
}

// Semaine ISO 8601 (du lundi au dimanche, la semaine 1 contient le 4 janvier) : année ISO et numéro de semaine.
function isoWeekOf({ year, month, day }) {
  const target = new Date(Date.UTC(year, month - 1, day));
  target.setUTCDate(target.getUTCDate() - ((target.getUTCDay() + 6) % 7) + 3); // jeudi de la même semaine
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  return { isoYear, week: 1 + Math.round((target - firstThursday) / (7 * 86400000)) };
}

// Identifiant du groupe d'une photo : deux photos voisines (la liste est déjà triée) de même identifiant sont dans le même groupe.
function separatorGroupKey(photo, mode) {
  if (mode === 'folder') {
    photoFolder(photo);
    return photo.folderSegments.join('/').toLowerCase(); // les chemins Windows ne distinguent pas les majuscules
  }
  const parts = photoSortDateParts(photo);
  if (!parts) return 'unknown';
  if (mode === 'year') return String(parts.year);
  if (mode === 'month') return `${parts.year}-${parts.month}`;
  if (mode === 'week') {
    const { isoYear, week } = isoWeekOf(parts);
    return `${isoYear}-W${week}`;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Texte de la ligne de séparation d'un groupe, d'après sa première photo ; title = infobulle (chemin complet pour un dossier).
function separatorText(photo, mode) {
  if (mode === 'folder') {
    photoFolder(photo);
    return { label: photo.folderPath || '…', title: photo.folderPath };
  }
  const parts = photoSortDateParts(photo);
  if (!parts) return { label: t('Unknown date'), title: '' };
  const language = getLanguage();
  const date = new Date(parts.year, parts.month - 1, parts.day);
  let label;
  if (mode === 'year') {
    label = String(parts.year);
  } else if (mode === 'month') {
    label = new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' }).format(date);
  } else if (mode === 'week') {
    const monday = new Date(parts.year, parts.month - 1, parts.day - ((date.getDay() + 6) % 7));
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const range = new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(monday, sunday);
    label = `${t('Week {week}', { week: isoWeekOf(parts).week })} · ${range}`;
  } else {
    label = new Intl.DateTimeFormat(language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  }
  return { label: label.charAt(0).toLocaleUpperCase(language) + label.slice(1), title: '' };
}

// Découpe la liste affichée en groupes consécutifs [start, end[ selon le séparateur actif ; liste vide = pas de séparateur.
function computePhotoGroups() {
  if (isDuplicateSearchActive() && photos.length > 0) return computeDuplicateSeparators();
  if (isSemanticSearchActive() || isListGridSortActive()) return []; // results are sorted by relevance or list columns: no separator
  const mode = activeSeparator();
  if (mode === 'none' || photos.length === 0) return [];
  const groups = [];
  let current = null;
  let currentKey = null;
  for (let i = 0; i < photos.length; i++) {
    const key = separatorGroupKey(photos[i], mode);
    if (current && key === currentKey) continue;
    if (current) current.end = i;
    current = { start: i, end: photos.length, ...separatorText(photos[i], mode) };
    currentKey = key;
    groups.push(current);
  }
  return groups;
}

function comparePhotosForSort(a, b, listComparator = null) {
  // Keyword filter with suggestions: photos carrying every keyword first, then the fewest guessed keywords, the chosen sort inside each block.
  if (keywordGuesses.size) {
    const guesses = (keywordGuesses.get(a.id)?.length ?? 0) - (keywordGuesses.get(b.id)?.length ?? 0);
    if (guesses) return guesses;
  }
  const semanticSearch = getSemanticSearch();
  if (semanticSearch?.carried.size) {
    // Photos carrying the typed keyword come first, then the content results by decreasing relevance. Inside the first block: the content score
    // ("Score"), or the sort options of the toolbar ("Grid", the rest of this function).
    const carriedA = semanticSearch.carried.has(a.id);
    if (carriedA !== semanticSearch.carried.has(b.id)) return carriedA ? -1 : 1;
    if (!carriedA) return semanticRankOrder(a, b);
    if (getSemanticSortMode() === 'score') {
      const byScore = semanticRankOrder(a, b); // the answer is already sorted by decreasing score; photos without a score (not analysed) last
      if (byScore) return byScore;
    }
  } else if (semanticSearch) {
    // Content search results: by decreasing relevance (the source photo of a similar-content search first).
    return semanticRankOrder(a, b);
  }
  // Duplicate results: groups in the chosen group order, members best first inside each group.
  const duplicateSearch = getDuplicateSearch();
  if (duplicateSearch) {
    const orderA = duplicateSearch.order.get(a.path);
    const orderB = duplicateSearch.order.get(b.path);
    if (orderA && orderB) return duplicateSearch.position.get(orderA.group) - duplicateSearch.position.get(orderB.group) || orderA.rank - orderB.rank;
  }
  if (listComparator) {
    const result = listComparator(a, b);
    if (result) return result;
    return sortNameCollator.compare(a.filename || '', b.filename || '') || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  // Tri par nom avec séparateur par dossier : les dossiers d'abord (dans le sens choisi), puis les noms au sein de chaque dossier.
  if (activeSeparator() === 'folder') {
    const folderResult = compareFolders(a, b);
    if (folderResult) return sortOrder === 'asc' ? folderResult : -folderResult;
  }
  const valueA = photoSortValue(a);
  const valueB = photoSortValue(b);
  if (valueA === null || valueB === null) {
    if (valueA !== valueB) return valueA === null ? 1 : -1;
  } else {
    const result = sortKey === 'name' ? sortNameCollator.compare(valueA, valueB) : valueA - valueB;
    if (result) return sortOrder === 'asc' ? result : -result;
  }
  // Égalité (rafale prise dans la même seconde, valeurs absentes…) : ordre stable et prévisible, indépendant du sens choisi.
  return sortNameCollator.compare(a.filename || '', b.filename || '') || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function sortOrderHint(key, order) {
  if (key === 'name') return order === 'asc' ? 'A → Z' : 'Z → A';
  return t(order === 'asc' ? 'Oldest first' : 'Newest first');
}

// Boutons radio de la modale, aides de l'ordre selon le critère, et infobulle du bouton de la barre du haut (ordre actif au survol).
function updateSortUI() {
  sortModal.querySelectorAll('input[name="sort-key"]').forEach(input => { input.checked = input.value === sortKey; });
  sortModal.querySelectorAll('input[name="sort-order"]').forEach(input => { input.checked = input.value === sortOrder; });
  sortModal.querySelectorAll('input[name="sort-separator-date"]').forEach(input => { input.checked = input.value === dateSeparator; });
  sortModal.querySelectorAll('input[name="sort-separator-name"]').forEach(input => { input.checked = input.value === nameSeparator; });
  document.getElementById('sort-separator-date').hidden = sortKey === 'name'; // les séparateurs proposés dépendent du critère de tri
  document.getElementById('sort-separator-name').hidden = sortKey !== 'name';
  document.getElementById('sort-separator-name-note').hidden = nameSeparator !== 'folder';
  const listOverrideNote = document.getElementById('sort-list-override-note');
  if (listOverrideNote) listOverrideNote.hidden = !isListGridSortActive();
  document.getElementById('sort-hint-asc').textContent = `(${sortOrderHint(sortKey, 'asc')})`;
  document.getElementById('sort-hint-desc').textContent = `(${sortOrderHint(sortKey, 'desc')})`;
  const order = `${t(sortOrder === 'asc' ? 'Ascending' : 'Descending')} (${sortOrderHint(sortKey, sortOrder)})`;
  const description = `${labelWithColon('Sort')} ${t(SORT_KEY_LABELS[sortKey])} · ${order}`;
  sortButton.title = description;
  sortButton.setAttribute('aria-label', description);
}

// Amène la photo dans la zone visible si elle n'y est pas : après un changement de tri, la photo sélectionnée a changé de place.
function scrollToPhotoIndex(index) {
  const layout = photoLayouts.find(item => item.index === index);
  if (!layout) return;
  const viewTop = gridContainer.scrollTop;
  const viewBottom = viewTop + gridContainer.clientHeight;
  if (layout.y >= viewTop && layout.y + layout.height <= viewBottom) return;
  gridContainer.scrollTop = Math.max(0, layout.y - (gridContainer.clientHeight - layout.height) / 2);
  renderVisibleItems();
}

function applySortChange() {
  if (isListGridSortActive()) clearListSortForGridSort();
  localStorage.setItem('photoSortKey', sortKey);
  localStorage.setItem('photoSortOrder', sortOrder);
  localStorage.setItem('photoDateSeparator', dateSeparator);
  localStorage.setItem('photoNameSeparator', nameSeparator);
  updateSortUI();
  clearFullscreenImageCache(); // le cache de préchargement est indexé par position dans la liste
  // Capped or paged list: the backend picked its photos in the previous sort (e.g. the newest ones), so the new sort needs another set; back to page 1.
  if (photoListCap || photoPageCount > 1) {
    currentPhotoPage = 0;
    loadPhotos({ catalogChanged: false });
    return;
  }
  applyPhotoFilters({ keepState: true }); // sélection conservée (retrouvée par chemin)
  scrollToPhotoIndex(lastSelectedIndex);
}

function openSortModal() {
  updateSortUI();
  sortModal.classList.remove('hidden');
  // Le focus sur un champ de la modale évite que les raccourcis clavier (SUPPR, C…) visent la grille pendant qu'elle est ouverte.
  sortModal.querySelector('input[name="sort-key"]:checked')?.focus();
}

function closeSortModal() {
  sortModal.classList.add('hidden');
}

sortButton.addEventListener('click', openSortModal);
document.getElementById('btn-close-sort').addEventListener('click', closeSortModal);
sortModal.addEventListener('click', event => { if (event.target === sortModal) closeSortModal(); });
sortModal.addEventListener('change', event => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (input.name === 'sort-key' && SORT_KEYS.includes(input.value)) sortKey = input.value;
  else if (input.name === 'sort-order') sortOrder = input.value === 'asc' ? 'asc' : 'desc';
  else if (input.name === 'sort-separator-date' && DATE_SEPARATORS.includes(input.value)) dateSeparator = input.value;
  else if (input.name === 'sort-separator-name' && NAME_SEPARATORS.includes(input.value)) nameSeparator = input.value;
  else return;
  applySortChange();
});
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || sortModal.classList.contains('hidden')) return;
  event.preventDefault();
  closeSortModal();
});

// Modale « Affichage » (disposition et taille des miniatures, thème, taille des textes…) : ouverte par le bouton à gauche du bouton de tri.
const displayModal = document.getElementById('display-modal');
function openDisplayModal() {
  displayModal.classList.remove('hidden');
  // Comme pour le tri : le focus dans la modale évite que les raccourcis clavier visent la grille pendant qu'elle est ouverte.
  document.getElementById('thumbnail-layout').focus();
}
function closeDisplayModal() {
  displayModal.classList.add('hidden');
}
document.getElementById('btn-open-display').addEventListener('click', openDisplayModal);
document.getElementById('btn-close-display').addEventListener('click', closeDisplayModal);
displayModal.addEventListener('click', event => { if (event.target === displayModal) closeDisplayModal(); });
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || displayModal.classList.contains('hidden')) return;
  event.preventDefault();
  closeDisplayModal();
});
updateSortUI();

const themeSelect = document.getElementById('theme-select');
const selectionColorInput = document.getElementById('accent-color');
// Couleurs proposées (Paramètres > Affichage) pour la sélection et pour les boutons actifs : clé de traduction du nom, valeur.
const ACCENT_PALETTE = [
  ['Blue', '#1e72ad'], ['Red', '#e74c3c'], ['Orange', '#e67e22'], ['Yellow', '#f1c40f'],
  ['Green', '#2ecc71'], ['Purple', '#9b59b6'], ['Pink', '#ff4fa3'],
];
// Pastilles de la palette, placées avant le sélecteur de couleur personnalisée `input` (noms traduits avec la langue, voir applyTranslations).
function createAccentSwatches(input, className) {
  const swatches = ACCENT_PALETTE.map(([label, color]) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = className;
    swatch.dataset.color = color;
    swatch.style.background = color;
    swatch.title = t(label);
    swatch.setAttribute('aria-label', t(label));
    swatch.setAttribute('data-i18n-title', label);
    swatch.setAttribute('data-i18n-aria-label', label);
    return swatch;
  });
  input.before(...swatches);
  return swatches;
}
const selectionColorSwatches = createAccentSwatches(selectionColorInput, 'accent-swatch');
const activeButtonColorInput = document.getElementById('active-button-color');
const activeButtonColorSwatches = createAccentSwatches(activeButtonColorInput, 'button-swatch');
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
  appTheme = APP_THEMES.includes(event.target.value) ? event.target.value : DEFAULTS.appTheme;
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
  updateRatingAction();
  updateFilteredPhotosCount();
  renderFilterSummaries(); // résumés des filtres dans la langue courante (dates, infobulles, étiquettes)
  updateDateFilterUI(parseDateFilter(dateFilterInput.value).error);
  updateSortUI();
  updateVirtualScroller(); // libellés des séparateurs (jours, mois…) dans la nouvelle langue
  refreshDatePickerLanguage();
});

const thumbnailSizeInput = document.getElementById('thumbnail-size');
const thumbnailSizeValue = document.getElementById('thumbnail-size-value');
thumbnailSizeInput.max = String(thumbnailCacheSize); // Valeur max synchronisée
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
// Bouton « Supprimer les miniatures orphelines » : même purge que la fin du rescan complet (purge_orphan_cache côté Rust).
const purgeOrphanThumbnailsButton = document.getElementById('btn-purge-orphan-thumbnails');
purgeOrphanThumbnailsButton?.addEventListener('click', async () => {
  purgeOrphanThumbnailsButton.disabled = true;
  showTaskToast(t('Removing orphan thumbnails…'), 0);
  try {
    const removed = await invoke('purge_orphan_thumbnails');
    showWriteToast(tp('{count} orphan thumbnail removed', removed, { count: removed }));
  } catch (error) {
    showWriteToast(t('Orphan thumbnail removal failed: {error}', { error }));
  } finally {
    hideTaskToast();
    purgeOrphanThumbnailsButton.disabled = false;
  }
});
// Thumbnail quality (Settings > Storage): only thumbnails written from now on use it, the cache is not cleared.
// The backend keeps its own copy in config.json so the setting applies from startup.
const thumbnailQualitySelect = document.getElementById('thumbnail-quality-select');
if (thumbnailQualitySelect) {
  thumbnailQualitySelect.value = readChoice('thumbnailQuality', ['normal', 'high']);
  thumbnailQualitySelect.addEventListener('change', async () => {
    const quality = thumbnailQualitySelect.value;
    try {
      await invoke('set_thumbnail_quality', { quality });
      localStorage.setItem('thumbnailQuality', quality);
    } catch (error) {
      console.error('Thumbnail quality change failed', error);
      thumbnailQualitySelect.value = readChoice('thumbnailQuality', ['normal', 'high']);
    }
  });
}
// Gestionnaire du sélecteur de taille des miniatures en cache
const thumbnailCacheSelect = document.getElementById('thumbnail-cache-size-select');
if (thumbnailCacheSelect) {
  thumbnailCacheSelect.value = String(thumbnailCacheSize);
  thumbnailCacheSelect.addEventListener('change', async (e) => {
    const newSize = Number(e.target.value);
    if (newSize === thumbnailCacheSize) return;

    const confirmed = await confirmDialog({
      title: t('Thumbnail cache size'),
      message: t('Change thumbnail cache size? This will delete all thumbnails, they will be gradually rebuilt during navigation.'),
      confirmLabel: t('Change'),
      cancelLabel: t('Cancel'),
    });

    if (!confirmed) {
      thumbnailCacheSelect.value = String(thumbnailCacheSize);
      return;
    }

    showTaskToast(t('Thumbnails cache cleared'), 0);
    try {
      await invoke('clear_thumbnail_cache');
      await invoke('set_thumbnail_cache_size', { size: newSize });
      thumbnailCacheSize = newSize;
      localStorage.setItem('thumbnailCacheSize', String(thumbnailCacheSize));

      // Met à jour la borne max de la modale "Options d'affichage"
      thumbnailSizeInput.max = String(thumbnailCacheSize);
      if (thumbnailSize > thumbnailCacheSize) {
        thumbnailSize = thumbnailCacheSize;
        localStorage.setItem('thumbnailSize', String(thumbnailSize));
        thumbnailSizeInput.value = String(thumbnailSize);
        thumbnailSizeValue.textContent = `${thumbnailSize} px`;
      }

      // Vide les caches mémoire du frontend
      thumbnailCacheLookups.clear();
      thumbnailCacheWrites.clear();
      pendingThumbnailLookups.clear();
      for (const node of renderedThumbnailNodes.values()) node.remove();
      renderedThumbnailNodes.clear();

      updateVirtualScroller();
      showWriteToast(t('Thumbnails cache cleared'));
    } catch (err) {
      console.error('Thumbnail cache size change failed', err);
      thumbnailCacheSelect.value = String(thumbnailCacheSize);
    } finally {
      hideTaskToast();
    }
  });
}
previewResizer.addEventListener('pointerdown', event => {
  if (mainContent.classList.contains('preview-hidden') && !mainContent.classList.contains('map-mode') && !mainContent.classList.contains('list-mode')) return; // la carte et la liste gardent leur panneau sans aperçu
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
        + previewResizer.getBoundingClientRect().width
        + (sidebarResizer && !sidebarPanel.classList.contains('hidden') ? sidebarResizer.getBoundingClientRect().width : 0);
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
        + previewResizer.getBoundingClientRect().width
        + (sidebarResizer && !sidebarPanel.classList.contains('hidden') ? sidebarResizer.getBoundingClientRect().width : 0);
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
        + previewResizer.getBoundingClientRect().width
        + (sidebarResizer && !sidebarPanel.classList.contains('hidden') ? sidebarResizer.getBoundingClientRect().width : 0);
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
  localStorage.setItem('exifVisible', String(exifVisible)); // Memorisation
  setTimeout(updateVirtualScroller, 300);
});

// REDIMENSIONNEMENT DU PANNEAU DE DROITE (Info / Mots-clés) : poignée à sa gauche, largeur mémorisée localement.
const EXIF_PANEL_MIN_WIDTH = 220;
const exifPanelElement = document.getElementById('exif-panel');
const exifResizer = document.getElementById('exif-resizer');
const storedExifPanelWidth = Number(localStorage.getItem('exifPanelWidth'));
if (storedExifPanelWidth >= EXIF_PANEL_MIN_WIDTH) exifPanelElement.style.width = `${storedExifPanelWidth}px`;

// Applique la largeur demandée, bornée pour laisser de la place à la barre latérale et à la grille ; renvoie la largeur retenue.
function setExifPanelWidth(requestedWidth) {
  const mainRect = document.querySelector('.main-content').getBoundingClientRect();
  const sidebar = document.getElementById('sidebar-panel');
  const sidebarWidth = sidebar && !sidebar.classList.contains('hidden') ? sidebar.getBoundingClientRect().width : 0;
  const maxWidth = Math.max(EXIF_PANEL_MIN_WIDTH, mainRect.width - sidebarWidth - 320);
  const width = Math.round(Math.max(EXIF_PANEL_MIN_WIDTH, Math.min(maxWidth, requestedWidth)));
  exifPanelElement.style.width = `${width}px`;
  return width;
}

exifResizer?.addEventListener('pointerdown', event => {
  if (exifPanelElement.classList.contains('hidden') || event.button !== 0) return;
  event.preventDefault();
  exifResizer.setPointerCapture(event.pointerId);
  exifResizer.classList.add('dragging');
  exifPanelElement.classList.add('resizing');
  const panelRect = exifPanelElement.getBoundingClientRect();
  let width = panelRect.width;
  const onMove = moveEvent => { width = setExifPanelWidth(panelRect.right - moveEvent.clientX); };
  const onEnd = () => {
    exifResizer.removeEventListener('pointermove', onMove);
    exifResizer.removeEventListener('pointerup', onEnd);
    exifResizer.removeEventListener('pointercancel', onEnd);
    exifResizer.classList.remove('dragging');
    exifPanelElement.classList.remove('resizing');
    localStorage.setItem('exifPanelWidth', String(width));
    updateVirtualScroller();
  };
  exifResizer.addEventListener('pointermove', onMove);
  exifResizer.addEventListener('pointerup', onEnd);
  exifResizer.addEventListener('pointercancel', onEnd);
});

// Au clavier (poignée au focus) : flèche gauche = plus large, flèche droite = plus étroit.
exifResizer?.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  event.stopPropagation(); // sans cela, les flèches changeraient aussi de photo
  const width = setExifPanelWidth(exifPanelElement.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 24 : -24));
  localStorage.setItem('exifPanelWidth', String(width));
  updateVirtualScroller();
});

// Filtre de note : cinq étoiles (un clic sur l'étoile active l'efface), pastille « non notées » et bascule ≥ / =.
const ratingStarsBar = document.getElementById('rating-stars');
const ratingUnratedButton = document.getElementById('rating-unrated');
const ratingModeButton = document.getElementById('rating-mode');
ratingStarsBar.replaceChildren(...[1, 2, 3, 4, 5].map(stars => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rating-star';
  button.dataset.stars = String(stars);
  button.textContent = '★';
  return button;
}));

// Texte lisible du filtre courant (infobulle du badge) ; ratingStarLabel décrit l'effet d'un clic sur l'étoile N.
function ratingStarLabel(stars) {
  return tp(ratingFilter.mode === 'eq' ? '= {count} star' : '≥ {count} star', stars);
}
function ratingFilterDescription() {
  const parts = [];
  if (ratingFilter.unrated) parts.push(t('Unrated'));
  if (ratingFilter.stars > 0) parts.push(ratingStarLabel(ratingFilter.stars));
  return parts.join(' + ');
}

// Reflète l'état du filtre sur les contrôles : étoiles remplies jusqu'à N (« au moins ») ou N seule (« exactement »), libellés accessibles.
function updateRatingFilterControls() {
  const exact = ratingFilter.mode === 'eq';
  ratingStarsBar.querySelectorAll('.rating-star').forEach(button => {
    const stars = Number(button.dataset.stars);
    const active = exact ? stars === ratingFilter.stars : stars <= ratingFilter.stars;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(stars === ratingFilter.stars));
    button.title = ratingStarLabel(stars);
    button.setAttribute('aria-label', button.title);
  });
  ratingUnratedButton.classList.toggle('active', ratingFilter.unrated);
  ratingUnratedButton.setAttribute('aria-pressed', String(ratingFilter.unrated));
  ratingModeButton.textContent = exact ? '=' : '≥';
  ratingModeButton.title = t(exact ? 'Exactly this rating (click for at least)' : 'At least this rating (click for exactly)');
  ratingModeButton.setAttribute('aria-label', ratingModeButton.title);
  ratingModeButton.disabled = ratingFilter.stars === 0; // sans étoile choisie, le mode n'a pas d'effet
}

ratingStarsBar.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest('.rating-star') : null;
  if (!button) return;
  const stars = Number(button.dataset.stars);
  ratingFilter.stars = ratingFilter.stars === stars ? 0 : stars;
  ratingFilter.unrated = false; // « non notées » et une note choisie s'excluent
  applyPhotoFilters();
});
// Aperçu au survol : remplit les étoiles comme le ferait le clic (classe `preview`, retirée à la sortie).
ratingStarsBar.addEventListener('mouseover', event => {
  const button = event.target instanceof Element ? event.target.closest('.rating-star') : null;
  if (!button) return;
  const hovered = Number(button.dataset.stars);
  ratingStarsBar.querySelectorAll('.rating-star').forEach(star => {
    const stars = Number(star.dataset.stars);
    star.classList.toggle('preview', ratingFilter.mode === 'eq' ? stars === hovered : stars <= hovered);
  });
});
ratingStarsBar.addEventListener('mouseleave', () => {
  ratingStarsBar.querySelectorAll('.rating-star.preview').forEach(star => star.classList.remove('preview'));
});
ratingUnratedButton.addEventListener('click', () => {
  ratingFilter.unrated = !ratingFilter.unrated;
  if (ratingFilter.unrated) ratingFilter.stars = 0; // exclusif avec les étoiles
  applyPhotoFilters();
});
ratingModeButton.addEventListener('click', () => {
  ratingFilter.mode = ratingFilter.mode === 'eq' ? 'gte' : 'eq';
  applyPhotoFilters();
});
updateRatingFilterControls();

// Carré de fanion pick cliquable (filtre : quatre états ; marquage : retenu et rejeté), même présentation que les carrés de couleur.
function createPickSquare(flag) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `color-square pick-square pick-${flag.key}`;
  button.dataset.pick = flag.key;
  button.textContent = flag.glyph;
  button.title = t(flag.label);
  button.setAttribute('aria-label', t(flag.label));
  button.setAttribute('data-i18n-title', flag.label);
  button.setAttribute('data-i18n-aria-label', flag.label);
  button.setAttribute('aria-pressed', 'false');
  return button;
}

// Filtre par fanion pick : plusieurs carrés peuvent être cochés (une photo est affichée si elle a l'un des fanions cochés).
const pickFilterBar = document.getElementById('pick-filter-bar');
// Mêmes drapeaux que dans la barre flottante : un seul glyphe dont la couleur porte le fanion.
pickFilterBar.replaceChildren(...PICK_FLAGS.map(flag => createPickSquare({ ...flag, glyph: '⚑' })));
pickFilterBar.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest('.pick-square') : null;
  if (!button) return;
  const key = button.dataset.pick;
  if (pickFilters.has(key)) pickFilters.delete(key); else pickFilters.add(key);
  setColorSquareChecked(button, pickFilters.has(key));
  applyPhotoFilters();
});

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

// ==========================================
// MARQUAGE (note et couleur de la sélection)
// ==========================================
// Deux présentations des mêmes contrôles : une section « Marquage » en bas du panneau Info, et une barre flottante en bas de la grille.
// Le réglage « Emplacement des barres de marquage » (modale Affichage) choisit : off, panel, floating, hybrid (panneau Info s'il est
// affiché avec son onglet Info, barre flottante sinon). Rien n'est affiché sans photo sélectionnée ; les raccourcis 0 à 9 marchent toujours.
const MARKING_MODES = ['off', 'panel', 'floating', 'hybrid'];
const storedMarkingMode = localStorage.getItem('markingPlacement');
let markingMode = MARKING_MODES.includes(storedMarkingMode) ? storedMarkingMode : DEFAULTS.markingPlacement;
const markingPanel = document.getElementById('marking-panel');
const markingBar = document.getElementById('marking-bar');
const markingColorButton = document.getElementById('marking-color-button');
const markingColorPopover = document.getElementById('marking-color-popover');

// Cinq étoiles : un clic sur la note active l'efface (voir setSelectionRating).
function createMarkingStars() {
  const group = document.createElement('div');
  group.className = 'selection-rating-stars marking-stars';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', t('Set a rating from 1 to 5'));
  group.setAttribute('data-i18n-aria-label', 'Set a rating from 1 to 5');
  for (let rating = 1; rating <= 5; rating++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.rating = String(rating);
    button.textContent = '★';
    const label = rating === 1 ? 'Set 1 star' : `Set ${rating} stars`;
    button.title = t(label);
    button.setAttribute('aria-label', t(label));
    button.setAttribute('data-i18n-title', label);
    button.setAttribute('data-i18n-aria-label', label);
    button.addEventListener('click', () => setSelectionRating(rating));
    group.append(button);
  }
  return group;
}

// Couleurs : une seule possible, un nouveau clic sur la couleur active l'efface (voir setSelectionColorFlag).
function createMarkingColors() {
  const bar = document.createElement('div');
  bar.className = 'color-bar marking-colors';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', t('Set a color'));
  bar.setAttribute('data-i18n-aria-label', 'Set a color');
  bar.replaceChildren(...COLOR_FLAGS.map(createColorSquare));
  bar.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('.color-square') : null;
    if (button) setSelectionColorFlag(button.dataset.flag);
  });
  return bar;
}

// Fanions pick proposés selon le format placé en tête de l'ordre de lecture (Paramètres > Métadonnées) : digiKam connaît aussi « en attente »,
// xmpDM:pick et xmpDM:good seulement retenu / rejeté ; « none » (blanc) retire le fanion.
const PICK_CHOICES = {
  digikam: ['none', 'pending', 'picked', 'rejected'],
  'xmpdm-pick': ['none', 'picked', 'rejected'],
  'xmpdm-good': ['none', 'picked', 'rejected'],
};
const markingPickBars = []; // barres de choix (panneau Info et bulle de la barre flottante), reconstruites quand l'ordre de lecture change

function fillMarkingPickBar(bar) {
  const keys = PICK_CHOICES[topPickFormat()] ?? PICK_CHOICES.digikam;
  // Un seul glyphe (drapeau) : c'est sa couleur qui porte le fanion (blanc aucun, jaune en attente, vert retenu, rouge rejeté).
  bar.replaceChildren(...keys.map(key => createPickSquare({ ...PICK_FLAGS.find(flag => flag.key === key), glyph: '⚑' })));
}

// Choix de fanion pick : un clic pose le fanion choisi sur la sélection (ceux déjà au même état ne sont pas réécrits).
function createMarkingPick() {
  const bar = document.createElement('div');
  bar.className = 'pick-bar marking-pick pick-control'; // sans « color-bar » : ce dernier est masqué quand les couleurs sont désactivées
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', t('Pick'));
  bar.setAttribute('data-i18n-aria-label', 'Pick');
  fillMarkingPickBar(bar);
  markingPickBars.push(bar);
  bar.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('.pick-square') : null;
    if (button) setSelectionPickFlag(button.dataset.pick, { toggle: false });
  });
  return bar;
}
onPickOrderChange(() => {
  markingPickBars.forEach(fillMarkingPickBar);
  updatePickAction();
});

document.getElementById('marking-panel-controls').append(createMarkingStars(), createMarkingColors(), createMarkingPick());
document.getElementById('marking-bar-stars').append(createMarkingStars());
// Dans la barre flottante, les couleurs se déroulent dans une bulle ouverte par la pastille multicolore, et les fanions pick dans une autre,
// ouverte par un drapeau à la couleur du fanion de la photo.
markingColorPopover.append(createMarkingColors());
const markingPickButton = document.getElementById('marking-pick-button');
const markingPickPopover = document.getElementById('marking-pick-popover');
markingPickPopover.append(createMarkingPick());

function closeMarkingColorPopover() {
  markingColorPopover.hidden = true;
  markingColorButton.setAttribute('aria-expanded', 'false');
}
function closeMarkingPickPopover() {
  markingPickPopover.hidden = true;
  markingPickButton.setAttribute('aria-expanded', 'false');
}
markingColorButton.addEventListener('click', () => {
  const open = markingColorPopover.hidden;
  closeMarkingPickPopover();
  markingColorPopover.hidden = !open;
  markingColorButton.setAttribute('aria-expanded', String(open));
});
markingPickButton.addEventListener('click', () => {
  const open = markingPickPopover.hidden;
  closeMarkingColorPopover();
  markingPickPopover.hidden = !open;
  markingPickButton.setAttribute('aria-expanded', String(open));
});
markingColorPopover.addEventListener('click', event => {
  if (event.target instanceof Element && event.target.closest('.color-square')) closeMarkingColorPopover();
});
markingPickPopover.addEventListener('click', event => {
  if (event.target instanceof Element && event.target.closest('.pick-square')) closeMarkingPickPopover();
});
// Un clic ailleurs ou Échap referme la bulle (Échap ne doit alors rien faire d'autre, comme vider la sélection).
document.addEventListener('pointerdown', event => {
  if (!markingColorPopover.hidden && !(event.target instanceof Element && event.target.closest('.marking-color-wrap'))) closeMarkingColorPopover();
  if (!markingPickPopover.hidden && !(event.target instanceof Element && event.target.closest('.marking-pick-wrap'))) closeMarkingPickPopover();
}, true);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || (markingColorPopover.hidden && markingPickPopover.hidden)) return;
  closeMarkingColorPopover();
  closeMarkingPickPopover();
  event.stopImmediatePropagation();
}, true);

// Le panneau Info compte comme « ouvert » quand il est affiché avec son onglet Info (le seul qui porte la section Marquage).
function isInfoTabVisible() {
  return !document.getElementById('exif-panel').classList.contains('hidden') && !document.getElementById('exif-tab-info').hidden;
}

function updateMarkingPlacement() {
  const hasSelection = selectedIndices.size > 0;
  const infoVisible = isInfoTabVisible();
  const showPanel = hasSelection && (markingMode === 'panel' || (markingMode === 'hybrid' && infoVisible));
  const showBar = hasSelection && (markingMode === 'floating' || (markingMode === 'hybrid' && !infoVisible));
  markingPanel.hidden = !showPanel;
  markingBar.hidden = !showBar;
  document.getElementById('grid-view').classList.toggle('has-marking-bar', showBar);
  if (!showBar) { closeMarkingColorPopover(); closeMarkingPickPopover(); }
  if (hasSelection) updateColorAction();
}
// Le panneau Info et ses onglets changent sans passer par la sélection : on suit leurs attributs.
new MutationObserver(updateMarkingPlacement).observe(document.getElementById('exif-panel'), { attributes: true, attributeFilter: ['class'] });
new MutationObserver(updateMarkingPlacement).observe(document.getElementById('exif-tab-info'), { attributes: true, attributeFilter: ['hidden'] });

const markingPlacementSelect = document.getElementById('marking-placement');
markingPlacementSelect.value = markingMode;
markingPlacementSelect.addEventListener('change', event => {
  markingMode = MARKING_MODES.includes(event.target.value) ? event.target.value : 'hybrid';
  localStorage.setItem('markingPlacement', markingMode);
  updateMarkingPlacement();
});
// Settings > Metadata > Keywords: include/exclude children by default when picking a parent keyword in the filter.
let keywordFilterIncludeChildren = readBool('keywordFilterIncludeChildren');
const keywordFilterChildrenDefaultToggle = document.getElementById('keyword-filter-children-default');
if (keywordFilterChildrenDefaultToggle) {
  keywordFilterChildrenDefaultToggle.checked = keywordFilterIncludeChildren;
  keywordFilterChildrenDefaultToggle.addEventListener('change', () => {
    keywordFilterIncludeChildren = keywordFilterChildrenDefaultToggle.checked;
    localStorage.setItem('keywordFilterIncludeChildren', String(keywordFilterIncludeChildren));
  });
}
// Keyword filter field: suggestion list; Shift includes children (~); Ctrl forces keyword alone (ignoring the Metadata setting); Alt excludes.
// With no suggestion, Enter takes the typed text as is (a keyword missing from the loaded photos can still be filtered on).
keywordFilterSuggest = createFilterSuggest({
  input: document.getElementById('keyword-filter-input'),
  list: document.getElementById('keyword-filter-suggestions'),
  acceptCtrl: true,
  getOptions: () => keywordFilterOptions.filter(option => !isHiddenKeyword(option.value) && !keywordFilters.includes(option.value) && !excludedKeywordFilters.includes(option.value)),
  onPick: (value, exclude, text, shift, ctrl) => {
    const picked = (value ?? text).trim();
    const includeChildren = ctrl ? false : shift || (keywordFilterIncludeChildren && keywordHasChildrenKeys.has(keywordKey(picked)));
    addKeywordFilter(picked, exclude, includeChildren);
  },
  emptyText: 'No matching keyword',
});
document.getElementById('filename-filter-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); addFilenameFilter(event.target.value, event.altKey); }
});
document.getElementById('recursive-folder-toggle').checked = includeSubfolders;
document.getElementById('recursive-folder-toggle').addEventListener('change', event => {
  const wanted = event.target.checked;
  abandonRawSearch(); // la recherche du RAW impose les sous-dossiers : changer l'option la termine
  abandonSemanticSearch(); // the scope of a "view" search would no longer match what is shown
  includeSubfolders = wanted;
  currentPhotoPage = 0; // the scope changed: first page
  event.target.checked = wanted;
  localStorage.setItem('includeSubfolders', String(includeSubfolders));
  renderFolderTree({ fromCounts: true });
  loadPhotos({ catalogChanged: false });
});
// Reloads photos after a rescan. The folder tree is built from the full collection list: when filtered on a folder, reread it too so newly discovered subfolders appear.
async function reloadPhotosAfterRescan() {
  if (currentFolderFilter !== null) {
    folderTreePhotos = await queryPhotoPage(null);
  }
  await loadPhotos();
  refreshDiskFoldersIfShown();
}

// After a pause, the photos read so far are added to the grid without the full reload (same in-place refresh as library sync).
async function refreshAfterPausedScan() {
  if (getSelectedAlbum() || isDuplicateSearchActive() || isSemanticSearchActive()) return;
  await refreshLibraryAfterSync({ added: [], updated: [], removed: [] });
}

// Folder tree, counts, empty folders, quick search, fold state and sticky folders: see folder-tree.js.
initFolderTree({
  getFolders: () => folders,
  getCurrentFolderFilter: () => currentFolderFilter,
  setCurrentFolderFilter: path => { currentFolderFilter = path; },
  getExtraFolderFilters: () => extraFolderFilters,
  setExtraFolderFilters: list => { extraFolderFilters = list; },
  getIncludeSubfolders: () => includeSubfolders,
  setCurrentPhotoPage: page => { currentPhotoPage = page; },
  getFolderTreePhotos: () => folderTreePhotos,
  getLoadedPhotos: () => loadedPhotos,
  getPhotos: () => photos,
  getSelectedIndices: () => selectedIndices,
  loadPhotos: options => loadPhotos(options),
  abandonRawSearch: () => abandonRawSearch(),
  abandonDuplicateSearch: () => abandonDuplicateSearch(),
  abandonSemanticSearch: () => abandonSemanticSearch(),
  syncSmartAlbumWithSelection: () => syncSmartAlbumWithSelection(),
  isDuplicateSearchActive: () => isDuplicateSearchActive(),
  isRawSearchActive: () => isRawSearchActive(),
  isSemanticSearchActive: () => isSemanticSearchActive(),
});

// Task queue (see task-queue.js): sequential main lane, parallel semantic lane, toasts, tasks modal, pause/resume and backend progress events.
initTaskQueue({
  showToast: message => showWriteToast(message),
  onIntegrityResult: (result, stopped) => showIntegrityReport(result, stopped),
  onRescanComplete: () => reloadPhotosAfterRescan(),
  onPausedScan: () => refreshAfterPausedScan(),
  onMainQueueIdle: () => { if (syncAfterTasks && foregroundTaskCount() === 0) runRequestedSync(); },
  onShowReadyTask: task => showReadyDuplicateResults(task),
  getTrackedFolders: () => folders,
});

// Duplicate search results mode (banner, group ranking, cleanup selection, tasks): see duplicates-view.js.
initDuplicatesView({
  getPhotos: () => photos,
  getLoadedPhotos: () => loadedPhotos,
  getSelectedIndices: () => selectedIndices,
  getLastSelectedIndex: () => lastSelectedIndex,
  setLastSelectedIndex: index => { lastSelectedIndex = index; },
  clearFullscreenImageCache: () => clearFullscreenImageCache(),
  applyPhotoFilters: options => applyPhotoFilters(options),
  renderVisibleItems: () => renderVisibleItems(),
  updateUIOnSelection: () => updateUIOnSelection(),
  scrollToPhotoIndex: index => scrollToPhotoIndex(index),
  showToast: message => showWriteToast(message),
  setIncludeSubfoldersTemporarily: value => setIncludeSubfoldersTemporarily(value),
  resetAllFilters: () => resetAllFilters(),
  applyFilterState: state => applyFilterState(state),
  captureViewSnapshot: album => captureViewSnapshot(album),
  restoreViewSnapshot: snapshot => restoreViewSnapshot(snapshot),
  getOtherSearchSnapshot: () => getRawSearch()?.snapshot ?? getSemanticSearch()?.snapshot,
  abandonOtherSearches: () => { abandonSemanticSearch(); abandonRawSearch(); },
  isFullscreen: () => isFullscreenOpen(),
  closeFullscreen: () => closeFullscreen(),
  syncSmartAlbumWithSelection: () => syncSmartAlbumWithSelection(),
  clearFolderFilter: () => { currentFolderFilter = null; extraFolderFilters = []; },
  renderFolderTree: () => renderFolderTree({ fromCounts: true }),
  loadPhotos: () => loadPhotos({ catalogChanged: false }),
  normalizeFilterPath: path => normalizeFilterPath(path),
  enqueueTask: task => enqueueScanTask(task),
  keepTaskReady: (task, payload, options) => keepTaskReady(task, payload, options),
  removeReadyTask: task => removeReadyTask(task),
  closeTasksModal: () => closeTasksModal(),
});

// Fullscreen viewer, off-screen decoding, preloading, info overlay and marking bar: see fullscreen.js.
initFullscreen({
  getPhotos: () => photos,
  getSelectedIndices: () => selectedIndices,
  getLastSelectedIndex: () => lastSelectedIndex,
  setLastSelectedIndex: index => { lastSelectedIndex = index; },
  updateUIOnSelection: () => updateUIOnSelection(),
  getPhotoDisplayUrl: photo => getPhotoDisplayUrl(photo),
  lookupCachedThumbnail: path => lookupCachedThumbnail(path),
  versionSuffix: path => versionSuffix(path),
  checkPhotoMissing: path => checkPhotoMissing(path),
  navigateToPhotoIndex: index => navigateToPhotoIndex(index),
  setSelectionRating: rating => setSelectionRating(rating),
  formatShutterSpeed: speed => formatShutterSpeed(speed),
  showToast: message => showWriteToast(message),
  createMarkingColors: () => createMarkingColors(),
  createMarkingPick: () => createMarkingPick(),
});

// Preview zoom, pan, compare mode, sub-selection and instant zoom (hold Z): see preview-zoom.js.
initPreviewZoom({
  getPhotos: () => photos,
  getSelectedIndices: () => selectedIndices,
  setSelectedIndices: next => { selectedIndices = next; },
  getLastSelectedIndex: () => lastSelectedIndex,
  isFullscreen: () => isFullscreenOpen(),
  getFullscreenSlot: () => getFullscreenSlot(),
  layoutFullscreenSlot: () => layoutFullscreenSlot(),
  layoutPreviewFaces: slot => layoutPreviewFaces(slot),
  getPhotoDisplayUrl: photo => getPhotoDisplayUrl(photo),
  checkPhotoMissing: path => checkPhotoMissing(path),
  markFormatPlaceholder: (element, path) => markFormatPlaceholder(element, path),
  createVideoPlayBadge: () => createVideoPlayBadge(),
  showToast: message => showWriteToast(message),
  onSubSelectionChange: () => { updateRatingAction(); updateColorAction(); },
  onCompareModeChange: active => setKeywordsCompareMode(active),
  updateVirtualScroller: () => updateVirtualScroller(),
  updateUIOnSelection: () => updateUIOnSelection(),
});

// Grid drag-scroll (with inertia) and photo drag-and-drop to the folder tree, manual albums and map: see drag-drop.js.
initDragDrop({
  getPhotos: () => photos,
  getSelectedIndices: () => selectedIndices,
  selectOnly: index => {
    selectedIndices.clear();
    selectedIndices.add(index);
    lastSelectedIndex = index;
    updateUIOnSelection();
  },
  getThumbnailImage: index => renderedThumbnailNodes.get(index)?._thumbnailImage ?? null,
  showToast: showWriteToast,
  enqueueTask: task => enqueueScanTask(task),
  applyMovedPhotos: moved => applyMovedPhotos(moved),
  syncAfterCopy: async () => {
    const changes = await invoke('sync_library', { excluded: pausedScanFolders() });
    notifyTempLeftovers(changes);
    if (changes.added.length || changes.updated.length || changes.removed.length) await refreshLibraryAfterSync(changes);
  },
});

// ==========================================
// FILE AND FOLDER OPERATIONS (delete, rename, path updates)
// ==========================================
let photoMoveRunning = false;

// Met à jour l'interface après la suppression d'un dossier (voir delete_folder) : photos retirées de la vue sans recharger la bibliothèque, dossiers
// vides créés pendant la session oubliés. Si le dossier affiché est concerné, on revient à son dossier parent.
function applyDeletedFolder(deletedPath, removedPaths) {
  const normalize = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const deleted = normalize(deletedPath);
  const isInside = value => normalize(value) === deleted || normalize(value).startsWith(`${deleted}/`);
  forgetDeletedFolder(deletedPath);
  const viewAffected = currentFolderFilter !== null && isInside(currentFolderFilter);
  extraFolderFilters = extraFolderFilters.filter(folder => !isInside(folder));
  removePhotosFromLibrary(removedPaths);
  renderFolderTree();
  // Le dossier supprimé n'est jamais un dossier suivi : son parent l'est, ou en fait partie.
  if (viewAffected) selectFolder(deletedPath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, ''));
}

// Dossier de l'arborescence vers la corbeille, ou supprimé définitivement quand son support n'en a pas (`permanent`, détecté avant la confirmation par
// photo-actions.js, qui a aussi demandé la confirmation). Le même indicateur que le déplacement suspend la synchronisation automatique pendant l'opération.
async function deleteFolderToTrash(path, { permanent = false } = {}) {
  if (photoMoveRunning || hasFileTask()) return;
  if (isWriteLocked()) { showWriteToast(t('Metadata writing in progress…')); return; }
  // Hidden photos would be deleted unseen with their folder (the backend refuses too, privacy.rs).
  if (hasActivePrivacy()) { showWriteToast(t('Folders cannot be deleted while a privacy set is active')); return; }
  photoMoveRunning = true;
  showWriteToast(t(permanent ? 'Deleting folder…' : 'Moving folder to the trash…'), true);
  try {
    const removedPaths = await invoke('delete_folder', { path });
    applyDeletedFolder(path, removedPaths);
    showWriteToast(t(permanent ? 'Folder deleted' : 'Folder moved to the trash'));
  } catch (error) {
    showWriteToast(t('Folder deletion failed: {error}', { error }));
    refreshDiskFoldersIfShown(); // le dossier a peut-être disparu du disque : l'arbre est resynchronisé
  } finally {
    photoMoveRunning = false;
  }
}

// Renommage d'une photo (rename_photo) : même mise à jour de l'interface qu'un déplacement (chemin et nom changent, la sélection est retrouvée par chemin).
// Renvoie un message d'erreur à afficher dans la fenêtre de saisie, ou null. Refusé pendant un déplacement ou une tâche de fichiers : la synchronisation
// automatique est suspendue par le même indicateur, sinon elle verrait le fichier disparaître sous son ancien nom.
async function renamePhotoOnDisk(photo, newName) {
  if (photoMoveRunning || hasFileTask()) return t('Wait for the running file task to finish.');
  // Écriture de métadonnées en cours : elle remplacerait le fichier sous son ancien nom (ou échouerait).
  if (isWriteLocked()) return t('Metadata writing in progress…');
  photoMoveRunning = true;
  try {
    const moved = await invoke('rename_photo', { path: photo.path, newName });
    let undoEntry = null;
    if (moved.from !== moved.to) {
      await applyMovedPhotos([moved]);
      const meta = {
        kind: 'rename',
        single: true,
        count: 1,
        itemKind: itemKindForPaths([moved.to]),
        sampleFrom: baseName(moved.from),
        sampleTo: baseName(moved.to),
      };
      undoEntry = pushUndo('common', {
        meta,
        canRun: () => {
          if (photoMoveRunning || hasFileTask()) { showWriteToast(t('Wait for the running file task to finish.')); return false; }
          if (isWriteLocked()) { showWriteToast(t('Metadata writing in progress…')); return false; }
          return true;
        },
        run: () => undoSingleRename(moved, meta),
      });
    }
    showWriteToast(t('File renamed'), false, undoEntry ? undoToastActions('common', undoEntry) : null);
    return null;
  } catch (error) {
    return String(error);
  } finally {
    photoMoveRunning = false;
  }
}

// Reverts a single-file rename pushed onto the common undo stack.
async function undoSingleRename(moved, meta) {
  photoMoveRunning = true;
  try {
    const reverted = await invoke('rename_photo', { path: moved.to, newName: splitFileName(baseName(moved.from)).stem });
    if (reverted.from !== reverted.to) await applyMovedPhotos([reverted]);
    showWriteToast(formatUndoToast(meta), false, hasUndo('common') ? historyToastAction() : null);
  } catch (error) {
    showWriteToast(t('Rename failed: {error}', { error }));
  } finally {
    photoMoveRunning = false;
  }
}

// Renommage d'un dossier de l'arborescence (rename_folder) : chemins des photos, dossiers créés ou dépliés, et dossier affiché suivent le nouveau nom.
async function renameFolderOnDisk(path, newName) {
  if (photoMoveRunning || hasFileTask()) return t('Wait for the running file task to finish.');
  if (isWriteLocked()) return t('Metadata writing in progress…');
  photoMoveRunning = true;
  try {
    const moved = await invoke('rename_folder', { path, newName });
    const oldBase = path.replace(/[\\/]+$/, '');
    const newBase = `${oldBase.replace(/[\\/][^\\/]*$/, '')}/${newName.trim()}`;
    const normalize = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const old = normalize(oldBase);
    const isInside = value => normalize(value) === old || normalize(value).startsWith(`${old}/`);
    const follow = value => `${newBase}${value.replace(/\/+$/, '').slice(oldBase.length)}`;
    renameFolderInTree(oldBase, newBase);
    if (currentFolderFilter !== null && isInside(currentFolderFilter)) {
      currentFolderFilter = follow(currentFolderFilter);
      rememberCurrentFolder();
    }
    extraFolderFilters = extraFolderFilters.map(folder => (isInside(folder) ? follow(folder) : folder));
    if (moved.length) await applyMovedPhotos(moved);
    renderFolderTree();
    refreshDiskFoldersIfShown(); // relit le disque : un sous-dossier vide renommé garde la bonne casse
    showWriteToast(t('Folder renamed'));
    return null;
  } catch (error) {
    return String(error);
  } finally {
    photoMoveRunning = false;
  }
}

// Met à jour l'interface après un déplacement. Les photos gardent leur objet (le chemin et le nom changent) pour que la sélection soit retrouvée par
// chemin, puis la liste est relue depuis la base sans remonter la grille : une photo déplacée hors du dossier affiché en disparaît.
async function applyMovedPhotos(moved) {
  const destinations = new Map(moved.map(item => [item.from, item.to]));
  // A batch rename can chain or swap names (1 to 2 while 2 to 3): a photo object seen twice (it can be in both lists) is renamed only once.
  const renamedPhotos = new Set();
  const rename = list => {
    for (const photo of list) {
      const destination = destinations.get(photo.path);
      if (!destination || renamedPhotos.has(photo)) continue;
      renamedPhotos.add(photo);
      thumbnailCacheLookups.delete(photo.path);
      rawPreviewPromises.delete(photo.path);
      photo.path = destination;
      photo.filename = destination.split(/[\\/]/).pop() || photo.filename;
      delete photo.folderPath; // recalculés par photoFolder() pour le tri et les séparateurs
      delete photo.folderSegments;
    }
  };
  rename(loadedPhotos);
  if (folderTreePhotos !== loadedPhotos) rename(folderTreePhotos);
  photosMoved(destinations); // modifications en attente (mots-clés, description) : elles visent le nouveau chemin
  invalidatePreview(); // force preview reload
  clearFullscreenImageCache();
  await refreshLibraryAfterSync({ added: [], updated: [], removed: [] });
}

// ==========================================
// FILTRE LIEU : toutes les photos, seulement les géolocalisées, ou seulement les autres
// ==========================================
let locationFilter = 'all'; // 'all', 'geolocated' ou 'not-geolocated'
const locationFilterOptions = [...document.querySelectorAll('#location-filter .location-filter-option')];

function matchesLocationFilter(photo) {
  if (locationFilter === 'all') return true;
  const located = Number.isFinite(photo.gps_lat) && Number.isFinite(photo.gps_lon);
  return locationFilter === 'geolocated' ? located : !located;
}

function setLocationFilter(value, { apply = true } = {}) {
  locationFilter = ['geolocated', 'not-geolocated'].includes(value) ? value : 'all';
  for (const option of locationFilterOptions) option.setAttribute('aria-checked', String(option.dataset.value === locationFilter));
  if (apply) applyPhotoFilters();
}
for (const option of locationFilterOptions) option.addEventListener('click', () => setLocationFilter(option.dataset.value));
setLocationFilter('all', { apply: false });

// ==========================================
// CONTENT ANALYSIS FILTER: photos analysed by the content search, or not yet (never saved in smart albums)
// ==========================================
let analysisFilter = 'all'; // 'all', 'analysed' or 'not-analysed'
let analysedIds = new Set(); // ids with an up-to-date analysis, read from the backend while the filter is active
let analysedIdsToken = 0;
const analysisFilterOptions = [...document.querySelectorAll('#analysis-filter .location-filter-option')];

// With the feature off the filter is ignored (its controls are hidden and the filter is reset by onSemanticChange).
function matchesAnalysisFilter(photo) {
  if (analysisFilter === 'all' || !isSemanticEnabled()) return true;
  return analysedIds.has(photo.id) === (analysisFilter === 'analysed');
}

async function refreshAnalysedIds() {
  if (analysisFilter === 'all' || !isSemanticEnabled()) return;
  const token = ++analysedIdsToken;
  try {
    const ids = await invoke('get_analysed_photo_ids');
    if (token === analysedIdsToken) analysedIds = new Set(ids);
  } catch (error) {
    console.error('Analysed photos unreadable', error);
    if (token === analysedIdsToken) analysedIds = new Set();
  }
}

async function setAnalysisFilter(value, { apply = true } = {}) {
  analysisFilter = ['analysed', 'not-analysed'].includes(value) ? value : 'all';
  for (const option of analysisFilterOptions) option.setAttribute('aria-checked', String(option.dataset.value === analysisFilter));
  if (!apply) return;
  await refreshAnalysedIds(); // the ids are known before the list is filtered
  applyPhotoFilters();
}
for (const option of analysisFilterOptions) option.addEventListener('click', () => setAnalysisFilter(option.dataset.value));
setAnalysisFilter('all', { apply: false });

// An analysis ended or the data was deleted: the filter follows. The feature went off: the filter is reset.
onAnalysisChanged(async () => {
  if (analysisFilter === 'all') return;
  await refreshAnalysedIds();
  applyPhotoFilters({ keepState: true });
});
onSemanticChange(() => { if (analysisFilter !== 'all' && !isSemanticEnabled()) setAnalysisFilter('all'); });

// ==========================================
// FILTRE DE DATE (date de prise de vue EXIF)
// ==========================================
// Field, calendar and date-key helpers (photoTimeKey, parseDateFilter…): see date-filter.js.
initDateFilter({ applyPhotoFilters, getPhotos: () => loadedPhotos });

// ==========================================
// MENU CONTEXTUEL DES MINIATURES (voir photo-actions.js)
// ==========================================
// Retire de l'affichage les photos dont le fichier vient d'être supprimé, sans recharger la bibliothèque ni remonter la grille.
// En mode comparaison (ou sélection multiple), les autres photos sélectionnées non supprimées sont conservées.
function removePhotosFromLibrary(paths, { keepSelection = false } = {}) {
  const removed = new Set(paths);
  if (removed.size === 0) return;
  const firstRemovedIndex = photos.findIndex(photo => removed.has(photo.path));

  // Conserve les autres photos sélectionnées qui n'ont pas été supprimées
  const remainingSelectedPaths = [...selectedIndices]
    .map(index => photos[index]?.path)
    .filter(path => path && !removed.has(path));
  const keptLastPath = !removed.has(photos[lastSelectedIndex]?.path) ? photos[lastSelectedIndex]?.path : null;

  for (const path of removed) thumbnailCacheLookups.delete(path);
  photosRemoved(removed); // modifications en attente de ces photos (mots-clés, description) abandonnées : elles n'ont plus de fichier
  const treeSharesLibrary = folderTreePhotos === loadedPhotos;
  loadedPhotos = loadedPhotos.filter(photo => !removed.has(photo.path));
  folderTreePhotos = treeSharesLibrary ? loadedPhotos : folderTreePhotos.filter(photo => !removed.has(photo.path));
  clearFullscreenImageCache();
  renderFolderTree();
  renderKeywordFilters({ force: true });

  if (loadedPhotos.length === 0) {
    applyPhotoFilters(); // plus aucune photo : même traitement que des filtres sans résultat
    return;
  }

  photos = photos.filter(photo => !removed.has(photo.path));
  updateFilteredPhotosCount();

  for (const node of renderedThumbnailNodes.values()) node.remove();
  renderedThumbnailNodes.clear();
  selectedIndices.clear();

  // Si d'autres photos faisaient partie de la sélection (ex. comparaison de 4 photos dont une est supprimée),
  // on conserve les survivantes pour continuer la comparaison !
  if (remainingSelectedPaths.length > 0) {
    const indexByPath = new Map(photos.map((photo, index) => [photo.path, index]));
    for (const path of remainingSelectedPaths) {
      if (indexByPath.has(path)) selectedIndices.add(indexByPath.get(path));
    }
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
    refreshListView({ dataChanged: true });
  } else {
    renderPreview();
    clearFullscreenImage();
    updateRatingAction();
    refreshListView({ dataChanged: true });
  }
}

// Batch rename (batch-rename.js): access to the grid and to the file operations.
initBatchRename({
  getPhotos: () => photos,
  getReferencePhoto: () => photos[lastSelectedIndex],
  showToast: showWriteToast,
  enqueueTask: task => enqueueScanTask(task),
  applyMoved: applyMovedPhotos,
  isBusy: () => photoMoveRunning || hasFileTask(),
  setBusy: busy => { photoMoveRunning = busy; },
  pushUndo: entry => pushUndo('common', entry),
  undoToastActions: entry => undoToastActions('common', entry),
  historyToastAction,
  hasUndo: () => hasUndo('common'),
  keepTaskReady,
});

initPhotoActions({
  // "Collapse all" / "Expand to the selected photo" entries, shared by the Folders title menu and the "All photos" menu (photo-actions.js).
  foldersMenuItems,
  // "Turn" submenu (lossless rotation, see rotatePhotos): only the HEIC / HEIF and videos of the targets are left out.
  isRotatablePath,
  rotatePhotos: (targets, quarterTurns) => rotatePhotos(quarterTurns, targets),
  // Album manuel affiché (nom pour le menu) et retrait de photos de cet album (albums-panel.js).
  getCurrentManualAlbum: () => { const album = getSelectedAlbum(); return album?.kind === 'manual' ? album : null; },
  removeFromAlbum: targets => removePhotosFromSelectedAlbum(targets.map(photo => photo.id)),
  // « Trouver le RAW » (voir la section du même nom) : disponible tant qu'au moins un critère est coché dans les Paramètres.
  findRaw: findRawFor,
  canFindRaw: hasRawSearchCriteria,
  isRawSearchActive: () => isRawSearchActive() || isDuplicateSearchActive() || isSemanticSearchActive(), // results views, where "Show in its folder" is offered
  findDuplicates: findDuplicateImages,
  openDuplicatesDialog,
  showInItsFolder: showPhotoInItsFolder,
  isAllPhotosView, // "Show in its own folder" in the menu of one photo of "All photos"
  getPhotos: () => photos,
  getRootFolders: () => folders,
  getSelectedIndices: () => selectedIndices,
  getActiveIndex: () => lastSelectedIndex,
  selectOnly: index => {
    selectedIndices.clear();
    selectedIndices.add(index);
    lastSelectedIndex = index;
    updateUIOnSelection();
  },
  removePhotos: removePhotosFromLibrary,
  showToast: showWriteToast,
  rescanFolder,
  checkFolderIntegrity,
  folderCreated: addCreatedFolder,
  syncLibrary: () => requestLibrarySync(), // nouveaux fichiers créés par l'application (redimensionnement)
  enqueueFileTask: task => enqueueScanTask(task), // copie vers un dossier choisi, redimensionnement : tâches de la file (voir enqueueScanTask)
  deleteFolder: deleteFolderToTrash,
  // Folder menu header: number of photos (subfolders included if the option is checked), from the whole-catalogue counts
  // (the loaded photo list is capped and would undercount older folders). Unknown until the first counts read: no number.
  folderPhotoCount: getFolderPhotoCount,
  // Sous-menu « Visages » d'une photo affichée (aperçu, plein écran) : ajouter un visage, modes des zones, zones écartées
  faces: { getDisplay: getFaceDisplay, setMode: setFaceDisplayMode, setExtra: setFaceDisplayExtra, startDrawing: armFaceDrawing },
  // Sous-menu « Marquage » du menu des photos : note, couleur et fanion pick posés sur les photos du clic droit (pas sur la sélection)
  marking: {
    colors: () => (isColorEnabled() ? COLOR_FLAGS : []),
    picks: () => (isPickEnabled() ? (PICK_CHOICES[topPickFormat()] ?? PICK_CHOICES.digikam).map(key => PICK_FLAGS.find(flag => flag.key === key)) : []),
    setRating: (photos, rating) => setSelectionRating(rating, photos),
    setColor: (photos, flag) => setSelectionColorFlag(flag, photos),
    setPick: (photos, flag) => setSelectionPickFlag(flag, { toggle: false, photos }),
  },
  renamePhoto: renamePhotoOnDisk,
  batchRename: targets => openBatchRename(targets),
  renameFolder: renameFolderOnDisk,
  // Sous-menu « Visages » (voir faces-panel.js) : affiché quand la détection est activée, il ouvre la fenêtre de lancement d'un scan.
  faceDetectionEnabled: isFaceDetectionEnabled,
  openFaceScan: scope => openFaceScanDialog(scope),
  eraseFaces: photoIds => eraseFaceData(photoIds),
  // Entrées « Analyser le contenu » (voir semantic-settings.js) : seulement quand la recherche par contenu est active et son modèle installé.
  semanticEnabled: isSemanticEnabled,
  analyseContent: scope => analyseContent(scope),
  // Ids with an up-to-date analysis (context menu: hides "Analyse content" when nothing is left to analyse); empty set on error.
  getAnalysedIds: async () => {
    try { return new Set(await invoke('get_analysed_photo_ids')); } catch { return new Set(); }
  },
  findSimilarContent: photo => findSimilarContent(photo),
  // Photo shown only because the content analysis suggests it for the keyword filter ("Suggested" badge): accept / dismiss entries.
  guessedKeywordEntries: photo => guessedKeywordEntries(keywordGuesses.get(photo.id) ?? [], photo.id),
  // Géolocalisation : effacer (danger) ou restaurer les coordonnées sauvegardées (voir geo-tools.js).
  eraseGeolocation: targets => eraseGeolocation(targets),
  restoreGeolocation: targets => restoreGeolocation(targets),
  hasErasedLocation,
});

// Paramètres, onglet Métadonnées : écriture par ExifTool ou interne (voir metadata-settings.js).
initMetadataSettings();
initDuplicatesModal(); // window "Find duplicates > More…"
initToolbarAria(); // aria-pressed on the toolbar toggle buttons
// Photos privées (privacy.js) : bouclier du panneau Filtres et réglages. À chaque changement d'ensemble actif, le backend est déjà à jour : on relit la grille
// (et les personnes), l'arborescence, les dossiers vides et les albums.
initPrivacy();
onPrivacyChange(async () => {
  await loadPhotos();
  scheduleFolderCounts();
  refreshDiskFoldersIfShown();
  refreshAlbums();
});
initRawSettings(); // Settings > Search > RAW search: criteria of "Find the RAW"
initLocationPanel({ showToast: message => showWriteToast(message) });
// Albums virtuels : arbre du panneau de gauche (le contenu des albums s'affichera aux étapes suivantes).
initAlbumsPanel({
  showToast: (message, action) => showWriteToast(message, false, action),
  // Un album a été choisi, modifié ou supprimé : la grille recharge ce qu'il faut afficher (voir loadPhotos).
  onSelectionChange: () => { abandonRawSearch(); abandonDuplicateSearch(); abandonSemanticSearch(); syncSmartAlbumWithSelection(); currentPhotoPage = 0; updateActiveFolderRows(); loadPhotos({ catalogChanged: false }); },
  // L'arbre ou le contenu des albums a changé : compteurs à recalculer.
  onTreeChanged: () => scheduleAlbumCounts(),
  // Disquette, « Enregistrer les modifications » et « Enregistrer la vue actuelle dans cet album ».
  saveActiveAlbum: () => saveActiveSmartAlbum(),
  saveCurrentViewInto: albumId => saveCurrentViewInto(albumId),
  // Identifiants (catalogue) des photos sélectionnées dans la grille, pour « Ajouter la sélection à cet album ».
  getSelectedPhotoIds: () => [...selectedIndices].map(index => photos[index]?.id).filter(id => Number.isFinite(id)),
});
// Effacement / restauration de la géolocalisation : les coordonnées relues sont reportées sur les photos chargées (pastille, filtre Lieu, carte).
initGeoTools({
  showToast: (message, action) => showWriteToast(message, false, action),
  onPhotosUpdated: updates => {
    const byId = new Map(updates.map(update => [update.photo_id, update]));
    // New modification dates of the rewritten files or sidecars (all lists), for the sort by modification date.
    const reordered = applyEffectiveModified(updates.map(update => [update.photo_id, update.effective_modified]));
    for (const photo of loadedPhotos) {
      const update = byId.get(photo.id);
      if (update) Object.assign(photo, { gps_lat: update.gps_lat, gps_lon: update.gps_lon });
    }
    if (locationFilter !== 'all' || reordered) applyPhotoFilters({ keepState: true });
    else { renderVisibleItems(); updateUIOnSelection(); refreshListView({ dataChanged: true }); }
  },
});
// Zones privées de la carte : téléchargements dans la file des tâches (voir private-zones-modal.js).
initPrivateZonesModal({ enqueueTask: task => enqueueScanTask(task), showToast: message => showWriteToast(message) });

// Paramètres, onglet Métadonnées : utilisation des couleurs et des fanions pick (voir marking-settings.js). Une fonction désactivée voit ses filtres
// vidés (sinon ils masqueraient des photos sans qu'on puisse les voir) ; le CSS masque ses contrôles et indicateurs.
initMarkingSettings();
onMarkingSettingsChange(() => {
  let filtersCleared = false;
  if (!isColorEnabled() && colorFilters.size > 0) {
    colorFilters.clear();
    document.querySelectorAll('#color-filter-bar .color-square').forEach(button => setColorSquareChecked(button, false));
    filtersCleared = true;
  }
  if (!isPickEnabled() && pickFilters.size > 0) {
    pickFilters.clear();
    document.querySelectorAll('#pick-filter-bar .pick-square').forEach(button => setColorSquareChecked(button, false));
    filtersCleared = true;
  }
  if (filtersCleared) applyPhotoFilters({ keepState: true });
  updateColorAction();
});

// Écriture des métadonnées éditées dans le panneau de droite (onglets Mots-clés et Description, voir metadata-writes.js).
initMetadataWrites({
  showToast: message => showWriteToast(message),
  // Enqueues large metadata writes with progress and cancellation; `onResult` receives the command result (or null on failure/cancellation).
  enqueueKeywordTask: (command, args, count, onResult) => enqueueScanTask({
    kind: 'keywords',
    path: null,
    command,
    args,
    labelKey: 'Metadata writing ({count})',
    labelParams: { count },
    onResult,
  }),
  // Valeurs relues dans les fichiers écrits (mots-clés à plat, titre, description) : mises à jour dans les listes de photos, le filtre de
  // mots-clés et le panneau Info.
  updatePhotoMetadata: written => {
    const updates = new Map(written.map(entry => [entry.photo_id, entry]));
    // New modification dates of the rewritten files or sidecars (all lists): the sort by modification date puts these photos first.
    const reordered = applyEffectiveModified(written.map(entry => [entry.photo_id, entry.effective_modified]));
    const rewritten = new Set();
    for (const list of new Set([loadedPhotos, folderTreePhotos, photos])) {
      for (const photo of list) {
        const entry = updates.get(photo.id);
        if (!entry) continue;
        photo.keywords = entry.keywords;
        photo.title = entry.title;
        photo.caption = entry.description;
        photo.author = entry.author ?? photo.author; // auteur relu dans le fichier (filtre Auteur, panneau Info)
        if (Number.isFinite(entry.gps_lat) && Number.isFinite(entry.gps_lon)) { photo.gps_lat = entry.gps_lat; photo.gps_lon = entry.gps_lon; } // position écrite (mode Carte)
        rewritten.add(photo.path);
      }
    }
    forgetCachedImagePaths([...rewritten]);
    renderKeywordFilters({ force: true });
    if (reordered) applyPhotoFilters({ keepState: true });
    else { updateUIOnSelection(); refreshListView({ dataChanged: true }); }
  },
  // Indices (dans la liste affichée) de ces photos, ou null si l'une d'elles n'y figure plus.
  findIndicesByPhotoIds: ids => {
    const wanted = new Set(ids);
    const indices = [];
    photos.forEach((photo, index) => { if (wanted.has(photo.id)) indices.push(index); });
    return indices.length === wanted.size ? indices : null;
  },
  // Sélection précédente rétablie (« Annuler » à la question des modifications en attente) : la vue Visages, si elle est ouverte, revient aussi
  // aux visages de ces photos (sinon elle montrerait encore le visage cliqué, sur une autre photo).
  setSelectionIndices: indices => {
    selectedIndices = new Set(indices);
    lastSelectedIndex = indices[0] ?? 0;
    updateUIOnSelection();
    restoreFaceSelection(indices.map(index => photos[index]?.id).filter(id => id !== undefined));
  },
  // La vue des miniatures ne montre plus que ces fichiers (pastille « Fichiers en échec » pour revenir à la liste complète).
  showFailedFiles: paths => {
    pathFilter = new Set(paths);
    renderFilterTags();
    applyPhotoFilters();
  },
  // Lecture des visages activée : avant d'écrire des mots-clés, vérifier ceux des personnes encore présentes sur les photos (voir metadata-writes.js).
  faceReadingEnabled: () => document.getElementById('face-reading-toggle')?.checked === true,
  // Visages modifiés en base (ex. passés en inconnu avant une écriture) : section Personnes, calques et vue Visages relus.
  refreshFaces: () => refreshFaces(),
});

const getSelectedPhotos = () => [...selectedIndices].map(index => photos[index]).filter(Boolean);

// Onglet Mots-clés du panneau de droite (voir keywords-panel.js) : cible = photos sélectionnées.
initKeywordsPanel({
  getSelectedPhotos,
  showToast: message => showWriteToast(message),
  // Mot-clé supprimé qui était relié à des personnes : proposer de les supprimer aussi (voir faces-panel.js).
  onPersonsUnlinked: unlinked => proposeDeletePersons(unlinked),
  // Content search: "Find photos that may match" in the context menu of a keyword (see CONTENT SEARCH RESULTS).
  findKeywordCandidates: keyword => findKeywordCandidates(keyword),
  onTreeChanged: () => refreshKeywordFilterTree(),
});

// Onglet Description du panneau de droite (voir description-panel.js) : titre et description des photos sélectionnées.
initDescriptionPanel({ getSelectedPhotos, showToast: message => showWriteToast(message) });
// Section « Auteur » de l'onglet Info : un clic sur une valeur ouvre l'onglet Description.
initInfoAuthor({ openDescription: () => openSideTab('description'), refreshRows: () => refreshInfoRows() });
// Tooltip of the "Date taken" row: creation and modification dates of the file (read from the disk on hover).
initFileDates();

// Histogramme de la photo courante et écrêtage (voir histogram.js). Affiché en bas à droite du plein écran, sinon de l'aperçu (s'il est visible) ou de la grille ;
// jamais en mode Comparer, ni dans les vues Carte, Personnes et Visages. La surcouche d'écrêtage ne se pose que sur l'image de l'aperçu et du plein écran.
const mapPanelElement = document.getElementById('map-panel');
const listPanelElement = document.getElementById('list-panel');
const personsViewElement = document.getElementById('persons-view');
const facesViewElement = document.getElementById('faces-view');
// Diaporama (slideshow.js) : le plein écran passe de photo en photo à intervalle réglé.
initSlideshow({
  getPhotos: () => photos,
  getSelectedIndices: () => selectedIndices,
  getCurrentIndex: () => lastSelectedIndex,
  isVideo: photo => isVideoPath(photo.path),
  isZoomed: () => getFullscreenSlot().zoom !== null,
  isFullscreen: () => isFullscreenOpen(),
  openFullscreen,
  goToIndex: navigateToPhotoIndex,
  showToast: message => showWriteToast(message),
});
initHistogram({
  // Éléments dont un redimensionnement ou un changement de classe / d'attribut hidden déplace ou masque l'histogramme.
  watch: [mainContent, gridContainer, previewStage, mapPanelElement, listPanelElement, personsViewElement, facesViewElement, document.getElementById('fullscreen-view'), document.getElementById('exif-panel')],
  getView: () => {
    const photo = selectedIndices.size > 0 ? photos[lastSelectedIndex] ?? null : null;
    const otherViewOpen = gridContainer.hidden || !mapPanelElement.hidden || !personsViewElement.hidden || !facesViewElement.hidden;
    const previewShown = !mainContent.classList.contains('preview-hidden');
    const fullscreen = isFullscreenOpen();
    const fullscreenSlot = getFullscreenSlot();
    const hidden = !fullscreen && (isCompareMode() || otherViewOpen);
    let overlays = [];
    if (fullscreen) overlays = fullscreenSlot.photo === photo ? [fullscreenSlot.clip] : []; // image du plein écran = photo courante
    else if (!hidden && previewShown) overlays = getPreviewSlots().filter(slot => slot.photo === photo).map(slot => slot.clip);
    return {
      photo, hidden, fullscreen, overlays,
      anchor: fullscreen ? null : previewShown ? previewStage : gridContainer,
      isRaw: Boolean(photo) && isRawPath(photo.path), // calcul sur l'aperçu JPEG intégré : avertissement dans l'encadré
    };
  },
  getThumbnailUrl: photo => thumbnailUrlFor(photo.path),
  getFallbackUrl: photo => getPhotoDisplayUrl(photo), // format dont le backend ne fait pas de miniature
  showToast: message => showWriteToast(message),
});

// Grille des photos masquée pendant que la vue Personnes ou la vue de gestion des visages l'occupe.
function setPhotoGridVisible(visible) {
  gridContainer.hidden = !visible;
  if (visible) {
    requestAnimationFrame(updateVirtualScroller);
    schedulePump(); // grid jobs that waited while the grid was hidden
  }
}

// URL d'affichage de la miniature d'une photo (vignettes des personnes et des visages) : cache d'abord, sinon génération côté Rust ;
// chaîne vide si le format n'est pas géré par le backend (pas de vignette).
async function thumbnailUrlFor(sourcePath, isWanted = () => true) {
  let cachedPath = await lookupCachedThumbnail(sourcePath);
  if (!cachedPath) {
    cachedPath = await new Promise(resolve => enqueueStandaloneThumbnailGeneration(isWanted, async () => {
      let generated = null;
      try {
        generated = (await invoke('generate_thumbnail', { sourcePath, maxSide: thumbnailCacheSize }))?.path ?? null;
      } catch (error) {
        console.debug('Thumbnail generation failed', sourcePath, error);
      }
      if (generated) thumbnailCacheLookups.set(sourcePath, Promise.resolve(generated));
      resolve(generated);
    }, () => resolve(null)));
  }
  return cachedPath ? convertFileSrc(cachedPath) + versionSuffix(sourcePath) : '';
}

// Visages (voir faces-panel.js) : section Personnes, filtre Personnes, zones en plein écran. Vignettes des personnes découpées dans les miniatures en cache.
initFacesPanel({
  getThumbnailUrl: thumbnailUrlFor,
  onFilterChange: options => applyPhotoFilters(options),
  getFullscreenSlot: () => getFullscreenSlot(),
  getPreviewSlotAt: event => previewSlotFromEvent(event),
  isFullscreen: () => isFullscreenOpen(),
  layoutPreview: () => layoutPreviewSlots(),
  showToast: (message, action) => showWriteToast(message, false, action),
  enqueueTask: task => enqueueScanTask(task),
  // Détection désactivée : les vues Personnes et de gestion se ferment.
  closeFacesView: () => { closeFacesView(); closePersonsView(); },
  onFacesChanged: () => { reloadFacesView(); reloadPersonsView(); onFacesDataChanged(); },
  // « Voir » (suppression d'une personne), double-clic dans la vue Personnes : vue de gestion sur les visages des photos affichées.
  openFacesManagement: () => { closePersonsView(); openFacesView(); },
  // Renommer une personne reliée : c'est son mot-clé qui est renommé, avec réécriture des fichiers qui le portent (même circuit que le panneau
  // Mots-clés). Renvoie un message d'erreur si le renommage n'est pas lancé, sinon null.
  renameKeyword: (keywordId, name, after) => renameKeywordById(keywordId, name, after),
});

// Recherche par contenu (voir semantic-settings.js) : réglage, gating et section des Paramètres.
initSemanticSettings({
  showToast: message => showWriteToast(message),
  enqueueTask: task => enqueueScanTask(task),
  stopTasks: () => stopSemanticTasks(), // disabling the feature: the analyses of the queue are stopped
});

// ==========================================
// CONTENT SEARCH RESULTS (semantic-results.js)
// ==========================================
initSemanticResults({
  getPhotos: () => photos,
  getLoadedPhotos: () => loadedPhotos,
  setLoadedPhotos: list => { loadedPhotos = list; },
  getSelectedPhotos: () => getSelectedPhotos(),
  clearFullscreenImageCache: () => clearFullscreenImageCache(),
  applyPhotoFilters: options => applyPhotoFilters(options),
  showToast: message => showWriteToast(message),
  setIncludeSubfoldersTemporarily: value => setIncludeSubfoldersTemporarily(value),
  resetAllFilters: () => resetAllFilters(),
  applyFilterState: state => applyFilterState(state),
  captureViewSnapshot: album => captureViewSnapshot(album),
  restoreViewSnapshot: snapshot => restoreViewSnapshot(snapshot),
  getOtherSearchSnapshot: () => getRawSearch()?.snapshot ?? getDuplicateSearch()?.snapshot,
  abandonOtherSearches: () => { abandonDuplicateSearch(); abandonRawSearch(); },
  isFullscreen: () => isFullscreenOpen(),
  closeFullscreen: () => closeFullscreen(),
  syncSmartAlbumWithSelection: () => syncSmartAlbumWithSelection(),
  setFolderFilter: folder => { currentFolderFilter = folder; extraFolderFilters = []; },
  renderFolderTree: () => renderFolderTree({ fromCounts: true }),
  loadPhotos: () => loadPhotos({ catalogChanged: false }),
  currentViewScope: () => currentViewScope(),
});

// ==========================================
// FIND THE RAW (find-raw-mode.js)
// ==========================================
initFindRawMode({
  getPhotos: () => photos,
  isFullscreen: () => isFullscreenOpen(),
  closeFullscreen: () => closeFullscreen(),
  captureViewSnapshot: album => captureViewSnapshot(album),
  restoreViewSnapshot: snapshot => restoreViewSnapshot(snapshot),
  setIncludeSubfoldersTemporarily: value => setIncludeSubfoldersTemporarily(value),
  resetAllFilters: () => resetAllFilters(),
  applyFilterState: state => applyFilterState(state),
  matchesFilterState: (photo, state) => matchesFilterState(photo, state),
  syncSmartAlbumWithSelection: () => syncSmartAlbumWithSelection(),
  normalizeFilterPath: path => normalizeFilterPath(path),
  setFolderFilter: folder => { currentFolderFilter = folder; extraFolderFilters = []; },
  resetPage: () => { currentPhotoPage = 0; },
  renderFolderTree: () => renderFolderTree({ fromCounts: true }),
  loadPhotos: () => loadPhotos({ catalogChanged: false }),
  showToast: message => showWriteToast(message),
  abandonDuplicateSearch: () => abandonDuplicateSearch(),
  getDuplicateSearch: () => getDuplicateSearch(),
  abandonSemanticSearch: () => abandonSemanticSearch(),
  getSemanticSearch: () => getSemanticSearch(),
});

// ==========================================
// FEATURE VIEWS & MODULE INITIALIZATION
// ==========================================
// Suggestions in the keyword filter (see semantic-keywords.js): a new answer filters the grid again, keeping selection and scroll.
initKeywordSuggestions({
  loadedIds: () => new Set(loadedPhotos.map(photo => photo.id)),
  onChange: () => { clearFullscreenImageCache(); applyPhotoFilters({ keepState: true }); },
  addKeyword: keywordId => addPendingKeyword(keywordId),
  showToast: message => showWriteToast(message),
});

// Vue Personnes (voir persons-view.js) : une vignette par personne, ouverte par le bouton « Visages » de la barre du haut.
initPersonsView({
  setPhotoGridVisible,
  closeFacesView: () => { closeFacesView(); closeMapModeNow(); closeListView(); }, // appelée à l'ouverture de la vue : une seule vue à la fois
  openFacesManagement: () => { closePersonsView(); openFacesView(); },
});
// Bouton « Visages » : ouvre la vue Personnes, ou ferme la vue (Personnes ou gestion) ouverte.
document.getElementById('btn-toggle-faces').addEventListener('click', async () => {
  if (isMapModeOpen() && !(await requestCloseMapMode())) return; // une seule vue à la fois ; positions en attente : question d'abord
  if (isPersonsViewOpen() || isFacesViewOpen()) {
    if (isFacesViewOpen() && !(await requestCloseFacesView())) return; // visages en attente d'écriture : question d'abord
    closePersonsView();
    closeFacesView();
    return;
  }
  closeListView();
  clearPersonSelection(); // vue ouverte par la barre d'outils : aucune personne choisie
  openPersonsView();
});

// Vue Visages (voir faces-grid.js) : visages des photos affichées, à la place de la grille des photos.
// Mode Carte (voir map-mode.js) : carte des photos affichées, positions de la sélection.
initMapMode({
  getPhotos: () => photos,
  getMapPhotos: () => mapCandidatePhotos,
  getSelection: () => ({ selection: [...selectedIndices].map(index => photos[index]).filter(Boolean), focus: photos[lastSelectedIndex] }),
  applyPhotoFilters: options => applyPhotoFilters(options),
  refreshThumbnails: () => renderVisibleItems(),
  showToast: message => showWriteToast(message),
  closePersonsView: () => closePersonsView(),
  closeFacesView: () => closeFacesView(),
  closeListView: () => closeListView(),
  requestCloseFacesView: () => requestCloseFacesView(),
  setMapLayout: open => { mainContent.classList.toggle('map-mode', open); requestAnimationFrame(updateVirtualScroller); },
  layoutPreview: () => requestAnimationFrame(layoutPreviewSlots),
});
// List panel (list-view.js): sortable virtual table synchronized with the thumbnail grid.
initListView({
  getPhotos: () => photos,
  getSelectedIndices: () => selectedIndices,
  getActiveIndex: () => lastSelectedIndex,
  canAddToSelection,
  showCompareLimitToast,
  commitSelection: activeIndex => { lastSelectedIndex = activeIndex; updateUIOnSelection(); },
  scrollGridToPhoto: index => scrollPhotoIntoView(index),
  openFullscreen: index => openFullscreen(index),
  closePersonsView: () => closePersonsView(),
  closeFacesView: () => closeFacesView(),
  requestCloseFacesView: () => requestCloseFacesView(),
  requestCloseMapMode: () => requestCloseMapMode(),
  setListLayout: open => { mainContent.classList.toggle('list-mode', open); requestAnimationFrame(updateVirtualScroller); },
  layoutPreview: () => requestAnimationFrame(layoutPreviewSlots),
  formatAperture,
  formatShutterSpeed,
  photoModifiedTime,
  isGridPagedOrCapped: () => photoPageCount > 1 || photoListCap !== null,
  isPriorityGridOrderActive: () => isDuplicateSearchActive() || isSemanticSearchActive(),
  applyListGridSort: () => { clearFullscreenImageCache(); applyPhotoFilters({ keepState: true }); scrollToPhotoIndex(lastSelectedIndex); },
  colorFlags: COLOR_FLAGS,
  colorFlagLabels,
  pickFlags: PICK_FLAGS,
});
document.getElementById('show-map-toggle').addEventListener('change', onMapModeAccessChanged);
initMapsSettings({ showToast: message => showWriteToast(message) }); // Paramètres > Cartes : style de la carte
initUpdateCheck({
  showToast: (message, action) => showWriteToast(message, false, action, 15000),
  enqueueTask: task => enqueueScanTask(task),
  // Avant de quitter pour installer : mêmes questions qu'à la fermeture de la fenêtre.
  canQuit: async () => (await confirmCloseWithRunningTasks()) && !(isSelectedAlbumDirty() && !(await confirmLeaveAlbum())) && (await confirmCloseWithPendingEdits()),
}); // Paramètres > Général > Internet : mises à jour

initFacesGrid({
  getDisplayedPhotoIds: () => photos.map(photo => photo.id),
  // Un dossier de l'arbre (ou d'un album) limite les photos affichées : sert au message de la vue Visages quand elle est vide.
  hasFolderSelected: () => currentFolderFilter !== null || albumFolder !== null,
  getThumbnailUrl: thumbnailUrlFor,
  // Sélection de visages : leurs photos deviennent exactement la sélection (panneaux Info, Mots-clés, Description), la photo du dernier visage
  // sélectionné étant la principale. Photos absentes de la grille (mode « Visages en attente ») : non sélectionnées, jamais l'ancienne sélection
  // à leur place (une modification de mots-clés irait sinon sur d'autres photos).
  selectPhotos: (photoIds, mainPhotoId) => {
    const wanted = new Set(photoIds);
    selectedIndices.clear();
    photos.forEach((photo, index) => { if (wanted.has(photo.id)) selectedIndices.add(index); });
    const mainIndex = photos.findIndex(photo => photo.id === mainPhotoId);
    lastSelectedIndex = selectedIndices.has(mainIndex) ? mainIndex : selectedIndices.values().next().value ?? 0;
    updateUIOnSelection();
  },
  // Double-clic sur un visage : sa photo en plein écran (elle doit faire partie des photos affichées).
  openPhotoFullscreen: photoId => {
    const index = photos.findIndex(photo => photo.id === photoId);
    if (index < 0) showWriteToast(t('This photo is not among the displayed photos'));
    else openFullscreen(index);
  },
  setPhotoGridVisible,
  // Bouton « Personnes » de la vue de gestion : visages en attente d'écriture, question d'abord (voir requestCloseFacesView).
  openPersonsView: async () => {
    if (!(await requestCloseFacesView())) return;
    openPersonsView();
  },
  closePersonsView: () => { closePersonsView(); closeMapModeNow(); closeListView(); }, // appelée à l'ouverture de la vue de gestion : une seule vue à la fois
  showToast: (message, action) => showWriteToast(message, false, action), // `action` : bouton « Annuler » des actions de révision
  getPersonRoot,
  isFullscreen: () => isFullscreenOpen(),
});

initUndo({
  isFacesViewOpen,
  isFullscreen: () => isFullscreenOpen(),
  showToast: (message, action) => showWriteToast(message, false, action),
  colorFlagLabels,
  pickFlags: PICK_FLAGS,
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
const notifiedTempLeftovers = new Set();

function notifyTempLeftovers(changes) {
  const items = changes?.temp_leftovers ?? [];
  if (!items.length) return;
  const hasNew = items.some(path => !notifiedTempLeftovers.has(path));
  for (const path of items) notifiedTempLeftovers.add(path);
  if (!hasNew) return;
  const count = changes.temp_leftovers_total || items.length;
  const logPath = changes.temp_leftovers_log;
  const message = logPath
    ? tp('{count} temporary item left by an interrupted operation (see log)', count)
    : tp('{count} temporary item left by an interrupted operation', count);
  const action = logPath
    ? { label: t('Show log'), onClick: () => invoke('reveal_in_file_manager', { path: logPath }).catch(err => showWriteToast(String(err))) }
    : { label: t('Show folder'), onClick: () => invoke('reveal_in_file_manager', { path: items[0] }).catch(err => showWriteToast(String(err))) };
  showWriteToast(message, false, action, 12000);
}

async function syncLibraryWithDisk() {
  if (librarySyncRunning || foregroundTaskCount() > 0 || photoMoveRunning || Date.now() < librarySyncNotBefore) return;
  librarySyncRunning = true;
  const startedAt = Date.now();
  try {
    const changes = await invoke('sync_library', { excluded: pausedScanFolders() });
    notifyTempLeftovers(changes);
    if (changes.added.length || changes.updated.length || changes.removed.length) await refreshLibraryAfterSync(changes);
  } catch (error) {
    console.debug('Disk synchronization failed', error);
  } finally {
    librarySyncNotBefore = Date.now() + Math.max(LIBRARY_SYNC_MIN_INTERVAL_MS, (Date.now() - startedAt) * 10);
    librarySyncRunning = false;
  }
  if (syncAfterTasks && foregroundTaskCount() === 0 && !photoMoveRunning) runRequestedSync();
}

// Library sync requested by the app itself for files it just created: runs with no minimum delay as soon as the queue is idle (see pumpScanQueue in task-queue.js).
let syncAfterTasks = false;
function requestLibrarySync() {
  syncAfterTasks = true;
  if (!librarySyncRunning && foregroundTaskCount() === 0 && !photoMoveRunning) return runRequestedSync();
  return Promise.resolve();
}
function runRequestedSync() {
  syncAfterTasks = false;
  librarySyncNotBefore = 0;
  return syncLibraryWithDisk();
}

// Recharge la liste depuis la base sans remonter la grille ni perdre la sélection (retrouvée par chemin).
async function refreshLibraryAfterSync(changes) {
  const folderAtStart = currentFolderFilter;
  const known = new Map(loadedPhotos.map(photo => [photo.path, photo]));
  const modified = new Set(changes.updated);
  // Same prefilter as the list on screen (large folder); the whole-catalogue list stays unfiltered (keyword suggestions, gear lists).
  const generation = photoLoadGeneration;
  const prefilter = loadedPrefilterKey ? JSON.parse(loadedPrefilterKey) : null;
  const [fresh, everything] = await Promise.all([
    queryFolderPhotos(folderAtStart, prefilter, photoPageOffset(currentPhotoPage)),
    folderAtStart === null && !prefilter ? null : queryPhotoPage(null),
  ]);
  const stale = () => folderAtStart !== currentFolderFilter || generation !== photoLoadGeneration;
  if (stale()) return; // dossier changé (ou liste relue) pendant le chargement : le rechargement normal fait foi
  const cap = fresh.capped && photoPageCount <= 1 ? { total: await countDisplayedPhotos(prefilter) } : null;
  if (stale()) return;
  photoListCap = cap;
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
    rawPreviewPromises.delete(path); // aperçu extrait (RAW, HEIC, vidéo) : relu, le fichier a changé
  }
  if (modified.size) {
    invalidatePreview(); // force preview reload
    clearFullscreenImageCache();
  }
  loadedPhotos = fresh;
  folderTreePhotos = everything ?? fresh;
  renderFolderTree();
  renderKeywordFilters({ force: true });
  invalidateKeywordTree();
  applyPhotoFilters({ keepState: true });
}

window.addEventListener('focus', () => { syncLibraryWithDisk(); });

// DEMARRAGE

function restorePanelsVisibility() {
  const sidebarVisible = readBool('sidebarVisible');
  const previewVisible = readBool('previewVisible');
  const exifVisible = readBool('exifVisible');

  // 1. Panneau latéral gauche
  sidebarPanel.classList.toggle('hidden', !sidebarVisible);
  document.getElementById('btn-toggle-sidebar')?.classList.toggle('active', sidebarVisible);
  if (sidebarVisible) {
    if (sidebarWidth > 0) sidebarPanel.style.width = `${sidebarWidth}px`;
  } else {
    sidebarPanel.style.removeProperty('width');
  }

  // 2. Panneau d'aperçu
  mainContent.classList.toggle('preview-hidden', !previewVisible);
  document.getElementById('btn-toggle-preview')?.classList.toggle('active', previewVisible);

  // 3. Panneau EXIF
  const exifPanel = document.getElementById('exif-panel');
  exifPanel?.classList.toggle('hidden', !exifVisible);
  document.getElementById('btn-toggle-exif')?.classList.toggle('active', exifVisible);
}

// Restauration de l'état des panneaux avant le chargement des photos
restorePanelsVisibility();

// Ouverture sur le dernier dossier de l'arbre (Paramètres > Général). Le dossier n'est repris que s'il figure encore dans l'arbre
// (dossier suivi, ou sous-dossier contenant des photos) ; sinon, ouverture sur Toutes les photos. L'arborescence se construit depuis
// toute la collection : elle est lue en plus de la liste du dossier, sinon l'arbre ne montrerait que ce dossier.
async function restoreStartupFolder() {
  await loadFolders();
  const lastFolder = localStorage.getItem('lastFolderFilter');
  if (startupView !== 'last' || !lastFolder) return;
  const normalize = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const target = normalize(lastFolder);
  const isRoot = folders.some(folder => target === normalize(folder.path));
  const watched = isRoot || folders.some(folder => target.startsWith(`${normalize(folder.path)}/`));
  if (!watched) return;
  const library = await queryPhotoPage(null);
  if (!isRoot && !library.some(photo => normalize(photo.path).startsWith(`${target}/`))) return; // dossier disparu
  folderTreePhotos = library;
  currentFolderFilter = lastFolder;
  // Dossiers parents dépliés pour que le dossier ouvert soit visible dans l'arbre.
  expandFolderAncestors(lastFolder);
}

refreshStorageLocationUI();
onLanguageChange(refreshStorageLocationUI); // « Par défaut » suit la langue (un chemin personnalisé reste tel quel)
restoreStartupFolder()
  .catch(error => console.error('Startup folder restore failed', error))
  .then(() => restorePausedTasks())
  .then(() => loadPhotos())
  .then(() => setTimeout(syncLibraryWithDisk, 2000)); // délai : laisse d'abord se charger les premières miniatures

// Choix de la vue au démarrage (Paramètres > Général)
document.querySelectorAll('input[name="startup-view"]').forEach(input => {
  input.checked = input.value === startupView;
  input.addEventListener('change', () => {
    if (!input.checked) return;
    startupView = input.value === 'last' ? 'last' : 'all';
    localStorage.setItem('startupView', startupView);
  });
});

// Mode hors ligne (Paramètres > Général) : le backend refuse tout téléchargement (modèle de visages) tant qu'il est actif.
const offlineModeToggle = document.getElementById('offline-mode-toggle');
offlineModeToggle.checked = readBool('offlineMode');
function sendInternetAllowed() {
  invoke('set_internet_allowed', { allowed: !offlineModeToggle.checked }).catch(error => console.error('Offline mode setting rejected', error));
}
sendInternetAllowed();
offlineModeToggle.addEventListener('change', () => {
  localStorage.setItem('offlineMode', String(offlineModeToggle.checked));
  sendInternetAllowed();
  onOfflineModeChanged();
  onSemanticOfflineChanged(); // content search model: Download greyed in offline mode
  onUpdateAccessChanged(); // mises à jour : cases grisées en mode hors ligne
  onMapAccessChanged();
  onMapModeAccessChanged();
  reloadAllMaps(); // tuiles déjà demandées (vides ou en filigrane) redemandées maintenant que l'accès change
});

// Vérification des déplacements entre disques (Paramètres > Stockage) : activée par défaut, choix mémorisé et transmis au backend.
const verifyMovesToggle = document.getElementById('verify-moves-toggle');
verifyMovesToggle.checked = readBool('verifyCrossDriveMoves');
function sendVerifyMoves() {
  invoke('set_verify_cross_drive_moves', { enabled: verifyMovesToggle.checked }).catch(error => console.error('Move verification setting rejected', error));
}
sendVerifyMoves();
verifyMovesToggle.addEventListener('change', () => {
  localStorage.setItem('verifyCrossDriveMoves', String(verifyMovesToggle.checked));
  sendVerifyMoves();
});

// ==========================================
// EMPLACEMENT DES DONNÉES ET DU CACHE
// ==========================================
async function refreshStorageLocationUI() {
  try {
    const info = await invoke('get_storage_location');
    const pathDisplay = document.getElementById('storage-path-display');
    const resetBtn = document.getElementById('btn-reset-storage');
    if (pathDisplay) {
      pathDisplay.textContent = info.current_path || t('Default');
      pathDisplay.title = info.current_path || '';
    }
    if (resetBtn) {
      resetBtn.classList.toggle('hidden', !info.is_custom);
    }
  } catch (error) {
    console.error("Storage location read failed", error);
    const pathDisplay = document.getElementById('storage-path-display');
    if (pathDisplay) pathDisplay.textContent = t('Default'); // emplacement illisible : état explicite plutôt qu'un champ vide
  }
}

document.getElementById('btn-change-storage')?.addEventListener('click', async () => {
  const selected = await open({
    directory: true,
    multiple: false,
    title: t('Choose data folder'),
  });
  if (!selected) return;

  showTaskToast(t('Moving data and cache…'), 50);
  try {
    await invoke('change_storage_location', { newPath: selected });
    await refreshStorageLocationUI();
    showWriteToast(t('Data location updated successfully'));
    loadPhotos();
  } catch (error) {
    console.error('Storage folder change failed', error);
    showWriteToast(t('Error moving data: {error}', { error: String(error) }));
  } finally {
    hideTaskToast();
  }
});

document.getElementById('btn-reset-storage')?.addEventListener('click', async () => {
  showTaskToast(t('Moving data and cache…'), 50);
  try {
    await invoke('change_storage_location', { newPath: null });
    await refreshStorageLocationUI();
    showWriteToast(t('Data location updated successfully'));
    loadPhotos();
  } catch (error) {
    console.error('Storage location reset failed', error);
    showWriteToast(t('Error moving data: {error}', { error: String(error) }));
  } finally {
    hideTaskToast();
  }
});
