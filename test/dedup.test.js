// Dedup: candidate detection, merge semantics, journaled undo.

const test = require("node:test");
const assert = require("node:assert/strict");
const contactsRepo = require("../src/main/db/contacts");
const edgesRepo = require("../src/main/db/edges");
const interactionsRepo = require("../src/main/db/interactions");
const meta = require("../src/main/db/meta");
const dedup = require("../src/main/dedup/engine");
const { makeDb } = require("./helpers");

function seed(db) {
  const a = contactsRepo.create(db, { name: "Alice Chen", fields: { email: "alice@acme.com", company: "Acme", role: "Lead" } });
  const a2 = contactsRepo.create(db, { name: "Alicia Chen", fields: { email: "alice@acme.com", phone: "+1555" } });
  const b = contactsRepo.create(db, { name: "Sam Okafor", fields: { company: "Globex" } });
  const b2 = contactsRepo.create(db, { name: "Sam Okafor", fields: { company: "Globex" } });
  const other = contactsRepo.create(db, { name: "Unrelated Person", fields: { company: "Initech" } });
  return { a, a2, b, b2, other };
}

test("candidates: same email, fuzzy name + same org; strongest first", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const pairs = dedup.candidates(db);
  assert.ok(pairs.length >= 2);
  assert.equal(pairs[0].reason, "same email");
  assert.ok(pairs.some((p) => p.reason === "similar name, same org"));
  assert.ok(!pairs.some((p) => p.a.name === "Unrelated Person" || p.b.name === "Unrelated Person"));
});

test("merge unions fields, re-points edges, moves timeline, soft-deletes secondary", (t) => {
  const { db } = makeDb(t);
  const { a, a2, b } = seed(db);
  edgesRepo.create(db, { sourceId: a2.id, targetId: b.id, type: "friend", directed: false });
  interactionsRepo.add(db, { contactId: a2.id, occurredAt: 111, kind: "call" });

  const { contact, mergeId } = dedup.merge(db, { primaryId: a.id, secondaryId: a2.id });
  assert.equal(contact.fields.role, "Lead", "primary field lost");
  assert.equal(contact.fields.phone, "+1555", "secondary field not unioned");

  assert.equal(contactsRepo.get(db, a2.id), null, "secondary still live");
  const edges = edgesRepo.listFor(db, a.id);
  assert.ok(edges.some((e) => (e.sourceId === b.id || e.targetId === b.id) && e.type === "friend"),
    "edge not re-pointed to primary");
  const timeline = interactionsRepo.list(db, { contactId: a.id });
  assert.equal(timeline.length, 1, "timeline not moved");
  assert.ok(mergeId > 0);
});

test("undo restores both sides exactly", (t) => {
  const { db } = makeDb(t);
  const { a, a2, b } = seed(db);
  edgesRepo.create(db, { sourceId: a2.id, targetId: b.id, type: "friend", directed: false });
  interactionsRepo.add(db, { contactId: a2.id, occurredAt: 111, kind: "call" });
  const fieldsBefore = contactsRepo.get(db, a.id).fields;

  const { mergeId } = dedup.merge(db, { primaryId: a.id, secondaryId: a2.id });
  const r = dedup.undo(db, { mergeId });
  assert.equal(r.ok, true);

  const primary = contactsRepo.get(db, a.id);
  const secondary = contactsRepo.get(db, a2.id);
  assert.deepEqual(primary.fields, fieldsBefore, "primary fields not restored");
  assert.ok(secondary, "secondary not restored");
  assert.equal(edgesRepo.listFor(db, a2.id).length, 1, "secondary edge not restored");
  assert.equal(edgesRepo.listFor(db, a.id).length, 0, "created primary edge not removed");
  assert.equal(interactionsRepo.list(db, { contactId: a2.id }).length, 1, "timeline not moved back");
  assert.throws(() => dedup.undo(db, { mergeId }), (err) => err.code === "NOT_FOUND");
});

