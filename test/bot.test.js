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

test('rails change (release 1, step 1.6b): every rail sent, all required, fail closed; the size up to the hard ceiling only', () => {
  const cur = { size: 1, maxTrades: 5, maxLosses: 3, dayLoss: 500, dayProfit: 500, root: 'MNQ', position: { qty: 0, avgPrice: null } };
  const all = (o) => Object.assign({ size: 1, maxTrades: 5, maxLosses: 3, dayLoss: 500, dayProfit: 500 }, o);
  assert.deepEqual(BC.railsChange(cur, all({ size: 5, maxTrades: 8, maxLosses: 4, dayLoss: 250.5, dayProfit: 750 }), 'c1').msg,
    { type: 'botRails', cid: 'c1', size: 5, maxTrades: 8, maxLosses: 4, dayLoss: 250.5, dayProfit: 750, root: 'MNQ' }, 'above the old fixed 5 trades and 3 losses: Anthony sets them');
  assert.deepEqual(BC.railsChange(cur, { size: ' 20', maxTrades: '4', maxLosses: ' 3 ', dayLoss: '300', dayProfit: '412.25' }).msg,
    { type: 'botRails', size: 20, maxTrades: 4, maxLosses: 3, dayLoss: 300, dayProfit: 412.25, root: 'MNQ' }, 'typed text; 20 MNQ is the ceiling');
  assert.deepEqual(BC.railsChange(cur, all({ size: 2, root: 'NQ' })).msg, { type: 'botRails', size: 2, maxTrades: 5, maxLosses: 3, dayLoss: 500, dayProfit: 500, root: 'NQ' }, 'the mini of the bot\'s micro');
  assert.match(BC.railsChange(cur, all({ size: 3, root: 'NQ' })).error, /Size must be a whole number from 1 to 2 for NQ \(the hard ceiling\)/);
  assert.match(BC.railsChange(cur, all({ size: 21 })).error, /from 1 to 20 for MNQ/);
  assert.match(BC.railsChange(cur, all({ root: 'ES' })).error, /root must be MNQ or NQ/);
  for (const k of ['size', 'maxTrades', 'maxLosses', 'dayLoss', 'dayProfit'])
    for (const bad of ['', 0, '0', null, undefined, 'none', -1]) assert.ok(BC.railsChange(cur, all({ [k]: bad })).error, k + ' ' + JSON.stringify(bad) + ' is refused: nothing is "no limit"');
  assert.match(BC.railsChange(cur, all({ maxTrades: 101 })).error, /Trades must be a whole number from 1 to 100/);
  assert.match(BC.railsChange(cur, all({ maxLosses: 2.5 })).error, /whole number/);
  assert.match(BC.railsChange(cur, all({ maxTrades: '1e1' })).error, /whole number/);
  assert.match(BC.railsChange(cur, all({ dayLoss: '12.345' })).error, /The day's loss stop must be dollars above 0, at most 2 decimals/);
  assert.match(BC.railsChange(cur, all({ dayProfit: 0.001 })).error, /The day's profit stop must be dollars/);
  assert.match(BC.railsChange(cur, all({})).error, /Nothing to change/);
  assert.match(BC.railsChange({}, all({})).error, /not known/);
  // rails not set yet (null in the bot message): every one may be set
  const unset = { size: null, maxTrades: null, maxLosses: null, dayLoss: null, dayProfit: null, root: 'MNQ', railsMissing: ['size', 'maxTrades', 'maxLosses', 'dayLoss', 'dayProfit'] };
  assert.deepEqual(BC.railsChange(unset, all({})).msg, { type: 'botRails', size: 1, maxTrades: 5, maxLosses: 3, dayLoss: 500, dayProfit: 500, root: 'MNQ' });
  assert.equal(BC.railsMissingText(unset), 'the size, the trades a day, the losing trades a day, the day\'s loss stop and the day\'s profit stop');
  assert.equal(BC.railsMissingText({ railsMissing: ['dayLoss'] }), 'the day\'s loss stop');
  assert.equal(BC.railsMissingText({ railsMissing: [] }), '');
  assert.deepEqual(BC.HARD_CEILING, { NQ: 2, ES: 2, MNQ: 20, MES: 20 }, 'ChartBridgeAgents.HardCeiling');
  // refused while the bot has a position (ChartBridge refuses it too, and while an entry works)
  assert.match(BC.railsChange(Object.assign({}, cur, { position: { qty: 1, avgPrice: 25400 } }), all({ size: 2 })).error, /has a position/);
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

test('release 1 (the R12 review of the cut): on a ChartBridge before 0.6.24 the Bot tab fails closed: copilot and auto refused, the old rails said', () => {
  const ready = LIB.bots.find(b => b.shelf === 'ready');
  const old = { enabled: true, connected: true, mode: 'shadow', account: 'PERS-1', trades: 0, maxTrades: 5, losses: 0, maxLosses: 3 };   // 0.6.23's bot message: no railsMissing, size or day stops
  const why = 'This ChartBridge (before 0.6.24) has the old fixed rails (1 contract, 5 trades, 3 losing trades, no day stops): install 0.6.24 to arm the bot';
  assert.equal(BC.OLD_RAILS, why);
  assert.equal(BC.oldRails(old), true); assert.equal(BC.oldRails({ railsMissing: [] }), false); assert.equal(BC.oldRails(null), false);
  for (const tradable of [true, false]) {
    const m = BC.modesAllowed({ entry: ready, tradable, account: 'PERS-1', bot: old });
    assert.ok(m.shadow.ok, 'Shadow stays');
    assert.deepEqual(m.copilot, { ok: false, why }); assert.deepEqual(m.auto, { ok: false, why });
  }
  assert.deepEqual(BC.modesAllowed({ entry: null, tradable: true, account: 'PERS-1', bot: Object.assign({}, old, { railsMissing: 'size' }) }).auto, { ok: false, why }, 'a railsMissing that is not a list is the old shape too');
  // no bot message yet: refused as well (fail closed), with its own words
  const none = BC.modesAllowed({ entry: ready, tradable: true, account: 'PERS-1' });
  assert.ok(none.shadow.ok && !none.copilot.ok && !none.auto.ok); assert.match(none.auto.why, /No word yet from ChartBridge's bot channel/);
  // 0.6.24 with every rail set: as before
  const m = BC.modesAllowed({ entry: ready, tradable: true, account: 'PERS-1', bot: Object.assign({}, old, { railsMissing: [] }) });
  assert.ok(m.copilot.ok && m.auto.ok);
  // the panel: the sentence in railMiss, never "Not set" with no warning
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'live', 'bot.js'), 'utf8');
  assert.match(src, /BC\.modesAllowed\(\{ entry: e, tradable: BC\.accountTradable\(S\.accounts, S\.trading, acc\.name\), account: acc\.name, bot: S\.bot \}\)/, 'the panel hands modesAllowed the bot message');
  assert.match(src, /const old = BC\.oldRails\(S\.bot\), miss = old \? '' : BC\.railsMissingText\(b\);/);
  assert.match(src, /put\(q\('\[data-k="railMiss"\]'\), 'textContent', old \? BC\.OLD_RAILS \+ '\.' :/);
  assert.match(src, /put\(q\('\[data-k="railMiss"\]'\), 'hidden', !old && !miss\);/);
});

test('modes: Research builds run in shadow only; auto only when the bot\'s account is tradable (Sim or LIVE); the bot switch', () => {
  const ready = LIB.bots.find(b => b.shelf === 'ready'), research = LIB.bots.find(b => b.shelf === 'research');
  const cur = { railsMissing: [] };   // release 1: a 0.6.24 bot message
  let m = BC.modesAllowed({ entry: ready, tradable: true, account: 'EVAL-A', bot: cur });
  assert.ok(m.shadow.ok && m.copilot.ok && m.auto.ok, 'auto on a LIVE account: allowed when ChartBridge says it is tradable');
  m = BC.modesAllowed({ entry: ready, tradable: false, account: 'EVAL-A', bot: cur });
  assert.ok(m.copilot.ok); assert.equal(m.auto.ok, false); assert.match(m.auto.why, /Auto needs EVAL-A to be tradable/);
  assert.match(BC.modesAllowed({ entry: ready, tradable: false, bot: cur }).auto.why, /None: choose its account first/, 'no account: None (DECISION 2026-10-14e)');
  m = BC.modesAllowed({ entry: research, tradable: true, bot: cur });
  assert.ok(m.shadow.ok); assert.equal(m.copilot.ok, false); assert.equal(m.auto.ok, false); assert.match(m.copilot.why, /Shadow only/);
  m = BC.modesAllowed({ entry: null, tradable: true, bot: cur });
  assert.ok(m.copilot.ok && m.auto.ok, 'a bot not in the library: ChartBridge decides');
  assert.equal(BC.MODE_NAME.auto, 'Auto', 'not "Sim auto": the bot trades the account Anthony chose');
  assert.equal(BC.accountTradable({ list: [{ name: 'Sim101', tradable: true }] }, null), false, 'no account named: None, never tradable (DECISION 2026-10-14e)');
  assert.equal(BC.accountTradable({ list: [{ name: 'Sim101', tradable: true }] }, null, 'Sim101'), true);
  assert.equal(BC.accountTradable({ list: [{ name: 'Sim101', tradable: false }] }, { enabled: true, accounts: ['Sim101'] }, 'Sim101'), false, 'the accounts list wins');
  assert.equal(BC.accountTradable(null, { enabled: true, accounts: ['Sim101'] }, 'Sim101'), true);
  assert.equal(BC.accountTradable(null, { enabled: false, accounts: ['Sim101'] }, 'Sim101'), false);
  assert.equal(BC.accountTradable({ list: [{ name: 'EVAL-A', tradable: true }] }, null, 'EVAL-A'), true);
  assert.equal(BC.botSwitchOn({ enabled: true, switches: { bot: true } }), true);
  assert.equal(BC.botSwitchOn({ enabled: true, switches: { bot: false } }), false);
  assert.equal(BC.botSwitchOn({ enabled: true }), false, 'a v2 answer has no switches: off');
  assert.equal(BC.botSwitchOn({ enabled: false, switches: { bot: true } }), false);
  assert.equal(BC.botSwitchOn({ enabled: true, switches: { bot: 'true' } }), false, 'only true is on');
});

test('the bot\'s account (Anthony 2026-10-07): SIM or LIVE mark, the accounts to choose, the change and its one LIVE question', () => {
  assert.deepEqual(BC.botAccount(null), { name: '', sim: false, mark: '', none: true, label: 'None' }, 'before ChartBridge says: None (DECISION 2026-10-14e), unmarked');
  assert.deepEqual(BC.botAccount({ account: null, sim: false }), { name: '', sim: false, mark: '', none: true, label: 'None' }, 'account null is None');
  assert.deepEqual(BC.botAccount({ account: 'Sim101', sim: true }), { name: 'Sim101', sim: true, mark: 'SIM', none: false, label: 'Sim101' });
  assert.deepEqual(BC.botAccount({ account: 'EVAL-A', sim: false }), { name: 'EVAL-A', sim: false, mark: 'LIVE', none: false, label: 'EVAL-A' });
  const accounts = { list: [
    { name: 'Sim101', sim: true, tradable: true, state: 'active' }, { name: 'EVAL-A', sim: false, tradable: true, state: 'active', personal: true },
    { name: 'FUNDED-B', sim: false, tradable: false, state: 'active' }, { name: 'EVAL-B', sim: false, tradable: false, state: 'gone' }, { name: 'SIM-F1', sim: true, tradable: true, state: 'active' }] };   // release 1 (1.6b): EVAL-A stands in for the personal account
  const bot = { account: 'Sim101', sim: true, position: { qty: 0, avgPrice: null } };
  const ch = BC.accountChoices(accounts, bot);
  assert.deepEqual(ch.map(c => c.name + ' ' + c.mark), ['SIM-F1 SIM', 'Sim101 SIM', 'EVAL-A LIVE'], 'tradable accounts only, each marked, Sim first');
  assert.equal(ch.find(c => c.name === 'Sim101').current, true);
  assert.ok(BC.accountChoices(accounts, { account: 'FUNDED-B', sim: false }).some(c => c.name === 'FUNDED-B' && c.current && !c.tradable), 'the current account is always listed');
  const live = BC.botAccountChange(bot, 'EVAL-A', ch, 'c9');
  assert.deepEqual(live.msg, { type: 'botAccount', cid: 'c9', account: 'EVAL-A' });
  assert.equal(live.live, true); assert.equal(live.confirm, 'The bot will trade LIVE account EVAL-A in Shadow. Continue?', 'a LIVE account: asked once, in the page, naming the mode it keeps');
  assert.equal(BC.botAccountChange(Object.assign({}, bot, { mode: 'auto' }), 'EVAL-A', ch).confirm, 'The bot will trade LIVE account EVAL-A in Auto. Continue?', '1.18.1: the mode named');
  // release 1 (1.6b, Anthony 2026-11-18 "Personal only, Sim later"): a Sim account and an account that is not the personal one are refused
  assert.match(BC.botAccountChange(bot, 'SIM-F1', ch).error, /SIM-F1 is a Sim account: the bot trades your personal account only/);
  assert.match(BC.botAccountChange(bot, 'FUNDED-B', BC.accountChoices(accounts, { account: 'FUNDED-B', sim: false })).error, /FUNDED-B is not your personal account/);
  assert.equal(ch.find(c => c.name === 'EVAL-A').personal, true);
  const notTradable = BC.accountChoices({ list: [{ name: 'EVAL-A', sim: false, tradable: false, state: 'active', personal: true }] }, { account: 'EVAL-A', sim: false });
  assert.match(BC.botAccountChange(bot, 'EVAL-A', notTradable).error, /not tradable/);
  assert.match(BC.botAccountChange(bot, 'Sim101', ch).error, /already the bot's account/);
  assert.match(BC.botAccountChange(Object.assign({}, bot, { position: { qty: 1, avgPrice: 25000 } }), 'EVAL-A', ch).error, /flat/);
  // None (DECISION 2026-10-14e): account null, never a LIVE question; refused while the bot holds a position
  assert.deepEqual(BC.botAccountChange(bot, '', ch, 'c0'), { msg: { type: 'botAccount', cid: 'c0', account: null }, live: false, confirm: '' });
  assert.match(BC.botAccountChange(Object.assign({}, bot, { position: { qty: 1, avgPrice: 25000 } }), '', ch).error, /choose None when it is flat/);
  assert.match(BC.botAccountChange({ account: null }, '', ch).error, /None is already the bot's account/);
  assert.match(BC.botAccountChange(bot, null, ch).error, /Choose an account, or None/);
  assert.equal(BC.accountTradable(accounts, null, ''), false, 'None is never tradable');
  assert.deepEqual(BC.modesAllowed({ tradable: false, account: '', bot: { railsMissing: ['size'] } }).auto, { ok: false, why: 'The bot\'s account is None: choose its account first (nothing trades on None).' });
  const st = BC.stripModel({ enabled: true, connected: true, name: 'Demo', mode: 'auto', account: 'EVAL-A', sim: false, trades: 0, maxTrades: 5, losses: 0, maxLosses: 3 });
  assert.equal(st.account, 'EVAL-A'); assert.equal(st.accountMark, 'LIVE'); assert.equal(st.mode, 'Auto');
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

test('fake bridge: botRails as ChartBridgeBot.cs SetRails (release 1, 1.6b): every rail, fail closed, the hard ceiling, flat only, the switch', async () => {
  const V = await import('./fake-v3.mjs');
  let clock = 1000000;
  const out = [];
  const conn = { origin: 'http://localhost:8765', authed: false, actions: [], v3: true };
  const desk = new V.OrderDeskV3({ config: { trading: true, tradeAccounts: ['Sim101'], maxQty: { MNQ: 1 }, port: 8765 }, botAccount: 'Sim101', botRails: null, instruments: { MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2 }, NQ: { name: 'NQ 12-26', tick: 0.25, pointValue: 20 } },
    knownAccounts: ['Sim101'], token: 'tok', switches: { bot: true }, accountList: [{ name: 'Sim101', sim: true, balance: 1 }], send: (c, m) => out.push(m), conns: () => [conn], now: () => clock, barTime: () => clock / 1000 });
  desk.tick('MNQ', 25400); desk.tick('NQ', 25400); desk.auth(conn, 'tok'); out.length = 0;
  const act = m => { clock += 150; out.length = 0; desk.handle(conn, m, JSON.stringify(m)); return out.slice(); };
  const why = msgs => (msgs.find(m => m.type === 'reject') || {}).reason || null;
  const R = o => Object.assign({ type: 'botRails', cid: 'a', size: 1, maxTrades: 5, maxLosses: 3, dayLoss: 500, dayProfit: 500, root: 'MNQ' }, o);
  // fail closed: no rails set (botRails: null), nothing arms
  assert.deepEqual(desk.botMsg().railsMissing, ['size', 'maxTrades', 'maxLosses', 'dayLoss', 'dayProfit']);
  assert.match(desk.botMsg().standDown, /^the bot's rails are not set: the size, the trades a day, the losing trades a day, the day's loss stop and the day's profit stop/);
  assert.match(why(act({ type: 'botMode', cid: 'm', mode: 'auto' })), /^auto refused: the bot's rails are not set/);
  assert.match(why(act(R({ size: 21 }))), /^size must be a whole number from 1 to 20 for MNQ \(the hard ceiling/);
  assert.match(why(act(R({ size: 3, root: 'NQ' }))), /^size must be a whole number from 1 to 2 for NQ/);
  assert.match(why(act(R({ maxTrades: 101 }))), /^maxTrades must be a whole number from 1 to 100$/);
  assert.match(why(act(R({ maxLosses: 0 }))), /^maxLosses must be a whole number from 1 to 100$/);
  assert.match(why(act(R({ dayLoss: 0 }))), /^dayLoss must be dollars above 0/);
  assert.match(why(act(R({ dayProfit: 1.234 }))), /^dayProfit must be dollars above 0/);
  const noSize = R({}); delete noSize.size;
  assert.match(why(act(noSize)), /^size must be a whole number/, 'size is required');
  assert.match(why(act(R({ root: 'ES' }))), /root must be MNQ or NQ/);
  assert.match(why(act(R({ extra: 1 }))), /Unknown key "extra"/);
  const ok = act(R({ size: 3, maxTrades: 8, maxLosses: 4, dayLoss: 250.5, dayProfit: 750 }));
  assert.equal(why(ok), null);
  const b = ok.find(m => m.type === 'bot');
  assert.equal(b.maxTrades, 8); assert.equal(b.maxLosses, 4); assert.equal(b.size, 3); assert.equal(b.maxQty, 3); assert.equal(b.dayLoss, 250.5); assert.equal(b.dayProfit, 750);
  assert.deepEqual(b.railsMissing, []); assert.equal(b.standDown, null);
  desk.bot.trades = 8;
  desk.botMessage({ type: 'botHello', name: 'Sample Bot' });
  act({ type: 'botMode', mode: 'auto' });
  desk.botMessage({ type: 'signal', id: 'a1', action: 'fired', side: 'buy', kind: 'market', stopTicks: 8, targetTicks: 8, reason: 'Sample' });
  assert.match(desk.bot.lastSignal.result, /8 trades today/);
  // the size: 3 MNQ placed though config.txt's maxQty.MNQ is 1 (the ticket's cap only)
  desk.bot.trades = 0;
  desk.botMessage({ type: 'signal', id: 'a2', action: 'fired', side: 'buy', kind: 'market', stopTicks: 8, targetTicks: 8, reason: 'Sample' });
  assert.equal(desk.bot.lastSignal.result, 'placed');
  assert.ok([...desk.orders.values()].some(o => o.account === 'Sim101' && o.by === 'bot' && o.role === 'entry' && o.qty === 3), 'the bot\'s entry is its size');
  assert.match(why(act(R({}))), /the bot has a position or a working entry: change its rails when it is flat/);
  // what a page sees of the bot's orders (review 2, as ChartBridgeV3.OrderBy): by "bot" on a v3 page, nothing on a v2 page
  const working = [...desk.orders.values()].filter(o => o.account === 'Sim101' && o.state === 'working');
  const seen = working.map(o => desk.orderMsg(o, true)), seen2 = working.map(o => desk.orderMsg(o, false));
  assert.ok(seen.length && seen.every(m => m.by === 'bot' && m.account === 'Sim101' && m.root === 'MNQ'), 'v3: the entry and its legs say by bot');
  assert.ok(seen2.every(m => !('by' in m)), 'v2: no by (0.3.8 byte for byte)');
  // with a personal account named (--personal), the bot's account must be it, never Sim
  const own = new V.OrderDeskV3({ config: { trading: true, tradeAccounts: ['Sim101', 'OWN-1'], maxQty: {}, port: 8765 }, botAccount: 'Sim101', personal: 'OWN-1', instruments: { MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2 } },
    knownAccounts: ['Sim101', 'OWN-1'], token: 'tok', switches: { bot: true }, accountList: [{ name: 'Sim101', sim: true }, { name: 'OWN-1', sim: false }], send: (c, m) => out.push(m), conns: () => [conn], now: () => clock, barTime: () => clock / 1000 });
  assert.match(own.botMsg().standDown, /^Sim101 is a Sim account: the bot trades the personal account only/);
  // the switch off: refused
  const off = new V.OrderDeskV3({ config: { trading: true, tradeAccounts: ['Sim101'], maxQty: {}, port: 8765 }, instruments: { MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2 } },
    knownAccounts: ['Sim101'], token: 'tok', switches: { bot: false }, accountList: [{ name: 'Sim101', sim: true }], send: (c, m) => out.push(m), conns: () => [conn], now: () => clock, barTime: () => clock / 1000 });
  out.length = 0; off.handle(conn, R({}), '{}');
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

test('ruling B (Anthony 2026-11-18): the Bot tab\'s standing line while ChartBridge\'s owner guard blocks entries', () => {
  const w = 'waiting: you hold your own position or order (OWN-1 MNQ holds 1 contract long that is not the bot\'s)';
  assert.equal(BC.ownerWaitText({ mode: 'auto', ownerWait: w }), 'Waiting: you hold your own position or order (OWN-1 MNQ holds 1 contract long that is not the bot\'s). The bot makes no entry until it is clear.');
  assert.equal(BC.ownerWaitText({ mode: 'copilot', ownerWait: w }).startsWith('Waiting: you hold your own position or order'), true);
  assert.equal(BC.ownerWaitText({ mode: 'shadow', ownerWait: w }), '', 'Shadow: no line');
  assert.equal(BC.ownerWaitText({ mode: 'auto', ownerWait: null }), '');
  assert.equal(BC.ownerWaitText({ mode: 'auto' }), '', 'an older ChartBridge sends no ownerWait');
  assert.equal(BC.ownerWaitText(null), '');
  const js = require('fs').readFileSync(require('path').join(__dirname, '..', 'live', 'bot.js'), 'utf8');
  assert.match(js, /data-k="ownerWait" role="note" hidden/);
  assert.match(js, /const ow = BC\.ownerWaitText\(b\);/);
});
