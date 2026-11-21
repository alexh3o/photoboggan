// Frontend task queue: sequential main lane (scans, integrity checks, file moves/copies/resizes/renames, keyword batches,
// model downloads, duplicate searches, updates, private maps) plus a parallel lane for content analysis (`semantic`).
// Keeps track of toasts, the "Running tasks" modal, pause/resume persistence (`pausedScanTasks`), close/reload guards,
// and backend `scan-progress` / `scan-detail` events. `main.js` wires host callbacks via `initTaskQueue()`.
import { invoke } from '@tauri-apps/api/core';
import { listen as listenToBackend } from '@tauri-apps/api/event';
import { DEFAULTS, readStored } from './settings-defaults.js';
import { t, tp, onLanguageChange } from './i18n.js';
import { choiceDialog } from './metadata-writes.js';

// Task shape in `scanTasks`:
// { id, kind, path (null = whole collection), command, args, labelKey, labelParams,
//   status: 'waiting' | 'running' | 'paused' | 'ready', percent, stopRequested, toastHidden,
//   firstStartedAt (resumable scans: start of their first run), pauseRequested, onResult, runner, dedupeKey, ... }
let host = {};
let initialized = false;
const scanTasks = [];
let scanTaskCounter = 0;
let scanPumpActive = false;
let semanticPumpActive = false;
let transientToast = null; // single toast for short non-queue operations (moving data/cache, clearing thumbnails): showTaskToast / hideTaskToast
let tasksClockTimer = null;

let taskToastsContainer = null;
let tasksButton = null;
let tasksModal = null;
let tasksList = null;
const taskToastElements = new Map(); // task -> toast element
const taskRowElements = new Map(); // task -> row element in the tasks modal

export const folderBaseName = path => path.split(/[\\/]/).filter(Boolean).pop() || path;
const normalizeTaskPath = path => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const taskName = task => task.displayName ?? t(task.labelKey, task.labelParams);
const taskPercent = task => Math.max(0, Math.min(100, Math.round(task.percent)));

// A 'ready' task has finished and only waits for the user to show its results: it stays in the list (and warns before quitting) but is not work in
// progress, so it never holds back the queue, the library synchronisation or the reload shortcut.
const activeTaskCount = () => scanTasks.filter(task => task.status !== 'ready' && task.status !== 'paused').length;

// Content analysis: its own lane, in parallel with the main queue (see pumpSemanticQueue). It counts in activeTaskCount (closing the application,
// reloading the page) but not in foregroundTaskCount: a library synchronisation never waits for it (the analysis pauses itself instead).
const isSemanticLaneTask = task => task.kind === 'semantic';
export const foregroundTaskCount = () => scanTasks.filter(task => task.status !== 'ready' && task.status !== 'paused' && !isSemanticLaneTask(task)).length;

// Scans that can be paused: the scan stops (photos already read stay in the catalogue), the task stays in the list without holding back the queue,
// and resuming puts it first in line; the backend then skips the files read since its first start (`resumeSince`, see run_scan).
// Unfinished ones are remembered (`pausedScanTasks`) and come back paused at the next launch.
const RESUMABLE_TASK_KINDS = ['add', 'rescan-all', 'rescan-folder'];
const isResumableTask = task => RESUMABLE_TASK_KINDS.includes(task.kind);

// File tasks (move, copy, resize, batch rename): 'files' family, queued sequentially without ever being refused as duplicates.
const FILE_TASK_KINDS = ['move', 'copy', 'resize', 'rename'];
export const hasFileTask = () => scanTasks.some(task => FILE_TASK_KINDS.includes(task.kind) && task.status !== 'ready'); // a finished task kept in the list only shows its errors
// Photos that a move or a batch rename of the queue is going to change the path of: metadata is not written to them meanwhile (see writeMarking).
export const queuedPathsBeingChanged = () => new Set(scanTasks.filter(task => task.status !== 'ready').flatMap(task => (task.kind === 'move' ? task.args?.paths ?? [] : task.kind === 'rename' ? (task.args?.items ?? []).map(item => item.path) : [])));

