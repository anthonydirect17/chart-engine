// The workspace's pure parts (live/workspace.js, WorkspaceCore): layout cleaning, snapping, overlap checks, the largest
// free rectangle, re-flow and the large-print floor by time of day. No browser.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const W = require('../live/workspace.js');
const { LivePrefs } = require('../live/live.js');

const chart = (id, x, y, w, h, extra) => Object.assign({ id, type: 'chart', root: 'MNQ', tf: 'm1', x, y, w, h }, extra);
const tape = (id, x, y, w, h) => ({ id, type: 'tape', root: 'NQ', x, y, w, h });
const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
const noOverlap = ps => { for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) if (W.overlaps(ps[i], ps[j])) return false; return true; };
const inside = ps => ps.every(p => p.x >= 0 && p.y >= 0 && p.w >= 2 && p.h >= 1 && p.x + p.w <= 12 && p.y + p.h <= 6);

test('the lists match live.js (instruments and timeframes)', () => {
  assert.deepStrictEqual(W.ROOTS, LivePrefs.ROOTS);
  assert.deepStrictEqual(W.TFS, LivePrefs.TFS);
});

test('default layout (Anthony, 2026-10-01): 4 charts, the order ticket top right, Time and Sales under it, no execution chart', () => {
  let n = 0;
  const l = W.defaultLayout(() => 'id' + (++n));
  assert.deepStrictEqual(l.panels.map(p => [p.type, p.root, p.tf, p.x + 1, p.x + p.w, p.y + 1, p.y + p.h]), [
    ['chart', 'MNQ', 'range', 1, 7, 1, 4], ['chart', 'MNQ', 'h1', 1, 7, 5, 6], ['chart', 'NQ', 'm5', 8, 10, 1, 3], ['chart', 'ES', 'm1', 8, 10, 4, 6],
    ['ticket', undefined, undefined, 11, 12, 1, 2], ['tape', 'MNQ', undefined, 11, 12, 3, 6]]);
  assert.ok(l.panels.every(p => !('exec' in p)), 'no execution chart');
  assert.strictEqual(l.panels[0].range, 40);
  assert.deepStrictEqual(W.cleanLayout(l), l, 'the default is already clean');
  assert.ok(noOverlap(l.panels) && inside(l.panels));
  assert.strictEqual(W.largestFree(l.panels), null, 'it fills the grid');
  const ids = new Set(W.defaultLayout().panels.map(p => p.id));
  assert.strictEqual(ids.size, 6);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,40}$/);
});

test('cleanPanel: bad shapes dropped, only known fields kept', () => {
  assert.deepStrictEqual(W.cleanPanel(chart('a', 0, 0, 2, 1, { exec: true, range: 12, junk: 1 })), { id: 'a', type: 'chart', root: 'MNQ', tf: 'm1', range: 12, x: 0, y: 0, w: 2, h: 1 }, 'E1\'s exec flag is dropped');
  assert.deepStrictEqual(W.cleanPanel(tape('t', 1, 1, 2, 2)), { id: 't', type: 'tape', root: 'NQ', x: 1, y: 1, w: 2, h: 2 });
  assert.deepStrictEqual(W.cleanPanel({ id: 'k', type: 'ticket', root: 'ES', tf: 'm1', x: 10, y: 0, w: 2, h: 2 }), { id: 'k', type: 'ticket', x: 10, y: 0, w: 2, h: 2 }, 'the ticket keeps no instrument (it gets its own in E2b)');
  for (const bad of [null, 1, 'x', [], {}, chart('', 0, 0, 2, 1), chart('a b', 0, 0, 2, 1), chart('a', 0, 0, 2, 1, { type: 'clock' }),
    chart('a', 0, 0, 2, 1, { root: 'CL' }), chart('a', 0, 0, 2, 1, { tf: 'd1' }), chart('a', 0.5, 0, 2, 1), chart('a', -1, 0, 2, 1), chart('a', 0, 0, 0, 1), chart('a', 0, 0, '2', 1)]) {
    assert.strictEqual(W.cleanPanel(bad), null, JSON.stringify(bad));
  }
  assert.strictEqual(W.cleanPanel(chart('a', 0, 0, 2, 1, { range: 401 })).range, undefined);
});

