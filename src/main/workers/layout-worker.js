// layout-worker.js - full-graph ForceAtlas2 on a worker thread (guardrail:
// layout never runs on the main thread). Receives the node/edge arrays via
// workerData, streams { type: "tick", positions } chunks, ends with
// { type: "done", positions } for persistence.

const { parentPort, workerData } = require("worker_threads");
const Graph = /** @type {typeof import("graphology").default} */ (
  /** @type {unknown} */ (require("graphology"))
);
const forceAtlas2 = /** @type {any} */ (require("graphology-layout-forceatlas2"));

const { nodes, edges, iterations, chunkIterations } = workerData;

const graph = new Graph({ multi: true, type: "undirected" });
for (const n of nodes) graph.addNode(n.id, { x: n.x, y: n.y, size: n.size });
for (const e of edges) {
  if (graph.hasNode(e.source) && graph.hasNode(e.target)) graph.addEdge(e.source, e.target);
}

// Collision-aware spacing is important here because these settled positions
// are persisted and become the default full-network presentation.
const settings = { ...forceAtlas2.inferSettings(graph), adjustSizes: true };
const collect = () => {
  const positions = {};
  graph.forEachNode((id, attrs) => {
    positions[id] = { x: attrs.x, y: attrs.y };
  });
  return positions;
};

for (let done = 0; done < iterations; done += chunkIterations) {
  forceAtlas2.assign(graph, { iterations: chunkIterations, settings });
  parentPort.postMessage({ type: "tick", positions: collect() });
}
parentPort.postMessage({ type: "done", positions: collect() });
