import './styles.css';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { DEFAULTS, readBool, readChoice, readNumber, readStored } from './settings-defaults.js';
import { APP_FONTS, APP_FONT_IDS, fontStack } from './app-fonts.js';
import { LANGUAGES, getLanguage, setLanguage, applyTranslations, t, tp, labelWithColon, onLanguageChange, normalizeSearch } from './i18n.js';
import { initPhotoActions, showPhotoInfo, copyPhotosTo, copyPhotosToClipboard, resizePhotos, confirmAndDelete, renamePhoto, askCopyResolutions, sidecarRenameNotice, revealInFileManager, openWithFirstProgram, confirmDialog, openContextMenuAt, showIntegrityReport } from './photo-actions.js';
import { listen as listenToBackend } from '@tauri-apps/api/event';
import { initMetadataSettings, topPickFormat, onPickOrderChange } from './metadata-settings.js';
import { initSemanticSettings, onSemanticOfflineChanged, onSemanticChange, onAnalysisChanged, isSemanticEnabled, analyseContent, semanticErrorMessage } from './semantic-settings.js';
import { initSemanticSearch, searchText, searchImage, currentSearchScope, semanticScope } from './semantic.js';
import { fetchKeywordCandidates, rejectKeywordSuggestion } from './semantic-tagging.js';
import { initKeywordSuggestions, guessedKeywordEntries, syncKeywordSuggestions, suggestionFor, suggestionsLoaded, suggestedExtraPhotos, describeGuesses, setSuggestedCount } from './semantic-keywords.js';
import { initRawSettings, getRawSearchSettings, hasRawSearchCriteria, compileNamePattern } from './raw-settings.js';
import { folderOf, searchScope, buildRawSearchState, rawNameMatches } from './find-raw.js';
import { initMarkingSettings, isColorEnabled, isPickEnabled, onMarkingSettingsChange } from './marking-settings.js';
import { initMetadataWrites, confirmCloseWithPendingEdits, choiceDialog, runLocked, isWriteLocked, photosMoved, photosRemoved, keepFocusInModal, failureDetailsAction } from './metadata-writes.js';
import { initGuide } from './guide.js';
import { initKeywordsPanel, refreshKeywordsPanel, addPendingKeyword, invalidateKeywordTree, handleSideTabShortcut, focusSideTabField, setKeywordsCompareMode, renameKeywordById } from './keywords-panel.js';
import { initDescriptionPanel, refreshDescriptionPanel } from './description-panel.js';
import { initLocationPanel, refreshLocation, onMapAccessChanged } from './location-panel.js';
import { reloadAllMaps } from './map-view.js';
import { initMapsSettings } from './maps-settings.js';
import { initUpdateCheck, onUpdateAccessChanged } from './update-check.js';
import { initMapMode, getVisibleZone, isMapModeOpen, requestCloseMapMode, closeMapModeNow, refreshMapMode, passesMapFilter, mapPrefilter, hasPendingPosition, dragOverMap, dragLeaveMap, dropOnMap, onMapModeAccessChanged } from './map-mode.js';
import { initPrivateZonesModal } from './private-zones-modal.js';
import { initGeoTools, eraseGeolocation, restoreGeolocation, hasErasedLocation, hasGps } from './geo-tools.js';
import { createFilterTag, addIncludeExcludeMenu } from './filter-tags.js';
import { createFilterSuggest } from './filter-suggest.js';
import { initFacesPanel, refreshFaces, hasPersonFilters, personFilterMatches, clearPersonFilters, setPersonFilterIds, photoMatchesPersonIds, getPersonFilterIds, getExcludedPersonFilterIds, layoutFullscreenFaces, layoutPreviewFaces, toggleFaceRegions, getFaceDisplay, setFaceDisplayMode, setFaceDisplayExtra, armFaceDrawing, isFaceDetectionEnabled, openFaceScanDialog, getPersonRoot, eraseFaceData, proposeDeletePersons, clearPersonSelection, onOfflineModeChanged } from './faces-panel.js';
import { fillSortButton, initFacesGrid, isFacesViewOpen, hasFaceSelection, openFacesView, closeFacesView, requestCloseFacesView, reloadFacesView, restoreFaceSelection } from './faces-grid.js';
import { initAlbumsPanel, clearAlbumSelection, getSelectedAlbum, getAlbumContext, addPhotosToAlbum, movePhotosToAlbum, removePhotosFromSelectedAlbum, refreshAlbums, getAlbumNodes, isAlbumsSectionExpanded, setAlbumCount, setAlbumCounts, setAlbumDirty, isSelectedAlbumDirty, confirmLeaveAlbum, restoreAlbumSelection } from './albums-panel.js';
import { initPersonsView,isPersonsViewOpen, openPersonsView, closePersonsView, reloadPersonsView } from './persons-view.js';
import { initHistogram, syncHistogram, cycleHistogramState } from './histogram.js';
import { initShootingFilters, matchesShootingState, shootingPrefilter } from './shooting-filters.js';
import { initFormatFilters, matchesFormatState, formatPrefilterExtensions, RAW_EXTENSIONS, HEIF_EXTENSIONS, VIDEO_EXTENSIONS } from './format-filters.js';
import { GROUP_SORT_MODES, GROUP_SORT_LABELS, normalizeGroupSort, formatBytes, sortGroupMembers, orderGroups, firstPathOf, getSimilarSettings, similarRequestFields, getIdenticalSettings, mergeGroups, describeSearch, getKeepSettings, describeKeepOrder } from './duplicates.js';
import { openDuplicatesModal, toggleKeepPanel, closeKeepPanel, initDuplicatesModal } from './duplicates-modal.js';
import { findNameGroups } from './duplicate-names.js';
import { initSlideshow,startSlideshow, stopSlideshow, toggleSlideshowPause, isSlideshowActive, notifySlideshowPhotoShown, peekNextSlideshowPhoto } from './slideshow.js';
import { initToolbarAria } from './toolbar-a11y.js';

// AFFICHAGE DE LA FENÊTRE : créée masquée (tauri.conf.json) pour ne pas montrer le HTML brut. Le module ayant déjà appliqué thème, langue et styles
// à DOMContentLoaded, on attend deux images (premier rendu stylé peint) avant de l'afficher. Un filet de sécurité existe côté Rust (main.rs).
window.addEventListener('DOMContentLoaded', () => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    getCurrentWindow().show().catch(err => console.error("Window show failed:", err));
  }));
});

// AJOUT BARRE TITRE
window.addEventListener('DOMContentLoaded', () => {
  const appWindow = getCurrentWindow();
  console.log("Tauri window initialized for the title bar");

  document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
    console.log("Clic sur Minimiser");
    appWindow.minimize().catch(err => console.error("Window minimize failed:", err));
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
      await syncWindowState();
    } catch (err) {
      console.error("Window maximize/unmaximize failed:", err);
    }
  });

  document.getElementById('titlebar-close')?.addEventListener('click', () => {
    console.log("Clic sur Fermer");
    appWindow.close().catch(err => console.error("Window close failed:", err));
  });

  // Fermeture par n'importe quel moyen (bouton, Alt+F4, menu système) : des mots-clés, titres ou descriptions non écrits ou une écriture en cours
  // demandent confirmation (voir metadata-writes.js). Sans preventDefault, l'API ferme la fenêtre ensuite (permission core:window:allow-destroy).
  appWindow.onCloseRequested(async event => {
    if (!(await confirmCloseWithRunningTasks())) { event.preventDefault(); return; } // tâches de la file encore actives
    if (isSelectedAlbumDirty() && !(await confirmLeaveAlbum())) { event.preventDefault(); return; } // filtres d'un album intelligent non enregistrés
    if (!(await confirmCloseWithPendingEdits())) event.preventDefault();
  }).catch(err => console.error("Close-request handler failed:", err));

  // Icône du bouton Maximiser / Restaurer d'après l'état réel de la fenêtre (aussi modifié hors du bouton : double-clic sur la barre, raccourcis Windows).
  const maximizeButton = document.getElementById('titlebar-maximize');
  const MAXIMIZE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>';
  const RESTORE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor"/><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor"/></svg>';
  let windowMaximized = false;

  function renderMaximizeButton() {
    if (!maximizeButton) return;
    const label = t(windowMaximized ? 'Restore down' : 'Maximize');
    maximizeButton.innerHTML = windowMaximized ? RESTORE_ICON : MAXIMIZE_ICON;
    maximizeButton.title = label;
    maximizeButton.setAttribute('aria-label', label);
  }

  // Lit l'état de la fenêtre : icône Maximiser / Restaurer, et barre de titre masquée en mode immersif (plein écran de la fenêtre).
  async function syncWindowState() {
    try {
      const [maximized, fullscreen] = await Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()]);
      windowMaximized = maximized;
      renderMaximizeButton();
      document.body.classList.toggle('immersive', fullscreen);
    } catch (err) {
      console.error("Window state read failed:", err);
    }
  }

  let windowStateSyncScheduled = false;
  appWindow.onResized(() => {
    if (windowStateSyncScheduled) return;
    windowStateSyncScheduled = true;
    requestAnimationFrame(() => {
      windowStateSyncScheduled = false;
      syncWindowState();
    });
  }).catch(err => console.error("Resize tracking failed:", err));
  onLanguageChange(renderMaximizeButton);
  renderMaximizeButton();
  syncWindowState();

  // MODE IMMERSIF (F11) : fenêtre en plein écran, par-dessus la barre des tâches, sans barre de titre.
  // F11 y entre et en sort.
  // Ne pas confondre avec le plein écran d'une photo (touche F, double-clic).
  let immersiveToggleRunning = false;
  let maximizedBeforeImmersive = false;
  async function toggleImmersiveMode() {
    if (immersiveToggleRunning) return;
    immersiveToggleRunning = true;
    try {
      if (await appWindow.isFullscreen()) {
        await appWindow.setFullscreen(false);
        if (maximizedBeforeImmersive) await appWindow.maximize();
        maximizedBeforeImmersive = false;
      } else {
        // Fenêtre sans décoration maximisée : le plein écran ne redimensionne pas la zone web (elle garde la taille de la zone de travail, sans la barre des tâches).
        // On la restaure donc d'abord, puis on la maximise de nouveau en sortant du mode immersif.
        maximizedBeforeImmersive = await appWindow.isMaximized();
        if (maximizedBeforeImmersive) await appWindow.unmaximize();
        await appWindow.setFullscreen(true);
      }
      await syncWindowState();
    } catch (err) {
      console.error("Immersive mode failed:", err);
    } finally {
      immersiveToggleRunning = false;
    }
  }

  toggleImmersiveFromMenu = toggleImmersiveMode;

  // Ce raccourci reste actif même quand un champ de saisie a le focus (le gestionnaire de touches principal les ignore).
  window.addEventListener('keydown', event => {
    if (event.key !== 'F11') return;
    event.preventDefault();
    if (!event.repeat) toggleImmersiveMode();
  });
});

// ETAT
let photos = [];
let loadedPhotos = [];
let folders = [];
let folderTreePhotos = [];
// Filtres Matériel (appareil, objectif) et Prise de vue (focale, vitesse, ouverture, ISO, flash) : voir shooting-filters.js.
const shootingFilters = initShootingFilters({ getPhotos: () => folderTreePhotos, onChange: () => applyPhotoFilters() });
// Filtre Format (type, marque de RAW, extension) : voir format-filters.js, qui porte aussi les listes d'extensions.
const formatFilters = initFormatFilters({ getPhotos: () => folderTreePhotos, onChange: () => applyPhotoFilters() });
let currentFolderFilter = null;
// Folders added to `currentFolderFilter` by Ctrl+click in the tree: the grid shows the photos of all of them (not persisted, reset by a plain click).
let extraFolderFilters = [];
// Mode « Trouver le RAW » (section du même nom plus bas) : null hors recherche, sinon { name, excludeDir, snapshot } (vue d'avant la recherche).
let rawSearch = null;
// Duplicate search results (section "DUPLICATES" below): null outside the mode, otherwise the groups found and the view to go back to.
let duplicateSearch = null;
let semanticSearch = null; // content search results mode (see "CONTENT SEARCH RESULTS")
// Vue au démarrage (Paramètres > Général) : « all » = Toutes les photos (défaut), « last » = dernier dossier ouvert dans l'arbre.
let startupView = readChoice('startupView', ['last', 'all']);
let includeSubfolders = readBool('includeSubfolders');
let keywordFilters = [];
// Keywords a photo must NOT carry (Alt+Enter / Alt+click in the keyword list, or the chip's context menu). A keyword is never in both lists.
let excludedKeywordFilters = [];
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
let isFullscreen = false; // Etat d'affichage plein écran de photos
let fullscreenRatingPinned = false;
let fullscreenRatingTimeout = null;
const fullscreenImageCache = new Map();
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

// LOSSLESS ROTATION (orientation.rs): the webview turns an original it shows by its EXIF tag only. When the orientation that wins is an XMP
// one (internal writer, sidecar of a PNG…), `photo.view_fix` (1 to 8, same values as the EXIF tag) is what remains to apply on top.
// Generated previews (RAW, HEIC, videos) and the thumbnails are already turned by the backend: their view_fix is 1.
// Matrix (CSS / canvas order a, b, c, d, e, f) of an orientation for a box of `width` × `height` px, origin at its top-left corner.
function orientationMatrix(orientation, width, height) {
  switch (orientation) {
    case 2: return [-1, 0, 0, 1, width, 0];
    case 3: return [-1, 0, 0, -1, width, height];
    case 4: return [1, 0, 0, -1, 0, height];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, height, 0];
    case 7: return [0, -1, -1, 0, height, width];
    case 8: return [0, -1, 1, 0, 0, width];
    default: return null;
  }
}
// Orientations that exchange width and height (quarter turns).
const swapsSides = orientation => orientation >= 5 && orientation <= 8;

// Ajout extracteur RAW (liste des extensions : format-filters.js)
export function isRawPath(path) {
  const ext = (path || '').split('.').pop()?.toLowerCase();
  return RAW_EXTENSIONS.has(ext);
}

// RAW sans JPEG intégré exploitable (jamais dématricé) : les lettres de l'extension (minuscules) s'affichent en gros sur la miniature de la grille et
// dans la case de l'aperçu (voir .format-placeholder dans styles.css). Le texte est lu par ::after sur son propre élément (.thumbnail-inner pour la grille).
function markFormatPlaceholder(element, path) {
  if (!element) return;
  const format = (path || '').split('.').pop()?.toLowerCase() ?? '';
  element.classList.add('format-placeholder');
  for (const target of [element, element.querySelector(':scope > .thumbnail-inner')]) if (target) target.dataset.format = format;
}

// HEIC / HEIF : le webview ne sait pas les afficher. Le backend en fait un JPEG pleine résolution (même commande et même cache que l'aperçu RAW).
// Liste des extensions : format-filters.js.

// VIDÉOS : indexées comme les photos, mais jamais affichées ni lues dans l'application. Le backend en extrait une image fixe (miniature de la grille et aperçu,
// même cache que les photos) ; le double-clic les ouvre dans le lecteur par défaut de l'OS (voir openVideoExternally). Liste alignée sur video.rs.
// Repères visuels : classe .is-video (miniature et case de l'aperçu) et .video-play-badge (icône Play), réglables dans styles.css.
// Liste des extensions : format-filters.js.
export function isVideoPath(path) {
  const ext = (path || '').split('.').pop()?.toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}
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
let appTheme = readChoice('appTheme', ['dark', 'light']);
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
  document.documentElement.dataset.theme = appTheme;
  document.documentElement.style.setProperty('--selected-border', selectionColor);
  document.documentElement.style.setProperty('--selected-contrast', readableTextColor(selectionColor)); // marker of the active photo, drawn on the selection colour
  document.documentElement.style.setProperty('--active-button', activeButtonColor);
  document.documentElement.style.setProperty('--active-button-text', readableTextColor(activeButtonColor));
}
applyAppearance();

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
// ESPACEMENT DES MINIATURES (mémorisé localement), commun à toutes les dispositions : aucun, petit (0,25 rem) ou normal (marge et cadre historiques de la cascade).
// Sans choix enregistré, on garde l'aspect d'avant ce réglage : vue justifiée sans espace, autres dispositions espacées.
const THUMBNAIL_SPACINGS = ['none', 'small', 'normal'];
const storedThumbnailSpacing = localStorage.getItem('thumbnailSpacing');
let thumbnailSpacing = THUMBNAIL_SPACINGS.includes(storedThumbnailSpacing) ? storedThumbnailSpacing
  : DEFAULTS.thumbnailSpacing !== 'auto' ? DEFAULTS.thumbnailSpacing : (thumbnailLayout === 'justified' ? 'none' : 'normal');
// En disposition Encadrée, l'espacement « Aucun » est interdit (les cadres se toucheraient) : voir syncThumbnailSpacingWithLayout.
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
const previewStage = document.getElementById('preview-stage');
const fullscreenView = document.getElementById('fullscreen-view');
const fullscreenImg = document.getElementById('fullscreen-image');
// Zoom du plein écran : même structure qu'une case de l'aperçu (voir layoutPreviewSlot), la vue entière occupe toute la fenêtre (marge 1).
const fullscreenSlot = { photo: null, url: '', cell: fullscreenView, img: fullscreenImg, clip: document.getElementById('fullscreen-clipping'), naturalWidth: 0, naturalHeight: 0, fit: 1, fitMargin: 1, zoom: null, tx: 0, ty: 0, displayWidth: 0, displayHeight: 0, center: { x: 0.5, y: 0.5 } };
fullscreenSlot.zoomBadge = document.getElementById('fullscreen-zoom-badge');
fullscreenSlot.zoomTimeout = null;let fullscreenLoadToken = 0;
let fullscreenDrag = null;
const sidebarPanel = document.getElementById('sidebar-panel');
const folderTree = document.getElementById('folder-tree');
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
  if (paths.length) fullscreenImageCache.clear();
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
async function loadFolders() {
  folders = await invoke('get_folders');
  renderFolderTree();
  renderSettingsFolderList();
}

