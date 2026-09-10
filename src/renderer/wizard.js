// wizard.js - the import wizard (APP_SHELL_UX §3). Archive: source ->
// dedup policy -> run. CSV: source -> mapping -> editable review table
// (validate, relationship + kinship + location per row) -> confirm -> run.
// vCard: same as CSV minus the mapping step (fields are fixed by the format).

import { el, openModal, confirmModal } from "./modal.js";
import { toast, toastError } from "./toast.js";
import { EDGE_TYPES, kinPreview, kinRolesFor, reciprocalRole } from "./colors.js";
import { BUSINESS_TYPES } from "../shared/relationships.js";
import { pickLocationOnMap } from "./location-picker.js";
import { COUNTRIES, flagEmoji, dialOf, groupNational, normalizePhone, formatPhone } from "../shared/countries.js";

// Numbers without a country code are treated as Indian (see normalizePhone).
const DEFAULT_PHONE_ISO = "IN";

// Extra editable columns shown per row beyond name/gender/relationship/location.
const DETAIL_FIELDS = ["birthday", "email", "phone", "company", "role", "nickname", "website", "linkedin", "notes"];
// Second-line format hint under a column label.
const FORMAT_HINT = {
  gender: "Male/Female",
  birthday: "DD/MM/YYYY or YYYY-MM-DD",
  tags: "tag1;tag2",
};
// Hover help per review-table column, for the ones whose purpose is not obvious
// from a one-word header.
const COLUMN_HINT = {
  "": "Turn each record on to import it, off to skip it. The icon beside it shows whether the row is complete",
  name: "Required. This is the name the contact will be created with",
  gender: "Sets the ring colour on the graph and the kinship terms available. Not needed for vendor rows",
  reltype: "How this person connects to someone you already know, or to another row in this file",
  related: "Who they are connected to. Matches existing contacts and other rows in this file",
  kinship: "The exact family role, for family relationships only. Needs a gender and a related person first",
  location: "Type a place and pick a suggestion to map it, or use the pin to choose the exact spot",
  tags: "Separate multiple tags with a semicolon",
};

/** "" | "Male" | "Female" | original (unrecognised passes through for the warning). */
function normGender(v) {
  const g = String(v || "").trim().toLowerCase();
  if (!g) return "";
  if (g === "m" || g === "male" || g === "man") return "Male";
  if (g === "f" || g === "female" || g === "woman") return "Female";
  return String(v).trim();
}

/** Birthday -> { ok, iso }. Accepts DD/MM/YYYY or YYYY-MM-DD; empty is ok. */
function normBirthday(v) {
  const s = String(v || "").trim();
  if (!s) return { ok: true, iso: "" };
  let y, mo, d;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) { [, y, mo, d] = m; }
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { [, d, mo, y] = m; }
  else return { ok: false, iso: "" };
  const yy = +y, mm = +mo, dd = +d;
  const dt = new Date(yy, mm - 1, dd);
  if (dt.getFullYear() !== yy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return { ok: false, iso: "" };
  const p = (n) => String(n).padStart(2, "0");
  return { ok: true, iso: `${yy}-${p(mm)}-${p(dd)}` };
}

