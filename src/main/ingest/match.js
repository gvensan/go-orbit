// match.js - read-only duplicate MATCHING for the import wizard. Given parsed
// incoming records, returns per-record ranked candidate matches against the live
// contacts (with a reason and a confidence score), each candidate's current
// connections for context, and in-file duplicate flags. Nothing is written here;
// the user decides what to do with every record (see the wizard Resolve step).
//
// This complements two existing matchers: importer.js does exact-equality dedup
// at commit time (no ranking), and dedup/engine.js ranks live-vs-live pairs. This
// module ranks INCOMING rows against the live graph so the wizard can advise.

const { jaroWinkler } = require("../search/engine");
const config = require("../config");

const normEmail = (e) => (e || "").trim().toLowerCase();
const normName = (n) => (n || "").trim().toLowerCase().replace(/\s+/g, " ");
const normPhone = (p) => (p || "").replace(/[^\d+]/g, "");
// Cheap blocking keys so fuzzy name comparison stays bounded on large graphs:
// a 3-char prefix per name token (first + last), so people who share a surname
// (or a first name) land in the same bucket even if the other token has a typo.
const tokenKeys = (nn) => {
  const keys = new Set();
  for (const t of nn.split(/\s+/)) { const k = t.replace(/[^a-z0-9]/g, "").slice(0, 3); if (k) keys.add(k); }
  return keys.size ? [...keys] : [nn.replace(/[^a-z0-9]/g, "").slice(0, 3)];
};

/** A contact's current connections (related contact + edge type), for context. */
function connectionsOf(db, id, limit) {
  return db
    .prepare(
      `SELECT e.type AS type, c.id AS id, c.name AS name
         FROM edges e
         JOIN contacts c ON c.id = (CASE WHEN e.source_id = @id THEN e.target_id ELSE e.source_id END)
        WHERE (e.source_id = @id OR e.target_id = @id) AND c.deleted_at IS NULL
        ORDER BY c.name
        LIMIT @limit`
    )
    .all({ id, limit });
}

/**
 * Rank candidate matches for each incoming record against the live contacts.
 *
 * @param {any} db
 * @param {{ name: string, fields?: Record<string,string> }[]} records
 * @returns {{ candidates: import("../../shared/types").MatchCandidate[], inFileDup: number[] }[]}
 *          parallel to `records`; `inFileDup` lists other record indices that
 *          share a strong key (email/phone/name+company) with this one.
 */
function matchRecords(db, records) {
  const maxC = config.dedup.matchMaxCandidates;
  const simMin = config.dedup.matchNameSimMin;
  const connLimit = config.dedup.matchConnections;

  const live = db
    .prepare("SELECT id, name, fields FROM contacts WHERE deleted_at IS NULL")
    .all()
    .map((r) => {
      const f = r.fields ? JSON.parse(r.fields) : {};
      return {
        id: r.id, name: r.name, fields: f,
        nn: normName(r.name), email: normEmail(f.email),
        phone: normPhone(f.phone), company: normName(f.company),
      };
    });

  const byEmail = new Map(), byPhone = new Map(), byName = new Map(), buckets = new Map();
  const push = (map, key, c) => { if (!key) return; const a = map.get(key); if (a) a.push(c); else map.set(key, [c]); };
  for (const c of live) {
    push(byEmail, c.email, c);
    push(byPhone, c.phone, c);
    push(byName, c.nn, c);
    for (const k of tokenKeys(c.nn)) push(buckets, k, c);
  }
  const liveById = new Map(live.map((c) => [c.id, c]));

  // Strong keys per record, for in-file (incoming-vs-incoming) duplicate flags.
  const keyOf = (rec) => {
    const f = rec.fields || {};
    return [
      normEmail(f.email) && "e:" + normEmail(f.email),
      normPhone(f.phone) && "p:" + normPhone(f.phone),
      "n:" + normName(rec.name) + "|" + normName(f.company),
    ].filter(Boolean);
  };
  const firstForKey = new Map();
  const inFile = records.map(() => new Set());
  records.forEach((rec, i) => {
    for (const k of keyOf(rec)) {
      if (firstForKey.has(k)) { const j = firstForKey.get(k); inFile[i].add(j); inFile[j].add(i); }
      else firstForKey.set(k, i);
    }
  });

  return records.map((rec, i) => {
    const f = rec.fields || {};
    const email = normEmail(f.email), phone = normPhone(f.phone);
    const nn = normName(rec.name), company = normName(f.company);
    const cand = new Map(); // id -> { score, reasons:Set }
    const add = (c, score, reason) => {
      const e = cand.get(c.id) || { score: 0, reasons: new Set() };
      e.score = Math.max(e.score, score);
      e.reasons.add(reason);
      cand.set(c.id, e);
    };
    if (email) for (const c of byEmail.get(email) || []) add(c, 1.0, "shares an email");
    if (phone) for (const c of byPhone.get(phone) || []) add(c, 0.95, "shares a phone number");
    for (const c of byName.get(nn) || [])
      add(c, company && c.company === company ? 0.85 : 0.7,
        company && c.company === company ? "same name and company" : "same name");
    // Fuzzy name within the blocking buckets (exact-name hits handled above).
    const seenFuzzy = new Set();
    for (const key of tokenKeys(nn)) for (const c of buckets.get(key) || []) {
      if (c.nn === nn || seenFuzzy.has(c.id)) continue;
      seenFuzzy.add(c.id);
      const sim = jaroWinkler(nn, c.nn);
      if (sim >= simMin)
        add(c, (company && c.company === company ? 0.7 : 0.6) * sim,
          company && c.company === company ? "similar name, same company" : "similar name");
    }

    const candidates = [...cand.entries()]
      .map(([id, e]) => {
        const c = liveById.get(id);
        return {
          contactId: id, name: c.name,
          score: Math.round(e.score * 100) / 100, reasons: [...e.reasons],
          email: c.fields.email || "", phone: c.fields.phone || "", company: c.fields.company || "",
          connections: connectionsOf(db, id, connLimit),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxC);

    return { candidates, inFileDup: [...inFile[i]].sort((a, b) => a - b) };
  });
}

module.exports = { matchRecords, connectionsOf };
