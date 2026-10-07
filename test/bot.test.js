'use strict';
// The Bot tab's logic (live/bot-core.js, chart page 1.16.0): rails and how close to each, the tighten-only rails change,
// a copilot proposal's life on the page, the library file (docs/BOT_LIBRARY.md) and its checks, the day-type log, the
// copilot keys, the notices and the bot's trades. The bot and the library here are made up (test/fixtures/bot-library.json).
// Also the fake's `botRails` (test/fake-v3.mjs, PROTOCOL.md "Bot rails from the page"), and the files' wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const BC = require('../live/bot-core.js');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const LIB = JSON.parse(read('test', 'fixtures', 'bot-library.json'));
const memStore = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }; };
const clone = v => JSON.parse(JSON.stringify(v));

test('rails: how close to each limit; amber from 70%, red from 90%', () => {
  assert.deepEqual(BC.railLevel(0, 5), { used: 0, max: 5, pct: 0, level: 'ok', known: true, text: '0 of 5' });
  assert.equal(BC.railLevel(3, 5).level, 'ok');                // 60%
  assert.equal(BC.railLevel(4, 5).level, 'amber');             // 80%
  assert.equal(BC.railLevel(5, 5).level, 'red');               // 100%
  assert.equal(BC.railLevel(2, 3).level, 'ok');                // 66.7%: under 70
  assert.equal(BC.railLevel(3, 3).level, 'red');
  assert.equal(BC.railLevel(7, 10).level, 'amber');            // exactly 70%
  assert.equal(BC.railLevel(9, 10).level, 'red');              // exactly 90%
  assert.equal(BC.railLevel(6, 5).pct, 1, 'capped at 100%');
  assert.equal(BC.railLevel(2, 0).known, false);
  assert.equal(BC.railLevel(2, null).level, 'ok');
  assert.equal(BC.railLevel(-1, 5).used, 0);
  const r = BC.rails({ trades: 4, maxTrades: 5, losses: 1, maxLosses: 3 });
  assert.equal(r.trades.level, 'amber'); assert.equal(r.losses.level, 'ok'); assert.equal(r.level, 'amber');
  assert.equal(BC.rails({ trades: 0, maxTrades: 5, losses: 3, maxLosses: 3 }).level, 'red');
  assert.equal(BC.rails(null).level, 'ok');
});

