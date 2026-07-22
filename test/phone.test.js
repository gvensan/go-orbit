// Country/phone helpers used by the edit-form phone input.

const test = require("node:test");
const assert = require("node:assert/strict");
const { COUNTRIES, flagEmoji, parsePhone } = require("../src/shared/countries");

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
