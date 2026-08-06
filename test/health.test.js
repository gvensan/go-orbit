// Admin data review: the scan finds seeded issues, fixes repair them, triage
// survives reruns, and a fixed finding counts as resolved on the next run.

const test = require("node:test");
const assert = require("node:assert/strict");
const health = require("../src/main/health/engine");
const { makeDb } = require("./helpers");

const now = Date.now();
const addContact = (db, id, name, fields, cadence = null) =>
  db.prepare("INSERT INTO contacts (id, name, fields, cadence_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, name, JSON.stringify(fields), cadence, now, now);
const addEdge = (db, s, t, type, metadata = null, directed = 0) =>
  db.prepare("INSERT INTO edges (source_id, target_id, type, directed, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(s, t, type, directed, metadata ? JSON.stringify(metadata) : null, now);

/** A db seeded with one instance of most detectable problems. */
function seedProblems(t) {
  const { db } = makeDb(t);
  addContact(db, 1, "You", { gender: "Male" });
  db.prepare("INSERT INTO app_meta (key, value, updated_at) VALUES ('owner.contactId', '1', ?)").run(now);
  addContact(db, 2, "Ramya", { gender: "Female" });
  addContact(db, 3, "ACT Support", { business: "yes", gender: "Female" });   // business-with-gender
  addContact(db, 4, "Gone Soon", { gender: "Male", deceased: "yes" }, 30);   // deceased-cadence
  addContact(db, 5, "Bad Fields", { gender: "Male", email: "not-an-email" }); // field-invalid
  addContact(db, 6, "Island", { gender: "Female" });                          // isolated
  addContact(db, 7, "Sonia", { gender: "Male" });                             // kin-gender-conflict below
  addEdge(db, 1, 2, "family", { kin: { 2: "wife" } });
  addEdge(db, 1, 7, "family", { kin: { 7: "daughter" } }); // daughter but gender Male
  addEdge(db, 2, 4, "family");                              // family-missing-kin
  addEdge(db, 4, 4, "friend");                              // self-loop
  addEdge(db, 1, 5, "colleague", { kin: { 5: "brother" } }); // kin-on-nonfamily
  addEdge(db, 1, 3, "nemesis");                             // unknown type
  addEdge(db, 5, 2, "acquaintance");                        // noncanonical (5 > 2, undirected)
  // Orphan interaction: park it on a contact, then hard-delete with FKs off.
  addContact(db, 99, "Ghost", {});
  db.prepare("INSERT INTO interactions (contact_id, occurred_at, kind) VALUES (99, ?, 'call')").run(now);
  db.pragma("foreign_keys = OFF");
  db.prepare("DELETE FROM contacts WHERE id = 99").run();
  db.pragma("foreign_keys = ON");
  return db;
}

const byCheck = (r, check) => r.findings.filter((f) => f.check === check);

test("scan surfaces every seeded issue with the right shape", (t) => {
  const db = seedProblems(t);
  const r = health.scan(db);
  for (const check of [
    "edge-self-loop", "edge-noncanonical", "edge-unknown-type", "kin-on-nonfamily",
    "orphan-rows", "family-missing-kin", "kin-gender-conflict", "business-with-gender",
    "deceased-cadence", "field-invalid", "isolated-contacts",
  ]) {
    assert.equal(byCheck(r, check).length >= 1, true, `expected a ${check} finding`);
  }
  assert.equal(byCheck(r, "owner-unset").length, 0, "owner is set in the fixture");
  for (const f of r.findings) {
    assert.ok(f.fingerprint && f.title && f.detail && ["error", "warn", "info"].includes(f.severity), f.check);
    assert.equal(f.status, "open");
  }
  assert.ok(r.counts.error >= 2 && r.lastRunAt > 0);
});

test("fixes repair, are idempotent, and resolve on the next run", (t) => {
  const db = seedProblems(t);
  const first = health.scan(db);

  const loop = byCheck(first, "edge-self-loop")[0];
  const { label, ...req } = loop.fix;
  assert.equal(health.fix(db, req).ok, true);
  assert.equal(health.fix(db, req).changed, 0, "second run is a no-op");

  const gendered = byCheck(first, "business-with-gender")[0];
  health.fix(db, { kind: "strip-gender", contactId: gendered.contactId });
  const fields = JSON.parse(db.prepare("SELECT fields FROM contacts WHERE id = ?").get(gendered.contactId).fields);
  assert.equal(fields.gender, undefined);
  assert.equal(fields.business, "yes", "only the gender goes");

  const cadence = byCheck(first, "deceased-cadence")[0];
  health.fix(db, { kind: "clear-cadence", contactId: cadence.contactId });
  assert.equal(db.prepare("SELECT cadence_days FROM contacts WHERE id = ?").get(cadence.contactId).cadence_days, null);

  const kin = byCheck(first, "kin-on-nonfamily")[0];
  health.fix(db, { kind: "clear-kin", sourceId: kin.fix.sourceId, targetId: kin.fix.targetId, type: kin.fix.type });

  const noncanon = byCheck(first, "edge-noncanonical")[0];
  health.fix(db, { kind: "canonicalize-edge", sourceId: noncanon.fix.sourceId, targetId: noncanon.fix.targetId, type: noncanon.fix.type });
  const swapped = db.prepare("SELECT 1 FROM edges WHERE source_id = 2 AND target_id = 5 AND type = 'acquaintance'").get();
  assert.ok(swapped, "endpoints reordered into canonical form");

  health.fix(db, { kind: "purge-orphans" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE contact_id = 99").get().n, 0);

  const second = health.scan(db);
  for (const check of ["edge-self-loop", "business-with-gender", "deceased-cadence", "kin-on-nonfamily", "edge-noncanonical", "orphan-rows"]) {
    assert.equal(byCheck(second, check).length, 0, `${check} should be gone after its fix`);
  }
  assert.ok(second.resolvedCount >= 6, `resolved ${second.resolvedCount}, expected >= 6`);
  assert.throws(() => health.fix(db, { kind: "drop-table" }), /Unknown fix/);
});

test("triage survives reruns and prunes when the issue disappears", (t) => {
  const db = seedProblems(t);
  const first = health.scan(db);
  const loop = byCheck(first, "edge-self-loop")[0];
  health.setStatus(db, { fingerprint: loop.fingerprint, status: "ignored" });
  const iso = byCheck(first, "isolated-contacts")[0];
  health.setStatus(db, { fingerprint: iso.fingerprint, status: "deferred" });

  const second = health.scan(db);
  assert.equal(byCheck(second, "edge-self-loop")[0].status, "ignored");
  assert.equal(byCheck(second, "isolated-contacts")[0].status, "deferred");

  // Setting back to open clears the record.
  health.setStatus(db, { fingerprint: iso.fingerprint, status: "open" });
  assert.equal(byCheck(health.scan(db), "isolated-contacts")[0].status, "open");

  // Fix the loop; its ignored record is pruned, so a future recurrence is open.
  const { label, ...req } = loop.fix;
  health.fix(db, req);
  health.scan(db);
  addEdge(db, 4, 4, "friend");
  assert.equal(byCheck(health.scan(db), "edge-self-loop")[0].status, "open", "pruned triage does not stick to a recurrence");
  assert.throws(() => health.setStatus(db, { fingerprint: "x", status: "later" }), /Unknown status/);
});

test("a stray kin key is its own finding, never attributed to whoever holds the id", (t) => {
  const { db } = makeDb(t);
  addContact(db, 1, "Shyamala", { gender: "Female" });
  addContact(db, 2, "Varshini", { gender: "Female" });
  addContact(db, 3, "Kannan VS", { gender: "Male" });
  // The user's case: a family tie whose kin map carries an id from an old
  // merge/import - id 3 belongs to Kannan today, who is not on this tie.
  addEdge(db, 1, 2, "family", { kin: { 2: "daughter", 3: "mother" } });

  const r = health.scan(db);
  assert.equal(byCheck(r, "kin-gender-conflict").length, 0,
    "no conflict may be reported against a non-endpoint contact");
  const stray = byCheck(r, "kin-stray-key");
  assert.equal(stray.length, 1);
  assert.match(stray[0].detail, /Kannan VS/);

  const { label, ...req } = stray[0].fix;
  assert.equal(health.fix(db, req).changed, 1);
  assert.equal(health.fix(db, req).changed, 0, "idempotent");
  const m = JSON.parse(db.prepare("SELECT metadata FROM edges WHERE source_id = 1 AND target_id = 2").get().metadata);
  assert.deepEqual(m.kin, { 2: "daughter" }, "the endpoint's own role survives");
  assert.equal(byCheck(health.scan(db), "kin-stray-key").length, 0);
});

test("the last run persists and reloads with triage re-merged", (t) => {
  const db = seedProblems(t);
  assert.equal(health.lastResult(db), null, "no run yet");
  const first = health.scan(db);
  const loop = byCheck(first, "edge-self-loop")[0];
  health.setStatus(db, { fingerprint: loop.fingerprint, status: "deferred" });

  const restored = health.lastResult(db);
  assert.equal(restored.findings.length, first.findings.length);
  assert.equal(restored.lastRunAt, first.lastRunAt);
  const restoredLoop = restored.findings.find((f) => f.fingerprint === loop.fingerprint);
  assert.equal(restoredLoop.status, "deferred", "triage done after the run still shows on reload");
});
