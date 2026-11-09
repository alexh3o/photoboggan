import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open } from '@tauri-apps/plugin-dialog';
import { t, tp, getLanguage, onLanguageChange } from './i18n.js';
import { getIsFullscreen, isVideoPath, isRawPath } from './main.js';
import { isWriteLocked, failureDetailsAction } from './metadata-writes.js';
import { getWriterMode } from './metadata-settings.js';
import { getIdenticalSettings, getSimilarSettings, describeIdenticalSettings, describeSimilarSettings } from './duplicates.js';
import { SLIDESHOW_DELAYS, getSlideshowSettings, setSlideshowOption, isSlideshowActive, isSlideshowPaused, startSlideshow, stopSlideshow, toggleSlideshowPause } from './slideshow.js';

// Actions sur les photos : menu contextuel des miniatures (remplace le menu du navigateur), fenêtre d'informations,
// suppression, copie des originaux et « Ouvrir avec ». main.js donne accès à l'état de la grille via initPhotoActions().

const PROGRAMS_STORAGE_KEY = 'openWithProgramsBySection';
const LEGACY_PROGRAMS_STORAGE_KEY = 'openWithPrograms'; // ancienne liste unique : recopiée dans chaque section tant que rien n'est enregistré
const PROGRAM_SECTION_STORAGE_KEY = 'openWithSection'; // section affichée dans les Paramètres
// Sections « Ouvrir avec » : chacune a sa liste ordonnée ; le premier programme est celui du raccourci O.
const PROGRAM_SECTIONS = ['images', 'raw', 'videos'];
const LAST_COPY_FOLDER_KEY = 'lastCopyFolder';
let api = null;
let contextMenu = null;

const baseName = path => path.split(/[\\/]/).filter(Boolean).pop() || path;
const photoName = photo => photo.filename || baseName(photo.path);
const defaultProgramName = path => baseName(path).replace(/\.[^.\\/]+$/, '');

// ==========================================
// PROGRAMMES « OUVRIR AVEC » (liste dans les Paramètres, mémorisée localement)
// ==========================================
function cleanPrograms(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(program => program && typeof program.path === 'string' && program.path)
    .map(program => ({ name: String(program.name || '').trim() || defaultProgramName(program.path), path: program.path }));
}

// Section d'un fichier : vidéos, RAW, sinon images rendues (JPEG, PNG, HEIC…).
function programSection(path) {
  if (isVideoPath(path)) return 'videos';
  return isRawPath(path) ? 'raw' : 'images';
}

function loadAllPrograms() {
  try {
    const stored = JSON.parse(localStorage.getItem(PROGRAMS_STORAGE_KEY));
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      return Object.fromEntries(PROGRAM_SECTIONS.map(section => [section, cleanPrograms(stored[section])]));
    }
    // Première utilisation après la mise à jour : l'ancienne liste unique sert à toutes les sections.
    const legacy = cleanPrograms(JSON.parse(localStorage.getItem(LEGACY_PROGRAMS_STORAGE_KEY) || '[]'));
    return Object.fromEntries(PROGRAM_SECTIONS.map(section => [section, legacy.map(program => ({ ...program }))]));
  } catch (error) {
    console.debug('Programs list unreadable', error);
    return Object.fromEntries(PROGRAM_SECTIONS.map(section => [section, []]));
  }
}

const loadPrograms = section => loadAllPrograms()[section] || [];

function savePrograms(section, programs) {
  localStorage.setItem(PROGRAMS_STORAGE_KEY, JSON.stringify({ ...loadAllPrograms(), [section]: programs }));
}

// Boîte de dialogue de l'OS pour choisir un dossier de destination ; null si l'utilisateur annule ou si la boîte ne s'ouvre pas.
async function pickDirectory(defaultPath) {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t('Choose the destination folder'),
      defaultPath: defaultPath || undefined,
    });
    return typeof selected === 'string' && selected ? selected : null;
  } catch (error) {
    console.error('Folder selection failed', error);
    return null;
  }
}

// OS dialog to choose a program; null if the user cancels. Opened by the backend (pick_program), which then allows that program for
// "Open with": open_with refuses any program that was not chosen this way.
async function pickProgram() {
  try {
    const selected = await invoke('pick_program', { title: t('Choose a program'), filterName: t('Programs') });
    return typeof selected === 'string' && selected ? selected : null;
  } catch (error) {
    console.error('Program selection failed', error);
    return null;
  }
}

function shownProgramSection() {
  const select = document.getElementById('open-with-section');
  return select && PROGRAM_SECTIONS.includes(select.value) ? select.value : PROGRAM_SECTIONS[0];
}

// Glisser la poignée : la ligne change de place dès que le pointeur passe le milieu d'une voisine ; l'ordre est enregistré au relâchement
// (même principe que order-list.js : évènements pointeur plutôt que glisser-déposer HTML5).
function startProgramDrag(event, item, handle, list, section) {
  if (event.button !== 0) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  item.classList.add('dragging');
  const onMove = moveEvent => {
    const previous = item.previousElementSibling;
    const next = item.nextElementSibling;
    if (previous && moveEvent.clientY < previous.getBoundingClientRect().top + previous.offsetHeight / 2) list.insertBefore(item, previous);
    if (next && moveEvent.clientY > next.getBoundingClientRect().top + next.offsetHeight / 2) list.insertBefore(next, item);
  };
  const onEnd = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onEnd);
    handle.removeEventListener('pointercancel', onEnd);
    item.classList.remove('dragging');
    const programs = loadPrograms(section);
    const order = [...list.children].map(child => child.dataset.path);
    savePrograms(section, order.map(path => programs.find(program => program.path === path)).filter(Boolean));
    renderProgramList();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onEnd);
  handle.addEventListener('pointercancel', onEnd);
}

function renderProgramList() {
  const list = document.getElementById('settings-program-list');
  if (!list) return;
  const section = shownProgramSection();
  const programs = loadPrograms(section);
  if (!programs.length) {
    const empty = document.createElement('li');
    empty.className = 'settings-program-empty';
    empty.textContent = t('No program configured');
    list.replaceChildren(empty);
    return;
  }
  const moveButton = (symbol, label, disabled, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'keyword-format-move';
    button.textContent = symbol;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    button.addEventListener('click', action);
    return button;
  };
  const move = (index, delta) => {
    const reordered = [...programs];
    [reordered[index], reordered[index + delta]] = [reordered[index + delta], reordered[index]];
    savePrograms(section, reordered);
    renderProgramList();
  };
  list.replaceChildren(...programs.map((program, index) => {
    const item = document.createElement('li');
    item.className = 'settings-program-item';
    item.dataset.path = program.path;
    const handle = document.createElement('span');
    handle.className = 'keyword-format-handle';
    handle.textContent = '⠿';
    handle.title = t('Drag to reorder');
    handle.addEventListener('pointerdown', event => startProgramDrag(event, item, handle, list, section));
    const rank = document.createElement('span');
    rank.className = 'keyword-format-rank';
    rank.textContent = `${index + 1}.`;
    const details = document.createElement('div');
    details.className = 'settings-program-details';
    const name = document.createElement('input');
    name.type = 'text';
    name.name = 'program-name';
    name.autocomplete = 'off'; // pour éviter un warning sur chrome console
    name.className = 'settings-program-name';
    name.value = program.name;
    name.setAttribute('aria-label', t('Program name'));
    name.addEventListener('change', () => {
      const nextName = name.value.trim() || defaultProgramName(program.path);
      savePrograms(section, loadPrograms(section).map(candidate => candidate.path === program.path ? { ...candidate, name: nextName } : candidate));
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
      savePrograms(section, loadPrograms(section).filter(candidate => candidate.path !== program.path));
      renderProgramList();
    });
    item.append(
      handle,
      rank,
      details,
      moveButton('↑', t('Move up'), index === 0, () => move(index, -1)),
      moveButton('↓', t('Move down'), index === programs.length - 1, () => move(index, 1)),
      remove,
    );
    return item;
  }));
}

async function addProgramFromDialog() {
  const path = await pickProgram();
  if (!path) return;
  const section = shownProgramSection();
  const programs = loadPrograms(section);
  const existing = programs.findIndex(program => program.path.toLowerCase() === path.toLowerCase());
  if (existing >= 0) {
    // Déjà dans la liste : on place simplement le curseur sur son nom.
    document.querySelectorAll('.settings-program-name')[existing]?.focus();
    return;
  }
  programs.push({ name: defaultProgramName(path), path });
  savePrograms(section, programs);
  renderProgramList();
}

// ==========================================
// FENÊTRES (informations, confirmation)
// ==========================================
// Fenêtre modale réutilisant les styles des Paramètres. Échap, clic sur le fond et × la ferment ;
// les touches ne remontent pas à main.js (pas de navigation ou de notation involontaire derrière la fenêtre).
// `focusSelector` : éléments parcourus par Tab (les boutons seulement par défaut ; les formulaires y ajoutent champs et listes).
// `canClose()` : faux tant que la fenêtre ne doit pas se fermer (ex. opération en cours : la fermer ferait croire à une annulation).
export function createModal({ title, cardClass = '', onClose = null, focusSelector = 'button:not([disabled])', canClose = () => true }) {
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
    if (!overlay.isConnected || !canClose()) return;
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

// Flèches dans une fenêtre : le focus passe d'un bouton de `buttons` à son voisin (gauche / haut = précédent, droite / bas = suivant).
// Sans effet quand le focus n'est pas sur l'un d'eux (ex. case à cocher, qui garde ses flèches). Entrée valide le bouton ayant le focus.
function arrowKeysBetween(overlay, buttons) {
  overlay.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key) || !buttons.includes(document.activeElement)) return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    buttons[Math.min(buttons.length - 1, Math.max(0, buttons.indexOf(document.activeElement) + step))].focus();
  });
}

