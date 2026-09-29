// The fake bridge's PIN (test/fake-bridge.mjs), the same rules as ChartBridge 0.3.2's nt8/ChartBridgePin.cs:
// a salted PBKDF2-SHA256 hash in a pin file (the same format, so either can read the other's), set once, unlock
// with no lockout (a wrong PIN is refused, nothing counted), change with the current PIN, and an unlock token that
// is an HMAC of a nonce keyed by a secret in the pin file, so a restarted bridge still takes it. For tests only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_ITERATIONS = 600000, MIN_ITERATIONS = 1000, MAX_ITERATIONS = 10000000, MAX_BODY_BYTES = 256;
export const HEADER = 'x-chartbridge-unlock';
const LABEL = 'chartbridge-unlock|v1|';
const TOKEN_RX = /^v1\.[0-9a-f]{32}\.[0-9a-f]{64}$/;

export const validPin = p => typeof p === 'string' && /^[0-9]{4}$/.test(p);

// Strict: one flat object whose keys are exactly `keys` (each once), every value a string of ASCII digits (at most
// 8, no escapes); anything else is null. Same grammar as ChartBridgePin.ParseFlat.
export function parseFlat(body, keys) {
  if (typeof body !== 'string') return null;
  let i = 0;
  const n = body.length, ws = () => { while (i < n && ' \t\n\r'.includes(body[i])) i++; };
  const run = digits => {
    if (body[i] !== '"') return null;
    const start = ++i, max = digits ? 8 : 16;
    while (i < n && body[i] !== '"') {
      const c = body[i];
      if (!(digits ? c >= '0' && c <= '9' : /[A-Za-z]/.test(c)) || i - start >= max) return null;
      i++;
    }
    if (i >= n) return null;
    const s = body.slice(start, i); i++;
    return !digits && !s.length ? null : s;
  };
  const d = {};
  ws();
  if (body[i] !== '{') return null;
  i++; ws();
  if (body[i] === '}') i++;
  else for (;;) {
    const k = run(false); if (k === null) return null;
    ws(); if (body[i] !== ':') return null; i++; ws();
    const v = run(true);
    if (v === null || Object.prototype.hasOwnProperty.call(d, k) || !keys.includes(k)) return null;
    d[k] = v; ws();
    if (body[i] === ',') { i++; ws(); continue; }
    if (body[i] === '}') { i++; break; }
    return null;
  }
  ws();
  return i === n && Object.keys(d).length === keys.length ? d : null;
}

const hex = b => Buffer.from(b).toString('hex');
const derive = (pin, salt, it) => new Promise((res, rej) => crypto.pbkdf2(Buffer.from(pin, 'ascii'), salt, it, 32, 'sha256', (e, k) => e ? rej(e) : res(k)));
const mac = (secret, nonce) => crypto.createHmac('sha256', secret).update(LABEL + nonce).digest();

export class PinLock {
  // file: where the pin file lives (null keeps it in memory, lost when the bridge stops)
  constructor({ file = null, iterations = DEFAULT_ITERATIONS } = {}) { this.file = file; this.iterations = iterations; this.mem = null; }

