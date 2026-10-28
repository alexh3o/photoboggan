// Écriture des métadonnées éditées dans le panneau de droite (onglets Mots-clés et Description) : un seul circuit pour les deux onglets.
//
// Chaque onglet est un « éditeur » qui garde ses modifications en attente (voir registerEditor). « Appliquer », Ctrl+Entrée, le changement de
// sélection (après confirmation, ou automatiquement selon le réglage) et la fermeture de l'application écrivent en une seule fois tout ce qui
// attend dans les deux onglets : un fichier n'est réécrit qu'une fois, avec ses mots-clés, son titre et sa description (commande
// apply_metadata_changes, voir keywords.rs). Une seule écriture à la fois : « Appliquer » est grisé tant qu'elle dure.

import { invoke } from '@tauri-apps/api/core';
import { t, tp } from './i18n.js';

const AUTO_APPLY_STORAGE_KEY = 'keywordsAutoApply'; // réglage « Appliquer automatiquement les modifications » (Paramètres, onglet Métadonnées)
const QUEUE_THRESHOLD = 20; // à partir de ce nombre de fichiers, l'écriture passe par la file de tâches

let host = null; // services de main.js, voir initMetadataWrites
const editors = [];
let directWrites = 0; // écritures directes (moins de QUEUE_THRESHOLD fichiers) en cours
const queuedWrites = []; // écritures passées par la file de tâches : { task, settled }
let lockTimer = null;
const lockListeners = new Set();
let lastWriteOk = false; // la dernière écriture directe s'est terminée sans échec ni arrêt (utile à la fermeture de l'application)
let pendingPrompt = null; // question en cours au changement de sélection (partagée par les deux onglets)
let promptOpen = false;

export const isAutoApply = () => localStorage.getItem(AUTO_APPLY_STORAGE_KEY) === 'true';
const fileName = path => String(path).split(/[\\/]/).pop();

// Services fournis par main.js : showToast, enqueueKeywordTask, isTaskQueued, updatePhotoMetadata, findIndicesByPhotoIds, setSelectionIndices,
// showFailedFiles.
export function initMetadataWrites(hostApi) {
  host = hostApi;
  const autoApplyBox = document.getElementById('keywords-auto-apply');
  if (autoApplyBox) {
    autoApplyBox.checked = isAutoApply();
    autoApplyBox.addEventListener('change', () => localStorage.setItem(AUTO_APPLY_STORAGE_KEY, String(autoApplyBox.checked)));
  }
}

/// Inscrit un onglet éditeur : { isDirty(), targetIds(), pendingItems() -> [{ photo_id, path, keyword_ids? , title?, description? }],
/// afterWrite(result, items), discard() }.
export function registerEditor(editor) {
  editors.push(editor);
}

export const isPromptOpen = () => promptOpen;
export const hasPendingEdits = () => editors.some(editor => editor.isDirty());

// ---------------------------------------------------------------------------
// Verrou d'écriture
// ---------------------------------------------------------------------------

// Tant qu'une écriture est en cours (directe, ou tâche en attente / en cours dans la file), « Appliquer » et Ctrl+Entrée sont inactifs.
export function isWriteLocked() {
  return directWrites > 0 || queuedWrites.some(entry => !entry.settled && host.isTaskQueued(entry.task));
}

/// `listener()` est appelé à chaque changement possible du verrou (les onglets mettent leurs boutons à jour).
export function onLockChange(listener) {
  lockListeners.add(listener);
}

function notifyLock() {
  for (const listener of lockListeners) listener();
}

