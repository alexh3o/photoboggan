// Mises à jour : Paramètres > Général > Internet (« Vérifier les mises à jour », « Inclure les pré-versions »), ligne des versions, fenêtre
// « Mise à jour disponible » et ligne de la fenêtre À propos. La recherche elle-même est faite par le backend (update_check.rs, releases GitHub).
//
// Quand : au démarrage (au plus une fois par 24 h, sans bloquer l'interface), à l'activation de la case et à la demande (« Vérifier maintenant »).
// Jamais en mode hors ligne ni case décochée. Le résultat est mémorisé : les Paramètres et À propos l'affichent sans nouvelle requête.
// Téléchargement : tâche de la file (progression et arrêt dans « Actions en cours »), vérifié par SHA-256 par le backend, puis bouton « Installer et
// redémarrer » (Windows) ou « Ouvrir l'installeur » (Linux : .deb confié au gestionnaire de paquets). Sans installeur pour ce système : page GitHub.

import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { t, onLanguageChange } from './i18n.js';

const KEY_ENABLED = 'checkUpdates';
const KEY_PRERELEASES = 'includePrereleases';
const KEY_LAST_CHECK = 'lastUpdateCheck';
const KEY_INFO = 'updateInfo';
const KEY_IGNORED = 'ignoredUpdateVersion';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 3000; // laisse le temps à l'interface d'envoyer le réglage « hors ligne » au backend et de finir son premier affichage
const RELEASE_URL_PREFIX = 'https://github.com/alexh3o/photoboggan/'; // seule adresse ouverte depuis la réponse du réseau
const MAX_NOTES_LENGTH = 8000;

const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* réglage non mémorisé */ } };
const remove = key => { try { localStorage.removeItem(key); } catch { /* rien à retirer */ } };

const isOffline = () => read('offlineMode') === 'true';
// Désactivée par défaut : l'application ne contacte personne tant que l'utilisateur ne l'a pas demandé.
const isEnabled = () => read(KEY_ENABLED) !== 'false';
const includesPrereleases = () => read(KEY_PRERELEASES) === 'true';

function savedInfo() {
  try { return JSON.parse(read(KEY_INFO)); } catch { return null; }
}

let currentVersion = '';
let info = null; // dernier résultat connu (UpdateInfo de update_check.rs), ou null
let checking = false;
let lastError = false;
let showToast = () => {};
let enqueueTask = () => false;
let canQuit = async () => true;
let downloadState = 'idle'; // 'idle' | 'downloading' | 'ready' (installeur téléchargé et vérifié)
let downloadedVersion = '';

let toggle, preToggle, statusLine, checkButton, showButton, modal, aboutLine;

/** Active seulement si Internet est autorisé et la vérification demandée. */
const isActive = () => isEnabled() && !isOffline();

// Ligne d'état sous les cases : versions installée et distante, ou état de la vérification.
function statusText() {
  const installed = t('Installed version: {version}', { version: currentVersion });
  if (!isActive()) return installed;
  if (checking) return `${installed} · ${t('Checking…')}`;
  if (lastError) return `${installed} · ${t('Could not check for updates')}`;
  if (!info) return installed;
  const latest = `${installed} · ${t('Latest version: {latest}', { latest: info.latest })}`;
  return info.update_available ? `${latest} — ${t('Update available')}` : `${latest} — ${t('Up to date')}`;
}

function render() {
  const active = isActive();
  toggle.disabled = isOffline();
  preToggle.disabled = !active;
  checkButton.disabled = !active || checking;
  showButton.hidden = !(active && info?.update_available);
  statusLine.textContent = statusText();

  // Fenêtre À propos : dernière version connue, sans requête.
  if (active && info) {
    aboutLine.hidden = false;
    aboutLine.textContent = info.update_available
      ? t('New version available: {latest}', { latest: info.latest })
      : t('Latest version: {latest}', { latest: info.latest });
  } else {
    aboutLine.hidden = true;
  }
}

/** Appelé par main.js quand le mode hors ligne ou la langue change. */
export function onUpdateAccessChanged() {
  if (statusLine) render();
}

// Notes de version : Markdown de git-cliff réduit à des titres, listes et paragraphes, construits en texte (jamais de HTML injecté).
function plainText(markdown) {
  return markdown.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '');
}