test('cleanLayout: unique ids, at most 12 panels, at most one order ticket', () => {
  const many = [];
  for (let i = 0; i < 20; i++) many.push(chart('c' + i, (i % 6) * 2, Math.floor(i / 6) % 6, 2, 1));
  const l = W.cleanLayout({ panels: many });
  assert.strictEqual(l.panels.length, 12);
  const dup = W.cleanLayout({ panels: [chart('a', 0, 0, 2, 1), chart('a', 2, 0, 2, 1), chart('b', 4, 0, 2, 1),
    { id: 'k1', type: 'ticket', x: 6, y: 0, w: 2, h: 1 }, { id: 'k2', type: 'ticket', x: 8, y: 0, w: 2, h: 1 }] });
  assert.deepStrictEqual(dup.panels.map(p => p.id), ['a', 'b', 'k1'], 'a second id and a second ticket dropped');
  assert.deepStrictEqual(W.cleanLayout({ panels: [] }), { panels: [] }, 'an empty layout is kept');
  for (const bad of [null, undefined, 3, 'x', { panels: 'no' }, { panels: [null, 1, 'x'] }]) assert.deepStrictEqual(W.cleanLayout(bad), { panels: [] });
});

test('cleanStore: never throws, drops bad layouts and names', () => {
  for (const bad of [null, undefined, '', '{', '[]', 'null', 42, { v: 1 }, { layouts: [] }, { layouts: 'x' }]) assert.deepStrictEqual(W.cleanStore(bad), { v: 1, layouts: {} });
  const raw = JSON.stringify({ v: 1, layouts: { Main: { panels: [chart('a', 0, 0, 2, 1)] }, Second: { panels: [] }, ' padded ': { panels: [] }, '': { panels: [] },
    Bad: { panels: 'x' }, Worse: null, ['x'.repeat(41)]: { panels: [] } } });
  const s = W.cleanStore(raw);
  assert.deepStrictEqual(Object.keys(s.layouts), ['Main', 'Second']);
  const proto = W.cleanStore('{"v":1,"layouts":{"__proto__":{"panels":[]},"constructor":{"panels":[]}}}');
  assert.deepStrictEqual(Object.keys(proto.layouts), []);
  assert.strictEqual(({}).panels, undefined, 'nothing reached Object.prototype');
});

test('layoutName: trimmed, one space, 40 characters, no reserved names', () => {
  assert.strictEqual(W.layoutName('  Second   screen '), 'Second screen');
  assert.strictEqual(W.layoutName('a'.repeat(50)).length, 40);
  for (const bad of ['', '   ', null, 3, '__proto__', 'constructor']) assert.strictEqual(W.layoutName(bad), '');
});

test('overlaps and fits', () => {
  const ps = [chart('a', 0, 0, 4, 2), chart('b', 4, 0, 4, 2)];
  assert.ok(W.overlaps({ x: 3, y: 1, w: 2, h: 1 }, ps[0]));
  assert.ok(!W.overlaps({ x: 4, y: 2, w: 2, h: 1 }, ps[0]), 'touching edges is not overlapping');
  assert.ok(W.fits({ x: 0, y: 2, w: 12, h: 4 }, ps));
  assert.ok(!W.fits({ x: 2, y: 0, w: 4, h: 2 }, ps, 'a'), 'overlaps b');
  assert.ok(W.fits({ x: 1, y: 0, w: 3, h: 2 }, ps, 'a'), 'a may overlap its own old place');
  assert.ok(!W.fits({ x: 11, y: 0, w: 2, h: 1 }, []), 'past the right edge');
  assert.ok(!W.fits({ x: 0, y: 5, w: 2, h: 2 }, []), 'past the bottom');
  assert.ok(!W.fits({ x: 0, y: 0, w: 1, h: 1 }, []), 'smaller than 2 x 1');
});

