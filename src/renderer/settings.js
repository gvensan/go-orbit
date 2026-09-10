// settings.js - encryption status, backup health + restore, data counts,
// export/import shortcuts, about/diagnostics (APP_SHELL_UX §3).
// Rendered as a full page in the content pane, not a modal.

import { confirmDangerModal, confirmModal, el, openModal, promptModal } from "./modal.js";
import { toast, toastError } from "./toast.js";
import {
  PALETTES, activePaletteId, applyPalette, paletteColors,
  customPalette, customDefaults, saveCustomPalette,
  userPalettes, saveUserPalette, renameUserPalette, deleteUserPalette,
} from "./colors.js";
import { RELATIONSHIP_TYPES } from "../shared/relationships.js";

const api = () => window.api;
const settingsControllers = new WeakMap();

/** Stop view-scoped listeners and prevent an in-flight render from repainting after navigation. */
export function disposeSettings(container) {
  settingsControllers.get(container)?.abort();
  settingsControllers.delete(container);
}

const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString() : "never");

function section(parent, title) {
  const sec = el("div", "card-section");
  sec.append(el("h3", null, title));
  parent.append(sec);
  return sec;
}

function row(sec, label, value, hint) {
  const r = el("div", "field-row");
  const val = el("span", "field-val", value);
  // Paths and long status strings get clipped by the column, so the full text
  // is always available on hover.
  val.title = hint ? `${hint}\n${value}` : String(value);
  r.append(el("span", "field-key mono", label), val);
  sec.append(r);
  return r;
}

function aboutSummary() {
  const wrap = el("div", "about-summary");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "about-logo");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("aria-label", "Orbit logo");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#orbit-mark");
  svg.append(use);
  wrap.append(
    svg,
    el("p", "about-copy", "Orbit is a local-first, encrypted relationship CRM for exploring the people, connections, and places in your network. Your contact graph stays on this device."),
  );
  return wrap;
}

/**
 * The owner ("you") - the person your whole network is built around. Editable
 * here (canonical home) and optionally seeded at first launch. Backed by a real
 * contact so you can appear in the graph, connected to your inner circle.
 * @param {() => void} [onChanged] called after a save so the graph can refresh
 */
/** Search existing contacts and designate one as the owner ("you").
 *  @param {() => void} [onPicked] */
function pickExistingOwner(onPicked) {
  const m = openModal({ title: "Set an existing contact as you" });
  m.body.append(el("p", "dim", "Search your contacts and choose which one is you. They become the gold node your network centres on."));
  const search = /** @type {HTMLInputElement} */ (el("input"));
  search.type = "search";
  search.placeholder = "Search contacts by name…";
  search.title = "Type a name, then pick the contact that is you";
  const results = el("div", "owner-results");
  m.body.append(search, results);

  let seq = 0;
  search.addEventListener("input", async () => {
    const text = search.value.trim();
    results.innerHTML = "";
    if (!text) return;
    const mine = ++seq;
    let hits = [];
    try { ({ results: hits } = await api().search.query({ text, requestId: 0, limit: 8 })); } catch { /* ignore */ }
    if (mine !== seq) return;
    if (!hits.length) { results.append(el("p", "dim mono", "No matches.")); return; }
    for (const h of hits) {
      const b = /** @type {HTMLButtonElement} */ (el("button", "owner-result"));
      b.type = "button";
      b.title = `Make ${h.name} the gold "you" node your network centres on`;
      b.append(el("span", null, h.name));
      const meta = [h.role, h.org].filter(Boolean).join(" · ");
      if (meta) b.append(el("span", "dim mono", meta));
      b.addEventListener("click", async () => {
        try {
          await api().profile.setOwner({ contactId: h.contactId });
          m.close();
          toast("Set as you.");
          onPicked?.();
        } catch (err) { toastError(err); }
      });
      results.append(b);
    }
  });

  const cancel = el("button", null, "Cancel");
  cancel.type = "button";
  cancel.title = "Close without changing who you are (Esc)";
  cancel.addEventListener("click", () => m.close());
  m.foot.append(cancel);
  search.focus();
}

/** @param {() => void} [onChanged] @param {() => void} [rerender] */
async function profileSection(body, onChanged, rerender) {
  let profile = {};
  let profileLoaded = true;
  try {
    profile = await api().profile.get({});
  } catch (err) {
    // Editing a form seeded with blanks would explicitly clear stored fields
    // on save; keep the form read-only-ish until a reload brings the data.
    profileLoaded = false;
    toastError(err);
  }
  const sec = section(body, "You");
  sec.append(el("p", "dim", "This is you - the person your whole network is built around. You appear as a node in the graph (a gold node), connected only to the people you link. Home centres on you."));

  // Already someone in your contacts? Point "you" at them instead of retyping.
  const pickLine = el("p", "field-hint");
  pickLine.append(document.createTextNode("Already in your contacts? "));
  const pickLink = el("a", "template-link");
  pickLink.textContent = "Choose an existing contact as you";
  pickLink.title = "Search your contacts and point \"you\" at one of them instead of retyping your details";
  pickLink.href = "#";
  pickLink.addEventListener("click", (e) => {
    e.preventDefault();
    pickExistingOwner(() => { onChanged?.(); rerender?.(); });
  });
  pickLine.append(pickLink);
  sec.append(pickLine);

  const grid = el("div", "profile-grid");
  /** @type {Record<string, HTMLInputElement | HTMLSelectElement>} */
  const inputs = {};

  const field = (key, label, placeholder, hint) => {
    const lab = el("label", "profile-key mono", label);
    if (hint) lab.title = hint;
    grid.append(lab);
    const input = /** @type {HTMLInputElement} */ (el("input"));
    input.value = profile[key] ?? "";
    input.placeholder = placeholder;
    input.title = hint ?? `Your ${label}. Saved when you click away`;
    inputs[key] = input;
    grid.append(input);
  };

  field("name", "name", "your full name", "The name shown on your gold node in the graph. Saved when you click away");

  const genderLab = el("label", "profile-key mono", "gender");
  genderLab.title = "Sets your ring colour on the graph and the kinship terms offered for your relatives";
  grid.append(genderLab);
  const genderSel = /** @type {HTMLSelectElement} */ (el("select"));
  genderSel.title = "Sets your ring colour on the graph and the kinship terms offered for your relatives";
  genderSel.append(new Option("(unspecified)", ""));
  for (const g of ["Female", "Male"]) genderSel.append(new Option(g, g));
  if (profile.gender && !["Female", "Male"].includes(profile.gender)) {
    genderSel.append(new Option(profile.gender, profile.gender));
  }
  genderSel.value = profile.gender ?? "";
  inputs.gender = genderSel;
  grid.append(genderSel);

  field("email", "email", "you@example.com", "Your email address. Saved when you click away");
  field("phone", "phone", "phone", "Your phone number. Saved when you click away");
  field("company", "company", "company", "Where you work. Also used to colour your node by organization");
  field("role", "role", "role / title", "Your job title. Saved when you click away");
  sec.append(grid);

  const save = async () => {
    if (!profileLoaded) { toast("Profile did not load; reopen Settings before editing."); return; }
    /** @type {Record<string, string>} */
    const next = {};
    // Submit every field, empties included: setProfile only touches submitted
    // keys, so an empty string is the explicit "clear this" signal while a
    // missing key means "leave it alone".
    for (const [k, input] of Object.entries(inputs)) next[k] = input.value.trim();
    try {
      await api().profile.set(next);
      onChanged?.(); // owner may be a new node - let the graph refresh
    } catch (err) {
      toastError(err);
    }
  };
  for (const input of Object.values(inputs)) input.addEventListener("change", save);
}

