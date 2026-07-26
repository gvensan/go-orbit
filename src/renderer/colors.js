// colors.js - the app's only palette: edge-type hues + org/cluster colors
// (APP_SHELL_UX §1: these ARE the accents; nothing else competes).

export const EDGE_COLORS = {
  colleague: "#3b6ea5",
  friend: "#3f9d76",
  acquaintance: "#9d7cd8",
  family: "#b0567f",
  introduced: "#b08a3e",
};
export const EDGE_DEFAULT = "#31415f";

/** The relationship types offered in pickers (order = display order). */
export const EDGE_TYPES = Object.keys(EDGE_COLORS);

// --- kinship roles for family edges --------------------------------------
// When an edge is `family`, we optionally capture the specific relation. The
// term set is chosen by the related person's gender; the picked role always
// describes THAT person relative to the other endpoint ("‹them› is your …").
export const KIN_ROLES = {
  female: ["wife", "mother", "daughter", "sister", "aunt", "niece", "grandmother", "granddaughter", "cousin", "other relative"],
  male: ["husband", "father", "son", "brother", "uncle", "nephew", "grandfather", "grandson", "cousin", "other relative"],
  other: ["spouse", "parent", "child", "sibling", "aunt/uncle", "niece/nephew", "grandparent", "grandchild", "cousin", "other relative"],
};

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
