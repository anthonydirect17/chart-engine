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

const ALL = ['volume', 'vwap', 'levels', 'ib', 'fills'];
const flags = on => Object.fromEntries(ALL.map(id => [id, on.includes(id)]));
const onIds = st => ALL.filter(id => st.ind[id].on);
const shownIds = st => ALL.filter(id => st.ind[id].on && st.ind[id].shown);
const pinIds = st => ALL.filter(id => st.ind[id].pin);

test('indicators (1.6.0): the main pane starts with the five on, shown and pinned; a new pane with none on', () => {
  const p = LP.create(mem());
  const main = p.pane('main'), fresh = p.pane('pane-2');
  assert.deepEqual([onIds(main), shownIds(main), pinIds(main)], [ALL, ALL, ALL]);
  assert.deepEqual([onIds(fresh), pinIds(fresh)], [[], []]);
  assert.deepEqual(p.indicators('pane-2'), flags([]));
  assert.deepEqual(LP.Pane.counts(main), { shown: 5, on: 5, hidden: 0 });
  assert.deepEqual(LP.Pane.counts(fresh), { shown: 0, on: 0, hidden: 0 });
  assert.deepEqual(main.recent, []);
  assert.equal(main.restore, null);
});

test('1.3 keys: the indicators chosen on 1.3 draw the same after the update (through live-indicators-v1)', () => {
  const s = mem({ 'live-settings-v1': { layers: { volume: false, vwap: true, levels: false, fills: true } } });
  const p = LP.create(s);
  assert.deepEqual(p.indicators('main'), { volume: false, vwap: true, levels: false, fills: true, ib: true });
  assert.deepEqual(p.indicators('pane-2'), flags([]));
  assert.deepEqual(s.dump('live-indicators-v1'), { main: { volume: false, vwap: true, levels: false, fills: true, ib: true } });   // left in place
});

test('migration from live-indicators-v1: on and off carried over exactly, an explicit off stays off', () => {
  const v1 = {
    main: { volume: false, vwap: true, levels: true, fills: false, ib: false },
    'pane-2': { volume: false, vwap: true, levels: false, fills: false, ib: false },
    'pane-3': { vwap: 'yes', levels: true },                     // junk values fall back to the new-pane default (off)
    old: { volume: true, vwap: true, levels: true, fills: true },   // a pane saved before 1.5.3: no ib key
    bad: [1, 2], worse: 'x',
  };
  const s = mem({ 'live-settings-v2': {}, 'live-indicators-v1': v1 });
  const p = LP.create(s);
  // drawn exactly as before on every pane
  assert.deepEqual(p.indicators('main'), flags(['vwap', 'levels']));
  assert.deepEqual(p.indicators('pane-2'), flags(['vwap']));
  assert.deepEqual(p.indicators('pane-3'), flags(['levels']));
  assert.deepEqual(p.indicators('old'), flags(['volume', 'vwap', 'levels', 'fills']));   // not main: IB stays off, as 1.5.3 had it
  // the main pane keeps all five on its chart; the ones that were off are hidden (one click back) and all are pinned
  const main = p.pane('main');
  assert.deepEqual([onIds(main), shownIds(main), pinIds(main)], [ALL, ['vwap', 'levels'], ALL]);
  // any other pane: only what was on is on its chart (and pinned); an off there is off, like a new pane
  const two = p.pane('pane-2');
  assert.deepEqual([onIds(two), shownIds(two), pinIds(two)], [['vwap'], ['vwap'], ['vwap']]);
  assert.deepEqual(Object.keys(s.dump('live-indicators-v2')).sort(), ['main', 'old', 'pane-2', 'pane-3']);
  assert.deepEqual(p.indicators('never-saved'), flags([]));
  assert.deepEqual(s.dump('live-indicators-v1'), v1);           // left in place for an older page
  // read once: later changes to the old key (an older page in another tab) are not read again
  s.setItem('live-indicators-v1', JSON.stringify({ main: { vwap: false }, 'pane-9': { vwap: true } }));
  const again = LP.create(s);
  assert.deepEqual(again.indicators('main'), flags(['vwap', 'levels']));
  assert.deepEqual(again.indicators('pane-9'), flags([]));
});

test('migration: a main pane saved before 1.5.3 gets IB on, with its other choices kept', () => {
  const p = LP.create(mem({ 'live-settings-v2': {}, 'live-indicators-v1': { main: { volume: true, vwap: false, levels: true, fills: true } } }));
  assert.deepEqual(p.indicators('main'), flags(['volume', 'levels', 'ib', 'fills']));
  assert.deepEqual(shownIds(p.pane('main')), ['volume', 'levels', 'ib', 'fills']);
  assert.equal(p.pane('main').ind.vwap.on, true);
});

test('migration: nothing saved before means nothing written, and the defaults apply', () => {
  const s = mem({ 'live-settings-v2': {} });
  const p = LP.create(s);
  assert.equal(s.m.has('live-indicators-v2'), false);
  assert.deepEqual(p.indicators('main'), flags(ALL));
});

