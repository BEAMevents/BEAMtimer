// Connection to the controller, used by both pages.
// - Finds the controller (?controller=host:port, else asks this page's own server).
// - Keeps an estimate of the controller's clock, so every screen shows the same time.
// - Reconnects forever, and remembers the last state so a display that reboots
//   mid-show keeps counting before it reconnects.
(function () {
  const CACHE_KEY = 'beamtimer.last';

  function storeGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
  function storeSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

  class Link {
    constructor(opts) {
      this.opts = opts;                 // { role, name, pin, onState, onStatus, onMessage }
      this.ws = null;
      this.offset = 0;                  // controller clock - this clock (ms)
      this.samples = [];
      this.state = null;
      this.status = 'connecting';
      this.lastPong = 0;
      this.retry = 0;
      const cached = storeGet(CACHE_KEY);
      if (cached && cached.state) {
        this.offset = cached.offset || 0;
        this.state = cached.state;
      }
      this.version = '';
      this.watchVersion();
      setInterval(() => this.watchVersion(), 20000);
    }

    // After an update this page's own server restarts with a new version: reload to get the new page.
    async watchVersion() {
      try {
        const j = await (await fetch('/api/info', { cache: 'no-store' })).json();
        if (!j.version) return;
        if (this.version && j.version !== this.version) return location.reload();
        this.version = j.version;
      } catch { /* server restarting */ }
    }

    now() { return Date.now() + this.offset; }

    setStatus(s, detail) {
      this.status = s;
      if (this.opts.onStatus) this.opts.onStatus(s, detail);
    }

    async wsUrl() {
      const q = new URLSearchParams(location.search).get('controller');
      if (q) return `ws://${q.replace(/^\w+:\/\//, '').replace(/\/.*$/, '')}/ws`;
      const r = await fetch('/api/controller', { cache: 'no-store' });
      const j = await r.json();
      if (j.url) return j.url.replace(/^http/, 'ws') + '/ws';
      if (j.self) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      throw new Error(j.error || 'Controller not found');
    }

    async connect() {
      clearTimeout(this.reconnectTimer);
      let url;
      try { url = await this.wsUrl(); }
      catch (e) { this.setStatus('searching', e.message); return this.later(); }
      this.setStatus('connecting', url);
      let ws;
      try { ws = new WebSocket(url); } catch (e) { return this.later(); }
      this.ws = ws;
      ws.onopen = async () => {
        if (!this.version) await this.watchVersion();
        this.retry = 0;
        this.samples = [];
        this.lastPong = Date.now();
        this.send({ t: 'hello', role: this.opts.role, name: this.opts.name, pin: this.opts.pin || '', version: this.version });
        this.ping();
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.ping(), 2000);
      };
      ws.onmessage = ev => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'pong') return this.pong(m);
        if (m.t === 'clockJump') { this.samples = []; this.offsetFrom(m.s, Date.now(), Date.now()); this.ping(); }
        if (m.t === 'welcome') { this.offsetFrom(m.s, Date.now(), Date.now()); this.setStatus('online', m.controller); }
        if (m.t === 'state') {
          this.state = m.state;
          storeSet(CACHE_KEY, { state: m.state, offset: this.offset });
          if (this.opts.onState) this.opts.onState(m.state);
          return;
        }
        if (this.opts.onMessage) this.opts.onMessage(m);
      };
      ws.onclose = () => {
        clearInterval(this.pingTimer);
        if (this.ws === ws) { this.ws = null; this.setStatus('offline'); this.later(); }
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    }

    later() {
      const wait = Math.min(5000, 500 * 2 ** this.retry++);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), wait);
    }

    send(obj) {
      if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; }
      return false;
    }

    cmd(cmd, extra) { return this.send({ t: 'cmd', cmd, ...(extra || {}) }); }

    ping() {
      // No answer for 6 s: the link is dead even if the socket hasn't noticed.
      if (this.ws && Date.now() - this.lastPong > 6000) { try { this.ws.close(); } catch { /* ignore */ } return; }
      this.send({ t: 'ping', c: Date.now() });
    }

    pong(m) {
      this.lastPong = Date.now();
      this.offsetFrom(m.s, m.c, this.lastPong);
    }

    // NTP-style: controller time at the midpoint of the round trip. Keep the
    // sample with the shortest round trip out of the last 10.
    offsetFrom(serverTime, sent, received) {
      const rtt = received - sent;
      this.samples.push({ rtt, offset: serverTime - (sent + received) / 2 });
      if (this.samples.length > 10) this.samples.shift();
      const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      this.offset = best.offset;
      this.rtt = best.rtt;
    }
  }

  window.BeamLink = Link;
})();
