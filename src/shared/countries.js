// countries.js - ISO country data for the phone-number input: name, iso2, and
// international dial code. The flag is derived from iso2 (regional-indicator
// codepoints), so no image assets. Ordered by name; common countries can be
// surfaced first by the UI. CJS so the renderer bundles it and tests require it.

/** @type {{ name: string, iso2: string, dial: string }[]} */
const COUNTRIES = [
  { name: "United States", iso2: "US", dial: "1" },
  { name: "Canada", iso2: "CA", dial: "1" },
  { name: "United Kingdom", iso2: "GB", dial: "44" },
  { name: "Australia", iso2: "AU", dial: "61" },
  { name: "India", iso2: "IN", dial: "91" },
  { name: "Germany", iso2: "DE", dial: "49" },
  { name: "France", iso2: "FR", dial: "33" },
  { name: "Spain", iso2: "ES", dial: "34" },
  { name: "Italy", iso2: "IT", dial: "39" },
  { name: "Netherlands", iso2: "NL", dial: "31" },
  { name: "Belgium", iso2: "BE", dial: "32" },
  { name: "Switzerland", iso2: "CH", dial: "41" },
  { name: "Austria", iso2: "AT", dial: "43" },
  { name: "Sweden", iso2: "SE", dial: "46" },
  { name: "Norway", iso2: "NO", dial: "47" },
  { name: "Denmark", iso2: "DK", dial: "45" },
  { name: "Finland", iso2: "FI", dial: "358" },
  { name: "Ireland", iso2: "IE", dial: "353" },
  { name: "Portugal", iso2: "PT", dial: "351" },
  { name: "Poland", iso2: "PL", dial: "48" },
  { name: "Czech Republic", iso2: "CZ", dial: "420" },
  { name: "Greece", iso2: "GR", dial: "30" },
  { name: "Romania", iso2: "RO", dial: "40" },
  { name: "Hungary", iso2: "HU", dial: "36" },
  { name: "Ukraine", iso2: "UA", dial: "380" },
  { name: "Russia", iso2: "RU", dial: "7" },
  { name: "Turkey", iso2: "TR", dial: "90" },
  { name: "Israel", iso2: "IL", dial: "972" },
  { name: "United Arab Emirates", iso2: "AE", dial: "971" },
  { name: "Saudi Arabia", iso2: "SA", dial: "966" },
  { name: "Qatar", iso2: "QA", dial: "974" },
  { name: "Egypt", iso2: "EG", dial: "20" },
  { name: "South Africa", iso2: "ZA", dial: "27" },
  { name: "Nigeria", iso2: "NG", dial: "234" },
  { name: "Kenya", iso2: "KE", dial: "254" },
  { name: "Ghana", iso2: "GH", dial: "233" },
  { name: "Morocco", iso2: "MA", dial: "212" },
  { name: "Brazil", iso2: "BR", dial: "55" },
  { name: "Mexico", iso2: "MX", dial: "52" },
  { name: "Argentina", iso2: "AR", dial: "54" },
  { name: "Chile", iso2: "CL", dial: "56" },
  { name: "Colombia", iso2: "CO", dial: "57" },
  { name: "Peru", iso2: "PE", dial: "51" },
  { name: "China", iso2: "CN", dial: "86" },
  { name: "Japan", iso2: "JP", dial: "81" },
  { name: "South Korea", iso2: "KR", dial: "82" },
  { name: "Singapore", iso2: "SG", dial: "65" },
  { name: "Hong Kong", iso2: "HK", dial: "852" },
  { name: "Taiwan", iso2: "TW", dial: "886" },
  { name: "Malaysia", iso2: "MY", dial: "60" },
  { name: "Indonesia", iso2: "ID", dial: "62" },
  { name: "Thailand", iso2: "TH", dial: "66" },
  { name: "Vietnam", iso2: "VN", dial: "84" },
  { name: "Philippines", iso2: "PH", dial: "63" },
  { name: "Pakistan", iso2: "PK", dial: "92" },
  { name: "Bangladesh", iso2: "BD", dial: "880" },
  { name: "Sri Lanka", iso2: "LK", dial: "94" },
  { name: "New Zealand", iso2: "NZ", dial: "64" },
];

