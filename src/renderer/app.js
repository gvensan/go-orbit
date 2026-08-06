// app.js - the shell controller: snapshot state, graph modes, contact card,
// palette, keyboard model, modals (import wizard, trash, dedup), and the
// undo-first delete flow.

import { CITY_COORDS } from "../shared/cities.js";
import { ContactCard } from "./card.js";
import { EDGE_COLORS, EDGE_TYPES } from "./colors.js";
import { ExploreView } from "./explore.js";
import { GeoMap } from "./geomap.js";
import { FindView } from "./find.js";
import { GraphView, renderLegend, renderClusterLegend } from "./graph-view.js";
import { InsightsView } from "./insights.js";
import { confirmModal, el, openModal, promptModal } from "./modal.js";
import { Palette } from "./palette.js";
import { disposeSettings, renderSettings } from "./settings.js";
import { toast, toastError } from "./toast.js";
import { hideTooltip, installTooltips } from "./tooltip.js";
import { openDedupQueue, openRelationshipPicker, openTrash } from "./views.js";
import { openImportWizard } from "./wizard.js";

const $ = (id) => document.getElementById(id);
const api = window.api;
const IS_MAC = navigator.platform.startsWith("Mac");
const shortcut = (key) => IS_MAC ? `⌘${key}` : `Ctrl+${key}`;

// Carry existing local preferences into Orbit's namespace once, then remove
// the superseded keys. This keeps the rebrand from resetting users' UI state.
for (const [legacyKey, orbitKey] of [
  ["cg-sidebar", "orbit-sidebar"],
  ["cg-theme", "orbit-theme"],
  ["cg-onboarded", "orbit-onboarded"],
  ["cg-phone-country", "orbit-phone-country"],
  ["cg-gender-ring", "orbit-gender-ring"],
  ["cg-minimap", "orbit-minimap"],
  ["cg-xp-cols", "orbit-xp-cols"],
  ["cg-xp-visible", "orbit-xp-visible"],
  ["cg-xp-order", "orbit-xp-order"],
]) {
  try {
    const value = localStorage.getItem(legacyKey);
    if (value != null && localStorage.getItem(orbitKey) == null) {
      localStorage.setItem(orbitKey, value);
    }
    localStorage.removeItem(legacyKey);
  } catch {}
}

const state = {
  /** @type {number | null} */ selectedId: null,
  /** @type {string | null} */ selectedName: null,
  depth: 1,
  contactCount: 0,
};

let graphView, card, palette, explore, find, insights, geomap;
let lastSnapshot = null;
let currentView = "graph"; // "graph" | "explore" | "find" | "insights" | "settings" | "geomap"
const CONTENT_VIEWS = ["graph", "explore", "find", "insights", "settings", "geomap"];
// Drill-down navigation history. Each entry is a restorer for a place we can
// go back to (a focused contact, or a top-level view). Drilling into a node
// pushes the current place; the on-canvas Back button pops one step.
/** @type {{ label: string, run: () => void }[]} */
let navStack = [];

function updateBackButton() {
  const top = navStack[navStack.length - 1];
  $("graph-back").textContent = top ? `← Back to ${top.label}` : "← Back";
  $("graph-back").title = top ? `Go back one step, to ${top.label}` : "Go back one step";
  $("graph-nav").hidden = navStack.length === 0;
  clearNavFocus(); // any navigation drops the drilled-into label until a new one is set
}

/** Show the name of what we've drilled into (e.g. an opened cluster) next to Back. */
function setNavFocus(label) {
  const el = $("graph-nav-focus");
  if (!el) return;
  el.textContent = label || "";
  el.title = label ? `You are looking at ${label}` : "";
  el.hidden = !label;
}
function clearNavFocus() {
  const el = $("graph-nav-focus");
  if (el) { el.hidden = true; el.textContent = ""; }
}

/** Snapshot where we are right now as a restorer we can return to. */
function snapshotLocation() {
  if (currentView === "explore") return { label: "Explore", run: () => openList() };
  if (currentView === "find") return { label: "Find", run: () => openFind() };
  if (currentView === "insights") return { label: "Insights", run: () => openInsightsPage() };
  if (state.selectedId != null) {
    const id = state.selectedId, depth = state.depth, name = state.selectedName || "back";
    return { label: name, run: () => selectContact(id, { depth }) };
  }
  if (graphView.mode === "mesh") return { label: "Full mesh", run: () => showMeshGraph() };
  if (graphView.mode === "orbit") return { label: "Orbit", run: () => showOrbitGraph() };
  if (graphView.mode === "reach") return { label: "Reach", run: () => showReachGraph() };
  if (graphView.mode === "cluster") return { label: "Clusters", run: () => showClusterGraph() };
  if (graphView.mode === "tree") return { label: "Tree", run: () => showTreeGraph() };
  return { label: "Home", run: () => goHome() };
}

/** Push the current location so Back can return to it. */
function pushNav() {
  navStack.push(snapshotLocation());
  updateBackButton();
}

/** Go back one step in the drill-down history. */
function popNav() {
  const prev = navStack.pop();
  updateBackButton();
  prev?.run();
}

/** Clear history - a fresh start on a top-level view switch. */
function resetNav() {
  navStack = [];
  updateBackButton();
}

