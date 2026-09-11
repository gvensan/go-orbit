// move-home.js - relocate the data home (`bin/orbit move <dir>`).
//
// The database key is bound to the data home's path (keys.js derives the
// keychain account from it), so simply moving the folder leaves the file
// unreadable. A move therefore copies the database and every snapshot to the
// new home and re-keys each copy to the key stored for the new path
// (SQLCipher's PRAGMA rekey), verifying before and after. The old folder and
// its key are left untouched: the user deletes them once the new home has
// proven itself. Nothing here is destructive.
//
// Run with the service stopped; the lock in the old home is checked.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");
const config = require("../main/config");
const { listBackups } = require("../main/db/backup-files");
const { resolvePaths, ensurePaths } = require("./paths");

const q = (s) => String(s).replace(/'/g, "''");

/** Open with `key`; true when the file passes quick_check under it. */
function opensWith(file, key) {
  let db = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma(`key = '${q(key)}'`);
    return db.pragma("quick_check", { simple: true }) === "ok";
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/** Re-encrypt `file` in place from oldKey to newKey, verifying both sides. */
function rekeyFile(file, oldKey, newKey) {
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma(`key = '${q(oldKey)}'`);
    let ok = false;
    try { ok = db.pragma("quick_check", { simple: true }) === "ok"; } catch { ok = false; } // SQLCipher reports a wrong key as "not a database"
    if (!ok) throw new Error(`${path.basename(file)} does not open with the old key`);
    db.pragma(`rekey = '${q(newKey)}'`);
  } finally {
    db.close();
  }
  if (!opensWith(file, newKey)) throw new Error(`${path.basename(file)} failed verification after re-keying`);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === "EPERM"; }
}

/**
 * @param {{ from: string, to: string, getKey: (paths: ReturnType<typeof resolvePaths>) => { key: string, backend: string },
 *           log?: (m: string) => void }} opts
 * @returns {{ to: string, backups: number, skipped: string[] }}
 */
function moveHome({ from, to, getKey, log = () => {} }) {
  const env = config.server.homeEnv;
  const src = resolvePaths({ [env]: from });
  const dst = resolvePaths({ [env]: to });
  if (path.resolve(src.home) === path.resolve(dst.home)) throw new Error("the new folder is the current data home");
  if (!fs.existsSync(src.dbPath)) throw new Error(`no database at ${src.dbPath}`);
  if (fs.existsSync(dst.home) && fs.readdirSync(dst.home).length) throw new Error(`${dst.home} exists and is not empty`);
  if (fs.existsSync(src.lockFile)) {
    const pid = parseInt(fs.readFileSync(src.lockFile, "utf8"), 10);
    if (pid && pidAlive(pid)) throw new Error(`the service (pid ${pid}) is still running on ${src.home}; stop it first (bin/orbit stop)`);
  }

  const oldKey = getKey(src).key;
  if (!opensWith(src.dbPath, oldKey)) {
    throw new Error("the current database does not open with the key stored for it; nothing was changed");
  }
  // Fold the WAL into the main file so a plain copy is complete.
  const live = new Database(src.dbPath);
  try { live.pragma(`key = '${q(oldKey)}'`); live.pragma("wal_checkpoint(TRUNCATE)"); } finally { live.close(); }

  ensurePaths(dst);
  const newKey = getKey(dst).key;
  log(`[move] key for ${dst.home} ready in the credential store`);

  fs.copyFileSync(src.dbPath, dst.dbPath);
  rekeyFile(dst.dbPath, oldKey, newKey);
  log(`[move] database copied and re-keyed`);

  /** @type {string[]} */
  const skipped = [];
  let backups = 0;
  for (const file of listBackups(src.backupDir)) {
    const target = path.join(dst.backupDir, path.basename(file));
    try {
      fs.copyFileSync(file, target);
      rekeyFile(target, oldKey, newKey);
      backups++;
    } catch (e) {
      try { fs.unlinkSync(target); } catch { /* nothing to remove */ }
      skipped.push(`${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log(`[move] ${backups} snapshot(s) copied and re-keyed${skipped.length ? `, ${skipped.length} skipped` : ""}`);

  if (fs.existsSync(src.tokenFile)) fs.copyFileSync(src.tokenFile, dst.tokenFile); // browsers stay signed in
  return { to: dst.home, backups, skipped };
}

module.exports = { moveHome, rekeyFile, opensWith };

if (require.main === module) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    process.stderr.write("usage: node src/server/move-home.js <current home> <new home>\n");
    process.exit(2);
  }
  const { getOrCreateDbKey } = require("./keys");
  try {
    const r = moveHome({ from, to, getKey: (p) => getOrCreateDbKey(p), log: (m) => process.stdout.write(m + "\n") });
    process.stdout.write(`Data moved to ${r.to} (${r.backups} snapshots). The old folder ${path.resolve(from)} was left in place; delete it once you are happy.\n`);
    for (const s of r.skipped) process.stdout.write(`  skipped ${s}\n`);
  } catch (e) {
    process.stderr.write(`Move failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