function taskStatusText(task) {
  if (task.status === 'ready') return task.readyText ?? tp('Results ready: {count} group', task.groupCount);
  if (task.status === 'waiting') return t('Waiting');
  if (task.status === 'paused') return `${taskPercent(task)} % · ${t('Paused')}`;
  if (task.pauseRequested) return t('Pausing…');
  if (task.stopRequested) return t('Stopping…');
  if (isSemanticLaneTask(task)) {
    // Paused while another task works; otherwise the progress and the time left estimated by the backend.
    if (task.paused) return `${taskPercent(task)} % · ${t('Paused (other task running)')}`;
    const parts = [`${taskPercent(task)} %`];
    if (task.total > 0) parts.push(`${task.done.toLocaleString()} / ${task.total.toLocaleString()}`);
    if (task.remainingSeconds != null) parts.push(t('{time} left', { time: `~${formatTaskDuration(task.remainingSeconds * 1000)}` }));
    return parts.join(' · ');
  }
  return `${taskPercent(task)} %`;
}

// Human-readable duration: "45 s", "3 min 05 s", "1 h 02 min".
function formatTaskDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  // Beyond 5 minutes, seconds add noise and make the display flicker: round to minutes.
  if (total >= 300) {
    const roundedMinutes = Math.round(total / 60);
    const h = Math.floor(roundedMinutes / 60);
    return h > 0 ? `${h} h ${String(roundedMinutes % 60).padStart(2, '0')} min` : `${roundedMinutes} min`;
  }
  if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
  return `${seconds} s`;
}

// Elapsed time and estimated time remaining for a running task (linear extrapolation from progress;
// waits a few seconds and 3% progress to avoid absurd initial estimates).
function taskTimingText(task) {
  if (task.status !== 'running' || !task.startedAt) return '';
  const elapsed = Date.now() - task.startedAt;
  const parts = [formatTaskDuration(elapsed)];
  const percent = taskPercent(task);
  // The content analysis gives its own estimate (taskStatusText): an extrapolation from the elapsed time would count the pauses.
  if (!isSemanticLaneTask(task) && !task.stopRequested && percent >= 3 && percent < 100 && elapsed >= 4000) {
    parts.push(t('{time} left', { time: `~${formatTaskDuration(elapsed * (100 - percent) / percent)}` }));
  }
  return parts.join(' · ');
}

// A task covers a folder when it targets that folder, a parent folder, or the whole collection (path === null).
function taskCoversFolder(task, path) {
  if (task.path === null) return true;
  const root = normalizeTaskPath(task.path);
  const folder = normalizeTaskPath(path);
  return folder === root || folder.startsWith(`${root}/`);
}

// Reorders DOM elements in place without detaching nodes already in place (detaching a button during a click drops the click).
function syncChildren(container, wanted) {
  for (const child of [...container.children]) if (!wanted.includes(child)) child.remove();
  wanted.forEach((element, position) => {
    if (container.children[position] !== element) container.insertBefore(element, container.children[position] || null);
  });
}

function buildTaskToast(task) {
  const toast = document.createElement('div');
  toast.className = 'task-toast';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.className = 'task-toast-text';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'task-toast-close';
  close.textContent = '×';
  close.addEventListener('click', () => {
    task.toastHidden = true; // hides the toast while the task keeps running (still visible in the tasks modal)
    syncTaskUI();
  });
  // Ready task (e.g. finished duplicate search): "Show" opens the results (visible only while status === 'ready').
  const show = document.createElement('button');
  show.type = 'button';
  show.className = 'task-toast-show';
  show.hidden = true;
  show.addEventListener('click', () => showReadyTask(task));
  toast.append(text, show, close);
  return toast;
}

