// generate-fixture.js - build a realistic test database at target scale.
//
//   node scripts/generate-fixture.js [--contacts 20000] [--out test/fixtures/scale.db] [--key testkey] [--corrupt]
//
// Produces a migrated, populated DB used by the perf + acceptance suites.
// Generation itself lives in src/main/db/sample.js (shared with the in-app
// "load sample network" action); this script adds the file/key/migrate
// scaffolding and the optional byte-damaged copy for self-heal tests.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");
const { migrate } = require("../src/main/db/migrate");
const { seedSample } = require("../src/main/db/sample");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const N = parseInt(arg("contacts", "20000"), 10);
const OUT = arg("out", path.join(__dirname, "..", "test", "fixtures", "scale.db"));
const KEY = arg("key", "testkey");

function build() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  for (const ext of ["", "-wal", "-shm"]) {
    if (fs.existsSync(OUT + ext)) fs.unlinkSync(OUT + ext);
  }

  const db = new Database(OUT);
  db.pragma(`key = '${KEY}'`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db, { backupDir: path.join(path.dirname(OUT), "backups"), key: KEY });

  const { contacts, edges } = seedSample(db, { count: N });
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  console.log(`[fixture] ${OUT}: ${contacts} contacts, ${edges} edges`);

  if (has("corrupt")) {
    const bad = OUT.replace(/\.db$/, ".corrupt.db");
    fs.copyFileSync(OUT, bad);
    const fd = fs.openSync(bad, "r+");
    const size = fs.fstatSync(fd).size;
    const junk = Buffer.alloc(4096, 0xff);
    fs.writeSync(fd, junk, 0, junk.length, Math.floor(size / 2)); // damage the middle
    fs.closeSync(fd);
    console.log(`[fixture] corrupt copy: ${bad}`);
  }
}

build();
