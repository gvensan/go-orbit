# Interface Contract - Channels & Shared Types

**Status:** Authoritative. Build the browser UI, the service, and workers against this.
**Types:** `src/shared/types.d.ts` (imported by both sides).

The page never touches SQLite, the filesystem, or a worker directly. It speaks
only to the local service, over the channels below, through the browser bridge.
This is both a security boundary (the page is untrusted) and the seam that lets
the UI, the service, and workers be built independently. The channel names and
payload shapes predate the service and are unchanged from the desktop build;
only the transport moved.

## 1. Boundary rules

- The bridge (`src/renderer/web-api.js`) exposes exactly one namespaced API on `window.api`, one method per channel, built from the single table in `src/shared/api-map.js`. No raw `fetch` to the service anywhere else in the UI.
- Every channel is request/response: `POST /api/rpc/<channel>` with the request payload as the JSON body, answered by `{ ok: true, result }` or `{ ok: false, error: IpcError }`. Promise-based on the page, so the UI awaits typed results.
- The service **validates every request payload** against its declared shape before acting. Invalid payloads reject with `IpcError { code: "VALIDATION" }`. Never trust a payload because the page "should" have sent the right thing.
- Responses and rejections use the shapes in `types.d.ts`. Errors always reject with `IpcError`; they are never resolved as a success value.
- Every request carries the session cookie (`SECURITY_AND_THREAT_MODEL.md` §5). Without it the RPC endpoint is 401 and the bridge sends the page back to the locked screen.

## 2. Channel catalogue

The full map is `IpcContract` in `types.d.ts` (the authoritative list;
`test/ipc-contract.test.js` asserts registry, `api-map.js`, and `IpcContract`
declare identical channels). Summary by namespace of who does the work and on
which thread:

| Namespace | Channels | Runs where | Notes |
|---|---|---|---|
| `contacts:*` | list, get, create, update, softDelete, restore, purge, setTags | service, sync | `better-sqlite3` synchronous CRUD in a transaction; purge is trash-only; softDelete refuses the owner contact; `get` resolves `null` for a miss |
| `edges:*` | create, delete, list, update | service, sync | validates both endpoints exist and are live |
| `interactions:*` | list, add | service, sync | feeds search recency ranking |
| `profile:*` | get, set, setOwner | service, sync | owner ("you") contact backed by `app_meta` (see DECISIONS.md) |
| `tags:list` | | service, sync | normalized tag universe |
| `graph:*` | snapshot, ego, path, centrality | service (graphology) | snapshot hydrates `nodes`/`links`; ego/path are cheap BFS. `centrality` with `betweenness` runs in a **worker** (O(V·E), on-demand, cached, never the request thread); `degree` is trivial and stays inline. Layout is deterministic and runs in the page (DECISIONS.md, 2026-08-06) |
| `search:query` | | **search worker** | read-only connection; two-stage retrieval; cancellable; operators ride inside `text` |
| `explore:*`, `find:query` | query, fieldValues | service (in-memory index) | faceted people-search over `ExploreService` rows, rebuilt on `markDirty()` |
| `insights:*` | summary, extended, breakdown | service | network stats, overdue/dormant, breakdowns |
| `searches:*` | list, save, delete | service, sync | saved searches (`kind` text or find) |
| `location:*`, `map:tile` | search, online, setOnline, backfill | service (fetch) | Online geocoding + map tiles are enabled by default and user-disableable via `location.online`; the page never touches a third party (`connect-src 'self'`), tiles return as `data:` URLs |
| `backup:*` | now, status, list, restoreLatest, restore, delete | service, sync | `VACUUM INTO` + verify + rotate; restore swaps the file, then the service exits with the restart code and the bridge reloads once the new process answers |
| `update:*` | status, check, install | service | "ready" means newer code is on disk than the running process loaded (`bin/orbit update`); `install` takes a verified backup, then restarts |
| `export:*` | archive, graphml, image, csv | service | granted export slots only (§6); archive adds optional passphrase encryption; `csv` writes a contacts sheet, with relationship detail rows when `includeDetails` is set |
| `import:*` | preview, parse, match, file, archive, records, writeResults | service | granted upload paths only (§6); snapshot backup **before** any bulk write; validate version → dedup → merge. `parse` turns a vCard/CSV into rows (optional column mapping); `match` is a **read-only** preview that ranks existing-contact candidates per incoming record (advisory only); `records` imports rows under a `skip`/`merge`/`keepBoth` policy that a per-record `decision` (`ignore`/`new`/`merge`) may override; `writeResults` writes an annotated results CSV (`orbit_status`) to a granted export slot |
| `dedup:*` | candidates, merge, undo | service | journaled merges (`merge_log`), undoable |
| `health:*` | scan, last, setStatus, fix | service | Data review (Settings > Review). `scan` runs every check and returns `HealthFinding[]` with stable fingerprints; `last` returns the persisted previous result or null; `setStatus` records per-finding triage (`open`/`ignored`/`deferred`); `fix` applies one whitelisted repair (`remove-edge`, `canonicalize-edge`, `clear-kin`, `clear-stray-kin`, `strip-gender`, `clear-cadence`, `purge-orphans`), each idempotent, transactional, and no more powerful than an existing public channel |
| `setup:*` | status, mark | service | Settings > Setup checklist. `status` builds the steps from live state (owner set, own contacts present, backups, launchd, key store, online preference) plus the user's manual marks in `app_meta` (`setup.done`); `mark` records a manual mark and refuses auto-checked step ids |
| `dialog:*` | openFile, saveFile | **browser** | never an RPC (the service answers 404); the bridge runs a file picker + upload, or reserves an export slot (§6) |
| `data:*` | clearAll, seedSample, sampleStatus | service | clearAll takes a safety backup first; seedSample powers samples/first-run |

