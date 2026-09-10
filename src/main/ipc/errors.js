// errors.js - the typed error that crosses the service boundary.
//
// Handlers throw AppError with an IpcError code; toIpcError() turns anything
// thrown into the { channel, code, message } shape from types.d.ts, scrubbing
// unexpected errors to a correlation id. The HTTP layer maps the code to a
// status and the browser bridge rehydrates the shape, so UI code never sees a
// raw stack trace.

const crypto = require("crypto");

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

/** HTTP status for each IpcError code (the browser bridge reads the body, not
 *  the status, but a sensible status keeps logs and curl honest). */
const HTTP_STATUS = { VALIDATION: 400, NOT_FOUND: 404, CONFLICT: 409, LOCKED: 423, INTERNAL: 500 };

/**
 * Turn any thrown value into the IpcError shape. Unexpected errors are scrubbed
 * to a correlation id; the full error is the caller's to log.
 * @param {string} channel
 * @param {unknown} err
 * @returns {{ ipcError: { channel: string, code: keyof typeof HTTP_STATUS, message: string }, correlationId: string | null, original: unknown }}
 */
function toIpcError(channel, err) {
  if (err instanceof AppError) {
    return { ipcError: { channel, code: err.code, message: err.message }, correlationId: null, original: err };
  }
  // SQLite contention maps to the contract's LOCKED code (busy beyond
  // busy_timeout, or a restore/migration holding the file).
  const sqliteCode = String((err && /** @type {any} */ (err).code) || "");
  if (sqliteCode === "SQLITE_BUSY" || sqliteCode === "SQLITE_LOCKED") {
    return {
      ipcError: { channel, code: "LOCKED", message: "The database is busy; try again in a moment." },
      correlationId: null, original: err,
    };
  }
  const correlationId = crypto.randomBytes(6).toString("hex");
  return {
    ipcError: { channel, code: "INTERNAL", message: `Unexpected error (ref ${correlationId}).` },
    correlationId, original: err,
  };
}

module.exports = { AppError, toIpcError, HTTP_STATUS };
