'use strict';
// The made-up agent client (test/fake-agent.mjs) against a small stand-in for ChartBridge's /agent/<id> upgrade, written here:
// the upgrade's answers (404, 403, 409), agentHello first, the beats, and every message it sends checked against the strict
// contract, with the keys read from nt8/ChartBridgeAgents.cs itself (so the client and the C# cannot drift apart). The agent
// channel's real rules are checked under Mono in nt8/check/AgentHarness.cs. No real agent's logic anywhere: every plan is a sample.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

const cs = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'ChartBridgeAgents.cs'), 'utf8');

// The agent's message keys, as ChartBridgeAgents.cs allows them (AgentKeys).
function agentKeys() {
  const block = cs.slice(cs.indexOf('AgentKeys = new Dictionary'), cs.indexOf('};', cs.indexOf('AgentKeys = new Dictionary')));
  const keys = {};
  for (const m of block.matchAll(/\{ "(\w+)", new\[\] \{ ([^}]*) \} \}/g)) keys[m[1]] = [...m[2].matchAll(/"(\w+)"/g)].map(x => x[1]);
  return keys;
}

// Gate 8 as the agent channel reads it: one flat object, plain strings (no backslash, no control character) of at most 200
// characters, except note.text (1,000); numbers plain (no sign, no exponent); only the keys allowed for the type.
function strictProblem(text, keys) {
  if (text.includes('\\')) return 'an escape';
  let o;
  try { o = JSON.parse(text); } catch (e) { return 'not JSON'; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'not an object';
  const allowed = keys[o.type];
  if (!allowed) return 'unknown type ' + o.type;
  for (const [k, v] of Object.entries(o)) {
    if (!allowed.includes(k)) return 'unknown key ' + k;
    if (v !== null && typeof v === 'object') return 'nested ' + k;
    if (typeof v === 'string') {
      if (v.length > (o.type === 'note' && k === 'text' ? 1000 : 200)) return k + ' too long';
      if ([...v].some(ch => ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f)) return k + ' has a control character';
    }
    if (typeof v === 'number' && (v < 0 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(JSON.stringify(v)))) return k + ' is not a plain number';
  }
  return null;
}

// A stand-in for ChartBridge's /agent/<id> upgrade (the C#'s answers, in its order), recording each message.
function standIn(agents) {
  const got = [], sockets = new Set();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, sock) => {
    const reply = code => { sock.end('HTTP/1.1 ' + code + ' X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); };
    const m = /^\/agent\/(.*)$/.exec(req.url), id = m ? m[1] : null, a = agents[id];
    if (!a) return reply(404);
    if (req.headers.origin !== undefined) return reply(403);
    if (req.headers['x-chartbridge-agent'] !== a.secret) return reply(403);
    if (a.busy) return reply(409);
    a.busy = true;
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    sockets.add(sock);
    const send = obj => { const d = Buffer.from(JSON.stringify(obj)); sock.write(Buffer.concat([d.length < 126 ? Buffer.from([0x81, d.length]) : Buffer.from([0x81, 126, d.length >> 8, d.length & 255]), d])); };
    let buf = Buffer.alloc(0), hello = false;
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f, q = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); q = 4; }
        if (buf.length < q + 4 + len) return;
        const mask = buf.slice(q, q + 4), body = Buffer.from(buf.slice(q + 4, q + 4 + len).map((b, i) => b ^ mask[i & 3]));
        buf = buf.slice(q + 4 + len);
        const text = body.toString('utf8'), msg = JSON.parse(text);
        got.push({ id, text, msg });
        if (!hello && msg.type !== 'agentHello') { send({ type: 'reject', id: null, reason: 'send agentHello first' }); continue; }
        if (msg.type === 'agentHello') {
          hello = true;
          send({ type: 'welcome', version: '0.5.0', agent: id, mode: 'shadow', account: 'Sim101', sim: true,
            rules: { roots: ['NQ', 'MNQ'], maxQty: { NQ: 2, MNQ: 20 }, entryFrom: '09:45', entryUntil: '15:00', flatAt: '15:55', maxExpireSec: 1800, maxTrades: null, maxLosses: null },
            instruments: [{ root: 'MNQ', name: 'MNQ 12-26', tick: 0.25, pointValue: 2 }, { root: 'NQ', name: 'NQ 12-26', tick: 0.25, pointValue: 20 }] });
          send({ type: 'agentState', mode: 'shadow', killed: false, standDown: null, trades: 0, losses: 0, pnlToday: 0, owns: false });
        }
      }
    });
    sock.on('end', () => { a.busy = false; sock.destroy(); });
    sock.on('close', () => { a.busy = false; sockets.delete(sock); });
    sock.on('error', () => {});
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, got, close: () => { for (const s of sockets) s.destroy(); server.close(); } })));
}

