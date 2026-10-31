'use strict';
// Chart 1.40.0 (Sunday item A): the accounts ChartBridge lists, told to The Desk (PUT /api/chart-accounts/listed) so a new account
// shows on Prop > Accounts before its first fill. The decision (live/accounts.js listedPlan) and the feed against a fake Desk and a
// fake ChartBridge. Made-up accounts only (EVAL-A, EVAL-B, FUNDED-C).
const test = require('node:test');
const assert = require('node:assert/strict');
const AC = require('../live/accounts.js');

test('Sunday A: the names: Sim and Playback left out, 1 to 64 characters, no repeats, sorted, at most 200', () => {
  assert.deepEqual(AC.listedNames([{ name: 'FUNDED-C' }, { name: 'Sim101' }, { name: ' sim-x' }, { name: 'Playback101' }, { name: 'EVAL-A' }, { name: 'EVAL-A' }, { name: '' }, { name: 'x'.repeat(65) }, null, { name: 7 }, { name: 'Simon-1' }]),
    ['EVAL-A', 'FUNDED-C'], '"Simon-1" starts with sim: left out as the rule says');
  const many = Array.from({ length: 250 }, (_, i) => ({ name: 'EVAL-' + String(i).padStart(3, '0') }));
  assert.equal(AC.listedNames(many).length, AC.LISTED_MAX);
  assert.equal(AC.LISTED_MAX, 200);
});

test('Sunday A: when it is sent: not without The Desk, before the accounts, with none, after a 404, while one is on its way, or when unchanged', () => {
  const accounts = [{ name: 'EVAL-B' }, { name: 'EVAL-A' }, { name: 'Sim101' }];
  const go = AC.listedPlan({ got: true, accounts, lastKey: '' });
  assert.deepEqual([go.send, go.names], [true, ['EVAL-A', 'EVAL-B']]);
  assert.equal(AC.listedPlan({ desk: false, got: true, accounts }).send, false);
  assert.equal(AC.listedPlan({ got: false, accounts }).send, false);
  assert.equal(AC.listedPlan({ got: true, accounts: [{ name: 'Sim101' }] }).send, false, 'only Sim: nothing to tell');
  assert.equal(AC.listedPlan({ got: true, accounts, stopped: true }).send, false);
  assert.equal(AC.listedPlan({ got: true, accounts, busy: true }).send, false);
  assert.equal(AC.listedPlan({ got: true, accounts: [{ name: 'EVAL-A' }, { name: 'EVAL-B' }], lastKey: go.key }).send, false, 'the same names in another order: unchanged');
  assert.equal(AC.listedPlan({ got: true, accounts: accounts.concat({ name: 'FUNDED-C' }), lastKey: go.key }).send, true, 'a new account: sent');
});

async function loadFeed(answer) {
  const file = require.resolve('../live/accounts.js');
  const core = require(file);
  const sent = [], socks = [], puts = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 1; socks.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send(t) { sent.push(JSON.parse(t)); }
    close() { this.readyState = 3; }
    deliver(m) { this.onmessage({ data: JSON.stringify(m) }); }
  }
  const saved = { window: global.window, document: global.document, WebSocket: global.WebSocket };
  global.window = { AccountsCore: core }; global.document = {}; global.WebSocket = FakeSocket;
  delete require.cache[file];
  require(file);
  const page = global.window.AccountsPage;
  delete require.cache[file];
  Object.assign(global, saved);
  for (const k of Object.keys(saved)) if (saved[k] === undefined) delete global[k];
  const feed = page.createFeed({
    wsUrl: () => 'ws://localhost:8765/ws', pin: null, framed: false, changed: () => {}, note: () => {}, orderSend: () => true, storage: null,
    fetch: (u, o) => {
      if (o && o.method === 'PUT') { puts.push({ u, o, body: JSON.parse(o.body) }); return answer(u, o); }
      return Promise.resolve(u === '/session' ? { ok: true, text: () => Promise.resolve('{"token":"tok"}') }
        : u === '/diag' ? { ok: true, json: () => Promise.resolve({ desk: { deskUrl: 'http://localhost:8800' } }) }
        : /chart-accounts$/.test(u) ? { ok: true, json: () => Promise.resolve({ accounts: [] }) }
        : { ok: false, status: 404, json: () => Promise.resolve({}) });
    },
  });
  return { feed, socks, puts, FakeSocket, settle: () => new Promise(r => setTimeout(r, 5)) };
}
const ON = { accountChecks: true, orderTypes: false, strategies: false, merge: false, cancelFromList: false, copier: false, bot: false };

test('Sunday A: the feed tells The Desk once when the accounts arrive, again only when they change; a failure is left; a 404 stops it', async () => {
  let status = 200;
  const F = await loadFeed(() => Promise.resolve(status === 'throw' ? Promise.reject(new Error('not reachable')) : { ok: status < 300, status, json: () => Promise.resolve({ kept: [], left_out: [] }) }));
  const G = global.WebSocket; global.WebSocket = F.FakeSocket;
  try {
    F.feed.start(['v3']);
    await F.settle();
    const s = F.socks[0];
    s.deliver({ type: 'hello', version: '0.6.10', instruments: [], features: ['v3'] });
    s.deliver({ type: 'trading', enabled: true, accounts: [], maxQty: {}, switches: ON });
    const acct = n => ({ name: n, sim: false, connection: 'connected', state: 'active', positions: [] });
    s.deliver({ type: 'accounts', list: [acct('EVAL-B'), acct('Sim101'), acct('EVAL-A')], archived: [] });
    await F.settle(); await F.settle();
    assert.equal(F.puts.length, 1, 'once, as the accounts arrive');
    assert.equal(F.puts[0].u, 'http://localhost:8800/api/chart-accounts/listed');
    assert.deepEqual(F.puts[0].body, { accounts: ['EVAL-A', 'EVAL-B'] });
    const o = F.puts[0].o;
    assert.deepEqual([o.method, o.mode, o.credentials, o.cache, o.headers['Content-Type']], ['PUT', 'cors', 'omit', 'no-store', 'application/json']);
    await F.feed.reportListed();
    assert.equal(F.puts.length, 1, 'unchanged: not sent again');
    s.deliver({ type: 'accounts', list: [acct('EVAL-A'), acct('EVAL-B'), acct('FUNDED-C')], archived: [] });
    await F.settle();
    status = 'throw';
    await F.feed.reportListed();
    assert.equal(F.puts.length, 2, 'a new account: sent');
    assert.deepEqual(F.puts[1].body.accounts, ['EVAL-A', 'EVAL-B', 'FUNDED-C']);
    await F.settle();
    assert.equal(F.puts.length, 2, 'a failure is not retried at once');
    status = 500;
    await F.feed.reportListed();   // the next minute: asked again (no 2xx yet for this list)
    assert.equal(F.puts.length, 3);
    status = 404;
    await F.feed.reportListed();
    assert.equal(F.puts.length, 4);
    status = 200;
    await F.feed.reportListed();
    assert.equal(F.puts.length, 4, 'an older Desk (404): not asked again this page load');
  } finally { global.WebSocket = G; F.feed.stop(); }
});

