#!/bin/bash
# Installs a BEAMtimer update. Run as root by beamtimer-update.service when the BEAMtimer
# server (which can't install as itself) leaves /var/lib/beamtimer/update-request:
#   {"file": "/var/lib/beamtimer/updates/beamtimer-1.2.0.tar.gz", "sha256": "…", "version": "1.2.0"}
# The server has already checked the file against the release checksum; it is checked again here.
set -uo pipefail
DIR=/var/lib/beamtimer
REQ="$DIR/update-request"
STATUS="$DIR/update-status.json"
LOG="$DIR/update.log"
[ -f "$REQ" ] || exit 0
mv -f "$REQ" "$REQ.taken"      # so the path unit doesn't start us again

VERSION=""
status() {   # phase, error (fixed texts only)
  printf '{"phase":"%s","version":"%s","error":"%s","at":%s000}\n' "$1" "$VERSION" "${2:-}" "$(date +%s)" > "$STATUS.tmp"
  chmod 644 "$STATUS.tmp"; mv -f "$STATUS.tmp" "$STATUS"
}
fail() { echo "FAILED: $1" >> "$LOG"; status failed "$1"; rm -f "$REQ.taken"; [ -n "${TMP:-}" ] && rm -rf "$TMP"; exit 1; }

field() { sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" "$REQ.taken" | head -1; }
FILE="$(field file)"; SHA="$(field sha256)"; VERSION="$(field version)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { VERSION=""; fail "The update request was not valid."; }
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || fail "The update request was not valid."
[ "$FILE" = "$DIR/updates/beamtimer-$VERSION.tar.gz" ] && [ -f "$FILE" ] || fail "The update file is missing."

{ echo "== $(date) updating to $VERSION"; } > "$LOG"
status installing
[ "$(sha256sum "$FILE" | cut -d' ' -f1)" = "$SHA" ] || fail "The update file is damaged (checksum does not match)."
TMP="$(mktemp -d)"
tar -xzf "$FILE" -C "$TMP" --no-same-owner >> "$LOG" 2>&1 || fail "The update file could not be unpacked."
[ -f "$TMP/pi/install.sh" ] && [ -f "$TMP/server/server.js" ] || fail "The update file is not a BEAMtimer update."
grep -q "\"version\": *\"$VERSION\"" "$TMP/package.json" || fail "The update file has the wrong version in it."

# The new installer does the rest, with this Pi's saved settings, then restarts BEAMtimer.
if bash "$TMP/pi/install.sh" --update >> "$LOG" 2>&1; then
  status done
  echo "== done" >> "$LOG"
else
  fail "Installing the update failed. Details: /var/lib/beamtimer/update.log"
fi
rm -rf "$TMP"
rm -f "$REQ.taken"
