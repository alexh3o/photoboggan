import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { t, tp, onLanguageChange } from './i18n.js';
import { getIsFullscreen } from './main.js';

// Actions sur les photos : menu contextuel des miniatures (remplace le menu du navigateur), fenêtre d'informations,
// suppression, copie des originaux et « Ouvrir avec ». main.js donne accès à l'état de la grille via initPhotoActions().

const PROGRAMS_STORAGE_KEY = 'openWithPrograms';
const LAST_COPY_FOLDER_KEY = 'lastCopyFolder';
let api = null;
let contextMenu = null;

const baseName = path => path.split(/[\\/]/).filter(Boolean).pop() || path;
const photoName = photo => photo.filename || baseName(photo.path);
const defaultProgramName = path => baseName(path).replace(/\.[^.\\/]+$/, '');

// ==========================================
// PROGRAMMES « OUVRIR AVEC » (liste dans les Paramètres, mémorisée localement)
// ==========================================
function loadPrograms() {
  try {
    const stored = JSON.parse(localStorage.getItem(PROGRAMS_STORAGE_KEY) || '[]');
    if (!Array.isArray(stored)) return [];
    return stored
      .filter(program => program && typeof program.path === 'string' && program.path)
      .map(program => ({ name: String(program.name || '').trim() || defaultProgramName(program.path), path: program.path }));
  } catch {
    return [];
  }
}

function savePrograms(programs) {
  localStorage.setItem(PROGRAMS_STORAGE_KEY, JSON.stringify(programs));
}

// Boîte de dialogue de l'OS pour choisir un programme ; null si l'utilisateur annule.
async function pickProgram() {
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      title: t('Choose a program'),
      filters: [{ name: t('Programs'), extensions: ['exe', 'bat', 'cmd', 'com'] }],
    });
    return typeof selected === 'string' && selected ? selected : null;
  } catch (error) {
    console.error('Sélection de programme impossible', error);
    return null;
  }
}

function renderProgramList() {
  const list = document.getElementById('settings-program-list');
  if (!list) return;
  const programs = loadPrograms();
  if (!programs.length) {
    const empty = document.createElement('li');
    empty.className = 'settings-program-empty';
    empty.textContent = t('No program configured');
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...programs.map(program => {
    const item = document.createElement('li');
    item.className = 'settings-program-item';
    const details = document.createElement('div');
    details.className = 'settings-program-details';
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'settings-program-name';
    name.value = program.name;
    name.setAttribute('aria-label', t('Program name'));
    name.addEventListener('change', () => {
      const nextName = name.value.trim() || defaultProgramName(program.path);
      savePrograms(loadPrograms().map(candidate => candidate.path === program.path ? { ...candidate, name: nextName } : candidate));
      name.value = nextName;
    });
    name.addEventListener('keydown', event => { if (event.key === 'Enter') name.blur(); });
    const path = document.createElement('span');
    path.className = 'settings-program-path';
    path.textContent = program.path;
    path.title = program.path;
    details.append(name, path);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-delete-folder';
    remove.textContent = t('Delete');
    remove.addEventListener('click', () => {
      savePrograms(loadPrograms().filter(candidate => candidate.path !== program.path));
      renderProgramList();
    });
    item.append(details, remove);
    return item;
  }));
}

async function addProgramFromDialog() {
  const path = await pickProgram();
  if (!path) return;
  const programs = loadPrograms();
  const existing = programs.findIndex(program => program.path.toLowerCase() === path.toLowerCase());
  if (existing >= 0) {
    // Déjà dans la liste : on place simplement le curseur sur son nom.
    document.querySelectorAll('.settings-program-name')[existing]?.focus();
    return;
  }
  programs.push({ name: defaultProgramName(path), path });
  savePrograms(programs);
  renderProgramList();
}

// ==========================================
// FENÊTRES (informations, confirmation)
// ==========================================
// Fenêtre modale réutilisant les styles des Paramètres. Échap, clic sur le fond et × la ferment ;
// les touches ne remontent pas à main.js (pas de navigation ou de notation involontaire derrière la fenêtre).
// `focusSelector` : éléments parcourus par Tab (les boutons seulement par défaut ; les formulaires y ajoutent champs et listes).
function createModal({ title, cardClass = '', onClose = null, focusSelector = 'button:not([disabled])' }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.tabIndex = -1;
  const card = document.createElement('div');
  card.className = `modal-card ${cardClass}`.trim();
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', title);
  const header = document.createElement('div');
  header.className = 'modal-header';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'close-x';
  closeButton.title = t('Close');
  closeButton.setAttribute('aria-label', t('Close'));
  closeButton.textContent = '×';
  header.append(heading, closeButton);
  const body = document.createElement('div');
  body.className = 'modal-body';
  card.append(header, body);
  overlay.append(card);
  document.body.append(overlay);

  const close = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    onClose?.();
  };
  closeButton.addEventListener('click', close);
  let pressedOnBackdrop = false;
  overlay.addEventListener('pointerdown', event => { pressedOnBackdrop = event.target === overlay; });
  overlay.addEventListener('click', event => { if (pressedOnBackdrop && event.target === overlay) close(); });
  overlay.addEventListener('keydown', event => {
    event.stopPropagation();
    // Une touche maintenue (ex. Entrée qui a ouvert la fenêtre) ne doit pas activer un bouton par répétition.
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const focusables = [...card.querySelectorAll(focusSelector)].filter(element => !element.closest('[hidden]'));
      if (!focusables.length) return;
      const index = focusables.indexOf(document.activeElement);
      const next = event.shiftKey ? (index <= 0 ? focusables.length - 1 : index - 1) : (index === focusables.length - 1 ? 0 : index + 1);
      focusables[next].focus();
    }
  });
  overlay.focus();
  return { overlay, card, body, close };
}

