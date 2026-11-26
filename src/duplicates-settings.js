// Settings > Search > Duplicates: hash coverage stats, precomputation launch (exact, similarity, or both),
// worker speed, synergies (content analysis, integrity check), background auto-hashing, and deletion.
import { invoke } from '@tauri-apps/api/core';
import { t, tp, onLanguageChange, formatMegabytes } from './i18n.js';
import { readBool, readChoice, writeStored } from './settings-defaults.js';
import { confirmDialog } from './photo-actions.js';
import { choiceDialog, showFailureDetails } from './metadata-writes.js';
import { notifyPhashChanged } from './duplicates-view.js';

const byId = id => document.getElementById(id);

let host = null;
let initialised = false;
let lastStats = null;
let statsToken = 0;

const exactHashListeners = new Set();

export function onExactHashChanged(listener) {
  exactHashListeners.add(listener);
  return () => exactHashListeners.delete(listener);
}

export function notifyExactHashChanged() {
  for (const listener of exactHashListeners) {
    try { listener(); } catch (error) { console.error('Exact hash listener failed', error); }
  }
}

export function duplicateHashThreads() {
  return readChoice('duplicateHashThreads', ['auto', '1', '2', '4']);
}

export function isHashOnSemanticEnabled() {
  return readBool('duplicateHashOnSemantic');
}

const PRECOMPUTE_LABELS = {
  exact_prepass: 'Exact hashes: whole library',
  exact_full: 'Exact hashes: whole library',
  similarity: 'Similarity hashes: whole library',
  both_prepass: 'Exact and similarity hashes: whole library',
  both_full: 'Exact and similarity hashes: whole library',
};

function missingCountsFor(stats, kind) {
  const pair = (s) => ({
    total: Math.max(0, s.total - s.upToDate - s.failed),
    nonRaw: Math.max(0, s.nonRawTotal - s.nonRawUpToDate - s.failed),
  });
  if (kind === 'exact_prepass') return pair(stats.exactPrepass);
  if (kind === 'exact_full') return pair(stats.exactFull);
  if (kind === 'similarity') return pair(stats.similarity);
  const exact = kind === 'both_full' ? pair(stats.exactFull) : pair(stats.exactPrepass);
  const sim = pair(stats.similarity);
  return {
    total: Math.max(exact.total, sim.total),
    nonRaw: Math.max(exact.nonRaw, sim.nonRaw),
  };
}

export async function refreshDuplicateHashStats() {
  if (!initialised) return null;
  const token = ++statsToken;
  try {
    const stats = await invoke('get_duplicate_hash_stats');
    if (token !== statsToken) return null;
    lastStats = stats;
  } catch (error) {
    console.error('Duplicate hash stats unreadable', error);
    lastStats = null;
  }
  renderStats();
  return lastStats;
}

function renderStats() {
  const prepassEl = byId('dup-stats-exact-prepass');
  const fullEl = byId('dup-stats-exact-full');
  const simEl = byId('dup-stats-similarity');
  const storageEl = byId('dup-stats-storage');
  if (!prepassEl || !fullEl || !simEl || !storageEl) return;
  if (!lastStats) {
    prepassEl.textContent = '';
    fullEl.textContent = '';
    simEl.textContent = '';
    storageEl.textContent = '';
    return;
  }
  const formatLine = (labelKey, s) => {
    const base = t('{label}: {done} of {total} up to date', {
      label: t(labelKey),
      done: s.upToDate.toLocaleString(),
      total: s.total.toLocaleString(),
    });
    return s.expired > 0 ? `${base} · ${t('{count} expired', { count: s.expired.toLocaleString() })}` : base;
  };
  prepassEl.textContent = formatLine('Exact hashes (pre-pass)', lastStats.exactPrepass);
  fullEl.textContent = formatLine('Exact hashes (full pass)', lastStats.exactFull);
  simEl.textContent = formatLine('Similarity hashes', lastStats.similarity);
  storageEl.textContent = t('Space used by duplicate hashes: {size}', { size: formatMegabytes(lastStats.bytes) });
  const hasAny = lastStats.bytes > 0
    || lastStats.exactPrepass.upToDate > 0 || lastStats.exactPrepass.expired > 0 || lastStats.exactPrepass.failed > 0
    || lastStats.similarity.upToDate > 0 || lastStats.similarity.expired > 0 || lastStats.similarity.failed > 0;
  byId('btn-dup-delete-data').disabled = !hasAny;
}