/** A small strip previewing a palette: six relationship dots + the two gender
 *  rings. Rebuilt in place when the custom palette is edited. */
function paletteSwatches(colors) {
  const strip = el("span", "palette-swatches");
  for (const type of RELATIONSHIP_TYPES) {
    const dot = el("i", "palette-dot");
    dot.style.background = colors.edges[type];
    dot.title = `${type} links`;
    strip.append(dot);
  }
  for (const g of ["Female", "Male"]) {
    const ring = el("i", "palette-ring");
    ring.style.borderColor = colors.gender[g];
    ring.title = `${g} ring`;
    strip.append(ring);
  }
  return strip;
}

/** Color palette for the graph: built-in presets, saved named palettes, and a
 *  Custom scratchpad whose scheme can be saved under a name (Custom then
 *  resets to its default baseline for the next experiment). A per-device
 *  preference (like the theme), stored in localStorage - never the database.
 *  @param {HTMLElement} parent @param {() => void} [onPaletteChanged] */
function appearanceSection(parent, onPaletteChanged) {
  const sec = section(parent, "Appearance");
  sec.append(el("p", "dim",
    "Palettes set the relationship colors on the graph, legend, and map, plus the gender rings. Browsing changes nothing; a palette takes effect only when you apply it. Build your own in Custom and save it under a name. This is a preference for this device only."));
  const listHost = el("div");
  const editorHost = el("div");
  sec.append(listHost, editorHost);

  let applied = activePaletteId();
  let editorOpen = applied === "custom";

  const labelOf = (id) =>
    id === "custom" ? "Custom" : ([...PALETTES, ...userPalettes()].find((p) => p.id === id)?.label ?? id);

  const applyChoice = (id) => {
    if (id === "custom") editorOpen = true;
    applied = id;
    applyPalette(id);
    renderAll();
    onPaletteChanged?.();
    toast(`Palette applied: ${labelOf(id)}.`);
  };

  const mkBtn = (text, cls, fn, title) => {
    const b = el("button", cls, text);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", fn);
    return b;
  };

  /** @param {{ id: string, label: string, blurb: string, user?: boolean }} p */
  function paletteRow({ id, label, blurb, user }) {
    const row = el("div", "palette-option" + (id === applied ? " selected" : ""));
    const meta = el("span", "palette-meta");
    meta.append(el("span", "palette-name", label), paletteSwatches(paletteColors(id)), el("span", "palette-blurb dim", blurb));
    const actions = el("span", "palette-actions");
    if (id === "custom") {
      const edit = mkBtn(editorOpen ? "Close editor" : "Edit\u2026", null,
        () => { editorOpen = !editorOpen; renderAll(); }, "Edit the custom palette");
      edit.setAttribute("aria-expanded", String(editorOpen));
      actions.append(edit);
    }
    if (user) {
      actions.append(mkBtn("Rename", null, async () => {
        const name = await promptModal({
          title: "Rename palette", label: "Name", value: label, confirmLabel: "Rename",
        });
        if (name == null) return;
        const entry = renameUserPalette(id, name);
        if (!entry) { toast("Give the palette a name."); return; }
        renderAll();
        toast(`Renamed to "${entry.label}".`);
      }, "Rename this saved palette"));
      actions.append(mkBtn("Edit a copy", null, () => {
        saveCustomPalette(paletteColors(id));
        applyChoice("custom");
      }, "Load these colors into the Custom editor"));
      actions.append(mkBtn("Delete", null, async () => {
        const yes = await confirmModal({
          title: `Delete "${label}"?`,
          message: "This removes the saved palette from the list. If it is the active palette, the default takes over.",
          confirmLabel: "Delete palette",
          danger: true,
        });
        if (!yes) return;
        deleteUserPalette(id);
        applied = activePaletteId(); // the default, if the deleted one was active
        renderAll();
        onPaletteChanged?.();
        toast("Palette deleted.");
      }, "Remove this saved palette"));
    }
    if (id === applied) actions.append(el("span", "palette-active-badge", "Active"));
    else actions.append(mkBtn("Apply", "primary", () => applyChoice(id), `Apply the ${label} palette`));
    row.append(meta, actions);
    return row;
  }

  function renderList() {
    listHost.innerHTML = "";
    const list = el("div", "palette-list");
    for (const p of PALETTES) list.append(paletteRow({ id: p.id, label: p.label, blurb: p.blurb }));
    for (const p of userPalettes()) list.append(paletteRow({ id: p.id, label: p.label, blurb: "Saved from the Custom editor.", user: true }));
    list.append(paletteRow({ id: "custom", label: "Custom", blurb: "Your scratchpad, starting from a true rainbow: edit freely, then save the scheme under a name." }));
    listHost.append(list);
  }

  function renderEditor() {
    editorHost.innerHTML = "";
    if (!editorOpen) return;
    const editor = el("div", "palette-editor");
    const current = customPalette();
    const grid = el("div", "palette-editor-grid");
    /** @param {string} label @param {string} value @param {(hex: string) => void} applyFn */
    const colorField = (label, value, applyFn) => {
      const fid = `pal-${label.replace(/\W+/g, "-").toLowerCase()}`;
      const lab = el("label", "palette-key mono", label);
      lab.setAttribute("for", fid);
      const input = /** @type {HTMLInputElement} */ (el("input"));
      input.type = "color";
      input.id = fid;
      input.value = value;
      input.title = `Colour used for ${label} on the graph, legend, and map`;
      lab.title = input.title;
      // Live-apply on every picker tick; the custom row's swatches follow.
      input.addEventListener("input", () => {
        applyFn(input.value);
        renderList();
        if (applied === "custom") onPaletteChanged?.();
      });
      grid.append(lab, input);
    };
    for (const type of RELATIONSHIP_TYPES) {
      colorField(type, current.edges[type], (hex) => {
        const next = customPalette();
        next.edges[type] = hex;
        saveCustomPalette(next);
      });
    }
    for (const g of ["Female", "Male"]) {
      colorField(`${g} ring`, current.gender[g], (hex) => {
        const next = customPalette();
        next.gender[g] = hex;
        saveCustomPalette(next);
      });
    }
    editor.append(grid);
    editor.append(el("p", "field-hint dim mono",
      applied === "custom"
        ? "Custom is the active palette - edits apply as you pick them."
        : "Edits are saved but not in use. Apply Custom, or save the scheme under a name."));
    const saveAs = mkBtn("Save as new palette\u2026", "primary", async () => {
      const name = await promptModal({
        title: "Save this scheme as a palette",
        label: "Name",
        placeholder: "e.g. Family reunion",
        confirmLabel: "Save",
      });
      if (name == null) return;
      const entry = saveUserPalette(name, customPalette());
      if (!entry) { toast("Give the palette a name."); return; }
      // The scheme moves into its named slot and takes effect; Custom resets
      // to its rainbow baseline, ready for the next experiment.
      saveCustomPalette(customDefaults());
      applied = entry.id;
      applyPalette(entry.id);
      editorOpen = false;
      renderAll();
      onPaletteChanged?.();
      toast(`Saved and applied "${entry.label}".`);
    }, "Add the current scheme to the palette list under its own name");
    const reset = mkBtn("Reset custom to rainbow", null, () => {
      saveCustomPalette(customDefaults());
      renderAll();
      if (applied === "custom") onPaletteChanged?.();
      toast("Custom palette reset to its rainbow baseline.");
    }, "Throw away the current custom colors and start again from the rainbow baseline");
    const actionsRow = el("div", "card-actions");
    actionsRow.append(saveAs, reset);
    editor.append(actionsRow);
    editorHost.append(editor);
  }

  function renderAll() { renderList(); renderEditor(); }
  renderAll();
}

