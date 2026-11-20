'use strict';
// chart 1.60.0 (Anthony 2026-11-19): finished prop accounts are hidden on Legion (display only), and Arm claims the firm's PC before
// the Auto goes. LegionCastraCore (live/legion-castra-core.js): finishedOf, cohortsView's hidden and away, withoutFinished, firmLine,
// needsYou, createClaimer; and the wiring in fleet.js, agent.js, legion-desk.js and legion-tabs.js. Made-up answers only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../live/legion-castra-core.js');
const F = require('./fixtures/castra-sample.js');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const row = (name, o) => Object.assign({ name, stageText: 'Eval', cushion: 1200, cushionWhy: '', today: 35, position: 'Flat', done: false }, o || {});
const trader = (o) => Object.assign({ id: 't1', name: 'Trader One', build: 'sample_a_v1', mode: 'auto', modeText: 'Auto', tone: 'on', status: 'Watching', accounts: ['EVAL-B'], accountText: 'EVAL-B', kind: 'prop', pnlToday: 12, trades: 2 }, o || {});
const withFinished = (ans, list) => Object.assign(ans, { finished_accounts: list });

/* ---------------------------------------------------------------- finished accounts, display only */
test('finished accounts: left out of the chips and the tray, said in one line; every check still counts them', () => {
  const ans = withFinished(F.cohortsAnswer(), [{ account: 'EVAL-D', reason: 'blown', at_ms: 5 }, { account: 'eval-b', reason: 'promoted', at_ms: 6 }, { account: 'X', reason: 'weird' }]);
  const v = K.cohortsView(ans, [row('EVAL-B'), row('FUNDED-C')], [trader({ accounts: ['EVAL-B'] })], true);
  assert.deepEqual(v.tray.map(k => k.account), [], 'EVAL-D (blown) is not in the tray');
  assert.deepEqual(v.cohorts[0].chips.map(k => k.account), [], 'EVAL-B (promoted, flat) is not shown in Alpha');
  assert.equal(v.cohorts[0].hidden, 1);
  assert.equal(v.cohorts[0].auto, true, 'Alpha is still in Auto: a trader is on EVAL-B, shown or not');
  assert.deepEqual(v.hidden.map(x => [x.account, x.reason, x.cohort]), [['EVAL-B', 'promoted', 'Alpha'], ['EVAL-D', 'blown', '']]);
  assert.equal(v.finishedKnown, true);
  assert.match(K.dropRefusal(v, 'EVAL-B', 'gamma'), /has a trader in Auto/, 'a drag still sees the hidden account');
  assert.equal(K.hiddenWords(2), '2 finished prop accounts hidden (blown, promoted or archived on The Desk: Fleet keeps them).');
  assert.equal(K.hiddenWords(0), '');
  const n = K.needsYou({ money: null, cohorts: v, traders: [], reads: {} });
  assert.ok(!n.items.some(i => i.kind === 'accounts'), 'Needs you no longer says "prop accounts in no cohort" for finished ones');
  assert.equal(n.hidden, 2);
});

test('finished accounts: one ChartBridge says holds a position is never hidden; no list from The Desk hides nothing', () => {
  const ans = withFinished(F.cohortsAnswer(), [{ account: 'FUNDED-C', reason: 'blown', at_ms: 5 }]);
  const v = K.cohortsView(ans, [row('EVAL-B'), row('FUNDED-C', { position: 'Long 1 MNQ' })], [], true);
  assert.deepEqual(v.cohorts[1].chips.map(k => [k.account, k.finished]), [['FUNDED-C', 'blown']], 'shown, marked');
  assert.deepEqual(v.hidden, []);
  const old = K.cohortsView(F.cohortsAnswer(), [row('EVAL-B')], [], true);
  assert.deepEqual([old.tray.map(k => k.account), old.hidden, old.finishedKnown], [['EVAL-D'], [], false], 'an older Desk: everything as before');
  assert.deepEqual([...K.finishedOf(null).keys()], []);
  assert.deepEqual(K.withoutFinished([row('EVAL-B'), row('EVAL-D', { position: 'Not connected' }), row('FUNDED-C', { position: 'Short 2 NQ' })],
    K.finishedOf({ finished_accounts: [{ account: 'EVAL-D', reason: 'archived' }, { account: 'FUNDED-C', reason: 'blown' }] })),
  { rows: [row('EVAL-B'), row('FUNDED-C', { position: 'Short 2 NQ' })], hidden: ['EVAL-D'] }, 'Today: left out unless it holds something');
});

