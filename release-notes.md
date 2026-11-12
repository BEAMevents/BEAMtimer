# BEAMtime 1.3.13

- Display safe mode now starts when Chromium crashes within 45 s of starting (its start-up crash takes about 15 s).

# BEAMtime 1.3.12

- Display screens come back when Chromium crashes at start ("Zygote process exited prematurely"): after 3 quick crashes the Pi starts it without the sandbox (safe for our own local page).
- More checks in /api/diag (folder owners, shared memory, Chromium version).

# BEAMtime 1.3.11

- Fixes Pis sometimes not restarting after an update or a Restart from Settings (the restart was cancelled when the update finished).
- Cleaner update files (no Mac file attributes).

# BEAMtime 1.3.10

- Settings → Displays → Scan: a Restart button for each display Pi (only its own controller can restart it).
- Scan no longer says "using another controller" for a display that uses this one but whose screen isn't connected.
- Each Pi has a diagnostics page at /api/diag (update log, browser messages, uptime) for troubleshooting without SSH.

# BEAMtime 1.3.9

- Fixes display Pi screens staying black after an automatic restart (Chromium's leftover "already running" lock is cleared).
- Works with no DHCP server (just a switch, no router): each Pi takes a self-assigned 169.254.x.x address after about a minute and the display still finds the controller. Needs internet once to install the small avahi-autoipd package.

# BEAMtime 1.3.8

- Display Pi screens reconnect by themselves: if the page stops responding, or stays disconnected while the controller is reachable, the browser restarts (checked every 15 s).
- Fixes the black screen on display Pis after 1.3.7 (the hidden mouse pointer change is undone).
- 12-hour clock by default (setups that used 24-hour switch once; pick 24-hour again in Settings → Clock if you want it).
- Tapping ✕ Remove on the On screen bar no longer opens the message page.

# BEAMtime 1.3.7

- Settings → Displays → Scan for new displays: finds every BEAMtime display Pi on the network and shows whether it's connected.
- Display Pis: no mouse pointer in the middle of the screen.

# BEAMtime 1.3.6

- Tap the On screen bar on the control panel to open the message page.
- A little surprise when you tap the BEAMtime name plate.

# BEAMtime 1.3.5

- Control panel LED digits: the unlit "ghost" segments are darker, and only lit segments glow.

# BEAMtime 1.3.4

- 12 presets (six rows) instead of 8: 2, 3, 5, 10, 15, 20, 25, 30, 45, 60, 90 and 120 min. Your own presets are kept; the new ones are added after them.

# BEAMtime 1.3.3

- The On screen box on the control panel flashes amber while a message is showing on the presenter screens.

# BEAMtime 1.3.2

- After an update the Pi restarts by itself, so the screen no longer freezes.
- Scan to control and Scan to display QR codes side by side in one box.
- "Can't reach the update server" now says why, and suggests restarting the Pi.

# BEAMtime 1.3.1

- Settings → Scan to display: a QR code that turns a phone, tablet or laptop into a presenter display.

# BEAMtime 1.3.0

- New name: BEAMtimer is now BEAMtime.
- NDI output shows the presenter message under the clock (flashing messages blink) and the green, amber and red signal lights.
- NDI source names that started with "BEAMtimer" are renamed to "BEAMtime".

# BEAMtime 1.2.1

- Repeat, Start and Stop buttons use drawn icons, so they no longer show as boxes on the Pi.

# BEAMtime 1.2.0

- Settings → Time of day: the Pi's clock, set by internet time or by hand (time picker, or "use this device's time").
- Settings → Network: Ethernet address automatic (DHCP) or fixed IP.
- A running timer keeps counting correctly when the clock is changed or corrected.
- IP number pad on the on-screen keyboard.

# BEAMtime 1.1.0

- The Pi's touchscreen shows the control panel full screen (it was small in a corner).
- The control page scales with any window, bigger or smaller; small phones fit too.
- Settings → Updates → Check for updates: install new versions from the control page. Display Pis update themselves from the controller.
- NDI output (optional, `--ndi`): send the clock to vMix, OBS, TriCaster or a switcher, with a transparent background if you want.
- Repeat is one tap.

# BEAMtime 1.0.0

First version: stage timer for Raspberry Pi 5 with a controller Pi and any number of display Pis.
