// files.js - the browser cannot hand the service a filesystem path, so import
// and export ride through short-lived "slots" the service mints itself:
//
//   upload  browser POSTs the chosen file -> <home>/uploads/<slot>/<name>
//           the path is granted, and the import channels read it as they always did
//   export  browser asks for a slot -> <home>/exports/<slot>/<name> is granted,
//           the export channel writes it, the browser downloads it, and the file
//           is deleted the moment the download finishes
//
// Both directories hold contact data in plaintext for the duration, exactly as
// the user's own chosen file did on the desktop, which is why a slot lives only
// as long as it must: exports go on download (unless the user asked to reopen
// the file, then on the upload TTL), uploads on a TTL that is refreshed every
// time a channel reads the file, everything on boot. Names are sanitized to a
// basename; the extension survives because the import kind is detected from it.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("../main/config");

const UPLOAD_EXT = new Set([".vcf", ".vcard", ".csv", ".orbit"]);

function safeName(name, fallback) {
  // Browsers send a bare file name, but split on both separators anyway so a
  // Windows-style path from any client still yields its last segment.
  const last = String(name || "").split(/[\\/]/).pop() || "";
  const base = last.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_").trim();
  const trimmed = base.slice(0, 120);
  return trimmed && trimmed !== "." && trimmed !== ".." ? trimmed : fallback;
}

class FileSlots {
  /** @param {{ uploadsDir: string, exportsDir: string, grantedPaths: Set<string> }} opts */
  constructor({ uploadsDir, exportsDir, grantedPaths }) {
    this.uploadsDir = uploadsDir;
    this.exportsDir = exportsDir;
    this.granted = grantedPaths;
    /** Export slots the user asked to keep after download (import results the
     *  wizard reopens); they age out on the upload TTL instead of on download. */
    /** @type {Set<string>} */
    this.kept = new Set();
  }

  /** Refresh a granted path's slot so a flow in progress never expires under the user. */
  touch(p) {
    if (!this.granted.has(p)) return;
    const now = new Date();
    for (const target of [path.dirname(p), p]) {
      try { fs.utimesSync(target, now, now); } catch { /* file not written yet */ }
    }
  }

  /** After download, keep this export slot readable (import TTL) instead of deleting it. */
  keep(p) {
    if (this.isExportSlot(p)) this.kept.add(path.dirname(p));
  }

  /** Remove every slot (boot). */
  purgeAll() {
    for (const dir of [this.uploadsDir, this.exportsDir]) {
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const e of entries) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
    }
  }

  /** Remove slots older than their TTL and revoke their grants. */
  sweep(now = Date.now()) {
    let removed = 0;
    const pass = (dir, ttl, kept = new Set()) => {
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const e of entries) {
        const slot = path.join(dir, e);
        let st;
        try { st = fs.statSync(slot); } catch { continue; }
        const life = kept.has(slot) ? config.server.uploadTtlMs : ttl;
        if (now - st.mtimeMs < life) continue;
        this.dropSlot(slot);
        removed++;
      }
    };
    pass(this.uploadsDir, config.server.uploadTtlMs);
    pass(this.exportsDir, config.server.exportTtlMs, this.kept);
    return removed;
  }

  dropSlot(slotDir) {
    for (const p of [...this.granted]) if (p.startsWith(slotDir + path.sep)) this.granted.delete(p);
    this.kept.delete(slotDir);
    fs.rmSync(slotDir, { recursive: true, force: true });
  }

  newSlotDir(parent) {
    const dir = path.join(parent, crypto.randomBytes(8).toString("hex"));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * Persist an uploaded import file and grant its path.
   * @param {string} name @param {Buffer} buf
   * @returns {string} the granted absolute path
   */
  saveUpload(name, buf) {
    const safe = safeName(name, "import");
    if (!UPLOAD_EXT.has(path.extname(safe).toLowerCase())) {
      throw new RangeError("Unsupported file type. Use .vcf, .csv, or .orbit.");
    }
    const file = path.join(this.newSlotDir(this.uploadsDir), safe);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    this.granted.add(file);
    return file;
  }

  /**
   * Reserve a granted destination for an export; nothing is written yet.
   * @param {string} defaultName
   */
  createExportSlot(defaultName) {
    const file = path.join(this.newSlotDir(this.exportsDir), safeName(defaultName, "export"));
    this.granted.add(file);
    return file;
  }

  /** True when `p` is a granted file inside an export slot. */
  isExportSlot(p) {
    const root = path.resolve(this.exportsDir) + path.sep;
    return typeof p === "string" && this.granted.has(p) && path.resolve(p).startsWith(root);
  }

  /** Delete an export slot after it was downloaded. */
  consumeExport(p) {
    this.dropSlot(path.dirname(p));
  }
}

module.exports = { FileSlots, safeName, UPLOAD_EXT };
