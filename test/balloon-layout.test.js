// Balloon (radial-tree) ego layout: deterministic wedge math, monotonic rings,
// stranded nodes on the outermost ring.

const test = require("node:test");
const assert = require("node:assert/strict");

const geometry = () => import("../src/renderer/graph-geometry.mjs");

const N = (id, size = 8) => ({ id, size });
const E = (source, target) => ({ source, target });

test("balloon: root at origin, rings grow with depth, output is deterministic", async () => {
  const { balloonLayout } = await geometry();
  const nodes = ["you", "a", "b", "a1", "a2", "b1"].map((id) => N(id));
  const edges = [E("you", "a"), E("you", "b"), E("a", "a1"), E("a", "a2"), E("b", "b1")];
  const p = balloonLayout(nodes, edges, "you");
  assert.deepEqual(p.you, { x: 0, y: 0 });
  const r = (id) => Math.hypot(p[id].x, p[id].y);
  for (const id of ["a", "b"]) assert.ok(r(id) > 0, "depth 1 off the origin");
  for (const id of ["a1", "a2", "b1"]) assert.ok(r(id) > r("a") - 1e-9, "depth 2 beyond depth 1");
  for (const id of Object.keys(p)) {
    assert.ok(Number.isFinite(p[id].x) && Number.isFinite(p[id].y), `${id} finite`);
  }
  assert.deepEqual(balloonLayout(nodes, edges, "you"), p, "same input, same layout");
  // No two nodes share a spot.
  const seen = new Set(Object.values(p).map((q) => `${q.x.toFixed(4)},${q.y.toFixed(4)}`));
  assert.equal(seen.size, nodes.length);
});

test("balloon: children stay inside their parent's wedge", async () => {
  const { balloonLayout } = await geometry();
  // Two branches: a heavy one (3 leaves) and a light one (1 leaf).
  const nodes = ["you", "a", "b", "a1", "a2", "a3", "b1"].map((id) => N(id));
  const edges = [E("you", "a"), E("you", "b"), E("a", "a1"), E("a", "a2"), E("a", "a3"), E("b", "b1")];
  const p = balloonLayout(nodes, edges, "you");
  const ang = (id) => (Math.atan2(p[id].y, p[id].x) + 2 * Math.PI) % (2 * Math.PI);
  // Children sorted by id, wedges by leaf weight: a (3 leaves) owns [0, 1.5π),
  // b (1 leaf) owns [1.5π, 2π). Children must stay inside their parent's wedge.
  const HALF3 = 1.5 * Math.PI;
  for (const kid of ["a1", "a2", "a3"]) {
    assert.ok(ang(kid) > 0 && ang(kid) < HALF3, `${kid} inside a's wedge (${ang(kid).toFixed(2)})`);
  }
  assert.ok(ang("b1") > HALF3 && ang("b1") < 2 * Math.PI, `b1 inside b's wedge (${ang("b1").toFixed(2)})`);
  // The heavier branch got the wider wedge.
  assert.ok(ang("a") < ang("b"), "sorted order kept");
});

test("balloon: stranded contacts land on one outermost ring", async () => {
  const { balloonLayout } = await geometry();
  const nodes = ["you", "a", "island1", "island2"].map((id) => N(id));
  const edges = [E("you", "a"), E("island1", "island2")]; // pair unreachable from you
  const p = balloonLayout(nodes, edges, "you");
  const r = (id) => Math.hypot(p[id].x, p[id].y);
  assert.ok(r("island1") > r("a") && r("island2") > r("a"), "islands beyond the tree");
  assert.ok(Math.abs(r("island1") - r("island2")) < 1e-9, "one shared outer ring");
});

test("balloon: no root given falls back to the biggest hub", async () => {
  const { balloonLayout } = await geometry();
  const nodes = ["hub", "x", "y", "z"].map((id) => N(id));
  const edges = [E("hub", "x"), E("hub", "y"), E("hub", "z")];
  const p = balloonLayout(nodes, edges, null);
  assert.deepEqual(p.hub, { x: 0, y: 0 });
});

