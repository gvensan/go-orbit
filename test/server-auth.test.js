// Request guards and the session token, in isolation from the HTTP server.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { hostIsLocal, originIsLocal, guardRequest, isAuthenticated, loadOrCreateToken, tokenEquals, TOKEN_RE } = require("../src/server/auth");
const { HttpError } = require("../src/server/http");
const { tmpDir } = require("./helpers");

test("only loopback hosts pass, with or without a port", () => {
  for (const h of ["localhost", "localhost:7779", "127.0.0.1", "127.0.0.1:7779", "[::1]", "[::1]:7779"]) {
    assert.equal(hostIsLocal(h), true, h);
  }
  for (const h of ["", "evil.example", "localhost.evil.example", "127.0.0.1.nip.io", "192.168.1.5:7779", "0.0.0.0"]) {
    assert.equal(hostIsLocal(h), false, h);
  }
});

test("origins: loopback http(s) only", () => {
  assert.equal(originIsLocal("http://localhost:7779"), true);
  assert.equal(originIsLocal("http://127.0.0.1:7779"), true);
  assert.equal(originIsLocal("http://[::1]:7779"), true);
  assert.equal(originIsLocal("https://evil.example"), false);
  assert.equal(originIsLocal("file://"), false);
  assert.equal(originIsLocal("not a url"), false);
});

test("guardRequest: Host always; Origin and Sec-Fetch-Site on writes only", () => {
  const req = (method, headers) => /** @type {any} */ ({ method, headers });
  assert.throws(() => guardRequest(req("GET", { host: "evil.example" })), (e) => e instanceof HttpError && e.status === 403);
  assert.doesNotThrow(() => guardRequest(req("GET", { host: "localhost:7779", origin: "https://evil.example" })));
  assert.throws(() => guardRequest(req("POST", { host: "localhost:7779", origin: "https://evil.example" })), HttpError);
  assert.throws(() => guardRequest(req("POST", { host: "localhost:7779", "sec-fetch-site": "cross-site" })), HttpError);
  assert.doesNotThrow(() => guardRequest(req("POST", { host: "localhost:7779", origin: "http://localhost:7779", "sec-fetch-site": "same-origin" })));
  assert.doesNotThrow(() => guardRequest(req("POST", { host: "localhost:7779" })), "no Origin (curl) is fine on loopback");
});

test("the session token persists, is 0600, and compares in constant time", (t) => {
  const file = path.join(tmpDir(t), "session-token");
  const a = loadOrCreateToken(file);
  assert.match(a, TOKEN_RE);
  assert.equal(loadOrCreateToken(file), a, "second load returns the same token");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, "garbage\n");
  const b = loadOrCreateToken(file);
  assert.match(b, TOKEN_RE);
  assert.notEqual(b, a, "a damaged token file is replaced");
  assert.equal(tokenEquals(a, a), true);
  assert.equal(tokenEquals(a, b), false);
  assert.equal(tokenEquals(a, a.slice(1)), false);
  assert.equal(tokenEquals(/** @type {any} */ (undefined), a), false);
});

test("isAuthenticated accepts the cookie or a bearer header, nothing else", () => {
  const token = "f".repeat(64);
  const req = (headers) => /** @type {any} */ ({ headers });
  assert.equal(isAuthenticated(req({ cookie: `orbit_session=${token}` }), token), true);
  assert.equal(isAuthenticated(req({ cookie: `other=1; orbit_session=${token}; x=y` }), token), true);
  assert.equal(isAuthenticated(req({ authorization: `Bearer ${token}` }), token), true);
  assert.equal(isAuthenticated(req({ cookie: `orbit_session=${"e".repeat(64)}` }), token), false);
  assert.equal(isAuthenticated(req({ authorization: `Basic ${token}` }), token), false);
  assert.equal(isAuthenticated(req({}), token), false);
});
