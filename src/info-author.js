// Section « Photographe » de l'onglet Info : l'auteur de la photo active et, en dépliant, sa mention de copyright, son crédit, ses conditions d'utilisation et
// l'e-mail de l'auteur (voir rights.rs et exif::Rights).
//
// - Le titre de section « Photographe » (même style que « Metadata ») porte le chevron ; toute sa ligne plie / déplie les autres champs (état mémorisé :
//   clé `infoAuthorOpen` de defaults.jsonc). Ces champs ne sont affichés que s'ils sont remplis (refreshInfoRows de main.js).
// - La ligne « Auteur » reste toujours affichée, même vide. Elle et les autres champs sont des lignes entières cliquables, surlignées au survol comme le titre
//   et la description : un clic ouvre l'onglet Description pour les modifier.
// - L'auteur vient de la liste des photos (champ `author`) ; les autres champs, qui n'y figurent pas, sont demandés à la base pour la seule photo active.
import './author-rights.css';
import { invoke } from '@tauri-apps/api/core';
import { t, onLanguageChange } from './i18n.js';
import { readBool, writeStored } from './settings-defaults.js';

const OPEN_STORAGE_KEY = 'infoAuthorOpen';
const DETAIL_FIELDS = [
  ['exif-copyright', 'copyright'],
  ['exif-credit', 'credit'],
  ['exif-usage-terms', 'usage_terms'],
  ['exif-author-email', 'author_email'],
];

let host = null; // { openDescription(), refreshRows() }, voir initInfoAuthor
let list;
let titleRow;
let authorValue;
let token = 0; // une lecture de la base plus récente rend caduque celle qui est en cours

function applyOpen(open) {
  list.classList.toggle('exif-author-collapsed', !open);
  titleRow.setAttribute('aria-expanded', String(open));
  titleRow.title = t(open ? 'Hide the copyright and credit fields' : 'Show the copyright and credit fields');
  titleRow.classList.toggle('open', open);
}

/**
 * Branche la section. `openDescription()` : ouvre l'onglet Description ; `refreshRows()` : masque les lignes vides de l'onglet Info (main.js).
 */
export function initInfoAuthor({ openDescription, refreshRows }) {
  host = { openDescription, refreshRows };
  list = document.getElementById('exif-data');
  titleRow = document.getElementById('exif-author-title');
  authorValue = document.getElementById('exif-author');
  if (![list, titleRow, authorValue].every(Boolean)) {
    console.error('Section Photographe : éléments introuvables dans index.html');
    return;
  }
  let open = readBool(OPEN_STORAGE_KEY);
  const setOpen = value => {
    open = value;
    writeStored(OPEN_STORAGE_KEY, open);
    applyOpen(open);
    host.refreshRows();
  };
  // Toute la ligne du titre plie / déplie.
  titleRow.addEventListener('click', () => setOpen(!open));
  titleRow.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(!open); }
  });

  // Les lignes entières mènent à l'onglet où on les modifie (comme le titre et la description : classe `exif-editable`, surlignage de la ligne).
  const makeEditable = (row, label) => {
    row.classList.add('exif-editable');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.title = label;
    row.addEventListener('click', () => host.openDescription());
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); host.openDescription(); }
    });
  };
  const editLabel = () => t('Edit in the Description tab');
  const editableRows = [authorValue, ...DETAIL_FIELDS.map(([id]) => document.getElementById(id))].map(element => element?.closest('li')).filter(Boolean);
  for (const row of editableRows) makeEditable(row, editLabel());
  onLanguageChange(() => {
    for (const row of editableRows) row.title = editLabel();
    applyOpen(open);
  });
  applyOpen(open);
}

function setDetails(rights) {
  for (const [id, field] of DETAIL_FIELDS) {
    const element = document.getElementById(id);
    if (element) element.textContent = rights?.[field] || '-';
  }
}

/** Affiche l'auteur et les droits de la photo active (`photo` : élément de la liste affichée). */
export function renderInfoAuthor(photo) {
  if (!host || !authorValue) return;
  const current = ++token;
  authorValue.textContent = photo?.author || '-';
  setDetails(null);
  host.refreshRows();
  if (!photo || !Number.isFinite(photo.id) || photo.id <= 0) return;
  invoke('get_photo_rights', { photoIds: [photo.id] })
    .then(rows => {
      if (current !== token) return;
      const rights = rows.find(row => row.photo_id === photo.id);
      if (!rights) return;
      authorValue.textContent = rights.author || '-';
      setDetails(rights);
      host.refreshRows();
    })
    .catch(error => console.error("Lecture de l'auteur et des droits impossible", error));
}
