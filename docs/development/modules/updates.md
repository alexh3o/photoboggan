<!-- verified: a9ca28f | sources: src-tauri/src/update_check.rs, src/update-check.js -->
# Update check and installer

## Purpose
Tells the user when a newer release exists on GitHub, and (optionally) downloads and launches its installer. It is opt-in and network-gated: nothing is contacted unless the user enabled "Check for updates" and offline mode is off. All requests are made by the backend, never by the webview, and the UI can never tell the backend which URL or file to use. Rules summary: AGENTS.md §5.J; offline rule: `../architecture.md` "Offline mode".

## Files
| File | Role |
|---|---|
| `update_check.rs` | Release lookup (`fetch_info`, `pick_latest`, `pick_asset`), download (`download_update`, `copy_verified`), launch (`install_update`) |
| `update-check.js` | Settings checkboxes, status line, "Update available" dialog, About line, scheduling (24 h), download task and install button |
| `model_files.rs` | Not documented here: provides the HTTP timeouts, `IdleReader` and `hex` shared with model downloads (`face-detection.md`) |

## How it works

### Checking (`check_for_update`)
1. `fetch_info` first tests `face_models::internet_allowed()` and returns the error code `internet_disabled` when offline.
2. It parses the installed version (`app.package_info().version`, e.g. `0.6.2` or `0.6.2-beta`) with `parse_version` (`1.2.3`, `v1.2.3`, `1.2.3-beta.1`; build metadata after `+` ignored; anything else, such as `face-models-1`, is not a version).
3. One GET on the repository releases API (30 most recent, 10 s connect / 15 s response timeouts, body capped at 4 MB, `User-Agent: photoboggan/<version> (update check)`: nothing else is sent). A non-200 status is an error.
4. `pick_latest`: drafts are ignored; pre-releases are considered only when `includePrereleases` is true **or** the installed version has a pre-release suffix; tags that are not `v<x>.<y>.<z>` are ignored; the highest by the **three numbers only** wins (the `-beta` suffix of the Linux `.deb` is therefore ignored). The version always comes from the tag, never from file names (a release can hold files named after an older version). `update_available` = latest numbers strictly greater than installed. With no eligible release it returns "no update" with `latest = current`.
5. Only when an update is available, `pick_asset` selects the installer for the platform (`current_platform`): Windows `_en-US.msi` first, then any `.msi`; Linux `.deb`; other systems none (the dialog then links to the release page). An asset is accepted only if its name is safe (`is_safe_file_name`: ASCII letters, digits, `._-`, ≤ 150, no leading dot), its URL starts with the repository download prefix (`DOWNLOAD_URL_PREFIX`), its size is 1 byte to 500 MB (`MAX_INSTALLER_BYTES`), and GitHub published a valid `sha256:<64 hex>` `digest` (without it integrity could not be verified, so no installer is offered). Only name, size and `restarts` (true on Windows) reach the UI (`#[serde(skip)]` on `url` and `sha256`).

### Downloading (`download_update`, a queued task of `kind: 'update'`)
1. Arguments: `taskId`, `version`, `includePrereleases`; **no URL**. The release list is read again; if the latest is no longer `version` or no update is available, the error is `update_changed` (the UI forgets its result and checks again); no installer → `update_no_installer`.
2. The folder `<OS temp>/photoboggan-update/` is emptied (one installer at a time) and the in-memory record `DOWNLOADED` cleared.
3. The asset URL (taken from the release, not from the UI) is fetched with the shared timeouts; `copy_verified` streams into `<name>.part` computing SHA-256, stops with `cancelled` if the task flag is set (partial file deleted), fails with `update_corrupted` if more bytes than announced arrive or if size / hash differ at the end, and only then renames to the final name. Progress goes through `scan-progress`.
4. On success `DOWNLOADED = (path, size, sha256)`. A cancelled task returns success with nothing kept.

### Installing (`install_update`)
Takes no argument. It uses `DOWNLOADED` (`update_not_downloaded` if empty), **re-checks size and recomputes the SHA-256** just before launching (mismatch clears the record and returns `update_corrupted`), then:
- Windows: `msiexec /i <file>` for `.msi` (any other extension would be executed directly), then `app.exit(0)`; returns `true` (the app closes so the installer can replace files).
- Other systems: `xdg-open <file>` (the `.deb` goes to the package manager, which needs rights the app lacks); returns `false`, the app stays open.