test('each storage prefix keeps its own indicators (The Desk\'s desk: keys are never the standalone page\'s)', () => {
  const s = mem({ 'live-indicators-v1': { main: { vwap: false } }, 'desk:live-indicators-v1': { main: { volume: false } } });
  const prefixed = pre => ({ getItem: k => s.getItem(pre + k), setItem: (k, v) => s.setItem(pre + k, v) });
  const page = LP.create(prefixed('')), desk = LP.create(prefixed('desk:'));
  assert.equal(page.indicators('main').vwap, false);
  assert.equal(page.indicators('main').volume, true);
  assert.equal(desk.indicators('main').vwap, true);
  assert.equal(desk.indicators('main').volume, false);
  desk.updatePane('main', st => LP.Pane.toggle(st, 'levels'));
  assert.equal(LP.create(prefixed('')).indicators('main').levels, true);
  assert.equal(LP.create(prefixed('desk:')).indicators('main').levels, false);
});

test('Pane: the switch and + show, hide and add; the x takes it off; pins are kept', () => {
  const P = LP.Pane;
  let st = LP.defaultPane('pane-2');
  st = P.toggle(st, 'vwap');                                     // + adds it, shown
  assert.deepEqual([onIds(st), shownIds(st)], [['vwap'], ['vwap']]);
  st = P.toggle(st, 'vwap');                                     // the switch hides it: still on the chart
  assert.deepEqual([onIds(st), shownIds(st)], [['vwap'], []]);
  assert.deepEqual(P.counts(st), { shown: 0, on: 1, hidden: 1 });
  st = P.pin(st, 'vwap');
  assert.equal(st.ind.vwap.pin, true);
  st = P.remove(st, 'vwap');
  assert.deepEqual(onIds(st), []);
  assert.equal(st.ind.vwap.pin, true, 'the pin waits for it to come back');
  st = P.toggle(st, 'vwap');                                     // added again: shown
  assert.deepEqual(shownIds(st), ['vwap']);
  const before = st;
  assert.equal(P.setShown(st, 'levels', true), before, 'a chip only acts on one that is on the chart');
  assert.equal(P.toggle(st, 'profile'), before, 'coming indicators cannot be added');
  assert.equal(P.toggle(st, 'bogus'), before);
  const again = P.toggle(before, 'ib');
  assert.equal(before.ind.ib.on, false, 'the state given is never changed');
  assert.equal(again.ind.ib.on, true);
});

test('Pane: Recent holds the last 5 used from the menu, newest first; a chip click is not a recent use', () => {
  const P = LP.Pane;
  let st = LP.defaultPane('pane-2');
  for (const id of ['vwap', 'levels', 'ib', 'fills', 'volume', 'vwap']) st = P.toggle(st, id);
  assert.deepEqual(st.recent, ['vwap', 'volume', 'fills', 'ib', 'levels']);
  st = P.setShown(st, 'levels', false);
  assert.deepEqual(st.recent, ['vwap', 'volume', 'fills', 'ib', 'levels']);
  assert.equal(LP.RECENT_MAX, 5);
});

test('Pane: Hide all then Restore brings back the same mix, not everything', () => {
  const P = LP.Pane;
  let st = LP.defaultPane('main');
  st = P.toggle(st, 'volume');                                   // Volume hidden by hand before Hide all
  st = P.remove(st, 'fills');
  assert.equal(P.hideLabel(st), 'Hide all (3)');
  st = P.hideAll(st);
  assert.deepEqual(shownIds(st), []);
  assert.deepEqual(onIds(st), ['volume', 'vwap', 'levels', 'ib'], 'hidden, not removed');
  assert.deepEqual(st.restore, ['vwap', 'levels', 'ib']);
  assert.equal(P.hideLabel(st), 'Restore');
  st = P.hideAll(st);                                            // the same button: Restore
  assert.deepEqual(shownIds(st), ['vwap', 'levels', 'ib'], 'Volume stays hidden');
  assert.equal(st.restore, null);
  // any other show or hide in between drops the saved mix
  st = P.hideAll(st);
  st = P.setShown(st, 'ib', true);
  assert.equal(st.restore, null);
  assert.equal(P.hideLabel(st), 'Hide all (1)');
  // one taken off after Hide all is not brought back by Restore
  st = P.hideAll(st); st = P.remove(st, 'ib');
  assert.equal(P.hideLabel(st), 'Hide all (0)');
  assert.equal(P.hideAll(st), st, 'nothing to hide and nothing to restore: no change');
  // with the ones in the saved mix taken off, nothing to restore
  let t = P.hideAll(LP.defaultPane('main'));
  for (const id of ALL) t = P.remove(t, id);
  assert.equal(P.hideLabel(t), 'Hide all (0)');
});

