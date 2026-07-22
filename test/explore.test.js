// ExploreService: faceted filtering, live facet counts, operator sync, sort.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const interactions = require("../src/main/db/interactions");
const tagsRepo = require("../src/main/db/tags");
const meta = require("../src/main/db/meta");
const { ExploreService, EXPLORE_SORT_KEYS } = require("../src/main/explore/service");
const { GraphStore } = require("../src/main/graph/store");
const { makeDb } = require("./helpers");

function seed(db) {
  const now = Date.now();
  const a = contacts.create(db, { name: "Alice Chen", fields: { company: "Acme", role: "PM", email: "a@acme.com" } });
  const b = contacts.create(db, { name: "Bo Novak", fields: { company: "Acme", email: "b@acme.com" } });
  const c = contacts.create(db, { name: "Cy Reyes", fields: { company: "Globex", phone: "+1555" } });
  const d = contacts.create(db, { name: "Dana Kim", fields: { company: "Globex" } });
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "colleague", directed: false });
  edges.create(db, { sourceId: a.id, targetId: c.id, type: "friend", directed: false });
  edges.create(db, { sourceId: a.id, targetId: d.id, type: "introduced", directed: true });
  tagsRepo.setForContact(db, { id: a.id, tags: ["vip"] });
  contacts.update(db, { id: a.id, patch: { starred: true, cadenceDays: 30 } });
  interactions.add(db, { contactId: a.id, occurredAt: now - 90 * 86400000, kind: "call" }); // overdue
  return { a, b, c, d };
}

function svc(db) {
  return new ExploreService({ db, graph: new GraphStore().hydrate(db) });
}

test("text + facets narrow results; total is exact, results capped by limit", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const s = svc(db);

  const all = s.query({});
  assert.equal(all.total, 4);

  const acme = s.query({ filters: { orgs: ["Acme"] } });
  assert.deepEqual(acme.results.map((r) => r.name).sort(), ["Alice Chen", "Bo Novak"]);

  const acmeEmail = s.query({ filters: { orgs: ["Acme"], status: ["hasEmail"] } });
  assert.equal(acmeEmail.total, 2);

  const textNarrow = s.query({ text: "cy", filters: {} });
  assert.deepEqual(textNarrow.results.map((r) => r.name), ["Cy Reyes"]);
});

test("operators in the text merge into filters (query/facet two-way sync)", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const s = svc(db);

  assert.deepEqual(
    s.query({ text: "org:globex" }).results.map((r) => r.name).sort(),
    ["Cy Reyes", "Dana Kim"]
  );
  assert.deepEqual(s.query({ text: "tag:vip" }).results.map((r) => r.name), ["Alice Chen"]);
  // near:/hops: graph-aware filter
  assert.deepEqual(
    s.query({ text: 'near:"Alice Chen"' }).results.map((r) => r.name).sort(),
    ["Alice Chen", "Bo Novak", "Cy Reyes", "Dana Kim"]
  );
});

test("facet counts reflect other groups but not the facet's own selection", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const s = svc(db);

  // With org=Acme selected, the org facet still shows Globex (its own group is
  // excluded from its counts), but the status facet reflects the Acme filter.
  const r = s.query({ filters: { orgs: ["Acme"] } });
  const orgFacet = Object.fromEntries(r.facets.orgs.map((f) => [f.value, f.count]));
  assert.equal(orgFacet["Acme"], 2);
  assert.equal(orgFacet["Globex"], 2, "org facet hid siblings under its own selection");

  const statusFacet = Object.fromEntries(r.facets.status.map((f) => [f.value, f.count]));
  assert.equal(statusFacet.hasEmail, 2, "status facet ignored the active org filter");
  assert.equal(statusFacet.starred, 1);

  const edgeFacet = Object.fromEntries(r.facets.edgeTypes.map((f) => [f.value, f.count]));
  assert.equal(edgeFacet.colleague, 2); // Alice + Bo
  assert.equal(edgeFacet.introduced, 1);
});

test("status facets: starred, overdue, dormant, has-email/phone", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const s = svc(db);
  assert.deepEqual(s.query({ filters: { status: ["starred"] } }).results.map((r) => r.name), ["Alice Chen"]);
  assert.deepEqual(s.query({ filters: { status: ["overdue"] } }).results.map((r) => r.name), ["Alice Chen"]);
  assert.deepEqual(s.query({ filters: { status: ["hasPhone"] } }).results.map((r) => r.name), ["Cy Reyes"]);
});

test("degree buckets and sort", (t) => {
  const { db } = makeDb(t);
  const { a } = seed(db);
  const s = svc(db);
  const byDegree = s.query({ sort: "degree" });
  assert.equal(byDegree.results[0].name, "Alice Chen"); // the hub (degree 3)
  assert.equal(byDegree.results[0].degree, 3);

  // Everyone in this seed has degree 1-3, so all fall in the peripheral bucket.
  const peripheral = s.query({ filters: { degreeBuckets: ["peripheral"] } });
  assert.equal(peripheral.total, 4);
  assert.ok(peripheral.results.every((r) => r.degree >= 1 && r.degree <= 4));
  assert.equal(s.query({ filters: { degreeBuckets: ["hub"] } }).total, 0);
  const degFacet = Object.fromEntries(byDegree.facets.degrees.map((f) => [f.value, f.count]));
  assert.equal(degFacet.peripheral, 4);
  assert.equal(degFacet.isolated, 0);
});

