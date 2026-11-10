// Collection statistics (window opened from Settings). Spec: dev_tools/Evolutions/feat stats.txt.
//
// Filters on top (camera, root folder and file format: multiple choices; period; granularity of the time chart), data blocks below.
// Every figure comes from the backend (stats.rs, commands get_collection_stats and get_stats_filter_options), which reads the catalogue:
// nothing is computed from the displayed list, which is capped at 50,000 photos. This module owns the calendar (period, granularity,
// grouping of the per-day counts into weeks / months / years / decades) and the display.

import './stats.css';
import { invoke } from '@tauri-apps/api/core';
import { t, tp, getLanguage, onLanguageChange, normalizeSearch } from './i18n.js';
import { createFilterSuggest } from './filter-suggest.js';
import { createFilterTag } from './filter-tags.js';
import { buildCatalog, extensionsOf } from './format-filters.js';
import { isFaceDetectionEnabled } from './faces-panel.js';
import { isSemanticEnabled } from './semantic-settings.js';
import { isColorEnabled, isPickEnabled } from './marking-settings.js';

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const pad = value => String(value).padStart(2, '0');
// Day as YYYYMMDD in the user's local calendar (a date taken has no time zone).
const dayKey = date => date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
const keyDate = key => new Date(Math.floor(key / 10000), (Math.floor(key / 100) % 100) - 1, key % 100);
const inputValue = key => `${Math.floor(key / 10000)}-${pad(Math.floor(key / 100) % 100)}-${pad(key % 100)}`;
const inputKey = value => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? Number(value.replaceAll('-', '')) : null);

// Period presets. "Last month" and "Last year" are whole months ending with the last complete one (today is in the current, incomplete
// month): in November 2026, the last month is October 2026 and the last year is November 2025 to October 2026. "All time" has no bounds.
function presetRange(name) {
  if (name === 'all') return { since: null, until: null };
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), 0);
  const start = new Date(today.getFullYear(), today.getMonth() - (name === 'month' ? 1 : 12), 1);
  return { since: dayKey(start), until: dayKey(end) };
}
const PRESETS = ['month', 'year', 'all'];
const DEFAULT_PRESET = 'year';

// Granularities of the time chart, from finest to coarsest, with the average length of their unit in days.
const GRANULARITIES = ['day', 'week', 'month', 'year', 'decade'];
const UNIT_DAYS = { day: 1, week: 7, month: 30.4375, year: 365.25, decade: 3652.5 };
const GRANULARITY_LABELS = { day: 'By day', week: 'By week', month: 'By month', year: 'By year', decade: 'By decade' };
const CHART_TITLES = { day: 'Photos per day', week: 'Photos per week', month: 'Photos per month', year: 'Photos per year', decade: 'Photos per decade' };
// A good chart has about this many columns: the default granularity is the allowed one that gets closest.
const TARGET_COLUMNS = 30;

// Granularities offered for a period of `days` days: day up to 62 days; week from 28 days to 62 weeks; month from 6 to 62 months;
// year from 2 to 62 years; decade from 30 years.
function allowedGranularities(days) {
  const rules = {
    day: days <= 62,
    week: days >= 28 && days / 7 <= 62,
    month: days / UNIT_DAYS.month >= 6 && days / UNIT_DAYS.month <= 62,
    year: days / UNIT_DAYS.year >= 2 && days / UNIT_DAYS.year <= 62,
    decade: days / UNIT_DAYS.year >= 30,
  };
  const allowed = GRANULARITIES.filter(name => rules[name]);
  return allowed.length ? allowed : ['month'];
}

function defaultGranularity(days, allowed) {
  let best = allowed[0];
  for (const name of allowed) {
    if (Math.abs(days / UNIT_DAYS[name] - TARGET_COLUMNS) < Math.abs(days / UNIT_DAYS[best] - TARGET_COLUMNS)) best = name;
  }
  return best;
}

// Length of the period in days: its bounds, or for a missing bound the first / last day with photos.
function spanDays(since, until, days) {
  const first = since ?? days[0]?.key;
  const last = until ?? days.at(-1)?.key;
  if (first == null || last == null) return null;
  return Math.max(1, Math.round((keyDate(last) - keyDate(first)) / DAY_MS) + 1);
}

// Start of the column a date belongs to (weeks start on Monday).
function bucketStart(date, name) {
  const [year, month, day] = [date.getFullYear(), date.getMonth(), date.getDate()];
  switch (name) {
    case 'day': return new Date(year, month, day);
    case 'week': return new Date(year, month, day - ((date.getDay() + 6) % 7));
    case 'month': return new Date(year, month, 1);
    case 'year': return new Date(year, 0, 1);
    default: return new Date(Math.floor(year / 10) * 10, 0, 1);
  }
}

