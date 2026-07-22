// migrate.js - forward-only schema migrations.
//
// Contract (see docs/APP_REQUIREMENTS.md §8, CLAUDE.md guardrails):
//   - Migrations are numbered NNNN_*.sql in ./migrations, applied in order.
//   - The DB's PRAGMA user_version is the applied count.
//   - A VACUUM INTO backup is taken BEFORE any pending migration runs.
//   - Each migration runs in its own transaction; failure rolls back and the
//     caller restores from the pre-migration backup.
//
// Exports: migrate(db, { backupDir, log, migrationsDir }) -> { from, to, applied[], backup }

const fs = require("fs");
const path = require("path");
const { rotateBackups } = require("./backup-files");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

let backupSeq = 0; // disambiguates backups created within the same millisecond

function listMigrations(migrationsDir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({
      version: parseInt(f.slice(0, 4), 10),
      name: f,
      sql: fs.readFileSync(path.join(migrationsDir, f), "utf8"),
    }));
}

function preMigrationBackup(db, backupDir, key) {
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, `pre-migration-${Date.now()}-${backupSeq++}.db`);
  const tmp = dest + ".tmp";
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  // This snapshot is the rollback target if a migration fails; verify it the
  // same way routine backups are verified before trusting it. The snapshot is
  // encrypted with the source connection's key, so the probe needs it too.
  const Database = require("better-sqlite3-multiple-ciphers");
  const probe = new Database(tmp, { readonly: true });
  if (key !== undefined) probe.pragma(`key = '${String(key).replace(/'/g, "''")}'`);
  let ok = false;
  try {
    ok = probe.pragma("integrity_check", { simple: true }) === "ok";
  } finally {
    probe.close();
  }
  if (!ok) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error("pre-migration snapshot failed integrity check; refusing to migrate");
  }
  fs.renameSync(tmp, dest);
  rotateBackups(backupDir);
  return dest;
}

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db  open, keyed connection
 * @param {{ backupDir: string, key?: string, log?: (m: string) => void, migrationsDir?: string }} opts
 */
function migrate(db, { backupDir, key, log = () => {}, migrationsDir = MIGRATIONS_DIR }) {
  const all = listMigrations(migrationsDir);
  const current = /** @type {number} */ (db.pragma("user_version", { simple: true }));
  const pending = all.filter((m) => m.version > current);

  if (pending.length === 0) {
    log(`[migrate] up to date at v${current}`);
    return { from: current, to: current, applied: [], backup: null };
  }

  // Sanity: versions must be contiguous starting at current+1.
  pending.forEach((m, i) => {
    const expected = current + i + 1;
    if (m.version !== expected) {
      throw new Error(`[migrate] gap: expected v${expected}, found ${m.name}`);
    }
  });

  const backup = preMigrationBackup(db, backupDir, key);
  log(`[migrate] backed up to ${path.basename(backup)} before ${pending.length} migration(s)`);

  const applied = [];
  for (const m of pending) {
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    try {
      run();
      applied.push(m.name);
      log(`[migrate] applied ${m.name} -> v${m.version}`);
    } catch (err) {
      // Transaction already rolled back this migration. Signal the caller to
      // restore from `backup` and abort startup rather than run half-migrated.
      err.migrationBackup = backup;
      err.failedMigration = m.name;
      throw err;
    }
  }

  return { from: current, to: pending[pending.length - 1].version, applied, backup };
}

module.exports = { migrate, listMigrations };

// CLI: `node src/main/db/migrate.js <dbPath> [key]`  (dev use; app calls migrate() at boot)
if (require.main === module) {
  const Database = require("better-sqlite3-multiple-ciphers");
  const [, , dbPath, key] = process.argv;
  if (!dbPath) {
    console.error("usage: node migrate.js <dbPath> [key]");
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  if (key) db.pragma(`key = '${key.replace(/'/g, "''")}'`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  try {
    const r = migrate(db, {
      backupDir: path.join(path.dirname(dbPath), "backups"),
      key,
      log: console.log,
    });
    console.log(`[migrate] ${r.from} -> ${r.to} (${r.applied.length} applied)`);
    db.close();
  } catch (err) {
    console.error("[migrate] FAILED:", err.message);
    if (err.migrationBackup) console.error("[migrate] restore from:", err.migrationBackup);
    db.close();
    process.exit(1);
  }
}
