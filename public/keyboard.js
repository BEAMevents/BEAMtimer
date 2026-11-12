// On-screen keyboard for the control Pi's touchscreen (it has no keyboard of its own).
// Types into a normal <input>, so a real keyboard works too. On phones the page
// hides it and uses the phone's own keyboard instead.
(function () {
  const LAYERS = {
    abc: [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
      ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '⌫'],
      ['#+=', 'space', '?', '!'],
    ],
    sym: [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      ['-', '/', ':', ';', '(', ')', '&', '@', '"', '+'],
      ['%', '*', '=', '#', '_', '$', '£', '€', '<', '>'],
      ['…', '–', '•', '[', ']', '{', '}', ',', '.', '⌫'],
      ['ABC', 'space', '?', '!'],
    ],
  };
  LAYERS.num = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], [':', '0', '⌫']];
  const WIDE = { '⇧': 'w15', '⌫': 'w15', '#+=': 'w2', 'ABC': 'w2', 'space': 'w6' };

  // Repeat while held (arrows, backspace): once now, then faster and faster.
  function holdRepeat(el, fn) {
    let t = null;
    const stop = () => { clearTimeout(t); t = null; el.classList.remove('held'); };
    el.addEventListener('pointerdown', e => {
      if (el.disabled || e.button > 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      el.classList.add('held');
      fn();
      let n = 0;
      const loop = () => { n++; fn(); t = setTimeout(loop, n < 5 ? 200 : n < 15 ? 100 : 50); };
      t = setTimeout(loop, 450);
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => el.addEventListener(ev, stop));
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('click', e => { if (e.detail === 0) fn(); }); // Enter/Space on a real keyboard
  }

  // Act on finger-down (feels instant on a touchscreen) without taking focus from the input.
  function onPress(el, fn) {
    el.addEventListener('pointerdown', e => { if (e.button > 0) return; e.preventDefault(); fn(); });
    el.addEventListener('click', e => { if (e.detail === 0) fn(); });
    el.addEventListener('contextmenu', e => e.preventDefault());
  }

  function attach(root, input) {
    let layer = 'abc';
    let shift = false;
    let caps = false;
    let lastShift = 0;

    const autoShift = () => {
      const before = input.value.slice(0, input.selectionStart ?? input.value.length);
      return before.trim() === '' || /[.!?]\s+$/.test(before);
    };

    function insert(text) {
      const a = input.selectionStart ?? input.value.length;
      const b = input.selectionEnd ?? a;
      if (input.maxLength > 0 && input.value.length - (b - a) + text.length > input.maxLength) return;
      input.setRangeText(text, a, b, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function backspace() {
      const a = input.selectionStart ?? input.value.length;
      const b = input.selectionEnd ?? a;
      if (a !== b) input.setRangeText('', a, b, 'end');
      else if (a > 0) input.setRangeText('', a - 1, a, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function draw() {
      root.innerHTML = '';
      root.classList.toggle('numpad', layer === 'num');
      const upper = shift || caps;
      for (const row of LAYERS[layer]) {
        const r = document.createElement('div');
        r.className = 'kb-row';
        for (const k of row) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'key ' + ((layer !== 'num' && WIDE[k]) || '') + (k.length > 1 && k !== 'space' ? ' fn' : '');
          b.textContent = k === 'space' ? 'space' : (upper && k.length === 1 ? k.toUpperCase() : k);
          if (k === '⇧') { b.classList.toggle('on', shift || caps); b.classList.toggle('caps', caps); b.setAttribute('aria-label', 'Shift'); }
          if (k === '⌫') { b.setAttribute('aria-label', 'Delete'); holdRepeat(b, backspace); }
          else onPress(b, () => press(k));
          r.appendChild(b);
        }
        root.appendChild(r);
      }
    }

    function press(k) {
      if (k === '⇧') {
        const now = Date.now();
        if (caps) { caps = false; shift = false; }
        else if (shift && now - lastShift < 400) caps = true;  // double-tap = caps lock
        else shift = !shift;
        lastShift = now;
        return draw();
      }
      if (k === '#+=') { layer = 'sym'; return draw(); }
      if (k === 'ABC') { layer = 'abc'; return draw(); }
      if (k === 'space') insert(' ');
      else insert((shift || caps) && k.length === 1 ? k.toUpperCase() : k);
      const wasShift = shift;
      shift = layer !== 'num' && !caps && autoShift();
      if (wasShift !== shift) draw();
    }

    function reset(which) { layer = which || 'abc'; caps = false; shift = layer !== 'num' && autoShift(); draw(); }
    input.addEventListener('input', () => { if (!caps && layer !== 'num') { const s = autoShift(); if (s !== shift) { shift = s; draw(); } } });
    reset();
    return { reset };
  }

  window.BeamKeyboard = { attach, holdRepeat, onPress };
})();