function setActiveViewSwitch(id) {
  document.querySelectorAll(".view-switch button").forEach((el) => {
    const b = /** @type {HTMLElement} */ (el);
    const active = b.dataset.view === id;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
}

/** The on-canvas Graph|Mesh|Orbit toggle: `which` is "graph" | "mesh" | "orbit". */
function setCanvasView(which) {
  document.querySelectorAll("#canvas-view-toggle button[data-canvas]").forEach((el) => {
    const b = /** @type {HTMLElement} */ (el);
    const active = b.dataset.canvas === which;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  $("orbit-controls").hidden = which !== "orbit"; // metric switch is Orbit-only
  $("tree-controls").hidden = which !== "tree";   // expand/collapse-all is Tree-only
  $("tree-anchor").hidden = which !== "tree";     // anchor combobox is Tree-only
  if (which === "tree") refreshTreeAnchor();
  // The Tree is family-only, so the relationship legend doesn't apply there.
  // (Cluster keeps it - its meta-edges carry the underlying relationship types.)
  const noLegend = which === "tree";
  $("legend").hidden = noLegend;
  // The gender legend applies wherever contacts are drawn as themselves - Tree
  // included. Only Cluster is out: a bubble is a mixed group, so there is no
  // gender ring to filter on.
  $("legend-gender").hidden = which === "cluster";
  $("legend-cluster").hidden = which !== "cluster"; // person/org legend is Cluster-only
}

function showView(view) {
  // Panes are hidden rather than removed, so an open tooltip's anchor stays in
  // the DOM and the MutationObserver would not catch it. Drop it here instead.
  hideTooltip();
  dismissLanding(); // any explicit view switch leaves the start screen
  if (currentView === "settings" && view !== "settings") disposeSettings($("settings"));
  currentView = view;
  $("graph-wrap").hidden = view !== "graph";
  $("explore").hidden = view !== "explore";
  $("find").hidden = view !== "find";
  $("insights").hidden = view !== "insights";
  $("settings").hidden = view !== "settings";
  $("geomap").hidden = view !== "geomap";
  // The graph canvas lives under the "Network" umbrella button in the top bar.
  setActiveViewSwitch(view === "graph" ? "network" : view);
  if (view === "explore") {
    explore.loadSaved().then(() => explore.run());
    explore.focus();
  } else if (view === "find") {
    find.focus();
  } else if (view === "insights") {
    insights.refresh();
  } else if (view === "geomap") {
    geomap.show();
  }
}

let countsText = "";
let backupText = "";

function renderStatus() {
  $("status").textContent = [countsText, backupText].filter(Boolean).join(" · ");
}

/** Amber badge on the sidebar's Insights entry: how many people need you. */
async function refreshAttentionBadge() {
  try {
    const s = await api.insights.summary({});
    const n = s.overdue.length + s.dormant.length;
    const badge = $("attention-badge");
    badge.hidden = n === 0;
    badge.textContent = String(n);
    badge.title = `${n} ${n === 1 ? "person needs" : "people need"} attention: overdue or dormant`;
  } catch {}
}

/** Ambient "new version" hint: a top-bar pill + a dot on the Settings entry.
 *  Driven by pushed update-state changes from the main-process updater (which
 *  checks on launch and every few hours). Only surfaces once an update is
 *  downloading or ready; silent otherwise. */
let lastUpdateState = null;
function renderUpdateHint(state) {
  lastUpdateState = state;
  const pill = $("update-pill");
  const dot = $("update-dot");
  const v = state?.availableVersion ? `v${state.availableVersion}` : "update";
  const ready = state?.phase === "ready";
  const downloading = state?.phase === "downloading";
  const show = ready || downloading;
  pill.hidden = !show;
  dot.hidden = !show;
  pill.classList.toggle("ready", ready);
  if (!show) return;
  if (ready) {
    pill.textContent = `↑ ${v} ready · Restart`;
    pill.title = "A new version is ready. Click to restart and update now (it also installs automatically on quit).";
  } else {
    pill.textContent = `↓ Downloading ${v}…`;
    pill.title = "A new version is downloading in the background.";
  }
  dot.title = ready ? `${v} is ready to install` : `${v} is downloading`;
}

async function onUpdatePillClick() {
  const state = lastUpdateState;
  if (!state) return;
  if (state.phase === "ready") {
    const yes = await confirmModal({
      title: "Restart to update?",
      message: `Orbit ${state.availableVersion ? "v" + state.availableVersion : ""} is ready. Restart now to install it? Your data is safe - a verified backup was already taken.`,
      confirmLabel: "Restart & update",
    });
    if (yes) await api.updates.install({}).catch(toastError);
  } else {
    runCommand("settings"); // downloading: show details in Settings > About
  }
}

/** Quiet trust strip: the safety net, visibly working. */
async function refreshBackupStrip() {
  try {
    const s = await api.data.backupStatus({});
    if (!s.lastBackupAt) backupText = "no backup yet";
    else {
      const mins = Math.floor((Date.now() - s.lastBackupAt) / 60000);
      backupText =
        mins < 1 ? "backed up just now ✓"
        : mins < 60 ? `backed up ${mins}m ago ✓`
        : `backed up ${Math.floor(mins / 60)}h ago ✓`;
    }
  } catch {
    backupText = "";
  }
  renderStatus();
}

async function refreshSnapshot() {
  const snapshot = await api.graph.snapshot({});
  lastSnapshot = snapshot;
  graphView.setSnapshot(snapshot);
  if (currentView === "geomap") plotGeomap();
  state.contactCount = snapshot.nodes.length;
  countsText =
    `${snapshot.nodes.length.toLocaleString()} contacts · ${snapshot.links.length.toLocaleString()} connections`;
  renderStatus();
  // Start screen: shown when there's no data (fresh), or held open by showLanding.
  if (snapshot.nodes.length === 0 && currentView === "graph") {
    $("landing-fresh").hidden = false;
    $("landing-sample").hidden = true;
    landingActive = true;
  }
  $("empty-state").hidden = !landingActive || currentView === "explore";
  return snapshot;
}

/** Refresh the in-memory graph + badge without changing the current view. */
async function refreshSnapshotQuiet() {
  await refreshSnapshot();
  refreshAttentionBadge();
}

/** Refresh all visible projections after an edit made in the contact card. */
async function refreshAfterCardChange() {
  await Promise.all([
    refreshSnapshot(),
    currentView === "explore" ? explore.run() : Promise.resolve(),
  ]);
}

function showHint(text) {
  const el = $("graph-hint");
  el.textContent = text;
  el.hidden = false;
}

function setActiveNav(id) {
  document.querySelectorAll("#sidebar .nav-item").forEach((el) => {
    const b = /** @type {HTMLElement} */ (el);
    b.classList.toggle("active", b.dataset.nav === id);
  });
}

function goHome() {
  state.selectedId = null;
  state.selectedName = null;
  card.hide();
  graphView.clearPath();
  resetNav();
  showView("graph");
  setActiveNav("network");
  // Home centres on you (the owner) when set - that's "who's connected to me" -
  // otherwise on the most-connected hub.
  const owner = graphView.ownerNode();
  const home = owner ?? graphView.hub();
  if (home != null) {
    graphView.focusAll(home); // the whole network, centred on you
    showHint(owner != null
      ? `Home: your whole network - you're at the centre. ${shortcut("K")} to search.`
      : `Home: your whole network. ${shortcut("K")} to search.`);
  }
  // At large scale focusAll falls back to Mesh; reflect the real mode.
  setCanvasView(graphView.mode === "mesh" ? "mesh" : "graph");
}

/** Close the contact card without discarding the surrounding non-graph view. */
function closeContact() {
  state.selectedId = null;
  state.selectedName = null;
  card.hide();
  if (currentView === "graph") goHome();
}

function showMeshGraph() {
  state.selectedId = null;
  state.selectedName = null;
  card.hide();
  resetNav();
  showView("graph");
  graphView.showMesh();
  setActiveNav("network");
  setCanvasView("mesh");
  showHint("Full mesh - every contact on the ring, every connection a chord. Click a node to open · shift-click two to trace a path.");
}

function orbitHint(metric) {
  return `Orbit - you at the centre. Rings by ${metric}. Click a node to open.`;
}

function showOrbitGraph() {
  state.selectedId = null;
  state.selectedName = null;
  card.hide();
  resetNav();
  showView("graph");
  graphView.showOrbit();
  setActiveNav("network");
  setCanvasView("orbit");
  /** @type {HTMLSelectElement} */ ($("orbit-metric")).value = graphView.orbitMetric;
  showHint(orbitHint(graphView.orbitMetric));
}

function showReachGraph() {
  state.selectedId = null;
  state.selectedName = null;
  card.hide();
  resetNav();
  showView("graph");
  graphView.showReach();
  setActiveNav("network");
  setCanvasView("reach");
  showHint("Reach - you at the centre, everyone on rings by degrees of separation (1 hop, 2 hops…). Click a node to open.");
}

function showTreeGraph() {
  state.selectedId = null;
  state.selectedName = null;
  card.hide();
  resetNav();
  showView("graph");
  const n = graphView.showTree();
  setActiveNav("network");
  setCanvasView("tree");
  showHint("Tree - starts at you. Click a person, then the + buttons to expand parents (↑), children (↓), or siblings.");
}

// --- Tree ANCHOR combobox: re-root the tree on a chosen pair -----------------
let anchorOptions = [];
let anchorActiveIdx = -1;

/** Reload the pair list and sync the input to the current anchor. */
function refreshTreeAnchor() {
  if (!graphView) return;
  anchorOptions = graphView.treeAnchorOptions();
  syncAnchorInput();
}
function syncAnchorInput() {
  const input = /** @type {HTMLInputElement} */ ($("tree-anchor-input"));
  const cur = graphView.treeAnchor;
  const opt = cur == null ? null : anchorOptions.find((o) => o.id === cur);
  input.value = opt ? opt.label : "";
}
function renderAnchorList(filter) {
  const list = $("tree-anchor-list");
  const input = /** @type {HTMLInputElement} */ ($("tree-anchor-input"));
  list.innerHTML = "";
  const f = (filter || "").trim().toLowerCase();
  const items = [{ id: null, label: "Default view (You)", isDefault: true }];
  for (const o of anchorOptions) if (!f || o.label.toLowerCase().includes(f)) items.push(o);
  anchorActiveIdx = -1;
  items.slice(0, 300).forEach((o, i) => {
    const li = el("li", o.isDefault ? "default-opt" : null, o.label);
    li.dataset.id = o.id == null ? "" : String(o.id);
    const isCur = (o.id == null && graphView.treeAnchor == null) || o.id === graphView.treeAnchor;
    if (isCur) { li.classList.add("active"); anchorActiveIdx = i; }
    li.addEventListener("mousedown", (e) => { e.preventDefault(); chooseAnchor(o.id); });
    list.append(li);
  });
  list.hidden = list.children.length === 0;
  input.setAttribute("aria-expanded", String(!list.hidden));
}
function chooseAnchor(id) {
  const input = /** @type {HTMLInputElement} */ ($("tree-anchor-input"));
  graphView.setTreeAnchor(id);
  $("tree-anchor-list").hidden = true;
  input.setAttribute("aria-expanded", "false");
  refreshTreeAnchor();
  input.blur();
}
function setupTreeAnchor() {
  const input = /** @type {HTMLInputElement} */ ($("tree-anchor-input"));
  const list = $("tree-anchor-list");
  input.addEventListener("focus", () => { input.select(); renderAnchorList(""); });
  input.addEventListener("input", () => renderAnchorList(input.value));
  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; syncAnchorInput(); }, 130));
  input.addEventListener("keydown", (e) => {
    const items = [...list.querySelectorAll("li")];
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
      e.preventDefault();
      anchorActiveIdx = e.key === "ArrowDown"
        ? Math.min(items.length - 1, anchorActiveIdx + 1)
        : Math.max(0, anchorActiveIdx - 1);
      items.forEach((li, i) => li.classList.toggle("active", i === anchorActiveIdx));
      items[anchorActiveIdx]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const li = items[anchorActiveIdx];
      if (li) chooseAnchor(li.dataset.id ? Number(li.dataset.id) : null);
    } else if (e.key === "Escape") { list.hidden = true; input.blur(); }
  });
}

