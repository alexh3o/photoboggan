<!-- verified: none | sources: src-tauri/src/main.rs, src-tauri/src/exiftool.rs, src-tauri/src/integrity.rs, src-tauri/src/db.rs -->
# Troubleshooting

> Status: **not written** (skeleton). Phase Opus or Sonnet. 150 lines max. Only problems actually visible in the code, tracker or history; mark guesses unverified. Follow `_TEMPLATE.md`.

## Planned content

- Where logs and error messages go (backend, frontend console, toasts) and how to enable more
- Frequent failures, each as: symptom, likely cause (name), how to check, fix (ExifTool not found, write refused, sidecar confusion, stale thumbnail, DB locked, models missing, offline mode refusal)
- How to reproduce with a clean state (new data folder, rebuild cache) without deleting user data
- Known issues (pointer to TODO.md and dev_tools issues)
