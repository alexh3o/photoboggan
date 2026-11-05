// Section « Albums » du panneau de gauche : arborescence d'albums virtuels (dossiers virtuels, albums manuels, albums intelligents), qui n'existent que
// dans la base (albums.rs). Gère l'arbre (création, renommage, suppression, déplacement et copie par glisser-déposer) et le contenu des albums
// manuels (ajout, remplacement, retrait : enregistrés immédiatement). L'enregistrement des filtres d'un album intelligent vient à l'étape suivante.
import './albums.css';
import { invoke } from '@tauri-apps/api/core';
import { t, onLanguageChange } from './i18n.js';
import { openContextMenuAt, promptDialog, createModal, confirmDialog } from './photo-actions.js';

const KIND_FOLDER = 'folder';
const KIND_MANUAL = 'manual';
const KIND_SMART = 'smart';
const EXPANDED_STORAGE_KEY = 'albumsExpanded';
const COLLAPSED_STORAGE_KEY = 'albumsCollapsed';
const DRAG_THRESHOLD = 5; // px parcourus avant que le glisser ne démarre (sinon c'est un simple clic)

// Icônes embarquées dans l'application (jeu Lucide : « images » pour les albums, « book-image » pour les dossiers virtuels), aucun accès réseau.
const ICONS = {
  [KIND_FOLDER]: '<path d="m20 13.7-2.1-2.1a2 2 0 0 0-2.8 0L9.7 17"/><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><circle cx="10" cy="8" r="2"/>',
  [KIND_MANUAL]: '<path d="M18 22H4a2 2 0 0 1-2-2V6"/><path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18"/><circle cx="12" cy="8" r="2"/><rect width="16" height="16" x="6" y="2" rx="2"/>',
};
// Album intelligent : l'icône « image » (Lucide) réduite, avec un entonnoir (Lucide « funnel », filtres enregistrés) en bas à droite.
ICONS[KIND_SMART] = '<g transform="translate(0.3 0.3) scale(0.9)"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></g>'
  + '<g transform="translate(11.6 11.6) scale(0.5)" fill="currentColor" stroke-width="3.2"><path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/></g>';
// Disquette (Lucide « save ») de l'enregistrement des filtres d'un album intelligent.
const SAVE_ICON = '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>';
const OVERWRITE_WARNING_KEY = 'albumOverwriteWarning'; // « false » : ne plus demander confirmation avant d'écraser un album intelligent

let host = null; // fonctions fournies par main.js (voir initAlbumsPanel)
let nodes = []; // arbre à plat, tel que renvoyé par get_album_tree
let expanded = new Set(readJson(EXPANDED_STORAGE_KEY));
let selectedId = 0; // album affiché dans la grille (0 : aucun)
let counts = new Map(); // id -> nombre de photos calculé par main.js (voir setAlbumCounts)
let selectedDirty = false; // l'album intelligent affiché a des filtres modifiés, pas encore enregistrés

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
}
function saveExpanded() {
  try { localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...expanded])); } catch { /* mémorisation facultative */ }
}

const list = () => document.getElementById('albums-list');
const nodeById = id => nodes.find(node => node.id === id);
const childrenOf = parentId => nodes.filter(node => node.parent_id === parentId)
  // Dossiers virtuels d'abord, puis les albums, chacun par ordre alphabétique.
  .sort((a, b) => (a.kind === KIND_FOLDER ? 0 : 1) - (b.kind === KIND_FOLDER ? 0 : 1) || a.name.localeCompare(b.name));

// Les messages d'erreur du backend sont des clés de traduction.
const errorText = error => t(String(error?.message ?? error));

