// graph-view.js - the constellation (GRAPH_CANVAS spec). Two modes:
//   ego  - the whole network (or a contact's N-hop neighborhood) laid out by
//          the renderer-side force worker. This is the "Graph" view.
//   mesh - every contact on a circle, every connection a straight chord. This
//          is the "Mesh" view. Deterministic; no worker.
// Plus: node drag, shortest-path highlight, Louvain community coloring, and
// edge-type filtering from the legend.

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import Sigma from "sigma";
import { EDGE_COLORS, EDGE_DEFAULT, orgColor } from "./colors.js";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Canvas colors follow the app theme (the graph is themed too, not just chrome).
function graphTheme() {
  const light = document.documentElement.dataset.theme === "light";
  return light
    ? { label: "#334155", dim: "#cbd5e1", center: "#0f172a", edge: "#c3ccdb", edgeFaint: "#e3e8f0", pathDim: "#dbe2ec", pathHi: "#2563eb", bg: "#eef2f8", hoverBg: "#ffffff", hoverBorder: "#cbd5e1",
        ownerFill: "#f0a500", ownerGlow: "#e07a00", ownerRing: "#b4700a", ownerSparkleRGB: "150,95,5",
        deceasedGlow: "#7c8aa0", deceasedRing: "#475569" }
    : { label: "#c7d2e4", dim: "#1d2a44", center: "#e2e8f0", edge: EDGE_DEFAULT, edgeFaint: "#161f33", pathDim: "#131c30", pathHi: "#93c5fd", bg: "#0a0f1c", hoverBg: "#0d1526", hoverBorder: "#2b4a80",
        ownerFill: "#ffc61a", ownerGlow: "#ffd85a", ownerRing: "#ffdd66", ownerSparkleRGB: "255,240,180",
        deceasedGlow: "#eaf1ff", deceasedRing: "#ffffff" };
}

// High-saturation, well-separated hues so the ring reads on any node fill.
const GENDER_RING = { Female: "#ff2d95", Male: "#00c2ff" };

// Natural-language phrasing of a relationship type toward a named contact.
// "introduced" is a provenance/directed type, so it reads "introduced by".
function relationshipPhrase(type, name, role) {
  if (type === "family" && role) return `${role} of ${name}`;
  switch (type) {
    case "introduced": return `introduced by ${name}`;
    case "family": return `family of ${name}`;
    case "colleague": return `colleague of ${name}`;
    case "friend": return `friend of ${name}`;
    case "acquaintance": return `acquaintance of ${name}`;
    default: return `${type} of ${name}`;
  }
}
const OVERLAY_MAX_NODES = 2500; // above this a dense graph, rings unreadable

// Family/kinship ties bind people into the same cluster far more than a loose
// colleague/acquaintance link, so they carry extra weight in the community
// detection (each kinship edge counts as this many ordinary ties).
const KINSHIP_WEIGHT = 5;

// Partner (couple) bonds inferred inside a family cluster: a bright, distinct
// link so married/partnered pairs read at a glance, apart from the plain
// relationship lines.
const PAIR_COLOR = "#f06fa6"; // the couple heart - the line keeps its own colour
const SPOUSE_ROLES = new Set(["husband", "wife", "spouse", "partner"]);
// Two people who hold complementary roles in the same generation toward a common
// relative are a couple (father+mother of a child, grandfather+grandmother of a
// grandchild, aunt+uncle of a niece/nephew). Detected as "exactly two members
// carry a role from this set toward the same person".
const COPARENT_ROLE_GROUPS = [
  new Set(["father", "mother", "parent"]),
  new Set(["grandfather", "grandmother", "grandparent"]),
  new Set(["uncle", "aunt", "aunt/uncle"]),
];

// Tree view: how many generations a kin role sits above (-) or below (+) the
// person they relate to. `kin[A]` is A's role toward B, so gen(A) = gen(B) + delta.
const GEN_DELTA = {
  grandfather: -2, grandmother: -2, grandparent: -2,
  father: -1, mother: -1, parent: -1, uncle: -1, aunt: -1, "aunt/uncle": -1,
  brother: 0, sister: 0, sibling: 0, husband: 0, wife: 0, spouse: 0, partner: 0, cousin: 0, "other relative": 0,
  son: 1, daughter: 1, child: 1, nephew: 1, niece: 1, "niece/nephew": 1,
  grandson: 2, granddaughter: 2, grandchild: 2,
};

// Lineage roles for the Tree hover-highlight: strictly lineal (no aunts/uncles,
// nieces/nephews, cousins, or siblings).
const ANCESTOR_ROLES = new Set(["father", "mother", "parent", "grandfather", "grandmother", "grandparent"]);
const DESCENDANT_ROLES = new Set(["son", "daughter", "child", "grandson", "granddaughter", "grandchild"]);
const SIBLING_ROLES = new Set(["brother", "sister", "sibling"]);

// Kin metadata is sometimes one-sided (only one endpoint's role stored). Read the
// relationship from EITHER side so a spouse/parent/child is never lost.
/** nb's generation offset from u across a family edge (or undefined). */
function genDeltaAcross(kin, u, nb) {
  const d1 = GEN_DELTA[kin[nb]];
  if (d1 !== undefined) return d1;
  const d2 = GEN_DELTA[kin[u]]; // reciprocal: nb's offset = -(u's offset)
  return d2 === undefined ? undefined : -d2;
}
/** Is this family edge a spouse tie, per either endpoint's role? */
function isSpouseEdge(kin, u, nb) {
  return SPOUSE_ROLES.has(kin[nb]) || SPOUSE_ROLES.has(kin[u]);
}
/** Is `child` a child of `parent` on this edge, per either endpoint's role? */
function isChildEdge(kin, parent, child) {
  const PARENT = ["father", "mother", "parent"];
  return DESCENDANT_ROLES.has(kin[child]) || PARENT.includes(kin[parent]);
}
/** Is this a sibling tie, per either endpoint's role? */
function isSiblingEdge(kin, u, nb) {
  return SIBLING_ROLES.has(kin[nb]) || SIBLING_ROLES.has(kin[u]);
}

/** A generation's label relative to "you" (offset 0). */
function genLabel(rel) {
  if (rel === 0) return "you";
  const up = ["", "parents", "grandparents", "great-grandparents"];
  const down = ["", "children", "grandchildren", "great-grandchildren"];
  const n = Math.abs(rel);
  if (rel < 0) return up[n] || `${n} generations up`;
  return down[n] || `${n} generations down`;
}

/** Deterministic PRNG (mulberry32) so Louvain returns the SAME communities every
 *  time - clusters shouldn't reshuffle on each visit. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small twinkling 4-point glint, used for the owner node's sparkle. */
function drawSparkle(ctx, x, y, size, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.1;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - size, y); ctx.lineTo(x + size, y);
  ctx.moveTo(x, y - size); ctx.lineTo(x, y + size);
  // diagonal shorter rays for a starrier look
  const d = size * 0.5;
  ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d);
  ctx.moveTo(x - d, y + d); ctx.lineTo(x + d, y - d);
  ctx.stroke();
}