/* ---------------------------------------------------------------- the firms' PCs, said from this PC */
const guard = (o) => Object.assign({ state: 'on', why: null, pc: 'PC-ONE', readAt: 1, firms: [{ firm: 'Firm A', pc: 'PC-ONE', here: true, accounts: ['EVAL-B', 'FUNDED-C'], sides: [] }] }, o || {});

test('the firms: where each firm\'s bots trade from, said plainly on this PC and on the other one', () => {
  const g = K.guardOf(guard());
  assert.match(K.firmLine('Firm A', 'PC-ONE', g).text, /^its bots trade from PC-ONE \(this PC\)\.$/);
  const other = K.guardOf(guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: 'PC-ONE', here: false, accounts: ['EVAL-B'] }] }));
  const away = K.firmLine('Firm A', 'PC-ONE', other);
  assert.equal(away.away, true);
  assert.match(away.text, /^its bots now trade from PC-ONE: new entries here \(PC-TWO\) by its traders are refused\. Nothing here is closed or cancelled\.$/);
  const lagging = K.guardOf(guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: 'PC-TWO', here: true, accounts: ['EVAL-B'] }] }));
  assert.match(K.firmLine('Firm A', 'PC-ONE', lagging).text, /still reads this PC until its next read of The Desk \(once a minute\)/, 'the minute before ChartBridge reads');
  assert.match(K.firmLine('Firm A', '', g).text, /^no PC set: its traders' new entries are refused on every PC\. Arm on a PC claims it/);
  assert.match(K.firmLine('Firm A', 'PC-ONE', null).text, /^its bots trade from PC-ONE\.$/, 'no firmGuard (an older ChartBridge): The Desk\'s PC only');
  assert.equal(K.guardOf({ state: 'odd', firms: [] }), null);
  // the Cohorts tab and Needs you: a trader in Auto HERE on a firm that now trades from the other PC
  const v = K.cohortsView(F.cohortsAnswer(), [row('EVAL-B')], [trader({ accounts: ['EVAL-B'] })], true, guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: 'PC-ONE', here: false, accounts: ['EVAL-B'] }] }));
  assert.deepEqual([v.thisPc, v.firms[0].away, v.away], ['PC-TWO', true, [{ firm: 'Firm A', pc: 'PC-ONE', traders: ['Trader One'] }]]);
  const item = K.needsYou({ money: null, cohorts: v, traders: [], reads: {} }).items.find(i => i.kind === 'firm');
  assert.match(item.words, /^Firm A's bots now trade from PC-ONE: new entries here by Trader One are refused \(still in Auto; nothing is closed or cancelled\)\./);
  const home = K.cohortsView(F.cohortsAnswer(), [row('EVAL-B')], [trader()], true, guard());
  assert.deepEqual([home.away, home.firms[0].away], [[], false], 'on the firm\'s own PC nothing waits');
});

/* ---------------------------------------------------------------- the claimer */
function desk(o) {
  const x = Object.assign({ firmPc: null, version: 7, failGet: null, putAnswers: [] }, o || {});
  const calls = [];
  const answer = () => Object.assign(F.cohortsAnswer({ version: x.version }), { firms: [{ firm: 'Firm A', pc: x.firmPc, set_ms: 1, cohorts: ['alpha'] }] });
  return { calls, x,
    get: p => { calls.push(['GET', p]); return x.failGet ? Promise.reject(x.failGet) : Promise.resolve(answer()); },
    put: (p, b) => { calls.push(['PUT', p, b]); const a = x.putAnswers.shift(); if (a) return Promise.reject(a); x.firmPc = b.pc; x.version++; return Promise.resolve(answer()); } };
}
function claimer(d) {
  const T = { timers: [], now: 0 };
  const c = K.createClaimer({ desk: d, now: () => T.now, setTimeout: (f, ms) => { const t = { f, at: T.now + ms }; T.timers.push(t); return t; }, clearTimeout: t => { T.timers = T.timers.filter(x => x !== t); } });
  T.run = ms => { T.now += ms; for (const t of T.timers.filter(x => x.at <= T.now)) { T.timers = T.timers.filter(y => y !== t); t.f(); } };
  return { c, T };
}
const groups = g => ({ type: 'groups', list: [], error: null, firmGuard: g });
const tick = () => new Promise(r => setImmediate(r));
const one = [{ name: 'Trader One', seats: ['EVAL-B'] }];

