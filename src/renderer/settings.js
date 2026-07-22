// settings.js - encryption status, backup health + restore, data counts,
// export/import shortcuts, about/diagnostics (APP_SHELL_UX §3).
// Rendered as a full page in the content pane, not a modal.

import { confirmDangerModal, confirmModal, el, openModal } from "./modal.js";
import { toast, toastError } from "./toast.js";

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

function row(sec, label, value) {
  const r = el("div", "field-row");
  r.append(el("span", "field-key mono", label), el("span", "field-val", value));
  sec.append(r);
  return r;
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
  cancel.addEventListener("click", () => m.close());
  m.foot.append(cancel);
  search.focus();
}

/** @param {() => void} [onChanged] @param {() => void} [rerender] */
async function profileSection(body, onChanged, rerender) {
  let profile = {};
  try {
    profile = await api().profile.get({});
  } catch (err) {
    toastError(err);
  }
  const sec = section(body, "You");
  sec.append(el("p", "dim", "This is you - the person your whole network is built around. You appear as a node in the graph (a gold node), connected only to the people you link. Home centres on you."));

  // Already someone in your contacts? Point "you" at them instead of retyping.
  const pickLine = el("p", "field-hint");
  pickLine.append(document.createTextNode("Already in your contacts? "));
  const pickLink = el("a", "template-link");
  pickLink.textContent = "Choose an existing contact as you";
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

  const field = (key, label, placeholder) => {
    grid.append(el("label", "profile-key mono", label));
    const input = /** @type {HTMLInputElement} */ (el("input"));
    input.value = profile[key] ?? "";
    input.placeholder = placeholder;
    inputs[key] = input;
    grid.append(input);
  };

  field("name", "name", "your full name");

  grid.append(el("label", "profile-key mono", "gender"));
  const genderSel = /** @type {HTMLSelectElement} */ (el("select"));
  genderSel.append(new Option("(unspecified)", ""));
  for (const g of ["Female", "Male"]) genderSel.append(new Option(g, g));
  if (profile.gender && !["Female", "Male"].includes(profile.gender)) {
    genderSel.append(new Option(profile.gender, profile.gender));
  }
  genderSel.value = profile.gender ?? "";
  inputs.gender = genderSel;
  grid.append(genderSel);

  field("email", "email", "you@example.com");
  field("phone", "phone", "phone");
  field("company", "company", "company");
  field("role", "role", "role / title");
  sec.append(grid);

  const save = async () => {
    /** @type {Record<string, string>} */
    const next = {};
    for (const [k, input] of Object.entries(inputs)) {
      const v = input.value.trim();
      if (v) next[k] = v;
    }
    try {
      await api().profile.set(next);
      onChanged?.(); // owner may be a new node - let the graph refresh
    } catch (err) {
      toastError(err);
    }
  };
  for (const input of Object.values(inputs)) input.addEventListener("change", save);
}

