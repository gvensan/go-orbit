// Ingest: vCard parsing, CSV parsing + mapping, import dedup policies.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const { parseVCard } = require("../src/main/ingest/vcard");
const { parseCSV, suggestMapping, rowsToContacts } = require("../src/main/ingest/csv");
const { importContacts } = require("../src/main/ingest/importer");
const { makeDb } = require("./helpers");

const VCF = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Alice Chen",
  "N:Chen;Alice;;;",
  "EMAIL;TYPE=WORK:alice@acme.com",
  "TEL;TYPE=CELL:+1 555 0100",
  "ORG:Acme Corp;Engineering",
  "TITLE:Eng Lead",
  "NOTE:Met at the graph conf\\, great chat",
  "CATEGORIES:mentor,Climbing",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:4.0",
  "N:Okafor;Sam;;;",
  "item1.EMAIL:sam@globex.com",
  "END:VCARD",
].join("\r\n");

test("vCard: folded lines, params, N fallback, categories", () => {
  const cards = parseVCard(VCF);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].name, "Alice Chen");
  assert.equal(cards[0].fields.email, "alice@acme.com");
  assert.equal(cards[0].fields.company, "Acme Corp");
  assert.equal(cards[0].fields.role, "Eng Lead");
  assert.equal(cards[0].fields.notes, "Met at the graph conf, great chat");
  assert.deepEqual(cards[0].tags, ["mentor", "climbing"]);
  assert.equal(cards[1].name, "Sam Okafor");
  assert.equal(cards[1].fields.email, "sam@globex.com");
});

test("CSV: quotes, escapes, mapping heuristics", () => {
  const text = 'Full Name,E-mail,Company,Job Title,Labels\n' +
    '"Reyes, Johanna",jo@initech.com,Initech,"PM, Core","vip; alumni"\n' +
    'NoEmail Person,,Globex,,\n';
  const { headers, rows } = parseCSV(text);
  assert.deepEqual(headers, ["Full Name", "E-mail", "Company", "Job Title", "Labels"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0], "Reyes, Johanna");

  const mapping = suggestMapping(headers);
  assert.equal(mapping["Full Name"], "name");
  assert.equal(mapping["E-mail"], "email");
  assert.equal(mapping["Company"], "company");
  assert.equal(mapping["Job Title"], "role");
  assert.equal(mapping["Labels"], "tags");

  const parsed = rowsToContacts(headers, rows, mapping);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "Reyes, Johanna");
  assert.deepEqual(parsed[0].tags, ["vip", "alumni"]);
});

test("import dedup policies: skip, merge, keepBoth", (t) => {
  const { db } = makeDb(t);
  contacts.create(db, { name: "Alice Chen", fields: { email: "alice@acme.com", role: "Eng Lead" } });

  const incoming = [
    { name: "Alicia Chen", fields: { email: "ALICE@acme.com", phone: "+1555" } }, // dup by email
    { name: "Brand New", fields: { email: "new@x.com" } },
  ];

  const skip = importContacts(db, incoming, { onDuplicate: "skip" });
  assert.deepEqual(
    { i: skip.imported, m: skip.merged, s: skip.skipped, d: skip.duplicatesFound },
    { i: 1, m: 0, s: 1, d: 1 }
  );

  const merge = importContacts(db, [incoming[0]], { onDuplicate: "merge" });
  assert.equal(merge.merged, 1);
  const alice = contacts.get(db, 1);
  assert.equal(alice.fields.phone, "+1555", "merge did not fill blank field");
  assert.equal(alice.fields.role, "Eng Lead", "merge overwrote existing field");

  const both = importContacts(db, [incoming[0]], { onDuplicate: "keepBoth" });
  assert.equal(both.imported, 1);
  assert.equal(contacts.list(db).length, 3);
});

test("in-file duplicates are caught within one import run", (t) => {
  const { db } = makeDb(t);
  const twice = [
    { name: "Dup Person", fields: { email: "dup@x.com" } },
    { name: "Dup Person", fields: { email: "dup@x.com" } },
  ];
  const r = importContacts(db, twice, { onDuplicate: "skip" });
  assert.equal(r.imported, 1);
  assert.equal(r.skipped, 1);
});
