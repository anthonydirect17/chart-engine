'use strict';
// Chart 1.40.0 and ChartBridge 0.6.10: the account lifecycle (Anthony 2026-10-30, D1 to D5: Blown and Promoted, marked by hand on The
// Desk or on the Account page) and the audit of the accounts NinjaTrader no longer lists. The pure parts (live/accounts.js
// AccountsCore, live/multi-account.js MultiAccountCore), the feed's steps against a fake ChartBridge connection (each step once, a
// refusal never sent again), the PUT to The Desk, and the ChartBridge source and PROTOCOL.md in step. Made-up accounts only (EVAL-A,
// EVAL-B, SIM-A, SIM-B, SIM-F1) and a made-up firm (Lucid).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const AC = require('../live/accounts.js');
const MC = require('../live/multi-account.js');

test('1.40.0: The Desk\'s rows carry the outcome (blown, promoted or null; anything else is null)', () => {
  const d = AC.cleanDesk({ accounts: [{ account: 'EVAL-A', outcome: 'blown' }, { account: 'EVAL-B', outcome: 'promoted' }, { account: 'SIM-A', outcome: 'passed' }, { account: 'SIM-B' }] });
  assert.equal(d.get('EVAL-A').outcome, 'blown');
  assert.equal(d.get('EVAL-B').outcome, 'promoted');
  assert.equal(d.get('SIM-A').outcome, null);
  assert.equal(d.get('SIM-B').outcome, null);
});

test('1.40.0: the Blown and Promoted buttons only for an account with a prop account on The Desk (outcome, type, or a prop number)', () => {
  const d = AC.cleanDesk({ accounts: [
    { account: 'EVAL-A', accountType: { id: 'lucid-50k', firm: 'Lucid', name: '50K' } },
    { account: 'EVAL-B', source: { daily_loss_limit: 'prop', trailing_drawdown: null, account_size: null } },
    { account: 'SIM-A', outcome: 'blown' },
    { account: 'SIM-B', source: { daily_loss_limit: 'account' } },
  ] });
  assert.equal(AC.propRow(d.get('EVAL-A')), true, 'an account type: The Desk gives it a prop account (D5)');
  assert.equal(AC.propRow(d.get('EVAL-B')), true, 'a number from a linked prop account');
  assert.equal(AC.propRow(d.get('SIM-A')), true, 'an outcome already set');
  assert.equal(AC.propRow(d.get('SIM-B')), false, 'its own numbers only: no prop account known');
  assert.equal(AC.propRow(undefined), false);
});

/* a feed's state as lifecycleStep reads it */
const base = over => Object.assign({
  accounts: [{ name: 'EVAL-A', canHide: true }], archived: [], notListed: [], groups: [{ id: 'g1', name: 'Lucid', members: ['EVAL-A', 'SIM-A'] }], groupsError: null,
  copier: { canRemove: true, followers: [{ account: 'EVAL-A', on: true, qty: 1, size: 'micro', lossLimit: null }] }, switches: { accountChecks: true, copier: true },
}, over || {});

test('1.40.0: the steps in the contract\'s order: out of its group, the follower off, then removed, then hidden; then done', () => {
  let S = base();
  assert.deepEqual([AC.lifecycleStep('EVAL-A', S).step, AC.lifecycleStep('EVAL-A', S).group.id], ['leave', 'g1']);
  S = base({ groups: [{ id: 'g1', name: 'Lucid', members: ['SIM-A'] }] });
  assert.equal(AC.lifecycleStep('EVAL-A', S).step, 'followerOff');
  S.copier.followers[0].on = false;
  assert.equal(AC.lifecycleStep('EVAL-A', S).step, 'followerRemove');
  S.copier.followers = [];
  assert.equal(AC.lifecycleStep('EVAL-A', S).step, 'hide');
  S.accounts = []; S.archived = [{ name: 'EVAL-A', at: 1 }];
  assert.equal(AC.lifecycleStep('EVAL-A', S).step, 'done');
});

