// "Author and rights" section of the Info tab: the author of the active photo and, when unfolded, its copyright notice, credit, usage terms and the
// author's e-mail (see rights.rs and exif::Rights).
//
// - The section title (same style as "Metadata") carries the chevron; the whole row folds / unfolds the other fields (state kept in the `infoAuthorOpen`
//   key of defaults.jsonc). Those fields are shown only when filled (refreshInfoRows in main.js). The chevron is shown only when at least one of them is
//   filled: with nothing to unfold, the title is a plain heading.
// - The "Author" row is always shown, even when empty. It and the other fields are whole clickable rows, highlighted on hover like the title and the
//   description: a click opens the Description tab and puts the cursor in the matching field.
// - The author comes from the photo list (`author` field); the other fields, which are not in it, are asked from the database for the active photo only.
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
// Input of the Description tab edited by each row of this section (a click on the row puts the cursor there).
const EDIT_INPUT_IDS = {
  'exif-author': 'description-author',
  'exif-copyright': 'description-copyright',
  'exif-credit': 'description-credit',
  'exif-usage-terms': 'description-usage-terms',
  'exif-author-email': 'description-author-email',
};

let host = null; // { openDescription(), refreshRows() }, see initInfoAuthor
let list;
let titleRow;
let authorValue;
let token = 0; // a more recent database read makes the one in progress obsolete
let isOpen = false; // the rights fields are unfolded
let hasDetails = false; // at least one of the rights fields is filled for the active photo

// Folded / unfolded look of the section. Without anything to unfold, the title is a plain heading: no chevron, not a button.
function applyOpen() {
  if (!list || !titleRow) return; // section elements missing from index.html (see initInfoAuthor)
  list.classList.toggle('exif-author-collapsed', !isOpen);
  titleRow.classList.toggle('open', isOpen);
  titleRow.classList.toggle('no-details', !hasDetails);
  if (hasDetails) {
    titleRow.setAttribute('role', 'button');
    titleRow.tabIndex = 0;
    titleRow.setAttribute('aria-expanded', String(isOpen));
    titleRow.title = t(isOpen ? 'Hide the copyright and credit fields' : 'Show the copyright and credit fields');
  } else {
    titleRow.removeAttribute('role');
    titleRow.removeAttribute('aria-expanded');
    titleRow.removeAttribute('title');
    titleRow.tabIndex = -1;
  }
}

// Opens the Description tab and puts the cursor in the field matching the clicked row. The tab is filled a moment after it appears (the selection is
// read when it becomes visible), so the focus is tried again on the next frames, as focusSideTabField does (keywords-panel.js).
function openDescriptionAt(inputId) {
  host.openDescription();
  const field = document.getElementById(inputId);
  if (!field) return;
  const focus = () => {
    if (document.activeElement === field || field.disabled) return;
    field.focus();
    field.select?.();
    field.scrollIntoView({ block: 'nearest' }); // the tab scrolls when its fields do not all fit
  };
  focus();
  requestAnimationFrame(focus);
  setTimeout(focus, 150);
}

/**
 * Wires the section. `openDescription()`: opens the Description tab; `refreshRows()`: hides the empty rows of the Info tab (main.js).
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
  isOpen = readBool(OPEN_STORAGE_KEY);
  const setOpen = value => {
    isOpen = value;
    writeStored(OPEN_STORAGE_KEY, isOpen);
    applyOpen();
    host.refreshRows();
  };
  // The whole title row folds / unfolds, but only when there is something to unfold.
  titleRow.addEventListener('click', () => { if (hasDetails) setOpen(!isOpen); });
  titleRow.addEventListener('keydown', event => {
    if (hasDetails && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setOpen(!isOpen); }
  });

  // Whole rows lead to the tab where they are edited, with the cursor in the matching field (like the title and the description: `exif-editable`
  // class, row highlight).
  const makeEditable = (row, label, inputId) => {
    row.classList.add('exif-editable');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.title = label;
    row.addEventListener('click', () => openDescriptionAt(inputId));
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); openDescriptionAt(inputId); }
    });
  };
  const editLabel = () => t('Edit in the Description tab');
  const editableRows = Object.entries(EDIT_INPUT_IDS)
    .map(([valueId, inputId]) => [document.getElementById(valueId)?.closest('li'), inputId])
    .filter(([row]) => row);
  for (const [row, inputId] of editableRows) makeEditable(row, editLabel(), inputId);
  onLanguageChange(() => {
    for (const [row] of editableRows) row.title = editLabel();
    applyOpen();
  });
  applyOpen();
}

function setDetails(rights) {
  for (const [id, field] of DETAIL_FIELDS) {
    const element = document.getElementById(id);
    if (element) element.textContent = rights?.[field] || '-';
  }
  // The chevron (and the folding) only make sense when at least one field is filled.
  hasDetails = DETAIL_FIELDS.some(([, field]) => Boolean(rights?.[field]));
  applyOpen();
}

/** Shows the author and rights of the active photo (`photo`: element of the displayed list). */
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
