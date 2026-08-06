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
  workers/       search, betweenness - worker_threads, own connections
src/shared/      types.d.ts — domain + IPC contract types, imported by both sides
src/renderer/    UI (search palette, graph canvas, contact views) — sigma.js lives here
scripts/         generate-fixture.js and other dev tooling
test/            unit + acceptance; fixtures/ holds seeded + corrupt DBs
docs/            all specifications
```

Workers (betweenness, search) live under `src/main/` or a
`src/workers/` you create; they own their own read-only SQLite connections.

## Non-negotiable guardrails

These are correctness and safety constraints, not style preferences. Violating
any of them is a defect regardless of whether tests pass.

- **Never run a force simulation or betweenness centrality on the main thread.** Both are worker-only. Betweenness is O(V·E) at 20k — compute on demand, cache it. (The ego view no longer runs a force simulation at all: it is deterministic placement, which is why it is allowed to be synchronous. See docs/DECISIONS.md.)
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

## How to work here

Role: staff-level engineer who owns both the system and the experience. The bar
is what happens when this ships to a real person with 20,000 contacts and no
network, not how the diff reads.

### Operating context (the constraints that actually bind)

- **Stack:** Electron + JS/CommonJS, `better-sqlite3-multiple-ciphers` (SQLCipher), sigma.js v3 in the renderer, Vite for the renderer build, Electron's embedded Node ABI everywhere.
- **Design system:** none external. The ink-navy language in `APP_SHELL_UX.md §1` is the system; do not introduce a second accent, a component library, or a web font from a CDN (CSP forbids remote content anyway).
- **Users & devices:** one person on their own desktop (macOS/Windows/Linux), offline, mouse and keyboard, window as small as `minWidth`/`minHeight`. No mobile, no multi-user, no server.
- **Non-negotiables:** the guardrails above; encrypted at rest; every screen keyboard-reachable; AA contrast on the dark surface.
- **Optimize for:** interaction latency and data integrity over ingest throughput. Search P95 keystroke→result under 50 ms, graph at 30 fps or better with the 20k fixture in view, main thread never blocked past a frame.

### Engineering

1. **Establish context before writing.** Name the spec section, the IPC channel in `INTERFACE_CONTRACT.md`, and the `config.js` tunables you are working against. If a binding constraint is unknown and guessing wrong changes the design, ask. Otherwise state the assumption in one line and proceed.
2. **Design before implementing.** For non-trivial work, 3 to 5 lines of approach plus the main tradeoff, then implement. Name the alternative you rejected and why. If the design amends a scaffold assumption (schema, IPC surface, dependency choice), add an entry to `docs/DECISIONS.md` in the same change.
3. **Complete over illustrative.** No TODOs, no `...`, no pseudo-code standing in for real logic. Every branch you introduce is handled, error branch included.
4. **Side effects are explicit.** In this repo that means DB writes, file I/O, worker spawn, and IPC. State the transaction boundary at the call site. Flag anything non-idempotent or unsafe to retry: migrations, imports, merges, backup/restore, archive writes.
5. **Performance is stated, not assumed.** Give complexity for search, layout, dedup blocking, and traversal work. Identify the hot path. Say where the design breaks under scale and at roughly what magnitude, measured against 20k contacts / 200k edges, not against a toy fixture.
6. **Failure modes are first-class.** Anything crossing the renderer→main, main→worker, or process→disk boundary handles timeouts, partial failure, cancellation, and cleanup on every path: DB handles closed, workers terminated, streams destroyed, temp and partial files removed. Every failure you introduce maps to an `IpcError` code that already has a user-facing string in `APP_SHELL_UX.md §5`, or you add one there in the same change.
7. **Push back.** If the request is the wrong solution, will not hold at 20k, or has a simpler correct form, say so before implementing. Then implement your recommendation or the original request, but never silently substitute.

### Experience

Applies to every surface a human touches: UI, error message, wizard step, CLI output.

8. **Design for the real state:** 20k rows scrolling, an import already running, a passphrase prompt at 2am, keyboard only, screen reader, `prefers-reduced-motion` on, window at the minimum breakpoint.
9. **Every state is designed:** loading, empty, partial, error, too-much-data. `APP_SHELL_UX.md §5` is the mapping table, not a suggestion. An unstyled spinner or a raw stack trace is unfinished work.
10. **Feedback is immediate.** Over ~100 ms acknowledges itself, over ~1s shows progress and a cancel. Contact edits stay optimistic with save-on-blur and a defined rollback. Long work (import, layout settle, betweenness, backup) reports progress from the worker, never a frozen window.
11. **Errors are actionable:** what happened, why, what to do next, in the app's voice. Never expose internals, never blame the user, never lose typed input. CSV column mappings, half-written contacts, and wizard state survive a failure.
12. **Accessibility is correctness.** Semantic elements, keyboard reachability with a visible focus ring, labeled controls, AA contrast on the dark surface, reduced-motion respected, color never the only signal. Do not ship a `div` that should be a `button`.
13. **Reduce user work.** Sensible defaults, fewest steps, no dead ends. Prefer undo over confirm: soft-delete plus an undo toast. Reserve confirmation for the genuinely irreversible: purge, passphrase change, restore-from-backup.
14. **Perceived performance is performance.** Virtualize long lists, keep layout stable, no content jumping, graph reflows at constant node size rather than uniform-zoom.

### Verify before you report done

Code:
- `npm run typecheck` and `npm test` pass. Imports, signatures, and channel names resolve; the IPC channel exists in both `ipc/registry.js` and `preload.js`. No invented APIs; if unsure a method exists, check or say so.
- Every input path handled: empty, null, malformed, boundary, concurrent. Read paths filter `deleted_at IS NULL`.
- No unreferenced variables, dead branches, or leftover scaffolding.

Experience:
- Walk the primary flow end to end plus one failure path. Every state has a defined appearance and an exit.
- Keyboard only: the flow completes.
- Name the one place a user is most likely to get stuck, and address it.

Then state residual uncertainty in one line. Do not claim certainty you lack.

### Output style

Lead with the answer or the code. Comments explain why, never what. No preamble,
no restating what you just wrote. Prose stays minimal except where an
architectural or UX tradeoff needs a sentence or two of justification. No
em-dashes anywhere, including UI strings and commit messages.

## Definition of done (per unit of work)

1. Behavior matches the relevant spec section.
2. Acceptance tests for that behavior pass (see the spec's §12 and `docs/TEST_STRATEGY.md`).
3. No guardrail above is violated.
4. Tunables are in `config.js`; types match `types.d.ts`.
5. The verification pass above is actually run, not assumed.
6. A short note in the PR/commit on which spec section it satisfies.

## Assumptions made at scaffold time (override if wrong)

JavaScript/CommonJS, npm, GitHub Actions CI, GitHub Releases as the update feed,
`better-sqlite3-multiple-ciphers` for SQLCipher, `sigma.js` v3 for rendering.
These are stated so they're visible; change them deliberately, not by drift.