test('the claim: The Desk already says this PC and ChartBridge shows "here": the Auto goes at once, The Desk read and not written', async () => {
  const d = desk({ firmPc: 'PC-ONE' }), { c } = claimer(d);
  c.hear(groups(guard()));
  assert.deepEqual(await c.claim(one), { ok: true, why: '', claimed: [], words: '' });
  assert.deepEqual(d.calls, [['GET', '/api/legion/cohorts']], 'The Desk is read before every Auto (the R12 review, B1), and not written');
  assert.deepEqual(await c.claim([{ name: 'Sim Trader', seats: ['Sim101'] }]), { ok: true, why: '', claimed: [], words: '' }, 'a seat with no firm: ChartBridge judges it as before');
});

test('B1 (the R12 review): ChartBridge still says "here" but The Desk has the firm on another PC: it is claimed, and nothing goes until the claim is done', async () => {
  const d = desk({ firmPc: 'PC-TWO' }), { c, T } = claimer(d);
  c.hear(groups(guard()));                                             // this PC is PC-ONE; its reading is a minute old and says here
  let done = null;
  c.claim(one).then(r => { done = r; });
  await tick(); await tick();
  assert.deepEqual(d.calls, [['GET', '/api/legion/cohorts'], ['PUT', '/api/legion/firm-pc', { version: 7, firm: 'Firm A', pc: 'PC-ONE' }]], 'claimed whatever ChartBridge says');
  assert.equal(done, null, 'the stale "here" does not let the Auto go');
  T.run(K.TAKEOVER_MS - 1); c.hear(groups(guard())); await tick();
  assert.equal(done, null, 'a takeover waits for the other PC\'s next read');
  T.run(1); await tick();
  assert.equal(done.ok, true);
  assert.deepEqual(done.claimed, ['Firm A']);
});

test('B1: The Desk not reached: nothing goes, even when ChartBridge says "here"', async () => {
  const d = desk({ failGet: { status: null, words: 'The Desk did not answer /api/legion/cohorts in 15 s.' } }), { c } = claimer(d);
  c.hear(groups(guard()));
  const r = await c.claim(one);
  assert.equal(r.ok, false);
  assert.match(r.why, /^The Desk could not be read \(The Desk did not answer \/api\/legion\/cohorts in 15 s\.\), so this page cannot tell which PC the firm trades from: nothing was armed; the trader stays in Shadow\.$/);
});

test('D2: a takeover from another PC holds the Auto until 75 s after the write, said with the time it goes; cancellable', async () => {
  const d = desk({ firmPc: 'PC-ONE' }), { c, T } = claimer(d);
  T.now = Date.UTC(2001, 0, 2, 14, 0, 0);
  c.hear(groups(guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: 'PC-ONE', here: false, accounts: ['EVAL-B'] }] })));
  const said = [];
  let done = null;
  c.claim(one, t => said.push(t)).then(r => { done = r; });
  await tick(); await tick();
  assert.deepEqual(d.calls, [['GET', '/api/legion/cohorts'], ['PUT', '/api/legion/firm-pc', { version: 7, firm: 'Firm A', pc: 'PC-TWO' }]]);
  const at = new Date(T.now + K.TAKEOVER_MS), hh = [at.getHours(), at.getMinutes(), at.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');
  assert.equal(said[0], 'Taking Firm A over from PC-ONE: its bots there stop taking new entries within about a minute (that PC reads The Desk once a minute); Auto goes at ' + hh + ', once ChartBridge here has read it too. Nothing is armed until then.');
  T.run(5000);
  c.hear(groups(guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: 'PC-TWO', here: true, accounts: ['EVAL-B'] }] })));
  await tick();
  assert.equal(done, null, 'ChartBridge here has read it after 5 s: the Auto still waits for the other PC');
  T.run(K.TAKEOVER_MS - 5000 - 1); await tick();
  assert.equal(done, null);
  T.run(1); await tick();
  assert.equal(done.ok, true);
  assert.match(done.words, /^Firm A now trades from PC-TWO \(this PC\); Firm A was PC-ONE: its traders there keep their mode, and their new entries on it are refused from that PC's next read of The Desk \(within a minute\); nothing there is closed or cancelled\.$/);
  assert.ok(K.CLAIM_WAIT_MS > K.TAKEOVER_MS + 30000, 'the wait covers the hold');
  // cancelled during the hold: nothing goes
  const d2 = desk({ firmPc: 'PC-ONE' }), x = claimer(d2);
  x.c.hear(groups(guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: 'PC-TWO', here: true, accounts: ['EVAL-B'] }] })));
  const late = x.c.claim(one);
  await tick(); await tick();
  x.c.cancel();
  assert.equal((await late).cancelled, true);
});

