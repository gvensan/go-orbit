# Prototypes (reference only — not production)

These are the throwaway graph demos from early exploration. The production
renderer is **sigma.js / WebGL** per `docs/GRAPH_CANVAS_REQUIREMENTS.md`, which
explicitly designates these disposable.

Mine them for **interaction semantics only** — ego-network focus, node size =
degree, typed/colored edges, hover labels, the side panel. Do **not** adopt the
SVG/d3-force rendering approach; it collapses well before the 20k-node target.

- `orbit-graph.html` — self-contained standalone demo (opens in any browser).
- `OrbitGraph.jsx` — the React version (needs a harness; the HTML one is the runnable reference).