test('rails change as ChartBridge 0.4.0 built it: 1 to 5 trades, 1 to 3 losses, the root or its sibling, all three sent', () => {
  const cur = { maxTrades: 5, maxLosses: 3, root: 'MNQ', position: { qty: 0, avgPrice: null } };
  assert.deepEqual(BC.railsChange(cur, { maxTrades: 3, maxLosses: 2 }, 'c1').msg, { type: 'botRails', cid: 'c1', maxTrades: 3, maxLosses: 2, root: 'MNQ' });
  assert.deepEqual(BC.railsChange(cur, { maxTrades: '4', maxLosses: ' 3 ' }).msg, { type: 'botRails', maxTrades: 4, maxLosses: 3, root: 'MNQ' }, 'typed text');
  assert.deepEqual(BC.railsChange(cur, { maxTrades: 5, maxLosses: 3, root: 'NQ' }).msg, { type: 'botRails', maxTrades: 5, maxLosses: 3, root: 'NQ' }, 'the mini of the bot\'s micro');
  assert.match(BC.railsChange(cur, { maxTrades: 5, maxLosses: 3, root: 'ES' }).error, /root must be MNQ or NQ/);
  assert.match(BC.railsChange(cur, { maxTrades: 6, maxLosses: 3 }).error, /Trades must be a whole number from 1 to 5 \(ChartBridge's limit\)/);
  assert.match(BC.railsChange(cur, { maxTrades: 5, maxLosses: 4 }).error, /Losing trades must be a whole number from 1 to 3/);
  assert.match(BC.railsChange(cur, { maxTrades: 0, maxLosses: 3 }).error, /from 1 to 5/);
  assert.match(BC.railsChange(cur, { maxTrades: 2.5, maxLosses: 3 }).error, /whole number/);
  assert.match(BC.railsChange(cur, { maxTrades: '', maxLosses: 3 }).error, /whole number/);
  assert.match(BC.railsChange(cur, { maxTrades: '1e1', maxLosses: 3 }).error, /whole number/);
  assert.match(BC.railsChange(cur, { maxTrades: 5, maxLosses: 3 }).error, /Nothing to change/);
  assert.match(BC.railsChange({}, { maxTrades: 1, maxLosses: 1 }).error, /not known/);
  // ChartBridge keeps them in bot-rails.txt: lowered rails may go back up to its own limits (never above)
  assert.deepEqual(BC.railsChange({ maxTrades: 3, maxLosses: 2, root: 'MNQ' }, { maxTrades: 5, maxLosses: 3 }).msg, { type: 'botRails', maxTrades: 5, maxLosses: 3, root: 'MNQ' });
  // refused while the bot has a position (ChartBridge refuses it too, and while an entry works)
  assert.match(BC.railsChange({ maxTrades: 5, maxLosses: 3, root: 'MNQ', position: { qty: 1, avgPrice: 25400 } }, { maxTrades: 2, maxLosses: 1 }).error, /has a position/);
});

test('the bot\'s orders: only those ChartBridge marks by: "bot" (review 2), never Anthony\'s own Sim101 orders on the bot\'s root', () => {
  const bot = { account: 'Sim101', root: 'MNQ' };
  assert.equal(BC.isBotMark({ account: 'Sim101', root: 'MNQ', role: 'stop', by: 'bot' }, bot), true);
  assert.equal(BC.isBotMark({ account: 'Sim101', root: 'MNQ', role: 'entry' }, bot), false, 'Anthony\'s own Sim101 order on the bot\'s root: not the bot\'s');
  assert.equal(BC.isBotMark({ account: 'Sim101', root: 'MNQ', by: 'copier' }, bot), false);
  assert.equal(BC.isBotMark({ account: 'Sim101', root: 'MNQ', by: 'strategy' }, bot), false);
  assert.equal(BC.isBotMark({ account: 'EVAL-A', root: 'MNQ', by: 'bot' }, bot), false, 'not on the bot\'s account');
  assert.equal(BC.isBotMark({ account: 'Sim101', root: 'NQ', by: 'bot' }, null), true, 'the mark is enough before the bot message');
});

test('the bot\'s fills: claimed only against the contracts its own orders fill (a fill carries no by)', () => {
  const L = BC.botFillLedger(), bot = { account: 'Sim101', root: 'MNQ' };
  const fill = (id, side, p, qty) => ({ id, account: 'Sim101', root: 'MNQ', side, p, qty: qty || 1 });
  // Anthony's own Sim101 order fills first: no bot order owes it, so it is never the bot's
  assert.equal(L.order({ id: 'o1', account: 'Sim101', root: 'MNQ', side: 'buy', filled: 1, avgFill: 25000 }, bot), false);
  assert.equal(L.claim(fill('e1', 'buy', 25000)), false, 'an unmarked order\'s fill');
  // the bot's entry: the fill may come before or after the order message
  assert.equal(L.claim(fill('e2', 'buy', 25001)), false, 'before its order message: waits');
  assert.equal(L.order({ id: 'o2', by: 'bot', account: 'Sim101', root: 'MNQ', side: 'buy', filled: 1, avgFill: 25001 }, bot), true);
  assert.equal(L.claim(fill('e1', 'buy', 25000)), false, 'the price tells Anthony\'s fill from the bot\'s');
  assert.equal(L.claim(fill('e2', 'buy', 25001)), true, 'claimed once its order says it filled');
  assert.equal(L.claim(fill('e2', 'buy', 25001)), true, 'the same fill again: the same answer');
  assert.equal(L.claim(fill('e3', 'buy', 25001)), false, 'nothing more is owed');
  assert.equal(L.order({ id: 'o2', by: 'bot', account: 'Sim101', root: 'MNQ', side: 'buy', filled: 1, avgFill: 25001 }, bot), false, 'the same filled count: nothing new');
  // its stop (a leg the bot channel follows) fills
  L.order({ id: 'o3', by: 'bot', account: 'Sim101', root: 'MNQ', side: 'sell', filled: 1, avgFill: 24990, role: 'stop' }, bot);
  assert.equal(L.claim(fill('e4', 'sell', 24990)), true);
  L.clear();
  assert.equal(L.claim(fill('e5', 'buy', 25001)), false, 'cleared');
});

test('modes: Research builds run in shadow only; auto only when Sim101 is tradable; the bot switch', () => {
  const ready = LIB.bots.find(b => b.shelf === 'ready'), research = LIB.bots.find(b => b.shelf === 'research');
  let m = BC.modesAllowed({ entry: ready, simTradable: true });
  assert.ok(m.shadow.ok && m.copilot.ok && m.auto.ok);
  m = BC.modesAllowed({ entry: ready, simTradable: false });
  assert.ok(m.copilot.ok); assert.equal(m.auto.ok, false); assert.match(m.auto.why, /Sim101/);
  m = BC.modesAllowed({ entry: research, simTradable: true });
  assert.ok(m.shadow.ok); assert.equal(m.copilot.ok, false); assert.equal(m.auto.ok, false); assert.match(m.copilot.why, /Shadow only/);
  m = BC.modesAllowed({ entry: null, simTradable: true });
  assert.ok(m.copilot.ok && m.auto.ok, 'a bot not in the library: ChartBridge decides');
  assert.equal(BC.simTradable({ list: [{ name: 'Sim101', tradable: true }] }, null), true);
  assert.equal(BC.simTradable({ list: [{ name: 'Sim101', tradable: false }] }, { enabled: true, accounts: ['Sim101'] }), false, 'the accounts list wins');
  assert.equal(BC.simTradable(null, { enabled: true, accounts: ['Sim101'] }), true);
  assert.equal(BC.simTradable(null, { enabled: false, accounts: ['Sim101'] }), false);
  assert.equal(BC.botSwitchOn({ enabled: true, switches: { bot: true } }), true);
  assert.equal(BC.botSwitchOn({ enabled: true, switches: { bot: false } }), false);
  assert.equal(BC.botSwitchOn({ enabled: true }), false, 'a v2 answer has no switches: off');
  assert.equal(BC.botSwitchOn({ enabled: false, switches: { bot: true } }), false);
  assert.equal(BC.botSwitchOn({ enabled: true, switches: { bot: 'true' } }), false, 'only true is on');
});

test('proposals: show, botSeen once, answer once while open, end; an expired one is "not answered"', () => {
  const P = BC.createProposals();
  const p = { type: 'botProposal', id: 'p1', at: 1000, account: 'Sim101', root: 'MNQ', side: 'sell', kind: 'market', price: null, qty: 1, stopTicks: 12, targetTicks: 24, reason: 'Sample', state: 'open', seenAt: null, answeredAt: null };
  assert.equal(P.update(p).act, 'show');
  assert.deepEqual(P.shown('p1', 1450.4), { type: 'botSeen', id: 'p1', at: 1450 });
  assert.equal(P.shown('p1', 1600), null, 'botSeen goes once');
  assert.equal(P.update(Object.assign({}, p, { seenAt: 1450 })).act, 'update', 'still open');
  assert.deepEqual(P.open().map(x => x.id), ['p1']);
  const a = P.answer('p1', 'accept', 2650, 'c9');
  assert.deepEqual(a.msg, { type: 'botAnswer', cid: 'c9', id: 'p1', answer: 'accept', at: 2650 });
  assert.match(P.answer('p1', 'reject', 2700).error, /Already answered \(accept\)/, 'one answer');
  P.refused('p1');
  assert.ok(P.answer('p1', 'reject', 2800).msg, 'refused by ChartBridge: may be answered again while open');
  assert.deepEqual(P.update(Object.assign({}, p, { state: 'rejected', answeredAt: 2800 })), { act: 'end', p: Object.assign({}, p, { state: 'rejected', answeredAt: 2800 }), why: 'rejected' });
  assert.equal(P.update(Object.assign({}, p, { state: 'rejected' })).act, 'none', 'an end once');
  assert.match(P.answer('p1', 'accept', 3000).error, /rejected: nothing was sent/);
  assert.deepEqual(P.open(), []);
  // expired: the bot withdrew it
  P.update(Object.assign({}, p, { id: 'p2' }));
  const end = P.update(Object.assign({}, p, { id: 'p2', state: 'not answered' }));
  assert.equal(end.act, 'end'); assert.equal(end.why, 'not answered');
  assert.equal(P.update(Object.assign({}, p, { id: 'p3' })).act, 'show');
  assert.equal(P.update(Object.assign({}, p, { id: 'p3', state: 'withdrawn' })).why, 'not answered', 'withdrawn reads "not answered"');
  assert.equal(P.shown('p3', 5000), null, 'no botSeen for an ended proposal');
  // ended before this page saw it: logged only, never shown
  assert.equal(P.update(Object.assign({}, p, { id: 'p4', state: 'accepted' })).act, 'none');
  assert.match(P.answer('p4', 'accept', 1).error, /accepted/);
  // bad shapes and answers
  assert.equal(P.update(null).act, 'none');
  assert.equal(P.update({ id: '', state: 'open' }).act, 'none');
  assert.equal(P.update({ id: 'x'.repeat(41), state: 'open' }).act, 'none');
  assert.match(P.answer('p1', 'maybe', 1).error, /accept or reject/);
  assert.match(P.answer('nope', 'accept', 1).error, /No proposal/);
  // a dropped connection clears what this page showed
  P.update(Object.assign({}, p, { id: 'p5' }));
  assert.deepEqual(P.clear().map(x => x.id), ['p5']);
  assert.equal(P.get('p5'), null);
});

test('library: the example file reads whole; shelves; slot by name; conditions rows', () => {
  const r = BC.parseLibrary(read('test', 'fixtures', 'bot-library.json'));
  assert.equal(r.ok, true); assert.equal(r.version, 1); assert.deepEqual(r.problems, []); assert.equal(r.none, false);
  assert.equal(r.bots.length, 4);
  const sh = BC.shelves(r.bots);
  assert.deepEqual(sh.ready.map(b => b.evidence), ['L2', 'L1']);
  assert.ok(sh.research.every(b => b.shelf === 'research'));
  for (const b of r.bots) {
    assert.ok(/^Sample /.test(b.name), 'made-up names only: ' + b.name);
    assert.ok(/made-up/i.test(b.sentence), 'says it is made up');
    assert.ok(b.equity.length === b.stats.trades);
  }
  assert.equal(BC.slotEntry(r.bots, 'sample lantern fade').id, 'sample-lantern-fade', 'name, case ignored');
  assert.equal(BC.slotEntry(r.bots, 'sample-kite-sweep').shelf, 'research', 'or the id');
  assert.equal(BC.slotEntry(r.bots, 'Demo Opening Fade'), null);
  assert.equal(BC.slotEntry(r.bots, ''), null);
  const row = BC.timeOfDayRow([{ key: '10:00', trades: 3, winRate: 0.5, avgR: 0.1 }, { key: '09:30', trades: 30, winRate: 0.6, avgR: 0.4 }, { key: '11:00', trades: 25, winRate: 0.5, avgR: -0.1 }]);
  assert.deepEqual(row.map(c => c.key), ['09:30', '10:00', '10:30', '11:00'], 'every 30 minutes, gaps filled');
  assert.equal(row[2].trades, 0); assert.ok(row[2].gap);
  assert.equal(BC.thinCell(row[1]), true, 'under 20 trades: faded');
  assert.equal(BC.thinCell(row[0]), false);
  assert.equal(BC.thinCell({ trades: 20 }), false);
  assert.deepEqual(BC.ruleLines('1. One\n2) Two\n\n- Three\n  Four  '), ['One', 'Two', 'Three', 'Four']);
  const eq = Array.from({ length: 1000 }, (_, i) => i);
  const th = BC.thinEquity(eq, 50);
  assert.equal(th.length, 50); assert.equal(th[0], 0); assert.equal(th[49], 999);
  assert.deepEqual(BC.thinEquity([1, 2], 50), [1, 2]);
});

test('library: no file, wrong version, not JSON; a bad entry is left out and named, the rest show', () => {
  assert.deepEqual(BC.parseLibrary('not json').problems, ['The library file is not JSON.']);
  assert.equal(BC.parseLibrary('[]').ok, false);
  assert.match(BC.parseLibrary({ version: 2, bots: [] }).problems[0], /version 2; this page reads version 1/);
  assert.match(BC.parseLibrary({ version: 1 }).problems[0], /no bots list/);
  assert.match(BC.parseLibrary({ version: 1, bots: [], extra: 1 }).problems[0], /unknown key "extra"/);
  const empty = BC.parseLibrary({ version: 1, bots: [] });
  assert.equal(empty.ok, true); assert.equal(empty.none, true);
  const bad = (mut, rx) => {
    const doc = clone(LIB); mut(doc.bots[0]);
    const r = BC.parseLibrary(doc);
    assert.equal(r.bots.length, LIB.bots.length - 1, 'one left out: ' + rx);
    assert.match(r.problems[0], rx);
    assert.ok(!r.bots.some(b => b.id === LIB.bots[0].id) || /used twice/.test(r.problems[0]));
  };
  bad(b => { b.evidence = 'L0'; }, /Ready shelf with L0 \(Ready needs L1 or higher\)/);
  bad(b => { b.evidence = 'Level 2'; }, /evidence must be L0 to L9/);
  bad(b => { b.shelf = 'live'; }, /shelf must be "ready" or "research"/);
  bad(b => { b.id = 'has space'; }, /\.id must be/);
  bad(b => { b.name = ''; }, /\.name must be text/);
  bad(b => { b.sentence = 'x'.repeat(241); }, /sentence/);
  bad(b => { b.secret = 'x'; }, /unknown key "secret"/);
  bad(b => { b.stats.winRate = 58.4; }, /winRate must be a number from 0 to 1/);
  bad(b => { delete b.stats.avgR; }, /stats\.avgR is missing/);
  bad(b => { b.stats.extra = 1; }, /stats has an unknown key/);
  bad(b => { b.equity = [1, 'x']; }, /equity must be a list/);
  bad(b => { b.equity = new Array(5001).fill(1); }, /equity must be a list/);
  bad(b => { b.settings = { nested: { a: 1 } }; }, /settings\["nested"\]/);
  bad(b => { b.ruleCard = ''; }, /ruleCard/);
  bad(b => { delete b.conditions.volBand; }, /conditions\.volBand must be a list/);
  bad(b => { b.conditions.extra = []; }, /conditions has an unknown key/);
  bad(b => { b.conditions.timeOfDay[0].key = '09:45'; }, /30-minute window start/);
  bad(b => { b.conditions.dayType[0].trades = -1; }, /trades must be a whole number/);
  bad(b => { b.conditions.levelSide[0].winRate = 2; }, /winRate must be a number from 0 to 1/);
  bad(b => { b.conditions.dayType[0].why = 'x'; }, /unknown key "why"/);
  bad(b => { b.frozen = 'yesterday'; }, /frozen must be a date/);
  bad(b => { b.name = 'Bad\u0007name'; }, /\.name must be text/);
  // a repeated id: the second is left out
  const doc = clone(LIB); doc.bots[1].id = doc.bots[0].id;
  const r = BC.parseLibrary(doc);
  assert.equal(r.bots.length, LIB.bots.length - 1); assert.match(r.problems[0], /used twice/);
  // a research build may be L0; a ready one at L1 is fine
  assert.ok(LIB.bots.some(b => b.shelf === 'research' && b.evidence === 'L0'));
  // nothing of the file is kept by reference
  const src = clone(LIB), got = BC.parseLibrary(src);
  src.bots[0].name = 'changed';
  assert.equal(got.bots[0].name, LIB.bots[0].name);
});

test('day type: every call logged with its time, the last is the current one; a new trading day starts empty', () => {
  const st = memStore();
  let now = Date.parse('2026-10-07T14:05:00Z');                // 10:05 ET
  const D = BC.createDayTypes(st, () => now);
  assert.equal(D.current(), '');
  assert.ok(D.call('Range').call);
  now += 60000; D.call('Trend');
  now += 60000; D.call('Range');
  assert.equal(D.current(), 'Range');
  assert.deepEqual(D.calls().map(c => c.type), ['Range', 'Trend', 'Range']);
  assert.equal(D.calls()[1].at, Date.parse('2026-10-07T14:06:00Z'));
  assert.match(D.call('Sideways').error, /Trend, Range, Gap, Unsure/);
  now = Date.parse('2026-10-07T22:30:00Z');                    // 18:30 ET: the next trading day
  assert.equal(D.current(), ''); assert.deepEqual(D.calls(), []);
  assert.equal(BC.tradeDay(Date.parse('2026-10-07T21:59:00Z')), '2026-10-07');   // 17:59 ET
  assert.equal(BC.tradeDay(Date.parse('2026-10-07T22:00:00Z')), '2026-10-08');   // 18:00 ET
  assert.equal(BC.etClock(Date.parse('2026-10-07T13:47:00Z')), '09:47');
  // blocked storage: says so, never throws
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.match(BC.createDayTypes(blocked, () => now).call('Gap').error, /would not save/);
});

test('log: one entry per key, newest last, kept for the trading day, at most 300', () => {
  const st = memStore();
  let now = Date.parse('2026-10-07T14:00:00Z');
  const L = BC.createLog(st, () => now);
  L.add({ k: 'prop:p1', kind: 'proposal', at: now, text: 'proposed' });
  now += 1000;
  L.add({ k: 'prop:p1', kind: 'proposal', at: now, text: 'accepted in 1.2 s' });
  L.add({ k: 'sig:s1', kind: 'signal', at: now - 5000, text: 'Short' });
  assert.deepEqual(L.list().map(e => e.text), ['Short', 'accepted in 1.2 s'], 'a key replaced, sorted by time, the first time kept');
  for (let i = 0; i < 320; i++) L.add({ k: 'n' + i, kind: 'notice', at: now + i, text: String(i) });
  assert.equal(L.list().length, 300);
  now = Date.parse('2026-10-08T22:01:00Z');
  assert.deepEqual(L.list(), []);
});

test('copilot keys: from The Desk\'s hotkeys document, no default; never a trading key; the two differ', () => {
  const refused = c => (c === 'F5' ? 'kept by the browser' : '');
  assert.deepEqual(BC.answerKeys({ keys: { buy: 'Alt+B', accept: 'Alt+Y', reject: 'Alt+N' } }, {}, refused), { accept: 'Alt+Y', reject: 'Alt+N', notes: [] });
  assert.deepEqual(BC.answerKeys({ keys: { buy: 'Alt+B' } }, {}, refused), { accept: '', reject: '', notes: [] }, 'no default');
  assert.deepEqual(BC.answerKeys(null, {}, refused), { accept: '', reject: '', notes: [] });
  const k = BC.answerKeys({ keys: { accept: 'Alt+B', reject: 'F5' } }, { buy: 'Alt+B' }, refused);
  assert.equal(k.accept, ''); assert.equal(k.reject, '');
  assert.deepEqual(k.notes, ['accept: Alt+B is a trading hotkey here', 'reject: kept by the browser']);
  assert.equal(BC.answerKeys({ keys: { accept: 'Alt+Y', reject: 'Alt+Y' } }, {}, refused).reject, '');
});

test('notices: entry, exit, a rail turning amber or red, stand-down, heartbeat, kill switch', () => {
  const base = { enabled: true, connected: true, name: 'Sample Bot', root: 'MNQ', position: { qty: 0, avgPrice: null }, pnlToday: 0, trades: 3, maxTrades: 5, losses: 1, maxLosses: 3, killed: false, standDown: null };
  const kinds = (a, b) => BC.noticesFrom(a, b, BC.fmtUsd).map(n => n.kind + (n.level ? ':' + n.level : ''));
  assert.deepEqual(kinds(base, Object.assign({}, base, { position: { qty: -1, avgPrice: 25400.25 } })), ['entry']);
  assert.match(BC.noticesFrom(base, Object.assign({}, base, { position: { qty: -1, avgPrice: 25400.25 } }))[0].text, /entered short 1 MNQ at 25400.25/);
  assert.match(BC.noticesFrom(base, Object.assign({}, base, { position: { qty: 1, avgPrice: 25400.25 } }), BC.fmtUsd, p => p.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','))[0].text, /long 1 MNQ at 25,400\.25/, 'prices as the page writes them');
  const inPos = Object.assign({}, base, { position: { qty: -1, avgPrice: 25400.25 } });
  assert.match(BC.noticesFrom(inPos, Object.assign({}, base, { pnlToday: 9 }), BC.fmtUsd)[0].text, /exited; today \+\$9\.00/);
  assert.deepEqual(kinds(base, Object.assign({}, base, { trades: 4 })), ['limit:amber']);
  assert.deepEqual(kinds(Object.assign({}, base, { trades: 4 }), Object.assign({}, base, { trades: 5 })), ['limit:red']);
  assert.deepEqual(kinds(base, Object.assign({}, base, { losses: 3, standDown: '3 losing trades today' })), ['limit:red', 'standDown:red']);
  assert.deepEqual(kinds(base, Object.assign({}, base, { connected: false })), ['heartbeat:red']);
  assert.deepEqual(kinds(Object.assign({}, base, { connected: false }), base), ['heartbeat']);
  assert.deepEqual(kinds(base, Object.assign({}, base, { killed: true })), ['kill:red']);
  assert.deepEqual(kinds(base, base), []);
  assert.deepEqual(BC.noticesFrom(null, base), [], 'the first message is no change');
  // a tightened rail can turn a meter red without a trade: said once
  assert.deepEqual(kinds(base, Object.assign({}, base, { maxTrades: 3 })), ['limit:red']);
});

test('trips: the bot\'s fills as trades for its marks (open, closed, reversed)', () => {
  assert.deepEqual(BC.trips([{ side: 'sell', qty: 1, p: 100, t: 10 }, { side: 'buy', qty: 1, p: 98, t: 20 }]), [{ tIn: 10, pIn: 100, tOut: 20, pOut: 98, dir: -1, qty: 1 }]);
  assert.deepEqual(BC.trips([{ side: 'buy', qty: 1, p: 100, t: 10 }]), [{ tIn: 10, pIn: 100, tOut: null, pOut: null, dir: 1, qty: 1 }]);
  const rev = BC.trips([{ side: 'buy', qty: 1, p: 100, t: 10 }, { side: 'sell', qty: 2, p: 101, t: 20 }, { side: 'buy', qty: 1, p: 99, t: 30 }]);
  assert.deepEqual(rev, [{ tIn: 10, pIn: 100, tOut: 20, pOut: 101, dir: 1, qty: 1 }, { tIn: 20, pIn: 101, tOut: 30, pOut: 99, dir: -1, qty: 1 }]);
  const avg = BC.trips([{ side: 'buy', qty: 1, p: 100, t: 1 }, { side: 'buy', qty: 1, p: 102, t: 2 }, { side: 'sell', qty: 2, p: 103, t: 3 }]);
  assert.deepEqual(avg, [{ tIn: 1, pIn: 101, tOut: 3, pOut: 103, dir: 1, qty: 2 }]);
  assert.deepEqual(BC.trips([null, { side: 'x' }, { side: 'buy', qty: 0, p: 1, t: 1 }]), []);
});

test('formats and the strip', () => {
  assert.equal(BC.fmtR(0.31), '+0.31 R'); assert.equal(BC.fmtR(-0.1, 1), '-0.1 R'); assert.equal(BC.fmtR(0), '0.00 R'); assert.equal(BC.fmtR(null), '');
  assert.equal(BC.fmtPct(0.584), '58.4%');
  assert.equal(BC.fmtUsd(1284.5), '+$1,284.50'); assert.equal(BC.fmtUsd(-12.5), '-$12.50'); assert.equal(BC.fmtUsd(0), '$0.00'); assert.equal(BC.fmtUsd(-0.001), '$0.00');
  assert.equal(BC.positionText({ qty: -1, avgPrice: 25400.25 }, p => p.toFixed(2)), 'Short 1 @ 25400.25');
  assert.equal(BC.positionText({ qty: 0 }), 'Flat');
  const m = BC.stripModel({ enabled: true, connected: true, name: 'Sample Bot', mode: 'copilot', position: { qty: 0 }, pnlToday: 18, trades: 4, maxTrades: 5, losses: 1, maxLosses: 3,
    lastSignal: { at: Date.parse('2026-10-07T14:12:00Z'), action: 'fired', side: 'sell', result: 'proposed', reason: 'x' } });
  assert.equal(m.mode, 'Copilot'); assert.equal(m.pnl, '+$18.00'); assert.equal(m.pnlTone, 'pos'); assert.equal(m.level, 'amber'); assert.equal(m.state, 'on');
  assert.equal(m.last, 'Last signal 10:12 short · proposed');
  assert.equal(BC.stripModel({ enabled: true, connected: false }).state, 'lost');
  assert.equal(BC.stripModel({ enabled: true, connected: true, killed: true }).state, 'killed');
  assert.equal(BC.stripModel({ enabled: false }).state, 'off');
  assert.equal(BC.signalLine({ action: 'skipped', reason: 'Range too wide', result: 'skipped' }).tone, 'skip');
  assert.equal(BC.signalLine({ action: 'fired', side: 'buy', result: 'refused: the kill switch is on', reason: 'r' }).why, 'r (the kill switch is on)');
  assert.match(BC.statusText({ enabled: true, connected: true, lastBeatMs: 6200 }), /late \(6\.2 s\)/);
  assert.match(BC.statusText({ enabled: false }), /off/);
});

test('ghosts and options: per chart, off by default; sound off by default', () => {
  const st = memStore();
  assert.deepEqual(BC.readGhosts(st), {});
  BC.setGhost(st, 'p1', true); BC.setGhost(st, 'p2', true); BC.setGhost(st, 'p1', false);
  assert.deepEqual(BC.readGhosts(st), { p2: true });
  st.setItem(BC.KEYS.ghost, JSON.stringify({ p3: 'yes', '__proto__': true, ok: true }));
  assert.deepEqual(BC.readGhosts(st), { ok: true });
  assert.deepEqual(BC.readOptions(st), { sound: false });
  BC.setOption(st, 'sound', true);
  assert.deepEqual(BC.readOptions(st), { sound: true });
});

test('fake bridge: botRails as ChartBridgeBot.cs SetRails: limits, root, all keys, flat only, the switch; the rails hold', async () => {
  const V = await import('./fake-v3.mjs');
  let clock = 1000000;
  const out = [];
  const conn = { origin: 'http://localhost:8765', authed: false, actions: [], v3: true };
  const desk = new V.OrderDeskV3({ config: { trading: true, tradeAccounts: ['Sim101'], maxQty: { MNQ: 5 }, port: 8765 }, instruments: { MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2 }, NQ: { name: 'NQ 12-26', tick: 0.25, pointValue: 20 } },
    knownAccounts: ['Sim101'], token: 'tok', switches: { bot: true }, accountList: [{ name: 'Sim101', sim: true, balance: 1 }], send: (c, m) => out.push(m), conns: () => [conn], now: () => clock, barTime: () => clock / 1000 });
  desk.tick('MNQ', 25400); desk.tick('NQ', 25400); desk.auth(conn, 'tok'); out.length = 0;
  const act = m => { clock += 150; out.length = 0; desk.handle(conn, m, JSON.stringify(m)); return out.slice(); };
  const why = msgs => (msgs.find(m => m.type === 'reject') || {}).reason || null;
  assert.match(why(act({ type: 'botRails', cid: 'a', maxTrades: 6, maxLosses: 3, root: 'MNQ' })), /^maxTrades must be a whole number from 1 to 5$/);
  assert.match(why(act({ type: 'botRails', cid: 'a', maxTrades: 5, maxLosses: 4, root: 'MNQ' })), /^maxLosses must be a whole number from 1 to 3$/);
  assert.match(why(act({ type: 'botRails', cid: 'a', maxTrades: 5, maxLosses: 3 })), /^root must be MNQ or NQ \(botRoot and its micro\/mini sibling\)$/, 'root is required');
  assert.match(why(act({ type: 'botRails', cid: 'a', maxTrades: 5, maxLosses: 3, root: 'ES' })), /root must be MNQ or NQ/);
  assert.match(why(act({ type: 'botRails', cid: 'a', maxTrades: 3, maxLosses: 2, root: 'MNQ', extra: 1 })), /Unknown key "extra"/);
  const ok = act({ type: 'botRails', cid: 'b', maxTrades: 2, maxLosses: 2, root: 'MNQ' });
  assert.equal(why(ok), null);
  const b = ok.find(m => m.type === 'bot');
  assert.equal(b.maxTrades, 2); assert.equal(b.maxLosses, 2); assert.equal(b.maxQty, 1);
  // kept, not a ceiling: back up to ChartBridge's own limits is accepted
  assert.equal(why(act({ type: 'botRails', cid: 'c', maxTrades: 5, maxLosses: 3, root: 'MNQ' })), null);
  act({ type: 'botRails', cid: 'c2', maxTrades: 2, maxLosses: 2, root: 'MNQ' });
  desk.bot.trades = 2;
  desk.botMessage({ type: 'botHello', name: 'Sample Bot' });
  act({ type: 'botMode', mode: 'auto' });
  desk.botMessage({ type: 'signal', id: 'a1', action: 'fired', side: 'buy', kind: 'market', stopTicks: 8, targetTicks: 8, reason: 'Sample' });
  assert.match(desk.bot.lastSignal.result, /2 trades today/);
  desk.bot.losses = 1;
  act({ type: 'botRails', cid: 'd', maxTrades: 2, maxLosses: 1, root: 'MNQ' });
  assert.match(desk.bot.standDown, /1 losing trades/, 'losses at the lower rail: stood down');
  // the root: its sibling, then the bot's orders go there; a position refuses a change
  desk.bot.trades = 0; desk.bot.losses = 0; desk.bot.standDown = null;
  assert.equal(why(act({ type: 'botRails', cid: 'e', maxTrades: 5, maxLosses: 3, root: 'NQ' })), null);
  assert.equal(desk.botMsg().root, 'NQ');
  desk.botMessage({ type: 'signal', id: 'a2', action: 'fired', side: 'buy', kind: 'market', stopTicks: 8, targetTicks: 8, reason: 'Sample' });
  assert.equal(desk.bot.lastSignal.result, 'placed');
  assert.ok([...desk.orders.values()].some(o => o.account === 'Sim101' && o.state === 'working' && o.root === 'NQ' && o.role === 'stop'), 'the bot\'s stop on NQ');
  assert.match(why(act({ type: 'botRails', cid: 'f', maxTrades: 5, maxLosses: 3, root: 'MNQ' })), /the bot has a position or a working entry: change its rails when it is flat/);
  // what a page sees of the bot's orders (review 2, as ChartBridgeV3.OrderBy): by "bot" on a v3 page, nothing on a v2 page
  const working = [...desk.orders.values()].filter(o => o.account === 'Sim101' && o.state === 'working');
  const seen = working.map(o => desk.orderMsg(o, true)), seen2 = working.map(o => desk.orderMsg(o, false));
  assert.ok(seen.length && seen.every(m => m.by === 'bot' && m.account === 'Sim101' && m.root === 'NQ'), 'v3: the entry and its legs say by bot');
  assert.ok(seen2.every(m => !('by' in m)), 'v2: no by (0.3.8 byte for byte)');
  // the switch off: refused
  const off = new V.OrderDeskV3({ config: { trading: true, tradeAccounts: ['Sim101'], maxQty: {}, port: 8765 }, instruments: { MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2 } },
    knownAccounts: ['Sim101'], token: 'tok', switches: { bot: false }, accountList: [{ name: 'Sim101', sim: true }], send: (c, m) => out.push(m), conns: () => [conn], now: () => clock, barTime: () => clock / 1000 });
  out.length = 0; off.handle(conn, { type: 'botRails', maxTrades: 1, maxLosses: 1, root: 'MNQ' }, '{}');
  assert.match(why(out), /botRails is off \(bot = off in config\.txt\)/);
});

