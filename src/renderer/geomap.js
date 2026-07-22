// geomap.js - world map of contact locations, Web Mercator (the projection real
// slippy maps use). Two base layers over one shared pan/zoom model:
//   - online + enabled: OpenStreetMap raster tiles, fetched in the MAIN process
//     and drawn as data: URLs (renderer stays connect-src 'none').
//   - offline / opted-out: a bundled 50m vector world (no network at all).
// Dots project the same way in both, so zoom/pan/hover/click are identical.

import { feature } from "topojson-client";
import Supercluster from "supercluster";
import worldTopo from "world-atlas/countries-50m.json";
import { unwrapRing } from "./map-geometry.mjs";

// Country outlines (offline, bundled): TopoJSON -> GeoJSON once at load.
const WORLD = feature(worldTopo, worldTopo.objects.countries);

const TILE = 256;          // OSM tile size (px)
const MAX_ZOOM = 19;       // must match config.map.maxZoom
const MERC_LAT = 85.0511;  // Web Mercator latitude limit
const GENDER = { Female: "#ff2d95", Male: "#00c2ff" };
const CLUSTER_RADIUS = 50;  // screen pixels, conventional map-cluster radius
const CLUSTER_MAX_ZOOM = 17;

function theme() {
  const light = document.documentElement.dataset.theme === "light";
  return light
    ? { ocean: "#cfdcf0", land: "#eef3fb", landStroke: "#b9c6da", grid: "#c3ccdb", grid0: "#9aa8bd", text: "#64748b", dotDefault: "#8b9bb4", label: "#334155", attribution: "#5b6b86" }
    : { ocean: "#0a1120", land: "#18243a", landStroke: "#40516d", grid: "#31415c", grid0: "#526783", text: "#94a3b8", dotDefault: "#8b9bb4", label: "#c0cad9", attribution: "#8291a8" };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class GeoMap {
  /** @param {HTMLElement} container @param {{ onOpenContact?: (id:number)=>void, onPickCoordinates?: (point:{lat:number,lon:number})=>void }} handlers */
  constructor(container, handlers) {
    this.container = container;
    this.handlers = handlers;
    this.points = [];       // {id,name,lat,lon,gender,isOwner,deceased,location}
    this.placed = [];       // visible individual, location-group, and cluster markers
    this.locationGroups = new Map();
    this.clusterIndex = null;
    this.hoveredKey = null;
    this.popupKey = null;
    this.zoom = 2;                  // fractional web-mercator zoom
    this.origin = { px: 0, py: 0 }; // world-pixel coordinate at the pane's top-left
    this.dragging = null;
    this.suppressClick = false;     // pointerup clears dragging before click fires
    this.tiles = false;             // tile base layer active (online + opted-in)
    /** @type {Map<string, HTMLImageElement | "loading" | "error">} */
    this.tileCache = new Map();
    this.abort = new AbortController();
    if (handlers.onPickCoordinates) container.classList.add("geomap-pin-mode");

    container.classList.add("geomap-wrap");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "geomap-canvas";
    container.append(this.canvas);

    this.tip = document.createElement("div");
    this.tip.className = "geomap-tip";
    this.tip.hidden = true;
    container.append(this.tip);

    this.popup = document.createElement("div");
    this.popup.className = "geomap-popup";
    this.popup.hidden = true;
    container.append(this.popup);

    const ctrls = document.createElement("div");
    ctrls.className = "geomap-controls";
    const btn = (glyph, title, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = glyph; b.title = title;
      b.addEventListener("click", fn);
      ctrls.append(b);
      return b;
    };
    btn("+", "Zoom in", () => this.zoomBy(0.8));
    btn("−", "Zoom out", () => this.zoomBy(-0.8));
    btn("⤢", "Fit all", () => this.fit());
    container.append(ctrls);

    this.count = document.createElement("div");
    this.count.className = "geomap-count mono";
    container.append(this.count);

    this.wireEvents();
    this.ro = new ResizeObserver(() => { this.clampView(); this.render(); });
    this.ro.observe(container);
    this.syncMode();
    window.addEventListener("online", () => this.syncMode(), { signal: this.abort.signal });
    window.addEventListener("offline", () => this.syncMode(), { signal: this.abort.signal });
    // Re-render (theme-aware colours + light/dark tiles) when the app theme flips.
    this.themeObserver = new MutationObserver(() => { if (!this.container.hidden) this.render(); });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  wireEvents() {
    const c = this.canvas;
    const signal = this.abort.signal;
    // Wheel + trackpad pinch (ctrl+wheel): zoom is linear in the scroll delta
    // (in zoom levels), so it tracks the gesture smoothly and stays anchored.
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dz = -e.deltaY * (e.ctrlKey ? 0.03 : 0.003);
      this.zoomAt(e.offsetX, e.offsetY, dz);
    }, { passive: false, signal });
    c.addEventListener("pointerdown", (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      this.suppressClick = false;
      this.hidePopup();
      this.dragging = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      c.setPointerCapture(e.pointerId);
    }, { signal });
    c.addEventListener("pointermove", (e) => {
      if (!this.dragging || this.dragging.pointerId !== e.pointerId) {
        if (!this.dragging && e.pointerType === "mouse") this.onHover(e.offsetX, e.offsetY);
        return;
      }
      const dx = e.clientX - this.dragging.x, dy = e.clientY - this.dragging.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.dragging.moved = true;
      this.origin.px -= dx; this.origin.py -= dy;
      this.dragging.x = e.clientX; this.dragging.y = e.clientY;
      this.clampView();
      this.render();
    }, { signal });
    const endDrag = (e) => {
      if (!this.dragging || this.dragging.pointerId !== e.pointerId) return;
      if (this.dragging?.moved) this.suppressClick = true;
      this.dragging = null;
    };
    c.addEventListener("pointerup", endDrag, { signal });
    c.addEventListener("pointercancel", endDrag, { signal });
    c.addEventListener("pointerleave", () => { if (!this.dragging) { this.hoveredKey = null; this.tip.hidden = true; this.render(); } }, { signal });
    c.addEventListener("click", (e) => {
      if (this.suppressClick) { this.suppressClick = false; return; }
      if (e.detail > 1) return;
      if (this.handlers.onPickCoordinates) {
        this.handlers.onPickCoordinates(this.unproject(e.offsetX, e.offsetY));
        return;
      }
      const hit = this.hit(e.offsetX, e.offsetY);
      if (!hit) return;
      if (hit.kind === "contact") {
        this.handlers.onOpenContact?.(hit.points[0].id);
      } else if (hit.kind === "location") {
        this.showLocationPopup(hit, e.offsetX, e.offsetY);
      } else {
        const expansion = this.clusterIndex.getClusterExpansionZoom(hit.clusterId);
        this.zoomAt(hit.sx, hit.sy, Math.max(0.8, expansion - this.zoom));
      }
    }, { signal });
    c.addEventListener("dblclick", (e) => {
      e.preventDefault();
      // Marker clicks retain their contact-opening behavior; only the map
      // background uses the conventional double-click-to-zoom gesture.
      if (!this.hit(e.offsetX, e.offsetY)) this.zoomAt(e.offsetX, e.offsetY, 0.8);
    }, { signal });
  }

  /** Is the online tile layer enabled and available right now? */
  async syncMode() {
    let enabled = false;
    try { ({ enabled } = await window.api.location.online({})); } catch { /* backend not up yet */ }
    const next = !!enabled && navigator.onLine;
    if (next !== this.tiles) { this.tiles = next; if (!this.container.hidden) this.render(); }
  }

  /** @param {Array<{id:number,name:string,lat:number,lon:number,gender?:string,isOwner?:boolean,deceased?:boolean,location?:string,place?:string,locationPrecision?:string}>} points */
  setPoints(points, total) {
    this.points = points;
    this.total = total ?? points.length;
    this.buildClusterIndex();
    if (this.container.hidden) return;
    if (!this._fitted) { this.fit(); this._fitted = true; } else this.render();
  }

  /** Collapse truly identical coordinates before spatial clustering. */
  buildClusterIndex() {
    this.locationGroups = new Map();
    for (const p of this.points) {
      const key = `${p.lat},${p.lon}`;
      if (!this.locationGroups.has(key)) this.locationGroups.set(key, { key, lat: p.lat, lon: p.lon, points: [] });
      this.locationGroups.get(key).points.push(p);
    }
    /** @type {import("supercluster").PointFeature<any>[]} */
    const features = [...this.locationGroups.values()].map((g) => {
      const female = g.points.filter((p) => p.gender === "Female").length;
      const male = g.points.filter((p) => p.gender === "Male").length;
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [g.lon, g.lat] },
        properties: {
          locId: g.key,
          contactCount: g.points.length,
          locationCount: 1,
          female,
          male,
          other: g.points.length - female - male,
          ownerCount: g.points.some((p) => p.isOwner) ? 1 : 0,
        },
      };
    });
    this.clusterIndex = new Supercluster({
      radius: CLUSTER_RADIUS,
      extent: TILE, // match this canvas's 256px Web-Mercator world tiles
      maxZoom: CLUSTER_MAX_ZOOM,
      minPoints: 2,
      map: (p) => ({
        contactCount: p.contactCount, locationCount: 1,
        female: p.female, male: p.male, other: p.other, ownerCount: p.ownerCount,
      }),
      reduce: (acc, p) => {
        acc.contactCount += p.contactCount;
        acc.locationCount += p.locationCount;
        acc.female += p.female; acc.male += p.male; acc.other += p.other;
        acc.ownerCount += p.ownerCount;
      },
    }).load(features);
  }

  dims() { return { w: this.container.clientWidth, h: this.container.clientHeight }; }

  // --- Web Mercator projection (unit square 0..1, then scaled by worldSize) ---
  worldSize() { return TILE * 2 ** this.zoom; }
  xFrac(lon) { return (lon + 180) / 360; }
  yFrac(lat) {
    const s = Math.sin(clamp(lat, -MERC_LAT, MERC_LAT) * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }
  latFromYFrac(y) {
    return Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y)) * 180 / Math.PI;
  }
  project(lon, lat) {
    const ws = this.worldSize();
    return { x: this.xFrac(lon) * ws - this.origin.px, y: this.yFrac(lat) * ws - this.origin.py };
  }
  unproject(sx, sy) {
    const ws = this.worldSize();
    return {
      lon: clamp((this.origin.px + sx) / ws * 360 - 180, -180, 180),
      lat: clamp(this.latFromYFrac((this.origin.py + sy) / ws), -MERC_LAT, MERC_LAT),
    };
  }

  /** Centre an address-level map on one coordinate without changing its pin. */
  focus(lat, lon, zoom = 16) {
    const { w, h } = this.dims();
    this.zoom = clamp(zoom, this.minZoom(), MAX_ZOOM);
    const ws = this.worldSize();
    this.origin = { px: this.xFrac(lon) * ws - w / 2, py: this.yFrac(lat) * ws - h / 2 };
    this._fitted = true;
    this.clampView(); this.render();
  }

  /** Zoom floor: world just covers the pane, so the map always fills it. */
  minZoom() {
    const { w, h } = this.dims();
    if (!w || !h) return 0;
    return Math.log2(Math.max(w, h) / TILE);
  }

  /** Keep zoom within [cover, MAX] and pan so the world always covers the pane. */
  clampView() {
    const { w, h } = this.dims();
    if (!w || !h) return;
    this.zoom = clamp(this.zoom, this.minZoom(), MAX_ZOOM);
    const ws = this.worldSize();
    this.origin.px = clamp(this.origin.px, 0, Math.max(0, ws - w));
    this.origin.py = clamp(this.origin.py, 0, Math.max(0, ws - h));
  }

  fit() {
    this.hidePopup();
    this.hoveredKey = null;
    this.tip.hidden = true;
    const { w, h } = this.dims();
    if (!w || !h) return;
    const min = this.minZoom();
    const pts = this.points;
    if (pts.length) {
      let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
      for (const p of pts) {
        minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
        minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      }
      const padLon = Math.max(6, (maxLon - minLon) * 0.25), padLat = Math.max(5, (maxLat - minLat) * 0.25);
      minLon -= padLon; maxLon += padLon; minLat -= padLat; maxLat += padLat;
      const fx = Math.max(1e-4, this.xFrac(maxLon) - this.xFrac(minLon));
      const fy = Math.max(1e-4, this.yFrac(minLat) - this.yFrac(maxLat));
      const ws = Math.min(w / fx, h / fy);
      this.zoom = clamp(Math.log2(ws / TILE), min, MAX_ZOOM);
      const size = this.worldSize();
      const cx = (this.xFrac(minLon) + this.xFrac(maxLon)) / 2 * size;
      const cy = (this.yFrac(minLat) + this.yFrac(maxLat)) / 2 * size;
      this.origin = { px: cx - w / 2, py: cy - h / 2 };
    } else {
      this.zoom = min;
      const size = this.worldSize();
      this.origin = { px: (size - w) / 2, py: (size - h) / 2 };
    }
    this.clampView();
    this.render();
  }

  zoomBy(dz) { const { w, h } = this.dims(); this.zoomAt(w / 2, h / 2, dz); }
  /** Zoom by dz levels, keeping the geographic point under (sx,sy) fixed. */
  zoomAt(sx, sy, dz) {
    this.hidePopup();
    this.hoveredKey = null;
    this.tip.hidden = true;
    const z1 = clamp(this.zoom + dz, this.minZoom(), MAX_ZOOM);
    const k = 2 ** (z1 - this.zoom);
    this.origin.px = (this.origin.px + sx) * k - sx;
    this.origin.py = (this.origin.py + sy) * k - sy;
    this.zoom = z1;
    this.clampView();
    this.render();
  }

  /** Build visible markers. Nearby locations cluster by zoom; contacts with
   * exactly the same coordinates remain one location marker at every zoom. */
  layout() {
    this.placed = [];
    if (!this.clusterIndex) return;
    const { w, h } = this.dims(), ws = this.worldSize();
    const west = this.origin.px / ws * 360 - 180;
    const east = (this.origin.px + w) / ws * 360 - 180;
    const north = this.latFromYFrac(this.origin.py / ws);
    const south = this.latFromYFrac((this.origin.py + h) / ws);
    const features = this.clusterIndex.getClusters([west, south, east, north], Math.floor(this.zoom));
    for (const f of features) {
      const [lon, lat] = f.geometry.coordinates;
      const pos = this.project(lon, lat), p = /** @type {any} */ (f.properties);
      if (p.cluster) {
        const count = p.contactCount ?? p.point_count;
        this.placed.push({
          kind: "cluster", key: `cluster:${f.id}`, clusterId: f.id,
          sx: pos.x, sy: pos.y, lat, lon, count,
          locationCount: p.locationCount ?? p.point_count,
          female: p.female ?? 0, male: p.male ?? 0, other: p.other ?? 0,
          ownerCount: p.ownerCount ?? 0, radius: this.markerRadius(count),
        });
      } else {
        const group = this.locationGroups.get(p.locId);
        if (!group) continue;
        const count = group.points.length;
        const female = group.points.filter((x) => x.gender === "Female").length;
        const male = group.points.filter((x) => x.gender === "Male").length;
        this.placed.push({
          kind: count === 1 ? "contact" : "location", key: `location:${group.key}`,
          sx: pos.x, sy: pos.y, lat, lon, points: group.points, count,
          locationCount: 1, female, male, other: count - female - male,
          ownerCount: group.points.some((x) => x.isOwner) ? 1 : 0,
          radius: count === 1 ? (group.points[0].isOwner ? 6 : 4.5) : this.markerRadius(count),
        });
      }
    }
  }

  markerRadius(count) { return clamp(5 * Math.sqrt(count), 10, 28); }

  hit(px, py) {
    let best = null, bd = Infinity;
    for (const p of this.placed) {
      const dx = p.sx - px, dy = p.sy - py, d = dx * dx + dy * dy;
      const hr = Math.max(12, p.radius + 4);
      if (d <= hr * hr && d < bd) { bd = d; best = p; }
    }
    return best;
  }

  onHover(px, py) {
    const hit = this.hit(px, py);
    // A marker can have either its transient hover tip or its interactive
    // popup open, never both. Moving to a different marker replaces whichever
    // map overlay was open before it.
    if (!this.popup.hidden) {
      if (hit?.key === this.popupKey) {
        this.hideTip();
        return;
      }
      if (hit) this.hidePopup();
    }
    if ((hit?.key ?? null) === this.hoveredKey) { if (hit) this.moveTip(px, py); return; }
    this.hoveredKey = hit?.key ?? null;
    if (!hit) { this.hideTip(); this.render(); return; }
    this.tip.innerHTML = "";
    if (hit.kind === "cluster") {
      const t = document.createElement("div"); t.className = "geomap-tip-loc";
      t.textContent = `${hit.count} contacts · ${hit.locationCount} locations`;
      this.tip.append(t, Object.assign(document.createElement("div"), { className: "dim", textContent: "Click to zoom in" }));
    } else {
      const here = hit.points, first = here[0];
      const t = document.createElement("div"); t.className = "geomap-tip-loc";
      t.textContent = first.place || first.location || "Mapped location";
      this.tip.append(t);
      if (first.locationPrecision) {
        const detail = document.createElement("div"); detail.className = "dim";
        detail.textContent = `${first.locationPrecision}-level location${here.length > 1 ? ` · ${here.length} contacts` : ""}`;
        this.tip.append(detail);
      }
      for (const p of here.slice(0, 8)) {
        const n = document.createElement("div");
        n.textContent = `${p.isOwner ? "★ " : ""}${p.name}${p.deceased ? " †" : ""}`;
        this.tip.append(n);
      }
      if (here.length > 8) this.tip.append(Object.assign(document.createElement("div"), { className: "dim", textContent: `+${here.length - 8} more` }));
    }
    this.tip.hidden = false;
    this.moveTip(px, py);
    this.render();
  }
  moveTip(px, py) {
    const { w } = this.dims();
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${px + 14 + tw > w ? px - 14 - tw : px + 14}px`;
    this.tip.style.top = `${py + 12}px`;
  }

  showLocationPopup(marker, px, py) {
    this.hideTip();
    this.popup.innerHTML = "";
    this.popupKey = marker.key;
    const first = marker.points[0];
    const head = document.createElement("div"); head.className = "geomap-popup-head";
    const precision = first.locationPrecision ? ` · ${first.locationPrecision}-level` : "";
    head.textContent = `${first.place || first.location || "Location"} · ${marker.count}${precision}`;
    this.popup.append(head);
    const list = document.createElement("div");
    const renderList = (query = "") => {
      list.innerHTML = "";
      const q = query.trim().toLowerCase();
      const matches = q ? marker.points.filter((p) => p.name.toLowerCase().includes(q)) : marker.points;
      for (const p of matches.slice(0, 100)) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = `${p.isOwner ? "★ " : ""}${p.name}${p.deceased ? " †" : ""}`;
        b.addEventListener("click", () => { this.hidePopup(); this.handlers.onOpenContact(p.id); });
        list.append(b);
      }
      if (matches.length > 100) {
        const more = document.createElement("div"); more.className = "geomap-popup-more dim";
        more.textContent = `+${matches.length - 100} more · filter by name`;
        list.append(more);
      }
    };
    if (marker.points.length > 12) {
      const search = document.createElement("input");
      search.type = "search"; search.placeholder = "Filter contacts…";
      search.addEventListener("input", () => renderList(search.value));
      this.popup.append(search);
    }
    renderList();
    this.popup.append(list);
    this.popup.hidden = false;
    const { w, h } = this.dims(), pw = this.popup.offsetWidth, ph = this.popup.offsetHeight;
    this.popup.style.left = `${clamp(px + 14, 8, Math.max(8, w - pw - 8))}px`;
    this.popup.style.top = `${clamp(py + 12, 8, Math.max(8, h - ph - 8))}px`;
    this.render(); // clear the hover ring now that the interactive popup owns the marker
  }

  hideTip() {
    this.hoveredKey = null;
    this.tip.hidden = true;
  }

  hidePopup() {
    this.popup.hidden = true;
    this.popupKey = null;
  }

  // --- base layers ---
  drawLand(ctx, th) {
    ctx.fillStyle = th.land;
    ctx.strokeStyle = th.landStroke;
    ctx.lineWidth = 0.5;
    const { w } = this.dims();

    // GeoJSON uses a discontinuity at the antimeridian. Connecting +180 to
    // -180 in screen space draws a line across the whole map, then fills a
    // giant rectangle (most visibly through Russia). Unwrap every ring into a
    // continuous longitude range and render the relevant world copy instead.
    const polygon = (coords) => {
      if (!coords.length) return;
      const outer = unwrapRing(coords[0]);
      const outerXs = outer.map((p) => p[0]);
      const centre = (Math.min(...outerXs) + Math.max(...outerXs)) / 2;
      const rings = [outer, ...coords.slice(1).map((r) => unwrapRing(r, centre))];
      for (const worldOffset of [-360, 0, 360]) {
        const left = this.project(Math.min(...outerXs) + worldOffset, 0).x;
        const right = this.project(Math.max(...outerXs) + worldOffset, 0).x;
        if (right < 0 || left > w) continue;
        ctx.beginPath();
        for (const ring of rings) {
          for (let i = 0; i < ring.length; i++) {
            const p = this.project(ring[i][0] + worldOffset, ring[i][1]);
            i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
          }
          ctx.closePath();
        }
        ctx.fill("evenodd"); // preserve lakes and other interior holes
        if (!this.tiles) ctx.stroke(); // under tiles the vector is just a loading base
      }
    };
    for (const f of WORLD.features) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === "Polygon") polygon(g.coordinates);
      else if (g.type === "MultiPolygon") for (const poly of g.coordinates) polygon(poly);
    }
  }

  drawGraticule(ctx, th, w, h) {
    ctx.lineWidth = 1;
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillStyle = th.text;
    for (let lon = -180; lon <= 180; lon += 30) {
      const a = this.project(lon, MERC_LAT), b = this.project(lon, -MERC_LAT);
      ctx.strokeStyle = lon === 0 ? th.grid0 : th.grid;
      ctx.beginPath(); ctx.moveTo(a.x, Math.max(a.y, 0)); ctx.lineTo(b.x, Math.min(b.y, h)); ctx.stroke();
      if (a.x > 2 && a.x < w - 2) ctx.fillText(`${lon}°`, a.x + 2, Math.max(a.y, 12) + 2);
    }
    for (const lat of [-60, -30, 0, 30, 60]) {
      const a = this.project(-180, lat), b = this.project(180, lat);
      ctx.strokeStyle = lat === 0 ? th.grid0 : th.grid;
      ctx.beginPath(); ctx.moveTo(Math.max(a.x, 0), a.y); ctx.lineTo(Math.min(b.x, w), b.y); ctx.stroke();
      if (a.y > 2 && a.y < h - 2) ctx.fillText(`${lat}°`, Math.max(a.x, 2) + 2, a.y - 2);
    }
  }

  /** @param {"base" | "labels"} [layer] */
  requestTile(z, x, y, layer = "base") {
    const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const key = `${theme}/${layer}/${z}/${x}/${y}`;
    const have = this.tileCache.get(key);
    if (have) return have;
    // Bridge may not exist until the main process is restarted after an update.
    if (!window.api.map?.tile) { this.tileCache.set(key, "error"); return "error"; }
    this.tileCache.set(key, "loading");
    window.api.map.tile({ z, x, y, theme, layer }).then(({ dataUrl }) => {
      if (!dataUrl) { this.tileCache.set(key, "error"); return; }
      const img = new Image();
      img.onload = () => { this.tileCache.set(key, img); this.scheduleRender(); };
      img.onerror = () => this.tileCache.set(key, "error");
      img.src = dataUrl;
    }).catch(() => this.tileCache.set(key, "error"));
    return "loading";
  }

  /** @param {"base" | "labels"} [layer] */
  drawTiles(ctx, w, h, layer = "base") {
    const ws = this.worldSize();
    const tz = clamp(Math.round(this.zoom), 0, MAX_ZOOM);
    const scale = ws / (TILE * 2 ** tz); // current px per tile-pixel
    const tileSize = TILE * scale;
    const n = 2 ** tz;
    const x0 = Math.floor(this.origin.px / tileSize), x1 = Math.floor((this.origin.px + w) / tileSize);
    const y0 = Math.floor(this.origin.py / tileSize), y1 = Math.floor((this.origin.py + h) / tileSize);
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = x0; tx <= x1; tx++) {
        if (tx < 0 || tx >= n) continue;
        const img = this.requestTile(tz, tx, ty, layer);
        if (!(img instanceof Image)) continue;
        const dx = tx * tileSize - this.origin.px, dy = ty * tileSize - this.origin.py;
        ctx.drawImage(img, dx, dy, tileSize + 1, tileSize + 1); // +1 hides seams
      }
    }
  }

  scheduleRender() {
    if (this._raf || this.container.hidden) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  drawAggregate(ctx, marker, th) {
    const r = marker.radius;
    const light = document.documentElement.dataset.theme === "light";
    ctx.save();
    ctx.shadowColor = "rgba(96, 165, 250, 0.45)";
    ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(marker.sx, marker.sy, r, 0, 2 * Math.PI);
    ctx.fillStyle = light ? "#f8fafc" : "#101827"; ctx.fill();
    ctx.restore();

    // Composition ring preserves the individual marker colours without
    // blending them into an ambiguous average.
    const segments = [
      [marker.female, GENDER.Female],
      [marker.male, GENDER.Male],
      [marker.other, th.dotDefault],
    ].filter(([n]) => n > 0);
    let angle = -Math.PI / 2;
    for (const [n, color] of segments) {
      const next = angle + 2 * Math.PI * n / marker.count;
      ctx.beginPath(); ctx.arc(marker.sx, marker.sy, r, angle, next);
      ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.stroke();
      angle = next;
    }

    if (marker.kind === "location") {
      // Double ring means this is a terminal, shared coordinate: zooming will
      // not split it, while a normal spatial cluster will.
      ctx.save();
      ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.arc(marker.sx, marker.sy, r + 4, 0, 2 * Math.PI);
      ctx.strokeStyle = th.label; ctx.globalAlpha = 0.8; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = light ? "#1e293b" : "#f1f5f9";
    ctx.font = `600 ${r >= 18 ? 12 : 11}px ui-monospace, monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(marker.count), marker.sx, marker.sy + 0.5);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";

    if (marker.ownerCount) {
      ctx.beginPath(); ctx.arc(marker.sx + r * 0.72, marker.sy - r * 0.72, 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = "#ffc61a"; ctx.fill();
      ctx.strokeStyle = light ? "#ffffff" : "#101827"; ctx.lineWidth = 1; ctx.stroke();
    }
    if (marker.key === this.hoveredKey) {
      ctx.beginPath(); ctx.arc(marker.sx, marker.sy, r + (marker.kind === "location" ? 7 : 4), 0, 2 * Math.PI);
      ctx.strokeStyle = th.label; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  drawContact(ctx, marker, th) {
    const p = marker.points[0];
    const fill = p.isOwner ? "#ffc61a" : (GENDER[p.gender] || th.dotDefault);
    ctx.save();
    ctx.shadowColor = fill; ctx.shadowBlur = p.isOwner ? 12 : 8;
    ctx.beginPath(); ctx.arc(marker.sx, marker.sy, marker.radius, 0, 2 * Math.PI);
    ctx.fillStyle = fill; ctx.fill();
    ctx.restore();
    ctx.strokeStyle = this.tiles ? "#ffffff" : th.ocean; ctx.lineWidth = 1.5; ctx.stroke();
    if (p.deceased) {
      ctx.beginPath(); ctx.arc(marker.sx, marker.sy, 7.5, 0, 2 * Math.PI);
      ctx.strokeStyle = th.label; ctx.lineWidth = 1.2; ctx.stroke();
    }
    if (marker.key === this.hoveredKey) {
      ctx.beginPath(); ctx.arc(marker.sx, marker.sy, 9, 0, 2 * Math.PI);
      ctx.strokeStyle = th.label; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  render() {
    const { w, h } = this.dims();
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr)) {
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`;
    }
    const th = theme();
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.layout();

    ctx.fillStyle = th.ocean;
    ctx.fillRect(0, 0, w, h);

    if (this.tiles) {
      this.drawLand(ctx, th);       // faint base while tiles stream in
      const light = document.documentElement.dataset.theme === "light";
      if (light) {
        this.drawTiles(ctx, w, h);
      } else {
        // Lift crushed blacks in Dark Matter while keeping the geography
        // quieter than the data layer, then tint it toward Orbit's ink navy.
        ctx.save();
        ctx.filter = "brightness(1.35) contrast(0.82) saturate(0.7)";
        this.drawTiles(ctx, w, h, "base");
        ctx.restore();
        ctx.fillStyle = "rgba(10, 17, 32, 0.18)";
        ctx.fillRect(0, 0, w, h);

        // CARTO's label-only PNGs are transparent, so label luminance can be
        // raised independently without washing out roads and boundaries.
        ctx.save();
        ctx.filter = "brightness(1.9) contrast(1.05)";
        this.drawTiles(ctx, w, h, "labels");
        ctx.restore();
      }
    } else {
      this.drawLand(ctx, th);
      this.drawGraticule(ctx, th, w, h);
    }

    for (const marker of this.placed) {
      if (marker.kind === "contact") this.drawContact(ctx, marker, th);
      else this.drawAggregate(ctx, marker, th);
    }

    if (this.tiles) {
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillStyle = th.attribution;
      ctx.textAlign = "right";
      ctx.fillText("© OpenStreetMap © CARTO", w - 8, h - 8);
      ctx.textAlign = "left";
    }

    this.count.textContent = this.handlers.onPickCoordinates
      ? "click to place pin · drag to pan · scroll to zoom"
      : `${this.points.length} of ${this.total} contacts placed` +
        (this.total > this.points.length ? " · others have no mappable location" : "");
  }

  show() {
    this.syncMode();
    if (!this._fitted) { this.fit(); this._fitted = true; } else { this.clampView(); this.render(); }
  }
  destroy() { this.abort?.abort(); this.ro?.disconnect(); this.themeObserver?.disconnect(); if (this._raf) cancelAnimationFrame(this._raf); }
}