function handlePrecomputeResult(report, stopped, error, task, { silentIfEmpty = false } = {}) {
  notifyPhashChanged();
  notifyExactHashChanged();
  refreshDuplicateHashStats();
  if (error) {
    host?.showToast(t('Hash computation failed: {error}', { error }));
    return;
  }
  if (!report || report.cancelled || stopped) return;
  const failures = report.failures ?? [];
  if (failures.length > 0) {
    const totalFailures = report.failuresTotal || failures.length;
    host?.keepTaskReady?.(task, {
      readyText: tp('{count} unreadable file', totalFailures),
      showLabel: t('Show errors'),
      onShow: () => showFailureDetails({
        title: t('Unreadable files'),
        failures,
        logPath: report.logPath ?? null,
      }),
    });
  }
  if (silentIfEmpty && report.computed === 0 && failures.length === 0) return;
  const parts = [tp('{count} photo hashed', report.computed)];
  if (report.upToDate > 0) parts.push(t('{count} already up to date', { count: report.upToDate }));
  if (failures.length > 0) parts.push(tp('{count} unreadable photo', report.failuresTotal || failures.length));
  host?.showToast(parts.join(' · '));
}

async function launchPrecompute(kind) {
  const stats = await refreshDuplicateHashStats();
  if (!stats) return;
  const missing = missingCountsFor(stats, kind);
  if (missing.total === 0) {
    host?.showToast(t('All photos already have up-to-date hashes'));
    return;
  }
  const rawCount = Math.max(0, missing.total - missing.nonRaw);
  const buttons = [{ label: t('Cancel'), value: 'cancel', cancel: true }];
  if (missing.nonRaw > 0 && rawCount > 0) {
    buttons.push({
      label: t('Without RAW ({count})', { count: missing.nonRaw.toLocaleString() }),
      value: 'non_raw',
    });
  }
  buttons.push({
    label: rawCount > 0
      ? t('Include RAW ({count})', { count: missing.total.toLocaleString() })
      : t('Compute ({count})', { count: missing.total.toLocaleString() }),
    value: 'all',
    primary: true,
  });

  const message = rawCount > 0
    ? tp('Duplicate precompute dialog message with raw', missing.total, {
        count: missing.total.toLocaleString(),
        raw: rawCount.toLocaleString(),
      })
    : tp('Duplicate precompute dialog message', missing.total, {
        count: missing.total.toLocaleString(),
      });

  const choice = await choiceDialog({
    title: t('Compute duplicate hashes'),
    message,
    buttons,
  });
  if (choice === 'cancel') return;

  const includeRaw = choice === 'all';
  host?.enqueueTask({
    kind: 'hash-precompute',
    path: null,
    command: 'precompute_hashes',
    args: {
      kind,
      includeRaw,
      scope: null,
      threads: duplicateHashThreads(),
    },
    labelKey: PRECOMPUTE_LABELS[kind] ?? 'Duplicate hashes: whole library',
    dedupeKey: 'hash-precompute:library',
    onResult: (report, stopped, error, task) => handlePrecomputeResult(report, stopped, error, task),
  });
}

async function deleteDuplicateHashes() {
  const confirmed = await confirmDialog({
    title: t('Delete duplicate hashes'),
    message: t('Delete all cached duplicate hashes (exact and similarity)? Photos and their metadata are not touched. They will be recomputed on the next search.'),
    confirmLabel: t('Delete'),
    cancelLabel: t('Cancel'),
  });
  if (!confirmed) return;
  try {
    host?.stopHashPrecomputeTasks?.();
    await invoke('delete_duplicate_hashes');
  } catch (error) {
    host?.showToast(String(error));
    return;
  }
  await refreshDuplicateHashStats();
  notifyPhashChanged();
  notifyExactHashChanged();
  host?.showToast(t('Duplicate hashes deleted'));
}

