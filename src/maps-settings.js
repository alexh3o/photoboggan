// Paramètres > Cartes (la carte du lieu, le zoom par défaut et les zones sont gérés par location-panel.js et private-zones-modal.js) : ici le style de
// la carte. Le style (couleurs, icônes, polices) est celui fourni avec l'application, qui marche sans Internet. Avec la case cochée, il est
// téléchargé chez le fournisseur à chaque téléchargement de zone et prend alors le pas sur celui de l'application ; « Revenir au style d'origine »
// supprime cette copie (private_maps.rs : has_downloaded_map_style, reset_map_style).

import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n.js';
import { reloadAllMaps } from './map-view.js';

const REFRESH_STORAGE_KEY = 'mapStyleRefresh';

/** Le style doit être téléchargé avec chaque zone (case des Paramètres > Cartes, décochée par défaut). */
export function isMapStyleRefreshEnabled() {
  try { return localStorage.getItem(REFRESH_STORAGE_KEY) === 'true'; } catch { return false; }
}

const isOffline = () => { try { return localStorage.getItem('offlineMode') === 'true'; } catch { return false; } };

/** `showToast(message)` vient de main.js. */
export function initMapsSettings({ showToast }) {
  const refreshToggle = document.getElementById('map-style-refresh-toggle');
  const resetButton = document.getElementById('btn-map-style-reset');
  const offlineHint = document.getElementById('show-map-offline-hint');
  const offlineToggle = document.getElementById('offline-mode-toggle');

  refreshToggle.checked = isMapStyleRefreshEnabled();
  refreshToggle.addEventListener('change', () => {
    try { localStorage.setItem(REFRESH_STORAGE_KEY, String(refreshToggle.checked)); } catch { /* réglage non mémorisé */ }
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
