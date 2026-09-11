// keymap.js (renderer) - the live keymap: defaults from src/shared/keymap.js,
// per-device overrides in localStorage, and a change signal so labels and the
// keyboard handler follow an edit made on Settings > Shortcuts.

import {
  STORAGE_KEY, COMMANDS, resolveKeymap, defaultKeymap, formatBinding, normalizeBinding, isValidBinding,
} from "../shared/keymap.js";

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent);

/** @type {Record<string, string[]>} */
let overrides = {};
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw ? JSON.parse(raw) : {};
  if (parsed && typeof parsed === "object") overrides = parsed;
} catch { overrides = {}; }

/** @type {Set<() => void>} */
const listeners = new Set();
let current = resolveKeymap(overrides, IS_MAC);

function persist() {
  current = resolveKeymap(overrides, IS_MAC);
  try {
    if (Object.keys(overrides).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* a blocked store only loses persistence, not the change */ }
  for (const fn of listeners) fn();
}

/** The effective bindings, { [commandId]: string[] }. */
export function getKeymap() { return current; }

/** Defaults for this platform. */
export function getDefaults() { return defaultKeymap(IS_MAC); }

/** Is this command bound differently from its default? */
export function isCustom(id) {
  const d = getDefaults()[id] || [];
  const c = current[id] || [];
  return d.length !== c.length || d.some((b, i) => b !== c[i]);
}

/**
 * Set slot `index` of a command to `binding`, or clear it with null. Slots
 * are compacted so a command never holds a hole.
 * @param {string} id @param {number} index @param {string | null} binding
 */
export function setBinding(id, index, binding) {
  if (!COMMANDS.some((c) => c.id === id)) return;
  const list = (current[id] || []).slice();
  if (binding == null) list.splice(index, 1);
  else if (isValidBinding(binding)) list[index] = normalizeBinding(binding);
  else return;
  overrides = { ...overrides, [id]: list.filter(Boolean).slice(0, 2) };
  persist();
}

export function resetBinding(id) {
  const next = { ...overrides };
  delete next[id];
  overrides = next;
  persist();
}

export function resetAll() {
  overrides = {};
  persist();
}

/** @param {() => void} fn @returns {() => void} unsubscribe */
export function onKeymapChange(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The primary key for a command, formatted for this platform; "" when unbound. */
export function keyLabel(id) {
  const b = (current[id] || [])[0];
  return b ? formatBinding(b, IS_MAC) : "";
}
