#!/bin/bash
# Try BEAMtimer on this Mac without any Pis: starts a controller (port 8080)
# and a pretend display Pi (port 8081) that finds the controller like a real one.
#   Control:  http://localhost:8080/control
#   Display:  http://localhost:8081/display   (served by the pretend display Pi)
#             http://localhost:8080/display   (straight from the controller)
# Ctrl-C stops both.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"

if command -v node >/dev/null 2>&1; then
  NODE=(node)
else
  # No Node on this Mac: use the Electron that BEAMpi ships as plain Node.
  ELECTRON="$DIR/../BEAMpi/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  [ -x "$ELECTRON" ] || { echo "Need Node.js (or BEAMpi's node_modules) to run this." >&2; exit 1; }
  export ELECTRON_RUN_AS_NODE=1
  NODE=("$ELECTRON")
fi

"${NODE[@]}" "$DIR/server/server.js" --role controller --port 8080 --data "$DIR/data" &
CTRL=$!
"${NODE[@]}" "$DIR/server/server.js" --role display --port 8081 --controller localhost:8080 --name "Pretend display Pi" &
DISP=$!
trap 'kill $CTRL $DISP 2>/dev/null' EXIT INT TERM

sleep 1
echo
echo "Control:  http://localhost:8080/control"
echo "Display:  http://localhost:8081/display"
[ "${1:-}" = "--open" ] && open "http://localhost:8080/control" "http://localhost:8081/display"
wait
