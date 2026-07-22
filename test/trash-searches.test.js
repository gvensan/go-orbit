// Trash purge (the only hard delete), auto-purge policy, and saved searches.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const interactions = require("../src/main/db/interactions");
const tagsRepo = require("../src/main/db/tags");
const searches = require("../src/main/db/searches");
const { makeDb } = require("./helpers");

test("purge hard-deletes a trashed contact and cascades derived rows", (t) => {
  const { db } = makeDb(t);
  const a = contacts.create(db, { name: "Doomed Soul" });
  const b = contacts.create(db, { name: "Bystander" });
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "friend", directed: false });
  interactions.add(db, { contactId: a.id, occurredAt: 1, kind: "call" });
  tagsRepo.setForContact(db, { id: a.id, tags: ["gone"] });
  db.prepare("INSERT INTO layout_positions (contact_id, x, y, updated_at) VALUES (?, 1, 2, 3)").run(a.id);

  // Live contacts are refused: soft-delete first, always.
  assert.throws(() => contacts.purge(db, a.id), (err) => err.code === "NOT_FOUND");

  contacts.softDelete(db, a.id);
  const r = contacts.purge(db, a.id);
  assert.deepEqual(r, { id: a.id, purged: true });

  assert.equal(db.prepare("SELECT COUNT(*) c FROM contacts WHERE id = ?").get(a.id).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM edges").get().c, 0, "edges not cascaded");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM interactions").get().c, 0, "interactions not cascaded");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM contact_tags").get().c, 0, "tags not cascaded");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tags").get().c, 0, "orphan tag definition not collected");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM layout_positions").get().c, 0, "layout not cascaded");
  assert.equal(contacts.get(db, b.id)?.name, "Bystander", "bystander harmed");
});

test("autoPurge removes only contacts trashed beyond the cutoff", (t) => {
  const { db } = makeDb(t);
  const oldOne = contacts.create(db, { name: "Long Gone" });
  const recent = contacts.create(db, { name: "Just Trashed" });
  tagsRepo.setForContact(db, { id: recent.id, tags: ["shared"] });
  tagsRepo.setForContact(db, { id: oldOne.id, tags: ["old-only"] });
  contacts.softDelete(db, oldOne.id);
  contacts.softDelete(db, recent.id);
  db.prepare("UPDATE contacts SET deleted_at = ? WHERE id = ?")
    .run(Date.now() - 40 * 86400000, oldOne.id);

  assert.equal(contacts.autoPurge(db, 30), 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM contacts").get().c, 1);
  assert.equal(
    db.prepare("SELECT deleted_at IS NOT NULL trashed FROM contacts WHERE id = ?").get(recent.id).trashed,
    1,
    "recent trash purged too early"
  );
  assert.deepEqual(tagsRepo.list(db).map((tag) => tag.name), ["shared"], "auto-purge left an orphan tag");
});

test("saved searches: save, replace by name, list, delete", (t) => {
  const { db } = makeDb(t);
  const s1 = searches.save(db, { name: "acme folks", query: "org:acme" });
  assert.ok(s1.id > 0);
  searches.save(db, { name: "vips", query: "tag:vip" });
  searches.save(db, { name: "acme folks", query: "org:acme has:email" }); // replace

  const all = searches.list(db);
  assert.deepEqual(all.map((s) => s.name), ["acme folks", "vips"]);
  assert.equal(all[0].query, "org:acme has:email");

  assert.deepEqual(searches.remove(db, all[1].id), { ok: true });
  assert.deepEqual(searches.remove(db, 9999), { ok: false });
  assert.equal(searches.list(db).length, 1);
});
