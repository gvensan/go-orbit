// interactions.js - per-contact timeline repository. Feeds search recency ranking.

const { requireLive } = require("./contacts");

/** @returns {import('../../shared/types').Interaction} */
function rowToInteraction(row) {
  return {
    id: row.id,
    contactId: row.contact_id,
    occurredAt: row.occurred_at,
    kind: row.kind ?? undefined,
    note: row.note ?? undefined,
  };
}

function list(db, { contactId }) {
  requireLive(db, contactId);
  return db
    .prepare(
      `SELECT id, contact_id, occurred_at, kind, note
         FROM interactions WHERE contact_id = ?
        ORDER BY occurred_at DESC`
    )
    .all(contactId)
    .map(rowToInteraction);
}

function add(db, { contactId, occurredAt, kind, note }) {
  const tx = db.transaction(() => {
    requireLive(db, contactId);
    const info = db
      .prepare(
        "INSERT INTO interactions (contact_id, occurred_at, kind, note) VALUES (?, ?, ?, ?)"
      )
      .run(contactId, occurredAt, kind ?? null, note ?? null);
    return { id: Number(info.lastInsertRowid), contactId, occurredAt, kind, note };
  });
  return tx();
}

module.exports = { list, add };
