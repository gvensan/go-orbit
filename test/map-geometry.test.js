const test = require("node:test");
const assert = require("node:assert/strict");
const { feature } = require("topojson-client");
const worldTopo = require("world-atlas/countries-50m.json");

test("offline map rings do not draw antimeridian segments across the world", async () => {
  const { unwrapRing } = await import("../src/renderer/map-geometry.mjs");
  const world = feature(worldTopo, worldTopo.objects.countries);
  let originalJumps = 0;
  for (const country of world.features) {
    const geometry = country.geometry;
    const polygons = geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        const unwrapped = unwrapRing(ring);
        for (let i = 1; i < ring.length; i++) {
          if (Math.abs(ring[i][0] - ring[i - 1][0]) > 180) originalJumps++;
          assert.ok(Math.abs(unwrapped[i][0] - unwrapped[i - 1][0]) <= 180,
            `${country.id} still crosses the rendered world`);
        }
      }
    }
  }
  assert.equal(originalJumps, 8, "fixture should exercise the known antimeridian geometry");
});
