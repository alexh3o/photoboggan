// Récupère chez OpenFreeMap (https://openfreemap.org) le style de carte embarqué dans l'application : styles « liberty » (thème clair) et « dark »
// (thème sombre), icônes et polices qu'ils utilisent. Les fichiers sont écrits dans src-tauri/resources/map-style/ (versionnés, ressource Tauri
// « map-style », voir tauri.conf.json) avec la même disposition que le style téléchargé avec une zone (private_maps.rs) :
//   styles/<style>.json, sprites/sprite[@2x].json|png, fonts/<police>/<plage>.pbf
// Ce script n'est PAS lancé par la compilation : il sert à renouveler le style embarqué à la main (`node scripts/fetch-map-style.mjs`), puis
// à versionner le résultat. Garder STYLES, GLYPH_RANGES et PROVIDER identiques à private_maps.rs. LICENSES.md (à la main) accompagne les fichiers.

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROVIDER = 'https://tiles.openfreemap.org';
const STYLES = ['liberty', 'dark'];
const GLYPH_RANGES = ['0-255', '256-511', '8192-8447'];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'src-tauri', 'resources', 'map-style');
const licenses = existsSync(join(target, 'LICENSES.md')) ? readFileSync(join(target, 'LICENSES.md')) : null;

async function get(url, { optional = false } = {}) {
  const response = await fetch(url, { headers: { 'User-Agent': 'photoboggan map-style fetch script' } });
  if (response.status === 404 && optional) return null;
  if (!response.ok) throw new Error(`${url} : HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function save(relative, bytes) {
  const file = join(target, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  console.log(`${relative} (${bytes.length} octets)`);
}

rmSync(target, { recursive: true, force: true });
const fonts = new Set();
let spriteBase = null;
for (const style of STYLES) {
  const bytes = await get(`${PROVIDER}/styles/${style}`);
  const json = JSON.parse(bytes.toString('utf8'));
  spriteBase ??= json.sprite;
  for (const layer of json.layers ?? []) for (const font of layer.layout?.['text-font'] ?? []) fonts.add(font);
  save(`styles/${style}.json`, bytes);
}
for (const suffix of ['', '@2x']) {
  for (const extension of ['json', 'png']) {
    const bytes = await get(`${spriteBase}${suffix}.${extension}`, { optional: true });
    if (bytes) save(`sprites/sprite${suffix}.${extension}`, bytes);
  }
}
for (const font of fonts) {
  for (const range of GLYPH_RANGES) {
    const bytes = await get(`${PROVIDER}/fonts/${encodeURIComponent(font)}/${range}.pbf`, { optional: true });
    if (bytes) save(`fonts/${font}/${range}.pbf`, bytes);
  }
}
if (licenses) writeFileSync(join(target, 'LICENSES.md'), licenses);
console.log(`Polices : ${[...fonts].join(', ')}`);
