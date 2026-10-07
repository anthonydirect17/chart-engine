'use strict';
// 1.16.0: the update notice's "ChartBridge x copied: press F5 when flat" goes as soon as the ChartBridge the page is
// connected to (its hello version) is x or newer, not at the updater's next run. The pure part in Node, then the browser
// part on a stand-in page (a fake document, fetch and timers): the note shows, a hello of the copied version hides it at
// once with no new read of update.json, an older hello brings it back. Display only: nothing is sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const N = require('../live/update-notice.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'live', 'update-notice.js'), 'utf8');

test('update notice: versions compared as the order ticket does ("fake-0.3.4" is 0.3.4)', () => {
  assert.deepEqual(N.versionOf('0.3.8'), [0, 3, 8]);
  assert.deepEqual(N.versionOf('fake-0.3.4'), [0, 3, 4]);
  assert.equal(N.versionOf(''), null);
  assert.equal(N.atLeast('0.3.8', '0.3.8'), true);
  assert.equal(N.atLeast('0.3.10', '0.3.9'), true, 'numbers, not text');
  assert.equal(N.atLeast('0.3.7', '0.3.8'), false);
  assert.equal(N.atLeast('', '0.3.8'), false, 'no hello yet: not at least anything');
});

test('update notice: the F5 note stays until the connected ChartBridge is the copied version or newer', () => {
  assert.equal(N.f5Pending('0.3.8', ''), true, 'no hello yet: it stays');
  assert.equal(N.f5Pending('0.3.8', '0.3.7'), true, 'still the old one: F5 not pressed yet');
  assert.equal(N.f5Pending('0.3.8', '0.3.8'), false, 'compiled: it goes');
  assert.equal(N.f5Pending('0.3.8', '0.3.9'), false, 'newer: it goes');
  assert.equal(N.f5Pending('0.3.8', 'garbled'), true, 'a version it cannot read: it stays');
  assert.equal(N.f5Pending(null, '0.3.9'), false, 'nothing copied: no note');
});

/* ---------------- the browser part on a stand-in page */
function fakeEl(tag) {
  const el = { tag, children: [], hidden: false, title: '', className: '', textContent: '', isConnected: true, scrollWidth: 0, clientWidth: 1000, id: '',
    classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.push(c); return c; }, querySelector() { return null; } };
  Object.defineProperty(el, 'innerHTML', { set() { el.children = [fakeEl('span'), fakeEl('span')]; } });
  Object.defineProperty(el, 'firstChild', { get() { return el.children[0]; } });
  Object.defineProperty(el, 'lastChild', { get() { return el.children[el.children.length - 1]; } });
  return el;
}
function page(update) {
  const host = fakeEl('div'), sent = [];
  const document = { head: fakeEl('head'), getElementById: () => null, createElement: fakeEl,
    querySelector: s => (s === '[data-update-host]' ? host : null) };
  const window = { addEventListener() {} };
  const ctx = { window, document, performance: { timeOrigin: Date.now() - 5000 }, console,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: (url, opt) => { sent.push(url); return Promise.resolve({ ok: true, json: () => Promise.resolve(update()) }); } };
  vm.runInNewContext(src, ctx);
  const note = () => { const n = host.children[0]; return n ? { hidden: n.hidden, said: n.lastChild.textContent } : null; };
  return { api: window.ChartUpdateNotice, note, sent };
}
const upd = cb => ({ schema: 1, page: { version: '1.16.0', build: 'b1', installedAt: 0, state: '' },
  chartBridge: Object.assign({ compiled: '0.3.7', ready: null, copied: null, mixed: null }, cb), updater: null });

test('update notice (stand-in page): the F5 note goes at the hello of the copied version, with no new read', async () => {
  const P = page(() => upd({ copied: '0.3.8' }));
  await P.api.checkNow();
  assert.deepEqual(P.note(), { hidden: false, said: 'ChartBridge 0.3.8 copied: press F5 when flat' }, 'before any hello');
  P.api.bridge('0.3.7');
  assert.equal(P.note().hidden, false, 'still the old ChartBridge: the note stays');
  const reads = P.sent.length;
  P.api.bridge('0.3.8');
  assert.deepEqual(P.note(), { hidden: true, said: '' }, 'the hello of 0.3.8: gone at once');
  assert.equal(P.sent.length, reads, 'nothing fetched or sent for it');
  await P.api.checkNow();
  assert.equal(P.note().hidden, true, 'the next read of the same update.json keeps it gone');
  P.api.bridge('0.3.7');
  assert.equal(P.note().hidden, false, 'a later hello of an older ChartBridge brings it back');
  P.api.bridge('0.3.9');
  assert.equal(P.note().hidden, true, 'a newer one: gone');
});

test('update notice (stand-in page): a hello before update.json is read counts; the other notes are untouched', async () => {
  const P = page(() => upd({ copied: '0.3.8' }));
  P.api.bridge('0.3.8');
  await P.api.checkNow();
  assert.equal(P.note().hidden, true, 'already 0.3.8 when update.json is first read: nothing shown');
  const Q = page(() => upd({ ready: '0.3.9' }));
  Q.api.bridge('0.3.9');
  await Q.api.checkNow();
  assert.equal(Q.note().said, 'ChartBridge 0.3.9 ready to install (flat, then F5)', 'the ready note is not this item\'s');
  const M = page(() => upd({ mixed: true, copied: '0.3.8' }));
  M.api.bridge('0.3.8');
  await M.api.checkNow();
  assert.match(M.note().said, /^DO NOT press F5: ChartBridge files are mixed/, 'the mixed stop stays');
});