test('1.40.0: what waits and what is blocked is never sent', () => {
  assert.equal(AC.lifecycleStep('EVAL-A', base({ groups: null })).step, 'wait', 'no groups from ChartBridge yet');
  assert.equal(AC.lifecycleStep('EVAL-A', base({ groups: [], copier: null })).step, 'wait', 'the copier on and its state not sent yet: never hidden blind');
  const ge = AC.lifecycleStep('EVAL-A', base({ groupsError: 'groups.txt could not be read' }));
  assert.deepEqual([ge.step, ge.why], ['blocked', 'groups.txt could not be read']);
  const old = AC.lifecycleStep('EVAL-A', base({ groups: [], copier: { followers: [{ account: 'EVAL-A', on: false }] } }));
  assert.equal(old.step, 'blocked', 'Remove needs ChartBridge 0.6.6 (canRemove)');
  const off = AC.lifecycleStep('EVAL-A', base({ groups: [], copier: null, switches: { accountChecks: false, copier: false } }));
  assert.deepEqual([off.step, off.why], ['blocked', 'Hide needs accountChecks = on in config.txt']);
  const busy = AC.lifecycleStep('EVAL-A', base({ groups: [], copier: { followers: [] }, accounts: [{ name: 'EVAL-A', canHide: false, hideWhy: 'EVAL-A has a position or working orders' }] }));
  assert.deepEqual([busy.step, busy.why], ['blocked', 'EVAL-A has a position or working orders']);
  assert.equal(AC.lifecycleStep('EVAL-A', base({ groups: [], copier: { followers: [] }, accounts: [] })).step, 'done', 'ChartBridge does not know it: nothing to hide');
  assert.equal(AC.lifecycleStep('EVAL-A', base({ groups: [], copier: { followers: [] }, accounts: [], notListed: [{ name: 'EVAL-A' }] })).step, 'hide', 'not connected this session: ChartBridge 0.6.10 hides it');
  assert.equal(AC.lifecycleStep('EVAL-A', base({ groups: [], switches: { accountChecks: true, copier: false } })).step, 'hide', 'the copier off: its followers are not known here (ChartBridge refuses Hide of a follower)');
});

test('1.40.0 (review): out of its group waits until a listed account is flat with no working orders; an unlisted one leaves at once', () => {
  const pos = AC.lifecycleStep('EVAL-A', base({ accounts: [{ name: 'EVAL-A', canHide: true, positions: [{ root: 'MNQ', qty: 2 }] }] }));
  assert.deepEqual([pos.step, pos.until, pos.group.id], ['wait', 'flat', 'g1'], 'a Promoted eval still in a group trade stays in the group');
  assert.equal(pos.why, 'waits until EVAL-A is flat with no working orders, then leaves Lucid');
  const msg = AC.lifecycleStep('EVAL-A', base({ positions: new Map([['EVAL-A|MNQ', { qty: -1 }]]) }));
  assert.equal(msg.step, 'wait', 'a position message counts too');
  assert.equal(AC.lifecycleStep('EVAL-A', base({ positions: new Map([['EVAL-AB|MNQ', { qty: 1 }]]) })).step, 'leave', 'another account\'s position does not');
  const ord = AC.lifecycleStep('EVAL-A', base({ orders: new Map([['o1', { id: 'o1', account: 'EVAL-A', state: 'working' }]]) }));
  assert.equal(ord.step, 'wait', 'a working order holds it');
  assert.equal(AC.lifecycleStep('EVAL-A', base({ orders: [{ id: 'o1', account: 'EVAL-A', state: 'filled' }, { id: 'o2', account: 'SIM-A', state: 'working' }] })).step, 'leave', 'a filled order, or another account\'s working one, does not');
  assert.equal(AC.lifecycleStep('EVAL-A', base({ accounts: [{ name: 'EVAL-A', positions: [{ root: 'MNQ', qty: 0 }] }] })).step, 'leave', 'flat: it leaves');
  /* NinjaTrader does not list it: it holds nothing ChartBridge can see, so it leaves at once (a stale position message does not hold it) */
  const gone = AC.lifecycleStep('EVAL-A', base({ accounts: [], notListed: [{ name: 'EVAL-A' }], positions: new Map([['EVAL-A|MNQ', { qty: 1 }]]) }));
  assert.equal(gone.step, 'leave');
});

