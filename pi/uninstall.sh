#!/bin/bash
# Removes BEAMtimer from this Pi (leaves nodejs, chromium and cage installed).
#   sudo bash /opt/beamtimer/pi/uninstall.sh
set -eu
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
USER_NAME="${SUDO_USER:-$(getent passwd 1000 | cut -d: -f1)}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"

systemctl disable --now beamtimer beamtimer-ndi beamtimer-update.path 2>/dev/null || true
rm -f /etc/systemd/system/beamtimer.service /etc/systemd/system/beamtimer-ndi.service \
  /etc/systemd/system/beamtimer-update.path /etc/systemd/system/beamtimer-update.service /etc/avahi/services/beamtimer.service
systemctl daemon-reload
systemctl restart avahi-daemon 2>/dev/null || true
[ -f "$USER_HOME/.bash_profile" ] && sed -i '/# BEAMtimer start/,/# BEAMtimer end/d' "$USER_HOME/.bash_profile"
[ -f "$USER_HOME/.config/labwc/autostart" ] && sed -i '/# BEAMtimer/d' "$USER_HOME/.config/labwc/autostart"
rm -rf /etc/beamtimer /var/lib/beamtimer "$USER_HOME/.config/beamtimer-chromium"
cd / && rm -rf /opt/beamtimer
echo "BEAMtimer removed. (The NDI library stays in /usr/local/lib.)"
echo "The Pi still logs in automatically; change that in raspi-config (System > Boot) if you like."
