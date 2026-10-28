// Liste ordonnable des Paramètres (onglet Métadonnées) : priorité de lecture des formats de mots-clés hiérarchiques, du titre, de la description.
// Chaque ligne se déplace par sa poignée (glisser) ou par les flèches ; l'ordre est mémorisé localement et transmis au backend par `send`.

import { t } from './i18n.js';

/// `formats` : [{ id, label, property }] dans l'ordre par défaut. `storageKey` : clé localStorage de l'ordre choisi. `send(order)` : transmission
/// au backend (au démarrage et à chaque changement). Renvoie { render } pour redessiner la liste (changement de langue).
export function createOrderList({ element, formats, storageKey, send }) {
  const defaultOrder = formats.map(format => format.id);
  let order = loadOrder();

  function loadOrder() {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey));
      if (Array.isArray(stored) && stored.every(id => defaultOrder.includes(id)) && new Set(stored).size === stored.length) {
        // Ordre enregistré avant l'ajout d'un format : conservé, les nouveaux formats sont ajoutés à la fin.
        return [...stored, ...defaultOrder.filter(id => !stored.includes(id))];
      }
    } catch {
      // valeur absente ou illisible : ordre par défaut
    }
    return [...defaultOrder];
  }

  function save(newOrder) {
    order = newOrder;
    localStorage.setItem(storageKey, JSON.stringify(order));
    send(order);
    render();
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const newOrder = [...order];
    [newOrder[index], newOrder[target]] = [newOrder[target], newOrder[index]];
    save(newOrder);
  }

  function makeMoveButton(symbol, label, disabled, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'keyword-format-move';
    button.textContent = symbol;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    button.addEventListener('click', action);
    return button;
  }

  // Glisser la poignée : la ligne change de place dès que le pointeur passe le milieu d'une voisine ; l'ordre n'est enregistré qu'au relâchement.
  // (Evènements pointeur plutôt que glisser-déposer HTML5, que le dépôt de fichiers de la fenêtre Tauri intercepte.)
  function startDrag(event, item, handle) {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    item.classList.add('dragging');
    const onMove = moveEvent => {
      const previous = item.previousElementSibling;
      const next = item.nextElementSibling;
      if (previous) {
        const rect = previous.getBoundingClientRect();
        if (moveEvent.clientY < rect.top + rect.height / 2) element.insertBefore(item, previous);
      }
      if (next) {
        const rect = next.getBoundingClientRect();
        if (moveEvent.clientY > rect.top + rect.height / 2) element.insertBefore(next, item);
      }
    };
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      item.classList.remove('dragging');
      const newOrder = [...element.children].map(child => child.dataset.formatId);
      if (newOrder.join() !== order.join()) save(newOrder);
      else render();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  }

  function render() {
    if (!element) return;
    const items = order.map((id, index) => {
      const format = formats.find(candidate => candidate.id === id);
      const item = document.createElement('li');
      item.className = 'keyword-format-item';
      item.dataset.formatId = id;
      const handle = document.createElement('span');
      handle.className = 'keyword-format-handle';
      handle.textContent = '⠿';
      handle.title = t('Drag to reorder');
      handle.addEventListener('pointerdown', event => startDrag(event, item, handle));
      const rank = document.createElement('span');
      rank.className = 'keyword-format-rank';
      rank.textContent = `${index + 1}.`;
      const name = document.createElement('span');
      name.className = 'keyword-format-name';
      name.textContent = format.label;
      const property = document.createElement('code');
      property.className = 'keyword-format-property';
      property.textContent = format.property;
      item.append(
        handle,
        rank,
        name,
        property,
        makeMoveButton('↑', t('Move up'), index === 0, () => move(index, -1)),
        makeMoveButton('↓', t('Move down'), index === order.length - 1, () => move(index, 1)),
      );
      return item;
    });
    element.replaceChildren(...items);
  }

  // Ordre transmis dès le démarrage (avant tout scan).
  render();
  send(order);
  return { render };
}
