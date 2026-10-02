'use strict';
// The order account after a reload or a dropped connection (1.6.1, Anthony's ruling 2026-09-30): the account last
// picked, when ChartBridge allows it now, else Sim101 with a note; Armed never restored. LivePrefs.orderAccount is the
// rule; the checks on live.js below pin down that every order path sends for the account shown and nothing else.
// The page itself is driven in test/orders-smoke.mjs (restore, fallback, every order path, two tabs, reconnect).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LivePrefs: LP } = require('../live/live.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'live', 'live.js'), 'utf8').replace(/\r\n/g, '\n');
const PAGE = SRC.slice(SRC.indexOf('function start(container, opt, PAGE)'));

test('orderAccount: the last pick when ChartBridge allows it now', () => {
  assert.deepEqual(LP.orderAccount(['Sim101', 'EVAL-1', 'EVAL-2'], 'EVAL-2'), { account: 'EVAL-2', missed: '' });
  assert.deepEqual(LP.orderAccount(['Sim101', 'EVAL-1'], 'Sim101'), { account: 'Sim101', missed: '' });
});

test('orderAccount: not allowed now gives Sim101 (or the first allowed) and names the one missed', () => {
  assert.deepEqual(LP.orderAccount(['Sim101', 'EVAL-1'], 'EVAL-9'), { account: 'Sim101', missed: 'EVAL-9' });
  assert.deepEqual(LP.orderAccount(['EVAL-1', 'EVAL-2'], 'EVAL-9'), { account: 'EVAL-1', missed: 'EVAL-9' }, 'no Sim101: the first allowed, as before');
  assert.deepEqual(LP.orderAccount(['EVAL-1', 'EVAL-2'], 'Sim101'), { account: 'EVAL-1', missed: 'Sim101' });
  assert.deepEqual(LP.orderAccount([], 'EVAL-1'), { account: '', missed: 'EVAL-1' }, 'nothing allowed: no account, nothing can be sent');
});

test('orderAccount: nothing picked yet is Sim101 with no note; junk is nothing picked', () => {
  assert.deepEqual(LP.orderAccount(['EVAL-1', 'Sim101'], ''), { account: 'Sim101', missed: '' });
  for (const junk of [null, undefined, 42, true, {}, ['EVAL-1']]) assert.deepEqual(LP.orderAccount(['EVAL-1', 'Sim101'], junk), { account: 'Sim101', missed: '' }, String(junk));
  assert.deepEqual(LP.orderAccount(null, 'EVAL-1'), { account: '', missed: 'EVAL-1' });
  assert.deepEqual(LP.orderAccount(['', 7, 'Sim101'], 'EVAL-1'), { account: 'Sim101', missed: 'EVAL-1' }, 'junk in the list is not an account');
});

test('orderAccount: the result is always one of the allowed accounts, or none', () => {
  const lists = [[], ['Sim101'], ['A'], ['A', 'B'], ['B', 'Sim101', 'A']], wants = ['', 'A', 'B', 'Sim101', 'C'];
  for (const l of lists) for (const w of wants) {
    const r = LP.orderAccount(l, w);
    assert.ok(r.account === '' ? l.length === 0 : l.includes(r.account), JSON.stringify([l, w, r]));
    assert.equal(r.missed !== '', w !== '' && w !== r.account, JSON.stringify([l, w, r]));
  }
});

/* 1.12.0: the order logic moved unchanged from live.js into live/trade.js (TradeCore), which the single chart page's
   order bar and the workspace's ticket share; the checks below read it there, and its wiring in live.js. */
const CORE = fs.readFileSync(path.join(__dirname, '..', 'live', 'trade.js'), 'utf8').replace(/\r\n/g, '\n');
const WS = fs.readFileSync(path.join(__dirname, '..', 'live', 'workspace.js'), 'utf8').replace(/\r\n/g, '\n');
const TC = require('../live/trade.js');

