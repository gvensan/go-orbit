// Settings > Setup: the checklist reads the live state and remembers manual marks.

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSetupStatus, markStep, STEP_IDS, MANUAL_STEPS, REQUIRED_STEPS } = require("../src/main/setup/checklist");
const meta = require("../src/main/db/meta");
const contacts = require("../src/main/db/contacts");
const { makeDb } = require("./helpers");

const info = (over = {}) => ({
  version: "0.2.0", port: 7779, url: "http://localhost:7779", home: "/h/.orbit", backupDir: "/h/.orbit/backups",
  launchd: false, agentInstalled: false, keyBackend: "test store", bookmarklet: "javascript:void%200", backupCount: 0, lastBackupAt: null, ...over,
});

test("a fresh database: service and session tick, owner and contacts do not", (t) => {
  const { db } = makeDb(t);
  const s = buildSetupStatus(db, info());
  assert.deepEqual(s.steps.map((x) => x.id), STEP_IDS);
  const by = Object.fromEntries(s.steps.map((x) => [x.id, x]));
  assert.equal(by.service.done, true);
  assert.equal(by.session.done, true);
  assert.equal(by.owner.done, false);
  assert.equal(by.contacts.done, false);
  assert.equal(by.backup.done, false);
  assert.equal(by.login.done, false);
  assert.equal(s.requiredTotal, REQUIRED_STEPS.size);
  assert.equal(s.requiredDone, 2);
  assert.equal(s.complete, false);
  for (const step of s.steps) {
    assert.equal(step.manual, MANUAL_STEPS.has(step.id));
    assert.equal(step.required, REQUIRED_STEPS.has(step.id));
    assert.ok(step.detail.length > 20, `${step.id} explains itself`);
    if (!step.done) assert.ok(step.actions.length > 0 || step.manual, `${step.id} offers a way forward`);
  }
  assert.equal(by.session.actions[0].value, "http://localhost:7779");
  assert.match(by.login.actions[0].value, /bin\/orbit install/);
});

test("owner and own contacts complete the required steps; sample data does not count", (t) => {
  const { db } = makeDb(t);
  meta.setProfile(db, { name: "Giri" });
  contacts.create(db, { name: "Ada" });
  meta.set(db, "sample.dataset", "small");
  let s = buildSetupStatus(db, info());
  let by = Object.fromEntries(s.steps.map((x) => [x.id, x]));
  assert.equal(by.owner.done, true);
  assert.equal(by.contacts.done, false, "a sample network is not the user's people");
  assert.match(by.contacts.detail, /sample/);
  meta.set(db, "sample.dataset", "");
  s = buildSetupStatus(db, info({ launchd: true, backupCount: 3 }));
  by = Object.fromEntries(s.steps.map((x) => [x.id, x]));
  assert.equal(by.contacts.done, true);
  assert.equal(by.backup.done, true);
  assert.equal(by.login.done, true);
  assert.match(by.service.detail, /every time you log in/);
  assert.equal(s.complete, true);
  assert.equal(s.remaining, 3, "the three manual steps remain");
  assert.equal(by.bookmarklet.actions[0].kind, "bookmarklet");
  assert.equal(by.bookmarklet.actions[0].value, "javascript:void%200");
});

test("manual marks persist and only manual steps accept them", (t) => {
  const { db } = makeDb(t);
  assert.deepEqual(markStep(db, { id: "online", done: true }), { ok: true });
  assert.deepEqual(markStep(db, { id: "owner", done: true }), { ok: false }, "auto steps cannot be faked");
  let by = Object.fromEntries(buildSetupStatus(db, info()).steps.map((x) => [x.id, x]));
  assert.equal(by.online.done, true);
  assert.equal(by.owner.done, false);
  markStep(db, { id: "online", done: false });
  by = Object.fromEntries(buildSetupStatus(db, info()).steps.map((x) => [x.id, x]));
  assert.equal(by.online.done, false);
  meta.set(db, "setup.done", "not json");
  assert.equal(buildSetupStatus(db, info()).steps.find((x) => x.id === "migrate").done, false, "a damaged mark store reads as nothing marked");
});

test("the online step describes the current preference", (t) => {
  const { db } = makeDb(t);
  meta.set(db, "location.online", "0");
  const off = buildSetupStatus(db, info()).steps.find((x) => x.id === "online");
  assert.match(off.detail, /OFF/);
  meta.set(db, "location.online", "1");
  const on = buildSetupStatus(db, info()).steps.find((x) => x.id === "online");
  assert.match(on.detail, /ON/);
});
