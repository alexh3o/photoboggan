// Panneau latéral droit à onglets (Info / Mots-clés) et onglet Mots-clés : arborescence hiérarchique avec cases à trois états.
//
// ÉTAPE 1 (lecture seule) : l'arbre et le nombre de photos de la sélection portant chaque mot-clé viennent de la base (voir keywords.rs) ;
// les cases reflètent la sélection mais ne sont pas encore cliquables. L'édition, l'écriture dans les fichiers et la gestion de
// l'arbre (création, suppression) viennent aux étapes suivantes.
//
// ÉTAPE 2 : cases cliquables, autocomplétion, boutons Appliquer / Réinitialiser / Unifier, écriture dans les fichiers via TaskQueue.
//
// main.js fournit la sélection (initKeywordsPanel) et appelle refreshKeywordsPanel quand elle change.
import './keywords.css';
import { invoke } from '@tauri-apps/api/core';
import { t, tp, onLanguageChange, labelWithColon } from './i18n.js';
import { confirmDialog } from './photo-actions.js';

const TAB_STORAGE_KEY = 'sidePanelTab';
const FILTER_MODE_STORAGE_KEY = 'keywordFilterMode';
const SIDE_TABS = ['info', 'keywords'];
const ROOT_ID = 0; // identifiant du « parent » des mots-clés de premier niveau
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
let host = null; // { getSelectedPhotos, showToast } fourni par main.js
let initialized = false;
let compareActive = false;
const storedTab = localStorage.getItem(TAB_STORAGE_KEY);
let requestedTab = SIDE_TABS.includes(storedTab) ? storedTab : 'info'; // dernier onglet utilisé, retrouvé à l'ouverture du panneau
let filterMode = localStorage.getItem(FILTER_MODE_STORAGE_KEY) === 'assigned' ? 'assigned' : 'all';

// Arbre : nœuds par identifiant, et enfants triés par parent.
let nodeById = new Map();
let childrenOf = new Map();
let treeVersion = 1; // incrémenté quand les fichiers ont pu changer l'arbre (relecture, synchronisation)
let loadedTreeVersion = 0;
// Sélection : nombre de photos sélectionnées portant chaque mot-clé.
let countByKeyword = new Map();
let selectionSize = 0;
const expandedIds = new Set(); // nœuds dépliés en mode « tous les mots-clés »
let reloadToken = 0;
let refreshScheduled = false;

// Suivi de la sélection précédente pour détecter les changements
let previousSelectionIds = null;
let previousSelectionPaths = null;

// État pour gérer le dialogue de changement de sélection
let selectionChangeDialog = null;
let selectionChangeResolve = null;

let exifPanel;
let toggleButton;
let infoTabButton;
let keywordsTabButton;
let infoPane;
let keywordsPane;
let treeList;
let modeButton;
let applyButton;
let resetButton;
let unifyButton;
let autocompleteInput;
let autocompleteList;

// --- État des modifications en attente (dirty state) ---
// Map<keywordId, desiredState> où desiredState ∈ { 'checked', 'empty' }
// 'partial' n'est jamais stocké : il est déduit à la lecture.
const pendingChanges = new Map();

let autocompleteDebounceTimer = null;
let autocompleteQuery = '';
let autocompleteSelectedIndex = -1;

// Onglet réellement affiché : le mode Comparer rend les mots-clés inaccessibles, le panneau Info s'affiche à la place (l'onglet demandé est retrouvé ensuite).
function displayedTab() {
  return compareActive && requestedTab === 'keywords' ? 'info' : requestedTab;
}

function isKeywordsTabVisible() {
  return initialized && !exifPanel.classList.contains('hidden') && displayedTab() === 'keywords';
}

function applyTab() {
  const shown = displayedTab();
  for (const [button, name] of [[infoTabButton, 'info'], [keywordsTabButton, 'keywords']]) {
    button.classList.toggle('active', shown === name);
    button.setAttribute('aria-selected', String(shown === name));
  }
  infoPane.hidden = shown !== 'info';
  keywordsPane.hidden = shown !== 'keywords';
  keywordsTabButton.disabled = compareActive;
  keywordsTabButton.title = compareActive ? t('Keywords panel unavailable in compare mode') : `${t('Keywords')} (K)`;
  infoTabButton.title = `${t('Info')} (J)`;
  if (shown === 'keywords') refreshKeywordsPanel();
}

function setTab(name) {
  if (!SIDE_TABS.includes(name)) return;
  requestedTab = name;
  localStorage.setItem(TAB_STORAGE_KEY, name);
  applyTab();
}

// Raccourcis J (Info) et K (Mots-clés) : si le panneau est masqué, il s'ouvre sur cet onglet ; s'il est affiché sur un autre onglet, il bascule ;
// s'il est déjà sur cet onglet, il se masque (comme l'ancienne touche J). Le bouton Info de la barre d'outils garde son rôle : afficher ou masquer
// le panneau, sur le dernier onglet utilisé.
export function handleSideTabShortcut(name) {
  if (!initialized) return;
  if (name === 'keywords' && compareActive) return;
  const panelVisible = !exifPanel.classList.contains('hidden');
  if (!panelVisible) {
    setTab(name);
    toggleButton.click();
  } else if (displayedTab() === name) {
    toggleButton.click();
  } else {
    setTab(name);
  }
}

// Mode Comparer : l'onglet Mots-clés est inaccessible (s'il était affiché, le panneau Info prend sa place).
export function setKeywordsCompareMode(active) {
  compareActive = active;
  if (initialized) applyTab();
}

// Les fichiers ont pu changer l'arbre (scan, relecture, synchronisation) : il sera relu à la prochaine mise à jour.
export function invalidateKeywordTree() {
  treeVersion += 1;
  if (isKeywordsTabVisible()) refreshKeywordsPanel();
}

// Appelée à chaque changement de sélection : mise à jour différée (une seule par image affichée), uniquement si l'onglet est visible.
export function refreshKeywordsPanel() {
  if (!initialized || refreshScheduled || !isKeywordsTabVisible()) return;
  refreshScheduled = true;
  requestAnimationFrame(() => {
    refreshScheduled = false;
    reloadFromDatabase();
  });
}

async function reloadFromDatabase() {
  const token = ++reloadToken;
  const versionAtStart = treeVersion;
  const needTree = loadedTreeVersion !== versionAtStart;
  const selectedPhotos = host.getSelectedPhotos();
  const photoIds = selectedPhotos.map(photo => photo.id).filter(id => Number.isFinite(id) && id > 0);
  const photoPaths = selectedPhotos.map(photo => photo.path);

  // Détecter un changement de sélection (photos différentes)
  const selectionChanged = previousSelectionIds !== null &&
    photoIds.length > 0 &&
    !arraysEqual(previousSelectionIds, photoIds);

  // Si sélection change avec des modifications en attente, demander confirmation
  if (selectionChanged && pendingChanges.size > 0) {
    // Stocker l'ANCIENNE sélection (celle où les changements ont été faits)
    const oldSelectionIds = previousSelectionIds.slice();
    const oldSelectionPaths = previousSelectionPaths.slice();

    // Vérifier l'option d'application automatique
    const autoApply = host.getAutoApplyKeywordChanges && host.getAutoApplyKeywordChanges();

    if (autoApply) {
      // Application automatique : écrire les changements sur l'ANCIENNE sélection sans dialogue
      await handleApplyOnSelection(oldSelectionPaths);
      // Après Apply, pendingChanges est vidé, on continue le rechargement normal
    } else {
      // Comportement standard : demander confirmation
      const choice = await showSelectionChangeDialog(oldSelectionPaths);
      if (choice === 'cancel') {
        // Annuler : restaurer l'ancienne sélection dans la grille
        if (host.restoreSelection) {
          await host.restoreSelection(oldSelectionIds);
        }
        return;
      } else if (choice === 'apply') {
        // Appliquer : écrire les changements sur l'ANCIENNE sélection
        await handleApplyOnSelection(oldSelectionPaths);
        // Après Apply, pendingChanges est vidé, on continue le rechargement normal
      } else if (choice === 'ignore') {
        // Ignorer : jeter les modifications en attente
        pendingChanges.clear();
        updateActionButtonsState();
      }
    }
    // Dans tous les cas, mettre à jour previousSelectionIds pour éviter les boucles
    previousSelectionIds = photoIds.slice();
    previousSelectionPaths = photoPaths.slice();
  } else {
    // Pas de changement de sélection ou pas de modifications en attente
    previousSelectionIds = photoIds.slice();
    previousSelectionPaths = photoPaths.slice();
  }

  try {
    const [nodes, counts] = await Promise.all([
      needTree ? invoke('get_keyword_tree') : null,
      photoIds.length ? invoke('get_keyword_counts', { photoIds }) : [],
    ]);
    if (token !== reloadToken) return; // une mise à jour plus récente est en cours
    if (nodes) {
      buildTree(nodes);
      loadedTreeVersion = versionAtStart;
    }
    countByKeyword = new Map(counts.map(item => [item.keyword_id, item.count]));
    selectionSize = photoIds.length;
    // Réinitialiser les modifications en attente si la sélection change (sélection vide)
    if (selectionSize === 0) {
      pendingChanges.clear();
    }
    updateActionButtonsState();
    renderTree();
    updateAutocompletePlaceholder();
  } catch (error) {
    console.error('Lecture des mots-clés impossible', error);
  }
}

