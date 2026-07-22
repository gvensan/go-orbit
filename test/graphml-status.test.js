// GraphML export structure + the backup:status diagnostics handler.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const dbLayer = require("../src/main/db");
const { buildGraphML } = require("../src/main/ingest/graphml");
const { buildRegistry } = require("../src/main/ipc/registry");
const { GraphStore } = require("../src/main/graph/store");
const { makeDb, tmpDir, TEST_KEY } = require("./helpers");

test("GraphML escapes content and carries node/edge attributes", (t) => {
  const { db } = makeDb(t);
  const a = contacts.create(db, { name: 'Alice "A&B" <Chen>', fields: { company: "Acme & Co" } });
  const b = contacts.create(db, { name: "Bo", fields: {} });
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "introduced", directed: true });

  const xml = buildGraphML(new GraphStore().hydrate(db).snapshot());
  assert.ok(xml.includes("Alice &quot;A&amp;B&quot; &lt;Chen&gt;"), "name not escaped");
  assert.ok(xml.includes("Acme &amp; Co"), "org not escaped");
  assert.ok(xml.includes('directed="true"'), "directedness lost");
  assert.ok(xml.includes('<data key="type">introduced</data>'));
  assert.equal((xml.match(/<node /g) || []).length, 2);
  assert.equal((xml.match(/<edge /g) || []).length, 1);
});

test("backup:status reports counts, backups, and config", (t) => {
  const { db, dir, dbPath } = makeDb(t);
  const a = contacts.create(db, { name: "Live One" });
  const b = contacts.create(db, { name: "Trashed One" });
  contacts.softDelete(db, b.id);
  const backupDir = path.join(dir, "snaps");
  dbLayer.takeBackup(db, backupDir, { key: TEST_KEY });
  db.pragma("wal_checkpoint(TRUNCATE)");

  const reg = buildRegistry(/** @type {any} */ ({
    db,
    dbPath,
    backupDir,
    key: TEST_KEY,
    graph: new GraphStore().hydrate(db),
    appVersion: "0.1.0-test",
    logPath: "/tmp/test.log",
  }));
  const status = reg["backup:status"].handle(reg["backup:status"].validate({}));
  assert.equal(status.contacts, 1);
  assert.equal(status.trashed, 1);
  assert.equal(status.backupCount, 1);
  assert.ok(status.lastBackupAt > 0);
  assert.ok(status.dbSizeBytes > 0);
  assert.equal(status.appVersion, "0.1.0-test");
  assert.equal(status.encrypted, true);
  assert.ok(status.autoPurgeDays > 0);

  const backup = dbLayer.listBackups(backupDir)[0];
  const deleted = reg["backup:delete"].handle(reg["backup:delete"].validate({ name: path.basename(backup) }));
  assert.equal(deleted.deleted, true);
  assert.equal(fs.existsSync(backup), false);
});
