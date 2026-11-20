import './batch-rename.css';
import { invoke } from '@tauri-apps/api/core';
import { t, tp } from './i18n.js';
import { createModal, confirmDialog, promptDialog } from './photo-actions.js';
import { isWriteLocked, showFailureDetails } from './metadata-writes.js';
import { newStep, splitFileName, validateRecipe, evaluate, normalizeSteps, STEP_TYPES } from './batch-rename-engine.js';

// Batch rename (F2 or "Rename…" of the context menu on several photos). The dialog builds a recipe of steps (replace, insert, delete), shows the
// new name of every photo (paginated) and applies it. The names are computed here (batch-rename-engine.js); the backend (batch_rename.rs)
// re-checks them, plans the batch (collisions, XMP sidecars, lengths) and renames. A batch of QUEUE_THRESHOLD photos or more is a task of the
// queue (progress, stop); a smaller one runs at once. Ctrl+Z (or the "Undo" button of the toast) gives the names back.

const QUEUE_THRESHOLD = 20;
const PAGE_SIZE = 10;
const FORM_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled])';

// main.js gives access to the grid and to the file operations: getPhotos(), getReferencePhoto(), showToast(message, isWriting, action, duration),
// enqueueTask(task), applyMoved(moved), isBusy(), setBusy(flag), pushUndo(run), undoToastAction(entry).
let deps = null;
export function initBatchRename(options) {
  deps = options;
}

const baseName = path => path.split(/[\\/]/).filter(Boolean).pop() || path;

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label, className = '', title = '') {
  const node = element('button', className, label);
  node.type = 'button';
  if (title) node.title = title;
  return node;
}

// ==========================================
// Texts of the errors
// ==========================================
function recipeErrorText({ code, params = {} }) {
  switch (code) {
    case 'syntax': return t('Syntax error in “{text}”', { text: params.text ?? '' });
    case 'unknown_variable': return t('Unknown variable: {name}', params);
    case 'too_many_params': return t('Too many parameters for {name}', params);
    case 'format_required': return t('{name}: the date format is required (for example YYYYMMDD)', params);
    case 'date_symbol': return t('Unknown date symbol “{symbol}” (use YYYY MM DD hh mm ss)', params);
    case 'counter_param': return t('counter: invalid {name}', params);
    case 'counter_overflow': return t('counter: {digits} digits are not enough to number up to {max}', params);
    case 'author_param': return t('author: invalid {name} (allowed: {values})', params);
    case 'empty_search': return t('The text to search for is empty');
    case 'occurrence': return t('The occurrence must be a whole number from 1');
    case 'position': return t('The position must be a whole number');
    case 'length': return t('The length must be a whole number from 1');
    case 'direction': return t('The direction must be “from the start” or “from the end”');
    case 'forbidden_chars': return t('This text contains characters not allowed in a file name: {chars}', params);
    case 'delete_range': return t('Cannot delete {length} characters from position {start} in a name of {size} characters', params);
    case 'empty_name': return t('The new name would be empty');
    case 'ends_with_dot': return t('The new name cannot end with a dot');
    case 'reserved_name': return t('“{name}” is a name reserved by Windows', params);
    case 'blank_once': return t('The “Start blank” step can only be used once');
    default: return String(code);
  }
}

function backendFailureText(code, detail) {
  switch (code) {
    case 'invalid_name': return detail || t('Invalid name');
    case 'not_found': return t('File not found');
    case 'not_tracked': return t('Photo not in the catalog');
    case 'duplicate': return t('Photo given twice');
    case 'too_long': return t('Name or path too long');
    case 'collision': return t('Same new name as another file of the batch, or as a file that keeps its name');
    case 'exists': return t('A file with this name already exists');
    case 'sidecar_exists': return t('The XMP sidecar already exists under the new name');
    case 'sidecar_taken': return t('An XMP sidecar already exists under the new name');
    case 'catalog': return t('Renamed, but the catalog could not be updated: {error}', { error: detail });
    default: return detail || String(code);
  }
}

