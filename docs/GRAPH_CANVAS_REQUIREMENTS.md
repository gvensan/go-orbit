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

- **Layout:** the ego view is a **deterministic radial tree** (`balloonLayout` in `graph-geometry.mjs`): you at the centre, rings by how many steps away a contact is, one wedge per tie type, unreachable contacts on an outer ring. Synchronous placement, permitted under the worker-only guardrail because it is not a force simulation and the ego view is capped at 1200 contacts. Same network, same picture, every launch - there is no second engine and no toggle. After placement, a seat **slides along its own ring** if it has come to rest on a line it has nothing to do with (bounded by the free space to its neighbours), and a **couple turns as one** about its middle for the same reason - the pair is split after the seat pass, so it needs its own, and each partner is tested against the other's lines. A ring is a **lane** two seats deep, the step half the ring gap so both the lanes of a ring and the lanes of adjacent rings clear each other so it holds twice the circumference and sits half as far out; each branch reserves the arc its whole subtree needs; a crowded wedge widens its own ring and the ones outside it, bounded against what the ring needs to seat its contacts. **Couples are one unit:** contracted to a single node carrying both partners' ties (`contractCouples`), split apart afterwards across the ring (`expandCouples`), the side chosen by which partner each neighbour actually knows (`partnerSides`) so a partner's lines never reach across their partner's. Their gap is a share of their painted size (`COUPLE_SPREAD`), floored at what `pairHeartSpots` needs, because a gap fixed in graph units closes up at fit-to-window. **A layout is told the radius the canvas paints** (`layoutSize` -> `nodeHaloRadius`), never the bare body. In the **relationship** colour mode a CONTACT carries the colour of the first step from you (`tagGateways`), so a friend's family reads as part of your friend's world, while a LINE always carries the colour of the tie it is - in every view, so the legend means one thing when you look at a line. Contacts of a kind are kept together wherever a view chooses its own order: Graph groups each parent's people by the tie connecting them (partner grouping wins where a couple is involved), Mesh orders its ring by what a contact mostly is, Reach walks neighbours closest-tie first. Clusters, Tree and Orbit keep their own groupings (community, generation, community) - those are what those views are for.
  - ForceAtlas2 and its worker were removed on 2026-08-06: measured against this layout on a real 97-contact network they drew 24 crossings to 0 and left 54 pairs overlapping on screen to 2, because that network is a tree and a force layout has no cluster structure to find in one. Circle packing was prototyped as a replacement and was worse again. See `docs/DECISIONS.md`.
- **Level of detail:** cull off-viewport nodes/edges; render labels only above a zoom threshold or for high-degree nodes, to avoid a label storm at full scale.
- **High-DPI:** sigma handles `devicePixelRatio`; any custom canvas must scale its backing store by `dpr` or it renders blurry on Retina/4K.
- **Incremental updates:** adding or removing a contact mutates the graphology instance and updates sigma in place — preserve existing positions and lay out only the new node locally. No full relayout, no visual jump.

**Where analytics run.** Degree centrality is trivial and precomputed. Betweenness centrality on 20k/200k is O(V·E) — compute it in a **worker, on demand, and cache it**; never on the main thread. Document this so it isn't naively called inline.

**Recommended dependencies:** `sigma`, `graphology`, `graphology-layout-forceatlas2`, `graphology-metrics`, `graphology-shortest-path`, `graphology-communities-louvain`.

## 6. Data model / hydration

The renderer builds its graphology instance from IPC-delivered `nodes`/`links` matching the SQLite shape:

- **Node:** `{ id, name, org, role, degree, x?, y? }` — `degree` drives size, `org`/community/dominant relationship drives color, `x/y` from cached or worker-computed layout.
- **Edge:** `{ source, target, type, directed }` — `type` drives color and legend. The canonical type list lives in `src/shared/relationships.js` (colleague, friend, acquaintance, family, introduced, vendor); `vendor` marks a business: the contact carries `business: true` (set explicitly, or derived in the snapshot when every tie is a business type and the contact is neither the owner nor gendered), stores no gender (import, merge, and the card all strip it), and draws a vendor-hued ring (same geometry as the gender ring) plus an organization glyph instead of a gender ring. The "Fade links" toggle dims edges in every view, including cluster meta-edges and the tree's overlay connectors.

Soft-deleted contacts (`deleted_at`) are excluded from hydration. Persist computed layout positions so reopening the app doesn't recompute from scratch.

## 7. Feature requirements

### Must-have

