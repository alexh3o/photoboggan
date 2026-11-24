// Settings, Metadata tab: ExifTool executable and reading priority of metadata formats
// (metadata kind dropdown + reorderable table). Settings are stored locally and sent to the
// backend at startup and on every change (see src-tauri/src/exiftool.rs and exif::set_read_priority).

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { t, onLanguageChange } from './i18n.js';
import { createOrderList, resolveOrder, formatCells } from './order-list.js';

const EXIFTOOL_PATH_STORAGE_KEY = 'exiftoolPath'; // user-chosen executable; empty = auto-detect
const ORDER_KIND_STORAGE_KEY = 'metadataOrderKind'; // metadata kind shown in the priority table

// Formats read for each metadata type, in default reading order. The first one holding a value wins; all are written.
// Each format is shown as three parts: `source` (XMP, IPTC, EXIF, JPEG), `schema` (who defines it) and `field`
// (technical name, with its XMP prefix when it has one).
// Ids are those of exif.rs (HIERARCHY_IDS, TITLE_SOURCE_IDS, DESCRIPTION_SOURCE_IDS, RATING_SOURCE_IDS, COLOR_SOURCE_IDS, PICK_SOURCE_IDS,
// GPS_SOURCE_IDS). Display only: ids are what is stored and sent to the backend.
const READ_ORDERS = {
  keywords: {
    storageKey: 'keywordFormatOrder',
    formats: [
      { id: 'digikam', source: 'XMP', schema: 'digiKam', field: 'digiKam:TagsList' },
      { id: 'lightroom', source: 'XMP', schema: 'Adobe Lightroom', field: 'lr:hierarchicalSubject' },
      { id: 'mediapro', source: 'XMP', schema: 'Media Pro', field: 'mediapro:CatalogSets' },
      { id: 'microsoft', source: 'XMP', schema: 'Microsoft Photo', field: 'MicrosoftPhoto:LastKeywordXMP' },
      { id: 'acdsee', source: 'XMP', schema: 'ACDSee', field: 'acdsee:categories' },
    ],
    // Flat keyword fields: merged into one list of names, no priority and no effect on the tree (not reorderable, shown below the table).
    flat: [
      { source: 'XMP', schema: 'Dublin Core', field: 'dc:subject' },
      { source: 'IPTC', schema: 'Application', field: 'Keywords', note: 'JPEG only' },
      { source: 'EXIF', schema: 'Windows XP', field: 'XPKeywords', note: 'JPEG only' },
    ],
  },
  title: {
    storageKey: 'titleFormatOrder',
    formats: [
      { id: 'xmp-dc', source: 'XMP', schema: 'Dublin Core', field: 'dc:title' },
      { id: 'xmp-acdsee', source: 'XMP', schema: 'ACDSee', field: 'acdsee:caption' },
      { id: 'iptc', source: 'IPTC', schema: 'Application', field: 'ObjectName' },
      { id: 'exif-xp', source: 'EXIF', schema: 'Windows XP', field: 'XPTitle' },
    ],
  },
  description: {
    storageKey: 'descriptionFormatOrder',
    formats: [
      { id: 'xmp-dc', source: 'XMP', schema: 'Dublin Core', field: 'dc:description' },
      { id: 'xmp-exif', source: 'XMP', schema: 'EXIF', field: 'exif:UserComment' },
      { id: 'xmp-tiff', source: 'XMP', schema: 'TIFF', field: 'tiff:ImageDescription' },
      { id: 'xmp-acdsee', source: 'XMP', schema: 'ACDSee', field: 'acdsee:notes' },
      { id: 'jpeg-comment', source: 'JPEG', schema: 'JPEG comment', field: 'Comment' },
      { id: 'exif-image', source: 'EXIF', schema: 'IFD0', field: 'ImageDescription' },
      { id: 'exif-user-comment', source: 'EXIF', schema: 'Exif IFD', field: 'UserComment' },
      { id: 'exif-xp', source: 'EXIF', schema: 'Windows XP', field: 'XPComment' },
      { id: 'iptc', source: 'IPTC', schema: 'Application', field: 'Caption-Abstract' },
    ],
  },
  rating: {
    storageKey: 'ratingFormatOrder',
    formats: [
      { id: 'xmp', source: 'XMP', schema: 'XMP Basic', field: 'xmp:Rating' },
      { id: 'microsoft', source: 'XMP', schema: 'Microsoft Photo', field: 'MicrosoftPhoto:Rating' },
      { id: 'acdsee', source: 'XMP', schema: 'ACDSee', field: 'acdsee:rating' },
      { id: 'exif', source: 'EXIF', schema: 'Windows', field: 'Rating' },
      { id: 'exif-percent', source: 'EXIF', schema: 'Windows', field: 'RatingPercent' },
    ],
  },
  color: {
    storageKey: 'colorFormatOrder',
    formats: [
      { id: 'xmp-label', source: 'XMP', schema: 'XMP Basic', field: 'xmp:Label' },
      { id: 'digikam', source: 'XMP', schema: 'digiKam', field: 'digiKam:ColorLabel' },
      { id: 'urgency', source: 'XMP', schema: 'Photoshop', field: 'photoshop:Urgency' },
    ],
  },
  pick: {
    storageKey: 'pickFormatOrder',
    formats: [
      { id: 'digikam', source: 'XMP', schema: 'digiKam', field: 'digiKam:PickLabel' },
      { id: 'xmpdm-pick', source: 'XMP', schema: 'Adobe Lightroom', field: 'xmpDM:pick' },
      { id: 'xmpdm-good', source: 'XMP', schema: 'Adobe XMP', field: 'xmpDM:good' },
    ],
  },
  // Face regions (read only if Settings > Faces > "Read face data" is checked; see faces.rs).
  faces: {
    storageKey: 'faceRegionFormatOrder',
    formats: [
      { id: 'mwg', source: 'XMP', schema: 'MWG (digiKam, Lightroom)', field: 'mwg-rs:Regions' },
      { id: 'microsoft', source: 'XMP', schema: 'Microsoft Photo', field: 'MP:RegionInfo' },
      { id: 'acdsee', source: 'XMP', schema: 'ACDSee', field: 'acdsee-rs:Regions' },
    ],
  },
  // GPS coordinates (see exif::GPS_SOURCE_IDS): XMP before EXIF by default, so that a position written by the Map mode is read back.
  gps: {
    storageKey: 'gpsFormatOrder',
    formats: [
      { id: 'xmp', source: 'XMP', schema: 'EXIF', field: 'exif:GPSLatitude / exif:GPSLongitude' },
      { id: 'exif', source: 'EXIF', schema: 'GPS', field: 'GPSLatitude / GPSLongitude' },
    ],
  },
  // Author and rights (Description tab, see exif::AUTHOR_SOURCE_IDS and the lists next to it). Several authors are separated by ";".
  author: {
    storageKey: 'authorFormatOrder',
    formats: [
      { id: 'xmp-dc', source: 'XMP', schema: 'Dublin Core', field: 'dc:creator' },
      { id: 'xmp-tiff', source: 'XMP', schema: 'TIFF', field: 'tiff:Artist' },
      { id: 'iptc', source: 'IPTC', schema: 'Application', field: 'By-line' },
      { id: 'exif', source: 'EXIF', schema: 'IFD0', field: 'Artist' },
    ],
  },
  copyright: {
    storageKey: 'copyrightFormatOrder',
    formats: [
      { id: 'xmp-dc', source: 'XMP', schema: 'Dublin Core', field: 'dc:rights' },
      { id: 'xmp-tiff', source: 'XMP', schema: 'TIFF', field: 'tiff:Copyright' },
      { id: 'iptc', source: 'IPTC', schema: 'Application', field: 'CopyrightNotice' },
      { id: 'exif', source: 'EXIF', schema: 'IFD0', field: 'Copyright' },
    ],
  },
  credit: {
    storageKey: 'creditFormatOrder',
    formats: [
      { id: 'xmp-photoshop', source: 'XMP', schema: 'Photoshop', field: 'photoshop:Credit' },
      { id: 'iptc', source: 'IPTC', schema: 'Application', field: 'Credit' },
    ],
  },
  usageTerms: {
    storageKey: 'usageTermsFormatOrder',
    formats: [
      { id: 'xmp-rights', source: 'XMP', schema: 'XMP Rights', field: 'xmpRights:UsageTerms' },
    ],
  },
  authorEmail: {
    storageKey: 'authorEmailFormatOrder',
    formats: [
      { id: 'xmp-iptc-core', source: 'XMP', schema: 'IPTC Core', field: 'iptcCore:CreatorWorkEmail' },
    ],
  },
};

