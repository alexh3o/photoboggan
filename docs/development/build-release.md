<!-- verified: 20af680 | sources: package.json, vite.config.js, src-tauri/Cargo.toml, src-tauri/tauri.conf.json, src-tauri/build.rs, .github/workflows/release.yml, .github/workflows/tests.yml, scripts/fetch-exiftool.mjs, scripts/prepare-face-models.mjs, scripts/prepare-semantic-models.mjs, scripts/fetch-map-style.mjs -->
# Build, packaging and release

## Purpose
How to build and run photoboggan, which assets come from outside the repository, what the installers contain, and how a release is published. The installers are consumed by the in-app updater (`modules/updates.md`), which relies on specific file types and published SHA-256 digests.

## Files
| File | Role |
|---|---|
| `package.json` | Scripts (incl. `prepare-semantic-models`); app version; dependencies (Tauri API / plugins, `maplibre-gl` 6.14.0; dev: Vite 5, Tauri CLI) |
| `vite.config.js` | Dev server on port 5173 (`strictPort`), `clearScreen: false`, ignores `src-tauri/**` in the watcher (avoids `EBUSY` on Windows) |
| `src-tauri/Cargo.toml` | Rust dependencies (pure Rust preferred; `rusqlite` bundled; `ort` pinned `=2.0.0-rc.15` with `load-dynamic`); Windows-only `windows` crate; app version |
| `src-tauri/tauri.conf.json` | App identity, window, CSP, bundle (targets, resources, MSI languages), build hooks |
| `src-tauri/tauri.dev.conf.json` | Overrides for development: identifier `com.alexh3o.photoboggan.dev`, product name `photoboggan-dev` |
| `src-tauri/build.rs` | Only `tauri_build::build()` |
| `scripts/` | `fetch-exiftool.mjs`, `fetch-map-style.mjs`, `prepare-face-models.mjs`, `prepare-semantic-models.mjs`, `gen-docs.mjs` (documentation) |
| `.github/workflows/` | `tests.yml` (`testing.md`), `release.yml` |

## How it works

### Prerequisites
Node 20 (CI), Rust stable (heic-rs needs Rust 1.85+, see the comment in `Cargo.toml`), the Tauri v2 platform requirements: on Linux `libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` (the list used by both workflows); on Linux the app also needs `perl` at run time for ExifTool (`bundle.linux.deb.depends`). Then `npm install`.

### Development loop
```bash
npm run tauri dev        # full app (Vite dev server + Rust, rebuilt on change)
npm run tauri:dev        # same with src-tauri/tauri.dev.conf.json: separate identifier and product name
cd src-tauri && cargo check
npm run build            # frontend only (Vite, output dist/)
```
- `tauri.conf.json` `beforeDevCommand` = `npm run fetch-exiftool -- --optional && npm run dev`: a failed ExifTool download only warns (the app then looks for ExifTool on `PATH`). The dev CSP (`devCsp`) additionally allows `ws://localhost:5173` and `http://localhost:5173` for hot reload.
- `npm run tauri:dev` exists to run a development build next to an installed one: the different identifier gives it its own app data and `config.json` folders and a different window class, so it does not clash with the installed app (the app is single-instance: `modules/app-shell.md`). Tauri derives the app config, local data (data directory, catalogue, caches) and WebView data folders from the identifier, so nothing is shared with the installed app; the single-instance lock is also per identifier.
- Frontend changes hot-reload through Vite; Rust changes restart the app. `src-tauri/target/` and `dist/` are build outputs (ignored by Git).

### External assets (not in the installer, or not versioned)
| Asset | Source | Where it lands | How it is pinned |
|---|---|---|---|
| ExifTool | SourceForge archives (`exiftool-<v>_64.zip` for Windows with embedded Perl; `Image-ExifTool-<v>.tar.gz` elsewhere) | `src-tauri/vendor/exiftool/` (not versioned except `README.txt`), bundled as resource `exiftool/` | `VERSION` (13.59) and one SHA-256 per distribution in `scripts/fetch-exiftool.mjs`; the download is verified, and skipped when the right version is already there (`.version` stamp). Options `--optional`, `--platform=win32\|linux\|darwin`. Runs automatically before `tauri dev` (optional) and `tauri build` (mandatory) |
| Map style (OpenFreeMap "liberty" and "dark", sprites, fonts) | `node scripts/fetch-map-style.mjs` | `src-tauri/resources/map-style/` (**versioned**), bundled as resource `map-style/` | Not run by any build; run by hand to renew, then commit the result. `STYLES`, `GLYPH_RANGES` and `PROVIDER` must match `private_maps.rs`; `LICENSES.md` is maintained by hand |
| Face models and ONNX Runtime | Files published on the GitHub release tagged `face-models-1`, downloaded by the app on demand | `<data dir>/models/` | `scripts/prepare-face-models.mjs` downloads the official files, checks pinned SHA-256, copies them to `dev_tools/face-models-release/` and rewrites `src-tauri/face_models.json` (compiled into the app). Then create the release and upload the 4 files by hand; a published release must never change (change `RELEASE_TAG` instead) |
| Semantic model (SigLIP 2) | Release `semantic-models-1` | `<data dir>/models/semantic/<id>/` | `scripts/prepare-semantic-models.mjs`, same procedure, rewrites `src-tauri/semantic_models.json`; ONNX Runtime is shared with the face models |
Models and ONNX Runtime are never in the installer (AGENTS.md §5.I). `dev_tools/` is ignored by Git.

