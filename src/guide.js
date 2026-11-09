// Guide des raccourcis (modale ouverte par la touche G, ou depuis les Paramètres) : rendu à partir d'une liste de groupes, avec recherche.
//
// Chaque ligne : la ou les touches à gauche, l'action à droite (texte court, détail éventuel en gris sur une seconde ligne, étiquette de contexte
// quand la même touche a un autre sens ailleurs). Les textes sont des clés de traduction (src/locales). Les mots des touches (Clic, Maj, Glisser…)
// sont traduits aussi ; les autres touches (Ctrl, A, F11, ←…) sont affichées telles quelles.

import { t, onLanguageChange, normalizeSearch } from './i18n.js';

// Mots de touche traduits (clé de traduction) ; toute autre touche s'affiche telle quelle.
const KEY_WORDS = new Set(['Click', 'Double-click', 'Right-click', 'Middle-click', 'Shift', 'Drag', 'Mouse wheel', 'Delete Key', 'Enter', 'Esc', 'A letter', 'Space Key']);

// `k` : alternatives de touches, chacune étant une combinaison (touches jointes par « + »). `sep` : séparateur entre alternatives
// (« ou » par défaut, 'slash' pour « / », 'space' pour une simple liste). `tag` : contexte où la ligne s'applique.
const GROUPS = [
  { title: 'Photos and selection', rows: [
    { a: 'Add a photo to the selection', k: [['Ctrl', 'Click']] },
    { a: 'Select from the last click', k: [['Shift', 'Click']] },
    { a: 'Select all / none', d: 'Not in compare mode', k: [['Ctrl', 'A']] },
    { a: 'Rate', d: '0 removes the rating', k: [['0 – 5']] },
    { a: 'Color label', d: 'Red, yellow, green, blue. Same key again: remove the color', k: [['6'], ['7'], ['8'], ['9']], sep: 'space' },
    { a: 'Pick or reject', d: 'Same key again: remove the flag. Enable it in Settings > Metadata', k: [['Shift', 'P'], ['Shift', 'X']], sep: 'space' },
    { a: 'Rate or color, then next photo', d: 'Fullscreen or a single selected photo', k: [['Alt', '0 – 9']] },
    { a: 'Delete', k: [['Delete Key']] },
    { a: 'Rename…', d: 'A single selected photo', k: [['F2']] },
    { a: 'Copy to…', k: [['C']] },
    { a: 'Copy to clipboard', k: [['Ctrl', 'C']] },
    { a: 'Resize…', k: [['S']] },
    { a: 'Turn right / left', d: 'Lossless: only the orientation tag changes (not for HEIC, HEIF and videos)', k: [['Ctrl', 'R'], ['Shift', 'R']], sep: 'slash' },
    { a: 'Undo the last rotation', k: [['Ctrl', 'Z']] },
    { a: 'Show in file explorer', k: [['E']] },
    { a: 'Open with the first program', d: 'Settings > Open with', k: [['O']] },
    { a: 'Information Sheet', k: [['I']] },
  ] },
  { title: 'Mouse', rows: [
    { a: 'Context menu', d: 'Info, delete, copy and more', k: [['Right-click']] },
    { a: 'Open in fullscreen', k: [['Double-click']] },
    { a: 'Move to a folder', k: [['Shift', 'Drag']] },
    { a: 'Copy to a folder', k: [['Ctrl', 'Drag']] },
    { a: 'Zoom around the cursor', tag: 'Fullscreen', k: [['Ctrl', 'Mouse wheel']] },
    { a: 'Open a filter group, keeping the others open', d: 'Without Shift, a click opens the group and closes the others', tag: 'Filters', k: [['Shift', 'Click']] },
  ] },
  { title: 'Filters', rows: [
    { a: 'Go to the keyword filter', d: 'Opens the library panel and the Keywords / Name group', tag: 'Filters', k: [['Shift', 'K']] },
    { a: 'Exclude the chosen value instead of including it', d: 'Keywords, people, camera, lens, format: in the suggestion list. File name: Alt+Enter', tag: 'Filters', k: [['Alt', 'Enter'], ['Alt', 'Click']] },
    { a: 'Include / exclude a filter chip', d: 'An excluded chip starts with "-" and has faded colors', tag: 'Filters', k: [['Right-click']] },
    { a: 'Remove a filter chip', d: 'Open group or folded line', tag: 'Filters', k: [['Middle-click']] },
    { a: 'Filter on a keyword of the photo', d: 'Ctrl+click: add it to the filter; Alt+click: exclude it', tag: 'Info panel', k: [['Click'], ['Ctrl', 'Click'], ['Alt', 'Click']], sep: 'slash' },
  ] },
  { title: 'Preview and comparison', rows: [
    { a: 'Previous / next photo', tag: 'Preview and fullscreen', k: [['←'], ['→']], sep: 'slash' },
    { a: 'Zoom in / out', k: [['+'], ['-']], sep: 'slash' },
    { a: 'Actual size / fit', k: [['*']] },
    { a: 'Toggle compare mode', k: [['X']] },
    { a: 'Compare: select a photo', d: 'To rate, color or delete it', k: [['Click']] },
    { a: 'Compare: select all photos', d: 'Press again to clear', k: [['A']] },
  ] },
  { title: 'Panels (show / hide)', rows: [
    { a: 'Library panel', k: [['N']] },
    { a: 'Preview', k: [['P']] },
    { a: 'Info panel', k: [['J']] },
    { a: 'Keywords panel', k: [['K']] },
    { a: 'Description panel', tag: 'Normal view', k: [['D']] },
    { a: 'Toolbar', k: [['T']] },
  ] },
  { title: 'Metadata', rows: [
    { a: 'Type a keyword for the selection', d: 'Opens the Keywords tab and its input', k: [['Alt', 'K']] },
    { a: 'Edit the title of the selection', d: 'Opens the Description tab, cursor in the title', k: [['Alt', 'D']] },
    { a: 'Keywords: all or assigned to the selection', k: [['Ctrl', 'K']] },
    { a: 'Write the pending changes to the files', d: 'Keywords, title and description', k: [['Ctrl', 'Enter']] },
  ] },
  { title: 'Fullscreen', rows: [
    { a: 'Enter / leave fullscreen', k: [['F']] },
    { a: 'Photo information', tag: 'Fullscreen', k: [['D']] },
    { a: 'Rating bar', tag: 'Fullscreen', k: [['R']] },
    { a: 'Start or stop the slideshow', d: 'Fullscreen or grid; on the selection if it holds several photos', k: [['F10']] },
    { a: 'Pause / resume the slideshow', tag: 'Fullscreen', k: [['Space Key']] },
  ] },
  { title: 'Faces', rows: [
    { a: 'Face regions: hover, always, hidden', d: 'Preview and fullscreen', k: [['V']] },
    { a: 'Draw a face region', d: 'Right-click a region to name or delete it', tag: 'Fullscreen', k: [['Shift', 'Drag']] },
    { a: 'Add a face region', d: 'Then draw it with the mouse, without holding Shift', tag: 'Preview and fullscreen', k: [['Alt', 'V']] },
    { a: 'Confirm the selected faces', tag: 'Faces view', k: [['Enter']] },
    { a: 'Name the selected faces', d: 'Type the first letter of the name', tag: 'Faces view', k: [['A letter']] },
    { a: 'Set the selected faces as unknown', tag: 'Faces view', k: [['-']] },
    { a: 'Ignore the selected faces', tag: 'Faces view', k: [['/']] },
    { a: 'Mark the selected faces as not faces', tag: 'Faces view', k: [['Delete Key']] },
    { a: 'Select all faces', tag: 'Faces view', k: [['Ctrl', 'A']] },
    { a: 'Clear the face selection', tag: 'Faces view', k: [['Esc']] },
    { a: 'Previous / next face', tag: 'Faces view', k: [['←'], ['→']], sep: 'slash' },
    { a: 'Previous / next row', tag: 'Faces view', k: [['↑'], ['↓']], sep: 'slash' },
    { a: 'Undo the last review action', tag: 'Faces view', k: [['Ctrl', 'Z']] },
    { a: 'Show only one status', d: 'Click a status button (To confirm, Auto…) while holding Shift: the others are hidden', tag: 'Faces view', k: [['Shift', 'Click']] },
    { a: 'Write the faces to the files', tag: 'Faces view', k: [['Ctrl', 'Enter']] },
  ] },
  { title: 'Window', rows: [
    { a: 'Close fullscreen or the open window', k: [['Esc']] },
    { a: 'Immersive mode', d: 'Hides the title bar and the taskbar', k: [['F11']] },
    { a: 'Shortcuts guide', k: [['G']] },
    { a: 'Histogram: off, displayed, with clippings', k: [['H']] },
  ] },
];

