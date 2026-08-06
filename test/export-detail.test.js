// Detailed CSV export must not emit duplicate relationship rows when the same
// undirected tie is stored as two directed edge rows (source->target AND
// target->source), as happens for reciprocal family links.

const test = require("node:test");
const assert = require("node:assert");
const { makeDb } = require("./helpers");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const { contactReviewRows } = require("../src/main/ipc/registry");

test("detailed export collapses a double-stored reciprocal family tie to one row", (t) => {
  const { db } = makeDb(t);
  const adhya = contacts.create(db, { name: "Adhya Ravindra", fields: { gender: "Female" } });
  const hema = contacts.create(db, { name: "Hema Ravindra", fields: { gender: "Female" } });

  // The same relationship stored from both directions (the legacy shape that
  // produced the duplicate rows). edges.create now canonicalises and would reject
  // the reverse, so write the twin rows directly to reproduce pre-migration data.
  const ins = db.prepare(
    "INSERT INTO edges (source_id, target_id, type, directed, metadata, created_at) VALUES (?,?,?,?,?,?)"
  );
  const kin = JSON.stringify({ kin: { [adhya.id]: "daughter", [hema.id]: "mother" } });
  ins.run(adhya.id, hema.id, "family", 0, kin, Date.now());
  ins.run(hema.id, adhya.id, "family", 0, kin, Date.now());

  const nameById = new Map([[adhya.id, adhya.name], [hema.id, hema.name]]);
  const rows = contactReviewRows(db, adhya, [], nameById);

  assert.equal(rows.length, 1, "one relationship row, not a duplicate");
  assert.equal(rows[0].relationship, "family");
  assert.equal(rows[0].relationshipTo, "Hema Ravindra");
  assert.equal(rows[0].kinship, "daughter");
});

test("detailed export keeps distinct ties to two different same-named contacts", (t) => {
  const { db } = makeDb(t);
  const giri = contacts.create(db, { name: "Giri", fields: {} });
  // Two genuinely different people who share a name must not be collapsed.
  const a = contacts.create(db, { name: "Abhishek Sharma", fields: { phone: "+1 111" } });
  const b = contacts.create(db, { name: "Abhishek Sharma", fields: { phone: "+2 222" } });
  edges.create(db, { sourceId: giri.id, targetId: a.id, type: "colleague", directed: false });
  edges.create(db, { sourceId: giri.id, targetId: b.id, type: "acquaintance", directed: false });

  const nameById = new Map([[giri.id, "Giri"], [a.id, "Abhishek Sharma"], [b.id, "Abhishek Sharma"]]);
  const rows = contactReviewRows(db, giri, [], nameById);
  assert.equal(rows.length, 2, "both ties survive - dedup is keyed on contact id, not name");
});
