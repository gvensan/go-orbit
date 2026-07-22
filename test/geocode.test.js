const test = require("node:test");
const assert = require("node:assert/strict");
const { searchCities } = require("../src/main/geocode");

test("address search retains the full hierarchy and reports house precision", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ features: [{
      geometry: { coordinates: [77.5946, 12.9716] },
      properties: {
        name: "Orbit House", housenumber: "42", street: "MG Road",
        district: "Central Bengaluru", city: "Bengaluru", state: "Karnataka",
        postcode: "560001", country: "India", countrycode: "IN",
        osm_type: "W", osm_id: 123,
      },
    }] }),
  });

  const [hit] = await searchCities("42 MG Road Bengaluru");
  assert.equal(hit.label, "Orbit House, 42 MG Road, Central Bengaluru, Bengaluru, Karnataka, 560001, India");
  assert.equal(hit.precision, "house");
  assert.equal(hit.components.housenumber, "42");
  assert.deepEqual([hit.lat, hit.lon], [12.9716, 77.5946]);
});

test("address search distinguishes same-named places by their full address", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ features: [
      { geometry: { coordinates: [1, 2] }, properties: { name: "Springfield", state: "Illinois", country: "United States", osm_value: "city" } },
      { geometry: { coordinates: [3, 4] }, properties: { name: "Springfield", state: "Massachusetts", country: "United States", osm_value: "city" } },
    ] }),
  });

  const hits = await searchCities("Springfield");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].precision, "city");
  assert.notEqual(hits[0].label, hits[1].label);
});
