// colors.js - the app's only palette: edge-type hues + org/cluster colors
// (APP_SHELL_UX §1: these ARE the accents; nothing else competes).

import { RELATIONSHIP_TYPES } from "../shared/relationships.js";
import { PALETTES, DEFAULT_PALETTE_ID, CUSTOM_DEFAULTS, isHexColor } from "../shared/palettes.js";

// "Signature" - the default preset: the owner's own scheme, promoted into the
// code by request (see shared/palettes.js for the caveats it knowingly
// carries). These literals are the same values as the default entry there
// (tests pin the two together); applyPalette() retints this object in place
// at boot and on every palette switch.
export const EDGE_COLORS = {
  colleague: "#e5781f",
  friend: "#06c17c",
  acquaintance: "#e6569e",
  family: "#289de6",
  introduced: "#d4ff00",
  vendor: "#2bff00",
};
export const EDGE_DEFAULT = "#31415f";

// --- palette presets & selection ------------------------------------------
// EDGE_COLORS above and GENDER_COLORS below are LIVE objects: every consumer
// (graph, geomap, legend, cards) reads them by reference, and applyPalette()
// retints them in place. The literals above stay the default preset so the
// palette tests can pin the default from source. The choice is a per-device
// UI preference, so it lives in localStorage next to the theme, not in the DB.

/** Gender ring colors (Female/Male). Mutated in place on palette switch.
 *  Signature (the default) recolors the rings; curated presets keep the neons. */
export const GENDER_COLORS = { Female: "#f58fdf", Male: "#0055ff" };

export { PALETTES };
const PALETTE_KEY = "orbit-palette";
const CUSTOM_KEY = "orbit-palette-custom";
// Tests and workers have no localStorage; the default palette applies there.
const store = typeof localStorage === "undefined" ? null : localStorage;
const preset = (id) =>
  PALETTES.find((p) => p.id === id) ?? PALETTES.find((p) => p.id === DEFAULT_PALETTE_ID);

/** The custom editor's baseline (a true rainbow; see shared/palettes.js). */
export function customDefaults() {
  return { edges: { ...CUSTOM_DEFAULTS.edges }, gender: { ...CUSTOM_DEFAULTS.gender } };
}

/** The saved custom palette, with any missing or malformed slot falling back
 *  to the rainbow baseline so a stale or hand-edited value can never break
 *  rendering. */
export function customPalette() {
  const base = CUSTOM_DEFAULTS;
  let saved = null;
  try { saved = JSON.parse(store?.getItem(CUSTOM_KEY) || "null"); } catch { saved = null; }
  const edges = { ...base.edges };
  const gender = { ...base.gender };
  for (const type of RELATIONSHIP_TYPES) {
    const v = saved?.edges?.[type];
    if (isHexColor(v)) edges[type] = v.toLowerCase();
  }
  for (const g of ["Female", "Male"]) {
    const v = saved?.gender?.[g];
    if (isHexColor(v)) gender[g] = v.toLowerCase();
  }
  return { edges, gender };
}

// --- named user palettes ---------------------------------------------------
// Snapshots of the custom editor saved under a user-chosen name; they join the
// preset list and can be applied like any preset. Stored beside the other
// palette prefs; malformed slots heal to the rainbow baseline, like custom.
const USER_KEY = "orbit-palette-user";
const USER_MAX = 20;

/** @returns {{ id: string, label: string, edges: Record<string,string>, gender: Record<string,string> }[]} */
export function userPalettes() {
  let raw = null;
  try { raw = JSON.parse(store?.getItem(USER_KEY) || "null"); } catch { raw = null; }
  if (!Array.isArray(raw)) return [];
  const base = CUSTOM_DEFAULTS; // named palettes are custom snapshots: heal to the same baseline
  const out = [];
  for (const p of raw) {
    if (!p || typeof p.id !== "string" || typeof p.label !== "string" || !p.label.trim()) continue;
    const edges = { ...base.edges };
    const gender = { ...base.gender };
    for (const t of RELATIONSHIP_TYPES) if (isHexColor(p.edges?.[t])) edges[t] = p.edges[t].toLowerCase();
    for (const g of ["Female", "Male"]) if (isHexColor(p.gender?.[g])) gender[g] = p.gender[g].toLowerCase();
    out.push({ id: p.id, label: p.label, edges, gender });
  }
  return out;
}

