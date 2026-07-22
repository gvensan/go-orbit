// M4 search: typo recall, operators, graph-aware near:, did-you-mean, boosts,
// and a latency sanity check.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const interactions = require("../src/main/db/interactions");
const tagsRepo = require("../src/main/db/tags");
const { seedSample } = require("../src/main/db/sample");
const { prepareStatements, search, parseQuery } = require("../src/main/search/engine");
const { makeDb } = require("./helpers");

const q = (stmts, text, id = 1) => search(stmts, { text, requestId: id });

function seed(db) {
  const john = contacts.create(db, { name: "John Smith", fields: { email: "js@acme.com", company: "Acme Corp" } });
  const jon = contacts.create(db, { name: "Jon Smythe", fields: { company: "Globex" } });
  const alice = contacts.create(db, { name: "Alice Chen", fields: { email: "alice@acme.com", company: "Acme Corp" } });
  const bo = contacts.create(db, { name: "Bo Novak", fields: { company: "Initech" } });
  const cy = contacts.create(db, { name: "Cy Reyes", fields: { company: "Initech" } });
  edges.create(db, { sourceId: alice.id, targetId: bo.id, type: "colleague", directed: false });
  edges.create(db, { sourceId: bo.id, targetId: cy.id, type: "friend", directed: false });
  tagsRepo.setForContact(db, { id: alice.id, tags: ["vip"] });
  return { john, jon, alice, bo, cy };
}

test("typo recall: 'Jhon Smyth' surfaces John Smith in the top 3", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const r = q(prepareStatements(db), "Jhon Smyth");
  assert.ok(r.results.length > 0, "no typo recall at all");
  assert.ok(
    r.results.slice(0, 3).some((x) => x.name === "John Smith"),
    `John Smith not in top 3: ${r.results.map((x) => x.name).join(", ")}`
  );
});

test("operators parse and filter: org:, tag:, has:email", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const stmts = prepareStatements(db);

  const parsed = parseQuery('chen org:"Acme Corp" tag:vip has:email hops:2');
  assert.deepEqual(parsed.tokens, ["chen"]);
  assert.equal(parsed.filters.org, "acme corp");
  assert.deepEqual(parsed.filters.tags, ["vip"]);
  assert.equal(parsed.filters.hasEmail, true);
  assert.equal(parsed.filters.hops, 2);

  assert.deepEqual(q(stmts, "org:initech").results.map((r) => r.name).sort(), ["Bo Novak", "Cy Reyes"]);
  assert.deepEqual(q(stmts, "tag:vip").results.map((r) => r.name), ["Alice Chen"]);
  assert.deepEqual(q(stmts, "org:acme has:email chen").results.map((r) => r.name), ["Alice Chen"]);
});

test("near:/hops: restricts to the graph neighborhood", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const stmts = prepareStatements(db);
  const one = q(stmts, 'near:"Alice Chen"').results.map((r) => r.name).sort();
  assert.deepEqual(one, ["Alice Chen", "Bo Novak"]);
  const two = q(stmts, 'near:"Alice Chen" hops:2').results.map((r) => r.name).sort();
  assert.deepEqual(two, ["Alice Chen", "Bo Novak", "Cy Reyes"]);
  const filtered = q(stmts, 'reyes near:"Alice Chen" hops:2').results.map((r) => r.name);
  assert.deepEqual(filtered, ["Cy Reyes"]);
});

test("did-you-mean fires when recall is empty", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const r = q(prepareStatements(db), "aliceo chenn org:doesnotexist");
  assert.equal(r.results.length, 0);
  const r2 = q(prepareStatements(db), "alicce chhen");
  if (r2.results.length === 0) {
    assert.equal(r2.didYouMean, "Alice Chen");
  } else {
    assert.equal(r2.results[0].name, "Alice Chen"); // fuzzy scan already caught it
  }
});

test("recency boost lifts a recently-contacted person over a stale one", (t) => {
  const { db } = makeDb(t);
  const s1 = contacts.create(db, { name: "Pat Recent", fields: {} });
  contacts.create(db, { name: "Pat Stale", fields: {} });
  interactions.add(db, { contactId: s1.id, occurredAt: Date.now() - 86400000, kind: "call" });
  const r = q(prepareStatements(db), "pat");
  assert.equal(r.results[0].name, "Pat Recent");
});

test("latency sanity: sub-50ms average on a 3k-contact network", (t) => {
  const { db } = makeDb(t);
  seedSample(db, { count: 3000 });
  const stmts = prepareStatements(db);
  const queries = ["chen", "acme", "ava pat", "sing", "okafor globex", "xyz nonsense", "tor"];
  const started = process.hrtime.bigint();
  let total = 0;
  for (let i = 0; i < 30; i++) total += q(stmts, queries[i % queries.length], i).results.length;
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / 30;
  assert.ok(ms < 50, `average query took ${ms.toFixed(1)}ms`);
  assert.ok(total > 0);
});
