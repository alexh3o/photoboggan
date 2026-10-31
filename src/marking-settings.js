// Paramètres > Métadonnées > Marquage : utilisation des couleurs et du fanion pick (pick / rejet).
// Désactivée, une fonction reste lue dans les fichiers (la base la conserve) mais n'est plus affichée ni modifiable : le CSS masque ses contrôles
// et indicateurs (classes no-color-labels / no-pick-labels sur <body>), et main.js ignore ses raccourcis et ses filtres.
// Réglages mémorisés localement : couleurs activées par défaut, pick désactivé par défaut.

const COLOR_STORAGE_KEY = 'colorLabelEnabled';
const PICK_STORAGE_KEY = 'pickLabelEnabled';

let colorEnabled = localStorage.getItem(COLOR_STORAGE_KEY) !== 'false';
let pickEnabled = localStorage.getItem(PICK_STORAGE_KEY) === 'true';
const listeners = [];

export const isColorEnabled = () => colorEnabled;
export const isPickEnabled = () => pickEnabled;

// `listener()` est appelé après chaque changement (main.js vide alors les filtres devenus invisibles et rafraîchit les contrôles).
export function onMarkingSettingsChange(listener) {
  listeners.push(listener);
}

function applyClasses() {
  document.body.classList.toggle('no-color-labels', !colorEnabled);
  document.body.classList.toggle('no-pick-labels', !pickEnabled);
}

export function initMarkingSettings() {
  applyClasses();
  const bind = (id, get, set, storageKey) => {
    const checkbox = document.getElementById(id);
    checkbox.checked = get();
    checkbox.addEventListener('change', () => {
      set(checkbox.checked);
      localStorage.setItem(storageKey, String(checkbox.checked));
      applyClasses();
      for (const listener of listeners) listener();
    });
  };
  bind('color-label-toggle', () => colorEnabled, value => { colorEnabled = value; }, COLOR_STORAGE_KEY);
  bind('pick-label-toggle', () => pickEnabled, value => { pickEnabled = value; }, PICK_STORAGE_KEY);
}
