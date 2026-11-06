// Duplicate search by file name (no file is read): photos whose names, reduced to a "key" by the user's pattern, contain one another. Pure functions;
// the task around them (candidates from the backend, progress, stop) is in main.js, section "DUPLICATES".
//
// Rules, as for "Find the RAW": the key of a name is the first group captured by the pattern (or the whole match), or the whole name without extension
// when there is no pattern or it does not match; keys are compared ignoring case; two keys match when one contains the other, in both directions
// ("IMG_1234-small" and "IMG_1234" match, "IMG_12345" and "IMG_12346" do not). A key shorter than the minimum length matches nothing.
//
// Speed: equal keys are one node (a Map), and a node is only compared with the nodes that contain one of its rarest 4-letter (or 3-letter) pieces, found
// in an index, instead of with every other name. The result is the same as comparing every pair.
import { extractNameKey } from './raw-settings.js';

/** Largest group kept: a pattern that is too permissive chains the whole library into one group. */
export const MAX_NAME_GROUP = 500;
const YIELD_EVERY = 1500;

const lastSeparator = path => Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
const stemOf = path => path.slice(lastSeparator(path) + 1).replace(/\.[^.]*$/, '');

const pause = () => new Promise(resolve => setTimeout(resolve, 0));

/** Pieces of `size` characters of a text. */
function* grams(text, size) {
  for (let at = 0; at + size <= text.length; at++) yield text.slice(at, at + size);
}

/**
 * candidates: [{ path, dateTaken, inScope, isRaw }]
 * options: { pattern, minLength, sameDate (also require the same shooting date), includeRawPairs (a RAW may match a non-RAW), maxGroup }
 * hooks: { shouldStop(), onProgress(percent 0-100) }
 * Returns a report shaped like the backend's: { groups: [[path]], scanned, skippedGroups, cancelled }.
 */
export async function findNameGroups(candidates, options, { shouldStop = () => false, onProgress = () => {} } = {}) {
  const { pattern, minLength, sameDate, includeRawPairs, maxGroup = MAX_NAME_GROUP } = options;

  // Nodes: photos that cannot be told apart for the comparison (same key, and same date / RAW side when those matter).
  const nodeByIdentity = new Map();
  const nodes = [];
  candidates.forEach((candidate, index) => {
    const key = extractNameKey(stemOf(candidate.path), pattern).toLowerCase();
    if (key.length < minLength) return;
    const date = sameDate ? candidate.dateTaken : '';
    if (sameDate && !date) return; // no shooting date: nothing to confirm the match with
    const side = includeRawPairs ? '' : candidate.isRaw ? 'raw' : 'plain';
    const identity = `${side}|${date}|${key}`;
    let id = nodeByIdentity.get(identity);
    if (id === undefined) {
      id = nodes.length;
      nodeByIdentity.set(identity, id);
      nodes.push({ text: key, date, side, photos: [] });
    }
    nodes[id].photos.push(index);
  });

  // Index of the pieces: piece -> nodes whose text holds it. The 3-letter index is only built when a 3-letter key exists.
  const indexes = new Map();
  const indexOf = size => {
    if (indexes.has(size)) return indexes.get(size);
    const index = new Map();
    nodes.forEach((node, id) => {
      for (const piece of new Set(grams(node.text, size))) {
        const list = index.get(piece);
        if (list) list.push(id); else index.set(piece, [id]);
      }
    });
    indexes.set(size, index);
    return index;
  };

  const parents = nodes.map((_, id) => id);
  const find = id => {
    while (parents[id] !== id) { parents[id] = parents[parents[id]]; id = parents[id]; }
    return id;
  };

  for (let id = 0; id < nodes.length; id++) {
    if (id % YIELD_EVERY === 0) {
      if (shouldStop()) return { groups: [], scanned: candidates.length, skippedGroups: 0, cancelled: true };
      onProgress(Math.round(90 * id / nodes.length));
      await pause();
    }
    const small = nodes[id];
    const size = Math.min(4, small.text.length);
    const index = indexOf(size);
    // The rarest piece of the key gives the shortest list of names that can contain it.
    let shortest = null;
    for (const piece of grams(small.text, size)) {
      const list = index.get(piece);
      if (!list) { shortest = null; break; }
      if (!shortest || list.length < shortest.length) shortest = list;
    }
    if (!shortest) continue;
    for (const otherId of shortest) {
      const other = nodes[otherId];
      // Only strictly longer texts: equal texts are the same node, or differ by RAW side / date and must stay apart.
      if (other.text.length <= small.text.length || !other.text.includes(small.text)) continue;
      if (sameDate && other.date !== small.date) continue;
      if (!includeRawPairs && other.side !== small.side) continue;
      const rootA = find(id);
      const rootB = find(otherId);
      if (rootA !== rootB) parents[rootA] = rootB;
    }
  }

  // Nodes to photos, one group per root; a group is kept when it has two photos or more and holds one photo of the scope.
  const members = new Map();
  nodes.forEach((node, id) => {
    const root = find(id);
    const list = members.get(root);
    if (list) list.push(...node.photos); else members.set(root, [...node.photos]);
  });
  const groups = [];
  let skippedGroups = 0;
  for (const photos of members.values()) {
    if (photos.length < 2 || !photos.some(index => candidates[index].inScope)) continue;
    if (photos.length > maxGroup) { skippedGroups += 1; continue; }
    groups.push(photos.map(index => candidates[index].path).sort());
  }
  groups.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  onProgress(100);
  return { groups, scanned: candidates.length, skippedGroups, cancelled: false };
}
