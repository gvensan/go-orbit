// Pure geometry helpers for the graph overlay. Kept out of graph-view.js (which
// pulls in sigma and the DOM) so the placement rules can be unit tested.

export const PAIR_HEART_PAD = 3;    // clear space kept between a heart and each node rim
export const PAIR_HEART_MIN = 3.2;  // below this the heart is unreadable - drop it instead

/** Where a couple heart may sit on the bond p1→p2 without covering either node.
 *  The heart rides the free gap between the two rims, never the plain segment
 *  midpoint (which lands inside the bigger node whenever the two differ in size or
 *  sit close together), and is shrunk to fit; when the gap cannot hold a legible
 *  heart the caller gets null and draws none. `want` is the requested heart size
 *  `s`, whose drawn half-extent is ~1.35s plus the 2.4px outline. Candidate points
 *  come back best-first (gap centre, then outward) so a caller that also knows
 *  where the other nodes are can pick the first one that clears them.
 *  @returns {{s:number, half:number, points:{x:number,y:number}[]}|null} */
export function pairHeartSpots(p1, p2, r1, r2, want) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const d = Math.hypot(dx, dy);
  if (!(d > 0)) return null;
  const from = r1 + PAIR_HEART_PAD;      // free gap starts here, measured from p1
  const to = d - r2 - PAIR_HEART_PAD;    // ...and ends here
  const room = to - from;
  if (room <= 0) return null;
  const s = Math.min(want, (room / 2 - 1.2) / 1.35);
  if (s < PAIR_HEART_MIN) return null;
  const half = 1.35 * s + 1.2;
  const lo = from + half, hi = to - half; // legal centres (lo <= hi by construction)
  const mid = (lo + hi) / 2, span = (hi - lo) / 2;
  const points = [];
  for (const f of [0, 0.5, -0.5, 1, -1]) {
    const t = mid + f * span;
    points.push({ x: p1.x + (dx / d) * t, y: p1.y + (dy / d) * t });
  }
  return { s, half, points };
}

/** Point-vs-nodes index for the overlay: nodes bucketed by their viewport
 *  position so a decoration can ask "does anything sit here?" without scanning
 *  every node. Cells are sized off the largest node so a small neighbourhood is
 *  an exact answer, and each node is filed once.
 *  @param {{x:number,y:number,r:number}[]} spots
 *  @returns {(x:number, y:number, rad:number) => boolean} */
export function nodeHitIndex(spots) {
  let maxR = 0;
  for (const s of spots) if (s.r > maxR) maxR = s.r;
  const cell = Math.max(64, maxR);
  const grid = new Map();
  for (const s of spots) {
    const k = `${Math.floor(s.x / cell)},${Math.floor(s.y / cell)}`;
    const bucket = grid.get(k);
    if (bucket) bucket.push(s); else grid.set(k, [s]);
  }
  return (x, y, rad) => {
    const n = Math.ceil((maxR + rad) / cell);
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const bucket = grid.get(`${cx + i},${cy + j}`);
        if (!bucket) continue;
        for (const s of bucket) if (Math.hypot(s.x - x, s.y - y) < s.r + rad) return true;
      }
    }
    return false;
  };
}

// --- couple units ----------------------------------------------------------
// A partner bond is one edge among many, so a force layout happily drags the two
// halves of a couple to opposite sides of the graph and the bond then crosses the
// whole web. Instead a couple is folded into ONE layout unit (the layout can no
// longer separate them by construction) and split apart again afterwards. Tree
// mode already lays couples out as units; this is the same rule for the force and
// balloon layouts.

// How wide a heart the bond should be able to carry. The overlay asks for
// 0.6 x the smaller partner's radius (min 4), so a pair of ordinary contacts
// wants about this; sizing the gap for it means the mark is never dropped.
const HEART_WANT = 5;