// The grid loads at most this many photos per folder. The backend picks them in the current sort (ascending by date = the oldest ones);
// on larger folders it also pre-applies the filters it can (`sqlPrefilter`), and `photoListCap` warns the user when the list is still cut.
const PHOTO_LOAD_LIMIT = 50000;
const queryPhotoPage = (folderFilter, prefilter = null) => invoke('get_photos_paginated', {
  offset: 0, limit: PHOTO_LOAD_LIMIT, folderFilter, recursive: includeSubfolders, sortKey, sortOrder, prefilter,
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
async function queryFolderPhotos(folder, prefilter = null) {
  const folderList = folder === null || folder !== currentFolderFilter ? [folder] : [folder, ...extraFolderFilters];
  const lists = await Promise.all(folderList.map(item => queryPhotoPage(item, prefilter)));
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
  if (state.keywords?.length) filter.keywords = [...state.keywords].sort();
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

// Reads the displayed folders: on a large folder, prefiltered (counted first to know). Returns { list, cap, large, key }.
async function readDisplayedFolderPhotos(folder) {
  const wanted = buildSqlPrefilter();
  let total;
  let list;
  if (wanted) {
    total = await countDisplayedPhotos();
  } else {
    [total, list] = await Promise.all([countDisplayedPhotos(), queryFolderPhotos(folder)]); // usual case: no wait for the count
  }
  const large = total === null ? Boolean(list?.capped) || largeScope : total > PHOTO_LOAD_LIMIT;
  const prefilter = large ? wanted : null;
  if (!list) list = await queryFolderPhotos(folder, prefilter);
  const cap = list.capped ? { total: prefilter ? await countDisplayedPhotos(prefilter) : total } : null;
  return { list, cap, large, key: prefilterKey(prefilter) };
}

// A filter changed on a large folder: the list is read again with the new prefilter (grouped over a burst of changes).
let prefilterReloadTimer = null;
function schedulePrefilterReload() {
  clearTimeout(prefilterReloadTimer);
  prefilterReloadTimer = setTimeout(async () => {
    if (!largeScope || prefilterKey(sqlPrefilter()) === loadedPrefilterKey) return;
    const generation = ++photoLoadGeneration;
    const result = await readDisplayedFolderPhotos(getSelectedAlbum() ? null : currentFolderFilter);
    if (generation !== photoLoadGeneration) return;
    ({ cap: photoListCap, large: largeScope, key: loadedPrefilterKey } = result);
    loadedPhotos = result.list;
    applyPhotoFilters(); // same reset (scroll, selection) as any filter change
  }, 200);
}

async function loadPhotos() {
  // Album virtuel affiché : un album manuel montre son contenu ; un album intelligent part de toute la photothèque (ses filtres viennent ensuite).
  // Dans les deux cas le dossier du disque n'intervient plus.
  const album = getSelectedAlbum();
  const baseAlbumId = album?.kind === 'manual' ? album.id : album?.kind === 'smart' ? getAlbumContext(album.id).baseManualId : 0;
  const generation = ++photoLoadGeneration;
  let result;
  if (duplicateSearch) {
    // Duplicate results: only the photos of the groups, never the folder or album view (also used when the mode reloads after a rescan).
    result = { list: await invoke('get_photos_by_paths', { paths: duplicateSearch.groupPaths.flat() }), cap: null, large: false, key: '' };
  } else if (semanticSearch) {
    // Content search results: only the photos of the answer (the slider cut is a filter, see matchesSemanticCut).
    result = { list: await loadSemanticPhotos(), cap: null, large: false, key: '' };
  } else if (baseAlbumId) {
    result = { list: await invoke('get_album_photos', { albumId: baseAlbumId }), cap: null, large: false, key: '' }; // never capped
  } else {
    result = await readDisplayedFolderPhotos(album ? null : currentFolderFilter);
  }
  if (generation !== photoLoadGeneration) return; // a newer load is under way and will show its own list
  ({ cap: photoListCap, large: largeScope, key: loadedPrefilterKey } = result);
  loadedPhotos = result.list;
  if (duplicateSearch) indexDuplicateGroups();
  photosLoadedOnce = true;
  // The whole-catalogue list feeds the keyword suggestions and gear lists: never a prefiltered one.
  if (!album && currentFolderFilter === null && !duplicateSearch && !semanticSearch && !loadedPrefilterKey) folderTreePhotos = loadedPhotos;
  renderFolderTree();
  renderKeywordFilters();
  invalidateKeywordTree(); // les fichiers ont pu changer l'arborescence des mots-clés (scan, relecture)
  applyPhotoFilters();
  refreshFaces(); // et les personnes lues dans les zones de visage (voir faces-panel.js)
  scheduleAlbumCounts(); // les photos ont pu changer : compteurs des albums
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
    || shootingFilters.hasGear() || shootingFilters.hasShot() || formatFilters.hasFormats()
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
  const key = semanticSearch ? 'No photo matches this search'
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
    const total = loadedPhotos.length;
    const format = value => value.toLocaleString(getLanguage()); // séparateur de milliers de la langue
    const number = format(photos.length);
    // Texte court (la barre latérale est étroite) : « 12 480 photos » ou « 342 sur 12 480 » ; la phrase complète est en infobulle.
    // Le pluriel suit le total (« 1 sur 12 photos ») ; les nombres affichés sont les valeurs mises en forme.
    const narrowed = isFiltered && photos.length !== total;
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
function applyPhotoFilters({ keepState = false } = {}) {
  // keepState : mise à jour en arrière-plan (synchronisation), la sélection et le défilement sont conservés.
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
  photos.sort(comparePhotosForSort); // même liste pour la grille et la navigation en plein écran
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
    refreshInfoRows();
  }
  updateFilteredPhotosCount();
  renderRawSearchBanner(); // mode « Trouver le RAW » : le nombre de résultats suit les filtres
  renderDuplicateBanner(); // duplicate search: the counts follow the filters
  renderSemanticBanner(); // content search: same
  reloadFacesView(); // vue Visages ouverte : visages des photos désormais affichées
  refreshMapMode(); // mode Carte ouvert : points des photos désormais affichées
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
    dateFilter = null;
    updateDateFilterUI('');
    closeDatePicker();
  },
  location: () => setLocationFilter('all', { apply: false }),
  analysis: () => setAnalysisFilter('all', { apply: false }),
  gear: () => shootingFilters.clearGear(),
  shot: () => shootingFilters.clearShot(),
  format: () => formatFilters.reset(),
};

// Types de filtre de chaque groupe de l'accordéon (data-filter-group), pour le × d'un groupe.
const filterGroupKinds = {
  'rating-color': ['rating', 'color', 'pick'],
  tags: ['keyword', 'filename', 'failed'],
  persons: ['person'],
  date: ['date'],
  gear: ['gear'],
  shooting: ['shot'],
  more: ['format', 'location', 'analysis'],
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
  if (excludedKeywordFilters.length) state.excludedKeywords = [...excludedKeywordFilters];
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
  if ((state.keywords || state.excludedKeywords) && !matchesKeywordFilters(photo, state.keywords, state.excludedKeywords)) return false;
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
  renderKeywordFilters();
  filenameFilters = [...(state.filenames ?? [])];
  excludedFilenameFilters = [...(state.excludedFilenames ?? [])];
  renderFilenameFilters();
  if (state.date) {
    dateFilterInput.value = state.date;
    dateFilter = parseDateFilter(state.date).filter ?? null;
    updateDateFilterUI('');
  }
  setPersonFilterIds(state.persons ?? [], state.excludedPersons ?? []);
  setLocationFilter(state.location ?? 'all', { apply: false });
  shootingFilters.apply(state);
  formatFilters.apply(state);
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
    applyPhotoFilters();
  }
}

// Compteurs des albums intelligents et des dossiers virtuels. Un album intelligent compte les photos de toute la photothèque (ou du contenu de son
// parent manuel ou intelligent) qui satisfont ses critères enregistrés ; un dossier virtuel compte les photos DISTINCTES de tout ce qu'il contient.
// Le calcul relit la liste complète des photos : il est différé et regroupé (une seule exécution à la fois), et inutile sans album.
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
        let own = {};
        try { own = JSON.parse(node.filters) || {}; } catch { /* critères illisibles : album sans filtre */ }
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
  labels.push(...(state.keywords ?? []), ...(state.excludedKeywords ?? []).map(keyword => `-${keyword}`), ...(state.filenames ?? []), ...(state.excludedFilenames ?? []).map(text => `-${text}`));
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

function renderKeywordFilters() {
  const counts = new Map();
  for (const photo of folderTreePhotos) {
    for (const word of new Set((photo.keywords || '').split(', ').map(item => item.trim()))) if (word) counts.set(word, (counts.get(word) || 0) + 1);
  }
  keywordFilterOptions = [...counts].map(([word, count]) => ({ value: word, label: decodeHtmlEntities(word), count, search: normalizeSearch(decodeHtmlEntities(word)) }));
  keywordFilterSuggest?.refresh();
  renderFilterTags();
  shootingFilters.refreshOptions(); // listes des appareils et objectifs : la collection a pu changer
}

const hasKeywordFilters = () => keywordFilters.length > 0 || excludedKeywordFilters.length > 0;

// A photo passes if it carries every included keyword and none of the excluded ones (whole keywords, as stored).
// Excluded keywords are never sent to the backend prefilter: it stays a superset of this test.
function matchesKeywordFilters(photo, included = keywordFilters, excluded = excludedKeywordFilters) {
  if (!included?.length && !excluded?.length) return true;
  const words = (photo.keywords || '').split(', ');
  return (included ?? []).every(keyword => words.includes(keyword)) && !(excluded ?? []).some(keyword => words.includes(keyword));
}

// Keyword filter with content-search suggestions (semantic-keywords.js, setting "Include suggestions in keyword filtering"): every included keyword is
// carried or suggested, nothing excluded is carried. `keywordGuesses` (rebuilt by each filtering) maps a photo id to the included keywords it only
// has by suggestion; a photo carrying everything is not in it.
function matchesKeywordFiltersOrSuggested(photo) {
  if (matchesKeywordFilters(photo)) return true;
  if (!suggestionsLoaded() || keywordFilters.length === 0) return false;
  const words = (photo.keywords || '').split(', ');
  if (excludedKeywordFilters.some(keyword => words.includes(keyword))) return false;
  const guessed = [];
  for (const keyword of keywordFilters) {
    if (words.includes(keyword)) continue;
    if (!suggestionFor(keyword, photo.id)) return false;
    guessed.push(keyword);
  }
  keywordGuesses.set(photo.id, guessed);
  return true;
}

// Cheap key of "the view" for the suggestions: they are searched again only when the filter or this key changes (never null in a plain view).
function keywordSuggestionViewKey() {
  if (rawSearch || duplicateSearch || semanticSearch) return null; // results modes: no suggestions
  return `${currentFolderFilter}|${includeSubfolders}|${getSelectedAlbum()?.id ?? ''}|${extraFolderFilters.join('\n')}`;
}

// Scope of the suggestions = the view (same as the content search); filters are not part of it, they apply to the suggested photos afterwards.
function keywordSuggestionScope() {
  const { folder, recursive, photoIds } = currentViewScope();
  return { folder: folder ?? null, recursive: Boolean(recursive), photoIds: photoIds ?? null, skipRaw: !readBool('semanticScanRaw') };
}

// Puts a keyword in the included or excluded list (and out of the other one). Neither re-renders nor filters: the caller does.
function setKeywordFilter(keyword, exclude) {
  keywordFilters = keywordFilters.filter(item => item !== keyword);
  excludedKeywordFilters = excludedKeywordFilters.filter(item => item !== keyword);
  (exclude ? excludedKeywordFilters : keywordFilters).push(keyword);
}

function addKeywordFilter(value, exclude = false) {
  const keyword = value.trim();
  if (!keyword) return;
  document.getElementById('keyword-filter-input').value = '';
  if ((exclude ? excludedKeywordFilters : keywordFilters).includes(keyword)) return;
  setKeywordFilter(keyword, exclude);
  renderKeywordFilters();
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

// Étiquettes des mots-clés (bleu) et des noms de fichier (vert), sur une ligne commune : boutons à croix quand le groupe est déplié,
// simples étiquettes derrière le titre quand il est replié.
function renderFilterTags() {
  const expandedContainer = document.getElementById('filter-tags');
  const collapsedLine = document.getElementById('tags-collapsed-line');
  if (!expandedContainer || !collapsedLine) return;
  const entries = [
    ...(pathFilter !== null ? [{ kind: 'failed', text: t('Failed files') }] : []),
    ...keywordFilters.map(text => ({ kind: 'keyword', text })),
    ...excludedKeywordFilters.map(text => ({ kind: 'keyword', text, excluded: true })),
    ...filenameFilters.map(text => ({ kind: 'filename', text })),
    ...excludedFilenameFilters.map(text => ({ kind: 'filename', text, excluded: true })),
  ];
  // Retire une étiquette (boutons du groupe déplié comme croix des étiquettes repliées) puis relance le filtrage.
  const removeEntry = (kind, text, excluded = false) => {
    if (kind === 'keyword' && excluded) excludedKeywordFilters = excludedKeywordFilters.filter(item => item !== text);
    else if (kind === 'keyword') keywordFilters = keywordFilters.filter(item => item !== text);
    else if (kind === 'failed') pathFilter = null;
    else if (excluded) excludedFilenameFilters = excludedFilenameFilters.filter(item => item !== text);
    else filenameFilters = filenameFilters.filter(item => item !== text);
    renderFilterTags();
    applyPhotoFilters();
  };
  // Excluded keyword or filename text: the chip text starts with "-". A right-click on such a chip switches it between "include" and "exclude".
  const label = (text, excluded) => (excluded ? `-${text}` : text);
  const addKeywordMenu = (node, kind, text, excluded) => {
    if (kind !== 'keyword' && kind !== 'filename') return;
    addIncludeExcludeMenu(node, {
      label: label(text, excluded),
      excluded,
      onToggle: () => {
        (kind === 'keyword' ? setKeywordFilter : setFilenameFilter)(text, !excluded);
        renderFilterTags();
        applyPhotoFilters();
      },
    });
  };
  expandedContainer.replaceChildren(...entries.map(({ kind, text, excluded = false }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `filter-tag tag-${kind}`;
    button.textContent = `${label(text, excluded)} ×`;
    button.title = t('Remove filter {keyword}', { keyword: label(text, excluded) });
    button.addEventListener('click', () => removeEntry(kind, text, excluded));
    addKeywordMenu(button, kind, text, excluded);
    return button;
  }));
  collapsedLine.querySelectorAll('.filter-tag').forEach(node => node.remove());
  collapsedLine.append(...entries.map(({ kind, text, excluded = false }) => {
    const tag = createFilterTag({
      kind,
      text: label(text, excluded),
      title: t(kind === 'keyword' ? (excluded ? 'Excluded keyword: {text}' : 'Keyword: {text}') : kind === 'failed' ? 'Files whose keywords could not be written'
        : excluded ? 'Filename without: {text}' : 'Filename: {text}', { text }),
      onRemove: () => removeEntry(kind, text, excluded),
    });
    addKeywordMenu(tag, kind, text, excluded);
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

  const analysisNodes = analysisFilter === 'all' ? [] : [createFilterTag({
    kind: 'analysis',
    text: t(analysisFilter === 'analysed' ? 'Analysed' : 'Not analysed'),
    title: t('Content analysis'),
    onRemove: () => clearFilterKindsAndApply(['analysis']),
  })];
  document.getElementById('analysis-summary').replaceChildren(...analysisNodes);

  shootingFilters.renderSummaries();
  formatFilters.renderSummaries();
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
    more: formatFilters.hasFormats() || locationFilter !== 'all' || analysisFilter !== 'all',
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
    [analysisFilter !== 'all', 'analysis', 'Content analysis'],
    [shootingFilters.hasGear(), 'gear', 'Gear'],
    [shootingFilters.hasShot(), 'shot', 'Shooting'],
    [formatFilters.hasFormats(), 'format', 'Format'],
    [pathFilter !== null, 'failed', 'Failed files'],
  ];
  // Chaque badge a sa croix : elle efface ce type de filtre sans déplier le bloc (les clés de `clearFilterKinds` sont les types ci-dessus).
  container.replaceChildren(...kinds.filter(([active]) => active).map(([, kind, label]) => createFilterTag({
    kind,
    text: t(label),
    onRemove: () => clearFilterKindsAndApply([kind]),
  })));
}

function decodeHtmlEntities(text) {
  const doc = new DOMParser().parseFromString(String(text || ''), 'text/html');
  return doc.documentElement.textContent;
}

// ==========================================
// ARBORESCENCE & FILTRES
// ==========================================
// `fromCounts` : redessin demandé par l'arrivée de nouveaux compteurs, qui ne doit pas en redemander.
function renderFolderTree({ fromCounts = false } = {}) {
  folderTree.innerHTML = '';
  if (!fromCounts) scheduleFolderCounts(); // photos may have changed (scan, move, deletion…): re-read the catalogue folders

  const allItem = document.createElement('li');
  allItem.className = `folder-tree-item ${currentFolderFilter === null && !getSelectedAlbum() ? 'active' : ''}`;
  allItem.dataset.allPhotos = '1'; // read by the context menu (photo-actions.js)
  allItem.innerHTML = `<span>📚</span> <span class="folder-tree-name">${t('All photos')}</span>`;
  if (showFolderCounts) allItem.append(folderCountElement(folderCountsTotal, 'in this folder'));
  allItem.addEventListener('click', () => selectFolder(null));
  folderTree.appendChild(allItem);
  const roots = folders.map(folder => ({ path: folder.path.replace(/[\\/]+$/, ''), name: folder.path.split(/[\\/]/).filter(Boolean).pop() || folder.path, children: new Map() }));
  const normalize = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  // `empty` : dossier sans photo ; seuls les nœuds créés par cet appel sont marqués (ceux déjà déduits des photos ne le sont jamais).
  const addFolderToTree = (parent, empty = false) => {
    const root = roots.find(candidate => {
      const rootPath = candidate.path.replace(/\\/g, '/').replace(/\/+$/, '');
      return normalize(parent) === normalize(rootPath) || normalize(parent).startsWith(`${normalize(rootPath)}/`);
    });
    if (!root) return;
    const rootPath = root.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const relative = parent.slice(rootPath.length).replace(/^\//, '');
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
  for (const folderPath of catalogFolders) addFolderToTree(folderPath);
  // Loaded photos too: they draw the tree right away, before the first catalogue read answers.
  for (const photo of (folderTreePhotos.length ? folderTreePhotos : loadedPhotos)) {
    const photoPath = photo.path.replace(/\\/g, '/');
    addFolderToTree(photoPath.slice(0, photoPath.lastIndexOf('/')));
  }
  // Dossiers créés depuis l'application et encore vides : l'arborescence est déduite des photos, ils n'y figureraient pas sinon.
  for (const folderPath of createdFolders) addFolderToTree(folderPath.replace(/\\/g, '/').replace(/\/+$/, ''));
  // Option « Afficher les dossiers sans photo » : tous les dossiers présents sur le disque (listés par `refreshDiskFolders`).
  if (showEmptyFolders) for (const folderPath of diskFolders) addFolderToTree(folderPath.replace(/\\/g, '/').replace(/\/+$/, ''), true);
  const renderNode = (node, parentElement, depth, isRoot = false) => {
    const li = document.createElement('li');
    const isActiveFolder = !getSelectedAlbum() && [currentFolderFilter, ...extraFolderFilters].some(folder => folder && normalize(folder) === normalize(node.path));
    li.className = `folder-tree-item ${isActiveFolder ? 'active' : ''} ${node.empty ? 'folder-empty' : ''}`;
    li.dataset.folderPath = node.path; // lu par le menu contextuel de l'arborescence (photo-actions.js)
    if (isRoot) li.dataset.folderRoot = '1'; // dossier suivi (et non sous-dossier) : message de confirmation de suppression
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
    const icon = document.createElement('span'); icon.className = `folder-tree-icon${isRoot ? ' folder-tree-icon-root' : ''}`; icon.textContent = '📁';
    const label = document.createElement('span'); label.className = 'folder-tree-name'; label.textContent = node.name; label.title = node.path;
    li.append(toggle, icon, label);
    if (showFolderCounts) {
      // Dossier replié avec « inclure les sous-dossiers » : le nombre résume ce qui est caché ; sinon, seulement le niveau du dossier
      // (déplié, ses sous-dossiers affichent les leurs).
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
    if (!folderTreeInitialized) folderTreeExpanded.add(normalize(root.path));
    renderNode(root, folderTree, 0, true);
  }
  folderTreeInitialized = true;
  // Aucun dossier suivi (premier lancement) : l'arborescence propose directement d'en ajouter un, sans passer par les Paramètres.
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
}

// Compteurs de l'option « Montrer le nombre de photos des dossiers » : photos et vidéos du catalogue, sans filtre, calculées côté Rust.
// Clés normalisées comme celles de l'arbre (« / », minuscules, sans « / » final) ; `Own` = niveau du dossier, `Tree` = avec ses sous-dossiers.
let showFolderCounts = readBool('showFolderCounts');

// Pastille des photos géolocalisées sur les miniatures (Options d'affichage, désactivée par défaut) : simple classe sur <body>.
const GEO_BADGE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>';
const showGeoBadgesToggle = document.getElementById('show-geo-badges-toggle');
showGeoBadgesToggle.checked = readBool('showGeoBadges');
document.body.classList.toggle('show-geo-badges', showGeoBadgesToggle.checked);
showGeoBadgesToggle.addEventListener('change', () => {
  localStorage.setItem('showGeoBadges', String(showGeoBadgesToggle.checked));
  document.body.classList.toggle('show-geo-badges', showGeoBadgesToggle.checked);
});
let folderCountsOwn = new Map();
let folderCountsTree = new Map();
let folderCountsTotal = 0;
let folderCountsSignature = '';
let folderCountsTimer = null;
function folderCountElement(count, scope) {
  const element = document.createElement('span');
  element.className = 'folder-tree-count';
  element.textContent = String(count);
  const titleKey = scope === 'with its subfolders' ? '{count} photo or video with its subfolders' : '{count} photo or video in this folder';
  element.title = tp(titleKey, count);
  return element;
}
// Folders of the whole catalogue (original case, "/" separators), from the same query as the counts: the tree is built from them.
let catalogFolders = [];
// Re-reads the catalogue folders and their counts (once per burst of redraws), whether or not counts are shown: the tree needs
// the folder list. The tree is redrawn only when something changed.
function scheduleFolderCounts() {
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
      const key = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      folderCountsOwn.set(key, (folderCountsOwn.get(key) ?? 0) + count);
      folderCountsTotal += count;
      // Chaque dossier parent du chemin cumule aussi ce nombre (total du sous-arbre).
      for (let cut = key.indexOf('/', 1); ; cut = key.indexOf('/', cut + 1)) {
        const ancestor = cut === -1 ? key : key.slice(0, cut);
        folderCountsTree.set(ancestor, (folderCountsTree.get(ancestor) ?? 0) + count);
        if (cut === -1) break;
      }
    }
    renderFolderTree({ fromCounts: true });
  }, 150);
}
const folderTreeExpanded = new Set();
const createdFolders = new Set(); // sous-dossiers créés pendant cette session (voir renderFolderTree)
let showEmptyFolders = readBool('showEmptyFolders');
let diskFolders = []; // sous-dossiers présents sur le disque, lus seulement si showEmptyFolders est actif
// Relit les sous-dossiers du disque puis redessine l'arborescence ; sans l'option, la liste est vidée et rien n'est lu.
async function refreshDiskFolders() {
  try {
    diskFolders = showEmptyFolders ? await invoke('list_disk_folders') : [];
  } catch (error) {
    console.debug('Disk folder list unavailable', error);
    diskFolders = [];
  }
  renderFolderTree();
}
let folderTreeInitialized = false;
// Appelé après la création d'un sous-dossier : il apparaît tout de suite dans l'arborescence, dossier parent déplié.
function addCreatedFolder(parentPath, name) {
  createdFolders.add(`${parentPath.replace(/[\\/]+$/, '')}/${name}`);
  folderTreeExpanded.add(parentPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
  renderFolderTree();
}
// Mémorise le dossier ouvert dans l'arbre (null = Toutes les photos), relu au démarrage si l'utilisateur l'a choisi.
function rememberCurrentFolder() {
  if (currentFolderFilter === null) localStorage.removeItem('lastFolderFilter');
  else localStorage.setItem('lastFolderFilter', currentFolderFilter);
}
function selectFolder(path) {
  // Album intelligent modifié : Enregistrer / Abandonner / Annuler avant de le quitter.
  if (isSelectedAlbumDirty()) {
    confirmLeaveAlbum().then(proceed => { if (proceed) selectFolder(path); });
    return;
  }
  abandonRawSearch(); // naviguer à la main termine « Trouver le RAW » : les filtres d'avant la recherche reviennent
  abandonDuplicateSearch(); // same for the duplicate search
  abandonSemanticSearch(); // and the content search
  clearAlbumSelection(); // une seule entrée active dans la barre latérale
  syncSmartAlbumWithSelection(); // quitter un album intelligent remet ses filtres à zéro
  currentFolderFilter = path;
  extraFolderFilters = [];
  rememberCurrentFolder();
  renderFolderTree();
  loadPhotos();
}

// Right-click on the "Folders" title: fold every folder, or unfold the ancestors of the folders holding the selected photos.
document.getElementById('folders-toggle').addEventListener('contextmenu', event => {
  const normalize = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const selectedFolders = new Set();
  for (const index of selectedIndices) {
    const path = photos[index]?.path;
    if (path) selectedFolders.add(normalize(path.slice(0, Math.max(path.search(/[\\/][^\\/]*$/), 0))));
  }
  openContextMenuAt(event, [
    { header: t('Folders') },
    { label: t('Collapse all'), title: t('Fold every folder'), onSelect: () => {
      folderTreeExpanded.clear();
      folderTreeInitialized = true; // otherwise the tracked folders would be unfolded again as on first display
      renderFolderTree();
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
        renderFolderTree();
      },
    },
  ]);
});

// Ctrl+click on a folder: adds it to the selection, or removes it if already selected. Without a current folder, behaves like a plain click.
function toggleFolderInSelection(path) {
  const same = (a, b) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (currentFolderFilter === null || getSelectedAlbum() || duplicateSearch || rawSearch || semanticSearch) { selectFolder(path); return; }
  if (isSelectedAlbumDirty()) { selectFolder(path); return; }
  if (same(currentFolderFilter, path)) {
    if (extraFolderFilters.length === 0) return; // the only selected folder stays selected
    // The main folder is deselected: the first extra one takes over.
    [currentFolderFilter, ...extraFolderFilters] = extraFolderFilters;
    rememberCurrentFolder();
  } else if (extraFolderFilters.some(folder => same(folder, path))) {
    extraFolderFilters = extraFolderFilters.filter(folder => !same(folder, path));
  } else {
    extraFolderFilters.push(path);
  }
  renderFolderTree();
  loadPhotos();
}

// Double-click on a folder row folds / unfolds it (same as its arrow). The tree is redrawn by the first click (and again when the photos load), so the
// row under the second click is a new element and the browser may never fire `dblclick` on it: the second `mousedown` (detail 2) is used instead.
folderTree.addEventListener('mousedown', event => {
  if (event.detail !== 2 || event.button !== 0 || event.ctrlKey || event.metaKey || event.target.closest('.folder-tree-toggle')) return;
  event.preventDefault(); // no text selection on a double-click
  const row = event.target.closest('li[data-folder-path]');
  if (!row) return;
  const key = row.dataset.folderPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!row.querySelector('.folder-tree-toggle')?.textContent.trim()) return; // no subfolder
  if (folderTreeExpanded.has(key)) folderTreeExpanded.delete(key); else folderTreeExpanded.add(key);
  folderTreeInitialized = true;
  renderFolderTree();
});

// ==========================================
// TROUVER LE RAW
// ==========================================
// Clic droit sur une image raster > « Trouver le RAW » : les critères cochés dans Paramètres > Divers > RAW (raw-settings.js) deviennent les filtres
// ordinaires de la barre latérale (nom, date, appareil, objectif, vitesse / ISO / ouverture, plus « RAW uniquement »), la grille s'ouvre sur le
// dossier de départ choisi avec tous ses sous-dossiers, et une bannière propose de revenir à la vue d'avant (instantané : dossier ou album, filtres,
// option sous-dossiers, défilement, sélection). Naviguer à la main (dossier, album, option sous-dossiers) termine le mode sans retour.
document.getElementById('raw-search-back')?.addEventListener('click', () => exitRawSearch());

// Ce que les filtres ne savent pas exprimer : « Sous-dossiers » (les photos du dossier de l'image lui-même ne comptent pas, le dossier de départ
// les contient) et la comparaison tolérante des noms (voir rawNameMatches).
function matchesRawSearchScope(photo) {
  if (!rawSearch) return true;
  if (rawSearch.excludeDir && normalizeFilterPath(folderOf(photo.path)) === rawSearch.excludeDir) return false;
  return rawNameMatches(photo, rawSearch.nameStem);
}

function renderRawSearchBanner() {
  // Éléments lus à chaque appel : la fonction peut être appelée avant que cette section du module ait été exécutée.
  const banner = document.getElementById('raw-search-banner');
  if (!banner) return;
  banner.hidden = !rawSearch;
  if (!rawSearch) return;
  const text = document.getElementById('raw-search-text');
  text.textContent = tp('RAW of {name}: {count} result', photos.length, { name: rawSearch.name });
  text.title = rawSearch.nameStem ? t('Names compared in both directions: {name}', { name: rawSearch.nameStem }) : '';
}

// L'option « Inclure les sous-dossiers » change de valeur sans être mémorisée : c'est un réglage du mode, pas un choix de l'utilisateur.
function setIncludeSubfoldersTemporarily(value) {
  includeSubfolders = value;
  document.getElementById('recursive-folder-toggle').checked = value;
}

// Termine le mode sans rouvrir la vue d'avant : remet l'option sous-dossiers et les filtres d'avant la recherche (sauf ceux d'un album intelligent,
// que le retour à l'album recharge lui-même). L'appelant s'occupe du dossier ou de l'album affiché ensuite.
function abandonRawSearch() {
  if (!rawSearch) return;
  const { snapshot } = rawSearch;
  rawSearch = null;
  setIncludeSubfoldersTemporarily(snapshot.includeSubfolders);
  resetAllFilters();
  if (snapshot.albumKind !== 'smart') applyFilterState(snapshot.filterState);
  renderRawSearchBanner();
}

// Bouton « Revenir à la vue précédente » et Échap.
async function exitRawSearch() {
  if (!rawSearch) return;
  const { snapshot } = rawSearch;
  abandonRawSearch();
  await restoreViewSnapshot(snapshot);
}

// Reopens the view saved before a results mode (folder or album, scroll, selection). The caller has already left the mode.
async function restoreViewSnapshot(snapshot) {
  if (snapshot.albumId) {
    restoreAlbumSelection(snapshot.albumId);
    syncSmartAlbumWithSelection(); // album intelligent : ses filtres reviennent
  } else {
    currentFolderFilter = snapshot.folder; extraFolderFilters = [];
  }
  await loadPhotos();
  const indexByPath = new Map(photos.map((photo, index) => [photo.path, index]));
  selectedIndices.clear();
  for (const path of snapshot.selectedPaths) if (indexByPath.has(path)) selectedIndices.add(indexByPath.get(path));
  lastSelectedIndex = indexByPath.get(snapshot.lastPath) ?? selectedIndices.values().next().value ?? 0;
  if (selectedIndices.size === 0 && photos.length > 0) selectedIndices.add(0);
  gridContainer.scrollTop = snapshot.scrollTop;
  renderVisibleItems();
  if (photos.length > 0) updateUIOnSelection();
}

// « Afficher dans son dossier » (menu d'un RAW de la grille de résultats) : quitte la recherche sans revenir à la vue d'avant, ouvre le dossier du
// fichier dans l'arbre, sans aucun filtre, avec le fichier sélectionné et visible dans la grille.
// Also used from "All photos" (context menu, one photo): there the current filters are kept, since the photo passes them and the user did not leave a search.
// What the content search calls "the view" (semantic.js): a folder (with its subfolders when the view includes them), otherwise the photos of the
// collection on screen (album, several folders, a results mode), otherwise the whole library. Filters are not part of the scope.
function currentViewScope() {
  if (semanticSearch) return semanticSearch.viewScope; // a new search from inside the results mode searches the same view
  const album = getSelectedAlbum();
  if (!album && !rawSearch && !duplicateSearch && extraFolderFilters.length === 0) {
    if (currentFolderFilter !== null) return { folder: currentFolderFilter, recursive: includeSubfolders, photoIds: null };
    return { folder: null, recursive: false, photoIds: null }; // "All photos"
  }
  return { folder: null, recursive: false, photoIds: loadedPhotos.map(photo => photo.id) };
}

function isAllPhotosView() { return currentFolderFilter === null && !getSelectedAlbum() && !rawSearch && !duplicateSearch && !semanticSearch; }
async function showPhotoInItsFolder(photo) {
  const fromResults = rawSearch !== null || duplicateSearch !== null || semanticSearch !== null;
  if (!photo || !(fromResults || isAllPhotosView())) return;
  if (isFullscreen) closeFullscreen();
  abandonRawSearch(); // option sous-dossiers d'avant la recherche
  abandonDuplicateSearch();
  abandonSemanticSearch();
  if (fromResults) resetAllFilters(); // aucun filtre dans le dossier du fichier, pas même ceux d'avant la recherche
  clearAlbumSelection();
  syncSmartAlbumWithSelection();
  const folder = folderOf(photo.path);
  currentFolderFilter = folder; extraFolderFilters = [];
  rememberCurrentFolder();
  // Dossiers parents dépliés pour que le dossier soit visible dans l'arbre (comme à la reprise du dernier dossier au démarrage).
  const segments = folder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase().split('/');
  for (let n = 1; n < segments.length; n++) folderTreeExpanded.add(segments.slice(0, n).join('/'));
  renderFolderTree();
  await loadPhotos();
  const index = photos.findIndex(candidate => candidate.path === photo.path);
  if (index >= 0) {
    selectedIndices.clear();
    selectedIndices.add(index);
    lastSelectedIndex = index;
    scrollToPhotoIndex(index);
    renderVisibleItems();
    updateUIOnSelection();
  }
  document.querySelector('#folder-tree .folder-tree-item.active')?.scrollIntoView({ block: 'nearest' });
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

const RAW_CRITERION_LABELS ={ name: 'Filename', date: 'Date', gear: 'Gear', shooting: 'Shooting' };

async function findRawFor(photo) {
  if (!photo) return;
  if (!hasRawSearchCriteria()) {
    showWriteToast(t('Tick at least one criterion in Settings > Misc > RAW'));
    return;
  }
  const settings = getRawSearchSettings();
  const name = photo.path.split(/[\\/]/).pop();
  const { state, nameStem, used, missing } = buildRawSearchState(photo, settings, photoTimeKey(photo));
  if (used.length === 0) {
    showWriteToast(t('This image has none of the data needed to find its RAW'));
    return;
  }
  // Même garde que pour un changement de dossier : un album intelligent modifié se quitte après Enregistrer / Abandonner / Annuler.
  if (isSelectedAlbumDirty() && !(await confirmLeaveAlbum())) return;

  // Contrôle avant de quitter la vue : sans RAW trouvé, on reste où on est (mêmes critères que les filtres, voir matchesFilterState).
  const { folder, excludeDir } = searchScope(photo.path, settings.scope);
  const excluded = excludeDir ? normalizeFilterPath(excludeDir) : null;
  const candidates = await invoke('get_photos_paginated', { offset: 0, limit: 50000, folderFilter: folder, recursive: true });
  const found = candidates.filter(candidate => matchesFilterState(candidate, state)
    && (!excluded || normalizeFilterPath(folderOf(candidate.path)) !== excluded)
    && rawNameMatches(candidate, nameStem));
  if (found.length === 0) {
    showWriteToast(t('No RAW found for {name}', { name }));
    return;
  }

  if (isFullscreen) closeFullscreen();
  const album = getSelectedAlbum();
  const snapshot = rawSearch?.snapshot ?? duplicateSearch?.snapshot ?? semanticSearch?.snapshot ?? captureViewSnapshot(album);
  duplicateSearch = null; // a duplicate search in progress ends here; the view saved above is the one to go back to
  renderDuplicateBanner();
  semanticSearch = null; // same for a content search
  renderSemanticBanner();
  clearAlbumSelection();
  syncSmartAlbumWithSelection();
  resetAllFilters();
  applyFilterState(state);
  setIncludeSubfoldersTemporarily(true);
  currentFolderFilter = folder; extraFolderFilters = [];
  rawSearch = { name, excludeDir: excluded, nameStem, snapshot };
  renderFolderTree();
  await loadPhotos();
  if (missing.length) {
    showWriteToast(t('Not used (no data in this image): {list}', { list: missing.map(key => t(RAW_CRITERION_LABELS[key])).join(', ') }));
  }
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
    node.classList.toggle('duplicate-group', Boolean(duplicateSearch)); // stronger look for the groups of the duplicate results
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

gridContainer.addEventListener('scroll', () => {
  if (scrollRenderPending) return;
  scrollRenderPending = true;
  requestAnimationFrame(() => { scrollRenderPending = false; renderVisibleItems(); });
});
window.addEventListener('resize', updateVirtualScroller);

// ==========================================
// GESTION DU PLEIN ÉCRAN ET NAVIGATION
// ==========================================
// Vidéo : lancée directement dans le lecteur par défaut de l'OS, jamais dans la visionneuse interne.
async function openVideoExternally(photo) {
  try {
    await invoke('open_video_externally', { path: photo.path });
  } catch (error) {
    showWriteToast(t('Open failed: {error}', { error: String(error) }));
  }
}

function openFullscreen(index) {
  // Point d'entrée unique du plein écran (double-clic, clavier) : une vidéo part vers le lecteur externe, la sélection reste telle quelle.
  const target = photos[index];
  if (target && isVideoPath(target.path)) {
    openVideoExternally(target);
    return;
  }
  lastSelectedIndex = index;
  selectedIndices.clear();
  selectedIndices.add(index);
  updateUIOnSelection();
  // L'image de la précédente ouverture est retirée : sinon elle s'afficherait un instant, le temps que celle de la photo demandée soit prête.
  if (fullscreenSlot.photo !== target) clearFullscreenImage();
  isFullscreen = true;
  if (target) loadFullscreenPhoto(target);
  fullscreenRatingPinned = false;
  fullscreenRating.classList.add('hidden');
  fullscreenView.classList.remove('hidden');
  // Toujours en vue entière à l'ouverture (le zoom d'une précédente ouverture n'est pas conservé).
  fullscreenSlot.zoom = null;
  fullscreenSlot.center = { x: 0.5, y: 0.5 };
  layoutFullscreenSlot();
  preloadFullscreenImages(index);
  updateFullscreenInfo();
  syncHistogram();
}

function closeFullscreen() {
  stopSlideshow({ silent: true }); // Échap, F ou double-clic : quitter le plein écran arrête aussi le diaporama
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
  layoutFullscreenFaces(fullscreenSlot); // masque les zones de visage
}

export function getIsFullscreen() {
  return isFullscreen;
}

// Positionne et zoome l'image du plein écran avec la même logique que l'aperçu (rien à faire tant que la fenêtre est masquée).
function layoutFullscreenSlot() {
  if (!isFullscreen) return;
  layoutPreviewSlot(fullscreenSlot);
  fullscreenView.classList.toggle('zoomed', fullscreenSlot.zoom !== null);
  layoutFullscreenFaces(fullscreenSlot); // zones de visage calées sur l'image affichée
}

// Affiche la photo en plein écran. Zoom et position repartent de la vue entière seulement quand l'image change : un simple
// changement de note rappelle cette fonction avec la même image. L'image précédente reste affichée jusqu'à ce que la nouvelle soit
// prête, puis dimensions, zoom et position sont appliqués d'un coup (pas d'image étirée entre deux photos).
// Charge l'image de `photo` dans le plein écran, si elle est toujours la photo courante quand son URL est prête.
function loadFullscreenPhoto(photo) {
  getPhotoDisplayUrl(photo).then(url => {
    if (isFullscreen && photos[lastSelectedIndex] === photo) showFullscreenPhoto(photo, url);
  });
}

function showFullscreenPhoto(photo, url) {
  fullscreenSlot.photo = photo;
  if (fullscreenSlot.url === url) { updateFullscreenInfo(); syncHistogram(); notifySlideshowPhotoShown(photo); return; } // même image (ex. changement de note) : la photo associée a pu changer
  fullscreenSlot.url = url;
  const token = ++fullscreenLoadToken;
  const apply = loaded => {
    if (token !== fullscreenLoadToken) return; // une autre photo a été demandée entre-temps
    setSlotImageSize(fullscreenSlot, loaded.naturalWidth, loaded.naturalHeight);
    fullscreenSlot.zoom = null;
    fullscreenSlot.center = { x: 0.5, y: 0.5 };
    updateFullscreenInfo(); // les informations changent en même temps que l'image affichée
    fullscreenImg.src = url;
    layoutFullscreenSlot();
    syncHistogram(); // surcouche d'écrêtage de l'image qui vient d'être affichée
    notifySlideshowPhotoShown(photo); // diaporama : le délai avant la photo suivante court à partir de l'affichage
  };
  const probe = new Image();
  probe.onload = () => apply(probe);
  probe.onerror = () => {
    if (token !== fullscreenLoadToken) return;
    updateFullscreenInfo();
    // Image illisible : l'élément affiche l'erreur, ce qui lance la vérification de fichier manquant (écouteur « error » plus bas).
    fullscreenSlot.naturalWidth = 0;
    fullscreenSlot.naturalHeight = 0;
    fullscreenSlot.zoom = null;
    fullscreenImg.src = url;
    notifySlideshowPhotoShown(photo); // image illisible : le diaporama passe quand même à la suivante après le délai
  };
  probe.src = url;
  if (probe.complete && probe.naturalWidth > 0) { // déjà en mémoire (aperçu, préchargement) : pas d'attente
    probe.onload = null;
    apply(probe);
  }
}

function clearFullscreenImage() {
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
  if (!fullscreenRatingPinned) {
    fullscreenRatingTimeout = setTimeout(() => {
      if (fullscreenPopoverOpen()) return; // une bulle de choix est ouverte : la barre reste, elle repart pour 3 s à la fermeture
      fullscreenRating.classList.add('hidden');
      syncFullscreenMarking();
    }, 3000);
  }
  syncFullscreenMarking();
}

function updateFullscreenRatingStars() {
  const rating = photos[lastSelectedIndex]?.rating || 0;
  fullscreenRating.querySelectorAll('button[data-rating]').forEach(button => button.classList.toggle('active', Number(button.dataset.rating) <= rating));
  if (isFullscreen) syncFullscreenMarking();
}

// INFORMATIONS SUR LA PHOTO EN PLEIN ÉCRAN (touche D) : nom de fichier (haut, centre), rang dans la liste parcourue (haut, droite),
// EXIF sur deux lignes (bas, gauche) et date de prise de vue en toutes lettres (bas, centre). Le choix affiché / masqué est mémorisé.
let fullscreenInfoVisible = false;
fullscreenInfoVisible = readBool('fullscreenInfoVisible');
const fullscreenInfo = document.getElementById('fullscreen-info');
const fullscreenInfoName = document.getElementById('fullscreen-info-name');
const fullscreenInfoRank = document.getElementById('fullscreen-info-rank');
const fullscreenInfoExifLines = [...document.querySelectorAll('#fullscreen-info-exif > div')];
const fullscreenInfoDate = document.getElementById('fullscreen-info-date');
const fullscreenInfoTitle = document.getElementById('fullscreen-info-title');
const fullscreenInfoDescription = document.getElementById('fullscreen-info-description');

// « samedi 12 septembre 2026, 12h36 » (l'heure n'est ajoutée que si la date EXIF en contient une).
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

// Fabricant + modèle, sans répéter le fabricant quand le modèle le contient déjà (« NIKON CORPORATION » + « NIKON D850 » -> « NIKON D850 »).
function fullscreenCameraName(photo) {
  const make = (photo.manufacturer || '').trim();
  const model = (photo.camera_model || '').trim();
  if (!model) return make;
  const makeWord = make.split(/\s+/)[0].toLowerCase();
  return make && !model.toLowerCase().startsWith(makeWord) ? `${make} ${model}` : model;
}

function updateFullscreenInfo() {
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
    [photo.focal_length, photo.shutter_speed ? formatShutterSpeed(photo.shutter_speed) : '', photo.iso ? `ISO ${photo.iso}` : ''],
  ].map(parts => parts.filter(Boolean).join(' · '));
  fullscreenInfoExifLines.forEach((line, i) => { line.textContent = lines[i] || ''; line.hidden = !lines[i]; });
  syncFullscreenMarking();
}

// RATING, COLOR AND PICK IN FULLSCREEN. Two places show them: the row under the file name (R; stars, color dot and pick flag are
// clickable and behave like the marking bar of the grid: the dot and the flag open a choice popover) and, when the info overlay is on
// while that row is hidden, a read-only summary at the bottom right (above the histogram if it is displayed).
const fullscreenColorButton = document.getElementById('fullscreen-color-button');
const fullscreenColorPopover = document.getElementById('fullscreen-color-popover');
const fullscreenPickButton = document.getElementById('fullscreen-pick-button');
const fullscreenPickPopover = document.getElementById('fullscreen-pick-popover');
const fullscreenMarking = document.getElementById('fullscreen-marking');
const fullscreenMarkingStars = document.getElementById('fullscreen-marking-stars');
const fullscreenMarkingColor = document.getElementById('fullscreen-marking-color');
const fullscreenMarkingPick = document.getElementById('fullscreen-marking-pick');

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
function syncFullscreenMarking() {
  const photo = photos[lastSelectedIndex];
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

function toggleFullscreenInfo() {
  fullscreenInfoVisible = !fullscreenInfoVisible;
  try { localStorage.setItem('fullscreenInfoVisible', String(fullscreenInfoVisible)); } catch { /* non mémorisé */ }
  updateFullscreenInfo();
}

function preloadFullscreenImages(index) {
  const keep = new Set();
  const wanted = [];
  for (let i = Math.max(0, index - 2); i <= Math.min(photos.length - 1, index + 2); i++) wanted.push(i);
  // Diaporama : la photo suivante n'est pas forcément voisine (ordre aléatoire), elle est préchargée aussi.
  const nextSlideshowIndex = isSlideshowActive() ? photos.indexOf(peekNextSlideshowPhoto()) : -1;
  if (nextSlideshowIndex >= 0) wanted.push(nextSlideshowIndex);
  for (const i of wanted) {
    keep.add(i);
    if (!fullscreenImageCache.has(i)) {
      const image = new Image();
      fullscreenImageCache.set(i, image);
      const photoPath = photos[i].path;
      const photo = photos[i];
      image.onerror = () => checkPhotoMissing(photoPath);
      getPhotoDisplayUrl(photo).then(url => {
        if (url && fullscreenImageCache.get(i) === image) {
          image.src = url;
        }
      });
    }
  }
  for (const cachedIndex of fullscreenImageCache.keys()) if (!keep.has(cachedIndex)) fullscreenImageCache.delete(cachedIndex);
}

// Navigation à la molette en plein écran ; avec Ctrl, la molette zoome autour du curseur (comme dans l'aperçu) au lieu de changer de photo.
fullscreenView.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) {
    const steps = wheelZoomSteps(e);
    if (steps) zoomPreviewSteps(-steps, previewAnchorAt(fullscreenSlot, e.clientX, e.clientY), fullscreenSlot);
    return;
  }
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

// Plein écran zoomé : on déplace l'image en la faisant glisser à la souris (comme dans l'aperçu) ; le zoom se commande au clavier (+ / - / *) ou par Ctrl + molette.
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
  showZoomIndicator(fullscreenSlot); // <-- Déclenche le badge pendant le déplacement en plein écran
});
function endFullscreenDrag(event) {
  if (!fullscreenDrag || event.pointerId !== fullscreenDrag.pointerId) return;
  fullscreenDrag = null;
  fullscreenView.classList.remove('dragging');
}
fullscreenView.addEventListener('pointerup', endFullscreenDrag);
fullscreenView.addEventListener('pointercancel', endFullscreenDrag);
// Redimensionnement de la fenêtre pendant le plein écran : la vue entière et le centre sont recalculés.
new ResizeObserver(() => layoutFullscreenSlot()).observe(fullscreenView);
// Image qui ne se charge pas (fichier supprimé hors de l'application) : vérification puis retrait du catalogue si besoin.
// Le backend revérifie sur le disque : une erreur sur une photo qui existe encore ne retire rien.
fullscreenImg.addEventListener('error', () => {
  const path = photos[lastSelectedIndex]?.path;
  if (path && fullscreenImg.getAttribute('src')) checkPhotoMissing(path);
});
fullscreenRating.addEventListener('click', event => event.stopPropagation());
fullscreenRating.querySelectorAll('button[data-rating]').forEach(button => button.addEventListener('click', () => setSelectionRating(Number(button.dataset.rating))));

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
  if (semanticSearch?.keyword) renderSemanticKeywordActions();
  refreshDescriptionPanel();
  pruneCompareSubSelection();
  renderVisibleItems(); 
  updateRatingAction();
  updateColorAction();
  renderPreview();
  if (selectedIndices.size > 0 && photos[lastSelectedIndex]) {
    const photo = photos[lastSelectedIndex];
    // Image pleine résolution (et extraction de l'aperçu d'un RAW) seulement plein écran ouvert : openFullscreen la charge à l'ouverture.
    if (isFullscreen) loadFullscreenPhoto(photo);

    updateFullscreenRatingStars();
    if (isFullscreen) preloadFullscreenImages(lastSelectedIndex);

    document.getElementById('exif-filename').textContent = photo.filename || photo.path.split(/[\\/]/).pop() || '-';
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
  }
  // Groupe Lieu : positions de toute la sélection, la photo active mise en avant (voir location-panel.js).
  refreshLocation([...selectedIndices].map(index => photos[index]).filter(Boolean), photos[lastSelectedIndex]);
  refreshMapMode(); // mode Carte ouvert : sélection mise en évidence sur la carte
  refreshInfoRows();
  syncHistogram(); // histogramme de la photo courante
}

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

// `action` (facultatif) : { label, onClick } ajoute un bouton au toast (ex. « Annuler ») et le garde plus longtemps à l'écran.
function showWriteToast(message, isWriting = false, action = null, duration = null) {
  const toast = document.getElementById('write-toast');
  if (!toast) return;
  clearTimeout(writeToastTimeout);
  toast.textContent = message;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      toast.classList.add('hidden');
      action.onClick();
    });
    toast.append(button);
  }
  toast.classList.remove('hidden');
  toast.classList.toggle('writing', isWriting);
  if (!isWriting) writeToastTimeout = setTimeout(() => toast.classList.add('hidden'), duration ?? (action ? 8000 : 3500));
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
  });
}