// Compare deux tableaux d'identifiants
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Affiche le dialogue de changement de sélection avec 3 choix
function showSelectionChangeDialog(oldSelectionPaths) {
  return new Promise((resolve) => {
    // Créer l'overlay modal
    const overlay = document.createElement('div');
    overlay.className = 'modal';

    const card = document.createElement('div');
    card.className = 'modal-card confirm-card';
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('role', 'dialog');

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `<h3>${t('Pending changes')}</h3>`;

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.innerHTML = `<p>${t('You have pending keyword changes. Apply them before changing selection?')}</p>`;

    const actions = document.createElement('div');
    actions.className = 'modal-header-actions';
    actions.style.justifyContent = 'center';
    actions.style.gap = '0.5rem';
    actions.style.padding = '1rem';
    actions.style.borderTop = '1px solid var(--border)';

    const applyBtn = document.createElement('button');
    applyBtn.className = 'keyword-action-btn keyword-action-apply';
    applyBtn.textContent = t('Apply');
    applyBtn.addEventListener('click', () => {
      overlay.remove();
      // Appliquer sur l'ancienne sélection
      handleApplyOnSelection(oldSelectionPaths).then(() => resolve('apply'));
    });

    const ignoreBtn = document.createElement('button');
    ignoreBtn.className = 'keyword-action-btn keyword-action-reset';
    ignoreBtn.textContent = t('Ignore');
    ignoreBtn.addEventListener('click', () => {
      overlay.remove();
      resolve('ignore');
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'keyword-action-btn';
    cancelBtn.textContent = t('Cancel');
    cancelBtn.addEventListener('click', () => {
      overlay.remove();
      resolve('cancel');
    });

    actions.append(applyBtn, ignoreBtn, cancelBtn);
    body.appendChild(actions);
    card.append(header, body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Fermer sur Échap ou clic hors modal
    const closeOnEscape = (e) => {
      if (e.key === 'Escape') {
        overlay.removeEventListener('keydown', closeOnEscape);
        overlay.remove();
        resolve('cancel');
      }
    };
    overlay.addEventListener('keydown', closeOnEscape);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.removeEventListener('keydown', closeOnEscape);
        overlay.remove();
        resolve('cancel');
      }
    });

    // Focus sur le bouton Annuler par défaut
    cancelBtn.focus();
  });
}

// Recharge uniquement la structure de l'arbre (nodeById) depuis la base, sans toucher aux compteurs locaux.
// Utile après l'écriture de mots-clés pour récupérer les nouveaux mots-clés créés.
async function reloadKeywordTreeOnly() {
  const versionAtStart = treeVersion;
  try {
    const nodes = await invoke('get_keyword_tree');
    buildTree(nodes);
    loadedTreeVersion = versionAtStart;
    renderTree();
    updateAutocompletePlaceholder();
  } catch (error) {
    console.error('Rechargement arbre mots-clés impossible', error);
  }
}

function buildTree(nodes) {
  nodeById = new Map(nodes.map(node => [node.id, node]));
  childrenOf = new Map();
  for (const node of nodes) {
    // Un parent inconnu (ne devrait pas arriver) rattache le nœud au premier niveau plutôt que de le perdre.
    const parentId = node.parent_id === ROOT_ID || nodeById.has(node.parent_id) ? node.parent_id : ROOT_ID;
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
    childrenOf.get(parentId).push(node);
  }
  for (const siblings of childrenOf.values()) siblings.sort((a, b) => nameCollator.compare(a.name, b.name));
}

function pathLabel(node) {
  const names = [];
  for (let current = node; current; current = nodeById.get(current.parent_id)) names.unshift(current.name);
  return names.join(' › ');
}

// Mots-clés à afficher en mode « attribués » : ceux que porte au moins une photo de la sélection, avec leurs ancêtres pour garder la hiérarchie.
// Inclut aussi les mots-clés avec des changements en attente (pendingChanges).
function assignedVisibleIds() {
  const visible = new Set();
  // Mots-clés avec count > 0 dans la base
  for (const [keywordId, count] of countByKeyword) {
    if (!(count > 0)) continue;
    for (let current = nodeById.get(keywordId); current && !visible.has(current.id); current = nodeById.get(current.parent_id)) visible.add(current.id);
  }
  // Mots-clés avec changements en attente (ajoutés via autocomplete ou cases cochées)
  for (const [keywordId, state] of pendingChanges) {
    if (state === 'checked') {
      for (let current = nodeById.get(keywordId); current && !visible.has(current.id); current = nodeById.get(current.parent_id)) visible.add(current.id);
    }
  }
  return visible;
}

function effectiveState(keywordId) {
  // Si un changement est en attente pour ce mot-clé, on l'affiche
  if (pendingChanges.has(keywordId)) {
    return pendingChanges.get(keywordId);
  }
  // Sinon, état déduit de la sélection actuelle
  const count = countByKeyword.get(keywordId) || 0;
  if (selectionSize > 0 && count >= selectionSize) return 'checked';
  return count > 0 ? 'partial' : 'empty';
}

// Retourne la liste des ancêtres (parent, grand-parent, etc.) jusqu'à la racine
function getAncestors(keywordId) {
  const ancestors = [];
  let current = nodeById.get(keywordId);
  while (current && current.parent_id !== ROOT_ID) {
    const parent = nodeById.get(current.parent_id);
    if (parent) {
      ancestors.push(parent.id);
      current = parent;
    } else {
      break;
    }
  }
  return ancestors;
}

// Retourne la liste de tous les descendants (enfants, petits-enfants, etc.)
function getDescendants(keywordId) {
  const descendants = [];
  const children = childrenOf.get(keywordId) || [];
  for (const child of children) {
    descendants.push(child.id);
    descendants.push(...getDescendants(child.id));
  }
  return descendants;
}

// Applique un état à un mot-clé et met à jour pendingChanges
function setKeywordState(keywordId, state) {
  if (selectionSize === 0) return;
  const currentState = effectiveState(keywordId);
  // Ne rien faire si l'état est déjà le même
  if (currentState === state) return;
  // Cycle : checked → empty → checked
  // Si l'état effectif est 'partial', on passe à 'checked' (toutes les photos sélectionnées l'auront)
  let newState = state;
  if (state === 'toggle') {
    if (currentState === 'checked') newState = 'empty';
    else newState = 'checked';
  }
  pendingChanges.set(keywordId, newState);
  // Si on repasse à l'état original (plus de diff), on nettoie
  const originalState = (() => {
    const count = countByKeyword.get(keywordId) || 0;
    if (selectionSize > 0 && count >= selectionSize) return 'checked';
    return count > 0 ? 'partial' : 'empty';
  })();
  if (newState === originalState) {
    pendingChanges.delete(keywordId);
  }
}

// Gère le clic sur un mot-clé (avec ou sans Shift)
function handleKeywordClick(keywordId, shiftPressed) {
  if (selectionSize === 0) return;
  const currentState = effectiveState(keywordId);
  const isActivating = currentState !== 'checked'; // empty ou partial -> checked
  const targetState = isActivating ? 'checked' : 'empty';

  // Appliquer au mot-clé principal
  setKeywordState(keywordId, targetState);

  if (shiftPressed) {
    if (isActivating) {
      // Shift+Activation : activer aussi tous les ancêtres
      const ancestors = getAncestors(keywordId);
      for (const ancestorId of ancestors) {
        setKeywordState(ancestorId, 'checked');
      }
    } else {
      // Shift+Désactivation : désactiver aussi tous les descendants
      const descendants = getDescendants(keywordId);
      for (const descendantId of descendants) {
        setKeywordState(descendantId, 'empty');
      }
    }
  }

  updateActionButtonsState();
  renderTree();
}

