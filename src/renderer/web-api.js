// web-api.js - the browser bridge. Builds `window.api` (the same 20-namespace
// surface the desktop preload exposed) from src/shared/api-map.js, so every
// call in the UI is one POST to /api/rpc/<channel> on the local service.
//
// Four things cannot be an RPC and are handled here instead:
//   dialogs.openFile   a file picker + upload to a granted import slot
//   dialogs.saveFile   a granted export slot; the finished file is downloaded
//   app.onMenu         browser-safe keyboard shortcuts standing in for the menu
//   updates.onStatus   polling; "update" means newer code is on disk
// It also keeps the page honest about the service: a banner when it is
// unreachable, a wait-then-reload when a restore or update restarts it, and a
// reload when a new build or process appears (dev:watch and bin/orbit update).
//
// Must be imported before app.js (boot.js does), since app.js reads window.api
// at module evaluation.

import config from "../main/config.js";
import {
  API_MAP, BROWSER_ONLY_CHANNELS, DOWNLOAD_CHANNELS, RESTART_CHANNELS,
} from "../shared/api-map.js";

const RPC_BASE = "/api/rpc/";
const OFFLINE_MSG = "Orbit's service isn't responding. Start it with bin/orbit start, then reload.";
const SESSION_MSG = "Your Orbit session ended. Open Orbit again with bin/orbit open.";

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent);

// ---- banner ---------------------------------------------------------------

/** @type {HTMLDivElement | null} */
let banner = null;
let bannerKind = "";

function showBanner(text, kind) {
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "service-banner";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    Object.assign(banner.style, {
      position: "fixed", top: "0", left: "0", right: "0", zIndex: "300",
      padding: "8px 16px", textAlign: "center", font: "13px/1.4 system-ui, sans-serif",
      color: "#fff", background: "#7a1f2b",
    });
    document.body.append(banner);
  }
  banner.style.background = kind === "info" ? "#1f3f7a" : "#7a1f2b";
  banner.textContent = text;
  banner.hidden = false;
  bannerKind = kind;
}

function hideBanner(kind) {
  if (banner && (!kind || bannerKind === kind)) {
    banner.hidden = true;
    bannerKind = "";
  }
}

// ---- transport ------------------------------------------------------------

function ipcError(channel, code, message) {
  return Object.assign(new Error(message), { channel, code, message });
}

/** An error the transport itself produced (offline, restarting, session gone):
 *  its message is already in the app's voice, so toastError shows it verbatim. */
function transportError(channel, code, message) {
  return Object.assign(ipcError(channel, code, message), { transport: true });
}

async function parseBody(res) {
  try { return await res.json(); } catch { return null; }
}

/** Turn a non-2xx response into the IpcError the UI expects. */
async function failFrom(res, channel) {
  const body = await parseBody(res);
  if (res.status === 401) {
    // The session cookie is gone (token rotated, cookies cleared): the locked
    // page explains how to get back in.
    setTimeout(() => location.replace("/"), 50);
    return transportError(channel, "INTERNAL", SESSION_MSG);
  }
  if (res.status === 503) return transportError(channel, "LOCKED", "Orbit is restarting. One moment.");
  if (res.status === 413) return transportError(channel, "VALIDATION", tooLargeMessage());
  const e = body && body.error;
  if (e && typeof e.code === "string" && e.code !== "HTTP") return ipcError(e.channel || channel, e.code, e.message);
  const message = (e && e.message) || `Orbit did not answer (${res.status}).`;
  return ipcError(channel, "INTERNAL", message);
}

async function send(url, init, channel) {
  let res;
  try {
    res = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
  } catch {
    showBanner(OFFLINE_MSG, "offline");
    throw transportError(channel, "INTERNAL", OFFLINE_MSG);
  }
  hideBanner("offline");
  if (!res.ok) throw await failFrom(res, channel);
  return res;
}

