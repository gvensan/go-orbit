// Changing an edge's relationship type (delete + re-insert, PK-safe).

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const { makeDb } = require("./helpers");

test("changeType swaps the type, preserving direction and endpoints", (t) => {
  const { db } = makeDb(t);
  const a = contacts.create(db, { name: "A" });
  const b = contacts.create(db, { name: "B" });
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "colleague", directed: true });

  const updated = edges.changeType(db, { sourceId: a.id, targetId: b.id, type: "colleague", newType: "acquaintance" });
  assert.equal(updated.type, "acquaintance");
  assert.equal(updated.directed, true);

  const list = edges.listFor(db, a.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].type, "acquaintance");
  assert.equal(list[0].sourceId, a.id);
  assert.equal(list[0].targetId, b.id);
});

test("changeType is a no-op when the type is unchanged; NOT_FOUND / CONFLICT otherwise", (t) => {
  const { db } = makeDb(t);
  const a = contacts.create(db, { name: "A" });
  const b = contacts.create(db, { name: "B" });
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "friend", directed: false });
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "family", directed: false });

  assert.equal(edges.changeType(db, { sourceId: a.id, targetId: b.id, type: "friend", newType: "friend" }).type, "friend");
  assert.throws(
    () => edges.changeType(db, { sourceId: a.id, targetId: b.id, type: "nope", newType: "friend" }),
    (err) => err.code === "NOT_FOUND"
  );
  // Changing friend -> family would collide with the existing family edge.
  assert.throws(
    () => edges.changeType(db, { sourceId: a.id, targetId: b.id, type: "friend", newType: "family" }),
    (err) => err.code === "CONFLICT"
  );
});

test("metadata is persisted: set in-place, carried across a type change, and clearable", (t) => {
  const { db } = makeDb(t);
  const a = contacts.create(db, { name: "A" });
  const b = contacts.create(db, { name: "B" });
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "family", directed: false });

  // Set a kinship role without changing the type (newType omitted).
  const kin = { [String(b.id)]: "sister" };
  const withMeta = edges.changeType(db, { sourceId: a.id, targetId: b.id, type: "family", metadata: { kin } });
  assert.deepEqual(withMeta.metadata, { kin });
  assert.deepEqual(edges.listFor(db, a.id)[0].metadata, { kin });

  // Metadata survives a type change (family -> acquaintance).
  const retyped = edges.changeType(db, { sourceId: a.id, targetId: b.id, type: "family", newType: "acquaintance", metadata: { kin } });
  assert.equal(retyped.type, "acquaintance");
  assert.deepEqual(retyped.metadata, { kin });

  // Empty metadata clears it back to undefined.
  const cleared = edges.changeType(db, { sourceId: a.id, targetId: b.id, type: "acquaintance", metadata: {} });
  assert.equal(cleared.metadata, undefined);
  assert.equal(edges.listFor(db, a.id)[0].metadata, undefined);
});
