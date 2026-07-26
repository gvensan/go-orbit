// card.js - the contact detail side panel (APP_SHELL_UX §3). The card is a
// read-only "simple view" by default; clicking any value (name, a field, notes,
// tags) turns THAT item into an in-place editor with apply (✓) / cancel (✕)
// controls. Each edit saves just its own field. Cadence and star apply
// immediately. Delete is undo-first.

import { CITIES, CITY_COORDS } from "../shared/cities.js";
import { COUNTRIES, flagEmoji, parsePhone, dialOf, groupNational } from "../shared/countries.js";
import { AUTOCOMPLETE_FIELDS, PRESET_VALUES, fieldType, validateField } from "../shared/field-types.js";
import { EDGE_COLORS, EDGE_TYPES, initials, kinPreview, kinRolesFor, orgColor, reciprocalRole } from "./colors.js";
import { confirmModal, el } from "./modal.js";
import { pickLocationOnMap } from "./location-picker.js";
import { toast, toastError } from "./toast.js";

// gender leads the details: it's the first thing worth setting (it drives the
// kinship options), then the rest.
const KNOWN_FIELDS = ["gender", "location", "email", "phone", "company", "role", "notes"];
// Standard fields offered as quick-pick chips under "+ Add field" (expandable).
const STANDARD_FIELDS = ["deceased", "birthday", "nickname", "address", "website", "linkedin"];
const fmtDate = (ts) =>
  new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const iconBtn = (glyph, cls, title) => {
  const b = el("button", cls, glyph);
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  return b;
};

// A value control matched to the field key: email/date/url native inputs,
// company/role/gender datalists, notes a textarea, phone a country + number
// widget. Module-level so both inline editors and add-field use it.
function createControl(key, value, fieldValues) {
  const type = fieldType(key);
  if (type === "bool") {
    const cb = /** @type {HTMLInputElement} */ (el("input", "field-check"));
    cb.type = "checkbox";
    cb.checked = /^(yes|true|1)$/i.test(value ?? "");
    return {
      element: cb,
      isBool: true,
      read: () => (cb.checked ? "yes" : ""),
      focus: () => cb.focus(),
      setInvalid: () => {},
      onBlur: (fn) => cb.addEventListener("change", fn),
    };
  }
  if (type === "tel") return createPhoneControl(value);
  const lc = String(key).trim().toLowerCase();
  if (lc === "gender") {
    // Gender is a standard field with a fixed option set (blank clears it).
    const sel = el("select", "field-value");
    sel.append(new Option("—", ""));
    for (const g of PRESET_VALUES.gender ?? ["Female", "Male"]) sel.append(new Option(g, g));
    if (value && !(PRESET_VALUES.gender ?? []).includes(value)) sel.append(new Option(value, value));
    sel.value = value ?? "";
    return {
      element: sel,
      isSelect: true, // a picked option commits immediately - no ✓ needed
      read: () => sel.value,
      focus: () => sel.focus(),
      setInvalid: () => {},
      onBlur: (fn) => sel.addEventListener("change", fn),
    };
  }
  if (lc === "notes") {
    const ta = el("textarea", "field-value");
    ta.rows = 3;
    ta.value = value ?? "";
    return {
      element: ta, multiline: true,
      read: () => ta.value.trim(),
      focus: () => ta.focus(),
      setInvalid: (b) => ta.classList.toggle("invalid", b),
      onBlur: (fn) => ta.addEventListener("blur", fn),
    };
  }
  const input = el("input", "field-value");
  input.type = { email: "email", date: "date", url: "url", text: "text" }[type] ?? "text";
  input.value = value ?? "";
  if (AUTOCOMPLETE_FIELDS.includes(lc)) input.setAttribute("list", `dl-${lc}`);
  return {
    element: input,
    read: () => input.value.trim(),
    focus: () => input.focus(),
    setInvalid: (b) => input.classList.toggle("invalid", b),
    onBlur: (fn) => input.addEventListener("blur", fn),
  };
}

function createPhoneControl(value) {
  const parsed = parsePhone(value);
  const wrap = el("div", "phone-input");
  // Country selector: option labels are full country names so you can search
  // by typing the name ("united k…" jumps to United Kingdom).
  const sel = el("select", "phone-country");
  for (const c of COUNTRIES) sel.append(new Option(`${flagEmoji(c.iso2)} ${c.name} (+${c.dial})`, c.iso2));
  sel.value = parsed ? parsed.country.iso2 : localStorage.getItem("orbit-phone-country") || "US";

  // Number split into area code + local number. For NANP (+1) the area code
  // is the first 3 national digits; elsewhere the split is left to the user.
  const area = el("input", "phone-area");
  area.type = "tel";
  area.placeholder = "area";
  area.setAttribute("aria-label", "Area code");
  const num = el("input", "phone-number");
  num.type = "tel";
  num.placeholder = "number";
  num.setAttribute("aria-label", "Phone number");
  if (parsed) {
    if (parsed.country.dial === "1" && parsed.national.length >= 7) {
      area.value = parsed.national.slice(0, 3);
      num.value = parsed.national.slice(3);
    } else {
      num.value = parsed.national;
    }
  } else if (value && !value.startsWith("+")) {
    num.value = value.replace(/[^\d]/g, "");
  }

  wrap.append(sel, area, num);
  sel.addEventListener("change", () => localStorage.setItem("orbit-phone-country", sel.value));
  return {
    element: wrap,
    // Standardized "+<dial> <grouped national>", e.g. "+91 98807 49181".
    read: () => {
      const a = area.value.replace(/[^\d]/g, "");
      const n = num.value.replace(/[^\d]/g, "");
      const nat = a + n;
      return nat ? `+${dialOf(sel.value)} ${groupNational(sel.value, nat)}` : "";
    },
    focus: () => num.focus(),
    setInvalid: (b) => num.classList.toggle("invalid", b),
    onBlur: (fn) => {
      num.addEventListener("blur", fn);
      area.addEventListener("blur", fn);
      sel.addEventListener("change", fn);
    },
  };
}