// Confirmation Oui / Non
// le focus est sur « Oui » (rouge), ou sur « Non » avec `focusCancel`, et les flèches du clavier passent de l'un à l'autre.
// Renvoie true uniquement si « Oui » est activé.
// `extraLabel` / `onExtra` (facultatifs) : bouton supplémentaire entre « Non » et « Oui » (ex. « Ouvrir » le dossier) qui ne ferme pas la fenêtre.
// `content` (facultatif) : élément affiché sous le message (ex. liste de fichiers) ; `cardClass` : classe de la fenêtre.
export function confirmDialog({ title, message, confirmLabel, cancelLabel, extraLabel, onExtra, content = null, focusCancel = false, cardClass = 'confirm-card' }) {
  return new Promise(resolve => {
    let answer = false;
    const modal = createModal({ title, cardClass, onClose: () => resolve(answer) });
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
    actions.append(cancel);
    if (extraLabel && onExtra) {
      const extra = document.createElement('button');
      extra.type = 'button';
      extra.textContent = extraLabel;
      extra.addEventListener('click', onExtra);
      actions.append(extra);
    }
    actions.append(confirm);
    modal.body.append(...[text, content, actions].filter(Boolean));
    arrowKeysBetween(modal.overlay, [...actions.querySelectorAll('button')]);
    (focusCancel ? cancel : confirm).focus();
  });
}

// Saisie d'un texte (nom de dossier…). `onSubmit(valeur)` renvoie un message d'erreur (la fenêtre reste ouverte et l'affiche) ou null (succès, la fenêtre
// se ferme). Entrée valide, Échap annule. Renvoie true si la saisie a été validée avec succès.
// `value` : texte proposé au départ (sélectionné, sauf avec `selectValue: false` : curseur à la fin, pour continuer la saisie) ;
// `suggestions` : valeurs proposées par l'autocomplétion du champ (ex. chemins de mots-clés), voir renderSuggestions.
const MAX_PROMPT_SUGGESTIONS = 12;

