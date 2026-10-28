// Onglet Description du panneau de droite (touche D) : titre et description des photos sélectionnées.
//
// Comme pour les mots-clés, la saisie reste « en attente » jusqu'à « Appliquer », Ctrl+Entrée, le changement de sélection (après confirmation,
// ou automatiquement selon le réglage) ou la fermeture : l'écriture passe par metadata-writes.js, en même temps que les mots-clés en attente.
// Plusieurs photos aux valeurs différentes : le champ est vide avec l'indication « Valeurs multiples » ; ce qui y est saisi remplace la valeur
// de toutes les photos. Un champ non touché n'est jamais écrit.
//
// Les valeurs affichées viennent de la base (colonnes `title` et `caption`), qui reflète le fichier selon l'ordre de priorité des sources réglé
// dans les Paramètres (onglet Métadonnées, voir metadata-settings.js).

import { invoke } from '@tauri-apps/api/core';
import { t, onLanguageChange } from './i18n.js';
import { registerEditor, onLockChange, isWriteLocked, applyPending, hasPendingEdits, resolvePendingSelection, isPromptOpen } from './metadata-writes.js';

let host = null; // services de main.js, voir initDescriptionPanel
let initialized = false;
let exifPanel;
let pane;
let titleField;
let descriptionField;
let applyButton;
let resetButton;

// Photos ciblées (la sélection au moment du chargement) : valeurs enregistrées, par identifiant de photo.
let targets = new Map(); // identifiant -> { id, path, title, description }
// Valeurs saisies : null tant que le champ n'a pas été modifié (il n'est alors pas écrit).
let editedTitle = null;
let editedDescription = null;
let refreshScheduled = false;
let refreshAfterPrompt = false;

// Mêmes règles que le backend (exif.rs, clean_title / clean_text) : le titre tient sur une ligne, espaces de début et de fin retirés.
const cleanTitle = value => value.replace(/[\r\n]+/g, ' ').trim();
const cleanDescription = value => value.replace(/\r\n?/g, '\n').trim();

const isVisible = () => initialized && !exifPanel.classList.contains('hidden') && !pane.hidden;
const currentTarget = () => host.getSelectedPhotos().filter(photo => Number.isFinite(photo.id) && photo.id > 0);
const sameAsTargets = photos => photos.length === targets.size && photos.every(photo => targets.has(photo.id));

const titleChangedFor = target => editedTitle !== null && cleanTitle(editedTitle) !== target.title;
const descriptionChangedFor = target => editedDescription !== null && cleanDescription(editedDescription) !== target.description;

function isDirty() {
  for (const target of targets.values()) if (titleChangedFor(target) || descriptionChangedFor(target)) return true;
  return false;
}

// Valeur commune aux photos ciblées, ou null si elles diffèrent.
function commonValue(field) {
  const values = [...targets.values()].map(target => target[field]);
  return values.every(value => value === values[0]) ? (values[0] ?? '') : null;
}

// ---------------------------------------------------------------------------
// Onglet inscrit auprès de metadata-writes.js
// ---------------------------------------------------------------------------

const descriptionEditor = {
  isDirty,
  targetIds: () => [...targets.keys()],
  // Seuls les champs modifiés, et seulement pour les photos dont la valeur change.
  pendingItems() {
    const items = [];
    for (const target of targets.values()) {
      const item = { photo_id: target.id, path: target.path };
      if (titleChangedFor(target)) item.title = cleanTitle(editedTitle);
      if (descriptionChangedFor(target)) item.description = cleanDescription(editedDescription);
      if ('title' in item || 'description' in item) items.push(item);
    }
    return items;
  },
  // Les valeurs relues dans les fichiers écrits deviennent l'état enregistré ; la saisie est conservée tant qu'il reste quelque chose à écrire.
  afterWrite(result) {
    for (const written of result.written) {
      const target = targets.get(written.photo_id);
      if (!target) continue;
      target.title = written.title;
      target.description = written.description;
    }
    if (!isDirty()) {
      editedTitle = null;
      editedDescription = null;
    }
    render();
  },
  discard() {
    editedTitle = null;
    editedDescription = null;
    render();
  },
};

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

function renderField(field, edited, common) {
  field.value = edited ?? common ?? '';
  field.placeholder = edited === null && common === null ? t('Multiple values') : '';
  field.disabled = targets.size === 0;
}

function render() {
  if (!initialized) return;
  renderField(titleField, editedTitle, commonValue('title'));
  renderField(descriptionField, editedDescription, commonValue('description'));
  updateState();
}