// Confirmation Oui / Non
// le focus est sur « Oui » (rouge) et les flèches du clavier passent de l'un à l'autre.
// Renvoie true uniquement si « Oui » est activé.
export function confirmDialog({ title, message, confirmLabel, cancelLabel }) {
  return new Promise(resolve => {
    let answer = false;
    const modal = createModal({ title, cardClass: 'confirm-card', onClose: () => resolve(answer) });
    const text = document.createElement('p');
    text.className = 'confirm-message';
    text.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = cancelLabel;
    cancel.addEventListener('click', modal.close);
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn-danger';
    confirm.textContent = confirmLabel;
    confirm.addEventListener('click', () => {
      answer = true;
      modal.close();
    });
    actions.append(cancel, confirm);
    modal.body.append(text, actions);
    // Flèches : le choix suit la position des boutons (gauche / haut = « Non », droite / bas = « Oui »). Entrée valide le bouton ayant le focus.
    modal.overlay.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? cancel : confirm).focus();
    });
    confirm.focus();
  });
}

// Saisie d'un texte (nom de dossier…). `onSubmit(valeur)` renvoie un message d'erreur (la fenêtre reste ouverte et l'affiche) ou null (succès, la fenêtre
// se ferme). Entrée valide, Échap annule. Renvoie true si la saisie a été validée avec succès.
function promptDialog({ title, message, inputLabel, confirmLabel, cancelLabel, onSubmit }) {
  return new Promise(resolve => {
    let done = false;
    const modal = createModal({ title, cardClass: 'confirm-card', onClose: () => resolve(done) });
    const text = document.createElement('p');
    text.className = 'confirm-message';
    text.textContent = message;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'prompt-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', inputLabel);
    const error = document.createElement('p');
    error.className = 'prompt-error';
    error.setAttribute('role', 'alert');
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = cancelLabel;
    cancel.addEventListener('click', modal.close);
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn-primary';
    confirm.textContent = confirmLabel;
    let busy = false;
    const submit = async () => {
      if (busy) return;
      busy = true;
      confirm.disabled = true;
      const problem = await onSubmit(input.value);
      busy = false;
      confirm.disabled = false;
      if (problem) {
        error.textContent = problem;
        input.focus();
        input.select();
        return;
      }
      done = true;
      modal.close();
    };
    confirm.addEventListener('click', submit);
    input.addEventListener('input', () => { error.textContent = ''; });
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submit();
    });
    actions.append(cancel, confirm);
    modal.body.append(text, input, error, actions);
    input.focus();
  });
}

// ==========================================
// INFOS (EXIF / XMP / IPTC)
// ==========================================
const FILE_LABELS = { path: 'Path', size: 'Filesize', dimensions: 'Dimensions' };

function renderMetadataSections(details) {
  const sections = [
    { title: t('File'), entries: details.file.map(entry => ({ key: t(FILE_LABELS[entry.key] ?? entry.key), value: entry.value })) },
    { title: 'EXIF', entries: details.exif },
    { title: 'XMP', entries: details.xmp },
    { title: 'IPTC', entries: details.iptc },
  ];
  return sections.map(({ title, entries }) => {
    const section = document.createElement('section');
    section.className = 'info-section';
    const heading = document.createElement('h4');
    heading.textContent = title;
    section.append(heading);
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'info-empty';
      empty.textContent = t('No data');
      section.append(empty);
      return section;
    }
    const table = document.createElement('table');
    table.className = 'info-table';
    for (const { key, value } of entries) {
      const row = table.insertRow();
      row.insertCell().textContent = key;
      row.insertCell().textContent = value;
    }
    section.append(table);
    return section;
  });
}

export async function showPhotoInfo(photo) {
  const modal = createModal({ title: `${t('Photo info')} · ${photoName(photo)}`, cardClass: 'info-card' });
  modal.body.classList.add('info-body');
  modal.body.tabIndex = -1;
  modal.body.textContent = t('Loading…');
  try {
    const details = await invoke('get_photo_details', { path: photo.path });
    if (!modal.overlay.isConnected) return;
    modal.body.replaceChildren(...renderMetadataSections(details));
    modal.body.focus();
  } catch (error) {
    if (modal.overlay.isConnected) modal.body.textContent = t('Unable to read metadata: {error}', { error });
  }
}

