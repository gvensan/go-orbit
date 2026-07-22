// graph-view.js - the constellation (GRAPH_CANVAS spec). Two modes:
//   ego  - a contact's N-hop neighborhood, laid out by the renderer-side
//          web worker (fast, small graphs)
//   full - the whole network, positions persisted in SQLite; heavy layout
//          runs in the MAIN-side worker and streams in over graph:layout:tick
// Plus: node drag (positions saved in full mode), shortest-path highlight,
// Louvain community coloring, and edge-type filtering from the legend.

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import Sigma from "sigma";
import { EDGE_COLORS, EDGE_DEFAULT, orgColor } from "./colors.js";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Canvas colors follow the app theme (the graph is themed too, not just chrome).
function graphTheme() {
  const light = document.documentElement.dataset.theme === "light";
  return light
    ? { label: "#334155", dim: "#cbd5e1", center: "#0f172a", edge: "#c3ccdb", pathDim: "#dbe2ec", pathHi: "#2563eb", bg: "#eef2f8", hoverBg: "#ffffff", hoverBorder: "#cbd5e1",
        ownerFill: "#f0a500", ownerGlow: "#e07a00", ownerRing: "#b4700a", ownerSparkleRGB: "150,95,5",
        deceasedGlow: "#7c8aa0", deceasedRing: "#475569" }
    : { label: "#c7d2e4", dim: "#1d2a44", center: "#e2e8f0", edge: EDGE_DEFAULT, pathDim: "#131c30", pathHi: "#93c5fd", bg: "#0a0f1c", hoverBg: "#0d1526", hoverBorder: "#2b4a80",
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

const COMMUNITY_COLORS = [
  "#7aa2f7", "#e0af68", "#9ece6a", "#f7768e", "#bb9af7",
  "#2ac3de", "#ff9e64", "#73daca", "#c0caf5", "#f4b8e4",
];

export class GraphView {
  /**
   * @param {HTMLElement} container
   * @param {{ onSelect: (id: number) => void, onShiftSelect: (id: number) => void,
   *           onDragEnd: (id: number, pos: {x: number, y: number}) => void,
   *           onNodeMenu?: (id: number, pos: {x: number, y: number}) => void }} handlers
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
    this.pathNodes = new Set();
    this.pathEdgePairs = new Set();
    this.colorMode = "org"; // "org" | "community"
    this.communities = new Map();
    this.dragging = null;
    this.dragMoved = false;
    this.pinned = new Set(); // session pins: layout leaves these alone
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
    const mmFit = document.createElement("button");
    mmFit.className = "minimap-fit"; mmFit.type = "button"; mmFit.textContent = "⛶"; mmFit.title = "Fit all to view";
    mmFit.addEventListener("click", () => this.fitCamera());
    this.minimapWrap.append(mmHide, mmFit, this.minimapCanvas);
    this.minimapShow = document.createElement("button");
    this.minimapShow.className = "minimap-show"; this.minimapShow.type = "button"; this.minimapShow.textContent = "🗺"; this.minimapShow.title = "Show minimap";
    this.minimapShow.addEventListener("click", () => this.setMinimapVisible(true));
    this._mmMap = null;
    this._mmDragging = false;

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
        if (this.pinned.has(node)) {
          out.size = data.size + 2;
          out.forceLabel = true;
        }
        // Center node color follows the theme (flips live on toggle)...
        if (this.center != null && node === String(this.center)) out.color = this.theme.center;
        // ...but the owner ("you") stays sun-gold even when it's the centre.
        if (out.isOwner || this.view.getNodeAttribute(node, "isOwner")) out.color = this.theme.ownerFill;
        if (this.pathNodes.size) {
          if (this.pathNodes.has(node)) {
            out.color = this.theme.center;
            out.zIndex = 2;
          } else {
            out.color = this.theme.dim;
            out.label = null;
          }
          return out;
        }
        if (this.hovered && node !== this.hovered && !this.view.areNeighbors(node, this.hovered)) {
          out.color = this.theme.dim;
          out.label = null;
        }
        return out;
      },
      edgeReducer: (edge, data) => {
        const out = { ...data };
        // "type" is reserved by sigma for its render program; ours is edgeType.
        const attrs = this.view.getEdgeAttributes(edge);
        if (this.hiddenTypes.has(attrs.edgeType)) {
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
        if (this.hovered && s !== this.hovered && t !== this.hovered) out.hidden = true;
        return out;
      },
    });

    this.wireEvents();
  }

  wireEvents() {
    // Overlay + hover card go on top of sigma's canvases (appended last).
    this.container.append(this.overlay, this.hoverCard, this.minimapWrap, this.minimapShow);
    this.applyMinimapVisibility(); // empty graph on boot -> no minimap chrome
    // Redraw the ring/badge overlay + minimap after every sigma paint.
    this.sigma.on("afterRender", () => { this.drawOverlay(); this.drawMinimap(); });

    // Minimap panning: click / drag jumps the main camera to that spot.
    const mmPan = (ev) => this.panFromMinimap(ev);
    this.minimapCanvas.addEventListener("mousedown", (ev) => { this._mmDragging = true; mmPan(ev); });
    window.addEventListener("mousemove", (ev) => { if (this._mmDragging) mmPan(ev); });
    window.addEventListener("mouseup", () => { this._mmDragging = false; });

    this.sigma.on("clickNode", ({ node, event }) => {
      if (this.dragMoved) return; // this click is the tail of a drag
      this.hoverCard.hidden = true; // dismiss the tooltip on click
      const id = Number(node);
      if (event.original.shiftKey) this.handlers.onShiftSelect(id);
      else this.handlers.onSelect(id);
    });
    this.sigma.on("enterNode", ({ node }) => {
      this.hovered = node;
      this.container.style.cursor = "pointer";
      this.showHoverCard(node);
      this.sigma.refresh();
    });
    this.sigma.on("leaveNode", () => {
      this.hovered = null;
      this.container.style.cursor = "";
      this.hoverCard.hidden = true;
      this.sigma.refresh();
    });

    // Right-click (or 2-finger click) a node: quick "add a connection" menu.
    // Driven by the DOM contextmenu event + the hovered node, which is reliable
    // across sigma versions (sigma's own rightClickNode can be finicky).
    this.container.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (this.hovered != null && this.handlers.onNodeMenu) {
        this.hoverCard.hidden = true;
        this.handlers.onNodeMenu(Number(this.hovered), { x: ev.clientX, y: ev.clientY });
      }
    });

    // Double-click pins/unpins: pinned nodes keep their position through
    // layout ticks (their dragged spot is already persisted in full mode).
    this.sigma.on("doubleClickNode", (e) => {
      e.preventSigmaDefault(); // no zoom-on-double-click
      const node = e.node;
      this.pinned.has(node) ? this.pinned.delete(node) : this.pinned.add(node);
      this.sigma.refresh();
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
    if (!this.full?.hasNode(node)) return;
    const a = this.full.getNodeAttributes(node);
    const bits = [];
    const sub = [a.role, a.org, a.gender].filter(Boolean).join(" · ");
    if (sub) bits.push(sub);
    if (a.place || a.location) bits.push(`📍 ${a.place || a.location}`);
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

    const na = this.view.getNodeAttributes(node);
    const pos = this.sigma.graphToViewport({ x: na.x, y: na.y });
    this.hoverCard.hidden = false;
    // Auto-placement: prefer to the right of the node, past its radius + ring;
    // flip to the left when there isn't room so the card never covers the node.
    let nr;
    try { nr = this.sigma.scaleSize(na.size); } catch { nr = na.size; }
    const gap = nr + 14;
    const rect = this.container.getBoundingClientRect();
    const cw = this.hoverCard.offsetWidth;
    const ch = this.hoverCard.offsetHeight;
    let x = pos.x + gap; // right of the node
    if (x + cw > rect.width - 8) x = pos.x - gap - cw; // flip to the left
    x = Math.max(8, Math.min(x, rect.width - cw - 8));
    const y = Math.max(8, Math.min(pos.y - 12, rect.height - ch - 8));
    this.hoverCard.style.left = `${x}px`;
    this.hoverCard.style.top = `${y}px`;
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
        gender: n.gender, starred: n.starred, isOwner: n.isOwner, lastInteractionAt: n.lastInteractionAt,
        location: n.location, place: n.place, deceased: n.deceased,
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
    if (this.view.order === 0 || this.view.order > OVERLAY_MAX_NODES) return;

    const centerStr = this.center != null ? String(this.center) : null;
    const hoverOnly = this.genderRingMode === "hover";
    this.view.forEachNode((id, attrs) => {
      if (!Number.isFinite(attrs.x) || !Number.isFinite(attrs.y)) return;
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
      // Deceased: a soft, steady halo (a quiet but visible memorial glow).
      if (attrs.deceased) {
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.shadowColor = this.theme.deceasedGlow;
        ctx.shadowBlur = 22;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 3.5, 0, 2 * Math.PI);
        ctx.lineWidth = 2.6;
        ctx.strokeStyle = this.theme.deceasedRing;
        ctx.stroke();
        // second, wider faint ring for extra glow spread
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 7, 0, 2 * Math.PI);
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.restore();
      }
      const ring = GENDER_RING[attrs.gender];
      const drawRing = ring && (!hoverOnly || id === this.hovered);
      if (drawRing) {
        const rr = r + 3;
        // A thin background gap ring first, so the colored ring stays legible
        // on similarly-colored fills.
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, 2 * Math.PI);
        ctx.lineWidth = 3;
        ctx.strokeStyle = this.theme.bg;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, 2 * Math.PI);
        ctx.lineWidth = 1.8;
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
  focusSet(ids, { induce = true } = {}) {
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
    this.buildView(set, null);
    this.runEgoLayout();
    this.fitCamera();
    return set.size;
  }

  /** Home: show the WHOLE graph (every node + connection) centred on you.
   *  For large networks, defer to the persisted full-network layout. */
  focusAll(centerId) {
    if (!this.full) return;
    if (this.full.order > 1200) { this.showFull(); return; } // scale guard
    this.mode = "ego";
    this.center = centerId;
    this.clearPath();
    const all = new Set(this.full.nodes());
    this.buildView(all, centerId);
    this.runEgoLayout();
    this.fitCamera();
  }

  nodeColor(id, attrs, isCenter = false) {
    if (isCenter) return this.theme.center;
    if (attrs.isOwner) return this.theme.ownerFill; // "you" - a distinct gold (theme-aware)
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
    const toMap = (x, y) => ({ x: ox + (x - minX) * scale, y: oy + (y - minY) * scale });
    this._mmMap = { minX, minY, scale, ox, oy };
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
    // viewport rectangle (camera center + zoom, in framed coords)
    const cam = this.sigma.getCamera().getState();
    const half = cam.ratio / 2;
    const a = toMap(cam.x - half, cam.y - half), b = toMap(cam.x + half, cam.y + half);
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
    const fy = m.minY + (my - m.oy) / m.scale;
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
    this.buildView(seen, centerId);
    this.runEgoLayout();
    this.fitCamera();
  }

  // --------------------------------------------------------------- full --
  showFull() {
    if (!this.full) return;
    this.mode = "full";
    this.center = null;
    this.clearPath();
    const all = new Set(this.full.nodes());
    this.buildView(all, null, { usePersisted: true });
    this.fitCamera();
  }

  buildView(idSet, centerId, { usePersisted = false } = {}) {
    this.worker?.terminate();
    this.worker = null;
    // Drop any hover state from the previous view. A stale `hovered` node that
    // isn't in the rebuilt view makes the edge reducer hide every edge (no edge
    // is incident to it), so the graph would render as nodes with no lines.
    this.hovered = null;
    const v = this.view;
    v.clear();
    const R = 100 * Math.sqrt(Math.max(1, idSet.size) / 50);
    let i = 0;
    for (const id of idSet) {
      const a = this.full.getNodeAttributes(id);
      const isCenter = centerId != null && Number(id) === centerId;
      // Phase offset keeps tiny views off the axes: a 2-node view otherwise puts
      // both nodes at y=0, and sigma's normalization (zero vertical extent) flings
      // them to opposite corners.
      const angle = (2 * Math.PI * i++) / idSet.size + 0.42;
      const hasPos = usePersisted && Number.isFinite(a.x) && Number.isFinite(a.y);
      v.addNode(id, {
        label: a.name,
        x: hasPos ? a.x : isCenter ? 0 : R * Math.cos(angle),
        y: hasPos ? a.y : isCenter ? 0 : R * Math.sin(angle),
        size: this.nodeSize(a.degree),
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
    this.sigma.refresh();
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
    if (this.view.order < 3) { this.sigma.refresh(); return; }
    const nodes = [];
    this.view.forEachNode((id, a) => nodes.push({ id, x: a.x, y: a.y, size: a.size }));
    const edges = [];
    this.view.forEachEdge((_k, _a, s, t) => edges.push({ source: s, target: t }));

    const worker = new Worker(new URL("./layout-worker.js", import.meta.url), { type: "module" });
    this.worker = worker;
    let last = null;
    worker.onmessage = (e) => {
      if (e.data.type === "tick") {
        last = e.data.positions;
        if (!reducedMotion) this.applyPositions(last);
      } else {
        if (last) this.applyPositions(last);
        worker.terminate();
        if (this.worker === worker) this.worker = null;
      }
    };
    worker.postMessage({ nodes, edges });
  }

  /** Positions streamed from the MAIN-side layout worker (full mode). */
  applyExternalPositions(positions) {
    if (this.mode !== "full") return;
    for (const [id, p] of Object.entries(positions)) {
      if (this.full?.hasNode(id)) this.full.mergeNodeAttributes(id, { x: p.x, y: p.y });
    }
    this.applyPositions(positions);
  }

  applyPositions(positions) {
    for (const [id, p] of Object.entries(positions)) {
      if (this.view.hasNode(id) && !this.pinned.has(id)) {
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
  /** Highlight a path (ids in order); switches to full mode if needed. */
  highlightPath(ids) {
    const strIds = ids.map(String);
    if (this.mode !== "full" && !strIds.every((id) => this.view.hasNode(id))) {
      this.showFull();
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
    // Louvain needs a mono undirected view of the multi graph.
    const mono = new Graph({ type: "undirected" });
    this.full.forEachNode((id) => mono.addNode(id));
    this.full.forEachEdge((_k, _a, s, t) => {
      if (s !== t && !mono.hasEdge(s, t)) mono.addEdge(s, t);
    });
    if (mono.size === 0) return 0; // only self-loops existed
    const mapping = louvain(mono);
    this.communities = new Map(Object.entries(mapping));
    return new Set(Object.values(mapping)).size;
  }

  /** Toggle org vs community coloring; returns community count when on. */
  setColorMode(mode) {
    this.colorMode = mode;
    let count = 0;
    if (mode === "community") count = this.computeCommunities();
    this.view.forEachNode((id) => {
      const isCenter = this.center != null && Number(id) === this.center;
      this.view.setNodeAttribute(id, "color", this.nodeColor(id, this.full.getNodeAttributes(id), isCenter));
    });
    this.sigma.refresh();
    return count;
  }

  toggleEdgeType(type) {
    if (this.hiddenTypes.has(type)) this.hiddenTypes.delete(type);
    else this.hiddenTypes.add(type);
    this.sigma.refresh();
    return !this.hiddenTypes.has(type);
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

export function renderLegend(el, genderEl, onToggle) {
  // Edge-type legend (bottom-left; clickable to filter).
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