function showClusterGraph() {
  state.selectedId = null;
  state.selectedName = null;
  card.hide();
  resetNav();
  showView("graph");
  graphView.showClusters();
  setActiveNav("network");
  setCanvasView("cluster");
  renderClusterLegend($("legend-cluster"), (kind) => graphView.toggleClusterKind(kind));
  const n = graphView.clusterMembers.size;
  showHint(n
    ? `Clusters - your network grouped into ${n} communit${n === 1 ? "y" : "ies"}. Click a cluster to open it.`
    : "Clusters - not enough connections yet to detect communities.");
}

async function selectContact(id, /** @type {{ depth?: number, keepView?: boolean, from?: number, fromName?: string, startRename?: boolean }} */ { depth, keepView, from, fromName, startRename } = {}) {
  try {
    const contact = await api.contacts.get({ id });
    if (!contact) {
      toast("That contact is no longer available.");
      return;
    }
    state.selectedId = id;
    state.selectedName = contact.name;
    if (depth) state.depth = depth;
    const [interactions, allTags, edges] = await Promise.all([
      api.interactions.list({ contactId: id }),
      api.tags.list({}),
      api.edges.list({ contactId: id }),
    ]);
    // Breadcrumb: if we arrived from another contact, expose the edge to them
    // for editing at the top of the card.
    let relFrom = null;
    if (from != null && from !== id) {
      const edge = edges.find((e) => e.sourceId === from || e.targetId === from);
      if (edge) relFrom = { id: from, name: fromName ?? "them", gender: graphView.genderOf(from), edge };
    }
    // No breadcrumb? Default the relationship editor to this person's connection
    // to you (the owner) - so a family member's type + kin stay editable however
    // it was opened. NOT on the owner's own card (the anchor has many
    // relationships; each is defined on the other person's card instead).
    if (!relFrom) {
      const ownerId = graphView.ownerNode();
      const isOwner = ownerId != null && ownerId === id;
      if (!isOwner) {
        // Prefer the connection to you (the owner); else a single, unambiguous
        // connection. Never on the owner's own card (it has many relationships).
        let anchor = ownerId != null ? edges.find((e) => e.sourceId === ownerId || e.targetId === ownerId) : null;
        if (!anchor && edges.length === 1) anchor = edges[0];
        if (anchor) {
          const otherId = anchor.sourceId === id ? anchor.targetId : anchor.sourceId;
          relFrom = { id: otherId, name: graphView.nameOf(otherId) ?? "them", gender: graphView.genderOf(otherId), edge: anchor };
        }
      }
    }
    // Opening a contact from Explore keeps the table; the card shows beside it.
    if (!keepView && currentView === "graph") {
      graphView.focus(id, state.depth);
      setCanvasView("graph"); // drilling in is an ego/force view; leave Mesh/Orbit
      showHint(`${contact.name}'s network · ${state.depth} hop${state.depth > 1 ? "s" : ""} · shift-click another node for the path`);
      setNavFocus(contact.name); // whose network we're in, next to Back (as cluster drill-downs do)
    }
    card.depth = state.depth;
    card.show(contact, {
      neighbors: graphView.neighborsOf(id),
      interactions,
      edges,
      relFrom,
      startRename,
      tags: contact.tags ?? [],
      allTags: allTags.map((t) => t.name),
    });
  } catch (err) {
    toastError(err);
  }
}

async function shiftSelect(id) {
  if (state.selectedId == null || state.selectedId === id) return selectContact(id);
  try {
    const r = await api.graph.path({ fromId: state.selectedId, toId: id });
    if (!r.found) {
      toast("No path between those two.");
      return;
    }
    graphView.highlightPath(r.path);
    showHint(`${r.hops} hop${r.hops > 1 ? "s" : ""} apart · Esc to clear`);
  } catch (err) {
    toastError(err);
  }
}

async function deleteContact(contact) {
  const originView = currentView;
  try {
    await api.contacts.softDelete({ id: contact.id });
    await refreshSnapshotQuiet();
    if (originView === "explore") await explore.run();
    card.hide();
    state.selectedId = null;
    state.selectedName = null;
    if (originView === "graph") goHome();
    toast(`Deleted ${contact.name}. It's in the trash.`, {
      actionLabel: "Undo",
      onAction: async () => {
        try {
          await api.contacts.restore({ id: contact.id });
          await refreshSnapshotQuiet();
          if (originView === "explore") await explore.run();
          if (currentView === originView) selectContact(contact.id, { keepView: originView !== "graph" });
        } catch (err) {
          toastError(err);
        }
      },
    });
  } catch (err) {
    toastError(err);
  }
}

async function createContact(name) {
  try {
    const contact = await api.contacts.create({ name });
    await refreshSnapshot();
    toast(`Added ${contact.name}.`);
    selectContact(contact.id);
  } catch (err) {
    toastError(err);
  }
}

// --- "add a connection" dropdown: pick a relationship type, then a new contact
// is created + linked to the anchor, and its card opens ready to be named.
// Used by right-click on a node and the card's "Add connection" button. ---
let connMenuEl = null;
function closeConnMenu() {
  if (connMenuEl) { connMenuEl.remove(); connMenuEl = null; }
  document.removeEventListener("click", closeConnMenu, true);
  document.removeEventListener("keydown", onConnMenuKey, true);
}
function onConnMenuKey(e) { if (e.key === "Escape") closeConnMenu(); }

function showConnectionMenu(anchorId, anchorName, pos) {
  closeConnMenu();
  const menu = el("div", "node-menu");
  const head = el("div", "node-menu-head mono", `New connection to ${anchorName}`);
  head.title = `Creates a new contact already linked to ${anchorName}, then opens it so you can name them`;
  menu.append(head);
  for (const type of EDGE_TYPES) {
    const item = el("button", "node-menu-item");
    item.type = "button";
    item.title = type === "introduced"
      ? `Add a new contact that ${anchorName} introduced. This link has a direction`
      : `Add a new contact connected to ${anchorName} as ${type}`;
    const dot = el("span", "node-menu-dot");
    dot.style.background = EDGE_COLORS[type] ?? "";
    item.append(dot, el("span", null, type));
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      closeConnMenu();
      addConnectionTo(anchorId, anchorName, type);
    });
    menu.append(item);
  }
  document.body.append(menu);
  // Position at the cursor/button, flipped to stay on-screen.
  const rect = menu.getBoundingClientRect();
  let x = pos.x, y = pos.y;
  if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight - 8) y = pos.y - rect.height;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  connMenuEl = menu;
  setTimeout(() => {
    document.addEventListener("click", closeConnMenu, true);
    document.addEventListener("keydown", onConnMenuKey, true);
  }, 0);
}

async function addConnectionTo(anchorId, anchorName, type) {
  try {
    const contact = await api.contacts.create({ name: `New ${type}` });
    try {
      await api.edges.create({ sourceId: anchorId, targetId: contact.id, type, directed: false });
    } catch (err) {
      // Creating a linked contact is one logical action. If its edge cannot be
      // created, remove the otherwise-orphaned placeholder before surfacing it.
      try {
        await api.contacts.softDelete({ id: contact.id });
        await api.contacts.purge({ id: contact.id });
      } catch {}
      throw err;
    }
    await refreshSnapshot();
    pushNav(); // Back returns to where you were
    await selectContact(contact.id, { from: anchorId, fromName: anchorName, startRename: true });
    toast(`Added a ${type} of ${anchorName} - type their name.`);
  } catch (err) {
    toastError(err);
  }
}