// ==========================================
// SUPPRIMER, COPIER VERS, OUVRIR AVEC
// ==========================================
export async function confirmAndDelete(targets) {
  const count = targets.length;
  const confirmed = await confirmDialog({
    title: t('Confirm deletion'),
    message: tp('Move {name} to the trash?', count, { name: photoName(targets[0]) }),
    confirmLabel: t('Yes'),
    cancelLabel: t('No'),
  });
  if (!confirmed) return;
  api.showToast(tp('Moving {count} file to the trash…', count), true);
  try {
    const result = await invoke('delete_photos', { paths: targets.map(photo => photo.path) });
    if (result.deleted.length) api.removePhotos(result.deleted);
    const failures = result.failed.length;
    if (failures) console.error('Suppression : échecs', result.failed);
    api.showToast(failures && !result.deleted.length
      ? t('Delete failed: {error}', { error: result.failed[0].error })
      : `${tp('{count} file moved to the trash', result.deleted.length)}${failures ? ` · ${tp('{count} failure', failures)}` : ''}`);
  } catch (error) {
    api.showToast(t('Delete failed: {error}', { error }));
  }
}

// Copie des fichiers originaux (pas des miniatures) vers un dossier choisi dans la boîte de dialogue de l'OS.
export async function copyPhotosTo(targets) {
  let destination = null;
  try {
    destination = await open({
      directory: true,
      multiple: false,
      title: t('Choose the destination folder'),
      defaultPath: localStorage.getItem(LAST_COPY_FOLDER_KEY) || undefined,
    });
  } catch (error) {
    console.error('Sélection de dossier impossible', error);
    return;
  }
  if (typeof destination !== 'string' || !destination) return;
  localStorage.setItem(LAST_COPY_FOLDER_KEY, destination);
  api.showToast(tp('Copying {count} file…', targets.length), true);
  try {
    const result = await invoke('copy_photos', { paths: targets.map(photo => photo.path), destination });
    const failures = result.failed.length;
    if (failures) console.error('Copie : échecs', result.failed);
    api.showToast(failures && !result.copied
      ? t('Copy failed: {error}', { error: result.failed[0].error })
      : `${tp('{count} file copied', result.copied)}${failures ? ` · ${tp('{count} failure', failures)}` : ''}`);
  } catch (error) {
    api.showToast(t('Copy failed: {error}', { error }));
  }
}

// Place les fichiers originaux dans le presse-papiers de l'OS, comme « Copier » dans l'Explorateur : ils se collent ensuite
// dans l'Explorateur, un client mail, une messagerie… (le backend s'occupe du format du presse-papiers).
export async function copyPhotosToClipboard(targets) {
  if (!targets.length) return;
  try {
    const copied = await invoke('copy_files_to_clipboard', { paths: targets.map(photo => photo.path) });
    api.showToast(tp('{count} file copied to the clipboard', copied));
  } catch (error) {
    api.showToast(t('Copy failed: {error}', { error }));
  }
}

// ==========================================
// REDIMENSIONNER PAR LOT
// ==========================================
// Une fenêtre d'options, puis le lot est traité photo par photo (commande `resize_photo`, quelques appels en parallèle). Quand le fichier de
// destination existe déjà, une question est posée (une à la fois) avec la possibilité d'appliquer le choix aux fichiers suivants.
const RESIZE_SETTINGS_KEY = 'resizeSettings';
const LAST_RESIZE_FOLDER_KEY = 'lastResizeFolder';
const RESIZE_SIDE_LIMITS = { min: 16, max: 30000 };
const FORM_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled])';
const FORBIDDEN_SUFFIX_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f]/;
let resizeRunning = false;

const makeElement = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const makeInput = (type, properties = {}) => Object.assign(makeElement('input'), { type, ...properties });
const optionRow = (...children) => {
  const row = makeElement('div', 'resize-option');
  row.append(...children);
  return row;
};
const labelled = (input, text) => {
  const label = makeElement('label');
  label.append(input, makeElement('span', '', text));
  return label;
};

// Dernières valeurs choisies (valeurs par défaut de la fenêtre) ; le dossier de destination n'en fait pas partie : par défaut, c'est le dossier de chaque photo.
function loadResizeSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(RESIZE_SETTINGS_KEY) || '{}') || {};
  } catch {
    stored = {};
  }
  const integer = (value, min, max, fallback) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  return {
    mode: stored.mode === 'percent' ? 'percent' : 'max_side',
    maxSide: integer(stored.maxSide, RESIZE_SIDE_LIMITS.min, RESIZE_SIDE_LIMITS.max, 1920),
    percent: integer(stored.percent, 1, 100, 50),
    format: stored.format === 'png' ? 'png' : 'jpeg',
    jpegQuality: integer(stored.jpegQuality, 1, 100, 85),
    pngCompression: ['fast', 'balanced', 'best'].includes(stored.pngCompression) ? stored.pngCompression : 'balanced',
    keepMetadata: stored.keepMetadata !== false,
    suffix: typeof stored.suffix === 'string' ? stored.suffix : '_s',
  };
}

