import { GeoMap } from "./geomap.js";
import { el, openModal } from "./modal.js";

/** Manual fallback for ambiguous/missing geocoder results. */
export function pickLocationOnMap(initial, label) {
  return new Promise((resolve) => {
    let settled = false;
    let point = initial;
    let pinMap;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    const m = openModal({
      title: `Adjust map pin${label ? ` · ${label}` : ""}`,
      onClose: () => { pinMap?.destroy(); settle(null); },
    });
    m.body.closest(".modal")?.classList.add("modal--map");
    m.body.append(el("p", "pin-help dim", "Click the exact location. Drag to pan and use the wheel or controls to zoom."));
    const mapHost = el("div", "pin-map");
    mapHost.title = "Click to place the pin. Drag to pan, wheel or the buttons to zoom";
    const coords = el("div", "pin-coordinates mono dim");
    coords.title = "Latitude and longitude of the pin you placed";
    m.body.append(mapHost, coords);
    const update = (next) => {
      point = next;
      coords.textContent = `${next.lat.toFixed(6)}, ${next.lon.toFixed(6)} · manual pin`;
      pinMap.setPoints([{ id: -1, name: label || "Selected location", lat: next.lat, lon: next.lon }], 1);
    };
    pinMap = new GeoMap(mapHost, { onPickCoordinates: update });
    if (initial) {
      update(initial);
      requestAnimationFrame(() => pinMap.focus(initial.lat, initial.lon));
    } else {
      pinMap.setPoints([], 0);
      coords.textContent = "No pin selected";
    }
    const cancel = el("button", null, "Cancel"); cancel.type = "button";
    const save = el("button", "primary", "Save pin"); save.type = "button"; save.disabled = !point;
    save.title = "Use these exact coordinates. The location text stays as it was written";
    m.foot.append(cancel, save);
    cancel.addEventListener("click", () => m.close());
    save.addEventListener("click", () => { if (point) { settle(point); m.close(); } });
    mapHost.addEventListener("click", () => { save.disabled = !point; });
  });
}
