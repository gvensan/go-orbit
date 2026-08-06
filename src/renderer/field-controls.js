// field-controls.js - THE field editors. One implementation shared by the
// contact card and Explore's inline cells, so a phone typed in either place
// gets the same country picker and lands as the same "+<dial> <grouped>"
// string, dates get the same picker, gender the same preset list, and a typed
// location resolves through the same offline-city-then-geocoder pipeline.
// Moved out of card.js verbatim when Explore gained in-place editing.

import { COUNTRIES, flagEmoji, parsePhone, dialOf, groupNational } from "../shared/countries.js";
import { CITIES, CITY_COORDS } from "../shared/cities.js";
import { AUTOCOMPLETE_FIELDS, PRESET_VALUES, fieldType } from "../shared/field-types.js";
import { el } from "./modal.js";

/** A uniform inline editor for one field. All controls expose the same shape:
 *  { element, read(), focus(), setInvalid(bool), onBlur(fn) } plus flags
 *  (isBool/isSelect/multiline) the callers use to pick commit gestures. */
export function createControl(key, value, fieldValues) {
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
    sel.title = "Sets the ring colour on the graph and the kinship terms available. The blank option clears it";
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

let pickerSeq = 0;

/** Searchable country selector for the phone widget: an input that shows the
 *  compact "🇮🇳 +91" when idle and becomes a search box on focus - type a
 *  country name (or ISO code, or dial code) and the list filters live, with
 *  full arrow/Enter/Escape keyboard support. Replaces the native select whose
 *  type-to-jump was invisible and reset after a beat. */
function createCountryPicker(initialIso2) {
  const byIso = new Map(COUNTRIES.map((c) => [c.iso2, c]));
  let iso2 = byIso.has(initialIso2) ? initialIso2 : "US";
  const wrap = el("div", "country-picker");
  const input = /** @type {HTMLInputElement} */ (el("input", "phone-country"));
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-label", "Country code - type a country name to search");
  input.title = "Country dialling code. Type a country name, ISO code, or dial code to search";
  const menuId = `country-menu-${pickerSeq++}`;
  const menu = el("div", "location-suggestions country-menu");
  menu.id = menuId;
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  input.setAttribute("aria-controls", menuId);
  wrap.append(input, menu);
  const short = () => `${flagEmoji(iso2)} +${dialOf(iso2)}`;
  input.value = short();

  let shown = [];
  let active = -1;
  const changeFns = [];
  const close = () => {
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
    input.value = short();
  };
  const pick = (c) => {
    const prev = iso2;
    iso2 = c.iso2;
    close();
    if (prev !== iso2) for (const fn of changeFns) fn();
  };
  const setActive = (i) => {
    if (!shown.length) return;
    active = (i + shown.length) % shown.length;
    [...menu.children].forEach((n, j) => {
      n.classList.toggle("active", j === active);
      n.setAttribute("aria-selected", String(j === active));
    });
    const a = menu.children[active];
    if (a) { input.setAttribute("aria-activedescendant", a.id); a.scrollIntoView({ block: "nearest" }); }
  };
  const renderMenu = (q) => {
    const needle = q.trim().toLowerCase();
    shown = !needle
      ? [...COUNTRIES]
      : COUNTRIES.filter((c) =>
          c.name.toLowerCase().includes(needle) ||
          c.iso2.toLowerCase() === needle ||
          `+${c.dial}`.startsWith(needle) ||
          String(c.dial).startsWith(needle.replace(/^\+/, "")));
    menu.innerHTML = "";
    shown.forEach((c, i) => {
      const b = el("button", "location-suggestion" + (c.iso2 === iso2 ? " active" : ""));
      b.type = "button";
      b.id = `${menuId}-${i}`;
      b.setAttribute("role", "option");
      b.title = `${c.name} · dial code +${c.dial}`;
      b.append(
        el("span", "location-suggestion-label", `${flagEmoji(c.iso2)} ${c.name}`),
        el("span", "location-suggestion-kind", `+${c.dial}`)
      );
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
      b.addEventListener("click", () => pick(c));
      menu.append(b);
    });
    if (!shown.length) menu.append(el("div", "location-suggestion-message dim", "No matching country"));
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
    active = -1;
  };
  input.addEventListener("focus", () => {
    input.value = ""; // the short label is a display, not a query - clear for typing
    renderMenu("");
    const idx = shown.findIndex((c) => c.iso2 === iso2);
    if (idx >= 0) setActive(idx);
  });
  input.addEventListener("input", () => renderMenu(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); menu.hidden ? renderMenu(input.value) : setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      // Picking from an open menu is internal: it must not bubble into the
      // surrounding editor's Enter-commits-the-field handling.
      if (!menu.hidden) e.stopPropagation();
      if (active >= 0 && shown[active]) pick(shown[active]);
      else if (shown.length === 1) pick(shown[0]);
    } else if (e.key === "Escape" && !menu.hidden) {
      // Close just the menu; a second Escape reaches the surrounding editor.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  input.addEventListener("blur", () => close());
  return {
    element: wrap,
    get value() { return iso2; },
    onChange: (fn) => { changeFns.push(fn); },
  };
}

export function createPhoneControl(value) {
  const parsed = parsePhone(value);
  const wrap = el("div", "phone-input");
  const sel = createCountryPicker(parsed ? parsed.country.iso2 : localStorage.getItem("orbit-phone-country") || "US");

  // Number split into area code + local number. For NANP (+1) the area code
  // is the first 3 national digits; elsewhere the split is left to the user.
  const area = el("input", "phone-area");
  area.type = "tel";
  area.placeholder = "area";
  area.title = "Area code, if the number has one. Leave it empty and type everything in the next box otherwise";
  area.setAttribute("aria-label", "Area code");
  const num = el("input", "phone-number");
  num.type = "tel";
  num.placeholder = "number";
  num.title = "The rest of the number. It is stored as +dial code plus grouped digits, whatever spacing you type";
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

  wrap.append(sel.element, area, num);
  sel.onChange(() => localStorage.setItem("orbit-phone-country", sel.value));
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
      sel.onChange(fn);
    },
  };
}

