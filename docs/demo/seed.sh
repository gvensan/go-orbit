#!/bin/bash
# Start a throwaway Orbit instance with the small sample network, for recording
# the README walkthrough. Nothing touches your real ~/.orbit: the data home is a
# temp folder, and its database key is a separate keychain item that stop.sh
# removes again.
#
#   docs/demo/seed.sh [port]          then:  node docs/demo/record.mjs http://localhost:PORT /tmp/orbit-demo TOKEN
#   docs/demo/stop.sh                 kills the instance, deletes its home and keychain item
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${1:-7790}"
HOME_DIR="$(mktemp -d /tmp/orbit-demo-home.XXXX)"
NODE="${NODE:-$(readlink "$ROOT/bin/node" 2>/dev/null || command -v node)}"
[ -f "$ROOT/dist/renderer/index.html" ] || (cd "$ROOT" && "$NODE" "$(dirname "$NODE")/npm" run build >/dev/null)
ORBIT_HOME="$HOME_DIR" ORBIT_PORT="$PORT" "$NODE" "$ROOT/src/server/server.js" > "$HOME_DIR/server.log" 2>&1 &
echo $! > "$HOME_DIR/server.pid"
echo "$HOME_DIR" > /tmp/orbit-demo-home.current
for i in $(seq 1 40); do curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.25; done
TOKEN="$(tr -d '\n' < "$HOME_DIR/session-token")"
B="http://localhost:$PORT"
rpc() { curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$2" "$B/api/rpc/$1"; }
rpc data:seedSample '{"dataset":"small"}' >/dev/null
# Make the sample people feel lived-in: a few interactions so Insights and the
# palette's recency ranking have something to show.
for id in 5 9 14 22; do
  rpc interactions:add "{\"contactId\":$id,\"occurredAt\":$(( $(date +%s) * 1000 - id * 86400000 )),\"kind\":\"meeting\",\"note\":\"coffee catch-up\"}" >/dev/null || true
done
echo "demo instance on $B, data in $HOME_DIR (pid $(cat "$HOME_DIR/server.pid"))"
echo "  node $ROOT/docs/demo/record.mjs $B /tmp/orbit-demo-out $TOKEN"
echo "  ffmpeg -f concat -safe 0 -i /tmp/orbit-demo-out/frames.txt -vf fps=12,format=yuv420p -c:v libx264 -crf 23 -movflags +faststart docs/demo.mp4"
echo "  docs/demo/stop.sh"
