// Red 7-segment LED digits drawn as SVG (no font files, works offline on the Pi).
// Unlit segments stay faintly visible, like a real LED display.
(function () {
  const T = 10;              // segment thickness
  const W = 56, ADV = 66;    // digit width, advance
  const COLON = 26;

  const h = (y, x1, x2) => `${x1},${y} ${x1 + T / 2},${y - T / 2} ${x2 - T / 2},${y - T / 2} ${x2},${y} ${x2 - T / 2},${y + T / 2} ${x1 + T / 2},${y + T / 2}`;
  const v = (x, y1, y2) => `${x},${y1} ${x + T / 2},${y1 + T / 2} ${x + T / 2},${y2 - T / 2} ${x},${y2} ${x - T / 2},${y2 - T / 2} ${x - T / 2},${y1 + T / 2}`;
  const SEG = {
    a: h(6, 9, 47), b: v(50, 9, 48), c: v(50, 52, 91),
    d: h(94, 9, 47), e: v(6, 52, 91), f: v(6, 9, 48), g: h(50, 9, 47),
  };
  const ON = {
    0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
    '-': 'g', '+': 'g', ' ': '', A: 'abcefg', P: 'abefg', M: 'aecb',
  };

  function svg(text) {
    let x = 4;
    const parts = [];
    for (const ch of String(text)) {
      if (ch === ':') {
        parts.push(`<circle class="on" cx="${x + COLON / 2 - 4}" cy="32" r="5.5"/><circle class="on" cx="${x + COLON / 2 - 8}" cy="70" r="5.5"/>`);
        x += COLON;
        continue;
      }
      if (ch === '.') { parts.push(`<circle class="on" cx="${x - 4}" cy="94" r="5"/>`); x += 8; continue; }
      const lit = ON[ch] !== undefined ? ON[ch] : '';
      for (const [k, pts] of Object.entries(SEG)) {
        parts.push(`<polygon class="${lit.includes(k) ? 'on' : 'off'}" points="${pts}" transform="translate(${x} 0)"/>`);
      }
      x += ADV;
    }
    const width = x - (ADV - W) + 6;
    return `<svg viewBox="0 0 ${width} 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><g transform="skewX(-6) translate(6 0)">${parts.join('')}</g></svg>`;
  }

  // Redraws only when the text changes.
  function render(el, text) {
    if (el._seg === text) return;
    el._seg = text;
    el.innerHTML = svg(text);
    el.setAttribute('aria-label', text);
  }

  window.SevenSeg = { render, svg };
})();