const looksEmail = (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
const looksUrl = (v) => !v || /^(https?:\/\/|www\.)\S+$/i.test(v.trim());

/** Per-row problems: which required fields are missing, which values are invalid. */
function rowIssues(row) {
  const missing = [];
  const invalid = [];
  if (!String(row.name || "").trim()) missing.push("name");
  const rel = row.rel || {};
  // A business row (vendor) has no gender to supply, so don't ask for one.
  const g = normGender(row.gender);
  if (!BUSINESS_TYPES.has(rel.type)) {
    if (!g) missing.push("gender"); else if (g !== "Male" && g !== "Female") invalid.push("gender");
  }
  const hasRelated = rel.existingId != null || rel.batchIndex != null;
  if (!rel.type) missing.push("relationship");
  if (!hasRelated) missing.push("related contact");
  if (rel.type === "family" && hasRelated && !rel.role) missing.push("kinship");
  if (!normBirthday(row.fields.birthday).ok) invalid.push("birthday");
  if (!looksEmail(row.fields.email)) invalid.push("email");
  if (!looksUrl(row.fields.website)) invalid.push("website");
  if (!looksUrl(row.fields.linkedin)) invalid.push("linkedin");
  return { missing, invalid, complete: missing.length === 0 && invalid.length === 0 };
}

const FIELD_OPTIONS = [
  "", "name", "email", "phone", "company", "role", "gender",
  "birthday", "nickname", "website", "linkedin", "notes", "deceased", "tags",
];
const api = () => window.api;

// A ready-to-fill CSV whose headers auto-map to Orbit's fields (see csv.js
// HEADER_HINTS). Location and relationships are captured in the review step,
// not the file. Tags are separated by ";" so they don't collide with the comma
// delimiter. The example rows show the expected shape and can be deleted.
const CSV_TEMPLATE = [
  "name,email,phone,company,role,gender,birthday,nickname,website,linkedin,notes,tags",
  "Ada Lovelace,ada@example.com,+1 555 0100,Analytical Engines,Mathematician,Female,1815-12-10,Ada,https://ada.example.com,https://linkedin.com/in/ada,Met at the Analytical Society,friend;mentor",
  "Alan Turing,alan@example.com,+44 20 7946 0000,Bletchley Park,Cryptanalyst,Male,1912-06-23,,,,,colleague",
  "",
].join("\n");

/** Offer the CSV template as a local download. No network, no main-process
 *  round-trip: a Blob URL downloaded via an <a download> (allowed under the
 *  renderer's strict CSP). */
function downloadCsvTemplate() {
  const url = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "orbit-contacts-template.csv";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param {{ onDone: () => void, reloadPath?: string }} opts
 *   reloadPath: reopen straight on this saved results file (Save and reload).
 */
export async function openImportWizard({ onDone, reloadPath }) {
  let resizeObs = null, resizeTimer = null, removeResize = null;
  const m = openModal({ title: "Import contacts", maximizable: true, onClose: () => { if (warnTipEl) warnTipEl.remove(); if (removeResize) removeResize(); } });
  const state = {
    srcPath: null,
    kind: null,
    preview: null,
    passphrase: undefined,
    mapping: null,
    onDuplicate: /** @type {"skip" | "merge" | "keepBoth"} */ ("skip"),
    rows: null,          // CSV/vCard review rows (all parsed rows, editable)
    existing: [],        // { id, name, gender } of live contacts, for related-to lookup
    page: 0,
    incompleteOnly: false,
    // Resolve step (per-record duplicate decisions). The user is master of every row.
    resolveMode: localStorage.getItem("orbit-import-mode") === "single" ? "single" : "batch",
    resolveIdx: 0,       // one-at-a-time cursor (position within the visible set)
    resolveFilter: "all",
    showIgnored: true,   // opt-in: show all rows so the user can mark which to import
    hideImported: false, // hide rows already imported in a prior run (orbit_status)
    search: "",          // filter rows by name (Review + Resolve)
    match: null,         // MatchResult[] parallel to rows (from import:match)
    decisions: [],       // per-row { mode: "new"|"ignore"|"merge", targetId? }
    activeRender: null,  // current re-render fn (Review/Resolve), for resize refit
  };

  const stepsBar = el("div", "wizard-steps");
  m.body.append(stepsBar);
  const content = el("div");
  m.body.append(content);

  // Re-fit pagination only when the AVAILABLE space actually changes: the viewport
  // (window resize) or the maximize toggle (a class change on the modal). Observing
  // the box's own size would loop, because every re-render changes the box height,
  // which would re-trigger the observer and churn (detaching the search box, etc.).
  const modalBox = m.body.closest(".modal");
  const refit = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.activeRender) state.activeRender(); }, 120);
  };
  if (typeof window !== "undefined") window.addEventListener("resize", refit);
  if (modalBox && typeof MutationObserver !== "undefined") {
    resizeObs = new MutationObserver(refit);
    resizeObs.observe(modalBox, { attributes: true, attributeFilter: ["class"] });
  }
  removeResize = () => {
    if (typeof window !== "undefined") window.removeEventListener("resize", refit);
    if (resizeObs) resizeObs.disconnect();
  };

  /** Rows that fit in the modal body at the current (capped) size, so the list
   *  does not scroll. Estimate from the modal's max height minus the chrome
   *  already shown; `rowPx` is the approximate per-row height, `reservePx` the
   *  table header + pager allowance. */
  function fitPageSize(rowPx, reservePx) {
    if (!modalBox || typeof window === "undefined") return 10;
    const maxVh = modalBox.classList.contains("modal--max") ? 0.94 : 0.84;
    const cap = window.innerHeight * maxVh;
    const headEl = /** @type {HTMLElement | null} */ (modalBox.firstElementChild);
    const headH = headEl?.offsetHeight || 48;
    const footH = m.foot.offsetHeight || 52;
    const chromeH = content.offsetHeight || 0; // toolbar/header/stats/bulk already shown
    const avail = cap - headH - footH - 32 /* body padding */ - chromeH - reservePx;
    return Math.max(3, Math.floor(avail / rowPx));
  }

  /** After a paged render, if the list still overflows, measure the tallest actual
   *  row, cache it, and re-render with fewer rows. Only ever shrinks, so it
   *  converges (row heights vary, especially in Resolve). Runs after paint. */
  function refitPage(rowSelector, stashKey) {
    requestAnimationFrame(() => {
      const rows = content.querySelectorAll(rowSelector);
      if (!rows.length) return;
      let maxH = 0; rows.forEach((r) => { maxH = Math.max(maxH, r.getBoundingClientRect().height); });
      maxH += 8; // row gap / margin
      // Learn the real row height once (the initial estimate under-counts tall rows,
      // so the first page over-fills). Re-render only when rows are TALLER than the
      // cached estimate; never grow it back, so this converges after one pass and
      // never loops. renderReview()'s own fitPageSize (measured on chrome-only,
      // before the table is appended) then computes the correct row count.
      if (maxH > (state[stashKey] || 0) + 1) { state[stashKey] = maxH; if (state.activeRender) state.activeRender(); }
    });
  }

  // vCard skips the CSV column-mapping step but shares the editable review
  // table, so the step chips depend on the source kind.
  const stepsFor = () => {
    if (state.kind === "archive") return ["Source", "Review", "Import"];
    if (state.kind === "vcard") return ["Source", "Review", "Resolve", "Import"];
    return ["Source", "Mapping", "Review", "Resolve", "Import"];
  };

  function setStep(name) {
    state.activeRender = null; // only Review/Resolve refit on resize
    stepsBar.innerHTML = "";
    for (const s of stepsFor()) {
      stepsBar.append(el("span", "wizard-step" + (s === name ? " active" : ""), s));
    }
    content.innerHTML = "";
    m.foot.innerHTML = "";
  }

  /** Where "Back" from the review table goes: CSV re-maps, vCard re-picks the file. */
  const reviewBack = () => (state.kind === "csv" ? stepMapping() : stepSource());

  // ---- step 0: pick source ----
  async function stepSource() {
    setStep("Source");
    const grid = el("div", "source-grid");
    const mkSource = (label, sub, filters, hint) => {
      const b = el("button");
      b.type = "button";
      b.title = hint;
      b.append(el("strong", null, label), el("span", "mono dim", sub));
      b.addEventListener("click", async () => {
        try {
          const { path } = await api().dialogs.openFile({ filters });
          if (!path) return;
          state.srcPath = path;
          state.rows = null; // a new file invalidates previously parsed rows
          state.preview = await api().data.importPreview({ srcPath: path });
          state.kind = state.preview.kind;
          if (state.preview.encrypted) return stepPassphrase();
          if (state.kind === "csv") stepMapping();
          else if (state.kind === "vcard") stepReview(); // same editable table as CSV
          else stepPolicy(); // archive: no per-row editing, straight to dedup policy
        } catch (err) {
          toastError(err);
        }
      });
      grid.append(b);
    };
    mkSource("vCard", ".vcf", [{ name: "vCard", extensions: ["vcf", "vcard"] }],
      "A contact card export from Contacts, Outlook, or a phone. Fields are fixed by the format, so there is no column mapping step");
    mkSource("CSV", ".csv", [{ name: "CSV", extensions: ["csv"] }],
      "A spreadsheet export. You map its columns to Orbit's fields, then review every row before anything is written");
    mkSource("Archive", ".orbit", [{ name: "Orbit archive", extensions: ["orbit"] }],
      "A full Orbit export: contacts, connections, tags, notes, and timelines. Use this to move between devices");
    content.append(grid);

    // Subtle helper for the CSV path: a template with the columns Orbit maps.
    const csvHelp = el("p", "mono dim source-csv-help");
    csvHelp.append(document.createTextNode("New to CSV? "));
    const tmpl = el("a", "template-link");
    tmpl.textContent = "Download the CSV template";
    tmpl.title = "Save a ready-to-fill CSV whose headers Orbit maps automatically. Saved locally, no network";
    tmpl.href = "#";
    tmpl.addEventListener("click", (e) => { e.preventDefault(); downloadCsvTemplate(); });
    csvHelp.append(tmpl);
    content.append(csvHelp);

    content.append(el("p", "mono dim", "Everything is parsed locally. A backup snapshot is taken before any import."));
  }

  // ---- step 0b: archive passphrase ----
  function stepPassphrase() {
    setStep("Source");
    content.append(el("p", null, "This archive is passphrase-protected."));
    const row = el("div", "form-row");
    row.append(el("label", null, "Passphrase"));
    const input = el("input");
    input.type = "password";
    input.title = "The passphrase set when this archive was exported. Orbit cannot recover it for you";
    row.append(input);
    content.append(row);
    const next = el("button", "primary", "Unlock");
    next.type = "button";
    next.title = "Decrypt the archive and read what is inside. Nothing is imported yet";
    next.addEventListener("click", async () => {
      try {
        state.passphrase = input.value;
        state.preview = await api().data.importPreview({ srcPath: state.srcPath, passphrase: input.value });
        stepPolicy();
      } catch (err) {
        toastError(err);
      }
    });
    m.foot.append(next);
    input.focus();
  }

  // ---- step 1: CSV mapping ----
  function stepMapping() {
    setStep("Mapping");
    const { headers, suggestedMapping, count } = state.preview;
    content.append(el("p", null, `${count} rows found. Map each column:`));
    const table = el("table", "map-table");
    /** @type {Record<string, HTMLSelectElement>} */
    const selects = {};
    for (const h of headers) {
      const tr = el("tr");
      const td1 = el("td", "mono", h);
      const td2 = el("td");
      const sel = el("select");
      sel.title = `Which Orbit field the "${h}" column fills. Choose (ignore) to drop it, or custom to keep it under its own name`;
      for (const f of FIELD_OPTIONS) sel.append(new Option(f === "" ? "(ignore)" : f, f));
      sel.append(new Option(`custom: ${h}`, `custom:${h}`));
      sel.value = suggestedMapping?.[h] ?? "";
      selects[h] = sel;
      td2.append(sel);
      tr.append(td1, td2);
      table.append(tr);
    }
    content.append(table);

    const next = el("button", "primary", "Next");
    next.type = "button";
    next.title = "Apply this mapping and go on to review every row. Nothing is written yet";
    next.addEventListener("click", () => {
      const mapping = {};
      for (const [h, sel] of Object.entries(selects)) {
        mapping[h] = sel.value.startsWith("custom:") ? h : sel.value;
      }
      if (!Object.values(mapping).includes("name")) {
        content.prepend(el("p", "danger", "One column must map to name."));
        return;
      }
      state.mapping = mapping;
      stepReview();
    });
    m.foot.append(next);
  }

  // ---- step 2 (CSV): editable review table ----
  function stepReview() {
    setStep("Review");
    m.body.closest(".modal")?.classList.add("modal--wide");
    content.append(el("p", "dim", "Loading rows…"));
    Promise.all([
      state.rows ? Promise.resolve(null) : api().data.importParse({ srcPath: state.srcPath, kind: state.kind, mapping: state.mapping ?? undefined }),
      api().contacts.list({}),
    ]).then(([parsed, contacts]) => {
      if (parsed) {
        state.rows = parsed.rows.map((r) => ({
          name: r.name, gender: r.fields.gender ?? "", tags: r.tags ?? [],
          fields: { ...r.fields },
          // Opt-in: every row starts NOT considered, so nothing imports until the
          // user marks it ("Consider all" begins clearly OFF). Rows are all shown
          // (state.showIgnored defaults true) so they can be marked; import
          // touches only the rows turned on.
          consider: false,
          // rel: relationship captured in the table. type = edge type; a related
          // contact (existingId or batchIndex); role/recip only when type=family.
          rel: { type: "", relatedName: "", existingId: undefined, batchIndex: undefined, relatedGender: "", role: "", recip: null },
        }));
        for (const r of state.rows) {
          delete r.fields.gender; // gender lives on row.gender
          // Standardize phones up front so EVERY row (not just the visible page)
          // is stored in a country-aware format; the phone cell re-parses this.
          if (r.fields.phone) r.fields.phone = formatPhone(r.fields.phone, { defaultIso: DEFAULT_PHONE_ISO });
        }
      }
      state.existing = contacts.map((c) => ({ id: c.id, name: c.name, gender: c.fields?.gender ?? "" }));
      renderReview();
    }).catch((err) => {
      content.innerHTML = ""; toastError(err);
      const back = el("button", null, "Back"); back.type = "button";
      back.title = "Go back and choose a different file";
      back.addEventListener("click", reviewBack);
      m.foot.append(back);
    });
  }

  /** Triage tally over the rows: how many are for consideration vs ignored, and
   *  (of the considered ones) how many are complete vs still need attention. */
  function reviewStats() {
    let complete = 0;
    for (const r of state.rows) if (r.consider !== false && rowIssues(r).complete) complete++;
    const c = considerCounts();
    return { total: state.rows.length, consider: c.considered, ignored: c.ignored, imported: c.imported, complete, attention: c.considered - complete };
  }

  /** Refresh the triage counts line without re-rendering the whole table. */
  function refreshCounts() {
    const line = content.querySelector(".rv-stats");
    if (!line) return;
    const s = reviewStats();
    line.innerHTML = "";
    const stat = (cls, text, hint) => {
      const b = el("b", cls, text);
      b.title = hint;
      return b;
    };
    line.append(
      stat("rv-consider", `${s.consider} for consideration`, "Records switched on, which the import will process"),
      el("span", "mono dim", " · "),
      stat("rv-complete", `${s.complete} complete`, "Considered records with everything they need"),
      el("span", "mono dim", " · "),
      stat("rv-attention", `${s.attention} need attention`, "Considered records still missing something, or holding an invalid value"),
      el("span", "mono dim", " · "),
      stat("rv-ignored", `${s.ignored} ignored`, "Records switched off, which the import will skip"),
    );
    if (s.imported) line.append(el("span", "mono dim", " · "),
      stat("rv-imported", `${s.imported} already imported`, "Records this file records as imported on an earlier run"));
  }

  /** Update the header "Consider all" switch to match the current selection
   *  without a full re-render (so marking rows stays smooth). */
  function refreshMasterToggle() {
    const cb = /** @type {HTMLInputElement|null} */ (content.querySelector(".master-toggle input"));
    if (!cb) return;
    const c = considerCounts();
    cb.checked = c.actionable > 0 && c.actionableConsidered === c.actionable;
    cb.indeterminate = c.actionableConsidered > 0 && c.actionableConsidered < c.actionable;
  }

  /** A per-row consider/ignore switch, shared by Review and Resolve rows/cards. */
  function considerToggle(row, onChange) {
    const lab = el("label", "consider-toggle");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = row.consider !== false;
    cb.setAttribute("aria-label", "Consider this record for import");
    lab.title = row.consider !== false ? "Considering (uncheck to ignore)" : "Ignored (check to consider)";
    cb.addEventListener("change", () => { row.consider = cb.checked; onChange(); });
    const track = el("span", "ct-track"); track.append(el("span", "ct-knob"));
    lab.append(cb, track);
    return lab;
  }

  // Three categories per row: already imported in a prior run ("done" - never
  // re-selected by Consider all, never counted as ignored), considered (will
  // import this run), and ignored (not imported yet, not selected). "actionable"
  // = rows that aren't already done, i.e. the set Consider all operates on.
  const considerCounts = () => {
    let considered = 0, ignored = 0, imported = 0, actionable = 0, actionableConsidered = 0;
    for (const r of state.rows) {
      const imp = priorImported(r);
      const on = r.consider !== false;
      if (imp) imported++;
      if (on) considered++;
      if (!imp) { actionable++; if (on) actionableConsidered++; }
      if (!on && !imp) ignored++;
    }
    return { considered, ignored, imported, actionable, actionableConsidered };
  };

  /** Was this row already imported in a prior run (from a saved results file)? */
  const priorImported = (row) => {
    const p = String(row.fields?.orbit_status || "").trim().toLowerCase();
    return p === "imported" || p === "merged";
  };
  const importedCount = () => state.rows.filter(priorImported).length;

  /** Row indices currently shown in the batch list: hides ignored (unless
   *  revealed) and, optionally, rows already imported in a prior run. */
  const visibleIndices = () =>
    state.rows.map((_r, i) => i).filter((i) => {
      const row = state.rows[i];
      if (state.hideImported && priorImported(row)) return false;
      // "Hide ignored" only affects not-imported, unselected rows (the true
      // ignored set); already-imported rows are governed by "Hide imported".
      if (!state.showIgnored && row.consider === false && !priorImported(row)) return false;
      return true;
    });

  /** Rows the one-at-a-time stepper walks: only those to be processed (considered),
   *  since ignored records are already decided and need no per-record review. */
  const consideredIndices = () => state.rows.map((_r, i) => i).filter((i) => state.rows[i].consider !== false);

  const nameMatch = (row) => !state.search || String(row.name || "").toLowerCase().includes(state.search.trim().toLowerCase());

  /** A name-search box. On input it filters the list and re-renders, then restores
   *  focus + caret so typing stays smooth despite the re-render. */
  // Search-box focus survives a re-render. captureSearchFocus() returns the caret
  // position if the name-search box is focused (-1 otherwise); restoreSearchFocus()
  // re-focuses the rebuilt box. Both the input handler AND the async pagination
  // refit re-render, so restoring inside the render functions (not just the input
  // handler) is what keeps focus from being stolen after the first character.
  function captureSearchFocus() {
    const ae = /** @type {any} */ (document.activeElement);
    if (ae && ae.classList && ae.classList.contains("rv-search")) {
      return typeof ae.selectionStart === "number" ? ae.selectionStart : ae.value.length;
    }
    return -1;
  }
  function restoreSearchFocus(caret) {
    if (caret < 0) return;
    const s = /** @type {HTMLInputElement|null} */ (content.querySelector(".rv-search"));
    if (!s) return;
    s.focus();
    const c = Math.min(caret, s.value.length);
    try { s.setSelectionRange(c, c); } catch { /* ignore */ }
  }

  function searchInput(rerender) {
    const inp = el("input", "rv-in rv-search");
    inp.type = "text"; inp.placeholder = "search name…"; inp.value = state.search;
    inp.title = "Filter the rows shown by name. This does not change what gets imported";
    inp.setAttribute("aria-label", "Search rows by name");
    inp.addEventListener("input", () => {
      state.search = inp.value; state.page = 0; state.resolveIdx = 0;
      rerender(); // the render restores focus/caret to the rebuilt box
    });
    return inp;
  }

  /** Header-level consider/ignore-all switch: one click applies to every record. */
  function masterToggleEl(rerender) {
    const c = considerCounts();
    const wrap = el("span", "master-toggle");
    const lab = el("label", "consider-toggle");
    const cb = el("input"); cb.type = "checkbox";
    // Reflects only the actionable (not-already-imported) rows, so 5 done rows
    // never prevent a clean "all considered" state.
    cb.checked = c.actionable > 0 && c.actionableConsidered === c.actionable;
    cb.indeterminate = c.actionableConsidered > 0 && c.actionableConsidered < c.actionable;
    cb.setAttribute("aria-label", "Consider or ignore all records not yet imported");
    lab.title = cb.checked
      ? "Ignore every record. Nothing will be imported until you turn some back on"
      : "Mark every record not already imported for import";
    cb.addEventListener("change", () => {
      const v = cb.checked;
      // Only touch not-already-imported rows; done rows stay out of the re-import.
      state.rows.forEach((r) => { if (!priorImported(r)) r.consider = v; });
      // Ignoring everything shouldn't empty the screen: keep rows visible so the
      // user can selectively re-enable individual records.
      if (!v) state.showIgnored = true;
      state.page = 0; state.resolveIdx = 0; rerender();
    });
    const track = el("span", "ct-track"); track.append(el("span", "ct-knob"));
    lab.append(cb, track);
    const capt = el("span", "mono dim", "Consider all");
    capt.title = lab.title;
    wrap.append(capt, lab);
    return wrap;
  }

  /** "Show ignored (N)" / "Hide ignored (N)" - ignored rows are hidden by default. */
  function showIgnoredBtn(rerender) {
    const c = considerCounts();
    const b = el("button", "chip-btn show-ignored-btn"); b.type = "button";
    b.textContent = state.showIgnored ? `Hide ignored (${c.ignored})` : `Show ignored (${c.ignored})`;
    b.title = state.showIgnored
      ? "Hide the records you are not importing, so only the ones you are keeping stay in view"
      : "Reveal the records you are not importing, so you can turn some back on";
    if (!c.ignored && !state.showIgnored) b.disabled = true;
    b.addEventListener("click", () => { state.showIgnored = !state.showIgnored; state.page = 0; state.resolveIdx = 0; rerender(); });
    return b;
  }

  /** "Hide imported (N)" / "Show imported (N)" - hides rows already imported in a
   *  prior run (orbit_status). Only meaningful when re-importing a results file. */
  function hideImportedBtn(rerender) {
    const n = importedCount();
    const b = el("button", "chip-btn"); b.type = "button";
    b.textContent = state.hideImported ? `Show imported (${n})` : `Hide imported (${n})`;
    b.title = state.hideImported
      ? "List the rows that were already imported in an earlier run"
      : "Hide the rows already imported in an earlier run, so you can work through the rest";
    b.addEventListener("click", () => { state.hideImported = !state.hideImported; state.page = 0; state.resolveIdx = 0; rerender(); });
    return b;
  }

  /** The triage toolbar shown above both the Review and Resolve headers. */
  function triageToolbar(rerender) {
    const bar = el("div", "triage-toolbar");
    bar.append(showIgnoredBtn(rerender));
    if (importedCount()) bar.append(hideImportedBtn(rerender));
    return bar;
  }

  /** Human-friendly explanation of a row's problems, for the warning popup. */
  function describeIssues(issues) {
    const lines = [];
    for (const mm of issues.missing) {
      lines.push(mm === "relationship" ? "Choose a relationship type"
        : mm === "related contact" ? "Pick who they're related to"
        : mm === "kinship" ? "Choose the kinship role (family)"
        : mm === "gender" ? "Set gender (Male/Female)"
        : mm === "name" ? "Name is required"
        : `Missing ${mm}`);
    }
    for (const iv of issues.invalid) {
      lines.push(iv === "birthday" ? "Birthday must be DD/MM/YYYY or YYYY-MM-DD"
        : iv === "gender" ? "Gender must be Male or Female"
        : iv === "email" ? "Email address looks invalid"
        : iv === "website" || iv === "linkedin" ? `${iv} must be a URL`
        : `Invalid ${iv}`);
    }
    return lines;
  }

  // Custom hover popup (native title tooltips are slow and styled by the OS
  // and would be clipped by the table's scroll container).
  let warnTipEl = null;
  function showWarnTip(anchor, lines) {
    if (!warnTipEl) { warnTipEl = el("div", "warn-tip"); document.body.append(warnTipEl); }
    warnTipEl.innerHTML = "";
    for (const line of lines) warnTipEl.append(el("div", null, line));
    warnTipEl.hidden = false;
    const r = anchor.getBoundingClientRect();
    warnTipEl.style.left = `${Math.round(r.left)}px`;
    warnTipEl.style.top = `${Math.round(r.bottom + 6)}px`;
  }
  function hideWarnTip() { if (warnTipEl) warnTipEl.hidden = true; }

  function renderReview() {
    hideWarnTip();
    state.activeRender = renderReview;
    const searchCaret = captureSearchFocus();
    content.innerHTML = ""; m.foot.innerHTML = "";
    if (!state.rows.length) {
      content.append(el("p", "dim", "No rows left to import."));
      const back = el("button", null, "Back"); back.type = "button";
      back.title = "Go back and choose a different file";
      back.addEventListener("click", reviewBack);
      m.foot.append(back);
      return;
    }
    // Toolbar above the header: reveal ignored / hide already-imported rows.
    content.append(triageToolbar(renderReview));

    const head = el("div", "review-head");
    head.append(masterToggleEl(renderReview), el("span", "mono dim", `${state.rows.length} rows`), searchInput(renderReview));
    const filter = el("label", "review-filter");
    filter.title = "Show only the rows you are importing that are still missing something or have an invalid value";
    const cb = el("input"); cb.type = "checkbox"; cb.checked = state.incompleteOnly;
    cb.addEventListener("change", () => { state.incompleteOnly = cb.checked; state.page = 0; renderReview(); });
    filter.append(cb, el("span", null, "Only rows needing attention"));
    head.append(filter);
    const modeWrap = el("span", "review-mode");
    const modeLbl = el("span", "mono dim", "Resolve matches:");
    modeLbl.title = "How you will work through possible duplicates in the next step";
    modeWrap.append(modeLbl, modeToggleEl(renderReview));
    head.append(modeWrap);
    content.append(head);
    // Triage tally: for consideration / complete / need attention / ignored.
    content.append(el("div", "rv-stats"));
    refreshCounts();

    const visible = new Set(visibleIndices());
    const items = state.rows.map((row, idx) => ({ row, idx }))
      .filter(({ idx, row }) => visible.has(idx) && nameMatch(row) && (!state.incompleteOnly || (row.consider !== false && !rowIssues(row).complete)));
    const pageSize = fitPageSize(state.reviewRowPx || 66, 92); // thead + pager reserve
    const pages = Math.max(1, Math.ceil(items.length / pageSize));
    if (state.page >= pages) state.page = pages - 1;
    const slice = items.slice(state.page * pageSize, state.page * pageSize + pageSize);

    const wrap = el("div", "review-table-wrap");
    const table = el("table", "review-table");
    const thead = el("tr");
    const cols = [["", ""], ["name", "name"], ["gender", "gender"], ["relationship", "reltype"],
      ["relationship to", "related"], ["kinship", "kinship"], ["location", "location"],
      ...DETAIL_FIELDS.map((f) => [f, f]), ["tags", "tags"]];
    for (const [label, key] of cols) {
      const th = el("th");
      if (COLUMN_HINT[key]) th.title = COLUMN_HINT[key];
      th.append(el("div", null, label || " "));
      if (FORMAT_HINT[key]) th.append(el("div", "th-hint mono", FORMAT_HINT[key]));
      thead.append(th);
    }
    table.append(thead);
    for (const { row, idx } of slice) table.append(makeRow(row, idx));
    wrap.append(table);
    content.append(wrap);

    if (pages > 1) {
      const pager = el("div", "review-pager");
      const prev = el("button", null, "‹ Prev"); prev.type = "button"; prev.disabled = state.page === 0;
      prev.title = "Previous page of rows. Your edits are kept";
      prev.addEventListener("click", () => { state.page--; renderReview(); });
      const next = el("button", null, "Next ›"); next.type = "button"; next.disabled = state.page >= pages - 1;
      next.title = "Next page of rows. Your edits are kept";
      next.addEventListener("click", () => { state.page++; renderReview(); });
      pager.append(prev, el("span", "mono dim", `Page ${state.page + 1} / ${pages}`), next);
      content.append(pager);
    }
    refitPage(".review-row", "reviewRowPx");

    const back = el("button", null, "Back"); back.type = "button";
    back.title = state.kind === "csv" ? "Return to column mapping" : "Choose a different file";
    back.addEventListener("click", reviewBack);
    const cont = el("button", "primary", "Continue"); cont.type = "button";
    cont.title = "Go on to check the records you marked against your existing contacts. Nothing is written yet";
    cont.addEventListener("click", () => {
      // Opt-in: nothing imports unless the user turned it on.
      if (!state.rows.some((r) => r.consider !== false)) {
        toast("Turn on the records you want to import first (or use Consider all)."); return;
      }
      // Only records marked for consideration must be valid; the rest are skipped.
      if (state.rows.some((r) => r.consider !== false && !String(r.name || "").trim())) {
        toast("Every selected row needs a name."); return;
      }
      stepResolve();
    });
    m.foot.append(back, cont);
    restoreSearchFocus(searchCaret);
  }

  /** Phone editor for a review row: a country dropdown (the same list the
   *  contact card uses) plus the national number. Writes a standardized
   *  "+<dial> <grouped>" string back to row.fields.phone on every change. */
  function makePhoneCell(row) {
    const wrap = el("div", "rv-phone");
    const sel = el("select", "rv-phone-country");
    sel.title = "Country dialling code. Changing it regroups the number below";
    for (const c of COUNTRIES) sel.append(new Option(`${flagEmoji(c.iso2)} ${c.name} (+${c.dial})`, c.iso2));
    const num = el("input", "rv-in rv-phone-num");
    num.type = "tel"; num.placeholder = "number";
    num.title = "The national number, without the country code";
    num.setAttribute("aria-label", "Phone number");

    const parsed = normalizePhone(row.fields.phone, { defaultIso: DEFAULT_PHONE_ISO });
    if (parsed) { sel.value = parsed.iso2; num.value = groupNational(parsed.iso2, parsed.national); }
    else { sel.value = DEFAULT_PHONE_ISO; num.value = row.fields.phone ?? ""; } // unparseable: show as-is

    const sync = () => {
      const digits = num.value.replace(/\D/g, "");
      row.fields.phone = digits ? `+${dialOf(sel.value)} ${groupNational(sel.value, digits)}` : "";
    };
    num.addEventListener("input", sync);
    sel.addEventListener("change", () => {
      const digits = num.value.replace(/\D/g, "");
      num.value = groupNational(sel.value, digits); // regroup for the new country
      sync();
    });
    wrap.append(sel, num);
    return wrap;
  }

  function makeRow(row, idx) {
    const tr = el("tr", "review-row" + (row.consider === false ? " row-ignored" : ""));
    const statusTd = el("td", "review-status");
    // Update in place while marking (smooth); only re-render if the row must
    // leave the list (i.e. it became ignored while ignored rows are hidden).
    const toggle = considerToggle(row, () => {
      const nowIgnored = row.consider === false;
      if (!state.showIgnored && nowIgnored) { renderReview(); return; }
      tr.classList.toggle("row-ignored", nowIgnored);
      refreshCounts();
      refreshMasterToggle();
    });
    const statusIcon = el("span", "status-icon");
    statusTd.append(toggle, statusIcon);
    const kinTd = el("td", "review-kin");
    const nameInput = el("input", "rv-in rv-name"); nameInput.value = row.name;
    nameInput.title = COLUMN_HINT.name;

    const updateStatus = () => {
      const issues = rowIssues(row);
      statusIcon.innerHTML = "";
      if (issues.complete) {
        const ok = el("span", "row-ok", "✓");
        ok.title = "This row has everything it needs";
        statusIcon.append(ok);
      } else {
        const w = el("span", "row-warn", "⚠");
        // Native title tooltips are slow and OS-styled - use a custom popup.
        w.addEventListener("mouseenter", () => showWarnTip(w, describeIssues(rowIssues(row))));
        w.addEventListener("mouseleave", hideWarnTip);
        statusIcon.append(w);
      }
      nameInput.classList.toggle("invalid", issues.missing.includes("name"));
      refreshCounts();
    };
    const rebuildKin = () => {
      kinTd.innerHTML = "";
      kinTd.append(kinshipSelect(row, updateStatus));
    };

    // name
    nameInput.addEventListener("input", () => { row.name = nameInput.value; });
    nameInput.addEventListener("blur", updateStatus);
    const nameTd = el("td"); nameTd.append(nameInput);

    // gender
    const gsel = el("select", "rv-in");
    gsel.title = COLUMN_HINT.gender;
    for (const opt of ["", "Male", "Female"]) gsel.append(new Option(opt || "—", opt));
    gsel.value = ["Male", "Female"].includes(normGender(row.gender)) ? normGender(row.gender) : "";
    gsel.addEventListener("change", () => { row.gender = gsel.value; row.rel.role = ""; rebuildKin(); updateStatus(); });
    const gTd = el("td"); gTd.append(gsel);

    // relationship type (like the sidebar: colleague/friend/family/...)
    const tsel = el("select", "rv-in");
    tsel.title = COLUMN_HINT.reltype;
    tsel.append(new Option("—", ""));
    for (const t of EDGE_TYPES) tsel.append(new Option(t, t));
    tsel.value = row.rel.type || "";
    tsel.addEventListener("change", () => {
      row.rel.type = tsel.value;
      if (row.rel.type !== "family") { row.rel.role = ""; row.rel.recip = null; } // kinship is family-only
      rebuildKin(); updateStatus();
    });
    const tTd = el("td"); tTd.append(tsel);

    // related-to (autocomplete)
    const relTd = relatedCell(row, idx, () => { rebuildKin(); updateStatus(); });

    // location
    const locTd = locationCell(row);

    tr.append(statusTd, nameTd, gTd, tTd, relTd, kinTd, locTd);
    rebuildKin();

    // detail fields
    for (const f of DETAIL_FIELDS) {
      const td = el("td");
      if (f === "phone") {
        td.append(makePhoneCell(row));
      } else {
        const inp = el("input", `rv-in rv-f-${f}`); inp.value = row.fields[f] ?? "";
        inp.title = FORMAT_HINT[f] ? `${f} · ${FORMAT_HINT[f]}` : f;
        inp.addEventListener("input", () => { row.fields[f] = inp.value; });
        inp.addEventListener("blur", () => { const iss = rowIssues(row); inp.classList.toggle("invalid", iss.invalid.includes(f)); updateStatus(); });
        td.append(inp);
      }
      tr.append(td);
    }
    // tags
    const tagIn = el("input", "rv-in"); tagIn.value = (row.tags || []).join(";");
    tagIn.title = COLUMN_HINT.tags;
    tagIn.addEventListener("input", () => { row.tags = tagIn.value.split(/[;,]/).map((t) => t.trim().toLowerCase()).filter(Boolean); });
    const tagTd = el("td"); tagTd.append(tagIn); tr.append(tagTd);

    updateStatus();
    return tr;
  }

  /** Kinship <select>: family only. Roles by THIS person's gender; "is <related>'s …". */
  function kinshipSelect(row, onChange) {
    const wrap = el("div", "kin-wrap");
    const isFamily = row.rel.type === "family";
    const hasRelated = row.rel.existingId != null || row.rel.batchIndex != null;
    const sel = el("select", "rv-in");
    sel.disabled = !isFamily || !normGender(row.gender) || !hasRelated;
    sel.title = !isFamily ? "Kinship applies to family relationships only"
      : !normGender(row.gender) ? "Set a gender first: the roles offered depend on it"
      : !hasRelated ? "Pick who they are related to first"
      : COLUMN_HINT.kinship;
    sel.append(new Option("—", ""));
    if (isFamily && normGender(row.gender)) for (const r of kinRolesFor(row.gender)) sel.append(new Option(r, r));
    if (isFamily && row.rel.role && !kinRolesFor(row.gender).includes(row.rel.role)) sel.append(new Option(row.rel.role, row.rel.role));
    sel.value = isFamily ? (row.rel.role || "") : "";
    sel.addEventListener("change", () => {
      row.rel.role = sel.value;
      row.rel.recip = sel.value ? reciprocalRole(sel.value, row.rel.relatedGender) : null;
      onChange();
    });
    wrap.append(sel);
    if (!isFamily) wrap.append(el("div", "kin-hint mono dim", "family only"));
    else if (row.rel.role && row.rel.relatedName) {
      // Both directions, so a reversed role is obvious (uses the stored reciprocal).
      wrap.append(el("div", "kin-hint mono dim", kinPreview({
        selfName: row.name, otherName: row.rel.relatedName,
        role: row.rel.role, otherGender: row.rel.relatedGender,
      })));
    }
    return wrap;
  }

  /** Related-to autocomplete: match existing contacts + other rows in the batch. */
  function relatedCell(row, idx, onChange) {
    const td = el("td", "review-rel");
    const wrap = el("div", "rel-wrap");
    const input = el("input", "rv-in"); input.placeholder = "name…"; input.value = row.rel?.relatedName ?? "";
    input.title = COLUMN_HINT.related;
    const menu = el("div", "rel-menu"); menu.hidden = true;
    const clearRelated = () => {
      row.rel.relatedName = ""; row.rel.relatedGender = "";
      row.rel.existingId = undefined; row.rel.batchIndex = undefined;
    };
    const pick = (cand) => {
      row.rel.relatedName = cand.name; row.rel.relatedGender = cand.gender;
      row.rel.existingId = cand.id; row.rel.batchIndex = cand.index;
      // keep an existing kinship role if still valid for this gender; recompute reciprocal
      if (!kinRolesFor(row.gender).includes(row.rel.role)) row.rel.role = "";
      row.rel.recip = row.rel.role ? reciprocalRole(row.rel.role, cand.gender) : null;
      input.value = cand.name; menu.hidden = true; onChange();
    };
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (row.rel.existingId != null || row.rel.batchIndex != null) { clearRelated(); onChange(); }
      if (q.length < 1) { menu.hidden = true; return; }
      const cands = [];
      state.existing.forEach((c) => { if (c.name.toLowerCase().includes(q)) cands.push({ name: c.name, gender: c.gender, id: c.id }); });
      state.rows.forEach((r, i) => { if (i !== idx && r.name && r.name.toLowerCase().includes(q)) cands.push({ name: r.name, gender: normGender(r.gender), index: i, batch: true }); });
      menu.innerHTML = "";
      cands.slice(0, 8).forEach((cand) => {
        const b = el("button", "rel-opt"); b.type = "button";
        b.title = cand.batch
          ? `${cand.name} is another row in this file. They will be linked once both are imported`
          : `${cand.name} is an existing contact`;
        b.append(el("span", null, cand.name));
        if (cand.batch) b.append(el("span", "rel-tag mono dim", "in this file"));
        b.addEventListener("mousedown", (e) => { e.preventDefault(); pick(cand); });
        menu.append(b);
      });
      menu.hidden = cands.length === 0;
    });
    input.addEventListener("blur", () => setTimeout(() => { menu.hidden = true; }, 150));
    wrap.append(input, menu);
    td.append(wrap);
    return td;
  }

  /** Location: sidebar-style geocode search + map pin; stores place/geo/components. */
  function locationCell(row) {
    const td = el("td", "review-loc");
    const wrap = el("div", "loc-wrap");
    const input = el("input", "rv-in"); input.placeholder = "city / address"; input.value = row.fields.location || row.fields.place || "";
    input.title = COLUMN_HINT.location;
    const menu = el("div", "loc-menu"); menu.hidden = true;
    const pin = el("button", "loc-pin"); pin.type = "button"; pin.textContent = "📍";
    pin.title = "Pick the exact spot on the map instead of searching for it";
    pin.setAttribute("aria-label", pin.title);
    let timer = null;
    const setLoc = (mt) => {
      row.fields.location = mt.label || mt.place; row.fields.place = mt.place || mt.label;
      row.fields.geo = `${mt.lat},${mt.lon}`;
      row.fields.locationResolved = JSON.stringify({ v: 1, components: mt.components || {}, osm: mt.osm });
      row.fields.locationPrecision = mt.precision || "place"; row.fields.locationSource = mt.source || "photon";
      input.value = row.fields.location; menu.hidden = true;
    };
    input.addEventListener("input", () => {
      row.fields.location = input.value.trim();
      for (const k of ["place", "geo", "locationResolved", "locationPrecision", "locationSource"]) delete row.fields[k];
      if (timer) clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { menu.hidden = true; return; }
      timer = setTimeout(async () => {
        try {
          const matches = await api().location.search({ query: q });
          menu.innerHTML = "";
          matches.slice(0, 6).forEach((mt) => {
            const b = el("button", "loc-opt"); b.type = "button"; b.textContent = mt.label;
            b.title = `Map to ${mt.label} at ${mt.precision || "place"} level`;
            b.addEventListener("mousedown", (e) => { e.preventDefault(); setLoc(mt); });
            menu.append(b);
          });
          menu.hidden = matches.length === 0;
        } catch { menu.hidden = true; }
      }, 300);
    });
    input.addEventListener("blur", () => setTimeout(() => { menu.hidden = true; }, 150));
    pin.addEventListener("click", async () => {
      const initial = row.fields.geo ? { lat: +row.fields.geo.split(",")[0], lon: +row.fields.geo.split(",")[1] } : null;
      const point = await pickLocationOnMap(initial, row.name);
      if (point) {
        row.fields.geo = `${point.lat},${point.lon}`;
        if (!row.fields.location) { row.fields.location = `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`; input.value = row.fields.location; }
      }
    });
    wrap.append(input, pin, menu);
    td.append(wrap);
    return td;
  }

  function buildRecord(row) {
    const fields = {};
    const g = normGender(row.gender); if (g === "Male" || g === "Female") fields.gender = g;
    // A business tie (vendor) marks the contact as one: no gender ring, no
    // kinship, and no gender even if the column carried one.
    if (BUSINESS_TYPES.has(row.rel?.type)) { fields.business = "yes"; delete fields.gender; }
    const b = normBirthday(row.fields.birthday); if (b.ok && b.iso) fields.birthday = b.iso;
    for (const k of ["email", "phone", "company", "role", "nickname", "website", "linkedin", "notes"]) {
      const val = String(row.fields[k] || "").trim();
      if (val && !((k === "email" && !looksEmail(val)) || ((k === "website" || k === "linkedin") && !looksUrl(val)))) fields[k] = val;
    }
    for (const k of ["location", "place", "geo", "locationResolved", "locationPrecision", "locationSource"]) {
      if (row.fields[k]) fields[k] = row.fields[k];
    }
    const rec = { name: row.name.trim(), fields, tags: row.tags || [] };
    const rel = row.rel;
    const hasRelated = rel.existingId != null || rel.batchIndex != null;
    if (rel.type && hasRelated) {
      rec.rel = { type: rel.type, existingId: rel.existingId, batchIndex: rel.batchIndex };
      if (rel.type === "family" && rel.role) { rec.rel.role = rel.role; rec.rel.recip = rel.recip ?? null; }
    }
    return rec;
  }

  // ---- step (CSV/vCard): resolve duplicates + per-record decisions ----
  // The user is master of every record: match hints are advisory and nothing is
  // written until they confirm. Two modes: an all-at-once table, or one-at-a-time.
  const STRONG = 0.95;          // score at/above which a match is pre-selected for merge
  const STATUS_LABEL = { strong: "Likely duplicate", weak: "Possible match", infile: "Duplicate in file", new: "New" };
  const STATUS_HINT = {
    strong: "A very close match to an existing contact, so merging is pre-selected. You can still override it",
    weak: "Resembles an existing contact, but not closely enough to assume. Importing as new is pre-selected",
    infile: "Another row in this same file looks like the same person",
    new: "No existing contact resembles this record",
  };
  const chipEl = (st) => {
    const chip = el("span", "resolve-chip chip-" + st, STATUS_LABEL[st]);
    chip.title = STATUS_HINT[st];
    return chip;
  };

  const priorStatus = (row) => String(row.fields?.orbit_status || "").trim().toLowerCase();

  function statusOf(i) {
    const res = state.match[i] || { candidates: [], inFileDup: [] };
    if (res.candidates[0]?.score >= STRONG) return "strong";
    if (res.candidates.length) return "weak";
    if (res.inFileDup.length) return "infile";
    return "new";
  }

  function initDecisions() {
    // A decision is what to do with a CONSIDERED record (new vs merge). Whether a
    // record is processed at all is the separate `row.consider` flag (set from the
    // per-row toggle, and pre-set to ignore for re-imported already-imported rows).
    state.decisions = state.rows.map((_row, i) => {
      const top = state.match[i]?.candidates[0];
      return top && top.score >= STRONG ? { mode: "merge", targetId: top.contactId } : { mode: "new" };
    });
  }

  function stepResolve() {
    setStep("Resolve");
    state.page = 0; state.resolveIdx = 0; state.resolveFilter = "all";
    content.append(el("p", "dim", "Checking for existing contacts…"));
    const records = state.rows.map((row) => buildRecord(row));
    api().data.importMatch({ records }).then(({ results }) => {
      state.match = results; initDecisions(); renderResolve();
    }).catch((err) => {
      // Matching is advisory; if it fails, still let the user import.
      toastError(err);
      state.match = state.rows.map(() => ({ candidates: [], inFileDup: [] }));
      initDecisions(); renderResolve();
    });
  }

  function resolveSummary() {
    let nnew = 0, merge = 0, ignore = 0;
    state.rows.forEach((row, i) => {
      if (row.consider === false) { ignore++; return; }
      if (state.decisions[i].mode === "merge") merge++; else nnew++;
    });
    return { nnew, merge, ignore };
  }

  /** Update the summary line + footer count without a full re-render. */
  function refreshResolveChrome() {
    const s = resolveSummary();
    const sumEl = content.querySelector(".resolve-sum");
    if (sumEl) sumEl.textContent = `${s.nnew} new · ${s.merge} merge · ${s.ignore} ignore`;
    const go = m.foot.querySelector("button.primary");
    if (go) go.textContent = `Import ${s.nnew + s.merge}`;
  }

  /** The persisted "All at once / One at a time" segmented control, shared by the
   *  Review and Resolve steps. `rerender` refreshes whichever step is showing it. */
  function modeToggleEl(rerender) {
    const modes = el("div", "resolve-modes");
    const MODE_TITLES = {
      batch: "Review every record in one list, each with a dropdown decision",
      single: "Step through the records you are importing one at a time, with full detail on each match",
    };
    for (const [mode, label] of [["batch", "All at once"], ["single", "One at a time"]]) {
      const b = el("button", "resolve-mode" + (state.resolveMode === mode ? " active" : ""));
      b.type = "button"; b.textContent = label; b.title = MODE_TITLES[mode];
      b.addEventListener("click", () => { state.resolveMode = mode; localStorage.setItem("orbit-import-mode", mode); rerender(); });
      modes.append(b);
    }
    return modes;
  }

  function renderResolve() {
    hideWarnTip();
    state.activeRender = renderResolve;
    const searchCaret = captureSearchFocus();
    content.innerHTML = ""; m.foot.innerHTML = "";
    content.append(triageToolbar(renderResolve));
    const head = el("div", "resolve-head");
    const s = resolveSummary();
    head.append(masterToggleEl(renderResolve), modeToggleEl(renderResolve), el("div", "resolve-sum mono dim", `${s.nnew} new · ${s.merge} merge · ${s.ignore} ignore`));
    content.append(head);

    if (state.resolveMode === "single") renderResolveSingle();
    else renderResolveBatch();

    const back = el("button", null, "Back"); back.type = "button";
    back.title = "Return to the review table to change the records or their details";
    back.addEventListener("click", renderReview);
    const go = el("button", "primary", `Import ${s.nnew + s.merge}`); go.type = "button";
    go.title = `Write ${s.nnew} new contact${s.nnew === 1 ? "" : "s"} and merge ${s.merge}. A backup snapshot is taken first`;
    go.addEventListener("click", runRecords);
    m.foot.append(back, go);
    restoreSearchFocus(searchCaret);
  }

  /** One existing candidate's reasons, fields, and current connections (context). */
  function candidateDetail(c) {
    const box = el("div", "cand-detail");
    box.append(el("div", "cand-reasons mono dim", c.reasons.join(", ")));
    const meta = [c.company, c.email, c.phone].filter(Boolean).join(" · ");
    if (meta) box.append(el("div", "cand-meta mono dim", meta));
    if (c.connections.length)
      box.append(el("div", "cand-conns mono dim", "Connected to " + c.connections.map((x) => `${x.name} (${x.type})`).join(", ")));
    return box;
  }

  function priorBadge(row) {
    const p = priorStatus(row);
    if (!p) return null;
    const badge = el("span", "prior-badge prior-" + p, p === "ignored" ? "was ignored" : `was ${p}`);
    badge.title = p === "ignored"
      ? "This row was skipped on an earlier run of this file. You can import it now"
      : `This row was already ${p} on an earlier run of this file`;
    return badge;
  }

  function renderResolveBatch() {
    const bar = el("div", "resolve-bulk");
    const mkBulk = (label, fn, title) => { const b = el("button", "chip-btn"); b.type = "button"; b.textContent = label; b.title = title; b.addEventListener("click", () => { fn(); renderResolve(); }); bar.append(b); };
    mkBulk("Merge strong matches", () => state.decisions.forEach((_d, i) => { const t = state.match[i]?.candidates[0]; if (t && t.score >= STRONG) state.decisions[i] = { mode: "merge", targetId: t.contactId }; }),
      "Set every record with a near-certain match to merge into that contact");
    mkBulk("All as new", () => { state.decisions = state.decisions.map(() => ({ mode: "new" })); },
      "Create a fresh contact for every record, merging nothing");
    mkBulk("Ignore all matches", () => state.rows.forEach((row, i) => { if (statusOf(i) !== "new") row.consider = false; }),
      "Skip every record that looks like a duplicate, importing only the genuinely new ones");
    const fsel = el("select", "resolve-filter");
    fsel.title = "Narrow the list below. This changes what you see, not what will be imported";
    for (const [v, l] of [["all", "All rows"], ["dup", "Only possible matches"], ["new", "Only new"]]) fsel.append(new Option(l, v));
    fsel.value = state.resolveFilter; fsel.addEventListener("change", () => { state.resolveFilter = fsel.value; state.page = 0; renderResolve(); });
    bar.append(searchInput(renderResolve), fsel);
    content.append(bar);

    const visible = new Set(visibleIndices());
    const items = state.rows.map((row, idx) => ({ row, idx })).filter(({ idx, row }) => {
      if (!visible.has(idx) || !nameMatch(row)) return false;
      if (state.resolveFilter === "dup") return statusOf(idx) !== "new";
      if (state.resolveFilter === "new") return statusOf(idx) === "new";
      return true;
    });
    const pageSize = fitPageSize(state.resolveRowPx || 96, 52); // cards vary; refit shrinks to fit
    const pages = Math.max(1, Math.ceil(items.length / pageSize));
    if (state.page >= pages) state.page = pages - 1;
    const slice = items.slice(state.page * pageSize, state.page * pageSize + pageSize);
    const list = el("div", "resolve-list");
    for (const { row, idx } of slice) list.append(resolveBatchRow(row, idx));
    content.append(list);

    if (pages > 1) {
      const pager = el("div", "review-pager");
      const prev = el("button", null, "‹ Prev"); prev.type = "button"; prev.disabled = state.page === 0;
      prev.title = "Previous page of records. Your decisions are kept";
      prev.addEventListener("click", () => { state.page--; renderResolve(); });
      const next = el("button", null, "Next ›"); next.type = "button"; next.disabled = state.page >= pages - 1;
      next.title = "Next page of records. Your decisions are kept";
      next.addEventListener("click", () => { state.page++; renderResolve(); });
      pager.append(prev, el("span", "mono dim", `Page ${state.page + 1} / ${pages}`), next);
      content.append(pager);
    }
    refitPage(".resolve-row", "resolveRowPx");
  }

  function resolveBatchRow(row, idx) {
    const res = state.match[idx] || { candidates: [], inFileDup: [] };
    const st = statusOf(idx);
    const ignored = row.consider === false;
    const card = el("div", "resolve-row " + (ignored ? "row-ignored" : "decided-" + state.decisions[idx].mode));
    const topRow = el("div", "resolve-row-top");
    const left = el("div", "resolve-row-id");
    left.append(considerToggle(row, () => renderResolve()));
    left.append(el("span", "resolve-name", row.name || "(no name)"));
    left.append(chipEl(st));
    const pb = priorBadge(row); if (pb) left.append(pb);
    topRow.append(left);
    if (ignored) {
      topRow.append(el("span", "resolve-ignored-tag mono dim", "ignored"));
    } else {
      const sel = el("select", "resolve-decision");
      sel.title = "What to do with this record: create a new contact, or fold it into an existing one";
      sel.append(new Option("Import as new", "new"));
      for (const c of res.candidates) sel.append(new Option(`Merge into ${c.name} (${Math.round(c.score * 100)}%)`, "merge:" + c.contactId));
      const d = state.decisions[idx];
      sel.value = d.mode === "merge" ? "merge:" + d.targetId : "new";
      sel.addEventListener("change", () => {
        state.decisions[idx] = sel.value.startsWith("merge:") ? { mode: "merge", targetId: +sel.value.slice(6) } : { mode: "new" };
        card.className = "resolve-row decided-" + state.decisions[idx].mode;
        refreshResolveChrome();
      });
      topRow.append(sel);
    }
    card.append(topRow);
    if (!ignored && res.candidates.length) {
      const cands = el("div", "resolve-cands");
      for (const c of res.candidates) cands.append(candidateDetail(c));
      card.append(cands);
    } else if (!ignored && res.inFileDup.length) {
      card.append(el("div", "resolve-note mono dim", "Matches another row in this file: " + res.inFileDup.map((j) => state.rows[j]?.name).filter(Boolean).join(", ")));
    }
    return card;
  }

  function renderResolveSingle() {
    const vis = consideredIndices();
    if (!vis.length) {
      content.append(el("div", "single-ignored mono dim", "No records marked for consideration. Turn some records on (or use All at once) to review them here."));
      return;
    }
    const pos = Math.max(0, Math.min(state.resolveIdx, vis.length - 1));
    state.resolveIdx = pos;
    const i = vis[pos];
    const row = state.rows[i];
    const res = state.match[i] || { candidates: [], inFileDup: [] };
    const d = state.decisions[i];

    const nav = el("div", "single-nav");
    const prev = el("button", null, "‹ Prev"); prev.type = "button"; prev.disabled = pos === 0;
    prev.title = "Back to the previous record. Your decision is kept";
    prev.addEventListener("click", () => { state.resolveIdx = pos - 1; renderResolve(); });
    const next = el("button", null, "Next ›"); next.type = "button"; next.disabled = pos >= vis.length - 1;
    next.title = "On to the next record. Your decision is kept";
    next.addEventListener("click", () => { state.resolveIdx = pos + 1; renderResolve(); });
    nav.append(prev, el("span", "single-count mono", `${pos + 1} of ${vis.length}`), next);
    content.append(nav);

    const rec = buildRecord(row);
    const inc = el("div", "single-incoming");
    const nline = el("div", "single-nameline");
    nline.append(considerToggle(row, () => renderResolve()));
    nline.append(el("span", "single-name", row.name || "(no name)"), chipEl(statusOf(i)));
    const pb = priorBadge(row); if (pb) nline.append(pb);
    inc.append(nline);
    const nmeta = [rec.fields.company, rec.fields.email, rec.fields.phone].filter(Boolean).join(" · ");
    if (nmeta) inc.append(el("div", "single-meta mono dim", nmeta));
    content.append(inc);

    if (row.consider === false) {
      content.append(el("div", "single-ignored mono dim", "Ignored - this record will not be imported. Toggle it on to choose an action."));
      return;
    }

    const choose = (dec) => { state.decisions[i] = dec; renderResolve(); };
    const group = el("div", "single-choices");
    const mkChoice = (checked, mainEl, subEl, onPick, title) => {
      const lab = el("label", "cand-opt" + (checked ? " selected" : ""));
      if (title) lab.title = title;
      const radio = el("input"); radio.type = "radio"; radio.name = "single-dec"; radio.checked = checked;
      radio.addEventListener("change", onPick);
      const body = el("div", "cand-body"); body.append(mainEl); if (subEl) body.append(subEl);
      lab.append(radio, body); return lab;
    };
    for (const c of res.candidates) {
      const checked = d.mode === "merge" && d.targetId === c.contactId;
      const main = el("div", "cand-main");
      main.append(el("span", "cand-name", `Merge into ${c.name}`), el("span", "cand-score mono", `${Math.round(c.score * 100)}%`));
      group.append(mkChoice(checked, main, candidateDetail(c), () => choose({ mode: "merge", targetId: c.contactId }),
        `Fold this record into ${c.name}, filling their blanks without overwriting what they already have`));
    }
    // A manually-linked target that isn't among the auto candidates.
    if (d.mode === "merge" && !res.candidates.some((c) => c.contactId === d.targetId)) {
      const ex = state.existing.find((c) => c.id === d.targetId);
      if (ex) group.append(mkChoice(true, el("span", "cand-name", `Merge into ${ex.name} (linked)`), null, () => {}));
    }
    group.append(mkChoice(d.mode === "new", el("span", "cand-name", "Import as a new contact"), null, () => choose({ mode: "new" }),
      "Create a separate contact, leaving any similar ones untouched"));
    content.append(group);
    content.append(manualLinkRow(i));
  }

  /** Link a record to any existing contact by hand (beyond the auto candidates). */
  function manualLinkRow(i) {
    const wrap = el("div", "manual-link");
    const caption = el("span", "mono dim", "Or link to a specific contact:");
    caption.title = "Merge into a contact Orbit did not suggest, when you know they are the same person";
    wrap.append(caption);
    const box = el("div", "rel-wrap");
    const input = el("input", "rv-in"); input.placeholder = "search contacts…";
    input.title = "Search all your contacts and merge this record into the one you pick";
    const menu = el("div", "rel-menu"); menu.hidden = true;
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { menu.hidden = true; return; }
      const cands = state.existing.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
      menu.innerHTML = "";
      for (const c of cands) {
        const b = el("button", "rel-opt"); b.type = "button"; b.textContent = c.name;
        b.title = `Merge this record into ${c.name}`;
        b.addEventListener("mousedown", (e) => { e.preventDefault(); state.decisions[i] = { mode: "merge", targetId: c.id }; menu.hidden = true; renderResolve(); });
        menu.append(b);
      }
      menu.hidden = cands.length === 0;
    });
    input.addEventListener("blur", () => setTimeout(() => { menu.hidden = true; }, 150));
    box.append(input, menu); wrap.append(box);
    return wrap;
  }

  /** A row's outcome for the results file. A row processed this run takes its
   *  decision (merge -> merged, otherwise imported). A row NOT considered this
   *  run keeps whatever it already achieved: a record imported/merged in a prior
   *  run stays imported/merged - the user merely chose not to RE-process it, and
   *  that must never regress its recorded outcome to "ignored". Only a record
   *  that was never imported before becomes "ignored". */
  const outcomeOf = (row, i) => {
    if (row.consider !== false) {
      return state.decisions[i].mode === "merge" ? "merged" : "imported";
    }
    const prior = String(row.fields?.orbit_status || "").trim().toLowerCase();
    if (prior === "imported" || prior === "merged") return prior;
    return "ignored";
  };

  /** Offer to write an annotated results file (CSV with an orbit_status column).
   *  Defaults to overwriting the source for CSV; a sidecar CSV for vCard. On a
   *  later re-import, Resolve reads orbit_status to show imported-vs-ignored and
   *  lets the user reconsider the ignored ones. Always user-initiated via a dialog. */
  async function saveResultsFile() {
    const rows = state.rows.map((row, i) => {
      const rec = buildRecord(row);
      return { name: rec.name, fields: rec.fields, tags: rec.tags || [], status: outcomeOf(row, i) };
    });
    try {
      // The bridge keeps only the base name for the download: a CSV import
      // yields a results file named like its source; vCard gets a sidecar CSV.
      const defaultName = state.kind === "csv" && state.srcPath
        ? state.srcPath
        : (state.srcPath ? state.srcPath.replace(/\.[^.]+$/, "") + "-orbit-results.csv" : "orbit-import-results.csv");
      const res = await api().dialogs.saveFile({ defaultName, filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!res?.path) return null;
      const out = await api().data.importWriteResults({ destPath: res.path, rows });
      toast(`Saved results for ${out.count} record${out.count === 1 ? "" : "s"}.`);
      return res.path;
    } catch (err) { toastError(err); return null; }
  }

  async function runRecords() {
    setStep("Import");
    content.append(el("p", null, "Importing… a backup snapshot was taken first."));
    try {
      const records = state.rows.map((row, i) => {
        const rec = buildRecord(row);
        if (row.consider === false) { rec.decision = { mode: "ignore" }; return rec; }
        const d = state.decisions?.[i];
        rec.decision = d?.mode === "merge" && d.targetId != null ? { mode: "merge", targetId: d.targetId } : { mode: "new" };
        return rec;
      });
      const report = await api().data.importRecords({ onDuplicate: state.onDuplicate, records });
      content.innerHTML = "";
      const grid = el("div", "report-grid");
      const RECORD_HINT = {
        imported: "Records created as new contacts",
        merged: "Records folded into an existing contact",
        ignored: "Records you chose not to import",
        relationships: "Connections created between contacts from this file",
      };
      for (const [label, value] of [["imported", report.imported], ["merged", report.merged],
        ["ignored", report.ignored ?? 0], ["relationships", report.relationships]]) {
        const cell = el("div");
        cell.title = RECORD_HINT[label];
        cell.append(el("div", "num", String(value)), el("div", "mono dim", label));
        grid.append(cell);
      }
      content.append(el("p", null, "Done."), grid);
      content.append(el("p", "dim", "Save a results file to remember what was imported vs ignored. “Save and reload” reopens this file with the imported rows hidden, so you can work through the remaining ones."));
      const save = el("button", null, "Save results file…"); save.type = "button";
      save.title = "Write a CSV with an orbit_status column recording what was imported, merged, or ignored";
      save.addEventListener("click", saveResultsFile);
      const reload = el("button", null, "Save and reload"); reload.type = "button";
      reload.title = "Save the results file, then reopen it here with the imported rows hidden so you can work through the rest";
      reload.addEventListener("click", async () => {
        const saved = await saveResultsFile();
        if (!saved) return;
        m.close();
        onDone();
        openImportWizard({ onDone, reloadPath: saved });
      });
      const close = el("button", "primary", "Close"); close.type = "button";
      close.title = "Finish and go back to Orbit with the imported contacts in place";
      close.addEventListener("click", () => { m.close(); onDone(); });
      m.foot.append(save, reload, close);
    } catch (err) {
      content.innerHTML = "";
      content.append(el("p", null, "The import failed and nothing was written."), el("p", "dim", err.message ?? String(err)));
      const back = el("button", null, "Back"); back.type = "button";
      back.title = "Return to your decisions and try again";
      back.addEventListener("click", () => renderResolve());
      m.foot.append(back);
    }
  }

  // ---- step 2 (vCard/archive): dedup policy ----
  function stepPolicy() {
    setStep("Review");
    content.append(el("p", null, `${state.preview.count} contacts ready. When one matches an existing contact:`));
    const options = /** @type {["skip" | "merge" | "keepBoth", string, string][]} */ ([
      ["skip", "Skip it - keep what I have",
        "The incoming record is dropped and your existing contact is left exactly as it is"],
      ["merge", "Merge - fill in my blanks, never overwrite",
        "Empty fields on your contact are filled from the incoming record. Nothing you already have is changed"],
      ["keepBoth", "Keep both - I'll review duplicates later",
        "Both contacts are created. Duplicates shows the pair so you can merge them when you are ready"],
    ]);
    for (const [value, label, hint] of options) {
      const row = el("label", "form-row");
      row.title = hint;
      const radio = el("input");
      radio.type = "radio";
      radio.name = "policy";
      radio.value = value;
      radio.checked = state.onDuplicate === value;
      radio.addEventListener("change", () => (state.onDuplicate = value));
      row.append(radio, el("span", null, label));
      content.append(row);
    }
    if (state.preview.sample?.length) {
      const ul = el("ul", "sample-list");
      for (const s of state.preview.sample) {
        ul.append(el("li", null, `${s.name}${s.fields.company ? ` · ${s.fields.company}` : ""}`));
      }
      content.append(el("p", "mono dim", "Preview:"), ul);
    }
    const run = el("button", "primary", `Import ${state.preview.count} contacts`);
    run.type = "button";
    run.title = "Write these contacts to your database. A backup snapshot is taken first";
    run.addEventListener("click", stepRun);
    m.foot.append(run);
  }

  // ---- step 3: run + report ----
  async function stepRun() {
    setStep("Import");
    content.append(el("p", null, "Importing… a backup snapshot was taken first."));
    try {
      const report =
        state.kind === "archive"
          ? await api().data.importArchive({
              srcPath: state.srcPath,
              passphrase: state.passphrase,
              onDuplicate: state.onDuplicate,
            })
          : await api().data.importFile({
              srcPath: state.srcPath,
              kind: state.kind,
              mapping: state.mapping ?? undefined,
              onDuplicate: state.onDuplicate,
            });
      content.innerHTML = "";
      const grid = el("div", "report-grid");
      const FILE_HINT = {
        imported: "Contacts created from this file",
        merged: "Contacts that filled blanks on someone you already had",
        skipped: "Contacts left out because they matched an existing one",
        duplicates: "Matches found against your existing contacts",
      };
      for (const [label, value] of [
        ["imported", report.imported],
        ["merged", report.merged],
        ["skipped", report.skipped],
        ["duplicates", report.duplicatesFound],
      ]) {
        const cell = el("div");
        cell.title = FILE_HINT[label];
        cell.append(el("div", "num", String(value)), el("div", "mono dim", label));
        grid.append(cell);
      }
      content.append(el("p", null, "Done."), grid);
      const close = el("button", "primary", "Close");
      close.type = "button";
      close.title = "Finish and go back to Orbit with the imported contacts in place";
      close.addEventListener("click", () => {
        m.close();
        onDone();
      });
      m.foot.append(close);
    } catch (err) {
      content.innerHTML = "";
      content.append(el("p", null, "The import failed and nothing was written."));
      content.append(el("p", "dim", err.message ?? String(err)));
      const back = el("button", null, "Back");
      back.type = "button";
      back.title = "Go back and choose a different file";
      back.addEventListener("click", stepSource);
      m.foot.append(back);
    }
  }

  // "Save and reload": reopen straight on the just-saved results file, with the
  // already-imported rows hidden so the user works through the remaining ones.
  async function reloadFrom(path) {
    try {
      state.srcPath = path;
      state.preview = await api().data.importPreview({ srcPath: path });
      state.kind = state.preview.kind;
      state.hideImported = true;
      if (state.kind === "csv") { state.mapping = state.preview.suggestedMapping || null; stepReview(); }
      else if (state.kind === "vcard") stepReview();
      else stepPolicy();
    } catch (err) { toastError(err); stepSource(); }
  }

  if (reloadPath) reloadFrom(reloadPath);
  else stepSource();
}
