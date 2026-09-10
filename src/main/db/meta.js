// meta.js - app_meta key/value repository for app-level singletons that are
// not, themselves, graph data (today: the sample-data flag and the owner
// pointer). The owner ("you") is a REAL contact so it can sit in the graph and
// be connected only to the people you explicitly link (your inner circle) - see
// docs/DECISIONS.md. app_meta stores just a pointer to that contact.

const contacts = require("./contacts");

const OWNER_ID_KEY = "owner.contactId";
// Contact-field keys that make up the owner profile (name is the contact name).
const PROFILE_FIELDS = ["gender", "email", "phone", "company", "role"];

/** Raw key/value get. @returns {string | null} */
function get(db, key) {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

/** Raw key/value set (upsert). */
function set(db, key, value) {
  db.prepare(
    `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now());
}

/** The contact id of the owner ("you"), or null if not set / no longer live. */
function getOwnerContactId(db) {
  const raw = get(db, OWNER_ID_KEY);
  if (!raw) return null;
  const id = Number(raw);
  return contacts.get(db, id) ? id : null;
}

/**
 * The owner profile, projected from the owner contact. Empty object if unset.
 * @returns {import('../../shared/types').OwnerProfile}
 */
function getProfile(db) {
  const id = getOwnerContactId(db);
  if (!id) return {};
  const c = contacts.get(db, id);
  if (!c) return {};
  /** @type {import('../../shared/types').OwnerProfile} */
  const p = { contactId: id, name: c.name };
  for (const f of PROFILE_FIELDS) if (c.fields[f]) p[f] = c.fields[f];
  return p;
}

/**
 * Create or update the owner contact from a profile. Blank fields are dropped.
 * The owner contact is starred so it reads as special. A wholly empty profile is
 * a no-op. @returns {import('../../shared/types').OwnerProfile}
 */
function setProfile(db, profile) {
  // Only the keys actually SUBMITTED are touched: an omitted field is left
  // as-is, and clearing takes an explicit empty string. The old behavior
  // (delete anything absent from the payload) silently wiped stored profile
  // fields whenever a caller submitted partially - e.g. a Settings form that
  // failed to preload and then saved a single edit.
  const provided = Object.keys(profile || {}).filter((k) => typeof (profile || {})[k] === "string");
  /** @type {Record<string, string>} */
  const clean = {};
  for (const k of provided) {
    const v = String(profile[k]).trim();
    if (v) clean[k] = v;
  }
  if (!provided.length) return getProfile(db);
  const id0 = getOwnerContactId(db);
  // No owner yet: only create one when something non-blank was submitted.
  if (!id0 && !(clean.name || PROFILE_FIELDS.some((f) => clean[f]))) return getProfile(db);

  return db.transaction(() => {
    const id = getOwnerContactId(db);
    const existing = id ? contacts.get(db, id) : null;
    // Preserve any non-profile fields (e.g. notes); set/clear only submitted ones.
    const fields = { ...(existing ? existing.fields : {}) };
    for (const f of PROFILE_FIELDS) {
      if (!provided.includes(f)) continue;
      if (clean[f]) fields[f] = clean[f];
      else delete fields[f];
    }
    const name = clean.name || (existing ? existing.name : "You");
    if (existing) {
      contacts.update(db, { id, patch: { name, fields, starred: true } });
    } else {
      const c = contacts.create(db, { name, fields });
      contacts.update(db, { id: c.id, patch: { starred: true } });
      set(db, OWNER_ID_KEY, String(c.id));
    }
    return getProfile(db);
  })();
}

/**
 * Designate an EXISTING contact as the owner ("you") - used when importing or
 * restoring data where "you" is already one of the contacts. Stars them and
 * points the owner singleton at them. Throws if the id isn't a live contact.
 * @returns {import('../../shared/types').OwnerProfile}
 */
function setOwnerContact(db, id) {
  const c = contacts.get(db, id);
  if (!c) throw new Error("No such contact to set as owner.");
  return db.transaction(() => {
    set(db, OWNER_ID_KEY, String(id));
    contacts.update(db, { id, patch: { starred: true } });
    return getProfile(db);
  })();
}

module.exports = { get, set, getProfile, setProfile, setOwnerContact, getOwnerContactId, OWNER_ID_KEY };
