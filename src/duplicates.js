// Duplicate search: pure helpers for the results view (the mode itself, the banner and the way back are in main.js, section "DUPLICATES").
// The backend (duplicates.rs) returns groups of paths; here a group is { id, members: [photo], bytes, firstPath }.
import './duplicates.css';
import { t } from './i18n.js';

/** Ways to order the groups: most images first, largest total size first, or by path. */
export const GROUP_SORT_MODES = ['count', 'size', 'path'];
export const GROUP_SORT_LABELS = { count: 'By number', size: 'By total size', path: 'By path' };

const pathCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function normalizeGroupSort(value) {
  return GROUP_SORT_MODES.includes(value) ? value : 'count';
}

// Size formatting lives in i18n.js; re-exported here for the modules that already import it from this file.
export { formatBytes } from './i18n.js';

// How the best copy of a group is chosen. Saved at once whenever it changes in the "Best copy" panel, and used by every later search.
//  - A text looked for in the full path (any part of it, any case, / or \ alike), preferred or to avoid: applied first, outside the list. For instance
//    "originals" preferred keeps what sits in an Originals folder, "export" to avoid sets aside what sits in an export folder.
//  - Then the ticked criteria of the list, in the order set by the user: the first one that tells two copies apart decides. The date criterion keeps the
//    oldest or the newest date taken (dateDirection). Missing dates always come last.
//  - The path is the last resort, so the order is always stable.
const KEEP_STORAGE_KEY = 'duplicateKeepSettings';
export const KEEP_CRITERIA = {
  pixels: 'Most pixels',
  size: 'Largest file',
  rating: 'Best rated',
  date: 'Date taken',
  shortname: 'Shortest file name',
};
const KEEP_DEFAULT_ORDER = [['pixels', true], ['size', true], ['rating', true], ['date', false], ['shortname', false]];

export function getKeepSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEEP_STORAGE_KEY) ?? '{}'); } catch { /* unreadable: defaults */ }
  const order = [];
  for (const entry of Array.isArray(saved.order) ? saved.order : []) {
    if (entry && entry.key in KEEP_CRITERIA && !order.some(item => item.key === entry.key)) order.push({ key: entry.key, enabled: entry.enabled === true });
  }
  for (const [key, enabled] of KEEP_DEFAULT_ORDER) if (!order.some(item => item.key === key)) order.push({ key, enabled });
  return {
    order,
    dateDirection: saved.dateDirection === 'newest' ? 'newest' : 'oldest',
    path: typeof saved.path === 'string' ? saved.path : '',
    pathMode: saved.pathMode === 'avoid' ? 'avoid' : 'prefer',
  };
}

export function saveKeepSettings(settings) {
  try { localStorage.setItem(KEEP_STORAGE_KEY, JSON.stringify(settings)); } catch { /* storage unavailable: the choice only lasts until restart */ }
}

/** "Path containing "originals" preferred > Most pixels > Largest file", for tooltips. */
export function describeKeepOrder(settings) {
  const parts = [];
  const needle = settings.path.trim();
  if (needle) parts.push(t(settings.pathMode === 'avoid' ? 'Path containing "{text}" avoided' : 'Path containing "{text}" preferred', { text: needle }));
  for (const entry of settings.order) {
    if (!entry.enabled) continue;
    parts.push(entry.key === 'date' ? t(settings.dateDirection === 'newest' ? 'Newest date taken' : 'Oldest date taken') : t(KEEP_CRITERIA[entry.key]));
  }
  return parts.join(' > ');
}

const normalizePath = path => path.replace(/\\/g, '/').toLowerCase();
const fileName = path => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
const pixelCount = photo => (photo.width || 0) * (photo.height || 0);
// Dates are "YYYY-MM-DD HH:MM:SS": they compare as text. A missing date always comes last.
const compareDates = (a, b, direction) => {
  const dateA = (a.date_taken || '').trim();
  const dateB = (b.date_taken || '').trim();
  if (!dateA || !dateB) return dateA === dateB ? 0 : dateA ? -1 : 1;
  return dateA < dateB ? -direction : dateA > dateB ? direction : 0;
};

