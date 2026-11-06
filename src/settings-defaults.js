// Default settings of a new installation, read from defaults.jsonc (the single place to edit them), and helpers
// that return the value saved in localStorage when it is valid, the default otherwise.
import rawDefaults from './defaults.jsonc?raw';

// defaults.jsonc allows full-line // comments only: drop those lines (src-tauri/src/face_detect.rs does the same).
export const DEFAULTS = Object.freeze(JSON.parse(
  rawDefaults.split(/\r?\n/).filter(line => !line.trimStart().startsWith('//')).join('\n'),
));

/** Raw saved string, or null (nothing saved, or storage unavailable). */
export function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** Boolean saved as "true" / "false"; anything else gives the default. */
export function readBool(key) {
  const stored = readStored(key);
  return stored === 'true' ? true : stored === 'false' ? false : DEFAULTS[key];
}

/** Saved string when it is one of `allowed`, the default otherwise. */
export function readChoice(key, allowed) {
  const stored = readStored(key);
  return allowed.includes(stored) ? stored : DEFAULTS[key];
}

/** Saved number (finite, within [min, max]), the default otherwise. */
export function readNumber(key, min = -Infinity, max = Infinity) {
  const stored = readStored(key);
  const value = stored === null || stored.trim() === '' ? NaN : Number(stored);
  return Number.isFinite(value) && value >= min && value <= max ? value : DEFAULTS[key];
}
