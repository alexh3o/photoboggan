// Date filter of the Filters block (date taken, from the EXIF date): text field (YYYYMMDD or YYYYMMDD-YYYYMMDD), calendar pop-up (single day or
// range) and clear button, plus the helpers that turn the date of a photo into a comparable key (YYYYMMDDHHmmss, as a number).
// The state (`dateFilter`) lives here; main.js reads it through the live binding and changes it with `setDateFilter`.
import { t, getLanguage } from './i18n.js';

// What main.js gives through initDateFilter: `applyPhotoFilters()` (filters the list again) and `getPhotos()` (every loaded photo, to open the
// calendar on the latest day of the collection).
let host = null;

export let dateFilter = null; // { from, to } as numbers YYYYMMDDHHmmss, or null = no filter
export const dateFilterInput = document.getElementById('date-filter-input');
const dateFilterClear = document.getElementById('date-filter-clear');
const dateFilterCalendar = document.getElementById('date-filter-calendar');
const dateFilterError = document.getElementById('date-filter-error');

export function setDateFilter(next) {
  dateFilter = next;
}

// Extracts the date and time from an EXIF text whatever the separator (« 2026:08:12 14:30:00 », « 2026-08-12 14:30:00 »…).
// Returns a number YYYYMMDDHHmmss (time at 00:00:00 when missing), or null.
function extractTimeKey(text) {
  const match = /(\d{4})\D?(\d{2})\D?(\d{2})(?:\D+(\d{2})\D?(\d{2})(?:\D?(\d{2}))?)?/.exec(String(text || ''));
  if (!match) return null;
  if (Number(match[1] + match[2] + match[3]) < 10000101) return null; // ignores empty dates such as 0000:00:00
  return Number(`${match[1]}${match[2]}${match[3]}${match[4] || '00'}${match[5] || '00'}${match[6] || '00'}`);
}

export function photoTimeKey(photo) {
  if (photo.timeKey === undefined) photo.timeKey = extractTimeKey(photo.date_taken);
  return photo.timeKey;
}

// Day the photo was taken as YYYYMMDD, or null.
export function photoDateKey(photo) {
  const key = photoTimeKey(photo);
  return key === null ? null : Math.floor(key / 1000000);
}

// The filter covers the first to the last instant of the typed period, bounds included.
export function matchesDateFilter(photo) {
  if (!dateFilter) return true;
  const key = photoTimeKey(photo);
  return key !== null && key >= dateFilter.from && key <= dateFilter.to;
}

export function isValidDateKey(key) {
  const year = Math.floor(key / 10000);
  const month = Math.floor(key / 100) % 100;
  const day = key % 100;
  const date = new Date(year, month - 1, day);
  return year >= 1000 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// A token YYYY, YYYYMM, YYYYMMDD, YYYYMMDDHH, YYYYMMDDHHmm or YYYYMMDDHHmmss: returns the first and the last instant
// (YYYYMMDDHHmmss) of the period. Missing parts are the start (01, 00) or the end (12, 31, 23, 59, 59).
function parseDateToken(token) {
  const year = Number(token.slice(0, 4));
  const month = token.length >= 6 ? Number(token.slice(4, 6)) : null;
  const day = token.length >= 8 ? Number(token.slice(6, 8)) : null;
  const hour = token.length >= 10 ? Number(token.slice(8, 10)) : null;
  const minute = token.length >= 12 ? Number(token.slice(10, 12)) : null;
  const second = token.length >= 14 ? Number(token.slice(12, 14)) : null;
  if (year < 1000) return null;
  if (month !== null && (month < 1 || month > 12)) return null;
  if (day !== null && !isValidDateKey(year * 10000 + month * 100 + day)) return null;
  if (hour !== null && hour > 23) return null;
  if (minute !== null && minute > 59) return null;
  if (second !== null && second > 59) return null;
  const pad = value => String(value).padStart(2, '0');
  const build = (m, d, h, mi, s) => Number(`${year}${pad(m)}${pad(d)}${pad(h)}${pad(mi)}${pad(s)}`);
  return {
    start: build(month ?? 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0),
    end: build(month ?? 12, day ?? 31, hour ?? 23, minute ?? 59, second ?? 59),
  };
}

export function parseDateFilter(text) {
  const compact = text.replace(/\s+/g, '');
  if (!compact) return { filter: null };
  const token = '(\\d{4}|\\d{6}|\\d{8}|\\d{10}|\\d{12}|\\d{14})';
  const match = new RegExp(`^${token}(?:-${token})?$`).exec(compact);
  if (!match) return { error: t('Date format error') };
  const first = parseDateToken(match[1]);
  const second = match[2] ? parseDateToken(match[2]) : first;
  if (!first || !second) return { error: t('Invalid date') };
  if (!match[2]) return { filter: { from: first.start, to: first.end } };
  // Range: start of the first token → end of the second. If it is reversed, the two tokens are swapped.
  const [begin, finish] = first.start <= second.end ? [first, second] : [second, first];
  return { filter: { from: begin.start, to: finish.end } };
}

export function updateDateFilterUI(error = '') {
  dateFilterClear.classList.toggle('has-value', dateFilterInput.value.trim() !== '');
  dateFilterInput.classList.toggle('invalid', Boolean(error));
  dateFilterInput.setAttribute('aria-invalid', error ? 'true' : 'false');
  dateFilterError.textContent = error;
}

// Applies the content of the field: empty = no filter; incomplete or invalid input = previous filter kept.
function setDateFilterFromInput() {
  const result = parseDateFilter(dateFilterInput.value);
  updateDateFilterUI(result.error);
  if (result.error) return;
  const next = result.filter;
  const unchanged = next === dateFilter || (next && dateFilter && next.from === dateFilter.from && next.to === dateFilter.to);
  if (unchanged) return;
  dateFilter = next;
  host.applyPhotoFilters();
}

// --- Calendar (single date or range) ---
// The element is created here; its label and its place in the page come with initDateFilter (same moment as before the move).
const datePicker = document.createElement('div');
datePicker.className = 'date-picker';
datePicker.setAttribute('role', 'dialog');
datePicker.style.display = 'none';
// Initials of the days (week starting on Monday) and months, in the current language: 1 January 2024 is a Monday.
const weekdayLabels = () => Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(getLanguage(), { weekday: 'narrow' }).format(new Date(2024, 0, 1 + day)));
const pickerMonthFormatter = () => new Intl.DateTimeFormat(getLanguage(), { month: 'long', year: 'numeric' });
let pickerYear = 0;
let pickerMonth = 0; // 0-11
let pickStart = null;
let pickEnd = null;
let pickAwaitingEnd = false;