function keepComparators(settings) {
  const comparators = [];
  const needle = normalizePath(settings.path.trim());
  if (needle) {
    const holds = photo => (normalizePath(photo.path).includes(needle) ? 1 : 0);
    comparators.push(settings.pathMode === 'avoid' ? (a, b) => holds(a) - holds(b) : (a, b) => holds(b) - holds(a));
  }
  const available = {
    pixels: (a, b) => pixelCount(b) - pixelCount(a),
    size: (a, b) => (b.file_size || 0) - (a.file_size || 0),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    date: (a, b) => compareDates(a, b, settings.dateDirection === 'newest' ? -1 : 1),
    shortname: (a, b) => fileName(a.path).length - fileName(b.path).length,
  };
  for (const entry of settings.order) if (entry.enabled) comparators.push(available[entry.key]);
  return comparators;
}

/** Members of a group, the copy to keep first (see getKeepSettings). */
export function sortGroupMembers(members, settings = getKeepSettings()) {
  const comparators = keepComparators(settings);
  return [...members].sort((a, b) => {
    for (const compare of comparators) {
      const result = compare(a, b);
      if (result) return result;
    }
    return pathCollator.compare(a.path, b.path);
  });
}

/** Groups in display order. Ties always fall back on the path, so the order is stable. */
export function orderGroups(groups, mode) {
  const byPath = (a, b) => pathCollator.compare(a.firstPath, b.firstPath);
  const compare = mode === 'size' ? (a, b) => b.bytes - a.bytes || byPath(a, b)
    : mode === 'path' ? byPath
    : (a, b) => b.members.length - a.members.length || byPath(a, b);
  return [...groups].sort(compare);
}

// Settings of the similar-image search, saved with "Save these settings as default" in the "More…" window (not built yet: until then the defaults apply).
// sensitivity: strict / normal / loose = largest number of differing bits (of 64) between two photos.
const SIMILAR_STORAGE_KEY = 'similarSearchSettings';
const SIMILAR_DISTANCES = { strict: 3, normal: 6, loose: 10 };
const SIMILAR_DEFAULTS = { sensitivity: 'normal', rotations: false, ignoreBursts: true, burstMs: 1000, includeRawPairs: false };

export function getSimilarSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIMILAR_STORAGE_KEY) ?? '{}');
    const burstMs = Number(saved.burstMs);
    return {
      sensitivity: saved.sensitivity in SIMILAR_DISTANCES ? saved.sensitivity : SIMILAR_DEFAULTS.sensitivity,
      rotations: typeof saved.rotations === 'boolean' ? saved.rotations : SIMILAR_DEFAULTS.rotations,
      ignoreBursts: typeof saved.ignoreBursts === 'boolean' ? saved.ignoreBursts : SIMILAR_DEFAULTS.ignoreBursts,
      burstMs: Number.isFinite(burstMs) && burstMs >= 0 && burstMs <= 60000 ? Math.round(burstMs) : SIMILAR_DEFAULTS.burstMs,
      includeRawPairs: typeof saved.includeRawPairs === 'boolean' ? saved.includeRawPairs : SIMILAR_DEFAULTS.includeRawPairs,
    };
  } catch {
    return { ...SIMILAR_DEFAULTS };
  }
}

/** One line for a tooltip: what the quick "identical" entry will do with the saved settings. */
export function describeIdenticalSettings(settings) {
  const parts = [];
  if (settings.hash) parts.push(settings.ignoreMetadata ? `${t('Image data')} (${t('metadata ignored')})` : t('Image data'));
  if (settings.name) parts.push(t('File name'));
  return parts.join(' + ');
}

/** The same for the "similar" entry. */
export function describeSimilarSettings(settings) {
  const level = { strict: 'Strict', normal: 'Normal', loose: 'Loose' }[settings.sensitivity];
  const parts = [t('Sensitivity: {level}', { level: t(level) })];
  if (settings.rotations) parts.push(t('rotations and mirrors'));
  if (settings.ignoreBursts) parts.push(t('bursts ignored ({ms} ms)', { ms: settings.burstMs }));
  return parts.join(' · ');
}

/** What a search looked for, one criterion per line (tooltip of the results banner). */
export function describeSearch(kind, settings, { scope, compareWithLibrary }) {
  const lines = [];
  if (kind === 'identical') {
    if (settings.hash) lines.push(`${t('Image data')} (${settings.ignoreMetadata ? t('metadata ignored') : t('metadata compared')})`);
    if (settings.name) {
      const options = [settings.pattern ? t('pattern: {pattern}', { pattern: settings.pattern }) : t('whole name'), t('shortest key: {count}', { count: settings.minLength })];
      if (settings.sameDate) options.push(t('same date taken'));
      if (settings.includeRawPairs) options.push(t('RAW and JPEG together'));
      lines.push(`${t('File name')} (${options.join(', ')})`);
    }
  } else {
    lines.push(describeSimilarSettings(settings));
    if (settings.includeRawPairs) lines.push(t('RAW and JPEG together'));
  }
  lines.push(compareWithLibrary ? t('Compared with the whole library') : t('Compared inside the scope only'));
  if (scope.kind === 'folder') lines.push(scope.recursive ? t('Subfolders included') : t('Subfolders not included'));
  return `${t('Search criteria')}\n${lines.map(line => `• ${line}`).join('\n')}`;
}

