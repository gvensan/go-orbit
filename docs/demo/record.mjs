// Scripted walkthrough of Orbit in headless Chrome, captured as PNG frames with a
// caption bar and a cursor drawn into the page, listed in frames.txt for ffmpeg.
// Same approach as the sibling golinks project: CDP over a WebSocket, no
// dependencies. WebGL (the sigma.js canvas) runs on SwiftShader in headless mode.
//
//   docs/demo/seed.sh 7790
//   node docs/demo/record.mjs http://localhost:7790 /tmp/orbit-demo-out <token>
//   PROBE=1 node docs/demo/record.mjs ...      one screenshot, to check WebGL and the session
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.argv[2] || "http://localhost:7790";
const OUT = process.argv[3] || "/tmp/orbit-demo-out";
const TOKEN = process.argv[4] || "";
const PROBE = process.env.PROBE === "1";
const FPS = 8;
const W = 1280, H = 800;
const PORT = 9371;

const CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
const chrome = CHROMES.find((p) => fs.existsSync(p));
if (!chrome) { console.error("no Chrome found"); process.exit(1); }
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });

const proc = spawn(chrome, [
  "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
  `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/profile`, "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0;
const waiting = new Map();
const errors = [];
const send = (method, params) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (expr) => send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })
  .then((d) => d.result && d.result.result && d.result.result.value);

// ---- frame capture at a steady rate, in the background
let frame = 0, recording = false, capturing = false;
/** @type {{ f: string, at: number }[]} */
const list = [];
async function grab() {
  if (capturing) return;
  capturing = true;
  try {
    const at = Date.now();
    const s = await send("Page.captureScreenshot", { format: "png" });
    if (s.result && s.result.data) {
      const f = `f${String(frame++).padStart(5, "0")}.png`;
      fs.writeFileSync(`${OUT}/frames/${f}`, Buffer.from(s.result.data, "base64"));
      list.push({ f, at });
    }
  } finally { capturing = false; }
}
let ticker = null;
function startRecording() { recording = true; ticker = setInterval(() => { if (recording) grab(); }, 1000 / FPS); }
function stopRecording() { recording = false; clearInterval(ticker); }

// ---- overlay: caption bar (above the legend) and a cursor
const OVERLAY = `(() => {
  if (document.getElementById('demoCap')) return;
  const st = document.createElement('style');
  st.textContent = '#demoCap{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);max-width:74%;background:rgba(10,15,28,.94);color:#e6edf7;font:500 17px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,sans-serif;padding:11px 18px;border-radius:12px;border:1px solid rgba(255,255,255,.08);box-shadow:0 8px 30px rgba(0,0,0,.45);z-index:9999;pointer-events:none;opacity:0;transition:opacity .25s;letter-spacing:.01em;text-align:center}#demoCap.show{opacity:1}#demoCap b{color:#f5c542;font-weight:600}#demoCap kbd{background:#16213a;border-radius:5px;padding:1px 7px;font:13px ui-monospace,Menlo,monospace;color:#e6edf7}#demoCur{position:fixed;width:18px;height:18px;border-radius:50%;background:rgba(245,197,66,.85);border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);z-index:10000;pointer-events:none;transform:translate(-50%,-50%);transition:left .05s linear,top .05s linear,transform .1s}#demoCur.down{transform:translate(-50%,-50%) scale(.7);background:#ff2d95}';
  document.head.appendChild(st);
  const c = document.createElement('div'); c.id = 'demoCap'; document.body.appendChild(c);
  const cur = document.createElement('div'); cur.id = 'demoCur'; cur.style.left = '640px'; cur.style.top = '400px'; document.body.appendChild(cur);
})()`;
async function overlay() { await ev(OVERLAY); }
async function caption(html, ms) {
  await overlay();
  await ev(`(() => { const c = document.getElementById('demoCap'); c.innerHTML = ${JSON.stringify(html)}; c.classList.add('show'); })()`);
  if (ms) await sleep(ms);
}
async function captionOff() { await ev("(() => { const c = document.getElementById('demoCap'); if (c) c.classList.remove('show'); })()"); }