function buildTaskRow(task) {
  const row = document.createElement('li');
  row.className = 'task-item';
  const name = document.createElement('span');
  name.className = 'task-item-name';
  // Progress bar, then status (left) / elapsed+ETA (right), then (integrity check) the folder currently analysed.
  const bar = document.createElement('div');
  bar.className = 'task-item-bar';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.append(document.createElement('span'));
  const status = document.createElement('span');
  status.className = 'task-item-status';
  const time = document.createElement('span');
  time.className = 'task-item-time';
  time.setAttribute('aria-hidden', 'true'); // live timer: avoid re-reading every second by screen readers
  const detail = document.createElement('span');
  detail.className = 'task-item-detail';
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'task-item-action';
  action.addEventListener('click', () => (task.status === 'ready' ? showReadyTask(task) : removeOrStopTask(task)));
  // Finished task with results waiting to be shown: "Show" (main action) or "Dismiss" (this button).
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'task-item-dismiss';
  dismiss.addEventListener('click', () => removeReadyTask(task));
  // Resumable scan: "Pause" (running or waiting) / "Resume" (paused).
  const pause = document.createElement('button');
  pause.type = 'button';
  pause.className = 'task-item-pause';
  pause.addEventListener('click', () => (task.status === 'paused' ? resumeTask(task) : pauseTask(task)));
  const actions = document.createElement('div');
  actions.className = 'task-item-actions';
  actions.append(pause, action, dismiss);
  row.append(name, bar, status, time, detail, actions);
  return row;
}

// Reconciles the task toasts, the tasks modal rows, and the toolbar hourglass button/badge with `scanTasks`.
function syncTaskUI() {
  if (!initialized) return;
  const toastTasks = [...scanTasks, ...(transientToast ? [transientToast] : [])].filter(task => !task.toastHidden);
  const toasts = toastTasks.map(task => {
    let toast = taskToastElements.get(task);
    if (!toast) {
      toast = buildTaskToast(task);
      taskToastElements.set(task, toast);
    }
    toast.classList.toggle('waiting', task.status === 'waiting' || task.status === 'paused');
    const textElement = toast.querySelector('.task-toast-text');
    textElement.textContent = `${taskName(task)} · ${taskStatusText(task)}`;
    const showButton = toast.querySelector('.task-toast-show');
    showButton.hidden = task.status !== 'ready';
    showButton.textContent = task.showLabel ?? t('Show');
    // Current folder being checked (integrity scan), shown on a second line.
    if (task.detail && task.status === 'running') {
      const detail = document.createElement('span');
      detail.className = 'task-toast-detail';
      detail.textContent = task.detail;
      detail.title = task.detail;
      textElement.append(detail);
    }
    const close = toast.querySelector('.task-toast-close');
    close.title = t('Close');
    close.setAttribute('aria-label', t('Close'));
    return toast;
  });
  for (const [task, toast] of taskToastElements) {
    if (!toastTasks.includes(task)) {
      toast.remove();
      taskToastElements.delete(task);
    }
  }
  syncChildren(taskToastsContainer, toasts);

  const rows = scanTasks.map(task => {
    let row = taskRowElements.get(task);
    if (!row) {
      row = buildTaskRow(task);
      taskRowElements.set(task, row);
    }
    row.classList.toggle('waiting', task.status === 'waiting' || task.status === 'paused');
    const name = row.querySelector('.task-item-name');
    name.textContent = taskName(task);
    name.title = taskName(task);
    row.querySelector('.task-item-status').textContent = taskStatusText(task);
    row.querySelector('.task-item-time').textContent = taskTimingText(task);
    const detailElement = row.querySelector('.task-item-detail');
    const detailText = task.detail && task.status === 'running' ? task.detail : '';
    detailElement.textContent = detailText;
    detailElement.title = detailText;
    detailElement.hidden = !detailText;
    const bar = row.querySelector('.task-item-bar');
    bar.setAttribute('aria-valuenow', String(task.status === 'waiting' ? 0 : taskPercent(task)));
    bar.querySelector('span').style.width = `${task.status === 'waiting' ? 0 : taskPercent(task)}%`;
    row.classList.toggle('ready', task.status === 'ready');
    const action = row.querySelector('.task-item-action');
    action.textContent = task.status === 'ready' ? task.showLabel ?? t('Show') : task.status === 'waiting' || task.status === 'paused' ? t('Remove from queue') : t('Stop');
    action.disabled = task.stopRequested;
    const pause = row.querySelector('.task-item-pause');
    pause.hidden = !isResumableTask(task) || !['waiting', 'running', 'paused'].includes(task.status);
    pause.textContent = task.status === 'paused' ? t('Resume') : t('Pause');
    pause.disabled = task.stopRequested;
    const dismiss = row.querySelector('.task-item-dismiss');
    dismiss.hidden = task.status !== 'ready';
    dismiss.textContent = t('Dismiss');
    return row;
  });
  for (const [task, row] of taskRowElements) {
    if (!scanTasks.includes(task)) {
      row.remove();
      taskRowElements.delete(task);
    }
  }
  syncChildren(tasksList, rows);

  const label = `${t('Running tasks')} (${scanTasks.length})`;
  tasksButton.hidden = scanTasks.length === 0;
  // Badge with the number of running + waiting tasks (created on first use).
  let badge = tasksButton.querySelector('.tasks-count-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'tasks-count-badge';
    badge.setAttribute('aria-hidden', 'true'); // the count is already in the button's aria-label
    tasksButton.append(badge);
  }
  badge.textContent = scanTasks.length > 99 ? '99+' : String(scanTasks.length);
  tasksButton.title = label;
  tasksButton.setAttribute('aria-label', label);
}

