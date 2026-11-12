#!/bin/bash
# Install or update BEAMtimer on a Pi from this Mac, over SSH.
#   scripts/push.sh beam@beamtimer-control.local --role controller
#   scripts/push.sh beam@beamtimer-display-1.local --role display --reboot
#   scripts/push.sh beam@beamtimer-display-1.local --role display --ndi "Stage clock"
# Everything after the address goes to pi/install.sh (see its options).
# You'll be asked for the Pi's password unless you use SSH keys.
set -euo pipefail
[ $# -ge 1 ] || { sed -n '2,7p' "$0"; exit 1; }
HOST="$1"; shift
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ARGS=$(printf '%q ' "$@")

echo "Copying BEAMtimer to ${HOST}…"
COPYFILE_DISABLE=1 tar -C "$DIR" -czf - server public pi package.json README.md |
  ssh "$HOST" 'rm -rf /tmp/beamtimer-src && mkdir -p /tmp/beamtimer-src && tar -xzf - -C /tmp/beamtimer-src --warning=no-unknown-keyword'

echo "Installing…"
ssh -t "$HOST" "sudo bash /tmp/beamtimer-src/pi/install.sh $ARGS"
