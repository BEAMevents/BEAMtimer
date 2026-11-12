// Updates.
//   Controller: "Check for updates" asks GitHub for the newest BEAMtimer release, downloads
//               beamtimer-X.Y.Z.tar.gz, checks it against the release's .sha256 file, then
//               asks the Pi to install it.
//   Display:    follows the controller: when the controller runs a newer version, the display
//               copies the same file from the controller (no internet needed) and installs it.
// Installing needs root, which this server doesn't have: it leaves a request file in its data
// folder, and the root service beamtimer-update (pi/update.sh) does the install and restarts us.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RELEASES = process.env.BEAMTIMER_UPDATE_URL || 'https://api.github.com/repos/BEAMevents/BEAMtimer/releases/latest';
const MAX_BYTES = 50 * 1024 * 1024;
const BUNDLE_RE = /^beamtimer-(\d+\.\d+\.\d+)\.tar\.gz$/;
const ROOT_HELPER = '/etc/systemd/system/beamtimer-update.path';

const parse = v => String(v || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
function newer(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function get(url, timeout = 20000) {
  const r = await fetch(url, { headers: { 'User-Agent': 'BEAMtimer', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (!r.ok) throw new Error(r.status === 404 ? 'No BEAMtimer release found yet.' : `Update server answered ${r.status}.`);
  return r;
}

// Download url to file, checking the SHA-256 on the way. Returns the file.
async function download(url, file, sha256) {
  const r = await get(url, 120000);
  const part = file + '.part';
  const h = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let size = 0;
  try {
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error('The update file is too big.');
      h.update(chunk);
      if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
    }
    await new Promise((res, rej) => out.end(err => (err ? rej(err) : res())));
  } catch (e) { out.destroy(); try { fs.unlinkSync(part); } catch { /* ignore */ } throw e; }
  if (h.digest('hex') !== sha256) { fs.unlinkSync(part); throw new Error('The update file is damaged (checksum doesn\'t match). Nothing was installed.'); }
  fs.renameSync(part, file);
  return file;
}

class Updater {
  constructor({ version, dataDir, role, onStatus, findController }) {
    Object.assign(this, { version, dataDir, role, onStatus, findController });
    this.dir = path.join(dataDir, 'updates');
    this.status = { phase: 'idle', current: version, latest: null, notes: '', error: '' };
    this.release = null;
    this.lastResult();
    if (role === 'display') this.followTimer = setInterval(() => this.follow().catch(() => {}), 60000);
  }

  set(p) {
    this.status = { ...this.status, ...p };
    if (this.onStatus) this.onStatus(this.status);
  }

  canInstall() { return fs.existsSync(ROOT_HELPER) || process.env.BEAMTIMER_UPDATE_TEST === '1'; }   // TEST: tests only

  // What the root installer said last time (e.g. a failed install).
  lastResult() {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'update-status.json'), 'utf8'));
      if (r.phase === 'failed' && Date.now() - r.at < 24 * 3600e3) this.status = { ...this.status, phase: 'failed', error: r.error || 'The last update did not install.' };
      if (r.phase === 'done' && r.version === this.version && Date.now() - r.at < 600e3) this.status = { ...this.status, phase: 'updated' };
    } catch { /* none yet */ }
  }

  // Controller: is there a newer release on GitHub?
  async check() {
    if (this.busy) return this.status;
    this.busy = true;
    this.set({ phase: 'checking', error: '' });
    try {
      const j = await (await get(RELEASES)).json();
      const latest = String(j.tag_name || '').replace(/^v/, '');
      const asset = (j.assets || []).find(a => BUNDLE_RE.test(a.name));
      const shaAsset = asset && (j.assets || []).find(a => a.name === asset.name + '.sha256');
      if (!latest || !asset || !shaAsset) throw new Error('The newest release has no BEAMtimer update file.');
      const sha = ((await (await get(shaAsset.browser_download_url)).text()).match(/\b[0-9a-f]{64}\b/) || [])[0];
      if (!sha) throw new Error('The newest release has no valid checksum.');
      this.release = { version: BUNDLE_RE.exec(asset.name)[1], url: asset.browser_download_url, sha256: sha };
      const available = newer(this.release.version, this.version);
      this.set({ phase: available ? 'available' : 'current', latest: this.release.version, notes: String(j.body || '').slice(0, 1500), checkedAt: Date.now() });
    } catch (e) {
      const net = e.name === 'TimeoutError' || /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH/.test(`${e.message} ${e.cause && (e.cause.code || e.cause.message)}`);
      this.set({ phase: 'error', error: net
        ? 'Can\'t reach the update server. The controller needs internet to check for updates.' : e.message });
    } finally { this.busy = false; }
    return this.status;
  }

  // Controller: download the release found by check(), then install it.
  async install() {
    if (this.busy) return;
    if (!this.release || !newer(this.release.version, this.version)) return this.set({ phase: 'error', error: 'Check for updates first.' });
    this.busy = true;
    try {
      this.set({ phase: 'downloading', error: '' });
      const file = await this.fetchBundle(this.release.url, this.release.version, this.release.sha256);
      this.request(file, this.release.sha256, this.release.version);
    } catch (e) {
      this.set({ phase: 'error', error: e.message });
    } finally { this.busy = false; }
  }

  async fetchBundle(url, version, sha256) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `beamtimer-${version}.tar.gz`);
    const keep = [path.basename(file), `beamtimer-${this.version}.tar.gz`];   // keep the running version's file for display Pis
    for (const f of fs.readdirSync(this.dir)) if (!keep.some(k => f === k || f === k + '.sha256')) fs.rmSync(path.join(this.dir, f), { force: true });
    await download(url, file, sha256);
    fs.writeFileSync(file + '.sha256', sha256 + '\n');
    return file;
  }

  // Hand the checked file to the root installer (pi/update.sh), which restarts BEAMtimer.
  request(file, sha256, version) {
    if (!this.canInstall()) return this.set({ phase: 'error', error: `Version ${version} downloaded and checked, but this machine can't install it (installing works on a Pi set up with pi/install.sh).` });
    const req = path.join(this.dataDir, 'update-request');
    fs.writeFileSync(req + '.tmp', JSON.stringify({ file, sha256, version }));
    fs.renameSync(req + '.tmp', req);
    this.set({ phase: 'installing', latest: version });
  }

  // The bundle of the version this server runs, for display Pis to copy.
  bundle() {
    const file = path.join(this.dir, `beamtimer-${this.version}.tar.gz`);
    try { return { file, version: this.version, sha256: fs.readFileSync(file + '.sha256', 'utf8').trim() }; } catch { return null; }
  }

  // Display: update to the controller's version when it is newer.
  async follow() {
    if (this.busy || !this.canInstall()) return;
    const base = await this.findController();
    if (!base) return;
    const r = await fetch(base + '/api/update/info', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return;
    const info = await r.json();
    if (!info.version || !newer(info.version, this.version) || !/^[0-9a-f]{64}$/.test(info.sha256 || '')) return;
    if (this.tried && this.tried.version === info.version && Date.now() - this.tried.at < 30 * 60e3) return;
    this.tried = { version: info.version, at: Date.now() };
    this.busy = true;
    try {
      console.log(`Updating to ${info.version} from the controller…`);
      const file = await this.fetchBundle(base + '/api/update/bundle', info.version, info.sha256);
      this.request(file, info.sha256, info.version);
    } catch (e) {
      console.error('Update from the controller failed:', e.message);
    } finally { this.busy = false; }
  }
}

module.exports = { Updater, newer };
