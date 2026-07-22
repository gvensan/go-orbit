// IPC payload validation: invalid payloads must reject with VALIDATION before
// touching the data layer (renderer is untrusted).

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRegistry } = require("../src/main/ipc/registry");
const { GraphStore } = require("../src/main/graph/store");
const { makeDb } = require("./helpers");
const { EXPLORE_SORT_KEYS } = require("../src/main/explore/service");

const isValidation = (err) => err.code === "VALIDATION";

test("malformed payloads are rejected with VALIDATION", (t) => {
  const { db } = makeDb(t);
  const reg = buildRegistry({ db, graph: new GraphStore(), backupDir: "", key: "" });

  const cases = [
    ["contacts:create", {}],                              // missing name
    ["contacts:create", { name: "" }],                    // empty name
    ["contacts:create", { name: "Ok", extra: true }],     // unknown key
    ["contacts:create", { name: "Ok", fields: { a: 1 } }],// non-string field
    ["contacts:get", { id: "7" }],                        // string id
    ["contacts:get", { id: -1 }],                         // negative id
    ["graph:ego", { contactId: 1, depth: 99 }],           // depth beyond cap
    ["graph:centrality", { metric: "closeness" }],        // unknown metric
    ["edges:create", { sourceId: 1, targetId: 2, type: "x" }], // missing directed
    ["interactions:add", { contactId: 1 }],               // missing occurredAt
    ["import:archive", { srcPath: "/x", onDuplicate: "explode" }],
  ];
  for (const [channel, payload] of cases) {
    assert.throws(
      () => reg[channel].handle(reg[channel].validate(payload)),
      isValidation,
      `${channel} accepted ${JSON.stringify(payload)}`
    );
  }
});

test("valid payloads flow through handler and keep the graph in sync", (t) => {
  const { db } = makeDb(t);
  const graph = new GraphStore().hydrate(db);
  const reg = buildRegistry({ db, graph, backupDir: "", key: "" });
  const call = (channel, payload) => reg[channel].handle(reg[channel].validate(payload));

  const a = call("contacts:create", { name: "Ada" });
  const b = call("contacts:create", { name: "Bo", fields: { company: "Acme" } });
  call("edges:create", { sourceId: a.id, targetId: b.id, type: "friend", directed: false });

  assert.equal(graph.order, 2);
  assert.equal(graph.size, 1);
  assert.deepEqual(call("graph:ego", { contactId: a.id, depth: 1 }).sort(), [a.id, b.id].sort());

  call("contacts:softDelete", { id: b.id });
  assert.equal(graph.order, 1);
  assert.equal(graph.size, 0);

  call("contacts:restore", { id: b.id });
  assert.equal(graph.order, 2);
  assert.equal(graph.size, 1, "restore did not re-link edges");
});

test("detailed maps default on but preserve an explicit opt-out", (t) => {
  const { db } = makeDb(t);
  const reg = buildRegistry({ db, graph: new GraphStore(), backupDir: "", key: "" });
  const call = (channel, payload) => reg[channel].handle(reg[channel].validate(payload));

  assert.deepEqual(call("location:online", {}), { enabled: true });
  assert.deepEqual(call("location:setOnline", { enabled: false }), { enabled: false });
  assert.deepEqual(call("location:online", {}), { enabled: false });
  assert.deepEqual(call("location:setOnline", { enabled: true }), { enabled: true });
  assert.deepEqual(call("location:online", {}), { enabled: true });
});

test("IPC accepts every Explore column sort key", (t) => {
  const { db } = makeDb(t);
  const reg = buildRegistry({ db, graph: new GraphStore(), backupDir: "", key: "" });
  for (const sort of EXPLORE_SORT_KEYS) {
    assert.equal(reg["explore:query"].validate({ sort }).sort, sort);
  }
});
