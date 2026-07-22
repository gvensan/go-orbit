// insights.js - the Insights content-pane page: network intelligence computed
// locally (insights:extended) plus an interactive "break down by" facility for
// extracting distributions across any dimension.

import { el } from "./modal.js";
import { toastError } from "./toast.js";

const api = () => window.api;
const fmtDays = (ts) => (ts ? `${Math.floor((Date.now() - ts) / 86400000)}d ago` : "never");

const BREAKDOWN_DIMS = [
  ["org", "Organization"], ["role", "Role"], ["gender", "Gender"],
  ["tags", "Tag"], ["edgeType", "Relationship"], ["cadence", "Cadence"],
];

export class InsightsView {
  /** @param {HTMLElement} root, { onOpenContact } */
  constructor(root, { onOpenContact }) {
    this.root = root;
    this.onOpenContact = onOpenContact;
  }

  async refresh() {
    let x;
    try {
      x = await api().insightsExt.extended({});
    } catch (err) {
      toastError(err);
      return;
    }
    this.root.innerHTML = "";
    const page = el("div", "insights-page");
    this.root.append(page);

    // --- top stat tiles ---
    const tiles = el("div", "stat-tiles");
    const tile = (num, label) => {
      const t = el("div", "stat-tile");
      t.append(el("div", "stat-num", num), el("div", "stat-label mono", label));
      tiles.append(t);
    };
    tile(x.contacts.toLocaleString(), "contacts");
    tile(x.edges.toLocaleString(), "connections");
    tile(String(x.connectivity.avgDegree), "avg connections");
    tile(String(x.connectivity.hubs), "hubs (20+)");
    tile(String(x.connectivity.isolated), "isolated");
    tile(`${x.cadence.withCadence}`, "with cadence");
    tile(String(x.overdue.length), "overdue");
    tile(String(x.missing.email), "no email");
    page.append(tiles);

    const grid = el("div", "insights-grid");
    page.append(grid);

    // --- needs attention ---
    const attn = this.card("Needs attention");
    if (!x.overdue.length && !x.dormant.length) {
      attn.append(el("p", "dim", "Nobody is overdue. Set a keep-in-touch cadence to get nudges."));
    }
    for (const o of x.overdue.slice(0, 8)) {
      this.personRow(attn, o.id, o.name, `${o.overdueDays}d overdue · every ${o.cadenceDays}d`, "overdue");
    }
    for (const d of x.dormant.slice(0, 6)) {
      this.personRow(attn, d.id, d.name, `well-connected, last ${fmtDays(d.lastAt)}`, `${d.degree}°`);
    }
    grid.append(attn);

    // --- top connectors ---
    const conn = this.card("Top connectors");
    for (const c of x.connectors) this.personRow(conn, c.id, c.name, "knows the most people", `${c.degree}°`);
    grid.append(conn);

    // --- recently added ---
    const recent = this.card("Recently added");
    for (const r of x.recentlyAdded) this.personRow(recent, r.id, r.name, r.org ?? "", fmtDays(r.createdAt));
    grid.append(recent);

    // --- distributions ---
    grid.append(this.distCard("Organizations", x.orgs, x.contacts));
    grid.append(this.distCard("Roles", x.roles, x.contacts));
    grid.append(this.distCard("Gender", x.gender, x.contacts));
    grid.append(this.distCard("Relationship types", x.edgeTypes, null));
    grid.append(this.distCard("Top tags", x.tags, null));

    // --- interactive breakdown ("extract insights over and above") ---
    const bk = this.card("Break down by…");
    const sel = el("select");
    for (const [k, label] of BREAKDOWN_DIMS) sel.append(new Option(label, k));
    const out = el("div", "breakdown-out");
    sel.addEventListener("change", () => this.renderBreakdown(out, sel.value));
    bk.append(sel, out);
    this.renderBreakdown(out, "org");
    grid.append(bk);
  }

  card(title) {
    const c = el("div", "insight-card");
    c.append(el("h3", null, title));
    return c;
  }

  personRow(card, id, name, sub, meta) {
    const row = el("button", "conn-row");
    row.type = "button";
    row.append(el("span", null, name));
    if (sub) row.append(el("span", "row-sub dim", sub));
    if (meta) row.append(el("span", "conn-degree mono", String(meta)));
    row.addEventListener("click", () => this.onOpenContact(id));
    card.append(row);
  }

  distCard(title, values, total) {
    const c = this.card(title);
    if (!values?.length) { c.append(el("p", "dim", "No data.")); return c; }
    const max = Math.max(...values.map((v) => v.count));
    for (const v of values) {
      const row = el("div", "dist-row");
      const bar = el("div", "dist-bar");
      const fill = el("div", "dist-fill");
      fill.style.width = `${(v.count / max) * 100}%`;
      bar.append(fill);
      row.append(
        el("span", "dist-label", v.label ?? v.value),
        bar,
        el("span", "dist-count mono", total ? `${v.count} · ${Math.round((v.count / total) * 100)}%` : String(v.count))
      );
      c.append(row);
    }
    return c;
  }

  async renderBreakdown(out, dimension) {
    out.innerHTML = "";
    try {
      const b = await api().insightsExt.breakdown({ dimension });
      if (!b.values.length) { out.append(el("p", "dim", "No data for this dimension.")); return; }
      const max = Math.max(...b.values.map((v) => v.count));
      for (const v of b.values) {
        const row = el("div", "dist-row");
        const bar = el("div", "dist-bar");
        const fill = el("div", "dist-fill");
        fill.style.width = `${(v.count / max) * 100}%`;
        bar.append(fill);
        row.append(el("span", "dist-label", v.value), bar, el("span", "dist-count mono", String(v.count)));
        out.append(row);
      }
      if (b.unset) out.append(el("p", "mono dim", `${b.unset} without a value`));
    } catch (err) {
      toastError(err);
    }
  }
}