test('updatePane reads fresh: two tabs changing one pane each keep the other\'s change (review S2)', () => {
  const s = mem();
  const a = LP.create(s), b = LP.create(s);                      // both loaded before either change
  a.updatePane('main', st => LP.Pane.toggle(st, 'vwap'));        // tab A hides VWAP
  b.updatePane('main', st => LP.Pane.toggle(st, 'volume'));      // tab B, still holding VWAP shown, hides Volume
  b.updatePane('pane-2', st => LP.Pane.toggle(st, 'ib'));
  a.updatePane('main', st => LP.Pane.pin(st, 'levels', false));
  const fresh = LP.create(s);
  assert.deepEqual(fresh.indicators('main'), flags(['levels', 'ib', 'fills']));
  assert.equal(fresh.pane('main').ind.levels.pin, false);
  assert.deepEqual(fresh.indicators('pane-2'), flags(['ib']));
  assert.equal(a.updatePane('', st => st), false);
  assert.equal(a.updatePane('__proto__', st => st), false);
});

test('cleanPane: junk in storage never breaks a pane', () => {
  for (const junk of [null, 5, 'x', [], { ind: [] }, { ind: { vwap: 'on', bogus: { on: true } }, recent: 'vwap', restore: 7 }]) {
    const st = LP.cleanPane(junk, 'main');
    assert.deepEqual(onIds(st), ALL, JSON.stringify(junk));
    assert.ok(Array.isArray(st.recent) && st.restore === null);
  }
  const st = LP.cleanPane({ ind: { vwap: { on: false, shown: 1, pin: false } }, recent: ['ib', 'ib', 'x', 'vwap', 'levels', 'fills', 'volume', 'profile'], restore: ['vwap', 'nope'] }, 'main');
  assert.deepEqual([st.ind.vwap.on, st.ind.vwap.shown, st.ind.vwap.pin], [false, true, false]);
  assert.deepEqual(st.recent, ['ib', 'vwap', 'levels', 'fills', 'volume']);
  assert.deepEqual(st.restore, ['vwap']);
  const s = mem(); s.m.set('live-settings-v2', '{}'); s.m.set('live-indicators-v2', '{not json');
  const p = LP.create(s);
  assert.deepEqual(p.indicators('main'), flags(ALL));
  assert.equal(p.updatePane('main', st2 => LP.Pane.toggle(st2, 'vwap')), true);
  assert.equal(LP.create(s).indicators('main').vwap, false);
});

test('search matches names and short names', () => {
  const ids = q => LP.searchIndicators(q).map(d => d.id);
  assert.deepEqual(ids('vwap'), ['vwap']);
  for (const q of ['ib', 'ibh', 'ibl', 'initial', 'IB']) assert.deepEqual(ids(q), ['ib'], q);
  for (const q of ['pdh', 'pdl', 'onh', 'onl', 'levels', 'prior day']) assert.deepEqual(ids(q), ['levels'], q);
  assert.deepEqual(ids('vol'), ['volume', 'profile']);
  assert.deepEqual(ids('volume bars'), ['volume']);
  assert.deepEqual(ids('fills'), ['fills']);
  assert.deepEqual(ids('profile'), ['profile']);
  assert.equal(LP.searchIndicators('profile')[0].coming, true);
  assert.deepEqual(ids(''), []);
  assert.deepEqual(ids('   '), []);
  assert.deepEqual(ids('zzz'), []);
});

test('the menu lists only real indicators, in three groups, with the volume profile tagged coming', () => {
  assert.deepEqual(LP.INDICATORS.map(d => d.id), ALL);
  assert.deepEqual(LP.CATEGORIES.map(c => c.name), ['Price', 'Volume', 'Trades']);
  const byCat = c => LP.INDICATORS.concat(LP.COMING).filter(d => d.cat === c).map(d => d.name);
  assert.deepEqual(byCat('price'), ['VWAP', 'Levels', 'Initial balance']);
  assert.deepEqual(byCat('volume'), ['Volume bars', 'Volume profile']);
  assert.deepEqual(byCat('trades'), ['Fills']);
  assert.ok(LP.COMING.every(d => d.coming));
  for (const d of LP.INDICATORS) assert.ok(d.opt && d.short && d.letter.length === 1 && d.sw, d.id);
  assert.equal(new Set(LP.INDICATORS.map(d => d.letter)).size, LP.INDICATORS.length, 'narrow chips: one letter each, all different');
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
   wrote the whole bracket (setBracket); the fallback below does exactly that, so this test shows the old failure when
   run against 1.4.0 (review S2). Indicators: 'updatePane reads fresh' above. */
function pageTab(s) {
  const p = LP.create(s);
  const bracket = Object.assign({ stop: 0, target: 0 }, p.bracket('MNQ'));
  return {
    setBracket(k, v) { bracket[k] = v; if (p.setBracketField) p.setBracketField('MNQ', k, v); else p.setBracket('MNQ', bracket); },
  };
}

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
