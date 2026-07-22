# Orbit - Application Requirements & Feature Specification

**Product:** Orbit - an Electron desktop CRM that stores contacts as a relationship graph
**Status:** Ready for implementation
**Audience:** Claude Code
**Scale target:** 20,000 contacts, ~200,000 edges, single-device, offline-first

**Sub-specifications:**
- `SEARCH_REQUIREMENTS.md` — search capability (referenced in §6, §9)
- `GRAPH_CANVAS_REQUIREMENTS.md` — graph visualization + canvas (referenced in §6, §9)
- `main.js` — lifecycle orchestrator (boot/shutdown, self-healing DB, backups)

---

## 1. Goal

A personal relationship intelligence tool. It manages contacts, but its thesis is the *graph between them* — who knows whom, how you know someone, who your connectors are. Everything is local, private, and durable: one encrypted file on one device, corruption-proof, with search and the graph as the two primary surfaces.

Success is three properties. **Durable:** data survives crashes, power loss, and bad updates without corruption, and is always recoverable. **Private:** the entire social graph is encrypted at rest and never leaves the device unless the user exports it. **Fluid:** search and graph navigation are fast and forgiving at full scale.

## 2. Intent

Local-first, single-device, no server, no account. The app is the whole system. Cross-device is handled by explicit export/import, not sync — a deliberate scope decision that removes conflict-resolution complexity and makes export/import a first-class, tested feature. Node size encodes centrality, edges are typed, search is the command surface, and the data layer is engineered to never lose or corrupt a user's network.

## 3. Users & use case

A single owner curating a large personal or professional network — hundreds to tens of thousands of contacts — who wants to see structure, trace connections, and find people forgivingly. No multi-user, no roles, no collaboration in v1.

## 4. Stack

- **Shell:** Electron. `contextIsolation` on, sandboxed renderer, `nodeIntegration` off, validated IPC bridge.
- **Store:** SQLite via `better-sqlite3-multiple-ciphers` (SQLCipher, AES-256), WAL mode. Single encrypted file.
- **Graph model:** `graphology` in-memory, hydrated from SQLite at boot.
- **Graph render:** `sigma.js` v3 (WebGL) over graphology. Layout via `graphology-layout-forceatlas2` in a worker.
- **Search:** SQLite FTS5 (fielded, prefix, trigram, diacritic-folding) + a JS fuzzy re-rank, on a read-only worker connection.
- **Key management:** OS keychain via Electron `safeStorage`.
- **Build/distribution:** `electron-builder` on a GitHub Actions matrix (`macos`, `ubuntu`, `windows`); `electron-updater` for delivery.
- **Observability:** `electron-log` local logs; opt-in Sentry, PII-scrubbed.

## 5. Architecture

Local-first, main-process-orchestrated. Boot brings components up in dependency order — single-instance lock → database (self-healing open) → in-memory graph → services (backup scheduler) → IPC → window — and shutdown tears them down in strict reverse, wired to every exit path so no unclean WAL is ever left behind. The renderer holds a graphology instance built from IPC-delivered `nodes`/`links` (identical shape to the SQLite hydration). Heavy work — force layout, betweenness centrality, search — runs on worker/read-only connections so the main thread stays responsive. Details in `main.js`.

## 6. Feature requirements

### Must-have

| Area | Feature | Detail |
|---|---|---|
| Contacts | CRUD + flexible schema | JSON `fields` column; contacts carry uneven attributes |
| Contacts | Soft-delete | `deleted_at` + recently-deleted view; never silent cascade |
| Relationships | Typed, directed edges | `source/target/type/directed/metadata`; graph-native storage from day one |
| Import | vCard + CSV | adoption gate; dedup runs on import |
| Export | Portable archive | contacts + edges as NDJSON with schema version; optional passphrase; the device-migration + backup-portability path |
| Search | Global fuzzy search | see `SEARCH_REQUIREMENTS.md` (Must) |
| Graph | Interactive graph at scale | see `GRAPH_CANVAS_REQUIREMENTS.md` (Must) |
| Data protection | Corruption-proof storage | WAL, transactions, integrity checks, single-instance lock |
| Data protection | Backup + restore | `VACUUM INTO` snapshots, verify, rotate, self-heal on boot |
| Data protection | Encryption at rest | SQLCipher; key in OS keychain via `safeStorage` |
| Migrations | Versioned schema | `PRAGMA user_version`, forward-only, pre-migration backup, auto-rollback |
| Lifecycle | Clean boot + shutdown | see `main.js`; ordered up, reverse teardown, all exit paths |
| Distribution | Cross-platform build | mac/win/linux via CI matrix; each OS rebuilds its own native module |
| Security | Renderer hardening | contextIsolation, sandbox, CSP, validated + whitelisted IPC |