/** Admin data review: run health checks over contacts, connections, and
 *  relationships; findings render as cards with a safe Fix where one exists,
 *  navigation to the offending record, and per-finding triage (ignore/defer)
 *  that survives reruns. A rerun replaces the whole deck; anything that
 *  stopped appearing counts as resolved.
 *  @param {HTMLElement} parent
 *  @param {{ onChanged?: () => void, onOpenContact?: (id: number) => void,
 *            onOpenDedup?: () => void, onShowOnGraph?: (ids: number[]) => void,
 *            goTab?: (id: string) => void }} opts */
/**
 * Settings > Setup: the checklist. Auto-checked steps show the service's own
 * view of the world; the two judgement steps take a "Mark done". Every open
 * step carries the action that completes it.
 * @param {HTMLElement} parent
 * @param {import("../shared/types").SetupStatus} s
 * @param {{ goTab: (id: string, focusTab?: boolean) => void, onImport: () => void, onOpenPalette?: () => void,
 *           onBackupNow?: () => void | Promise<void>, onChanged: () => void }} opts
 */
function setupSection(parent, s, { goTab, onImport, onOpenPalette, onBackupNow, onChanged }) {
  const sec = section(parent, "Setup checklist");
  const intro = el("p", "dim",
    "Four short steps and a few optional ones. Orbit works without the optional ones; each makes it more yours. " +
    "Steps that Orbit can see for itself tick on their own; mark the judgement calls done when you have decided.");
  if (s.complete) intro.append(" ", el("b", null, "All required steps are done."), " This checklist has left the sidebar and stays here under Settings.");
  sec.append(intro);

  const progress = el("div", "setup-progress");
  progress.setAttribute("role", "status");
  progress.append(
    el("span", "setup-progress-text", `${s.requiredDone} of ${s.requiredTotal} required steps done`),
    el("span", "dim", s.remaining ? ` · ${s.remaining} to go in total` : " · nothing left to do"),
  );
  const bar = el("div", "setup-progress-bar");
  const fill = el("div", "setup-progress-fill");
  fill.style.width = `${Math.round((s.requiredDone / Math.max(1, s.requiredTotal)) * 100)}%`;
  bar.append(fill);
  const recheck = el("button", null, "Re-check");
  recheck.type = "button";
  recheck.title = "Ask Orbit to look again at every step that checks itself";
  recheck.addEventListener("click", () => onChanged());
  const head = el("div", "card-actions setup-head");
  head.append(progress, recheck);
  sec.append(head, bar);

  const list = el("ol", "setup-steps");
  for (const step of s.steps) {
    const li = el("li", `setup-step${step.done ? " done" : ""}${step.required ? "" : " optional"}`);
    const mark = el("span", "setup-mark", step.done ? "✓" : "");
    mark.setAttribute("aria-label", step.done ? "done" : "to do");
    const headRow = el("div", "setup-step-head");
    const title = el("h4", null, step.title);
    if (!step.required) title.append(" ", el("span", "setup-opt", "optional"));
    headRow.append(mark, title);
    if (step.manual) {
      const toggle = el("button", "ghost", step.done ? "Undo" : "Mark done");
      toggle.type = "button";
      toggle.title = step.done ? "Put this step back on the list" : "Record that you have dealt with this step";
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try {
          await api().setup.mark({ id: step.id, done: !step.done });
          onChanged();
        } catch (err) {
          toggle.disabled = false;
          toastError(err);
        }
      });
      headRow.append(toggle);
    }
    const body = el("div", "setup-step-body");
    body.append(el("p", null, step.detail));
    if (step.hint) body.append(el("p", "field-hint dim", step.hint));
    if (step.actions.length) {
      const actions = el("div", "card-actions");
      for (const a of step.actions) {
        const btn = el("button", a.kind === "copy" ? null : "primary", a.label);
        btn.type = "button";
        if (a.kind === "copy") {
          const code = el("code", "mono", a.value);
          code.title = a.value;
          actions.append(code);
          btn.title = `Copy "${a.value}" to the clipboard`;
          btn.addEventListener("click", async () => {
            try {
              await navigator.clipboard.writeText(a.value);
              toast("Copied.");
            } catch {
              toast("Could not reach the clipboard; select the text and copy it by hand.");
            }
          });
        } else if (a.kind === "tab") {
          btn.title = "Jump to that Settings tab";
          btn.addEventListener("click", () => goTab(a.value, true));
        } else if (a.kind === "import") {
          btn.title = "Open the import wizard (vCard, CSV, or Orbit archive)";
          btn.addEventListener("click", () => onImport());
        } else if (a.kind === "backup") {
          btn.title = "Take a verified snapshot of your data now";
          btn.addEventListener("click", async () => { await onBackupNow?.(); onChanged(); });
        } else if (a.kind === "palette") {
          btn.title = "Open the search palette and type a name to add someone";
          btn.addEventListener("click", () => onOpenPalette?.());
        } else if (a.kind === "bookmarklet") {
          // A real link so it can be dragged to the bookmarks bar; clicking it here
          // is refused by the CSP anyway, so explain instead of doing nothing.
          const link = /** @type {HTMLAnchorElement} */ (el("a", "bookmarklet", a.label));
          link.href = a.value;
          link.draggable = true;
          link.title = "Drag this button to your bookmarks bar. Clicking it here does nothing; it works on other pages";
          link.addEventListener("click", (e) => {
            e.preventDefault();
            toast("Drag the button to your bookmarks bar, then use it on any web page.");
          });
          const copyBtn = el("button", null, "Copy code");
          copyBtn.type = "button";
          copyBtn.title = "Copy the bookmark's address, for adding a bookmark by hand";
          copyBtn.addEventListener("click", async () => {
            try { await navigator.clipboard.writeText(a.value); toast("Copied. Add a bookmark and paste this as its address."); }
            catch { toast("Could not reach the clipboard."); }
          });
          actions.append(link, copyBtn);
          continue;
        }
        actions.append(btn);
      }
      body.append(actions);
    }
    li.append(headRow, body);
    list.append(li);
  }
  sec.append(list);
}

