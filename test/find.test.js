// Find: structured query evaluator, breakdown, extended insights, named
// (kind='find') saved queries.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const interactions = require("../src/main/db/interactions");
const tagsRepo = require("../src/main/db/tags");
const searches = require("../src/main/db/searches");
const { ExploreService } = require("../src/main/explore/service");
const { GraphStore } = require("../src/main/graph/store");
const { makeDb } = require("./helpers");

function seed(db) {
  const now = Date.now();
  const a = contacts.create(db, { name: "Alice Chen", fields: { company: "Acme", role: "PM", email: "a@acme.com", gender: "Female" } });
  const b = contacts.create(db, { name: "Bo Novak", fields: { company: "Acme", role: "Engineer", gender: "Male" } });
  const c = contacts.create(db, { name: "Cy Reyes", fields: { company: "Globex", role: "PM", phone: "+1555", gender: "Male" } });
  const d = contacts.create(db, { name: "Dana Kim", fields: { company: "Globex", gender: "Female" } });
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "colleague", directed: false });
  edges.create(db, { sourceId: a.id, targetId: c.id, type: "friend", directed: false });
  tagsRepo.setForContact(db, { id: a.id, tags: ["vip"] });
  contacts.update(db, { id: a.id, patch: { starred: true, cadenceDays: 30 } });
  interactions.add(db, { contactId: a.id, occurredAt: now - 90 * 86400000, kind: "call" });
  return { a, b, c, d };
}
const svc = (db) => new ExploreService({ db, graph: new GraphStore().hydrate(db) });

test("find: ALL vs ANY across typed conditions", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const s = svc(db);

  const pmAtAcme = s.find({ match: "all", conditions: [
    { field: "role", op: "equals", value: "PM" },
    { field: "company", op: "equals", value: "Acme" },
  ] });
  assert.deepEqual(pmAtAcme.results.map((r) => r.name), ["Alice Chen"]);

  const pmOrGlobex = s.find({ match: "any", conditions: [
    { field: "role", op: "equals", value: "PM" },
    { field: "company", op: "equals", value: "Globex" },
  ] });
  assert.deepEqual(pmOrGlobex.results.map((r) => r.name).sort(), ["Alice Chen", "Cy Reyes", "Dana Kim"]);
});

test("find: operators for text, number, list, bool, empty, date", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const s = svc(db);
  const names = (q) => s.find(q).results.map((r) => r.name).sort();

  assert.deepEqual(names({ conditions: [{ field: "name", op: "contains", value: "chen" }] }), ["Alice Chen"]);
  assert.deepEqual(names({ conditions: [{ field: "email", op: "isEmpty" }] }), ["Bo Novak", "Cy Reyes", "Dana Kim"]);
  assert.deepEqual(names({ conditions: [{ field: "degree", op: "gte", value: 2 }] }), ["Alice Chen"]);
  assert.deepEqual(names({ conditions: [{ field: "tags", op: "includes", value: "vip" }] }), ["Alice Chen"]);
  assert.deepEqual(names({ conditions: [{ field: "starred", op: "isTrue" }] }), ["Alice Chen"]);
  assert.deepEqual(names({ conditions: [{ field: "edgeType", op: "includes", value: "friend" }] }), ["Alice Chen", "Cy Reyes"]);
  assert.deepEqual(names({ conditions: [{ field: "overdue", op: "isTrue" }] }), ["Alice Chen"]);
  assert.deepEqual(names({ conditions: [{ field: "gender", op: "equals", value: "Male" }] }), ["Bo Novak", "Cy Reyes"]);
});

test("breakdown groups by a dimension with an unset bucket", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const s = svc(db);
  const gender = s.breakdown("gender");
  assert.equal(gender.total, 4);
  assert.deepEqual(Object.fromEntries(gender.values.map((v) => [v.value, v.count])), { Female: 2, Male: 2 });
  const roles = s.breakdown("role");
  assert.equal(roles.unset, 1); // Dana has no role
});

test("extendedInsights returns the rich stat set", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const s = svc(db);
  const x = s.extendedInsights();
  assert.equal(x.contacts, 4);
  assert.equal(x.connectors[0].name, "Alice Chen");
  assert.ok(x.gender.length === 2);
  assert.equal(x.cadence.withCadence, 1);
  assert.equal(x.missing.phone, 3);
  assert.ok(x.connectivity.isolated >= 1); // Dana Kim has no edges
  assert.equal(x.recentlyAdded.length, 4);
});

test("named Find queries save with kind='find' and list separately", (t) => {
  const { db } = makeDb(t);
  searches.save(db, { name: "text one", query: "org:acme", kind: "text" });
  searches.save(db, { name: "find one", query: JSON.stringify({ match: "all", conditions: [] }), kind: "find" });
  assert.deepEqual(searches.list(db, { kind: "find" }).map((s) => s.name), ["find one"]);
  assert.deepEqual(searches.list(db, { kind: "text" }).map((s) => s.name), ["text one"]);
  assert.equal(searches.list(db).length, 2);
});