async function rpc(channel, payload) {
  const res = await send(RPC_BASE + encodeURIComponent(channel), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  }, channel);
  const body = await parseBody(res);
  if (!body || body.ok !== true) throw ipcError(channel, "INTERNAL", "Orbit sent an unreadable reply.");
  return body.result;
}

async function health() {
  const res = await fetch("/api/health", { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(`health ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const basename = (p) => String(p).split(/[\\/]/).pop() || "file";
const tooLargeMessage = () => `That file is too large to import (the limit is ${Math.round(config.limits.importMaxBytes / (1024 * 1024))} MB).`;

// ---- dialogs --------------------------------------------------------------

function acceptFor(filters) {
  const exts = (Array.isArray(filters) ? filters : []).flatMap((f) => (f && Array.isArray(f.extensions) ? f.extensions : []));
  return exts.map((e) => "." + String(e).replace(/^\./, "")).join(",");
}

/** The native picker. Resolves null when the user cancels. */
function pickFile(filters) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = acceptFor(filters);
    input.style.display = "none";
    let settled = false;
    const finish = (file) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    // `cancel` is standard in every current browser (Chrome 113, Safari 16.4,
    // Firefox 91). A window-focus heuristic was rejected: it can fire before the
    // picker even opens and would resolve null under a picker still showing.
    input.addEventListener("change", () => finish(input.files && input.files[0] ? input.files[0] : null));
    input.addEventListener("cancel", () => finish(null));
    document.body.append(input);
    input.click();
  });
}

async function openFile(opts) {
  const file = await pickFile(opts && opts.filters);
  if (!file) return { path: null };
  if (file.size > config.limits.importMaxBytes) throw transportError("dialog:openFile", "VALIDATION", tooLargeMessage());
  const res = await send(`/api/files/upload?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  }, "dialog:openFile");
  const body = await parseBody(res);
  return { path: body && typeof body.path === "string" ? body.path : null };
}

/** Export slots handed out this page-load and not yet downloaded. */
const pendingExports = new Set();

async function saveFile(opts) {
  const defaultName = opts && typeof opts.defaultName === "string" && opts.defaultName ? opts.defaultName : "export";
  const res = await send("/api/files/export-slot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultName }),
  }, "dialog:saveFile");
  const body = await parseBody(res);
  const p = body && typeof body.path === "string" ? body.path : null;
  if (p) pendingExports.add(p);
  return { path: p };
}

