// Sticky folders of the folder tree: which rows stay pinned at the top while the tree is scrolled. Pure code: no state, no DOM.
// The layer that draws the pinned rows (copies of the real rows, see "STICKY FOLDERS" in main.js) calls it on every scroll frame.

// Which rows are pinned for a scroll position. Pure: the geometry comes in through `topOf(index)` (offsetTop of a row, growing with the index).
// `depths`, `parents` (-1 for none) and `ends` (index of the first row after the subtree) describe the flat list; `listEnd` is where the last row ends
// (margin included) and `pitch` the distance between two rows. Returns [{ index, slot, pushed }]: `slot` = place among the pinned rows (0 = top),
// `pushed` = how far up (px, 0 or less) the end of the subtree pushes the row out of its slot.
export function pinnedFolderRows({ depths, parents, ends, topOf, listEnd, scrollTop, pitch, maxSlots }) {
  const count = depths.length;
  // Last row whose top is above `y`, -1 when there is none (binary search: the tops grow with the index).
  const lastAbove = y => {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (topOf(middle) < y) low = middle + 1; else high = middle;
    }
    return low - 1;
  };
  // Pinned rows when the `skip` first levels are left out: the level `skip` takes the top slot, the next one the slot below, and so on.
  const collect = (skip, limit) => {
    const pinned = [];
    for (let level = skip; pinned.length < limit; level++) {
      const y = scrollTop + (level - skip) * pitch; // top of the slot of this level
      let index = lastAbove(y);
      while (index >= 0 && depths[index] > level) index = parents[index]; // up to the row of this level that holds (or is) that row
      if (index < 0 || depths[index] !== level || ends[index] === index + 1) break; // no such level here, or no subfolder shown under it
      const subtreeEnd = ends[index] < count ? topOf(ends[index]) : listEnd;
      pinned.push({ index, slot: level - skip, pushed: Math.min(0, subtreeEnd - (y + pitch)) });
    }
    return pinned;
  };
  const all = collect(0, Infinity);
  return all.length > maxSlots ? collect(all.length - maxSlots, maxSlots) : all;
}