test('snapMove and snapResize: whole cells, inside the grid, at least 2 x 1', () => {
  const m = W.metrics(1206, 606);                      // 12 x 6 cells of 94 x 94 px with 6 px gaps and padding: a 100 px pitch
  assert.strictEqual(m.cw, 94); assert.strictEqual(m.ch, 94);
  const p = chart('a', 2, 1, 3, 2);
  assert.deepStrictEqual(W.snapMove(p, 49, 0, m), { x: 2, y: 1, w: 3, h: 2 }, 'under half a cell stays');
  assert.deepStrictEqual(W.snapMove(p, 51, -51, m), { x: 3, y: 0, w: 3, h: 2 }, 'over half a cell moves one');
  assert.deepStrictEqual(W.snapMove(p, 5000, 5000, m), { x: 9, y: 4, w: 3, h: 2 }, 'kept inside');
  assert.deepStrictEqual(W.snapMove(p, -5000, -5000, m), { x: 0, y: 0, w: 3, h: 2 });
  assert.deepStrictEqual(W.snapResize(p, 160, 90, m), { x: 2, y: 1, w: 5, h: 3 });
  assert.deepStrictEqual(W.snapResize(p, -5000, -5000, m), { x: 2, y: 1, w: 2, h: 1 }, 'minimum 2 x 1');
  assert.deepStrictEqual(W.snapResize(p, 5000, 5000, m), { x: 2, y: 1, w: 10, h: 5 }, 'up to the grid edge');
});

test('largestFree: biggest free rectangle, top left on a tie, null when full', () => {
  assert.deepStrictEqual(W.largestFree([]), { x: 0, y: 0, w: 12, h: 6 });
  assert.deepStrictEqual(W.largestFree([chart('a', 0, 0, 12, 4)]), { x: 0, y: 4, w: 12, h: 2 });
  assert.deepStrictEqual(W.largestFree([chart('a', 0, 0, 6, 6)]), { x: 6, y: 0, w: 6, h: 6 });
  // an L-shaped space: 3 wide down the right (3 x 6 = 18) beats the 9 x 1 strip at the bottom
  assert.deepStrictEqual(W.largestFree([chart('a', 0, 0, 9, 5)]), { x: 9, y: 0, w: 3, h: 6 });
  // only single free cells left: none is 2 x 1
  const full = []; for (let y = 0; y < 6; y++) full.push(chart('r' + y, y % 2, y, 11, 1));
  assert.strictEqual(W.largestFree(full), null);
  const def = W.defaultLayout().panels;
  assert.strictEqual(W.largestFree(def), null);
  assert.deepStrictEqual(W.largestFree(def.filter(p => p.type !== 'tape')), { x: 10, y: 2, w: 2, h: 4 }, 'closing the tape frees its place');
});

test('reflow: nothing off the grid, nothing overlapping, nothing lost while there is room', () => {
  const out = W.reflow([chart('a', 10, 5, 4, 3), chart('b', 0, 0, 20, 9)]);
  assert.ok(inside(out) && noOverlap(out));
  assert.deepStrictEqual(out.map(p => [p.id, p.x, p.y, p.w, p.h]), [['a', 8, 3, 4, 3], ['b', 0, 0, 8, 6]]);
  const ov = W.reflow([chart('a', 0, 0, 6, 6), chart('b', 2, 2, 4, 2), chart('c', 0, 0, 2, 1)]);
  assert.ok(inside(ov) && noOverlap(ov));
  assert.deepStrictEqual(ov.map(p => [p.id, p.x, p.y, p.w, p.h]), [['a', 0, 0, 6, 6], ['b', 6, 0, 4, 2], ['c', 10, 0, 2, 1]]);
  // no room for its size: it goes into the largest free rectangle, smaller
  const small = W.reflow([chart('a', 0, 0, 12, 5), chart('b', 0, 0, 12, 3)]);
  assert.deepStrictEqual(small.map(p => [p.id, p.x, p.y, p.w, p.h]), [['a', 0, 0, 12, 5], ['b', 0, 5, 12, 1]]);
  // a grid with no free 2 x 1 left: dropped
  assert.strictEqual(W.reflow([chart('a', 0, 0, 12, 6), chart('b', 0, 0, 2, 1)]).length, 1);
  // a smaller grid (fewer columns): every panel kept is on it, none overlapping, the first ones in place
  const narrow = W.reflow(W.defaultLayout().panels, 9, 6);
  assert.ok(narrow.every(p => p.x + p.w <= 9 && p.y + p.h <= 6) && noOverlap(narrow));
  assert.deepStrictEqual(narrow.slice(0, 2).map(p => [p.x, p.y, p.w, p.h]), [[0, 0, 7, 4], [0, 4, 7, 2]]);
  assert.ok(narrow.length >= 3, 'the right-hand panels squeezed into the two columns left');
});

