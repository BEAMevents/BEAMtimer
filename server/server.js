#!/usr/bin/env node
// BEAMtime server. One program, two roles:
//   controller: holds the timer, serves the control page, and is the WebSocket hub
//   display:    serves the display page locally and tells it where the controller is
// Usage: node server/server.js [--role controller|display] [--port 8080]
//        [--controller host[:port]|auto] [--name "Stage left"] [--pin 1234]
//        [--config /etc/beamtimer/config.json] [--data ./data]
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns');
const { execFile } = require('child_process');
const ws = require('./ws');
const { Updater } = require('./update');
const { System } = require('./system');
const Core = require('../public/timer-core');

const VERSION = require('../package.json').version;
const PUBLIC = path.join(__dirname, '..', 'public');

// ---------- config ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) continue;
    const val = m[2] !== undefined ? m[2] : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    out[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const configPath = args.config || process.env.BEAMTIMER_CONFIG || '';
let fileConfig = {};
if (configPath) {
  try { fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { console.error(`Could not read ${configPath}: ${e.message}`); }
}
const cfg = {
  role: 'controller', port: 8080, controller: 'auto', name: '', pin: '',
  dataDir: process.env.STATE_DIRECTORY || path.join(__dirname, '..', 'data'),
  ...fileConfig, ...args,
};
if (args.data) cfg.dataDir = args.data;
cfg.port = Number(cfg.port) || 8080;
cfg.pin = String(cfg.pin || '');
if (!['controller', 'display'].includes(cfg.role)) { console.error('role must be controller or display'); process.exit(1); }
const NAME = cfg.name || os.hostname().replace(/\.local$/, '');

function localIPs() {
  const out = [];
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // 169.254.x.x: self-assigned (no DHCP server). Listed last, and only used when there's nothing else.
      out.push({ ifname, address: a.address, ...(a.address.startsWith('169.254.') ? { selfAssigned: true } : {}) });
    }
  }
  return out.sort((a, b) => !!a.selfAssigned - !!b.selfAssigned);
}

// ---------- timer state (controller only) ----------
const statePath = path.join(cfg.dataDir, 'state.json');
let state = Core.defaultState();
if (cfg.role === 'controller') {
  try { state = Core.restore(JSON.parse(fs.readFileSync(statePath, 'utf8'))); } catch { /* first run */ }
}
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.writeFileSync(statePath + '.tmp', JSON.stringify(state));
      fs.renameSync(statePath + '.tmp', statePath);
    } catch (e) { console.error('Could not save state:', e.message); }
  }, 250);
}

function publicState() {
  return { ...state, tzOffsetMin: -new Date().getTimezoneOffset() };
}

// ---------- WebSocket hub (controller only) ----------
const clients = new Map(); // conn -> { id, role, name, ip, authed, since }
let nextId = 1;

function broadcast(msg, filter) {
  const text = JSON.stringify(msg);
  for (const [conn, info] of clients) if (!filter || filter(info)) conn.send(text);
}
const sendState = () => broadcast({ t: 'state', state: publicState(), s: Date.now() }, i => i.role);
const clientList = () => [...clients.values()].filter(i => i.role)
  .map(({ id, role, name, ip, since, version }) => ({ id, role, name, ip, since, version }));
const sendClients = () => broadcast({ t: 'clients', list: clientList() }, i => i.role === 'control' && i.authed);

