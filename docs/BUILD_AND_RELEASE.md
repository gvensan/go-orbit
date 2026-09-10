# Build, Install & Update

**Status:** Authoritative for the service. Replaces the Electron packaging,
signing and auto-update plan (see `DECISIONS.md`, 2026-09-10).

## 1. The constraint that shapes everything

Orbit is a Node service plus a static bundle. There is no installer to sign, no
per-platform binary, and no update feed. "Building" is `vite build`; "installing"
is registering the service to start at login; "updating" is pulling code,
rebuilding, and restarting. The one native piece, the encrypted SQLite addon,
ships prebuilt for Node 20 through 26 and installs without a compiler.

## 2. Requirements

- Node 24 LTS (`.nvmrc`; `engines` in `package.json`).
- macOS for the scripted login agent (`launchd`). Linux and Windows run the
  service in the foreground (`bin/orbit run`) or under the user's own supervisor
  (a systemd user unit, Task Scheduler). The service itself is cross-platform.
- A credential store: the macOS keychain, a Secret Service on Linux
  (`secret-tool`), DPAPI on Windows. No store, no start (SECURITY §4).

## 3. Install

`install.sh` (or `bin/orbit install` on macOS):

1. `bin/orbit node` finds Node 24 (nvm default, newest nvm, Volta, Homebrew, PATH)
   and symlinks it at `bin/node`, so the agent survives PATH changes.
2. `bin/orbit build` runs `npm install` if `node_modules` is missing and
   `npm run build` if `dist/renderer/index.html` is missing.
3. `launchd/dev.orbit.plist.tmpl` is rendered with the repo root, `HOME`, the
   port and the data home, then bootstrapped in the user's `gui/<uid>` domain.
   `RunAtLoad` starts it now and at every login. `KeepAlive.SuccessfulExit=false`
   restarts it only after a non-zero exit, which is how a restore or update
   asks for a fresh process while `bin/orbit stop` stays down.
4. `bin/orbit open` opens the launch URL, which carries the session token and
   sets the cookie (SECURITY §5).

Data never lives in the repo: `~/.orbit` (or `ORBIT_HOME`) holds the database,
backups, tile cache, logs, session token and the short-lived import/export
slots. The repo can be deleted and re-cloned without losing anything.

## 4. Update

`bin/orbit update`: `git pull --ff-only`, `npm install`, `npm run build`,
restart. A copy not installed with git reruns `install.sh` from a fresh
download; the data home is untouched.

In the UI, the top-bar pill lights up when the code on disk is newer than the
running process (`update:status`, phase `ready`). Clicking it takes a verified
snapshot and restarts the service; the page waits for the new process and
reloads. Nothing is downloaded by the service itself.

## 5. Ports and homes

| Setting | Default | Override |
|---|---|---|
| Port | `config.server.port` (7779) | `ORBIT_PORT` |
| Data home | `~/.orbit` | `ORBIT_HOME` |
| Bind address | `127.0.0.1` | none, by design |

Two services on one data home cannot happen: a pid lock in the home refuses the
second, and the port refuses a second listener.

## 6. Reproducibility

- `package-lock.json` is committed; CI uses `npm ci`.
- `npm run verify:native` proves the addon loads on the running Node and that
  FTS5 is compiled in, on every OS in CI.
- The renderer bundle is deterministic for a given lockfile; it is not
  committed, it is built at install and update.

## 7. Acceptance criteria

1. On a clean macOS with Node 24 and no compiler, `./install.sh` ends with the
   UI open in the browser and `bin/orbit doctor` all green.
2. `bin/orbit stop` leaves the service down through a `launchctl kickstart`-free
   wait; `bin/orbit start` brings it back; a restore restarts it on its own.
3. `bin/orbit update` on a repo with newer commits ends with the new version in
   `/api/health` and the same contacts in the UI.
4. Deleting the repo and cloning it again, then `./install.sh`, shows the same
   data (the key and the database were never in the repo).
5. `npm ci && npm test && npm run typecheck && npm run build` pass on macOS,
   Linux and Windows CI.