/** Location editor with live suggestions - the sidebar's behavior as a
 *  reusable control: bundled-city matches appear instantly as you type, online
 *  geocoder results (when the user has them enabled) join in debounced, and
 *  picking one remembers the structured match so the caller can write the
 *  same resolution keys the card does. Same control shape as createControl,
 *  plus match(text) to fetch the picked resolution for the final value. */
/** @param {string} value @param {{ onPick?: (match: any) => void }} [opts] */
export function createLocationControl(value, { onPick } = {}) {
  const wrap = el("div", "location-input-wrap");
  const input = /** @type {HTMLInputElement} */ (el("input", "field-value"));
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "City, neighborhood, or full address";
  input.title = "Type a place and pick a suggestion to put it on the map. Your text is kept exactly as entered either way";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.value = value ?? "";
  const menuId = `loc-menu-${pickerSeq++}`;
  const menu = el("div", "location-suggestions");
  menu.id = menuId;
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  input.setAttribute("aria-controls", menuId);
  wrap.append(input, menu);

  const picked = new Map(); // suggestion label -> structured match
  let suggestions = [];
  let active = -1;
  let timer = 0;
  let seq = 0;
  const hide = () => {
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };
  const setActive = (i) => {
    if (!suggestions.length) return;
    active = (i + suggestions.length) % suggestions.length;
    [...menu.children].forEach((n, j) => {
      n.classList.toggle("active", j === active);
      n.setAttribute("aria-selected", String(j === active));
    });
    const a = menu.children[active];
    if (a) { input.setAttribute("aria-activedescendant", a.id); a.scrollIntoView({ block: "nearest" }); }
  };
  const choose = (i) => {
    const m = suggestions[i];
    if (!m) return;
    picked.set(m.label, m);
    input.value = m.label;
    hide();
    onPick?.(m);
  };
  const render = (matches) => {
    suggestions = matches.slice(0, 8);
    menu.innerHTML = "";
    active = -1;
    suggestions.forEach((m, i) => {
      const b = el("button", "location-suggestion");
      b.type = "button";
      b.id = `${menuId}-${i}`;
      b.setAttribute("role", "option");
      b.title = `Map to ${m.label} at ${m.precision || "place"} level`;
      b.append(
        el("span", "location-suggestion-label", m.label),
        el("span", "location-suggestion-kind", m.precision || "place")
      );
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
      b.addEventListener("click", () => choose(i));
      menu.append(b);
    });
    menu.hidden = suggestions.length === 0;
    input.setAttribute("aria-expanded", String(suggestions.length > 0));
  };
  const cityMatches = (q) => {
    const needle = q.toLowerCase();
    return CITIES.filter((c) => c.toLowerCase().startsWith(needle)).slice(0, 5)
      .map((c) => ({ label: c, place: c, lat: CITY_COORDS[c][0], lon: CITY_COORDS[c][1], precision: "city", source: "offline-city", components: {} }));
  };
  const refresh = () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (!q) { hide(); return; }
    const offline = cityMatches(q);
    render(offline);
    if (q.length >= 3 && navigator.onLine) {
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const { enabled } = await window.api.location.online({});
          if (!enabled || mine !== seq) return;
          const results = (await window.api.location.search({ query: q })) ?? [];
          if (mine !== seq || document.activeElement !== input) return;
          const seen = new Set(offline.map((m) => m.label));
          render([...offline, ...results.filter((m) => !seen.has(m.label))]);
        } catch { /* offline list stands */ }
      }, 250);
    }
  };
  input.addEventListener("input", refresh);
  input.addEventListener("focus", refresh);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); menu.hidden ? refresh() : setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter" && !menu.hidden) {
      e.preventDefault();
      e.stopPropagation(); // picking must not submit the surrounding editor
      if (active >= 0) choose(active);
      else hide();
    } else if (e.key === "Escape" && !menu.hidden) {
      e.preventDefault();
      e.stopPropagation();
      hide();
    }
  });
  input.addEventListener("blur", () => setTimeout(hide, 120)); // let an option click land
  return {
    element: wrap,
    read: () => input.value.trim(),
    focus: () => input.focus(),
    setInvalid: (b) => input.classList.toggle("invalid", b),
    onBlur: (fn) => input.addEventListener("blur", fn),
    /** The structured match behind a picked suggestion, if `text` was picked. */
    match: (text) => picked.get(text) ?? null,
  };
}