/** Location autocomplete preference: local list vs. opt-in online city search. */
async function locationSection(parent, signal) {
  let enabled = false;
  try {
    ({ enabled } = await api().location.online({}));
  } catch { /* backend not loaded yet (needs an app restart); default off */ }
  const sec = section(parent, "Location search");
  sec.append(el("p", "dim", "Location suggestions come from a built-in city list, fully offline, and the Geomap uses a bundled vector world map. Turn this on to search OpenStreetMap for neighborhoods and full addresses as you type, and to show detailed map tiles. The location text you search and the map area you view then leave this device. Off by default."));
  const toggle = el("label", "toggle-row");
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
    ok.addEventListener("click", () => m.close());
    m.foot.append(ok);
    return;
  }

  let selected = null;
  const restore = el("button", "danger", "Restore & relaunch");
  restore.type = "button";
  restore.disabled = true;

  const rows = el("div", "restore-list");
  for (const b of list) {
    const rowEl = el("div", "restore-row");
    if (!b.ok) rowEl.classList.add("restore-bad");
    const radio = /** @type {HTMLInputElement} */ (el("input"));
    radio.type = "radio";
    radio.name = "restore-pick";
    radio.disabled = !b.ok;
    radio.addEventListener("change", () => { selected = b.name; restore.disabled = false; });
    const meta = el("div", "restore-meta");
    const contacts = b.contacts == null ? "unreadable" : `${b.contacts.toLocaleString()} contacts`;
    const sub = el("div", "restore-sub mono dim", `${contacts} · ${fmtBytes(b.sizeBytes)}${b.ok ? "" : " · cannot open"}`);
    meta.append(el("div", "restore-when", fmtWhen(b.takenAt)), sub);
    if (b.kind === "pre-migration") meta.append(el("span", "restore-tag", "before update"));
    const del = el("button", "restore-delete", "Delete");
    del.type = "button";
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
 * @param {{ onExport: () => void, onImport: () => void, onChanged: () => void }} opts
 */
export async function renderSettings(container, opts) {
  settingsControllers.get(container)?.abort();
  const controller = new AbortController();
  settingsControllers.set(container, controller);
  const { onExport, onImport, onChanged } = opts;
  const rerender = () => renderSettings(container, opts);

  let status;
  try {
    status = await api().data.backupStatus({});
  } catch (err) {
    if (controller.signal.aborted) return;
    toastError(err);
    return;
  }
  if (controller.signal.aborted) return;

  container.innerHTML = "";
  const page = el("div", "settings-page");
  page.append(el("h2", "page-title", "Settings"));
  // Two independently-scrolling columns: identity on the left, data on the right.
  const cols = el("div", "settings-cols");
  const left = el("div", "settings-col");
  const divider = el("div", "settings-divider");
  const right = el("div", "settings-col");
  cols.append(left, divider, right);
  page.append(cols);
  container.append(page);

  // --- left: who you are + preferences + about ---
  await profileSection(left, onChanged, rerender);
  if (controller.signal.aborted) return;
  await locationSection(left, controller.signal);
  if (controller.signal.aborted) return;
  const about = section(left, "About");
  row(about, "version", status.appVersion);
  row(about, "updates", "auto-update ships with signed builds (M6); no network calls until then");
  row(about, "log file", status.logPath);
  row(about, "telemetry", "none - nothing leaves this device except your exports");

  const enc = section(right, "Encryption");
  row(enc, "at rest", "AES-256 (SQLCipher), whole file");
  row(enc, "key", "random 256-bit, stored in your OS keychain");
  row(enc, "database", `${status.dbPath} · ${fmtBytes(status.dbSizeBytes)}`);

  const bak = section(right, "Backups");
  row(bak, "last backup", fmtWhen(status.lastBackupAt));
  row(bak, "backups kept", `${status.backupCount} of ${status.backupKeep} · ${status.backupDir}`);
  bak.append(el("p", "field-hint dim mono",
    `Taken automatically every ${status.backupIntervalMin} min, before updates, and on quit. Up to ${status.backupKeep} are kept in total; recovery snapshots from before updates reserve some of those slots.`));
  const bakActions = el("div", "card-actions");
  const backupBtn = el("button", null, "Back up now");
  backupBtn.type = "button";
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
  restoreBtn.addEventListener("click", () => openRestorePicker(rerender));
  bakActions.append(backupBtn, restoreBtn);
  bak.append(bakActions);

  const data = section(right, "Data");
  row(data, "contacts", `${status.contacts.toLocaleString()} live · ${status.trashed} in trash`);
  row(data, "connections", status.edges.toLocaleString());
  row(data, "trash policy", `items are permanently removed after ${status.autoPurgeDays} days`);
  const dataActions = el("div", "card-actions");
  const exportBtn = el("button", null, "Export archive…");
  exportBtn.type = "button";
  exportBtn.addEventListener("click", () => onExport());
  const importBtn = el("button", null, "Import…");
  importBtn.type = "button";
  importBtn.addEventListener("click", () => onImport());
  dataActions.append(exportBtn, importBtn);
  data.append(dataActions);

  // --- danger zone: clear everything for a fresh start ---
  const danger = section(right, "Danger zone");
  danger.append(
    el("p", "dim", "Clear all data removes every contact, connection, tag, note, and saved query. A safety backup is taken first, so you can Restore latest backup afterwards if it was a mistake.")
  );
  const dangerActions = el("div", "card-actions");
  const clearBtn = el("button", "danger", "Clear all data…");
  clearBtn.type = "button";
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