test('the claim: a first claim (no other PC had the firm) goes as soon as ChartBridge here shows "here"', async () => {
  const d = desk({ firmPc: null }), { c } = claimer(d);
  c.hear(groups(guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: null, here: false, accounts: ['EVAL-B'] }] })));
  const said = [];
  let done = null;
  c.claim(one, t => said.push(t)).then(r => { done = r; });
  await tick(); await tick();
  assert.match(said[0], /^Claiming Firm A for this PC \(PC-TWO\)\.\.\. waiting for ChartBridge here to read it from The Desk \(once a minute, 120 s at most\)\. Nothing is armed until it does\.$/);
  c.hear(groups(guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: null, here: false, accounts: ['EVAL-B'] }] })));
  await tick();
  assert.equal(done, null, 'a groups message with the old table: still waiting');
  c.hear(groups(guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: 'PC-TWO', here: true, accounts: ['EVAL-B'] }] })));
  await tick();
  assert.equal(done.ok, true);
  assert.equal(done.words, 'Firm A now trades from PC-TWO (this PC).');
  assert.equal(c.state().busy, false);
});

test('the claim: past 120 s with no "here" nothing is armed and it says so; The Desk already set is not written twice', async () => {
  const d = desk({ firmPc: 'PC-TWO' }), { c, T } = claimer(d);
  c.hear(groups(guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: null, here: false, accounts: ['EVAL-B'] }] })));
  let done = null;
  c.claim(one).then(r => { done = r; });
  await tick(); await tick();
  assert.deepEqual(d.calls.map(x => x[0]), ['GET'], 'The Desk has PC-TWO already: only ChartBridge\'s read is waited for');
  T.run(K.CLAIM_WAIT_MS - 1); await tick();
  assert.equal(done, null);
  T.run(1); await tick();
  assert.equal(done.ok, false);
  assert.match(done.why, /^ChartBridge on this PC did not show Firm A as this PC's within 120 s, so nothing was armed: the trader stays in Shadow\. The Desk has Firm A on PC-TWO now; arm again in a minute\.$/);
});

test('N3: a write The Desk did not answer in time says this PC may not have claimed the firm', async () => {
  const d = desk({ putAnswers: [{ status: null, words: 'The Desk did not answer /api/legion/firm-pc in 15 s.' }] }), { c } = claimer(d);
  c.hear(groups(guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: 'PC-ONE', here: false, accounts: ['EVAL-B'] }] })));
  const r = await c.claim(one);
  assert.equal(r.why, 'The Desk did not answer in time, so this PC may not have claimed Firm A: nothing was armed; the trader stays in Shadow.');
});

test('D3: Castra\'s Today counts every account in its total, hidden finished ones too; only the rows leave them out', () => {
  const fin = K.finishedOf({ finished_accounts: [{ account: 'EVAL-D', reason: 'blown' }, { account: 'EVAL-E', reason: 'archived' }] });
  const t = K.todayView([row('EVAL-B', { today: 35 }), row('EVAL-D', { today: -20, position: 'Flat' }), row('EVAL-E', { today: null, position: 'Not connected' })], fin);
  assert.deepEqual([t.sum, t.known, t.accounts, t.rows.map(r => r.name), t.hidden, t.hiddenCounted], [15, 2, 3, ['EVAL-B'], 2, 1]);
  assert.match(read('live', 'legion-castra.js'), /' The total includes ' \+ K\.plural\(t\.hiddenCounted, 'hidden finished account'\)/);
});

