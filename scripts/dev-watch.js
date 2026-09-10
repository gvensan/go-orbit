// dev-watch.js - development watch mode without a dev server.
//
//   npm run dev:watch
//
// Runs `vite build --watch` (renderer rebuilds into dist/renderer on save) and
// the service side by side. Edits under src/main, src/server or src/shared
// restart the service through its normal SIGTERM teardown; the page notices the
// new process (or a new bundle) through its liveness poll and reloads itself.
// The service is also respawned when it exits with the restart code, so a
// restore or "restart to update" in dev behaves as it does under launchd.
// No dev server, so the production CSP holds in dev exactly as in production.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("../src/main/config");

const ROOT = path.join(__dirname, "..");
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const RESTART_DEBOUNCE_MS = 300;

/** @type {import('child_process').ChildProcess | null} */
let service = null;
let shuttingDown = false;

const viteWatch = spawn(NPX, ["vite", "build", "--watch"], { cwd: ROOT, stdio: "inherit" });

function startService() {
  service = spawn(process.execPath, ["src/server/server.js"], { cwd: ROOT, stdio: "inherit", env: process.env });
  service.on("exit", (code, signal) => {
    if (shuttingDown || signal !== null) return; // our own kill: the restart path starts the next one
    if (code === config.server.restartExitCode) {
      console.log("[dev-watch] service asked for a restart (restore/update); respawning");
      startService();
      return;
    }
    shutdown(code ?? 0); // stopped by hand or failed to boot: end the session
  });
}

/** @type {NodeJS.Timeout | null} */
let restartTimer = null;
function scheduleRestart(file) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log(`[dev-watch] service change (${file}), restarting`);
    if (service && !service.killed && service.exitCode === null) {
      service.once("exit", startService);
      service.kill("SIGTERM"); // clean teardown path in server.js
    } else {
      startService();
    }
  }, RESTART_DEBOUNCE_MS);
}

for (const dir of ["src/main", "src/server", "src/shared"]) {
  // recursive fs.watch is fine on macOS/Windows; on Linux only top-level
  // changes are seen, which still covers the common files.
  try {
    fs.watch(path.join(ROOT, dir), { recursive: true }, (_event, file) => scheduleRestart(`${dir}/${file}`));
  } catch { /* directory missing in a partial checkout */ }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { viteWatch.kill("SIGTERM"); } catch {}
  try { service?.kill("SIGTERM"); } catch {}
  setTimeout(() => process.exit(code), 500);
}

viteWatch.on("exit", (code) => { if (!shuttingDown && code) shutdown(code); });
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

startService();
console.log("[dev-watch] renderer: vite --watch; service: restart on src change and after restore/update. The page reloads itself. Ctrl+C to stop.");