test('trade.js: every order path sends for TR.account, and only after ready() checked the account shown', () => {
  // the messages that act on an account: the order and Flatten carry TR.account; cancel and change carry an id
  const sends = CORE.match(/send\(\{ type: '(order|flatten|cancel|change)'[^\n]*/g) || [];
  assert.ok(sends.length >= 4, 'found the order sends');
  assert.match(CORE, /const msg = \{ type: 'order', cid: newCid\(\), account: TR\.account,/);
  // Flatten: the click sends for the account and instrument shown (sendFlatten); a resend after a rate refusal only
  // while those are still shown (review 3 S4), Flatten all's while the account is still a trade account (1.12.0)
  assert.match(CORE, /sendFlatten\(TR\.account, R, false, other \? 'all' : 'here'\);/);
  assert.match(CORE, /send\(\{ type: 'flatten', account, root: R \}\);/);
  assert.match(CORE, /const ok = on && \(f\.kind === 'here' \? TR\.account === f\.account && root\(\) === f\.root : TR\.accounts\.includes\(f\.account\)\);\n\s+if \(ok\) \{ sendFlatten\(f\.account, f\.root, true, f\.kind\);/);
  // ready(): the picker must show TR.account, else nothing is sent
  const ready = CORE.slice(CORE.indexOf('function ready('), CORE.indexOf('function sendOrder('));
  assert.match(ready, /if \(env\.pickerAccount\(\) !== TR\.account\) \{ env\.syncAccounts\(\); flash\('Nothing was sent[^\n]*return false; \}/);
  assert.match(PAGE, /pickerAccount: \(\) => \$\('oAcct'\)\.value,/, 'the page\'s picker');
  assert.match(WS, /pickerAccount: \(\) => \(holds\(\) && TK\.el \? tk\('oAcct'\)\.value : ticketAccount\(\)\),/, 'the ticket\'s picker');
  // every path goes through ready(): sendOrder (Buy, Sell, click-trade, Shift+click), cancelAll, Flatten, move, cancel
  assert.match(CORE.slice(CORE.indexOf('function sendOrder('), CORE.indexOf('function placeAt(')), /^\s+if \(!ready\(\)\) return;/m);
  assert.match(CORE.slice(CORE.indexOf('function breakEven('), CORE.indexOf('function bePump(')), /^\s+if \(!ready\(\)\) return;/m);
  assert.match(CORE.slice(CORE.indexOf('function cancelAll('), CORE.indexOf('function cancelPump(')), /^\s+if \(!ready\(\)\) return;/m);
  // Flatten (the button and the Close hotkey, 1.11.0) and Flatten all: ready() first; Flatten all names TR.account then
  assert.match(CORE, /\$\('flattenBtn'\)\.addEventListener\('click', pointerOnly\(\(\) => core\.flattenHere\(\)\)\);/);
  assert.match(CORE, /function flattenHere\(other\) \{\n\s+if \(!ready\(false\)\) return;/);
  assert.match(CORE, /function flattenAll\(\) \{\n\s+if \(!ready\(false\)\) return;\n\s+const account = TR\.account;/);
  // only Flatten and Flatten all skip the Armed check (Anthony 2026-10-01); every other ready() call keeps it
  assert.deepEqual((CORE.match(/ready\(false\)/g) || []).length, 2);
  assert.match(CORE, /if \(!TR\.armed && armed !== false\) \{ flash\('Armed is off: nothing was sent/);
  // the hotkeys and the buttons call the core's own functions: no second order path, on either page
  assert.match(PAGE, /actions: \{ buy: \(\) => T\.sendOrder\('buy', 'market', null\), sell: \(\) => T\.sendOrder\('sell', 'market', null\), be: T\.breakEven, close: \(\) => T\.flattenHere\(\), flattenAll: T\.flattenAll \},/);
  assert.match(CORE, /\$\('buyMkt'\)\.addEventListener\('click', pointerOnly\(\(\) => core\.sendOrder\('buy', 'market', null\)\)\);/);
  assert.match(CORE, /\$\('sellMkt'\)\.addEventListener\('click', pointerOnly\(\(\) => core\.sendOrder\('sell', 'market', null\)\)\);/);
  assert.match(CORE, /\$\('beBtn'\)\.addEventListener\('click', pointerOnly\(core\.breakEven\)\);/);
  assert.match(PAGE, /chart\.on\('orderMove', e => \(OT\.planIdOf\(e\.id\) \? T\.planMove\(e\.id, e\.price\) : T\.moveOrder\(e\.id, e\.price\)\)\);/);
  assert.match(PAGE, /chart\.on\('orderCancel', e => \(OT\.planIdOf\(e\.id\) \? T\.planRemove\(e\.id\) : T\.cancelOrder\(e\.id\)\)\);/);
  // 1.13.0: a planned line's drag, x and "+SL" / "+TP" go through ready() too (the gates of a leg's drag)
  assert.match(CORE, /function planTarget\(entryId\) \{\n\s+if \(!ready\(\)\) \{ env\.changed\(\); return null; \}\n\s+if \(notShown\(entryId\)\) return null;/);
  for (const f of ['planMove', 'planRemove', 'planAdd']) assert.match(CORE.slice(CORE.indexOf('function ' + f + '(')), /^\s+const o = planTarget\(/m, f);
  assert.match(CORE, /function moveOrder\(id, price\) \{\n\s+if \(!ready\(\)\) \{ env\.changed\(\); return; \}\n\s+if \(notShown\(id\)\) return;/);
  assert.match(CORE, /function cancelOrder\(id\) \{\n\s+if \(!ready\(\)\) return;\n\s+if \(notShown\(id\)\) return;/);
  assert.match(CORE, /const notShown = id => \{ const o = TR\.orders\.get\(id\); if \(o && o\.account === TR\.account\) return false;/);
  // the workspace sends only through the same core: its ticket's buttons (TradeCore.wire), chart clicks, keys, forwards
  assert.match(WS, /const core = TC\.create\(\{/);
  assert.match(WS, /TK\.bar = TC\.wire\(id => map\[id\] \|\| null, core, \{/);
  assert.doesNotMatch(WS, /tws\.send\(JSON\.stringify\(\{ type: '(order|flatten|cancel|change)'/, 'no order message built outside the core');
  assert.equal((WS.match(/tws\.send\(/g) || []).length, 1, 'the order connection is written only by the core\'s send');
});

test('trade.js: TR.account is set only from orderAccount, the picker, or cleared; Armed is never read from storage', () => {
  const sets = CORE.match(/TR\.account = [^;]*;/g);
  assert.deepEqual(sets, ["TR.account = TR.enabled ? pick.account : '';", "TR.account = '';", 'TR.account = a;']);
  assert.match(CORE, /const pick = LP\.orderAccount\(TR\.accounts, TR\.enabled \? env\.wantedAccount\(\) : ''\);/);
  assert.match(PAGE, /wantedAccount: \(\) => viewAccount,/);
  assert.match(CORE, /function pickAccount\(a\) \{\n\s+TR\.account = a;\n\s+if \(TR\.armed\) \{ setArmed\(false\); flash\('Armed turned off: the account changed\.', 'warn'\); \}/);
  assert.doesNotMatch(PAGE + CORE + WS, /TR\.armed = (?!v;)/, 'TR.armed is set only in setArmed');
  assert.doesNotMatch(PAGE + WS, /store\.(get|set|getItem|setItem)\('[^']*arm/i, 'nothing about Armed in storage');
  assert.match(CORE, /if \(cameOn \|\| !TR\.enabled \|\| TR\.account !== was\) setArmed\(false\);/);
  // the trading page never follows another tab's pick (each tab keeps its own account while open)
  assert.match(PAGE, /function followAccount\(v\) \{\n\s+if \(TRADING \|\| /);
  // the 1.5 fills choice is never an order account
  assert.match(PAGE, /if \(typeof v === 'string' && v\) \{ if \(TRADING\) \{ restored\.account = v; restored\.from = 'pc'; \} return v; \}\n\s+if \(TRADING\) return '';\n\s+const old = store\.get\('live-fill-account-v1'/);
  // review S1: a reload restores this tab's account (sessionStorage) first, the PC-wide last pick only for a new tab
  assert.match(PAGE, /if \(TRADING && tabAccount\(\)\) \{ restored\.account = tabAccount\(\); restored\.from = 'tab'; return restored\.account; \}\n\s+const v = store\.get\('live-account-v1', null\);/);
  assert.match(PAGE, /prefixedStorage\(window\.sessionStorage, PREFIX\)/);
  assert.equal((PAGE.match(/saveTabAccount\(/g) || []).length, 2, 'called on the two kinds of pick, never on a fallback');
});

/* Cancel all's batch (review 2 S1, S2, N1), run on its own: TradeCore with the page around it stubbed (the socket, the
   timers, the elements). The page itself is driven in test/orders-smoke.mjs. */
function cancelHarness(n, opts = {}) {
  const OT = require('../live/order-ticket.js');
  const store = new Map();
  const prefs = LP.create({ getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) });
  const D = { root: 'MNQ' }, ws = { readyState: 1 }, sent = [], at = [], flashes = [], timers = [], els = {}, clock = { t: 1000 };
  const $ = id => els[id] || (els[id] = { textContent: '', title: '', hidden: true, cls: new Set() });
  let core = null;
  core = TC.create({
    LP, prefs, fetch: () => new Promise(() => {}), send: m => { sent.push(m.id); at.push(clock.t); }, open: () => ws.readyState === 1, sock: () => ws,
    root: () => D.root, lastPrice: () => 100, qty: () => 1, pickerAccount: () => core.TR.account, wantedAccount: () => '', tick: () => 0.25, served: () => true, fmt: p => String(p),
    flash: (t, l) => flashes.push([t, l]), later: (fn, ms) => timers.push({ fn, ms }), changed: () => {}, armed: () => {}, applied: () => {}, lost: () => {}, syncAccounts: () => {},
    batch: () => { const b = core.batchLine(D.root); $('oCancel').textContent = b.text; if (b.away) $('oCancel').cls.add('away'); else $('oCancel').cls.delete('away'); },
    unsent: () => { const u = core.unsentNote(); $('unsentBar').hidden = !u.show; $('unsentText').textContent = u.text; },
    destroyed: () => false, now: () => clock.t,
  });
  const TR = Object.assign(core.TR, { v2: true, enabled: true, armed: true, account: 'EVAL-1', accounts: ['Sim101', 'EVAL-1'] });
  for (let i = 1; i <= n; i++) TR.orders.set('A' + i, { id: 'A' + i, account: 'EVAL-1', root: 'MNQ', side: 'buy', kind: 'limit', state: 'working', qty: 1, price: 100 - i, oco: null });
  for (const o of opts.others || []) TR.orders.set(o.id, o);
  const t = core._t;
  const api = { cancelAll: core.cancelAll, inCancelAll: core.inCancelAll, batchStop: t.batchStop, unsentCheck: t.unsentCheck, actionSent: t.actionSent,
    sendFlatten: t.sendFlatten, onRefused: t.onRefused, get batch() { return t.batch; } };
  // the next timer: the clock moves to it (a whole 1.1 s after the first of the last 8 sends)
  const tick = () => { const t = timers.shift(); if (t) { clock.t += t.ms; t.fn(); } return !!t; };
  const wait = ms => { clock.t += ms; };
  void OT;
  return { TR, D, ws, sent, at, flashes, timers, els, api, tick, wait, clock };
}

const inWindow = at => { for (let i = 0; i < at.length; i++) if (at.filter(t => t >= at[i] && t < at[i] + 1100).length > 6) return false; return true; };
const order = (id, account, root, price) => ({ id, account, root: root || 'MNQ', side: 'buy', kind: 'limit', state: 'working', qty: 1, price: price || 50, oco: null });

test('Cancel all: the rest go out by id whatever Armed, the account shown or the instrument say; nothing is locked (review 2 S1)', () => {
  const h = cancelHarness(20);
  h.api.cancelAll();
  assert.equal(h.sent.length, 6, 'the first 6 at the click (review 3 S4: 4 left for Anthony)');
  assert.match(h.els.oCancel.textContent, /^Cancelling on EVAL-1 MNQ: 14 left \(6 a second\)\.$/);
  assert.equal(h.els.oCancel.cls.has('away'), false);
  h.TR.armed = false; h.D.root = 'NQ'; h.TR.account = 'Sim101';          // Armed off, the instrument and the account switched
  h.tick();
  assert.equal(h.sent.length, 12, '6 more 1.1 s later');
  assert.equal(h.els.oCancel.cls.has('away'), true, 'the warning color while EVAL-1 MNQ is not shown (review 3 S2)');
  while (h.tick());
  assert.deepEqual(h.sent, [...Array(20)].map((_, i) => 'A' + (i + 1)), 'all 20, by id, once each');
  assert.equal(h.els.oCancel.textContent, '', 'the note goes with the last one');
  assert.equal(h.api.batch, null);
  assert.equal(h.timers.length, 0);
  assert.ok(inWindow(h.at), 'never over 6 in 1.1 s');
  // nothing locks the picker or Armed any more
  assert.doesNotMatch(PAGE + CORE, /TR\.cancelling|cancelSeq/);
  assert.match(CORE, /sel\.disabled = !TR\.accounts\.length;/);
  assert.match(CORE, /if \(el !== \$\('oAcct'\) && !el\.hasAttribute\('data-keep'\)\) el\.disabled = !on;/);
  assert.match(CORE, /const CANCEL_CHUNK = 6, CANCEL_GAP = 1100, CANCEL_AGAIN = 5000;/);
});

test('Cancel all: the newest click goes first, so the account shown never waits behind an earlier batch (review 3 S1)', () => {
  const h = cancelHarness(30, { others: [order('S1', 'Sim101'), order('S2', 'Sim101'), order('S3', 'Sim101')] });
  h.api.cancelAll();                                                     // 30 on EVAL-1
  h.wait(150); h.TR.account = 'Sim101';
  h.api.cancelAll();                                                     // then 3 on Sim101, the account shown
  assert.match(h.flashes.at(-1)[0], /^Added 3 to the cancels under way, first in line, on Sim101 MNQ\./);
  assert.match(h.els.oCancel.textContent, /^Cancelling on Sim101 MNQ: 3 left, EVAL-1 MNQ: 24 left/);
  h.tick();
  assert.deepEqual(h.sent.slice(6, 9), ['S1', 'S2', 'S3'], 'Sim101 first at the next slot, before EVAL-1\'s 24');
  while (h.tick());
  assert.equal(h.sent.length, 33);
  assert.ok(inWindow(h.at));
});

test('Cancel all of 6 or fewer: all sent at the click, so Armed going off right after drops none (review 2 N1)', () => {
  const h = cancelHarness(3);
  h.api.cancelAll();
  h.TR.armed = false;
  assert.deepEqual(h.sent, ['A1', 'A2', 'A3']);
  assert.equal(h.els.oCancel.textContent, '');
});

test('Cancel all: a second click sends nothing new, each send skips an order no longer working, a refused cancel can go again (review 2 S2, review 3 N1)', () => {
  const h = cancelHarness(20);
  h.api.cancelAll();
  h.wait(300);
  h.api.cancelAll();                                                     // the second click, orders still on the chart
  assert.equal(h.sent.length, 6);
  assert.match(h.flashes.at(-1)[0], /^Still cancelling on EVAL-1 MNQ: 14 left\. Nothing new to send\./);
  for (const id of ['A7', 'A8', 'A9']) h.TR.orders.delete(id);           // filled or cancelled meanwhile
  h.tick();
  assert.deepEqual(h.sent.slice(6), ['A10', 'A11', 'A12', 'A13', 'A14', 'A15']);
  while (h.tick());
  assert.equal(h.sent.length, 17);
  // still working (their cancels on the way): another click within 5 s sends nothing
  h.api.cancelAll();
  assert.equal(h.sent.length, 17);
  assert.match(h.flashes.at(-1)[0], /^Those cancels went out a moment ago\. Nothing new to send\./);
  // ChartBridge refused one of them (not for the rate): shown, and that one can go again at the next click
  assert.equal(h.api.onRefused({ type: 'reject', id: 'A20', reason: 'account EVAL-1 is in tradeAccounts but not connected in NinjaTrader' }), false, 'shown as a refusal');
  h.wait(1200); h.api.cancelAll();
  assert.deepEqual(h.sent.slice(17), ['A20']);
  // refused for the rate: sent again once by itself, at the pace; a second rate refusal of it is shown
  h.wait(1200);
  assert.equal(h.api.onRefused({ type: 'reject', id: 'A20', reason: 'More than 10 order actions in one second. Slow down.' }), true);
  assert.match(h.flashes.at(-1)[0], /^ChartBridge refused a cancel for the rate/);
  assert.deepEqual(h.sent.slice(18), ['A20']);
  assert.equal(h.api.onRefused({ type: 'reject', id: 'A20', reason: 'More than 10 order actions in one second. Slow down.' }), false);
  assert.ok(inWindow(h.at));
  // a Cancel all right after a batch ended waits for the pace too
  const g = cancelHarness(6);
  g.api.cancelAll();
  assert.equal(g.api.batch, null);
  g.TR.orders.set('B1', order('B1', 'EVAL-1'));
  g.wait(200); g.api.cancelAll();
  assert.equal(g.sent.length, 6, 'the 7th waits');
  g.tick();
  assert.deepEqual(g.sent.slice(6), ['B1']);
  assert.ok(g.at[6] - g.at[0] >= 1100);
});

test('a drag on an order in a Cancel all under way sends no change: Cancel all wins (Anthony 2026-09-30)', () => {
  const h = cancelHarness(10);
  h.api.cancelAll();
  assert.equal(h.api.inCancelAll('A1'), true, 'its cancel just went out');
  assert.equal(h.api.inCancelAll('A9'), true, 'queued');
  assert.equal(h.api.inCancelAll('X1'), false);
  while (h.tick());
  h.wait(5100);
  assert.equal(h.api.inCancelAll('A9'), false, 'a while after its cancel went out');
  assert.match(CORE, /if \(notShown\(id\)\) return;\n(\s+\/\*[^]*?\*\/\n)?\s+if \(inCancelAll\(id\)\) \{ env\.changed\(\); flash\('Not moved: order ' \+ id \+ ' is in the Cancel all under way, which cancels it\.', 'warn'\); return; \}\n\s+send\(\{ type: 'change'/);
});

test('Cancel all: the orders just sent count toward the pace, so ChartBridge never sees more than 10 a second', () => {
  const h = cancelHarness(10);
  for (let i = 0; i < 4; i++) { h.api.actionSent(); h.wait(150); }        // four Shift+clicks in the last 0.6 s
  h.api.cancelAll();
  assert.equal(h.sent.length, 2, 'at most 6 actions in 1.1 s');
  while (h.tick());
  assert.equal(h.sent.length, 10);
  assert.match(CORE, /function send\(obj\) \{\n\s+if \(!open\(\)\) return;\n\s+env\.send\(obj\);\n\s+if \(ORDER_ACTIONS\.includes\(obj\.type\)\) actionSent\(\);/);
});

test('Flatten: takes its orders off a batch (no "No working order" after it), and is sent again once after a rate refusal (review 2 S2, review 3 S4)', () => {
  const h = cancelHarness(20);
  const flat = [];
  h.api.cancelAll();
  h.api.sendFlatten('EVAL-1', 'MNQ');
  while (h.tick());
  assert.equal(h.sent.length, 6 + 1, 'the first 6 and the Flatten, nothing after it');
  assert.equal(h.api.batch, null);
  assert.match(CORE, /send\(\{ type: 'cancel', id \}\);\n\s+batchStop\(x => x\.id === id\);/);
  // refused for the rate: sent once more 1.1 s later, while EVAL-1 MNQ is still shown
  const g = cancelHarness(0);
  g.api.sendFlatten('EVAL-1', 'MNQ');
  assert.equal(g.api.onRefused({ type: 'reject', reason: 'More than 10 order actions in one second. Slow down.' }), true);
  assert.match(g.flashes.at(-1)[0], /^ChartBridge refused Flatten for EVAL-1 MNQ \(more than 10 order actions a second\): sending it again in 1 s\./);
  g.tick();
  assert.equal(g.sent.length, 2, 'sent again');
  assert.equal(g.api.onRefused({ type: 'reject', reason: 'More than 10 order actions in one second. Slow down.' }), false, 'only once: a second refusal shows as usual');
  // another refusal (not the rate), or one with an id or cid, is not a Flatten's to resend
  const k = cancelHarness(0);
  k.api.sendFlatten('EVAL-1', 'MNQ');
  assert.equal(k.api.onRefused({ type: 'reject', reason: 'account EVAL-1 may not trade from the chart' }), false);
  assert.equal(k.api.onRefused({ type: 'reject', cid: 'p1', reason: 'too many order actions (more than 10 a second)' }), false);
  // the account shown changed before the resend: not sent, and the note says so until dismissed
  const m = cancelHarness(0);
  m.api.sendFlatten('EVAL-1', 'MNQ');
  m.api.onRefused({ type: 'reject', reason: 'too many order actions (more than 10 a second)' });
  m.TR.account = 'Sim101';
  m.tick();
  assert.equal(m.sent.length, 1);
  assert.equal(m.els.unsentBar.hidden, false);
  assert.match(m.els.unsentText.textContent, /^Flatten for EVAL-1 MNQ was refused by ChartBridge \(more than 10 order actions a second\) and not sent again: the account or instrument shown changed\. The position may still be open\. Flatten again\.$/);
  void flat;
});

test('Cancel all: a drop mid-batch leaves a note that names the account, the instrument and the count, until dismissed or the orders are gone (review 2 S1)', () => {
  const h = cancelHarness(20);
  h.api.cancelAll();
  h.ws.readyState = 3;                                                   // the connection dropped before the next 6
  h.tick();
  assert.equal(h.sent.length, 6);
  assert.equal(h.api.batch, null);
  assert.equal(h.els.unsentBar.hidden, false);
  assert.match(h.els.unsentText.textContent, /^14 cancels on EVAL-1 MNQ were not sent: the connection to ChartBridge dropped\.\nThose orders may still be working\./);
  // reconnected: the orders list still has 5 of them
  h.TR.orders = new Map([...h.TR.orders].filter(([id]) => ['A16', 'A17', 'A18', 'A19', 'A20'].includes(id)));
  h.api.unsentCheck();
  assert.match(h.els.unsentText.textContent, /^5 cancels on EVAL-1 MNQ were not sent/);
  h.TR.orders.clear();
  h.api.unsentCheck();
  assert.equal(h.els.unsentBar.hidden, true, 'gone with the orders');
  // the account leaving ChartBridge's list: those stay in the note (not in the orders list), the rest go on
  const g = cancelHarness(12, { others: [] });
  g.api.cancelAll();
  g.TR.accounts = ['Sim101'];
  g.api.batchStop(e => !g.TR.accounts.includes(e.account), 'the account is no longer a trade account in ChartBridge');
  g.TR.orders.clear(); g.api.unsentCheck();
  assert.match(g.els.unsentText.textContent, /^6 cancels on EVAL-1 MNQ were not sent: the account is no longer a trade account in ChartBridge\./);
  // the wiring: a drop, trading off and the account list, a refusal, and Dismiss
  assert.match(CORE, /batchStop\(\(\) => true, 'the connection to ChartBridge dropped'\);   \/\/ before the orders are cleared/);
  assert.match(CORE, /if \(!TR\.enabled\) batchStop\(\(\) => true, 'trading went off \(' \+ TR\.reason\.replace\(\/\\\.\$\/, ''\) \+ '\)'\);/);
  assert.match(CORE, /case 'reject': if \(!onRefused\(m\)\) flash\('Refused by ChartBridge: ' \+ m\.reason, 'error'\);/);
  assert.match(CORE, /\$\('unsentClose'\)\.addEventListener\('click', \(\) => core\.dismissUnsent\(\)\);/);
  assert.match(CORE, /function dismissUnsent\(\) \{ unsent\.clear\(\); flattenMiss = ''; env\.unsent\(\); \}/);
});

test('order-ticket.js is unchanged by 1.6.1 (defaultAccount stays for anything else that uses it)', () => {
  const OT = require('../live/order-ticket.js');
  assert.equal(OT.defaultAccount(['EVAL-1', 'Sim101'], 'EVAL-1'), 'EVAL-1');
  assert.equal(OT.defaultAccount(['EVAL-1', 'Sim101'], 'X'), 'Sim101');
});
