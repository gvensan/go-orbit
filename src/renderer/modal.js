// modal.js - one overlay primitive for the wizard, trash, dedup queue, and
// pickers. Esc closes (captured so the app-level Esc doesn't also fire).

export const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * @param {{ title: string, onClose?: () => void }} opts
 * @returns {{ body: HTMLElement, foot: HTMLElement, close: () => void, setTitle: (t: string) => void }}
 */
export function openModal({ title, onClose }) {
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal");
  const head = el("div", "modal-head");
  const h2 = el("h2", null, title);
  const x = el("button", null, "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  head.append(h2, x);
  const body = el("div", "modal-body");
  const foot = el("div", "modal-foot");
  box.append(head, body, foot);
  overlay.append(box);
  document.body.append(overlay);

  const close = () => {
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
    onClose?.();
  };
  const onKey = (e) => {
    const overlays = document.querySelectorAll(".modal-overlay");
    if (e.key === "Escape" && overlays[overlays.length - 1] === overlay) {
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener("keydown", onKey, true);
  x.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  return { body, foot, close, setTitle: (t) => (h2.textContent = t) };
}

/** Yes/no confirmation; resolves true only on explicit confirm. */
export function confirmModal({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const m = openModal({ title, onClose: () => settle(false) });
    m.body.append(el("p", null, message));
    const cancel = el("button", null, "Cancel");
    cancel.type = "button";
    const ok = el("button", danger ? "danger" : "primary", confirmLabel);
    ok.type = "button";
    m.foot.append(cancel, ok);
    cancel.addEventListener("click", () => m.close());
    ok.addEventListener("click", () => {
      settle(true);
      m.close();
    });
    ok.focus();
  });
}

/**
 * Destructive-action confirmation: the confirm button stays disabled until the
 * user types the exact `confirmWord`. Resolves true only on confirm.
 * @param {{ title: string, message: string, confirmWord: string, confirmLabel?: string }} opts
 */
export function confirmDangerModal({ title, message, confirmWord, confirmLabel = "Delete" }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    const m = openModal({ title, onClose: () => settle(false) });
    for (const line of message.split("\n")) m.body.append(el("p", null, line));
    const row = el("div", "form-row");
    row.append(el("label", null, `Type ${confirmWord}`));
    const input = el("input");
    input.type = "text";
    input.placeholder = confirmWord;
    row.append(input);
    m.body.append(row);
    const cancel = el("button", null, "Cancel");
    cancel.type = "button";
    const ok = el("button", "danger", confirmLabel);
    ok.type = "button";
    ok.disabled = true;
    m.foot.append(cancel, ok);
    input.addEventListener("input", () => { ok.disabled = input.value.trim() !== confirmWord; });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !ok.disabled) confirm(); });
    const confirm = () => { settle(true); m.close(); };
    ok.addEventListener("click", confirm);
    cancel.addEventListener("click", () => m.close());
    input.focus();
  });
}

/** Simple inline prompt modal; resolves the string or null on cancel. */
export function promptModal({ title, label, type = "text", placeholder = "", confirmLabel = "OK" }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const m = openModal({ title, onClose: () => settle(null) });
    const row = el("div", "form-row");
    const lab = el("label", null, label);
    const input = el("input");
    input.type = type;
    input.placeholder = placeholder;
    row.append(lab, input);
    m.body.append(row);
    const ok = el("button", "primary", confirmLabel);
    ok.type = "button";
    const cancel = el("button", null, "Cancel");
    cancel.type = "button";
    m.foot.append(cancel, ok);
    const submit = () => {
      settle(input.value);
      m.close();
    };
    ok.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    cancel.addEventListener("click", () => m.close());
    input.focus();
  });
}
