#!/bin/bash
# Remove the Orbit login agent. Your data stays unless you pass --purge, which
# deletes the data home (encrypted database, backups, logs) and the database key
# from the OS credential store. --purge asks first: it is the one irreversible step.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORBIT_HOME="${ORBIT_HOME:-$HOME/.orbit}"

if [ "$(uname)" = "Darwin" ]; then
  "$ROOT/bin/orbit" uninstall
fi

if [ "${1:-}" = "--purge" ]; then
  echo
  echo "This deletes EVERYTHING in $ORBIT_HOME (your encrypted contacts, every backup) and the database key."
  echo "There is no undo. Export an .orbit archive first if you might want this data again."
  read -r -p "Type DELETE to continue: " answer
  if [ "$answer" != "DELETE" ]; then echo "kept everything"; exit 0; fi
  NODE="$(readlink "$ROOT/bin/node" 2>/dev/null || command -v node || true)"
  if [ -n "$NODE" ] && [ -x "$NODE" ]; then
    ORBIT_HOME="$ORBIT_HOME" "$NODE" -e '
      const { resolvePaths } = require(process.argv[1] + "/src/server/paths");
      const { deleteDbKey } = require(process.argv[1] + "/src/server/keys");
      const ok = deleteDbKey(resolvePaths());
      console.log(ok ? "database key removed from the credential store" : "could not remove the database key; remove the \"orbit\" item by hand");
    ' "$ROOT" || true
  fi
  rm -rf "$ORBIT_HOME"
  echo "removed $ORBIT_HOME"
else
  echo "Your data is untouched in $ORBIT_HOME (re-run with --purge to delete it)."
fi
