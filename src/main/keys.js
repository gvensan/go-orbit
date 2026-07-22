// keys.js - database key management (docs/SECURITY_AND_THREAT_MODEL.md §4).
//
// A random 256-bit key is generated on first run and stored encrypted by the
// OS keychain via Electron safeStorage (Keychain / DPAPI / libsecret). The key
// never touches disk in plaintext and is never logged. It is device-bound by
// design: moving devices uses export/import with a separate passphrase.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { safeStorage } = require("electron");

const KEY_FILE = "dbkey.bin";

/**
 * @param {string} userDataDir
 * @returns {string} hex key for the SQLCipher `key` pragma
 */
function getOrCreateDbKey(userDataDir) {
  if (!safeStorage.isEncryptionAvailable()) {
    // Failing closed is deliberate: a plaintext key on disk would defeat
    // encryption at rest. On Linux this usually means no secret service.
    throw new Error(
      "OS keychain is unavailable; refusing to store the database key insecurely. " +
        "See docs/SECURITY_AND_THREAT_MODEL.md §4."
    );
  }
  const file = path.join(userDataDir, KEY_FILE);
  if (fs.existsSync(file)) {
    return safeStorage.decryptString(fs.readFileSync(file));
  }
  const key = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 });
  return key;
}

module.exports = { getOrCreateDbKey, KEY_FILE };
