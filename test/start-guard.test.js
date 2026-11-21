// Release 1 (the start guard, the lock of 2026-11-15, topic 2): the charts and the order ticket start first, and each automation
// part starts inside its own guard, so one that throws cannot stop the charts, the ticket or another part. Plan step 3.2: Legion,
// the Colosseum and Praetorian's Agent tab moved to Legion's own page (legion.html, its own guard there: test/legion-smoke.mjs);
// the chart page starts the Bot tab, the Agent desk with no view, and the Chart button. The page's own start code (live/workspace.js: startGuard and start) is cut out
// and run here against stand-ins; npm run smoke:start-guard runs the real page with each tab broken.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ws = fs.readFileSync(path.join(__dirname, '..', 'live', 'workspace.js'), 'utf8');
/* a piece of the source from its first line to the first line after it that starts with `end` */
function piece(start, end) {
  const i = ws.indexOf(start);
  assert.ok(i >= 0, 'workspace.js has ' + start);
  const j = ws.indexOf(end, i);
  assert.ok(j > i, 'and its end');
  return ws.slice(i, j + end.length);
}
const GUARD = piece('const START_FAILED = new Map();', '\n}\n');
const START = piece('const start = () => {', '\n};\n');

/* the page's start, run with stand-ins: `broken` names the parts that throw; returns what ran, in order, and what was said */
function run(broken, tab) {
  const ran = [], notes = [], errors = [], buttons = {};
  const part = name => () => { ran.push(name); if (broken.includes(name)) throw new Error(name + ' broke'); };
  const desk = name => ({ layoutChanged: part(name + '.layoutChanged'), chartsChanged: part(name + '.chartsChanged'), showTab: part(name + '.showTab'), openDay: part(name + '.openDay') });
  const env = {
    $: id => (buttons[id] = buttons[id] || { hidden: false }),
    note: (t, warn) => notes.push({ t, warn }),
    console: { error: (m) => errors.push(m) },
    location: { search: tab ? '?tab=' + tab : '' },
    URLSearchParams,
    W: { DEFAULT_NAME: 'Main' },
    layout: 'Main',
    openLayout: part('openLayout'), tconnect: part('tconnect'), autoTake: part('autoTake'),
    syncChartTab: part('syncChartTab'),
  };
  const names = Object.keys(env);
  /* the tabs' start functions as the page has them: each sets its desk once its part ran (a part that throws leaves it null) */
  const failed = new Function(...names, 'part', 'mk', GUARD + '\nlet botDesk = null, agentDesk = null, leagueView = null, fleetView = null;\n' +
    'const startBot = () => { part("startBot")(); botDesk = mk("bot"); };\n' +
    'const startAgent = () => { part("startAgent")(); agentDesk = mk("agent"); };\n' +
    'const startLeague = () => { part("startLeague")(); leagueView = mk("league"); };\n' +
    'const startFleet = () => { part("startFleet")(); fleetView = mk("fleet"); };\n' +
    'const startPlanner = () => { part("startPlanner")(); };\n' +   // 1.62.0: the planner, last
    START + '\nstart();\nreturn START_FAILED;')(...names.map(n => env[n]), part, desk);
  return { ran, notes, errors, buttons, failed };
}

test('the start order: the layout, the ticket\'s connection and the ticket first; then each part in its own guard', () => {
  const r = run([]);
  assert.deepStrictEqual(r.ran.slice(0, 3), ['openLayout', 'tconnect', 'autoTake'], 'the charts and the ticket first');
  assert.deepStrictEqual(r.ran.slice(3), ['startBot', 'bot.layoutChanged', 'bot.chartsChanged', 'startAgent', 'agent.layoutChanged', 'syncChartTab', 'startPlanner'],
    'then the Bot tab and the Agent desk, each told the layout the charts opened on, then the Chart button, then the planner (1.62.0)');
  assert.strictEqual(r.notes.length, 0, 'nothing said when every part starts');
  assert.strictEqual(r.failed.size, 0);
});

test('one part that throws: the charts, the ticket and every other part still start; it is named once (the Bot tab\'s button hidden)', () => {
  for (const [part, name, btn] of [['startBot', 'Bot tab', 'wsBotTab'], ['startAgent', 'Agent desk', null], ['startPlanner', 'Planner', null]]) {
    const r = run([part]);
    assert.deepStrictEqual(r.ran.slice(0, 3), ['openLayout', 'tconnect', 'autoTake'], part + ': the charts and the ticket started');
    for (const other of ['startBot', 'startAgent', 'syncChartTab', 'startPlanner']) assert.ok(r.ran.includes(other), part + ' broken: ' + other + ' still ran');
    assert.deepStrictEqual([...r.failed.keys()], [name], part + ': only its part failed');
    assert.strictEqual(r.notes.length, 1, part + ': said once');
    assert.match(r.notes[0].t, new RegExp('^The ' + name + ' did not start: the charts and the ticket work; reload this window to try it again\\.$'));
    assert.strictEqual(r.notes[0].warn, true);
    assert.strictEqual(r.errors.length, 1, 'and in the console');
    if (btn) assert.strictEqual(r.buttons[btn].hidden, true, part + ': its button hidden');
  }
});

