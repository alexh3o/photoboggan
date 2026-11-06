// Keeps aria-pressed in sync with the "active" class on the toolbar toggle buttons.
// The class is toggled from many modules (main.js, faces-grid.js, map-mode.js...), so a single
// observer here avoids touching each of them.
const TOGGLE_IDS = [
  'btn-toggle-sidebar', 'btn-toggle-faces', 'btn-toggle-map',
  'btn-toggle-compare', 'btn-toggle-preview', 'btn-toggle-exif',
];

export function initToolbarAria() {
  for (const id of TOGGLE_IDS) {
    const button = document.getElementById(id);
    if (!button) continue;
    const sync = () => button.setAttribute('aria-pressed', String(button.classList.contains('active')));
    sync();
    new MutationObserver(sync).observe(button, { attributes: true, attributeFilter: ['class'] });
  }
}