function buildCheckbox(state, label) {
  // Utiliser un bouton pour une meilleure accessibilité et gestion du clic
  const box = document.createElement('button');
  box.type = 'button';
  box.className = `keyword-check${state === 'empty' ? '' : ` ${state}`}`;
  box.setAttribute('role', 'checkbox');
  box.setAttribute('aria-checked', state === 'checked' ? 'true' : state === 'partial' ? 'mixed' : 'false');
  box.setAttribute('aria-label', label);
  box.setAttribute('tabindex', '0');
  // Gestion clavier : Espace/Entrée pour basculer
  box.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      box.click();
    }
  });
  return box;
}

function buildNodeRow(node, depth, hasChildren, expanded, togglable) {
  const row = document.createElement('li');
  row.className = 'keyword-row';
  row.dataset.keywordId = String(node.id);
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(depth + 1));
  if (hasChildren) row.setAttribute('aria-expanded', String(expanded));
  row.style.paddingLeft = `${0.25 + depth * 1}rem`;

  // Menu contextuel (clic droit)
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showKeywordContextMenu(e.clientX, e.clientY, node);
  });

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'keyword-toggle';
  if (hasChildren && togglable) {
    toggle.textContent = expanded ? '▾' : '▸';
    toggle.setAttribute('aria-label', t(expanded ? 'Collapse keyword' : 'Expand keyword'));
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (expanded) expandedIds.delete(node.id); else expandedIds.add(node.id);
      renderTree();
    });
  } else {
    toggle.disabled = true;
    toggle.tabIndex = -1;
    toggle.textContent = hasChildren ? '▾' : ' ';
  }

  const checkbox = buildCheckbox(effectiveState(node.id), node.name);
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    handleKeywordClick(node.id, e.shiftKey);
  });
  // Gestion clavier Shift+Entrée/Espace sur la checkbox
  checkbox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleKeywordClick(node.id, e.shiftKey);
    }
  });
  // Clic sur la ligne = bascule aussi (sauf sur le toggle)
  row.addEventListener('click', (e) => {
    if (e.target === toggle || e.target === checkbox) return;
    handleKeywordClick(node.id, e.shiftKey);
  });

  const name = document.createElement('span');
  name.className = 'keyword-name';
  name.textContent = node.name;
  name.title = pathLabel(node);
  row.append(toggle, checkbox, name);
  return row;
}

// Ligne « Racine » : au sommet de l'arbre, ce n'est pas un mot-clé (son menu contextuel viendra avec la gestion de l'arbre).
function buildRootRow() {
  const row = document.createElement('li');
  row.className = 'keyword-row keyword-root';
  row.setAttribute('role', 'presentation');
  const name = document.createElement('span');
  name.className = 'keyword-name';
  name.textContent = t('Root');
  // Menu contextuel sur la racine (créer mot-clé de premier niveau)
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showRootContextMenu(e.clientX, e.clientY);
  });
  row.append(name);
  return row;
}

// --- Menu contextuel mot-clé (clic droit sur un nœud) ---
let contextMenu = null;

function createContextMenu() {
  if (contextMenu) contextMenu.remove();
  contextMenu = document.createElement('div');
  contextMenu.className = 'keyword-context-menu';
  contextMenu.setAttribute('role', 'menu');
  document.body.appendChild(contextMenu);

  // Fermer sur clic hors menu ou Échap
  document.addEventListener('click', closeContextMenu, { once: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); });
}

function closeContextMenu() {
  if (contextMenu) {
    contextMenu.remove();
    contextMenu = null;
  }
}

function showRootContextMenu(x, y) {
  createContextMenu();
  contextMenu.innerHTML = '';
  const createItem = createMenuItem(t('Create top-level keyword'), 'create-root');
  createItem.addEventListener('click', () => {
    closeContextMenu();
    createTopLevelKeyword();
  });
  contextMenu.appendChild(createItem);
  positionContextMenu(x, y);
}

function showKeywordContextMenu(x, y, node) {
  createContextMenu();
  contextMenu.innerHTML = '';

  // Créer un enfant
  const createChildItem = createMenuItem(t('Create child keyword'), 'create-child');
  createChildItem.addEventListener('click', () => {
    closeContextMenu();
    createChildKeyword(node.id);
  });
  contextMenu.appendChild(createChildItem);

  // Renommer
  const renameItem = createMenuItem(t('Rename keyword'), 'rename');
  renameItem.addEventListener('click', () => {
    closeContextMenu();
    renameKeyword(node.id, node.name);
  });
  contextMenu.appendChild(renameItem);

  // Supprimer
  const deleteItem = createMenuItem(t('Delete keyword'), 'delete');
  deleteItem.classList.add('keyword-context-danger');
  deleteItem.addEventListener('click', () => {
    closeContextMenu();
    deleteKeyword(node.id, node.name);
  });
  contextMenu.appendChild(deleteItem);

  positionContextMenu(x, y);
}

function createMenuItem(label, action) {
  const item = document.createElement('div');
  item.className = 'keyword-context-item';
  item.setAttribute('role', 'menuitem');
  item.textContent = label;
  return item;
}

function positionContextMenu(x, y) {
  if (!contextMenu) return;
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
  // S'assurer que le menu reste dans la fenêtre
  requestAnimationFrame(() => {
    if (!contextMenu) return;
    const rect = contextMenu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) contextMenu.style.left = `${vw - rect.width - 4}px`;
    if (rect.bottom > vh) contextMenu.style.top = `${vh - rect.height - 4}px`;
  });
}

async function createChildKeyword(parentId) {
  // Obtenir le chemin du parent pour l'affichage
  const parentNode = nodeById.get(parentId);
  const parentPath = parentNode ? pathLabel(parentNode) : '';
  const newId = await showCreateKeywordModal(parentId, parentPath);
  if (newId) {
    // Invalider l'arbre pour le recharger
    treeVersion += 1;
    invalidateKeywordTree();
    updateActionButtonsState();
    renderTree();
  }
}

async function renameKeyword(keywordId, currentName) {
  const success = await showRenameKeywordModal(keywordId, currentName);
  if (success) {
    treeVersion += 1;
    invalidateKeywordTree();
    updateActionButtonsState();
    renderTree();
  }
}

/**
 * Affiche un modal pour renommer un mot-clé avec autocomplétion et validation
 * @param {number} keywordId - ID du mot-clé à renommer
 * @param {string} currentName - Nom actuel
 * @returns {Promise<boolean>} true si renommé avec succès
 */
