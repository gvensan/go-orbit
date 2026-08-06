// card.js - the contact detail side panel (APP_SHELL_UX §3). The card is a
// read-only "simple view" by default; clicking any value (name, a field, notes,
// tags) turns THAT item into an in-place editor with apply (✓) / cancel (✕)
// controls. Each edit saves just its own field. Cadence and star apply
// immediately. Delete is undo-first.

import { CITIES, CITY_COORDS } from "../shared/cities.js";
import { PRESET_VALUES, fieldType, validateField, normalizeFieldValue } from "../shared/field-types.js";
import { BUSINESS_TYPES } from "../shared/relationships.js";
import { EDGE_COLORS, EDGE_TYPES, initials, kinPreview, kinRolesFor, orgColor, reciprocalRole } from "./colors.js";
import { confirmModal, el } from "./modal.js";
import { pickLocationOnMap } from "./location-picker.js";
import { createControl, applyLocationMatch, clearLocationResolution } from "./field-controls.js";
import { toast, toastError } from "./toast.js";

// gender leads the details: it's the first thing worth setting (it drives the
// kinship options), then the rest.
const KNOWN_FIELDS = ["gender", "location", "email", "phone", "company", "role", "notes"];
// Standard fields offered as quick-pick chips under "+ Add field" (expandable).
const STANDARD_FIELDS = ["deceased", "business", "birthday", "nickname", "address", "website", "linkedin"];
/** A vendor/shop/service rather than a person: no gender, no kinship. */
const isBusiness = (contact) => /^(yes|true|1)$/i.test(String(contact?.fields?.business ?? ""));
const fmtDate = (ts) =>
  new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const iconBtn = (glyph, cls, title) => {
  const b = el("button", cls, glyph);
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  return b;
};

