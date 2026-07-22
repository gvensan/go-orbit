// explore.js - the content-pane faceted people-search view. Query bar + facets
// rail + a data table with resizable, sortable, facet-aware columns. The query
// bar and facets share one filter state (operators check facets and vice
// versa); results drive the graph and bulk actions over the whole matched set.

import config from "../main/config.js";
import { el, openModal, promptModal } from "./modal.js";
import { CITIES, CITY_COORDS } from "../shared/cities.js";
import { pickLocationOnMap } from "./location-picker.js";
import { toast, toastError } from "./toast.js";

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
  { label: "Everyone", filters: {}, sort: "name" },
  { label: "Needs attention", filters: { status: ["overdue", "dormant"] }, sort: "overdue" },
  { label: "Starred", filters: { status: ["starred"] }, sort: "name" },
  { label: "Dormant connectors", filters: { status: ["dormant"], degreeBuckets: ["hub", "connected"] }, sort: "degree" },
  { label: "Missing email", filters: {}, sort: "name", exclude: { hasEmail: true } },
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
      return c;
    } },
  { key: "nickname", label: "Nickname", group: "Identity", sort: "nickname", w: 120, min: 80, render: (r) => textCell(r.nickname) },
  { key: "gender", label: "Gender", group: "Identity", sort: "gender", w: 90, min: 60, render: (r) => textCell(r.gender) },
  { key: "birthday", label: "Birthday", group: "Identity", sort: "birthday", w: 110, min: 90, render: (r) => dateCell(r.birthday) },
  { key: "deceased", label: "Deceased", group: "Identity", sort: "deceased", w: 86, min: 70, render: (r) => boolCell(r.deceased) },
  { key: "email", label: "Email", group: "Contact", sort: "email", facet: (f) => f.status.includes("hasEmail"), w: 200, min: 120, render: (r) => textCell(r.email, "mono dim") },
  { key: "phone", label: "Phone", group: "Contact", sort: "phone", facet: (f) => f.status.includes("hasPhone"), w: 150, min: 100, render: (r) => textCell(r.phone, "mono dim") },
  { key: "org", label: "Company", group: "Work", sort: "org", base: true, w: 170, min: 100, render: (r) => textCell(r.org) },
  { key: "role", label: "Role", group: "Work", sort: "role", w: 150, min: 90, render: (r) => textCell(r.role) },
  { key: "location", label: "Location entered", group: "Location", sort: "location", w: 190, min: 110, render: (r) => textCell(r.location) },
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
  { key: "notes", label: "Notes", group: "Activity", sort: "notes", w: 240, min: 120, render: (r) => textCell(r.notes) },
  { key: "last", label: "Last interaction", group: "Activity", sort: "recent", base: true, w: 110, min: 82, render: (r) => textCell(fmtLast(r.lastAt), "mono dim") },
  { key: "lastKind", label: "Last type", group: "Activity", sort: "lastKind", w: 90, min: 70, render: (r) => textCell(r.lastKind) },
  { key: "lastNote", label: "Last interaction note", group: "Activity", sort: "lastNote", w: 220, min: 120, render: (r) => textCell(r.lastNote) },
  { key: "interactionCount", label: "Interactions", group: "Activity", sort: "interactionCount", w: 90, min: 70, render: (r) => textCell(r.interactionCount, "mono dim") },
  { key: "cadenceDays", label: "Cadence", group: "Activity", sort: "cadenceDays", w: 90, min: 70, render: (r) => textCell(r.cadenceDays ? `${r.cadenceDays}d` : "—", "mono dim") },
  { key: "starred", label: "Starred", group: "Activity", sort: "starred", w: 76, min: 60, render: (r) => boolCell(r.starred, "★") },
  { key: "website", label: "Website", group: "Web", sort: "website", w: 190, min: 110, render: (r) => textCell(r.website, "mono dim") },
  { key: "linkedin", label: "LinkedIn", group: "Web", sort: "linkedin", w: 190, min: 110, render: (r) => textCell(r.linkedin, "mono dim") },
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
    const bar = el("div", "xp-bar");
    this.input = el("input");
    this.input.type = "text";
    this.input.placeholder = "Filter people…  try  org:acme  tag:vip  has:email  near:\"Bo\" hops:2";
    this.scopeToggle = el("div", "xp-scope-toggle");
    for (const [value, label] of [["all", "ALL"], ["family", "FAMILY"], ["friends", "FRIENDS"]]) {
      const b = el("button", null, label); b.type = "button"; b.dataset.scope = value;
      b.addEventListener("click", () => {
        if (this.state.scope === value) return;
        this.state.scope = /** @type {"all"|"family"|"friends"} */ (value); this.selected.clear(); this.scroller.scrollTop = 0; this.run();
      });
      this.scopeToggle.append(b);
    }
    this.count = el("span", "xp-count mono");
    bar.append(this.input, this.scopeToggle, this.count);
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
    if (this._colMenu) { this._colMenu.remove(); this._colMenu = null; return; }
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
        labelBtn.addEventListener("click", () => this.sortBy(col));
      } else {
        labelBtn.disabled = true;
      }
      cell.append(labelBtn);
      // Resize grip on the right edge (all but a trailing tiny column).
      const grip = el("div", "xp-resize");
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
        b.title = s.query;
        b.addEventListener("click", () => {
          this.state.text = s.query;
          this.input.value = s.query;
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
      for (const col of cols) row.append(col.render(r, this));
      row.addEventListener("click", () => this.handlers.onOpenContact(r.id));
      this.rowsEl.append(row);
    }
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
    this.bulk.append(el("span", "mono xp-scope", n ? `${n} selected` : `${scopeN.toLocaleString()} in view`));
    const btn = (text, cls, fn) => {
      const b = el("button", cls, text);
      b.type = "button";
      b.addEventListener("click", fn);
      this.bulk.append(b);
    };
    btn("Show on graph", "primary", () => this.handlers.onShowOnGraph(this.targetIds()));
    btn("Add tag…", null, () => this.bulkTag());
    const fieldBtn = el("button", null, "Set common field…");
    fieldBtn.type = "button"; fieldBtn.disabled = n === 0;
    fieldBtn.title = n ? "Apply one shared value to the selected contacts" : "Select contacts first";
    fieldBtn.addEventListener("click", () => this.bulkCommonField());
    this.bulk.append(fieldBtn);
    btn("Set cadence…", null, () => this.bulkCadence());
    btn("Star", null, () => this.bulkStar(true));
    btn("Unstar", null, () => this.bulkStar(false)); // binary option, both ways
    btn("Save as segment…", null, () => this.saveSegment());
    if (n) {
      btn("Delete", "danger", () => this.bulkDelete());
    }
    // Column chooser, pushed to the right end of the toolbar.
    this.bulk.append(el("div", "xp-bulk-spacer"));
    const colsBtn = el("button", "xp-cols-btn", "Columns ▾");
    colsBtn.type = "button";
    colsBtn.addEventListener("click", () => this.openColumnMenu(colsBtn));
    this.bulk.append(colsBtn);
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

  async bulkCommonField() {
    if (!this.selected.size) return;
    const choice = await new Promise((resolve) => {
      let settled = false;
      const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
      const m = openModal({ title: `Set a common field for ${this.selected.size} contacts`, onClose: () => settle(null) });
      const fieldRow = el("div", "form-row"); fieldRow.append(el("label", null, "Field"));
      const field = el("select");
      for (const [value, label] of [
        ["location", "Location / address"], ["company", "Company"], ["role", "Role"],
        ["gender", "Gender"], ["notes", "Notes (append)"], ["website", "Website"],
        ["linkedin", "LinkedIn"], ["deceased", "Deceased status"],
      ]) field.append(new Option(label, value));
      fieldRow.append(field);
      const valueRow = el("div", "form-row"); valueRow.append(el("label", null, "Value"));
      let control;
      let controlHost;
      let locationMatch = null;
      let locationTimer = null;
      let locationQuery = 0;
      let onlineLocation = false;
      let resolveLocationControl = async () => null;
      let getLocationMatch = () => null;
      const onlineLocationReady = api().location.online({}).then(
        (result) => { onlineLocation = !!result.enabled; },
        () => { onlineLocation = false; }
      );

      const offlineMatch = (value) => CITY_COORDS[value]
        ? { label: value, place: value, lat: CITY_COORDS[value][0], lon: CITY_COORDS[value][1], precision: "city", source: "offline-city", components: {} }
        : null;

      const buildLocationControl = () => {
        const editor = el("div", "bulk-location-editor");
        const wrap = el("div", "location-input-wrap");
        const input = /** @type {HTMLInputElement} */ (el("input"));
        input.type = "text";
        input.placeholder = "City, neighborhood, or full address";
        input.autocomplete = "off";
        input.setAttribute("role", "combobox");
        input.setAttribute("aria-autocomplete", "list");
        input.setAttribute("aria-expanded", "false");
        const menu = el("div", "location-suggestions");
        menu.id = `bulk-location-suggestions-${Date.now()}`;
        menu.setAttribute("role", "listbox");
        menu.hidden = true;
        input.setAttribute("aria-controls", menu.id);
        wrap.append(input, menu);
        const resolution = el("span", "field-hint location-resolution dim", "Enter a location to resolve it");
        const pin = el("button", "location-pin-btn", "Place pin on map");
        pin.type = "button";
        pin.disabled = true;
        const meta = el("div", "bulk-location-meta");
        meta.append(resolution, pin);
        editor.append(wrap, meta);

        const matchesByLabel = new Map();
        let suggestions = [];
        let active = -1;
        const showResolution = (match, state = "") => {
          resolution.className = `field-hint location-resolution ${match ? "is-mapped" : "dim"}`;
          resolution.textContent = state || (match
            ? `● mapped · ${match.precision || "place"}${match.place && match.place !== input.value.trim() ? ` · ${match.place}` : ""}`
            : input.value.trim() ? "○ saved as entered · not mapped" : "Enter a location to resolve it");
          pin.textContent = match ? "Adjust pin on map" : "Place pin on map";
          pin.disabled = !input.value.trim();
        };
        const hideSuggestions = () => {
          menu.hidden = true;
          input.setAttribute("aria-expanded", "false");
          input.removeAttribute("aria-activedescendant");
          active = -1;
        };
        const chooseSuggestion = (index) => {
          const match = suggestions[index];
          if (!match) return;
          input.value = match.label;
          locationMatch = match;
          matchesByLabel.set(match.label, match);
          hideSuggestions();
          showResolution(match);
        };
        const renderSuggestions = (items) => {
          suggestions = items.slice(0, 8);
          active = -1;
          menu.innerHTML = "";
          for (const [index, match] of suggestions.entries()) {
            const option = el("button", "location-suggestion");
            option.type = "button";
            option.id = `${menu.id}-${index}`;
            option.setAttribute("role", "option");
            option.append(
              el("span", "location-suggestion-label", match.label),
              el("span", "location-suggestion-kind", match.precision || "place"),
            );
            option.addEventListener("mousedown", (event) => event.preventDefault());
            option.addEventListener("click", () => chooseSuggestion(index));
            menu.append(option);
          }
          menu.hidden = !suggestions.length;
          input.setAttribute("aria-expanded", String(!!suggestions.length));
        };
        const showMessage = (message) => {
          suggestions = []; active = -1; menu.innerHTML = "";
          menu.append(el("div", "location-suggestion-message dim", message));
          menu.hidden = false;
          input.setAttribute("aria-expanded", "false");
        };
        const setActive = (index) => {
          if (!suggestions.length) return;
          active = (index + suggestions.length) % suggestions.length;
          [...menu.children].forEach((node, i) => {
            node.classList.toggle("active", i === active);
            node.setAttribute("aria-selected", String(i === active));
          });
          const node = menu.children[active];
          if (node) {
            input.setAttribute("aria-activedescendant", node.id);
            node.scrollIntoView({ block: "nearest" });
          }
        };
        const resolveLocation = async () => {
          const value = input.value.trim();
          if (!value) { locationMatch = null; showResolution(null); return null; }
          let match = matchesByLabel.get(value) || offlineMatch(value);
          if (!match && navigator.onLine) {
            await onlineLocationReady;
            if (onlineLocation) {
              showResolution(null, "resolving address…");
              try { match = (await api().location.search({ query: value }))?.[0] ?? null; } catch { /* preserve free text */ }
            }
          }
          locationMatch = match;
          if (match) matchesByLabel.set(value, match);
          showResolution(match);
          return match;
        };

        input.addEventListener("input", () => {
          locationMatch = null;
          showResolution(null);
          const query = input.value.trim();
          const queryId = ++locationQuery;
          if (locationTimer) clearTimeout(locationTimer);
          if (query.length < 2) { hideSuggestions(); return; }
          const needle = query.toLocaleLowerCase();
          const local = CITIES
            .filter((name) => CITY_COORDS[name] && name.toLocaleLowerCase().includes(needle))
            .slice(0, 8)
            .map((label) => offlineMatch(label));
          for (const match of local) matchesByLabel.set(match.label, match);
          if (local.length) renderSuggestions(local);
          else if (onlineLocation && navigator.onLine) showMessage("Searching addresses…");
          else showMessage("No offline city match · enable online location search for addresses");
          locationTimer = setTimeout(async () => {
            if (!navigator.onLine) return;
            await onlineLocationReady;
            if (!onlineLocation) return;
            try {
              const remote = await api().location.search({ query });
              if (queryId !== locationQuery) return;
              const merged = [...(remote || []), ...local].filter((match, index, all) =>
                all.findIndex((other) => other.label.toLocaleLowerCase() === match.label.toLocaleLowerCase()) === index
              );
              for (const match of merged) matchesByLabel.set(match.label, match);
              if (merged.length) renderSuggestions(merged);
              else showMessage("No matching address found · your text can still be saved");
            } catch { /* local suggestions remain usable */ }
          }, 280);
        });
        input.addEventListener("blur", () => setTimeout(hideSuggestions, 120));
        input.addEventListener("keydown", (event) => {
          if (event.key === "ArrowDown" && suggestions.length && !menu.hidden) {
            event.preventDefault(); setActive(active + 1);
          } else if (event.key === "ArrowUp" && suggestions.length && !menu.hidden) {
            event.preventDefault(); setActive(active < 0 ? suggestions.length - 1 : active - 1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (!menu.hidden && active >= 0) chooseSuggestion(active);
            else { hideSuggestions(); resolveLocation(); }
          } else if (event.key === "Escape") hideSuggestions();
        });
        pin.addEventListener("click", async () => {
          const match = locationMatch || await resolveLocation();
          const initial = match && Number.isFinite(Number(match.lat)) && Number.isFinite(Number(match.lon))
            ? { lat: Number(match.lat), lon: Number(match.lon) } : null;
          const point = await pickLocationOnMap(initial, input.value.trim());
          if (!point) return;
          locationMatch = {
            ...(match || {}), label: input.value.trim(), place: match?.place || input.value.trim(),
            lat: point.lat, lon: point.lon, precision: "manual", source: "manual-pin",
            components: match?.components || {},
          };
          matchesByLabel.set(input.value.trim(), locationMatch);
          showResolution(locationMatch);
        });
        resolveLocationControl = resolveLocation;
        getLocationMatch = () => locationMatch;
        return { editor, input };
      };

      const rebuildControl = () => {
        controlHost?.remove();
        if (locationTimer) clearTimeout(locationTimer);
        locationMatch = null;
        if (field.value === "gender") {
          control = el("select");
          for (const [value, label] of [["", "Clear"], ["Female", "Female"], ["Male", "Male"]]) control.append(new Option(label, value));
        } else if (field.value === "deceased") {
          control = el("select"); control.append(new Option("Mark deceased", "yes"), new Option("Clear deceased status", ""));
        } else if (field.value === "notes") {
          control = el("textarea"); control.rows = 4; control.placeholder = "This text is appended to each selected contact's existing notes";
        } else if (field.value === "location") {
          const locationControl = buildLocationControl();
          control = locationControl.input;
          controlHost = locationControl.editor;
        } else {
          control = el("input"); control.type = "text";
          control.placeholder = "Blank clears this field";
        }
        if (!controlHost) controlHost = control;
        valueRow.append(controlHost); control.focus();
      };
      field.addEventListener("change", rebuildControl);
      m.body.append(fieldRow, valueRow, el("p", "dim field-hint", "Existing notes are preserved; other fields are replaced. Location resolution is shared across the selection."));
      const cancel = el("button", null, "Cancel"); cancel.type = "button";
      const apply = el("button", "primary", "Apply to selected"); apply.type = "button";
      m.foot.append(cancel, apply);
      cancel.addEventListener("click", () => m.close());
      apply.addEventListener("click", async () => {
        const value = String(control?.value ?? "").trim();
        if (field.value === "notes" && !value) return;
        apply.disabled = true;
        let resolvedLocation = null;
        if (field.value === "location" && value) {
          resolvedLocation = getLocationMatch() || await resolveLocationControl();
        }
        settle({ field: field.value, value, locationMatch: resolvedLocation }); m.close();
      });
      rebuildControl();
    });
    if (!choice) return;

    const locationMatch = choice.locationMatch || null;
    const done = await this.eachTarget(async (id) => {
      const contact = await api().contacts.get({ id });
      if (!contact) return;
      const fields = { ...contact.fields };
      if (choice.field === "notes") {
        fields.notes = fields.notes ? `${fields.notes.trimEnd()}\n${choice.value}` : choice.value;
      } else if (choice.field === "location") {
        if (choice.value) fields.location = choice.value; else delete fields.location;
        if (locationMatch) {
          fields.geo = `${locationMatch.lat},${locationMatch.lon}`;
          fields.place = locationMatch.place || locationMatch.label;
          fields.locationPrecision = locationMatch.precision || "place";
          fields.locationSource = locationMatch.source || "photon";
          const resolved = { v: 1, components: locationMatch.components || {}, osm: locationMatch.osm };
          if (locationMatch.source === "manual-pin") resolved.manualPin = { lat: locationMatch.lat, lon: locationMatch.lon };
          fields.locationResolved = JSON.stringify(resolved);
        } else for (const key of ["geo", "place", "locationPrecision", "locationSource", "locationResolved"]) delete fields[key];
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
