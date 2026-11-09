// Content search (local AI, SigLIP 2): the setting, the gating of every semantic element, the Settings section and the launch of the analysis.
// See dev_tools/Evolutions/feat semantic search SigLIP 2.md (§9). Nothing here talks to the backend about the feature while it is disabled,
// except the one `set_semantic_enabled` call that tells the backend so.

import './semantic.css';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { t, tp, onLanguageChange } from './i18n.js';
import { readBool, readChoice } from './settings-defaults.js';
import { confirmDialog } from './photo-actions.js';
import { choiceDialog } from './metadata-writes.js';

const ENABLED_STORAGE_KEY = 'semanticSearch';

let host = null; // functions provided by main.js (see initSemanticSettings)
let enabled = readBool(ENABLED_STORAGE_KEY); // the setting
let modelStatus = null; // last get_semantic_model_status (null: not read yet, or the feature is off)
const changeListeners = new Set();

/** The single source of truth: the setting is on AND the model is installed. Every semantic entry, menu item and shortcut checks this. */
export function isSemanticEnabled() {
  return enabled && modelStatus?.installed === true;
}

/** The setting alone (Settings section: the model may still have to be installed). */
export function isSemanticSettingOn() {
  return enabled;
}

/** `listener()` is called each time `isSemanticEnabled()` may have changed. Returns the function that removes it. */
export function onSemanticChange(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** `no-semantic` on <body> hides every `.semantic-only` element (semantic.css). */
function applyGate() {
  document.body.classList.toggle('no-semantic', !isSemanticEnabled());
  for (const listener of changeListeners) {
    try { listener(); } catch (error) { console.error('Semantic listener failed', error); }
  }
}

/** Backend error keys (semantic*.rs) translated; other messages are shown as they are. */
export function semanticErrorMessage(error) {
  const text = String(error);
  const messages = {
    semantic_disabled: 'Content search is disabled (Settings > Content search)',
    semantic_scan_running: 'A content analysis is already running',
    semantic_model_missing: 'Install the content search model first (Settings > Content search)',
    semantic_unsupported_platform: 'Content search is not available on this system',
    internet_disabled: 'Offline mode is on (Settings > General)',
  };
  return text in messages ? t(messages[text]) : text;
}

/** Reads the model status (only when the setting is on: the backend refuses otherwise) and updates the gating. */
export async function refreshModelStatus() {
  if (!enabled) {
    modelStatus = null;
  } else {
    try {
      modelStatus = await invoke('get_semantic_model_status');
    } catch (error) {
      console.error('Content search model status unreadable', error);
      modelStatus = null;
    }
  }
  applyGate();
  return modelStatus;
}

/** Tells the backend, then (when on) reads the model status. Awaited before any other semantic command. */
async function sendEnabled() {
  try {
    await invoke('set_semantic_enabled', { enabled });
  } catch (error) {
    console.error('Content search setting rejected', error);
  }
}

// ==========================================
// SETTINGS SECTION
// ==========================================
const isOffline = () => readBool('offlineMode');
const byId = id => document.getElementById(id);

function formatMegabytes(bytes) {
  const megabytes = bytes / 1e6;
  return t('{size} MB', { size: megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes) });
}

// Model line: status, Download (greyed in offline mode) / Import buttons, and the list of files to fetch by hand.
function renderModelStatus() {
  const status = byId('semantic-model-status');
  const download = byId('btn-semantic-model-download');
  const importButton = byId('btn-semantic-model-import');
  const list = byId('semantic-model-files');
  if (!modelStatus) {
    status.textContent = enabled ? t('Checking the content search model…') : '';
    download.hidden = true;
    importButton.hidden = true;
    list.replaceChildren();
    return;
  }
  const offline = isOffline();
  const name = `${modelStatus.label} (${formatMegabytes(modelStatus.modelSize)})`;
  importButton.hidden = !modelStatus.supported;
  download.hidden = !modelStatus.supported || modelStatus.installed;
  // Offline mode: the button stays visible but greyed, with the offline explanation; the files to fetch by hand are listed open.
  download.disabled = offline;
  download.title = offline ? t('Offline mode is on (Settings > General)') : '';
  if (offline && modelStatus.supported && !modelStatus.installed) list.closest('details').open = true;
  if (!modelStatus.supported) status.textContent = t('Content search is not available on this system');
  else if (modelStatus.installed) status.textContent = t('{name}: installed in {folder}', { name, folder: modelStatus.directory });
  else if (offline) status.textContent = t('{name}: not installed. Offline mode: download the files listed below ({size}) on another computer, then install them from a folder. They are stored in {folder}.', { name, size: formatMegabytes(modelStatus.missingSize), folder: modelStatus.directory });
  else status.textContent = t('{name}: not installed. Download needed: {size}. It is stored in {folder}.', { name, size: formatMegabytes(modelStatus.missingSize), folder: modelStatus.directory });
  download.textContent = t('Download ({size})', { size: formatMegabytes(modelStatus.missingSize) });
  list.replaceChildren(...modelStatus.files.map(file => {
    const item = document.createElement('li');
    const fileName = document.createElement('strong');
    fileName.textContent = `${file.installed ? '✓ ' : ''}${file.name} (${formatMegabytes(file.size)})`;
    const url = document.createElement('code');
    url.textContent = file.url;
    const sha = document.createElement('code');
    sha.textContent = `SHA-256 ${file.sha256}`;
    item.append(fileName, url, sha);
    return item;
  }));
  const hasData = modelStatus.installed;
  byId('btn-semantic-delete-model').disabled = !modelFilesInstalled();
  byId('btn-semantic-scan-all').disabled = !hasData;
}

