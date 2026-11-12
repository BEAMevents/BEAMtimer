// Minimal WebSocket server (RFC 6455), text frames only, no dependencies,
// so the Pi needs nothing beyond the Debian "nodejs" package.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1 << 20;

function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | op;
  return Buffer.concat([head, payload]);
}

class Conn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.parts = null;
    this.alive = true;
    this.closed = false;
    socket.on('data', d => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => socket.destroy());
  }

  send(obj) {
    if (this.closed) return;
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    this.socket.write(frame(0x1, Buffer.from(text)));
  }

  ping() { if (!this.closed) this.socket.write(frame(0x9, Buffer.alloc(0))); }

  close() {
    if (this.closed) return;
    try { this.socket.end(frame(0x8, Buffer.alloc(0))); } catch { /* already gone */ }
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.socket.destroy();
        len = Number(big); off = 10;
      }
      if (len > MAX_MESSAGE) return this.socket.destroy();
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = b.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = b.subarray(need);
      this.alive = true;

      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.socket.write(frame(0xA, payload)); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2) this.parts = [payload];
      else if (op === 0x0 && this.parts) this.parts.push(payload);
      else continue;
      if (fin && this.parts) {
        const msg = Buffer.concat(this.parts).toString('utf8');
        this.parts = null;
        this.emit('message', msg);
      }
    }
  }
}

// Calls onConn(conn, req) for each WebSocket opened on `path`.
function attach(server, path, onConn) {
  const conns = new Set();
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    const conn = new Conn(socket);
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    onConn(conn, req);
  });
  // Drop connections that stop answering (pulled cable, Pi switched off).
  const timer = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.socket.destroy(); continue; }
      c.alive = false;
      c.ping();
    }
  }, 5000);
  timer.unref();
  return conns;
}

module.exports = { attach, frame };
