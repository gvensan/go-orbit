// archive.js - the portable .orbit archive (EXPORT_IMPORT spec, slice):
// NDJSON records (contacts, edges, interactions, tags) behind a JSON header.
// Optional passphrase => scrypt-derived AES-256-GCM over the whole payload,
// fail-closed on tamper or wrong passphrase (GCM auth tag). This archive is
// the device-migration and disaster-recovery floor; it deliberately uses a
// user-chosen passphrase, never the device-bound keychain key.

const crypto = require("crypto");
const fs = require("fs");
const { AppError } = require("../ipc/errors");
const { importContacts } = require("./importer");

const MAGIC = "ORBIT1";
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function buildPayload(db) {
  const lines = [];
  const contacts = db
    .prepare("SELECT id, name, fields, created_at, updated_at FROM contacts WHERE deleted_at IS NULL")
    .all();
  for (const c of contacts) {
    lines.push(JSON.stringify({ t: "c", id: c.id, name: c.name, fields: c.fields ? JSON.parse(c.fields) : {} }));
  }
  const edges = db
    .prepare(
      `SELECT e.source_id, e.target_id, e.type, e.directed, e.metadata
         FROM edges e
         JOIN contacts a ON a.id = e.source_id AND a.deleted_at IS NULL
         JOIN contacts b ON b.id = e.target_id AND b.deleted_at IS NULL`
    )
    .all();
  for (const e of edges) {
    lines.push(JSON.stringify({
      t: "e", s: e.source_id, d: e.target_id, type: e.type,
      directed: !!e.directed, metadata: e.metadata ? JSON.parse(e.metadata) : undefined,
    }));
  }
  const interactions = db
    .prepare(
      `SELECT i.contact_id, i.occurred_at, i.kind, i.note
         FROM interactions i JOIN contacts c ON c.id = i.contact_id AND c.deleted_at IS NULL`
    )
    .all();
  for (const i of interactions) {
    lines.push(JSON.stringify({ t: "i", c: i.contact_id, at: i.occurred_at, kind: i.kind, note: i.note }));
  }
  const tags = db
    .prepare(
      `SELECT ct.contact_id, t.name
         FROM contact_tags ct
         JOIN tags t ON t.id = ct.tag_id
         JOIN contacts c ON c.id = ct.contact_id AND c.deleted_at IS NULL`
    )
    .all();
  for (const t of tags) lines.push(JSON.stringify({ t: "t", c: t.contact_id, name: t.name }));

  return {
    payload: lines.join("\n"),
    counts: { contacts: contacts.length, edges: edges.length, interactions: interactions.length, tags: tags.length },
  };
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

/**
 * @param {any} db
 * @param {{ destPath: string, passphrase?: string }} opts
 * @returns {{ path: string, ok: boolean, counts: Record<string, number> }}
 */
function exportArchive(db, { destPath, passphrase }) {
  const { payload, counts } = buildPayload(db);
  const header = {
    magic: MAGIC,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    counts,
    encrypted: !!passphrase,
  };
  let body = Buffer.from(payload, "utf8");
  if (passphrase) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
    const enc = Buffer.concat([cipher.update(body), cipher.final()]);
    header.salt = salt.toString("base64");
    header.iv = iv.toString("base64");
    header.authTag = cipher.getAuthTag().toString("base64");
    body = enc;
  }
  const tmp = destPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(header) + "\n");
  fs.appendFileSync(tmp, body);
  fs.renameSync(tmp, destPath); // atomic: never a half-written archive
  return { path: destPath, ok: true, counts };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function readArchive(srcPath, passphrase) {
  const raw = fs.readFileSync(srcPath);
  const nl = raw.indexOf(0x0a);
  if (nl === -1) throw new AppError("VALIDATION", "Not an Orbit archive.");
  let header;
  try {
    header = JSON.parse(raw.slice(0, nl).toString("utf8"));
  } catch {
    throw new AppError("VALIDATION", "Not an Orbit archive.");
  }
  if (header.magic !== MAGIC) throw new AppError("VALIDATION", "Not an Orbit archive.");
  if (header.schemaVersion > SCHEMA_VERSION) {
    throw new AppError("VALIDATION", "This export is from a newer version. Update the app to import it.");
  }
  let body = raw.slice(nl + 1);
  if (header.encrypted) {
    if (!passphrase) throw new AppError("VALIDATION", "This archive is passphrase-protected.");
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        deriveKey(passphrase, Buffer.from(header.salt, "base64")),
        Buffer.from(header.iv, "base64")
      );
      decipher.setAuthTag(Buffer.from(header.authTag, "base64"));
      body = Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      // Fail closed: wrong passphrase and tampering are indistinguishable.
      throw new AppError("VALIDATION", "Wrong passphrase, or the archive has been modified.");
    }
  }
  const records = { contacts: [], edges: [], interactions: [], tags: [] };
  for (const line of body.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      throw new AppError("VALIDATION", "Archive is corrupted (bad record).");
    }
    if (rec.t === "c") records.contacts.push(rec);
    else if (rec.t === "e") records.edges.push(rec);
    else if (rec.t === "i") records.interactions.push(rec);
    else if (rec.t === "t") records.tags.push(rec);
  }
  return { header, records };
}