/** Model files (not counting the ONNX Runtime library shared with the faces) present on disk. */
function modelFilesInstalled() {
  if (!modelStatus) return false;
  return modelStatus.files.filter(file => file.installed).length - (modelStatus.runtimeInstalled ? 1 : 0) > 0;
}

// "x of y photos analysed" and the storage used (statistics of the whole library), read when the section opens and after a change.
let lastStats = null;
let statsToken = 0;
async function refreshStats() {
  if (!enabled) return null;
  const token = ++statsToken;
  try {
    const stats = await invoke('get_semantic_stats', { folder: null, recursive: false, photoIds: null });
    if (token !== statsToken) return null;
    lastStats = stats;
  } catch (error) {
    console.error('Content analysis statistics unreadable', error);
    lastStats = null;
  }
  renderStats();
  return lastStats;
}

function renderStats() {
  const analysis = byId('semantic-analysis-status');
  const storage = byId('semantic-storage-status');
  if (!lastStats) {
    analysis.textContent = '';
    storage.textContent = '';
    return;
  }
  const { total, analysed, failed, bytes } = lastStats;
  analysis.textContent = tp('{analysed} of {count} photo analysed', total, { analysed: analysed.toLocaleString(), count: total.toLocaleString() })
    + (failed > 0 ? ` · ${tp('{count} could not be read', failed)}` : '');
  storage.textContent = t('Space used by the analysis data: {size}', { size: formatMegabytes(bytes) });
  byId('btn-semantic-delete-data').disabled = analysed === 0 && failed === 0 && bytes === 0;
}

function renderSection() {
  byId('semantic-toggle').checked = enabled;
  byId('semantic-settings').hidden = !enabled;
  renderModelStatus();
  renderStats();
}

/** Messages of the import: one line per problem (a file missing or with a wrong checksum). */
async function importModel() {
  const directory = await open({ directory: true, multiple: false, title: t('Folder containing the content search model files') });
  if (typeof directory !== 'string' || !directory) return;
  try {
    modelStatus = await invoke('import_semantic_model', { directory });
    renderSection();
    applyGate();
    host.showToast(t('Content search model installed'));
  } catch (error) {
    const lines = String(error);
    // One problem per line: shown in a dialog (a toast would cut them); a single key such as semantic_disabled is translated.
    await choiceDialog({
      title: t('Installation from a folder failed'),
      message: lines.includes('\n') ? lines : semanticErrorMessage(lines),
      buttons: [{ label: t('OK'), value: 'ok', primary: true, cancel: true }],
      scrollable: true,
    });
    refreshModelStatus().then(renderSection);
  }
}

function downloadModel() {
  host.enqueueTask({
    kind: 'semantic-models',
    path: null,
    command: 'download_semantic_model',
    args: {},
    labelKey: 'Content search model download',
    onResult: async (_result, stopped, error) => {
      if (error) host.showToast(t('Content search model download failed: {error}', { error: semanticErrorMessage(error) }));
      await refreshModelStatus();
      renderSection();
      if (!error && !stopped && modelStatus?.installed) host.showToast(t('Content search model installed'));
    },
  });
}

async function deleteAnalysisData() {
  const confirmed = await confirmDialog({
    title: t('Delete analysis data'),
    message: t('Delete the content analysis of every photo, and the dismissed suggestions? Photos and their metadata are not touched. The analysis can be run again; it takes time.'),
    confirmLabel: t('Delete'),
    cancelLabel: t('Cancel'),
  });
  if (!confirmed) return;
  try {
    await invoke('delete_semantic_data');
  } catch (error) {
    host.showToast(semanticErrorMessage(error));
    return;
  }
  await refreshStats();
  host.showToast(t('Analysis data deleted'));
}

