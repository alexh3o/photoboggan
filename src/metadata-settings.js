// Paramètres, onglet Métadonnées : chemin d'écriture des métadonnées (ExifTool ou écriture interne) et exécutable ExifTool.
// Les réglages sont mémorisés localement et envoyés au backend au démarrage puis à chaque changement (voir src-tauri/src/exiftool.rs).

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { t, onLanguageChange } from './i18n.js';

const WRITER_STORAGE_KEY = 'metadataWriter'; // « exiftool » (par défaut) ou « internal »
const EXIFTOOL_PATH_STORAGE_KEY = 'exiftoolPath'; // exécutable choisi par l'utilisateur ; vide : détection automatique

let writerMode = localStorage.getItem(WRITER_STORAGE_KEY) === 'internal' ? 'internal' : 'exiftool';
let customPath = localStorage.getItem(EXIFTOOL_PATH_STORAGE_KEY) || '';
let lastStatus = null; // dernier état renvoyé par get_exiftool_status
let statusToken = 0;

function sendSettings() {
  return invoke('set_metadata_writer', { mode: writerMode, customPath: customPath || null })
    .catch(error => console.error("Réglage de l'écriture des métadonnées refusé", error));
}

function renderStatus() {
  const status = document.getElementById('exiftool-status');
  const pathLabel = document.getElementById('exiftool-custom-path');
  const resetButton = document.getElementById('btn-reset-exiftool');
  pathLabel.textContent = customPath;
  pathLabel.title = customPath;
  pathLabel.classList.toggle('hidden', !customPath);
  resetButton.classList.toggle('hidden', !customPath);
  if (!lastStatus) {
    status.textContent = t('Looking for ExifTool…');
    status.classList.remove('exiftool-missing');
    return;
  }
  if (lastStatus.available) {
    const sourceLabels = { bundled: t('embedded version'), path: t('found in the PATH'), custom: t('chosen file') };
    status.textContent = t('ExifTool {version} ({source}): {path}', {
      version: lastStatus.version,
      source: sourceLabels[lastStatus.source] || lastStatus.source,
      path: lastStatus.path,
    });
  } else {
    // Le message du backend détaille ce qui a été essayé (version embarquée, PATH, chemin choisi).
    status.textContent = `${lastStatus.error}${writerMode === 'exiftool' ? ` ${t('Metadata will not be written until ExifTool is found.')}` : ''}`;
  }
  status.classList.toggle('exiftool-missing', !lastStatus.available);
}

// Nouvelle détection (l'utilisateur a pu installer ou déplacer ExifTool) : à l'ouverture de l'onglet et après un changement de réglage.
async function refreshStatus() {
  const token = ++statusToken;
  lastStatus = null;
  renderStatus();
  try {
    const status = await invoke('get_exiftool_status');
    if (token === statusToken) lastStatus = status;
  } catch (error) {
    if (token === statusToken) lastStatus = { available: false, error: String(error) };
  }
  if (token === statusToken) renderStatus();
}

async function changeSettings(update) {
  update();
  localStorage.setItem(WRITER_STORAGE_KEY, writerMode);
  if (customPath) localStorage.setItem(EXIFTOOL_PATH_STORAGE_KEY, customPath);
  else localStorage.removeItem(EXIFTOOL_PATH_STORAGE_KEY);
  await sendSettings();
  refreshStatus();
}

export function initMetadataSettings() {
  sendSettings();
  for (const radio of document.querySelectorAll('input[name="metadata-writer"]')) {
    radio.checked = radio.value === writerMode;
    radio.addEventListener('change', () => {
      if (radio.checked) changeSettings(() => { writerMode = radio.value; });
    });
  }
  document.getElementById('btn-choose-exiftool').addEventListener('click', async () => {
    const chosen = await open({ multiple: false, directory: false, title: t('Choose ExifTool…') });
    if (typeof chosen === 'string' && chosen) changeSettings(() => { customPath = chosen; });
  });
  document.getElementById('btn-reset-exiftool').addEventListener('click', () => changeSettings(() => { customPath = ''; }));
  document.querySelector('.settings-tab-btn[data-tab="metadata"]').addEventListener('click', refreshStatus);
  onLanguageChange(renderStatus);
  renderStatus();
}
