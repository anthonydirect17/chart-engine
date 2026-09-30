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
  assert.deepEqual(p.indicators('main'), { volume: true, vwap: true, levels: true, fills: true, ib: true, vp: false, delta: true });   // the delta pane (1.7.0): on
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
  assert.deepEqual(p.indicators('main'), { volume: true, vwap: false, levels: true, fills: false, ib: true, vp: false, delta: true });   // IB (1.5.3) and the delta pane (1.7.0): the main pane defaults
  // later changes to the old keys (an older page in another tab) are not read again
  s.setItem('live-range-v1', JSON.stringify({ NQ: 12 }));
  s.setItem('live-settings-v1', JSON.stringify({ root: 'ES' }));
  const again = LP.create(s);
  assert.equal(again.range('NQ'), 40);
  assert.equal(again.settings().root, 'NQ');
  assert.deepEqual(s.dump('live-range-v1'), { NQ: 12 });   // left in place
});

const ALL = ['volume', 'vwap', 'levels', 'ib', 'fills'];
const IDS = LP.INDICATORS.map(d => d.id);                        // the five, the volume profile (off by default) and the delta pane (1.7.0)
const flags = on => Object.fromEntries(IDS.map(id => [id, on.includes(id)]));
const onIds = st => ALL.filter(id => st.ind[id].on);
const shownIds = st => ALL.filter(id => st.ind[id].on && st.ind[id].shown);
const pinIds = st => ALL.filter(id => st.ind[id].pin);

test('indicators (1.6.0): the main pane starts with the five on, shown and pinned (and the delta pane, 1.7.0); a new pane with none on', () => {
  const p = LP.create(mem());
  const main = p.pane('main'), fresh = p.pane('pane-2');
  assert.deepEqual([onIds(main), shownIds(main), pinIds(main)], [ALL, ALL, ALL]);
  assert.deepEqual(main.ind.delta, { on: true, shown: true, pin: true });
  assert.deepEqual([onIds(fresh), pinIds(fresh)], [[], []]);
  assert.deepEqual(p.indicators('pane-2'), flags([]));
  assert.deepEqual(LP.Pane.counts(main), { shown: 6, on: 6, hidden: 0 });
  assert.deepEqual(LP.Pane.counts(fresh), { shown: 0, on: 0, hidden: 0 });
  assert.deepEqual(main.recent, []);
  assert.equal(main.restore, null);
});

test('1.3 keys: the indicators chosen on 1.3 draw the same after the update (through live-indicators-v1)', () => {
  const s = mem({ 'live-settings-v1': { layers: { volume: false, vwap: true, levels: false, fills: true } } });
  const p = LP.create(s);
  assert.deepEqual(p.indicators('main'), { volume: false, vwap: true, levels: false, fills: true, ib: true, vp: false, delta: true });
  assert.deepEqual(p.indicators('pane-2'), flags([]));
  assert.deepEqual(s.dump('live-indicators-v1'), { main: { volume: false, vwap: true, levels: false, fills: true, ib: true, vp: false, delta: true } });   // left in place
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
  // drawn exactly as before on every pane (and the delta pane on the main pane, 1.7.0)
  assert.deepEqual(p.indicators('main'), flags(['vwap', 'levels', 'delta']));
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
  assert.deepEqual(again.indicators('main'), flags(['vwap', 'levels', 'delta']));
  assert.deepEqual(again.indicators('pane-9'), flags([]));
});

test('migration: a main pane saved before 1.5.3 gets IB on, with its other choices kept', () => {
  const p = LP.create(mem({ 'live-settings-v2': {}, 'live-indicators-v1': { main: { volume: true, vwap: false, levels: true, fills: true } } }));
  assert.deepEqual(p.indicators('main'), flags(['volume', 'levels', 'ib', 'fills', 'delta']));
  assert.deepEqual(shownIds(p.pane('main')), ['volume', 'levels', 'ib', 'fills']);
  assert.equal(p.pane('main').ind.vwap.on, true);
});

test('migration: a damaged live-indicators-v2 is carried over from v1 again, so an explicit off stays off (review N3)', () => {
  const s = mem({ 'live-settings-v2': {}, 'live-indicators-v1': { main: { fills: false } } });
  s.m.set('live-indicators-v2', '{bad');
  const p = LP.create(s);
  assert.equal(p.indicators('main').fills, false);
  assert.equal(p.pane('main').ind.fills.on, true);
  assert.equal(s.dump('live-indicators-v2').main.ind.fills.shown, false);
});

