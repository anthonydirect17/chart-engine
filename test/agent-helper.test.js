'use strict';
// The Agent tab's On/Off, spend and hero picker (live/agent-helper.js, chart 1.20.0; DECISION 2026-10-09 v and w): the
// picker's rows by mode and account, the mode block for a build that is not a hero, Off in a trade, the spend readout, the
// settings form, the names, and the client against a made-up PC helper (fetch stubbed). The builds and the agent are made
// up (demo, sample-build-1, sample-build-2).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const AH = require('../live/agent-helper.js');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const STATUS = {
  v: 1, barSet: false, bar: { min_trades: null, min_mean_r: null }, session: '2026-10-12',
  builds: [
    { build: 'sample-build-1', stamp: 'aaaaaaaaaaaa', hero: 'Demo', here: true, shadowOk: true, trades: 40, meanR: 0.2 },
    { build: 'sample-build-3', stamp: 'cccccccccccc', hero: 'Demo 2', here: false, shadowOk: true, trades: 25, meanR: 0.1 },
    { build: 'sample-build-2', stamp: 'bbbbbbbbbbbb', hero: null, here: true, shadowOk: true, trades: 5, meanR: 0.4 },
    { build: 'sample-build-4', stamp: 'dddddddddddd', hero: null, here: true, shadowOk: false, trades: 2, meanR: -0.1 },
  ],
  agents: { demo: { on: true, running: true, why: 'on', build: 'sample-build-2', runningBuild: 'sample-build-2', hero: null, spend: { session: 1.8412, overall: 1234.5 }, autoOn: '', cap: null } },
};

test('the picker: heroes only in Copilot, Auto and on a LIVE account; Shadow on Sim adds the builds over the bar', () => {
  const shadow = AH.pickerRows(STATUS, 'shadow', true).map(r => r.build);
  assert.deepEqual(shadow, ['sample-build-1', 'sample-build-3', 'sample-build-2'], 'the one under the bar is not listed');
  for (const [mode, sim] of [['copilot', true], ['auto', true], ['shadow', false], ['shadow', undefined], ['copilot', false]]) {
    assert.deepEqual(AH.pickerRows(STATUS, mode, sim).map(r => r.build), ['sample-build-1', 'sample-build-3'], mode + ' ' + sim);
  }
  const rows = AH.pickerRows(STATUS, 'shadow', true);
  assert.equal(rows[0].label, 'Demo (sample-build-1)');
  assert.equal(rows[2].label, 'sample-build-2 (Shadow only)');
  assert.match(rows[1].title, /fetched from The Desk on On/);
  assert.match(rows[2].title, /^Not a hero, Shadow on Sim only: sample-build-2 bbbbbbbbbbbb, 5 trades, mean R 0\.4/);
  assert.deepEqual(AH.pickerRows(null, 'shadow', true), []);
  assert.equal(AH.pickerNote(STATUS, 'shadow', true), 'No Shadow bar set: every build is listed in Shadow.');
  assert.equal(AH.pickerNote(Object.assign({}, STATUS, { barSet: true }), 'shadow', true), '');
  assert.equal(AH.pickerNote(STATUS, 'copilot', true), 'Heroes only in Copilot.');
  assert.equal(AH.pickerNote(STATUS, 'shadow', false), 'Heroes only in this mode and on a LIVE account.');
});

test('a build that is not a hero keeps the mode at Shadow on Sim and its account Sim; it fails closed', () => {
  const why = 'sample-build-2 is not a hero: Shadow on a Sim account only.';
  assert.deepEqual(AH.modeBlock(STATUS.agents.demo), { copilot: why, auto: why });
  assert.deepEqual(AH.modeBlock(Object.assign({}, STATUS.agents.demo, { hero: 'Demo' })), { copilot: null, auto: null });
  assert.deepEqual(AH.modeBlock(Object.assign({}, STATUS.agents.demo, { running: false })), { copilot: null, auto: null });
  assert.deepEqual(AH.modeBlock(null), { copilot: null, auto: null });
  /* the helper down, locked or slow (no entry): his own hello still says it (a build that is not a hero says its build id) */
  const plain = { agent: 'demo', connected: true, name: 'sample-build-2', build: 'sample-build-2 bbbbbbbbbbbb' };
  assert.deepEqual(AH.modeBlock(null, plain), { copilot: why, auto: why });
  assert.deepEqual(AH.modeBlock(null, Object.assign({}, plain, { name: 'Demo 2', build: 'sample-build-3 cccccccccccc' })), { copilot: null, auto: null }, 'a hero says its name');
  assert.deepEqual(AH.modeBlock(null, Object.assign({}, plain, { connected: false })), { copilot: null, auto: null }, 'nothing runs');
  assert.equal(AH.nonHero(plain, null), 'sample-build-2');
  assert.equal(AH.accountBlock(plain, null, false), 'sample-build-2 is not a hero: it trades a Sim account only. Turn him Off and pick a hero first.');
  assert.equal(AH.accountBlock(plain, null, undefined), AH.accountBlock(plain, null, false), 'an account not known to be Sim counts as LIVE');
  assert.equal(AH.accountBlock(plain, null, true), '');
  assert.equal(AH.accountBlock(Object.assign({}, plain, { name: 'Demo 2' }), null, false), '');
});

