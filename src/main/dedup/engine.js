// dedup/engine.js - identity resolution and safe merge (DEDUP_MERGE spec,
// slice): candidate pairs by email / phone / fuzzy-name+org, merge with field
// union + edge re-pointing + timeline/tags move, every merge journaled in
// merge_log and undoable.

const config = require("../config");
const contactsRepo = require("../db/contacts");
const { AppError } = require("../ipc/errors");
const { upsertSearchRow, deleteSearchRow } = require("../db/search-projection");
const { jaroWinkler } = require("../search/engine");

const normEmail = (e) => (e || "").trim().toLowerCase();
const normPhone = (p) => (p || "").replace(/[^\d+]/g, "");
const normName = (n) => (n || "").trim().toLowerCase().replace(/\s+/g, " ");
const OWNER_ID_KEY = "owner.contactId";

/** Rewrite contact-id keyed kin metadata when an edge endpoint is re-pointed. */
function remapEdgeMetadata(raw, fromId, toId) {
  if (!raw) return null;
  let metadata;
  try { metadata = JSON.parse(raw); } catch { return raw; }
  if (!metadata?.kin || typeof metadata.kin !== "object") return raw;
  const kin = { ...metadata.kin };
  const role = kin[fromId];
  if (role !== undefined && kin[toId] === undefined) kin[toId] = role;
  delete kin[fromId];
  return JSON.stringify({ ...metadata, kin });
}

/** Merge metadata into an already-existing primary edge; primary values win. */
function mergeEdgeMetadata(existingRaw, incomingRaw) {
  if (!incomingRaw) return existingRaw;
  let existing = /** @type {any} */ ({}), incoming = /** @type {any} */ ({});
  try { existing = existingRaw ? JSON.parse(existingRaw) : {}; } catch { return existingRaw; }
  try { incoming = JSON.parse(incomingRaw); } catch { return existingRaw; }
  const merged = { ...incoming, ...existing };
  if (incoming.kin || existing.kin) merged.kin = { ...(incoming.kin || {}), ...(existing.kin || {}) };
  return Object.keys(merged).length ? JSON.stringify(merged) : null;
}

/**
 * Candidate duplicate pairs, strongest signal first.
 * @returns {{ aId: number, bId: number, a: any, b: any, score: number, reason: string }[]}
 */
function candidates(db) {
  const rows = db
    .prepare("SELECT id, name, fields FROM contacts WHERE deleted_at IS NULL")
    .all()
    .map((r) => {
      const f = r.fields ? JSON.parse(r.fields) : {};
      return { id: r.id, name: r.name, fields: f };
    });

  const pairs = new Map(); // "a|b" -> pair (a < b)
  const add = (x, y, score, reason) => {
    const [a, b] = x.id < y.id ? [x, y] : [y, x];
    const key = `${a.id}|${b.id}`;
    const existing = pairs.get(key);
    if (!existing || existing.score < score) {
      pairs.set(key, {
        aId: a.id, bId: b.id,
        a: { id: a.id, name: a.name, email: a.fields.email, phone: a.fields.phone, company: a.fields.company },
        b: { id: b.id, name: b.name, email: b.fields.email, phone: b.fields.phone, company: b.fields.company },
        score, reason,
      });
    }
  };

  const byEmail = new Map();
  const byPhone = new Map();
  for (const r of rows) {
    const e = normEmail(r.fields.email);
    if (e) {
      if (byEmail.has(e)) add(byEmail.get(e), r, 1.0, "same email");
      else byEmail.set(e, r);
    }
    const p = normPhone(r.fields.phone);
    if (p) {
      if (byPhone.has(p)) add(byPhone.get(p), r, 0.9, "same phone");
      else byPhone.set(p, r);
    }
  }

  // Fuzzy name within the same org (blocking keeps this O(sum of org sizes²)).
  const byOrg = new Map();
  for (const r of rows) {
    const org = normName(r.fields.company);
    if (!org) continue;
    if (!byOrg.has(org)) byOrg.set(org, []);
    byOrg.get(org).push(r);
  }
  for (const group of byOrg.values()) {
    if (group.length < 2 || group.length > 500) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const sim = jaroWinkler(normName(group[i].name), normName(group[j].name));
        if (sim >= config.dedup.nameSimMin && group[i].name !== "" ) {
          add(group[i], group[j], 0.8 * sim, "similar name, same org");
        }
      }
    }
  }

  return [...pairs.values()]
    .sort((x, y) => y.score - x.score)
    .slice(0, config.dedup.maxCandidates);
}