// ==========================================
// RÈGLES DE PARENTÉ (miroir de albums.rs, qui reste l'arbitre)
// ==========================================
// Un dossier virtuel ou la racine accepte tout ; un album ne contient que des albums intelligents.
function canContain(parent, kind) {
  return !parent || parent.kind === KIND_FOLDER || kind === KIND_SMART;
}
function isSelfOrDescendant(id, candidateId) {
  for (let current = candidateId, guard = 0; current && guard < 10000; current = nodeById(current)?.parent_id, guard++) {
    if (current === id) return true;
  }
  return false;
}
// Pourquoi cette cible (nœud ou racine = 0) ne peut pas recevoir ce nœud : clé de traduction, ou null si elle le peut.
function dropRefusal(node, targetId) {
  if (isSelfOrDescendant(node.id, targetId)) return 'An item cannot be dropped into itself or into what it contains';
  const target = nodeById(targetId);
  if (canContain(target, node.kind)) return null;
  return target.kind === KIND_MANUAL ? 'A manual album can only contain smart albums' : 'A smart album can only contain smart albums';
}

// ==========================================
// AFFICHAGE
// ==========================================
function iconElement(kind) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '16');
  icon.setAttribute('height', '16');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  icon.classList.add('album-icon', `album-icon-${kind}`);
  icon.innerHTML = ICONS[kind];
  return icon;
}

function kindLabel(kind) {
  return t(kind === KIND_FOLDER ? 'Virtual folder' : kind === KIND_MANUAL ? 'Manual album' : 'Smart album');
}

function renderNode(node, depth, parent) {
  const li = document.createElement('li');
  li.className = `folder-tree-item album-item album-${node.kind}${node.id === selectedId ? ' active' : ''}`;
  li.dataset.albumId = String(node.id);
  li.style.paddingLeft = `${10 + depth * 16}px`;
  li.title = kindLabel(node.kind);
  const hasChildren = nodes.some(child => child.parent_id === node.id);
  const isOpen = expanded.has(node.id);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'folder-tree-toggle';
  toggle.textContent = hasChildren ? (isOpen ? '▾' : '▸') : ' ';
  toggle.setAttribute('aria-label', t(isOpen ? 'Collapse folder' : 'Expand folder'));
  toggle.addEventListener('click', event => {
    event.stopPropagation();
    if (isOpen) expanded.delete(node.id); else expanded.add(node.id);
    saveExpanded();
    render();
  });
  // Pas de glisser démarré depuis le chevron.
  toggle.addEventListener('pointerdown', event => event.stopPropagation());
  const label = document.createElement('span');
  label.className = 'folder-tree-name';
  label.textContent = node.name;
  li.append(toggle, iconElement(node.kind), label);
  // Disquette : l'album intelligent ouvert a des modifications de filtres non enregistrées.
  if (node.id === selectedId && node.kind === KIND_SMART && selectedDirty) {
    const save = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    save.setAttribute('viewBox', '0 0 24 24');
    save.setAttribute('width', '16');
    save.setAttribute('height', '16');
    save.setAttribute('fill', 'none');
    save.setAttribute('stroke', 'currentColor');
    save.setAttribute('stroke-width', '2');
    save.setAttribute('stroke-linecap', 'round');
    save.setAttribute('stroke-linejoin', 'round');
    save.innerHTML = SAVE_ICON;
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'album-save';
    saveButton.title = t('Save changes');
    saveButton.setAttribute('aria-label', t('Save changes'));
    saveButton.append(save);
    saveButton.addEventListener('click', event => { event.stopPropagation(); host?.saveActiveAlbum?.(); });
    saveButton.addEventListener('pointerdown', event => event.stopPropagation());
    li.append(saveButton);
  }
  // Compteur calculé par main.js (albums intelligents, dossiers virtuels), sinon celui de la base (albums manuels).
  const shown = counts.has(node.id) ? counts.get(node.id) : node.count;
  if (shown != null) {
    const count = document.createElement('span');
    count.className = 'folder-tree-count';
    count.textContent = String(shown);
    li.append(count);
  }
  li.addEventListener('click', () => selectAlbum(node.id));
  li.addEventListener('contextmenu', event => openNodeMenu(event, node));
  li.addEventListener('pointerdown', event => startDrag(event, node));
  parent.append(li);
  if (isOpen) for (const child of childrenOf(node.id)) renderNode(child, depth + 1, parent);
}

