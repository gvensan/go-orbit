// Betweenness worker service (real worker threads).

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const { CentralityService } = require("../src/main/graph/centrality-service");
const { makeDb, TEST_KEY } = require("./helpers");

function chain(db, n) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(contacts.create(db, { name: `Node ${i}` }).id);
  for (let i = 1; i < n; i++) {
    edges.create(db, { sourceId: ids[i - 1], targetId: ids[i], type: "friend", directed: false });
  }
  return ids;
}

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
