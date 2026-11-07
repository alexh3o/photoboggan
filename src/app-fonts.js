// Interface fonts offered in Settings > Appearance. This list is the single place to register a font:
// the select is built from it and main.js applies the chosen stack to --app-font.
//
// To add a font (all four steps are required):
//   1. Put its .woff2 file(s) in src/assets/fonts/ (and its licence next to OFL.txt if different).
//   2. Declare it with @font-face at the top of src/styles.css (family name = `family` below).
//   3. Add an entry here (`id` is what is saved in localStorage, `family` must match the @font-face).
//   4. Add the id to the list in the "appFont" comment of src/defaults.jsonc.
// Nothing else: no locale key (font names are not translated), no Rust change.

/** `family` is null for the system font: the stack is then SYSTEM_STACK only. */
export const APP_FONTS = Object.freeze([
  { id: 'system', label: 'Tahoma / Segoe UI', family: null },
  { id: 'inter', label: 'Inter', family: 'Inter' },
  { id: 'manrope', label: 'Manrope', family: 'Manrope' },
  { id: 'geist', label: 'Geist', family: 'Geist' },
  { id: 'raleway', label: 'Raleway', family: 'Raleway' },
]);

// Fallbacks used after the chosen font (and alone for "system"): also what shows while a font file is missing.
const SYSTEM_STACK = "Tahoma, 'Segoe UI', Geneva, Verdana, sans-serif";

export const APP_FONT_IDS = APP_FONTS.map(font => font.id);

/** CSS font-family value for a font id (unknown id: the system stack). */
export function fontStack(id) {
  const font = APP_FONTS.find(entry => entry.id === id);
  return font && font.family ? `'${font.family}', ${SYSTEM_STACK}` : SYSTEM_STACK;
}
