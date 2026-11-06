// Window "Find duplicates > More…": the kind of search (identical or similar images), the settings of each, and where to search. The choices are
// applied to this search only, unless "Save these settings as default" is ticked: the quick menu entries then use them (see duplicates.js).
import { t, onLanguageChange } from './i18n.js';
import { compileNamePattern, extractNameKey } from './raw-settings.js';
import { getIdenticalSettings, getSimilarSettings, saveIdenticalSettings, saveSimilarSettings, getKeepSettings, saveKeepSettings, KEEP_CRITERIA } from './duplicates.js';

const byId = id => document.getElementById(id);
const stemOf = fileName => fileName.replace(/\.[^./\\]*$/, '');

let currentSpec = null; // { scope, label, compareWithLibrary } of the search being prepared
let onRun = null;

const kindButtons = () => [...document.querySelectorAll('#dup-kind .location-filter-option')];

function selectedKind() {
  return kindButtons().find(button => button.getAttribute('aria-checked') === 'true')?.dataset.value === 'similar' ? 'similar' : 'identical';
}

function selectKind(kind) {
  for (const button of kindButtons()) button.setAttribute('aria-checked', String(button.dataset.value === kind));
  syncAvailability();
}

// Test line under the name pattern: the key the pattern draws from a typed name, or why it is of no use.
function renderPatternResult() {
  const pattern = byId('dup-pattern');
  const result = byId('dup-pattern-result');
  const regex = compileNamePattern(pattern.value);
  pattern.classList.toggle('invalid', regex === undefined);
  pattern.setAttribute('aria-invalid', regex === undefined ? 'true' : 'false');
  result.classList.toggle('raw-pattern-error', regex === undefined);
  const typed = byId('dup-pattern-test').value.trim();
  if (regex === undefined) result.textContent = t('Invalid pattern');
  else if (regex === null) result.textContent = t('No pattern: the whole name without extension is compared');
  else if (!typed) result.textContent = t('Type a file name to test the pattern');
  else {
    const stem = stemOf(typed);
    const match = regex.exec(stem);
    result.textContent = match ? t('Key extracted: {key}', { key: (match[1] ?? match[0]) || stem }) : t('No match: the whole name without extension is compared');
  }
}

// Enables only the fields that matter for what is ticked, and shows the settings of the chosen kind.
function syncAvailability() {
  const kind = selectedKind();
  // The inactive settings stay in the layout (invisible, out of reach) so the window never changes height when the kind changes.
  for (const [id, active] of [['dup-identical', kind === 'identical'], ['dup-similar', kind === 'similar']]) {
    byId(id).classList.toggle('inactive', !active);
    byId(id).inert = !active;
  }
  byId('dup-ignore-metadata').disabled = !byId('dup-hash').checked;
  const nameOn = byId('dup-name').checked;
  for (const id of ['dup-pattern', 'dup-pattern-test', 'dup-min-length', 'dup-name-date', 'dup-name-raw']) byId(id).disabled = !nameOn;
  byId('dup-pattern-result').hidden = !nameOn;
  byId('dup-burst-ms').disabled = !byId('dup-bursts').checked;
  byId('dup-run').disabled = kind === 'identical' && !byId('dup-hash').checked && !nameOn; // at least one criterion
  byId('dup-run').title = byId('dup-run').disabled ? t('Tick at least one criterion') : '';
  // The saving only covers the settings of the kind shown, never the scope.
  byId('dup-save-label').textContent = t(kind === 'identical' ? 'Save these settings as default for identical searches' : 'Save these settings as default for similar searches');
}

function applyLanguage() {
  const tip = t('Metadata is ignored for JPEG, PNG and WebP. Other formats (HEIC, AVIF, GIF, BMP, RAW) are compared as whole files: copies whose metadata differ are not found.');
  byId('dup-ignore-metadata').closest('label').title = tip;
  byId('dup-sensitivity').closest('label').title = t('Strict: almost identical copies. Normal: resized or recompressed copies. Loose: also edited versions, with more false matches.');
  renderPatternResult();
  syncAvailability();
}

