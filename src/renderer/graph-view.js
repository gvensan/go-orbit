// graph-view.js - the constellation (GRAPH_CANVAS spec). Two modes:
//   ego  - the whole network (or a contact's N-hop neighborhood) as a radial
//          tree: you at the centre, rings by how many steps away a contact is.
//          This is the "Graph" view.
//   mesh - every contact on a circle, every connection a straight chord. This
//          is the "Mesh" view.
// Every layout here is deterministic: the same network draws the same picture.
// Plus: node drag, shortest-path highlight, Louvain community coloring, and
// edge-type filtering from the legend.

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import Sigma from "sigma";
import { EDGE_COLORS, EDGE_DEFAULT, GENDER_COLORS, orgColor } from "./colors.js";
import { CLOSENESS_ORDER } from "../shared/relationships.js";
import { pairHeartSpots, nodeHitIndex, balloonLayout } from "./graph-geometry.mjs";

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
// A live alias: applyPalette() retints GENDER_COLORS in place, so the rings
// (and the legend) follow the active palette without a rebuild.
const GENDER_RING = GENDER_COLORS;

// Labels: sigma hides any label whose node renders below this size - sensible
// at 95 nodes, but it silently unlabels small degree-1 contacts in a sparse
// drill-down where every name would fit. At or under LABEL_ALL_MAX_NODES the
// size gate is dropped and sigma's label grid (which handles actual overlap)
// is the only filter.
const LABEL_SIZE_THRESHOLD = 7;
const LABEL_ALL_MAX_NODES = 40;

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
// The order the layouts lay tie types around the circle. Family first (it is the
// biggest and the one people look for), then the working world, then the looser
// ties; anything untyped falls to the end.
const TIE_RANK = ["family", "colleague", "friend", "acquaintance", "vendor", "introduced"];
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

/** Is this fill light enough that a glyph drawn on it needs dark ink?
 *  Perceived luminance, so any hex the palette or a colour mode produces works. */