/** Clear space kept between two partners' painted rims. NOT a taste value: it is
 *  what pairHeartSpots needs to return a legible heart, so a bond is never drawn
 *  without its mark. A hand-set 18 left 0 of 10 couples with room. */
export const COUPLE_GAP = 2 * PAIR_HEART_PAD + 2 * (1.35 * Math.max(PAIR_HEART_MIN, HEART_WANT) + 1.2);

/** ...but a view is framed to its extent, and sigma keeps a node the same size
 *  on screen however far out the camera pulls. A gap fixed in graph units
 *  therefore closes up at fit-to-window precisely when a network gets big. Tying
 *  it to the partners' own size instead keeps the pair in proportion to
 *  everything around it - and gives the biggest node in the view (you, halo and
 *  all) the widest berth, which is where the pinch actually shows. */
export const COUPLE_SPREAD = 2.6;

/** Fold couples into layout units. Each person joins at most one unit (a
 *  matching): a second bond on someone already paired is left to the layout, so
 *  a remarriage or an A-B-C co-parent chain still shows every bond but only one
 *  of them is guaranteed adjacent. Units keep the caller's member order (Tree
 *  puts the man first) and take the id of their first member, so unit ids can
 *  never collide with a real node id.
 *  @param {{id: string, size?: number}[]} nodes
 *  @param {[string, string][]} pairs
 *  @returns {{units: {id: string, members: string[], sep: number, size: number}[],
 *             unitOf: Map<string, {id: string, members: string[], sep: number, size: number}>}} */
export function coupleUnits(nodes, pairs, coupleGap) {
  const sizeOf = new Map(nodes.map((n) => [String(n.id), n.size ?? 8]));
  // The gap has to survive fit-to-window. A view is framed to its extent, which
  // grows with the contact count, while a node shrinks only as the square root of
  // the zoom - so a gap fixed in graph units closes up on screen exactly when the
  // network gets big, and the heart goes with it. Widening it by the fourth root
  // of the count holds the ON-SCREEN gap roughly constant. Whatever it works out
  // to, the unit's radius below is derived from it, so every layout reserves the
  // pair's real width and nothing is placed inside it.

  const unitOf = new Map();
  const units = [];
  const ordered = (pairs ?? [])
    .map(([a, b]) => [String(a), String(b)])
    .filter(([a, b]) => a !== b && sizeOf.has(a) && sizeOf.has(b))
    .sort((p, q) => (p[0] === q[0] ? (p[1] < q[1] ? -1 : 1) : p[0] < q[0] ? -1 : 1));
  for (const [a, b] of ordered) {
    if (unitOf.has(a) || unitOf.has(b)) continue;
    const sa = sizeOf.get(a), sb = sizeOf.get(b);
    const sep = sa + sb + (coupleGap ?? Math.max(COUPLE_GAP, COUPLE_SPREAD * (sa + sb)));
    // The unit's radius covers the pair's whole extent, so a layout that respects
    // node sizes leaves room for both halves before they are split apart.
    const u = { id: a, members: [a, b], sep, size: sep / 2 + Math.max(sa, sb) };
    units.push(u);
    unitOf.set(a, u);
    unitOf.set(b, u);
  }
  for (const n of nodes) {
    const id = String(n.id);
    if (unitOf.has(id)) continue;
    const u = { id, members: [id], sep: 0, size: sizeOf.get(id) };
    units.push(u);
    unitOf.set(id, u);
  }
  return { units, unitOf };
}

/** The layout input with every couple collapsed to one node: edges are rewired
 *  onto units, the bond itself becomes internal and drops out, and a unit is
 *  seeded at its members' midpoint. Multi-edges survive (two units tied by three
 *  relationships still attract three times as hard). */
