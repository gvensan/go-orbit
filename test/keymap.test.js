// The keymap grammar, defaults, overrides, conflicts and the event matcher.

const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../src/shared/keymap");

const ev = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("combos parse, normalize and format per platform", () => {
  assert.deepEqual(K.parseCombo("Mod+K"), { mods: ["Mod"], key: "k" });
  assert.deepEqual(K.parseCombo("Shift+Alt+Delete"), { mods: ["Alt", "Shift"], key: "Delete" });
  assert.equal(K.parseCombo("Mod+Mod+K"), null);
  assert.equal(K.parseCombo("Bogus+K"), null);
  assert.equal(K.parseCombo("Mod+Nope"), null);
  assert.equal(K.isValidBinding("g g"), true);
  assert.equal(K.isValidBinding("g g g"), false);
  assert.equal(K.isValidBinding(""), false);
  assert.equal(K.normalizeBinding("Shift+Mod+Q"), "Mod+Shift+q");
  assert.equal(K.formatCombo("Mod+K", true), "⌘K");
  assert.equal(K.formatCombo("Mod+K", false), "Ctrl+K");
  assert.equal(K.formatCombo("Ctrl+,", true), "⌃,");
  assert.equal(K.formatCombo("Delete", true), "Del");
  assert.equal(K.formatBinding("g g", false), "G G");
});

test("events spell combos: Mod is Cmd on Mac and Ctrl elsewhere; punctuation keeps its own shift", () => {
  assert.equal(K.comboFromEvent(ev("k", { metaKey: true }), true), "Mod+k");
  assert.equal(K.comboFromEvent(ev("k", { ctrlKey: true }), false), "Mod+k");
  assert.equal(K.comboFromEvent(ev("n", { ctrlKey: true }), true), "Ctrl+n", "Control on a Mac is its own modifier");
  assert.equal(K.comboFromEvent(ev("?", { shiftKey: true }), true), "?", "the key already reflects shift");
  assert.equal(K.comboFromEvent(ev("K", { shiftKey: true, metaKey: true }), true), "Mod+Shift+k");
  assert.equal(K.comboFromEvent(ev("Delete"), true), "Delete");
  assert.equal(K.comboFromEvent(ev(" "), true), "Space");
  assert.equal(K.comboFromEvent(ev("Meta", { metaKey: true }), true), null, "a lone modifier is not a combo");
  assert.equal(K.comboFromEvent(ev("MediaPlay"), true), null);
});

test("defaults differ by platform only in the browser-safe alternates", () => {
  const mac = K.defaultKeymap(true);
  const win = K.defaultKeymap(false);
  assert.deepEqual(mac.palette, ["Mod+k"], "defaults are stored normalized");
  assert.deepEqual(mac["new-contact"], ["Mod+n", "Ctrl+n"]);
  assert.deepEqual(win["new-contact"], ["Mod+n", "Alt+n"]);
  assert.deepEqual(mac.home, ["g g"]);
  for (const c of K.COMMANDS) assert.ok(mac[c.id].every(K.isValidBinding), c.id);
});

test("overrides merge onto defaults; junk falls back instead of breaking a key", () => {
  const map = K.resolveKeymap({ palette: ["Mod+P"], home: [], list: "not-a-list", bogus: ["Mod+Z"], settings: ["Nope+Q", "Alt+S"] }, true);
  assert.deepEqual(map.palette, ["Mod+p"]);
  assert.deepEqual(map.home, [], "an empty list means switched off");
  assert.deepEqual(map.list, ["Mod+l", "Ctrl+l"], "a malformed override is ignored");
  assert.equal("bogus" in map, false);
  assert.deepEqual(map.settings, ["Alt+s"], "invalid bindings are dropped, valid ones kept");
  assert.deepEqual(K.resolveKeymap("garbage", true).palette, ["Mod+k"]);
});

test("conflicts are found by command, excluding the one being edited", () => {
  const map = K.defaultKeymap(true);
  assert.equal(K.findConflict(map, "Mod+K", "list"), "palette");
  assert.equal(K.findConflict(map, "Mod+K", "palette"), null);
  assert.equal(K.findConflict(map, "Mod+Shift+K", "list"), null);
  assert.equal(K.findConflict(map, "Ctrl+N", "list"), "new-contact");
});

test("browser-reserved combos are named; safe ones are not", () => {
  assert.match(K.browserReserved("Mod+N", true), /Cmd\+N/);
  assert.match(K.browserReserved("Mod+T", false), /Ctrl\+T/);
  assert.equal(K.browserReserved("Mod+K", true), null);
  assert.equal(K.browserReserved("Ctrl+N", true), null, "Control on a Mac is free");
  assert.match(K.browserReserved("Alt+N", false), /menus/);
  assert.equal(K.browserReserved("?", true), null);
});

test("the matcher resolves combos, chords, typing guards and rebinds", () => {
  let map = K.defaultKeymap(true);
  const match = K.createMatcher(() => map);
  const opts = { isMac: true };
  assert.equal(match(ev("k", { metaKey: true }), opts).id, "palette");
  assert.equal(match(ev("k", { metaKey: true }), { ...opts, typing: true }).id, "palette", "modifier combos work while typing");
  assert.equal(match(ev("Delete"), { ...opts, typing: true }).id, null, "bare keys never fire in an input");
  assert.equal(match(ev("Delete"), opts).id, "delete-selected");
  assert.equal(match(ev("?", { shiftKey: true }), opts).id, "shortcuts");

  const first = match(ev("g"), { ...opts, now: 1000 });
  assert.deepEqual(first, { id: null, chordStarted: true });
  assert.equal(match(ev("g"), { ...opts, now: 1300 }).id, "home", "second g within the window completes the chord");
  match(ev("g"), { ...opts, now: 2000 });
  assert.equal(match(ev("g"), { ...opts, now: 2000 + K.CHORD_MS + 1 }).id, null, "too late: the chord restarts");

  map = K.resolveKeymap({ palette: ["Mod+P"], home: [] }, true);
  assert.equal(match(ev("k", { metaKey: true }), opts).id, null, "old key released");
  assert.equal(match(ev("p", { metaKey: true }), opts).id, "palette");
  assert.deepEqual(match(ev("g"), opts), { id: null, chordStarted: false }, "a cleared chord no longer arms");
});
