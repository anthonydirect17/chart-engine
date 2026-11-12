'use strict';
// Chart 1.47.0 (Anthony 2026-11-11, the loop amendment 1 section 5): the top tabs (Chart, Legion, Colosseum) and the
// Colosseum, the League tab renamed and widened with the watch (ChartBridge's traders in Shadow, read only). Made-up
// traders and SIM-A style accounts only. The browser half is test/league-smoke.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const LC = require('../live/league.js');
const FC = require('../live/fleet.js');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
/* made-up agent messages, as ChartBridge sends them */
const agent = o => Object.assign({ type: 'agent', agent: 'demo', name: 'Demo Agent', build: 'sample-build-1', mode: 'shadow', enabled: true, connected: true, account: 'SIM-A', trades: 2 }, o || {});
const accounts = { type: 'accounts', personalNamed: true, list: [{ name: 'SIM-A', sim: true }, { name: 'PROP-1', prop: true }, { name: 'MINE-1', personal: true }] };

test('the watch: only traders in Shadow, in ChartBridge\'s own words, nothing guessed', () => {
  const traders = FC.traders([
    agent(), agent({ agent: 'b2', name: 'Sample bot B', mode: 'auto', account: 'PROP-1' }), agent({ agent: 'c3', name: 'Sample bot C', mode: 'copilot' }),
    agent({ agent: 'd4', name: 'Sample bot D', account: 'PROP-1', trades: undefined }), agent({ agent: 'e5', name: '', mode: 'nonsense' }), agent({ agent: 'f6', account: 'MINE-1', connected: false }),
    agent({ agent: 'g7', account: '' }) ], accounts, '0.6.21');
  const rows = LC.watchRows(traders);
  assert.deepEqual(rows.map(r => r.id), ['d4', 'demo', 'f6', 'g7'], 'Shadow only: Auto, Copilot and an unknown mode are not on the watch');
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(by.demo.place, 'on Sim accounts');
  assert.equal(by.d4.place, 'on a prop account');
  assert.equal(by.d4.trades, null, 'no trade count reported: none shown');
  assert.equal(by.f6.place, 'on your personal account');
  assert.match(by.f6.status, /^Not connected/);
  assert.equal(by.g7.place, 'on None: no account');
  assert.equal(by.demo.trades, 2);
  assert.deepEqual(LC.watchRows(null), []); assert.deepEqual(LC.watchRows([null, 'x', { mode: 'shadow' }]), []);
  /* no personal account picked: the page cannot tell a live account, and says so */
  const unk = LC.watchRows(FC.traders([agent({ account: 'PROP-1' })], { type: 'accounts', personalNamed: false, list: [{ name: 'PROP-1' }] }, '0.6.21'));
  assert.equal(unk[0].place, 'on an account the page cannot tell yet');
  assert.match(LC.WATCH_LATER, /not built yet/);
});

