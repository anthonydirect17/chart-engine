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

test('live.js: every order path sends for TR.account, and only after ready() checked the account shown', () => {
  // the messages that act on an account: the order and Flatten carry TR.account; cancel and change carry an id
  const sends = PAGE.match(/send\(\{ type: '(order|flatten|cancel|change)'[^\n]*/g) || [];
  assert.ok(sends.length >= 4, 'found the order sends');
  assert.match(PAGE, /const msg = \{ type: 'order', cid: newCid\(\), account: TR\.account,/);
  assert.match(PAGE, /send\(\{ type: 'flatten', account: TR\.account, root: D\.root \}\)/);
  // ready(): the picker must show TR.account, else nothing is sent
  const ready = PAGE.slice(PAGE.indexOf('function ready()'), PAGE.indexOf('function sendOrder('));
  assert.match(ready, /if \(\$\('oAcct'\)\.value !== TR\.account\) \{ syncAccounts\(\); flash\('Nothing was sent[^\n]*return false; \}/);
  // every path goes through ready(): sendOrder (Buy, Sell, click-trade, Shift+click), cancelAll, Flatten, move, cancel
  assert.match(PAGE.slice(PAGE.indexOf('function sendOrder('), PAGE.indexOf('function workingHere(')), /^\s+if \(!ready\(\)\) return;/m);
  assert.match(PAGE.slice(PAGE.indexOf('function cancelAll('), PAGE.indexOf('function setArmed(')), /^\s+if \(!ready\(\)\) return;/m);
  assert.match(PAGE, /\$\('flattenBtn'\)\.addEventListener\('click', pointerOnly\(\(\) => \{\n\s+if \(!ready\(\)\) return;/);
  assert.match(PAGE, /chart\.on\('orderMove', e => \{\n\s+if \(!ready\(\)\) \{ renderTrading\(\); return; \}\n\s+if \(notShown\(e\.id\)\) return;/);
  assert.match(PAGE, /chart\.on\('orderCancel', e => \{\n\s+if \(!ready\(\)\) return;\n\s+if \(notShown\(e\.id\)\) return;/);
  assert.match(PAGE, /const notShown = id => \{ const o = TR\.orders\.get\(id\); if \(o && o\.account === TR\.account\) return false;/);
});

test('live.js: TR.account is set only from orderAccount, the picker, or cleared; Armed is never read from storage', () => {
  const sets = PAGE.match(/TR\.account = [^;]*;/g);
  assert.deepEqual(sets, ["TR.account = TR.enabled ? pick.account : '';", "TR.account = '';", 'TR.account = e.target.value;']);
  assert.match(PAGE, /const pick = LP\.orderAccount\(TR\.accounts, TR\.enabled \? viewAccount : ''\);/);
  assert.doesNotMatch(PAGE, /TR\.armed = (?!v;)/, 'TR.armed is set only in setArmed');
  assert.doesNotMatch(PAGE, /store\.(get|set)\('[^']*arm/i, 'nothing about Armed in storage');
  assert.match(PAGE, /if \(cameOn \|\| !TR\.enabled \|\| TR\.account !== was\) setArmed\(false\);/);
  // the trading page never follows another tab's pick (each tab keeps its own account while open)
  assert.match(PAGE, /function followAccount\(v\) \{\n\s+if \(TRADING \|\| /);
  // the 1.5 fills choice is never an order account
  assert.match(PAGE, /if \(typeof v === 'string' && v\) \{ if \(TRADING\) \{ restored\.account = v; restored\.from = 'pc'; \} return v; \}\n\s+if \(TRADING\) return '';\n\s+const old = store\.get\('live-fill-account-v1'/);
  // review S1: a reload restores this tab's account (sessionStorage) first, the PC-wide last pick only for a new tab
  assert.match(PAGE, /if \(TRADING && tabAccount\(\)\) \{ restored\.account = tabAccount\(\); restored\.from = 'tab'; return restored\.account; \}\n\s+const v = store\.get\('live-account-v1', null\);/);
  assert.match(PAGE, /prefixedStorage\(window\.sessionStorage, PREFIX\)/);
  assert.equal((PAGE.match(/saveTabAccount\(/g) || []).length, 2, 'called on the two kinds of pick, never on a fallback');
});

test('live.js: a batched Cancel all locks the picker and Armed until its last cancel is sent, and sends only for its account (review N1)', () => {
  const ca = PAGE.slice(PAGE.indexOf('function cancelAll('), PAGE.indexOf('function setArmed('));
  assert.match(ca, /const acct = TR\.account, seq = \+\+cancelSeq, batched = ids\.length > 8;/);
  assert.match(ca, /if \(TR\.armed && TR\.account === acct\) send\(\{ type: 'cancel', id \}\); else unsent\+\+;/);
  assert.match(PAGE, /sel\.disabled = !TR\.accounts\.length \|\| !!TR\.cancelling;/);
  assert.match(PAGE, /el\.disabled = !on \|\| \(el === \$\('armBtn'\) && !!TR\.cancelling\);/);
  const fl = PAGE.slice(PAGE.indexOf("$('flattenBtn').addEventListener"), PAGE.indexOf("$('cancelAllBtn').addEventListener"));
  assert.doesNotMatch(fl, /cancelling/, 'Flatten is never blocked by it');
});

test('order-ticket.js is unchanged by 1.6.1 (defaultAccount stays for anything else that uses it)', () => {
  const OT = require('../live/order-ticket.js');
  assert.equal(OT.defaultAccount(['EVAL-1', 'Sim101'], 'EVAL-1'), 'EVAL-1');
  assert.equal(OT.defaultAccount(['EVAL-1', 'Sim101'], 'X'), 'Sim101');
});
