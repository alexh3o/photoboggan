// Settings > Storage > Import & OS media arrival detection (event-driven, zero polling at rest).
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { readBool, readChoice, readStored, writeStored } from './settings-defaults.js';
import { t, tp } from './i18n.js';
import { createModal, confirmDialog } from './photo-actions.js';

let host = {};
let detectedMedia = [];

function parseMarkers(raw) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export function getDetectedMedia() {
  return detectedMedia;
}

export async function refreshDetectedMedia() {
  try {
    detectedMedia = await invoke('list_detected_media');
    updateToolbarButton();
  } catch (error) {
    console.debug('Media detection unavailable:', error);
  }
  return detectedMedia;
}

export function syncImportToolbarButton() {
  const button = document.getElementById('btn-open-import');
  const badge = document.getElementById('import-detected-badge');
  if (!button || !badge) return;
  const autoDetect = readBool('importAutoDetect');
  const eligible = autoDetect ? detectedMedia.filter(d => d.eligible) : [];
  const open = Boolean(host.isImportOpen?.());
  button.classList.toggle('active', open);
  button.hidden = !open && eligible.length === 0;
  if (eligible.length === 0) {
    badge.hidden = true;
    badge.textContent = '';
    badge.classList.remove('is-dot');
  } else if (eligible.length === 1) {
    badge.hidden = false;
    badge.textContent = '';
    badge.classList.add('is-dot');
  } else {
    badge.hidden = false;
    badge.textContent = String(eligible.length);
    badge.classList.remove('is-dot');
  }
}

function updateToolbarButton() {
  syncImportToolbarButton();
}

export async function syncImportWatcherToBackend() {
  const enabled = readBool('importAutoDetect');
  const markers = parseMarkers(readStored('importMediaMarkers') ?? 'DCIM, PRIVATE/M4ROOT, MP_ROOT, AVCHD');
  const listMode = readChoice('importDeviceListMode', ['blacklist', 'whitelist']);
  const retention30d = readBool('importHistoryRetention30d');
  try {
    await invoke('set_import_watcher_config', { enabled, markers, listMode, retention30d });
  } catch (error) {
    console.debug('Import watcher config failed:', error);
  }
  if (enabled) await refreshDetectedMedia();
  else {
    detectedMedia = [];
    updateToolbarButton();
  }
}

function handleMediaArrival(arrived) {
  if (!arrived || !readBool('importAutoDetect')) return;
  const autoOpen = readBool('importAutoOpen');
  const canAutoOpen = autoOpen && !host.isBusyViewOpen?.();
  if (canAutoOpen) {
    host.openImport?.({ sourcePath: arrived.rootPath, mediaId: arrived.mediaId });
    return;
  }
  host.showToast?.(
    t('Photo media detected: {name}', { name: arrived.label }),
    [
      {
        label: t('Import'),
        onClick: () => host.openImport?.({ sourcePath: arrived.rootPath, mediaId: arrived.mediaId }),
      },
      {
        label: t("Don't suggest"),
        onClick: async () => {
          try {
            await invoke('set_import_device_policy', { mediaId: arrived.mediaId, policy: 'blacklist' });
            await refreshDetectedMedia();
          } catch (error) {
            console.error('Blacklist device failed:', error);
          }
        },
      },
    ],
    12000,
  );
}

