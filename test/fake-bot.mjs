// A MADE-UP bot client for tests (nt8/PROTOCOL.md "Bot channel"). It has NO trading rules: it connects to /bot (ChartBridge's,
// or the fake bridge's with --v3) with no Origin header and the secret in X-ChartBridge-Bot, says hello, beats every second,
// and sends only what it is told: by hand, one signal (a sample reason, never a real bot's), a withdraw, a flatten. Real bots
// and their rules live in the private Bot-Lab repository, never here.
//
// As a module: connectBot({ port, secret }) -> { send, next, beat, stop, close, received }; wsConnect(port, path, headers) for
// any WebSocket (the tests use it for a page too); readSecret(file) reads bot-secret.txt.
// From the command line (a manual check against a running ChartBridge or `node test/fake-bridge.mjs 8765 --v3`):
//   node test/fake-bot.mjs 8765 --secret-file="%USERPROFILE%\Documents\NinjaTrader 8\ChartBridge\bot-secret.txt" --signal --seconds=20
//   options: --secret=<hex>, --signal (one fired signal after the welcome), --side=buy|sell, --kind=market|limit|stop,
//   --price=<p> (limit or stop), --stop=<ticks> (default 12), --target=<ticks> (default 24, "null" for none),
//   --withdraw-after=<ms> (withdraw it), --seconds=<n> (then close; default 10), --silent (no beats: the heartbeat test)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NAME = 'Demo Opening Fade';   // made up
export const SAMPLE_REASON = 'Sample: price stalled at the made-up level twice';

// bot-secret.txt: two # lines, then 64 hex characters. The secret is never printed.
export function readSecret(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines.length !== 1 || !/^[0-9a-fA-F]{64}$/.test(lines[0])) throw new Error('bot-secret.txt does not hold one 64 character secret');
  return lines[0];
}

// A minimal WebSocket client (text frames, masked as a client must). Rejects with "WebSocket refused: <status>" when the
// server answers without upgrading. headers are sent as given: no Origin unless the caller adds one.
export function wsConnect(port, path, headers, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: host || '127.0.0.1', port, path, agent: false, headers: Object.assign({ Host: 'localhost:' + port, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') }, headers || {}) });
    req.on('upgrade', (res, sock, head) => {
      const received = [], waiters = [];
      let buf = Buffer.alloc(0), closed = false;
      const onData = d => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) break;
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f, q = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); q = 4; } else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); q = 10; }
          if (buf.length < q + len) break;
          const body = buf.slice(q, q + len);
          buf = buf.slice(q + len);
          if (op === 8) { closed = true; sock.end(); break; }
          if (op === 1) { try { received.push(JSON.parse(body.toString('utf8'))); } catch (e) { /* not JSON: ignored */ } }
          for (const w of waiters.splice(0)) w();
        }
      };
      sock.on('data', onData); sock.on('error', () => {}); sock.on('close', () => { closed = true; for (const w of waiters.splice(0)) w(); });
      if (head && head.length) onData(head);
      const sendText = text => {
        if (closed) return false;
        const data = Buffer.from(text), mask = crypto.randomBytes(4);
        let h;
        if (data.length < 126) h = Buffer.from([0x81, 0x80 | data.length]);
        else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(data.length, 2); }
        sock.write(Buffer.concat([h, mask, Buffer.from(data.map((b, i) => b ^ mask[i & 3]))]));
        return true;
      };
      // the next message of a type (removed from the list), or null after ms
      const next = async (type, ms) => {
        const end = Date.now() + (ms || 3000);
        for (;;) {
          const i = received.findIndex(m => m.type === type);
          if (i >= 0) return received.splice(i, 1)[0];
          if (Date.now() > end || closed) return null;
          await new Promise(r => { waiters.push(r); setTimeout(r, 50); });
        }
      };
      resolve({ send: obj => sendText(JSON.stringify(obj)), sendText, next, received, isClosed: () => closed, close: () => { closed = true; sock.destroy(); } });
    });
    req.on('response', res => { res.resume(); reject(new Error('WebSocket refused: ' + res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}

// Connects as the bot: no Origin, the secret, botHello; beats every second until stop() (or silent: true).
export async function connectBot({ port, secret, name, silent, host }) {
  const ws = await wsConnect(port, '/bot', { 'X-ChartBridge-Bot': secret }, host);
  ws.send({ type: 'botHello', name: name || NAME });
  let timer = silent ? null : setInterval(() => ws.send({ type: 'beat' }), 1000);
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const closeSocket = ws.close;
  return Object.assign(ws, {
    stop,
    close: () => { stop(); closeSocket(); },
    signal: (id, f) => ws.send(Object.assign({ type: 'signal', id, action: 'fired', side: 'buy', kind: 'market', stopTicks: 12, targetTicks: 24, reason: SAMPLE_REASON }, f || {})),
    withdraw: (id, reason) => ws.send({ type: 'withdraw', id, reason: reason || 'Sample: the entry is no longer valid' }),
  });
}

function flagValue(args, name) { const a = args.find(x => x.startsWith('--' + name + '=')); return a ? a.slice(a.indexOf('=') + 1) : ''; }

async function main() {
  const args = process.argv.slice(2);
  const port = +(args.find(a => /^\d+$/.test(a)) || 8765);
  const secret = flagValue(args, 'secret') || (flagValue(args, 'secret-file') ? readSecret(flagValue(args, 'secret-file')) : '');
  if (!secret) { console.error('fake-bot: give --secret=<hex> or --secret-file=<bot-secret.txt>'); process.exit(2); }
  const bot = await connectBot({ port, secret, silent: args.includes('--silent') });
  const w = await bot.next('welcome', 5000);
  console.log('fake-bot: welcome', JSON.stringify(w));
  if (args.includes('--signal')) {
    const id = 'demo-' + Date.now();
    const kind = flagValue(args, 'kind') || 'market', f = { side: flagValue(args, 'side') || 'buy', kind, stopTicks: +(flagValue(args, 'stop') || 12) };
    f.targetTicks = flagValue(args, 'target') === 'null' ? null : +(flagValue(args, 'target') || 24);
    if (kind !== 'market') f.price = +flagValue(args, 'price');
    bot.signal(id, f);
    console.log('fake-bot: sent signal', id);
    const after = +flagValue(args, 'withdraw-after');
    if (after > 0) setTimeout(() => { bot.withdraw(id); console.log('fake-bot: withdrew', id); }, after);
  }
  const seconds = +(flagValue(args, 'seconds') || 10);
  const shown = new Set(['welcome', 'botState', 'answer', 'reject', 'order', 'position', 'exec']);
  const t = setInterval(() => { for (const m of bot.received.splice(0)) if (shown.has(m.type)) console.log('fake-bot:', JSON.stringify(m)); }, 200);
  setTimeout(() => { clearInterval(t); bot.close(); process.exit(0); }, seconds * 1000);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error('fake-bot: ' + e.message); process.exit(1); });
