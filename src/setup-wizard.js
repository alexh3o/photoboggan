// First-launch setup wizard: guides new users through language, Internet access, optional features, and watched folders.
// Reuses existing settings handlers, model downloads, private zones modal, and folder management injected by main.js.

import './setup-wizard.css';
import { createModal } from './photo-actions.js';
import { LANGUAGES, getLanguage, setLanguage, onLanguageChange, t, formatMegabytes } from './i18n.js';
import { readStored, writeStored, isOffline } from './settings-defaults.js';
import { openPrivateZonesModal } from './private-zones-modal.js';
import { isCheckUpdatesEnabled, setCheckUpdatesEnabled } from './update-check.js';
import {
  setSemanticEnabled, downloadSemanticModel, getSemanticModelState, onSemanticModelStatusChange,
} from './semantic-settings.js';
import {
  setFaceDetectionEnabled, downloadFaceModels, getFaceModelState, refreshFaceModelStatus, onFaceModelStatusChange,
} from './faces-panel.js';
import { isShowMapEnabled, setShowMapEnabled } from './location-panel.js';

const WIZARD_DONE_KEY = 'setupWizardDone';
const STEP_COUNT = 4;

let host = {
  setOfflineMode: () => {},
  getFolders: () => [],
  addFolder: async () => {},
  removeFolder: async () => {},
};
let activeWizard = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createSvgIcon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
}

const createInfoIcon = () => createSvgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>');
const createWarningIcon = () => createSvgIcon('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>');

function cloneToolbarIcon(buttonId) {
  const source = document.querySelector(`#${buttonId} svg`);
  if (!source) return null;
  const icon = source.cloneNode(true);
  icon.setAttribute('width', '16');
  icon.setAttribute('height', '16');
  icon.setAttribute('aria-hidden', 'true');
  icon.classList.remove('preview-icon');
  icon.classList.add('wizard-inline-icon');
  return icon;
}

function markWizardDone() {
  writeStored(WIZARD_DONE_KEY, 'true');
}

/** Wires host services from main.js. */
export function initSetupWizard(hostApi) {
  host = { ...host, ...hostApi };
}

/** Opens the wizard on first launch when no watched folder exists and the wizard has not been completed/skipped yet. */
export function maybeOpenSetupWizard() {
  if (host.getFolders().length > 0) {
    // Existing users with tracked folders should not see the wizard even if they remove their last folder later.
    if (readStored(WIZARD_DONE_KEY) !== 'true') markWizardDone();
    return;
  }
  if (readStored(WIZARD_DONE_KEY) === 'true') return;
  openSetupWizard();
}

/** Refreshes the open wizard when watched folders change (Step 3 list or Step 4 intro). */
export function notifyWizardFoldersChanged() {
  activeWizard?.refreshFolders();
}