/**
 * Merge secondary into primary. Journaled; returns the merged contact + log id.
 * Pure data-layer: the caller refreshes the in-memory graph.
 */
function merge(db, { primaryId, secondaryId }) {
  if (primaryId === secondaryId) {
    throw new AppError("VALIDATION", "Cannot merge a contact with itself.");
  }
  const tx = db.transaction(() => {
    const primary = contactsRepo.get(db, primaryId);
    const secondary = contactsRepo.get(db, secondaryId);
    if (!primary || !secondary) throw new AppError("NOT_FOUND", "Both contacts must be live to merge.");

    const snapshot = {
      primaryFieldsBefore: primary.fields,
      primaryStarredBefore: primary.starred,
      secondaryRow: db.prepare("SELECT * FROM contacts WHERE id = ?").get(secondaryId),
      secondaryEdges: db
        .prepare("SELECT * FROM edges WHERE source_id = ? OR target_id = ?")
        .all(secondaryId, secondaryId),
      secondaryTagIds: db
        .prepare("SELECT tag_id FROM contact_tags WHERE contact_id = ?")
        .all(secondaryId)
        .map((r) => r.tag_id),
      movedInteractionIds: db
        .prepare("SELECT id FROM interactions WHERE contact_id = ?")
        .all(secondaryId)
        .map((r) => r.id),
      createdPrimaryEdges: [],
      updatedPrimaryEdges: [],
      ownerContactIdBefore: Number(db.prepare("SELECT value FROM app_meta WHERE key = ?").get(OWNER_ID_KEY)?.value) || null,
      ownerRepointed: false,
    };

    // Fields: union, primary wins conflicts.
    const fields = { ...secondary.fields, ...primary.fields };
    const now = Date.now();
    db.prepare("UPDATE contacts SET fields = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(fields), now, primaryId);

    // Edges: re-point, skipping self-edges and duplicates.
    const insE = db.prepare(
      `INSERT OR IGNORE INTO edges (source_id, target_id, type, directed, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const e of snapshot.secondaryEdges) {
      const s = e.source_id === secondaryId ? primaryId : e.source_id;
      const t = e.target_id === secondaryId ? primaryId : e.target_id;
      if (s === t) continue;
      const metadata = remapEdgeMetadata(e.metadata, secondaryId, primaryId);
      const info = insE.run(s, t, e.type, e.directed, metadata, e.created_at);
      if (info.changes > 0) {
        snapshot.createdPrimaryEdges.push({ source_id: s, target_id: t, type: e.type });
      } else if (metadata) {
        const existing = db.prepare(
          "SELECT metadata FROM edges WHERE source_id = ? AND target_id = ? AND type = ?"
        ).get(s, t, e.type);
        if (existing) {
          const mergedMetadata = mergeEdgeMetadata(existing.metadata, metadata);
          if (mergedMetadata !== existing.metadata) {
            snapshot.updatedPrimaryEdges.push({ source_id: s, target_id: t, type: e.type, metadata: existing.metadata });
            db.prepare("UPDATE edges SET metadata = ? WHERE source_id = ? AND target_id = ? AND type = ?")
              .run(mergedMetadata, s, t, e.type);
          }
        }
      }
    }
    db.prepare("DELETE FROM edges WHERE source_id = ? OR target_id = ?").run(secondaryId, secondaryId);

    // Timeline + tags move to the primary.
    db.prepare("UPDATE interactions SET contact_id = ? WHERE contact_id = ?").run(primaryId, secondaryId);
    db.prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) SELECT ?, tag_id FROM contact_tags WHERE contact_id = ?")
      .run(primaryId, secondaryId);
    db.prepare("DELETE FROM contact_tags WHERE contact_id = ?").run(secondaryId);

    // Secondary: soft-delete + drop from search.
    db.prepare("UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, secondaryId);
    deleteSearchRow(db, secondaryId);
    if (snapshot.ownerContactIdBefore === secondaryId) {
      db.prepare("UPDATE app_meta SET value = ?, updated_at = ? WHERE key = ?")
        .run(String(primaryId), now, OWNER_ID_KEY);
      db.prepare("UPDATE contacts SET starred = 1 WHERE id = ?").run(primaryId);
      snapshot.ownerRepointed = true;
    }

    const merged = { ...primary, fields, starred: snapshot.ownerRepointed ? true : primary.starred, updatedAt: now };
    upsertSearchRow(db, merged);

    const info = db
      .prepare("INSERT INTO merge_log (primary_id, secondary_id, snapshot, merged_at) VALUES (?, ?, ?, ?)")
      .run(primaryId, secondaryId, JSON.stringify(snapshot), now);

    return { contact: merged, mergeId: Number(info.lastInsertRowid) };
  });

  return tx();
}

/** Reverse a journaled merge. Pure data-layer; caller refreshes the graph. */
function undo(db, { mergeId }) {
  const tx = db.transaction(() => {
    const row = db.prepare("SELECT * FROM merge_log WHERE id = ?").get(mergeId);
    if (!row) throw new AppError("NOT_FOUND", `No merge #${mergeId} to undo.`);
    const snap = JSON.parse(row.snapshot);
    const now = Date.now();

    // Remove the edges the merge created on the primary.
    const delE = db.prepare("DELETE FROM edges WHERE source_id = ? AND target_id = ? AND type = ?");
    for (const e of snap.createdPrimaryEdges) delE.run(e.source_id, e.target_id, e.type);
    for (const e of snap.updatedPrimaryEdges || []) {
      db.prepare("UPDATE edges SET metadata = ? WHERE source_id = ? AND target_id = ? AND type = ?")
        .run(e.metadata, e.source_id, e.target_id, e.type);
    }

    // Restore the secondary and its edges/tags.
    db.prepare("UPDATE contacts SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(now, row.secondary_id);
    if (snap.ownerRepointed) {
      const currentOwner = Number(db.prepare("SELECT value FROM app_meta WHERE key = ?").get(OWNER_ID_KEY)?.value) || null;
      // Do not overwrite a deliberate owner change made after the merge.
      if (currentOwner === row.primary_id) {
        db.prepare("UPDATE app_meta SET value = ?, updated_at = ? WHERE key = ?")
          .run(String(row.secondary_id), now, OWNER_ID_KEY);
      }
    }
    const insE = db.prepare(
      `INSERT OR IGNORE INTO edges (source_id, target_id, type, directed, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const e of snap.secondaryEdges) {
      insE.run(e.source_id, e.target_id, e.type, e.directed, e.metadata, e.created_at);
    }
    const linkTag = db.prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)");
    for (const tagId of snap.secondaryTagIds) linkTag.run(row.secondary_id, tagId);

    // Move the timeline back and restore the primary's fields.
    if (snap.movedInteractionIds.length) {
      const upd = db.prepare("UPDATE interactions SET contact_id = ? WHERE id = ?");
      for (const iid of snap.movedInteractionIds) upd.run(row.secondary_id, iid);
    }
    db.prepare("UPDATE contacts SET fields = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(snap.primaryFieldsBefore), now, row.primary_id);
    if (snap.primaryStarredBefore !== undefined) {
      db.prepare("UPDATE contacts SET starred = ? WHERE id = ?")
        .run(snap.primaryStarredBefore ? 1 : 0, row.primary_id);
    }

    const primary = contactsRepo.get(db, row.primary_id);
    upsertSearchRow(db, primary);
    const secondary = contactsRepo.get(db, row.secondary_id);
    upsertSearchRow(db, secondary);

    db.prepare("DELETE FROM merge_log WHERE id = ?").run(mergeId);
    return { primary, secondary };
  });
  const result = tx();
  return { ok: true, primaryId: result.primary.id, secondaryId: result.secondary.id };
}

module.exports = { candidates, merge, undo };
