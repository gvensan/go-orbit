// find.js - the FIND view: a structured query builder (JIRA-style) over every
// contact field. Rows of [field][operator][value] combined with ALL/ANY, run
// against find:query, results in a table, saveable as a named query for reuse.

import config from "../main/config.js";
import { el, openModal, promptModal } from "./modal.js";
import { toast, toastError } from "./toast.js";

const api = () => window.api;
const ROW_H = 40;
const SAVED_INLINE_MAX = 10; // saved queries shown inline before "Browse all…"

// Field catalog: label, backend key, value type. Operators derive from type.
const FIELDS = [
  { key: "name", label: "Name", type: "text" },
  { key: "email", label: "Email", type: "text" },
  { key: "phone", label: "Phone", type: "text" },
  { key: "company", label: "Company", type: "text" },
  { key: "role", label: "Role", type: "text" },
  { key: "gender", label: "Gender", type: "enum", options: ["Female", "Male"] },
  { key: "notes", label: "Notes", type: "text" },
  { key: "tags", label: "Tag", type: "list" },
  { key: "edgeType", label: "Relationship", type: "list", options: ["colleague", "friend", "acquaintance", "family", "introduced"] },
  { key: "degree", label: "Connections", type: "number" },
  { key: "lastAt", label: "Last interaction", type: "date" },
  { key: "cadenceDays", label: "Cadence (days)", type: "number" },
  { key: "starred", label: "Starred", type: "bool" },
  { key: "overdue", label: "Overdue", type: "bool" },
  { key: "dormant", label: "Dormant", type: "bool" },
  { key: "__custom", label: "Custom field…", type: "custom" },
];

const OPS = {
  text: [["contains", "contains"], ["notContains", "does not contain"], ["equals", "equals"], ["startsWith", "starts with"], ["isEmpty", "is empty"], ["isNotEmpty", "is not empty"]],
  enum: [["equals", "is"], ["isEmpty", "is empty"], ["isNotEmpty", "is set"]],
  list: [["includes", "includes"], ["excludes", "excludes"], ["isEmpty", "is empty"], ["isNotEmpty", "is not empty"]],
  number: [["eq", "="], ["gt", ">"], ["lt", "<"], ["gte", "≥"], ["lte", "≤"], ["between", "between"]],
  date: [["withinDays", "within last N days"], ["olderThanDays", "not in last N days"], ["never", "never"]],
  bool: [["isTrue", "is true"], ["isFalse", "is false"]],
  custom: [["contains", "contains"], ["equals", "equals"], ["isEmpty", "is empty"], ["isNotEmpty", "is not empty"]],
};
const NO_VALUE = new Set(["isEmpty", "isNotEmpty", "isTrue", "isFalse", "never"]);

const fmtLast = (ts) => {
  if (!ts) return "—";
  const d = Math.floor((Date.now() - ts) / 86400000);
  return d === 0 ? "today" : d < 30 ? `${d}d` : d < 365 ? `${Math.floor(d / 30)}mo` : `${Math.floor(d / 365)}y`;
};

export class FindView {
  /**
   * @param {HTMLElement} root
   * @param {{ onOpenContact: (id: number) => void, onShowOnGraph: (ids: number[]) => void }} handlers
   */
  constructor(root, handlers) {
    this.root = root;
    this.handlers = handlers;
    this.match = "all";
    this.rows = []; // { field, op, value, el }
    this.lastResponse = null;
    this.saved = [];
    this.build();
  }

  build() {
    this.root.innerHTML = "";
    const bar = el("div", "find-bar");
    bar.append(el("span", "find-lead", "Find contacts matching"));
    this.matchSel = el("select", "find-match");
    this.matchSel.append(new Option("all", "all"), new Option("any", "any"));
    this.matchSel.addEventListener("change", () => { this.match = this.matchSel.value; });
    bar.append(this.matchSel, el("span", "find-lead", "of these conditions:"));
    this.savedSel = el("select", "find-saved");
    this.savedSel.append(new Option("Saved queries…", ""));
    this.savedSel.addEventListener("change", () => this.loadSaved(this.savedSel.value));
    bar.append(this.savedSel);
    this.root.append(bar);

    this.condWrap = el("div", "find-conditions");
    this.root.append(this.condWrap);

    const controls = el("div", "find-controls");
    const addBtn = el("button", null, "+ Add condition");
    addBtn.type = "button";
    addBtn.addEventListener("click", () => this.addCondition());
    const runBtn = el("button", "primary", "Run query");
    runBtn.type = "button";
    runBtn.addEventListener("click", () => this.run());
    const clearBtn = el("button", null, "Clear");
    clearBtn.type = "button";
    clearBtn.addEventListener("click", () => { this.rows = []; this.condWrap.innerHTML = ""; this.addCondition(); this.renderResults(null); });
    const saveBtn = el("button", null, "Save query…");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", () => this.saveQuery());
    controls.append(addBtn, runBtn, clearBtn, saveBtn);
    this.root.append(controls);

    this.resultBar = el("div", "find-resultbar mono");
    this.root.append(this.resultBar);
    this.tableHead = el("div", "xp-row xp-head find-head");
    for (const h of ["Name", "Organization", "Last", "Deg", "Tags"]) this.tableHead.append(el("div", "xp-cell", h));
    this.scroller = el("div", "xp-scroller find-scroller");
    this.sizer = el("div");
    this.rowsEl = el("div", "xp-rows");
    this.sizer.append(this.rowsEl);
    this.scroller.append(this.sizer);
    this.root.append(this.tableHead, this.scroller);
    this.scroller.addEventListener("scroll", () => this.renderRows());

    if (!this.rows.length) this.addCondition();
  }