/**
 * Rewrite contact ids that live inside an edge's metadata (currently the kin map
 * on family edges) from archive-external ids to the local ids they mapped to.
 * kin entries whose contact didn't import are dropped.
 * @param {any} metadata @param {Map<number, number>} idMap
 */
function remapEdgeMetadata(metadata, idMap) {
  if (!metadata || typeof metadata !== "object" || !metadata.kin) return metadata;
  /** @type {Record<number, string>} */
  const kin = {};
  for (const [extId, role] of Object.entries(metadata.kin)) {
    const local = idMap.get(Number(extId));
    if (local != null) kin[local] = /** @type {string} */ (role);
  }
  return { ...metadata, kin };
}

/**
 * Import an archive. Caller takes the pre-import backup.
 * @param {any} db
 * @param {{ srcPath: string, passphrase?: string, onDuplicate: "skip"|"merge"|"keepBoth" }} opts
 * @returns {import('../../shared/types').ImportReport}
 */
function importArchive(db, { srcPath, passphrase, onDuplicate }) {
  const { header, records } = readArchive(srcPath, passphrase);

  const tagsByContact = new Map();
  for (const t of records.tags) {
    if (!tagsByContact.has(t.c)) tagsByContact.set(t.c, []);
    tagsByContact.get(t.c).push(t.name);
  }
  const incoming = records.contacts.map((c) => ({
    externalId: c.id,
    name: c.name,
    fields: c.fields ?? {},
    tags: tagsByContact.get(c.id) ?? [],
  }));

  // ONE outer transaction (inner ones become savepoints): a failure anywhere
  // rolls back contacts, edges, and interactions together - no partial import.
  let report = /** @type {ReturnType<typeof importContacts>} */ (/** @type {any} */ (null));
  const tx = db.transaction(() => {
    report = importContacts(db, incoming, { onDuplicate });
    const { idMap } = report;
    const now = Date.now();

    const insE = db.prepare(
      `INSERT OR IGNORE INTO edges (source_id, target_id, type, directed, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const e of records.edges) {
      const s = idMap.get(e.s);
      const d = idMap.get(e.d);
      if (s == null || d == null || s === d) continue;
      // Remap contact ids that live INSIDE the metadata too (family edges carry
      // metadata.kin = { <contactId>: role }); otherwise the kin roles point at
      // the archive's old ids and become unreadable after import.
      const metadata = remapEdgeMetadata(e.metadata, idMap);
      insE.run(s, d, e.type, e.directed ? 1 : 0, metadata ? JSON.stringify(metadata) : null, now);
    }
    const insI = db.prepare(
      "INSERT INTO interactions (contact_id, occurred_at, kind, note) VALUES (?, ?, ?, ?)"
    );
    // Only freshly inserted contacts get their history copied; merged/skipped
    // ones keep the local timeline to avoid duplicating interactions.
    for (const i of records.interactions) {
      const localId = idMap.get(i.c);
      if (localId == null || !report.freshIds.has(localId)) continue;
      insI.run(localId, i.at, i.kind ?? null, i.note ?? null);
    }
  });
  tx();

  return {
    imported: report.imported,
    merged: report.merged,
    skipped: report.skipped,
    duplicatesFound: report.duplicatesFound,
    schemaVersion: header.schemaVersion,
    // Local ids of newly inserted contacts, so the caller can run post-import
    // steps (location resolution) on just this batch. Stripped before IPC.
    freshIds: [...report.freshIds],
  };
}

module.exports = { exportArchive, importArchive, readArchive, MAGIC, SCHEMA_VERSION };
