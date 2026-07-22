// Run a Node-oriented script with Electron's embedded Node runtime. This keeps
// native dependencies on one ABI across development, tests, migrations, and
// packaging instead of rewriting the same .node binary back and forth.

const { spawnSync } = require("child_process");
const electron = /** @type {string} */ (/** @type {unknown} */ (require("electron")));

const result = spawnSync(electron, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
