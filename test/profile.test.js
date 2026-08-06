// The owner ("you") - a real contact pointed to by app_meta owner.contactId.

const test = require("node:test");
const assert = require("node:assert/strict");
const meta = require("../src/main/db/meta");
const contacts = require("../src/main/db/contacts");
const { makeDb } = require("./helpers");

test("profile defaults to empty, then backs a real starred contact", (t) => {
  const { db } = makeDb(t);

  assert.deepEqual(meta.getProfile(db), {}, "fresh install has an empty profile");
  assert.equal(meta.getOwnerContactId(db), null);

  const saved = meta.setProfile(db, { name: "  Giri  ", gender: "Male", email: "", role: "   " });
  assert.deepEqual(saved, { name: "Giri", gender: "Male" }, "trims and drops blank fields");

  // It created an owner contact, starred, and app_meta points at it.
  const id = meta.getOwnerContactId(db);
  assert.ok(id, "owner.contactId not set");
  const c = contacts.get(db, id);
  assert.equal(c.name, "Giri");
  assert.equal(c.starred, true);
  assert.equal(c.fields.gender, "Male");
});

test("updating the profile edits the same owner contact (no duplicate)", (t) => {
  const { db } = makeDb(t);
  meta.setProfile(db, { name: "Giri", gender: "Male", email: "g@example.com", phone: "+1 555" });
  const id1 = meta.getOwnerContactId(db);
  meta.setProfile(db, { name: "Giri V", gender: "Male" });
  const id2 = meta.getOwnerContactId(db);
  assert.equal(id1, id2, "profile update created a second contact");
  // Only submitted keys are touched: the partial save must NOT eat email/phone
  // (the old delete-if-absent contract silently wiped stored fields whenever a
  // caller submitted partially - the "phone vanished from the owner card" bug).
  assert.deepEqual(meta.getProfile(db), { name: "Giri V", gender: "Male", email: "g@example.com", phone: "+1 555" });
  // Clearing is explicit: an empty string removes the field.
  meta.setProfile(db, { email: "" });
  assert.deepEqual(meta.getProfile(db), { name: "Giri V", gender: "Male", phone: "+1 555" });
  assert.equal(contacts.list(db).length, 1, "should be exactly one contact");
});

test("app_meta is a generic key/value store with upsert semantics", (t) => {
  const { db } = makeDb(t);
  assert.equal(meta.get(db, "k"), null);
  meta.set(db, "k", "v1");
  assert.equal(meta.get(db, "k"), "v1");
  meta.set(db, "k", "v2");
  assert.equal(meta.get(db, "k"), "v2");
});
