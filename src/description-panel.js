// Onglet Description du panneau de droite (touche D) : titre et description des photos sélectionnées.
//
// Comme pour les mots-clés, la saisie reste « en attente » jusqu'à « Appliquer », Ctrl+Entrée, le changement de sélection (après confirmation,
// ou automatiquement selon le réglage) ou la fermeture : l'écriture passe par metadata-writes.js, en même temps que les mots-clés en attente.
// Plusieurs photos aux valeurs différentes : le champ est vide avec l'indication « Valeurs multiples » ; ce qui y est saisi remplace la valeur
// de toutes les photos. Un champ non touché n'est jamais écrit.
//
// Les valeurs affichées viennent de la base (colonnes `title` et `caption`), qui reflète le fichier selon l'ordre de priorité des sources réglé
// dans les Paramètres (onglet Métadonnées, voir metadata-settings.js).
//
// La moitié basse de l'onglet porte l'auteur et les droits (auteur, mention de copyright, crédit, conditions d'utilisation, e-mail de l'auteur) :
// cinq champs saisis, appliqués et abandonnés exactement comme le titre et la description (colonnes `author`, `copyright`, `credit`, `usage_terms`,
// `author_email`, lues à la demande par get_photo_rights). Une ligne de préréglage au-dessus (rights-presets.js) remplace les cinq champs d'un coup.

import { invoke } from '@tauri-apps/api/core';
import { t, onLanguageChange } from './i18n.js';
import { registerEditor, onLockChange, onPendingChange, notifyPendingChange, isWriteLocked, applyPending, hasSelectionEdits, resolvePendingSelection, isPromptOpen } from './metadata-writes.js';
import { initRightsPresets } from './rights-presets.js';

let host = null; // services de main.js, voir initDescriptionPanel
let initialized = false;
let exifPanel;
let pane;
let titleField;
let descriptionField;
let applyButton;
let resetButton;

// Photos ciblées (la sélection au moment du chargement) : valeurs enregistrées, par identifiant de photo.
let targets = new Map(); // identifiant -> { id, path, title, description, rights: { author, copyright, credit, usage_terms, author_email } }
// Valeurs saisies : null tant que le champ n'a pas été modifié (il n'est alors pas écrit).
let editedTitle = null;
let editedDescription = null;
// Valeur affichée quand le champ n'est pas modifié (valeur commune, ou vide pour « Valeurs multiples ») : y revenir annule la saisie.
let untouchedTitle = '';
let untouchedDescription = '';
let prewarmed = false; // processus ExifTool déjà démarré pour cette sélection
let refreshScheduled = false;
let refreshAfterPrompt = false;

// Mêmes règles que le backend (exif.rs, clean_title / clean_text) : le titre tient sur une ligne, espaces de début et de fin retirés.
const cleanTitle = value => value.replace(/[\r\n]+/g, ' ').trim();
const cleanDescription = value => value.replace(/\r\n?/g, '\n').trim();

// Auteur et droits : `key` est le nom du champ côté backend (get_photo_rights, éléments d'écriture) ; `clean` suit les mêmes règles que exif.rs
// (plusieurs auteurs séparés par « ; », entrées vides écartées, affichés « A; B »).
const cleanAuthors = value => value.split(';').map(cleanTitle).filter(Boolean).join('; ');
const RIGHTS_FIELDS = [
  { key: 'author', id: 'description-author', clean: cleanAuthors },
  { key: 'copyright', id: 'description-copyright', clean: cleanTitle },
  { key: 'credit', id: 'description-credit', clean: cleanTitle },
  { key: 'usage_terms', id: 'description-usage-terms', clean: cleanTitle },
  { key: 'author_email', id: 'description-author-email', clean: cleanTitle },
];
const emptyRights = () => Object.fromEntries(RIGHTS_FIELDS.map(field => [field.key, '']));
const noRightsEdits = () => Object.fromEntries(RIGHTS_FIELDS.map(field => [field.key, null]));
let rightsInputs = {}; // clé -> champ de saisie
let editedRights = noRightsEdits(); // saisie de chaque champ : null tant qu'il n'a pas été modifié
let untouchedRights = emptyRights(); // valeur affichée quand le champ n'est pas modifié
let presets = null; // ligne de préréglage, voir rights-presets.js
let rightsLoadToken = 0;