function fillFromSettings() {
  const identical = getIdenticalSettings();
  byId('dup-hash').checked = identical.hash;
  byId('dup-ignore-metadata').checked = identical.ignoreMetadata;
  byId('dup-name').checked = identical.name;
  byId('dup-pattern').value = identical.pattern;
  byId('dup-pattern-test').value = '';
  byId('dup-min-length').value = String(identical.minLength);
  byId('dup-name-date').checked = identical.sameDate;
  byId('dup-name-raw').checked = identical.includeRawPairs;
  const similar = getSimilarSettings();
  byId('dup-sensitivity').value = similar.sensitivity;
  byId('dup-rotations').checked = similar.rotations;
  byId('dup-bursts').checked = similar.ignoreBursts;
  byId('dup-burst-ms').value = String(similar.burstMs);
  byId('dup-similar-raw').checked = similar.includeRawPairs;
  byId('dup-save').checked = false;
}

const clampNumber = (value, fallback, min, max) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

function run() {
  const kind = selectedKind();
  let settings;
  if (kind === 'identical') {
    if (compileNamePattern(byId('dup-pattern').value) === undefined && byId('dup-name').checked) {
      byId('dup-pattern').focus(); // an invalid pattern would make the search fail: the field shows why
      return;
    }
    settings = {
      hash: byId('dup-hash').checked,
      ignoreMetadata: byId('dup-ignore-metadata').checked,
      name: byId('dup-name').checked,
      pattern: byId('dup-pattern').value.trim(),
      minLength: clampNumber(byId('dup-min-length').value, 3, 2, 50),
      sameDate: byId('dup-name-date').checked,
      includeRawPairs: byId('dup-name-raw').checked,
    };
    if (!settings.hash && !settings.name) return;
    if (byId('dup-save').checked) saveIdenticalSettings(settings);
  } else {
    settings = {
      sensitivity: byId('dup-sensitivity').value,
      rotations: byId('dup-rotations').checked,
      ignoreBursts: byId('dup-bursts').checked,
      burstMs: clampNumber(byId('dup-burst-ms').value, 1000, 0, 60000),
      includeRawPairs: byId('dup-similar-raw').checked,
    };
    if (byId('dup-save').checked) saveSimilarSettings(settings);
  }
  const scope = currentSpec.scope.kind === 'folder' ? { ...currentSpec.scope, recursive: byId('dup-subfolders').checked } : currentSpec.scope;
  const spec = { ...currentSpec, scope, compareWithLibrary: byId('dup-library').checked };
  close();
  onRun(kind, spec, settings);
}

function close() {
  byId('duplicates-modal').classList.add('hidden');
}

/** Opens the window for `spec` ({ scope, label, compareWithLibrary }); `callback(kind, spec, settings)` starts the search. */
export function openDuplicatesModal(spec, callback) {
  currentSpec = spec;
  onRun = callback;
  fillFromSettings();
  byId('dup-scope').textContent = spec.label;
  const isFolder = spec.scope.kind === 'folder';
  byId('dup-subfolders-row').hidden = !isFolder;
  byId('dup-subfolders').checked = isFolder ? spec.scope.recursive : true;
  byId('dup-library').checked = spec.compareWithLibrary;
  selectKind('identical');
  applyLanguage();
  byId('duplicates-modal').classList.remove('hidden');
  byId('dup-run').focus();
}

// ---------------------------------------------------------------------------
// "Best copy" panel of the results: which copy of a group is the one to keep. A floating panel under the banner, it stays open while the grid is used.
// Every change is saved and applied at once (onChange).
// ---------------------------------------------------------------------------
let keepSettings = null;
let onKeepChange = null;
let keepTimer = null;

const keepPanel = () => byId('duplicates-keep-panel');

function commitKeep(delay = 0) {
  saveKeepSettings(keepSettings);
  clearTimeout(keepTimer);
  keepTimer = setTimeout(() => onKeepChange?.(), delay);
}

// Under the banner of the results, at its right end.
function placeKeepPanel() {
  const banner = byId('duplicates-banner');
  if (!banner || banner.hidden) return;
  const rect = banner.getBoundingClientRect();
  const panel = keepPanel();
  // Right edge of the panel on the right edge of the banner, but never out of the window (a narrow grid is narrower than the panel).
  const left = Math.min(rect.right - panel.offsetWidth - 12, window.innerWidth - panel.offsetWidth - 8);
  panel.style.top = `${Math.round(rect.bottom + 6)}px`;
  panel.style.left = `${Math.max(8, Math.round(left))}px`;
}

// Two-button blocks (same mechanics as the "kind" block of the search window).
function showBlock(id, value) {
  for (const button of byId(id).querySelectorAll('.location-filter-option')) button.setAttribute('aria-checked', String(button.dataset.value === value));
}

