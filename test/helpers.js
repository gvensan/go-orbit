// helpers.js - shared test setup. Everything runs under plain Node against
// temp-dir encrypted databases; no Electron required.

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");
const { migrate } = require("../src/main/db/migrate");

const TEST_KEY = "test-key";

/** Temp dir removed when the test (context `t`) finishes. */
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openKeyed(dbPath, key = TEST_KEY) {
  const db = new Database(dbPath);
  db.pragma(`key = '${key}'`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

/** Fresh encrypted DB, fully migrated, in its own temp dir. */
function makeDb(t) {
  const dir = tmpDir(t);
  const dbPath = path.join(dir, "test.db");
  const db = openKeyed(dbPath);
  migrate(db, { backupDir: path.join(dir, "migration-backups"), key: TEST_KEY });
  t.after(() => {
    try { db.close(); } catch {}
  });
  return { db, dir, dbPath };
}

module.exports = { tmpDir, openKeyed, makeDb, TEST_KEY };