test('fake-agent: reads agent-<id>-secret.txt (two # lines, 64 hex), never anything else', async () => {
  const { readSecret } = await import('./fake-agent.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-agent-'));
  const f = path.join(dir, 'agent-demo-secret.txt');
  fs.writeFileSync(f, '# ChartBridge agent secret\r\n# Delete this file to make a new one\r\n' + 'cd'.repeat(32) + '\r\n');
  assert.equal(readSecret(f), 'cd'.repeat(32));
  fs.writeFileSync(f, '# torn\nabc\n');
  assert.throws(() => readSecret(f), /64 character/);
});

test('fake-agent: clean() makes model text plain (quotes, newlines, backslashes, control characters, length)', async () => {
  const { clean } = await import('./fake-agent.mjs');
  assert.equal(clean('He said "go"\nthen \\stop\u0007'), "He said 'go' / then stop");
  assert.equal(clean('x'.repeat(250)).length, 200);
  assert.equal(clean('y'.repeat(1200), 1000).length, 1000);
});

test('fake-agent: a sample plan carries every field the contract asks for, and its riskDollars add up (check 5)', async () => {
  const { samplePlan, riskDollars } = await import('./fake-agent.mjs');
  const keys = agentKeys();
  assert.deepEqual(keys.plan, ['type', 'id', 'root', 'side', 'kind', 'price', 'limitPrice', 'qty', 'stopTicks', 'targetTicks', 'expireSec', 'riskDollars', 'setup', 'reason', 'confidence'], 'the C# plan keys are the contract\'s');
  const p = samplePlan('s1');
  assert.deepEqual(Object.keys(p).sort(), keys.plan.filter(k => k !== 'limitPrice').sort());
  assert.equal(p.riskDollars, 12 * 0.25 * 2 * 1);
  assert.equal(samplePlan('s2', { root: 'NQ', qty: 2, stopTicks: 8 }).riskDollars, 80);
  const sl = samplePlan('s3', { kind: 'stopLimit', price: 25001, limitPrice: 25002 });
  assert.equal(sl.limitPrice, 25002);
  assert.equal(samplePlan('s4', { limitPrice: 1 }).limitPrice, undefined, 'a limit plan never carries limitPrice');
  assert.equal(riskDollars('MNQ', 7, 3), 10.5);
  assert.equal(strictProblem(JSON.stringify(p), keys), null);
});

