<!-- verified: b34237f | sources: scripts/gen-docs.mjs, AGENTS.md -->
# Developer documentation — photoboggan

Entry point for developers and AI assistants who maintain or extend the application. For the product itself, see `../USER_GUIDE.md`; for the rules AI agents must follow in every session, see `../../AGENTS.md`.

> Status: every doc is written and was cross-checked against the code (phase 4, see `_PROGRESS.md`). Remaining doubts are marked `⚠ unverified` in each doc.

## How this documentation is organized

Two kinds of files, deliberately separated:

- **Hand-written** (this folder): purpose, flows, contracts, invariants, pitfalls, recipes. Short (≤150 lines), one subject each.
- **Generated** (`generated/`): everything the code already states precisely — IPC commands, symbols, database schema, CSS variables, events, settings, tests, module dependencies. Never edit by hand; regenerate with `npm run docs:gen`.

Rule of thumb: if a fact can be extracted from the code by a script, it is in `generated/`; if it needs understanding, it is hand-written.

## Where to look (routing table)

| I want to… | Read |
|---|---|
| Understand the whole application | `architecture.md`, then `code-map.md` |
| Know what a file or folder is for | `code-map.md`, `generated/files.md` |
| Find a function / a Tauri command / who calls it | `generated/symbols-*.md`, `generated/ipc-commands.md` |
| Modify one feature | `modules/<feature>.md` (list below) |
| Check what a change might break | the module doc's "Invariants" section, `invariants.md`, `generated/module-deps.md` |
| Add a command, setting, metadata field, filter, translation, table… | `recipes.md` |
| Change a color, a modal, a layout, a theme | `style.md`, `generated/css.md` |
| Find or change a setting and its default | `configuration.md`, `generated/config.md` |
| Run or write tests | `testing.md`, `generated/tests.md` |
| Build, package, release | `build-release.md` |
| Investigate a bug | `troubleshooting.md` |
| Learn a term (sidecar, pick, scope…) | `glossary.md` |

## Feature modules

`modules/` holds one document per functional block. The list and each document's status are tracked in `_PROGRESS.md`.

## Conventions

- Reference code by **name** (`fn write_xmp_sidecar_with` in exif.rs), not by line number.
- `⚠ unverified:` marks something the author could not confirm in the code. `⚠ sensitive:` marks an area where a change is likely to cause a regression.
- Every hand-written doc starts with `<!-- verified: <git hash | none> | sources: <files> -->`. See `_TEMPLATE.md` for the writing rules and the module template.

## Keeping it current (cheap path)

1. After changing code: `npm run docs:gen` (free: regenerates `generated/`).
2. `npm run docs:stale` lists the hand-written docs whose source files changed since they were last verified, and source files no doc covers.
3. For each stale doc: read the diff of its sources (`git diff <hash> -- <sources>`), edit **only the affected sections**, then `node scripts/gen-docs.mjs --stamp docs/development/<doc>.md`.
4. Commit docs and code together.

A change that adds a command, a setting, a table, a CSS variable or a test needs no hand-written edit for that fact (it is generated); it needs one only if it changes a flow, an invariant or a recipe.

## Reading order for a model with a small context window

`README.md` → the one `modules/<feature>.md` you need → the rows of `generated/ipc-commands.md` and `generated/module-deps.md` mentioning that module (search by name) → the source files listed in the module doc. Do not load `generated/symbols-*.md` entirely: search it.
