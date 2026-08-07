// explore.js - the content-pane faceted people-search view. Query bar + facets
// rail + a data table with resizable, sortable, facet-aware columns. The query
// bar and facets share one filter state (operators check facets and vice
// versa); results drive the graph and bulk actions over the whole matched set.

import config from "../main/config.js";
import { el, openModal, promptModal } from "./modal.js";
import { pickLocationOnMap } from "./location-picker.js";
import { toast, toastError } from "./toast.js";
import { fieldType, validateField, normalizeFieldValue } from "../shared/field-types.js";
import { createControl, createLocationControl, applyLocationMatch, clearLocationResolution, resolveLocation } from "./field-controls.js";

const api = () => window.api;
const ROW_H = 40;
const FACET_COLLAPSE = 8; // org/tag values shown before "Show all"

const STATUS_LABELS = {
  starred: "★ Starred",
  overdue: "Overdue",
  dormant: "Dormant",
  hasEmail: "Has email",
  hasPhone: "Has phone",
};
const SEGMENTS = [
  { label: "Everyone", filters: {}, sort: "name",
    hint: "Clear all filters and list every contact by name" },
  { label: "Needs attention", filters: { status: ["overdue", "dormant"] }, sort: "overdue",
    hint: "People past their keep-in-touch cadence, or long out of contact" },
  { label: "Starred", filters: { status: ["starred"] }, sort: "name",
    hint: "The contacts you starred, which also pin to the top of the search palette" },
  { label: "Dormant connectors", filters: { status: ["dormant"], degreeBuckets: ["hub", "connected"] }, sort: "degree",
    hint: "Well-connected people you have not spoken to in a long time" },
  { label: "Missing email", filters: {}, sort: "name", exclude: { hasEmail: true },
    hint: "Contacts with no email address on file" },
];

function renderTags(r) {
  const tags = r.tags ?? [];
  const cell = el("div", "xp-cell xp-tags");
  if (!tags.length) {
    cell.append(el("span", "dim", "—"));
    return cell;
  }
  cell.title = tags.join(", ");
  for (const tag of tags.slice(0, 3)) cell.append(el("span", "tag-chip", tag));
  if (tags.length > 3) cell.append(el("span", "tag-chip xp-tag-more", `+${tags.length - 3}`));
  return cell;
}

const textCell = (value, cls = "dim") => {
  const cell = el("div", `xp-cell ${cls}`, value == null || value === "" ? "—" : String(value));
  if (value != null && value !== "") cell.title = String(value);
  return cell;
};
const boolCell = (value, yes = "Yes", no = "—") => textCell(value ? yes : no, value ? "xp-boolean yes" : "dim");
const dateCell = (value) => textCell(value ? fmtDate(value) : "—", "mono dim");

// Column model. `base` columns always show; the rest appear when their facet is
// active (requirement: selecting a facet reveals its column). `sort` is the
// backend sort key. Every data column is sortable.
const COLUMNS = [
  { key: "name", label: "Name", group: "Identity", sort: "name", base: true, w: 230, min: 140,
    edit: { field: "name", kind: "name" },
    render: (r, view) => {
      const c = el("div", "xp-cell xp-name");
      if (view.state.scope === "family") {
        c.style.paddingLeft = `${10 + (r._familyDepth ?? 0) * 20}px`;
        if (r._hasFamilyChildren) {
          const toggle = el("button", "xp-tree-toggle", view.familyCollapsed.has(r.id) ? "▸" : "▾");
          toggle.type = "button"; toggle.title = view.familyCollapsed.has(r.id) ? "Expand branch" : "Collapse branch";
          toggle.addEventListener("click", (e) => { e.stopPropagation(); view.toggleFamilyBranch(r.id); });
          c.append(toggle);
        } else c.append(el("span", "xp-tree-spacer", "·"));
      }
      c.append(document.createTextNode(`${r.starred ? "★ " : ""}${r.name}`));
      if (r.isOwner) c.append(el("span", "xp-pill owner", "you"));
      if (r.overdue) c.append(el("span", "xp-pill overdue", "overdue"));
      // Always-available edit popup - no mode needed. Shown on row hover.
      const pencil = el("button", "xp-row-edit", "✎");
      pencil.type = "button";
      pencil.title = `Edit ${r.name}'s details`;
      pencil.setAttribute("aria-label", `Edit ${r.name}'s details`);
      pencil.addEventListener("click", (e) => { e.stopPropagation(); view.editContact(r.id); });
      c.append(pencil);
      return c;
    } },
  { key: "nickname", label: "Nickname", group: "Identity", sort: "nickname", w: 120, min: 80, edit: { field: "nickname" }, render: (r) => textCell(r.nickname) },
  { key: "gender", label: "Gender", group: "Identity", sort: "gender", w: 90, min: 60, edit: { field: "gender", kind: "select" }, render: (r) => textCell(r.gender) },
  { key: "birthday", label: "Birthday", group: "Identity", sort: "birthday", w: 110, min: 90, edit: { field: "birthday", kind: "date" }, render: (r) => dateCell(r.birthday) },
  { key: "deceased", label: "Deceased", group: "Identity", sort: "deceased", w: 86, min: 70, render: (r) => boolCell(r.deceased) },
  { key: "email", label: "Email", group: "Contact", sort: "email", facet: (f) => f.status.includes("hasEmail"), w: 200, min: 120, edit: { field: "email" }, render: (r) => textCell(r.email, "mono dim") },
  { key: "phone", label: "Phone", group: "Contact", sort: "phone", facet: (f) => f.status.includes("hasPhone"), w: 150, min: 100, edit: { field: "phone" }, render: (r) => textCell(r.phone, "mono dim") },
  { key: "org", label: "Company", group: "Work", sort: "org", base: true, w: 170, min: 100, edit: { field: "company" }, render: (r) => textCell(r.org) },
  { key: "role", label: "Role", group: "Work", sort: "role", w: 150, min: 90, edit: { field: "role" }, render: (r) => textCell(r.role) },
  { key: "location", label: "Location entered", group: "Location", sort: "location", w: 190, min: 110, edit: { field: "location", kind: "location" }, render: (r) => textCell(r.location) },
  { key: "city", label: "City", group: "Location", sort: "city", w: 130, min: 85, render: (r) => textCell(r.city) },
  { key: "county", label: "County", group: "Location", sort: "county", w: 130, min: 85, render: (r) => textCell(r.county) },
  { key: "state", label: "State / region", group: "Location", sort: "state", w: 140, min: 90, render: (r) => textCell(r.state) },
  { key: "postcode", label: "Postcode", group: "Location", sort: "postcode", w: 100, min: 75, render: (r) => textCell(r.postcode, "mono dim") },
  { key: "country", label: "Country", group: "Location", sort: "country", w: 130, min: 85, render: (r) => textCell(r.country) },
  { key: "relationship", label: "Relationships", group: "Network", sort: "relationship", facet: (f) => f.edgeTypes.length > 0, w: 170, min: 100, render: (r) => textCell((r.types ?? []).join(", ")) },
  { key: "kin", label: "Kinship", group: "Network", sort: "kin", w: 120, min: 80, render: (r) => textCell(r.kin) },
  { key: "degree", label: "Connections", group: "Network", sort: "degree", base: true, w: 92, min: 70, render: (r) => textCell(r.degree, "mono dim") },
  { key: "tags", label: "Tags", group: "Network", sort: "tags", base: true, w: 170, min: 90,
    render: renderTags },
  { key: "notes", label: "Notes", group: "Activity", sort: "notes", w: 240, min: 120, edit: { field: "notes" }, render: (r) => textCell(r.notes) },
  { key: "last", label: "Last interaction", group: "Activity", sort: "recent", base: true, w: 110, min: 82, render: (r) => textCell(fmtLast(r.lastAt), "mono dim") },
  { key: "lastKind", label: "Last type", group: "Activity", sort: "lastKind", w: 90, min: 70, render: (r) => textCell(r.lastKind) },
  { key: "lastNote", label: "Last interaction note", group: "Activity", sort: "lastNote", w: 220, min: 120, render: (r) => textCell(r.lastNote) },
  { key: "interactionCount", label: "Interactions", group: "Activity", sort: "interactionCount", w: 90, min: 70, render: (r) => textCell(r.interactionCount, "mono dim") },
  { key: "cadenceDays", label: "Cadence", group: "Activity", sort: "cadenceDays", w: 90, min: 70, render: (r) => textCell(r.cadenceDays ? `${r.cadenceDays}d` : "—", "mono dim") },
  { key: "starred", label: "Starred", group: "Activity", sort: "starred", w: 76, min: 60, render: (r) => boolCell(r.starred, "★") },
  { key: "website", label: "Website", group: "Web", sort: "website", w: 190, min: 110, edit: { field: "website" }, render: (r) => textCell(r.website, "mono dim") },
  { key: "linkedin", label: "LinkedIn", group: "Web", sort: "linkedin", w: 190, min: 110, edit: { field: "linkedin" }, render: (r) => textCell(r.linkedin, "mono dim") },
  { key: "id", label: "ID", group: "System", sort: "id", w: 64, min: 50, render: (r) => textCell(r.id, "mono dim") },
  { key: "createdAt", label: "Created", group: "System", sort: "createdAt", w: 120, min: 90, render: (r) => dateCell(r.createdAt) },
  { key: "updatedAt", label: "Updated", group: "System", sort: "updatedAt", w: 120, min: 90, render: (r) => dateCell(r.updatedAt) },
];

