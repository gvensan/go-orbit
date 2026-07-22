// tags.js - normalized tags. Setting a contact's tags upserts tag rows,
// replaces the join rows, and re-projects the search row so tag search stays
// live. Unused tags are garbage-collected so tags:list stays meaningful.

const { AppError } = require("../ipc/errors");
const contacts = require("./contacts");
const { upsertSearchRow } = require("./search-projection");

/** @returns {import('../../shared/types').Tag[]} */
function list(db) {
  return db.prepare("SELECT id, name FROM tags ORDER BY name").all();
}

/** Tags currently on a contact, alphabetical. */
function forContact(db, contactId) {
  return db
    .prepare(
      `SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
        WHERE ct.contact_id = ? ORDER BY t.name`
    )
    .all(contactId)
    .map((r) => r.name);
}

/**
 * Replace a contact's tag set. Names are trimmed, lowercased, deduped.
 * @returns {{ contact: any, tags: string[] }}
 */
function setForContact(db, { id, tags }) {
  const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const tx = db.transaction(() => {
    const contact = contacts.get(db, id);
    if (!contact) throw new AppError("NOT_FOUND", `No live contact with id ${id}.`);

    db.prepare("DELETE FROM contact_tags WHERE contact_id = ?").run(id);
    const upsert = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
    const idOf = db.prepare("SELECT id FROM tags WHERE name = ?");
    const link = db.prepare("INSERT INTO contact_tags (contact_id, tag_id) VALUES (?, ?)");
    for (const name of clean) {
      upsert.run(name);
      link.run(id, idOf.get(name).id);
    }
    // GC tags no contact uses anymore.
    db.prepare("DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM contact_tags)").run();

    upsertSearchRow(db, contact, clean.join(" "));
    return { contact, tags: clean };
  });
  return tx();
}

module.exports = { list, forContact, setForContact };
