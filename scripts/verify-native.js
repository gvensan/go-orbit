// A real load test for the encrypted SQLite addon. Requiring its JS wrapper is
// insufficient because the native binary is loaded lazily on first Database.
// Runs under the same Node the service uses, so a passing check here means the
// prebuilt (or locally compiled) binary matches this runtime's ABI.

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-native-"));
const file = path.join(dir, "abi.db");
const db = new Database(file);
try {
  db.pragma("key = 'abi-check'");
  db.exec("CREATE TABLE abi_check (value INTEGER NOT NULL)");
  db.prepare("INSERT INTO abi_check VALUES (?)").run(1);
  const row = /** @type {{ value: number }} */ (db.prepare("SELECT value FROM abi_check").get());
  if (row.value !== 1) throw new Error("Native SQLite smoke query returned the wrong value.");
  const fts = /** @type {{ n: number }} */ (db.prepare("SELECT COUNT(*) AS n FROM pragma_compile_options WHERE compile_options LIKE 'ENABLE_FTS5%'").get());
  if (fts.n !== 1) throw new Error("This SQLite build lacks FTS5, which search requires.");
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`Native encrypted SQLite verified for Node ${process.version} (ABI ${process.versions.modules}).`);