/** Opens the 4-step setup wizard modal. */
export function openSetupWizard() {
  if (activeWizard) return;

  let step = 0;
  let step2Controls = null;

  const modal = createModal({
    title: '',
    cardClass: 'wizard-card',
    focusSelector: 'button:not([disabled]), input:not([disabled]), select:not([disabled])',
    closeOnBackdrop: false,
    onClose: () => {
      markWizardDone();
      unsubLanguage();
      unsubSemantic();
      unsubFaces();
      activeWizard = null;
    },
  });

  const stepBadge = el('span', 'wizard-step-badge');
  modal.header.insertBefore(stepBadge, modal.header.lastElementChild);

  const footer = el('div', 'wizard-footer');
  const footerLeft = el('div', 'wizard-footer-left');
  const footerRight = el('div', 'wizard-footer-right');
  const dots = el('div', 'wizard-dots');
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < STEP_COUNT; i += 1) dots.append(el('span', 'wizard-dot'));
  footer.append(footerLeft, footerRight);
  modal.card.append(footer);

  function updateHeaderAndFooter() {
    stepBadge.textContent = `${step + 1} / ${STEP_COUNT}`;
    [...dots.children].forEach((dot, index) => dot.classList.toggle('active', index === step));

    footerLeft.replaceChildren();
    footerRight.replaceChildren();

    if (step === 0) {
      const skip = el('button', '', t('Skip'));
      skip.type = 'button';
      skip.addEventListener('click', () => modal.close());
      footerLeft.append(skip, dots);
    } else {
      footerLeft.append(dots);
      const prev = el('button', '', t('Previous'));
      prev.type = 'button';
      prev.addEventListener('click', () => {
        step -= 1;
        renderStep();
      });
      footerRight.append(prev);
    }

    if (step < STEP_COUNT - 1) {
      const next = el('button', 'btn-primary', t('Next'));
      next.type = 'button';
      next.addEventListener('click', () => {
        step += 1;
        renderStep();
      });
      footerRight.append(next);
    } else {
      const finish = el('button', 'btn-primary', t('Finish'));
      finish.type = 'button';
      finish.addEventListener('click', () => modal.close());
      footerRight.append(finish);
    }
  }

  function renderStep1() {
    modal.heading.textContent = t('Welcome to photoboggan');
    const intro = el(
      'p',
      'wizard-intro',
      t('photoboggan organizes and finds your photos right where they are on disk. It reads your folders and keeps a local index without copying or moving your files. Let us review the essential settings.'),
    );

    const langRow = el('label', 'settings-row');
    langRow.setAttribute('for', 'wizard-language-select');
    langRow.append(el('span', '', t('Language')));
    const langSelect = document.createElement('select');
    langSelect.id = 'wizard-language-select';
    langSelect.replaceChildren(...Object.entries(LANGUAGES).map(([code, { label }]) => new Option(label, code)));
    langSelect.value = getLanguage();
    langSelect.addEventListener('change', () => {
      setLanguage(langSelect.value);
    });
    langRow.append(langSelect);

    const internetBox = el('div', 'wizard-internet-box');
    const internetLabel = el('label', 'settings-row settings-check');
    const internetCheck = document.createElement('input');
    internetCheck.type = 'checkbox';
    internetCheck.checked = !isOffline();
    internetLabel.append(internetCheck, el('span', '', t('Internet access')));

    const internetHelp = el(
      'p',
      'wizard-internet-help',
      t('No data related to your photos is sent; Internet access is only used for the following features if you enable them:'),
    );
    const internetList = el('ul', 'wizard-list');
    for (const key of [
      'Update checks (GitHub)',
      'Automatic download of AI models for face detection/recognition and content analysis',
      'Online map display, offline/private map zone downloads (OpenFreeMap), place search (Nominatim)',
    ]) {
      internetList.append(el('li', '', t(key)));
    }

    const updatesLabel = el('label', 'settings-row settings-check settings-sub');
    const updatesCheck = document.createElement('input');
    updatesCheck.type = 'checkbox';
    updatesCheck.checked = isCheckUpdatesEnabled();
    updatesCheck.disabled = !internetCheck.checked;
    updatesCheck.addEventListener('change', () => {
      setCheckUpdatesEnabled(updatesCheck.checked);
    });
    updatesLabel.append(updatesCheck, el('span', '', t('Update checks (GitHub)')));

    internetCheck.addEventListener('change', () => {
      host.setOfflineMode(!internetCheck.checked);
      updatesCheck.disabled = !internetCheck.checked;
    });

    internetBox.append(internetLabel, internetHelp, internetList, updatesLabel);
    modal.body.replaceChildren(intro, langRow, internetBox);
  }

  function renderModelActionCell(actionCell, { enabled, status, downloading, offlineHintKey, onDownload, sizeField }) {
    actionCell.replaceChildren();
    if (isOffline()) {
      actionCell.append(el('span', '', t(offlineHintKey)));
      return;
    }
    if (status && status.supported === false) {
      actionCell.append(el('span', '', t('Not available on this system')));
      return;
    }
    if (enabled && status?.installed) {
      actionCell.append(el('span', 'wizard-status-ok', `✓ ${t('Installed')}`));
      return;
    }
    const label = downloading
      ? t('Downloading…')
      : enabled && status?.[sizeField]
        ? t('Download ({size})', { size: formatMegabytes(status[sizeField]) })
        : t('Download the model');
    const btn = el('button', enabled ? 'btn-highlight' : '', label);
    btn.type = 'button';
    btn.style.marginBottom = '0';
    btn.disabled = !enabled || downloading;
    btn.addEventListener('click', onDownload);
    actionCell.append(btn);
  }

  function refreshStep2Dynamic() {
    if (!step2Controls) return;
    const semantic = getSemanticModelState();
    const faces = getFaceModelState();
    const mapEnabled = isShowMapEnabled();

    step2Controls.semanticCheck.checked = semantic.enabled;
    step2Controls.semanticRow.classList.toggle('inactive', !semantic.enabled);
    renderModelActionCell(step2Controls.semanticAction, {
      enabled: semantic.enabled,
      status: semantic.status,
      downloading: semantic.downloading,
      offlineHintKey: 'Model to download (see Settings > Search > Content search)',
      onDownload: downloadSemanticModel,
      sizeField: 'missingSize',
    });

    step2Controls.facesCheck.checked = faces.enabled;
    step2Controls.facesRow.classList.toggle('inactive', !faces.enabled);
    renderModelActionCell(step2Controls.facesAction, {
      enabled: faces.enabled,
      status: faces.status,
      downloading: faces.downloading,
      offlineHintKey: 'Model to download (see Settings > Faces)',
      onDownload: downloadFaceModels,
      sizeField: 'missing_size',
    });

    step2Controls.mapCheck.checked = mapEnabled;
    step2Controls.mapRow.classList.toggle('inactive', !mapEnabled);
    step2Controls.zonesButton.disabled = !mapEnabled;

    step2Controls.aiCallout.hidden = !(semantic.enabled || faces.enabled);
    step2Controls.mapCallout.hidden = !mapEnabled;
  }

  function renderStep2() {
    modal.heading.textContent = t('Choose your features');
    const intro = el(
      'p',
      'wizard-intro',
      t('The following features need to be enabled. Choose the ones you need; you can change them later.'),
    );

    const features = el('div', 'wizard-features');

    const createFeatureRow = (titleKey, descKey) => {
      const row = el('div', 'wizard-feature-row');
      const main = el('div', 'wizard-feature-main');
      const label = el('label', 'settings-row settings-check');
      const check = document.createElement('input');
      check.type = 'checkbox';
      label.append(check, el('span', '', t(titleKey)));
      main.append(label, el('p', 'wizard-feature-desc', t(descKey)));
      const action = el('div', 'wizard-feature-action');
      row.append(main, action);
      return { row, check, action };
    };

    const semantic = createFeatureRow(
      'Content search',
      'Find photos by describing them ("beach", "dog"). Longer analysis.',
    );
    semantic.check.addEventListener('change', async () => {
      semantic.check.disabled = true;
      try {
        await setSemanticEnabled(semantic.check.checked);
      } finally {
        semantic.check.disabled = false;
        refreshStep2Dynamic();
      }
    });

    const faces = createFeatureRow(
      'People (face detection)',
      'Detects and groups faces to find photos of the same person.',
    );
    faces.check.addEventListener('change', () => {
      setFaceDetectionEnabled(faces.check.checked);
      refreshStep2Dynamic();
    });

    const map = createFeatureRow(
      'Places and map',
      'Geolocate photos to view them on a map.',
    );
    map.check.addEventListener('change', () => {
      setShowMapEnabled(map.check.checked, { offerWelcome: false });
      refreshStep2Dynamic();
    });
    const zonesButton = el('button', '', t('Offline / private zones…'));
    zonesButton.type = 'button';
    zonesButton.addEventListener('click', () => openPrivateZonesModal());
    map.action.append(el('span', '', t('Define or import')), zonesButton);

    features.append(semantic.row, faces.row, map.row);

    const notes = el('div', 'wizard-notes');
    const notesList = el('ul', 'wizard-list wizard-list-compact');
    notesList.append(
      el('li', '', t('Nothing is sent to the Internet for these features.')),
      el('li', '', t('Enable Internet access on the previous screen, even temporarily, to download models and maps automatically, or do it manually.')),
    );

    const aiCallout = el('div', 'wizard-callout wizard-callout-info');
    aiCallout.append(
      createInfoIcon(),
      el('span', '', t('Photos or folders must be scanned from the context menus (right-click a folder or photos), or for the whole library from Settings > Search > Content search.')),
    );

    const mapCallout = el('div', 'wizard-callout wizard-callout-warn');
    mapCallout.append(
      createWarningIcon(),
      el('span', '', t('It is recommended to define private zones—around your home in particular—to protect your privacy.')),
    );

    notes.append(notesList, aiCallout, mapCallout);

    step2Controls = {
      semanticRow: semantic.row,
      semanticCheck: semantic.check,
      semanticAction: semantic.action,
      facesRow: faces.row,
      facesCheck: faces.check,
      facesAction: faces.action,
      mapRow: map.row,
      mapCheck: map.check,
      zonesButton,
      aiCallout,
      mapCallout,
    };

    modal.body.replaceChildren(intro, features, notes);
    if (getFaceModelState().enabled && !getFaceModelState().status) refreshFaceModelStatus();
    refreshStep2Dynamic();
  }

  function renderStep3() {
    modal.heading.textContent = t('Where are your photos?');
    const intro = el('p', 'wizard-intro', t('Choose the folders to watch:'));
    const bullets = el('ul', 'wizard-list');
    for (const key of [
      'photoboggan scans them and adds photos and videos with their metadata. Subfolders are included.',
      'Your files stay in place, and nothing is modified without action from you.',
      'Scanning can take a while for large collections: you can close the app and it will resume on the next launch.',
      'Folders are then synchronized automatically.',
    ]) {
      bullets.append(el('li', '', t(key)));
    }

    const actions = el('div', 'wizard-folders-actions');
    const addButton = el('button', 'btn-highlight', t('Add folder…'));
    addButton.type = 'button';
    addButton.addEventListener('click', () => host.addFolder());
    actions.append(addButton);

    const folders = host.getFolders();
    const listContainer = el('div');
    if (folders.length === 0) {
      listContainer.append(
        el('p', 'wizard-folders-empty', t('No folder added yet. You can also add folders later in Settings > General.')),
      );
    } else {
      const list = el('ul', 'wizard-folders-list');
      for (const folder of folders) {
        const li = el('li', 'settings-folder-item');
        const pathSpan = el('span', 'settings-folder-path', folder.path);
        pathSpan.title = folder.path;
        const remove = el('button', 'btn-remove-folder', t('Remove'));
        remove.type = 'button';
        remove.addEventListener('click', () => host.removeFolder(folder));
        li.append(pathSpan, remove);
        list.append(li);
      }
      listContainer.append(list);
    }

    modal.body.replaceChildren(intro, bullets, actions, listContainer);
  }

  function renderStep4() {
    modal.heading.textContent = t('Everything is set');
    const hasFolders = host.getFolders().length > 0;
    const intro = el(
      'p',
      'wizard-intro',
      hasFolders
        ? t('We have only seen part of the settings; feel free to explore the rest in Settings while photoboggan scans your collection. Every setting shows an explanatory tooltip when you hover over it.')
        : t('We have only seen part of the settings; feel free to explore the rest in Settings, and add your photo folders in Settings > General. Every setting shows an explanatory tooltip when you hover over it.'),
    );

    const subtitle = el('h4', 'wizard-subtitle', t('To get started:'));
    const tips = el('ul', 'wizard-tips');

    const tipH = el('li');
    const kbdH = el('kbd', '', 'H');
    tipH.append(kbdH, document.createTextNode(` : ${t('shortcuts guide')}`));

    const tipT = el('li');
    const kbdT = el('kbd', '', 'T');
    tipT.append(kbdT, document.createTextNode(` : ${t('hide/show the toolbar')}`));

    const tipContext = el('li', '', t('Right-click a photo or folder: all actions'));

    const tipToolbar = el('li');
    tipToolbar.append(document.createTextNode(t('All application settings are accessible from the toolbar:')));
    const toolbarList = el('ul', 'wizard-toolbar-list');
    for (const [buttonId, labelKey] of [
      ['btn-open-settings', 'Settings'],
      ['btn-open-display', 'Display options'],
      ['btn-open-sort', 'Sort options'],
    ]) {
      const item = el('li', 'wizard-toolbar-item');
      const icon = cloneToolbarIcon(buttonId);
      if (icon) item.append(icon);
      item.append(el('span', '', t(labelKey)));
      toolbarList.append(item);
    }
    tipToolbar.append(toolbarList);

    tips.append(tipH, tipT, tipContext, tipToolbar);
    modal.body.replaceChildren(intro, subtitle, tips);
  }

  function renderStep() {
    step2Controls = null;
    updateHeaderAndFooter();
    if (step === 0) renderStep1();
    else if (step === 1) renderStep2();
    else if (step === 2) renderStep3();
    else renderStep4();
  }

  const unsubLanguage = onLanguageChange(() => {
    const langFocused = document.activeElement?.id === 'wizard-language-select';
    renderStep();
    if (langFocused) document.getElementById('wizard-language-select')?.focus();
  });
  const unsubSemantic = onSemanticModelStatusChange(() => {
    if (step === 1) refreshStep2Dynamic();
  });
  const unsubFaces = onFaceModelStatusChange(() => {
    if (step === 1) refreshStep2Dynamic();
  });

  activeWizard = {
    refreshFolders: () => {
      if (step === 2 || step === 3) renderStep();
    },
  };

  renderStep();
}