function onConn(conn, req) {
  const info = { id: nextId++, role: null, name: '', ip: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''), authed: false, since: Date.now() };
  clients.set(conn, info);
  conn.on('close', () => { clients.delete(conn); sendClients(); });
  conn.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ping') return conn.send({ t: 'pong', c: m.c, s: Date.now() });
    if (m.t === 'hello') {
      info.role = m.role === 'control' ? 'control' : 'display';
      info.name = String(m.name || '').slice(0, 60) || (info.role === 'display' ? 'Display' : 'Control');
      info.version = /^\d+\.\d+\.\d+$/.test(m.version || '') ? m.version : '';
      info.authed = info.role === 'display' || !cfg.pin || String(m.pin || '') === cfg.pin;
      conn.send({ t: 'welcome', id: info.id, s: Date.now(), controller: NAME, version: VERSION, pinRequired: !!cfg.pin });
      if (info.role === 'control') conn.send({ t: 'auth', ok: info.authed });
      conn.send({ t: 'state', state: publicState(), s: Date.now() });
      if (info.role === 'control' && info.authed) conn.send({ t: 'clients', list: clientList() });
      if (info.role === 'control' && info.authed) conn.send({ t: 'update', status: updater.status });
      sendClients();
      return;
    }
    if (m.t === 'system') {   // time of day / network of this Pi
      if (info.role !== 'control' || !info.authed) return conn.send({ t: 'auth', ok: false });
      (async () => {
        if (m.action === 'status') return conn.send({ t: 'system', status: await system.status() });
        const result = await system.change(m);
        const status = await system.status();
        broadcast({ t: 'system', status, result }, i => i.role === 'control' && i.authed);
      })().catch(e => conn.send({ t: 'system', result: { ok: false, message: e.message } }));
      return;
    }
    if (m.t === 'restartDisplay') {   // Settings → Displays → Restart (a display Pi found by the scan)
      if (info.role !== 'control' || !info.authed || cfg.role !== 'controller') return conn.send({ t: 'auth', ok: false });
      const ip = String(m.ip || '');
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return;
      fetch(`http://${ip}/api/restart`, { method: 'POST', signal: AbortSignal.timeout(20000) })
        .then(r => r.json()).catch(() => ({ ok: false, message: 'The display did not answer.' }))
        .then(r => conn.send({ t: 'restartDisplay', ip, ok: !!r.ok, message: r.message || '' }));
      return;
    }
    if (m.t === 'scan') {   // Settings → Displays → Scan for new displays
      if (info.role !== 'control' || !info.authed || cfg.role !== 'controller') return conn.send({ t: 'auth', ok: false });
      scanDisplays().then(found => conn.send({ t: 'scan', found }), () => conn.send({ t: 'scan', found: [], error: 'Scan failed' }));
      return;
    }
    if (m.t === 'update') {
      if (info.role !== 'control' || !info.authed) return conn.send({ t: 'auth', ok: false });
      if (m.action === 'check') updater.check();
      else if (m.action === 'install') updater.install();
      else conn.send({ t: 'update', status: updater.status });
      return;
    }
    if (m.t === 'cmd') {
      if (info.role !== 'control' || !info.authed) return conn.send({ t: 'auth', ok: false });
      if (m.cmd === 'identify') {
        const until = Date.now() + 6000;
        for (const [c, i] of clients) {
          if (i.role === 'display' && (m.id === 'all' || i.id === m.id)) c.send({ t: 'identify', name: i.name, until });
        }
        return;
      }
      const next = Core.apply(state, m, Date.now());
      if (next !== state) { state = next; saveSoon(); sendState(); }
    }
  });
}

const kiosk = { beatAt: 0, onlineAt: 0 };

// ---------- finding the controller (display only) ----------
let found = { url: null, at: 0 };

function avahiBrowse() {
  return new Promise(resolve => {
    execFile('avahi-browse', ['-rpt', '_beamtimer._tcp'], { timeout: 4000 }, (err, out) => {
      if (err || !out) return resolve(null);
      const found = [];
      for (const line of out.split('\n')) {
        const f = line.split(';');
        // =;eth0;IPv4;BEAMtime on host;_beamtimer._tcp;local;host.local;192.168.1.20;80;"role=controller"
        if (f[0] === '=' && f[2] === 'IPv4' && f[7]) found.push(`http://${f[7]}:${f[8]}`);
      }
      // A normal address first; a self-assigned one (169.254.x.x, no DHCP) also works on the same switch.
      found.sort((a, b) => a.includes('//169.254.') - b.includes('//169.254.'));
      resolve(found[0] || null);
    });
  });
}

function lookup(host) {
  return new Promise(resolve => dns.lookup(host, { family: 4 }, (err, addr) => resolve(err ? null : addr)));
}

