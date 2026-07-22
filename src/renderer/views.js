// views.js - the smaller modal surfaces: trash (restore), dedup review queue,
// and the relationship picker.

import { EDGE_TYPES } from "./colors.js";
import { confirmDangerModal, confirmModal, el, openModal } from "./modal.js";
import { toast, toastError } from "./toast.js";

const api = () => window.api;
const fmtDate = (ts) =>
  new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

// ---------------------------------------------------------------- trash --

export async function openTrash({ onChanged }) {
  const m = openModal({ title: "Trash" });
  let autoPurgeDays = null;
  try {
    autoPurgeDays = (await api().data.backupStatus({})).autoPurgeDays;
  } catch {}

  async function render() {
    m.body.innerHTML = "";
    let all;
    try {
      all = await api().contacts.list({ includeDeleted: true });
    } catch (err) {
      toastError(err);
      return;
    }
    const trashed = all.filter((c) => c.deletedAt != null);
    if (autoPurgeDays) {
      m.body.append(
        el("p", "mono dim", `Items here are permanently removed after ${autoPurgeDays} days.`)
      );
    }
    if (!trashed.length) {
      m.body.append(el("p", "dim", "Trash is empty. Deleted contacts land here and can be restored."));
      return;
    }
    // Bulk purge: empty the whole trash at once (type-to-confirm, irreversible).
    const bar = el("div", "trash-actions");
    const purgeAll = el("button", "danger", `Delete all forever (${trashed.length})`);
    purgeAll.type = "button";
    purgeAll.addEventListener("click", async () => {
      const yes = await confirmDangerModal({
        title: "Empty the trash?",
        message: `This permanently removes all ${trashed.length} trashed contacts, their relationships, and timelines. It cannot be undone.`,
        confirmWord: "DELETE",
        confirmLabel: "Delete all forever",
      });
      if (!yes) return;
      try {
        for (const c of trashed) await api().contacts.purge({ id: c.id });
        await onChanged();
        await render();
        toast(`Emptied the trash - ${trashed.length} removed for good.`);
      } catch (err) {
        // The loop can fail after earlier contacts were already purged.
        // Reconcile both the underlying view and this modal before reporting it.
        try {
          await onChanged();
          await render();
        } catch {}
        toastError(err);
      }
    });
    bar.append(purgeAll);
    m.body.append(bar);
    for (const c of trashed) {
      const row = el("div", "trash-row");
      row.append(el("span", null, c.name));
      if (c.fields.company) row.append(el("span", "row-sub dim", c.fields.company));
      row.append(el("span", "when mono", `deleted ${fmtDate(c.deletedAt)}`));
      const restore = el("button", null, "Restore");
      restore.type = "button";
      restore.addEventListener("click", async () => {
        try {
          await api().contacts.restore({ id: c.id });
          await onChanged();
          await render();
          toast(`Restored ${c.name}.`);
        } catch (err) {
          toastError(err);
        }
      });
      // Purge is the app's ONLY hard delete, so it is the one confirmed action.
      const purge = el("button", "danger", "Delete forever");
      purge.type = "button";
      purge.addEventListener("click", async () => {
        const yes = await confirmModal({
          title: `Delete ${c.name} forever?`,
          message: "This permanently removes the contact, their relationships, and their timeline. It cannot be undone.",
          confirmLabel: "Delete forever",
          danger: true,
        });
        if (!yes) return;
        try {
          await api().contacts.purge({ id: c.id });
          await onChanged();
          await render();
          toast(`${c.name} is gone for good.`);
        } catch (err) {
          toastError(err);
        }
      });
      row.append(restore, purge);
      m.body.append(row);
    }
  }
  await render();
}

// ---------------------------------------------------------------- dedup --

