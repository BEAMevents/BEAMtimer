// Time of day and network settings of the Pi this server runs on (Settings on the control page).
// Reading needs no special rights. Changing needs root: requests go to pi/system.sh through
// /var/lib/beamtimer/system-request (watched by beamtimer-system.path), like updates do.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HELPER = '/etc/systemd/system/beamtimer-system.path';
const IP_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

const run = (cmd, args) => new Promise(resolve => {
  execFile(cmd, args, { timeout: 4000 }, (err, out) => resolve(err ? '' : String(out || '')));
});

class System {
  constructor({ dataDir }) { this.dataDir = dataDir; this.last = null; }

  canChange() { return fs.existsSync(HELPER) || process.env.BEAMTIMER_SYSTEM_TEST === '1'; }

  async status() {
    const t = await run('timedatectl', ['show', '-p', 'Timezone', '-p', 'NTP', '-p', 'NTPSynchronized']);
    const kv = Object.fromEntries(t.split('\n').filter(Boolean).map(l => l.split('=')));
    let net = null;
    const dev = await run('nmcli', ['-t', '-g', 'GENERAL.CONNECTION,IP4.ADDRESS,IP4.GATEWAY', 'device', 'show', 'eth0']);
    if (dev) {
      const [con, addr, gw] = dev.split('\n');
      const method = con ? (await run('nmcli', ['-g', 'ipv4.method', 'connection', 'show', con])).trim() : '';
      net = { mode: method === 'manual' ? 'static' : method === 'auto' ? 'dhcp' : method || 'unknown', address: (addr || '').trim(), gateway: (gw || '').trim() };
    }
    return {
      time: Date.now(),
      timezone: kv.Timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      ntp: kv.NTP ? kv.NTP === 'yes' : null,
      synced: kv.NTPSynchronized ? kv.NTPSynchronized === 'yes' : null,
      net,
      canChange: this.canChange(),
      last: this.last,
    };
  }

  // Check a request from the page; returns { error } or the cleaned request.
  clean(m) {
    if (m.action === 'ntp') return { action: 'ntp', on: m.on === true };
    if (m.action === 'time') {
      const at = Math.round(Number(m.at));
      if (!(at > Date.UTC(2024, 0, 1)) || at > Date.UTC(2100, 0, 1)) return { error: 'That time is not valid.' };
      return { action: 'time', at };
    }
    if (m.action === 'net') {
      if (m.mode === 'dhcp') return { action: 'net', mode: 'dhcp' };
      if (m.mode === 'static') {
        const address = String(m.address || '').trim(), gateway = String(m.gateway || '').trim();
        const prefix = Number(m.prefix) || 24;
        if (!IP_RE.test(address)) return { error: `"${address}" isn't an IP address.` };
        if (gateway && !IP_RE.test(gateway)) return { error: `"${gateway}" isn't a gateway address.` };
        if (prefix < 8 || prefix > 32) return { error: 'Subnet size not valid.' };
        return { action: 'net', mode: 'static', address, prefix, gateway };
      }
    }
    return { error: 'Unknown setting.' };
  }

  // Hand a change to the root helper and wait for its answer (up to 15 s).
  async change(m) {
    const req = this.clean(m);
    if (req.error) return { ok: false, message: req.error };
    if (!this.canChange()) return { ok: false, message: 'Changing this needs a Pi set up with pi/install.sh.' };
    const id = crypto.randomUUID();
    const file = path.join(this.dataDir, 'system-request');
    const out = path.join(this.dataDir, 'system-status.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ id, ...req }));
    fs.renameSync(file + '.tmp', file);
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const r = JSON.parse(fs.readFileSync(out, 'utf8'));
        if (r.id === id) { this.last = { ok: r.ok, message: r.message, at: Date.now() }; return this.last; }
      } catch { /* not yet */ }
    }
    this.last = { ok: false, message: 'The Pi did not answer. Try again, or restart the Pi.', at: Date.now() };
    return this.last;
  }
}

module.exports = { System };