test('nothing on the Colosseum can send: its link has one key, listen, and league.js calls no post or send', () => {
  const ws = read('live/workspace.js');
  const m = /const colosseumLink = (AF \? Object\.freeze\(\{ listen: part => AF\.listen\(part\) \}\) : null);/.exec(ws);
  assert.ok(m, 'the link is built in one line');
  const sent = [], heard = [];
  const AF = { listen: p => { heard.push(p); return () => {}; }, post: x => sent.push(x), send: x => sent.push(x), sendOrder: x => sent.push(x) };
  const link = new Function('AF', 'return ' + m[1])(AF);
  assert.deepStrictEqual(Object.keys(link), ['listen'], 'listen only: no post, no send, no sendOrder');
  assert.ok(Object.isFrozen(link), 'frozen: nothing can add a post to it');
  link.listen({ message() {} });
  assert.equal(heard.length, 1); assert.equal(sent.length, 0);
  assert.strictEqual(new Function('AF', 'return ' + m[1])(null), null, 'no feed: no link');
  assert.match(ws, /window\.LeagueView\.create\(\{ view: \$\('lgView'\), tab: \$\('wsLeagueTab'\), feed: hub, storagePrefix: PREFIX, watch: colosseumLink,/);
  const lg = read('live/league.js');
  assert.doesNotMatch(lg, /\.post\(|\.send\(|sendOrder/, 'league.js never posts or sends');
  assert.doesNotMatch(lg, /agentMode|agentKill|agentAccount|agentRules|agentAnswer|agentPick|botMode|botAnswer/, 'no trader message is named in league.js');
});

test('the top tabs: Chart, Legion, Colosseum in one row, each its own button; old links land on the Colosseum', () => {
  const html = read('live/index.html');
  const row = /<span class="ws-toptabs" id="wsTopTabs" role="group" aria-label="Tabs">([\s\S]*?)\n  <\/span>/.exec(html);
  assert.ok(row, 'one row in the top bar');
  assert.deepEqual([...row[1].matchAll(/<button[^>]*id="(\w+)"[^>]*>([^<]*)<\/button>/g)].map(x => x[1] + ':' + x[2]), ['wsChartTab:Chart', 'wsFleetTab:Legion', 'wsLeagueTab:Colosseum', 'wsPraetorianTab:Praetorian', 'wsAgentTab:Agent'], '1.48.0: Praetorian and its sides last (the Bot\'s button comes into its slot)');
  assert.match(row[1], /<span class="ws-tabslot" id="wsTabSlot"><\/span>/);
  assert.match(row[1], /id="wsChartTab" aria-pressed="true"/, 'Chart pressed at the start');
  assert.doesNotMatch(row[1], /id="wsChartTab"[^>]*hidden/, 'Chart is never hidden, so the row never jumps');
  assert.equal((html.match(/id="wsLeagueTab"/g) || []).length, 1); assert.equal((html.match(/id="wsFleetTab"/g) || []).length, 1);
  assert.match(html, /aria-label="Colosseum tab"/);
  const ws = read('live/workspace.js');
  assert.match(ws, /\['league', 'colosseum'\]\.includes\(new URLSearchParams\(location\.search\)\.get\('tab'\)\)\) leagueView\.openDay\(/, 'the old ?tab=league and the new ?tab=colosseum both open it, the day checked first');
  assert.match(ws, /tabUrl\(on \? 'colosseum' : ''\);/);
  assert.match(ws, /const TAB_CLASSES = \['bt-on', 'ag-on', 'lg-on', 'fl-on'\];/);
  // every body class a tab sets is one the Chart tab reads: a later tab that forgets it fails here
  const toggled = [...ws.matchAll(/document\.body\.classList\.toggle\('([a-z]+-on)', on\)/g)].map(x => x[1]).sort();
  assert.deepStrictEqual(['ag-on', 'bt-on', 'fl-on', 'lg-on'], toggled);
  assert.match(ws, /function closeTabs\(\) \{ for \(const d of \[botDesk, agentDesk, leagueView, fleetView\]\) if \(d && d\.shown\(\)\) d\.showTab\(false\); \}/);
  for (const f of ['live/league.js', 'live/league.css', 'live/workspace.css', 'live/index.html', 'docs/COLOSSEUM_PRAETORIAN_reuse_map.md', 'test/colosseum.test.js'])
    assert.ok(!/[\u2013\u2014]/.test(read(f)), f + ': no en or em dash');
});

test('the Colosseum\'s look: the title font for its name only, the chosen box with builder 1\'s tokens and their fallbacks', () => {
  const css = read('live/league.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.lg-word \{[^}]*font: 700 20px var\(--ws-title-font\)/);
  assert.match(css, /\.lg-watch \{[^}]*border-radius: var\(--ws-box-radius, 18px\);[^}]*box-shadow: var\(--ws-box-shadow, [^;]+\);/);
  assert.doesNotMatch(read('live/workspace.css'), /--ws-box-radius:|--ws-box-shadow:/, 'the two tokens are defined by builder 1, not here');
  assert.doesNotMatch(css, /--ws-buy|--ws-sell/, 'no green or red: nothing on the watch is P&L or a side');
});
