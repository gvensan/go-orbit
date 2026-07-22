// dev-watch.js - development watch mode without a dev server.
//
//   npm run dev:watch
//
// Runs `vite build --watch` (renderer rebuilds into dist/renderer on save) and
// Electron side by side. The main process watches dist/renderer and reloads
// the window when it changes (see main.js), so renderer edits appear in ~1s.
// Edits under src/main or src/shared restart Electron entirely, which also
// exercises the boot/teardown lifecycle on every save. No dev server, so the
// CSP's connect-src 'none' holds in dev exactly as in production.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const RESTART_DEBOUNCE_MS = 300;

/** @type {import('child_process').ChildProcess | null} */
let electron = null;
let shuttingDown = false;

const viteWatch = spawn(NPX, ["vite", "build", "--watch"], {
  cwd: ROOT,
  stdio: "inherit",
});

function startElectron() {
  electron = spawn(NPX, ["electron", "."], { cwd: ROOT, stdio: "inherit" });
  electron.on("exit", (code, signal) => {
    // Closed by hand (not by our restart kill): stop the whole watch session.
    if (!shuttingDown && signal === null) shutdown(code ?? 0);
  });
}

/** @type {NodeJS.Timeout | null} */
let restartTimer = null;
function scheduleRestart(file) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log(`[dev-watch] main-process change (${file}), restarting Electron`);
    if (electron && !electron.killed) {
      electron.once("exit", startElectron);
      electron.kill("SIGTERM"); // clean teardown path in main.js
    } else {
      startElectron();
    }
  }, RESTART_DEBOUNCE_MS);
}

for (const dir of ["src/main", "src/shared"]) {
  // recursive fs.watch is fine on macOS/Windows; on Linux only top-level
  // changes are seen, which still covers the common files.
  try {
    fs.watch(path.join(ROOT, dir), { recursive: true }, (_event, file) =>
      scheduleRestart(`${dir}/${file}`)
    );
  } catch {}
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { viteWatch.kill("SIGTERM"); } catch {}
  try { electron?.kill("SIGTERM"); } catch {}
  setTimeout(() => process.exit(code), 500);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

startElectron();
console.log("[dev-watch] renderer: vite --watch -> auto window reload; main/shared: Electron restart. Ctrl+C to stop.");
