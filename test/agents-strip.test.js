// The Agents strip (chart 1.36.0, Anthony 2026-10-22): live/agents-strip.js's pure part (AgentsStripCore): the derived look cap,
// the mode labels, "not reported" for what nobody reports, the seats' cards from a SAMPLE league day (made up here: no real
// league, no model name, no account) and a made-up live agent's card. Plus the page: the panel in + Add panel, one a layout,
// installed, read only.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../live/agents-strip.js');
const L = require('../live/league.js');
const W = require('../live/workspace.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const T0 = Date.parse('2026-10-22T10:00:00Z');        // the league's clock: New York wall time as if UTC
const min = m => T0 + m * 60000;
const look = (seat, t, extra) => Object.assign({ id: seat + '-' + t, seat, t, time: new Date(t).toISOString().slice(11, 19), call_ok: true, refused: null, answer: { action: 'pass', confidence: 0.4, reasoning: 'Sample: no edge here' } }, extra || {});

test('the look cap is derived from the seat\'s decisions in any 60 minutes, as the league counts them', () => {
  /* 30 looks a minute apart from 09:34 to 10:03: at 10:04 the cap holds; the next look when the oldest (09:34) is an hour old */
  const ds = []; for (let i = 0; i < 30; i++) ds.push(look('H', min(-26 + i)));
  ds.push(look('S', min(1)));
  const c = A.lookCap(ds, 'H', min(4));
  assert.equal(c.capped, true); assert.equal(c.n, 30);
  assert.equal(A.clock(c.nextMs), '10:34');
  assert.match(c.text, /^30 counted looks in the last hour, next look 10:34$/);
  assert.equal(A.lookCap(ds, 'S', min(4)).capped, false, 'another seat is not capped');
  assert.equal(A.lookCap(ds.slice(1), 'H', min(4)).capped, false, '29 looks: not capped');
  assert.equal(A.lookCap(ds, 'H', min(35)).capped, false, 'an hour after the oldest: free again');
  /* 34 looks in the hour: the next is when the 30th newest is an hour old */
  const more = []; for (let i = 0; i < 34; i++) more.push(look('O', min(-50 + i)));
  assert.equal(A.clock(A.lookCap(more, 'O', min(-15)).nextMs), '10:14', 'the fifth oldest (09:14) an hour on');
  assert.equal(A.lookCap(ds, 'H', null).capped, false, 'no clock: nothing claimed');
  assert.equal(A.lookCap(null, 'H', min(4)).n, 0);
});

test('the look cap counts as the league does: a look at Anthony\'s new entry is never counted (Amendment 7)', () => {
  /* 30 clock looks and 5 looks at his new entry in the hour: still 30 counted */
  const ds = []; for (let i = 0; i < 30; i++) ds.push(look('H', min(-26 + i), { trigger: i % 2 ? 'the 5 minute look' : 'a reaction at IBH' }));
  for (let i = 0; i < 5; i++) ds.push(look('H', min(-50 + i), { trigger: 'a new mentor entry: long MNQ at 09:1' + i }));
  const c = A.lookCap(ds, 'H', min(4));
  assert.equal(c.n, 30); assert.equal(c.capped, true);
  assert.equal(A.clock(c.nextMs), '10:34', 'the oldest counted look (09:34) an hour on, not a mentor look\'s time');
  /* 25 counted and 10 mentor looks: not capped (the old count said 35) */
  const mix = []; for (let i = 0; i < 25; i++) mix.push(look('S', min(-30 + i)));
  for (let i = 0; i < 10; i++) mix.push(look('S', min(-4 + i), { trigger: 'a new mentor entry: short MNQ at 10:0' + i }));
  assert.equal(A.lookCap(mix, 'S', min(6)).capped, false); assert.equal(A.lookCap(mix, 'S', min(6)).n, 25);
  /* the runner's own rule: look_kind first, then the trigger */
  assert.equal(A.lookKind({ look_kind: 'mentor', trigger: 'the 5 minute look' }), 'mentor');
  assert.equal(A.lookKind({ look_kind: 'clock', trigger: 'a new mentor entry: long MNQ' }), 'clock', 'look_kind wins, as in _look_kind');
  assert.equal(A.lookKind({ trigger: 'a new mentor entry: long MNQ at 10:01' }), 'mentor');
  assert.equal(A.lookKind({ trigger: 'his new mentor entry' }), 'clock', 'only a trigger that starts with it');
  assert.equal(A.lookKind({}), 'clock');
  assert.equal(A.lookCap(ds.map(d => Object.assign({}, d, { look_kind: d.trigger.startsWith('a new') ? 'mentor' : 'clock' })), 'H', min(4)).n, 30);
});

test('open R is on the trade\'s ORIGINAL risk: right at break-even and after the trail, never on the stop now', () => {
  const at = (stopPx, last, open) => { const d = sampleDay(); d.status.seats.S.position.stop_px = stopPx; d.status.seats.S.position.id = 's1'; if (open) Object.assign(d.open[0], open); d.open[0].stopPx = stopPx; return A.seatCards(d, { nowMs: min(5), last, pv: 2 })[1].position; };
  /* break-even: the stop at the fill (24000); 10 points up on 3 MNQ is still +0.40 R of the $150 risk, not "not reported" */
  const be = at(24000, 24010);
  assert.equal(be.open.text, 'open +$60.00 · +0.40 R', 'break-even');
  assert.equal(be.stops, 'stop 10 pt · target 40 pt', 'the stop distance now is still shown, from the price');
  /* the trail: the stop at 24030, 40 points up: +1.60 R of the original risk (the stop now would say 4.00 R) */
  assert.equal(at(24030, 24040).open.text, 'open +$240.00 · +1.60 R', 'after the trail');
  /* no risk_dollars: the stop distance at the fill (25 points) */
  assert.equal(at(24030, 24040, { riskDollars: null }).open.text, 'open +$240.00 · +1.60 R', 'from stop_points');
  assert.match(at(24030, 24040, { riskDollars: null }).open.title, /open points over the stop distance at the fill \(25 pt\)/);
  /* neither: R not reported, never the stop now */
  assert.equal(at(24030, 24040, { riskDollars: null, stopPoints: null }).open.text, 'open +$240.00 · R not reported');
  /* status.json's position from another trade than The Desk's open one: its risk is not borrowed */
  assert.equal(at(24000, 24010, { id: 'other' }).open.text, 'open +$60.00 · R not reported');
  /* a live agent with no plan risk: not reported, never from its stop order */
  const a = { agent: 'demo', name: 'Demo Agent', mode: 'shadow', connected: true, position: { qty: 1, root: 'MNQ', avgPrice: 24000 } };
  const c = A.agentCard(a, { orders: [{ role: 'stop', root: 'MNQ', price: 24000 }], openRisk: null }, { last: () => 24010, pv: () => 2 });
  assert.equal(c.position.open.text, 'open +$20.00 · R not reported');
  assert.deepEqual(L.cleanTrade({ id: 'x', seat: 'H', side: 'long', fill_t: 1, fill_px: 1, risk_dollars: 150, stop_points: 25 }, true).riskDollars, 150);
  assert.equal(L.cleanTrade({ id: 'x', seat: 'H', side: 'long', fill_t: 1, fill_px: 1, risk_dollars: 0 }, true).riskDollars, null);
});

test('the mode, big: SHADOW or LIVE only (Anthony 2026-10-22); the account kind under LIVE; never COPILOT, AUTO or SIM big', () => {
  assert.deepEqual(A.seatMode(), { word: 'SHADOW', sub: 'paper: no orders', kind: 'shadow' });
  assert.equal(A.agentMode({ mode: 'shadow', account: 'X', sim: false }).word, 'SHADOW', 'Shadow on any account places nothing');
  assert.deepEqual(A.agentMode({ mode: 'auto', account: 'X', sim: true }), { word: 'LIVE', sub: 'sim', kind: 'live' }, 'promoted, on a Sim account: LIVE, sim under it');
  assert.deepEqual(A.agentMode({ mode: 'copilot', account: 'X', sim: false }), { word: 'LIVE', sub: 'not Sim: eval or funded', kind: 'live' });
  assert.equal(A.agentMode({ mode: 'auto', account: 'X' }).sub, 'account kind not reported');
  assert.deepEqual(A.agentMode({ mode: 'auto', account: '' }), { word: 'SHADOW', sub: 'account None: no orders', kind: 'shadow' }, 'no account: nothing trades');
  assert.match(A.agentMode({}).sub, /mode not reported/);
  for (const a of [{ mode: 'auto', account: 'X', sim: true }, { mode: 'copilot', account: 'X', sim: false }, { mode: 'auto' }, { mode: 'copilot', account: 'X' }, {}]) {
    const m = A.agentMode(a);
    assert.ok(['SHADOW', 'LIVE', '?'].includes(m.word), m.word);
    assert.doesNotMatch(m.word + ' ' + m.sub, /copilot|auto/i, 'never the Copilot or Auto word');
  }
});

test('a thought: time, action, confidence, the first line of its reasoning; the whole reasoning for the click', () => {
  const t = A.thoughtOf(look('O', min(1), { answer: { action: 'rest', side: 'short', stop_points: 6, target_points: 15, reference: 'IBL', confidence: 0.55, reasoning: 'Sample: retest of the level from below\nsecond line' }, contracts: 12 }));
  assert.equal(t.action, 'rest'); assert.equal(t.conf, '0.55'); assert.equal(t.time, '10:01');
  assert.equal(t.line, 'Sample: retest of the level from below');
  assert.match(t.full, /^short, 12 MNQ, stop 6 pt, target 15 pt, at IBL, good until not reported\n\nSample: retest of the level from below\nsecond line$/);
  assert.equal(A.thoughtOf(look('H', min(1), { call_ok: false })).action, 'failed');
  assert.match(A.thoughtOf(look('H', min(1), { refused: 'stop wider than 25 points' })).line, /^refused: stop wider/);
  assert.equal(A.thoughtOf(look('H', min(1), { answer: { action: 'pass' } })).conf, '', 'no confidence: none shown');
  assert.equal(A.firstLine('a / b'), 'a', 'the runner\'s " / " is a line break');
  assert.ok(A.firstLine('x'.repeat(300)).length <= 140);
  const list = [look('H', min(1)), look('S', min(2)), look('H', min(3), { answer: { action: 'enter', confidence: 0.7, reasoning: 'Sample: go' } })];
  assert.deepEqual(A.seatThoughts(list, 'H').map(x => x.action), ['enter', 'pass'], 'newest first');
});

/* a SAMPLE league day as The Desk serves it (made up) */
function sampleDay() {
  return L.cleanDay({ date: '2026-10-22', folder: { set: true }, day: { closed: false },
    status: { date: '2026-10-22', now: '10:05:00', feed: 'live', seats: {
      H: { status: 'active', decisions: 30, entries: 0, account: undefined, flex: { phase: 'eval', balance: 50000, today_pnl: 0, room_to_floor: 2000 }, position: null },
      S: { status: 'active', decisions: 12, flex: { phase: 'eval', balance: 49980, today_pnl: -20 }, position: { side: 'long', contracts: 3, fill_px: 24000, stop_px: 23975, target_px: 24050, fill_time: '09:58:10' } },
      O: { status: 'active', decisions: 11, flex: { phase: 'eval', balance: 49838, today_pnl: -162, room_to_floor: 1838 }, position: null } },
      spend: { day_spent: 1.61, day_cap: 9.5, coach_reserve: 1, seats: { H: 0.5, S: 0.4, O: 0.71 }, calls_today: 53, stopped: null } },
    trades: [{ id: 'o1', seat: 'O', side: 'short', contracts: 12, fill_t: min(-40), fill_px: 24010, stop_px: 24016, target_px: 23995, exit_t: min(-39), exit_px: 24016, r: -1.13 }],
    open: [{ id: 's1', seat: 'S', side: 'long', contracts: 3, fill_t: min(-7), fill_px: 24000, stop_px: 23975, target_px: 24050, stop_points: 25, risk_dollars: 150 }],
    decisions: Array.from({ length: 30 }, (_, i) => look('H', min(-25 + i))).concat([look('O', min(-41), { answer: { action: 'rest', side: 'short', confidence: 0.55, reasoning: 'Sample: retest' } })]) });
}

test('the seats\' cards: one flat at the look cap, one with an open paper trade, one with a closed loss; what is not there says not reported', () => {
  const cards = A.seatCards(sampleDay(), { nowMs: min(5), last: 24010, pv: 2 });
  assert.deepEqual(cards.map(c => c.letter + ' ' + c.name + ' ' + c.color), ['H Haiku #FFC266', 'S Sonnet #5DE0F0', 'O Opus #B69CFF']);
  assert.ok(cards.every(c => c.mode.word === 'SHADOW'));
  const [h, s, o] = cards;
  assert.equal(h.state.word, 'look cap'); assert.match(h.state.why, /next look 10:35.*worked out on this page/);
  assert.equal(h.position.head, 'Flat');
  assert.equal(h.position.rest, 'resting order: not reported', 'no resting field from The Desk: not reported');
  assert.equal(h.today.room, '$2,000.00 to the floor');
  assert.equal(s.state, null);
  assert.equal(s.position.head, 'LONG 3 MNQ'); assert.equal(s.position.since, '09:58');
  assert.equal(s.position.open.text, 'open +$60.00 · +0.40 R', '10 points on 3 MNQ at $2; R on the trade\'s $150 risk at the fill');
  assert.match(s.position.open.title, /R: open P&L over the trade's risk at the fill, gross: before the round-turn fees .*\(\$150\.00\)$/, 'the hover says gross');
  assert.equal(s.position.stops, 'stop 35 pt · target 40 pt');
  assert.equal(o.today.usd, -162); assert.equal(o.today.r, -1.13); assert.equal(o.today.n, 1); assert.equal(o.today.losses, 1);
  assert.equal(o.today.room, '$1,838.00 to the floor');
  assert.equal(s.today.room, 'room to the floor not reported');
  assert.equal(h.today.r, 0, 'no trade yet: 0 R, not "not reported"');
  assert.equal(o.spend.line1, '$0.71 seat · seats $1.61 of $8.50', 'the pool: the day cap less the coach\'s reserve');
  assert.equal(o.spend.line2, 'day $1.61 of $9.50 · 11 calls');
  assert.equal(o.thoughts[0].action, 'rest');
  /* no price on the page: open P&L not reported, the distances from the fill */
  const s2 = A.seatCards(sampleDay(), { nowMs: min(5), last: null })[1];
  assert.equal(s2.position.open.text, 'open P&L not reported'); assert.equal(s2.position.stops, 'stop 25 pt · target 50 pt from the fill');
});

test('a seat\'s resting order once The Desk passes the league\'s field on: side, level, stop and target, time left', () => {
  const d = sampleDay();
  d.status.seats.O.resting = { id: 'o-R', side: 'short', type: 'limit', price: 24020.5, stop_points: 6, target_points: 15, good_until: '10:20:00', triggered: false };
  d.status.seats.H.resting = null;
  const cards = A.seatCards(d, { nowMs: min(5), last: null });
  assert.equal(cards[2].position.rest, 'resting short limit at 24,020.50, stop 6 pt, target 15 pt until 10:20 (15 min left)');
  assert.equal(cards[0].position.rest, '', 'null: no resting order, nothing said');
  assert.equal(cards[1].position.rest, 'resting order: not reported', 'the field absent: not reported');
  assert.equal(A.seatRest({ resting: { side: 'long', type: 'stop', price_ref: 'IBH' } }, '2026-10-22', min(5)), 'resting long stop at IBH, time left not reported');
});

test('the seats\' one word: API stopped, day stopped, day closed, feed down, status late; nothing reported', () => {
  const at = (mut, now) => { const d = sampleDay(); mut(d); return A.seatCards(d, { nowMs: now || min(5), last: null }); };
  assert.equal(at(d => { d.status.seats.S.api_stopped = 'the daily cap is reached'; })[1].state.word, 'API stopped');
  assert.ok(at(d => { d.status.spend.stopped = 'the daily cap of $9.50 is reached'; }).every(c => c.state.word === 'API stopped'));
  assert.equal(at(d => { d.status.seats.O.stopped = 'daily loss limit'; })[2].state.word, 'day stopped');
  assert.ok(at(d => { d.day.closed = true; }).every(c => c.state.word === 'day closed'), 'after the close no look cap is claimed');
  assert.equal(at(d => { d.status.feed = 'reconnecting'; })[1].state.word, 'feed down');
  assert.equal(at(() => {}, min(9))[1].state.word, 'status late', 'status.json four minutes behind');
  const none = A.seatCards(L.cleanDay({ date: '2026-10-22', status: { seats: {} }, decisions: [] }), { nowMs: min(5) });
  assert.ok(none.every(c => c.state.word === 'not reported' && c.position.head === 'not reported' && c.spend.line1 === 'spend not reported'));
});

test('a live agent\'s card: from its agent message and the Agent tab\'s glance; what neither holds says not reported', () => {
  const a = { agent: 'demo', name: 'Demo Agent', mode: 'shadow', connected: true, account: 'SIM-AG1', sim: true, position: { qty: -2, root: 'MNQ', avgPrice: 24020 } };
  const g = { stream: [{ key: 'n1', at: 1, time: '10:04:30', tag: 'THINKING', text: 'Sample: waiting for the retest', full: 'Sample: waiting for the retest of the made-up level' }],
    exits: [{ pnl: 40 }, { pnl: -10 }], totalR: 0.5, openRisk: 48, sinceText: '10:01:00', orders: [{ role: 'stop', root: 'MNQ', price: 24032 }, { role: 'entry', side: 'buy', qty: 1, root: 'MNQ', kind: 'limit', price: 23990 }], spend: null };
  const c = A.agentCard(a, g, { last: () => 24010, pv: () => 2 });
  assert.equal(c.mode.word, 'SHADOW'); assert.equal(c.state, null);
  assert.equal(c.position.head, 'SHORT 2 MNQ'); assert.equal(c.position.since, '10:01');
  assert.equal(c.position.open.text, 'open +$40.00 · +0.83 R', 'R on the plan\'s risk');
  assert.equal(c.position.stops, 'stop 22 pt · target not reported');
  assert.match(c.position.rest, /^resting buy 1 MNQ limit at 23,990.00 \(time left not reported\)$/);
  assert.equal(c.today.usd, 30); assert.equal(c.today.wins, 1); assert.equal(c.today.losses, 1);
  assert.equal(c.spend.line1, 'spend not reported');
  assert.equal(c.thoughts[0].action, 'think', 'the tag short enough for its column');
  assert.equal(A.agentCard(Object.assign({}, a, { connected: false }), g, {}).state.word, 'not connected');
  assert.equal(A.agentCard(Object.assign({}, a, { killed: true }), g, {}).state.word, 'killed');
  assert.equal(A.agentActive({ agent: 'x', connected: false }, null), false, 'an off, empty slot: no card');
  assert.equal(A.agentActive({ agent: 'x', connected: false, killed: true }, null), true);
  assert.equal(A.idleLine(['workspare']), '1 agent slot is off and empty: workspare');
});

test('the bot\'s card (the Bot panel merged in): its mode, account kind, position, P&L, rails and bot.js\'s own red alert', () => {
  const strip = { name: 'Demo Opening Fade', trades: { used: 1, max: 3, level: 'ok' }, losses: { used: 1, max: 2, level: 'amber' }, level: 'amber', last: 'Last signal 10:31 short fade' };
  const bot = { enabled: true, connected: true, mode: 'auto', account: 'SIM-1', sim: true, root: 'MNQ', position: { qty: -1, avgPrice: 24000 }, pnlToday: -12.5, trades: 1, losses: 1, killed: false };
  const c = A.botCard({ offered: true, on: true, bot, alert: false, status: 'Watching', strip }, { last: () => 24010, pv: () => 2 });
  assert.equal(c.key, 'bot'); assert.equal(c.name, 'Demo Opening Fade');
  assert.deepEqual([c.mode.word, c.mode.sub], ['LIVE', 'sim']);
  assert.equal(c.state, null); assert.equal(c.alert, false);
  assert.equal(c.position.head, 'SHORT 1 MNQ'); assert.equal(c.position.open.text, 'open -$20.00 · R not reported');
  assert.equal(c.today.usd, -12.5); assert.equal(c.today.losses, 1); assert.equal(c.today.account, 'Sim account');
  assert.equal(c.spend.label, 'Rails'); assert.equal(c.spend.line1, 'trades 1 of 3 · losing 1 of 2'); assert.equal(c.spend.level, 'amber');
  const killed = A.botCard({ offered: true, on: true, bot: Object.assign({}, bot, { killed: true }), alert: true, status: 'Kill switch on: no bot orders', strip }, {});
  assert.equal(killed.state.word, 'killed'); assert.equal(killed.alert, true, 'the alert as bot.js says it');
  assert.equal(A.botCard({ offered: true, on: true, bot: Object.assign({}, bot, { connected: false }), alert: true, strip }, {}).state.word, 'not connected');
  assert.equal(A.botCard({ offered: true, on: true, bot: Object.assign({}, bot, { standDown: '2 losing trades today' }), alert: true, strip }, {}).state.word, 'stood down');
  assert.equal(A.botCard({ offered: true, on: true, bot, alert: true, strip: Object.assign({}, strip, { level: 'red' }) }, {}).state.word, 'rails red');
  assert.equal(A.botCard({ offered: true, on: false, bot: null, alert: false, status: 'The bot channel is off on this PC' }, {}).state.word, 'off', 'channel off: a card still, the way to the Bot view');
  assert.equal(A.botCard({ offered: false }, {}), null, 'not offered (no v3 ChartBridge): no card');
  assert.equal(A.botCard(null), null);
  assert.equal(A.botCard({ offered: true, on: true, bot: Object.assign({}, bot, { mode: 'shadow' }), strip }, {}).mode.word, 'SHADOW');
  const src = read('live/bot.js');
  assert.match(src, /tog\(tabBtn, 'bt-alert', alertNow\(\)\)/, 'the button and the card read one alert rule');
  assert.match(src, /alert: !!alertNow\(\)/);
});

test('the page: Agents in + Add panel, one a layout, installed, read only, no dashes, no green or red but P&L and sides', () => {
  const html = read('live/index.html');
  assert.match(html, /data-add="agents"[^>]*>Agents<\/button>/);
  assert.ok(html.indexOf('<script src="agents-strip.js"></script>') < html.indexOf('<script src="workspace.js"></script>'));
  assert.ok(html.indexOf('<script src="league.js"></script>') < html.indexOf('<script src="agents-strip.js"></script>'));
  assert.ok(W.TYPES.includes('agents') && !W.TYPES.includes('bot'));
  assert.doesNotMatch(html, /data-add="bot"/, 'no Bot panel: merged into the strip');
  const ws0 = read('live/workspace.js');
  assert.match(ws0, /const where = !btn\.hidden \? \$\('wsTabSlot'\) : \$\('wsTabHold'\);/, 'the Bot button in the top bar on every layout (only a hidden one waits in the hold)');
  const two = W.cleanLayout({ panels: [{ id: 'a1', type: 'agents', x: 0, y: 3, w: 9, h: 3 }, { id: 'a2', type: 'agents', x: 9, y: 3, w: 3, h: 3 }] });
  assert.deepEqual(two.panels.map(p => p.id), ['a1'], 'one Agents strip a layout');
  const files = JSON.parse(read('nt8/install-files.json'));
  assert.ok(files.www.some(x => x.from === 'live/agents-strip.js') && files.www.some(x => x.from === 'live/agents-strip.css'));
  const src = read('live/agents-strip.js');
  assert.doesNotMatch(src, /\.send\(|\.post\(|fetch\(|method: ?'(POST|PUT)'|type: ?'(order|change|cancel|flatten|plan|agent[A-Z]\w*)'/, 'reads only: no request and no message of its own');
  assert.doesNotMatch(src, /setInterval|setTimeout/, 'no poller of its own');
  const ws = read('live/workspace.js');
  assert.match(ws, /day: \(\) => leagueGhostDay\(\)/, 'the strip reads the workspace\'s one league read');
  assert.equal((ws.match(/'\/api\/chart-league'/g) || []).length, 1, 'the workspace still asks The Desk for the league in one place');
  /* review: one fills read a tick for every agent; the league read gives up after 10 s; the League view's close never starts a second read */
  assert.match(ws, /agents: \(\) => \(agentDesk && agentDesk\.glances \? agentDesk\.glances\(\)/, 'the strip asks for every agent\'s glance at once');
  assert.match(read('live/agent.js'), /glances: \(\) => \{ const f = fillsDay\(\), r = risksDay\(\); return agents\.ids\(\)\.map\(id => glanceOf\(id, f, r\)\)/, 'one read of the day\'s fills for all');
  assert.match(ws, /const LG_TIMEOUT_MS = 10000;/); assert.match(ws, /Promise\.race\(\[limit, /); assert.match(ws, /clearTimeout\(giveUp\); LG\.busy = false;/);
  assert.match(ws, /if \(!on\) \{ if \(leagueView\.day\(\)\) LG\.day = leagueView\.day\(\); if \(!LG\.busy\) leaguePoll\(\); \}/, 'the League view\'s close guarded by busy');
  assert.match(src, /if \(drawn \|\| !ro\) fitThoughts\(\);/, 'the stream fit only when a card was drawn or the size changed');
  for (const f of ['live/agents-strip.js', 'live/agents-strip.css', 'test/agents-strip.test.js', 'test/agents-strip-smoke.mjs']) assert.doesNotMatch(read(f), /[\u2013\u2014]/, f + ': no em or en dashes');
  const css = read('live/agents-strip.css');
  assert.doesNotMatch(css, /crimson|#9F1239|#E0445E/i, 'no crimson');
  const greenRed = css.split('\n').filter(l => /--ws-buy|--ws-sell/.test(l));
  assert.ok(greenRed.length && greenRed.every(l => /\.as-side\.(long|short)|\.as-pnl\.(up|down)|\.as-alert|\.as-state\.red/.test(l)), 'green and red only for the side, P&L and the bot\'s red alert (the Bot button\'s own look)');
  assert.doesNotMatch(css, /transition:(?!\s*none)|animation:(?!\s*none)|@keyframes/, 'no motion (R3)');
});