// Échecs d'écriture de la note, de la couleur ou du fanion : leur nombre et la raison du premier (ex. ExifTool introuvable).
function failureSummary(failures) {
  return failures.length ? ` · ${tp('{count} failure', failures.length)} (${failures[0].error})` : '';
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
function writeMarking(targets, fields, { startMessage, doneMessage, apply, refilter, property = null, restore = null }) {
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
    forgetCachedImagePaths(successful.map(photo => photo.path));
    if (successful.length && refilter()) applyPhotoFilters({ keepState: true });
    else updateUIOnSelection();
    if (markedProperty === 'rating') updateFullscreenRatingStars();
    // Only the photos actually written can be given their previous value back.
    const undoEntry = !restore && successful.length
      ? pushUndo(() => undoMarking(markedProperty, successful.map(photo => ({ id: photo.id, path: photo.path, value: previous.get(photo.id) })), refilter))
      : null;
    const stopped = result.cancelled ? ` · ${t('Metadata writing stopped: {count} not processed', { count: result.cancelled })}` : '';
    // Failures: the toast names the first one, its "Details" button lists them all. Otherwise the button undoes this write.
    const action = failureDetailsAction(t('Metadata could not be written to some files'), result.failed) ?? (undoEntry ? undoToastAction(undoEntry) : null);
    showWriteToast(`${doneMessage(successful.length)}${failureSummary(result.failed)}${stopped}`, false, action);
  };
  const run = () => {
    // Photos of a move in progress or waiting would change path while being written (the backend lock makes the write fail cleanly
    // anyway): refused with the same message as the other file operations. Only those photos: the others stay editable during a long
    // transfer. A rename (photoMoveRunning, no path list, a split second) blocks everything. Copies and resizing do not move files.
    const moving = new Set(scanTasks.filter(task => task.kind === 'move').flatMap(task => task.args?.paths ?? []));
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
function undoMarking(property, entries, refilter) {
  const byId = new Map(loadedPhotos.map(photo => [photo.id, photo]));
  const targets = entries.map(entry => byId.get(entry.id) ?? { id: entry.id, path: entry.path });
  const values = new Map(entries.map(entry => [entry.id, entry.value]));
  return writeMarking(targets, {}, {
    property,
    restore: values,
    startMessage: t('Undoing…'),
    doneMessage: count => tp('Change undone for {count} photo', count),
    apply: photo => { photo[property] = values.get(photo.id); },
    refilter,
  });
}

// ==========================================
// UNDO (Ctrl+Z, "Undo" button of the toasts)
// ==========================================
// Last actions on the files that can be undone (rating, color, pick flag, lossless rotation), the latest at the end. Each entry knows how to
// undo itself; an undo is not stacked again. The toast button undoes its own action, Ctrl+Z the latest one.
const MAX_UNDO = 20;
const undoStack = [];

function pushUndo(run) {
  const entry = { run };
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  return entry;
}

// Undoes `entry` (default: the latest action), once: it leaves the stack. False if there is nothing (left) to undo.
function runUndo(entry = undoStack.at(-1)) {
  const index = entry ? undoStack.lastIndexOf(entry) : -1;
  if (index < 0) return false;
  undoStack.splice(index, 1);
  entry.run();
  return true;
}

const undoToastAction = entry => ({ label: t('Undo'), onClick: () => runUndo(entry) });

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
  });
  if (isFullscreen && anyWritten) showFullscreenRatingForAWhile();
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
function rotatePhotos(quarterTurns, explicitTargets = null, { undo = false } = {}) {
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
    const written = new Map(result.written.map(entry => [entry.id, entry.view_fix]));
    const turned = targets.filter(photo => written.has(photo.id));
    for (const photo of turned) photo.view_fix = written.get(photo.id);
    refreshRotatedPhotos(turned, quarterTurns);
    const turnedEntries = turned.map(photo => ({ id: photo.id, path: photo.path }));
    const undoEntry = turned.length && !undo ? pushUndo(() => undoRotation(turnedEntries, quarterTurns)) : null;
    const stopped = result.cancelled ? ` · ${t('Metadata writing stopped: {count} not processed', { count: result.cancelled })}` : '';
    const message = `${undo ? tp('Rotation undone for {count} photo', turned.length) : tp('{count} photo turned', turned.length)}${failureSummary(result.failed)}${stopped}`;
    // Failures take the toast button (their details); otherwise "Undo".
    const action = failureDetailsAction(t('Metadata could not be written to some files'), result.failed)
      ?? (undoEntry ? undoToastAction(undoEntry) : null);
    showWriteToast(message, false, action);
  };
  const run = () => {
    // Same rule as the other metadata writes (see writeMarking): photos of a move in progress are not written.
    const moving = new Set(scanTasks.filter(task => task.kind === 'move').flatMap(task => task.args?.paths ?? []));
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
function undoRotation(entries, quarterTurns) {
  const byId = new Map(loadedPhotos.map(photo => [photo.id, photo]));
  const targets = entries.map(entry => byId.get(entry.id) ?? entry);
  return rotatePhotos(-quarterTurns, targets, { undo: true });
}

// Turned photos: their cached images are regenerated by the backend; the grid, the preview and the fullscreen view load them again.
function refreshRotatedPhotos(turned, quarterTurns) {
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
  previewSignature = ''; // the preview cells are created again
  updateVirtualScroller();
  updateUIOnSelection();
  if (isFullscreen && turnedPaths.has(photos[lastSelectedIndex]?.path)) loadFullscreenPhoto(photos[lastSelectedIndex]);
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
// H      : Histogram: off / displayed / displayed with clippings
// I      : Info sheet
// J      : Info panel
// K      : Keywords panel
// Ctrl+K : Keywords panel: all keywords / keywords of the selection
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
  if (e.ctrlKey || e.metaKey || isFullscreen || document.querySelector('.modal:not(.hidden)')) return;
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
  if (isFacesViewOpen() && !isFullscreen && (e.key.toLowerCase() !== 'g' || hasFaceSelection())) return;
  if (isPersonsViewOpen() && !isFullscreen && e.key.toLowerCase() !== 'g') return; // vue Personnes : idem
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
    if (!compareMode && !isFullscreen && !document.querySelector('.modal:not(.hidden)')) toggleSelectAllPhotos();
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
  // Ctrl+Z: undoes the latest rating, color, pick flag or lossless rotation (text fields keep their own Ctrl+Z: this handler ignores them).
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
    if (document.querySelector('.modal:not(.hidden)')) return;
    e.preventDefault();
    if (!e.repeat && !runUndo()) showWriteToast(t('Nothing to undo'));
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
  if (e.key.toLowerCase() === 'r' && isFullscreen) {
    fullscreenRatingPinned = !fullscreenRatingPinned;
    clearTimeout(fullscreenRatingTimeout);
    if (fullscreenRatingPinned) fullscreenRating.classList.remove('hidden');
    else fullscreenRating.classList.add('hidden');
    syncFullscreenMarking();
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
  // H : histogramme désactivé -> affiché -> affiché avec écrêtage (réglages des Options d'affichage), avec un toast. Pas derrière une fenêtre ouverte.
  if (e.key.toLowerCase() === 'h' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.repeat && !document.querySelector('.modal:not(.hidden)')) {
    e.preventDefault();
    cycleHistogramState();
    return;
  }
  // Informations sur la photo (nom, date, EXIF, rang) en plein écran
  if (e.key.toLowerCase() === 'd' && isFullscreen && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector('.modal:not(.hidden)')) {
    toggleFullscreenInfo();
    return;
  }
  // Zones de visage en plein écran et dans l'aperçu (lecture des visages activée dans les Paramètres)
  if (e.key.toLowerCase() === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector('.modal:not(.hidden)')) {
    if (toggleFaceRegions()) return;
  }
  // I, E, C et Suppr : sans modificateur, et jamais derrière une fenêtre ouverte (Paramètres, question…), où elles viseraient les photos masquées.
  const modalOpen = Boolean(document.querySelector('.modal:not(.hidden)'));
  const plainKey = !e.ctrlKey && !e.metaKey && !e.altKey && !modalOpen;
  // Modale info
  if (e.key.toLowerCase() === 'i' && plainKey) {
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
  // F2 : renomme la photo sélectionnée, comme « Renommer… » du menu contextuel. Une seule photo ; une sélection multiple ne fait rien.
  // Les dossiers ne se renomment que par le menu contextuel (avec un aperçu actif, F2 viserait la photo de l'aperçu).
  if (e.key === 'F2' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (e.repeat || document.querySelector('.modal:not(.hidden)')) return;
    const targetPhotos = commandTargetPhotos();
    if (targetPhotos.length === 1) renamePhoto(targetPhotos[0]);
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
  if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey && !e.altKey && !isFullscreen && !document.querySelector('.modal:not(.hidden)')) {
    e.preventDefault();
    if (!e.repeat) toggleTopBar();
    return;
  }
  // Bascule des panneaux et modes :
  // X : mode Comparer | P : aperçu | N : panneau Filtres (gauche) | J : panneau Info (droite)
  // Inactif en plein écran ou lorsqu'une fenêtre modale est ouverte.
  // J / K / D : panneau de droite, onglet Info, Mots-clés ou Description (voir keywords-panel.js). Inactif en plein écran (où D affiche les
  // informations de la photo, ci-dessus) ou lorsqu'une fenêtre modale est ouverte.
  const sideTabByKey = { j: 'info', k: 'keywords', d: 'description' };
  const sideTab = sideTabByKey[e.key.toLowerCase()];
  if (sideTab && !e.ctrlKey && !e.metaKey && !e.altKey && !isFullscreen && !document.querySelector('.modal:not(.hidden)')) {
    e.preventDefault();
    if (!e.repeat) handleSideTabShortcut(sideTab);
    return;
  }
  const panelToggleButtons = {
    x: 'btn-toggle-compare',
    p: 'btn-toggle-preview',
    n: 'btn-toggle-sidebar',
  };
  const targetToggleBtnId = panelToggleButtons[e.key.toLowerCase()];
  if (targetToggleBtnId && !e.ctrlKey && !e.metaKey && !e.altKey && !isFullscreen && !document.querySelector('.modal:not(.hidden)')) {
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
  const advanceAfter = altAdvance && (isFullscreen || selectedIndices.size === 1);
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
    const zoomTarget = isFullscreen ? null : hoveredPreviewSlot;
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
  } else if (e.key === 'Escape') {
    if (isFullscreen && guideModal.classList.contains('hidden')) closeFullscreen(); // guide ouvert par-dessus le plein écran : Échap ne ferme que le guide
    else if (!isFullscreen && rawSearch && !document.querySelector('.modal:not(.hidden)') && !isDatePickerOpen()) exitRawSearch(); // « Trouver le RAW » : retour à la vue d'avant
    else if (!isFullscreen && duplicateSearch && !document.querySelector('.modal:not(.hidden)') && !isDatePickerOpen()) exitDuplicateSearch(); // duplicate search: back to the previous view
    else if (!isFullscreen && semanticSearch && !document.querySelector('.modal:not(.hidden)') && !isDatePickerOpen()) exitSemanticSearch(); // content search: same
  } else if (e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (isFullscreen) closeFullscreen();
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
  for (let f of folders) {
    const li = document.createElement('li');
    li.className = 'settings-folder-item';
    // Built as elements: a folder path is text, never markup (a folder may be named "<img …>").
    const label = document.createElement('span');
    label.title = f.path;
    label.textContent = f.path;
    const remove = document.createElement('button');
    remove.className = 'btn-remove-folder';
    remove.textContent = t('Remove');
    li.append(label, remove);
    remove.addEventListener('click', async () => {
      dropScanTasksForFolder(f.path); // un dossier retiré ne doit plus être scanné
      folders = await invoke('remove_folder', { id: f.id, path: f.path });
      if (currentFolderFilter === f.path) { currentFolderFilter = null; rememberCurrentFolder(); }
      renderFolderTree();
      renderSettingsFolderList();
      loadPhotos();
    });
    settingsFolderList.appendChild(li);
  }
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
const STATIC_MODALS = '#settings-modal, #about-modal, #update-modal, #guide-modal, #display-modal, #sort-modal, #tasks-modal';
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
      folders = await invoke('add_folder', { path: dir });
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

let toggleImmersiveFromMenu = () => {}; // set by the window-controls block above (immersive mode lives in its scope)
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
  if (isFullscreen || document.querySelector('.modal:not(.hidden)')) return;
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
  else if (event.buttons === 0 && !isFullscreen && !document.querySelector('.modal:not(.hidden)')) topBar.classList.add('peek');
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
// L'option « Aucun » est grisée en disposition Encadrée ; si elle était choisie, l'espacement passe à « Petit » (et ce choix est mémorisé).
function syncThumbnailSpacingWithLayout() {
  const framed = thumbnailLayout === 'framed';
  thumbnailSpacingSelect.querySelector('option[value="none"]').disabled = framed;
  if (framed && thumbnailSpacing === 'none') {
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
// ==========================================
// TRI DES MINIATURES
// ==========================================
// Le tri s'applique à la liste affichée (photos, voir applyPhotoFilters) : il détermine donc à la fois l'ordre de la grille et celui du
// défilement en plein écran. Il est fait côté interface : la date de modification vient de la base, la date de prise de vue est celle du filtre de date.
const sortModal = document.getElementById('sort-modal');
const sortButton = document.getElementById('btn-open-sort');
const SORT_KEY_LABELS = { taken: 'Date taken', modified: 'Date modified', name: 'Filename' };
const sortNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }); // « IMG_2 » avant « IMG_10 », comme l'Explorateur

// Valeur de tri d'une photo ; null = information absente (ces photos restent en fin de liste, quel que soit l'ordre).
function photoSortValue(photo) {
  if (sortKey === 'name') return photo.filename || photo.path.split(/[\\/]/).pop() || '';
  if (sortKey === 'modified') return photo.modified > 0 ? photo.modified : null;
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
    if (!(photo.modified > 0)) return null;
    const date = new Date(photo.modified);
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
  if (duplicateSearch && photos.length > 0) return computeDuplicateSeparators();
  if (semanticSearch) return []; // results are sorted by relevance: no separator
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

function comparePhotosForSort(a, b) {
  // Keyword filter with suggestions: photos carrying every keyword first, then the fewest guessed keywords, the chosen sort inside each block.
  if (keywordGuesses.size) {
    const guesses = (keywordGuesses.get(a.id)?.length ?? 0) - (keywordGuesses.get(b.id)?.length ?? 0);
    if (guesses) return guesses;
  }
  if (semanticSearch?.carried.size) {
    // Photos carrying the typed keyword come first, then the content results by decreasing relevance. Inside the first block: the content score
    // ("Score"), or the sort options of the toolbar ("Grid", the rest of this function).
    const carriedA = semanticSearch.carried.has(a.id);
    if (carriedA !== semanticSearch.carried.has(b.id)) return carriedA ? -1 : 1;
    if (!carriedA) return semanticRankOrder(a, b);
    if (semanticSortMode === 'score') {
      const byScore = semanticRankOrder(a, b); // the answer is already sorted by decreasing score; photos without a score (not analysed) last
      if (byScore) return byScore;
    }
  } else if (semanticSearch) {
    // Content search results: by decreasing relevance (the source photo of a similar-content search first).
    return semanticRankOrder(a, b);
  }
  // Duplicate results: groups in the chosen group order, members best first inside each group.
  if (duplicateSearch) {
    const orderA = duplicateSearch.order.get(a.path);
    const orderB = duplicateSearch.order.get(b.path);
    if (orderA && orderB) return duplicateSearch.position.get(orderA.group) - duplicateSearch.position.get(orderB.group) || orderA.rank - orderB.rank;
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
  localStorage.setItem('photoSortKey', sortKey);
  localStorage.setItem('photoSortOrder', sortOrder);
  localStorage.setItem('photoDateSeparator', dateSeparator);
  localStorage.setItem('photoNameSeparator', nameSeparator);
  updateSortUI();
  fullscreenImageCache.clear(); // le cache de préchargement est indexé par position dans la liste
  // Capped list: the backend picked its photos in the previous sort (e.g. the newest ones), so the new sort needs another set.
  if (photoListCap) {
    loadPhotos();
    return;
  }
  applyPhotoFilters({ keepState: true }); // sélection conservée (retrouvée par chemin)
  scrollToPhotoIndex(lastSelectedIndex);
}

function openSortModal() {
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
  updateRatingAction();
  updateFilteredPhotosCount();
  renderFilterSummaries(); // résumés des filtres dans la langue courante (dates, infobulles, étiquettes)
  updateDateFilterUI(parseDateFilter(dateFilterInput.value).error);
  updateSortUI();
  updateVirtualScroller(); // libellés des séparateurs (jours, mois…) dans la nouvelle langue
  datePicker.setAttribute('aria-label', t('Choose a date or a range'));
  if (isDatePickerOpen()) {
    renderDatePicker();
    positionDatePicker();
  }
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
  if (mainContent.classList.contains('preview-hidden') && !mainContent.classList.contains('map-mode')) return; // la carte garde son panneau sans aperçu
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

// Fullscreen row (R): the same choices as the marking bar, in popovers opening downwards (see syncFullscreenMarking).
fullscreenColorPopover.append(createMarkingColors());
fullscreenPickPopover.append(createMarkingPick());
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
// Keyword filter field: suggestion list; Alt+Enter / Alt+click excludes the keyword. With no suggestion, Enter takes the typed text as is
// (a keyword missing from the loaded photos can still be filtered on).
keywordFilterSuggest = createFilterSuggest({
  input: document.getElementById('keyword-filter-input'),
  list: document.getElementById('keyword-filter-suggestions'),
  getOptions: () => keywordFilterOptions.filter(option => !keywordFilters.includes(option.value) && !excludedKeywordFilters.includes(option.value)),
  onPick: (value, exclude, text) => addKeywordFilter(value ?? text, exclude),
  emptyText: 'No matching keyword',
});
document.getElementById('filename-filter-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); addFilenameFilter(event.target.value, event.altKey); }
});
document.getElementById('show-empty-folders-toggle').checked = showEmptyFolders;
document.getElementById('show-empty-folders-toggle').addEventListener('change', event => {
  showEmptyFolders = event.target.checked;
  localStorage.setItem('showEmptyFolders', String(showEmptyFolders));
  refreshDiskFolders();
});
if (showEmptyFolders) refreshDiskFolders();
document.getElementById('show-folder-counts-toggle').checked = showFolderCounts;
document.getElementById('show-folder-counts-toggle').addEventListener('change', event => {
  showFolderCounts = event.target.checked;
  localStorage.setItem('showFolderCounts', String(showFolderCounts));
  folderCountsSignature = ''; // force la relecture à la prochaine activation
  renderFolderTree();
});
document.getElementById('recursive-folder-toggle').checked = includeSubfolders;
document.getElementById('recursive-folder-toggle').addEventListener('change', event => {
  const wanted = event.target.checked;
  abandonRawSearch(); // la recherche du RAW impose les sous-dossiers : changer l'option la termine
  abandonSemanticSearch(); // the scope of a "view" search would no longer match what is shown
  includeSubfolders = wanted;
  event.target.checked = wanted;
  localStorage.setItem('includeSubfolders', String(includeSubfolders));
  loadPhotos();
});
// ==========================================
// FILE D'ATTENTE DES TÂCHES (scan d'un dossier ajouté, relecture de la collection ou d'un dossier)
// ==========================================
// Une seule tâche de scan s'exécute à la fois, les autres attendent leur tour dans l'ordre de leur demande. Chaque tâche a son toast (la tâche en cours en bas,
// avec son avancement ; les suivantes au-dessus, « En attente ») et sa ligne dans la fenêtre « Actions en cours » (bouton sablier de la barre du haut), qui permet
// d'arrêter la tâche en cours ou de retirer une tâche en attente. Le backend publie l'avancement dans « scan-progress » avec l'identifiant de la tâche.
// { id, kind: 'add' | 'rescan-all' | 'rescan-folder' | 'integrity', path (null = toute la collection), command, args, labelKey, labelParams,
//   status: 'waiting' | 'running' | 'paused' | 'ready', percent, stopRequested, toastHidden,
//   firstStartedAt (resumable scans: start of their first run), pauseRequested }
const scanTasks = [];
let scanTaskCounter = 0;
let scanPumpActive = false;
let transientToast = null; // toast d'une opération courte qui n'est pas un scan (déplacement des données, cache des miniatures) : showTaskToast / hideTaskToast
const taskToastsContainer = document.getElementById('task-toasts');
const tasksButton = document.getElementById('btn-open-tasks');
const tasksModal = document.getElementById('tasks-modal');
const tasksList = document.getElementById('tasks-list');
const taskToastElements = new Map(); // tâche -> son toast
const taskRowElements = new Map(); // tâche -> sa ligne dans la fenêtre des actions

const folderBaseName = path => path.split(/[\\/]/).filter(Boolean).pop() || path;
const normalizeTaskPath = path => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const taskName = task => task.displayName ?? t(task.labelKey, task.labelParams);
const taskPercent = task => Math.max(0, Math.min(100, Math.round(task.percent)));

// A 'ready' task has finished and only waits for the user to show its results: it stays in the list (and warns before quitting) but is not work in
// progress, so it never holds back the queue, the library synchronisation or the reload shortcut.
const activeTaskCount = () => scanTasks.filter(task => task.status !== 'ready' && task.status !== 'paused').length;

// Content analysis: its own lane, in parallel with the main queue (see pumpSemanticQueue). It counts in activeTaskCount (closing the application,
// reloading the page) but not in foregroundTaskCount: a library synchronisation never waits for it (the analysis pauses itself instead).
const isSemanticLaneTask = task => task.kind === 'semantic';
const foregroundTaskCount = () => scanTasks.filter(task => task.status !== 'ready' && task.status !== 'paused' && !isSemanticLaneTask(task)).length;

// Scans that can be paused: the scan stops (photos already read stay in the catalogue), the task stays in the list without holding back the queue,
// and resuming puts it first in line; the backend then skips the files read since its first start (`resumeSince`, see run_scan).
// Unfinished ones are remembered (`pausedScanTasks`) and come back paused at the next launch.
const RESUMABLE_TASK_KINDS = ['add', 'rescan-all', 'rescan-folder'];
const isResumableTask = task => RESUMABLE_TASK_KINDS.includes(task.kind);

function taskStatusText(task) {
  if (task.status === 'ready') return tp('Results ready: {count} group', task.groupCount);
  if (task.status === 'waiting') return t('Waiting');
  if (task.status === 'paused') return `${taskPercent(task)} % · ${t('Paused')}`;
  if (task.pauseRequested) return t('Pausing…');
  if (task.stopRequested) return t('Stopping…');
  if (isSemanticLaneTask(task)) {
    // Paused while another task works; otherwise the progress and the time left estimated by the backend.
    if (task.paused) return `${taskPercent(task)} % · ${t('Paused (other task running)')}`;
    const parts = [`${taskPercent(task)} %`];
    if (task.total > 0) parts.push(`${task.done.toLocaleString()} / ${task.total.toLocaleString()}`);
    if (task.remainingSeconds != null) parts.push(t('{time} left', { time: `~${formatTaskDuration(task.remainingSeconds * 1000)}` }));
    return parts.join(' · ');
  }
  return `${taskPercent(task)} %`;
}

// Durée lisible : « 45 s », « 3 min 05 s », « 1 h 02 min ».
function formatTaskDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  // Au-delà de 5 minutes, les secondes n'apportent rien (et feraient scintiller l'affichage) : arrondi à la minute.
  if (total >= 300) {
    const roundedMinutes = Math.round(total / 60);
    const h = Math.floor(roundedMinutes / 60);
    return h > 0 ? `${h} h ${String(roundedMinutes % 60).padStart(2, '0')} min` : `${roundedMinutes} min`;
  }
  if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
  return `${seconds} s`;
}

// Temps écoulé et estimation du temps restant d'une tâche en cours (extrapolation linéaire de l'avancement ;
// l'estimation attend quelques secondes et 2 % d'avancement pour ne pas afficher une valeur absurde).
function taskTimingText(task) {
  if (task.status !== 'running' || !task.startedAt) return '';
  const elapsed = Date.now() - task.startedAt;
  const parts = [formatTaskDuration(elapsed)];
  const percent = taskPercent(task);
  // The content analysis gives its own estimate (taskStatusText): an extrapolation from the elapsed time would count the pauses.
  if (!isSemanticLaneTask(task) && !task.stopRequested && percent >= 3 && percent < 100 && elapsed >= 4000) {
    parts.push(t('{time} left', { time: `~${formatTaskDuration(elapsed * (100 - percent) / percent)}` }));
  }
  return parts.join(' · ');
}

// Une tâche couvre un dossier quand c'est le sien, l'un de ses sous-dossiers, ou que la tâche relit toute la collection.
function taskCoversFolder(task, path) {
  if (task.path === null) return true;
  const root = normalizeTaskPath(task.path);
  const folder = normalizeTaskPath(path);
  return folder === root || folder.startsWith(`${root}/`);
}

// Place les éléments dans l'ordre voulu sans toucher à ceux qui y sont déjà (un bouton déplacé pendant un clic perdrait ce clic).
function syncChildren(container, wanted) {
  for (const child of [...container.children]) if (!wanted.includes(child)) child.remove();
  wanted.forEach((element, position) => {
    if (container.children[position] !== element) container.insertBefore(element, container.children[position] || null);
  });
}

function buildTaskToast(task) {
  const toast = document.createElement('div');
  toast.className = 'task-toast';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.className = 'task-toast-text';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'task-toast-close';
  close.textContent = '×';
  close.addEventListener('click', () => {
    task.toastHidden = true; // le toast se ferme, la tâche continue (elle reste dans la fenêtre des actions)
    syncTaskUI();
  });
  // Duplicate search finished: "Show" opens the results (the button only appears while the task is 'ready').
  const show = document.createElement('button');
  show.type = 'button';
  show.className = 'task-toast-show';
  show.hidden = true;
  show.addEventListener('click', () => showReadyDuplicateResults(task));
  toast.append(text, show, close);
  return toast;
}

function buildTaskRow(task) {
  const row = document.createElement('li');
  row.className = 'task-item';
  const name = document.createElement('span');
  name.className = 'task-item-name';
  // Barre de progression, puis une ligne « avancement à gauche / temps à droite », puis (vérification d'intégrité) le dossier en cours.
  const bar = document.createElement('div');
  bar.className = 'task-item-bar';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.append(document.createElement('span'));
  const status = document.createElement('span');
  status.className = 'task-item-status';
  const time = document.createElement('span');
  time.className = 'task-item-time';
  time.setAttribute('aria-hidden', 'true'); // chronomètre : pas relu à chaque seconde par les lecteurs d'écran
  const detail = document.createElement('span');
  detail.className = 'task-item-detail';
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'task-item-action';
  action.addEventListener('click', () => (task.status === 'ready' ? showReadyDuplicateResults(task) : removeOrStopTask(task)));
  // A finished duplicate search whose results are not shown yet: "Show" (the main button) or "Dismiss" (this one).
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'task-item-dismiss';
  dismiss.addEventListener('click', () => removeReadyTask(task));
  // Resumable scan: "Pause" (running or waiting) / "Resume" (paused).
  const pause = document.createElement('button');
  pause.type = 'button';
  pause.className = 'task-item-pause';
  pause.addEventListener('click', () => (task.status === 'paused' ? resumeTask(task) : pauseTask(task)));
  const actions = document.createElement('div');
  actions.className = 'task-item-actions';
  actions.append(pause, action, dismiss);
  row.append(name, bar, status, time, detail, actions);
  return row;
}

// Met l'affichage en phase avec les tâches : toasts, lignes de la fenêtre des actions et bouton sablier.
function syncTaskUI() {
  const toastTasks = [...scanTasks, ...(transientToast ? [transientToast] : [])].filter(task => !task.toastHidden);
  const toasts = toastTasks.map(task => {
    let toast = taskToastElements.get(task);
    if (!toast) {
      toast = buildTaskToast(task);
      taskToastElements.set(task, toast);
    }
    toast.classList.toggle('waiting', task.status === 'waiting' || task.status === 'paused');
    const textElement = toast.querySelector('.task-toast-text');
    textElement.textContent = `${taskName(task)} · ${taskStatusText(task)}`;
    const showButton = toast.querySelector('.task-toast-show');
    showButton.hidden = task.status !== 'ready';
    showButton.textContent = t('Show');
    // Dossier en cours d'analyse (vérification d'intégrité), sur une seconde ligne.
    if (task.detail && task.status === 'running') {
      const detail = document.createElement('span');
      detail.className = 'task-toast-detail';
      detail.textContent = task.detail;
      detail.title = task.detail;
      textElement.append(detail);
    }
    const close = toast.querySelector('.task-toast-close');
    close.title = t('Close');
    close.setAttribute('aria-label', t('Close'));
    return toast;
  });
  for (const [task, toast] of taskToastElements) {
    if (!toastTasks.includes(task)) {
      toast.remove();
      taskToastElements.delete(task);
    }
  }
  syncChildren(taskToastsContainer, toasts);

  const rows = scanTasks.map(task => {
    let row = taskRowElements.get(task);
    if (!row) {
      row = buildTaskRow(task);
      taskRowElements.set(task, row);
    }
    row.classList.toggle('waiting', task.status === 'waiting' || task.status === 'paused');
    const name = row.querySelector('.task-item-name');
    name.textContent = taskName(task);
    name.title = taskName(task);
    row.querySelector('.task-item-status').textContent = taskStatusText(task);
    row.querySelector('.task-item-time').textContent = taskTimingText(task);
    const detailElement = row.querySelector('.task-item-detail');
    const detailText = task.detail && task.status === 'running' ? task.detail : '';
    detailElement.textContent = detailText;
    detailElement.title = detailText;
    detailElement.hidden = !detailText;
    const bar = row.querySelector('.task-item-bar');
    bar.setAttribute('aria-valuenow', String(task.status === 'waiting' ? 0 : taskPercent(task)));
    bar.querySelector('span').style.width = `${task.status === 'waiting' ? 0 : taskPercent(task)}%`;
    row.classList.toggle('ready', task.status === 'ready');
    const action = row.querySelector('.task-item-action');
    action.textContent = task.status === 'ready' ? t('Show') : task.status === 'waiting' || task.status === 'paused' ? t('Remove from queue') : t('Stop');
    action.disabled = task.stopRequested;
    const pause = row.querySelector('.task-item-pause');
    pause.hidden = !isResumableTask(task) || !['waiting', 'running', 'paused'].includes(task.status);
    pause.textContent = task.status === 'paused' ? t('Resume') : t('Pause');
    pause.disabled = task.stopRequested;
    const dismiss = row.querySelector('.task-item-dismiss');
    dismiss.hidden = task.status !== 'ready';
    dismiss.textContent = t('Dismiss');
    return row;
  });
  for (const [task, row] of taskRowElements) {
    if (!scanTasks.includes(task)) {
      row.remove();
      taskRowElements.delete(task);
    }
  }
  syncChildren(tasksList, rows);

  const label = `${t('Running tasks')} (${scanTasks.length})`;
  tasksButton.hidden = scanTasks.length === 0;
  // Badge with the number of running + waiting tasks (created on first use).
  let badge = tasksButton.querySelector('.tasks-count-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'tasks-count-badge';
    badge.setAttribute('aria-hidden', 'true'); // the count is already in the button's aria-label
    tasksButton.append(badge);
  }
  badge.textContent = scanTasks.length > 99 ? '99+' : String(scanTasks.length);
  tasksButton.title = label;
  tasksButton.setAttribute('aria-label', label);
}
onLanguageChange(syncTaskUI);

// Toast d'une opération courte hors scan (déplacement des données, vidage du cache) : un seul à la fois, affiché avec son pourcentage.
function showTaskToast(name, percent) {
  if (transientToast) {
    transientToast.displayName = name;
    transientToast.percent = percent;
  } else {
    transientToast = { displayName: name, percent, status: 'running', stopRequested: false, toastHidden: false };
  }
  syncTaskUI();
}

function hideTaskToast() {
  transientToast = null;
  syncTaskUI();
}

// Tant que la fenêtre est ouverte, l'affichage est rafraîchi chaque seconde pour faire avancer le temps écoulé.
let tasksClockTimer = null;
function openTasksModal() {
  // The modal lists every queued task, so their toasts would only duplicate it: close them (the transient toast is not in the modal and stays).
  for (const task of scanTasks) task.toastHidden = true;
  syncTaskUI();
  tasksModal.classList.remove('hidden');
  clearInterval(tasksClockTimer);
  tasksClockTimer = setInterval(syncTaskUI, 1000);
}
function closeTasksModal() {
  tasksModal.classList.add('hidden');
  clearInterval(tasksClockTimer);
  tasksClockTimer = null;
}
// Fermeture de l'application : si des tâches de la file sont actives ou en attente, le dire avant de les interrompre. Renvoie true si l'on peut quitter ;
// « Afficher les tâches » et « Annuler » gardent l'application ouverte (le premier ouvre en plus la fenêtre des actions).
async function confirmCloseWithRunningTasks() {
  // Paused scans are remembered and come back at the next launch: nothing to warn about.
  const pending = scanTasks.filter(task => task.status !== 'paused');
  if (pending.length === 0) return true;
  const active = activeTaskCount();
  // Interrupted scans are remembered too (saveResumableTasks): they come back paused.
  const resumableNote = pending.some(isResumableTask) ? ` ${t('Interrupted scans are kept paused and can be resumed at the next launch.')}` : '';
  const choice = await choiceDialog({
    title: t('Tasks in progress'),
    // Only finished searches left: nothing is interrupted, but their results are lost.
    message: active > 0
      ? `${tp('{count} task is running. Quitting now interrupts it.', active, { count: active })}${resumableNote}`
      : tp('{count} search result has not been shown yet. Quitting now discards it.', pending.length, { count: pending.length }),
    buttons: [
      { label: t('Quit anyway'), value: 'quit', tone: 'red' },
      { label: t('Show tasks'), value: 'show', primary: true },
      { label: t('Cancel'), value: 'cancel', cancel: true },
    ],
  });
  if (choice === 'show') openTasksModal();
  if (choice === 'quit') saveResumableTasks(); // latest progress of the interrupted scans
  return choice === 'quit';
}

tasksButton.addEventListener('click', openTasksModal);
document.getElementById('btn-close-tasks').addEventListener('click', closeTasksModal);
tasksModal.addEventListener('click', event => {
  if (event.target === tasksModal) closeTasksModal();
});
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || tasksModal.classList.contains('hidden')) return;
  event.preventDefault();
  closeTasksModal();
});

// Un rechargement de la page (F5, Ctrl+R) réinitialise l'interface : la file des tâches, qui n'existe que côté interface, serait perdue alors que le
// backend continue de travailler (la modale n'afficherait plus rien, et une nouvelle tâche s'ajouterait à une autre encore active). Tant qu'une tâche
// existe, le rechargement est donc refusé, avec une explication.
window.addEventListener('keydown', event => {
  const isReload = event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r');
  if (!isReload || activeTaskCount() === 0) return;
  event.preventDefault();
  showWriteToast(t('Reload disabled while tasks are running'));
});

// Avancement des tâches de scan (pourcentage de la tâche, jamais en recul si deux événements arrivent dans le désordre).
listenToBackend('scan-progress', event => {
  const { taskId, percent, done, total, remainingSeconds, paused } = event.payload || {};
  const task = scanTasks.find(item => item.id === taskId);
  if (!task || task.status !== 'running') return;
  task.percent = Math.max(task.percent, Number(percent) || 0);
  // Content analysis: photos handled / to handle, time left estimated by the backend (null at first, pauses excluded) and the pause flag.
  if (isSemanticLaneTask(task)) {
    task.done = Number(done) || 0;
    task.total = Number(total) || 0;
    task.remainingSeconds = Number.isFinite(remainingSeconds) ? remainingSeconds : null;
    task.paused = paused === true;
  }
  syncTaskUI();
}).catch(error => console.debug('Progress tracking unavailable', error));

// Dossier en cours d'analyse par une tâche (vérification d'intégrité) : affiché sous le pourcentage, dans le toast et dans la fenêtre des actions.
listenToBackend('scan-detail', event => {
  const { taskId, detail } = event.payload || {};
  const task = scanTasks.find(item => item.id === taskId);
  if (!task || task.status !== 'running') return;
  task.detail = typeof detail === 'string' ? detail : '';
  syncTaskUI();
}).catch(error => console.debug('Current folder tracking unavailable', error));

// Recharge les photos après un rescan. L'arborescence est construite depuis la liste complète de la collection : quand un dossier est
// filtré, cette liste est relue aussi, sinon un sous-dossier découvert par le rescan n'y apparaîtrait pas.
async function reloadPhotosAfterRescan() {
  if (currentFolderFilter !== null) {
    folderTreePhotos = await queryPhotoPage(null);
  }
  await loadPhotos();
  if (showEmptyFolders) refreshDiskFolders(); // dossiers ajoutés ou supprimés sur le disque depuis la dernière lecture
}

// Retire une tâche en attente de la file, ou demande l'arrêt de la tâche en cours (les photos déjà lues restent dans le catalogue ;
// les fichiers non lus d'un dossier sont repris par la synchronisation avec le disque, ou par une nouvelle relecture).
function removeOrStopTask(task) {
  if (task.status === 'ready') {
    removeReadyTask(task);
    return;
  }
  if (task.status === 'waiting' || task.status === 'paused') {
    const position = scanTasks.indexOf(task);
    if (position >= 0) scanTasks.splice(position, 1);
    saveResumableTasks();
    syncTaskUI();
    // Tâche qui traite elle-même son résultat (écriture de métadonnées…) : prévenue qu'elle ne s'exécutera pas (libère le verrou d'écriture).
    task.onResult?.(null, true, null);
  } else if (!task.stopRequested) {
    task.stopRequested = true;
    syncTaskUI();
    if (!task.runner || task.kind === 'duplicates') invoke('cancel_scan', { taskId: task.id }).catch(error => console.debug('Scan stop failed', error));
  }
}

// Un dossier retiré de la liste des dossiers suivis ne doit plus être scanné : ses tâches en attente sont retirées, celle en cours est arrêtée.
function dropScanTasksForFolder(path) {
  for (const task of [...scanTasks]) {
    if (task.path !== null && taskCoversFolder({ path }, task.path)) removeOrStopTask(task);
  }
}

// Tâches sur des fichiers (déplacement, copie, redimensionnement) : famille « files », attendent leur tour sans jamais être refusées comme doublon.
const FILE_TASK_KINDS = ['move', 'copy', 'resize'];
const hasFileTask = () => scanTasks.some(task => FILE_TASK_KINDS.includes(task.kind));

// Met une tâche en file d'attente ; elle démarre tout de suite si rien ne tourne. Elle est refusée, avec un message, quand une tâche en cours ou en attente
// couvre déjà ce dossier (même dossier, dossier parent, ou relecture de toute la collection). Renvoie true si la tâche est en file.
// `runner(task, setPercent)` (facultatif) : tâche pilotée par l'interface (redimensionnement), exécutée à la place de la commande du backend ;
// elle doit surveiller `task.stopRequested` et publier son avancement avec `setPercent`.
function enqueueScanTask({ kind, path, command, args, labelKey, labelParams, onResult, runner, dedupeKey }) {
  // `dedupeKey` (duplicate search): refused while a task with the same key is running or waiting.
  const sameKey = dedupeKey && scanTasks.find(task => task.dedupeKey === dedupeKey && !task.stopRequested && task.status !== 'ready');
  if (sameKey) {
    showWriteToast(t(kind === 'semantic' ? 'A content analysis of this is already in progress or waiting: {name}' : 'A duplicate search on this is already in progress or waiting: {name}', { name: taskName(sameKey) }));
    return false;
  }
  // Les vérifications d'intégrité ont leur propre famille : elles ne se bloquent qu'entre elles (pas avec les scans ni les relectures de métadonnées).
  const isIntegrity = kind === 'integrity';
  // Familles de tâches qui ne se bloquent pas entre elles : scans et relectures, vérifications d'intégrité, écritures de mots-clés
  // (ces dernières attendent simplement leur tour dans la file, sans jamais être refusées comme doublon), détections de visages (d'un dossier :
  // « faces » ; d'une sélection : « faces-selection », jamais refusée comme doublon), téléchargement des modèles de visages (« face-models »).
  const familyOf = taskKind => (taskKind === 'integrity' ? 'integrity' : taskKind === 'keywords' ? 'keywords'
    : taskKind === 'faces' || taskKind === 'faces-selection' ? 'faces' : taskKind === 'face-models' ? 'face-models' : taskKind === 'update' ? 'update'
    // Content search: model download (main queue) and content analysis (own lane, see pumpSemanticQueue).
    : taskKind === 'semantic-models' ? 'semantic-models' : taskKind === 'semantic' ? 'semantic'
    // Téléchargement d'une zone privée de la carte : une tâche par zone, jamais refusée comme doublon.
    : taskKind === 'private-map' ? 'private-map'
    // Duplicate search: its own family, never refused as a duplicate of another task (each search is queued).
    : taskKind === 'duplicates' ? 'duplicates'
    : FILE_TASK_KINDS.includes(taskKind) ? 'files' : 'scan');
  const sameFamily = task => familyOf(task.kind) === familyOf(kind);
  const covering = kind === 'keywords' || kind === 'faces-selection' || kind === 'private-map' || kind === 'duplicates' || kind === 'semantic' || FILE_TASK_KINDS.includes(kind) ? null : path === null
    ? scanTasks.find(task => task.path === null && !task.stopRequested && sameFamily(task))
    : scanTasks.find(task => !task.stopRequested && sameFamily(task) && taskCoversFolder(task, path));
  if (covering?.status === 'paused') {
    showWriteToast(t('Already part of a paused scan: {name}', { name: taskName(covering) }));
    return false;
  }
  if (covering) {
    showWriteToast(t(isIntegrity ? 'Already part of an integrity check in progress or waiting: {name}' : 'Already part of a scan in progress or waiting: {name}', { name: taskName(covering) }));
    return false;
  }
  scanTaskCounter += 1;
  scanTasks.push({
    id: `scan-${Date.now()}-${scanTaskCounter}`,
    kind, path, command, args, labelKey, labelParams, onResult, runner, dedupeKey,
    status: 'waiting', percent: 0, stopRequested: false, toastHidden: false,
  });
  if (isResumableTask({ kind })) saveResumableTasks();
  syncTaskUI();
  if (isSemanticLaneTask({ kind })) pumpSemanticQueue();
  else pumpScanQueue();
  return true;
}

// Exécute les tâches une par une, dans l'ordre de la file. L'analyse du contenu (famille « semantic ») n'en fait pas partie : elle dure des heures et
// bloquerait toutes les autres tâches, elle a donc sa propre file (pumpSemanticQueue), en parallèle.
async function pumpScanQueue() {
  if (scanPumpActive) return;
  scanPumpActive = true;
  const nextWaiting = () => scanTasks.find(item => item.status === 'waiting' && !isSemanticLaneTask(item));
  try {
    for (let task = nextWaiting(); task; task = nextWaiting()) {
      await runScanTask(task);
    }
  } finally {
    scanPumpActive = false;
  }
  // File vide : synchronisation demandée pendant qu'elle travaillait (fichiers créés par l'application, voir syncLibrary).
  if (syncAfterTasks && foregroundTaskCount() === 0) runRequestedSync();
}

// File de l'analyse du contenu : une seule analyse à la fois (le backend en refuse une seconde, « semantic_scan_running »), les suivantes attendent.
// Elle tourne en parallèle de la file principale ; le backend lui-même se met en pause pendant que les autres tâches travaillent.
let semanticPumpActive = false;
async function pumpSemanticQueue() {
  if (semanticPumpActive) return;
  semanticPumpActive = true;
  try {
    for (let task = scanTasks.find(item => item.status === 'waiting' && isSemanticLaneTask(item)); task;
      task = scanTasks.find(item => item.status === 'waiting' && isSemanticLaneTask(item))) {
      await runScanTask(task);
    }
  } finally {
    semanticPumpActive = false;
  }
}

// Arrête les analyses du contenu : celles en attente quittent la file, celle en cours est interrompue (désactivation de la fonction).
function stopSemanticTasks() {
  for (const task of scanTasks.filter(isSemanticLaneTask)) removeOrStopTask(task);
}

async function runScanTask(task) {
  task.status = 'running';
  task.startedAt = Date.now(); // départ du chronomètre affiché dans la fenêtre des actions
  // Resumed scan: the files read since its first start are skipped. Taken before the scan reads anything, so every file it reads is dated after it.
  const resumeSince = isResumableTask(task) ? task.firstStartedAt ?? null : null;
  if (isResumableTask(task)) {
    task.firstStartedAt ??= task.startedAt;
    saveResumableTasks();
  }
  syncTaskUI();
  try {
    const args = resumeSince === null ? task.args : { ...task.args, resumeSince };
    const result = task.runner
      ? await task.runner(task, percent => { task.percent = Math.max(task.percent, percent); syncTaskUI(); })
      : await invoke(task.command, { ...args, taskId: task.id });
    if (!task.pauseRequested) task.percent = 100; // a paused scan keeps its progress
    syncTaskUI();
    // Vérification d'intégrité : le catalogue n'est pas modifié (seules des miniatures manquantes sont créées), donc pas de rechargement ; le rapport s'affiche à la fin.
    if (task.onResult) await task.onResult(result, task.stopRequested, null, task); // tâche qui traite elle-même son résultat (mots-clés) ; elle peut passer en 'ready' (recherche de doublons)
    else if (task.kind === 'integrity') showIntegrityReport(result, task.stopRequested);
    else if (task.pauseRequested) await refreshAfterPausedScan();
    else await reloadPhotosAfterRescan();
    if (task.pauseRequested) showWriteToast(t('Task paused: {name}', { name: taskName(task) }));
    else if (task.stopRequested) showWriteToast(t('Task stopped: {name}', { name: taskName(task) }));
  } catch (error) {
    console.error('Rescan failed', error);
    if (task.onResult) await task.onResult(null, task.stopRequested, error, task);
    else showWriteToast(t(task.kind === 'integrity' ? 'Integrity check failed: {error}' : 'Rescan failed: {error}', { error }));
  } finally {
    if (task.pauseRequested) {
      // Paused: stays in the list, out of the queue, until "Resume" (its own toast closes: the list shows it).
      task.status = 'paused';
      task.pauseRequested = false;
      task.stopRequested = false;
      task.toastHidden = true;
    } else {
      // A task that finished with results to show stays in the list ('ready') until the user shows or dismisses them.
      const position = scanTasks.indexOf(task);
      if (position >= 0 && task.status !== 'ready') scanTasks.splice(position, 1);
    }
    if (isResumableTask(task)) saveResumableTasks();
    syncTaskUI();
  }
}

// Pauses a resumable scan: a waiting one leaves the queue at once, a running one stops (runScanTask then keeps it as 'paused').
function pauseTask(task) {
  if (!isResumableTask(task) || task.stopRequested) return;
  if (task.status === 'waiting') {
    task.status = 'paused';
    saveResumableTasks();
    syncTaskUI();
  } else if (task.status === 'running') {
    task.pauseRequested = true;
    task.stopRequested = true;
    syncTaskUI();
    invoke('cancel_scan', { taskId: task.id }).catch(error => console.debug('Scan pause failed', error));
  }
}

// Resumes a paused scan: it goes first among the waiting tasks, so it starts as soon as the running task has finished.
function resumeTask(task) {
  if (task.status !== 'paused') return;
  scanTasks.splice(scanTasks.indexOf(task), 1);
  const firstWaiting = scanTasks.findIndex(item => item.status === 'waiting' && !isSemanticLaneTask(item));
  scanTasks.splice(firstWaiting < 0 ? scanTasks.length : firstWaiting, 0, task);
  task.status = 'waiting';
  saveResumableTasks();
  syncTaskUI();
  pumpScanQueue();
}

// After a pause, the photos read so far are added to the grid without the full reload (which redraws the grid from scratch and makes it flash):
// same in-place refresh as the library synchronisation, keeping scroll, selection and learnt ratios. Albums and search results do not depend on
// the scan in progress: they are left as they are (the scan reloads everything when it completes).
async function refreshAfterPausedScan() {
  if (getSelectedAlbum() || duplicateSearch || semanticSearch) return;
  await refreshLibraryAfterSync({ added: [], updated: [], removed: [] });
}

// Folders of paused folder discoveries: the library synchronisation leaves them alone (otherwise it would read the rest of a whole root
// folder in the background, unseen and unstoppable, holding back the content analysis); the scan reads them when resumed.
// Paused rescans are not excluded: the synchronisation only reads their new or changed files, as for any folder.
const pausedScanFolders = () => scanTasks.filter(task => task.kind === 'add' && task.status === 'paused' && task.path).map(task => task.path);

// Remembers the unfinished resumable scans (running, waiting or paused): after a restart they come back paused (restorePausedTasks).
function saveResumableTasks() {
  const saved = scanTasks
    .filter(task => isResumableTask(task) && ['waiting', 'running', 'paused'].includes(task.status))
    .map(({ kind, path, command, args, labelKey, labelParams, firstStartedAt, percent }) => ({
      kind, path, command, args, labelKey, labelParams, firstStartedAt: firstStartedAt ?? null, percent: firstStartedAt ? percent : 0,
    }));
  try { localStorage.setItem('pausedScanTasks', JSON.stringify(saved)); } catch (error) { console.debug('Paused scans not saved', error); }
}

// At startup: the scans left unfinished last time come back paused (only those whose folder is still tracked), with a toast to tell so.
function restorePausedTasks() {
  let saved;
  try { saved = JSON.parse(readStored('pausedScanTasks') ?? 'null'); } catch { saved = null; }
  if (!Array.isArray(saved)) saved = DEFAULTS.pausedScanTasks;
  const tracked = path => folders.some(folder => taskCoversFolder({ path: folder.path }, path));
  const restored = saved.filter(item => item && RESUMABLE_TASK_KINDS.includes(item.kind) && typeof item.command === 'string'
    && (item.path === null ? folders.length > 0 : typeof item.path === 'string' && tracked(item.path)));
  for (const item of restored) {
    scanTaskCounter += 1;
    scanTasks.push({
      id: `scan-${Date.now()}-${scanTaskCounter}`,
      kind: item.kind, path: item.path, command: item.command, args: item.args ?? {}, labelKey: item.labelKey, labelParams: item.labelParams,
      firstStartedAt: Number.isFinite(item.firstStartedAt) ? item.firstStartedAt : null, percent: Number(item.percent) || 0,
      status: 'paused', stopRequested: false, toastHidden: true,
    });
  }
  saveResumableTasks(); // drops the scans of folders no longer tracked
  syncTaskUI();
  if (restored.length) showWriteToast(tp('{count} paused scan can be resumed from the task list.', restored.length, { count: restored.length }));
}

document.getElementById('btn-rescan-folders').addEventListener('click', () => enqueueScanTask({ kind: 'rescan-all', path: null, command: 'rescan_all_folders', args: {}, labelKey: 'Collection data rescan', labelParams: undefined }));

// Vérification d'intégrité d'un dossier de l'arborescence (sous-dossiers compris), lancée depuis son menu contextuel : chaque fichier est décodé et les miniatures
// absentes du cache sont créées. Même file que les scans ; refusée si un dossier parent est déjà en vérification (en cours ou en attente).
function checkFolderIntegrity(path) {
  return enqueueScanTask({ kind: 'integrity', path, command: 'integrity_scan', args: { path }, labelKey: 'Integrity check: {folder}', labelParams: { folder: folderBaseName(path) } });
}

// Rescan d'un dossier de l'arborescence (sous-dossiers compris), lancé depuis son menu contextuel.
function rescanFolder(path) {
  return enqueueScanTask({ kind: 'rescan-folder', path, command: 'rescan_folder', args: { path }, labelKey: 'Folder data rescan: {folder}', labelParams: { folder: folderBaseName(path) } });
}

// ==========================================
// DUPLICATES
// ==========================================
// Right click > "Find duplicates" (a photo, a selection, a folder or "All photos"): the backend (duplicates.rs) searches as a queue task and returns groups
// of paths. They open in the main grid in a results mode like "Find the RAW": a banner brings back the view saved before (snapshot), the filters
// are cleared, a separator heads each group, and the groups are ordered by quantity, total size or path (button of the banner).
// Navigating by hand (folder, album) ends the mode without going back.
const DUPLICATE_SORT_KEY = 'duplicateGroupSort';

// Groups of the mode with the members found in the catalog, ranked. Called after each load of the mode's photos (loadedPhotos is up to date).
function indexDuplicateGroups() {
  const search = duplicateSearch;
  const byPath = new Map(loadedPhotos.map(photo => [photo.path, photo]));
  search.groups = [];
  const keep = getKeepSettings(); // read once: the groups are ranked with the same settings
  search.groupPaths.forEach((paths, position) => {
    const members = sortGroupMembers(paths.map(path => byPath.get(path)).filter(Boolean), keep);
    if (members.length < 2) return; // photos removed since the search leave nothing to compare
    search.groups.push({ id: search.groups.length, members, reasons: search.groupReasons?.[position] ?? [], bytes: members.reduce((sum, photo) => sum + (photo.file_size || 0), 0), firstPath: firstPathOf(members) });
  });
  // Best copies, wearing the medal. One per group; with RAW and JPEG searched together, one per format and only for a format that has several copies in
  // the group (a lone JPEG next to its RAW is not "the best" of anything).
  search.best = new Set();
  for (const group of search.groups) {
    if (!search.mixedFormats) { search.best.add(group.members[0].path); continue; }
    const byFormat = new Map();
    for (const photo of group.members) {
      const format = photoFormat(photo.path);
      byFormat.set(format, [...(byFormat.get(format) ?? []), photo]);
    }
    for (const copies of byFormat.values()) if (copies.length > 1) search.best.add(copies[0].path);
  }
  rankDuplicateGroups();
}

// File format shown and compared in the duplicate results: the extension in capitals (JPEG and JFIF count as JPG).
function photoFormat(path) {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return (extension === 'jpeg' || extension === 'jfif' ? 'jpg' : extension).toUpperCase();
}

// Position of each group in the chosen order, and group and rank of each photo (read by the grid sort).
function rankDuplicateGroups() {
  const search = duplicateSearch;
  search.position = new Map(orderGroups(search.groups, search.sortMode).map((group, index) => [group.id, index]));
  search.order = new Map();
  for (const group of search.groups) group.members.forEach((photo, rank) => search.order.set(photo.path, { group: group.id, rank }));
}

// Separators of the grid: one per group, as groups of consecutive photos (the list is already sorted by group). The label gives the group number,
// its image count and total size as displayed (filters can hide members).
function computeDuplicateSeparators() {
  const groups = [];
  let current = null;
  let currentId = null;
  for (let i = 0; i < photos.length; i++) {
    const id = duplicateSearch.order.get(photos[i].path)?.group ?? -1;
    if (current && id === currentId) continue;
    if (current) current.end = i;
    current = { start: i, end: photos.length, id };
    currentId = id;
    groups.push(current);
  }
  for (const group of groups) {
    let bytes = 0;
    for (let i = group.start; i < group.end; i++) bytes += photos[i].file_size || 0;
    const number = (duplicateSearch.position.get(group.id) ?? 0) + 1;
    // With several criteria, the label says which ones found the group.
    const reasons = duplicateSearch.groups[group.id]?.reasons ?? [];
    group.label = [t('Group {number}', { number }), tp('{count} image', group.end - group.start), formatBytes(bytes), ...(reasons.length ? [reasons.map(reason => t(DUPLICATE_REASONS[reason])).join(' + ')] : [])].join(' · ');
    group.title = '';
  }
  return groups;
}

function renderDuplicateBanner() {
  // Elements read at each call: the function can run before this section of the module has been executed.
  const banner = document.getElementById('duplicates-banner');
  if (!banner) return;
  banner.hidden = !duplicateSearch;
  if (!duplicateSearch) return;
  const shownGroups = new Set(photos.map(photo => duplicateSearch.order.get(photo.path)?.group)).size;
  const text = document.getElementById('duplicates-text');
  text.textContent = `${t(duplicateSearch.titleKey)} · ${duplicateSearch.label} · ${tp('{count} group', shownGroups)} · ${tp('{count} image', photos.length)}`;
  text.title = [duplicateSearch.note, t('Best copy: {list}', { list: describeKeepOrder(getKeepSettings()) || '—' })].filter(Boolean).join('\n');
  const keepButton = document.getElementById('duplicates-keep');
  keepButton.textContent = t('Best copy…');
  keepButton.title = t('Choose how the best copy of each group is picked');
  const select = document.getElementById('duplicates-select');
  select.textContent = t('Select duplicates');
  select.title = t('Select every copy except the best one of each group, then use Delete to send them to the trash');
  select.hidden = duplicateSearch.mixedFormats; // with RAW and JPEG together a cleanup could remove the only RAW: never offered
  const sort = document.getElementById('duplicates-sort');
  sort.textContent = t(GROUP_SORT_LABELS[duplicateSearch.sortMode]);
  sort.title = t('Sort the groups by number of images, total size or path');
}

document.getElementById('duplicates-back')?.addEventListener('click', () => exitDuplicateSearch());

// "Best copy…": the order of the criteria changes who wears the medal. The groups are ranked again at once; the selection is emptied, because the
// copies it held are no longer the ones to remove.
function rankDuplicatesAgain() {
  if (!duplicateSearch) return;
  indexDuplicateGroups();
  fullscreenImageCache.clear(); // the preload cache is indexed by position in the list
  applyPhotoFilters({ keepState: true });
  selectedIndices.clear();
  if (photos.length > 0) {
    lastSelectedIndex = Math.min(lastSelectedIndex, photos.length - 1);
    selectedIndices.add(lastSelectedIndex);
    renderVisibleItems();
    updateUIOnSelection();
  }
}
document.getElementById('duplicates-keep')?.addEventListener('click', () => toggleKeepPanel(rankDuplicatesAgain));

// Cleanup, first step: selects every copy except the best one of each group, among the photos displayed. Nothing is deleted here: the selection is then
// handled like any other (Delete key or context menu, with the usual confirmation and the trash). A group whose best copy is hidden by a filter is left
// alone, so a cleanup can never take away every copy of a picture.
function selectDuplicatesExceptBest() {
  if (!duplicateSearch || duplicateSearch.mixedFormats) return;
  const groupsWithBest = new Set();
  for (const photo of photos) {
    const info = duplicateSearch.order.get(photo.path);
    if (info?.rank === 0) groupsWithBest.add(info.group);
  }
  selectedIndices.clear();
  photos.forEach((photo, index) => {
    const info = duplicateSearch.order.get(photo.path);
    if (info && info.rank > 0 && groupsWithBest.has(info.group)) selectedIndices.add(index);
  });
  if (selectedIndices.size === 0) {
    showWriteToast(t('No duplicate to select'));
    return;
  }
  lastSelectedIndex = Math.min(...selectedIndices);
  scrollToPhotoIndex(lastSelectedIndex);
  renderVisibleItems();
  updateUIOnSelection();
  showWriteToast(tp('{count} duplicate selected: the best copy of each group is kept', selectedIndices.size));
}
document.getElementById('duplicates-select')?.addEventListener('click', selectDuplicatesExceptBest);
document.getElementById('duplicates-sort')?.addEventListener('click', () => {
  if (!duplicateSearch) return;
  duplicateSearch.sortMode = GROUP_SORT_MODES[(GROUP_SORT_MODES.indexOf(duplicateSearch.sortMode) + 1) % GROUP_SORT_MODES.length];
  localStorage.setItem(DUPLICATE_SORT_KEY, duplicateSearch.sortMode);
  rankDuplicateGroups();
  fullscreenImageCache.clear(); // the preload cache is indexed by position in the list
  applyPhotoFilters({ keepState: true });
});

// Ends the mode without reopening the previous view: puts back the sub-folder option and the filters of before the search (except those of a smart
// album, which going back to the album reloads itself). The caller shows whatever comes next.
function abandonDuplicateSearch() {
  if (!duplicateSearch) return;
  const { snapshot } = duplicateSearch;
  duplicateSearch = null;
  closeKeepPanel(); // the floating "Best copy" panel belongs to the results
  setIncludeSubfoldersTemporarily(snapshot.includeSubfolders);
  resetAllFilters();
  if (snapshot.albumKind !== 'smart') applyFilterState(snapshot.filterState);
  renderDuplicateBanner();
}

// "Back" button and Escape.
async function exitDuplicateSearch() {
  if (!duplicateSearch) return;
  const { snapshot } = duplicateSearch;
  abandonDuplicateSearch();
  await restoreViewSnapshot(snapshot);
}

// Returns false when the user declined to leave a modified smart album (nothing shown).
async function showDuplicateResults(result, titleKey, label, context) {
  if (isSelectedAlbumDirty() && !(await confirmLeaveAlbum())) return false;
  if (isFullscreen) closeFullscreen();
  const album = getSelectedAlbum();
  const snapshot = duplicateSearch?.snapshot ?? rawSearch?.snapshot ?? semanticSearch?.snapshot ?? captureViewSnapshot(album);
  abandonSemanticSearch(); // its filters and sub-folder option are put back, the snapshot above is the view to return to
  abandonRawSearch(); // restores the filters of before "Find the RAW"; the snapshot above is the view to go back to
  clearAlbumSelection();
  syncSmartAlbumWithSelection();
  resetAllFilters();
  currentFolderFilter = null; extraFolderFilters = [];
  // What the search could not do, in the tooltip of the banner.
  const note = [
    context.criteria,
    result.wholeFileExtensions?.length ? t('Metadata could not be ignored for: {list}', { list: result.wholeFileExtensions.join(', ') }) : '',
    result.unsupported > 0 ? tp('{count} photo could not be compared (format not supported)', result.unsupported) : '',
    result.skippedGroups > 0 ? tp('{count} group was left out because it was too large: lower the sensitivity', result.skippedGroups) : '',
  ].filter(Boolean).join('\n');
  duplicateSearch = {
    titleKey, label, snapshot, note, groupPaths: result.groups, groupReasons: result.reasons ?? null, mixedFormats: context.mixedFormats,
    sortMode: normalizeGroupSort(localStorage.getItem(DUPLICATE_SORT_KEY)),
    groups: [], order: new Map(), position: new Map(),
  };
  renderFolderTree();
  await loadPhotos();
  return true;
}

// "Show" (toast or tasks window): opens the results of a finished search, then the task leaves the list.
async function showReadyDuplicateResults(task) {
  if (task.status !== 'ready' || task.showing) return;
  task.showing = true; // a double click must not open the results twice
  try {
    if (!(await showDuplicateResults(task.result, task.titleKey, task.resultLabel, task.context))) return;
    closeTasksModal();
    removeReadyTask(task);
  } finally {
    task.showing = false;
  }
}

function removeReadyTask(task) {
  const position = scanTasks.indexOf(task);
  if (position >= 0) scanTasks.splice(position, 1);
  task.result = null; // the groups are not kept once the task is gone
  syncTaskUI();
}

// A task ended (onResult of the queue): `stopped` = the user stopped it, `error` = the backend failed. With groups found, the task stays in the list
// ('ready') and its toast announces the results: the view is never changed without the user's click.
async function handleDuplicatesResult(result, stopped, error, titleKey, label, task, context) {
  if (error) {
    showWriteToast(t('Duplicate search failed: {error}', { error }));
    return;
  }
  if (!result || result.cancelled || stopped) return; // runScanTask announces the stop
  if (result.groups.length === 0) {
    showWriteToast(tp('No duplicates found among {count} photo', result.scanned));
    return;
  }
  // A newer result for the same search replaces the one still waiting.
  for (const older of scanTasks.filter(other => other !== task && other.status === 'ready' && other.dedupeKey === task.dedupeKey)) removeReadyTask(older);
  Object.assign(task, { status: 'ready', result, groupCount: result.groups.length, titleKey, resultLabel: label, context });
  task.toastHidden = !tasksModal.classList.contains('hidden'); // the tasks window already shows it
}

// `spec` (built by the menus of photo-actions.js): { scope, label, compareWithLibrary }, with scope = { kind: 'all' } | { kind: 'folder', path, recursive }
// | { kind: 'paths', paths }. `settings` come from the "More…" window, otherwise from the defaults saved there (duplicates.js).

// Hash of the image data and/or file name, as one task. The name search runs here (its pattern is a JavaScript regular expression, the backend only lists
// the photos); the hash search is a backend command stopped through the task's identifier. Groups found by both are joined, each with its reasons.
async function runIdenticalSearch({ scope, compareWithLibrary }, settings, task, setPercent) {
  if (settings.name && compileNamePattern(settings.pattern) === undefined) throw t('Invalid pattern');
  const parts = [];
  let nameReport = null;
  let hashReport = null;
  if (settings.name) {
    const rows = await invoke('list_duplicate_candidates', { scope, compareWithLibrary });
    if (task.stopRequested) return { groups: [], scanned: 0, cancelled: true };
    const candidates = rows.map(([path, dateTaken, inScope]) => ({ path, dateTaken, inScope, isRaw: RAW_EXTENSIONS.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase()) }));
    // With the hash search to come, the name search only fills the first tenth of the progress bar.
    nameReport = await findNameGroups(candidates, settings, { shouldStop: () => task.stopRequested, onProgress: percent => setPercent(settings.hash ? percent / 10 : percent) });
    if (nameReport.cancelled) return nameReport;
    parts.push({ reason: 'name', groups: nameReport.groups });
  }
  if (settings.hash) {
    hashReport = await invoke('find_duplicates', { request: { scope, compareWithLibrary, ignoreMetadata: settings.ignoreMetadata }, taskId: task.id });
    if (hashReport.cancelled) return hashReport;
    parts.push({ reason: 'hash', groups: hashReport.groups });
  }
  const report = {
    scanned: Math.max(nameReport?.scanned ?? 0, hashReport?.scanned ?? 0),
    unsupported: 0,
    skippedGroups: nameReport?.skippedGroups ?? 0,
    wholeFileExtensions: hashReport?.wholeFileExtensions ?? [],
    cancelled: false,
  };
  if (parts.length === 1) return { ...report, groups: parts[0].groups }; // one criterion: no reason to show
  return { ...report, ...mergeGroups(parts) };
}

const DUPLICATE_REASONS = { hash: 'Same image data', name: 'Same file name' };

const DUPLICATE_KINDS = {
  identical: {
    settings: getIdenticalSettings,
    // Title of the results: the image data is the main criterion; the name alone has its own title.
    titleKey: settings => (settings.hash ? 'Identical images' : 'Same file name'),
    labelKey: settings => (settings.hash ? 'Identical images: {scope}' : 'Same file name: {scope}'),
    runner: (spec, settings, task, setPercent) => runIdenticalSearch(spec, settings, task, setPercent),
  },
  similar: {
    settings: getSimilarSettings,
    titleKey: () => 'Similar images',
    labelKey: () => 'Similar images: {scope}',
    command: 'find_similar_images',
    request: settings => similarRequestFields(settings),
  },
};

// `kind`: 'identical' | 'similar'.
function findDuplicateImages(kind, { scope, label, compareWithLibrary }, settings) {
  const definition = DUPLICATE_KINDS[kind];
  settings = settings ?? definition.settings();
  // Same kind of search on the same scope (same folder, same photos, whole library): refused while another one is running or waiting.
  const scopeKey = scope.kind === 'folder' ? `folder:${normalizeFilterPath(scope.path)}:${scope.recursive}`
    : scope.kind === 'paths' ? `paths:${[...scope.paths].sort().join('|')}` : 'all';
  return enqueueScanTask({
    kind: 'duplicates', path: null, dedupeKey: `${kind}:${scopeKey}`,
    ...(definition.runner
      ? { runner: (task, setPercent) => definition.runner({ scope, compareWithLibrary }, settings, task, setPercent) }
      : { command: definition.command, args: { request: { scope, compareWithLibrary, ...definition.request(settings) } } }),
    labelKey: definition.labelKey(settings), labelParams: { scope: label },
    onResult: (result, stopped, error, task) => handleDuplicatesResult(result, stopped, error, definition.titleKey(settings), label, task, {
      criteria: describeSearch(kind, settings, { scope, compareWithLibrary }),
      // RAW and JPEG searched together: results are shown per format and never offered for cleanup. (The hash search never pairs them: only the name does.)
      mixedFormats: kind === 'identical' ? Boolean(settings.name && settings.includeRawPairs) : Boolean(settings.includeRawPairs),
    }),
  });
}

// "More…" window (duplicates-modal.js): the user picks the kind and the settings, then the search starts with them.
function openDuplicatesDialog(spec) {
  openDuplicatesModal(spec, (kind, chosenSpec, settings) => findDuplicateImages(kind, chosenSpec, settings));
}

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
// Sous-sélection du mode Comparer (plusieurs photos comparées) : chemins des photos de l'aperçu qui reçoivent les commandes de note, de couleur et de suppression au clavier ou depuis la barre latérale. Vide par défaut.
const compareSubSelection = new Set();
let suppressPreviewClick = false; // le clic qui suit un déplacement de l'image dans l'aperçu ne change pas la sous-sélection
let previewHiddenBeforeCompare = false; // l'aperçu était masqué avant l'activation du mode Comparer : il est masqué de nouveau à sa désactivation
const PREVIEW_CLICK_DRAG_THRESHOLD = 5; // pixels avant de considérer un déplacement (sinon c'est un clic)
// Icône lucide « circle-check-big » : repère d'une photo de la sous-sélection (coin supérieur droit de sa case dans l'aperçu).
const CIRCLE_CHECK_BIG_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check-big"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>';

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

// Comparaison de plusieurs photos : les cases de l'aperçu servent alors à choisir les photos visées par les commandes.
function isCompareMultiple() {
  return compareMode && selectedIndices.size > 1;
}

// Photos (indices dans photos) visées par les notes, les couleurs et la suppression au clavier, et par la barre latérale.
// Hors comparaison, ou avec une seule photo sélectionnée : toute la sélection. Comparaison de plusieurs photos : uniquement la sous-sélection (aucune par défaut).
// Les commandes du menu contextuel n'en dépendent pas : elles visent toujours la photo du clic droit.
function commandTargetIndices() {
  if (!isCompareMultiple()) return [...selectedIndices];
  return [...selectedIndices].filter(index => compareSubSelection.has(photos[index]?.path));
}

function commandTargetPhotos() {
  return commandTargetIndices().map(index => photos[index]).filter(Boolean);
}

// Photo dont la note et la couleur sont affichées dans la barre latérale.
function commandReferencePhoto() {
  const indices = commandTargetIndices();
  return photos[indices.includes(lastSelectedIndex) ? lastSelectedIndex : indices[0]];
}

// Retire de la sous-sélection les photos qui ne font plus partie de la comparaison (changement de sélection, suppression, fin du mode Comparer).
function pruneCompareSubSelection() {
  if (!isCompareMultiple()) {
    compareSubSelection.clear();
    return;
  }
  const comparedPaths = new Set([...selectedIndices].map(index => photos[index]?.path));
  for (const path of compareSubSelection) if (!comparedPaths.has(path)) compareSubSelection.delete(path);
}

// Repères circle-check-big des cases de l'aperçu, d'après la sous-sélection.
function syncPreviewSubSelection() {
  previewStage.classList.toggle('sub-selectable', isCompareMultiple());
  for (const slot of previewSlots) slot.cell.classList.toggle('sub-selected', compareSubSelection.has(slot.photo.path));
}

function toggleCompareSubSelection(photo) {
  if (compareSubSelection.has(photo.path)) compareSubSelection.delete(photo.path);
  else compareSubSelection.add(photo.path);
  syncPreviewSubSelection();
  updateRatingAction();
  updateColorAction();
}

// Place les repères (sous-sélection, étoiles, couleur et badge de zoom) dans les coins de l'image
function positionPreviewMarks(slot, cellWidth, cellHeight) {
  if (!slot.meta) return; // le plein écran n'a pas les repères d'aperçu et son badge est calé en CSS symétrique à rank
  const left = Math.max(0, slot.tx);
  const top = Math.max(0, slot.ty);
  // Positionnement dans les cases de l'aperçu et de la comparaison
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

// Affiche le pourcentage de zoom pendant 2 secondes puis l'estompe
function showZoomIndicator(slot) {
  if (!slot || !slot.zoomBadge || !(slot.naturalWidth > 0)) return;
  const scale = slot.zoom ?? slot.fit;
  slot.zoomBadge.textContent = `${Math.round(scale * 100)}%`;
  slot.zoomBadge.classList.add('visible');
  clearTimeout(slot.zoomTimeout);
  slot.zoomTimeout = setTimeout(() => {
    slot.zoomBadge.classList.remove('visible');
  }, 2000);
}

// Touche A : sous-sélectionne toutes les photos comparées, ou les désélectionne toutes si elles le sont déjà.
function toggleAllCompareSubSelection() {
  const paths = [...selectedIndices].map(index => photos[index]?.path).filter(Boolean);
  if (paths.every(path => compareSubSelection.has(path))) compareSubSelection.clear();
  else for (const path of paths) compareSubSelection.add(path);
  syncPreviewSubSelection();
  updateRatingAction();
  updateColorAction();
}

function notifyNoCompareTarget() {
  showWriteToast(t('Compare mode: first click one or more photos in the preview'));
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

// Size of the image of a slot (preview cell, comparison, fullscreen). The element keeps the size the webview gives it (`width` × `height`);
// naturalWidth / naturalHeight are those of the picture as displayed, after the orientation still to apply (`photo.view_fix`, see
// orientationMatrix), which layoutPreviewSlot adds to the transform. The whole layout (fit, zoom, faces) then works on the displayed picture.
function setSlotImageSize(slot, width, height) {
  slot.viewFix = slot.photo?.view_fix ?? 1;
  slot.rawWidth = width;
  slot.rawHeight = height;
  const swapped = swapsSides(slot.viewFix);
  slot.naturalWidth = swapped ? height : width;
  slot.naturalHeight = swapped ? width : height;
  slot.img.style.width = `${width}px`;
  slot.img.style.height = `${height}px`;
}

function layoutPreviewSlot(slot) {
  if (!(slot.naturalWidth > 0 && slot.naturalHeight > 0)) return;
  const cellWidth = slot.cell.clientWidth;
  const cellHeight = slot.cell.clientHeight;
  if (!cellWidth || !cellHeight) return;
  const dpr = window.devicePixelRatio || 1;
  const fitMargin = slot.fitMargin ?? PREVIEW_FIT_MARGIN; // le plein écran utilise toute la fenêtre (marge 1)
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
  if (slot.clip) { // surcouche d'écrêtage (histogram.js) : mêmes dimensions et même transformation que l'image
    slot.clip.style.width = slot.img.style.width;
    slot.clip.style.height = slot.img.style.height;
    slot.clip.style.transform = slot.img.style.transform;
  }
  positionPreviewMarks(slot, cellWidth, cellHeight);
  if (slot !== fullscreenSlot) layoutPreviewFaces(slot); // zones de visage (touche V)
}

function renderPreviewTransforms() {
  previewSlots.forEach(layoutPreviewSlot);
  layoutFullscreenSlot();
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
  img.addEventListener('error', () => checkPhotoMissing(photo.path));
  img.addEventListener('error', () => checkPhotoMissing(photo.path));
  img.addEventListener('error', () => { if (isRawPath(photo.path)) markFormatPlaceholder(cell, photo.path); });
  getPhotoDisplayUrl(photo).then(url => {
    if (previewSlots.includes(slot) && url) {
      img.src = url;
    }
  });
  const check = document.createElement('span');
  check.className = 'preview-check';
  check.setAttribute('aria-hidden', 'true');
  check.innerHTML = CIRCLE_CHECK_BIG_ICON;
  // Badge du pourcentage de zoom
  const zoomBadge = document.createElement('span');
  zoomBadge.className = 'preview-zoom-badge';
  slot.zoomBadge = zoomBadge;
  slot.zoomTimeout = null;
  // Note (à gauche) et couleur (à droite) de la photo, en bas de la case.
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
  // Surcouche d'écrêtage (masquée tant que histogram.js n'y peint rien).
  const clip = document.createElement('canvas');
  clip.className = 'clipping-overlay';
  clip.hidden = true;
  clip.setAttribute('aria-hidden', 'true');
  slot.clip = clip;
  cell.append(img, clip, check, meta, zoomBadge);
  if (isVideoPath(photo.path)) cell.append(createVideoPlayBadge());
  slot.check = check;
  slot.meta = meta;
  return slot;
}

// Mode normal : la photo courante. Mode Comparer : la sélection (4 max), dans l'ordre de la grille.
function currentPreviewPhotos() {
  if (compareMode) {
    return [...selectedIndices].sort((a, b) => a - b).slice(0, MAX_COMPARE).map(index => photos[index]).filter(Boolean);
  }
  if (selectedIndices.size === 0) return []; // rien de sélectionné (Ctrl+A pour tout désélectionner) : aperçu vide
  const photo = photos[lastSelectedIndex];
  return photo ? [photo] : [];
}

// Étoiles et pastille de couleur affichées en bas des cases de l'aperçu, d'après l'état actuel des photos.
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

function renderPreview() {
  pruneCompareSubSelection();
  const list = currentPreviewPhotos();
  const signature = list.map(photo => photo.path).join('|');
  // Un aperçu vidé (signature '') ne doit pas réutiliser d'anciennes cases : leurs photos n'existeraient plus (ex. photos déplacées hors de la vue).
  if (signature === previewSignature && list.length === previewSlots.length) { // mêmes images : on garde zoom et position
    previewSlots.forEach((slot, index) => { slot.photo = list[index]; }); // objets renouvelés après une synchronisation
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
// Le plein écran a toujours son propre centre (une seule image, indépendante de l'aperçu).
function previewCenterOf(slot) {
  return previewDesynced || slot === fullscreenSlot ? slot.center : previewCenter;
}

function setPreviewCenter(slot, center) {
  if (previewDesynced || slot === fullscreenSlot) slot.center = center;
  else previewCenter = center;
}

// En mode désynchronisé, une action vise l'image concernée ; sinon elle s'applique à toutes.
function previewSlotsToAffect(targetSlot) {
  // Plein écran ouvert : les touches + / - / * (et le zoom en général) ne visent que son image.
  if (isFullscreen) return fullscreenSlot.naturalWidth > 0 ? [fullscreenSlot] : [];
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
  if (previewDesynced || isFullscreen) {
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
  slots.forEach(showZoomIndicator); // <-- Déclenche le badge sur chaque case zoomée
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

// Nombre de crans de zoom correspondant à un événement de molette, ou 0 si aucun cran n'est atteint : une molette à crans donne un cran par
// événement (avec un court délai anti-rebond), un pavé tactile envoie de petits déplacements qui sont cumulés. Partagé par l'aperçu et le plein écran.
function wheelZoomSteps(event) {
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
  previewSlotsToAffect(slot).forEach(showZoomIndicator); // <-- Déclenche le badge pendant le déplacement
});

function endPreviewDrag(event) {
  if (!previewDrag || event.pointerId !== previewDrag.pointerId) return;
  if (previewDrag.moved) {
    // Le clic qui suit un déplacement de l'image ne doit pas changer la sous-sélection.
    suppressPreviewClick = true;
    setTimeout(() => { suppressPreviewClick = false; }, 0);
  }
  previewDrag.slot.cell.classList.remove('dragging');
  previewDrag = null;
}
previewStage.addEventListener('pointerup', endPreviewDrag);
previewStage.addEventListener('pointercancel', endPreviewDrag);

// Comparaison de plusieurs photos : un clic sur une case de l'aperçu ajoute ou retire sa photo de la sous-sélection.
// Un double-clic (zoom 1:1) compte deux clics et laisse donc la sous-sélection inchangée.
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
  setKeywordsCompareMode(compareMode); // les onglets Mots-clés et Description sont inaccessibles en mode Comparer
  document.getElementById('btn-toggle-preview').disabled = compareMode; // l'aperçu reste affiché tant que le mode Comparer est actif
  const desyncOption = document.getElementById('compare-desync');
  desyncOption.classList.toggle('hidden', !compareMode);
  updatePreviewSyncMode();
  if (compareMode) {
    previewHiddenBeforeCompare = mainContent.classList.contains('preview-hidden');
    if (previewHiddenBeforeCompare) {
      mainContent.classList.remove('preview-hidden');
      document.getElementById('btn-toggle-preview').classList.add('active');
      requestAnimationFrame(updateVirtualScroller);
    }
    limitSelectionForCompare();
  } else if (previewHiddenBeforeCompare) {
    previewHiddenBeforeCompare = false;
    mainContent.classList.add('preview-hidden');
    document.getElementById('btn-toggle-preview').classList.remove('active');
    requestAnimationFrame(updateVirtualScroller);
  }
  updateUIOnSelection();
});

// ==========================================
// DÉFILEMENT DE LA GRILLE AU GLISSER
// ==========================================
const GRID_DRAG_THRESHOLD = 5; // pixels avant de considérer un glissement (sinon c'est un clic)
let gridDrag = null;
let photoDrag = null; // glisser-déposer de photos vers l'arborescence (voir plus bas)
let suppressGridClick = false;

// Inertie : au relâchement d'un glissement rapide, le défilement continue puis ralentit progressivement (décroissance exponentielle,
// indépendante de la cadence d'affichage). La distance totale parcourue vaut vitesse initiale x GRID_INERTIA_TIME_CONSTANT_MS.
const GRID_INERTIA_TIME_CONSTANT_MS = 325; // plus la valeur est grande, plus le défilement dure et va loin
const GRID_INERTIA_VELOCITY_WINDOW_MS = 100; // fenêtre de mesure de la vitesse juste avant le relâchement
const GRID_INERTIA_MAX_IDLE_MS = 60; // pointeur immobile plus longtemps avant le relâchement : pas d'inertie
const GRID_INERTIA_MIN_VELOCITY = 0.1; // px/ms nécessaires pour lancer l'inertie
const GRID_INERTIA_STOP_VELOCITY = 0.02; // px/ms : en dessous, le défilement s'arrête
const GRID_INERTIA_MAX_VELOCITY = 6; // px/ms
let gridInertia = null; // { frame, velocity, position, lastTime } pendant l'inertie

// Arrête l'inertie en cours ; renvoie true si la grille était encore en train de défiler.
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
    // scrollTop modifié ailleurs (barre de défilement, changement de filtre ou de tri…) : l'inertie s'efface.
    if (Math.abs(gridContainer.scrollTop - state.position) > 2) { stopGridInertia(); return; }
    const elapsed = Math.min(50, Math.max(0, now - state.lastTime));
    state.lastTime = now;
    const decay = Math.exp(-elapsed / GRID_INERTIA_TIME_CONSTANT_MS);
    state.position += state.velocity * GRID_INERTIA_TIME_CONSTANT_MS * (1 - decay);
    state.velocity *= decay;
    const maxScroll = Math.max(0, gridContainer.scrollHeight - gridContainer.clientHeight);
    const clamped = Math.max(0, Math.min(maxScroll, state.position));
    gridContainer.scrollTop = clamped;
    // Haut ou bas de la grille atteint, ou vitesse devenue négligeable : fin du défilement.
    if (clamped !== state.position || Math.abs(state.velocity) < GRID_INERTIA_STOP_VELOCITY) { stopGridInertia(); return; }
    state.frame = requestAnimationFrame(step);
  };
  state.frame = requestAnimationFrame(step);
}

// Vitesse mesurée sur les derniers instants du glissement (pointeur immobile avant le relâchement = pas d'inertie).
function releaseGridInertia(samples, releaseTime) {
  const last = samples[samples.length - 1];
  if (!last || releaseTime - last.time > GRID_INERTIA_MAX_IDLE_MS) return;
  const first = samples[0];
  const duration = last.time - first.time;
  if (duration < 8) return; // trop peu de mesures pour estimer une vitesse fiable
  const velocity = Math.max(-GRID_INERTIA_MAX_VELOCITY, Math.min(GRID_INERTIA_MAX_VELOCITY, -(last.y - first.y) / duration));
  if (Math.abs(velocity) < GRID_INERTIA_MIN_VELOCITY) return;
  startGridInertia(velocity);
}

// La molette reprend la main sur une inertie en cours.
gridContainer.addEventListener('wheel', stopGridInertia, { passive: true });

gridContainer.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.pointerType === 'touch') return;
  const stoppedInertia = stopGridInertia(); // un clic sur la grille qui défile l'arrête
  const bounds = gridContainer.getBoundingClientRect();
  if (event.clientX - bounds.left >= gridContainer.clientWidth) return; // barre de défilement
  // Maj + bouton tenu sur une miniature : on glisse les photos vers un dossier de l'arborescence pour les déplacer ; Ctrl + bouton tenu : pour les copier
  // (le glissement simple fait défiler la grille).
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
  // Derniers points du glissement, pour estimer la vitesse au relâchement.
  const samples = gridDrag.samples;
  samples.push({ time: event.timeStamp, y: event.clientY });
  while (samples.length > 1 && event.timeStamp - samples[0].time > GRID_INERTIA_VELOCITY_WINDOW_MS) samples.shift();
});