// Toast for a short non-queue operation (moving data/cache, clearing thumbnail cache): single toast at a time with its percentage.
export function showTaskToast(name, percent) {
  if (transientToast) {
    transientToast.displayName = name;
    transientToast.percent = percent;
  } else {
    transientToast = { displayName: name, percent, status: 'running', stopRequested: false, toastHidden: false };
  }
  syncTaskUI();
}

export function hideTaskToast() {
  transientToast = null;
  syncTaskUI();
}

function openTasksModal() {
  // The modal lists every queued task, so their toasts would only duplicate it: close them (the transient toast is not in the modal and stays).
  for (const task of scanTasks) task.toastHidden = true;
  syncTaskUI();
  tasksModal.classList.remove('hidden');
  clearInterval(tasksClockTimer);
  // While open, refresh once per second so the elapsed-time timers advance.
  tasksClockTimer = setInterval(syncTaskUI, 1000);
}

export function closeTasksModal() {
  if (!tasksModal) return;
  tasksModal.classList.add('hidden');
  clearInterval(tasksClockTimer);
  tasksClockTimer = null;
}

// Close guard: if queue tasks are running, waiting, or have unshown results, warn before interrupting or discarding them.
// Returns true when quitting is allowed; "Show tasks" and "Cancel" keep the app open ("Show tasks" opens the tasks modal).
export async function confirmCloseWithRunningTasks() {
  // Paused scans are remembered and come back at the next launch: nothing to warn about.
  const pending = scanTasks.filter(task => task.status !== 'paused');
  if (pending.length === 0) return true;
  const active = activeTaskCount();
  // Interrupted scans are remembered too (saveResumableTasks): they come back paused.
  const resumableNote = pending.some(isResumableTask) ? ` ${t('Interrupted scans are kept paused and can be resumed at the next launch.')}` : '';
  const choice = await choiceDialog({
    title: t('Tasks in progress'),
    // Only finished searches left: nothing is interrupted, but their results are lost.
    message: active > 0
      ? `${tp('{count} task is running. Quitting now interrupts it.', active, { count: active })}${resumableNote}`
      : tp('{count} search result has not been shown yet. Quitting now discards it.', pending.length, { count: pending.length }),
    buttons: [
      { label: t('Quit anyway'), value: 'quit', tone: 'red' },
      { label: t('Show tasks'), value: 'show', primary: true },
      { label: t('Cancel'), value: 'cancel', cancel: true },
    ],
  });
  if (choice === 'show') openTasksModal();
  if (choice === 'quit') saveResumableTasks(); // latest progress of the interrupted scans
  return choice === 'quit';
}

// "Show" action of a finished task kept in the list: delegates to the task's own `onShow` (e.g. batch-rename failures) or the host's default handler (duplicate results).
async function showReadyTask(task) {
  if (task.onShow) await task.onShow(task);
  else await host.onShowReadyTask?.(task);
}