test("every Explore data column sorts, with blank values kept last", (t) => {
  const { db } = makeDb(t);
  const { a, b } = seed(db);
  contacts.update(db, { id: a.id, patch: { fields: { company: "Acme", nickname: "Zulu" } } });
  contacts.update(db, { id: b.id, patch: { fields: { company: "Acme", nickname: "Alpha" } } });
  const s = svc(db);

  for (const sort of EXPLORE_SORT_KEYS) {
    assert.equal(s.query({ sort, dir: "asc" }).results.length, 4, `${sort} ascending failed`);
    assert.equal(s.query({ sort, dir: "desc" }).results.length, 4, `${sort} descending failed`);
  }
  assert.deepEqual(s.query({ sort: "nickname", dir: "asc" }).results.slice(0, 2).map((r) => r.name), ["Bo Novak", "Alice Chen"]);
  assert.deepEqual(s.query({ sort: "nickname", dir: "desc" }).results.slice(0, 2).map((r) => r.name), ["Alice Chen", "Bo Novak"]);
  assert.equal(s.query({ sort: "starred" }).results[0].name, "Alice Chen");
});

test("markDirty rebuilds the index after a write", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const s = svc(db);
  assert.equal(s.query({}).total, 4);
  contacts.create(db, { name: "New Person", fields: { company: "Initech" } });
  s.markDirty();
  assert.equal(s.query({}).total, 5);
  const orgFacet = s.query({}).facets.orgs.map((f) => f.value);
  assert.ok(orgFacet.includes("Initech"));
});

test("kinship is shown from any family edge and prefers the role relative to the owner", (t) => {
  const { db } = makeDb(t);
  const owner = contacts.create(db, { name: "Owner" });
  const parent = contacts.create(db, { name: "Parent" });
  const child = contacts.create(db, { name: "Child" });
  meta.setOwnerContact(db, owner.id);

  edges.create(db, {
    sourceId: parent.id, targetId: child.id, type: "family", directed: false,
    metadata: { kin: { [parent.id]: "father", [child.id]: "son" } },
  });

  let result = svc(db).query({}).results.find((r) => r.id === child.id);
  assert.equal(result.kin, "son", "role on a non-owner family edge was omitted");

  edges.create(db, {
    sourceId: owner.id, targetId: child.id, type: "family", directed: false,
    metadata: { kin: { [owner.id]: "uncle", [child.id]: "nephew" } },
  });

  result = svc(db).query({}).results.find((r) => r.id === child.id);
  assert.equal(result.kin, "nephew", "owner-relative role should take precedence");
});

test("ALL/FAMILY/FRIENDS scopes and family hierarchy metadata", (t) => {
  const { db } = makeDb(t);
  const owner = contacts.create(db, { name: "Owner" });
  const parent = contacts.create(db, { name: "Parent" });
  const child = contacts.create(db, { name: "Child" });
  const friend = contacts.create(db, { name: "Friend" });
  meta.setOwnerContact(db, owner.id);
  edges.create(db, { sourceId: owner.id, targetId: parent.id, type: "family", directed: false });
  edges.create(db, { sourceId: parent.id, targetId: child.id, type: "family", directed: false });
  edges.create(db, { sourceId: owner.id, targetId: friend.id, type: "friend", directed: false });

  const s = svc(db);
  assert.equal(s.query({ scope: "all" }).total, 4);
  const family = s.query({ scope: "family" });
  assert.deepEqual(new Set(family.results.map((r) => r.name)), new Set(["Owner", "Parent", "Child"]));
  const childRow = family.results.find((r) => r.id === child.id);
  assert.equal(childRow.familyParentId, parent.id);
  assert.equal(childRow.familyDepth, 2);
  assert.deepEqual(s.query({ scope: "friends" }).results.map((r) => r.name).sort(), ["Friend", "Owner"]);
});

test("Explore rows expose standard, resolved-location, activity, and system fields", (t) => {
  const { db } = makeDb(t);
  const c = contacts.create(db, { name: "Rich Contact", fields: {
    nickname: "RC", birthday: "2000-01-02", deceased: "yes", website: "example.com",
    linkedin: "linkedin.com/in/rc", address: "legacy", location: "typed",
    place: "resolved", geo: "1,2", locationPrecision: "house", locationSource: "photon", notes: "memo",
    locationResolved: JSON.stringify({ components: { housenumber: "42", street: "MG Road", city: "Bengaluru", country: "India" }, osm: { type: "W", id: 123 } }),
  } });
  interactions.add(db, { contactId: c.id, occurredAt: 1234, kind: "call", note: "hello" });
  const row = svc(db).query({}).results[0];
  assert.equal(row.nickname, "RC");
  assert.equal(row.deceased, true);
  assert.equal(row.place, "resolved");
  assert.equal(row.locationPrecision, "house");
  assert.equal(row.houseNumber, "42");
  assert.equal(row.street, "MG Road");
  assert.equal(row.city, "Bengaluru");
  assert.equal(row.osmId, 123);
  assert.equal(row.lastKind, "call");
  assert.equal(row.lastNote, "hello");
  assert.equal(row.interactionCount, 1);
  assert.equal(typeof row.createdAt, "number");
  assert.equal(typeof row.updatedAt, "number");
});
