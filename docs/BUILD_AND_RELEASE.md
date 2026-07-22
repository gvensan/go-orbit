# Build & Release — Requirements

**Status:** Implemented. Milestone M6 signing credentials still need to be
configured in the GitHub repository before the first public release.
**Config artifacts:** `electron-builder.yml`, `.github/workflows/build.yml`.

## 1. The constraint that shapes everything

The app bundles a native module (`better-sqlite3-multiple-ciphers`). Native
modules compile to a platform+arch-specific binary and cannot be reliably
cross-compiled. So each platform is built on its own OS. There is no shortcut
around this; do not attempt Windows-from-macOS via Wine with a native module in
the tree.

The development tree also keeps one ABI: the pinned stable Electron runtime.
`postinstall` force-rebuilds and smoke-tests the addon, while tests, migrations,
and fixtures use Electron's embedded-Node mode. Do not rebuild the addon with
standalone `npm rebuild`; that would replace it with an incompatible Node ABI.

## 2. Build matrix

A GitHub Actions matrix, one runner per OS, each running `electron-builder`,
which invokes `@electron/rebuild` to rebuild the native module against Electron's
ABI for that platform+arch.

| OS | Runner | Outputs | Arch |
|---|---|---|---|
| macOS | `macos-latest`, `macos-15-intel` | `.dmg`, `.zip` | `arm64`, `x64` |
| Windows | `windows-11-arm`, `windows-latest` | NSIS `.exe`, portable | `arm64`, `x64` |
| Linux | `ubuntu-24.04-arm`, `ubuntu-latest` | `AppImage`, `.deb`, `.rpm` | `arm64`, `x64` |

Each architecture is built and smoke-tested on a native runner. Do not combine
architectures in one job: electron-builder's final native rebuild can leave the
workspace addon compiled for the other architecture even when the packaged app
itself is correct.

Tagged publishing is the deliberate exception: each platform builds both
already-validated architectures together so electron-builder emits a single
`latest-*.yml` containing every architecture. Separate publishing jobs would
race to overwrite that shared auto-update metadata file.

Release CI verifies the resulting macOS bundle with `codesign` and Gatekeeper,
every Windows installer with `Get-AuthenticodeSignature`, and each platform's
update manifest for hashed ARM64 and x64 artifacts. Missing credentials or
incomplete update metadata fail the release. Artifacts remain in a private
GitHub draft until every platform passes; only then does CI publish the release
and make it visible to the auto-updater.

## 3. Signing & notarization

Required, and coupled to auto-update — unsigned updates won't install.

- **macOS:** Developer ID cert; sign then notarize with `notarytool`; staple. Secrets: cert (base64 p12), password, Apple ID / API key, team id.
- **Windows:** Authenticode sign the installer or users hit SmartScreen. Secret: signing cert + password (or an EV/cloud signer).
- **Linux:** no signing required; AppImage is the portable default.

Secrets live in GitHub Actions encrypted secrets, never in the repo.

## 4. Auto-update

`electron-updater` against a GitHub Releases feed (configured in
`electron-builder.yml` `publish`). Behavior:

- Check on launch and periodically; download in the background; apply on next restart.
- **Take a backup before applying** (`config.update.backupBeforeApply`) — an update may run migrations on next boot.
- Surface current version + a manual "check now" in Settings.
- Updates must be signed or they will not install; the same certs from §3.
- Development/source runs do not initialize the updater and make no release-feed requests.

## 5. Versioning & channels

- SemVer. The app version, the archive `appVersion`, and the release tag stay in lockstep.
- `schemaVersion` (DB) is independent of app version; migrations bridge it.
- One stable channel to start; a `beta` prerelease channel is optional later.

## 6. Reproducibility

- Pin Node and Electron versions; commit the lockfile; CI uses `npm ci`.
- Cache `node_modules` and the Electron download per-OS to keep builds fast.
- Main-branch and pull-request builds are retained as unsigned GitHub Actions
  artifacts for 14 days. They are validation builds, not for distribution.
- Tagged builds are the only ones published to GitHub Releases. A tag must match
  the version in `package.json` (for example, version `0.2.0` uses tag `v0.2.0`).

### Dependency currency policy

- Audit direct and transitive packages before each release with `npm outdated`
  and `npm audit`; use stable release tags only.
- Keep direct versions exact in `package.json` and update `package-lock.json` in
  the same change. This makes a validated combination reproducible on every OS.
- Keep Electron on the newest stable supported major after the cross-platform
  build/smoke matrix passes. Its embedded Node major controls `@types/node` and
  the native SQLite ABI; a numerically newer standalone Node type package is not
  automatically compatible.
- Framework, graph-engine, database, or native-addon upgrades require typecheck,
  all tests, renderer build, native ABI verification, and the encrypted startup
  smoke test. Database changes additionally require archive round-trip,
  migration-backup, corruption-recovery, and wrong-key tests.
- Never accept a major update solely because it is listed by `npm outdated`.
  Review release notes and peer/engine constraints first; document any held-back
  package and the compatibility reason.

## 7. Acceptance criteria

1. A tagged release produces installers for macOS, Windows, and Linux from one workflow run.
2. The native module loads on each platform (a smoke test opens an encrypted DB post-build).
3. macOS artifacts are notarized and stapled; Windows artifacts are Authenticode-signed.
4. An `electron-updater` client detects, downloads, and applies a newer signed release.
5. A backup is taken before an update is applied.
