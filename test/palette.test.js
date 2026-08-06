// Palette presets (Settings > Appearance) must obey the same rules as the
// shipped default: cover every relationship type, keep every personal fill
// legible inside its gender ring, and clear both canvas grounds. These pin the
// floors so a future preset tweak cannot silently regress the graph.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RELATIONSHIP_TYPES, BUSINESS_TYPES } = require("../src/shared/relationships");
const { PALETTES, DEFAULT_PALETTE_ID, CUSTOM_DEFAULTS, isHexColor } = require("../src/shared/palettes");

const NIGHT = "#0a0f1c"; // graph-view night canvas
const DAY = "#eef2f8";   // graph-view day canvas

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

test("every preset is complete and well-formed", () => {
  const ids = PALETTES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "palette ids must be unique");
  assert.ok(ids.includes(DEFAULT_PALETTE_ID), "the default palette must exist");
  assert.ok(!ids.includes("custom"), "'custom' is a reserved id, resolved at runtime");
  for (const p of PALETTES) {
    assert.ok(p.label && p.blurb, `${p.id}: label and blurb are user-facing, both required`);
    assert.deepEqual(Object.keys(p.edges).sort(), [...RELATIONSHIP_TYPES].sort(),
      `${p.id}: edges must cover the shared relationship list exactly`);
    for (const [type, hex] of Object.entries(p.edges)) {
      assert.ok(isHexColor(hex), `${p.id}.${type}: ${hex} is not a #rrggbb color`);
    }
    for (const g of ["Female", "Male"]) {
      assert.ok(isHexColor(p.gender[g]), `${p.id}: ${g} ring must be a #rrggbb color`);
    }
  }
  // The custom editor's rainbow baseline obeys the same shape rules.
  assert.deepEqual(Object.keys(CUSTOM_DEFAULTS.edges).sort(), [...RELATIONSHIP_TYPES].sort(),
    "CUSTOM_DEFAULTS must cover the shared relationship list exactly");
  for (const [type, hex] of Object.entries(CUSTOM_DEFAULTS.edges)) {
    assert.ok(isHexColor(hex), `CUSTOM_DEFAULTS.${type}: ${hex} is not a #rrggbb color`);
  }
  for (const g of ["Female", "Male"]) assert.ok(isHexColor(CUSTOM_DEFAULTS.gender[g]));
});

test("no preset's personal fill fuses into its gender rings", () => {
  // Same rule as relationships.test.js: a fill fuses when it is near the ring
  // on BOTH axes (hue and lightness). Businesses carry no ring; vendor exempt.
  const fuses = (fill, ring) => hueGap(fill, ring) < 30 && contrast(fill, ring) < 2.5;
  for (const p of PALETTES) {
    if (p.curated === false) continue; // user-authored: exempt by explicit choice
    for (const [type, hex] of Object.entries(p.edges)) {
      if (BUSINESS_TYPES.has(type)) continue;
      for (const [who, ring] of Object.entries(p.gender)) {
        assert.ok(!fuses(hex, ring),
          `${p.id}: ${type} (${hex}) is ${hueGap(hex, ring).toFixed(0)}° from the ${who} ring at ${contrast(hex, ring).toFixed(1)}:1`);
      }
    }
  }
});

test("every fill clears both canvases", () => {
  // Floors, not aspirations: bright presets trade day-canvas contrast for
  // energy (documented in their blurbs), but nothing may drop below the point
  // where a disc disappears.
  for (const p of PALETTES) {
    if (p.curated === false) continue; // user-authored: exempt by explicit choice
    const [nightFloor, dayFloor] = [2.4, 1.4];
    for (const [type, hex] of Object.entries(p.edges)) {
      assert.ok(contrast(hex, NIGHT) >= nightFloor,
        `${p.id}.${type} (${hex}) is ${contrast(hex, NIGHT).toFixed(2)}:1 on the night canvas (floor ${nightFloor})`);
      assert.ok(contrast(hex, DAY) >= dayFloor,
        `${p.id}.${type} (${hex}) is ${contrast(hex, DAY).toFixed(2)}:1 on the day canvas (floor ${dayFloor})`);
    }
  }
});

test("the default preset and the colors.js literals cannot drift apart", () => {
  // colors.js keeps EDGE_COLORS/GENDER_COLORS as literals (other tests pin
  // them from source); the default preset must be the same values so the
  // shipped colors and the default list entry can never disagree.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "colors.js"), "utf8");
  const block = src.slice(src.indexOf("EDGE_COLORS = {"), src.indexOf("EDGE_DEFAULT"));
  const literals = Object.fromEntries(
    [...block.matchAll(/^\s{2}(\w+):\s*"(#[0-9a-f]{6})"/gim)].map((m) => [m[1], m[2].toLowerCase()])
  );
  const def = PALETTES.find((p) => p.id === DEFAULT_PALETTE_ID);
  assert.deepEqual(literals, def.edges, "EDGE_COLORS literals must equal the default preset");
  const genderBlock = src.slice(src.indexOf("GENDER_COLORS = {"), src.indexOf("export { PALETTES }"));
  for (const [g, hex] of Object.entries(def.gender)) {
    assert.ok(genderBlock.includes(`${g}: "${hex}"`), `GENDER_COLORS literal for ${g} must be ${hex}`);
  }
});
