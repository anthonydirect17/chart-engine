// Trade tags (chart 1.34.0, Anthony 2026-10-21): live/trade-tags.js's pure part (TradeTagsCore): the chips, the trades from
// ChartBridge's fills, the phase of a click, which records the panel shows, each row's chip, this browser's copy; and the page's
// wiring (the panel in + Add panel, clicks only, nothing that trades). Made-up accounts (SIM-A, SIM-B) and sample prices only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../live/trade-tags.js');
const W = require('../live/workspace.js');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const T = 1792590300000;   // a made-up first fill (UTC ms)
const f = (id, side, qty, u, account) => ({ account: account || 'SIM-A', root: 'MNQ', side, qty, p: 25000, u, id });
const rec = (id, dim, value, phase, at, tom, account) => ({ id, account: account || 'SIM-A', root: 'MNQ', phase, dim, value, trade_open_ms: tom === undefined ? null : tom, at_ms: at });

test('the chips are Anthony\'s four rows, as The Desk keeps them (thedesk/trade_record.py CHIPS)', () => {
  assert.deepStrictEqual(C.DIMS, ['setup', 'grade', 'context', 'trigger']);
  assert.deepStrictEqual(Object.fromEntries(C.DIMS.map(d => [d, C.CHIPS[d].map(c => c[1])])), {
    setup: ['Continuation', 'Breakout', 'Reversal', 'Sweep/retest', 'Other'], grade: ['A+', 'A', 'B'],
    context: ['With-trend', 'Counter-trend', 'No context'], trigger: ['Absorption', 'Delta flip/divergence', 'Level hold/reclaim', 'Other'] });
  assert.deepStrictEqual(Object.fromEntries(C.DIMS.map(d => [d, C.CHIPS[d].map(c => c[0])])), {
    setup: ['continuation', 'breakout', 'reversal', 'sweep_retest', 'other'], grade: ['A+', 'A', 'B'],
    context: ['with_trend', 'counter_trend', 'no_context'], trigger: ['absorption', 'delta_flip', 'level_hold', 'other'] });
});

test('the trades from the fills: flat to flat, adds, a flip, and a position from before the list', () => {
  const fills = [f('1', 'buy', 1, T), f('2', 'buy', 1, T + 200), f('3', 'sell', 2, T + 600000), f('4', 'sell', 1, T + 1200000), f('x', 'buy', 5, T, 'SIM-B')];
  let tr = C.tradesOf(fills, 'SIM-A', 'MNQ', -1);
  assert.deepStrictEqual(tr.trades, [{ open: T, close: T + 600000 }, { open: T + 1200000, close: null }]);
  assert.deepStrictEqual(tr.openTrade, { open: T + 1200000, close: null });
  tr = C.tradesOf(fills.concat([f('5', 'buy', 3, T + 1300000)]), 'SIM-A', 'MNQ', 2);   // short 1, buy 3: a flip to long 2
  assert.deepStrictEqual(tr.trades.slice(1), [{ open: T + 1200000, close: T + 1300000 }, { open: T + 1300000, close: null }]);
  tr = C.tradesOf([f('9', 'buy', 1, T)], 'SIM-A', 'MNQ', 3);                             // long 2 before the list, then 1 more
  assert.deepStrictEqual(tr.trades, [{ open: null, close: null }]);
  assert.strictEqual(C.targetOf(tr, 'next').why, 'this position began before the fills ChartBridge lists, so its trade cannot be named');
  assert.deepStrictEqual(C.tradesOf([], 'SIM-A', 'MNQ', 0), { trades: [], openTrade: null });
});

test('the phase of a click: open while a position is open; flat: pre for the next trade, after for the last one', () => {
  const closed = C.tradesOf([f('1', 'buy', 1, T), f('2', 'sell', 1, T + 60000)], 'SIM-A', 'MNQ', 0);
  assert.deepStrictEqual(C.targetOf(closed, 'next'), { phase: 'pre', tradeOpenMs: null, trade: null, why: '' });
  assert.deepStrictEqual(C.targetOf(closed, 'last'), { phase: 'after', tradeOpenMs: T, trade: { open: T, close: T + 60000 }, why: '' });
  const open = C.tradesOf([f('1', 'buy', 1, T)], 'SIM-A', 'MNQ', 1);
  assert.strictEqual(C.targetOf(open, 'last').phase, 'open', 'a position open wins over the switch');
  assert.strictEqual(C.targetOf(open, 'next').tradeOpenMs, T);
  assert.match(C.targetOf(C.tradesOf([], 'SIM-A', 'MNQ', 0), 'last').why, /no closed trade/);
});

