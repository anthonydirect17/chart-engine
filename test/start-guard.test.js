// Release 1 (the start guard, the lock of 2026-11-15, topic 2): the charts and the order ticket start first, and each automation
// tab (the Bot, the Agent, the Colosseum, Legion, Praetorian's button) starts inside its own guard, so one tab that throws cannot
// stop the charts, the ticket or another tab. The page's own start code (live/workspace.js: startGuard and start) is cut out
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
    openPraetorian: part('openPraetorian'), syncLeagueGhosts: part('syncLeagueGhosts'), syncChartTab: part('syncChartTab'),
  };
  const names = Object.keys(env);
  /* the tabs' start functions as the page has them: each sets its desk once its part ran (a part that throws leaves it null) */
  const failed = new Function(...names, 'part', 'mk', GUARD + '\nlet botDesk = null, agentDesk = null, leagueView = null, fleetView = null;\n' +
    'const startBot = () => { part("startBot")(); botDesk = mk("bot"); };\n' +
    'const startAgent = () => { part("startAgent")(); agentDesk = mk("agent"); };\n' +
    'const startLeague = () => { part("startLeague")(); leagueView = mk("league"); };\n' +
    'const startFleet = () => { part("startFleet")(); fleetView = mk("fleet"); };\n' +
    START + '\nstart();\nreturn START_FAILED;')(...names.map(n => env[n]), part, desk);
  return { ran, notes, errors, buttons, failed };
}

test('the start order: the layout, the ticket\'s connection and the ticket first; then each tab in its own guard', () => {
  const r = run([]);
  assert.deepStrictEqual(r.ran.slice(0, 3), ['openLayout', 'tconnect', 'autoTake'], 'the charts and the ticket first');
  assert.deepStrictEqual(r.ran.slice(3), ['startBot', 'bot.layoutChanged', 'bot.chartsChanged', 'startAgent', 'agent.layoutChanged', 'startLeague', 'startFleet', 'syncLeagueGhosts', 'syncChartTab'],
    'then the tabs, each told the layout the charts opened on');
  assert.strictEqual(r.notes.length, 0, 'nothing said when every tab starts');
  assert.strictEqual(r.failed.size, 0);
});

test('one tab that throws: the charts, the ticket and every other tab still start; the tab is named once and its button hidden', () => {
  for (const [part, name, btn] of [['startBot', 'Bot tab', 'wsBotTab'], ['startAgent', 'Agent tab', 'wsAgentTab'], ['startLeague', 'Colosseum tab', 'wsLeagueTab'], ['startFleet', 'Legion tab', 'wsFleetTab']]) {
    const r = run([part]);
    assert.deepStrictEqual(r.ran.slice(0, 3), ['openLayout', 'tconnect', 'autoTake'], part + ': the charts and the ticket started');
    for (const other of ['startBot', 'startAgent', 'startLeague', 'startFleet', 'syncLeagueGhosts', 'syncChartTab']) assert.ok(r.ran.includes(other), part + ' broken: ' + other + ' still ran');
    assert.deepStrictEqual([...r.failed.keys()], [name], part + ': only its tab failed');
    assert.strictEqual(r.notes.length, 1, part + ': said once');
    assert.match(r.notes[0].t, new RegExp('^The ' + name + ' did not start: the charts and the ticket work; reload this window to try it again\\.$'));
    assert.strictEqual(r.notes[0].warn, true);
    assert.strictEqual(r.errors.length, 1, 'and in the console');
    assert.strictEqual(r.buttons[btn].hidden, true, part + ': its button hidden');
    for (const b of ['wsBotTab', 'wsAgentTab', 'wsLeagueTab', 'wsFleetTab'].filter(x => x !== btn)) assert.ok(!r.buttons[b] || r.buttons[b].hidden === false, b + ' left as it was');
  }
});

test('every tab throws: the charts and the ticket still start, and the rest of start runs to its end', () => {
  const r = run(['startBot', 'startAgent', 'startLeague', 'startFleet', 'syncLeagueGhosts', 'syncChartTab']);
  assert.deepStrictEqual(r.ran.slice(0, 3), ['openLayout', 'tconnect', 'autoTake']);
  assert.ok(r.ran.includes('syncChartTab'), 'start ran to its end');
  assert.strictEqual(r.failed.size, 6);
  assert.strictEqual(r.notes.length, 6, 'each failed part said once');
  assert.strictEqual(r.notes[5].t, 'The Bot tab, Agent tab, Colosseum tab, Legion tab, Colosseum marks and Praetorian button did not start: the charts and the ticket work; reload this window to try it again.', 'the last note names every part that failed');
});

test('a tab that starts but throws when told the layout, or when opened from the address, leaves the others', () => {
  let r = run(['bot.layoutChanged']);
  assert.ok(r.ran.includes('startAgent') && r.ran.includes('startFleet'), 'the others started');
  assert.deepStrictEqual([...r.failed.keys()], ['Bot tab']);
  r = run(['agent.showTab'], 'agent');
  assert.ok(r.ran.includes('agent.showTab') && r.ran.includes('syncChartTab'), '?tab=agent tried, the rest ran');
  assert.deepStrictEqual([...r.failed.keys()], ['Agent tab']);
  r = run(['league.openDay'], 'colosseum');
  assert.ok(r.ran.includes('league.openDay') && r.ran.includes('syncChartTab'));
  assert.deepStrictEqual([...r.failed.keys()], ['Colosseum tab']);
});

test('the guard in the source: every tab start, the tabs\' hello and a layout change go through it; nothing starts a tab outside start', () => {
  for (const f of ['startBot', 'startAgent', 'startLeague', 'startFleet']) {
    const calls = [...ws.matchAll(new RegExp('\\b' + f + '\\b(?!\\s*\\(\\)\\s*\\{)', 'g'))].map(m => ws.slice(ws.lastIndexOf('\n', m.index) + 1, ws.indexOf('\n', m.index)));
    const uses = calls.filter(l => !/^function /.test(l));
    assert.ok(uses.length >= 1, f + ' is called');
    for (const l of uses) assert.match(l, /startGuard\('/, f + ' is called inside a guard: ' + l.trim());
  }
  const hello = piece("case 'hello':", 'return;');
  for (const d of ['botDesk', 'agentDesk', 'fleetView']) assert.match(hello, new RegExp('if \\(' + d + '\\) startGuard\\(\'[A-Za-z]+ tab\', \\(\\) => ' + d + '\\.hello\\(m\\)\\);'), d + ' hears hello inside its guard');
  assert.ok(hello.indexOf('core.hello(m);') < hello.indexOf('startGuard('), 'the ticket hears hello before any tab');
  const openLayout = piece('function openLayout(name) {', '\n}\n');
  assert.ok(openLayout.indexOf('renderOrders();') < openLayout.indexOf('startGuard('), 'a layout change places the charts and the ticket before it tells the tabs');
  assert.strictEqual((openLayout.match(/startGuard\(/g) || []).length, 4, 'each of the four tabs told inside its own guard');
  // the links the tabs are handed are built inside a guard too (a throw there leaves the tabs with no connection: the careful side)
  assert.match(ws, /startGuard\('Praetorian link', \(\) => \{\n  praetorianLink = /);
  assert.match(ws, /startGuard\('Legion helper link', \(\) => \{/);
  assert.match(ws, /if \(PIN\) PIN\.gate\(\)\.then\(start\); else start\(\);/, 'the page starts the same way');
});