function renderNotes(container, markdown) {
  container.replaceChildren();
  let list = null;
  for (const rawLine of markdown.slice(0, MAX_NOTES_LENGTH).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { list = null; continue; }
    const item = line.match(/^[-*+]\s+(.*)$/);
    if (item) {
      if (!list) { list = document.createElement('ul'); container.append(list); }
      const li = document.createElement('li');
      li.textContent = plainText(item[1]);
      list.append(li);
      continue;
    }
    list = null;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const element = document.createElement(heading ? 'h5' : 'p');
    element.textContent = plainText(heading ? heading[1] : line);
    container.append(element);
  }
  if (!container.childNodes.length) {
    const empty = document.createElement('p');
    empty.textContent = t('No release notes.');
    container.append(empty);
  }
}

function formatMegabytes(bytes) {
  const megabytes = bytes / 1e6;
  return t('{size} MB', { size: megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes) });
}

// Codes d'erreur du backend (update_check.rs) traduits ; les autres messages sont affichés tels quels.
function updateErrorMessage(error) {
  const text = String(error);
  if (text === 'internet_disabled') return t('Offline mode is on (Settings > General)');
  if (text === 'update_corrupted') return t('The downloaded file is corrupted');
  if (text === 'update_no_installer') return t('No installer is published for this system');
  if (text === 'update_not_downloaded') return t('The update has not been downloaded');
  return text;
}

// Bouton principal de la fenêtre : Télécharger, puis Installer ; absent quand la release n'a pas d'installeur pour ce système.
function renderDownloadButton() {
  const button = document.getElementById('btn-update-download');
  const asset = info?.asset;
  button.hidden = !asset;
  if (!asset) return;
  const ready = downloadState === 'ready' && downloadedVersion === info.latest;
  button.disabled = downloadState === 'downloading';
  button.textContent = downloadState === 'downloading' ? t('Downloading…')
    : ready ? t(asset.restarts ? 'Install and restart' : 'Open the installer')
    : t('Download ({size})', { size: formatMegabytes(asset.size) });
}

// ---- Fenêtre « Mise à jour disponible » ----
function openDialog() {
  if (!info?.update_available) return;
  document.getElementById('update-summary').textContent = t('Version {latest} is available (installed: {version}).', { latest: info.latest, version: currentVersion })
    + (info.prerelease ? ` ${t('Pre-release')}` : '');
  renderNotes(document.getElementById('update-notes'), info.notes || '');
  renderDownloadButton();
  modal.classList.remove('hidden');
  document.getElementById(info.asset ? 'btn-update-download' : 'btn-update-github').focus();
}

function closeDialog() {
  modal.classList.add('hidden');
}

function downloadUpdate() {
  if (!info?.update_available || !info.asset || downloadState === 'downloading') return;
  const version = info.latest;
  const queued = enqueueTask({
    kind: 'update',
    path: null,
    command: 'download_update',
    args: { version, includePrereleases: includesPrereleases() },
    labelKey: 'Update download',
    onResult: (_result, stopped, error) => {
      if (error) {
        downloadState = 'idle';
        if (String(error) === 'update_changed') {
          // Une version plus récente a été publiée entre-temps : on la cherche et on la présente.
          closeDialog();
          forgetResult();
          runCheck({ announce: 'dialog' });
        } else {
          showToast(t('Update download failed: {error}', { error: updateErrorMessage(error) }));
        }
      } else if (stopped) {
        downloadState = 'idle';
      } else {
        downloadState = 'ready';
        downloadedVersion = version;
        showToast(t('Update downloaded'));
      }
      renderDownloadButton();
    },
  });
  if (!queued) return;
  downloadState = 'downloading';
  renderDownloadButton();
}

async function installUpdate() {
  // Windows : l'installeur remplace l'application, qui se ferme : mêmes garde-fous qu'à la fermeture (mots-clés non écrits, album modifié).
  if (info?.asset?.restarts && !(await canQuit())) return;
  try {
    const exits = await invoke('install_update');
    if (!exits) showToast(t('Installer opened'));
  } catch (error) {
    console.error('Update install failed', error);
    if (String(error) === 'update_corrupted' || String(error) === 'update_not_downloaded') downloadState = 'idle';
    showToast(t('Could not install the update: {error}', { error: updateErrorMessage(error) }));
    renderDownloadButton();
  }
}

