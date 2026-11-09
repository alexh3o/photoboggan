<!-- verified: none | sources: src/styles.css, src/keywords.css, src/faces.css, src/albums.css, src/duplicates.css, src/histogram.css, src/map-mode.css, src/semantic.css, src/find-raw.css, src/format-filters.css, src/raw-settings.css, src/shooting-filters.css, index.html, src/app-fonts.js -->
# Style and UI conventions

> Status: **not written** (skeleton). Phase Sonnet. 200 lines max. The variable table, z-index stack and section maps are in generated/css.md. Follow `_TEMPLATE.md`.

## Planned content

- Which stylesheet owns what (global vs per-feature) and load order
- Themes: dark/light mechanism (data-theme), how to add a token, accent and selection colors set at runtime
- Units rule (rem vs px, grid exceptions) with an example of each
- Layout skeleton: title bar, toolbar, sidebar, grid, right panel, status and toasts; where each is defined
- Reusable patterns: modal, button variants, toast, context menu, flags and colors, icons (inline SVG), fonts
- z-index policy (what layer ranges mean; table in generated/css.md)
- Checklist: adding a new panel, modal or setting control with consistent style and i18n