test('1.40.0 (audit 8): the accounts NinjaTrader does not list now: members and followers first, with what holds them', () => {
  const rows = AC.notListedRows([{ name: 'SIM-A' }], [{ id: 'g1', name: 'Lucid', members: ['SIM-A', 'EVAL-B'] }], { followers: [{ account: 'SIM-F1', on: true }, { account: 'SIM-A', on: false }] },
    [{ name: 'EVAL-C', trade: false }, { name: 'EVAL-B', trade: true }], [{ name: 'EVAL-D', at: 1 }]);
  assert.deepEqual(rows.map(r => r.name), ['EVAL-B', 'SIM-F1', 'EVAL-C'], 'never one ChartBridge lists (SIM-A)');
  assert.deepEqual(rows[0], { name: 'EVAL-B', group: { id: 'g1', name: 'Lucid' }, follower: null, unseen: true, hidden: false });
  assert.deepEqual(rows[1].follower, { on: true });
  assert.equal(AC.notListedWords(rows[0]), 'in Lucid');
  assert.equal(AC.notListedWords(rows[1]), 'copier follower (on)');
  assert.equal(AC.notListedWords(rows[2]), 'not connected this session');
  assert.deepEqual(AC.notListedRows([], null, null, undefined, undefined), []);
});

test('1.40.0: the outcome PUT body: blown, promoted or null (Undo), nothing else', () => {
  assert.deepEqual(AC.outcomeBody('blown'), { body: { outcome: 'blown' } });
  assert.deepEqual(AC.outcomeBody(null), { body: { outcome: null } });
  assert.ok(AC.outcomeBody('passed').error);
});

/* ---------------- the feed: each step once, a refusal shown and never sent again */
async function loadFeed(deskRows, onPut) {
  const file = require.resolve('../live/accounts.js');
  delete require.cache[file];
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
  Object.assign(global, saved);
  for (const k of Object.keys(saved)) if (saved[k] === undefined) delete global[k];
  const notes = [];
  const feed = page.createFeed({
    wsUrl: () => 'ws://localhost:8765/ws', pin: null, framed: false, changed: () => {}, note: t => notes.push(t), orderSend: () => true, storage: null,
    fetch: (u, o) => {
      if (o && o.method === 'PUT') { puts.push({ u, o }); return Promise.resolve(onPut ? onPut(u, o) : { ok: true, json: () => Promise.resolve({}) }); }
      return Promise.resolve(u === '/session' ? { ok: true, text: () => Promise.resolve('{"token":"tok"}') }
        : u === '/diag' ? { ok: true, json: () => Promise.resolve({ desk: { deskUrl: 'http://localhost:8800' } }) }
        : /chart-accounts$/.test(u) ? { ok: true, json: () => Promise.resolve({ accounts: deskRows() }) }
        : { ok: false, status: 404, json: () => Promise.resolve({}) });
    },
  });
  return { feed, sent, socks, notes, puts, FakeSocket, settle: () => new Promise(r => setTimeout(r, 5)) };
}
const ON = { accountChecks: true, orderTypes: false, strategies: false, merge: false, cancelFromList: false, copier: true, bot: false };

