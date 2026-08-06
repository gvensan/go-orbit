// health/engine.js - the admin review: scans the database for structural,
// relationship, quality, and graph-shape issues, and applies the narrow set of
// fixes that are provably safe. Read-only except where documented:
//   - scan() persists its run summary + prunes stale statuses (app_meta only),
//   - setStatus() records a user's triage (ignored/deferred) per finding,
//   - fix() applies one whitelisted repair inside a transaction.
// Findings carry a stable fingerprint (check id + anchor), so triage survives
// reruns while a fixed issue simply stops appearing (and counts as resolved).

const { RELATIONSHIP_TYPES, BUSINESS_TYPES, KIN_ROLES } = require("../../shared/relationships");
const { fieldType, validateField } = require("../../shared/field-types");
const contacts = require("../db/contacts");
const meta = require("../db/meta");
const dedup = require("../dedup/engine");
const { AppError } = require("../ipc/errors");

const STATUS_KEY = "health.statuses";
const LAST_RUN_KEY = "health.lastRun";
const STATUSES = new Set(["open", "ignored", "deferred"]);
const FIX_KINDS = new Set([
  "remove-edge", "canonicalize-edge", "clear-kin", "clear-stray-kin",
  "strip-gender", "clear-cadence", "purge-orphans",
]);

const isBiz = (f) => /^(yes|true|1)$/i.test(String(f?.business ?? ""));
const isYes = (v) => /^(yes|true|1)$/i.test(String(v ?? ""));
// Roles exclusive to one term set (shared terms like "cousin" prove nothing).
const FEMALE_ONLY = new Set(KIN_ROLES.female.filter((r) => !KIN_ROLES.male.includes(r)));
const MALE_ONLY = new Set(KIN_ROLES.male.filter((r) => !KIN_ROLES.female.includes(r)));

