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
  ["gender", /^(gender|sex)$/i],
  ["birthday", /^(birth ?day|birth ?date|dob|d\.?o\.?b\.?)$/i],
  ["nickname", /^(nick ?name|alias|preferred ?name|goes ?by)$/i],
  ["website", /^(web ?site|url|homepage|site)$/i],
  ["linkedin", /^(linked ?in|linkedin ?url)$/i],
  ["deceased", /^(deceased|passed ?away|memorial)$/i],
  ["notes", /^(notes?|comments?)$/i],
  ["tags", /^(tags?|labels?|groups?|categories)$/i],
];

/** "Female"/"Male" so gender rings match; other values pass through as typed. */
function normGender(v) {
  const g = v.trim().toLowerCase();
  if (g === "f" || g === "female" || g === "woman") return "Female";
  if (g === "m" || g === "male" || g === "man") return "Male";
  return v.trim();
}
const TRUTHY = /^(y|yes|true|1|x|deceased)$/i;

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
      } else if (field === "gender") contact.fields.gender = normGender(value);
      // Deceased is a boolean-ish flag: only store it (as a truthy string) when
      // the cell is affirmative, so "no"/"false" never marks someone deceased.
      else if (field === "deceased") { if (TRUTHY.test(value.trim())) contact.fields.deceased = "true"; }
      else contact.fields[field] = value;
    });
    if (contact.name) out.push(contact);
  }
  return out;
}

// The importer/template column order. Kept in lockstep with CSV_TEMPLATE in the
// import wizard (src/renderer/wizard.js) so an exported file re-imports cleanly.
const EXPORT_COLUMNS = [
  "name", "email", "phone", "company", "role", "gender",
  "birthday", "nickname", "website", "linkedin", "notes", "tags",
];

/** Quote a cell per RFC 4180 when it holds a comma, quote, or newline. */
function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialize contacts to importer-compatible CSV - the same columns, in the same
 * order, as the downloadable template. Tags join on ";" so the importer's tag
 * split round-trips. Edges, kinship, and location are intentionally omitted: the
 * importer captures those in its review step, not from the file, so they would
 * not round-trip (use the .orbit archive for a lossless dump).
 * @param {{ name: string, fields?: Record<string,string>, tags?: string[] }[]} contacts
 * @returns {string}
 */
function contactsToCSV(contacts) {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const c of contacts) {
    const f = c.fields || {};
    lines.push(EXPORT_COLUMNS.map((col) => {
      if (col === "name") return csvCell(c.name);
      if (col === "tags") return csvCell((c.tags || []).join(";"));
      return csvCell(f[col] ?? "");
    }).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// The import wizard's Review-step columns, in on-screen order. The detailed CSV
// mirrors this exactly so a person reading it sees the same shape they review on
// import: one relationship per row (relationship, who it's to, and the kinship).
const REVIEW_COLUMNS = [
  "name", "gender", "relationship", "relationship to", "kinship",
  "location", "birthday", "email", "phone", "company", "role",
  "nickname", "website", "linkedin", "notes", "tags",
];

/**
 * Serialize contacts in the Review-step column shape. A contact with several
 * relationships yields one row per relationship (its fields repeated); a contact
 * with none yields a single row with the relationship columns blank. `kinship` is
 * the contact's OWN role toward the related person (as picked in the wizard).
 * @param {{ name: string, fields?: Record<string,string>, tags?: string[],
 *           relationship?: string, relationshipTo?: string, kinship?: string }[]} rows
 * @returns {string}
 */
function relationshipRowsToCSV(rows) {
  const lines = [REVIEW_COLUMNS.join(",")];
  for (const r of rows) {
    const f = r.fields || {};
    lines.push(REVIEW_COLUMNS.map((col) => {
      switch (col) {
        case "name": return csvCell(r.name);
        case "gender": return csvCell(f.gender ?? "");
        case "relationship": return csvCell(r.relationship ?? "");
        case "relationship to": return csvCell(r.relationshipTo ?? "");
        case "kinship": return csvCell(r.kinship ?? "");
        case "tags": return csvCell((r.tags || []).join(";"));
        default: return csvCell(f[col] ?? "");
      }
    }).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

module.exports = { parseCSV, suggestMapping, rowsToContacts, contactsToCSV, relationshipRowsToCSV, EXPORT_COLUMNS, REVIEW_COLUMNS };