const DESC_SORTS = new Set(["degree", "recent", "overdue", "deceased", "interactionCount", "starred", "createdAt", "updatedAt"]);
const naturalSortDirection = (sort) => DESC_SORTS.has(sort) ? "desc" : "asc";

const fmtLast = (ts) => {
  if (!ts) return "—";
  const d = Math.floor((Date.now() - ts) / 86400000);
  return d === 0 ? "today" : d < 30 ? `${d}d` : d < 365 ? `${Math.floor(d / 30)}mo` : `${Math.floor(d / 365)}y`;
};
const fmtDate = (value) => {
  if (!value) return "—";
  const d = typeof value === "number" ? new Date(value) : new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

export class ExploreView {
  /**
   * @param {HTMLElement} root
   * @param {{ onOpenContact: (id: number) => void, onShowOnGraph: (ids: number[]) => void,
   *           onChanged: () => void }} handlers
   */
  constructor(root, handlers) {
    this.root = root;
    this.handlers = handlers;
    this.state = {
      text: "",
      filters: { orgs: [], tags: [], edgeTypes: [], status: [], degreeBuckets: [] },
      sort: /** @type {import("../shared/types").ExploreSort} */ ("name"),
      dir: /** @type {"asc"|"desc"} */ ("asc"),
      exclude: /** @type {{ hasEmail?: boolean }} */ ({}),
      scope: /** @type {"all"|"family"|"friends"} */ ("all"),
    };
    this.selected = new Set();
    this.familyCollapsed = new Set();
    // In-place cell editing: a row click opens the contact unless the toolbar
    // toggle flips clicks to edit-the-cell. Persisted - a mid-cleanup restart
    // must not silently drop the mode and turn edit clicks into navigation.
    this.editMode = localStorage.getItem("orbit-explore-edit") === "1";
    this._editingCell = false;
    this.lastResponse = null;
    this.runVersion = 0;
    this.debounce = null;
    this.colWidths = loadWidths();
    this.colOrder = loadOrder();
    // User-chosen columns (persisted). Defaults to the base set; facet columns
    // still auto-reveal when their facet is active (see visibleColumns).
    this.colVisible = loadVisible() ?? new Set(COLUMNS.filter((c) => c.base).map((c) => c.key));
    this.facetUI = { orgs: { expanded: false, filter: "" }, tags: { expanded: false, filter: "" } };
    this.resizing = null;
    this.build();
  }

  build() {
    this.root.innerHTML = "";
    this.root.classList.toggle("xp-editing", this.editMode); // restored mode styles from the first paint
    const bar = el("div", "xp-bar");
    this.input = el("input");
    this.input.type = "text";
    this.input.placeholder = "Filter people…  try  org:acme  tag:vip  has:email  near:\"Bo\" hops:2";
    this.input.title = "Type to filter by name, company, or role. Operators narrow it further: org:acme, tag:vip, type:family, has:email, near:\"Bo\", hops:2";
    this.scopeToggle = el("div", "xp-scope-toggle");
    const SCOPE_TITLES = {
      all: "Show every contact",
      family: "Show only family, nested from you along recorded family connections",
      friends: "Show only contacts connected to you as friends",
    };
    for (const [value, label] of [["all", "ALL"], ["family", "FAMILY"], ["friends", "FRIENDS"]]) {
      const b = el("button", null, label); b.type = "button"; b.dataset.scope = value;
      b.title = SCOPE_TITLES[value];
      b.addEventListener("click", () => {
        if (this.state.scope === value) return;
        this.state.scope = /** @type {"all"|"family"|"friends"} */ (value); this.selected.clear(); this.scroller.scrollTop = 0; this.run();
      });
      this.scopeToggle.append(b);
    }
    this.count = el("span", "xp-count mono");
    this.count.title = "How many people match the current filters";
    // Clear (✕) inside the filter box, shown only while there is text.
    const inputWrap = el("div", "xp-input-wrap");
    this.clearBtn = el("button", "xp-input-clear", "✕");
    this.clearBtn.type = "button";
    this.clearBtn.title = "Clear the filter";
    this.clearBtn.setAttribute("aria-label", "Clear the filter");
    this.clearBtn.hidden = true;
    this.clearBtn.addEventListener("click", () => {
      this.input.value = "";
      this.input.dispatchEvent(new Event("input")); // one path: same clearing rules as typing
      this.input.focus();
    });
    inputWrap.append(this.input, this.clearBtn);
    bar.append(inputWrap, this.scopeToggle, this.count);
    this.root.append(bar);
    this.familyNote = el("div", "xp-family-note", "Family is nested from you through recorded family connections. Indentation shows relationship paths, not legal or biological parentage.");
    this.familyNote.hidden = true;
    this.root.append(this.familyNote);

    const body = el("div", "xp-body");
    this.facets = el("aside", "xp-facets");
    this.main = el("div", "xp-main");
    this.bulk = el("div", "xp-bulk");
    this.tableHead = el("div", "xp-row xp-head");
    // The header lives in a clip that we scroll horizontally in lock-step with
    // the body (below), so a wide table scrolls rows AND header together while
    // the header stays pinned vertically.
    this.headClip = el("div", "xp-head-clip");
    this.headClip.append(this.tableHead);
    this.scroller = el("div", "xp-scroller");
    this.sizer = el("div");
    this.rowsEl = el("div", "xp-rows");
    this.sizer.append(this.rowsEl);
    this.scroller.append(this.sizer);
    this.main.append(this.bulk, this.headClip, this.scroller);
    body.append(this.facets, this.main);
    this.root.append(body);

    this.input.addEventListener("input", () => {
      this.state.text = this.input.value;
      this.clearBtn.hidden = !this.input.value;
      // A changed query defines a new working set. Never let an invisible
      // selection from the previous query receive a bulk action.
      if (this.selected.size) {
        this.selected.clear();
        this.renderRows();
        this.renderBulk();
        this.renderHead();
      }
      this.debounced();
    });
    this.scroller.addEventListener("scroll", () => {
      this.renderRows();
      // Keep the header aligned with the body's horizontal scroll.
      this.syncHeaderScroll();
    });
    // Live column-resize tracking on the whole view.
    window.addEventListener("mousemove", (e) => this.onResizeMove(e));
    window.addEventListener("mouseup", () => this.onResizeEnd());
  }

  focus() {
    this.input.focus();
    this.input.select();
  }

  visibleColumns() {
    // Name is always shown; otherwise a column shows when the user enabled it OR
    // its facet is active (activating a facet still reveals its column).
    return this.orderedColumns().filter(
      (c) => c.key === "name" || this.colVisible.has(c.key) || (c.facet && c.facet(this.state.filters))
    );
  }

  /** Persisted user order, healed when columns are added to or removed from the model. */
  orderedColumns() {
    const byKey = new Map(COLUMNS.map((column) => [column.key, column]));
    const keys = ["name", ...this.colOrder.filter((key) => key !== "name" && byKey.has(key))];
    for (const column of COLUMNS) if (!keys.includes(column.key)) keys.push(column.key);
    return keys.map((key) => byKey.get(key)).filter(Boolean);
  }

  /** Dropdown to choose which columns the table shows. Persisted. */
  openColumnMenu(anchor) {
    const mark = (open) => anchor?.setAttribute?.("aria-expanded", String(open));
    if (this._colMenu) { this._colMenu.remove(); this._colMenu = null; mark(false); return; }
    mark(true);
    const menu = el("div", "xp-col-menu");
    menu.append(el("div", "xp-col-menu-head mono", "Columns"));
    const grid = el("div", "xp-col-grid");
    const stacks = [el("div", "xp-col-stack"), el("div", "xp-col-stack"), el("div", "xp-col-stack")];
    grid.append(...stacks);
    // Keep the original group order flowing left-to-right while balancing the
    // three columns: 9, 10, and 12 selectable rows respectively.
    const groupStack = new Map([
      ["Identity", 0], ["Contact", 0], ["Work", 0],
      ["Location", 1], ["Network", 1],
      ["Activity", 2], ["Web", 2], ["System", 2],
    ]);
    let group = null;
    let groupEl = null;
    for (const c of COLUMNS) {
      if (c.group !== group) {
        group = c.group;
        groupEl = el("div", "xp-col-group-block");
        groupEl.append(el("div", "xp-col-group", group));
        stacks[groupStack.get(group) ?? 0].append(groupEl);
      }
      const forced = !!(c.facet && c.facet(this.state.filters)); // shown by an active filter
      const rowEl = el("label", "xp-col-menu-row");
      const cb = /** @type {HTMLInputElement} */ (el("input"));
      cb.type = "checkbox";
      cb.checked = c.key === "name" || this.colVisible.has(c.key) || forced;
      cb.disabled = c.key === "name" || forced; // name is required; a filter pins its column
      rowEl.title = c.key === "name" ? "Name is always shown"
        : forced ? `${c.label} is pinned while its filter is active`
        : cb.checked ? `Hide the ${c.label} column` : `Show the ${c.label} column`;
      cb.addEventListener("change", () => {
        if (cb.checked) this.colVisible.add(c.key); else this.colVisible.delete(c.key);
        saveVisible(this.colVisible);
        this.applyGrid();
        this.renderHead();
        this.renderRows();
      });
      rowEl.append(cb, el("span", null, c.label));
      if (forced) rowEl.append(el("span", "dim mono xp-col-forced", "· filter"));
      groupEl.append(rowEl);
    }
    menu.append(grid);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    const menuWidth = Math.min(720, window.innerWidth - 16);
    menu.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - menuWidth - 8, r.right - menuWidth)))}px`;
    document.body.append(menu);
    this._colMenu = menu;
    const close = (ev) => {
      if (menu.contains(ev.target) || ev.target === anchor) return;
      menu.remove();
      this._colMenu = null;
      mark(false);
      window.removeEventListener("mousedown", close, true);
    };
    setTimeout(() => window.addEventListener("mousedown", close, true), 0);
  }

  gridTemplate() {
    const cols = this.visibleColumns().map((c) => `${this.colWidths[c.key] ?? c.w}px`);
    return `34px ${cols.join(" ")}`; // leading checkbox column
  }

  applyGrid() {
    this.root.style.setProperty("--xp-cols", this.gridTemplate());
  }

  loadSegment(seg) {
    this.state.filters = {
      orgs: [], tags: [], edgeTypes: [], status: [], degreeBuckets: [],
      ...structuredCloneLite(seg.filters),
    };
    this.state.sort = /** @type {any} */ (seg.sort ?? "name");
    this.state.dir = naturalSortDirection(this.state.sort);
    this.state.text = "";
    this.state.exclude = seg.exclude ?? {};
    this.input.value = "";
    this.clearBtn.hidden = true;
    this.selected.clear();
    this.run();
  }

  debounced() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.run(), 140);
  }

  async run() {
    const version = ++this.runVersion;
    try {
      const resp = await api().explore.query({
        text: this.state.text,
        filters: this.compactFilters(),
        sort: this.state.sort,
        dir: this.state.dir,
        limit: config.explore.resultLimit,
        scope: this.state.scope,
      });
      // A sidebar edit can refresh Explore while another query is in flight.
      // Only the latest request may repaint the table.
      if (version !== this.runVersion) return;
      this.lastResponse = resp;
      this.applyClientExclude();
      // Sidebar edits/deletes can remove selected rows from the current result
      // without a query-bar event. Prune them before exposing bulk controls.
      const matched = new Set(this.lastResponse.results.map((row) => row.id));
      for (const id of this.selected) if (!matched.has(id)) this.selected.delete(id);
      this.render();
    } catch (err) {
      toastError(err);
    }
  }

  applyClientExclude() {
    if (this.state.exclude.hasEmail) {
      this.lastResponse.results = this.lastResponse.results.filter((r) => !r.email);
      this.lastResponse.total = this.lastResponse.results.length;
    }
  }

  compactFilters() {
    const f = this.state.filters;
    const out = {};
    for (const k of ["orgs", "tags", "edgeTypes", "status", "degreeBuckets"]) {
      if (f[k]?.length) out[k] = f[k];
    }
    return out;
  }

  render() {
    const { total, results } = this.lastResponse;
    this.scopeToggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.scope === this.state.scope));
    this.familyNote.hidden = this.state.scope !== "family";
    this.count.textContent =
      total === results.length ? `${total.toLocaleString()} people` : `${results.length.toLocaleString()} of ${total.toLocaleString()}`;
    this.applyGrid();
    this.renderFacets(this.lastResponse.facets);
    this.renderHead();
    this.sizer.style.height = `${this.displayResults().length * ROW_H}px`;
    this.renderRows();
    this.renderBulk();
  }

  // ------------------------------------------------------------- header --
  renderHead() {
    this.tableHead.innerHTML = "";
    const check = el("input");
    check.type = "checkbox";
    check.setAttribute("aria-label", "Select all shown");
    const shown = this.displayResults();
    check.checked = shown.length > 0 && shown.every((r) => this.selected.has(r.id));
    check.title = check.checked
      ? "Unselect every row shown"
      : `Select all ${shown.length} rows shown, so bulk actions apply to just them`;
    check.addEventListener("click", () => this.toggleSelectAll(check.checked));
    const cw = el("div", "xp-cell xp-check xp-sticky-check");
    cw.append(check);
    this.tableHead.append(cw);

    for (const col of this.visibleColumns()) {
      const cell = el("div", "xp-cell xp-th");
      cell.dataset.columnKey = col.key;
      if (col.key === "name") cell.classList.add("xp-sticky-name");
      cell.addEventListener("dragover", (event) => this.onColumnDragOver(event, cell, col));
      cell.addEventListener("dragleave", (event) => {
        if (!cell.contains(event.relatedTarget)) cell.classList.remove("drop-before", "drop-after");
      });
      cell.addEventListener("drop", (event) => this.onColumnDrop(event, cell, col));
      const active = col.sort && this.state.sort === col.sort;
      const arrow = active ? (this.state.dir === "asc" ? " ▲" : " ▼") : "";
      if (col.key !== "name") {
        const move = el("button", "xp-drag-handle", "⠿");
        move.type = "button";
        move.draggable = true;
        move.dataset.columnKey = col.key;
        move.title = `Move ${col.label} column · drag or press Alt+Left/Right`;
        move.setAttribute("aria-label", move.title);
        move.addEventListener("dragstart", (event) => this.onColumnDragStart(event, col));
        move.addEventListener("dragend", () => this.clearColumnDrag());
        move.addEventListener("keydown", (event) => this.onColumnMoveKey(event, col));
        cell.append(move);
      }
      const labelBtn = el("button", "xp-th-label" + (col.sort ? " sortable" : ""), col.label + arrow);
      labelBtn.type = "button";
      if (col.sort) {
        labelBtn.title = active
          ? `Sorted by ${col.label}, ${this.state.dir === "asc" ? "ascending" : "descending"}. Click to reverse`
          : `Sort by ${col.label}`;
        labelBtn.addEventListener("click", () => this.sortBy(col));
      } else {
        labelBtn.title = `${col.label} cannot be sorted`;
        labelBtn.disabled = true;
      }
      cell.append(labelBtn);
      // Resize grip on the right edge (all but a trailing tiny column).
      const grip = el("div", "xp-resize");
      grip.title = `Drag to resize the ${col.label} column`;
      grip.addEventListener("mousedown", (e) => this.onResizeStart(e, col));
      cell.append(grip);
      this.tableHead.append(cell);
    }
    this.syncHeaderScroll();
  }

  syncHeaderScroll() {
    const x = this.scroller?.scrollLeft ?? 0;
    this.tableHead.style.transform = `translateX(${-x}px)`;
    for (const cell of this.tableHead.querySelectorAll(".xp-sticky-check, .xp-sticky-name")) {
      cell.style.transform = `translateX(${x}px)`;
    }
  }

  sortBy(col) {
    const natural = naturalSortDirection(col.sort);
    if (this.state.sort === col.sort) {
      this.state.dir = this.state.dir === "asc" ? "desc" : "asc";
    } else {
      this.state.sort = col.sort;
      this.state.dir = natural;
    }
    this.run();
  }

  // -------------------------------------------------------- column move --
  onColumnDragStart(event, col) {
    this.draggedColumn = col.key;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", col.key);
    event.currentTarget.closest(".xp-th")?.classList.add("dragging");
  }

  onColumnDragOver(event, cell, target) {
    if (!this.draggedColumn || this.draggedColumn === target.key) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    this.clearColumnDropTargets();
    const after = target.key === "name" || event.clientX >= cell.getBoundingClientRect().left + cell.offsetWidth / 2;
    cell.classList.add(after ? "drop-after" : "drop-before");
  }

  onColumnDrop(event, cell, target) {
    if (!this.draggedColumn || this.draggedColumn === target.key) return;
    event.preventDefault();
    const after = target.key === "name" || cell.classList.contains("drop-after");
    const source = this.draggedColumn;
    this.clearColumnDrag();
    this.moveColumn(source, target.key, after);
  }

  onColumnMoveKey(event, col) {
    if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const visible = this.visibleColumns();
    const index = visible.findIndex((item) => item.key === col.key);
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const target = visible[index + direction];
    if (!target) return;
    this.moveColumn(col.key, target.key, direction > 0);
    requestAnimationFrame(() => this.tableHead.querySelector(`.xp-drag-handle[data-column-key="${col.key}"]`)?.focus());
  }

  moveColumn(sourceKey, targetKey, after) {
    if (sourceKey === "name" || sourceKey === targetKey) return;
    const keys = this.orderedColumns().map((column) => column.key).filter((key) => key !== sourceKey);
    let targetIndex = keys.indexOf(targetKey);
    if (targetIndex < 0) return;
    if (targetKey === "name") after = true; // Name and the checkbox are always anchored.
    if (after) targetIndex += 1;
    keys.splice(targetIndex, 0, sourceKey);
    this.colOrder = keys.filter((key) => key !== "name");
    saveOrder(this.colOrder);
    this.applyGrid();
    this.renderHead();
    this.renderRows();
  }

  clearColumnDropTargets() {
    this.tableHead.querySelectorAll(".drop-before, .drop-after").forEach((cell) => cell.classList.remove("drop-before", "drop-after"));
  }

  clearColumnDrag() {
    this.draggedColumn = null;
    this.tableHead.querySelectorAll(".dragging").forEach((cell) => cell.classList.remove("dragging"));
    this.clearColumnDropTargets();
  }

  // ------------------------------------------------------- column resize --
  onResizeStart(e, col) {
    e.preventDefault();
    e.stopPropagation();
    this.resizing = { key: col.key, min: col.min, startX: e.clientX, startW: this.colWidths[col.key] ?? col.w };
    document.body.style.cursor = "col-resize";
  }
  onResizeMove(e) {
    if (!this.resizing) return;
    const { key, min, startX, startW } = this.resizing;
    this.colWidths[key] = Math.max(min, startW + (e.clientX - startX));
    this.applyGrid();
  }
  onResizeEnd() {
    if (!this.resizing) return;
    saveWidths(this.colWidths);
    this.resizing = null;
    document.body.style.cursor = "";
  }

  // ------------------------------------------------------------- facets --
  renderFacets(facets) {
    this.facets.innerHTML = "";

    const segs = el("div", "facet-group");
    segs.append(el("h4", null, "Segments"));
    for (const seg of SEGMENTS) {
      const b = el("button", "facet-seg", seg.label);
      b.type = "button";
      b.title = seg.hint;
      b.addEventListener("click", () => this.loadSegment(seg));
      segs.append(b);
    }
    this.facets.append(segs);

    if (this.savedSearches?.length) {
      const saved = el("div", "facet-group");
      saved.append(el("h4", null, "Saved"));
      for (const s of this.savedSearches) {
        const b = el("button", "facet-seg", s.name);
        b.type = "button";
        b.title = `Saved segment. Runs: ${s.query}`;
        b.addEventListener("click", () => {
          this.state.text = s.query;
          this.input.value = s.query;
          this.clearBtn.hidden = !s.query;
          this.run();
        });
        saved.append(b);
      }
      this.facets.append(saved);
    }

    this.facetGroup("Status", "status", facets.status.map((f) => ({ ...f, label: STATUS_LABELS[f.value] })));
    this.facetGroup("Connection strength", "degreeBuckets", facets.degrees);
    this.facetGroup("Relationship", "edgeTypes", facets.edgeTypes);
    this.facetGroup("Organization", "orgs", facets.orgs, true);
    this.facetGroup("Tags", "tags", facets.tags, true);
  }

  /**
   * @param overflowable when true (org/tags), long lists collapse to the top
   * FACET_COLLAPSE with an inline search + "Show all" toggle instead of a popup.
   */
  facetGroup(title, key, values, overflowable = false) {
    const active = this.state.filters[key];
    let shown = values.filter((v) => v.count > 0 || active.includes(v.value));
    if (!shown.length) return;

    const group = el("div", "facet-group");
    group.append(el("h4", null, title));

    const ui = this.facetUI[key];
    let list = shown;
    if (overflowable) {
      if (ui.filter) {
        const q = ui.filter.toLowerCase();
        list = shown.filter((v) => (v.label ?? v.value).toLowerCase().includes(q));
      }
      if (ui.expanded) {
        const search = el("input", "facet-search");
        search.type = "text";
        search.placeholder = `Search ${title.toLowerCase()}…`;
        search.title = `Narrow the ${title.toLowerCase()} list below. This does not filter the table on its own`;
        search.value = ui.filter;
        search.addEventListener("input", () => {
          ui.filter = search.value;
          this.renderFacets(this.lastResponse.facets);
          // keep focus after re-render
          const again = this.facets.querySelector(`[data-facet-search="${key}"]`);
          if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
        });
        search.setAttribute("data-facet-search", key);
        group.append(search);
      } else if (shown.length > FACET_COLLAPSE) {
        list = shown.slice(0, FACET_COLLAPSE);
      }
    }

    const scroll = el("div", overflowable && ui.expanded ? "facet-scroll" : "");
    for (const v of list) {
      const isOn = active.includes(v.value);
      const row = el("label", "facet-row" + (isOn ? " on" : ""));
      const name = v.label ?? v.value;
      row.title = isOn
        ? `Stop filtering by ${name}`
        : `Show only the ${v.count} ${v.count === 1 ? "person" : "people"} matching ${name}`;
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = isOn;
      cb.addEventListener("change", () => this.toggleFacet(key, v.value));
      row.append(cb, el("span", "facet-label", v.label ?? v.value), el("span", "facet-count mono", String(v.count)));
      scroll.append(row);
    }
    group.append(scroll);

    if (overflowable && shown.length > FACET_COLLAPSE) {
      const more = el("button", "facet-more", ui.expanded ? "Show less" : `Show all ${shown.length}`);
      more.type = "button";
      more.title = ui.expanded
        ? `Collapse back to the top ${FACET_COLLAPSE}`
        : `Expand to all ${shown.length}, with a search box`;
      more.addEventListener("click", () => {
        ui.expanded = !ui.expanded;
        if (!ui.expanded) ui.filter = "";
        this.renderFacets(this.lastResponse.facets);
      });
      group.append(more);
    }
    this.facets.append(group);
  }

  toggleFacet(key, value) {
    const arr = this.state.filters[key];
    const i = arr.indexOf(value);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(value);
    this.selected.clear();
    this.run(); // re-run also re-evaluates which columns are visible
  }

  // --------------------------------------------------------------- rows --
  displayResults() {
    const rows = this.lastResponse?.results ?? [];
    if (this.state.scope !== "family") return rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const resultOrder = new Map(rows.map((r, index) => [r.id, index]));
    const children = new Map(), roots = [];
    for (const r of rows) {
      if (r.familyParentId != null && byId.has(r.familyParentId)) {
        if (!children.has(r.familyParentId)) children.set(r.familyParentId, []);
        children.get(r.familyParentId).push(r);
      } else roots.push(r);
    }
    // The service has already sorted the full result set by the selected
    // column. Preserve the family tree shape, but use that order for roots and
    // siblings so every header still has a visible sorting effect.
    const sort = (list) => list.sort((a, b) =>
      Number(b.isOwner) - Number(a.isOwner) || resultOrder.get(a.id) - resultOrder.get(b.id));
    const out = [], seen = new Set();
    const visit = (r, depth) => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      r._familyDepth = depth;
      r._hasFamilyChildren = (children.get(r.id)?.length ?? 0) > 0;
      out.push(r);
      if (!this.familyCollapsed.has(r.id)) for (const child of sort(children.get(r.id) ?? [])) visit(child, depth + 1);
    };
    for (const root of sort(roots)) visit(root, 0);
    for (const r of sort([...rows])) visit(r, 0); // defensive: malformed/cyclic parent data
    return out;
  }

  toggleFamilyBranch(id) {
    this.familyCollapsed.has(id) ? this.familyCollapsed.delete(id) : this.familyCollapsed.add(id);
    this.sizer.style.height = `${this.displayResults().length * ROW_H}px`;
    this.renderRows(); this.renderHead();
  }

  renderRows() {
    const cols = this.visibleColumns();
    const results = this.displayResults();
    const start = Math.max(0, Math.floor(this.scroller.scrollTop / ROW_H) - 5);
    const end = Math.min(results.length, start + Math.ceil(this.scroller.clientHeight / ROW_H) + 10);
    this.rowsEl.style.transform = `translateY(${start * ROW_H}px)`;
    this.rowsEl.innerHTML = "";
    if (!results.length) {
      this.rowsEl.append(el("div", "xp-empty", "No people match these filters."));
      return;
    }
    for (let i = start; i < end; i++) {
      const r = results[i];
      const row = el("div", "xp-row" + (this.selected.has(r.id) ? " sel" : ""));
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = this.selected.has(r.id);
      cb.title = this.selected.has(r.id) ? `Unselect ${r.name}` : `Select ${r.name} for a bulk action`;
      cb.setAttribute("aria-label", cb.title);
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selected.has(r.id) ? this.selected.delete(r.id) : this.selected.add(r.id);
        this.renderRows();
        this.renderBulk();
        this.renderHead();
      });
      const check = el("div", "xp-cell xp-check xp-sticky-check");
      check.append(cb);
      row.append(check);
      for (const col of cols) {
        const cell = col.render(r, this);
        if (col.edit) cell.dataset.editKey = col.key;
        row.append(cell);
      }
      row.addEventListener("click", (e) => {
        if (this.editMode) {
          // A click mid-edit belongs to the editor: let it commit or cancel first.
          if (this._editingCell) return;
          const cellEl = /** @type {HTMLElement|null} */ ((/** @type {HTMLElement} */ (e.target)).closest?.("[data-edit-key]"));
          // An editable column edits in place. A column that cannot be edited
          // here still has somewhere to go: open the contact beside the table,
          // which is what the click does with Edit off. Refusing it and
          // explaining why was strictly less useful than doing the obvious thing.
          if (cellEl) this.beginCellEdit(cellEl, cellEl.dataset.editKey, r);
          else this.handlers.onOpenContact(r.id);
          return;
        }
        this.handlers.onOpenContact(r.id);
      });
      this.rowsEl.append(row);
    }
  }

  /** In-place cell editor (edit mode): Enter/blur commits, Esc cancels.
   *  The controls are the card's OWN editors from field-controls.js - the
   *  phone country widget, the date picker, the gender preset list, the notes
   *  textarea - and every value runs through the shared validation +
   *  normalization, so an Explore edit is byte-identical to a card edit.
   *  Location resolves through the same offline-city-then-geocoder pipeline
   *  the card uses, writing the same resolution keys. */
  async beginCellEdit(cellEl, colKey, r) {
    const col = COLUMNS.find((c) => c.key === colKey);
    if (!col?.edit) return;
    // Rich controls (the phone widget, location resolution, the notes
    // textarea) live in the edit POPUP: a modal is immune to the grid's
    // virtualization, sticky columns, and cell clipping. In-cell editing
    // stays for the simple one-line values.
    if (fieldType(col.edit.field) === "tel" || col.edit.kind === "location" || col.edit.field === "notes") {
      this.editContact(r.id, col.edit.field);
      return;
    }
    // A failure to open the editor must SAY so and must not leave the
    // _editingCell latch stuck (which would silently kill all later edits).
    try {
      this.openCellEditor(cellEl, col, r);
    } catch (err) {
      this._editingCell = false;
      toastError(err);
    }
  }

  /** The edit popup: every supported field on one form, using the SAME shared
   *  controls and validation as the contact card. Reachable from the per-row
   *  pencil with NO mode required, so editing a phone number never depends on
   *  the edit-mode toggle or in-cell layout. `focusKey` preselects a field. */
  async editContact(id, focusKey) {
    let contact;
    try { contact = await api().contacts.get({ id }); } catch (err) { toastError(err); return; }
    if (!contact) { toast("That contact is no longer available."); return; }
    // Distinct existing values power the type-ahead lists, like the sidebar.
    if (!this.fieldValues) {
      try { this.fieldValues = await api().explore.fieldValues({}); } catch { this.fieldValues = {}; }
    }
    const m = openModal({ title: `Edit · ${contact.name}` });
    // Autocomplete datalists for company/role (createControl points inputs at
    // these ids). The contact card builds identically-named ones; only add
    // ours when the card's are not in the DOM.
    if (!document.getElementById("dl-company")) {
      const dls = el("div");
      const mkdl = (dlId, values) => {
        const dl = el("datalist");
        dl.id = dlId;
        for (const v of values ?? []) dl.append(new Option(v));
        dls.append(dl);
      };
      mkdl("dl-company", this.fieldValues?.company);
      mkdl("dl-role", this.fieldValues?.role);
      m.body.append(dls);
    }
    const FIELDS = [
      { key: "name", label: "Name" }, { key: "gender", label: "Gender" },
      { key: "email", label: "Email" }, { key: "phone", label: "Phone" },
      { key: "company", label: "Company" }, { key: "role", label: "Role" },
      { key: "birthday", label: "Birthday" }, { key: "location", label: "Location / address" },
      { key: "nickname", label: "Nickname" }, { key: "website", label: "Website" },
      { key: "linkedin", label: "LinkedIn" }, { key: "notes", label: "Notes" },
    ];
    const grid = el("div", "xp-editform");
    /** @type {Map<string, { ctrl: any }>} */
    const ctrls = new Map();
    for (const f of FIELDS) {
      const val = f.key === "name" ? contact.name : (contact.fields[f.key] ?? "");
      // Location gets the live-suggestion control (bundled cities + online
      // geocoder while typing), same behavior as the sidebar's location row.
      const ctrl = f.key === "location"
        ? createLocationControl(String(val))
        : createControl(f.key, String(val), null);
      const lab = el("label", "xp-editform-key mono", f.label);
      if (f.key === "location") lab.title = "Pick a suggestion to put this contact on the map. Your text is kept exactly as entered either way";
      grid.append(lab, ctrl.element);
      ctrls.set(f.key, { ctrl });
    }
    m.body.append(grid);
    const err = el("p", "field-err");
    err.hidden = true;
    m.body.append(err);

    const cancel = el("button", null, "Cancel");
    cancel.type = "button";
    cancel.title = "Close without saving any of these changes (Esc)";
    cancel.addEventListener("click", () => m.close());
    const save = el("button", "primary", "Save");
    save.type = "button";
    save.title = `Save every field above to ${contact.name}`;
    save.addEventListener("click", async () => {
      err.hidden = true;
      // Validate everything before writing anything.
      const values = new Map();
      for (const [key, { ctrl }] of ctrls) {
        const v = key === "name" ? String(ctrl.read()).trim() : normalizeFieldValue(key, ctrl.read());
        if (key === "name" && !v) { err.textContent = "A contact needs a name."; err.hidden = false; return; }
        if (key !== "name") {
          const msg = validateField(fieldType(key), v);
          if (msg) { err.textContent = `${key}: ${msg}`; err.hidden = false; ctrl.setInvalid(true); return; }
        }
        values.set(key, v);
      }
      save.disabled = true;
      try {
        const fields = { ...contact.fields };
        for (const [key, v] of values) {
          if (key === "name") continue;
          if (v) fields[key] = v;
          else delete fields[key];
        }
        // Location save semantics shared with the card: text as typed, the
        // resolution keys beside it (re-resolved when the text changed or was
        // never mapped), cleared when nothing maps.
        const loc = values.get("location") ?? "";
        if (loc !== (contact.fields.location ?? "") || (loc && !fields.geo)) {
          // A suggestion picked in the control carries its structured match;
          // free-typed text falls back to the shared resolver.
          const locCtrl = /** @type {any} */ (ctrls.get("location")?.ctrl);
          const match = loc ? (locCtrl?.match?.(loc) ?? await resolveLocation(loc)) : null;
          if (match) applyLocationMatch(fields, match);
          else clearLocationResolution(fields);
        }
        await api().contacts.update({ id, patch: { name: values.get("name"), fields } });
        m.close();
        toast("Saved.");
        await this.run();
        await this.handlers.onChanged();
      } catch (e2) {
        save.disabled = false;
        toastError(e2);
      }
    });
    m.foot.append(cancel, save);
    ctrls.get(focusKey && ctrls.has(focusKey) ? focusKey : "name")?.ctrl.focus();
  }

  openCellEditor(cellEl, col, r) {
    this._editingCell = true;
    const field = col.edit.field;
    const isName = col.edit.kind === "name";
    const isLocation = col.edit.kind === "location";
    const current = String((isName ? r.name : r[col.key]) ?? "");

    const ctrl = createControl(isName ? "name" : field, current, null);
    ctrl.element.classList.add("xp-cell-input");
    cellEl.innerHTML = "";
    cellEl.classList.add("xp-cell-editing");
    cellEl.append(ctrl.element);
    ctrl.focus();

    let settled = false;
    const done = () => {
      settled = true;
      this._editingCell = false;
      cellEl.classList.remove("xp-cell-editing");
      this.renderRows(); // repaint from data (commit or cancel alike)
    };
    const commit = async () => {
      if (settled) return;
      const raw = ctrl.read();
      const value = isName ? String(raw).trim() : normalizeFieldValue(field, raw);
      if (value === current || (isName && !value)) { done(); return; } // unchanged, or a name cannot blank
      if (!isName) {
        const msg = validateField(fieldType(field), value);
        if (msg) { ctrl.setInvalid(true); toast(msg); return; } // stay in the editor
      }
      try {
        if (isName) {
          await api().contacts.update({ id: r.id, patch: { name: value } });
        } else {
          // patch.fields replaces the whole map: merge onto the live record so
          // one cell edit can never drop the contact's other fields.
          const contact = await api().contacts.get({ id: r.id });
          if (!contact) { toast("That contact is no longer available."); done(); return; }
          const fields = { ...contact.fields };
          if (value) fields[field] = value;
          else delete fields[field];
          if (isLocation) {
            // Same save semantics as the card: text stays as typed, and the
            // resolution keys ride beside it (or clear when nothing maps).
            const match = value ? await resolveLocation(value) : null;
            if (match) applyLocationMatch(fields, match);
            else clearLocationResolution(fields);
            toast(match ? `Mapped · ${match.precision || "place"}` : value ? "Saved as entered · not mapped" : "Location cleared");
          }
          await api().contacts.update({ id: r.id, patch: { fields } });
        }
        done();
        await this.run();               // fresh projection for the table
        await this.handlers.onChanged(); // graph + counters follow
      } catch (err) {
        done();
        toastError(err);
      }
    };
    ctrl.element.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !ctrl.multiline) { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); done(); }
      e.stopPropagation();
    });
    ctrl.element.addEventListener("click", (e) => e.stopPropagation()); // don't re-enter
    // Commit when focus leaves the WHOLE control: the phone widget moves focus
    // between its own country/area/number parts, and that must not commit.
    ctrl.element.addEventListener("focusout", (e) => {
      const to = /** @type {Node|null} */ (e.relatedTarget);
      if (to && ctrl.element.contains(to)) return;
      commit();
    });
    if (ctrl.isSelect) ctrl.element.addEventListener("change", () => commit()); // picking an option IS the commit
  }

  // --------------------------------------------------------------- bulk --
  matchedIds() { return this.lastResponse?.matchedIds ?? []; }
  targetIds() { return this.selected.size ? [...this.selected] : this.matchedIds(); }

  toggleSelectAll(on) {
    this.selected.clear();
    if (on) for (const r of this.displayResults()) this.selected.add(r.id);
    this.renderRows();
    this.renderBulk();
    this.renderHead();
  }

  renderBulk() {
    const n = this.selected.size;
    this.bulk.innerHTML = "";
    const scopeN = this.targetIds().length;
    if (n) {
      const clearSelection = el("button", "xp-clear-selection", "✕");
      clearSelection.type = "button";
      clearSelection.title = `Unselect ${n} contact${n === 1 ? "" : "s"}`;
      clearSelection.setAttribute("aria-label", clearSelection.title);
      clearSelection.addEventListener("click", () => {
        this.selected.clear();
        this.renderRows();
        this.renderBulk();
        this.renderHead();
      });
      this.bulk.append(clearSelection);
    }
    const scopeEl = el("span", "mono xp-scope", n ? `${n} selected` : `${scopeN.toLocaleString()} in view`);
    // Bulk actions silently target the whole filtered set when nothing is
    // ticked, so say which set the buttons beside this will hit.
    scopeEl.title = n
      ? `The buttons here act on the ${n} selected contact${n === 1 ? "" : "s"}`
      : `Nothing is selected, so the buttons here act on all ${scopeN.toLocaleString()} contacts matching the current filters`;
    this.bulk.append(scopeEl);
    const target = n ? `the ${n} selected contact${n === 1 ? "" : "s"}` : `all ${scopeN.toLocaleString()} contacts in view`;
    /** An icon button: the glyph carries the meaning, the label carries it for
     *  anyone not looking at it. Both are required - an icon with no name is a
     *  guess for a screen reader and for a new user hovering. */
    const iconBtn = (symbol, label, fn, title, cls = "") => {
      const b = el("button", `xp-icon-btn ${cls}`.trim());
      b.type = "button";
      b.innerHTML = `<svg class="view-icon" aria-hidden="true"><use href="#${symbol}"/></svg>`;
      b.setAttribute("aria-label", label);
      b.title = title;
      b.addEventListener("click", fn);
      this.bulk.append(b);
      return b;
    };
    const btn = (text, cls, fn, title) => {
      const b = el("button", cls, text);
      b.type = "button";
      if (title) b.title = title;
      b.addEventListener("click", fn);
      this.bulk.append(b);
    };
    // Star and unstar are one binary offered both ways, so they sit together as
    // a filled star and an outline of the same star.
    iconBtn("ico-star", "Star", () => this.bulkStar(true), `Star ${target}`);
    iconBtn("ico-star-off", "Remove star", () => this.bulkStar(false), `Remove the star from ${target}`);
    btn("Show on graph", "primary", () => this.handlers.onShowOnGraph(this.targetIds()),
      `Switch to the Network view with ${target} highlighted`);
    btn("Add tag…", null, () => this.bulkTag(), `Add one tag to ${target}`);
    const fieldBtn = el("button", null, "Set common field…");
    fieldBtn.type = "button"; fieldBtn.disabled = n === 0;
    fieldBtn.title = n ? "Apply one shared value to the selected contacts" : "Select contacts first";
    fieldBtn.addEventListener("click", () => this.bulkCommonField());
    this.bulk.append(fieldBtn);
    btn("Set cadence…", null, () => this.bulkCadence(),
      `Set how often you mean to be in touch with ${target}`);
    btn("Save as segment…", null, () => this.saveSegment(),
      "Save the current filters under a name, so you can rerun them from the Segments list");
    if (n) {
      btn("Delete", "danger", () => this.bulkDelete(),
        `Move the ${n} selected contact${n === 1 ? "" : "s"} to the trash. You can undo this`);
    }
    // Column chooser + edit mode, pushed to the right end of the toolbar.
    this.bulk.append(el("div", "xp-bulk-spacer"));
    // A pressed toggle, not a label that changes: the pencil stays put and the
    // button itself shows whether editing is on, the way every other toggle in
    // the app does.
    const editBtn = el("button", "xp-icon-btn xp-edit-btn" + (this.editMode ? " active" : ""));
    editBtn.type = "button";
    editBtn.innerHTML = '<svg class="view-icon" aria-hidden="true"><use href="#ico-edit"/></svg>';
    editBtn.setAttribute("aria-label", "Edit cells");
    editBtn.setAttribute("aria-pressed", String(this.editMode));
    editBtn.title = this.editMode
      ? "Editing is ON: click any highlighted value to change it. Click here to go back to browsing."
      : "Edit cells in place: click a value to change it, Enter saves, Esc cancels";
    editBtn.addEventListener("click", () => {
      this.editMode = !this.editMode;
      localStorage.setItem("orbit-explore-edit", this.editMode ? "1" : "0");
      this.root.classList.toggle("xp-editing", this.editMode);
      toast(this.editMode
        ? "Edit mode on - click a value to change it. Rows no longer open the contact."
        : "Edit mode off - clicking a row opens the contact again.");
      this.renderRows();
      this.renderBulk();
    });
    this.bulk.append(editBtn);
    const colsBtn = iconBtn("ico-columns", "Columns", () => this.openColumnMenu(colsBtn),
      "Choose which columns the table shows. Your choice is remembered", "xp-cols-btn");
    colsBtn.setAttribute("aria-haspopup", "true");
    // openColumnMenu keeps this honest; setting it here alone would go stale the
    // moment the menu opened.
    colsBtn.setAttribute("aria-expanded", "false");
  }

  async eachTarget(fn) {
    const ids = this.targetIds().slice(0, config.limits.bulkMax);
    try {
      for (const id of ids) await fn(id);
      await this.run();
      await this.handlers.onChanged();
      return ids;
    } catch (err) {
      // Writes are sequential, so an unexpected mid-batch failure may follow
      // successful earlier writes. Re-query every projection before reporting.
      await this.run();
      await this.handlers.onChanged();
      toastError(err);
      return null;
    }
  }

  async bulkTag() {
    const tag = await promptModal({ title: "Add tag to these people", label: "Tag", confirmLabel: "Add" });
    if (!tag?.trim()) return;
    const clean = tag.trim().toLowerCase();
    const ids = await this.eachTarget(async (id) => {
      const c = await api().contacts.get({ id });
      if (c) await api().contacts.setTags({ id, tags: [...new Set([...(c.tags ?? []), clean])] });
    });
    if (ids) toast(`Tagged ${ids.length} with "${clean}".`);
  }

  /** Bulk "Set common field": one value applied to every selected contact.
   *  The field list, controls, validation, and normalization are the SIDEBAR's
   *  (shared field-controls + field-types), so a bulk write can never produce
   *  a value a card edit could not. Location keeps its bulk extra - a manual
   *  pin on the map - on top of the shared suggestion control. */
  async bulkCommonField() {
    if (!this.selected.size) return;
    if (!this.fieldValues) {
      try { this.fieldValues = await api().explore.fieldValues({}); } catch { this.fieldValues = {}; }
    }
    const choice = await new Promise((resolve) => {
      let settled = false;
      const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
      const m = openModal({ title: `Set a common field for ${this.selected.size} contacts`, onClose: () => settle(null) });

      // Autocomplete datalists (company/role), unless the card's are mounted.
      if (!document.getElementById("dl-company")) {
        const dls = el("div");
        for (const [dlId, values] of [["dl-company", this.fieldValues?.company], ["dl-role", this.fieldValues?.role]]) {
          const dl = el("datalist");
          dl.id = dlId;
          for (const v of values ?? []) dl.append(new Option(v));
          dls.append(dl);
        }
        m.body.append(dls);
      }

      const form = el("div", "bulk-field-form");
      const fieldRow = el("div", "bulk-field-row");
      fieldRow.append(el("label", "xp-editform-key mono", "Field"));
      const field = el("select");
      field.title = "Which field to write on every selected contact";
      for (const [value, label] of [
        ["location", "Location / address"], ["company", "Company"], ["role", "Role"],
        ["gender", "Gender"], ["notes", "Notes (append)"], ["website", "Website"],
        ["linkedin", "LinkedIn"], ["deceased", "Deceased status"],
      ]) field.append(new Option(label, value));
      fieldRow.append(field);
      const valueRow = el("div", "bulk-field-row");
      valueRow.append(el("label", "xp-editform-key mono", "Value"));
      const valueHost = el("div", "bulk-field-value");
      valueRow.append(valueHost);
      form.append(fieldRow, valueRow);
      m.body.append(form,
        el("p", "dim field-hint", "Existing notes are preserved; other fields are replaced (a blank value clears the field). Location resolution is shared across the selection."));
      const err = el("p", "field-err");
      err.hidden = true;
      m.body.append(err);

      /** @type {any} */ let control = null;
      /** @type {any} */ let locCtrl = null;
      let manualMatch = null;
      const hint = el("span", "field-hint location-resolution dim");
      const showHint = (match) => {
        hint.textContent = match
          ? `\u25cf will map \u00b7 ${match.precision || "place"}`
          : "\u25cb saved as typed \u00b7 resolved on apply when possible";
        hint.hidden = false;
      };

      const rebuildControl = () => {
        valueHost.innerHTML = "";
        err.hidden = true;
        manualMatch = null;
        locCtrl = null;
        const key = field.value;
        if (key === "deceased") {
          // Bulk needs the explicit pair, not a checkbox: "mark" vs "clear".
          const sel = el("select", "field-value");
          sel.append(new Option("Mark deceased", "yes"), new Option("Clear deceased status", ""));
          control = { element: sel, read: () => sel.value, focus: () => sel.focus(), setInvalid: () => {} };
          valueHost.append(sel);
        } else if (key === "location") {
          locCtrl = createLocationControl("", { onPick: (mt) => { manualMatch = null; showHint(mt); } });
          control = locCtrl;
          const pin = el("button", null, "Place pin on map\u2026");
          pin.type = "button";
          pin.title = "Pick the exact spot; the typed text stays as the label";
          pin.addEventListener("click", async () => {
            const text = locCtrl.read();
            const base = (text && (locCtrl.match(text) ?? await resolveLocation(text))) || null;
            const initial = base && Number.isFinite(Number(base.lat)) && Number.isFinite(Number(base.lon))
              ? { lat: Number(base.lat), lon: Number(base.lon) } : null;
            const point = await pickLocationOnMap(initial, text);
            if (!point) return;
            manualMatch = {
              ...(base || {}), label: text, place: base?.place || text,
              lat: point.lat, lon: point.lon, precision: "manual", source: "manual-pin",
              components: base?.components || {},
            };
            showHint(manualMatch);
          });
          const meta = el("div", "bulk-field-meta");
          meta.append(hint, pin);
          showHint(null);
          valueHost.append(locCtrl.element, meta);
        } else {
          // The sidebar's own editor for this field: gender preset select,
          // notes textarea, url inputs, company/role datalists.
          control = createControl(key, "", null);
          valueHost.append(control.element);
        }
        control.focus();
      };
      field.addEventListener("change", rebuildControl);

      const cancel = el("button", null, "Cancel");
      cancel.type = "button";
      cancel.title = "Close without changing any of the selected contacts (Esc)";
      cancel.addEventListener("click", () => { m.close(); });
      const apply = el("button", "primary", "Apply to selected");
      apply.type = "button";
      apply.title = `Write this value to all ${this.selected.size} selected contacts`;
      apply.addEventListener("click", async () => {
        err.hidden = true;
        const key = field.value;
        const raw = String(control.read() ?? "");
        // Same canonical form + validators as a sidebar edit.
        const value = key === "notes" ? raw.trim() : normalizeFieldValue(key, raw);
        if (key === "notes" && !value) return;
        if (key !== "deceased" && value) {
          const msg = validateField(fieldType(key), value);
          if (msg) { err.textContent = msg; err.hidden = false; control.setInvalid(true); return; }
        }
        apply.disabled = true;
        let locationMatch = null;
        if (key === "location" && value) {
          locationMatch = manualMatch ?? locCtrl?.match?.(value) ?? await resolveLocation(value);
        }
        settle({ field: key, value, locationMatch });
        m.close();
      });
      m.foot.append(cancel, apply);
      rebuildControl();
    });
    if (!choice) return;

    const done = await this.eachTarget(async (id) => {
      const contact = await api().contacts.get({ id });
      if (!contact) return;
      const fields = { ...contact.fields };
      if (choice.field === "notes") {
        fields.notes = fields.notes ? `${fields.notes.trimEnd()}\n${choice.value}` : choice.value;
      } else if (choice.field === "location") {
        if (choice.value) fields.location = choice.value; else delete fields.location;
        // Shared appliers, so the stored shape matches the card exactly; a
        // manual pin additionally records its coordinates in the resolution.
        if (choice.locationMatch) {
          applyLocationMatch(fields, choice.locationMatch);
          if (choice.locationMatch.source === "manual-pin") {
            const resolved = JSON.parse(fields.locationResolved);
            resolved.manualPin = { lat: choice.locationMatch.lat, lon: choice.locationMatch.lon };
            fields.locationResolved = JSON.stringify(resolved);
          }
        } else clearLocationResolution(fields);
      } else if (choice.value) fields[choice.field] = choice.value;
      else delete fields[choice.field];
      await api().contacts.update({ id, patch: { fields } });
    });
    if (done) toast(`${choice.field === "notes" ? "Appended notes for" : `Updated ${choice.field} for`} ${done.length} contacts.`);
  }

  async bulkCadence() {
    const val = await promptModal({
      title: "Keep-in-touch cadence", label: "Every N days (0 clears)", placeholder: "90", confirmLabel: "Set",
    });
    if (val === null) return;
    const days = parseInt(val, 10);
    if (Number.isNaN(days)) return;
    const ids = await this.eachTarget((id) => api().contacts.update({ id, patch: { cadenceDays: days } }));
    if (ids) toast(days ? `Cadence set for ${ids.length}.` : `Cadence cleared for ${ids.length}.`);
  }

  async bulkStar(on) {
    const ids = await this.eachTarget((id) => api().contacts.update({ id, patch: { starred: on } }));
    if (ids) toast(`${on ? "Starred" : "Unstarred"} ${ids.length}.`);
  }

  async bulkDelete() {
    const ids = [...this.selected];
    try {
      for (const id of ids) await api().contacts.softDelete({ id });
      this.selected.clear();
      await this.run();
      await this.handlers.onChanged();
      toast(`Deleted ${ids.length}. In the trash.`, {
        actionLabel: "Undo",
        onAction: async () => {
          try {
            for (const id of ids) await api().contacts.restore({ id });
            await this.run();
            await this.handlers.onChanged();
          } catch (err) { toastError(err); }
        },
      });
    } catch (err) {
      await this.run();
      await this.handlers.onChanged();
      toastError(err);
    }
  }

  async saveSegment() {
    const name = await promptModal({ title: "Save as segment", label: "Name", confirmLabel: "Save" });
    if (!name?.trim()) return;
    try {
      await api().searches.save({ name: name.trim(), query: this.currentQueryString() });
      await this.loadSaved();
      this.render();
      toast(`Saved segment "${name.trim()}".`);
    } catch (err) { toastError(err); }
  }

  currentQueryString() {
    const parts = [this.state.text.trim()].filter(Boolean);
    for (const o of this.state.filters.orgs) parts.push(`org:${quote(o)}`);
    for (const t of this.state.filters.tags) parts.push(`tag:${quote(t)}`);
    for (const e of this.state.filters.edgeTypes) parts.push(`type:${e}`);
    if (this.state.filters.status.includes("hasEmail")) parts.push("has:email");
    return parts.join(" ") || "*";
  }

  async loadSaved() {
    try {
      this.savedSearches = await api().searches.list({});
    } catch {
      this.savedSearches = [];
    }
  }
}

const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
function structuredCloneLite(o) { return JSON.parse(JSON.stringify(o ?? {})); }

function loadWidths() {
  try {
    return { ...JSON.parse(localStorage.getItem("orbit-xp-cols") || "{}") };
  } catch {
    return {};
  }
}
function saveWidths(w) {
  try { localStorage.setItem("orbit-xp-cols", JSON.stringify(w)); } catch {}
}

/** @returns {Set<string> | null} user's chosen columns, or null for defaults */
function loadVisible() {
  try {
    const raw = localStorage.getItem("orbit-xp-visible");
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : null;
  } catch { return null; }
}
function saveVisible(set) {
  try { localStorage.setItem("orbit-xp-visible", JSON.stringify([...set])); } catch {}
}

/** @returns {string[]} movable column keys in the user's preferred order */
function loadOrder() {
  try {
    const value = JSON.parse(localStorage.getItem("orbit-xp-order") || "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((key) => typeof key === "string"))]
      : [];
  } catch { return []; }
}
function saveOrder(order) {
  try { localStorage.setItem("orbit-xp-order", JSON.stringify(order)); } catch {}
}