// Fenêtre d'options. Renvoie les options à envoyer au backend (sans la politique de conflit) ou null si l'utilisateur annule.
function resizeOptionsDialog(count, firstPhotoPath) {
  return new Promise(resolve => {
    const saved = loadResizeSettings();
    let destination = null; // null = dossier d'origine de chaque photo
    let keepMetadata = saved.keepMetadata;
    let result = null;
    const modal = createModal({
      title: `${t('Resize')} · ${tp('{count} photo selected', count)}`,
      cardClass: 'resize-card',
      focusSelector: FORM_FOCUSABLE,
      onClose: () => resolve(result),
    });

    // Taille
    const maxSideRadio = makeInput('radio', { name: 'resize-mode', value: 'max_side', checked: saved.mode === 'max_side' });
    const maxSideInput = makeInput('number', { min: RESIZE_SIDE_LIMITS.min, max: RESIZE_SIDE_LIMITS.max, step: 1, value: saved.maxSide });
    maxSideInput.className = 'resize-field resize-number';
    const percentRadio = makeInput('radio', { name: 'resize-mode', value: 'percent', checked: saved.mode === 'percent' });
    const percentRange = makeInput('range', { min: 1, max: 100, step: 1, value: saved.percent });
    const percentValue = makeElement('span', 'resize-value');
    const sizeSection = makeElement('section', 'settings-section');
    sizeSection.append(
      makeElement('h4', '', t('Size')),
      optionRow(labelled(maxSideRadio, t('Longest side (max.)')), maxSideInput, makeElement('span', 'resize-unit', 'px')),
      optionRow(labelled(percentRadio, t('Percentage')), percentRange, percentValue),
    );

    // Format et qualité
    const formatSelect = makeElement('select', 'resize-field');
    formatSelect.append(new Option('JPEG', 'jpeg'), new Option('PNG', 'png'));
    formatSelect.value = saved.format;
    const qualityRange = makeInput('range', { min: 1, max: 100, step: 1, value: saved.jpegQuality });
    const qualityValue = makeElement('span', 'resize-value');
    const compressionSelect = makeElement('select', 'resize-field');
    compressionSelect.append(new Option(t('Fast'), 'fast'), new Option(t('Balanced'), 'balanced'), new Option(t('Maximum'), 'best'));
    compressionSelect.value = saved.pngCompression;
    const metadataCheck = makeInput('checkbox');
    const qualityRow = optionRow(makeElement('span', 'resize-label', t('JPEG quality')), qualityRange, qualityValue);
    const compressionRow = optionRow(makeElement('span', 'resize-label', t('PNG compression')), compressionSelect);
    const metadataRow = optionRow(labelled(metadataCheck, t('Keep metadata (EXIF, XMP, IPTC)')));
    const formatSection = makeElement('section', 'settings-section');
    formatSection.append(
      makeElement('h4', '', t('Output format')),
      optionRow(makeElement('span', 'resize-label', t('Format')), formatSelect),
      qualityRow,
      compressionRow,
      metadataRow,
    );

    // Destination
    const pathLabel = makeElement('div', 'settings-path-label');
    const chooseButton = makeElement('button', 'btn-secondary', t('Choose…'));
    chooseButton.type = 'button';
    const resetButton = makeElement('button', 'btn-secondary', t('Original folder'));
    resetButton.type = 'button';
    const folderActions = makeElement('div', 'resize-folder-actions');
    folderActions.append(chooseButton, resetButton);
    const suffixInput = makeInput('text', { value: saved.suffix, autocomplete: 'off', spellcheck: false });
    suffixInput.className = 'resize-field resize-text';
    const preview = makeElement('p', 'resize-preview');
    const error = makeElement('p', 'prompt-error');
    error.setAttribute('role', 'alert');
    const destinationSection = makeElement('section', 'settings-section');
    destinationSection.append(
      makeElement('h4', '', t('Destination folder')),
      pathLabel,
      folderActions,
      optionRow(makeElement('span', 'resize-label', t('File name suffix')), suffixInput),
      preview,
      error,
    );

    const actions = makeElement('div', 'confirm-actions');
    const cancel = makeElement('button', '', t('Cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', modal.close);
    const confirm = makeElement('button', 'btn-primary', t('Resize'));
    confirm.type = 'button';
    actions.append(cancel, confirm);
    modal.body.append(sizeSection, formatSection, destinationSection, actions);

    const sampleName = () => `${baseName(firstPhotoPath).replace(/\.[^.]*$/, '')}${suffixInput.value}.${formatSelect.value === 'png' ? 'png' : 'jpg'}`;
    const refresh = () => {
      const bySide = maxSideRadio.checked;
      maxSideInput.disabled = !bySide;
      percentRange.disabled = bySide;
      percentValue.textContent = `${percentRange.value} %`;
      qualityValue.textContent = qualityRange.value;
      const jpeg = formatSelect.value === 'jpeg';
      qualityRow.hidden = !jpeg;
      compressionRow.hidden = jpeg;
      metadataCheck.disabled = !jpeg;
      metadataCheck.checked = jpeg && keepMetadata;
      metadataRow.title = jpeg ? '' : t('Metadata can only be kept in JPEG files');
      pathLabel.textContent = destination ?? t('Original folder of each photo');
      pathLabel.title = destination ?? '';
      resetButton.hidden = destination === null;
      preview.textContent = t('Example: {name}', { name: sampleName() });
      error.textContent = '';
    };
    const validate = () => {
      if (maxSideRadio.checked) {
        const side = Number(maxSideInput.value);
        if (!Number.isInteger(side) || side < RESIZE_SIDE_LIMITS.min || side > RESIZE_SIDE_LIMITS.max) {
          return t('Enter a size between {min} and {max} px', RESIZE_SIDE_LIMITS);
        }
      }
      if (FORBIDDEN_SUFFIX_CHARACTERS.test(suffixInput.value)) return t('The suffix contains a forbidden character');
      if (destination === null && suffixInput.value === '') return t('Without a suffix, choose another destination folder');
      return '';
    };
    const submit = () => {
      const problem = validate();
      if (problem) {
        error.textContent = problem;
        return;
      }
      const jpeg = formatSelect.value === 'jpeg';
      const bySide = maxSideRadio.checked;
      localStorage.setItem(RESIZE_SETTINGS_KEY, JSON.stringify({
        mode: bySide ? 'max_side' : 'percent',
        maxSide: bySide ? Number(maxSideInput.value) : saved.maxSide,
        percent: Number(percentRange.value),
        format: formatSelect.value,
        jpegQuality: Number(qualityRange.value),
        pngCompression: compressionSelect.value,
        keepMetadata,
        suffix: suffixInput.value,
      }));
      result = {
        mode: bySide ? 'max_side' : 'percent',
        value: bySide ? Number(maxSideInput.value) : Number(percentRange.value),
        format: formatSelect.value,
        jpegQuality: Number(qualityRange.value),
        pngCompression: compressionSelect.value,
        keepMetadata: jpeg && keepMetadata,
        destination,
        suffix: suffixInput.value,
      };
      modal.close();
    };

    for (const control of [maxSideRadio, percentRadio, percentRange, qualityRange, formatSelect, compressionSelect, suffixInput]) {
      control.addEventListener('input', refresh);
      control.addEventListener('change', refresh);
    }
    maxSideInput.addEventListener('input', () => { error.textContent = ''; });
    metadataCheck.addEventListener('change', () => { keepMetadata = metadataCheck.checked; });
    for (const field of [maxSideInput, suffixInput]) {
      field.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        submit();
      });
    }
    chooseButton.addEventListener('click', async () => {
      try {
        const selected = await open({
          directory: true,
          multiple: false,
          title: t('Choose the destination folder'),
          defaultPath: destination || localStorage.getItem(LAST_RESIZE_FOLDER_KEY) || firstPhotoPath.replace(/[\\/][^\\/]*$/, '') || undefined,
        });
        if (typeof selected !== 'string' || !selected) return;
        destination = selected;
        localStorage.setItem(LAST_RESIZE_FOLDER_KEY, selected);
        refresh();
      } catch (failure) {
        console.error('Sélection de dossier impossible', failure);
      }
    });
    resetButton.addEventListener('click', () => {
      destination = null;
      refresh();
    });
    confirm.addEventListener('click', submit);
    refresh();
    (maxSideRadio.checked ? maxSideInput : percentRange).focus();
  });
}