async function findController() {
  if (cfg.role === 'controller') return null; // same origin
  if (found.url && Date.now() - found.at < 10000) return found.url;
  let url = null;
  const want = String(cfg.controller || 'auto').trim();
  if (want && want !== 'auto') {
    const [host, port] = want.replace(/^https?:\/\//, '').replace(/\/.*$/, '').split(':');
    const addr = /^[\d.]+$/.test(host) ? host : await lookup(host);
    if (addr) url = `http://${addr}:${port || 80}`;
  } else {
    url = await avahiBrowse();
    if (!url) { const addr = await lookup('beamtimer-control.local'); if (addr) url = `http://${addr}:80`; }
  }
  found = { url, at: url ? Date.now() : 0 };
  return url;
}

// ---------- scanning for displays (controller only) ----------
// Asks every address on this controller's local networks (its /24) for /api/info on port 80.
// Works without mDNS. Returns the BEAMtime displays found, with the controller each one uses.
let scanning = null;
function scanDisplays() {
  if (scanning) return scanning;
  const self = new Set(localIPs().map(i => i.address));
  const targets = [];
  for (const { address, selfAssigned } of localIPs()) {
    if (selfAssigned) continue;   // 169.254.0.0/16 is too big to check address by address
    const base = address.split('.').slice(0, 3).join('.');
    for (let n = 1; n < 255; n++) { const ip = `${base}.${n}`; if (!self.has(ip) && !targets.includes(ip)) targets.push(ip); }
  }
  const found = [];
  const probe = async ip => {
    try {
      const r = await fetch(`http://${ip}/api/info`, { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      if (j && j.app === 'BEAMtimer' && j.role === 'display') {
        const controller = 'controller' in j ? j.controller : undefined;   // undefined: older version, doesn't say
        const host = controller ? controller.replace(/^\w+:\/\//, '').split(/[:/]/)[0] : '';
        found.push({ ip, name: j.name || j.hostname || ip, version: j.version || '', controller, usesThis: !!host && (self.has(host) || host === os.hostname() + '.local') });
      }
    } catch { /* nothing there */ }
  };
  scanning = (async () => {
    const queue = targets.slice();
    await Promise.all(Array.from({ length: 64 }, async () => { while (queue.length) await probe(queue.shift()); }));
    return found.sort((a, b) => a.ip.split('.').map(Number).reduce((x, y) => x * 256 + y) - b.ip.split('.').map(Number).reduce((x, y) => x * 256 + y));
  })().finally(() => { scanning = null; });
  return scanning;
}

// ---------- clock changes ----------
// If this computer's clock is changed (set by hand, or corrected by internet time), a running
// timer must not jump: move its start by the same amount. "End by" keeps its time of day.
const system = new System({ dataDir: cfg.dataDir });
if (cfg.role === 'controller') {
  let wall = Date.now(), mono = performance.now();
  setInterval(() => {
    const w = Date.now(), m = performance.now();
    const jump = Math.round((w - wall) - (m - mono));
    wall = w; mono = m;
    if (Math.abs(jump) < 1500) return;
    console.log(`Clock changed by ${Math.round(jump / 1000)} s; keeping the timer where it was.`);
    const s = { ...state };
    if (s.running && s.startedAt != null) {
      s.startedAt += jump;
      if (s.endBy && s.mode === 'down') s.duration = Math.max(0, Math.min(Core.MAX_MS, s.elapsedBefore + s.endBy - s.startedAt));
    }
    s.rev = (s.rev || 0) + 1;
    state = s;
    saveSoon();
    broadcast({ t: 'clockJump', by: jump, s: w }, i => i.role);
    sendState();
  }, 1000);
}

// ---------- updates ----------
const updater = new Updater({
  version: VERSION, dataDir: cfg.dataDir, role: cfg.role,
  onStatus: status => { if (cfg.role === 'controller') broadcast({ t: 'update', status }, i => i.role === 'control' && i.authed); },
  findController: async () => (cfg.role === 'display' ? findController() : null),
});

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function sendJSON(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/') { res.writeHead(302, { Location: cfg.role === 'controller' ? '/control' : '/display' }); return res.end(); }
  if (p === '/control' || p === '/display') return sendFile(res, path.join(PUBLIC, p.slice(1) + '.html'));
  if (p === '/api/info') {
    return sendJSON(res, { app: 'BEAMtimer', version: VERSION, role: cfg.role, name: NAME, hostname: os.hostname(), port: cfg.port, ips: localIPs(), clients: cfg.role === 'controller' ? clientList().length : undefined,
      controller: cfg.role === 'display' ? (found.url || null) : undefined });
  }
  // Current timer, read-only (used by the NDI sender). s = controller clock, for the offset.
  if (p === '/api/state' && cfg.role === 'controller') return sendJSON(res, { state: publicState(), s: Date.now() });
  // Watchdog for the Pi's own full-screen browser (pi/kiosk.sh): the page beats every 10 s.
  if (p === '/api/kiosk/beat') {
    const local = /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');
    if (local) { kiosk.beatAt = Date.now(); if (url.searchParams.get('online') === '1') kiosk.onlineAt = Date.now(); }
    return sendJSON(res, { ok: local });
  }
  if (p === '/api/kiosk/check') {
    const now = Date.now();
    const quiet = now - kiosk.beatAt > 60000;   // page not running (stuck, crashed, never loaded)
    let reachable = cfg.role === 'controller';
    if (!reachable) {
      const u = await findController();
      if (u) reachable = await fetch(u + '/api/info', { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
    }
    const stuck = reachable && now - kiosk.onlineAt > 90000;   // page running but not linked, though the controller answers
    return sendJSON(res, { restart: quiet || stuck, quiet, stuck, reachable });
  }
  // What's going on with this Pi, readable from the controller or a laptop (no password needed).
  if (p === '/api/diag') {
    const tail = (f, n = 40) => { try { return fs.readFileSync(f, 'utf8').split('\n').slice(-n).join('\n'); } catch { return null; } };
    const home = os.homedir();
    let updateStatus = null;
    try { updateStatus = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'update-status.json'), 'utf8')); } catch { /* none */ }
    return sendJSON(res, {
      version: VERSION, role: cfg.role, name: NAME, uptimeSec: Math.round(os.uptime()),
      screen: { lastReportSecAgo: kiosk.beatAt ? Math.round((Date.now() - kiosk.beatAt) / 1000) : null, lastConnectedSecAgo: kiosk.onlineAt ? Math.round((Date.now() - kiosk.onlineAt) / 1000) : null },
      controller: cfg.role === 'display' ? (found.url || null) : undefined,
      updateStatus, updateLog: tail(path.join(cfg.dataDir, 'update.log')),
      browserLog: tail(path.join(home, '.cache', 'beamtime-kiosk.log')), browserLogLast: tail(path.join(home, '.cache', 'beamtime-kiosk.log.last')),
    });
  }
  // Restart this display Pi. Only its own controller may ask (Settings → Displays → Restart).
  if (p === '/api/restart' && req.method === 'POST' && cfg.role === 'display') {
    const from = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const u = await findController();
    let allowed = false;
    if (u) {
      const host = u.replace(/^\w+:\/\//, '').split(/[:/]/)[0];
      allowed = from === host;
      if (!allowed) {
        const info = await fetch(u + '/api/info', { signal: AbortSignal.timeout(2000) }).then(r => r.json(), () => null);
        allowed = !!(info && (info.ips || []).some(i => i.address === from));
      }
    }
    if (!allowed) return sendJSON(res, { ok: false, message: 'Only this display\'s controller can restart it.' }, 403);
    return sendJSON(res, await system.change({ action: 'reboot' }));
  }
  if (p === '/api/controller') {
    if (cfg.role === 'controller') return sendJSON(res, { url: null, self: true });
    const u = await findController();
    return u ? sendJSON(res, { url: u }) : sendJSON(res, { url: null, error: 'Controller not found yet' }, 503);
  }
  // The update file of the version this controller runs, for display Pis to copy.
  if (p === '/api/update/info' || p === '/api/update/bundle') {
    const b = cfg.role === 'controller' && updater.bundle();
    if (!b) return sendJSON(res, { error: 'No update file here' }, 404);
    if (p === '/api/update/info') return sendJSON(res, { version: b.version, sha256: b.sha256 });
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Cache-Control': 'no-store' });
    return fs.createReadStream(b.file).pipe(res);
  }
  if (p.startsWith('/assets/')) {
    const name = path.basename(p);
    if (!TYPES[path.extname(name)]) return sendJSON(res, { error: 'Not found' }, 404);
    return sendFile(res, path.join(PUBLIC, name));
  }
  if (p === '/favicon.ico') return sendFile(res, path.join(PUBLIC, 'icon.png'));
  sendJSON(res, { error: 'Not found' }, 404);
});

if (cfg.role === 'controller') ws.attach(server, '/ws', onConn);

server.on('error', e => { console.error(`Server error: ${e.message}`); process.exit(1); });
server.listen(cfg.port, () => {
  console.log(`BEAMtime ${VERSION} ${cfg.role} "${NAME}" on port ${cfg.port}`);
  for (const ip of localIPs()) console.log(`  http://${ip.address}${cfg.port === 80 ? '' : ':' + cfg.port}/  (${ip.ifname})`);
  if (cfg.role === 'display') console.log(`  controller: ${cfg.controller || 'auto'}`);
});

function shutdown() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    try { fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(state)); } catch { /* ignore */ }
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
