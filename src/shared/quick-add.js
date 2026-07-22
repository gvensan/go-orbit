// quick-add.js - natural-language contact capture for the palette:
//   "met Sarah Kim, PM at Initech, via Bo Novak, #conf sarah@initech.com"
// Deterministic comma-segment heuristics, not NLP: predictable beats clever
// for a capture box. CommonJS so plain-Node tests and the Vite bundle share it.

const TRIGGER_RE = /^\s*(met|add|new)\s+|^\s*\+\s*/i;
const EMAIL_RE = /\S+@\S+\.\S+/;
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,})/;
const INTRO_RE = /^(?:intro(?:duced)?(?:\s+(?:by|from))?|via|from)\s+(.+)$/i;

/** True when the text looks like a quick-add attempt at all. */
function isQuickAdd(text) {
  return TRIGGER_RE.test(text);
}

/**
 * @param {string} text
 * @returns {null | { name: string, fields: Record<string, string>, tags: string[], introducedBy?: string }}
 */
function parseQuickAdd(text) {
  if (!isQuickAdd(text)) return null;
  let rest = text.replace(TRIGGER_RE, "").trim();
  if (!rest) return null;

  const tags = [];
  rest = rest.replace(/#([\w-]+)/g, (_m, tag) => {
    tags.push(tag.toLowerCase());
    return " ";
  });

  const fields = /** @type {Record<string, string>} */ ({});
  const notes = [];
  let name = "";
  let introducedBy;

  const segments = rest.split(",").map((s) => s.trim()).filter(Boolean);
  segments.forEach((seg, i) => {
    const email = seg.match(EMAIL_RE);
    if (email) {
      fields.email = email[0].replace(/[.,;]$/, "");
      seg = seg.replace(email[0], "").trim();
      if (!seg) return;
    }
    const intro = seg.match(INTRO_RE);
    if (intro) {
      introducedBy = intro[1].replace(/^"|"$/g, "").trim();
      return;
    }
    if (i > 0) {
      const phone = seg.match(PHONE_RE);
      if (phone && seg.replace(phone[0], "").trim() === "") {
        fields.phone = phone[0].trim();
        return;
      }
    }

    const atSplit = seg.split(/\s+at\s+/i);
    if (i === 0) {
      // First segment is the name; "Name at Org" also assigns the org.
      name = atSplit[0].trim();
      if (atSplit.length > 1) fields.company = atSplit.slice(1).join(" at ").trim();
    } else if (atSplit.length > 1) {
      const role = atSplit[0].trim();
      if (role && !/^works?$/i.test(role)) fields.role = role;
      fields.company = atSplit.slice(1).join(" at ").trim();
    } else if (/^(?:works\s+)?at\s+/i.test(seg)) {
      fields.company = seg.replace(/^(?:works\s+)?at\s+/i, "").trim();
    } else if (seg) {
      notes.push(seg);
    }
  });

  if (!name) return null;
  if (notes.length) fields.notes = notes.join(", ");
  return { name, fields, tags, introducedBy };
}

/** One-line human preview of what quick add will create. */
function quickAddPreview(parsed) {
  const bits = [parsed.name];
  if (parsed.fields.role && parsed.fields.company) bits.push(`${parsed.fields.role} at ${parsed.fields.company}`);
  else if (parsed.fields.company) bits.push(parsed.fields.company);
  if (parsed.fields.email) bits.push(parsed.fields.email);
  if (parsed.introducedBy) bits.push(`via ${parsed.introducedBy}`);
  if (parsed.tags.length) bits.push(parsed.tags.map((t) => `#${t}`).join(" "));
  return bits.join(" · ");
}

module.exports = { isQuickAdd, parseQuickAdd, quickAddPreview };
