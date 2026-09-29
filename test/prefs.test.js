'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LivePrefs: LP } = require('../live/live.js');

function mem(init) {
  const m = new Map(Object.entries(init || {}).map(([k, v]) => [k, JSON.stringify(v)]));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, dump: k => JSON.parse(m.get(k)), m };
}

test('defaults with empty storage: what the page showed before', () => {
  const p = LP.create(mem());
  assert.deepEqual(p.settings(), { root: 'MNQ', tf: 'm1', glide: 'smooth', rangeMode: 'nt' });
  assert.equal(p.range('NQ'), 20);
  assert.equal(p.range('ES'), 8);
  assert.deepEqual(p.indicators('main'), { volume: true, vwap: true, levels: true, fills: true, ib: true });
});

test('range size is per root, and one write never undoes another tab', () => {
  const s = mem();
  const tabA = LP.create(s), tabB = LP.create(s);
  assert.equal(tabA.setRange('NQ', 40), true);
  tabB.setRange('MNQ', 16);                       // tab B never saw NQ = 40
  const fresh = LP.create(s);
  assert.equal(fresh.range('NQ'), 40);
  assert.equal(fresh.range('MNQ'), 16);
  assert.equal(fresh.range('ES'), 8);
  tabA.setSetting('tf', 'range'); tabB.setSetting('glide', 'fast');
  assert.deepEqual(LP.create(s).settings(), { root: 'MNQ', tf: 'range', glide: 'fast', rangeMode: 'nt' });
});

test('range size validation: whole ticks 1 to 400', () => {
  assert.equal(LP.parseRange('40'), 40);
  assert.equal(LP.parseRange(' 40 '), 40);
  for (const bad of ['', '0', '401', '4.5', '-3', 'abc', '1e2', null, undefined]) assert.equal(LP.parseRange(bad), null, String(bad));
  assert.equal(LP.clampRange('999'), 400);
  assert.equal(LP.clampRange('0'), 1);
  assert.equal(LP.clampRange('12.6'), 13);
  assert.equal(LP.clampRange(''), null);
  const p = LP.create(mem());
  assert.equal(p.setRange('NQ', '0'), false);
  assert.equal(p.setRange('XX', 40), false);
  assert.equal(p.range('NQ'), 20);
});

test('1.3 keys are read once and carry over', () => {
  const s = mem({
    'live-settings-v1': { root: 'NQ', tf: 'range', glide: 'fast', layers: { volume: true, vwap: false, levels: true, fills: false } },
    'live-range-v1': { MNQ: 20, NQ: 40, MES: 8, ES: 'junk' },
  });
  const p = LP.create(s);
  assert.deepEqual(p.settings(), { root: 'NQ', tf: 'range', glide: 'fast', rangeMode: 'nt' });
  assert.equal(p.range('NQ'), 40);
  assert.equal(p.range('ES'), 8);
  assert.deepEqual(p.indicators('main'), { volume: true, vwap: false, levels: true, fills: false, ib: true });   // IB (1.5.3): the main pane default
  // later changes to the old keys (an older page in another tab) are not read again
  s.setItem('live-range-v1', JSON.stringify({ NQ: 12 }));
  s.setItem('live-settings-v1', JSON.stringify({ root: 'ES' }));
  const again = LP.create(s);
  assert.equal(again.range('NQ'), 40);
  assert.equal(again.settings().root, 'NQ');
  assert.deepEqual(s.dump('live-range-v1'), { NQ: 12 });   // left in place
});

test('indicators are saved per pane; a new pane starts with none on, the main pane with the 1.3 set', () => {
  const s = mem({ 'live-settings-v1': { layers: { volume: false, vwap: true, levels: false, fills: true } } });
  const p = LP.create(s);
  assert.deepEqual(p.indicators('main'), { volume: false, vwap: true, levels: false, fills: true, ib: true });
  assert.deepEqual(p.indicators('pane-2'), { volume: false, vwap: false, levels: false, fills: false, ib: false });
  assert.deepEqual(LP.create(mem()).indicators('main'), { volume: true, vwap: true, levels: true, fills: true, ib: true });
  assert.equal(p.setIndicator('pane-2', 'vwap', true), true);
  assert.equal(p.setIndicator('pane-2', 'bogus', true), false);
  assert.deepEqual(LP.create(s).indicators('pane-2'), { volume: false, vwap: true, levels: false, fills: false, ib: false });
  assert.deepEqual(LP.create(s).indicators('main'), { volume: false, vwap: true, levels: false, fills: true, ib: true });
});

test('IB 1h (1.5.3): its own indicator, on for the main pane (also one saved before 1.5.3), off for a new pane, saved per pane', () => {
  assert.ok(LP.INDICATORS.some(x => x.id === 'ib' && x.name === 'IB 1h'));
  // a main pane saved by 1.4 or 1.5.2 (no ib key) gets the default; its other choices are kept
  const s = mem({ 'live-settings-v2': {}, 'live-indicators-v1': { main: { volume: true, vwap: false, levels: true, fills: true }, 'pane-2': { vwap: true } } });
  const p = LP.create(s);
  assert.equal(p.indicators('main').ib, true);
  assert.equal(p.indicators('main').vwap, false);
  assert.equal(p.indicators('pane-2').ib, false);
  assert.equal(p.indicators('pane-9').ib, false);
  // turning IB off on the main pane in one tab and on for pane-2 in another: both stick, nothing else moves
  const a = LP.create(s), b = LP.create(s);
  a.setIndicator('main', 'ib', false);
  b.setIndicator('pane-2', 'ib', true);
  const fresh = LP.create(s);
  assert.deepEqual(fresh.indicators('main'), { volume: true, vwap: false, levels: true, fills: true, ib: false });
  assert.deepEqual(fresh.indicators('pane-2'), { volume: false, vwap: true, levels: false, fills: false, ib: true });
});