/** Save colors as a named palette. Returns the new entry, or null on a blank
 *  name. Ids are slugged from the name and kept unique against every source. */
export function saveUserPalette(label, colors) {
  const name = String(label ?? "").trim().slice(0, 40);
  if (!name) return null;
  const list = userPalettes();
  const base = `user-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}` || "user-palette";
  let id = base;
  let n = 2;
  while (id === "custom" || PALETTES.some((p) => p.id === id) || list.some((p) => p.id === id)) id = `${base}-${n++}`;
  const entry = { id, label: name, edges: { ...colors.edges }, gender: { ...colors.gender } };
  const next = [...list, entry].slice(-USER_MAX);
  try { store?.setItem(USER_KEY, JSON.stringify(next)); } catch { /* quota: the save just won't persist */ }
  return entry;
}

/** Rename a saved palette. The id stays stable, so the active-palette pointer
 *  and anything else referencing it are unaffected. Null on blank/unknown. */
export function renameUserPalette(id, label) {
  const name = String(label ?? "").trim().slice(0, 40);
  if (!name) return null;
  const list = userPalettes();
  const entry = list.find((p) => p.id === id);
  if (!entry) return null;
  entry.label = name;
  try { store?.setItem(USER_KEY, JSON.stringify(list)); } catch { /* quota */ }
  return entry;
}

/** Remove a named palette; if it was active, the default takes over. */
export function deleteUserPalette(id) {
  const next = userPalettes().filter((p) => p.id !== id);
  try { store?.setItem(USER_KEY, JSON.stringify(next)); } catch { /* see above */ }
  if (store?.getItem(PALETTE_KEY) === id) applyPalette(DEFAULT_PALETTE_ID);
}

/** Resolved colors for any palette id (presets, "custom", or a named user
 *  palette), without applying. */
export function paletteColors(id) {
  if (id === "custom") return customPalette();
  const u = userPalettes().find((p) => p.id === id);
  if (u) return { edges: { ...u.edges }, gender: { ...u.gender } };
  const p = preset(id);
  return { edges: { ...p.edges }, gender: { ...p.gender } };
}

/** The persisted palette choice; anything unknown resolves to the default. */
export function activePaletteId() {
  const id = store?.getItem(PALETTE_KEY);
  if (id === "custom" || PALETTES.some((p) => p.id === id) || userPalettes().some((p) => p.id === id)) return id;
  return DEFAULT_PALETTE_ID;
}

/** Switch palettes: retint the live color objects and persist the choice.
 *  Callers repaint (legend + canvas) themselves; nothing here touches the DOM. */
export function applyPalette(id) {
  const next = paletteColors(id);
  Object.assign(EDGE_COLORS, next.edges);
  Object.assign(GENDER_COLORS, next.gender);
  try { store?.setItem(PALETTE_KEY, id); } catch { /* private-mode quota: choice just won't persist */ }
  return next;
}

/** Persist the custom palette; re-applies immediately if custom is active. */
export function saveCustomPalette({ edges = {}, gender = {} }) {
  const clean = { edges: {}, gender: {} };
  for (const type of RELATIONSHIP_TYPES) {
    if (isHexColor(edges[type])) clean.edges[type] = edges[type].toLowerCase();
  }
  for (const g of ["Female", "Male"]) {
    if (isHexColor(gender[g])) clean.gender[g] = gender[g].toLowerCase();
  }
  try { store?.setItem(CUSTOM_KEY, JSON.stringify(clean)); } catch { /* see above */ }
  if (activePaletteId() === "custom") applyPalette("custom");
}

