# BEAMtime

Stage timer for Raspberry Pi 5. One Pi is the **controller**; any number of **display** Pis show the clock full screen on HDMI for presenters. Control it from the controller Pi's own screen (touchscreen, or HDMI + mouse) or from any phone or laptop browser on the same network.

- **Control panel styled like a hardware stage timer**, made for a touchscreen:
  - green / yellow / red lamps, a big red LED main display, and LED windows for **Total time** and **Sum-up** (when it turns yellow)
  - **Total time ▲/▼** change the set time by 1 minute (hold to go faster). Tap **Set seconds** and they step 10 seconds instead.
  - **Sum-up ▲/▼** move the yellow warning point by 30 seconds
  - **Presets**: tap to load a preset time (red LED on the one that's loaded). **Press and hold** a preset for 1 second to save the current Total time into it. Tap the **Presets** title to put all presets back to the 12 defaults (2, 3, 5, 10, 15, 20, 25, 30, 45, 60, 90, 120 min).
  - **Options**: **Blink** (flash in overtime), **Black** (blackout the displays), **Msg** (message to presenter; **✕ Remove** on the On-screen strip takes it off), **End by** (pick a time of day, like 14:30, and the countdown ends then. It still ends on time after a pause. The button shows the end time while it's set, and any manual time change cancels it). **Clear** stops and sets the time to 0:00, ready to build a new time with the arrows.
  - **Repeat** goes back to the full time, **Start (Stop)** starts and pauses
  - While the timer runs, Clear needs a second tap ("Sure?") so a stray finger can't wipe the time. Repeat is always one tap
- **Message to presenter** opens a page that is mostly a big on-screen keyboard, with quick messages and a Flash switch. Phones use their own keyboard instead.
- **Settings** (one tap away): countdown / count up / time of day, keep counting in red or stop at 0:00, amber and red warning times, the digit colour for each stage (Running, Amber, Red; tap a colour swatch), title above the timer, time of day, progress bar, blackout, 12-hour or 24-hour clock, and editing presets and quick messages. Typing uses the same on-screen keyboard, or a number pad for times.
- **Scales with the window**: the control page zooms as a whole to fill any screen or browser window, bigger or smaller (it is laid out for the 10" Pi screen and keeps that shape). Phones get a one-column layout. The display page always fills its screen.
- Lists connected displays, with **Identify** to flash a display's name on its screen
- Optional PIN for the control page (with an on-screen number pad)
- Displays keep counting if the network drops (tiny orange dot in the corner while disconnected), and pick up any change when it comes back. They also remember the last state, so a display that reboots mid-show carries on.
- The controller saves the timer, so it carries on after a restart too.
- **NDI output** (optional, `--ndi`): any Pi can also send the clock as an NDI video source for vMix, OBS, TriCaster or a switcher, with a transparent background for keying if you want. See [NDI output](#ndi-output).
- **Time of day** in Settings: the controller Pi's clock, set by **internet time** or **by hand** (a time picker, or "use this device's time" from a phone). Display Pis show the controller's time. A running timer isn't affected when the clock is changed.
- **No router? Still works**: with no DHCP server, each Pi takes a self-assigned 169.254.x.x address (like a Mac does) after about a minute, and displays still find the controller by name. Laptops and phones on the same switch reach `http://beamtimer-control.local/control`. (Scan for new displays only checks normal addresses.)
- **Network** in Settings: the controller's Ethernet address, **automatic (DHCP)** or a **fixed IP**.
- **Scan for new displays** in Settings → Displays: the controller checks every address on its network for BEAMtime display Pis and shows which are connected (works without mDNS).
- **Scan to display** in Settings: a QR code that opens the presenter clock on a phone, tablet or laptop (tap for full screen).
- **Reconnects by itself**: each Pi's full-screen page reports to its own Pi every 10 s; if it stops, or stays disconnected while the controller answers, the browser restarts (`journalctl -t beamtime-kiosk`).
- **Check for updates** in Settings: the controller downloads the newest version and installs it; display Pis then update themselves from the controller. See [Updates](#updates).
- Display Pis find the controller by themselves (Bonjour/mDNS); no IP addresses to type.

## How it works

```
 phone / laptop ──┐
                  │  http://beamtimer-control.local/control
 controller Pi ───┤  (Node server :80 + Chromium full screen on /control)
   touchscreen    │
                  │  WebSocket /ws: commands in, timer state out
 display Pi 1 ────┤  Chromium full screen on its own localhost/display
 display Pi 2 ────┘  (local server finds the controller via _beamtimer._tcp)
```

The state never says "time left". It says "started at T (controller clock), N ms already run". Each screen works the time out itself, using the controller's clock (each screen measures its offset from the controller every 2 s, NTP-style). So every display shows the same second, and keeps going on its own if the link drops. This works on an isolated show network with no internet or NTP.

Everything is plain Node.js with no npm packages (`server/server.js`, `server/ws.js`) and plain HTML/JS pages (`public/`). `public/timer-core.js` is the timer logic, shared by the server and the pages.

## Set up two (or more) Pi 5s

You need: Pi 5s, SD cards, an HDMI screen for each display (micro-HDMI port **HDMI0**, the one next to the USB-C power), and internet on the network **once** during setup.

### 1. Write the cards

Use **BEAMpi → Write card** (or Raspberry Pi Imager) with **Raspberry Pi OS (64-bit)**. Either works:
- **Lite** (recommended for displays): boots faster, nothing else on screen. BEAMtime uses the small `cage` kiosk.
- **Desktop**: also fine (and handy on the controller if you want a desktop later). BEAMtime starts full screen with no desktop around it.

In the Pi settings:
- **Name:** `beamtimer-control` for the controller, `beamtimer-display-1`, `beamtimer-display-2`… for displays. (In BEAMpi the number goes up by one for each card.)
- **User + password**, **SSH on**
- **Wi-Fi** and/or a **fixed Ethernet IP** if you like. Wired Ethernet is best for a show.

Boot each Pi once and wait for it to show up (BEAMpi's Pi list, or `ping beamtimer-control.local`).

### 2. Install BEAMtime from the Mac

From this folder:

```bash
scripts/push.sh beam@beamtimer-control.local --role controller --reboot
```

```bash
scripts/push.sh beam@beamtimer-display-1.local --role display --reboot
```

(Use your user name instead of `beam`, or the Pi's IP instead of the `.local` name. The pages size themselves to whatever screen is connected.) It copies the app over SSH and runs `pi/install.sh` on the Pi, which:
1. installs `nodejs`, `chromium`, `avahi` (and `cage` on Lite) from the Pi OS repositories
2. copies the app to `/opt/beamtimer`, writes `/etc/beamtimer/config.json`
3. starts the `beamtimer` service (port 80) and, on the controller, announces `_beamtimer._tcp` on the network
4. sets the Pi to log in automatically and open the timer full screen at boot, with screen blanking off

Run the same command again to update to a new version.

**No Mac?** Copy the BEAMtimer folder to the Pi (USB stick, `scp`…) and run on the Pi: `sudo bash pi/install.sh --role controller` (or `--role display`), then `sudo reboot`.

### 3. Use it

- The controller's screen shows the control page. From a phone or laptop on the same network, open **http://beamtimer-control.local/control** (or `http://<controller IP>/control`. Some Android phones don't know `.local` names; Settings has a **Scan to control** QR code for each network, so a phone camera opens the page).
- Each display boots straight to the timer. Until it finds the controller, it shows "Waiting for controller…".
- A laptop or smart-TV browser can also be a display: `http://beamtimer-control.local/display` (double-click or press F for full screen).

With a real keyboard (laptop): **Space** start/pause, **↑/↓** total time ±1 min, **←/→** ±10 s, **M** or **Enter** message, **Esc** remove the message.

### Install options

`pi/install.sh` (and `scripts/push.sh`, which passes them on):

| Option | |
|---|---|
| `--role controller\|display` | required |
| `--hostname NAME` | rename the Pi too |
| `--name "Stage left"` | name in the control page's display list (default: hostname) |
| `--controller HOST[:PORT]` | display only: fixed controller address, instead of finding it automatically. Use it if mDNS is blocked on the venue network, e.g. `--controller 192.168.10.50` |
| `--pin 1234` | controller only: PIN to use the control page (remembered on each phone) |
| `--port 80` | web port |
| `--ndi ["Name"]` | also send the clock as an NDI source (see [NDI output](#ndi-output)) |
| `--ndi-size 1280x720` | NDI picture size (default `1920x1080`) |
| `--ndi-fps 30` | NDI frame rate (default 30) |
| `--ndi-alpha` | NDI with a transparent background, for keying over cameras |
| `--no-ndi` | turn NDI off again |
| `--accept-ndi-license` | skip showing the NDI SDK licence (only if you have read it) |
| `--no-kiosk` | server only, no full-screen browser at boot (e.g. a headless controller used only from phones) |
| `--reboot` | reboot when done |

Settings live in `/etc/beamtimer/config.json`; after editing, `sudo systemctl restart beamtimer` (and `beamtimer-ndi`).
Re-running the installer keeps NDI as it was unless you pass NDI options.
Remove: `sudo bash /opt/beamtimer/pi/uninstall.sh`.

### Updates

**Settings → Updates → Check for updates** on the control page (Pi screen, phone or laptop):
1. The controller asks GitHub for the newest release of `BEAMevents/BEAMtimer` (the controller needs internet for this).
2. If there is a newer version, it shows what's new and an **Install update** button (tap twice: the Pi restarts when it's done).
3. The controller downloads `beamtimer-X.Y.Z.tar.gz`, checks it against the release's checksum, and installs it with this Pi's settings. Then the **Pi restarts by itself** (about 1–2 minutes in all), so the screen, browser and NDI all start fresh on the new version; the page comes back by itself. Display Pis follow the controller the same way, so their screens go dark for about a minute while they restart.
4. **Display Pis follow by themselves** within a minute or two: they see the controller runs a newer version and copy the same file from it, so displays don't need internet. Settings → Displays shows each display's version.

How it installs: the BEAMtime server isn't root, so it leaves a request in `/var/lib/beamtimer`; the root service `beamtimer-update` (`pi/update.sh`) checks the file again and re-runs the installer with `--update`. Log: `/var/lib/beamtimer/update.log`.

`scripts/push.sh` still works for updating a Pi from the Mac (e.g. with no internet at all).

**Making a release** (on the Mac): raise `"version"` in `package.json`, put the notes in `dist/notes.txt`, then:

```bash
GH_TOKEN=… scripts/release.sh --publish
```

It makes `dist/beamtimer-X.Y.Z.tar.gz` and its `.sha256` and publishes them as GitHub release `vX.Y.Z`. Without `--publish` it only makes the files. The repository must be public, or the Pis can't download from it.

### NDI output

Any BEAMtime Pi, controller or display, can also send the clock over the network as an **NDI** source. vMix, OBS (with the DistroAV plugin), TriCaster, NDI Studio Monitor and NDI switchers then see it like a camera: no HDMI cable needed.

```bash
scripts/push.sh beam@beamtimer-display-1.local --role display --ndi "Stage clock"
```

```bash
scripts/push.sh beam@beamtimer-control.local --role controller --ndi --ndi-alpha
```

- The source appears as **`HOSTNAME (Stage clock)`**, e.g. `BEAMTIMER-DISPLAY-1 (Stage clock)`.
- It shows the **clock as the presenter sees it**: the three **signal lights** (green, amber, red, as on the control panel), LED-style digits, the **presenter message** under the clock (flashing messages blink in the warning colour) and the progress bar, in your Settings colours, flashing in overtime, gone on Black. The message needs `python3-pil` and `fonts-dejavu-core`, which `--ndi` installs.
- `--ndi-alpha` gives a transparent background (unlit segments hidden), to key the clock over camera shots.
- The first install downloads the free **NDI SDK** from ndi.video and **shows you its licence to accept** (press space to page through, then answer the question). `--accept-ndi-license` skips that if you have already read it. Only the library file (`libndi.so`) is kept, in `/usr/local/lib`.
- Full NDI uses roughly 100–150 Mbit/s at 1080p: use **wired gigabit Ethernet**, not Wi-Fi. If the Pi struggles, try `--ndi-size 1280x720`. The Pi 5 has no hardware video encoder, so NDI|HX isn't possible; this is full NDI.
- A display Pi can do NDI and HDMI at the same time. A Pi with no screen can do NDI only: `--ndi --no-kiosk`.
- Logs: `journalctl -u beamtimer-ndi -f`.

Try the NDI picture on the Mac without NDI (draws one frame from the running dev controller to a PNG):

```bash
python3 server/ndi-sender.py --server http://localhost:8080 --png ndi-test.png
```

### Troubleshooting

- **Display says "Waiting for controller…"**: check both are on the same network/VLAN. On the display Pi: `avahi-browse -rt _beamtimer._tcp` should list the controller. If the network blocks mDNS, reinstall the display with `--controller <controller IP>` (give the controller a fixed IP).
- **Service logs:** `journalctl -u beamtimer -f`
- **NDI source doesn't show up:** `systemctl status beamtimer-ndi`. The receiving computer must be on the same network/VLAN (NDI finds sources with mDNS, like the displays do). If the venue blocks mDNS, add the Pi's IP in the receiver (NDI Access Manager → Remote Sources, or vMix's NDI IP list).
- **Screen black / no browser:** check the screen is on HDMI0. Over SSH: `cat /etc/beamtimer/kiosk` (should exist); on Lite, the kiosk starts from `~/.bash_profile` on tty1; on Desktop, from `~/.config/labwc/autostart`.
- **Wrong time of day:** the clock follows the controller's time and time zone. Fix it in Settings → Time of day (internet time, or set by hand). The Pi 5 keeps time while unplugged only with a clock battery (RTC battery, the small connector next to USB-C); without one, a Pi with no internet starts with roughly the time it was switched off. Countdowns don't depend on the clock being right. Time zone: BEAMpi → System.
- **Changed the network and lost the page:** with DHCP the router picks the address. Use `http://beamtimer-control.local/control`, or read the address on the Pi's own screen (Settings → Network).
- **Portrait screen:** on Pi OS Desktop, rotate it in Screen Configuration. Rotation on Lite isn't built in yet.

## Try it on the Mac without Pis

```bash
scripts/dev.sh --open
```

This starts a controller on port 8080 and a pretend display Pi on port 8081, which finds the controller the way a real one does:
- Control: http://localhost:8080/control
- Display: http://localhost:8081/display (open it in a second window, side by side)

To test a dropped link, stop and restart the controller (`kill $(lsof -ti tcp:8080 -sTCP:LISTEN)`). The display keeps counting with an orange dot, then reconnects.

The Mac has no Node.js installed, so `dev.sh` borrows BEAMpi's Electron as Node (`ELECTRON_RUN_AS_NODE=1`). With Node installed, `npm start` and `npm run display` work too.

Tests (timer maths, plus a real controller and display talking over WebSocket):

```bash
ELECTRON_RUN_AS_NODE=1 ../BEAMpi/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron test/unit.js
```

## Files

| | |
|---|---|
| `server/server.js` | the server (both roles), HTTP + API + WebSocket hub, saves state |
| `server/ndi-sender.py` | NDI output: draws the clock and sends it with the NDI library (Python, no packages) |
| `server/ws.js` | minimal WebSocket server, no dependencies |
| `public/timer-core.js` | timer logic and commands (server + browser) |
| `public/link.js` | browser connection: find controller, reconnect, clock offset, cache |
| `public/render.js`, `screen.css` | draws the timer (display page and control preview) |
| `public/control.*`, `display.html` | the two pages (control has main, message and settings screens) |
| `server/system.js`, `pi/system.sh` | Settings → Time of day and Network (server side) and the root helper that changes them |
| `server/update.js`, `pi/update.sh` | Check for updates (server side) and the root installer it hands over to |
| `scripts/release.sh` | makes (and publishes) an update for Check for updates |
| `public/fit.js` | zooms the control page to fit the window |
| `public/keyboard.js` | on-screen keyboard and number pad, hold-to-repeat buttons |
| `public/sevenseg.js` | red 7-segment LED digits (SVG, no font files) |
| `public/qr.js` | QR code maker for "Scan to control" (works offline) |
| `public/icon.png`, `build/make-icon.js` | the app icon (orange, like the other BEAM apps). Re-make it with BEAMpi's Electron: `build/make-icon.js` |
| `docs/*.png` | screenshots (kept on the Mac, not in the repository) |
| `pi/install.sh`, `kiosk.sh`, `uninstall.sh` | Pi setup, full-screen start, removal |
| `scripts/push.sh` | install/update a Pi from the Mac |
| `scripts/dev.sh` | run on the Mac |
| `test/unit.js` | tests |
