'use strict';
// The planner's opinion on the chart page (chart 1.64.0, phase 6 part B): the page asks The Desk once, right after a Submit, with
// its own context (its one minute bars, the five minute bars made from them, the levels on its charts and the lines Anthony drew),
// and shows only what The Desk returns. Information only: Arm never waits on it, the page never sends an `opinion` fact, and no
// order code is touched. PlannerCore's pure parts, then the real planner page (live/planner.js) on a fake Desk and a fake clock.
// Sample values only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PC = require('../live/planner-core.js');
const { PlannerPage } = require('../live/planner.js');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const T0 = Date.UTC(2026, 10, 20, 15, 30, 20);                      // a made-up moment, 10:30:20 New York
const MIN = 60000;
const bar = (t, o, h, l, c, v) => ({ t, o, h, l, c, v });
const UID = 'pu' + 'b'.repeat(16);

test('opinion is an event kind only The Desk writes: phaseOf ignores it, the queue never takes it, fromDesk keeps its seq', () => {
  assert.ok(PC.EVENT_KINDS.includes('opinion'));
  assert.deepEqual(PC.DESK_ONLY_KINDS, ['opinion']);
  assert.ok(!PC.END_KINDS.includes('opinion'));
  assert.deepEqual(PC.phaseOf({ events: [{ kind: 'opinion' }] }), { phase: 'submitted', why: '' });
  assert.deepEqual(PC.phaseOf({ events: [{ kind: 'arm' }, { kind: 'opinion' }] }), { phase: 'armed', why: '' });
  const m = new Map(), store = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  const q = PC.createQueue(store, () => T0);
  assert.equal(q.add(7, 'opinion', { verdict: 'agree' }), null, 'the page never queues (or sends) an opinion');
  assert.ok(q.add(7, 'touched', {}), 'its own facts still go');
  assert.deepEqual(q.items().map(x => x.kind), ['touched']);
  const v = { seq: 7, uid: UID, logged_at_ms: T0, pc: 'TESTPC', root: 'MNQ', side: 'long', entry_type: 'limit', entry: 25000, stop: 24990, target: 25020, qty: 1,
    events: [{ seq: 8, uid: 'desk-8', kind: 'opinion', logged_at_ms: T0 + 7000, detail: { status: 'reported', verdict: 'agree', grade: 'A' } }] };
  const P = PC.fromDesk(v);
  assert.equal(P.phase, 'submitted');
  assert.deepEqual([P.events[0].kind, P.events[0].seq, P.events[0].at], ['opinion', 8, T0 + 7000]);
});