export function promptDialog({ title, message, inputLabel, confirmLabel, cancelLabel, onSubmit, value = '', suggestions = [], selectValue = true }) {
  return new Promise(resolve => {
    let done = false;
    let busy = false; // validation en cours : Échap, × et le fond ne ferment pas la fenêtre (l'opération aboutirait quand même)
    // Tab parcourt aussi le champ de saisie (sinon, une fois quitté, il n'est plus atteignable au clavier).
    const modal = createModal({ title, cardClass: 'confirm-card', focusSelector: FORM_FOCUSABLE, canClose: () => !busy, onClose: () => resolve(done) });
    const text = document.createElement('p');
    text.className = 'confirm-message';
    text.textContent = message;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'prompt-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', inputLabel);
    input.value = value;
    // Autocomplétion propre à l'application (la liste du navigateur rapproche chaque mot séparément : « bernard c » proposait tous les
    // « bernard ») : seules les entrées qui contiennent tout le texte tapé, espaces compris, casse ignorée. En premier celles qui commencent par
    // ce texte, puis celles dont un niveau (« / ») commence par lui. Flèches pour choisir, Entrée ou clic pour retenir, Échap pour fermer la liste.
    const list = document.createElement('ul');
    list.className = 'prompt-suggestions';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    let matches = [];
    let highlighted = -1;
    const pick = suggestion => {
      input.value = suggestion;
      matches = [];
      list.hidden = true;
      input.focus();
      input.setSelectionRange(suggestion.length, suggestion.length);
    };
    const highlight = index => {
      highlighted = index;
      [...list.children].forEach((item, position) => item.classList.toggle('active', position === index));
      list.children[index]?.scrollIntoView({ block: 'nearest' });
    };
    const renderSuggestions = () => {
      const query = input.value.trim().toLowerCase();
      matches = [];
      if (query && suggestions.length > 0) {
        const ranked = [];
        for (const suggestion of suggestions) {
          const lower = suggestion.toLowerCase();
          if (!lower.includes(query)) continue;
          const rank = lower.startsWith(query) ? 0 : lower.split('/').some(level => level.trim().startsWith(query)) ? 1 : 2;
          ranked.push([rank, suggestion]);
        }
        ranked.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
        matches = ranked.slice(0, MAX_PROMPT_SUGGESTIONS).map(([, suggestion]) => suggestion);
        if (matches.length === 1 && matches[0].toLowerCase() === query) matches = []; // déjà saisie telle quelle
      }
      highlighted = -1;
      list.replaceChildren(...matches.map(suggestion => {
        const item = document.createElement('li');
        item.setAttribute('role', 'option');
        item.textContent = suggestion;
        item.title = suggestion;
        item.addEventListener('mousedown', event => { event.preventDefault(); pick(suggestion); });
        return item;
      }));
      list.hidden = matches.length === 0;
    };
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
    const submit = async () => {
      if (busy) return;
      busy = true;
      confirm.disabled = true;
      cancel.disabled = true;
      let problem;
      try {
        problem = await onSubmit(input.value);
      } catch (failure) {
        // Erreur inattendue : affichée dans la fenêtre, qui reste utilisable (jamais bloquée avec un bouton grisé).
        console.error('Prompt submit failed', failure);
        problem = String(failure);
      } finally {
        busy = false;
        confirm.disabled = false;
        cancel.disabled = false;
      }
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
    input.addEventListener('input', () => {
      error.textContent = '';
      renderSuggestions();
    });
    input.addEventListener('keydown', event => {
      const listOpen = !list.hidden && matches.length > 0;
      if (listOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        highlight((highlighted + step + matches.length) % matches.length);
      } else if (listOpen && event.key === 'Escape') {
        // Échap ferme d'abord la liste, pas la fenêtre.
        event.preventDefault();
        event.stopPropagation();
        list.hidden = true;
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (listOpen && highlighted >= 0) pick(matches[highlighted]);
        else submit();
      }
    });
    input.addEventListener('blur', () => { list.hidden = true; });
    actions.append(cancel, confirm);
    modal.body.append(text, input, list, error, actions);
    input.focus();
    if (selectValue) input.select();
    else {
      input.setSelectionRange(input.value.length, input.value.length);
      renderSuggestions(); // saisie commencée (lettre tapée sur une vignette) : propositions tout de suite
    }
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
// Nombre d'éléments dont le support n'a pas de corbeille (clé USB, lecteur ou partage réseau) : leur suppression est définitive (voir count_permanent_deletions).
// En cas d'erreur de la commande, on suppose la corbeille disponible.
async function countPermanentDeletions(paths) {
  try {
    return Number(await invoke('count_permanent_deletions', { paths })) || 0;
  } catch (error) {
    console.debug('Permanent deletion count unavailable', error);
    return 0;
  }
}

export async function confirmAndDelete(targets) {
  // Écriture de métadonnées en cours ou en file : elle vise ces fichiers (ExifTool pourrait recréer un fichier mis à la corbeille).
  if (isWriteLocked()) {
    api.showToast(t('Metadata writing in progress…'));
    return;
  }
  const count = targets.length;
  const permanent = await countPermanentDeletions(targets.map(photo => photo.path));
  const name = photoName(targets[0]);
  let message = tp('Move {name} to the trash?', count, { name });
  if (permanent === count) message = tp('Permanently delete {name}? This storage has no trash (USB drive or network): it cannot be undone.', count, { name });
  else if (permanent > 0) message = t('Some of these {count} photos ({permanent}) are on a storage without trash (USB drive or network) and will be permanently deleted. Continue?', { count, permanent });
  const confirmed = await confirmDialog({
    title: permanent ? t('Confirm permanent deletion') : t('Confirm deletion'),
    message,
    confirmLabel: t('Yes'),
    cancelLabel: t('No'),
  });
  if (!confirmed) return;
  api.showToast(permanent ? tp('Deleting {count} file…', count) : tp('Moving {count} file to the trash…', count), true);
  try {
    const result = await invoke('delete_photos', { paths: targets.map(photo => photo.path) });
    if (result.deleted.length) api.removePhotos(result.deleted);
    const failures = result.failed.length;
    if (failures) console.error('Delete failures', result.failed);
    const details = failureDetailsAction(t('Some files could not be deleted'), result.failed);
    api.showToast(failures && !result.deleted.length
      ? t('Delete failed: {error}', { error: result.failed[0].error })
      : `${tp(permanent ? '{count} file deleted' : '{count} file moved to the trash', result.deleted.length)}${failures ? ` · ${tp('{count} failure', failures)}` : ''}`,
    false, details);
  } catch (error) {
    api.showToast(t('Delete failed: {error}', { error }));
  }
}

// Taille d'un fichier pour la question « fichier existant » (Ko sous 1 Mo, Mo au-delà).
function formatCopySize(bytes) {
  if (bytes < 1024 * 1024) return t('{size} KB', { size: Math.max(1, Math.round(bytes / 1024)) });
  return t('{size} MB', { size: (bytes / (1024 * 1024)).toLocaleString(getLanguage(), { maximumFractionDigits: 1 }) });
}

// Question posée pour un fichier à copier dont le nom existe déjà à destination : montre taille et date de modification des deux fichiers.
// Renvoie { action: 'rename' | 'skip' | 'replace', applyAll }. Fermer la fenêtre (Échap, ×) revient à « Passer » pour ce fichier seulement ; le focus est
// sur « Renommer automatiquement », le choix sans perte de données.
function copyConflictDialog(conflict) {
  return new Promise(resolve => {
    let choice = { action: 'skip', applyAll: false };
    const modal = createModal({ title: t('File already exists'), cardClass: 'confirm-card', focusSelector: FORM_FOCUSABLE, onClose: () => resolve(choice) });
    const describe = (label, size, modified) => makeElement('p', 'confirm-message', t('{label} {size} · modified on {date}', {
      label,
      size: formatCopySize(size),
      date: new Date(modified).toLocaleString(getLanguage()),
    }));
    const text = makeElement('p', 'confirm-message', t('“{name}” already exists in the destination folder.', { name: conflict.name }));
    const applyAll = makeInput('checkbox');
    const applyRow = makeElement('div', 'resize-option');
    applyRow.append(labelled(applyAll, t('Apply my choice to the following files')));
    const actions = makeElement('div', 'confirm-actions');
    // « Annuler la copie » : aucun fichier n'est copié (mauvais dossier choisi…), au lieu d'enchaîner les « Passer ».
    const buttons = [['rename', t('Rename automatically'), 'btn-primary'], ['skip', t('Skip this file'), ''], ['replace', t('Overwrite the destination file'), 'btn-danger'], ['cancel', t('Cancel the copy'), '']].map(([action, label, className]) => {
      const button = makeElement('button', className, label);
      button.type = 'button';
      button.addEventListener('click', () => {
        choice = { action, applyAll: applyAll.checked };
        modal.close();
      });
      return button;
    });
    actions.append(...buttons);
    modal.body.append(
      text,
      describe(t('Destination file:'), conflict.target_size, conflict.target_modified),
      describe(t('File to copy:'), conflict.source_size, conflict.source_modified),
      applyRow,
      actions,
    );
    arrowKeysBetween(modal.overlay, buttons);
    buttons[0].focus();
  });
}

// Avant une copie : cherche les fichiers dont le nom existe déjà à destination (`command` : copy_conflicts ou tracked_copy_conflicts) et pose la question
// pour chacun, l'un après l'autre. « Appliquer mon choix aux fichiers suivants » vaut pour les conflits restants de cette copie seulement.
// Renvoie { chemin du fichier à copier: 'rename' | 'skip' | 'replace' } à passer à la commande de copie ; un fichier absent de la table est renommé.
// Renvoie null si l'utilisateur annule la copie : rien ne doit être copié.
export async function askCopyResolutions(command, paths, destination) {
  let conflicts = [];
  try {
    conflicts = await invoke(command, { paths, destination });
  } catch (error) {
    console.debug('Copy conflicts unavailable', error); // sans la liste, la copie renomme comme avant : aucun fichier n'est écrasé
  }
  const resolutions = {};
  let applied = null;
  for (const conflict of conflicts) {
    if (applied) {
      resolutions[conflict.path] = applied;
      continue;
    }
    const choice = await copyConflictDialog(conflict);
    if (choice.action === 'cancel') return null;
    resolutions[conflict.path] = choice.action;
    if (choice.applyAll) applied = choice.action;
  }
  return resolutions;
}

// Copie des fichiers originaux (pas des miniatures) vers un dossier choisi dans la boîte de dialogue de l'OS.
export async function copyPhotosTo(targets) {
  const destination = await pickDirectory(localStorage.getItem(LAST_COPY_FOLDER_KEY));
  if (!destination) return;
  localStorage.setItem(LAST_COPY_FOLDER_KEY, destination);
  const paths = targets.map(photo => photo.path);
  const resolutions = await askCopyResolutions('copy_conflicts', paths, destination);
  if (!resolutions) return; // copie annulée
  // Tâche de la file (progression, arrêt possible entre deux fichiers, voir copy_photos).
  api.enqueueFileTask({
    kind: 'copy',
    path: null,
    command: 'copy_photos',
    args: { paths, destination, resolutions },
    labelKey: 'Copying files ({count})',
    labelParams: { count: targets.length },
    onResult: (result, stopped, error) => {
      if (error) {
        api.showToast(t('Copy failed: {error}', { error }));
        return;
      }
      if (!result) return; // removed from the queue before it started: nothing was copied
      const failures = result.failed.length;
      if (failures) console.error('Copy failures', result.failed);
      const renamed = sidecarRenameNotice(result);
      if (stopped && !renamed.text && !failures) return;
      const action = failureDetailsAction(t('Some files could not be copied'), result.failed, { notes: [renamed.text], logPath: result.log_path }) ?? renamed.action;
      api.showToast(failures && !result.copied
        ? t('Copy failed: {error}', { error: result.failed[0].error })
        : [tp('{count} file copied', result.copied), result.skipped ? tp('{count} file skipped', result.skipped) : '', failures ? tp('{count} failure', failures) : '', renamed.text].filter(Boolean).join(' · '),
      false, action, action ? 12000 : null);
    },
  });
}

// Move or copy result: photos given another name because a sidecar that is not theirs was already at the destination (left untouched,
// listed in a log of the storage folder). Returns the text to add to the end-of-task toast and its "Show log" button, or nulls.
export function sidecarRenameNotice(result) {
  const count = result?.renamed_for_sidecar?.length ?? 0;
  if (!count) return { text: null, action: null };
  const text = tp('{count} renamed: a sidecar was already at the destination', count);
  const logPath = result.log_path;
  const action = logPath
    ? { label: t('Show log'), onClick: () => invoke('reveal_in_file_manager', { path: logPath }).catch(error => api.showToast(String(error))) }
    : null;
  return { text, action };
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
// Une fenêtre d'options, puis le lot devient une tâche de la file de main.js (progression, arrêt possible, une tâche à la fois) : il est traité photo par
// photo (commande `resize_photo`, quelques appels en parallèle). Quand le fichier de
// destination existe déjà, une question est posée (une à la fois) avec la possibilité d'appliquer le choix aux fichiers suivants.
const RESIZE_SETTINGS_KEY = 'resizeSettings';
const LAST_RESIZE_FOLDER_KEY = 'lastResizeFolder';
const RESIZE_SIDE_LIMITS = { min: 16, max: 30000 };
const FORM_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled])';
const FORBIDDEN_SUFFIX_CHARACTERS = /[\\/:*?"<>|\u0000-\u001f]/;

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
  } catch (error) {
    console.debug('Resize settings unreadable', error);
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
    keepMarks: stored.keepMarks === true, // désactivé par défaut
    suffix: typeof stored.suffix === 'string' ? stored.suffix : '_s',
  };
}

// Fenêtre d'options. Renvoie les options à envoyer au backend (sans la politique de conflit) ou null si l'utilisateur annule.
function resizeOptionsDialog(count, firstPhotoPath) {
  return new Promise(resolve => {
    const saved = loadResizeSettings();
    let destination = null; // null = dossier d'origine de chaque photo
    let keepMetadata = saved.keepMetadata;
    let keepMarks = saved.keepMarks;
    // L'option n'existe que sur le chemin d'écriture ExifTool ; en écriture interne, les marquages sont recopiés tels quels.
    const exiftoolWriter = getWriterMode() === 'exiftool';
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
    const marksCheck = makeInput('checkbox');
    const marksRow = optionRow(labelled(marksCheck, t('Keep marks (rating, color, flags)')));
    marksRow.hidden = !exiftoolWriter;
    const formatSection = makeElement('section', 'settings-section');
    formatSection.append(
      makeElement('h4', '', t('Output format')),
      optionRow(makeElement('span', 'resize-label', t('Format')), formatSelect),
      qualityRow,
      compressionRow,
      metadataRow,
      marksRow,
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
      marksCheck.disabled = !jpeg || !keepMetadata; // sans métadonnées recopiées, il n'y a pas de marquages à conserver
      marksCheck.checked = keepMarks;
      marksRow.title = marksCheck.disabled ? t('Marks are only copied with the metadata') : '';
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
        keepMarks,
        suffix: suffixInput.value,
      }));
      result = {
        mode: bySide ? 'max_side' : 'percent',
        value: bySide ? Number(maxSideInput.value) : Number(percentRange.value),
        format: formatSelect.value,
        jpegQuality: Number(qualityRange.value),
        pngCompression: compressionSelect.value,
        keepMetadata: jpeg && keepMetadata,
        clearMarks: exiftoolWriter && !keepMarks,
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
    metadataCheck.addEventListener('change', () => { keepMetadata = metadataCheck.checked; refresh(); });
    marksCheck.addEventListener('change', () => { keepMarks = marksCheck.checked; });
    for (const field of [maxSideInput, suffixInput]) {
      field.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        submit();
      });
    }
    chooseButton.addEventListener('click', async () => {
      try {
        const selected = await pickDirectory(destination || localStorage.getItem(LAST_RESIZE_FOLDER_KEY) || firstPhotoPath.replace(/[\\/][^\\/]*$/, ''));
        if (!selected) return;
        destination = selected;
        localStorage.setItem(LAST_RESIZE_FOLDER_KEY, selected);
        refresh();
      } catch (failure) {
        console.error('Folder selection failed', failure);
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
    arrowKeysBetween(modal.overlay, buttons);
    buttons[1].focus();
  });
}

// Traitement du lot, exécuté par la file des tâches (`task` : sa tâche, `setPercent` : avancement en %). Un arrêt demandé (`task.stopRequested`) laisse finir
// les photos en cours et ne démarre pas les suivantes ; les fichiers déjà redimensionnés le restent. Renvoie le bilan pour `showResizeSummary`.
async function runResizeBatch(targets, options, task, setPercent) {
  const total = targets.length;
  const workerCount = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1, total));
  let next = 0;
  let finished = 0;
  let written = 0;
  let skipped = 0;
  const failures = [];
  let appliedPolicy = null; // choix « Appliquer à tous les fichiers suivants »
  let conflictQueue = Promise.resolve();

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
    while (next < total && !task.stopRequested) {
      await processPhoto(targets[next++]);
      finished += 1;
      setPercent(Math.floor(finished * 100 / total));
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return { written, skipped, failures };
}

