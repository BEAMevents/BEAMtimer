#!/usr/bin/env python3
"""BEAMtimer NDI output: sends the timer as an NDI video source (for vMix, OBS, TriCaster…).

It reads the timer from the controller (GET /api/state, 4 times a second) and draws
the clock as LED-style 7-segment digits with the progress bar, in the colours picked
in Settings. Presenter messages are left out on purpose: this is the clean clock.

Only the Python standard library is used. NDI itself comes from the NDI SDK's
libndi (pi/install.sh --ndi installs it), loaded with ctypes.

  python3 server/ndi-sender.py                 # settings from /etc/beamtimer/config.json ("ndi": {...})
  python3 server/ndi-sender.py --name "Stage" --size 1280x720 --fps 30 --alpha
  python3 server/ndi-sender.py --png out.png   # draw one frame to a PNG, no NDI needed (for testing)
"""
import argparse
import ctypes
import ctypes.util
import datetime
import glob
import json
import math
import os
import struct
import sys
import threading
import time
import urllib.request
import zlib

# ---------------------------------------------------------------- timer maths (same as public/timer-core.js)


def pad(n):
    return '%02d' % n


def fmt(total_sec):
    h, m, s = total_sec // 3600, (total_sec % 3600) // 60, total_sec % 60
    return '%d:%s:%s' % (h, pad(m), pad(s)) if h > 0 else '%d:%s' % (m, pad(s))


def elapsed(s, now):
    run = max(0, now - s['startedAt']) if s.get('running') and s.get('startedAt') is not None else 0
    return s.get('elapsedBefore', 0) + run


def clock_text(s, now):
    d = datetime.datetime.fromtimestamp((now + (s.get('tzOffsetMin') or 0) * 60000) / 1000, datetime.timezone.utc)
    tail = '%s:%s' % (pad(d.minute), pad(d.second))
    if s.get('clock24', True):
        return '%s:%s' % (pad(d.hour), tail)
    h = d.hour % 12 or 12
    return '%d:%s %s' % (h, tail, 'PM' if d.hour >= 12 else 'AM')


def phase_for(s, left):
    if left <= 0:
        return 'over'
    if s.get('dangerAt') and left <= s['dangerAt']:
        return 'danger'
    if s.get('warnAt') and left <= s['warnAt']:
        return 'warn'
    return 'normal'


