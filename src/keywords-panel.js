// Panneau latéral droit à onglets (Info / Mots-clés) et onglet Mots-clés : arborescence hiérarchique éditable.
//
// Les mots-clés ne sont pas écrits dans les fichiers à chaque clic : les cases modifient un état « en attente » (une copie des mots-clés actifs
// de chaque photo sélectionnée), qui n'est enregistré que sur « Appliquer », Ctrl+Entrée, ou au changement de sélection (après confirmation,
// ou automatiquement si « Appliquer automatiquement les changements de mots-clés » est activé).
//
// L'arbre, l'état enregistré et les fréquences d'usage viennent de la base (voir keywords.rs), qui reflète le contenu réel des fichiers.
// main.js fournit la sélection et les services de l'application (initKeywordsPanel) et appelle refreshKeywordsPanel quand la sélection change.
import './keywords.css';
import { invoke } from '@tauri-apps/api/core';
import { t, tp, labelWithColon, onLanguageChange } from './i18n.js';

const TAB_STORAGE_KEY = 'sidePanelTab';
const FILTER_MODE_STORAGE_KEY = 'keywordFilterMode';
const AUTO_APPLY_STORAGE_KEY = 'keywordsAutoApply'; // réglage « Appliquer automatiquement les changements de mots-clés »
const SIDE_TABS = ['info', 'keywords'];
const ROOT_ID = 0; // identifiant du « parent » des mots-clés de premier niveau
const QUEUE_THRESHOLD = 20; // à partir de ce nombre de fichiers, l'écriture passe par la file de tâches
const MAX_SUGGESTIONS = 200;
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

let host = null; // services de main.js, voir initKeywordsPanel
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
let usageById = new Map(); // mot-clé -> nombre de photos de la photothèque qui le portent
let usageDirty = true;
const expandedIds = new Set(); // nœuds dépliés en mode « tous les mots-clés »

// Photos ciblées (la sélection au moment du chargement) : mots-clés enregistrés et mots-clés en cours d'édition, par identifiant de photo.
let baseline = new Map();
let working = new Map();
let workingPhotos = new Map(); // identifiant -> { id, path }
let baselineCount = new Map(); // mot-clé -> nombre de photos ciblées qui le portent (état enregistré)
let workingCount = new Map(); // idem, état en cours d'édition
const dirtyIds = new Set(); // photos dont les mots-clés en cours d'édition diffèrent de ceux enregistrés

let reloadToken = 0;
let refreshScheduled = false;
let promptOpen = false;
let refreshAfterPrompt = false;
let directWrites = 0; // écritures directes (moins de QUEUE_THRESHOLD fichiers) en cours
const queuedWrites = []; // écritures passées par la file de tâches : { task, settled }
let lockTimer = null;
let lastWriteOk = false; // la dernière écriture directe s'est terminée sans échec ni arrêt (utile à la fermeture de l'application)

// Autocomplétion : nœuds correspondants, du plus fréquent au moins fréquent (le plus fréquent est affiché le plus près du champ).
let suggestions = [];
let highlighted = 0;

let exifPanel;
let toggleButton;
let infoTabButton;
let keywordsTabButton;
let infoPane;
let keywordsPane;
let treeList;
let modeButton;
let inputField;
let suggestionList;
let applyButton;
let resetButton;
let unifyButton;

const isAutoApply = () => localStorage.getItem(AUTO_APPLY_STORAGE_KEY) === 'true';
const fileName = path => String(path).split(/[\\/]/).pop();
const normalizeSearch = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const compareByUsage = (a, b) => (usageById.get(b.id) || 0) - (usageById.get(a.id) || 0) || nameCollator.compare(a.name, b.name);

