// errors.js - the typed error that crosses the IPC boundary.
//
// Electron's ipcMain.handle strips custom properties from thrown errors, so an
// IpcError is serialized into the Error message behind a marker and re-parsed
// by the preload bridge. Renderer code receives the IpcError shape from
// types.d.ts; it never sees a raw stack trace.

const crypto = require("crypto");

const MARKER = "IPCERR:";

/** Domain error with an IpcError code. Thrown by repos and handlers. */
class AppError extends Error {
  /**
   * @param {"VALIDATION"|"NOT_FOUND"|"CONFLICT"|"LOCKED"|"INTERNAL"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

/**
 * Wrap any thrown value into a transport-safe Error carrying an IpcError JSON.
 * Unexpected errors are scrubbed to a correlation id; the full error is the
 * caller's to log.
 * @param {string} channel
 * @param {unknown} err
 * @returns {{ transportError: Error, correlationId: string | null, original: unknown }}
 */
function toTransportError(channel, err) {
  if (err instanceof AppError) {
    const payload = { channel, code: err.code, message: err.message };
    return { transportError: new Error(MARKER + JSON.stringify(payload)), correlationId: null, original: err };
  }
  // SQLite contention maps to the contract's LOCKED code (busy beyond
  // busy_timeout, or a restore/migration holding the file).
  const sqliteCode = String((err && /** @type {any} */ (err).code) || "");
  if (sqliteCode === "SQLITE_BUSY" || sqliteCode === "SQLITE_LOCKED") {
    const payload = { channel, code: "LOCKED", message: "The database is busy; try again in a moment." };
    return { transportError: new Error(MARKER + JSON.stringify(payload)), correlationId: null, original: err };
  }
  const correlationId = crypto.randomBytes(6).toString("hex");
  const payload = {
    channel,
    code: "INTERNAL",
    message: `Unexpected error (ref ${correlationId}).`,
  };
  return { transportError: new Error(MARKER + JSON.stringify(payload)), correlationId, original: err };
}

module.exports = { AppError, toTransportError, MARKER };
