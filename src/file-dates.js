// Tooltip of the "Date taken" row of the Info tab: the creation and modification dates of the active photo's file.
//
// The dates are read from the disk (get_file_dates in main.rs) only when the row is hovered, so nothing is read while browsing.
// The tooltip is the native `title` of the row: it is set once the dates are known, which takes far less time than the tooltip delay. An unknown date
// (creation date not provided by the file system, file not found) is shown as "-".
import { invoke } from '@tauri-apps/api/core';
import { getLanguage, labelWithColon } from './i18n.js';

let row = null; // <li> of the "Date taken" row
let activePath = null; // path of the photo shown in the Info tab, null when there is none
let token = 0; // a more recent hover or photo change makes the read in progress obsolete

const formatDate = millis => {
  if (!Number.isFinite(millis)) return '-';
  return new Date(millis).toLocaleString(getLanguage(), { dateStyle: 'medium', timeStyle: 'medium' });
};

/** Wires the tooltip on the row holding the `#exif-date` value. */
export function initFileDates() {
  row = document.getElementById('exif-date')?.closest('li') ?? null;
  if (!row) {
    console.error('Infobulle des dates du fichier : ligne « Date prise de vue » introuvable dans index.html');
    return;
  }
  row.addEventListener('mouseenter', () => {
    if (!activePath) return;
    const path = activePath;
    const current = ++token;
    invoke('get_file_dates', { path })
      .then(dates => {
        if (current !== token || path !== activePath) return;
        row.title = `${labelWithColon('File created')} ${formatDate(dates.created)}\n${labelWithColon('File modified')} ${formatDate(dates.modified)}`;
      })
      .catch(error => console.error('Lecture des dates du fichier impossible', error));
  });
}

/** Called when the Info tab shows another photo (`photo`: element of the displayed list, null when there is none). */
export function renderFileDates(photo) {
  activePath = photo?.path || null;
  token++;
  row?.removeAttribute('title'); // the dates of the previous photo must not stay in the tooltip
}
