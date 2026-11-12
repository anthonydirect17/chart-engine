// The Multi-Account panel mounted more than once on one page (chart 1.47.0; the reuse map, build answers 18 point 4): the
// proof that a Legion lane can BE that panel, before anything is built on it. Against the fake bridge (--bench --bench-groups:
// made-up groups Lucid with SIM-A to SIM-D and Apex with SIM-H) in Chromium. Sample data only; nothing reaches a broker.
//   - three mounts through the page's own window.workspace.lanePanel: two on Lucid, one on Apex, each in its own element;
//   - each shows its own group; no element id is on the page twice;
//   - a click on a chip in one mount sends ONE memberBench; ChartBridge's groups message redraws that mount AND the other mount
//     on the same group, and leaves the mount on the other group as it was;
//   - a drag in the second mount moves it back, and the first follows;
//   - a mount taken away is no longer redrawn and the others go on.
//   npm run smoke:lanes
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = +(process.env.LANES_SMOKE_PORT || 8979);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--bench', '--bench-groups', '--max-qty=MNQ:9,NQ:9',
  '--trade-accounts=SIM-A,SIM-B,SIM-C,SIM-D,SIM-E,SIM-F,SIM-G,SIM-H', '--version=0.6.7', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const groupMsgs = async () => ((await control('received')).groupMsgs || []);
const lucid = (id, name) => ({ id, firm: 'Lucid', name, version: 1, status: 'checked' });
const DESK = { accounts: ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D', 'SIM-E', 'SIM-F'].map(a => ({ account: a, firm: 'Lucid', archived: false, accountType: lucid('sample-lucid-50k', 'Flex 50K Eval'), source: {} }))
  .concat([{ account: 'SIM-H', firm: 'Apex', archived: false, accountType: { id: 'sample-apex-50k', firm: 'Apex', name: 'EOD 50K', version: 1, status: 'checked' }, source: {} }]) };