function render() {
  const element = list();
  if (!element) return;
  element.replaceChildren();
  const roots = childrenOf(0);
  for (const root of roots) renderNode(root, 0, element);
  if (!roots.length) {
    const empty = document.createElement('li');
    empty.className = 'albums-empty';
    empty.textContent = t('No album yet. Right-click here to create one.');
    element.append(empty);
  }
}

export async function refreshAlbums() {
  try {
    nodes = await invoke('get_album_tree');
  } catch (error) {
    nodes = [];
    host?.showToast(errorText(error));
  }
  render();
  host?.onTreeChanged?.(); // l'arbre ou le contenu a changé : compteurs à recalculer
  // Un album supprimé ne reste pas affiché : la grille revient au dossier courant.
  if (selectedId && !nodeById(selectedId)) {
    selectedId = 0;
    selectedDirty = false;
    render();
    host?.onSelectionChange?.();
  }
}

// Le bloc Albums est-il déplié ? (les compteurs calculés ne le sont que dans ce cas)
export const isAlbumsSectionExpanded = () => document.getElementById('albums-list')?.hidden === false;

// Compteur d'un seul album (celui qui est ouvert, dont la grille donne le nombre exact sans calcul) ; redessine seulement si la valeur change.
export function setAlbumCount(id, count) {
  if (counts.get(id) === count) return;
  counts = new Map(counts).set(id, count);
  render();
}

// Arbre à plat (copie en lecture seule), pour les calculs de main.js.
export const getAlbumNodes = () => nodes;

// Compteurs des albums intelligents et des dossiers virtuels (id -> nombre), calculés par main.js d'après les filtres et le contenu des albums manuels.
export function setAlbumCounts(map) {
  counts = map;
  render();
}

// Album affiché dans la grille (nœud à jour), ou null.
export function getSelectedAlbum() {
  return selectedId ? nodeById(selectedId) ?? null : null;
}

// Sélection : une seule entrée active dans toute la barre latérale. Un dossier virtuel n'a pas de contenu : le clic l'ouvre ou le replie seulement.
async function selectAlbum(id) {
  const node = nodeById(id);
  if (!node) return;
  if (node.kind === KIND_FOLDER) {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    saveExpanded();
    render();
    return;
  }
  // Quitter un album intelligent modifié pour un autre : Enregistrer / Abandonner / Annuler.
  if (id !== selectedId && !(await confirmLeaveAlbum())) return;
  if (id !== selectedId) selectedDirty = false;
  selectedId = id;
  render();
  host?.onSelectionChange?.();
}

// ==========================================
// ALBUMS INTELLIGENTS : CONTEXTE, ÉTAT MODIFIÉ, GARDE DE SORTIE
// ==========================================
function parseFilters(text) {
  try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}

// Ce dont un album intelligent hérite de ses ancêtres : filtres des albums intelligents parents (du plus éloigné au plus proche, lecture seule)
// et, si un album manuel est son ancêtre, ce dernier comme ensemble de départ (baseManualId). own : ses propres critères enregistrés.
export function getAlbumContext(id) {
  const node = nodeById(id);
  const inherited = [];
  let baseManualId = 0;
  for (let parent = node && nodeById(node.parent_id); parent; parent = nodeById(parent.parent_id)) {
    if (parent.kind === KIND_SMART) inherited.unshift({ name: parent.name, state: parseFilters(parent.filters) });
    else { if (parent.kind === KIND_MANUAL) baseManualId = parent.id; break; }
  }
  return { inherited, baseManualId, own: node ? parseFilters(node.filters) : {} };
}

// main.js signale que les filtres de l'album intelligent ouvert diffèrent (ou non) de l'état enregistré : la disquette apparaît ou disparaît.
export function setAlbumDirty(dirty) {
  if (selectedDirty === dirty) return;
  selectedDirty = dirty;
  render();
}

export const isSelectedAlbumDirty = () => selectedDirty && getSelectedAlbum()?.kind === KIND_SMART;