// Format de fanion pick placé en tête de l'ordre de lecture : il décide des fanions proposés dans les boutons de marquage (main.js). `listener()` est
// appelé quand l'ordre change.
const pickOrderListeners = [];
export function onPickOrderChange(listener) {
  pickOrderListeners.push(listener);
}
export function topPickFormat() {
  const { storageKey, formats } = READ_ORDERS.pick;
  return resolveOrder(formats, storageKey)[0]; // même ordre que le tableau et le backend
}

let customPath = localStorage.getItem(EXIFTOOL_PATH_STORAGE_KEY) || '';
let lastStatus = null; // dernier état renvoyé par get_exiftool_status
let statusToken = 0;

function sendSettings() {
  return invoke('set_metadata_writer', { customPath: customPath || null })
    .catch(error => console.error('Metadata writer settings refused', error));
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
    // Backend error details what was tried (embedded version, PATH, chosen path).
    status.textContent = `${lastStatus.error} ${t('Metadata will not be written until ExifTool is found.')}`;
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
  if (customPath) localStorage.setItem(EXIFTOOL_PATH_STORAGE_KEY, customPath);
  else localStorage.removeItem(EXIFTOOL_PATH_STORAGE_KEY);
  await sendSettings();
  refreshStatus();
}

export function initMetadataSettings() {
  localStorage.removeItem('metadataWriter');
  localStorage.removeItem('skipExifWithInternalWriter');
  sendSettings();
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
    send: order => {
      if (kind === 'pick') for (const listener of pickOrderListeners) listener();
      return invoke('set_metadata_read_order', { kind, order }).catch(error => console.error(`Ordre de lecture refusé (${kind})`, error));
    },
  })]));
  // Fields without priority (flat keywords): static rows below the table, with what each one can be written by.
  const flatElement = document.getElementById('metadata-order-flat');
  function renderFlat(kind) {
    const flat = READ_ORDERS[kind].flat;
    flatElement.hidden = !flat;
    if (!flat) return;
    const note = document.createElement('p');
    note.className = 'sort-note';
    note.textContent = t('Flat keywords help');
    const rows = flat.map(format => {
      const row = document.createElement('li');
      row.className = 'keyword-format-item keyword-format-static';
      row.append(...formatCells(format));
      if (format.note) {
        const noteElement = document.createElement('span');
        noteElement.className = 'format-note';
        noteElement.textContent = t(format.note);
        row.append(noteElement);
      }
      return row;
    });
    const list = document.createElement('ul');
    list.className = 'keyword-format-static-list';
    list.append(...rows);
    flatElement.replaceChildren(note, list);
  }
  let shownKind = localStorage.getItem(ORDER_KIND_STORAGE_KEY);
  if (!(shownKind in orderLists)) shownKind = 'keywords';
  kindSelect.value = shownKind;
  orderLists[shownKind].render();
  renderFlat(shownKind);
  kindSelect.addEventListener('change', () => {
    shownKind = kindSelect.value;
    localStorage.setItem(ORDER_KIND_STORAGE_KEY, shownKind);
    orderLists[shownKind].render();
    renderFlat(shownKind);
  });

  onLanguageChange(() => {
    renderStatus();
    orderLists[shownKind].render();
    renderFlat(shownKind);
  });
  renderStatus();
}
