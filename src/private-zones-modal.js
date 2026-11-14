// Fenêtre « Zones privées et cartes hors ligne » : liste des zones à gauche ; à droite, accueil, détail d'une zone (aperçu local, informations,
// actions) ou création d'une zone (dessin, nom, niveau de détail, estimation). Ouverte depuis le groupe Lieu du panneau Info, Paramètres >
// Général, et plus tard la vue carte (bouton sur le modèle de « Réviser les visages »).
// Les téléchargements passent par la file des tâches (toast, Sablier, arrêt) ; les zones sont dans le backend (private_maps.rs).

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { t, tp, getLanguage, formatBytes } from './i18n.js';
import { readStored, writeStored } from './settings-defaults.js';
import { createModal, confirmDialog, promptDialog } from './photo-actions.js';
import { createMapView, reloadAllMaps } from './map-view.js';
import { isMapNetworkAllowed } from './map-config.js';
import { isMapStyleRefreshEnabled } from './maps-settings.js';
import { startZoneDrawing } from './zone-drawing.js';
import {
  DETAIL_LEVELS, MAX_ZONE_TILES, reloadZones, ensureZonesLoaded, getZones, estimateZone, zonesFeatureCollection, zoneBounds,
  zoneFileName, isZoneNameTaken,
} from './private-zones.js';

const WELCOME_DONE_KEY = 'privateZonesWelcomeDone';
const FOCUSABLE = 'button:not([disabled]), input:not([disabled])';

let host = { enqueueTask: () => false, showToast: () => {} };
const downloading = new Set(); // zones dont un téléchargement est en file ou en cours
let refreshOpenModal = null; // rafraîchit la fenêtre ouverte (fin d'un téléchargement)

/** `enqueueTask` et `showToast` viennent de main.js (file des tâches, messages). */
export function initPrivateZonesModal(options) {
  host = { ...host, ...options };
}

/** Première activation de la carte : la fenêtre s'ouvre sur l'accueil si aucune zone n'existe et que l'accueil n'a pas été refusé. */
export async function offerPrivateZonesWelcome() {
  if (readStored(WELCOME_DONE_KEY) === 'true') return;
  const zones = await ensureZonesLoaded();
  if (zones.length === 0) openPrivateZonesModal();
}

const ERROR_KEYS = {
  internet_disabled: 'Offline mode is on (Settings > General)',
  zone_too_large: 'The zone is too large for this detail level.',
  invalid_zone_geometry: 'The zone is not valid.',
  invalid_zone_name: 'Enter a name for the zone.',
  zone_name_taken: 'Another zone already has this name.',
  invalid_mbtiles: 'This file is not a valid MBTiles file.',
  mbtiles_not_vector: 'This MBTiles file does not contain vector tiles.',
  mbtiles_without_bounds: 'This MBTiles file does not give its area.',
  imported_zone: 'An imported zone cannot be updated: import the file again.',
};
const errorMessage = error => (ERROR_KEYS[error] ? t(ERROR_KEYS[error]) : String(error));