const loadJson = (db, key, fallback) => {
  const raw = meta.get(db, key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
};

/** One finding. `fix` names a safe auto-repair this engine can apply; `action`
 *  names a place the renderer can take the user (open the card, the dedup
 *  queue, the profile). Both optional; a finding can be advice alone. */
/** @param {{ fingerprint: string, check: string, category: string, severity: string,
 *            title: string, detail: string, contactId?: number | null,
 *            focusIds?: number[] | null,
 *            fix?: Record<string, unknown> | null, action?: string | null }} f */
function finding({ fingerprint, check, category, severity, title, detail, contactId, focusIds, fix, action }) {
  return {
    fingerprint, check, category, severity, title, detail,
    contactId: contactId ?? null,
    focusIds: focusIds ?? null, // live contacts to focus for "Show on graph"
    fix: fix ?? null, action: action ?? null, status: "open",
  };
}

const edgeRef = (e) => ({ sourceId: e.s, targetId: e.t, type: e.type });
const edgeFp = (check, e) => `${check}|${e.s}|${e.t}|${e.type}`;

/** Run every check. Persists the run summary and returns findings newest-first
 *  by severity. Pure reads plus two app_meta writes (run summary, pruned
 *  statuses); never touches contacts, edges, or derived rows. */
function scan(db) {
  const live = db
    .prepare("SELECT id, name, fields, cadence_days FROM contacts WHERE deleted_at IS NULL")
    .all()
    .map((r) => {
      let f = {};
      try { f = r.fields ? JSON.parse(r.fields) : {}; } catch { f = {}; }
      return { id: r.id, name: r.name, fields: f, cadenceDays: r.cadence_days };
    });
  const liveById = new Map(live.map((c) => [c.id, c]));
  const allIds = new Set(db.prepare("SELECT id FROM contacts").all().map((r) => r.id));
  const trashed = new Set(
    db.prepare("SELECT id FROM contacts WHERE deleted_at IS NOT NULL").all().map((r) => r.id)
  );
  const edges = db
    .prepare("SELECT source_id AS s, target_id AS t, type, directed, metadata FROM edges")
    .all()
    .map((e) => {
      let m = null;
      try { m = e.metadata ? JSON.parse(e.metadata) : null; } catch { m = null; }
      return { s: e.s, t: e.t, type: e.type, directed: !!e.directed, metadata: m };
    });
  const nameOf = (id) => liveById.get(id)?.name ?? (trashed.has(id) ? `#${id} (in trash)` : `#${id}`);
  const F = [];

  // --- structure -----------------------------------------------------------
  for (const e of edges) {
    const pair = `${nameOf(e.s)} — ${nameOf(e.t)}`;
    // Live endpoints, for the "Show on graph" jump on every edge finding.
    const ends = [...new Set([e.s, e.t])].filter((id) => liveById.has(id));
    if (!allIds.has(e.s) || !allIds.has(e.t)) {
      F.push(finding({
        fingerprint: edgeFp("edge-dangling", e), check: "edge-dangling",
        category: "structure", severity: "error",
        title: "Connection points at a contact that no longer exists",
        detail: `The ${e.type} tie ${pair} references a missing contact row. It can never render; removing it is safe.`,
        contactId: liveById.has(e.s) ? e.s : liveById.has(e.t) ? e.t : null,
        focusIds: ends,
        fix: { kind: "remove-edge", label: "Remove connection", ...edgeRef(e) },
      }));
      continue; // the other structural checks assume real endpoints
    }
    if (e.s === e.t) {
      F.push(finding({
        fingerprint: edgeFp("edge-self-loop", e), check: "edge-self-loop",
        category: "structure", severity: "error",
        title: "Contact is connected to themselves",
        detail: `${nameOf(e.s)} has a ${e.type} tie to themselves. Self-loops mean nothing in the graph; removing it is safe.`,
        contactId: e.s,
        focusIds: ends,
        fix: { kind: "remove-edge", label: "Remove connection", ...edgeRef(e) },
      }));
    }
    if (!e.directed && e.s > e.t) {
      F.push(finding({
        fingerprint: edgeFp("edge-noncanonical", e), check: "edge-noncanonical",
        category: "structure", severity: "warn",
        title: "Undirected connection stored in the wrong order",
        detail: `The ${e.type} tie ${pair} predates endpoint canonicalization; it risks a duplicate of its mirror. Reordering (or dropping it if the mirror exists) is safe.`,
        contactId: liveById.has(e.s) ? e.s : liveById.has(e.t) ? e.t : null,
        focusIds: ends,
        fix: { kind: "canonicalize-edge", label: "Repair ordering", ...edgeRef(e) },
      }));
    }
    if (!RELATIONSHIP_TYPES.includes(e.type)) {
      F.push(finding({
        fingerprint: edgeFp("edge-unknown-type", e), check: "edge-unknown-type",
        category: "structure", severity: "warn",
        title: `Unknown relationship type "${e.type}"`,
        detail: `${pair} uses a type the legend cannot color (likely an old import). Open either contact and re-pick the relationship.`,
        contactId: liveById.has(e.s) ? e.s : e.t,
        focusIds: ends,
        action: "open-contact",
      }));
    }
    if (e.metadata?.kin && e.type !== "family") {
      F.push(finding({
        fingerprint: edgeFp("kin-on-nonfamily", e), check: "kin-on-nonfamily",
        category: "structure", severity: "warn",
        title: "Kinship recorded on a non-family connection",
        detail: `The ${e.type} tie ${pair} carries kinship roles, but only family ties use them (the tree ignores this). Clearing the leftover roles is safe.`,
        contactId: liveById.has(e.s) ? e.s : liveById.has(e.t) ? e.t : null,
        focusIds: ends,
        fix: { kind: "clear-kin", label: "Clear kinship", ...edgeRef(e) },
      }));
    }
    if (trashed.has(e.s) || trashed.has(e.t)) {
      F.push(finding({
        fingerprint: edgeFp("edge-to-trashed", e), check: "edge-to-trashed",
        category: "structure", severity: "info",
        title: "Connection to a contact in the trash",
        detail: `The ${e.type} tie ${pair} is dormant while its contact sits in the trash; it revives on restore. Restore them from Trash, or remove the tie if they are gone for good.`,
        contactId: liveById.has(e.s) ? e.s : liveById.has(e.t) ? e.t : null,
        focusIds: ends,
        fix: { kind: "remove-edge", label: "Remove connection", ...edgeRef(e) },
      }));
    }
  }

  const orphanInteractions = db
    .prepare("SELECT COUNT(*) AS n FROM interactions WHERE contact_id NOT IN (SELECT id FROM contacts)").get().n;
  const orphanTags = db
    .prepare("SELECT COUNT(*) AS n FROM contact_tags WHERE contact_id NOT IN (SELECT id FROM contacts)").get().n;
  if (orphanInteractions + orphanTags > 0) {
    F.push(finding({
      fingerprint: "orphan-rows", check: "orphan-rows",
      category: "structure", severity: "error",
      title: "Leftover rows for contacts that no longer exist",
      detail: `${orphanInteractions} interaction(s) and ${orphanTags} tag link(s) reference missing contacts. They are unreachable from the app; cleaning them is safe.`,
      fix: { kind: "purge-orphans", label: "Clean up" },
    }));
  }

  const ownerRaw = meta.get(db, "owner.contactId");
  const ownerId = meta.getOwnerContactId(db);
  if (ownerRaw && ownerId == null) {
    F.push(finding({
      fingerprint: "owner-invalid", check: "owner-invalid",
      category: "structure", severity: "warn",
      title: "The \"you\" contact is missing",
      detail: "The owner pointer references a deleted contact, so views cannot centre on you. Pick yourself again under Settings > You.",
      action: "open-profile",
    }));
  } else if (!ownerRaw) {
    F.push(finding({
      fingerprint: "owner-unset", check: "owner-unset",
      category: "structure", severity: "info",
      title: "No \"you\" contact set",
      detail: "Home, Orbit and Reach centre on you; without an owner they fall back to the biggest hub. Set yourself under Settings > You.",
      action: "open-profile",
    }));
  }

  // --- relationship semantics ---------------------------------------------
  for (const e of edges) {
    if (e.type !== "family" || !liveById.has(e.s) || !liveById.has(e.t)) continue;
    const kin = e.metadata?.kin && typeof e.metadata.kin === "object" ? e.metadata.kin : null;
    const pair = `${nameOf(e.s)} — ${nameOf(e.t)}`;
    if (!kin || !Object.values(kin).some((r) => typeof r === "string" && r)) {
      F.push(finding({
        fingerprint: edgeFp("family-missing-kin", e), check: "family-missing-kin",
        category: "relationships", severity: "info",
        title: "Family tie without a kinship role",
        detail: `${pair} is family, but who is whose what is not recorded, so the tree cannot place them. Open the card and pick the role.`,
        contactId: e.s, focusIds: [e.s, e.t], action: "open-contact",
      }));
      continue;
    }
    for (const [cidStr, role] of Object.entries(kin)) {
      const cid = Number(cidStr);
      // A kin entry keyed by a NON-endpoint id is a leftover (old merges and
      // imports predate id remapping). It must not be attributed to whoever
      // holds that id today, and nothing can read it - the tree looks kin up
      // by endpoint id - so clearing it is safe. Endpoint roles are kept.
      if (cid !== e.s && cid !== e.t) {
        const stray = liveById.get(cid);
        F.push(finding({
          fingerprint: `kin-stray-key|${e.s}|${e.t}|${cidStr}`, check: "kin-stray-key",
          category: "structure", severity: "warn",
          title: "Leftover kinship entry on this tie",
          detail: `The family tie ${pair} still carries the role "${role}" keyed to a contact id from before an old merge or import${stray ? ` - a number that now belongs to ${stray.name}, who is not on this tie and is unaffected` : ""}. No view can read the entry; clearing it is safe. If the role should exist, open the card and record it on the right person.`,
          contactId: liveById.has(e.s) ? e.s : e.t,
          focusIds: [e.s, e.t],
          fix: { kind: "clear-stray-kin", label: "Clear stray entry", ...edgeRef(e) },
        }));
        continue;
      }
      const person = liveById.get(cid);
      if (!person || typeof role !== "string") continue;
      const g = String(person.fields.gender || "").trim().toLowerCase();
      const conflict =
        (FEMALE_ONLY.has(role) && (g === "male" || g === "m" || g === "man")) ||
        (MALE_ONLY.has(role) && (g === "female" || g === "f" || g === "woman"));
      if (conflict) {
        F.push(finding({
          fingerprint: `kin-gender-conflict|${e.s}|${e.t}|${cid}`, check: "kin-gender-conflict",
          category: "relationships", severity: "warn",
          title: `"${role}" conflicts with ${person.name}'s gender`,
          detail: `${person.name} is recorded as ${person.fields.gender}, but their role on the ${pair} tie is "${role}". One of the two is wrong; open the card to correct it.`,
          contactId: cid, focusIds: [e.s, e.t], action: "open-contact",
        }));
      }
      if (BUSINESS_TYPES.size && isBiz(person.fields)) {
        F.push(finding({
          fingerprint: `business-in-family|${e.s}|${e.t}|${cid}`, check: "business-in-family",
          category: "relationships", severity: "warn",
          title: "A business sits inside a family tie",
          detail: `${person.name} is flagged as a business but appears on the family tie ${pair}. Either the flag or the tie type is wrong.`,
          contactId: cid, focusIds: [e.s, e.t], action: "open-contact",
        }));
      }
    }
  }

  for (const e of edges) {
    if (!BUSINESS_TYPES.has(e.type) || !liveById.has(e.s) || !liveById.has(e.t)) continue;
    const cs = liveById.get(e.s), ct = liveById.get(e.t);
    const flagged = isBiz(cs.fields) || isBiz(ct.fields);
    const genderless = !cs.fields.gender || !ct.fields.gender;
    if (!flagged && !genderless) {
      F.push(finding({
        fingerprint: edgeFp("vendor-ambiguous", e), check: "vendor-ambiguous",
        category: "relationships", severity: "info",
        title: "Vendor tie between two people",
        detail: `${nameOf(e.s)} — ${nameOf(e.t)} is a vendor tie, but both sides look like gendered people, so neither is treated as the business. Open the vendor's card and mark it as a business.`,
        contactId: e.s, focusIds: [e.s, e.t], action: "open-contact",
      }));
    }
  }

  for (const c of live) {
    if (isBiz(c.fields) && c.fields.gender) {
      F.push(finding({
        fingerprint: `business-with-gender|${c.id}`, check: "business-with-gender",
        category: "relationships", severity: "warn",
        title: `${c.name} is a business with a stored gender`,
        detail: `Businesses have no gender; this value predates the rule and nothing reads it. Removing it is safe.`,
        contactId: c.id,
        fix: { kind: "strip-gender", label: "Remove gender", contactId: c.id },
      }));
    }
    if (isYes(c.fields.deceased) && c.cadenceDays != null) {
      F.push(finding({
        fingerprint: `deceased-cadence|${c.id}`, check: "deceased-cadence",
        category: "relationships", severity: "warn",
        title: `${c.name} is deceased but has a keep-in-touch reminder`,
        detail: `A "stay in touch every ${c.cadenceDays} days" cadence is still set. Clearing it is safe.`,
        contactId: c.id,
        fix: { kind: "clear-cadence", label: "Clear reminder", contactId: c.id },
      }));
    }
  }

  // --- data quality --------------------------------------------------------
  for (const c of live) {
    const name = String(c.name ?? "");
    // eslint-disable-next-line no-control-regex
    if (!name.trim() || /[\u0000-\u001f\u007f]/.test(name)) {
      F.push(finding({
        fingerprint: `name-suspect|${c.id}`, check: "name-suspect",
        category: "quality", severity: "error",
        title: "Contact name is blank or contains junk characters",
        detail: `Contact #${c.id} has an empty or control-character name and cannot be searched for sensibly. Open it and give it a real name.`,
        contactId: c.id, action: "open-contact",
      }));
    }
    for (const [key, value] of Object.entries(c.fields)) {
      if (typeof value !== "string" || !value.trim()) continue;
      const msg = validateField(fieldType(key), value);
      if (msg) {
        F.push(finding({
          fingerprint: `field-invalid|${c.id}|${key}`, check: "field-invalid",
          category: "quality", severity: "warn",
          title: `${c.name}: ${key} looks malformed`,
          detail: `"${value}" - ${msg}`,
          contactId: c.id, action: "open-contact",
        }));
      }
    }
    if (c.fields.location && !c.fields.geo) {
      F.push(finding({
        fingerprint: `location-unmapped|${c.id}`, check: "location-unmapped",
        category: "quality", severity: "info",
        title: `${c.name} has an address that is not on the map`,
        detail: `"${c.fields.location}" was never geocoded, so they are missing from the Geomap. Open the card and map it.`,
        contactId: c.id, action: "open-contact",
      }));
    }
  }

  const dupPairs = dedup.candidates(db);
  if (dupPairs.length) {
    F.push(finding({
      fingerprint: "dedup-pending", check: "dedup-pending",
      category: "quality", severity: "info",
      title: `${dupPairs.length} possible duplicate pair(s)`,
      detail: "Contacts sharing an email, phone, or a close name at the same company. Review them in the dedup queue; merges are journaled and undoable.",
      action: "open-dedup",
    }));
  }

  // --- graph shape ---------------------------------------------------------
  const adj = new Map();
  for (const e of edges) {
    if (!liveById.has(e.s) || !liveById.has(e.t) || e.s === e.t) continue;
    if (!adj.has(e.s)) adj.set(e.s, new Set());
    if (!adj.has(e.t)) adj.set(e.t, new Set());
    adj.get(e.s).add(e.t);
    adj.get(e.t).add(e.s);
  }
  const isolated = live.filter((c) => !adj.has(c.id) && c.id !== ownerId);
  if (isolated.length) {
    const sample = isolated.slice(0, 5).map((c) => c.name).join(", ");
    F.push(finding({
      fingerprint: "isolated-contacts", check: "isolated-contacts",
      category: "graph", severity: "info",
      title: `${isolated.length} contact(s) with no connections`,
      detail: `${sample}${isolated.length > 5 ? "…" : ""} - they exist but are invisible in every centred view. Link them to someone, or leave them if that is intentional.`,
      contactId: isolated[0].id,
      focusIds: isolated.slice(0, 25).map((c) => c.id),
      action: "open-contact",
    }));
  }
  if (ownerId != null && adj.size) {
    const seen = new Set([ownerId]);
    const queue = [ownerId];
    while (queue.length) {
      const u = queue.pop();
      for (const nb of adj.get(u) ?? []) if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
    }
    const unreachable = live.filter((c) => adj.has(c.id) && !seen.has(c.id));
    if (unreachable.length) {
      const sample = unreachable.slice(0, 5).map((c) => c.name).join(", ");
      F.push(finding({
        fingerprint: "unreachable-from-owner", check: "unreachable-from-owner",
        category: "graph", severity: "info",
        title: `${unreachable.length} contact(s) in islands not linked to you`,
        detail: `${sample}${unreachable.length > 5 ? "…" : ""} - connected to each other but with no path to you, so Reach and Orbit cannot place them. Add the tie that links their group to your network.`,
        contactId: unreachable[0].id,
        focusIds: unreachable.slice(0, 25).map((c) => c.id),
        action: "open-contact",
      }));
    }
  }

  // --- statuses, resolved count, run summary -------------------------------
  const statuses = loadJson(db, STATUS_KEY, {});
  const current = new Set(F.map((f) => f.fingerprint));
  for (const f of F) {
    const s = statuses[f.fingerprint]?.status;
    if (s && STATUSES.has(s)) f.status = s;
  }
  const sevRank = { error: 0, warn: 1, info: 2 };
  F.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.check.localeCompare(b.check) || a.fingerprint.localeCompare(b.fingerprint));
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of F) counts[f.severity]++;

  const lastRun = loadJson(db, LAST_RUN_KEY, null);
  // Older builds stored only fingerprints; both shapes feed the resolved count.
  const prevFps = lastRun?.findings ? lastRun.findings.map((f) => f.fingerprint) : lastRun?.fingerprints ?? null;
  const resolvedCount = prevFps ? prevFps.filter((fp) => !current.has(fp)).length : 0;
  const now = Date.now();
  const result = { findings: F, counts, resolvedCount, lastRunAt: now, previousRunAt: lastRun?.at ?? null };
  const tx = db.transaction(() => {
    // The full deck is persisted so the Review tab can show the last run (with
    // triage re-merged) instead of an empty screen until the next scan.
    meta.set(db, LAST_RUN_KEY, JSON.stringify({ at: now, ...result }));
    const pruned = {};
    for (const [fp, rec] of Object.entries(statuses)) if (current.has(fp)) pruned[fp] = rec;
    meta.set(db, STATUS_KEY, JSON.stringify(pruned));
  });
  tx();
  return result;
}