const keyLabel = key => (KEY_WORDS.has(key) ? t(key) : key);

// Une alternative de touches : « Ctrl + Clic ».
function renderCombo(combo) {
  const fragment = document.createDocumentFragment();
  combo.forEach((key, index) => {
    if (index > 0) fragment.append(' + ');
    const cap = document.createElement('kbd');
    cap.textContent = keyLabel(key);
    fragment.append(cap);
  });
  return fragment;
}

function renderKeys(row) {
  const control = document.createElement('span');
  control.className = 'guide-control';
  row.k.forEach((combo, index) => {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = 'guide-separator';
      separator.textContent = row.sep === 'slash' ? '/' : row.sep === 'space' ? '' : t('or');
      control.append(separator);
    }
    control.append(renderCombo(combo));
  });
  return control;
}

function renderRow(row) {
  const element = document.createElement('div');
  element.className = 'guide-row';
  const action = document.createElement('span');
  action.className = 'guide-action';
  const label = document.createElement('span');
  label.className = 'guide-label';
  label.textContent = t(row.a);
  if (row.tag) {
    const tag = document.createElement('span');
    tag.className = 'guide-tag';
    tag.textContent = t(row.tag);
    label.append(' ', tag);
  }
  action.append(label);
  if (row.d) {
    const detail = document.createElement('span');
    detail.className = 'guide-detail';
    detail.textContent = t(row.d);
    action.append(detail);
  }
  element.append(renderKeys(row), action);
  // Texte cherché : action, détail, contexte et touches, sans accents ni majuscules.
  element.dataset.search = normalizeSearch([t(row.a), row.d ? t(row.d) : '', row.tag ? t(row.tag) : '', ...row.k.flat().map(keyLabel)].join(' '));
  return element;
}

