// clearAll: wipes every data table, leaving an empty but valid database.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const interactions = require("../src/main/db/interactions");
const tagsRepo = require("../src/main/db/tags");
const searches = require("../src/main/db/searches");
const { clearAll } = require("../src/main/db/maintenance");
const meta = require("../src/main/db/meta");
const { GraphStore } = require("../src/main/graph/store");
const { makeDb } = require("./helpers");

test("clearAll empties all data tables and reports the count", (t) => {
  const { db } = makeDb(t);
  const a = contacts.create(db, { name: "Alice", fields: { company: "Acme" } });
  const b = contacts.create(db, { name: "Bo" });
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "friend", directed: false });
  interactions.add(db, { contactId: a.id, occurredAt: 1, kind: "call" });
  tagsRepo.setForContact(db, { id: a.id, tags: ["vip"] });
  searches.save(db, { name: "q", query: "org:acme", kind: "text" });
  meta.setProfile(db, { name: "Owner", gender: "Female" }); // owner is a real contact now
  meta.set(db, "sample.dataset", "large");
  const trashed = contacts.create(db, { name: "Trashed" });
  contacts.softDelete(db, trashed.id);

  const r = clearAll(db);
  assert.equal(r.contacts, 4); // Alice + Bo + Owner (live) + Trashed

  // app_meta (owner pointer + sample flag) is wiped, and the owner contact is
  // gone with the rest, for a truly fresh start.
  assert.deepEqual(meta.getProfile(db), {}, "owner profile survived clearAll");
  assert.equal(meta.getOwnerContactId(db), null, "owner pointer survived clearAll");
  assert.equal(meta.get(db, "sample.dataset"), null, "sample flag survived clearAll");

  for (const table of ["contacts", "edges", "interactions", "contact_tags", "tags",
    "layout_positions", "merge_log", "saved_searches", "contacts_search"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c, 0, `${table} not empty`);
  }
  // FTS mirror cleared, schema intact, and a fresh insert still works.
  assert.equal(db.prepare("SELECT COUNT(*) c FROM contacts_fts").get().c, 0);
  const fresh = contacts.create(db, { name: "New Start" });
  assert.equal(fresh.name, "New Start");
  assert.equal(new GraphStore().hydrate(db).order, 1);
});
