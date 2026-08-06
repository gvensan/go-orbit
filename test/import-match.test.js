// Import match preview + per-record decisions + results annotation round-trip.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");
const { matchRecords } = require("../src/main/ingest/match");
const { importContacts } = require("../src/main/ingest/importer");
const { resultsToCSV, parseCSV, suggestMapping, rowsToContacts } = require("../src/main/ingest/csv");
const { makeDb } = require("./helpers");

test("matchRecords: strong email match ranks first, with reason + connections", (t) => {
  const { db } = makeDb(t);
  const alice = contacts.create(db, { name: "Alice Chen", fields: { email: "alice@acme.com", phone: "+1 555 0100", company: "Acme" } }).id;
  const bob = contacts.create(db, { name: "Bob Roy", fields: {} }).id;
  edges.create(db, { sourceId: alice, targetId: bob, type: "colleague", directed: false });

  const res = matchRecords(db, [
    { name: "Alicia Chen", fields: { email: "ALICE@acme.com" } }, // strong (email)
    { name: "Zed Newman", fields: { email: "zed@x.com" } },       // new
  ]);
  assert.equal(res.length, 2);
  const top = res[0].candidates[0];
  assert.equal(top.contactId, alice);
  assert.equal(top.score, 1.0);
  assert.ok(top.reasons.includes("shares an email"));
  assert.ok(top.connections.some((c) => c.name === "Bob Roy" && c.type === "colleague"));
  assert.equal(res[1].candidates.length, 0, "unrelated record has no candidates");
});

test("matchRecords: fuzzy name via shared-surname bucket (first-name typo)", (t) => {
  const { db } = makeDb(t);
  contacts.create(db, { name: "Jonathan Smith", fields: { company: "Globex" } });
  // "Johnathan" differs from "Jonathan" in the first 3 chars, but shares the
  // "smi" surname bucket, so it is still fuzzy-compared.
  const res = matchRecords(db, [{ name: "Johnathan Smith", fields: { company: "Globex" } }]);
  assert.ok(res[0].candidates.length >= 1, "fuzzy surname bucket found a candidate");
  assert.ok(res[0].candidates[0].reasons.some((r) => /name/.test(r)));
});

test("matchRecords: in-file duplicates flag each other", (t) => {
  const { db } = makeDb(t);
  const res = matchRecords(db, [
    { name: "Dup Person", fields: { email: "dup@x.com" } },
    { name: "Someone Else", fields: { email: "else@x.com" } },
    { name: "Dup Person 2", fields: { email: "DUP@x.com" } }, // same email as #0
  ]);
  assert.deepEqual(res[0].inFileDup, [2]);
  assert.deepEqual(res[2].inFileDup, [0]);
  assert.deepEqual(res[1].inFileDup, []);
});

test("importContacts: per-record decisions override the global policy", (t) => {
  const { db } = makeDb(t);
  const alice = contacts.create(db, { name: "Alice Chen", fields: { email: "alice@acme.com" } }).id;

  const incoming = [
    { name: "Alicia", fields: { email: "alice@acme.com", phone: "+1999" }, externalId: 0, decision: { mode: "merge", targetId: alice } },
    { name: "Ignore Me", fields: { email: "im@x.com" }, externalId: 1, decision: { mode: "ignore" } },
    { name: "Force New", fields: { email: "alice@acme.com" }, externalId: 2, decision: { mode: "new" } }, // dup email but forced new
  ];
  // Global policy "skip" would skip the two email dups; decisions override it.
  const r = importContacts(db, incoming, { onDuplicate: "skip" });
  assert.equal(r.merged, 1, "decision merge applied");
  assert.equal(r.ignored, 1, "decision ignore applied");
  assert.equal(r.imported, 1, "decision new forced an insert despite the email dup");
  assert.equal(contacts.get(db, alice).fields.phone, "+1999", "merge filled the blank phone");
  assert.equal(r.idMap.get(1), undefined, "ignored record has no id (no relationship)");
  assert.equal(r.idMap.get(0), alice, "merged record maps to the target");
});

test("importContacts: merge into a vanished target falls through to insert", (t) => {
  const { db } = makeDb(t);
  const r = importContacts(db, [
    { name: "Orphan", fields: {}, externalId: 0, decision: { mode: "merge", targetId: 999 } },
  ], { onDuplicate: "skip" });
  assert.equal(r.imported, 1, "missing merge target inserts as new instead of crashing");
});

test("results annotation: orbit_status round-trips through export -> re-parse", () => {
  const csv = resultsToCSV([
    { name: "Kept", fields: { email: "kept@x.com" }, tags: ["vip"], status: "imported" },
    { name: "Skipped", fields: { email: "skip@x.com" }, tags: [], status: "ignored" },
  ], "2026-07-27");
  const { headers, rows } = parseCSV(csv);
  assert.ok(headers.includes("orbit_status"));
  const parsed = rowsToContacts(headers, rows, suggestMapping(headers));
  assert.equal(parsed[0].fields.orbit_status, "imported", "status preserved on re-parse even though unmapped");
  assert.equal(parsed[1].fields.orbit_status, "ignored");
  assert.equal(parsed[0].fields.orbit_status_at, "2026-07-27");
});
