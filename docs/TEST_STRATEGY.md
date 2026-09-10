# Test Strategy

**Status:** Ready for implementation. Woven through all milestones; formalized in M6.
**Principle:** untested backup, restore, and migration code is theater. The paths
that protect data must be exercised, not assumed.

## 1. Layers

- **Unit** — pure logic: ranking math, fuzzy scorers, dedup blocking/scoring, migration ordering, archive (de)serialization, validation of IPC payloads.
- **Integration** — against a real (encrypted) SQLite DB in a temp dir: CRUD + transactions, FTS sync via triggers, soft-delete filtering, backup/restore, migration apply + rollback, export→import round-trip.
- **Acceptance** — the numbered criteria in every spec's §12, run as executable tests. These are the contract.
- **Performance** — search latency and graph framerate/layout against the 20k fixture.

## 2. Fixtures

`scripts/generate-fixture.js` builds a migrated, populated, encrypted 20k-contact
/ ~200k-edge DB, deterministically (seeded RNG) so tests are stable. `--corrupt`
writes a byte-damaged copy for self-heal tests. All heavy tests run against this
fixture; unit tests use tiny inline fixtures.

## 3. Acceptance suite → source of truth

Each spec owns its behavioral tests; the app-level suite owns the guarantees that
span features:

| Suite | Source |
|---|---|
| Search behavior (typo, prefix, diacritics, order, perf, cancellation) | `SEARCH_REQUIREMENTS.md §12` |
| Graph behavior (scale/fps, ego, path, cluster, filter, resize, DPI, off-thread) | `GRAPH_CANVAS_REQUIREMENTS.md §12` |
| Export/import (round-trip, encryption, checksum, versioning, dedup, streaming) | `EXPORT_IMPORT_REQUIREMENTS.md §8` |
| Dedup/merge (blocking, edge/interaction preservation, undo, import parity) | `DEDUP_MERGE_REQUIREMENTS.md §9` |
| App shell (keyboard reach, virtualized list, trash, error states, reduced-motion) | `APP_SHELL_UX.md §7` |
| Build/release (matrix outputs, native load, signing, update, pre-update backup) | `BUILD_AND_RELEASE.md §7` |
| App-level (corruption recovery, clean shutdown, single-instance, soft-delete) | `APP_REQUIREMENTS.md §10` |

## 4. The recovery harness (highest priority — this is why the app exists)

Explicit, automated, non-negotiable:

1. **Corruption self-heal:** boot against `scale.corrupt.db` with a good snapshot present → assert the bad file is quarantined and the newest good snapshot restored, and the app comes up.
2. **Migration rollback:** run a deliberately failing migration → assert the transaction rolled back, the pre-migration backup exists, and the caller restores from it (no half-migrated state).
3. **Backup/restore round-trip:** snapshot → mutate → restore → assert state matches the snapshot exactly.
4. **Export/import round-trip:** export → import into empty → assert graph identity (counts + content), plus the encrypted variant with right/wrong passphrase.
5. **Clean shutdown:** trigger each exit path (before-quit, window-all-closed, SIGINT) → assert no `-wal` remains and the DB reopens clean.

## 5. Performance harness

- **Search:** P95 keystroke→result < 50 ms over the 20k fixture; assert cancellation discards stale results.
- **Graph:** ≥30 fps pan/zoom with the full fixture in view; layout runs off the main thread (assert the main thread stays responsive during settle); betweenness computed on a worker and cached.
- Record numbers per run so regressions are visible.

## 6. CI

- Runs unit + integration + acceptance on every push (Linux runner is enough for logic; the HTTP host is driven end to end on an ephemeral port in test/server-app.test.js).
- The build matrix (`BUILD_AND_RELEASE.md`) runs on tags and includes a post-build smoke test that opens an encrypted DB on each OS.
- Fixtures are generated in-CI (cached) rather than committed.

## 7. Definition of done ties here

A unit of work is done when its spec section's acceptance tests pass and no
guardrail (`CLAUDE.md`) is violated. New behavior ships with the test that proves
it, in the same change.
