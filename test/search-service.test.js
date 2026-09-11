// SearchService: the real worker bridge. Results flow, supersede semantics,
// and the requestId-collision case (two UI surfaces with independent counters).

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const { SearchService } = require("../src/main/search/service");
const { makeDb, TEST_KEY } = require("./helpers");

test("service answers queries and survives colliding requestIds", async (t) => {
  const { db, dbPath } = makeDb(t);
  contacts.create(db, { name: "Alice Chen", fields: { company: "Acme" } });
  contacts.create(db, { name: "Bo Novak" });
  db.pragma("wal_checkpoint(TRUNCATE)");

  const service = new SearchService({ dbPath, key: TEST_KEY });
  t.after(() => service.terminate());

  const r1 = await service.query({ text: "alice", requestId: 7 });
  assert.equal(r1.requestId, 7);
  assert.equal(r1.results[0]?.name, "Alice Chen");

  // Two "surfaces" using the same requestId value: both must settle correctly.
  const [a, b] = await Promise.all([
    service.query({ text: "alice", requestId: 1 }),
    service.query({ text: "bo", requestId: 1 }),
  ]);
  // The first was superseded by the second: it resolves empty; the second wins.
  assert.equal(a.requestId, 1);
  assert.deepEqual(a.results, []);
  assert.equal(b.results[0]?.name, "Bo Novak");

  // Rapid-fire: only the last query's content matters; earlier ones resolve
  // empty under their own ids so the renderer discards them.
  const burst = await Promise.all(
    ["a", "al", "ali", "alic", "alice"].map((text, i) =>
      service.query({ text, requestId: 100 + i })
    )
  );
  const last = burst[burst.length - 1];
  assert.equal(last.requestId, 104);
  assert.equal(last.results[0]?.name, "Alice Chen");
  for (const r of burst.slice(0, -1)) {
    if (r.results.length) assert.notEqual(r.requestId, 104);
  }
});

test("terminate right after construction waits for the worker to load, then exits it cleanly", async (t) => {
  const { dbPath } = makeDb(t);
  const service = new SearchService({ dbPath, key: TEST_KEY });
  // The worker is still requiring the native addon here; killing it now would
  // abort the whole process (N-API fatal). terminate() must wait it out.
  const code = await service.terminate();
  assert.equal(code, 0, "the worker closed its own connection and exited 0");
  assert.equal(await service.exited, 0);
  assert.equal(await service.terminate(), 0, "idempotent");
});

test("a query in flight during terminate resolves empty under its own requestId", async (t) => {
  const { dbPath } = makeDb(t);
  const service = new SearchService({ dbPath, key: TEST_KEY });
  assert.equal(await service.ready, true);
  const pending = service.query({ text: "anything", requestId: 42 });
  const done = service.terminate();
  const r = await pending;
  assert.equal(r.requestId, 42);
  assert.deepEqual(r.results, []);
  await done;
});
