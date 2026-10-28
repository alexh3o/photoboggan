// Paramètres, onglet Métadonnées : chemin d'écriture des métadonnées (ExifTool ou écriture interne), exécutable ExifTool, et priorité de lecture
// des formats de chaque type de métadonnée (liste déroulante du type + tableau ordonnable).
// Les réglages sont mémorisés localement et envoyés au backend au démarrage puis à chaque changement (voir src-tauri/src/exiftool.rs et
// exif::set_read_priority).

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { t, onLanguageChange } from './i18n.js';
import { createOrderList } from './order-list.js';

const WRITER_STORAGE_KEY = 'metadataWriter'; // « exiftool » (par défaut) ou « internal »
const EXIFTOOL_PATH_STORAGE_KEY = 'exiftoolPath'; // exécutable choisi par l'utilisateur ; vide : détection automatique
const ORDER_KIND_STORAGE_KEY = 'metadataOrderKind'; // type de métadonnée affiché dans le tableau des priorités

// Formats lus pour chaque type de métadonnée, dans l'ordre de lecture par défaut. Le premier qui contient une valeur l'emporte ; tous sont écrits.
// Identifiants : ceux de exif.rs (HIERARCHY_IDS, TITLE_SOURCE_IDS, DESCRIPTION_SOURCE_IDS, RATING_SOURCE_IDS, COLOR_SOURCE_IDS).
const READ_ORDERS = {
  keywords: {
    storageKey: 'keywordFormatOrder',
    formats: [
      { id: 'digikam', label: 'digiKam', property: 'digiKam:TagsList' },
      { id: 'lightroom', label: 'Adobe Lightroom', property: 'lr:hierarchicalSubject' },
      { id: 'mediapro', label: 'Media Pro', property: 'mediapro:CatalogSets' },
      { id: 'microsoft', label: 'Microsoft Photo', property: 'MicrosoftPhoto:LastKeywordXMP' },
      { id: 'acdsee', label: 'ACDSee', property: 'acdsee:categories' },
    ],
  },
  title: {
    storageKey: 'titleFormatOrder',
    formats: [
      { id: 'xmp-dc', label: 'XMP', property: 'dc:title' },
      { id: 'xmp-acdsee', label: 'ACDSee (XMP)', property: 'acdsee:caption' },
      { id: 'iptc', label: 'IPTC', property: 'ObjectName' },
      { id: 'exif-xp', label: 'EXIF (Windows)', property: 'XPTitle' },
    ],
  },
  description: {
    storageKey: 'descriptionFormatOrder',
    formats: [
      { id: 'xmp-dc', label: 'XMP', property: 'dc:description' },
      { id: 'xmp-exif', label: 'XMP EXIF', property: 'exif:UserComment' },
      { id: 'xmp-tiff', label: 'XMP TIFF', property: 'tiff:ImageDescription' },
      { id: 'xmp-acdsee', label: 'ACDSee (XMP)', property: 'acdsee:notes' },
      { id: 'jpeg-comment', label: 'JPEG', property: 'Comment' },
      { id: 'exif-image', label: 'EXIF', property: 'ImageDescription' },
      { id: 'exif-user-comment', label: 'EXIF', property: 'UserComment' },
      { id: 'exif-xp', label: 'EXIF (Windows)', property: 'XPComment' },
      { id: 'iptc', label: 'IPTC', property: 'Caption-Abstract' },
    ],
  },
  rating: {
    storageKey: 'ratingFormatOrder',
    formats: [
      { id: 'xmp', label: 'XMP', property: 'xmp:Rating' },
      { id: 'microsoft', label: 'Microsoft Photo', property: 'MicrosoftPhoto:Rating' },
      { id: 'acdsee', label: 'ACDSee', property: 'acdsee:rating' },
      { id: 'exif', label: 'EXIF (Windows)', property: 'Rating' },
      { id: 'exif-percent', label: 'EXIF (Windows)', property: 'RatingPercent' },
    ],
  },
  color: {
    storageKey: 'colorFormatOrder',
    formats: [
      { id: 'xmp-label', label: 'XMP', property: 'xmp:Label' },
      { id: 'digikam', label: 'digiKam', property: 'digiKam:ColorLabel' },
      { id: 'urgency', label: 'Photoshop', property: 'photoshop:Urgency' },
    ],
  },
  // Zones de visage (lues seulement si Paramètres > Visages > « Lire les données de visages » est coché ; voir faces.rs).
  faces: {
    storageKey: 'faceRegionFormatOrder',
    formats: [
      { id: 'mwg', label: 'MWG (digiKam, Lightroom)', property: 'mwg-rs:Regions' },
      { id: 'microsoft', label: 'Microsoft Photo', property: 'MP:RegionInfo' },
      { id: 'acdsee', label: 'ACDSee', property: 'acdsee-rs:Regions' },
    ],
  },
};