// Question posée quand le fichier de destination existe déjà. Renvoie { action: 'replace' | 'increment' | 'skip', applyAll }.
// Fermer la fenêtre (Échap, ×) revient à « Passer » pour ce fichier seulement. Le focus est sur « Incrémenter le nom », le choix sans perte de données.
function resizeConflictDialog(output) {
  return new Promise(resolve => {
    let choice = { action: 'skip', applyAll: false };
    const modal = createModal({ title: t('File already exists'), cardClass: 'confirm-card', focusSelector: FORM_FOCUSABLE, onClose: () => resolve(choice) });
    const text = makeElement('p', 'confirm-message', t('“{name}” already exists in “{folder}”.', {
      name: baseName(output),
      folder: baseName(output.replace(/[\\/][^\\/]*$/, '')),
    }));
    const applyAll = makeInput('checkbox');
    const applyRow = makeElement('div', 'resize-option');
    applyRow.append(labelled(applyAll, t('Apply to all following files')));
    const actions = makeElement('div', 'confirm-actions');
    const buttons = [['replace', t('Replace'), 'btn-danger'], ['increment', t('Increment name'), 'btn-primary'], ['skip', t('Skip'), '']].map(([action, label, className]) => {
      const button = makeElement('button', className, label);
      button.type = 'button';
      button.addEventListener('click', () => {
        choice = { action, applyAll: applyAll.checked };
        modal.close();
      });
      return button;
    });
    actions.append(...buttons);
    modal.body.append(text, applyRow, actions);
    // Flèches : passent d'un bouton à l'autre. Entrée valide le bouton ayant le focus.
    modal.overlay.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (document.activeElement === applyAll) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement);
      const next = event.key === 'ArrowLeft' ? Math.max(0, current - 1) : Math.min(buttons.length - 1, current + 1);
      buttons[current < 0 ? 1 : next].focus();
    });
    buttons[1].focus();
  });
}