/** Natural-language capture from the palette (see shared/quick-add.js). */
async function quickAdd(parsed) {
  try {
    const contact = await api.contacts.create({ name: parsed.name, fields: parsed.fields });
    if (parsed.tags.length) {
      await api.contacts.setTags({ id: contact.id, tags: parsed.tags });
    }
    let linked = "";
    if (parsed.introducedBy) {
      const resp = await api.search.query({ text: parsed.introducedBy, requestId: 0, limit: 1 });
      const top = resp.results[0];
      if (top && top.name.toLowerCase() === parsed.introducedBy.toLowerCase()) {
        await api.edges.create({
          sourceId: top.contactId, targetId: contact.id, type: "introduced", directed: true,
        });
        linked = ` · introduced by ${top.name}`;
      } else if (top) {
        linked = ` · couldn't match "${parsed.introducedBy}" exactly (did you mean ${top.name}?)`;
      }
    }
    await api.interactions.add({
      contactId: contact.id, occurredAt: Date.now(), kind: "meeting", note: "added via quick add",
    });
    await refreshSnapshot();
    toast(`Added ${contact.name}${linked}`);
    selectContact(contact.id);
  } catch (err) {
    toastError(err);
  }
}

async function doBackup() {
  try {
    await api.data.backupNow({});
    toast("Backup written and verified.");
    refreshBackupStrip();
  } catch (err) {
    toastError(err);
  }
}

/** One router for the native menu, the sidebar, and anything else. */
function runCommand(id) {
  const actions = {
    "home": () => goHome(),
    "network": () => goHome(),
    "mesh": () => showMeshGraph(),
    "geomap": () => openGeomap(),
    "list": () => openList(),
    "find": () => openFind(),
    "find-current": () => focusCurrentFind(),
    "insights": () => openInsightsPage(),
    "import": () => startImport(),
    "export-archive": () => exportArchiveFlow(),
    "export-png": () => exportImageFlow(),
    "export-graphml": () => exportGraphMLFlow(),
    "dedup": () => openDedupQueue({ onChanged: () => onDataChanged() }),
    "trash": () => openTrash({ onChanged: () => onDataChanged() }),
    "settings": () => openSettingsPage(),
    "about": () => showAbout(),
    "shortcuts": () => showShortcuts(),
    "backup": () => doBackup(),
    "new-contact": () => palette.open(""),
    "quick-add": () => palette.open("met "),
    "palette": () => (palette.isOpen ? palette.close() : palette.open()),
  };
  actions[id]?.();
}

async function showAbout() {
  const m = openModal({ title: "About Orbit" });
  const summary = el("div", "about-summary about-summary--dialog");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "about-logo");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("aria-label", "Orbit logo");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#orbit-mark");
  svg.append(use);
  const copy = el("div");
  copy.append(
    el("p", "about-dialog-name", "Orbit"),
    el("p", "about-copy", "A local-first, encrypted relationship CRM for exploring the people, connections, and places in your network. Your contact graph stays on this device."),
  );
  summary.append(svg, copy);
  const version = el("p", "dim mono field-hint", "Version…");
  version.title = "Orbit reports no usage data. Nothing about your contacts leaves this device";
  m.body.append(summary, version);
  const close = el("button", null, "Close");
  close.type = "button";
  close.title = "Close this dialog (Esc)";
  close.addEventListener("click", m.close);
  m.foot.append(close);
  try {
    const status = await api.data.backupStatus({});
    version.textContent = `Version ${status.appVersion} · no telemetry`;
  } catch {
    version.textContent = "No telemetry";
  }
}

function showShortcuts() {
  const m = openModal({ title: "Keyboard shortcuts" });
  const rows = [
    [shortcut("K"), "Command palette (search, commands, quick add)"],
    [shortcut("F"), "Find in the current view"],
    [shortcut("L"), "Explore (faceted people-search)"],
    [shortcut("N"), "New contact (via palette)"],
    [shortcut("E"), "Export archive"],
    ["g g", "Graph home"],
    ["Esc", "Close / clear path / back to home"],
    ["Del", "Delete selected contact (undoable)"],
    ["↑ ↓ ↵", "Navigate and open in palette or lists"],
    ["shift-click node", "Shortest path from the selected contact"],
    ["right-click node", "Add a connection"],
    ["drag node", "Reposition a node on the canvas"],
    ["?", "This overlay"],
  ];
  for (const [key, what] of rows) {
    const row = el("div", "field-row");
    row.append(el("span", "field-key mono", key), el("span", "field-val dim", what));
    m.body.append(row);
  }
}

const SAMPLE_LABEL = { small: "small · 100", large: "large · 5,000" };
let sampleBannerDismissed = false;
let landingActive = false; // the start screen is up (choose sample / build own)

/** Seed a sample dataset (small/large, or the legacy default) into an empty DB. */
async function loadSample(dataset) {
  try {
    const r = await api.data.seedSample(dataset ? { dataset } : {});
    await refreshSnapshot();
    toast(`Loaded the ${SAMPLE_LABEL[dataset] ?? "sample"} network: ${r.contacts.toLocaleString()} contacts, ${r.edges.toLocaleString()} connections.`);
    sampleBannerDismissed = false;
    await refreshSampleBanner();
    goHome();
  } catch (err) {
    toastError(err);
  }
}

/** Replace the active sample with the other size (still sample data). */
async function switchSample(dataset) {
  try {
    await api.data.clearAll({}); // safety backup + wipes the current sample/owner
    const r = await api.data.seedSample({ dataset });
    await refreshSnapshot();
    sampleBannerDismissed = false;
    await refreshSampleBanner();
    goHome();
    toast(`Switched to the ${SAMPLE_LABEL[dataset] ?? "sample"} network: ${r.contacts.toLocaleString()} contacts.`);
  } catch (err) {
    toastError(err);
  }
}

/** The sample-data banner: shown while exploring sample data (unless the start
 *  screen is up, which supersedes it). */
async function refreshSampleBanner() {
  const banner = $("sample-banner");
  let dataset = null;
  try {
    ({ dataset } = await api.data.sampleStatus({}));
  } catch {}
  const show = !!dataset && state.contactCount > 0 && !sampleBannerDismissed && !landingActive;
  banner.hidden = !show;
  if (!show) return;
  const pretty = SAMPLE_LABEL[dataset] ?? "sample";
  $("sample-banner-text").textContent = `You're exploring sample data (${pretty}). Switch size, exit to the start screen, or build your own.`;
  const switchBtn = /** @type {HTMLButtonElement} */ ($("sample-switch"));
  const to = dataset === "small" ? "large" : "small";
  switchBtn.dataset.to = to;
  switchBtn.textContent = `Switch to ${SAMPLE_LABEL[to]}`;
}

/**
 * The start screen (the landing/launch screen). Shown on launch when the last
 * session was sample data - so the user re-chooses explicitly - and via the
 * banner's "Exit exploring". Adapts to fresh (no data) vs sample-loaded.
 */
async function showLanding() {
  let dataset = null;
  try {
    ({ dataset } = await api.data.sampleStatus({}));
  } catch {}
  const sampleMode = !!dataset && state.contactCount > 0;
  $("landing-fresh").hidden = sampleMode;
  $("landing-sample").hidden = !sampleMode;
  if (sampleMode) {
    const pretty = SAMPLE_LABEL[dataset] ?? "sample";
    $("landing-sample-text").textContent = `You're exploring the ${pretty} sample network. Keep going, switch size, or build your own.`;
    const to = dataset === "small" ? "large" : "small";
    const sw = /** @type {HTMLButtonElement} */ ($("landing-switch"));
    sw.dataset.to = to;
    sw.textContent = `Switch to ${SAMPLE_LABEL[to]}`;
  }
  landingActive = true;
  state.selectedId = null;
  state.selectedName = null;
  card.hide();
  $("sample-banner").hidden = true;
  $("empty-state").hidden = false;
}

function dismissLanding() {
  landingActive = false;
  $("empty-state").hidden = true;
}

/** Clear the sample and begin the user's own network with owner onboarding. */
async function startMyOwnNetwork() {
  const yes = await confirmModal({
    title: "Start your own network?",
    message:
      "This clears the sample data so you can begin fresh. A safety backup is taken first, " +
      "so you can Restore latest backup if you change your mind.",
    confirmLabel: "Clear sample & start",
    danger: true,
  });
  if (!yes) return;
  try {
    await api.data.clearAll({});
    await refreshSnapshot();
    $("sample-banner").hidden = true;
    sampleBannerDismissed = false;
    ownerOnboarding({ onDone: async () => { await refreshSnapshot(); goHome(); } });
  } catch (err) {
    toastError(err);
  }
}

