// maptiles.js - opt-in online map tiles (OpenStreetMap raster). Like geocode.js,
// the fetch happens in the MAIN process only; the renderer stays connect-src
// 'none' and receives each tile as a data: URL to draw on canvas. Tiles are
// cached on disk so panning/zooming doesn't refetch, and to be polite to OSM's
// tile servers. Gated on the same "Online location search" opt-in.

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const config = require("./config");

let cacheDir;
function dir() {
  if (!cacheDir) {
    cacheDir = path.join(app.getPath("userData"), config.map.cacheDir);
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* best effort */ }
  }
  return cacheDir;
}

/** @type {Map<string, Promise<{dataUrl: string} | null>>} concurrent asks share one fetch */
const inflight = new Map();

/**
 * Fetch one slippy-map tile (z/x/y) for the given theme as a PNG data: URL,
 * cached on disk (per theme). Returns null on any failure (offline, timeout, bad
 * tile) so the renderer falls back to its offline vector map. Never throws.
 * @param {"light" | "dark"} [theme]
 * @param {"base" | "labels"} [layer]
 * @returns {Promise<{dataUrl: string} | null>}
 */
async function fetchTile(z, x, y, theme, layer = "base") {
  z = Math.round(z); x = Math.round(x); y = Math.round(y);
  const max = (1 << z) - 1;
  if (z < 0 || z > config.map.maxZoom || x < 0 || y < 0 || x > max || y > max) return null;
  const style = theme === "light" ? "light" : (layer === "labels" ? "dark-labels" : "dark-base");

  const styleDir = path.join(dir(), style);
  try { fs.mkdirSync(styleDir, { recursive: true }); } catch { /* best effort */ }
  const file = path.join(styleDir, `${z}_${x}_${y}${config.map.tileTag || ""}.png`);
  try {
    const buf = fs.readFileSync(file);
    return { dataUrl: `data:image/png;base64,${buf.toString("base64")}` };
  } catch { /* not cached yet - fetch below */ }

  const key = `${style}/${z}/${x}/${y}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    const urlKey = style === "light" ? "light" : (style === "dark-labels" ? "darkLabels" : "darkBase");
    const url = config.map.tileUrl[urlKey]
      .replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Orbit/0.1" },
        signal: AbortSignal.timeout(config.map.timeoutMs),
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      try { fs.writeFileSync(file, buf); } catch { /* cache is best effort */ }
      return { dataUrl: `data:image/png;base64,${buf.toString("base64")}` };
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

module.exports = { fetchTile };
