// app.js - the HTTP host: routes, auth, static UI, and the RPC endpoint that
// exposes every registry channel as POST /api/rpc/<channel>.
//
// The request pipeline, in order, for every request:
//   guardRequest (Host / Origin)  ->  /api/health (public)  ->  session check
//   ->  static UI | /api/rpc | /api/files | /api/doctor  ->  404
//
// createHttpApp() returns an unlistened http.Server so tests can bind port 0;
// server.js binds the real one.

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const config = require("../main/config");
const { AppError, HTTP_STATUS } = require("../main/ipc/errors");
const { createInvoker, ChannelError } = require("../main/ipc/registry");
const { BROWSER_ONLY_CHANNELS } = require("../shared/api-map");
const { HttpError, sendJson, sendText, redirect, readBody, readJson, serveFile, contentDisposition, MIME } = require("./http");
const { guardRequest, isAuthenticated, sessionCookie, tokenEquals, TOKEN_RE } = require("./auth");
const { FileSlots } = require("./files");
const { createUpdates } = require("./updates");
const { runDoctor } = require("./doctor");
const { buildBookmarklet } = require("./bookmarklet");

const ROOT = path.join(__dirname, "..", "..");
const DIST_DIR = path.join(ROOT, "dist", "renderer");

const SECURITY_HEADERS = {
  "content-security-policy": config.security.csp,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

/** Shown while `vite build` has emptied dist/renderer; refreshes itself. */
const BUILDING_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Orbit</title>
<meta http-equiv="refresh" content="2">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e6edf7;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:34rem;padding:2rem;text-align:center}p{color:#b7c3d6}</style>
</head><body><main><h1>Orbit is building its interface</h1><p>This page retries on its own. If it stays here, run <code>npm run build</code> in the Orbit folder.</p></main></body></html>`;

/** Shown to a browser that has no session: how to get one, and nothing else. */
const LOCKED_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Orbit</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e6edf7;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:34rem;padding:2rem}
h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:.5rem 0;color:#b7c3d6}
code{background:#16213a;padding:.15rem .4rem;border-radius:4px;color:#e6edf7}
</style></head><body><main>
<h1>Orbit is locked to this machine</h1>
<p>This browser has no session with the Orbit service, or its session was made under an older setting. Open Orbit from the terminal, in the Orbit folder, and it will unlock this browser:</p>
<p><code>bin/orbit open</code></p>
<p>That prints and opens a one-time link. If you got here from the Add to Orbit button, click it again afterwards. Nothing about your contacts was shown to this page.</p>
</main></body></html>`;

/**
 * @param {{ runtime: ReturnType<typeof import('./runtime').bootRuntime>,
 *           paths: ReturnType<typeof import('./paths').resolvePaths>, key: string, token: string,
 *           log: { path: string, info: (m: string) => void, error: (m: string, e?: unknown) => void },
 *           version: string, port: number, keyBackend: string,
 *           requestRestart: () => void, distDir?: string, startedAt?: number }} deps
 */
function createHttpApp({ runtime, paths, key, token, log, version, port, keyBackend, requestRestart, distDir = DIST_DIR, startedAt = Date.now() }) {
  /** File paths the service minted this session; import/export only honor these. */
  const grantedPaths = new Set();
  const slots = new FileSlots({ uploadsDir: paths.uploadsDir, exportsDir: paths.exportsDir, grantedPaths });
  slots.purgeAll();
  const sweepTimer = setInterval(() => {
    try { slots.sweep(); } catch (e) { log.error("[files] sweep failed", e); }
  }, Math.min(config.server.uploadTtlMs, config.server.exportTtlMs));
  sweepTimer.unref();

  const updates = createUpdates({
    root: ROOT, startedAt, currentVersion: version, runtime,
    backupDir: paths.backupDir, key, log, requestRestart,
  });

  const browserOnly = () => {
    throw new AppError("VALIDATION", "File dialogs are handled in the browser.");
  };

  /** Restore closes the runtime; whatever happens after that, only a fresh
   *  process can serve again, so the restart is requested in every case. */
  const restoring = (fn) => {
    try {
      return fn();
    } finally {
      if (runtime.closed) requestRestart();
    }
  };

  const ctx = {
    db: runtime.db,
    graph: runtime.graph,
    search: runtime.search,
    centrality: runtime.centrality,
    explore: runtime.explore,
    backupDir: paths.backupDir,
    key,
    grantedPaths,
    touchGranted: (p) => slots.touch(p),
    dbPath: paths.dbPath,
    appVersion: version,
    logPath: log.path,
    restoreLatestAndRelaunch: () => restoring(() => runtime.restoreLatest()),
    restoreSnapshotAndRelaunch: (file) => restoring(() => runtime.restoreSnapshot(file)),
    setupInfo: () => ({
      version,
      port,
      url: `http://localhost:${port}`,
      home: paths.home,
      launchd: process.ppid === 1, // macOS launchd (and systemd) parent us directly
      agentInstalled: fs.existsSync(path.join(os.homedir(), "Library", "LaunchAgents", `${config.server.launchdLabel}.plist`)),
      keyBackend,
      bookmarklet: buildBookmarklet(port),
    }),
    updateStatus: () => updates.status(),
    updateCheck: () => updates.check(),
    updateInstall: () => updates.install(),
    dialog: { openFile: browserOnly, saveFile: browserOnly },
  };
  const { invoke, channels } = createInvoker(ctx, { log: (m, err) => log.error(m, err) });
  const channelSet = new Set(channels);

  function rendererBuiltAt() {
    try { return Math.round(fs.statSync(path.join(distDir, "index.html")).mtimeMs); } catch { return null; }
  }

  // ---- routes -------------------------------------------------------------

  /** @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res @param {URL} url */
  async function route(req, res, url) {
    const p = url.pathname;
    const method = req.method || "GET";

    if (p === "/api/health" && method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        name: "orbit",
        version,
        pid: process.pid,
        port,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        restarting: runtime.closed,
        restartNeeded: updates.codeChanged(),
        rendererBuiltAt: rendererBuiltAt(),
      });
    }

    // The launch URL: exchange the token for the session cookie once.
    if (p === "/" && method === "GET" && url.searchParams.has("token")) {
      const given = url.searchParams.get("token") || "";
      if (!TOKEN_RE.test(given) || !tokenEquals(given, token)) {
        throw new HttpError(403, "That link is not valid for this Orbit.");
      }
      return redirect(res, "/", { "set-cookie": sessionCookie(token), ...SECURITY_HEADERS });
    }

    const authed = isAuthenticated(req, token);

    if (p.startsWith("/api/")) {
      if (!authed) throw new HttpError(401, "No session. Open Orbit with bin/orbit open.");
      return apiRoute(req, res, url, p, method);
    }

    // Everything else is the UI bundle, which only a session may load.
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed.");
    if (!authed) {
      return sendText(res, 401, LOCKED_PAGE, "text/html; charset=utf-8", SECURITY_HEADERS);
    }
    let rel;
    try {
      rel = p === "/" ? "index.html" : decodeURIComponent(p.slice(1));
    } catch {
      throw new HttpError(400, "Bad path.");
    }
    const immutable = rel.startsWith("assets/");
    // Re-issue the cookie on every signed-in page load: the browser keeps the
    // attributes a cookie was set with, so this is how a changed policy (Lax
    // vs Strict, a new Max-Age) reaches browsers that signed in under the old one.
    const headers = rel === "index.html" ? { ...SECURITY_HEADERS, "set-cookie": sessionCookie(token) } : SECURITY_HEADERS;
    const served = serveFile(req, res, distDir, rel, {
      cache: immutable ? "public, max-age=31536000, immutable" : "no-cache",
      headers,
    });
    if (!served) {
      if (!fs.existsSync(path.join(distDir, "index.html"))) {
        return sendText(res, 503, BUILDING_PAGE, "text/html; charset=utf-8", { ...SECURITY_HEADERS, "retry-after": "2" });
      }
      throw new HttpError(404, "Not found.");
    }
  }

  /** @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res @param {URL} url */
  async function apiRoute(req, res, url, p, method) {
    if (p.startsWith("/api/rpc/")) {
      if (method !== "POST") throw new HttpError(405, "Use POST.");
      let channel;
      try { channel = decodeURIComponent(p.slice("/api/rpc/".length)); } catch { throw new HttpError(400, "Bad channel."); }
      if (!channelSet.has(channel) || BROWSER_ONLY_CHANNELS.includes(channel)) {
        throw new HttpError(404, "Unknown channel.");
      }
      if (runtime.closed) throw new HttpError(503, "Orbit is restarting.");
      const payload = await readJson(req, config.server.bodyMaxBytes);
      try {
        const result = await invoke(channel, payload);
        return sendJson(res, 200, { ok: true, result: result === undefined ? null : result });
      } catch (err) {
        if (err instanceof ChannelError) {
          return sendJson(res, HTTP_STATUS[err.ipcError.code] || 500, { ok: false, error: err.ipcError });
        }
        throw err;
      }
    }

    if (p === "/api/files/upload" && method === "POST") {
      if (runtime.closed) throw new HttpError(503, "Orbit is restarting.");
      const name = url.searchParams.get("name") || "";
      const buf = await readBody(req, config.limits.importMaxBytes);
      try {
        return sendJson(res, 200, { path: slots.saveUpload(name, buf) });
      } catch (e) {
        if (e instanceof RangeError) throw new HttpError(400, e.message);
        throw e;
      }
    }

    if (p === "/api/files/export-slot" && method === "POST") {
      if (runtime.closed) throw new HttpError(503, "Orbit is restarting.");
      const body = await readJson(req, 64 * 1024);
      const defaultName = typeof body.defaultName === "string" ? body.defaultName : "";
      return sendJson(res, 200, { path: slots.createExportSlot(defaultName) });
    }

    if (p === "/api/files/download" && method === "GET") {
      const file = url.searchParams.get("path") || "";
      if (!slots.isExportSlot(file)) throw new HttpError(404, "That export is no longer available.");
      let st;
      try { st = fs.statSync(file); } catch { throw new HttpError(404, "That export was not written."); }
      const name = path.basename(file);
      res.writeHead(200, {
        "content-type": MIME[path.extname(name).toLowerCase()] || "application/octet-stream",
        "content-length": st.size,
        "content-disposition": contentDisposition(name),
        "cache-control": "no-store",
        ...SECURITY_HEADERS,
      });
      const stream = fs.createReadStream(file);
      // One download: delete once the bytes are out (or the client went away),
      // unless the page asked to keep it (the wizard reopens its results file).
      const keep = url.searchParams.get("keep") === "1";
      const done = () => { try { if (keep) slots.keep(file); else slots.consumeExport(file); } catch { /* already gone */ } };
      res.on("finish", done);
      res.on("close", done);
      stream.pipe(res);
      return;
    }

    if (p === "/api/doctor" && method === "GET") {
      return sendJson(res, 200, runDoctor({ paths, runtime, keyBackend, distDir, port, version, updates }));
    }

    throw new HttpError(404, "Not found.");
  }

  // ---- server -------------------------------------------------------------

  let inflight = 0;
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    inflight++;
    /** @type {URL | null} */
    let url = null;
    try {
      url = new URL(req.url || "/", `http://${config.server.host}:${port}`);
      guardRequest(req);
      await route(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500 && !(err instanceof HttpError)) log.error(`[http] ${req.method} ${url ? url.pathname : req.url}`, err);
      if (!res.headersSent) {
        const message = err instanceof HttpError ? err.message : "Orbit hit an unexpected problem.";
        const headers = {};
        if (status === 413) {
          // The body is still arriving: answer, then drop the connection.
          headers.connection = "close";
          res.once("finish", () => req.destroy());
        }
        sendJson(res, status, { ok: false, error: { code: "HTTP", message } }, headers);
      } else {
        res.end();
      }
    } finally {
      inflight--;
      // Access log stays PII-free: paths only, never bodies or queries.
      if (url && !/^\/api\/health$|^\/assets\//.test(url.pathname)) {
        log.info(`[http] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0}ms`);
      }
    }
  });
  server.requestTimeout = 0; // long imports; the body cap guards abuse instead
  server.headersTimeout = 60000;

  function close() {
    clearInterval(sweepTimer);
    return new Promise((resolve) => server.close(() => resolve(undefined)));
  }

  /** Resolve once no request is being handled, or after `maxMs`. */
  function drain(maxMs = config.server.restartDrainMs) {
    const deadline = Date.now() + maxMs;
    return new Promise((resolve) => {
      const tick = () => (inflight === 0 || Date.now() >= deadline ? resolve(undefined) : setTimeout(tick, 50));
      tick();
    });
  }

  return { server, close, drain, channels, grantedPaths, slots };
}

module.exports = { createHttpApp, SECURITY_HEADERS, DIST_DIR, ROOT };
