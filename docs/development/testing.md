<!-- verified: none | sources: src-tauri/src/test_support.rs, .github/workflows/tests.yml, src-tauri/Cargo.toml -->
# Testing

> Status: **not written** (skeleton). Phase Sonnet. 150 lines max. Test inventory is generated: generated/tests.md. Follow `_TEMPLATE.md`.

## Planned content

- Philosophy and scope (backend only, synthetic fixtures, no network)
- Commands: fast set, ignored/integration set, per-module; prerequisites (ExifTool)
- test_support.rs helpers and how to build a synthetic image or temporary catalog
- Which risks each test group protects (map risk to test file)
- Known gaps and what is covered only manually
- Rules: when a test is mandatory, how to mark a slow test, global-state tests