function endGridDrag(event) {
  if (!gridDrag || event.pointerId !== gridDrag.pointerId) return;
  const { active, stoppedInertia, samples } = gridDrag;
  if (active || stoppedInertia) {
    // Le clic qui suit un glissement (ou qui vient d'arrêter l'inertie) ne doit pas changer la sélection.
    suppressGridClick = true;
    setTimeout(() => { suppressGridClick = false; }, 0);
  }
  if (active) {
    gridContainer.classList.remove('dragging-scroll');
    if (event.type === 'pointerup') releaseGridInertia(samples, event.timeStamp); // pas d'inertie si le glissement est annulé
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
// DÉPLACEMENT ET COPIE DE PHOTOS PAR GLISSER-DÉPOSER VERS L'ARBORESCENCE
// ==========================================
// Maj + bouton tenu sur une miniature, puis glisser sur un dossier de l'arborescence et relâcher : les photos sélectionnées y sont déplacées
// (fichiers déplacés sur le disque). Avec Ctrl au lieu de Maj, elles sont copiées (un « + » vert s'affiche sur la vignette). Si la miniature saisie
// n'est pas sélectionnée, seule elle est concernée. Échap annule. Un simple Maj + clic ou Ctrl + clic, sans glissement, garde son rôle habituel
// (sélection d'une plage, ajout ou retrait de la sélection).
const PHOTO_DRAG_THRESHOLD = 6; // pixels avant de considérer un glissement (sinon c'est un clic)
let photoMoveRunning = false;

function folderItemAt(x, y) {
  const element = document.elementFromPoint(x, y);
  return element instanceof Element ? element.closest('#folder-tree .folder-tree-item[data-folder-path]') : null;
}

// Mode du glissement d'après les touches tenues À CET INSTANT (Maj : déplacer, Ctrl : copier ; Maj l'emporte), null si aucune. Les touches peuvent
// changer pendant le glissement : le mode et le badge suivent.
const dragModeFrom = modifiers => (modifiers.shiftKey ? 'move' : modifiers.ctrlKey ? 'copy' : null);

// Action d'un dépôt sur un album manuel : 'copy' (ajout), 'move' (ajout à la cible puis retrait de l'album d'origine), null (à demander) ou 'none'
// (l'album d'origine lui-même : rien à faire).
// Des photos venant d'un dossier du disque ne sont jamais déplacées dans un album : toujours un ajout, quelle que soit la touche tenue.
// Des photos venant d'un autre album manuel suivent les touches, comme sur un dossier : Maj déplace, Ctrl copie, sans touche on demande.
function albumDropAction(drag) {
  if (drag.sourceAlbumId && drag.overAlbumId === drag.sourceAlbumId) return 'none';
  return drag.sourceAlbumId ? drag.mode : 'copy';
}

// Badge de l'image qui suit le curseur : « + » vert pour une copie, flèche bleue vers la gauche pour un déplacement, aucun quand le dépôt demandera
// quoi faire. Au-dessus de la carte, quelle que soit la touche : une épingle rouge, les photos y seront géolocalisées.
function paintPhotoDragBadge(drag) {
  if (!drag.ghost) return;
  // Aucun badge quand le dépôt est refusé (album intelligent, dossier virtuel) ou sans effet (album d'origine).
  const action = drag.refusal ? 'none' : drag.overAlbum ? albumDropAction(drag) : drag.mode;
  drag.ghost.classList.toggle('pin', drag.overMap);
  drag.ghost.classList.toggle('copy', !drag.overMap && action === 'copy');
  drag.ghost.classList.toggle('move', !drag.overMap && action === 'move');
  // Cible refusée (album intelligent, dossier virtuel) : la raison s'affiche sous l'image.
  const reason = drag.overMap ? null : drag.refusal;
  if (drag.reason) { drag.reason.hidden = !reason; drag.reason.textContent = reason ? t(reason) : ''; }
}

// Recalcule ce que le glissement vise d'après les touches tenues et la position du curseur : mode, album ou carte survolés, badge, réticule de la carte.
// Appelée à chaque mouvement de la souris et à chaque appui ou relâchement de Maj / Ctrl.
function updatePhotoDragState(drag, x, y, modifiers) {
  drag.mode = dragModeFrom(modifiers);
  drag.lastX = x;
  drag.lastY = y;
  const albumItem = albumItemAt(x, y);
  drag.overAlbum = Boolean(albumItem);
  drag.overAlbumId = albumItem ? Number(albumItem.dataset.albumId) : 0;
  // Un album qui n'est pas manuel (intelligent, dossier virtuel) ne reçoit pas de photos : on le dit au lieu d'ignorer le dépôt.
  drag.refusal = !albumItem && albumNodeAt(x, y) ? 'Photos can only be added to a manual album' : null;
  // Au-dessus de la carte (avec ou sans Maj / Ctrl) : réticule, coordonnées visées, et image décalée pour ne pas masquer le point de dépôt.
  drag.overMap = dragOverMap(x, y); // quelle que soit la touche tenue
  document.body.classList.toggle('over-map', drag.overMap);
  paintPhotoDragBadge(drag);
  const ghostOffset = drag.overMap ? 30 : 12;
  drag.ghost.style.transform = `translate(${x + ghostOffset}px, ${y + ghostOffset}px)`;
}

// Photos lâchées sans Maj ni Ctrl sur un dossier du disque ou un album : menu Copier / Déplacer / Annuler à l'endroit du relâchement.
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

// Album manuel de la section Albums sous le curseur (cible d'ajout de photos).
function albumItemAt(x, y) {
  const element = document.elementFromPoint(x, y);
  return element instanceof Element ? element.closest('#albums-list .album-item.album-manual') : null;
}

// N'importe quelle ligne de la section Albums sous le curseur (pour expliquer pourquoi un album intelligent ou un dossier virtuel refuse les photos).
function albumNodeAt(x, y) {
  const element = document.elementFromPoint(x, y);
  return element instanceof Element ? element.closest('#albums-list .album-item') : null;
}

// Premier déplacement au-delà du seuil : fixe les photos concernées et crée l'image qui suit le curseur.
function startPhotoDrag(drag) {
  if (!selectedIndices.has(drag.index)) {
    selectedIndices.clear();
    selectedIndices.add(drag.index);
    lastSelectedIndex = drag.index;
    updateUIOnSelection();
  }
  drag.targets = [...selectedIndices].sort((a, b) => a - b).map(index => photos[index]).filter(Boolean);
  if (!drag.targets.length) return false;
  drag.active = true;
  // Photos affichées depuis un album manuel : elles peuvent en être déplacées vers un autre (voir albumDropAction).
  const sourceAlbum = getSelectedAlbum();
  drag.sourceAlbumId = sourceAlbum?.kind === 'manual' ? sourceAlbum.id : 0;
  gridContainer.setPointerCapture(drag.pointerId); // les événements continuent d'arriver au-dessus de l'arborescence
  const ghost = document.createElement('div');
  ghost.className = drag.mode === 'copy' ? 'drag-ghost copy' : 'drag-ghost';
  const source = renderedThumbnailNodes.get(drag.index)?._thumbnailImage;
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

function endPhotoDrag(event, released) {
  const drag = photoDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  photoDrag = null;
  if (!drag.active) return; // Maj ou Ctrl + clic simple : le clic gère la sélection
  clearPhotoDragVisuals(drag);
  // Le clic qui suit un glissement ne doit pas changer la sélection.
  suppressGridClick = true;
  setTimeout(() => { suppressGridClick = false; }, 0);
  if (!released || drag.cancelled) return;
  drag.mode = dragModeFrom(event); // touches au moment du relâchement
  if (dropOnMap(event.clientX, event.clientY, drag.targets)) return; // déposées sur la carte : position choisie
  // Déposées sur un album manuel : aucun fichier n'est déplacé ni copié. Venant d'un dossier du disque, les photos sont ajoutées ; venant d'un autre
  // album manuel, Maj les en retire en plus (déplacement), Ctrl les ajoute seulement, sans touche on demande.
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
  if (!drag.mode) { askCopyOrMove(event, drag.targets, () => copyPhotosToFolder(drag.targets, folderPath), () => movePhotosToFolder(drag.targets, folderPath)); return; } // sans Maj ni Ctrl au relâchement : on demande
  if (drag.mode === 'copy') copyPhotosToFolder(drag.targets, folderPath);
  else movePhotosToFolder(drag.targets, folderPath);
}
gridContainer.addEventListener('pointerup', event => endPhotoDrag(event, true));
gridContainer.addEventListener('pointercancel', event => endPhotoDrag(event, false));
// Maj ou Ctrl pressé ou relâché pendant le glissement (souris immobile) : mode et badge changent aussitôt.
function onPhotoDragModifierKey(event) {
  const drag = photoDrag;
  if (!drag?.active || drag.cancelled || (event.key !== 'Shift' && event.key !== 'Control')) return;
  updatePhotoDragState(drag, drag.lastX, drag.lastY, event);
}
window.addEventListener('keydown', onPhotoDragModifierKey);
window.addEventListener('keyup', onPhotoDragModifierKey);

// Échap pendant le glissement : annule le déplacement (le relâché du bouton ne fait alors plus rien).
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !photoDrag?.active || photoDrag.cancelled) return;
  event.preventDefault();
  photoDrag.cancelled = true;
  clearPhotoDragVisuals(photoDrag);
});