function adminSection(parent, opts) {
  const sec = section(parent, "Data review");
  sec.append(el("p", "dim",
    "Scans your data for broken connections, contradictory relationships, malformed fields, and contacts the graph cannot reach. Fixes marked safe apply with one click; everything else links to the place to correct it. Ignoring or deferring a finding is remembered until the issue itself goes away."));

  const bar = el("div", "card-actions");
  const runBtn = /** @type {HTMLButtonElement} */ (el("button", "primary", "Run review"));
  runBtn.type = "button";
  runBtn.title = "Scan every contact, connection, and relationship for problems. This only reads your data";
  const showIgnored = /** @type {HTMLInputElement} */ (el("input"));
  showIgnored.type = "checkbox";
  showIgnored.id = "health-show-ignored";
  const showIgnoredLbl = el("label", "toggle-row health-show-ignored");
  showIgnoredLbl.title = "Also list findings you chose to ignore";
  showIgnoredLbl.append(showIgnored, el("span", null, "Show ignored"));
  bar.append(runBtn, showIgnoredLbl);
  sec.append(bar);

  const summary = el("div", "health-summary");
  summary.hidden = true;
  const deck = el("div", "health-cards");
  sec.append(summary, deck);

  /** @type {import("../shared/types").HealthFinding[]} */
  let findings = [];

  const sevLabel = { error: "error", warn: "warning", info: "info" };

  function renderSummary(r) {
    summary.hidden = false;
    summary.innerHTML = "";
    const chips = [
      { cls: "error", text: `${r.counts.error} error${r.counts.error === 1 ? "" : "s"}`,
        hint: "Broken data that will misbehave until it is corrected" },
      { cls: "warn", text: `${r.counts.warn} warning${r.counts.warn === 1 ? "" : "s"}`,
        hint: "Contradictory or questionable data worth a look" },
      { cls: "info", text: `${r.counts.info} info`,
        hint: "Observations that are not necessarily problems" },
    ];
    for (const c of chips) {
      const chip = el("span", `health-chip ${c.cls}`, c.text);
      chip.title = c.hint;
      summary.append(chip);
    }
    if (r.previousRunAt != null) {
      const resolved = el("span", "health-resolved", `${r.resolvedCount} resolved since last run`);
      resolved.title = "Findings from the previous run that no longer appear";
      summary.append(resolved);
    }
    const when = el("span", "dim mono health-when", `run ${new Date(r.lastRunAt).toLocaleString()}`);
    when.title = "When this review was last run. Run it again to refresh the findings";
    summary.append(when);
  }

  function renderDeck() {
    deck.innerHTML = "";
    const visible = findings.filter((f) => showIgnored.checked || f.status !== "ignored");
    if (!visible.length) {
      deck.append(el("p", "dim mono health-empty",
        findings.length ? "Nothing to show. Toggle \"Show ignored\" to see triaged findings." : "No issues found. Your data looks healthy."));
      return;
    }
    // Open findings first, deferred next, ignored (when shown) last.
    const rank = { open: 0, deferred: 1, ignored: 2 };
    visible.sort((a, b) => rank[a.status] - rank[b.status]);
    for (const f of visible) deck.append(card(f));
  }

  /** @param {import("../shared/types").HealthFinding} f */
  function card(f) {
    const c = el("div", `health-card sev-${f.severity} st-${f.status}`);
    const head = el("div", "health-card-head");
    head.append(
      el("span", `health-sev ${f.severity}`, sevLabel[f.severity]),
      el("span", "health-title", f.title),
    );
    const status = el("span", "health-status mono");
    const setStatusChip = () => {
      status.textContent = f.status === "open" ? "" : f.status;
      status.hidden = f.status === "open";
      c.className = `health-card sev-${f.severity} st-${f.status}`;
    };
    setStatusChip();
    head.append(status);
    c.append(head, el("p", "health-detail dim", f.detail));

    const actions = el("div", "health-card-actions");
    const btn = (label, cls, fn, title) => {
      const b = /** @type {HTMLButtonElement} */ (el("button", cls, label));
      b.type = "button";
      if (title) b.title = title;
      b.addEventListener("click", fn);
      actions.append(b);
      return b;
    };
    if (f.fix) {
      const fixBtn = btn(f.fix.label, "primary", async () => {
        fixBtn.disabled = true;
        try {
          const { label, ...req } = f.fix;
          await api().health.fix(req);
          f.status = "open";
          c.classList.add("st-fixed");
          status.textContent = "fixed";
          status.hidden = false;
          for (const b of actions.querySelectorAll("button")) b.disabled = true;
          toast("Fixed. It will not appear on the next run.");
          opts.onChanged?.(); // edges/contacts changed; let the graph refresh
        } catch (err) {
          fixBtn.disabled = false;
          toastError(err);
        }
      }, "Apply this correction now. It changes your data, and a backup is kept as usual");
    }
    // Any finding anchored to real records gets jumps, fix or no fix: focus
    // the exact nodes on the canvas, and open the anchoring contact's card.
    if (f.focusIds?.length) {
      btn("Show on graph", null, () => opts.onShowOnGraph?.(/** @type {number[]} */ (f.focusIds)),
        "Switch to the Network view with the records behind this finding highlighted");
    }
    if (f.contactId != null) {
      btn("Open contact", null, () => opts.onOpenContact?.(/** @type {number} */ (f.contactId)),
        "Open the contact card so you can correct this by hand");
    } else if (f.action === "open-dedup") {
      btn("Review duplicates", null, () => opts.onOpenDedup?.(),
        "Open the duplicate review queue to decide what to merge");
    } else if (f.action === "open-profile") {
      btn("Open You settings", null, () => opts.goTab?.("you"),
        "Jump to the You tab to set who your network is built around");
    }
    const triage = async (next) => {
      const status_ = f.status === next ? "open" : next; // same button again = undo
      try {
        await api().health.setStatus({ fingerprint: f.fingerprint, status: status_ });
        f.status = status_;
        setStatusChip();
        renderDeck(); // re-sorts and re-applies the ignored filter
      } catch (err) { toastError(err); }
    };
    const ignoreBtn = btn(f.status === "ignored" ? "Un-ignore" : "Ignore", null, () => triage("ignored"));
    const deferBtn = btn(f.status === "deferred" ? "Un-defer" : "Defer", null, () => triage("deferred"));
    ignoreBtn.title = f.status === "ignored"
      ? "Bring this finding back into the list"
      : "Hide this finding until the underlying issue changes";
    deferBtn.title = f.status === "deferred"
      ? "Move this finding back up with the open ones"
      : "Keep it listed, parked at the bottom";
    c.append(actions);
    return c;
  }

  async function run() {
    runBtn.disabled = true;
    runBtn.textContent = "Reviewing…";
    deck.innerHTML = "";
    deck.append(el("p", "dim mono", "Scanning contacts, connections, and relationships…"));
    try {
      const r = await api().health.scan({});
      findings = r.findings;
      renderSummary(r);
      renderDeck();
    } catch (err) {
      deck.innerHTML = "";
      toastError(err);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "Run review";
    }
  }
  runBtn.addEventListener("click", run);
  showIgnored.addEventListener("change", renderDeck);

  // Until a rerun replaces it, show the previous run's deck with its triage
  // (re-merged main-side), not an empty screen.
  deck.append(el("p", "dim mono health-empty", "No review yet. Run one to check your data."));
  api().health.last({})
    .then((r) => {
      if (!r) return;
      findings = r.findings;
      renderSummary(r);
      renderDeck();
    })
    .catch(() => { /* no stored run (or pre-upgrade shape): the empty state stands */ });
}

