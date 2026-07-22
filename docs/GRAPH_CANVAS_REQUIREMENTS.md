# Graph & Canvas Rendering — Requirements & Build Handoff

**Component:** Orbit (Electron desktop CRM with connection graphs)
**Feature:** Interactive relationship-graph visualization and canvas
**Status:** Ready for implementation
**Audience:** Claude Code
**Scale target:** 20,000 nodes, ~200,000 edges, single-device

---

## 1. Goal

The connection graph is the product's centerpiece, not a decoration. It must render a 20k-node / 200k-edge relationship network at interactive framerate, let the user move through it fluidly, and turn the graph structure into answers: who connects to whom, how the user knows someone, who the connectors are, which clusters exist. Rendering is a means; the goal is a graph a user can *think with*.

Success is three properties: **fast** (≥30 fps pan/zoom at full scale, layout off the main thread), **legible** (the default view is a meaningful subgraph, not a 20k hairball — node size and color encode real signal), and **answerable** (shortest-path, centrality, ego-network, and clustering are one interaction away).

## 2. Intent

Default to focused, filtered views — ego-networks, clusters, search results — with the full graph always reachable. A user rarely wants all 20k nodes on screen at once; they want *this person's world*, or *everyone at Globex two hops out*. The renderer must be capable of the full graph, but the UX is built around meaningful subviews. Node size encodes centrality so hubs are visible at a glance; edge color encodes relationship type; focusing a node reveals its constellation and dims the rest.

## 3. Scope & non-goals

**In scope:** WebGL graph rendering at scale; pan/zoom/fit; node drag; hover and selection; ego-network focus; typed/colored edges with legend; centrality-scaled nodes; graph analytics (shortest path, degrees of separation, centrality, community detection); filtering; responsive desktop reflow; high-DPI correctness; integration with the search subsystem.

**Out of scope (v1):** 3D rendering, geographic/map overlays, real-time collaborative cursors, server-side layout. Edge bundling and timeline scrubbing are listed as Nice-to-have.

## 4. Architecture context (already decided)

Do not re-decide these; the renderer plugs into them:

- **Runtime:** Electron, single-device, offline. `contextIsolation` on, sandboxed renderer, validated IPC. No remote content or tiles.
- **Graph model:** `graphology` is the authoritative in-memory graph, built from the `contacts`/`edges` tables. The renderer consumes this model directly.
- **Store:** SQLite/SQLCipher. `nodes`/`links` hydrate from `contacts`/`edges` with an identical shape to the model — hydration source changes, downstream render code does not.
- **Search:** the search subsystem (separate spec) selects nodes; graph focus is driven by search results and vice-versa.

## 5. Rendering stack

**Renderer: sigma.js v3 (WebGL) over graphology.** This is the decisive choice and it follows from scale. SVG and Canvas-2D (e.g. Cytoscape.js) are smooth to a few thousand nodes and stutter well before 20k; the SVG/d3-force demo built earlier is a throwaway prototype, not the production path. sigma.js renders in WebGL, targets tens of thousands of nodes, and pairs natively with graphology — which the app already uses as its model — so there is no second graph representation to keep in sync.

- **Layout:** ForceAtlas2 via `graphology-layout-forceatlas2`, run in a **worker** (its supervisor mode streams positions). Layout never runs on the render or main thread. Progressive: stream positions as they settle, then freeze.
- **Level of detail:** cull off-viewport nodes/edges; render labels only above a zoom threshold or for high-degree nodes, to avoid a label storm at full scale.
- **High-DPI:** sigma handles `devicePixelRatio`; any custom canvas must scale its backing store by `dpr` or it renders blurry on Retina/4K.
- **Incremental updates:** adding or removing a contact mutates the graphology instance and updates sigma in place — pin existing positions, lay out only the new node locally. No full relayout, no visual jump.

**Where analytics run.** Degree centrality is trivial and precomputed. Betweenness centrality on 20k/200k is O(V·E) — compute it in a **worker, on demand, and cache it**; never on the main thread. Document this so it isn't naively called inline.

**Recommended dependencies:** `sigma`, `graphology`, `graphology-layout-forceatlas2`, `graphology-metrics`, `graphology-shortest-path`, `graphology-communities-louvain`.

## 6. Data model / hydration

The renderer builds its graphology instance from IPC-delivered `nodes`/`links` matching the SQLite shape:

- **Node:** `{ id, name, org, role, degree, x?, y? }` — `degree` drives size, `org`/community drives color, `x/y` from cached or worker-computed layout.
- **Edge:** `{ source, target, type, directed }` — `type` drives color and legend.

Soft-deleted contacts (`deleted_at`) are excluded from hydration. Persist computed layout positions so reopening the app doesn't recompute from scratch.

## 7. Feature requirements

### Must-have

| Feature | Detail |
|---|---|
| WebGL render at scale | 20k nodes / 200k edges without collapse; LOD + viewport culling |
| Meaningful default view | Opens on a focused/filtered subgraph, not the full hairball |
| Pan / zoom / fit | Wheel + controls; reset and fit-to-view; smooth at scale |
| Node drag | Reposition a node; pin/unpin |
| Node size = centrality | Degree-scaled radius so hubs are visible |
| Typed edges + legend | Edge color by relationship type; readable legend |
| Node color by group | Org / cluster color encoding |
| Hover | Highlight node, show label + lightweight tooltip |
| Click-to-focus ego-network | Select a node → highlight it + neighbors, dim the rest, side panel of connections |
| High-DPI correctness | Crisp on Retina/4K; backing store scaled by devicePixelRatio |
| Off-thread layout | Force layout in a worker; UI stays responsive during settle |

### Need-to-have