test("merge preserves owner identity and remaps family kin metadata; undo restores both", (t) => {
  const { db } = makeDb(t);
  const primary = contactsRepo.create(db, { name: "Alexandra", fields: { email: "alex@example.com" } });
  const ownerDuplicate = contactsRepo.create(db, { name: "Alex", fields: { email: "alex@example.com" } });
  const relative = contactsRepo.create(db, { name: "Relative" });
  meta.setOwnerContact(db, ownerDuplicate.id);
  edgesRepo.create(db, {
    sourceId: ownerDuplicate.id,
    targetId: relative.id,
    type: "family",
    directed: false,
    metadata: { kin: { [ownerDuplicate.id]: "parent", [relative.id]: "child" } },
  });

  const { mergeId } = dedup.merge(db, { primaryId: primary.id, secondaryId: ownerDuplicate.id });
  assert.equal(meta.getOwnerContactId(db), primary.id, "owner pointer still targets the merged-away contact");
  assert.equal(contactsRepo.get(db, primary.id).starred, true, "surviving owner contact was not starred");
  const mergedEdge = edgesRepo.listFor(db, primary.id).find((edge) => edge.type === "family");
  assert.equal(mergedEdge.metadata.kin[primary.id], "parent", "kin role was not remapped to the surviving contact");
  assert.equal(mergedEdge.metadata.kin[ownerDuplicate.id], undefined, "stale merged contact remained in kin metadata");

  dedup.undo(db, { mergeId });
  assert.equal(meta.getOwnerContactId(db), ownerDuplicate.id, "undo did not restore the original owner pointer");
  assert.equal(contactsRepo.get(db, primary.id).starred, false, "undo did not restore the primary's starred state");
  const restoredEdge = edgesRepo.listFor(db, ownerDuplicate.id).find((edge) => edge.type === "family");
  assert.equal(restoredEdge.metadata.kin[ownerDuplicate.id], "parent", "undo did not restore original kin metadata");
});

test("merge combines metadata when re-pointing collides with an existing family edge", (t) => {
  const { db } = makeDb(t);
  const primary = contactsRepo.create(db, { name: "Primary" });
  const duplicate = contactsRepo.create(db, { name: "Duplicate" });
  const relative = contactsRepo.create(db, { name: "Relative" });
  const primaryMetadata = { kin: { [primary.id]: "parent", [relative.id]: "child" }, note: "keep-primary" };
  const duplicateMetadata = { kin: { [duplicate.id]: "sibling", [relative.id]: "sibling" }, source: "duplicate" };
  edgesRepo.create(db, { sourceId: primary.id, targetId: relative.id, type: "family", directed: false, metadata: primaryMetadata });
  edgesRepo.create(db, { sourceId: duplicate.id, targetId: relative.id, type: "family", directed: false, metadata: duplicateMetadata });

  const { mergeId } = dedup.merge(db, { primaryId: primary.id, secondaryId: duplicate.id });
  const edge = edgesRepo.listFor(db, primary.id).find((item) => item.type === "family");
  assert.equal(edge.metadata.kin[primary.id], "parent", "existing primary kin role should win a collision");
  assert.equal(edge.metadata.kin[duplicate.id], undefined, "collision retained a stale contact id");
  assert.equal(edge.metadata.source, "duplicate", "non-conflicting metadata was dropped");
  assert.equal(edge.metadata.note, "keep-primary");

  dedup.undo(db, { mergeId });
  assert.deepEqual(edgesRepo.listFor(db, primary.id)[0].metadata, primaryMetadata, "primary edge metadata was not restored");
  assert.deepEqual(edgesRepo.listFor(db, duplicate.id)[0].metadata, duplicateMetadata, "secondary edge metadata was not restored");
});

test("merging across the business flag never leaves a gendered business", (t) => {
  const { db } = makeDb(t);
  const person = contactsRepo.create(db, { name: "Ravi Stores", fields: { email: "shop@x.com", gender: "Male" } });
  const biz = contactsRepo.create(db, { name: "Ravi Stores", fields: { email: "shop@x.com", business: "yes" } });
  const { contact } = dedup.merge(db, { primaryId: biz.id, secondaryId: person.id });
  assert.equal(contact.fields.business, "yes");
  assert.equal(contact.fields.gender, undefined, "dedup merge kept a gender on a business");
});
