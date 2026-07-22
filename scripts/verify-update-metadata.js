// Verify that a tagged multi-architecture build produced one usable update
// manifest for the current platform. Architecture-specific publishing jobs
// would overwrite this shared file and silently strand one architecture.

const fs = require("fs");
const path = require("path");

const platform = process.argv[2];
const manifestNames = {
  macOS: "latest-mac.yml",
  Windows: "latest.yml",
  Linux: "latest-linux.yml",
};
const manifestName = manifestNames[platform];

if (!manifestName) {
  console.error(`[update-metadata] unsupported platform: ${platform || "(missing)"}`);
  process.exit(1);
}

const manifestPath = path.join(__dirname, "..", "dist", manifestName);
if (!fs.existsSync(manifestPath)) {
  console.error(`[update-metadata] missing ${manifestPath}`);
  process.exit(1);
}

const manifest = fs.readFileSync(manifestPath, "utf8");
const urls = [...manifest.matchAll(/^\s*-\s+url:\s+(.+)$/gm)].map((match) => match[1].trim());
const hasArm64 = urls.some((url) => /(?:^|[-_.])arm64(?:[-_.]|$)/i.test(url));
const hasX64 = urls.some((url) => !/(?:^|[-_.])arm64(?:[-_.]|$)/i.test(url));
const hashes = [...manifest.matchAll(/^\s+sha512:\s+\S+/gm)];

if (!hasArm64 || !hasX64 || hashes.length < urls.length || urls.length < 2) {
  console.error(`[update-metadata] ${manifestName} must contain hashed ARM64 and x64 artifacts`);
  console.error(`[update-metadata] URLs: ${urls.join(", ") || "none"}`);
  process.exit(1);
}

console.log(`[update-metadata] OK — ${manifestName} covers ARM64 and x64 (${urls.length} artifacts)`);