| Feature | Detail |
|---|---|
| Shortest path | "How do I know X" — highlighted path between two selected nodes |
| Degrees of separation | Hop distance between any two contacts |
| Centrality metrics | Degree (live) and betweenness (worker, on-demand, cached) |
| Ego-network depth N | Expand a focus to N hops interactively |
| Community detection | Louvain clustering with cluster coloring and optional cluster layout |
| Filtering / facets | By edge type, tag, org, degree threshold — mirrors search operators |
| Search ↔ graph integration | Search result focuses its ego-network; graph selection can seed a search; matches highlighted |
| Responsive reflow | On resize keep node sizes constant and expand/refit bounds — never uniform-scale zoom |
| Incremental update | Add/remove/edit a contact updates the graph in place, no full relayout |

### Nice-to-have

| Feature | Detail |
|---|---|
| Minimap / overview | Overview pane with viewport indicator |
| Export | PNG / SVG snapshot, GraphML for the network |
| Saved / pinned layouts | Persist manual arrangements per view |
| Path animation | Animate traversal along a shortest path |
| Signal overlays | Heatmap by centrality, recency, or unread |
| Edge bundling | Reduce clutter in dense regions |
| Timeline scrubbing | Show how the network grew over time |

## 8. Interaction spec

- **Zoom** on wheel toward the cursor; **pan** on background drag; **fit-to-view** and **reset** as explicit controls.
- **Hover** highlights the node and shows its label + minimal context; **click** selects and enters ego-focus (neighbors highlighted, everyone else dimmed, side panel lists connections sorted by their own degree).
- **Two-node selection** offers shortest-path highlight and hop count.
- **Filters** apply live; hidden elements fade rather than pop.
- **Keyboard:** focus navigation, escape to clear selection, arrow-driven neighbor stepping where feasible.
- Selecting a search result animates a focus+zoom to that node's ego-network.

## 9. Performance targets

- Pan/zoom: **≥30 fps** (target 60) with 20k/200k in the scene; typical filtered views far lighter.
- Initial full-graph layout: settles in a few seconds in a worker, positions streamed progressively; ego/filtered subgraphs are effectively instant.
- Incremental node update: imperceptible, no full relayout.
- Betweenness centrality: computed off-thread, cached, never blocking interaction.
- Label rendering gated by LOD so text never becomes the bottleneck.

## 10. Rendering quality

- Sharp on high-DPI displays (backing store × devicePixelRatio).
- Anti-aliased nodes and edges; label collision avoidance at readable zoom.
- Distinct, colorblind-considerate palettes for edge types and clusters.
- Stable frame pacing — prefer consistent 30 fps over stuttering 60.

## 11. Security & privacy

- All rendering and analytics are local; no remote assets, tiles, or fonts fetched at runtime.
- Graph data crosses the IPC boundary through a validated bridge only.
- Exports are user-initiated and written to a user-chosen path.

## 12. Acceptance criteria

Each must pass as an automated or scripted test:

1. **Scale:** a 20k-node / 200k-edge fixture renders and sustains ≥30 fps pan/zoom.
2. **Ego-focus:** clicking a node dims non-neighbors and the panel lists its connections.
3. **Shortest path:** selecting two nodes highlights the connecting path and reports hop count.
4. **Community:** Louvain clustering colors clusters; toggle on/off works.
5. **Filter:** filtering by edge type shows/hides exactly the correct edges.
6. **Resize:** on window resize node sizes stay constant and the view refits — no uniform-scale zoom.
7. **High-DPI:** renders crisp on a 2× display with no blur.
8. **Off-thread layout:** the UI remains interactive while the initial layout computes.
9. **Search integration:** selecting a search result focuses the correct node's ego-network.
10. **Incremental:** adding or removing a contact updates the graph with no full relayout and no visual jump.
11. **Soft-delete:** `deleted_at` contacts never appear as nodes.

## 13. Build plan (phased)

- **Phase 0 — Renderer foundation.** Swap the prototype for sigma.js + graphology hydrated from SQLite via IPC; pan/zoom/fit; node size = degree; typed edge colors + legend; org color.
- **Phase 1 — Core interactions.** Hover, drag, click-to-focus ego-network + side panel; LOD labels; viewport culling; high-DPI correctness.
- **Phase 2 — Layout engine.** ForceAtlas2 in a worker, progressive settle + freeze, persisted positions, incremental in-place updates.
- **Phase 3 — Analytics.** Shortest path, degrees of separation, degree + (worker/cached) betweenness centrality, ego depth N, filters/facets.
- **Phase 4 — Clustering & search link.** Louvain community detection with cluster coloring/layout; search ↔ graph focus integration and match highlighting.
- **Phase 5 — Polish & verify.** Responsive reflow, minimap, export (PNG/SVG/GraphML); acceptance-test suite (§12) plus a perf harness on the 20k fixture in CI.

## 14. Handoff notes for Claude Code

- Extend the existing repo (lifecycle orchestrator, `contacts`/`edges` schema, graphology hydration, SQLCipher). Do not duplicate the graph model — the renderer's graphology instance is built from the same `nodes`/`links` shape delivered over validated IPC.
- **Do not compute betweenness centrality on the main thread.** Offload to a worker, compute on demand, cache the result; degree centrality stays live.
- Gate all label rendering behind LOD; assume full-scale views will otherwise drown in text.
- Treat the earlier SVG/d3-force graph as a disposable prototype — reference it for interaction semantics (ego-focus, size-by-degree, typed edges) only, not as a rendering approach.
- This spec is a sibling to the Search spec: the two integrate at focus (search selects → graph focuses) and at querying (graph filters mirror search operators). Build the integration in Phase 4 of both.
- Deliverables per phase: renderer/worker code, IPC handlers, UI controls, tests. Persist layout positions so reopening is instant.
