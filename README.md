# Orbit

A local-first Electron desktop CRM that stores contacts as an **encrypted
relationship graph**. Two primary surfaces - a forgiving search palette and an
interactive WebGL graph. Single-device, offline, corruption-proof, private.

Target scale: **20,000 contacts, ~200,000 edges.**

## Quick start

```bash
npm install          # plain install (native module on the Node ABI)
npm run dev          # rebuild for Electron + build renderer, launch the app
npm run dev:watch    # dev with auto-reload (renderer edits reload, main edits restart)
npm test             # rebuild for Node, run the unit + acceptance suite
npm run typecheck    # tsc --checkJs against the shared type contract
npm run fixture      # (optional) seed a 20k-contact clustered test DB
```

Requires Node ≥ 20. The dev/build commands and the test/script commands need
different native-module ABIs (Electron vs Node); the npm pre-hooks switch
automatically. See `docs/DECISIONS.md`.

## What to read

Start with **`CLAUDE.md`** (repo orientation + guardrails), then the docs:

| Doc | Covers |
|---|---|
| `docs/APP_REQUIREMENTS.md` | Umbrella: features (must/need/nice), stack, schema, roadmap |
| `docs/INTERFACE_CONTRACT.md` | IPC channels, payloads, shared types - the boundary |
| `docs/SEARCH_REQUIREMENTS.md` | Fuzzy search: two-stage retrieval, ranking, acceptance tests |
| `docs/GRAPH_CANVAS_REQUIREMENTS.md` | WebGL graph: renderer, interactions, analytics |
| `docs/EXPORT_IMPORT_REQUIREMENTS.md` | Portable archive: format, encryption, device migration |
| `docs/DEDUP_MERGE_REQUIREMENTS.md` | Identity resolution and safe merge |
| `docs/APP_SHELL_UX.md` | Screen map, design system, keyboard model, error states |
| `docs/BUILD_AND_RELEASE.md` | Cross-platform build, signing, auto-update |
| `docs/TEST_STRATEGY.md` | Test layers, fixtures, recovery harness |
| `docs/SECURITY_AND_THREAT_MODEL.md` | Threat model, encryption, key management |
| `docs/DECISIONS.md` | Deliberate amendments to the scaffold, newest first |

## Architecture at a glance

- **Electron**, hardened renderer (contextIsolation, sandbox, strict CSP, validated IPC).
- **SQLite/SQLCipher** (`better-sqlite3-multiple-ciphers`), one encrypted file, WAL. Key lives in the OS keychain via `safeStorage`.
- **graphology** in-memory model in the main process; **sigma.js** (WebGL) renderer, bundled by Vite; force layout + betweenness on workers.
- **FTS5 + JS fuzzy re-rank** for search, on a read-only worker connection.
- Lifecycle orchestration in `src/main/main.js`; data layer (self-healing open, backups, migrations) in `src/main/db/`; every IPC channel in one validated registry (`src/main/ipc/registry.js`).

## Milestones

- **M0** Foundation - lifecycle, schema + migrations, encrypted DB, backup/restore. **(done)**
- **M1** Core data - CRUD, soft-delete, edges, tags, interactions, graph hydration, editing UI, trash. **(done)**
- **M2** Ingest - vCard/CSV import wizard, encrypted .orbit export/import, dedup-on-import, backup-before-import. **(done)**
- **M3** Graph - ego + full-network modes, main-side layout worker with persisted positions, drag, shortest path, edge-type filters. **(done; 20k perf harness pending)**
- **M4** Search - two-stage pipeline in a worker, typo tolerance, operators (org: tag: type: has: near: hops:), did-you-mean, recency/degree boosts, Cmd+K palette. **(done; spellfix1 evaluation pending)**
- **M5** Intelligence - betweenness worker (cached), Louvain communities, dedup review queue with undoable merges, saved searches, scope-to-focus. **(done)**
- **Need/Nice tier** - virtualized list view (⌘L) with bulk actions, Settings (backup status + restore-and-relaunch), first-run onboarding, trash purge + 30-day auto-purge, PNG/GraphML export, pin/unpin. **(done; minimap + path animation deliberately skipped, see DECISIONS)**
- **M6** Distribution & hardening - CI build matrix, signing, notarization, auto-update, app icons, 20k perf harnesses.

## Layout

```
src/main/      lifecycle (main.js), keys.js, config.js
  db/          open/self-heal/backup, repos, migrations
  graph/       in-memory graphology store
  ipc/         channel registry, validators, error transport
src/shared/    types.d.ts - the domain + IPC contract
src/renderer/  UI sources, built by Vite into dist/renderer
scripts/       generate-fixture.js, smoke-open-db.js
test/          unit + acceptance (plain Node, no Electron needed)
docs/          all specifications + DECISIONS.md
```