export function scheduleAutoHash(scope) {
  if (!initialised || !readBool('duplicateAutoHash')) return false;
  if (scope?.kind === 'paths' && (!scope.paths || scope.paths.length === 0)) return false;
  const kind = readChoice('duplicateAutoHashMode', ['similarity', 'exact_prepass', 'exact_full', 'both_prepass', 'both_full']);
  const includeRaw = readBool('duplicateAutoHashRaw');
  const labelKey = scope?.kind === 'folder'
    ? 'Auto-computing hashes: {folder}'
    : scope?.kind === 'paths'
      ? 'Auto-computing hashes ({count} photos)'
      : 'Auto-computing hashes';
  const baseName = scope?.kind === 'folder' ? scope.path.split(/[\\/]/).filter(Boolean).pop() || scope.path : '';
  const labelParams = scope?.kind === 'folder'
    ? { folder: baseName }
    : scope?.kind === 'paths'
      ? { count: scope.paths.length }
      : undefined;
  return host?.enqueueTask({
    kind: 'hash-precompute',
    path: scope?.kind === 'folder' ? scope.path : null,
    command: 'precompute_hashes',
    args: { kind, includeRaw, scope, threads: duplicateHashThreads() },
    labelKey,
    labelParams,
    onResult: (report, stopped, error, task) => handlePrecomputeResult(report, stopped, error, task, { silentIfEmpty: true }),
  });
}

function bindCheckbox(id, key) {
  const input = byId(id);
  if (!input) return;
  input.checked = readBool(key);
  input.addEventListener('change', () => writeStored(key, input.checked));
}

function syncAutoHashAvailability() {
  const active = byId('dup-auto-hash')?.checked === true;
  const mode = byId('dup-auto-hash-mode');
  const raw = byId('dup-auto-hash-raw');
  if (mode) mode.disabled = !active;
  if (raw) raw.disabled = !active;
}

export function initDuplicatesSettings(hostApi) {
  host = hostApi;
  if (!byId('duplicates-settings')) return;

  const exactMode = byId('dup-precompute-exact-mode');
  exactMode.value = readChoice('duplicatePrecomputeExactMode', ['prepass', 'full']);
  exactMode.addEventListener('change', () => writeStored('duplicatePrecomputeExactMode', exactMode.value));

  const threads = byId('dup-hash-threads');
  threads.value = duplicateHashThreads();
  threads.addEventListener('change', () => writeStored('duplicateHashThreads', threads.value));

  bindCheckbox('dup-hash-on-semantic', 'duplicateHashOnSemantic');
  bindCheckbox('dup-hash-on-integrity', 'duplicateHashOnIntegrity');
  bindCheckbox('dup-auto-hash', 'duplicateAutoHash');
  bindCheckbox('dup-auto-hash-raw', 'duplicateAutoHashRaw');

  const autoMode = byId('dup-auto-hash-mode');
  autoMode.value = readChoice('duplicateAutoHashMode', ['similarity', 'exact_prepass', 'exact_full', 'both_prepass', 'both_full']);
  autoMode.addEventListener('change', () => writeStored('duplicateAutoHashMode', autoMode.value));

  byId('dup-auto-hash').addEventListener('change', syncAutoHashAvailability);
  syncAutoHashAvailability();

  byId('btn-dup-compute-exact').addEventListener('click', () => launchPrecompute(exactMode.value === 'full' ? 'exact_full' : 'exact_prepass'));
  byId('btn-dup-compute-similar').addEventListener('click', () => launchPrecompute('similarity'));
  byId('btn-dup-compute-both').addEventListener('click', () => launchPrecompute(exactMode.value === 'full' ? 'both_full' : 'both_prepass'));
  byId('btn-dup-delete-data').addEventListener('click', deleteDuplicateHashes);

  document.querySelector('.settings-tab-btn[data-tab="semantic"]')?.addEventListener('click', refreshDuplicateHashStats);
  onLanguageChange(renderStats);
  initialised = true;
  refreshDuplicateHashStats();
}