test('the large-print floor by time of day: RTH 09:30 to 16:15 ET, overnight otherwise', () => {
  const d = 20000 * 86400;                               // some day, bar time (New York wall clock as if UTC)
  const at = (h, m, s = 0) => d + h * 3600 + m * 60 + s;
  assert.ok(!W.isRth(at(9, 29, 59.9)) && W.isRth(at(9, 30)) && W.isRth(at(16, 14, 59.9)) && !W.isRth(at(16, 15)) && !W.isRth(at(2, 0)));
  const f = W.cleanFloors(null);
  assert.deepStrictEqual(f, { MNQ: { rth: 100, eth: 50 }, NQ: { rth: 50, eth: 25 }, MES: { rth: 100, eth: 50 }, ES: { rth: 100, eth: 50 } });
  assert.strictEqual(W.floorAt('NQ', at(10, 0), f), 50);
  assert.strictEqual(W.floorAt('NQ', at(20, 0), f), 25);
  assert.strictEqual(W.floorAt('ES', at(9, 30), f), 100);
  assert.strictEqual(W.floorAt('ES', at(9, 29), f), 50);
  assert.strictEqual(W.floorAt('MNQ', at(16, 15), f), 50);
  assert.strictEqual(W.floorAt('MES', at(12, 0), null), 100, 'defaults without floors');
  const set = W.cleanFloors({ NQ: { rth: 40, eth: 0 }, ES: { rth: '75' }, CL: { rth: 1 }, MNQ: 'x' });
  assert.deepStrictEqual(set.NQ, { rth: 40, eth: 25 }, '0 is not a floor');
  assert.deepStrictEqual(set.ES, { rth: 75, eth: 50 });
  assert.ok(!('CL' in set));
  assert.deepStrictEqual(W.cleanFloors('{bad'), f);
});

test('storage: one layout written at a time, rename keeps the order, floors one at a time, nothing throws', () => {
  const s = mem();
  assert.deepStrictEqual(W.readStore(s), { v: 1, layouts: {} });
  assert.ok(W.saveLayout(s, 'Main', W.defaultLayout()));
  assert.ok(W.saveLayout(s, 'Second', { panels: [tape('t', 0, 0, 2, 6)] }));
  // another window saves Main while this one saves Second: neither undoes the other
  const other = JSON.parse(s.getItem(W.KEYS.store)); other.layouts.Main.panels.pop(); s.setItem(W.KEYS.store, JSON.stringify(other));
  W.saveLayout(s, 'Second', { panels: [tape('t', 2, 0, 2, 6)] });
  const now = W.readStore(s);
  assert.strictEqual(now.layouts.Main.panels.length, 5);
  assert.strictEqual(now.layouts.Second.panels[0].x, 2);
  assert.ok(W.saveLayout(s, 'Third', { panels: [] }));
  assert.ok(!W.renameLayout(s, 'Main', 'Second'), 'taken');
  assert.ok(W.renameLayout(s, 'Second', 'Left screen'));
  assert.deepStrictEqual(Object.keys(W.readStore(s).layouts), ['Main', 'Left screen', 'Third']);
  assert.ok(W.deleteLayout(s, 'Third') && !W.deleteLayout(s, 'Third'));
  assert.strictEqual(JSON.parse(s.getItem(W.KEYS.store)).v, 1);
  assert.ok(W.setFloor(s, 'NQ', 'rth', '60') && W.setFloor(s, 'NQ', 'eth', 30) && !W.setFloor(s, 'NQ', 'eth', 0) && !W.setFloor(s, 'CL', 'rth', 5) && !W.setFloor(s, 'NQ', 'x', 5));
  assert.deepStrictEqual(W.readFloors(s).NQ, { rth: 60, eth: 30 });
  assert.deepStrictEqual(JSON.parse(s.getItem(W.KEYS.floors)), { NQ: { rth: 60, eth: 30 } }, 'only floors set by hand are saved');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepStrictEqual(W.readStore(broken), { v: 1, layouts: {} });
  assert.strictEqual(W.saveLayout(broken, 'Main', W.defaultLayout()), false);
  assert.deepStrictEqual(W.readFloors(broken), W.cleanFloors(null));
  assert.strictEqual(W.setFloor(broken, 'NQ', 'rth', 5), false);
});

