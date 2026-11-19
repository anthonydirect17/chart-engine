'use strict';
// Legion, the app for bots and agents (plan step 3.2): its own page (live/legion.html), the five tabs, Stop all automation in the
// header of every tab, the tabs moved from the chart page with their own gates, and the ChartBridge commands for the steps a closed
// page must never leave half done (agentStopAll, agentFlattenOff). test/legion-smoke.mjs runs the page in a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...f) => fs.readFileSync(path.join(root, ...f), 'utf8');
const L = require('../live/legion.js');
const AC = require('../live/agent-core.js');
const www = JSON.parse(read('nt8', 'install-files.json')).www;

test('the five tabs in Anthony\'s order, each with its Roman numeral', () => {
  assert.deepEqual(L.TABS.map(t => t.name + ' ' + t.rn), ['Castra I', 'Cohorts II', 'Colosseum III', 'Ludus IV', 'Go live V']);
  assert.ok(Object.isFrozen(L.TABS) && L.TABS.every(Object.isFrozen));
  for (let i = 0; i < L.TABS.length; i++) assert.equal(L.roman(i + 1), L.TABS[i].rn);
  assert.equal(L.roman(1999), 'MCMXCIX'); assert.equal(L.roman(44), 'XLIV');
  for (const bad of [0, -1, 4000, 1.5, NaN, '3', null]) assert.equal(L.roman(bad), '', String(bad));
});

test('the address: each tab, Castra by default, and the chart page\'s old words land where the tab moved', () => {
  assert.deepEqual(L.tabFrom(''), { tab: 'castra', sub: '' });
  assert.deepEqual(L.tabFrom('?tab=nonsense'), { tab: 'castra', sub: '' });
  for (const t of L.TAB_IDS) assert.equal(L.tabFrom('?tab=' + t).tab, t);
  assert.deepEqual(L.tabFrom('?tab=cohorts'), { tab: 'cohorts', sub: 'legion' });
  assert.deepEqual(L.tabFrom('?tab=cohorts&sub=praetorian'), { tab: 'cohorts', sub: 'praetorian' });
  assert.deepEqual(L.tabFrom('?tab=cohorts&sub=bogus'), { tab: 'cohorts', sub: 'legion' });
  assert.deepEqual(L.tabFrom('?tab=legion'), { tab: 'cohorts', sub: 'legion' });
  assert.deepEqual(L.tabFrom('?tab=league&day=2026-01-05'), { tab: 'colosseum', sub: '' });
  assert.deepEqual(L.tabFrom('?tab=agent'), { tab: 'cohorts', sub: 'praetorian' });
  assert.deepEqual(L.tabFrom('?tab=praetorian'), { tab: 'cohorts', sub: 'praetorian' });
  assert.equal(L.tabSearch('?tab=castra&layout=X', 'cohorts', 'praetorian'), '?tab=cohorts&layout=X&sub=praetorian');
  assert.equal(L.tabSearch('?tab=colosseum&day=2026-01-05', 'colosseum', ''), '?tab=colosseum&day=2026-01-05', 'a past day stays on the Colosseum');
  assert.equal(L.tabSearch('?tab=colosseum&day=2026-01-05', 'ludus', ''), '?tab=ludus', 'and leaves with it');
  assert.equal(L.tabSearch('?sub=praetorian', 'golive', 'praetorian'), '?tab=golive', 'sub only on Cohorts');
});

test('Stop all: what it can send by ChartBridge\'s version, and why not otherwise', () => {
  assert.equal(L.STOPALL_MIN, '0.6.25');
  assert.equal(L.stopPlan('0.6.25', false, false).ok, false);
  assert.match(L.stopPlan('0.6.25', false, false).why, /Not connected/);
  assert.match(L.stopPlan('0.6.25', true, false).why, /Not signed in/);
  assert.deepEqual(L.stopPlan('0.6.25', true, true), { kind: 'stopAll', ok: true, why: '', note: '' });
  assert.equal(L.stopPlan('0.7.0', true, true).kind, 'stopAll');
  const old = L.stopPlan('0.6.24', true, true);
  assert.equal(old.kind, 'killAll'); assert.ok(old.ok);
  assert.match(old.note, /own prop rule only .* not by the account ledger/, 'an older ChartBridge: said plainly that the ledger is not covered');
  assert.equal(L.stopPlan('0.6.17', true, true).kind, 'killAll');
  for (const v of ['0.6.16', '', 'fake-0.6.25', null]) { const p = L.stopPlan(v, true, true); assert.equal(p.ok, false, String(v)); assert.match(p.why, /has no Stop all/); }
});

