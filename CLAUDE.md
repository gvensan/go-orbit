# CLAUDE.md

Read this first, every session. It orients you before you touch code.

## What this is

Orbit - an Electron desktop CRM that stores contacts as a relationship
graph. Local-first, single-device, offline, encrypted at rest. Two primary
surfaces: a forgiving search palette and an interactive WebGL graph. Target
scale: 20,000 contacts, ~200,000 edges.

Full intent and feature tiers: `docs/APP_REQUIREMENTS.md`.

## Read order

1. `docs/APP_REQUIREMENTS.md` — umbrella: features (must/need/nice), stack, schema, roadmap.
2. `docs/INTERFACE_CONTRACT.md` — IPC channels, payload/return shapes, shared types. **Build against this, not against your own assumptions.**
3. The spec for whatever you're building: `SEARCH_REQUIREMENTS.md`, `GRAPH_CANVAS_REQUIREMENTS.md`, `EXPORT_IMPORT_REQUIREMENTS.md`, `DEDUP_MERGE_REQUIREMENTS.md`, `APP_SHELL_UX.md`.
4. `docs/TEST_STRATEGY.md` for how to prove it, `docs/BUILD_AND_RELEASE.md` for shipping, `docs/SECURITY_AND_THREAT_MODEL.md` for the privacy contract.
5. `docs/DECISIONS.md` - deliberate amendments to the original scaffold (ABI strategy, Vite, IPC registry, UX direction). Newest first.

## Language & conventions

- **JavaScript, CommonJS** (`require`/`module.exports`) — matches `src/main/main.js`. TypeScript is acceptable if you migrate the whole tree, but do not mix.
- Domain and IPC types are declared in `src/shared/types.d.ts`. Treat them as the contract even in JS; annotate with JSDoc `@type` imports.
- All tunables live in `src/main/config.js`. Never hardcode a weight, interval, or threshold elsewhere.
- Node 24 LTS (24.18+), npm; use `.nvmrc`.

## Commands

```
npm install            # installs, rebuilds + verifies native SQLite for Electron
npm run dev            # verifies native ABI, builds renderer, then launches
npm run dev:watch      # same, plus auto-reload: renderer edits reload the window, main edits restart Electron
npm test               # tests via Electron's embedded Node (same native ABI as the app)
npm run typecheck      # tsc --checkJs against src/shared/types.d.ts (CI-enforced)
npm run migrate        # dev CLI migrate against .dev/contacts.db
npm run fixture        # generate a 20k-contact / ~190k-edge clustered test DB
npm run build          # electron-builder for the current OS (prebuild handles renderer + ABI)
```

ABI note: the workspace always uses Electron's embedded Node ABI. Tests,
migrations, fixtures, and smoke checks run through `scripts/electron-node.js`.
Never run standalone `npm rebuild` for the SQLite addon; use
`npm run rebuild:electron`. See docs/DECISIONS.md.

## Repo layout

```
src/main/        Electron main process: lifecycle, IPC, DB, backups, workers spawn
  main.js        Thin lifecycle orchestrator: boot order + teardown only.
  preload.js     The ONLY IPC bridge. contextIsolation + sandbox stay on.
  config.js      All tunables (including validation limits).
  keys.js        DB key via safeStorage (OS keychain).
  db/            index.js (open/self-heal/backup/close), repos, migrate.js + migrations/*.sql
  graph/         store.js (in-memory model), layout-service.js, centrality-service.js
  ipc/           registry.js (one table of channels), validate.js, errors.js
  search/        engine.js (pure pipeline), service.js (worker bridge)
  ingest/        vcard.js, csv.js, importer.js (dedup policies), archive.js (.orbit)
  dedup/         engine.js (candidates, merge, journaled undo)
  workers/       search, layout (FA2), betweenness - worker_threads, own connections
src/shared/      types.d.ts — domain + IPC contract types, imported by both sides
src/renderer/    UI (search palette, graph canvas, contact views) — sigma.js lives here
scripts/         generate-fixture.js and other dev tooling
test/            unit + acceptance; fixtures/ holds seeded + corrupt DBs
docs/            all specifications
```

Workers (force layout, betweenness, search) live under `src/main/` or a
`src/workers/` you create; they own their own read-only SQLite connections.

## Non-negotiable guardrails

These are correctness and safety constraints, not style preferences. Violating
any of them is a defect regardless of whether tests pass.

- **Never run force layout or betweenness centrality on the main thread.** Both are worker-only. Betweenness is O(V·E) at 20k — compute on demand, cache it.
- **Never write a plaintext search index or plaintext DB to disk.** Everything lives inside the SQLCipher-encrypted file.
- **Never hard-cascade a user-initiated delete.** Use soft-delete (`deleted_at`) + a recoverable trash view. `ON DELETE CASCADE` in the schema is for integrity of *derived* rows only.
- **Every multi-statement write is a transaction.** Use `db.transaction()`.
- **Take a `VACUUM INTO` backup before every migration.** A half-applied migration is the corruption case this app exists to prevent.
- **All read paths filter `deleted_at IS NULL`.**
- **Renderer is untrusted.** contextIsolation on, sandbox on, nodeIntegration off, strict CSP, no remote content. IPC payloads are validated in the main process before use.
- **One writer.** The single-instance lock is boot-critical; two processes on one SQLite file corrupt it.
- **Dependencies stay current deliberately.** Prefer the latest stable release
  compatible with the shipped Electron/Node runtime, pin direct versions, and
  commit the lockfile. Do not select prerelease/nightly packages or a higher
  `@types/node` major than Electron embeds. Run the full type/test/build/native
  smoke suite after framework, database, or native-module changes.

## Definition of done (per unit of work)

1. Behavior matches the relevant spec section.
2. Acceptance tests for that behavior pass (see the spec's §12 and `docs/TEST_STRATEGY.md`).
3. No guardrail above is violated.
4. Tunables are in `config.js`; types match `types.d.ts`.
5. A short note in the PR/commit on which spec section it satisfies.

## Assumptions made at scaffold time (override if wrong)

JavaScript/CommonJS, npm, GitHub Actions CI, GitHub Releases as the update feed,
`better-sqlite3-multiple-ciphers` for SQLCipher, `sigma.js` v3 for rendering.
These are stated so they're visible; change them deliberately, not by drift.