async function openManageDevicesModal() {
  const modal = createModal({ title: t('Devices and import history'), cardClass: 'confirm-card' });
  const list = document.createElement('ul');
  list.className = 'import-devices-list';
  const empty = document.createElement('p');
  empty.className = 'import-note';
  empty.textContent = t('No remembered media yet.');

  const renderDevices = async () => {
    list.innerHTML = '';
    let devices = [];
    try {
      devices = await invoke('list_import_devices');
    } catch (error) {
      empty.textContent = String(error);
      empty.hidden = false;
      return;
    }
    empty.hidden = devices.length > 0;
    for (const dev of devices) {
      const li = document.createElement('li');
      li.className = 'import-device-row';

      const meta = document.createElement('div');
      meta.className = 'import-device-meta';
      const name = document.createElement('div');
      name.className = 'import-device-name';
      name.textContent = dev.lastLabel || dev.mediaId;
      const sub = document.createElement('div');
      sub.className = 'import-device-sub';
      const lastImport = dev.lastImportAt > 0
        ? new Date(dev.lastImportAt).toLocaleDateString()
        : t('Never imported');
      sub.textContent = `${dev.mediaId} · ${tp('{count} file', dev.historyCount)} · ${lastImport}`;
      meta.append(name, sub);

      const actions = document.createElement('div');
      actions.className = 'import-device-actions';
      const select = document.createElement('select');
      for (const [val, label] of [
        ['normal', t('Normal')],
        ['whitelist', t('Whitelist')],
        ['blacklist', t('Blacklist')],
      ]) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        opt.selected = dev.policy === val;
        select.append(opt);
      }
      select.addEventListener('change', async () => {
        await invoke('set_import_device_policy', { mediaId: dev.mediaId, policy: select.value });
        await refreshDetectedMedia();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = t('Delete');
      delBtn.addEventListener('click', async () => {
        await invoke('delete_import_device', { mediaId: dev.mediaId });
        await refreshDetectedMedia();
        await renderDevices();
      });

      actions.append(select, delBtn);
      li.append(meta, actions);
      list.append(li);
    }
  };

  const footer = document.createElement('div');
  footer.className = 'settings-button-row';
  const purge30Btn = document.createElement('button');
  purge30Btn.type = 'button';
  purge30Btn.textContent = t('Purge > 30 days');
  purge30Btn.addEventListener('click', async () => {
    const count = await invoke('purge_import_history', { mediaId: null, olderThanDays: 30 });
    host.showToast?.(tp('{count} history entry removed', count));
    await renderDevices();
  });

  const purgeAllBtn = document.createElement('button');
  purgeAllBtn.type = 'button';
  purgeAllBtn.className = 'btn-danger';
  purgeAllBtn.textContent = t('Clear all history');
  purgeAllBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: t('Clear all history'),
      message: t('Forget all previously imported files across every media?'),
      confirmLabel: t('Yes'),
      cancelLabel: t('No'),
    });
    if (!ok) return;
    const count = await invoke('purge_import_history', { mediaId: null, olderThanDays: null });
    host.showToast?.(tp('{count} history entry removed', count));
    await renderDevices();
  });

  footer.append(purge30Btn, purgeAllBtn);
  modal.body.append(empty, list, footer);
  await renderDevices();
}

export function initImportSettings(deps) {
  host = deps;

  const autoDetectEl = document.getElementById('import-auto-detect-toggle');
  const autoOpenEl = document.getElementById('import-auto-open-toggle');
  const markersEl = document.getElementById('import-media-markers-input');
  const listModeEl = document.getElementById('import-device-list-mode');
  const retentionEl = document.getElementById('import-retention-30d-toggle');
  const manageBtn = document.getElementById('btn-import-manage-devices');
  const openBtn = document.getElementById('btn-open-import');

  if (autoDetectEl) {
    autoDetectEl.checked = readBool('importAutoDetect');
    autoDetectEl.addEventListener('change', () => {
      writeStored('importAutoDetect', autoDetectEl.checked);
      if (autoOpenEl) autoOpenEl.disabled = !autoDetectEl.checked;
      syncImportWatcherToBackend();
    });
  }
  if (autoOpenEl) {
    autoOpenEl.checked = readBool('importAutoOpen');
    autoOpenEl.disabled = !readBool('importAutoDetect');
    autoOpenEl.addEventListener('change', () => writeStored('importAutoOpen', autoOpenEl.checked));
  }
  if (markersEl) {
    markersEl.value = readStored('importMediaMarkers') ?? 'DCIM, PRIVATE/M4ROOT, MP_ROOT, AVCHD';
    markersEl.addEventListener('change', () => {
      writeStored('importMediaMarkers', markersEl.value.trim());
      syncImportWatcherToBackend();
    });
  }
  if (listModeEl) {
    listModeEl.value = readChoice('importDeviceListMode', ['blacklist', 'whitelist']);
    listModeEl.addEventListener('change', () => {
      writeStored('importDeviceListMode', listModeEl.value);
      syncImportWatcherToBackend();
    });
  }
  if (retentionEl) {
    retentionEl.checked = readBool('importHistoryRetention30d');
    retentionEl.addEventListener('change', () => {
      writeStored('importHistoryRetention30d', retentionEl.checked);
      syncImportWatcherToBackend();
    });
  }
  manageBtn?.addEventListener('click', openManageDevicesModal);
  openBtn?.addEventListener('click', () => {
    if (host.isImportOpen?.()) {
      host.closeImport?.();
      return;
    }
    const first = detectedMedia.find(d => d.eligible);
    host.openImport?.(first ? { sourcePath: first.rootPath, mediaId: first.mediaId } : {});
  });

  listen('import-media-changed', event => {
    const payload = event.payload || {};
    if (Array.isArray(payload.devices)) {
      detectedMedia = payload.devices;
      updateToolbarButton();
    }
    if (payload.arrived) handleMediaArrival(payload.arrived);
  }).catch(error => console.debug('Media event listener failed:', error));

  syncImportWatcherToBackend();
}
