// Section « Auteur » de l'onglet Info : l'auteur de la photo active et, en dépliant, sa mention de copyright, son crédit, ses conditions d'utilisation et
// l'e-mail de l'auteur (voir rights.rs et exif::Rights).
//
// - La ligne « Auteur » et sa valeur restent toujours affichées, même vide. Un clic sur le nom du champ ou sur le chevron plie / déplie les autres
//   champs (état mémorisé : clé `infoAuthorOpen` de defaults.jsonc) ; ces champs ne sont affichés que s'ils sont remplis (refreshInfoRows de main.js).
// - Un clic sur la valeur de l'auteur, ou sur un des autres champs, ouvre l'onglet Description pour les modifier.
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
let toggleButton;
let chevronButton;
let authorValue;
let token = 0; // une lecture de la base plus récente rend caduque celle qui est en cours

function applyOpen(open) {
  list.classList.toggle('exif-author-collapsed', !open);
  for (const button of [toggleButton, chevronButton]) button.setAttribute('aria-expanded', String(open));
  chevronButton.title = t(open ? 'Hide the copyright and credit fields' : 'Show the copyright and credit fields');
  chevronButton.classList.toggle('open', open);
}

/**
 * Branche la section. `openDescription()` : ouvre l'onglet Description ; `refreshRows()` : masque les lignes vides de l'onglet Info (main.js).
 */
export function initInfoAuthor({ openDescription, refreshRows }) {
  host = { openDescription, refreshRows };
  list = document.getElementById('exif-data');
  toggleButton = document.getElementById('exif-author-toggle');
  chevronButton = document.getElementById('exif-author-chevron');
  authorValue = document.getElementById('exif-author');
  if (![list, toggleButton, chevronButton, authorValue].every(Boolean)) {
    console.error('Section Auteur : éléments introuvables dans index.html');
    return;
  }
  let open = readBool(OPEN_STORAGE_KEY);
  const setOpen = value => {
    open = value;
    writeStored(OPEN_STORAGE_KEY, open);
    applyOpen(open);
    host.refreshRows();
  };
  toggleButton.addEventListener('click', () => setOpen(!open));
  chevronButton.addEventListener('click', () => setOpen(!open));

  // Les valeurs mènent à l'onglet où on les modifie (comme le titre et la description).
  const makeEditable = (element, label) => {
    element.classList.add('exif-editable');
    element.tabIndex = 0;
    element.setAttribute('role', 'button');
    element.title = label;
    element.addEventListener('click', () => host.openDescription());
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); host.openDescription(); }
    });
  };
  const editLabel = () => t('Edit in the Description tab');
  makeEditable(authorValue, editLabel());
  const detailRows = DETAIL_FIELDS.map(([id]) => document.getElementById(id)?.closest('li')).filter(Boolean);
  for (const row of detailRows) makeEditable(row, editLabel());
  onLanguageChange(() => {
    authorValue.title = editLabel();
    for (const row of detailRows) row.title = editLabel();
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
