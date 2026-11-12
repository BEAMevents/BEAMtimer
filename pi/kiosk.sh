#!/bin/bash
# Opens the BEAMtime page full screen in Chromium and reopens it if it ever closes.
# Started at boot by cage (Pi OS Lite) or by labwc's autostart (Pi OS Desktop).
# No browser zoom: the pages scale themselves to the screen (public/fit.js, container units).
CONFIG=/etc/beamtimer/config.json
[ -f /etc/beamtimer/kiosk ] || exit 0

ROLE=$(sed -n 's/.*"role": *"\([a-z]*\)".*/\1/p' "$CONFIG")
PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$CONFIG")
PORT=${PORT:-80}
PAGE=$([ "$ROLE" = controller ] && echo control || echo display)
URL="http://localhost:$PORT/$PAGE"

BROWSER=$(command -v chromium || command -v chromium-browser)
PROFILE="$HOME/.config/beamtimer-chromium"
mkdir -p "$PROFILE" "$HOME/.cache"
LOG="$HOME/.cache/beamtime-kiosk.log"   # the browser's own messages, shown in /api/diag
rm -f "$HOME/.cache/beamtime-kiosk-safe"

# Wait for the local server (up to 60 s) so the page doesn't open on an error.
for _ in $(seq 60); do
  curl -fs -o /dev/null "http://localhost:$PORT/api/info" 2>/dev/null && break
  sleep 1
done

QUICK=0      # browser crashes in a row, each within 45 s of starting
SAFE=0       # after 3: start without the sandbox and zygote helper (fine for our own local page)
SAFE_FLAGS=()
while true; do
  if [ "$SAFE" = 0 ] && [ "$QUICK" -ge 3 ]; then
    SAFE=1
    SAFE_FLAGS=(--no-sandbox --no-zygote --test-type)
    echo "BEAMtime kiosk: browser keeps crashing at start; starting it without the sandbox" | systemd-cat -t beamtime-kiosk 2>/dev/null || true
    touch "$HOME/.cache/beamtime-kiosk-safe"
  fi
  # A restart or power cut can leave Chromium's "already running" lock behind; Chromium then
  # quits at once and the screen stays black. Nothing else uses this profile, so clear it.
  rm -f "$PROFILE"/SingletonLock "$PROFILE"/SingletonSocket "$PROFILE"/SingletonCookie
  # Stop Chromium offering to "restore pages" after a power cut.
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' \
    "$PROFILE/Default/Preferences" 2>/dev/null
  "$BROWSER" "$URL" \
    --kiosk --start-fullscreen --noerrdialogs --disable-infobars --no-first-run \
    --disable-session-crashed-bubble --disable-features=Translate,TranslateUI \
    --overscroll-history-navigation=0 --disable-pinch --check-for-update-interval=31536000 \
    --password-store=basic --user-data-dir="$PROFILE" \
    --ozone-platform=wayland --enable-features=OverlayScrollbar "${SAFE_FLAGS[@]}" \
    >"$LOG" 2>&1 &
  PID=$!
  START=$(date +%s)
  # Watchdog: if the page stops reporting in, or stays disconnected while the controller answers,
  # restart the browser (the page then reconnects from scratch). First check after 90 s.
  while kill -0 "$PID" 2>/dev/null; do
    sleep 15
    [ $(( $(date +%s) - START )) -lt 90 ] && continue
    if curl -fs -m 8 "http://localhost:$PORT/api/kiosk/check" 2>/dev/null | grep -q '"restart":true'; then
      echo "BEAMtime kiosk: page not connected, restarting the browser" | systemd-cat -t beamtime-kiosk 2>/dev/null || true
      kill "$PID" 2>/dev/null; sleep 5; kill -9 "$PID" 2>/dev/null
    fi
  done
  wait "$PID" 2>/dev/null
  CODE=$?
  # A crash at start takes about 15 s (Chromium waits for its helper first); a working page runs much longer.
  if [ $(( $(date +%s) - START )) -lt 45 ]; then QUICK=$((QUICK + 1)); else QUICK=0; fi
  echo "== browser exited with code $CODE at $(date) (quick crashes in a row: $QUICK, safe mode: $SAFE)" >> "$LOG"
  cp -f "$LOG" "$LOG.last" 2>/dev/null
  sleep 2
done