test('migration: nothing saved before means nothing written, and the defaults apply', () => {
  const s = mem({ 'live-settings-v2': {} });
  const p = LP.create(s);
  assert.equal(s.m.has('live-indicators-v2'), false);
  assert.deepEqual(p.indicators('main'), flags(ALL.concat('delta')));
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

test('Pane: the switch and + show, hide and add; one added gets a chip; the x takes it off', () => {
  const P = LP.Pane;
  let st = LP.defaultPane('pane-2');
  st = P.toggle(st, 'vwap');                                     // + adds it, shown, pinned (Anthony: added ones get a chip)
  assert.deepEqual([onIds(st), shownIds(st), pinIds(st)], [['vwap'], ['vwap'], ['vwap']]);
  st = P.toggle(st, 'vwap');                                     // the switch hides it: still on the chart
  assert.deepEqual([onIds(st), shownIds(st)], [['vwap'], []]);
  assert.deepEqual(P.counts(st), { shown: 0, on: 1, hidden: 1 });
  st = P.pin(st, 'vwap');
  assert.equal(st.ind.vwap.pin, false);
  st = P.remove(st, 'vwap');
  assert.deepEqual(onIds(st), []);
  st = P.toggle(st, 'vwap');                                     // added again: shown, and a chip again
  assert.deepEqual([shownIds(st), pinIds(st)], [['vwap'], ['vwap']]);
  const before = st;
  assert.equal(P.setShown(st, 'levels', true), before, 'a chip only acts on one that is on the chart');
  assert.equal(P.toggle(st, 'profile'), before, 'coming indicators cannot be added');
  assert.equal(P.toggle(st, 'bogus'), before);
  const again = P.toggle(before, 'ib');
  assert.equal(before.ind.ib.on, false, 'the state given is never changed');
  assert.equal(again.ind.ib.on, true);
});

test('Pane: the chip strip holds 6; when full an added one gets no chip and pinning by hand is refused', () => {
  const P = LP.Pane;
  assert.equal(LP.PIN_MAX, 6);
  assert.equal(P.pinned(LP.defaultPane('main')), 6, 'the main pane: the five and the delta pane (1.7.0)');
  assert.equal(P.pinFull(LP.defaultPane('main')), true);
  const cap = LP.PIN_MAX;
  try {
    LP.PIN_MAX = 2;                                              // five indicators today: a lower cap shows the rule
    let st = LP.defaultPane('pane-2');
    st = P.toggle(st, 'vwap'); st = P.toggle(st, 'levels');
    assert.deepEqual(pinIds(st), ['vwap', 'levels']);
    assert.equal(P.pinFull(st), true);
    st = P.toggle(st, 'ib');                                     // added while full: on the chart, no chip
    assert.deepEqual([onIds(st), pinIds(st)], [['vwap', 'levels', 'ib'], ['vwap', 'levels']]);
    assert.equal(P.pin(st, 'ib', true), st, 'pinning by hand when full is refused');
    st = P.pin(st, 'vwap', false);                               // make room
    st = P.pin(st, 'ib', true);
    assert.deepEqual(pinIds(st).filter(id => st.ind[id].on), ['levels', 'ib']);
    // a pin kept on one taken off does not count, and never takes a chip beyond the cap when it comes back
    st = P.remove(st, 'levels');
    st = P.toggle(st, 'fills');
    st = P.toggle(st, 'levels');
    assert.equal(P.pinned(st), 2);
  } finally { LP.PIN_MAX = cap; }
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
  assert.equal(P.hideLabel(st), 'Hide all (4)');                 // VWAP, Levels, IB and the delta pane (1.7.0)
  st = P.hideAll(st);
  assert.deepEqual(shownIds(st), []);
  assert.equal(P.drawn(st).delta, false);
  assert.deepEqual(onIds(st), ['volume', 'vwap', 'levels', 'ib'], 'hidden, not removed');
  assert.deepEqual(st.restore, ['vwap', 'levels', 'ib', 'delta']);
  assert.equal(P.hideLabel(st), 'Restore');
  st = P.hideAll(st);                                            // the same button: Restore
  assert.deepEqual(shownIds(st), ['vwap', 'levels', 'ib'], 'Volume stays hidden');
  assert.equal(P.drawn(st).delta, true);
  assert.equal(st.restore, null);
  // any other show or hide in between drops the saved mix
  st = P.hideAll(st);
  st = P.setShown(st, 'ib', true);
  assert.equal(st.restore, null);
  assert.equal(P.hideLabel(st), 'Hide all (1)');
  // one taken off after Hide all is not brought back by Restore
  st = P.hideAll(st); st = P.remove(st, 'ib'); st = P.remove(st, 'delta');
  assert.equal(P.hideLabel(st), 'Hide all (0)');
  assert.equal(P.hideAll(st), st, 'nothing to hide and nothing to restore: no change');
  // with the ones in the saved mix taken off, nothing to restore
  let t = P.hideAll(LP.defaultPane('main'));
  for (const id of IDS) t = P.remove(t, id);
  assert.equal(P.hideLabel(t), 'Hide all (0)');
});

/* A chart tab as the page runs it: what a click means is worked out from what the tab shows, then applied to its own
   state and to storage read fresh (review S1). */
function menuTab(s, paneId) {
  const p = LP.create(s);
  let IS = p.pane(paneId);
  const change = fn => { IS = fn(IS); p.updatePane(paneId, fn); };
  return {
    get IS() { return IS; },
    toggle: id => change(LP.Pane.toggleOp(IS, id)),
    hideAll: () => change(LP.Pane.hideAllOp(IS)),
    remove: id => change(st => LP.Pane.remove(st, id)),
  };
}

test('two tabs on the same indicator: each saves what it shows, never the opposite (review S1)', () => {
  const s = mem();
  const a = menuTab(s, 'main'), b = menuTab(s, 'main');         // both loaded with Fills shown
  a.toggle('fills');                                             // tab A hides Fills
  b.toggle('fills');                                             // tab B, still showing Fills, hides it too
  assert.equal(LP.Pane.drawn(b.IS).fills, false);
  assert.equal(LP.create(s).indicators('main').fills, false, 'saved as tab B shows it');
  // add from two tabs: both end with it on and shown
  const c = menuTab(s, 'pane-2'), d = menuTab(s, 'pane-2');
  c.toggle('vwap'); d.toggle('vwap');
  assert.equal(LP.create(s).indicators('pane-2').vwap, true);
});

test('two tabs pressing Hide all: saved as the tabs show it, and Restore brings back the same mix (review S1)', () => {
  const s = mem();
  const a = menuTab(s, 'main'), b = menuTab(s, 'main');
  a.hideAll(); b.hideAll();
  assert.deepEqual(LP.Pane.drawn(b.IS), flags([]));
  assert.deepEqual(LP.create(s).indicators('main'), flags([]), 'saved: all hidden, not restored');
  b.hideAll();                                                   // Restore in tab B
  assert.deepEqual(LP.create(s).indicators('main'), flags(ALL.concat('delta')));
  assert.deepEqual(LP.Pane.drawn(b.IS), flags(ALL.concat('delta')));
});

test('two tabs: showing writes on and shown, so a tab that shows one another tab took off draws what a reload draws (review 2, N7)', () => {
  const s = mem();
  const a = menuTab(s, 'main'), b = menuTab(s, 'main');
  a.remove('vwap');                                              // tab A takes VWAP off the chart
  b.toggle('vwap'); b.toggle('vwap');                           // tab B (stale) hides it, then shows it again
  assert.equal(LP.Pane.drawn(b.IS).vwap, true);
  assert.equal(LP.create(s).indicators('main').vwap, true, 'saved as tab B shows it');
  // Restore likewise
  const c = menuTab(s, 'pane-3'), d = menuTab(s, 'pane-3');
  c.toggle('ib'); d.toggle('ib');
  d.hideAll();                                                   // tab D hides IB (remembered for Restore)
  c.remove('ib');                                                // tab C takes it off
  d.hideAll();                                                   // Restore in tab D
  assert.equal(LP.Pane.drawn(d.IS).ib, true);
  assert.equal(LP.create(s).indicators('pane-3').ib, true);
});

test('updatePane reads fresh: two tabs changing one pane each keep the other\'s change (review S2)', () => {
  const s = mem();
  const a = LP.create(s), b = LP.create(s);                      // both loaded before either change
  a.updatePane('main', st => LP.Pane.toggle(st, 'vwap'));        // tab A hides VWAP
  b.updatePane('main', st => LP.Pane.toggle(st, 'volume'));      // tab B, still holding VWAP shown, hides Volume
  b.updatePane('pane-2', st => LP.Pane.toggle(st, 'ib'));
  a.updatePane('main', st => LP.Pane.pin(st, 'levels', false));
  const fresh = LP.create(s);
  assert.deepEqual(fresh.indicators('main'), flags(['levels', 'ib', 'fills', 'delta']));
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
  assert.deepEqual(p.indicators('main'), flags(ALL.concat('delta')));
  assert.equal(p.updatePane('main', st2 => LP.Pane.toggle(st2, 'vwap')), true);
  assert.equal(LP.create(s).indicators('main').vwap, false);
});

test('search matches names and short names', () => {
  const ids = q => LP.searchIndicators(q).map(d => d.id);
  assert.deepEqual(ids('vwap'), ['vwap']);
  for (const q of ['ib', 'ibh', 'ibl', 'initial', 'IB']) assert.deepEqual(ids(q), ['ib'], q);
  for (const q of ['pdh', 'pdl', 'onh', 'onl', 'levels', 'prior day']) assert.deepEqual(ids(q), ['levels'], q);
  assert.deepEqual(ids('vol'), ['volume', 'vp']);
  assert.deepEqual(ids('volume bars'), ['volume']);
  assert.deepEqual(ids('fills'), ['fills']);
  assert.deepEqual(ids('profile'), ['vp']);
  assert.deepEqual(ids(''), []);
  assert.deepEqual(ids('   '), []);
  assert.deepEqual(ids('zzz'), []);
});

test('the menu lists only real indicators, in three groups; the volume profile (1.6.0) and the cumulative delta (1.7.0) are among them', () => {
  assert.deepEqual(LP.INDICATORS.map(d => d.id), ['volume', 'vwap', 'levels', 'ib', 'vp', 'delta', 'fills']);
  assert.deepEqual(LP.CATEGORIES.map(c => c.name), ['Price', 'Volume', 'Trades']);
  const byCat = c => LP.INDICATORS.concat(LP.COMING).filter(d => d.cat === c).map(d => d.name);
  assert.deepEqual(byCat('price'), ['VWAP', 'Levels', 'Initial balance']);
  assert.deepEqual(byCat('volume'), ['Volume bars', 'Volume profile', 'Cumulative delta']);
  assert.deepEqual(byCat('trades'), ['Fills']);
  assert.deepEqual(LP.COMING, []);
  for (const d of LP.INDICATORS) assert.ok(d.opt && d.short && d.letter.length === 1 && d.sw, d.id);
  assert.equal(new Set(LP.INDICATORS.map(d => d.letter)).size, LP.INDICATORS.length, 'narrow chips: one letter each, all different');
});

test('the volume profile in the menu: off on every pane (also a main pane carried over from a 1.5.3 save), added with a chip under the cap, covered by Hide all', () => {
  const P = LP.Pane;
  assert.equal(LP.create(mem()).pane('main').ind.vp.on, false);
  const v1 = LP.create(mem({ 'live-settings-v2': {}, 'live-indicators-v1': { main: { vwap: false } } })).pane('main');
  assert.deepEqual([v1.ind.vp.on, v1.ind.vp.pin], [false, false], 'a 1.5.3 save has no vp key: off after the carry-over');
  const two = P.toggle(LP.defaultPane('pane-2'), 'vp');          // a pane with room: a chip
  assert.deepEqual([two.ind.vp.on, two.ind.vp.shown, two.ind.vp.pin, P.pinned(two)], [true, true, true, 1]);
  let st = P.toggle(LP.defaultPane('main'), 'vp');               // the main pane's strip is full since 1.7.0 (the delta pane is its sixth): no chip
  assert.deepEqual([st.ind.vp.on, st.ind.vp.shown, st.ind.vp.pin, P.pinned(st), P.pinFull(st)], [true, true, false, 6, true]);
  st = P.hideAll(st);
  assert.equal(P.drawn(st).vp, false);
  assert.ok(st.restore.includes('vp'));
  st = P.hideAll(st);
  assert.equal(P.drawn(st).vp, true);
  const ids = q => LP.searchIndicators(q).map(d => d.id);
  for (const q of ['vp', 'profile', 'poc', 'value area']) assert.ok(ids(q).includes('vp'), q);
  assert.deepEqual(ids('vah'), ['levels', 'vp']);
});

test('the volume profile carried over from live-indicators-v1: off from a 1.5.3 save, kept on from a save that had it on, under the 6-chip cap', () => {
  const P = LP.Pane;
  // (a) every 1.5.3 save: the five flags and no vp key, on the main pane and any other
  const s153 = LP.create(mem({ 'live-settings-v2': {}, 'live-indicators-v1': {
    main: { volume: true, vwap: false, levels: true, fills: true, ib: true }, 'pane-2': { volume: true, vwap: true, levels: false, fills: false, ib: false } } }));
  for (const pane of ['main', 'pane-2']) {
    const st = s153.pane(pane);
    assert.deepEqual([st.ind.vp.on, st.ind.vp.pin, P.drawn(st).vp], [false, false, false], pane + ': off, no chip, not drawn');
  }
  assert.equal(pinIds(s153.pane('main')).length, 5, 'the main pane keeps its five chips');
  assert.deepEqual(s153.pane('main').ind.delta, { on: true, shown: true, pin: true }, 'and the delta pane (1.7.0) on, its sixth chip');
  // (b) a save from the unreleased profile test build with vp on: on, shown and pinned, as it was drawn
  const on = LP.create(mem({ 'live-settings-v2': {}, 'live-indicators-v1': { main: { vp: true }, 'pane-2': { vp: true } } }));
  const main = on.pane('main');
  assert.deepEqual(main.ind.vp, { on: true, shown: true, pin: true });
  assert.equal(P.drawn(main).vp, true);
  assert.deepEqual(main.ind.delta, { on: true, shown: true, pin: false }, 'the delta pane on, no chip: the strip is full');
  assert.deepEqual([P.pinned(main), P.pinFull(main), LP.PIN_MAX], [6, true, 6], 'six chips on the main pane: the strip is full, not over it');
  const two = on.pane('pane-2');
  assert.deepEqual([two.ind.vp, P.pinned(two), onIds(two)], [{ on: true, shown: true, pin: true }, 1, []], 'another pane: only the profile');
  // with the main pane's explicit offs next to it: those stay hidden, the profile stays on
  const mixed = LP.create(mem({ 'live-settings-v2': {}, 'live-indicators-v1': { main: { vwap: false, vp: true } } })).pane('main');
  assert.deepEqual([mixed.ind.vp, shownIds(mixed), P.pinned(mixed), mixed.ind.delta.pin], [{ on: true, shown: true, pin: true }, ['volume', 'levels', 'ib', 'fills'], 6, false]);
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

test('volume profile (1.6.0): the vp indicator, off on every pane; its Session / RTH option saved per pane', () => {
  assert.ok(LP.INDICATORS.some(x => x.id === 'vp' && x.name === 'Volume profile'));
  assert.equal(LP.DEFAULT_INDICATORS.vp, false);
  assert.equal(LP.NEW_PANE_INDICATORS.vp, false);
  assert.deepEqual(LP.INDICATOR_OPTIONS.vp.session, ['full', 'rth']);
  const s = mem();
  const a = LP.create(s), b = LP.create(s);
  assert.deepEqual(a.indicatorOptions('main', 'vp'), { session: 'full' }, 'the full session by default');
  assert.deepEqual(a.indicatorOptions('main', 'nope'), {});
  assert.equal(a.setIndicatorOption('main', 'vp', 'session', 'rth'), true);
  assert.equal(b.setIndicatorOption('pane-2', 'vp', 'session', 'full'), true);   // another tab, another pane: both kept
  assert.equal(a.setIndicatorOption('main', 'vp', 'session', 'eth'), false, 'an unknown value is refused');
  assert.equal(a.setIndicatorOption('main', 'vp', 'rows', 4), false, 'an unknown option is refused');
  assert.equal(a.setIndicatorOption('main', 'ib', 'session', 'rth'), false, 'an indicator without options');
  assert.equal(a.setIndicatorOption('', 'vp', 'session', 'rth'), false);
  const fresh = LP.create(s);
  assert.deepEqual(fresh.indicatorOptions('main', 'vp'), { session: 'rth' });
  assert.deepEqual(fresh.indicatorOptions('pane-2', 'vp'), { session: 'full' });
  assert.deepEqual(s.dump('live-indicator-options-v1'), { main: { vp: { session: 'rth' } }, 'pane-2': { vp: { session: 'full' } } });
  // junk in storage falls back to the default
  const junk = mem({ 'live-indicator-options-v1': { main: { vp: { session: 'overnight' } }, x: 5 } });
  assert.deepEqual(LP.create(junk).indicatorOptions('main', 'vp'), { session: 'full' });
  assert.equal(LP.create(junk).setIndicatorOption('x', 'vp', 'session', 'rth'), true);
  a.updatePane('main', st => LP.Pane.add(st, 'vp'));
  assert.equal(LP.create(s).indicators('main').vp, true);
  assert.equal(LP.create(s).indicators('pane-2').vp, false);
});

test('indicator options: inherited names are never options, and a pane id such as __proto__ pollutes nothing (review S5)', () => {
  const s = mem();
  const p = LP.create(s);
  for (const [id, key, value] of [['vp', 'toString', 'x'], ['vp', 'constructor', 'keys'], ['vp', '__proto__', 'rth'], ['toString', 'session', 'rth'],
    ['__proto__', 'session', 'rth'], ['constructor', 'name', 'Object'], ['vp', 'session', 'toString'], ['vp', 'session', 'hasOwnProperty']]) {
    assert.equal(p.setIndicatorOption('main', id, key, value), false, id + '.' + key + ' = ' + value);
    assert.equal(LP.indicatorOptionAllowed(id, key, value), false);
  }
  assert.deepEqual(p.indicatorOptions('main', 'toString'), {});
  assert.deepEqual(p.indicatorOptions('main', '__proto__'), {});
  for (const pane of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(p.setIndicatorOption(pane, 'vp', 'session', 'rth'), true, pane);
    assert.deepEqual(LP.create(s).indicatorOptions(pane, 'vp'), { session: 'rth' }, pane + ' read back');
  }
  assert.equal(Object.prototype.vp, undefined, 'Object.prototype untouched');
  assert.equal({}.vp, undefined);
  assert.deepEqual(LP.create(s).indicatorOptions('main', 'vp'), { session: 'full' }, 'main untouched');
  const saved = JSON.parse(s.m.get('live-indicator-options-v1'));
  assert.ok(Object.prototype.hasOwnProperty.call(saved, '__proto__') && saved.constructor.vp.session === 'rth', 'stored as plain keys: ' + s.m.get('live-indicator-options-v1'));
  // a stored __proto__ key read back is a plain key too, and a new pane keeps it
  const t = mem(); t.m.set('live-indicator-options-v1', '{"__proto__":{"vp":{"session":"rth"}}}');
  assert.deepEqual(LP.create(t).indicatorOptions('__proto__', 'vp'), { session: 'rth' });
  assert.deepEqual(LP.create(t).indicatorOptions('main', 'vp'), { session: 'full' });
  assert.equal(LP.create(t).setIndicatorOption('main', 'vp', 'session', 'rth'), true);
  assert.deepEqual(LP.create(t).indicatorOptions('__proto__', 'vp'), { session: 'rth' }, 'the other pane kept');
  assert.equal(Object.prototype.vp, undefined);
});

/* ---------------- the cumulative delta pane (1.7.0, Anthony's rulings 2026-09-30) */
test('delta pane: a normal indicator, on for the main pane by default (the sixth chip), off on a new pane, found by its names', () => {
  const P = LP.Pane;
  const d = LP.INDICATORS.find(x => x.id === 'delta');
  assert.deepEqual([d.name, d.short, d.letter, d.cat], ['Cumulative delta', 'DELTA', 'D', 'volume']);
  assert.equal(LP.DEFAULT_INDICATORS.delta, true);
  assert.equal(LP.NEW_PANE_INDICATORS.delta, false);
  const p = LP.create(mem());
  assert.deepEqual(p.pane('main').ind.delta, { on: true, shown: true, pin: true });
  assert.deepEqual([P.pinned(p.pane('main')), P.pinFull(p.pane('main'))], [6, true], 'six chips: the cap, not over it');
  assert.deepEqual(p.pane('pane-2').ind.delta, { on: false, shown: true, pin: false });
  assert.equal(p.indicators('pane-2').delta, false);
  const ids = q => LP.searchIndicators(q).map(x => x.id);
  for (const q of ['delta', 'cd', 'cvd', 'cumulative', 'order flow', 'flow', 'DELTA', 'cumulative delta']) assert.deepEqual(ids(q), ['delta'], q);
  // show and hide keep it (and its option); x takes it off; + adds it back with a chip while there is room
  let st = p.pane('main');
  st = P.toggle(st, 'delta');
  assert.deepEqual([st.ind.delta.on, P.drawn(st).delta], [true, false], 'hidden, still on the chart');
  st = P.toggle(st, 'delta');
  assert.equal(P.drawn(st).delta, true);
  st = P.remove(st, 'delta');
  assert.deepEqual([st.ind.delta.on, P.pinned(st)], [false, 5]);
  st = P.toggle(st, 'delta');
  assert.deepEqual(st.ind.delta, { on: true, shown: true, pin: true }, 'added again: a chip again (room for it)');
  // a second pane adds it from the menu: on, shown, a chip
  const two = P.toggle(LP.defaultPane('pane-2'), 'delta');
  assert.deepEqual([two.ind.delta, P.counts(two)], [{ on: true, shown: true, pin: true }, { shown: 1, on: 1, hidden: 0 }]);
});

test('delta pane: an existing saved layout with no delta key gets it on for the main pane, an explicit off stays off (1.6.0 saves)', () => {
  const P = LP.Pane;
  // a 1.6.0 save: the main pane's five (VWAP hidden), no delta key; another pane with VWAP
  const saved = { main: { ind: { volume: { on: true, shown: true, pin: true }, vwap: { on: true, shown: false, pin: true }, levels: { on: true, shown: true, pin: true },
    ib: { on: true, shown: true, pin: true }, vp: { on: false, shown: true, pin: false }, fills: { on: true, shown: true, pin: true } }, recent: ['vwap'], restore: null },
  'pane-2': { ind: { vwap: { on: true, shown: true, pin: true } }, recent: [], restore: null } };
  const s = mem({ 'live-settings-v2': {}, 'live-indicators-v2': saved });
  const p = LP.create(s);
  assert.deepEqual(p.pane('main').ind.delta, { on: true, shown: true, pin: true }, 'main: on, shown, the sixth chip');
  assert.equal(p.indicators('main').vwap, false, 'the other choices kept');
  assert.equal(p.indicators('pane-2').delta, false, 'another pane: off, as a new pane');
  // with the profile pinned (six chips already): on, no chip, never over the cap
  const six = JSON.parse(JSON.stringify(saved)); six.main.ind.vp = { on: true, shown: true, pin: true };
  const q = LP.create(mem({ 'live-settings-v2': {}, 'live-indicators-v2': six })).pane('main');
  assert.deepEqual([q.ind.delta, P.pinned(q)], [{ on: true, shown: true, pin: false }, 6]);
  // an explicit off (or hidden) is kept, on the main pane and elsewhere
  const off = JSON.parse(JSON.stringify(saved));
  off.main.ind.delta = { on: false, shown: true, pin: false }; off['pane-2'].ind.delta = { on: true, shown: false, pin: true };
  const r = LP.create(mem({ 'live-settings-v2': {}, 'live-indicators-v2': off }));
  assert.deepEqual([r.pane('main').ind.delta.on, r.indicators('main').delta], [false, false], 'main: an explicit off stays off');
  assert.deepEqual([r.pane('pane-2').ind.delta.on, r.indicators('pane-2').delta], [true, false], 'pane-2: hidden stays hidden');
  // once changed, it is saved as shown: an update writes the delta entry
  p.updatePane('main', st => P.toggle(st, 'levels'));
  assert.deepEqual(s.dump('live-indicators-v2').main.ind.delta, { on: true, shown: true, pin: true });
  // junk in the delta entry reads as missing (on for main)
  const junk = JSON.parse(JSON.stringify(saved)); junk.main.ind.delta = 'off';
  assert.equal(LP.create(mem({ 'live-settings-v2': {}, 'live-indicators-v2': junk })).indicators('main').delta, true);
});

test('delta pane: carried over from live-indicators-v1 (1.5.3): on for the main pane with a chip while there is room, off on other panes', () => {
  const P = LP.Pane;
  const s = mem({ 'live-settings-v2': {}, 'live-indicators-v1': { main: { volume: true, vwap: false, levels: true, fills: false, ib: true }, 'pane-2': { vwap: true } } });
  const p = LP.create(s);
  assert.deepEqual(p.pane('main').ind.delta, { on: true, shown: true, pin: true });
  assert.deepEqual([pinIds(p.pane('main')), P.pinned(p.pane('main'))], [ALL, 6]);
  assert.deepEqual(p.indicators('main'), flags(['volume', 'levels', 'ib', 'delta']), 'the 1.5.3 choices exactly, and the delta pane');
  assert.deepEqual(p.indicators('pane-2'), flags(['vwap']));
  assert.equal(s.dump('live-indicators-v2').main.ind.delta.on, true, 'written with the carry-over');
  // a 1.3 save goes the same way (through live-indicators-v1)
  assert.equal(LP.create(mem({ 'live-settings-v1': { layers: { volume: false, vwap: true, levels: false, fills: true } } })).indicators('main').delta, true);
});

test('delta pane: its Show option (Cumulative or Bar delta) is saved per pane, only that field, on a fresh read', () => {
  assert.deepEqual(LP.INDICATOR_OPTIONS.delta.show, ['cum', 'bar']);
  const s = mem({ 'live-indicator-options-v1': { main: { vp: { session: 'rth' } } } });
  const a = LP.create(s), b = LP.create(s);
  assert.deepEqual(a.indicatorOptions('main', 'delta'), { show: 'cum' }, 'Cumulative by default');
  assert.equal(a.setIndicatorOption('main', 'delta', 'show', 'bar'), true);
  assert.equal(b.setIndicatorOption('pane-2', 'delta', 'show', 'cum'), true);   // another tab, another pane
  assert.equal(b.setIndicatorOption('main', 'delta', 'show', 'bars'), false, 'an unknown value is refused');
  assert.equal(b.setIndicatorOption('main', 'delta', 'session', 'rth'), false, 'another indicator\'s option is refused');
  assert.equal(b.setIndicatorOption('main', 'delta', 'toString', 'bar'), false);
  assert.deepEqual(s.dump('live-indicator-options-v1'), { main: { vp: { session: 'rth' }, delta: { show: 'bar' } }, 'pane-2': { delta: { show: 'cum' } } }, 'the profile\'s option kept');
  // always saved, also when the tab already shows it (another tab may have saved the other one since; 1.6.0 review S2)
  const c = LP.create(s);
  assert.equal(c.setIndicatorOption('main', 'delta', 'show', 'bar'), true);
  b.setIndicatorOption('main', 'delta', 'show', 'cum');
  c.setIndicatorOption('main', 'delta', 'show', 'bar');
  assert.deepEqual(LP.create(s).indicatorOptions('main', 'delta'), { show: 'bar' });
  assert.deepEqual(LP.create(mem({ 'live-indicator-options-v1': { main: { delta: { show: 'x' } } } })).indicatorOptions('main', 'delta'), { show: 'cum' }, 'junk: the default');
});

test('delta pane: its height is saved per pane (a share of the chart), kept between 8% and 60%, on a fresh read', () => {
  assert.deepEqual(LP.PANE_HEIGHTS.delta, { def: 0.2, min: 0.08, max: 0.6 });
  const s = mem();
  const a = LP.create(s), b = LP.create(s);
  assert.equal(a.paneHeight('main', 'delta'), 0.2, 'about 20% at first');
  assert.equal(a.setPaneHeight('main', 'delta', 0.3456), true);
  assert.equal(b.setPaneHeight('pane-2', 'delta', 0.15), true);             // another tab, another pane: both kept
  assert.deepEqual(s.dump('live-pane-heights-v1'), { main: { delta: 0.346 }, 'pane-2': { delta: 0.15 } });
  assert.equal(LP.create(s).paneHeight('main', 'delta'), 0.346);
  assert.equal(a.setPaneHeight('main', 'delta', 0.95), true);
  assert.equal(LP.create(s).paneHeight('main', 'delta'), 0.6, 'kept to the most');
  a.setPaneHeight('main', 'delta', 0.01);
  assert.equal(LP.create(s).paneHeight('main', 'delta'), 0.08, 'kept to the least');
  for (const bad of [NaN, Infinity, '0.3', null, undefined]) assert.equal(a.setPaneHeight('main', 'delta', bad), false, String(bad));
  assert.equal(a.setPaneHeight('main', 'vp', 0.3), false, 'only the delta pane has a height');
  assert.equal(a.setPaneHeight('', 'delta', 0.3), false);
  assert.equal(a.paneHeight('main', 'toString'), null);
  // junk and out-of-range values in storage read as the default
  for (const v of [5, -1, 'x', null, [0.3]]) assert.equal(LP.create(mem({ 'live-pane-heights-v1': { main: { delta: v } } })).paneHeight('main', 'delta'), 0.2, JSON.stringify(v));
  // a pane id such as __proto__ is a plain key
  assert.equal(a.setPaneHeight('__proto__', 'delta', 0.4), true);
  assert.equal(LP.create(s).paneHeight('__proto__', 'delta'), 0.4);
  assert.equal(LP.create(s).paneHeight('pane-2', 'delta'), 0.15);
  assert.equal(Object.prototype.delta, undefined);
  // per storage prefix, like every key
  const prefixed = pre => ({ getItem: k => s.getItem(pre + k), setItem: (k, v) => s.setItem(pre + k, v) });
  LP.create(prefixed('desk:')).setPaneHeight('main', 'delta', 0.25);
  assert.equal(LP.create(prefixed('desk:')).paneHeight('main', 'delta'), 0.25);
  assert.equal(LP.create(s).paneHeight('main', 'delta'), 0.08, 'the standalone page\'s own height kept');
});
