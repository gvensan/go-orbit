// smoke-open-db.js — post-build sanity check (see .github/workflows/build.yml).
// Confirms the native module loads on this OS and an encrypted DB opens + migrates.

const path = require("path");
const os = require("os");
const fs = require("fs");
const Database = require("better-sqlite3-multiple-ciphers");
const { migrate } = require("../src/main/db/migrate");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-smoke-"));
const dbPath = path.join(dir, "smoke.db");
const key = "smoke-key";

try {
  const db = new Database(dbPath);
  db.pragma(`key = '${key}'`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Migration verifies its encrypted pre-migration snapshot through a second
  // connection, so it must receive the same key as the primary connection.
  migrate(db, { backupDir: path.join(dir, "backups"), key });
  const v = /** @type {number} */ (db.pragma("user_version", { simple: true }));
  db.prepare("INSERT INTO contacts (id,name,fields,created_at,updated_at) VALUES (1,'Smoke Test','{}',0,0)").run();
  const n = /** @type {{c: number}} */ (db.prepare("SELECT COUNT(*) c FROM contacts").get()).c;
  db.close();
  if (v < 1 || n !== 1) throw new Error(`unexpected state v=${v} n=${n}`);
  console.log(`[smoke] OK — encrypted DB opened, migrated to v${v}, wrote ${n} row`);
} catch (err) {
  console.error("[smoke] FAILED:", err.message);
  process.exit(1);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
