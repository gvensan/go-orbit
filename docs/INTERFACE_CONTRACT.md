# Interface Contract — IPC & Shared Types

**Status:** Authoritative. Build renderer, main, and workers against this.
**Types:** `src/shared/types.d.ts` (imported by both sides).

The renderer never touches SQLite, the filesystem, or a worker directly. It
speaks only to the main process, over the channels below, through the preload
bridge. This is both a security boundary (untrusted renderer) and the seam that
lets main, renderer, and workers be built independently.

## 1. Boundary rules

- The preload script (`src/main/preload.js`) exposes exactly one namespaced API on `window.api`, one method per channel. No raw `ipcRenderer`, no Node globals, reach the renderer.
- Every channel is request/response via `ipcRenderer.invoke` / `ipcMain.handle` — promise-based, so the renderer awaits typed results.
- The main process **validates every request payload** against its declared shape before acting. Invalid payloads reject with `IpcError { code: "VALIDATION" }`. Never trust a payload because the renderer "should" have sent the right thing.
- Responses and rejections use the shapes in `types.d.ts`. Errors always reject with `IpcError`; they are never resolved as a success value.

## 2. Channel catalogue

The full map is `IpcContract` in `types.d.ts` (the authoritative list;
`test/ipc-contract.test.js` asserts registry, preload, and `IpcContract`
declare identical channels). Summary by namespace of who does the work and on
which thread:

| Namespace | Channels | Runs where | Notes |
|---|---|---|---|
| `contacts:*` | list, get, create, update, softDelete, restore, purge, setTags | main, sync | `better-sqlite3` synchronous CRUD in a transaction; purge is trash-only; softDelete refuses the owner contact |
| `edges:*` | create, delete, list, update | main, sync | validates both endpoints exist and are live |
| `interactions:*` | list, add | main, sync | feeds search recency ranking |
| `profile:*` | get, set, setOwner | main, sync | owner ("you") contact backed by `app_meta` (see DECISIONS.md) |
| `tags:list` | | main, sync | normalized tag universe |
| `graph:*` | snapshot, ego, path, centrality, layoutStart, layoutStop, savePositions | main (graphology) | snapshot hydrates `nodes`/`links`; ego/path are cheap BFS. `centrality` with `betweenness` runs in a **worker** (O(V·E), on-demand, cached, never main thread); `degree` is trivial and stays on main |
| `search:query` | | **search worker** | read-only connection; two-stage retrieval; cancellable; operators ride inside `text` |
| `explore:*`, `find:query` | query, fieldValues | main (in-memory index) | faceted people-search over `ExploreService` rows, rebuilt on `markDirty()` |
| `insights:*` | summary, extended, breakdown | main | network stats, overdue/dormant, breakdowns |
| `searches:*` | list, save, delete | main, sync | saved searches (`kind` text or find) |
| `location:*`, `map:tile` | search, online, setOnline, backfill | main (fetch) | Online geocoding + OSM tiles are enabled by default and user-disableable via `location.online`; the renderer never touches the network (`connect-src 'none'`), tiles return as `data:` URLs |
| `backup:*` | now, status, list, restoreLatest, restore | main, sync | `VACUUM INTO` + verify + rotate; restore relaunches |
| `update:*` | status, check, install | main | Packaged builds only; `install` applies a downloaded update on quit, enabled only after a verified backup |
| `export:*` | archive, graphml, image, csv | main | dialog-granted paths only; archive adds optional passphrase encryption; `csv` writes a contacts sheet, with relationship detail rows when `includeDetails` is set |
| `import:*` | preview, parse, file, archive, records | main | dialog-granted paths only; snapshot backup **before** any bulk write; validate version → dedup → merge. `parse` turns a vCard/CSV into rows (optional column mapping) for the wizard; `records` imports already-mapped rows under a `skip`/`merge`/`keepBoth` policy |
| `dedup:*` | candidates, merge, undo | main | journaled merges (`merge_log`), undoable |
| `dialog:*` | openFile, saveFile | main | the only way a path becomes granted for import/export |
| `data:*` | clearAll, seedSample, sampleStatus | main | clearAll takes a safety backup first; seedSample powers samples/first-run |

Two channels are event streams, not request/response, exposed as
subscribe/unsubscribe functions on `window.api`:

- `graph:layout:tick` - the main-side layout worker streams node positions;
  positions are persisted so reopening is instant.
- `app:menu` - native menu command ids forwarded to the renderer's command
  router.

## 3. Cancellation

`search:query` carries a monotonic `requestId`. The renderer increments it per
keystroke (after debounce). The search worker tags each `SearchResponse` with
the originating `requestId`; the renderer discards any response whose id is not
the latest. The worker may also abandon in-flight work when a newer id arrives.

## 4. Error semantics

| Code | Meaning |
|---|---|
| `VALIDATION` | Payload failed shape/bounds checks. Never reached the data layer. |
| `NOT_FOUND` | Referenced id does not exist or is soft-deleted. |
| `CONFLICT` | Uniqueness or edge-duplicate violation. |
| `LOCKED` | DB busy beyond `busy_timeout`, or a restore/migration is in progress. |
| `INTERNAL` | Unexpected; logged with a correlation id, message scrubbed of PII. |

The renderer maps these to the UX states in `docs/APP_SHELL_UX.md` (§ error &
recovery). It never shows a raw stack trace.

Transport detail: Electron strips custom properties from errors crossing IPC,
so main serializes the `IpcError` into the Error message behind an `IPCERR:`
marker and the preload bridge re-hydrates it. Renderer code just sees a
rejected promise carrying `{ channel, code, message }`.

## 5. Adding a channel

1. Add the entry to `IpcContract` in `types.d.ts` (request + response shapes).
2. Register a validated `ipcMain.handle` in the main process.
3. Expose one method on `window.api` in `preload.js`.
4. Decide the thread: anything O(V·E) or heavier than a point query goes to a worker with its own read-only connection.
5. Add it to the table in §2 and cover it in tests.

Never widen the bridge with a generic passthrough. One method per channel, typed
and validated, is the whole point.
