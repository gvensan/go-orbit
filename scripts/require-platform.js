// Guard for the per-OS release scripts. Orbit bundles a native module
// (better-sqlite3-multiple-ciphers) that node-gyp cannot cross-compile, so each
// OS's installers must be built on that OS. Fail fast with a clear message
// instead of a deep node-gyp stack trace when run on the wrong platform.

const want = process.argv[2]; // "win32" | "darwin" | "linux"
const LABEL = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const label = LABEL[want] || want;

if (process.platform !== want) {
  const here = LABEL[process.platform] || process.platform;
  console.error(
    `\n[release] ${label} installers must be built on ${label}.` +
    `\nYou are on ${here}, and the native SQLite module cannot cross-compile.` +
    `\nBuild on a ${label} machine, or let CI (native ${label} runner) do it.\n`
  );
  process.exit(1);
}
