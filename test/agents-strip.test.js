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
  assert.match(c.text, /^30 looks in the last hour, next look 10:34$/);
  assert.equal(A.lookCap(ds, 'S', min(4)).capped, false, 'another seat is not capped');
  assert.equal(A.lookCap(ds.slice(1), 'H', min(4)).capped, false, '29 looks: not capped');
  assert.equal(A.lookCap(ds, 'H', min(35)).capped, false, 'an hour after the oldest: free again');
  /* 34 looks in the hour: the next is when the 30th newest is an hour old */
  const more = []; for (let i = 0; i < 34; i++) more.push(look('O', min(-50 + i)));
  assert.equal(A.clock(A.lookCap(more, 'O', min(-15)).nextMs), '10:14', 'the fifth oldest (09:14) an hour on');
  assert.equal(A.lookCap(ds, 'H', null).capped, false, 'no clock: nothing claimed');
  assert.equal(A.lookCap(null, 'H', min(4)).n, 0);
});

test('the mode, big: a seat is SHADOW; a live agent SHADOW, SIM, LIVE, or its mode on no account; not reported otherwise', () => {
  assert.deepEqual(A.seatMode(), { word: 'SHADOW', sub: 'paper: no orders', kind: 'shadow' });
  assert.equal(A.agentMode({ mode: 'shadow', account: 'X', sim: false }).word, 'SHADOW', 'Shadow on any account places nothing');
  assert.equal(A.agentMode({ mode: 'auto', account: 'X', sim: true }).word, 'SIM');
  assert.equal(A.agentMode({ mode: 'copilot', account: 'X', sim: true }).sub, 'Copilot on a Sim account');
  const live = A.agentMode({ mode: 'auto', account: 'X', sim: false });
  assert.equal(live.word, 'LIVE'); assert.equal(live.kind, 'live');
  assert.equal(A.agentMode({ mode: 'auto', account: '' }).word, 'AUTO');
  assert.match(A.agentMode({ mode: 'auto', account: '' }).sub, /None: nothing trades/);
  assert.match(A.agentMode({ mode: 'auto', account: 'X' }).sub, /account kind not reported/);
  assert.match(A.agentMode({}).sub, /mode not reported/);
});

test('a thought: time, action, confidence, the first line of its reasoning; the whole reasoning for the click', () => {
  const t = A.thoughtOf(look('O', min(1), { answer: { action: 'rest', side: 'short', stop_points: 6, target_points: 15, reference: 'IBL', confidence: 0.55, reasoning: 'Sample: retest of the level from below\nsecond line' }, contracts: 12 }));
  assert.equal(t.action, 'rest'); assert.equal(t.conf, '0.55'); assert.equal(t.time, '10:01');
  assert.equal(t.line, 'Sample: retest of the level from below');
  assert.match(t.full, /^short, 12 MNQ, stop 6 pt, target 15 pt, at IBL\n\nSample: retest of the level from below\nsecond line$/);
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
    open: [{ id: 's1', seat: 'S', side: 'long', contracts: 3, fill_t: min(-7), fill_px: 24000, stop_px: 23975, target_px: 24050 }],
    decisions: Array.from({ length: 30 }, (_, i) => look('H', min(-25 + i))).concat([look('O', min(-41), { answer: { action: 'rest', side: 'short', confidence: 0.55, reasoning: 'Sample: retest' } })]) });
}

test('the seats\' cards: one flat at the look cap, one with an open paper trade, one with a closed loss; what is not there says not reported', () => {
  const cards = A.seatCards(sampleDay(), { nowMs: min(5), last: 24010, pv: 2 });
  assert.deepEqual(cards.map(c => c.letter + ' ' + c.name + ' ' + c.color), ['H Haiku #FFC266', 'S Sonnet #5DE0F0', 'O Opus #B69CFF']);
  assert.ok(cards.every(c => c.mode.word === 'SHADOW'));
  const [h, s, o] = cards;
  assert.equal(h.state.word, 'look cap'); assert.match(h.state.why, /next look 10:35.*worked out on this page/);
  assert.equal(h.position.head, 'Flat');
  assert.equal(h.position.rest, 'resting order: not reported', 'The Desk does not pass the resting order on: not reported');
  assert.equal(h.today.room, '$2,000.00 to the floor');
  assert.equal(s.state, null);
  assert.equal(s.position.head, 'LONG 3 MNQ'); assert.equal(s.position.since, '09:58');
  assert.equal(s.position.open.text, 'open +$60.00 · +0.40 R', '10 points on 3 MNQ at $2; R on the 25 point stop');
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

test('the page: Agents in + Add panel, one a layout, installed, read only, no dashes, no green or red but P&L and sides', () => {
  const html = read('live/index.html');
  assert.match(html, /data-add="agents"[^>]*>Agents<\/button>/);
  assert.ok(html.indexOf('<script src="agents-strip.js"></script>') < html.indexOf('<script src="workspace.js"></script>'));
  assert.ok(html.indexOf('<script src="league.js"></script>') < html.indexOf('<script src="agents-strip.js"></script>'));
  assert.ok(W.TYPES.includes('agents'));
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
  for (const f of ['live/agents-strip.js', 'live/agents-strip.css', 'test/agents-strip.test.js', 'test/agents-strip-smoke.mjs']) assert.doesNotMatch(read(f), /[\u2013\u2014]/, f + ': no em or en dashes');
  const css = read('live/agents-strip.css');
  assert.doesNotMatch(css, /crimson|#9F1239|#E0445E/i, 'no crimson');
  const greenRed = css.split('\n').filter(l => /--ws-buy|--ws-sell/.test(l));
  assert.ok(greenRed.length && greenRed.every(l => /\.as-side\.(long|short)|\.as-pnl\.(up|down)/.test(l)), 'green and red only for the side and P&L');
  assert.doesNotMatch(css, /transition:(?!\s*none)|animation:(?!\s*none)|@keyframes/, 'no motion (R3)');
});