// Met à jour l'interface après la suppression d'un dossier (voir delete_folder) : photos retirées de la vue sans recharger la bibliothèque, dossiers
// vides créés pendant la session oubliés. Si le dossier affiché est concerné, on revient à son dossier parent.
function applyDeletedFolder(deletedPath, removedPaths) {
  const normalize = value => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const deleted = normalize(deletedPath);
  const isInside = value => normalize(value) === deleted || normalize(value).startsWith(`${deleted}/`);
  for (const created of [...createdFolders]) if (isInside(created)) createdFolders.delete(created);
  diskFolders = diskFolders.filter(folder => !isInside(folder)); // sinon le dossier supprimé resterait dans l'arbre (option « dossiers sans photo »)
  for (const key of [...folderTreeExpanded]) if (isInside(key)) folderTreeExpanded.delete(key);
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
  photoMoveRunning = true;
  showWriteToast(t(permanent ? 'Deleting folder…' : 'Moving folder to the trash…'), true);
  try {
    const removedPaths = await invoke('delete_folder', { path });
    applyDeletedFolder(path, removedPaths);
    showWriteToast(t(permanent ? 'Folder deleted' : 'Folder moved to the trash'));
  } catch (error) {
    showWriteToast(t('Folder deletion failed: {error}', { error }));
    if (showEmptyFolders) refreshDiskFolders(); // le dossier a peut-être disparu du disque : l'arbre est resynchronisé
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
    if (moved.from !== moved.to) await applyMovedPhotos([moved]);
    showWriteToast(t('File renamed'));
    return null;
  } catch (error) {
    return String(error);
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
    const followKey = key => normalize(`${newBase}${key.slice(old.length)}`);
    for (const created of [...createdFolders]) if (isInside(created)) { createdFolders.delete(created); createdFolders.add(follow(created)); }
    diskFolders = diskFolders.map(folder => (isInside(folder) ? follow(folder) : folder));
    for (const key of [...folderTreeExpanded]) if (isInside(key)) { folderTreeExpanded.delete(key); folderTreeExpanded.add(followKey(key)); }
    if (currentFolderFilter !== null && isInside(currentFolderFilter)) {
      currentFolderFilter = follow(currentFolderFilter);
      rememberCurrentFolder();
    }
    extraFolderFilters = extraFolderFilters.map(folder => (isInside(folder) ? follow(folder) : folder));
    if (moved.length) await applyMovedPhotos(moved);
    renderFolderTree();
    if (showEmptyFolders) refreshDiskFolders(); // relit le disque : un sous-dossier vide renommé garde la bonne casse
    showWriteToast(t('Folder renamed'));
    return null;
  } catch (error) {
    return String(error);
  } finally {
    photoMoveRunning = false;
  }
}

