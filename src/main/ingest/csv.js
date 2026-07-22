// csv.js - RFC 4180-ish CSV reader plus the column-mapping heuristics the
// import wizard offers as defaults.

/**
 * @param {string} text
 * @returns {{ headers: string[], rows: string[][] }}
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);

  const headers = rows.shift() ?? [];
  return { headers: headers.map((h) => h.trim()), rows };
}

/** Field each header most likely maps to; "" = ignore. */
/** @type {[string, RegExp][]} */
const HEADER_HINTS = [
  ["name", /^(full ?name|name|display ?name|contact)$/i],
  ["email", /e-?mail/i],
  ["phone", /^(phone|mobile|tel|telephone|cell)/i],
  ["company", /^(company|org|organisation|organization|employer)$/i],
  ["role", /^(role|title|job ?title|position)$/i],
  ["notes", /^(notes?|comments?)$/i],
  ["tags", /^(tags?|labels?|groups?|categories)$/i],
];

/** @returns {Record<string, string>} header -> field name ("" to ignore) */
function suggestMapping(headers) {
  const mapping = /** @type {Record<string, string>} */ ({});
  const taken = new Set();
  for (const h of headers) {
    let field = "";
    for (const [f, re] of HEADER_HINTS) {
      if (re.test(h) && !taken.has(f)) { field = f; break; }
    }
    if (field) taken.add(field);
    mapping[h] = field;
  }
  return mapping;
}

/**
 * Apply a mapping to raw rows. Unmapped headers become custom fields when
 * mapped explicitly; "" columns are dropped. Rows without a name are skipped.
 * @returns {{ name: string, fields: Record<string, string>, tags: string[] }[]}
 */
function rowsToContacts(headers, rows, mapping) {
  const out = [];
  for (const cells of rows) {
    const contact = { name: "", fields: {}, tags: [] };
    headers.forEach((h, i) => {
      const value = (cells[i] ?? "").trim();
      const field = mapping[h];
      if (!field || !value) return;
      if (field === "name") contact.name = value;
      else if (field === "tags") {
        contact.tags.push(...value.split(/[;,]/).map((t) => t.trim().toLowerCase()).filter(Boolean));
      } else contact.fields[field] = value;
    });
    if (contact.name) out.push(contact);
  }
  return out;
}

module.exports = { parseCSV, suggestMapping, rowsToContacts };
