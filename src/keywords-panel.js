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
  const token = ++reloadToken;
  const versionAtStart = treeVersion;
  try {
    const nodes = await invoke('get_keyword_tree');
    if (token !== reloadToken) return;
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
    toggleKeyword(node.id);
  });
  // Clic sur la ligne = bascule aussi (sauf sur le toggle)
  row.addEventListener('click', (e) => {
    if (e.target === toggle || e.target === checkbox) return;
    toggleKeyword(node.id);
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
  row.append(name);
  return row;
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

function toggleKeyword(keywordId) {
  if (selectionSize === 0) return;
  const currentState = effectiveState(keywordId);
  // Cycle : checked → empty → checked (on ne met jamais 'partial' en attente)
  // Si l'état effectif est 'partial', on passe à 'checked' (toutes les photos sélectionnées l'auront)
  let newState;
  if (currentState === 'checked') {
    newState = 'empty';
  } else if (currentState === 'empty') {
    newState = 'checked';
  } else { // 'partial'
    newState = 'checked';
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
  updateActionButtonsState();
  renderTree();
}

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

// --- Boutons d'action ---

async function handleApply() {
  if (pendingChanges.size === 0) return;
  const paths = host.getSelectedPhotos().map(photo => photo.path);
  const keywordPaths = buildKeywordPathsForWrite();

  // Préparer les items pour l'écriture : chaque photo reçoit les mêmes mots-clés actifs
  const items = paths.map(path => [path, keywordPaths]);

  // Toast persistant pendant l'écriture (isWriting = true)
  host.showToast(tp('Writing keywords to {count} file…', items.length), true);
  try {
    const failed = await invoke('write_keywords_to_files', { items });
    if (failed.length === 0) {
      host.showToast(tp('Keywords written to {count} file', items.length));
      // Appliquer les changements en attente à l'état local (la base n'est pas mise à jour par l'écriture)
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
      await reloadKeywordTreeOnly();
    } else {
      host.showToast(t('Some files failed to write'));
    }
  } catch (error) {
    console.error('Écriture mots-clés échouée', error);
    host.showToast(t('Keywords write failed: {error}', { error: String(error) }));
  }
}

// Écrit les mots-clés sur une sélection spécifique (chemins donnés) - utilisée pour Apply sur l'ancienne sélection
async function handleApplyOnSelection(paths) {
  if (pendingChanges.size === 0) return;
  const keywordPaths = buildKeywordPathsForWrite();

  // Préparer les items pour l'écriture : chaque photo reçoit les mêmes mots-clés actifs
  const items = paths.map(path => [path, keywordPaths]);

  // Toast persistant pendant l'écriture (isWriting = true)
  host.showToast(tp('Writing keywords to {count} file…', items.length), true);
  try {
    const failed = await invoke('write_keywords_to_files', { items });
    if (failed.length === 0) {
      host.showToast(tp('Keywords written to {count} file', items.length));
      // Appliquer les changements en attente à l'état local
      for (const [keywordId, state] of pendingChanges) {
        if (state === 'checked') {
          countByKeyword.set(keywordId, paths.length);
        } else { // 'empty'
          countByKeyword.set(keywordId, 0);
        }
      }
      pendingChanges.clear();
      updateActionButtonsState();
      // Recharger UNIQUEMENT la structure de l'arbre
      await reloadKeywordTreeOnly();
    } else {
      host.showToast(t('Some files failed to write'));
    }
  } catch (error) {
    console.error('Écriture mots-clés échouée', error);
    host.showToast(t('Keywords write failed: {error}', { error: String(error) }));
  }
}

function handleReset() {
  pendingChanges.clear();
  updateActionButtonsState();
  renderTree();
  host.showToast(t('Changes reset'));
}

function handleUnify() {
  // Unifier : appliquer les mêmes mots-clés à toutes les photos de la sélection
  // L'état actuel des cases (avec pending) devient la nouvelle référence pour toutes les photos
  // En pratique, pendingChanges contient déjà l'état désiré, il suffit d'appliquer
  handleApply();
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
  matches.sort((a, b) => nameCollator.compare(a.name, b.name));

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
    item.addEventListener('click', () => selectAutocompleteItem(node));
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

function selectAutocompleteItem(node) {
  // Ajouter ce mot-clé à la sélection (le mettre à 'checked')
  if (selectionSize === 0) return;
  pendingChanges.set(node.id, 'checked');
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
  try {
    const newId = await invoke('create_keyword', { parentId: 0, name });
    pendingChanges.set(newId, 'checked');
    autocompleteInput.value = '';
    autocompleteList.hidden = true;
    autocompleteInput.setAttribute('aria-expanded', 'false');
    // Invalider l'arbre pour le recharger
    treeVersion += 1;
    invalidateKeywordTree();
    updateActionButtonsState();
    renderTree();
  } catch (error) {
    console.error('Création mot-clé échouée', error);
    host.showToast(t('Keywords write failed: {error}', { error: String(error) }));
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
        if (node) selectAutocompleteItem(node);
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