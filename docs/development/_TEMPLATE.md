<!-- Not a doc: the template and the writing rules every author (human or AI, any model) must follow. Files starting with "_" are ignored by `npm run docs:stale`. -->
# Template and writing rules for `docs/development/`

## Rules (read before writing anything)

1. **Facts only.** Every statement must come from code you have read. Never invent a behavior, a rule or a feature. If you are not sure, write `⚠ unverified: <what you assumed and where to check>`.
2. **Explain intent, not syntax.** Do not paraphrase code. The mechanical facts (IPC signatures, symbols, tables, CSS variables, tests, dependencies) are already in `generated/`: link to them, never copy them. What a doc adds: purpose, flow, contracts between pieces, invariants, pitfalls, how to extend.
3. **Point to names, not line numbers.** Write `fn apply_metadata_changes` (keywords.rs), not `keywords.rs:412`. Names can be found with a search; line numbers rot.
4. **Mark sensitive areas** with `⚠ sensitive:` followed by the reason (what breaks, which test or invariant protects it).
5. **Size limit: 150 lines per file** (200 for architecture-level files). A free-tier model must be able to read a doc entirely. If a module needs more, split it into two docs.
6. **Self-contained.** A reader must not need another doc to understand this one, except for links to `generated/` tables and to named docs for shared concepts. Define a term the first time it appears (or link `glossary` in README).
7. **English.** Docs and code comments are in English (AGENTS.md §4.9). UI strings are French/English keys in `src/locales/`.
8. **First line of every hand-written doc** is the verification header, used by `npm run docs:stale`:
   `<!-- verified: <git short hash | none> | sources: file1, file2, dir/ -->`
   - `sources`: the files this doc describes (exact paths from the repository root). A directory ending in `/` only tracks added / deleted files.
   - After checking a doc against the code, run `node scripts/gen-docs.mjs --stamp <doc>` (sets the hash to the current commit). Never stamp a doc you did not verify.
9. **Update in the same commit as the code** (see README, "Keeping it current"). Edit only the affected section; do not rewrite the file.

## Module doc template

Copy everything below the line into `modules/<name>.md`. Delete a section only if it is truly empty (write `none` instead, so the reader knows it was checked).

---

```markdown
<!-- verified: none | sources: src-tauri/src/x.rs, src/x.js -->
# <Module name>

## Purpose
<2–4 sentences: what the user gets from this module, and which problem it solves.>

## Files
| File | Role |
|---|---|
| `x.rs` | … |

## How it works
<Numbered flow(s) with function names: trigger → steps → result. One flow per user-visible action.>

## Contracts
- IPC commands: <names only; signatures in generated/ipc-commands.md>
- Events: <names; see generated/events.md>
- Database: <tables / columns it owns or touches; see generated/db-schema.md>
- Settings: <localStorage keys; see generated/config.md>

## Dependencies
- Uses: <modules and why>
- Used by: <modules and what they rely on>

## Invariants and sensitive areas
- ⚠ sensitive: …

## Tests
<test files (see generated/tests.md), what they protect, known gaps.>

## How to extend
<3–6 steps for the most likely changes, referring to recipes.md when a generic recipe applies.>

## Open questions
<things you could not determine; each one marked ⚠ unverified in the text above.>
```