test('the chips shown: the newest record of each row, its phase kept; a click on the set chip clears the row', () => {
  const S = T - 3600000;
  const fills = [f('1', 'buy', 1, T), f('2', 'sell', 1, T + 600000)];
  const records = [rec('r0000001', 'setup', 'breakout', 'pre', T - 60000), rec('r0000002', 'grade', 'A', 'pre', T - 50000),
    rec('r0000003', 'setup', 'reversal', 'open', T + 1000, T), rec('r0000004', 'grade', null, 'open', T + 2000, T),
    rec('r0000005', 'trigger', 'absorption', 'after', T + 700000, T), rec('r0000006', 'context', 'with_trend', 'pre', T + 800000),
    rec('r0000007', 'setup', 'other', 'pre', T - 7200000), rec('r0000008', 'setup', 'other', 'pre', T + 900000, null, 'SIM-B')];
  const flat = C.tradesOf(fills, 'SIM-A', 'MNQ', 0);
  const last = C.chipsOf(C.recordsFor(records, 'SIM-A', 'MNQ', flat, C.targetOf(flat, 'last'), S));
  assert.deepStrictEqual(last, { setup: { value: 'reversal', label: 'Reversal', phase: 'open', at_ms: T + 1000 }, grade: null, context: null,
    trigger: { value: 'absorption', label: 'Absorption', phase: 'after', at_ms: T + 700000 } });
  const next = C.recordsFor(records, 'SIM-A', 'MNQ', flat, C.targetOf(flat, 'next'), S);
  assert.deepStrictEqual(next.map(r => r.id), ['r0000006'], 'the next trade: pre records since the last close, this account only');
  const open = C.tradesOf(fills.concat([f('3', 'buy', 1, T + 1000000)]), 'SIM-A', 'MNQ', 1);
  assert.deepStrictEqual(C.recordsFor(records, 'SIM-A', 'MNQ', open, C.targetOf(open, 'next'), S).map(r => r.id), ['r0000006'],
    'once the fill comes, the pre records since the close before it are this trade\'s');
});

test('1.34.1: fill times with a fraction of a ms (ChartBridge sends u with 3 decimals) still name the trade, and its records are kept', () => {
  const u1 = T + 0.123, u2 = T + 60000.789;
  const open = C.tradesOf([f('1', 'buy', 1, u1)], 'SIM-A', 'MNQ', 1);
  const t = C.targetOf(open, 'next');
  assert.strictEqual(t.phase, 'open');
  assert.strictEqual(t.tradeOpenMs, T);
  assert.ok(C.cleanRecord(rec('r0000101', 'trigger', 'absorption', 'open', T + 5000, t.tradeOpenMs)), 'an open record is kept');
  const closed = C.tradesOf([f('1', 'buy', 1, u1), f('2', 'sell', 1, u2)], 'SIM-A', 'MNQ', 0);
  const a = C.targetOf(closed, 'last');
  assert.deepStrictEqual(a, { phase: 'after', tradeOpenMs: T, trade: { open: T, close: T + 60001 }, why: '' });
  const r = rec('r0000102', 'grade', 'A', 'after', T + 70000, a.tradeOpenMs);
  assert.ok(C.cleanRecord(r), 'an after record is kept');
  const store = C.cleanStore({ records: [r], pending: [r.id], dropped: 0 });
  assert.deepStrictEqual(store.pending, [r.id], 'still waiting to be sent, not dropped');
  assert.deepStrictEqual(C.chipsOf(C.recordsFor(store.records, 'SIM-A', 'MNQ', closed, a, T - 3600000)).grade.value, 'A');
});

test('the session starts at 18:00 ET', () => {
  const et = 10 * 3600 + 30 * 60;   // 10:30 ET
  assert.strictEqual(C.sessionStartMs(T, 86400 * 20000 + et), T - (16 * 3600 + 30 * 60) * 1000);
  assert.strictEqual(C.sessionStartMs(T, 86400 * 20000 + 18 * 3600 + 5), T - 5000);
});

