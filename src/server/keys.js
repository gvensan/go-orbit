// keys.js - database key management for the service (SECURITY §4).
//
// The desktop build wrapped a random 256-bit key with Electron's safeStorage.
// Plain Node has no such API, so the service uses the OS's own credential
// store through the tool every machine already has:
//   macOS    `security` (login keychain), commands fed over stdin so the key
//            never appears in a process listing
//   Linux    `secret-tool` (Secret Service / GNOME Keyring / KWallet)
//   Windows  PowerShell DPAPI (ProtectedData, CurrentUser scope); the wrapped
//            blob lives in <home>/dbkey.bin, mirroring the desktop layout
// The key never touches disk in plaintext and is never logged. If no store is
// reachable the service refuses to start rather than fall back to a plaintext
// key: encryption at rest is the point of the app.
//
// The keychain account is derived from the data home, so two homes on one
// machine (say, a test profile) never share a key.

const crypto = require("crypto");
const fs = require("fs");
const { spawnSync } = require("child_process");

const SERVICE = "orbit";
const KEY_RE = /^[0-9a-f]{64}$/;

/** @param {string} home */
function accountFor(home) {
  return "db:" + crypto.createHash("sha256").update(home).digest("hex").slice(0, 16);
}

/** Default command runner; tests inject a fake. */
function defaultRun(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout: 20000 });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error };
}

class KeyStoreError extends Error {
  /** @param {string} message @param {string} fix */
  constructor(message, fix) {
    super(message);
    this.name = "KeyStoreError";
    this.fix = fix;
  }
}

function checkKey(key, backend) {
  const k = String(key || "").trim();
  if (!KEY_RE.test(k)) {
    throw new KeyStoreError(
      `The ${backend} returned an unusable database key.`,
      "The stored key is damaged. Restore from an .orbit archive after removing the item, or contact support."
    );
  }
  return k;
}