async function showRenameKeywordModal(keywordId, currentName) {
  const node = nodeById.get(keywordId);
  if (!node) return false;

  const parentPath = node.parent_id ? pathLabel(nodeById.get(node.parent_id)) : '';

  return new Promise((resolve) => {
    // Créer le modal
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.style.zIndex = '12000';

    const card = document.createElement('div');
    card.className = 'modal-card confirm-card';
    card.style.maxWidth = '40rem';
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('role', 'dialog');

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `<h3>${t('Rename keyword')}</h3>`;

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.style.padding = '1.5rem';

    // Message indiquant le mot-clé actuel et sa hiérarchie
    const currentInfo = document.createElement('p');
    currentInfo.style.marginBottom = '1rem';
    currentInfo.style.color = 'var(--text-dim)';
    currentInfo.style.fontSize = '0.85rem';
    const fullPath = parentPath ? `${parentPath} › ${currentName}` : currentName;
    currentInfo.textContent = `${t('Current:')} ${fullPath}`;
    body.appendChild(currentInfo);

    // Zone de saisie avec autocomplétion
    const inputWrapper = document.createElement('div');
    inputWrapper.style.position = 'relative';
    inputWrapper.style.marginBottom = '1rem';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'prompt-input';
    input.style.width = '100%';
    input.style.padding = '0.5rem 0.75rem';
    input.style.fontSize = '1rem';
    input.value = currentName;
    input.placeholder = t('Enter new name…');
    input.autocomplete = 'off';
    inputWrapper.appendChild(input);

    // Liste d'autocomplétion
    const autocompleteList = document.createElement('ul');
    autocompleteList.className = 'keyword-create-autocomplete';
    autocompleteList.style.display = 'none';
    autocompleteList.style.position = 'absolute';
    autocompleteList.style.top = '100%';
    autocompleteList.style.left = '0';
    autocompleteList.style.right = '0';
    autocompleteList.style.maxHeight = '15rem';
    autocompleteList.style.overflowY = 'auto';
    autocompleteList.style.background = 'var(--card-bg)';
    autocompleteList.style.border = '1px solid var(--control-border)';
    autocompleteList.style.borderRadius = '4px';
    autocompleteList.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    autocompleteList.style.zIndex = '100';
    autocompleteList.style.listStyle = 'none';
    autocompleteList.style.padding = '0.25rem';
    autocompleteList.style.margin = '0';
    autocompleteList.setAttribute('role', 'listbox');
    inputWrapper.appendChild(autocompleteList);

    body.appendChild(inputWrapper);

    // Message d'erreur/doublon
    const errorEl = document.createElement('div');
    errorEl.className = 'prompt-error';
    errorEl.style.minHeight = '1.2rem';
    errorEl.style.marginBottom = '0.75rem';
    errorEl.style.color = '#e74c3c';
    errorEl.style.fontSize = '0.8rem';
    body.appendChild(errorEl);

    const actions = document.createElement('div');
    actions.className = 'modal-header-actions';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '0.5rem';
    actions.style.paddingTop = '0.5rem';
    actions.style.borderTop = '1px solid var(--border)';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = t('Cancel');
    cancelBtn.addEventListener('click', () => {
      overlay.remove();
      resolve(false);
    });

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-primary';
    renameBtn.textContent = t('Rename');
    renameBtn.disabled = true;
    renameBtn.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name || name === currentName) return;

      // Vérifier les doublons
      const parentId = node.parent_id;
      const sameHierarchyDuplicates = findDuplicateKeywordsInHierarchy(name, parentId, keywordId);
      const otherHierarchyDuplicates = findDuplicateKeywordsInOtherHierarchies(name, parentId, keywordId);

      if (sameHierarchyDuplicates.length > 0) {
        // Existe déjà dans la MÊME hiérarchie - empêcher
        errorEl.textContent = t('A keyword with this name already exists in this hierarchy');
        return;
      }

      if (otherHierarchyDuplicates.length > 0) {
        // Existe dans UNE AUTRE hiérarchie - demander confirmation
        const hierarchies = otherHierarchyDuplicates.map(d => pathLabel(d)).join('\n');
        const confirmMsg = `${t('Keyword already exists in other hierarchies:')}\n${hierarchies}\n\n${t('Rename anyway?')}`;
        const confirmed = await confirmDialog({
          title: t('Keyword already exists'),
          message: confirmMsg,
          confirmLabel: t('Rename anyway?'),
          cancelLabel: t('Cancel')
        });
        if (!confirmed) return;
      }

      try {
        await invoke('rename_keyword', { keywordId, name });
        overlay.remove();
        resolve(true);
      } catch (error) {
        console.error('Renommage mot-clé échoué', error);
        errorEl.textContent = t('Keywords write failed: {error}', { error: String(error) });
      }
    });

    actions.append(cancelBtn, renameBtn);
    body.appendChild(actions);
    card.append(header, body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Focus sur l'input et sélectionner le texte
    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);

    // Autocomplétion
    let autocompleteDebounce = null;
    let selectedIndex = -1;

    function updateAutocomplete() {
      clearTimeout(autocompleteDebounce);
      autocompleteDebounce = setTimeout(() => {
        const query = input.value.trim().toLowerCase();
        if (query.length < 3) {
          autocompleteList.style.display = 'none';
          return;
        }

        const matches = [];
        for (const n of nodeById.values()) {
          // Exclure le mot-clé en cours de renommage
          if (n.id === keywordId) continue;
          if (n.name.toLowerCase().includes(query)) {
            matches.push(n);
          }
        }
        // Trier par fréquence puis alphabétique
        matches.sort((a, b) => {
          const countA = countByKeyword.get(a.id) || 0;
          const countB = countByKeyword.get(b.id) || 0;
          if (countB !== countA) return countB - countA;
          return nameCollator.compare(a.name, b.name);
        });

        if (matches.length === 0) {
          autocompleteList.style.display = 'none';
          return;
        }

        autocompleteList.innerHTML = '';
        selectedIndex = -1;
        for (let i = 0; i < Math.min(matches.length, 15); i++) {
          const n = matches[i];
          const item = document.createElement('li');
          item.className = 'keyword-create-autocomplete-item';
          item.setAttribute('role', 'option');
          item.textContent = pathLabel(n);
          item.style.padding = '0.4rem 0.6rem';
          item.style.cursor = 'pointer';
          item.style.borderRadius = '3px';
          item.style.whiteSpace = 'nowrap';
          item.style.overflow = 'hidden';
          item.style.textOverflow = 'ellipsis';
          item.addEventListener('click', () => {
            input.value = n.name;
            autocompleteList.style.display = 'none';
            input.focus();
            validateInput();
          });
          item.addEventListener('mouseenter', () => {
            selectAutocompleteItem(item, i);
          });
          autocompleteList.appendChild(item);
        }
        autocompleteList.style.display = 'block';
      }, 100);
    }

    function selectAutocompleteItem(item, index) {
      const items = autocompleteList.querySelectorAll('.keyword-create-autocomplete-item');
      items.forEach((el, i) => {
        el.style.background = i === index ? 'var(--control-hover)' : 'transparent';
      });
      selectedIndex = index;
    }

    function validateInput() {
      const name = input.value.trim();
      renameBtn.disabled = name.length === 0 || name === currentName;
      if (name.length > 0 && name !== currentName) {
        const parentId = node.parent_id;
        const sameHierarchyDuplicates = findDuplicateKeywordsInHierarchy(name, parentId, keywordId);
        const otherHierarchyDuplicates = findDuplicateKeywordsInOtherHierarchies(name, parentId, keywordId);

        if (sameHierarchyDuplicates.length > 0) {
          errorEl.textContent = t('A keyword with this name already exists in this hierarchy');
        } else if (otherHierarchyDuplicates.length > 0) {
          const hierarchies = otherHierarchyDuplicates.map(d => pathLabel(d)).join('\n');
          errorEl.innerHTML = `${t('Keyword already exists in other hierarchies:')}<br>${hierarchies.replace(/\n/g, '<br>')}`;
        } else {
          errorEl.textContent = '';
        }
      } else {
        errorEl.textContent = '';
      }
    }

    input.addEventListener('input', () => {
      updateAutocomplete();
      validateInput();
    });

    input.addEventListener('keydown', (e) => {
      const items = autocompleteList.querySelectorAll('.keyword-create-autocomplete-item');
      if (items.length === 0) {
        if (e.key === 'Enter' && !renameBtn.disabled) {
          e.preventDefault();
          renameBtn.click();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (selectedIndex < 0) selectedIndex = 0;
          else selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
          selectAutocompleteItem(items[selectedIndex], selectedIndex);
          items[selectedIndex].scrollIntoView({ block: 'nearest' });
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (selectedIndex < 0) selectedIndex = items.length - 1;
          else selectedIndex = Math.max(selectedIndex - 1, 0);
          selectAutocompleteItem(items[selectedIndex], selectedIndex);
          items[selectedIndex].scrollIntoView({ block: 'nearest' });
          break;
        case 'Enter':
          e.preventDefault();
          if (selectedIndex >= 0) {
            const item = items[selectedIndex];
            input.value = item.textContent.split(' › ').pop();
            autocompleteList.style.display = 'none';
            input.focus();
            validateInput();
          } else if (!renameBtn.disabled) {
            renameBtn.click();
          }
          break;
        case 'Escape':
          autocompleteList.style.display = 'none';
          break;
      }
    });

    // Fermer l'autocomplétion sur clic dehors
    document.addEventListener('click', (e) => {
      if (!inputWrapper.contains(e.target)) {
        autocompleteList.style.display = 'none';
      }
    }, { once: false });

    // Fermer sur Échap
    const closeOnEscape = (e) => {
      if (e.key === 'Escape') {
        overlay.removeEventListener('keydown', closeOnEscape);
        overlay.remove();
        resolve(false);
      }
    };
    overlay.addEventListener('keydown', closeOnEscape);

    // Fermer sur clic hors modal
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.removeEventListener('keydown', closeOnEscape);
        overlay.remove();
        resolve(false);
      }
    });
  });
}

/**
 * Trouve les mots-clés avec le même nom dans la MÊME hiérarchie (même parent)
 * @param {string} name - Nom à rechercher
 * @param {number} parentId - ID du parent
 * @param {number} excludeId - ID à exclure (le mot-clé en cours de renommage)
 * @returns {Array} Nœuds correspondants
 */
function findDuplicateKeywordsInHierarchy(name, parentId, excludeId) {
  const key = name.trim().toLowerCase();
  const duplicates = [];
  for (const n of nodeById.values()) {
    if (n.id === excludeId) continue;
    if (n.parent_id === parentId && n.name.toLowerCase() === key) {
      duplicates.push(n);
    }
  }
  return duplicates;
}

/**
 * Trouve les mots-clés avec le même nom dans D'AUTRES hiérarchies (parents différents)
 * @param {string} name - Nom à rechercher
 * @param {number} parentId - ID du parent actuel
 * @param {number} excludeId - ID à exclure
 * @returns {Array} Nœuds correspondants
 */