test('deskApi.opinion posts { uid, context } to /api/plans/{seq}/opinion', async () => {
  const calls = [];
  const api = PC.deskApi({ base: () => 'http://desk.example.com', fetch: (url, o) => { calls.push([o.method, url, JSON.parse(o.body)]); return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"status":"off"}') }); } });
  const ctx = { bars_1m: [], bars_5m: [], levels: {}, lines: [] };
  const r = await api.opinion(9, 'u'.repeat(8), ctx);
  assert.deepEqual(calls, [['POST', 'http://desk.example.com/api/plans/9/opinion', { uid: 'u'.repeat(8), context: ctx }]]);
  assert.deepEqual(r.body, { status: 'off' });
});

test('opinionContext: the last 60 one minute and 24 five minute bars as [minutes_before, o, h, l, c, v], oldest first', () => {
  const m1 = [];
  for (let k = 200; k >= 0; k--) { const t = Math.floor(T0 / MIN) * MIN - k * MIN, o = 25000 + (k % 7); m1.push(bar(t, o, o + 2, o - 1.5, o + 0.5, 10 + k + 0.4)); }
  m1.push(bar(Math.floor(T0 / MIN) * MIN + MIN, 1, 2, 0.5, 1, 1));   // after the Submit: never sent
  m1.push(bar(T0 - 300 * MIN, 25000, 24990, 25010, 25000, 1));        // a high under its low: dropped
  m1.push(bar(T0 - 301 * MIN, NaN, 1, 1, 1, 1));                        // not a number: dropped
  const c = PC.opinionContext({ m1: m1.slice().reverse(), now: T0 });
  assert.equal(c.bars_1m.length, 60);
  assert.equal(c.bars_5m.length, 24);
  assert.deepEqual(c.bars_1m[59], [0, 25000, 25002, 24998.5, 25000.5, 10], 'the forming minute: 0 minutes before, its volume whole');
  assert.deepEqual(c.bars_1m[0].slice(0, 1), [59]);
  for (const rows of [c.bars_1m, c.bars_5m]) {
    assert.ok(rows.every(r => r.length === 6 && r.every(x => typeof x === 'number' && isFinite(x))));
    assert.ok(rows.every((r, i) => i === 0 || r[0] < rows[i - 1][0]), 'oldest first');
    assert.ok(rows.every(r => r[0] >= 0 && r[0] < 1000), 'minutes before the Submit, never a time or a date');
  }
  /* a five minute bar is its five minutes: the first open, the highest high, the lowest low, the last close, the volumes summed */
  const five = Math.floor(T0 / 300000) * 300000, inIt = m1.filter(b => b.t >= five && b.t <= T0 && b.h >= b.l);
  const last5 = c.bars_5m[23];
  assert.deepEqual(last5, [Math.floor((T0 - five) / MIN), inIt[0].o, Math.max(...inIt.map(b => b.h)), Math.min(...inIt.map(b => b.l)), inIt[inIt.length - 1].c,
    inIt.reduce((a, b) => a + Math.round(b.v), 0)]);
  assert.deepEqual(PC.opinionContext({}), { bars_1m: [], bars_5m: [], levels: {}, lines: [] }, 'nothing known: empty, never a guess');
});

test('opinionContext: level names in letters and _ only (never a digit), the session high and low only when whole; lines nearest the entry', () => {
  const levels = [{ key: 'pdh', name: 'PDH', price: 25100 }, { key: 'pc', name: 'Prior close', price: 25050 }, { key: 'onl', name: 'ONL', price: 24900 },
    { key: 'ibh', name: 'IBH', price: 25040 }, { name: 'VWAP 2', price: 25010 }, { name: '9:30', price: 25005 }, { name: 'PD VAH', price: -1 },
    { key: 'pdh', name: 'PDH', price: 25101 }, { name: 'Round 25000', price: 25000 }];
  const lines = [25003, 24800, 25003, 24999.75, Infinity, -5].concat(Array.from({ length: 60 }, (x, i) => 26000 + i));
  const m1 = [bar(T0 - 70 * MIN, 25000, 25001, 24999, 25000, 1), bar(T0 - 50 * MIN, 25000, 25030, 24995, 25010, 1), bar(T0 - 10 * MIN, 25010, 25012, 24980, 25001, 1)];
  const session = { start: T0 - 60 * MIN, end: T0 + 330 * MIN };
  const c = PC.opinionContext({ m1, now: T0, entry: 25000, levels, lines, session });
  assert.deepEqual(c.levels, { prior_high: 25100, prior_close: 25050, overnight_low: 24900, ib_high: 25040, vwap: 25010, round: 25000, session_high: 25030, session_low: 24980 });
  for (const k of Object.keys(c.levels)) assert.match(k, /^[a-z][a-z_]*$/);
  assert.equal(c.lines.length, PC.OPINION_LINES_MAX);
  assert.deepEqual(c.lines.slice(0, 3), [24999.75, 25003, 24800], 'unique, finite, above 0, the nearest to the entry first');
  const late = PC.opinionContext({ m1: m1.slice(1), now: T0, entry: 25000, session });
  assert.ok(!('session_high' in late.levels) && !('session_low' in late.levels), 'a window without the whole session so far sends no session high or low');
  assert.ok(!('session_high' in PC.opinionContext({ m1, now: T0, session: null }).levels), 'outside the session: none');
  const json = JSON.stringify(c);
  assert.ok(!/20\d\d-|T\d\d:\d\d|account|Sim101|TESTPC/i.test(json), 'no date, clock time, account or PC in the context');
  assert.ok(json.length < 16000);
});

test('opinionOf: the last opinion fact, flat or under answer; after Arm, before an edit, late; texts cut', () => {
  const base = { loggedAt: T0, events: [] };
  assert.equal(PC.opinionOf(base), null);
  const long = 'x'.repeat(400);
  const flat = PC.opinionOf(Object.assign({}, base, { events: [{ kind: 'opinion', seq: 9, at: T0 + 7200, detail: { status: 'reported', verdict: 'agree', grade: 'A', reasons: ['one', ' two  ', '', 'three', 'four', 'five'], wrong_if: long, latency_s: 7.2, cost_usd: 0.0193, on_seq: 8 } }] }));
  assert.deepEqual([flat.status, flat.verdict, flat.grade, flat.reasons, flat.afterArm, flat.edited, flat.late, flat.latency, flat.cost],
    ['reported', 'agree', 'A', ['one', 'two', 'three', 'four'], false, false, false, 7.2, 0.0193]);
  assert.equal(flat.wrongIf.length, 220);
  assert.ok(flat.wrongIf.endsWith('...'));
  const nested = PC.opinionOf(Object.assign({}, base, { events: [{ kind: 'arm', seq: 9, at: T0 + 2000, detail: {} }, { kind: 'opinion', seq: 10, at: T0 + 50000, detail: { status: 'reported', answer: { verdict: 'doubt', grade: 'B', reasons: ['r'], wrong_if: 'w' } } }] }));
  assert.deepEqual([nested.verdict, nested.grade, nested.afterArm, nested.late], ['doubt', 'B', true, true], 'after Arm, and stamped past the 45 seconds: late');
  /* edited: an edit after the values it judged (on_seq), or after the stamp */
  const ev = [{ kind: 'edit', seq: 9, at: T0 + 1000, detail: {} }, { kind: 'opinion', seq: 10, at: T0 + 8000, detail: { status: 'reported', verdict: 'agree', on_seq: 7 } }];
  assert.equal(PC.opinionOf({ loggedAt: T0, events: ev }).edited, true, 'an edit while it was asked: it judged the plan before the edit');
  assert.equal(PC.opinionOf({ loggedAt: T0, events: [ev[0], Object.assign({}, ev[1], { detail: { verdict: 'agree', on_seq: 9 } })] }).edited, false);
  assert.equal(PC.opinionOf({ loggedAt: T0, events: [{ kind: 'opinion', at: T0, detail: { verdict: 'agree' } }, { kind: 'edit', at: T0 + 1, detail: {} }] }).edited, true);
});

test('opinionView: what the card says, reported, each no-opinion, asking and the page\'s own 45 seconds', () => {
  const t = () => '14:05:09';
  const op = { status: 'reported', verdict: 'agree', grade: 'A', reasons: ['a', 'b'], wrongIf: 'it loses the level', why: '', at: T0, latency: 7.2, cost: 0.0193, afterArm: false, edited: false, late: false };
  assert.deepEqual(PC.opinionView(op, null, T0, t), { head: 'Opus: agree · A', reasons: ['a', 'b'], wrongIf: 'it loses the level', meta: 'stamped 14:05:09 · 7.2 s · $0.02', tags: [], quiet: false });
  assert.deepEqual(PC.opinionView(Object.assign({}, op, { afterArm: true, edited: true, late: true }), null, T0, t).tags, ['(after Arm)', 'on the plan before your edit', 'late']);
  const words = { budget: 'No opinion: budget', 'day cap': 'No opinion: day cap', 'month cap': 'No opinion: month cap', declined: 'No opinion: the model declined', off: 'No opinion: the service is off' };
  for (const [status, head] of Object.entries(words)) {
    const v = PC.opinionView(Object.assign({}, op, { status, verdict: '', grade: '', reasons: [], wrongIf: '', latency: null, cost: 0 }), null, T0, t);
    assert.deepEqual([v.head, v.quiet, v.meta], [head, true, 'stamped 14:05:09 · $0.00']);
  }
  assert.equal(PC.opinionView(Object.assign({}, op, { status: 'something new', verdict: '' }), null, T0, t).head, 'No opinion (something new)');
  assert.deepEqual(PC.opinionView(Object.assign({}, op, { status: 'failed', verdict: '', why: 'the service said why' }), null, T0, t).reasons, ['the service said why']);
  /* the page's own ask (nothing stamped yet): the stamp always wins */
  const ask = { state: 'asking', since: T0 };
  assert.equal(PC.opinionView(null, ask, T0 + 44999, t).head, 'Asking Opus...');
  assert.equal(PC.opinionView(null, ask, T0 + 45000, t).head, 'No opinion: no answer in 45 seconds');
  assert.equal(PC.opinionView(op, ask, T0 + 45000, t).head, 'Opus: agree · A');
  assert.equal(PC.opinionView(null, { state: 'off' }, T0, t).head, 'No opinion: the service is off');
  assert.equal(PC.opinionView(null, { state: 'down' }, T0, t).head, 'No opinion: The Desk did not answer');
  assert.deepEqual(PC.opinionView(null, { state: 'refused', why: 'plan #9 is not submitted' }, T0, t).reasons, ['plan #9 is not submitted']);
  assert.equal(PC.opinionView(null, { state: 'none' }, T0, t), null);
  assert.equal(PC.opinionView(null, null, T0, t), null);
});

/* ---------------------------------------------------------------- the real page, on a fake Desk */
async function rig(answer) {
  let clock = T0;
  const plStore = new Map();
  const mem = m => ({ getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) });
  const R = { calls: [], bodies: [], socks: [], notes: [], held: null, core: [] };
  const draft = { uid: UID, root: 'MNQ', side: 'long', entry: 25000, stop: 24990, target: 25020, qty: 1, account: 'Sim101', entryType: 'limit', expiryMin: 30, grade: 'A', tick: 0.25, contract: 'MNQ 12-26', at: T0 };
  plStore.set(PC.STORE_KEY, JSON.stringify({ drafts: { [UID]: draft }, plans: {} }));
  const view = events => ({ seq: 9, uid: UID, pc: 'PC-A', account: 'Sim101', root: 'MNQ', contract: 'MNQ 12-26', side: 'long', entry_type: 'limit', entry: 25000, stop: 24990, target: 25020,
    qty: 1, tick: 0.25, expiry_min: 30, grade: 'A', status: 'submitted', logged_at_ms: T0, events: events || [] });
  let submitted = false;
  const reply = (status, body) => Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });
  const fetch = (url, o) => {
    const u = url.replace(/^https?:\/\/[^/]+/, '');
    R.calls.push((o.method || 'GET') + ' ' + u);
    if (o.body) R.bodies.push({ url: u, body: JSON.parse(o.body) });
    if (u === '/api/plans' && o.method === 'POST') { submitted = true; return reply(200, { plan: view(), duplicate: false }); }
    if (/\/api\/plans\/9\/opinion$/.test(u)) return new Promise(res => { R.held = (status, body) => res({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) }); if (answer) R.held(...answer(view)); });
    if (/\/api\/plans\?/.test(u)) return reply(200, { live: true, now_ms: clock, plans: submitted ? [view(R.deskEvents || [])] : [] });
    return reply(200, {});
  };
  /* TradeCore stands in as a recorder: the opinion must never reach it */
  const core = new Proxy({}, { get: (x, k) => { R.core.push(String(k)); if (k === 'TR') return { orders: new Map(), positions: new Map(), snapGen: 0, snapReady: false, armed: false }; return () => ''; } });
  const timers = [], keep = global.setInterval;
  global.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  let planner;
  try {
    planner = PlannerPage.mount({
      test: true, PC, U: { zoneSeconds: s => s - 5 * 3600, cmeClosed: () => false }, core, storage: mem(plStore), channel: null, now: () => clock,
      locks: null, fetch, deskBase: () => 'http://desk.example.com', pcName: () => 'PC-A',
      hub: { open: root => { const sock = { root, send: () => {} }; R.socks.push(sock); return sock; } }, note: t => R.notes.push(t), alarm: t => R.notes.push(t),
      charts: () => [{ id: 'c1', root: 'MNQ', chart: { getLevels: () => [{ key: 'pdh', name: 'PDH', price: 25100 }, { name: 'Level 7', price: 25050 }], getDrawings: () => [{ type: 'hline', price: 25012.5 }, { type: 'zone', a: { t: 1, p: 24980 }, b: { t: 2, p: 24985 } }, { type: 'trend', a: { t: 1, p: 1 }, b: { t: 2, p: 2 } }], setPlans: () => {}, on: () => {}, lastBar: () => null }, stage: null }],
      tickOf: () => 0.25, contract: () => 'MNQ 12-26', accounts: () => ['Sim101'], ticketAccount: () => 'Sim101', ticketRoot: () => 'MNQ',
      members: a => [a], maxBracketTicks: () => 400, execs: () => [], qty: () => 1, orderTypes: () => true, maxQty: () => 5,
      bracket: () => ({ stop: 40, target: 80 }), holdsTicket: () => false,
    });
  } finally { global.setInterval = keep; }
  for (let i = 0; i < 50 && planner.state().ok !== true; i++) await new Promise(r => setImmediate(r));
  assert.equal(planner.state().ok, true);
  /* the planner's line of MNQ: its history (New York wall seconds), then trades */
  const sock = R.socks.find(s => s.root === 'MNQ');
  assert.ok(sock, 'the planner follows MNQ');
  const nyMin = Math.floor((T0 / 1000 - 5 * 3600) / 60) * 60;
  sock.onmessage({ message: { type: 'history', root: 'MNQ', bars: Array.from({ length: 90 }, (x, i) => [nyMin - (90 - i) * 60, 25000, 25004, 24996, 25001, 12]) } });
  sock.onmessage({ message: { type: 'tick', root: 'MNQ', p: 25002, u: T0 - 15000, v: 3 } });
  sock.onmessage({ message: { type: 'tick', root: 'MNQ', p: 25003.5, u: T0 - 5000, v: 2 } });
  R.core.length = 0;
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  return { R, planner, settle, tick: ms => { clock += ms; }, timers };
}

