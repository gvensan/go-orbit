// "Update" in the service model: newer code on disk than the process loaded.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createUpdates } = require("../src/server/updates");
const { makeDb, tmpDir } = require("./helpers");
const { listBackups } = require("../src/main/db/backup-files");

function fakeRoot(t, version = "1.0.0") {
  const root = tmpDir(t);
  for (const d of ["src/main", "src/server", "src/shared", "dist/renderer"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, "src/server/app.js"), "// v1");
  fs.writeFileSync(path.join(root, "dist/renderer/index.html"), "<!DOCTYPE html>");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  return root;
}

const old = (p, ms) => { const d = new Date(Date.now() - ms); fs.utimesSync(p, d, d); };

test("nothing changed: up to date, install is a no-op", (t) => {
  const root = fakeRoot(t);
  const { db, dir } = makeDb(t);
  let restarts = 0;
  const u = createUpdates({
    root, startedAt: Date.now() + 60000, currentVersion: "1.0.0",
    runtime: { db, closed: false }, backupDir: path.join(dir, "b"), key: "test-key",
    log: { info() {}, error() {} }, requestRestart: () => { restarts++; },
  });
  const s = u.status();
  assert.equal(s.phase, "up-to-date");
  assert.equal(s.restartNeeded, false);
  assert.equal(s.availableVersion, null);
  assert.deepEqual(u.install(), { ok: false });
  assert.equal(restarts, 0);
});

test("a newer source file flips to ready; install takes a verified backup then restarts", (t) => {
  const root = fakeRoot(t);
  // Process "started" an hour ago; the file on disk is newer.
  const startedAt = Date.now() - 3600 * 1000;
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.1.0" }));
  const { db, dir } = makeDb(t);
  const backupDir = path.join(dir, "b");
  let restarts = 0;
  const u = createUpdates({
    root, startedAt, currentVersion: "1.0.0",
    runtime: { db, closed: false }, backupDir, key: "test-key",
    log: { info() {}, error() {} }, requestRestart: () => { restarts++; },
  });
  const s = u.status();
  assert.equal(s.phase, "ready");
  assert.equal(s.restartNeeded, true);
  assert.equal(s.availableVersion, "1.1.0");
  assert.deepEqual(u.install(), { ok: true });
  assert.equal(restarts, 1);
  assert.equal(listBackups(backupDir).length, 1, "verified snapshot before applying");
});

test("a rebuilt UI bundle alone is not an update (the page reloads onto it by itself)", (t) => {
  const root = fakeRoot(t);
  const startedAt = Date.now() - 3600 * 1000;
  for (const f of ["src/server/app.js", "package.json"]) old(path.join(root, f), 7200 * 1000);
  for (const d of ["src/main", "src/server", "src/shared"]) old(path.join(root, d), 7200 * 1000);
  fs.writeFileSync(path.join(root, "dist/renderer/index.html"), "<!DOCTYPE html>new");
  const { db, dir } = makeDb(t);
  const u = createUpdates({
    root, startedAt, currentVersion: "1.0.0",
    runtime: { db, closed: false }, backupDir: path.join(dir, "b"), key: "test-key",
    log: { info() {}, error() {} }, requestRestart: () => {},
  });
  assert.equal(u.status().restartNeeded, false);
});

test("a closed runtime never installs", (t) => {
  const root = fakeRoot(t);
  const { db, dir } = makeDb(t);
  const u = createUpdates({
    root, startedAt: Date.now() - 3600 * 1000, currentVersion: "1.0.0",
    runtime: { db, closed: true }, backupDir: path.join(dir, "b"), key: "test-key",
    log: { info() {}, error() {} }, requestRestart: () => { throw new Error("must not restart"); },
  });
  assert.deepEqual(u.install(), { ok: false });
});