test('1.40.0: an account marked Blown on The Desk: ChartBridge is asked each step once, in order, until it is hidden', async () => {
  let rows = [{ account: 'EVAL-A', outcome: 'blown', accountType: { id: 'lucid-50k', firm: 'Lucid', name: '50K' } }, { account: 'SIM-A' }];
  const F = await loadFeed(() => rows);
  const G = global.WebSocket; global.WebSocket = F.FakeSocket;
  try {
    F.feed.start(['v3']);
    await F.settle();
    const s = F.socks[0];
    s.deliver({ type: 'hello', version: '0.6.10', instruments: [], features: ['v3'] });
    s.deliver({ type: 'trading', enabled: true, accounts: [], maxQty: {}, switches: ON });
    const acct = { name: 'EVAL-A', sim: false, connection: 'connected', state: 'active', canHide: true, positions: [] };
    s.deliver({ type: 'groups', list: [{ id: 'g1', name: 'Lucid', members: ['EVAL-A', 'SIM-A'] }] });
    s.deliver({ type: 'copier', canRemove: true, armed: false, leader: null, followers: [{ account: 'EVAL-A', on: true, qty: 2, size: 'micro', lossLimit: null }] });
    F.sent.length = 0;
    s.deliver({ type: 'accounts', list: [acct, { name: 'SIM-A', state: 'active', positions: [] }], archived: [], notListed: [] });
    await F.settle();
    const of = t => F.sent.filter(m => m.type === t);
    assert.equal(of('accountGroup').length, 1, 'out of its group: asked once');
    assert.deepEqual({ ...of('accountGroup')[0], cid: 'x' }, { type: 'accountGroup', cid: 'x', account: 'EVAL-A', group: null });
    s.deliver({ type: 'accounts', list: [acct], archived: [], notListed: [] });   // nothing changed yet: never asked again
    await F.settle();
    assert.equal(of('accountGroup').length, 1);
    s.deliver({ type: 'groups', list: [{ id: 'g1', name: 'Lucid', members: ['SIM-A'] }] });
    await F.settle();
    assert.equal(of('copierFollower').length, 1, 'then its follower off');
    assert.deepEqual({ ...of('copierFollower')[0], cid: 'x' }, { type: 'copierFollower', cid: 'x', account: 'EVAL-A', on: false, qty: 2, size: 'micro', lossLimit: null }, 'its other settings as they are');
    s.deliver({ type: 'copier', canRemove: true, armed: false, leader: null, followers: [{ account: 'EVAL-A', on: false, qty: 2, size: 'micro', lossLimit: null }] });
    await F.settle();
    assert.equal(of('copierFollowerRemove').length, 1, 'then removed');
    s.deliver({ type: 'copier', canRemove: true, armed: false, leader: null, followers: [] });
    await F.settle();
    assert.equal(of('accountArchive').length, 1, 'then hidden');
    assert.equal(of('accountArchive')[0].confirm, true);
    // ChartBridge refuses Hide: shown (Log and the feed's state), never sent again however often the state comes
    s.deliver({ type: 'reject', cid: of('accountArchive')[0].cid, reason: 'EVAL-A is agent a1\'s account (the Agent tab): it cannot be hidden' });
    for (let i = 0; i < 3; i++) { s.deliver({ type: 'accounts', list: [acct], archived: [], notListed: [] }); await F.settle(); }
    assert.equal(of('accountArchive').length, 1, 'a refusal is never retried in a loop');
    const rec = F.feed.S.lifecycle.get('EVAL-A');
    assert.equal(rec.tried.get('hide').state, 'refused');
    assert.match(rec.tried.get('hide').why, /agent a1's account/);
    assert.ok(F.feed.S.log.some(l => /EVAL-A \(Blown on The Desk\): hidden refused by ChartBridge: EVAL-A is agent a1's account/.test(l.text)));
    // hidden at last (by Anthony): done, nothing more is sent
    const n = F.sent.length;
    s.deliver({ type: 'accounts', list: [], archived: [{ name: 'EVAL-A', at: 1 }], notListed: [] });
    await F.settle();
    assert.equal(F.sent.length, n);
    assert.equal(F.feed.S.lifecycle.get('EVAL-A').step, 'done');
    // Undo on The Desk (outcome back to none): forgotten, nothing sent (D4: it does not rejoin its group)
    rows = [{ account: 'EVAL-A', outcome: null }];
    F.feed.S.desk = AC.cleanDesk({ accounts: rows });
    s.deliver({ type: 'accounts', list: [], archived: [{ name: 'EVAL-A', at: 1 }], notListed: [] });
    await F.settle();
    assert.equal(F.feed.S.lifecycle.has('EVAL-A'), false);
    assert.equal(F.sent.length, n);
  } finally { global.WebSocket = G; F.feed.stop(); }
});

test('1.40.0 (review): a Promoted eval in a group trade stays in its group until flat with no working orders, then leaves by itself', async () => {
  const rows = [{ account: 'EVAL-A', outcome: 'promoted', accountType: { id: 'lucid-50k', firm: 'Lucid', name: '50K' } }];
  const F = await loadFeed(() => rows);
  const G = global.WebSocket; global.WebSocket = F.FakeSocket;
  try {
    F.feed.start(['v3']);
    await F.settle();
    const s = F.socks[0];
    s.deliver({ type: 'hello', version: '0.6.10', instruments: [], features: ['v3'] });
    s.deliver({ type: 'trading', enabled: true, accounts: [], maxQty: {}, switches: ON });
    s.deliver({ type: 'groups', list: [{ id: 'g1', name: 'Lucid', members: ['EVAL-A', 'SIM-A'] }] });
    s.deliver({ type: 'copier', canRemove: true, armed: false, leader: null, followers: [] });
    s.deliver({ type: 'orders', list: [{ id: 'o9', account: 'EVAL-A', root: 'MNQ', state: 'working', role: 'stop' }] });
    const acct = q => ({ name: 'EVAL-A', sim: false, connection: 'connected', state: 'active', canHide: !q, positions: q ? [{ root: 'MNQ', qty: q }] : [] });
    s.deliver({ type: 'accounts', list: [acct(2)], archived: [], notListed: [] });
    await F.settle();
    const leaves = () => F.sent.filter(m => m.type === 'accountGroup');
    assert.equal(leaves().length, 0, 'in a group trade: nothing sent, so a group Close or Flatten still covers it');
    const rec = F.feed.S.lifecycle.get('EVAL-A');
    assert.deepEqual([rec.step, rec.until], ['wait', 'flat']);
    assert.match(rec.why, /^waits until EVAL-A is flat with no working orders/);
    s.deliver({ type: 'accounts', list: [acct(0)], archived: [], notListed: [] });   // flat, its stop still working
    await F.settle();
    assert.equal(leaves().length, 0, 'a working order still holds it');
    s.deliver({ type: 'order', id: 'o9', account: 'EVAL-A', root: 'MNQ', state: 'cancelled' });
    await F.settle();
    assert.equal(leaves().length, 1, 'flat with nothing working: it leaves by itself');
    assert.deepEqual({ ...leaves()[0], cid: 'x' }, { type: 'accountGroup', cid: 'x', account: 'EVAL-A', group: null });
  } finally { global.WebSocket = G; F.feed.stop(); }
});

test('1.40.0 (review): Hide refused because the account traded meanwhile is asked again once it is flat, a bounded number of times', async () => {
  const rows = [{ account: 'EVAL-A', outcome: 'promoted', accountType: { id: 'lucid-50k', firm: 'Lucid', name: '50K' } }];
  const F = await loadFeed(() => rows);
  const G = global.WebSocket; global.WebSocket = F.FakeSocket;
  try {
    F.feed.start(['v3']);
    await F.settle();
    const s = F.socks[0];
    s.deliver({ type: 'hello', version: '0.6.10', instruments: [], features: ['v3'] });
    s.deliver({ type: 'trading', enabled: true, accounts: [], maxQty: {}, switches: ON });
    s.deliver({ type: 'groups', list: [] });
    s.deliver({ type: 'copier', canRemove: true, armed: false, leader: null, followers: [] });
    const acct = q => ({ name: 'EVAL-A', sim: false, connection: 'connected', state: 'active', canHide: !q, positions: q ? [{ root: 'MNQ', qty: q }] : [] });
    s.deliver({ type: 'accounts', list: [acct(0)], archived: [], notListed: [] });
    await F.settle();
    const hides = () => F.sent.filter(m => m.type === 'accountArchive');
    assert.equal(hides().length, 1);
    s.deliver({ type: 'reject', cid: hides()[0].cid, reason: 'EVAL-A left its group; not hidden: it is in a trade now; Hide it once flat (changed, but groups.txt could not be saved (made up))' });
    s.deliver({ type: 'accounts', list: [acct(1)], archived: [], notListed: [] });
    await F.settle();
    assert.equal(F.feed.S.lifecycle.get('EVAL-A').tried.get('hide').state, 'flat');
    assert.equal(hides().length, 1, 'in a trade: not asked again yet');
    assert.ok(F.feed.S.log.some(l => /EVAL-A \(Promoted on The Desk\): not hidden yet: .*hidden once it is flat/.test(l.text)));
    s.deliver({ type: 'accounts', list: [acct(0)], archived: [], notListed: [] });
    await F.settle();
    assert.equal(hides().length, 2, 'flat again: Hide asked again by itself');
    /* a "not flat" refusal over and over: asked again at most FLAT_RETRIES times, then it stands (never a loop) */
    for (let i = 0; i < AC.FLAT_RETRIES + 2; i++) {
      s.deliver({ type: 'reject', cid: hides()[hides().length - 1].cid, reason: 'EVAL-A has a position or working orders: only a flat account can be hidden (exits always work)' });
      s.deliver({ type: 'accounts', list: [acct(0)], archived: [], notListed: [] });
      await F.settle();
    }
    assert.equal(hides().length, 1 + AC.FLAT_RETRIES);
    assert.equal(F.feed.S.lifecycle.get('EVAL-A').tried.get('hide').state, 'refused');
    assert.equal(AC.flatRetry('EVAL-A is agent a1\'s account (the Agent tab): it cannot be hidden'), false, 'any other refusal stands at once');
  } finally { global.WebSocket = G; F.feed.stop(); }
});

test('1.40.0: a refused first step is shown once and not sent again; another outcome later asks again', async () => {
  let rows = [{ account: 'EVAL-B', outcome: 'promoted' }];
  const F = await loadFeed(() => rows);
  const G = global.WebSocket; global.WebSocket = F.FakeSocket;
  try {
    F.feed.start(['v3']);
    await F.settle();
    const s = F.socks[0];
    s.deliver({ type: 'hello', version: '0.6.9', instruments: [], features: ['v3'] });
    s.deliver({ type: 'trading', enabled: true, accounts: [], maxQty: {}, switches: ON });
    s.deliver({ type: 'groups', list: [{ id: 'g1', name: 'Lucid', members: ['EVAL-B'] }] });
    s.deliver({ type: 'accounts', list: [], archived: [] });   // an older ChartBridge: EVAL-B is not listed and there is no notListed
    await F.settle();
    const leave = F.sent.filter(m => m.type === 'accountGroup');
    assert.equal(leave.length, 1);
    s.deliver({ type: 'reject', cid: leave[0].cid, reason: 'no account EVAL-B' });   // ChartBridge 0.6.9 (audit 1)
    for (let i = 0; i < 3; i++) { s.deliver({ type: 'groups', list: [{ id: 'g1', name: 'Lucid', members: ['EVAL-B'] }] }); await F.settle(); }
    assert.equal(F.sent.filter(m => m.type === 'accountGroup').length, 1, 'never in a loop');
    assert.equal(F.feed.S.lifecycle.get('EVAL-B').tried.get('leave|g1').why, 'no account EVAL-B');
    rows = [{ account: 'EVAL-B', outcome: 'blown' }];   // marked again, another outcome: a change, so asked once more
    F.feed.S.desk = AC.cleanDesk({ accounts: rows });
    s.deliver({ type: 'groups', list: [{ id: 'g1', name: 'Lucid', members: ['EVAL-B'] }] });
    await F.settle();
    assert.equal(F.sent.filter(m => m.type === 'accountGroup').length, 2);
  } finally { global.WebSocket = G; F.feed.stop(); }
});

test('1.40.0: nothing is sent while ChartBridge is not signed in, or in a window that does not read The Desk', async () => {
  const F = await loadFeed(() => [{ account: 'EVAL-A', outcome: 'blown' }]);
  const G = global.WebSocket; global.WebSocket = F.FakeSocket;
  try {
    F.feed.start(['v3']);
    await F.settle();
    const s = F.socks[0];
    s.deliver({ type: 'hello', version: '0.6.10', instruments: [], features: ['v3'] });
    s.deliver({ type: 'trading', enabled: false, reason: 'locked', switches: {} });
    s.deliver({ type: 'groups', list: [{ id: 'g1', name: 'Lucid', members: ['EVAL-A'] }] });
    s.deliver({ type: 'accounts', list: [{ name: 'EVAL-A', state: 'active', positions: [] }], archived: [], notListed: [] });
    await F.settle();
    assert.equal(F.sent.filter(m => m.type === 'accountGroup').length, 0, 'not signed in: nothing');
  } finally { global.WebSocket = G; F.feed.stop(); }
});

test('1.40.0: Blown from the drawer: PUT /api/accounts/{account}/outcome as the account type\'s PUT (cors, credentials omit), then the steps', async () => {
  const F = await loadFeed(() => [{ account: 'EVAL A/1', accountType: { id: 't', firm: 'Lucid', name: '50K' } }]);
  F.feed.start(['v3']);
  await F.settle();
  const r = await F.feed.setOutcome('EVAL A/1', 'blown');
  assert.deepEqual(r, { ok: true });
  assert.equal(F.puts.length, 1);
  assert.equal(F.puts[0].u, 'http://localhost:8800/api/accounts/EVAL%20A%2F1/outcome');
  assert.equal(F.puts[0].o.mode, 'cors'); assert.equal(F.puts[0].o.credentials, 'omit');
  assert.deepEqual(JSON.parse(F.puts[0].o.body), { outcome: 'blown' });
  assert.equal(F.feed.S.desk.get('EVAL A/1').outcome, 'blown', 'marked here at once, so the steps start now');
  assert.deepEqual(await F.feed.setOutcome('EVAL A/1', 'passed'), { ok: false, error: 'The outcome is Blown, Promoted or none.' });
  F.feed.stop();
  const F2 = await loadFeed(() => [], () => ({ ok: false, status: 404, json: () => Promise.resolve({ detail: 'no prop account' }) }));
  F2.feed.start(['v3']);
  await F2.settle();
  assert.deepEqual(await F2.feed.setOutcome('SIM-A', 'promoted'), { ok: false, error: 'The Desk has no prop account for SIM-A (no prop account)' });
  F2.feed.stop();
});

/* ---------------- the Multi-Account panel (audit 6) */
test('1.40.0 (audit 6): a member NinjaTrader does not list: "not in NinjaTrader now", no type asked, no bench move offered', () => {
  const S = { accounts: [{ name: 'SIM-A', group: 'g1', rules: { own: true, drawdown: 2000 }, positions: [] }],
    desk: new Map([['SIM-A', { firm: 'Lucid', accountType: { id: 't', firm: 'Lucid', name: '50K' } }], ['SIM-B', { firm: 'Lucid', accountType: { id: 't', firm: 'Lucid', name: '50K' } }]]) };
  const g = { id: 'g1', name: 'Lucid', members: ['SIM-A', 'SIM-B'], benched: ['SIM-B'], riskPct: 5 };
  const L = MC.lanes(g, S, []);
  const b = L.bench.find(c => c.name === 'SIM-B');
  assert.equal(b.missing, true); assert.equal(b.notype, false);
  assert.deepEqual(MC.chipTags(b), ['not in NinjaTrader now']);
  assert.match(MC.moveWhy(b, true, 'Lucid'), /SIM-B is not in NinjaTrader now: it sits out every entry and cannot move between the lanes\. Remove takes it out of Lucid\./);
  assert.match(MC.moveWhy(b, false, 'Lucid'), /not in NinjaTrader now/);
  const a = L.active.find(c => c.name === 'SIM-A');
  assert.equal(a.missing, false); assert.deepEqual(MC.chipTags(a), []);
  assert.equal(MC.moveWhy(a, false, 'Lucid'), '');
});

test('1.40.0: the panel has Remove for such a chip; the Account page has the drawer buttons, the not-listed section and an honest Show', () => {
  const ma = read('live/multi-account.js'), acc = read('live/accounts.js');
  assert.match(ma, /data-ma="remove"/);
  assert.match(ma, /F\.accountGroup\(name, null, '', null, c2\)/);
  for (const k of ['data-act="outcome"', 'data-act="outcome-yes"', 'data-act="nl-leave"', 'data-act="nl-foff"', 'data-act="nl-fremove"', 'Not in NinjaTrader now', "once NinjaTrader has it connected this session"]) assert.ok(acc.includes(k), k);
  assert.ok(!/\b(alert|confirm|prompt)\(/.test(acc.replace(/confirm: true/g, '')), 'no browser dialogs');
});

/* ---------------- ChartBridge 0.6.10 in its source and PROTOCOL.md */
test('0.6.10: the remove-only relief and Hide leaving the group are in the source; PROTOCOL.md says so', () => {
  const g = read('nt8/ChartBridgeGroups.cs'), c = read('nt8/ChartBridgeCopier.cs'), ag = read('nt8/ChartBridgeAgents.cs'), a = read('nt8/ChartBridgeAccounts.cs'), p = read('nt8/PROTOCOL.md');
  assert.match(g, /string memberAs = id == null \? MemberName\(name\) : null;/);
  assert.match(g, /if \(a == null && memberAs == null && !ChartBridgeAccounts\.Listed\(name\)\) return "no account " \+ name;/);
  assert.match(g, /internal static string HideAndLeave\(/);
  assert.match(g, /if \(!AccountTradable\(name\)\) \{ s\.Out = /);
  assert.match(c, /if \(a == null && on\.Groups\[1\]\.Value == "false"\)/);
  assert.match(ag, /if \(why != null && FindAccount\(m\) == null && ChartBridgeOrders\.Enabled && !ChartBridgeOrders\.IsNeverTradable\(m\)\) why = null;/);
  assert.match(a, /ChartBridgeGroups\.HideAndLeave\(/);
  assert.match(a, /notListed/);
  assert.match(read('nt8/ChartBridge.cs'), /public const string Version = "0\.6\.10";/);
  assert.ok(p.includes('### The account lifecycle (0.6.10)'));
  for (const k of ['notListed', 'remove-only', 'HideAndLeave']) assert.ok(p.includes(k), k);
});

test('1.40.0: versions and the changelog', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.40.0');
  assert.match(read('src/chart-engine.js'), /const VERSION = '1\.40\.0';/);
  assert.match(read('CHANGELOG.md'), /^# Changelog\n\n## ChartBridge 0\.6\.10 and chart 1\.40\.0 \(2026-11-01\)/);
  const compat = JSON.parse(read('live/COMPAT.json'));
  assert.equal(compat.page, '1.40.0'); assert.equal(compat.minChartBridge, '0.6.2');
  for (const f of ['live/accounts.js', 'live/multi-account.js', 'nt8/PROTOCOL.md', 'CHANGELOG.md', 'test/lifecycle.test.js']) assert.ok(!/[\u2013\u2014]/.test(read(f)), f + ': no en or em dashes');
});
