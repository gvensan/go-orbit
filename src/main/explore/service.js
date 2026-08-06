// explore/service.js - the faceted people-search engine behind the Explore
// view. Keeps an in-memory assembled index (one row per live contact with the
// attributes every facet needs) so filtering and facet counting are pure
// in-memory passes; the index is rebuilt only when the data changes
// (markDirty(), driven from the IPC write handlers like the centrality cache).
//
// Facet model: OR within a group, AND across groups. A facet's own counts are
// computed as if that group's selection were not applied, so you can always
// see what adding another value would yield (standard faceted-search UX).

const config = require("../config");
const meta = require("../db/meta");
const { parseQuery } = require("../search/engine");
const { RELATIONSHIP_TYPES, BUSINESS_TYPES, isBusinessContact } = require("../../shared/relationships");

const STATUS_KEYS = ["starred", "overdue", "dormant", "hasEmail", "hasPhone"];
const EXPLORE_SORT_KEYS = [
  "name", "nickname", "gender", "birthday", "deceased", "email", "phone", "org", "role",
  "location", "city", "county", "state", "postcode", "country", "relationship", "kin",
  "degree", "tags", "notes", "recent", "overdue", "lastKind", "lastNote", "interactionCount",
  "cadenceDays", "starred", "website", "linkedin", "id", "createdAt", "updatedAt",
];
const DESC_SORTS = new Set(["degree", "recent", "overdue", "deceased", "interactionCount", "starred", "createdAt", "updatedAt"]);

class ExploreService {
  /** @param {{ db: any, graph: import('../graph/store').GraphStore }} ctx */
  constructor({ db, graph }) {
    this.db = db;
    this.graph = graph;
    /** @type {any[] | null} */
    this.rows = null;
  }

  markDirty() {
    this.rows = null;
  }

  /**
   * Distinct existing values for common fields, for the edit form's
   * select-or-type inputs. Cheap: reads the assembled index.
   * @returns {Record<string, string[]>}
   */
  fieldValues() {
    const rows = this.ensure();
    const pick = (get) => {
      const set = new Set();
      for (const r of rows) {
        const v = get(r);
        if (v) set.add(v);
      }
      return [...set].sort((a, b) => a.localeCompare(b)).slice(0, 500);
    };
    return {
      company: pick((r) => r.org),
      role: pick((r) => r.role),
      gender: pick((r) => r.gender),
      tags: [...new Set(rows.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b)).slice(0, 500),
    };
  }

