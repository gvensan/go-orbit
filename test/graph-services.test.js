// Layout persistence + betweenness worker service (real worker threads).

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const { CentralityService } = require("../src/main/graph/centrality-service");
const { LayoutService } = require("../src/main/graph/layout-service");
const { GraphStore } = require("../src/main/graph/store");
const { makeDb, TEST_KEY } = require("./helpers");

function chain(db, n) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(contacts.create(db, { name: `Node ${i}` }).id);
  for (let i = 1; i < n; i++) {
    edges.create(db, { sourceId: ids[i - 1], targetId: ids[i], type: "friend", directed: false });
  }
  return ids;
}

test("layout service persists positions and the worker settles", async (t) => {
  const { db, dbPath } = makeDb(t);
  chain(db, 12);
  db.pragma("wal_checkpoint(TRUNCATE)");

  const service = new LayoutService({ db });
  const ticks = [];
  service.start(new GraphStore().hydrate(db), (positions) => ticks.push(positions));
  const deadline = Date.now() + 15000;
  while (service.running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(service.running, false, "layout did not settle in time");
  assert.ok(ticks.length >= 2, "no streamed ticks");

  const rows = db.prepare("SELECT COUNT(*) c FROM layout_positions").get().c;
  assert.equal(rows, 12, "positions not persisted");

  service.persist({ 1: { x: 42, y: -7 } });
  const p = db.prepare("SELECT x, y FROM layout_positions WHERE contact_id = 1").get();
  assert.deepEqual({ x: p.x, y: p.y }, { x: 42, y: -7 });
});

test("betweenness runs off-thread, caches, and ranks the bridge highest", async (t) => {
  const { db, dbPath } = makeDb(t);
  const ids = chain(db, 5); // path graph: middle node is the bridge
  db.pragma("wal_checkpoint(TRUNCATE)");

  const service = new CentralityService({ dbPath, key: TEST_KEY });
  const values = await service.betweenness();
  const middle = ids[2];
  for (const id of ids) {
    if (id !== middle) assert.ok(values[middle] >= values[id], "middle node not the most between");
  }

  const again = await service.betweenness();
  assert.equal(again, values, "cache miss on second call");
  service.bump();
  const recomputed = await service.betweenness();
  assert.notEqual(recomputed, values, "bump did not invalidate");
});