function nextBucket(start, name) {
  const [year, month, day] = [start.getFullYear(), start.getMonth(), start.getDate()];
  switch (name) {
    case 'day': return new Date(year, month, day + 1);
    case 'week': return new Date(year, month, day + 7);
    case 'month': return new Date(year, month + 1, 1);
    case 'year': return new Date(year + 1, 0, 1);
    default: return new Date(year + 10, 0, 1);
  }
}

// Columns from the first to the last day, empty ones included: [{ start, count }].
function buildColumns(days, name, firstKey, lastKey) {
  const counts = new Map();
  for (const { key, count } of days) {
    const columnKey = dayKey(bucketStart(keyDate(key), name));
    counts.set(columnKey, (counts.get(columnKey) ?? 0) + count);
  }
  const columns = [];
  const end = keyDate(lastKey);
  for (let start = bucketStart(keyDate(firstKey), name); start <= end && columns.length < 5000; start = nextBucket(start, name)) {
    columns.push({ start, count: counts.get(dayKey(start)) ?? 0 });
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const formatNumber = value => value.toLocaleString(getLanguage());
const photoCount = count => tp('{count} photo', count, { count: formatNumber(count) });
const formatPercent = share => new Intl.NumberFormat(getLanguage(), { style: 'percent', maximumFractionDigits: 0 }).format(share);

// Size in bytes, scaled by 1024 up to terabytes: "1.4 GB" / "1,4 Go".
function formatSize(bytes) {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(getLanguage(), { style: 'unit', unit: units[unit], unitDisplay: 'short', maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
}

// Colour and pick flags in display order; the label is a translation key (same as the filter panel).
const COLOR_FLAGS = [['red', 'Red'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['green', 'Green'], ['blue', 'Blue'], ['magenta', 'Magenta'], ['grey', 'Grey'], ['black', 'Black'], ['white', 'White']];
const PICK_FLAGS = [['picked', 'Picked'], ['rejected', 'Rejected'], ['pending', 'Pending'], ['none', 'No flag']];

// ---------------------------------------------------------------------------
// Rows (every list of the window shares them)
// ---------------------------------------------------------------------------

const span = (className, text = '') => {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
};

/**
 * One list row: [rank] [name + optional path] [count text], over a background bar `share` (0-100) wide.
 * options: rank (number shown first), path (grey second line), swatch (colour class of a small square before the name), title (tooltip).
 */
function listRow(name, countText, share, { rank = '', path = '', swatch = '', title = '' } = {}) {
  const row = document.createElement('li');
  row.className = 'stats-rank-item';
  row.style.setProperty('--share', `${Math.max(0, Math.min(100, Math.round(share)))}%`);
  if (title) row.title = title;
  const label = span('stats-rank-label');
  const nameLine = span('stats-rank-name');
  if (swatch) nameLine.append(span(`stats-swatch ${swatch}`));
  nameLine.append(name);
  label.append(nameLine);
  if (path) label.append(span('stats-rank-path', path));
  row.append(span('stats-rank-number', String(rank)), label, span('stats-rank-count', countText));
  return row;
}

// Placeholder row for a list with nothing to show.
const emptyRow = () => {
  const row = document.createElement('li');
  row.className = 'stats-rank-empty';
  row.textContent = '—';
  return row;
};

// ---------------------------------------------------------------------------
// Multiple-choice filter (camera, root folder, format): the suggestion list and chips of the filter panel.
// ---------------------------------------------------------------------------

/**
 * - input, list, tagsBox: the field, its `<ul class="keyword-suggestions below">` and the box that holds the chips;
 * - getOptions(): offered entries [{ value, label, count }]; labelOf(value): chip text (follows the language);
 * - onChange(): a chip was added or removed.
 * Nothing chosen = no filter. Alt+Enter (exclude) is not offered here: the choice is "only these".
 */
function createMultiPicker({ input, list, tagsBox, kind, getOptions, labelOf, onChange }) {
  const selected = new Set();
  function render() {
    tagsBox.replaceChildren(...[...selected].map(value => createFilterTag({
      kind,
      text: labelOf(value),
      onRemove: () => {
        selected.delete(value);
        render();
        onChange();
      },
    })));
  }
  createFilterSuggest({
    input,
    list,
    getOptions: () => getOptions().filter(option => !selected.has(option.value)).map(option => ({ ...option, search: normalizeSearch(option.label) })),
    onPick: value => {
      if (value === null) return; // Enter with no suggestion: only listed entries can be chosen
      selected.add(value);
      render();
      onChange();
    },
    emptyText: 'No matching entry',
  });
  return { values: () => [...selected], render };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

export function initStats() {
  const ids = ['stats-modal', 'btn-open-stats', 'btn-close-stats', 'stats-from', 'stats-to', 'stats-granularity', 'stats-message', 'stats-content',
    'stats-camera-input', 'stats-camera-suggestions', 'stats-camera-tags', 'stats-folder-input', 'stats-folder-suggestions', 'stats-folder-tags',
    'stats-format-input', 'stats-format-suggestions', 'stats-format-tags', 'stats-total-photos', 'stats-total-size', 'stats-chart-title', 'stats-chart',
    'stats-chart-note', 'stats-extensions', 'stats-ratings', 'stats-colors-column', 'stats-colors', 'stats-picks-column', 'stats-picks', 'stats-keywords',
    'stats-keywords-note', 'stats-geo', 'stats-faces-section', 'stats-faces', 'stats-top-persons', 'stats-param', 'stats-shooting', 'stats-shooting-note',
    'stats-analysis-section', 'stats-analysis'];
  const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  if (!ids.every(id => el[id])) {
    console.error('Statistics: elements not found in index.html');
    return;
  }
  const presetButtons = [...el['stats-modal'].querySelectorAll('.stats-preset')];

  // Period asked (null bound = open) and granularity chosen by hand (null = the default one for the period).
  const state = { since: null, until: null, granularity: null };
  // Only the latest answer is displayed: changing a filter during a computation must not let the old result win.
  let requestId = 0;
  let optionsId = 0;
  let lastStats = null;
  let filterOptions = { cameras: [], folders: [], extensions: [] };

  // --- Filters ---------------------------------------------------------------

  const extensionCounts = () => new Map(filterOptions.extensions.map(item => [item.name, item.count]));
  const formatLabelOf = id => buildCatalog().find(entry => entry.id === id)?.label ?? id;

  const cameraPicker = createMultiPicker({
    input: el['stats-camera-input'], list: el['stats-camera-suggestions'], tagsBox: el['stats-camera-tags'], kind: 'camera',
    getOptions: () => filterOptions.cameras.map(item => ({ value: item.name, label: item.name, count: item.count })),
    labelOf: name => name,
    onChange: () => load(),
  });
  const folderPicker = createMultiPicker({
    input: el['stats-folder-input'], list: el['stats-folder-suggestions'], tagsBox: el['stats-folder-tags'], kind: 'folder',
    getOptions: () => filterOptions.folders.map(item => ({ value: item.id, label: item.path, count: item.count })),
    labelOf: id => filterOptions.folders.find(item => item.id === id)?.path ?? String(id),
    onChange: () => load(),
  });
  // Same catalogue as the Format filter of the filter panel (RAW / Raster / Video, RAW brands, extensions); only those present are offered.
  const formatPicker = createMultiPicker({
    input: el['stats-format-input'], list: el['stats-format-suggestions'], tagsBox: el['stats-format-tags'], kind: 'format',
    getOptions: () => {
      const counts = extensionCounts();
      return buildCatalog()
        .map(entry => ({ value: entry.id, label: entry.label, count: [...entry.extensions].reduce((sum, extension) => sum + (counts.get(extension) ?? 0), 0) }))
        .filter(option => option.count > 0);
    },
    labelOf: formatLabelOf,
    onChange: () => load(),
  });

  // Marks the preset whose range is the current one (none when the dates were typed).
  function syncPresetButtons() {
    for (const button of presetButtons) {
      const range = presetRange(button.dataset.preset);
      button.setAttribute('aria-pressed', String(range.since === state.since && range.until === state.until));
    }
  }

  function setPeriod(since, until) {
    state.since = since;
    state.until = until;
    state.granularity = null; // a new period gets its default granularity again
    el['stats-from'].value = since === null ? '' : inputValue(since);
    el['stats-to'].value = until === null ? '' : inputValue(until);
    syncPresetButtons();
  }

  for (const button of presetButtons) {
    button.addEventListener('click', () => {
      const { since, until } = presetRange(button.dataset.preset);
      setPeriod(since, until);
      load();
    });
  }
  const onDatesChange = () => {
    let since = inputKey(el['stats-from'].value);
    let until = inputKey(el['stats-to'].value);
    if (since !== null && until !== null && since > until) [since, until] = [until, since];
    setPeriod(since, until);
    load();
  };
  el['stats-from'].addEventListener('change', onDatesChange);
  el['stats-to'].addEventListener('change', onDatesChange);

  // Granularities offered for the period, the one in use and the select showing them. Returns the one to draw with, null with no period.
  function syncGranularity(stats) {
    const select = el['stats-granularity'];
    const days = spanDays(state.since, state.until, stats?.days ?? []);
    if (days === null) {
      select.replaceChildren();
      select.disabled = true;
      return null;
    }
    const allowed = allowedGranularities(days);
    const chosen = allowed.includes(state.granularity) ? state.granularity : defaultGranularity(days, allowed);
    select.replaceChildren(...allowed.map(name => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = t(GRANULARITY_LABELS[name]);
      return option;
    }));
    select.value = chosen;
    select.disabled = allowed.length < 2;
    return chosen;
  }
  el['stats-granularity'].addEventListener('change', () => {
    state.granularity = el['stats-granularity'].value;
    if (lastStats && lastStats.photos > 0) renderChart(lastStats);
  });

  // --- Blocks ----------------------------------------------------------------

  // A message replaces the data blocks (loading, error, nothing matches); the filters stay.
  function showMessage(text) {
    el['stats-message'].textContent = text;
    el['stats-message'].hidden = !text;
    el['stats-content'].hidden = Boolean(text);
  }

  // Sentence under a list: how much of the photos it rests on (photos without the information are not in it).
  function coverageNote(known, total) {
    if (known === 0) return t('No photo has this information.');
    if (known < total) return t('{known} of {total} photos have this information', { known: formatNumber(known), total: formatNumber(total) });
    return '';
  }

  function renderTotals(stats) {
    el['stats-total-photos'].textContent = formatNumber(stats.photos);
    el['stats-total-size'].textContent = formatSize(stats.totalSize);
  }

  function renderChart(stats) {
    const name = syncGranularity(stats);
    const lang = getLanguage();
    el['stats-chart'].replaceChildren();
    const undated = stats.photos - stats.datedPhotos;
    const undatedNote = undated > 0 ? tp('{count} photo without a date is not shown in the chart', undated, { count: formatNumber(undated) }) : '';
    if (name === null || stats.days.length === 0) {
      el['stats-chart-title'].textContent = t(CHART_TITLES.month);
      el['stats-chart-note'].textContent = [t('No photo with a date.'), undatedNote].filter(Boolean).join(' ');
      return;
    }
    el['stats-chart-title'].textContent = t(CHART_TITLES[name]);
    el['stats-chart-note'].textContent = undatedNote;
    const columns = buildColumns(stats.days, name, state.since ?? stats.days[0].key, state.until ?? stats.days.at(-1).key);
    const top = Math.max(...columns.map(column => column.count), 1);
    // Roughly a dozen labels at most, whatever the number of columns.
    const every = Math.max(1, Math.ceil(columns.length / 12));
    const shortFormats = {
      day: new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }),
      week: new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }),
      month: new Intl.DateTimeFormat(lang, { month: 'short', year: '2-digit' }),
      year: new Intl.DateTimeFormat(lang, { year: 'numeric' }),
    };
    const monthOnly = new Intl.DateTimeFormat(lang, { month: 'short' });
    const fullDay = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric' });
    const fullMonth = new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric' });
    const shortLabel = (start, index) => {
      if (name === 'decade') return `${start.getFullYear()}s`;
      // Up to 12 months the month name is enough (the year is added on the first column and on January).
      if (name === 'month' && columns.length <= 12 && index > 0 && start.getMonth() !== 0) return monthOnly.format(start);
      return shortFormats[name].format(start);
    };
    const fullLabel = start => {
      if (name === 'day') return fullDay.format(start);
      if (name === 'week') return t('Week of {date}', { date: fullDay.format(start) });
      if (name === 'month') return fullMonth.format(start);
      if (name === 'year') return String(start.getFullYear());
      return `${start.getFullYear()}–${start.getFullYear() + 9}`;
    };

    const axis = span('stats-axis-max', formatNumber(top));
    const scroller = document.createElement('div');
    scroller.className = 'stats-chart-scroll';
    // Column width by their number; few columns grow to fill the window (flex-grow in the CSS).
    scroller.style.setProperty('--bar-width', columns.length <= 12 ? '2.6rem' : columns.length <= 24 ? '1.6rem' : '1.1rem');
    const bars = document.createElement('div');
    bars.className = 'stats-bars';
    const labels = document.createElement('div');
    labels.className = 'stats-labels';
    columns.forEach((column, index) => {
      const bar = document.createElement('div');
      bar.className = 'stats-bar';
      bar.title = `${fullLabel(column.start)}: ${photoCount(column.count)}`;
      const fill = document.createElement('div');
      fill.className = column.count > 0 ? 'stats-bar-fill' : 'stats-bar-fill empty';
      fill.style.height = `${(column.count / top) * 100}%`;
      bar.append(fill);
      bars.append(bar);
      const label = document.createElement('div');
      label.className = 'stats-label';
      if (index % every === 0) label.append(span('', shortLabel(column.start, index)));
      labels.append(label);
    });
    scroller.append(bars, labels);
    el['stats-chart'].append(axis, scroller);
  }

  function renderExtensions(stats) {
    const top = stats.extensions[0]?.count || 1;
    el['stats-extensions'].replaceChildren(...stats.extensions.map(item => listRow(
      item.extension ? `.${item.extension.toUpperCase()}` : t('No extension'),
      `${photoCount(item.count)} · ${formatSize(item.size)}`,
      (item.count / top) * 100,
    )));
  }

  // Ratings (always), colours and pick flags (only while turned on in Settings, like everywhere else in the application).
  function renderFlags(stats) {
    const total = stats.photos;
    const countText = count => `${formatNumber(count)} (${formatPercent(count / total)})`;
    const ratingTop = Math.max(...stats.ratings, 1);
    const ratingRows = [5, 4, 3, 2, 1, 0].map(stars => listRow(stars ? '★'.repeat(stars) : t('Unrated'), countText(stats.ratings[stars]), (stats.ratings[stars] / ratingTop) * 100, { title: stars ? `${stars} ★` : '' }));
    el['stats-ratings'].replaceChildren(...ratingRows);

    const flagRows = (flags, items, { skipNone, swatches }) => {
      const counts = new Map(items.map(item => [item.name, item.count]));
      const present = flags.filter(([key]) => counts.get(key) > 0 && !(skipNone && key === 'none'));
      const top = Math.max(...present.map(([key]) => counts.get(key)), 1);
      const rows = present.map(([key, label]) => listRow(t(label), countText(counts.get(key)), (counts.get(key) / top) * 100, { swatch: swatches ? key : '' }));
      return rows.length ? rows : [emptyRow()];
    };
    el['stats-colors-column'].hidden = !isColorEnabled();
    el['stats-picks-column'].hidden = !isPickEnabled();
    el['stats-colors'].replaceChildren(...flagRows(COLOR_FLAGS, stats.colors, { skipNone: true, swatches: true }));
    el['stats-picks'].replaceChildren(...flagRows(PICK_FLAGS, stats.picks, { skipNone: false, swatches: false }));
  }

  function renderKeywords(stats) {
    const top = stats.keywords[0]?.count || 1;
    el['stats-keywords'].replaceChildren(...(stats.keywords.length
      ? stats.keywords.map((item, index) => listRow(item.name, photoCount(item.count), (item.count / top) * 100, {
        rank: index + 1, path: item.path, title: item.path ? `${item.path} / ${item.name}` : item.name,
      }))
      : [emptyRow()]));
    el['stats-keywords-note'].textContent = coverageNote(stats.keywordPhotos, stats.photos);
  }

  // Two rows whose background bar is the share of all the photos counted, with the percentage.
  function renderPair(list, first, second, total) {
    list.replaceChildren(...[first, second].map(([name, count]) => listRow(name, `${photoCount(count)} (${formatPercent(count / total)})`, (count / total) * 100)));
  }

  function renderGeolocation(stats) {
    renderPair(el['stats-geo'], [t('Geolocated'), stats.geolocatedPhotos], [t('Not geolocated'), stats.photos - stats.geolocatedPhotos], stats.photos);
  }

  // People and faces: only with face detection on (otherwise hidden, even if old face data exists in the catalogue).
  function renderFaces(stats) {
    const enabled = isFaceDetectionEnabled();
    el['stats-faces-section'].hidden = !enabled;
    if (!enabled) return;
    // The two counts are not comparable, so no background bar.
    el['stats-faces'].replaceChildren(
      listRow(t('People'), tp('{count} person', stats.persons, { count: formatNumber(stats.persons) }), 0),
      listRow(t('Faces'), tp('{count} face', stats.faces, { count: formatNumber(stats.faces) }), 0),
    );
    const top = stats.topPersons[0]?.count || 1;
    el['stats-top-persons'].replaceChildren(...(stats.topPersons.length
      ? stats.topPersons.map((item, index) => listRow(item.name, tp('{count} face', item.count, { count: formatNumber(item.count) }), (item.count / top) * 100, { rank: index + 1 }))
      : [emptyRow()]));
  }

  // Distribution over fixed ranges of the chosen shooting setting (the four are in the answer: switching does not call the backend).
  // Background bar: share of the fullest range; percentage: share of the photos that have the setting.
  function renderShooting(stats) {
    const distribution = stats.shooting[el['stats-param'].value];
    const top = Math.max(...distribution.bins.map(bin => bin.count), 1);
    el['stats-shooting'].replaceChildren(...distribution.bins.map(bin => listRow(
      bin.name,
      distribution.known > 0 ? `${photoCount(bin.count)} (${formatPercent(bin.count / distribution.known)})` : photoCount(bin.count),
      (bin.count / top) * 100,
    )));
    el['stats-shooting-note'].textContent = coverageNote(distribution.known, stats.photos);
  }

  // Content analysis (semantic search): analysed vs not, only while the feature is on.
  function renderAnalysis(stats) {
    const enabled = isSemanticEnabled() && stats.analysedPhotos !== null;
    el['stats-analysis-section'].hidden = !enabled;
    if (!enabled) return;
    renderPair(el['stats-analysis'], [t('Analysed'), stats.analysedPhotos], [t('Not analysed'), stats.photos - stats.analysedPhotos], stats.photos);
  }

  function render(stats) {
    lastStats = stats;
    if (stats.photos === 0) {
      syncGranularity(stats);
      showMessage(t('No photo matches these filters.'));
      return;
    }
    showMessage('');
    renderTotals(stats);
    renderChart(stats);
    renderExtensions(stats);
    renderFlags(stats);
    renderKeywords(stats);
    renderGeolocation(stats);
    renderFaces(stats);
    renderShooting(stats);
    renderAnalysis(stats);
  }

  async function load() {
    const id = ++requestId;
    lastStats = null;
    showMessage(t('Calculating statistics…'));
    const filter = {
      since: state.since,
      until: state.until,
      cameras: cameraPicker.values(),
      folders: folderPicker.values(),
      extensions: [...extensionsOf(formatPicker.values())].sort(),
      withAnalysis: isSemanticEnabled(),
    };
    try {
      const stats = await invoke('get_collection_stats', { filter });
      if (id === requestId) render(stats);
    } catch (error) {
      console.error('Statistics unavailable', error);
      if (id === requestId) showMessage(t('Statistics could not be loaded.'));
    }
  }

  // Cameras, root folders and formats present in the catalogue: read each time the window opens (the collection may have changed).
  async function loadOptions() {
    const id = ++optionsId;
    try {
      const options = await invoke('get_stats_filter_options');
      if (id !== optionsId) return;
      filterOptions = options;
      folderPicker.render(); // chips show the folder paths, known only now
    } catch (error) {
      console.error('Statistics filters unavailable', error);
    }
  }

  const isOpen = () => !el['stats-modal'].classList.contains('hidden');
  function open() {
    el['stats-modal'].classList.remove('hidden');
    el['stats-camera-input'].focus();
    loadOptions();
    load();
  }
  function close() {
    el['stats-modal'].classList.add('hidden');
    requestId += 1; // an answer that arrives after closing is ignored
    optionsId += 1;
  }

  el['btn-open-stats'].addEventListener('click', open);
  el['btn-close-stats'].addEventListener('click', close);
  el['stats-param'].addEventListener('change', () => {
    if (lastStats && lastStats.photos > 0) renderShooting(lastStats);
  });
  // Escape closes this window only: the capture phase runs before main.js's listeners, which would also close Settings underneath.
  // While a suggestion list is open, Escape belongs to it (it closes the list, see filter-suggest.js).
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !isOpen()) return;
    if (el['stats-modal'].querySelector('.keyword-suggestions:not([hidden])')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }, true);
  // Texts built here (lists, chart, chips, notes) are redone in the new language.
  onLanguageChange(() => {
    cameraPicker.render();
    folderPicker.render();
    formatPicker.render();
    syncPresetButtons();
    if (lastStats) render(lastStats);
  });

  // First opening: the default period (last 12 whole months).
  const initial = presetRange(DEFAULT_PRESET);
  setPeriod(initial.since, initial.until);
}