// Déplacement : tâche de la file (progression, arrêt possible entre deux fichiers, voir move_photos). Les fichiers déjà déplacés le restent après un arrêt.
function movePhotosToFolder(targets, folderPath) {
  if (!targets.length) return;
  // Écriture de métadonnées en cours ou en file : le déplacement attend qu'elle soit finie (elle vise les chemins actuels).
  if (isWriteLocked()) { showWriteToast(t('Metadata writing in progress…')); return; }
  enqueueScanTask({
    kind: 'move',
    path: null,
    command: 'move_photos',
    args: { paths: targets.map(photo => photo.path), destination: folderPath },
    labelKey: 'Moving files ({count})',
    labelParams: { count: targets.length },
    onResult: async (result, stopped, error) => {
      if (error) {
        showWriteToast(t('Move failed: {error}', { error }));
        return;
      }
      if (!result) return; // removed from the queue before it started: nothing was moved
      if (result.failed.length) console.error('Move failures', result.failed);
      if (result.moved.length) await applyMovedPhotos(result.moved);
      const parts = [];
      if (result.moved.length) parts.push(tp('{count} file moved', result.moved.length));
      if (result.skipped) parts.push(tp('{count} file already in this folder', result.skipped));
      if (result.failed.length) parts.push(tp('{count} failure', result.failed.length));
      const renamed = sidecarRenameNotice(result);
      if (renamed.text) parts.push(renamed.text);
      // Failures: "Details" lists them all (with the renames and their log); otherwise the renames' "Show log" button.
      const action = failureDetailsAction(t('Some files could not be moved'), result.failed, { notes: [renamed.text], logPath: result.log_path }) ?? renamed.action;
      if (!stopped || renamed.text || result.failed.length) {
        showWriteToast(!result.moved.length && !result.skipped && result.failed.length
          ? t('Move failed: {error}', { error: result.failed[0].error })
          : parts.join(' · '), false, action, action ? 12000 : null);
      }
    },
  });
}

