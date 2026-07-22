// Search engine (slice scope): prefix, word-order, diacritics, mid-word
// fragments, soft-delete exclusion, requestId passthrough. Transposition-typo
// recall (spellfix/edit-distance) is M4 and intentionally untested here.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const { prepareStatements, search } = require("../src/main/search/engine");
const { makeDb } = require("./helpers");

function seed(db) {
  contacts.create(db, { name: "John Smith", fields: { company: "Acme Corp", role: "PM", email: "john.smith@acme.com" } });
  contacts.create(db, { name: "John Malone", fields: { company: "Globex" } });
  contacts.create(db, { name: "Johanna Reyes", fields: { company: "Initech" } });
  contacts.create(db, { name: "Jürgen Müller", fields: { company: "München AG" } });
  contacts.create(db, { name: "Marina Delacroix", fields: { email: "marina@example.com" } });
}

const q = (stmts, text, id = 1) => search(stmts, { text, requestId: id });

test("prefix search returns all Johns; exact name outranks", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const stmts = prepareStatements(db);

  const r = q(stmts, "joh");
  assert.equal(r.results.length, 3);
  assert.equal(q(stmts, "john smith").results[0].name, "John Smith");
  assert.equal(q(stmts, "johanna").results[0].name, "Johanna Reyes");
});

test("word order does not matter", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const r = q(prepareStatements(db), "acme john");
  assert.ok(r.results.length >= 1);
  assert.equal(r.results[0].name, "John Smith");
  assert.equal(r.results[0].org, "Acme Corp");
});

test("diacritics are ignored on both sides", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const stmts = prepareStatements(db);
  assert.equal(q(stmts, "muller").results[0]?.name, "Jürgen Müller");
  assert.equal(q(stmts, "munchen").results[0]?.name, "Jürgen Müller");
});

test("mid-word fragments recall through the trigram table", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const r = q(prepareStatements(db), "elacroix");
  assert.equal(r.results[0]?.name, "Marina Delacroix");
});

test("email fragments find the contact", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const r = q(prepareStatements(db), "marina");
  assert.equal(r.results[0]?.contactId, 5);
});

test("soft-deleted contacts never appear; empty query returns nothing", (t) => {
  const { db } = makeDb(t);
  seed(db);
  const stmts = prepareStatements(db);
  contacts.softDelete(db, 1);
  assert.deepEqual(q(stmts, "john smith").results.map((r) => r.name), ["John Malone"]);
  assert.deepEqual(q(stmts, "   ").results, []);
});

test("responses carry the originating requestId", (t) => {
  const { db } = makeDb(t);
  seed(db);
  assert.equal(q(prepareStatements(db), "john", 42).requestId, 42);
});
