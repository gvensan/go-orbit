// Launch the runner-native unpacked application produced by electron-builder.
// The app's ORBIT_PACKAGED_SMOKE mode uses only a disposable DB and exits 0 after
// proving that the packaged Electron ABI, SQLCipher, and migrations work.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

function existing(candidates) {
  return candidates.find((file) => fs.existsSync(file));
}

let extractedDir = null;

function prepareMacBundle(bundle) {
  const verified = spawnSync("codesign", ["--verify", "--deep", "--strict", bundle]);
  if (verified.status === 0) return path.join(bundle, "Contents", "MacOS", "Orbit");
  if (!extractedDir) {
    extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-packaged-"));
    const copy = spawnSync("ditto", [bundle, path.join(extractedDir, "Orbit.app")], { encoding: "utf8" });
    if (copy.status !== 0) return null;
    bundle = path.join(extractedDir, "Orbit.app");
  }
  // Pull-request artifacts intentionally skip Developer ID signing. Modern
  // macOS blocks them before main() with a generic malware alert. Ad-hoc sign
  // only this disposable copy so CI can exercise the packaged native code.
  const signed = spawnSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { encoding: "utf8" });
  if (signed.status !== 0) {
    if (signed.stderr) process.stderr.write(signed.stderr);
    return null;
  }
  return path.join(bundle, "Contents", "MacOS", "Orbit");
}

function executable() {
  if (process.platform === "win32") {
    return existing([
      path.join(DIST, "win-unpacked", "Orbit.exe"),
      path.join(DIST, "win-arm64-unpacked", "Orbit.exe"),
    ]);
  }
  if (process.platform === "darwin") {
    const dirs = process.arch === "arm64"
      ? ["mac-arm64", "mac-universal"]
      : ["mac", "mac-x64", "mac-universal"];
    const unpacked = existing(dirs.map((dir) => path.join(DIST, dir, "Orbit.app")));
    if (unpacked) return prepareMacBundle(unpacked);
    // A multi-arch mac build may retain only the last unpacked architecture.
    // Smoke the runner-native ZIP in that case instead of accidentally trying
    // to execute an x64 bundle on an arm64 runner (or vice versa).
    const suffix = process.arch === "arm64" ? "-arm64-mac.zip" : "-mac.zip";
    const archive = fs.readdirSync(DIST).find((name) => name.endsWith(suffix));
    if (!archive) return null;
    extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-packaged-"));
    const extracted = spawnSync("ditto", ["-x", "-k", path.join(DIST, archive), extractedDir], { encoding: "utf8" });
    if (extracted.status !== 0) {
      if (extracted.stderr) process.stderr.write(extracted.stderr);
      return null;
    }
    return prepareMacBundle(path.join(extractedDir, "Orbit.app"));
  }
  return existing([
    path.join(DIST, "linux-unpacked", "orbit"),
    path.join(DIST, "linux-arm64-unpacked", "orbit"),
  ]);
}

const app = executable();
if (!app) {
  console.error(`[packaged-smoke] no runner-native unpacked application found under ${DIST}`);
  process.exit(1);
}

const result = spawnSync(app, [], {
  cwd: ROOT,
  env: { ...process.env, ORBIT_PACKAGED_SMOKE: "1" },
  encoding: "utf8",
  timeout: 60_000,
});
if (extractedDir) fs.rmSync(extractedDir, { recursive: true, force: true });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error("[packaged-smoke] launch failed:", result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[packaged-smoke] application exited ${result.status}${result.signal ? ` (${result.signal})` : ""}`);
  process.exit(result.status ?? 1);
}
