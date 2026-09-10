// doctor.js - one place that answers "why isn't Orbit working?" with a fix
// per finding. Served at /api/doctor and printed by `bin/orbit doctor`. Each
// check is { id, ok, label, detail, fix }: ok=true passes, ok=false fails with
// a copy-pasteable fix, ok=null was skipped.

const fs = require("fs");
const path = require("path");
const config = require("../main/config");
const dbLayer = require("../main/db");

/**
 * @param {{ paths: ReturnType<typeof import('./paths').resolvePaths>, runtime: { db: any, closed: boolean },
 *           keyBackend: string, distDir: string, port: number, version: string,
 *           updates: { codeChanged: () => boolean } }} deps
 */
function runDoctor({ paths, runtime, keyBackend, distDir, port, version, updates }) {
  /** @type {{ id: string, ok: boolean | null, label: string, detail?: string, fix?: string }[]} */
  const checks = [];
  const add = (id, ok, label, detail, fix) => checks.push({ id, ok, label, detail, fix });

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 24, "Node.js", `${process.version} at ${process.execPath}`,
    "Install Node 24 LTS from https://nodejs.org, then run bin/orbit node && bin/orbit restart.");

  try {
    fs.accessSync(paths.home, fs.constants.W_OK);
    add("home", true, "Data home is writable", paths.home);
  } catch {
    add("home", false, "Data home is writable", paths.home,
      `Fix permissions on ${paths.home} (it should belong to you, mode 700), or set ${config.server.homeEnv} to a writable folder.`);
  }

  add("key", true, "Database key", `stored in the ${keyBackend}`);

  if (runtime.closed || !runtime.db) {
    add("db", null, "Database", "restarting");
  } else {
    let ok = false;
    let detail = "";
    try {
      ok = runtime.db.pragma("quick_check", { simple: true }) === "ok";
      const n = runtime.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE deleted_at IS NULL").get().n;
      detail = `${paths.dbPath} (${n.toLocaleString()} contacts, encrypted)`;
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    add("db", ok, "Database opens and passes quick_check", detail,
      "Restore the newest good snapshot from Settings > Data & Backups, or run bin/orbit logs to see what failed.");
  }

  const backups = dbLayer.listBackups(paths.backupDir);
  if (backups.length) {
    let age = null;
    try { age = Date.now() - fs.statSync(backups[0]).mtimeMs; } catch { /* rotated */ }
    const stale = age != null && age > config.backup.intervalMs * 4;
    add("backups", !stale, "Backups", `${backups.length} snapshot(s), newest ${age == null ? "unknown" : Math.round(age / 60000) + " min ago"} in ${paths.backupDir}`,
      "The periodic backup has not run in a while. Check bin/orbit logs for [backup] errors.");
  } else {
    add("backups", null, "Backups", "none yet (the first snapshot is taken 15 minutes after a change)");
  }

  const index = path.join(distDir, "index.html");
  add("renderer", fs.existsSync(index), "Web UI bundle", index,
    "Run npm run build in the Orbit folder, then bin/orbit restart.");

  add("port", true, "Listening", `http://127.0.0.1:${port}`);

  const restartNeeded = updates.codeChanged();
  add("code", !restartNeeded, "Running the code on disk",
    restartNeeded ? "files changed since the service started" : "up to date",
    "Run bin/orbit restart.");

  return { version, pid: process.pid, restartNeeded, checks };
}

module.exports = { runDoctor };
