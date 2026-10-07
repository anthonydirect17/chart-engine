'use strict';
// The made-up bot client (test/fake-bot.mjs) against the fake bridge's bot channel (--v3): the upgrade's refusals, the welcome,
// live ticks, a signal in shadow, a copilot proposal that is never sent when unanswered (withdrawn: "not answered"), and an
// accepted one; the switch off answers 404. The bot channel's real rules (ChartBridgeBot.cs) are checked under Mono in
// nt8/check/BotHarness.cs. No real bot's rules anywhere: the bot's one signal is written by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', agent: false, headers: { Host: 'localhost:' + port, Origin: 'http://localhost:' + port,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let t = ''; res.on('data', x => t += x); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function get(port, p, unlock) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, agent: false, headers: Object.assign({ Host: 'localhost:' + port }, unlock ? { 'X-ChartBridge-Unlock': unlock } : {}) }, res => {
      let body = ''; res.on('data', x => body += x); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}
async function bridge(extra) {
  const port = 19000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [path.join(__dirname, 'fake-bridge.mjs'), String(port), '--v3', '--trading', '--test-controls', '--test-pin=5820', '--no-v3-seed'].concat(extra || []),
    { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));
  return { port, child };
}
async function nextWhere(ws, type, pred, ms) {
  const end = Date.now() + (ms || 3000);
  for (;;) { const m = await ws.next(type, Math.max(1, end - Date.now())); if (!m || pred(m)) return m; }
}

test('fake-bot: reads its secret from a bot-secret.txt (two # lines, 64 hex), never anything else', async () => {
  const { readSecret } = await import('./fake-bot.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bot-'));
  const f = path.join(dir, 'bot-secret.txt');
  fs.writeFileSync(f, '# ChartBridge bot secret\r\n# Delete this file to make a new one\r\n' + 'ab'.repeat(32) + '\r\n');
  assert.equal(readSecret(f), 'ab'.repeat(32));
  fs.writeFileSync(f, '# torn\nabc\n');
  assert.throws(() => readSecret(f), /64 character/);
});

test('fake-bot against the fake bridge: refusals, welcome, ticks, shadow, copilot (unanswered never sent, accepted placed)', async () => {
  const { connectBot, wsConnect } = await import('./fake-bot.mjs');
  const { port, child } = await bridge();
  try {
    const own = 'http://localhost:' + port;
    const secret = (await post(port, '/test/bot-secret')).json.secret;
    await assert.rejects(wsConnect(port, '/bot', {}), /WebSocket refused: 403/, 'no secret: 403');
    await assert.rejects(wsConnect(port, '/bot', { 'X-ChartBridge-Bot': 'f'.repeat(64) }), /403/, 'a wrong secret: 403');
    await assert.rejects(wsConnect(port, '/bot', { 'X-ChartBridge-Bot': secret, Origin: own }), /403/, 'any Origin (a browser page): 403');

    const bot = await connectBot({ port, secret });
    const w = await bot.next('welcome');
    assert.equal(w.account, 'Sim101'); assert.equal(w.mode, 'shadow'); assert.deepEqual(w.rails, { maxQty: 1, maxTrades: 5, maxLosses: 3 });
    await assert.rejects(connectBot({ port, secret }), /409/, 'one bot at a time');
    assert.ok(await bot.next('tick', 5000), 'the bot reads the live trades');

    // a signed-in v3 page
    const unlock = (await post(port, '/pin/unlock', { pin: '5820' })).json.token;
    const token = JSON.parse((await get(port, '/session', unlock)).body).token;
    const page = await wsConnect(port, '/ws?unlock=' + encodeURIComponent(unlock), { Origin: own });
    await page.next('hello');
    page.send({ type: 'client', v: 3 });
    page.send({ type: 'auth', token });
    assert.equal((await page.next('trading')).enabled, true);
    assert.ok(await page.next('bot'));

    // shadow: shown, nothing placed
    bot.signal('fb-1');
    const s1 = await nextWhere(page, 'botSignal', m => m.id === 'fb-1');
    assert.equal(s1.result, 'shadow');

    // copilot: a proposal; withdrawn before an answer, it is never sent
    page.send({ type: 'botMode', cid: 'm1', mode: 'copilot' });
    assert.ok(await nextWhere(page, 'bot', m => m.mode === 'copilot'));
    bot.signal('fb-2', { side: 'sell' });
    const p2 = await nextWhere(page, 'botProposal', m => m.id === 'fb-2');
    assert.equal(p2.state, 'open'); assert.equal(p2.account, 'Sim101'); assert.equal(p2.qty, 1); assert.match(p2.reason, /^Sample:/);
    page.send({ type: 'botSeen', id: 'fb-2', at: Date.now() });
    bot.withdraw('fb-2');
    assert.equal((await nextWhere(bot, 'answer', m => m.id === 'fb-2')).answer, 'not answered');
    assert.equal((await nextWhere(page, 'botProposal', m => m.id === 'fb-2' && m.state !== 'open')).state, 'not answered');
    page.send({ type: 'botAnswer', cid: 'a1', id: 'fb-2', answer: 'accept', at: Date.now() });
    assert.ok(await page.next('reject'), 'an expired proposal cannot be accepted');
    let v3 = (await post(port, '/test/v3')).json;
    assert.equal(v3.diag.bot.placed, 0, 'nothing placed');
    assert.equal(v3.diag.bot.notAnswered, 1);

    // accepted: placed by the bridge from the proposal's own parameters, on Sim101
    bot.signal('fb-3');
    await nextWhere(page, 'botProposal', m => m.id === 'fb-3');
    page.send({ type: 'botAnswer', cid: 'a2', id: 'fb-3', answer: 'accept', at: Date.now() });
    assert.equal((await nextWhere(bot, 'answer', m => m.id === 'fb-3')).answer, 'accepted');
    v3 = (await post(port, '/test/v3')).json;
    assert.equal(v3.diag.bot.placed, 1);
    bot.close(); page.close();
  } finally { child.kill(); }
});

test('fake-bot: with the bot switch off, /bot answers 404', async () => {
  const { wsConnect } = await import('./fake-bot.mjs');
  const { port, child } = await bridge(['--v3-off=bot']);
  try {
    await assert.rejects(wsConnect(port, '/bot', { 'X-ChartBridge-Bot': '0'.repeat(64) }), /WebSocket refused: 404/);
  } finally { child.kill(); }
});
