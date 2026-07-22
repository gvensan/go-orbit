// betweenness-worker.js - betweenness centrality is O(V·E): worker-only,
// on-demand, cached by the service (guardrail: never the main thread).
// Opens its own read-only keyed connection, builds the live graph, computes,
// posts the result once, exits.

const { parentPort, workerData } = require("worker_threads");
const Database = require("better-sqlite3-multiple-ciphers");
const Graph = /** @type {typeof import("graphology").default} */ (
  /** @type {unknown} */ (require("graphology"))
);
const betweennessCentrality = /** @type {any} */ (require("graphology-metrics/centrality/betweenness"));

const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
db.pragma(`key = '${String(workerData.key).replace(/'/g, "''")}'`);

const graph = new Graph({ multi: true, type: "undirected" });
for (const c of /** @type {Iterable<any>} */ (
  db.prepare("SELECT id FROM contacts WHERE deleted_at IS NULL").iterate()
)) {
  graph.addNode(c.id);
}
const edges = /** @type {Iterable<any>} */ (db.prepare(
  `SELECT e.source_id AS s, e.target_id AS t
     FROM edges e
     JOIN contacts a ON a.id = e.source_id AND a.deleted_at IS NULL
     JOIN contacts b ON b.id = e.target_id AND b.deleted_at IS NULL`
).iterate());
for (const e of edges) {
  if (graph.hasNode(e.s) && graph.hasNode(e.t)) graph.addEdge(e.s, e.t);
}
db.close();

const raw = betweennessCentrality(graph, { normalized: true });
const values = {};
for (const [id, v] of Object.entries(raw)) values[Number(id)] = v;
parentPort.postMessage({ values });