  addCondition(preset) {
    const row = el("div", "find-cond");
    const fieldSel = el("select", "find-field");
    for (const f of FIELDS) fieldSel.append(new Option(f.label, f.key));
    const opSel = el("select", "find-op");
    const valWrap = el("span", "find-value");
    const customKey = el("input", "find-customkey");
    customKey.placeholder = "field name";
    customKey.hidden = true;

    const cond = { fieldSel, opSel, valWrap, customKey, row };
    this.rows.push(cond);

    const rebuildOps = () => {
      const f = FIELDS.find((x) => x.key === fieldSel.value);
      customKey.hidden = f.type !== "custom";
      opSel.innerHTML = "";
      for (const [op, label] of OPS[f.type]) opSel.append(new Option(label, op));
      rebuildValue();
    };
    const rebuildValue = () => {
      const f = FIELDS.find((x) => x.key === fieldSel.value);
      valWrap.innerHTML = "";
      if (NO_VALUE.has(opSel.value)) return;
      if (opSel.value === "between") {
        const a = el("input", "find-num"); a.type = "number"; a.placeholder = "min";
        const b = el("input", "find-num"); b.type = "number"; b.placeholder = "max";
        valWrap.append(a, el("span", "dim", "…"), b);
      } else if ((f.type === "enum" || (f.type === "list" && f.options))) {
        const sel = el("select");
        for (const o of f.options) sel.append(new Option(o, o));
        valWrap.append(sel);
      } else if (f.type === "number" || f.type === "date") {
        const inp = el("input", "find-num"); inp.type = "number";
        inp.placeholder = f.type === "date" ? "days" : "value";
        valWrap.append(inp);
      } else {
        const inp = el("input"); inp.type = "text"; inp.placeholder = "value";
        valWrap.append(inp);
      }
    };
    fieldSel.addEventListener("change", rebuildOps);
    opSel.addEventListener("change", rebuildValue);

    const rm = el("button", "find-rm", "✕");
    rm.type = "button";
    rm.addEventListener("click", () => {
      row.remove();
      this.rows = this.rows.filter((r) => r !== cond);
    });

    row.append(fieldSel, customKey, opSel, valWrap, rm);
    this.condWrap.append(row);
    if (preset) {
      fieldSel.value = preset.field === "org" ? "company" : preset.field;
      if (fieldSel.value === "" || !FIELDS.some((f) => f.key === fieldSel.value)) {
        fieldSel.value = "__custom"; customKey.value = preset.field;
      }
      rebuildOps();
      opSel.value = preset.op;
      rebuildValue();
      this.setValue(cond, preset.value);
    } else {
      rebuildOps();
    }
  }

  setValue(cond, value) {
    const inputs = cond.valWrap.querySelectorAll("input, select");
    if (!inputs.length) return;
    if (Array.isArray(value)) { inputs[0].value = value[0] ?? ""; if (inputs[1]) inputs[1].value = value[1] ?? ""; }
    else inputs[0].value = value ?? "";
  }

  toQuery() {
    const conditions = [];
    for (const c of this.rows) {
      const f = FIELDS.find((x) => x.key === c.fieldSel.value);
      const field = f.type === "custom" ? c.customKey.value.trim().toLowerCase() : (f.key === "company" ? "company" : f.key);
      if (!field) continue;
      const op = c.opSel.value;
      let value;
      if (!NO_VALUE.has(op)) {
        const inputs = c.valWrap.querySelectorAll("input, select");
        value = op === "between" ? [inputs[0]?.value, inputs[1]?.value] : inputs[0]?.value;
      }
      conditions.push({ field, op, value });
    }
    return { match: /** @type {"all"|"any"} */ (this.match), conditions, limit: config.explore.resultLimit };
  }

  async run() {
    try {
      this.lastResponse = await api().find.query(this.toQuery());
      this.renderResults(this.lastResponse);
    } catch (err) {
      toastError(err);
    }
  }