### Production build and packages
`npm run tauri build` runs `beforeBuildCommand` (`npm run fetch-exiftool && npm run build`) then compiles and bundles for `targets: ["msi", "deb"]` (a `.msi` on Windows, a `.deb` on Linux). Bundled resources: `vendor/exiftool/` → `exiftool/` and `resources/map-style/` → `map-style/`; `LICENSE.rtf` as licence file. The webview CSP (`tauri.conf.json`): only `'self'`, IPC and asset protocol, plus `https://tiles.openfreemap.org` in `connect-src` for map tiles (the one webview network access, `../architecture.md`); the asset protocol scope is `**` (the webview reads image files directly).
- Windows MSI (WiX): one MSI per language, English default (`wix/en-US.wxl`, `wix/fr-FR.wxl` hold the installer texts); images `icons/msibanner.bmp` and `icons/msidialog.bmp` (the left panel is 164 px wide, AGENTS.md §5.I). Installer file names end in `_en-US.msi` and `_fr-FR.msi`; the updater picks `_en-US.msi` first.
- Linux `.deb` depends on `perl`.
- The release must keep one `.msi` and one `.deb`, otherwise the update dialog sends the user to the GitHub page.

### CI workflows
The release workflow passes the `TAURI_PRIVATE_KEY` and `TAURI_PRIVATE_KEY_PASSWORD` GitHub secrets to Tauri as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; `bundle.createUpdaterArtifacts` must remain enabled so signed updater bundles are produced.
- `tests.yml`: push to `main` and every pull request; `ubuntu-22.04` and `windows-latest`; builds the frontend, `cargo test`, and on Windows the ExifTool integration tests (`testing.md`).
- `release.yml`: triggered by pushing a tag `v*`. Matrix: `ubuntu-22.04` with `--bundles deb`, and `windows-latest`. Steps: checkout with full history; Node 20; Rust stable; on Linux only, install `git-cliff` (`cargo install git-cliff`) and generate the changelog of the latest tag (`git cliff --latest --strip header`) into an environment variable; Linux system libraries; `npm install`; then `tauri-apps/tauri-action@v0` creates the GitHub release for the tag as a **draft and pre-release** with the binaries attached. The Linux job writes the changelog as the release body; the Windows job sets the body to "Release for Windows". The Linux job passes `appVersion` = `<tag>-beta`, but it has no visible effect: the published `.deb` names follow the version of `tauri.conf.json` (`photoboggan_0.6.10_amd64.deb`; older releases had `-alpha` / `-beta` suffixes). The updater ignores suffixes anyway (three numbers only).

### Release procedure (as implied by the files)
1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` (they must stay equal; `Cargo.lock` follows `Cargo.toml`). The updater compares the installed version (`app.package_info()`) with release tags.
2. Commit, tag `v<x>.<y>.<z>` and push the tag; wait for both jobs.
3. Check the draft: one `.msi` per language, one `.deb`, changelog text; GitHub must publish a SHA-256 `digest` for each asset (the updater refuses assets without it); then publish the release. Since the release is created with `prerelease: true`, users with "Include pre-releases" off only see it once the pre-release flag is cleared (`pick_latest` filters on it); the flag is cleared by hand when publishing (no workflow step does it; the published v0.6.4–v0.6.10 are stable).
4. Tags that are not `v<x>.<y>.<z>` (`face-models-1`, `semantic-models-1`) are model assets and are ignored by the updater.

### Platform differences
Platform code is isolated by `cfg`: `windows` crate (Shell video thumbnails, Job object around ExifTool, drive types for `has_trash`), `hide_console_window`, installer launch (`msiexec` vs `xdg-open`), ExifTool launcher (`exiftool.exe` vs `perl exiftool`), drive flush in `flush_to_disk`. Rules: `../invariants.md` §8.

## Contracts
- IPC / events / database / settings: none. External contract: the updater requires release tags `v<x>.<y>.<z>`, `.msi` / `.deb` assets and GitHub digests (`modules/updates.md`).

## Dependencies
- Uses: Tauri CLI and `tauri-action`, Vite, git-cliff, SourceForge and GitHub downloads.
- Used by: `modules/updates.md` (asset names), `modules/metadata-read-write.md` (bundled ExifTool), `modules/private-zones.md` and `modules/maps-and-geolocation.md` (bundled map style), face and semantic modules (manifests compiled from `face_models.json` / `semantic_models.json`).

## Invariants and sensitive areas
- ⚠ sensitive: ExifTool version and SHA-256 live only in `fetch-exiftool.mjs`; change both hashes together (from exiftool.org/checksums.txt).
- ⚠ sensitive: a published model release must never change; manifests record sizes and hashes that the app verifies (`model_files.rs`).
- ⚠ sensitive: `STYLES` / `GLYPH_RANGES` / `PROVIDER` duplicated between `fetch-map-style.mjs` and `private_maps.rs`.
- Three version numbers must be bumped together (above).

## Tests
CI runs `tests.yml` only. No test covers the build scripts or the release workflow.

## How to extend
1. New platform: add a matrix entry in both workflows, the `bundle.targets` entry, an ExifTool distribution check, a `current_platform` case in `update_check.rs`.
2. New bundled resource: add it to `bundle.resources` and read it from `app.path().resource_dir()` (see `exiftool::init`).
3. New downloadable asset: follow the model scripts (pinned hash and size, manifest compiled in, release never modified).

## Open questions
none. The changelog uses git-cliff's built-in default configuration (there is no `cliff.toml`). Possible cleanup: drop the ineffective `appVersion` line of `release.yml`.
