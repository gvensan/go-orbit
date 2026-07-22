// sample.js - deterministic sample-network generator.
//
// One implementation shared by scripts/generate-fixture.js (test fixtures at
// 20k scale) and the data:seedSample IPC channel (the first-run "load sample
// network" action). Edges cluster into social circles of CIRCLE_SIZE with a
// share of long-range links, orgs align to circles, ~30% of contacts carry
// tags, so layout/community/centrality see realistic structure.

const config = require("../config");

const CIRCLE_SIZE = 40;       // members per social circle
const EDGES_PER_CONTACT = 10; // insert attempts; ~10x contacts in edge rows
const IN_CIRCLE_RATIO = 0.8;  // rest are random long-range links

const FIRST = ["Ava","Liam","Noah","Emma","Olivia","Mason","Mia","Ethan","Riya","Arjun","Wei","Priya","Diego","Yuki","Omar","Fatima","Kai","Nina","Zara","Ivan","Maya","Raj","Elena","Hana","Sven","Lucia","Amir","Grace","Tomas","Ines"];
const LAST = ["Chen","Patel","Kim","Garcia","Okafor","Nguyen","Silva","Haddad","Rossi","Novak","Khan","Torres","Ivanov","Tanaka","Mensah","Cohen","Reyes","Singh","Muller","Abbas"];
const ORGS = ["Acme Corp","Globex","Initech","Umbrella","Wayne Ent.","Hooli","Stark Ind.","Soylent"];
const ROLES = ["Eng Lead","Designer","PM","Founder","Analyst","Recruiter","Sales","Ops","Legal","Data Sci"];
const EDGE_TYPES = ["colleague","friend","acquaintance","family","introduced"];
const TAGS = ["mentor","investor","alumni","neighbor","climbing","bookclub","conference","exteam","vendor","press","advisor","running"];
const NOTES = ["met at a conference","intro from a mutual friend","worked together on a launch","regular coffee catch-up",""];

// The owner ("you") and family, seeded as the first contacts. The owner is a
// REAL contact (index 1) wired to their inner circle, so "who's connected to me"
// is just the owner's ego view. Gender drives the kin term set; ties are literal.
/** @type {{ first: string, last: string, gender: string, company?: string, role?: string }[]} */
const FAMILY = [
  { first: "Sam",    last: "Rivera", gender: "Male",   company: "Meridian Labs", role: "Founder" }, // 1 = owner ("you")
  { first: "Rosa",   last: "Rivera", gender: "Female" }, // 2 mother
  { first: "Miguel", last: "Rivera", gender: "Male" },   // 3 father
  { first: "Elena",  last: "Rivera", gender: "Female" }, // 4 sister
  { first: "Diego",  last: "Rivera", gender: "Male" },   // 5 brother
  { first: "Carmen", last: "Rivera", gender: "Female" }, // 6 grandmother
  { first: "Lucia",  last: "Rivera", gender: "Female" }, // 7 niece
  { first: "Marco",  last: "Rivera", gender: "Male" },   // 8 nephew
];
// [aIndex, roleOfA, bIndex, roleOfB] - 1-based into FAMILY. Stored on the family
// edge as metadata.kin = { <idA>: roleOfA, <idB>: roleOfB } ("X is Y's <role>").
const FAMILY_TIES = [
  // Sam (1) to his immediate family - this is the owner's inner circle.
  [1, "son",      2, "mother"],      // Sam & Rosa
  [1, "son",      3, "father"],      // Sam & Miguel
  [1, "brother",  4, "sister"],      // Sam & Elena
  [1, "brother",  5, "brother"],     // Sam & Diego
  [1, "grandson", 6, "grandmother"], // Sam & Carmen
  // Extended ties among the relatives.
  [2, "wife",     3, "husband"],     // Rosa  & Miguel (parents)
  [2, "mother",   4, "daughter"],    // Rosa  -> Elena
  [2, "mother",   5, "son"],         // Rosa  -> Diego
  [3, "father",   4, "daughter"],    // Miguel-> Elena
  [3, "father",   5, "son"],         // Miguel-> Diego
  [4, "sister",   5, "brother"],     // Elena & Diego
  [6, "mother",   2, "daughter"],    // Carmen-> Rosa
  [4, "mother",   7, "daughter"],    // Elena -> Lucia
  [4, "mother",   8, "son"],         // Elena -> Marco
  [7, "sister",   8, "brother"],     // Lucia & Marco (siblings)
];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed `count` sample contacts (plus edges, tags, interactions) into an open,
 * migrated DB. Safe on a non-empty DB: ids start after the current max.
 * @param {any} db keyed better-sqlite3 connection
 * @param {{ count?: number, seed?: number, withOwnerFamily?: boolean }} [opts]
 * @returns {{ contacts: number, edges: number }}
 */