  renderResults(resp) {
    this.resultBar.innerHTML = "";
    if (!resp) { this.sizer.style.height = "0"; this.rowsEl.innerHTML = ""; return; }
    this.resultBar.append(el("span", null, `${resp.total.toLocaleString()} match${resp.total === 1 ? "" : "es"}`));
    if (resp.total) {
      const showBtn = el("button", "primary", "Show on graph");
      showBtn.type = "button";
      showBtn.addEventListener("click", () => this.handlers.onShowOnGraph(resp.matchedIds));
      this.resultBar.append(showBtn);
    }
    this.sizer.style.height = `${resp.results.length * ROW_H}px`;
    this.renderRows();
  }

  renderRows() {
    const results = this.lastResponse?.results ?? [];
    const start = Math.max(0, Math.floor(this.scroller.scrollTop / ROW_H) - 5);
    const end = Math.min(results.length, start + Math.ceil(this.scroller.clientHeight / ROW_H) + 10);
    this.rowsEl.style.transform = `translateY(${start * ROW_H}px)`;
    this.rowsEl.innerHTML = "";
    if (!results.length) {
      this.rowsEl.append(el("div", "xp-empty", this.lastResponse ? "No contacts match." : "Build a query and Run."));
      return;
    }
    for (let i = start; i < end; i++) {
      const r = results[i];
      const row = el("div", "xp-row find-row");
      const name = el("div", "xp-cell xp-name", `${r.starred ? "★ " : ""}${r.name}`);
      row.append(
        name,
        el("div", "xp-cell dim", [r.role, r.org].filter(Boolean).join(" · ") || "—"),
        el("div", "xp-cell mono dim", fmtLast(r.lastAt)),
        el("div", "xp-cell mono dim", String(r.degree)),
        el("div", "xp-cell dim", (r.tags ?? []).slice(0, 3).join(" "))
      );
      row.addEventListener("click", () => this.handlers.onOpenContact(r.id));
      this.rowsEl.append(row);
    }
  }

  async saveQuery() {
    if (!this.rows.length) { toast("Add a condition first."); return; }
    const name = await promptModal({ title: "Save query", label: "Name", confirmLabel: "Save" });
    if (!name?.trim()) return;
    try {
      await api().searches.save({ name: name.trim(), query: JSON.stringify(this.toQuery()), kind: "find" });
      await this.loadSavedList();
      toast(`Saved query "${name.trim()}".`);
    } catch (err) { toastError(err); }
  }

  async loadSavedList() {
    try {
      this.saved = await api().searches.list({ kind: "find" });
    } catch { this.saved = []; }
    this.savedSel.innerHTML = "";
    this.savedSel.append(new Option("Saved queries…", ""));
    // Keep the inline dropdown short; overflow goes to a searchable picker.
    const inline = this.saved.slice(0, SAVED_INLINE_MAX);
    for (const s of inline) this.savedSel.append(new Option(s.name, String(s.id)));
    if (this.saved.length > SAVED_INLINE_MAX) {
      this.savedSel.append(new Option(`Browse all ${this.saved.length}…`, "__more"));
    }
  }

  loadSaved(id) {
    if (id === "__more") { this.savedSel.value = ""; this.openSavedPicker(); return; }
    const s = this.saved.find((x) => String(x.id) === id);
    if (!s) return;
    let q;
    try { q = JSON.parse(s.query); } catch { toast("Could not load that query."); return; }
    this.match = q.match ?? "all";
    this.matchSel.value = this.match;
    this.rows = [];
    this.condWrap.innerHTML = "";
    for (const c of q.conditions ?? []) this.addCondition(c);
    if (!this.rows.length) this.addCondition();
    this.run();
  }

  /** Searchable picker for all saved queries (used when the list is long). */
  openSavedPicker() {
    const m = openModal({ title: "Saved queries" });
    const search = el("input", "find-picker-search");
    search.type = "text";
    search.placeholder = "Search saved queries…";
    const list = el("div", "find-picker-list");
    m.body.append(search, list);
    const render = () => {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = "";
      const shown = this.saved.filter((s) => !q || s.name.toLowerCase().includes(q));
      if (!shown.length) { list.append(el("p", "dim", "No matching queries.")); return; }
      for (const s of shown) {
        const row = el("button", "find-picker-row");
        row.type = "button";
        row.append(el("span", null, s.name));
        const del = el("span", "find-picker-del mono", "✕");
        del.title = "Delete query";
        del.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            await api().searches.delete({ id: s.id });
            await this.loadSavedList();
            render();
          } catch (err) { toastError(err); }
        });
        row.append(del);
        row.addEventListener("click", () => { m.close(); this.loadSaved(String(s.id)); });
        list.append(row);
      }
    };
    search.addEventListener("input", render);
    render();
    search.focus();
  }

  focus() {
    this.loadSavedList();
    this.rows[0]?.fieldSel.focus();
  }
}