export function isDatePickerOpen() {
  return datePicker.style.display !== 'none';
}

export function closeDatePicker() {
  datePicker.style.display = 'none';
}

function todayDateKey() {
  const now = new Date();
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

function latestPhotoDateKey() {
  let latest = null;
  for (const photo of host.getPhotos()) {
    const key = photoDateKey(photo);
    if (key !== null && (latest === null || key > latest)) latest = key;
  }
  return latest;
}

function positionDatePicker() {
  const rect = dateFilterCalendar.getBoundingClientRect();
  const width = datePicker.offsetWidth;
  const height = datePicker.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  datePicker.style.left = `${left}px`;
  datePicker.style.top = `${top}px`;
}

function renderDatePicker() {
  const first = new Date(pickerYear, pickerMonth, 1);
  const offset = (first.getDay() + 6) % 7; // the week starts on Monday
  const daysInMonth = new Date(pickerYear, pickerMonth + 1, 0).getDate();
  const today = todayDateKey();
  const low = pickStart === null ? null : Math.min(pickStart, pickEnd ?? pickStart);
  const high = pickStart === null ? null : Math.max(pickStart, pickEnd ?? pickStart);
  let cells = weekdayLabels().map(label => `<span class="date-picker-weekday">${label}</span>`).join('');
  for (let i = 0; i < offset; i++) cells += '<span></span>';
  for (let day = 1; day <= daysInMonth; day++) {
    const key = pickerYear * 10000 + (pickerMonth + 1) * 100 + day;
    const classes = ['date-picker-day'];
    if (key === today) classes.push('today');
    if (low !== null && key > low && key < high) classes.push('in-range');
    if (key === low || key === high) classes.push('selected');
    cells += `<button type="button" class="${classes.join(' ')}" data-key="${key}">${day}</button>`;
  }
  datePicker.innerHTML = `
    <div class="date-picker-header">
      <button type="button" data-nav="-12" title="${t('Previous year')}" aria-label="${t('Previous year')}">«</button>
      <button type="button" data-nav="-1" title="${t('Previous month')}" aria-label="${t('Previous month')}">‹</button>
      <span class="date-picker-title">${pickerMonthFormatter().format(first)}</span>
      <button type="button" data-nav="1" title="${t('Next month')}" aria-label="${t('Next month')}">›</button>
      <button type="button" data-nav="12" title="${t('Next year')}" aria-label="${t('Next year')}">»</button>
    </div>
    <div class="date-picker-grid">${cells}</div>
    <div class="date-picker-hint">${t('Click a day, then a second one for a range.')}</div>`;
}

function openDatePicker() {
  const fromDay = dateFilter ? Math.floor(dateFilter.from / 1000000) : null;
  const toDay = dateFilter ? Math.floor(dateFilter.to / 1000000) : null;
  const key = fromDay ?? latestPhotoDateKey() ?? todayDateKey();
  pickerYear = Math.floor(key / 10000);
  pickerMonth = (Math.floor(key / 100) % 100) - 1;
  pickStart = fromDay;
  pickEnd = fromDay !== null && toDay !== fromDay ? toDay : null;
  pickAwaitingEnd = false;
  datePicker.style.display = 'block';
  renderDatePicker();
  positionDatePicker();
}

function applyPickerSelection() {
  const low = Math.min(pickStart, pickEnd ?? pickStart);
  const high = Math.max(pickStart, pickEnd ?? pickStart);
  dateFilterInput.value = low === high ? String(low) : `${low}-${high}`;
  setDateFilterFromInput();
}

// 1st click: single day (filter applied at once). 2nd click: range, or the same day to confirm the single day.
function pickDate(key) {
  if (!pickAwaitingEnd) {
    pickStart = key;
    pickEnd = null;
    pickAwaitingEnd = true;
    applyPickerSelection();
    renderDatePicker();
    return;
  }
  pickAwaitingEnd = false;
  if (key !== pickStart) {
    pickEnd = key;
    applyPickerSelection();
  }
  closeDatePicker();
}

// Reusable date filter control (text input YYYYMMDD / YYYYMMDD-YYYYMMDD, calendar pop-up, clear button).
// Used by the main Filters sidebar (`initDateFilter`) and by the Import view (`import-view.js`).
const datePickerInstances = new Set();

export function createDateFilterControl({ input, calendarBtn, clearBtn, errorEl, getReferenceDateKey, onChange }) {
  let currentFilter = null;
  const picker = document.createElement('div');
  picker.className = 'date-picker';
  picker.setAttribute('role', 'dialog');
  picker.style.display = 'none';
  picker.setAttribute('aria-label', t('Choose a date or a range'));
  document.body.appendChild(picker);

  let pYear = 0;
  let pMonth = 0;
  let pStart = null;
  let pEnd = null;
  let pAwaitingEnd = false;

  const isOpen = () => picker.style.display !== 'none';
  const close = () => { picker.style.display = 'none'; };

  const updateUI = (error = '') => {
    clearBtn.classList.toggle('has-value', input.value.trim() !== '');
    input.classList.toggle('invalid', Boolean(error));
    input.setAttribute('aria-invalid', error ? 'true' : 'false');
    errorEl.textContent = error;
  };

  const applyFromInput = () => {
    const result = parseDateFilter(input.value);
    updateUI(result.error);
    if (result.error) return;
    const next = result.filter;
    const unchanged = next === currentFilter || (next && currentFilter && next.from === currentFilter.from && next.to === currentFilter.to);
    if (unchanged) return;
    currentFilter = next;
    onChange?.(currentFilter);
  };

  const position = () => {
    const rect = calendarBtn.getBoundingClientRect();
    const width = picker.offsetWidth;
    const height = picker.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
  };

  const render = () => {
    const first = new Date(pYear, pMonth, 1);
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(pYear, pMonth + 1, 0).getDate();
    const today = todayDateKey();
    const low = pStart === null ? null : Math.min(pStart, pEnd ?? pStart);
    const high = pStart === null ? null : Math.max(pStart, pEnd ?? pStart);
    let cells = weekdayLabels().map(label => `<span class="date-picker-weekday">${label}</span>`).join('');
    for (let i = 0; i < offset; i++) cells += '<span></span>';
    for (let day = 1; day <= daysInMonth; day++) {
      const key = pYear * 10000 + (pMonth + 1) * 100 + day;
      const classes = ['date-picker-day'];
      if (key === today) classes.push('today');
      if (low !== null && key > low && key < high) classes.push('in-range');
      if (key === low || key === high) classes.push('selected');
      cells += `<button type="button" class="${classes.join(' ')}" data-key="${key}">${day}</button>`;
    }
    picker.innerHTML = `
      <div class="date-picker-header">
        <button type="button" data-nav="-12" title="${t('Previous year')}" aria-label="${t('Previous year')}">«</button>
        <button type="button" data-nav="-1" title="${t('Previous month')}" aria-label="${t('Previous month')}">‹</button>
        <span class="date-picker-title">${pickerMonthFormatter().format(first)}</span>
        <button type="button" data-nav="1" title="${t('Next month')}" aria-label="${t('Next month')}">›</button>
        <button type="button" data-nav="12" title="${t('Next year')}" aria-label="${t('Next year')}">»</button>
      </div>
      <div class="date-picker-grid">${cells}</div>
      <div class="date-picker-hint">${t('Click a day, then a second one for a range.')}</div>`;
  };

  const open = () => {
    const fromDay = currentFilter ? Math.floor(currentFilter.from / 1000000) : null;
    const toDay = currentFilter ? Math.floor(currentFilter.to / 1000000) : null;
    const key = fromDay ?? getReferenceDateKey?.() ?? todayDateKey();
    pYear = Math.floor(key / 10000);
    pMonth = (Math.floor(key / 100) % 100) - 1;
    pStart = fromDay;
    pEnd = fromDay !== null && toDay !== fromDay ? toDay : null;
    pAwaitingEnd = false;
    picker.style.display = 'block';
    render();
    position();
  };

  const pickDay = key => {
    if (!pAwaitingEnd) {
      pStart = key;
      pEnd = null;
      pAwaitingEnd = true;
      const low = Math.min(pStart, pEnd ?? pStart);
      const high = Math.max(pStart, pEnd ?? pStart);
      input.value = low === high ? String(low) : `${low}-${high}`;
      applyFromInput();
      render();
      return;
    }
    pAwaitingEnd = false;
    if (key !== pStart) {
      pEnd = key;
      const low = Math.min(pStart, pEnd ?? pStart);
      const high = Math.max(pStart, pEnd ?? pStart);
      input.value = low === high ? String(low) : `${low}-${high}`;
      applyFromInput();
    }
    close();
  };

  input.addEventListener('input', () => { close(); applyFromInput(); });
  clearBtn.addEventListener('click', () => { input.value = ''; close(); applyFromInput(); });
  picker.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button) return;
    if (button.dataset.nav) {
      const shifted = new Date(pYear, pMonth + Number(button.dataset.nav), 1);
      pYear = shifted.getFullYear();
      pMonth = shifted.getMonth();
      render();
      position();
    } else if (button.dataset.key) {
      pickDay(Number(button.dataset.key));
    }
  });
  calendarBtn.addEventListener('click', () => { if (isOpen()) close(); else open(); });
  document.addEventListener('pointerdown', event => {
    if (!isOpen()) return;
    const target = event.target;
    if (target instanceof Node && (picker.contains(target) || calendarBtn.contains(target))) return;
    close();
  }, true);
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && isOpen()) close(); });
  window.addEventListener('resize', close);

  const instance = {
    getFilter: () => currentFilter,
    setValue(text) {
      input.value = text;
      close();
      applyFromInput();
    },
    clear() {
      input.value = '';
      close();
      applyFromInput();
    },
    refreshLanguage() {
      picker.setAttribute('aria-label', t('Choose a date or a range'));
      if (isOpen()) { render(); position(); }
    },
    close,
  };
  datePickerInstances.add(instance);
  return instance;
}