  /** Assemble one row per live contact with everything the facets need. */
  assemble() {
    const db = this.db;
    const dormantCutoff = Date.now() - config.insights.dormantDays * 86400000;
    const degrees = this.graph.degreeCentrality();

    const tagsByContact = new Map();
    for (const r of db
      .prepare(
        `SELECT ct.contact_id AS id, group_concat(t.name, ' ') AS tags
           FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
          GROUP BY ct.contact_id`
      )
      .all()) {
      tagsByContact.set(r.id, r.tags ? r.tags.split(" ") : []);
    }

    const lastByContact = new Map();
    const interactionCount = new Map();
    for (const r of db.prepare("SELECT contact_id AS id, occurred_at AS at, kind, note FROM interactions ORDER BY occurred_at DESC").all()) {
      interactionCount.set(r.id, (interactionCount.get(r.id) ?? 0) + 1);
      if (!lastByContact.has(r.id)) lastByContact.set(r.id, r);
    }

    const edgeTypesByContact = new Map();
    for (const r of db
      .prepare(
        `SELECT c.id, e.type FROM contacts c
           JOIN edges e ON (e.source_id = c.id OR e.target_id = c.id)
           JOIN contacts o ON o.id = (CASE WHEN e.source_id = c.id THEN e.target_id ELSE e.source_id END)
                              AND o.deleted_at IS NULL
          WHERE c.deleted_at IS NULL
          GROUP BY c.id, e.type`
      )
      .all()) {
      if (!edgeTypesByContact.has(r.id)) edgeTypesByContact.set(r.id, new Set());
      edgeTypesByContact.get(r.id).add(r.type);
    }

    // A kin role is stored on the family edge, keyed by the contact id it
    // describes. Prefer the role on an edge to the owner (the most useful
    // egocentric reading), but fall back to any family edge so roles defined
    // between two other contacts do not disappear from Explore.
    const kinByContact = new Map();
    const ownerId = meta.getOwnerContactId(db);
    const kinPriority = new Map();
    const familyAdj = new Map();
    for (const r of db
      .prepare("SELECT source_id AS s, target_id AS t, metadata AS m FROM edges WHERE type='family'")
      .all()) {
      if (!familyAdj.has(r.s)) familyAdj.set(r.s, []);
      if (!familyAdj.has(r.t)) familyAdj.set(r.t, []);
      familyAdj.get(r.s).push(r.t); familyAdj.get(r.t).push(r.s);
      let kin;
      try { kin = JSON.parse(r.m).kin; } catch { kin = null; }
      if (!kin || typeof kin !== "object") continue;
      for (const [contactId, otherId] of [[r.s, r.t], [r.t, r.s]]) {
        if (contactId === ownerId || !kin[contactId]) continue;
        const priority = otherId === ownerId ? 1 : 0;
        if (!kinPriority.has(contactId) || priority > kinPriority.get(contactId)) {
          kinByContact.set(contactId, kin[contactId]);
          kinPriority.set(contactId, priority);
        }
      }
    }

    // Turn the undirected family graph into a stable, cycle-safe display tree.
    // The owner is the primary root; disconnected family components get their
    // own roots so no recorded family member disappears.
    const familyDepth = new Map(), familyParent = new Map();
    const walk = (root) => {
      const queue = [root];
      if (!familyDepth.has(root)) familyDepth.set(root, 0);
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        for (const next of familyAdj.get(id) ?? []) {
          if (familyDepth.has(next)) continue;
          familyDepth.set(next, familyDepth.get(id) + 1);
          familyParent.set(next, id);
          queue.push(next);
        }
      }
    };
    if (ownerId != null) walk(ownerId);
    for (const id of [...familyAdj.keys()].sort((a, b) => a - b)) if (!familyDepth.has(id)) walk(id);

    // A vendor is an organization in its own right (mirrors the Cluster view
    // and the graph snapshot): a business contact with no company field lists
    // under Organizations by its own name, and that org filter matches it.
    const businessTie = new Set();
    const personalTie = new Set();
    for (const r of db.prepare("SELECT source_id AS s, target_id AS t, type FROM edges").all()) {
      const bucket = BUSINESS_TYPES.has(r.type) ? businessTie : personalTie;
      bucket.add(r.s);
      bucket.add(r.t);
    }