test('Submit asks for the opinion once, with the page\'s context; nothing reaches TradeCore; a stamped answer shows on the plan', async () => {
  const x = await rig();
  x.planner.test.submit(UID);
  await x.settle();
  const asks = x.R.bodies.filter(b => /\/opinion$/.test(b.url));
  assert.equal(asks.length, 1, 'asked once, right after The Desk stamped the plan');
  assert.equal(asks[0].url, '/api/plans/9/opinion');
  const body = asks[0].body;
  assert.deepEqual(Object.keys(body).sort(), ['context', 'uid']);
  assert.ok(PC.DESK_UID_RX.test(body.uid));
  assert.deepEqual(Object.keys(body.context).sort(), ['bars_1m', 'bars_5m', 'levels', 'lines']);
  assert.equal(body.context.bars_1m.length, 60);
  assert.deepEqual(body.context.bars_1m[59], [0, 25002, 25003.5, 25002, 25003.5, 5], 'the forming minute from this window\'s trades');
  assert.deepEqual(body.context.bars_1m[58], [1, 25000, 25004, 24996, 25001, 12], 'the history, open and volume kept');
  assert.ok(body.context.bars_5m.length >= 18 && body.context.bars_5m.length <= 24);
  assert.deepEqual(body.context.levels, { prior_high: 25100, level: 25050, session_high: 25004, session_low: 24996 }, 'the session from 09:30: this window has it whole');
  assert.deepEqual(body.context.lines, [25012.5, 24985, 24980], 'his hline and zone edges, nearest the entry first; a trend line is not a price');
  assert.ok(!/Sim101|PC-A|account|"pc"/.test(JSON.stringify(body)), 'no account or PC in the ask');
  assert.equal(x.planner.state().asks[UID].state, 'asking');
  assert.equal(x.planner.state().plans[0].phase, 'submitted', 'Arm\'s condition is the phase alone, and the plan is submitted while it is asked');
  assert.deepEqual(x.R.core.filter(k => !['TR'].includes(k)), [], 'the ask touches nothing of TradeCore: ' + x.R.core.join(', '));
  /* The Desk stamps it and answers with the plan: the opinion is a fact of the plan, every window reads it */
  const op = { seq: 10, uid: 'desk-10', kind: 'opinion', logged_at_ms: T0 + 7200, detail: { status: 'reported', verdict: 'agree', grade: 'A', reasons: ['r1', 'r2'], wrong_if: 'w', latency_s: 7.2, cost_usd: 0.02, on_seq: 9 } };
  x.R.deskEvents = [op];
  x.R.held(200, { plan: { seq: 9, uid: UID, pc: 'PC-A', account: 'Sim101', root: 'MNQ', contract: 'MNQ 12-26', side: 'long', entry_type: 'limit', entry: 25000, stop: 24990, target: 25020, qty: 1, tick: 0.25, expiry_min: 30, grade: 'A', status: 'submitted', logged_at_ms: T0, events: [op] }, duplicate: false });
  await x.settle();
  const p = x.planner.state().plans[0];
  assert.equal(p.phase, 'submitted', 'the opinion changes no phase');
  const o = PC.opinionOf(p);
  assert.deepEqual([o.verdict, o.grade, o.reasons, o.latency, o.cost], ['agree', 'A', ['r1', 'r2'], 7.2, 0.02]);
  assert.equal(x.planner.state().asks[UID].state, 'none');
  assert.equal(x.R.bodies.filter(b => /\/events$/.test(b.url) && b.body.kind === 'opinion').length, 0, 'the page never sends an opinion fact');
  x.planner.destroy();
});