function setsEqual(a, b) {
  if (!a || !b || a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Onglets du panneau
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Arbre
// ---------------------------------------------------------------------------

function buildTree(nodes) {
  nodeById = new Map(nodes.map(node => [node.id, { ...node, search: normalizeSearch(node.name) }]));
  childrenOf = new Map();
  for (const node of nodeById.values()) {
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

function ancestorIds(keywordId) {
  const ids = [];
  for (let current = nodeById.get(keywordId); current && current.parent_id !== ROOT_ID; ) {
    current = nodeById.get(current.parent_id);
    if (current) ids.push(current.id);
  }
  return ids;
}

function descendantIds(keywordId) {
  const ids = [];
  const stack = [...(childrenOf.get(keywordId) || [])];
  while (stack.length) {
    const node = stack.pop();
    ids.push(node.id);
    stack.push(...(childrenOf.get(node.id) || []));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// État d'édition
// ---------------------------------------------------------------------------

function recomputeCounts() {
  baselineCount = new Map();
  workingCount = new Map();
  for (const set of baseline.values()) for (const id of set) baselineCount.set(id, (baselineCount.get(id) || 0) + 1);
  for (const set of working.values()) for (const id of set) workingCount.set(id, (workingCount.get(id) || 0) + 1);
  dirtyIds.clear();
  for (const [photoId, set] of working) if (!setsEqual(set, baseline.get(photoId))) dirtyIds.add(photoId);
}

// État d'un mot-clé d'après les photos ciblées : toutes = coché, quelques-unes = rempli, aucune = vide.
function checkState(keywordId) {
  const count = workingCount.get(keywordId) || 0;
  if (working.size > 0 && count >= working.size) return 'checked';
  return count > 0 ? 'partial' : 'empty';
}

const hasPendingChange = keywordId => (baselineCount.get(keywordId) || 0) !== (workingCount.get(keywordId) || 0);

function afterEdit() {
  // Mode ExifTool : un processus est démarré dès la première modification, pour que « Appliquer » ne paie pas son démarrage (sans effet sinon).
  invoke('exiftool_prewarm').catch(() => {});
  recomputeCounts();
  renderTree();
  updateButtons();
}

function setKeywordsOnAll(keywordIds, turnOn) {
  for (const set of working.values()) {
    for (const id of keywordIds) {
      if (turnOn) set.add(id); else set.delete(id);
    }
  }
  afterEdit();
}

// Clic sur une case : présent sur toutes les photos -> retiré de toutes ; sinon -> ajouté à toutes.
// Avec Maj : l'activation active aussi tous les ascendants, la désactivation désactive aussi tous les descendants.
function toggleKeyword(keywordId, withHierarchy) {
  if (working.size === 0) return;
  const turnOn = checkState(keywordId) !== 'checked';
  const affected = [keywordId];
  if (withHierarchy) affected.push(...(turnOn ? ancestorIds(keywordId) : descendantIds(keywordId)));
  setKeywordsOnAll(affected, turnOn);
}

function activateKeyword(keywordId, withAncestors) {
  if (working.size === 0) return;
  setKeywordsOnAll(withAncestors ? [keywordId, ...ancestorIds(keywordId)] : [keywordId], true);
}

// « Unifier » : tout mot-clé actif sur au moins une photo de la sélection est activé sur l'ensemble de la sélection (en attente, comme le reste).
function unifySelection() {
  const union = new Set();
  for (const set of working.values()) for (const id of set) union.add(id);
  for (const set of working.values()) for (const id of union) set.add(id);
  afterEdit();
}

// « Réinitialiser » : les mots-clés de chaque photo reviennent à l'état enregistré ; les mots-clés créés ou supprimés dans l'arbre ne sont pas concernés.
function resetChanges() {
  working = new Map([...baseline].map(([id, set]) => [id, new Set(set)]));
  afterEdit();
}

const discardWorking = resetChanges;

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

function buildCheckbox(state, label, keywordId) {
  const box = document.createElement('button');
  box.type = 'button';
  box.className = `keyword-check${state === 'empty' ? '' : ` ${state}`}`;
  box.setAttribute('role', 'checkbox');
  box.setAttribute('aria-checked', state === 'checked' ? 'true' : state === 'partial' ? 'mixed' : 'false');
  box.setAttribute('aria-label', label);
  box.disabled = working.size === 0;
  box.addEventListener('click', event => toggleKeyword(keywordId, event.shiftKey));
  return box;
}

function buildNodeRow(node, depth, hasChildren, expanded, togglable) {
  const row = document.createElement('li');
  row.className = 'keyword-row';
  if (hasPendingChange(node.id)) row.classList.add('pending');
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
  row.append(toggle, buildCheckbox(checkState(node.id), node.name, node.id), name);
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

// Mode « attribués » : mots-clés portés par au moins une photo ciblée (avant ou après modification : une ligne décochée ne disparaît pas
// tant que la modification n'est pas appliquée), avec leurs ancêtres pour garder la hiérarchie.
function assignedVisibleIds() {
  const visible = new Set();
  for (const counts of [workingCount, baselineCount]) {
    for (const [keywordId, count] of counts) {
      if (!(count > 0)) continue;
      for (let current = nodeById.get(keywordId); current && !visible.has(current.id); current = nodeById.get(current.parent_id)) visible.add(current.id);
    }
  }
  return visible;
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
    if (visibleIds.size === 0) rows.push(emptyMessage(t(working.size === 0 ? 'No photo selected.' : 'No keyword assigned to the selection.')));
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

// ---------------------------------------------------------------------------
// Boutons et verrou d'écriture
// ---------------------------------------------------------------------------

// Tant qu'une écriture est en cours (directe, ou tâche en attente / en cours dans la file), « Appliquer » et Ctrl+Entrée sont inactifs.
function isWriteLocked() {
  return directWrites > 0 || queuedWrites.some(entry => !entry.settled && host.isTaskQueued(entry.task));
}

function canUnify() {
  if (working.size < 2) return false;
  for (const count of workingCount.values()) if (count > 0 && count < working.size) return true;
  return false;
}

function updateButtons() {
  if (!initialized) return;
  const locked = isWriteLocked();
  applyButton.disabled = dirtyIds.size === 0 || locked;
  applyButton.title = locked ? t('Keyword writing in progress…') : t('Write the keyword changes into the files (Ctrl+Enter)');
  resetButton.disabled = dirtyIds.size === 0;
  resetButton.title = t('Put the keywords back to their state before the changes');
  unifyButton.disabled = !canUnify();
  unifyButton.title = t('Give every selected photo all the keywords that at least one of them has');
  inputField.disabled = working.size === 0;
}

// Surveille la file de tâches tant qu'une écriture est en attente : une tâche retirée de la file libère le verrou sans autre signal.
function watchLock() {
  if (lockTimer !== null) return;
  lockTimer = setInterval(() => {
    updateButtons();
    if (!isWriteLocked()) {
      clearInterval(lockTimer);
      lockTimer = null;
      queuedWrites.length = 0;
    }
  }, 400);
}

// ---------------------------------------------------------------------------
// Fenêtre à choix multiples
// ---------------------------------------------------------------------------

// Fenêtre modale : `buttons` = [{ label, value, primary?, cancel? }]. Échap choisit le bouton marqué `cancel` (sans lui, Échap ne fait rien).
function choiceDialog({ title, message, buttons }) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const card = document.createElement('div');
    card.className = 'modal-card keyword-dialog';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h3');
    heading.textContent = title;
    const body = document.createElement('p');
    body.textContent = message;
    body.style.whiteSpace = 'pre-line';
    const actions = document.createElement('div');
    actions.className = 'keyword-dialog-actions';
    const close = value => {
      document.removeEventListener('keydown', onKeyDown, true);
      modal.remove();
      resolve(value);
    };
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      const cancelButton = buttons.find(button => button.cancel);
      event.preventDefault();
      event.stopPropagation();
      if (cancelButton) close(cancelButton.value);
    };
    let primaryElement = null;
    for (const button of buttons) {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = button.label;
      if (button.primary) { element.classList.add('active'); primaryElement = element; }
      element.addEventListener('click', () => close(button.value));
      actions.append(element);
    }
    card.append(heading, body, actions);
    modal.append(card);
    document.addEventListener('keydown', onKeyDown, true);
    (document.getElementById('app') || document.body).append(modal);
    (primaryElement || actions.firstElementChild)?.focus();
  });
}

// ---------------------------------------------------------------------------
// Écriture dans les fichiers
// ---------------------------------------------------------------------------

async function applyChanges(options) {
  if (!initialized || isWriteLocked() || dirtyIds.size === 0) return;
  // Photos dont les mots-clés ont changé uniquement : on envoie l'ensemble final des mots-clés actifs de chacune.
  const items = [...dirtyIds].map(id => ({ photo_id: id, path: workingPhotos.get(id).path, keyword_ids: [...working.get(id)] }));
  await runKeywordWrite(items, options);
}

// Lance une opération qui réécrit des fichiers (application des modifications, suppression ou renommage d'un mot-clé), verrou d'écriture pris pendant
// sa durée. `count` photos ≥ QUEUE_THRESHOLD : tâche de la file, avec progression et arrêt possible (sauf `forceDirect`) ; sinon commande directe.
// `finish(entry, resultat, erreur)` traite la fin ; `resultat` vaut null si la commande a échoué ou si la tâche a été retirée de la file.
async function runLocked(command, args, count, finish, { forceDirect = false } = {}) {
  const entry = { task: null, settled: false };
  if (!forceDirect && count >= QUEUE_THRESHOLD) {
    const task = host.enqueueKeywordTask(command, args, count, (result, stopped, error) => finish(entry, result, error));
    if (!task) {
      host.showToast(t('Keyword writing could not be queued'));
      return;
    }
    entry.task = task;
    queuedWrites.push(entry);
    watchLock();
    updateButtons();
    return;
  }
  directWrites += 1;
  updateButtons();
  host.showToast(t('Writing keywords…'));
  try {
    const result = await invoke(command, args);
    await finish(entry, result, null);
  } catch (error) {
    await finish(entry, null, error);
  } finally {
    directWrites -= 1;
    updateButtons();
  }
}

const runKeywordWrite = (items, options) => runLocked('apply_keyword_changes', { items }, items.length, (entry, result, error) => finishWrite(entry, items, result, error), options);

// Fin d'une écriture : `result` vaut null si la commande a échoué ou si la tâche a été retirée de la file avant de démarrer.
async function finishWrite(entry, items, result, error) {
  if (entry.settled) return;
  entry.settled = true;
  updateButtons();
  if (!result) {
    if (error) host.showToast(t('Keyword writing failed: {error}', { error: String(error) }));
    return;
  }
  const sent = new Map(items.map(item => [item.photo_id, new Set(item.keyword_ids)]));
  const updates = new Map();
  for (const written of result.written) {
    updates.set(written.photo_id, written.keywords);
    const sentSet = sent.get(written.photo_id);
    if (sentSet && working.has(written.photo_id)) {
      // Ce qui vient d'être écrit devient l'état enregistré ; les modifications faites depuis restent en attente.
      const untouched = !dirtyIds.has(written.photo_id) || setsEqual(working.get(written.photo_id), sentSet);
      baseline.set(written.photo_id, new Set(sentSet));
      if (untouched) working.set(written.photo_id, new Set(sentSet));
    }
  }
  usageDirty = true;
  recomputeCounts();
  renderTree();
  updateButtons();
  if (updates.size) host.updatePhotoKeywords(updates);
  refreshUsage();
  if (result.failed.length) {
    const failedIds = new Set(result.failed.map(failure => failure.photo_id));
    await showFailureDialog(result, () => runKeywordWrite(items.filter(item => failedIds.has(item.photo_id))));
  }
  else if (result.cancelled) host.showToast(t('Keyword writing stopped: {count} not processed', { count: result.cancelled }));
  else { lastWriteOk = true; host.showToast(tp('Keywords written in {count} file', result.written.length)); }
}

// `retry` relance l'opération pour les fichiers en échec (nouvelle application des modifications, ou nouvelle suppression du mot-clé).
async function showFailureDialog(result, retry) {
  const details = result.failed.slice(0, 3).map(failure => `${fileName(failure.path)} : ${failure.error}`).join('\n');
  const choice = await choiceDialog({
    title: t('Keywords could not be written to some files'),
    message: `${t('{written} written · {failed} failed', { written: result.written.length, failed: result.failed.length })}\n${details}`,
    buttons: [
      { label: t('No'), value: 'no', cancel: true },
      { label: t('Retry'), value: 'retry', primary: true },
      { label: t('Show'), value: 'show' },
    ],
  });
  if (choice === 'retry') {
    await retry();
  } else if (choice === 'show') {
    // La vue des miniatures ne montre plus que les fichiers en échec ; leurs modifications en attente sont abandonnées (les fichiers n'ont pas changé).
    discardWorking();
    host.showFailedFiles(result.failed.map(failure => failure.path));
  }
}

async function refreshUsage() {
  try {
    usageById = new Map(await invoke('get_keyword_usage'));
    usageDirty = false;
  } catch (error) {
    console.error('Lecture des fréquences de mots-clés impossible', error);
  }
}

// ---------------------------------------------------------------------------
// Chargement et changement de sélection
// ---------------------------------------------------------------------------

// Relit l'arbre et les fréquences d'usage s'ils ont changé, sans toucher à l'état d'édition des photos sélectionnées.
async function refreshTreeAndUsage() {
  const versionAtStart = treeVersion;
  const needTree = loadedTreeVersion !== versionAtStart;
  try {
    const [nodes, usage] = await Promise.all([
      needTree ? invoke('get_keyword_tree') : null,
      needTree || usageDirty ? invoke('get_keyword_usage') : null,
    ]);
    if (nodes) {
      buildTree(nodes);
      loadedTreeVersion = versionAtStart;
    }
    if (usage) {
      usageById = new Map(usage);
      usageDirty = false;
    }
  } catch (error) {
    console.error('Lecture des mots-clés impossible', error);
  }
}

const currentTarget = () => host.getSelectedPhotos().filter(photo => Number.isFinite(photo.id) && photo.id > 0);
const sameAsWorking = photos => photos.length === working.size && photos.every(photo => working.has(photo.id));

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
  if (promptOpen) { refreshAfterPrompt = true; return; }
  try {
    let photos = currentTarget();
    if (sameAsWorking(photos)) {
      // Même sélection : les modifications en attente sont conservées ; seuls l'arbre et les fréquences d'usage sont relus s'ils ont changé.
      if (loadedTreeVersion !== treeVersion || usageDirty) await refreshTreeAndUsage();
      renderTree();
      updateButtons();
      return;
    }
    if (!sameAsWorking(photos) && dirtyIds.size > 0) {
      // La sélection a changé alors que des mots-clés attendent d'être écrits : Appliquer / Ignorer / Annuler (revenir à la sélection précédente).
      const previousIndices = host.findIndicesByPhotoIds([...working.keys()]);
      const locked = isWriteLocked();
      promptOpen = true;
      let decision;
      try {
        decision = await askPendingDecision(previousIndices !== null, locked);
      } finally {
        promptOpen = false;
      }
      if (decision === 'cancel' && previousIndices) {
        host.setSelectionIndices(previousIndices);
        return;
      }
      if (decision === 'apply') await applyChanges();
      photos = currentTarget();
    }
    await loadState(photos);
  } finally {
    if (refreshAfterPrompt && !promptOpen) {
      refreshAfterPrompt = false;
      refreshKeywordsPanel();
    }
  }
}

// `canCancel` : la sélection précédente peut être retrouvée. `locked` : une écriture est déjà en cours, on ne peut pas en lancer une autre.
async function askPendingDecision(canCancel, locked) {
  if (!locked && isAutoApply()) return 'apply';
  const buttons = [];
  if (!locked) buttons.push({ label: t('Apply'), value: 'apply', primary: true });
  buttons.push({ label: t('Ignore'), value: 'ignore', primary: locked });
  if (canCancel) buttons.push({ label: t('Cancel'), value: 'cancel', cancel: true });
  return choiceDialog({
    title: t('Pending keyword changes'),
    message: t(locked
      ? 'Keyword changes are not written to the files yet, and another write is in progress. Ignore them?'
      : 'Keyword changes are not written to the files yet. Apply them before changing the selection?'),
    buttons,
  });
}

async function loadState(photos) {
  const token = ++reloadToken;
  const versionAtStart = treeVersion;
  const needTree = loadedTreeVersion !== versionAtStart;
  const needUsage = needTree || usageDirty;
  const ids = photos.map(photo => photo.id);
  try {
    const [nodes, usage, pairs] = await Promise.all([
      needTree ? invoke('get_keyword_tree') : null,
      needUsage ? invoke('get_keyword_usage') : null,
      ids.length ? invoke('get_photo_keyword_ids', { photoIds: ids }) : [],
    ]);
    if (token !== reloadToken) return; // une mise à jour plus récente est en cours
    if (nodes) {
      buildTree(nodes);
      loadedTreeVersion = versionAtStart;
    }
    if (usage) {
      usageById = new Map(usage);
      usageDirty = false;
    }
    baseline = new Map(ids.map(id => [id, new Set()]));
    for (const [photoId, keywordId] of pairs) baseline.get(photoId)?.add(keywordId);
    working = new Map([...baseline].map(([id, set]) => [id, new Set(set)]));
    workingPhotos = new Map(photos.map(photo => [photo.id, { id: photo.id, path: photo.path }]));
    recomputeCounts();
    closeSuggestions();
    renderTree();
    updateButtons();
  } catch (error) {
    console.error('Lecture des mots-clés impossible', error);
  }
}

// ---------------------------------------------------------------------------
// Saisie rapide et autocomplétion
// ---------------------------------------------------------------------------

function closeSuggestions() {
  suggestions = [];
  if (suggestionList) suggestionList.hidden = true;
}

function renderSuggestions() {
  suggestionList.hidden = false;
  if (suggestions.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'keyword-suggestion-empty';
    empty.textContent = t('No matching keyword. Create it from the keyword tree (right-click).');
    suggestionList.replaceChildren(empty);
    return;
  }
  // Le plus fréquent est en bas, le plus près du champ de saisie, et en surbrillance.
  const rows = suggestions.map((node, index) => {
    const row = document.createElement('li');
    row.className = 'keyword-suggestion';
    row.setAttribute('role', 'option');
    if (index === highlighted) row.classList.add('highlighted');
    const label = document.createElement('span');
    label.textContent = pathLabel(node);
    const count = document.createElement('span');
    count.className = 'keyword-suggestion-count';
    count.textContent = String(usageById.get(node.id) || 0);
    row.append(label, count);
    // mousedown plutôt que click : le champ garde le focus (sinon la liste se fermerait avant le clic).
    row.addEventListener('mousedown', event => {
      event.preventDefault();
      validateSuggestion(index, event.shiftKey);
    });
    return row;
  }).reverse();
  suggestionList.replaceChildren(...rows);
  suggestionList.querySelector('.highlighted')?.scrollIntoView({ block: 'nearest' });
}

function updateSuggestions() {
  const query = normalizeSearch(inputField.value.trim());
  if (!query || working.size === 0) { closeSuggestions(); return; }
  suggestions = [...nodeById.values()]
    .filter(node => node.search.includes(query))
    .sort((a, b) => (usageById.get(b.id) || 0) - (usageById.get(a.id) || 0) || nameCollator.compare(a.name, b.name))
    .slice(0, MAX_SUGGESTIONS);
  highlighted = 0;
  renderSuggestions();
  suggestionList.scrollTop = suggestionList.scrollHeight;
}

// Entrée : active le mot-clé en surbrillance sur toute la sélection (avec Maj : ses ascendants aussi). Rien ne se passe s'aucun mot-clé ne correspond.
function validateSuggestion(index, withAncestors) {
  const node = suggestions[index];
  if (!node) return;
  activateKeyword(node.id, withAncestors);
  inputField.value = '';
  closeSuggestions();
  inputField.focus();
}

function onInputKeyDown(event) {
  const open = !suggestionList.hidden && suggestions.length > 0;
  if (event.key === 'ArrowUp' && open) {
    event.preventDefault();
    highlighted = Math.min(highlighted + 1, suggestions.length - 1); // vers le moins fréquent, donc vers le haut de la liste
    renderSuggestions();
  } else if (event.key === 'ArrowDown' && open) {
    event.preventDefault();
    highlighted = Math.max(highlighted - 1, 0);
    renderSuggestions();
  } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    validateSuggestion(highlighted, event.shiftKey);
  } else if (event.key === 'Escape') {
    event.stopPropagation();
    if (!suggestionList.hidden) closeSuggestions(); else inputField.blur();
  }
}

// ---------------------------------------------------------------------------
// Gestion de l'arborescence : création, suppression, repli
// ---------------------------------------------------------------------------

const FORBIDDEN_NAME_CHARS = ['/', '|', ',']; // séparateurs des formats hiérarchiques et du filtre de mots-clés

let contextMenu = null;

function closeContextMenu() {
  if (!contextMenu) return;
  contextMenu.remove();
  contextMenu = null;
  document.removeEventListener('mousedown', onMenuOutsideClick, true);
  document.removeEventListener('keydown', onMenuKeyDown, true);
  window.removeEventListener('blur', closeContextMenu);
}

function onMenuOutsideClick(event) {
  if (contextMenu && !contextMenu.contains(event.target)) closeContextMenu();
}

function onMenuKeyDown(event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  closeContextMenu();
}

// Menu contextuel : `entries` = [{ label, action, disabled? }]. Se ferme au clic ailleurs, sur Échap ou quand la fenêtre perd le focus.
function showContextMenu(x, y, entries) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'keyword-context-menu';
  menu.setAttribute('role', 'menu');
  for (const entry of entries) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.textContent = entry.label;
    item.disabled = Boolean(entry.disabled);
    item.addEventListener('click', () => {
      closeContextMenu();
      entry.action();
    });
    menu.append(item);
  }
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  contextMenu = menu;
  document.addEventListener('mousedown', onMenuOutsideClick, true);
  document.addEventListener('keydown', onMenuKeyDown, true);
  window.addEventListener('blur', closeContextMenu);
  menu.querySelector('button:not(:disabled)')?.focus();
}