async function runResizeBatch(targets, options) {
  resizeRunning = true;
  const total = targets.length;
  const workerCount = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1, total));
  let next = 0;
  let finished = 0;
  let written = 0;
  let skipped = 0;
  const failures = [];
  let appliedPolicy = null; // choix « Appliquer à tous les fichiers suivants »
  let conflictQueue = Promise.resolve();
  const showProgress = () => api.showToast(t('Resizing… {done}/{total}', { done: finished, total }), true);

  // Les questions sont posées une à la fois ; pendant qu'une fenêtre est ouverte, les autres photos continuent d'être traitées.
  const askConflict = output => {
    const run = async () => {
      if (appliedPolicy) return appliedPolicy;
      const choice = await resizeConflictDialog(output);
      if (choice.applyAll) appliedPolicy = choice.action;
      return choice.action;
    };
    const answer = conflictQueue.then(run, run);
    conflictQueue = answer.catch(() => {});
    return answer;
  };

  const processPhoto = async photo => {
    let conflict = appliedPolicy ?? 'ask';
    for (;;) {
      let outcome;
      try {
        outcome = await invoke('resize_photo', { path: photo.path, options: { ...options, conflict } });
      } catch (failure) {
        failures.push({ path: photo.path, error: String(failure) });
        return;
      }
      if (outcome.status === 'conflict') {
        conflict = await askConflict(outcome.output);
        continue;
      }
      if (outcome.status === 'skipped') skipped += 1;
      else written += 1;
      return;
    }
  };

  const worker = async () => {
    while (next < total) {
      await processPhoto(targets[next++]);
      finished += 1;
      showProgress();
    }
  };

  showProgress();
  try {
    await Promise.all(Array.from({ length: workerCount }, worker));
  } finally {
    resizeRunning = false;
  }
  if (failures.length) console.error('Redimensionnement : échecs', failures);
  const parts = [];
  if (written) parts.push(tp('{count} file resized', written));
  if (skipped) parts.push(tp('{count} file skipped', skipped));
  if (failures.length) parts.push(tp('{count} failure', failures.length));
  api.showToast(!written && !skipped && failures.length ? t('Resize failed: {error}', { error: failures[0].error }) : parts.join(' · '));
  // Les nouvelles photos entrent dans le catalogue si elles sont dans un dossier suivi.
  if (written) api.syncLibrary?.();
}

// Redimensionne les photos données (menu contextuel « Redimensionner… » et touche S, sur la sélection).
export async function resizePhotos(targets) {
  if (!targets.length) return;
  if (resizeRunning) {
    api.showToast(t('A resize is already in progress'));
    return;
  }
  const options = await resizeOptionsDialog(targets.length, targets[0].path);
  if (options) await runResizeBatch(targets, options);
}

async function openWith(program, targets) {
  try {
    await invoke('open_with', { program, paths: targets.map(photo => photo.path) });
  } catch (error) {
    api.showToast(t('Open failed: {error}', { error }));
  }
}

async function chooseProgramAndOpen(targets) {
  const program = await pickProgram();
  if (program) await openWith(program, targets);
}

// Affiche la photo dans le gestionnaire de fichiers de l'OS, avec le fichier sélectionné. Une seule photo est montrée :
// en cas de sélection multiple, c'est celle sous le curseur (celle du clic droit).
export async function revealInFileManager(photo) {
  try {
    await invoke('reveal_in_file_manager', { path: photo.path });
  } catch (error) {
    api.showToast(t('Open failed: {error}', { error }));
  }
}

// Crée un sous-dossier dans un dossier de l'arborescence (nom demandé dans une fenêtre ; le backend vérifie le nom et refuse d'écraser).
async function createSubfolder(parentPath) {
  await promptDialog({
    title: t('New subfolder'),
    message: t('Name of the new subfolder in {folder}', { folder: baseName(parentPath) }),
    inputLabel: t('Subfolder name'),
    confirmLabel: t('Create'),
    cancelLabel: t('Cancel'),
    onSubmit: async name => {
      try {
        await invoke('create_subfolder', { parent: parentPath, name });
      } catch (error) {
        return String(error);
      }
      api.folderCreated(parentPath, name.trim());
      return null;
    },
  });
}