let mouse = { x: 640, y: 400 };
async function moveTo(x, y, ms = 500) {
  const steps = Math.max(6, Math.round(ms / 40));
  const sx = mouse.x, sy = mouse.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    mouse = { x: sx + (x - sx) * e, y: sy + (y - sy) * e };
    await ev(`(() => { const c = document.getElementById('demoCur'); if (c) { c.style.left='${mouse.x}px'; c.style.top='${mouse.y}px'; } })()`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: mouse.x, y: mouse.y });
    await sleep(ms / steps);
  }
}
async function click(x, y) {
  await moveTo(x, y);
  await ev("(() => { const c = document.getElementById('demoCur'); if (c) c.classList.add('down'); })()");
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(80);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await ev("(() => { const c = document.getElementById('demoCur'); if (c) c.classList.remove('down'); })()");
  await sleep(120);
}
const rect = async (sel) => {
  const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }); })()`);
  return r ? JSON.parse(r) : null;
};
/** Rect of the first visible element whose text starts with `text` (buttons, tabs, rows). */
const rectText = async (text, scope = "button, [role=tab], [role=option], a") => {
  const r = await ev(`(() => { const t = ${JSON.stringify(text)}; const e = [...document.querySelectorAll(${JSON.stringify(scope)})].find((n) => n.offsetParent !== null && n.textContent.trim().startsWith(t)); if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }); })()`);
  return r ? JSON.parse(r) : null;
};
/** Rect of the first visible leaf element whose exact text is `text`, inside `scope`. */
const rectLeaf = async (text, scope) => {
  const r = await ev(`(() => { const t = ${JSON.stringify(text)}; const e = [...document.querySelectorAll(${JSON.stringify(scope + " *")})].find((n) => n.children.length === 0 && n.offsetParent !== null && n.textContent.trim() === t); if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }); })()`);
  return r ? JSON.parse(r) : null;
};
async function clickLeaf(text, scope) { const r = await rectLeaf(text, scope); if (!r) { errors.push("missing leaf " + text); return false; } await click(r.x + r.w / 2, r.y + r.h / 2); return true; }
async function setSelect(sel, value) {
  await hoverSel(sel);
  await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) { e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
}
async function wheel(x, y, deltaY, times = 3, gap = 260) {
  await moveTo(x, y, 400);
  for (let i = 0; i < times; i++) { await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY }); await sleep(gap); }
}
async function clickSel(sel, dx = 0.5, dy = 0.5) { const r = await rect(sel); if (!r) { errors.push("missing " + sel); return false; } await click(r.x + r.w * dx, r.y + r.h * dy); return true; }
async function clickText(text, scope) { const r = await rectText(text, scope); if (!r) { errors.push("missing text " + text); return false; } await click(r.x + r.w / 2, r.y + r.h / 2); return true; }
async function hoverSel(sel) { const r = await rect(sel); if (r) await moveTo(r.x + r.w / 2, r.y + r.h / 2); else errors.push("missing " + sel); }
async function hoverText(text, scope) { const r = await rectText(text, scope); if (r) await moveTo(r.x + r.w / 2, r.y + r.h / 2); else errors.push("missing text " + text); }
async function type(text, perChar = 70) {
  for (const ch of text) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    await sleep(perChar);
  }
}
async function key(k, code, vk) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
}
const clearPalette = async () => {
  await ev("(() => { const i = document.querySelector('#palette-root input'); if (i) { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); } })()");
  await sleep(400);
};

try {
  let targets;
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); } }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.text);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
  };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  // Sign the headless browser in through the launch URL, exactly as bin/orbit open does.
  await send("Page.navigate", { url: `${BASE}/?token=${TOKEN}` }); await sleep(2500);
  await ev("localStorage.setItem('orbit-sidebar', 'open'); localStorage.setItem('orbit-onboarded', '1');");
  await ev("location.reload()"); await sleep(3200);

  if (PROBE) {
    const gl = await ev("(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); })()");
    const landing = await ev("!!document.querySelector('#landing-continue') && document.querySelector('#landing-continue').offsetParent !== null");
    if (landing) { await clickSel("#landing-continue"); await sleep(3000); }
    await overlay(); await caption("probe", 300);
    const s = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${OUT}/probe.png`, Buffer.from(s.result.data, "base64"));
    const nodes = await ev("document.querySelectorAll('#graph-root canvas').length");
    console.log(JSON.stringify({ webgl: gl, landingShown: landing, canvases: nodes, title: await ev("document.title"), errors }));
    process.exit(0);
  }

  // The seeded sample brings up the start screen: continue into it.
  if (await ev("!!document.querySelector('#landing-continue') && document.querySelector('#landing-continue').offsetParent !== null")) {
    await clickSel("#landing-continue"); await sleep(2800);
  }
  await ev("(() => { const b = document.getElementById('sample-dismiss'); if (b) b.click(); })()");
  await overlay();
  startRecording();

  // 1. intro
  await caption("<b>Orbit</b> keeps your people as a relationship graph, with you at the centre. Everything stays encrypted on your own machine.", 4400);
  await moveTo(760, 420, 900);
  await caption("A small local service serves it to your browser. Nothing is installed in the browser, nothing leaves the machine.", 3800);
  await moveTo(640, 360, 700);
  await caption("Every line is a tie: family, colleague, friend. Couples sit together, a heart on their bond. The legend filters by tie or by gender.", 1400);
  await clickText("colleague", "#legend > *"); await sleep(1400);
  await clickText("acquaintance", "#legend > *"); await sleep(1600);
  await caption("Hide a tie type and the shape of what is left comes through. Click again to bring it back.", 1200);
  await clickText("colleague", "#legend > *"); await sleep(600);
  await clickText("acquaintance", "#legend > *"); await sleep(800);
  await clickSel("#edge-fade-toggle");
  await caption("<b>Fade links</b> dims every line so the people read on their own; the minimap keeps the whole network in view.", 3200);
  await clickSel("#edge-fade-toggle"); await sleep(600);

  // 2. search palette
  await clickSel("#search-trigger"); await sleep(600);
  await caption("<kbd>Cmd+K</kbd> opens the palette. Search forgives typos and understands what you mean.", 800);
  await type("priya"); await sleep(2200);
  await clearPalette();
  await caption("Operators narrow it down: <kbd>org:acme</kbd>, <kbd>type:family</kbd>, <kbd>has:email</kbd>, <kbd>near:2</kbd> for people within two hops.", 600);
  await type("org:acme"); await sleep(2200);
  await clearPalette();
  await type("type:family"); await sleep(2000);
  await caption("<kbd>Enter</kbd> opens a person. The palette is also the command line: every view, every action, quick add in plain words.", 1200);
  await key("Enter", "Enter", 13); await sleep(2400);

  // 3. the card
  await caption("Their card: details you can edit in place, how you know them, a timeline, and every connection with its tie.", 4200);
  await hoverText("Add connection", "button");
  await caption("<b>Add connection</b> creates a linked person in one click and opens them ready to be named. <b>Link…</b> ties two people who already exist.", 1600);
  await clickText("Add connection", "button"); await sleep(3200);
  await clickText("2 hops", "button"); // the first click closes the menu and reaches the button
  await caption("<b>2 hops</b> widens their neighbourhood: their people, and their people's people.", 3600);

  // 4. the views
  await clickSel('#sidebar [data-nav="network"]');
  await caption("Six ways to see the same network. <b>Graph</b> is a deterministic radial tree: rings by distance from you, wedges by tie.", 4800);
  await clickSel('#canvas-view-toggle [data-canvas="mesh"]');
  await caption("<b>Mesh</b> puts everyone on one ring, grouped by the kind of tie they mostly hold.", 4400);
  await clickSel('#canvas-view-toggle [data-canvas="orbit"]');
  await caption("<b>Orbit</b> rings people by how recently you were in touch, you at the centre.", 3400);
  await setSelect("#orbit-metric", "degree");
  await caption("Switch the rings to degree, keep-in-touch cadence, or influence (betweenness, computed on a worker thread).", 3800);
  await setSelect("#orbit-metric", "betweenness"); await sleep(2600);
  await setSelect("#orbit-metric", "recency"); await sleep(400);
  await clickSel('#canvas-view-toggle [data-canvas="reach"]');
  await caption("<b>Reach</b> counts hops from you: who you could be introduced to, and through whom.", 4400);
  await clickSel('#canvas-view-toggle [data-canvas="cluster"]');
  await caption("<b>Clusters</b> finds communities and organisations, drawn as bubbles you can open.", 4600);
  await clickSel('#canvas-view-toggle [data-canvas="tree"]');
  await caption("<b>Tree</b> is the family tree by generation, couples as units, expandable up and down.", 3400);
  await clickSel("#tree-expand-all");
  await caption("Expand every branch, or open one person at a time; hovering lights up a whole lineage.", 4200);
  await clickSel('#canvas-view-toggle [data-canvas="graph"]'); await sleep(1200);

  // 5. geomap, explore, find, insights
  await clickSel('#sidebar [data-nav="geomap"]');
  await caption("<b>Geomap</b> places everyone on a world map that works offline; detailed tiles are optional and switchable.", 3000);
  await wheel(720, 400, -240, 4, 420);
  await caption("Zoom in and clusters split into people; click one to open their card.", 3600);
  await clickSel('#sidebar [data-nav="list"]');
  await caption("<b>Explore</b> is the whole network as a table. Facets on the left narrow it: organisation, tag, tie, status, how connected.", 3000);
  await clickSel("#explore .facet-row"); await sleep(1800);
  await clickSel("#explore .facet-row:nth-of-type(2)"); await sleep(1600);
  await caption("Thirty-odd columns, each sortable, each movable and resizable; the layout is remembered.", 1200);
  await clickText("Company", "#explore .xp-th-label"); await sleep(1600);
  await clickText("Company", "#explore .xp-th-label"); await sleep(1200);
  await caption("Turn on <b>Edit</b> and cells become fields: a phone gets the country picker, a location its suggestions, all validated the same way as the card.", 1000);
  await clickSel('#explore button[aria-label="Edit cells"]'); await sleep(2800);
  await clickSel('#explore button[aria-label="Edit cells"]'); await sleep(400);
  await clickSel('#sidebar [data-nav="find"]');
  await caption("<b>Find</b> builds precise queries across every field: all or any of several conditions, saved for next time.", 1400);
  await clickSel('#find input[placeholder="value"]'); await type("Rivera"); await sleep(400);
  await clickText("Run query", "#find button");
  await caption("Run it, and the matches can be shown on the graph as a subgraph of their own.", 3800);
  await clickSel('#sidebar [data-nav="insights"]');
  await caption("<b>Insights</b>: who connects your world, who you are overdue to talk to, and how your network breaks down by organisation, role, tie and tag.", 5200);
  await clickSel('#sidebar [data-nav="import"]');
  await caption("<b>Import</b> reads vCard, CSV and Orbit archives. Every row is reviewed before anything is written, duplicates are flagged per row, and a backup is taken first.", 5000);
  await key("Escape", "Escape", 27); await sleep(600);

  // 6. Add to Orbit (the bookmarklet's deep link)
  await clickSel('#sidebar [data-nav="network"]');
  await caption("The <b>Add to Orbit</b> bookmark works on any web page: a LinkedIn profile, a team page, an article.", 3600);
  const params = new URLSearchParams({
    url: "https://www.linkedin.com/in/priya-natarajan/",
    title: "Priya Natarajan - Head of Platform - Initech | LinkedIn",
    og: "Priya Natarajan - Head of Platform - Initech | LinkedIn",
    site: "LinkedIn",
    text: "",
  });
  await ev(`location.hash = "#add=" + ${JSON.stringify(encodeURIComponent(params.toString()))}`); await sleep(900);
  await overlay();
  await caption("Orbit drafts the person from the page, checks whether you already have them, and asks how you know them.", 3200);
  await hoverSel("#addpage-anchor");
  await caption("Connect them to yourself, or search anyone already in Orbit. Then pick the tie.", 3400);
  await clickText("colleague", ".addpage-choices button");
  await caption("Their card opens, connected and filled in. Every field is editable right here.", 5000);

  // 7. settings: setup checklist, data and backups
  await clickSel('#sidebar [data-nav="settings"]'); await sleep(900);
  await clickSel("#settings-tab-setup");
  await caption("<b>Settings &gt; Setup</b> is a short checklist: steps Orbit can see tick themselves; the rest take a Mark done.", 5200);
  await clickSel("#settings-tab-data");
  await caption("One encrypted file, verified snapshots every fifteen minutes and before every import, restore in one click, export as an archive or CSV.", 5600);
  await clickSel("#settings-tab-admin");
  await caption("<b>Review</b> scans your data for broken ties, contradictions and gaps, with a safe fix where one exists.", 4400);

  // 8. outro
  await clickSel('#sidebar [data-nav="network"]');
  await moveTo(700, 400, 1400);
  await caption("<b>Orbit</b>: install in two minutes, your people stay in a folder you own. See the README for setup.", 4600);
  await captionOff(); await sleep(600);
  stopRecording();
  await sleep(300);
  // Each frame lasts until the next one was taken, so playback runs in real time
  // however long a screenshot took.
  const lines = list.map((x, i) => {
    const next = list[i + 1];
    const dur = next ? Math.max(0.04, (next.at - x.at) / 1000) : 1 / FPS;
    return `file '${OUT}/frames/${x.f}'\nduration ${dur.toFixed(4)}`;
  });
  fs.writeFileSync(`${OUT}/frames.txt`, lines.join("\n") + `\nfile '${OUT}/frames/${list[list.length - 1].f}'\n`);
  const seconds = (list[list.length - 1].at - list[0].at) / 1000;
  console.log("frames:", list.length, "seconds:", seconds.toFixed(1), "| issues:", errors.length ? errors.join(" | ") : "none");
} finally {
  if (ws) ws.close();
  proc.kill();
}