// Avant de quitter l'album intelligent ouvert (autre album, dossier, fermeture) : s'il a des modifications, Enregistrer / Abandonner / Annuler.
// Renvoie vrai si l'on peut continuer (enregistré ou abandonné), faux pour rester dans l'album.
export async function confirmLeaveAlbum() {
  const album = getSelectedAlbum();
  if (!album || !isSelectedAlbumDirty()) return true;
  const choice = await new Promise(resolve => {
    let answer = 'cancel';
    const modal = createModal({ title: t('Unsaved changes'), cardClass: 'confirm-card', onClose: () => resolve(answer) });
    const text = document.createElement('p');
    text.className = 'confirm-message';
    text.textContent = t('The filters of the smart album "{name}" have been modified. Save the changes?', { name: album.name });
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const button = (label, value, className = '') => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      if (className) element.className = className;
      element.addEventListener('click', () => { answer = value; modal.close(); });
      return element;
    };
    const save = button(t('Save'), 'save', 'btn-primary');
    actions.append(button(t('Cancel'), 'cancel'), button(t('Discard'), 'discard'), save);
    modal.body.append(text, actions);
    save.focus();
  });
  if (choice === 'save') return Boolean(await host?.saveActiveAlbum?.());
  if (choice === 'discard') { selectedDirty = false; return true; }
  return false;
}

// « Enregistrer la vue actuelle dans cet album » : écrase les critères de l'album ; confirmation, désactivable (« ne plus afficher »).
async function saveViewInto(album) {
  let ask = true;
  try { ask = localStorage.getItem(OVERWRITE_WARNING_KEY) !== 'false'; } catch { /* sans mémorisation, on demande toujours */ }
  if (ask) {
    const label = document.createElement('label');
    label.className = 'confirm-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    label.append(checkbox, document.createTextNode(` ${t('Do not show this again')}`));
    const confirmed = await confirmDialog({
      title: t('Save current view'),
      message: t('Replace the filters of the smart album "{name}" with those of the current view?', { name: album.name }),
      confirmLabel: t('Replace'),
      cancelLabel: t('Cancel'),
      focusCancel: true,
      content: label,
    });
    if (!confirmed) return;
    if (checkbox.checked) { try { localStorage.setItem(OVERWRITE_WARNING_KEY, 'false'); } catch { /* facultatif */ } }
  }
  await host?.saveCurrentViewInto?.(album.id);
}

// ==========================================
// CONTENU DES ALBUMS MANUELS (enregistré immédiatement, sans bouton)
// ==========================================
// Après un changement : compteurs à jour, et grille rechargée si l'album affiché est l'un de ceux modifiés.
async function contentChanged(...albumIds) {
  await refreshAlbums();
  if (albumIds.includes(selectedId)) host?.onSelectionChange?.();
}

// Toast avec bouton « Annuler » : `undo` défait l'opération (ajout, retrait ou déplacement), sans fichier touché.
function toastWithUndo(message, undo) {
  host?.showToast(message, {
    label: t('Undo'),
    onClick: async () => {
      try {
        await undo();
      } catch (error) {
        host?.showToast(errorText(error));
      }
    },
  });
}

const addToAlbum = (albumId, photoIds) => invoke('add_photos_to_album', { albumId, photoIds }); // renvoie les ids réellement ajoutés
const removeFromAlbum = (albumId, photoIds) => invoke('remove_photos_from_album', { albumId, photoIds });

// Ajoute des photos (ids du catalogue) à un album manuel et l'annonce en toast, avec « Annuler » (qui ne retire que ce qui vient d'être ajouté).
export async function addPhotosToAlbum(albumId, photoIds) {
  const album = nodeById(albumId);
  if (!album || !photoIds.length) return;
  try {
    const addedIds = await addToAlbum(albumId, photoIds);
    const skipped = photoIds.length - addedIds.length;
    const message = skipped > 0
      ? t('{added} added to "{name}" ({skipped} already there)', { added: addedIds.length, name: album.name, skipped })
      : t('{added} added to "{name}"', { added: addedIds.length, name: album.name });
    if (addedIds.length) {
      toastWithUndo(message, async () => {
        await removeFromAlbum(albumId, addedIds);
        await contentChanged(albumId);
      });
    } else {
      host?.showToast(message);
    }
  } catch (error) {
    host?.showToast(errorText(error));
  }
  await contentChanged(albumId);
}

