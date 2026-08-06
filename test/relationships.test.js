// The relationship-type list is shared by the main process and the renderer;
// these guard the places that would silently drift apart.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RELATIONSHIP_TYPES, BUSINESS_TYPES, isRelationshipType } = require("../src/shared/relationships");
const { fieldType } = require("../src/shared/field-types");
const { GraphStore } = require("../src/main/graph/store");
const { makeDb } = require("./helpers");

const src = (rel) => fs.readFileSync(path.join(__dirname, "..", "src", rel), "utf8");

const RINGS = { female: "#ff2d95", male: "#00c2ff" };
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const hue = (hex) => {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const hueGap = (a, b) => {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return d > 180 ? 360 - d : d;
};
const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lum = (hex) => {
  const [r, g, b] = rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

test("every relationship type has a colour, and no colour is orphaned", () => {
  const colors = src("renderer/colors.js");
  const block = colors.slice(colors.indexOf("EDGE_COLORS = {"), colors.indexOf("EDGE_DEFAULT"));
  const keyed = [...block.matchAll(/^\s{2}(\w+):\s*"(#[0-9a-f]{6})"/gim)].map((m) => m[1]);
  assert.deepEqual([...keyed].sort(), [...RELATIONSHIP_TYPES].sort(),
    "EDGE_COLORS keys must match the shared relationship list exactly");
});

test("no relationship fill fuses into the gender ring drawn around it", () => {
  // Node fills sit inside a #ff2d95 or #00c2ff ring. A fill "fuses" when it is
  // close to the ring on BOTH axes - similar hue and similar lightness - which
  // is what a rose family colour did to the female ring. Either axis apart is
  // enough to keep the ring readable (indigo is near cyan in hue but far darker).
  // Businesses carry no ring, so vendor is exempt and may use the cyan slot.
  const colors = src("renderer/colors.js");
  const block = colors.slice(colors.indexOf("EDGE_COLORS = {"), colors.indexOf("EDGE_DEFAULT"));
  const entries = [...block.matchAll(/^\s{2}(\w+):\s*"(#[0-9a-f]{6})"/gim)].map((m) => [m[1], m[2]]);
  assert.ok(entries.length >= RELATIONSHIP_TYPES.length, "parsed the palette");
  const fuses = (fill, ring) => hueGap(fill, ring) < 30 && contrast(fill, ring) < 2.5;

  // The shipped literals mirror the DEFAULT preset. A curated default must
  // pass; a user-authored one (curated: false) is exempt by explicit choice -
  // the curated presets are still held to the rule in test/palette.test.js.
  const { PALETTES, DEFAULT_PALETTE_ID } = require("../src/shared/palettes");
  const def = PALETTES.find((p) => p.id === DEFAULT_PALETTE_ID);
  if (def.curated !== false) {
    for (const [type, hex] of entries) {
      if (BUSINESS_TYPES.has(type)) continue;
      for (const [who, ring] of Object.entries(RINGS)) {
        assert.ok(!fuses(hex, ring),
          `${type} (${hex}) is ${hueGap(hex, ring).toFixed(0)}° from the ${who} ring at ${contrast(hex, ring).toFixed(1)}:1 - the ring will disappear into the fill`);
      }
    }
  }
  // Anchor: the rose family colour this rule was written for must still fail it.
  assert.ok(fuses("#e11d63", RINGS.female), "the rule must catch the colour that caused the problem");
});

test("the import-review validator accepts every shared type", () => {
  const registry = src("main/ipc/registry.js");
  assert.match(registry, /const T = RELATIONSHIP_TYPES;/,
    "registry must validate against the shared list, not a private copy");
  assert.ok(isRelationshipType("vendor"));
  assert.ok(!isRelationshipType("nemesis"));
});

test("business is a boolean contact field and rides into the graph snapshot", (t) => {
  assert.equal(fieldType("business"), "bool");
  const { db } = makeDb(t);
  const now = Date.now();
  db.prepare("INSERT INTO contacts (id, name, fields, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(1, "You", JSON.stringify({ gender: "Male" }), now, now);
  db.prepare("INSERT INTO contacts (id, name, fields, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(2, "Airtel Support", JSON.stringify({ business: "yes", phone: "121" }), now, now);
  db.prepare("INSERT INTO edges (source_id, target_id, type, directed, created_at) VALUES (?, ?, ?, 0, ?)")
    .run(1, 2, "vendor", now);
  const snap = new GraphStore().hydrate(db).snapshot();
  const vendor = snap.nodes.find((n) => n.name === "Airtel Support");
  const person = snap.nodes.find((n) => n.name === "You");
  assert.equal(vendor.business, true, "a business contact is flagged for the renderer");
  assert.equal(person.business, false);
  assert.equal(vendor.gender, undefined, "a business has no gender");
  assert.equal(snap.links[0].type, "vendor");
});

test("a contact whose only ties are vendor is a business, even unflagged", (t) => {
  const { db } = makeDb(t);
  const now = Date.now();
  const ins = db.prepare("INSERT INTO contacts (id, name, fields, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  ins.run(1, "You", JSON.stringify({ gender: "Male" }), now, now);
  ins.run(2, "ACT Support", JSON.stringify({ phone: "1800" }), now, now); // no business flag (pre-flag data)
  ins.run(3, "Ravi", JSON.stringify({ gender: "Male" }), now, now);
  const edge = db.prepare("INSERT INTO edges (source_id, target_id, type, directed, created_at) VALUES (?, ?, ?, 0, ?)");
  edge.run(1, 2, "vendor", now);
  edge.run(1, 3, "vendor", now);   // Ravi has a vendor tie...
  edge.run(1, 3, "friend", now);   // ...but also a personal one: still a person
  const snap = new GraphStore().hydrate(db).snapshot();
  const act = snap.nodes.find((n) => n.name === "ACT Support");
  const ravi = snap.nodes.find((n) => n.name === "Ravi");
  assert.equal(act.business, true, "vendor-only contact must derive business");
  assert.equal(ravi.business, false, "a personal tie keeps a contact a person");
});

test("closeness order covers every type, closest first", () => {
  const { CLOSENESS_ORDER } = require("../src/shared/relationships");
  assert.deepEqual([...CLOSENESS_ORDER].sort(), [...RELATIONSHIP_TYPES].sort(),
    "closeness order must cover the shared relationship list exactly");
  assert.equal(CLOSENESS_ORDER[0], "family", "family outranks everything on a tie");
  assert.ok(CLOSENESS_ORDER.indexOf("friend") < CLOSENESS_ORDER.indexOf("acquaintance"));
  // The tiebreak this exists for: dominantRelColor iterates this order, so one
  // family tie + one friend tie must resolve to family.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "graph-view.js"), "utf8");
  assert.match(src, /for \(const type of CLOSENESS_ORDER\)/,
    "dominantRelColor must break ties by closeness, not legend order");
});
