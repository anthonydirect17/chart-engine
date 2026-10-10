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

test('a build that is not a hero keeps the mode at Shadow on Sim; a hero is free', () => {
  assert.deepEqual(AH.modeBlock(STATUS.agents.demo), { copilot: 'sample-build-2 is not a hero: Shadow on a Sim account only.', auto: 'sample-build-2 is not a hero: Shadow on a Sim account only.' });
  assert.deepEqual(AH.modeBlock(Object.assign({}, STATUS.agents.demo, { hero: 'Demo' })), { copilot: null, auto: null });
  assert.deepEqual(AH.modeBlock(Object.assign({}, STATUS.agents.demo, { running: false })), { copilot: null, auto: null });
  assert.deepEqual(AH.modeBlock(null), { copilot: null, auto: null });
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

test('the spend readout and the words under On/Off', () => {
  assert.deepEqual(AH.spendText(STATUS.agents.demo.spend), { session: '$1.84', overall: '$1,234.50' });
  assert.deepEqual(AH.spendText(null), { session: '-', overall: '-' });
  assert.equal(AH.usd(0), '$0.00');
  assert.match(AH.stateText(null, 'down'), /PC helper is not running on this PC/);
  assert.match(AH.stateText(null, 'locked'), /PIN/);
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
  r = await c.on('demo', 'sample-build-1');
  assert.equal(calls[1].url, 'http://localhost:8767/on');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].init.body), { agent: 'demo', build: 'sample-build-1' });
  answers.push({ status: 409, body: { error: 'demo runs sample-build-2: turn him Off first' } });
  r = await c.on('demo', 'sample-build-1');
  assert.deepEqual(r, { reach: 'refused', body: { error: 'demo runs sample-build-2: turn him Off first' } });
  answers.push({ status: 401, body: { error: 'unlock' } });
  assert.equal((await c.off('demo')).reach, 'locked');
  assert.deepEqual(JSON.parse(calls[3].init.body), { agent: 'demo' });
  answers.push('throw');
  assert.equal((await c.status()).reach, 'down');
  answers.push({ status: 200, body: { ok: true } });
  await c.settings({ agent: 'demo', autoOn: '09:30', cap: 5 });
  assert.equal(calls[5].url, 'http://localhost:8767/settings');
});

test('wiring: loaded before agent.js on both pages, installed, the workspace passes its Flatten, no dashes', () => {
  for (const f of ['index.html', 'agent.html']) {
    const h = read('live', f);
    assert.ok(h.indexOf('agent-helper.js') > 0 && h.indexOf('agent-helper.js') < h.indexOf('src="agent.js"'), f);
  }
  const to = JSON.parse(read('nt8', 'install-files.json')).www.map(f => f.to);
  assert.ok(to.includes('agent-helper.js'));
  assert.match(read('live', 'workspace.js'), /flatten: \(account, root\) => core\.flattenAgent\(account, root\)/);
  assert.match(read('live', 'trade.js'), /function flattenAgent\(account, R\)/);
  for (const f of ['live/agent-helper.js', 'test/agent-helper.test.js']) assert.doesNotMatch(read(f), /[\u2013\u2014]/, f);
  /* the page never builds an order for the agent: the only order On/Off can cause is the page's own Flatten */
  const js = read('live', 'agent-helper.js');
  assert.doesNotMatch(js, /type: ?'(order|flatten|agentAnswer)'/);
});