// Clic droit : sur « Racine » (créer au premier niveau, tout replier, déplier jusqu'aux mots-clés actifs) ou sur un mot-clé (créer un enfant, supprimer).
function onTreeContextMenu(event) {
  const row = event.target.closest('.keyword-row');
  if (!row) return;
  event.preventDefault();
  if (row.classList.contains('keyword-root')) {
    showContextMenu(event.clientX, event.clientY, [
      { label: t('Create a child keyword…'), action: () => createKeywordFlow(ROOT_ID) },
      { label: t('Collapse all'), action: collapseAll },
      { label: t('Expand to active keywords'), action: expandToActive },
    ]);
    return;
  }
  const node = nodeById.get(Number(row.dataset.keywordId));
  if (!node) return;
  showContextMenu(event.clientX, event.clientY, [
    { label: t('Create a child keyword…'), action: () => createKeywordFlow(node.id) },
    { label: t('Rename keyword…'), action: () => renameKeywordFlow(node), disabled: isWriteLocked() },
    { label: t('Delete keyword…'), action: () => deleteKeywordFlow(node), disabled: isWriteLocked() },
  ]);
}

function collapseAll() {
  expandedIds.clear();
  renderTree();
}

// Déplie tous les niveaux nécessaires pour voir les mots-clés actifs dans la sélection.
function expandToActive() {
  for (const [keywordId, count] of workingCount) {
    if (count > 0) for (const ancestorId of ancestorIds(keywordId)) expandedIds.add(ancestorId);
  }
  renderTree();
}

