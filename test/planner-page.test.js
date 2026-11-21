'use strict';
// The planner on the chart page (chart 1.62.0, live/planner.js, mounted by live/workspace.js): what can be read from the source.
// The page itself runs in test/planner-smoke.mjs, planner-windows-smoke.mjs and planner-resume-smoke.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('loaded before the workspace (its rules first), installed, and optional (a window without it trades as before)', () => {
  const html = read('live/index.html'), i = s => html.indexOf('<script src="' + s + '"></script>');
  assert.ok(i('planner-core.js') > 0 && i('planner-core.js') < i('planner.js') && i('planner.js') < i('workspace.js'));
  const www = JSON.parse(read('nt8/install-files.json')).www;
  for (const f of ['planner-core.js', 'planner.js']) assert.ok(www.some(x => x.from === 'live/' + f && x.to === f), f + ' installed');
  const ws = read('live/workspace.js');
  assert.match(ws, /startGuard\('Planner', startPlanner\);/);
  assert.match(ws, /if \(!window\.PlannerPage \|\| !window\.PlannerCore \|\| !window\.AccountsPage\) return;/);
  assert.doesNotMatch(ws.slice(ws.indexOf('const ok = () =>'), ws.indexOf('const ok = () =>') + 200), /Planner/, 'the page starts without it');
});

test('the planner sends entries only through sendPlanOrder and cancels only through cancelPlanOrder; never the ticket\'s paths', () => {
  const src = read('live/planner.js');
  for (const bad of ['sendOrder(', 'placeAt(', 'placeChecked(', 'core.ready(', 'setArmed(true', 'flattenHere(', 'flattenAll(', 'cutHalf(', 'env.send(', 'core.send(']) assert.ok(!src.includes(bad), 'planner.js never calls ' + bad);
  assert.equal((src.match(/core\.sendPlanOrder\(/g) || []).length, 1, 'one send site');
  assert.match(src, /if \(!journal\.mark\(p\.uid, cid\)\) \{[^\n]*return; \}\n    const r = core\.sendPlanOrder\(/, 'the send journal is written before the send, and a failed write sends nothing');
  assert.match(src, /core\.setArmed\(false\)/, 'the light lock turns the ticket\'s Armed off');
});

test('writing: no em or en dashes in the planner\'s files', () => {
  for (const f of ['live/planner.js', 'live/planner-core.js', 'test/planner-core.test.js', 'test/planner-trade.test.js', 'test/plan-layer.test.js']) assert.ok(!/[–—]/.test(read(f)), f);
});
