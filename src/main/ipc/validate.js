// validate.js - small combinator validators for IPC payloads.
//
// Every failure throws AppError("VALIDATION") before the payload reaches the
// data layer. Validators return the cleaned value; obj() strips unknown keys
// is deliberately NOT done - unknown keys are rejected so contract drift is
// caught at the boundary, not silently ignored. Size caps live in config.limits.

const config = require("../config");
const { AppError } = require("./errors");

const fail = (msg) => {
  throw new AppError("VALIDATION", msg);
};

const id = (x, name = "id") =>
  Number.isInteger(x) && x > 0 ? x : fail(`${name} must be a positive integer.`);

const int = (x, name, { min = -Infinity, max = Infinity } = {}) => {
  if (!Number.isInteger(x) || x < min || x > max) {
    fail(`${name} must be an integer in [${min}, ${max}].`);
  }
  return x;
};

const bool = (x, name) => (typeof x === "boolean" ? x : fail(`${name} must be a boolean.`));

const str = (x, name, { max = 1000, min = 0 } = {}) => {
  if (typeof x !== "string" || x.length < min || x.length > max) {
    fail(`${name} must be a string of ${min}..${max} characters.`);
  }
  return x;
};

const isPlainObject = (x) =>
  x !== null && typeof x === "object" && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);

/** Contact fields: flat string map with bounded keys/values/cardinality. */
const fields = (x, name = "fields") => {
  const L = config.limits;
  if (!isPlainObject(x)) fail(`${name} must be a plain object.`);
  const keys = Object.keys(x);
  if (keys.length > L.fieldsMaxKeys) fail(`${name} has too many keys (max ${L.fieldsMaxKeys}).`);
  for (const k of keys) {
    if (k.length === 0 || k.length > L.fieldKeyMax) fail(`${name} key "${k}" exceeds ${L.fieldKeyMax} chars.`);
    if (x[k] === undefined) continue;
    if (typeof x[k] !== "string" || x[k].length > L.fieldValueMax) {
      fail(`${name}.${k} must be a string of at most ${L.fieldValueMax} chars.`);
    }
  }
  return x;
};

/** Edge metadata: JSON-serializable plain object with a byte cap. */
const metadata = (x, name = "metadata") => {
  if (!isPlainObject(x)) fail(`${name} must be a plain object.`);
  let json;
  try {
    json = JSON.stringify(x);
  } catch {
    return fail(`${name} must be JSON-serializable.`);
  }
  if (json.length > config.limits.metadataMaxBytes) {
    fail(`${name} exceeds ${config.limits.metadataMaxBytes} bytes.`);
  }
  return x;
};

/** Optional wrapper: undefined/null pass through as undefined. */
const opt = (fn) => (x, name) => (x === undefined || x === null ? undefined : fn(x, name));

/** Array validator: every item through `fn`, bounded length. */
const arr = (fn, { max = 1000 } = {}) => (x, name) => {
  if (!Array.isArray(x) || x.length > max) fail(`${name} must be an array of at most ${max} items.`);
  return x.map((item, i) => fn(item, `${name}[${i}]`));
};

/** Map of id -> {x, y} for position persistence. */
const positions = (x, name = "positions") => {
  if (!isPlainObject(x)) fail(`${name} must be a plain object.`);
  const entries = Object.entries(x);
  if (entries.length > 50000) fail(`${name} has too many entries.`);
  for (const [k, v] of entries) {
    if (!/^\d+$/.test(k)) fail(`${name} keys must be contact ids.`);
    if (!isPlainObject(v) || typeof v.x !== "number" || typeof v.y !== "number" ||
        !Number.isFinite(v.x) || !Number.isFinite(v.y)) {
      fail(`${name}.${k} must be { x, y } finite numbers.`);
    }
  }
  return x;
};

/** File-dialog filter list: [{ name, extensions[] }]. */
const dialogFilters = (x, name = "filters") => {
  if (!Array.isArray(x) || x.length > 10) fail(`${name} must be a short array.`);
  for (const f of x) {
    if (!isPlainObject(f) || typeof f.name !== "string" || !Array.isArray(f.extensions) ||
        f.extensions.some((e) => typeof e !== "string" || !/^[\w.]{1,12}$/.test(e))) {
      fail(`${name} entries must be { name, extensions[] }.`);
    }
  }
  return x;
};

/**
 * Object validator from a shape of per-key validators. Rejects non-objects and
 * unknown keys; returns a cleaned copy.
 * @param {Record<string, (x: any, name: string) => any>} shape
 */
const obj = (shape) => (payload) => {
  if (!isPlainObject(payload)) fail("Payload must be a plain object.");
  for (const k of Object.keys(payload)) {
    if (!(k in shape)) fail(`Unknown payload key "${k}".`);
  }
  const out = {};
  for (const [k, fn] of Object.entries(shape)) {
    const v = fn(payload[k], k);
    if (v !== undefined) out[k] = v;
  }
  return out;
};

const req = (fn) => (x, name) => (x === undefined ? fail(`${name} is required.`) : fn(x, name));

module.exports = {
  fail, id, int, bool, str, fields, metadata, opt, obj, req, arr,
  positions, dialogFilters, isPlainObject,
};
