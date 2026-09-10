// The three declarations of the channel surface - the registry, the browser
// bridge table (src/shared/api-map.js), and IpcContract in types.d.ts - must be
// identical. This is the drift guard the interface contract relies on. The CSP
// is asserted the same way: the meta tag in index.html and the header the
// service sends both come from config.security.csp.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { buildRegistry } = require("../src/main/ipc/registry");
const { API_MAP, BROWSER_ONLY_CHANNELS, DOWNLOAD_CHANNELS, RESTART_CHANNELS, allChannels } = require("../src/shared/api-map");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("registry, api-map, and IpcContract declare the same channels", () => {
  const registryChannels = new Set(Object.keys(buildRegistry(/** @type {any} */ ({}))));
  const mapChannels = new Set(allChannels());
  const typesChannels = new Set(
    [...read("src/shared/types.d.ts").matchAll(/"([\w]+:[\w]+)":\s*\{\s*request/g)].map((m) => m[1])
  );

  assert.ok(registryChannels.size >= 18, "registry lost channels");
  assert.equal(allChannels().length, mapChannels.size, "api-map names a channel twice");
  assert.deepEqual(mapChannels, registryChannels, "api-map vs registry drift");
  assert.deepEqual(typesChannels, registryChannels, "types.d.ts vs registry drift");
});

test("api-map special-case lists only name real channels", () => {
  const all = new Set(allChannels());
  for (const c of [...BROWSER_ONLY_CHANNELS, ...DOWNLOAD_CHANNELS, ...RESTART_CHANNELS]) {
    assert.ok(all.has(c), `${c} is not in the api-map`);
  }
  assert.deepEqual(BROWSER_ONLY_CHANNELS, ["dialog:openFile", "dialog:saveFile"]);
});

test("api-map namespaces match RendererApi in types.d.ts", () => {
  const types = read("src/shared/types.d.ts");
  const at = types.indexOf("export interface RendererApi");
  assert.ok(at > 0, "RendererApi missing from types.d.ts");
  const block = types.slice(at, types.indexOf("declare global", at));
  for (const [ns, methods] of Object.entries(API_MAP)) {
    assert.ok(new RegExp(`^\\s+${ns}:\\s*\\{`, "m").test(block), `RendererApi lacks namespace ${ns}`);
    for (const m of Object.keys(methods)) {
      assert.ok(new RegExp(`\\b${m}:\\s*Call<`).test(block), `RendererApi.${ns} lacks ${m}`);
    }
  }
});

test("index.html CSP matches config.security.csp", () => {
  const config = require("../src/main/config");
  const html = read("src/renderer/index.html");
  const m = html.match(/Content-Security-Policy"[\s\S]*?content="([^"]+)"/);
  assert.ok(m, "no CSP meta tag in index.html");
  assert.equal(m[1], config.security.csp, "index.html CSP drifted from config");
  assert.match(config.security.csp, /connect-src 'self'/, "the UI must be allowed to reach its own service and nothing else");
  assert.doesNotMatch(config.security.csp, /https?:/, "no remote origin may appear in the CSP");
});