// A finished task that has something to show (`readyText`, `showLabel`, `onShow`) stays in the list ('ready') until dismissed:
// either the task that just ran (`task`), or a new entry for an operation that skipped the queue (`task` omitted).
export function keepTaskReady(task, properties, { replaceSameKey = false } = {}) {
  if (!task) {
    scanTaskCounter += 1;
    task = { id: `scan-${Date.now()}-${scanTaskCounter}`, path: null, percent: 100, stopRequested: false, toastHidden: false };
    scanTasks.push(task);
  }
  if (replaceSameKey && task.dedupeKey) {
    for (const older of scanTasks.filter(other => other !== task && other.status === 'ready' && other.dedupeKey === task.dedupeKey)) {
      removeReadyTask(older);
    }
  }
  Object.assign(task, { status: 'ready' }, properties);
  task.toastHidden = tasksModal ? !tasksModal.classList.contains('hidden') : false; // the tasks window already shows it
  syncTaskUI();
}

export function removeReadyTask(task) {
  const position = scanTasks.indexOf(task);
  if (position >= 0) scanTasks.splice(position, 1);
  task.result = null; // drop result payload once the task leaves the list
  syncTaskUI();
}

// Removes a waiting or paused task from the queue, or requests cancellation of a running task (photos read so far remain in the catalogue).
function removeOrStopTask(task) {
  if (task.status === 'ready') {
    removeReadyTask(task);
    return;
  }
  if (task.status === 'waiting' || task.status === 'paused') {
    const position = scanTasks.indexOf(task);
    if (position >= 0) scanTasks.splice(position, 1);
    saveResumableTasks();
    syncTaskUI();
    // Tasks that handle their own result (e.g. metadata writes holding a lock) must be notified that they will not run.
    task.onResult?.(null, true, null);
  } else if (!task.stopRequested) {
    task.stopRequested = true;
    syncTaskUI();
    if (!task.runner || task.kind === 'duplicates') invoke('cancel_scan', { taskId: task.id }).catch(error => console.debug('Scan stop failed', error));
  }
}

// When a tracked root folder is removed, drop its queued tasks and stop any active task covering it.
export function dropScanTasksForFolder(path) {
  for (const task of [...scanTasks]) {
    if (task.path !== null && taskCoversFolder({ path }, task.path)) removeOrStopTask(task);
  }
}

// Maps task kinds to concurrency/deduplication families:
// - scans and rescans, integrity checks, keyword writes (never refused as duplicate), face detection ('faces' per folder, 'faces-selection' never refused),
//   face/semantic model downloads, content analysis ('semantic' on its own lane), private map downloads, duplicate searches, updates, and file operations.
function familyOf(taskKind) {
  if (taskKind === 'integrity') return 'integrity';
  if (taskKind === 'keywords') return 'keywords';
  if (taskKind === 'faces' || taskKind === 'faces-selection') return 'faces';
  if (taskKind === 'face-models') return 'face-models';
  if (taskKind === 'update') return 'update';
  if (taskKind === 'semantic-models') return 'semantic-models';
  if (taskKind === 'semantic') return 'semantic';
  if (taskKind === 'private-map') return 'private-map';
  if (taskKind === 'duplicates') return 'duplicates';
  return FILE_TASK_KINDS.includes(taskKind) ? 'files' : 'scan';
}