export class ContactCard {
  /**
   * @param {HTMLElement} panel
   * @param {{ onNavigate: (id: number) => void, onDelete: (contact: any) => void,
   *           onDepthChange: (depth: number) => void, onClose: () => void,
   *           onChanged: (id: number, from?: { from: number, fromName: string }) => void, onAddRelationship: (contact: any) => void,
   *           onAddConnection: (contact: any, rect: DOMRect) => void,
   *           onRelChanged: (id: number, fromId: number, fromName: string) => void,
   *           onDeleteConnection: (edge: any, other: any) => Promise<void>,
   *           onHighlightConnection: (id: number | null) => void,
   *           getIntroChain: (id: number) => { id: number, name: string }[] }} handlers
   */
  constructor(panel, handlers) {
    this.panel = panel;
    this.handlers = handlers;
    this.depth = 1;
    this.connExpanded = true; // Connections are useful context, so show them by default.
  }

  hide() {
    this.panel.hidden = true;
    this.panel.innerHTML = "";
  }

  /**
   * @param {any} contact
   * @param {{ neighbors: any[], interactions: any[], edges?: any[], tags: string[], allTags: string[],
   *           startRename?: boolean,
   *           relFrom?: { id: number, name: string, gender?: string, edge: any } }} context
   */
  show(contact, context) {
    this.contact = contact;
    this.context = context;
    this.panel.hidden = false;
    // Refresh the online preference every time the card opens: Settings may have changed
    // it since this long-lived card instance was last used.
    this._locOnline = false;
    this._locOnlineReady = window.api.location.online({}).then(
      (r) => { this._locOnline = !!r.enabled; },
      () => { this._locOnline = false; }
    );
    // Distinct company/role/gender values power the select-or-type editors.
    if (!this.fieldValues) {
      window.api.explore.fieldValues({}).then(
        (fv) => { this.fieldValues = fv; this.repopulateDatalists(); },
        () => { this.fieldValues = {}; }
      );
    }
    this.render();
  }

  /** Notify the app of a change, preserving the breadcrumb (relFrom) so the
   *  relationship + kinship editor survives edits like renaming. */
  notifyChanged() {
    const rf = this.context?.relFrom;
    this.handlers.onChanged(this.contact.id, rf ? { from: rf.id, fromName: rf.name } : undefined);
  }

  async saveField(key, value) {
    const fields = { ...this.contact.fields };
    if (value) fields[key] = value;
    else delete fields[key];
    try {
      await window.api.contacts.update({ id: this.contact.id, patch: { fields } });
      this.notifyChanged();
    } catch (err) {
      toastError(err);
    }
  }

  buildDatalists(p) {
    const wrap = el("div");
    this._datalists = {};
    const mk = (id) => {
      const dl = el("datalist");
      dl.id = id;
      wrap.append(dl);
      this._datalists[id] = dl;
      return dl;
    };
    mk("dl-company"); mk("dl-role"); mk("dl-gender"); mk("dl-location"); mk("dl-alltags");
    p.append(wrap);
    this.repopulateDatalists();
  }

  repopulateDatalists() {
    if (!this._datalists) return;
    const fill = (id, values) => {
      const dl = this._datalists[id];
      if (!dl) return;
      dl.innerHTML = "";
      for (const v of values ?? []) dl.append(new Option(v));
    };
    fill("dl-company", this.fieldValues?.company);
    fill("dl-role", this.fieldValues?.role);
    fill("dl-gender", [...new Set([...(PRESET_VALUES.gender ?? []), ...(this.fieldValues?.gender ?? [])])]);
    // Location: the bundled city list first, then any values already in the DB.
    fill("dl-location", [...new Set([...CITIES, ...(this.fieldValues?.location ?? [])])]);
    fill("dl-alltags", this.context?.allTags);
  }