// The value controls (email/date/url inputs, datalists, notes textarea, the
// phone country widget) live in field-controls.js, shared with Explore's
// inline cell editor so the two write identical shapes.

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
    // Same canonical form the import pipeline writes (trim, "f" -> "Female",
    // truthy flags -> "yes"), so hand-typed and imported values never drift.
    value = normalizeFieldValue(key, value);
    const fields = { ...this.contact.fields };
    if (value) fields[key] = value;
    else delete fields[key];
    // A business has no gender. Turning the flag on also drops any gender left
    // from when this contact was a person - otherwise the card stops showing it
    // while Explore, the gender legend and exports still count it.
    if (key === "business" && value) delete fields.gender;
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
    recency.title = recencyBits.includes("overdue")
      ? `It has been longer than the keep-in-touch cadence of ${contact.cadenceDays} days since the last logged interaction`
      : "Time since the last interaction logged in the timeline below";
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
    const mkBtn = (label, cls, fn, title) => {
      const b = el("button", cls, label);
      b.type = "button";
      if (title) b.title = title;
      b.addEventListener("click", fn);
      actions.append(b);
    };
    mkBtn(this.depth === 1 ? "2 hops" : "1 hop", null, () => {
      this.depth = this.depth === 1 ? 2 : 1;
      this.handlers.onDepthChange(this.depth);
    }, this.depth === 1
      ? `Widen the graph to everyone within two steps of ${contact.name}`
      : `Narrow the graph back to ${contact.name}'s direct connections`);
    mkBtn("Link…", null, () => this.handlers.onAddRelationship(contact),
      `Connect ${contact.name} to a contact you already have`);
    mkBtn("Add connection ▾", null, (e) =>
      this.handlers.onAddConnection(contact, /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect()),
      `Create a brand new contact already connected to ${contact.name}`);
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
    // options below), so it sits at the very top and commits on selection.
    // A business has no gender, so the row is replaced by the business marker. ---
    // Flagged explicitly, or derived: a contact whose every tie is a business
    // type (vendor) IS a business - never ask it for a gender.
    const flagged = isBusiness(contact);
    const cardEdges = this.context?.edges ?? [];
    // Mirrors the snapshot rule: vendor-only ties make a business, but a
    // recorded gender (or being the owner) keeps a contact a person.
    const derived = !flagged && !contact.fields.gender && !contact.isOwner
      && cardEdges.length > 0 && cardEdges.every((e) => BUSINESS_TYPES.has(e.type));
    const business = flagged || derived;
    if (business) {
      const bizRow = el("div", "form-row");
      bizRow.append(el("label", null, "Kind"));
      const bwrap = el("div", "biz-kind");
      const bizTag = el("span", "biz-tag mono", "business");
      bizTag.title = "Treated as a vendor or shop, not a person: no gender ring and no kinship";
      bwrap.append(bizTag);
      if (flagged) {
        const undo = el("button", "biz-undo", "Not a business");
        undo.type = "button";
        undo.title = "Treat this contact as a person again";
        undo.addEventListener("click", () => this.saveField("business", ""));
        bwrap.append(undo);
      } else {
        const hint = el("span", "field-hint dim mono", "all ties are vendor");
        hint.title = "Change a connection's type to treat this contact as a person";
        bwrap.append(hint);
      }
      bizRow.append(bwrap);
      p.append(bizRow);
    } else {
      const genderRow = el("div", "form-row");
      genderRow.append(el("label", null, "Gender"));
      const gsel = el("select");
      gsel.title = "Sets the ring colour on the graph and the kinship terms offered below. Saves as soon as you pick";
      gsel.append(new Option("—", ""));
      for (const g of (PRESET_VALUES.gender ?? ["Female", "Male"])) gsel.append(new Option(g, g));
      const gv = contact.fields.gender ?? "";
      if (gv && !(PRESET_VALUES.gender ?? []).includes(gv)) gsel.append(new Option(gv, gv));
      gsel.value = gv;
      gsel.addEventListener("change", () => this.saveField("gender", gsel.value));
      genderRow.append(gsel);
      p.append(genderRow);
    }

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
      sel.title = `How ${contact.name} and ${relFrom.name} are connected. This sets the link's colour on the graph`;
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
        kinSel.title = "The exact family role. Choosing one also records the matching role in the other direction, so both cards read correctly";
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
    locInput.title = "Type a place and pick a suggestion to put this contact on the map. Your text is kept exactly as entered either way";
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

    const applyMatch = applyLocationMatch; // shared with Explore's inline editor
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
        option.title = `Map to ${match.label} at ${match.precision || "place"} level`;
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
      else clearLocationResolution(fields);
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
      pinBtn.title = contact.fields.geo
        ? "Drag the pin to the exact spot. The location text above stays as you wrote it"
        : "Pick the exact spot on the map. The location text above stays as you wrote it";
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
    cadence.title = "How often you mean to be in touch. Going longer than this marks the contact overdue in Insights and on the graph";
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
    const addBtn = iconBtn("+", "inline-add-btn", "Add a field: pick a standard one or type your own name");
    addBtn.addEventListener("click", () => this.addFieldInline(sec, addBtn));
    dHead.append(addBtn);
    sec.append(dHead);
    // Gender + Location have their own rows above, so Details holds the rest.
    const skip = (k) => k === "notes" || k === "gender" || k === "location" || k === "geo" || k === "place"
      || k === "locationPrecision" || k === "locationSource" || k === "locationResolved";
    // Details lists only fields that HAVE values (a sparse contact stays a
    // short card); the FULL supported catalog - core channels and the
    // standard extras alike - is one click away as quick-pick chips under
    // "+ Add field" (see addFieldInline), so nothing is undiscoverable.
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
    const tagEdit = iconBtn("✎", "inline-edit-btn", "Edit tags. Tags are searchable and filterable in Explore");
    tHead.append(tagEdit);
    tagSec.append(tHead);
    const tagView = el("div", "tag-view");
    tagView.title = "Click to edit. Tags are searchable and filterable in Explore";
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
    cHead.title = this.connExpanded
      ? "Hide the connection list. Hovering a row highlights that person on the graph"
      : "Show who this contact is connected to";
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
        const deg = el("span", "conn-degree mono", `${n.degree}°`);
        deg.title = `${n.name} has ${n.degree} connection${n.degree === 1 ? "" : "s"}`;
        open.append(deg);
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
    kind.title = "What kind of interaction this was";
    for (const k of ["note", "call", "email", "meeting"]) kind.append(new Option(k, k));
    const note = el("input");
    note.type = "text";
    note.placeholder = "Log an interaction…";
    note.title = "Optional note. Press Enter to log it, dated today";
    const logBtn = el("button", null, "Log");
    logBtn.type = "button";
    logBtn.title = `Record an interaction with ${contact.name} today. This resets their keep-in-touch clock`;
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
      label.title = `Turn ${key} on or off. Clearing it removes the field entirely`;
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
    keyInput.title = "Pick a standard field below, or type any name of your own";
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

    // Quick-pick chips: the FULL supported catalog (core channels + standard
    // extras), minus whatever this contact already has - so every field the
    // app supports is reachable from here even though Details lists only set
    // ones. Free-typing a custom name still works.
    const presets = el("div", "field-presets mono");
    presets.append(el("span", "dim", "standard:"));
    const SUPPORTED = [...KNOWN_FIELDS.filter((k) => !["gender", "location", "notes"].includes(k)), ...STANDARD_FIELDS];
    for (const key of SUPPORTED.filter((k) => !this.contact.fields[k])) {
      const chip = el("button", "preset-chip", key);
      chip.type = "button";
      chip.title = `Add a ${key} field`;
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
      view.title = "Click to edit. Notes are searchable and saved when you click away";
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
    input.title = "Type a tag and press Enter. Click away to save the whole set";
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