// Enqueues a task and starts it immediately if its lane is idle.
// Refused (returns false with a toast) when `dedupeKey` matches a non-stopped, non-ready task, or when an active/waiting/paused task of the same family already covers `path`.
// Optional `runner(task, setPercent)` runs UI-driven work instead of a backend command; it must poll `task.stopRequested` and report progress via `setPercent`.
export function enqueueScanTask({ kind, path, command, args, labelKey, labelParams, onResult, runner, dedupeKey }) {
  const sameKey = dedupeKey && scanTasks.find(task => task.dedupeKey === dedupeKey && !task.stopRequested && task.status !== 'ready');
  if (sameKey) {
    host.showToast(t(kind === 'semantic' ? 'A content analysis of this is already in progress or waiting: {name}' : 'A duplicate search on this is already in progress or waiting: {name}', { name: taskName(sameKey) }));
    return false;
  }
  const isIntegrity = kind === 'integrity';
  const sameFamily = task => familyOf(task.kind) === familyOf(kind);
  const covering = kind === 'keywords' || kind === 'faces-selection' || kind === 'private-map' || kind === 'duplicates' || kind === 'semantic' || FILE_TASK_KINDS.includes(kind) ? null : path === null
    ? scanTasks.find(task => task.path === null && !task.stopRequested && sameFamily(task))
    : scanTasks.find(task => !task.stopRequested && sameFamily(task) && taskCoversFolder(task, path));
  if (covering?.status === 'paused') {
    host.showToast(t('Already part of a paused scan: {name}', { name: taskName(covering) }));
    return false;
  }
  if (covering) {
    host.showToast(t(isIntegrity ? 'Already part of an integrity check in progress or waiting: {name}' : 'Already part of a scan in progress or waiting: {name}', { name: taskName(covering) }));
    return false;
  }
  scanTaskCounter += 1;
  scanTasks.push({
    id: `scan-${Date.now()}-${scanTaskCounter}`,
    kind, path, command, args, labelKey, labelParams, onResult, runner, dedupeKey,
    status: 'waiting', percent: 0, stopRequested: false, toastHidden: false,
  });
  if (isResumableTask({ kind })) saveResumableTasks();
  syncTaskUI();
  if (isSemanticLaneTask({ kind })) pumpSemanticQueue();
  else pumpScanQueue();
  return true;
}

// Runs main-lane tasks strictly sequentially in arrival order. Content analysis ('semantic') uses `pumpSemanticQueue` instead so long analyses do not block other tasks.
async function pumpScanQueue() {
  if (scanPumpActive) return;
  scanPumpActive = true;
  const nextWaiting = () => scanTasks.find(item => item.status === 'waiting' && !isSemanticLaneTask(item));
  try {
    for (let task = nextWaiting(); task; task = nextWaiting()) {
      await runScanTask(task);
    }
  } finally {
    scanPumpActive = false;
  }
  // Main queue is now idle: run any library sync requested while foreground tasks were busy.
  host.onMainQueueIdle?.();
}

// Dedicated lane for content analysis: one analysis at a time (the backend refuses a second one with 'semantic_scan_running'),
// running concurrently with the main lane; the backend pauses itself while foreground work runs.
async function pumpSemanticQueue() {
  if (semanticPumpActive) return;
  semanticPumpActive = true;
  try {
    for (let task = scanTasks.find(item => item.status === 'waiting' && isSemanticLaneTask(item)); task;
      task = scanTasks.find(item => item.status === 'waiting' && isSemanticLaneTask(item))) {
      await runScanTask(task);
    }
  } finally {
    semanticPumpActive = false;
  }
}

// Stops all queued or running content analyses (called when content search is disabled).
export function stopSemanticTasks() {
  for (const task of scanTasks.filter(isSemanticLaneTask)) removeOrStopTask(task);
}

async function runScanTask(task) {
  task.status = 'running';
  task.startedAt = Date.now(); // starts the elapsed timer shown in the tasks modal
  // Resumed scan: the files read since its first start are skipped. Taken before the scan reads anything, so every file it reads is dated after it.
  const resumeSince = isResumableTask(task) ? task.firstStartedAt ?? null : null;
  if (isResumableTask(task)) {
    task.firstStartedAt ??= task.startedAt;
    saveResumableTasks();
  }
  syncTaskUI();
  try {
    const args = resumeSince === null ? task.args : { ...task.args, resumeSince };
    const result = task.runner
      ? await task.runner(task, percent => { task.percent = Math.max(task.percent, percent); syncTaskUI(); })
      : await invoke(task.command, { ...args, taskId: task.id });
    if (!task.pauseRequested) task.percent = 100; // a paused scan keeps its progress
    syncTaskUI();
    // Default result handling: custom `onResult`, else integrity report (no catalog reload), else in-place refresh after pause, else full rescan reload.
    if (task.onResult) await task.onResult(result, task.stopRequested, null, task);
    else if (task.kind === 'integrity') host.onIntegrityResult(result, task.stopRequested);
    else if (task.pauseRequested) await host.onPausedScan();
    else await host.onRescanComplete();
    if (task.pauseRequested) host.showToast(t('Task paused: {name}', { name: taskName(task) }));
    else if (task.stopRequested) host.showToast(t('Task stopped: {name}', { name: taskName(task) }));
  } catch (error) {
    console.error('Rescan failed', error);
    if (task.onResult) await task.onResult(null, task.stopRequested, error, task);
    else host.showToast(t(task.kind === 'integrity' ? 'Integrity check failed: {error}' : 'Rescan failed: {error}', { error }));
  } finally {
    if (task.pauseRequested) {
      // Paused: stays in the list, out of the queue, until "Resume" (its own toast closes: the list shows it).
      task.status = 'paused';
      task.pauseRequested = false;
      task.stopRequested = false;
      task.toastHidden = true;
    } else {
      // A task that finished with results to show stays in the list ('ready') until the user shows or dismisses them.
      const position = scanTasks.indexOf(task);
      if (position >= 0 && task.status !== 'ready') scanTasks.splice(position, 1);
    }
    if (isResumableTask(task)) saveResumableTasks();
    syncTaskUI();
  }
}