/** The persisted result of the most recent scan, with triage re-merged from
 *  the status store (so ignore/defer done since then still shows). Null when
 *  no scan has run yet (or the stored shape predates persisted findings). */
function lastResult(db) {
  const stored = loadJson(db, LAST_RUN_KEY, null);
  if (!stored || !Array.isArray(stored.findings)) return null;
  const statuses = loadJson(db, STATUS_KEY, {});
  for (const f of stored.findings) {
    const s = statuses[f.fingerprint]?.status;
    f.status = s && STATUSES.has(s) ? s : "open";
  }
  return {
    findings: stored.findings,
    counts: stored.counts ?? { error: 0, warn: 0, info: 0 },
    resolvedCount: stored.resolvedCount ?? 0,
    lastRunAt: stored.at,
    previousRunAt: stored.previousRunAt ?? null,
  };
}

/** Record the user's triage of one finding. Statuses survive reruns while the
 *  finding persists; when it disappears the record is pruned by the next scan. */
function setStatus(db, { fingerprint, status }) {
  if (!STATUSES.has(status)) throw new AppError("VALIDATION", `Unknown status "${status}".`);
  const statuses = loadJson(db, STATUS_KEY, {});
  if (status === "open") delete statuses[fingerprint];
  else statuses[fingerprint] = { status, at: Date.now() };
  meta.set(db, STATUS_KEY, JSON.stringify(statuses));
  return { ok: true };
}

