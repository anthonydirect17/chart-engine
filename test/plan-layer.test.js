'use strict';
// The plan layer (chart 1.62.0, the planner): the engine's pure helpers for a plan drawn on the chart (cleanPlan, planGeometry,
// planDragTo, planLabels). The drawing and the mouse are in test/plan-layer-smoke.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const CE = require('../src/chart-engine.js');
const U = CE.util;

test('cleanPlan: an id and an entry are needed; side long unless short; unknown states are draft; editable only when true', () => {
  assert.equal(U.cleanPlan(null), null);
  assert.equal(U.cleanPlan({ id: 'a' }), null, 'no entry');
  assert.equal(U.cleanPlan({ id: '', entry: 1 }), null, 'an empty id');
  const p = U.cleanPlan({ id: 7, entry: 100, stop: 'x', target: 104, state: 'weird', editable: 1, qty: 2.5, label: 'L'.repeat(80) });
  assert.deepEqual([p.id, p.side, p.stop, p.target, p.state, p.editable, p.qty, p.label.length, p.t0], ['7', 'long', null, 104, 'draft', false, null, 48, null]);
  assert.equal(U.cleanPlan({ id: 'b', entry: 1, side: 'short', state: 'armed', editable: true }).side, 'short');
  for (const s of U.PLAN_STATES) assert.equal(U.cleanPlan({ id: 'c', entry: 1, state: s }).state, s);
});

test('planGeometry: risk and reward in whole ticks from the entry, the ratio; a line on the wrong side counts as none', () => {
  assert.deepEqual(U.planGeometry({ side: 'long', entry: 100, stop: 96, target: 108 }, 0.25), { riskTicks: 16, rewardTicks: 32, rr: 2 });
  assert.deepEqual(U.planGeometry({ side: 'short', entry: 100, stop: 101.5, target: 97 }, 0.25), { riskTicks: 6, rewardTicks: 12, rr: 2 });
  assert.deepEqual(U.planGeometry({ side: 'long', entry: 100, stop: 101, target: null }, 0.25), { riskTicks: null, rewardTicks: null, rr: null });
  assert.deepEqual(U.planGeometry({ side: 'short', entry: 100, stop: 99, target: 98 }, 0.25), { riskTicks: null, rewardTicks: 8, rr: null });
});

test('planDragTo: the entry carries the stop and target; the stop and target stay a tick on their own side; on the tick', () => {
  const L = { side: 'long', entry: 100, stop: 96, target: 108 }, S = { side: 'short', entry: 100, stop: 102, target: 95 };
  assert.deepEqual(U.planDragTo(L, 'entry', 101.1, 0.25), { entry: 101, stop: 97, target: 109 });
  assert.deepEqual(U.planDragTo(L, 'stop', 95.3, 0.25), { entry: 100, stop: 95.25, target: 108 });
  assert.deepEqual(U.planDragTo(L, 'stop', 104, 0.25), { entry: 100, stop: 99.75, target: 108 }, 'a long\'s stop stops a tick under the entry');
  assert.deepEqual(U.planDragTo(L, 'target', 90, 0.25), { entry: 100, stop: 96, target: 100.25 }, 'its target a tick over it');
  assert.deepEqual(U.planDragTo(S, 'stop', 97, 0.25), { entry: 100, stop: 100.25, target: 95 }, 'a short\'s stop a tick over the entry');
  assert.deepEqual(U.planDragTo(S, 'target', 103, 0.25), { entry: 100, stop: 102, target: 99.75 });
  assert.deepEqual(U.planDragTo({ side: 'long', entry: 100, stop: null, target: null }, 'entry', 99, 0.25), { entry: 99, stop: null, target: null });
});

test('planLabels: the host\'s label and note on the entry; ticks, dollars with a point value and qty, and the ratio on the target', () => {
  const p = U.cleanPlan({ id: 'a', side: 'long', entry: 100, stop: 96, target: 108, qty: 2, label: 'Plan #3 LONG LMT 2', note: 'armed' });
  assert.deepEqual(U.planLabels(p, 0.25, 2), { entry: 'Plan #3 LONG LMT 2  armed', stop: 'SL -16t $16', target: 'TP +32t $32  2.0R' });
  assert.deepEqual(U.planLabels(Object.assign({}, p, { qty: null }), 0.25, 2), { entry: 'Plan #3 LONG LMT 2  armed', stop: 'SL -16t', target: 'TP +32t  2.0R' });
  assert.deepEqual(U.planLabels(Object.assign({}, p, { stop: 101, target: null }), 0.25, 0), { entry: 'Plan #3 LONG LMT 2  armed', stop: 'SL wrong side', target: '' });
});

test('the plan layer stays apart from the drawings: setTool takes plan, setDrawings never keeps a plan (source)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'chart-engine.js'), 'utf8');
  assert.match(src, /setTool\(t\) \{ setToolInternal\(t === 'hline' \|\| t === 'trend' \|\| t === 'zone' \|\| t === 'plan' \? t : null\); \}/);
  assert.match(src, /setDrawings\(list\) \{ drawings = \(list \|\| \[\]\)\.filter\(d => d && \(d\.type === 'hline' \|\| d\.type === 'trend' \|\| d\.type === 'zone'\)\)/);
  for (const ev of ['planMove', 'planSelect', 'planPressOff', 'planCreate']) assert.ok(src.includes(ev + ': []'), ev);
  assert.ok(!/planMove[^\n]*send\(/.test(src), 'the engine sends no order for a plan');
});
