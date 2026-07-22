// contacts.js - contact repository. Pure data layer: no Electron, no IPC.
//
// Rows are mapped to the Contact domain shape from types.d.ts (camelCase,
// parsed fields). All read paths filter deleted_at IS NULL unless the caller
// explicitly asks for the trash view. Deletes are soft; the search projection
// row is removed on delete and rebuilt on restore.

const config = require("../config");
const { AppError } = require("../ipc/errors");
const { upsertSearchRow, deleteSearchRow } = require("./search-projection");

/** @returns {import('../../shared/types').Contact} */
function rowToContact(row) {
  return {
    id: row.id,
    name: row.name,
    fields: row.fields ? JSON.parse(row.fields) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
    starred: !!row.starred,
    cadenceDays: row.cadence_days ?? null,
  };
}

const COLS = "id, name, fields, created_at, updated_at, deleted_at, starred, cadence_days";

function list(db, { includeDeleted = false } = {}) {
  const sql = includeDeleted
    ? `SELECT ${COLS} FROM contacts ORDER BY name LIMIT ?`
    : `SELECT ${COLS} FROM contacts WHERE deleted_at IS NULL ORDER BY name LIMIT ?`;
  return db.prepare(sql).all(config.limits.listMax).map(rowToContact);
}

/** Live contacts only; null when missing or soft-deleted. */
function get(db, id) {
  const row = db
    .prepare(`SELECT ${COLS} FROM contacts WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  return row ? rowToContact(row) : null;
}

function requireLive(db, id, what = "contact") {
  const row = db
    .prepare("SELECT id FROM contacts WHERE id = ? AND deleted_at IS NULL")
    .get(id);
  if (!row) throw new AppError("NOT_FOUND", `No live ${what} with id ${id}.`);
}

function create(db, { name, fields = {} }) {
  const now = Date.now();
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        "INSERT INTO contacts (name, fields, created_at, updated_at) VALUES (?, ?, ?, ?)"
      )
      .run(name, JSON.stringify(fields), now, now);
    const contact = { id: Number(info.lastInsertRowid), name, fields };
    upsertSearchRow(db, contact, "");
    return {
      ...contact,
      createdAt: now, updatedAt: now, deletedAt: null,
      starred: false, cadenceDays: null,
    };
  });
  return tx();
}

function update(db, { id, patch }) {
  const tx = db.transaction(() => {
    const existing = get(db, id);
    if (!existing) throw new AppError("NOT_FOUND", `No live contact with id ${id}.`);
    const name = patch.name !== undefined ? patch.name : existing.name;
    const fields = patch.fields !== undefined ? patch.fields : existing.fields;
    const starred = patch.starred !== undefined ? patch.starred : existing.starred;
    // cadenceDays: 0 clears the cadence (stored NULL); undefined leaves it alone.
    const cadenceDays =
      patch.cadenceDays !== undefined
        ? patch.cadenceDays === 0 ? null : patch.cadenceDays
        : existing.cadenceDays;
    const now = Date.now();
    db.prepare(
      "UPDATE contacts SET name = ?, fields = ?, starred = ?, cadence_days = ?, updated_at = ? WHERE id = ?"
    ).run(name, JSON.stringify(fields), starred ? 1 : 0, cadenceDays, now, id);
    const contact = { ...existing, name, fields, starred, cadenceDays, updatedAt: now };
    upsertSearchRow(db, contact);
    return contact;
  });
  return tx();
}

function softDelete(db, id) {
  const tx = db.transaction(() => {
    requireLive(db, id);
    const now = Date.now();
    db.prepare("UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);
    deleteSearchRow(db, id); // out of the FTS index the moment it is trashed
    return { id, deletedAt: now };
  });
  return tx();
}

function restore(db, id) {
  const tx = db.transaction(() => {
    const row = db
      .prepare(`SELECT ${COLS} FROM contacts WHERE id = ? AND deleted_at IS NOT NULL`)
      .get(id);
    if (!row) throw new AppError("NOT_FOUND", `No trashed contact with id ${id}.`);
    const now = Date.now();
    db.prepare("UPDATE contacts SET deleted_at = NULL, updated_at = ? WHERE id = ?")
      .run(now, id);
    const contact = { ...rowToContact(row), deletedAt: null, updatedAt: now };
    upsertSearchRow(db, contact);
    return contact;
  });
  return tx();
}

/**
 * Hard-delete a TRASHED contact (Trash "purge"). The only true delete in the
 * app; edges/interactions/tags/layout rows go via ON DELETE CASCADE (derived
 * data). Live contacts are refused: soft-delete first, always.
 */
function purge(db, id) {
  const tx = db.transaction(() => {
    const row = db
      .prepare("SELECT id FROM contacts WHERE id = ? AND deleted_at IS NOT NULL")
      .get(id);
    if (!row) throw new AppError("NOT_FOUND", `No trashed contact with id ${id}.`);
    deleteSearchRow(db, id); // belt and braces; softDelete already removed it
    db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
    db.prepare("DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM contact_tags)").run();
    return { id, purged: true };
  });
  return tx();
}

/** Hard-delete everything trashed longer than `days` ago. Returns the count. */
function autoPurge(db, days) {
  const cutoff = Date.now() - days * 86400000;
  const tx = db.transaction(() => {
    const ids = db
      .prepare("SELECT id FROM contacts WHERE deleted_at IS NOT NULL AND deleted_at < ?")
      .all(cutoff)
      .map((r) => r.id);
    for (const id of ids) {
      deleteSearchRow(db, id);
      db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
    }
    if (ids.length) db.prepare("DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM contact_tags)").run();
    return ids.length;
  });
  return tx();
}

module.exports = {
  list, get, create, update, softDelete, restore, purge, autoPurge,
  requireLive, rowToContact,
};
