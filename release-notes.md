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
