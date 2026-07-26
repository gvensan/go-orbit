// importer.js - the one write path every import source (vCard, CSV, archive
// contacts) funnels through: dedup detection + policy, transactional insert,
// search projection, tags. Returns the ImportReport shape plus an id map so
// archive import can remap edges.

const contactsRepo = require("../db/contacts");
const edgesRepo = require("../db/edges");
const { upsertSearchRow } = require("../db/search-projection");

const normEmail = (e) => (e || "").trim().toLowerCase();
const normName = (n) => (n || "").trim().toLowerCase().replace(/\s+/g, " ");
const normPhone = (p) => (p || "").replace(/[^\d+]/g, "");

/** Index existing live contacts for duplicate matching. */
function buildIndex(db) {
  const byEmail = new Map();
  const byPhone = new Map();
  const byNameOrg = new Map();
  const rows = db
    .prepare("SELECT id, name, fields FROM contacts WHERE deleted_at IS NULL")
    .all();
  for (const r of rows) {
    const f = r.fields ? JSON.parse(r.fields) : {};
    if (f.email) byEmail.set(normEmail(f.email), r.id);
    if (f.phone && normPhone(f.phone)) byPhone.set(normPhone(f.phone), r.id);
    byNameOrg.set(`${normName(r.name)}|${normName(f.company)}`, r.id);
  }
  return { byEmail, byPhone, byNameOrg };
}

function findDuplicate(index, contact) {
  const email = normEmail(contact.fields.email);
  if (email && index.byEmail.has(email)) return index.byEmail.get(email);
  const phone = normPhone(contact.fields.phone);
  if (phone && index.byPhone.has(phone)) return index.byPhone.get(phone);
  const key = `${normName(contact.name)}|${normName(contact.fields.company)}`;
  if (index.byNameOrg.has(key)) return index.byNameOrg.get(key);
  return null;
}

function setTags(db, contactId, tags) {
  if (!tags?.length) return;
  const upsert = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const idOf = db.prepare("SELECT id FROM tags WHERE name = ?");
  const link = db.prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)");
  for (const t of tags) {
    upsert.run(t);
    link.run(contactId, idOf.get(t).id);
  }
}

/**
 * Import parsed contacts inside ONE transaction. Caller is responsible for the
 * pre-import backup (guardrail: snapshot before every risky bulk write).
 *
 * @param {any} db
 * @param {{ name: string, fields?: Record<string,string>, tags?: string[], externalId?: number }[]} incoming
 * @param {{ onDuplicate: "skip" | "merge" | "keepBoth" }} opts
 * @returns {{ imported: number, merged: number, skipped: number,
 *             duplicatesFound: number, idMap: Map<number, number>,
 *             freshIds: Set<number> }}
 *          idMap: externalId -> local id (for archive edge remapping)
 */
function importContacts(db, incoming, { onDuplicate }) {
  const index = buildIndex(db);
  const report = {
    imported: 0, merged: 0, skipped: 0, duplicatesFound: 0,
    idMap: new Map(),
    freshIds: new Set(), // local ids of rows newly inserted (not merged/skipped)
  };
  const now = Date.now();
  const insert = db.prepare(
    "INSERT INTO contacts (name, fields, created_at, updated_at) VALUES (?, ?, ?, ?)"
  );

  const tx = db.transaction(() => {
    for (const item of incoming) {
      const contact = { name: item.name, fields: item.fields ?? {}, tags: item.tags ?? [] };
      const dupId = findDuplicate(index, contact);
      if (dupId != null) report.duplicatesFound++;

      if (dupId != null && onDuplicate === "skip") {
        report.skipped++;
        if (item.externalId != null) report.idMap.set(item.externalId, dupId);
        continue;
      }

      if (dupId != null && onDuplicate === "merge") {
        // Existing values win; incoming fills the blanks.
        const existing = contactsRepo.get(db, dupId);
        const fields = { ...contact.fields, ...existing.fields };
        db.prepare("UPDATE contacts SET fields = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(fields), now, dupId);
        setTags(db, dupId, contact.tags);
        upsertSearchRow(db, { id: dupId, name: existing.name, fields });
        report.merged++;
        if (item.externalId != null) report.idMap.set(item.externalId, dupId);
        continue;
      }

      const info = insert.run(contact.name, JSON.stringify(contact.fields), now, now);
      const id = Number(info.lastInsertRowid);
      setTags(db, id, contact.tags);
      upsertSearchRow(db, { id, name: contact.name, fields: contact.fields }, contact.tags.join(" "));
      // New contacts join the dup index so in-file duplicates are caught too.
      if (contact.fields.email) index.byEmail.set(normEmail(contact.fields.email), id);
      if (normPhone(contact.fields.phone)) index.byPhone.set(normPhone(contact.fields.phone), id);
      index.byNameOrg.set(`${normName(contact.name)}|${normName(contact.fields.company)}`, id);
      report.imported++;
      report.freshIds.add(id);
      if (item.externalId != null) report.idMap.set(item.externalId, id);
    }
  });
  tx();
  return report;
}

/**
 * Import reviewed records: contacts (same dedup as importContacts) PLUS the
 * family relationships captured in the review table. Each record may carry a
 * `rel` linking it to another contact - an existing one (`existingId`) or
 * another row in this batch (`batchIndex`) - with the kinship role already
 * resolved on the client (role + reciprocal). Runs after the shared pre-import
 * backup.
 *
 * @param {any} db
 * @param {{ name: string, fields?: Record<string,string>, tags?: string[],
 *           rel?: { type: string, role?: string, recip?: string|null, existingId?: number, batchIndex?: number } }[]} records
 * @param {{ onDuplicate: "skip" | "merge" | "keepBoth" }} opts
 */
function importRecords(db, records, opts) {
  const { onDuplicate } = opts;
  const incoming = records.map((r, i) => ({
    name: r.name, fields: r.fields ?? {}, tags: r.tags ?? [], externalId: i,
  }));
  const report = importContacts(db, incoming, { onDuplicate }); // report.idMap: index -> local id

  let relationships = 0;
  const relTx = db.transaction(() => {
    records.forEach((r, i) => {
      const rel = r.rel;
      if (!rel || !rel.type) return;
      const selfId = report.idMap.get(i);
      if (selfId == null) return;
      const relatedId = rel.existingId != null
        ? rel.existingId
        : (rel.batchIndex != null ? report.idMap.get(rel.batchIndex) : null);
      if (relatedId == null || relatedId === selfId) return;
      // Kinship metadata only for family; "introduced" is directed (self -> related).
      let metadata;
      if (rel.type === "family" && rel.role) {
        const kin = { [selfId]: rel.role };
        if (rel.recip) kin[relatedId] = rel.recip;
        metadata = { kin };
      }
      try {
        edgesRepo.create(db, {
          sourceId: selfId, targetId: relatedId, type: rel.type,
          directed: rel.type === "introduced", metadata,
        });
        relationships++;
      } catch { /* already linked or endpoint gone - skip, don't abort the batch */ }
    });
  });
  relTx();
  return { ...report, relationships };
}

module.exports = { importContacts, importRecords, findDuplicate, buildIndex };