| Feature | Detail |
|---|---|
| WebGL render at scale | 20k nodes / 200k edges without collapse; LOD + viewport culling |
| Meaningful default view | Opens on a focused/filtered subgraph, not the full hairball |
| Pan / zoom / fit | Wheel + controls; reset and fit-to-view; smooth at scale |
| Node drag | Reposition a node; persist the position in full-network view |
| Node size = centrality | Degree-scaled radius so hubs are visible |
| Typed edges + legend | Edge color by relationship type; readable legend |
| Node color by group | Org / cluster / relationship color encoding (switch from the palette: "Color by organization", "Color by community", "Color by relationship" (default - fills match the legend)). The choice persists across launches (`orbit-color-mode`). The gender ring and the deceased half-disc sit on top of whichever fill is active. |
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
| Community detection | **Hybrid clustering:** every company (org field) recorded on any contact becomes its own cluster with all of its people (regardless of count or relationship type), so any company you've noted always appears. A business contact (vendor) with no org field is a company in its own right: it becomes its own org-kind bubble named by the contact (or joins the company cluster already carrying its name) and never dissolves into a personal Louvain community. Contacts with no company group by Louvain connectivity communities. **Connector people are drawn as their own node, not folded into a bubble:** a company-to-company line is meaningless (companies don't have relationships, people do), so the owner ("you", your network's hub) and any genuine peer bridge (a person who links two clusters without routing through you) are pulled out as a person node, wired to their home cluster and to whoever they actually know. Every remaining line is therefore person→cluster or person→person, never org→org. A company is never emptied by promotion (a bridge is only pulled from a cluster that keeps ≥1 member behind). Keeping the owner as a person node also keeps the person-only view (organizations hidden) connected instead of collapsing into dangling islands. Each cluster bubble carries a person/organization badge glyph. Meta-edges are uniform thickness (tie count doesn't vary line width, so lines don't balloon on zoom). No cluster is left dangling: a bubble with no cross ties is anchored to the owner (else the highest-degree node). Because companies now connect only through people, the **organization-only view** (people hidden via the legend) would otherwise strand every company; a hidden "org bridge" link, shown only while people are hidden, wires each company to your own company (else the largest) so that view stays a connected star. The Cluster view adds a center-bottom person/organization legend; clicking a kind hides/shows those nodes. |
| Filtering / facets | By edge type, tag, org, degree threshold — mirrors search operators |
| Search ↔ graph integration | Search result focuses its ego-network; graph selection can seed a search; matches highlighted |
| Responsive reflow | On resize keep node sizes constant and expand/refit bounds — never uniform-scale zoom |
| Incremental update | Add/remove/edit a contact updates the graph in place, no full relayout |

### Nice-to-have

| Feature | Detail |
|---|---|
| Minimap / overview | Overview pane with viewport indicator |
| Export | PNG / SVG snapshot, GraphML for the network |
| Saved layouts | Persist manual arrangements per view |
| Path animation | Animate traversal along a shortest path |
| Signal overlays | Heatmap by centrality, recency, or unread |
| Edge bundling | Reduce clutter in dense regions |
| Timeline scrubbing | Show how the network grew over time |

### Family tree view (canvas mode `tree`)

An implemented addition to the original view set (`ego` / `mesh` / `orbit` /
`reach` / `cluster`). A kinship-only view that lays the family graph out as a
generational tree rooted on "you" (the owner contact), for reading lineage rather
than exploring the whole network. It consumes the same `graph:snapshot`
hydration and kinship edges as the other modes and adds no new IPC channel;
layout, connectors, and expander placement are renderer-local (`graph-view.js`).

| Aspect | Behavior |
|---|---|
| Root | Opens rooted on the owner at generation 0; ancestors above, descendants below. |
| Generational lanes | Nodes placed by generation (`familyGenerations`): each lane labeled relative to the root (grandparents / parents / you / children ...). |
| Couples & siblings | Spouses/co-parents sit adjacent as a unit with a couple bond + heart; blood siblings share a bar; parent-to-children buses are drawn on an overlay canvas *behind* the node circles. |
| Constant node size | Nodes render at a fixed on-screen size (`zoomToSizeRatioFunction = 1`) matching the graph view; zoom-in is capped so a couple keeps a fixed on-screen gap. |
| Expand / collapse | Per-node directional expanders reveal or hide parents (up), children (down), and siblings. A button shows only where it is **load-bearing**: it appears just when toggling it would actually add or remove a node. A couple's children expansion is shared and toggles both partners together. |
| Anchor (re-root) | A combobox re-roots the tree on any chosen pair, labeled `[Level n] X - Y` relative to you (0), ancestors negative and descendants positive. Anchoring presents the extended family of that pair (siblings, children, grandchildren, parents, grandparents). A "Default" option resets to you. |
| Hover highlight | Hovering lights the relevant family. **Default** mode is vertical lineage (self + partner, own siblings, ancestors to grandparents, children, grandchildren); **Extended** mode adds collateral kin (siblings' children, all ancestors, aunts/uncles). Connectors light only along the sub-segments that join lit nodes. |
| Controls | Shared zoom in/fit/out plus tree-only expand-all / collapse-all and the "Extended hover" toggle in the top-center cluster. That toggle changes the HOVER HIGHLIGHT only - it reveals nothing and moves nothing, which is why the tree looks identical with it on or off until you hover somebody. It sits beside the expand controls, so its label and tooltip have to carry that themselves; the anchor combobox sits in the top-left slot. |

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
- **Phase 2 — Layout engine.** Deterministic radial-tree placement for the ego view, persisted positions, incremental in-place updates. (Shipped as ForceAtlas2 in a worker; replaced 2026-08-06, see §5.)
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