function findDuplicateKeywordsInOtherHierarchies(name, parentId, excludeId) {
  const key = name.trim().toLowerCase();
  const duplicates = [];
  for (const n of nodeById.values()) {
    if (n.id === excludeId) continue;
    if (n.parent_id !== parentId && n.name.toLowerCase() === key) {
      duplicates.push(n);
    }
  }
  return duplicates;
}

async function deleteKeyword(keywordId, name) {
  const confirmed = await confirmDialog({
    title: t('Delete keyword'),
    message: `${t('Delete keyword')} “${name}” ${t('and all its children?')}`,
    confirmLabel: t('Delete'),
    cancelLabel: t('Cancel')
  });
  if (!confirmed) return;
  try {
    await invoke('delete_keyword', { keywordId });
    // Invalider l'arbre pour le recharger
    treeVersion += 1;
    invalidateKeywordTree();
    updateActionButtonsState();
    renderTree();
  } catch (error) {
    console.error('Suppression mot-clé échouée', error);
    host.showToast(t('Keywords write failed: {error}', { error: String(error) }));
  }
}

// --- Création de mot-clé avec modal personnalisé ---
async function createTopLevelKeyword() {
  const newId = await showCreateKeywordModal(0, '');
  if (newId) {
    treeVersion += 1;
    invalidateKeywordTree();
    updateActionButtonsState();
    renderTree();
  }
}

/**
 * Affiche un modal pour créer un nouveau mot-clé avec autocomplétion et détection de doublons.
 * @param {number} parentId - ID du parent (0 = premier niveau)
 * @param {string} parentPath - Chemin hiérarchique du parent pour l'affichage
 * @returns {Promise<number|null>} ID du mot-clé créé ou null si annulé
 */
async function showCreateKeywordModal(parentId, parentPath) {
  return new Promise((resolve) => {
    // Créer le modal
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.style.zIndex = '12000'; // Au-dessus des autres modales

    const card = document.createElement('div');
    card.className = 'modal-card confirm-card';
    card.style.maxWidth = '40rem';
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('role', 'dialog');

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `<h3>${t('Create a new keyword')}</h3>`;

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.style.padding = '1.5rem';

    // Message indiquant le parent
    const parentInfo = document.createElement('p');
    parentInfo.style.marginBottom = '1rem';
    parentInfo.style.color = 'var(--text-dim)';
    parentInfo.style.fontSize = '0.85rem';
    if (parentPath) {
      parentInfo.textContent = `${t('Parent:')} ${parentPath}`;
    } else {
      parentInfo.textContent = t('Creating a top-level keyword');
    }
    body.appendChild(parentInfo);

    // Zone de saisie avec autocomplétion
    const inputWrapper = document.createElement('div');
    inputWrapper.style.position = 'relative';
    inputWrapper.style.marginBottom = '1rem';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'prompt-input';
    input.style.width = '100%';
    input.style.padding = '0.5rem 0.75rem';
    input.style.fontSize = '1rem';
    input.placeholder = t('Enter keyword name…');
    input.autocomplete = 'off';
    inputWrapper.appendChild(input);

    // Liste d'autocomplétion
    const autocompleteList = document.createElement('ul');
    autocompleteList.className = 'keyword-create-autocomplete';
    autocompleteList.style.display = 'none';
    autocompleteList.style.position = 'absolute';
    autocompleteList.style.top = '100%';
    autocompleteList.style.left = '0';
    autocompleteList.style.right = '0';
    autocompleteList.style.maxHeight = '15rem';
    autocompleteList.style.overflowY = 'auto';
    autocompleteList.style.background = 'var(--card-bg)';
    autocompleteList.style.border = '1px solid var(--control-border)';
    autocompleteList.style.borderRadius = '4px';
    autocompleteList.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    autocompleteList.style.zIndex = '100';
    autocompleteList.style.listStyle = 'none';
    autocompleteList.style.padding = '0.25rem';
    autocompleteList.style.margin = '0';
    autocompleteList.setAttribute('role', 'listbox');
    inputWrapper.appendChild(autocompleteList);

    body.appendChild(inputWrapper);

    // Message d'erreur/doublon
    const errorEl = document.createElement('div');
    errorEl.className = 'prompt-error';
    errorEl.style.minHeight = '1.2rem';
    errorEl.style.marginBottom = '0.75rem';
    errorEl.style.color = '#e74c3c';
    errorEl.style.fontSize = '0.8rem';
    body.appendChild(errorEl);

    const actions = document.createElement('div');
    actions.className = 'modal-header-actions';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '0.5rem';
    actions.style.paddingTop = '0.5rem';
    actions.style.borderTop = '1px solid var(--border)';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = t('Cancel');
    cancelBtn.addEventListener('click', () => {
      overlay.remove();
      resolve(null);
    });

    const createBtn = document.createElement('button');
    createBtn.className = 'btn-primary';
    createBtn.textContent = t('Create');
    createBtn.disabled = true;
    createBtn.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) return;

      // Vérifier les doublons dans TOUTES les hiérarchies
      const duplicates = findDuplicateKeywords(name);
      if (duplicates.length > 0) {
        // Afficher les doublons trouvés avec confirmation personnalisée
        const hierarchies = duplicates.map(d => pathLabel(d)).join('\n');
        const confirmMsg = `${t('Keyword already exists in:')}\n${hierarchies}\n\n${t('Create anyway?')}`;
        const confirmed = await confirmDialog({
          title: t('Keyword already exists'),
          message: confirmMsg,
          confirmLabel: t('Create anyway?'),
          cancelLabel: t('Cancel')
        });
        if (!confirmed) return;
      }

      try {
        const newId = await invoke('create_keyword', { parentId, name });
        // Si une sélection d'images est active, ajouter le mot-clé en attente
        if (selectionSize > 0) {
          pendingChanges.set(newId, 'checked');
          updateActionButtonsState();
        }
        overlay.remove();
        resolve(newId);
      } catch (error) {
        console.error('Création mot-clé échouée', error);
        errorEl.textContent = t('Keywords write failed: {error}', { error: String(error) });
      }
    });

    actions.append(cancelBtn, createBtn);
    body.appendChild(actions);
    card.append(header, body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Focus sur l'input
    setTimeout(() => input.focus(), 50);

    // Autocomplétion
    let autocompleteDebounce = null;
    let selectedIndex = -1;

    function updateAutocomplete() {
      clearTimeout(autocompleteDebounce);
      autocompleteDebounce = setTimeout(() => {
        const query = input.value.trim().toLowerCase();
        if (query.length < 4) {
          autocompleteList.style.display = 'none';
          return;
        }

        const matches = [];
        for (const node of nodeById.values()) {
          if (node.name.toLowerCase().includes(query)) {
            matches.push(node);
          }
        }
        // Trier par fréquence puis alphabétique
        matches.sort((a, b) => {
          const countA = countByKeyword.get(a.id) || 0;
          const countB = countByKeyword.get(b.id) || 0;
          if (countB !== countA) return countB - countA;
          return nameCollator.compare(a.name, b.name);
        });

        if (matches.length === 0) {
          autocompleteList.style.display = 'none';
          return;
        }

        autocompleteList.innerHTML = '';
        selectedIndex = -1;
        for (let i = 0; i < Math.min(matches.length, 15); i++) {
          const node = matches[i];
          const item = document.createElement('li');
          item.className = 'keyword-create-autocomplete-item';
          item.setAttribute('role', 'option');
          item.textContent = pathLabel(node);
          item.style.padding = '0.4rem 0.6rem';
          item.style.cursor = 'pointer';
          item.style.borderRadius = '3px';
          item.style.whiteSpace = 'nowrap';
          item.style.overflow = 'hidden';
          item.style.textOverflow = 'ellipsis';
          item.addEventListener('click', () => {
            input.value = node.name;
            autocompleteList.style.display = 'none';
            input.focus();
            validateInput();
          });
          item.addEventListener('mouseenter', () => {
            selectAutocompleteItem(item, i);
          });
          autocompleteList.appendChild(item);
        }
        autocompleteList.style.display = 'block';
      }, 100);
    }

    function selectAutocompleteItem(item, index) {
      const items = autocompleteList.querySelectorAll('.keyword-create-autocomplete-item');
      items.forEach((el, i) => {
        el.style.background = i === index ? 'var(--control-hover)' : 'transparent';
      });
      selectedIndex = index;
    }

    function validateInput() {
      const name = input.value.trim();
      createBtn.disabled = name.length === 0;
      if (name.length > 0) {
        const duplicates = findDuplicateKeywords(name);
        if (duplicates.length > 0) {
          const hierarchies = duplicates.map(d => pathLabel(d)).join('\n');
          errorEl.innerHTML = `${t('Keyword already exists in:')}<br>${hierarchies.replace(/\n/g, '<br>')}`;
        } else {
          errorEl.textContent = '';
        }
      } else {
        errorEl.textContent = '';
      }
    }

    input.addEventListener('input', () => {
      updateAutocomplete();
      validateInput();
    });

    input.addEventListener('keydown', (e) => {
      const items = autocompleteList.querySelectorAll('.keyword-create-autocomplete-item');
      if (items.length === 0) {
        if (e.key === 'Enter' && !createBtn.disabled) {
          e.preventDefault();
          createBtn.click();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (selectedIndex < 0) selectedIndex = 0;
          else selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
          selectAutocompleteItem(items[selectedIndex], selectedIndex);
          items[selectedIndex].scrollIntoView({ block: 'nearest' });
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (selectedIndex < 0) selectedIndex = items.length - 1;
          else selectedIndex = Math.max(selectedIndex - 1, 0);
          selectAutocompleteItem(items[selectedIndex], selectedIndex);
          items[selectedIndex].scrollIntoView({ block: 'nearest' });
          break;
        case 'Enter':
          e.preventDefault();
          if (selectedIndex >= 0) {
            const item = items[selectedIndex];
            input.value = item.textContent.split(' › ').pop(); // Prendre seulement le nom final
            autocompleteList.style.display = 'none';
            input.focus();
            validateInput();
          } else if (!createBtn.disabled) {
            createBtn.click();
          }
          break;
        case 'Escape':
          autocompleteList.style.display = 'none';
          break;
      }
    });

    // Fermer l'autocomplétion sur clic dehors
    document.addEventListener('click', (e) => {
      if (!inputWrapper.contains(e.target)) {
        autocompleteList.style.display = 'none';
      }
    }, { once: false });

    // Fermer sur Échap
    const closeOnEscape = (e) => {
      if (e.key === 'Escape') {
        overlay.removeEventListener('keydown', closeOnEscape);
        overlay.remove();
        resolve(null);
      }
    };
    overlay.addEventListener('keydown', closeOnEscape);

    // Fermer sur clic hors modal
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.removeEventListener('keydown', closeOnEscape);
        overlay.remove();
        resolve(null);
      }
    });
  });
}