  read() {
    let text = this.mem;
    if (this.file) { try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { return null; } }
    if (!text) return null;
    const line = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    const f = line ? line.split(/ +/) : [];
    if (f.length !== 6 || f[0] !== 'v1' || f[1] !== 'pbkdf2-sha256' || !/^[0-9]+$/.test(f[2])) return null;
    const it = +f[2];
    if (it < MIN_ITERATIONS || it > MAX_ITERATIONS || ![f[3], f[4], f[5]].every(h => /^[0-9a-f]+$/.test(h))) return null;
    const s = { iterations: it, salt: Buffer.from(f[3], 'hex'), hash: Buffer.from(f[4], 'hex'), secret: Buffer.from(f[5], 'hex') };
    return s.salt.length === 16 && s.hash.length === 32 && s.secret.length === 32 ? s : null;
  }
  write(s) {
    const text = ['# ChartBridge PIN (fake bridge): a salted PBKDF2-SHA256 hash of the PIN and the key that keeps open pages unlocked.',
      '# Forgot the PIN? Delete this file; the page then asks for a new PIN.',
      ['v1', 'pbkdf2-sha256', s.iterations, hex(s.salt), hex(s.hash), hex(s.secret)].join(' '), ''].join('\n');
    if (!this.file) { this.mem = text; return; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', text);
    fs.renameSync(this.file + '.tmp', this.file);
  }
  isSet() { return !!this.read(); }
  token(secret) { const nonce = crypto.randomBytes(16).toString('hex'); return 'v1.' + nonce + '.' + hex(mac(secret, nonce)); }
  tokenValid(t) {
    if (typeof t !== 'string' || !TOKEN_RX.test(t)) return false;
    const s = this.read();
    if (!s) return false;
    const [, nonce, m] = t.split('.');
    return crypto.timingSafeEqual(mac(s.secret, nonce), Buffer.from(m, 'hex'));
  }
  // ChartBridge's own page needs the unlock; allowOrigins pages and local programs (no Origin) do not
  wsUnlocked(origin, t, own) {
    if (origin === undefined || origin === null || String(origin).trim().toLowerCase() !== own) return true;
    return this.tokenValid(t);
  }
  async matches(s, pin) { return !!s && validPin(pin) && crypto.timingSafeEqual(await derive(pin, s.salt, s.iterations), s.hash); }

  // each answers { status, token } or { status, reason }
  async set(pin) {
    if (!validPin(pin)) return { status: 400, reason: 'the PIN must be 4 digits' };
    if (this.read()) return { status: 409, reason: 'a PIN is already set on this PC; unlock with it, or change it once unlocked' };
    const salt = crypto.randomBytes(16), s = { iterations: this.iterations, salt, hash: await derive(pin, salt, this.iterations), secret: crypto.randomBytes(32) };
    if (this.read()) return { status: 409, reason: 'a PIN is already set on this PC; unlock with it, or change it once unlocked' };
    this.write(s);
    return { status: 200, token: this.token(s.secret) };
  }
  async unlock(pin) {
    if (!validPin(pin)) return { status: 400, reason: 'the PIN must be 4 digits' };
    const s = this.read();
    if (!s) return { status: 409, reason: 'no PIN is set on this PC yet' };
    if (!(await this.matches(s, pin))) return { status: 403, reason: 'wrong PIN' };
    return { status: 200, token: this.token(s.secret) };
  }
  async change(pin, newPin) {
    if (!validPin(pin) || !validPin(newPin)) return { status: 400, reason: 'each PIN must be 4 digits' };
    const s = this.read();
    if (!s) return { status: 409, reason: 'no PIN is set on this PC yet' };
    if (!(await this.matches(s, pin))) return { status: 403, reason: 'wrong PIN' };
    const salt = crypto.randomBytes(16);
    this.write({ iterations: this.iterations, salt, hash: await derive(newPin, salt, this.iterations), secret: s.secret });
    return { status: 200, token: this.token(s.secret) };
  }

  // POST /pin/status, /pin/set, /pin/unlock, /pin/change with ChartBridge's checks: POST only, Host localhost:<port>,
  // the exact own Origin (as orders), JSON content type, a body of at most 256 bytes, strict keys.
  handle(req, res, port) {
    const reply = (status, obj, extra) => {
      res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
      res.end(JSON.stringify(obj));
    };
    const no = (status, reason, extra) => reply(status, { ok: false, reason }, extra);
    if (req.method !== 'POST') return no(405, 'POST only', { Allow: 'POST' });
    if (req.headers.host !== 'localhost:' + port) return no(403, 'ask by the name localhost');
    if (req.headers.origin !== 'http://localhost:' + port) return no(403, "only ChartBridge's own page");
    const type = String(req.headers['content-type'] || '').trim().toLowerCase();
    if (type !== 'application/json' && !type.startsWith('application/json;')) return no(415, 'JSON only');
    if (+req.headers['content-length'] > MAX_BODY_BYTES) { no(413, 'body too large'); req.destroy(); return; }
    const chunks = []; let size = 0, over = false;
    req.on('data', d => { size += d.length; if (size > MAX_BODY_BYTES) over = true; else chunks.push(d); });
    req.on('end', async () => {
      if (over) return no(413, 'body too large');
      const buf = Buffer.concat(chunks);
      const body = buf.every(c => (c >= 0x20 && c <= 0x7e) || c === 9 || c === 10 || c === 13) ? buf.toString('latin1') : '\u0001';
      const p = new URL(req.url, 'http://x').pathname;
      if (p === '/pin/status') {
        if (!parseFlat(body, [])) return no(400, 'malformed request');
        const set = this.isSet();
        return reply(200, { set, unlocked: set && this.tokenValid(req.headers[HEADER]) });
      }
      let f, r;
      if (p === '/pin/set') r = (f = parseFlat(body, ['pin'])) ? await this.set(f.pin) : null;
      else if (p === '/pin/unlock') r = (f = parseFlat(body, ['pin'])) ? await this.unlock(f.pin) : null;
      else if (p === '/pin/change') r = (f = parseFlat(body, ['pin', 'newPin'])) ? await this.change(f.pin, f.newPin) : null;
      else return no(404, 'not found');
      if (!r) return no(400, 'malformed request');
      if (r.token) return reply(200, { ok: true, token: r.token });
      return no(r.status, r.reason);
    });
  }
}