const STEP_LABELS = { blank: 'Start blank', replace: 'Replace text', insert: 'Insert text', delete: 'Delete characters' };
const stepLabel = type => t(STEP_LABELS[type]);
const titled = (node, text) => {
  node.title = text; // the tooltip shows what the ellipsis cuts
  return node;
};

// ==========================================
// Running the batch (dialog closed): task of the queue or direct call, then the interface follows the new names
// ==========================================
function runBatch(items, onDone) {
  if (items.length >= QUEUE_THRESHOLD) {
    deps.enqueueTask({
      kind: 'rename',
      path: null,
      command: 'rename_photos',
      args: { items },
      labelKey: 'Renaming files ({count})',
      labelParams: { count: items.length },
      onResult: (result, stopped, error, queuedTask) => onDone(result, stopped, error, queuedTask),
    });
    return;
  }
  runDirect(items, onDone);
}

async function runDirect(items, onDone) {
  if (deps.isBusy()) {
    deps.showToast(t('Wait for the running file task to finish.'));
    return;
  }
  deps.setBusy(true); // same flag as a single rename: the automatic synchronisation waits
  deps.showToast(t('Renaming files…'), true);
  let result = null;
  let failure = null;
  try {
    result = await invoke('rename_photos', { items });
  } catch (error) {
    failure = error;
  } finally {
    deps.setBusy(false);
  }
  await onDone(result, false, failure);
}

// The failures of a batch stay in the tasks window ("Show errors" / "Dismiss") instead of a toast that closes by itself: the task of the queue that
// just ran, or a new entry when the batch ran at once.
function keepFailures(failures, queuedTask, count, notes = []) {
  const options = { title: t('Some files could not be renamed'), failures, notes };
  deps.keepTaskReady(queuedTask ?? null, {
    kind: 'rename',
    labelKey: 'Renaming files ({count})',
    labelParams: { count },
    readyText: tp('{count} file not renamed', failures.length),
    showLabel: t('Show errors'),
    onShow: () => showFailureDetails(options),
  });
}

// End of a batch: interface updated, Ctrl+Z armed, one toast (with the "Undo" button); the failures are kept in the tasks window.
async function finishBatch(result, stopped, error, queuedTask) {
  if (error) {
    deps.showToast(t('Rename failed: {error}', { error }));
    return;
  }
  if (!result) return; // removed from the queue before it started: nothing was renamed
  if (result.failed.length) console.error('Rename failures', result.failed);
  const renamed = result.renamed;
  let undoEntry = null;
  if (renamed.length) {
    await deps.applyMoved(renamed);
    undoEntry = deps.pushUndo(() => undoBatch(renamed));
  }
  const failures = result.failed.map(failure => ({ path: failure.path, error: backendFailureText(failure.code, failure.detail) }));
  if (failures.length) keepFailures(failures, queuedTask, renamed.length + failures.length + result.unchanged, [renamed.length ? t('Ctrl+Z gives the files that were renamed their previous names back.') : '']);
  const action = undoEntry ? deps.undoToastAction(undoEntry) : null;
  const parts = [];
  if (renamed.length) parts.push(tp('{count} file renamed', renamed.length));
  if (result.unchanged) parts.push(tp('{count} file unchanged', result.unchanged));
  if (failures.length) parts.push(tp('{count} file not renamed', failures.length));
  if (result.not_processed) parts.push(t('Renaming stopped: {count} not processed', { count: result.not_processed }));
  if (!parts.length) return;
  deps.showToast(!renamed.length && failures.length ? t('Rename failed: {error}', { error: failures[0].error }) : parts.join(' · '), false, action, action ? 12000 : null);
}

