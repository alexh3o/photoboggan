// Préréglages d'auteur et de droits de l'onglet Description : un jeu des cinq champs (auteur, mention de copyright, crédit, conditions d'utilisation,
// e-mail de l'auteur) mémorisé sous un nom, stocké dans la base (table `author_presets`, voir rights.rs).
//
// - Le champ de préréglage est vide à l'ouverture du panneau ; en taper le début propose les préréglages correspondants (liste de filter-suggest.js).
//   Choisir un préréglage remplace les cinq champs par ses valeurs, même vides (description-panel.js : applyPreset).
// - Le bouton liste ouvre la fenêtre « Author and Rights presets » : un champ pour créer un préréglage (Entrée) et la liste des préréglages, chacun
//   avec son bouton Supprimer (après confirmation). Créer ou choisir un préréglage ferme la fenêtre et le sélectionne ; un préréglage neuf vide les champs.
// - La disquette enregistre les valeurs visibles dans le préréglage sélectionné (après confirmation) ou, sans préréglage sélectionné, dans un nouveau
//   préréglage dont elle demande le nom. Elle est rouge quand un champ a été modifié (description-panel.js calcule l'état : setModified).
import { invoke } from '@tauri-apps/api/core';
import { t, normalizeSearch, onLanguageChange } from './i18n.js';
import { createFilterSuggest } from './filter-suggest.js';
import { choiceDialog, keepFocusInModal } from './metadata-writes.js';

const MAX_NAME_LENGTH = 100; // même limite que rights.rs

const FIELD_KEYS = ['author', 'copyright', 'credit', 'usage_terms', 'author_email'];

// Message d'erreur de la commande (codes courts du backend) en texte lisible.
function describeError(error) {
  const code = String(error);
  if (code === 'invalid_name') return t('A preset name must have 1 to {max} characters.', { max: MAX_NAME_LENGTH });
  if (code === 'unknown_preset') return t('This preset no longer exists.');
  return code;
}

/**
 * Branche la ligne de préréglage de l'onglet Description.
 * - applyPreset(preset) : remplace les champs par les valeurs du préréglage ;
 * - currentValues() : valeurs visibles des cinq champs, { author, copyright, credit, usage_terms, author_email } ;
 * - onChange() : appelé quand la sélection du préréglage change (l'état rouge de la disquette est à recalculer) ;
 * - showToast(message).
 */
