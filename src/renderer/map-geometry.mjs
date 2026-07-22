/** Convert a GeoJSON ring into a continuous longitude sequence. GeoJSON may
 * jump between +180 and -180 at the antimeridian; canvas must not connect that
 * discontinuity across the visible world. */
export function unwrapRing(coords, alignTo = null) {
  if (!coords.length) return [];
  const out = [[coords[0][0], coords[0][1]]];
  for (let i = 1; i < coords.length; i++) {
    let lon = coords[i][0];
    const prev = out[out.length - 1][0];
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    out.push([lon, coords[i][1]]);
  }
  if (alignTo != null) {
    const xs = out.map((p) => p[0]);
    const centre = (Math.min(...xs) + Math.max(...xs)) / 2;
    const shift = Math.round((alignTo - centre) / 360) * 360;
    if (shift) for (const p of out) p[0] += shift;
  }
  return out;
}