// Pauses a resumable scan: a waiting one leaves the queue at once, a running one stops (runScanTask then keeps it as 'paused').
function pauseTask(task) {
  if (!isResumableTask(task) || task.stopRequested) return;
  if (task.status === 'waiting') {
    task.status = 'paused';
    saveResumableTasks();
    syncTaskUI();
  } else if (task.status === 'running') {
    task.pauseRequested = true;
    task.stopRequested = true;
    syncTaskUI();
    invoke('cancel_scan', { taskId: task.id }).catch(error => console.debug('Scan pause failed', error));
  }
}

// Resumes a paused scan: it goes first among the waiting tasks, so it starts as soon as the running task has finished.
function resumeTask(task) {
  if (task.status !== 'paused') return;
  scanTasks.splice(scanTasks.indexOf(task), 1);
  const firstWaiting = scanTasks.findIndex(item => item.status === 'waiting' && !isSemanticLaneTask(item));
  scanTasks.splice(firstWaiting < 0 ? scanTasks.length : firstWaiting, 0, task);
  task.status = 'waiting';
  saveResumableTasks();
  syncTaskUI();
  pumpScanQueue();
}

// Folders of paused folder discoveries: the library synchronisation leaves them alone (otherwise it would read the rest of a whole root
// folder in the background, unseen and unstoppable, holding back the content analysis); the scan reads them when resumed.
// Paused rescans are not excluded: the synchronisation only reads their new or changed files, as for any folder.
export const pausedScanFolders = () => scanTasks.filter(task => task.kind === 'add' && task.status === 'paused' && task.path).map(task => task.path);

// Remembers the unfinished resumable scans (running, waiting or paused): after a restart they come back paused (restorePausedTasks).
function saveResumableTasks() {
  const saved = scanTasks
    .filter(task => isResumableTask(task) && ['waiting', 'running', 'paused'].includes(task.status))
    .map(({ kind, path, command, args, labelKey, labelParams, firstStartedAt, percent }) => ({
      kind, path, command, args, labelKey, labelParams, firstStartedAt: firstStartedAt ?? null, percent: firstStartedAt ? percent : 0,
    }));
  try { localStorage.setItem('pausedScanTasks', JSON.stringify(saved)); } catch (error) { console.debug('Paused scans not saved', error); }
}

// At startup: the scans left unfinished last time come back paused (only those whose folder is still tracked), with a toast to tell so.
export function restorePausedTasks() {
  let saved;
  try { saved = JSON.parse(readStored('pausedScanTasks') ?? 'null'); } catch { saved = null; }
  if (!Array.isArray(saved)) saved = DEFAULTS.pausedScanTasks;
  const trackedFolders = host.getTrackedFolders?.() ?? [];
  const tracked = path => trackedFolders.some(folder => taskCoversFolder({ path: folder.path }, path));
  const restored = saved.filter(item => item && RESUMABLE_TASK_KINDS.includes(item.kind) && typeof item.command === 'string'
    && (item.path === null ? trackedFolders.length > 0 : typeof item.path === 'string' && tracked(item.path)));
  for (const item of restored) {
    scanTaskCounter += 1;
    scanTasks.push({
      id: `scan-${Date.now()}-${scanTaskCounter}`,
      kind: item.kind, path: item.path, command: item.command, args: item.args ?? {}, labelKey: item.labelKey, labelParams: item.labelParams,
      firstStartedAt: Number.isFinite(item.firstStartedAt) ? item.firstStartedAt : null, percent: Number(item.percent) || 0,
      status: 'paused', stopRequested: false, toastHidden: true,
    });
  }
  saveResumableTasks(); // drops the scans of folders no longer tracked
  syncTaskUI();
  if (restored.length) host.showToast(tp('{count} paused scan can be resumed from the task list.', restored.length, { count: restored.length }));
}

