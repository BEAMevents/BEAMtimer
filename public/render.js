// Draws the timer into a "screen" element. Used full-size by the display page
// and as the live preview on the control page, so both always look the same.
(function () {
  const Core = window.BeamTimerCore;

  function build(root) {
    root.classList.add('screen');
    root.innerHTML = `
      <div class="scr-top"><div class="scr-label"></div><div class="scr-clock"></div></div>
      <div class="scr-main"><div class="scr-time"><span></span></div><div class="scr-msg"><span></span></div></div>
      <div class="scr-bar"><div></div></div>
      <div class="scr-ident"></div>
      <div class="scr-link" title="Not connected to the controller"></div>`;
    const q = s => root.querySelector(s);
    return {
      root, label: q('.scr-label'), clock: q('.scr-clock'), main: q('.scr-main'),
      time: q('.scr-time'), timeSpan: q('.scr-time span'), msg: q('.scr-msg'), msgSpan: q('.scr-msg span'),
      bar: q('.scr-bar div'), ident: q('.scr-ident'), link: q('.scr-link'),
      last: {},
    };
  }

  // Largest font size (px) at which el's span fits inside el.
  function fit(el, span, max) {
    let lo = 4, hi = max;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      span.style.fontSize = mid + 'px';
      if (span.offsetWidth <= el.clientWidth && span.offsetHeight <= el.clientHeight) lo = mid; else hi = mid;
    }
    span.style.fontSize = Math.floor(lo) + 'px';
  }

  // shape: same character pattern regardless of digits, so the font only resizes when the layout changes
  const shape = t => t.replace(/\d/g, '0');

  function draw(v, state, now, extra) {
    const r = v.root;
    const last = v.last;
    extra = extra || {};
    if (!state) {
      r.className = 'screen waiting';
      v.timeSpan.textContent = '--:--';
      v.msgSpan.textContent = '';
      v.label.textContent = extra.waitingText || 'Waiting for controller…';
      v.link.style.display = extra.online === false ? '' : 'none';
      if (!last.waiting) { fit(v.time, v.timeSpan, r.clientHeight); v.last = { waiting: true }; }
      return;
    }
    const view = Core.view(state, now);
    const msg = state.message && state.message.text || '';
    const classes = ['screen', 'phase-' + view.phase];
    if (state.blackout) classes.push('blackout');
    if (msg) classes.push('has-msg');
    if (msg && state.message.flash) classes.push('msg-flash');
    if (view.over && state.flashOvertime && state.overtime !== 'stop') classes.push('flash-over');
    if (state.running) classes.push('running');
    if (extra.identify) classes.push('identify');
    const cls = classes.join(' ');
    if (cls !== last.cls) { r.className = cls; last.cls = cls; }

    // Colours picked in Settings
    const colors = `${state.colorNormal}|${state.colorWarn}|${state.colorDanger}`;
    if (colors !== last.colors) {
      last.colors = colors;
      if (state.colorNormal) r.style.setProperty('--normal', state.colorNormal);
      if (state.colorWarn) r.style.setProperty('--warn', state.colorWarn);
      if (state.colorDanger) r.style.setProperty('--danger', state.colorDanger);
    }

    if (view.text !== last.text) v.timeSpan.textContent = view.text;
    if (state.label !== last.label) v.label.textContent = state.label || '';
    const clock = state.showClock && state.mode !== 'clock' ? Core.clockShort(state, now) : '';
    if (clock !== last.clock) v.clock.textContent = clock;
    const p = state.showProgress && view.progress != null ? Math.max(0, Math.min(1, view.progress)) : null;
    v.bar.parentNode.style.visibility = p == null ? 'hidden' : 'visible';
    if (p != null) v.bar.style.transform = `scaleX(${1 - p})`;
    if (msg !== last.msg) v.msgSpan.textContent = msg;
    v.ident.textContent = extra.identify || '';
    v.link.style.display = extra.online === false ? '' : 'none';

    // Refit only when the size or the text layout changed.
    const size = r.clientWidth + 'x' + r.clientHeight;
    const key = size + '|' + shape(view.text) + '|' + (msg ? 1 : 0);
    if (key !== last.fitKey) { fit(v.time, v.timeSpan, r.clientHeight); last.fitKey = key; }
    const mkey = size + '|' + msg;
    if (msg && mkey !== last.msgKey) { fit(v.msg, v.msgSpan, r.clientHeight / 3); last.msgKey = mkey; }
    last.text = view.text; last.label = state.label; last.clock = clock; last.msg = msg;
  }

  window.BeamRender = { build, draw };
})();