test('this browser\'s copy: bad records dropped, pending only for records kept, the newest kept', () => {
  const good = rec('r0000001', 'setup', 'breakout', 'pre', T);
  const st = C.cleanStore(JSON.stringify({ records: [good, rec('short', 'setup', 'x', 'pre', T), rec('r0000002', 'grade', 'breakout', 'pre', T),
    rec('r0000003', 'grade', 'A', 'open', T), rec('r0000004', 'grade', 'A', 'pre', T, T), good], pending: ['r0000001', 'r0000002', 7] }));
  assert.deepStrictEqual(st, { records: [good], pending: ['r0000001'], dropped: 1 }, 'a pending id with no usable record is counted as dropped');
  assert.deepStrictEqual(C.cleanStore('not json'), { records: [], pending: [], dropped: 0 });
  const many = { records: Array.from({ length: C.KEEP + 5 }, (_, i) => rec('r' + String(i).padStart(7, '0'), 'grade', 'B', 'pre', T + i)), pending: [] };
  assert.strictEqual(C.cleanStore(many).records.length, C.KEEP);
  /* the review of b4bc612: trimming never drops an unsent record: every pending one stays, the newest KEEP of the sent ones */
  const unsent = Object.assign({}, many, { pending: many.records.slice(0, 10).map(r => r.id) });
  const kept = C.cleanStore(unsent);
  assert.strictEqual(kept.records.length, C.KEEP + 5);
  assert.deepStrictEqual(kept.pending, unsent.pending, 'the 10 oldest, all pending, are kept');
  assert.strictEqual(kept.dropped, 0);
  const allUnsent = C.cleanStore(Object.assign({}, many, { pending: many.records.map(r => r.id), dropped: 2 }));
  assert.strictEqual(allUnsent.records.length, C.KEEP + 5);
  assert.strictEqual(allUnsent.dropped, 2, 'the count of records ever lost is kept');
  assert.deepStrictEqual(C.mergeRecords([good], [Object.assign({}, good, { value: 'other' }), rec('r0000009', 'grade', 'A+', 'pre', T - 5)]).map(r => [r.id, r.value]),
    [['r0000009', 'A+'], ['r0000001', 'breakout']], 'The Desk\'s records added by id; this browser\'s own kept');
  assert.match(C.newId(), /^tt[a-z0-9]{18}$/);
});

test('the page: Trade tags in + Add panel, saved in the layout, loaded before workspace.js and installed', () => {
  const html = read('live/index.html');
  assert.match(html, /<button type="button" role="menuitem" data-add="tags">Trade tags<\/button>/);
  assert.ok(html.indexOf('<script src="trade-tags.js"></script>') > 0 && html.indexOf('<script src="trade-tags.js"></script>') < html.indexOf('<script src="workspace.js"></script>'));
  assert.deepStrictEqual(W.cleanLayout({ panels: [{ id: 'tg1', type: 'tags', x: 10, y: 5, w: 2, h: 1 }] }).panels, [{ id: 'tg1', type: 'tags', x: 10, y: 5, w: 2, h: 1 }]);
  const files = JSON.parse(read('nt8/install-files.json'));
  assert.ok(files.www.some(x => x.from === 'live/trade-tags.js' && x.to === 'trade-tags.js'));
  assert.ok(files.addons.includes('nt8/ChartBridgeStops.cs'));
});

test('clicks only, and nothing that trades: no key handler, a keyboard press records nothing, no order message', () => {
  const src = read('live/trade-tags.js');
  assert.doesNotMatch(src, /addEventListener\('key(down|up|press)'/);
  assert.match(src, /if \(e\.detail === 0\) \{ say\('Trade tags work by click only, not by keyboard\.', true\); return; \}/);
  assert.doesNotMatch(src, /type: ?'(order|change|cancel|flatten)'|\.send\(JSON/);
  assert.match(src, /'\/api\/trade-tags'/);
  for (const file of ['live/trade-tags.js', 'nt8/ChartBridgeStops.cs', 'nt8/check/StopsHarness.cs', 'test/trade-tags.test.js', 'test/trade-tags-smoke.mjs']) {
    if (fs.existsSync(path.join(__dirname, '..', file))) assert.doesNotMatch(read(file), /[\u2013\u2014]/, file + ': no em or en dashes');
  }
  const css = read('live/workspace.css'), block = css.slice(css.indexOf('Trade tags (live/trade-tags.js)'));
  assert.doesNotMatch(block.replace(/\.tt-long \{[^}]*\}|\.tt-short \{[^}]*\}/g, ''), /--ws-buy|--ws-sell/, 'green and red only for the trade\'s side');
});
