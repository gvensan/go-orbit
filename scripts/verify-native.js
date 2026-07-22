// A real load test for the encrypted SQLite addon. Requiring its JS wrapper is
// insufficient because the native binary is loaded lazily on first Database.

const Database = require("better-sqlite3-multiple-ciphers");

if (!process.versions.electron) {
  throw new Error("Native verification must run with Electron's Node runtime.");
}

const db = new Database(":memory:");
try {
  db.exec("CREATE TABLE abi_check (value INTEGER NOT NULL)");
  db.prepare("INSERT INTO abi_check VALUES (?)").run(1);
  const row = /** @type {{ value: number }} */ (db.prepare("SELECT value FROM abi_check").get());
  if (row.value !== 1) throw new Error("Native SQLite smoke query returned the wrong value.");
} finally {
  db.close();
}

console.log(`Native SQLite verified for Electron ${process.versions.electron} (ABI ${process.versions.modules}).`);