// Integrity check of a folder in the tree (subfolders included), launched from its context menu: decodes every file and generates missing cached thumbnails.
export function checkFolderIntegrity(path) {
  return enqueueScanTask({ kind: 'integrity', path, command: 'integrity_scan', args: { path }, labelKey: 'Integrity check: {folder}', labelParams: { folder: folderBaseName(path) } });
}

// Rescan of a folder in the tree (subfolders included), launched from its context menu.
export function rescanFolder(path) {
  return enqueueScanTask({ kind: 'rescan-folder', path, command: 'rescan_folder', args: { path }, labelKey: 'Folder data rescan: {folder}', labelParams: { folder: folderBaseName(path) } });
}

// Wires DOM controls, keyboard guards (modal Escape and F5/Ctrl+R block while tasks run), and backend progress/detail events.
export function initTaskQueue(deps) {
  if (initialized) return;
  host = deps;
  initialized = true;

  taskToastsContainer = document.getElementById('task-toasts');
  tasksButton = document.getElementById('btn-open-tasks');
  tasksModal = document.getElementById('tasks-modal');
  tasksList = document.getElementById('tasks-list');

  onLanguageChange(syncTaskUI);

  tasksButton.addEventListener('click', openTasksModal);
  document.getElementById('btn-close-tasks').addEventListener('click', closeTasksModal);
  tasksModal.addEventListener('click', event => {
    if (event.target === tasksModal) closeTasksModal();
  });
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || tasksModal.classList.contains('hidden')) return;
    event.preventDefault();
    closeTasksModal();
  });

  // Page reload (F5, Ctrl+R) resets the frontend and drops the queue while the backend keeps working, leaving UI and backend out of sync.
  // Block reload while any active task exists and inform the user.
  window.addEventListener('keydown', event => {
    const isReload = event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r');
    if (!isReload || activeTaskCount() === 0) return;
    event.preventDefault();
    host.showToast(t('Reload disabled while tasks are running'));
  });

  document.getElementById('btn-rescan-folders').addEventListener('click', () => enqueueScanTask({
    kind: 'rescan-all', path: null, command: 'rescan_all_folders', args: {}, labelKey: 'Collection data rescan', labelParams: undefined,
  }));

  // Progress of queued tasks (percentage never moves backwards if events arrive out of order).
  listenToBackend('scan-progress', event => {
    const { taskId, percent, done, total, remainingSeconds, paused } = event.payload || {};
    const task = scanTasks.find(item => item.id === taskId);
    if (!task || task.status !== 'running') return;
    task.percent = Math.max(task.percent, Number(percent) || 0);
    // Content analysis: photos handled / to handle, backend ETA (null initially, excludes pauses) and pause flag.
    if (isSemanticLaneTask(task)) {
      task.done = Number(done) || 0;
      task.total = Number(total) || 0;
      task.remainingSeconds = Number.isFinite(remainingSeconds) ? remainingSeconds : null;
      task.paused = paused === true;
    }
    syncTaskUI();
  }).catch(error => console.debug('Progress tracking unavailable', error));

  // Folder currently analysed by a task (integrity check): shown below the percentage in the toast and tasks modal.
  listenToBackend('scan-detail', event => {
    const { taskId, detail } = event.payload || {};
    const task = scanTasks.find(item => item.id === taskId);
    if (!task || task.status !== 'running') return;
    task.detail = typeof detail === 'string' ? detail : '';
    syncTaskUI();
  }).catch(error => console.debug('Current folder tracking unavailable', error));
}