function render(container) {
  container.replaceChildren(...GROUPS.map(group => {
    const section = document.createElement('div');
    section.className = 'guide-section';
    const title = document.createElement('h4');
    title.className = 'guide-section-title';
    title.textContent = t(group.title);
    section.dataset.search = normalizeSearch(t(group.title));
    section.append(title, ...group.rows.map(renderRow));
    return section;
  }));
}

// Recherche : une ligne reste affichée si tous les mots saisis figurent dans son texte (ou dans le titre de son groupe) ; un groupe sans ligne
// affichée est masqué.
function applyFilter(container, query, emptyMessage) {
  const words = normalizeSearch(query).split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const section of container.querySelectorAll('.guide-section')) {
    let sectionShown = 0;
    for (const row of section.querySelectorAll('.guide-row')) {
      const text = `${row.dataset.search} ${section.dataset.search}`;
      const match = words.every(word => text.includes(word));
      row.hidden = !match;
      if (match) sectionShown += 1;
    }
    section.hidden = sectionShown === 0;
    shown += sectionShown;
  }
  emptyMessage.hidden = shown > 0;
}

export function initGuide() {
  const container = document.getElementById('guide-groups');
  const search = document.getElementById('guide-search');
  const emptyMessage = document.getElementById('guide-empty');
  if (![container, search, emptyMessage].every(Boolean)) {
    console.error('Guide : éléments introuvables dans index.html');
    return;
  }
  const refresh = () => {
    render(container);
    applyFilter(container, search.value, emptyMessage);
  };
  search.addEventListener('input', () => applyFilter(container, search.value, emptyMessage));
  onLanguageChange(refresh);
  refresh();
}
