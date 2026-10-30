// Guide des raccourcis (modale ouverte par la touche H, ou depuis les Paramètres) : rendu à partir d'une liste de groupes, avec recherche.
//
// Chaque ligne : la ou les touches à gauche, l'action à droite (texte court, détail éventuel en gris sur une seconde ligne, étiquette de contexte
// quand la même touche a un autre sens ailleurs). Les textes sont des clés de traduction (src/locales). Les mots des touches (Clic, Maj, Glisser…)
// sont traduits aussi ; les autres touches (Ctrl, A, F11, ←…) sont affichées telles quelles.

import { t, onLanguageChange } from './i18n.js';

// Mots de touche traduits (clé de traduction) ; toute autre touche s'affiche telle quelle.
const KEY_WORDS = new Set(['Click', 'Double-click', 'Right-click', 'Shift', 'Drag', 'Mouse wheel', 'Delete Key', 'Enter', 'Esc', 'A letter']);

// `k` : alternatives de touches, chacune étant une combinaison (touches jointes par « + »). `sep` : séparateur entre alternatives
// (« ou » par défaut, 'slash' pour « / », 'space' pour une simple liste). `tag` : contexte où la ligne s'applique.
const GROUPS = [
  { title: 'Photos and selection', rows: [
    { a: 'Add a photo to the selection', k: [['Ctrl', 'Click']] },
    { a: 'Select from the last click', k: [['Shift', 'Click']] },
    { a: 'Select all / none', d: 'Not in compare mode', k: [['Ctrl', 'A']] },
    { a: 'Rate', d: '0 removes the rating', k: [['0 – 5']] },
    { a: 'Color label', d: 'Red, yellow, green, blue. Same key again: remove the color', k: [['6'], ['7'], ['8'], ['9']], sep: 'space' },
    { a: 'Delete', k: [['Delete Key']] },
    { a: 'Copy to…', k: [['C']] },
    { a: 'Copy to clipboard', k: [['Ctrl', 'C']] },
    { a: 'Resize…', k: [['S']] },
    { a: 'Show in file explorer', k: [['E']] },
    { a: 'Information Sheet', k: [['I']] },
  ] },
  { title: 'Mouse', rows: [
    { a: 'Context menu', d: 'Info, delete, copy and more', k: [['Right-click']] },
    { a: 'Open in fullscreen', k: [['Double-click']] },
    { a: 'Move to a folder', k: [['Shift', 'Drag']] },
    { a: 'Copy to a folder', k: [['Ctrl', 'Drag']] },
    { a: 'Zoom around the cursor', tag: 'Fullscreen', k: [['Ctrl', 'Mouse wheel']] },
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
    { a: 'Filters panel', k: [['N']] },
    { a: 'Preview', k: [['P']] },
    { a: 'Info panel', k: [['J']] },
    { a: 'Keywords panel', k: [['K']] },
    { a: 'Description panel', tag: 'Normal view', k: [['D']] },
    { a: 'Toolbar', k: [['T']] },
  ] },
  { title: 'Metadata', rows: [
    { a: 'Keywords: all or assigned to the selection', k: [['Ctrl', 'K']] },
    { a: 'Write the pending changes to the files', d: 'Keywords, title and description', k: [['Ctrl', 'Enter']] },
  ] },
  { title: 'Fullscreen', rows: [
    { a: 'Enter / leave fullscreen', k: [['F']] },
    { a: 'Photo information', tag: 'Fullscreen', k: [['D']] },
    { a: 'Rating bar', tag: 'Fullscreen', k: [['R']] },
  ] },
  { title: 'Faces', rows: [
    { a: 'Face regions: hover, always, hidden', d: 'Preview and fullscreen', k: [['V']] },
    { a: 'Draw a face region', d: 'Right-click a region to name or delete it', tag: 'Fullscreen', k: [['Shift', 'Drag']] },
    { a: 'Confirm the selected faces', tag: 'Faces view', k: [['Enter']] },
    { a: 'Name the selected faces', d: 'Type the first letter of the name', tag: 'Faces view', k: [['A letter']] },
    { a: 'Select all faces', tag: 'Faces view', k: [['Ctrl', 'A']] },
    { a: 'Clear the face selection', tag: 'Faces view', k: [['Esc']] },
    { a: 'Write the faces to the files', tag: 'Faces view', k: [['Ctrl', 'Enter']] },
  ] },
  { title: 'Window', rows: [
    { a: 'Close fullscreen or the open window', k: [['Esc']] },
    { a: 'Immersive mode', d: 'Hides the title bar and the taskbar', k: [['F11']] },
    { a: 'Shortcuts guide', k: [['H']] },
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
  element.dataset.search = normalize([t(row.a), row.d ? t(row.d) : '', row.tag ? t(row.tag) : '', ...row.k.flat().map(keyLabel)].join(' '));
  return element;
}

const normalize = text => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function render(container) {
  container.replaceChildren(...GROUPS.map(group => {
    const section = document.createElement('div');
    section.className = 'guide-section';
    const title = document.createElement('h4');
    title.className = 'guide-section-title';
    title.textContent = t(group.title);
    section.dataset.search = normalize(t(group.title));
    section.append(title, ...group.rows.map(renderRow));
    return section;
  }));
}

// Recherche : une ligne reste affichée si tous les mots saisis figurent dans son texte (ou dans le titre de son groupe) ; un groupe sans ligne
// affichée est masqué.
function applyFilter(container, query, emptyMessage) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
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