export function contractCouples(nodes, edges, pairs, coupleGap) {
  const { units, unitOf } = coupleUnits(nodes, pairs, coupleGap);
  const seed = new Map(nodes.map((n) => [String(n.id), n]));
  const unitNodes = units.map((u) => {
    const ms = u.members.map((m) => seed.get(m));
    return {
      id: u.id,
      x: ms.reduce((s, n) => s + (n.x ?? 0), 0) / ms.length,
      y: ms.reduce((s, n) => s + (n.y ?? 0), 0) / ms.length,
      size: u.size,
    };
  });
  const unitEdges = [];
  for (const e of edges) {
    const s = unitOf.get(String(e.source))?.id, t = unitOf.get(String(e.target))?.id;
    if (s == null || t == null || s === t) continue;
    unitEdges.push({ source: s, target: t });
  }
  return { nodes: unitNodes, edges: unitEdges, units, unitOf };
}

/** Which partner of a couple each neighbouring unit actually knows: 0 for the
 *  first member, 1 for the second, and 0 for anyone tied to both. This is the
 *  pre-analysis a placement needs BEFORE it splits a couple - split blind and a
 *  partner can end up on the far side from their own people, with every one of
 *  their lines reaching back across the other partner's.
 *  @param {{id: string, members: string[]}[]} units
 *  @param {{source: string, target: string}[]} edges
 *  @param {Map<string, {id: string}>} unitOf
 *  @returns {Map<string, Map<string, number>>} */
export function partnerSides(units, edges, unitOf) {
  /** @type {Map<string, Map<string, number>>} */
  const sides = new Map();
  const of = new Map();
  for (const u of units) {
    if (u.members.length !== 2) continue;
    of.set(u.members[0], [u.id, 0]);
    of.set(u.members[1], [u.id, 1]);
    sides.set(u.id, new Map());
  }
  if (!sides.size) return sides;
  for (const e of edges) {
    const a = String(e.source), b = String(e.target);
    for (const [self, other] of [[a, b], [b, a]]) {
      const seat = of.get(self);
      if (!seat) continue;
      const [uid, at] = seat;
      const nbr = unitOf.get(other)?.id;
      if (nbr == null || nbr === uid) continue;
      const side = sides.get(uid);
      // Someone tied to BOTH partners is filed with the first: their second line
      // has to reach across either way (two parents sharing children is a shape
      // that cannot be drawn flat in a ring), and filing them in the middle only
      // means BOTH lines reach.
      side.set(nbr, Math.min(side.get(nbr) ?? at, at));
    }
  }
  return sides;
}

/** Split unit positions back into per-person positions. Partners straddle the
 *  line running to `centre` (the units' centroid when none is given), so both sit
 *  the same distance out and their own branches fan outward beside each other
 *  rather than one partner's ties crossing the other. The first member takes the
 *  left/upper side, which keeps the pair's orientation stable between runs -
 *  unless `sides` (from partnerSides) says otherwise, in which case each partner
 *  is turned to face the people they actually know.
 *  @param {Map<string, Map<string, number>>} [sides]
 *  @returns {Record<string, {x: number, y: number}>} */
export function expandCouples(positions, units, centre, sides) {
  let cx = 0, cy = 0;
  if (centre) { cx = centre.x; cy = centre.y; }
  else {
    let n = 0;
    for (const u of units) {
      const p = positions[u.id];
      if (p) { cx += p.x; cy += p.y; n++; }
    }
    if (n) { cx /= n; cy /= n; }
  }
  /** @type {Record<string, {x: number, y: number}>} */
  const out = {};
  for (const u of units) {
    const p = positions[u.id];
    if (!p) continue;
    if (u.members.length === 1) { out[u.members[0]] = { x: p.x, y: p.y }; continue; }
    const dx = p.x - cx, dy = p.y - cy;
    const d = Math.hypot(dx, dy);
    // The split always runs the way angles increase, never "whichever side is
    // left on screen". A caller that also orders a couple's children by partner
    // (the balloon does) can then rely on member 0 and member 0's children being
    // on the SAME side; picking the side by screen x put a couple at the bottom
    // of the circle back to front, and every one of its lines crossed.
    let tx = 1, ty = 0;
    if (d > 1e-6) { tx = -dy / d; ty = dx / d; }
    // Which way round? Member 0 sits on the -t side, so turn the pair until that
    // is the side member 0's own contacts are on. Without this the split is blind
    // and a partner's lines cross their partner's to get where they are going.
    const seatOf = sides?.get(u.id);
    if (seatOf?.size) {
      let vx = 0, vy = 0;
      for (const [nbr, at] of seatOf) {
        const q = positions[nbr];
        if (!q) continue;
        const w = at === 0 ? 1 : -1;
        vx += (q.x - p.x) * w; vy += (q.y - p.y) * w;
      }
      if (vx * -tx + vy * -ty < 0) { tx = -tx; ty = -ty; }
    }
    const h = u.sep / 2;
    out[u.members[0]] = { x: p.x - tx * h, y: p.y - ty * h };
    out[u.members[1]] = { x: p.x + tx * h, y: p.y + ty * h };
  }
  return out;
}