test('storage that throws or holds junk never breaks the page', () => {
  const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); } };
  const p = LP.create(throwing);
  assert.deepEqual(p.settings(), { root: 'MNQ', tf: 'm1', glide: 'smooth', rangeMode: 'nt' });
  assert.equal(p.setRange('NQ', 40), false);
  assert.equal(p.range('NQ'), 20);
  const none = LP.create(null);
  assert.equal(none.range('MNQ'), 20);
  const junk = mem(); junk.m.set('live-range-v2', '{not json'); junk.m.set('live-settings-v2', '[1,2]');
  const q = LP.create(junk);
  assert.equal(q.range('NQ'), 20);
  assert.equal(q.settings().root, 'MNQ');
  q.setRange('NQ', 33);
  assert.equal(LP.create(junk).range('NQ'), 33);
});

test('debounce waits for quiet, flush runs a waiting call now', async () => {
  const calls = [];
  const d = LP.debounce(v => calls.push(v), 30);
  d(1); d(2); d(3);
  assert.deepEqual(calls, []);
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(calls, [3]);
  d(4); d.flush();
  assert.deepEqual(calls, [3, 4]);
  d.flush();
  assert.deepEqual(calls, [3, 4]);
  d(5); d.cancel();
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(calls, [3, 4]);
});

test('every script the live page loads is copied by nt8/install.ps1', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'live', 'index.html'), 'utf8');
  const install = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'install.ps1'), 'utf8');
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(srcs.length >= 4);
  for (const src of srcs) {
    const file = (src.startsWith('../') ? src.slice(3) : 'live/' + src).split('/').join('\\');   // live\\live.js
    assert.ok(install.includes("'" + file + "'"), src + ' is not in install.ps1');
  }
});

test('every local stylesheet the live page loads is copied by nt8/install.ps1', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'live', 'index.html'), 'utf8');
  const install = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'install.ps1'), 'utf8');
  const hrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]).filter(h => !/^https?:/.test(h));
  assert.ok(hrefs.includes('live.css'));
  for (const href of hrefs) assert.ok(install.includes("'live\\" + href + "'"), href + ' is not in install.ps1');
});

/* A chart tab as the page holds it: choices read once at load, then changed one at a time. Before 1.4.1 the page
   wrote the whole pane set (setIndicators) or the whole bracket (setBracket); the fallbacks below do exactly that,
   so these tests show the old failure when run against 1.4.0 (review S2). */
function pageTab(s) {
  const p = LP.create(s);
  const layers = p.indicators('main'), bracket = Object.assign({ stop: 0, target: 0 }, p.bracket('MNQ'));
  return {
    toggle(id, on) { layers[id] = on; if (p.setIndicator) p.setIndicator('main', id, on); else p.setIndicators('main', layers); },
    setBracket(k, v) { bracket[k] = v; if (p.setBracketField) p.setBracketField('MNQ', k, v); else p.setBracket('MNQ', bracket); },
  };
}

test('two tabs: turning different indicators off in each keeps both (review S2)', () => {
  const s = mem();
  const a = pageTab(s), b = pageTab(s);          // both loaded before either change
  a.toggle('vwap', false);                        // tab A turns VWAP off
  b.toggle('volume', false);                      // tab B, still holding VWAP on, turns Volume off
  const after = LP.create(s).indicators('main');
  assert.equal(after.volume, false);
  assert.equal(after.vwap, false, "tab A's VWAP off must survive tab B's save");
  assert.equal(after.levels, true);
});

test('two tabs: a stop set in one and a target in the other both stick (review S2, brackets)', () => {
  const s = mem({ 'live-bracket-v1': { MNQ: { stop: 40, target: 20 } } });
  const a = pageTab(s), b = pageTab(s);
  a.setBracket('target', 80);                     // tab A: target 20 -> 80
  b.setBracket('stop', 30);                       // tab B, still holding target 20, changes the stop
  assert.deepEqual(LP.create(s).bracket('MNQ'), { stop: 30, target: 80 });
});

test('setBracketField: whole ticks 0 to 200 for stop or target on a known root only', () => {
  const s = mem(), p = LP.create(s);
  assert.equal(p.setBracketField('MNQ', 'stop', 40), true);
  for (const [r, k, v] of [['XX', 'stop', 4], ['MNQ', 'size', 4], ['MNQ', 'stop', 201], ['MNQ', 'stop', -1], ['MNQ', 'stop', 4.5], ['MNQ', 'stop', '4']]) assert.equal(p.setBracketField(r, k, v), false, [r, k, v].join(' '));
  assert.deepEqual(p.bracket('MNQ'), { stop: 40 });
});