/**
 * Trouve les mots-clés existants avec le même nom DANS TOUTES LES HIÉRARCHIES
 * @param {string} name - Nom du mot-clé à créer
 * @returns {Array} Nœuds correspondants (dans toutes les hiérarchies)
 */
function findDuplicateKeywords(name) {
  const key = name.trim().toLowerCase();
  const duplicates = [];
  for (const node of nodeById.values()) {
    if (node.name.toLowerCase() === key) {
      duplicates.push(node);
    }
  }
  return duplicates;
}

function appendNodeRows(parentId, depth, rows, visibleIds) {
  for (const node of childrenOf.get(parentId) || []) {
    if (visibleIds && !visibleIds.has(node.id)) continue;
    const hasChildren = (childrenOf.get(node.id) || []).some(child => !visibleIds || visibleIds.has(child.id));
    const expanded = visibleIds ? true : expandedIds.has(node.id); // mode « attribués » : tout est déplié
    rows.push(buildNodeRow(node, depth, hasChildren, expanded, !visibleIds));
    if (hasChildren && expanded) appendNodeRows(node.id, depth + 1, rows, visibleIds);
  }
}

function emptyMessage(text) {
  const item = document.createElement('li');
  item.className = 'keyword-empty';
  item.textContent = text;
  return item;
}

function renderTree() {
  if (!initialized) return;
  const rows = [buildRootRow()];
  if (nodeById.size === 0) {
    rows.push(emptyMessage(t('No keyword in the library yet. Rescan the collection (Settings) to read the keywords from your files.')));
  } else if (filterMode === 'assigned') {
    const visibleIds = assignedVisibleIds();
    if (visibleIds.size === 0) rows.push(emptyMessage(t(selectionSize === 0 ? 'No photo selected.' : 'No keyword assigned to the selection.')));
    else appendNodeRows(ROOT_ID, 0, rows, visibleIds);
  } else {
    appendNodeRows(ROOT_ID, 0, rows, null);
  }
  treeList.replaceChildren(...rows);
}

function updateModeButton() {
  modeButton.textContent = t(filterMode === 'all' ? 'All keywords' : 'Assigned keywords');
  modeButton.setAttribute('aria-pressed', String(filterMode === 'assigned'));
  modeButton.title = t('Switch between all keywords and keywords assigned to the selection (Ctrl+K)');
}

// Bouton ou Ctrl+K : tous les mots-clés de la photothèque, ou seulement ceux attribués à la sélection.
function toggleFilterMode() {
  filterMode = filterMode === 'all' ? 'assigned' : 'all';
  localStorage.setItem(FILTER_MODE_STORAGE_KEY, filterMode);
  updateModeButton();
  renderTree();
}

// --- Gestion des modifications en attente ---

// Calcule les chemins de mots-clés actifs pour une photo donnée à partir de pendingChanges + base
function computeActiveKeywordPaths() {
  // Retourne un Map<keywordId, boolean> indiquant si le mot-clé doit être actif après application
  const result = new Map();
  for (const [keywordId, count] of countByKeyword) {
    const originalState = selectionSize > 0 && count >= selectionSize ? 'checked' : count > 0 ? 'partial' : 'empty';
    const pending = pendingChanges.get(keywordId);
    const finalState = pending !== undefined ? pending : originalState;
    result.set(keywordId, finalState === 'checked');
  }
  // Ajouter les mots-clés qui n'étaient pas dans la sélection mais sont ajoutés via pendingChanges
  for (const [keywordId, state] of pendingChanges) {
    if (!result.has(keywordId)) {
      result.set(keywordId, state === 'checked');
    }
  }
  return result;
}

// Construit la liste des chemins hiérarchiques pour l'écriture (uniquement les mots-clés actifs, dernier niveau de chaque branche)
function buildKeywordPathsForWrite() {
  const activeIds = computeActiveKeywordPaths();
  const activeKeywords = [...activeIds.entries()].filter(([, active]) => active).map(([id]) => id);
  const paths = [];
  for (const keywordId of activeKeywords) {
    const segments = [];
    for (let current = nodeById.get(keywordId); current; current = nodeById.get(current.parent_id)) {
      segments.unshift(current.name);
    }
    // On n'écrit que le dernier niveau (le mot-clé actif), mais le chemin complet sert à reconstruire l'arbre côté Rust
    paths.push(segments);
  }
  return paths;
}

function updateActionButtonsState() {
  const hasPending = pendingChanges.size > 0;
  applyButton.disabled = !hasPending;
  resetButton.disabled = !hasPending;
  unifyButton.disabled = selectionSize < 2 || !hasPending; // Unifier n'a de sens que si sélection multiple et changements
}

function updateAutocompletePlaceholder() {
  if (!autocompleteInput) return;
  autocompleteInput.placeholder = selectionSize === 0
    ? t('No photo selected.')
    : t('Choose keyword...');
  autocompleteInput.disabled = selectionSize === 0;
}

// --- État d'écriture (blocage UI) ---
let isWriting = false;

function setWritingState(writing) {
  isWriting = writing;
  applyButton.disabled = writing || pendingChanges.size === 0;
  resetButton.disabled = writing || pendingChanges.size === 0;
  unifyButton.disabled = writing || selectionSize < 2 || pendingChanges.size === 0;
  autocompleteInput.disabled = writing || selectionSize === 0;
  // Désactiver les cases de l'arbre pendant l'écriture
  const checkboxes = treeList.querySelectorAll('.keyword-check');
  checkboxes.forEach(cb => { cb.disabled = writing; });
  // Mettre à jour le placeholder de l'autocomplétion
  updateAutocompletePlaceholder();
}

