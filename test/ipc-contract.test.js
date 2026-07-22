// The three declarations of the IPC surface - main registry, preload bridge,
// IpcContract in types.d.ts - must be identical. This is the drift guard the
// interface contract relies on (sandboxed preloads cannot share a module with
// main, so equality is asserted here instead).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { buildRegistry } = require("../src/main/ipc/registry");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("registry, preload, and IpcContract declare the same channels", () => {
  const registryChannels = new Set(Object.keys(buildRegistry(/** @type {any} */ ({}))));

  const preloadChannels = new Set(
    [...read("src/main/preload.js").matchAll(/invoke\("([\w:]+)"\)/g)].map((m) => m[1])
  );

  const typesChannels = new Set(
    [...read("src/shared/types.d.ts").matchAll(/"([\w]+:[\w]+)":\s*\{\s*request/g)].map((m) => m[1])
  );

  assert.ok(registryChannels.size >= 18, "registry lost channels");
  assert.deepEqual(preloadChannels, registryChannels, "preload vs registry drift");
  assert.deepEqual(typesChannels, registryChannels, "types.d.ts vs registry drift");
});

test("index.html CSP matches config.security.csp", () => {
  const config = require("../src/main/config");
  const html = read("src/renderer/index.html");
  const m = html.match(/Content-Security-Policy"[\s\S]*?content="([^"]+)"/);
  assert.ok(m, "no CSP meta tag in index.html");
  assert.equal(m[1], config.security.csp, "index.html CSP drifted from config");
});