const TYPES = { v: 1, asOf: '2026-10-22T12:00:00Z', types: [{ id: 'sample-lucid-50k', firm: 'Lucid', name: 'Flex 50K Eval', account_type: 'eval', account_size: 50000, drawdown: 2000, drawdown_type: 'eod', version: 1, status: 'checked' }] };
const LAYOUT = [{ id: 'c1', type: 'chart', root: 'MNQ', tf: 'm1', x: 0, y: 0, w: 12, h: 3 }];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  for (const [api, body] of [['chart-accounts', DESK], ['account-types', TYPES]])
    await ctx.route('http://localhost:8800/api/' + api, r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) }));
  await ctx.addInitScript(l => { try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: { Main: { panels: l } } })); } catch (e) { /* blocked */ } }, LAYOUT);
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.goto(`http://localhost:${PORT}/live/?layout=Main`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });

  // three mounts, each in its own box over the page, through the page's own function
  const made = await p.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'laneHost'; host.style.cssText = 'position:fixed;left:8px;right:8px;top:60px;bottom:8px;z-index:50;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;background:#050506';
    document.body.appendChild(host);
    window.lanes = {};
    for (const k of ['laneA', 'laneB', 'laneC']) { const el = document.createElement('div'); el.id = k; el.style.cssText = 'min-width:0;overflow:auto;border:1px solid #2A2824'; host.appendChild(el); window.lanes[k] = window.workspace.lanePanel(el, k); }
    return { all: Object.values(window.lanes).every(x => x && x.panel && typeof x.destroy === 'function'), again: window.workspace.lanePanel(document.getElementById('laneA'), 'laneA') };
  });
  check(made.all && made.again === null, 'three Multi-Account panels are mounted beside each other; the same key twice is refused');
  const lane = k => p.evaluate(key => { const s = '#' + key; return { group: (document.querySelector(s + ' [data-ma="group"]') || {}).value, in: [...document.querySelectorAll(s + ' .ma-lane.in [data-chip]')].map(e => e.dataset.chip), bench: [...document.querySelectorAll(s + ' .ma-lane.bench [data-chip]')].map(e => e.dataset.chip) }; }, k);
  await until(async () => (await lane('laneC')).in.length === 3, 'the mounts drawn');
  // laneA and laneC on Lucid (g1), laneB on Apex (g2)
  const gids = await p.evaluate(() => [...document.querySelectorAll('#laneB [data-ma="group"] option')].map(o => o.value + ':' + o.textContent));
  const apex = (gids.find(x => /Apex/.test(x)) || '').split(':')[0];
  await p.selectOption('#laneB [data-ma="group"]', apex);
  await until(async () => JSON.stringify((await lane('laneB')).in) === '["SIM-H"]', 'laneB on Apex');
  let A = await lane('laneA'), B = await lane('laneB'), C = await lane('laneC');
  check(A.group === 'g1' && C.group === 'g1' && B.group === apex && apex !== 'g1', 'each mount keeps its own group: ' + [A.group, B.group, C.group].join(', '));
  check(JSON.stringify(A.in) === '["SIM-A","SIM-B","SIM-C"]' && JSON.stringify(A) === JSON.stringify(C) && JSON.stringify(B.in) === '["SIM-H"]' && !B.bench.includes('SIM-D'), 'two mounts on Lucid show the same accounts; the one on Apex shows Apex\'s only: ' + JSON.stringify(B));
  const dup = await p.evaluate(() => { const seen = new Map(); for (const e of document.querySelectorAll('[id]')) seen.set(e.id, (seen.get(e.id) || 0) + 1); return [...seen].filter(([, n]) => n > 1).map(([id]) => id); });
  check(dup.length === 0, 'no element id is on the page twice: ' + dup.join(', '));
  await p.screenshot({ path: path.join(out, 'lane-panels.png') });

  // a click in laneA: one message; laneA and laneC both follow ChartBridge's answer; laneB is as it was
  const n0 = (await groupMsgs()).length, B0 = JSON.stringify(await lane('laneB'));
  await p.click('#laneA [data-chip="SIM-D"]');
  await until(async () => (await lane('laneA')).in.includes('SIM-D'), 'laneA shows SIM-D trading with the group');
  await until(async () => (await lane('laneC')).in.includes('SIM-D'), 'laneC, never touched, shows it too');
  const sent = (await groupMsgs()).slice(n0);
  check(sent.length === 1 && sent[0].type === 'memberBench' && sent[0].account === 'SIM-D' && sent[0].benched === false, 'one click in one mount sent one message: ' + JSON.stringify(sent));
  A = await lane('laneA'); C = await lane('laneC');
  check(JSON.stringify(A) === JSON.stringify(C) && A.in.includes('SIM-D') && !A.bench.includes('SIM-D'), 'both mounts on Lucid redrew from ChartBridge\'s groups message and agree');
  check(JSON.stringify(await lane('laneB')) === B0, 'the mount on Apex is as it was');

  // a drag in laneC puts it back on the bench; laneA follows
  const n1 = (await groupMsgs()).length;
  await p.dragAndDrop('#laneC [data-chip="SIM-D"]', '#laneC .ma-lane.bench');
  await until(async () => (await lane('laneA')).bench.includes('SIM-D'), 'laneA shows SIM-D back on the bench after a drag in laneC');
  const sent2 = (await groupMsgs()).slice(n1);
  check(sent2.length === 1 && sent2[0].type === 'memberBench' && sent2[0].benched === true, 'the drag in the other mount sent one message: ' + JSON.stringify(sent2));
  check(JSON.stringify(await lane('laneA')) === JSON.stringify(await lane('laneC')), 'and the two agree again');

  // a mount taken away is not redrawn any more; the others go on
  await p.evaluate(() => { window.lanes.laneC.destroy(); window.frozen = document.getElementById('laneC').innerHTML; });
  await p.click('#laneA [data-chip="SIM-D"]');
  await until(async () => (await lane('laneA')).in.includes('SIM-D'), 'laneA still works after laneC was taken away');
  await wait(1500);
  check(await p.evaluate(() => document.getElementById('laneC').innerHTML === window.frozen), 'the mount that was taken away is not drawn again');
  check(JSON.stringify((await lane('laneB')).in) === '["SIM-H"]', 'and the mount on Apex goes on');
  check(errors.filter(e => e.startsWith('pageerror')).length === 0, 'no page error');
} finally {
  await browser.close();
  bridge.kill();
}
if (errors.length) { console.error(`${errors.length} of ${checks} checks FAILED`); for (const e of errors) console.error('  failed: ' + e); process.exit(1); }
console.log(`all ${checks} checks passed`);
