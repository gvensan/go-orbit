// page-guess.js - turn what a web page exposes (address, title, Open Graph
// tags, the user's selection) into a draft contact for the Add to Orbit flow.
// Deterministic heuristics, not NLP: a LinkedIn title is "Name - Role -
// Company | LinkedIn"; elsewhere a short selection is the name, else the title,
// and the site name the company. The page address is deliberately NOT kept:
// unlike a bookmark tool, Orbit records people, and "where I was when I added
// them" is not a fact about the person (a LinkedIn profile link is, and stays).
// Every guess is shown before anything is saved. CommonJS so plain Node tests
// and the Vite bundle share it.

const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+\d[\d\s().-]{6,}\d|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/;

/** Strip a leading "(3) " notification count and a trailing " | Site" / " · Site". */
function cleanTitle(t) {
  return String(t || "").replace(/^\(\d+\)\s*/, "").replace(/\s*[|·]\s*[^|·]+$/, "").trim();
}

/**
 * @param {{ url?: string, title?: string, text?: string, og?: string, desc?: string, site?: string }} page
 * @returns {{ name: string, fields: Record<string, string>, source: string, isLinkedIn: boolean }}
 */
function guessFromPage(page) {
  const p = { url: "", title: "", text: "", og: "", desc: "", site: "", ...page };
  /** @type {Record<string, string>} */
  const fields = {};
  let host = "";
  try { host = new URL(p.url).hostname.replace(/^www\./, ""); } catch { /* not a URL */ }
  const isLinkedIn = /(^|\.)linkedin\.com$/.test(host) && /\/in\//.test(p.url);
  const raw = cleanTitle(p.og || p.title);
  const text = String(p.text || "").trim();
  // A short selection with no contact details in it is the name the user meant.
  const selectedName = text && text.length <= 60 && !/\n/.test(text) && !EMAIL_RE.test(text) && !PHONE_RE.test(text)
    && text.split(/\s+/).length <= 5 ? text : "";
  let name = "";
  if (isLinkedIn) {
    const parts = raw.split(/\s+[-–]\s+/).map((s) => s.trim()).filter(Boolean);
    name = parts[0] || "";
    if (parts[1]) fields.role = parts[1];
    if (parts[2]) fields.company = parts[2];
    try {
      const u = new URL(p.url);
      fields.linkedin = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    } catch { fields.linkedin = p.url; }
  } else {
    name = selectedName || raw;
    if (p.site && p.site.toLowerCase() !== name.toLowerCase()) fields.company = p.site;
  }
  const email = text.match(EMAIL_RE);
  if (email) fields.email = email[0];
  const phone = text.match(PHONE_RE);
  if (phone) fields.phone = phone[0].trim();
  if (text && text !== name) fields.notes = text;
  const source = p.site || host || p.title || "";
  return { name, fields, source, isLinkedIn };
}

module.exports = { guessFromPage, cleanTitle };
