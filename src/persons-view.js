// Vue Personnes (lot 5a) : une grosse vignette par personne, à la place de la grille des photos (bouton « Visages » de la barre du haut).
// - Vignette : le visage représentatif recadré depuis la photo d'origine, à la résolution du cache des miniatures (commande get_person_cover,
//   gardée dans person_covers/ côté Rust) ; nom et nombre de photos dessous. Taille réglable (curseur), défilement virtuel.
// - Clic : la vue se ferme et la grille des photos est filtrée sur la personne. Clic droit : menu de la personne, dont « Gérer ses visages »
//   (vue de gestion sur ses visages). Bouton « Gérer les visages » : vue de gestion (faces-grid.js), qui a un bouton de retour ici.

import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { t, tp, onLanguageChange } from './i18n.js';
import { listedPersons, openPersonMenu, filterOnPerson, getShowHiddenPersons, setShowHiddenPersons } from './faces-panel.js';

const SIZE_STORAGE_KEY = 'personsTileSize';
const GAP = 12;
const SIDE_MARGIN = 12;
const LABEL_HEIGHT = 40; // nom et nombre de photos sous la vignette

let host = null; // fonctions fournies par main.js (voir initPersonsView)
let open = false;
let tileSize = readSize();
let shown = []; // personnes affichées, triées par nombre de photos
let layout = []; // { x, y, index }
const renderedNodes = new Map(); // identifiant de personne -> nœud
const coverUrls = new Map(); // « personne-visage » -> Promise<url | ''>

const view = () => document.getElementById('persons-view');
const scroller = () => document.getElementById('persons-scroll');
const content = () => document.getElementById('persons-content');

function readSize() {
  let size = 200;
  try { size = Number(localStorage.getItem(SIZE_STORAGE_KEY)) || 200; } catch { /* stockage indisponible */ }
  return Math.min(512, Math.max(96, size));
}

export function isPersonsViewOpen() {
  return open;
}

export function openPersonsView() {
  host.closeFacesView();
  open = true;
  view().hidden = false;
  host.setPhotoGridVisible(false);
  document.getElementById('btn-toggle-faces')?.classList.add('active');
  reloadPersonsView();
  scroller().focus({ preventScroll: true });
}

export function closePersonsView() {
  if (!open) return;
  open = false;
  view().hidden = true;
  host.setPhotoGridVisible(true);
  document.getElementById('btn-toggle-faces')?.classList.remove('active');
}

// Personnes rechargées (après un scan, une révision, une suppression…) : la grille est reconstruite, défilement conservé.
export function reloadPersonsView() {
  if (!open) return;
  shown = [...listedPersons()].sort((a, b) => b.photo_count - a.photo_count || a.name.localeCompare(b.name));
  document.getElementById('persons-count').textContent = tp('{count} person', shown.length);
  document.getElementById('persons-show-hidden').checked = getShowHiddenPersons();
  document.getElementById('persons-empty-view').hidden = shown.length > 0;
  rebuild();
}

function rebuild() {
  const width = Math.max(tileSize, scroller().clientWidth - 2 * SIDE_MARGIN);
  const columns = Math.max(1, Math.floor((width + GAP) / (tileSize + GAP)));
  layout = shown.map((_, index) => ({
    x: SIDE_MARGIN + (index % columns) * (tileSize + GAP),
    y: SIDE_MARGIN + Math.floor(index / columns) * (tileSize + LABEL_HEIGHT + GAP),
    index,
  }));
  const rows = Math.ceil(shown.length / columns);
  content().style.height = `${SIDE_MARGIN * 2 + rows * (tileSize + LABEL_HEIGHT + GAP)}px`;
  for (const node of renderedNodes.values()) node.remove();
  renderedNodes.clear();
  renderVisible();
}

function renderVisible() {
  const area = scroller();
  const top = area.scrollTop - tileSize * 2;
  const bottom = area.scrollTop + area.clientHeight + tileSize * 2;
  const visible = new Set();
  for (const item of layout) {
    if (item.y + tileSize + LABEL_HEIGHT < top || item.y > bottom) continue;
    const person = shown[item.index];
    visible.add(person.id);
    let node = renderedNodes.get(person.id);
    if (!node) {
      node = createTile(person);
      renderedNodes.set(person.id, node);
      content().append(node);
    }
    node.style.transform = `translate3d(${item.x}px, ${item.y}px, 0)`;
    node.style.width = `${tileSize}px`;
    node.querySelector('.person-tile-image').style.height = `${tileSize}px`;
  }
  for (const [id, node] of renderedNodes) {
    if (!visible.has(id)) { node.remove(); renderedNodes.delete(id); }
  }
}

function createTile(person) {
  const node = document.createElement('div');
  node.className = `person-tile${person.hidden ? ' hidden-person' : ''}`;
  node.title = t('Click: show the photos of this person · Right-click: manage this person and their faces');
  const image = document.createElement('div');
  image.className = 'person-tile-image';
  const name = document.createElement('div');
  name.className = 'person-tile-name';
  name.textContent = person.name;
  const count = document.createElement('div');
  count.className = 'person-tile-count';
  count.textContent = tp('{count} photo', person.photo_count);
  node.append(image, name, count);
  loadCover(image, person);
  node.addEventListener('click', () => {
    closePersonsView();
    filterOnPerson(person.id);
  });
  node.addEventListener('contextmenu', event => openPersonMenu(event, person));
  return node;
}

// Vignette de la personne : générée une fois côté Rust (photo d'origine), puis servie depuis son cache.
function loadCover(element, person) {
  if (!person.cover) return;
  const key = `${person.id}-${person.cover.face_id}`;
  let url = coverUrls.get(key);
  if (!url) {
    url = invoke('get_person_cover', { personId: person.id })
      .then(path => (path ? convertFileSrc(path) : ''))
      .catch(error => {
        console.error('Vignette de personne impossible', error);
        return '';
      });
    coverUrls.set(key, url);
  }
  url.then(source => {
    if (!source || !element.isConnected) return;
    element.style.backgroundImage = `url("${source}")`;
  });
}

// hostApi : setPhotoGridVisible(visible), closeFacesView(), openFacesManagement().
export function initPersonsView(hostApi) {
  host = hostApi;
  let scrollPending = false;
  scroller().addEventListener('scroll', () => {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => { scrollPending = false; renderVisible(); });
  });
  window.addEventListener('resize', () => { if (open) rebuild(); });
  const slider = document.getElementById('persons-size');
  slider.value = String(tileSize);
  slider.addEventListener('input', () => {
    tileSize = Number(slider.value);
    try { localStorage.setItem(SIZE_STORAGE_KEY, String(tileSize)); } catch { /* stockage indisponible */ }
    rebuild();
  });
  document.getElementById('persons-show-hidden').addEventListener('change', event => setShowHiddenPersons(event.target.checked));
  document.getElementById('btn-persons-manage').addEventListener('click', () => host.openFacesManagement());
  onLanguageChange(() => { if (open) reloadPersonsView(); });
}
