// palettes.js - the built-in color palette presets (relationship fills + gender
// rings). Shared (CJS, like relationships.js) so the renderer applies them and
// tests can require() them without an ESM loader. The renderer's colors.js owns
// which palette is ACTIVE; this file only says what the presets ARE.
//
// Every preset was picked in the August 2026 palette review (Piktochart's
// black-red and dark lists, Digital Synopsis, and a Vecteezy sheet - 89
// palettes ranked; see the "Orbit palettes, round two" artifact). Source hexes
// were pixel-sampled, then minimally adapted so each slot:
//   - clears the night (#0a0f1c) and day (#eef2f8) canvases, and
//   - never fuses with the gender rings drawn around personal fills
//     (test/palette.test.js and test/relationships.test.js enforce both).
// Adapted values note the source color they were derived from.

/** @typedef {{ id: string, label: string, blurb: string,
 *              edges: Record<string, string>,
 *              gender: { Female: string, Male: string },
 *              curated?: boolean }} PaletteDef
 *  `curated: false` marks a user-authored preset: baked in by explicit
 *  request, exempt from the curated ring-fuse and canvas-floor test gates. */

// The rings are settled and identical across presets; only a custom palette
// may move them. Neon on purpose: they must read over any fill.
const GENDER_DEFAULTS = Object.freeze({ Female: "#ff2d95", Male: "#00c2ff" });

/** @type {PaletteDef[]} */
const PALETTES = [
  {
    // User-authored (Giri's scheme), promoted to the built-in default by
    // request. NOT curated: it knowingly bends the ring-fuse rule
    // (acquaintance vs its Female ring, family vs its Male ring) and the
    // day-canvas floor (the two neons) - the owner prefers the look. It also
    // recolors the gender rings, which curated presets never do.
    id: "signature",
    label: "Signature",
    blurb: "Bright and personal - the house scheme. Rings included.",
    curated: false,
    edges: {
      colleague: "#e5781f",
      friend: "#06c17c",
      acquaintance: "#e6569e",
      family: "#289de6",
      introduced: "#d4ff00",
      vendor: "#2bff00",
    },
    gender: { Female: "#f58fdf", Male: "#0055ff" },
  },
  {
    id: "ember-coast",
    label: "Ember Coast",
    blurb: "Warm and earthy: terracotta, sand, gold over sea green and slate.",
    edges: {
      colleague: "#33586b",   // slate, lifted from #264653 for the night canvas
      friend: "#29a175",      // sea green, from #299e8e, nudged off the male ring's hue
      acquaintance: "#f4a361",
      family: "#e66f51",
      introduced: "#e8c36a",
      vendor: "#2f7f8f",      // not in the source; the retired Dusk preset's vendor teal, kept
    },
    gender: GENDER_DEFAULTS,
  },
  {
    id: "crayon-box",
    label: "Crayon Box",
    blurb: "Bright and playful; the most energetic set. Shines in dark theme.",
    edges: {
      colleague: "#4a5fe0",   // indigo, added; deep enough not to fuse with the male ring
      friend: "#8cd77a",
      acquaintance: "#a55fd6", // violet, added
      family: "#f3533b",
      introduced: "#fa9f42",
      vendor: "#5bcec9",
    },
    gender: GENDER_DEFAULTS,
  },
];

// The CUSTOM editor's baseline: a true rainbow, spectrum order across the
// relationship slots (red, orange, yellow, green, blue, violet) with the
// classic neon rings. Unset custom slots and "Reset custom to defaults"
// resolve here, NOT to the default preset - Custom starts as its own thing.
const CUSTOM_DEFAULTS = Object.freeze({
  edges: Object.freeze({
    colleague: "#e53935",     // red
    friend: "#f57c00",        // orange
    acquaintance: "#fdd835",  // yellow
    family: "#43a047",        // green
    introduced: "#1e88e5",    // blue
    vendor: "#8e24aa",        // violet
  }),
  gender: GENDER_DEFAULTS,
});

const DEFAULT_PALETTE_ID = "signature";

const HEX_RE = /^#[0-9a-f]{6}$/i;
/** @param {unknown} v */
const isHexColor = (v) => typeof v === "string" && HEX_RE.test(v);

module.exports = { PALETTES, DEFAULT_PALETTE_ID, GENDER_DEFAULTS, CUSTOM_DEFAULTS, isHexColor };
