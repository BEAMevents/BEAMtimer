#!/bin/bash
# Clock and network changes asked for on the control page (Settings → Time of day / Network).
# Run as root by beamtimer-system.service when the BEAMtime server (not root) leaves
# /var/lib/beamtimer/system-request, one JSON request:
#   {"id":"…","action":"ntp","on":true}                       internet time on / off
#   {"id":"…","action":"time","at":1794450000000}             set the clock (ms since 1970, UTC); turns internet time off
#   {"id":"…","action":"net","mode":"dhcp"}                    Ethernet address from the router
#   {"id":"…","action":"net","mode":"static","address":"192.168.1.50","prefix":24,"gateway":"192.168.1.1"}
#   {"id":"…","action":"reboot"}                               restart this Pi
# Every value is checked here before use. The result goes to system-status.json.
set -uo pipefail
DIR=/var/lib/beamtimer
REQ="$DIR/system-request"
OUT="$DIR/system-status.json"
[ -f "$REQ" ] || exit 0
mv -f "$REQ" "$REQ.taken"

# Read the request with node (installed with BEAMtime); only plain checked values come out.
eval "$(node -e '
  let r = {}; try { r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch {}
  const ok = (v, re) => (re.test(String(v)) ? String(v) : "");
  const out = {
    ID: ok(r.id, /^[A-Za-z0-9-]{1,40}$/), ACTION: ok(r.action, /^(ntp|time|net|reboot)$/),
    ON: r.on === true ? 1 : 0, AT: ok(r.at, /^\d{12,14}$/),
    MODE: ok(r.mode, /^(dhcp|static)$/), ADDR: ok(r.address, /^\d{1,3}(\.\d{1,3}){3}$/),
    PREFIX: ok(r.prefix, /^([89]|[12]\d|3[0-2])$/) || "24", GW: ok(r.gateway || "", /^(\d{1,3}(\.\d{1,3}){3})?$/),
  };
  for (const [k, v] of Object.entries(out)) console.log(`${k}=\x27${v}\x27`);' "$REQ.taken")"
rm -f "$REQ.taken"

result() {   # ok(0/1), message (fixed texts only)
  printf '{"id":"%s","ok":%s,"message":"%s","at":%s000}\n' "$ID" "$([ "$1" = 1 ] && echo true || echo false)" "$2" "$(date +%s)" > "$OUT.tmp"
  chmod 644 "$OUT.tmp"; mv -f "$OUT.tmp" "$OUT"
  exit 0
}
octets_ok() { local IFS=.; for o in $1; do [ "$o" -le 255 ] || return 1; done; }
save_rtc() { [ -e /dev/rtc0 ] && hwclock --systohc 2>/dev/null; true; }

case "$ACTION" in
  ntp)
    if [ "$ON" = 1 ]; then
      timedatectl set-ntp true || result 0 "Could not turn on internet time."
      result 1 "Internet time is on. The clock corrects itself when the Pi can reach the internet."
    else
      timedatectl set-ntp false || result 0 "Could not turn off internet time."
      result 1 "Internet time is off. Set the clock by hand."
    fi ;;
  time)
    [ -n "$AT" ] || result 0 "That time was not valid."
    SECS=$(( AT / 1000 ))
    [ "$SECS" -gt 1704067200 ] || result 0 "That time was not valid."   # after 2024
    timedatectl set-ntp false 2>/dev/null
    timedatectl set-time "$(date -d "@$SECS" '+%Y-%m-%d %H:%M:%S')" || result 0 "Could not set the clock."
    save_rtc
    result 1 "Clock set. Internet time is off so it stays as you set it." ;;
  net)
    DEV=eth0
    CON=$(nmcli -g GENERAL.CONNECTION device show "$DEV" 2>/dev/null | head -1)
    [ -n "$CON" ] || CON=$(nmcli -t -f NAME,DEVICE connection show | awk -F: -v d="$DEV" '$2==d{print $1; exit}')
    [ -n "$CON" ] || result 0 "No Ethernet connection found to change."
    if [ "$MODE" = dhcp ]; then
      nmcli connection modify "$CON" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns "" || result 0 "Could not change the network setting."
    elif [ "$MODE" = static ]; then
      [ -n "$ADDR" ] && octets_ok "$ADDR" || result 0 "That IP address was not valid."
      [ -z "$GW" ] || octets_ok "$GW" || result 0 "That gateway was not valid."
      DNS="${GW:-1.1.1.1}"; [ -n "$GW" ] && DNS="$GW 1.1.1.1"
      nmcli connection modify "$CON" ipv4.method manual ipv4.addresses "$ADDR/$PREFIX" ipv4.gateway "$GW" ipv4.dns "$DNS" || result 0 "Could not change the network setting."
    else
      result 0 "Unknown network setting."
    fi
    # Report first: re-applying drops the link for a moment, and the address may change.
    printf '{"id":"%s","ok":true,"message":"%s","at":%s000}\n' "$ID" "Network changed. Reconnecting…" "$(date +%s)" > "$OUT"
    chmod 644 "$OUT"
    sleep 1
    nmcli connection up "$CON" >/dev/null 2>&1 || nmcli device reapply "$DEV" >/dev/null 2>&1
    exit 0 ;;
  reboot)
    # Asked by this Pi's controller (Settings → Displays → Restart). A few seconds' delay so the answer gets out.
    # Scheduled (not run in the background): anything left running when this service ends is stopped.
    systemd-run --on-active=3 --unit="beamtimer-restart-$(date +%s)" /bin/systemctl reboot >/dev/null 2>&1 \
      || result 0 "Could not restart."
    result 1 "Restarting. Back in about a minute." ;;
  *) result 0 "Unknown request." ;;
esac