test('Off: flat goes at once; in a trade it asks first', () => {
  assert.equal(AH.offStep({ position: null }), 'off');
  assert.equal(AH.offStep({ position: { root: 'MNQ', qty: 0 } }), 'off');
  assert.equal(AH.offStep({ position: { root: 'MNQ', qty: 2 } }), 'ask');
  assert.equal(AH.offStep({ position: { root: 'MNQ', qty: -1 } }), 'ask');
  assert.equal(AH.offStep(null), 'off');
  assert.equal(AH.offQuestion({ account: 'SIM-AG1', position: { root: 'MNQ', qty: -2 } }, 'Demo'), 'Demo holds short 2 MNQ on SIM-AG1. Flatten and turn him off?');
  assert.ok(AH.flat({ position: { root: 'MNQ', qty: 0 } }) && !AH.flat({ position: { root: 'MNQ', qty: 1 } }));
  assert.equal(AH.FLAT_WAIT_MS, 30000);
});

test('Flatten and turn off on an older ChartBridge: Shadow first, then a flatten by hand, then Off once flat; his account never a default; it gives up and says so', () => {
  /* the R12 delta, nit: no page sends a Flatten of its own any more (no desk is given one): every job that is not one
     agentFlattenOff is this hand job */
  const T = 1000000, pos = { root: 'MNQ', qty: 1, avgPrice: 25400 };
  const inAuto = { agent: 'demo', account: 'SIM-AG1', mode: 'auto', position: pos };
  assert.match(AH.flatOffStart(Object.assign({}, inAuto, { account: '' }), T).error, /His account is not known yet: nothing was sent/);
  assert.match(AH.flatOffStart(Object.assign({}, inAuto, { position: { qty: 1 } }), T).error, /instrument is not known: nothing was sent/);
  assert.equal(AH.flatOffStart(Object.assign({}, inAuto, { position: null }), T).action, 'off', 'flat by now: just Off');
  const st = AH.flatOffStart(inAuto, T);
  assert.deepEqual(st, { job: { agent: 'demo', account: 'SIM-AG1', root: 'MNQ', phase: 'shadow', until: T + AH.SHADOW_WAIT_MS, hand: true }, action: 'shadow' });
  assert.equal(AH.flatOffStart(Object.assign({}, inAuto, { mode: 'shadow' }), T).action, 'hand', 'already in Shadow: the wait at once');
  let r = AH.flatOffStep(st.job, inAuto, T + 500);
  assert.deepEqual([r.action, r.line], ['', 'Putting him in Shadow first (no new entries)...']);
  r = AH.flatOffStep(st.job, Object.assign({}, inAuto, { position: null }), T + 600);
  assert.deepEqual([r.action, r.job.phase], ['', 'shadow'], 'flat but not yet in Shadow: no Off');
  r = AH.flatOffStep(st.job, inAuto, T + AH.SHADOW_WAIT_MS + 1);
  assert.deepEqual([r.action, r.job], ['giveup', null]); assert.match(r.line, /did not put him in Shadow within 10 s: nothing was flattened and he stays on/);
  r = AH.flatOffStep(st.job, Object.assign({}, inAuto, { mode: 'shadow' }), T + 2000);
  assert.equal(r.action, ''); assert.equal(r.job.phase, 'flatten'); assert.equal(r.job.until, T + 2000 + AH.HAND_WAIT_MS);
  const j = r.job, shadowPos = Object.assign({}, inAuto, { mode: 'shadow' });
  assert.equal(AH.flatOffStep(j, shadowPos, T + 3000).action, '', 'not flat yet: wait');
  assert.equal(AH.flatOffStep(j, shadowPos, T + 3000).line, AH.handLine(j));
  assert.equal(AH.flatOffStep(j, Object.assign({}, shadowPos, { position: null }), T + 4000).action, 'off');
  r = AH.flatOffStep(j, shadowPos, j.until + 1);
  assert.deepEqual([r.action, r.job], ['giveup', null]);
  assert.equal(r.line, 'Not flat 15 minutes after he went to Shadow: he stays on, in Shadow. Flatten SIM-AG1 MNQ, then press Off.');
  assert.deepEqual(AH.flatOffStep(null, inAuto, T), { action: '', job: null, line: '' });
  /* the connection dropped: the page has no agent message for him; that is never flat (re-review of e15b971) */
  r = AH.flatOffStep(j, null, T + 3000);
  assert.deepEqual([r.action, r.job], ['', j]); assert.match(r.line, /^Waiting for ChartBridge \(the connection dropped\)/);
  r = AH.flatOffStep(st.job, null, T + 500);
  assert.equal(r.action, '', 'in the Shadow step too');
  r = AH.flatOffStep(j, null, j.until + 1);
  assert.deepEqual([r.action, r.job], ['giveup', null]);
  assert.equal(r.line, 'ChartBridge did not answer: he may still hold SIM-AG1 MNQ and stays on. Check NinjaTrader, then press Off.');
  assert.equal(AH.flatOffStep(j, Object.assign({}, shadowPos, { position: null }), T + 5000).action, 'off', 'back, and flat: Off');
  /* a job of neither kind (none is made any more) is taken as a hand job: it never asks for a Flatten */
  const odd = { agent: 'demo', account: 'SIM-AG1', root: 'MNQ', phase: 'flatten', until: T + 1000 };
  assert.deepEqual(AH.flatOffStep(odd, shadowPos, T + 10).action, '');
  assert.ok(['', 'off', 'giveup'].includes(AH.flatOffStep(odd, Object.assign({}, shadowPos, { position: null }), T + 10).action));
  /* no page Flatten is left in the desk */
  const js = read('live', 'agent.js');
  assert.ok(!/jobFlatten|o\.flatten\(|flatSent/.test(js), 'the desk has no Flatten of its own');
  assert.ok(!/flatten: o\.flatten/.test(read('live', 'legion-desk.js')), 'Legion\'s trader desk hands it none');
});

test('the spend readout and the words under On/Off', () => {
  assert.deepEqual(AH.spendText(STATUS.agents.demo.spend), { session: '$1.84', overall: '$1,234.50' });
  assert.deepEqual(AH.spendText(null), { session: '-', overall: '-' });
  assert.equal(AH.usd(0), '$0.00');
  assert.match(AH.stateText(null, 'down'), /PC helper is not running on this PC/);
  assert.match(AH.stateText(null, 'locked'), /PIN/);
  assert.equal(AH.stateText(null, 'forbidden', 'only ChartBridge\'s own page'), 'The PC helper refused this page: only ChartBridge\'s own page.');
  assert.match(AH.stateText(null, 'none'), /does not run this agent/);
  assert.equal(AH.stateText({ on: false, running: false }), 'Off: no model calls, no spend.');
  assert.equal(AH.stateText({ on: false, running: true }), 'Turning off...');
  assert.equal(AH.stateText({ on: true, running: true, runningBuild: 'sample-build-1', hero: 'Demo' }), 'On: Demo.');
  assert.equal(AH.stateText({ on: true, running: false, why: 'waiting for NinjaTrader to connect' }), 'On, not running yet: waiting for NinjaTrader to connect.');
});

test('names (DECISION v): the hello name in the header, the build and stamp in the details', () => {
  assert.deepEqual(AH.names({ agent: 'demo', name: 'Demo 2', build: 'sample-build-3 cccccccccccc' }), { name: 'Demo 2', build: 'sample-build-3 cccccccccccc' });
  assert.deepEqual(AH.names({ agent: 'demo' }), { name: 'demo', build: '' });
});

test('the settings form', () => {
  assert.deepEqual(AH.settingsBody('demo', '09:30', '5'), { ok: true, body: { agent: 'demo', autoOn: '09:30', cap: 5 } });
  assert.deepEqual(AH.settingsBody('demo', '', ''), { ok: true, body: { agent: 'demo', autoOn: '', cap: null } });
  assert.deepEqual(AH.settingsBody('demo', ' 17:55 ', '2.555'), { ok: true, body: { agent: 'demo', autoOn: '17:55', cap: 2.56 } });
  for (const [at, cap] of [['9:30', ''], ['24:00', ''], ['', '-1'], ['', '1001'], ['', 'five']]) assert.ok(AH.settingsBody('demo', at, cap).error, at + ' ' + cap);
});

test('the client: the PIN unlock on every call, JSON bodies, and what each answer means', async () => {
  const calls = [];
  const answers = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const a = answers.shift();
    if (a === 'throw') throw new Error('refused');
    return { status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => a.body };
  };
  const c = AH.createClient({ fetch, headers: () => ({ 'X-ChartBridge-Unlock': 'made-up-token' }) });
  answers.push({ status: 200, body: STATUS });
  let r = await c.status();
  assert.equal(r.reach, 'ok'); assert.equal(r.body.v, 1);
  assert.equal(calls[0].url, 'http://localhost:8767/status');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['X-ChartBridge-Unlock'], 'made-up-token');
  assert.equal(calls[0].init.credentials, 'omit');
  answers.push({ status: 200, body: { ok: true } });
  r = await c.on('demo', 'sample-build-1', 'shadow', true);
  assert.equal(calls[1].url, 'http://localhost:8767/on');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].init.body), { agent: 'demo', build: 'sample-build-1', mode: 'shadow', sim: true });
  answers.push({ status: 409, body: { error: 'demo runs sample-build-2: turn him Off first' } });
  r = await c.on('demo', 'sample-build-1');
  assert.deepEqual(r, { reach: 'refused', body: { error: 'demo runs sample-build-2: turn him Off first' } });
  answers.push({ status: 401, body: { error: 'unlock' } });
  assert.equal((await c.off('demo')).reach, 'locked');
  assert.deepEqual(JSON.parse(calls[3].init.body), { agent: 'demo' });
  answers.push('throw');
  assert.equal((await c.status()).reach, 'down');
  answers.push({ status: 403, body: { error: 'only ChartBridge\'s own page' } });
  assert.deepEqual(await c.status(), { reach: 'forbidden', body: { error: 'only ChartBridge\'s own page' } });
  answers.push({ status: 200, body: { ok: true } });
  await c.settings({ agent: 'demo', autoOn: '09:30', cap: 5 });
  assert.equal(calls[6].url, 'http://localhost:8767/settings');
});