def view(s, now):
    """(text, phase, progress 0..1 or None, over)"""
    mode = s.get('mode', 'down')
    if mode == 'clock':
        return clock_text(s, now), 'normal', None, False
    el = elapsed(s, now)
    dur = s.get('duration', 0)
    if mode == 'up':
        text = fmt(el // 1000)
        if not dur:
            return text, 'normal', None, False
        left = dur - el
        return text, phase_for(s, left), min(1, el / dur), left <= 0
    left = dur - el
    if not dur and el == 0:
        return fmt(0), 'idle', None, False
    if left > 0:
        return fmt(math.ceil(left / 1000)), phase_for(s, left), (el / dur if dur else 1), False
    if s.get('overtime') == 'stop':
        return fmt(0), 'over', 1, True
    over_sec = int(-left // 1000)
    return ('+' if over_sec > 0 else '') + fmt(over_sec), 'over', 1, True


# ---------------------------------------------------------------- drawing (BGRA, top row first)

# 7-segment shapes, same as public/sevenseg.js (digit cell 100 units high).
T, W_DIG, ADV, COLON = 10, 56, 66, 26
SKEW = math.tan(math.radians(6))


def hseg(y, x1, x2):
    t = T / 2
    return [(x1, y), (x1 + t, y - t), (x2 - t, y - t), (x2, y), (x2 - t, y + t), (x1 + t, y + t)]


def vseg(x, y1, y2):
    t = T / 2
    return [(x, y1), (x + t, y1 + t), (x + t, y2 - t), (x, y2), (x - t, y2 - t), (x - t, y1 + t)]


SEG = {'a': hseg(6, 9, 47), 'b': vseg(50, 9, 48), 'c': vseg(50, 52, 91),
       'd': hseg(94, 9, 47), 'e': vseg(6, 52, 91), 'f': vseg(6, 9, 48), 'g': hseg(50, 9, 47)}
ON = {'0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc',
      '8': 'abcdefg', '9': 'abcdfg', '-': 'g', '+': 'g', ' ': '', 'A': 'abcefg', 'P': 'abefg', 'M': 'aecb'}


def circle(cx, cy, r, n=28):
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


def layout(text):
    """Shapes for text in unit space: list of (points, lit), and the total width."""
    x = 4
    shapes = []
    for ch in text:
        if ch == ':':
            shapes.append((circle(x + COLON / 2 - 4, 32, 5.5), True))
            shapes.append((circle(x + COLON / 2 - 8, 70, 5.5), True))
            x += COLON
            continue
        if ch == '.':
            shapes.append((circle(x - 4, 94, 5), True))
            x += 8
            continue
        lit = ON.get(ch, '')
        for k, pts in SEG.items():
            shapes.append(([(px + x, py) for px, py in pts], k in lit))
        x += ADV
    width = x - (ADV - W_DIG) + 6
    # skewX(-6) translate(6 0), as in the SVG
    shapes = [([(px + 6 - SKEW * py, py) for px, py in pts], lit) for pts, lit in shapes]
    return shapes, width


def hex_rgb(h, fallback):
    h = str(h or '')
    if len(h) == 7 and h[0] == '#':
        try:
            return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
        except ValueError:
            pass
    return fallback


class Canvas:
    def __init__(self, w, h, alpha):
        self.w, self.h, self.alpha = w, h, alpha
        self.bg = bytes((0, 0, 0, 0 if alpha else 255))
        self.buf = bytearray(self.bg * (w * h))

    def clear_rows(self, y0, y1):
        y0, y1 = max(0, y0), min(self.h, y1)
        if y1 > y0:
            self.buf[y0 * self.w * 4:y1 * self.w * 4] = self.bg * ((y1 - y0) * self.w)

    def rect(self, x0, y0, x1, y1, rgb, a=1.0):
        x0, x1 = max(0, int(round(x0))), min(self.w, int(round(x1)))
        y0, y1 = max(0, int(round(y0))), min(self.h, int(round(y1)))
        if x1 <= x0:
            return
        px = self._px(rgb, a)
        row = px * (x1 - x0)
        for y in range(y0, y1):
            o = (y * self.w + x0) * 4
            self.buf[o:o + len(row)] = row

    def _px(self, rgb, a):
        r, g, b = rgb
        if self.alpha:
            return bytes((b, g, r, int(255 * a)))
        return bytes((int(b * a), int(g * a), int(r * a), 255))

    def poly(self, pts, rgb, a=1.0, sub=4):
        """Fill a convex polygon, with smooth (anti-aliased) edges."""
        ys = [p[1] for p in pts]
        y0, y1 = max(0, int(math.floor(min(ys)))), min(self.h - 1, int(math.ceil(max(ys))))
        n = len(pts)
        full = self._px(rgb, a)
        r, g, b = rgb
        for y in range(y0, y1 + 1):
            spans = []
            for k in range(sub):
                yy = y + (k + 0.5) / sub
                xs = []
                for i in range(n):
                    (xa, ya), (xb, yb) = pts[i], pts[(i + 1) % n]
                    if (ya <= yy < yb) or (yb <= yy < ya):
                        xs.append(xa + (yy - ya) * (xb - xa) / (yb - ya))
                if len(xs) >= 2:
                    spans.append((min(xs), max(xs)))
            if not spans:
                continue
            inner_l = max(s[0] for s in spans)
            inner_r = min(s[1] for s in spans)
            outer_l = min(s[0] for s in spans)
            outer_r = max(s[1] for s in spans)
            # solid middle
            fl = int(math.ceil(inner_l))
            fr = int(math.floor(inner_r))
            full_row = len(spans) == sub
            if full_row and fr > fl:
                fl, fr = max(0, fl), min(self.w, fr)
                o = (y * self.w + fl) * 4
                self.buf[o:o + (fr - fl) * 4] = full * (fr - fl)
            else:
                fl, fr = 0, -1
            # soft edges: work out how much of each edge pixel is covered
            for px in range(max(0, int(math.floor(outer_l))), min(self.w, int(math.ceil(outer_r)))):
                if fl <= px < fr:
                    continue
                cov = sum(max(0.0, min(px + 1, sr) - max(px, sl)) for sl, sr in spans) / sub
                if cov <= 0:
                    continue
                o = (y * self.w + px) * 4
                if self.alpha:
                    na = int(255 * a * cov)
                    if na > self.buf[o + 3]:
                        self.buf[o:o + 4] = bytes((b, g, r, na))
                else:
                    c = a * cov
                    d = self.buf
                    d[o] = int(b * c + d[o] * (1 - c))
                    d[o + 1] = int(g * c + d[o + 1] * (1 - c))
                    d[o + 2] = int(r * c + d[o + 2] * (1 - c))


GREEN = (0x34, 0xc7, 0x59)


class Renderer:
    def __init__(self, w, h, alpha):
        self.c = Canvas(w, h, alpha)
        self.w, self.h = w, h
        # Bar along the bottom, digits fill the space above it (like the display page).
        self.bar = (0.03 * w, h - 0.035 * h - 0.018 * h, w - 0.03 * w, h - 0.035 * h)
        self.digits_box = (0.04 * w, 0.06 * h, 0.96 * w, self.bar[1] - 0.04 * h)
        self.last_digits = None
        self.last_bar = None

    def frame(self, s, now, online):
        """Draw the frame for state s (None = waiting). Only redraws what changed; True if anything did."""
        if s is None:
            digits = ('--:--', (0x3a, 0x3a, 0x3a), 1.0, False)
            bar = None
        elif s.get('blackout'):
            digits, bar = None, None
        else:
            text, phase, progress, over = view(s, now)
            col = {'warn': hex_rgb(s.get('colorWarn'), (255, 176, 0)),
                   'danger': hex_rgb(s.get('colorDanger'), (255, 59, 48)),
                   'over': hex_rgb(s.get('colorDanger'), (255, 59, 48))}.get(phase, hex_rgb(s.get('colorNormal'), (255, 255, 255)))
            dim = 1.0
            if over and s.get('flashOvertime', True) and s.get('overtime') != 'stop' and (now % 1000) >= 500:
                dim = 0.2
            digits = (text, col, dim, True)
            bar = None
            if s.get('showProgress', True) and progress is not None:
                p = max(0.0, min(1.0, progress))
                bcol = col if phase in ('warn', 'danger', 'over') else GREEN
                bx0, _, bx1, _ = self.bar
                bar = (int(round((bx1 - bx0) * (1 - p))), bcol)
        changed = False
        if digits != self.last_digits:
            self.draw_digits(digits)
            self.last_digits, changed = digits, True
        if bar != self.last_bar:
            self.draw_bar(bar)
            self.last_bar, changed = bar, True
        return changed

    def draw_digits(self, d):
        x0, y0, x1, y1 = self.digits_box
        self.c.clear_rows(0, int(math.ceil(self.bar[1])) - 1)
        if d is None:
            return
        text, col, dim, unlit = d
        shapes, width = layout(text)
        k = min((x1 - x0) / width, (y1 - y0) / 100)
        ox = (x0 + x1) / 2 - width * k / 2
        oy = (y0 + y1) / 2 - 50 * k
        for pts, lit in shapes:
            if not lit and (not unlit or self.c.alpha):
                continue  # faint unlit segments only on a black background
            spts = [(ox + px * k, oy + py * k) for px, py in pts]
            if lit:
                self.c.poly(spts, col, dim)
            else:
                self.c.poly(spts, col, 0.07)

    def draw_bar(self, bar):
        x0, y0, x1, y1 = self.bar
        self.c.clear_rows(int(math.floor(y0)) - 1, int(math.ceil(y1)) + 1)
        if bar is None:
            return
        fill, col = bar
        self.c.rect(x0, y0, x1, y1, (0x1d, 0x1d, 0x1d), 1.0 if not self.c.alpha else 0.6)
        if fill > 0:
            self.c.rect(x0, y0, x0 + fill, y1, col)


def write_png(path, w, h, bgra):
    rgba = bytearray(bgra)
    rgba[0::4], rgba[2::4] = bgra[2::4], bgra[0::4]
    raw = b''.join(b'\x00' + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))

    def chunk(t, data):
        return struct.pack('>I', len(data)) + t + data + struct.pack('>I', zlib.crc32(t + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


# ---------------------------------------------------------------- NDI (libndi from the NDI SDK, via ctypes)

class SendCreate(ctypes.Structure):
    _fields_ = [('p_ndi_name', ctypes.c_char_p), ('p_groups', ctypes.c_char_p),
                ('clock_video', ctypes.c_bool), ('clock_audio', ctypes.c_bool)]


class VideoFrame(ctypes.Structure):
    _fields_ = [('xres', ctypes.c_int), ('yres', ctypes.c_int), ('FourCC', ctypes.c_int),
                ('frame_rate_N', ctypes.c_int), ('frame_rate_D', ctypes.c_int),
                ('picture_aspect_ratio', ctypes.c_float), ('frame_format_type', ctypes.c_int),
                ('timecode', ctypes.c_int64), ('p_data', ctypes.c_void_p),
                ('line_stride_in_bytes', ctypes.c_int), ('p_metadata', ctypes.c_char_p),
                ('timestamp', ctypes.c_int64)]


def fourcc(s):
    return s[0] | s[1] << 8 | s[2] << 16 | s[3] << 24


def load_ndi():
    names = [os.environ.get('NDI_LIB', ''), ctypes.util.find_library('ndi') or '']
    names += sorted(glob.glob('/usr/local/lib/libndi.so*'), reverse=True)
    names += glob.glob('/usr/lib/libndi.so*') + glob.glob('/usr/lib/*/libndi.so*')
    names += ['/usr/local/lib/libndi.dylib', '/Library/NDI SDK for Apple/lib/macOS/libndi.dylib']
    for n in names:
        if n and (os.path.exists(n) or '/' not in n):
            try:
                return ctypes.CDLL(n)
            except OSError:
                pass
    return None


class NdiSender:
    def __init__(self, lib, name, w, h, fps, alpha):
        self.lib = lib
        lib.NDIlib_initialize.restype = ctypes.c_bool
        lib.NDIlib_send_create.restype = ctypes.c_void_p
        lib.NDIlib_send_create.argtypes = [ctypes.POINTER(SendCreate)]
        lib.NDIlib_send_send_video_v2.argtypes = [ctypes.c_void_p, ctypes.POINTER(VideoFrame)]
        lib.NDIlib_send_destroy.argtypes = [ctypes.c_void_p]
        if not lib.NDIlib_initialize():
            raise RuntimeError('NDI could not start (this CPU may not be supported)')
        self.create = SendCreate(name.encode(), None, True, False)  # clock_video: NDI paces the frames
        self.inst = lib.NDIlib_send_create(ctypes.byref(self.create))
        if not self.inst:
            raise RuntimeError('NDI sender could not be created')
        self.frame = VideoFrame(w, h, fourcc(b'BGRA' if alpha else b'BGRX'), int(fps * 1000), 1000,
                                w / h, 1, 0x7fffffffffffffff, None, w * 4, None, 0)

    def send(self, buf):
        ptr = (ctypes.c_ubyte * len(buf)).from_buffer(buf)
        self.frame.p_data = ctypes.addressof(ptr)
        self.lib.NDIlib_send_send_video_v2(self.inst, ctypes.byref(self.frame))
        del ptr

    def close(self):
        self.lib.NDIlib_send_destroy(self.inst)
        self.lib.NDIlib_destroy()


# ---------------------------------------------------------------- timer state from the controller

def get_json(url, timeout=2):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


class Link(threading.Thread):
    """Polls the controller's state and keeps the controller-clock offset (like the display page)."""

    def __init__(self, local):
        super().__init__(daemon=True)
        self.local = local.rstrip('/')
        self.ctrl = None
        self.state = None
        self.offset = 0.0
        self.samples = []
        self.ok_at = 0

    def now(self):
        return time.time() * 1000 + self.offset

    def online(self):
        return time.time() - self.ok_at < 3

    def run(self):
        found_at = 0
        while True:
            try:
                if not self.ctrl or time.time() - found_at > 30:
                    info = get_json(self.local + '/api/controller')
                    self.ctrl = (info.get('url') or self.local).rstrip('/')
                    found_at = time.time()
                t0 = time.time() * 1000
                data = get_json(self.ctrl + '/api/state')
                t1 = time.time() * 1000
                self.samples = (self.samples + [(t1 - t0, data['s'] - (t0 + t1) / 2)])[-10:]
                self.offset = min(self.samples)[1]  # the quickest reply is the most exact
                self.state = data['state']
                self.ok_at = time.time()
            except Exception:
                if time.time() - self.ok_at > 5:
                    self.ctrl = None  # look for the controller again
            time.sleep(0.25)


class Painter(threading.Thread):
    """Draws new frames on its own, so a slow redraw never holds up the video."""

    def __init__(self, renderer, link, fps):
        super().__init__(daemon=True)
        self.r, self.link, self.fps = renderer, link, fps
        renderer.frame(None, 0, False)
        self.out = bytearray(renderer.c.buf)  # the frame being sent; never changed once published

    def run(self):
        while True:
            t = time.time()
            if self.r.frame(self.link.state, self.link.now(), self.link.online()):
                self.out = bytearray(self.r.c.buf)
            time.sleep(max(0.005, 1 / self.fps - (time.time() - t)))


# ---------------------------------------------------------------- main

def main():
    cfg = {}
    try:
        with open(os.environ.get('BEAMTIMER_CONFIG', '/etc/beamtimer/config.json')) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        pass
    ndi = cfg.get('ndi') or {}
    ap = argparse.ArgumentParser(description='Send the BEAMtimer clock as an NDI source.')
    ap.add_argument('--name', default=ndi.get('name') or 'BEAMtimer', help='NDI source name')
    ap.add_argument('--size', default=ndi.get('size') or '1920x1080', help='e.g. 1920x1080 or 1280x720')
    ap.add_argument('--fps', type=float, default=ndi.get('fps') or 30)
    ap.add_argument('--alpha', action='store_true', default=bool(ndi.get('alpha')), help='transparent background, for keying')
    ap.add_argument('--server', default='http://127.0.0.1:%s' % cfg.get('port', 80), help='this Pi\'s BEAMtimer server')
    ap.add_argument('--png', help='draw one frame to this PNG file and stop (no NDI needed)')
    ap.add_argument('--state', help='with --png: draw this state JSON file instead of asking the server')
    ap.add_argument('--at', type=float, default=0, help='with --png and --state: ms after startedAt to draw')
    a = ap.parse_args()
    try:
        w, h = (int(v) for v in a.size.lower().split('x'))
        assert 160 <= w <= 3840 and 90 <= h <= 2160
    except (ValueError, AssertionError):
        sys.exit('--size must look like 1920x1080')

    r = Renderer(w, h, a.alpha)

    if a.png:
        if a.state:
            with open(a.state) as f:
                s = json.load(f)
            now = (s.get('startedAt') or 0) + a.at
        else:
            link = Link(a.server)
            link.daemon = True
            link.start()
            for _ in range(20):
                if link.state:
                    break
                time.sleep(0.25)
            s, now = link.state, link.now()
        t = time.time()
        r.frame(s, now, True)
        write_png(a.png, w, h, r.c.buf)
        print('Wrote %s (%dx%d, drawn in %.0f ms)' % (a.png, w, h, (time.time() - t) * 1000))
        return

    lib = load_ndi()
    if not lib:
        sys.exit('NDI library (libndi) not found. Install it with: sudo bash pi/install.sh ... --ndi')
    sender = NdiSender(lib, a.name, w, h, a.fps, a.alpha)
    link = Link(a.server)
    link.start()
    painter = Painter(r, link, a.fps)
    painter.start()
    print('BEAMtimer NDI: sending "%s" at %dx%d, %g fps%s' % (a.name, w, h, a.fps, ', transparent' if a.alpha else ''), flush=True)
    try:
        while True:
            sender.send(painter.out)  # NDI waits here until the next frame is due
    except KeyboardInterrupt:
        pass
    finally:
        sender.close()


if __name__ == '__main__':
    main()
