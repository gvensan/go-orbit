#!/bin/bash
# Stop the demo instance started by seed.sh and remove every trace of it: the
# temp data home and the keychain item that held its database key.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOME_DIR="$(cat /tmp/orbit-demo-home.current 2>/dev/null || true)"
[ -n "$HOME_DIR" ] && [ -d "$HOME_DIR" ] || { echo "no demo instance recorded"; exit 0; }
NODE="${NODE:-$(readlink "$ROOT/bin/node" 2>/dev/null || command -v node)}"
if [ -f "$HOME_DIR/server.pid" ]; then kill -TERM "$(cat "$HOME_DIR/server.pid")" 2>/dev/null || true; sleep 1; fi
ORBIT_HOME="$HOME_DIR" "$NODE" -e '
  const { resolvePaths } = require(process.argv[1] + "/src/server/paths");
  const { deleteDbKey } = require(process.argv[1] + "/src/server/keys");
  console.log(deleteDbKey(resolvePaths()) ? "demo keychain item removed" : "could not remove the demo keychain item");
' "$ROOT"
rm -rf "$HOME_DIR" /tmp/orbit-demo-home.current
echo "demo instance stopped and removed"
