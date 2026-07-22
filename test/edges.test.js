// Edge repository: endpoint liveness, conflicts, deletes.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const { makeDb } = require("./helpers");

function pair(db) {
  return [contacts.create(db, { name: "A" }), contacts.create(db, { name: "B" })];
}

test("create validates both endpoints are live", (t) => {
  const { db } = makeDb(t);
  const [a, b] = pair(db);
  const e = edges.create(db, { sourceId: a.id, targetId: b.id, type: "friend", directed: false });
  assert.equal(e.type, "friend");
  assert.ok(e.createdAt > 0);

  contacts.softDelete(db, b.id);
  assert.throws(
    () => edges.create(db, { sourceId: a.id, targetId: b.id, type: "colleague", directed: false }),
    (err) => err.code === "NOT_FOUND"
  );
});

test("duplicate (source, target, type) rejects with CONFLICT; self-edges with VALIDATION", (t) => {
  const { db } = makeDb(t);
  const [a, b] = pair(db);
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "friend", directed: false });
  assert.throws(
    () => edges.create(db, { sourceId: a.id, targetId: b.id, type: "friend", directed: true }),
    (err) => err.code === "CONFLICT"
  );
  assert.throws(
    () => edges.create(db, { sourceId: a.id, targetId: a.id, type: "self", directed: false }),
    (err) => err.code === "VALIDATION"
  );
});

test("remove reports whether anything was deleted; listFor skips trashed endpoints", (t) => {
  const { db } = makeDb(t);
  const [a, b] = pair(db);
  const c = contacts.create(db, { name: "C" });
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "friend", directed: false });
  edges.create(db, { sourceId: a.id, targetId: c.id, type: "colleague", directed: false });

  assert.equal(edges.listFor(db, a.id).length, 2);
  contacts.softDelete(db, c.id);
  assert.equal(edges.listFor(db, a.id).length, 1);

  assert.deepEqual(edges.remove(db, { sourceId: a.id, targetId: b.id, type: "friend" }), { ok: true });
  assert.deepEqual(edges.remove(db, { sourceId: a.id, targetId: b.id, type: "friend" }), { ok: false });
});