test('one version rule (the R12 delta, X3): agent-core.js, fleet.js and legion.js the same text, a.b.c only; ChartBridge.cs writes a.b.c', () => {
  const FC = require('../live/fleet.js');
  /* the rule's own lines, word for word the same in the three files (the version gates of Stop all, Kill all and Flatten and turn off) */
  const rule = f => { const s = read('live', f), i = s.indexOf('function parseVersion(v)'), j = s.indexOf('\n}\n', s.indexOf('function atLeast(', i)); assert.ok(i > 0 && j > i, f); return s.slice(i, j + 3); };
  assert.equal(rule('fleet.js'), rule('agent-core.js'), 'fleet.js and agent-core.js');
  assert.equal(rule('legion.js'), rule('agent-core.js'), 'legion.js and agent-core.js');
  const cases = [['0.6.25', '0.6.25', true], ['0.6.26', '0.6.25', true], ['0.7.0', '0.6.25', true], ['1.0.0', '0.6.25', true], ['0.6.24', '0.6.25', false],
    ['0.6.25-rc1', '0.6.25', false], ['v0.6.25', '0.6.25', false], ['fake-0.6.25', '0.6.25', false], ['0.6.25 ', '0.6.25', false], ['0.6.25.1', '0.6.25', false], ['0.7', '0.6.25', false],
    ['', '0.6.25', false], [null, '0.6.25', false], [undefined, '0.6.25', false], [625, '0.6.25', false], [['0.6.25'], '0.6.25', false], ['0.6.25', 'x', false]];
  for (const [v, min, want] of cases) assert.deepEqual([L.atLeast(v, min), FC.atLeast(v, min), AC.atLeast(v, min)], [want, want, want], JSON.stringify([v, min]));
  /* so Stop all (legion.js), Kill all (fleet.js) and Flatten and turn off (agent-core.js) agree about every ChartBridge */
  for (const v of ['0.6.25', '0.6.24', '0.6.25-rc1', 'v0.6.25', '0.7']) assert.equal(L.stopPlan(v, true, true).kind === 'stopAll', AC.atLeast(v, AC.FLATOFF_MIN), v);
  const cb = /public const string Version = "([^"]*)";/.exec(read('nt8', 'ChartBridge.cs'));
  assert.ok(cb, 'ChartBridge.cs names its Version');
  assert.match(cb[1], /^\d+\.\d+\.\d+$/, 'ChartBridge says its version as a.b.c, the only form the page takes');
});

test('Stop all: one message with exactly its keys, and the header\'s gate passes those two and nothing else', () => {
  assert.deepEqual(L.stopMsg('stopAll', 'c1'), { type: 'agentStopAll', cid: 'c1' });
  assert.deepEqual(L.stopMsg('killAll', 'c1'), { type: 'agentKillAllProp', cid: 'c1' });
  assert.equal(L.stopMsg('', 'c1'), null); assert.equal(L.stopMsg('stopAll', ''), null);
  assert.equal(L.stopMaySend({ type: 'agentStopAll', cid: 'c1' }), true);
  assert.equal(L.stopMaySend({ type: 'agentKillAllProp', cid: 'c1' }), true);
  for (const bad of [null, [], 'x', { type: 'agentStopAll' }, { type: 'agentStopAll', cid: '' }, { type: 'agentStopAll', cid: 'c', agent: 'a' },
    { type: 'agentKill', cid: 'c', agent: 'a', on: true }, { type: 'agentMode', cid: 'c', agent: 'a', mode: 'shadow' }, { type: 'order', cid: 'c' }, { type: 'flatten', cid: 'c' },
    { type: 'agentStopAll', cid: 'x'.repeat(65) }, { type: 'agentStopAll', cid: 7 }]) assert.equal(L.stopMaySend(bad), false, JSON.stringify(bad));
});