/** Regional-indicator flag emoji from an ISO-3166 alpha-2 code. */
function flagEmoji(iso2) {
  return String(iso2)
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

/** Longest-dial-code match for an E.164-ish string, e.g. "+15550100" -> US. */
function parsePhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw.startsWith("+")) return null;
  const digits = raw.slice(1).replace(/\D/g, "");
  let best = null;
  for (const c of COUNTRIES) {
    if (digits.startsWith(c.dial) && (!best || c.dial.length > best.dial.length)) best = c;
  }
  if (!best) return null;
  return { country: best, national: digits.slice(best.dial.length) };
}

const dialOf = (iso2) => (COUNTRIES.find((c) => c.iso2 === iso2) || { dial: "" }).dial;

// National-number groupings for a readable format. Countries not listed fall
// back to a generic 3-digit grouping (first group holds the remainder).
const PHONE_GROUPS = { IN: [5, 5], US: [3, 3, 4], CA: [3, 3, 4] };

/** Space-group national digits, e.g. IN "9812345678" -> "98123 45678". */
function groupNational(iso2, national) {
  const nat = String(national ?? "").replace(/\D/g, "");
  const pat = PHONE_GROUPS[iso2];
  if (pat && pat.reduce((a, b) => a + b, 0) === nat.length) {
    const out = [];
    let i = 0;
    for (const g of pat) { out.push(nat.slice(i, i + g)); i += g; }
    return out.join(" ");
  }
  if (nat.length <= 4) return nat;
  const first = nat.length % 3 || 3; // keep trailing groups as clean triples
  const parts = [nat.slice(0, first)];
  for (let i = first; i < nat.length; i += 3) parts.push(nat.slice(i, i + 3));
  return parts.join(" ");
}

/**
 * Split a raw phone string into { iso2, dial, national }, or null when it can't
 * be confidently normalized (so junk like extensions is left untouched).
 *   - "+<dial>..."  -> longest dial-code match
 *   - "00<dial>..." -> treated as "+<dial>..."
 *   - no country code -> `defaultIso` (India), for clean 10-digit / 0-11 / 91-12 forms
 * @param {string} value
 * @param {{ defaultIso?: string }} [opts]
 */
function normalizePhone(value, { defaultIso = "IN" } = {}) {
  let raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^00\d/.test(raw)) raw = "+" + raw.slice(2); // international access prefix
  if (raw.startsWith("+")) {
    const p = parsePhone(raw);
    return p ? { iso2: p.country.iso2, dial: p.country.dial, national: p.national } : null;
  }
  const d = raw.replace(/\D/g, "");
  if (defaultIso === "IN") {
    // Clean Indian forms only; anything else is left alone rather than mis-tagged.
    if (d.length === 10) return { iso2: "IN", dial: "91", national: d };
    if (d.length === 11 && d[0] === "0") return { iso2: "IN", dial: "91", national: d.slice(1) };
    if (d.length === 12 && d.startsWith("91")) return { iso2: "IN", dial: "91", national: d.slice(2) };
    return null;
  }
  // Non-India default (an explicit UI country pick): prefix a plausible number.
  const dial = dialOf(defaultIso);
  if (dial && d.length >= 4 && d.length <= 14) return { iso2: defaultIso, dial, national: d };
  return null;
}

/**
 * Standardize a phone string to "+<dial> <grouped national>", e.g.
 * "9880749181" -> "+91 98807 49181", "+14085551234" -> "+1 408 555 1234".
 * Returns the trimmed original untouched when it can't be normalized.
 * @param {string} value
 * @param {{ defaultIso?: string }} [opts]
 */
function formatPhone(value, opts) {
  const n = normalizePhone(value, opts);
  if (!n) return String(value ?? "").trim();
  const grouped = groupNational(n.iso2, n.national);
  return grouped ? `+${n.dial} ${grouped}` : `+${n.dial}`;
}

module.exports = { COUNTRIES, flagEmoji, parsePhone, dialOf, groupNational, normalizePhone, formatPhone };