test('fake-agent against a stand-in: the upgrade answers, agentHello first, beats, and only strict contract messages', async () => {
  const { connectAgent, NAME, BUILD } = await import('./fake-agent.mjs');
  const { wsConnect } = await import('./fake-bot.mjs');
  const secret = 'ab'.repeat(32), other = 'ef'.repeat(32);
  const s = await standIn({ demo: { secret }, demob: { secret: other } });
  try {
    await assert.rejects(wsConnect(s.port, '/agent/nobody', { 'X-ChartBridge-Agent': secret }), /WebSocket refused: 404/, 'an id not in agents: 404');
    await assert.rejects(wsConnect(s.port, '/agent/demo', {}), /403/, 'no secret: 403');
    await assert.rejects(wsConnect(s.port, '/agent/demo', { 'X-ChartBridge-Agent': other }), /403/, 'another agent\'s secret: 403');
    await assert.rejects(wsConnect(s.port, '/agent/demo', { 'X-ChartBridge-Agent': secret, Origin: 'http://localhost:' + s.port }), /403/, 'any Origin: 403');

    const a = await connectAgent({ port: s.port, id: 'demo', secret });
    const w = await a.next('welcome');
    assert.equal(w.agent, 'demo');
    assert.ok(await a.next('agentState'));
    await assert.rejects(connectAgent({ port: s.port, id: 'demo', secret }), /409/, 'one connection per id');
    const b = await connectAgent({ port: s.port, id: 'demob', secret: other, silent: true });
    assert.ok(await b.next('welcome'), 'ids are independent: two agents at once');

    a.plan('p1');
    a.plan('p2', { kind: 'stopLimit', price: 25001, limitPrice: 25002, side: 'buy' });
    a.skip('k1', 'Sample: spread too wide', 'Sample fade');
    a.withdraw('p2');
    a.note('thinking', 'Sample "thought"\nwith a line break and a \\backslash ' + 'z'.repeat(1100));
    a.note('look', 'short');
    a.subscribe('MNQ', { days: 1, tickHours: 0 });
    a.flatten();
    await new Promise(r => setTimeout(r, 1300));   // at least one beat
    const mine = s.got.filter(g => g.id === 'demo');
    assert.equal(mine[0].msg.type, 'agentHello', 'agentHello first');
    assert.equal(mine[0].msg.name, NAME); assert.equal(mine[0].msg.build, BUILD);
    const keys = agentKeys();
    for (const g of mine) assert.equal(strictProblem(g.text, keys), null, 'strict: ' + g.text.slice(0, 120));
    for (const t of ['plan', 'skip', 'withdraw', 'note', 'subscribe', 'flatten', 'beat']) assert.ok(mine.some(g => g.msg.type === t), 'sent a ' + t);
    const note = mine.find(g => g.msg.type === 'note' && g.msg.kind === 'thinking').msg;
    assert.equal(note.text.length, 1000);
    assert.ok(!note.text.includes('"') && !note.text.includes('\n') && !note.text.includes('\\'), 'note text cleaned');
    const plans = mine.filter(g => g.msg.type === 'plan').map(g => g.msg);
    assert.ok(plans.every(p => p.kind === 'limit' || p.kind === 'stopLimit'), 'only limit or stop-limit plans');
    assert.ok(plans.every(p => p.stopTicks >= 1 && p.targetTicks >= 1), 'always a stop and a target');
    assert.equal(s.got.filter(g => g.id === 'demob' && g.msg.type === 'beat').length, 0, 'silent: no beats (the heartbeat test)');
    a.close(); b.close();
    await new Promise(r => setTimeout(r, 200));   // the stand-in frees the id when the socket closes

    // never says hello: the stand-in, as ChartBridge, refuses everything before it
    const c = await connectAgent({ port: s.port, id: 'demo', secret, noHello: true, silent: true });
    c.plan('p9');
    assert.equal((await c.next('reject')).reason, 'send agentHello first');
    c.close();
  } finally { s.close(); }
});

test('fake-agent: ChartBridgeAgents.cs keeps the contract\'s upgrade order and limits', () => {
  assert.match(cs, /if \(a == null\) return 404;\s*if \(origin != null\) return 403;\s*if \(!a\.SecretMatches\(givenSecret\)\) return 403;\s*if \(!isWebSocket\) return 400;\s*if \(a\.Busy\(\)\) return 409;\s*return 101;/);
  assert.match(cs, /public const string SecretHeader = "X-ChartBridge-Agent";/);
  assert.match(cs, /public const int MaxMessageBytes = 65536, MaxActionsPerSecond = 10;/);
  assert.match(cs, /public const double SilenceMs = 5000/);
});
