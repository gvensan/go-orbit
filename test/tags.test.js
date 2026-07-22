// Tags: set/replace per contact, normalization, GC of unused tags, FTS sync.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const tags = require("../src/main/db/tags");
const { makeDb } = require("./helpers");

const ftsHits = (db, term) =>
  db.prepare("SELECT rowid FROM contacts_fts WHERE contacts_fts MATCH ?").all(term);

test("setForContact normalizes, replaces, and GCs unused tags", (t) => {
  const { db } = makeDb(t);
  const c = contacts.create(db, { name: "Taggy Person" });

  const r1 = tags.setForContact(db, { id: c.id, tags: [" Mentor", "VIP ", "mentor"] });
  assert.deepEqual(r1.tags, ["mentor", "vip"]);
  assert.deepEqual(tags.forContact(db, c.id), ["mentor", "vip"]);
  assert.equal(ftsHits(db, "mentor").length, 1, "tags not searchable");

  tags.setForContact(db, { id: c.id, tags: ["vip"] });
  assert.deepEqual(tags.list(db).map((x) => x.name), ["vip"], "unused tag not GC'd");
  assert.equal(ftsHits(db, "mentor").length, 0, "removed tag still searchable");
});

test("setForContact on a trashed contact rejects NOT_FOUND", (t) => {
  const { db } = makeDb(t);
  const c = contacts.create(db, { name: "Gone" });
  contacts.softDelete(db, c.id);
  assert.throws(
    () => tags.setForContact(db, { id: c.id, tags: ["x"] }),
    (err) => err.code === "NOT_FOUND"
  );
});
