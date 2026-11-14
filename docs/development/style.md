<!-- verified: 03c1da6 | sources: src/styles.css, src/keywords.css, src/faces.css, src/albums.css, src/duplicates.css, src/histogram.css, src/map-mode.css, src/semantic.css, src/find-raw.css, src/format-filters.css, src/raw-settings.css, src/shooting-filters.css, src/privacy.css, index.html, src/app-fonts.js -->
# Style and UI conventions

The tables (every CSS variable and where it is defined, the z-index stack, the commented sections of each stylesheet) are generated in `generated/css.md`: search it, do not copy it. This doc gives the rules and the mechanisms. Layout invariants of the grid (px vs rem) are in AGENTS.md §5.A / §7 and `modules/grid-and-viewer.md`.

## Stylesheets: who owns what
- `src/styles.css` (~1050 lines): **the global stylesheet**: `@font-face` rules (Fredoka for the title, then Inter, Manrope, Geist, Raleway from `src/assets/fonts/`, all embedded: no network, AGENTS.md §1), `:root` tokens, the `:root[data-theme="light"]` overrides, title bar, toolbar, sidebar, filter accordion, grid, preview, full screen, modals, toasts, context menu, settings controls. It is loaded from `main.js` (`import './styles.css'`).
- **One CSS file per feature**, imported by the feature's own JS module (so it is bundled by Vite and absent if the module is not loaded): `keywords.css` (keywords-panel.js), `faces.css` (faces-panel.js), `albums.css` (albums-panel.js), `duplicates.css` (duplicates.js), `histogram.css`, `map-mode.css`, `semantic.css` (semantic-settings.js), `find-raw.css`, `format-filters.css`, `raw-settings.css`, `shooting-filters.css`, `privacy.css` (privacy.js). Feature files define their own variables (e.g. `--face-*` scoped on `.faces-view`, `--clipping-*` on `:root` in `histogram.css`) and only reference global tokens.
- No CSS preprocessor, no framework (AGENTS.md §4.6). Rules are written one per line in the dense style of the existing file; a comment above a block explains **why**, not what (the generator extracts those comments into `generated/css.md` "Sections").
- Load order: `styles.css` first (from `main.js`), then each feature's file as its module is imported. A feature file may therefore override a global rule at equal specificity; keep selectors feature-scoped (`#id` or a feature class).

## Themes and runtime colours
- Dark is the base (`:root` tokens: `--bg-dark`, `--bg-panel`, `--text-light`, `--border`, `--control-bg`, `--control-border`, `--card-bg`, `--btn-text`, `--danger-text`, `--accent`, `--accent-text`…). Light overrides the **same names** in `:root[data-theme="light"]` (`styles.css`); feature files add light tweaks with `:root[data-theme="light"] .x` (see `faces.css`).
- `main.js` `applyAppearance()` sets `document.documentElement.dataset.theme` (`appTheme`: `dark` | `light`) and writes four properties inline on `<html>`: `--selected-border` (photo selection colour, `selectionColor`), `--selected-contrast` and `--active-button-text` (black or white chosen by `readableTextColor`, WCAG luminance threshold), `--active-button` (colour of toggled buttons, `activeButtonColor`). `--app-font` comes from the chosen font (`appFont`, stack built by `fontStack` in `app-fonts.js`); `--dim-unselected-brightness` from `dimUnselectedOnHover`. `generated/css.md` column "Set at runtime by" lists them all.
- **Add a token**: define it in `:root` of `styles.css` (and in the light block if it differs), use `var(--name)`; never hard-code a colour that must change with the theme. A variable only set by JS needs a CSS fallback or must be set before first paint (`applyAppearance()` runs at module load, before the window is shown).
- Colour labels and flags: classes `.flag-<key>` (`red`, `orange`, …, key stored in the database), pick classes `.pick-indicator.pick-<state>`; the visual colour is in CSS only, labels (translated) in `main.js` `COLOR_FLAGS`.

