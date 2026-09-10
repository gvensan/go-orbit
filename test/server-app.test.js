// The HTTP host end to end: guards, session, RPC, file slots, static UI,
// restore. Runs the real runtime on a temp data home with the test key, bound
// to an ephemeral port; no keychain, no launchd.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const config = require("../src/main/config");
const { bootRuntime } = require("../src/server/runtime");
const { createHttpApp, SECURITY_HEADERS } = require("../src/server/app");
const { resolvePaths, ensurePaths } = require("../src/server/paths");
const { tmpDir, TEST_KEY } = require("./helpers");

const TOKEN = "a".repeat(64);
const COOKIE = `${config.server.sessionCookie}=${TOKEN}`;

async function startApp(t) {
  const home = tmpDir(t);
  const paths = ensurePaths(resolvePaths({ ORBIT_HOME: home }));
  const log = { path: path.join(home, "orbit.log"), info() {}, warn() {}, error() {} };
  const runtime = bootRuntime({ paths, key: TEST_KEY, log });
  const distDir = path.join(home, "dist");
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<!DOCTYPE html><title>Orbit</title>ok");
  fs.writeFileSync(path.join(distDir, "assets", "a.js"), "export const a = 1;");
  let restarts = 0;
  const app = createHttpApp({
    runtime, paths, key: TEST_KEY, token: TOKEN, log, version: "0.0.0-test", port: 0,
    keyBackend: "test store", requestRestart: () => { restarts++; }, distDir,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", () => r(undefined)));
  const { port } = /** @type {import('net').AddressInfo} */ (app.server.address());
  t.after(async () => {
    await app.close();
    runtime.teardown();
  });
  const base = `http://127.0.0.1:${port}`;
  const get = (p, headers = {}) => fetch(base + p, { redirect: "manual", headers });
  const authed = (p, init = {}) => fetch(base + p, { redirect: "manual", ...init, headers: { cookie: COOKIE, ...(init.headers || {}) } });
  const rpc = async (channel, payload, headers = {}) => {
    const res = await authed(`/api/rpc/${encodeURIComponent(channel)}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload ?? {}),
    });
    return { status: res.status, body: await res.json() };
  };
  return { base, port, get, authed, rpc, runtime, paths, restarts: () => restarts };
}

test("health is public and carries no data", async (t) => {
  const s = await startApp(t);
  const res = await s.get("/api/health");
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.equal(h.ok, true);
  assert.equal(h.name, "orbit");
  assert.equal(typeof h.startedAt, "number");
  assert.equal("contacts" in h, false);
});

test("no session: the UI is a locked page and the API is 401", async (t) => {
  const s = await startApp(t);
  const page = await s.get("/");
  assert.equal(page.status, 401);
  assert.match(await page.text(), /locked to this machine/);
  assert.equal(page.headers.get("content-security-policy"), config.security.csp);
  const api = await s.get("/api/rpc/contacts:list");
  assert.equal(api.status, 401);
  const asset = await s.get("/assets/a.js");
  assert.equal(asset.status, 401);
});

test("the launch URL exchanges the token for a cookie exactly", async (t) => {
  const s = await startApp(t);
  const bad = await s.get("/?token=" + "b".repeat(64));
  assert.equal(bad.status, 403);
  const malformed = await s.get("/?token=short");
  assert.equal(malformed.status, 403);
  const ok = await s.get("/?token=" + TOKEN);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "/");
  assert.match(ok.headers.get("set-cookie") || "", new RegExp(`^${config.server.sessionCookie}=${TOKEN}; Path=/; Max-Age=\\d+; HttpOnly; SameSite=Lax`));
});

test("a bearer header also authenticates (the CLI's doctor)", async (t) => {
  const s = await startApp(t);
  const res = await fetch(`${s.base}/api/doctor`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.ok(Array.isArray(d.checks) && d.checks.length >= 5);
  assert.ok(d.checks.every((c) => typeof c.label === "string"));
  assert.equal(d.checks.find((c) => c.id === "db").ok, true);
  assert.equal(d.checks.find((c) => c.id === "key").detail, "stored in the test store");
});

test("a foreign Host header is refused before routing", async (t) => {
  const s = await startApp(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: s.port, path: "/api/health", headers: { host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

test("writes from another origin or site are refused; our own origin passes", async (t) => {
  const s = await startApp(t);
  const foreign = await s.rpc("contacts:list", {}, { origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  const crossSite = await s.rpc("contacts:list", {}, { "sec-fetch-site": "cross-site" });
  assert.equal(crossSite.status, 403);
  const own = await s.rpc("contacts:list", {}, { origin: `http://localhost:${s.port}`, "sec-fetch-site": "same-origin" });
  assert.equal(own.status, 200);
});

test("RPC: results, validation errors, unknown and browser-only channels", async (t) => {
  const s = await startApp(t);
  const created = await s.rpc("contacts:create", { name: "Ada Lovelace" });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  assert.equal(typeof created.body.result.id, "number");

  const list = await s.rpc("contacts:list", {});
  assert.equal(list.body.result.length, 1);
  assert.equal(list.body.result[0].name, "Ada Lovelace");

  const invalid = await s.rpc("contacts:get", {});
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.ok, false);
  assert.equal(invalid.body.error.code, "VALIDATION");
  assert.equal(invalid.body.error.channel, "contacts:get");

  const missing = await s.rpc("contacts:get", { id: 999 });
  assert.equal(missing.status, 200, "a lookup miss is a null result, not an error");
  assert.equal(missing.body.result, null);

  const notFound = await s.rpc("contacts:update", { id: 999, patch: { name: "Nobody" } });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, "NOT_FOUND");

  const unknown = await s.rpc("nope:nothing", {});
  assert.equal(unknown.status, 404);
  const browserOnly = await s.rpc("dialog:openFile", {});
  assert.equal(browserOnly.status, 404);

  const wrongMethod = await s.authed("/api/rpc/contacts:list");
  assert.equal(wrongMethod.status, 405);
  const badJson = await s.authed("/api/rpc/contacts:list", { method: "POST", body: "{nope" });
  assert.equal(badJson.status, 400);
});

test("upload grants an import path; import channels read it unchanged", async (t) => {
  const s = await startApp(t);
  const csv = "name,email,company\nGrace Hopper,grace@navy.mil,US Navy\n";
  const up = await s.authed("/api/files/upload?name=people.csv", { method: "POST", body: csv });
  assert.equal(up.status, 200);
  const { path: srcPath } = await up.json();
  assert.ok(srcPath.startsWith(s.paths.uploadsDir + path.sep));
  assert.equal(fs.readFileSync(srcPath, "utf8"), csv);

  const preview = await s.rpc("import:preview", { srcPath });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.result.kind, "csv");

  const ungranted = await s.rpc("import:preview", { srcPath: path.join(s.paths.home, "not-granted.csv") });
  assert.equal(ungranted.status, 400);
  assert.equal(ungranted.body.error.code, "VALIDATION");

  const badExt = await s.authed("/api/files/upload?name=evil.exe", { method: "POST", body: "MZ" });
  assert.equal(badExt.status, 400);
  const traversal = await s.authed("/api/files/upload?name=..%2F..%2Fx.csv", { method: "POST", body: "a" });
  assert.equal(traversal.status, 200);
  const { path: safe } = await traversal.json();
  assert.equal(path.basename(safe), "x.csv");
  assert.ok(safe.startsWith(s.paths.uploadsDir + path.sep));
});

