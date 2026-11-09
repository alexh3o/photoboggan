<!-- verified: none | sources: src-tauri/src/main.rs, src-tauri/src/db.rs, src/main.js, src-tauri/tauri.conf.json, index.html -->
# Architecture

> Status: **not written** (skeleton). Phase Opus. 200 lines max. Follow `_TEMPLATE.md`.

## Planned content

- Purpose and philosophy (in-place, offline-capable, local): one paragraph, no copy of AGENTS.md
- Process model: Tauri shell, Rust backend, webview frontend, ExifTool child process, SQLite (WAL, r2d2 pools)
- Block diagram of the functional blocks (the modules/ list) and how they talk (IPC commands, events, DB, files on disk)
- End-to-end flows, one numbered flow each: add a folder, scan, grid; thumbnail request; metadata write; keyword apply; duplicate search; update install
- Where state lives: SQLite tables vs files on disk vs localStorage vs memory (what is rebuildable)
- Concurrency model: TaskQueue families, spawn_blocking / rayon, what runs on the main thread
- Offline mode and network access rule