export async function openDedupQueue({ onChanged }) {
  const m = openModal({ title: "Review duplicates" });
  async function render() {
    m.body.innerHTML = "";
    let pairs;
    try {
      ({ pairs } = await api().dedup.candidates({}));
    } catch (err) {
      toastError(err);
      return;
    }
    if (!pairs.length) {
      m.body.append(el("p", "dim", "No likely duplicates found. Nice and tidy."));
      return;
    }
    m.body.append(el("p", "dim", `${pairs.length} candidate pair${pairs.length > 1 ? "s" : ""}, strongest first.`));
    for (const pair of pairs) {
      const row = el("div", "pair-row");
      row.append(el("div", "pair-reason", `${pair.reason} · confidence ${(pair.score * 100).toFixed(0)}%`));
      const sides = el("div", "pair-sides");
      for (const side of [pair.a, pair.b]) {
        const box = el("div", "pair-side");
        box.append(el("div", null, side.name));
        const sub = [side.company, side.email, side.phone].filter(Boolean).join(" · ");
        if (sub) box.append(el("div", "mono", sub));
        sides.append(box);
      }
      row.append(sides);

      const actions = el("div", "pair-actions");
      const doMerge = async (primaryId, secondaryId, keptName) => {
        try {
          const { mergeId } = await api().dedup.merge({ primaryId, secondaryId });
          await onChanged();
          await render();
          toast(`Merged into ${keptName}.`, {
            actionLabel: "Undo",
            onAction: async () => {
              try {
                await api().dedup.undo({ mergeId });
                await onChanged();
                await render();
              } catch (err) {
                toastError(err);
              }
            },
          });
        } catch (err) {
          toastError(err);
        }
      };
      const keepA = el("button", "primary", `Keep "${pair.a.name}"`);
      keepA.type = "button";
      keepA.addEventListener("click", () => doMerge(pair.aId, pair.bId, pair.a.name));
      const keepB = el("button", null, `Keep "${pair.b.name}"`);
      keepB.type = "button";
      keepB.addEventListener("click", () => doMerge(pair.bId, pair.aId, pair.b.name));
      const skip = el("button", null, "Not duplicates");
      skip.type = "button";
      skip.addEventListener("click", () => row.remove());
      actions.append(keepA, keepB, skip);
      row.append(actions);
      m.body.append(row);
    }
  }
  await render();
}

// ---------------------------------------------- relationship picker --

/** Pick another contact + edge type, then create the relationship. */
export function openRelationshipPicker(fromContact, { onLinked }) {
  const m = openModal({ title: `Link ${fromContact.name} to…` });
  const input = el("input");
  input.type = "text";
  input.placeholder = "Search for a contact…";
  input.style.width = "100%";
  const results = el("div");
  results.style.marginTop = "10px";
  m.body.append(input, results);

  let requestId = 0;
  let debounce = null;
  let chosen = null;

  function renderTypeChooser(target) {
    chosen = target;
    results.innerHTML = "";
    results.append(el("p", null, `Relationship with ${target.name}:`));
    const actions = el("div", "pair-actions");
    for (const type of EDGE_TYPES) {
      const b = el("button", null, type);
      b.type = "button";
      b.addEventListener("click", async () => {
        try {
          await api().edges.create({
            sourceId: fromContact.id,
            targetId: target.id,
            type,
            directed: type === "introduced",
          });
          toast(`Linked ${fromContact.name} and ${target.name} (${type}).`);
          m.close();
          onLinked();
        } catch (err) {
          toastError(err);
        }
      });
      actions.append(b);
    }
    results.append(actions);
  }

  async function refresh() {
    const text = input.value.trim();
    if (!text) {
      results.innerHTML = "";
      return;
    }
    const rid = ++requestId;
    try {
      const resp = await api().search.query({ text, requestId: rid, limit: 8 });
      if (resp.requestId !== requestId || chosen) return;
      results.innerHTML = "";
      for (const r of resp.results.filter((x) => x.contactId !== fromContact.id)) {
        const row = el("button", "conn-row");
        row.type = "button";
        row.append(
          el("span", null, r.name),
          el("span", "row-sub dim", r.org ?? ""),
          el("span", "conn-degree mono", `${r.degree}°`)
        );
        row.addEventListener("click", () => renderTypeChooser({ id: r.contactId, name: r.name }));
        results.append(row);
      }
    } catch (err) {
      toastError(err);
    }
  }
  input.addEventListener("input", () => {
    chosen = null;
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 120);
  });
  input.focus();
}
