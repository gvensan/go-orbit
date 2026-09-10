// log.js - a plain file logger. Lines go to <home>/logs/orbit.log and, when the
// process has a terminal, to stdout/stderr as well. One rotation (.1) keeps
// the file bounded. Nothing here formats contact data: callers log counts,
// paths, and error messages, never names or notes (SECURITY §6).

const fs = require("fs");
const config = require("../main/config");

/**
 * @param {{ file: string, maxBytes?: number, echo?: boolean }} opts
 */
function createLogger({ file, maxBytes = config.server.logMaxBytes, echo = Boolean(process.stdout.isTTY) }) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* new file */ }

  function rotateIfNeeded(extra) {
    size += extra;
    if (size <= maxBytes) return;
    try { fs.renameSync(file, file + ".1"); } catch { /* best effort */ }
    size = extra;
  }

  /** @param {"info" | "warn" | "error"} level */
  function write(level, msg, err = undefined) {
    const detail = err instanceof Error ? ` ${err.stack || err.message}` : err !== undefined ? ` ${String(err)}` : "";
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}${detail}\n`;
    try {
      rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch { /* a full disk must not take the service down */ }
    if (echo) (level === "info" ? process.stdout : process.stderr).write(line);
  }

  return {
    path: file,
    info: (msg) => write("info", msg),
    warn: (msg, err) => write("warn", msg, err),
    error: (msg, err) => write("error", msg, err),
  };
}

module.exports = { createLogger };
