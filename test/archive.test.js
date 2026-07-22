// Archive round-trip fidelity (the device-migration guarantee), encryption
// fail-closed behavior, and version gating.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const contactsRepo = require("../src/main/db/contacts");
const edgesRepo = require("../src/main/db/edges");
const interactionsRepo = require("../src/main/db/interactions");
const tagsRepo = require("../src/main/db/tags");
const { exportArchive, importArchive } = require("../src/main/ingest/archive");
const { makeDb, tmpDir } = require("./helpers");

function seedSource(db) {
  const a = contactsRepo.create(db, { name: "Alice Chen", fields: { email: "alice@acme.com", company: "Acme" } });
  const b = contactsRepo.create(db, { name: "Sam Okafor", fields: { email: "sam@globex.com" } });
  const c = contactsRepo.create(db, { name: "Trashed Soul" });
  edgesRepo.create(db, { sourceId: a.id, targetId: b.id, type: "introduced", directed: true });
  interactionsRepo.add(db, { contactId: a.id, occurredAt: 12345, kind: "call", note: "catch-up" });
  tagsRepo.setForContact(db, { id: a.id, tags: ["vip"] });
  contactsRepo.softDelete(db, c.id); // must NOT travel
  return { a, b };
}

test("export -> fresh import reproduces the graph exactly", (t) => {
  const src = makeDb(t);
  seedSource(src.db);
  const file = path.join(tmpDir(t), "out.orbit");
  const r = exportArchive(src.db, { destPath: file });
  assert.equal(r.counts.contacts, 2, "soft-deleted contact leaked into export");

  const dst = makeDb(t);
  const report = importArchive(dst.db, { srcPath: file, onDuplicate: "skip" });
  assert.deepEqual(
    { i: report.imported, d: report.duplicatesFound },
    { i: 2, d: 0 }
  );

  const list = contactsRepo.list(dst.db);
  assert.deepEqual(list.map((x) => x.name).sort(), ["Alice Chen", "Sam Okafor"]);
  const alice = list.find((x) => x.name === "Alice Chen");
  assert.equal(alice.fields.company, "Acme");
  assert.deepEqual(tagsRepo.forContact(dst.db, alice.id), ["vip"]);
  const edges = edgesRepo.listFor(dst.db, alice.id);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].type, "introduced");
  assert.equal(edges[0].directed, true);
  const timeline = interactionsRepo.list(dst.db, { contactId: alice.id });
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].note, "catch-up");
});

test("passphrase archive: decrypts with the right one, fails closed otherwise", (t) => {
  const src = makeDb(t);
  seedSource(src.db);
  const file = path.join(tmpDir(t), "enc.orbit");
  exportArchive(src.db, { destPath: file, passphrase: "correct horse" });

  const raw = fs.readFileSync(file);
  assert.equal(raw.includes(Buffer.from("Alice Chen")), false, "plaintext in encrypted archive");

  const dst = makeDb(t);
  assert.throws(
    () => importArchive(dst.db, { srcPath: file, passphrase: "wrong", onDuplicate: "skip" }),
    (err) => err.code === "VALIDATION"
  );
  assert.equal(contactsRepo.list(dst.db).length, 0, "partial write after failed decrypt");

  const report = importArchive(dst.db, { srcPath: file, passphrase: "correct horse", onDuplicate: "skip" });
  assert.equal(report.imported, 2);
});

test("tampered archive fails closed; newer schemaVersion is rejected", (t) => {
  const src = makeDb(t);
  seedSource(src.db);
  const dir = tmpDir(t);
  const file = path.join(dir, "tamper.orbit");
  exportArchive(src.db, { destPath: file, passphrase: "pw" });
  const raw = fs.readFileSync(file);
  raw[raw.length - 5] ^= 0xff; // flip a ciphertext byte
  fs.writeFileSync(file, raw);
  const dst = makeDb(t);
  assert.throws(
    () => importArchive(dst.db, { srcPath: file, passphrase: "pw", onDuplicate: "skip" }),
    (err) => err.code === "VALIDATION"
  );

  const future = path.join(dir, "future.orbit");
  fs.writeFileSync(future, JSON.stringify({ magic: "ORBIT1", schemaVersion: 99, encrypted: false }) + "\n");
  assert.throws(
    () => importArchive(dst.db, { srcPath: future, onDuplicate: "skip" }),
    /newer version/
  );
});