function formatRelativeDate(millis) {
  const seconds = (millis - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  const relative = new Intl.RelativeTimeFormat(getLanguage(), { numeric: 'auto' });
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  return relative.format(0, 'minute');
}

const detailLabel = zoom => t(DETAIL_LEVELS.find(level => level.zoom === zoom)?.labelKey || 'Streets');

// État d'une zone : icône et texte (jamais la couleur seule).
function zoneState(zone) {
  if (downloading.has(zone.id)) return { icon: '⟳', text: t('Downloading'), kind: 'busy' };
  if (zone.status === 'ready') return { icon: '✓', text: zone.source === 'import' ? t('Imported') : t('Ready'), kind: 'ok' };
  if (zone.status === 'incomplete') return { icon: '!', text: tp('Incomplete ({count} missing tiles)', zone.missing_count), kind: 'warn' };
  if (zone.status === 'failed') return { icon: '✕', text: t('Download failed'), kind: 'error' };
  return { icon: '…', text: t('Not downloaded'), kind: 'warn' };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className = '', onClick = null) {
  const node = element('button', className, label);
  node.type = 'button';
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

// Case « Privée » (création et détail d'une zone) avec son explication.
function privacyCheckbox(checked, onChange) {
  const label = element('label', 'pz-privacy');
  const input = element('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const text = element('span');
  text.append(element('strong', '', t('Private')), element('span', 'pz-muted', ` — ${t('Private zone setting help')}`));
  label.append(input, text);
  return label;
}

/** Télécharge (ou met à jour) une zone : tâche de la file. */
function enqueueDownload(zone) {
  downloading.add(zone.id);
  const queued = host.enqueueTask({
    kind: 'private-map',
    path: null,
    command: 'download_private_zone',
    args: { zoneId: zone.id, refreshStyle: isMapStyleRefreshEnabled() }, // style : celui de l'application, sauf si Paramètres > Cartes demande de le télécharger
    labelKey: 'Private zone download: {name}',
    labelParams: { name: zone.name },
    onResult: async (_result, stopped, error) => {
      downloading.delete(zone.id);
      if (error) host.showToast(t('Private zone download failed: {error}', { error: errorMessage(error) }));
      else if (!stopped) host.showToast(t('Private zone ready: {name}', { name: zone.name }));
      await reloadZones().catch(() => {});
      refreshOpenModal?.();
    },
  });
  if (!queued) downloading.delete(zone.id);
}

/** Ouvre la fenêtre de gestion des zones privées. */
export async function openPrivateZonesModal() {
  if (refreshOpenModal) return; // déjà ouverte
  await reloadZones().catch(error => console.error('Private zones unavailable', error));
  let selectedId = getZones()[0]?.id ?? null;
  let view = getZones().length ? 'detail' : 'welcome';
  let drawing = null; // outil de dessin actif (vue « new »)
  let draft = null; // { geometry, name, zoom, estimate }

  const modal = createModal({
    title: t('Offline / private zones'),
    cardClass: 'private-zones-card',
    focusSelector: FOCUSABLE,
    // Échap pendant une création : annule la création au lieu de fermer la fenêtre.
    canClose: () => {
      if (view !== 'new') return true;
      leaveEditor();
      render();
      return false;
    },
    onClose: () => {
      leaveEditor();
      mapView.dispose();
      refreshOpenModal = null;
    },
  });

  const layout = element('div', 'pz-layout');
  const listPane = element('aside', 'pz-list-pane');
  const list = element('ul', 'pz-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('Offline / private zones'));
  const listActions = element('div', 'pz-list-actions');
  listActions.append(
    button(t('New zone'), 'btn-primary', () => startEditor()),
    button(t('Import a file…'), '', () => importZone()),
  );
  listPane.append(list, listActions);
  const detailPane = element('section', 'pz-detail');
  const panel = element('div', 'pz-panel');
  const mapElement = element('div', 'pz-map');
  detailPane.append(panel, mapElement);
  layout.append(listPane, detailPane);
  modal.body.append(layout);

  const mapView = createMapView(mapElement, { isAllowed: () => true });

  function leaveEditor() {
    drawing?.stop();
    drawing = null;
    draft = null;
    if (view === 'new') view = getZones().length ? 'detail' : 'welcome';
  }

  function renderList() {
    const zones = getZones();
    list.replaceChildren(...zones.map(zone => {
      const state = zoneState(zone);
      const item = element('li', 'pz-item');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(view === 'detail' && zone.id === selectedId));
      const entry = button('', 'pz-item-button');
      // Icône du type de zone : cadenas (privée) ou nuage barré (simple carte hors ligne).
      const kindIcon = element('span', 'pz-kind', zone.private ? '🔒' : '☁');
      kindIcon.title = zone.private ? t('Private zone') : t('Offline map (not private)');
      const nameRow = element('span', 'pz-item-name');
      nameRow.append(kindIcon, document.createTextNode(` ${zone.name}`));
      entry.append(nameRow, element('span', `pz-state pz-state-${state.kind}`, `${state.icon} ${state.text}`));
      entry.addEventListener('click', () => {
        leaveEditor();
        selectedId = zone.id;
        view = 'detail';
        render();
      });
      item.append(entry);
      return item;
    }));
    list.hidden = zones.length === 0;
  }

  // Aperçu local (mode strict : aucune requête) de toutes les zones, celle choisie mise en avant et cadrée.
  function showZonesOnMap(zone) {
    mapView.show([], { strict: true, maxZoom: zone?.max_zoom ?? 14 });
    mapView.showZones(zonesFeatureCollection(getZones(), zone?.id ?? null), zone ? zoneBounds(zone) : null);
  }

  function renderWelcome() {
    panel.append(
      element('h4', 'pz-title', t('Protect places?')),
      element('p', 'pz-text', t('Private zones help')),
      element('p', 'pz-text pz-muted', t('Private zones how')),
    );
    const actions = element('div', 'pz-actions');
    actions.append(
      button(t('Create a zone'), 'btn-primary', () => startEditor()),
      button(t('Import a file…'), '', () => importZone()),
      button(t('Later'), '', () => {
        writeStored(WELCOME_DONE_KEY, 'true');
        modal.close();
      }),
    );
    panel.append(actions);
    mapElement.hidden = true;
  }

  function renderDetail() {
    const zone = getZones().find(item => item.id === selectedId) || getZones()[0];
    if (!zone) { view = 'welcome'; renderWelcome(); return; }
    selectedId = zone.id;
    const state = zoneState(zone);
    panel.append(element('h4', 'pz-title', zone.name), element('p', `pz-state pz-state-${state.kind}`, `${state.icon} ${state.text}`));
    const table = element('dl', 'pz-info');
    const add = (label, value, title = '') => {
      const valueElement = element('dd', '', value);
      if (title) valueElement.title = title;
      table.append(element('dt', '', label), valueElement);
    };
    add(t('Detail'), `${detailLabel(zone.max_zoom)} (${t('zoom {zoom}', { zoom: zone.max_zoom })})`);
    add(t('Tiles'), new Intl.NumberFormat(getLanguage()).format(zone.tile_count));
    add(t('Size on disk'), zone.size_bytes ? formatBytes(zone.size_bytes) : '-');
    add(t('Last update'), zone.updated_at ? formatRelativeDate(zone.updated_at) : '-', zone.updated_at ? new Date(zone.updated_at).toLocaleString(getLanguage()) : '');
    add(t('Source'), zone.source === 'import' ? t('Imported file') : 'OpenFreeMap');
    panel.append(table);
    // Zone privée ou simple carte hors ligne, modifiable à tout moment.
    const privacy = privacyCheckbox(zone.private, async checked => {
      try {
        await invoke('set_private_zone_privacy', { zoneId: zone.id, private: checked });
        await reloadZones();
        render();
      } catch (error) {
        host.showToast(errorMessage(error));
        render();
      }
    });
    panel.append(privacy);
    const actions = element('div', 'pz-actions');
    const update = button(zone.updated_at ? t('Update') : t('Download'), 'btn-primary', () => {
      enqueueDownload(zone);
      render();
    });
    update.disabled = zone.source === 'import' || downloading.has(zone.id) || !isMapNetworkAllowed();
    update.title = zone.source === 'import' ? t(ERROR_KEYS.imported_zone)
      : !isMapNetworkAllowed() ? t('Downloading needs the map enabled and offline mode off (Settings > General).')
      : t('Update help');
    const rename = button(t('Rename'), '', () => renameZone(zone));
    rename.disabled = downloading.has(zone.id);
    const remove = button(t('Delete'), 'btn-danger pz-delete', () => deleteZone(zone));
    remove.disabled = downloading.has(zone.id);
    actions.append(update, rename);
    // Zone importée : forme relue d'après les tuiles du fichier (utile pour une zone importée avant que la forme réelle soit lue).
    if (zone.source === 'import') {
      const reshape = button(t('Recompute the shape'), '', () => recomputeShape(zone));
      reshape.title = t('Recompute the shape help');
      actions.append(reshape);
    }
    actions.append(remove);
    panel.append(actions);
    mapElement.hidden = false;
    showZonesOnMap(zone);
  }

  // Création : avertissement, dessin sur la carte en ligne, nom, niveau de détail, estimation, téléchargement.
  function renderEditor() {
    panel.append(element('h4', 'pz-title', t('New private zone')));
    const online = isMapNetworkAllowed();
    panel.append(element('p', 'pz-warning', online ? t('Drawing privacy warning') : t('Drawing needs the map enabled and offline mode off (Settings > General). You can still import a file.')));

    const modeRow = element('div', 'pz-segmented');
    modeRow.setAttribute('role', 'radiogroup');
    modeRow.setAttribute('aria-label', t('Shape'));
    const hint = element('p', 'pz-text pz-muted');
    const setMode = mode => {
      draft.mode = mode;
      for (const option of modeRow.children) option.setAttribute('aria-checked', String(option.dataset.mode === mode));
      hint.textContent = mode === 'circle' ? t('Circle drawing help') : t('Polygon drawing help');
      drawing?.setMode(mode);
    };
    for (const [mode, label] of [['circle', t('Circle')], ['polygon', t('Polygon')]]) {
      const option = button(label, 'pz-segment', () => setMode(mode));
      option.dataset.mode = mode;
      option.setAttribute('role', 'radio');
      modeRow.append(option);
    }

    const nameInput = element('input', 'prompt-input');
    nameInput.type = 'text';
    nameInput.maxLength = 100;
    nameInput.placeholder = t('Zone name (e.g. Home)');
    nameInput.setAttribute('aria-label', t('Zone name'));
    nameInput.value = draft.name;
    const levelRow = element('div', 'pz-segmented');
    levelRow.setAttribute('role', 'radiogroup');
    levelRow.setAttribute('aria-label', t('Detail'));
    const estimateLine = element('p', 'pz-estimate');
    // Nom : chaque zone a son fichier, nommé d'après elle (minuscules, « _ » à la place des espaces) ; un doublon est signalé à la saisie.
    const nameProblem = element('p', 'prompt-error');
    const actions = element('div', 'pz-actions');
    const download = button(t('Download the zone'), 'btn-primary', () => createZone());
    actions.append(button(t('Cancel'), '', () => { leaveEditor(); render(); }), download);

    const nameError = () => (!draft.name.trim() ? '' : !zoneFileName(draft.name) ? t(ERROR_KEYS.invalid_zone_name)
      : isZoneNameTaken(draft.name) ? t(ERROR_KEYS.zone_name_taken) : '');
    const refreshButton = () => {
      const problem = nameError();
      nameProblem.textContent = problem;
      download.disabled = !online || !draft.geometry || !draft.name.trim() || !!problem || !draft.estimate?.within_limits;
    };
    let estimateToken = 0;
    const refreshEstimate = async () => {
      const token = ++estimateToken;
      if (!draft.geometry) {
        draft.estimate = null;
        estimateLine.textContent = t('Draw the zone on the map.');
        estimateLine.classList.remove('pz-over');
        refreshButton();
        return;
      }
      try {
        const estimate = await estimateZone(draft.geometry, draft.zoom);
        if (token !== estimateToken || !draft) return;
        draft.estimate = estimate;
        const tiles = new Intl.NumberFormat(getLanguage()).format(estimate.tiles);
        estimateLine.textContent = estimate.within_limits
          ? t('≈ {tiles} tiles, ≈ {size}', { tiles, size: formatBytes(estimate.bytes) })
          : t('Too large: ≈ {tiles} tiles, ≈ {size} (at most {max} tiles and 50 MB). Draw a smaller zone or choose less detail.', {
            tiles, size: formatBytes(estimate.bytes), max: new Intl.NumberFormat(getLanguage()).format(MAX_ZONE_TILES),
          });
        estimateLine.classList.toggle('pz-over', !estimate.within_limits);
      } catch (error) {
        draft.estimate = null;
        estimateLine.textContent = errorMessage(error);
      }
      refreshButton();
    };
    for (const level of DETAIL_LEVELS) {
      const option = button(`${t(level.labelKey)} (${level.zoom})`, 'pz-segment', () => {
        draft.zoom = level.zoom;
        for (const item of levelRow.children) item.setAttribute('aria-checked', String(Number(item.dataset.zoom) === level.zoom));
        refreshEstimate();
      });
      option.dataset.zoom = String(level.zoom);
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', String(level.zoom === draft.zoom));
      levelRow.append(option);
    }
    nameInput.addEventListener('input', () => { draft.name = nameInput.value; refreshButton(); });
    nameInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !download.disabled) createZone(); });

    panel.append(
      element('span', 'pz-label', t('Shape')), modeRow, hint,
      element('span', 'pz-label', t('Zone name')), nameInput, nameProblem,
      element('span', 'pz-label', t('Detail')), levelRow,
      privacyCheckbox(draft.private, checked => { draft.private = checked; }),
      estimateLine, actions,
    );
    mapElement.hidden = !online;
    if (online) {
      // Carte en ligne (pas de mode strict) : les zones existantes y restent locales (règle par tuile).
      mapView.show([], { strict: false });
      mapView.showZones(zonesFeatureCollection(getZones()));
      mapView.whenReady(map => {
        if (view !== 'new' || drawing) return;
        drawing = startZoneDrawing(map, {
          mode: draft.mode,
          onChange: geometry => {
            if (!draft) return;
            draft.geometry = geometry;
            refreshEstimate();
          },
        });
      });
    }
    setMode(draft.mode);
    refreshEstimate();
    nameInput.focus();
  }

  function startEditor() {
    leaveEditor();
    view = 'new';
    draft = { mode: 'circle', geometry: null, name: '', zoom: 14, private: true, estimate: null };
    render();
  }

  async function createZone() {
    if (!draft?.geometry) return;
    try {
      const zone = await invoke('add_private_zone', { name: draft.name, geometry: draft.geometry, maxZoom: draft.zoom, private: draft.private });
      leaveEditor();
      await reloadZones();
      selectedId = zone.id;
      view = 'detail';
      enqueueDownload(zone);
      render();
    } catch (error) {
      host.showToast(errorMessage(error));
    }
  }

  async function importZone() {
    const path = await open({ multiple: false, directory: false, title: t('Import a file…'), filters: [{ name: 'MBTiles', extensions: ['mbtiles'] }] });
    if (typeof path !== 'string' || !path) return;
    const suggested = path.split(/[\\/]/).pop().replace(/\.mbtiles$/i, '');
    await promptDialog({
      title: t('Import a file…'),
      message: t('Import help'),
      inputLabel: t('Zone name'),
      confirmLabel: t('Import'),
      cancelLabel: t('Cancel'),
      value: suggested,
      onSubmit: async name => {
        if (isZoneNameTaken(name)) return t(ERROR_KEYS.zone_name_taken);
        try {
          const zone = await invoke('import_private_zone', { path, name, geometry: null });
          leaveEditor();
          await reloadZones();
          selectedId = zone.id;
          view = 'detail';
          render();
          return null;
        } catch (error) {
          return errorMessage(error);
        }
      },
    });
  }

  async function renameZone(zone) {
    await promptDialog({
      title: t('Rename the zone'),
      message: t('New name of {name}', { name: zone.name }),
      inputLabel: t('Zone name'),
      confirmLabel: t('Rename'),
      cancelLabel: t('Cancel'),
      value: zone.name,
      onSubmit: async name => {
        if (isZoneNameTaken(name, zone.id)) return t(ERROR_KEYS.zone_name_taken);
        try {
          await invoke('rename_private_zone', { zoneId: zone.id, name });
          await reloadZones();
          render();
          return null;
        } catch (error) {
          return errorMessage(error);
        }
      },
    });
  }

  async function recomputeShape(zone) {
    try {
      await invoke('recompute_private_zone_shape', { zoneId: zone.id });
      await reloadZones();
      reloadAllMaps(); // tuiles redemandées selon la nouvelle forme
      render();
      host.showToast(t('The shape of the zone was recomputed'));
    } catch (error) {
      host.showToast(errorMessage(error));
    }
  }

  async function deleteZone(zone) {
    const confirmed = await confirmDialog({
      title: t('Delete the zone'),
      message: t('Delete zone help {name}', { name: zone.name }),
      confirmLabel: t('Delete'),
      cancelLabel: t('Cancel'),
      focusCancel: true,
    });
    if (!confirmed) return;
    try {
      await invoke('delete_private_zone', { zoneId: zone.id });
      await reloadZones();
      selectedId = getZones()[0]?.id ?? null;
      render();
    } catch (error) {
      host.showToast(errorMessage(error));
    }
  }

  function render() {
    panel.replaceChildren();
    // Création : la carte (outil de dessin) passe avant le formulaire.
    detailPane.classList.toggle('pz-editing', view === 'new');
    if (view === 'new') {
      if (!draft) draft = { mode: 'circle', geometry: null, name: '', zoom: 14, private: true, estimate: null };
      renderEditor();
    } else if (view === 'detail' && getZones().length) renderDetail();
    else { view = 'welcome'; renderWelcome(); }
    renderList();
  }

  refreshOpenModal = () => { if (view !== 'new') render(); else renderList(); };
  render();
}
