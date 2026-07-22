// vcard.js - minimal vCard 3.0/4.0 reader for the import path. Handles line
// folding, multiple cards per file, and the fields this app stores: FN/N,
// EMAIL, TEL, ORG, TITLE, NOTE, CATEGORIES (-> tags). Unknown properties are
// ignored, never fatal: import is forgiving by design.

/** Unfold RFC 6350 continuation lines (CRLF followed by space/tab). */
function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, "");
}

function unescapeValue(v) {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

/**
 * @param {string} text raw .vcf content
 * @returns {{ name: string, fields: Record<string, string>, tags: string[] }[]}
 */
function parseVCard(text) {
  const cards = [];
  let current = null;

  for (const rawLine of unfold(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VCARD") {
      current = { name: "", fields: {}, tags: [] };
      continue;
    }
    if (upper === "END:VCARD") {
      if (current && current.name) cards.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const rawKey = line.slice(0, colon);
    const value = unescapeValue(line.slice(colon + 1));
    if (!value) continue;
    // Strip group prefix (item1.EMAIL) and parameters (EMAIL;TYPE=WORK).
    const key = rawKey.split(";")[0].split(".").pop().toUpperCase();

    switch (key) {
      case "FN":
        current.name = value;
        break;
      case "N":
        if (!current.name) {
          const [family, given] = value.split(";");
          current.name = [given, family].filter(Boolean).join(" ").trim();
        }
        break;
      case "EMAIL":
        if (!current.fields.email) current.fields.email = value;
        break;
      case "TEL":
        if (!current.fields.phone) current.fields.phone = value;
        break;
      case "ORG":
        current.fields.company = value.split(";")[0].trim();
        break;
      case "TITLE":
        current.fields.role = value;
        break;
      case "NOTE":
        current.fields.notes = value;
        break;
      case "CATEGORIES":
        current.tags.push(...value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean));
        break;
    }
  }
  return cards;
}

module.exports = { parseVCard };
