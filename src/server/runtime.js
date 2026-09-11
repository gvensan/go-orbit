// runtime.js - the data layer's lifecycle, host-independent.
//
// Boot order (dependency order):   key -> database -> graph -> services
// Shutdown order (strict reverse):  services -> database
//
// The database comes up first and goes down last so durability is always
// guaranteed. Teardown is idempotent and the host wires it to every exit path
// so the service never leaves a dangling WAL behind (the main local-corruption
// risk). Restore swaps the file and leaves the runtime closed; the host then
// exits with the restart code and the supervisor brings a fresh process up.

const fs = require("fs");
const path = require("path");
const config = require("../main/config");
const dbLayer = require("../main/db");
const contactsRepo = require("../main/db/contacts");
const { AppError } = require("../main/ipc/errors");
const { CentralityService } = require("../main/graph/centrality-service");
const { ExploreService } = require("../main/explore/service");
const { GraphStore } = require("../main/graph/store");
const { SearchService } = require("../main/search/service");
const { setTileCacheDir } = require("../main/maptiles");

/**
 * @param {{ paths: ReturnType<typeof import('./paths').resolvePaths>, key: string,
 *           log: { info: (m: string) => void, error: (m: string, e?: unknown) => void },
 *           devSeed?: number }} opts
 */
function bootRuntime({ paths, key, log, devSeed }) {
  setTileCacheDir(paths.tileCacheDir);
  const db = dbLayer.openDatabase({
    dbPath: paths.dbPath,
    backupDir: paths.backupDir,
    key,
    log: (m) => log.info(m),
  });
  const purged = contactsRepo.autoPurge(db, config.trash.autoPurgeDays);
  if (purged) log.info(`[trash] auto-purged ${purged} contact(s) trashed > ${config.trash.autoPurgeDays} days`);
  const graph = new GraphStore().hydrate(db);
  log.info(`[graph] hydrated ${graph.order} nodes / ${graph.size} edges`);
  if (devSeed && graph.order === 0) {
    // Dev convenience: ORBIT_DEV_SEED=<n> pre-seeds an empty DB at boot.
    const { seedSample } = require("../main/db/sample");
    const r = seedSample(db, { count: devSeed });
    graph.hydrate(db);
    log.info(`[dev] seeded sample network: ${r.contacts} contacts / ${r.edges} edges`);
  }
  const search = new SearchService({ dbPath: paths.dbPath, key, log: (m) => log.error(m) });
  const centrality = new CentralityService({ dbPath: paths.dbPath, key, log: (m) => log.info(m) });
  const explore = new ExploreService({ db, graph });
  const backupTimer = dbLayer.startBackupScheduler(db, paths.backupDir, {
    key,
    log: (m) => log.info(m),
    onError: (e) => log.error(`[backup] failed: ${e.message}`),
  });

  const rt = {
    db,
    graph,
    search,
    centrality,
    explore,
    /** @type {NodeJS.Timeout | null} */
    backupTimer,
    closed: false,
    /** @type {Promise<void>} pending worker shutdown after a restore */
    closing: Promise.resolve(),
    teardown,
    restoreSnapshot,
    restoreLatest,
  };

  /** @returns {Promise<void>} resolves once the search worker has exited */
  function stopServices() {
    if (rt.backupTimer) {
      clearInterval(rt.backupTimer);
      rt.backupTimer = null;
    }
    let closing = Promise.resolve();
    if (rt.search) {
      // Graceful, and awaited by the host before it exits: a worker torn down
      // mid-load aborts the process, which launchd would read as a crash.
      closing = rt.search.terminate().then(() => undefined, () => undefined);
      rt.search = null;
    }
    rt.centrality = null; // its worker exits on its own
    return closing;
  }

  /** Idempotent, strict reverse order. The database work is synchronous; the
   *  returned promise settles when the search worker has actually exited. */
  function teardown() {
    if (rt.closed) return Promise.resolve();
    rt.closed = true;
    log.info("[shutdown] tearing down components");
    const closing = stopServices();
    if (rt.db) {
      if (config.backup.onExit) {
        try {
          dbLayer.takeBackup(rt.db, paths.backupDir, { key });
        } catch (e) {
          log.error(`[shutdown] final backup skipped: ${e.message}`);
        }
      }
      try {
        dbLayer.checkpointAndClose(rt.db);
      } catch (e) {
        log.error(`[shutdown] db close error: ${e.message}`);
      }
      rt.db = null;
    }
    rt.graph = null;
    log.info("[shutdown] clean");
    return closing;
  }

  /** Swap in a verified snapshot. Leaves the runtime closed; the host restarts. */
  function restoreSnapshot(target) {
    if (rt.closed) throw new AppError("LOCKED", "Orbit is already restarting.");
    if (!dbLayer.verifySnapshot(target, key)) {
      throw new AppError("VALIDATION", "That backup can't be opened; nothing was changed.");
    }
    // Copy the chosen snapshot aside FIRST: the safety-net backup below can
    // rotate files out (keep-N), and a user might pick the oldest one.
    const stash = paths.dbPath + ".restore-src";
    fs.copyFileSync(target, stash);
    // Safety net: the pre-restore state becomes a snapshot too, so a mistaken
    // restore is itself reversible, and a failed swap below rolls back to it.
    const safety = dbLayer.takeBackup(rt.db, paths.backupDir, { key });

    rt.closed = true; // teardown must not double-close what we close here
    rt.closing = stopServices(); // the host awaits this before restarting
    dbLayer.checkpointAndClose(rt.db);
    rt.db = null;
    try {
      dbLayer.replaceDatabaseFile(paths.dbPath, stash);
    } catch (err) {
      // Disk full or permissions mid-swap: put the pre-restore database back so
      // the restart (which the host still performs) comes up on known data.
      log.error("[restore] swap failed; rolling back to the safety snapshot", err);
      try { dbLayer.replaceDatabaseFile(paths.dbPath, safety); } catch (e2) { log.error("[restore] rollback failed", e2); }
      try { fs.unlinkSync(stash); } catch { /* best effort */ }
      throw new AppError("INTERNAL", "The backup could not be copied into place; your previous data was kept.");
    }
    try { fs.unlinkSync(stash); } catch { /* already moved */ }
    log.info(`[restore] replaced database with ${path.basename(target)}; restart pending`);
    return { ok: true, restoredFrom: path.basename(target) };
  }

  function restoreLatest() {
    const snaps = dbLayer.listBackups(paths.backupDir);
    const target = snaps.find((s) => dbLayer.verifySnapshot(s, key));
    if (!target) throw new AppError("NOT_FOUND", "No verified backup snapshot to restore.");
    return restoreSnapshot(target);
  }

  return rt;
}

module.exports = { bootRuntime };
