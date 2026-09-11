// Relocating the data home: copies and re-keys the database and its snapshots
// to the key stored for the new path, never touching the old folder.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");
const config = require("../src/main/config");
const { moveHome, opensWith, rekeyFile } = require("../src/server/move-home");
const { resolvePaths, ensurePaths } = require("../src/server/paths");
const { migrate } = require("../src/main/db/migrate");
const { takeBackup } = require("../src/main/db");
const contacts = require("../src/main/db/contacts");
const { tmpDir } = require("./helpers");

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const env = config.server.homeEnv;

function seededHome(t) {
  const home = path.join(tmpDir(t), "home-a");
  const p = ensurePaths(resolvePaths({ [env]: home }));
  const db = new Database(p.dbPath);
  db.pragma(`key = '${KEY_A}'`);
  db.pragma("journal_mode = WAL");
  migrate(db, { backupDir: p.backupDir, key: KEY_A });
  contacts.create(db, { name: "Ada Lovelace" });
  takeBackup(db, p.backupDir, { key: KEY_A });
  db.close();
  fs.writeFileSync(p.tokenFile, "c".repeat(64) + "\n");
  return p;
}

const keyFor = (paths) => ({ key: paths.home.endsWith("home-a") ? KEY_A : KEY_B, backend: "test" });

test("rekeyFile: opens with the new key only, and refuses a wrong old key", (t) => {
  const p = seededHome(t);
  assert.equal(opensWith(p.dbPath, KEY_A), true);
  assert.equal(opensWith(p.dbPath, KEY_B), false);
  rekeyFile(p.dbPath, KEY_A, KEY_B);
  assert.equal(opensWith(p.dbPath, KEY_B), true);
  assert.equal(opensWith(p.dbPath, KEY_A), false);
  assert.throws(() => rekeyFile(p.dbPath, KEY_A, KEY_B), /does not open with the old key/);
});

test("moveHome copies, re-keys and verifies; the old home is untouched", (t) => {
  const p = seededHome(t);
  const to = path.join(path.dirname(p.home), "home-b");
  const logs = [];
  const r = moveHome({ from: p.home, to, getKey: keyFor, log: (m) => logs.push(m) });
  assert.equal(r.to, to);
  assert.ok(r.backups >= 1, "snapshots travel too");
  assert.deepEqual(r.skipped, []);

  const q = resolvePaths({ [env]: to });
  assert.equal(opensWith(q.dbPath, KEY_B), true, "new copy opens with the new home's key");
  assert.equal(opensWith(q.dbPath, KEY_A), false);
  const db = new Database(q.dbPath, { readonly: true });
  db.pragma(`key = '${KEY_B}'`);
  assert.equal(db.prepare("SELECT name FROM contacts").get().name, "Ada Lovelace");
  db.close();
  for (const f of fs.readdirSync(q.backupDir)) assert.equal(opensWith(path.join(q.backupDir, f), KEY_B), true, f);
  assert.equal(fs.readFileSync(q.tokenFile, "utf8"), fs.readFileSync(p.tokenFile, "utf8"), "the session travels so browsers stay signed in");

  assert.equal(opensWith(p.dbPath, KEY_A), true, "the old database still opens with its own key");
  assert.equal(fs.existsSync(p.dbPath), true);
  assert.ok(logs.some((m) => /re-keyed/.test(m)));
});

test("moveHome refuses the wrong situations without changing anything", (t) => {
  const p = seededHome(t);
  const to = path.join(path.dirname(p.home), "home-b");
  assert.throws(() => moveHome({ from: p.home, to: p.home, getKey: keyFor }), /current data home/);
  fs.mkdirSync(to); fs.writeFileSync(path.join(to, "x"), "");
  assert.throws(() => moveHome({ from: p.home, to, getKey: keyFor }), /not empty/);
  fs.rmSync(to, { recursive: true });
  fs.writeFileSync(p.lockFile, String(process.pid));
  assert.throws(() => moveHome({ from: p.home, to, getKey: keyFor }), /still running/);
  fs.unlinkSync(p.lockFile);
  assert.throws(() => moveHome({ from: p.home, to, getKey: () => ({ key: KEY_B, backend: "test" }) }), /does not open with the key stored/);
  assert.equal(fs.existsSync(path.join(to, "contacts.db")), false, "nothing written on refusal");
  assert.throws(() => moveHome({ from: path.join(p.home, "nowhere"), to, getKey: keyFor }), /no database/);
});