/** Location autocomplete and detailed-map online preference. */
async function locationSection(parent, signal) {
  let enabled = false;
  try {
    ({ enabled } = await api().location.online({}));
  } catch { /* backend not loaded yet (needs an app restart); show unavailable */ }
  const sec = section(parent, "Location search");
  sec.append(el("p", "dim", "Detailed map tiles and address search are enabled by default. The location text you search and the map area you view are sent to the map providers; contact names and relationships are not. Turn this off to use only the bundled city list and country-outline map."));
  const toggle = el("label", "toggle-row");
  toggle.title = "On: detailed map tiles and address search, which send your search text and the map area you view to OpenStreetMap. Off: only the bundled city list and country-outline map, with no network at all";
  const cb = /** @type {HTMLInputElement} */ (el("input"));
  cb.type = "checkbox";
  cb.checked = !!enabled;
  cb.addEventListener("change", async () => {
    try {
      await api().location.setOnline({ enabled: cb.checked });
      toast(cb.checked ? "Online location search on." : "Online location search off.");
    } catch (err) {
      cb.checked = !cb.checked;
      toastError(err);
    }
  });
  toggle.append(cb, el("span", null, "Online maps & location search (OpenStreetMap)"));
  sec.append(toggle);
  const netHint = el("p", "dim mono field-hint");
  const refreshNet = () => {
    netHint.hidden = !(cb.checked && !navigator.onLine);
    netHint.textContent = "You're offline right now - online search resumes automatically when you reconnect.";
  };
  cb.addEventListener("change", refreshNet);
  window.addEventListener("online", refreshNet, { signal });
  window.addEventListener("offline", refreshNet, { signal });
  refreshNet();
  sec.append(netHint);
}