test('files: the Bot tab is installed, loaded in order, and keeps motion off its order surfaces', () => {
  const www = JSON.parse(read('nt8', 'install-files.json')).www.map(f => f.from);
  for (const f of ['live/bot.html', 'live/bot.js', 'live/bot-core.js', 'live/bot.css', 'live/motion.js', 'live/motion.css']) assert.ok(www.includes(f), f + ' is installed');
  const idx = read('live', 'index.html');
  const at = s => idx.indexOf(s);
  assert.ok(at('src="motion.js"') > 0 && at('src="motion.js"') < at('src="bot-core.js"') && at('src="bot-core.js"') < at('src="bot.js"') && at('src="bot.js"') < at('src="workspace.js"'), 'scripts in order');
  assert.ok(at('href="motion.css"') > 0 && at('href="bot.css"') > at('href="motion.css"'));
  for (const id of ['wsBotTab', 'btStrip', 'btView', 'wsMotion']) assert.ok(idx.includes('id="' + id + '"'), id);
  const pop = read('live', 'bot.html');
  for (const f of ['../src/chart-engine.js', 'live.js', 'feed.js', 'pin.js', 'motion.js', 'bot-core.js', 'bot.js']) assert.ok(pop.includes('src="' + f + '"'), 'bot.html loads ' + f);
  const js = read('live', 'bot.js');
  // R3: the kill switch, the mode, position and P&L, the proposals and the chart are never animated
  assert.match(js, /class="bt-kill" data-no-motion/);
  assert.match(js, /class="bt-sec" data-no-motion><span class="bt-cap">Mode/);
  assert.match(js, /class="bt-kv bt-money" data-no-motion/);
  assert.match(js, /data-k="chart" data-no-motion/);
  assert.match(js, /d\.className = 'bt-props'; d\.setAttribute\('data-no-motion', ''\)/);
  // the page never builds an order for the bot: no `order` message anywhere in it
  assert.doesNotMatch(js, /type: 'order'/);
  assert.doesNotMatch(read('live', 'bot-core.js'), /type: 'order'/);
  // no em or en dashes in what Anthony reads
  for (const f of [['live', 'bot.js'], ['live', 'bot-core.js'], ['live', 'bot.css'], ['live', 'bot.html'], ['docs', 'BOT_LIBRARY.md']]) assert.doesNotMatch(read(...f), /[–—]/, f.join('/'));
});

