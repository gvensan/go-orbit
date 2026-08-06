// GRAPH_CANVAS_REQUIREMENTS: overlay decorations never paint over a node.
const test = require("node:test");
const assert = require("node:assert/strict");

const geometry = () => import("../src/renderer/graph-geometry.mjs");

test("a couple heart never overlaps either partner, even a huge 'you' node", async () => {
  const { pairHeartSpots } = await geometry();
  const you = { x: 1000, y: 600 }, partner = { x: 1090, y: 600 };
  const youHalo = 37, partnerHalo = 12; // owner halo (sparkles) vs an ordinary ring
  const spot = pairHeartSpots(you, partner, youHalo, partnerHalo, 4.8);
  assert.ok(spot, "there is room for a heart between the two");
  for (const p of spot.points) {
    assert.ok(Math.hypot(p.x - you.x, p.y - you.y) >= youHalo + spot.half - 1e-9,
      "heart clears the owner's halo");
    assert.ok(Math.hypot(p.x - partner.x, p.y - partner.y) >= partnerHalo + spot.half - 1e-9,
      "heart clears the partner");
  }
});

test("no heart at all when the partners are too close to hold one", async () => {
  const { pairHeartSpots } = await geometry();
  assert.equal(pairHeartSpots({ x: 0, y: 0 }, { x: 30, y: 0 }, 14, 14, 6), null);
  assert.equal(pairHeartSpots({ x: 0, y: 0 }, { x: 0, y: 0 }, 8, 8, 6), null); // stacked nodes
});

test("the heart shrinks to fit a tight gap instead of spilling onto a node", async () => {
  const { pairHeartSpots, PAIR_HEART_MIN } = await geometry();
  const spot = pairHeartSpots({ x: 0, y: 0 }, { x: 60, y: 0 }, 20, 20, 12);
  assert.ok(spot, "a narrow gap still gets a heart");
  assert.ok(spot.s < 12 && spot.s >= PAIR_HEART_MIN, "requested size was reduced, not ignored");
  assert.ok(spot.points.every((p) => p.x - spot.half >= 20 - 1e-9 && p.x + spot.half <= 40 + 1e-9),
    "every candidate stays inside the free gap");
});

test("the node index finds any node under a point, whatever the cell layout", async () => {
  const { nodeHitIndex } = await geometry();
  const spots = [
    { x: 10, y: 10, r: 6 },
    { x: 400, y: 320, r: 120 },   // one very large node spanning several cells
    { x: -250, y: -90, r: 9 },    // negative coordinates (panned canvas)
  ];
  const occupied = nodeHitIndex(spots);
  // Brute force is the oracle: the index must agree with it everywhere.
  const hits = (x, y, rad) => spots.some((s) => Math.hypot(s.x - x, s.y - y) < s.r + rad);
  for (let x = -400; x <= 600; x += 7) {
    for (let y = -200; y <= 500; y += 11) {
      assert.equal(occupied(x, y, 8), hits(x, y, 8), `disagreement at ${x},${y}`);
    }
  }
  assert.equal(nodeHitIndex([])(0, 0, 5), false, "an empty canvas occupies nothing");
});