/** Restore picker: list every retained backup with its details and let the user
 *  choose which one to restore (the current state is snapshotted first, then the
 *  app relaunches). Only backups that open cleanly are selectable. */
async function openRestorePicker(onDeleted) {
  let list;
  try {
    list = await api().data.backupList({});
  } catch (err) {
    toastError(err);
    return;
  }
  const m = openModal({ title: "Restore from a backup" });
  m.body.append(
    el("p", "dim", "Choose a backup to restore. Your current data is backed up first, then the app relaunches. Only backups that open cleanly can be restored.")
  );
  if (!list.length) {
    m.body.append(el("p", "dim mono", "No backups yet."));
    const ok = el("button", null, "Close");
    ok.type = "button";
    ok.title = "Close this dialog (Esc)";
    ok.addEventListener("click", () => m.close());
    m.foot.append(ok);
    return;
  }

  let selected = null;
  const restore = el("button", "danger", "Restore & relaunch");
  restore.type = "button";
  restore.title = "Replace your current data with the selected backup. Your current data is backed up first, then Orbit relaunches";
  restore.disabled = true;

  const rows = el("div", "restore-list");
  for (const b of list) {
    const rowEl = el("div", "restore-row");
    if (!b.ok) rowEl.classList.add("restore-bad");
    const radio = /** @type {HTMLInputElement} */ (el("input"));
    radio.type = "radio";
    radio.name = "restore-pick";
    radio.disabled = !b.ok;
    rowEl.title = b.ok
      ? `Restore the snapshot taken ${fmtWhen(b.takenAt)}`
      : "This backup cannot be opened, so it cannot be restored";
    radio.setAttribute("aria-label", rowEl.title);
    radio.addEventListener("change", () => { selected = b.name; restore.disabled = false; });
    const meta = el("div", "restore-meta");
    const contacts = b.contacts == null ? "unreadable" : `${b.contacts.toLocaleString()} contacts`;
    const sub = el("div", "restore-sub mono dim", `${contacts} · ${fmtBytes(b.sizeBytes)}${b.ok ? "" : " · cannot open"}`);
    meta.append(el("div", "restore-when", fmtWhen(b.takenAt)), sub);
    if (b.kind === "pre-migration") {
      const tag = el("span", "restore-tag", "before update");
      tag.title = "A recovery snapshot taken automatically just before a version update";
      meta.append(tag);
    }
    const del = el("button", "restore-delete", "Delete");
    del.type = "button";
    del.title = `Remove the backup from ${fmtWhen(b.takenAt)}. This cannot be undone`;
    del.setAttribute("aria-label", `Delete backup from ${fmtWhen(b.takenAt)}`);
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const yes = await confirmModal({
        title: "Delete this backup?",
        message: `Delete the backup from ${fmtWhen(b.takenAt)}? This cannot be undone.`,
        confirmLabel: "Delete backup",
        danger: true,
      });
      if (!yes) return;
      del.disabled = true;
      try {
        await api().data.deleteBackup({ name: b.name });
        if (selected === b.name) { selected = null; restore.disabled = true; }
        rowEl.remove();
        if (!rows.children.length) rows.append(el("p", "dim mono restore-empty", "No backups yet."));
        toast("Backup deleted.");
        onDeleted?.();
      } catch (err) { del.disabled = false; toastError(err); }
    });
    rowEl.addEventListener("click", () => {
      if (!b.ok) return;
      radio.checked = true; selected = b.name; restore.disabled = false;
    });
    rowEl.append(radio, meta, del);
    rows.append(rowEl);
  }
  m.body.append(rows);

  const cancel = el("button", null, "Cancel");
  cancel.type = "button";
  cancel.title = "Close without restoring anything (Esc)";
  cancel.addEventListener("click", () => m.close());
  restore.addEventListener("click", async () => {
    if (!selected) return;
    restore.disabled = true;
    try {
      await api().data.restoreBackup({ name: selected });
      toast("Restoring… the app will relaunch.");
      m.close();
    } catch (err) {
      restore.disabled = false;
      toastError(err);
    }
  });
  m.foot.append(cancel, restore);
}

/**
 * Render the Settings page into a content-pane container.
 * @param {HTMLElement} container
 * @param {{ onExport: () => void, onExportCsv: () => void, onImport: () => void, onChanged: () => void, onPaletteChanged?: () => void, onOpenContact?: (id: number) => void, onOpenDedup?: () => void, onShowOnGraph?: (ids: number[]) => void,
 *           initialTab?: string, onSetupChanged?: () => void, onOpenPalette?: () => void, onBackupNow?: () => void | Promise<void> }} opts
 */
