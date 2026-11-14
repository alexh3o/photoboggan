// Paramètres > Cartes (la carte du lieu, le zoom par défaut et les zones sont gérés par location-panel.js et private-zones-modal.js) : ici le style de
// la carte. Le style (couleurs, icônes, polices) est celui fourni avec l'application, qui marche sans Internet. Avec la case cochée, il est
// téléchargé chez le fournisseur à chaque téléchargement de zone et prend alors le pas sur celui de l'application ; « Revenir au style d'origine »
// supprime cette copie (private_maps.rs : has_downloaded_map_style, reset_map_style).

import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n.js';
import { readBool, isOffline, writeStored } from './settings-defaults.js';
import { reloadAllMaps } from './map-view.js';

const REFRESH_STORAGE_KEY = 'mapStyleRefresh';

/** Ouvre les Paramètres sur l'onglet demandé ('maps', 'general'…) : lien des messages « Carte désactivée », « Mode hors ligne »… */
export function openSettingsTab(tab) {
  document.getElementById('btn-open-settings').click();
  document.querySelector(`.settings-tab-btn[data-tab="${tab}"]`)?.click();
}

/** Rend un élément de message cliquable vers l'onglet `tab` des Paramètres (clic ou Entrée / Espace), ou ne l'est plus si `tab` est vide. */
export function setSettingsLink(element, tab) {
  element.classList.toggle('settings-link', !!tab);
  if (tab) {
    element.dataset.settingsTab = tab;
    element.setAttribute('role', 'link');
    element.tabIndex = 0;
    element.title = t(tab === 'maps' ? 'Open the map settings' : 'Open the general settings, or disable the map widget in display options');
  } else {
    delete element.dataset.settingsTab;
    element.removeAttribute('role');
    element.removeAttribute('tabindex');
    element.removeAttribute('title');
  }
}

/** À appeler une fois par élément de message : l'action n'a lieu que s'il est marqué comme lien (setSettingsLink). */
export function bindSettingsLink(element) {
  element.addEventListener('click', () => { if (element.dataset.settingsTab) openSettingsTab(element.dataset.settingsTab); });
  element.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && element.dataset.settingsTab) { event.preventDefault(); openSettingsTab(element.dataset.settingsTab); }
  });
}

/** Le style doit être téléchargé avec chaque zone (case des Paramètres > Cartes, décochée par défaut). */
export function isMapStyleRefreshEnabled() {
  return readBool(REFRESH_STORAGE_KEY);
}

/** `showToast(message)` vient de main.js. */
export function initMapsSettings({ showToast }) {
  const refreshToggle = document.getElementById('map-style-refresh-toggle');
  const resetButton = document.getElementById('btn-map-style-reset');
  const offlineHint = document.getElementById('show-map-offline-hint');
  const offlineToggle = document.getElementById('offline-mode-toggle');

  refreshToggle.checked = isMapStyleRefreshEnabled();
  refreshToggle.addEventListener('change', () => {
    writeStored(REFRESH_STORAGE_KEY, refreshToggle.checked);
  });

  // « Internet nécessaire » sous la case de la carte quand le mode hors ligne est activé.
  const updateOfflineHint = () => { offlineHint.hidden = !isOffline(); };
  updateOfflineHint();
  offlineToggle.addEventListener('change', updateOfflineHint);

  // Le bouton n'est actif que s'il y a une copie téléchargée à supprimer ; relu à l'ouverture de l'onglet.
  async function updateResetButton() {
    try {
      resetButton.disabled = !(await invoke('has_downloaded_map_style'));
    } catch (error) {
      console.error('Map style state unavailable', error);
    }
  }
  document.querySelector('.settings-tab-btn[data-tab="maps"]').addEventListener('click', updateResetButton);
  updateResetButton();

  resetButton.addEventListener('click', async () => {
    resetButton.disabled = true;
    try {
      await invoke('reset_map_style');
      reloadAllMaps(); // cartes affichées : style embarqué rechargé
      showToast(t('Original map style restored'));
    } catch (error) {
      console.error('Map style reset failed', error);
      showToast(t('The map style could not be reset: {error}', { error: String(error) }));
    }
    updateResetButton();
  });
}
