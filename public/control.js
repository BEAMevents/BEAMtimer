// BEAMtime control page: three screens for a touchscreen.
//   main      big arrows, start/pause, presets, message button
//   keyboard  message to the presenter (also used to type titles, presets, quick messages)
//   settings  everything else
(function () {
  const Core = window.BeamTimerCore;
  const { holdRepeat, onPress } = window.BeamKeyboard;
  const $ = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);
  const PIN_KEY = 'beamtimer.pin';
  const pinSaved = (() => { try { return localStorage.getItem(PIN_KEY) || ''; } catch { return ''; } })();
  const phone = window.matchMedia('(max-width: 700px)');

  let online = false;
  let displays = [];
  let flash = false;
  const shown = {};

  // ---------- connection ----------
  const link = new BeamLink({
    role: 'control',
    name: /Mobi|Android|iPhone/.test(navigator.userAgent) ? 'Phone' : 'Control',
    pin: pinSaved,
    onStatus: (s, detail) => {
      online = s === 'online';
      $$('.status').forEach(st => {
        st.className = 'status pill ' + (online ? 'on' : 'off');
        st.textContent = online ? `● ${detail || 'Connected'}`
          : s === 'searching' ? 'Looking for controller…' : s === 'offline' ? 'Offline · reconnecting…' : 'Connecting…';
      });
      if (!online) { displays = []; showDisplays(); }
    },
    onState: s => showState(s),
    onMessage: m => {
      if (m.t === 'auth') {
        $('pinGate').hidden = m.ok;
        if (!m.ok) $('pinErr').textContent = link.opts.pin ? 'Wrong PIN.' : '';
      }
      if (m.t === 'clients') { displays = m.list.filter(c => c.role === 'display'); showDisplays(); }
      if (m.t === 'update') showUpdate(m.status);
      if (m.t === 'system') showSystem(m);
      if (m.t === 'scan') showScan(m);
    },
  });
  link.connect();

  function cmd(name, extra) {
    if (link.cmd(name, extra)) return true;
    $$('.status').forEach(st => { st.classList.add('shake'); setTimeout(() => st.classList.remove('shake'), 500); });
    return false;
  }

  // ---------- screens ----------
  function show(view) {
    for (const v of ['main', 'kb', 'settings', 'endby']) $('v-' + v).hidden = v !== view;
    window.scrollTo(0, 0);
  }
  $$('[data-go]').forEach(b => onPress(b, () => show(b.dataset.go)));

  // A second tap within 3 s, for things that would spoil a running show.
  function confirmTap(btn, question, fn) {
    if (btn.dataset.armed) {
      clearTimeout(btn._t); delete btn.dataset.armed; btn.innerHTML = btn._label; btn.classList.remove('armed');
      return fn();
    }
    btn._label = btn.innerHTML;
    btn.dataset.armed = '1';
    btn.textContent = question;
    btn.classList.add('armed');
    btn._t = setTimeout(() => { delete btn.dataset.armed; btn.innerHTML = btn._label; btn.classList.remove('armed'); }, 3000);
  }
  const midShow = () => {
    const s = link.state;
    return s && s.mode !== 'clock' && (s.running || Core.elapsed(s, link.now()) > 0);
  };

  // ---------- End by: count down to a time of day ----------
  // Times are in the controller's time zone, so a phone in another zone still gets the right clock.
  const DAY = 86400000;
  const tzOff = s => (s.tzOffsetMin || 0) * 60000;
  const minOfDay = (s, t) => Math.floor((((t + tzOff(s)) % DAY) + DAY) % DAY / 60000);
  function hm(s, mins) {
    const h = Math.floor(mins / 60), m = String(mins % 60).padStart(2, '0');
    return s.clock24 ? { h: String(h).padStart(2, '0'), m, ap: '' } : { h: String(h % 12 || 12), m, ap: h >= 12 ? 'PM' : 'AM' };
  }
  function clockHM(s, t) { const x = hm(s, minOfDay(s, t)); return `${x.h}:${x.m}`; }
  // The next moment (controller clock) that is `mins` past midnight.
  function nextAt(s, mins) {
    const now = link.now();
    const local = now + tzOff(s);
    let at = local - (((local % DAY) + DAY) % DAY) + mins * 60000 - tzOff(s);
    if (at <= now) at += DAY;
    return at;
  }
  let pick = 0; // minutes past midnight
  let pickMode = 'endby';   // or 'clock': the same picker sets the Pi's clock (Settings → Time of day)
  function pickerFor(mode) {
    pickMode = mode;
    const clock = mode === 'clock';
    $('v-endby').querySelector('.title').textContent = clock ? 'Set the clock' : 'End by';
    $('v-endby').querySelector('.back').dataset.go = clock ? 'settings' : 'main';
    $('epSet').hidden = clock;
    $('epQuick').hidden = clock;
    $('epStart').textContent = clock ? 'Set clock' : 'Start ▶';
  }
  function openSetClock() {
    const s = link.state;
    if (!s) return;
    pickerFor('clock');
    pick = minOfDay(s, link.now());
    show('endby');
    drawEndBy();
  }
  function openEndBy() {
    const s = link.state;
    if (!s) return;
    pickerFor('endby');
    if (s.endBy && s.mode === 'down' && s.endBy > link.now()) pick = minOfDay(s, s.endBy);
    else {
      // suggest "now + the current time", rounded up to the next 5 minutes
      const m = minOfDay(s, link.now() + (s.mode === 'clock' ? 0 : s.duration)) + 1;
      pick = (Math.ceil(m / 5) * 5) % 1440;
    }
    show('endby');
    drawEndBy();
  }
  const stepPick = by => { pick = (((pick + by) % 1440) + 1440) % 1440; drawEndBy(); };
  holdRepeat($('epHourUp'), () => stepPick(60));
  holdRepeat($('epHourDown'), () => stepPick(-60));
  holdRepeat($('epMinUp'), () => stepPick(1));
  holdRepeat($('epMinDown'), () => stepPick(-1));
  $$('#epAmPm button').forEach(b => onPress(b, () => {
    const pm = pick >= 720;
    if ((b.dataset.ap === 'pm') !== pm) stepPick(pm ? -720 : 720);
  }));
  function drawEndBy() {
    const s = link.state;
    if (!s || $('v-endby').hidden) return;
    const x = hm(s, pick);
    Seg.render($('epHour'), x.h.padStart(2, ' '));
    Seg.render($('epMin'), x.m);
    $('epAmPm').hidden = !!s.clock24;
    $$('#epAmPm button').forEach(b => b.classList.toggle('on', b.dataset.ap === x.ap.toLowerCase()));
    const left = nextAt(s, pick) - link.now();
    const now = hm(s, minOfDay(s, link.now()));
    const nowText = `${now.h}:${now.m}${now.ap ? ' ' + now.ap : ''}`;
    if (pickMode === 'clock') {
      $('epHint').innerHTML = `The clock says <b>${nowText}</b> &nbsp;·&nbsp; Set clock makes it <b>${x.h.trim()}:${x.m}${x.ap ? ' ' + x.ap : ''}</b> (seconds from :00)`;
      return;
    }
    $('epHint').innerHTML = `Now ${nowText} &nbsp;·&nbsp; the timer will run for <b>${Core.fmt(Math.ceil(left / 1000))}</b>`;
    // Quick picks: the next four quarter hours
    const base = Math.floor(minOfDay(s, link.now()) / 15) * 15;
    const key = `${base}|${s.clock24}`;
    if ($('epQuick').dataset.key !== key) {
      $('epQuick').dataset.key = key;
      $('epQuick').innerHTML = '';
      for (let i = 1; i <= 4; i++) {
        const mins = (base + i * 15) % 1440;
        const q = hm(s, mins);
        const c = document.createElement('button');
        c.className = 'chip';
        c.textContent = `${q.h}:${q.m}${q.ap ? ' ' + q.ap : ''}`;
        onPress(c, () => { pick = mins; drawEndBy(); });
        $('epQuick').appendChild(c);
      }
    }
  }
  setInterval(drawEndBy, 1000);
  const endBy = start => { const s = link.state; if (s && cmd('endBy', { at: nextAt(s, pick), start })) show('main'); };
  onPress($('epSet'), () => endBy(false));
  onPress($('epStart'), () => {
    if (pickMode !== 'clock') return endBy(true);
    // Today at the picked time, in the Pi's time zone.
    const s = link.state;
    const local = link.now() + tzOff(s);
    const at = local - (((local % DAY) + DAY) % DAY) + pick * 60000 - tzOff(s);
    sysChange({ action: 'time', at }, 'sysMsg');
    show('settings');
  });

  // ---------- main: the timer panel ----------
  const Seg = window.SevenSeg;
  let secMode = false; // "Set seconds": total time arrows step 10 s instead of 1 min

  const totalStep = () => (secMode ? 10000 : 60000);
  holdRepeat($('totUp'), () => cmd('total', { ms: totalStep() }));
  holdRepeat($('totDown'), () => cmd('total', { ms: -totalStep() }));
  onPress($('setSec'), () => { secMode = !secMode; $('setSec').classList.toggle('on', secMode); });
  const stepWarn = by => cmd('nudge', { key: 'warnAt', ms: by });
  holdRepeat($('sumUp'), () => stepWarn(30000));
  holdRepeat($('sumDown'), () => stepWarn(-30000));

  onPress($('startBtn'), () => cmd('toggle'));
  // Repeat: one tap puts the timer back to the full Total time.
  onPress($('resetBtn'), () => cmd('reset'));
  // Drawn icons: the Pi's fonts have no media symbols (they showed as boxes).
  const ICONS = {
    play: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.6v14.8a.9.9 0 0 0 1.4.8l11.3-7.4a.9.9 0 0 0 0-1.6L8.4 3.8A.9.9 0 0 0 7 4.6z"/></svg>',
    pause: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="4" width="4.5" height="16" rx="1"/><rect x="14" y="4" width="4.5" height="16" rx="1"/></svg>',
  };
  onPress($('openMsg'), () => openMessage());
  onPress($('openEnd'), () => openEndBy());
  let removedAt = 0;
  onPress($('clearStage'), () => { removedAt = Date.now(); cmd('clearMessage'); });
  // Tapping the On screen bar opens the message page. Not after Remove: that button hides as soon
  // as it is pressed, so the end of the same tap lands on the bar.
  $('onStage').addEventListener('click', e => {
    if (e.target.closest('#clearStage') || Date.now() - removedAt < 1000) return;
    openMessage();
  });

  // Easter egg: tap the BEAMtime plate and every button flies off the screen, then back.
  let flying = false;
  $('v-main').querySelector('.plate').addEventListener('click', () => {
    if (flying || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    flying = true;
    const els = [...$('v-main').querySelectorAll('.rbtn, .hbtn, .lamp, .ledwin, .flabel, .dot-led, .msgstrip, .pill')];
    const cx = innerWidth / 2, cy = innerHeight / 2, far = Math.max(innerWidth, innerHeight) * 1.4;
    let last = 0;
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      let dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
      const len = Math.hypot(dx, dy) || 1;
      const ang = (Math.random() - 0.5) * 0.9;   // a little scatter
      [dx, dy] = [dx * Math.cos(ang) - dy * Math.sin(ang), dx * Math.sin(ang) + dy * Math.cos(ang)];
      const spin = (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 540);
      const off = `translate(${dx / len * far}px, ${dy / len * far}px) rotate(${spin}deg) scale(.6)`;
      const delay = Math.random() * 250;
      last = Math.max(last, delay);
      el.animate([
        { transform: 'none', offset: 0 },
        { transform: off, offset: 0.4, easing: 'ease-in' },
        { transform: off, offset: 0.55, easing: 'cubic-bezier(.2,1.4,.4,1)' },
        { transform: 'none', offset: 1 },
      ], { duration: 2000, delay, easing: 'linear' });
    });
    const plate = $('v-main').querySelector('.plate');
    plate.animate([{ transform: 'none' }, { transform: 'rotate(360deg) scale(1.15)' }, { transform: 'none' }], { duration: 1200, easing: 'ease-in-out' });
    setTimeout(() => { flying = false; }, 2000 + last);
  });
  // Clear, like the hardware: stop and set the time to 0:00, then build a new time with the arrows.
  $('clearBtn').addEventListener('click', () => {
    if (midShow()) confirmTap($('clearBtn'), 'Sure?', () => cmd('set', { ms: 0 }));
    else cmd('set', { ms: 0 });
  });
  onPress($('optBlink'), () => { const s = link.state; if (s) cmd('settings', { values: { flashOvertime: !s.flashOvertime } }); });
  onPress($('optBlack'), () => { const s = link.state; if (s) cmd('settings', { values: { blackout: !s.blackout } }); });
  onPress($('blackoutOff'), () => cmd('settings', { values: { blackout: false } }));

  // 7 segments have no "+" or AM/PM: overtime shows as "-0:12" with the red lamp.
  const ledText = t => fixed(t.replace('+', '-').replace(/ [AP]M$/, ''));
  // Fixed number of digits, like a real LED display (' 5:00', not '5:00').
  const fixed = t => (t.length < 5 ? t.padStart(5, ' ') : t);

  function tick() {
    const s = link.state;
    if ($('v-main').hidden) return;
    if (!s) { Seg.render($('ledMain'), '--:--'); return; }
    const v = Core.view(s, link.now());
    Seg.render($('ledMain'), ledText(v.text));
    const clock = s.mode === 'clock';
    const blink = v.phase === 'over' && s.flashOvertime && s.overtime !== 'stop';
    $('lampG').classList.toggle('on', !clock && v.phase === 'normal');
    $('lampY').classList.toggle('on', v.phase === 'warn');
    $('lampR').classList.toggle('on', v.phase === 'danger' || v.phase === 'over');
    $('lampR').classList.toggle('blink', blink);
    $('ledMain').classList.toggle('blink', blink);
    const icon = s.running ? 'pause' : 'play';
    if ($('startBtn').dataset.icon !== icon) {
      $('startBtn').dataset.icon = icon;
      $('startBtn').innerHTML = ICONS[icon];
    }
    $('startBtn').classList.toggle('running', s.running);
  }
  setInterval(tick, 100);

  // Presets: tap the "Presets" title to put every preset back to the default times.
  onPress($('presetsReset'), () => {
    cmd('presets', { list: Core.defaultState().presets });
    const t = $('presetsReset'); t.classList.add('done'); setTimeout(() => t.classList.remove('done'), 800);
  });

  // Presets: tap loads the time; press and hold (1 s) saves the current Total time into that button.
  let savedSlot = null;
  function programButton(b, slot, ms) {
    let t = null;
    b.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      b.classList.add('held');
      t = setTimeout(() => {
        t = null;
        b.classList.remove('held');
        const s = link.state;
        if (!s || s.mode === 'clock' || !s.duration) return;
        const list = s.presets.slice();
        list[slot] = s.duration;
        savedSlot = slot;
        cmd('presets', { list });
      }, 1000);
    });
    const up = load => {
      b.classList.remove('held');
      if (!t) return;          // the hold already saved
      clearTimeout(t); t = null;
      if (load) cmd('set', { ms });
    };
    b.addEventListener('pointerup', () => up(true));
    b.addEventListener('pointercancel', () => up(false));
    b.addEventListener('contextmenu', e => e.preventDefault());
    b.addEventListener('click', e => { if (e.detail === 0) cmd('set', { ms }); });
  }

  function showState(s) {
    const clock = s.mode === 'clock';
    for (const id of ['totUp', 'totDown', 'startBtn', 'resetBtn', 'setSec', 'clearBtn']) $(id).disabled = clock;
    $('blackoutBar').hidden = !s.blackout;
    const dur = Math.round(s.duration / 1000);
    Seg.render($('ledTotal'), fixed(Core.fmt(dur)));
    Seg.render($('ledSum'), fixed(Core.fmt(Math.round(s.warnAt / 1000))));
    Seg.render($('ledSec'), ':' + String(dur % 60).padStart(2, '0'));
    $('dotBlink').classList.toggle('on', !!s.flashOvertime);
    $('dotBlack').classList.toggle('on', !!s.blackout);
    $('dotMsg').classList.toggle('on', !!(s.message && s.message.text));
    const endOn = !!(s.endBy && s.mode === 'down');
    $('dotEnd').classList.toggle('on', endOn);
    const endLabel = endOn ? `<small>END</small><b>${clockHM(s, s.endBy)}</b>` : 'END<br>BY';
    if ($('openEnd').innerHTML !== endLabel) $('openEnd').innerHTML = endLabel;
    $('openEnd').classList.toggle('set', endOn);

    // Preset times (rebuilt only when the list changes, so a tap is never lost).
    const pkey = JSON.stringify(s.presets);
    if (pkey !== shown.presets) {
      shown.presets = pkey;
      $('presets').innerHTML = '';
      s.presets.forEach((ms, slot) => {
        const wrap = document.createElement('div');
        wrap.className = 'prog';
        const dot = document.createElement('i');
        dot.className = 'dot-led';
        const b = document.createElement('button');
        b.className = 'rbtn';
        b.dataset.ms = ms;
        b.innerHTML = ms % 60000 ? `<b>${Core.fmt(ms / 1000)}</b>` : `<b>${ms / 60000}</b><small>min</small>`;
        programButton(b, slot, ms);
        wrap.append(dot, b);
        $('presets').appendChild(wrap);
      });
      if (savedSlot != null) {
        const w = $('presets').children[savedSlot];
        if (w) { w.classList.add('saved'); setTimeout(() => w.classList.remove('saved'), 1500); }
        savedSlot = null;
      }
      buildPresetEdit(s);
    }
    $$('#presets .prog').forEach(w => w.querySelector('.dot-led').classList.toggle('on', !clock && Number(w.querySelector('button').dataset.ms) === s.duration));

    const msg = s.message && s.message.text;
    $('onStageText').textContent = msg ? `${msg}${s.message.flash ? '  (flashing)' : ''}` : 'No message';
    $('onStage').classList.toggle('live', !!msg);
    $('clearStage').hidden = !msg;
    $('kbOnStage').hidden = !msg;
    $('kbOnStage').querySelector('span').textContent = msg ? `On screen: ${msg}` : '';

    const qkey = JSON.stringify(s.quickMessages);
    if (qkey !== shown.quick) { shown.quick = qkey; buildQuick(s); buildQuickEdit(s); }

    // settings
    $$('#modeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === s.mode));
    $$('#overSeg button').forEach(b => b.classList.toggle('active', b.dataset.over === s.overtime));
    $$('#clockSeg button').forEach(b => b.classList.toggle('active', (b.dataset.c24 === '1') === !!s.clock24));
    $('warnAtVal').textContent = s.warnAt ? Core.fmt(s.warnAt / 1000) : 'Off';
    $('dangerAtVal').textContent = s.dangerAt ? Core.fmt(s.dangerAt / 1000) : 'Off';
    $('labelVal').textContent = s.label || 'None';
    $$('[data-toggle]').forEach(b => b.classList.toggle('on', !!s[b.dataset.toggle]));
    $$('[data-color-of]').forEach(l => { l.style.color = s[l.dataset.colorOf] || ''; });
    $$('.swatches').forEach(box => {
      const cur = (s[box.dataset.color] || '').toLowerCase();
      box.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.hex === cur));
    });
  }

  const presetText = ms => (ms % 60000 ? Core.fmt(ms / 1000) : `${ms / 60000} min`);

  // ---------- keyboard screen ----------
  const kbInput = $('kbInput');
  const kb = window.BeamKeyboard.attach($('kb'), kbInput);
  let kbDone = null;

  function setKeyboardMode() {
    // Phones use their own keyboard; the touchscreen and laptops get the big one.
    kbInput.setAttribute('inputmode', phone.matches ? 'text' : 'none');
  }
  setKeyboardMode();
  phone.addEventListener('change', setKeyboardMode);

  function openKeyboard({ title, value = '', done = 'Save', message = false, numeric = false, placeholder = '', onDone }) {
    $('kbTitle').textContent = title;
    $('kbDone').textContent = done;
    $('kbMsgTools').hidden = !message;
    $('kbQuick').hidden = !message;
    kbInput.value = value;
    kbInput.placeholder = placeholder;
    kbInput.classList.remove('bad');
    kbDone = onDone;
    show('kb');
    kb.reset(numeric === 'ip' ? 'ip' : numeric ? 'num' : 'abc');
    kbInput.focus();
    kbInput.setSelectionRange(value.length, value.length);
  }

  function openMessage() {
    flash = false;
    $('kbFlash').classList.remove('on');
    openKeyboard({
      title: 'Message to presenter', done: 'Send ▶', message: true, placeholder: 'Type a message…',
      onDone: text => {
        if (!text.trim()) return false;
        return cmd('message', { text, flash });
      },
    });
  }

  function finish() {
    if (!kbDone) return show('main');
    const ok = kbDone(kbInput.value);
    if (ok === false) { kbInput.classList.add('bad'); return; }
    const back = $('kbMsgTools').hidden ? 'settings' : 'main';
    kbDone = null;
    kbInput.blur();
    show(back);
  }
  onPress($('kbDone'), finish);
  kbInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(); } });
  kbInput.addEventListener('input', () => kbInput.classList.remove('bad'));
  onPress($('kbBack'), () => { const back = $('kbMsgTools').hidden ? 'settings' : 'main'; kbDone = null; kbInput.blur(); show(back); });
  onPress($('kbFlash'), () => { flash = !flash; $('kbFlash').classList.toggle('on', flash); });
  onPress($('kbClearText'), () => { kbInput.value = ''; kbInput.dispatchEvent(new Event('input')); kbInput.focus(); });
  onPress($('kbRemove'), () => cmd('clearMessage'));

  function buildQuick(s) {
    $('kbQuick').innerHTML = '';
    for (const text of s.quickMessages) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = text;
      onPress(b, () => { kbInput.value = text; kbInput.dispatchEvent(new Event('input')); kbInput.focus(); });
      $('kbQuick').appendChild(b);
    }
  }

  // ---------- settings ----------
  $$('#modeSeg button').forEach(b => onPress(b, () => cmd('mode', { mode: b.dataset.mode })));
  $$('#overSeg button').forEach(b => onPress(b, () => cmd('settings', { values: { overtime: b.dataset.over } })));
  // Colour swatches for the display digits (big round targets for touch).
  const SWATCHES = [
    ['#ffffff', 'White'], ['#34c759', 'Green'], ['#ffd60a', 'Yellow'], ['#ffb000', 'Amber'], ['#ff7a00', 'Orange'],
    ['#ff3b30', 'Red'], ['#ff4fa3', 'Pink'], ['#bf5af2', 'Purple'], ['#3d8bff', 'Blue'], ['#32d7f0', 'Cyan'],
  ];
  $$('.swatches').forEach(box => {
    for (const [hex, name] of SWATCHES) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.dataset.hex = hex;
      b.style.background = hex;
      b.title = name;
      b.setAttribute('aria-label', name);
      onPress(b, () => cmd('settings', { values: { [box.dataset.color]: hex } }));
      box.appendChild(b);
    }
  });

  $$('#clockSeg button').forEach(b => onPress(b, () => cmd('settings', { values: { clock24: b.dataset.c24 === '1' } })));

  $$('[data-step]').forEach(b => holdRepeat(b, () => cmd('nudge', { key: b.dataset.step, ms: Number(b.dataset.by) })));
  $$('[data-toggle]').forEach(b => onPress(b, () => {
    const s = link.state;
    if (s) cmd('settings', { values: { [b.dataset.toggle]: !s[b.dataset.toggle] } });
  }));
  onPress($('labelField'), () => openKeyboard({
    title: 'Title above the timer', value: (link.state && link.state.label) || '', placeholder: 'e.g. Opening keynote (leave empty for none)',
    onDone: text => cmd('settings', { values: { label: text.trim() } }),
  }));

  function chip(text, onRemove) {
    const b = document.createElement('button');
    b.className = 'chip removable';
    b.innerHTML = '<span></span><i>✕</i>';
    b.firstChild.textContent = text;
    b.addEventListener('click', () => confirmTap(b, `Remove “${text}”?`, onRemove));
    return b;
  }
  function addChip(label, fn) {
    const b = document.createElement('button');
    b.className = 'chip add';
    b.textContent = label;
    onPress(b, fn);
    return b;
  }

  function buildPresetEdit(s) {
    const box = $('presetEdit');
    box.innerHTML = '';
    s.presets.forEach((ms, i) => box.appendChild(chip(presetText(ms), () => cmd('presets', { list: s.presets.filter((_, j) => j !== i) }))));
    box.appendChild(addChip('+ Add time', () => openKeyboard({
      title: 'Add a preset time', numeric: true, placeholder: 'Minutes (e.g. 25) or m:ss (e.g. 7:30)',
      onDone: text => {
        const ms = Core.parseTime(text);
        if (!ms) return false;
        return cmd('presets', { list: [...new Set([...link.state.presets, ms])].sort((a, b) => a - b) });
      },
    })));
  }

  function buildQuickEdit(s) {
    const box = $('quickEdit');
    box.innerHTML = '';
    s.quickMessages.forEach((t, i) => box.appendChild(chip(t, () => cmd('quickMessages', { list: s.quickMessages.filter((_, j) => j !== i) }))));
    box.appendChild(addChip('+ Add message', () => openKeyboard({
      title: 'Add a quick message', placeholder: 'e.g. Two minutes',
      onDone: text => (text.trim() ? cmd('quickMessages', { list: [...link.state.quickMessages, text.trim()] }) : false),
    })));
  }

  function showDisplays() {
    $$('.dispcount').forEach(p => {
      p.textContent = `${displays.length} display${displays.length === 1 ? '' : 's'}`;
      p.classList.toggle('warnpill', online && displays.length === 0);
    });
    const ul = $('displays');
    ul.innerHTML = '';
    if (!displays.length) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = online ? 'No displays connected.' : 'Not connected.';
      ul.appendChild(li);
    }
    for (const d of displays) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.innerHTML = '<i class="dot"></i>';
      span.append(d.name);
      const ip = document.createElement('small');
      ip.textContent = d.ip + (d.version ? ` · v${d.version}` : '');
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = 'Identify';
      onPress(b, () => cmd('identify', { id: d.id }));
      li.append(span, ip, b);
      ul.appendChild(li);
    }
  }
  showDisplays();
  onPress($('identifyAll'), () => cmd('identify', { id: 'all' }));

  // Scan for new displays: the controller asks every address on its network for a BEAMtime display.
  let scanTimer = null;
  onPress($('scanBtn'), () => {
    if ($('scanBtn').disabled) return;
    if (!link.send({ t: 'scan' })) return cmd('noop');   // offline: shake the status pill
    $('scanBtn').disabled = true;
    $('scanMsg').className = 'upd-msg';
    $('scanMsg').textContent = 'Scanning the network… (about 10 seconds)';
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => showScan({ found: null }), 30000);
  });
  function showScan(m) {
    clearTimeout(scanTimer);
    $('scanBtn').disabled = false;
    const ul = $('scanList');
    ul.innerHTML = '';
    if (!m.found) {
      ul.hidden = true;
      $('scanMsg').className = 'upd-msg bad';
      $('scanMsg').textContent = m.error || 'The scan did not finish. Try again.';
      return;
    }
    const here = new Set(displays.map(d => d.ip));
    const fresh = m.found.filter(d => !here.has(d.ip)).length;
    $('scanMsg').className = 'upd-msg' + (m.found.length ? ' good' : '');
    $('scanMsg').textContent = !m.found.length ? 'No BEAMtime display Pis found on this network.'
      : `Found ${m.found.length} display Pi${m.found.length === 1 ? '' : 's'}` + (fresh ? `, ${fresh} not connected here.` : ', all connected.');
    ul.hidden = !m.found.length;
    for (const d of m.found) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      const ok = here.has(d.ip);
      span.innerHTML = `<i class="dot${ok ? '' : ' off'}"></i>`;
      span.append(d.name);
      const info = document.createElement('small');
      info.textContent = `${d.ip}${d.version ? ` · v${d.version}` : ''} · ` + (ok ? 'connected'
        : d.controller ? `using another controller (${d.controller.replace(/^http:\/\//, '')})`
          : d.controller === null ? 'not connected: looking for the controller' : 'not connected here');
      li.append(span, info);
      ul.appendChild(li);
    }
  }

  // ---------- time of day and network (of the controller Pi) ----------
  let sys = null, sysAt = 0, sysMsgTarget = 'sysMsg';
  const sysSend = m => link.send({ t: 'system', ...m }) || cmd('noop');
  function sysChange(m, target) {
    sysMsgTarget = target;
    $(target).textContent = 'Working…';
    $(target).className = 'upd-msg';
    sysSend(m);
  }
  function showSystem(m) {
    if (m.status) { sys = m.status; sysAt = Date.now(); }
    if (m.result) {
      const el = $(sysMsgTarget);
      el.textContent = m.result.message;
      el.className = 'upd-msg ' + (m.result.ok ? 'good' : 'bad');
    }
    if (!sys) return;
    const can = sys.canChange;
    $$('#ntpSeg button').forEach(b => { b.classList.toggle('active', sys.ntp != null && (b.dataset.ntp === '1') === sys.ntp); b.disabled = !can; });
    $('manualTime').hidden = !can || sys.ntp !== false;
    $('ntpHint').textContent = !can || sys.ntp == null ? 'Changing the clock works on the Pi.'
      : sys.ntp ? (sys.synced ? `Set by internet time · ${sys.timezone}` : `Waiting for internet time (the Pi needs internet) · ${sys.timezone}`)
        : `Set by hand · ${sys.timezone}. A Pi without a clock battery loses the time when unplugged: check it after power-up, or use internet time.`;
    const n = sys.net;
    $('netNow').textContent = !n ? 'Network settings work on the Pi.'
      : `Ethernet: ${n.address ? n.address.replace(/\/\d+$/, '') : 'not connected'} · ${n.mode === 'dhcp' ? 'automatic (DHCP)' : n.mode === 'static' ? 'fixed' : n.mode}`;
    $$('#netSeg button').forEach(b => { b.classList.toggle('active', !!n && b.dataset.net === n.mode); b.disabled = !can || !n; });
  }
  // The Pi's clock, ticking (controller clock, controller time zone).
  setInterval(() => {
    const s = link.state;
    if (!s || $('v-settings').hidden) return;
    const d = new Date(link.now() + tzOff(s));
    const x = hm(s, d.getUTCHours() * 60 + d.getUTCMinutes());
    $('sysTime').textContent = `${x.h}:${x.m}:${String(d.getUTCSeconds()).padStart(2, '0')}${x.ap ? ' ' + x.ap : ''}`;
    $('sysDate').textContent = d.toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    if (Date.now() - sysAt > 10000) { sysAt = Date.now(); sysSend({ action: 'status' }); }
  }, 500);
  $$('#ntpSeg button').forEach(b => onPress(b, () => sysChange({ action: 'ntp', on: b.dataset.ntp === '1' }, 'sysMsg')));
  onPress($('setClock'), openSetClock);
  onPress($('useDeviceTime'), () => sysChange({ action: 'time', at: Date.now() }, 'sysMsg'));
  const dhcpBtn = $('netSeg').querySelector('[data-net=dhcp]');
  onPress(dhcpBtn, () => confirmTap(dhcpBtn, 'Sure? Address may change', () => sysChange({ action: 'net', mode: 'dhcp' }, 'netMsg')));
  onPress($('netSeg').querySelector('[data-net=static]'), () => {
    const n = (sys && sys.net) || {};
    const ipOk = v => /^(\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every(o => Number(o) <= 255);
    openKeyboard({
      title: 'Fixed IP address (Ethernet)', value: (n.address || '').replace(/\/\d+$/, ''), numeric: 'ip', done: 'Next', placeholder: 'e.g. 192.168.1.50',
      onDone: addr => {
        if (!ipOk(addr.trim())) return false;
        setTimeout(() => openKeyboard({
          title: `Gateway (router) for ${addr.trim()}`, value: n.gateway || addr.trim().replace(/\.\d+$/, '.1'), numeric: 'ip', done: 'Set IP', placeholder: 'e.g. 192.168.1.1',
          onDone: gw => {
            if (gw.trim() && !ipOk(gw.trim())) return false;
            sysChange({ action: 'net', mode: 'static', address: addr.trim(), prefix: 24, gateway: gw.trim() }, 'netMsg');
          },
        }), 0);
      },
    });
  });

  // Tell this Pi's server the page is alive and linked (pi/kiosk.sh restarts the browser if not).
  const kioskBeat = () => fetch(`/api/kiosk/beat?online=${link.status === 'online' ? 1 : 0}`, { cache: 'no-store' }).catch(() => {});
  kioskBeat(); setInterval(kioskBeat, 10000);

  // ---------- updates ----------
  let upd = { phase: 'idle' };
  function showUpdate(st) {
    upd = st || upd;
    $('updVersion').textContent = `This controller runs version ${upd.current || link.version || '?'}.`;
    const msg = {
      idle: '',
      checking: 'Checking…',
      current: 'BEAMtime is up to date.',
      available: `Version ${upd.latest} is available.`,
      downloading: `Downloading version ${upd.latest}…`,
      installing: `Installing version ${upd.latest}. When it's done the Pi restarts by itself (about 1–2 minutes in all), then this page comes back.`,
      updated: `Updated to version ${upd.current}. Display Pis follow within a minute or two.`,
      error: upd.error,
      failed: upd.error,
    }[upd.phase] || '';
    const m = $('updMsg');
    m.textContent = msg;
    m.className = 'upd-msg' + (/error|failed/.test(upd.phase) ? ' bad' : upd.phase === 'available' || upd.phase === 'updated' ? ' good' : '');
    $('updNotes').textContent = upd.phase === 'available' ? (upd.notes || '') : '';
    $('updNotes').hidden = !$('updNotes').textContent;
    const busy = ['checking', 'downloading', 'installing'].includes(upd.phase);
    $('updCheck').disabled = busy;
    $('updInstall').hidden = upd.phase !== 'available';
  }
  const updSend = action => link.send({ t: 'update', action }) || cmd('noop');   // cmd() shakes the status pill when offline
  onPress($('updCheck'), () => updSend('check'));
  onPress($('updInstall'), () => confirmTap($('updInstall'), 'Sure? It restarts', () => updSend('install')));
  showUpdate();

  // Scan to control / Scan to display: a QR code per network (Ethernet / Wi-Fi), using the IP so every phone can open it.
  fetch('/api/info').then(r => r.json()).then(info => {
    const port = info.port === 80 ? '' : ':' + info.port;
    const host = `${info.hostname.replace(/\.(local|localdomain)$/, '')}.local`;
    const kind = n => (/^(wl|wlan|wifi)/i.test(n) ? 'Wi-Fi' : /^(eth|end)/i.test(n) ? 'Ethernet' : n);
    const targets = info.ips.length ? info.ips.slice(0, 3).map(i => ({ label: kind(i.ifname) + (i.selfAssigned ? ' (no DHCP)' : ''), host: i.address })) : [{ label: 'Network', host }];
    const codes = (el, page) => { el.innerHTML = ''; for (const t of targets) {
      const url = `http://${t.host}${port}/${page}`;
      const box = document.createElement('figure');
      box.className = 'qr';
      box.innerHTML = window.BeamQR.svg(url);
      const cap = document.createElement('figcaption');
      cap.innerHTML = `<b></b><code></code>`;
      cap.querySelector('b').textContent = t.label;
      cap.querySelector('code').textContent = url.replace('http://', '');
      box.appendChild(cap);
      el.appendChild(box);
    } };
    codes($('qrs'), 'control');
    codes($('qrsDisplay'), 'display');
    $('links').innerHTML = 'Point a phone camera at the code (the phone must be on the same network). Or type ' +
      `<code>http://${host}${port}/control</code>.`;
    $('linksDisplay').innerHTML = 'Turns a phone, tablet, laptop or smart TV browser into a presenter display (same network). ' +
      'Tap the clock for full screen; the screen stays on while it is open. Or type ' +
      `<code>http://${host}${port}/display</code>.`;
  }).catch(() => {});

  // ---------- PIN ----------
  const pad = $('pinPad');
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = k;
    onPress(b, () => {
      const inp = $('pinInput');
      if (k === '⌫') inp.value = inp.value.slice(0, -1);
      else if (k === '✓') $('pinForm').requestSubmit();
      else inp.value += k;
    });
    pad.appendChild(b);
  }
  $('pinForm').onsubmit = e => {
    e.preventDefault();
    link.opts.pin = $('pinInput').value;
    try { localStorage.setItem(PIN_KEY, link.opts.pin); } catch { /* ignore */ }
    link.send({ t: 'hello', role: 'control', name: link.opts.name, pin: link.opts.pin, version: link.version });
    $('pinInput').value = '';
  };

  // ---------- real keyboard shortcuts (main screen) ----------
  document.addEventListener('keydown', e => {
    if ($('v-main').hidden || e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); cmd('toggle'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmd('total', { ms: 60000 }); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); cmd('total', { ms: -60000 }); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); cmd('total', { ms: 10000 }); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); cmd('total', { ms: -10000 }); }
    else if (e.key === 'm' || e.key === 'M' || e.key === 'Enter') { e.preventDefault(); openMessage(); }
    else if (e.key === 'Escape') cmd('clearMessage');
  });
})();
