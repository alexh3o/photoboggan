// « Trouver le RAW » : fonctions pures qui préparent la recherche du RAW d'une image raster (le mode lui-même, la bannière et le retour sont dans
// main.js, section « TROUVER LE RAW »). Les critères cochés dans Paramètres > Divers > RAW (raw-settings.js) deviennent un état de filtres ordinaire,
// celui que savent appliquer les filtres de la barre latérale : la recherche est donc visible, retouchable et enregistrable comme n'importe quelle vue.
import './find-raw.css';
import { extractNameKey } from './raw-settings.js';
import { shootingStateFromPhoto } from './shooting-filters.js';

const lastSeparator = path => Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));

/** Dossier d'un chemin de fichier (mêmes séparateurs que le chemin d'origine, pour rester identique à ceux de l'arborescence). */
export function folderOf(path) {
  const index = lastSeparator(path);
  return index > 0 ? path.slice(0, index) : '';
}

/** Nom de fichier sans son extension. */
export function stemOf(path) {
  return path.slice(lastSeparator(path) + 1).replace(/\.[^.]*$/, '');
}

/**
 * Où chercher, toujours avec tous les sous-dossiers :
 * - parent : le dossier au-dessus de celui de l'image (`folder` null = toute la bibliothèque, l'image étant à la racine) ;
 * - current : le dossier de l'image ;
 * - children : les dossiers sous celui de l'image, sans les fichiers du dossier lui-même (`excludeDir`).
 */
export function searchScope(imagePath, scope) {
  const folder = folderOf(imagePath);
  if (scope === 'parent') return { folder: folderOf(folder) || null, excludeDir: null };
  if (scope === 'children') return { folder, excludeDir: folder };
  return { folder, excludeDir: null };
}

/**
 * État de filtres qui retrouve le RAW de `photo` selon les réglages. Il n'est produit que pour les critères dont l'image a la donnée (une image
 * exportée sans EXIF n'a pas de date ni d'appareil : sa recherche se fait sur ce qui reste). `used` liste les critères réellement appliqués,
 * `missing` ceux qui sont cochés mais impossibles faute de donnée.
 *   timeKey : date de prise de vue de l'image au format AAAAMMJJHHmmss (nombre), ou null.
 */
export function buildRawSearchState(photo, settings, timeKey) {
  const state = { formats: ['raw'] };
  const used = [];
  const missing = [];
  // Nom : avec un motif qui reconnaît le nom de l'image, sa clé devient un filtre « nom contient » ordinaire. Sans motif (ou s'il ne reconnaît rien),
  // la comparaison est tolérante dans les deux sens (le nom du RAW contient celui de l'image, ou l'inverse : « IMG_1234-edit.jpg » trouve
  // « IMG_1234.CR3 ») ; un filtre ne sait pas l'exprimer, elle est donc portée à part par `nameStem` (voir rawNameMatches).
  let nameStem = null;
  if (settings.name) {
    const stem = stemOf(photo.path);
    const key = extractNameKey(stem, settings.pattern);
    if (key !== stem) { state.filenames = [key]; used.push('name'); } else if (stem) { nameStem = stem; used.push('name'); } else missing.push('name');
  }
  if (settings.date) {
    if (timeKey) { state.date = String(timeKey); used.push('date'); } else missing.push('date');
  }
  const shooting = shootingStateFromPhoto(photo, { gear: settings.gear, shooting: settings.shooting });
  if (settings.gear) (shooting.gear ? used : missing).push('gear');
  if (settings.shooting) (shooting.shot ? used : missing).push('shooting');
  Object.assign(state, shooting);
  return { state, nameStem, used, missing };
}

/** Comparaison tolérante des noms (sans extension, casse ignorée) : l'un contient l'autre. Un nom de moins de 3 caractères ne compare rien. */
export function rawNameMatches(photo, nameStem) {
  if (!nameStem) return true;
  const raw = stemOf(photo.path).toLowerCase();
  const wanted = nameStem.toLowerCase();
  return raw.length >= 3 && (raw.includes(wanted) || wanted.includes(raw));
}
