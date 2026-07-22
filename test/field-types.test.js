// Field-type inference + validation (shared edit-form logic).

const test = require("node:test");
const assert = require("node:assert/strict");
const { fieldType, validateField, AUTOCOMPLETE_FIELDS } = require("../src/shared/field-types");
const contacts = require("../src/main/db/contacts");
const { ExploreService } = require("../src/main/explore/service");
const { GraphStore } = require("../src/main/graph/store");
const { makeDb } = require("./helpers");

test("field keys map to input types", () => {
  assert.equal(fieldType("email"), "email");
  assert.equal(fieldType("Work E-Mail"), "email");
  assert.equal(fieldType("mobile"), "tel");
  assert.equal(fieldType("phone"), "tel");
  assert.equal(fieldType("birthday"), "date");
  assert.equal(fieldType("anniversary"), "date");
  assert.equal(fieldType("linkedin"), "url");
  assert.equal(fieldType("website"), "url");
  assert.equal(fieldType("company"), "text");
  assert.equal(fieldType("role"), "text");
  assert.ok(AUTOCOMPLETE_FIELDS.includes("company") && AUTOCOMPLETE_FIELDS.includes("role"));
});

test("validation accepts good values and rejects bad ones (empty always ok)", () => {
  assert.equal(validateField("email", ""), null);
  assert.equal(validateField("email", "a@b.com"), null);
  assert.ok(validateField("email", "not-an-email"));
  assert.equal(validateField("tel", "+1 (555) 010-9999"), null);
  assert.ok(validateField("tel", "abc"));
  assert.equal(validateField("url", "https://example.com"), null);
  assert.equal(validateField("url", "example.com"), null);
  assert.ok(validateField("url", "no spaces here"));
  assert.equal(validateField("date", "2026-07-20"), null);
  assert.ok(validateField("date", "2026-13-40"));
  assert.equal(validateField("text", "anything at all"), null);
});

test("explore.fieldValues returns distinct company/role/tags", (t) => {
  const { db } = makeDb(t);
  contacts.create(db, { name: "A", fields: { company: "Acme", role: "PM" } });
  contacts.create(db, { name: "B", fields: { company: "Globex", role: "PM" } });
  contacts.create(db, { name: "C", fields: { company: "Acme", role: "Designer" } });
  const s = new ExploreService({ db, graph: new GraphStore().hydrate(db) });
  const fv = s.fieldValues();
  assert.deepEqual(fv.company, ["Acme", "Globex"]);
  assert.deepEqual(fv.role, ["Designer", "PM"]);
});
