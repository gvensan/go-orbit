// geocode.js - opt-in online address/place search via OpenStreetMap Photon. This is the
// ONLY outbound network call in the app, and it runs in the main process (never
// the renderer, whose CSP stays connect-src 'none'). It fires only when the user
// has turned on "Online location search"; the caller (registry) gates on that.

const config = require("./config");

/**
 * Search addresses/places by free text; returns de-duplicated, structured
 * results with coordinates so the caller can preserve both the user's text and
 * the resolved location. Any failure
 * (offline, timeout, bad response) returns [] so the UI falls back to the
 * bundled list. Never throws.
 * @param {string} query
 * @returns {Promise<{label: string, lat: number, lon: number, place: string, precision: string, source: string, components: Record<string,string>, osm?: {type?: string,id?: number}}[]>}
 */
async function searchCities(query) {
  const q = String(query || "").trim();
  if (q.length < config.location.minChars) return [];
  const url = `${config.location.photonUrl}?q=${encodeURIComponent(q)}&limit=${config.location.limit}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Orbit/0.1" },
      signal: AbortSignal.timeout(config.location.timeoutMs),
    });
    if (!res.ok) return [];
    const data = /** @type {any} */ (await res.json());
    const seen = new Set();
    /** @type {Awaited<ReturnType<typeof searchCities>>} */
    const results = [];
    for (const f of data.features ?? []) {
      const p = f.properties || {};
      const coords = f.geometry && f.geometry.coordinates; // [lon, lat]
      if (!Array.isArray(coords) || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) continue;

      const addressLine = [p.housenumber, p.street].filter(Boolean).join(" ");
      const parts = [];
      const add = (value) => {
        const s = String(value || "").trim();
        if (s && !parts.some((x) => x.toLocaleLowerCase() === s.toLocaleLowerCase())) parts.push(s);
      };
      // Photon may use name for a POI, a street, or a locality. Keep it when it
      // adds information, then retain the complete international hierarchy.
      if (p.name && String(p.name).toLocaleLowerCase() !== String(p.street || "").toLocaleLowerCase()) add(p.name);
      add(addressLine);
      add(p.street && !addressLine ? p.street : "");
      add(p.district);
      add(p.city);
      add(p.county);
      add(p.state);
      add(p.postcode);
      add(p.country);
      const label = parts.join(", ");
      if (!label || seen.has(label.toLocaleLowerCase())) continue;
      seen.add(label.toLocaleLowerCase());

      let precision = "place";
      if (p.housenumber) precision = "house";
      else if (p.street) precision = "street";
      else if (p.postcode) precision = "postcode";
      else if (p.district) precision = "district";
      else if (p.city || ["city", "town", "village", "hamlet"].includes(p.osm_value)) precision = "city";
      else if (p.state) precision = "region";
      else if (p.country) precision = "country";

      const componentKeys = ["name", "housenumber", "street", "postcode", "district", "city", "county", "state", "country", "countrycode"];
      /** @type {Record<string, string>} */
      const components = {};
      for (const key of componentKeys) if (p[key] != null && p[key] !== "") components[key] = String(p[key]);
      results.push({
        label, place: label, lat: coords[1], lon: coords[0], precision,
        source: "photon", components,
        osm: { type: p.osm_type, id: Number.isFinite(Number(p.osm_id)) ? Number(p.osm_id) : undefined },
      });
    }
    return results.slice(0, config.location.limit);
  } catch {
    return [];
  }
}

module.exports = { searchCities };