/** Owner ("you") onboarding: collect the profile singleton. Skippable.
 * @param {{ onDone?: () => void }} [opts] */
function ownerOnboarding({ onDone } = {}) {
  const m = openModal({ title: "Set up your profile" });
  m.body.append(el("p", "dim", "This is you - the person your whole network is built around. You'll appear as a gold node in the graph, connected only to the people you link. Home centres on you."));
  const grid = el("div", "profile-grid");
  /** @type {Record<string, HTMLInputElement | HTMLSelectElement>} */
  const inputs = {};
  const field = (key, label, placeholder, hint) => {
    const lab = el("label", "profile-key mono", label);
    lab.title = hint;
    grid.append(lab);
    const input = /** @type {HTMLInputElement} */ (el("input"));
    input.placeholder = placeholder;
    input.title = hint;
    inputs[key] = input;
    grid.append(input);
  };
  field("name", "name", "your full name", "The name on your gold node in the graph. Everything else here is optional");
  const genderLab = el("label", "profile-key mono", "gender");
  genderLab.title = "Sets your ring colour on the graph and the kinship terms offered for your relatives";
  grid.append(genderLab);
  const genderSel = /** @type {HTMLSelectElement} */ (el("select"));
  genderSel.title = genderLab.title;
  genderSel.append(new Option("(unspecified)", ""));
  for (const g of ["Female", "Male"]) genderSel.append(new Option(g, g));
  inputs.gender = genderSel;
  grid.append(genderSel);
  field("email", "email", "you@example.com", "Your email address. Optional, and changeable later in Settings");
  field("company", "company", "company", "Where you work. Also used to colour your node by organization");
  field("role", "role", "role / title", "Your job title. Optional, and changeable later in Settings");
  m.body.append(grid);

  const actions = el("div", "card-actions");
  const save = /** @type {HTMLButtonElement} */ (el("button", "primary", "Save & continue"));
  save.type = "button";
  save.title = "Save this profile and go on to build your network";
  save.addEventListener("click", async () => {
    /** @type {Record<string, string>} */
    const next = {};
    for (const [k, input] of Object.entries(inputs)) {
      const v = input.value.trim();
      if (v) next[k] = v;
    }
    try {
      await api.profile.set(next);
    } catch (err) {
      toastError(err);
      return;
    }
    m.close();
    toast(`Profile saved. Add your first contact with ${shortcut("K")}.`);
    onDone?.();
  });
  const skip = /** @type {HTMLButtonElement} */ (el("button", null, "Skip for now"));
  skip.type = "button";
  skip.title = "Carry on without a profile. You can set who you are any time in Settings under You";
  skip.addEventListener("click", () => {
    m.close();
    onDone?.();
  });
  actions.append(save, skip);
  m.body.append(actions);
}

/** True when there is data but no "you" node - e.g. after importing an archive
 *  or restoring a backup whose owner wasn't set. */
function ownerMissing() {
  return !!lastSnapshot && lastSnapshot.nodes.length > 0 && !lastSnapshot.nodes.some((n) => n.isOwner);
}

/** Ask who "you" is when data has landed without an owner: pick an existing
 *  contact from the imported/restored set, or add yourself. Skippable.
 *  @param {{ onDone?: () => void }} [opts] */
function promptOwnerAfterData({ onDone } = {}) {
  const finish = () => { refreshSnapshot().then(() => goHome()); onDone?.(); };
  const m = openModal({ title: "Who are you in this network?" });
  m.body.append(el("p", "dim", "Set which contact is you - your network centres on you (the gold node). Pick someone already here, or add yourself."));

  // --- pick an existing contact ---
  const search = /** @type {HTMLInputElement} */ (el("input"));
  search.type = "search";
  search.placeholder = "Search these contacts to set as you…";
  search.title = "Type a name to find yourself among the contacts that just arrived";
  const results = el("div", "owner-results");
  m.body.append(search, results);

  const setExisting = async (id) => {
    try {
      await api.profile.setOwner({ contactId: id });
      m.close();
      toast("Set as you. Your network now centres on you.");
      finish();
    } catch (err) { toastError(err); }
  };

  let seq = 0;
  search.addEventListener("input", async () => {
    const text = search.value.trim();
    results.innerHTML = "";
    if (!text) return;
    const mine = ++seq;
    let hits = [];
    try { ({ results: hits } = await api.search.query({ text, requestId: 0, limit: 8 })); } catch {}
    if (mine !== seq) return;
    if (!hits.length) { results.append(el("p", "dim mono", "No matches.")); return; }
    for (const h of hits) {
      const b = /** @type {HTMLButtonElement} */ (el("button", "owner-result"));
      b.type = "button";
      b.title = `Make ${h.name} the gold "you" node your network centres on`;
      b.append(el("span", null, h.name));
      const meta = [h.role, h.org].filter(Boolean).join(" · ");
      if (meta) b.append(el("span", "dim mono", meta));
      b.addEventListener("click", () => setExisting(h.contactId));
      results.append(b);
    }
  });

  m.body.append(el("div", "owner-or dim mono", "or"));

  // --- add yourself as a new contact ---
  const addRow = el("div", "owner-add");
  const nameInput = /** @type {HTMLInputElement} */ (el("input"));
  nameInput.placeholder = "Add yourself - your full name";
  nameInput.title = "Use this when you are not already among these contacts. Press Enter to add yourself";
  const addBtn = /** @type {HTMLButtonElement} */ (el("button", "primary", "Add me"));
  addBtn.type = "button";
  addBtn.title = "Create a contact for yourself and centre the network on it";
  const addMe = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    try {
      await api.profile.set({ name });
      m.close();
      toast("Added you. Your network now centres on you.");
      finish();
    } catch (err) { toastError(err); }
  };
  addBtn.addEventListener("click", addMe);
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addMe(); });
  addRow.append(nameInput, addBtn);
  m.body.append(addRow);

  const skip = /** @type {HTMLButtonElement} */ (el("button", null, "Skip for now"));
  skip.type = "button";
  skip.title = "Carry on without a \"you\" node. Home will not centre on anyone until you set one in Settings";
  skip.addEventListener("click", () => { m.close(); onDone?.(); });
  m.foot.append(skip);
  search.focus();
}

/** Open the import wizard, then - if the new data has no "you" - offer to set
 *  the owner before carrying on. */
function startImport() {
  openImportWizard({
    onDone: async () => {
      await onDataChanged();
      if (ownerMissing()) promptOwnerAfterData();
    },
  });
}

async function exportGraphMLFlow() {
  try {
    const { path } = await api.dialogs.saveFile({
      defaultName: "network.graphml",
      filters: [{ name: "GraphML", extensions: ["graphml"] }],
    });
    if (!path) return;
    const r = await api.data.exportGraphML({ destPath: path });
    toast(`Network written to ${r.path}.`);
  } catch (err) {
    toastError(err);
  }
}

/** Pre-export popup: pick plain (template) vs. detailed CSV. Resolves the chosen
 *  options, or null if the user cancels. */
function csvExportOptions() {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    const m = openModal({ title: "Export CSV", onClose: () => settle(null) });
    m.body.append(el("p", null, "Exports your contacts in the import template's columns (re-imports cleanly)."));
    const opt = el("label", "form-check");
    opt.title = "Off: one row per contact, in the import template's columns, which re-imports cleanly. On: one row per relationship with the kinship detail, for analysis elsewhere";
    const cb = el("input");
    cb.type = "checkbox";
    opt.append(cb, el("span", null, "Include relationships (the import review layout: relationship, relationship to, kinship, gender…) - one row per relationship, for offline analysis. This richer file is not meant for re-import."));
    m.body.append(opt);
    const cancel = el("button", null, "Cancel");
    cancel.type = "button";
    cancel.title = "Close without exporting anything";
    const ok = el("button", "primary", "Export…");
    ok.type = "button";
    ok.title = "Choose where to save the CSV";
    m.foot.append(cancel, ok);
    cancel.addEventListener("click", () => m.close());
    ok.addEventListener("click", () => { settle({ includeDetails: cb.checked }); m.close(); });
    ok.focus();
  });
}

