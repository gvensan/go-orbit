// Sample-network seeding: counts, structure, idempotent id allocation,
// searchability, and graph hydration.

const test = require("node:test");
const assert = require("node:assert/strict");
const { seedSample } = require("../src/main/db/sample");
const { GraphStore } = require("../src/main/graph/store");
const { prepareStatements, search } = require("../src/main/search/engine");
const meta = require("../src/main/db/meta");
const edgesRepo = require("../src/main/db/edges");
const { makeDb } = require("./helpers");

test("seeds the requested count with clustered edges, tags, and search rows", (t) => {
  const { db } = makeDb(t);
  const r = seedSample(db, { count: 200 });
  assert.equal(r.contacts, 200);
  assert.ok(r.edges > 200 * 4, `too few edges: ${r.edges}`);

  const store = new GraphStore().hydrate(db);
  assert.equal(store.order, 200);
  assert.equal(store.size, r.edges);

  const tagged = db.prepare("SELECT COUNT(DISTINCT contact_id) c FROM contact_tags").get().c;
  assert.ok(tagged > 0, "no tags seeded");

  const found = search(prepareStatements(db), { text: "chen", requestId: 1 });
  assert.ok(found.results.length > 0, "seeded contacts are not searchable");
});

test("seeding twice allocates fresh ids with no collisions", (t) => {
  const { db } = makeDb(t);
  seedSample(db, { count: 50 });
  seedSample(db, { count: 50 });
  const n = db.prepare("SELECT COUNT(*) c FROM contacts").get().c;
  assert.equal(n, 100);
});

test("withOwnerFamily seeds the owner as a contact wired to family with kin roles", (t) => {
  const { db } = makeDb(t);
  seedSample(db, { count: 100, withOwnerFamily: true });

  // The owner is a real contact (Sam), pointed to by app_meta, and starred.
  const ownerId = meta.getOwnerContactId(db);
  assert.ok(ownerId, "owner.contactId not set");
  const owner = meta.getProfile(db);
  assert.ok(owner.name && owner.gender, "owner profile not projectable");

  // The owner has family edges to their inner circle, carrying kin metadata.
  const ownerEdges = edgesRepo.listFor(db, ownerId).filter((e) => e.type === "family" && e.metadata && e.metadata.kin);
  assert.ok(ownerEdges.length >= 4, `owner should be wired to their family, got ${ownerEdges.length}`);
  const roles = ownerEdges.flatMap((e) => Object.values(e.metadata.kin));
  assert.ok(roles.length >= 1 && roles.every((r) => typeof r === "string"), "kin roles missing/invalid");
});
