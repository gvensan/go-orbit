// shortcuts.js - Settings > Shortcuts: every key Orbit answers to, editable.
// Click a key to record a new one, Backspace clears it (which is how a shortcut
// is disabled), Esc cancels; a combo already in use is refused by name; one the
// browser reserves is accepted with a warning, since whether it reaches the
// page depends on the browser. Per-row and whole-table reset. The fixed keys
// (Esc, arrows, mouse gestures) are listed but not editable.

import { el } from "./modal.js";
import { toast } from "./toast.js";
import { COMMANDS, FIXED, comboFromEvent, formatBinding, findConflict, browserReserved } from "../shared/keymap.js";
import { IS_MAC, getKeymap, getDefaults, isCustom, setBinding, resetBinding, resetAll } from "./keymap.js";

/**
 * @param {HTMLElement} parent
 * @param {{ onChanged?: () => void }} [opts]
 */
export function shortcutsSection(parent, { onChanged } = {}) {
  const sec = el("div", "card-section");
  sec.append(el("h3", null, "Keyboard shortcuts"));
  sec.append(el("p", "dim",
    "Everything in Orbit is reachable by keyboard; these keys skip even the palette. " +
    "Click a key to change it, then press the new combination. Backspace while recording clears it, which switches that shortcut off. " +
    "Choices are kept on this device only."));

  const table = el("div", "shortcut-list");
  sec.append(table);

  const bar = el("div", "card-actions");
  const resetBtn = el("button", null, "Reset all to defaults");
  resetBtn.type = "button";
  resetBtn.title = "Put every shortcut back to what Orbit ships with";
  resetBtn.addEventListener("click", () => { resetAll(); render(); onChanged?.(); toast("Shortcuts reset to defaults."); });
  bar.append(resetBtn);
  sec.append(bar);

  const fixedHead = el("h4", "shortcut-fixed-head", "Always the same");
  const fixed = el("div", "shortcut-list");
  for (const { keys, what } of FIXED) {
    const row = el("div", "field-row shortcut-row");
    row.append(el("kbd", "field-key mono shortcut-keys shortcut-keys--fixed", keys), el("span", "field-val dim", what));
    fixed.append(row);
  }
  sec.append(fixedHead, fixed);
  parent.append(sec);

  /** @type {(() => void) | null} */
  let stopRecording = null;

  function record(chip, id, index) {
    stopRecording?.();
    const original = chip.textContent;
    chip.textContent = "Press keys…";
    chip.classList.add("recording");
    chip.title = "Press the new key combination. Backspace clears this shortcut, Esc keeps the old one";
    const done = () => {
      window.removeEventListener("keydown", onKey, true);
      chip.classList.remove("recording");
      stopRecording = null;
    };
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { done(); chip.textContent = original; return; }
      if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        done();
        setBinding(id, index, null);
        render();
        onChanged?.();
        toast("Shortcut cleared.");
        return;
      }
      const combo = comboFromEvent(e, IS_MAC);
      if (!combo) return; // a lone modifier: keep waiting for the key
      const taken = findConflict(getKeymap(), combo, id);
      if (taken) {
        const other = COMMANDS.find((c) => c.id === taken);
        done();
        chip.textContent = original;
        toast(`${formatBinding(combo, IS_MAC)} already opens "${other ? other.label : taken}". Change that one first, or pick another key.`);
        return;
      }
      done();
      setBinding(id, index, combo);
      render();
      onChanged?.();
      const warn = browserReserved(combo, IS_MAC);
      toast(warn ? `Set to ${formatBinding(combo, IS_MAC)}. ${warn}` : `Set to ${formatBinding(combo, IS_MAC)}.`);
    };
    window.addEventListener("keydown", onKey, true);
    stopRecording = () => { done(); chip.textContent = original; };
  }

  function render() {
    table.innerHTML = "";
    const map = getKeymap();
    const defaults = getDefaults();
    for (const cmd of COMMANDS) {
      const list = map[cmd.id] || [];
      const row = el("div", "field-row shortcut-row");
      const keys = el("span", "shortcut-slots");
      const slots = Math.max(1, Math.min(2, list.length + (list.length < (defaults[cmd.id] || []).length || list.length === 0 ? 1 : 0)));
      for (let i = 0; i < slots; i++) {
        const binding = list[i];
        const chip = el("button", `shortcut-keys mono${binding ? "" : " unbound"}`, binding ? formatBinding(binding, IS_MAC) : (i === 0 ? "off" : "+ add"));
        chip.type = "button";
        chip.title = binding
          ? `Click to change this key for "${cmd.label}"`
          : (i === 0 ? `Switched off. Click to give "${cmd.label}" a key` : `Add a second key for "${cmd.label}"`);
        chip.addEventListener("click", () => record(chip, cmd.id, i));
        keys.append(chip);
      }
      const what = el("span", "field-val dim", cmd.label);
      row.append(keys, what);
      const warnings = list.map((b) => browserReserved(b, IS_MAC)).filter(Boolean);
      if (isCustom(cmd.id)) {
        const reset = el("button", "ghost shortcut-reset", "↺");
        reset.type = "button";
        reset.title = `Back to ${defaults[cmd.id].map((b) => formatBinding(b, IS_MAC)).join(" or ")}`;
        reset.setAttribute("aria-label", `Reset ${cmd.label} to its default key`);
        reset.addEventListener("click", () => { resetBinding(cmd.id); render(); onChanged?.(); });
        row.append(reset);
      }
      table.append(row);
      if (warnings.length && isCustom(cmd.id)) {
        table.append(el("p", "field-hint dim shortcut-warn", warnings[0]));
      }
    }
  }
  render();
}
