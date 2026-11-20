// Recipe engine of the batch rename (see batch-rename.js for the dialog, batch_rename.rs for what runs on the disk). Pure code: no DOM, no Tauri,
// so it can be tried with plain Node. It computes the new name (without extension) of each photo from a list of steps; the backend never replays
// a recipe, it only receives the names computed here.
//
// Steps (applied in order, each one on the result of the previous one):
//   { type: 'blank' }                                      erases the current name (the recipe then builds a new one); once, always first
//   { type: 'replace', search, replacement, occurrence }   occurrence: '' = all, otherwise the n-th one (1 = first), case-sensitive
//   { type: 'insert',  text, position, direction }         position: characters from the start / the end of the name (extension excluded)
//   { type: 'delete',  start, length, direction }
// Texts may hold variables: {filename} {date_taken(format;default)} {camera(default)} {lens(default)} {counter(digits;start)}
// {author(format;space;separator;default)}. Parameters are separated by ";", written without quotes. "\" escapes the next character
// (\; \) \} \{ \\). Dates use ISO 8601 symbols: YYYY MM DD hh mm ss (and "T", the ISO date / time separator, is kept as it is).

export const STEP_TYPES = ['blank', 'replace', 'insert', 'delete'];

/** Characters a file name cannot hold (same list as validate_new_name in main.rs). */
export const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)]);

/** Error of a recipe: a stable code (translated by the dialog) and its parameters. */
export class RecipeError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

let stepCounter = 0;
export function newStep(type) {
  stepCounter += 1;
  const base = { id: stepCounter, type };
  if (type === 'blank') return base;
  if (type === 'replace') return { ...base, search: '', replacement: '', occurrence: '' };
  if (type === 'insert') return { ...base, text: '', position: '0', direction: 'start' };
  return { ...base, start: '0', length: '1', direction: 'start' };
}

/** The "blank" step is unique and always first: the first one goes to the front, the others are dropped. */
export function normalizeSteps(steps) {
  const blank = steps.find(step => step.type === 'blank');
  return blank ? [blank, ...steps.filter(step => step.type !== 'blank')] : steps;
}

/** { stem, ext } of a file name: the extension is what follows the last dot, a leading dot does not start one (as in the backend). */
export function splitFileName(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? { stem: fileName.slice(0, dot), ext: fileName.slice(dot) } : { stem: fileName, ext: '' };
}

// ---------------------------------------------------------------------------
// Texts and variables
// ---------------------------------------------------------------------------

const unescapeText = raw => raw.replace(/\\([\s\S])/g, '$1');
const sanitize = value => value.replace(FORBIDDEN, '');
const codePoints = text => Array.from(text);

function parseInteger(raw, { min, fallback, code, params = {} }) {
  const text = unescapeText(raw).trim();
  if (text === '') {
    if (fallback === undefined) throw new RecipeError(code, params);
    return fallback;
  }
  if (!/^\d+$/.test(text) || Number(text) < min) throw new RecipeError(code, params);
  return Number(text);
}

// Parses a text with variables into [{ literal }, { name, params }]. `\x` is the character x; a variable is {name} or {name(param;param)}.
const templateCache = new Map();
export function parseTemplate(text) {
  const cached = templateCache.get(text);
  if (cached) return cached;
  const parts = [];
  let literal = '';
  const flush = () => { if (literal) { parts.push({ literal }); literal = ''; } };
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      literal += index + 1 < text.length ? text[index + 1] : '\\';
      index += 2;
      continue;
    }
    if (character !== '{') {
      literal += character;
      index += 1;
      continue;
    }
    const name = /^[A-Za-z_]+/.exec(text.slice(index + 1))?.[0] ?? '';
    index += 1 + name.length;
    const params = [];
    if (text[index] === '(') {
      index += 1;
      let current = '';
      for (;;) {
        if (index >= text.length) throw new RecipeError('syntax', { text });
        const next = text[index];
        if (next === '\\' && index + 1 < text.length) { current += next + text[index + 1]; index += 2; continue; }
        if (next === ';') { params.push(current); current = ''; index += 1; continue; }
        if (next === ')') { params.push(current); index += 1; break; }
        current += next;
        index += 1;
      }
    }
    if (text[index] !== '}' || !name) throw new RecipeError('syntax', { text });
    index += 1;
    if (!VARIABLES[name]) throw new RecipeError('unknown_variable', { name });
    flush();
    parts.push({ name, params });
  }
  flush();
  if (templateCache.size > 500) templateCache.clear();
  templateCache.set(text, parts);
  return parts;
}