const isVisible = () => initialized && !exifPanel.classList.contains('hidden') && !pane.hidden;
const currentTarget = () => host.getSelectedPhotos().filter(photo => Number.isFinite(photo.id) && photo.id > 0);
const sameAsTargets = photos => photos.length === targets.size && photos.every(photo => targets.has(photo.id));

const titleChangedFor = target => editedTitle !== null && cleanTitle(editedTitle) !== target.title;
const descriptionChangedFor = target => editedDescription !== null && cleanDescription(editedDescription) !== target.description;
const rightsChangedFor = (target, field) => editedRights[field.key] !== null && field.clean(editedRights[field.key]) !== (target.rights[field.key] ?? '');
const rightsChanged = target => RIGHTS_FIELDS.some(field => rightsChangedFor(target, field));
const isRightsDirty = () => [...targets.values()].some(rightsChanged);

function isDirty() {
  for (const target of targets.values()) if (titleChangedFor(target) || descriptionChangedFor(target) || rightsChanged(target)) return true;
  return false;
}

// Valeur commune d'un champ d'auteur ou de droits aux photos ciblées, ou null si elles diffèrent.
function commonRight(key) {
  const values = [...targets.values()].map(target => target.rights[key] ?? '');
  return values.every(value => value === values[0]) ? (values[0] ?? '') : null;
}

// Valeur visible dans un champ d'auteur ou de droits (vide pour « Valeurs multiples » non touché).
const displayedRight = key => editedRights[key] ?? commonRight(key) ?? '';

// La disquette des préréglages est rouge quand un champ a été modifié : par rapport aux valeurs du préréglage sélectionné, sinon par rapport aux fichiers.
function presetModified() {
  const selected = presets?.getSelected();
  if (!selected) return isRightsDirty();
  return RIGHTS_FIELDS.some(field => field.clean(displayedRight(field.key)) !== field.clean(selected[field.key] ?? ''));
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
  // Types en attente (pastilles des onglets), sans construire les éléments à écrire.
  pendingKinds() {
    const values = [...targets.values()];
    const kinds = [];
    if (values.some(titleChangedFor)) kinds.push('title');
    if (values.some(descriptionChangedFor)) kinds.push('description');
    // L'auteur et les droits se saisissent dans cet onglet : même pastille que le titre et la description.
    if (values.some(rightsChanged) && !kinds.includes('description')) kinds.push('description');
    return kinds;
  },
  // Seuls les champs modifiés, et seulement pour les photos dont la valeur change.
  pendingItems() {
    const items = [];
    for (const target of targets.values()) {
      const item = { photo_id: target.id, path: target.path };
      if (titleChangedFor(target)) item.title = cleanTitle(editedTitle);
      if (descriptionChangedFor(target)) item.description = cleanDescription(editedDescription);
      for (const field of RIGHTS_FIELDS) if (rightsChangedFor(target, field)) item[field.key] = field.clean(editedRights[field.key]);
      if ('title' in item || 'description' in item || RIGHTS_FIELDS.some(field => field.key in item)) items.push(item);
    }
    return items;
  },
  // Les valeurs relues dans les fichiers écrits deviennent l'état enregistré. Une saisie est abandonnée quand plus aucune photo ne l'attend :
  // celles qui l'ont reçue telle qu'elle est maintenant (`items` : ce que cet onglet a envoyé) comptent comme servies, même si la relecture la
  // normalise autrement ; une saisie modifiée depuis l'envoi, ou des photos en échec, la gardent en attente.
  afterWrite(result, items) {
    const writtenIds = new Set();
    for (const written of result.written) {
      const target = targets.get(written.photo_id);
      if (!target) continue;
      writtenIds.add(written.photo_id);
      target.title = written.title;
      target.description = written.description;
      target.rights = Object.fromEntries(RIGHTS_FIELDS.map(field => [field.key, written[field.key] ?? '']));
    }
    const sent = new Map(items.map(item => [item.photo_id, item]));
    const served = (edited, clean, changedFor, field) => {
      const value = clean(edited);
      return [...targets.values()].every(target => !changedFor(target) || (writtenIds.has(target.id) && sent.get(target.id)?.[field] === value));
    };
    if (editedTitle !== null && served(editedTitle, cleanTitle, titleChangedFor, 'title')) editedTitle = null;
    if (editedDescription !== null && served(editedDescription, cleanDescription, descriptionChangedFor, 'description')) editedDescription = null;
    for (const field of RIGHTS_FIELDS) {
      if (editedRights[field.key] === null) continue;
      const value = field.clean(editedRights[field.key]);
      const rightServed = [...targets.values()].every(target => !rightsChangedFor(target, field) || (writtenIds.has(target.id) && sent.get(target.id)?.[field.key] === value));
      if (rightServed) editedRights[field.key] = null;
    }
    render();
  },
  discard() {
    editedTitle = null;
    editedDescription = null;
    editedRights = noRightsEdits();
    presets?.clearSelection(); // les champs reprennent les valeurs des fichiers : plus de préréglage
    render();
  },
  // Photo renommée ou déplacée : sa saisie en attente sera écrite sous le nouveau chemin.
  photosMoved(destinations) {
    for (const target of targets.values()) target.path = destinations.get(target.path) ?? target.path;
  },
  // Photos retirées du catalogue : elles sortent des photos ciblées (la saisie reste pour les autres).
  photosRemoved(paths) {
    let removed = false;
    for (const [id, target] of targets) {
      if (paths.has(target.path)) { targets.delete(id); removed = true; }
    }
    if (removed) render();
  },
};

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