test('N2: the claim\'s code and words name made-up firms and PCs only', () => {
  const core = read('live', 'legion-castra-core.js');
  const part = core.slice(core.indexOf('/* ---------------------------------------------------------------- the firms\' PCs as this PC sees them'), core.indexOf('return Object.freeze({ ROUTES'));
  assert.ok(part.length > 1000);
  assert.doesNotMatch(part, /Lucid|\bWORK\b|\bHOME\b/);
  const log = read('CHANGELOG.md'), entry = log.slice(log.indexOf('## chart 1.60.0'), log.indexOf('## chart 1.59.0'));
  assert.doesNotMatch(entry, /Lucid|\bWORK\b|\bHOME\b/);
});

test('N1: Kill all, a trader\'s kill switch and Stop all automation end a claim that waits', () => {
  assert.match(read('live', 'agent.js'), /if \(k === 'kill'\) \{\n[^\n]*\n\s+if \(claiming\) \{ endClaim\(\);[^\n]*\n\s+else if \(typeof o\.claimCancel === 'function'\)/);
  assert.match(read('live', 'legion.js'), /function send\(\) \{\n[^\n]*\n\s+endAsk\(\);\n[^\n]*\n\s+try \{ if \(window\.LegionTabs && typeof window\.LegionTabs\.cancelClaim === 'function'\) window\.LegionTabs\.cancelClaim\(\); \}/);
  assert.match(read('live', 'legion-tabs.js'), /window\.LegionTabs\.cancelClaim = \(\) => \{ if \(claimer\) claimer\.cancel\(\); \};/);
});

test('the claim fails closed, in plain words: The Desk refuses or is not reached, two firms, no firm table, no PC name; a stale version is read again once', async () => {
  const away = guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: 'PC-ONE', here: false, accounts: ['EVAL-B'] }] });
  {
    const d = desk({ putAnswers: [{ status: 400, body: { detail: 'Firm A is not a firm in the account ledger' } }] }), { c } = claimer(d);
    c.hear(groups(away));
    const r = await c.claim(one);
    assert.equal(r.ok, false);
    assert.match(r.why, /^The Desk refused it: Firm A is not a firm in the account ledger, so this PC did not claim Firm A: nothing was armed; the trader stays in Shadow\.$/);
  }
  {
    const d = desk({ failGet: { status: null, words: 'The Desk did not answer /api/legion/cohorts in 15 s.' } }), { c } = claimer(d);
    c.hear(groups(away));
    assert.match((await c.claim(one)).why, /^The Desk could not be read \(The Desk did not answer \/api\/legion\/cohorts in 15 s\.\), so this page cannot tell which PC the firm trades from: nothing was armed/);
  }
  {
    const d = desk({ putAnswers: [{ status: 409, body: { detail: 'stale', version: 9 } }] }), { c } = claimer(d);
    c.hear(groups(away));
    let done = null;
    c.claim(one).then(r => { done = r; });
    for (let i = 0; i < 6; i++) await tick();
    assert.deepEqual(d.calls.map(x => x[0] + (x[2] ? ' ' + x[2].version : '')), ['GET', 'PUT 7', 'GET', 'PUT 7'], 'read again once, then written with the version read');
    c.hear(groups(guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: 'PC-TWO', here: true, accounts: ['EVAL-B'] }] })));
    await tick();
    assert.equal(done.ok, true);
  }
  {
    const d = desk(), { c } = claimer(d);
    c.hear(groups(guard({ firms: [{ firm: 'Firm A', pc: 'PC-ONE', here: true, accounts: ['EVAL-B'] }, { firm: 'Firm B', pc: null, here: false, accounts: ['B-1'] }] })));
    const r = await c.claim([{ name: 'Trader One', seats: ['EVAL-B', 'B-1'] }]);
    assert.match(r.why, /^Trader One's prop accounts are of more than one firm \(Firm A, Firm B\): a trader trades one firm\. Nothing was armed\.$/);
    assert.deepEqual(d.calls, [], 'never claimed');
  }
  {
    const d = desk(), { c } = claimer(d);
    assert.match((await c.claim(one)).why, /^ChartBridge on this PC has not sent its firm table yet \(firmGuard, ChartBridge 0\.6\.25 or later\)/, 'an older ChartBridge (no firmGuard): nothing is claimed or armed');
    c.hear(groups(guard({ pc: null, firms: [{ firm: 'Firm A', pc: 'PC-ONE', here: false, accounts: ['EVAL-B'] }] })));
    assert.match((await c.claim(one)).why, /does not know its own name \(config\.txt pc, else the Windows computer name\)/);
    assert.deepEqual(d.calls.map(x => x[0]), ['GET'], 'no PUT without this PC\'s name');
    c.hear(groups(guard({ pc: 'bad/name', firms: [{ firm: 'Firm A', pc: 'PC-ONE', here: false, accounts: ['EVAL-B'] }] })));
    assert.match((await c.claim(one)).why, /is not one The Desk takes/);
  }
});