// Message de fin du lot, puis intégration des nouveaux fichiers au catalogue (s'ils sont dans un dossier suivi).
function showResizeSummary({ written, skipped, failures }, ignoredVideosCount, stopped) {
  if (failures.length) console.error('Resize failures', failures);
  if (stopped && !failures.length) return; // le toast « Action arrêtée » de la file suffit, sauf s'il y a des échecs à détailler
  const parts = [];
  if (written) parts.push(tp('{count} file resized', written));
  if (skipped) parts.push(tp('{count} file skipped', skipped));
  if (failures.length) parts.push(tp('{count} failure', failures.length));
  if (ignoredVideosCount > 0) parts.push(tp('{count} video file ignored', ignoredVideosCount));
  const details = failureDetailsAction(t('Some files could not be resized'), failures);
  api.showToast(!written && !skipped && failures.length ? t('Resize failed: {error}', { error: failures[0].error }) : parts.join(' · '), false, details);
}

// Redimensionne les photos données (menu contextuel « Redimensionner… » et touche S, sur la sélection).
export async function resizePhotos(targets) {
  const resizableTargets = targets.filter(target => !isVideoPath(target.path));
  const ignoredVideosCount = targets.length - resizableTargets.length;

  if (!resizableTargets.length) {
    if (ignoredVideosCount > 0) {
      api.showToast(tp('{count} video file ignored', ignoredVideosCount));
    }
    return;
  }
  const options = await resizeOptionsDialog(resizableTargets.length, resizableTargets[0].path);
  if (!options) return;
  api.enqueueFileTask({
    kind: 'resize',
    path: null,
    labelKey: 'Resizing files ({count})',
    labelParams: { count: resizableTargets.length },
    runner: (task, setPercent) => runResizeBatch(resizableTargets, options, task, setPercent),
    onResult: (summary, stopped, error) => {
      if (error) {
        api.showToast(t('Resize failed: {error}', { error }));
        return;
      }
      if (!summary) return; // removed from the queue before it started: nothing was resized
      showResizeSummary(summary, ignoredVideosCount, stopped);
      // Les nouveaux fichiers entrent dans le catalogue : synchronisation demandée, faite dès que la file des tâches est vide (main.js).
      if (summary.written) setTimeout(() => api.syncLibrary?.(), 0);
    },
  });
}

// Lance une commande d'ouverture (programme externe, gestionnaire de fichiers) ; un échec est signalé par un message.
async function invokeOpen(command, args) {
  try {
    await invoke(command, args);
  } catch (error) {
    api.showToast(t('Open failed: {error}', { error }));
  }
}

// `name` : nom du programme affiché dans le message « Ouverture avec … » (5 secondes).
function openWith(program, targets, name = defaultProgramName(program)) {
  api.showToast(t('Opening with {program}', { program: name }), false, null, 5000);
  return invokeOpen('open_with', { program, paths: targets.map(photo => photo.path) });
}

// Raccourci O : ouvre les photos avec le premier programme de la section de la première photo ; message si cette section est vide.
export async function openWithFirstProgram(targets) {
  if (!targets.length) return;
  const [program] = loadPrograms(programSection(targets[0].path));
  if (!program) {
    api.showToast(t('No program configured for this file type'));
    return;
  }
  await openWith(program.path, targets, program.name);
}

async function chooseProgramAndOpen(targets) {
  const program = await pickProgram();
  if (program) await openWith(program, targets);
}

// Affiche la photo dans le gestionnaire de fichiers de l'OS, avec le fichier sélectionné. Une seule photo est montrée :
// en cas de sélection multiple, c'est celle sous le curseur (celle du clic droit).
export function revealInFileManager(photo) {
  return invokeOpen('reveal_in_file_manager', { path: photo.path });
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

// Renomme un dossier de l'arborescence : la saisie reprend le nom actuel ; le backend vérifie le nom et refuse d'écraser (message affiché dans la fenêtre).
async function renameFolder(path) {
  const current = baseName(path);
  await promptDialog({
    title: t('Rename folder'),
    message: t('New name of the folder “{name}”', { name: current }),
    inputLabel: t('Folder name'),
    confirmLabel: t('Rename'),
    cancelLabel: t('Cancel'),
    value: current,
    onSubmit: async name => (name.trim() === current ? null : api.renameFolder(path, name)),
  });
}

// Renomme une photo ou une vidéo : seul le nom sans extension est modifiable, l'extension (dernier point du nom) est conservée par le backend.
// « IMG.2024.cr2 » propose donc « IMG.2024 ».
export async function renamePhoto(photo) {
  const fileName = baseName(photo.path);
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot) : '';
  const current = dot > 0 ? fileName.slice(0, dot) : fileName;
  await promptDialog({
    title: t('Rename file'),
    message: extension
      ? t('New name of “{name}” (the extension {extension} is kept)', { name: fileName, extension })
      : t('New name of “{name}”', { name: fileName }),
    inputLabel: t('File name'),
    confirmLabel: t('Rename'),
    cancelLabel: t('Cancel'),
    value: current,
    onSubmit: async name => (name.trim() === current ? null : api.renamePhoto(photo, name)),
  });
}

// ==========================================
// VÉRIFICATION D'INTÉGRITÉ (rapport final)
// ==========================================
// Fenêtre affichée à la fin d'une vérification d'intégrité (commande `integrity_scan`, lancée depuis la file des tâches de main.js) : résumé, puis un fichier
// suspect par ligne avec un bouton « Montrer » (gestionnaire de fichiers de l'OS). Le rapport s'exporte en CSV dans un dossier choisi dans la boîte de dialogue de l'OS.
const LAST_INTEGRITY_EXPORT_FOLDER_KEY = 'lastIntegrityExportFolder';

