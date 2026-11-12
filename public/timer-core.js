// BEAMtime timer maths, shared by the server (Node) and the pages (browser).
// The state never stores "time left": it stores when the timer started (in the
// controller's clock) and how much had run before. Every screen works out the
// time from that, so displays keep counting correctly if the network drops.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BeamTimerCore = factory();
})(this, function () {
  const MAX_MS = 100 * 3600 * 1000;

  function defaultState() {
    return {
      mode: 'down',            // 'down' countdown, 'up' count up, 'clock' time of day
      duration: 10 * 60000,    // countdown length, or count-up target (0 = none)
      running: false,
      startedAt: null,         // controller time (ms) when last started
      elapsedBefore: 0,        // ms run before the last start
      overtime: 'continue',    // 'continue' counts up past zero in red, 'stop' holds at 0:00
      warnAt: 2 * 60000,       // amber at or below this
      dangerAt: 30000,         // red at or below this
      colorNormal: '#ffffff',  // digit colours on the displays: while running normally,
      colorWarn: '#ffb000',    //   at "amber at",
      colorDanger: '#ff3b30',  //   and at "red at" / overtime
      flashOvertime: true,
      showClock: true,
      showProgress: true,
      clock24: true,
      blackout: false,
      label: '',
      message: null,           // { text, flash, id }
      endBy: null,             // controller time (ms) the countdown should end at, or null
      presets: [2, 3, 5, 10, 15, 20, 25, 30, 45, 60, 90, 120].map(m => m * 60000),   // 6 rows of 2 on the panel
      presetsV: 2,
      quickMessages: ['Please wrap up', 'Overtime', 'Last question', '5 minutes left', 'Q&A now', 'Speak up', 'Slow down', 'Thank you'],
      tzOffsetMin: 0,          // controller's time zone, so every display shows the same clock
      rev: 0,
    };
  }

  const clampMs = (ms) => Math.max(0, Math.min(MAX_MS, Math.round(Number(ms) || 0)));

  function elapsed(s, now) {
    return s.elapsedBefore + (s.running && s.startedAt != null ? Math.max(0, now - s.startedAt) : 0);
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function fmt(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  function clockText(s, now) {
    const d = new Date(now + (s.tzOffsetMin || 0) * 60000);
    let h = d.getUTCHours();
    const tail = `${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    if (s.clock24) return `${pad(h)}:${tail}`;
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${tail} ${ap}`;
  }

  function clockShort(s, now) {
    return clockText(s, now).replace(/:\d\d( [AP]M)?$/, '$1');
  }

  // What to show right now: { text, phase: 'normal'|'warn'|'danger'|'over', progress 0..1 | null, over }
  function view(s, now) {
    if (s.mode === 'clock') return { text: clockText(s, now), phase: 'normal', progress: null, over: false };
    const el = elapsed(s, now);
    if (s.mode === 'up') {
      const text = fmt(Math.floor(el / 1000));
      if (!s.duration) return { text, phase: 'normal', progress: null, over: false };
      const left = s.duration - el;
      return { text, phase: phaseFor(s, left), progress: Math.min(1, el / s.duration), over: left <= 0 };
    }
    const left = s.duration - el;
    if (!s.duration && el === 0) return { text: fmt(0), phase: 'idle', progress: null, over: false };
    if (left > 0) {
      return { text: fmt(Math.ceil(left / 1000)), phase: phaseFor(s, left), progress: s.duration ? el / s.duration : 1, over: false };
    }
    if (s.overtime === 'stop') return { text: fmt(0), phase: 'over', progress: 1, over: true };
    const overSec = Math.floor(-left / 1000);
    return { text: (overSec > 0 ? '+' : '') + fmt(overSec), phase: 'over', progress: 1, over: true };
  }

  function phaseFor(s, left) {
    if (left <= 0) return 'over';
    if (s.dangerAt && left <= s.dangerAt) return 'danger';
    if (s.warnAt && left <= s.warnAt) return 'warn';
    return 'normal';
  }

  function hexColor(fallback) {
    return v => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : fallback);
  }

  const SETTINGS = {
    overtime: v => (v === 'stop' ? 'stop' : 'continue'),
    warnAt: clampMs, dangerAt: clampMs,
    flashOvertime: Boolean, showClock: Boolean, showProgress: Boolean, clock24: Boolean, blackout: Boolean,
    label: v => String(v || '').slice(0, 120),
    colorNormal: hexColor('#ffffff'), colorWarn: hexColor('#ffb000'), colorDanger: hexColor('#ff3b30'),
  };

  // Apply one command from a controller. Returns a new state (never changes the old one).
  function apply(prev, cmd, now) {
    const s = { ...prev };
    const stop = () => { s.elapsedBefore = elapsed(s, now); s.running = false; s.startedAt = null; };
    const reset = () => { s.running = false; s.startedAt = null; s.elapsedBefore = 0; };
    // "End by": starting (or restarting after a pause) works the length out again, so it still ends on time.
    const go = () => {
      if (s.endBy && s.mode === 'down') s.duration = clampMs(s.elapsedBefore + s.endBy - now);
      s.running = true; s.startedAt = now;
    };
    // Any manual change to the time cancels "End by".
    if (['set', 'adjust', 'total', 'mode', 'reset'].includes(cmd && cmd.cmd)) s.endBy = null;
    switch (cmd && cmd.cmd) {
      case 'start': if (!s.running) go(); break;
      case 'pause': if (s.running) stop(); break;
      case 'toggle': if (s.running) stop(); else go(); break;
      case 'reset': reset(); break;
      case 'set':
        s.duration = clampMs(cmd.ms);
        if (s.mode === 'clock') s.mode = 'down';
        reset();
        if (cmd.start) { s.running = true; s.startedAt = now; }
        break;
      case 'endBy': { // count down to a time of day (cmd.at, controller clock)
        const at = Math.round(Number(cmd.at) || 0);
        if (!(at > now) || at - now > 24 * 3600000) return prev;
        s.mode = 'down';
        reset();
        s.endBy = at;
        s.duration = clampMs(at - now);
        if (cmd.start) go();
        break;
      }
      case 'adjust': {
        const d = Math.round(Number(cmd.ms) || 0);
        if (s.mode === 'down') s.duration = clampMs(s.duration + d);
        else if (s.mode === 'up') {
          const el = elapsed(s, now);
          const target = Math.max(0, el + d);
          s.elapsedBefore += target - el;
        }
        break;
      }
      case 'total': // change the set time (countdown length / count-up target) in any mode
        s.duration = clampMs(s.duration + (Math.round(Number(cmd.ms) || 0)));
        break;
      case 'nudge': // step a warning time up or down (done here so fast taps all count)
        if (cmd.key === 'warnAt' || cmd.key === 'dangerAt') s[cmd.key] = Math.min(3600000, clampMs(s[cmd.key] + (Number(cmd.ms) || 0)));
        else return prev;
        break;
      case 'mode':
        if (['down', 'up', 'clock'].includes(cmd.mode) && cmd.mode !== s.mode) { s.mode = cmd.mode; reset(); }
        break;
      case 'message': {
        const text = String(cmd.text || '').trim().slice(0, 500);
        s.message = text ? { text, flash: !!cmd.flash, id: now } : null;
        break;
      }
      case 'clearMessage': s.message = null; break;
      case 'settings':
        for (const [k, fix] of Object.entries(SETTINGS)) if (cmd.values && k in cmd.values) s[k] = fix(cmd.values[k]);
        break;
      case 'presets':
        if (Array.isArray(cmd.list)) s.presets = cmd.list.map(clampMs).filter(ms => ms > 0).slice(0, 24);
        break;
      case 'quickMessages':
        if (Array.isArray(cmd.list)) s.quickMessages = cmd.list.map(t => String(t).trim().slice(0, 200)).filter(Boolean).slice(0, 24);
        break;
      default: return prev;
    }
    s.rev = (prev.rev || 0) + 1;
    return s;
  }

  // Merge a saved state over the defaults (older saved files may miss new fields).
  function restore(saved) {
    const s = { ...defaultState(), ...(saved && typeof saved === 'object' ? saved : {}) };
    if (!['down', 'up', 'clock'].includes(s.mode)) s.mode = 'down';
    // 1.3.4 went from 8 to 12 presets: top up older saved lists once (keeping the user's own first).
    if (saved && saved.presetsV !== 2 && Array.isArray(s.presets) && s.presets.length < 12) {
      const OLD = [5, 10, 15, 20, 30, 45, 60, 90].map(m => m * 60000);
      if (s.presets.join() === OLD.join()) s.presets = defaultState().presets;   // untouched: the new list, in order
      else s.presets = s.presets.concat(defaultState().presets.filter(ms => !s.presets.includes(ms))).slice(0, 12);
    }
    s.presetsV = 2;
    return s;
  }

  // "1:30" / "90" (minutes) / "1:02:03" / "45s" -> ms, or null
  function parseTime(str) {
    const t = String(str || '').trim().toLowerCase();
    if (!t) return null;
    let m;
    if ((m = t.match(/^(\d+(?:\.\d+)?)\s*s$/))) return clampMs(parseFloat(m[1]) * 1000);
    if ((m = t.match(/^(\d+(?:\.\d+)?)\s*m?$/))) return clampMs(parseFloat(m[1]) * 60000);
    if ((m = t.match(/^(\d+(?:\.\d+)?)\s*h$/))) return clampMs(parseFloat(m[1]) * 3600000);
    const parts = t.split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d+$/.test(p))) return null;
    const n = parts.map(Number);
    const sec = parts.length === 3 ? n[0] * 3600 + n[1] * 60 + n[2] : n[0] * 60 + n[1];
    return clampMs(sec * 1000);
  }

  return { defaultState, restore, apply, view, elapsed, fmt, clockShort, parseTime, MAX_MS };
});
