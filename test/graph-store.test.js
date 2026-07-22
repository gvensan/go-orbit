// GraphStore: hydration filters soft-deleted rows; ego/path/degree queries.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const { GraphStore } = require("../src/main/graph/store");
const { makeDb } = require("./helpers");

function seedChain(db) {
  // a - b - c, plus a tail d only reachable through c
  const [a, b, c, d] = ["A", "B", "C", "D"].map((name) => contacts.create(db, { name }));
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "friend", directed: false });
  edges.create(db, { sourceId: b.id, targetId: c.id, type: "friend", directed: false });
  edges.create(db, { sourceId: c.id, targetId: d.id, type: "friend", directed: false });
  return { a, b, c, d };
}

test("hydrate excludes soft-deleted contacts and their edges", (t) => {
  const { db } = makeDb(t);
  const { a, b } = seedChain(db);
  contacts.softDelete(db, b.id);

  const store = new GraphStore().hydrate(db);
  assert.equal(store.order, 3);
  assert.equal(store.size, 1, "edges touching a trashed contact survived hydration");
  assert.equal(store.hasNode(a.id), true);
  assert.equal(store.hasNode(b.id), false);
});

test("ego BFS respects depth; path finds and reports hops", (t) => {
  const { db } = makeDb(t);
  const { a, b, c, d } = seedChain(db);
  const store = new GraphStore().hydrate(db);

  assert.deepEqual(store.ego(a.id, 0), [a.id]);
  assert.deepEqual(new Set(store.ego(a.id, 1)), new Set([a.id, b.id]));
  assert.deepEqual(new Set(store.ego(a.id, 3)), new Set([a.id, b.id, c.id, d.id]));

  assert.deepEqual(store.path(a.id, d.id), { path: [a.id, b.id, c.id, d.id], hops: 3, found: true });
  assert.throws(() => store.path(a.id, 9999), (err) => err.code === "NOT_FOUND");
});

test("disconnection after removeContact: path not found, degrees update", (t) => {
  const { db } = makeDb(t);
  const { a, b, c } = seedChain(db);
  const store = new GraphStore().hydrate(db);

  contacts.softDelete(db, b.id);
  store.removeContact(b.id);

  assert.deepEqual(store.path(a.id, c.id), { path: [], hops: 0, found: false });
  assert.equal(store.degreeCentrality()[a.id], 0);
  const snap = store.snapshot();
  assert.equal(snap.nodes.length, 3);
  assert.equal(snap.links.length, 1); // only c - d survives
});