test("balloon: a crowded ring is widened until every node has room", async () => {
  const { balloonLayout, BALLOON_NODE_PAD, BALLOON_LANES } = await geometry();
  // A hub with 40 one-off contacts: the ring must seat all of them.
  const ids = ["you", ...Array.from({ length: 40 }, (_, i) => `c${String(i).padStart(2, "0")}`)];
  const nodes = ids.map((id) => N(id));
  const edges = ids.slice(1).map((id) => E("you", id));
  const p = balloonLayout(nodes, edges, "you");
  const ring = ids.slice(1).map((id) => p[id]).sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
  let tightest = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const q = ring[(i + 1) % ring.length];
    tightest = Math.min(tightest, Math.hypot(ring[i].x - q.x, ring[i].y - q.y));
  }
  assert.ok(tightest > 2 * 8, `neighbours clear each other's rims (${tightest.toFixed(1)})`);
  // The old fixed cap (base + 3 ring gaps) sat these 40 on top of each other.
  // The ring is a lane BALLOON_LANES seats deep, so it needs that fraction of the
  // circumference a single-file ring would have. Seats straddle the lane, so the
  // ring itself is their mean radius.
  const need = (40 * 2 * 8 * BALLOON_NODE_PAD) / (2 * Math.PI * BALLOON_LANES);
  const radii = ids.slice(1).map((id) => Math.hypot(p[id].x, p[id].y));
  const lane = radii.reduce((s, r) => s + r, 0) / radii.length;
  assert.ok(lane >= need, `ring circumference seats the whole fan (${lane.toFixed(1)} vs ${need.toFixed(1)})`);
  assert.equal(new Set(radii.map((r) => r.toFixed(3))).size, BALLOON_LANES, "seats straddle the lane");
});

test("balloon: a lone contact beside a big family keeps a readable slice", async () => {
  const { balloonLayout } = await geometry();
  // "solo" competes with a branch carrying 24 leaves for the root's circle.
  const family = Array.from({ length: 24 }, (_, i) => `f${String(i).padStart(2, "0")}`);
  const nodes = ["you", "clan", "solo", ...family].map((id) => N(id));
  const edges = [E("you", "clan"), E("you", "solo"), ...family.map((f) => E("clan", f))];
  const p = balloonLayout(nodes, edges, "you");
  const r = Math.hypot(p.solo.x, p.solo.y);
  const gap = Math.min(
    ...family.map((f) => Math.hypot(p[f].x - p.solo.x, p[f].y - p.solo.y)),
    Math.hypot(p.clan.x - p.solo.x, p.clan.y - p.solo.y),
  );
  assert.ok(r > 0 && gap > 2 * 8, `solo is not squeezed onto a neighbour (${gap.toFixed(1)})`);
});

test("balloon: relationship ranks group the root's branches into arcs", async () => {
  const { balloonLayout } = await geometry();
  // Three ties of each type, interleaved by id so only the rank can group them.
  const kinds = ["family", "work", "friend"];
  const ids = [];
  for (let i = 0; i < 9; i++) ids.push(`t${i}`);
  const rank = (id) => Number(id.slice(1)) % 3;   // t0 family, t1 work, t2 friend, t3 family...
  const nodes = ["you", ...ids].map((id) => N(id));
  const edges = ids.map((id) => E("you", id));
  const p = balloonLayout(nodes, edges, "you", { rankOf: rank });
  const ang = (id) => (Math.atan2(p[id].y, p[id].x) + 2 * Math.PI) % (2 * Math.PI);
  const byRank = kinds.map((_, r) => ids.filter((id) => rank(id) === r).map(ang).sort((a, b) => a - b));
  // Each group occupies a contiguous arc: no member of another group falls inside.
  byRank.forEach((group, r) => {
    const lo = group[0], hi = group[group.length - 1];
    for (const [other, list] of byRank.entries()) {
      if (other === r) continue;
      for (const a of list) {
        assert.ok(a < lo - 1e-9 || a > hi + 1e-9, `rank ${other} stays out of rank ${r}'s arc`);
      }
    }
  });
  assert.deepEqual(balloonLayout(nodes, edges, "you", { rankOf: rank }), p, "deterministic");
});

