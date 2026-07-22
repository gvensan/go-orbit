// Relationship upkeep: cadence/starred fields, insights:summary, quick-add parsing.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const interactions = require("../src/main/db/interactions");
const { GraphStore } = require("../src/main/graph/store");
const { buildRegistry } = require("../src/main/ipc/registry");
const { parseQuickAdd, quickAddPreview, isQuickAdd } = require("../src/shared/quick-add");
const { makeDb } = require("./helpers");

test("starred and cadenceDays round-trip through update; 0 clears cadence", (t) => {
  const { db } = makeDb(t);
  const c = contacts.create(db, { name: "Kept InTouch" });
  assert.equal(c.starred, false);
  assert.equal(c.cadenceDays, null);

  let u = contacts.update(db, { id: c.id, patch: { starred: true, cadenceDays: 90 } });
  assert.equal(u.starred, true);
  assert.equal(u.cadenceDays, 90);
  assert.equal(contacts.get(db, c.id).cadenceDays, 90);

  u = contacts.update(db, { id: c.id, patch: { cadenceDays: 0 } });
  assert.equal(u.cadenceDays, null);
  assert.equal(u.starred, true, "unrelated patch reset starred");
});

test("insights:summary surfaces overdue cadences and dormant connectors", (t) => {
  const { db } = makeDb(t);
  const now = Date.now();
  const overdueC = contacts.create(db, { name: "Overdue Olga", fields: { company: "Acme" } });
  const freshC = contacts.create(db, { name: "Fresh Fred", fields: { company: "Acme" } });
  const dormantC = contacts.create(db, { name: "Dormant Dana", fields: { company: "Globex" } });
  const leaf = contacts.create(db, { name: "Lonely Leaf" });

  contacts.update(db, { id: overdueC.id, patch: { cadenceDays: 30 } });
  contacts.update(db, { id: freshC.id, patch: { cadenceDays: 30 } });
  interactions.add(db, { contactId: overdueC.id, occurredAt: now - 90 * 86400000, kind: "call" });
  interactions.add(db, { contactId: freshC.id, occurredAt: now - 86400000, kind: "call" });
  // dormant: connected but last touch 200 days ago; leaf has no edges at all
  edges.create(db, { sourceId: dormantC.id, targetId: freshC.id, type: "friend", directed: false });
  edges.create(db, { sourceId: dormantC.id, targetId: overdueC.id, type: "friend", directed: false });
  interactions.add(db, { contactId: dormantC.id, occurredAt: now - 200 * 86400000, kind: "email" });

  const reg = buildRegistry(/** @type {any} */ ({ db, graph: new GraphStore().hydrate(db) }));
  const s = reg["insights:summary"].handle(reg["insights:summary"].validate({}));

  assert.equal(s.contacts, 4);
  assert.deepEqual(s.overdue.map((o) => o.name), ["Overdue Olga"]);
  assert.ok(s.overdue[0].overdueDays >= 59);
  assert.ok(s.dormant.some((d) => d.name === "Dormant Dana"));
  assert.ok(!s.dormant.some((d) => d.name === "Lonely Leaf"), "edge-less contact counted as dormant");
  assert.ok(!s.dormant.some((d) => d.name === "Fresh Fred"));
  assert.equal(s.orgs[0].org, "Acme");
  assert.equal(s.connectors[0].name, "Dormant Dana");
});

test("quick add parses names, org/role, contact points, intro, and tags", () => {
  assert.equal(isQuickAdd("hello world"), false);

  const p = parseQuickAdd("met Sarah Kim, PM at Initech, via Bo Novak, sarah@initech.com #conf #design");
  assert.equal(p.name, "Sarah Kim");
  assert.equal(p.fields.role, "PM");
  assert.equal(p.fields.company, "Initech");
  assert.equal(p.fields.email, "sarah@initech.com");
  assert.equal(p.introducedBy, "Bo Novak");
  assert.deepEqual(p.tags, ["conf", "design"]);
  assert.ok(quickAddPreview(p).includes("PM at Initech"));

  const q = parseQuickAdd("add Omar Haddad at Globex, +1 555 010 9999, great chat about graphs");
  assert.equal(q.name, "Omar Haddad");
  assert.equal(q.fields.company, "Globex");
  assert.equal(q.fields.phone, "+1 555 010 9999");
  assert.equal(q.fields.notes, "great chat about graphs");

  assert.equal(parseQuickAdd("met "), null);
  assert.equal(parseQuickAdd("+ Zara Khan").name, "Zara Khan");
});
