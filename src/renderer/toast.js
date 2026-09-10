// toast.js - transient notices with an optional action (the undo-first delete
// pattern: no confirm dialogs, always an Undo).

const root = () => document.getElementById("toast-root");

/**
 * @param {string} message
 * @param {{ actionLabel?: string, onAction?: () => void, ttlMs?: number }} [opts]
 */
export function toast(message, { actionLabel, onAction, ttlMs = 6000 } = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);
  if (actionLabel && onAction) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = actionLabel;
    // The toast disappears on a timer, so say the action is time-limited.
    btn.title = `${actionLabel} · available until this notice fades`;
    btn.addEventListener("click", () => {
      el.remove();
      onAction();
    });
    el.appendChild(btn);
  }
  root().appendChild(el);
  setTimeout(() => el.remove(), ttlMs);
}

/** Map IpcError codes to the app-voice messages of APP_SHELL_UX §5. */
export function toastError(err) {
  // The bridge's own conditions (service offline, restarting, session gone,
  // file too large) arrive already worded for the user.
  if (err?.transport && err.message) return toast(err.message);
  const messages = {
    LOCKED: "Busy finishing a backup - one moment.",
    NOT_FOUND: "That contact is no longer available.",
    CONFLICT: "That already exists.",
    VALIDATION: "That request didn't look right - try again.",
  };
  toast(messages[err?.code] ?? `Something went wrong (${err?.message ?? "unknown error"}).`);
}