/** Apply one whitelisted repair. Each is idempotent, bounded to the referenced
 *  rows, and no more powerful than an existing public channel; multi-statement
 *  work runs in a transaction. Callers rehydrate the graph store afterwards. */
function fix(db, p) {
  if (!FIX_KINDS.has(p.kind)) throw new AppError("VALIDATION", `Unknown fix "${p.kind}".`);
  switch (p.kind) {
    case "remove-edge": {
      const info = db
        .prepare("DELETE FROM edges WHERE source_id = ? AND target_id = ? AND type = ?")
        .run(p.sourceId, p.targetId, p.type);
      return { ok: true, changed: info.changes };
    }
    case "canonicalize-edge": {
      const tx = db.transaction(() => {
        const row = db
          .prepare("SELECT source_id AS s, target_id AS t, directed FROM edges WHERE source_id = ? AND target_id = ? AND type = ?")
          .get(p.sourceId, p.targetId, p.type);
        if (!row || row.directed || row.s <= row.t) return 0; // already fine (idempotent rerun)
        const twin = db
          .prepare("SELECT 1 FROM edges WHERE source_id = ? AND target_id = ? AND type = ?")
          .get(row.t, row.s, p.type);
        if (twin) {
          return db.prepare("DELETE FROM edges WHERE source_id = ? AND target_id = ? AND type = ?")
            .run(row.s, row.t, p.type).changes;
        }
        return db.prepare("UPDATE edges SET source_id = ?, target_id = ? WHERE source_id = ? AND target_id = ? AND type = ?")
          .run(row.t, row.s, row.s, row.t, p.type).changes;
      });
      return { ok: true, changed: tx() };
    }
    case "clear-kin": {
      const tx = db.transaction(() => {
        const row = db
          .prepare("SELECT metadata FROM edges WHERE source_id = ? AND target_id = ? AND type = ?")
          .get(p.sourceId, p.targetId, p.type);
        if (!row || !row.metadata) return 0;
        let m;
        try { m = JSON.parse(row.metadata); } catch { m = null; }
        if (!m || !("kin" in m)) return 0;
        delete m.kin;
        const next = Object.keys(m).length ? JSON.stringify(m) : null;
        return db.prepare("UPDATE edges SET metadata = ? WHERE source_id = ? AND target_id = ? AND type = ?")
          .run(next, p.sourceId, p.targetId, p.type).changes;
      });
      return { ok: true, changed: tx() };
    }
    case "clear-stray-kin": {
      const tx = db.transaction(() => {
        const row = db
          .prepare("SELECT source_id AS s, target_id AS t, metadata FROM edges WHERE source_id = ? AND target_id = ? AND type = ?")
          .get(p.sourceId, p.targetId, p.type);
        if (!row || !row.metadata) return 0;
        let m;
        try { m = JSON.parse(row.metadata); } catch { m = null; }
        if (!m?.kin || typeof m.kin !== "object") return 0;
        const kept = {};
        let dropped = 0;
        for (const [k, role] of Object.entries(m.kin)) {
          if (Number(k) === row.s || Number(k) === row.t) kept[k] = role;
          else dropped++;
        }
        if (!dropped) return 0; // already clean (idempotent rerun)
        if (Object.keys(kept).length) m.kin = kept; else delete m.kin;
        const next = Object.keys(m).length ? JSON.stringify(m) : null;
        db.prepare("UPDATE edges SET metadata = ? WHERE source_id = ? AND target_id = ? AND type = ?")
          .run(next, p.sourceId, p.targetId, p.type);
        return dropped;
      });
      return { ok: true, changed: tx() };
    }
    case "strip-gender": {
      const c = contacts.get(db, p.contactId);
      if (!c) throw new AppError("NOT_FOUND", "That contact is no longer available.");
      if (!isBiz(c.fields) || !c.fields.gender) return { ok: true, changed: 0 };
      const fields = { ...c.fields };
      delete fields.gender;
      contacts.update(db, { id: p.contactId, patch: { fields } });
      return { ok: true, changed: 1 };
    }
    case "clear-cadence": {
      const c = contacts.get(db, p.contactId);
      if (!c) throw new AppError("NOT_FOUND", "That contact is no longer available.");
      if (c.cadenceDays == null) return { ok: true, changed: 0 };
      contacts.update(db, { id: p.contactId, patch: { cadenceDays: 0 } });
      return { ok: true, changed: 1 };
    }
    case "purge-orphans": {
      const tx = db.transaction(() => {
        const a = db.prepare("DELETE FROM interactions WHERE contact_id NOT IN (SELECT id FROM contacts)").run().changes;
        const b = db.prepare("DELETE FROM contact_tags WHERE contact_id NOT IN (SELECT id FROM contacts)").run().changes;
        const c = db.prepare("DELETE FROM contacts_search WHERE id NOT IN (SELECT id FROM contacts)").run().changes;
        return a + b + c;
      });
      return { ok: true, changed: tx() };
    }
    default:
      throw new AppError("VALIDATION", `Unknown fix "${p.kind}".`);
  }
}

module.exports = { scan, lastResult, setStatus, fix };
