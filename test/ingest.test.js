// Ingest: vCard parsing, CSV parsing + mapping, import dedup policies.

const test = require("node:test");
const assert = require("node:assert/strict");
const contacts = require("../src/main/db/contacts");
const { parseVCard } = require("../src/main/ingest/vcard");
const { parseCSV, suggestMapping, rowsToContacts, contactsToCSV, relationshipRowsToCSV } = require("../src/main/ingest/csv");
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

test("CSV export round-trips through the importer", () => {
  const original = [
    { name: "Reyes, Johanna", fields: { email: "jo@initech.com", company: "Initech", role: "PM, Core", notes: 'says "hi"\nline two' }, tags: ["vip", "alumni"] },
    { name: "NoEmail Person", fields: { company: "Globex" }, tags: [] },
  ];
  const csv = contactsToCSV(original);
  // Export leads with a UTF-8 BOM (so Excel reads non-ASCII correctly).
  assert.equal(csv.charCodeAt(0), 0xfeff);
  // Header matches the import template's column order exactly (after the BOM).
  assert.equal(csv.slice(1).split("\r\n")[0], "name,email,phone,company,role,gender,birthday,nickname,website,linkedin,notes,tags");

  const { headers, rows } = parseCSV(csv);
  const back = rowsToContacts(headers, rows, suggestMapping(headers));
  assert.equal(back.length, 2);
  assert.equal(back[0].name, "Reyes, Johanna");
  assert.equal(back[0].fields.email, "jo@initech.com");
  assert.equal(back[0].fields.role, "PM, Core");
  assert.equal(back[0].fields.notes, 'says "hi"\nline two'); // quotes + newline survive
  assert.deepEqual(back[0].tags, ["vip", "alumni"]);
  assert.equal(back[1].name, "NoEmail Person");
  assert.equal(back[1].fields.company, "Globex");
});

test("CSV export neutralises formula injection yet round-trips the value", () => {
  const original = [
    { name: "Alice", fields: { phone: "+91 99459 99459", notes: "=cmd()", website: "@handle" }, tags: [] },
  ];
  const csv = contactsToCSV(original);
  // The raw file guards dangerous leading chars so Excel/Sheets treat them as text.
  const body = csv.slice(1).split("\r\n")[1]; // after BOM + header
  assert.ok(body.includes("'+91 99459 99459"), "phone guarded");
  assert.ok(body.includes("'=cmd()"), "formula guarded");
  // But re-importing strips the guard, so the stored values are unchanged.
  const { headers, rows } = parseCSV(csv);
  const back = rowsToContacts(headers, rows, suggestMapping(headers));
  assert.equal(back[0].fields.phone, "+91 99459 99459");
  assert.equal(back[0].fields.notes, "=cmd()");
  assert.equal(back[0].fields.website, "@handle");
});

test("CSV detailed export mirrors the Review-step columns", () => {
  // One contact with two relationships -> two rows; one with none -> one blank row.
  const rows = [
    { name: "Adhya", fields: { gender: "Female", location: "Chennai", email: "a@x.io" }, tags: ["core"],
      relationship: "family", relationshipTo: "Rosa", kinship: "daughter" },
    { name: "Adhya", fields: { gender: "Female", location: "Chennai", email: "a@x.io" }, tags: ["core"],
      relationship: "colleague", relationshipTo: "Sam", kinship: "" },
    { name: "Loner", fields: { gender: "Male" }, tags: [] },
  ];
  const csv = relationshipRowsToCSV(rows);
  const { headers, rows: parsed } = parseCSV(csv);
  assert.deepEqual(headers.slice(0, 5), ["name", "gender", "relationship", "relationship to", "kinship"]);
  const col = (r, h) => parsed[r][headers.indexOf(h)];
  assert.equal(col(0, "relationship"), "family");
  assert.equal(col(0, "relationship to"), "Rosa");
  assert.equal(col(0, "kinship"), "daughter");
  assert.equal(col(0, "gender"), "Female");
  assert.equal(col(1, "relationship"), "colleague");
  assert.equal(col(1, "kinship"), ""); // non-family has no kinship
  assert.equal(col(2, "relationship"), ""); // relationship-less contact still exported
  assert.equal(col(2, "name"), "Loner");
});

test("detailed export reads kinship as the contact's own role (real edges)", (t) => {
  const { contactReviewRows } = require("../src/main/ipc/registry");
  const edges = require("../src/main/db/edges");
  const { db } = makeDb(t);
  const uma = contacts.create(db, { name: "Uma", fields: { gender: "Female" } }).id;
  const leela = contacts.create(db, { name: "Leelavathy", fields: { gender: "Female" } }).id;
  // Uma is Leelavathy's daughter; Leelavathy is Uma's mother.
  edges.create(db, {
    sourceId: uma, targetId: leela, type: "family", directed: false,
    metadata: { kin: { [uma]: "daughter", [leela]: "mother" } },
  });
  const nameById = new Map([[uma, "Uma"], [leela, "Leelavathy"]]);
  const umaRows = contactReviewRows(db, contacts.get(db, uma), [], nameById);
  assert.equal(umaRows.length, 1);
  assert.equal(umaRows[0].relationshipTo, "Leelavathy");
  assert.equal(umaRows[0].kinship, "daughter"); // Uma's own role, not "mother"
  const leelaRows = contactReviewRows(db, contacts.get(db, leela), [], nameById);
  assert.equal(leelaRows[0].relationshipTo, "Uma");
  assert.equal(leelaRows[0].kinship, "mother"); // Leelavathy's own role
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

test("a business row never stores a gender (fresh insert and merge)", (t) => {
  const { db } = makeDb(t);
  // Source file carries both: business wins, gender is dropped on insert.
  const r1 = importContacts(db, [
    { name: "Acme Broadband", fields: { business: "yes", gender: "Female", phone: "+1800" }, tags: [] },
  ], { onDuplicate: "skip" });
  assert.equal(r1.imported, 1);
  const vendor = contacts.get(db, 1);
  assert.equal(vendor.fields.business, "yes");
  assert.equal(vendor.fields.gender, undefined, "imported business kept a gender");

  // Merging a business flag onto an existing gendered contact drops the gender.
  importContacts(db, [
    { name: "Priya Rao", fields: { email: "priya@example.com", gender: "Female" }, tags: [] },
  ], { onDuplicate: "skip" });
  const r2 = importContacts(db, [
    { name: "Priya Rao", fields: { email: "priya@example.com", business: "true" }, tags: [] },
  ], { onDuplicate: "merge" });
  assert.equal(r2.merged, 1);
  const merged = contacts.get(db, 2);
  assert.equal(merged.fields.gender, undefined, "merge left a gendered business behind");
});