function download(p, keep) {
  const a = document.createElement("a");
  a.href = `/api/files/download?path=${encodeURIComponent(p)}${keep ? "&keep=1" : ""}`;
  a.download = basename(p);
  a.rel = "noopener";
  a.style.display = "none";
  document.body.append(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

/** Channels whose written file the page reads back afterwards (the import
 *  wizard's "Save and reload" reopens its results CSV): the slot is kept and
 *  the real path returned so the follow-up import call still resolves. */
const KEEP_AFTER_DOWNLOAD = new Set(["import:writeResults"]);

/** After an export channel wrote its slot, hand the file to the browser and
 *  report the name the user will see in their downloads. */
function wrapDownload(call, channel) {
  const keep = KEEP_AFTER_DOWNLOAD.has(channel);
  return async (payload) => {
    const r = await call(payload);
    const p = r && typeof r.path === "string" ? r.path : null;
    if (p && pendingExports.has(p)) {
      pendingExports.delete(p);
      download(p, keep);
      return keep ? r : { ...r, path: basename(p) };
    }
    return r;
  };
}

// ---- restarts -------------------------------------------------------------

let restarting = false;

async function waitForRestart(prevStartedAt) {
  restarting = true;
  showBanner("Orbit is restarting…", "info");
  const deadline = Date.now() + config.server.restartWaitMaxMs;
  while (Date.now() < deadline) {
    await sleep(config.server.restartPollMs);
    const h = await health().catch(() => null);
    if (h && !h.restarting && h.startedAt !== prevStartedAt) {
      location.reload();
      return;
    }
  }
  restarting = false;
  showBanner("Orbit did not come back on its own. Start it with bin/orbit start, then reload.", "offline");
}

/** Restore and update both end the process; wait for the new one, then reload. */
function wrapRestart(call) {
  return async (payload) => {
    const before = await health().catch(() => null);
    const r = await call(payload);
    if (r && r.ok === false) return r; // nothing to apply
    waitForRestart(before ? before.startedAt : null);
    return r;
  };
}

// ---- menu commands (keyboard) -----------------------------------------------

/** @type {Set<(id: string) => void>} */
const menuListeners = new Set();

function onMenu(cb) {
  menuListeners.add(cb);
  return () => { menuListeners.delete(cb); };
}

// Browsers reserve Cmd/Ctrl+N (new window), Cmd/Ctrl+L (address bar) and
// Cmd+, (preferences), which the desktop menu used. The page keeps those
// bindings for browsers that pass them through and adds ones every browser
// leaves alone: Control+key on macOS, Alt+key elsewhere.
const MENU_KEYS = { KeyN: "new-contact", KeyL: "list", KeyI: "import", Comma: "settings" };

window.addEventListener("keydown", (e) => {
  const alt = IS_MAC ? (e.ctrlKey && !e.metaKey && !e.altKey) : (e.altKey && !e.ctrlKey && !e.metaKey);
  if (!alt || e.shiftKey) return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  const id = MENU_KEYS[e.code];
  if (!id) return;
  e.preventDefault();
  for (const cb of menuListeners) cb(id);
});

// ---- update status + liveness -------------------------------------------------

function onStatus(cb) {
  let last = "";
  let stopped = false;
  const tick = async () => {
    if (stopped || restarting) return;
    try {
      const s = await rpc("update:status", {});
      const key = JSON.stringify(s);
      if (key !== last) {
        last = key;
        cb(s);
      }
    } catch { /* offline banner already shown by rpc() */ }
  };
  tick();
  const timer = setInterval(tick, config.server.statusPollMs);
  return () => { stopped = true; clearInterval(timer); };
}

/** Cheap unauthenticated heartbeat: shows the offline banner, and reloads onto a
 *  new process or a new UI build (dev:watch, bin/orbit update + restart). */
function startLiveness() {
  let startedAt = null;
  let builtAt = null;
  let first = true;
  setInterval(async () => {
    if (restarting) return;
    let h;
    try {
      h = await health();
    } catch {
      showBanner(OFFLINE_MSG, "offline");
      return;
    }
    hideBanner("offline");
    if (h.restarting) return;
    if (first) {
      first = false;
      startedAt = h.startedAt;
      builtAt = h.rendererBuiltAt;
      return;
    }
    // A null build time means `vite build` has emptied dist and is mid-write:
    // reloading now would land on the "building" page, so wait for the new stamp.
    const newBuild = h.rendererBuiltAt != null && builtAt != null && h.rendererBuiltAt !== builtAt;
    if (builtAt == null && h.rendererBuiltAt != null) builtAt = h.rendererBuiltAt;
    if (h.startedAt !== startedAt || newBuild) location.reload();
  }, config.server.livenessPollMs);
}

// ---- assemble window.api ----------------------------------------------------

/** @type {any} */
const api = {};
for (const [ns, methods] of Object.entries(API_MAP)) {
  api[ns] = api[ns] || {};
  for (const [method, channel] of Object.entries(methods)) {
    if (BROWSER_ONLY_CHANNELS.includes(channel)) continue;
    let fn = (payload) => rpc(channel, payload);
    if (DOWNLOAD_CHANNELS.includes(channel)) fn = wrapDownload(fn, channel);
    if (RESTART_CHANNELS.includes(channel)) fn = wrapRestart(fn);
    api[ns][method] = fn;
  }
}
api.dialogs = { openFile, saveFile };
api.app = { onMenu };
api.updates.onStatus = onStatus;

window.api = api;
startLiveness();

export { api };
