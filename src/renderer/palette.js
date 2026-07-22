// palette.js - the command palette: search and app commands in ONE Cmd/Ctrl+K
// surface (DECISIONS.md: the palette is the app's front door). Debounced,
// cancellable search per INTERFACE_CONTRACT §3: stale requestIds are discarded.

import config from "../main/config.js";
import { isQuickAdd, parseQuickAdd, quickAddPreview } from "../shared/quick-add.js";
import { promptModal } from "./modal.js";
import { toast, toastError } from "./toast.js";

const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Wrap query-token matches in <mark> (safe: builds DOM, never innerHTML). */
function highlight(target, text, tokens) {
  const lower = text.toLowerCase();
  const ranges = [];
  for (const tok of tokens) {
    if (!tok) continue;
    let at = lower.indexOf(tok);
    while (at !== -1) {
      ranges.push([at, at + tok.length]);
      at = lower.indexOf(tok, at + tok.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    if (start > cursor) target.append(text.slice(cursor, start));
    target.append(Object.assign(document.createElement("mark"), { textContent: text.slice(start, end) }));
    cursor = end;
  }
  if (cursor < text.length) target.append(text.slice(cursor));
}

export class Palette {
  /**
   * @param {HTMLElement} root
   * @param {{ commands: { label: string, hint?: string, run: () => void }[],
   *           onOpenContact: (id: number) => void,
   *           onCreateContact: (name: string) => void,
   *           onQuickAdd: (parsed: any) => void,
   *           getStarred?: () => { id: number, name: string, org?: string }[],
   *           getScope?: () => { label: string, ids: Set<number> } | null }} opts
   */
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.requestId = 0;
    this.debounceTimer = null;
    this.rows = [];
    this.selected = 0;
    this.results = [];
    this.savedSearches = [];
    this.attention = [];
    this.attentionDismissed = false; // 'c c' clears the attention suggestions for the session
    this.scopeOn = false;

    const box = el("div", "palette");
    this.input = el("input");
    this.input.placeholder = "Search contacts or type a command…";
    this.input.setAttribute("aria-label", "Search contacts or type a command");
    this.scopeBar = el("button", "scope-bar mono");
    this.scopeBar.type = "button";
    this.scopeBar.hidden = true;
    this.scopeBar.addEventListener("click", () => {
      this.scopeOn = !this.scopeOn;
      this.refresh(this.input.value.trim());
    });
    this.list = el("div", "palette-results");
    this.list.setAttribute("role", "listbox");
    const foot = el("div", "palette-foot mono");
    foot.append(el("span", null, "↑↓ navigate"), el("span", null, "↵ open"), el("span", null, "esc close"));
    this.clearHint = el("button", "palette-clear mono", "clear attention");
    this.clearHint.type = "button";
    this.clearHint.hidden = true;
    this.clearHint.addEventListener("mousedown", (e) => e.preventDefault()); // keep input focus
    this.clearHint.addEventListener("click", () => this.clearAttention());
    foot.append(this.clearHint);
    box.append(this.input, this.scopeBar, this.list, foot);
    root.append(box);

    root.addEventListener("mousedown", (e) => {
      if (e.target === root) this.close();
    });
    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open(prefill = "") {
    this.root.hidden = false;
    this.input.value = prefill;
    this.input.focus();
    // The empty-query state is a briefing: attention, favorites, saved
    // searches, then commands (SEARCH spec §9).
    window.api.searches.list({}).then(
      (saved) => {
        this.savedSearches = saved;
        if (this.isOpen && !this.input.value.trim()) this.renderRows("");
      },
      () => {}
    );
    if (!this.attentionDismissed) {
      window.api.insights.summary({}).then(
        (s) => {
          this.attention = [
            ...s.overdue.slice(0, 3).map((o) => ({ ...o, kind: "overdue" })),
            ...s.dormant.slice(0, 2).map((d) => ({ ...d, kind: "dormant" })),
          ];
          if (this.isOpen && !this.input.value.trim()) this.renderRows("");
        },
        () => {}
      );
    }
    this.refresh(prefill.trim());
  }

  close() {
    this.root.hidden = true;
    this.input.value = "";
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  onInput() {
    const text = this.input.value.trim();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.refresh(text), config.search.debounceMs);
  }

  async refresh(text) {
    if (!text) {
      this.results = [];
      this.didYouMean = undefined;
      this.renderRows(text);
      return;
    }
    const requestId = ++this.requestId;
    try {
      const resp = await window.api.search.query({ text, requestId, limit: config.search.limit });
      if (resp.requestId !== this.requestId) return; // stale: discard, never flicker
      this.results = resp.results;
      this.didYouMean = resp.didYouMean;
      this.renderRows(text);
    } catch (err) {
      if (this.requestId === requestId) toastError(err);
    }
  }

  renderRows(text) {
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    this.list.innerHTML = "";
    this.rows = [];
    this.selected = 0;
    this.clearHint.hidden = !(!text && this.attention.length); // only when suggestions show

    // Scope-to-focus chip (SEARCH spec, Need tier: search within the ego view).
    const scope = this.opts.getScope?.() ?? null;
    this.scopeBar.hidden = !scope;
    if (scope) {
      this.scopeBar.textContent = this.scopeOn
        ? `⦿ limited to ${scope.label}'s network - click to search everyone`
        : `○ searching everyone - click to limit to ${scope.label}'s network`;
    }
    const visible = scope && this.scopeOn
      ? this.results.filter((r) => scope.ids.has(r.contactId))
      : this.results;

    if (!text) {
      for (const a of this.attention) {
        this.addRow(() => this.opts.onOpenContact(a.id), (row) => {
          row.append(el("span", null, a.name));
          row.append(
            el("span", "row-sub overdue-sub",
              a.kind === "overdue"
                ? `${a.overdueDays}d overdue (every ${a.cadenceDays}d)`
                : "well-connected, long silent")
          );
          row.append(el("span", "row-meta mono", "attention"));
        });
      }
      for (const s of this.opts.getStarred?.() ?? []) {
        this.addRow(() => this.opts.onOpenContact(s.id), (row) => {
          row.append(el("span", null, `★ ${s.name}`));
          if (s.org) row.append(el("span", "row-sub", s.org));
        });
      }
      for (const s of this.savedSearches) {
        this.addRow(
          () => {
            this.root.hidden = false; // stay open, run the saved query
            this.input.value = s.query;
            this.input.focus();
            this.refresh(s.query);
          },
          (row) => {
            row.append(el("span", null, s.name));
            row.append(el("span", "row-sub", s.query));
            const rm = el("span", "row-meta saved-remove mono", "✕");
            rm.title = "Delete saved search";
            rm.addEventListener("click", async (e) => {
              e.stopPropagation();
              try {
                await window.api.searches.delete({ id: s.id });
                this.savedSearches = this.savedSearches.filter((x) => x.id !== s.id);
                this.renderRows("");
              } catch (err) {
                toastError(err);
              }
            });
            row.append(rm);
          }
        );
      }
    }

    // Natural-language capture first: "met Sarah Kim, PM at Initech, via Bo
    // #conf" - capture intent beats search results.
    const quick = isQuickAdd(text) ? parseQuickAdd(text) : null;
    if (quick) {
      this.addRow(() => this.opts.onQuickAdd(quick), (row) => {
        row.append(el("span", null, `Quick add: ${quickAddPreview(quick)}`));
        row.append(el("span", "row-meta mono", "↵ add"));
      });
    }

    for (const r of visible) {
      this.addRow(() => this.opts.onOpenContact(r.contactId), (row) => {
        const name = el("span");
        highlight(name, r.name, tokens);
        row.append(name);
        const sub = [r.role, r.org].filter(Boolean).join(" · ");
        if (sub) row.append(el("span", "row-sub", sub));
        row.append(el("span", "row-meta mono", `${r.degree}°`));
      });
    }

    const matching = this.opts.commands.filter(
      (c) => !text || c.label.toLowerCase().includes(text.toLowerCase())
    );
    for (const c of matching) {
      this.addRow(c.run, (row) => {
        row.append(el("span", null, c.label));
        if (c.hint) row.append(el("span", "row-meta mono", c.hint));
      });
    }

    if (text && this.didYouMean) {
      const suggestion = this.didYouMean;
      this.addRow(
        () => {
          this.root.hidden = false;
          this.input.value = suggestion;
          this.input.focus();
          this.refresh(suggestion);
        },
        (row) => {
          row.append(el("span", null, `Did you mean "${suggestion}"?`));
          row.append(el("span", "row-meta mono", "suggestion"));
        }
      );
    }

    if (text && !quick && !visible.some((r) => r.name.toLowerCase() === text.toLowerCase())) {
      this.addRow(() => this.opts.onCreateContact(text), (row) => {
        row.append(el("span", null, `Create contact "${text}"`));
        row.append(el("span", "row-meta mono", "new"));
      });
    }

    if (text && visible.length) {
      this.addRow(
        async () => {
          const name = await promptModal({
            title: "Save this search",
            label: "Name",
            placeholder: text,
            confirmLabel: "Save",
          });
          if (!name?.trim()) return;
          try {
            await window.api.searches.save({ name: name.trim(), query: text });
            toast(`Saved search "${name.trim()}".`);
          } catch (err) {
            toastError(err);
          }
        },
        (row) => {
          row.append(el("span", "dim", `Save search "${text}"`));
          row.append(el("span", "row-meta mono", "save"));
        }
      );
    }

    if (!this.rows.length) {
      this.list.append(el("div", "palette-empty", `No matches for "${text}".`));
    }
    this.updateSelection();
  }

  addRow(run, build) {
    const row = el("button", "palette-row");
    row.type = "button";
    row.setAttribute("role", "option");
    build(row);
    const index = this.rows.length;
    row.addEventListener("click", () => {
      this.close();
      run();
    });
    row.addEventListener("mousemove", () => {
      if (this.selected !== index) {
        this.selected = index;
        this.updateSelection();
      }
    });
    this.rows.push({ row, run });
    this.list.append(row);
  }

  updateSelection() {
    this.rows.forEach(({ row }, i) => {
      row.setAttribute("aria-selected", String(i === this.selected));
    });
    this.rows[this.selected]?.row.scrollIntoView({ block: "nearest" });
  }

  onKey(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const n = this.rows.length;
      if (n) this.selected = (this.selected + delta + n) % n;
      this.updateSelection();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = this.rows[this.selected];
      if (entry) {
        this.close();
        entry.run();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // the app-level Esc must not also fire
      this.close();
    }
  }

  /** Dismiss the attention suggestions from the empty-state list (session). */
  clearAttention() {
    this.attentionDismissed = true;
    this.attention = [];
    this.input.value = "";
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.renderRows("");
    this.input.focus();
    toast("Attention suggestions cleared.");
  }
}