Two entries on `window.api` are subscriptions rather than request/response:

- `app.onMenu(cb)` - command ids (`new-contact`, `list`, `import`, `settings`)
  from the bridge's browser-safe shortcuts, routed to the UI's command router.
  There is no native menu; every command is also on the sidebar or in the palette.
- `updates.onStatus(cb)` - the bridge polls `update:status` every
  `config.server.statusPollMs` and calls back on change.

## 3. Cancellation

`search:query` carries a monotonic `requestId`. The page increments it per
keystroke (after debounce). The search worker tags each `SearchResponse` with
the originating `requestId`; the page discards any response whose id is not
the latest. The worker may also abandon in-flight work when a newer id arrives.

## 4. Error semantics

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION` | 400 | Payload failed shape/bounds checks. Never reached the data layer. |
| `NOT_FOUND` | 404 | Referenced id does not exist or is soft-deleted. |
| `CONFLICT` | 409 | Uniqueness or edge-duplicate violation. |
| `LOCKED` | 423 | DB busy beyond `busy_timeout`, or a restore/migration is in progress. |
| `INTERNAL` | 500 | Unexpected; logged with a correlation id, message scrubbed of PII. |

The page maps these to the UX states in `docs/APP_SHELL_UX.md` (§5). It never
shows a raw stack trace.

Transport detail: the service serializes `IpcError` as the JSON body
`{ ok: false, error: { channel, code, message } }` with the status above; the
bridge rehydrates it into a rejected promise carrying `{ channel, code, message }`.
Two conditions arise from the transport itself and are mapped by the bridge:
the service unreachable (network failure → `INTERNAL`, plus the offline banner)
and the service restarting (503 → `LOCKED`, "Orbit is restarting").

## 5. Adding a channel

1. Add the entry to `IpcContract` in `types.d.ts` (request + response shapes) and the method to `RendererApi`.
2. Register a validated `{ validate, handle }` entry in `src/main/ipc/registry.js`.
3. Add the method → channel mapping to `src/shared/api-map.js` (the bridge builds `window.api` from it; nothing else to write).
4. Decide the thread: anything O(V·E) or heavier than a point query goes to a worker with its own read-only connection.
5. Add it to the table in §2 and cover it in tests. `test/ipc-contract.test.js` fails until all three declarations agree.

Never widen the bridge with a generic passthrough. One method per channel, typed
and validated, is the whole point.

## 6. Files: uploads and export slots

The page cannot name a filesystem path, so the service mints them:

- `POST /api/files/upload?name=<file name>` with the file as the body stores it
  under `<home>/uploads/<slot>/<name>` and returns `{ path }`. The path is
  **granted** for this process; import channels accept it in `srcPath` exactly
  as they accepted a dialog-chosen path. Only `.vcf`, `.vcard`, `.csv`, `.orbit`.
- `POST /api/files/export-slot` `{ defaultName }` returns a granted `{ path }`
  under `<home>/exports/<slot>/<name>`; the export channel writes it, then
  `GET /api/files/download?path=` streams it **once** and deletes the slot.
- `&keep=1` on the download keeps the slot readable afterwards instead of
  deleting it; the bridge uses it for `import:writeResults`, whose results CSV
  the wizard reopens with "Save and reload".
- Anything not granted is `VALIDATION` on the channel and 404 on download.
  Slots expire when idle (`config.server.uploadTtlMs`, `exportTtlMs`); every
  channel read refreshes the slot, so a flow in progress never loses its file.
  All slots are wiped at boot.

## 7. Other routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | liveness: version, pid, `startedAt`, `restarting`, `restartNeeded`, `rendererBuiltAt`. No data. |
| `GET /?token=<hex64>` | the token | one-time exchange for the session cookie, then redirect to `/` |
| `GET /`, `/assets/*`, `/favicon.svg` | session | the UI bundle from `dist/renderer` (locked page without a session) |
| `GET /#add=<query>` | session | the Add to Orbit bookmarklet: the hash (url, title, text, og, desc, site) never reaches the service; the app drafts the person (`src/shared/page-guess.js`) and runs its own add-connection flow through `import:match`, `contacts:create` and `edges:create` |
| `GET /api/doctor` | session | `{ checks: [{ id, ok, label, detail, fix }], restartNeeded }` |
