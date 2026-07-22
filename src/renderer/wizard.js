// wizard.js - the 4-step import wizard (APP_SHELL_UX §3): source -> mapping
// (CSV only) -> dedup policy -> run + report.

import { el, openModal } from "./modal.js";
import { toastError } from "./toast.js";

const FIELD_OPTIONS = ["", "name", "email", "phone", "company", "role", "notes", "tags"];
const api = () => window.api;

// A ready-to-fill CSV whose headers auto-map to Orbit's fields (see csv.js
// HEADER_HINTS). Tags are separated by ";" so they don't collide with the comma
// delimiter. The example rows show the expected shape and can be deleted.
const CSV_TEMPLATE = [
  "name,email,phone,company,role,notes,tags",
  "Ada Lovelace,ada@example.com,+1 555 0100,Analytical Engines,Mathematician,Met at the Analytical Society,friend;mentor",
  "Alan Turing,alan@example.com,+44 20 7946 0000,Bletchley Park,Cryptanalyst,,colleague",
  "",
].join("\n");

/** Offer the CSV template as a local download. No network, no main-process
 *  round-trip: a Blob URL downloaded via an <a download> (allowed under the
 *  renderer's strict CSP). */
function downloadCsvTemplate() {
  const url = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "orbit-contacts-template.csv";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param {{ onDone: () => void }} opts
 */
export async function openImportWizard({ onDone }) {
  const m = openModal({ title: "Import contacts" });
  const steps = ["Source", "Mapping", "Duplicates", "Import"];
  const state = {
    srcPath: null,
    kind: null,
    preview: null,
    passphrase: undefined,
    mapping: null,
    onDuplicate: /** @type {"skip" | "merge" | "keepBoth"} */ ("skip"),
  };

  const stepsBar = el("div", "wizard-steps");
  m.body.append(stepsBar);
  const content = el("div");
  m.body.append(content);

  function setStep(n) {
    stepsBar.innerHTML = "";
    steps.forEach((s, i) => {
      const chip = el("span", "wizard-step" + (i === n ? " active" : ""), s);
      stepsBar.append(chip);
    });
    content.innerHTML = "";
    m.foot.innerHTML = "";
  }

  // ---- step 0: pick source ----
  async function stepSource() {
    setStep(0);
    const grid = el("div", "source-grid");
    const mkSource = (label, sub, filters) => {
      const b = el("button");
      b.type = "button";
      b.append(el("strong", null, label), el("span", "mono dim", sub));
      b.addEventListener("click", async () => {
        try {
          const { path } = await api().dialogs.openFile({ filters });
          if (!path) return;
          state.srcPath = path;
          state.preview = await api().data.importPreview({ srcPath: path });
          state.kind = state.preview.kind;
          if (state.preview.encrypted) return stepPassphrase();
          state.kind === "csv" ? stepMapping() : stepPolicy();
        } catch (err) {
          toastError(err);
        }
      });
      grid.append(b);
    };
    mkSource("vCard", ".vcf", [{ name: "vCard", extensions: ["vcf", "vcard"] }]);
    mkSource("CSV", ".csv", [{ name: "CSV", extensions: ["csv"] }]);
    mkSource("Archive", ".orbit", [{ name: "Orbit archive", extensions: ["orbit"] }]);
    content.append(grid);

    // Subtle helper for the CSV path: a template with the columns Orbit maps.
    const csvHelp = el("p", "mono dim source-csv-help");
    csvHelp.append(document.createTextNode("New to CSV? "));
    const tmpl = el("a", "template-link");
    tmpl.textContent = "Download the CSV template";
    tmpl.href = "#";
    tmpl.addEventListener("click", (e) => { e.preventDefault(); downloadCsvTemplate(); });
    csvHelp.append(tmpl);
    content.append(csvHelp);

    content.append(el("p", "mono dim", "Everything is parsed locally. A backup snapshot is taken before any import."));
  }

  // ---- step 0b: archive passphrase ----
  function stepPassphrase() {
    setStep(0);
    content.append(el("p", null, "This archive is passphrase-protected."));
    const row = el("div", "form-row");
    row.append(el("label", null, "Passphrase"));
    const input = el("input");
    input.type = "password";
    row.append(input);
    content.append(row);
    const next = el("button", "primary", "Unlock");
    next.type = "button";
    next.addEventListener("click", async () => {
      try {
        state.passphrase = input.value;
        state.preview = await api().data.importPreview({ srcPath: state.srcPath, passphrase: input.value });
        stepPolicy();
      } catch (err) {
        toastError(err);
      }
    });
    m.foot.append(next);
    input.focus();
  }

  // ---- step 1: CSV mapping ----
  function stepMapping() {
    setStep(1);
    const { headers, suggestedMapping, count } = state.preview;
    content.append(el("p", null, `${count} rows found. Map each column:`));
    const table = el("table", "map-table");
    /** @type {Record<string, HTMLSelectElement>} */
    const selects = {};
    for (const h of headers) {
      const tr = el("tr");
      const td1 = el("td", "mono", h);
      const td2 = el("td");
      const sel = el("select");
      for (const f of FIELD_OPTIONS) sel.append(new Option(f === "" ? "(ignore)" : f, f));
      sel.append(new Option(`custom: ${h}`, `custom:${h}`));
      sel.value = suggestedMapping?.[h] ?? "";
      selects[h] = sel;
      td2.append(sel);
      tr.append(td1, td2);
      table.append(tr);
    }
    content.append(table);

    const next = el("button", "primary", "Next");
    next.type = "button";
    next.addEventListener("click", () => {
      const mapping = {};
      for (const [h, sel] of Object.entries(selects)) {
        mapping[h] = sel.value.startsWith("custom:") ? h : sel.value;
      }
      if (!Object.values(mapping).includes("name")) {
        content.prepend(el("p", "danger", "One column must map to name."));
        return;
      }
      state.mapping = mapping;
      stepPolicy();
    });
    m.foot.append(next);
  }

  // ---- step 2: dedup policy ----
  function stepPolicy() {
    setStep(2);
    content.append(el("p", null, `${state.preview.count} contacts ready. When one matches an existing contact:`));
    const options = /** @type {["skip" | "merge" | "keepBoth", string][]} */ ([
      ["skip", "Skip it - keep what I have"],
      ["merge", "Merge - fill in my blanks, never overwrite"],
      ["keepBoth", "Keep both - I'll review duplicates later"],
    ]);
    for (const [value, label] of options) {
      const row = el("label", "form-row");
      const radio = el("input");
      radio.type = "radio";
      radio.name = "policy";
      radio.value = value;
      radio.checked = state.onDuplicate === value;
      radio.addEventListener("change", () => (state.onDuplicate = value));
      row.append(radio, el("span", null, label));
      content.append(row);
    }
    if (state.preview.sample?.length) {
      const ul = el("ul", "sample-list");
      for (const s of state.preview.sample) {
        ul.append(el("li", null, `${s.name}${s.fields.company ? ` · ${s.fields.company}` : ""}`));
      }
      content.append(el("p", "mono dim", "Preview:"), ul);
    }
    const run = el("button", "primary", `Import ${state.preview.count} contacts`);
    run.type = "button";
    run.addEventListener("click", stepRun);
    m.foot.append(run);
  }

  // ---- step 3: run + report ----
  async function stepRun() {
    setStep(3);
    content.append(el("p", null, "Importing… a backup snapshot was taken first."));
    try {
      const report =
        state.kind === "archive"
          ? await api().data.importArchive({
              srcPath: state.srcPath,
              passphrase: state.passphrase,
              onDuplicate: state.onDuplicate,
            })
          : await api().data.importFile({
              srcPath: state.srcPath,
              kind: state.kind,
              mapping: state.mapping ?? undefined,
              onDuplicate: state.onDuplicate,
            });
      content.innerHTML = "";
      const grid = el("div", "report-grid");
      for (const [label, value] of [
        ["imported", report.imported],
        ["merged", report.merged],
        ["skipped", report.skipped],
        ["duplicates", report.duplicatesFound],
      ]) {
        const cell = el("div");
        cell.append(el("div", "num", String(value)), el("div", "mono dim", label));
        grid.append(cell);
      }
      content.append(el("p", null, "Done."), grid);
      const close = el("button", "primary", "Close");
      close.type = "button";
      close.addEventListener("click", () => {
        m.close();
        onDone();
      });
      m.foot.append(close);
    } catch (err) {
      content.innerHTML = "";
      content.append(el("p", null, "The import failed and nothing was written."));
      content.append(el("p", "dim", err.message ?? String(err)));
      const back = el("button", null, "Back");
      back.type = "button";
      back.addEventListener("click", stepSource);
      m.foot.append(back);
    }
  }

  stepSource();
}