// --- location resolution ----------------------------------------------------
// The location TEXT stays exactly as the user typed it; the resolution rides
// beside it in these keys. Both writers (card + Explore) share the appliers so
// the stored shape can never fork.

export const LOCATION_RESOLUTION_KEYS = ["geo", "place", "locationPrecision", "locationSource", "locationResolved"];

/** Write a geocoder/city match onto a fields map (mutates). */
export function applyLocationMatch(fields, match) {
  fields.geo = `${match.lat},${match.lon}`;
  fields.place = match.place || match.label;
  fields.locationPrecision = match.precision || "place";
  fields.locationSource = match.source || "photon";
  fields.locationResolved = JSON.stringify({ v: 1, components: match.components || {}, osm: match.osm });
}

/** Drop every resolution key (mutates) - the text no longer maps anywhere. */
export function clearLocationResolution(fields) {
  for (const k of LOCATION_RESOLUTION_KEYS) delete fields[k];
}

/** Resolve typed location text the way the card's save does: the bundled city
 *  list first (offline, exact label), then the online geocoder when the user
 *  has it enabled. Null when nothing resolves - the text still saves as typed. */
export async function resolveLocation(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (CITY_COORDS[v]) {
    return { label: v, place: v, lat: CITY_COORDS[v][0], lon: CITY_COORDS[v][1], precision: "city", source: "offline-city", components: {} };
  }
  if (!navigator.onLine) return null;
  try {
    const { enabled } = await window.api.location.online({});
    if (!enabled) return null;
    return (await window.api.location.search({ query: v }))?.[0] ?? null;
  } catch {
    return null;
  }
}