// Déplace des photos d'un album manuel vers un autre : ajout à la cible, puis retrait de la source (le toast propose d'annuler les deux).
export async function movePhotosToAlbum(fromId, toId, photoIds) {
  const from = nodeById(fromId);
  const to = nodeById(toId);
  if (!from || !to || fromId === toId || !photoIds.length) return;
  try {
    const addedIds = await addToAlbum(toId, photoIds);
    await removeFromAlbum(fromId, photoIds);
    toastWithUndo(t('{count} moved from "{from}" to "{to}"', { count: photoIds.length, from: from.name, to: to.name }), async () => {
      await removeFromAlbum(toId, addedIds); // seulement ce que le déplacement avait ajouté
      await addToAlbum(fromId, photoIds);
      await contentChanged(fromId, toId);
    });
  } catch (error) {
    host?.showToast(errorText(error));
  }
  await contentChanged(fromId, toId);
}

async function replaceAlbumContent(album, photoIds) {
  const confirmed = await confirmDialog({
    title: t('Replace content'),
    message: t('Replace the {old} photos of "{name}" with the {count} selected photos?', { old: album.count ?? 0, name: album.name, count: photoIds.length }),
    confirmLabel: t('Replace'),
    cancelLabel: t('Cancel'),
    focusCancel: true,
  });
  if (!confirmed) return;
  try {
    await invoke('replace_album_photos', { albumId: album.id, photoIds });
  } catch (error) {
    host?.showToast(errorText(error));
  }
  await contentChanged(album.id);
}

// « Retirer de l'album » (menu d'une photo de la grille) : les photos quittent l'album affiché, les fichiers ne sont pas touchés.
export async function removePhotosFromSelectedAlbum(photoIds) {
  const album = getSelectedAlbum();
  if (!album || album.kind !== KIND_MANUAL || !photoIds.length) return;
  try {
    await removeFromAlbum(album.id, photoIds);
    toastWithUndo(t('{count} removed from "{name}"', { count: photoIds.length, name: album.name }), async () => {
      await addToAlbum(album.id, photoIds);
      await contentChanged(album.id);
    });
  } catch (error) {
    host?.showToast(errorText(error));
  }
  await contentChanged(album.id);
}

// Rouvre un album quitté un instant (retour de « Trouver le RAW ») : sélection seule, sans confirmation ni rechargement de la grille,
// main.js recharge ensuite lui-même. Sans effet si l'album a disparu.
export function restoreAlbumSelection(id) {
  if (!nodeById(id) || id === selectedId) return;
  selectedId = id;
  selectedDirty = false;
  render();
}

// Appelée par main.js quand l'utilisateur revient à un dossier du disque.
export function clearAlbumSelection() {
  if (!selectedId) return;
  selectedId = 0;
  selectedDirty = false;
  render();
}

// ==========================================
// CRÉATION, RENOMMAGE, SUPPRESSION
// ==========================================
const NEW_TITLES = { [KIND_FOLDER]: 'New virtual folder', [KIND_MANUAL]: 'New manual album', [KIND_SMART]: 'New smart album' };

async function createNode(parentId, kind) {
  let createdId = 0;
  const saved = await promptDialog({
    title: t(NEW_TITLES[kind]),
    message: t('Name:'),
    inputLabel: t('Name'),
    confirmLabel: t('Create'),
    cancelLabel: t('Cancel'),
    onSubmit: async name => {
      try {
        createdId = await invoke('create_album_node', { parentId, kind, name });
        return null;
      } catch (error) {
        return errorText(error);
      }
    },
  });
  if (!saved) return;
  if (parentId) expanded.add(parentId); // le parent s'ouvre pour montrer le nouvel élément
  saveExpanded();
  await refreshAlbums();
  if (kind === KIND_SMART) showSmartAlbumHelp();
}

