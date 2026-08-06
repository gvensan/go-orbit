// Migration runner: forward apply, contiguity, pre-backup, rollback on failure.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { migrate } = require("../src/main/db/migrate");
const { tmpDir, openKeyed, makeDb, TEST_KEY } = require("./helpers");

const CURRENT_VERSION = 8;
const migName = (n, name) => `${String(n).padStart(4, "0")}_${name}.sql`;

test("fresh DB migrates to the current version with the full schema", (t) => {
  const { db } = makeDb(t);
  assert.equal(db.pragma("user_version", { simple: true }), CURRENT_VERSION);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')")
    .all()
    .map((r) => r.name);
  for (const expected of [
    "contacts", "edges", "interactions", "tags", "contact_tags",
    "contacts_search", "contacts_fts", "contacts_trigram",
    "contacts_search_ai", "contacts_search_ad", "contacts_search_au",
    "layout_positions", "merge_log", "saved_searches", "app_meta",
  ]) {
    assert.ok(tables.includes(expected), `missing ${expected}`);
  }
});

test("a pre-migration backup is taken before pending migrations run", (t) => {
  const dir = tmpDir(t);
  const db = openKeyed(path.join(dir, "a.db"));
  const backupDir = path.join(dir, "backups");
  const result = migrate(db, { backupDir, key: TEST_KEY });
  assert.equal(result.applied.length, CURRENT_VERSION);
  assert.ok(result.backup && fs.existsSync(result.backup));
  db.close();
});

test("non-contiguous migration versions are rejected", (t) => {
  const { db, dir } = makeDb(t);
  const migDir = path.join(dir, "migrations");
  fs.mkdirSync(migDir);
  fs.writeFileSync(path.join(migDir, migName(CURRENT_VERSION + 2, "skip")), "SELECT 1;");
  assert.throws(
    () => migrate(db, { backupDir: path.join(dir, "b"), migrationsDir: migDir }),
    new RegExp(`gap: expected v${CURRENT_VERSION + 1}`)
  );
});

test("a failing migration rolls back completely and reports its backup", (t) => {
  const { db, dir } = makeDb(t);
  const migDir = path.join(dir, "migrations");
  fs.mkdirSync(migDir);
  // First statement succeeds, second fails: the whole migration must roll back.
  const boomName = migName(CURRENT_VERSION + 1, "boom");
  fs.writeFileSync(
    path.join(migDir, boomName),
    "INSERT INTO contacts (name, fields, created_at, updated_at) VALUES ('Ghost', '{}', 0, 0);\n" +
      "CREATE TABLE contacts (id INTEGER);\n"
  );
  let caught = null;
  try {
    migrate(db, { backupDir: path.join(dir, "b"), migrationsDir: migDir, key: TEST_KEY });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "expected the migration to fail");
  assert.equal(caught.failedMigration, boomName);
  assert.ok(fs.existsSync(caught.migrationBackup));
  assert.equal(db.pragma("user_version", { simple: true }), CURRENT_VERSION);
  const ghosts = db.prepare("SELECT COUNT(*) c FROM contacts WHERE name = 'Ghost'").get().c;
  assert.equal(ghosts, 0, "partial migration write survived rollback");
});