### Need-to-have

| Area | Feature | Detail |
|---|---|---|
| Contacts | Interaction timeline + notes | per-contact history; feeds search recency ranking |
| Contacts | Tags / groups | normalized tags for filtering + facets |
| Dedup | Identity resolution + merge | two-phase, human-in-the-loop; edge re-pointing; field union; undo log |
| Search | Filters, operators, graph-aware, did-you-mean | see sub-spec (Need) |
| Graph | Shortest path, centrality, clustering, filters | see sub-spec (Need) |
| Distribution | Code signing + notarization | mac `notarytool`, Windows signing; required for auto-update |
| Distribution | Auto-update | `electron-updater` + release feed; backup before applying |
| UX | Responsive desktop layout | min window size; reflow (constant node size), not uniform zoom |
| Observability | Local logging | `electron-log`, rotating, in `userData` |
| Observability | Crash reporting (opt-in) | Sentry opt-in, PII-scrubbed |
| Quality | Recovery + migration + export tests | corruption self-heal, migration-forward, export→import fidelity |

### Nice-to-have

| Area | Feature | Detail |
|---|---|---|
| Contacts | Follow-up nudges | "no contact with X in N months" |
| Enrichment | Email/LinkedIn enrichment | scope realistically against API limits |
| Search | NL queries, history, learning, semantic | see sub-spec (Nice) |
| Graph | Minimap, image/GraphML export, saved layouts, overlays | see sub-spec (Nice) |
| Export | GraphML network export | for external graph tooling |
| Observability | In-app diagnostics panel | logs, DB health, backup status |

**Post-M5 additions** (each a deliberate amendment logged in `DECISIONS.md`,
which is authoritative for anything not in the tables above): owner profile
("you" as an inner-circle contact), Explore (faceted people-search), Find
(structured query builder), Insights page + breakdowns, saved searches, quick
add, keep-in-touch cadence + starred, Geomap (offline vector fallback with
default-on, user-disableable OSM tiles), online location search/backfill, sample datasets,
clear-all, native menu + sidebar chrome.

## 7. Data model

Target schema (authoritative; both sub-specs assume `deleted_at` and the interaction timeline):

```sql
CREATE TABLE contacts (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  fields     TEXT,                    -- flexible JSON schema
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                  -- soft-delete; NULL = live
);

CREATE TABLE edges (
  source_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  target_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  directed   INTEGER NOT NULL DEFAULT 0,
  metadata   TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id, type)
);
CREATE INDEX idx_edges_source ON edges(source_id);
CREATE INDEX idx_edges_target ON edges(target_id);

CREATE TABLE interactions (             -- per-contact timeline; feeds recency ranking
  id         INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  occurred_at INTEGER NOT NULL,
  kind       TEXT,                      -- call, email, meeting, note...
  note       TEXT
);
CREATE INDEX idx_interactions_contact ON interactions(contact_id, occurred_at DESC);

CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE contact_tags (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);
```

Search projection and FTS5/trigram tables are defined in `SEARCH_REQUIREMENTS.md §6`. Schema version tracked via `PRAGMA user_version`. All read paths filter `deleted_at IS NULL`.

## 8. Cross-cutting requirements