/** A small filled heart, used to mark a partner (couple) bond at its midpoint. */
function drawHeart(ctx, x, y, s, fill, stroke) {
  ctx.save();
  ctx.beginPath();
  const top = y - s * 0.35;
  ctx.moveTo(x, y + s * 0.7);
  ctx.bezierCurveTo(x - s * 1.3, y - s * 0.15, x - s * 0.65, top - s, x, top);
  ctx.bezierCurveTo(x + s * 0.65, top - s, x + s * 1.3, y - s * 0.15, x, y + s * 0.7);
  ctx.closePath();
  if (stroke) { ctx.lineWidth = 2.4; ctx.strokeStyle = stroke; ctx.stroke(); }
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

/** Trace a rounded rectangle path (caller strokes/fills). */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Green used to highlight a relationship "flow" when a Tree node is hovered.
const FLOW_HIGHLIGHT = "#3ee08f";

const COMMUNITY_COLORS = [
  "#7aa2f7", "#e0af68", "#9ece6a", "#f7768e", "#bb9af7",
  "#2ac3de", "#ff9e64", "#73daca", "#c0caf5", "#f4b8e4",
];

export class GraphView {
  /**
   * @param {HTMLElement} container
   * @param {{ onSelect: (id: number) => void, onShiftSelect: (id: number) => void,
   *           onDragEnd: (id: number, pos: {x: number, y: number}) => void,
   *           onNodeMenu?: (id: number, pos: {x: number, y: number}) => void,
   *           onClusterOpen?: (memberIds: number[], label: string) => void,
   *           onTreeSelect?: (id: number) => void }} handlers
   */
  constructor(container, handlers) {
    this.container = container;
    this.handlers = handlers;
    /** @type {Graph | null} */
    this.full = null;
    this.view = new Graph({ multi: true, type: "mixed" });
    this.mode = "ego";
    this.center = null;
    this.hovered = null;
    this.worker = null;
    this.sparklePhase = 0;      // drives the owner node's golden twinkle
    this.sparkleRAF = null;
    this.hiddenTypes = new Set();
    this.isolatedType = null;        // legend hover: show only this relationship
    this.isolatedNodes = new Set();  // contacts incident to the isolated type
    this.pathNodes = new Set();
    this.pathEdgePairs = new Set();
    // Edge-fade toggle: dim every connection line so the node structure reads
    // through the mesh/orbit/reach chord clutter. On by default; persisted across
    // sessions (only an explicit toggle-off, stored as "0", turns it off).
    this.edgeFade = localStorage.getItem("orbit-edge-fade") !== "0";
    // Tree "Extended" hover mode: off = vertical lineage only, on = also follow
    // sibling discovery (collateral kin). Persisted across sessions.
    this.treeExtended = localStorage.getItem("orbit-tree-extended") === "1";
    // Tree ANCHOR: re-root the tree on a chosen pair instead of You. null = default
    // (You). Per-session (reset on reload); the value is a node id.
    this.treeAnchor = null;
    // Reach tree: BFS parent of each node (child id -> parent id) so hovering a
    // node can trace the chain back to "you", plus the currently traced path.
    this.reachParent = new Map();
    this.reachPath = new Set();       // node ids on the hovered node's path to centre
    this.reachPathEdges = new Set();  // "child|parent" pairs along that path
    // Tree: on hover, the whole lineage (ancestors + descendants + partners).
    this.familyHighlight = new Set();
    this.familyHighlightEdges = new Set();
    // Tree: click a parent to focus - its children group beneath it, rest dims.
    this.treeFocus = null;
    this.treeFocusSet = new Set();
    this.treeFocusEdges = new Set();
    this.treeGen = null; // generation map, kept so focus can re-lay the tree
    // Cluster metagraph: super-node id -> member contact ids / display label.
    this.clusterMembers = new Map();
    this.clusterLabels = new Map();
    this.clusterIsolate = null; // legend hover in Cluster: highlight one tie type
    this.colorMode = "org"; // "org" | "community"
    this.communities = new Map();
    this.orbitMetric = "recency"; // Orbit ring radius: recency|cadence|degree|betweenness
    this.betweenness = {};        // node id -> betweenness, fetched on demand for the metric
    this._orbitMax = 1;           // metric max for the normalized (degree/betweenness) rings
    this.dragging = null;
    this.dragMoved = false;
    this.theme = graphTheme();
    // "all" = gender ring on every node; "hover" = only the hovered node.
    this.genderRingMode = localStorage.getItem("orbit-gender-ring") || "all";

    // Overlay canvas for gender rings + relationship-to-center badges. Created
    // now, appended AFTER sigma below so it stacks above sigma's own canvases.
    this.overlay = document.createElement("canvas");
    this.overlay.className = "graph-overlay";

    this.hoverCard = document.createElement("div");
    this.hoverCard.className = "hover-card";
    this.hoverCard.hidden = true;
    container.style.position = "relative";

    // Minimap (top-right, pannable, toggleable).
    this.minimapVisible = localStorage.getItem("orbit-minimap") !== "0";
    this.minimapWrap = document.createElement("div");
    this.minimapWrap.className = "minimap-wrap";
    this.minimapCanvas = document.createElement("canvas");
    this.minimapCanvas.className = "minimap-canvas";
    const mmHide = document.createElement("button");
    mmHide.className = "minimap-hide"; mmHide.type = "button"; mmHide.textContent = "✕"; mmHide.title = "Hide minimap";
    mmHide.addEventListener("click", () => this.setMinimapVisible(false));
    mmHide.setAttribute("aria-label", "Hide minimap");
    // Re-layout ("shuffle"/refresh) - only meaningful in the force/Graph view. Hidden
    // in the deterministic Mesh/Orbit/Reach/Clusters views (see applyMinimapVisibility).
    // Sits top-left (fit-to-view moved to the shared zoom controls in the top bar).
    this.mmShuffle = document.createElement("button");
    this.mmShuffle.className = "minimap-shuffle"; this.mmShuffle.type = "button"; this.mmShuffle.textContent = "⟳";
    this.mmShuffle.title = "Reshuffle the layout (alternative arrangement)";
    this.mmShuffle.setAttribute("aria-label", "Reshuffle the layout");
    this.mmShuffle.addEventListener("click", () => this.reshuffleLayout());
    this.minimapWrap.append(mmHide, this.mmShuffle, this.minimapCanvas);
    this.minimapShow = document.createElement("button");
    this.minimapShow.className = "minimap-show"; this.minimapShow.type = "button"; this.minimapShow.textContent = "🗺"; this.minimapShow.title = "Show minimap";
    this.minimapShow.addEventListener("click", () => this.setMinimapVisible(true));
    this._mmMap = null;
    this._mmDragging = /** @type {number | null} */ (null);

    this.sigma = new Sigma(this.view, container, {
      // The graph lives in a pane that's hidden on other views (Settings, Geomap,
      // onboarding), so its container is 0-width then. A refresh while hidden
      // must skip rendering, not throw "Container has no width".
      allowInvalidContainer: true,
      labelColor: { color: this.theme.label },
      labelSize: 12,
      labelRenderedSizeThreshold: 7,
      defaultEdgeColor: this.theme.edge,
      stagePadding: 50,
      // Sigma's default hover label sits on a hardcoded white box (invisible
      // with light label text in dark mode); draw a themed box instead.
      defaultDrawNodeHover: (ctx, data, settings) => this.drawNodeHover(ctx, data, settings),
      nodeReducer: (node, data) => {
        const out = { ...data };
        // Center node color follows the theme (flips live on toggle)...
        if (this.center != null && node === String(this.center)) out.color = this.theme.center;
        // ...but the owner ("you") stays sun-gold even when it's the centre.
        if (out.isOwner || this.view.getNodeAttribute(node, "isOwner")) out.color = this.theme.ownerFill;
        // Legend hover: show only contacts touched by the isolated relationship.
        if (this.isolatedType && !this.isolatedNodes.has(node)) {
          out.hidden = true;
          return out;
        }
        if (this.pathNodes.size) {
          if (this.pathNodes.has(node)) {
            out.color = this.theme.center;
            out.zIndex = 2;
            out.forceLabel = true; // name every node on the traced path
          } else {
            out.color = this.theme.dim;
            out.label = null;
          }
          return out;
        }
        // Tree hover: light the whole lineage (ancestors/descendants/partners),
        // dim the rest - keeping natural colours so the family reads at a glance.
        if (this.familyHighlight.size) {
          if (node === this.hovered || this.familyHighlight.has(node)) out.zIndex = 2;
          else { out.color = this.theme.dim; out.label = null; }
          return out;
        }
        // Tree focus (not hovering): the focused family stays lit, the rest dims.
        if (this.treeFocus && this.treeFocusSet.size && !this.treeFocusSet.has(node)) {
          out.color = this.theme.dim; out.label = null;
          return out;
        }
        if (this.hovered && node !== this.hovered) {
          // Nodes on the chain back to "you" stay lit and are named (keeping their
          // own colour - the highlighted line conveys the path); everyone else dims.
          if (this.reachPath.has(node)) { out.zIndex = 2; out.forceLabel = true; }
          else if (!this.view.areNeighbors(node, this.hovered)) { out.color = this.theme.dim; out.label = null; }
        }
        return out;
      },
      edgeReducer: (edge, data) => {
        const out = { ...data };
        // "type" is reserved by sigma for its render program; ours is edgeType.
        const attrs = this.view.getEdgeAttributes(edge);
        // Cluster metagraph: a meta-edge bundles ties of several relationship types.
        // The legend filters/isolates on that underlying breakdown.
        if (attrs.edgeType === "meta") {
          const tc = attrs.typeCounts || {};
          const maxW = this._clusterMaxW || 1;
          if (this.clusterIsolate) {
            const n = tc[this.clusterIsolate] || 0;
            if (!n) { out.hidden = true; return out; }
            out.color = EDGE_COLORS[this.clusterIsolate] || this.theme.edge;
            out.size = 1 + 7 * (n / maxW);
            return out;
          }
          let eff = 0;
          for (const [type, cnt] of Object.entries(tc)) if (!this.hiddenTypes.has(type)) eff += cnt;
          if (eff === 0) { out.hidden = true; return out; }
          out.size = 1 + 7 * (eff / maxW);
          return out;
        }
        if (this.hiddenTypes.has(attrs.edgeType)) {
          out.hidden = true;
          return out;
        }
        // Legend hover: hide every connection that isn't the isolated type.
        if (this.isolatedType && attrs.edgeType !== this.isolatedType) {
          out.hidden = true;
          return out;
        }
        const [s, t] = this.view.extremities(edge);
        if (this.pathEdgePairs.size) {
          if (this.pathEdgePairs.has(`${s}|${t}`) || this.pathEdgePairs.has(`${t}|${s}`)) {
            out.color = this.theme.pathHi;
            out.size = 2.5;
            out.zIndex = 2;
          } else {
            out.color = this.theme.pathDim;
          }
          return out;
        }
        // Tree hover: show only the lineage's own connecting lines.
        if (this.familyHighlightEdges.size) {
          if (this.familyHighlightEdges.has(`${s}|${t}`) || this.familyHighlightEdges.has(`${t}|${s}`)) out.zIndex = 2;
          else out.hidden = true;
          return out;
        }
        // Tree focus (not hovering): only the focused family's lines.
        if (this.treeFocus && this.treeFocusEdges.size) {
          if (this.treeFocusEdges.has(`${s}|${t}`) || this.treeFocusEdges.has(`${t}|${s}`)) out.zIndex = 2;
          else out.hidden = true;
          return out;
        }
        if (this.hovered) {
          // Reach: keep the traced chain to "you" lit even where it runs past
          // the hovered node's immediate neighbours.
          if (this.reachPathEdges.size &&
              (this.reachPathEdges.has(`${s}|${t}`) || this.reachPathEdges.has(`${t}|${s}`))) {
            out.color = this.theme.pathHi;
            out.size = 2.6;
            out.zIndex = 2;
            return out;
          }
          if (s !== this.hovered && t !== this.hovered) out.hidden = true;
          return out;
        }
        // No hover: optionally fade every line so the nodes read through the
        // chord clutter (mesh/orbit/reach get busy at high edge density).
        if (this.edgeFade) {
          out.color = this.theme.edgeFaint;
          out.size = Math.min(data.size ?? 1, 0.7);
        }
        return out;
      },
    });
    // Tree renders at a fixed zoom-out, so keep its nodes a constant on-screen size
    // (matching Graph view) instead of shrinking with the zoom. Captured here, applied
    // per-mode via setNodeSizeMode.
    this._zoomSizeFnDefault = this.sigma.getSetting("zoomToSizeRatioFunction");

    this.wireEvents();
  }

  /** Constant node size (tree, so zoom-out doesn't shrink them) vs the default
   *  zoom-scaled size (every other view). */
  setNodeSizeMode(constant) {
    this.sigma.setSetting("zoomToSizeRatioFunction", constant ? () => 1 : this._zoomSizeFnDefault);
  }

  wireEvents() {
    // Overlay + hover card go on top of sigma's canvases (appended last).
    this.container.append(this.overlay, this.hoverCard, this.minimapWrap, this.minimapShow);
    this.applyMinimapVisibility(); // empty graph on boot -> no minimap chrome
    // Redraw the ring/badge overlay + minimap after every sigma paint.
    this.sigma.on("afterRender", () => {
      this.applyMinimapVisibility(); this.drawOverlay(); this.drawMinimap();
      if (this.mode === "tree") this.renderTreeExpanders();
      else if (this.treeExpanderEl) { this.treeExpanderEl.hidden = true; this.treeExpanderEl.innerHTML = ""; }
    });

    // Minimap panning: click / drag jumps the main camera to that spot.
    const mmPan = (ev) => this.panFromMinimap(ev);
    this.minimapCanvas.addEventListener("pointerdown", (ev) => {
      if (!ev.isPrimary || ev.button !== 0) return;
      this._mmDragging = ev.pointerId;
      this.minimapCanvas.setPointerCapture(ev.pointerId);
      mmPan(ev);
    });
    this.minimapCanvas.addEventListener("pointermove", (ev) => {
      if (this._mmDragging === ev.pointerId) mmPan(ev);
    });
    const mmEnd = (ev) => {
      if (this._mmDragging === ev.pointerId) this._mmDragging = null;
    };
    this.minimapCanvas.addEventListener("pointerup", mmEnd);
    this.minimapCanvas.addEventListener("pointercancel", mmEnd);

    this.sigma.on("clickNode", ({ node, event }) => {
      if (this.dragMoved) return; // this click is the tail of a drag
      this.hoverCard.hidden = true; // dismiss the tooltip on click
      // Cluster metagraph: a super-node isn't a contact - clicking expands it.
      if (this.mode === "cluster") {
        const members = this.clusterMembers.get(node);
        if (members && this.handlers.onClusterOpen) {
          this.handlers.onClusterOpen(members.map(Number), this.clusterLabels.get(node) || "Cluster");
        }
        return;
      }
      const id = Number(node);
      // Tree: clicking a parent focuses it (children group beneath); the app also
      // opens the card without leaving the tree.
      if (this.mode === "tree" && this.handlers.onTreeSelect && !event.original.shiftKey) {
        this.handlers.onTreeSelect(id);
        return;
      }
      if (event.original.shiftKey) this.handlers.onShiftSelect(id);
      else this.handlers.onSelect(id);
    });
    // Tree: clicking empty space restores the full (unfocused) tree.
    this.sigma.on("clickStage", () => { if (this.mode === "tree") { this.treeActive = null; this.renderTreeExpanders(); } });
    this.sigma.on("enterNode", ({ node }) => {
      this.hovered = node;
      // Reach: chain back to "you". Tree: the hovered node's whole lineage.
      // Everywhere else: the shortest path through the visible graph to "you".
      if (this.mode === "reach") this.traceReachPath(node);
      else if (this.mode === "tree") {
        // Light exactly the 3-generation family band (current, parents, children):
        // those nodes stay bright and their connector flows glow green; the rest dims.
        this.treeHoverNode = node;
        this.familyHighlight = this.treeActiveFamily(node);
        this.familyHighlightEdges = new Set(); // the tree view has no sigma edges
      }
      else this.traceOwnerPath(node);
      this.container.style.cursor = "pointer";
      this.showHoverCard(node);
      this.sigma.refresh();
    });
    this.sigma.on("leaveNode", () => {
      this.hovered = null;
      if (this.treeHoverNode) this.treeHoverNode = null;
      if (this.reachPath.size) { this.reachPath = new Set(); this.reachPathEdges = new Set(); }
      if (this.familyHighlight.size) { this.familyHighlight = new Set(); this.familyHighlightEdges = new Set(); }
      this.container.style.cursor = "";
      this.hoverCard.hidden = true;
      this.sigma.refresh();
    });

    // Right-click (or 2-finger click) a node: quick "add a connection" menu.
    // Driven by the DOM contextmenu event + the hovered node, which is reliable
    // across sigma versions (sigma's own rightClickNode can be finicky).
    this.container.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (this.mode === "cluster") return; // super-nodes aren't contacts
      if (this.hovered != null && this.handlers.onNodeMenu) {
        this.hoverCard.hidden = true;
        this.handlers.onNodeMenu(Number(this.hovered), { x: ev.clientX, y: ev.clientY });
      }
    });

    // Node drag (GRAPH_CANVAS §7 must-have). Camera stays put via
    // preventSigmaDefault; a real drag suppresses the click that follows.
    this.sigma.on("downNode", (/** @type {any} */ e) => {
      if (e.event?.original?.button !== 0) return; // left-button drags only
      this.dragging = e.node;
      this.dragMoved = false;
    });
    const captor = this.sigma.getMouseCaptor();
    captor.on("mousemovebody", (e) => {
      if (!this.dragging) return;
      // If no button is held (e.g. a right-click never cleared the drag), stop -
      // otherwise the node would follow the cursor everywhere, even off-canvas.
      if (/** @type {any} */ (e.original)?.buttons === 0) { this.dragging = null; return; }
      const pos = this.sigma.viewportToGraph(e);
      this.view.setNodeAttribute(this.dragging, "x", pos.x);
      this.view.setNodeAttribute(this.dragging, "y", pos.y);
      if (this.full?.hasNode(this.dragging)) {
        this.full.mergeNodeAttributes(this.dragging, { x: pos.x, y: pos.y });
      }
      this.dragMoved = true;
      e.preventSigmaDefault();
      e.original.preventDefault();
      e.original.stopPropagation();
    });
    captor.on("mouseup", () => {
      if (this.dragging && this.dragMoved) {
        const id = this.dragging;
        const a = this.view.getNodeAttributes(id);
        this.handlers.onDragEnd(Number(id), { x: a.x, y: a.y });
      }
      this.dragging = null;
      // clickNode fires within this same event cascade; clear the suppression
      // flag afterwards so drags ending off-node can't swallow the NEXT click.
      setTimeout(() => { this.dragMoved = false; }, 0);
    });
  }

  /** The graph mini-card: name, org, recency, degree, mutuals with the focus. */
  showHoverCard(node) {
    if (this.mode === "cluster") { this.showClusterCard(node); return; }
    if (!this.full?.hasNode(node)) return;
    const a = this.full.getNodeAttributes(node);
    const bits = [];
    const sub = [a.role, a.org, a.gender].filter(Boolean).join(" · ");
    if (sub) bits.push(sub);
    // Location: city, state, country only (drop the full geocoded address/place);
    // fall back to the freeform location if no structured components exist.
    const locality = [a.city, a.state, a.country].filter(Boolean).join(", ") || a.location;
    if (locality) bits.push(`📍 ${locality}`);
    // The node's family relationship + mutuals-with-you, computed from the node
    // itself (not the focused centre) so the tooltip reads identically in Graph,
    // Full network, and any focused view. Prefer the family edge to you (owner);
    // otherwise show the node's kin role toward whoever they're family with.
    const ownerId = this.ownerNode();
    const ownerStr = ownerId != null ? String(ownerId) : null;
    if (ownerStr !== node) {
      let role = null, otherId = null;
      this.full.forEachEdge(node, (_k, attrs, s, t) => {
        if (attrs.type !== "family" || !(attrs.metadata && attrs.metadata.kin)) return;
        const r = attrs.metadata.kin[node];
        if (!r) return;
        const other = s === node ? t : s;
        if (other === ownerStr) { role = r; otherId = other; }   // prefer the edge to you
        else if (!role) { role = r; otherId = other; }
      });
      if (role && otherId != null) bits.push(`${role} of ${this.full.getNodeAttribute(otherId, "name")}`);
    }
    if (a.lastInteractionAt) {
      const days = Math.floor((Date.now() - a.lastInteractionAt) / 86400000);
      bits.push(days === 0 ? "in touch today" : `last touch ${days}d ago`);
    } else {
      bits.push("no interactions logged");
    }
    bits.push(`${a.degree} connection${a.degree === 1 ? "" : "s"}`);
    if (ownerStr && ownerStr !== node) {
      let mutuals = 0;
      this.full.forEachNeighbor(node, (nb) => { if (this.full.areNeighbors(nb, ownerStr)) mutuals++; });
      if (mutuals) bits.push(`${mutuals} mutual`);
    }
    this.hoverCard.innerHTML = "";
    const title = document.createElement("div");
    title.className = "hover-title";
    title.textContent = `${a.starred ? "★ " : ""}${a.name}${a.isOwner ? " (you)" : ""}${a.deceased ? " †" : ""}`;
    const meta = document.createElement("div");
    meta.className = "hover-meta mono";
    meta.textContent = bits.join("  ·  ");
    this.hoverCard.append(title, meta);
    this.positionHoverCard();
  }

  /** Park the hover tooltip in a fixed spot - top-right, just below the minimap -
   *  for every view. Hovering already highlights the node on the canvas, so the
   *  card no longer chases the cursor or dodges lines; it just has a stable home. */
  positionHoverCard() {
    this.hoverCard.hidden = false;
    const rect = this.container.getBoundingClientRect();
    const cw = this.hoverCard.offsetWidth;
    const margin = 12;
    // Sit just below whatever occupies the top-right corner: the open minimap, or
    // the little "show minimap" button when it's collapsed.
    const anchor = [this.minimapWrap, this.minimapShow].find((el) => el && !el.hidden && el.offsetParent);
    const top = anchor ? anchor.offsetTop + anchor.offsetHeight + margin : margin;
    const left = Math.max(8, rect.width - cw - margin);
    this.hoverCard.style.left = `${left}px`;
    this.hoverCard.style.top = `${top}px`;
  }

  /** Inbound `introduced` chain: who brought this person into the network. */
  introChain(id, maxHops = 3) {
    const chain = [];
    const seen = new Set([String(id)]);
    let current = String(id);
    for (let i = 0; i < maxHops; i++) {
      let introducer = null;
      this.full?.forEachInboundEdge(current, (_e, attrs, source, target) => {
        if (!introducer && attrs.type === "introduced" && target === current && !seen.has(source)) {
          introducer = source;
        }
      });
      if (!introducer) break;
      seen.add(introducer);
      chain.push({ id: Number(introducer), name: this.full.getNodeAttribute(introducer, "name") });
      current = introducer;
    }
    return chain;
  }

  starred() {
    const out = [];
    this.full?.forEachNode((id, a) => {
      if (a.starred) out.push({ id: Number(id), name: a.name, org: a.org });
    });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ----------------------------------------------------------- snapshot --
  setSnapshot(snapshot) {
    const g = new Graph({ multi: true, type: "mixed" });
    for (const n of snapshot.nodes) {
      g.addNode(n.id, {
        name: n.name, org: n.org, role: n.role, degree: n.degree,
        gender: n.gender, starred: n.starred, isOwner: n.isOwner,
        lastInteractionAt: n.lastInteractionAt, cadenceDays: n.cadenceDays,
        location: n.location, place: n.place,
        city: n.city, state: n.state, country: n.country, deceased: n.deceased,
        x: n.x, y: n.y,
      });
    }
    snapshot.links.forEach((l, i) => {
      if (!g.hasNode(l.source) || !g.hasNode(l.target)) return;
      const key = `e${i}`;
      if (l.directed) g.addDirectedEdgeWithKey(key, l.source, l.target, { type: l.type, metadata: l.metadata });
      else g.addUndirectedEdgeWithKey(key, l.source, l.target, { type: l.type, metadata: l.metadata });
    });
    this.full = g;
    this.communities.clear();
    if (this.colorMode === "community") this.computeCommunities();
    this.applyMinimapVisibility(); // hide minimap on the empty/onboarding state
  }

  /** Themed hover-label box (replaces sigma's hardcoded white box). data.x/y
   *  are viewport coordinates; data.size is the rendered radius. */
  drawNodeHover(context, data, settings) {
    if (typeof data.label !== "string" || !data.label) return;
    const size = settings.labelSize;
    context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    const pad = 4;
    const tw = context.measureText(data.label).width;
    const boxH = size + pad * 2;
    const x = data.x + data.size + 5;
    const y = data.y - boxH / 2;
    const boxW = tw + pad * 2 + 2;
    const rad = 4;
    context.beginPath();
    context.moveTo(x + rad, y);
    context.arcTo(x + boxW, y, x + boxW, y + boxH, rad);
    context.arcTo(x + boxW, y + boxH, x, y + boxH, rad);
    context.arcTo(x, y + boxH, x, y, rad);
    context.arcTo(x, y, x + boxW, y, rad);
    context.closePath();
    context.fillStyle = this.theme.hoverBg;
    context.fill();
    context.strokeStyle = this.theme.hoverBorder;
    context.lineWidth = 1;
    context.stroke();
    context.fillStyle = this.theme.label;
    context.textBaseline = "middle";
    context.fillText(data.label, x + pad + 1, data.y);
  }

  /** Highlight a node from outside (e.g. hovering a Connections row) - same
   *  dimming effect as hovering the node in the graph. */
  highlightNode(id) {
    const s = String(id);
    if (!this.view.hasNode(s)) return;
    this.hovered = s;
    this.sigma.refresh();
  }
  clearHighlight() {
    if (this.hovered) {
      this.hovered = null;
      this.sigma.refresh();
    }
  }

  /** Flip gender-ring scope between every node and only the hovered one. */
  cycleGenderRingMode() {
    this.genderRingMode = this.genderRingMode === "all" ? "hover" : "all";
    localStorage.setItem("orbit-gender-ring", this.genderRingMode);
    this.sigma.refresh();
    return this.genderRingMode;
  }

  /** Recompute canvas colors after a light/dark toggle and repaint. */
  applyTheme() {
    this.theme = graphTheme();
    this.sigma.setSetting("labelColor", { color: this.theme.label });
    this.sigma.setSetting("defaultEdgeColor", this.theme.edge);
    this.sigma.refresh();
  }

  /**
   * Draw a gender ring around each node and, in ego view, a small badge in the
   * relationship-to-center color. Runs on sigma's afterRender.
   */
  drawOverlay() {
    const ctx = this.overlay.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (this.overlay.width !== Math.round(w * dpr) || this.overlay.height !== Math.round(h * dpr)) {
      this.overlay.width = Math.round(w * dpr);
      this.overlay.height = Math.round(h * dpr);
      this.overlay.style.width = `${w}px`;
      this.overlay.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Orbit: faint concentric guide rings + labels behind the nodes (drawn even
    // at large scale, before the per-node overlay bails out).
    if (this.mode === "orbit" && this.orbitRingGap && this.view.order > 0) this.drawOrbitGuides(ctx);
    if (this.mode === "reach" && this.reachGap && this.view.order > 0) this.drawReachGuides(ctx);
    if (this.mode === "tree" && this.treeRowGap && this.view.order > 0) { this.drawTreeGuides(ctx); this.drawTreeConnectors(ctx); }
    if (this.view.order === 0 || this.view.order > OVERLAY_MAX_NODES) return;

    const centerStr = this.center != null ? String(this.center) : null;
    const hoverOnly = this.genderRingMode === "hover";
    const mesh = this.mode === "mesh";
    this.view.forEachNode((id, attrs) => {
      if (!Number.isFinite(attrs.x) || !Number.isFinite(attrs.y)) return;
      // Isolated-out nodes are hidden by the reducer; skip their rings/halos too.
      if (this.isolatedType && !this.isolatedNodes.has(id)) return;
      // Node GRAPH coordinates -> viewport (getNodeDisplayData is sigma's
      // normalized frame and would misplace the rings).
      const p = this.sigma.graphToViewport({ x: attrs.x, y: attrs.y });
      let r;
      try { r = this.sigma.scaleSize(attrs.size); } catch { r = attrs.size; }
      // The owner ("you"): a golden sparkling halo + twinkling glints.
      if (attrs.isOwner) {
        const t = this.sparklePhase;
        ctx.save();
        // Glowing gold ring (canvas shadow makes it radiate) - theme-aware so it
        // reads on the light canvas too.
        ctx.shadowColor = this.theme.ownerGlow;
        ctx.shadowBlur = 14 + Math.sin(t) * 5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 3.5, 0, 2 * Math.PI);
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = this.theme.ownerRing;
        ctx.stroke();
        ctx.shadowBlur = 0;
        // A few sparkles orbiting the node, each twinkling out of phase.
        const N = 5;
        for (let s = 0; s < N; s++) {
          const ang = t * 0.5 + (s * 2 * Math.PI) / N;
          const orbit = r + 8;
          const tw = 0.5 + 0.5 * Math.sin(t * 3 + s * 1.7); // 0..1
          drawSparkle(ctx, p.x + Math.cos(ang) * orbit, p.y + Math.sin(ang) * orbit,
            1.5 + tw * 2.6, `rgba(${this.theme.ownerSparkleRGB},${(0.35 + tw * 0.6).toFixed(3)})`);
        }
        ctx.restore();
      }
      // Deceased are shown by a sober white fill (see nodeColor), not a halo.
      const ring = GENDER_RING[attrs.gender];
      const drawRing = ring && (!hoverOnly || id === this.hovered);
      if (drawRing) {
        // On the mesh the beads sit shoulder-to-shoulder, so hug the ring tight
        // to the bead (and thin it) - a fat offset ring would fuse into a rope.
        const rr = mesh ? r + 1.2 : r + 3;
        // A thin background gap ring first, so the colored ring stays legible
        // on similarly-colored fills.
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, 2 * Math.PI);
        ctx.lineWidth = mesh ? 1.6 : 3;
        ctx.strokeStyle = this.theme.bg;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, 2 * Math.PI);
        ctx.lineWidth = mesh ? 1.3 : 1.8;
        ctx.strokeStyle = ring;
        ctx.stroke();
      }
      if (centerStr && id !== centerStr && attrs.relColor) {
        const off = (r + 2.5) * 0.72;
        ctx.beginPath();
        ctx.arc(p.x + off, p.y - off, 3.6, 0, 2 * Math.PI);
        ctx.fillStyle = attrs.relColor;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = this.theme.center;
        ctx.stroke();
      }
    });
    // Partner (couple) bonds: a small heart at the midpoint of each pair link.
    if (this._hasPairs) {
      this.view.forEachEdge((_k, a, s, t) => {
        if (!a.pair) return;
        // Mirror the edge reducer: if the bond line is hidden, hide its heart too.
        if (this.hiddenTypes.has(a.edgeType)) return;                       // legend filter off
        if (this.isolatedType && a.edgeType !== this.isolatedType) return;  // legend isolate
        if (this.hovered && s !== this.hovered && t !== this.hovered) return; // hover dimming
        const sa = this.view.getNodeAttributes(s), ta = this.view.getNodeAttributes(t);
        if (!Number.isFinite(sa.x) || !Number.isFinite(ta.x)) return;
        const p1 = this.sigma.graphToViewport({ x: sa.x, y: sa.y });
        const p2 = this.sigma.graphToViewport({ x: ta.x, y: ta.y });
        // Size the heart off the rendered node radii so it scales with zoom.
        let r1, r2;
        try { r1 = this.sigma.scaleSize(sa.size); } catch { r1 = sa.size; }
        try { r2 = this.sigma.scaleSize(ta.size); } catch { r2 = ta.size; }
        const hz = Math.max(4, 0.6 * Math.min(r1, r2));
        drawHeart(ctx, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2, hz, PAIR_COLOR, this.theme.bg);
      });
    }
  }

  hub() {
    let best = null, bestDeg = -1;
    this.full?.forEachNode((id, attrs) => {
      if (attrs.degree > bestDeg) { bestDeg = attrs.degree; best = Number(id); }
    });
    return best;
  }

  /** A node's display name (from the full graph), or null. */
  nameOf(id) {
    return this.full && this.full.hasNode(String(id)) ? this.full.getNodeAttribute(String(id), "name") : null;
  }

  /** The owner ("you") node id, or null if the owner isn't in the graph. */
  ownerNode() {
    let owner = null;
    this.full?.forEachNode((id, attrs) => {
      if (attrs.isOwner) owner = Number(id);
    });
    return owner;
  }

  /** Show an arbitrary set of contacts as a subgraph (Explore "Show on graph"). */
  focusSet(ids, { induce = true, nodeScale = 1, pairs = false, expandPartners = false } = {}) {
    if (!this.full) return;
    this.mode = "ego";
    this.center = null;
    this.clearPath();
    const set = new Set(ids.map(String).filter((id) => this.full.hasNode(id)));
    if (induce) {
      // Pull in shared neighbors so a scattered result set still reads as a graph.
      for (const id of [...set]) {
        this.full.forEachNeighbor(id, (nb) => {
          if (set.has(nb)) return; // keep it tight: only edges within the set
        });
      }
    }
    // A rendered node's partner may live elsewhere; pull partners into the view
    // so couples (and their bond) are always visible.
    if (pairs && expandPartners) this.expandWithPartners(set);
    this.buildView(set, null, { render: false, nodeScale });
    if (pairs) this.drawCoupleBonds(this.detectCouples(new Set(this.view.nodes()), { requireBoth: true }));
    this.runEgoLayout(); // paints + frames once the layout settles (no seed flash)
    return set.size;
  }

  /** Detect couples in the FULL graph: direct spouses, plus co-parents /
   *  co-grandparents / co-aunt-uncles (exactly two people hold a complementary
   *  same-generation role toward the same relative). `requireBoth` keeps only
   *  couples fully inside `baseSet`; otherwise a couple with just one endpoint in
   *  the set is kept too (so a member's partner can be pulled into the view).
   *  Returns [[a, b], ...] as node-id strings. */
  detectCouples(baseSet, { requireBoth = true } = {}) {
    if (!this.full) return [];
    const found = new Map(); // key -> [a, b]
    const key = (a, b) => (Number(a) < Number(b) ? `${a}|${b}` : `${b}|${a}`);
    const consider = (a, b) => {
      if (a === b) return;
      const ok = requireBoth ? (baseSet.has(a) && baseSet.has(b)) : (baseSet.has(a) || baseSet.has(b));
      if (ok) found.set(key(a, b), [a, b]);
    };
    const rolesTo = new Map(); // targetId -> [{person, role}]
    const push = (target, person, role) => {
      if (!role) return;
      if (!rolesTo.has(target)) rolesTo.set(target, []);
      rolesTo.get(target).push({ person, role });
    };
    this.full.forEachEdge((_k, attrs, s, t) => {
      if (attrs.type !== "family" || !attrs.metadata || !attrs.metadata.kin) return;
      const rs = attrs.metadata.kin[s], rt = attrs.metadata.kin[t];
      if (SPOUSE_ROLES.has(rs) || SPOUSE_ROLES.has(rt)) consider(s, t); // direct spouse edge
      push(t, s, rs); // s is `rs` toward t
      push(s, t, rt); // t is `rt` toward s
    });
    for (const group of COPARENT_ROLE_GROUPS) {
      for (const [, arr] of rolesTo) {
        const people = [...new Set(arr.filter((x) => group.has(x.role)).map((x) => x.person))];
        if (people.length === 2) consider(people[0], people[1]);
      }
    }
    return [...found.values()];
  }

  /** Draw partner bonds (bright, thick, with a heart) for the given couples that
   *  are present in the current view. Promotes an existing tie between them, or
   *  adds one for co-parents who have no direct edge. Run before the layout so
   *  partners settle side by side. */
  drawCoupleBonds(couples) {
    let any = false;
    for (const [a, b] of couples) {
      if (!this.view.hasNode(a) || !this.view.hasNode(b)) continue;
      const between = this.view.edges(a, b);
      if (between.length) {
        // Keep the tie's own relationship colour; the heart alone marks the pair.
        const e = between.find((k) => this.view.getEdgeAttribute(k, "edgeType") === "family") ?? between[0];
        this.view.setEdgeAttribute(e, "pair", true);
      } else {
        // Co-parents with no direct edge: a plain family-coloured tie + the heart.
        this.view.addEdge(a, b, { edgeType: "family", color: EDGE_COLORS.family, size: 1, pair: true });
      }
      any = true;
    }
    this._hasPairs = any;
  }

  /** Transitively add every partner of anyone in `set` into `set` (in place), so
   *  a rendered node's spouse/co-parent is always shown. A pulled-in partner may
   *  themselves partner someone new, so loop until the couple graph is complete. */
  expandWithPartners(set) {
    for (let i = 0; i < 8; i++) {
      let grew = false;
      for (const [a, b] of this.detectCouples(set, { requireBoth: false })) {
        if (!set.has(a)) { set.add(a); grew = true; }
        if (!set.has(b)) { set.add(b); grew = true; }
      }
      if (!grew) break;
    }
  }

  /** Re-seed the force view from fresh random positions and re-run the layout -
   *  an "alternative arrangement" shuffle. Only meaningful for the ego/graph view
   *  (Mesh/Orbit/Reach/Clusters are deterministic). */
  reshuffleLayout() {
    if (this.mode !== "ego" || this.view.order === 0) return;
    const R = 100 * Math.sqrt(Math.max(1, this.view.order) / 50);
    this.view.forEachNode((id) => {
      const ang = Math.random() * 2 * Math.PI;
      const r = R * (0.35 + Math.random());
      this.view.mergeNodeAttributes(id, { x: r * Math.cos(ang), y: r * Math.sin(ang) });
    });
    this.runEgoLayout();
  }

  /** Home: show the WHOLE graph (every node + connection) centred on you.
   *  Above a scale threshold the force layout is too heavy, so fall back to the
   *  deterministic circular Mesh (which handles the whole network cheaply). */
  focusAll(centerId) {
    if (!this.full) return;
    if (this.full.order > 1200) { this.showMesh(); return; } // scale guard
    this.mode = "ego";
    this.center = centerId;
    this.clearPath();
    const all = new Set(this.full.nodes());
    this.buildView(all, centerId, { render: false });
    this.drawCoupleBonds(this.detectCouples(new Set(this.view.nodes()), { requireBoth: true }));
    this.runEgoLayout(); // paints + frames once the layout settles (no seed flash)
  }

  nodeColor(id, attrs, isCenter = false) {
    if (isCenter) return this.theme.center;
    if (attrs.isOwner) return this.theme.ownerFill; // "you" - a distinct gold (theme-aware)
    // Deceased: a sober, desaturated white fill - a quiet memorial that reads
    // distinctly from the org/community hues without an attention-grabbing glow.
    if (attrs.deceased) return "#d7dbe4";
    if (this.colorMode === "community") {
      const c = this.communities.get(String(id)) ?? 0;
      return COMMUNITY_COLORS[c % COMMUNITY_COLORS.length];
    }
    return orgColor(attrs.org);
  }

  nodeSize(degree) {
    return 1.5 * Math.max(3, Math.min(16, 2.5 + Math.sqrt(degree ?? 1) * 1.6));
  }

  setMinimapVisible(v) {
    this.minimapVisible = v;
    localStorage.setItem("orbit-minimap", v ? "1" : "0");
    this.applyMinimapVisibility();
    if (v) this.drawMinimap();
  }

  /** The minimap (and its "show" toggle) only make sense when the visible graph
   *  has nodes. Keep both hidden on the empty/onboarding state, without touching
   *  the user's saved minimap preference. */
  applyMinimapVisibility() {
    const hasNodes = !!this.view && this.view.order > 0;
    this.minimapWrap.hidden = !(this.minimapVisible && hasNodes);
    this.minimapShow.hidden = !(!this.minimapVisible && hasNodes);
    // Shuffle only re-lays the force view; the other layouts are deterministic.
    if (this.mmShuffle) this.mmShuffle.hidden = this.mode !== "ego";
  }

  /** Little overview map: all nodes at their rendered positions + a viewport box. */
  drawMinimap() {
    if (!this.minimapVisible || !this.minimapWrap || this.minimapWrap.hidden) return;
    const W = 180, H = 130, pad = 10;
    const dpr = window.devicePixelRatio || 1;
    const cvs = this.minimapCanvas;
    if (cvs.width !== Math.round(W * dpr)) {
      cvs.width = Math.round(W * dpr); cvs.height = Math.round(H * dpr);
      cvs.style.width = `${W}px`; cvs.style.height = `${H}px`;
    }
    const ctx = cvs.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // getNodeDisplayData gives framed coords (same space as the camera state).
    const pts = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    this.view.forEachNode((id) => {
      const d = this.sigma.getNodeDisplayData(id);
      if (!d) return;
      pts.push({ id, x: d.x, y: d.y, color: this.view.getNodeAttribute(id, "color") });
      minX = Math.min(minX, d.x); maxX = Math.max(maxX, d.x);
      minY = Math.min(minY, d.y); maxY = Math.max(maxY, d.y);
    });
    if (!pts.length) { this._mmMap = null; return; }
    const spanX = Math.max(1e-6, maxX - minX), spanY = Math.max(1e-6, maxY - minY);
    const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
    const ox = (W - spanX * scale) / 2, oy = (H - spanY * scale) / 2;
    // Framed coords are Y-up (as sigma renders them on screen), but the canvas
    // is Y-down, so flip Y here or the minimap comes out vertically mirrored
    // relative to the main view.
    const toMap = (x, y) => ({ x: ox + (x - minX) * scale, y: oy + (maxY - y) * scale });
    this._mmMap = { minX, minY, maxY, scale, ox, oy };
    // edges
    ctx.strokeStyle = "rgba(140,150,170,0.22)"; ctx.lineWidth = 0.5;
    this.view.forEachEdge((_k, _a, s, t) => {
      const ds = this.sigma.getNodeDisplayData(s), dt = this.sigma.getNodeDisplayData(t);
      if (!ds || !dt) return;
      const p1 = toMap(ds.x, ds.y), p2 = toMap(dt.x, dt.y);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    });
    // nodes
    for (const n of pts) {
      const p = toMap(n.x, n.y);
      ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, 2 * Math.PI);
      ctx.fillStyle = n.color || "#8b9bb4"; ctx.fill();
    }
    // Viewport rectangle: convert the ACTUAL on-screen corners into the same
    // framed space the nodes are drawn in. Deriving it from the real canvas
    // corners tracks pan, zoom, and the canvas aspect ratio - the old
    // cam.ratio/2 square assumed a square viewport, so the box never matched a
    // wide canvas.
    const { width, height } = this.sigma.getDimensions();
    const tl = this.sigma.viewportToFramedGraph({ x: 0, y: 0 });
    const br = this.sigma.viewportToFramedGraph({ x: width, y: height });
    const a = toMap(tl.x, tl.y), b = toMap(br.x, br.y);
    ctx.strokeStyle = this.theme.pathHi; ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  }

  /** Pan the main camera to the framed point under the minimap cursor. */
  panFromMinimap(ev) {
    const m = this._mmMap;
    if (!m) return;
    const rect = this.minimapCanvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const fx = m.minX + (mx - m.ox) / m.scale;
    const fy = m.maxY - (my - m.oy) / m.scale; // inverse of the Y-flipped toMap
    const cam = this.sigma.getCamera();
    cam.setState({ x: fx, y: fy, ratio: cam.getState().ratio, angle: cam.getState().angle });
  }

  /** Frame the current view with margin so nodes don't hug the canvas edges.
   *  Sigma normalizes a 2-node view to the exact [0,1] extremes, which would put
   *  a node right at the edge (clipped by the sidebar); small views get more
   *  breathing room. Centring at 0.5 keeps it centred in the visible canvas
   *  (the panel is a flex sibling, so the canvas is already sized to fit). */
  fitCamera() {
    // Ratio 1 keeps nodes at full on-screen size (margin comes from stagePadding).
    // Only the tiny 2-node case zooms out a touch, since its two points otherwise
    // sit at the exact horizontal extremes.
    const ratio = this.view.order <= 2 ? 1.25 : 1;
    this.sigma.getCamera().animate({ x: 0.5, y: 0.5, ratio, angle: 0 }, { duration: reducedMotion ? 0 : 300 });
  }

  /** Multiply the camera zoom (ratio < 1 zooms in). Clamped to a sane range. */
  zoomBy(factor) {
    const cam = this.sigma.getCamera();
    const s = cam.getState();
    cam.animate({ ...s, ratio: Math.max(0.02, Math.min(30, s.ratio * factor)) }, { duration: reducedMotion ? 0 : 200 });
  }
  zoomIn() { this.zoomBy(1 / 1.4); }
  zoomOut() { this.zoomBy(1.4); }
  /** "Actual" / fit-to-window - tree uses its fixed-scale fit, others fit-all. */
  zoomFit() { if (this.mode === "tree") this.fitTreeCamera(); else this.fitCamera(); }

  // ---------------------------------------------------------------- ego --
  focus(centerId, depth = 1) {
    if (!this.full || !this.full.hasNode(centerId)) return;
    this.mode = "ego";
    this.center = centerId;
    this.clearPath();

    const seen = new Set([String(centerId)]);
    let frontier = [String(centerId)];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const n of frontier) {
        this.full.forEachNeighbor(n, (nb) => {
          if (!seen.has(nb)) { seen.add(nb); next.push(nb); }
        });
      }
      frontier = next;
    }
    this.expandWithPartners(seen); // a shown node's partner is always pulled in
    this.buildView(seen, centerId, { render: false });
    this.drawCoupleBonds(this.detectCouples(new Set(this.view.nodes()), { requireBoth: true }));
    this.runEgoLayout(); // paints + frames once the layout settles (no seed flash)
  }

  // --------------------------------------------------------------- mesh --
  /** Full-mesh view: every contact evenly spaced on a circle (stable id
   *  order), every real connection drawn as a straight chord. Deterministic -
   *  no force pass and nothing streams into it, so it never drifts. The
   *  emergent shape reflects the actual adjacency (sparse data -> sparse
   *  chords; dense data -> the classic interconnected mesh). */
  showMesh() {
    if (!this.full) return;
    this.mode = "mesh";
    this.center = null;
    this.clearPath();
    // Stable, deterministic order around the ring: ascending contact id.
    const ordered = [...this.full.nodes()].sort((a, b) => Number(a) - Number(b));
    this.buildView(new Set(ordered), null, { layout: "circle" });
    this.fitCamera();
  }

  // -------------------------------------------------------------- orbit --
  /** Orbit rings: you at the centre, everyone else on concentric rings by how
   *  overdue you are to reach out (inner = recently/on-time in touch, outer =
   *  drifting away/never), grouped angularly by community. Deterministic - no
   *  worker. The signature ego view the app is named for. */
  showOrbit() {
    if (!this.full) return;
    this.mode = "orbit";
    this.center = this.ownerNode() ?? this.hub();
    this.clearPath();
    const all = new Set(this.full.nodes());
    this.buildView(all, this.center, { render: false }); // positions overwritten below
    this.applyOrbitLayout();
    this.sigma.refresh();
    this.fitCamera();
  }

  /** Ring value (0 = you at centre, 5 = outermost) for the chosen metric.
   *  recency/cadence bucket into 5 bands; degree/betweenness are normalized so
   *  the biggest hub/bridge sits innermost and the smallest outermost. */
  orbitRing(id) {
    const a = this.full.getNodeAttributes(id);
    if (this.orbitMetric === "degree") {
      return 1 + (1 - this.full.degree(id) / this._orbitMax) * 4;
    }
    if (this.orbitMetric === "betweenness") {
      const b = this.betweenness[Number(id)] ?? 0;
      return 1 + (1 - b / this._orbitMax) * 4;
    }
    const last = a.lastInteractionAt;
    if (this.orbitMetric === "cadence") {
      if (last == null || !a.cadenceDays) return 5; // no cadence / never touched -> outer
      const ratio = (Date.now() - last) / 86400000 / a.cadenceDays;
      return ratio < 0.5 ? 1 : ratio < 1 ? 2 : ratio < 2 ? 3 : ratio < 4 ? 4 : 5;
    }
    // recency (default)
    if (last == null) return 5;
    const days = (Date.now() - last) / 86400000;
    return days < 30 ? 1 : days < 90 ? 2 : days < 180 ? 3 : days < 365 ? 4 : 5;
  }

  /** Labels for the guide rings, per metric (inner -> outer). */
  orbitLabels() {
    switch (this.orbitMetric) {
      case "degree": return ["", "most connected", "", "", "", "least"];
      case "betweenness": return ["", "key bridges", "", "", "", "leaves"];
      case "cadence": return ["", "on time", "slipping", "overdue", "very overdue", "no cadence"];
      default: return ["", "in touch", "recent", "fading", "stale", "drifting"];
    }
  }

  /** Switch the Orbit ring metric. `betweenness` is a map passed from the app
   *  (computed off-thread); the others are read from node attrs. */
  setOrbitMetric(metric, betweenness) {
    this.orbitMetric = metric;
    if (betweenness) this.betweenness = betweenness;
    if (this.mode === "orbit") {
      this.applyOrbitLayout();
      this.sigma.refresh();
      this.fitCamera();
    }
  }

  applyOrbitLayout() {
    const centerStr = this.center != null ? String(this.center) : null;
    if (!this.communities.size) this.computeCommunities(); // angular grouping
    const nodes = [];
    this.view.forEachNode((id) => { if (id !== centerStr) nodes.push(id); });
    const total = nodes.length || 1;
    // Metric max for the normalized rings (degree/betweenness).
    this._orbitMax = 1;
    if (this.orbitMetric === "degree") {
      for (const id of nodes) this._orbitMax = Math.max(this._orbitMax, this.full.degree(id));
    } else if (this.orbitMetric === "betweenness") {
      for (const id of nodes) this._orbitMax = Math.max(this._orbitMax, this.betweenness[Number(id)] ?? 0);
      this._orbitMax = Math.max(this._orbitMax, 1e-9);
    }
    this.orbitRingGap = 120 * Math.sqrt(Math.max(9, total)) / 5; // outer ring scales with size
    if (centerStr && this.view.hasNode(centerStr)) this.view.mergeNodeAttributes(centerStr, { x: 0, y: 0 });

    // Group into community wedges; each wedge's angular width ∝ its member count.
    const byComm = new Map();
    for (const id of nodes) {
      const c = this.communities.get(id) ?? 0;
      if (!byComm.has(c)) byComm.set(c, []);
      byComm.get(c).push(id);
    }
    let a0 = 0.42; // phase offset keeps a single wedge off the axis
    for (const members of byComm.values()) {
      members.sort((x, y) => Number(x) - Number(y)); // stable within a wedge
      const width = (2 * Math.PI * members.length) / total;
      members.forEach((id, i) => {
        const angle = a0 + (width * (i + 0.5)) / members.length;
        const r = this.orbitRing(id) * this.orbitRingGap;
        this.view.mergeNodeAttributes(id, { x: r * Math.cos(angle), y: r * Math.sin(angle) });
      });
      a0 += width;
    }
  }

  /** Faint dashed guide circles + labels for the Orbit rings (viewport space). */
  drawOrbitGuides(ctx) {
    const c = this.sigma.graphToViewport({ x: 0, y: 0 });
    const labels = this.orbitLabels();
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.textAlign = "center";
    ctx.font = "11px ui-monospace, monospace";
    for (let ring = 1; ring <= 5; ring++) {
      const e = this.sigma.graphToViewport({ x: ring * this.orbitRingGap, y: 0 });
      const rPx = Math.hypot(e.x - c.x, e.y - c.y);
      if (rPx < 8) continue;
      ctx.beginPath();
      ctx.arc(c.x, c.y, rPx, 0, 2 * Math.PI);
      ctx.strokeStyle = "rgba(160,172,196,0.32)";
      ctx.lineWidth = 1.25;
      ctx.stroke();
      // label chip sits at the top of each ring, on a small dark backing so it
      // reads over the edges.
      const ly = c.y - rPx + 4;
      if (ly > 2) {
        ctx.font = "600 11px ui-monospace, monospace";
        const tw = ctx.measureText(labels[ring]).width;
        ctx.fillStyle = "rgba(10,15,28,0.72)";
        ctx.fillRect(c.x - tw / 2 - 5, ly - 9, tw + 10, 15);
        ctx.fillStyle = "rgba(190,200,220,0.85)";
        ctx.fillText(labels[ring], c.x, ly);
      }
    }
    ctx.restore();
  }

  // --------------------------------------------------------------- reach --
  /** Reach tree: you at the centre, everyone placed on a radial tree by shortest
   *  hop-distance from you (1-hop, 2-hop, …), angle allocated by subtree so
   *  branches fan out cleanly. Deterministic BFS - "how far is everyone from me,
   *  and who's the bridge to whom." Disconnected contacts sit on an outer ring. */
  showReach() {
    if (!this.full) return;
    this.mode = "reach";
    this.center = this.ownerNode() ?? this.hub();
    this.clearPath();
    this.buildView(new Set(this.full.nodes()), this.center, { render: false });
    this.applyReachLayout();
    this.sigma.refresh();
    this.fitCamera();
  }

  applyReachLayout() {
    const root = this.center != null ? String(this.center) : null;
    if (root == null || !this.full.hasNode(root)) return;
    // BFS from you: depth + first-discoverer parent (deterministic neighbour order).
    const depth = new Map([[root, 0]]);
    const children = new Map();
    this.reachParent = new Map();
    this.reachPath = new Set();
    this.reachPathEdges = new Set();
    const queue = [root];
    while (queue.length) {
      const u = queue.shift();
      for (const w of [...this.full.neighbors(u)].sort((a, b) => Number(a) - Number(b))) {
        if (!depth.has(w)) {
          depth.set(w, depth.get(u) + 1);
          if (!children.has(u)) children.set(u, []);
          children.get(u).push(w);
          this.reachParent.set(w, u);
          queue.push(w);
        }
      }
    }
    let maxDepth = 1;
    for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
    // Leaf counts size each subtree's angular wedge.
    const leaves = new Map();
    const countLeaves = (u) => {
      const ch = children.get(u);
      if (!ch || !ch.length) { leaves.set(u, 1); return 1; }
      let s = 0; for (const c of ch) s += countLeaves(c);
      leaves.set(u, s); return s;
    };
    countLeaves(root);
    // Assign each node the mid-angle of its wedge; children split the parent's arc.
    const angle = new Map();
    const assign = (u, a0, a1) => {
      angle.set(u, (a0 + a1) / 2);
      const ch = children.get(u);
      if (!ch) return;
      let a = a0;
      for (const c of ch) {
        const span = (a1 - a0) * (leaves.get(c) / leaves.get(u));
        assign(c, a, a + span);
        a += span;
      }
    };
    assign(root, 0.42, 0.42 + 2 * Math.PI);

    this.reachGap = 130 * Math.sqrt(Math.max(9, this.view.order)) / (maxDepth + 1);
    this.reachMaxDepth = maxDepth;
    const unreachedR = (maxDepth + 1) * this.reachGap;
    const n = this.full.order || 1;
    this.view.forEachNode((id) => {
      if (id === root) { this.view.mergeNodeAttributes(id, { x: 0, y: 0 }); return; }
      const d = depth.get(id);
      if (d == null) { // not connected to you: park on an outer ring by id
        const ang = (2 * Math.PI * Number(id)) / n + 0.42;
        this.view.mergeNodeAttributes(id, { x: unreachedR * Math.cos(ang), y: unreachedR * Math.sin(ang) });
        return;
      }
      const ang = angle.get(id) ?? 0;
      const r = d * this.reachGap;
      this.view.mergeNodeAttributes(id, { x: r * Math.cos(ang), y: r * Math.sin(ang) });
    });
  }

  /** Reach: build the chain of nodes/edges from `node` back up to "you" along
   *  the BFS tree, so hovering lights the whole route to the centre. */
  traceReachPath(node) {
    const nodes = new Set();
    const edges = new Set();
    let cur = String(node);
    nodes.add(cur);
    // Follow parents to the root; guard against cycles with a step cap.
    for (let i = 0; i < this.view.order && this.reachParent.has(cur); i++) {
      const parent = String(this.reachParent.get(cur));
      edges.add(`${cur}|${parent}`);
      nodes.add(parent);
      cur = parent;
    }
    this.reachPath = nodes;
    this.reachPathEdges = edges;
  }

  /** Any view: light the shortest path from `node` to "you" (the owner) through
   *  the visible graph, so hovering shows both the node's direct connections and
   *  its route to you. Empty if the owner isn't shown or is unreachable. */
  traceOwnerPath(node) {
    const start = String(node);
    const nodes = new Set([start]);
    const edges = new Set();
    const owner = this.ownerNode();
    const target = owner != null ? String(owner) : null;
    if (target == null || target === start || !this.view.hasNode(target) || !this.view.hasNode(start)) {
      this.reachPath = nodes; this.reachPathEdges = edges; return;
    }
    // BFS from the hovered node to the owner (unweighted shortest path).
    const prev = new Map();
    const seen = new Set([start]);
    const queue = [start];
    let found = false;
    while (queue.length) {
      const u = queue.shift();
      if (u === target) { found = true; break; }
      for (const w of this.view.neighbors(u)) {
        if (!seen.has(w)) { seen.add(w); prev.set(w, u); queue.push(w); }
      }
    }
    if (found) {
      let cur = target;
      nodes.add(cur);
      while (prev.has(cur)) {
        const p = prev.get(cur);
        edges.add(`${cur}|${p}`);
        nodes.add(p);
        cur = p;
      }
    }
    this.reachPath = nodes;
    this.reachPathEdges = edges;
  }

  /** Toggle the faint-edge mode (persisted); re-render so it takes effect. */
  setEdgeFade(on) {
    this.edgeFade = !!on;
    localStorage.setItem("orbit-edge-fade", this.edgeFade ? "1" : "0");
    this.sigma?.refresh();
  }

  /** Faint dashed guide circles + "N hops" labels for the Reach tree. */
  drawReachGuides(ctx) {
    const c = this.sigma.graphToViewport({ x: 0, y: 0 });
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.textAlign = "center";
    for (let d = 1; d <= this.reachMaxDepth; d++) {
      const e = this.sigma.graphToViewport({ x: d * this.reachGap, y: 0 });
      const rPx = Math.hypot(e.x - c.x, e.y - c.y);
      if (rPx < 8) continue;
      ctx.beginPath();
      ctx.arc(c.x, c.y, rPx, 0, 2 * Math.PI);
      ctx.strokeStyle = "rgba(160,172,196,0.28)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // Label in the empty band between this ring and the previous one (nodes sit
      // ON the rings, so the mid-band never covers a node).
      const mid = this.sigma.graphToViewport({ x: (d - 0.5) * this.reachGap, y: 0 });
      const midPx = Math.hypot(mid.x - c.x, mid.y - c.y);
      const ly = c.y - midPx + 4;
      if (ly > 2) {
        const label = `${d} hop${d > 1 ? "s" : ""}`;
        ctx.font = "600 11px ui-monospace, monospace";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(10,15,28,0.72)";
        ctx.fillRect(c.x - tw / 2 - 5, ly - 9, tw + 10, 15);
        ctx.fillStyle = "rgba(190,200,220,0.85)";
        ctx.fillText(label, c.x, ly);
      }
    }
    ctx.restore();
  }

  // --------------------------------------------------------------- tree --
  /** Interactive family tree. Starts at YOU (+ spouse); each focused person shows
   *  directional expanders - ↑ parents, ↓ children, siblings on the person's
   *  gender side (male left, female right). Only expanded branches are drawn, so a
   *  big family stays legible. Generation lanes materialise on demand; couples read
   *  as a unit; connectors are drawn orthogonally on the overlay. Deterministic. */
  showTree() {
    if (!this.full) return;
    this.mode = "tree";
    // The tree centres on You by default, or on the ANCHOR pair when one is chosen.
    const owner = this.ownerNode() ?? this.hub();
    this.center = (this.treeAnchor != null && this.full.hasNode(String(this.treeAnchor)))
      ? Number(this.treeAnchor) : owner;
    this.clearPath();
    this.setNodeSizeMode(true); // constant node size at the tree's fixed zoom
    this.treeExpanded = new Set();  // "personId|dir" (dir: up | down | sib)
    this.treeActive = null;         // the node whose expanders are shown
    this.treeHoverNode = null;      // node under the cursor (its flows glow green)
    this.treeGen = this.familyGenerations(this.center); // generations relative to the centre
    const center = String(this.center);
    const expand = (id, dir) => { if (this.treeReveal(id, dir).size) this.treeExpanded.add(`${id}|${dir}`); };
    if (this.treeAnchor != null) {
      // Anchored: open the anchor pair's whole extended family - parents & grandparents,
      // aunts/uncles, siblings + their children, children + grandchildren.
      for (const m of [center, ...this.familyPartnersOf(center)]) for (const d of ["up", "down", "sib"]) expand(m, d);
      this.computeTreeVisible();
      for (const id of [...this.treeVisible]) {
        const g = this.treeGen.get(id);
        if (g === -1) { expand(id, "up"); expand(id, "sib"); }   // parents -> grandparents + aunts/uncles
        else if (g === 1) expand(id, "down");                    // children -> grandchildren
        else if (g === 0 && id !== center) expand(id, "down");   // siblings/partners -> their children
      }
    } else {
      // Default landing: parents + children of BOTH members of the you-pair (no siblings),
      // so the tree opens on your immediate household, not just you.
      for (const id of [center, ...this.familyPartnersOf(center)]) for (const d of ["up", "down"]) expand(id, d);
    }
    this.rebuildTree();
    this.treeActive = center;
    this.renderTreeExpanders();
    return this.treeVisible.size;
  }

  /** Anchor pairs for the dropdown: every visible couple in your family component,
   *  labelled "[Level n] X - Y" where n is the generation relative to You (0 = you,
   *  negative = ancestors, positive = descendants). Unpaired people are listed too
   *  (label is just their name). Sorted by level, then name. */
  treeAnchorOptions() {
    const owner = this.ownerNode() ?? this.hub();
    if (owner == null || !this.full) return [];
    const gen = this.familyGenerations(owner); // level relative to You
    const done = new Set();
    const out = [];
    const name = (id) => this.full.getNodeAttribute(id, "name") || `#${id}`;
    for (const id of gen.keys()) {
      if (done.has(id) || !this.full.hasNode(id)) continue;
      done.add(id);
      const level = gen.get(id) ?? 0;
      const partner = [...this.familyPartnersOf(id)].find((p) => gen.has(p) && !done.has(p));
      let members = name(id);
      if (partner) { done.add(partner); members = `${name(id)} - ${name(partner)}`; }
      out.push({ id: Number(id), level, label: `[Level ${level}] ${members}` });
    }
    out.sort((a, b) => a.level - b.level || a.label.localeCompare(b.label));
    return out;
  }

  /** Re-root the tree on `id` (its pair), or pass null to return to the default (You). */
  setTreeAnchor(id) {
    this.treeAnchor = (id != null && this.full && this.full.hasNode(String(id))) ? Number(id) : null;
    if (this.mode === "tree") this.showTree();
  }

  /** Iterate over a person's family edges (kin present), giving (neighbour, kin). */
  eachFamilyEdge(u, cb) {
    this.full.forEachEdge(u, (_k, a, s, t) => {
      if (a.type === "family" && a.metadata && a.metadata.kin) cb(s === u ? t : s, a.metadata.kin);
    });
  }

  /** Full-graph partners of `id` (spouse or co-parent), regardless of visibility. */
  familyPartnersOf(id) {
    const out = new Set();
    this.eachFamilyEdge(id, (nb, kin) => {
      if (isSpouseEdge(kin, id, nb)) out.add(nb);
      if (isChildEdge(kin, id, nb)) this.eachFamilyEdge(nb, (p, k2) => {
        if (p !== id && isChildEdge(k2, p, nb)) out.add(p);
      });
    });
    return out;
  }

  /** Full-graph parents of `id` (one generation up). */
  familyParentsOf(id) {
    const out = new Set();
    this.eachFamilyEdge(id, (nb, kin) => { if (genDeltaAcross(kin, id, nb) === -1) out.add(nb); });
    return out;
  }

  /** Full-graph children of `id` (one generation down). */
  familyChildrenOf(id) {
    const out = new Set();
    this.eachFamilyEdge(id, (nb, kin) => { if (genDeltaAcross(kin, id, nb) === 1) out.add(nb); });
    return out;
  }

  /** Nodes revealed by expanding `id` in a direction (relatives + their partners).
   *  Siblings are found both directly AND as the other children of `id`'s parents
   *  (siblings are usually linked to a shared parent, not to each other). */
  treeReveal(id, dir) {
    const out = new Set();
    const add = (m) => { out.add(m); for (const p of this.familyPartnersOf(m)) out.add(p); };
    if (dir === "up") {
      for (const p of this.familyParentsOf(id)) add(p);
    } else if (dir === "down") {
      for (const c of this.familyChildrenOf(id)) add(c);
    } else if (dir === "sib") {
      this.eachFamilyEdge(id, (nb, kin) => {
        if (genDeltaAcross(kin, id, nb) === 0 && isSiblingEdge(kin, id, nb)) add(nb);
      });
      for (const parent of this.familyParentsOf(id)) for (const c of this.familyChildrenOf(parent)) if (c !== id) add(c);
    }
    return out;
  }

  /** A node's full blood-sibling group, transitively: sibling edges AND shared
   *  parents, closed over, so a sibling-of-a-sibling (linked only pairwise) is
   *  included. Excludes `id` itself. */
  treeSiblingGroup(id) {
    const group = new Set([String(id)]);
    const queue = [String(id)];
    while (queue.length) {
      const u = queue.shift();
      const nbs = [];
      this.eachFamilyEdge(u, (nb, kin) => { if (genDeltaAcross(kin, u, nb) === 0 && isSiblingEdge(kin, u, nb)) nbs.push(nb); });
      for (const p of this.familyParentsOf(u)) for (const c of this.familyChildrenOf(p)) if (c !== u) nbs.push(c);
      for (const nb of nbs) if (!group.has(nb)) { group.add(nb); queue.push(nb); }
    }
    group.delete(String(id));
    return group;
  }

  /** The set of nodes lit when tree node `id` is hovered. Two modes:
   *
   *  DEFAULT (vertical): node + partner; its own siblings + partners (same level, NOT
   *  their children); ancestors up to grandparents (2 levels), both mother & father
   *  lines, with partners; children (down 1) + partners; grandchildren (down 2) +
   *  partners.
   *
   *  EXTENDED: node + partner; its own siblings + partners AND their children (nieces/
   *  nephews) + partners; ALL ancestors up, both lines, with partners; children (down 1)
   *  + partners; grandchildren (down 2) + partners.
   *
   *  So the only differences are: ancestors go 2 levels (default) vs all (extended), and
   *  the node's siblings' children come in only in extended. Every "level" is completed
   *  through the transitive sibling group so a relative linked only to a sibling (not to
   *  the connecting parent) is not missed. Visible-only. */
  treeActiveFamily(id) {
    const extended = !!this.treeExtended;
    const vis = this.treeVisible;
    const idS = String(id);
    const V = (x) => vis.has(x);
    const A = new Set();
    const sibsOf = (x) => [...this.treeSiblingGroup(x)].filter(V);
    // A person's visible children - direct, plus those recorded only against a partner
    // (co-parented) - completed through the children's sibling groups.
    const kidsOf = (x) => {
      const out = new Set();
      for (const c of this.familyChildrenOf(x)) if (V(c)) out.add(c);
      for (const p of this.familyPartnersOf(x)) if (V(p)) for (const c of this.familyChildrenOf(p)) if (V(c)) out.add(c);
      for (const c of [...out]) for (const s of sibsOf(c)) out.add(s);
      return out;
    };
    // Add each node with its partner(s).
    const addPair = (nodes) => { for (const n of nodes) if (V(n)) { A.add(n); for (const p of this.familyPartnersOf(n)) if (V(p)) A.add(p); } };

    // --- the node itself + partner ---
    addPair([idS]);
    // --- own siblings + partners (same level). Extended also adds their children. ---
    const sibs = sibsOf(idS);
    addPair(sibs);
    if (extended) { const nn = new Set(); for (const s of sibs) for (const c of kidsOf(s)) nn.add(c); addPair([...nn]); }
    // --- ancestors up. Default: 2 levels; extended: all. At each level a node's
    // effective parents are the parents of its whole SIBLING GROUP (siblings share
    // parents), each completed with their partner (co-parent). So a parent recorded
    // only against a sibling (no direct parent edge, e.g. Prasad) still exposes the
    // shared parents/grandparents to any descendant, via any node in the parent union;
    // and both partners of a pair are treated symmetrically (both climb the walk). ---
    const effParents = (n) => {
      const out = new Set();
      for (const s of [n, ...this.treeSiblingGroup(n)]) if (V(s))
        for (const p of this.familyParentsOf(s)) if (V(p)) {
          out.add(p); for (const cp of this.familyPartnersOf(p)) if (V(cp)) out.add(cp);
        }
      return out;
    };
    const maxUp = extended ? 999 : 2;
    let frontier = [idS, ...this.familyPartnersOf(idS)].filter(V);
    for (let lvl = 1; lvl <= maxUp && frontier.length; lvl++) {
      const next = new Set();
      for (const n of frontier) for (const p of effParents(n)) next.add(p);
      addPair([...next]);
      // Extended: also light each ancestor's siblings and their pairs (the aunts/uncles
      // on BOTH parents' lines) - e.g. hovering Siyani surfaces her uncle Prasad's pair,
      // and Aditya surfaces Giri's pair. The walk still climbs only through `next`.
      if (extended) for (const p of [...next]) addPair([...this.treeSiblingGroup(p)].filter(V));
      frontier = [...next];
    }
    // --- children (down 1) + partners ---
    const kids = kidsOf(idS);
    addPair([...kids]);
    // --- grandchildren (down 2) + partners (from the node's own children only) ---
    const grand = new Set();
    for (const k of kids) for (const gc of kidsOf(k)) grand.add(gc);
    addPair([...grand]);

    A.delete(idS);
    return A;
  }

  /** The reveal state of a direction: "none", "collapsed", "expanded".
   *  "none" when there are no such relatives OR they are already all on screen
   *  (e.g. a node pulled in by a parent's "down" already shows its siblings, and
   *  its parents; offering those expanders again would do nothing). */
  treeDirState(id, dir) {
    const reveal = this.treeReveal(id, dir);
    if (reveal.size === 0) return "none";
    // Expanded, but only worth a collapse button if it actually holds nodes on screen.
    // A redundant expansion (its relatives are kept visible by another branch) does
    // nothing when collapsed, so we hide its button rather than show a dead "−".
    if (this.treeExpanded.has(`${id}|${dir}`))
      return this.treeLoadBearing().has(`${id}|${dir}`) ? "expanded" : "none";
    const hasNew = [...reveal].some((m) => this.full.hasNode(m) && !this.treeVisible.has(m));
    return hasNew ? "collapsed" : "none";
  }

  /** The subset of currently-expanded `${id}|${dir}` keys whose collapse would actually
   *  remove a node from view. Computed by dropping each expansion and checking whether
   *  the visible set shrinks; cached against the expansion signature so it recomputes
   *  only when the tree structure changes (not on every camera/hover re-render). */
  treeLoadBearing() {
    const full = new Set(this.treeExpanded);
    const sig = [...full].sort().join(";") + "#" + this.center;
    if (this._lbSig === sig && this._lbSet) return this._lbSet;
    const base = this.computeTreeVisible().size; // with `full` expansions
    const load = new Set();
    for (const key of full) {
      // A couple's ↓ children live on both partners' down keys; test them as a unit so a
      // jointly-load-bearing collapse still lights the shared button (neither key alone
      // shrinks the set because the partner holds the kids).
      const rm = new Set([key]);
      const [pid, dir] = key.split("|");
      if (dir === "down") for (const p of this.familyPartnersOf(pid)) if (full.has(`${p}|down`)) rm.add(`${p}|down`);
      this.treeExpanded = new Set([...full].filter((k) => !rm.has(k)));
      if (this.computeTreeVisible().size < base) load.add(key);
    }
    this.treeExpanded = full;
    this.computeTreeVisible(); // restore this.treeVisible to the real state
    this._lbSig = sig; this._lbSet = load;
    return load;
  }

  /** Derive the visible set from the expanded directions (fixpoint), closed under
   *  partners so a couple is always shown together. */
  computeTreeVisible() {
    const anchor = String(this.center);
    const visible = new Set([anchor]);
    for (const p of this.familyPartnersOf(anchor)) visible.add(p);
    let changed = true, guard = 0;
    while (changed && guard++ < 2000) {
      changed = false;
      for (const id of [...visible]) {
        for (const dir of ["up", "down", "sib"]) {
          if (this.treeExpanded.has(`${id}|${dir}`)) {
            for (const m of this.treeReveal(id, dir)) if (this.full.hasNode(m) && !visible.has(m)) { visible.add(m); changed = true; }
          }
        }
        for (const p of this.familyPartnersOf(id)) if (this.full.hasNode(p) && !visible.has(p)) { visible.add(p); changed = true; }
      }
    }
    this.treeVisible = visible;
    return visible;
  }

  /** Toggle a person's expander; recompute + re-render, keeping the camera steady.
   *  A couple's ↓ children expansion lives on BOTH partners (either may hold the shared
   *  kids), so toggling "down" flips both together - otherwise collapsing one partner
   *  leaves the kids held by the other and the button appears to do nothing. */
  treeToggle(id, dir) {
    const keys = [`${id}|${dir}`];
    if (dir === "down") {
      const y = this.view.hasNode(id) ? Math.round(this.view.getNodeAttribute(id, "y")) : null;
      for (const p of this.familyPartnersOf(id))
        if (this.view.hasNode(p) && Math.round(this.view.getNodeAttribute(p, "y")) === y) keys.push(`${p}|down`);
    }
    const anyOn = keys.some((k) => this.treeExpanded.has(k));
    for (const k of keys) { if (anyOn) this.treeExpanded.delete(k); else this.treeExpanded.add(k); }
    this.rebuildTree(); // refit so newly revealed levels stay in view
    this.renderTreeExpanders();
  }

  /** Reveal the entire family: keep expanding every visible node in all directions
   *  until nothing new appears (fixpoint), then rebuild once. */
  treeExpandAll() {
    let prev = -1, guard = 0;
    while (this.treeVisible.size !== prev && guard++ < 200) {
      prev = this.treeVisible.size;
      for (const id of [...this.treeVisible]) {
        for (const dir of ["up", "down", "sib"]) this.treeExpanded.add(`${id}|${dir}`);
      }
      this.computeTreeVisible();
    }
    this.rebuildTree();
    this.renderTreeExpanders();
  }

  /** Toggle the "Extended" hover mode (vertical-only vs. sibling-discovery). If a
   *  node is currently hovered, re-light it under the new mode. Persisted. */
  setTreeExtended(on) {
    this.treeExtended = !!on;
    localStorage.setItem("orbit-tree-extended", this.treeExtended ? "1" : "0");
    if (this.mode === "tree" && this.treeHoverNode) {
      this.familyHighlight = this.treeActiveFamily(this.treeHoverNode);
      this.sigma.refresh();
    }
    this.drawOverlay();
  }

  /** Collapse the tree back to just you (and your partner). */
  treeCollapseAll() {
    this.treeExpanded = new Set();
    this.rebuildTree();
    this.renderTreeExpanders();
  }

  rebuildTree({ keepCamera = false } = {}) {
    this.computeTreeVisible();
    this.rebuildTreeView();
    this.layoutTree();
    this.sigma.refresh();
    if (!keepCamera) this.fitTreeCamera();
  }

  /** Frame the tree at a fixed scale: a small tree (e.g. just you + partner) is
   *  NOT blown up to fill the canvas - partners keep a steady on-screen gap. Larger
   *  trees fall back to fit-all (ratio 1) so everything stays visible. */
  fitTreeCamera() {
    const cam = this.sigma.getCamera();
    // Measure px-per-graph-unit at the auto-fit (ratio 1), then zoom out until a
    // graph unit renders at TARGET px - but never zoom IN past fit-all.
    cam.setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
    this.sigma.refresh();
    const a = this.sigma.graphToViewport({ x: 0, y: 0 });
    const b = this.sigma.graphToViewport({ x: 100, y: 0 });
    const pxPerUnit = Math.hypot(b.x - a.x, b.y - a.y) / 100 || 1;
    const TARGET = 1.35; // px per graph unit -> a couple (coupleGap ~82) sits ~110px apart
    const ratio = Math.max(1, pxPerUnit / TARGET);
    cam.animate({ x: 0.5, y: 0.5, ratio, angle: 0 }, { duration: reducedMotion ? 0 : 250 });
  }

  /** Build the sigma view from the visible set (nodes only - connectors are drawn
   *  on the overlay). */
  rebuildTreeView() {
    this.worker?.terminate(); this.worker = null;
    this.hovered = null;
    this.familyHighlight = new Set(); this.familyHighlightEdges = new Set();
    const v = this.view; v.clear();
    for (const id of this.treeVisible) {
      if (!this.full.hasNode(id)) continue;
      const a = this.full.getNodeAttributes(id);
      v.addNode(id, {
        label: "", x: 0, y: 0, // names are drawn below each node on the overlay
        size: this.nodeSize(a.degree) * 1.35,
        color: this.nodeColor(id, a), org: a.org, gender: a.gender,
        isOwner: a.isOwner, deceased: a.deceased,
      });
    }
  }

  /** Generation of each relative: BFS over FAMILY edges from `anchor`, shifting by
   *  the kin role's generation delta. Returns Map(id -> gen) for the kinship
   *  component only (people you have no kinship path to are excluded). */
  familyGenerations(anchor) {
    const gen = new Map();
    if (anchor == null || !this.full.hasNode(String(anchor))) return gen;
    const a = String(anchor);
    gen.set(a, 0);
    const queue = [a];
    while (queue.length) {
      const u = queue.shift();
      const gu = gen.get(u);
      this.full.forEachEdge(u, (_k, attrs, s, t) => {
        if (attrs.type !== "family" || !attrs.metadata || !attrs.metadata.kin) return;
        const nb = s === u ? t : s;
        if (gen.has(nb)) return;
        const delta = genDeltaAcross(attrs.metadata.kin, u, nb); // works from either side
        if (delta === undefined) return;
        gen.set(nb, gu + delta);
        queue.push(nb);
      });
    }
    return gen;
  }

  /** A person's partner(s) present in the view: a direct spouse tie, or a co-parent
   *  (someone who is also a parent of one of their children). */
  partnersInView(u) {
    const out = new Set();
    this.full.forEachEdge(u, (_k, a, s, t) => {
      if (a.type !== "family" || !a.metadata || !a.metadata.kin) return;
      const nb = s === u ? t : s;
      if (!this.view.hasNode(nb)) return;
      const kin = a.metadata.kin;
      if (isSpouseEdge(kin, u, nb)) out.add(nb);
      // co-parent: nb is u's child -> nb's other parents are u's co-parents
      if (isChildEdge(kin, u, nb)) this.full.forEachEdge(nb, (_k2, a2, s2, t2) => {
        if (a2.type !== "family" || !a2.metadata || !a2.metadata.kin) return;
        const p = s2 === nb ? t2 : s2;
        if (p !== u && this.view.hasNode(p) && isChildEdge(a2.metadata.kin, p, nb)) out.add(p);
      });
    });
    return [...out];
  }

  /** Lay out the visible set: y by generation; x placed directionally by walking
   *  the reveal structure from you (children centred below, parents above, siblings
   *  to the person's gender side), reserving space per lane so nothing overlaps. */
  layoutTree() {
    const gen = this.treeGen;
    // coupleGap (spouse-to-spouse) is kept small and the inter-unit gap large, so a
    // couple reads as one tight unit and siblings are clearly separated from it.
    const colGap = 150, coupleGap = 82, rowGap = 172, sibGap = 210, gap = 66;
    this.treeRowGap = rowGap; this.treeColGap = colGap; this.treeCoupleGap = coupleGap;
    const genderMale = (id) => (this.full.getNodeAttribute(id, "gender") || "").toLowerCase().startsWith("m");
    // Group visible people into units (a person + their visible same-gen partner).
    const unitOf = new Map();
    const units = [];
    const partnerVisible = (id) => [...this.familyPartnersOf(id)].find((p) => this.treeVisible.has(p) && gen.get(p) === gen.get(id));
    const claimed = new Set();
    for (const id of this.treeVisible) {
      if (claimed.has(id) || !this.full.hasNode(id)) continue;
      claimed.add(id);
      const members = [id];
      const partner = partnerVisible(id);
      if (partner && !claimed.has(partner)) { claimed.add(partner); members.push(partner); }
      // Order male-left / female-right within a couple.
      if (members.length === 2 && genderMale(members[1])) members.reverse();
      const u = { members, gen: gen.get(id), x: null };
      units.push(u);
      for (const m of members) unitOf.set(m, u);
    }
    const unitWidth = (u) => (u.members.length === 2 ? coupleGap + 56 : 56);
    // Per-lane interval reservation: place a slot of `width` near `cx`, shift off any overlap.
    const lanes = new Map();
    const reserve = (g, cx, width) => {
      const arr = lanes.get(g) || [];
      let x = cx - width / 2, iter = 0, overlap = true;
      while (overlap && iter++ < 800) {
        overlap = false;
        for (const [a, b] of arr) {
          if (x < b + gap && x + width > a - gap) { x = cx <= (a + b) / 2 ? a - gap - width : b + gap; overlap = true; break; }
        }
      }
      arr.push([x, x + width]); arr.sort((p, q) => p[0] - q[0]); lanes.set(g, arr);
      return x + width / 2; // centre
    };
    const placeUnit = (u, cx) => {
      if (u.x !== null) return;
      const w = unitWidth(u);
      const c = reserve(u.gen, cx, w);
      u.x = c;
      const y = -u.gen * rowGap;
      if (u.members.length === 2) {
        this.view.mergeNodeAttributes(u.members[0], { x: c - coupleGap / 2, y });
        this.view.mergeNodeAttributes(u.members[1], { x: c + coupleGap / 2, y });
      } else this.view.mergeNodeAttributes(u.members[0], { x: c, y });
    };
    // BFS from the anchor unit, placing revealed units relative to their source.
    const anchorUnit = unitOf.get(String(this.center));
    if (!anchorUnit) return;
    placeUnit(anchorUnit, 0);
    const placed = new Set([anchorUnit]);
    const queue = [anchorUnit];
    while (queue.length) {
      const u = queue.shift();
      for (const person of u.members) {
        for (const dir of ["down", "up", "sib"]) {
          if (!this.treeExpanded.has(`${person}|${dir}`)) continue;
          const relUnits = [];
          const seenU = new Set();
          for (const r of this.treeReveal(person, dir)) {
            if (!this.treeVisible.has(r)) continue;
            const un = unitOf.get(r);
            if (un && !seenU.has(un) && !placed.has(un)) { seenU.add(un); relUnits.push(un); }
          }
          if (!relUnits.length) continue;
          if (dir === "sib") {
            // Siblings are the SAME generation - place them on the person's own lane,
            // flanking the unit. A sibling bar (drawn later) links them together.
            const px = this.view.getNodeAttribute(person, "x");
            relUnits.forEach((un, i) => {
              const k = Math.floor(i / 2) + 1, side = i % 2 === 0 ? 1 : -1;
              placeUnit(un, px + side * k * sibGap); placed.add(un); queue.push(un);
            });
          } else {
            const base = dir === "down" ? u.x : this.view.getNodeAttribute(person, "x");
            const n = relUnits.length;
            relUnits.forEach((un, i) => { placeUnit(un, base + (i - (n - 1) / 2) * colGap); placed.add(un); queue.push(un); });
          }
        }
      }
    }
    for (const u of units) if (u.x === null) placeUnit(u, 0); // safety
    // Guaranteed de-overlap: group units by their actual row (rounded y) and spread
    // any that overlap. Catches every collision regardless of how units were placed.
    const byRow = new Map();
    for (const u of units) {
      const ry = Math.round(-u.gen * rowGap);
      if (!byRow.has(ry)) byRow.set(ry, []);
      byRow.get(ry).push(u);
    }
    for (const row of byRow.values()) {
      row.sort((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++) {
        const need = unitWidth(row[i - 1]) / 2 + unitWidth(row[i]) / 2 + gap;
        if (row[i].x - row[i - 1].x < need) this.shiftUnit(row[i], row[i - 1].x + need - row[i].x);
      }
    }
    this.treeGens = [...new Set(units.map((u) => u.gen))].sort((a, b) => a - b);
    this.treeOwnerGen = 0;
  }

  /** Shift a placed unit (and its member nodes) horizontally by `dx`. */
  shiftUnit(u, dx) {
    if (!dx) return;
    u.x += dx;
    for (const m of u.members) {
      if (this.view.hasNode(m)) this.view.mergeNodeAttributes(m, { x: this.view.getNodeAttribute(m, "x") + dx });
    }
  }

  /** Make `id` the active node - its directional expanders show. */
  treeActivate(id) {
    this.treeActive = this.full.hasNode(String(id)) ? String(id) : null;
    this.renderTreeExpanders();
  }

  /** Position the +/− expanders around the active COUPLE. Each partner gets their
   *  own ↑ parents and side siblings (male left, female right); the couple shares a
   *  single ↓ children (keyed to a canonical member so either partner toggles it). */
  renderTreeExpanders() {
    if (!this.treeExpanderEl) {
      this.treeExpanderEl = document.createElement("div");
      this.treeExpanderEl.className = "tree-expanders";
      this.container.append(this.treeExpanderEl);
    }
    const el = this.treeExpanderEl;
    if (this.mode !== "tree" || this.view.order === 0) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false; el.innerHTML = "";
    const male = (m) => (this.full.getNodeAttribute(m, "gender") || "").toLowerCase().startsWith("m");
    const sameRow = (a, b) => Math.round(this.view.getNodeAttribute(a, "y")) === Math.round(this.view.getNodeAttribute(b, "y"));
    const addBtn = (person, dir, dx, dy, label) => {
      const state = this.treeDirState(person, dir);
      if (state === "none") return;
      const a = this.view.getNodeAttributes(person);
      const p = this.sigma.graphToViewport({ x: a.x, y: a.y });
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tree-exp" + (state === "expanded" ? " open" : "");
      b.textContent = state === "expanded" ? "−" : "+";
      b.title = (state === "expanded" ? "Collapse " : "Expand ") + label;
      b.style.left = `${p.x + dx}px`;
      b.style.top = `${p.y + dy}px`;
      b.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
      b.addEventListener("click", (e) => { e.stopPropagation(); this.treeToggle(person, dir); });
      el.append(b);
    };
    // Every visible node gets its own expanders. Couples share one ↓ children.
    const done = new Set();
    for (const person of this.treeVisible) {
      if (done.has(person) || !this.view.hasNode(person)) continue;
      done.add(person);
      const partner = [...this.familyPartnersOf(person)].find((pn) =>
        this.treeVisible.has(pn) && this.view.hasNode(pn) && sameRow(pn, person));
      const members = partner ? [person, partner] : [person];
      if (partner) done.add(partner);
      for (const m of members) {
        let r; try { r = this.sigma.scaleSize(this.view.getNodeAttribute(m, "size")); } catch { r = 14; }
        addBtn(m, "up", 0, -(r + 15), "parents");
        addBtn(m, "sib", male(m) ? -(r + 15) : (r + 15), 0, "siblings");
      }
      const downOn = members.map(String).sort((a, b) => Number(a) - Number(b))[0];
      let rd; try { rd = this.sigma.scaleSize(this.view.getNodeAttribute(downOn, "size")); } catch { rd = 14; }
      const tier = (this._treeLabelTier && this._treeLabelTier.get(downOn)) || 0;
      addBtn(downOn, "down", 0, rd + 34 + tier * 15, "children"); // below the node's name label (clears its row)
    }
  }

  /** Orthogonal family connectors on the overlay: couple units (framed pair + bond
   *  + heart), parent→children drop-buses, and sibling bars where no parent shows. */
  drawTreeConnectors(ctx) {
    if (this.mode !== "tree" || this.view.order === 0) return;
    const vis = this.treeVisible;
    const VP = (id) => { const a = this.view.getNodeAttributes(id); return this.sigma.graphToViewport({ x: a.x, y: a.y }); };
    const RAD = (id) => { try { return this.sigma.scaleSize(this.view.getNodeAttribute(id, "size")); } catch { return 12; } };
    const sameRow = (a, b) => Math.round(this.view.getNodeAttribute(a, "y")) === Math.round(this.view.getNodeAttribute(b, "y"));
    ctx.save();
    ctx.lineJoin = "round";
    // Build every connector as a "flow" - a set of segments plus the node ids it
    // links - so hovering any member node can light the whole flow green.
    const flows = [];
    // A node's effective (visible) parents for connector purposes: its own parent
    // edges PLUS those of its blood siblings, so a sibling recorded only against a
    // sibling (no direct parent edge) still hangs off the shared parents' bus.
    const busParentsOf = (c) => {
      const set = new Set();
      for (const s of [c, ...this.treeSiblingGroup(c)]) if (vis.has(s))
        for (const p of this.familyParentsOf(s)) if (vis.has(p) && this.view.hasNode(p)) set.add(p);
      return [...set].sort();
    };
    // Parent -> children drop-buses.
    const buses = new Map();
    for (const c of vis) {
      if (!this.view.hasNode(c)) continue;
      const parents = busParentsOf(c);
      if (!parents.length) continue;
      const key = parents.join(",");
      if (!buses.has(key)) buses.set(key, { parents, kids: [] });
      buses.get(key).kids.push(c);
    }
    for (const { parents, kids } of buses.values()) {
      const pps = parents.map(VP);
      const px = pps.reduce((s, q) => s + q.x, 0) / pps.length;
      const pBottom = Math.max(...parents.map((p) => VP(p).y + RAD(p)));
      const kTop = Math.min(...kids.map((c) => VP(c).y - RAD(c)));
      const busY = pBottom + (kTop - pBottom) * 0.5;
      const kps = kids.map(VP);
      const segs = [[px, pBottom, px, busY],
        [Math.min(px, ...kps.map((k) => k.x)), busY, Math.max(px, ...kps.map((k) => k.x)), busY]];
      for (const k of kids) { const kp = VP(k); segs.push([kp.x, busY, kp.x, kp.y - RAD(k)]); }
      flows.push({ kind: "bus", segs, parents, kids, px, pBottom, busY });
    }
    // Sibling bars: link same-generation blood siblings whose sibling group shows NO
    // visible parent at all (otherwise the parent→children bus already joins them).
    const sibDone = new Set();
    for (const id of vis) {
      if (sibDone.has(id) || !this.view.hasNode(id)) continue;
      if (busParentsOf(id).length) continue;
      const blood = new Set();
      this.eachFamilyEdge(id, (nb, kin) => { if (genDeltaAcross(kin, id, nb) === 0 && isSiblingEdge(kin, id, nb)) blood.add(nb); });
      for (const parent of this.familyParentsOf(id)) for (const c of this.familyChildrenOf(parent)) if (c !== id) blood.add(c);
      const uniq = [...new Set([id, ...[...blood].filter((s) => vis.has(s) && this.view.hasNode(s))])];
      if (uniq.length < 2) continue;
      const pts = uniq.map(VP);
      const barY = Math.min(...pts.map((p) => p.y)) - RAD(id) - 14;
      const segs = [[Math.min(...pts.map((p) => p.x)), barY, Math.max(...pts.map((p) => p.x)), barY]];
      for (const g of uniq) { const p = VP(g); segs.push([p.x, barY, p.x, p.y - RAD(g)]); sibDone.add(g); }
      flows.push({ kind: "sib", segs, members: uniq, barY });
    }
    // Couple bonds (no frame - partners are just placed close together).
    const coupleDone = new Set();
    for (const id of vis) {
      if (coupleDone.has(id) || !this.view.hasNode(id)) continue;
      const partner = [...this.familyPartnersOf(id)].find((p) => vis.has(p) && this.view.hasNode(p) && sameRow(id, p));
      if (!partner) continue;
      coupleDone.add(id); coupleDone.add(partner);
      const p1 = VP(id), p2 = VP(partner), r = Math.max(RAD(id), RAD(partner));
      // Draw the bond edge-to-edge (not centre-to-centre) so the line reads as passing
      // BEHIND the node circles rather than across them.
      const [ln, rn] = p1.x <= p2.x ? [id, partner] : [partner, id];
      const lp = VP(ln), rp = VP(rn);
      flows.push({ kind: "couple", segs: [[lp.x + RAD(ln), lp.y, rp.x - RAD(rn), rp.y]], members: [id, partner],
        heart: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, r: Math.max(4, 0.42 * r) } });
    }
    // Which segments of a flow light green: only the parts that connect selected nodes.
    // A bus lights its stem + the drops to the SELECTED children (so a child's link up to
    // its parents lights even when a sibling isn't selected). Couples/sibling-bars light
    // only when their selected members connect.
    const hover = this.treeHoverNode && vis.has(String(this.treeHoverNode)) ? String(this.treeHoverNode) : null;
    // Include the hovered node itself so connectors that touch it (its couple bond,
    // its drop from its parents, its sibling bar) light too. (treeActiveFamily omits
    // the hovered node because node-dimming highlights it via `this.hovered`.)
    const active = hover ? this.treeActiveFamily(hover) : null;
    if (active) active.add(hover);
    const greenSegs = (f) => {
      if (!active) return [];
      if (f.kind === "bus") {
        if (!f.parents.every((p) => active.has(p))) return [];
        const litKids = f.kids.filter((k) => active.has(k));
        if (!litKids.length) return [];
        const kps = litKids.map(VP);
        const out = [[f.px, f.pBottom, f.px, f.busY],
          [Math.min(f.px, ...kps.map((k) => k.x)), f.busY, Math.max(f.px, ...kps.map((k) => k.x)), f.busY]];
        for (const k of litKids) { const kp = VP(k); out.push([kp.x, f.busY, kp.x, kp.y - RAD(k)]); }
        return out;
      }
      if (f.kind === "sib") {
        const lit = f.members.filter((m) => active.has(m));
        if (lit.length < 2) return [];
        const pts = lit.map(VP);
        const out = [[Math.min(...pts.map((p) => p.x)), f.barY, Math.max(...pts.map((p) => p.x)), f.barY]];
        for (const g of lit) { const p = VP(g); out.push([p.x, f.barY, p.x, p.y - RAD(g)]); }
        return out;
      }
      return (active.has(f.members[0]) && active.has(f.members[1])) ? f.segs : [];
    };
    // Grey full connectors first, then the green sub-segments on top.
    for (const f of flows) {
      ctx.strokeStyle = f.kind === "couple" ? EDGE_COLORS.family : this.theme.edge;
      ctx.lineWidth = f.kind === "couple" ? 1.6 : 1.5;
      ctx.beginPath();
      for (const s of f.segs) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }
      ctx.stroke();
    }
    ctx.strokeStyle = FLOW_HIGHLIGHT; ctx.lineWidth = 2.8;
    ctx.beginPath();
    for (const f of flows) for (const s of greenSegs(f)) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }
    ctx.stroke();
    for (const f of flows) if (f.heart) drawHeart(ctx, f.heart.x, f.heart.y, f.heart.r, PAIR_COLOR, this.theme.bg);
    // Node names (first name only, truncated), drawn below each node. To avoid
    // overlap in dense lanes without hiding anything, each lane is laid out on up to
    // two rows: a label takes the upper row unless it would collide with the previous
    // one, then it drops to the lower row (a zigzag). The chosen tier is remembered so
    // the ↓ expander can sit below the label.
    ctx.textAlign = "center";
    ctx.font = "600 12px ui-monospace, monospace";
    const TIER_H = 15;
    const labelOf = (id) => {
      let name = (this.full.getNodeAttribute(id, "name") || "").trim().split(/\s+/)[0] || "";
      return name.length > 12 ? name.slice(0, 11) + "…" : name;
    };
    this._treeLabelTier = new Map();
    const lanes = new Map();
    for (const id of vis) {
      if (!this.view.hasNode(id)) continue;
      const ly = Math.round(this.view.getNodeAttribute(id, "y"));
      if (!lanes.has(ly)) lanes.set(ly, []);
      lanes.get(ly).push(id);
    }
    for (const laneIds of lanes.values()) {
      laneIds.sort((a, b) => this.view.getNodeAttribute(a, "x") - this.view.getNodeAttribute(b, "x"));
      const tierRight = [-Infinity, -Infinity]; // right edge of the last label on each row
      for (const id of laneIds) {
        const name = labelOf(id);
        const p = VP(id), r = RAD(id);
        const tw = ctx.measureText(name).width;
        const left = p.x - tw / 2 - 4, right = p.x + tw / 2 + 4;
        let tier = 0;
        if (left < tierRight[0] + 2) tier = (left >= tierRight[1] + 2) ? 1 : (tierRight[0] <= tierRight[1] ? 0 : 1);
        tierRight[tier] = right;
        this._treeLabelTier.set(id, tier);
        const topY = p.y + r + 3 + tier * TIER_H;
        ctx.fillStyle = this.theme.bg; // match the canvas so it reads uniformly in both themes
        ctx.fillRect(p.x - tw / 2 - 4, topY, tw + 8, 15);
        ctx.fillStyle = this.theme.label;
        ctx.fillText(name, p.x, topY + 11);
      }
    }
    ctx.restore();
  }

  /** Faint generation bands + labels ("parents", "you", "children"…) for Tree. */
  drawTreeGuides(ctx) {
    if (!this.treeGens || !this.treeGens.length) return;
    const rect = this.container.getBoundingClientRect();
    ctx.save();
    ctx.textAlign = "left";
    ctx.font = "600 11px ui-monospace, monospace";
    for (const g of this.treeGens) {
      const p = this.sigma.graphToViewport({ x: 0, y: -g * this.treeRowGap });
      if (p.y < 4 || p.y > rect.height - 4) continue;
      ctx.strokeStyle = "rgba(160,172,196,0.12)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(8, p.y); ctx.lineTo(rect.width - 8, p.y); ctx.stroke();
      const label = genLabel(g - this.treeOwnerGen);
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = this.theme.bg;
      ctx.fillRect(10, p.y - 15, tw + 10, 15);
      ctx.fillStyle = this.theme.dim;
      ctx.fillText(label, 15, p.y - 4);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------- cluster --
  /** Cluster metagraph: collapse the whole network into its Louvain communities.
   *  Each super-node is one community (sized by member count); each meta-edge is
   *  the count of ties crossing two communities (thicker = more shared links).
   *  Deterministic force layout - connected clusters pull together. Clicking a
   *  super-node expands that community's members (handled by the app). */
  showClusters() {
    if (!this.full) return;
    this.mode = "cluster";
    this.center = null;
    this.clearPath();
    this.setNodeSizeMode(false);
    this.buildClusterView();
    this.sigma.refresh();
    this.fitCamera();
  }

  buildClusterView() {
    this.worker?.terminate();
    this.worker = null;
    this.hovered = null;
    this.reachPath = new Set();
    this.reachPathEdges = new Set();
    this.isolatedType = null;
    this.isolatedNodes = new Set();
    this.clusterIsolate = null;
    this.clusterMembers = new Map();
    this.clusterLabels = new Map();
    this._clusterHub = new Map();
    const v = this.view;
    v.clear();
    this.computeCommunities();
    if (!this.communities.size) return;

    // Group contacts by community; label each by its dominant org (falling back
    // to the most-connected member), and remember its members for expand-on-click.
    const groups = new Map();
    this.full.forEachNode((id) => {
      const c = this.communities.get(id);
      if (c == null) return;
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(id);
    });
    // Deterministic order: biggest community first, ties broken by community id.
    const commIds = [...groups.keys()].sort((a, b) =>
      groups.get(b).length - groups.get(a).length || Number(a) - Number(b));

    let maxCount = 1;
    for (const c of commIds) maxCount = Math.max(maxCount, groups.get(c).length);
    const superId = (c) => `c${c}`;
    for (const c of commIds) {
      const members = groups.get(c).sort((a, b) => Number(a) - Number(b));
      const orgCount = new Map();
      let topMember = members[0], topDeg = -1;
      for (const id of members) {
        const a = this.full.getNodeAttributes(id);
        if (a.org) orgCount.set(a.org, (orgCount.get(a.org) || 0) + 1);
        const d = this.full.degree(id);
        if (d > topDeg) { topDeg = d; topMember = id; }
      }
      let bestOrg = null, bestN = 0;
      for (const [org, n] of orgCount) if (n > bestN) { bestN = n; bestOrg = org; }
      const hubName = this.full.getNodeAttribute(topMember, "name") || `Cluster ${c}`;
      // Use the org only when it actually characterises the group; else the hub.
      const label = (bestOrg && bestN >= Math.max(2, members.length * 0.34)) ? bestOrg : hubName;
      const sid = superId(c);
      this.clusterMembers.set(sid, members);
      this.clusterLabels.set(sid, label);
      this._clusterHub.set(sid, hubName);
      v.addNode(sid, {
        label: `${label} · ${members.length}`,
        x: 0, y: 0, // positioned by the layout below
        size: 10 + Math.sqrt(members.length) * 5,
        color: COMMUNITY_COLORS[Number(c) % COMMUNITY_COLORS.length],
      });
    }
    // Disambiguate clusters that ended up with the same label (e.g. one big org
    // split into several communities): append each one's hub name.
    const labelCounts = new Map();
    for (const l of this.clusterLabels.values()) labelCounts.set(l, (labelCounts.get(l) || 0) + 1);
    for (const [sid, l] of this.clusterLabels) {
      if (labelCounts.get(l) <= 1) continue;
      const hub = this._clusterHub.get(sid) || "";
      const disamb = hub && hub !== l ? `${l} · ${hub}` : l;
      this.clusterLabels.set(sid, disamb);
      v.setNodeAttribute(sid, "label", `${disamb} · ${this.clusterMembers.get(sid).length}`);
    }

    // Inter-cluster tie weights: count real edges whose endpoints differ in
    // community, keeping a per-relationship-type breakdown for the legend filters.
    const w = new Map();
    const byType = new Map();
    this.full.forEachEdge((_k, attrs, s, t) => {
      const cs = this.communities.get(s), ct = this.communities.get(t);
      if (cs == null || ct == null || cs === ct) return;
      const key = Number(cs) < Number(ct) ? `${cs}|${ct}` : `${ct}|${cs}`;
      w.set(key, (w.get(key) || 0) + 1);
      const bt = byType.get(key) || {};
      bt[attrs.type] = (bt[attrs.type] || 0) + 1;
      byType.set(key, bt);
    });
    let maxW = 1;
    for (const c of w.values()) maxW = Math.max(maxW, c);
    this._clusterMaxW = maxW;
    const metaEdges = [];
    for (const [key, count] of w) {
      const [ca, cb] = key.split("|");
      const a = superId(ca), b = superId(cb);
      if (!v.hasNode(a) || !v.hasNode(b)) continue;
      v.addEdge(a, b, {
        edgeType: "meta",
        color: this.theme.edge,
        size: 1 + 7 * (count / maxW),
        typeCounts: byType.get(key), // { relationshipType: count } for legend filtering
      });
      metaEdges.push({ a, b, w: 0.5 + 1.5 * (count / maxW) });
    }

    // Deterministic force layout on the (small) metagraph. Node radii feed the
    // separation pass so bubbles pack snugly without overlapping.
    const sids = commIds.map(superId);
    const radii = sids.map((sid) => this.view.getNodeAttribute(sid, "size"));
    const pos = this.layoutMetagraph(sids, metaEdges, radii);
    sids.forEach((sid, i) => v.mergeNodeAttributes(sid, { x: pos[i].x, y: pos[i].y }));
  }

  /** Deterministic force layout for the cluster metagraph, in a pixel-like space
   *  so node radii can drive a hard no-overlap pass. Three forces: repulsion
   *  (spreads bubbles), weighted attraction (ties pull clusters together), and
   *  centering gravity (keeps disconnected clusters in the pack instead of
   *  drifting to a corner). A final separation pass guarantees clean spacing and
   *  the snug "bubble cluster" look. No randomness - seeded on a circle by index. */
  layoutMetagraph(ids, edges, radii) {
    const n = ids.length;
    if (n === 0) return [];
    if (n === 1) return [{ x: 0, y: 0 }];
    const idx = new Map(ids.map((id, i) => [id, i]));
    // Ideal edge length ~ a couple of average bubble diameters.
    const avgR = radii.reduce((s, r) => s + r, 0) / n;
    const k = avgR * 4.2;
    // Seed on a circle sized so bubbles start apart (avoids an initial pile-up).
    const seedR = k * Math.max(1.4, Math.sqrt(n) / 1.6);
    const pos = ids.map((_, i) => ({
      x: seedR * Math.cos((2 * Math.PI * i) / n),
      y: seedR * Math.sin((2 * Math.PI * i) / n),
    }));
    let temp = seedR * 0.35;
    const grav = 0.045;
    for (let it = 0; it < 500; it++) {
      const disp = ids.map(() => ({ x: 0, y: 0 }));
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
          const d = Math.hypot(dx, dy) || 1e-4;
          const f = (k * k) / d, ux = dx / d, uy = dy / d;
          disp[i].x += ux * f; disp[i].y += uy * f;
          disp[j].x -= ux * f; disp[j].y -= uy * f;
        }
      }
      for (const e of edges) {
        const i = idx.get(e.a), j = idx.get(e.b);
        if (i == null || j == null) continue;
        let dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
        const d = Math.hypot(dx, dy) || 1e-4;
        const f = ((d * d) / k) * e.w, ux = dx / d, uy = dy / d;
        disp[i].x -= ux * f; disp[i].y -= uy * f;
        disp[j].x += ux * f; disp[j].y += uy * f;
      }
      // Centering gravity: pull each cluster toward the origin (disconnected ones too).
      for (let i = 0; i < n; i++) {
        disp[i].x -= pos[i].x * grav;
        disp[i].y -= pos[i].y * grav;
      }
      for (let i = 0; i < n; i++) {
        const dl = Math.hypot(disp[i].x, disp[i].y) || 1e-4;
        pos[i].x += (disp[i].x / dl) * Math.min(dl, temp);
        pos[i].y += (disp[i].y / dl) * Math.min(dl, temp);
      }
      temp *= 0.992;
    }
    // Hard separation: no two bubbles overlap; leave a small gap between rims.
    const gap = avgR * 0.9;
    for (let pass = 0; pass < 120; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
          let d = Math.hypot(dx, dy) || 1e-4;
          const min = radii[i] + radii[j] + gap;
          if (d < min) {
            const push = (min - d) / 2, ux = dx / d, uy = dy / d;
            pos[i].x -= ux * push; pos[i].y -= uy * push;
            pos[j].x += ux * push; pos[j].y += uy * push;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    return pos;
  }

  /** Hover card for a cluster super-node: label, member count, top orgs. */
  showClusterCard(node) {
    const members = this.clusterMembers.get(node);
    if (!members) { this.hoverCard.hidden = true; return; }
    const label = this.clusterLabels.get(node) || "Cluster";
    const orgCount = new Map();
    for (const id of members) {
      const o = this.full.getNodeAttribute(String(id), "org");
      if (o) orgCount.set(o, (orgCount.get(o) || 0) + 1);
    }
    const orgs = [...orgCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o]) => o);
    const bits = [`${members.length} member${members.length === 1 ? "" : "s"}`];
    if (orgs.length) bits.push(orgs.join(", "));
    bits.push("click to open the cluster");
    this.hoverCard.innerHTML = "";
    const title = document.createElement("div");
    title.className = "hover-title";
    title.textContent = label;
    const meta = document.createElement("div");
    meta.className = "hover-meta mono";
    meta.textContent = bits.join("  ·  ");
    this.hoverCard.append(title, meta);
    this.positionHoverCard();
  }

  buildView(idSet, centerId, { render = true, layout = null, nodeScale = 1 } = {}) {
    this.setNodeSizeMode(false); // non-tree views scale node size with zoom as usual
    this.worker?.terminate();
    this.worker = null;
    // Drop any hover state from the previous view. A stale `hovered` node that
    // isn't in the rebuilt view makes the edge reducer hide every edge (no edge
    // is incident to it), so the graph would render as nodes with no lines.
    this.hovered = null;
    this.reachPath = new Set();      // stale trace would light nodes across a rebuild
    this.reachPathEdges = new Set();
    this.familyHighlight = new Set();
    this.familyHighlightEdges = new Set();
    this.treeFocus = null;           // a rebuild starts from the full, unfocused tree
    this.treeFocusSet = new Set();
    this.treeFocusEdges = new Set();
    this._hasPairs = false;          // partner bonds are re-detected per focusSet
    this.isolatedType = null; // stale isolate set would hide the rebuilt view
    this.isolatedNodes = new Set();
    const v = this.view;
    v.clear();
    const circle = layout === "circle";
    // A true ring wants nodes on the perimeter, not scattered by a density
    // heuristic; scale the radius with node count so a big mesh spreads out.
    const R = circle
      ? 60 * Math.sqrt(Math.max(1, idSet.size))
      : 100 * Math.sqrt(Math.max(1, idSet.size) / 50);
    // On the ring, cap node radius to the arc spacing between neighbours so
    // contacts read as distinct beads instead of a fused rope - and so 20k
    // nodes become a fine ring rather than a solid blob.
    // Leave a gap between beads so a gender ring can hug each one without the
    // ring fusing into a solid rope around the circle.
    const meshCap = circle
      ? Math.max(1.5, ((2 * Math.PI * R) / Math.max(1, idSet.size)) * 0.34)
      : Infinity;
    let i = 0;
    for (const id of idSet) {
      const a = this.full.getNodeAttributes(id);
      const isCenter = centerId != null && Number(id) === centerId;
      // Phase offset keeps tiny views off the axes: a 2-node view otherwise puts
      // both nodes at y=0, and sigma's normalization (zero vertical extent) flings
      // them to opposite corners.
      const angle = (2 * Math.PI * i++) / idSet.size + 0.42;
      v.addNode(id, {
        label: a.name,
        x: isCenter ? 0 : R * Math.cos(angle),
        y: isCenter ? 0 : R * Math.sin(angle),
        size: Math.min(this.nodeSize(a.degree) * nodeScale, meshCap),
        color: this.nodeColor(id, a, isCenter),
        org: a.org,
        gender: a.gender,
        isOwner: a.isOwner,
        deceased: a.deceased,
      });
    }
    const centerStr = centerId != null ? String(centerId) : null;
    this.full.forEachEdge((key, attrs, s, t) => {
      if (idSet.has(s) && idSet.has(t)) {
        v.addEdgeWithKey(key, s, t, {
          edgeType: attrs.type,
          color: EDGE_COLORS[attrs.type] ?? EDGE_DEFAULT,
          size: 1,
        });
        // Tag the non-center endpoint with its relationship colour + type.
        if (centerStr && (s === centerStr || t === centerStr)) {
          const other = s === centerStr ? t : s;
          if (v.hasNode(other)) {
            v.setNodeAttribute(other, "relColor", EDGE_COLORS[attrs.type] ?? null);
            v.setNodeAttribute(other, "relType", attrs.type);
          }
        }
      }
    });
    this.syncSparkle();
    this.applyMinimapVisibility();
    // Ego views run a force layout right after building. Painting the raw circular
    // seed here (then letting the worker collapse it) shows a jarring ring "flash",
    // so those callers pass render:false and let the first settled tick paint.
    if (render) this.sigma.refresh();
  }

  /** Start/stop the owner sparkle animation depending on whether "you" is in view.
   *  (Deceased nodes glow steadily, so they don't drive the animation loop.) */
  syncSparkle() {
    let animate = false;
    this.view.forEachNode((_id, a) => { if (a.isOwner) animate = true; });
    if (animate && this.view.order <= OVERLAY_MAX_NODES) this.startSparkle();
    else this.stopSparkle();
  }
  startSparkle() {
    if (this.sparkleRAF != null) return;
    const tick = () => {
      this.sparklePhase += 0.05;
      this.drawOverlay();
      this.sparkleRAF = requestAnimationFrame(tick);
    };
    this.sparkleRAF = requestAnimationFrame(tick);
  }
  stopSparkle() {
    if (this.sparkleRAF != null) { cancelAnimationFrame(this.sparkleRAF); this.sparkleRAF = null; }
  }

  runEgoLayout() {
    if (this.view.order < 3) { this.sigma.refresh(); this.fitCamera(); return; }
    const nodes = [];
    this.view.forEachNode((id, a) => nodes.push({ id, x: a.x, y: a.y, size: a.size }));
    const edges = [];
    this.view.forEachEdge((_k, _a, s, t) => edges.push({ source: s, target: t }));

    const worker = new Worker(new URL("./layout-worker.js", import.meta.url), { type: "module" });
    this.worker = worker;
    let last = null;
    let framed = false;
    worker.onmessage = (e) => {
      if (e.data.type === "tick") {
        last = e.data.positions;
        if (!reducedMotion) {
          this.applyPositions(last);
          // Frame once the first settled tick lands (the worker runs 30 FA2
          // iterations before it), so we never frame the raw circular seed.
          if (!framed) { this.fitCamera(); framed = true; }
        }
      } else {
        if (last) this.applyPositions(last);
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        this.fitCamera();
      }
    };
    // Callers no longer paint the seed, so if the worker dies we must still
    // render the built view rather than leaving the previous one on screen.
    worker.onerror = () => {
      if (this.worker !== worker) return;
      this.worker = null;
      worker.terminate();
      this.sigma.refresh();
      this.fitCamera();
    };
    worker.postMessage({ nodes, edges });
  }

  applyPositions(positions) {
    for (const [id, p] of Object.entries(positions)) {
      if (this.view.hasNode(id)) {
        this.view.setNodeAttribute(id, "x", p.x);
        this.view.setNodeAttribute(id, "y", p.y);
      }
    }
    this.sigma.refresh();
  }

  /** Compose sigma's canvas layers over the app background; base64 PNG body. */
  exportPNG() {
    const canvases = [...this.container.querySelectorAll("canvas")];
    if (!canvases.length) return null;
    const out = document.createElement("canvas");
    out.width = canvases[0].width;
    out.height = canvases[0].height;
    const ctx = out.getContext("2d");
    ctx.fillStyle = document.documentElement.dataset.theme === "light" ? "#eef2f8" : "#0a0f1c";
    ctx.fillRect(0, 0, out.width, out.height);
    for (const c of canvases) ctx.drawImage(c, 0, 0);
    return out.toDataURL("image/png").split(",")[1];
  }

  // ---------------------------------------------------- path / analytics --
  /** Highlight a path (ids in order); zooms out to the whole network (Mesh) if
   *  any node on the path isn't in the current view. */
  highlightPath(ids) {
    const strIds = ids.map(String);
    if (!strIds.every((id) => this.view.hasNode(id))) {
      this.showMesh();
    }
    this.pathNodes = new Set(strIds);
    this.pathEdgePairs = new Set();
    for (let i = 1; i < strIds.length; i++) {
      this.pathEdgePairs.add(`${strIds[i - 1]}|${strIds[i]}`);
    }
    this.sigma.refresh();
  }

  clearPath() {
    if (this.pathNodes.size || this.pathEdgePairs.size) {
      this.pathNodes = new Set();
      this.pathEdgePairs = new Set();
      this.sigma.refresh();
    }
  }

  get hasPath() {
    return this.pathNodes.size > 0;
  }

  computeCommunities() {
    // Louvain throws on edge-less graphs; treat that as "no communities".
    if (!this.full || this.full.order === 0 || this.full.size === 0) return 0;
    // Louvain needs a mono undirected view of the multi graph. Weight the ties:
    // every kinship (family) edge counts as KINSHIP_WEIGHT ordinary links, so
    // families are pulled into the same community. Multiple ties between the same
    // pair accumulate ("count all kinships").
    const mono = new Graph({ type: "undirected" });
    this.full.forEachNode((id) => mono.addNode(id));
    this.full.forEachEdge((_k, a, s, t) => {
      if (s === t) return;
      const w = a.type === "family" ? KINSHIP_WEIGHT : 1;
      if (mono.hasEdge(s, t)) mono.updateEdgeAttribute(s, t, "weight", (x) => (x || 1) + w);
      else mono.addEdge(s, t, { weight: w });
    });
    if (mono.size === 0) return 0; // only self-loops existed
    // Seeded RNG + weight attribute => deterministic, kinship-aware communities.
    const mapping = louvain(mono, { getEdgeWeight: "weight", rng: mulberry32(0x0b17) });
    this.communities = new Map(Object.entries(mapping));
    return new Set(Object.values(mapping)).size;
  }

  /** Toggle org vs community coloring; returns community count when on. */
  setColorMode(mode) {
    this.colorMode = mode;
    let count = 0;
    if (mode === "community") count = this.computeCommunities();
    if (this.mode === "cluster") return count; // super-nodes aren't contacts; keep community palette
    this.view.forEachNode((id) => {
      const isCenter = this.center != null && Number(id) === this.center;
      this.view.setNodeAttribute(id, "color", this.nodeColor(id, this.full.getNodeAttributes(id), isCenter));
    });
    this.sigma.refresh();
    return count;
  }

  toggleEdgeType(type) {
    // Works in every view - in Cluster it re-weights meta-edges by their breakdown.
    if (this.hiddenTypes.has(type)) this.hiddenTypes.delete(type);
    else this.hiddenTypes.add(type);
    this.sigma.refresh();
    return !this.hiddenTypes.has(type);
  }

  /** Legend hover: isolate one relationship type. In Cluster this keeps only the
   *  meta-edges that carry that type (nodes stay); elsewhere it shows only that
   *  type's connections and the contacts they link. clearIsolate() restores. */
  isolateEdgeType(type) {
    if (this.mode === "cluster") {
      if (this.hiddenTypes.has(type)) return;
      this.clusterIsolate = type;
      this.sigma.refresh();
      return;
    }
    if (this.hiddenTypes.has(type)) return; // a filtered-off type has nothing to show
    this.isolatedType = type;
    const nodes = new Set();
    this.view.forEachEdge((_k, attrs, s, t) => {
      if (attrs.edgeType === type) { nodes.add(s); nodes.add(t); }
    });
    this.isolatedNodes = nodes;
    this.sigma.refresh();
  }

  clearIsolate() {
    let changed = false;
    if (this.clusterIsolate) { this.clusterIsolate = null; changed = true; }
    if (this.isolatedType != null) { this.isolatedType = null; this.isolatedNodes = new Set(); changed = true; }
    if (changed) this.sigma.refresh();
  }

  neighborsOf(id) {
    if (!this.full || !this.full.hasNode(id)) return [];
    const out = [];
    const seen = new Set();
    this.full.forEachNeighbor(String(id), (nb, attrs) => {
      if (seen.has(nb)) return;
      seen.add(nb);
      out.push({ id: Number(nb), name: attrs.name, org: attrs.org, degree: attrs.degree, gender: attrs.gender });
    });
    out.sort((a, b) => b.degree - a.degree);
    return out;
  }

  /** Gender attribute of a node in the full graph (drives kinship term sets). */
  genderOf(id) {
    return this.full && this.full.hasNode(String(id))
      ? this.full.getNodeAttribute(String(id), "gender")
      : undefined;
  }

  destroy() {
    this.stopSparkle();
    this.worker?.terminate();
    this.sigma.kill();
  }
}

