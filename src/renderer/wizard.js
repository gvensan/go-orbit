// wizard.js - the import wizard (APP_SHELL_UX §3). Archive: source ->
// dedup policy -> run. CSV: source -> mapping -> editable review table
// (validate, relationship + kinship + location per row) -> confirm -> run.
// vCard: same as CSV minus the mapping step (fields are fixed by the format).

import { el, openModal, confirmModal } from "./modal.js";
import { toast, toastError } from "./toast.js";
import { EDGE_TYPES, kinPreview, kinRolesFor, reciprocalRole } from "./colors.js";
import { pickLocationOnMap } from "./location-picker.js";
import { COUNTRIES, flagEmoji, dialOf, groupNational, normalizePhone, formatPhone } from "../shared/countries.js";

// Numbers without a country code are treated as Indian (see normalizePhone).
const DEFAULT_PHONE_ISO = "IN";

const PAGE_SIZE = 10;
// Extra editable columns shown per row beyond name/gender/relationship/location.
const DETAIL_FIELDS = ["birthday", "email", "phone", "company", "role", "nickname", "website", "linkedin", "notes"];
// Second-line format hint under a column label.
const FORMAT_HINT = {
  gender: "Male/Female",
  birthday: "DD/MM/YYYY or YYYY-MM-DD",
  tags: "tag1;tag2",
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
  const g = normGender(row.gender);
  if (!g) missing.push("gender"); else if (g !== "Male" && g !== "Female") invalid.push("gender");
  const rel = row.rel || {};
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
 * @param {{ onDone: () => void }} opts
 */
export async function openImportWizard({ onDone }) {
  const m = openModal({ title: "Import contacts", maximizable: true, onClose: () => { if (warnTipEl) warnTipEl.remove(); } });
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
  };

  const stepsBar = el("div", "wizard-steps");
  m.body.append(stepsBar);
  const content = el("div");
  m.body.append(content);

  // vCard skips the CSV column-mapping step but shares the editable review
  // table, so the step chips depend on the source kind.
  const stepsFor = () =>
    state.kind === "vcard" ? ["Source", "Review", "Import"] : ["Source", "Mapping", "Review", "Import"];

  function setStep(name) {
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
    const mkSource = (label, sub, filters) => {
      const b = el("button");
      b.type = "button";
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
    mkSource("vCard", ".vcf", [{ name: "vCard", extensions: ["vcf", "vcard"] }]);
    mkSource("CSV", ".csv", [{ name: "CSV", extensions: ["csv"] }]);
    mkSource("Archive", ".orbit", [{ name: "Orbit archive", extensions: ["orbit"] }]);
    content.append(grid);

    // Subtle helper for the CSV path: a template with the columns Orbit maps.
    const csvHelp = el("p", "mono dim source-csv-help");
    csvHelp.append(document.createTextNode("New to CSV? "));
    const tmpl = el("a", "template-link");
    tmpl.textContent = "Download the CSV template";
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
    row.append(input);
    content.append(row);
    const next = el("button", "primary", "Unlock");
    next.type = "button";
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
      const back = el("button", null, "Back"); back.type = "button"; back.addEventListener("click", reviewBack);
      m.foot.append(back);
    });
  }

  /** Live count in the header + status cell of a row, without re-rendering. */
  function refreshCounts() {
    const complete = state.rows.filter((r) => rowIssues(r).complete).length;
    const el1 = content.querySelector(".rv-complete");
    const el2 = content.querySelector(".rv-incomplete");
    if (el1) el1.textContent = `${complete} complete`;
    if (el2) el2.textContent = `${state.rows.length - complete} need attention`;
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

  // Custom hover popup (native title tooltips don't fire reliably in Electron
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

  /** Remove a row from the import, fixing any batch relationship references. */
  function deleteRow(idx) {
    state.rows.splice(idx, 1);
    for (const r of state.rows) {
      if (r.rel && r.rel.batchIndex != null) {
        if (r.rel.batchIndex === idx) r.rel = null;
        else if (r.rel.batchIndex > idx) r.rel.batchIndex -= 1;
      }
    }
    hideWarnTip();
    renderReview();
  }

  function renderReview() {
    hideWarnTip();
    content.innerHTML = ""; m.foot.innerHTML = "";
    if (!state.rows.length) {
      content.append(el("p", "dim", "No rows left to import."));
      const back = el("button", null, "Back"); back.type = "button"; back.addEventListener("click", reviewBack);
      m.foot.append(back);
      return;
    }
    const head = el("div", "review-head");
    const complete = state.rows.filter((r) => rowIssues(r).complete).length;
    head.append(
      el("span", "mono dim", `${state.rows.length} rows · `),
      el("b", "rv-complete", `${complete} complete`),
      el("span", "mono dim", " · "),
      el("b", "rv-incomplete", `${state.rows.length - complete} need attention`),
    );
    const filter = el("label", "review-filter");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = state.incompleteOnly;
    cb.addEventListener("change", () => { state.incompleteOnly = cb.checked; state.page = 0; renderReview(); });
    filter.append(cb, el("span", null, "Only rows needing attention"));
    head.append(filter);
    content.append(head);

    const items = state.rows.map((row, idx) => ({ row, idx }))
      .filter(({ row }) => !state.incompleteOnly || !rowIssues(row).complete);
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    if (state.page >= pages) state.page = pages - 1;
    const slice = items.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);

    const wrap = el("div", "review-table-wrap");
    const table = el("table", "review-table");
    const thead = el("tr");
    const cols = [["", ""], ["name", "name"], ["gender", "gender"], ["relationship", "reltype"],
      ["relationship to", "related"], ["kinship", "kinship"], ["location", "location"],
      ...DETAIL_FIELDS.map((f) => [f, f]), ["tags", "tags"]];
    for (const [label, key] of cols) {
      const th = el("th");
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
      prev.addEventListener("click", () => { state.page--; renderReview(); });
      const next = el("button", null, "Next ›"); next.type = "button"; next.disabled = state.page >= pages - 1;
      next.addEventListener("click", () => { state.page++; renderReview(); });
      pager.append(prev, el("span", "mono dim", `Page ${state.page + 1} / ${pages}`), next);
      content.append(pager);
    }

    const back = el("button", null, "Back"); back.type = "button"; back.addEventListener("click", reviewBack);
    const cont = el("button", "primary", "Continue"); cont.type = "button"; cont.addEventListener("click", openConfirm);
    m.foot.append(back, cont);
  }

  /** Phone editor for a review row: a country dropdown (the same list the
   *  contact card uses) plus the national number. Writes a standardized
   *  "+<dial> <grouped>" string back to row.fields.phone on every change. */
  function makePhoneCell(row) {
    const wrap = el("div", "rv-phone");
    const sel = el("select", "rv-phone-country");
    for (const c of COUNTRIES) sel.append(new Option(`${flagEmoji(c.iso2)} ${c.name} (+${c.dial})`, c.iso2));
    const num = el("input", "rv-in rv-phone-num");
    num.type = "tel"; num.placeholder = "number";
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
    const tr = el("tr", "review-row");
    const statusTd = el("td", "review-status");
    const statusIcon = el("span", "status-icon");
    const del = el("button", "rv-del"); del.type = "button"; del.textContent = "✕";
    del.title = "Remove this row from the import";
    del.addEventListener("click", () => deleteRow(idx));
    statusTd.append(statusIcon, del);
    const kinTd = el("td", "review-kin");
    const nameInput = el("input", "rv-in rv-name"); nameInput.value = row.name;

    const updateStatus = () => {
      const issues = rowIssues(row);
      statusIcon.innerHTML = "";
      if (issues.complete) {
        statusIcon.append(el("span", "row-ok", "✓"));
      } else {
        const w = el("span", "row-warn", "⚠");
        // Native title tooltips are unreliable in Electron - use a custom popup.
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
    for (const opt of ["", "Male", "Female"]) gsel.append(new Option(opt || "—", opt));
    gsel.value = ["Male", "Female"].includes(normGender(row.gender)) ? normGender(row.gender) : "";
    gsel.addEventListener("change", () => { row.gender = gsel.value; row.rel.role = ""; rebuildKin(); updateStatus(); });
    const gTd = el("td"); gTd.append(gsel);

    // relationship type (like the sidebar: colleague/friend/family/...)
    const tsel = el("select", "rv-in");
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
        inp.addEventListener("input", () => { row.fields[f] = inp.value; });
        inp.addEventListener("blur", () => { const iss = rowIssues(row); inp.classList.toggle("invalid", iss.invalid.includes(f)); updateStatus(); });
        td.append(inp);
      }
      tr.append(td);
    }
    // tags
    const tagIn = el("input", "rv-in"); tagIn.value = (row.tags || []).join(";");
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
    const menu = el("div", "loc-menu"); menu.hidden = true;
    const pin = el("button", "loc-pin"); pin.type = "button"; pin.textContent = "📍"; pin.title = "Pin on map";
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

  function openConfirm() {
    if (state.rows.some((r) => !String(r.name || "").trim())) { toast("Every row needs a name before importing."); return; }
    const total = state.rows.length;
    const complete = state.rows.filter((r) => rowIssues(r).complete).length;
    const incomplete = total - complete;
    const cm = openModal({ title: "Import these contacts?" });
    cm.body.append(el("p", null, `${total} contacts ready to import.`));
    const grid = el("div", "report-grid");
    for (const [label, value, cls] of [["complete", complete, "num-ok"], ["need attention", incomplete, incomplete ? "num-warn" : ""]]) {
      const cell = el("div"); cell.append(el("div", `num ${cls}`, String(value)), el("div", "mono dim", label)); grid.append(cell);
    }
    cm.body.append(grid);
    cm.body.append(el("p", "dim", "Every row is imported as a contact. A row with a relationship type + a related contact also creates that connection (family also captures kinship); invalid values (e.g. a bad birthday) are skipped."));
    const polWrap = el("div", "form-row");
    polWrap.append(el("label", null, "If a contact already exists"));
    const polSel = el("select");
    for (const [v, l] of [["skip", "Skip - keep mine"], ["merge", "Merge - fill blanks"], ["keepBoth", "Keep both"]]) polSel.append(new Option(l, v));
    polSel.value = state.onDuplicate; polSel.addEventListener("change", () => { state.onDuplicate = polSel.value; });
    polWrap.append(polSel); cm.body.append(polWrap);
    const cancel = el("button", null, "Back"); cancel.type = "button"; cancel.addEventListener("click", () => cm.close());
    const go = el("button", "primary", `Import ${total}`); go.type = "button";
    go.addEventListener("click", () => { cm.close(); runRecords(); });
    cm.foot.append(cancel, go);
  }

  async function runRecords() {
    setStep("Import");
    content.append(el("p", null, "Importing… a backup snapshot was taken first."));
    try {
      const report = await api().data.importRecords({
        onDuplicate: state.onDuplicate,
        records: state.rows.map((row) => buildRecord(row)),
      });
      content.innerHTML = "";
      const grid = el("div", "report-grid");
      for (const [label, value] of [["imported", report.imported], ["relationships", report.relationships],
        ["merged", report.merged], ["skipped", report.skipped]]) {
        const cell = el("div"); cell.append(el("div", "num", String(value)), el("div", "mono dim", label)); grid.append(cell);
      }
      content.append(el("p", null, "Done."), grid);
      const close = el("button", "primary", "Close"); close.type = "button";
      close.addEventListener("click", () => { m.close(); onDone(); });
      m.foot.append(close);
    } catch (err) {
      content.innerHTML = "";
      content.append(el("p", null, "The import failed and nothing was written."), el("p", "dim", err.message ?? String(err)));
      const back = el("button", null, "Back"); back.type = "button"; back.addEventListener("click", () => renderReview());
      m.foot.append(back);
    }
  }

  // ---- step 2 (vCard/archive): dedup policy ----
  function stepPolicy() {
    setStep("Review");
    content.append(el("p", null, `${state.preview.count} contacts ready. When one matches an existing contact:`));
    const options = /** @type {["skip" | "merge" | "keepBoth", string][]} */ ([
      ["skip", "Skip it - keep what I have"],
      ["merge", "Merge - fill in my blanks, never overwrite"],
      ["keepBoth", "Keep both - I'll review duplicates later"],
    ]);
    for (const [value, label] of options) {
      const row = el("label", "form-row");
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
      for (const [label, value] of [
        ["imported", report.imported],
        ["merged", report.merged],
        ["skipped", report.skipped],
        ["duplicates", report.duplicatesFound],
      ]) {
        const cell = el("div");
        cell.append(el("div", "num", String(value)), el("div", "mono dim", label));
        grid.append(cell);
      }
      content.append(el("p", null, "Done."), grid);
      const close = el("button", "primary", "Close");
      close.type = "button";
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
      back.addEventListener("click", stepSource);
      m.foot.append(back);
    }
  }

  stepSource();
}
