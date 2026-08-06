// tooltip.js - in-app hover tooltips. The native `title` tooltip is an OS
// artefact: it waits a second or more, ignores the app's type and colours, and
// never appears on keyboard focus. Rather than invent a parallel attribute for
// every control, this hijacks `title` itself - the attribute is moved to
// `data-tip` the first time an element is hovered or focused, which suppresses
// the OS bubble, and one shared element renders the text in the app's voice.
//
// Delegated from the document, so controls built later (table rows, wizard
// pages, menus) need no registration: set `title` as usual and it works.

import config from "../main/config.js";

const T = config.tooltip;

let tipEl = null;
let anchor = null;        // element the visible tooltip belongs to
let showTimer = null;
let hideTimer = null;
let lastHiddenAt = 0;     // drives the shorter repeat delay between neighbours
let installed = false;

/** The tooltip text for `node`, stashing `title` on first use so the OS bubble
 *  never fires. A freshly-set `title` always wins: callers re-title controls to
 *  reflect state (pressed, selected, disabled), and that must not go stale. */
function textFor(node) {
  const title = node.getAttribute("title");
  if (title !== null) {
    // An empty title is an explicit "no tooltip"; keep it stashed either way so
    // the attribute stops reaching the OS.
    node.removeAttribute("title");
    if (title.trim()) node.dataset.tip = title;
    else delete node.dataset.tip;
  }
  return node.dataset.tip || "";
}

/** Nearest ancestor (including `node`) that carries tooltip text. */
function anchorFor(node) {
  for (let el = node; el && el !== document.body; el = el.parentElement) {
    if (el.nodeType !== 1) continue;
    if (el.hasAttribute("title") || el.dataset.tip) {
      // Reading the text also migrates a stale `title`; an emptied one means
      // "no tooltip here", so keep walking up to a wrapper that has one.
      if (textFor(el)) return el;
    }
  }
  return null;
}

function ensureEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className = "app-tip";
  tipEl.setAttribute("role", "tooltip");
  tipEl.hidden = true;
  // Never let the bubble itself take a hover or a hit test, or moving toward it
  // would flicker the very control that opened it.
  tipEl.style.maxWidth = `${T.maxWidthPx}px`;
  document.body.append(tipEl);
  return tipEl;
}

/** Below the anchor when it fits, above when it doesn't, always inside the
 *  window. Measured after the text is set, so wrapping is accounted for. */
function place(el, rect) {
  el.style.left = "0px";
  el.style.top = "0px";
  el.classList.remove("above");
  const tip = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let top = rect.bottom + T.gapPx;
  if (top + tip.height > vh - T.edgePadPx) {
    const above = rect.top - tip.height - T.gapPx;
    // Only flip when there is genuinely more room above, so a tooltip on a
    // control near the bottom edge does not cover the control itself.
    if (above >= T.edgePadPx) { top = above; el.classList.add("above"); }
    else top = Math.max(T.edgePadPx, vh - tip.height - T.edgePadPx);
  }
  let left = rect.left + rect.width / 2 - tip.width / 2;
  left = Math.max(T.edgePadPx, Math.min(left, vw - tip.width - T.edgePadPx));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function show(node) {
  const text = textFor(node);
  if (!text) return;
  // A control can be removed or disabled during the delay (a re-render, a
  // finished async action); pointing at nothing would strand the bubble.
  if (!node.isConnected) return;
  const rect = node.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  const el = ensureEl();
  el.textContent = text;
  el.hidden = false;
  anchor = node;
  place(el, rect);
}

export function hideTooltip() {
  clearTimeout(showTimer); showTimer = null;
  clearTimeout(hideTimer); hideTimer = null;
  if (!tipEl || tipEl.hidden) return;
  tipEl.hidden = true;
  anchor = null;
  lastHiddenAt = Date.now();
}

function schedule(node, immediate) {
  if (node === anchor) { clearTimeout(hideTimer); hideTimer = null; return; }
  clearTimeout(showTimer);
  clearTimeout(hideTimer); hideTimer = null;
  // Sweeping from one control to its neighbour should not re-serve the full
  // delay - the user has already declared intent by lingering once.
  const warm = Date.now() - lastHiddenAt < 400;
  const delay = immediate ? 0 : warm ? T.repeatDelayMs : T.showDelayMs;
  const run = () => { showTimer = null; show(node); };
  if (delay === 0) run(); else showTimer = setTimeout(run, delay);
}

function scheduleHide() {
  clearTimeout(showTimer); showTimer = null;
  if (!tipEl || tipEl.hidden) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideTooltip, T.hideDelayMs);
}

/** Start listening. Idempotent, so a re-entered renderer cannot double-bind. */
export function installTooltips() {
  if (installed) return;
  installed = true;

  document.addEventListener("pointerover", (e) => {
    // Touch and pen taps have no hover state; a tooltip there just steals the tap.
    if (e.pointerType && e.pointerType !== "mouse") return;
    const node = anchorFor(/** @type {Element} */ (e.target));
    if (node) schedule(node, false);
    else if (anchor) scheduleHide();
  }, true);

  document.addEventListener("pointerout", (e) => {
    const to = /** @type {Node | null} */ (e.relatedTarget);
    // Moving within the same anchor (onto its icon or label) is not a leave.
    if (anchor && to && anchor.contains(to)) return;
    scheduleHide();
  }, true);

  // Keyboard parity: `title` alone is invisible to anyone tabbing through, so
  // focus shows the same help a hover does, with no delay. Only for keyboard
  // focus though - a click focuses the button too, and re-popping the bubble
  // under the pointer the instant it was dismissed reads as a flicker.
  document.addEventListener("focusin", (e) => {
    const target = /** @type {Element} */ (e.target);
    if (!target.matches?.(":focus-visible")) return;
    const node = anchorFor(target);
    if (node) schedule(node, true);
    else hideTooltip();
  });
  document.addEventListener("focusout", () => scheduleHide());

  // Anything that moves the anchor or takes the user's attention drops the tip
  // rather than leaving it floating over unrelated content.
  document.addEventListener("pointerdown", hideTooltip, true);
  document.addEventListener("keydown", (e) => {
    // Esc and Tab are handled by focus/blur; typing into a field should not
    // leave a tooltip parked over what is being typed.
    if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt" && e.key !== "Meta") hideTooltip();
  }, true);
  document.addEventListener("scroll", hideTooltip, true);
  window.addEventListener("resize", hideTooltip);
  window.addEventListener("blur", hideTooltip);

  // A re-render can replace the anchor while the tooltip is up (Explore repaints
  // rows on every selection change). Drop the bubble when its anchor leaves.
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(() => {
      if (anchor && !anchor.isConnected) hideTooltip();
    }).observe(document.body, { childList: true, subtree: true });
  }
}