  // ------------------------------------------------------------------ view --
  render() {
    const { contact } = this;
    const { neighbors, interactions, tags } = this.context;
    let p = this.panel;
    p.innerHTML = "";
    this.appendClose(p);
    this.buildDatalists(p);

    // --- identity ---
    const head = el("div", "card-head");
    const avatar = el("div", "avatar", initials(contact.name));
    avatar.style.background = orgColor(contact.fields.company);
    const idBlock = el("div", "card-id");
    const nameRow = el("h2", "card-name");
    const star = el("button", "star-btn", contact.starred ? "★" : "☆");
    star.type = "button";
    star.title = contact.starred ? "Unstar" : "Star (pinned in the palette)";
    star.addEventListener("click", () => this.toggleStar());
    const nameText = el("span", "editable-text", contact.name);
    nameText.title = "Click to rename";
    nameText.addEventListener("click", () => this.editName(nameText));
    nameRow.append(star, nameText);
    idBlock.append(nameRow);

    const sub = [contact.fields.role, contact.fields.company].filter(Boolean).join(" · ");
    if (sub) idBlock.append(el("p", "card-sub", sub));

    const lastAt = interactions[0]?.occurredAt ?? null;
    const recencyBits = [lastAt ? `last touch ${Math.floor((Date.now() - lastAt) / 86400000)}d ago` : "no interactions yet"];
    if (contact.cadenceDays && (!lastAt || Date.now() - lastAt > contact.cadenceDays * 86400000)) recencyBits.push("overdue");
    const recency = el("p", "card-sub mono", recencyBits.join(" · "));
    if (recencyBits.includes("overdue")) recency.classList.add("overdue");
    idBlock.append(recency);

    const chain = this.handlers.getIntroChain(contact.id);
    if (chain.length) {
      const line = el("p", "card-sub dim", `introduced by ${chain.map((c) => c.name).join(" ← ")}`);
      // Spell the chain out on hover: "A introduced them; B introduced A; …"
      const names = [contact.name, ...chain.map((c) => c.name)];
      line.title = names.slice(1).map((n, i) => `${n} introduced ${names[i]}`).join("; ");
      idBlock.append(line);
    }
    head.append(avatar, idBlock);
    p.append(head);
    // Arriving from "add a connection": drop straight into renaming the new node.
    if (this.context.startRename) {
      this.context.startRename = false;
      this.editName(nameText);
    }

    // --- actions (no more separate Edit mode) ---
    const actions = el("div", "card-actions");
    const mkBtn = (label, cls, fn) => {
      const b = el("button", cls, label);
      b.type = "button";
      b.addEventListener("click", fn);
      actions.append(b);
    };
    mkBtn(this.depth === 1 ? "2 hops" : "1 hop", null, () => {
      this.depth = this.depth === 1 ? 2 : 1;
      this.handlers.onDepthChange(this.depth);
    });
    mkBtn("Link…", null, () => this.handlers.onAddRelationship(contact));
    mkBtn("Add connection ▾", null, (e) =>
      this.handlers.onAddConnection(contact, /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect()));
    // Delete as a trash icon (same glyph as the per-connection delete).
    const delBtn = el("button", "card-del");
    delBtn.type = "button";
    delBtn.title = `Delete ${contact.name}`;
    delBtn.setAttribute("aria-label", `Delete ${contact.name}`);
    const delIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    delIcon.setAttribute("viewBox", "0 0 24 24");
    delIcon.setAttribute("aria-hidden", "true");
    const delUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
    delUse.setAttribute("href", "#nav-trash");
    delIcon.append(delUse);
    delBtn.append(delIcon);
    delBtn.addEventListener("click", () => this.handlers.onDelete(contact));
    actions.append(delBtn);
    p.append(actions);

    // Everything below the action row scrolls; the identity + actions stay pinned.
    const body = el("div", "card-scroll");
    p.append(body);
    p = body;

    // --- gender first: the first field worth setting (it drives the kinship
    // options below), so it sits at the very top and commits on selection. ---
    const genderRow = el("div", "form-row");
    genderRow.append(el("label", null, "Gender"));
    const gsel = el("select");
    gsel.append(new Option("—", ""));
    for (const g of (PRESET_VALUES.gender ?? ["Female", "Male"])) gsel.append(new Option(g, g));
    const gv = contact.fields.gender ?? "";
    if (gv && !(PRESET_VALUES.gender ?? []).includes(gv)) gsel.append(new Option(gv, gv));
    gsel.value = gv;
    gsel.addEventListener("change", () => this.saveField("gender", gsel.value));
    genderRow.append(gsel);
    p.append(genderRow);

    // --- relationship editor (breadcrumb): editable when you arrived here
    // from another contact. Relationships are pairwise, so this edits the edge
    // between this contact and the one you came from. ---
    const relFrom = this.context.relFrom;
    if (relFrom && relFrom.edge) {
      const edge = relFrom.edge;
      // Re-select preserving the breadcrumb so the editor stays open, and
      // refresh the graph so edge colours / hover text reflect the change.
      const reload = () => this.handlers.onRelChanged(contact.id, relFrom.id, relFrom.name);

      const relRow = el("div", "form-row rel-row");
      relRow.append(el("label", null, `Relationship to ${relFrom.name}`));
      const sel = el("select");
      for (const t of EDGE_TYPES) {
        const opt = new Option(t, t);
        opt.style.color = EDGE_COLORS[t] ?? "";
        sel.append(opt);
      }
      if (!EDGE_TYPES.includes(edge.type)) sel.append(new Option(edge.type, edge.type));
      sel.value = edge.type;
      sel.style.color = EDGE_COLORS[edge.type] ?? "";
      sel.addEventListener("change", async () => {
        const newType = sel.value;
        const meta = { ...(edge.metadata || {}) };
        // Leaving family: drop both kinship entries so they don't linger.
        if (newType !== "family" && meta.kin) {
          const kin = { ...meta.kin };
          delete kin[relFrom.id];
          delete kin[contact.id];
          if (Object.keys(kin).length) meta.kin = kin; else delete meta.kin;
        }
        try {
          await window.api.edges.update({
            sourceId: edge.sourceId, targetId: edge.targetId,
            type: edge.type, newType, metadata: meta,
          });
          reload();
        } catch (err) {
          sel.value = edge.type;
          toastError(err);
        }
      });
      relRow.append(sel);
      p.append(relRow);

      // Kinship sub-picker: for family edges, capture the specific relation.
      // Describes THIS contact relative to relFrom ("‹this contact› is ‹them›'s…"),
      // by this contact's gender. Setting it also records the reciprocal (their
      // role toward this contact, by their gender) so both sides read correctly.
      if (edge.type === "family") {
        const firstName = (n) => String(n || "").split(/\s+/)[0];
        const roles = kinRolesFor(contact.fields.gender);
        const curRole = (edge.metadata && edge.metadata.kin && edge.metadata.kin[contact.id]) || "";
        const kinRow = el("div", "form-row rel-row");
        kinRow.append(el("label", null, `${firstName(contact.name)} is ${firstName(relFrom.name)}'s…`));
        const kinSel = el("select");
        kinSel.append(new Option("(unspecified)", ""));
        for (const r of roles) kinSel.append(new Option(r, r));
        if (curRole && !roles.includes(curRole)) kinSel.append(new Option(curRole, curRole));
        kinSel.value = curRole;
        // Live both-direction preview so a reversed role is obvious before saving.
        const preview = el("div", "kin-preview mono dim");
        const renderPreview = () => {
          preview.textContent = kinPreview({
            selfName: contact.name, otherName: relFrom.name,
            role: kinSel.value, otherGender: relFrom.gender,
          });
          preview.hidden = !kinSel.value;
        };
        renderPreview();
        kinSel.addEventListener("change", async () => {
          renderPreview();
          const meta = { ...(edge.metadata || {}) };
          const kin = { ...(meta.kin || {}) };
          if (kinSel.value) {
            kin[contact.id] = kinSel.value;
            // Reciprocal: their role toward this contact, by their gender.
            const recip = reciprocalRole(kinSel.value, relFrom.gender);
            if (recip) kin[relFrom.id] = recip; else delete kin[relFrom.id];
          } else {
            delete kin[contact.id];
            delete kin[relFrom.id];
          }
          if (Object.keys(kin).length) meta.kin = kin; else delete meta.kin;
          try {
            await window.api.edges.update({
              sourceId: edge.sourceId, targetId: edge.targetId, type: edge.type, metadata: meta,
            });
            reload();
          } catch (err) {
            kinSel.value = curRole;
            renderPreview();
            toastError(err);
          }
        });
        kinRow.append(kinSel);
        p.append(kinRow, preview);
      }
    }

    // --- location/address (exact input + separately stored resolution) ---
    const locRow = el("div", "form-row");
    locRow.append(el("label", null, "Location / address"));
    const locInput = /** @type {HTMLInputElement} */ (el("input"));
    locInput.type = "text";
    locInput.placeholder = "City, neighborhood, or full address";
    locInput.autocomplete = "off";
    locInput.setAttribute("role", "combobox");
    locInput.setAttribute("aria-autocomplete", "list");
    locInput.setAttribute("aria-expanded", "false");
    locInput.value = contact.fields.location ?? "";
    const locWrap = el("div", "location-input-wrap");
    const locMenu = el("div", "location-suggestions");
    locMenu.id = `location-suggestions-${contact.id}`;
    locMenu.setAttribute("role", "listbox");
    locMenu.hidden = true;
    locInput.setAttribute("aria-controls", locMenu.id);
    locWrap.append(locInput, locMenu);
    const locMatches = new Map(); // full suggestion label -> structured result
    let suggestions = [];
    let activeSuggestion = -1;
    const locHint = el("p", "field-hint location-resolution");
    const showResolution = (fields, state = "") => {
      if (state) {
        locHint.className = "field-hint location-resolution dim mono";
        locHint.textContent = state;
      } else if (fields.geo) {
        const precision = fields.locationPrecision || "mapped";
        locHint.className = "field-hint location-resolution is-mapped";
        locHint.textContent = `● mapped · ${precision}${fields.place && fields.place !== fields.location ? ` · ${fields.place}` : ""}`;
      } else if (fields.location) {
        locHint.className = "field-hint location-resolution dim";
        locHint.textContent = "○ saved as entered · not mapped";
      } else {
        locHint.textContent = "";
      }
      locHint.hidden = !locHint.textContent;
    };
    showResolution(contact.fields);

    const applyMatch = (fields, match) => {
      fields.geo = `${match.lat},${match.lon}`;
      fields.place = match.place || match.label;
      fields.locationPrecision = match.precision || "place";
      fields.locationSource = match.source || "photon";
      fields.locationResolved = JSON.stringify({ v: 1, components: match.components || {}, osm: match.osm });
    };
    const hideSuggestions = () => {
      locMenu.hidden = true;
      locInput.setAttribute("aria-expanded", "false");
      locInput.removeAttribute("aria-activedescendant");
      activeSuggestion = -1;
    };
    const renderSuggestions = (matches) => {
      suggestions = matches.slice(0, 8);
      locMenu.innerHTML = "";
      activeSuggestion = -1;
      for (const [index, match] of suggestions.entries()) {
        const option = el("button", "location-suggestion");
        option.type = "button";
        option.id = `${locMenu.id}-${index}`;
        option.setAttribute("role", "option");
        const text = el("span", "location-suggestion-label", match.label);
        const kind = el("span", "location-suggestion-kind", match.precision || "place");
        option.append(text, kind);
        option.addEventListener("mousedown", (e) => e.preventDefault());
        option.addEventListener("click", () => chooseSuggestion(index));
        locMenu.append(option);
      }
      locMenu.hidden = suggestions.length === 0;
      locInput.setAttribute("aria-expanded", String(suggestions.length > 0));
    };
    const showSuggestionMessage = (message) => {
      suggestions = []; activeSuggestion = -1;
      locMenu.innerHTML = "";
      locMenu.append(el("div", "location-suggestion-message dim", message));
      locMenu.hidden = false;
      locInput.setAttribute("aria-expanded", "false");
    };
    const setActiveSuggestion = (index) => {
      if (!suggestions.length) return;
      activeSuggestion = (index + suggestions.length) % suggestions.length;
      [...locMenu.children].forEach((node, i) => {
        node.classList.toggle("active", i === activeSuggestion);
        node.setAttribute("aria-selected", String(i === activeSuggestion));
      });
      const active = locMenu.children[activeSuggestion];
      if (active) {
        locInput.setAttribute("aria-activedescendant", active.id);
        active.scrollIntoView({ block: "nearest" });
      }
    };
    const saveLoc = async () => {
      const v = locInput.value.trim();
      if (v === (contact.fields.location ?? "") && contact.fields.geo) return;
      const fields = { ...contact.fields };
      if (v) fields.location = v; else delete fields.location;
      let match = locMatches.get(v);
      if (!match && CITY_COORDS[v]) {
        match = { label: v, place: v, lat: CITY_COORDS[v][0], lon: CITY_COORDS[v][1], precision: "city", source: "offline-city", components: {} };
      }
      // A user may type a complete address and press Enter without selecting a
      // suggestion. Resolve it, but keep `location` exactly as typed.
      if (!match && v && navigator.onLine) {
        await this._locOnlineReady;
        if (this._locOnline) {
          showResolution(fields, "resolving address…");
          try { match = (await window.api.location.search({ query: v }))?.[0]; } catch { /* preserve free text */ }
        }
      }
      if (match) applyMatch(fields, match);
      else for (const key of ["geo", "place", "locationPrecision", "locationSource", "locationResolved"]) delete fields[key];
      try {
        await window.api.contacts.update({ id: contact.id, patch: { fields } });
        contact.fields = fields;
        showResolution(fields);
        this.notifyChanged();
      } catch (err) {
        showResolution(contact.fields);
        toastError(err);
      }
    };
    const chooseSuggestion = (index) => {
      const match = suggestions[index];
      if (!match) return;
      locMatches.set(match.label, match);
      locInput.value = match.label;
      hideSuggestions();
      saveLoc();
    };
    locInput.addEventListener("change", saveLoc); // fires on blur + on datalist pick
    locInput.addEventListener("blur", () => setTimeout(hideSuggestions, 120));
    locInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && suggestions.length && !locMenu.hidden) {
        e.preventDefault(); setActiveSuggestion(activeSuggestion + 1);
      } else if (e.key === "ArrowUp" && suggestions.length && !locMenu.hidden) {
        e.preventDefault(); setActiveSuggestion(activeSuggestion < 0 ? suggestions.length - 1 : activeSuggestion - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (!locMenu.hidden && activeSuggestion >= 0) chooseSuggestion(activeSuggestion);
        else { hideSuggestions(); locInput.blur(); }
      } else if (e.key === "Escape") {
        e.preventDefault(); hideSuggestions();
      }
    });
    // Show bundled results immediately; merge richer online address results
    // after the debounced lookup completes.
    let locTimer = null;
    let locQuery = 0;
    locInput.addEventListener("input", () => {
      const q = locInput.value.trim();
      const queryId = ++locQuery;
      if (locTimer) clearTimeout(locTimer);
      if (q.length < 2) { hideSuggestions(); return; }
      const needle = q.toLocaleLowerCase();
      const local = CITIES
        .filter((name) => CITY_COORDS[name] && name.toLocaleLowerCase().includes(needle))
        .slice(0, 8)
        .map((label) => ({ label, place: label, lat: CITY_COORDS[label][0], lon: CITY_COORDS[label][1], precision: "city", source: "offline-city", components: {} }));
      for (const match of local) locMatches.set(match.label, match);
      if (local.length) renderSuggestions(local);
      else if (this._locOnline && navigator.onLine) showSuggestionMessage("Searching addresses…");
      else showSuggestionMessage("No offline city match · enable online location search for addresses");
      locTimer = setTimeout(async () => {
        if (!navigator.onLine) return; // offline: local results remain visible
        await this._locOnlineReady;
        if (!this._locOnline) return;
        try {
          const matches = await window.api.location.search({ query: q });
          if (queryId !== locQuery) return;
          const merged = [...(matches || []), ...local].filter((match, index, all) =>
            all.findIndex((other) => other.label.toLocaleLowerCase() === match.label.toLocaleLowerCase()) === index
          );
          for (const match of merged) locMatches.set(match.label, match);
          if (merged.length) renderSuggestions(merged);
          else showSuggestionMessage("No matching address found · your text can still be saved");
        } catch { /* offline / disabled: local list stands */ }
      }, 280);
    });
    locRow.append(locWrap);
    p.append(locRow);
    const locMeta = el("div", "location-meta");
    locMeta.append(locHint);
    if (contact.fields.location) {
      const pinBtn = el("button", "location-pin-btn", contact.fields.geo ? "Adjust pin on map" : "Place pin on map");
      pinBtn.type = "button";
      pinBtn.addEventListener("click", async () => {
        let initial = null;
        if (contact.fields.geo) {
          const [lat, lon] = contact.fields.geo.split(",").map(Number);
          if (Number.isFinite(lat) && Number.isFinite(lon)) initial = { lat, lon };
        }
        const point = await pickLocationOnMap(initial, contact.fields.location);
        if (!point) return;
        const fields = { ...contact.fields };
        fields.geo = `${point.lat},${point.lon}`;
        fields.locationPrecision = "manual";
        fields.locationSource = "manual-pin";
        let resolved = { v: 1, components: {} };
        try { resolved = JSON.parse(fields.locationResolved || "") || resolved; } catch { /* legacy/unresolved */ }
        resolved.manualPin = { lat: point.lat, lon: point.lon };
        fields.locationResolved = JSON.stringify(resolved);
        try {
          await window.api.contacts.update({ id: contact.id, patch: { fields } });
          contact.fields = fields;
          showResolution(fields);
          this.notifyChanged();
        } catch (err) { toastError(err); }
      });
      locMeta.append(pinBtn);
    }
    p.append(locMeta);

    // --- cadence (immediate apply) ---
    const cadenceRow = el("div", "form-row");
    cadenceRow.append(el("label", null, "Keep in touch"));
    const cadence = el("select");
    for (const [days, label] of /** @type {[number, string][]} */ ([
      [0, "no reminder"], [30, "monthly"], [90, "quarterly"], [180, "twice a year"], [365, "yearly"],
    ])) cadence.append(new Option(label, String(days)));
    cadence.value = String(contact.cadenceDays ?? 0);
    cadence.addEventListener("change", async () => {
      try {
        await window.api.contacts.update({ id: contact.id, patch: { cadenceDays: parseInt(cadence.value, 10) } });
        this.notifyChanged();
      } catch (err) { toastError(err); }
    });
    cadenceRow.append(cadence);
    p.append(cadenceRow);

    // --- details (click any value to edit in place) ---
    const sec = el("div", "card-section");
    const dHead = el("div", "section-head");
    dHead.append(el("h3", null, "Details"));
    const addBtn = iconBtn("+", "inline-add-btn", "Add field");
    addBtn.addEventListener("click", () => this.addFieldInline(sec, addBtn));
    dHead.append(addBtn);
    sec.append(dHead);
    // Gender + Location have their own rows above, so Details holds the rest.
    const skip = (k) => k === "notes" || k === "gender" || k === "location" || k === "geo" || k === "place"
      || k === "locationPrecision" || k === "locationSource" || k === "locationResolved";
    const shownKeys = [
      ...KNOWN_FIELDS.filter((k) => !skip(k) && contact.fields[k]),
      ...Object.keys(contact.fields).filter((k) => !skip(k) && !KNOWN_FIELDS.includes(k)),
    ];
    for (const k of shownKeys) this.makeFieldRow(sec, k, contact.fields[k] ?? "");
    if (!shownKeys.length) sec.append(el("p", "dim empty-hint", "No details yet — click + to add one."));
    p.append(sec);

    // --- notes (click to edit) ---
    const notesSec = el("div", "card-section");
    notesSec.append(el("h3", null, "Notes"));
    this.makeNotesRow(notesSec);
    p.append(notesSec);

    // --- tags (click to edit) ---
    const tagSec = el("div", "card-section");
    const tHead = el("div", "section-head");
    tHead.append(el("h3", null, "Tags"));
    const tagEdit = iconBtn("✎", "inline-edit-btn", "Edit tags");
    tHead.append(tagEdit);
    tagSec.append(tHead);
    const tagView = el("div", "tag-view");
    if (tags.length) for (const t of tags) tagView.append(el("span", "tag-chip", t));
    else tagView.append(el("span", "dim empty-hint", "No tags"));
    tagSec.append(tagView);
    const openTagEditor = () => this.editTags(tagSec, tagView, tHead);
    tagEdit.addEventListener("click", openTagEditor);
    tagView.addEventListener("click", openTagEditor);
    p.append(tagSec);

    // --- connections (collapsible, shown by default) ---
    const conn = el("div", "card-section");
    const cHead = el("div", "section-head collapsible");
    cHead.append(el("h3", null, `Connections · ${neighbors.length}`));
    const chevron = el("span", "collapse-chevron mono", this.connExpanded ? "▾ hide" : "▸ show");
    cHead.append(chevron);
    cHead.addEventListener("click", () => { this.connExpanded = !this.connExpanded; this.render(); });
    conn.append(cHead);

    if (this.connExpanded) {
      const edgeByOther = new Map();
      for (const e of this.context.edges ?? []) {
        const other = e.sourceId === contact.id ? e.targetId : e.sourceId;
        if (!edgeByOther.has(other)) edgeByOther.set(other, e);
      }
      for (const n of neighbors.slice(0, 30)) {
        const row = el("div", "conn-row");
        const open = el("button", "conn-open");
        open.type = "button";
        open.title = `Open ${n.name}`;
        open.append(el("span", "conn-name-plain", n.name), el("span", "row-sub dim", n.org ?? ""));
        const edge = edgeByOther.get(n.id);
        if (edge) {
          const kinRole = edge.type === "family" && edge.metadata?.kin ? edge.metadata.kin[n.id] : null;
          const lbl = el("span", "conn-rel-label", kinRole || edge.type);
          lbl.style.color = EDGE_COLORS[edge.type] ?? "";
          if (kinRole) lbl.title = `family · ${kinRole}`;
          open.append(lbl);
        }
        open.append(el("span", "conn-degree mono", `${n.degree}°`));
        row.append(open);
        if (edge) {
          const remove = el("button", "conn-delete");
          remove.type = "button";
          remove.title = `Delete connection to ${n.name}`;
          remove.setAttribute("aria-label", `Delete connection to ${n.name}`);
          const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          icon.setAttribute("viewBox", "0 0 24 24");
          icon.setAttribute("aria-hidden", "true");
          const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
          use.setAttribute("href", "#nav-trash");
          icon.append(use);
          remove.append(icon);
          remove.addEventListener("click", async () => {
            const relation = edge.type === "family" && edge.metadata?.kin?.[n.id]
              ? edge.metadata.kin[n.id]
              : edge.type;
            const yes = await confirmModal({
              title: "Delete connection?",
              message: `Delete the ${relation} connection between ${contact.name} and ${n.name}? Neither contact will be deleted.`,
              confirmLabel: "Delete connection",
              danger: true,
            });
            if (!yes) return;
            remove.disabled = true;
            try {
              await this.handlers.onDeleteConnection(edge, n);
            } catch (err) {
              remove.disabled = false;
              toastError(err);
            }
          });
          row.append(remove);
        }
        row.addEventListener("mouseenter", () => this.handlers.onHighlightConnection(n.id));
        row.addEventListener("mouseleave", () => this.handlers.onHighlightConnection(null));
        open.addEventListener("click", () => this.handlers.onNavigate(n.id));
        conn.append(row);
      }
      if (neighbors.length > 30) conn.append(el("p", "mono dim", `+ ${neighbors.length - 30} more in the graph`));
    } else {
      conn.append(el("p", "mono dim empty-hint", "collapsed · click to show · hover a row to highlight it on the graph"));
    }
    // Connections render last (appended after the timeline below).

    // --- timeline + quick log ---
    const timeline = el("div", "card-section");
    timeline.append(el("h3", null, "Timeline"));
    const logRow = el("div", "form-row");
    const kind = el("select");
    for (const k of ["note", "call", "email", "meeting"]) kind.append(new Option(k, k));
    const note = el("input");
    note.type = "text";
    note.placeholder = "Log an interaction…";
    const logBtn = el("button", null, "Log");
    logBtn.type = "button";
    const submitLog = async () => {
      try {
        await window.api.interactions.add({
          contactId: contact.id, occurredAt: Date.now(), kind: kind.value, note: note.value.trim() || undefined,
        });
        note.value = "";
        this.notifyChanged();
      } catch (err) { toastError(err); }
    };
    logBtn.addEventListener("click", submitLog);
    note.addEventListener("keydown", (e) => { if (e.key === "Enter") submitLog(); });
    logRow.append(kind, note, logBtn);
    timeline.append(logRow);
    if (!interactions.length) timeline.append(el("p", "dim", "No interactions logged yet."));
    for (const i of interactions.slice(0, 20)) {
      const row = el("div", "timeline-row");
      row.append(el("span", "timeline-when mono", fmtDate(i.occurredAt)), el("span", null, [i.kind, i.note].filter(Boolean).join(" · ") || "interaction"));
      timeline.append(row);
    }
    p.append(timeline);
    p.append(conn); // Connections as the last section (per UX request)
  }

  appendClose(p) {
    const x = iconBtn("✕", "panel-close", "Close panel");
    x.addEventListener("click", () => this.handlers.onClose());
    p.append(x);
  }

  async toggleStar() {
    try {
      await window.api.contacts.update({ id: this.contact.id, patch: { starred: !this.contact.starred } });
      this.notifyChanged();
    } catch (err) { toastError(err); }
  }

  // ---- inline editors ----
  editName(textEl) {
    const row = textEl.parentElement; // the h2.card-name
    const input = el("input", "field-value name-edit");
    input.value = this.contact.name;
    const controls = this.inlineControls(
      async () => {
        const v = input.value.trim();
        if (v === this.contact.name) { this.render(); return; } // unchanged
        if (!v) { this.render(); return; } // empty - keep the existing name
        try {
          await window.api.contacts.update({ id: this.contact.id, patch: { name: v } });
          this.notifyChanged();
        } catch (err) { toastError(err); this.render(); }
      },
      () => this.render()
    );
    textEl.replaceWith(input);
    controls.attachKeys(input);
    row.append(controls.element);
    input.focus();
    input.select();
  }

  makeFieldRow(sec, key, value) {
    // Boolean field (e.g. deceased): a checkbox that toggles + commits inline.
    // Unchecking clears the field, so it only appears once marked.
    if (fieldType(key) === "bool") {
      const row = el("div", "field-row bool-row");
      const label = el("label", "bool-field");
      const cb = /** @type {HTMLInputElement} */ (el("input", "field-check"));
      cb.type = "checkbox";
      cb.checked = /^(yes|true|1)$/i.test(value ?? "");
      cb.addEventListener("change", () => this.saveField(key, cb.checked ? "yes" : ""));
      label.append(cb, el("span", "field-key mono", key));
      row.append(label);
      sec.append(row);
      return;
    }
    const row = el("div", "field-row editable");
    const renderText = () => {
      row.innerHTML = "";
      row.classList.remove("editing");
      const valEl = el("span", "field-val editable-text", value || "—");
      valEl.title = "Click to edit";
      row.append(el("span", "field-key mono", key), valEl);
      valEl.addEventListener("click", renderEditor);
    };
    const renderEditor = () => {
      row.innerHTML = "";
      row.classList.add("editing");
      const ctrl = createControl(key, value, this.fieldValues);
      const err = el("div", "field-err");
      err.hidden = true;
      const commit = async () => {
        const v = ctrl.read();
        if (v === (value || "")) { renderText(); return; } // unchanged
        const msg = validateField(fieldType(key), v);
        if (msg) { err.textContent = msg; err.hidden = false; ctrl.setInvalid(true); return false; }
        await this.saveField(key, v);
      };
      row.append(el("span", "field-key mono edit-label", key), ctrl.element);
      if (ctrl.isSelect) {
        // Dropdown: the picked option is the value - commit immediately, no ✓/✗.
        ctrl.element.addEventListener("change", () => commit());
        ctrl.element.addEventListener("keydown", (/** @type {any} */ e) => { if (e.key === "Escape") renderText(); });
      } else {
        const controls = this.inlineControls(commit, renderText, () => this.saveField(key, "")); // remove
        row.append(controls.element);
        // Multiline (notes) commits on blur but keeps Enter for newlines.
        controls.attachKeys(ctrl.element, { enter: !ctrl.multiline });
      }
      row.append(err);
      ctrl.focus();
    };
    renderText();
    sec.append(row);
  }

  addFieldInline(sec, addBtn) {
    const wrap = el("div", "add-field");
    const row = el("div", "field-row editing");
    const keyInput = el("input", "edit-key");
    keyInput.placeholder = "field name";
    const state = { ctrl: createControl("", "", this.fieldValues) };
    const controls = this.inlineControls(
      async () => {
        const key = keyInput.value.trim().toLowerCase();
        const v = state.ctrl.read();
        if (!key || !v) { keyInput.classList.toggle("invalid", !key); return false; }
        const msg = validateField(fieldType(key), v);
        if (msg) { state.ctrl.setInvalid(true); return false; }
        await this.saveField(key, v);
      },
      () => wrap.remove()
    );
    const onKey = (/** @type {any} */ e) => {
      if (e.key === "Enter") { e.preventDefault(); controls.apply(); }
      else if (e.key === "Escape") { e.preventDefault(); wrap.remove(); }
    };
    const rebuildControl = () => {
      const next = createControl(keyInput.value.trim(), state.ctrl.read(), this.fieldValues);
      next.element.addEventListener("keydown", onKey);
      if (next.isBool) next.element.addEventListener("change", () => controls.apply()); // toggle commits
      row.replaceChild(next.element, state.ctrl.element);
      state.ctrl = next;
    };
    keyInput.addEventListener("keydown", onKey);
    state.ctrl.element.addEventListener("keydown", onKey);
    keyInput.addEventListener("input", rebuildControl);

    // Quick-pick standard fields (expandable) - click to prefill the name.
    const presets = el("div", "field-presets mono");
    presets.append(el("span", "dim", "standard:"));
    for (const key of STANDARD_FIELDS.filter((k) => !this.contact.fields[k])) {
      const chip = el("button", "preset-chip", key);
      chip.type = "button";
      chip.addEventListener("mousedown", (e) => e.preventDefault()); // don't blur/commit
      chip.addEventListener("click", () => {
        keyInput.value = key;
        rebuildControl();
        state.ctrl.focus();
      });
      presets.append(chip);
    }

    // Atomic: commit when focus leaves the whole block; abandon if left empty.
    wrap.addEventListener("focusout", (e) => {
      if (wrap.contains(/** @type {Node} */ (e.relatedTarget))) return;
      if (!keyInput.value.trim() && !state.ctrl.read()) wrap.remove();
      else controls.apply();
    });
    row.append(keyInput, state.ctrl.element, controls.element);
    wrap.append(presets, row);
    sec.insertBefore(wrap, addBtn.closest(".section-head").nextSibling);
    keyInput.focus();
  }

  makeNotesRow(sec) {
    const notes = this.contact.fields.notes || "";
    const renderText = () => {
      const view = el("p", "dim editable-text notes-view", notes || "Click to add notes…");
      view.addEventListener("click", () => {
        view.replaceWith(editorEl());
      });
      return view;
    };
    const editorEl = () => {
      const wrap = el("div", "notes-edit");
      const ctrl = createControl("notes", notes, this.fieldValues);
      const controls = this.inlineControls(
        () => { if (ctrl.read() === notes) { wrap.replaceWith(renderText()); return; } this.saveField("notes", ctrl.read()); },
        () => { wrap.replaceWith(renderText()); }
      );
      wrap.append(ctrl.element, controls.element);
      controls.attachKeys(ctrl.element, { enter: false }); // blur commits; Enter = newline
      setTimeout(() => ctrl.focus(), 0);
      return wrap;
    };
    sec.append(renderText());
  }

  editTags(tagSec, tagView, head) {
    // Guard re-entry: the pencil keeps its listener after the view is swapped,
    // so a second click would append another editor + controls cluster.
    if (tagSec.querySelector(".chip-input")) return;
    const box = el("div", "chip-input");
    const tagSet = new Set(this.context.tags);
    const input = el("input");
    input.type = "text";
    input.placeholder = "add tag + Enter";
    input.setAttribute("list", "dl-alltags");
    const renderChips = () => {
      box.querySelectorAll(".chip").forEach((c) => c.remove());
      for (const t of tagSet) {
        const chip = el("span", "chip", t);
        const rm = iconBtn("✕", null, "Remove tag");
        rm.addEventListener("mousedown", (e) => e.preventDefault()); // don't blur the input
        rm.addEventListener("click", () => { tagSet.delete(t); renderChips(); });
        chip.append(rm);
        box.insertBefore(chip, input);
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        e.preventDefault();
        tagSet.add(input.value.trim().toLowerCase());
        input.value = "";
        renderChips();
      }
    });
    box.append(input);
    renderChips();
    const controls = this.inlineControls(
      async () => {
        // Fold a half-typed tag in before saving.
        if (input.value.trim()) { tagSet.add(input.value.trim().toLowerCase()); input.value = ""; }
        try {
          await window.api.contacts.setTags({ id: this.contact.id, tags: [...tagSet] });
          this.notifyChanged();
        } catch (err) { toastError(err); }
      },
      () => this.render()
    );
    // Atomic: commit when focus leaves the chip box entirely.
    box.addEventListener("focusout", (e) => {
      if (!box.contains(/** @type {Node} */ (e.relatedTarget))) controls.apply();
    });
    tagView.replaceWith(box);
    tagSec.append(controls.element);
    input.focus();
  }

  /** Apply (✓) / cancel (✕) [/ remove (🗑)] control cluster. */
  inlineControls(onApply, onCancel, onRemove) {
    const wrap = el("div", "inline-controls");
    let done = false; // one-shot: a successful commit re-renders, so guard re-entry
    const apply = async () => {
      if (done) return;
      done = true;
      const r = await onApply();
      if (r === false) done = false; // validation failed - let the user retry
    };
    const cancel = () => { if (done) return; done = true; onCancel(); };
    const remove = () => { if (done) return; done = true; onRemove(); };
    // Atomic editing: Enter / blur commits, Esc cancels - no ✓ needed. The ✕
    // (cancel) and 🗑 (remove) buttons stay; mousedown-preventDefault stops them
    // from blurring the field first (which would auto-commit instead).
    const cancelBtn = iconBtn("✕", "inline-cancel", "Cancel (Esc)");
    cancelBtn.addEventListener("mousedown", (e) => e.preventDefault());
    cancelBtn.addEventListener("click", cancel);
    wrap.append(cancelBtn);
    if (onRemove) {
      const del = iconBtn("🗑", "inline-remove", "Remove");
      del.addEventListener("mousedown", (e) => e.preventDefault());
      del.addEventListener("click", remove);
      wrap.append(del);
    }
    return {
      element: wrap,
      apply,
      attachKeys: (input, { enter = true } = {}) => {
        input.addEventListener("keydown", (e) => {
          if (enter && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); apply(); }
          else if (e.key === "Escape") { e.preventDefault(); cancel(); }
        });
        input.addEventListener("blur", () => apply());
      },
    };
  }
}