// Boot: retint to the saved choice before anything renders (this module is
// imported ahead of every view, so first paint is already in the right palette).
applyPalette(activePaletteId());

/** The relationship types offered in pickers (order = display order). Comes from
 *  the shared list so the main process and the renderer can never disagree about
 *  what a valid type is; test/relationships.test.js asserts a colour exists for
 *  every one of them. */
export const EDGE_TYPES = RELATIONSHIP_TYPES;

// --- kinship roles for family edges --------------------------------------
// When an edge is `family`, we optionally capture the specific relation. The
// term set is chosen by the related person's gender; the picked role always
// describes THAT person relative to the other endpoint ("‹them› is your …").
// The lists live in shared/relationships.js so the main process (health
// checks) uses the same terms; re-exported here for the card and wizard.
import { KIN_ROLES } from "../shared/relationships.js";
export { KIN_ROLES };

/** Kinship options to offer, based on the related person's gender. */
export function kinRolesFor(gender) {
  const g = String(gender || "").trim().toLowerCase();
  if (g === "female" || g === "f" || g === "woman") return KIN_ROLES.female;
  if (g === "male" || g === "m" || g === "man") return KIN_ROLES.male;
  return KIN_ROLES.other;
}

/**
 * Given a role that A plays toward B, return B's role toward A, resolved by B's
 * gender. E.g. reciprocalRole("daughter", "Male") -> "father" (A is B's
 * daughter, so B is A's father). Returns null for roles with no known inverse.
 */
export function reciprocalRole(role, otherGender) {
  const g = String(otherGender || "").trim().toLowerCase();
  const female = g === "female" || g === "f" || g === "woman";
  const male = g === "male" || g === "m" || g === "man";
  const pick = (f, m, n) => (female ? f : male ? m : n); // by the OTHER's gender
  switch (role) {
    case "wife": case "husband": return pick("wife", "husband", "spouse");
    case "mother": case "father": return pick("daughter", "son", "child");
    case "daughter": case "son": return pick("mother", "father", "parent");
    case "sister": case "brother": return pick("sister", "brother", "sibling");
    case "aunt": case "uncle": return pick("niece", "nephew", "niece/nephew");
    case "niece": case "nephew": return pick("aunt", "uncle", "aunt/uncle");
    case "grandmother": case "grandfather": return pick("granddaughter", "grandson", "grandchild");
    case "granddaughter": case "grandson": return pick("grandmother", "grandfather", "grandparent");
    case "cousin": return "cousin";
    default: return null;
  }
}

/** Both-direction summary of a kinship role, for entry previews. `role` is
 *  `selfName`'s role toward `otherName`; `otherGender` phrases the reciprocal.
 *  Uses the SAME reciprocalRole() that gets stored, so it can never disagree with
 *  the saved data. e.g. "Uma is Leelavathy's daughter · Leelavathy is Uma's mother".
 *  Returns "" when no role is picked. */
export function kinPreview({ selfName, otherName, role, otherGender }) {
  if (!role) return "";
  const a = String(selfName || "they").trim().split(/\s+/)[0] || "they";
  const b = String(otherName || "them").trim().split(/\s+/)[0] || "them";
  const forward = `${a} is ${b}'s ${role}`;
  const recip = reciprocalRole(role, otherGender);
  return recip ? `${forward}  ·  ${b} is ${a}'s ${recip}` : forward;
}

const ORG_COLORS = [
  "#7aa2f7", "#e0af68", "#9ece6a", "#f7768e",
  "#bb9af7", "#2ac3de", "#ff9e64", "#73daca",
];

/** Stable org -> hue mapping. */
export function orgColor(org) {
  if (!org) return "#8b9bb4";
  let h = 0;
  for (let i = 0; i < org.length; i++) h = (h * 31 + org.charCodeAt(i)) | 0;
  return ORG_COLORS[Math.abs(h) % ORG_COLORS.length];
}

export function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}