function renderKeepList(focus = null) {
  const list = byId('dup-keep-list');
  list.replaceChildren(...keepSettings.order.map((entry, index) => {
    const item = document.createElement('li');
    item.className = 'duplicates-keep-item';
    const label = document.createElement('label');
    label.className = 'duplicates-keep-label';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = entry.enabled;
    box.addEventListener('change', () => {
      entry.enabled = box.checked;
      syncKeepFields();
      commitKeep();
    });
    const text = document.createElement('span');
    text.textContent = t(KEEP_CRITERIA[entry.key]);
    label.append(box, text);
    item.append(label);
    const move = (step, symbol, title, direction) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'duplicates-keep-move';
      button.textContent = symbol;
      button.title = title;
      button.setAttribute('aria-label', title);
      button.disabled = index + step < 0 || index + step >= keepSettings.order.length;
      button.addEventListener('click', () => {
        [keepSettings.order[index], keepSettings.order[index + step]] = [keepSettings.order[index + step], keepSettings.order[index]];
        renderKeepList({ key: entry.key, direction });
        commitKeep();
      });
      return button;
    };
    item.append(move(-1, '▲', t('Move up'), 'up'), move(1, '▼', t('Move down'), 'down'));
    return item;
  }));
  if (focus) {
    // The moved criterion keeps the focus on the same arrow, so it can be moved again from the keyboard.
    const row = keepSettings.order.findIndex(entry => entry.key === focus.key);
    const buttons = list.children[row]?.querySelectorAll('.duplicates-keep-move');
    const target = buttons?.[focus.direction === 'up' ? 0 : 1];
    (target && !target.disabled ? target : buttons?.[0] ?? buttons?.[1])?.focus();
  }
  syncKeepFields();
}

// The date direction only matters while the date criterion is ticked.
function syncKeepFields() {
  const dateOn = keepSettings.order.some(entry => entry.key === 'date' && entry.enabled);
  for (const button of byId('dup-keep-date').querySelectorAll('button')) button.disabled = !dateOn;
  showBlock('dup-keep-date', keepSettings.dateDirection);
  showBlock('dup-keep-path-mode', keepSettings.pathMode);
}

/** Shows or hides the "Best copy" panel; `callback` is called after each change, to rank the results again. */
export function toggleKeepPanel(callback) {
  const panel = keepPanel();
  if (!panel.hidden) {
    closeKeepPanel();
    return;
  }
  onKeepChange = callback;
  keepSettings = getKeepSettings();
  byId('dup-keep-path').value = keepSettings.path;
  renderKeepList();
  panel.hidden = false;
  placeKeepPanel();
  byId('dup-keep-list').querySelector('input')?.focus();
}

export function closeKeepPanel() {
  const panel = keepPanel();
  if (panel) panel.hidden = true;
}

function initKeepPanel() {
  const panel = keepPanel();
  if (!panel) return;
  byId('btn-close-duplicates-keep').addEventListener('click', closeKeepPanel);
  // Escape closes the panel (not the results behind it) while the focus is inside.
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeKeepPanel();
  });
  window.addEventListener('resize', placeKeepPanel);
  byId('dup-keep-date').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    keepSettings.dateDirection = button.dataset.value;
    syncKeepFields();
    commitKeep();
  });
  byId('dup-keep-path-mode').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    keepSettings.pathMode = button.dataset.value;
    syncKeepFields();
    commitKeep();
  });
  byId('dup-keep-path').addEventListener('input', event => {
    keepSettings.path = event.target.value;
    commitKeep(250); // not at each keystroke: the grid is sorted again
  });
  onLanguageChange(() => { if (keepSettings && !panel.hidden) renderKeepList(); });
}

export function initDuplicatesModal() {
  initKeepPanel();
  const modal = byId('duplicates-modal');
  if (!modal) return;
  byId('btn-close-duplicates').addEventListener('click', close);
  byId('dup-cancel').addEventListener('click', close);
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || modal.classList.contains('hidden')) return;
    event.preventDefault();
    close();
  });
  modal.addEventListener('change', syncAvailability);
  for (const button of kindButtons()) button.addEventListener('click', () => selectKind(button.dataset.value));
  byId('dup-pattern').addEventListener('input', renderPatternResult);
  byId('dup-pattern-test').addEventListener('input', renderPatternResult);
  byId('dup-run').addEventListener('click', run);
  onLanguageChange(applyLanguage);
}