test("balloon: an only child stays in the inner lane, close to its parent", async () => {
  const { balloonLayout, BALLOON_LANE_STEP } = await geometry();
  // One busy branch (so ring 2 is crowded) and one thin chain.
  const many = Array.from({ length: 8 }, (_, i) => `m${i}`);
  const nodes = ["you", "busy", "thin", "lone", ...many].map((id) => N(id));
  const edges = [E("you", "busy"), E("you", "thin"), E("thin", "lone"), ...many.map((m) => E("busy", m))];
  const p = balloonLayout(nodes, edges, "you");
  const r = (id) => Math.hypot(p[id].x, p[id].y);
  assert.ok(r("lone") < r(many[0]) || r("lone") <= r(many[1]),
    "the only child takes the inner lane of its ring");
  const reach = Math.hypot(p.lone.x - p.thin.x, p.lone.y - p.thin.y);
  const outer = Math.max(...many.map((m) => Math.hypot(p[m].x - p.busy.x, p[m].y - p.busy.y)));
  assert.ok(reach <= outer + BALLOON_LANE_STEP, "its line is no longer than a crowded branch's");
});

// --- couple bonds ----------------------------------------------------------

test("couples: the gap always leaves room for the heart", async () => {
  const { coupleUnits, expandCouples, pairHeartSpots, PAIR_HEART_MIN, COUPLE_GAP } = await geometry();
  // Painted radii, as the layouts now receive them (body + the gender ring).
  for (const [sa, sb] of [[8, 8], [12.5, 12.5], [29, 12.5], [8, 20]]) {
    const nodes = [{ id: "a", size: sa }, { id: "b", size: sb }];
    const { units } = coupleUnits(nodes, [["a", "b"]]);
    const p = expandCouples({ [units[0].id]: { x: 0, y: 0 } }, units, { x: -100, y: 0 });
    const spot = pairHeartSpots(p.a, p.b, sa, sb, 5);
    assert.ok(spot, `a ${sa}/${sb} couple has room for a heart`);
    assert.ok(spot.s >= PAIR_HEART_MIN, `the heart is legible (${spot.s.toFixed(1)})`);
  }
  assert.ok(COUPLE_GAP > 17, `the gap is derived from the heart, not hand-set (${COUPLE_GAP.toFixed(1)})`);
});

test("couples: one partner each, singles keep their own unit", async () => {
  const { coupleUnits, COUPLE_GAP, COUPLE_SPREAD } = await geometry();
  const nodes = ["a", "b", "c", "solo"].map((id) => N(id));
  // b is offered two partners (a remarriage / co-parent chain): only one sticks.
  const { units, unitOf } = coupleUnits(nodes, [["a", "b"], ["b", "c"], ["b", "gone"]]);
  assert.equal(unitOf.get("a"), unitOf.get("b"), "a and b share a unit");
  assert.notEqual(unitOf.get("c"), unitOf.get("b"), "c is not folded in as a third");
  assert.deepEqual(unitOf.get("a").members, ["a", "b"], "caller's order kept");
  // The gap is the heart's minimum or a share of the partners' own size,
  // whichever is wider - so a pair stays in proportion when the view is framed.
  assert.equal(unitOf.get("a").sep, 8 + 8 + Math.max(COUPLE_GAP, COUPLE_SPREAD * 16),
    "rims clear by the couple gap");
  assert.equal(units.length, 3, "one pair unit plus c and solo");
  assert.ok(units.every((u) => nodes.some((n) => n.id === u.id)), "unit ids are real node ids");
});

