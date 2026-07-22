// search-projection.js - the ONE place a contact becomes a contacts_search row.
//
// CRUD, restore, and import all go through here so the FTS index (mirrored from
// contacts_search by triggers, see 0001_init.sql) can never drift from the
// source of truth. Soft-deleted contacts have their row deleted outright, which
// is what keeps them out of search results.

/**
 * @param {{ id: number, name: string, fields: Record<string, string | undefined> }} contact
 * @param {string} tags space-separated tag names
 */
function projectionFromContact(contact, tags = "") {
  const f = contact.fields || {};
  return {
    id: contact.id,
    name: contact.name,
    email: f.email || "",
    phone: f.phone || "",
    company: f.company || "",
    role: f.role || "",
    tags,
    notes: f.notes || "",
  };
}

/** Space-separated tag names for a contact (empty string when untagged). */
function tagsFor(db, contactId) {
  const row = db
    .prepare(
      `SELECT group_concat(t.name, ' ') AS tags
         FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
        WHERE ct.contact_id = ?`
    )
    .get(contactId);
  return (row && row.tags) || "";
}

/**
 * Insert or update the projection row. Uses explicit UPDATE/INSERT rather than
 * INSERT OR REPLACE: REPLACE only fires delete triggers with recursive_triggers
 * on, which would silently desync the FTS mirror.
 */
function upsertSearchRow(db, contact, tags = tagsFor(db, contact.id)) {
  const p = projectionFromContact(contact, tags);
  const updated = db
    .prepare(
      `UPDATE contacts_search
          SET name=@name, email=@email, phone=@phone, company=@company,
              role=@role, tags=@tags, notes=@notes
        WHERE id=@id`
    )
    .run(p);
  if (updated.changes === 0) {
    db.prepare(
      `INSERT INTO contacts_search (id, name, email, phone, company, role, tags, notes)
       VALUES (@id, @name, @email, @phone, @company, @role, @tags, @notes)`
    ).run(p);
  }
}

function deleteSearchRow(db, contactId) {
  db.prepare("DELETE FROM contacts_search WHERE id = ?").run(contactId);
}

module.exports = { projectionFromContact, tagsFor, upsertSearchRow, deleteSearchRow };