test('the claim: one at a time; cancel and a dropped connection end it with nothing armed', async () => {
  const away = guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: 'PC-ONE', here: false, accounts: ['EVAL-B'] }] });
  const d = desk({ firmPc: 'PC-ONE' }), { c } = claimer(d);
  c.hear(groups(away));
  const first = c.claim(one);
  assert.match((await c.claim(one)).why, /^Still claiming/);
  await tick(); await tick();
  c.cancel();
  const r = await first;
  assert.deepEqual([r.ok, r.cancelled], [false, true]);
  c.hear(groups(guard({ pc: 'PC-TWO', firms: [{ firm: 'Firm A', pc: 'PC-TWO', here: false, accounts: ['EVAL-B'] }] })));
  const second = c.claim(one);
  await tick(); await tick();
  c.lost();
  assert.match((await second).why, /connection to ChartBridge dropped while claiming: nothing was armed/);
});

/* ---------------------------------------------------------------- the wiring */
test('the wiring: Armed and the trader desk ask the claimer before Auto; Praetorian and the Bot desk never claim; Fleet hides finished accounts', () => {
  const tabs = read('live', 'legion-tabs.js'), desk = read('live', 'legion-desk.js'), agent = read('live', 'agent.js'), fleet = read('live', 'fleet.js');
  assert.match(tabs, /claimer = K\.createClaimer\(\{ desk: K\.deskClient\(/);
  assert.match(tabs, /AF\.listen\(\{ message: m => claimer\.hear\(m\), closed: \(\) => claimer\.lost\(\) \}\)/, 'it listens only: it never posts to ChartBridge');
  assert.ok(!/claimer[^\n]*AF\.post/.test(tabs));
  assert.match(tabs, /FleetView\.create\(\{[^\n]*finished: finishedNow, claim: claimOpts\.claim, claimCancel: claimOpts\.claimCancel/);
  assert.match(tabs, /LegionDesk\.mount\(el, \{[^\n]*claim: claimOpts\.claim, claimCancel: claimOpts\.claimCancel \}\)/);
  assert.match(tabs, /firmGuard: s\.firmGuard \|\| null/, 'Castra and the cohort model read firmGuard from FleetView\'s one reader');
  assert.match(desk, /window\.AgentDesk\.create\(Object\.assign\(\{\}, common, claims,/);
  assert.match(desk, /window\.BotDesk\.create\(Object\.assign\(\{\}, common, \{ floating: false/, 'the Bot desk gets no claim');
  assert.match(agent, /if \(m === 'auto' && claimHook && !praetorian\)/);
  assert.match(agent, /const probe = AC\.modeMsg\(a\.agent, 'auto'\), no = probe \? refusal\(/, 'the gate first: a refused Auto claims nothing');
  assert.match(fleet, /if \(on && claimHook && !claimed\)/, 'only switching ON claims; off (Shadow) never waits');
  assert.match(fleet, /arm\(true, true, r\.words \|\| ''\)/, 'after the claim everything is checked again');
  assert.match(read('live', 'legion-castra-core.js'), /firmPc: '\/api\/legion\/firm-pc'/);
});