function showSmartAlbumHelp() {
  const modal = createModal({ title: t('Smart album'), cardClass: 'confirm-card' });
  const text = document.createElement('p');
  text.className = 'confirm-message';
  text.textContent = t('A smart album is a saved set of filters. It is empty at first. To define it, select it and set your filters: a save icon appears next to its name. You can also set filters, then right-click the album and choose "Save current view in this album".');
  const actions = document.createElement('div');
  actions.className = 'confirm-actions';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'btn-primary';
  ok.textContent = t('OK');
  ok.addEventListener('click', modal.close);
  actions.append(ok);
  modal.body.append(text, actions);
  ok.focus();
}

async function renameNode(node) {
  await promptDialog({
    title: t('Rename'),
    message: t('Name:'),
    inputLabel: t('Name'),
    confirmLabel: t('Rename'),
    cancelLabel: t('Cancel'),
    value: node.name,
    onSubmit: async name => {
      try {
        await invoke('rename_album_node', { id: node.id, name });
        return null;
      } catch (error) {
        return errorText(error);
      }
    },
  });
  await refreshAlbums();
}

function descendantCount(id) {
  return nodes.filter(node => node.parent_id === id).reduce((sum, child) => sum + 1 + descendantCount(child.id), 0);
}

async function deleteNode(node) {
  const inside = descendantCount(node.id);
  const message = inside > 0
    ? t('Delete "{name}" and the {count} items it contains? The photos themselves are not deleted.', { name: node.name, count: inside })
    : t('Delete "{name}"? The photos themselves are not deleted.', { name: node.name });
  const confirmed = await confirmDialog({ title: t('Delete'), message, confirmLabel: t('Delete'), cancelLabel: t('Cancel'), focusCancel: true });
  if (!confirmed) return;
  try {
    await invoke('delete_album_node', { id: node.id });
  } catch (error) {
    host?.showToast(errorText(error));
  }
  await refreshAlbums();
}

// ==========================================
// MENUS CONTEXTUELS
// ==========================================
// Entrées « créer » proposées sous un parent (0 : racine) : un album n'accepte que des albums intelligents.
function createItems(parent) {
  const parentId = parent?.id ?? 0;
  const smart = { label: t('New smart album…'), onSelect: () => createNode(parentId, KIND_SMART) };
  if (parent && parent.kind !== KIND_FOLDER) return [smart];
  return [
    { label: t('New virtual folder…'), onSelect: () => createNode(parentId, KIND_FOLDER) },
    { label: t('New manual album…'), onSelect: () => createNode(parentId, KIND_MANUAL) },
    smart,
  ];
}

// Entrées d'un album manuel qui agissent sur la sélection de la grille (grisées quand rien n'est sélectionné).
function selectionItems(album) {
  const ids = host?.getSelectedPhotoIds?.() ?? [];
  const none = ids.length === 0;
  const title = none ? t('Select photos in the grid first') : undefined;
  return [
    { label: none ? t('Add selection to this album') : t('Add selection to this album ({count})', { count: ids.length }), disabled: none, title, onSelect: () => addPhotosToAlbum(album.id, ids) },
    { label: t('Replace content with selection…'), disabled: none, danger: true, title, onSelect: () => replaceAlbumContent(album, ids) },
  ];
}

// Entrées d'un album intelligent : enregistrer les modifications de l'album ouvert (grisé sans modification), ou écraser ses critères par la vue actuelle.
function smartItems(album) {
  const modified = album.id === selectedId && isSelectedAlbumDirty();
  return [
    { label: t('Save changes'), disabled: !modified, title: modified ? undefined : t('No unsaved changes'), onSelect: () => host?.saveActiveAlbum?.() },
    { label: t('Save current view in this album…'), onSelect: () => saveViewInto(album) },
  ];
}