test('formatting: tape clock, prices, timeframe labels', () => {
  assert.strictEqual(W.fmtClock(20000 * 86400 + 10 * 3600 + 41 * 60 + 27.9), '10:41:27');
  assert.strictEqual(W.fmtClock(5), '00:00:05');
  assert.strictEqual(W.fmtPrice(30604.25, 2), '30,604.25');
  assert.strictEqual(W.fmtPrice(6846, 2), '6,846.00');
  assert.strictEqual(W.fmtPrice(999.5, 1), '999.5');
  assert.strictEqual(W.decimalsOf(0.25), 2);
  assert.strictEqual(W.decimalsOf(1), 0);
  assert.strictEqual(W.tfLabel('range', 40), 'Range 40');
  assert.strictEqual(W.tfLabel('h1'), '1 hour');
  assert.strictEqual(W.tfLabel('m5'), '5 min');
});

test('no en or em dashes in the workspace files', () => {
  for (const f of ['live/workspace.js', 'live/workspace.css', 'live/index.html', 'live/feed.js', 'live/update-notice.js', 'test/workspace.test.js', 'test/feed.test.js', 'test/workspace-smoke.mjs', 'test/perf-workspace.mjs']) {
    const p = path.join(__dirname, '..', f);
    if (fs.existsSync(p)) assert.ok(!/[\u2013\u2014]/.test(fs.readFileSync(p, 'utf8')), f);
  }
});

test('the workspace is the main page (index.html), the single chart page is single.html, both installed', () => {
  const www = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'nt8', 'install-files.json'), 'utf8')).www;
  const to = www.map(f => f.to);
  for (const f of ['index.html', 'single.html', 'workspace.js', 'workspace.css', 'feed.js', 'update-notice.js']) assert.ok(to.includes(f), f);
  assert.ok(!to.includes('workspace.html'), 'no workspace.html any more');
  assert.deepStrictEqual(www.find(f => f.to === 'index.html').from, 'live/index.html');
  assert.deepStrictEqual(www.find(f => f.to === 'single.html').from, 'live/single.html');
  const html = fs.readFileSync(path.join(__dirname, '..', 'live', 'index.html'), 'utf8');
  for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^":]+)"/g)) assert.ok(to.includes(m[1].replace(/^\.\.\//, '')), m[1]);
  assert.match(html, /id="wsGrid"/, 'index.html is the workspace');
  const at = f => html.indexOf('src="' + f + '"');
  assert.ok(at('live.js') < at('feed.js') && at('feed.js') < at('workspace.js') && at('workspace.js') < at('update-notice.js'), 'live.js, feed.js, workspace.js, then the update notice');
  assert.match(html, /data-update-host/, 'the update notice has its place in the top bar');
  const single = fs.readFileSync(path.join(__dirname, '..', 'live', 'single.html'), 'utf8');
  assert.match(single, /<script src="live\.js" data-mount="page"><\/script>/, 'single.html is the trading page');
  assert.ok(!/workspace|feed\.js/.test(single), 'and nothing of the workspace');
});
