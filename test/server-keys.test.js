// Database key storage through the OS credential tools, with the tool calls
// faked: the flows must create-then-verify, never fall back to plaintext, and
// keep the key out of argv on macOS.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { getOrCreateDbKey, deleteDbKey, accountFor, KeyStoreError, SERVICE } = require("../src/server/keys");
const { tmpDir } = require("./helpers");

const HEX64 = /^[0-9a-f]{64}$/;

/** A scripted spawnSync stand-in: each call pops the next reply. */
function fakeRunner(script) {
  const calls = [];
  const run = (cmd, args, input) => {
    calls.push({ cmd, args, input });
    const step = script.shift();
    if (!step) throw new Error(`unexpected call ${cmd} ${args.join(" ")}`);
    return typeof step === "function" ? step({ cmd, args, input }) : step;
  };
  return { run, calls };
}

test("macOS: first run creates the key over stdin and reads it back", (t) => {
  const paths = { home: tmpDir(t), keyFile: "" };
  /** @type {string} */
  let stored = "";
  const { run, calls } = fakeRunner([
    { status: 44, stdout: "", stderr: "could not be found" },
    ({ input }) => { stored = /-w "([0-9a-f]{64})"/.exec(input)[1]; return { status: 0, stdout: "", stderr: "" }; },
    () => ({ status: 0, stdout: stored + "\n", stderr: "" }),
  ]);
  const r = getOrCreateDbKey(paths, { platform: "darwin", run });
  assert.equal(r.backend, "macOS keychain");
  assert.match(r.key, HEX64);
  assert.equal(r.key, stored);
  assert.deepEqual(calls[0].args, ["find-generic-password", "-s", SERVICE, "-a", accountFor(paths.home), "-w"]);
  assert.deepEqual(calls[1].args, ["-i"], "key must travel over stdin, not argv");
  assert.match(calls[1].input, /add-generic-password/);
  assert.equal(calls.length, 3);
});

test("macOS: an existing key is read without writing anything", (t) => {
  const paths = { home: tmpDir(t), keyFile: "" };
  const key = "c".repeat(64);
  const { run, calls } = fakeRunner([{ status: 0, stdout: key + "\n", stderr: "" }]);
  assert.equal(getOrCreateDbKey(paths, { platform: "darwin", run }).key, key);
  assert.equal(calls.length, 1);
});

test("macOS: a locked keychain or a damaged item fails closed with a fix", (t) => {
  const paths = { home: tmpDir(t), keyFile: "" };
  assert.throws(
    () => getOrCreateDbKey(paths, { platform: "darwin", run: fakeRunner([{ status: 36, stdout: "", stderr: "interaction not allowed" }]).run }),
    (e) => e instanceof KeyStoreError && /keychain/i.test(e.message) && e.fix.length > 10
  );
  assert.throws(
    () => getOrCreateDbKey(paths, { platform: "darwin", run: fakeRunner([{ status: 0, stdout: "not-a-key\n", stderr: "" }]).run }),
    (e) => e instanceof KeyStoreError && /unusable/.test(e.message)
  );
  assert.throws(
    () => getOrCreateDbKey(paths, { platform: "darwin", run: fakeRunner([{ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }]).run }),
    KeyStoreError
  );
});

test("Linux: secret-tool store then lookup; missing tool fails closed", (t) => {
  const paths = { home: tmpDir(t), keyFile: "" };
  let stored = "";
  const { run, calls } = fakeRunner([
    { status: 1, stdout: "", stderr: "" },
    ({ input }) => { stored = input; return { status: 0, stdout: "", stderr: "" }; },
    () => ({ status: 0, stdout: stored, stderr: "" }),
  ]);
  const r = getOrCreateDbKey(paths, { platform: "linux", run });
  assert.equal(r.backend, "Secret Service");
  assert.match(r.key, HEX64);
  assert.equal(calls[1].args[0], "store");
  assert.throws(
    () => getOrCreateDbKey(paths, { platform: "linux", run: fakeRunner([{ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }]).run }),
    (e) => e instanceof KeyStoreError && /secret-tool/.test(e.message)
  );
});

test("Windows: DPAPI blob lands in dbkey.bin and unwraps on the next run", (t) => {
  const home = tmpDir(t);
  const paths = { home, keyFile: path.join(home, "dbkey.bin") };
  let wrapped = "";
  const first = fakeRunner([({ input }) => { wrapped = Buffer.from(input).toString("base64"); return { status: 0, stdout: wrapped, stderr: "" }; }]);
  const r1 = getOrCreateDbKey(paths, { platform: "win32", run: first.run });
  assert.match(r1.key, HEX64);
  assert.equal(fs.readFileSync(paths.keyFile, "utf8"), wrapped);
  assert.match(first.calls[0].args.join(" "), /ProtectedData\]::Protect/);

  const second = fakeRunner([({ input }) => ({ status: 0, stdout: Buffer.from(input.trim(), "base64").toString("utf8"), stderr: "" })]);
  const r2 = getOrCreateDbKey(paths, { platform: "win32", run: second.run });
  assert.equal(r2.key, r1.key);
  assert.match(second.calls[0].args.join(" "), /ProtectedData\]::Unprotect/);

  assert.equal(deleteDbKey(paths, { platform: "win32" }), true);
  assert.equal(fs.existsSync(paths.keyFile), false);
});

test("an unsupported platform never gets a plaintext key", (t) => {
  const paths = { home: tmpDir(t), keyFile: "" };
  assert.throws(() => getOrCreateDbKey(paths, { platform: "freebsd", run: fakeRunner([]).run }), KeyStoreError);
});

test("the keychain account is derived from the data home", (t) => {
  const a = accountFor("/Users/a/.orbit");
  const b = accountFor("/Users/b/.orbit");
  assert.notEqual(a, b);
  assert.equal(a, accountFor("/Users/a/.orbit"));
  assert.match(a, /^db:[0-9a-f]{16}$/);
});