export async function renderSettings(container, opts) {
  settingsControllers.get(container)?.abort();
  const controller = new AbortController();
  settingsControllers.set(container, controller);
  const { onExport, onExportCsv, onImport, onChanged, onPaletteChanged, onOpenContact, onOpenDedup, onShowOnGraph,
    initialTab, onSetupChanged, onOpenPalette, onBackupNow } = opts;
  const rerender = () => renderSettings(container, opts);

  let status;
  let updateStatus;
  let setupStatus;
  try {
    [status, updateStatus, setupStatus] = await Promise.all([
      api().data.backupStatus({}),
      api().updates.status({}),
      api().setup.status({}),
    ]);
  } catch (err) {
    if (controller.signal.aborted) return;
    toastError(err);
    return;
  }
  if (controller.signal.aborted) return;

  container.innerHTML = "";
  const page = el("div", "settings-page");
  page.append(el("h2", "page-title", "Settings"));

  // Tabs, one per concern: who you are, how it looks, what leaves the device,
  // where the data lives, and what version is running. The last-viewed tab is
  // remembered so "check the backups again" is one click, not a re-navigation.
  const TABS = [
    { id: "setup", label: "Setup", hint: "The one-time steps that make Orbit yours, each with what to do" },
    { id: "you", label: "You", hint: "Who your network is built around" },
    { id: "appearance", label: "Appearance", hint: "Colour palettes for the graph, legend, and map" },
    { id: "privacy", label: "Privacy & Security", hint: "Encryption, what can leave this device, and telemetry" },
    { id: "data", label: "Data & Backups", hint: "Counts, export and import, backups, and clearing everything" },
    { id: "admin", label: "Review", hint: "Scan your data for broken or contradictory records" },
    { id: "about", label: "About", hint: "Version, updates, and the log file" },
  ];
  const TAB_KEY = "orbit-settings-tab";
  // A requested tab wins; otherwise the remembered one; a first visit with the
  // checklist still open lands on it, later visits on You.
  let current = initialTab ?? localStorage.getItem(TAB_KEY);
  if (!TABS.some((t) => t.id === current)) current = setupStatus.complete ? "you" : "setup";

  const tablist = el("div", "settings-tabs");
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "Settings sections");
  const panels = el("div", "settings-panels");
  page.append(tablist, panels);
  container.append(page);

  /** @type {Map<string, { tab: HTMLButtonElement, panel: HTMLElement }>} */
  const tabs = new Map();
  function selectTab(id, focusTab = false) {
    current = id;
    localStorage.setItem(TAB_KEY, id);
    for (const [tid, t] of tabs) {
      const on = tid === id;
      t.tab.setAttribute("aria-selected", String(on));
      t.tab.tabIndex = on ? 0 : -1;
      t.tab.classList.toggle("selected", on);
      t.panel.hidden = !on;
    }
    if (focusTab) tabs.get(id)?.tab.focus();
  }
  for (const t of TABS) {
    const btn = /** @type {HTMLButtonElement} */ (el("button", "settings-tab", t.label));
    btn.type = "button";
    btn.title = t.hint;
    btn.id = `settings-tab-${t.id}`;
    btn.setAttribute("role", "tab");
    const panel = el("div", "settings-panel");
    panel.id = `settings-panel-${t.id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", btn.id);
    btn.setAttribute("aria-controls", panel.id);
    btn.addEventListener("click", () => selectTab(t.id));
    tabs.set(t.id, { tab: btn, panel });
    tablist.append(btn);
    panels.append(panel);
  }
  // Roving focus per the ARIA tabs pattern: arrows move AND activate.
  tablist.addEventListener("keydown", (e) => {
    const order = TABS.map((t) => t.id);
    const i = order.indexOf(current);
    let next = null;
    if (e.key === "ArrowRight") next = order[(i + 1) % order.length];
    else if (e.key === "ArrowLeft") next = order[(i - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (next) { e.preventDefault(); selectTab(next, true); }
  });
  selectTab(current);
  const pane = (id) => /** @type {HTMLElement} */ (tabs.get(id)?.panel);

  // --- Setup: the checklist ---
  setupSection(pane("setup"), setupStatus, {
    goTab: selectTab, onImport, onOpenPalette, onBackupNow,
    onChanged: () => { onSetupChanged?.(); rerender(); },
  });

  // --- You: who the network is built around ---
  await profileSection(pane("you"), onChanged, rerender);
  if (controller.signal.aborted) return;

  // --- Appearance: the graph's colors ---
  appearanceSection(pane("appearance"), onPaletteChanged);

  // --- Privacy & Security: what protects the data, what can leave the device ---
  const priv = pane("privacy");
  const enc = section(priv, "Encryption");
  row(enc, "at rest", "AES-256 (SQLCipher), whole file",
    "Everything, including the search index, lives inside one encrypted file. Nothing is written in plain text");
  row(enc, "key", "random 256-bit, stored in your OS keychain",
    "Orbit never asks you for a passphrase: the key is held by the operating system's keychain");
  row(enc, "database", `${status.dbPath} · ${fmtBytes(status.dbSizeBytes)}`,
    "Where the encrypted database file lives on this device, and how large it is");
  await locationSection(priv, controller.signal);
  if (controller.signal.aborted) return;
  const tele = section(priv, "Telemetry");
  row(tele, "telemetry", "none - online maps send only viewed areas and location queries",
    "Orbit reports no usage data at all. The only outbound traffic is map tiles and address lookups, and only while online maps are on");

  // --- Admin: run a data review, fix or triage the findings ---
  adminSection(pane("admin"), { onChanged, onOpenContact, onOpenDedup, onShowOnGraph, goTab: selectTab });

  // --- About: version, updates, diagnostics ---
  const about = section(pane("about"), "About");
  about.append(aboutSummary());
  row(about, "version", status.appVersion, "The build of Orbit currently running");
  const updateLabels = {
    disabled: "switched off in config",
    idle: "running the code on disk",
    checking: "checking…",
    "up-to-date": "running the code on disk",
    downloading: `downloading ${updateStatus.availableVersion ?? "update"}…`,
    ready: `${updateStatus.availableVersion ? "v" + updateStatus.availableVersion : "newer code"} on disk; restart to apply`,
    blocked: "newer code on disk, but the safety backup failed",
    error: "last check failed",
  };
  row(about, "updates", updateLabels[updateStatus.phase] ?? updateStatus.phase,
    "Whether the running service matches the code in the Orbit folder. bin/orbit update fetches new code");
  if (updateStatus.error) about.append(el("p", "field-hint dim mono", updateStatus.error));
  const updateBtn = el("button", null, "Check for updates");
  updateBtn.type = "button";
  updateBtn.title = updateStatus.supported
    ? "Look now for newer code in the Orbit folder (bin/orbit update fetches it). Orbit also checks on its own"
    : "Updates are switched off in config";
  updateBtn.disabled = !updateStatus.supported || updateStatus.phase === "checking";
  updateBtn.addEventListener("click", async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = "Checking…";
    try {
      const next = await api().updates.check({});
      if (next.phase === "up-to-date") toast("Orbit is running the current code.");
      else if (next.phase === "ready") toast(`${next.availableVersion ? "Orbit v" + next.availableVersion : "Newer code"} is on disk. Restart to apply it.`);
      rerender();
    } catch (err) {
      toastError(err);
      rerender();
    }
  });
  about.append(updateBtn);
  if (updateStatus.phase === "ready") {
    const restartBtn = el("button", "primary", `Restart to update${updateStatus.availableVersion ? ` to v${updateStatus.availableVersion}` : ""}`);
    restartBtn.type = "button";
    restartBtn.title = "Restart the Orbit service onto the new code now. A verified backup is taken first; the page reloads when it is back";
    restartBtn.style.marginLeft = "8px";
    restartBtn.addEventListener("click", async () => {
      restartBtn.disabled = true;
      await api().updates.install({}).catch(toastError);
    });
    about.append(restartBtn);
  }
  row(about, "log file", status.logPath, "Where Orbit writes its diagnostic log on this device");

  // --- Data & Backups: what you have, getting it out, getting it back ---
  const dataPane = pane("data");
  const data = section(dataPane, "Data");
  row(data, "contacts", `${status.contacts.toLocaleString()} live · ${status.trashed} in trash`,
    "Live contacts, plus deleted ones still recoverable from the trash");
  row(data, "connections", status.edges.toLocaleString(),
    "Relationships recorded between your contacts");
  row(data, "trash policy", `items are permanently removed after ${status.autoPurgeDays} days`,
    "How long a deleted contact stays recoverable before it is purged for good");
  const dataActions = el("div", "card-actions");
  const exportBtn = el("button", null, "Export archive…");
  exportBtn.type = "button";
  exportBtn.title = "Write an encrypted .orbit file holding everything: contacts, connections, tags, notes, and timelines. This is the file to move devices with";
  exportBtn.addEventListener("click", () => onExport());
  const exportCsvBtn = el("button", null, "Export CSV…");
  exportCsvBtn.type = "button";
  exportCsvBtn.title = "Contacts in the import template's columns (not a full backup)";
  exportCsvBtn.addEventListener("click", () => onExportCsv());
  const importBtn = el("button", null, "Import…");
  importBtn.type = "button";
  importBtn.title = "Bring in contacts from a vCard, CSV, or Orbit archive. Everything is parsed on this device";
  importBtn.addEventListener("click", () => onImport());
  dataActions.append(exportBtn, exportCsvBtn, importBtn);
  data.append(dataActions);

  const bak = section(dataPane, "Backups");
  row(bak, "last backup", fmtWhen(status.lastBackupAt),
    "When the most recent verified snapshot was written");
  row(bak, "backups kept", `${status.backupCount} of ${status.backupKeep} · ${status.backupDir}`,
    "How many snapshots are retained, and the folder they live in");
  bak.append(el("p", "field-hint dim mono",
    `Taken automatically every ${status.backupIntervalMin} min, before updates, and on quit. Up to ${status.backupKeep} are kept in total; recovery snapshots from before updates reserve some of those slots.`));
  const bakActions = el("div", "card-actions");
  const backupBtn = el("button", null, "Back up now");
  backupBtn.type = "button";
  backupBtn.title = "Take an extra snapshot right now and verify it opens cleanly";
  backupBtn.addEventListener("click", async () => {
    try {
      await api().data.backupNow({});
      toast("Backup written and verified.");
      rerender();
    } catch (err) {
      toastError(err);
    }
  });
  const restoreBtn = el("button", "danger", "Restore from backup…");
  restoreBtn.type = "button";
  restoreBtn.title = "Roll your data back to an earlier snapshot. Your current data is backed up first, then Orbit relaunches";
  restoreBtn.addEventListener("click", () => openRestorePicker(rerender));
  bakActions.append(backupBtn, restoreBtn);
  bak.append(bakActions);

  // --- danger zone: clear everything for a fresh start ---
  const danger = section(dataPane, "Danger zone");
  danger.append(
    el("p", "dim", "Clear all data removes every contact, connection, tag, note, and saved query. A safety backup is taken first, so you can Restore latest backup afterwards if it was a mistake.")
  );
  const dangerActions = el("div", "card-actions");
  const clearBtn = el("button", "danger", "Clear all data…");
  clearBtn.type = "button";
  clearBtn.title = "Empty the database completely. A safety backup is taken first, so you can restore it afterwards";
  clearBtn.addEventListener("click", async () => {
    const yes = await confirmDangerModal({
      title: "Clear all data?",
      message:
        `This permanently deletes all ${status.contacts.toLocaleString()} contacts, ${status.edges.toLocaleString()} connections, and everything else, leaving an empty database.\n` +
        "A safety backup is taken first - you can undo this with Restore latest backup.\n" +
        "This cannot be undone from the app otherwise.",
      confirmWord: "CLEAR",
      confirmLabel: "Clear everything",
    });
    if (!yes) return;
    try {
      const r = await api().data.clearAll({});
      toast(`Cleared ${r.contacts.toLocaleString()} contacts. Starting fresh.`);
      onChanged();
      rerender();
    } catch (err) {
      toastError(err);
    }
  });
  dangerActions.append(clearBtn);
  danger.append(dangerActions);
}
