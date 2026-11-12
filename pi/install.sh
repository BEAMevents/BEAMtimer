#!/bin/bash
# BEAMtimer installer for Raspberry Pi 5 (Raspberry Pi OS Bookworm or Trixie, 64-bit, Lite or Desktop).
# Run on the Pi as root from the BEAMtimer folder:
#   sudo bash pi/install.sh --role controller
#   sudo bash pi/install.sh --role display
# Options:
#   --role controller|display   required
#   --hostname NAME             also rename the Pi (e.g. beamtimer-control, beamtimer-display-1)
#   --name "Stage left"         name shown on the control page (default: the Pi's hostname)
#   --controller HOST[:PORT]    display only: where the controller is (default: auto, found on the network)
#   --pin 1234                  controller only: PIN needed to use the control page
#   --port 80                   web port (default 80)
#   --no-kiosk                  don't open the timer full screen at boot (server only)
#   --ndi ["Name"]              also send the timer as an NDI source (default name: BEAMtimer)
#   --ndi-size 1280x720         NDI picture size (default 1920x1080)
#   --ndi-fps 30                NDI frame rate (default 30)
#   --ndi-alpha                 NDI with a transparent background, for keying over cameras
#   --no-ndi                    turn NDI off again
#   --accept-ndi-license        you have read and accept the NDI SDK licence (otherwise it is shown to you)
#   --reboot                    reboot when done
#   --update                    used by "Check for updates": same settings as now, then restart BEAMtimer
# Needs internet once (to install nodejs, chromium and, on Lite, cage). Re-running updates in place.
set -euo pipefail

ROLE=""; HOSTNAME_NEW=""; NAME=""; CONTROLLER="auto"; PIN=""; PORT=80; ZOOM=1; KIOSK=1; REBOOT=0; UPDATE=0
NDI=keep; NDI_NAME=""; NDI_SIZE=1920x1080; NDI_FPS=30; NDI_ALPHA=0; NDI_ACCEPT=0
NDI_URL="https://downloads.ndi.tv/SDK/NDI_SDK_Linux/Install_NDI_SDK_v6_Linux.tar.gz"
while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --hostname) HOSTNAME_NEW="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --controller) CONTROLLER="$2"; shift 2 ;;
    --pin) PIN="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --zoom) ZOOM="$2"; shift 2 ;;
    --no-kiosk) KIOSK=0; shift ;;
    --ndi) NDI=1; if [ $# -ge 2 ] && [[ "$2" != --* ]]; then NDI_NAME="$2"; shift; fi; shift ;;
    --ndi-size) NDI=1; NDI_SIZE="$2"; shift 2 ;;
    --ndi-fps) NDI=1; NDI_FPS="$2"; shift 2 ;;
    --ndi-alpha) NDI=1; NDI_ALPHA=1; shift ;;
    --no-ndi) NDI=0; shift ;;
    --accept-ndi-license) NDI_ACCEPT=1; shift ;;
    --reboot) REBOOT=1; shift ;;
    --update) UPDATE=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# --update: take every setting from this Pi's current install.
if [ "$UPDATE" = 1 ]; then
  [ -f /etc/beamtimer/config.json ] || { echo "Error: --update needs an installed BEAMtimer" >&2; exit 1; }
  eval "$(node -e '
    const c = JSON.parse(require("fs").readFileSync("/etc/beamtimer/config.json", "utf8"));
    const q = v => "\x27" + String(v == null ? "" : v).replace(/\x27/g, "") + "\x27";
    console.log(`ROLE=${q(c.role)}; PORT=${q(c.port || 80)}; ZOOM=${q(c.zoom || 1)}; NAME=${q(c.name)}; CONTROLLER=${q(c.controller || "auto")}; PIN=${q(c.pin)}`);')"
  [ -f /etc/beamtimer/kiosk ] && KIOSK=1 || KIOSK=0
  REBOOT=0