function formatDuration(milliseconds) {
  const total = Math.round(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours} h ${minutes} min ${seconds} s`;
  return minutes ? `${minutes} min ${seconds} s` : `${seconds} s`;
}

// Première partie du rapport exporté (texte) : titre, version, date, dossier, extensions vérifiées / non vérifiées, chiffres, durée et durée moyenne par extension.
// La seconde partie (liste CSV des fichiers suspects) est ajoutée par le backend. Ces détails techniques ne figurent que dans l'export, pas dans la fenêtre du rapport.
function buildIntegrityReportPreamble(report, version, hasSuspects) {
  const timings = report.timings ?? [];
  const unverified = report.unsupportedExtensions ?? [];
  const none = t('None');
  const lines = [
    t('File integrity report'),
    '',
    t('Photoboggan version: {version}', { version: version || '?' }),
    t('Date: {date}', { date: report.generatedAt }),
    t('Scanned folder: {path}', { path: report.folder }),
    t('Verified extensions: {list}', { list: timings.length ? timings.map(item => item.extension).join(', ') : none }),
    t('Unverified extensions: {list}', { list: unverified.length ? unverified.map(item => `${item.extension} (${item.files})`).join(', ') : none }),
    '',
    t('Total files: {count}', { count: report.total }),
    t('Files analysed: {count}', { count: report.checked }),
    t('Healthy files: {count}', { count: report.healthy }),
    t('Thumbnails created: {count}', { count: report.thumbnailsCreated }),
    t('Unverified files: {count}', { count: report.unsupported }),
    t('Suspect files: {count}', { count: report.suspects?.length ?? 0 }),
    t('Total duration: {duration}', { duration: formatDuration(report.elapsedMillis ?? 0) }),
  ];
  if (report.thumbnailsFailed) lines.push(t('Thumbnails not written: {count}', { count: report.thumbnailsFailed }));
  if (report.cancelled) lines.push('', t('The check was stopped: this report only covers the files analysed so far.'));
  if (timings.length) {
    lines.push('', t('Files analysed by extension (average time per file):'));
    for (const item of timings) {
      const seconds = (item.averageMillis / 1000).toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
      lines.push(`  ${t('{extension}: {count} files, {seconds} s per file', { extension: item.extension, count: item.files, seconds })}`);
    }
  }
  lines.push('', hasSuspects ? t('Suspect files (CSV, ";" separator):') : t('No suspect file detected.'));
  return lines.join('\n');
}

async function exportIntegrityReport(report) {
  const suspects = report.suspects ?? [];
  const directory = await pickDirectory(localStorage.getItem(LAST_INTEGRITY_EXPORT_FOLDER_KEY));
  if (!directory) return;
  localStorage.setItem(LAST_INTEGRITY_EXPORT_FOLDER_KEY, directory);
  try {
    const version = await getVersion().catch(() => '');
    const file = await invoke('export_integrity_report', {
      preamble: buildIntegrityReportPreamble(report, version, suspects.length > 0),
      directory,
      headers: [t('File name'), t('Folder'), t('Full path'), t('Problem')],
      rows: suspects,
    });
    api.showToast(t('Report exported: {name}', { name: baseName(file) }));
  } catch (error) {
    api.showToast(t('Export failed: {error}', { error }));
  }
}

// `report` : résultat de `integrity_scan` ; `stopped` : la tâche a été arrêtée avant la fin (le rapport ne couvre alors que les fichiers déjà analysés).
export function showIntegrityReport(report, stopped = false) {
  if (!report) return;
  const suspects = Array.isArray(report.suspects) ? report.suspects : [];
  const modal = createModal({ title: `${t('Integrity report')} · ${baseName(report.folder || '')}`, cardClass: 'integrity-card' });

  const verdict = makeElement('p', 'integrity-verdict', suspects.length
    ? tp('{count} suspect file detected', suspects.length)
    : t('No suspect file detected.'));
  verdict.classList.toggle('has-suspects', suspects.length > 0);
  const summary = makeElement('dl', 'integrity-summary');
  const stats = [
    [t('Files analysed'), `${report.checked} / ${report.total}`],
    [t('Healthy files'), report.healthy],
    [t('Thumbnails created'), report.thumbnailsCreated],
  ];
  if (report.unsupported) stats.push([t('Not verified (format without decoder)'), report.unsupported]);
  if (report.thumbnailsFailed) stats.push([t('Thumbnails not written'), report.thumbnailsFailed]);
  if (report.elapsedMillis) stats.push([t('Duration'), formatDuration(report.elapsedMillis)]);
  for (const [label, value] of stats) summary.append(makeElement('dt', '', label), makeElement('dd', '', String(value)));
  const notes = [];
  if (stopped || report.cancelled) notes.push(makeElement('p', 'integrity-note', t('The check was stopped: this report only covers the files analysed so far.')));
  modal.body.append(verdict, summary, ...notes);

  if (suspects.length) {
    const list = makeElement('ul', 'integrity-list');
    const rows = document.createDocumentFragment();
    for (const suspect of suspects) {
      const row = makeElement('li', 'integrity-row');
      const info = makeElement('div', 'integrity-info');
      const name = makeElement('span', 'integrity-name', baseName(suspect.path));
      const problem = makeElement('span', 'integrity-problem', suspect.error);
      const folder = makeElement('span', 'integrity-path', suspect.path.replace(/[\\/][^\\/]*$/, ''));
      folder.title = suspect.path;
      info.append(name, problem, folder);
      const show = makeElement('button', 'btn-secondary', t('Show'));
      show.type = 'button';
      show.addEventListener('click', () => revealInFileManager({ path: suspect.path }));
      row.append(info, show);
      rows.append(row);
    }
    list.append(rows);
    modal.body.append(list);
  }

  const actions = makeElement('div', 'confirm-actions');
  // L'export contient aussi les chiffres et les détails techniques : proposé même sans fichier suspect.
  const exportButton = makeElement('button', '', t('Export report…'));
  exportButton.type = 'button';
  exportButton.addEventListener('click', () => exportIntegrityReport(report));
  actions.append(exportButton);
  const closeButton = makeElement('button', 'btn-primary', t('Close'));
  closeButton.type = 'button';
  closeButton.addEventListener('click', modal.close);
  actions.append(closeButton);
  modal.body.append(actions);
  closeButton.focus();
}

// Ouvre un dossier de l'arborescence dans le gestionnaire de fichiers de l'OS.
export function openFolderInFileManager(path) {
  return invokeOpen('open_folder_in_file_manager', { path });
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

// `shortcut` : touche(s) du raccourci clavier équivalent, affichée en grisé à droite.
// `title` : infobulle expliquant l'action. `disabled` : ligne grisée (l'infobulle dit pourquoi).
function menuButton(label, onSelect, { danger = false, shortcut = null, title = '', disabled = false, checked } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `context-menu-item${danger ? ' danger' : ''}`;
  button.setAttribute('role', 'menuitem');
  if (title) button.title = title;
  if (checked !== undefined) {
    button.setAttribute('role', 'menuitemcheckbox');
    button.setAttribute('aria-checked', String(checked));
    button.classList.toggle('checked', checked);
  }
  if (disabled) {
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
  }
  if (shortcut) {
    const text = document.createElement('span');
    text.textContent = label;
    const keys = document.createElement('span');
    keys.className = 'context-menu-shortcut';
    keys.textContent = shortcut;
    button.classList.add('with-shortcut');
    button.append(text, keys);
  } else {
    button.textContent = label;
  }
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

function menuSeparator() {
  const separator = document.createElement('div');
  separator.className = 'context-menu-separator';
  separator.setAttribute('role', 'separator');
  return separator;
}

// Ligne d'en-tête (non cliquable) : ce que le menu vise (nom du fichier, ou nombre de photos).
function menuHeader(text, title = '') {
  const header = document.createElement('div');
  header.className = 'context-menu-header';
  header.setAttribute('role', 'presentation');
  header.textContent = text;
  if (title) header.title = title;
  return header;
}

// Entrée de sous-menu décorée : `swatch` (classes d'une pastille de couleur), `glyph` + `glyphClass` (symbole coloré), `labelClass`, `ariaLabel`,
// `checked` (valeur déjà posée sur toutes les photos visées : repère ✓). Les entrées sans décoration restent de simples boutons.
function submenuEntry(item) {
  if (item.separator) return menuSeparator();
  if (item.heading) {
    const heading = document.createElement('div');
    heading.className = 'context-menu-heading';
    heading.setAttribute('role', 'presentation');
    heading.textContent = item.heading;
    return heading;
  }
  const button = menuButton(item.label, item.onSelect, { danger: Boolean(item.danger), shortcut: item.shortcut, disabled: Boolean(item.disabled), title: item.title });
  if (!(item.swatch || item.glyph || item.labelClass || item.checked !== undefined)) return button;
  button.classList.add('decorated');
  button.textContent = '';
  if (item.swatch) {
    const swatch = document.createElement('span');
    swatch.className = `context-menu-swatch ${item.swatch}`;
    swatch.setAttribute('aria-hidden', 'true');
    button.append(swatch);
  }
  if (item.glyph) {
    const glyph = document.createElement('span');
    glyph.className = `context-menu-glyph ${item.glyphClass || ''}`;
    glyph.textContent = item.glyph;
    glyph.setAttribute('aria-hidden', 'true');
    button.append(glyph);
  }
  const text = document.createElement('span');
  text.className = item.labelClass || '';
  text.textContent = item.label;
  button.append(text);
  if (item.ariaLabel) {
    button.setAttribute('aria-label', item.ariaLabel);
    button.title = item.ariaLabel;
  }
  if (item.checked !== undefined) {
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(item.checked));
    button.classList.toggle('checked', item.checked);
  }
  return button;
}

// Sous-menu : `items` = [{ label, onSelect, … }] (voir submenuEntry) ou { separator: true }.
function buildSubmenuItem(label, items) {
  const wrapper = document.createElement('div');
  wrapper.className = 'context-menu-sub';
  const trigger = menuButton(label, null);
  trigger.classList.add('has-submenu');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  const submenu = document.createElement('div');
  submenu.className = 'context-submenu';
  submenu.setAttribute('role', 'menu');
  submenu.append(...items.map(submenuEntry));
  wrapper.append(trigger, submenu);
  trigger.addEventListener('click', () => setSubmenuExpanded(wrapper, !wrapper.classList.contains('open')));
  wrapper.addEventListener('mouseenter', () => setSubmenuExpanded(wrapper, true));
  wrapper.addEventListener('mouseleave', () => setSubmenuExpanded(wrapper, false));
  return wrapper;
}

// Sous-menu « Diaporama » (plein écran) : lancer / arrêter, boucle, ordre aléatoire et durée entre les photos. Les mêmes réglages sont dans
// Paramètres > Général. Pendant la lecture, une ligne Pause / Reprendre s'ajoute.
function buildSlideshowItem() {
  const settings = getSlideshowSettings();
  const active = isSlideshowActive();
  const items = [
    active
      ? { label: t('Stop'), onSelect: () => stopSlideshow() }
      : { label: t('Start'), shortcut: 'F10', onSelect: startSlideshow },
  ];
  if (active) items.push({ label: isSlideshowPaused() ? t('Resume') : t('Pause'), shortcut: t('Space Key'), onSelect: toggleSlideshowPause });
  items.push(
    { separator: true },
    { label: t('Loop'), checked: settings.loop, onSelect: () => setSlideshowOption('loop', !settings.loop) },
    { label: t('Random order'), checked: settings.random, onSelect: () => setSlideshowOption('random', !settings.random) },
    { separator: true },
    ...SLIDESHOW_DELAYS.map(seconds => ({ label: t('Delay: {seconds} s', { seconds }), checked: settings.delay === seconds, onSelect: () => setSlideshowOption('delay', seconds) })),
  );
  return buildSubmenuItem(t('Slideshow'), items);
}

// Sous-menu « Marquage » : note, couleur et fanion pick (ces deux derniers seulement s'ils sont activés dans les Paramètres) de `targets`,
// la valeur déjà commune à toutes les photos visées étant cochée. Un clic sur la valeur cochée l'efface (comme les raccourcis).
function buildMarkingItem(targets) {
  const marking = api.marking;
  if (!marking) return null;
  const all = (read, value) => targets.every(photo => read(photo) === value);
  const items = [{ label: t('No rating'), checked: all(photo => photo.rating || 0, 0), onSelect: () => marking.setRating(targets, 0) }];
  for (let rating = 1; rating <= 5; rating++) {
    items.push({
      label: '★'.repeat(rating),
      labelClass: 'context-menu-stars',
      ariaLabel: rating === 1 ? t('Set 1 star') : t(`Set ${rating} stars`),
      checked: all(photo => photo.rating || 0, rating),
      onSelect: () => marking.setRating(targets, rating),
    });
  }
  const colors = marking.colors();
  if (colors.length) {
    items.push({ separator: true });
    items.push({ label: t('No color'), checked: all(photo => photo.color_flag || 'none', 'none'), onSelect: () => marking.setColor(targets, 'none') });
    for (const color of colors) {
      items.push({
        label: t(color.label),
        swatch: `flag-indicator flag-${color.key}`,
        checked: all(photo => photo.color_flag || 'none', color.key),
        onSelect: () => marking.setColor(targets, color.key),
      });
    }
  }
  const picks = marking.picks();
  if (picks.length) {
    items.push({ separator: true });
    for (const pick of picks) {
      items.push({
        label: t(pick.label),
        glyph: '⚑',
        glyphClass: `pick-${pick.key}`,
        checked: all(photo => photo.pick_flag || 'none', pick.key),
        onSelect: () => marking.setPick(targets, pick.key),
      });
    }
  }
  return buildSubmenuItem(t('Labels'), items);
}

// Entries of the duplicate search, `spec` = { scope, label, compareWithLibrary } handed to main.js (section DUPLICATES). The quick entries use the settings
// saved in the "details" window; their tooltip says which ones. `short`: labels without the word "duplicates" (the submenu already says it).
function duplicateEntries(spec, short) {
  return [
    { label: t(short ? 'Identical' : 'Identical duplicates'), onSelect: () => api.findDuplicates('identical', spec),
      title: `${t('Same image data (or file name)')}
${t('Saved settings: {list}', { list: describeIdenticalSettings(getIdenticalSettings()) })}` },
    { label: t(short ? 'Similar' : 'Similar duplicates'), onSelect: () => api.findDuplicates('similar', spec),
      title: `${t('Photos that look alike: resized, recompressed, lightly edited')}
${t('Saved settings: {list}', { list: describeSimilarSettings(getSimilarSettings()) })}` },
    { label: t(short ? 'Details…' : 'Duplicates: details…'), onSelect: () => api.openDuplicatesDialog(spec),
      title: t('Choose the kind of search, its settings (file name, sensitivity, bursts…) and where to search') },
  ];
}

// Without a RAW to look for (folder, "All photos", selection, a RAW or a video): the duplicates are the only way to find, so no "Find" level.
function buildDuplicatesItem(spec) {
  return buildSubmenuItem(t('Find duplicates'), duplicateEntries(spec, true));
}

// Sous-menu « Visages » (détection activée dans les Paramètres) : `scope` = { folder } ou { photoIds }, transmis à la fenêtre de lancement (faces-panel.js).
// `source` : 'preview' ou 'fullscreen' pour le menu d'une photo affichée (où existent les zones : ajouter un visage, modes et zones écartées) ;
// sans, dans la grille et pour un dossier, le sous-menu ne propose que la reconnaissance (et l'effacement pour des photos).
function buildFacesItem(scope, { source } = {}) {
  const items = [];
  const faces = api.faces;
  if (faces && (source === 'preview' || source === 'fullscreen')) {
    const display = faces.getDisplay();
    const hidden = display.mode === 'hidden';
    items.push(
      { label: t('Add a new face'), shortcut: 'Alt+V', onSelect: () => faces.startDrawing() },
      { separator: true },
      { heading: t('Areas') },
      ...[['always', 'Always'], ['hover', 'On hover'], ['hidden', 'Hidden']].map(([mode, label]) => ({
        label: t(label), checked: display.mode === mode, onSelect: () => faces.setMode(mode),
      })),
      { separator: true },
      { heading: t('Also show') },
      { label: t('Ignored areas'), checked: display.ignored, disabled: hidden, onSelect: () => faces.setExtra('ignored', !display.ignored) },
      { label: t('Not a face areas'), checked: display.notFace, disabled: hidden, onSelect: () => faces.setExtra('notFace', !display.notFace) },
      { separator: true },
    );
  }
  items.push(
    { label: t('Recognize (all photos)'), onSelect: () => api.openFaceScan({ ...scope, onlyUnscanned: false }) },
    { label: t('Recognize (unscanned photos)'), onSelect: () => api.openFaceScan({ ...scope, onlyUnscanned: true }) },
  );
  // Sélection : effacer ses données de visages (base et fichiers), après confirmation.
  if (scope.photoIds) items.push({ separator: true }, { label: t('Erase face data…'), danger: true, onSelect: () => api.eraseFaces(scope.photoIds) });
  return buildSubmenuItem(t('Faces'), items);
}

// « Ouvrir avec » : programmes de la section du fichier (Paramètres), dans leur ordre, puis toujours « Choisir… » en fin de liste.
function buildOpenWithItem(targets, section) {
  const wrapper = document.createElement('div');
  wrapper.className = 'context-menu-sub';
  const trigger = menuButton(t('Open with'), null);
  trigger.classList.add('has-submenu');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  const submenu = document.createElement('div');
  submenu.className = 'context-submenu';
  submenu.setAttribute('role', 'menu');
  const programs = loadPrograms(section);
  for (const program of programs) submenu.append(menuButton(program.name, () => openWith(program.path, targets, program.name)));
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

let thumbnailMenuToken = 0; // a newer right-click supersedes a menu still waiting for the analysed ids

async function openThumbnailMenu(event, index, source = 'grid') {
  closeContextMenu();
  const token = ++thumbnailMenuToken;
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

  // Content search on: which photos of the target are already analysed (decides the "Analyse content" entry). Read before the menu is built.
  let analysedIds = null;
  if (api.semanticEnabled?.() && api.getAnalysedIds) {
    analysedIds = await api.getAnalysedIds();
    if (token !== thumbnailMenuToken) return;
  }

  // Vérifie si la sélection contient au moins une photo (les vidéos ne sont pas redimensionnables)
  const hasResizablePhotos = targets.some(target => !isVideoPath(target.path));

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  // Quatre blocs séparés : en-tête et marquage, actions sur les fichiers, outils et ouvertures, puis la suppression (toujours en dernier).
  const menuItems = [];
  // Plein écran : « Diaporama » en tête du menu (le lancement depuis la grille se fait par F10).
  if (source === 'fullscreen') menuItems.push(buildSlideshowItem(), menuSeparator());
  menuItems.push(
    targets.length > 1
      ? menuHeader(tp('{count} photo selected', targets.length))
      : menuHeader(photoName(photo), photo.path),
  );
  const markingItem = buildMarkingItem(targets);
  if (markingItem) menuItems.push(markingItem, menuSeparator());
  menuItems.push(
    menuButton(t('Show info'), () => showPhotoInfo(photo), { shortcut: 'I' }),
    menuButton(t('Copy'), () => copyPhotosToClipboard(targets), { shortcut: 'Ctrl+C' }),
    menuButton(t('Copy to…'), () => copyPhotosTo(targets), { shortcut: 'C' }),
  );
  // Un renommage vise un seul fichier : absent d'une sélection multiple.
  if (targets.length === 1) menuItems.push(menuButton(t('Rename…'), () => renamePhoto(photo), { shortcut: 'F2' }));

  // L'option « Redimensionner… » n'apparaît que pour les photos réelles
  if (hasResizablePhotos) {
    menuItems.push(menuButton(t('Resize…'), () => resizePhotos(targets), { shortcut: 'S' }));
  }
  // "Turn >" (lossless rotation: orientation tag only). Absent when no target can be turned (HEIC / HEIF, videos); a multiple selection
  // shows how many photos will be turned.
  const rotatable = api.isRotatablePath ? targets.filter(target => api.isRotatablePath(target.path)) : [];
  if (rotatable.length) {
    const rotateLabel = targets.length > 1 ? `${t('Turn')} (${rotatable.length})` : t('Turn');
    menuItems.push(buildSubmenuItem(rotateLabel, [
      { label: t('Turn right'), shortcut: 'Ctrl+R', onSelect: () => api.rotatePhotos(rotatable, 1) },
      { label: t('Turn left'), shortcut: 'Shift+R', onSelect: () => api.rotatePhotos(rotatable, -1) },
      { label: t('Turn 180°'), onSelect: () => api.rotatePhotos(rotatable, 2) },
    ]));
  }
  menuItems.push(
    menuSeparator(),
    menuButton(t('Show in file explorer'), () => revealInFileManager(photo), { shortcut: 'E' }),
  );
  // "All photos" with a single photo: jump to the folder that holds it (same navigation as the results views, see showPhotoInItsFolder in main.js).
  if (targets.length === 1 && api.isAllPhotosView?.() && api.showInItsFolder) {
    menuItems.push(menuButton(t('Show in its own folder'), () => api.showInItsFolder(photo)));
  }
  menuItems.push(
    buildOpenWithItem(targets, programSection(photo.path)),
  );
  // « Trouver le RAW » : une image raster à la fois ; grisé tant qu'aucun critère n'est coché (Paramètres > Divers > RAW).
  // Grille de résultats de « Trouver le RAW » : sortir de la recherche et ouvrir le dossier du fichier, sans filtre.
  if (api.showInItsFolder && api.isRawSearchActive() && targets.length === 1) {
    menuItems.push(menuButton(t('Show in its folder'), () => api.showInItsFolder(photo), { title: t('Leave the search and show this file in its folder, without any filter') }));
  }
  // « Trouver » : le RAW d'une image raster seule (grisé tant qu'aucun critère n'est coché), puis les doublons de la sélection (une photo seule est
  // cherchée dans toute la photothèque, une sélection aussi). Sans RAW à chercher, seul le sous-menu des doublons reste.
  const duplicateSpec = hasResizablePhotos && api.findDuplicates ? {
    scope: { kind: 'paths', paths: targets.filter(target => !isVideoPath(target.path)).map(target => target.path) },
    label: targets.length > 1 ? tp('{count} photo selected', targets.length) : photoName(photo),
    compareWithLibrary: true,
  } : null;
  const rawEntry = api.findRaw && targets.length === 1 && !isRawPath(photo.path) && !isVideoPath(photo.path) ? (() => {
    const available = api.canFindRaw();
    return {
      label: 'RAW', onSelect: () => api.findRaw(photo), disabled: !available,
      title: available ? t('Find the RAW file of this image with the criteria set in Settings > Misc > RAW') : t('Tick at least one criterion in Settings > Misc > RAW'),
    };
  })() : null;
  // Content search (entries absent while the feature is off or its model is not installed). One "content" entry in the "Find" submenu:
  // - one photo already analysed: "Similar content" (it needs the analysis);
  // - one photo not analysed: "Analyse content" in its place (nothing to search with yet);
  // - several photos: "Analyse content" with the number of photos still to analyse, hidden when all are analysed.
  // `analysedIds` unknown (null): the photo is assumed analysed, so the search stays available.
  const semanticOn = Boolean(api.semanticEnabled?.());
  const notAnalysed = analysedIds ? targets.filter(target => !analysedIds.has(target.id)).length : 0;
  let contentEntry = null;
  if (semanticOn && targets.length === 1 && notAnalysed === 0) {
    contentEntry = {
      label: t('Similar content'), onSelect: () => api.findSimilarContent(photo),
      title: t('Search the photos that look like this one: same subject or scene'),
    };
  } else if (semanticOn && notAnalysed > 0) {
    contentEntry = {
      label: notAnalysed < targets.length ? `${t('Analyse content')} (${notAnalysed})` : t('Analyse content'),
      onSelect: () => api.analyseContent({ photoIds: targets.map(target => target.id) }),
      title: t('Compute the content analysis of these photos (low priority, in the background)'),
    };
  }
  const findGroups = [];
  if (rawEntry) findGroups.push([rawEntry]);
  if (duplicateSpec) {
    // With a "content" group next to them, the duplicates get a heading and short labels (the heading says "Duplicates").
    findGroups.push(contentEntry
      ? [{ heading: t('Duplicates') }, ...duplicateEntries(duplicateSpec, true)]
      : duplicateEntries(duplicateSpec, false));
  }
  if (contentEntry) findGroups.push(duplicateSpec ? [{ heading: t('Content') }, contentEntry] : [contentEntry]);
  if (findGroups.length > 1) {
    const findItems = findGroups.flatMap((group, groupIndex) => (groupIndex ? [{ separator: true }, ...group] : group));
    menuItems.push(buildSubmenuItem(t('Find'), findItems));
  } else if (duplicateSpec) menuItems.push(buildDuplicatesItem(duplicateSpec));
  else if (rawEntry) menuItems.push(menuButton(t('Find the RAW'), rawEntry.onSelect, { disabled: rawEntry.disabled, title: rawEntry.title }));
  // Alone (e.g. a video): no submenu to join.
  else if (contentEntry) menuItems.push(menuButton(contentEntry.label, contentEntry.onSelect, { title: contentEntry.title }));
  if (hasResizablePhotos && api.faceDetectionEnabled?.()) {
    menuItems.push(buildFacesItem({ photoIds: targets.filter(target => !isVideoPath(target.path)).map(target => target.id) }, { source }));
  }
  // The "Suggested" badge of the keyword filter (content search on; grid only: the selection is then the photo under the click).
  if (semanticOn && source === 'grid' && targets.length === 1) {
    for (const entry of api.guessedKeywordEntries?.(photo) ?? []) menuItems.push(menuButton(entry.label, entry.onSelect, { title: entry.title }));
  }
  // Géolocalisation (geo-tools.js) : restaurer les coordonnées sauvegardées, effacer celles des photos géolocalisées (danger).
  const withCount = (label, list) => (targets.length > 1 ? `${label} (${list.length})` : label);
  const erased = targets.filter(target => api.hasErasedLocation?.(target));
  const located = targets.filter(target => Number.isFinite(target.gps_lat) && Number.isFinite(target.gps_lon));
  if (erased.length || located.length) menuItems.push(menuSeparator());
  if (erased.length) menuItems.push(menuButton(withCount(t('Restore geolocation'), erased), () => api.restoreGeolocation(erased)));
  if (located.length) menuItems.push(menuButton(withCount(t('Erase geolocation…'), located), () => api.eraseGeolocation(located), { danger: true }));
  // Album manuel affiché : retrait de l'album (les fichiers restent où ils sont), distinct de la suppression qui suit.
  const manualAlbum = api.getCurrentManualAlbum?.();
  if (manualAlbum) {
    menuItems.push(menuSeparator(), menuButton(withCount(t('Remove from album "{name}"', { name: manualAlbum.name }), targets), () => api.removeFromAlbum(targets)));
  }
  menuItems.push(
    menuSeparator(),
    menuButton(targets.length > 1 ? `${t('Delete')} (${targets.length})` : t('Delete'), () => confirmAndDelete(targets), { danger: true, shortcut: t('Delete Key') }),
  );
  menu.append(...menuItems);
  showContextMenu(menu, event);
}

// Seconde alerte à la suppression d'un dossier : liste des fichiers non catalogués qu'il contient. Focus sur « Annuler », par sécurité.
function confirmUnrecognizedFilesDialog(folderName, files) {
  const listContainer = document.createElement('div');
  listContainer.className = 'unrecognized-files-list';
  const ul = document.createElement('ul');
  for (const file of files) {
    const li = document.createElement('li');
    li.textContent = file;
    li.title = file;
    ul.appendChild(li);
  }
  listContainer.appendChild(ul);
  return confirmDialog({
    title: t('Non-cataloged files detected'),
    message: tp('The folder “{folder}” contains {count} file not managed by photoboggan. These files will also be deleted:', files.length, { folder: folderName }),
    confirmLabel: t('Delete anyway'),
    cancelLabel: t('Cancel'),
    content: listContainer,
    focusCancel: true,
    cardClass: 'unrecognized-files-card',
  });
}

// Supprime un dossier de l'arborescence : première confirmation habituelle,
// puis seconde confirmation détaillée si des fichiers inconnus (textes, PDF, formats non gérés...) s'y trouvent.
async function confirmAndDeleteFolder(path) {
  const permanent = (await countPermanentDeletions([path])) > 0;
  const name = baseName(path);
  // Dossier vide (aucun fichier, même caché) : le message n'évoque pas de contenu à perdre. En cas d'échec de la vérification, message complet.
  const empty = await invoke('is_folder_empty', { path }).catch(() => false);
  const confirmed = await confirmDialog({
    title: permanent ? t('Confirm permanent deletion') : t('Confirm deletion'),
    message: empty
      ? t(permanent ? 'Permanently delete the empty folder “{name}”? This storage has no trash (USB drive or network).' : 'Move the empty folder “{name}” to the trash?', { name })
      : permanent
        ? t('Permanently delete folder “{name}” and everything it contains (subfolders and files)? This storage has no trash (USB drive or network): it cannot be undone.', { name })
        : t('Move folder “{name}” and everything it contains (subfolders and files) to the trash?', { name }),
    confirmLabel: t('Yes'),
    cancelLabel: t('No'),
    // Dossier non vide : « Ouvrir » permet de voir son contenu dans l'explorateur avant de décider.
    ...(empty ? {} : { extraLabel: t('Open'), onExtra: () => openFolderInFileManager(path) }),
  });
  if (!confirmed) return;
  // Vérification de la présence de fichiers non gérés par photoboggan. Si elle échoue, la suppression n'a pas lieu : ces fichiers (documents…)
  // partiraient sans avoir été montrés à l'utilisateur.
  let unrecognized;
  try {
    unrecognized = await invoke('get_folder_unrecognized_files', { path });
  } catch (error) {
    console.error('Unrecognized files check failed:', error);
    api.showToast(t('Folder not deleted: its content could not be checked ({error})', { error: String(error) }));
    return;
  }
  if (Array.isArray(unrecognized) && unrecognized.length > 0) {
    const secondConfirm = await confirmUnrecognizedFilesDialog(name, unrecognized);
    if (!secondConfirm) return;
  }
  await api.deleteFolder(path, { permanent });
}

// Menu de l'arborescence des dossiers (clic droit sur un dossier suivi ou l'un de ses sous-dossiers).
function openFolderMenu(event, folderItem) {
  closeContextMenu();
  const path = folderItem.dataset.folderPath;
  if (!path) return;
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  // Un dossier suivi (racine de l'arborescence, ajouté dans les Paramètres) ne se renomme ni ne se supprime depuis ce menu : seuls ses sous-dossiers.
  // Ces deux lignes restent affichées, grisées, avec une infobulle qui renvoie aux Paramètres.
  const isRoot = folderItem.dataset.folderRoot === '1';
  const count = api.folderPhotoCount?.(path);
  // Trois groupes : gestes courants (ouvrir, créer, renommer), maintenance (relire, intégrité, visages), suppression.
  menu.append(
    menuHeader(count === undefined ? baseName(path) : `${baseName(path)} · ${tp('{count} photo', count)}`, path),
    menuButton(t('Open folder in file explorer'), () => openFolderInFileManager(path), { title: t('Show this folder in the file explorer') }),
    menuButton(t('New subfolder…'), () => createSubfolder(path), { title: t('Create a folder inside this one') }),
    menuButton(t('Rename folder…'), () => renameFolder(path), {
      disabled: isRoot,
      title: isRoot ? t('Tracked folder: change it in Settings > Library') : t('Rename this folder on disk'),
    }),
    menuSeparator(),
    menuButton(t('Rescan folder data'), () => api.rescanFolder(path), { title: t('Read the files of this folder again to update the list and the metadata') }),
    menuButton(t('Integrity check'), () => api.checkFolderIntegrity(path), { title: t('Check that the files of this folder can be read (detects corrupted files)') }),
  );
  // "Find": the duplicates of the folder, plus (content search on) the analysis of this folder, with or without its subfolders. Same layout as the
  // photo menu; without content search it stays the plain "Find duplicates" submenu.
  const folderDuplicates = api.findDuplicates
    ? { scope: { kind: 'folder', path, recursive: true }, label: baseName(path), compareWithLibrary: true }
    : null;
  if (folderDuplicates && api.semanticEnabled?.()) {
    menu.append(buildSubmenuItem(t('Find'), [
      { heading: t('Duplicates') },
      ...duplicateEntries(folderDuplicates, true),
      { separator: true },
      { heading: t('Analyse content') },
      { label: t('This folder only'), onSelect: () => api.analyseContent({ folder: path, recursive: false }) },
      { label: t('With its subfolders'), onSelect: () => api.analyseContent({ folder: path, recursive: true }) },
    ]));
  } else if (folderDuplicates) menu.append(buildDuplicatesItem(folderDuplicates));
  if (api.faceDetectionEnabled?.()) menu.append(buildFacesItem({ folder: path }));
  menu.append(
    menuSeparator(),
    menuButton(t('Delete folder…'), () => confirmAndDeleteFolder(path), {
      danger: true,
      disabled: isRoot,
      title: isRoot ? t('Tracked folder: remove it in Settings > Library') : t('Delete this folder and everything it contains (after confirmation)'),
    }),
  );
  contextTarget = folderItem;
  folderItem.classList.add('context-target');
  showContextMenu(menu, event);
}

// Menu de « Toutes les photos » (tête de l'arborescence) : la recherche de doublons sur toute la photothèque.
function openAllPhotosMenu(event, item) {
  closeContextMenu();
  if (!api.findDuplicates) return;
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.append(
    menuHeader(t('All photos')),
    buildDuplicatesItem({ scope: { kind: 'all' }, label: t('All photos'), compareWithLibrary: false }),
  );
  contextTarget = item;
  item.classList.add('context-target');
  showContextMenu(menu, event);
}

// Menu contextuel pour les autres modules (ex. section Personnes, faces-panel.js) : `items` = [{ label, onSelect, danger, title, disabled, shortcut, checked }] (checked : ligne cochable) ;
// un item peut porter `submenu` = [{ label, onSelect }] à la place de `onSelect` pour ouvrir un sous-niveau. { header: 'texte' } ajoute une ligne
// d'en-tête (ce que le menu vise), { separator: true } un séparateur.
export function openContextMenuAt(event, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.append(...items.map(item => {
    if (item.header) return menuHeader(item.header, item.title);
    if (item.separator) return menuSeparator();
    return item.submenu
      ? buildSubmenuItem(item.label, item.submenu)
      : menuButton(item.label, item.onSelect, { danger: Boolean(item.danger), title: item.title, disabled: Boolean(item.disabled), shortcut: item.shortcut, checked: item.checked });
  }));
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

// ==========================================
// MENU DES CHAMPS DE SAISIE
// ==========================================
const NATIVE_MENU_FIELDS = '#description-title, #description-text'; // gardent le menu du navigateur (orthographe)
const isTextField = field => field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && (field.type === 'text' || field.type === 'search'));

// Lignes propres à certains champs (le menu de base est le même partout) : appel d'un bouton voisin, ou champ vidé.
function fieldExtraItems(field) {
  const clickButton = id => () => document.getElementById(id)?.click();
  if (field.id === 'date-filter-input') {
    return [
      { label: t('Pick in calendar'), onSelect: clickButton('date-filter-calendar') },
      { label: t('Clear date filter'), onSelect: clickButton('date-filter-clear') },
    ];
  }
  if (['keyword-filter-input', 'filename-filter-input', 'person-filter-input'].includes(field.id)) {
    return [{
      label: t('Clear the field'),
      disabled: field.value === '',
      onSelect: () => {
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.focus();
      },
    }];
  }
  return [];
}

// Coller : le texte vient du presse-papiers de l'OS (commande Rust), puis est inséré comme une frappe (annulable avec Annuler).
async function pasteIntoField(field) {
  let text = '';
  try {
    text = await invoke('read_clipboard_text');
  } catch {
    try { text = await navigator.clipboard.readText(); } catch { return; }
  }
  if (!text) return;
  field.focus();
  document.execCommand('insertText', false, text);
}

// Menu d'un champ de saisie texte. Le menu prend le focus : chaque action le rend au champ et rétablit la sélection d'avant l'ouverture.
function openTextFieldMenu(event, field) {
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? 0;
  const hasSelection = end > start;
  const editable = !field.readOnly && !field.disabled;
  const act = run => () => {
    field.focus();
    field.setSelectionRange(start, end);
    run();
  };
  const items = [
    { label: t('Undo'), shortcut: 'Ctrl+Z', disabled: !editable, onSelect: act(() => document.execCommand('undo')) },
    { separator: true },
    { label: t('Cut'), shortcut: 'Ctrl+X', disabled: !editable || !hasSelection, onSelect: act(() => document.execCommand('cut')) },
    { label: t('Copy'), shortcut: 'Ctrl+C', disabled: !hasSelection, onSelect: act(() => document.execCommand('copy')) },
    { label: t('Paste'), shortcut: 'Ctrl+V', disabled: !editable, onSelect: act(() => pasteIntoField(field)) },
    { separator: true },
    { label: t('Select all'), shortcut: 'Ctrl+A', disabled: field.value === '', onSelect: act(() => field.select()) },
  ];
  const extras = fieldExtraItems(field);
  if (extras.length) items.push({ separator: true }, ...extras);
  // Menu ouvert au clavier (touche Menu, Maj+F10) : pas de position de souris, il s'ouvre sous le champ.
  const rect = field.getBoundingClientRect();
  const position = event.clientX === 0 && event.clientY === 0 ? { clientX: rect.left, clientY: rect.bottom } : event;
  openContextMenuAt(position, items);
}

// Remplace le menu contextuel du navigateur
// Menu d'actions sur miniatures, aperçu et plein écran.
function onContextMenu(event) {
  const target = event.target instanceof Element ? event.target : null;
  // Champs de saisie : menu Annuler / Couper / Copier / Coller / Tout sélectionner (openTextFieldMenu). Titre et Description gardent le menu du
  // navigateur : il propose les corrections orthographiques, que le code ne peut pas obtenir.
  const field = target?.closest('input, textarea');
  if (field && isTextField(field)) {
    if (field.matches(NATIVE_MENU_FIELDS)) return;
    event.preventDefault();
    openTextFieldMenu(event, field);
    return;
  }
  event.preventDefault();
  if (target?.closest('.context-menu')) return;
  // Section Personnes et vue Personnes : leur menu est ouvert par faces-panel.js (openContextMenuAt).
  if (target?.closest('.person-item, .person-tile')) return;
  // Arborescence des mots-clés : son menu est ouvert par keywords-panel.js (openContextMenuAt).
  if (target?.closest('#keyword-tree')) return;
  // Titre « Dossiers » de la barre latérale : son menu est ouvert par main.js (openContextMenuAt).
  if (target?.closest('#folders-toggle')) return;
  // Section Albums : son menu est ouvert par albums-panel.js (openContextMenuAt).
  if (target?.closest('#albums-section')) return;
  // Panneau carte (mode Carte) : son menu propre est ouvert par map-mode.js, pas celui de la sélection.
  if (target?.closest('#map-panel')) return;

  // Arborescence des dossiers : menu propre aux dossiers (« Toutes les photos » n'en a pas, le menu du navigateur reste simplement masqué).
  const folderItem = target?.closest('#folder-tree .folder-tree-item');
  if (folderItem) {
    if (folderItem.dataset.folderPath) openFolderMenu(event, folderItem);
    else if (folderItem.dataset.allPhotos) openAllPhotosMenu(event, folderItem);
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

// options : getPhotos(), getSelectedIndices(), selectOnly(index), removePhotos(paths), showToast(message, isWriting), rescanFolder(path), checkFolderIntegrity(path), folderCreated(parentPath, name),
// syncLibrary() (relecture des dossiers suivis après la création de fichiers), deleteFolder(path, { permanent }) (suppression d'un dossier de l'arborescence).
export function initPhotoActions(options) {
  api = options;
  // Programs already listed before open_with checked them: allowed once by the backend (ignored once its list exists).
  const listed = [...new Set(Object.values(loadAllPrograms()).flat().map(program => program.path))];
  invoke('register_existing_programs', { paths: listed }).catch(error => console.error('Programs not registered', error));
  document.addEventListener('contextmenu', onContextMenu);
  document.getElementById('btn-add-program')?.addEventListener('click', addProgramFromDialog);
  const sectionSelect = document.getElementById('open-with-section');
  if (sectionSelect) {
    const stored = localStorage.getItem(PROGRAM_SECTION_STORAGE_KEY);
    if (PROGRAM_SECTIONS.includes(stored)) sectionSelect.value = stored;
    sectionSelect.addEventListener('change', () => {
      localStorage.setItem(PROGRAM_SECTION_STORAGE_KEY, sectionSelect.value);
      renderProgramList();
    });
  }
  renderProgramList();
  onLanguageChange(renderProgramList);
}