async function copyPhotosToFolder(targets, folderPath) {
  if (!targets.length) return;
  const paths = targets.map(photo => photo.path);
  const resolutions = await askCopyResolutions('tracked_copy_conflicts', paths, folderPath); // fichiers déjà présents à destination : l'utilisateur choisit
  if (!resolutions) return; // copie annulée
  enqueueScanTask({
    kind: 'copy',
    path: null,
    command: 'copy_photos_to_tracked_folder',
    args: { paths, destination: folderPath, resolutions },
    labelKey: 'Copying files ({count})',
    labelParams: { count: targets.length },
    onResult: async (result, stopped, error) => {
      if (error) {
        showWriteToast(t('Copy failed: {error}', { error }));
        return;
      }
      if (!result) return; // removed from the queue before it started: nothing was copied
      if (result.failed.length) console.error('Copy failures', result.failed);
      if (result.copied) {
        const changes = await invoke('sync_library', { excluded: pausedScanFolders() });
        if (changes.added.length || changes.updated.length || changes.removed.length) await refreshLibraryAfterSync(changes);
      }
      const renamed = sidecarRenameNotice(result);
      const action = failureDetailsAction(t('Some files could not be copied'), result.failed, { notes: [renamed.text], logPath: result.log_path }) ?? renamed.action;
      if (!stopped || renamed.text || result.failed.length) {
        showWriteToast(!result.copied && result.failed.length
          ? t('Copy failed: {error}', { error: result.failed[0].error })
          : [tp('{count} file copied', result.copied), result.skipped ? tp('{count} file skipped', result.skipped) : '', result.failed.length ? tp('{count} failure', result.failed.length) : '', renamed.text].filter(Boolean).join(' · '),
        false, action, action ? 12000 : null);
      }
    },
  });
}

