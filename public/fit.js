// Scales the whole control page with the window, like a picture.
// The panel is laid out for 1280x720 (the Pi's 10" touchscreen at 150%), then zoomed
// so it just fits: a big monitor makes it bigger, a small window makes it smaller.
// Phones (700 px wide or less) keep their own one-column layout, just shrunk to fit the width.
(function () {
  const W = 1280, H = 720;
  const root = document.documentElement;
  function fit() {
    const w = window.innerWidth, h = window.innerHeight;
    // Phones: the one-column layout needs about 420 px, so smaller phones shrink it a little.
    const z = w <= 700 ? Math.min(1, w / 420) : Math.max(0.4, Math.min(w / W, h / H));
    root.style.zoom = z;
    // 100vh / 100vw would be zoomed too, so give the page the window size in zoomed pixels.
    root.style.setProperty('--vh', h / z + 'px');
    root.style.setProperty('--vw', w / z / 100 + 'px');
    root.classList.toggle('fit', w > 700);
  }
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
})();
