// Root-cause coverage: undirected ties are stored canonically (source <= target)
// so the same relationship can never become two reverse rows, and the cleanup
// migration collapses any that legacy data already produced.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { makeDb } = require("./helpers");
const contacts = require("../src/main/db/contacts");
const edges = require("../src/main/db/edges");

test("undirected edge is stored canonically regardless of create order", (t) => {
  const { db } = makeDb(t);
  const a = contacts.create(db, { name: "A", fields: {} });
  const b = contacts.create(db, { name: "B", fields: {} });
  const hi = Math.max(a.id, b.id), lo = Math.min(a.id, b.id);
  // Create it "backwards" (high -> low): it must land as low -> high.
  const e = edges.create(db, { sourceId: hi, targetId: lo, type: "friend", directed: false });
  assert.equal(e.sourceId, lo);
  assert.equal(e.targetId, hi);
  const rows = db.prepare("SELECT source_id, target_id FROM edges").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_id, lo);
});

test("creating the reverse of an existing undirected tie is rejected, not duplicated", (t) => {
  const { db } = makeDb(t);
  const a = contacts.create(db, { name: "Adhya", fields: {} });
  const b = contacts.create(db, { name: "Hema", fields: {} });
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "family", directed: false });
  assert.throws(
    () => edges.create(db, { sourceId: b.id, targetId: a.id, type: "family", directed: false }),
    /already exists/
  );
  assert.equal(db.prepare("SELECT COUNT(*) c FROM edges").get().c, 1);
});

test("a directed tie keeps its direction and both directions can coexist", (t) => {
  const { db } = makeDb(t);
  const a = contacts.create(db, { name: "A", fields: {} });
  const b = contacts.create(db, { name: "B", fields: {} });
  const e = edges.create(db, { sourceId: b.id, targetId: a.id, type: "introduced", directed: true });
  assert.equal(e.sourceId, b.id); // not reordered
  edges.create(db, { sourceId: a.id, targetId: b.id, type: "introduced", directed: true }); // reverse allowed
  assert.equal(db.prepare("SELECT COUNT(*) c FROM edges").get().c, 2);
});

test("the 0008 migration collapses a legacy reverse-duplicate to one canonical row", (t) => {
  const { db } = makeDb(t);
  const a = contacts.create(db, { name: "Adhya", fields: {} });
  const b = contacts.create(db, { name: "Hema", fields: {} });
  const lo = Math.min(a.id, b.id), hi = Math.max(a.id, b.id);
  db.exec("DELETE FROM edges");
  const ins = db.prepare("INSERT INTO edges (source_id,target_id,type,directed,metadata,created_at) VALUES (?,?,?,?,?,?)");
  // Legacy: both directions, and metadata only on the non-canonical twin.
  ins.run(lo, hi, "family", 0, null, Date.now());
  ins.run(hi, lo, "family", 0, JSON.stringify({ kin: { [a.id]: "daughter", [b.id]: "mother" } }), Date.now());
  // Also a non-canonical singleton (no twin) that should just be flipped.
  const c = contacts.create(db, { name: "C", fields: {} });
  ins.run(Math.max(a.id, c.id), Math.min(a.id, c.id), "friend", 0, null, Date.now());

  const sql = fs.readFileSync(
    path.join(__dirname, "..", "src", "main", "db", "migrations", "0008_canonicalize_undirected_edges.sql"), "utf8");
  db.exec(sql);

  const fam = db.prepare("SELECT source_id, target_id, metadata FROM edges WHERE type='family'").all();
  assert.equal(fam.length, 1, "one family row remains");
  assert.equal(fam[0].source_id, lo);
  assert.equal(fam[0].target_id, hi);
  assert.ok(fam[0].metadata && fam[0].metadata.includes("daughter"), "kin metadata preserved");

  const fr = db.prepare("SELECT source_id, target_id FROM edges WHERE type='friend'").get();
  assert.ok(fr.source_id < fr.target_id, "singleton flipped to canonical");
});
