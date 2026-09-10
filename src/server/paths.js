// paths.js - where the service keeps everything: one data home, by default
// ~/.orbit, overridable with ORBIT_HOME. The database, its backups, the tile
// cache, logs, the session token, and the short-lived import/export slots all
// live under it, so "back up my Orbit" is one directory and "move it" is one
// environment variable. The data home never collides with the desktop app's
// Electron profile: that key is device-and-app bound, so the two cannot share
// a database anyway (migrate with an .orbit archive).

const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("../main/config");

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [homeDir]
 */
function resolvePaths(env = process.env, homeDir = os.homedir()) {
  const override = env[config.server.homeEnv];
  const home = override && override.trim() ? path.resolve(override.trim()) : path.join(homeDir, config.server.homeDirName);
  return {
    home,
    dbPath: path.join(home, config.db.filename),
    backupDir: path.join(home, config.backup.dirName),
    tileCacheDir: path.join(home, config.map.cacheDir),
    logDir: path.join(home, "logs"),
    logFile: path.join(home, "logs", "orbit.log"),
    uploadsDir: path.join(home, "uploads"),
    exportsDir: path.join(home, "exports"),
    tokenFile: path.join(home, "session-token"),
    lockFile: path.join(home, "orbit.lock"),
    keyFile: path.join(home, "dbkey.bin"), // DPAPI-wrapped key on Windows only
  };
}

/** Create the layout with owner-only permissions. Idempotent. */
function ensurePaths(p) {
  fs.mkdirSync(p.home, { recursive: true, mode: 0o700 });
  for (const d of [p.logDir, p.uploadsDir, p.exportsDir, p.backupDir]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  return p;
}

/**
 * The listening port: ORBIT_PORT when set (the launchd agent sets it from the
 * CLI), else config.server.port.
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolvePort(env = process.env) {
  const raw = env[config.server.portEnv];
  if (raw == null || raw === "") return config.server.port;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${config.server.portEnv} must be a port number in 1..65535 (got "${raw}").`);
  }
  return n;
}

module.exports = { resolvePaths, ensurePaths, resolvePort };
