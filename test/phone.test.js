// Country/phone helpers used by the edit-form phone input.

const test = require("node:test");
const assert = require("node:assert/strict");
const { COUNTRIES, flagEmoji, parsePhone, groupNational, normalizePhone, formatPhone } = require("../src/shared/countries");

test("flag emoji derives from ISO code", () => {
  assert.equal(flagEmoji("US"), "🇺🇸");
  assert.equal(flagEmoji("in"), "🇮🇳");
});

test("parsePhone matches the longest dial code", () => {
  // US and Canada share +1; the number after is the national part.
  const us = parsePhone("+15550109999");
  assert.equal(us.country.dial, "1");
  assert.equal(us.national, "5550109999");

  const uk = parsePhone("+442071838750");
  assert.equal(uk.country.iso2, "GB");
  assert.equal(uk.national, "2071838750");

  const india = parsePhone("+919812345678");
  assert.equal(india.country.iso2, "IN");
  assert.equal(india.national, "9812345678");

  assert.equal(parsePhone("5550100"), null); // no country code
  assert.equal(parsePhone(""), null);
});

test("groupNational spaces per-country and falls back to triples", () => {
  assert.equal(groupNational("IN", "9812345678"), "98123 45678");
  assert.equal(groupNational("US", "4085551234"), "408 555 1234");
  assert.equal(groupNational("GB", "2071838750"), "2 071 838 750"); // generic fallback
  assert.equal(groupNational("IN", "123"), "123"); // too short to group
});

test("normalizePhone: +/00 prefixes and India-default for bare numbers", () => {
  assert.deepEqual(normalizePhone("+14085551234"), { iso2: "US", dial: "1", national: "4085551234" });
  assert.deepEqual(normalizePhone("00919812345678"), { iso2: "IN", dial: "91", national: "9812345678" });
  // Bare numbers default to India: 10-digit, 0-prefixed 11-digit, 91-prefixed 12-digit.
  assert.deepEqual(normalizePhone("9812345678"), { iso2: "IN", dial: "91", national: "9812345678" });
  assert.deepEqual(normalizePhone("09812345678"), { iso2: "IN", dial: "91", national: "9812345678" });
  assert.deepEqual(normalizePhone("919812345678"), { iso2: "IN", dial: "91", national: "9812345678" });
  // Junk / ambiguous bare numbers are left unparsed (so they are not mangled).
  assert.equal(normalizePhone("5188-4931#"), null);
  assert.equal(normalizePhone("21344 / 385924"), null);
  // An explicit non-India default prefixes plausible bare numbers.
  assert.deepEqual(normalizePhone("5550109999", { defaultIso: "US" }), { iso2: "US", dial: "1", national: "5550109999" });
});

test("formatPhone standardizes and leaves junk alone", () => {
  assert.equal(formatPhone("9880749181"), "+91 98807 49181");
  assert.equal(formatPhone("+14085551234"), "+1 408 555 1234");
  assert.equal(formatPhone("+91 98807 49181"), "+91 98807 49181"); // idempotent
  assert.equal(formatPhone("5188-4931#"), "5188-4931#"); // unrecognized: untouched
  assert.equal(formatPhone(""), "");
});

test("every country has a unique-ish ISO and a numeric dial", () => {
  const isos = new Set();
  for (const c of COUNTRIES) {
    assert.match(c.iso2, /^[A-Z]{2}$/);
    assert.match(c.dial, /^\d+$/);
    assert.ok(!isos.has(c.iso2), `duplicate iso ${c.iso2}`);
    isos.add(c.iso2);
  }
  assert.ok(COUNTRIES.length >= 40);
});