    this.rows = db
      .prepare("SELECT id, name, fields, starred, cadence_days, created_at, updated_at FROM contacts WHERE deleted_at IS NULL")
      .all()
      .map((c) => {
        const f = c.fields ? JSON.parse(c.fields) : {};
        const business = isBusinessContact({
          flagged: /^(yes|true|1)$/i.test(String(f.business ?? "")),
          isOwner: c.id === ownerId,
          gender: f.gender,
          hasBusinessTie: businessTie.has(c.id),
          hasPersonalTie: personalTie.has(c.id),
        });
        let locationResolved = {};
        try { locationResolved = JSON.parse(f.locationResolved || "") || {}; } catch { /* legacy/malformed metadata */ }
        const locationParts = locationResolved.components || {};
        const degree = degrees[c.id] ?? 0;
        const last = lastByContact.get(c.id);
        const lastAt = last?.at ?? null;
        const overdue =
          c.cadence_days != null &&
          (lastAt == null || Date.now() - lastAt > c.cadence_days * 86400000);
        const dormant = degree > 0 && (lastAt == null || lastAt < dormantCutoff);
        return {
          id: c.id,
          name: c.name,
          org: f.company || (business ? c.name : ""),
          role: f.role ?? "",
          email: f.email ?? "",
          phone: f.phone ?? "",
          gender: f.gender ?? "",
          location: f.location || f.place || "",
          place: f.place ?? "",
          geo: f.geo ?? "",
          locationPrecision: f.locationPrecision ?? "",
          locationSource: f.locationSource ?? "",
          locationName: locationParts.name ?? "",
          houseNumber: locationParts.housenumber ?? "",
          street: locationParts.street ?? "",
          postcode: locationParts.postcode ?? "",
          district: locationParts.district ?? "",
          city: locationParts.city ?? "",
          county: locationParts.county ?? "",
          state: locationParts.state ?? "",
          country: locationParts.country ?? "",
          countryCode: locationParts.countrycode ?? "",
          osmType: locationResolved.osm?.type ?? "",
          osmId: locationResolved.osm?.id ?? null,
          kin: kinByContact.get(c.id) ?? "",
          notes: f.notes ?? "",
          address: f.address ?? "",
          birthday: f.birthday ?? "",
          nickname: f.nickname ?? "",
          deceased: /^(yes|true|1)$/i.test(f.deceased ?? ""),
          website: f.website ?? "",
          linkedin: f.linkedin ?? "",
          allFields: f, // for Find over custom keys
          createdAt: c.created_at,
          updatedAt: c.updated_at,
          tags: tagsByContact.get(c.id) ?? [],
          edgeTypes: edgeTypesByContact.get(c.id) ?? new Set(),
          degree,
          lastAt,
          starred: !!c.starred,
          cadenceDays: c.cadence_days ?? null,
          lastKind: last?.kind ?? "",
          lastNote: last?.note ?? "",
          interactionCount: interactionCount.get(c.id) ?? 0,
          isOwner: c.id === ownerId,
          isFamily: c.id === ownerId || familyAdj.has(c.id),
          familyDepth: familyDepth.get(c.id) ?? 0,
          familyParentId: familyParent.get(c.id) ?? null,
          overdue,
          dormant,
          hay:
            `${c.name} ${f.company ?? ""} ${f.role ?? ""} ${f.email ?? ""} ${f.phone ?? ""} ${f.notes ?? ""} ${(tagsByContact.get(c.id) ?? []).join(" ")}`.toLowerCase(),
        };
      });
    return this.rows;
  }

  ensure() {
    if (!this.rows) this.assemble();
    return this.rows;
  }

  degreeBucketKey(degree) {
    for (const [key, , min, max] of config.explore.degreeBuckets) {
      if (degree >= min && degree <= max) return key;
    }
    return null;
  }

  /**
   * @param {{ text?: string, filters?: any, sort?: string, dir?: string, limit?: number, scope?: "all"|"family"|"friends" }} params
   * @returns {import('../../shared/types').ExploreResponse}
   */
  query({ text = "", filters = {}, sort = "name", dir, limit = config.explore.resultLimit, scope = "all" } = {}) {
    const rows = this.ensure();

    // The query bar and facets share state: operators in the text merge into
    // filters so typing `org:acme` behaves exactly like clicking the facet.
    const parsed = parseQuery(text || "");
    const orgs = new Set([...(filters.orgs ?? []), ...(parsed.filters.org ? [parsed.filters.org] : [])].map(lc));
    const tags = new Set([...(filters.tags ?? []), ...parsed.filters.tags].map(lc));
    const edgeTypes = new Set([...(filters.edgeTypes ?? []), ...(parsed.filters.edgeType ? [parsed.filters.edgeType] : [])].map(lc));
    const status = new Set((filters.status ?? []).filter((s) => STATUS_KEYS.includes(s)));
    if (parsed.filters.hasEmail) status.add("hasEmail");
    const degreeBuckets = new Set(filters.degreeBuckets ?? []);
    const tokens = parsed.tokens;

    // Graph-aware near:/hops: - restrict to a BFS neighborhood from the anchor.
    let nearIds = null;
    if (parsed.filters.near) {
      const anchor = rows.find((r) => r.name.toLowerCase() === parsed.filters.near);
      nearIds = anchor ? this.neighborhood(anchor.id, parsed.filters.hops) : new Set();
    }

    // Per-facet predicates; each result must satisfy all groups.
    const preds = {
      text: (r) => tokens.every((t) => r.hay.includes(t)),
      near: (r) => (nearIds ? nearIds.has(r.id) : true),
      orgs: (r) => (orgs.size ? orgs.has(r.org.toLowerCase()) : true),
      tags: (r) => (tags.size ? [...tags].some((t) => r.tags.map(lc).includes(t)) : true),
      edgeTypes: (r) => (edgeTypes.size ? [...edgeTypes].some((t) => r.edgeTypes.has(t)) : true),
      status: (r) =>
        !status.size ||
        [...status].some((s) =>
          s === "hasEmail" ? !!r.email : s === "hasPhone" ? !!r.phone : r[s]
        ),
      degreeBuckets: (r) => (degreeBuckets.size ? degreeBuckets.has(this.degreeBucketKey(r.degree)) : true),
      scope: (r) => scope === "family" ? r.isFamily : scope === "friends" ? r.edgeTypes.has("friend") : true,
    };
    const groups = Object.keys(preds);
    const passesAllExcept = (r, skip) => groups.every((g) => g === skip || preds[g](r));
    const passesAll = (r) => groups.every((g) => preds[g](r));

    const matched = rows.filter(passesAll);

    // Facet counts: computed against all OTHER groups (so the facet's own
    // selection doesn't hide its siblings). Standard faceted-search behavior.
    const facets = {
      status: this.countStatus(rows, (r) => passesAllExcept(r, "status")),
      orgs: this.countTop(rows, (r) => passesAllExcept(r, "orgs"), (r) => (r.org ? [r.org] : [])),
      tags: this.countTop(rows, (r) => passesAllExcept(r, "tags"), (r) => r.tags),
      edgeTypes: this.countValues(
        rows, (r) => passesAllExcept(r, "edgeTypes"),
        (r) => [...r.edgeTypes], RELATIONSHIP_TYPES
      ),
      degrees: this.countDegrees(rows, (r) => passesAllExcept(r, "degreeBuckets")),
    };

    const sorted = this.sortRows(matched, sort, dir);
    const results = sorted.slice(0, limit).map((r) => this.toResult(r));

    return {
      total: matched.length,
      results,
      // Ids of the full matched set (capped generously) so the UI can drive the
      // graph / bulk actions over everything, not just the visible page.
      matchedIds: matched.slice(0, 20000).map((r) => r.id),
      facets,
    };
  }

  /** Shared row -> ExploreRow shape for both Explore and Find results. */
  toResult(r) {
    return {
      id: r.id, name: r.name, org: r.org || undefined, role: r.role || undefined,
      email: r.email || undefined, phone: r.phone || undefined, types: [...r.edgeTypes],
      gender: r.gender || undefined, location: r.location || undefined, kin: r.kin || undefined,
      degree: r.degree, lastAt: r.lastAt, starred: r.starred, overdue: r.overdue,
      cadenceDays: r.cadenceDays, tags: r.tags, notes: r.notes || undefined,
      address: r.address || undefined, birthday: r.birthday || undefined,
      nickname: r.nickname || undefined, deceased: r.deceased,
      website: r.website || undefined, linkedin: r.linkedin || undefined,
      place: r.place || undefined, geo: r.geo || undefined,
      locationPrecision: r.locationPrecision || undefined, locationSource: r.locationSource || undefined,
      locationName: r.locationName || undefined, houseNumber: r.houseNumber || undefined,
      street: r.street || undefined, postcode: r.postcode || undefined,
      district: r.district || undefined, city: r.city || undefined, county: r.county || undefined,
      state: r.state || undefined, country: r.country || undefined, countryCode: r.countryCode || undefined,
      osmType: r.osmType || undefined, osmId: r.osmId ?? undefined,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
      lastKind: r.lastKind || undefined, lastNote: r.lastNote || undefined,
      interactionCount: r.interactionCount, isOwner: r.isOwner,
      familyDepth: r.familyDepth, familyParentId: r.familyParentId,
      dormant: r.dormant,
    };
  }

  // ---- Find: structured query builder ----------------------------------
  fieldValue(r, field) {
    switch (field) {
      case "name": return r.name;
      case "company": case "org": return r.org;
      case "role": return r.role;
      case "email": return r.email;
      case "phone": return r.phone;
      case "gender": return r.gender;
      case "notes": return r.notes;
      case "tags": return r.tags;
      case "edgeType": return [...r.edgeTypes];
      case "degree": return r.degree;
      case "lastAt": return r.lastAt;
      case "cadenceDays": return r.cadenceDays;
      case "starred": return r.starred;
      case "overdue": return r.overdue;
      case "dormant": return r.dormant;
      default: return r.allFields?.[field] ?? "";
    }
  }

  conditionPred({ field, op, value }) {
    const get = (r) => this.fieldValue(r, field);
    const s = (x) => String(x ?? "").toLowerCase();
    const asList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map(s);
    switch (op) {
      case "contains": return (r) => s(get(r)).includes(s(value));
      case "notContains": return (r) => !s(get(r)).includes(s(value));
      case "equals": return (r) => s(get(r)) === s(value);
      case "startsWith": return (r) => s(get(r)).startsWith(s(value));
      case "isEmpty": return (r) => { const v = get(r); return Array.isArray(v) ? v.length === 0 : !v; };
      case "isNotEmpty": return (r) => { const v = get(r); return Array.isArray(v) ? v.length > 0 : !!v; };
      case "eq": return (r) => Number(get(r)) === Number(value);
      case "gt": return (r) => Number(get(r)) > Number(value);
      case "lt": return (r) => Number(get(r)) < Number(value);
      case "gte": return (r) => Number(get(r)) >= Number(value);
      case "lte": return (r) => Number(get(r)) <= Number(value);
      case "between": return (r) => { const n = Number(get(r)); return n >= Number(value?.[0]) && n <= Number(value?.[1]); };
      case "withinDays": return (r) => { const t = get(r); return t != null && Date.now() - t <= Number(value) * 86400000; };
      case "olderThanDays": return (r) => { const t = get(r); return t == null || Date.now() - t > Number(value) * 86400000; };
      case "never": return (r) => get(r) == null;
      case "includes": return (r) => asList(get(r)).includes(s(value));
      case "excludes": return (r) => !asList(get(r)).includes(s(value));
      case "isTrue": return (r) => !!get(r);
      case "isFalse": return (r) => !get(r);
      default: return () => true;
    }
  }

  /**
   * @param {{ match?: "all"|"any", conditions?: any[], sort?: string, dir?: string, limit?: number }} q
   * @returns {import('../../shared/types').ExploreResponse}
   */
  find({ match = "all", conditions = [], sort = "name", dir, limit = config.explore.resultLimit } = {}) {
    const rows = this.ensure();
    let matched;
    if (!conditions.length) {
      matched = rows;
    } else {
      const preds = conditions.map((c) => this.conditionPred(c));
      const test = match === "any" ? (r) => preds.some((p) => p(r)) : (r) => preds.every((p) => p(r));
      matched = rows.filter(test);
    }
    const sorted = this.sortRows(matched, sort, dir);
    return {
      total: matched.length,
      results: sorted.slice(0, limit).map((r) => this.toResult(r)),
      matchedIds: matched.slice(0, 20000).map((r) => r.id),
      facets: { status: [], orgs: [], tags: [], edgeTypes: [], degrees: [] },
    };
  }

  // ---- Insights: distributions + a generic breakdown -------------------
  breakdown(dimension) {
    const rows = this.ensure();
    const counts = new Map();
    let unset = 0;
    for (const r of rows) {
      let vals;
      switch (dimension) {
        case "org": vals = r.org ? [r.org] : []; break;
        case "role": vals = r.role ? [r.role] : []; break;
        case "gender": vals = r.gender ? [r.gender] : []; break;
        case "tags": vals = r.tags; break;
        case "edgeType": vals = [...r.edgeTypes]; break;
        case "cadence": vals = r.cadenceDays ? [`every ${r.cadenceDays}d`] : []; break;
        default: vals = [];
      }
      if (!vals.length) unset++;
      else for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const values = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, 50);
    return { dimension, values, unset, total: rows.length };
  }

  extendedInsights() {
    const rows = this.ensure();
    const I = config.insights;
    const top = (dim, n) => this.breakdown(dim).values.slice(0, n);

    const overdue = rows.filter((r) => r.overdue)
      .map((r) => ({ id: r.id, name: r.name, cadenceDays: r.cadenceDays, lastAt: r.lastAt,
        overdueDays: Math.floor((Date.now() - ((r.lastAt ?? 0) + r.cadenceDays * 86400000)) / 86400000) }))
      .sort((a, b) => b.overdueDays - a.overdueDays).slice(0, I.overdueLimit);
    const dormant = rows.filter((r) => r.dormant)
      .map((r) => ({ id: r.id, name: r.name, degree: r.degree, lastAt: r.lastAt }))
      .sort((a, b) => b.degree - a.degree).slice(0, I.dormantLimit);
    const connectors = [...rows].sort((a, b) => b.degree - a.degree)
      .slice(0, I.connectorsLimit).map((r) => ({ id: r.id, name: r.name, degree: r.degree }));

    const withCadence = rows.filter((r) => r.cadenceDays != null).length;
    const isolated = rows.filter((r) => r.degree === 0).length;
    const hubs = rows.filter((r) => r.degree >= 20).length;
    const avgDegree = rows.length ? rows.reduce((s, r) => s + r.degree, 0) / rows.length : 0;
    const missingEmail = rows.filter((r) => !r.email).length;
    const missingPhone = rows.filter((r) => !r.phone).length;
    const recentlyAdded = [...rows].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 5).map((r) => ({ id: r.id, name: r.name, org: r.org || undefined, createdAt: r.createdAt }));

    return {
      contacts: rows.length,
      edges: this.graph.size,
      connectors, overdue, dormant, recentlyAdded,
      orgs: top("org", I.orgsLimit),
      roles: top("role", 8),
      gender: top("gender", 5),
      tags: top("tags", 12),
      edgeTypes: this.breakdown("edgeType").values,
      cadence: { withCadence, overdue: overdue.length, total: rows.length },
      connectivity: { isolated, hubs, avgDegree: Math.round(avgDegree * 10) / 10 },
      missing: { email: missingEmail, phone: missingPhone },
    };
  }

  neighborhood(startId, hops) {
    const seen = new Set([startId]);
    let frontier = [startId];
    for (let d = 0; d < hops && frontier.length; d++) {
      const next = [];
      for (const n of frontier) {
        if (!this.graph.hasNode(n)) continue;
        this.graph.graph.forEachNeighbor(String(n), (nb) => {
          const id = Number(nb);
          if (!seen.has(id)) { seen.add(id); next.push(id); }
        });
      }
      frontier = next;
    }
    return seen;
  }

  countStatus(rows, pass) {
    const counts = { starred: 0, overdue: 0, dormant: 0, hasEmail: 0, hasPhone: 0 };
    for (const r of rows) {
      if (!pass(r)) continue;
      if (r.starred) counts.starred++;
      if (r.overdue) counts.overdue++;
      if (r.dormant) counts.dormant++;
      if (r.email) counts.hasEmail++;
      if (r.phone) counts.hasPhone++;
    }
    return STATUS_KEYS.map((key) => ({ value: key, count: counts[key] }));
  }

  countTop(rows, pass, valuesOf) {
    const counts = new Map();
    for (const r of rows) {
      if (!pass(r)) continue;
      for (const v of valuesOf(r)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, config.explore.facetTopN);
  }

  countValues(rows, pass, valuesOf, universe) {
    const counts = new Map(universe.map((v) => [v, 0]));
    for (const r of rows) {
      if (!pass(r)) continue;
      for (const v of valuesOf(r)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return universe.map((value) => ({ value, count: counts.get(value) ?? 0 }));
  }

  countDegrees(rows, pass) {
    const counts = new Map(config.explore.degreeBuckets.map(([k]) => [k, 0]));
    for (const r of rows) {
      if (!pass(r)) continue;
      const k = this.degreeBucketKey(r.degree);
      if (k) counts.set(k, counts.get(k) + 1);
    }
    return config.explore.degreeBuckets.map(([value, label]) => ({
      value: String(value), label: String(label), count: counts.get(value),
    }));
  }

  sortRows(rows, sort, dir) {
    const value = {
      name: (r) => r.name,
      nickname: (r) => r.nickname,
      gender: (r) => r.gender,
      birthday: (r) => r.birthday,
      deceased: (r) => r.deceased,
      email: (r) => r.email,
      phone: (r) => r.phone,
      org: (r) => r.org,
      role: (r) => r.role,
      location: (r) => r.location,
      city: (r) => r.city,
      county: (r) => r.county,
      state: (r) => r.state,
      postcode: (r) => r.postcode,
      country: (r) => r.country,
      relationship: (r) => [...r.edgeTypes].sort().join(", "),
      kin: (r) => r.kin,
      degree: (r) => r.degree,
      tags: (r) => [...r.tags].sort().join(", "),
      notes: (r) => r.notes,
      recent: (r) => r.lastAt,
      overdue: (r) => r.overdue ? overdueDays(r) : null,
      lastKind: (r) => r.lastKind,
      lastNote: (r) => r.lastNote,
      interactionCount: (r) => r.interactionCount,
      cadenceDays: (r) => r.cadenceDays,
      starred: (r) => r.starred,
      website: (r) => r.website,
      linkedin: (r) => r.linkedin,
      id: (r) => r.id,
      createdAt: (r) => r.createdAt,
      updatedAt: (r) => r.updatedAt,
    };
    const get = value[sort] ?? value.name;
    const direction = dir ?? (DESC_SORTS.has(sort) ? "desc" : "asc");
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const missing = (v) => v == null || v === "";
    return [...rows].sort((a, b) => {
      const av = get(a), bv = get(b);
      if (missing(av) !== missing(bv)) return missing(av) ? 1 : -1; // blanks stay last in both directions
      let compared = 0;
      if (!missing(av)) {
        compared = typeof av === "number" || typeof av === "boolean"
          ? Number(av) - Number(bv)
          : collator.compare(String(av), String(bv));
        if (direction === "desc") compared *= -1;
      }
      return compared || collator.compare(a.name, b.name) || a.id - b.id;
    });
  }
}

const lc = (s) => String(s).toLowerCase();
const overdueDays = (r) => {
  if (!r.overdue) return -1;
  const dueAt = (r.lastAt ?? 0) + r.cadenceDays * 86400000;
  return (Date.now() - dueAt) / 86400000;
};

exports.ExploreService = ExploreService;
exports.STATUS_KEYS = STATUS_KEYS;
exports.EXPLORE_SORT_KEYS = EXPLORE_SORT_KEYS;
