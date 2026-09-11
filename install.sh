#!/bin/bash
# One-step install for Orbit.
#
#   From a git clone or an unpacked download, inside the folder:   bash install.sh
#   Without downloading anything first (installs to ~/orbit):
#     curl -fsSL https://raw.githubusercontent.com/gvensan/go-orbit/main/install.sh | bash
#
# Set ORBIT_DIR to install somewhere other than ~/orbit.
#
# Installs dependencies (the encrypted SQLite addon arrives prebuilt for Node 24,
# no compiler needed), builds the web UI, and on macOS registers the service as a
# login agent and opens it in your browser. Elsewhere it leaves you with
# `bin/orbit run` to start the service in the foreground.
#
# Your data never lives in this folder: it goes to ~/.orbit (or ORBIT_HOME).
set -euo pipefail

REPO="${ORBIT_REPO:-gvensan/go-orbit}"
BRANCH="${ORBIT_BRANCH:-main}"
TARBALL="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"

# Where is the code? Next to this script when run from a folder; downloaded when piped from curl.
ROOT=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$ROOT/src/server/server.js" ] || ROOT=""
fi

if [ -z "$ROOT" ]; then
  ROOT="${ORBIT_DIR:-$HOME/orbit}"
  echo "Downloading Orbit to $ROOT"
  tmp="$(mktemp -d)"
  curl -fsSL "$TARBALL" | tar -xz -C "$tmp" || { echo "download failed"; rm -rf "$tmp"; exit 1; }
  src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
  mkdir -p "$ROOT"
  if [ -f "$ROOT/src/server/server.js" ]; then
    # Already installed here: update the code, keep deps and the built UI (rebuilt below).
    mkdir -p "$ROOT/bin"; cp "$src/bin/orbit" "$ROOT/bin/orbit"; chmod +x "$ROOT/bin/orbit"
    "$ROOT/bin/orbit" update-from "$src"
  else
    cp -R "$src/." "$ROOT/"
  fi
  rm -rf "$tmp"
fi

# Zip extraction can drop execute bits; git and tar keep them. Fix either way.
chmod +x "$ROOT/bin/orbit" "$ROOT/install.sh" "$ROOT/uninstall.sh" 2>/dev/null || true

echo "Installing Orbit from $ROOT"
"$ROOT/bin/orbit" node
"$ROOT/bin/orbit" build

if [ "$(uname)" = "Darwin" ]; then
  "$ROOT/bin/orbit" install
  echo
  echo "Opening Orbit in your browser."
  sleep 1
  "$ROOT/bin/orbit" open || true
  cat <<MSG

Done. Orbit runs at login and keeps your contacts encrypted in ${ORBIT_HOME:-$HOME/.orbit}.

Commands (from $ROOT):
  bin/orbit open              open the UI (use this link, it carries your session)
  bin/orbit status | doctor | logs
  bin/orbit update            pull the newest code, rebuild, restart
  bin/orbit stop | start
  ./uninstall.sh [--purge]    remove the login agent (and, with --purge, all data)
MSG
else
  cat <<MSG

Done. This system has no scripted login agent; start Orbit in the foreground with:
  bin/orbit run
then, in another terminal, open it with:
  bin/orbit open
To run it at login, wrap 'bin/orbit run' in a systemd user unit or Task Scheduler task.
MSG
fi