// --- balloon (radial-tree) layout -----------------------------------------
// Deterministic fractal-style layout for the ego view: the centre at the
// origin, its people fanned on rings, each branch subdividing its parent's wedge
// recursively. Pure function so the wedge math is unit-testable; the caller
// (graph-view) only applies the returned positions.

const wrapTurn = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const BALLOON_RING_GAP = 130;     // minimum graph units between depth rings
export const BALLOON_NODE_PAD = 3.0;     // sibling spacing as a multiple of node size
export const BALLOON_LANES = 2;          // seats deep: a ring is a lane, not a rope
// Half the ring gap, and that is a constraint rather than a taste: the step has
// to be wide enough that the two lanes of a ring clear each other, and narrow
// enough that the outer lane of one ring clears the inner lane of the next. At 56
// the lanes were 27px apart on screen with a contact 22px across.
export const BALLOON_LANE_STEP = 65;     // graph units between the lanes of one ring
export const BALLOON_SEG_PAD = 0.16;     // clear sky between two relationship groups
export const BALLOON_RING_MAX = 1.8;     // furthest a crowded wedge may push a ring past its seating radius
export const BALLOON_EVEN = 0.45;        // how much wedge width is shared equally vs by size

/**
 * @param {{id: string, size?: number}[]} allNodes
 * @param {{source: string, target: string}[]} allEdges
 * @param {string | null} rootId  centre of the view; falls back to the
 *   highest-degree node (ties break to the smallest id) so Mesh-less callers
 *   still get a stable root.
 * @param {{pairs?: [string, string][], rankOf?: (id: string) => number,
 *          tieRank?: (a: string, b: string) => number, coupleGap?: number}} [opts]
 *   `pairs` are couples to keep side by side: each is laid out as one node and
 *   split along its ring afterwards, so the bond never stretches between two
 *   branches. `rankOf` orders the root's branches (the app ranks by tie type), so
 *   family, work and friends each own an arc of the circle. `tieRank` ranks the
 *   tie BETWEEN two contacts, which groups every other parent's people the same
 *   way: a person's family sits together, their colleagues sit together.
 * @returns {Record<string, {x: number, y: number}>}
 */