// The language changed: the label of the pop-up follows, and an open calendar is drawn again (names of the days and of the month).
export function refreshDatePickerLanguage() {
  datePicker.setAttribute('aria-label', t('Choose a date or a range'));
  if (isDatePickerOpen()) {
    renderDatePicker();
    positionDatePicker();
  }
  for (const inst of datePickerInstances) inst.refreshLanguage();
}

// `api`: { applyPhotoFilters, getPhotos }. Called by main.js at the place where this code used to be, so that the listeners keep their order
// among the others (Escape, pointerdown, resize) and the calendar keeps its place at the end of the body.
export function initDateFilter(api) {
  host = api;
  datePicker.setAttribute('aria-label', t('Choose a date or a range'));
  document.body.appendChild(datePicker);

  dateFilterInput.addEventListener('input', () => {
    closeDatePicker();
    setDateFilterFromInput();
  });

  dateFilterClear.addEventListener('click', () => {
    dateFilterInput.value = '';
    closeDatePicker();
    setDateFilterFromInput();
  });

  datePicker.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button) return;
    if (button.dataset.nav) {
      const shifted = new Date(pickerYear, pickerMonth + Number(button.dataset.nav), 1);
      pickerYear = shifted.getFullYear();
      pickerMonth = shifted.getMonth();
      renderDatePicker();
      positionDatePicker();
    } else if (button.dataset.key) {
      pickDate(Number(button.dataset.key));
    }
  });

  dateFilterCalendar.addEventListener('click', () => {
    if (isDatePickerOpen()) closeDatePicker();
    else openDatePicker();
  });

  document.addEventListener('pointerdown', event => {
    if (!isDatePickerOpen()) return;
    const target = event.target;
    if (target instanceof Node && (datePicker.contains(target) || dateFilterCalendar.contains(target))) return;
    closeDatePicker();
  }, true);
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isDatePickerOpen()) closeDatePicker();
  });
  window.addEventListener('resize', closeDatePicker);
}
