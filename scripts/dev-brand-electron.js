// dev-brand-electron.js - dev-only cosmetic fix for the macOS menu-bar app name.
//
// The bold application-menu title (next to the Apple logo) is read by macOS from
// the RUNNING bundle's CFBundleName. In dev we run Electron's own bundle
// (`electron .`), so it reads "Electron" - app.setName()/productName cannot
// override it. This stamps "Orbit" into the local dev Electron.app Info.plist so
// the menu bar reads "Orbit" in dev too. Packaged builds already read "Orbit"
// from productName, so this only touches the throwaway dev Electron.
//
// It does NOT change storage: userData and the safeStorage keychain key off
// app.getName() (package.json "name" = "orbit"), not the bundle's CFBundleName.
//
// Idempotent. No-op off macOS or when the bundle isn't present. Best-effort: any
// failure exits 0 so it can never block `npm run dev`.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const NAME = "Orbit";

if (process.platform !== "darwin") process.exit(0);

const appDir = path.join(__dirname, "..", "node_modules", "electron", "dist", "Electron.app");
const plist = path.join(appDir, "Contents", "Info.plist");
if (!fs.existsSync(plist)) process.exit(0);

const get = (key) => {
  try { return execFileSync("/usr/bin/plutil", ["-extract", key, "raw", plist], { encoding: "utf8" }).trim(); }
  catch { return null; }
};
const set = (key, val) => {
  try { execFileSync("/usr/bin/plutil", ["-replace", key, "-string", val, plist]); }
  catch { try { execFileSync("/usr/bin/plutil", ["-insert", key, "-string", val, plist]); } catch { /* ignore */ } }
};

if (get("CFBundleName") === NAME && get("CFBundleDisplayName") === NAME) process.exit(0);

set("CFBundleName", NAME);
set("CFBundleDisplayName", NAME);
// Editing the plist invalidates the ad-hoc signature; re-sign the top-level
// bundle so macOS still launches it. Best-effort - dev binaries usually run fine
// either way.
try { execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", appDir], { stdio: "ignore" }); } catch { /* ignore */ }

console.log(`[dev-brand] macOS menu-bar name set to "${NAME}" for the dev Electron.app`);