function registerNode(node) {
  const entry = { ...node, search: normalizeSearch(node.name) };
  nodeById.set(entry.id, entry);
  if (!childrenOf.has(entry.parent_id)) childrenOf.set(entry.parent_id, []);
  const siblings = childrenOf.get(entry.parent_id);
  siblings.push(entry);
  siblings.sort((a, b) => nameCollator.compare(a.name, b.name));
}

// Message d'erreur si `name` ne peut pas être créé sous `parentId`, sinon null.
function validateKeywordName(name, parentId, excludeId = null) {
  if (!name) return t('A keyword name cannot be empty.');
  if (FORBIDDEN_NAME_CHARS.some(char => name.includes(char))) return t('A keyword name cannot contain “/”, “|” or “,”.');
  const key = name.toLowerCase();
  if ((childrenOf.get(parentId) || []).some(sibling => sibling.id !== excludeId && sibling.name.trim().toLowerCase() === key)) return t('This keyword already exists at this level.');
  return null;
}

// Erreurs de la commande create_keyword : codes courts du backend traduits, autre erreur affichée telle quelle.
function describeKeywordError(error) {
  const code = String(error);
  if (code === 'duplicate') return t('This keyword already exists at this level.');
  if (code === 'invalid_name') return t('A keyword name cannot contain “/”, “|” or “,”.');
  return code;
}

