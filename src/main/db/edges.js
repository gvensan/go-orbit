// edges.js - edge repository. Validates both endpoints are live before writing.

const { AppError } = require("../ipc/errors");
const { requireLive } = require("./contacts");

/** Canonical endpoint order for an edge. An UNDIRECTED tie is symmetric, so it is
 *  stored with source_id <= target_id: this makes A-B and B-A the same primary
 *  key, so the reverse of an existing undirected edge can never land as a second
 *  row. Directed ties (e.g. "introduced") keep their direction. Kin metadata is
 *  keyed by contact id, so reordering the endpoints never affects it.
 *  @returns {[number, number]} */
function canonicalEndpoints(sourceId, targetId, directed) {
  if (!directed && sourceId > targetId) return [targetId, sourceId];
  return [sourceId, targetId];
}

/** @returns {import('../../shared/types').Edge} */
function rowToEdge(row) {
  return {
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type,
    directed: !!row.directed,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
  };
}

function create(db, { sourceId, targetId, type, directed, metadata }) {
  const tx = db.transaction(() => {
    requireLive(db, sourceId, "source contact");
    requireLive(db, targetId, "target contact");
    if (sourceId === targetId) {
      throw new AppError("VALIDATION", "An edge cannot connect a contact to itself.");
    }
    // Store undirected ties canonically so the reverse (target->source) collides
    // with the primary key instead of being written as a duplicate row.
    const [src, tgt] = canonicalEndpoints(sourceId, targetId, directed);
    const now = Date.now();
    try {
      db.prepare(
        `INSERT INTO edges (source_id, target_id, type, directed, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(src, tgt, type, directed ? 1 : 0, metadata ? JSON.stringify(metadata) : null, now);
    } catch (err) {
      if (String(err.code || "").startsWith("SQLITE_CONSTRAINT")) {
        throw new AppError("CONFLICT", `A ${type} connection between these contacts already exists.`);
      }
      throw err;
    }
    return { sourceId: src, targetId: tgt, type, directed: !!directed, metadata, createdAt: now };
  });
  return tx();
}

function remove(db, { sourceId, targetId, type }) {
  const info = db
    .prepare("DELETE FROM edges WHERE source_id = ? AND target_id = ? AND type = ?")
    .run(sourceId, targetId, type);
  return { ok: info.changes > 0 };
}

/**
 * Change an edge's relationship type and/or its metadata. Since type is part of
 * the primary key, a type change is a delete + re-insert (preserving direction /
 * created_at) in one transaction; a metadata-only change is an in-place UPDATE.
 * When `metadata` is provided it replaces the stored metadata; when omitted the
 * existing metadata is carried over.
 */
function changeType(db, { sourceId, targetId, type, newType, metadata }) {
  const tx = db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = ?")
      .get(sourceId, targetId, type);
    if (!row) throw new AppError("NOT_FOUND", `No ${type} edge ${sourceId}->${targetId}.`);
    const metaJson =
      metadata !== undefined
        ? (metadata && Object.keys(metadata).length ? JSON.stringify(metadata) : null)
        : row.metadata;

    if (newType === type || newType === undefined) {
      if (metadata !== undefined && metaJson !== row.metadata) {
        db.prepare("UPDATE edges SET metadata = ? WHERE source_id = ? AND target_id = ? AND type = ?")
          .run(metaJson, sourceId, targetId, type);
      }
      return rowToEdge({ ...row, metadata: metaJson });
    }

    const clash = db
      .prepare("SELECT 1 FROM edges WHERE source_id = ? AND target_id = ? AND type = ?")
      .get(sourceId, targetId, newType);
    if (clash) throw new AppError("CONFLICT", `A ${newType} edge already exists.`);
    db.prepare("DELETE FROM edges WHERE source_id = ? AND target_id = ? AND type = ?")
      .run(sourceId, targetId, type);
    db.prepare(
      `INSERT INTO edges (source_id, target_id, type, directed, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sourceId, targetId, newType, row.directed, metaJson, row.created_at);
    return rowToEdge({ ...row, type: newType, metadata: metaJson });
  });
  return tx();
}

/** Edges incident to a contact whose other endpoint is live. */
function listFor(db, contactId) {
  return db
    .prepare(
      `SELECT e.source_id, e.target_id, e.type, e.directed, e.metadata, e.created_at
         FROM edges e
         JOIN contacts s ON s.id = e.source_id AND s.deleted_at IS NULL
         JOIN contacts t ON t.id = e.target_id AND t.deleted_at IS NULL
        WHERE e.source_id = ? OR e.target_id = ?`
    )
    .all(contactId, contactId)
    .map(rowToEdge);
}

module.exports = { create, remove, changeType, listFor, rowToEdge, canonicalEndpoints };