test('Stop all: the question takes a real click on Yes only, never in its first moment and never once it is old', () => {
  assert.equal(L.stopClick(0, 1000, true), 'none');
  assert.equal(L.stopClick(1000, 1000 + L.ARM_MS - 1, true), 'early');
  assert.equal(L.stopClick(1000, 1000 + L.ARM_MS, true), 'yes');
  assert.equal(L.stopClick(1000, 1000 + L.ARM_MS, false), 'key', 'Enter or Space on Yes is refused');
  assert.equal(L.stopClick(1000, 1000 + L.CONFIRM_MS + 1, true), 'late');
  assert.equal(L.stopClick(1000, 1000 + L.CONFIRM_MS + 1, false), 'late');
  assert.ok(L.ARM_MS === 600 && L.CONFIRM_MS === 8000, 'the same moments as Kill all on the Legion tab (FleetCore)');
  const FC = require('../live/fleet.js');
  assert.ok(FC.ARM_MS === L.ARM_MS && FC.CONFIRM_MS === L.CONFIRM_MS);
});

test('Stop all: the answer is ChartBridge\'s status line or a refusal of this press', () => {
  assert.deepEqual(L.stopAnswer({ type: 'reject', cid: 'c1', reason: 'no' }, 'c1'), { text: 'Not done: no', bad: true });
  assert.equal(L.stopAnswer({ type: 'reject', cid: 'c2', reason: 'no' }, 'c1'), null, 'another press\'s refusal');
  assert.deepEqual(L.stopAnswer({ type: 'status', text: 'Stop all automation: agent a on P: flattening what it owns' }, ''), { text: 'Stop all automation: agent a on P: flattening what it owns', bad: false });
  assert.equal(L.stopAnswer({ type: 'status', text: 'Stop all automation: x. FAILED, stop it on Legion\'s Cohorts now: b' }, '').bad, true);
  assert.equal(L.stopAnswer({ type: 'status', text: 'Kill all (prop accounts): agent a on P: x' }, '').bad, false);
  assert.equal(L.stopAnswer({ type: 'status', text: 'Something else' }, 'c1'), null);
});

