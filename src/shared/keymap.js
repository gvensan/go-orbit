// keymap.js - the one table of keys Orbit answers to, and the rules for
// changing them. A binding is a combo string ("Mod+K", "Alt+,", "Delete", "?")
// or a two-step chord ("g g"). "Mod" is Cmd on macOS and Ctrl elsewhere; "Ctrl"
// on macOS is the Control key (the browser-safe alternates use it). Overrides
// are per device (localStorage in the renderer): a key choice is about this
// keyboard, not about the data. CommonJS so plain Node tests and the Vite
// bundle share it.

const STORAGE_KEY = "orbit-keymap";
const CHORD_MS = 600; // second key of "g g" must land within this

/**
 * Every rebindable command. `defaults` may hold two combos: the primary, and
 * where browsers reserve it, a fallback every browser leaves alone.
 * @type {{ id: string, label: string, defaults: (isMac: boolean) => string[] }[]}
 */
const COMMANDS = [
  { id: "palette", label: "Command palette: search, every command, quick add", defaults: () => ["Mod+K"] },
  { id: "find-current", label: "Find in the current view", defaults: () => ["Mod+F"] },
  { id: "list", label: "Explore, the faceted table", defaults: (m) => ["Mod+L", m ? "Ctrl+L" : "Alt+L"] },
  { id: "new-contact", label: "New contact, via the palette", defaults: (m) => ["Mod+N", m ? "Ctrl+N" : "Alt+N"] },
  { id: "import", label: "Import contacts", defaults: (m) => [m ? "Ctrl+I" : "Alt+I"] },
  { id: "export-archive", label: "Export an archive", defaults: () => ["Mod+E"] },
  { id: "settings", label: "Settings", defaults: (m) => ["Mod+,", m ? "Ctrl+," : "Alt+,"] },
  { id: "home", label: "Graph home", defaults: () => ["g g"] },
  { id: "delete-selected", label: "Trash the selected contact (undoable)", defaults: () => ["Delete", "Backspace"] },
  { id: "shortcuts", label: "Open this page", defaults: () => ["?"] },
];

/** Keys that stay fixed; listed on the Shortcuts page for completeness. */
const FIXED = [
  { keys: "Esc", what: "Close, clear the path, or step back to home" },
  { keys: "↑ ↓ ↵", what: "Move through and open results in the palette and lists" },
  { keys: "shift-click a node", what: "Shortest path from the selected contact" },
  { keys: "right-click a node", what: "Add a connection to that person" },
  { keys: "drag a node", what: "Reposition it on the canvas" },
];

const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift"];
const NAMED_KEYS = new Set(["Delete", "Backspace", "Enter", "Tab", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Insert",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]);

/** Combos the browser acts on before the page sees them (Mod = Cmd/Ctrl). */
const RESERVED_KEYS = new Set(["n", "t", "w", "l", "q", "h", "j", "d", "p", "r", "m", ",", "s", "o", "u", "y"]);

/** @param {string} combo @returns {{ mods: string[], key: string } | null} */
function parseCombo(combo) {
  const parts = String(combo || "").split("+");
  if (!parts.length) return null;
  const key = parts.pop();
  if (!key) return null;
  const mods = [];
  for (const m of parts) {
    if (!MODIFIERS.includes(m) || mods.includes(m)) return null;
    mods.push(m);
  }
  if (key.length !== 1 && !NAMED_KEYS.has(key)) return null;
  mods.sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));
  return { mods, key: key.length === 1 ? key.toLowerCase() : key };
}

/** True for "Mod+K", "?", "g g" (a chord of two bare or modified combos). */
function isValidBinding(binding) {
  if (typeof binding !== "string" || !binding.trim()) return false;
  const steps = binding.split(" ");
  if (steps.length > 2) return false;
  return steps.every((s) => parseCombo(s) !== null);
}

/** Canonical spelling ("mod+k" -> "Mod+K" is not accepted; letters lowercase). */
function normalizeBinding(binding) {
  return binding.split(" ").map((s) => {
    const c = parseCombo(s);
    return c ? [...c.mods, c.key].join("+") : s;
  }).join(" ");
}

/**
 * The combo a keydown event spells, in this table's grammar, or null for a
 * lone modifier press. Shift is kept for letters and named keys; for
 * punctuation e.key already reflects it ("?" is "?", not "Shift+/").
 * @param {{ key: string, metaKey: boolean, ctrlKey: boolean, altKey: boolean, shiftKey: boolean }} e
 */
function comboFromEvent(e, isMac) {
  const raw = e.key;
  if (!raw || ["Meta", "Control", "Alt", "Shift", "CapsLock", "Dead", "Unidentified"].includes(raw)) return null;
  const mods = [];
  const modHeld = isMac ? e.metaKey : e.ctrlKey;
  if (modHeld) mods.push("Mod");
  if (isMac && e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  let key = raw === " " ? "Space" : raw;
  if (key.length === 1) {
    if (/[a-z]/i.test(key)) {
      if (e.shiftKey) mods.push("Shift");
      key = key.toLowerCase();
    }
  } else {
    if (!NAMED_KEYS.has(key)) return null;
    if (e.shiftKey) mods.push("Shift");
  }
  mods.sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));
  return [...mods, key].join("+");
}