test("export slot -> channel writes -> one download -> file gone", async (t) => {
  const s = await startApp(t);
  await s.rpc("contacts:create", { name: "Grace Hopper", fields: { email: "grace@navy.mil" } });
  const slot = await s.authed("/api/files/export-slot", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultName: "orbit-contacts.csv" }),
  });
  const { path: destPath } = await slot.json();
  assert.equal(path.basename(destPath), "orbit-contacts.csv");

  const notYet = await s.authed(`/api/files/download?path=${encodeURIComponent(destPath)}`);
  assert.equal(notYet.status, 404);

  const exported = await s.rpc("export:csv", { destPath });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.result.count, 1);

  const dl = await s.authed(`/api/files/download?path=${encodeURIComponent(destPath)}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-disposition") || "", /attachment; filename="orbit-contacts.csv"/);
  assert.match(await dl.text(), /Grace Hopper/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(destPath), false, "export slot removed after download");

  const again = await s.authed(`/api/files/download?path=${encodeURIComponent(destPath)}`);
  assert.equal(again.status, 404);
  const arbitrary = await s.authed(`/api/files/download?path=${encodeURIComponent(s.paths.dbPath)}`);
  assert.equal(arbitrary.status, 404);
});

test("static UI: index, immutable assets, security headers, no traversal", async (t) => {
  const s = await startApp(t);
  const index = await s.authed("/");
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") || "", /text\/html/);
  assert.match(index.headers.get("set-cookie") || "", /SameSite=Lax/, "a signed-in page load refreshes the cookie's attributes");
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(index.headers.get(k), v, k);
  assert.equal(index.headers.get("cache-control"), "no-cache");

  const asset = await s.authed("/assets/a.js");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const traversal = await s.authed("/../package.json");
  assert.equal(traversal.status, 404);
  const encoded = await s.authed("/%2e%2e/%2e%2e/etc/passwd");
  assert.equal(encoded.status, 404);
  const post = await s.authed("/", { method: "POST" });
  assert.equal(post.status, 405);
});

test("restore: refuses with nothing to restore, then restores and asks for a restart", async (t) => {
  const s = await startApp(t);
  // Boot already took the pre-migration snapshots; clear them to reach the empty case.
  const initial = await s.rpc("backup:list", {});
  assert.ok(initial.body.result.length >= 1, "migrations snapshot before running");
  for (const b of initial.body.result) {
    const del = await s.rpc("backup:delete", { name: b.name });
    assert.equal(del.status, 200);
  }
  const none = await s.rpc("backup:restoreLatest", {});
  assert.equal(none.status, 404);
  assert.equal(none.body.error.code, "NOT_FOUND");

  await s.rpc("contacts:create", { name: "Before Backup" });
  const backup = await s.rpc("backup:now", {});
  assert.equal(backup.status, 200);
  await s.rpc("contacts:create", { name: "After Backup" });

  const restored = await s.rpc("backup:restoreLatest", {});
  assert.equal(restored.status, 200);
  assert.equal(restored.body.result.ok, true);
  assert.equal(s.restarts(), 1);
  assert.equal(s.runtime.closed, true);

  const during = await s.rpc("contacts:list", {});
  assert.equal(during.status, 503);
  const health = await (await s.get("/api/health")).json();
  assert.equal(health.restarting, true);
});

test("oversized upload: a real 413 with the app-voice message, connection closed", async (t) => {
  const s = await startApp(t);
  const declared = await s.authed("/api/files/upload?name=big.csv", {
    method: "POST", headers: { "content-length": String(config.limits.importMaxBytes + 1) }, body: "x",
  }).catch((e) => e);
  // Node's fetch may surface the early close as an error; either way no crash and no partial slot.
  if (declared instanceof Response) {
    assert.equal(declared.status, 413);
    assert.equal(declared.headers.get("connection"), "close");
    assert.match((await declared.json()).error.message, /too large/);
  }
  assert.deepEqual(fs.readdirSync(s.paths.uploadsDir), [], "nothing was written");
  const health = await s.get("/api/health");
  assert.equal(health.status, 200, "the service is still up");
});

test("download with keep=1 leaves the results file readable for the wizard's reload", async (t) => {
  const s = await startApp(t);
  await s.rpc("contacts:create", { name: "Kept Person" });
  const slot = await s.authed("/api/files/export-slot", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultName: "results.csv" }),
  });
  const { path: destPath } = await slot.json();
  const written = await s.rpc("import:writeResults", { destPath, rows: [{ name: "Kept Person", fields: {}, tags: [], status: "imported" }] });
  assert.equal(written.status, 200);
  const dl = await s.authed(`/api/files/download?path=${encodeURIComponent(destPath)}&keep=1`);
  assert.equal(dl.status, 200);
  await dl.text();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(destPath), true, "kept after download");
  const preview = await s.rpc("import:preview", { srcPath: destPath });
  assert.equal(preview.status, 200, "the wizard can reopen it");
  assert.equal(preview.body.result.kind, "csv");
  const plain = await s.authed(`/api/files/download?path=${encodeURIComponent(destPath)}`);
  assert.equal(plain.status, 200);
  await plain.text();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(destPath), false, "a plain download consumes it");
});

test("a restore that fails after closing the database still requests the restart", async (t) => {
  const s = await startApp(t);
  const real = s.runtime.restoreLatest;
  s.runtime.restoreLatest = () => {
    s.runtime.closed = true; // the swap failed after the close, as ENOSPC would
    throw new Error("disk full");
  };
  t.after(() => { s.runtime.restoreLatest = real; });
  const r = await s.rpc("backup:restoreLatest", {});
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, "INTERNAL");
  assert.equal(s.restarts(), 1, "a fresh process is the only way out of a closed runtime");
  const during = await s.rpc("contacts:list", {});
  assert.equal(during.status, 503);
});

test("while dist is being rebuilt the UI answers with a self-refreshing page", async (t) => {
  const s = await startApp(t);
  const before = await (await s.get("/api/health")).json();
  assert.equal(typeof before.rendererBuiltAt, "number");
  fs.unlinkSync(path.join(s.paths.home, "dist", "index.html"));
  const health = await (await s.get("/api/health")).json();
  assert.equal(health.rendererBuiltAt, null);
  const page = await s.authed("/");
  assert.equal(page.status, 503);
  assert.match(page.headers.get("content-type") || "", /text\/html/);
  assert.match(await page.text(), /http-equiv="refresh"/);
});
