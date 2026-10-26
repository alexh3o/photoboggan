// Panneau latéral droit à onglets (Info / Mots-clés) et onglet Mots-clés : arborescence hiérarchique avec cases à trois états.
//
// ÉTAPE 1 (lecture seule) : l'arbre et le nombre de photos de la sélection portant chaque mot-clé viennent de la base (voir keywords.rs) ;
// les cases reflètent la sélection mais ne sont pas encore cliquables. L'édition, l'écriture dans les fichiers et la gestion de
// l'arbre (création, suppression) viennent aux étapes suivantes.
//
// main.js fournit la sélection (initKeywordsPanel) et appelle refreshKeywordsPanel quand elle change.
import './keywords.css';
import { invoke } from '@tauri-apps/api/core';
import { t, onLanguageChange } from './i18n.js';

const TAB_STORAGE_KEY = 'sidePanelTab';
const FILTER_MODE_STORAGE_KEY = 'keywordFilterMode';
const SIDE_TABS = ['info', 'keywords'];
const ROOT_ID = 0; // identifiant du « parent » des mots-clés de premier niveau
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

let host = null; // { getSelectedPhotos } fourni par main.js
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

let exifPanel;
let toggleButton;
let infoTabButton;
let keywordsTabButton;
let infoPane;
let keywordsPane;
let treeList;
let modeButton;

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
  const photoIds = host.getSelectedPhotos().map(photo => photo.id).filter(id => Number.isFinite(id) && id > 0);
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
    renderTree();
  } catch (error) {
    console.error('Lecture des mots-clés impossible', error);
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
function assignedVisibleIds() {
  const visible = new Set();
  for (const [keywordId, count] of countByKeyword) {
    if (!(count > 0)) continue;
    for (let current = nodeById.get(keywordId); current && !visible.has(current.id); current = nodeById.get(current.parent_id)) visible.add(current.id);
  }
  return visible;
}

function checkState(keywordId) {
  const count = countByKeyword.get(keywordId) || 0;
  if (selectionSize > 0 && count >= selectionSize) return 'checked';
  return count > 0 ? 'partial' : 'empty';
}

function buildCheckbox(state, label) {
  const box = document.createElement('span');
  box.className = `keyword-check${state === 'empty' ? '' : ` ${state}`}`;
  box.setAttribute('role', 'checkbox');
  box.setAttribute('aria-checked', state === 'checked' ? 'true' : state === 'partial' ? 'mixed' : 'false');
  box.setAttribute('aria-disabled', 'true'); // lecture seule à cette étape
  box.setAttribute('aria-label', label);
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
    toggle.addEventListener('click', () => {
      if (expanded) expandedIds.delete(node.id); else expandedIds.add(node.id);
      renderTree();
    });
  } else {
    toggle.disabled = true;
    toggle.tabIndex = -1;
    toggle.textContent = hasChildren ? '▾' : ' ';
  }
  const name = document.createElement('span');
  name.className = 'keyword-name';
  name.textContent = node.name;
  name.title = pathLabel(node);
  row.append(toggle, buildCheckbox(checkState(node.id), node.name), name);
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
  if (!exifPanel || !toggleButton || !infoTabButton || !keywordsTabButton || !infoPane || !keywordsPane || !treeList || !modeButton) {
    console.error('Panneau des mots-clés : éléments introuvables dans index.html');
    return;
  }
  initialized = true;

  infoTabButton.addEventListener('click', () => setTab('info'));
  keywordsTabButton.addEventListener('click', () => { if (!keywordsTabButton.disabled) setTab('keywords'); });
  modeButton.addEventListener('click', toggleFilterMode);

  // Ctrl+K : bascule le filtre d'affichage, même quand un champ de saisie a le focus (le gestionnaire de touches de main.js les ignore).
  window.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return;
    if (!isKeywordsTabVisible() || document.querySelector('.modal:not(.hidden)')) return;
    event.preventDefault();
    if (!event.repeat) toggleFilterMode();
  });

  // Le panneau est affiché ou masqué par main.js (classe « hidden ») : l'onglet Mots-clés se met à jour dès qu'il devient visible.
  new MutationObserver(() => refreshKeywordsPanel()).observe(exifPanel, { attributes: true, attributeFilter: ['class'] });

  onLanguageChange(() => {
    applyTab();
    updateModeButton();
    renderTree();
  });
  updateModeButton();
  applyTab();
}