const shellQuote = (s) => `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;

// --- macOS -----------------------------------------------------------------

function darwin(paths, run) {
  const acct = accountFor(paths.home);
  const read = () => run("security", ["find-generic-password", "-s", SERVICE, "-a", acct, "-w"]);
  const fix = "Open Keychain Access and make sure the login keychain is unlocked, then run bin/orbit restart.";
  let r = read();
  if (r.error) throw new KeyStoreError("The macOS keychain tool (security) could not be run.", fix);
  if (r.status === 0) return { key: checkKey(r.stdout, "macOS keychain"), backend: "macOS keychain" };
  if (r.status !== 44) {
    // 44 = errSecItemNotFound; anything else is a locked or unreachable keychain.
    throw new KeyStoreError(`The macOS keychain refused the request (security exited ${r.status}).`, fix);
  }
  const key = crypto.randomBytes(32).toString("hex");
  // `security -i` reads commands from stdin, so the key stays out of argv.
  const cmd = `add-generic-password -a ${shellQuote(acct)} -s ${shellQuote(SERVICE)} -l "Orbit database key" -w ${shellQuote(key)} -U\n`;
  r = run("security", ["-i"], cmd);
  if (r.error || r.status !== 0) {
    throw new KeyStoreError("Could not store the database key in the macOS keychain.", fix);
  }
  r = read();
  if (r.status !== 0 || checkKey(r.stdout, "macOS keychain") !== key) {
    throw new KeyStoreError("The macOS keychain did not return the key it just stored.", fix);
  }
  return { key, backend: "macOS keychain" };
}

function darwinDelete(paths, run) {
  const r = run("security", ["delete-generic-password", "-s", SERVICE, "-a", accountFor(paths.home)]);
  return !r.error && (r.status === 0 || r.status === 44);
}

// --- Linux -----------------------------------------------------------------

function linux(paths, run) {
  const acct = accountFor(paths.home);
  const fix = "Install libsecret's secret-tool (apt: libsecret-tools, dnf: libsecret) and make sure a Secret Service (GNOME Keyring or KWallet) is running in your session.";
  const read = () => run("secret-tool", ["lookup", "service", SERVICE, "account", acct]);
  let r = read();
  if (r.error) throw new KeyStoreError("secret-tool is not installed, so the database key cannot be stored securely.", fix);
  if (r.status === 0 && r.stdout.trim()) return { key: checkKey(r.stdout, "Secret Service"), backend: "Secret Service" };
  if (r.status !== 0 && r.status !== 1) {
    throw new KeyStoreError(`The Secret Service refused the request (secret-tool exited ${r.status}).`, fix);
  }
  const key = crypto.randomBytes(32).toString("hex");
  r = run("secret-tool", ["store", "--label=Orbit database key", "service", SERVICE, "account", acct], key);
  if (r.error || r.status !== 0) throw new KeyStoreError("Could not store the database key in the Secret Service.", fix);
  r = read();
  if (r.status !== 0 || checkKey(r.stdout, "Secret Service") !== key) {
    throw new KeyStoreError("The Secret Service did not return the key it just stored.", fix);
  }
  return { key, backend: "Secret Service" };
}

function linuxDelete(paths, run) {
  const r = run("secret-tool", ["clear", "service", SERVICE, "account", accountFor(paths.home)]);
  return !r.error && r.status === 0;
}

// --- Windows ---------------------------------------------------------------

const PS_PROTECT = `Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); $b=[Text.Encoding]::UTF8.GetBytes($s); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($p))`;
const PS_UNPROTECT = `Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($s); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))`;

function win32(paths, run) {
  const fix = "Make sure Windows PowerShell is available on PATH and that this Windows account can use DPAPI (it always can for a normal local or domain user).";
  const ps = (script, input) => run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], input);
  if (fs.existsSync(paths.keyFile)) {
    const blob = fs.readFileSync(paths.keyFile, "utf8");
    const r = ps(PS_UNPROTECT, blob);
    if (r.error || r.status !== 0) throw new KeyStoreError("Windows could not unwrap the database key (DPAPI).", fix);
    return { key: checkKey(r.stdout, "Windows DPAPI"), backend: "Windows DPAPI" };
  }
  const key = crypto.randomBytes(32).toString("hex");
  const r = ps(PS_PROTECT, key);
  if (r.error || r.status !== 0 || !r.stdout.trim()) throw new KeyStoreError("Windows could not wrap the database key (DPAPI).", fix);
  fs.writeFileSync(paths.keyFile, r.stdout.trim(), { mode: 0o600 });
  return { key, backend: "Windows DPAPI" };
}

function win32Delete(paths) {
  try { fs.unlinkSync(paths.keyFile); } catch { /* already gone */ }
  return true;
}

// --- entry -----------------------------------------------------------------

/**
 * @param {{ home: string, keyFile: string }} paths
 * @param {{ platform?: string, run?: typeof defaultRun }} [opts]
 * @returns {{ key: string, backend: string }}
 */
function getOrCreateDbKey(paths, { platform = process.platform, run = defaultRun } = {}) {
  if (platform === "darwin") return darwin(paths, run);
  if (platform === "linux") return linux(paths, run);
  if (platform === "win32") return win32(paths, run);
  throw new KeyStoreError(
    `No credential store is supported on ${platform}; refusing to store the database key in plaintext.`,
    "Run Orbit on macOS, Linux with a Secret Service, or Windows."
  );
}

/** Remove the stored key (uninstall --purge). Returns true when nothing remains. */
function deleteDbKey(paths, { platform = process.platform, run = defaultRun } = {}) {
  if (platform === "darwin") return darwinDelete(paths, run);
  if (platform === "linux") return linuxDelete(paths, run);
  if (platform === "win32") return win32Delete(paths);
  return true;
}

module.exports = { getOrCreateDbKey, deleteDbKey, accountFor, KeyStoreError, SERVICE };