// Auto-growing fields (copyright, usage terms: `.rights-textarea`): the height follows the text, up to the max-height of the CSS (then the field scrolls).
// Nothing to measure while the tab is hidden: the ResizeObserver set in initDescriptionPanel grows the field once it is visible.
function autoGrow(element) {
  if (!element.offsetParent) return;
  element.style.height = 'auto';
  // scrollHeight does not include the borders, and the field is border-box.
  element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
}

function renderField(field, edited, common) {
  field.value = edited ?? common ?? '';
  field.placeholder = edited === null && common === null ? t('Multiple values') : '';
  field.disabled = targets.size === 0;
  if (field.classList.contains('rights-textarea')) autoGrow(field);
}

function render() {
  if (!initialized) return;
  const commonTitle = commonValue('title');
  const commonDescription = commonValue('description');
  untouchedTitle = commonTitle ?? '';
  untouchedDescription = commonDescription ?? '';
  renderField(titleField, editedTitle, commonTitle);
  renderField(descriptionField, editedDescription, commonDescription);
  for (const field of RIGHTS_FIELDS) {
    const common = commonRight(field.key);
    untouchedRights[field.key] = common ?? '';
    renderField(rightsInputs[field.key], editedRights[field.key], common);
  }
  updateState();
}

// Boutons et marque « modifié » des champs (sans toucher à leur contenu, pour ne pas gêner la saisie).
function updateState() {
  if (!initialized) return;
  const values = [...targets.values()];
  titleField.classList.toggle('pending', values.some(titleChangedFor));
  descriptionField.classList.toggle('pending', values.some(descriptionChangedFor));
  for (const field of RIGHTS_FIELDS) rightsInputs[field.key].classList.toggle('pending', values.some(target => rightsChangedFor(target, field)));
  presets?.setModified(presetModified());
  const locked = isWriteLocked();
  // « Appliquer » écrit aussi les mots-clés en attente (onglet Mots-clés).
  applyButton.disabled = !hasSelectionEdits() || locked;
  applyButton.title = locked ? t('Metadata writing in progress…') : t('Write the pending changes into the files (Ctrl+Enter)');
  resetButton.disabled = !isDirty();
  resetButton.title = t('Put the title, description, author and rights back to their saved values');
  notifyPendingChange(); // pastilles des onglets et boutons de l'onglet Mots-clés
}

// ---------------------------------------------------------------------------
// Chargement et changement de sélection
// ---------------------------------------------------------------------------

// `keepPreset` : même sélection relue (rien en attente), le préréglage choisi reste affiché ; une autre sélection remet le champ de préréglage à blanc.
function load(photos, { keepPreset = false } = {}) {
  targets = new Map(photos.map(photo => [photo.id, { id: photo.id, path: photo.path, title: photo.title || '', description: photo.caption || '', rights: { ...emptyRights(), author: photo.author || '' } }]));
  editedTitle = null;
  editedDescription = null;
  editedRights = noRightsEdits();
  if (!keepPreset) presets?.clearSelection();
  prewarmed = false;
  render();
  loadRights(photos.map(photo => photo.id));
}