function openNodeMenu(event, node) {
  event.preventDefault();
  event.stopPropagation();
  // Un album manuel n'a pas d'enfant : aucune création n'est possible dessous ; il propose à la place d'y verser la sélection de la grille.
  const creatable = node.kind === KIND_MANUAL ? [{ header: node.name }, ...selectionItems(node)]
    : node.kind === KIND_SMART ? [{ header: node.name }, ...createItems(node), { separator: true }, ...smartItems(node)]
    : [{ header: node.name }, ...createItems(node)];
  openContextMenuAt(event, [
    ...creatable,
    ...(creatable.length > 1 ? [{ separator: true }] : []),
    { label: t('Rename…'), onSelect: () => renameNode(node) },
    { label: t('Delete…'), danger: true, onSelect: () => deleteNode(node) },
  ]);
}

function openBackgroundMenu(event) {
  if (event.target.closest('.album-item')) return;
  event.preventDefault();
  openContextMenuAt(event, [{ header: t('Albums') }, ...createItems(null)]);
}

// Bouton « + » de l'en-tête : le même menu de création, à la racine, sous le bouton.
function openAddMenu(event) {
  event.stopPropagation();
  const box = event.currentTarget.getBoundingClientRect();
  openContextMenuAt({ clientX: box.left, clientY: box.bottom, preventDefault() {}, stopPropagation() {} }, [{ header: t('Albums') }, ...createItems(null)]);
}

// ==========================================
// GLISSER-DÉPOSER (déplacement et copie dans l'arbre)
// ==========================================
let drag = null;

function startDrag(event, node) {
  if (event.button !== 0) return;
  drag = { node, startX: event.clientX, startY: event.clientY, active: false, ghost: null, targetId: null, valid: false };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('keydown', onDragKey, true);
}

function onDragKey(event) {
  if (event.key === 'Escape') stopDrag();
}

function targetUnder(event) {
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('.album-item');
  if (row) return { id: Number(row.dataset.albumId), element: row };
  // Vide de la section Albums : la racine.
  const section = document.elementFromPoint(event.clientX, event.clientY)?.closest('#albums-section');
  return section ? { id: 0, element: section } : null;
}

function onDragMove(event) {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return;
    drag.active = true;
    drag.ghost = document.createElement('div');
    drag.ghost.className = 'album-drag-ghost';
    drag.ghost.append(iconElement(drag.node.kind), Object.assign(document.createElement('span'), { textContent: drag.node.name }));
    drag.reason = Object.assign(document.createElement('div'), { className: 'album-drag-reason', hidden: true });
    drag.ghost.append(drag.reason);
    document.body.append(drag.ghost);
    document.body.classList.add('dragging-photos');
  }
  drag.ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
  drag.ghost.classList.toggle('copy', event.ctrlKey);
  document.querySelectorAll('#albums-section .drop-target, #albums-section .drop-refused').forEach(element => element.classList.remove('drop-target', 'drop-refused'));
  const target = targetUnder(event);
  drag.targetId = target?.id ?? null;
  const refusal = target ? dropRefusal(drag.node, target.id) : null;
  drag.valid = Boolean(target) && !refusal;
  if (target) target.element.classList.add(drag.valid ? 'drop-target' : 'drop-refused');
  // Le curseur « interdit » ne dit pas pourquoi : la raison s'affiche sous l'image glissée.
  drag.reason.hidden = !refusal;
  drag.reason.textContent = refusal ? t(refusal) : '';
}

async function onDragEnd(event) {
  const current = drag;
  stopDrag();
  if (!current?.active || !current.valid) return;
  const copy = event.ctrlKey;
  const move = event.shiftKey;
  // Ctrl ou Maj : action directe ; sinon on demande ce que l'utilisateur veut faire.
  let choice = copy ? 'copy' : move ? 'move' : await askMoveOrCopy(current.node);
  if (!choice) return;
  // Un déplacement vers le parent actuel ne change rien.
  if (choice === 'move' && current.node.parent_id === current.targetId) return;
  try {
    if (choice === 'copy') await invoke('copy_album_node', { id: current.node.id, newParentId: current.targetId, suffix: t('copy') });
    else await invoke('move_album_node', { id: current.node.id, newParentId: current.targetId });
    if (current.targetId) { expanded.add(current.targetId); saveExpanded(); }
  } catch (error) {
    host?.showToast(errorText(error));
  }
  await refreshAlbums();
}