function onDownloadButton() {
  if (downloadState === 'ready' && downloadedVersion === info?.latest) installUpdate();
  else downloadUpdate();
}

async function openReleasePage() {
  if (!info?.url?.startsWith(RELEASE_URL_PREFIX)) return;
  try {
    await openUrl(info.url);
  } catch (error) {
    console.error('Could not open the release page', error);
  }
}

/**
 * Interroge le backend. `announce` : avertir si une version plus récente existe (toast, ou fenêtre pour une demande manuelle) ;
 * sans lui (activation de la case…) seule la ligne d'état est mise à jour.
 */
async function runCheck({ announce = null } = {}) {
  if (!isActive() || checking) return;
  checking = true;
  lastError = false;
  render();
  try {
    info = await invoke('check_for_update', { includePrereleases: includesPrereleases() });
    write(KEY_INFO, JSON.stringify(info));
    write(KEY_LAST_CHECK, String(Date.now()));
  } catch (error) {
    console.error('Update check failed', error);
    lastError = announce !== null; // au démarrage, un échec reste silencieux
  } finally {
    checking = false;
    render();
  }
  if (!info?.update_available || lastError) return;
  if (announce === 'dialog') {
    openDialog();
  } else if (announce === 'toast' && read(KEY_IGNORED) !== info.latest) {
    showToast(t('Version {latest} is available', { latest: info.latest }), { label: t('Details'), onClick: openDialog });
  }
}

/** Une nouvelle recherche est nécessaire (réglage modifié ou version installée changée) : oublie le résultat mémorisé. */
function forgetResult() {
  info = null;
  lastError = false;
  remove(KEY_INFO);
  remove(KEY_LAST_CHECK);
}

export async function initUpdateCheck({ showToast: toast, enqueueTask: enqueue, canQuit: quitAllowed }) {
  showToast = toast;
  enqueueTask = enqueue;
  canQuit = quitAllowed;
  toggle = document.getElementById('check-updates-toggle');
  preToggle = document.getElementById('include-prereleases-toggle');
  statusLine = document.getElementById('update-status');
  checkButton = document.getElementById('btn-check-updates');
  showButton = document.getElementById('btn-show-update');
  modal = document.getElementById('update-modal');
  aboutLine = document.getElementById('about-update');

  try { currentVersion = await getVersion(); } catch (error) { console.error('Version unavailable', error); }

  // Résultat mémorisé pour une autre version installée (l'application vient d'être mise à jour) : on repart de zéro.
  info = savedInfo();
  if (info && info.current !== currentVersion) forgetResult();

  toggle.checked = isEnabled();
  preToggle.checked = includesPrereleases();
  render();
  onLanguageChange(render); // textes construits en JavaScript : refaits dans la nouvelle langue

  toggle.addEventListener('change', () => {
    write(KEY_ENABLED, String(toggle.checked));
    if (toggle.checked) {
      forgetResult();
      runCheck();
    }
    render();
  });
  preToggle.addEventListener('change', () => {
    write(KEY_PRERELEASES, String(preToggle.checked));
    forgetResult(); // le choix de la version proposée dépend de ce réglage
    runCheck();
    render();
  });
  checkButton.addEventListener('click', () => runCheck({ announce: 'dialog' }));
  showButton.addEventListener('click', openDialog);

  document.getElementById('btn-update-download').addEventListener('click', onDownloadButton);
  document.getElementById('btn-update-github').addEventListener('click', openReleasePage);
  document.getElementById('btn-update-ignore').addEventListener('click', () => {
    if (info) write(KEY_IGNORED, info.latest);
    closeDialog();
  });
  document.getElementById('btn-update-close').addEventListener('click', closeDialog);
  document.getElementById('btn-close-update').addEventListener('click', closeDialog);
  // Échap ferme cette fenêtre seule (écouteur en phase de capture : les Paramètres, derrière, ne doivent pas se fermer avec elle).
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || modal.classList.contains('hidden')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeDialog();
  }, true);

  // Vérification au démarrage : au plus une fois par jour, en arrière-plan.
  if (isActive() && Date.now() - Number(read(KEY_LAST_CHECK) || 0) > CHECK_INTERVAL_MS) {
    setTimeout(() => runCheck({ announce: 'toast' }), STARTUP_DELAY_MS);
  }
}