// Fenêtre de saisie du nom d'un mot-clé (création ou renommage) : rappelle le parent ; `validate(nom)` renvoie un message d'erreur ou null.
// Pendant la saisie, une liste au-dessus du champ montre les mots-clés existants dont le nom correspond (hiérarchie complète, le plus fréquent
// le plus près du champ) ; en choisir un reprend son nom. Entrée valide, Échap ferme la liste puis la fenêtre. Renvoie le nom, ou null si annulé.
function nameDialog({ title, parentLabel, validate, initialValue = '', confirmLabel = t('Create'), excludeId = null }) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const card = document.createElement('div');
    card.className = 'modal-card keyword-dialog';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h3');
    heading.textContent = title;
    const parentLine = document.createElement('p');
    parentLine.textContent = `${labelWithColon('Parent')} ${parentLabel}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'keyword-input keyword-dialog-input';
    input.placeholder = t('Keyword name');
    input.setAttribute('aria-label', t('Keyword name'));
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = initialValue;
    const wrap = document.createElement('div');
    wrap.className = 'keyword-input-wrap';
    const matchList = document.createElement('ul');
    matchList.className = 'keyword-suggestions';
    matchList.setAttribute('role', 'listbox');
    matchList.hidden = true;
    wrap.append(matchList, input);
    let matches = [];
    let matchIndex = -1; // ligne choisie au clavier (0 = la plus fréquente), -1 = aucune
    const hideMatches = () => {
      matches = [];
      matchIndex = -1;
      matchList.hidden = true;
    };
    const pickMatch = node => {
      input.value = node.name;
      errorLine.textContent = '';
      hideMatches();
      input.focus();
    };
    const renderMatches = () => {
      if (matches.length === 0) {
        matchList.hidden = true;
        return;
      }
      matchList.hidden = false;
      const rows = matches.map((node, index) => {
        const row = document.createElement('li');
        row.className = 'keyword-suggestion';
        row.setAttribute('role', 'option');
        if (index === matchIndex) row.classList.add('highlighted');
        const label = document.createElement('span');
        label.textContent = pathLabel(node);
        const count = document.createElement('span');
        count.className = 'keyword-suggestion-count';
        count.textContent = String(usageById.get(node.id) || 0);
        row.append(label, count);
        // mousedown plutôt que click : le champ garde le focus (sinon la liste se fermerait avant le clic).
        row.addEventListener('mousedown', event => {
          event.preventDefault();
          pickMatch(node);
        });
        return row;
      }).reverse();
      matchList.replaceChildren(...rows);
      matchList.querySelector('.highlighted')?.scrollIntoView({ block: 'nearest' });
    };
    const updateMatches = () => {
      const query = normalizeSearch(input.value.trim());
      matches = query
        ? [...nodeById.values()].filter(node => node.id !== excludeId && node.search.includes(query)).sort(compareByUsage).slice(0, MAX_SUGGESTIONS)
        : [];
      matchIndex = -1;
      renderMatches();
      matchList.scrollTop = matchList.scrollHeight;
    };
    const errorLine = document.createElement('p');
    errorLine.className = 'keyword-dialog-error';
    errorLine.setAttribute('role', 'alert');
    const actions = document.createElement('div');
    actions.className = 'keyword-dialog-actions';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.textContent = t('Cancel');
    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.className = 'active';
    createButton.textContent = confirmLabel;
    actions.append(cancelButton, createButton);
    const close = value => {
      document.removeEventListener('keydown', onKeyDown, true);
      modal.remove();
      resolve(value);
    };
    const submit = () => {
      const name = input.value.trim();
      const problem = validate(name);
      if (problem) {
        errorLine.textContent = problem;
        input.focus();
        return;
      }
      close(name);
    };
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (!matchList.hidden) {
        hideMatches();
        return;
      }
      close(null);
    };
    input.addEventListener('keydown', event => {
      const open = !matchList.hidden && matches.length > 0;
      if (event.key === 'ArrowUp' && open) {
        event.preventDefault();
        matchIndex = Math.min(matchIndex + 1, matches.length - 1); // vers le moins fréquent, donc vers le haut de la liste
        renderMatches();
      } else if (event.key === 'ArrowDown' && open) {
        event.preventDefault();
        matchIndex = Math.max(matchIndex - 1, -1);
        renderMatches();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (open && matchIndex >= 0) pickMatch(matches[matchIndex]); else submit();
      }
    });
    input.addEventListener('input', () => {
      errorLine.textContent = '';
      updateMatches();
    });
    input.addEventListener('blur', hideMatches);
    cancelButton.addEventListener('click', () => close(null));
    createButton.addEventListener('click', submit);
    card.append(heading, parentLine, wrap, errorLine, actions);
    modal.append(card);
    document.addEventListener('keydown', onKeyDown, true);
    (document.getElementById('app') || document.body).append(modal);
    input.focus();
    input.select();
  });
}

// Création d'un mot-clé enfant (parentId 0 = premier niveau). Créé tout de suite dans l'arbre s'il n'existe pas ailleurs ; sinon confirmation
// en précisant les hiérarchies où il existe déjà. Une fois créé, il est activé sur la sélection (modification en attente, comme un clic sur sa case).
async function createKeywordFlow(parentId) {
  const parent = parentId === ROOT_ID ? null : nodeById.get(parentId);
  const name = await nameDialog({
    title: t('Create a child keyword'),
    parentLabel: parent ? pathLabel(parent) : t('Root'),
    validate: candidate => validateKeywordName(candidate, parentId),
  });
  if (name === null) return;
  if (!(await confirmHomonyms(name, null, t('Create it here anyway?'), t('Create')))) return;
  try {
    const node = await invoke('create_keyword', { parentId, name });
    registerNode(node);
    if (parentId !== ROOT_ID) expandedIds.add(parentId);
    if (working.size > 0) activateKeyword(node.id, false);
    else renderTree();
  } catch (error) {
    host.showToast(t('Could not create the keyword: {error}', { error: describeKeywordError(error) }));
  }
}

// Suppression d'un mot-clé (et de son sous-arbre) : confirmation indiquant le nombre de photos concernées, puis retrait des fichiers.
async function deleteKeywordFlow(node) {
  if (isWriteLocked()) {
    host.showToast(t('Keyword writing in progress…'));
    return;
  }
  let info;
  try {
    info = await invoke('get_keyword_delete_info', { keywordId: node.id });
  } catch (error) {
    host.showToast(t('Could not delete the keyword: {error}', { error: String(error) }));
    return;
  }
  const lines = [info.photo_count > 0
    ? tp('Keyword “{name}” will be deleted and removed from {count} photo.', info.photo_count, { name: node.name })
    : t('Keyword “{name}” will be deleted.', { name: node.name })];
  if (info.keyword_count > 1) lines.push(tp('Its {count} sub-keyword will be deleted too.', info.keyword_count - 1));
  const choice = await choiceDialog({
    title: t('Delete keyword'),
    message: lines.join('\n'),
    buttons: [
      { label: t('Cancel'), value: 'cancel', cancel: true },
      { label: t('Delete'), value: 'delete', primary: true },
    ],
  });
  if (choice === 'delete') await runKeywordDelete(node, info.photo_count);
}

// Confirmation quand ce nom existe déjà ailleurs dans l'arbre (hors `excludeId`) : liste les hiérarchies où il existe. Renvoie true s'il faut continuer.
async function confirmHomonyms(name, excludeId, question, actionLabel) {
  const key = name.toLowerCase();
  const homonyms = [...nodeById.values()].filter(node => node.id !== excludeId && node.name.trim().toLowerCase() === key);
  if (homonyms.length === 0) return true;
  const shown = homonyms.slice(0, 8).map(node => `• ${pathLabel(node)}`);
  if (homonyms.length > shown.length) shown.push(t('… and {count} more', { count: homonyms.length - shown.length }));
  const choice = await choiceDialog({
    title: t('Keyword already exists'),
    message: `${t('A keyword named “{name}” already exists here:', { name })}\n${shown.join('\n')}\n${question}`,
    buttons: [
      { label: t('Cancel'), value: 'cancel', cancel: true },
      { label: actionLabel, value: 'go', primary: true },
    ],
  });
  return choice === 'go';
}

// Renommage d'un mot-clé : même fenêtre que la création (liste des mots-clés existants, confirmation si le nom existe déjà ailleurs dans l'arbre).
// Les fichiers de toutes les photos qui portent ce mot-clé ou l'un de ses descendants sont réécrits (leur chemin hiérarchique change).
async function renameKeywordFlow(node) {
  if (isWriteLocked()) {
    host.showToast(t('Keyword writing in progress…'));
    return;
  }
  const parent = node.parent_id === ROOT_ID ? null : nodeById.get(node.parent_id);
  const name = await nameDialog({
    title: t('Rename keyword'),
    parentLabel: parent ? pathLabel(parent) : t('Root'),
    initialValue: node.name,
    confirmLabel: t('Rename'),
    excludeId: node.id,
    validate: candidate => validateKeywordName(candidate, node.parent_id, node.id),
  });
  if (name === null || name === node.name) return;
  if (!(await confirmHomonyms(name, node.id, t('Rename it here anyway?'), t('Rename')))) return;
  let photoCount = 0;
  try {
    photoCount = (await invoke('get_keyword_delete_info', { keywordId: node.id })).photo_count;
  } catch (error) {
    console.error('Comptage des photos impossible', error);
  }
  await runKeywordRename(node, name, photoCount);
}

function runKeywordRename(node, name, photoCount) {
  return runLocked('rename_keyword', { keywordId: node.id, name }, photoCount, (entry, result, error) => finishRename(entry, node, name, photoCount, result, error));
}

// Fin d'un renommage. L'arbre est renommé dès le début de l'opération, même si certains fichiers n'ont pas pu être réécrits (« Retenter » les reprend).
async function finishRename(entry, node, name, photoCount, result, error) {
  if (entry.settled) return;
  entry.settled = true;
  updateButtons();
  if (!result) {
    if (error) host.showToast(t('Could not rename the keyword: {error}', { error: describeKeywordError(error) }));
    return;
  }
  buildTree([...nodeById.values()].map(candidate => (candidate.id === node.id ? { ...candidate, name } : candidate)));
  renderTree();
  updateButtons();
  if (result.written.length) host.updatePhotoKeywords(new Map(result.written.map(written => [written.photo_id, written.keywords])));
  if (result.failed.length) await showFailureDialog(result, () => runKeywordRename({ ...node, name }, name, photoCount));
  else if (result.cancelled) host.showToast(t('Keyword writing stopped: {count} not processed', { count: result.cancelled }));
  else host.showToast(t('Keyword renamed to “{name}”', { name }));
}

// ---------------------------------------------------------------------------
// Priorité de lecture des formats hiérarchiques (Paramètres, onglet Mots-clés)
// ---------------------------------------------------------------------------

const FORMAT_ORDER_STORAGE_KEY = 'keywordFormatOrder';
// Les quatre formats de mots-clés hiérarchiques lus. Le premier de la liste qui contient des données l'emporte : ses mots-clés alimentent l'arbre
// et s'affichent, les autres sont ignorés. L'ordre par défaut est celui ci-dessous ; l'utilisateur le règle.
const HIERARCHY_FORMATS = [
  { id: 'digikam', label: 'digiKam', property: 'digiKam:TagsList' },
  { id: 'lightroom', label: 'Adobe Lightroom', property: 'lr:hierarchicalSubject' },
  { id: 'mediapro', label: 'Media Pro', property: 'mediapro:CatalogSets' },
  { id: 'microsoft', label: 'Microsoft Photo', property: 'MicrosoftPhoto:LastKeywordXMP' },
];
const DEFAULT_FORMAT_ORDER = HIERARCHY_FORMATS.map(format => format.id);

function loadFormatOrder() {
  try {
    const stored = JSON.parse(localStorage.getItem(FORMAT_ORDER_STORAGE_KEY));
    if (Array.isArray(stored) && stored.length === DEFAULT_FORMAT_ORDER.length && DEFAULT_FORMAT_ORDER.every(id => stored.includes(id))) return stored;
  } catch {
    // valeur absente ou illisible : ordre par défaut
  }
  return [...DEFAULT_FORMAT_ORDER];
}

let formatOrder = loadFormatOrder();
let formatListElement = null;

// Envoie l'ordre au backend, qui l'applique aux prochaines lectures de fichiers (scan, relecture, synchronisation).
function sendFormatOrder() {
  invoke('set_keyword_format_order', { order: formatOrder }).catch(error => console.error('Ordre des formats de mots-clés refusé', error));
}

function saveFormatOrder(order) {
  formatOrder = order;
  localStorage.setItem(FORMAT_ORDER_STORAGE_KEY, JSON.stringify(order));
  sendFormatOrder();
  renderFormatOrder();
}

function moveFormat(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= formatOrder.length) return;
  const order = [...formatOrder];
  [order[index], order[target]] = [order[target], order[index]];
  saveFormatOrder(order);
}

function makeMoveButton(symbol, label, disabled, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'keyword-format-move';
  button.textContent = symbol;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.addEventListener('click', action);
  return button;
}

// Glisser la poignée : la ligne change de place dès que le pointeur passe le milieu d'une voisine ; l'ordre n'est enregistré qu'au relâchement.
// (Evènements pointeur plutôt que glisser-déposer HTML5, que le dépôt de fichiers de la fenêtre Tauri intercepte.)
function startFormatDrag(event, item, handle) {
  if (event.button !== 0) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  item.classList.add('dragging');
  const onMove = moveEvent => {
    const previous = item.previousElementSibling;
    const next = item.nextElementSibling;
    if (previous) {
      const rect = previous.getBoundingClientRect();
      if (moveEvent.clientY < rect.top + rect.height / 2) formatListElement.insertBefore(item, previous);
    }
    if (next) {
      const rect = next.getBoundingClientRect();
      if (moveEvent.clientY > rect.top + rect.height / 2) formatListElement.insertBefore(next, item);
    }
  };
  const onEnd = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onEnd);
    handle.removeEventListener('pointercancel', onEnd);
    item.classList.remove('dragging');
    const order = [...formatListElement.children].map(child => child.dataset.formatId);
    if (order.join() !== formatOrder.join()) saveFormatOrder(order);
    else renderFormatOrder();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onEnd);
  handle.addEventListener('pointercancel', onEnd);
}

function renderFormatOrder() {
  if (!formatListElement) return;
  const items = formatOrder.map((id, index) => {
    const format = HIERARCHY_FORMATS.find(candidate => candidate.id === id);
    const item = document.createElement('li');
    item.className = 'keyword-format-item';
    item.dataset.formatId = id;
    const handle = document.createElement('span');
    handle.className = 'keyword-format-handle';
    handle.textContent = '⠿';
    handle.title = t('Drag to reorder');
    handle.addEventListener('pointerdown', event => startFormatDrag(event, item, handle));
    const rank = document.createElement('span');
    rank.className = 'keyword-format-rank';
    rank.textContent = `${index + 1}.`;
    const name = document.createElement('span');
    name.className = 'keyword-format-name';
    name.textContent = format.label;
    const property = document.createElement('code');
    property.className = 'keyword-format-property';
    property.textContent = format.property;
    item.append(
      handle,
      rank,
      name,
      property,
      makeMoveButton('↑', t('Move up'), index === 0, () => moveFormat(index, -1)),
      makeMoveButton('↓', t('Move down'), index === formatOrder.length - 1, () => moveFormat(index, 1)),
    );
    return item;
  });
  formatListElement.replaceChildren(...items);
}

// Fermeture de l'application (appelée par main.js) : renvoie true si elle peut se poursuivre. Des mots-clés non écrits donnent lieu à
// Appliquer / Quitter sans appliquer / Annuler ; une écriture en cours à une confirmation, car quitter l'interrompt.
export async function confirmCloseWithPendingKeywords() {
  if (!initialized) return true;
  if (promptOpen) return false; // une question est déjà posée : on y répond d'abord
  const locked = isWriteLocked();
  if (dirtyIds.size === 0 && !locked) return true;
  promptOpen = true;
  let decision;
  try {
    if (dirtyIds.size === 0) {
      const choice = await choiceDialog({
        title: t('Keyword writing in progress'),
        message: t('Quitting now interrupts the writing of keywords into the files. Quit anyway?'),
        buttons: [
          { label: t('Cancel'), value: 'cancel', cancel: true },
          { label: t('Quit'), value: 'quit' },
        ],
      });
      return choice === 'quit';
    }
    if (!locked && isAutoApply()) {
      decision = 'apply';
    } else {
      const buttons = [];
      if (!locked) buttons.push({ label: t('Apply'), value: 'apply', primary: true });
      buttons.push({ label: t('Quit without applying'), value: 'quit', primary: locked });
      buttons.push({ label: t('Cancel'), value: 'cancel', cancel: true });
      decision = await choiceDialog({
        title: t('Pending keyword changes'),
        message: t(locked
          ? 'Keyword changes are not written to the files yet, and another write is in progress. Quit anyway?'
          : 'Keyword changes are not written to the files yet. Apply them before quitting?'),
        buttons,
      });
    }
  } finally {
    promptOpen = false;
  }
  if (decision === 'quit') return true;
  if (decision !== 'apply') return false;
  // Écriture directe (jamais par la file, qui serait interrompue par la fermeture) ; la fenêtre reste ouverte si elle ne réussit pas entièrement.
  lastWriteOk = false;
  await applyChanges({ forceDirect: true });
  return lastWriteOk;
}

function runKeywordDelete(node, photoCount) {
  const ids = [node.id, ...descendantIds(node.id)];
  return runLocked('delete_keyword', { keywordId: node.id }, photoCount, (entry, result, error) => finishDelete(entry, node, photoCount, ids, result, error));
}

// Fin d'une suppression. Les photos écrites ne portent plus le mot-clé ; il ne quitte l'arbre que si plus aucun fichier ne le porte (`result.deleted`).
async function finishDelete(entry, node, photoCount, ids, result, error) {
  if (entry.settled) return;
  entry.settled = true;
  updateButtons();
  if (!result) {
    if (error) host.showToast(t('Could not delete the keyword: {error}', { error: String(error) }));
    return;
  }
  const removedIds = new Set(ids);
  const writtenIds = new Set(result.written.map(written => written.photo_id));
  for (const sets of [baseline, working]) {
    for (const [photoId, set] of sets) {
      if (result.deleted || writtenIds.has(photoId)) for (const id of removedIds) set.delete(id);
    }
  }
  if (result.deleted) {
    buildTree([...nodeById.values()].filter(candidate => !removedIds.has(candidate.id)));
    for (const id of removedIds) expandedIds.delete(id);
  }
  usageDirty = true;
  recomputeCounts();
  renderTree();
  updateButtons();
  if (result.written.length) host.updatePhotoKeywords(new Map(result.written.map(written => [written.photo_id, written.keywords])));
  refreshUsage();
  if (result.failed.length) await showFailureDialog(result, () => runKeywordDelete(node, photoCount));
  else if (result.cancelled) host.showToast(t('Keyword writing stopped: {count} not processed', { count: result.cancelled }));
  else host.showToast(t('Keyword “{name}” deleted', { name: node.name }));
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

// Services fournis par main.js : getSelectedPhotos, showToast, enqueueKeywordTask, isTaskQueued, updatePhotoKeywords,
// findIndicesByPhotoIds, setSelectionIndices, showFailedFiles.
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
  inputField = document.getElementById('keyword-input');
  suggestionList = document.getElementById('keyword-suggestions');
  applyButton = document.getElementById('btn-keyword-apply');
  resetButton = document.getElementById('btn-keyword-reset');
  unifyButton = document.getElementById('btn-keyword-unify');
  if (![exifPanel, toggleButton, infoTabButton, keywordsTabButton, infoPane, keywordsPane, treeList, modeButton, inputField, suggestionList, applyButton, resetButton, unifyButton].every(Boolean)) {
    console.error('Panneau des mots-clés : éléments introuvables dans index.html');
    return;
  }
  initialized = true;

  infoTabButton.addEventListener('click', () => setTab('info'));
  keywordsTabButton.addEventListener('click', () => { if (!keywordsTabButton.disabled) setTab('keywords'); });
  modeButton.addEventListener('click', toggleFilterMode);
  applyButton.addEventListener('click', applyChanges);
  resetButton.addEventListener('click', resetChanges);
  unifyButton.addEventListener('click', unifySelection);
  inputField.addEventListener('input', updateSuggestions);
  inputField.addEventListener('focus', updateSuggestions);
  inputField.addEventListener('blur', closeSuggestions);
  inputField.addEventListener('keydown', onInputKeyDown);
  treeList.addEventListener('contextmenu', onTreeContextMenu);

  // Réglage « Appliquer automatiquement les changements de mots-clés » (onglet Mots-clés des Paramètres).
  const autoApplyBox = document.getElementById('keywords-auto-apply');
  if (autoApplyBox) {
    autoApplyBox.checked = isAutoApply();
    autoApplyBox.addEventListener('change', () => localStorage.setItem(AUTO_APPLY_STORAGE_KEY, String(autoApplyBox.checked)));
  }

  // Priorité de lecture des formats hiérarchiques : liste ordonnable des Paramètres, ordre transmis au backend dès le démarrage (avant tout scan).
  formatListElement = document.getElementById('keyword-format-order');
  renderFormatOrder();
  sendFormatOrder();

  // Ctrl+K (filtre d'affichage) et Ctrl+Entrée (Appliquer) : actifs même quand un champ de saisie a le focus
  // (le gestionnaire de touches de main.js ignore les champs de saisie).
  window.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'k' && event.key !== 'Enter') return;
    if (!isKeywordsTabVisible() || document.querySelector('.modal:not(.hidden)')) return;
    event.preventDefault();
    if (event.repeat) return;
    if (key === 'k') toggleFilterMode(); else applyChanges();
  });

  // Le panneau est affiché ou masqué par main.js (classe « hidden ») : l'onglet Mots-clés se met à jour dès qu'il devient visible.
  new MutationObserver(() => refreshKeywordsPanel()).observe(exifPanel, { attributes: true, attributeFilter: ['class'] });

  onLanguageChange(() => {
    renderFormatOrder();
    applyTab();
    updateModeButton();
    updateButtons();
    renderTree();
  });
  updateModeButton();
  updateButtons();
  applyTab();
}