// Ouvre un dossier de l'arborescence dans le gestionnaire de fichiers de l'OS.
export async function openFolderInFileManager(path) {
  try {
    await invoke('open_folder_in_file_manager', { path });
  } catch (error) {
    api.showToast(t('Open failed: {error}', { error }));
  }
}

// ==========================================
// MENUS CONTEXTUELS (miniatures, aperçu, plein écran et arborescence des dossiers)
// ==========================================
let contextTarget = null; // élément de l'arborescence visé par le menu ouvert (mis en évidence)

function closeContextMenu() {
  if (!contextMenu) return;
  contextMenu.remove();
  contextMenu = null;
  contextTarget?.classList.remove('context-target');
  contextTarget = null;
  document.removeEventListener('pointerdown', onOutsidePointerDown, true);
  window.removeEventListener('blur', closeContextMenu);
  window.removeEventListener('resize', closeContextMenu);
  window.removeEventListener('wheel', closeContextMenu);
  document.getElementById('grid-view')?.removeEventListener('scroll', closeContextMenu);
}

function onOutsidePointerDown(event) {
  if (contextMenu && !(event.target instanceof Node && contextMenu.contains(event.target))) closeContextMenu();
}

function menuButton(label, onSelect, { danger = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `context-menu-item${danger ? ' danger' : ''}`;
  button.setAttribute('role', 'menuitem');
  button.textContent = label;
  if (onSelect) {
    button.addEventListener('click', () => {
      closeContextMenu();
      onSelect();
    });
  }
  return button;
}

function setSubmenuExpanded(wrapper, expanded) {
  wrapper.classList.toggle('open', expanded);
  wrapper.firstElementChild.setAttribute('aria-expanded', String(expanded));
  if (!expanded) return;
  // Le sous-menu remonte s'il dépasserait du bas de la fenêtre.
  const submenu = wrapper.querySelector('.context-submenu');
  submenu.style.top = '';
  submenu.style.bottom = '';
  if (submenu.getBoundingClientRect().bottom > window.innerHeight - 4) {
    submenu.style.top = 'auto';
    submenu.style.bottom = '-5px';
  }
}

// « Ouvrir avec » : programmes des Paramètres, puis toujours « Choisir… » en fin de liste.
function buildOpenWithItem(targets) {
  const wrapper = document.createElement('div');
  wrapper.className = 'context-menu-sub';
  const trigger = menuButton(t('Open with'), null);
  trigger.classList.add('has-submenu');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  const submenu = document.createElement('div');
  submenu.className = 'context-submenu';
  submenu.setAttribute('role', 'menu');
  const programs = loadPrograms();
  for (const program of programs) submenu.append(menuButton(program.name, () => openWith(program.path, targets)));
  if (programs.length) {
    const separator = document.createElement('div');
    separator.className = 'context-menu-separator';
    separator.setAttribute('role', 'separator');
    submenu.append(separator);
  }
  submenu.append(menuButton(t('Choose…'), () => chooseProgramAndOpen(targets)));
  wrapper.append(trigger, submenu);
  trigger.addEventListener('click', () => setSubmenuExpanded(wrapper, !wrapper.classList.contains('open')));
  wrapper.addEventListener('mouseenter', () => setSubmenuExpanded(wrapper, true));
  wrapper.addEventListener('mouseleave', () => setSubmenuExpanded(wrapper, false));
  return wrapper;
}

function onMenuKeydown(event) {
  event.stopPropagation();
  if (event.key === 'Tab') {
    event.preventDefault();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeContextMenu();
    return;
  }
  const active = document.activeElement;
  const submenu = active instanceof Element ? active.closest('.context-submenu') : null;
  const items = [...(submenu || contextMenu).querySelectorAll(submenu
    ? ':scope > .context-menu-item'
    : ':scope > .context-menu-item, :scope > .context-menu-sub > .context-menu-item')];
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const current = items.indexOf(active);
    const next = current < 0 ? (step > 0 ? 0 : items.length - 1) : (current + step + items.length) % items.length;
    items[next]?.focus();
  } else if (event.key === 'ArrowRight' && active instanceof Element && active.classList.contains('has-submenu')) {
    event.preventDefault();
    setSubmenuExpanded(active.parentElement, true);
    active.parentElement.querySelector('.context-submenu .context-menu-item')?.focus();
  } else if (event.key === 'ArrowLeft' && submenu) {
    event.preventDefault();
    setSubmenuExpanded(submenu.parentElement, false);
    submenu.parentElement.firstElementChild.focus();
  }
}