test("couples: contraction rewires ties onto the unit and drops the bond", async () => {
  const { contractCouples } = await geometry();
  const nodes = [N("you"), N("dad"), N("mum"), N("kid")];
  const edges = [E("dad", "mum"), E("you", "dad"), E("you", "mum"), E("dad", "kid")];
  const { nodes: un, edges: ue } = contractCouples(nodes, edges, [["dad", "mum"]]);
  assert.equal(un.length, 3, "dad+mum simulate as one node");
  assert.ok(!ue.some((e) => e.source === e.target), "the bond became internal");
  assert.equal(ue.filter((e) => e.source === "you" || e.target === "you").length, 2,
    "both ties to the couple survive, so attraction is not lost");
  assert.equal(un.find((n) => n.id === "dad").size > 8, true, "the unit reserves room for both");
});

test("couples: partners split across the line to the centre, not along it", async () => {
  const { expandCouples, coupleUnits } = await geometry();
  const nodes = [N("a"), N("b")];
  const { units } = coupleUnits(nodes, [["a", "b"]]);
  const u = units[0];
  const p = expandCouples({ [u.id]: { x: 100, y: 0 } }, units, { x: 0, y: 0 });
  assert.ok(Math.abs(Math.hypot(p.a.x, p.a.y) - Math.hypot(p.b.x, p.b.y)) < 1e-9,
    "both partners sit the same distance from the centre");
  assert.ok(Math.abs(Math.hypot(p.a.x - p.b.x, p.a.y - p.b.y) - u.sep) < 1e-9, "separated by the gap");
  assert.ok(Math.abs(p.a.x - 100) < 1e-9 && Math.abs(p.b.x - 100) < 1e-9, "split is perpendicular");
  const flat = expandCouples({ [u.id]: { x: 0, y: 0 } }, units, { x: 0, y: 0 });
  assert.ok(Math.abs(flat.a.y) < 1e-9 && Math.abs(flat.b.y) < 1e-9, "a centred couple lies flat");
  assert.ok(flat.a.x < flat.b.x, "first member takes the left side");
});

test("balloon: a couple lands side by side instead of in two branches", async () => {
  const { balloonLayout, coupleUnits } = await geometry();
  // dad and mum each carry their own subtree, so nothing but the pairing keeps
  // them together: unpaired, the tree splits them into opposite wedges.
  const ids = ["you", "dad", "mum", "d1", "d2", "m1", "m2"];
  const nodes = ids.map((id) => N(id));
  const edges = [E("you", "dad"), E("you", "mum"), E("dad", "d1"), E("dad", "d2"),
    E("mum", "m1"), E("mum", "m2")];
  const dist = (p) => Math.hypot(p.dad.x - p.mum.x, p.dad.y - p.mum.y);
  const loose = balloonLayout(nodes, edges, "you");
  const paired = balloonLayout(nodes, edges, "you", { pairs: [["dad", "mum"]] });
  const { units } = coupleUnits(nodes, [["dad", "mum"]]);
  assert.ok(Math.abs(dist(paired) - units[0].sep) < 1e-9, "partners end one gap apart");
  assert.ok(dist(paired) < dist(loose), "closer than the unpaired layout");
  assert.ok(ids.every((id) => Number.isFinite(paired[id]?.x) && Number.isFinite(paired[id]?.y)),
    "nobody is lost by the contraction");
  const r = (id) => Math.hypot(paired[id].x, paired[id].y);
  assert.ok(Math.abs(r("dad") - r("mum")) < 1e-9, "the couple shares a ring");
  for (const kid of ["d1", "d2", "m1", "m2"]) assert.ok(r(kid) > r("dad"), `${kid} sits beyond its parents`);
  assert.deepEqual(balloonLayout(nodes, edges, "you", { pairs: [["dad", "mum"]] }), paired, "still deterministic");
});