test('The Desk\'s answers without a stamp: off, in flight (409), an older Desk (404), not the live Desk, no answer, refused', async () => {
  const cases = [[[200, { status: 'off' }], 'off'], [[409, { detail: 'asking' }], 'asking'], [[404, { detail: 'Not Found' }], 'none'], [[409, { detail: 'This Desk is not the live Desk (THEDESK_LIVE is not set)' }], 'none'], [[400, { detail: 'context too large' }], 'refused']];
  for (const [ans, state] of cases) {
    const x = await rig(() => ans);
    x.planner.test.submit(UID);
    await x.settle();
    assert.equal(x.planner.state().asks[UID].state, state, JSON.stringify(ans));
    x.planner.destroy();
  }
  /* The Desk does not answer: the page says so (it never asks again by itself) */
  const x = await rig();
  x.planner.test.submit(UID);
  await x.settle();
  x.R.held(0, null);
  await x.settle();
  assert.equal(x.planner.state().asks[UID].state, 'down');
  assert.equal(x.R.bodies.filter(b => /\/opinion$/.test(b.url)).length, 1);
  x.planner.destroy();
});

test('the source: Arm\'s enable condition and the order calls are as before; the opinion code calls no order path', () => {
  const src = read('live/planner.js');
  assert.match(src, /data-pl="arm"\$\{phase === 'submitted' && !off \? '' : ' disabled'\}/, 'Arm is enabled by the phase alone, never by the opinion');
  assert.equal((src.match(/core\.sendPlanOrder\(/g) || []).length, 1);
  assert.equal((src.match(/core\.cancelPlanOrder\(/g) || []).length, 1);
  const a = src.indexOf('/* 1.64.0 (phase 6 part B): the planner\'s opinion, under the buttons'), b = src.indexOf('function editDraft(');
  assert.ok(a > 0 && b > a);
  const block = src.slice(a, b);
  assert.doesNotMatch(block, /core\.|sendPlanOrder|cancelPlanOrder|readyPlan|journal\.|fact\(|queue\./, 'the opinion block asks The Desk and draws; nothing else');
  const armFn = src.slice(src.indexOf('  function arm(uid) {'), src.indexOf('  function cancel(uid) {'));
  assert.doesNotMatch(armFn, /opinion|asks/i, 'Arm never looks at the opinion');
  assert.ok(!/[\u2013\u2014]/.test(src + read('live/planner-core.js') + read('test/planner-opinion.test.js')), 'no em or en dashes');
});

test('trade.js is untouched by the opinion (ready() and the plan\'s order calls)', () => {
  const t = read('live/trade.js');
  assert.doesNotMatch(t, /opinion/i);
});