function openThumbnailMenu(event, index, source = 'grid') {
  closeContextMenu();
  const photos = api.getPhotos();
  const photo = photos[index];
  if (!photo) return;

  // En vue directe (case d'aperçu ou plein écran), on cible UNIQUEMENT la photo sous le clic.
  // Sur la grille, on conserve le comportement de sélection groupée.
  const isDirectView = source === 'preview' || source === 'fullscreen';

  if (!isDirectView && !api.getSelectedIndices().has(index)) {
    api.selectOnly(index);
  }

  const targets = isDirectView
    ? [photo]
    : [...api.getSelectedIndices()].sort((a, b) => a - b).map(selectedIndex => photos[selectedIndex]).filter(Boolean);

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.append(
    menuButton(t('Photo info'), () => showPhotoInfo(photo)),
    menuButton(targets.length > 1 ? `${t('Delete')} (${targets.length})` : t('Delete'), () => confirmAndDelete(targets), { danger: true }),
    menuButton(t('Copy'), () => copyPhotosToClipboard(targets)),
    menuButton(t('Copy to…'), () => copyPhotosTo(targets)),
    menuButton(t('Resize…'), () => resizePhotos(targets)),
    menuButton(t('Show in file explorer'), () => revealInFileManager(photo)),
    buildOpenWithItem(targets),
  );
  showContextMenu(menu, event);
}

// Menu de l'arborescence des dossiers (clic droit sur un dossier suivi ou l'un de ses sous-dossiers).
function openFolderMenu(event, folderItem) {
  closeContextMenu();
  const path = folderItem.dataset.folderPath;
  if (!path) return;
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.append(
    menuButton(t('Rescan folder data'), () => api.rescanFolder(path)),
    menuButton(t('New subfolder…'), () => createSubfolder(path)),
    menuButton(t('Open folder in file explorer'), () => openFolderInFileManager(path)),
  );
  contextTarget = folderItem;
  folderItem.classList.add('context-target');
  showContextMenu(menu, event);
}

// Affiche le menu au curseur (sans sortir de la fenêtre) et installe les écouteurs qui le ferment.
function showContextMenu(menu, event) {
  menu.addEventListener('keydown', onMenuKeydown);
  document.body.append(menu);
  contextMenu = menu;

  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(4, Math.min(event.clientX, window.innerWidth - width - 4));
  const top = Math.max(4, Math.min(event.clientY, window.innerHeight - height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  if (left + width + 220 > window.innerWidth) menu.classList.add('submenu-left');

  document.addEventListener('pointerdown', onOutsidePointerDown, true);
  window.addEventListener('blur', closeContextMenu);
  window.addEventListener('resize', closeContextMenu);
  window.addEventListener('wheel', closeContextMenu, { passive: true });
  document.getElementById('grid-view')?.addEventListener('scroll', closeContextMenu);
  menu.querySelector('.context-menu-item')?.focus();
}

// Détermine l'index et l'origine du clic (grille ou vue directe aperçu/plein écran).
function findTargetPhoto(target) {
  const thumbnail = target?.closest('.thumbnail');
  if (thumbnail && thumbnail.dataset.index !== undefined) {
    return { index: Number(thumbnail.dataset.index), source: 'grid' };
  }

  const previewCell = target?.closest('.preview-cell');
  if (previewCell?.dataset.path) {
    const photos = api.getPhotos();
    const index = photos.findIndex(photo => photo.path === previewCell.dataset.path);
    if (index >= 0) return { index, source: 'preview' };
  }

  if (target?.closest('#fullscreen-view')) {
    if (target.closest('#fullscreen-rating')) return null;
    const index = api.getActiveIndex ? api.getActiveIndex() : -1;
    return index >= 0 ? { index, source: 'fullscreen' } : null;
  }

  if (target?.closest('#preview-stage, #preview-panel')) {
    const index = api.getActiveIndex ? api.getActiveIndex() : -1;
    return index >= 0 ? { index, source: 'preview' } : null;
  }

  return null;
}

// Remplace le menu contextuel du navigateur
// Menu d'actions sur miniatures, aperçu et plein écran.
function onContextMenu(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input[type="text"], input:not([type]), textarea')) return;
  event.preventDefault();
  if (target?.closest('.context-menu')) return;

  // Arborescence des dossiers : menu propre aux dossiers (« Toutes les photos » n'en a pas, le menu du navigateur reste simplement masqué).
  const folderItem = target?.closest('#folder-tree .folder-tree-item');
  if (folderItem) {
    if (folderItem.dataset.folderPath) openFolderMenu(event, folderItem);
    else closeContextMenu();
    return;
  }

  const result = findTargetPhoto(target);
  if (!result) {
    closeContextMenu();
    return;
  }
  openThumbnailMenu(event, result.index, result.source);
}

// options : getPhotos(), getSelectedIndices(), selectOnly(index), removePhotos(paths), showToast(message, isWriting), rescanFolder(path), folderCreated(parentPath, name),
// syncLibrary() (relecture des dossiers suivis après la création de fichiers).
export function initPhotoActions(options) {
  api = options;
  document.addEventListener('contextmenu', onContextMenu);
  document.getElementById('btn-add-program')?.addEventListener('click', addProgramFromDialog);
  renderProgramList();
  onLanguageChange(renderProgramList);
}