test('wiring: loaded before agent.js on both pages, installed, the workspace passes its Flatten, no dashes', () => {
  for (const f of ['index.html', 'agent.html']) {
    const h = read('live', f);
    assert.ok(h.indexOf('agent-helper.js') > 0 && h.indexOf('agent-helper.js') < h.indexOf('src="agent.js"'), f);
  }
  const to = JSON.parse(read('nt8', 'install-files.json')).www.map(f => f.to);
  assert.ok(to.includes('agent-helper.js'));
  /* plan step 3.2: the Agent desk is on Legion (no order ticket there): with a ChartBridge that knows it, "Flatten and turn off"
     is one ChartBridge command (agentFlattenOff); with an older one the desk says where to flatten. The chart page no longer
     shows the desk, so it hands it no Flatten */
  assert.match(read('live', 'agent.js'), /if \(AC\.FLATOFF_MIN && AC\.atLeast\(S\.version, AC\.FLATOFF_MIN\)\) \{/);
  assert.doesNotMatch(read('live', 'workspace.js'), /core\.flattenAgent\(/);
  assert.match(read('live', 'trade.js'), /function flattenAgent\(account, R\)/);
  for (const f of ['live/agent-helper.js', 'test/agent-helper.test.js']) assert.doesNotMatch(read(f), /[\u2013\u2014]/, f);
  /* the page never builds an order for the agent: the only order On/Off can cause is the page's own Flatten */
  const js = read('live', 'agent-helper.js');
  assert.doesNotMatch(js, /type: ?'(order|flatten|agentAnswer)'/);
});

/* chart 1.29.1: a missed GET /status (a timeout, no connection, a 500) keeps the last good answer for one poll only */
test('the missed-poll grace: one miss keeps the last good answer, the second in a row is down', () => {
  const T = 1000000, ok = { reach: 'ok', body: STATUS }, down = { reach: 'down', body: null };
  let st = AH.pollStep(null, ok, T);
  assert.deepEqual(st, { reach: 'ok', status: STATUS, why: '', okAt: T, misses: 0, slow: false });
  /* one miss: the old answer stays, the agent is still On and his spend still shows; slow says so */
  const one = AH.pollStep(st, down, T + AH.POLL_MS + 4000);
  assert.equal(one.reach, 'ok'); assert.equal(one.status, STATUS); assert.equal(one.slow, true); assert.equal(one.misses, 1);
  assert.equal(AH.stateText(one.status.agents.demo, one.reach), 'On: sample-build-2.');
  assert.deepEqual(AH.spendText(one.status.agents.demo.spend), { session: '$1.84', overall: '$1,234.50' });
  /* a 500 is a miss as well, and so is a 200 with no agents */
  assert.equal(AH.pollStep(st, { reach: 'down', body: { error: 'HTTP 500' } }, T + 3000).slow, true);
  assert.equal(AH.pollStep(st, { reach: 'ok', body: { v: 1 } }, T + 3000).slow, true);
  /* the second miss in a row: down, no status, the words as before */
  const two = AH.pollStep(one, down, T + 6000);
  assert.deepEqual(two, { reach: 'down', status: null, why: '', okAt: T, misses: 2, slow: false });
  assert.equal(AH.stateText(null, two.reach), 'The PC helper is not running on this PC (tools\\manrae_helper.ps1 register).');
  assert.equal(AH.pollStep(two, down, T + 9000).reach, 'down', 'stays down');
  /* a helper really gone (no connection at once, every POLL_MS): down on the second poll, about 6 s after the last answer */
  assert.equal(AH.pollStep(AH.pollStep(st, down, T + AH.POLL_MS), down, T + 2 * AH.POLL_MS).reach, 'down');
  /* a good answer too old for the grace (the tab was hidden, polls stopped): the first miss is down */
  assert.equal(AH.pollStep(st, down, T + AH.MISS_GRACE_MS + 1).reach, 'down');
  assert.equal(AH.pollStep(st, down, T + AH.MISS_GRACE_MS).reach, 'ok', 'arrived at most MISS_GRACE_MS before the miss');
  /* no good answer yet (a PC with no helper): down at once */
  assert.equal(AH.pollStep(null, down, T).reach, 'down');
  assert.equal(AH.pollStep({ reach: '', status: null, okAt: 0, misses: 0 }, down, T).reach, 'down');
});

test('the missed-poll grace: recovery, and 401, 403, 400, 409 exactly as before', () => {
  const T = 1000000, ok = { reach: 'ok', body: STATUS }, down = { reach: 'down', body: null };
  const st = AH.pollStep(null, ok, T), one = AH.pollStep(st, down, T + 3000), two = AH.pollStep(one, down, T + 6000);
  /* recovery: the next good answer ends the grace or the down, and a fresh miss after it gets the grace again */
  for (const [from, at] of [[one, T + 6000], [two, T + 9000]]) {
    const back = AH.pollStep(from, ok, at);
    assert.deepEqual(back, { reach: 'ok', status: STATUS, why: '', okAt: at, misses: 0, slow: false });
    assert.equal(AH.pollStep(back, down, at + 3000).slow, true);
  }
  /* the page refused: never held, from a good answer or from the grace */
  for (const from of [st, one]) {
    assert.deepEqual(AH.pollStep(from, { reach: 'locked', body: { error: 'unlock' } }, T + 3000), { reach: 'locked', status: null, why: 'unlock', okAt: 0, misses: 0, slow: false });
    assert.deepEqual(AH.pollStep(from, { reach: 'forbidden', body: { error: 'only ChartBridge\'s own page' } }, T + 3000), { reach: 'forbidden', status: null, why: 'only ChartBridge\'s own page', okAt: 0, misses: 0, slow: false });
    assert.deepEqual(AH.pollStep(from, { reach: 'refused', body: { error: 'bad request' } }, T + 3000), { reach: 'refused', status: null, why: 'bad request', okAt: 0, misses: 0, slow: false });
  }
  assert.equal(AH.stateText(null, 'forbidden', 'only ChartBridge\'s own page'), 'The PC helper refused this page: only ChartBridge\'s own page.');
  assert.equal(AH.stateText(null, 'locked'), 'Unlock ChartBridge\'s page with its PIN.');
  /* a miss after a refusal is down at once (no good answer to keep) */
  assert.equal(AH.pollStep(AH.pollStep(st, { reach: 'locked', body: null }, T + 3000), down, T + 6000).reach, 'down');
  /* nothing starts on an old answer: Assign hero's free slot is refused while slow (the page passes reach 'slow') */
  assert.match(AH.freeSlot([{ agent: 'demo' }], STATUS, 'slow').error, /not answering/);
  assert.match(AH.slotFree({ agent: 'demo' }, STATUS, 'slow'), /not answering/);
  assert.match(AH.SLOW_TEXT, /slow/); assert.doesNotMatch(AH.SLOW_TEXT, /not running/);
});

test('the missed-poll grace is wired: agent.js folds every poll through pollStep and holds On while slow', () => {
  const js = read('live', 'agent.js');
  assert.match(js, /const st = AH\.pollStep\(H, r, Date\.now\(\)\);/);
  assert.match(js, /isOn \? on \|\| !sel\.value \|\| H\.slow : !on/);
  assert.match(js, /if \(H\.slow\) \{ helperSay\(SLOW_SENT\); renderPanel\(\); return; \}/);
  assert.match(js, /function assignPressed[^]*?if \(H\.slow\) \{ boardSay\(SLOW_SENT\); return; \}[^]*?AH\.assignStart\(/);
  assert.match(js, /else if \(k === 'bYes'\) \{ if \(B\.ask && H\.slow\) boardSay\(SLOW_SENT\);/);
  assert.match(js, /H\.reach !== 'ok' \|\| H\.slow \|\| !r\.startBuild/);
  assert.match(js, /AH\.assignStart\(g, agents\.list\(\), H\.status, helperReach\(\)/);
  assert.equal(AH.POLL_MS, 3000); assert.equal(AH.TIMEOUT_MS, 4000); assert.equal(AH.MISS_GRACE_MS, 8000);
  assert.ok(AH.POLL_MS + AH.TIMEOUT_MS <= AH.MISS_GRACE_MS, 'a poll that times out right after a good answer still gets the grace');
});

test('plan step 3.2 (the R12 review, B1): a hand flatten (no Flatten of the page, an older ChartBridge): Shadow first, then Off once flat', () => {
  const T = 2000000, pos = { root: 'MNQ', qty: 1, avgPrice: 25400 };
  const inCopilot = { agent: 'demo', account: 'SIM-AG1', mode: 'copilot', position: pos }, inShadow = Object.assign({}, inCopilot, { mode: 'shadow' });
  const HAND = 'He is in Shadow: flatten him in NinjaTrader, or with Flatten on the chart page\'s ticket with his account picked; he turns off once flat.';
  const st = AH.flatOffStart(inCopilot, T);
  assert.deepEqual([st.action, st.job.phase, st.job.hand], ['shadow', 'shadow', true], 'the stop half still goes: Shadow first');
  let r = AH.flatOffStep(st.job, inShadow, T + 1000);
  assert.deepEqual([r.action, r.job.phase, r.line], ['', 'flatten', HAND], 'in Shadow: no Flatten of the page, the line says where');
  assert.equal(r.job.until, T + 1000 + AH.HAND_WAIT_MS);
  assert.equal(AH.flatOffStep(r.job, inShadow, T + 60000).action, '', 'still long a minute later: he waits, no Off');
  assert.equal(AH.flatOffStep(r.job, Object.assign({}, inShadow, { position: null }), T + 61000).action, 'off', 'flat by hand: Off');
  const g = AH.flatOffStep(r.job, inShadow, r.job.until + 1);
  assert.deepEqual([g.action, g.job], ['giveup', null]); assert.match(g.line, /^Not flat 15 minutes after he went to Shadow: he stays on, in Shadow\. Flatten SIM-AG1 MNQ, then press Off\.$/);
  const s2 = AH.flatOffStart(inShadow, T);
  assert.deepEqual([s2.action, s2.job.phase, s2.job.until], ['hand', 'flatten', T + AH.HAND_WAIT_MS], 'in Shadow already: the wait at once');
  assert.equal(AH.handLine(s2.job), HAND);
  assert.equal(AH.flatOffStart(Object.assign({}, inCopilot, { position: null }), T).action, 'off', 'flat: Off at once');
  assert.equal(AH.flatOffStart(inCopilot, T).job.hand, true, 'every job that is not agentFlattenOff is a hand job (the R12 delta: no page Flatten)');
});

test('the R12 delta of plan step 3.2, B1r: in the hand wait, he leaves Shadow (Auto, from Legion\'s Armed or another page): the wait ends, no Off', () => {
  const T = 3000000, pos = { root: 'MNQ', qty: 1, avgPrice: 25400 };
  const inShadow = { agent: 'demo', account: 'SIM-AG1', mode: 'shadow', position: pos };
  const st = AH.flatOffStart(inShadow, T);
  assert.deepEqual([st.action, st.job.phase, st.job.hand], ['hand', 'flatten', true]);
  let r = AH.flatOffStep(st.job, Object.assign({}, inShadow, { mode: 'auto' }), T + 5000);
  assert.deepEqual([r.action, r.job], ['giveup', null]);
  assert.equal(r.line, 'He left Shadow (now auto) before he was flat: he stays on. Flatten SIM-AG1 MNQ, then press Off.');
  r = AH.flatOffStep(st.job, Object.assign({}, inShadow, { mode: 'auto', position: null }), T + 5000);
  assert.equal(r.action, 'giveup', 'flat but out of Shadow: no Off either');
  r = AH.flatOffStep(st.job, Object.assign({}, inShadow, { mode: undefined }), T + 5000);
  assert.match(r.line, /^He left Shadow \(now not known\)/);
});

test('the R12 delta of plan step 3.2, X2: one agentFlattenOff: Shadow said only once seen, Shadow before Off, out of Shadow the wait ends', () => {
  const T = 4000000, pos = { root: 'MNQ', qty: 1, avgPrice: 25400 };
  const inAuto = { agent: 'demo', account: 'SIM-AG1', mode: 'auto', position: pos }, inShadow = Object.assign({}, inAuto, { mode: 'shadow' });
  const st = AH.flatOffStart(inAuto, T, true);
  assert.deepEqual(st, { job: { agent: 'demo', account: 'SIM-AG1', root: 'MNQ', phase: 'shadow', fo: true, until: T + AH.SHADOW_WAIT_MS }, action: 'flatoff' });
  /* still in Auto: never "he is in Shadow"; flat for a moment while still in Auto: no Off */
  let r = AH.flatOffStep(st.job, inAuto, T + 500);
  assert.deepEqual([r.action, r.line], ['', 'Flatten and turn off sent: waiting for ChartBridge to put him in Shadow...']);
  assert.equal(r.line, AH.FO_SENT);
  r = AH.flatOffStep(st.job, Object.assign({}, inAuto, { position: null }), T + 600);
  assert.deepEqual([r.action, r.job.phase], ['', 'shadow'], 'flat but still in Auto: no Off');
  /* not in Shadow in time: he stays on, in the mode ChartBridge says */
  r = AH.flatOffStep(st.job, inAuto, T + AH.SHADOW_WAIT_MS + 1);
  assert.deepEqual([r.action, r.job], ['giveup', null]);
  assert.equal(r.line, 'ChartBridge did not put him in Shadow within 10 s of Flatten and turn off: he stays on (Auto). Flatten SIM-AG1 MNQ in NinjaTrader, then press Off.');
  /* in Shadow: ChartBridge flattens; Off once flat, in Shadow */
  r = AH.flatOffStep(st.job, inShadow, T + 1000);
  assert.deepEqual([r.action, r.job.phase, r.job.until, r.line], ['', 'flatten', T + 1000 + AH.FLAT_WAIT_MS, AH.FO_WAIT]);
  assert.ok(/^In Shadow: /.test(AH.FO_WAIT));
  const j = r.job;
  assert.equal(AH.flatOffStep(j, inShadow, T + 2000).action, '', 'not flat yet: wait');
  assert.deepEqual(AH.flatOffStep(j, Object.assign({}, inShadow, { position: null }), T + 3000).action, 'off');
  /* B1r for this job too: out of Shadow before flat (or flat in Auto) the wait ends, no Off */
  for (const x of [Object.assign({}, inShadow, { mode: 'auto' }), Object.assign({}, inShadow, { mode: 'auto', position: null }), Object.assign({}, inShadow, { mode: 'copilot', position: null })]) {
    r = AH.flatOffStep(j, x, T + 4000);
    assert.deepEqual([r.action, r.job], ['giveup', null], JSON.stringify(x));
    assert.match(r.line, /^He left Shadow \(now (auto|copilot)\) before he was flat: he stays on\. Flatten SIM-AG1 MNQ, then press Off\.$/);
  }
  r = AH.flatOffStep(j, inShadow, j.until + 1);
  assert.deepEqual([r.action, r.line], ['giveup', 'Not flat 30 s after Flatten and turn off: he stays on, in Shadow. Flatten SIM-AG1 MNQ in NinjaTrader, then press Off.']);
  /* no word from ChartBridge: never read as flat; at the end, never "nothing was flattened" (ChartBridge may have) */
  assert.equal(AH.flatOffStep(j, null, T + 2000).action, '');
  assert.equal(AH.flatOffStep(st.job, null, st.job.until + 1).line, 'ChartBridge did not answer: whether he was flattened is not known, and he stays on. Check NinjaTrader, then press Off.');
  /* already in Shadow when pressed: the wait for flat at the first step; a job is made even when the page cannot say where he holds */
  r = AH.flatOffStep(AH.flatOffStart(inShadow, T, true).job, inShadow, T + 100);
  assert.deepEqual([r.action, r.job.phase, r.job.fo, r.line], ['', 'flatten', true, AH.FO_WAIT]);
  const unclear = AH.flatOffStart(Object.assign({}, inAuto, { account: null, seats: [{ account: 'PROP-1' }] }), T, true);
  assert.deepEqual([unclear.action, unclear.job.fo, unclear.job.phase], ['flatoff', true, 'shadow'], 'ChartBridge flattens what he owns: the page need not say where');
  assert.match(AH.flatOffStep(unclear.job, Object.assign({}, inAuto, { account: null, seats: [{ account: 'PROP-1' }] }), unclear.job.until + 1).line, /Flatten what he holds in NinjaTrader, then press Off\.$/);
  assert.equal(AH.modeWord('copilot'), 'Copilot'); assert.equal(AH.modeWord(undefined), 'mode not known');
});

test('the R12 delta of plan step 3.2, X2: the desk keeps the command\'s cid, and a refusal ends the job with ChartBridge\'s words', () => {
  const js = read('live', 'agent.js');
  assert.match(js, /const c = sendAgent\(fm, 'flatoff'\);/);
  assert.match(js, /H\.job = Object\.assign\(AH\.flatOffStart\(a, Date\.now\(\), true\)\.job, \{ cid: c \}\);/);
  assert.match(js, /S\.pending\.set\(c, \{ kind, agent: typeof m\.agent === 'string' \? m\.agent : '' \}\);/);
  assert.match(js, /return c;\s+\/\/ its cid/);
  assert.match(js, /else if \(x\.kind === 'flatoff'\) \{[\s\S]{0,400}if \(H\.job && H\.job\.cid === m\.cid\) \{ H\.job = null; clearTimeout\(flatTimer\); \}[\s\S]{0,200}'Refused by ChartBridge: ' \+ String\(m\.reason \|\| 'no reason given'\)\.replace\(\/\\\.\+\$\/, ''\) \+ '\. Nothing was flattened; he stays on \(' \+ AH\.modeWord\(a && a\.mode\) \+ '\)\.';/);
  assert.ok(!/Flatten and turn off sent: ChartBridge puts him in Shadow and flattens what he owns/.test(js), 'the old words that said Shadow before ChartBridge did are gone');
});

test('the R12 delta of plan step 3.2, X4: the traders being turned off are shared by every window of this origin, and storage that fails never throws', () => {
  let t = 5000000;
  const now = () => t;
  /* a made-up browser: one localStorage for the origin, and a BroadcastChannel bus between the windows */
  const mem = () => { const m = new Map(); return { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };
  const bus = () => { const ends = []; return () => { const c = { onmessage: null, postMessage: d => { for (const o of ends) if (o !== c && o.onmessage) o.onmessage({ data: JSON.parse(JSON.stringify(d)) }); } }; ends.push(c); return c; }; };
  const ls = mem(), chan = bus();
  const A = AH.createTurnShare({ storage: () => ls, channel: chan, now, token: 'wa' }), B = AH.createTurnShare({ storage: () => ls, channel: chan, now, token: 'wb' });
  assert.deepEqual([A.list(), B.list()], [[], []]);
  A.set(['legion1']);
  assert.deepEqual([A.list(), B.list()], [['legion1'], ['legion1']], 'window B sees what window A is turning off (its channel at once)');
  const Bs = AH.createTurnShare({ storage: () => ls, now, token: 'ws' });   // a window with storage only, no channel
  assert.deepEqual(Bs.list(), ['legion1'], 'and storage alone says it too');
  assert.ok([...ls.m.keys()].every(k => k.startsWith(AH.TURN_KEY)), 'its own key: ' + [...ls.m.keys()]);
  B.set(['legion1', 'legion2']);
  A.set([]);
  assert.deepEqual([A.list().sort(), B.list().sort()], [['legion1', 'legion2'], ['legion1', 'legion2']], 'A ends its job: B\'s own entry for legion1 stays');
  B.set([]);
  assert.deepEqual([A.list(), B.list()], [[], []], 'both ended');
  t += AH.TURN_SCAN_MS;
  assert.deepEqual(Bs.list(), [], 'storage alone: gone at its next read (at most TURN_SCAN_MS later)');
  /* a window closed mid-wait: its entry goes TURN_TTL_MS after its last write, and is cleaned away */
  A.set(['legion1']);
  t += AH.TURN_TTL_MS - 1;
  assert.deepEqual(B.list(), ['legion1']);
  t += 2;
  assert.deepEqual(B.list(), [], 'not written again in time: gone');
  t += AH.TURN_SCAN_MS; B.list();
  assert.equal(ls.m.size, 0, 'and its entry removed');
  /* storage is read at most once each TURN_SCAN_MS, however often a page asks */
  let reads = 0; const counted = { get length() { reads++; return 0; }, key: () => null, getItem: () => null, setItem() {}, removeItem() {} };
  const R = AH.createTurnShare({ storage: () => counted, now, token: 'wr' });
  for (let i = 0; i < 50; i++) R.list();
  assert.equal(reads, 1); t += AH.TURN_SCAN_MS; R.list(); assert.equal(reads, 2);
  /* storage that cannot be used: no throw; this window's own, and what the channel said */
  const bad = { get length() { throw new Error('denied'); }, key() { throw new Error('denied'); }, getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const chan2 = bus();
  const C = AH.createTurnShare({ storage: () => bad, channel: chan2, now, token: 'wc' }), D = AH.createTurnShare({ storage: () => { throw new Error('SecurityError'); }, channel: chan2, now, token: 'wd' });
  assert.doesNotThrow(() => C.set(['legion1']));
  assert.deepEqual([C.list(), D.list()], [['legion1'], ['legion1']], 'storage blocked: the channel still carries it');
  const E = AH.createTurnShare({ storage: () => null, channel: () => { throw new Error('no channel'); }, now, token: 'we' });
  assert.doesNotThrow(() => E.set(['legion3']));
  assert.deepEqual(E.list(), ['legion3'], 'neither: this window\'s own only');
  assert.deepEqual(AH.createTurnShare().list(), [], 'nothing given: an empty list, no throw');
  /* odd entries are never read as a trader */
  ls.setItem(AH.TURN_KEY + 'wx:Not-An-Id', JSON.stringify({ until: t + 5000 })); ls.setItem(AH.TURN_KEY + 'wx:legion9', 'not json');
  t += AH.TURN_SCAN_MS;
  assert.deepEqual(B.list(), []);
  /* a channel word for a past time takes the trader off */
  const F2 = AH.createTurnShare({ storage: () => null, channel: chan2, now, token: 'wf' });
  C.set([]);
  assert.deepEqual(F2.list(), [], 'C said it ended');
});
