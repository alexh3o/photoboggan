// Effacement et restauration de la géolocalisation (menu contextuel des photos, voir geolocation.rs) :
// - Effacer : confirmation, coordonnées sauvegardées par le backend puis retirées des fichiers (EXIF et XMP avec ExifTool, XMP seul sinon) ;
//   les photos dont le GPS de l'EXIF ne peut pas être effacé sont signalées et laissées telles quelles.
// - Restaurer : coordonnées sauvegardées réécrites.
// L'écriture passe par runLocked (verrou d'écriture des métadonnées, file des tâches à partir de 20 photos).

import { invoke } from '@tauri-apps/api/core';
import { t, tp } from './i18n.js';
import { confirmDialog } from './photo-actions.js';
import { runLocked, isWriteLocked } from './metadata-writes.js';

let host = { showToast: () => {}, onPhotosUpdated: () => {} };
let erasedIds = new Set(); // photos dont les coordonnées effacées sont sauvegardées

/** `showToast(message)` et `onPhotosUpdated(updates)` ([{ photo_id, gps_lat, gps_lon }]) viennent de main.js. */
export function initGeoTools(options) {
  host = { ...host, ...options };
  reloadErasedIds();
}

async function reloadErasedIds() {
  try {
    erasedIds = new Set(await invoke('get_erased_location_ids'));
  } catch (error) {
    console.error('Erased locations unavailable', error);
  }
}

export const hasGps = photo => Number.isFinite(photo?.gps_lat) && Number.isFinite(photo?.gps_lon);
export const hasErasedLocation = photo => erasedIds.has(photo?.id);

// Bilan affiché après l'écriture : photos traitées, refusées (GPS de l'EXIF non effaçable par le chemin actif) et en échec.
function report(result, error, restored) {
  if (!result) {
    host.showToast(t('Geolocation not written: {error}', { error: String(error ?? '') }));
    return;
  }
  const messages = [];
  if (result.updated.length) {
    messages.push(restored
      ? tp('Geolocation restored for {count} photo', result.updated.length)
      : tp('Geolocation erased for {count} photo', result.updated.length));
  }
  const internal = result.refused.filter(item => item.error === 'gps_in_exif_internal_writer').length;
  const sidecar = result.refused.length - internal;
  if (internal) messages.push(tp('{count} photo kept: its location is in the EXIF, enable ExifTool (Settings > Metadata) to erase it', internal));
  if (sidecar) messages.push(tp('{count} photo kept: the location stored inside this file format cannot be erased', sidecar));
  if (result.failed.length) {
    console.error('Geolocation write failures', result.failed);
    messages.push(tp('{count} photo failed: {error}', result.failed.length, { error: result.failed[0].error }));
  }
  if (result.cancelled) messages.push(tp('{count} photo not processed (task stopped)', result.cancelled));
  if (messages.length) host.showToast(messages.join(' · '));
}

async function run(command, photos, restored) {
  if (isWriteLocked()) {
    host.showToast(t('A metadata write is in progress: try again when it is finished.'));
    return;
  }
  await runLocked(command, { photoIds: photos.map(photo => photo.id) }, photos.length, async (result, error) => {
    await reloadErasedIds();
    if (result?.updated.length) host.onPhotosUpdated(result.updated);
    report(result, error, restored);
  });
}

/** Efface la géolocalisation des photos géolocalisées de `targets` (après confirmation). */
export async function eraseGeolocation(targets) {
  const photos = targets.filter(hasGps);
  if (!photos.length) return;
  const confirmed = await confirmDialog({
    title: t('Erase geolocation'),
    message: tp('Erase the location of {count} photo from its file? The coordinates are kept by photoboggan and can be restored from this menu.', photos.length),
    confirmLabel: t('Erase'),
    cancelLabel: t('Cancel'),
    focusCancel: true,
  });
  if (confirmed) await run('erase_geolocation', photos, false);
}

/** Réécrit les coordonnées sauvegardées des photos de `targets`. */
export async function restoreGeolocation(targets) {
  const photos = targets.filter(hasErasedLocation);
  if (photos.length) await run('restore_geolocation', photos, true);
}