test('the page: installed, served by ChartBridge from its www folder, loading only installed files from this PC', () => {
  const to = www.map(f => f.to);
  for (const f of ['legion.html', 'legion.js', 'legion-tabs.js', 'legion.css']) assert.ok(www.some(x => x.from === 'live/' + f && x.to === f), f + ' is installed');
  const html = read('live', 'legion.html');
  for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) assert.ok(to.includes(m[1].replace(/^\.\.\//, '')), m[1] + ' is installed');
  assert.doesNotMatch(html, /https?:\/\/(?!localhost)/, 'nothing from the internet');
  assert.match(html, /<title>Legion · Imperium<\/title>/);
  assert.match(html, /<script src="pin\.js"><\/script>/, 'behind the same PIN as the chart page');
  assert.match(read('live', 'legion.js'), /if \(PIN\) PIN\.gate\(\)\.then\(start\); else start\(\);/);
  assert.ok(html.indexOf('legion-tabs.js') < html.indexOf('src="legion.js"'), 'the moved tabs load before legion.js starts them');
  // ChartBridge serves any file under its www folder (ServeFile): no ChartBridge change is needed to serve the page
  assert.match(read('nt8', 'ChartBridge.cs'), /private static void ServeFile\(HttpListenerContext ctx, string path\)/);
});

test('the header: the five tabs, Stop all automation outside every tab panel (so on every tab), and the way back to the charts', () => {
  const html = read('live', 'legion.html');
  const nav = /<nav class="lx-nav" id="lxNav" role="tablist"[^>]*>([\s\S]*?)<\/nav>/.exec(html)[1];
  const tabs = [...nav.matchAll(/data-lx-tab="([a-z]+)"[^>]*><span class="lx-rn" aria-hidden="true">([IVX]+)<\/span>([^<]+)<\/button>/g)].map(m => m[1] + ' ' + m[2] + ' ' + m[3]);
  assert.deepEqual(tabs, ['castra I Castra', 'cohorts II Cohorts', 'colosseum III Colosseum', 'ludus IV Ludus', 'golive V Go live']);
  const head = /<header class="lx-head" id="lxHead">([\s\S]*?)<\/header>/.exec(html)[1];
  assert.match(head, /<button type="button" class="lx-btn lx-stop" id="lxStop"[^>]*>Stop all automation<\/button>/);
  assert.match(head, /<a class="lx-btn lx-link" href="\.\/"/, 'Charts: the chart page');
  const main = /<main class="lx-main">([\s\S]*?)<\/main>/.exec(html)[1];
  assert.doesNotMatch(main, /lxStop/, 'not inside a tab: one header over all five');
  for (const t of L.TAB_IDS) assert.match(main, new RegExp('<section class="lx-view" id="lx-' + t + '" role="tabpanel"'), t);
  assert.match(html, /id="lxStopAsk" role="alertdialog"[\s\S]*?Flatten and stop every bot and agent on your prop accounts\? Your personal account, the chart's Bot tab and the copier are not touched\./);
  assert.ok(html.includes(L.QUESTION.replace(/'/g, '\'')), 'the question in the page is LegionCore\'s');
});

test('the R12 delta, nits: on an older ChartBridge the ledger caveat is in the question itself; a drop answers a pending Stop all at once', () => {
  assert.equal(L.questionFor(L.stopPlan('0.6.25', true, true)), L.QUESTION, '0.6.25: the question as it is');
  for (const v of ['0.6.17', '0.6.24']) {
    const q = L.questionFor(L.stopPlan(v, true, true));
    assert.ok(q.startsWith(L.QUESTION + ' '), v);
    assert.match(q, /by its own prop rule only: an account The Desk's ledger types eval or funded that NinjaTrader lists as Sim is NOT stopped/, v);
  }
  assert.equal(L.questionFor(L.stopPlan('0.6.16', true, true)), L.QUESTION, 'nothing can be sent: no question opens anyway');
  const js = read('live', 'legion.js');
  assert.match(js, /const q = \$\('lxStopQ'\), qt = C\.questionFor\(p\);\n\s+if \(q && q\.textContent !== qt\) q\.textContent = qt;/, 'the page writes it into the question');
  assert.match(js, /const tip = p\.ok \? C\.questionFor\(p\) : p\.why;/);
  /* the closed handler: the pending press is answered at once, marked bad, never left to the 5 s timer */
  const closed = js.slice(js.indexOf('closed: () => {'), js.indexOf('} });', js.indexOf('closed: () => {')));
  assert.match(closed, /if \(S\.pending\) \{ S\.pending = ''; clearTimeout\(S\.waitTimer\); say\('Stop all was sent and ChartBridge\\'s answer never came \(the connection dropped\): check the traders on Cohorts, or in NinjaTrader, now\.', true\); \}/);
  assert.ok(closed.indexOf('S.pending') < closed.indexOf('renderHead()'));
});

test('Go live: labelled not built yet, with no sample numbers (Castra is built: test/legion-castra.test.js; the Ludus: test/ludus.test.js)', () => {
  const html = read('live', 'legion.html');
  for (const t of ['golive']) {
    const sec = new RegExp('<section class="lx-view" id="lx-' + t + '"[\\s\\S]*?</section>').exec(html)[0];
    assert.match(sec, /<b>Not built yet\.<\/b>/, t);
    assert.doesNotMatch(sec.replace(/profit per \$1/g, ''), /\$\d|\d+%|\bsample data\b/i, t + ': no numbers ("profit per $1" is the measure\'s name)');
  }
});

test('the header sends through its own link only: the two Stop all messages', () => {
  const js = read('live', 'legion.js');
  assert.equal((js.match(/AF\.post\(/g) || []).length, 1, 'one post on the connection');
  assert.match(js, /link = AF \? Object\.freeze\(\{ post: m => C\.stopMaySend\(m\) === true && AF\.post\(m\) === true \}\) : null;/);
  assert.doesNotMatch(js, /\.send\(|sendOrder|new WebSocket/, 'no other way to ChartBridge');
  assert.match(js, /if \(r === 'yes'\) send\(\);/);
});

test('the moved tabs keep the gates the chart page gave them', () => {
  const js = read('live', 'legion-tabs.js');
  assert.match(js, /const legionLink = AF && legionGate \? \{ listen: part => AF\.listen\(part\), post: m => legionGate\(m\) === true && AF\.post\(m\) === true \} : null;/, 'Cohorts: FleetCore.maySend in front');
  assert.match(js, /const legionGate = window\.FleetCore && Object\.isFrozen\(window\.FleetCore\) \? window\.FleetCore\.maySend : null;/);
  assert.match(js, /const watch = AF \? Object\.freeze\(\{ listen: part => AF\.listen\(part\) \}\) : null;/, 'Colosseum: listen only');
  assert.match(js, /AC\.praetorianLink\(AF\)/, 'Praetorian: its own gate');
  assert.match(js, /FC\.laneFeed\(AF, opts\.locked, opts\.group, opts\.otherLocked\)/, 'a lane: the narrow feed');
  assert.match(js, /feed: readOnlyFeed\(AF\)/, 'the Account page\'s rows: read only');
  assert.doesNotMatch(js, /AF\.post\(m\)(?! === true)|AF\.send|sendOrder/, 'nothing posts on the feed but through the Cohorts gate');
  assert.equal((js.match(/AF\.post\(/g) || []).length, 1);
});

test('agentFlattenOff: a stop on both desks\' gates, for a trader ChartBridge described, with exactly its keys', () => {
  assert.equal(AC.FLATOFF_MIN, '0.6.25');
  const agents = new Map([['t1', { agent: 't1', mode: 'auto', account: 'PROP-1' }]]);
  for (const check of [AC.prCheck, AC.lgCheck]) {
    assert.equal(check({ type: 'agentFlattenOff', cid: 'c', agent: 't1' }, { agents }), '');
    assert.equal(check({ type: 'agentFlattenOff', agent: 't1' }, { agents }), '');
    assert.notEqual(check({ type: 'agentFlattenOff', cid: 'c', agent: 't2' }, { agents }), '', 'not described');
    assert.notEqual(check({ type: 'agentFlattenOff', cid: 'c', agent: 't1', account: 'X' }, { agents }), '', 'an extra key');
    assert.notEqual(check({ type: 'agentFlattenOff', cid: 'c', agent: 't1' }, {}), '', 'nothing heard');
  }
  const desk = read('live', 'agent.js');
  assert.match(desk, /if \(AC\.FLATOFF_MIN && AC\.atLeast\(S\.version, AC\.FLATOFF_MIN\)\) \{/);
  assert.match(desk, /sendAgent\(fm, 'flatoff'\)/);
});

test('ChartBridge: the two messages, their keys, never refused for the rate, and the personal account never in Stop all\'s scope', () => {
  const cs = read('nt8', 'ChartBridgeAgents.cs');
  assert.match(cs, /\{ "agentStopAll", new\[\] \{ "type", "cid" \} \}/);
  assert.match(cs, /\{ "agentFlattenOff", new\[\] \{ "type", "cid", "agent" \} \}/);
  const disp = cs.indexOf('if (type == "agentStopAll") { why = PageStopAll();'), rate = cs.indexOf('if (!RateOk(client.Actions))');
  assert.ok(disp > 0 && rate > disp, 'handled before the action rate, as Kill all');
  const scope = /internal static bool StopScope\(string name\)\s*\{([\s\S]*?)\n        \}/.exec(cs)[1];
  assert.match(scope, /if \(ChartBridgeBranches\.PersonalNamed && ChartBridgeBranches\.IsPersonal\(name\)\) return false;/);
  assert.match(scope, /return ChartBridgeAgent\.KillScope\(name\) \|\| ChartBridgeGroups\.InLedger\(name\);/, 'it only widens Kill all\'s scope');
  assert.match(cs, /if \(off && m != "shadow"\) return m \+ " refused: Flatten and turn off was asked/, 'Copilot and Auto refused while Off waits');
  assert.match(read('nt8', 'ChartBridgeGroups.cs'), /if \(r != null && !string\.IsNullOrEmpty\(r\.Account\) && \(r\.Kind == "eval" \|\| r\.Kind == "funded"\)\)/, 'the ledger: every eval or funded row, whatever its outcome');
  assert.match(read('nt8', 'PROTOCOL.md'), /### Stop all automation and Flatten and turn off \(plan step 3\.2/);
});

test('plain hyphens only in Legion\'s files', () => {
  for (const f of ['live/legion.html', 'live/legion.js', 'live/legion-tabs.js', 'live/legion.css', 'test/legion.test.js', 'test/legion-smoke.mjs']) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) assert.ok(!/[\u2013\u2014]/.test(fs.readFileSync(p, 'utf8')), f);
  }
});

test('round 4: a status line carrying a cid answers only the pending press with that cid; one with none is matched by its words', () => {
  const line = { type: 'status', level: 'warn', text: 'Stop all automation: agent a on P: stopped' };
  assert.deepEqual(L.stopAnswer(Object.assign({ cid: 'lx1' }, line), 'lx1'), { text: line.text, bad: false }, 'its own press');
  assert.equal(L.stopAnswer(Object.assign({ cid: 'other' }, line), 'lx1'), null, 'another window\'s press: not this answer');
  assert.equal(L.stopAnswer(Object.assign({ cid: 'lx1' }, line), ''), null, 'nothing pending: a line with a cid is not taken');
  assert.equal(L.stopAnswer(Object.assign({ cid: 'lx1' }, line, { text: 'Kill all (prop accounts): x' }), 'lx2'), null);
  assert.deepEqual(L.stopAnswer(line, 'lx1'), { text: line.text, bad: false }, 'an older ChartBridge (no cid): by its words, as before');
  assert.deepEqual(L.stopAnswer(line, ''), { text: line.text, bad: false });
  const js = read('live', 'legion.js');
  assert.match(js, /const a = C\.stopAnswer\(m, S\.pending\);\n[^\n]*\n\s+if \(m\.type === 'status' && typeof m\.text === 'string' && \(m\.level === 'warn' \|\| m\.level === 'error'\) && !a\) alertLoud/, 'a line that is not this press\'s answer goes to the alert line');
});

test('round 4, GOLIVE_MIN: Go live needs ChartBridge 0.6.25 or later, said with the version on its tab', () => {
  assert.equal(L.GOLIVE_MIN, '0.6.25');
  assert.deepEqual(L.goLivePlan('0.6.25'), { ok: true, why: '' });
  assert.deepEqual(L.goLivePlan('0.7.0'), { ok: true, why: '' });
  for (const [v, w] of [['0.6.24', '0.6.24'], ['0.6.25-rc1', '0.6.25-rc1'], ['', 'not known'], [null, 'not known']])
    assert.deepEqual(L.goLivePlan(v), { ok: false, why: 'Go live needs ChartBridge 0.6.25 or later (its firm and GO-size guards); this one is ' + w + '. Nothing goes live from here until it is updated.' }, String(v));
  assert.match(read('live', 'legion.html'), /<section class="lx-view" id="lx-golive"[\s\S]*?<p class="lx-muted" id="lxGoLiveWhy" role="note" hidden><\/p>/);
  assert.match(read('live', 'legion.js'), /const gl = \$\('lxGoLiveWhy'\), gw = S\.connected \? C\.goLivePlan\(S\.version\)\.why : '';/);
});

/* the R12 delta review of plan step 3.3: no confirm is ever under the floating lines (live/legion.css) */
test('the stacking order: the floating lines under the lanes\' head (Kill all and its question), under the header, under Stop all\'s question', () => {
  const css = read('live', 'legion.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const z = sel => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('(?:^|\\})\\s*' + esc + '\\s*\\{([^}]*)\\}', 'm').exec(css);
    assert.ok(m, sel + ' has its own rule');
    const v = /z-index:\s*(-?\d+)/.exec(m[1]);
    assert.ok(v, sel + ' sets a z-index');
    return +v[1];
  };
  const float = z('.lx-float'), head = z('.lx-fl .fl-head, .lx-fl .fl-armrow, .lx-fl .fl-top > .fl-ask'), header = z('.lx-head'), stopAsk = z('.lx-ask');
  assert.ok(head > float, 'the lanes\' head (' + head + ') must stack above the floating lines (' + float + ')');
  assert.ok(header > head, 'Legion\'s header (' + header + ') must stack above the lanes\' head (' + head + '), so Stop all is never covered');
  assert.ok(stopAsk > header, 'Stop all\'s question (' + stopAsk + ') must stack above the header (' + header + ')');
  /* the head itself makes no layer of its own on Legion's page (fleet.css gives it 2), or its controls' z-index would count only inside it */
  assert.match(css, /\.lx-fl \.fl-top \{[^}]*z-index: auto;/);
  /* FleetView's own rule is still the weaker one: the lift is Legion's, and nothing in fleet.css outranks it */
  assert.ok(/\.fl-top\s*\{[^}]*z-index:\s*2;/.test(read('live', 'fleet.css')));
  /* the lines are never hidden (Stop all's answer and ChartBridge's errors stay in sight and are announced): they keep clear of every
     open question in the page instead (live/legion.js floatFit, the second R12 delta review of 3.3) */
  assert.doesNotMatch(css, /\.lx-float\s*\{[^}]*(visibility:\s*hidden|display:\s*none|opacity:\s*0)/);
  assert.doesNotMatch(css, /:has\([^)]*alertdialog[^{]*\{[^}]*(visibility|display|opacity)/);
  assert.match(read('live', 'legion.js'), /querySelectorAll\('\[role="alertdialog"\]'\)/);
  /* the cohort model goes under the head, not above it */
  assert.match(read('live', 'legion-tabs.js'), /FleetView\.create\(\{[^\n]*underHead: \$\('chView'\)/);
  assert.match(read('live', 'fleet.js'), /if \(underHead\) \{ const top = view\.querySelector\('\.fl-top'\); if \(top\) top\.after\(underHead\); \}/);
});
