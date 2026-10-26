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
import { t, tp, onLanguageChange } from './i18n.js';

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

async function applyChanges() {
  if (!initialized || isWriteLocked() || dirtyIds.size === 0) return;
  // Photos dont les mots-clés ont changé uniquement : on envoie l'ensemble final des mots-clés actifs de chacune.
  const items = [...dirtyIds].map(id => ({ photo_id: id, path: workingPhotos.get(id).path, keyword_ids: [...working.get(id)] }));
  await runKeywordWrite(items);
}

async function runKeywordWrite(items) {
  const entry = { task: null, settled: false };
  if (items.length >= QUEUE_THRESHOLD) {
    // Beaucoup de fichiers : tâche de la file, avec progression et arrêt possible ; « Appliquer » reste grisé jusqu'à sa fin.
    const task = host.enqueueKeywordWrite(items, (result, stopped, error) => finishWrite(entry, items, result, error));
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
    const result = await invoke('apply_keyword_changes', { items });
    await finishWrite(entry, items, result, null);
  } catch (error) {
    await finishWrite(entry, items, null, error);
  } finally {
    directWrites -= 1;
    updateButtons();
  }
}

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
  if (result.failed.length) await showFailureDialog(items, result);
  else if (result.cancelled) host.showToast(t('Keyword writing stopped: {count} not processed', { count: result.cancelled }));
  else host.showToast(tp('Keywords written in {count} file', result.written.length));
}

async function showFailureDialog(items, result) {
  const failedIds = new Set(result.failed.map(failure => failure.photo_id));
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
    await runKeywordWrite(items.filter(item => failedIds.has(item.photo_id)));
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
    if (sameAsWorking(photos) && loadedTreeVersion === treeVersion && !usageDirty) {
      // Même sélection : les modifications en attente sont conservées, on réaffiche seulement.
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
// Initialisation
// ---------------------------------------------------------------------------

// Services fournis par main.js : getSelectedPhotos, showToast, enqueueKeywordWrite, isTaskQueued, updatePhotoKeywords,
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
    applyTab();
    updateModeButton();
    updateButtons();
    renderTree();
  });
  updateModeButton();
  updateButtons();
  applyTab();
}
