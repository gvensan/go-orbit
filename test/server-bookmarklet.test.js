// The Add to Orbit bookmarklet: a javascript: URL that carries the port and
// nothing sensitive, and opens /add with only what the page exposed.

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildBookmarklet } = require("../src/server/bookmarklet");

test("carries the port, opens /add, and never a token", () => {
  const href = buildBookmarklet(7779);
  assert.ok(href.startsWith("javascript:"));
  const src = decodeURIComponent(href.slice("javascript:".length));
  assert.match(src, /http:\/\/localhost:7779\/#add=/, "a hash deep link into the real app; the server never sees it");
  assert.match(src, /window\.open\(/);
  assert.match(src, /location\.href/, "falls back to navigation when popups are blocked");
  assert.doesNotMatch(src, /popup=yes|width=/, "a tab, not a popup: the app needs its full width");
  assert.match(src, /window\.open\(u,"orbit"\)/, "targets the name the app gives its own window");
  for (const key of ["url", "title", "text", "og", "desc", "site"]) assert.match(src, new RegExp(`\\b${key}:`));
  assert.doesNotMatch(src, /token|session|cookie/i);
  assert.doesNotMatch(src, /\n/, "single line so it survives a bookmark field");
  assert.notEqual(buildBookmarklet(7780), href, "port is baked in");
});