export function renderLegend(el, genderEl, onToggle, onHover, onHoverEnd) {
  // Edge-type legend (bottom-left; click to filter, hover to isolate).
  el.innerHTML = "";
  for (const [type, color] of Object.entries(EDGE_COLORS)) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "legend-item";
    item.style.cssText = "border:0;background:none;color:inherit;font:inherit;padding:0;";
    const swatch = document.createElement("i");
    swatch.className = "legend-swatch";
    swatch.style.background = color;
    item.append(swatch, document.createTextNode(type));
    item.addEventListener("click", () => {
      const visible = onToggle(type);
      item.classList.toggle("off", !visible);
    });
    // Hover (or keyboard focus): isolate this relationship on the canvas.
    item.addEventListener("mouseenter", () => onHover?.(type));
    item.addEventListener("mouseleave", () => onHoverEnd?.());
    item.addEventListener("focus", () => onHover?.(type));
    item.addEventListener("blur", () => onHoverEnd?.());
    el.appendChild(item);
  }
  el.hidden = false;

  // Gender-ring legend (bottom-right).
  if (genderEl) {
    genderEl.innerHTML = "";
    for (const [g, color] of Object.entries(GENDER_RING)) {
      const item = document.createElement("span");
      item.className = "legend-item";
      const ring = document.createElement("i");
      ring.className = "legend-ring";
      ring.style.borderColor = color;
      item.append(ring, document.createTextNode(g));
      genderEl.append(item);
    }
    genderEl.hidden = false;
  }
}
