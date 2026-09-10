// Import/export slots: grants, TTLs, keep-after-download, touch-on-use.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const config = require("../src/main/config");
const { FileSlots, safeName } = require("../src/server/files");
const { tmpDir } = require("./helpers");

function make(t) {
  const home = tmpDir(t);
  const uploadsDir = path.join(home, "uploads");
  const exportsDir = path.join(home, "exports");
  fs.mkdirSync(uploadsDir);
  fs.mkdirSync(exportsDir);
  const granted = new Set();
  return { slots: new FileSlots({ uploadsDir, exportsDir, grantedPaths: granted }), granted, uploadsDir, exportsDir };
}

const age = (p, ms) => {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(p, t, t);
};

test("names are basenamed, scrubbed and bounded; uploads need an import extension", () => {
  assert.equal(safeName("../../etc/passwd.csv", "x"), "passwd.csv");
  assert.equal(safeName("C:\\Users\\me\\people.vcf", "x"), "people.vcf");
  assert.equal(safeName("a:b*c?.csv", "x"), "a_b_c_.csv");
  assert.equal(safeName("", "fallback"), "fallback");
  assert.equal(safeName("..", "fallback"), "fallback");
  assert.equal(safeName("x".repeat(300) + ".csv", "f").length, 120);
});

test("upload: granted path under uploadsDir, wrong extension refused", (t) => {
  const { slots, granted, uploadsDir } = make(t);
  const p = slots.saveUpload("people.CSV", Buffer.from("name\nAda\n"));
  assert.ok(p.startsWith(uploadsDir + path.sep));
  assert.ok(granted.has(p));
  assert.equal(fs.readFileSync(p, "utf8"), "name\nAda\n");
  assert.throws(() => slots.saveUpload("evil.exe", Buffer.from("MZ")), RangeError);
  assert.throws(() => slots.saveUpload("", Buffer.from("")), RangeError);
  assert.equal(slots.isExportSlot(p), false, "an upload is never downloadable");
});

test("export slot: granted, consumed once, never an upload", (t) => {
  const { slots, granted } = make(t);
  const p = slots.createExportSlot("orbit-contacts.csv");
  assert.equal(path.basename(p), "orbit-contacts.csv");
  assert.ok(granted.has(p));
  assert.equal(slots.isExportSlot(p), true);
  assert.equal(slots.isExportSlot(p + "x"), false);
  fs.writeFileSync(p, "a,b\n");
  slots.consumeExport(p);
  assert.equal(fs.existsSync(path.dirname(p)), false);
  assert.equal(granted.has(p), false);
  assert.equal(slots.isExportSlot(p), false);
  slots.consumeExport(p); // idempotent
});

test("sweep: idle slots expire; a slot a channel just read survives; kept exports follow the upload TTL", (t) => {
  const { slots, granted } = make(t);
  const up = slots.saveUpload("a.csv", Buffer.from("x"));
  const ex = slots.createExportSlot("b.csv");
  const kept = slots.createExportSlot("results.csv");
  fs.writeFileSync(kept, "x");
  slots.keep(kept);
  assert.ok(slots.kept.has(path.dirname(kept)));
  slots.keep(up); // not an export slot: ignored
  assert.equal(slots.kept.size, 1);
  const touched = slots.saveUpload("c.csv", Buffer.from("x"));

  const longest = Math.max(config.server.uploadTtlMs, config.server.exportTtlMs);
  // Young slots are all kept.
  assert.equal(slots.sweep(), 0);
  // A plain export older than its TTL but not the upload TTL goes; a kept one stays.
  age(path.dirname(ex), config.server.exportTtlMs + 1000);
  age(path.dirname(kept), config.server.exportTtlMs + 1000);
  const first = slots.sweep();
  assert.equal(granted.has(ex), false, "undownloaded export expired");
  assert.equal(granted.has(kept), config.server.uploadTtlMs > config.server.exportTtlMs, "kept export follows the upload TTL");
  assert.equal(first, config.server.uploadTtlMs > config.server.exportTtlMs ? 1 : 2);

  // Everything else past the longest TTL, except the slot a channel just read.
  for (const p of [up, kept, touched]) if (fs.existsSync(p)) age(path.dirname(p), longest + 1000);
  slots.touch(touched);
  slots.sweep();
  assert.equal(granted.has(up), false);
  assert.equal(granted.has(kept), false);
  assert.equal(slots.kept.size, 0, "dropping a kept slot forgets it");
  assert.equal(granted.has(touched), true, "touched slots survive");
  slots.touch("/not/granted"); // no throw
});

test("purgeAll removes every slot directory", (t) => {
  const { slots, uploadsDir, exportsDir } = make(t);
  slots.saveUpload("a.csv", Buffer.from("x"));
  slots.createExportSlot("b.csv");
  slots.purgeAll();
  assert.deepEqual(fs.readdirSync(uploadsDir), []);
  assert.deepEqual(fs.readdirSync(exportsDir), []);
});
