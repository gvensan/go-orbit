// db/index.js - encrypted database lifecycle: open, self-heal, back up, close.
//
// This module is Electron-free so the entire data layer runs under plain Node
// in tests. main.js supplies the paths (from userData) and the SQLCipher key
// (from the OS keychain via keys.js). The migration runner is the only schema
// authority; there is deliberately no ad-hoc schema creation here.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");
const config = require("../config");
const { migrate } = require("./migrate");
const { listBackups, rotateBackups } = require("./backup-files");

let backupSeq = 0; // disambiguates backups created within the same millisecond

function applyKey(db, key) {
  db.pragma(`key = '${String(key).replace(/'/g, "''")}'`);
}

function applyPragmas(db) {
  for (const [name, value] of Object.entries(config.db.pragmas)) {
    db.pragma(`${name} = ${value}`);
  }
}

function isHealthy(db) {
  try {
    return db.pragma("quick_check", { simple: true }) === "ok";
  } catch {
    return false;
  }
}

function quarantine(dbPath) {
  try {
    fs.renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`);
  } catch {}
  for (const ext of ["-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + ext); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Backups: VACUUM INTO a temp file, verify, atomic rename, rotate.
// A keyed connection's VACUUM INTO output is itself encrypted with the same key.
// ---------------------------------------------------------------------------

function takeBackup(
  db,
  backupDir,
  /** @type {{ key?: string, keep?: number }} */ { key, keep = config.backup.keep } = {}
) {
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, `contacts-${Date.now()}-${backupSeq++}.db`);
  const tmp = dest + ".tmp";
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);

  const probe = new Database(tmp, { readonly: true });
  if (key !== undefined) applyKey(probe, key);
  let ok = false;
  try {
    ok = probe.pragma("integrity_check", { simple: true }) === "ok";
  } finally {
    probe.close();
  }
  if (!ok) {
    fs.unlinkSync(tmp);
    throw new Error("snapshot failed integrity check");
  }
  fs.renameSync(tmp, dest); // atomic: never a half-written backup

  rotateBackups(backupDir, { keep });
  return dest;
}

function restoreNewestGoodBackup(
  dbPath,
  backupDir,
  /** @type {{ key?: string, log?: (m: string) => void }} */ { key, log = () => {} } = {}
) {
  for (const snap of listBackups(backupDir)) {
    try {
      const probe = new Database(snap, { readonly: true });
      if (key !== undefined) applyKey(probe, key);
      let ok = false;
      try {
        ok = probe.pragma("integrity_check", { simple: true }) === "ok";
      } finally {
        probe.close();
      }
      if (!ok) continue;
      quarantine(dbPath);
      fs.copyFileSync(snap, dbPath);
      log(`[db] restored from backup: ${path.basename(snap)}`);
      return true;
    } catch {
      /* try older snapshot */
    }
  }
  return false;
}

/** Total row changes (INSERT/UPDATE/DELETE) on this connection since it opened.
 *  A monotonic "something changed" signal - reads never bump it. Used to skip a
 *  periodic backup when the database is untouched since the last one. */
function changeCount(db) {
  return db.prepare("SELECT total_changes() AS n").pluck().get();
}

function startBackupScheduler(
  db,
  backupDir,
  /** @type {{ key?: string, log?: (m: string) => void, onError?: (e: Error) => void }} */
  { key, log = () => {}, onError = () => {} } = {}
) {
  // Baseline: the change count when scheduling started (boot). A tick only
  // snapshots when this grows, so an idle app doesn't churn identical backups.
  // The single-writer guardrail means every data change flows through `db`, so
  // total_changes() sees all of it. Event-driven backups (import/migration/
  // manual/exit) stay unconditional; only the periodic tick is change-gated.
  let lastMark = changeCount(db);
  const tick = () => {
    try {
      const mark = changeCount(db);
      if (config.backup.onlyWhenChanged && mark === lastMark) {
        log("[backup] skipped (no changes since last backup)");
        return;
      }
      const f = takeBackup(db, backupDir, { key });
      lastMark = mark;
      log(`[backup] ${path.basename(f)}`);
    } catch (e) {
      onError(e);
    }
  };
  const timer = setInterval(tick, config.backup.intervalMs);
  timer.unref?.(); // never keep the process alive just for backups
  return timer;
}

// ---------------------------------------------------------------------------
// Open: key -> pragmas -> quick_check -> migrate. Self-heals from the newest
// good snapshot when one exists. If neither the live file nor a backup can be
// verified, fail closed and leave every byte in place: loader/ABI failures and
// a wrong key are not evidence that the database itself is corrupt.
// ---------------------------------------------------------------------------

function openKeyed(dbPath, key) {
  const db = new Database(dbPath);
  applyKey(db, key);
  applyPragmas(db);
  return db;
}

/** @param {(m: string) => void} log */
function migrateAtBoot(db, dbPath, backupDir, key, log) {
  try {
    migrate(db, { backupDir, key, log });
  } catch (err) {
    // The failed migration's transaction already rolled back; restoring the
    // pre-migration snapshot is belt and braces before aborting the boot.
    log(`[migrate] FAILED (${err.failedMigration || "?"}): ${err.message}`);
    if (err.migrationBackup) {
      try { db.close(); } catch {}
      quarantine(dbPath);
      fs.copyFileSync(err.migrationBackup, dbPath);
      log(`[migrate] restored pre-migration snapshot ${path.basename(err.migrationBackup)}`);
    }
    throw err;
  }
}

/**
 * @param {{ dbPath: string, backupDir: string, key: string, log?: (m: string) => void }} opts
 * @returns {import('better-sqlite3-multiple-ciphers').Database}
 */
function openDatabase({ dbPath, backupDir, key, log = () => {} }) {
  fs.mkdirSync(backupDir, { recursive: true });
  rotateBackups(backupDir); // enforce retention for snapshots from older app versions too
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  if (fs.existsSync(dbPath)) {
    let db = null;
    let openError = null;
    try {
      db = openKeyed(dbPath, key);
      if (isHealthy(db)) {
        migrateAtBoot(db, dbPath, backupDir, key, log);
        return db;
      }
      db.close();
      log("[db] quick_check failed, attempting restore");
    } catch (e) {
      try { db?.close(); } catch {}
      openError = e;
      log(`[db] open failed, attempting restore: ${e.message}`);
    }

    if (restoreNewestGoodBackup(dbPath, backupDir, { key, log })) {
      const db2 = openKeyed(dbPath, key);
      migrateAtBoot(db2, dbPath, backupDir, key, log);
      return db2;
    }
    // A native-addon ABI mismatch, missing shared library, unavailable keychain,
    // or wrong key can make both the live file and every backup unreadable. Do
    // not mislabel that as corruption or replace the user's data with an empty DB.
    log("[db] NO VERIFIED BACKUP FOUND - leaving the database untouched");
    const reason = openError?.message ? ` (${openError.message})` : "";
    throw new Error(`Database could not be verified and no readable backup was found${reason}`);
  }

  const db = openKeyed(dbPath, key);
  migrateAtBoot(db, dbPath, backupDir, key, log);
  return db;
}

function checkpointAndClose(db) {
  db.pragma("wal_checkpoint(TRUNCATE)"); // fold WAL back, clean sidecars
  db.close();
}

/** Details for the restore picker: does it open, and what's inside. Never throws
 *  - a snapshot that won't open comes back {ok:false, contacts:null}. */
function snapshotInfo(file, key) {
  try {
    const probe = new Database(file, { readonly: true });
    if (key !== undefined) applyKey(probe, key);
    try {
      const ok = probe.pragma("integrity_check", { simple: true }) === "ok";
      let contacts = null;
      try {
        const r = /** @type {any} */ (probe.prepare("SELECT COUNT(*) c FROM contacts WHERE deleted_at IS NULL").get());
        contacts = r.c;
      } catch { /* schema not present / unreadable */ }
      return { ok, contacts };
    } finally {
      probe.close();
    }
  } catch {
    return { ok: false, contacts: null };
  }
}

/** True when the snapshot opens with this key and passes integrity_check. */
function verifySnapshot(file, key) {
  try {
    const probe = new Database(file, { readonly: true });
    if (key !== undefined) applyKey(probe, key);
    try {
      return probe.pragma("integrity_check", { simple: true }) === "ok";
    } finally {
      probe.close();
    }
  } catch {
    return false;
  }
}

/** Overwrite the (CLOSED) database file with a snapshot. Caller backs up first. */
function replaceDatabaseFile(dbPath, backupFile) {
  for (const ext of ["-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + ext); } catch {}
  }
  fs.copyFileSync(backupFile, dbPath);
}

module.exports = {
  openDatabase,
  checkpointAndClose,
  takeBackup,
  listBackups,
  rotateBackups,
  restoreNewestGoodBackup,
  verifySnapshot,
  snapshotInfo,
  replaceDatabaseFile,
  startBackupScheduler,
  changeCount,
};
