// field-types.js - infers an input type from a field key and validates values.
// Shared (CJS) so the renderer form and any future importer validation agree.
// Dates are stored as ISO yyyy-mm-dd strings (native <input type=date> value).

// Yes/no fields render as a checkbox (value stored as "yes" / absent). Expandable.
const BOOLEAN_FIELDS = ["deceased", "business"];

/** @returns {"bool"|"email"|"tel"|"date"|"url"|"text"} */
function fieldType(key) {
  const k = String(key).toLowerCase();
  if (BOOLEAN_FIELDS.includes(k)) return "bool";
  if (/e-?mail/.test(k)) return "email";
  if (/phone|mobile|tel|cell|whatsapp|fax/.test(k)) return "tel";
  if (/birthday|birthdate|\bdob\b|anniversary|\bdate\b/.test(k)) return "date";
  if (/url|website|\bsite\b|linkedin|twitter|github|\blink\b/.test(k)) return "url";
  return "text";
}

/** Field keys that offer a datalist of existing values (select-or-type). */
const AUTOCOMPLETE_FIELDS = ["company", "role", "gender", "location"];

/** Preset suggestions merged with existing values for select-or-type fields.
 *  Inclusive + open: these are suggestions, the input still accepts free text. */
const PRESET_VALUES = {
  gender: ["Female", "Male"],
};

/**
 * @returns {string | null} an error message, or null when valid (empty is ok).
 */
function validateField(type, value) {
  const v = (value ?? "").trim();
  if (!v) return null;
  switch (type) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "Enter a valid email address.";
    case "tel":
      return /^[+()\-.\s\d]{5,}$/.test(v) ? null : "Enter a valid phone number.";
    case "url":
      return /^(https?:\/\/)?[^\s.]+\.[^\s]{2,}$/.test(v) ? null : "Enter a valid web address.";
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
        ? null
        : "Pick a valid date.";
    default:
      return null;
  }
}

/** "Female"/"Male" so gender rings match; other values pass through as typed. */
function normalizeGender(v) {
  const g = String(v ?? "").trim().toLowerCase();
  if (g === "f" || g === "female" || g === "woman") return "Female";
  if (g === "m" || g === "male" || g === "man") return "Male";
  return String(v ?? "").trim();
}

/**
 * Canonical form for a field value wherever one is written. The card's inline
 * editor and the import pipeline share this, so a hand-typed value can never
 * drift from an imported one (untrimmed strings, "f" vs "Female", "1" vs
 * "yes"). Returns "" when the value should clear the field.
 */
function normalizeFieldValue(key, value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  if (String(key).trim().toLowerCase() === "gender") return normalizeGender(v);
  if (fieldType(key) === "bool") return /^(y|yes|true|1|x)$/i.test(v) ? "yes" : "";
  return v;
}

module.exports = { fieldType, validateField, normalizeGender, normalizeFieldValue, AUTOCOMPLETE_FIELDS, PRESET_VALUES };