// Ctrl+Z: the same batch the other way round (each photo takes back the name it had). Not stacked again.
function undoBatch(renamed) {
  const items = renamed.map(({ from, to }) => ({ path: to, newName: splitFileName(baseName(from)).stem }));
  if (deps.isBusy()) {
    deps.showToast(t('Wait for the running file task to finish.'));
    deps.pushUndo(() => undoBatch(renamed)); // not undone yet: stays available
    return;
  }
  if (isWriteLocked()) {
    deps.showToast(t('Metadata writing in progress…'));
    deps.pushUndo(() => undoBatch(renamed));
    return;
  }
  runBatch(items, async (result, stopped, error, queuedTask) => {
    if (error) {
      deps.showToast(t('Rename failed: {error}', { error }));
      return;
    }
    if (!result) return;
    if (result.renamed.length) await deps.applyMoved(result.renamed);
    const failures = result.failed.map(failure => ({ path: failure.path, error: backendFailureText(failure.code, failure.detail) }));
    if (failures.length) keepFailures(failures, queuedTask, result.renamed.length + failures.length);
    const parts = [tp('Renaming undone for {count} file', result.renamed.length)];
    if (failures.length) parts.push(tp('{count} file not renamed', failures.length));
    deps.showToast(parts.join(' · '));
  });
}