// --- Dates (ISO 8601 symbols) ---------------------------------------------

/** { year, month, day, hour, minute, second } read from the EXIF date text of a photo, or null (absent or unreadable). */
export function parseDate(text) {
  const match = /(\d{4})\D?(\d{2})\D?(\d{2})(?:\D+(\d{2})\D?(\d{2})\D?(\d{2}))?/.exec(String(text || ''));
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(value => (value === undefined ? 0 : Number(value)));
  if (!year || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return { year, month, day, hour, minute, second };
}

const DATE_SYMBOLS = { Y: 'year', y: 'year', M: 'month', D: 'day', d: 'day', h: 'hour', H: 'hour', m: 'minute', s: 'second', S: 'second' };

/** Formats `date` with a format written with ISO 8601 symbols (Y M D h m s; a doubled symbol gives the leading zero; YY / YYY: last digits of the year). */
export function formatDate(format, date) {
  let output = '';
  let index = 0;
  while (index < format.length) {
    const character = format[index];
    if (character === '\\') {
      output += index + 1 < format.length ? format[index + 1] : '\\';
      index += 2;
      continue;
    }
    if (!/[A-Za-z]/.test(character)) {
      output += character;
      index += 1;
      continue;
    }
    if (character === 'T') { // ISO 8601 separator between the date and the time
      output += 'T';
      index += 1;
      continue;
    }
    let run = 1;
    while (format[index + run] === character) run += 1;
    index += run;
    const field = DATE_SYMBOLS[character];
    if (!field) throw new RecipeError('date_symbol', { symbol: character });
    const value = date[field];
    if (field === 'year') {
      if (run > 4) throw new RecipeError('date_symbol', { symbol: character.repeat(run) });
      output += String(value).padStart(4, '0').slice(-run);
    } else {
      if (run > 2) throw new RecipeError('date_symbol', { symbol: character.repeat(run) });
      output += run === 2 ? String(value).padStart(2, '0') : String(value);
    }
  }
  return output;
}

const SAMPLE_DATE = { year: 2026, month: 1, day: 2, hour: 3, minute: 4, second: 5 };

// --- Variables ---------------------------------------------------------------
// `check(params, count)` validates the parameters once (RecipeError) and returns what `value` needs; `value(config, context)` is the text for a photo.

const noParams = (name, params) => { if (params.length) throw new RecipeError('too_many_params', { name }); return null; };
const defaultOf = raw => sanitize(unescapeText(raw ?? ''));
const SPACE_CHARACTERS = [' ', '', '_', '-', '.'];
const SEPARATOR_CHARACTERS = ['', ' ', '_', '-', '.', '+', '&'];

const VARIABLES = {
  filename: {
    check: (params) => noParams('filename', params),
    value: (config, context) => sanitize(context.stem),
  },
  date_taken: {
    check: (params) => {
      if (params.length > 2) throw new RecipeError('too_many_params', { name: 'date_taken' });
      const format = params[0] ?? '';
      if (format === '') throw new RecipeError('format_required', { name: 'date_taken' });
      formatDate(format, SAMPLE_DATE); // syntax of the format
      return { format, fallback: defaultOf(params[1]) };
    },
    value: (config, context) => {
      const date = parseDate(context.photo.date_taken);
      return date ? sanitize(formatDate(config.format, date)) : config.fallback;
    },
  },
  camera: {
    check: (params) => {
      if (params.length > 1) throw new RecipeError('too_many_params', { name: 'camera' });
      return { fallback: defaultOf(params[0]) };
    },
    value: (config, context) => sanitize(String(context.photo.camera_model || '').trim()) || config.fallback,
  },
  lens: {
    check: (params) => {
      if (params.length > 1) throw new RecipeError('too_many_params', { name: 'lens' });
      return { fallback: defaultOf(params[0]) };
    },
    value: (config, context) => sanitize(String(context.photo.lens_model || '').trim()) || config.fallback,
  },
  counter: {
    check: (params, count) => {
      if (params.length > 2) throw new RecipeError('too_many_params', { name: 'counter' });
      const digits = parseInteger(params[0] ?? '', { min: 0, fallback: 0, code: 'counter_param', params: { name: 'digits' } });
      const start = parseInteger(params[1] ?? '', { min: 0, fallback: 1, code: 'counter_param', params: { name: 'start' } });
      // The format cannot hold more photos than it has digits for: the recipe is refused (nothing is numbered twice or cut).
      if (digits > 0 && count > 0 && String(start + count - 1).length > digits) throw new RecipeError('counter_overflow', { digits, max: start + count - 1 });
      return { digits, start };
    },
    value: (config, context) => String(config.start + context.index).padStart(config.digits, '0'),
  },
  author: {
    check: (params) => {
      if (params.length > 4) throw new RecipeError('too_many_params', { name: 'author' });
      const format = unescapeText(params[0] ?? '') || 'initials';
      if (format !== 'initials' && format !== 'full') throw new RecipeError('author_param', { name: 'format', values: 'initials, full' });
      const space = unescapeText(params[1] ?? '');
      if (!SPACE_CHARACTERS.includes(space)) throw new RecipeError('author_param', { name: 'space', values: SPACE_CHARACTERS.map(value => `"${value}"`).join(' ') });
      const separator = unescapeText(params[2] ?? '');
      if (!SEPARATOR_CHARACTERS.includes(separator)) throw new RecipeError('author_param', { name: 'separator', values: SEPARATOR_CHARACTERS.map(value => `"${value}"`).join(' ') });
      return { format, space, separator, fallback: defaultOf(params[3]) };
    },
    value: (config, context) => {
      const authors = String(context.photo.author || '').split(';').map(name => name.trim()).filter(Boolean);
      const names = authors.map(author => (config.format === 'full' ? author.replace(/\s+/g, config.space) : initialsOf(author)));
      return sanitize(names.join(config.separator)) || config.fallback;
    },
  },
};

/** "Jean-Pierre Dupont" gives "JpD": the first letter of each word, in capitals, and of each following part of a compound first name, in lower case. */
function initialsOf(author) {
  const first = text => codePoints(text)[0] ?? '';
  return author.split(/\s+/).filter(Boolean).map(word => word.split('-').filter(Boolean).map((part, rank) => (rank === 0 ? first(part).toLocaleUpperCase() : first(part).toLocaleLowerCase())).join('')).join('');
}

// Checks the variables of a text once (syntax, names, parameters) and keeps their configuration.
const configCache = new WeakMap();
function compile(text, count) {
  const parts = parseTemplate(text);
  const cached = configCache.get(parts);
  if (cached && cached.count === count) return cached.configs;
  const configs = parts.map(part => (part.name ? VARIABLES[part.name].check(part.params, count) : null));
  configCache.set(parts, { count, configs });
  return configs;
}

/** The text with its variables replaced for one photo (`context`: { stem, photo, index, count }). */
function expand(text, context) {
  const parts = parseTemplate(text);
  const configs = compile(text, context.count);
  return parts.map((part, rank) => (part.name ? VARIABLES[part.name].value(configs[rank], context) : part.literal)).join('');
}

/** Characters of the literal parts of `text` (outside the variables) that a file name cannot hold. */
function forbiddenLiterals(text) {
  return [...new Set(parseTemplate(text).flatMap(part => (part.literal ? part.literal.match(FORBIDDEN) ?? [] : [])))];
}

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

function checkDirection(raw) {
  const value = String(raw ?? '').trim();
  if (value !== '' && value !== 'start' && value !== 'end') throw new RecipeError('direction');
  return value === 'end' ? 'end' : 'start';
}

function checkStep(step, count) {
  if (step.type === 'blank') {
    // Nothing to check: the name is erased.
  } else if (step.type === 'replace') {
    if (step.search === '') throw new RecipeError('empty_search');
    compile(step.search, count);
    compile(step.replacement, count);
    const bad = forbiddenLiterals(step.replacement);
    if (bad.length) throw new RecipeError('forbidden_chars', { chars: bad.join(' ') });
    const occurrence = String(step.occurrence ?? '').trim();
    if (occurrence !== '' && !(/^\d+$/.test(occurrence) && Number(occurrence) >= 1)) throw new RecipeError('occurrence');
  } else if (step.type === 'insert') {
    compile(step.text, count);
    const bad = forbiddenLiterals(step.text);
    if (bad.length) throw new RecipeError('forbidden_chars', { chars: bad.join(' ') });
    parseInteger(step.position, { min: 0, fallback: 0, code: 'position' });
    checkDirection(step.direction);
  } else if (step.type === 'delete') {
    parseInteger(step.start, { min: 0, fallback: 0, code: 'position' });
    parseInteger(step.length, { min: 1, code: 'length' });
    checkDirection(step.direction);
  } else {
    throw new RecipeError('unknown_step');
  }
}

/** Mistakes of the recipe itself, before any photo: [{ step: index, code, params }]. A recipe with mistakes is never applied. `count`: photos to rename. */
export function validateRecipe(steps, count) {
  const errors = [];
  steps.forEach((step, index) => {
    try {
      if (step.type === 'blank' && steps.findIndex(other => other.type === 'blank') !== index) throw new RecipeError('blank_once');
      checkStep(step, count);
    } catch (error) {
      if (!(error instanceof RecipeError)) throw error;
      errors.push({ step: index, code: error.code, params: error.params });
    }
  });
  return errors;
}

function applyStep(step, name, context) {
  if (step.type === 'blank') return '';
  if (step.type === 'replace') {
    const search = expand(step.search, context);
    if (search === '') throw new RecipeError('empty_search');
    const replacement = expand(step.replacement, context);
    const occurrence = String(step.occurrence ?? '').trim();
    if (occurrence === '') return name.split(search).join(replacement);
    let from = 0;
    for (let found = 0; ; ) {
      const at = name.indexOf(search, from);
      if (at < 0) return name; // fewer occurrences than asked: nothing to replace
      found += 1;
      if (found === Number(occurrence)) return name.slice(0, at) + replacement + name.slice(at + search.length);
      from = at + search.length;
    }
  }
  const characters = codePoints(name);
  const direction = checkDirection(step.direction);
  if (step.type === 'insert') {
    const position = parseInteger(step.position, { min: 0, fallback: 0, code: 'position' });
    const at = direction === 'end' ? Math.max(0, characters.length - position) : Math.min(position, characters.length);
    characters.splice(at, 0, expand(step.text, context));
    return characters.join('');
  }
  const start = parseInteger(step.start, { min: 0, fallback: 0, code: 'position' });
  const length = parseInteger(step.length, { min: 1, code: 'length' });
  // At least one character must be left, and the part to delete must be inside the name.
  if (length > characters.length - 1 || start + length > characters.length) {
    throw new RecipeError('delete_range', { start, length, size: characters.length });
  }
  const at = direction === 'end' ? characters.length - start - length : start;
  characters.splice(at, length);
  return characters.join('');
}

/**
 * New name (without extension) of one photo: { name } or { error: { code, params, step } } (this photo is left alone).
 * `context`: { stem: current name without extension, photo, index: rank among the renamed photos, count: how many }.
 */
export function evaluate(steps, context) {
  let name = context.stem;
  for (let index = 0; index < steps.length; index += 1) {
    try {
      name = applyStep(steps[index], name, context);
    } catch (error) {
      if (!(error instanceof RecipeError)) throw error;
      return { error: { code: error.code, params: error.params, step: index } };
    }
  }
  name = name.trim();
  if (!name) return { error: { code: 'empty_name', params: {}, step: -1 } };
  const bad = [...new Set(name.match(FORBIDDEN) ?? [])];
  if (bad.length) return { error: { code: 'forbidden_chars', params: { chars: bad.join(' ') }, step: -1 } };
  if (name.endsWith('.')) return { error: { code: 'ends_with_dot', params: {}, step: -1 } };
  if (RESERVED.has(name.split('.')[0].trimEnd().toUpperCase())) return { error: { code: 'reserved_name', params: { name }, step: -1 } };
  return { name };
}