function stopDrag() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('keydown', onDragKey, true);
  drag?.ghost?.remove();
  document.body.classList.remove('dragging-photos');
  document.querySelectorAll('#albums-section .drop-target, #albums-section .drop-refused').forEach(element => element.classList.remove('drop-target', 'drop-refused'));
  // Le clic qui suivrait le relâchement ne doit pas sélectionner l'élément glissé.
  if (drag?.active) {
    const swallow = event => { event.stopPropagation(); event.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
  }
  drag = null;
}

// Question Déplacer / Copier / Annuler. Renvoie 'move', 'copy' ou null.
function askMoveOrCopy(node) {
  return new Promise(resolve => {
    let answer = null;
    const modal = createModal({ title: t('Move or copy'), cardClass: 'confirm-card', onClose: () => resolve(answer) });
    const text = document.createElement('p');
    text.className = 'confirm-message';
    text.textContent = t('Move or copy "{name}"? (Shift + drag moves, Ctrl + drag copies, without asking)', { name: node.name });
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const button = (label, value, className = '') => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      if (className) element.className = className;
      element.addEventListener('click', () => { answer = value; modal.close(); });
      return element;
    };
    const cancel = button(t('Cancel'), null);
    const copy = button(t('Copy'), 'copy');
    const move = button(t('Move'), 'move', 'btn-primary');
    actions.append(cancel, copy, move);
    modal.body.append(text, actions);
    move.focus();
  });
}

// ==========================================
// INITIALISATION
// ==========================================
function applyCollapsed() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true'; } catch { /* sans mémorisation */ }
  const toggle = document.getElementById('albums-toggle');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.querySelector('.sidebar-block-chevron').textContent = collapsed ? '▸' : '▾';
  document.getElementById('albums-list').hidden = collapsed;
  document.getElementById('albums-add').hidden = collapsed; // le bouton « + » n'a de sens que bloc ouvert
  document.getElementById('albums-section').classList.toggle('collapsed', collapsed);
}

// `options` : showToast(message), onSelectAlbum(node | null).
export function initAlbumsPanel(options) {
  host = options;
  document.getElementById('albums-add').addEventListener('click', openAddMenu);
  // Paramètres : confirmation avant d'écraser les filtres d'un album intelligent. La case reflète le réglage, que « Ne plus afficher » (dans la
  // confirmation) peut avoir changé depuis : elle est relue à l'ouverture des Paramètres.
  const warningToggle = document.getElementById('album-overwrite-warning-toggle');
  const syncWarningToggle = () => {
    try { warningToggle.checked = localStorage.getItem(OVERWRITE_WARNING_KEY) !== 'false'; } catch { warningToggle.checked = true; }
  };
  warningToggle.addEventListener('change', () => {
    try {
      if (warningToggle.checked) localStorage.removeItem(OVERWRITE_WARNING_KEY); else localStorage.setItem(OVERWRITE_WARNING_KEY, 'false');
    } catch { /* facultatif */ }
  });
  document.getElementById('btn-open-settings')?.addEventListener('click', syncWarningToggle);
  syncWarningToggle();
  document.getElementById('albums-toggle').addEventListener('click', () => {
    const collapsed = document.getElementById('albums-list').hidden;
    try { localStorage.setItem(COLLAPSED_STORAGE_KEY, String(!collapsed)); } catch { /* sans mémorisation */ }
    applyCollapsed();
    if (collapsed) host?.onTreeChanged?.(); // le bloc vient de s'ouvrir : compteurs calculés à ce moment-là seulement
  });
  document.getElementById('albums-section').addEventListener('contextmenu', openBackgroundMenu);
  applyCollapsed();
  onLanguageChange(render);
  return refreshAlbums();
}