async function deleteModelFiles() {
  const confirmed = await confirmDialog({
    title: t('Delete the model files'),
    message: t('Delete the content search model files from this computer? Content search stops working until the model is installed again ({size} to download). The analysis data is kept.', { size: formatMegabytes(modelStatus?.modelSize ?? 0) }),
    confirmLabel: t('Delete'),
    cancelLabel: t('Cancel'),
  });
  if (!confirmed) return;
  try {
    modelStatus = await invoke('delete_semantic_model');
  } catch (error) {
    host.showToast(semanticErrorMessage(error));
    refreshModelStatus().then(renderSection);
    return;
  }
  renderSection();
  applyGate();
  host.showToast(t('Content search model files deleted'));
}

// ==========================================
// ENABLING AND DISABLING
// ==========================================
/** True when disabling would leave something on disk: analysis data or the model files. */
async function hasStoredData() {
  const stats = await refreshStats();
  return modelFilesInstalled() || Boolean(stats && (stats.analysed > 0 || stats.failed > 0 || stats.bytes > 0));
}

async function setEnabled(wanted) {
  if (wanted === enabled) return;
  if (!wanted) {
    // Data on disk: ask. The delete commands refuse once the feature is disabled, so they run BEFORE set_semantic_enabled(false).
    let choice = 'keep';
    if (await hasStoredData()) {
      choice = await choiceDialog({
        title: t('Disable content search'),
        message: t('Keep the analysis data and the model files, or delete them? Kept, enabling content search again is instant. A running analysis is stopped.'),
        buttons: [
          { label: t('Cancel'), value: 'cancel', cancel: true },
          { label: t('Delete data and model files'), value: 'delete', tone: 'red' },
          { label: t('Keep the data'), value: 'keep', primary: true },
        ],
      });
      if (choice === 'cancel') {
        byId('semantic-toggle').checked = true;
        return;
      }
    }
    host.stopTasks?.(); // waiting analyses leave the queue, the running one is stopped
    if (choice === 'delete') {
      try {
        await invoke('delete_semantic_data');
        await invoke('delete_semantic_model');
      } catch (error) {
        // Nothing is disabled: the user sees what failed and can try again.
        host.showToast(semanticErrorMessage(error));
        byId('semantic-toggle').checked = true;
        return;
      }
    }
  }
  enabled = wanted;
  try { localStorage.setItem(ENABLED_STORAGE_KEY, String(enabled)); } catch { /* storage unavailable: setting not remembered */ }
  await sendEnabled();
  lastStats = null;
  await refreshModelStatus();
  renderSection();
  if (enabled) refreshStats();
}

function bindCheckbox(id, key) {
  const input = byId(id);
  input.checked = readBool(key);
  input.addEventListener('change', () => {
    try { localStorage.setItem(key, String(input.checked)); } catch { /* storage unavailable: setting not remembered */ }
  });
}

/** Scan speed (ONNX Runtime threads): 1, 2 or 4. */
export function semanticScanThreads() {
  return Number(readChoice('semanticScanThreads', ['1', '2', '4']));
}

/** Offline mode changed (main.js): the Download button follows. */
export function onSemanticOfflineChanged() {
  if (initialised) renderModelStatus();
}

let initialised = false;

// hostApi: enqueueTask(task) and showToast(message), as faces-panel.js; stopTasks() stops the analyses of the queue.
export async function initSemanticSettings(hostApi) {
  host = hostApi;
  applyGate();
  byId('semantic-toggle').addEventListener('change', event => setEnabled(event.target.checked));
  bindCheckbox('semantic-in-keyword-search', 'semanticInKeywordSearch');
  bindCheckbox('semantic-show-score', 'semanticShowScore');
  const threads = byId('semantic-threads');
  threads.value = String(semanticScanThreads());
  threads.addEventListener('change', () => {
    try { localStorage.setItem('semanticScanThreads', threads.value); } catch { /* storage unavailable: setting not remembered */ }
  });
  byId('btn-semantic-model-download').addEventListener('click', downloadModel);
  byId('btn-semantic-model-import').addEventListener('click', importModel);
  byId('btn-semantic-delete-data').addEventListener('click', deleteAnalysisData);
  byId('btn-semantic-delete-model').addEventListener('click', deleteModelFiles);
  document.querySelector('.settings-tab-btn[data-tab="semantic"]').addEventListener('click', () => {
    if (!enabled) return;
    refreshModelStatus().then(renderSection);
    refreshStats();
  });
  onLanguageChange(renderSection);
  initialised = true;
  renderSection();
  await sendEnabled();
  if (enabled) {
    await refreshModelStatus();
    renderSection();
  }
}
