<!-- Working file for the writing phase: delete or archive when every row below is "reviewed". Ignored by `npm run docs:stale`. -->
# Documentation progress

Update the status column and commit at the end of each session. One session = one row (or two small ones). Statuses: `skeleton` → `written` → `reviewed`.

## Phase plan

| # | Phase | Model | Output | Status |
|---|---|---|---|---|
| 1 | Generator + skeleton + template | Sonnet | `scripts/gen-docs.mjs`, `generated/`, empty docs | done (to be committed) |
| 2 | Architecture, code map, invariants, recipes; **validate the module split below** | Opus | `architecture.md`, `code-map.md`, `invariants.md`, `recipes.md`, this table | todo |
| 3 | Module docs, style, configuration, testing, build, troubleshooting, glossary | Sonnet, one session per row | see table below | todo |
| 4 | Cross-review: contradictions, `⚠` items, spot-check claims against the code | Opus | fixes + `reviewed` status | todo |
| 5 | Real-task test with a free-tier model using only these docs | any | list of gaps → fixes | todo |
| 6 | Hook up `AGENTS.md` (one pointer line + "update docs with the code" rule) | Sonnet | AGENTS.md diff, user validates | todo |

## Document status

Draft module split (to be confirmed or changed in phase 2; `main.js` alone is ~8400 lines and may need two docs).

| Doc | Phase | Status |
|---|---|---|
| `architecture.md` | 2 | skeleton |
| `code-map.md` | 2 | skeleton |
| `invariants.md` | 2 | skeleton |
| `recipes.md` | 2 | skeleton |
| `modules/library-and-database.md` | 3 | skeleton |
| `modules/thumbnails-and-previews.md` | 3 | skeleton |
| `modules/metadata-read-write.md` | 3 | skeleton |
| `modules/keywords.md` | 3 | skeleton |
| `modules/faces.md` | 3 | skeleton |
| `modules/semantic.md` | 3 | skeleton |
| `modules/duplicates.md` | 3 | skeleton |
| `modules/maps-and-geolocation.md` | 3 | skeleton |
| `modules/albums.md` | 3 | skeleton |
| `modules/filters-and-search.md` | 3 | skeleton |
| `modules/photo-operations.md` | 3 | skeleton |
| `modules/grid-and-viewer.md` | 3 | skeleton |
| `modules/app-shell.md` | 3 | skeleton |
| `modules/updates.md` | 3 | skeleton |
| `style.md` | 3 | skeleton |
| `configuration.md` | 3 | skeleton |
| `testing.md` | 3 | skeleton |
| `build-release.md` | 3 | skeleton |
| `troubleshooting.md` | 3 | skeleton |
| `glossary.md` | 3 | skeleton |

## Session prompts (copy, paste, replace the placeholder)

**Phase 2 (Opus, one session)**

> Read `docs/development/README.md`, `_TEMPLATE.md` and `_PROGRESS.md`, then `AGENTS.md`. Write `architecture.md`, `code-map.md`, `invariants.md` and `recipes.md` following the planned content of each skeleton and the rules of `_TEMPLATE.md`. Use `generated/` (files, module-deps, ipc-commands, db-schema) as your map and read the source to confirm every claim; mark anything uncertain `⚠ unverified`. Then review the module split in `_PROGRESS.md` (change it if the code suggests a better one, adjusting skeleton files and their `sources:` lines) and, for each module, add 3–6 bullets under its "How it works" heading naming the entry-point functions, so the Sonnet sessions start with a guide. Stamp the docs you verified. Commit.

**Phase 3 (Sonnet, one session per module)**

> Read `docs/development/_TEMPLATE.md`, `architecture.md` and `modules/<NAME>.md` (its skeleton and the entry-point notes left by phase 2). Read the source files listed in its `sources:` line, plus the rows of `generated/ipc-commands.md`, `generated/module-deps.md` and `generated/db-schema.md` that concern them (search by name, do not load whole files). Write the module doc following the template and its rules: facts only, `⚠ unverified` when unsure, `⚠ sensitive` for regression-prone areas, names not line numbers, 150 lines max. Stamp it (`node scripts/gen-docs.mjs --stamp docs/development/modules/<NAME>.md`), update its row in `_PROGRESS.md`, commit.

**Phase 4 (Opus, one session)**

> Review every `written` doc in `docs/development/`: contradictions between docs, claims that do not match the code (check at least 5 per doc against the source), missing sensitive areas, links to generated tables that do not exist, files over the size limit. Fix them, mark docs `reviewed`, list what remains uncertain.

**Phase 5 (free-tier model)**

> Using ONLY `docs/development/` (and the source files it points to), explain how you would add <a small realistic feature>. List every step and file. Say which statement of the docs was missing or unclear.
