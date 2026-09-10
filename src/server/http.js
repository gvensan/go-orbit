// http.js - small HTTP helpers for the service. No framework: the surface is
// ~10 routes plus one RPC endpoint, and a hand-written layer keeps the
// dependency list to the encrypted SQLite addon and the graph libraries.

const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".graphml": "application/xml; charset=utf-8",
  ".orbit": "application/octet-stream",
  ".map": "application/json; charset=utf-8",
};

class HttpError extends Error {
  /** @param {number} status @param {string} message @param {Record<string, unknown>} [extra] */
  constructor(status, message, extra) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.extra = extra;
  }
}

/** @param {import('http').ServerResponse} res */
function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** @param {import('http').ServerResponse} res */
function sendText(res, status, text, type = "text/plain; charset=utf-8", headers = {}) {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** @param {import('http').ServerResponse} res */
function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, "cache-control": "no-store", ...headers });
  res.end();
}

/**
 * Buffer a request body up to `limit` bytes; 413 past that. The stream is
 * paused, not destroyed, so the 413 reaches the client; the request handler
 * closes the connection once the response is out.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req, limit) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    // Answer before reading a byte; the caller closes the connection after.
    req.pause();
    return Promise.reject(new HttpError(413, "That file is too large."));
  }
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        // Pause rather than destroy: destroying first drops the 413 on the
        // floor and the browser reports "network error" instead of "too large".
        done = true;
        req.pause();
        reject(new HttpError(413, "That file is too large."));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

/** @param {import('http').IncomingMessage} req */
async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

/**
 * Serve one file from under `root`. Traversal is refused by resolving and
 * checking the prefix, not by string-scrubbing the request.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ cache?: string, headers?: Record<string, string> }} [opts]
 * @returns {boolean} false when nothing was served (caller decides on 404)
 */
function serveFile(req, res, root, rel, opts = {}) {
  const resolvedRoot = path.resolve(root) + path.sep;
  const file = path.resolve(root, "." + path.posix.normalize("/" + rel));
  if (!file.startsWith(resolvedRoot)) return false;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const headers = {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": st.size,
    "cache-control": opts.cache || "no-cache",
    "last-modified": st.mtime.toUTCString(),
    ...(opts.headers || {}),
  };
  const since = req.headers["if-modified-since"];
  if (since && Math.floor(Date.parse(String(since)) / 1000) >= Math.floor(st.mtimeMs / 1000)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}

/** RFC 6266 attachment header that survives non-ASCII names. */
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** @param {string | undefined} header */
function parseCookies(header) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (!header) return out;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    const k = part.slice(0, at).trim();
    const v = part.slice(at + 1).trim();
    if (k && !out.has(k)) out.set(k, v);
  }
  return out;
}

module.exports = { MIME, HttpError, sendJson, sendText, redirect, readBody, readJson, serveFile, contentDisposition, parseCookies };
