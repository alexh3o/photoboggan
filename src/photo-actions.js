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
function createModal({ title, cardClass = '', onClose = null }) {
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
      const focusables = [...card.querySelectorAll('button:not([disabled])')];
      if (!focusables.length) return;
      const index = focusables.indexOf(document.activeElement);
      const next = event.shiftKey ? (index <= 0 ? focusables.length - 1 : index - 1) : (index === focusables.length - 1 ? 0 : index + 1);
      focusables[next].focus();
    }
  });
  overlay.focus();
  return { overlay, card, body, close };
}

// Confirmation Oui / Non ; le focus est sur « Oui » (rouge) et les flèches du clavier passent de l'un à l'autre. Renvoie true uniquement si « Oui » est activé.
function confirmDialog({ title, message, confirmLabel, cancelLabel }) {
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
    message: tp('Permanently delete {name}? This cannot be undone.', count, { name: photoName(targets[0]) }),
    confirmLabel: t('Yes'),
    cancelLabel: t('No'),
  });
  if (!confirmed) return;
  api.showToast(tp('Deleting {count} file…', count), true);
  try {
    const result = await invoke('delete_photos', { paths: targets.map(photo => photo.path) });
    if (result.deleted.length) api.removePhotos(result.deleted);
    const failures = result.failed.length;
    if (failures) console.error('Suppression : échecs', result.failed);
    api.showToast(failures && !result.deleted.length
      ? t('Delete failed: {error}', { error: result.failed[0].error })
      : `${tp('{count} file deleted', result.deleted.length)}${failures ? ` · ${tp('{count} failure', failures)}` : ''}`);
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

// ==========================================
// MENU CONTEXTUEL DES MINIATURES
// ==========================================
function closeContextMenu() {
  if (!contextMenu) return;
  contextMenu.remove();
  contextMenu = null;
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

function openThumbnailMenu(event, index) {
  closeContextMenu();
  const photos = api.getPhotos();
  const photo = photos[index];
  if (!photo) return;
  // Comme dans l'Explorateur : clic droit hors sélection = on sélectionne cette photo ; dans la sélection = on agit sur toute la sélection.
  if (!api.getSelectedIndices().has(index)) api.selectOnly(index);
  const targets = [...api.getSelectedIndices()].sort((a, b) => a - b).map(selectedIndex => photos[selectedIndex]).filter(Boolean);

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.append(
    menuButton(t('Photo info'), () => showPhotoInfo(photo)),
    menuButton(targets.length > 1 ? `${t('Delete')} (${targets.length})` : t('Delete'), () => confirmAndDelete(targets), { danger: true }),
    menuButton(t('Copy'), () => copyPhotosToClipboard(targets)),
    menuButton(t('Copy to…'), () => copyPhotosTo(targets)),
    menuButton(t('Show in file explorer'), () => revealInFileManager(photo)),
    buildOpenWithItem(targets),
  );
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

// Détermine l'index de la photo visée par le clic droit (miniature, cellule d'aperçu ou plein écran).
function findTargetPhotoIndex(target) {
  // 1. Clic droit sur une miniature de la grille
  const thumbnail = target?.closest('.thumbnail');
  if (thumbnail && thumbnail.dataset.index !== undefined) {
    return Number(thumbnail.dataset.index);
  }
  // 2. Clic droit sur une case d'aperçu (mode normal ou mode comparaison)
  const previewCell = target?.closest('.preview-cell');
  if (previewCell?.dataset.path) {
    const photos = api.getPhotos();
    const index = photos.findIndex(photo => photo.path === previewCell.dataset.path);
    if (index >= 0) return index;
  }
  // 3. Clic droit dans la vue plein écran (sauf sur la barre de notation)
  if (target?.closest('#fullscreen-view')) {
    if (target.closest('#fullscreen-rating')) return -1;
    return api.getActiveIndex ? api.getActiveIndex() : -1;
  }
  // 4. Clic droit dans la zone d'aperçu générale
  if (target?.closest('#preview-stage, #preview-panel')) {
    return api.getActiveIndex ? api.getActiveIndex() : -1;
  }
  return -1;
}

// Remplace le menu du navigateur : menu d'actions sur miniatures, aperçu et plein écran.
function onContextMenu(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input[type="text"], input:not([type]), textarea')) return;
  event.preventDefault();
  if (target?.closest('.context-menu')) return;
  const index = findTargetPhotoIndex(target);
  if (index < 0) {
    closeContextMenu();
    return;
  }
  openThumbnailMenu(event, index);
}

// options : getPhotos(), getSelectedIndices(), selectOnly(index), removePhotos(paths), showToast(message, isWriting).
export function initPhotoActions(options) {
  api = options;
  document.addEventListener('contextmenu', onContextMenu);
  document.getElementById('btn-add-program')?.addEventListener('click', addProgramFromDialog);
  renderProgramList();
  onLanguageChange(renderProgramList);
}