## Units rule
- **`rem` for everything typographic and spatial** (font sizes, paddings, margins, button and modal sizes, icons): the whole UI scales through one setting. `main.js` `applyTextSize()` sets `html { font-size }` to `textSize × 110 %` (`textSize` 80–140 in steps of 5, default 100, so 100 % = 17.6 px, stored as `textSize`).
- **Scrollbars** are styled globally at the top of `styles.css` (slim, themed, no arrow buttons) with `::-webkit-scrollbar*` only: never add `scrollbar-color` / `scrollbar-width`, which disable these rules in Chromium and bring the arrows back.
- **`px` only for**: hairline borders and fine shadows, and **all virtual-grid maths in `main.js`** (`clientWidth`, `scrollTop`, layout sizes), exact to the pixel to avoid gaps in the justified view. Example of each: `.settings-row { gap: 0.75rem; font-size: 0.8rem }` vs `border: 1px solid var(--control-border)` and `GRID_SIDE_MARGIN = 8`.
- Inline SVG icons carry `width`/`height` attributes in px; `styles.css` has rules `svg[width="14"|"16"|"20"|"22"|"24"]` that convert those sizes to rem (except the title bar's 10 px icons and the 12 px thumbnail badges). **A new SVG size needs a new line there.**
- Settings and other modals are sized in rem, so they resize with the text: this is why text size uses − / + buttons and not a slider (comment in `main.js`).
- Sidebar width is the exception handled in JS (`--sidebar-width` / `style.width`, AGENTS.md §5.A): in `.sidebar-section.hidden` keep `width: 0 !important; min-width: 0 !important`. The right panel: `#exif-panel.hidden { width: 0 !important }` (`keywords.css`).

## Layout skeleton
`body` (flex column, `overflow: hidden`, height 100vh) → `#app` (relative) → title bar (custom, undecorated window; its buttons call the Tauri window API) → `.top-bar` toolbar (labels hidden when narrow by `fitToolbar`, hidden with T and revealed by `.peek` on hover, z-index 900) → main area: left sidebar (folders, albums, people, filters accordion) / central grid and preview / right panel `#exif-panel` (Info and Keywords tabs, `keywords.css`). The grid owns its transient `#grid-scroll-position` pill at z-index 20, above virtual thumbnails but without pointer interaction. Overlays: `#fullscreen-view`, `.modal`s, `.context-menu`, task toasts and `.write-toast`. The DOM of all of it is in `index.html` (one file, every modal included). Resizers: `#sidebar-resizer`, `#preview-resizer`, `#exif-resizer`.

## Reusable patterns
- **Modal**: static modals are in `index.html` as `.modal.hidden > .modal-card[role=dialog][aria-modal][aria-labelledby]` with `.modal-header`; opened by removing `hidden` (`STATIC_MODALS` list in `main.js` for shared handling). Dynamic dialogs: `createModal`, `confirmDialog`, `promptDialog` (`photo-actions.js`), `choiceDialog` (`metadata-writes.js`); they trap focus (`keepFocusInModal`).
- **Buttons**: plain `button` with control tokens; `.btn-primary` for the default action in confirmation dialogs; toggled toolbar buttons use `.active` (and `aria-pressed`, kept in sync by `toolbar-a11y.js`).
- **Toasts**: `showWriteToast(message, isWriting, action, duration)` for results (optional action button such as Undo / Details), per-task toasts in `#task-toasts` (`main-window.md`).
- **Context menu**: `openContextMenuAt(event, items)` (`photo-actions.js`), items `{label, title, onSelect, disabled, header}`.
- **Sidebar title tools and quick search**: the title row of a left-panel block is `.sidebar-block-header` (flex: title, then tools at the right through `margin-right: auto` on the title). A small framed button in that row uses `.sidebar-block-tool` (`faces.css`: 1.5 rem square, `--separator` frame, hover `--control-bg`): the magnifier of the Folders, Albums and People blocks and the "+" of Albums share it. It is **invisible until the row is hovered** (`opacity: 0`, not `display: none`, so it stays in the tab order) and is shown by `.sidebar-block-header:hover` or its own `:focus-visible`. The search field next to it is `.sidebar-search` (`flex: 1 1 0; min-width: 0`: it grows to the left between the title and the buttons and never covers the title) with `.sidebar-search-input` and the × button `.sidebar-search-clear`; all colours are theme tokens and sizes are rem. Behaviour in `sidebar-search.js` (`recipes.md` §10). The People sort button keeps its own always-visible style (`.persons-sort`).
- **Filter chips**: `createFilterTag` (`filter-tags.js`) sets the class `tag-<kind>`; each kind has `--tag-<kind>-bg` / `-border` (and `-hover` for clickable chips), defined in `:root` of `styles.css` for the core kinds (rating, colour, keyword, date, file name…) and in the feature stylesheet for the others (gear and shot: `shooting-filters.css`, format: `format-filters.css`, person: `faces.css`). They have no light-theme override: chips keep the same colours in both themes. Excluded entries are faded.
- **Icons**: inline SVG in the HTML/JS (Lucide-style strokes, `currentColor`), never an icon font or a network resource.
- **Fonts**: choose in Settings; adding one takes four steps (header of `app-fonts.js`). Font names are not translated.
- **Disabled-by-feature elements**: `body.no-semantic .semantic-only { display: none !important }` (`semantic.css`) is the pattern for optional features (AGENTS.md §5.I); `no-color-labels` / `no-pick-labels` classes work the same for marking.

## z-index policy
Full stack in `generated/css.md`. Bands in use (as found): 1–10 local stacking inside a component (badges, resizers, hover lift), 20 floating widgets (`.histogram-widget`, keyword suggestions), 60 privacy set dropdown menu (`.privacy-menu.keyword-suggestions`), 900 revealed toolbar, 1000 `.write-toast`, 5000 date picker, 9999 full-screen view (and the histogram in full screen), 10000 modals, 11000 context menu, 12000 task toasts, 13000 drag ghosts. A new overlay picks the band of what it must sit above; do not invent values between bands.

## Checklist: new panel, modal or control
1. Markup in `index.html`, text via `data-i18n*` and keys in **both** `en.json` and `fr.json` (`recipes.md` §7).
2. Styles: sizes in rem, colours from tokens (check the light theme), feature CSS in its own file imported from the feature module; add a one-line comment above each block saying why.
3. New persisted state: default in `defaults.jsonc` (`configuration.md`).
4. Accessibility: `role`, `aria-label` / `aria-labelledby`, `aria-pressed` or `aria-expanded` for toggles, keyboard focus order, Esc closes modals.
5. Overlay: pick a z-index band; keep it out of the grid's reflow (use `transform` / `outline`, AGENTS.md §7).
6. Run the app in dark and light, at text size 80 % and 140 %, and in a narrow window (900 px minimum).

## Sensitive areas
- ⚠ sensitive: grid sizing in px and the thumbnail hover effect (`transform: scale`, `GRID_SIDE_MARGIN` leaves room for it); changing `.thumbnail` dimensions or padding rules affects `renderVisibleItems`.
- ⚠ sensitive: SVG size override rules above; a missing line makes an icon fixed-size in px while text scales.
- ⚠ sensitive: `:root[data-theme="light"]` must define every themeable token; a token added only to `:root` shows dark colours on the light theme.

## Open questions
none.
