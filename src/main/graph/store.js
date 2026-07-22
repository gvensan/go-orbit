// graph/store.js - the in-memory graphology model, hydrated from SQLite and
// kept in sync by the IPC write handlers. Serves the cheap graph queries
// (snapshot, ego BFS, shortest path, degree). Betweenness is worker-only and
// does not belong here.

const Graph = /** @type {typeof import("graphology").default} */ (
  /** @type {unknown} */ (require("graphology"))
);
const { bidirectional } = require("graphology-shortest-path");
const { AppError } = require("../ipc/errors");

const edgeKey = (s, t, type) => `${s}|${t}|${type}`;

/** Pull just the coarse locality (city, state, country) from a contact's fields.
 *  Geocoded contacts store their address parts inside `locationResolved`
 *  ({ v, components: { city, state, country, ... } }), not as flat fields - so
 *  a tooltip can show "Bengaluru, Karnataka, India" instead of the full address.
 *  Falls back to any flat fields, then to nothing.
 *  @returns {{ city?: string, state?: string, country?: string }} */
function localityOf(f) {
  let comp = {};
  if (f.locationResolved) {
    try { comp = JSON.parse(f.locationResolved).components || {}; } catch { comp = {}; }
  }
  return {
    city: comp.city || comp.district || comp.county || f.city,
    state: comp.state || f.state,
    country: comp.country || f.country,
  };
}

class GraphStore {
  constructor() {
    this.graph = new Graph({ multi: true, type: "mixed" });
  }

  /** Rebuild from scratch: live contacts, edges with both endpoints live. */
  hydrate(db) {
    this.graph.clear();
    const contacts = db
      .prepare("SELECT id, name, fields, starred FROM contacts WHERE deleted_at IS NULL")
      .iterate();
    for (const c of contacts) {
      const f = c.fields ? JSON.parse(c.fields) : {};
      this.graph.addNode(c.id, {
        name: c.name, org: f.company, role: f.role, gender: f.gender, location: f.location, place: f.place, ...localityOf(f), geo: f.geo, locationPrecision: f.locationPrecision, locationSource: f.locationSource, deceased: !!f.deceased, starred: !!c.starred,
      });
    }
    // Tag the owner ("you") node so the renderer can mark it and centre Home on it.
    const ownerRow = db.prepare("SELECT value FROM app_meta WHERE key = 'owner.contactId'").get();
    const ownerId = ownerRow ? Number(ownerRow.value) : null;
    if (ownerId != null && this.graph.hasNode(ownerId)) {
      this.graph.setNodeAttribute(ownerId, "isOwner", true);
    }
    const edges = db
      .prepare(
        `SELECT e.source_id, e.target_id, e.type, e.directed, e.metadata
           FROM edges e
           JOIN contacts s ON s.id = e.source_id AND s.deleted_at IS NULL
           JOIN contacts t ON t.id = e.target_id AND t.deleted_at IS NULL`
      )
      .iterate();
    for (const e of edges) {
      this.addEdge({ sourceId: e.source_id, targetId: e.target_id, type: e.type, directed: !!e.directed, metadata: e.metadata });
    }
    return this;
  }

  get order() { return this.graph.order; }
  get size() { return this.graph.size; }

  hasNode(id) { return this.graph.hasNode(id); }

  addContact(contact) {
    if (this.graph.hasNode(contact.id)) return;
    const f = contact.fields || {};
    this.graph.addNode(contact.id, {
      name: contact.name, org: f.company, role: f.role, gender: f.gender, location: f.location, place: f.place, ...localityOf(f), geo: f.geo, locationPrecision: f.locationPrecision, locationSource: f.locationSource, deceased: !!f.deceased, starred: !!contact.starred,
    });
  }

  updateContact(contact) {
    if (!this.graph.hasNode(contact.id)) return;
    const f = contact.fields || {};
    this.graph.mergeNodeAttributes(contact.id, {
      name: contact.name, org: f.company, role: f.role, gender: f.gender, location: f.location, place: f.place, ...localityOf(f), geo: f.geo, locationPrecision: f.locationPrecision, locationSource: f.locationSource, deceased: !!f.deceased, starred: !!contact.starred,
    });
  }

  /** dropNode also drops incident edges, which is what soft-delete needs. */
  removeContact(id) {
    if (this.graph.hasNode(id)) this.graph.dropNode(id);
  }

  addEdge({ sourceId, targetId, type, directed, metadata }) {
    const key = edgeKey(sourceId, targetId, type);
    if (this.graph.hasEdge(key)) return;
    // metadata arrives as a JSON string from the DB or a parsed object from IPC.
    const meta = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    if (directed) {
      this.graph.addDirectedEdgeWithKey(key, sourceId, targetId, { type, directed: true, metadata: meta });
    } else {
      this.graph.addUndirectedEdgeWithKey(key, sourceId, targetId, { type, directed: false, metadata: meta });
    }
  }

  removeEdge({ sourceId, targetId, type }) {
    const key = edgeKey(sourceId, targetId, type);
    if (this.graph.hasEdge(key)) this.graph.dropEdge(key);
  }

  /** @returns {import('../../shared/types').GraphSnapshot} */
  snapshot() {
    const nodes = [];
    this.graph.forEachNode((id, attrs) => {
      nodes.push({
        id: Number(id),
        name: attrs.name,
        org: attrs.org,
        role: attrs.role,
        gender: attrs.gender,
        location: attrs.location,
        place: attrs.place,
        city: attrs.city,
        state: attrs.state,
        country: attrs.country,
        geo: attrs.geo,
        locationPrecision: attrs.locationPrecision,
        locationSource: attrs.locationSource,
        deceased: !!attrs.deceased,
        starred: attrs.starred,
        isOwner: !!attrs.isOwner,
        degree: this.graph.degree(id),
      });
    });
    const links = [];
    this.graph.forEachEdge((_key, attrs, source, target) => {
      links.push({
        source: Number(source),
        target: Number(target),
        type: attrs.type,
        directed: !!attrs.directed,
        metadata: attrs.metadata || undefined,
      });
    });
    return { nodes, links };
  }

  /** BFS to `depth` hops; includes the center. @returns {number[]} */
  ego(contactId, depth) {
    if (!this.graph.hasNode(contactId)) {
      throw new AppError("NOT_FOUND", `No live contact with id ${contactId} in the graph.`);
    }
    const seen = new Set([String(contactId)]);
    let frontier = [String(contactId)];
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next = [];
      for (const n of frontier) {
        this.graph.forEachNeighbor(n, (nb) => {
          if (!seen.has(nb)) {
            seen.add(nb);
            next.push(nb);
          }
        });
      }
      frontier = next;
    }
    return [...seen].map(Number);
  }

  /** @returns {import('../../shared/types').PathResult} */
  path(fromId, toId) {
    for (const id of [fromId, toId]) {
      if (!this.graph.hasNode(id)) {
        throw new AppError("NOT_FOUND", `No live contact with id ${id} in the graph.`);
      }
    }
    const p = bidirectional(this.graph, String(fromId), String(toId));
    if (!p) return { path: [], hops: 0, found: false };
    return { path: p.map(Number), hops: p.length - 1, found: true };
  }

  /** @returns {Record<number, number>} */
  degreeCentrality() {
    const out = /** @type {Record<number, number>} */ ({});
    this.graph.forEachNode((id) => {
      out[Number(id)] = this.graph.degree(id);
    });
    return out;
  }
}

exports.GraphStore = GraphStore;