### Frontend (`update-check.js`)
- `initUpdateCheck({ showToast, enqueueTask, canQuit })` (services injected by `main.js`): reads the saved result (`updateInfo`), drops it if it was for another installed version (the app was just updated), binds the checkboxes `checkUpdates` and `includePrereleases` (changing either forgets the result and rechecks).
- Scheduling: a check at startup after a 3 s delay (so the offline setting has reached the backend), at most once per 24 h (`lastUpdateCheck`), silent on failure; a manual "Check now" always opens the dialog; a toast (with "Details") announces a new version unless the user chose Ignore for that version (`ignoredUpdateVersion`). `isActive() = checkUpdates && !offlineMode`; `onUpdateAccessChanged()` is called when offline mode changes.
- Download button → `enqueueTask({ kind: 'update', command: 'download_update', … })`; state `idle → downloading → ready`; when ready for the shown version the same button runs `installUpdate`. On Windows (`asset.restarts`) it first calls `canQuit()`, the same guards as closing the window (unwritten keywords, changed album, running writes).
- The release page is opened only if its URL starts with `https://github.com/alexh3o/photoboggan/`. Release notes (Markdown, capped at 8000 characters) are rendered as plain text by `plainText` / `renderNotes`.

## Contracts
- IPC: `check_for_update`, `download_update`, `install_update` (`../generated/ipc-commands.md`). Error codes: `internet_disabled`, `update_changed`, `update_no_installer`, `update_corrupted`, `update_not_downloaded`, `cancelled` (swallowed).
- Events: `scan-progress` for the download task.
- Database: none.
- Settings: `checkUpdates`, `includePrereleases`, `lastUpdateCheck`, `updateInfo`, `ignoredUpdateVersion`, `offlineMode` (read) (`../generated/config.md`).

## Dependencies
- Uses: `face_models::internet_allowed` (global offline flag), `model_files` (timeouts, `IdleReader`, `hex`), `scan_cancel_flag` / `release_scan_cancel_flag` (main.rs), `ureq`, `sha2`.
- Used by: `main.js` (init, task queue, `canQuit`), the Settings and About dialogs.

## Invariants and sensitive areas
- ⚠ sensitive: the security chain: asset filter (prefix, safe name, size, published digest) → hash checked while writing → hash checked again before launch → the UI passes no URL or path. Do not add a parameter that lets the frontend choose a file or URL. Tests: `unsafe_or_unverifiable_assets_are_refused`, `download_is_kept_only_when_size_and_sha256_match`.
- ⚠ sensitive: version choice (tag only, three numbers, drafts and non-app tags skipped): `face-models-1` is a real tag of the repository holding model files, not an application release.
- The release must keep an `.msi` (Windows) and a `.deb` (Linux), otherwise the dialog falls back to the GitHub page (`build-release.md`).
- Offline mode: any new network call here must keep the `internet_disabled` check.

## Tests
`tests/update_check.rs` (12): version parsing and comparison, eligibility (stable, pre-release, beta installed, drafts, non-app releases), asset choice per platform (English MSI preferred, never a setup `.exe`), refused unsafe assets, download kept only on matching size + hash, cancel leaves nothing. Not covered: network calls (`fetch_info`, `download_update`) and `install_update`, which launches a process.

## How to extend
1. New platform installer: add its extensions in `pick_asset` and a case in `current_platform` and `install_update`, and make the release workflow publish it (`build-release.md`).
2. New source of releases: keep a fixed repository prefix and the published digest requirement.
3. New UI text: keys in `en.json` and `fr.json`; error codes go through `updateErrorMessage`.

## Open questions
- The non-`.msi` branch of `install_update` (Windows) is unreachable since `pick_asset` only selects `.msi`; kept as a safety net.
- The repository slug `alexh3o/photoboggan` is written in both `update_check.rs` (`RELEASES_URL`, `DOWNLOAD_URL_PREFIX`) and `update-check.js` (`RELEASE_URL_PREFIX`): change both together.