function seedSample(db, { count = config.sample.defaultContacts, seed = 1337, withOwnerFamily = false } = {}) {
  const rnd = mulberry32(seed);
  const ri = (n) => Math.floor(rnd() * n);
  const now = Date.now();

  const insC = db.prepare("INSERT INTO contacts (id,name,fields,created_at,updated_at) VALUES (?,?,?,?,?)");
  const insS = db.prepare("INSERT INTO contacts_search (id,name,email,phone,company,role,tags,notes) VALUES (?,?,?,?,?,?,?,?)");
  const insE = db.prepare("INSERT OR IGNORE INTO edges (source_id,target_id,type,directed,created_at) VALUES (?,?,?,?,?)");
  const insEM = db.prepare("INSERT OR IGNORE INTO edges (source_id,target_id,type,directed,metadata,created_at) VALUES (?,?,?,?,?,?)");
  const insMeta = db.prepare(
    "INSERT INTO app_meta (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
  );
  const insI = db.prepare("INSERT INTO interactions (contact_id,occurred_at,kind,note) VALUES (?,?,?,?)");
  const insT = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const tagId = db.prepare("SELECT id FROM tags WHERE name = ?");
  const insCT = db.prepare("INSERT OR IGNORE INTO contact_tags (contact_id,tag_id) VALUES (?,?)");

  const base = /** @type {{m: number}} */ (
    db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM contacts").get()
  ).m;
  const circleOf = (id) => Math.floor((id - base - 1) / CIRCLE_SIZE);
  const randomInCircle = (c) => {
    const start = base + c * CIRCLE_SIZE + 1;
    const size = Math.min(CIRCLE_SIZE, base + count - start + 1);
    return start + ri(size);
  };

  const edgesBefore = /** @type {{c: number}} */ (db.prepare("SELECT COUNT(*) c FROM edges").get()).c;

  const tx = db.transaction(() => {
    const tagIds = TAGS.map((t) => {
      insT.run(t);
      return /** @type {{id: number}} */ (tagId.get(t)).id;
    });

    for (let n = 1; n <= count; n++) {
      const id = base + n;
      const fam = withOwnerFamily && n <= FAMILY.length ? FAMILY[n - 1] : null;
      const name = fam ? `${fam.first} ${fam.last}` : `${FIRST[ri(FIRST.length)]} ${LAST[ri(LAST.length)]}`;
      const company = fam ? (fam.company ?? "") : ORGS[circleOf(id) % ORGS.length];
      const role = fam ? (fam.role ?? "") : ROLES[ri(ROLES.length)];
      const domain = company ? company.split(" ")[0].toLowerCase() : "example";
      const email = name.toLowerCase().replace(/[^a-z]/g, ".") + "@" + domain + ".com";
      const phone = `+1${1000000000 + ri(900000000)}`;
      const note = fam ? (n === 1 ? "" : "family") : NOTES[ri(NOTES.length)]; // owner (n===1) has no note
      const gender = fam ? fam.gender : (rnd() < 0.5 ? "Male" : "Female"); // demo data only
      const fields = /** @type {Record<string, string>} */ ({ email, phone, company, role, gender });
      if (note) fields.notes = note;
      insC.run(id, name, JSON.stringify(fields), now, now);

      let tagNames = "";
      if (rnd() < 0.3) {
        const picked = new Set();
        const n2 = 1 + ri(3);
        for (let t = 0; t < n2; t++) picked.add(ri(TAGS.length));
        for (const idx of picked) insCT.run(id, tagIds[idx]);
        tagNames = [...picked].map((idx) => TAGS[idx]).join(" ");
      }
      insS.run(id, name, email, phone, company, role, tagNames, note);

      if (rnd() < 0.4) insI.run(id, now - ri(180) * 86400000, "email", "auto-seeded");
    }

    // Curated family cluster (inserted before the random loop so its kin
    // metadata wins over any later OR IGNORE'd random 'family' edge). The owner
    // (Sam, the first contact) is starred and recorded as the app_meta owner.
    const ownerId = withOwnerFamily && count >= FAMILY.length ? base + 1 : null;
    if (ownerId != null) {
      insMeta.run("owner.contactId", String(ownerId), now);
      db.prepare("UPDATE contacts SET starred = 1 WHERE id = ?").run(ownerId);
      for (const [ia, ra, ib, rb] of FAMILY_TIES) {
        const idA = base + Number(ia), idB = base + Number(ib);
        const kin = { [idA]: ra, [idB]: rb };
        insEM.run(Math.min(idA, idB), Math.max(idA, idB), "family", 0, JSON.stringify({ kin }), now);
      }
    }

    for (let n = 1; n <= count; n++) {
      const id = base + n;
      if (id === ownerId) continue; // owner connects only to their inner circle
      for (let k = 0; k < EDGES_PER_CONTACT; k++) {
        const b = rnd() < IN_CIRCLE_RATIO ? randomInCircle(circleOf(id)) : base + 1 + ri(count);
        if (b === id || b === ownerId) continue; // never wire a stranger to the owner
        insE.run(Math.min(id, b), Math.max(id, b), EDGE_TYPES[ri(EDGE_TYPES.length)], 0, now);
      }
    }
  });
  tx();

  const edgesAfter = /** @type {{c: number}} */ (db.prepare("SELECT COUNT(*) c FROM edges").get()).c;
  return { contacts: count, edges: edgesAfter - edgesBefore };
}

module.exports = { seedSample };
