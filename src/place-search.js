// Recherche d'un lieu par son nom dans la barre du mode Carte (commande search_places, voir place_search.rs). Disponible seulement avec Internet
// (mode hors ligne désactivé) : en mode hors ligne le champ est absent. Lancée à la validation (Entrée), jamais à la frappe.

import { invoke } from '@tauri-apps/api/core';
import { t, tp } from './i18n.js';
import { isOffline } from './settings-defaults.js';

let form, input, results, host;

function clearResults() {
  results.replaceChildren();
  results.hidden = true;
}

function showResults(places) {
  results.replaceChildren();
  if (!places.length) {
    const none = document.createElement('li');
    none.className = 'map-search-empty';
    none.textContent = t('No place found');
    results.append(none);
  }
  for (const place of places) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = place.name;
    button.title = place.name;
    button.addEventListener('click', () => { clearResults(); host.goTo(place); });
    item.append(button);
    results.append(item);
  }
  results.hidden = false;
}

async function search() {
  const query = input.value.trim();
  if (!query || isOffline()) return;
  form.classList.add('busy');
  try {
    showResults(await invoke('search_places', { query }));
  } catch (error) {
    clearResults();
    host.showToast(error === 'internet_disabled' ? t('Offline mode is on (Settings > General)') : t('Place search failed: {error}', { error: String(error) }));
  } finally {
    form.classList.remove('busy');
  }
}

/** Champ de recherche affiché seulement si Internet est permis ; à rappeler quand le mode hors ligne change. */
export function updatePlaceSearchAvailability() {
  if (!form) return;
  form.hidden = isOffline();
  if (form.hidden) clearResults();
}

/** `host` : { goTo(place), showToast(message) }. */
export function initPlaceSearch(options) {
  host = options;
  form = document.getElementById('map-search');
  input = document.getElementById('map-search-input');
  results = document.getElementById('map-search-results');
  form.addEventListener('submit', event => { event.preventDefault(); search(); });
  input.addEventListener('keydown', event => { if (event.key === 'Escape') { clearResults(); input.blur(); } event.stopPropagation(); });
  document.addEventListener('pointerdown', event => { if (!form.contains(event.target)) clearResults(); });
  updatePlaceSearchAvailability();
}