/** Display form: "Mod+K" -> "⌘K" on macOS, "Ctrl+K" elsewhere. */
function formatCombo(combo, isMac) {
  const c = parseCombo(combo);
  if (!c) return combo;
  const glyph = isMac
    ? { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" }
    : { Mod: "Ctrl+", Ctrl: "Ctrl+", Alt: "Alt+", Shift: "Shift+" };
  const keyLabel = c.key.length === 1 ? c.key.toUpperCase() : (c.key === "Delete" ? "Del" : c.key);
  return c.mods.map((m) => glyph[m]).join("") + keyLabel;
}

/** "g g" -> "g g"; "Mod+K" -> "⌘K". */
function formatBinding(binding, isMac) {
  return String(binding).split(" ").map((s) => formatCombo(s, isMac)).join(" ");
}

/** A reason the browser will likely swallow this combo before Orbit sees it, or null. */
function browserReserved(binding, isMac) {
  const first = parseCombo(binding.split(" ")[0]);
  if (!first) return null;
  if (first.mods.includes("Mod") && !first.mods.includes("Alt") && RESERVED_KEYS.has(first.key)) {
    const name = isMac ? "Cmd" : "Ctrl";
    return `${name}+${first.key.toUpperCase()} belongs to the browser (new window, tabs, address bar...). It may never reach Orbit.`;
  }
  if (!isMac && first.mods.length === 1 && first.mods[0] === "Alt" && /[a-z]/.test(first.key)) {
    return "Alt+letter opens menus in some browsers on Windows and Linux; it usually works, but not everywhere.";
  }
  return null;
}

/** Defaults for this platform: { [id]: string[] }. */
function defaultKeymap(isMac) {
  /** @type {Record<string, string[]>} */
  const map = {};
  // Normalized so a default and a recorded key ("Mod+k") compare equal.
  for (const c of COMMANDS) map[c.id] = c.defaults(isMac).map(normalizeBinding);
  return map;
}

/**
 * Merge stored overrides onto the defaults. An override is { [id]: string[] };
 * unknown ids and malformed bindings are dropped, so a damaged store can only
 * ever fall back to a default, never break a key.
 * @param {unknown} overrides
 */
function resolveKeymap(overrides, isMac) {
  const map = defaultKeymap(isMac);
  if (overrides && typeof overrides === "object") {
    for (const [id, list] of Object.entries(/** @type {Record<string, unknown>} */ (overrides))) {
      if (!(id in map) || !Array.isArray(list)) continue;
      map[id] = list.filter(isValidBinding).map(normalizeBinding).slice(0, 2);
    }
  }
  return map;
}

/** The command already holding `binding`, other than `exceptId`, or null. */
function findConflict(keymap, binding, exceptId) {
  const b = normalizeBinding(binding);
  for (const [id, list] of Object.entries(keymap)) {
    if (id === exceptId) continue;
    if (list.includes(b)) return id;
  }
  return null;
}

/**
 * Turn keydown events into command ids, chords included. `typing` suppresses
 * bare-key bindings (letters, Delete, "?") while an input has focus, so typing
 * a name never trashes a contact; combos with a modifier still work.
 * @param {() => Record<string, string[]>} getKeymap
 */
function createMatcher(getKeymap) {
  /** @type {{ combo: string, at: number } | null} */
  let pending = null;
  /**
   * @param {{ key: string, metaKey: boolean, ctrlKey: boolean, altKey: boolean, shiftKey: boolean }} e
   * @param {{ typing?: boolean, now?: number, isMac: boolean }} opts
   * @returns {{ id: string | null, chordStarted: boolean }}
   */
  return function match(e, { typing = false, now = Date.now(), isMac }) {
    const combo = comboFromEvent(e, isMac);
    if (!combo) return { id: null, chordStarted: false };
    const bare = !parseCombo(combo).mods.some((m) => m !== "Shift");
    if (typing && bare) { pending = null; return { id: null, chordStarted: false }; }
    const map = getKeymap();
    if (pending && now - pending.at <= CHORD_MS) {
      const chord = `${pending.combo} ${combo}`;
      pending = null;
      for (const [id, list] of Object.entries(map)) if (list.includes(chord)) return { id, chordStarted: false };
    }
    pending = null;
    for (const [id, list] of Object.entries(map)) if (list.includes(combo)) return { id, chordStarted: false };
    for (const list of Object.values(map)) {
      if (list.some((b) => b.split(" ").length === 2 && b.split(" ")[0] === combo)) {
        pending = { combo, at: now };
        return { id: null, chordStarted: true };
      }
    }
    return { id: null, chordStarted: false };
  };
}

module.exports = {
  COMMANDS, FIXED, STORAGE_KEY, CHORD_MS,
  parseCombo, isValidBinding, normalizeBinding, comboFromEvent, formatCombo, formatBinding,
  browserReserved, defaultKeymap, resolveKeymap, findConflict, createMatcher,
};
