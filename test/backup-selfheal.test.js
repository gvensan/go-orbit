// Backup snapshots, rotation, corruption self-heal, and boot-time encryption.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const dbLayer = require("../src/main/db");
const contacts = require("../src/main/db/contacts");
const { makeDb, tmpDir, TEST_KEY } = require("./helpers");

test("takeBackup produces a verified encrypted snapshot and rotates old ones", (t) => {
  const { db, dir } = makeDb(t);
  contacts.create(db, { name: "Snapshot Subject" });
  const backupDir = path.join(dir, "snaps");

  const first = dbLayer.takeBackup(db, backupDir, { key: TEST_KEY, keep: 3 });
  assert.ok(fs.existsSync(first));
  for (let i = 0; i < 4; i++) dbLayer.takeBackup(db, backupDir, { key: TEST_KEY, keep: 3 });
  assert.equal(dbLayer.listBackups(backupDir).length, 3, "rotation depth not enforced");
});

test("changeCount rises on writes and is stable across reads", (t) => {
  const { db } = makeDb(t);
  const before = dbLayer.changeCount(db);
  contacts.create(db, { name: "Changer" });
  const afterWrite = dbLayer.changeCount(db);
  assert.ok(afterWrite > before, "a write should advance the change count");
  db.prepare("SELECT COUNT(*) FROM contacts").get(); // a read
  assert.equal(dbLayer.changeCount(db), afterWrite, "a read must not advance the change count");
});

test("routine and pre-migration backups share one total retention cap", (t) => {
  const dir = tmpDir(t);
  const backupDir = path.join(dir, "snaps");
  fs.mkdirSync(backupDir);
  const names = [
    "contacts-1000000000000-0.db", "contacts-1000000000001-0.db", "contacts-1000000000002-0.db",
    "pre-migration-1000000000003-0.db", "pre-migration-1000000000004-0.db",
  ];
  names.forEach((name, i) => {
    const file = path.join(backupDir, name);
    fs.writeFileSync(file, "snapshot");
    fs.utimesSync(file, new Date(1000 + i * 1000), new Date(1000 + i * 1000));
  });

  const kept = dbLayer.rotateBackups(backupDir, { keep: 3, keepPreMigration: 2 });
  assert.equal(kept.length, 3);
  assert.equal(kept.filter((f) => path.basename(f).startsWith("pre-migration-")).length, 2);
  assert.equal(kept.filter((f) => path.basename(f).startsWith("contacts-")).length, 1);
});

test("a corrupted DB self-heals from the newest good snapshot on open", (t) => {
  const dir = tmpDir(t);
  const dbPath = path.join(dir, "app.db");
  const backupDir = path.join(dir, "backups");

  // Boot once, write data, snapshot, close cleanly.
  const db = dbLayer.openDatabase({ dbPath, backupDir, key: TEST_KEY });
  const c = contacts.create(db, { name: "Survivor Dane" });
  dbLayer.takeBackup(db, backupDir, { key: TEST_KEY });
  dbLayer.checkpointAndClose(db);

  // Damage the middle of the file.
  const fd = fs.openSync(dbPath, "r+");
  const size = fs.fstatSync(fd).size;
  fs.writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, Math.floor(size / 2));
  fs.closeSync(fd);

  // Reopen: restore should kick in and the data should be intact.
  const healed = dbLayer.openDatabase({ dbPath, backupDir, key: TEST_KEY });
  t.after(() => { try { healed.close(); } catch {} });
  assert.deepEqual(contacts.get(healed, c.id)?.name, "Survivor Dane");
  const quarantined = fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"));
  assert.equal(quarantined.length, 1, "corrupt file was not quarantined");
});

test("a wrong key never quarantines or replaces the live database", (t) => {
  const dir = tmpDir(t);
  const dbPath = path.join(dir, "app.db");
  const backupDir = path.join(dir, "backups");
  const db = dbLayer.openDatabase({ dbPath, backupDir, key: TEST_KEY });
  contacts.create(db, { name: "Must Stay Put" });
  dbLayer.checkpointAndClose(db);
  const before = fs.readFileSync(dbPath);

  assert.throws(
    () => dbLayer.openDatabase({ dbPath, backupDir, key: "definitely-wrong" }),
    /Database could not be verified/
  );
  assert.deepEqual(fs.readFileSync(dbPath), before, "live database bytes changed after a key failure");
  assert.equal(
    fs.readdirSync(dir).some((name) => name.includes(".corrupt-")),
    false,
    "key failure quarantined a healthy database"
  );
});

test("no plaintext leaks to disk and the DB is unreadable without the key", (t) => {
  const { db, dbPath } = makeDb(t);
  contacts.create(db, {
    name: "Zelda Plaintextcheck",
    fields: { email: "zelda.secret@example.com", notes: "extremely private note" },
  });
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();

  const raw = fs.readFileSync(dbPath);
  for (const needle of ["Plaintextcheck", "zelda.secret", "extremely private"]) {
    assert.equal(raw.includes(Buffer.from(needle)), false, `plaintext "${needle}" on disk`);
  }

  const Database = require("better-sqlite3-multiple-ciphers");
  const noKey = new Database(dbPath, { readonly: true });
  assert.throws(() => noKey.prepare("SELECT * FROM sqlite_master").get());
  noKey.close();
});