// Auteur et droits des photos ciblées, lus dans la base (ils ne font pas partie de la liste des photos, sauf l'auteur). La saisie faite pendant la lecture
// est conservée : seules les valeurs enregistrées changent.
async function loadRights(ids) {
  const token = ++rightsLoadToken;
  if (!ids.length) return;
  try {
    const rows = await invoke('get_photo_rights', { photoIds: ids });
    if (token !== rightsLoadToken) return;
    for (const row of rows) {
      const target = targets.get(row.photo_id);
      if (target) target.rights = Object.fromEntries(RIGHTS_FIELDS.map(field => [field.key, row[field.key] ?? '']));
    }
    render();
  } catch (error) {
    console.error('Lecture de l\'auteur et des droits impossible', error);
  }
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
      if (!isDirty()) load(photos, { keepPreset: true });
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

// Services fournis par main.js : getSelectedPhotos, showToast.
export function initDescriptionPanel(hostApi) {
  host = hostApi;
  exifPanel = document.getElementById('exif-panel');
  pane = document.getElementById('exif-tab-description');
  titleField = document.getElementById('description-title');
  descriptionField = document.getElementById('description-text');
  applyButton = document.getElementById('btn-description-apply');
  resetButton = document.getElementById('btn-description-reset');
  rightsInputs = Object.fromEntries(RIGHTS_FIELDS.map(field => [field.key, document.getElementById(field.id)]));
  if (![exifPanel, pane, titleField, descriptionField, applyButton, resetButton, ...Object.values(rightsInputs)].every(Boolean)) {
    console.error('Onglet Description : éléments introuvables dans index.html');
    return;
  }
  initialized = true;

  // Auto-growing fields: measured again when their width changes (panel resized, tab shown after having been hidden). Only a width change counts,
  // so the height set by autoGrow does not trigger the observer again.
  const growObserver = new ResizeObserver(entries => {
    for (const { target, contentRect } of entries) {
      if (target.dataset.growWidth === String(contentRect.width)) continue;
      target.dataset.growWidth = String(contentRect.width);
      autoGrow(target);
    }
  });
  for (const element of Object.values(rightsInputs)) if (element.classList.contains('rights-textarea')) growObserver.observe(element);

  const onInput = () => {
    // Mode ExifTool : un processus est démarré à la première modification, pour que « Appliquer » ne paie pas son démarrage.
    if (!prewarmed && isDirty()) {
      prewarmed = true;
      invoke('exiftool_prewarm').catch(() => {});
    }
    updateState();
  };
  // Revenir à la valeur affichée au départ (ex. une lettre tapée puis effacée dans un champ « Valeurs multiples ») : le champ redevient non
  // touché et n'est pas écrit, au lieu de remplacer la valeur de toutes les photos par un texte vide.
  titleField.addEventListener('input', () => { editedTitle = titleField.value === untouchedTitle ? null : titleField.value; onInput(); });
  descriptionField.addEventListener('input', () => {
    editedDescription = descriptionField.value === untouchedDescription ? null : descriptionField.value;
    onInput();
  });
  applyButton.addEventListener('click', () => applyPending());
  for (const field of RIGHTS_FIELDS) {
    const element = rightsInputs[field.key];
    const growing = element.classList.contains('rights-textarea');
    // A rights value is a single line (same rule as exif.rs): Enter does nothing in these fields (Ctrl+Enter still applies, see below).
    if (growing) element.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    element.addEventListener('input', () => {
      if (growing) {
        // A pasted line break becomes a space, as cleanTitle does when the value is written.
        if (/[\r\n]/.test(element.value)) element.value = element.value.replace(/[\r\n]+/g, ' ');
        autoGrow(element);
      }
      editedRights[field.key] = element.value === untouchedRights[field.key] ? null : element.value;
      onInput();
    });
  }
  // Ligne de préréglage : choisir un préréglage remplace les cinq champs par ses valeurs (même vides), à écrire comme une saisie.
  presets = initRightsPresets({
    applyPreset: preset => {
      if (targets.size === 0) return;
      for (const field of RIGHTS_FIELDS) editedRights[field.key] = preset[field.key] ?? '';
      render();
      onInput();
    },
    currentValues: () => Object.fromEntries(RIGHTS_FIELDS.map(field => [field.key, field.clean(displayedRight(field.key))])),
    onChange: () => updateState(),
    showToast: message => host.showToast?.(message),
  });
  resetButton.addEventListener('click', () => descriptionEditor.discard());
  registerEditor(descriptionEditor);
  onLockChange(updateState);
  onPendingChange(updateState);

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
