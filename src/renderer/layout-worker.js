// layout-worker.js - ForceAtlas2 in a renderer web worker (guardrail: layout
// never runs on a UI or main thread). Vite bundles this as its own same-origin
// chunk, so the strict CSP (script-src 'self') holds - no blob: workers.
//
// Protocol: receives { nodes: [{id,x,y,size}], edges: [{source,target}] },
// streams { type: "tick", positions } every chunk, ends with { type: "done" }.

import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";

const CHUNK_ITERATIONS = 30;
const TOTAL_ITERATIONS = 420;

self.onmessage = (e) => {
  const { nodes, edges } = e.data;
  const graph = new Graph({ multi: true, type: "undirected" });
  for (const n of nodes) graph.addNode(n.id, { x: n.x, y: n.y, size: n.size });
  for (const l of edges) {
    if (graph.hasNode(l.source) && graph.hasNode(l.target)) {
      graph.addEdge(l.source, l.target);
    }
  }

  // Tidier layout: LinLog pulls tightly-connected groups into compact clumps and
  // pushes unrelated ones apart (less spaghetti); gravity keeps peripheral and
  // disconnected nodes from drifting off; outbound-attraction gives hubs room;
  // adjustSizes respects rendered node radii so contacts don't overlap.
  const settings = {
    ...forceAtlas2.inferSettings(graph),
    adjustSizes: true,
    linLogMode: true,
    outboundAttractionDistribution: true,
    gravity: 1.2,
    scalingRatio: 12,
  };
  for (let done = 0; done < TOTAL_ITERATIONS; done += CHUNK_ITERATIONS) {
    forceAtlas2.assign(graph, { iterations: CHUNK_ITERATIONS, settings });
    const positions = {};
    graph.forEachNode((id, attrs) => {
      positions[id] = { x: attrs.x, y: attrs.y };
    });
    self.postMessage({ type: "tick", positions });
  }
  self.postMessage({ type: "done" });
};
