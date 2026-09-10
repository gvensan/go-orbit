// server.js - the service entry point. Thin by design, like the desktop
// main.js it replaces: lock -> key -> runtime -> http -> listen, and the strict
// reverse on every exit path.
//
// Exit codes: 0 for a stop AND for a boot failure (a failed boot must not turn
// into a 5-second crash loop under launchd's KeepAlive; the reason is in the
// log and `bin/orbit doctor`), config.server.restartExitCode when a restore or
// update asks the supervisor to bring up a fresh process, 1 for a crash.

const fs = require("fs");
const config = require("../main/config");
const { resolvePaths, ensurePaths, resolvePort } = require("./paths");
const { createLogger } = require("./log");
const { getOrCreateDbKey, KeyStoreError } = require("./keys");
const { loadOrCreateToken } = require("./auth");
const { bootRuntime } = require("./runtime");
const { createHttpApp } = require("./app");

const VERSION = String(require("../../package.json").version);

function fail(msg, err) {
  process.stderr.write(`Orbit could not start: ${msg}\n`);
  if (err instanceof KeyStoreError) process.stderr.write(`Fix: ${err.fix}\n`);
  else if (err instanceof Error && process.env.ORBIT_DEBUG) process.stderr.write(`${err.stack}\n`);
  process.stderr.write("Your database was left in place. Run bin/orbit logs for details, bin/orbit start to retry.\n");
  process.exit(config.server.bootFailureExitCode);
}

/**
 * One writer per database. A pid lock beside the DB: a live pid means another
 * service owns this home; a dead one is stale and reclaimed.
 */
function acquireLock(lockFile) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => { try { if (fs.readFileSync(lockFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(lockFile); } catch { /* gone */ } };
    } catch (e) {
      if (!(e instanceof Error) || /** @type {any} */ (e).code !== "EEXIST") throw e;
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(lockFile, "utf8"), 10); } catch { /* unreadable: treat as stale */ }
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          throw new Error(`another Orbit service (pid ${pid}) already owns this data home. Stop it first (bin/orbit stop).`);
        } catch (probe) {
          if (/** @type {any} */ (probe).code !== "ESRCH") throw probe;
        }
      }
      try { fs.unlinkSync(lockFile); } catch { /* raced */ }
    }
  }
  throw new Error("could not acquire the data-home lock.");
}

function main() {
  let paths;
  let port;
  try {
    paths = ensurePaths(resolvePaths());
    port = resolvePort();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), e);
  }
  const log = createLogger({ file: paths.logFile });
  log.info(`[boot] orbit ${VERSION} node ${process.version} home ${paths.home}`);

  let releaseLock;
  try {
    releaseLock = acquireLock(paths.lockFile);
  } catch (e) {
    log.error("[boot] lock", e);
    return fail(e instanceof Error ? e.message : String(e), e);
  }

  let keyInfo;
  try {
    keyInfo = getOrCreateDbKey(paths);                              // 1. credential store
    log.info(`[boot] database key from the ${keyInfo.backend}`);
  } catch (e) {
    releaseLock();
    log.error("[boot] key", e);
    return fail(e instanceof Error ? e.message : String(e), e);
  }

  const token = loadOrCreateToken(paths.tokenFile);                 // 2. browser session secret

  let runtime;
  try {
    const devSeed = process.env.ORBIT_DEV_SEED ? parseInt(process.env.ORBIT_DEV_SEED, 10) : 0;
    runtime = bootRuntime({ paths, key: keyInfo.key, log, devSeed });  // 3. database + services
  } catch (e) {
    releaseLock();
    log.error("[boot] runtime", e);
    return fail(e instanceof Error ? e.message : String(e), e);
  }

  let exiting = false;
  /** @param {number} code */
  function shutdown(code) {
    if (exiting) return;
    exiting = true;
    try { runtime.teardown(); } catch (e) { log.error("[shutdown] teardown", e); }
    app.close().catch(() => {});
    releaseLock();
    setTimeout(() => process.exit(code), 150).unref();
  }
  // Let the RPC reply reach the browser, then let in-flight handlers finish
  // (an import awaiting the geocoder, say) before the process goes away.
  const requestRestart = () => setTimeout(() => {
    app.drain().then(() => shutdown(config.server.restartExitCode));
  }, 400);

  const app = createHttpApp({                                       // 4. http
    runtime, paths, key: keyInfo.key, token, log, version: VERSION, port,
    keyBackend: keyInfo.backend, requestRestart,
  });

  app.server.on("error", (err) => {
    const code = /** @type {any} */ (err).code;
    try { runtime.teardown(); } catch (e) { log.error("[boot] teardown after listen failure", e); }
    releaseLock();
    if (code === "EADDRINUSE") {
      log.error(`[boot] port ${port} is already in use`);
      return fail(`port ${port} is already in use. Stop the other process, or set ${config.server.portEnv}.`, err);
    }
    log.error("[boot] listen", err);
    return fail(err.message, err);
  });
  app.server.listen(port, config.server.host, () => {              // 5. listen
    const base = `http://localhost:${port}`;
    log.info(`[boot] listening on ${base} (pid ${process.pid})`);
    if (process.stdout.isTTY) {
      process.stdout.write(`\nOrbit is running. Open it with:\n  ${base}/?token=${token}\n\n`);
    }
  });

  process.on("SIGINT", () => { log.info("[signal] SIGINT"); shutdown(0); });
  process.on("SIGTERM", () => { log.info("[signal] SIGTERM"); shutdown(0); });
  process.on("uncaughtException", (err) => { log.error("[fatal]", err); shutdown(1); });
  process.on("unhandledRejection", (err) => { log.error("[fatal] unhandled rejection", err); });
}

main();