fi

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run with sudo"
[[ "$ROLE" = controller || "$ROLE" = display ]] || die "--role controller or --role display"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number"
[[ "$ZOOM" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--zoom must be a number like 1.5"
[[ "$NDI_SIZE" =~ ^[0-9]+x[0-9]+$ ]] || die "--ndi-size must look like 1920x1080"
[[ "$NDI_FPS" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--ndi-fps must be a number like 30"
if [ -n "$HOSTNAME_NEW" ] && ! [[ "$HOSTNAME_NEW" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$ ]]; then
  die "--hostname: letters, numbers and dashes only"
fi

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/beamtimer
[ -f "$SRC/server/server.js" ] || die "run this from the BEAMtimer folder (server/server.js not found)"

# The desktop user (the one who ran sudo, else the first normal user).
USER_NAME="${SUDO_USER:-}"
if [ -z "$USER_NAME" ] || [ "$USER_NAME" = root ]; then USER_NAME="$(getent passwd 1000 | cut -d: -f1)"; fi
[ -n "$USER_NAME" ] || die "no normal user found on this Pi"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
USER_GROUP="$(id -gn "$USER_NAME")"

# Re-running without NDI options keeps the NDI output as it was.
if [ "$NDI" = keep ]; then
  if systemctl is-enabled beamtimer-ndi >/dev/null 2>&1; then NDI=1; else NDI=0; fi
  if [ "$NDI" = 1 ] && [ -f /etc/beamtimer/config.json ] && command -v node >/dev/null; then
    eval "$(node -e '
      const n = (JSON.parse(require("fs").readFileSync("/etc/beamtimer/config.json", "utf8")).ndi) || {};
      const q = v => "\x27" + String(v).replace(/\x27/g, "") + "\x27";
      console.log(`NDI_NAME=${q(n.name || "")}; NDI_SIZE=${q(n.size || "1920x1080")}; NDI_FPS=${q(n.fps || 30)}; NDI_ALPHA=${n.alpha ? 1 : 0}`);' 2>/dev/null || true)"
  fi
fi
[ -n "$NDI_NAME" ] || NDI_NAME="BEAMtimer"

DESKTOP=0
if systemctl is-enabled lightdm >/dev/null 2>&1 || [ -x /usr/sbin/lightdm ]; then DESKTOP=1; fi

say "BEAMtimer $ROLE for user $USER_NAME ($([ $DESKTOP = 1 ] && echo 'Pi OS Desktop' || echo 'Pi OS Lite'))"

# ---------- packages ----------
export DEBIAN_FRONTEND=noninteractive
PKGS=(nodejs avahi-daemon avahi-utils libnss-mdns curl)
if [ $KIOSK = 1 ]; then
  [ $DESKTOP = 1 ] || PKGS+=(cage fonts-dejavu-core)
fi
[ "$NDI" = 1 ] && PKGS+=(python3 libavahi-client3)
MISSING=()
for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p"); done
if [ ${#MISSING[@]} -gt 0 ] || [ "$UPDATE" = 0 ]; then
  say "Installing packages (needs internet)"
  apt-get update
  apt-get install -y --no-install-recommends "${PKGS[@]}"
fi
if [ $KIOSK = 1 ] && ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  apt-get install -y chromium || apt-get install -y chromium-browser
fi
node -e 'process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)' || die "Node.js 18 or newer needed (found $(node -v))"

# ---------- app ----------
say "Copying the app to $APP"
if [ "$SRC" != "$APP" ]; then
  rm -rf "$APP.new"
  mkdir -p "$APP.new"
  cp -a "$SRC/server" "$SRC/public" "$SRC/pi" "$SRC/package.json" "$APP.new/"
  [ -f "$SRC/README.md" ] && cp "$SRC/README.md" "$APP.new/"
  rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"
  mv "$APP.new" "$APP"
  rm -rf "$APP.old"
fi
chmod +x "$APP/pi/"*.sh

# ---------- config ----------
say "Writing /etc/beamtimer/config.json"
mkdir -p /etc/beamtimer
APP_DIR="$APP" ROLE="$ROLE" PORT="$PORT" ZOOM="$ZOOM" NAME="$NAME" CONTROLLER="$CONTROLLER" PIN="$PIN" \
NDI="$NDI" NDI_NAME="$NDI_NAME" NDI_SIZE="$NDI_SIZE" NDI_FPS="$NDI_FPS" NDI_ALPHA="$NDI_ALPHA" node -e '
const e = process.env;
const cfg = { role: e.ROLE, port: Number(e.PORT), zoom: Number(e.ZOOM) || 1, name: e.NAME, controller: e.ROLE === "display" ? e.CONTROLLER : "auto" };
if (e.ROLE === "controller") cfg.pin = e.PIN;
if (e.NDI === "1") cfg.ndi = { name: e.NDI_NAME, size: e.NDI_SIZE, fps: Number(e.NDI_FPS), alpha: e.NDI_ALPHA === "1" };
require("fs").writeFileSync("/etc/beamtimer/config.json", JSON.stringify(cfg, null, 2) + "\n");'
chgrp "$USER_GROUP" /etc/beamtimer/config.json
chmod 640 /etc/beamtimer/config.json   # may hold the PIN

# ---------- service ----------
say "Starting the BEAMtimer service"
cat > /etc/systemd/system/beamtimer.service <<EOF
[Unit]
Description=BEAMtimer ($ROLE)
After=network.target avahi-daemon.service
Wants=avahi-daemon.service

[Service]
User=$USER_NAME
Environment=BEAMTIMER_CONFIG=/etc/beamtimer/config.json
StateDirectory=beamtimer
ExecStart=/usr/bin/node $APP/server/server.js
Restart=always
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable beamtimer >/dev/null
systemctl restart beamtimer

# ---------- updates ----------
# "Check for updates" (server/update.js) leaves a request file; this root service installs it.
cat > /etc/systemd/system/beamtimer-update.path <<EOF
[Unit]
Description=BEAMtimer update request

[Path]
PathExists=/var/lib/beamtimer/update-request

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/beamtimer-update.service <<EOF
[Unit]
Description=Install a BEAMtimer update

[Service]
Type=oneshot
ExecStart=/bin/bash $APP/pi/update.sh
EOF
systemctl daemon-reload
systemctl enable --now beamtimer-update.path >/dev/null 2>&1 || true

# ---------- NDI output ----------
if [ "$NDI" = 1 ]; then
  [ "$(uname -m)" = aarch64 ] || die "NDI needs 64-bit Raspberry Pi OS"
  if ! ls /usr/local/lib/libndi.so* >/dev/null 2>&1; then
    say "Installing the NDI library (NDI SDK from ndi.video)"
    if [ $NDI_ACCEPT = 0 ] && ! [ -t 0 ]; then
      die "The NDI SDK has a licence to accept. Read it at https://ndi.video/sdk/ and add --accept-ndi-license, or run this in a terminal to see it."
    fi
    NDI_TMP="$(mktemp -d)"
    curl -fL --retry 3 -o "$NDI_TMP/ndi.tar.gz" "$NDI_URL" || die "could not download the NDI SDK from $NDI_URL"
    tar -xzf "$NDI_TMP/ndi.tar.gz" -C "$NDI_TMP"
    NDI_INST="$(ls "$NDI_TMP"/Install_NDI_SDK_*Linux.sh | head -1)"
    [ -n "$NDI_INST" ] || die "NDI SDK download had no installer in it"
    if [ $NDI_ACCEPT = 1 ]; then
      (cd "$NDI_TMP" && yes y | bash "$NDI_INST" >/dev/null) || true
    else
      echo "The NDI SDK licence is shown next. Accept it to install NDI (q leaves the pager)."
      (cd "$NDI_TMP" && bash "$NDI_INST") || true
    fi
    NDI_SDK="$(find "$NDI_TMP" -mindepth 1 -maxdepth 1 -type d -name 'NDI SDK*' | head -1)"
    [ -n "$NDI_SDK" ] || die "NDI SDK not installed (licence not accepted?)"
    NDI_LIBDIR=""
    for d in "$NDI_SDK/lib/aarch64-linux-gnu" "$NDI_SDK/lib/aarch64-rpi4-linux-gnueabi"; do
      if ls "$d"/libndi.so* >/dev/null 2>&1; then NDI_LIBDIR="$d"; break; fi
    done
    if [ -z "$NDI_LIBDIR" ]; then
      f="$(find "$NDI_SDK/lib" -path '*aarch64*' -name 'libndi.so*' | head -1)"
      [ -n "$f" ] && NDI_LIBDIR="$(dirname "$f")"
    fi
    [ -n "$NDI_LIBDIR" ] || die "no 64-bit ARM libndi in the NDI SDK (folders: $(ls "$NDI_SDK/lib" | tr '\n' ' '))"
    cp -P "$NDI_LIBDIR"/libndi.so* /usr/local/lib/
    mkdir -p /usr/local/share/doc/ndi-sdk
    find "$NDI_SDK" -maxdepth 1 -type f -iname '*licen*' -exec cp {} /usr/local/share/doc/ndi-sdk/ \;
    ldconfig
    rm -rf "$NDI_TMP"
  fi
  say "Starting the NDI output \"$NDI_NAME\" ($NDI_SIZE, $NDI_FPS fps$([ $NDI_ALPHA = 1 ] && echo ', transparent'))"
  cat > /etc/systemd/system/beamtimer-ndi.service <<EOF
[Unit]
Description=BEAMtimer NDI output
After=beamtimer.service avahi-daemon.service
Wants=beamtimer.service

[Service]
User=$USER_NAME
Environment=BEAMTIMER_CONFIG=/etc/beamtimer/config.json
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 $APP/server/ndi-sender.py
Restart=always
RestartSec=3
Nice=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable beamtimer-ndi >/dev/null
  systemctl restart beamtimer-ndi
else
  if [ -f /etc/systemd/system/beamtimer-ndi.service ]; then
    systemctl disable --now beamtimer-ndi 2>/dev/null || true
    rm -f /etc/systemd/system/beamtimer-ndi.service
    systemctl daemon-reload
  fi
fi

# The controller announces itself so display Pis find it with no IP typed in.
if [ "$ROLE" = controller ]; then
  cat > /etc/avahi/services/beamtimer.service <<EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">BEAMtimer on %h</name>
  <service>
    <type>_beamtimer._tcp</type>
    <port>$PORT</port>
    <txt-record>role=controller</txt-record>
  </service>
</service-group>
EOF
else
  rm -f /etc/avahi/services/beamtimer.service
fi
systemctl enable avahi-daemon >/dev/null 2>&1 || true
systemctl restart avahi-daemon || true

# ---------- kiosk ----------
if [ $KIOSK = 1 ]; then
  say "Setting up full-screen start at boot"
  echo "$ROLE" > /etc/beamtimer/kiosk
  if command -v raspi-config >/dev/null; then
    raspi-config nonint do_blanking 1 || true          # never blank the screen
  fi
  if [ $DESKTOP = 1 ]; then
    raspi-config nonint do_boot_behaviour B4 || true   # desktop, logged in automatically
    raspi-config nonint do_wayland W3 >/dev/null 2>&1 || true  # labwc (default on new images)
    install -d -o "$USER_NAME" -g "$USER_GROUP" "$USER_HOME/.config" "$USER_HOME/.config/labwc"
    AUTOSTART="$USER_HOME/.config/labwc/autostart"
    touch "$AUTOSTART"
    sed -i '/# BEAMtimer/d' "$AUTOSTART"
    echo "$APP/pi/kiosk.sh & # BEAMtimer" >> "$AUTOSTART"
    chown "$USER_NAME:$USER_GROUP" "$AUTOSTART"
  else
    raspi-config nonint do_boot_behaviour B2 || true   # console, logged in automatically
    PROFILE="$USER_HOME/.bash_profile"
    touch "$PROFILE"
    sed -i '/# BEAMtimer start/,/# BEAMtimer end/d' "$PROFILE"
    grep -q '\.bashrc' "$PROFILE" || echo '[ -f ~/.bashrc ] && . ~/.bashrc' >> "$PROFILE"
    cat >> "$PROFILE" <<EOF
# BEAMtimer start: full-screen timer on the HDMI screen (not over SSH)
if [ -z "\${WAYLAND_DISPLAY:-}" ] && [ "\$(tty)" = /dev/tty1 ] && [ -f /etc/beamtimer/kiosk ]; then
  exec cage -s -- $APP/pi/kiosk.sh
fi
# BEAMtimer end
EOF
    chown "$USER_NAME:$USER_GROUP" "$PROFILE"
  fi
else
  rm -f /etc/beamtimer/kiosk
fi

# ---------- hostname ----------
if [ -n "$HOSTNAME_NEW" ] && [ "$HOSTNAME_NEW" != "$(hostname)" ]; then
  say "Renaming this Pi to $HOSTNAME_NEW"
  if command -v raspi-config >/dev/null; then raspi-config nonint do_hostname "$HOSTNAME_NEW"
  else hostnamectl set-hostname "$HOSTNAME_NEW"; sed -i "s/127.0.1.1.*/127.0.1.1\t$HOSTNAME_NEW/" /etc/hosts; fi
fi

# ---------- done ----------
sleep 1
HOST_NOW="${HOSTNAME_NEW:-$(hostname)}"
PORTSUFFIX=$([ "$PORT" = 80 ] && echo "" || echo ":$PORT")
IPS="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' || true)"
say "Done"
if systemctl is-active --quiet beamtimer; then echo "Service: running"; else echo "Service: NOT running — see: journalctl -u beamtimer -n 50"; fi
if [ "$NDI" = 1 ]; then
  if systemctl is-active --quiet beamtimer-ndi; then echo "NDI: sending \"$(hostname | tr a-z A-Z) ($NDI_NAME)\""
  else echo "NDI: NOT running — see: journalctl -u beamtimer-ndi -n 50"; fi
fi
if [ "$ROLE" = controller ]; then
  echo "Control page:  http://$HOST_NOW.local$PORTSUFFIX/control"
  for ip in $IPS; do echo "               http://$ip$PORTSUFFIX/control"; done
else
  echo "This display looks for the controller: $CONTROLLER"
fi
if [ "$UPDATE" = 1 ]; then
  # Restart the full-screen browser so it runs the new version (the page also reloads by itself).
  if [ $KIOSK = 1 ]; then pkill -x cage 2>/dev/null || pkill -f 'beamtimer-chromium' 2>/dev/null || true; fi
  echo "Updated to $(node -p 'require("'"$APP"'/package.json").version')"
elif [ $REBOOT = 1 ]; then
  echo "Rebooting…"; systemctl reboot
else
  echo "Reboot to start full screen:  sudo reboot"
fi
