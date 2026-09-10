// auth.js - who may talk to the service (SECURITY §5, service edition).
//
// Loopback is not a security boundary: every process of every user on the
// machine can reach 127.0.0.1, and any web page open in the browser can send
// requests to it. Three checks close that:
//   1. Host header must name loopback (defeats DNS rebinding).
//   2. Writes must come from our own origin (Origin / Sec-Fetch-Site), which
//      stops cross-site request forgery from other tabs.
//   3. Every request except /api/health carries a session token, delivered
//      once through the launch URL (`bin/orbit open`) and kept in an HttpOnly,
//      SameSite=Lax cookie. Other OS users cannot read the 0600 token file.

const crypto = require("crypto");
const fs = require("fs");
const config = require("../main/config");
const { HttpError, parseCookies } = require("./http");

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Load the persistent session token, minting one on first run (0600). */
function loadOrCreateToken(file) {
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (TOKEN_RE.test(t)) {
      if (process.platform !== "win32") { try { fs.chmodSync(file, 0o600); } catch { /* not ours to fix */ } }
      return t;
    }
  } catch { /* first run */ }
  const t = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

/** Constant-time equality on same-length hex strings. */
function tokenEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const LOCAL = new Set(config.server.localHosts);

function hostIsLocal(hostHeader) {
  const h = String(hostHeader || "").trim();
  if (!h) return false;
  // "[::1]:7779" keeps its brackets; "localhost:7779" drops the port.
  const bare = h.startsWith("[") ? h.replace(/\]:\d+$/, "]") : h.replace(/:\d+$/, "");
  return LOCAL.has(bare);
}

function originIsLocal(origin) {
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && LOCAL.has(u.hostname === "::1" ? "[::1]" : u.hostname);
  } catch {
    return false;
  }
}

/**
 * Reject anything that is not a same-machine, same-origin request. Runs before
 * routing, so no handler can forget it.
 * @param {import('http').IncomingMessage} req
 */
function guardRequest(req) {
  if (!hostIsLocal(req.headers.host)) throw new HttpError(403, "Orbit only answers on this machine.");
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin && origin !== "null" && !originIsLocal(String(origin))) {
      throw new HttpError(403, "Cross-origin writes are not allowed.");
    }
    if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "Cross-site writes are not allowed.");
  }
}

/**
 * True when the request carries the session: the cookie the launch URL set, or
 * a bearer header (the CLI's doctor and scripts).
 * @param {import('http').IncomingMessage} req
 */
function isAuthenticated(req, token) {
  const cookie = parseCookies(req.headers.cookie).get(config.server.sessionCookie);
  if (cookie && tokenEquals(cookie, token)) return true;
  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Bearer ") && tokenEquals(auth.slice(7).trim(), token)) return true;
  return false;
}

function sessionCookie(token) {
  const maxAge = config.server.sessionMaxAgeDays * 24 * 60 * 60;
  // Lax, not Strict: the Add to Orbit bookmarklet opens /add as a top-level GET
  // from another site, which Strict would strip the cookie from. Lax still
  // withholds it on cross-site POSTs and subresources, and every write is a
  // POST behind the Origin / Sec-Fetch-Site guards.
  return `${config.server.sessionCookie}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

module.exports = { loadOrCreateToken, tokenEquals, hostIsLocal, originIsLocal, guardRequest, isAuthenticated, sessionCookie, TOKEN_RE };
