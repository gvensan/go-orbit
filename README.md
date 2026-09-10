# Orbit

A local-first CRM that stores your contacts as an **encrypted relationship
graph**, with you at the centre. Two primary surfaces: a forgiving search
palette and an interactive WebGL graph. Single machine, offline, private.

Orbit runs as a small Node service on your own computer and its UI is a page in
your browser. Nothing is compiled, nothing sits in your menu bar, and nothing
about your contacts leaves the machine: the database is one SQLCipher-encrypted
file in `~/.orbit`, and the key lives in your OS keychain.

Target scale: **20,000 contacts, ~200,000 edges.**

## Install

Requires Node 24 LTS. On macOS the service is registered as a login agent;
elsewhere it runs in the foreground (or under your own supervisor).

```bash
curl -fsSL https://raw.githubusercontent.com/gvensan/my-orbit/main/install.sh | bash
```

That downloads Orbit to `~/orbit` (set `ORBIT_DIR` to choose another folder).
Developers can clone instead:

```bash
git clone https://github.com/gvensan/my-orbit.git ~/orbit
cd ~/orbit && ./install.sh
```

The installer installs dependencies (the encrypted SQLite addon arrives prebuilt,
no compiler needed), builds the UI, starts the service on `http://localhost:7779`,
and opens it in your browser. The link it opens carries your session, so use
`bin/orbit open` whenever you want a new browser to see Orbit; a browser without
a session sees a locked page and nothing else.

```bash
bin/orbit open              # open the UI (unlocks this browser)
bin/orbit status | doctor   # is it running, and if not, why
bin/orbit update            # pull the newest code, rebuild, restart
bin/orbit stop | start | restart
bin/orbit logs              # follow the service log
bin/orbit run               # run in the foreground (any OS)
./uninstall.sh [--purge]    # remove the agent; --purge also deletes ~/.orbit and the key
```

`ORBIT_HOME` moves the data folder; `ORBIT_PORT` changes the port (default in
`src/main/config.js`).

**Add to Orbit** is a button for your bookmarks bar (Settings > Setup): on a
LinkedIn profile or any page that names someone, click it and Orbit opens with
that person drafted (name, role, company, link, selected text as notes), checks
whether you already have them, asks how you know them, and opens their card.

The first time you open Orbit, **Settings > Setup** lists the one-time steps
(who you are, your people, backups, starting at login, the online-maps choice)
with the exact thing to do for each. It stays in the sidebar until the required
steps are done, then lives under Settings.

## Development

```bash
npm install          # deps; the SQLCipher addon is prebuilt for Node 24
npm run dev          # build the UI, then start the service
npm run dev:watch    # vite --watch + node --watch; the page reloads itself
npm test             # node --test, plain Node
npm run typecheck    # tsc --checkJs against the shared type contract
npm run fixture      # (optional) seed a 20k-contact clustered test DB
```

Requires Node 24 LTS (24.18+); use `.nvmrc`. Dev runs use your real `~/.orbit`
unless you set `ORBIT_HOME`; `ORBIT_DEV_SEED=300` seeds an empty database.

## What to read

Start with **`CLAUDE.md`** (repo orientation + guardrails), then the docs:

| Doc | Covers |
|---|---|
| `docs/APP_REQUIREMENTS.md` | Umbrella: features (must/need/nice), stack, schema, roadmap |
| `docs/INTERFACE_CONTRACT.md` | Channels, payloads, shared types - the boundary between UI and service |
| `docs/SEARCH_REQUIREMENTS.md` | Fuzzy search: two-stage retrieval, ranking, acceptance tests |
| `docs/GRAPH_CANVAS_REQUIREMENTS.md` | WebGL graph: renderer, interactions, analytics |
| `docs/EXPORT_IMPORT_REQUIREMENTS.md` | Portable archive: format, encryption, device migration |
| `docs/DEDUP_MERGE_REQUIREMENTS.md` | Identity resolution and safe merge |
| `docs/APP_SHELL_UX.md` | Screen map, design system, keyboard model, error states |
| `docs/BUILD_AND_RELEASE.md` | Install, the login agent, updates |
| `docs/TEST_STRATEGY.md` | Test layers, fixtures, recovery harness |
| `docs/SECURITY_AND_THREAT_MODEL.md` | Threat model, encryption, key management, the session |
| `docs/DECISIONS.md` | Deliberate amendments to the scaffold, newest first |

## Architecture at a glance

- **Node HTTP service** (`src/server/`) on loopback: session cookie, Host/Origin
  guards, strict CSP, static UI, one RPC endpoint per channel.
- **SQLite/SQLCipher** (`better-sqlite3-multiple-ciphers`), one encrypted file,
  WAL. Key in the OS credential store (`security`, `secret-tool`, DPAPI).
- **graphology** in-memory model in the service; **sigma.js** (WebGL) in the
  browser, bundled by Vite; deterministic layouts in the page, betweenness on a
  worker thread.
- **FTS5 + JS fuzzy re-rank** for search, on a read-only worker connection.
- Lifecycle in `src/server/server.js` + `runtime.js`; data layer (self-healing
  open, backups, migrations) in `src/main/db/`; every channel in one validated
  registry (`src/main/ipc/registry.js`), mirrored in the browser by
  `src/shared/api-map.js` + `src/renderer/web-api.js`.

## History

Orbit began as an Electron desktop app. The engine and the UI carried over
unchanged when it became a local service; `docs/DECISIONS.md` (2026-09-10)
records what moved where and why.
