// Content search (local AI, SigLIP 2): the setting, the gating of every semantic element, the Settings section and the launch of the analysis.
// See dev_tools/Evolutions/feat semantic search SigLIP 2.md (§9). Nothing here talks to the backend about the feature while it is disabled,
// except the one `set_semantic_enabled` call that tells the backend so.

import './semantic.css';
import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n.js';
import { readBool } from './settings-defaults.js';

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

// hostApi: enqueueTask(task) and showToast(message), as faces-panel.js.
export async function initSemanticSettings(hostApi) {
  host = hostApi;
  applyGate();
  await sendEnabled();
  if (enabled) await refreshModelStatus();
}
