// Shared backup-directory listing and retention. The total cap is authoritative:
// pre-migration snapshots reserve up to keepPreMigration slots inside it rather
// than being added on top of it.

const fs = require("fs");
const path = require("path");
const config = require("../config");

function listBackups(backupDir) {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => path.join(backupDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function rotateBackups(backupDir, { keep = config.backup.keep, keepPreMigration = config.backup.keepPreMigration } = {}) {
  const all = listBackups(backupDir);
  const isPreMigration = (f) => path.basename(f).startsWith("pre-migration-");
  const pre = all.filter(isPreMigration).slice(0, Math.min(keep, keepPreMigration));
  const routine = all.filter((f) => !isPreMigration(f)).slice(0, Math.max(0, keep - pre.length));
  const retained = new Set([...pre, ...routine]);
  for (const old of all) {
    if (retained.has(old)) continue;
    try { fs.unlinkSync(old); } catch {}
  }
  return listBackups(backupDir);
}

module.exports = { listBackups, rotateBackups };