// --- Dialogue d'échec d'écriture ---
function showWriteFailureDialog(failedPaths, allPaths, keywordPaths) {
  // Créer l'overlay modal
  const overlay = document.createElement('div');
  overlay.className = 'modal';

  const card = document.createElement('div');
  card.className = 'modal-card confirm-card';
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('role', 'dialog');

  const header = document.createElement('div');
  header.className = 'modal-header';
  header.innerHTML = `<h3>${t('Write failed for some files')}</h3>`;

  const body = document.createElement('div');
  body.className = 'modal-body';
  body.innerHTML = `<p>${tp('{count} of {total} files failed to write keywords.', failedPaths.length, allPaths.length)}</p>`;

  const actions = document.createElement('div');
  actions.className = 'modal-header-actions';
  actions.style.justifyContent = 'center';
  actions.style.gap = '0.5rem';
  actions.style.padding = '1rem';
  actions.style.borderTop = '1px solid var(--border)';

  const retryBtn = document.createElement('button');
  retryBtn.className = 'keyword-action-btn keyword-action-apply';
  retryBtn.textContent = t('Retry');
  retryBtn.addEventListener('click', () => {
    overlay.remove();
    // Retenter l'écriture seulement sur les fichiers en échec
    retryFailedWrites(failedPaths, keywordPaths);
  });

  const showBtn = document.createElement('button');
  showBtn.className = 'keyword-action-btn';
  showBtn.textContent = t('Show failed');
  showBtn.addEventListener('click', () => {
    overlay.remove();
    // Filtrer la grille sur les fichiers en échec
    showFailedFiles(failedPaths);
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'keyword-action-btn keyword-action-reset';
  closeBtn.textContent = t('Close');
  closeBtn.addEventListener('click', () => {
    overlay.remove();
  });

  actions.append(retryBtn, showBtn, closeBtn);
  body.appendChild(actions);
  card.append(header, body);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Fermer sur Échap ou clic hors modal
  const closeOnEscape = (e) => {
    if (e.key === 'Escape') {
      overlay.removeEventListener('keydown', closeOnEscape);
      overlay.remove();
    }
  };
  overlay.addEventListener('keydown', closeOnEscape);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.removeEventListener('keydown', closeOnEscape);
      overlay.remove();
    }
  });

  closeBtn.focus();
}

// Retenter l'écriture sur les fichiers en échec
async function retryFailedWrites(failedPaths, keywordPaths) {
  if (pendingChanges.size === 0) return;
  const items = failedPaths.map(path => [path, keywordPaths]);

  setWritingState(true);
  const enqueued = host.enqueueKeywordWrite(
    items,
    keywordPaths,
    (failed, writtenPaths, writtenKeywordPaths) => {
      setWritingState(false);
      if (failed.length === 0) {
        host.showToast(tp('Keywords written to {count} file', writtenPaths.length));
        for (const [keywordId, state] of pendingChanges) {
          if (state === 'checked') {
            countByKeyword.set(keywordId, writtenPaths.length);
          } else {
            countByKeyword.set(keywordId, 0);
          }
        }
        pendingChanges.clear();
        updateActionButtonsState();
        reloadKeywordTreeOnly();
      } else {
        // Échec partiel : réafficher le dialogue avec les échecs restants
        showWriteFailureDialog(failed, writtenPaths, writtenKeywordPaths);
      }
    },
    (error, writtenPaths, writtenKeywordPaths) => {
      setWritingState(false);
      host.showToast(t('Keywords write failed: {error}', { error: String(error) }));
    }
  );
  if (!enqueued) setWritingState(false);
}

// Filtrer la grille pour afficher seulement les fichiers en échec
function showFailedFiles(failedPaths) {
  if (host.filterByPaths) {
    host.filterByPaths(failedPaths);
  } else {
    host.showToast(t('Cannot filter grid: host.filterByPaths not available'));
  }
}

// --- Boutons d'action ---

async function handleApply() {
  if (pendingChanges.size === 0) return;
  const paths = host.getSelectedPhotos().map(photo => photo.path);
  const keywordPaths = buildKeywordPathsForWrite();

  // Préparer les items pour l'écriture : chaque photo reçoit les mêmes mots-clés actifs
  const items = paths.map(path => [path, keywordPaths]);

  // Bloquer l'UI pendant l'écriture
  setWritingState(true);

  // Enfile dans la TaskQueue et attend la fin de l'écriture
  return new Promise((resolve) => {
    const enqueued = host.enqueueKeywordWrite(
      items,
      keywordPaths,
      // onComplete
      (failed, writtenPaths, writtenKeywordPaths) => {
        setWritingState(false);
        if (failed.length === 0) {
          host.showToast(tp('Keywords written to {count} file', writtenPaths.length));
          // Appliquer les changements en attente à l'état local
          for (const [keywordId, state] of pendingChanges) {
            if (state === 'checked') {
              countByKeyword.set(keywordId, selectionSize);
            } else { // 'empty'
              countByKeyword.set(keywordId, 0);
            }
          }
          pendingChanges.clear();
          updateActionButtonsState();
          // Recharger UNIQUEMENT la structure de l'arbre (nodeById) pour récupérer les nouveaux mots-clés créés
          // sans écraser nos compteurs locaux
          reloadKeywordTreeOnly();
        } else {
          // Afficher le dialogue d'échec avec option Retenter / Afficher
          showWriteFailureDialog(failed, writtenPaths, writtenKeywordPaths);
        }
        resolve({ failed, writtenPaths, writtenKeywordPaths });
      },
      // onFailure
      (error, writtenPaths, writtenKeywordPaths) => {
        setWritingState(false);
        host.showToast(t('Keywords write failed: {error}', { error: String(error) }));
        resolve({ error, writtenPaths, writtenKeywordPaths });
      }
    );

    if (!enqueued) {
      setWritingState(false);
      resolve({ error: 'Not enqueued' });
    }
  });
}

// Écrit les mots-clés sur une sélection spécifique (chemins donnés) - utilisée pour Apply sur l'ancienne sélection
async function handleApplyOnSelection(paths) {
  if (pendingChanges.size === 0) return;
  const keywordPaths = buildKeywordPathsForWrite();

  // Préparer les items pour l'écriture : chaque photo reçoit les mêmes mots-clés actifs
  const items = paths.map(path => [path, keywordPaths]);

  // Bloquer l'UI pendant l'écriture
  setWritingState(true);

  // Enfile dans la TaskQueue et attend la fin de l'écriture
  return new Promise((resolve) => {
    const enqueued = host.enqueueKeywordWrite(
      items,
      keywordPaths,
      // onComplete
      (failed, writtenPaths, writtenKeywordPaths) => {
        setWritingState(false);
        if (failed.length === 0) {
          host.showToast(tp('Keywords written to {count} file', writtenPaths.length));
          // Appliquer les changements en attente à l'état local
          for (const [keywordId, state] of pendingChanges) {
            if (state === 'checked') {
              countByKeyword.set(keywordId, writtenPaths.length);
            } else { // 'empty'
              countByKeyword.set(keywordId, 0);
            }
          }
          pendingChanges.clear();
          updateActionButtonsState();
          // Recharger UNIQUEMENT la structure de l'arbre
          reloadKeywordTreeOnly();
        } else {
          // Afficher le dialogue d'échec avec option Retenter / Afficher
          showWriteFailureDialog(failed, writtenPaths, writtenKeywordPaths);
        }
        resolve({ failed, writtenPaths, writtenKeywordPaths });
      },
      // onFailure
      (error, writtenPaths, writtenKeywordPaths) => {
        setWritingState(false);
        host.showToast(t('Keywords write failed: {error}', { error: String(error) }));
        resolve({ error, writtenPaths, writtenKeywordPaths });
      }
    );

    if (!enqueued) {
      setWritingState(false);
      resolve({ error: 'Not enqueued' });
    }
  });
}

function handleReset() {
  pendingChanges.clear();
  updateActionButtonsState();
  renderTree();
  host.showToast(t('Changes reset'));
}

async function handleUnify() {
  // Unifier : appliquer les mêmes mots-clés à toutes les photos de la sélection
  // L'état actuel des cases (avec pending) devient la nouvelle référence pour toutes les photos
  // En pratique, pendingChanges contient déjà l'état désiré, il suffit d'appliquer
  await handleApply();
}

// --- Autocomplétion ---