/** The fields of the backend request (`find_similar_images`) that come from the settings. */
export function similarRequestFields(settings) {
  return {
    maxDistance: SIMILAR_DISTANCES[settings.sensitivity],
    rotations: settings.rotations,
    ignoreBursts: settings.ignoreBursts,
    burstMs: settings.burstMs,
    includeRawPairs: settings.includeRawPairs,
  };
}

// Settings of the search for identical images, saved with "Save these settings as default" in the "More…" window; they are also what the quick
// "Identical images" menu entry uses. Two criteria, joined by "or": the image data (hash) and the file name. The name pattern is a regular expression
// of its own, separate from the one used to find a RAW; empty = the whole name without extension is the key.
const IDENTICAL_STORAGE_KEY = 'identicalSearchSettings';
const IDENTICAL_DEFAULTS = { hash: true, ignoreMetadata: true, name: false, pattern: '', minLength: 3, sameDate: false, includeRawPairs: false };

export function getIdenticalSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(IDENTICAL_STORAGE_KEY) ?? '{}');
    const flag = key => (typeof saved[key] === 'boolean' ? saved[key] : IDENTICAL_DEFAULTS[key]);
    const minLength = Math.round(Number(saved.minLength));
    const settings = {
      hash: flag('hash'), ignoreMetadata: flag('ignoreMetadata'), name: flag('name'), sameDate: flag('sameDate'), includeRawPairs: flag('includeRawPairs'),
      pattern: typeof saved.pattern === 'string' ? saved.pattern : IDENTICAL_DEFAULTS.pattern,
      minLength: Number.isFinite(minLength) && minLength >= 2 && minLength <= 50 ? minLength : IDENTICAL_DEFAULTS.minLength,
    };
    if (!settings.hash && !settings.name) settings.hash = true; // at least one criterion
    return settings;
  } catch {
    return { ...IDENTICAL_DEFAULTS };
  }
}

export function saveIdenticalSettings(settings) {
  try { localStorage.setItem(IDENTICAL_STORAGE_KEY, JSON.stringify(settings)); } catch { /* storage unavailable: the settings simply stay as they were */ }
}

export function saveSimilarSettings(settings) {
  try { localStorage.setItem(SIMILAR_STORAGE_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

/**
 * Joins the groups found by several criteria into one list: two groups that share a photo become one. `parts` = [{ reason, groups: [[path]] }].
 * Returns { groups, reasons } with reasons[i] = the criteria (in the order given) behind groups[i].
 */
export function mergeGroups(parts) {
  const ids = new Map();
  const paths = [];
  const parents = [];
  const idOf = path => {
    if (!ids.has(path)) { ids.set(path, paths.length); paths.push(path); parents.push(paths.length - 1); }
    return ids.get(path);
  };
  const find = id => { while (parents[id] !== id) { parents[id] = parents[parents[id]]; id = parents[id]; } return id; };
  for (const part of parts) {
    for (const group of part.groups) {
      const first = find(idOf(group[0]));
      for (const path of group.slice(1)) parents[find(idOf(path))] = first;
    }
  }
  const members = new Map();
  const reasons = new Map();
  paths.forEach((path, id) => {
    const root = find(id);
    members.set(root, [...(members.get(root) ?? []), path]);
  });
  for (const part of parts) {
    for (const group of part.groups) {
      const root = find(idOf(group[0]));
      reasons.set(root, [...new Set([...(reasons.get(root) ?? []), part.reason])]);
    }
  }
  const order = parts.map(part => part.reason);
  const merged = [...members.entries()].map(([root, list]) => ({ paths: list.sort(), reasons: (reasons.get(root) ?? []).sort((a, b) => order.indexOf(a) - order.indexOf(b)) }));
  merged.sort((a, b) => (a.paths[0] < b.paths[0] ? -1 : a.paths[0] > b.paths[0] ? 1 : 0));
  return { groups: merged.map(group => group.paths), reasons: merged.map(group => group.reasons) };
}

/** Smallest path of a group, used to order groups by path. */
export function firstPathOf(members) {
  return members.map(photo => photo.path).sort(pathCollator.compare)[0] ?? '';
}