// Surveille la file de tâches tant qu'une écriture est en attente : une tâche retirée de la file libère le verrou sans autre signal.
function watchLock() {
  if (lockTimer !== null) return;
  lockTimer = setInterval(() => {
    notifyLock();
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
export function choiceDialog({ title, message, buttons }) {
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

// Lance une opération qui réécrit des fichiers (application des modifications, suppression ou renommage d'un mot-clé), verrou d'écriture pris
// pendant sa durée. `count` photos ≥ QUEUE_THRESHOLD : tâche de la file, avec progression et arrêt possible (sauf `forceDirect`) ; sinon commande
// directe. `finish(entry, resultat, erreur)` traite la fin ; `resultat` vaut null si la commande a échoué ou si la tâche a été retirée de la file.
export async function runLocked(command, args, count, finish, { forceDirect = false } = {}) {
  const entry = { task: null, settled: false };
  const settle = async (result, error) => {
    if (entry.settled) return;
    entry.settled = true;
    notifyLock();
    await finish(result, error);
  };
  if (!forceDirect && count >= QUEUE_THRESHOLD) {
    const task = host.enqueueKeywordTask(command, args, count, (result, stopped, error) => settle(result, error));
    if (!task) {
      host.showToast(t('Metadata writing could not be queued'));
      return;
    }
    entry.task = task;
    queuedWrites.push(entry);
    watchLock();
    notifyLock();
    return;
  }
  directWrites += 1;
  notifyLock();
  host.showToast(t('Writing metadata…'));
  try {
    const result = await invoke(command, args);
    await settle(result, null);
  } catch (error) {
    await settle(null, error);
  } finally {
    directWrites -= 1;
    notifyLock();
  }
}

/// Écrit tout ce qui attend dans les onglets éditeurs : les éléments d'une même photo sont réunis en une seule écriture.
export async function applyPending(options) {
  if (isWriteLocked()) return;
  const merged = new Map();
  for (const editor of editors) {
    if (!editor.isDirty()) continue;
    for (const item of editor.pendingItems()) {
      merged.set(item.photo_id, { ...merged.get(item.photo_id), ...item });
    }
  }
  const items = [...merged.values()];
  if (items.length) await runWrite(items, options);
}

const runWrite = (items, options) => runLocked('apply_metadata_changes', { items }, items.length, (result, error) => finishWrite(items, result, error), options);

/// Valeurs relues dans les fichiers écrits (mots-clés à plat, titre, description) : reportées dans les listes de photos de main.js.
export function publishWritten(written) {
  if (written.length) host.updatePhotoMetadata(written);
}

async function finishWrite(items, result, error) {
  if (!result) {
    if (error) host.showToast(t('Metadata writing failed: {error}', { error: String(error) }));
    return;
  }
  for (const editor of editors) editor.afterWrite(result, items);
  publishWritten(result.written);
  if (result.failed.length) {
    const failedIds = new Set(result.failed.map(failure => failure.photo_id));
    await showFailureDialog(result, () => runWrite(items.filter(item => failedIds.has(item.photo_id))));
  }
  else if (result.cancelled) host.showToast(t('Metadata writing stopped: {count} not processed', { count: result.cancelled }));
  else { lastWriteOk = true; host.showToast(tp('Metadata written in {count} file', result.written.length)); }
}

// `retry` relance l'opération pour les fichiers en échec (nouvelle application des modifications, ou nouvelle suppression du mot-clé).
export async function showFailureDialog(result, retry) {
  const details = result.failed.slice(0, 3).map(failure => `${fileName(failure.path)} : ${failure.error}`).join('\n');
  const choice = await choiceDialog({
    title: t('Metadata could not be written to some files'),
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
    // La vue des miniatures ne montre plus que les fichiers en échec ; les modifications en attente sont abandonnées (les fichiers n'ont pas changé).
    for (const editor of editors) editor.discard();
    host.showFailedFiles(result.failed.map(failure => failure.path));
  }
}

// ---------------------------------------------------------------------------
// Changement de sélection et fermeture de l'application
// ---------------------------------------------------------------------------

const sameIds = (ids, others) => ids.length === others.length && ids.every(id => others.includes(id));

/// Appelée par un onglet avant de se recharger pour la sélection `currentIds` : si des modifications en attente (d'un onglet ou de l'autre) visent
/// une autre sélection, demande Appliquer / Ignorer / Annuler (revenir à la sélection précédente). Renvoie « cancel » si la sélection précédente
/// est rétablie (l'onglet ne doit pas se recharger), « proceed » sinon. Une seule question à la fois, partagée par les onglets.
export function resolvePendingSelection(currentIds) {
  if (pendingPrompt) return pendingPrompt;
  const stale = editors.filter(editor => editor.isDirty() && !sameIds(editor.targetIds(), currentIds));
  if (!stale.length) return Promise.resolve('proceed');
  pendingPrompt = (async () => {
    const previousIndices = host.findIndicesByPhotoIds(stale[0].targetIds());
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
      return 'cancel';
    }
    if (decision === 'apply') await applyPending();
    else for (const editor of stale) editor.discard();
    return 'proceed';
  })();
  return pendingPrompt.finally(() => { pendingPrompt = null; });
}

// `canCancel` : la sélection précédente peut être retrouvée. `locked` : une écriture est déjà en cours, on ne peut pas en lancer une autre.
async function askPendingDecision(canCancel, locked) {
  if (!locked && isAutoApply()) return 'apply';
  const buttons = [];
  if (!locked) buttons.push({ label: t('Apply'), value: 'apply', primary: true });
  buttons.push({ label: t('Ignore'), value: 'ignore', primary: locked });
  if (canCancel) buttons.push({ label: t('Cancel'), value: 'cancel', cancel: true });
  return choiceDialog({
    title: t('Pending changes'),
    message: t(locked
      ? 'Keyword, title or description changes are not written to the files yet, and another write is in progress. Ignore them?'
      : 'Keyword, title or description changes are not written to the files yet. Apply them before changing the selection?'),
    buttons,
  });
}

// Fermeture de l'application (appelée par main.js) : renvoie true si elle peut se poursuivre. Des modifications non écrites donnent lieu à
// Appliquer / Quitter sans appliquer / Annuler ; une écriture en cours à une confirmation, car quitter l'interrompt.
export async function confirmCloseWithPendingEdits() {
  if (!host) return true;
  if (promptOpen) return false; // une question est déjà posée : on y répond d'abord
  const locked = isWriteLocked();
  const dirty = hasPendingEdits();
  if (!dirty && !locked) return true;
  promptOpen = true;
  let decision;
  try {
    if (!dirty) {
      const choice = await choiceDialog({
        title: t('Metadata writing in progress'),
        message: t('Quitting now interrupts the writing of metadata into the files. Quit anyway?'),
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
        title: t('Pending changes'),
        message: t(locked
          ? 'Keyword, title or description changes are not written to the files yet, and another write is in progress. Quit anyway?'
          : 'Keyword, title or description changes are not written to the files yet. Apply them before quitting?'),
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
  await applyPending({ forceDirect: true });
  return lastWriteOk;
}