function updateAutocompleteList() {
  if (!autocompleteInput || !autocompleteList) return;
  const query = autocompleteInput.value.trim().toLowerCase();
  autocompleteQuery = query;

  if (!query) {
    autocompleteList.hidden = true;
    autocompleteInput.setAttribute('aria-expanded', 'false');
    return;
  }

  // Filtrer les nœuds qui correspondent à la requête
  const matches = [];
  for (const node of nodeById.values()) {
    if (node.name.toLowerCase().includes(query)) {
      matches.push(node);
    }
  }
  // Trier par fréquence d'utilisation (décroissant), puis alphabétiquement
  matches.sort((a, b) => {
    const countA = countByKeyword.get(a.id) || 0;
    const countB = countByKeyword.get(b.id) || 0;
    if (countB !== countA) return countB - countA; // plus fréquent en premier
    return nameCollator.compare(a.name, b.name);
  });

  if (matches.length === 0) {
    autocompleteList.innerHTML = `<li class="keyword-autocomplete-empty">${t('No matching keyword')}</li>`;
    autocompleteList.hidden = false;
    autocompleteInput.setAttribute('aria-expanded', 'true');
    autocompleteSelectedIndex = -1;
    return;
  }

  autocompleteList.innerHTML = '';
  autocompleteSelectedIndex = -1;
  for (let i = 0; i < Math.min(matches.length, 20); i++) {
    const node = matches[i];
    const item = document.createElement('li');
    item.className = 'keyword-autocomplete-item';
    item.setAttribute('role', 'option');
    item.dataset.keywordId = String(node.id);
    item.textContent = pathLabel(node);
    item.addEventListener('click', (e) => selectAutocompleteItem(node, e.shiftKey));
    autocompleteList.appendChild(item);
  }
  // Option pour créer un nouveau mot-clé si la requête ne correspond à rien d'existant exactement
  const exactMatch = matches.find(n => n.name.toLowerCase() === query);
  if (!exactMatch && query.length >= 2 && !query.includes('/') && !query.includes('|') && !query.includes(',')) {
    const createItem = document.createElement('li');
    createItem.className = 'keyword-autocomplete-item keyword-autocomplete-create';
    createItem.setAttribute('role', 'option');
    createItem.innerHTML = `<span>${t('Create new keyword')}</span> <span class="keyword-autocomplete-hint">“${query}”</span>`;
    createItem.addEventListener('click', () => createKeywordFromAutocomplete(query));
    autocompleteList.appendChild(createItem);
  }
  autocompleteList.hidden = false;
  autocompleteInput.setAttribute('aria-expanded', 'true');
}

function selectAutocompleteItem(node, shiftPressed = false) {
  // Ajouter ce mot-clé à la sélection (le mettre à 'checked')
  if (selectionSize === 0) return;
  pendingChanges.set(node.id, 'checked');
  if (shiftPressed) {
    // Shift+Activation : activer aussi tous les ancêtres
    const ancestors = getAncestors(node.id);
    for (const ancestorId of ancestors) {
      pendingChanges.set(ancestorId, 'checked');
    }
  }
  autocompleteInput.value = '';
  autocompleteList.hidden = true;
  autocompleteInput.setAttribute('aria-expanded', 'false');
  updateActionButtonsState();
  renderTree();
}

async function createKeywordFromAutocomplete(name) {
  if (selectionSize === 0) return;
  // Par défaut, créer au premier niveau (parent_id = 0)
  // Plus tard, on pourra demander le parent via un sélecteur
  const newId = await showCreateKeywordModal(0, '');
  if (newId) {
    autocompleteInput.value = '';
    autocompleteList.hidden = true;
    autocompleteInput.setAttribute('aria-expanded', 'false');
    // Invalider l'arbre pour le recharger
    treeVersion += 1;
    invalidateKeywordTree();
    updateActionButtonsState();
    renderTree();
  }
}

function handleAutocompleteKeydown(event) {
  const items = autocompleteList.querySelectorAll('.keyword-autocomplete-item:not(.keyword-autocomplete-empty)');
  if (items.length === 0) return;

  switch (event.key) {
    case 'ArrowDown':
      // Liste AU-DESSUS de l'input : flèche BAS = descendre visuellement = vers le BAS de la liste (index length-1)
      event.preventDefault();
      if (autocompleteSelectedIndex < 0) {
        autocompleteSelectedIndex = 0;  // 1er appui : sommet visuel (index 0)
      } else {
        autocompleteSelectedIndex = Math.min(autocompleteSelectedIndex + 1, items.length - 1);  // suivants : descendre = incrémenter
      }
      updateAutocompleteSelection(items);
      break;
    case 'ArrowUp':
      // Liste AU-DESSUS de l'input : flèche HAUT = monter visuellement = vers le HAUT de la liste (index 0)
      event.preventDefault();
      if (autocompleteSelectedIndex < 0) {
        autocompleteSelectedIndex = items.length - 1;  // 1er appui : bas visuel (index length-1)
      } else {
        autocompleteSelectedIndex = Math.max(autocompleteSelectedIndex - 1, 0);  // suivants : monter = décrémenter
      }
      updateAutocompleteSelection(items);
      break;
    case 'Enter':
      event.preventDefault();
      if (autocompleteSelectedIndex >= 0 && items[autocompleteSelectedIndex]) {
        const item = items[autocompleteSelectedIndex];
        const keywordId = parseInt(item.dataset.keywordId, 10);
        const node = nodeById.get(keywordId);
        if (node) selectAutocompleteItem(node, event.shiftKey);
      }
      break;
    case 'Escape':
      autocompleteList.hidden = true;
      autocompleteInput.setAttribute('aria-expanded', 'false');
      autocompleteSelectedIndex = -1;
      break;
  }
}

function updateAutocompleteSelection(items) {
  items.forEach((item, i) => {
    item.classList.toggle('selected', i === autocompleteSelectedIndex);
    if (i === autocompleteSelectedIndex) {
      item.scrollIntoView({ block: 'nearest' });
    }
  });
}

export function initKeywordsPanel(hostApi) {
  host = hostApi;
  exifPanel = document.getElementById('exif-panel');
  toggleButton = document.getElementById('btn-toggle-exif');
  infoTabButton = document.getElementById('side-tab-info');
  keywordsTabButton = document.getElementById('side-tab-keywords');
  infoPane = document.getElementById('exif-tab-info');
  keywordsPane = document.getElementById('exif-tab-keywords');
  treeList = document.getElementById('keyword-tree');
  modeButton = document.getElementById('btn-keyword-filter-mode');
  applyButton = document.getElementById('btn-keyword-apply');
  resetButton = document.getElementById('btn-keyword-reset');
  unifyButton = document.getElementById('btn-keyword-unify');
  autocompleteInput = document.getElementById('keyword-autocomplete-input');
  autocompleteList = document.getElementById('keyword-autocomplete-list');

  if (!exifPanel || !toggleButton || !infoTabButton || !keywordsTabButton || !infoPane || !keywordsPane || !treeList || !modeButton ||
      !applyButton || !resetButton || !unifyButton || !autocompleteInput || !autocompleteList) {
    console.error('Panneau des mots-clés : éléments introuvables dans index.html');
    return;
  }
  initialized = true;

  infoTabButton.addEventListener('click', () => setTab('info'));
  keywordsTabButton.addEventListener('click', () => { if (!keywordsTabButton.disabled) setTab('keywords'); });
  modeButton.addEventListener('click', toggleFilterMode);

  // Boutons d'action
  applyButton.addEventListener('click', handleApply);
  resetButton.addEventListener('click', handleReset);
  unifyButton.addEventListener('click', handleUnify);

  // Autocomplétion
  autocompleteInput.addEventListener('input', () => {
    clearTimeout(autocompleteDebounceTimer);
    autocompleteDebounceTimer = setTimeout(updateAutocompleteList, 100);
  });
  autocompleteInput.addEventListener('keydown', handleAutocompleteKeydown);
  autocompleteInput.addEventListener('focus', updateAutocompleteList);
  document.addEventListener('click', (e) => {
    if (!autocompleteList.contains(e.target) && e.target !== autocompleteInput) {
      autocompleteList.hidden = true;
      autocompleteInput.setAttribute('aria-expanded', 'false');
    }
  });

  // Ctrl+K : bascule le filtre d'affichage, même quand un champ de saisie a le focus
  window.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return;
    if (!isKeywordsTabVisible() || document.querySelector('.modal:not(.hidden)')) return;
    // Ne pas intercepter si on est dans l'autocomplétion
    if (document.activeElement === autocompleteInput) return;
    event.preventDefault();
    if (!event.repeat) toggleFilterMode();
  });

  // Ctrl+Entrée : appliquer les modifications de mots-clés en attente
  window.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key !== 'Enter') return;
    if (!isKeywordsTabVisible() || document.querySelector('.modal:not(.hidden)')) return;
    // Ne pas intercepter si on est dans l'autocomplétion
    if (document.activeElement === autocompleteInput) return;
    event.preventDefault();
    if (!event.repeat && pendingChanges.size > 0) handleApply();
  });

  // Le panneau est affiché ou masqué par main.js (classe « hidden ») : l'onglet Mots-clés se met à jour dès qu'il devient visible.
  new MutationObserver(() => refreshKeywordsPanel()).observe(exifPanel, { attributes: true, attributeFilter: ['class'] });

  onLanguageChange(() => {
    applyTab();
    updateModeButton();
    updateAutocompletePlaceholder();
    renderTree();
  });
  updateModeButton();
  updateAutocompletePlaceholder();
  applyTab();
}