async function exportCsvFlow() {
  try {
    const opts = await csvExportOptions();
    if (!opts) return;
    const { path } = await api.dialogs.saveFile({
      defaultName: opts.includeDetails ? "orbit-contacts-detailed.csv" : "orbit-contacts.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    const r = await api.data.exportCsv({ destPath: path, includeDetails: opts.includeDetails });
    toast(`${r.count.toLocaleString()} contact${r.count === 1 ? "" : "s"} written to ${r.path}.`);
  } catch (err) {
    toastError(err);
  }
}

async function exportImageFlow() {
  try {
    const pngBase64 = graphView.exportPNG();
    if (!pngBase64) {
      toast("Nothing to capture yet.");
      return;
    }
    const { path } = await api.dialogs.saveFile({
      defaultName: "orbit.png",
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (!path) return;
    const r = await api.data.exportImage({ destPath: path, pngBase64 });
    toast(`Snapshot written to ${r.path}.`);
  } catch (err) {
    toastError(err);
  }
}

function openList() {
  resetNav();
  showView("explore");
  setActiveNav("list");
}

function openFind() {
  resetNav();
  showView("find");
  setActiveNav("find");
}

function openInsightsPage() {
  resetNav();
  showView("insights");
  setActiveNav("insights");
}

/** Build the geomap points from the latest snapshot (prefers stored coords). */
function plotGeomap() {
  const nodes = lastSnapshot?.nodes ?? [];
  const points = [];
  for (const n of nodes) {
    let lat, lon;
    if (n.geo) { const [a, b] = String(n.geo).split(","); lat = +a; lon = +b; }
    else if (n.location && CITY_COORDS[n.location]) { [lat, lon] = CITY_COORDS[n.location]; }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    points.push({ id: n.id, name: n.name, lat, lon, gender: n.gender, isOwner: n.isOwner, deceased: n.deceased, location: n.location, place: n.place, locationPrecision: n.locationPrecision });
  }
  geomap.setPoints(points, nodes.length);
}

/** Geomap: backfill coordinates for any located contacts, then plot them. */
async function openGeomap() {
  resetNav();
  try {
    const r = await api.location.backfill({});
    if (r.updated) { await refreshSnapshot(); }
  } catch { /* backfill is best-effort */ }
  plotGeomap();
  showView("geomap");
  setActiveNav("geomap");
}

/** (Re)build both legends from the live palette, keeping any active filters. */
function refreshLegend() {
  renderLegend(
    $("legend"), $("legend-gender"),
    (type) => graphView.toggleEdgeType(type),
    (type) => graphView.isolateEdgeType(type),
    () => graphView.clearIsolate(),
    (gender) => graphView.toggleGender(gender),
    (gender) => graphView.isolateGender(gender),
    { types: graphView.hiddenTypes, genders: graphView.hiddenGenders },
  );
}

function openSettingsPage() {
  state.selectedId = null;
  state.selectedName = null;
  card.hide();
  resetNav();
  setActiveNav("settings");
  renderSettings($("settings"), {
    onExport: () => exportArchiveFlow(),
    onExportCsv: () => exportCsvFlow(),
    onImport: () => startImport(),
    onChanged: () => onDataChanged(),
    // Palette switch: the color objects are already retinted; repaint what
    // baked them in (legend chips, canvas attributes, memoised tints).
    onPaletteChanged: () => {
      refreshLegend();
      graphView.repaintPalette();
    },
    // Admin review: findings deep-link to the offending record.
    onOpenContact: (id) => { pushNav(); showView("graph"); setActiveNav(null); selectContact(id); },
    onOpenDedup: () => openDedupQueue({ onChanged: () => onDataChanged() }),
    onShowOnGraph: (ids) => showOnGraph(ids, "Review"),
  });
  showView("settings");
}

/** "Show on graph" from Explore/Find: focus the graph to the matched subgraph. */
function showOnGraph(ids, source = "Explore") {
  if (!ids.length) {
    toast("Nothing to show.");
    return;
  }
  pushNav(); // remember the Find/Explore view so Back returns to it
  showView("graph");
  const n = graphView.focusSet(ids, { pairs: true, expandPartners: true });
  card.hide();
  state.selectedId = null;
  setActiveNav(null);
  showHint(`${n} people from ${source}. Esc or Back to return.`);
}

async function exportArchiveFlow() {
  try {
    const { path } = await api.dialogs.saveFile({
      defaultName: "contacts.orbit",
      filters: [{ name: "Orbit archive", extensions: ["orbit"] }],
    });
    if (!path) return;
    const passphrase = await promptModal({
      title: "Protect the archive?",
      label: "Passphrase",
      type: "password",
      placeholder: "leave empty for unencrypted",
      confirmLabel: "Export",
    });
    if (passphrase === null) return;
    const r = await api.data.exportArchive({ destPath: path, passphrase: passphrase || undefined });
    toast(`Exported to ${r.path}.`);
  } catch (err) {
    toastError(err);
  }
}

async function onDataChanged() {
  await refreshSnapshot();
  refreshAttentionBadge();
  if (currentView === "explore") {
    await explore.run();
    if (state.selectedId != null) {
      const still = await api.contacts.get({ id: state.selectedId });
      if (still) await selectContact(state.selectedId, { keepView: true });
      else closeContact();
    }
    return;
  }
  if (currentView === "find") {
    if (find.lastResponse) await find.run();
    return;
  }
  if (currentView === "insights") {
    await insights.refresh();
    return;
  }
  if (currentView === "settings") {
    openSettingsPage();
    return;
  }
  if (currentView === "geomap") {
    if (state.selectedId != null) {
      const still = await api.contacts.get({ id: state.selectedId });
      if (still) await selectContact(state.selectedId, { keepView: true });
      else closeContact();
    }
    return;
  }
  if (state.selectedId != null) {
    const still = await api.contacts.get({ id: state.selectedId });
    if (still) selectContact(state.selectedId);
    else goHome();
  } else if (graphView.mode === "mesh") {
    showMeshGraph();
  } else if (graphView.mode === "orbit") {
    showOrbitGraph();
  } else if (graphView.mode === "reach") {
    showReachGraph();
  } else if (graphView.mode === "cluster") {
    showClusterGraph();
  } else if (graphView.mode === "tree") {
    showTreeGraph();
  } else {
    goHome();
  }
}

async function computeInfluence() {
  toast("Computing betweenness in a worker…");
  try {
    const values = await api.graph.centrality({ metric: "betweenness" });
    const max = Math.max(1e-9, ...Object.values(values));
    graphView.view.forEachNode((id) => {
      const v = values[Number(id)] ?? 0;
      graphView.view.setNodeAttribute(id, "size", 3 + 15 * Math.sqrt(v / max));
    });
    graphView.sigma.refresh();
    showHint("Node size = betweenness (bridges between circles are big). Reselect to reset.");
  } catch (err) {
    toastError(err);
  }
}

function wireKeyboard() {
  let lastG = 0;
  window.addEventListener("keydown", (e) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const typing = e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;

    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      palette.isOpen ? palette.close() : palette.open();
      return;
    }
    if (mod && e.key.toLowerCase() === "e") {
      e.preventDefault();
      exportArchiveFlow();
      return;
    }
    if (mod && e.key.toLowerCase() === "l") {
      e.preventDefault();
      openList();
      return;
    }
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      focusCurrentFind();
      return;
    }
    if (mod && e.key.toLowerCase() === "n") {
      e.preventDefault();
      palette.open("");
      return;
    }
    if (palette.isOpen) {
      // Esc must close the palette even if its input lost focus.
      if (e.key === "Escape") {
        e.preventDefault();
        palette.close();
      }
      return;
    }
    if (typing) return;

    if (e.key === "Escape") {
      if (graphView.hasPath) graphView.clearPath();
      else if (navStack.length) popNav();
      else if (state.selectedId != null) goHome();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (state.selectedId != null) {
        e.preventDefault();
        api.contacts.get({ id: state.selectedId }).then((c) => c && deleteContact(c));
      }
    } else if (e.key.toLowerCase() === "g" && !mod) {
      const now = Date.now();
      if (now - lastG < 400) goHome();
      lastG = now;
    } else if (e.key === "?") {
      showShortcuts();
    }
  });
}

function focusCurrentFind() {
  if (currentView === "find") find.focus();
  else if (currentView === "explore") explore.focus();
  else palette.open();
}

export async function init() {
  // Before any UI is built, so every control created below (and everything
  // rendered later) gets the in-app tooltip instead of the OS one.
  installTooltips();
  graphView = new GraphView($("graph-root"), {
    onSelect: (id) => {
      if (id !== state.selectedId) pushNav(); // drill-down: remember where we were
      selectContact(id, { from: state.selectedId, fromName: state.selectedName });
    },
    onShiftSelect: (id) => shiftSelect(id),
    onDragEnd: () => {},
    onNodeMenu: (id, pos) => showConnectionMenu(id, graphView.nameOf(id) ?? "this contact", pos),
    // Tree: focus the family under this person (children grouped) and open the
    // card beside it, without leaving the Tree view.
    onTreeSelect: (id) => { graphView.treeActivate(id); selectContact(id, { keepView: true }); },
    onClusterOpen: (openIds, label, memberCount) => {
      pushNav(); // Back returns to the Clusters metagraph
      showView("graph");
      setCanvasView("graph"); // expand into a normal member subgraph (re-shows legends)
      graphView.focusSet(openIds, { induce: false, nodeScale: 1.9, pairs: true, expandPartners: true });
      card.hide();
      state.selectedId = null;
      setActiveNav("network");
      setNavFocus(label); // show which cluster we opened, next to Back
      const m = memberCount ?? openIds.length;
      showHint(`${label} · ${m} member${m === 1 ? "" : "s"}. Partners linked in pink · Click a node to open · Back returns to clusters.`);
    },
  });
  explore = new ExploreView($("explore"), {
    onOpenContact: (id) => selectContact(id),
    onShowOnGraph: (ids) => showOnGraph(ids, "Explore"),
    onChanged: () => refreshSnapshotQuiet(),
  });
  find = new FindView($("find"), {
    onOpenContact: (id) => { pushNav(); showView("graph"); setActiveNav(null); selectContact(id); },
    onShowOnGraph: (ids) => showOnGraph(ids, "Find"),
  });
  insights = new InsightsView($("insights"), {
    onOpenContact: (id) => { pushNav(); showView("graph"); setActiveNav(null); selectContact(id); },
  });
  geomap = new GeoMap($("geomap"), { onOpenContact: (id) => selectContact(id) });
  card = new ContactCard($("panel"), {
    getIntroChain: (id) => graphView.introChain(id),
    onNavigate: (id) => {
      if (id !== state.selectedId) pushNav(); // drill-down from the card
      selectContact(id, { from: state.selectedId, fromName: state.selectedName });
    },
    onRelChanged: async (id, fromId, fromName) => {
      await refreshAfterCardChange();
      selectContact(id, { keepView: true, from: fromId, fromName });
    },
    onDeleteConnection: async (edge, other) => {
      const result = await api.edges.delete({
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        type: edge.type,
      });
      if (!result.ok) throw new Error("That connection no longer exists.");
      graphView.clearHighlight();
      await refreshAfterCardChange(); // updates the master model + counts
      // Re-render the canvas so the removed edge actually disappears: setSnapshot
      // refreshed graphView.full but not the visible sigma view.
      if (state.selectedId != null) {
        if (graphView.mode === "mesh") {
          graphView.showMesh();                                   // rebuild the ring, edge gone
          await selectContact(state.selectedId, { keepView: true });
        } else if (graphView.mode === "orbit") {
          graphView.showOrbit();                                  // rebuild the rings, edge gone
          await selectContact(state.selectedId, { keepView: true });
        } else if (graphView.mode === "reach") {
          graphView.showReach();                                  // rebuild the tree, edge gone
          await selectContact(state.selectedId, { keepView: true });
        } else {
          await selectContact(state.selectedId, { keepView: false }); // rebuild ego + card
        }
      }
      toast(`Deleted the connection to ${other.name}.`);
    },
    onHighlightConnection: (id) => (id != null ? graphView.highlightNode(id) : graphView.clearHighlight()),
    onDelete: (c) => deleteContact(c),
    onDepthChange: (depth) => {
      state.depth = depth;
      if (state.selectedId != null) selectContact(state.selectedId, { depth });
    },
    onClose: () => closeContact(),
    onChanged: async (id, opts) => {
      await refreshAfterCardChange();
      selectContact(id, { keepView: false, from: opts?.from, fromName: opts?.fromName });
    },
    onAddRelationship: (contact) =>
      openRelationshipPicker(contact, { onLinked: () => onDataChanged() }),
    onAddConnection: (contact, rect) =>
      showConnectionMenu(contact.id, contact.name, { x: rect.left, y: rect.bottom + 4 }),
  });
  palette = new Palette($("palette-root"), {
    getStarred: () => graphView.starred(),
    onQuickAdd: (parsed) => quickAdd(parsed),
    getScope: () =>
      graphView.mode === "ego" && state.selectedId != null && state.selectedName
        ? { label: state.selectedName, ids: new Set([...graphView.view.nodes()].map(Number)) }
        : null,
    commands: [
      { label: "Go to graph home", hint: "g g", run: () => goHome() },
      { label: "Insights", hint: "network intelligence", run: () => openInsightsPage() },
      { label: "Find (query builder)", hint: "advanced search", run: () => openFind() },
      { label: "Explore (facets)", hint: shortcut("L"), run: () => openList() },
      { label: "Keyboard shortcuts", hint: "?", run: () => showShortcuts() },
      { label: "Show graph (force layout)", run: () => goHome() },
      { label: "Show full mesh", hint: "circular", run: () => showMeshGraph() },
      { label: "Show orbit rings", hint: "you at centre", run: () => showOrbitGraph() },
      { label: "Show reach tree", hint: "hops from you", run: () => showReachGraph() },
      { label: "Show clusters", hint: "communities", run: () => showClusterGraph() },
      { label: "Show family tree", hint: "by generation", run: () => showTreeGraph() },
      {
        label: "Gender rings: all nodes / hovered only",
        hint: "toggle",
        run: () => {
          const mode = graphView.cycleGenderRingMode();
          toast(mode === "all" ? "Gender ring on every node." : "Gender ring on the hovered node only.");
        },
      },
      { label: "Import contacts…", hint: ".vcf .csv .orbit", run: () => startImport() },
      { label: "Export archive…", hint: shortcut("E"), run: () => exportArchiveFlow() },
      { label: "Export graph as PNG…", run: () => exportImageFlow() },
      { label: "Export network as GraphML…", run: () => exportGraphMLFlow() },
      { label: "Settings", run: () => openSettingsPage() },
      { label: "Open trash", run: () => openTrash({ onChanged: () => onDataChanged() }) },
      { label: "Review duplicates", run: () => openDedupQueue({ onChanged: () => onDataChanged() }) },
      {
        label: "Color by community",
        run: () => {
          const count = graphView.setColorMode("community");
          toast(`Louvain found ${count} communities.`);
        },
      },
      { label: "Color by organization", hint: "contacts without a company show gray", run: () => graphView.setColorMode("org") },
      {
        label: "Color by relationship",
        hint: "matches the legend",
        run: () => {
          graphView.setColorMode("relationship");
          toast("Contacts are filled by their main relationship type.");
        },
      },
      { label: "Size by influence (betweenness)", hint: "worker", run: () => computeInfluence() },
      { label: "Load sample network (small)", hint: "100 contacts", run: () => loadSample("small") },
      { label: "Load sample network (large)", hint: "5,000 contacts", run: () => loadSample("large") },
      {
        label: "Back up now",
        run: async () => {
          try {
            await api.data.backupNow({});
            toast("Backup written and verified.");
            refreshBackupStrip();
          } catch (err) {
            toastError(err);
          }
        },
      },
    ],
    // Opening a search result: remember where we were so the on-canvas
    // Back / Home buttons appear (Back to Home from the search result).
    onOpenContact: (id) => { pushNav(); showView("graph"); setActiveNav(null); selectContact(id); },
    onCreateContact: (name) => createContact(name),
  });

  api.app.onMenu((id) => runCommand(id));
  // Top-bar "Network" opens the graph canvas (defaulting to the force Graph);
  // Graph vs Mesh is chosen by the on-canvas toggle below.
  const viewNav = {
    network: () => goHome(),
    geomap: () => openGeomap(),
    explore: () => openList(),
    find: () => openFind(),
  };
  document.querySelectorAll(".view-switch button").forEach((el) => {
    const b = /** @type {HTMLElement} */ (el);
    b.addEventListener("click", () => viewNav[b.dataset.view]?.());
  });
  // On-canvas Graph|Mesh toggle: swaps the layout without leaving the canvas.
  document.querySelectorAll("#canvas-view-toggle button[data-canvas]").forEach((el) => {
    const b = /** @type {HTMLElement} */ (el);
    b.addEventListener("click", () => {
      if (b.dataset.canvas === "mesh") showMeshGraph();
      else if (b.dataset.canvas === "orbit") showOrbitGraph();
      else if (b.dataset.canvas === "reach") showReachGraph();
      else if (b.dataset.canvas === "cluster") showClusterGraph();
      else if (b.dataset.canvas === "tree") showTreeGraph();
      else goHome();
    });
  });
  // Shared zoom controls (all canvas views).
  $("zoom-in").addEventListener("click", () => graphView.zoomIn());
  $("zoom-out").addEventListener("click", () => graphView.zoomOut());
  $("zoom-fit").addEventListener("click", () => graphView.zoomFit());
  // Tree-only: reveal the whole family, or collapse back to you.
  $("tree-expand-all").addEventListener("click", () => graphView.treeExpandAll());
  $("tree-collapse-all").addEventListener("click", () => graphView.treeCollapseAll());
  // Tree-only: "Extended" hover mode (vertical lineage vs. sibling-discovery reach).
  const extBtn = $("tree-extended");
  const syncExtBtn = () => {
    extBtn.classList.toggle("active", graphView.treeExtended);
    extBtn.setAttribute("aria-pressed", String(graphView.treeExtended));
  };
  syncExtBtn();
  extBtn.addEventListener("click", () => { graphView.setTreeExtended(!graphView.treeExtended); syncExtBtn(); });
  setupTreeAnchor();
  // Fade-links toggle: dims every connection line so the node structure reads
  // through the mesh/orbit/reach clutter. Independent of the layout tabs.
  const fadeBtn = $("edge-fade-toggle");
  const syncFadeBtn = () => {
    fadeBtn.classList.toggle("active", graphView.edgeFade);
    fadeBtn.setAttribute("aria-pressed", String(graphView.edgeFade));
  };
  syncFadeBtn();
  fadeBtn.addEventListener("click", () => {
    graphView.setEdgeFade(!graphView.edgeFade);
    syncFadeBtn();
  });

  // Orbit ring-metric switch. Betweenness is computed off-thread on demand.
  const orbitMetricSel = /** @type {HTMLSelectElement} */ ($("orbit-metric"));
  orbitMetricSel.addEventListener("change", async () => {
    const metric = orbitMetricSel.value;
    if (metric === "betweenness") {
      orbitMetricSel.disabled = true;
      try {
        const values = await api.graph.centrality({ metric: "betweenness" });
        graphView.setOrbitMetric("betweenness", values);
      } catch (err) {
        toastError(err);
        orbitMetricSel.value = graphView.orbitMetric;
      } finally {
        orbitMetricSel.disabled = false;
      }
    } else {
      graphView.setOrbitMetric(metric);
    }
    showHint(orbitHint(metric));
  });
  document.querySelectorAll("#sidebar .nav-item[data-nav]").forEach((el) => {
    const b = /** @type {HTMLElement} */ (el);
    b.addEventListener("click", () => runCommand(b.dataset.nav));
  });

  // Pinnable sidebar collapse (also auto-collapses under the responsive breakpoint).
  const sidebar = $("sidebar");
  const collapseBtn = $("nav-collapse");
  const applyCollapsed = (c) => {
    sidebar.classList.toggle("collapsed", c);
    collapseBtn.querySelector("use").setAttribute("href", c ? "#nav-panel-open" : "#nav-panel-close");
    collapseBtn.querySelector("span").textContent = c ? "Expand" : "Collapse";
    collapseBtn.setAttribute("aria-label", c ? "Expand sidebar" : "Collapse sidebar");
    collapseBtn.title = c ? "Expand sidebar" : "Collapse sidebar";
  };
  // A compact rail is the default; an explicit user choice to leave it open
  // still persists across launches.
  applyCollapsed(localStorage.getItem("orbit-sidebar") !== "open");
  collapseBtn.addEventListener("click", () => {
    const c = !sidebar.classList.contains("collapsed");
    localStorage.setItem("orbit-sidebar", c ? "collapsed" : "open");
    applyCollapsed(c);
  });

  // Theme: light/dark, persisted. The graph canvas stays dark either way.
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    $("theme-toggle").textContent = t === "light" ? "☀️" : "🌙";
    $("theme-toggle").title = t === "light" ? "Switch to dark" : "Switch to light";
    graphView.applyTheme(); // repaint the canvas in the new theme
  };
  applyTheme(localStorage.getItem("orbit-theme") || "dark");
  $("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    localStorage.setItem("orbit-theme", next);
    applyTheme(next);
  });

  $("graph-back").addEventListener("click", () => popNav());
  $("graph-home").addEventListener("click", () => goHome()); // skip straight home

  refreshLegend();
  $("search-trigger").addEventListener("click", () => palette.open());
  $("btn-setup").addEventListener("click", () => ownerOnboarding({ onDone: async () => { await refreshSnapshot(); goHome(); palette.open(""); } }));
  $("btn-sample-small").addEventListener("click", () => loadSample("small"));
  $("btn-sample-large").addEventListener("click", () => loadSample("large"));
  document.querySelectorAll("[data-shortcut]").forEach((node) => {
    const item = /** @type {HTMLElement} */ (node);
    item.textContent = shortcut(item.dataset.shortcut);
  });
  document.querySelectorAll("[data-shortcut-title]").forEach((node) => {
    const item = /** @type {HTMLElement} */ (node);
    const [label, key] = item.dataset.shortcutTitle.split("|");
    item.title = `${label} (${shortcut(key)})`;
  });
  wireKeyboard();

  // Start-screen (landing) actions.
  $("landing-continue").addEventListener("click", () => { dismissLanding(); goHome(); refreshSampleBanner(); });
  $("landing-switch").addEventListener("click", () => {
    const to = /** @type {HTMLButtonElement} */ ($("landing-switch")).dataset.to;
    dismissLanding();
    if (to) switchSample(to);
  });
  $("landing-startown").addEventListener("click", () => { dismissLanding(); startMyOwnNetwork(); });

  // Sample-data banner actions.
  $("sample-dismiss").addEventListener("click", () => {
    sampleBannerDismissed = true;
    $("sample-banner").hidden = true;
  });
  $("sample-switch").addEventListener("click", () => {
    const to = /** @type {HTMLButtonElement} */ ($("sample-switch")).dataset.to;
    if (to) switchSample(to);
  });
  $("sample-exit").addEventListener("click", () => showLanding());
  $("sample-reset").addEventListener("click", () => startMyOwnNetwork());

  // First-run onboarding: one screen, once, only when there is nothing yet.
  const onboarding = $("onboarding");
  $("btn-onboard").addEventListener("click", () => {
    localStorage.setItem("orbit-onboarded", "1");
    onboarding.hidden = true;
  });

  refreshBackupStrip();
  refreshAttentionBadge();
  setInterval(() => {
    refreshBackupStrip();
    refreshAttentionBadge();
  }, 5 * 60 * 1000);

  // Update hint: read the launch-time state, then listen for live changes.
  $("update-pill").addEventListener("click", () => onUpdatePillClick());
  api.updates.status({}).then(renderUpdateHint).catch(() => {});
  api.updates.onStatus(renderUpdateHint);

  try {
    const snapshot = await refreshSnapshot();
    let sampleDataset = null;
    try { ({ dataset: sampleDataset } = await api.data.sampleStatus({})); } catch {}
    if (state.contactCount > 0) {
      localStorage.setItem("orbit-onboarded", "1"); // existing data: skip the pitch
      // Last session was sample data: open the start screen so the user chooses
      // explicitly (keep exploring / switch / build their own), rather than
      // silently dropping back into the sample graph.
      if (sampleDataset) await showLanding();
      else goHome();
      // Data but no "you" (e.g. just restored a backup / imported an archive
      // whose owner wasn't set): offer to designate the owner before carrying on.
      if (!sampleDataset && ownerMissing()) promptOwnerAfterData();
    } else if (!localStorage.getItem("orbit-onboarded")) {
      onboarding.hidden = false;
    }
    if (!landingActive) await refreshSampleBanner();
    console.log(
      `shell ready: ${snapshot.nodes.length} contacts, ${snapshot.links.length} links, ` +
        `${landingActive ? "start screen" : state.contactCount > 0 ? "home view" : "empty state"}`
    );
  } catch (err) {
    toastError(err);
    console.error(`shell boot failed: ${err.message}`);
  }
}