- **Durability:** every multi-statement write in a transaction; `quick_check` on boot with auto-restore; final checkpoint + close on every exit path.
- **Privacy:** encrypted at rest; no telemetry by default; crash reporting opt-in and scrubbed. Online maps and location search are enabled by default and user-disableable: the **main process** fetches geocoding and OSM/CARTO tiles, while the renderer keeps `connect-src 'none'`. Viewed map areas and location query strings go to those providers; names, relationships, notes, and the contact graph do not.
- **Portability:** SQLite's file format is cross-platform, so a backup or export from one OS restores on another. Export archives are the disaster-recovery and device-migration floor.
- **Security:** hardened renderer; validated IPC; no remote content, scripts, or fonts at runtime.
- **Performance:** heavy compute (layout, betweenness, search) off the main thread; interactive framerate and sub-50 ms search at full scale.

## 9. Non-goals (v1)

Multi-device sync, cloud storage, accounts, multi-user/collaboration, server-side anything, 3D graph rendering, mobile, and semantic/vector search. Cross-device is export/import only. (Geographic rendering was originally a non-goal; the Geomap amendment in `DECISIONS.md` superseded that with detailed online tiles and an offline vector fallback.)

## 10. Acceptance criteria (app-level)

Feature-level criteria live in the sub-specs (`SEARCH_REQUIREMENTS.md §12`, `GRAPH_CANVAS_REQUIREMENTS.md §12`). App-level, each automated:

1. **Corruption recovery:** a corrupted DB on boot is quarantined and the newest good snapshot restored.
2. **Backup/restore round-trip:** snapshot → restore reproduces contacts, edges, and interactions exactly.
3. **Export/import fidelity:** export → fresh import reproduces the graph identically (the device-migration guarantee).
4. **Encryption:** the app runs against a SQLCipher DB; no plaintext DB or index exists on disk.
5. **Migration:** every migration runs forward on a fixture; a failed migration rolls back and restores.
6. **Clean shutdown:** no exit path leaves a dangling WAL.
7. **Single instance:** a second launch focuses the existing window rather than opening a second writer.
8. **Cross-platform build:** the CI matrix produces signed/notarized artifacts for mac, Windows, and Linux.
9. **Soft-delete:** deleted contacts never appear in search, graph, or lists.

## 11. Build roadmap

Milestones sequence the whole app; the two sub-specs phase internally within M3–M5.

- **M0 — Foundation.** Repo, lifecycle orchestrator (`main.js`), schema + migration runner, encrypted DB open, backup/restore + self-heal.
- **M1 — Core data.** Contact CRUD + flexible fields, soft-delete, typed edges, tags, interaction timeline, graphology hydration.
- **M2 — Ingest.** vCard + CSV import, export archive (device-migration path), dedup-on-import.
- **M3 — Graph.** `GRAPH_CANVAS_REQUIREMENTS.md` phases 0–2 (renderer, interactions, worker layout).
- **M4 — Search.** `SEARCH_REQUIREMENTS.md` phases 0–2 (index, pipeline, palette).
- **M5 — Intelligence.** Graph analytics + clustering (graph spec 3–4), search filters/operators/did-you-mean (search spec 3–4), search↔graph integration, dedup/merge UI.
- **M6 — Distribution & hardening.** Cross-platform CI, signing/notarization, auto-update, logging + crash reporting, security hardening, full recovery/migration/export test suites.

## 12. Handoff notes for Claude Code

- Suggested layout: `main/` (lifecycle, IPC, DB, backups), `workers/` (layout, search, metrics), `renderer/` (UI, sigma), `db/migrations/`, `shared/` (types, config).
- One authoritative config module for all tunables (search weights, backup interval/rotation, layout params, min window).
- The three documents form one set: this file is the umbrella; the search and graph specs are the depth; `main.js` is the lifecycle reference. Build in milestone order (§11); each sub-spec's phases nest into M3–M5.
- Never compute betweenness centrality or run layout on the main thread; never write a plaintext index; never hard-cascade a delete without soft-delete + undo.
- Ship each milestone behind its acceptance tests. Treat the earlier SVG/d3 graph prototype as disposable — semantics only, not the rendering approach.
