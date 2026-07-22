// Contact repository: CRUD, soft-delete filtering, restore, FTS projection sync.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const interactions = require("../src/main/db/interactions");
const { makeDb } = require("./helpers");

const ftsHits = (db, term) =>
  db.prepare("SELECT rowid FROM contacts_fts WHERE contacts_fts MATCH ?").all(term);

test("create returns the domain shape and lands in the FTS index", (t) => {
  const { db } = makeDb(t);
  const c = contacts.create(db, {
    name: "Marina Delacroix",
    fields: { email: "marina@example.com", company: "Acme Corp" },
  });
  assert.ok(c.id > 0);
  assert.equal(c.deletedAt, null);
  assert.deepEqual(contacts.get(db, c.id), c);
  assert.equal(ftsHits(db, "marina").length, 1);
});

test("update patches name/fields, bumps updatedAt, and re-projects search", (t) => {
  const { db } = makeDb(t);
  const c = contacts.create(db, { name: "Old Name", fields: { company: "Initech" } });
  const u = contacts.update(db, { id: c.id, patch: { name: "Renata Voss" } });
  assert.equal(u.name, "Renata Voss");
  assert.equal(u.fields.company, "Initech");
  assert.ok(u.updatedAt >= c.updatedAt);
  assert.equal(ftsHits(db, "renata").length, 1);
  assert.equal(ftsHits(db, '"Old Name"').length, 0);
});

test("soft-delete hides the contact from every read path; restore brings it back", (t) => {
  const { db } = makeDb(t);
  const c = contacts.create(db, { name: "Ephraim Vanish" });
  const del = contacts.softDelete(db, c.id);
  assert.ok(del.deletedAt > 0);

  assert.equal(contacts.get(db, c.id), null);
  assert.equal(contacts.list(db).length, 0);
  assert.equal(contacts.list(db, { includeDeleted: true }).length, 1);
  assert.equal(ftsHits(db, "ephraim").length, 0, "trashed contact still searchable");

  const back = contacts.restore(db, c.id);
  assert.equal(back.deletedAt, null);
  assert.equal(contacts.list(db).length, 1);
  assert.equal(ftsHits(db, "ephraim").length, 1);
});

test("operations on missing or trashed contacts reject with NOT_FOUND", (t) => {
  const { db } = makeDb(t);
  const c = contacts.create(db, { name: "Gone Soon" });
  contacts.softDelete(db, c.id);
  for (const fn of [
    () => contacts.update(db, { id: c.id, patch: { name: "X" } }),
    () => contacts.softDelete(db, c.id),
    () => contacts.restore(db, 9999),
    () => interactions.add(db, { contactId: c.id, occurredAt: 1 }),
    () => interactions.list(db, { contactId: 9999 }),
  ]) {
    assert.throws(fn, (err) => err.code === "NOT_FOUND");
  }
});

test("interactions add + list, newest first", (t) => {
  const { db } = makeDb(t);
  const c = contacts.create(db, { name: "Talky McChat" });
  interactions.add(db, { contactId: c.id, occurredAt: 1000, kind: "call" });
  interactions.add(db, { contactId: c.id, occurredAt: 3000, kind: "email", note: "intro" });
  const list = interactions.list(db, { contactId: c.id });
  assert.deepEqual(list.map((i) => i.occurredAt), [3000, 1000]);
  assert.equal(list[0].note, "intro");
});
