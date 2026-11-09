<!-- verified: none | sources: package.json, vite.config.js, src-tauri/Cargo.toml, src-tauri/tauri.conf.json, src-tauri/build.rs, .github/workflows/release.yml, .github/workflows/tests.yml, scripts/fetch-exiftool.mjs, scripts/prepare-face-models.mjs, scripts/prepare-semantic-models.mjs, scripts/fetch-map-style.mjs -->
# Build, packaging and release

> Status: **not written** (skeleton). Phase Sonnet. 150 lines max. Follow `_TEMPLATE.md`.

## Planned content

- Prerequisites (Node, Rust, platform toolchains)
- Dev loop: commands, dev config, what is hot-reloaded
- External assets: ExifTool (version and hash pinned), face and semantic models, map style: where they come from and where they land
- Production build and packages: MSI (WiX, wxl, bmp), .deb; bundled resources
- CI workflows: what runs when; release procedure step by step; version bump places
- Platform differences (cfg(windows) code)