// Boutons et marque « modifié » des champs (sans toucher à leur contenu, pour ne pas gêner la saisie).
function updateState() {
  if (!initialized) return;
  const values = [...targets.values()];
  titleField.classList.toggle('pending', values.some(titleChangedFor));
  descriptionField.classList.toggle('pending', values.some(descriptionChangedFor));
  const locked = isWriteLocked();
  // « Appliquer » écrit aussi les mots-clés en attente (onglet Mots-clés).
  applyButton.disabled = !hasPendingEdits() || locked;
  applyButton.title = locked ? t('Metadata writing in progress…') : t('Write the pending changes into the files (Ctrl+Enter)');
  resetButton.disabled = !isDirty();
  resetButton.title = t('Put the title and description back to their saved values');
}

// ---------------------------------------------------------------------------
// Chargement et changement de sélection
// ---------------------------------------------------------------------------

function load(photos) {
  targets = new Map(photos.map(photo => [photo.id, { id: photo.id, path: photo.path, title: photo.title || '', description: photo.caption || '' }]));
  editedTitle = null;
  editedDescription = null;
  render();
}

// Appelée à chaque changement de sélection : mise à jour différée (une seule par image affichée), uniquement si l'onglet est visible.
export function refreshDescriptionPanel() {
  if (!initialized || refreshScheduled || !isVisible()) return;
  refreshScheduled = true;
  requestAnimationFrame(() => {
    refreshScheduled = false;
    reload();
  });
}

async function reload() {
  if (isPromptOpen()) { refreshAfterPrompt = true; return; }
  try {
    const photos = currentTarget();
    if (sameAsTargets(photos)) {
      // Même sélection : la saisie en cours est conservée ; sans saisie, les valeurs sont relues (une écriture ou une relecture a pu les changer).
      if (!isDirty()) load(photos);
      else updateState();
      return;
    }
    // La sélection a changé alors que des modifications attendent d'être écrites : Appliquer / Ignorer / Annuler (voir metadata-writes.js).
    if ((await resolvePendingSelection(photos.map(photo => photo.id))) === 'cancel') return;
    load(currentTarget());
  } finally {
    if (refreshAfterPrompt && !isPromptOpen()) {
      refreshAfterPrompt = false;
      refreshDescriptionPanel();
    }
  }
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

// Services fournis par main.js : getSelectedPhotos.
export function initDescriptionPanel(hostApi) {
  host = hostApi;
  exifPanel = document.getElementById('exif-panel');
  pane = document.getElementById('exif-tab-description');
  titleField = document.getElementById('description-title');
  descriptionField = document.getElementById('description-text');
  applyButton = document.getElementById('btn-description-apply');
  resetButton = document.getElementById('btn-description-reset');
  if (![exifPanel, pane, titleField, descriptionField, applyButton, resetButton].every(Boolean)) {
    console.error('Onglet Description : éléments introuvables dans index.html');
    return;
  }
  initialized = true;

  const onInput = () => {
    // Mode ExifTool : un processus est démarré dès la première modification, pour que « Appliquer » ne paie pas son démarrage.
    invoke('exiftool_prewarm').catch(() => {});
    updateState();
  };
  titleField.addEventListener('input', () => { editedTitle = titleField.value; onInput(); });
  descriptionField.addEventListener('input', () => { editedDescription = descriptionField.value; onInput(); });
  applyButton.addEventListener('click', () => applyPending());
  resetButton.addEventListener('click', () => descriptionEditor.discard());
  registerEditor(descriptionEditor);
  onLockChange(updateState);

  // Ctrl+Entrée (Appliquer, avec les mots-clés en attente) : actif même dans les champs de saisie (le gestionnaire de touches de main.js
  // ignore les champs de saisie).
  window.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key !== 'Enter') return;
    if (!isVisible() || document.querySelector('.modal:not(.hidden)')) return;
    event.preventDefault();
    if (!event.repeat) applyPending();
  });

  // Le panneau est affiché ou masqué par main.js (classe « hidden »), l'onglet par keywords-panel.js (attribut « hidden ») : l'onglet se met
  // à jour dès qu'il devient visible.
  new MutationObserver(() => refreshDescriptionPanel()).observe(exifPanel, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(() => refreshDescriptionPanel()).observe(pane, { attributes: true, attributeFilter: ['hidden'] });

  onLanguageChange(render);
  render();
}