test('every part throws: the charts and the ticket still start, and the rest of start runs to its end', () => {
  const r = run(['startBot', 'startAgent', 'syncChartTab', 'startPlanner']);
  assert.deepStrictEqual(r.ran.slice(0, 3), ['openLayout', 'tconnect', 'autoTake']);
  assert.ok(r.ran.includes('syncChartTab') && r.ran.includes('startPlanner'), 'start ran to its end');
  assert.strictEqual(r.failed.size, 4);
  assert.strictEqual(r.notes.length, 4, 'each failed part said once');
  assert.strictEqual(r.notes[3].t, 'The Bot tab, Agent desk, Chart button and Planner did not start: the charts and the ticket work; reload this window to try it again.', 'the last note names every part that failed');
});

test('a part that starts but throws when told the layout, or the Bot tab opened from the address, leaves the others', () => {
  let r = run(['bot.layoutChanged']);
  assert.ok(r.ran.includes('startAgent') && r.ran.includes('syncChartTab'), 'the others started');
  assert.deepStrictEqual([...r.failed.keys()], ['Bot tab']);
  r = run(['bot.showTab'], 'bot');
  assert.ok(r.ran.includes('bot.showTab') && r.ran.includes('syncChartTab'), '?tab=bot tried, the rest ran');
  assert.deepStrictEqual([...r.failed.keys()], ['Bot tab']);
});

test('the guard in the source: every part start, the hello and a layout change go through it; the moved tabs forward to Legion before start', () => {
  for (const f of ['startBot', 'startAgent', 'startPlanner']) {
    const calls = [...ws.matchAll(new RegExp('\\b' + f + '\\b(?!\\s*\\(\\)\\s*\\{)', 'g'))].map(m => ws.slice(ws.lastIndexOf('\n', m.index) + 1, ws.indexOf('\n', m.index)));
    const uses = calls.filter(l => !/^function /.test(l));
    assert.ok(uses.length >= 1, f + ' is called');
    for (const l of uses) assert.match(l, /startGuard\('/, f + ' is called inside a guard: ' + l.trim());
  }
  assert.doesNotMatch(ws, /\bstartLeague\b|\bstartFleet\b/, 'plan step 3.2: the Colosseum and Legion start on Legion\'s page');
  const hello = piece("case 'hello':", 'return;');
  for (const d of ['botDesk', 'agentDesk']) assert.match(hello, new RegExp('if \\(' + d + '\\) startGuard\\(\'[A-Za-z]+ tab\', \\(\\) => ' + d + '\\.hello\\(m\\)\\);'), d + ' hears hello inside its guard');
  assert.ok(hello.indexOf('core.hello(m);') < hello.indexOf('startGuard('), 'the ticket hears hello before any part');
  const openLayout = piece('function openLayout(name) {', '\n}\n');
  assert.ok(openLayout.indexOf('renderOrders();') < openLayout.indexOf('startGuard('), 'a layout change places the charts and the ticket before it tells the parts');
  assert.strictEqual((openLayout.match(/startGuard\(/g) || []).length, 2, 'the Bot tab and the Agent desk told inside their own guards');
  assert.match(ws, /startGuard\('Praetorian link', \(\) => \{\n  praetorianLink = /);
  assert.match(ws, /if \(LEGION_TABS\.includes\(movedTab\) && !prBotLast\) location\.replace\('legion\.html' \+ location\.search \+ location\.hash\);\nelse if \(PIN\) PIN\.gate\(\)\.then\(start\); else start\(\);/, 'the page starts the same way, after forwarding a moved tab');
});

test('the R12 review of plan step 3.2, N4: an old ?tab=praetorian opens the side used last (the Bot tab here, else Praetorian on Legion)', () => {
  const ws = fs.readFileSync(path.join(__dirname, '..', 'live', 'workspace.js'), 'utf8');
  assert.match(ws, /const PR_SIDE_KEY = 'live-praetorian-side-v1';/, '1.51.0\'s key, kept');
  assert.match(ws, /const prBotLast = movedTab === 'praetorian' && store\.getItem\(PR_SIDE_KEY\) === 'bot' && !new URLSearchParams\(location\.search\)\.has\('agent'\);[^\n]*\nif \(prBotLast\) \{ try \{ const q = new URLSearchParams\(location\.search\); q\.set\('tab', 'bot'\);/, 'the Bot last: ?tab=bot here');
  assert.match(ws, /if \(on\) \{ closePops\(\); restoreMax\(\); store\.setItem\(PR_SIDE_KEY, 'bot'\); \}/, 'the Bot tab writes it');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'live', 'legion-tabs.js'), 'utf8'), /onTab: on => \{ if \(on\) \{ try \{ store\.setItem\('live-praetorian-side-v1', 'agent'\); \}/, 'Legion\'s Praetorian side writes the Agent');
});