let writerMode = localStorage.getItem(WRITER_STORAGE_KEY) === 'internal' ? 'internal' : 'exiftool';
let customPath = localStorage.getItem(EXIFTOOL_PATH_STORAGE_KEY) || '';
let lastStatus = null; // dernier état renvoyé par get_exiftool_status
let statusToken = 0;

function sendSettings() {
  return invoke('set_metadata_writer', { mode: writerMode, customPath: customPath || null })
    .catch(error => console.error("Réglage de l'écriture des métadonnées refusé", error));
}

function renderStatus() {
  const status = document.getElementById('exiftool-status');
  const resetButton = document.getElementById('btn-reset-exiftool');
  resetButton.classList.toggle('hidden', !customPath);
  if (!lastStatus) {
    status.textContent = t('Looking for ExifTool…');
    status.classList.remove('exiftool-missing');
    return;
  }
  if (lastStatus.available) {
    const sourceLabels = { bundled: t('embedded version'), path: t('found in the PATH'), custom: t('chosen file') };
    // Le préfixe « \\?\ » (chemin étendu Windows) est retiré : il n'apporte rien à l'utilisateur.
    const path = String(lastStatus.path).replace(/^\\\\\?\\/, '');
    status.textContent = t('{version} ({source}): {path}', {
      version: lastStatus.version,
      source: sourceLabels[lastStatus.source] || lastStatus.source,
      path,
    });
    status.title = path;
  } else {
    // Le message du backend détaille ce qui a été essayé (version embarquée, PATH, chemin choisi).
    status.textContent = `${lastStatus.error}${writerMode === 'exiftool' ? ` ${t('Metadata will not be written until ExifTool is found.')}` : ''}`;
  }
  status.classList.toggle('exiftool-missing', !lastStatus.available);
}

// Nouvelle détection (l'utilisateur a pu installer ou déplacer ExifTool) : à l'ouverture de l'onglet et après un changement de réglage.
async function refreshStatus() {
  const token = ++statusToken;
  lastStatus = null;
  renderStatus();
  try {
    const status = await invoke('get_exiftool_status');
    if (token === statusToken) lastStatus = status;
  } catch (error) {
    if (token === statusToken) lastStatus = { available: false, error: String(error) };
  }
  if (token === statusToken) renderStatus();
}

async function changeSettings(update) {
  update();
  localStorage.setItem(WRITER_STORAGE_KEY, writerMode);
  if (customPath) localStorage.setItem(EXIFTOOL_PATH_STORAGE_KEY, customPath);
  else localStorage.removeItem(EXIFTOOL_PATH_STORAGE_KEY);
  await sendSettings();
  refreshStatus();
}

export function initMetadataSettings() {
  sendSettings();
  for (const radio of document.querySelectorAll('input[name="metadata-writer"]')) {
    radio.checked = radio.value === writerMode;
    radio.addEventListener('change', () => {
      if (radio.checked) changeSettings(() => { writerMode = radio.value; });
    });
  }
  document.getElementById('btn-choose-exiftool').addEventListener('click', async () => {
    const chosen = await open({ multiple: false, directory: false, title: t('Choose ExifTool…') });
    if (typeof chosen === 'string' && chosen) changeSettings(() => { customPath = chosen; });
  });
  document.getElementById('btn-reset-exiftool').addEventListener('click', () => changeSettings(() => { customPath = ''; }));
  document.querySelector('.settings-tab-btn[data-tab="metadata"]').addEventListener('click', refreshStatus);

  // Priorité de lecture : un tableau ordonnable par type de métadonnée, tous dans le même élément ; la liste déroulante choisit celui affiché.
  // Chaque ordre est transmis au backend dès le démarrage (avant tout scan).
  const kindSelect = document.getElementById('metadata-order-kind');
  const listElement = document.getElementById('metadata-order-list');
  const orderLists = Object.fromEntries(Object.entries(READ_ORDERS).map(([kind, { storageKey, formats }]) => [kind, createOrderList({
    element: listElement,
    formats,
    storageKey,
    send: order => invoke('set_metadata_read_order', { kind, order }).catch(error => console.error(`Ordre de lecture refusé (${kind})`, error)),
  })]));
  let shownKind = localStorage.getItem(ORDER_KIND_STORAGE_KEY);
  if (!(shownKind in orderLists)) shownKind = 'keywords';
  kindSelect.value = shownKind;
  orderLists[shownKind].render();
  kindSelect.addEventListener('change', () => {
    shownKind = kindSelect.value;
    localStorage.setItem(ORDER_KIND_STORAGE_KEY, shownKind);
    orderLists[shownKind].render();
  });

  onLanguageChange(() => {
    renderStatus();
    orderLists[shownKind].render();
  });
  renderStatus();
}
