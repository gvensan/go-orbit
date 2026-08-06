// relationships.js - the canonical list of relationship (edge) types.
// Shared (CJS, like field-types.js) because both sides need the same list: the
// main process validates against it, the renderer colours, filters and offers
// it. Adding a type here is the only edit needed; edges.type is free text in
// SQLite, so no migration is involved.
//
// Order is display order: the four personal ties first (closest first), then
// provenance, then the non-personal one.

/** @type {import('./types').EdgeType[]} */
const RELATIONSHIP_TYPES = ["colleague", "friend", "acquaintance", "family", "introduced", "vendor"];

/** Types that describe a business rather than a person. A contact reached only
 *  by one of these has no gender and never appears in the family tree. */
const BUSINESS_TYPES = new Set(["vendor"]);

// Kinship role term sets for family edges, chosen by the related person's
// gender. Shared (moved from renderer colors.js, which re-exports them) so the
// main process can validate kin-vs-gender consistency in health checks.
const KIN_ROLES = {
  female: ["wife", "mother", "daughter", "sister", "aunt", "niece", "grandmother", "granddaughter", "cousin", "other relative"],
  male: ["husband", "father", "son", "brother", "uncle", "nephew", "grandfather", "grandson", "cousin", "other relative"],
  other: ["spouse", "parent", "child", "sibling", "aunt/uncle", "niece/nephew", "grandparent", "grandchild", "cousin", "other relative"],
};

/** Closeness precedence, closest first. When counts of two relationship types
 *  tie (e.g. one family tie and one friend tie), the closer type wins - a
 *  daughter must never read as "friend" because of an ordering accident.
 *  Deterministic, so a contact's dominant colour never flickers. */
const CLOSENESS_ORDER = ["family", "friend", "colleague", "acquaintance", "introduced", "vendor"];

const isRelationshipType = (t) => RELATIONSHIP_TYPES.includes(t);

/** THE rule for "is this contact a business": explicitly flagged, or every tie
 *  is a business type - with the person tiebreakers (the owner is always a
 *  person; a recorded gender means person). Callers plumb their own data
 *  (graph attrs, SQL rows); the rule itself must never fork. */
const isBusinessContact = ({ flagged, isOwner, gender, hasBusinessTie, hasPersonalTie }) =>
  !!flagged || (!isOwner && !gender && !!hasBusinessTie && !hasPersonalTie);

module.exports = { RELATIONSHIP_TYPES, BUSINESS_TYPES, CLOSENESS_ORDER, KIN_ROLES, isRelationshipType, isBusinessContact };