function isLight(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 > 0.55;
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

/** Cluster-kind hint glyphs drawn on the overlay, centered at (x,y), fit to a
 *  box of side `s`. White fill + dark outline so they read on any bubble color.
 *  Shapes mirror the person/organization icons in the cluster legend. */
function drawClusterBadge(ctx, x, y, s, kind, fill, stroke) {
  const u = s / 16;                 // 16-unit design grid, top-left origin
  const gx = x - s / 2, gy = y - s / 2;
  const X = (n) => gx + n * u, Y = (n) => gy + n * u;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1.5, s * 0.14);
  ctx.strokeStyle = stroke;
  ctx.fillStyle = fill;
  if (kind === "org") {
    // Tower + annex building.
    ctx.beginPath();
    ctx.rect(X(2.5), Y(2), u * 6, u * 12);      // tower
    ctx.rect(X(9.5), Y(6), u * 4, u * 8);       // annex
    ctx.stroke();
    ctx.fill();
    // Punched windows (draw in outline color so they read as openings).
    ctx.fillStyle = stroke;
    for (const [wx, wy] of [[4, 4], [7, 4], [4, 7.5], [7, 7.5], [11, 8], [11, 11]]) {
      ctx.fillRect(X(wx), Y(wy), u * 1.6, u * 1.6);
    }
  } else {
    // Head + shoulders person.
    ctx.beginPath();
    ctx.arc(X(8), Y(5), u * 2.9, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(X(2.5), Y(14));
    ctx.quadraticCurveTo(X(2.5), Y(9), X(8), Y(9));
    ctx.quadraticCurveTo(X(13.5), Y(9), X(13.5), Y(14));
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
  }
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
// Cluster view "connector people" pulled out of their bubbles: a muted slate for
// peers, a warm gold for the owner ("you"), so they read as individuals against
// the colourful group bubbles.
const PERSON_NODE_COLOR = "#8b97ad";
const OWNER_NODE_COLOR = "#e5b567";

export class GraphView {
  /**
   * @param {HTMLElement} container
   * @param {{ onSelect: (id: number) => void, onShiftSelect: (id: number) => void,
   *           onDragEnd: (id: number, pos: {x: number, y: number}) => void,
   *           onNodeMenu?: (id: number, pos: {x: number, y: number}) => void,
   *           onClusterOpen?: (openIds: number[], label: string, memberCount: number) => void,
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
    this.sparklePhase = 0;      // drives the owner node's golden twinkle
    this.sparkleRAF = null;
    this.hiddenTypes = new Set();
    this.isolatedType = null;        // legend hover: show only this relationship
    this.isolatedNodes = new Set();  // contacts incident to the isolated type
    // Legend filter: nodes hidden because every relationship line touching them
    // is toggled off (so the now-dangling dot disappears with its line, not just
    // the line). Recomputed on toggle and on every view rebuild.
    this.filteredOutNodes = new Set();
    // Gender legend (bottom-right), same grammar as the relationship legend:
    // click a gender to filter it out, hover to isolate it.
    this.hiddenGenders = new Set();
    this.isolatedGender = null;
    // A contact's dominant relationship colour (deceased half-disc, and the
    // "colour by relationship" fill), memoised per contact.
    this._relTint = new Map();
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
    this.clusterKind = new Map();        // super-node id -> "person" | "org"
    this.hiddenClusterKinds = new Set(); // cluster kinds toggled off in the legend
    this.clusterIsolate = null; // legend hover in Cluster: highlight one tie type
    // Node fill mode, persisted across launches. Default is "relationship"
    // (fills match the legend): on a personal network few contacts carry an
    // org, and color-by-organization painted nearly every disc the neutral
    // "no organization" slate. Org and community stay one command away.
    const savedColorMode = localStorage.getItem("orbit-color-mode");
    this.colorMode = ["org", "community", "relationship"].includes(savedColorMode)
      ? savedColorMode
      : "relationship"; // "org" | "community" | "relationship"
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
    this.minimapWrap.append(mmHide, this.minimapCanvas);
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
      // Sigma keeps one label per grid cell. Its default cell is narrower than a
      // contact's name at 12px, so two names in neighbouring cells still overlap
      // (visible on any ego view with a couple in it). A wider cell drops the
      // colliding one instead - hovering still names anybody.
      labelGridCellSize: 140,
      labelRenderedSizeThreshold: LABEL_SIZE_THRESHOLD,
      defaultEdgeColor: this.theme.edge,
      stagePadding: 50,
      // Sigma's default hover label sits on a hardcoded white box (invisible
      // with light label text in dark mode); draw a themed box instead.
      defaultDrawNodeHover: (ctx, data, settings) => this.drawNodeHover(ctx, data, settings),
      // Sigma's default label sits at rim + 3px, which lands under the gender
      // ring and inside the owner's halo; ours clears the node's decorations.
      defaultDrawNodeLabel: (ctx, data, settings) => this.drawNodeLabel(ctx, data, settings),
      nodeReducer: (node, data) => {
        const out = { ...data };
        // Cluster view: hide super-nodes whose kind (person / organization) is
        // toggled off in the cluster legend.
        if (this.mode === "cluster" && this.hiddenClusterKinds.has(this.clusterKind.get(node))) {
          out.hidden = true;
          return out;
        }
        // Center node color follows the theme (flips live on toggle)...
        if (this.center != null && node === String(this.center)) out.color = this.theme.center;
        // ...but the owner ("you") stays sun-gold even when it's the centre.
        const isOwnerNode = out.isOwner || this.view.getNodeAttribute(node, "isOwner");
        if (isOwnerNode) out.color = this.theme.ownerFill;
        // Legend filter: a relationship type toggled off hides its lines AND the
        // contacts left with no visible line at all. "You"/the centre always stays.
        if (this.filteredOutNodes.has(node)
            && !(this.center != null && node === String(this.center))
            && !isOwnerNode) {
          out.hidden = true;
          return out;
        }
        // Legend hover: show only contacts touched by the isolated relationship.
        if (this.isolatedType && !this.isolatedNodes.has(node)) {
          out.hidden = true;
          return out;
        }
        // Gender legend: a gender toggled off drops out, and hovering one shows
        // only that gender. Cluster super-nodes have no gender, so it never
        // applies there; "you"/the centre always stays, as the anchor.
        // Businesses have no gender at all: filtering a gender off leaves them
        // (they are not the thing being filtered), but isolating one means
        // "show only these people", so they step aside for that. The business
        // check covers contacts flagged before the card started clearing gender,
        // which would otherwise be filtered out by a value they no longer show.
        if (this.mode !== "cluster" && !isOwnerNode
            && !(this.center != null && node === String(this.center))
            && ((this.hiddenGenders.has(out.gender) && !out.business)
                || (this.isolatedGender && out.gender !== this.isolatedGender))) {
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
          // Fade links applies to the metagraph too - every visible meta-edge
          // dims the same way ordinary connections do. Isolating a tie type is
          // an explicit "light these up", so that branch stays full-strength.
          const fade = () => {
            if (this.edgeFade) {
              out.color = this.theme.edgeFaint;
              out.size = Math.min(data.size ?? 1, 0.7);
            }
            return out;
          };
          // Org-only fallback link: only meaningful when people are hidden (it keeps
          // the company bubbles connected in that view); hide it otherwise.
          if (attrs.orgBridge) {
            if (!this.hiddenClusterKinds.has("person") || this.clusterIsolate) { out.hidden = true; return out; }
            return fade();
          }
          // Structural "belongs to" / anti-dangling links carry no relationship
          // type: show them normally, hide only while isolating a single tie type.
          if (attrs.anchor) {
            if (this.clusterIsolate) { out.hidden = true; return out; }
            return fade();
          }
          // Uniform thickness (keep the edge's own size): tie count no longer drives
          // line width, so organization and person cluster links look identical and
          // don't balloon on zoom. The count only filters (hide) and colours.
          if (this.clusterIsolate) {
            if (!(tc[this.clusterIsolate] || 0)) { out.hidden = true; return out; }
            out.color = EDGE_COLORS[this.clusterIsolate] || this.theme.edge;
            return out;
          }
          let eff = 0;
          for (const [type, cnt] of Object.entries(tc)) if (!this.hiddenTypes.has(type)) eff += cnt;
          if (eff === 0) { out.hidden = true; return out; }
          return fade();
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
          const near = (a, b) => this.full.hasEdge(a, b) || this.full.hasEdge(b, a);
          const openIds = new Set(members.map(String));
          if (node[0] === "p") {
            // A connector person opens their ego: them + everyone they directly know.
            for (const m of members) this.full.forEachNeighbor(String(m), (nb) => openIds.add(nb));
          } else {
            // A company / community opens its members plus the owner ("you"), the
            // anchor that links them - but NOT every member's whole neighbourhood
            // (a hub member like you would otherwise drag in the entire network).
            const owner = this.ownerNode();
            if (owner != null) {
              const oStr = String(owner);
              if (!openIds.has(oStr) && members.some((m) => near(String(m), oStr))) openIds.add(oStr);
            }
          }
          this.handlers.onClusterOpen([...openIds].map(Number), this.clusterLabels.get(node) || "Cluster", members.length);
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
    // How this contact hangs on the network, always answered for a connected
    // node: the tie to whatever the view is about (the focused centre, else
    // you), and when there is none, the tie to their strongest neighbour so a
    // second-degree contact still says "friend of Ramya Giri" rather than
    // nothing. Family shows its kin role ("daughter") in place of the type.
    const refStr = this.center != null && String(this.center) !== node
      ? String(this.center)
      : (ownerStr !== node ? ownerStr : null);
    /** @type {Map<string, {types: string[], kin: string | null}>} */
    const ties = new Map();
    this.full.forEachEdge(node, (_k, attrs, s2, t2) => {
      const other = s2 === node ? t2 : s2;
      let e = ties.get(other);
      if (!e) { e = { types: [], kin: null }; ties.set(other, e); }
      if (attrs.type && !e.types.includes(attrs.type)) e.types.push(attrs.type);
      const r = attrs.metadata?.kin?.[node];
      if (r && !e.kin) e.kin = r;
    });
    let tieTo = refStr && ties.has(refStr) ? refStr : null;
    if (!tieTo && ties.size) {
      // Deterministic pick: someone you also know first (that's the useful
      // bridge), then the best-connected, then lowest id so it never flickers.
      const deg = (o) => this.full.getNodeAttribute(o, "degree") ?? this.full.degree(o);
      const mutual = (o) => (ownerStr && o !== ownerStr && this.full.areNeighbors(o, ownerStr) ? 1 : 0);
      tieTo = [...ties.keys()].sort((x, y) =>
        mutual(y) - mutual(x) || deg(y) - deg(x) || Number(x) - Number(y))[0];
    }
    let relText = null, relColor = "";
    if (tieTo) {
      const tie = ties.get(tieTo);
      const label = tie.kin || tie.types.join(" + ");
      // "of <name>" everywhere except your own ties, where it is implicit.
      const of = tieTo === ownerStr ? "" : ` of ${this.full.getNodeAttribute(tieTo, "name")}`;
      relText = label + of;
      relColor = EDGE_COLORS[tie.types[0]] ?? "";
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
    if (relText) {
      const chip = document.createElement("span");
      chip.className = "hover-rel";
      chip.textContent = relText;
      chip.style.color = relColor;
      meta.append(chip);
      if (bits.length) meta.append(document.createTextNode("  ·  "));
    }
    meta.append(document.createTextNode(bits.join("  ·  ")));
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
        business: n.business,
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
    this._relTint.clear(); // the relationship mix changed with the data
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
    const x = data.x + this.nodeHaloRadius(data, data.size) + 4;
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

  /** The outermost radius the node actually paints to, decorations included:
   *  the gender ring, or the owner's halo plus its orbiting sparkles. Labels,
   *  hover cards and couple hearts clear THIS radius, not the bare node size, so
   *  nothing is ever drawn over a node. Clearance is constant whether or not the
   *  ring is currently painted (hover-only mode), so labels don't shift on hover. */
  nodeHaloRadius(attrs, r) {
    if (attrs.isOwner) return r + 13;              // sparkle orbit (r+8) + its arms
    if (this.mode === "cluster") return r;         // super-nodes carry no ring
    return r + (this.mode === "mesh" ? 2 : 4.5);   // gender ring outer edge
  }

  /** Clip the overlay to everything EXCEPT the visible node discs, so guides,
   *  lanes and their label chips read as background behind the nodes instead of
   *  painting across them (the coloured discs live on the WebGL layer below).
   *  Skipped past the overlay budget, where the per-node work is off anyway.
   *  Caller wraps this in ctx.save() / ctx.restore(). */
  clipOutNodes(ctx, ids) {
    const rect = this.container.getBoundingClientRect();
    ctx.beginPath();
    ctx.rect(0, 0, rect.width, rect.height);
    if (this.view.order <= OVERLAY_MAX_NODES) {
      for (const id of ids) {
        if (!this.view.hasNode(id)) continue;
        const dd = this.sigma.getNodeDisplayData(id);
        if (!dd || dd.hidden) continue;
        const a = this.view.getNodeAttributes(id);
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
        const p = this.sigma.graphToViewport({ x: a.x, y: a.y });
        let r; try { r = this.sigma.scaleSize(a.size); } catch { r = 12; }
        const hole = Math.max(this.nodeHaloRadius(a, r), r + 4);
        ctx.moveTo(p.x + hole, p.y);
        ctx.arc(p.x, p.y, hole, 0, 2 * Math.PI);
      }
    }
    ctx.clip("evenodd");
    return rect;
  }

  /** Node label, offset past whatever the overlay paints around the node. */
  drawNodeLabel(ctx, data, settings) {
    if (!data.label) return;
    const size = settings.labelSize;
    ctx.fillStyle = settings.labelColor.color || this.theme.label;
    ctx.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillText(data.label, data.x + this.nodeHaloRadius(data, data.size) + 3, data.y + size / 3);
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
    // Every visible node's painted footprint, collected during this pass so the
    // couple hearts drawn afterwards can steer clear of ALL of them (a bond can
    // run right over a third node on its way across the canvas).
    const spots = [];
    this.view.forEachNode((id, attrs) => {
      if (!Number.isFinite(attrs.x) || !Number.isFinite(attrs.y)) return;
      // Skip rings/halos for any node the reducer hid (legend filter, isolated
      // hover, ...) - otherwise a hidden node keeps a floating gender ring.
      const dd = this.sigma.getNodeDisplayData(id);
      if (!dd || dd.hidden) return;
      // Node GRAPH coordinates -> viewport (getNodeDisplayData is sigma's
      // normalized frame and would misplace the rings).
      const p = this.sigma.graphToViewport({ x: attrs.x, y: attrs.y });
      let r;
      try { r = this.sigma.scaleSize(attrs.size); } catch { r = attrs.size; }
      spots.push({ x: p.x, y: p.y, r: this.nodeHaloRadius(attrs, r) });
      // Cluster view: stamp a person/organization hint badge on each bubble so its
      // kind is legible at a glance, then skip the gender/relationship rings (they
      // don't apply to a super-node).
      if (this.mode === "cluster") {
        const kind = this.clusterKind.get(id);
        if (kind) {
          const gs = Math.max(9, Math.min(r * 1.1, 26));
          if (gs >= 9) drawClusterBadge(ctx, p.x, p.y, gs, kind, "#ffffff", "#1b2130");
        }
        return;
      }
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
      // Deceased: the disc reads as a memorial split - the left half carries the
      // relationship colour, the right stays the white fill from nodeColor(). No
      // halo, no motion; the tint keeps the tie legible at a glance.
      if (attrs.deceased && !attrs.isOwner) {
        const tint = this.relationshipTint(id, attrs);
        if (tint) {
          ctx.save();
          ctx.beginPath();
          // Half-disc, inset half a pixel so it sits inside sigma's antialiased rim.
          ctx.arc(p.x, p.y, Math.max(0.5, r - 0.5), Math.PI / 2, 1.5 * Math.PI);
          ctx.closePath();
          ctx.fillStyle = tint;
          ctx.fill();
          ctx.restore();
        }
      }
      // The centred contact: a thin theme-colored halo outside the ring marks
      // focus now that the fill stays in the palette. The owner already has the
      // gold halo, and the mesh packs beads too tight for an extra ring.
      if (centerStr && id === centerStr && !attrs.isOwner && !mesh) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 5.6, 0, 2 * Math.PI);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = this.theme.center;
        ctx.stroke();
      }
      // A business is not a person: it has no gender, so instead of a gender
      // ring it wears the vendor hue (same geometry and hover behavior, so it
      // reads as a first-class node), plus the building glyph so a vendor never
      // reads as a contact you know. The gap ring keeps the vendor ring legible
      // even when the fill underneath is the vendor color itself.
      if (attrs.business) {
        if (!hoverOnly || id === this.hovered) {
          const rr = mesh ? r + 1.2 : r + 3;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr, 0, 2 * Math.PI);
          ctx.lineWidth = mesh ? 1.6 : 3;
          ctx.strokeStyle = this.theme.bg;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr, 0, 2 * Math.PI);
          ctx.lineWidth = mesh ? 1.3 : 1.8;
          ctx.strokeStyle = EDGE_COLORS.vendor;
          ctx.stroke();
        }
        const gs = Math.max(10, Math.min(r * 1.3, 22));
        // The disc underneath can be anything (org hue, vendor teal, or the pale
        // centre fill), so pick the glyph off its lightness or it disappears.
        const light = isLight(dd.color || attrs.color);
        drawClusterBadge(ctx, p.x, p.y, gs, "org", light ? "#16233a" : "#ffffff", light ? "#ffffff" : "#16233a");
        return;
      }
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
      // Tie-to-centre badge - skipped when the disc fill already IS that colour
      // (relationship fill mode tints centre-adjacent fills with relColor), so
      // the dot only appears where it adds information: org/community fills,
      // the owner's gold, the deceased memorial disc.
      if (centerStr && id !== centerStr && attrs.relColor && attrs.relColor !== attrs.color) {
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
    // Partner (couple) bonds: a small heart on each pair link, placed in clear
    // space between the two partners and skipped when there is none.
    if (this._hasPairs) {
      const occupied = nodeHitIndex(spots);
      this.view.forEachEdge((_k, a, s, t) => {
        if (!a.pair) return;
        // Mirror the edge reducer: if the bond line is hidden, hide its heart too.
        if (this.hiddenTypes.has(a.edgeType)) return;                       // legend filter off
        if (this.isolatedType && a.edgeType !== this.isolatedType) return;  // legend isolate
        if (this.hovered && s !== this.hovered && t !== this.hovered) return; // hover dimming
        const sd = this.sigma.getNodeDisplayData(s), td = this.sigma.getNodeDisplayData(t);
        if (!sd || !td || sd.hidden || td.hidden) return; // a partner filtered out (gender/legend)
        const sa = this.view.getNodeAttributes(s), ta = this.view.getNodeAttributes(t);
        if (!Number.isFinite(sa.x) || !Number.isFinite(ta.x)) return;
        const p1 = this.sigma.graphToViewport({ x: sa.x, y: sa.y });
        const p2 = this.sigma.graphToViewport({ x: ta.x, y: ta.y });
        // Size the heart off the rendered node radii so it scales with zoom.
        let r1, r2;
        try { r1 = this.sigma.scaleSize(sa.size); } catch { r1 = sa.size; }
        try { r2 = this.sigma.scaleSize(ta.size); } catch { r2 = ta.size; }
        const hz = Math.max(4, 0.6 * Math.min(r1, r2));
        // Keep it clear of both partners (the "you" node is far bigger than its
        // neighbours, so the plain midpoint sits on top of it) and of any node the
        // bond happens to cross. No clear spot on the bond means no heart.
        const spot = pairHeartSpots(p1, p2, this.nodeHaloRadius(sa, r1), this.nodeHaloRadius(ta, r2), hz);
        if (!spot) return;
        const at = spot.points.find((q) => !occupied(q.x, q.y, spot.half));
        if (at) drawHeart(ctx, at.x, at.y, spot.s, PAIR_COLOR, this.theme.bg);
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
    // Callers pass the exact set to show (a cluster's members + its anchor, or a
    // person's ego); the view renders the edges that fall inside that set.
    const set = new Set(ids.map(String).filter((id) => this.full.hasNode(id)));
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

  // `isCenter` no longer swaps the fill: the centred contact keeps its palette
  // colour in every mode (a white disc read as "scheme not applied") and focus
  // is marked by a thin halo drawn in the overlay instead. The param stays so
  // call sites don't churn if a centre-specific fill ever returns.
  nodeColor(id, attrs, isCenter = false) { // eslint-disable-line no-unused-vars
    if (attrs.isOwner) return this.theme.ownerFill; // "you" - a distinct gold (theme-aware)
    // Deceased: a sober, desaturated white fill - a quiet memorial that reads
    // distinctly from the org/community hues without an attention-grabbing glow.
    if (attrs.deceased) return "#d7dbe4";
    if (this.colorMode === "community") {
      const c = this.communities.get(String(id)) ?? 0;
      return COMMUNITY_COLORS[c % COMMUNITY_COLORS.length];
    }
    // Fill by relationship: the disc carries the same hue as the legend, so the
    // tie type reads without tracing a line. Unconnected contacts stay neutral.
    if (this.colorMode === "relationship") {
      // The tie to the current centre outranks the global dominant type: a
      // daughter must read family-coloured in her parent's view even if she
      // has as many ties of another type elsewhere. relColor is tagged onto
      // view nodes adjacent to the centre when the view is built.
      const known = this.view?.hasNode(String(id));
      const rel = known ? this.view.getNodeAttribute(String(id), "relColor") : null;
      // Reached through someone else: wear that branch's colour, not your own
      // commonest tie - a friend's daughter belongs to your friend's world.
      const gate = known ? this.view.getNodeAttribute(String(id), "gateway") : null;
      return rel || EDGE_COLORS[gate] || this.dominantRelColor(id) || "#8b9bb4";
    }
    return orgColor(attrs.org);
  }

  /** Tag every contact with how YOU reach them: the tie type of the first step
   *  on the path from the centre. A contact two hops out has no tie to you of
   *  their own, so without this they fall back to whatever their commonest
   *  relationship happens to be, and a friend's family reads as "family" rather
   *  than as part of your friend's world. */
  tagGateways(centerStr) {
    this.view.forEachNode((id) => this.view.setNodeAttribute(id, "gateway", null));
    if (!centerStr || !this.view.hasNode(centerStr)) return;
    const queue = [centerStr];
    const seen = new Set([centerStr]);
    while (queue.length) {
      const u = queue.shift();
      const from = u === centerStr ? null : this.view.getNodeAttribute(u, "gateway");
      this.view.forEachNeighbor(u, (nb) => {
        if (seen.has(nb)) return;
        seen.add(nb);
        // The first step decides; every step after it inherits.
        const step = u === centerStr
          ? this.view.getEdgeAttribute(this.view.edges(u, nb)[0], "edgeType")
          : from;
        this.view.setNodeAttribute(nb, "gateway", step ?? null);
        queue.push(nb);
      });
    }
  }

  /** Paint the relationship view. A CONTACT wears the colour of how you reach
   *  them, so a friend's family reads as part of your friend's world. A LINE
   *  always names its own tie - a marriage inside that family is drawn as family,
   *  whichever branch it sits in - so the legend keeps meaning one thing when you
   *  look at a line. */
  applyRelationshipTint() {
    const centerStr = this.center != null ? String(this.center) : null;
    this.view.forEachNode((id) => {
      if (!this.full.hasNode(id)) return;
      this.view.setNodeAttribute(id, "color", this.nodeColor(id, this.full.getNodeAttributes(id), id === centerStr));
    });
    this.view.forEachEdge((key, attrs) => {
      this.view.setEdgeAttribute(key, "color", EDGE_COLORS[attrs.edgeType] ?? EDGE_DEFAULT);
    });
  }

  /** The relationship colour that describes a contact: their tie to the current
   *  centre when the view knows one, else their commonest relationship overall.
   *  Null when they have no ties at all. Used for the deceased half-disc and the
   *  "colour by relationship" fill. */
  relationshipTint(id, attrs = {}) {
    return attrs.relColor || this.dominantRelColor(id);
  }

  /** A contact's commonest relationship type in the FULL graph, as a colour -
   *  view-independent, so a node keeps the same hue in every graph. Ties break
   *  by closeness (family first), so a daughter with one family and one friend
   *  tie reads family, deterministically. Memoised; cleared with the snapshot. */
  dominantRelColor(id) {
    const key = String(id);
    if (this._relTint.has(key)) return this._relTint.get(key);
    let tint = null;
    if (this.full?.hasNode(key)) {
      const counts = new Map();
      this.full.forEachEdge(key, (_k, a) => counts.set(a.type, (counts.get(a.type) || 0) + 1));
      let best = null, bestN = 0;
      for (const type of CLOSENESS_ORDER) {
        const n = counts.get(type) || 0;
        if (n > bestN) { best = type; bestN = n; }
      }
      tint = best ? EDGE_COLORS[best] : null;
    }
    this._relTint.set(key, tint);
    return tint;
  }

  nodeSize(degree) {
    return 1.5 * Math.max(3, Math.min(16, 2.5 + Math.sqrt(degree ?? 1) * 1.6));
  }


  /** In sparse views every name fits: drop sigma's size-based label culling and
   *  let its label grid (the actual overlap handler) decide alone. Dense views
   *  keep the size gate so labels don't carpet the canvas. */
  applyLabelPolicy() {
    const sparse = this.view.order > 0 && this.view.order <= LABEL_ALL_MAX_NODES;
    this.sigma.setSetting("labelRenderedSizeThreshold", sparse ? 0 : LABEL_SIZE_THRESHOLD);
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
    // Grouped around the ring by what each contact mostly is to you (family,
    // then work, then the looser ties), and by id inside a group - so the ring
    // reads as blocks of one colour rather than a shuffle. Deterministic either
    // way; this one is also legible.
    const ordered = [...this.full.nodes()].sort((a, b) =>
      this.dominantRank(a) - this.dominantRank(b) || Number(a) - Number(b));
    this.buildView(new Set(ordered), null, { layout: "circle" });
    this.fitCamera();
  }

  // -------------------------------------------------------------- orbit --
  /** Orbit rings: you at the centre, everyone else on concentric rings by how
   *  overdue you are to reach out (inner = recently/on-time in touch, outer =
   *  drifting away/never), grouped angularly by community. Deterministic - no
   *  The signature ego view the app is named for. */
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
    // Contacts sit ON their ring, so the guide circle would run straight through
    // them: keep it (and the ring chip) outside every node.
    this.clipOutNodes(ctx, this.view.nodes());
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
      // Closest tie first, then by id: the wedges come out grouped by
      // relationship instead of by whichever contact was created first.
      const near = [...this.full.neighbors(u)].sort((a, b) =>
        this.fullTieRank(u, a) - this.fullTieRank(u, b) || Number(a) - Number(b));
      for (const w of near) {
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
    // Contacts sit ON their ring: keep the guide circles off them.
    this.clipOutNodes(ctx, this.view.nodes());
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
    // When anchored on a chosen pair, keep that pair centred (expand/collapse-all
    // otherwise recentres on the whole tree's bounding box, losing the anchor).
    let cx = 0.5, cy = 0.5;
    if (this.treeAnchor != null && this.center != null) {
      const ids = [String(this.center), ...this.familyPartnersOf(String(this.center))].filter((id) => this.view.hasNode(id));
      const dds = ids.map((id) => this.sigma.getNodeDisplayData(id)).filter(Boolean);
      if (dds.length) { cx = dds.reduce((s, d) => s + d.x, 0) / dds.length; cy = dds.reduce((s, d) => s + d.y, 0) / dds.length; }
    }
    cam.animate({ x: cx, y: cy, ratio, angle: 0 }, { duration: reducedMotion ? 0 : 250 });
  }

  /** Build the sigma view from the visible set (nodes only - connectors are drawn
   *  on the overlay). */
  rebuildTreeView() {
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
        isOwner: a.isOwner, deceased: a.deceased, business: a.business,
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

  /** Tree nodes actually on screen: `treeVisible` minus anyone a legend filter
   *  (relationship or gender) has hidden. Connectors, names and expanders key off
   *  this so nothing dangles toward a person who isn't drawn. */
  treeShown() {
    const out = new Set();
    for (const id of this.treeVisible || []) {
      if (!this.view.hasNode(id)) continue;
      const dd = this.sigma.getNodeDisplayData(id);
      if (dd && !dd.hidden) out.add(id);
    }
    return out;
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
    const shown = this.treeShown();
    const done = new Set();
    for (const person of shown) {
      if (done.has(person)) continue;
      done.add(person);
      const partner = [...this.familyPartnersOf(person)].find((pn) =>
        shown.has(pn) && sameRow(pn, person));
      const members = partner ? [person, partner] : [person];
      if (partner) done.add(partner);
      // Offsets clear the node's PAINTED extent (gender ring, or the owner's
      // halo + sparkles), so no button or name lands inside a decoration.
      const halo = (m, r) => this.nodeHaloRadius(this.view.getNodeAttributes(m), r);
      for (const m of members) {
        let r; try { r = this.sigma.scaleSize(this.view.getNodeAttribute(m, "size")); } catch { r = 14; }
        const pr = halo(m, r);
        addBtn(m, "up", 0, -(pr + 11), "parents");
        addBtn(m, "sib", male(m) ? -(pr + 11) : (pr + 11), 0, "siblings");
      }
      const downOn = members.map(String).sort((a, b) => Number(a) - Number(b))[0];
      let rd; try { rd = this.sigma.scaleSize(this.view.getNodeAttribute(downOn, "size")); } catch { rd = 14; }
      const tier = (this._treeLabelTier && this._treeLabelTier.get(downOn)) || 0;
      // Below the name label's row: label top sits at halo+2 and is 15px tall.
      addBtn(downOn, "down", 0, halo(downOn, rd) + 30 + tier * 15, "children");
    }
  }

  /** Orthogonal family connectors on the overlay: couple units (framed pair + bond
   *  + heart), parent→children drop-buses, and sibling bars where no parent shows. */
  drawTreeConnectors(ctx) {
    if (this.mode !== "tree" || this.view.order === 0) return;
    const vis = this.treeShown(); // a filtered-out person takes their connectors with them
    if (!vis.size) return;
    const VP = (id) => { const a = this.view.getNodeAttributes(id); return this.sigma.graphToViewport({ x: a.x, y: a.y }); };
    const RAD = (id) => { try { return this.sigma.scaleSize(this.view.getNodeAttribute(id, "size")); } catch { return 12; } };
    const sameRow = (a, b) => Math.round(this.view.getNodeAttribute(a, "y")) === Math.round(this.view.getNodeAttribute(b, "y"));
    ctx.save();
    // Connectors stop at the rims they touch, but a drop line can still cross an
    // unrelated node in a dense lane: clip them all out.
    this.clipOutNodes(ctx, vis);
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
      // The heart sits in the gap between the two rims, never on a node; when the
      // pair is packed too tightly to hold one, the bond line alone carries it.
      const fit = pairHeartSpots(p1, p2, RAD(id) + 2, RAD(partner) + 2, Math.max(4, 0.42 * r));
      const heart = fit ? { ...fit.points[0], s: fit.s } : null;
      flows.push({ kind: "couple", segs: [[lp.x + RAD(ln), lp.y, rp.x - RAD(rn), rp.y]], members: [id, partner], heart });
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
    // Grey full connectors first, then the green sub-segments on top. Fade
    // links dims them like any other view's edges; the hover highlight and the
    // couple hearts stay full-strength so lineage tracing still works faded.
    const faded = this.edgeFade;
    for (const f of flows) {
      ctx.strokeStyle = faded
        ? this.theme.edgeFaint
        : (f.kind === "couple" ? EDGE_COLORS.family : this.theme.edge);
      ctx.lineWidth = faded ? 1 : (f.kind === "couple" ? 1.6 : 1.5);
      ctx.beginPath();
      for (const s of f.segs) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }
      ctx.stroke();
    }
    ctx.strokeStyle = FLOW_HIGHLIGHT; ctx.lineWidth = 2.8;
    ctx.beginPath();
    for (const f of flows) for (const s of greenSegs(f)) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }
    ctx.stroke();
    for (const f of flows) if (f.heart) drawHeart(ctx, f.heart.x, f.heart.y, f.heart.s, PAIR_COLOR, this.theme.bg);
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
        // Anchor below the node's PAINTED extent, not its bare radius: the
        // owner's halo + sparkles reach r+13 and were drawn straight through
        // the name (and into the ↓ expander's lane).
        const pr = this.nodeHaloRadius(this.view.getNodeAttributes(id), r);
        const tw = ctx.measureText(name).width;
        const left = p.x - tw / 2 - 4, right = p.x + tw / 2 + 4;
        let tier = 0;
        if (left < tierRight[0] + 2) tier = (left >= tierRight[1] + 2) ? 1 : (tierRight[0] <= tierRight[1] ? 0 : 1);
        tierRight[tier] = right;
        this._treeLabelTier.set(id, tier);
        const topY = p.y + pr + 2 + tier * TIER_H;
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
    ctx.save();
    const rect = this.clipOutNodes(ctx, this.treeVisible || []);
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
    this.applyLabelPolicy(); // few bubbles -> label them all
    // A legend filter persists into Cluster; re-derive it for the meta-graph.
    this.recomputeFilteredNodes();
    this.sigma.refresh();
    this.fitCamera();
  }

  /** Toggle a cluster kind ("person" | "org") in the cluster legend; hidden kinds
   *  drop their super-nodes (and, via sigma, their meta-edges). Returns visibility. */
  toggleClusterKind(kind) {
    if (this.hiddenClusterKinds.has(kind)) this.hiddenClusterKinds.delete(kind);
    else this.hiddenClusterKinds.add(kind);
    this.sigma.refresh();
    return !this.hiddenClusterKinds.has(kind);
  }

  buildClusterView() {
    this.hovered = null;
    this.reachPath = new Set();
    this.reachPathEdges = new Set();
    this.isolatedType = null;
    this.isolatedNodes = new Set();
    this.isolatedGender = null;
    this.clusterIsolate = null;
    this.clusterMembers = new Map();
    this.clusterLabels = new Map();
    this._clusterHub = new Map();
    this.clusterKind = new Map();
    this.hiddenClusterKinds = new Set(); // legend starts with both kinds visible
    const v = this.view;
    v.clear();
    this.computeCommunities();
    if (!this.full.order) return;

    const norm = (s) => String(s || "").trim();
    const nodeCluster = new Map(); // contact id -> cluster object
    /** @type {{members:number[], label:string, kind:string, hub:string, sid?:string|null, color?:string}[]} */
    const clusters = [];

    // 1. COMPANY clusters: every company (org field) on ANY contact becomes a
    // cluster with all of its people - regardless of how many there are or how you
    // relate to them - so a company you've recorded always shows up.
    const byCompany = new Map();
    this.full.forEachNode((id) => {
      const co = norm(this.full.getNodeAttribute(id, "org"));
      if (!co) return;
      if (!byCompany.has(co)) byCompany.set(co, []);
      byCompany.get(co).push(id);
    });
    const claimed = new Set();
    for (const [co, ids] of byCompany) {
      const cl = { members: ids.slice(), label: co, kind: "org", hub: co };
      clusters.push(cl);
      for (const id of ids) { claimed.add(id); nodeCluster.set(id, cl); }
    }

    // 1b. BUSINESS contacts (vendor) are companies in their own right: an
    // unclaimed business becomes its own org-kind bubble named by the contact,
    // or joins the company cluster already carrying its name. It must never
    // dissolve into a personal Louvain community (or label one as its hub).
    const orgByLabel = new Map(clusters.map((c) => [c.label, c]));
    this.full.forEachNode((id, attrs) => {
      if (claimed.has(id) || !attrs.business) return;
      const label = norm(attrs.name) || "Business";
      // Graphology hands out string keys; members holds them like the company
      // loop above does (the typedef's number[] predates that).
      const mid = /** @type {number} */ (/** @type {unknown} */ (id));
      let cl = orgByLabel.get(label);
      if (cl) {
        cl.members.push(mid);
      } else {
        cl = { members: [mid], label, kind: "org", hub: label };
        clusters.push(cl);
        orgByLabel.set(label, cl);
      }
      claimed.add(id);
      nodeCluster.set(id, cl);
    });

    // 2. Everyone else (no company, or a lone company contact) -> connectivity
    // communities (Louvain), labelled by their most-connected person.
    const remGroups = new Map();
    this.full.forEachNode((id) => {
      if (claimed.has(id)) return;
      const c = this.communities.get(id);
      if (c == null) return;
      if (!remGroups.has(c)) remGroups.set(c, []);
      remGroups.get(c).push(id);
    });
    for (const ids of remGroups.values()) {
      let topMember = ids[0], topDeg = -1;
      for (const id of ids) {
        const d = this.full.degree(id);
        if (d > topDeg) { topDeg = d; topMember = id; }
      }
      // These groups are company-less by construction (every contact with an org
      // field was already claimed into a company cluster above), so they're always
      // personal connectivity clusters, labelled by their most-connected person.
      const hubName = this.full.getNodeAttribute(topMember, "name") || "Cluster";
      const cl = { members: ids.slice(), label: hubName, kind: "person", hub: hubName };
      clusters.push(cl);
      for (const id of ids) nodeCluster.set(id, cl);
    }
    if (!clusters.length) return;

    // Deterministic order (biggest first, ties by label), then id + colour.
    clusters.sort((a, b) => b.members.length - a.members.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

    // ---- Promote connector PEOPLE out of their bubbles ------------------------
    // A company-to-company line is misleading: companies don't have relationships,
    // people do. So the owner (your network's hub) and any genuine peer bridge (a
    // person who links two clusters WITHOUT routing through you) are drawn as their
    // own person node - wired to their home cluster and to whoever they actually
    // know - so every remaining line is person->cluster or person->person.
    const ownerId = this.ownerNode();
    const ownerStr = ownerId != null && this.full.hasNode(String(ownerId)) ? String(ownerId) : null;
    const promoted = new Set();
    if (ownerStr) promoted.add(ownerStr);
    // Greedy cover of every peer-peer cross edge: promote one endpoint, always one
    // whose company keeps >=1 member behind so a company is never emptied. Two
    // lone-contact companies linked directly are left as a bubble-bubble line (rare,
    // and promoting would erase one of the companies).
    const csize = (id) => nodeCluster.get(id).members.length;
    this.full.forEachEdge((_k, _a, s, t) => {
      if (s === ownerStr || t === ownerStr) return;            // owner already covers these
      const cs = nodeCluster.get(s), ct = nodeCluster.get(t);
      if (!cs || !ct || cs === ct) return;                     // internal
      if (promoted.has(s) || promoted.has(t)) return;          // already covered
      const sOk = csize(s) >= 2, tOk = csize(t) >= 2;
      if (sOk && tOk) {
        const ds = this.full.degree(s), dt = this.full.degree(t);
        promoted.add(ds > dt || (ds === dt && Number(s) < Number(t)) ? s : t);
      } else if (sOk) promoted.add(s);
      else if (tOk) promoted.add(t);
      // else: both lone-contact companies -> keep both bubbles, allow the line.
    });

    // Nodes: a super-node per cluster over its NON-promoted core (companies stay
    // visible; a cluster whose every member was promoted just isn't drawn as a
    // bubble), plus one person node per promoted contact.
    const superSids = [];
    clusters.forEach((cl, i) => {
      cl.color = COMMUNITY_COLORS[i % COMMUNITY_COLORS.length];
      // A cluster is drawn as a bubble only if it still has a non-promoted "core"
      // (otherwise its people are all shown as connector nodes).
      const core = cl.members.filter((m) => !promoted.has(String(m)));
      if (!core.length) { cl.sid = null; return; }
      cl.sid = `k${i}`;
      superSids.push(cl.sid);
      // A COMPANY bubble represents the whole company: its count and click-to-open
      // include anyone promoted out (you belong to Solace even when drawn as your
      // own node) - promotion is only visual there. A PERSON COMMUNITY is a soft
      // grouping: a promoted bridge is shown once, as its own connector node, and is
      // excluded here - both from the count and from lending its name to a bubble it
      // is no longer drawn inside (which produced two same-named nodes).
      let members = cl.members, label = cl.label, hub = cl.hub;
      if (cl.kind !== "org") {
        members = core;
        let top = core[0], td = -1;
        for (const m of core) { const d = this.full.degree(String(m)); if (d > td) { td = d; top = m; } }
        label = this.full.getNodeAttribute(String(top), "name") || label;
        hub = label;
      }
      members = members.slice().sort((a, b) => Number(a) - Number(b));
      this.clusterMembers.set(cl.sid, members);
      this.clusterLabels.set(cl.sid, label);
      this._clusterHub.set(cl.sid, hub);
      this.clusterKind.set(cl.sid, cl.kind);
      v.addNode(cl.sid, {
        label: `${label} · ${members.length}`,
        x: 0, y: 0,
        size: 10 + Math.sqrt(members.length) * 5,
        color: cl.color,
      });
    });
    const psid = (id) => `p${id}`;
    for (const id of promoted) {
      const sid = psid(id);
      const name = this.full.getNodeAttribute(id, "name") || "Contact";
      // Opening any cluster pulls in the members' neighbors (see onClusterOpen), so
      // a connector person's drill-in lands on their ego network, not a lone node.
      this.clusterMembers.set(sid, [Number(id)]);
      this.clusterLabels.set(sid, name);
      this.clusterKind.set(sid, "person");
      v.addNode(sid, {
        label: name,
        x: 0, y: 0,
        size: id === ownerStr ? 11 : 8,
        color: id === ownerStr ? OWNER_NODE_COLOR : PERSON_NODE_COLOR,
      });
    }
    if (!v.order) return;

    // Disambiguate super-nodes that share a label (repeated person-hub names).
    const labelCounts = new Map();
    for (const sid of superSids) { const l = this.clusterLabels.get(sid); labelCounts.set(l, (labelCounts.get(l) || 0) + 1); }
    for (const sid of superSids) {
      const l = this.clusterLabels.get(sid);
      if (labelCounts.get(l) <= 1) continue;
      const hub = this._clusterHub.get(sid) || "";
      const disamb = hub && hub !== l ? `${l} · ${hub}` : l;
      this.clusterLabels.set(sid, disamb);
      v.setNodeAttribute(sid, "label", `${disamb} · ${this.clusterMembers.get(sid).length}`);
    }

    // ---- Edges over the RENDER representation ---------------------------------
    // Each contact renders as either its own person node (if promoted) or its
    // cluster super-node. Collapse the real edges onto those, keeping a per-type
    // breakdown for the relationship legend filters.
    const rep = (id) => {
      if (promoted.has(String(id))) return psid(id);
      const cl = nodeCluster.get(String(id));
      return cl ? cl.sid : null;
    };
    const w = new Map();
    const byType = new Map();
    this.full.forEachEdge((_k, attrs, s, t) => {
      const rs = rep(s), rt = rep(t);
      if (!rs || !rt || rs === rt) return;
      const key = rs < rt ? `${rs}|${rt}` : `${rt}|${rs}`;
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
      const [a, b] = key.split("|");
      if (!v.hasNode(a) || !v.hasNode(b)) continue;
      v.addEdge(a, b, {
        edgeType: "meta",
        color: this.theme.edge,
        size: 1.6, // uniform: tie count no longer drives line thickness
        typeCounts: byType.get(key), // { relationshipType: count } for legend filtering
      });
      metaEdges.push({ a, b, w: 0.5 + 1.5 * (count / maxW) });
    }

    // Anchor each promoted person to their home cluster bubble (a structural
    // "belongs to" link) when a real internal tie didn't already draw one, so a
    // connector never floats free of the group it came from.
    for (const id of promoted) {
      const cl = nodeCluster.get(String(id));
      if (!cl || !cl.sid) continue;
      const a = psid(id), b = cl.sid;
      if (v.hasEdge(a, b) || v.hasEdge(b, a)) continue;
      v.addEdge(a, b, { edgeType: "meta", anchor: true, color: this.theme.edge, size: 1.2, typeCounts: {} });
      metaEdges.push({ a, b, w: 1.4 });
    }

    // No dangling bubbles: a company whose people relate only among themselves gets
    // no cross edge and would float off alone. Tie any such super-node to a well-
    // connected anchor - the owner person node when present, else the highest-degree
    // node - so nothing is orphaned.
    let anchor = ownerStr ? psid(ownerStr) : null;
    if (!anchor || !v.hasNode(anchor) || v.degree(anchor) === 0) {
      let best = null, bestDeg = -1;
      v.forEachNode((sid) => { const d = v.degree(sid); if (d > bestDeg) { bestDeg = d; best = sid; } });
      anchor = best;
    }
    if (anchor && v.degree(anchor) > 0) {
      for (const sid of superSids) {
        if (sid === anchor || v.degree(sid) > 0) continue;
        v.addEdge(sid, anchor, { edgeType: "meta", anchor: true, color: this.theme.edge, size: 1.6, typeCounts: {} });
        metaEdges.push({ a: sid, b: anchor, w: 0.8 });
      }
    }

    // Org-only fallback links: in the person-hidden view every connector person
    // vanishes, which would strand the company bubbles (they only ever connect
    // THROUGH people now). Pre-wire each company to an anchor company - your own
    // company, else the biggest - with a bridge edge shown ONLY while people are
    // hidden, so the organization view stays a connected star instead of scattering.
    // These edges are kept OUT of the layout so they don't distort the normal view.
    const orgSuperSids = superSids.filter((sid) => this.clusterKind.get(sid) === "org");
    if (orgSuperSids.length > 1) {
      const ownerOrg = ownerStr && nodeCluster.get(ownerStr) ? nodeCluster.get(ownerStr).sid : null;
      const orgAnchor = ownerOrg && v.hasNode(ownerOrg) && this.clusterKind.get(ownerOrg) === "org"
        ? ownerOrg : orgSuperSids[0]; // superSids are biggest-first, so [0] is the largest org
      for (const sid of orgSuperSids) {
        if (sid === orgAnchor || v.hasEdge(sid, orgAnchor) || v.hasEdge(orgAnchor, sid)) continue;
        v.addEdge(sid, orgAnchor, { edgeType: "meta", anchor: true, orgBridge: true, color: this.theme.edge, size: 1.4, typeCounts: {} });
      }
    }

    // Deterministic force layout on the (small) metagraph. Node radii feed the
    // separation pass so bubbles pack snugly without overlapping.
    const sids = [];
    v.forEachNode((sid) => sids.push(sid));
    const radii = sids.map((sid) => v.getNodeAttribute(sid, "size"));
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
    this.isolatedGender = null;
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
        business: a.business,
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
    this.tagGateways(centerStr);
    // Relationship fill: fills were computed at addNode time, before relColor
    // existed, so nodes adjacent to the centre must be re-tinted now that the
    // edges are wired (nodeColor prefers the tie-to-centre when present).
    if (this.colorMode === "relationship" && centerStr) this.applyRelationshipTint();
    this.syncSparkle();
    this.applyMinimapVisibility();
    this.applyLabelPolicy();
    // A legend filter persists across a rebuild; re-derive which nodes it hides
    // for the new node/edge set before the reducer runs.
    this.recomputeFilteredNodes();
    // Ego views lay themselves out right after building, so painting the raw
    // circular seed here would show a ring that immediately vanishes: those
    // callers pass render:false and let the finished layout paint.
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

  /** What a layout must treat a contact as: the radius the canvas actually
   *  PAINTS, decorations included, not the bare body. Every gap in a layout is
   *  measured against this, so understating it by the gender ring (4.5px) or the
   *  owner's halo made the whole view read as cluttered and left couple bonds
   *  with no room for their heart. */
  layoutSize(attrs) {
    return this.nodeHaloRadius(attrs, attrs.size ?? 8);
  }

  /** Couples in the current view as ordered [left, right] ids, so the layout can
   *  hold partners side by side. Bonds are tagged by drawCoupleBonds, which every
   *  ego path runs before laying out. Man on the left, matching Tree; an unknown
   *  gender keeps the edge's own order so the result stays stable. */
  viewPairs() {
    const male = (id) =>
      (this.full?.hasNode(id) ? this.full.getNodeAttribute(id, "gender") || "" : "").toLowerCase().startsWith("m");
    /** @type {[string, string][]} */
    const pairs = [];
    this.view.forEachEdge((_k, a, s, t) => {
      if (a.pair) pairs.push(male(t) && !male(s) ? [t, s] : [s, t]);
    });
    return pairs;
  }

  /** The same, over the full graph, for the views that order their contacts
   *  before the view is built. */
  fullTieRank(a, b) {
    let best = TIE_RANK.length;
    if (!this.full) return best;
    for (const key of this.full.edges(String(a), String(b))) {
      const i = TIE_RANK.indexOf(this.full.getEdgeAttribute(key, "type"));
      if (i >= 0 && i < best) best = i;
    }
    return best;
  }

  /** What a contact mostly is, as a rank: the closest tie type they hold with
   *  anybody. Used to group contacts in views that have no centre to measure
   *  from, like the Mesh ring. */
  dominantRank(id) {
    let best = TIE_RANK.length;
    if (!this.full?.hasNode(String(id))) return best;
    this.full.forEachEdge(String(id), (_k, a) => {
      const i = TIE_RANK.indexOf(a.type);
      if (i >= 0 && i < best) best = i;
    });
    return best;
  }

  /** How close the tie between two contacts is, as a rank, so a layout can keep
   *  the same kind of tie together. Multi-edges take the closest one. */
  tieRank(a, b) {
    let best = TIE_RANK.length;
    for (const key of this.view.edges(a, b)) {
      const i = TIE_RANK.indexOf(this.view.getEdgeAttribute(key, "edgeType"));
      if (i >= 0 && i < best) best = i;
    }
    return best;
  }

  /** Each contact's tie to the centre, as a rank: the layout groups the circle by
   *  it, so family, work and friends each own an arc. Contacts further out have
   *  no tie to you and are ranked with their branch, never on their own. */
  viewRanks() {
    const rank = new Map();
    this.view.forEachNode((id, a) => {
      const i = TIE_RANK.indexOf(a.relType);
      if (i >= 0) rank.set(id, i);
    });
    return rank;
  }

  /** The ego layout: a deterministic radial tree, rings by how many steps away a
   *  contact is and one wedge per tie type. Synchronous placement, which the
   *  worker-only guardrail permits because it is not a force simulation and the
   *  ego view is capped at 1200 contacts.
   *
   *  There used to be a second engine here (ForceAtlas2 in a worker, on a
   *  toggle). It was removed: this network is a TREE - 97 contacts, 96 ties, not
   *  one cycle - and a force layout earns its keep by finding cluster structure
   *  in cross-links. With none to find it spent its freedom on arbitrary choices,
   *  and measured against this layout it drew 24 crossings to 0 and left 54 pairs
   *  of contacts overlapping on screen to 2. Circle packing was built and
   *  measured as a replacement and was worse again (75 crossings), because a
   *  packing means containment INSTEAD of lines and this canvas draws the lines.
   *  See docs/DECISIONS.md.
   */
  runEgoLayout() {
    if (this.view.order < 3) { this.sigma.refresh(); this.fitCamera(); return; }
    const nodes = [];
    this.view.forEachNode((id, a) => nodes.push({ id, size: this.layoutSize(a) }));
    const edges = [];
    this.view.forEachEdge((_k, _a, s, t) => edges.push({ source: s, target: t }));
    const rank = this.viewRanks();
    this.applyPositions(balloonLayout(nodes, edges, this.center != null ? String(this.center) : null, {
      pairs: this.viewPairs(),
      rankOf: (id) => rank.get(id) ?? TIE_RANK.length,
      tieRank: (a, b) => this.tieRank(a, b),
    }));
    this.fitCamera();
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

  /** Switch the node fill: organization / community / relationship. Returns the
   *  community count when switching to community, else 0. */
  setColorMode(mode) {
    this.colorMode = mode;
    localStorage.setItem("orbit-color-mode", mode);
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

  /** Retint everything after a palette switch. Edge colors and relationship
   *  tints are baked into view attributes at build time, and dominantRelColor()
   *  memoises hexes, so all three need refreshing; ring colors and the cluster
   *  isolate read the live color objects and just need the repaint. */
  repaintPalette() {
    this._relTint.clear();
    this.view.forEachEdge((key, attrs) => {
      if (attrs.edgeType) this.view.setEdgeAttribute(key, "color", EDGE_COLORS[attrs.edgeType] ?? EDGE_DEFAULT);
    });
    this.view.forEachNode((id, attrs) => {
      if (attrs.relType) this.view.setNodeAttribute(id, "relColor", EDGE_COLORS[attrs.relType] ?? null);
    });
    if (this.mode !== "cluster") {
      this.view.forEachNode((id) => {
        if (!this.full?.hasNode(id)) return; // super-nodes and synthetics keep their fill
        const isCenter = this.center != null && Number(id) === this.center;
        this.view.setNodeAttribute(id, "color", this.nodeColor(id, this.full.getNodeAttributes(id), isCenter));
      });
    }
    this.sigma.refresh();
  }

  toggleEdgeType(type) {
    // Works in every view - in Cluster it re-weights meta-edges by their breakdown.
    if (this.hiddenTypes.has(type)) this.hiddenTypes.delete(type);
    else this.hiddenTypes.add(type);
    this.recomputeFilteredNodes();
    this.sigma.refresh();
    return !this.hiddenTypes.has(type);
  }

  /** Gender legend click: filter that gender's contacts out of the canvas (their
   *  lines go with them). Returns whether the gender is now visible. */
  toggleGender(gender) {
    if (this.hiddenGenders.has(gender)) this.hiddenGenders.delete(gender);
    else this.hiddenGenders.add(gender);
    if (this.isolatedGender && this.hiddenGenders.has(this.isolatedGender)) this.isolatedGender = null;
    this.sigma.refresh();
    return !this.hiddenGenders.has(gender);
  }

  /** Gender legend hover: show only that gender (plus you / the centre).
   *  clearIsolate() restores. A filtered-off gender has nothing to isolate. */
  isolateGender(gender) {
    if (this.mode === "cluster" || this.hiddenGenders.has(gender)) return;
    this.isolatedGender = gender;
    this.sigma.refresh();
  }

  /** Recompute which nodes to hide because every relationship line touching them
   *  is filtered off in the legend. A node with NO edges at all is left alone
   *  (it was never reachable via the toggled type); only a node that HAD edges
   *  and now has none visible is hidden, so its dangling dot goes with the line.
   *  Call after any change to hiddenTypes or after rebuilding this.view. Cheap
   *  no-op when nothing is filtered. Honors the Cluster meta-edge breakdown. */
  recomputeFilteredNodes() {
    const hidden = new Set();
    if (this.hiddenTypes.size && this.view) {
      const hasEdge = new Set();
      const hasVisible = new Set();
      this.view.forEachEdge((_k, attrs, s, t) => {
        hasEdge.add(s); hasEdge.add(t);
        let visible;
        if (attrs.edgeType === "meta") {
          const tc = attrs.typeCounts || {};
          visible = attrs.anchor || Object.keys(tc).some((type) => !this.hiddenTypes.has(type));
        } else {
          visible = !this.hiddenTypes.has(attrs.edgeType);
        }
        if (visible) { hasVisible.add(s); hasVisible.add(t); }
      });
      for (const id of hasEdge) if (!hasVisible.has(id)) hidden.add(id);
    }
    this.filteredOutNodes = hidden;
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
    if (this.isolatedGender != null) { this.isolatedGender = null; changed = true; }
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
    this.sigma.kill();
  }
}

export function renderLegend(el, genderEl, onToggle, onHover, onHoverEnd, onGenderToggle, onGenderHover, hidden) {
  // Edge-type legend (bottom-left; click to filter, hover to isolate).
  // `hidden` ({types, genders} Sets) restores filter state when the legend is
  // re-rendered mid-session (palette switch); omitted on first render.
  el.innerHTML = "";
  for (const [type, color] of Object.entries(EDGE_COLORS)) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "legend-item";
    const off = hidden?.types?.has(type) ?? false;
    if (off) item.classList.add("off");
    item.style.cssText = "border:0;background:none;color:inherit;font:inherit;padding:0;";
    // The struck-through "off" look is visual only, so state goes to assistive
    // tech too (same contract as the gender legend below).
    item.setAttribute("aria-pressed", String(!off));
    item.title = `Show only ${type} links on hover; click to hide them`;
    const swatch = document.createElement("i");
    swatch.className = "legend-swatch";
    swatch.style.background = color;
    item.append(swatch, document.createTextNode(type));
    item.addEventListener("click", () => {
      const visible = onToggle(type);
      item.classList.toggle("off", !visible);
      item.setAttribute("aria-pressed", String(visible));
    });
    // Hover (or keyboard focus): isolate this relationship on the canvas.
    item.addEventListener("mouseenter", () => onHover?.(type));
    item.addEventListener("mouseleave", () => onHoverEnd?.());
    item.addEventListener("focus", () => onHover?.(type));
    item.addEventListener("blur", () => onHoverEnd?.());
    el.appendChild(item);
  }
  el.hidden = false;

  // (Cluster person/org legend is rendered separately via renderClusterLegend.)
  // Gender-ring legend (bottom-right; same grammar as above - click to filter,
  // hover to isolate).
  if (genderEl) {
    genderEl.innerHTML = "";
    for (const [g, color] of Object.entries(GENDER_RING)) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "legend-item";
      const off = hidden?.genders?.has(g) ?? false;
      if (off) item.classList.add("off");
      item.style.cssText = "border:0;background:none;color:inherit;font:inherit;padding:0;";
      item.setAttribute("aria-pressed", String(!off));
      item.title = `Show only ${g} contacts on hover; click to hide them`;
      const ring = document.createElement("i");
      ring.className = "legend-ring";
      ring.style.borderColor = color;
      item.append(ring, document.createTextNode(g));
      item.addEventListener("click", () => {
        const visible = onGenderToggle ? onGenderToggle(g) : true;
        item.classList.toggle("off", !visible);
        item.setAttribute("aria-pressed", String(visible));
      });
      item.addEventListener("mouseenter", () => onGenderHover?.(g));
      item.addEventListener("mouseleave", () => onHoverEnd?.());
      item.addEventListener("focus", () => onGenderHover?.(g));
      item.addEventListener("blur", () => onHoverEnd?.());
      genderEl.append(item);
    }
    genderEl.hidden = false;
  }
}

/** Cluster-only legend (person vs organization); click toggles that kind's
 *  clusters. `onToggle(kind)` returns whether the kind is now visible. */
export function renderClusterLegend(el, onToggle) {
  el.innerHTML = "";
  const PERSON_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="8" cy="4.5" r="2.6"/><path d="M2.5 14c0-3 2.5-5 5.5-5s5.5 2 5.5 5z"/></svg>';
  const ORG_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M3 14V2.5h6.5V14zm2-9.5h2.5V6H5zm0 3h2.5v1.5H5zm5.5-2H14V14h-3.5z"/></svg>';
  const items = [["person", "person", PERSON_ICON], ["org", "organization", ORG_ICON]];
  for (const [kind, label, icon] of items) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "legend-item";
    item.style.cssText = "border:0;background:none;color:inherit;font:inherit;padding:0;display:inline-flex;align-items:center;gap:5px;";
    item.title = `Click to hide the ${label} clusters`;
    const ico = document.createElement("span");
    ico.className = "legend-ico";
    ico.innerHTML = icon;
    item.append(ico, document.createTextNode(label));
    item.setAttribute("aria-pressed", "true");
    item.addEventListener("click", () => {
      const visible = onToggle(kind);
      item.classList.toggle("off", !visible);
      item.setAttribute("aria-pressed", String(visible));
      item.title = visible ? `Click to hide the ${label} clusters` : `Click to show the ${label} clusters`;
    });
    el.appendChild(item);
  }
  el.hidden = false;
}