export function balloonLayout(allNodes, allEdges, rootId, opts = {}) {
  const pairs = opts.pairs ?? [];
  const rankOf = opts.rankOf ?? (() => 0);
  const tieRank = opts.tieRank ?? null;
  /** @type {Record<string, {x: number, y: number}>} */
  const out = {};
  if (!allNodes.length) return out;
  const { nodes, edges, units, unitOf } = contractCouples(allNodes, allEdges, pairs, opts.coupleGap);
  // The root's unit is the root: centring on one half of a couple centres both.
  if (rootId != null) rootId = unitOf.get(String(rootId))?.id ?? rootId;
  const sizeOf = new Map(nodes.map((n) => [n.id, n.size ?? 8]));
  const adj = new Map(nodes.map((n) => [n.id, new Set()]));
  for (const e of edges) {
    if (e.source !== e.target && adj.has(e.source) && adj.has(e.target)) {
      adj.get(e.source).add(e.target);
      adj.get(e.target).add(e.source);
    }
  }
  let root = rootId != null && adj.has(String(rootId)) ? String(rootId) : null;
  if (root == null) {
    for (const n of nodes) {
      if (root == null || adj.get(n.id).size > adj.get(root).size ||
        (adj.get(n.id).size === adj.get(root).size && n.id < root)) root = n.id;
    }
  }

  // BFS tree. Children sort by id so the layout never reshuffles between runs;
  // the ROOT's children sort by rank first, which is what gives the view its
  // relationship arcs. Ranking stops at the root: below it a branch keeps its own
  // shape, so a family is never torn apart by how its members know you.
  const sideOf = partnerSides(units, allEdges, unitOf);
  // How closely two UNITS are tied, taken from the closest tie their members
  // share. Couples hide the original endpoints, so this is worked out once here
  // rather than asked of the caller per pair.
  const between = new Map();
  if (tieRank) {
    for (const e of allEdges) {
      const a = unitOf.get(String(e.source))?.id, b = unitOf.get(String(e.target))?.id;
      if (a == null || b == null || a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const r = tieRank(String(e.source), String(e.target));
      if (r != null) between.set(key, Math.min(between.get(key) ?? r, r));
    }
  }
  const tieBetween = (a, b) => between.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0;

  const children = new Map();
  const parentOf = new Map();
  const depthOf = new Map([[root, 0]]);
  const queue = [root];
  while (queue.length) {
    const u = queue.shift();
    let kids = [...adj.get(u)].filter((v) => !depthOf.has(v)).sort();
    // Same kind of tie, same part of the wedge: a contact's family sits together
    // and their colleagues sit together, so a run of one colour reads as one
    // thing rather than as a scatter.
    if (tieRank) kids.sort((a, b) => tieBetween(u, a) - tieBetween(u, b) || (a < b ? -1 : 1));
    // A couple is drawn as two people side by side, so its children are grouped
    // by WHICH partner they belong to FIRST. Interleaved, half of them reach
    // across to the far partner and every one of those lines crosses a sibling's.
    const side = sideOf.get(u);
    if (side) kids = kids.map((k, i) => [k, i]).sort((x, y) =>
      (side.get(x[0]) ?? 0) - (side.get(y[0]) ?? 0) || x[1] - y[1]).map(([k]) => k);
    if (u === root) {
      kids.sort((a, b) =>
        (side ? (side.get(a) ?? 0) - (side.get(b) ?? 0) : 0) ||
        rankOf(a) - rankOf(b) || (a < b ? -1 : 1));
    }
    children.set(u, kids);
    for (const v of kids) { depthOf.set(v, depthOf.get(u) + 1); parentOf.set(v, u); queue.push(v); }
  }

  // Subtree weight = its leaf count: wedges are shared out by how much rim a
  // branch ultimately needs, which is what makes the view read as fractal.
  const weight = new Map();
  const weigh = (u) => {
    const kids = children.get(u) ?? [];
    if (!kids.length) { weight.set(u, 1); return 1; }
    let w = 0;
    for (const k of kids) w += weigh(k);
    weight.set(u, w);
    return w;
  };
  weigh(root);

  const byDepth = new Map();
  for (const [id, d] of depthOf) {
    if (d === 0) continue;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(id);
  }
  const width = (id) => 2 * (sizeOf.get(id) ?? 8) * BALLOON_NODE_PAD;
  // Couples share the lane like everybody else. They are split ACROSS the ring,
  // so a partner reaches half the couple's width sideways - the lane step is set
  // wide enough that the seat on the other lane still clears it. Giving a couple
  // a whole lane instead was safe but expensive: it put ring 1 three times
  // further out than the contacts standing on it actually need.


  // Ring radii: a ring clears the one inside it AND is long enough to seat
  // everybody standing on it. A ring is a LANE, two seats deep, so it holds twice
  // the circumference and sits half as far out as a one-contact-thick rope would
  // - which is what keeps the whole drawing compact enough to read.
  const radius = new Map([[0, 0]]);
  const maxDepth = Math.max(0, ...byDepth.keys());
  for (let d = 1; d <= maxDepth; d++) {
    let seats = 0;
    for (const id of byDepth.get(d) ?? []) seats += width(id);
    radius.set(d, Math.max(radius.get(d - 1) + BALLOON_RING_GAP, seats / (2 * Math.PI * BALLOON_LANES)));
  }
  // What each ring costs before any wedge asks for more. Growth is measured
  // against THIS: letting a crowded wedge multiply a ring pass after pass, and
  // every ring outside it too, is what turned a 97-contact network into a
  // 1300-unit sprawl of long spokes and empty space.
  const seated = new Map(radius);

  // Wedges: the root owns the full circle; a child is guaranteed the angle its
  // own body needs at its ring, and what is left over is shared by subtree
  // weight - so a lone contact beside a twenty-person family keeps a readable
  // slice while the branch still gets the room that makes the view fractal.
  const span = new Map();
  const angle = new Map();
  const byDepthDesc = [...depthOf.keys()].sort((a, b) => depthOf.get(b) - depthOf.get(a));
  /** The arc a branch must reserve: its own body, or whatever its descendants
   *  need at their rings - whichever is larger. Reserving for the subtree is what
   *  stops a long chain being handed a sliver that no ring is far enough out to
   *  seat, which is the case that used to run the outer rings away. */
  const reserve = () => {
    const need = new Map();
    for (const u of byDepthDesc) {
      const d = depthOf.get(u);
      let sub = 0;
      for (const k of children.get(u) ?? []) sub += need.get(k);
      need.set(u, Math.max(d === 0 ? 0 : width(u) / (BALLOON_LANES * radius.get(d)), sub));
    }
    return need;
  };
  /** One wedge pass. Returns each ring's worst overflow: how much wider it has
   *  to be before the tightest branch standing on it can seat its subtree. */
  const assign = () => {
    const need = reserve();
    span.clear(); angle.clear();
    span.set(root, [0, 2 * Math.PI]);
    angle.set(root, 0);
    /** @type {Map<number, number>} */
    const over = new Map();
    const stack = [root];
    while (stack.length) {
      const u = stack.pop();
      const kids = children.get(u) ?? [];
      if (!kids.length) continue;
      const [a0, a1] = span.get(u);
      const ring = depthOf.get(u) + 1;
      // Only the root's children are grouped: clear sky between tie types, and
      // each group's share is blended toward an equal cut so one large family
      // cannot own the circle and squash work and friends into slivers.
      const grouped = u === root;
      const breaks = grouped ? kids.filter((k, i) => i > 0 && rankOf(k) !== rankOf(kids[i - 1])).length : 0;
      const kerf = Math.min(breaks * BALLOON_SEG_PAD, (a1 - a0) * 0.25);
      const total = a1 - a0 - kerf;
      const body = kids.map((k) => Math.min(need.get(k), total));
      const packed = body.reduce((s, b) => s + b, 0);
      const crowd = packed / total;
      if (crowd > (over.get(ring) ?? 1)) over.set(ring, crowd);
      const fit = crowd > 1 ? 1 / crowd : 1; // this pass squeezes; the next widens the ring
      const free = total - packed * fit;
      const mass = kids.reduce((s, k) => s + weight.get(k), 0) || 1;
      const even = grouped ? BALLOON_EVEN : 0;
      let acc = a0;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (grouped && i > 0 && rankOf(k) !== rankOf(kids[i - 1])) acc += kerf / Math.max(breaks, 1);
        const share = even / kids.length + (1 - even) * (weight.get(k) / mass);
        const w = body[i] * fit + free * share;
        span.set(k, [acc, acc + w]);
        angle.set(k, acc + w / 2);
        acc += w;
        stack.push(k);
      }
    }
    return over;
  };
  // Widening a ring shrinks every footprint standing on it, so growing by the
  // overflow and re-sharing converges in a pass or two. A crowded wedge grows its
  // own ring and everything outside it (that is where its demand comes from) but
  // never the rings inside: inflating those would hollow the middle of the view
  // for the sake of one busy branch far out.
  for (let pass = 0; pass < 4; pass++) {
    const over = assign();
    let worst = 1;
    for (const [d, factor] of over) {
      if (factor > worst) worst = factor;
      if (factor <= 1.01) continue;
      const grow = Math.min(factor, 1.6);
      for (let k = d; k <= maxDepth; k++) {
        radius.set(k, Math.min(radius.get(k) * grow, seated.get(k) * BALLOON_RING_MAX));
      }
    }
    for (let d = 1; d <= maxDepth; d++) {
      radius.set(d, Math.max(radius.get(d), radius.get(d - 1) + BALLOON_RING_GAP));
    }
    if (worst <= 1.01) break;
  }

  // Lanes. Neighbours around a ring take turns on its inner and outer lane, so
  // the pitch doubles without the ring moving out and labels get room. An only
  // child takes the inner lane whatever its turn: on a thin branch that is the
  // difference between a short line and one long lonely spoke to the next ring.
  const lane = new Map();
  for (const [d, ids] of byDepth) {
    const seated = [...ids].sort((a, b) => angle.get(a) - angle.get(b));
    seated.forEach((id, i) => {
      const only = (children.get(parentOf.get(id)) ?? []).length === 1;
      lane.set(id, only ? 0 : i % BALLOON_LANES);
    });
    void d;
  }

  const seatRadius = (id) => {
    const d = depthOf.get(id);
    return radius.get(d) + (lane.get(id) ?? 0) * BALLOON_LANE_STEP - (d ? BALLOON_LANE_STEP / 2 : 0);
  };
  const seatAngle = new Map(angle);
  const put = (id) => {
    const r = seatRadius(id), a = seatAngle.get(id);
    out[id] = { x: r * Math.cos(a), y: r * Math.sin(a) };
  };
  for (const id of depthOf.keys()) put(id);

  // A contact can come to rest ON a line it has nothing to do with: the wedges
  // and rings are laid out from the tree, and nothing in that says a spoke
  // running out to a branch may not pass exactly where an inner seat sits. Slide
  // such a seat along its OWN ring until it is clear, never further than the free
  // space to its neighbours there - so the ring, the lane and the wedge order all
  // survive, and a contact only ever moves a few degrees.
  {
    const near = (id) => {
      let worst = Infinity;
      const p = out[id];
      for (const e of edges) {
        const a = e.source, b = e.target;
        if (a === id || b === id || !out[a] || !out[b]) continue;
        const ax = out[a].x, ay = out[a].y;
        const vx = out[b].x - ax, vy = out[b].y - ay;
        const len = vx * vx + vy * vy;
        let t = len ? ((p.x - ax) * vx + (p.y - ay) * vy) / len : 0;
        t = Math.max(0, Math.min(1, t));
        worst = Math.min(worst, Math.hypot(p.x - (ax + t * vx), p.y - (ay + t * vy)));
      }
      return worst;
    };
    for (const [d, ids] of byDepth) {
      if (!d) continue;
      const ring = [...ids].sort((x, y) => seatAngle.get(x) - seatAngle.get(y));
      ring.forEach((id, i) => {
        const clear = width(id) / 2 + BALLOON_LANE_STEP / 8;
        if (near(id) >= clear) return;
        // Half the way to each neighbour on this ring, and no more.
        const prev = ring[(i - 1 + ring.length) % ring.length], next = ring[(i + 1) % ring.length];
        const back = ring.length < 2 ? 0.3 : Math.abs(wrapTurn(seatAngle.get(id) - seatAngle.get(prev))) / 2;
        const fwd = ring.length < 2 ? 0.3 : Math.abs(wrapTurn(seatAngle.get(next) - seatAngle.get(id))) / 2;
        const home = seatAngle.get(id);
        let best = { at: home, clearance: near(id) };
        for (let step = 1; step <= 4; step++) {
          for (const room of [fwd * (step / 4), -back * (step / 4)]) {
            seatAngle.set(id, home + room);
            put(id);
            const got = near(id);
            if (got > best.clearance) best = { at: home + room, clearance: got };
            if (got >= clear) break;
          }
          if (best.clearance >= clear) break;
        }
        seatAngle.set(id, best.at);
        put(id);
      });
    }
  }

  // Anything unreachable from the root sits on one outermost ring, evenly
  // spaced, so isolated contacts stay visible without pretending a lineage.
  const stranded = nodes.map((n) => n.id).filter((id) => !depthOf.has(id)).sort();
  if (stranded.length) {
    const r = (radius.get(maxDepth) ?? 0) + 2 * BALLOON_RING_GAP;
    stranded.forEach((id, i) => {
      const a = (2 * Math.PI * i) / stranded.length + 0.2;
      out[id] = { x: r * Math.cos(a), y: r * Math.sin(a) };
    });
  }
  // Split each couple along its own ring: partners share a depth and sit next to
  // each other, which is what the wedge was sized for.
  const split = expandCouples(out, units, { x: 0, y: 0 }, sideOf);

  // A pair is split after the easing above, so a partner can still come to rest
  // on a line - the owner's own partner did, sitting 13px inside a spoke. Turn
  // the PAIR about its middle until both are clear, rigidly and by a few degrees
  // at most, so they stay adjacent, keep their heart, and stay on their ring.
  for (const u of units) {
    if (u.members.length !== 2) continue;
    const [m0, m1] = u.members;
    const mid = out[u.id];
    if (!mid || !split[m0] || !split[m1]) continue;
    const clearOf = (p, self) => {
      let worst = Infinity;
      for (const e of allEdges) {
        const a = String(e.source), b = String(e.target);
        // Only this partner's OWN lines are excused. The pair sits shoulder to
        // shoulder, so the one thing most likely to be drawn over a partner is a
        // line leaving the OTHER partner - which is exactly what happened to the
        // owner's.
        if (a === self || b === self) continue;
        const pa = split[a], pb = split[b];
        if (!pa || !pb) continue;
        const vx = pb.x - pa.x, vy = pb.y - pa.y;
        const len = vx * vx + vy * vy;
        let t = len ? ((p.x - pa.x) * vx + (p.y - pa.y) * vy) / len : 0;
        t = Math.max(0, Math.min(1, t));
        worst = Math.min(worst, Math.hypot(p.x - (pa.x + t * vx), p.y - (pa.y + t * vy)));
      }
      return worst;
    };
    const turn = (by) => {
      const c = Math.cos(by), sn = Math.sin(by);
      return [m0, m1].map((m) => {
        const dx = split[m].x - mid.x, dy = split[m].y - mid.y;
        return { x: mid.x + dx * c - dy * sn, y: mid.y + dx * sn + dy * c };
      });
    };
    const need = Math.max(width(u.id) / 6, BALLOON_LANE_STEP / 6);
    const scoreOf = (ps) => Math.min(clearOf(ps[0], m0), clearOf(ps[1], m1));
    let best = { by: 0, score: scoreOf([split[m0], split[m1]]) };
    if (best.score >= need) continue;
    for (const by of [0.15, -0.15, 0.3, -0.3, 0.45, -0.45]) {
      const score = scoreOf(turn(by));
      if (score > best.score) best = { by, score };
      if (best.score >= need) break;
    }
    if (best.by) {
      const [p0, p1] = turn(best.by);
      split[m0] = p0; split[m1] = p1;
    }
  }
  return split;
}