// Met à jour l'interface après un déplacement. Les photos gardent leur objet (le chemin et le nom changent) pour que la sélection soit retrouvée par
// chemin, puis la liste est relue depuis la base sans remonter la grille : une photo déplacée hors du dossier affiché en disparaît.
async function applyMovedPhotos(moved) {
  const destinations = new Map(moved.map(item => [item.from, item.to]));
  const rename = list => {
    for (const photo of list) {
      const destination = destinations.get(photo.path);
      if (!destination) continue;
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
  previewSignature = ''; // force le rechargement de l'aperçu
  fullscreenImageCache.clear();
  await refreshLibraryAfterSync({ added: [], updated: [], removed: [] });
}

// ==========================================
// FILTRE DE DATE (date de prise de vue EXIF)
// ==========================================
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

// Un jeton AAAA, AAAAMM, AAAAMMJJ, AAAAMMJJHH, AAAAMMJJHHmm ou AAAAMMJJHHmmss : renvoie le premier et le dernier instant
// (AAAAMMJJHHmmss) de la période. Les parties absentes valent le début (01, 00) ou la fin (12, 31, 23, 59, 59).
function parseDateToken(token) {
  const year = Number(token.slice(0, 4));
  const month = token.length >= 6 ? Number(token.slice(4, 6)) : null;
  const day = token.length >= 8 ? Number(token.slice(6, 8)) : null;
  const hour = token.length >= 10 ? Number(token.slice(8, 10)) : null;
  const minute = token.length >= 12 ? Number(token.slice(10, 12)) : null;
  const second = token.length >= 14 ? Number(token.slice(12, 14)) : null;
  if (year < 1000) return null;
  if (month !== null && (month < 1 || month > 12)) return null;
  if (day !== null && !isValidDateKey(year * 10000 + month * 100 + day)) return null;
  if (hour !== null && hour > 23) return null;
  if (minute !== null && minute > 59) return null;
  if (second !== null && second > 59) return null;
  const pad = value => String(value).padStart(2, '0');
  const build = (m, d, h, mi, s) => Number(`${year}${pad(m)}${pad(d)}${pad(h)}${pad(mi)}${pad(s)}`);
  return {
    start: build(month ?? 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0),
    end: build(month ?? 12, day ?? 31, hour ?? 23, minute ?? 59, second ?? 59),
  };
}

function parseDateFilter(text) {
  const compact = text.replace(/\s+/g, '');
  if (!compact) return { filter: null };
  const token = '(\\d{4}|\\d{6}|\\d{8}|\\d{10}|\\d{12}|\\d{14})';
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
  fullscreenImageCache.clear();
  renderFolderTree();
  renderKeywordFilters();

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
  } else {
    renderPreview();
    clearFullscreenImage();
    updateRatingAction();
  }
}

initPhotoActions({
  // "Turn" submenu (lossless rotation, see rotatePhotos): only the HEIC / HEIF and videos of the targets are left out.
  isRotatablePath,
  rotatePhotos: (targets, quarterTurns) => rotatePhotos(quarterTurns, targets),
  // Album manuel affiché (nom pour le menu) et retrait de photos de cet album (albums-panel.js).
  getCurrentManualAlbum: () => { const album = getSelectedAlbum(); return album?.kind === 'manual' ? album : null; },
  removeFromAlbum: targets => removePhotosFromSelectedAlbum(targets.map(photo => photo.id)),
  // « Trouver le RAW » (voir la section du même nom) : disponible tant qu'au moins un critère est coché dans les Paramètres.
  findRaw: findRawFor,
  canFindRaw: hasRawSearchCriteria,
  isRawSearchActive: () => rawSearch !== null || duplicateSearch !== null || semanticSearch !== null, // results views, where "Show in its folder" is offered
  findDuplicates: findDuplicateImages,
  openDuplicatesDialog,
  showInItsFolder: showPhotoInItsFolder,
  isAllPhotosView, // "Show in its own folder" in the menu of one photo of "All photos"
  getPhotos: () => photos,
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
  folderPhotoCount: path => {
    if (!folderCountsSignature) return undefined;
    const folder = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return (includeSubfolders ? folderCountsTree : folderCountsOwn).get(folder) ?? 0;
  },
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
initRawSettings(); // Paramètres > Divers > RAW : critères de « Trouver le RAW »
initLocationPanel({ showToast: message => showWriteToast(message) });
// Albums virtuels : arbre du panneau de gauche (le contenu des albums s'affichera aux étapes suivantes).
initAlbumsPanel({
  showToast: (message, action) => showWriteToast(message, false, action),
  // Un album a été choisi, modifié ou supprimé : la grille recharge ce qu'il faut afficher (voir loadPhotos).
  onSelectionChange: () => { abandonRawSearch(); abandonDuplicateSearch(); abandonSemanticSearch(); syncSmartAlbumWithSelection(); loadPhotos(); },
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
    for (const photo of loadedPhotos) {
      const update = byId.get(photo.id);
      if (update) Object.assign(photo, { gps_lat: update.gps_lat, gps_lon: update.gps_lon });
    }
    if (locationFilter !== 'all') applyPhotoFilters({ keepState: true });
    else { renderVisibleItems(); updateUIOnSelection(); }
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
  // Écriture de beaucoup de fichiers : tâche de la file (progression, arrêt possible). `onResult` reçoit le résultat de la commande
  // (ou null si elle a échoué ou si la tâche a été retirée de la file). Renvoie la tâche, ou null si elle n'a pas pu être mise en file.
  enqueueKeywordTask: (command, args, count, onResult) => {
    const queued = enqueueScanTask({
      kind: 'keywords',
      path: null,
      command,
      args,
      labelKey: 'Metadata writing ({count})',
      labelParams: { count },
    });
    const task = queued ? [...scanTasks].reverse().find(candidate => candidate.kind === 'keywords' && !candidate.onResult) : null;
    if (!task) return null;
    task.onResult = onResult;
    return task;
  },
  // Valeurs relues dans les fichiers écrits (mots-clés à plat, titre, description) : mises à jour dans les listes de photos, le filtre de
  // mots-clés et le panneau Info.
  updatePhotoMetadata: written => {
    const updates = new Map(written.map(entry => [entry.photo_id, entry]));
    const rewritten = new Set();
    for (const list of new Set([loadedPhotos, folderTreePhotos, photos])) {
      for (const photo of list) {
        const entry = updates.get(photo.id);
        if (!entry) continue;
        photo.keywords = entry.keywords;
        photo.title = entry.title;
        photo.caption = entry.description;
        if (Number.isFinite(entry.gps_lat) && Number.isFinite(entry.gps_lon)) { photo.gps_lat = entry.gps_lat; photo.gps_lon = entry.gps_lon; } // position écrite (mode Carte)
        rewritten.add(photo.path);
      }
    }
    forgetCachedImagePaths([...rewritten]);
    renderKeywordFilters();
    updateUIOnSelection();
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
});

// Onglet Description du panneau de droite (voir description-panel.js) : titre et description des photos sélectionnées.
initDescriptionPanel({ getSelectedPhotos });

// Histogramme de la photo courante et écrêtage (voir histogram.js). Affiché en bas à droite du plein écran, sinon de l'aperçu (s'il est visible) ou de la grille ;
// jamais en mode Comparer, ni dans les vues Carte, Personnes et Visages. La surcouche d'écrêtage ne se pose que sur l'image de l'aperçu et du plein écran.
const mapPanelElement = document.getElementById('map-panel');
const personsViewElement = document.getElementById('persons-view');
const facesViewElement = document.getElementById('faces-view');
// Diaporama (slideshow.js) : le plein écran passe de photo en photo à intervalle réglé.
initSlideshow({
  getPhotos: () => photos,
  getSelectedIndices: () => selectedIndices,
  getCurrentIndex: () => lastSelectedIndex,
  isVideo: photo => isVideoPath(photo.path),
  isZoomed: () => fullscreenSlot.zoom !== null,
  isFullscreen: () => isFullscreen,
  openFullscreen,
  goToIndex: navigateToPhotoIndex,
  showToast: message => showWriteToast(message),
});
initHistogram({
  // Éléments dont un redimensionnement ou un changement de classe / d'attribut hidden déplace ou masque l'histogramme.
  watch: [mainContent, gridContainer, previewStage, mapPanelElement, personsViewElement, facesViewElement, fullscreenView, document.getElementById('exif-panel')],
  getView: () => {
    const photo = selectedIndices.size > 0 ? photos[lastSelectedIndex] ?? null : null;
    const otherViewOpen = gridContainer.hidden || !mapPanelElement.hidden || !personsViewElement.hidden || !facesViewElement.hidden;
    const previewShown = !mainContent.classList.contains('preview-hidden');
    const hidden = !isFullscreen && (compareMode || otherViewOpen);
    let overlays = [];
    if (isFullscreen) overlays = fullscreenSlot.photo === photo ? [fullscreenSlot.clip] : []; // image du plein écran = photo courante
    else if (!hidden && previewShown) overlays = previewSlots.filter(slot => slot.photo === photo).map(slot => slot.clip);
    return {
      photo, hidden, fullscreen: isFullscreen, overlays,
      anchor: isFullscreen ? null : previewShown ? previewStage : gridContainer,
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
  getFullscreenSlot: () => fullscreenSlot,
  getPreviewSlotAt: event => previewSlotFromEvent(event),
  isFullscreen: () => isFullscreen,
  layoutPreview: () => previewSlots.forEach(layoutPreviewSlot),
  showToast: message => showWriteToast(message),
  enqueueTask: task => enqueueScanTask(task),
  // Détection désactivée : les vues Personnes et de gestion se ferment.
  closeFacesView: () => { closeFacesView(); closePersonsView(); },
  onFacesChanged: () => { reloadFacesView(); reloadPersonsView(); },
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
// CONTENT SEARCH RESULTS
// ==========================================
// Mode `semanticSearch`, built like `duplicateSearch` / `rawSearch`: the grid shows the photos of the backend answer sorted by relevance, a banner
// gives the query, the count, the relevance slider and "Close". Navigating by hand (folder, album, sub-folder option) ends it, and so does
// disabling the feature. The slider is a plain filter (`matchesSemanticCut`): no new request when it moves (spec §18.2).
const semanticDelta = () => readNumber('semanticRelevance', 0.005, 0.08);
let semanticSliderFrame = 0;
let semanticSortMode = readChoice('semanticKeywordSort', ['grid', 'score']); // order of the photos carrying the typed keyword

// Position in the answer (decreasing score); the source photo of a similar-content search is -1, photos outside the answer come last.
function semanticRankOrder(a, b) {
  const rankA = semanticSearch.rank.get(a.id) ?? Infinity;
  const rankB = semanticSearch.rank.get(b.id) ?? Infinity;
  return rankA === rankB ? 0 : rankA - rankB;
}

// The photos of the answer, read again each time the mode reloads (a rescan, a metadata write).
function loadSemanticPhotos() {
  return invoke('get_photos_by_ids', { ids: semanticSearch.ids });
}

// Relative threshold of §7.1: a result stays while cos >= best - delta. The source photo of a similar-content search always stays.
function matchesSemanticCut(photo) {
  if (!semanticSearch) return true;
  if (semanticSearch.keyword) return true; // keyword candidates: the backend threshold is the rule, the slider is hidden
  if (photo.id === semanticSearch.sourceId || semanticSearch.carried.has(photo.id)) return true; // tagged with the typed keyword: always kept
  const cos = semanticSearch.cos.get(photo.id);
  return cos !== undefined && cos >= semanticSearch.best - semanticDelta();
}

function renderSemanticBanner() {
  // Elements read at each call: the function can run before this section of the module has been executed.
  const banner = document.getElementById('semantic-banner');
  if (!banner) return;
  banner.hidden = !semanticSearch;
  if (!semanticSearch) return;
  const search = semanticSearch;
  const shown = photos.filter(photo => photo.id !== search.sourceId).length;
  const parts = [search.label, tp('{count} result', shown)];
  const carriedShown = photos.filter(photo => search.carried.has(photo.id)).length;
  if (carriedShown > 0) parts.push(tp('{count} tagged with this keyword', carriedShown, { count: carriedShown.toLocaleString() }));
  const sortButton = document.getElementById('semantic-sort');
  sortButton.hidden = search.carried.size === 0;
  fillSortButton(sortButton, semanticSortMode);
  if (search.keyword) parts.splice(1, 0, search.keyword.kind === 'examples' ? tp('like your {count} photo tagged with it', search.keyword.examples) : t('from the keyword name'));
  // More than the cap was scored and the cut did not stop before it: say that the list is the best part only.
  const cut = search.best - semanticDelta();
  if (!search.keyword && search.capped && search.lastCos >= cut) parts.push(t('The {count} best results only', { count: search.ids.length - (search.sourceId === null ? 0 : 1) }));
  document.getElementById('semantic-text').textContent = parts.join(' · ');
  const slider = document.getElementById('semantic-relevance');
  slider.closest('.semantic-relevance').hidden = Boolean(search.keyword); // the slider counts text cosines: not for keyword candidates
  renderSemanticKeywordActions();
  if (Number(slider.value) !== semanticDelta()) slider.value = String(semanticDelta());
  // Photos of the scope the analysis would still handle (never analysed, or changed since): the answer's `pending`, no other call.
  const pendingRow = document.getElementById('semantic-pending-row');
  pendingRow.hidden = !(search.pending > 0);
  if (search.pending > 0) {
    const where = t(search.scopeKind === 'folder' ? 'this folder' : search.scopeKind === 'library' ? 'the library' : 'the current view');
    document.getElementById('semantic-pending-text').textContent = tp('{count} photo of {where} is not analysed yet, or changed since its analysis', search.pending, { count: search.pending.toLocaleString(), where });
  }
}

document.getElementById('semantic-close')?.addEventListener('click', () => exitSemanticSearch());
// "Grid" / "Score": order of the photos carrying the typed keyword (same button as the Faces view). Sorting again keeps selection and scroll.
document.getElementById('semantic-sort')?.addEventListener('click', () => {
  semanticSortMode = semanticSortMode === 'score' ? 'grid' : 'score';
  try { localStorage.setItem('semanticKeywordSort', semanticSortMode); } catch { /* storage unavailable: the choice is not remembered */ }
  renderSemanticBanner();
  if (!semanticSearch) return;
  fullscreenImageCache.clear(); // the preload cache is indexed by position in the list
  applyPhotoFilters({ keepState: true });
});
onLanguageChange(() => renderSemanticBanner());
document.getElementById('semantic-relevance')?.addEventListener('input', event => {
  try { localStorage.setItem('semanticRelevance', event.target.value); } catch { /* storage unavailable: the choice is not remembered */ }
  if (!semanticSearch) return;
  // One refresh per frame while the slider is dragged.
  cancelAnimationFrame(semanticSliderFrame);
  semanticSliderFrame = requestAnimationFrame(() => {
    fullscreenImageCache.clear(); // the preload cache is indexed by position in the list
    applyPhotoFilters({ keepState: true });
  });
});
// "Analyse": the same scope as the search, in the semantic lane of the queue. The results are not refreshed by themselves: the user searches again.
document.getElementById('semantic-analyse')?.addEventListener('click', () => {
  if (!semanticSearch) return;
  const { folder, recursive, photoIds } = semanticSearch.scope;
  analyseContent({ folder, recursive, photoIds });
});

// Keyword -> photos: actions on the selected photos. Disabled while nothing is selected.
function renderSemanticKeywordActions() {
  const row = document.getElementById('semantic-keyword-row');
  if (!row) return;
  const keyword = semanticSearch?.keyword ?? null;
  row.hidden = !keyword;
  if (!keyword) return;
  const count = getSelectedPhotos().length;
  const add = document.getElementById('semantic-keyword-add');
  add.textContent = t('Add keyword “{name}”', { name: keyword.name });
  add.title = t('Add the keyword to the selected photos as a pending change (nothing is written until “Write to files”)');
  add.disabled = count === 0;
  document.getElementById('semantic-keyword-reject').disabled = count === 0;
  document.getElementById('semantic-keyword-hint').textContent = count === 0 ? t('Select photos to tag them') : tp('{count} photo selected', count, { count: count.toLocaleString() });
}

// "Add keyword": a pending keyword on the selection through the Keywords panel; the photos stay in the list until the user writes it.
document.getElementById('semantic-keyword-add')?.addEventListener('click', async () => {
  const keyword = semanticSearch?.keyword;
  if (!keyword) return;
  const count = await addPendingKeyword(keyword.id);
  showWriteToast(count > 0
    ? tp('Keyword “{name}” added to {count} photo: click “Write to files” to save it', count, { name: keyword.name })
    : t('The keyword could not be added to the selection'));
});

// "Not this keyword": the selected photos are never suggested for it again; they leave the list at once (no new request).
document.getElementById('semantic-keyword-reject')?.addEventListener('click', async () => {
  const search = semanticSearch;
  if (!search?.keyword) return;
  const ids = getSelectedPhotos().map(photo => photo.id).filter(id => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return;
  const { error } = await rejectKeywordSuggestion(ids, search.keyword.id);
  if (error) { showWriteToast(semanticErrorMessage(error)); return; }
  if (semanticSearch !== search) return; // the mode was closed or replaced meanwhile
  const gone = new Set(ids);
  search.ids = search.ids.filter(id => !gone.has(id));
  for (const id of gone) { search.cos.delete(id); search.prob.delete(id); search.rank.delete(id); search.carried.delete(id); }
  loadedPhotos = loadedPhotos.filter(photo => !gone.has(photo.id));
  fullscreenImageCache.clear();
  applyPhotoFilters({ keepState: true });
  showWriteToast(tp('{count} photo will no longer be suggested for “{name}”', ids.length, { name: search.keyword.name }));
});

// Ends the mode without reopening the previous view (same contract as abandonDuplicateSearch).
function abandonSemanticSearch() {
  if (!semanticSearch) return;
  const { snapshot } = semanticSearch;
  semanticSearch = null;
  setIncludeSubfoldersTemporarily(snapshot.includeSubfolders);
  resetAllFilters();
  if (snapshot.albumKind !== 'smart') applyFilterState(snapshot.filterState);
  renderSemanticBanner();
}

// "Close" and Escape.
async function exitSemanticSearch() {
  if (!semanticSearch) return;
  const { snapshot } = semanticSearch;
  abandonSemanticSearch();
  await restoreViewSnapshot(snapshot);
}

// Opens the mode on a backend answer. `spec`: { label, answer, scope, viewScope, sourcePhoto }. Returns false when the user declined to leave a
// modified smart album. A new search from inside the mode replaces the results and keeps the view to go back to.
async function showSemanticResults({ label, answer, scope, viewScope, sourcePhoto = null, keyword = null, carriedIds = [] }) {
  if (isSelectedAlbumDirty() && !(await confirmLeaveAlbum())) return false;
  if (isFullscreen) closeFullscreen();
  const album = getSelectedAlbum();
  const snapshot = semanticSearch?.snapshot ?? duplicateSearch?.snapshot ?? rawSearch?.snapshot ?? captureViewSnapshot(album);
  abandonDuplicateSearch();
  abandonRawSearch(); // both put back the filters of before their search; the snapshot above is the view to go back to
  clearAlbumSelection();
  syncSmartAlbumWithSelection();
  resetAllFilters();
  // A search over a folder keeps it highlighted in the tree (the list itself no longer depends on it); other scopes show "All photos".
  currentFolderFilter = scope.folder ?? null; extraFolderFilters = [];
  const sourceId = sourcePhoto?.id ?? null;
  const search = {
    label, snapshot, scope, viewScope, sourceId, keyword, scopeKind: scope.folder ? 'folder' : semanticScope() === 'library' ? 'library' : 'view',
    best: answer.best, capped: answer.capped, pending: answer.pending, total: answer.total,
    lastCos: answer.results.length ? answer.results[answer.results.length - 1].cos : Infinity,
    ids: answer.results.map(result => result.photoId), cos: new Map(), prob: new Map(), rank: new Map(),
  };
  answer.results.forEach((result, index) => { search.cos.set(result.photoId, result.cos); search.prob.set(result.photoId, result.prob); search.rank.set(result.photoId, index); });
  if (sourceId !== null) { search.ids.push(sourceId); search.rank.set(sourceId, -1); } // the source photo is not in the results: shown first
  // Photos tagged with the typed keyword (toolbar box): always listed, before the content results; some may be outside the answer (no score).
  search.carried = new Set(carriedIds);
  const known = new Set(search.ids);
  for (const id of carriedIds) if (!known.has(id)) search.ids.push(id);
  semanticSearch = search;
  renderFolderTree();
  await loadPhotos();
  return true;
}

// "Find similar content" (menu of one photo). The interface does not know whether the photo has an embedding: the backend says so, and the user is
// offered to analyse it. The photo itself is not in the results: it is shown first, marked as the source.
async function findSimilarContent(photo) {
  if (!photo || !isSemanticEnabled()) return;
  const viewScope = currentViewScope();
  const scope = currentSearchScope(viewScope);
  const { answer, error } = await searchImage(photo.id, scope);
  if (error === 'semantic_photo_not_analysed') {
    const analyse = await confirmDialog({
      title: t('Photo not analysed'),
      message: t('This photo has not been analysed yet, so similar content cannot be found. Analyse it now? It only takes a moment; search again once the analysis is done.'),
      confirmLabel: t('Analyse'),
      cancelLabel: t('Cancel'),
    });
    if (analyse) analyseContent({ photoIds: [photo.id] });
    return;
  }
  if (error) { showWriteToast(semanticErrorMessage(error)); return; }
  if (!answer) return; // a newer search made this answer stale
  // Image-to-image cosines are not on the scale of text ones (spec §18.3, §14-5): the values the relevance slider has to work with, for tuning.
  const at = rank => answer.results[rank - 1]?.cos;
  console.debug('Similar content cosines', { best: answer.best, rank10: at(10), rank50: at(50), rank200: at(200), count: answer.results.length });
  await showSemanticResults({ label: t('Content similar to {name}', { name: photo.path.split(/[\\/]/).pop() }), answer, scope, viewScope, sourcePhoto: photo });
}

// "Find photos that may match" (menu of a keyword): the candidates of the backend (examples or name score, threshold already applied, never the
// photos that carry the keyword nor the dismissed ones) in the results mode, with the scope of the search toggle like the other entries.
async function findKeywordCandidates({ id, name }) {
  if (!isSemanticEnabled()) return;
  const viewScope = currentViewScope();
  const scope = currentSearchScope(viewScope);
  const { answer, error } = await fetchKeywordCandidates(id, scope);
  if (error) { showWriteToast(semanticErrorMessage(error)); return; }
  if (!answer) return; // a newer request made this answer stale
  await showSemanticResults({
    label: t('Photos that may deserve “{name}”', { name }), answer, scope, viewScope,
    keyword: { id, name, kind: answer.kind, examples: answer.examples },
  });
}

// Content search field of the toolbar (see semantic.js).
initSemanticSearch({
  getViewScope: () => currentViewScope(),
  showToast: message => showWriteToast(message),
  errorMessage: semanticErrorMessage,
  onSearch: async query => {
    const viewScope = currentViewScope(); // read before the mode changes the view
    const scope = currentSearchScope(viewScope);
    // The box is shared with the keyword search: the photos tagged with the typed text come first, then the content results.
    const [answer, carriedIds] = await Promise.all([
      searchText(query, scope),
      readBool('semanticKeywordsInSearch') ? invoke('semantic_keyword_photos', { query, scope }).catch(() => []) : [],
    ]);
    if (!answer) return;
    await showSemanticResults({ label: `“${query}”`, answer, scope, viewScope, carriedIds });
  },
});
onSemanticChange(() => { if (semanticSearch && !isSemanticEnabled()) exitSemanticSearch(); }); // disabled, or the model deleted

// Suggestions in the keyword filter (see semantic-keywords.js): a new answer filters the grid again, keeping selection and scroll.
initKeywordSuggestions({
  loadedIds: () => new Set(loadedPhotos.map(photo => photo.id)),
  onChange: () => { fullscreenImageCache.clear(); applyPhotoFilters({ keepState: true }); },
  addKeyword: keywordId => addPendingKeyword(keywordId),
  showToast: message => showWriteToast(message),
});

// Vue Personnes (voir persons-view.js) : une vignette par personne, ouverte par le bouton « Visages » de la barre du haut.
initPersonsView({
  setPhotoGridVisible,
  closeFacesView: () => { closeFacesView(); closeMapModeNow(); }, // appelée à l'ouverture de la vue : une seule vue à la fois
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
  requestCloseFacesView: () => requestCloseFacesView(),
  setMapLayout: open => { mainContent.classList.toggle('map-mode', open); requestAnimationFrame(updateVirtualScroller); },
  layoutPreview: () => requestAnimationFrame(() => previewSlots.forEach(layoutPreviewSlot)),
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
  closePersonsView: () => { closePersonsView(); closeMapModeNow(); }, // appelée à l'ouverture de la vue de gestion : une seule vue à la fois
  showToast: (message, action) => showWriteToast(message, false, action), // `action` : bouton « Annuler » des actions de révision
  getPersonRoot,
  isFullscreen: () => isFullscreen,
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
  if (librarySyncRunning || foregroundTaskCount() > 0 || photoMoveRunning || Date.now() < librarySyncNotBefore) return;
  librarySyncRunning = true;
  const startedAt = Date.now();
  try {
    const changes = await invoke('sync_library', { excluded: pausedScanFolders() });
    if (changes.added.length || changes.updated.length || changes.removed.length) await refreshLibraryAfterSync(changes);
  } catch (error) {
    console.debug('Disk synchronization failed', error);
  } finally {
    librarySyncNotBefore = Date.now() + Math.max(LIBRARY_SYNC_MIN_INTERVAL_MS, (Date.now() - startedAt) * 10);
    librarySyncRunning = false;
  }
  if (syncAfterTasks && foregroundTaskCount() === 0 && !photoMoveRunning) runRequestedSync();
}

// Synchronisation demandée par l'application elle-même (fichiers qu'elle vient de créer) : sans délai minimal, et jamais perdue : si une tâche
// tourne (ou une synchronisation, ou un déplacement), elle est faite dès que la file est vide (voir pumpScanQueue).
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
    queryFolderPhotos(folderAtStart, prefilter),
    folderAtStart === null && !prefilter ? null : queryPhotoPage(null),
  ]);
  const stale = () => folderAtStart !== currentFolderFilter || generation !== photoLoadGeneration;
  if (stale()) return; // dossier changé (ou liste relue) pendant le chargement : le rechargement normal fait foi
  const cap = fresh.capped ? { total: await countDisplayedPhotos(prefilter) } : null;
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
    previewSignature = ''; // force le rechargement de l'aperçu
    fullscreenImageCache.clear();
  }
  loadedPhotos = fresh;
  folderTreePhotos = everything ?? fresh;
  renderFolderTree();
  renderKeywordFilters();
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
  const segments = target.split('/');
  for (let n = 1; n < segments.length; n++) folderTreeExpanded.add(segments.slice(0, n).join('/'));
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