// ==========================================
// Dialog
// ==========================================
export async function openBatchRename(targets) {
  if (!deps || !targets.length) return;
  if (deps.isBusy()) {
    deps.showToast(t('Wait for the running file task to finish.'));
    return;
  }
  // Metadata being written: it would write to the files under their old names.
  if (isWriteLocked()) {
    deps.showToast(t('Metadata writing in progress…'));
    return;
  }
  // The counter follows the order of the grid, whatever the order of the selection.
  const order = new Map(deps.getPhotos().map((photo, index) => [photo.path, index]));
  const photos = [...targets].sort((first, second) => (order.get(first.path) ?? Infinity) - (order.get(second.path) ?? Infinity));
  const reference = deps.getReferencePhoto?.();

  const state = { steps: [], presets: [], selectedPreset: '', rows: [], errors: [], statuses: new Map(), checking: false, page: 0 };
  let checkTimer = 0;
  let checkToken = 0;

  const modal = createModal({
    title: `${t('Rename')} · ${tp('{count} photo selected', photos.length)}`,
    cardClass: 'batch-rename-card',
    focusSelector: FORM_FOCUSABLE,
    onClose: () => { clearTimeout(checkTimer); checkToken += 1; },
  });

  // --- Saved recipes
  const presetSelect = element('select', 'resize-field batch-preset-select');
  presetSelect.setAttribute('aria-label', t('Saved recipes'));
  const saveButton = button(t('Save recipe…'), 'btn-secondary');
  const deleteButton = button(t('Delete recipe'), 'btn-secondary');
  const presetRow = element('div', 'batch-presets');
  presetRow.append(presetSelect, saveButton, deleteButton);

  // --- Steps
  const variablesHelp = button('?', 'batch-help', t('Batch rename variables help'));
  variablesHelp.setAttribute('aria-label', t('Help'));
  const stepsHeading = element('h4', 'batch-heading');
  stepsHeading.append(element('span', '', t('Steps')), variablesHelp);
  const stepList = element('ol', 'batch-steps');
  const addSelect = element('select', 'resize-field batch-add-step');
  addSelect.setAttribute('aria-label', t('Add a step…'));
  const emptyHint = element('p', 'batch-hint', t('Add at least one step to build the new names.'));
  const stepsSection = element('section', 'settings-section');
  stepsSection.append(stepsHeading, stepList, emptyHint, addSelect);

  // --- Preview
  const example = element('p', 'batch-example');
  const summary = element('p', 'batch-summary');
  const previewList = element('ul', 'batch-preview');
  const previous = button('‹', 'batch-page-button', t('Previous page'));
  const next = button('›', 'batch-page-button', t('Next page'));
  const pageLabel = element('span', 'batch-page-label');
  const pager = element('div', 'batch-pager');
  pager.append(previous, pageLabel, next);
  const previewSection = element('section', 'settings-section');
  previewSection.append(element('h4', '', t('Preview')), example, summary, previewList, pager);

  const actions = element('div', 'confirm-actions');
  const cancel = button(t('Cancel'));
  cancel.addEventListener('click', modal.close);
  const apply = button('', 'btn-primary');
  actions.append(cancel, apply);

  const presetsSection = element('section', 'settings-section');
  presetsSection.append(element('h4', '', t('Saved recipes')), presetRow);
  modal.body.append(presetsSection, stepsSection, previewSection, actions);

  // --- Computation (names from the recipe, then the backend's opinion on the disk)
  function compute() {
    state.errors = validateRecipe(state.steps, photos.length);
    const usable = state.steps.length > 0 && state.errors.length === 0;
    state.rows = photos.map((photo, index) => {
      const fileName = baseName(photo.path);
      const { stem, ext } = splitFileName(fileName);
      const row = { photo, fileName, newStem: null, newFileName: null, error: null, unchanged: false };
      if (!usable) return row;
      const result = evaluate(state.steps, { stem, photo, index, count: photos.length });
      if (result.error) {
        row.error = { text: recipeErrorText(result.error), step: result.error.step };
      } else {
        row.newStem = result.name;
        row.newFileName = result.name + ext;
        row.unchanged = row.newFileName === fileName;
      }
      return row;
    });
  }

  function rowState(row) {
    if (row.error) return { kind: 'error', text: row.error.text };
    if (row.newStem === null) return { kind: 'none' };
    if (row.unchanged) return { kind: 'unchanged' };
    const status = state.statuses.get(row.photo.path);
    if (status?.status === 'error') return { kind: 'error', text: backendFailureText(status.code, status.detail) };
    if (status?.status === 'unchanged') return { kind: 'unchanged' };
    return { kind: state.checking && !status ? 'pending' : 'ok' };
  }

  function scheduleCheck() {
    clearTimeout(checkTimer);
    checkToken += 1;
    state.statuses = new Map();
    state.checking = state.rows.some(row => row.newStem !== null && !row.unchanged);
    checkTimer = setTimeout(runCheck, 250);
  }

  async function runCheck() {
    const items = state.rows.filter(row => row.newStem !== null && !row.unchanged).map(row => ({ path: row.photo.path, newName: row.newStem }));
    const token = ++checkToken;
    if (!items.length) {
      state.checking = false;
      renderPreview();
      return;
    }
    try {
      const statuses = await invoke('preview_rename_batch', { items });
      if (token !== checkToken) return;
      state.statuses = new Map(statuses.map(status => [status.path, status]));
    } catch (error) {
      if (token !== checkToken) return;
      console.error('Batch rename preview failed', error);
      state.statuses = new Map();
    }
    state.checking = false;
    renderPreview();
  }

  function changed() {
    compute();
    renderStepErrors();
    scheduleCheck();
    renderPreview();
    saveButton.disabled = state.steps.length === 0; // a recipe can be saved as soon as it has a step
  }

  // --- Rendering of the preview
  function renderPreview() {
    const states = state.rows.map(rowState);
    const toRename = states.filter(row => row.kind === 'ok' || row.kind === 'pending').length;
    const unchanged = states.filter(row => row.kind === 'unchanged').length;
    const problems = states.filter(row => row.kind === 'error').length;
    const pages = Math.max(1, Math.ceil(state.rows.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages - 1);

    const sample = state.rows.find(row => row.photo.path === reference?.path) ?? state.rows.at(-1);
    const sampleState = sample ? rowState(sample) : { kind: 'none' };
    example.textContent = '';
    if (state.errors.length) example.textContent = t('Fix the steps marked in red to see the new names.');
    else if (sampleState.kind === 'none') example.textContent = t('The new names appear here once a step is added.');
    else if (sampleState.kind === 'error' && sample.error) example.textContent = `[${sample.fileName}] → ${sample.error.text}`;
    else if (sample.newFileName) example.textContent = `[${sample.fileName}] → [${sample.newFileName}]`;
    example.title = example.textContent;
    summary.textContent = state.steps.length && !state.errors.length
      ? [t('{count} to rename', { count: toRename }), t('{count} unchanged', { count: unchanged }), t('{count} not renamed', { count: problems })].join(' · ')
      : '';
    summary.classList.toggle('has-problems', problems > 0);

    const start = state.page * PAGE_SIZE;
    previewList.replaceChildren(...state.rows.slice(start, start + PAGE_SIZE).map((row, offset) => {
      const rowStatus = states[start + offset];
      const item = element('li', `batch-row ${rowStatus.kind}`);
      const oldName = titled(element('span', 'batch-row-old', row.fileName), `${row.fileName}\n${row.photo.path}`);
      item.append(oldName);
      if (rowStatus.kind === 'error') {
        item.append(element('span', 'batch-row-arrow', '→'), titled(element('span', 'batch-row-problem', rowStatus.text), rowStatus.text));
      } else if (rowStatus.kind === 'unchanged') {
        item.append(element('span', 'batch-row-arrow', '='), element('span', 'batch-row-same', t('Unchanged')));
      } else if (row.newFileName) {
        item.append(element('span', 'batch-row-arrow', '→'), titled(element('span', 'batch-row-new', row.newFileName), row.newFileName));
      }
      return item;
    }));
    pager.hidden = pages <= 1;
    pageLabel.textContent = t('Page {page} / {pages}', { page: state.page + 1, pages });
    previous.disabled = state.page === 0;
    next.disabled = state.page >= pages - 1;

    const canApply = state.steps.length > 0 && state.errors.length === 0 && toRename > 0 && !state.checking;
    apply.disabled = !canApply;
    apply.textContent = toRename > 0 ? tp('Rename {count} file', toRename) : t('Rename');
  }

  previous.addEventListener('click', () => { state.page -= 1; renderPreview(); });
  next.addEventListener('click', () => { state.page += 1; renderPreview(); });

  // --- Rendering of the steps
  function renderStepErrors() {
    const messages = new Map(state.errors.map(error => [error.step, recipeErrorText(error)]));
    [...stepList.children].forEach((item, index) => {
      const line = item.querySelector('.batch-step-error');
      line.textContent = messages.get(index) ?? '';
      line.hidden = !messages.has(index);
    });
  }

  function textField(label, step, property, { narrow = false, type = 'text' } = {}) {
    const input = element('input', `resize-field batch-field-input${narrow ? ' narrow' : ''}`);
    input.type = type;
    if (type === 'number') { input.min = '0'; input.step = '1'; }
    input.value = step[property];
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', label);
    input.addEventListener('input', () => { step[property] = input.value; changed(); });
    const wrapper = element('label', 'batch-field');
    wrapper.append(element('span', '', label), input);
    return wrapper;
  }

  function directionField(step) {
    const select = element('select', 'resize-field batch-field-input');
    select.append(new Option(t('From the start'), 'start'), new Option(t('From the end'), 'end'));
    select.value = step.direction === 'end' ? 'end' : 'start';
    select.setAttribute('aria-label', t('Direction'));
    select.addEventListener('change', () => { step.direction = select.value; changed(); });
    const wrapper = element('label', 'batch-field');
    wrapper.append(element('span', '', t('Direction')), select);
    return wrapper;
  }

  function stepHelp(type) {
    return t(`Batch rename ${type} help`);
  }

  function moveButton(symbol, label, disabled, action) {
    const node = button(symbol, 'keyword-format-move', label);
    node.setAttribute('aria-label', label);
    node.disabled = disabled;
    node.addEventListener('click', action);
    return node;
  }

  // Drag by the handle: the row changes place when the pointer passes the middle of a neighbour; the order is kept on release.
  function startDrag(event, item, handle) {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    item.classList.add('dragging');
    const onMove = moveEvent => {
      const above = item.previousElementSibling;
      const below = item.nextElementSibling;
      if (above && moveEvent.clientY < above.getBoundingClientRect().top + above.offsetHeight / 2) stepList.insertBefore(item, above);
      if (below && moveEvent.clientY > below.getBoundingClientRect().top + below.offsetHeight / 2) stepList.insertBefore(below, item);
    };
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      item.classList.remove('dragging');
      const ids = [...stepList.children].map(child => Number(child.dataset.id));
      state.steps = normalizeSteps(ids.map(id => state.steps.find(step => step.id === id)).filter(Boolean));
      renderSteps();
      changed();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  }

  function renderSteps() {
    emptyHint.hidden = state.steps.length > 0;
    renderAddOptions();
    stepList.replaceChildren(...state.steps.map((step, index) => {
      const item = element('li', 'batch-step');
      item.dataset.id = String(step.id);
      const handle = element('span', 'keyword-format-handle', '⠿');
      handle.title = t('Drag to reorder');
      // "Start blank" is first and stays first: nothing to drag, and no other step can be dropped above it.
      if (step.type === 'blank') handle.style.visibility = 'hidden';
      else handle.addEventListener('pointerdown', event => startDrag(event, item, handle));
      const rank = element('span', 'keyword-format-rank', `${index + 1}.`);
      const type = element('select', 'resize-field batch-step-type');
      // "Start blank" is offered once, to the steps that are not already it; it can be turned into another step.
      type.append(...STEP_TYPES.filter(value => value !== 'blank' || step.type === 'blank').map(value => new Option(stepLabel(value), value)));
      type.value = step.type;
      type.setAttribute('aria-label', t('Step type'));
      type.addEventListener('change', () => {
        state.steps[index] = { ...newStep(type.value), id: step.id };
        renderSteps();
        changed();
      });
      const help = button('?', 'batch-help', stepHelp(step.type));
      help.setAttribute('aria-label', t('Help'));
      const remove = button('×', 'batch-remove', t('Remove this step'));
      remove.setAttribute('aria-label', t('Remove this step'));
      remove.addEventListener('click', () => {
        state.steps.splice(index, 1);
        renderSteps();
        changed();
      });
      const head = element('div', 'batch-step-head');
      head.append(
        handle, rank, type, help,
        moveButton('↑', t('Move up'), index === 0 || step.type === 'blank' || state.steps[index - 1].type === 'blank', () => { [state.steps[index - 1], state.steps[index]] = [state.steps[index], state.steps[index - 1]]; renderSteps(); changed(); }),
        moveButton('↓', t('Move down'), index === state.steps.length - 1 || step.type === 'blank', () => { [state.steps[index + 1], state.steps[index]] = [state.steps[index], state.steps[index + 1]]; renderSteps(); changed(); }),
        remove,
      );
      const fields = element('div', 'batch-step-fields');
      if (step.type === 'blank') {
        fields.append(element('p', 'batch-hint', t('The current name is erased here: the next steps build the new name.')));
      } else if (step.type === 'replace') {
        fields.append(textField(t('Search'), step, 'search'), textField(t('Replace with'), step, 'replacement'), textField(t('Occurrence (empty: all)'), step, 'occurrence', { narrow: true }));
      } else if (step.type === 'insert') {
        fields.append(textField(t('Text to insert'), step, 'text'), textField(t('Position'), step, 'position', { narrow: true, type: 'number' }), directionField(step));
      } else {
        fields.append(textField(t('Start'), step, 'start', { narrow: true, type: 'number' }), textField(t('Length'), step, 'length', { narrow: true, type: 'number' }), directionField(step));
      }
      const error = element('p', 'batch-step-error');
      error.setAttribute('role', 'alert');
      error.hidden = true;
      item.append(head, fields, error);
      return item;
    }));
  }

  // "Start blank" is offered only while the recipe does not have it, and goes to the first place.
  function renderAddOptions() {
    const hasBlank = state.steps.some(step => step.type === 'blank');
    addSelect.replaceChildren(new Option(t('Add a step…'), ''), ...STEP_TYPES.filter(type => type !== 'blank' || !hasBlank).map(type => new Option(stepLabel(type), type)));
  }

  addSelect.addEventListener('change', () => {
    if (!addSelect.value) return;
    const added = newStep(addSelect.value);
    if (added.type === 'blank') state.steps.unshift(added);
    else state.steps.push(added);
    addSelect.value = '';
    renderSteps();
    changed();
    if (added.type !== 'blank') stepList.lastElementChild?.querySelector('input')?.focus();
  });

  // --- Saved recipes
  const stepsForSaving = () => state.steps.map(({ id, ...rest }) => rest);

  function renderPresets() {
    presetSelect.replaceChildren(new Option(state.presets.length ? t('Choose a saved recipe…') : t('No saved recipe'), ''), ...state.presets.map(preset => new Option(preset.name, String(preset.id))));
    presetSelect.value = state.presets.some(preset => String(preset.id) === state.selectedPreset) ? state.selectedPreset : '';
    presetSelect.disabled = state.presets.length === 0;
    deleteButton.disabled = presetSelect.value === '';
    saveButton.disabled = state.steps.length === 0;
  }

  function loadPreset(preset) {
    let parsed = [];
    try {
      parsed = JSON.parse(preset.steps);
    } catch (error) {
      console.error('Saved recipe unreadable', error);
    }
    state.steps = (Array.isArray(parsed) ? parsed : [])
      .filter(step => step && STEP_TYPES.includes(step.type))
      .map(step => {
        const fresh = newStep(step.type);
        for (const key of Object.keys(fresh)) if (key !== 'id' && key !== 'type' && typeof step[key] === 'string') fresh[key] = step[key];
        return fresh;
      });
    state.steps = normalizeSteps(state.steps);
    renderSteps();
    changed();
  }

  const saveErrorText = error => {
    const code = String(error);
    if (code.includes('empty_name')) return t('Enter a name for the recipe');
    if (code.includes('name_too_long')) return t('The name of the recipe is too long');
    if (code.includes('invalid_steps')) return t('The recipe could not be saved');
    return code;
  };

  presetSelect.addEventListener('change', () => {
    state.selectedPreset = presetSelect.value;
    const preset = state.presets.find(candidate => String(candidate.id) === presetSelect.value);
    if (preset) loadPreset(preset);
    renderPresets();
  });

  saveButton.addEventListener('click', () => {
    const current = state.presets.find(preset => String(preset.id) === state.selectedPreset);
    promptDialog({
      title: t('Save recipe'),
      message: t('Name of the recipe (an existing recipe with the same name is replaced)'),
      inputLabel: t('Recipe name'),
      confirmLabel: t('Save'),
      cancelLabel: t('Cancel'),
      value: current?.name ?? '',
      onSubmit: async name => {
        try {
          state.presets = await invoke('save_rename_preset', { name, steps: JSON.stringify(stepsForSaving()) });
        } catch (error) {
          return saveErrorText(error);
        }
        state.selectedPreset = String(state.presets.find(preset => preset.name.toLowerCase() === name.trim().toLowerCase())?.id ?? '');
        renderPresets();
        return null;
      },
    });
  });

  deleteButton.addEventListener('click', async () => {
    const preset = state.presets.find(candidate => String(candidate.id) === state.selectedPreset);
    if (!preset) return;
    const confirmed = await confirmDialog({
      title: t('Delete recipe'),
      message: t('Delete the recipe “{name}”?', { name: preset.name }),
      confirmLabel: t('Yes'),
      cancelLabel: t('No'),
    });
    if (!confirmed) return;
    try {
      state.presets = await invoke('delete_rename_preset', { id: preset.id });
    } catch (error) {
      deps.showToast(String(error));
      return;
    }
    state.selectedPreset = '';
    renderPresets();
  });

  // --- Apply
  apply.addEventListener('click', () => {
    const items = state.rows
      .filter(row => rowState(row).kind === 'ok' || rowState(row).kind === 'pending')
      .map(row => ({ path: row.photo.path, newName: row.newStem }));
    if (!items.length) return;
    modal.close();
    runBatch(items, finishBatch);
  });

  renderSteps();
  renderPresets();
  changed();
  addSelect.focus();
  try {
    state.presets = await invoke('list_rename_presets');
  } catch (error) {
    console.error('Saved recipes unreadable', error);
    state.presets = [];
  }
  if (modal.overlay.isConnected) renderPresets();
}