test('engine: ghost trades are drawn faint with no label; an open trade draws its entry only', () => {
  // a stand-in canvas that records the alpha used and the text drawn (as test/perf.test.js's)
  const seen = { alpha: new Set(), text: [], arcs: 0 };
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'fillText') return s => seen.text.push(String(s));
      if (k === 'arc') return () => { seen.arcs++; };
      if (k === 'getLineDash') return () => [];
      return () => {};
    },
    set(t, k, v) { if (k === 'globalAlpha') seen.alpha.add(v); t[k] = v; return true; },
  });
  const element = () => ({
    handlers: {}, style: {}, dataset: {}, hidden: false, textContent: '', tabIndex: -1,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { this.handlers[type] = fn; }, removeEventListener(type) { delete this.handlers[type]; },
    appendChild(c) { return c; }, remove() {}, setAttribute() {}, hasAttribute() { return false; },
    getContext: () => ctx, focus() {}, setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1400, height: 800, right: 1400, bottom: 800 }),
  });
  let frameFn = null;
  const saved = { document: global.document, window: global.window, raf: global.requestAnimationFrame, caf: global.cancelAnimationFrame, Path2D: global.Path2D };
  global.document = { createElement: element, getElementById: () => null, head: { appendChild() {} } };
  global.window = { devicePixelRatio: 1 };
  global.requestAnimationFrame = fn => { frameFn = fn; return 1; };
  global.cancelAnimationFrame = () => { frameFn = null; };
  global.Path2D = class { moveTo() {} lineTo() {} rect() {} closePath() {} arc() {} };
  try {
    delete require.cache[require.resolve('../src/chart-engine.js')];
    const CE = require('../src/chart-engine.js');
    const bars = [];
    for (let i = 0; i < 120; i++) { const c = 25000 + Math.sin(i / 9) * 20; bars.push({ t: 1790000000 + i * 60, o: c - 1, h: c + 3, l: c - 3, c, v: 100, vw: c }); }
    const chart = CE.create(element(), { clock: () => bars[bars.length - 1].t + 30 });
    chart.setBars(bars);
    chart.setLayers({ trades: true });
    const T = i => bars[i].t;
    const draw = list => { chart.setTrades(list); seen.alpha.clear(); seen.text.length = 0; seen.arcs = 0; for (let k = 0; k < 3 && frameFn; k++) { const f = frameFn; frameFn = null; f(1000 + k * 16); } };
    draw([{ tIn: T(100), pIn: 25000, tOut: T(110), pOut: 25002, dir: 1, ghost: true }]);
    assert.ok(seen.alpha.has(0.38), 'faint: ' + [...seen.alpha].join(','));
    assert.ok(!seen.text.some(s => /^\+2\.00/.test(s)), 'no label on a ghost trade');
    draw([{ tIn: T(100), pIn: 25000, tOut: T(110), pOut: 24998.5, dir: 1 }]);
    assert.ok(seen.text.some(s => /^-1\.50/.test(s)), 'a normal trade keeps its label: ' + seen.text.filter(s => /\d\.\d\d/.test(s)).slice(0, 3).join('|'));
    assert.ok(!seen.alpha.has(0.38));
    const arcsWithExit = seen.arcs;
    draw([{ tIn: T(100), pIn: 25000, tOut: null, pOut: null, dir: -1 }]);
    assert.ok(seen.arcs < arcsWithExit, 'an open trade has no exit dot');
    assert.ok(!seen.text.includes('0.00'), 'and no label (an open trade has no result yet)');
  } finally {
    Object.assign(global, { document: saved.document, window: saved.window, requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf, Path2D: saved.Path2D });
    delete require.cache[require.resolve('../src/chart-engine.js')];
  }
});