export function initRightsPresets({ applyPreset, currentValues, onChange, showToast }) {
  const input = document.getElementById('rights-preset-input');
  const suggestions = document.getElementById('rights-preset-suggestions');
  const manageButton = document.getElementById('btn-rights-presets');
  const saveButton = document.getElementById('btn-rights-preset-save');
  if (![input, suggestions, manageButton, saveButton].every(Boolean)) {
    console.error('Préréglages d\'auteur : éléments introuvables dans index.html');
    return { getSelected: () => null, clearSelection() {}, setModified() {} };
  }

  let presets = [];
  let selected = null;
  let modified = false;

  async function loadPresets() {
    try {
      presets = await invoke('list_author_presets');
      // Valeurs du préréglage sélectionné relues (un autre enregistrement a pu les changer).
      if (selected) selected = presets.find(preset => preset.id === selected.id) ?? null;
    } catch (error) {
      console.error('Préréglages d\'auteur illisibles', error);
      showToast?.(t('The author and rights presets could not be read: {error}', { error: String(error) }));
    }
  }

  function select(preset, { apply = true } = {}) {
    selected = preset;
    input.value = preset.name;
    if (apply) applyPreset(preset);
    onChange();
  }

  function clearSelection() {
    const had = selected !== null || input.value !== '';
    selected = null;
    input.value = '';
    suggest.close();
    if (had) onChange();
  }

  const suggest = createFilterSuggest({
    input,
    list: suggestions,
    getOptions: () => presets.map(preset => ({ value: preset.id, label: preset.name, count: 0, hideCount: true, search: normalizeSearch(preset.name) })),
    onPick: (id, exclude, text) => {
      const preset = id === null
        ? presets.find(candidate => normalizeSearch(candidate.name) === normalizeSearch(text))
        : presets.find(candidate => candidate.id === id);
      if (preset) select(preset);
      else input.value = text; // nothing matches: the text stays, no preset is selected
    },
    emptyText: 'No matching preset',
  });
  // Texte modifié à la main : ce n'est plus le préréglage sélectionné (les champs gardent leurs valeurs).
  input.addEventListener('input', () => {
    if (selected && input.value !== selected.name) {
      selected = null;
      onChange();
    }
  });

  // --- Fenêtre « Author and Rights presets » ---
  function openManager() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const card = document.createElement('div');
    card.className = 'modal-card rights-presets-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('h3');
    title.textContent = t('Author and Rights presets');
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'close-x';
    closeButton.textContent = '×';
    closeButton.title = t('Close');
    closeButton.setAttribute('aria-label', t('Close'));
    header.append(title, closeButton);
    const body = document.createElement('div');
    body.className = 'modal-body';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'keyword-input';
    nameInput.maxLength = MAX_NAME_LENGTH;
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.placeholder = t('Type a new preset name and hit Enter');
    nameInput.setAttribute('aria-label', t('New Preset'));
    const errorLine = document.createElement('p');
    errorLine.className = 'keyword-dialog-error';
    errorLine.setAttribute('role', 'alert');
    const listElement = document.createElement('ul');
    listElement.className = 'rights-preset-list';
    const emptyLine = document.createElement('p');
    emptyLine.className = 'sort-note';
    emptyLine.textContent = t('No preset yet');
    body.append(nameInput, errorLine, listElement, emptyLine);
    card.append(header, body);
    modal.append(card);

    const close = () => {
      document.removeEventListener('keydown', onKeyDown, true);
      modal.remove();
    };
    const onKeyDown = event => {
      if (keepFocusInModal(modal, event) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };

    function renderList() {
      emptyLine.hidden = presets.length > 0;
      listElement.replaceChildren(...presets.map(preset => {
        const row = document.createElement('li');
        row.className = 'rights-preset-item';
        const choose = document.createElement('button');
        choose.type = 'button';
        choose.className = 'rights-preset-name';
        choose.textContent = preset.name;
        choose.title = preset.name;
        choose.addEventListener('click', () => { close(); select(preset); });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn-danger';
        remove.textContent = t('Delete');
        remove.title = t('Delete the preset {name}', { name: preset.name });
        remove.addEventListener('click', () => removePreset(preset).then(renderList));
        row.append(choose, remove);
        return row;
      }));
    }

    nameInput.addEventListener('input', () => { errorLine.textContent = ''; });
    nameInput.addEventListener('keydown', async event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      try {
        const preset = await invoke('create_author_preset', { name });
        await loadPresets();
        close();
        // New preset: its values are empty, so the five fields are emptied; an existing name brings its own values.
        select(presets.find(candidate => candidate.id === preset.id) ?? preset);
      } catch (error) {
        errorLine.textContent = describeError(error);
      }
    });
    closeButton.addEventListener('click', close);
    document.addEventListener('keydown', onKeyDown, true);
    (document.getElementById('app') || document.body).append(modal);
    renderList();
    nameInput.focus();
  }

  // Suppression d'un préréglage, après confirmation. Le préréglage sélectionné supprimé laisse les champs tels quels, sans préréglage.
  async function removePreset(preset) {
    const choice = await choiceDialog({
      title: t('Delete preset'),
      message: t('Delete the preset “{name}”? The photos are not changed.', { name: preset.name }),
      buttons: [
        { label: t('Cancel'), value: 'cancel', cancel: true },
        { label: t('Delete'), value: 'delete', primary: true, tone: 'red' },
      ],
    });
    if (choice !== 'delete') return;
    try {
      await invoke('delete_author_preset', { id: preset.id });
    } catch (error) {
      showToast?.(describeError(error));
      return;
    }
    await loadPresets();
    if (selected?.id === preset.id) clearSelection();
  }

  // --- Disquette : enregistre les valeurs visibles ---
  // Fenêtre de saisie du nom d'un nouveau préréglage : renvoie le nom, ou null si annulé.
  function askPresetName() {
    return new Promise(resolve => {
      const modal = document.createElement('div');
      modal.className = 'modal';
      const card = document.createElement('div');
      card.className = 'modal-card keyword-dialog';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      const heading = document.createElement('h3');
      heading.textContent = t('New preset');
      const field = document.createElement('input');
      field.type = 'text';
      field.className = 'keyword-input keyword-dialog-input';
      field.maxLength = MAX_NAME_LENGTH;
      field.autocomplete = 'off';
      field.spellcheck = false;
      field.placeholder = t('Preset name');
      field.setAttribute('aria-label', t('Preset name'));
      const errorLine = document.createElement('p');
      errorLine.className = 'keyword-dialog-error';
      errorLine.setAttribute('role', 'alert');
      const actions = document.createElement('div');
      actions.className = 'keyword-dialog-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = t('Cancel');
      const create = document.createElement('button');
      create.type = 'button';
      create.className = 'active';
      create.textContent = t('Create Preset');
      actions.append(cancel, create);
      card.append(heading, field, errorLine, actions);
      modal.append(card);
      const close = value => {
        document.removeEventListener('keydown', onKeyDown, true);
        modal.remove();
        resolve(value);
      };
      const submit = () => {
        const name = field.value.trim();
        if (!name) { errorLine.textContent = t('A preset name must have 1 to {max} characters.', { max: MAX_NAME_LENGTH }); field.focus(); return; }
        close(name);
      };
      const onKeyDown = event => {
        if (keepFocusInModal(modal, event) || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close(null);
      };
      field.addEventListener('input', () => { errorLine.textContent = ''; });
      field.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } });
      cancel.addEventListener('click', () => close(null));
      create.addEventListener('click', submit);
      document.addEventListener('keydown', onKeyDown, true);
      (document.getElementById('app') || document.body).append(modal);
      field.focus();
    });
  }

  async function confirmReplace(preset) {
    const choice = await choiceDialog({
      title: t('Replace the preset values'),
      message: t('Do you want to replace {name} preset values with the current values ?', { name: preset.name }),
      buttons: [
        { label: t('Cancel'), value: 'cancel', cancel: true },
        { label: t('Replace'), value: 'replace', primary: true, tone: 'orange' },
      ],
    });
    return choice === 'replace';
  }

  async function storeValues(preset, values) {
    return invoke('save_author_preset', {
      id: preset.id,
      author: values.author,
      copyright: values.copyright,
      credit: values.credit,
      usageTerms: values.usage_terms,
      authorEmail: values.author_email,
    });
  }

  async function saveCurrent() {
    const values = currentValues();
    try {
      let target = selected;
      if (target) {
        if (!(await confirmReplace(target))) return;
      } else {
        const name = await askPresetName();
        if (name === null) return;
        // An existing name (any case) is replaced like a selected preset, after the same confirmation.
        const existing = presets.find(candidate => normalizeSearch(candidate.name) === normalizeSearch(name));
        if (existing && !(await confirmReplace(existing))) return;
        target = existing ?? (await invoke('create_author_preset', { name }));
      }
      const saved = await storeValues(target, values);
      await loadPresets();
      select(presets.find(candidate => candidate.id === saved.id) ?? saved, { apply: false });
      showToast?.(t('Preset “{name}” saved', { name: saved.name }));
    } catch (error) {
      showToast?.(t('The preset could not be saved: {error}', { error: describeError(error) }));
    }
  }

  manageButton.addEventListener('click', () => openManager());
  saveButton.addEventListener('click', () => saveCurrent());
  onLanguageChange(() => setModified(modified));

  function setModified(value) {
    modified = value;
    saveButton.classList.toggle('modified', value);
    saveButton.title = t(value ? 'Save the fields in the preset (the fields were modified)' : 'Save the fields in the preset');
  }

  loadPresets();
  return {
    getSelected: () => selected,
    clearSelection,
    setModified,
    FIELD_KEYS,
  };
}
