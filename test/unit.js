// BEAMtime tests: timer maths, then a real controller + display server talking
// over WebSocket. Run: node test/unit.js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Core = require('../public/timer-core');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.log('FAIL', name); console.error(e); process.exitCode = 1; }
}

const T0 = 1_000_000_000;
const run = (s, cmds) => cmds.reduce((st, [c, now]) => Core.apply(st, c, now), s);

(async () => {
  // ---------- maths ----------
  await test('countdown shows full time, counts down, hits 0:00', () => {
    let s = Core.apply(Core.defaultState(), { cmd: 'set', ms: 5 * 60000 }, T0);
    assert.strictEqual(Core.view(s, T0).text, '5:00');
    s = Core.apply(s, { cmd: 'start' }, T0);
    assert.strictEqual(Core.view(s, T0 + 1).text, '5:00');
    assert.strictEqual(Core.view(s, T0 + 1000).text, '4:59');
    assert.strictEqual(Core.view(s, T0 + 5 * 60000).text, '0:00');
    assert.strictEqual(Core.view(s, T0 + 5 * 60000).phase, 'over');
  });

  await test('overtime counts up with + and can stop at zero', () => {
    let s = run(Core.defaultState(), [[{ cmd: 'set', ms: 60000 }, T0], [{ cmd: 'start' }, T0]]);
    assert.strictEqual(Core.view(s, T0 + 75000).text, '+0:15');
    s = Core.apply(s, { cmd: 'settings', values: { overtime: 'stop' } }, T0);
    assert.strictEqual(Core.view(s, T0 + 75000).text, '0:00');
  });

  await test('amber and red thresholds', () => {
    const s = run(Core.defaultState(), [[{ cmd: 'set', ms: 10 * 60000 }, T0], [{ cmd: 'start' }, T0]]);
    assert.strictEqual(Core.view(s, T0 + 60000).phase, 'normal');
    assert.strictEqual(Core.view(s, T0 + 8 * 60000).phase, 'warn');      // 2:00 left
    assert.strictEqual(Core.view(s, T0 + 9.5 * 60000).phase, 'danger');  // 0:30 left
  });

  await test('pause keeps time, resume continues', () => {
    const s = run(Core.defaultState(), [
      [{ cmd: 'set', ms: 60000 }, T0], [{ cmd: 'start' }, T0], [{ cmd: 'pause' }, T0 + 10000], [{ cmd: 'start' }, T0 + 50000],
    ]);
    assert.strictEqual(Core.view(s, T0 + 50000).text, '0:50');
    assert.strictEqual(Core.view(s, T0 + 60000).text, '0:40');
  });

  await test('adjust while running, hours format, count up', () => {
    let s = run(Core.defaultState(), [[{ cmd: 'set', ms: 60000 }, T0], [{ cmd: 'start' }, T0], [{ cmd: 'adjust', ms: 3600000 }, T0]]);
    assert.strictEqual(Core.view(s, T0).text, '1:01:00');
    s = run(Core.defaultState(), [[{ cmd: 'mode', mode: 'up' }, T0], [{ cmd: 'start' }, T0]]);
    assert.strictEqual(Core.view(s, T0 + 61000).text, '1:01');
    s = Core.apply(s, { cmd: 'adjust', ms: 60000 }, T0 + 61000);
    assert.strictEqual(Core.view(s, T0 + 61000).text, '2:01');
  });

  await test('total changes the set time in count-up mode without touching elapsed', () => {
    let s = run(Core.defaultState(), [[{ cmd: 'mode', mode: 'up' }, T0], [{ cmd: 'set', ms: 60000 }, T0]]);
    s = Core.apply(s, { cmd: 'mode', mode: 'up' }, T0);
    s = run(s, [[{ cmd: 'start' }, T0], [{ cmd: 'total', ms: 120000 }, T0 + 5000]]);
    assert.strictEqual(s.duration, 180000);
    assert.strictEqual(Core.view(s, T0 + 5000).text, '0:05');
    assert.strictEqual(Core.apply(s, { cmd: 'total', ms: -9e9 }, T0).duration, 0);
  });

  await test('nudge steps warning times and ignores other keys', () => {
    const s0 = Core.defaultState();
    const s = run(s0, [[{ cmd: 'nudge', key: 'warnAt', ms: 30000 }, T0], [{ cmd: 'nudge', key: 'warnAt', ms: 30000 }, T0]]);
    assert.strictEqual(s.warnAt, s0.warnAt + 60000);
    assert.strictEqual(Core.apply(s, { cmd: 'nudge', key: 'dangerAt', ms: -9e9 }, T0).dangerAt, 0);
    assert.strictEqual(Core.apply(s, { cmd: 'nudge', key: 'duration', ms: 1 }, T0), s);
  });

  await test('end by a time: counts down to it, still ends on time after a pause, cancelled by a manual change', () => {
    const at = T0 + 30 * 60000;
    let s = Core.apply(Core.defaultState(), { cmd: 'endBy', at, start: true }, T0);
    assert.strictEqual(s.mode, 'down');
    assert.strictEqual(Core.view(s, T0).text, '30:00');
    s = run(s, [[{ cmd: 'pause' }, T0 + 5 * 60000], [{ cmd: 'start' }, T0 + 10 * 60000]]);
    assert.strictEqual(Core.view(s, T0 + 10 * 60000).text, '20:00');
    assert.strictEqual(Core.view(s, at).text, '0:00');
    s = Core.apply(s, { cmd: 'endBy', at, start: false }, T0 + 20 * 60000);
    assert.strictEqual(s.running, false);
    assert.strictEqual(Core.view(s, T0 + 25 * 60000).text, '10:00');
    s = Core.apply(s, { cmd: 'start' }, T0 + 25 * 60000);
    assert.strictEqual(Core.view(s, T0 + 25 * 60000).text, '5:00');
    s = Core.apply(s, { cmd: 'total', ms: 60000 }, T0 + 26 * 60000);
    assert.strictEqual(s.endBy, null);
    assert.strictEqual(Core.apply(s, { cmd: 'endBy', at: T0 }, T0 + 1), s, 'a time in the past is ignored');
  });

  await test('display colours: valid hex is kept, anything else falls back to the default', () => {
    let s = Core.apply(Core.defaultState(), { cmd: 'settings', values: { colorNormal: '#34C759', colorWarn: 'red', colorDanger: '#123' } }, T0);
    assert.strictEqual(s.colorNormal, '#34c759');
    assert.strictEqual(s.colorWarn, '#ffb000');
    assert.strictEqual(s.colorDanger, '#ff3b30');
    assert.strictEqual(Core.restore({ mode: 'down' }).colorNormal, '#ffffff', 'old saved files get the defaults');
  });

  await test('a cleared timer is idle (not overtime) until started', () => {
    let s = Core.apply(Core.defaultState(), { cmd: 'set', ms: 0 }, T0);
    assert.strictEqual(Core.view(s, T0).phase, 'idle');
    assert.strictEqual(Core.view(s, T0).text, '0:00');
    s = Core.apply(s, { cmd: 'total', ms: 5 * 60000 }, T0);
    assert.strictEqual(Core.view(s, T0).text, '5:00');
    assert.strictEqual(Core.view(s, T0).phase, 'normal');
  });

  await test('clock mode uses the controller time zone', () => {
    const s = { ...Core.apply(Core.defaultState(), { cmd: 'mode', mode: 'clock' }, T0), tzOffsetMin: 60 };
    const noonUTC = Date.UTC(2026, 0, 1, 12, 0, 5);
    assert.strictEqual(Core.view(s, noonUTC).text, '13:00:05');
    assert.strictEqual(Core.view({ ...s, clock24: false }, noonUTC).text, '1:00:05 PM');
  });

  await test('parseTime', () => {
    assert.strictEqual(Core.parseTime('10'), 600000);
    assert.strictEqual(Core.parseTime('5:30'), 330000);
    assert.strictEqual(Core.parseTime('1:00:00'), 3600000);
    assert.strictEqual(Core.parseTime('45s'), 45000);
    assert.strictEqual(Core.parseTime('abc'), null);
  });

  await test('unknown commands change nothing; settings are cleaned', () => {
    const s = Core.defaultState();
    assert.strictEqual(Core.apply(s, { cmd: 'nope' }, T0), s);
    const t = Core.apply(s, { cmd: 'settings', values: { warnAt: -5, evil: 1, overtime: 'x' } }, T0);
    assert.strictEqual(t.warnAt, 0);
    assert.strictEqual(t.overtime, 'continue');
    assert.ok(!('evil' in t));
  });

  // ---------- servers ----------
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'beamtimer-test-'));
  const server = path.join(__dirname, '..', 'server', 'server.js');
  const procs = [];
  const start = (args) => {
    const p = spawn(process.execPath, [server, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    procs.push(p);
    return new Promise(res => p.stdout.once('data', () => res(p)));
  };
  const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, r => {
    let b = ''; r.on('data', d => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: b }));
  }).on('error', rej));

  const CP = 18080 + Math.floor(Math.random() * 1000);
  await start(['--role', 'controller', '--port', String(CP), '--data', data, '--pin', '4321']);
  await start(['--role', 'display', '--port', String(CP + 1), '--controller', `127.0.0.1:${CP}`, '--name', 'Test display']);

  await test('pages and API are served', async () => {
    assert.strictEqual((await get(CP, '/control')).status, 200);
    assert.strictEqual((await get(CP + 1, '/display')).status, 200);
    assert.strictEqual((await get(CP, '/assets/timer-core.js')).status, 200);
    assert.strictEqual((await get(CP, '/assets/../server/server.js')).status, 404);
    const info = JSON.parse((await get(CP + 1, '/api/info')).body);
    assert.strictEqual(info.role, 'display');
    const c = JSON.parse((await get(CP + 1, '/api/controller')).body);
    assert.strictEqual(c.url, `http://127.0.0.1:${CP}`);
  });

  // tiny WebSocket client
  function wsClient(port) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1');
      const key = crypto.randomBytes(16).toString('base64');
      const msgs = [];
      const waiters = [];
      let buf = Buffer.alloc(0), upgraded = false;
      sock.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      sock.on('error', reject);
      sock.on('data', d => {
        buf = Buffer.concat([buf, d]);
        if (!upgraded) {
          const i = buf.indexOf('\r\n\r\n');
          if (i < 0) return;
          const head = buf.subarray(0, i).toString();
          const want = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          if (!head.includes(want)) return reject(new Error('bad handshake'));
          upgraded = true; buf = buf.subarray(i + 4);
          resolve(api);
        }
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          if (buf.length < off + len) return;
          const op = buf[0] & 0xf;
          const payload = buf.subarray(off, off + len).toString();
          buf = buf.subarray(off + len);
          if (op !== 1) continue;
          const m = JSON.parse(payload);
          msgs.push(m);
          for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
        }
      });
      const api = {
        send(obj) {
          const p = Buffer.from(JSON.stringify(obj));
          const mask = crypto.randomBytes(4);
          const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0xfe, p.length >> 8, p.length & 255]);
          const body = Buffer.from(p.map((b, i) => b ^ mask[i & 3]));
          sock.write(Buffer.concat([head, mask, body]));
        },
        wait(test, ms = 2000) {
          const hit = msgs.find(test);
          if (hit) { msgs.splice(msgs.indexOf(hit), 1); return Promise.resolve(hit); }
          return new Promise((res, rej) => { waiters.push({ test, res }); setTimeout(() => rej(new Error('timeout')), ms); });
        },
        clear() { msgs.length = 0; },
        close() { sock.destroy(); },
      };
    });
  }

  await test('display gets state; control needs the PIN; commands reach the display', async () => {
    const disp = await wsClient(CP);
    disp.send({ t: 'hello', role: 'display', name: 'Test display' });
    await disp.wait(m => m.t === 'state');

    const ctl = await wsClient(CP);
    ctl.send({ t: 'hello', role: 'control', name: 'Test', pin: 'wrong' });
    assert.strictEqual((await ctl.wait(m => m.t === 'auth')).ok, false);
    ctl.send({ t: 'cmd', cmd: 'start' });
    await assert.rejects(disp.wait(m => m.t === 'state' && m.state.running, 400));

    ctl.clear();
    ctl.send({ t: 'hello', role: 'control', name: 'Test', pin: '4321' });
    assert.strictEqual((await ctl.wait(m => m.t === 'auth')).ok, true);
    const list = await ctl.wait(m => m.t === 'clients' && m.list.some(c => c.role === 'display'));
    const d = list.list.find(c => c.role === 'display');
    assert.strictEqual(d.name, 'Test display');

    ctl.send({ t: 'cmd', cmd: 'set', ms: 90000, start: true });
    const st = await disp.wait(m => m.t === 'state' && m.state.running);
    assert.strictEqual(st.state.duration, 90000);
    assert.strictEqual(Core.view(st.state, st.s).text, '1:30');

    ctl.send({ t: 'cmd', cmd: 'message', text: 'Wrap up', flash: true });
    const sm = await disp.wait(m => m.t === 'state' && m.state.message);
    assert.strictEqual(sm.state.message.text, 'Wrap up');

    ctl.send({ t: 'cmd', cmd: 'identify', id: d.id });
    await disp.wait(m => m.t === 'identify' && m.name === 'Test display');

    const t0 = Date.now();
    disp.send({ t: 'ping', c: t0 });
    const pong = await disp.wait(m => m.t === 'pong');
    assert.strictEqual(pong.c, t0);
    assert.ok(Math.abs(pong.s - Date.now()) < 1000);
    disp.close(); ctl.close();
  });

  await test('state survives a controller restart', async () => {
    await new Promise(r => setTimeout(r, 400)); // let the save land
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
    assert.strictEqual(saved.duration, 90000);
    assert.strictEqual(saved.running, true);
  });

  await test('clock jump (set by hand / internet time) does not move a running timer', async () => {
    // A controller whose clock jumps 1 hour ahead 2.5 s after starting.
    const pre = path.join(data, 'jump.js');
    fs.writeFileSync(pre, 'setTimeout(() => { const real = Date.now; Date.now = () => real() + 3600000; }, 2500);');
    const JP = CP + 5;
    const p = spawn(process.execPath, ['--require', pre, server, '--role', 'controller', '--port', String(JP), '--data', path.join(data, 'j')], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    procs.push(p);
    await new Promise(res => p.stdout.once('data', res));
    const c = await wsClient(JP);
    c.send({ t: 'hello', role: 'control', name: 'T' });
    await c.wait(m => m.t === 'auth');
    c.send({ t: 'cmd', cmd: 'set', ms: 600000, start: true });
    const before = (await c.wait(m => m.t === 'state' && m.state.running)).state;
    c.clear();
    const jump = await c.wait(m => m.t === 'clockJump', 5000);
    assert.ok(Math.abs(jump.by - 3600000) < 3000, 'jump of about an hour seen: ' + jump.by);
    const after = (await c.wait(m => m.t === 'state' && m.state.startedAt !== before.startedAt)).state;
    const leftSec = Math.round((after.duration - (jump.s - after.startedAt)) / 1000);
    assert.ok(leftSec >= 595 && leftSec <= 598, 'still about 9:57 left, not an hour less: ' + leftSec);
    c.close();
  });

  await test('clock / network settings: status, and refused off a Pi', async () => {
    const c = await wsClient(CP);
    c.send({ t: 'hello', role: 'control', name: 'T', pin: '4321' });
    await c.wait(m => m.t === 'auth');
    c.send({ t: 'system', action: 'status' });
    const st = (await c.wait(m => m.t === 'system' && m.status)).status;
    assert.ok(Math.abs(st.time - Date.now()) < 5000);
    c.send({ t: 'system', action: 'net', mode: 'static', address: '999.1.1.1' });
    assert.strictEqual((await c.wait(m => m.t === 'system' && m.result)).result.ok, false);
    c.close();
  });

  for (const p of procs) p.kill();
  fs.rmSync(data, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
