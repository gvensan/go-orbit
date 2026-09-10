// updates.js - "an update is ready" in the service model means newer code is
// on disk than the running process loaded: `bin/orbit update` pulled it, or a
// developer edited a file. The desktop updater's phases are kept so the UI's
// update pill works unchanged: `ready` lights it up, `install` restarts the
// service (after the same verified backup the desktop build took), and the
// browser reloads once the new process answers.

const fs = require("fs");
const path = require("path");
const config = require("../main/config");
const dbLayer = require("../main/db");

// The UI bundle is deliberately not watched: the service serves it from disk,
// so a rebuild needs a page reload (the bridge does that), not a restart.
const WATCHED = ["src/main", "src/server", "src/shared"];

/** Newest mtime under `dir`, recursively (a few hundred files; fine per call). */
function newestMtime(dir) {
  let newest = 0;
  /** @type {string[]} */
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      try {
        const m = fs.statSync(p).mtimeMs;
        if (m > newest) newest = m;
      } catch { /* raced a rebuild */ }
    }
  }
  return newest;
}

/**
 * @param {{ root: string, startedAt: number, currentVersion: string,
 *           runtime: { db: any, closed: boolean }, backupDir: string, key: string,
 *           log: { info: (m: string) => void, error: (m: string, e?: unknown) => void },
 *           requestRestart: () => void }} opts
 */
function createUpdates({ root, startedAt, currentVersion, runtime, backupDir, key, log, requestRestart }) {
  function versionOnDisk() {
    try {
      return String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "");
    } catch {
      return "";
    }
  }

  let cached = { at: 0, value: false };
  function codeChanged() {
    const now = Date.now();
    if (now - cached.at < config.update.codeChangeCacheMs) return cached.value;
    const threshold = startedAt + config.update.codeChangeGraceMs;
    const value = WATCHED.some((rel) => newestMtime(path.join(root, rel)) > threshold);
    cached = { at: now, value };
    return value;
  }

  function status() {
    const changed = config.update.enabled && codeChanged();
    const onDisk = versionOnDisk();
    return {
      supported: config.update.enabled,
      currentVersion,
      phase: changed ? "ready" : (config.update.enabled ? "up-to-date" : "disabled"),
      availableVersion: changed && onDisk && onDisk !== currentVersion ? onDisk : null,
      error: null,
      restartNeeded: changed,
    };
  }

  /** Restart onto the code on disk, gated on a verified snapshot. */
  function install() {
    if (!status().restartNeeded) return { ok: false };
    if (runtime.closed) return { ok: false };
    if (config.update.backupBeforeApply) dbLayer.takeBackup(runtime.db, backupDir, { key });
    log.info("[update] verified backup complete; restarting onto the code on disk");
    requestRestart();
    return { ok: true };
  }

  return { status, check: async () => status(), install, codeChanged };
}

module.exports = { createUpdates };
