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
  '--trade-accounts=SIM-A,SIM-B,SIM-C,SIM-D,SIM-E,SIM-F,SIM-G,SIM-H', '--version=0.6.21', '--agents=demo', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
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
    for (const k of ['laneA', 'laneB', 'laneC']) { const el = document.createElement('div'); el.id = k; el.style.cssText = 'min-width:0;overflow:auto;border:1px solid #2A2824'; host.appendChild(el); window.lanes[k] = window.workspace.lanePanel(el, k, { twoMountsProof: true }); }
    return { all: Object.values(window.lanes).every(x => x && x.panel && typeof x.destroy === 'function'), again: window.workspace.lanePanel(document.getElementById('laneA'), 'laneA', { twoMountsProof: true }),
      /* the review of 97, F7 and F1: no group and no proof flag, or a group with no lock: no panel at all */
      bare: window.workspace.lanePanel(document.createElement('div'), 'laneX'), nolock: window.workspace.lanePanel(document.createElement('div'), 'laneY', { group: 'g1' }) };
  });
  check(made.all && made.again === null, 'three Multi-Account panels are mounted beside each other; the same key twice is refused');
  check(made.bare === null && made.nolock === null, 'no group without the proof flag, and a group with no lock: no panel (the review of 97, F7 and F1)');
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

  // ---- one fixed group with the narrow feed (a Legion lane): what it shows, what it sends, and the lock
  await p.evaluate(() => {
    window.lockWhy = '';
    const el = document.getElementById('laneC'); el.innerHTML = '';
    window.fixed = window.workspace.lanePanel(el, 'laneF', { group: 'g1', locked: () => window.lockWhy });
  });
  await until(async () => (await p.$$('#laneC .ma-lane.in [data-chip]')).length >= 3, 'the fixed panel drawn');
  const fx = await p.evaluate(() => { const q = x => document.querySelector('#laneC ' + x); return {
    tabs: q('.ma-tabs') ? q('.ma-tabs').hidden : null, select: !!q('[data-ma="group"]'), settings: !!q('[data-ma="settings"]'), create: !!q('[data-ma="new"]'), risk: !!q('[data-ma="risk"]'),
    name: (q('.ma-bar .ma-lname') || {}).textContent, narrow: !!window.fixed.feed && typeof window.fixed.feed.send === 'undefined' && typeof window.fixed.feed.sendOrder === 'undefined',
      /* the review of 97, F3: the panel itself holds exactly the narrow feed (by identity), never the page's */
      held: window.fixed.panel.feed === window.fixed.feed && typeof window.fixed.panel.feed.send === 'undefined' }; });
  check(fx.tabs === true && !fx.select && !fx.settings && !fx.create && !fx.risk && fx.name === 'Lucid', 'one fixed group: its name, no group list, no Copier, no Group settings, no New group, no risk box: ' + JSON.stringify(fx));
  check(fx.narrow, 'it holds the narrow feed: no send and no sendOrder');
  check(fx.held, 'and the panel itself holds that very feed, never the page\'s (the review of 97, F3)');
  const n2 = (await groupMsgs()).length;
  await p.click('#laneC [data-chip="SIM-D"]');
  await until(async () => ((await groupMsgs()).slice(n2)).length === 1, 'a move from the fixed panel');
  const s3 = (await groupMsgs()).slice(n2);
  check(s3.length === 1 && s3[0].type === 'memberBench' && s3[0].account === 'SIM-D', 'moves are free while the lane is in Shadow and flat: one memberBench: ' + JSON.stringify(s3));
  await wait(800);
  // forced sends through the narrow feed: refused by name, nothing reaches ChartBridge
  const n3 = (await groupMsgs()).length;
  const forced = await p.evaluate(() => { const f = window.fixed.feed; return [f.post({ type: 'groupSave', cid: 'x1', group: 'g1', name: 'Renamed', accountType: 'funded' }), f.post({ type: 'groupDelete', cid: 'x2', group: 'g1' }), f.post({ type: 'accountGroup', cid: 'x3', account: 'SIM-E', group: 'g1' }), window.fixed.refused.slice()]; });
  await wait(800);
  check(forced[0] === false && forced[1] === false && forced[2] === false && JSON.stringify(forced[3]) === '["groupSave","groupDelete","accountGroup"]' && (await groupMsgs()).length === n3, 'groupSave, groupDelete and a bare accountGroup through it are refused by name and never reach ChartBridge: ' + JSON.stringify(forced[3]));
  // 1.56.0 (the lanes' Unassigned row): Legion's Add asks the panel's own join step; an account the panel does not offer says why
  const nJ = (await groupMsgs()).length;
  const joins = await p.evaluate(() => [window.fixed.panel.join('SIM-H'), window.fixed.panel.join('SIM-A'), window.fixed.panel.join('SIM-E')]);
  await until(async () => !!(await p.$('#laneC .ma-join')), 'the join step shown');
  check(/SIM-H is not offered by Lucid's panel/.test(joins[0]) && joins[1] === 'SIM-A is in Lucid already.' && joins[2] === '', '1.56.0 join: another firm\'s account is not offered, a member is in already, the firm\'s account in no group opens the join step: ' + JSON.stringify(joins));
  check(/Put in Lucid/.test(await p.$eval('#laneC .ma-join', e => e.textContent)), '1.56.0 join: the panel\'s own Put in, with its rules and highest close');
  await p.click('#laneC [data-ma="join-no"]'); await wait(500);
  check(!(await p.$('#laneC .ma-join')) && (await groupMsgs()).length === nJ, '1.56.0 join: Cancel sends nothing');
  // the lock: every chip locked, a click and a drag send nothing, the reason is shown
  await p.evaluate(() => { window.lockWhy = 'The lane is in Auto: switch Armed off before an account moves.'; });
  await until(async () => p.evaluate(() => /in Auto/.test((document.querySelector('#laneC [data-ma="lockwhy"]') || {}).textContent || '')), 'the reason shown');
  const n4 = (await groupMsgs()).length;
  const locked = await p.evaluate(() => [...document.querySelectorAll('#laneC [data-chip]')].every(c => c.classList.contains('locked') && c.getAttribute('draggable') === 'false'));
  await p.click('#laneC [data-chip="SIM-A"]', { force: true });
  await p.dragAndDrop('#laneC [data-chip="SIM-B"]', '#laneC .ma-lane.bench', { force: true });
  await wait(800);
  check(locked && (await groupMsgs()).length === n4, 'locked: every chip locked and not draggable; a click and a drag sent nothing');
  check(/in Auto: switch Armed off/.test(await p.evaluate(() => (document.querySelector('#laneC .ma-toast:last-child') || {}).textContent)), 'and the panel\'s line says why');
  await p.screenshot({ path: path.join(out, 'lane-panel-fixed-locked.png') });
  // a lock that answers something other than text is not known: the panel shows every chip locked too (the review of 97, F9)
  await p.evaluate(() => { window.lockWhy = null; });
  await until(async () => p.evaluate(() => /not known yet/.test((document.querySelector('#laneC [data-ma="lockwhy"]') || {}).textContent || '')), 'not known shown');
  check(await p.evaluate(() => [...document.querySelectorAll('#laneC [data-chip]')].every(c => c.classList.contains('locked'))), 'a lock that answers null: the panel says not known and locks every chip, as the feed does');
  await p.evaluate(() => { window.lockWhy = 'The lane is in Auto: switch Armed off before an account moves.'; });

  // ---- the Account page's own rows, read only, for the accounts a filter passes (Legion Live's accounts by group)
  await p.evaluate(() => {
    window.fixed.destroy(); window.lanes.laneA.destroy(); window.lanes.laneB.destroy();
    const host = document.getElementById('laneHost'); host.innerHTML = ''; host.style.gridTemplateColumns = '1fr';
    const el = document.createElement('div'); el.id = 'rowsBox'; el.style.cssText = 'min-width:0;overflow:auto'; host.appendChild(el);
    window.rows = window.workspace.accountRows(el, 'rowsL', a => a.group === 'g1');
  });
  const R = await until(async () => { const r = await p.evaluate(() => ({ rows: [...document.querySelectorAll('#rowsBox .gr-row.apg-acc')].map(e => e.dataset.k), secs: [...document.querySelectorAll('#rowsBox .apg-stitle')].map(e => e.textContent),
    tabs: (document.querySelector('#rowsBox .apg-tabs') || {}).hidden, controls: [...document.querySelectorAll('#rowsBox button, #rowsBox input, #rowsBox select')].filter(e => !e.closest('[hidden]')).length, room: (document.querySelector('#rowsBox .apg-rpart') || {}).textContent,
    foot: (document.querySelector('#rowsBox [data-foot]') || {}).textContent })); return r.rows.length ? r : null; }, 'the rows drawn');
  check(R && JSON.stringify(R.secs) === '["Lucid"]' && R.rows.every(k => ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'].includes(k)) && R.rows.length >= 3, 'the Account page\'s rows for Lucid only, under its own section: ' + JSON.stringify(R && [R.secs, R.rows]));
  check(R && R.tabs === true && R.controls === 0 && R.foot === '', 'read only: no tab strip, no button, checkbox or dropdown, no foot line');
  check(R && /\$/.test(R.room || ''), 'with the Room cell the Accounts tab draws (limitState): ' + (R && R.room));
  const n5 = (await groupMsgs()).length;
  await p.click('#rowsBox .gr-row.apg-acc', { force: true }); await wait(500);
  check((await groupMsgs()).length === n5 && await p.evaluate(() => !document.querySelector('#rowsBox .apg-open')), 'a click on a row opens nothing and sends nothing');
  await p.screenshot({ path: path.join(out, 'lane-account-rows.png') });

  // ---- the League tab's overlay, handed any trader's marks (Legion Live's marks of each lane), on a real chart panel
  await p.evaluate(() => { document.getElementById('laneHost').remove(); });
  const ov = await p.evaluate(async () => {
    const chart = window.workspace.chart('c1'), body = document.querySelector('.ws-panel[data-id="c1"] .ws-body');
    const bars = chart.bars(), last = bars[bars.length - 1], mid = bars[Math.max(0, bars.length - 20)];
    const marks = { kind: 'marks', marks: [{ kind: 'entry', t: mid.t, price: mid.c, color: '#8FB4E0', letter: 'E' }, { kind: 'exit', t: last.t, price: last.c, color: '#8FB4E0', letter: 'E' },
      { kind: 'entry', t: mid.t, price: mid.c, color: 'javascript:alert(1)', letter: 'X' }, { kind: 'entry', t: NaN, price: 1, color: '#fff', letter: 'Y' }, { kind: 'entry', t: mid.t, price: mid.c, color: '#fff', letter: '<b>' }],
      lines: [{ kind: 'stop', t0: mid.t, t1: null, price: mid.l, color: '#C9A55C' }] };
    let get = () => marks;
    const o = window.LeagueOverlay.attach({ chart }, body, () => get(), () => 'MNQ', true);
    const cv = body.querySelector('canvas.lg-overlay');
    const ink = () => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };
    o.redraw(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const a = ink();
    get = () => ({ kind: 'marks', marks: [{ kind: 'entry', t: 'x', price: 1, color: '#fff', letter: 'A' }], lines: [{ kind: 'stop', t0: mid.t, t1: null, price: 'x', color: '#fff' }] });
    o.redraw(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b = ink();
    get = () => null; o.redraw(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = ink();
    o.destroy();
    return { a, b, c, gone: !body.querySelector('canvas.lg-overlay') };
  });
  check(ov.a > 50 && ov.b === 0 && ov.c === 0 && ov.gone, 'the overlay draws handed marks on a real chart panel (' + ov.a + ' px), draws nothing for marks that are not numbers or for none, and goes when destroyed');

  // ---- Legion Setup in the real page: a sample trader on the eval group (Lucid, Type eval) is the eval lane, and its lane holds
  // the page's own Multi-Account panel on that group (one fixed group, the narrow feed)
  await control('agent-group', { agent: 'demo', name: 'Lucid', members: 'SIM-A,SIM-B,SIM-C,SIM-D', sizes: '1,1,1,1' });
  await p.click('#wsFleetTab');
  await until(() => p.evaluate(() => !!document.querySelector('#flView .fl-lane[data-stage="eval"] .fl-lanepanels .ma')), 'the eval lane holds a Multi-Account panel');
  const lp = await p.evaluate(() => { const q = x => document.querySelector('#flView .fl-lane[data-stage="eval"] ' + x); return { name: (q('.ma-bar .ma-lname') || {}).textContent, select: !!q('[data-ma="group"]'), settings: !!q('[data-ma="settings"]'),
    chips: [...document.querySelectorAll('#flView .fl-lane[data-stage="eval"] [data-chip]')].map(e => e.dataset.chip) }; });
  check(lp.name === 'Lucid' && !lp.select && !lp.settings && ['SIM-A', 'SIM-B', 'SIM-C'].every(n => lp.chips.includes(n)), 'Legion\'s eval lane holds the Multi-Account panel on Lucid, fixed, with its chips: ' + JSON.stringify(lp));
  // 1.54.0 (D): the lane's accounts are folded under its account count; a click opens the panel in place
  check(await p.locator('#flView .fl-lane[data-stage="eval"] .fl-lanepanels').isHidden(), 'the lane\'s accounts are folded at first (1.54.0)');
  await p.click('#flView .fl-lane[data-stage="eval"] [data-do="laneaccts"]');
  // 1.55.0 (D1, D2): the count lists the accounts; Bench / Trade on the list goes through the lane's own panel, to ChartBridge
  await until(() => p.evaluate(() => document.querySelectorAll('#flView .fl-lane[data-stage="eval"] .fl-acct').length >= 4), 'the account count lists the lane\'s accounts');
  const listed = await p.evaluate(() => [...document.querySelectorAll('#flView .fl-lane[data-stage="eval"] .fl-acct')].map(e => e.dataset.acct));
  check(['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'].every(n => listed.includes(n)) && await p.locator('#flView .fl-lane[data-stage="eval"] .fl-lanepanels').isHidden(), 'the list shows the lane\'s accounts, the panel stays folded: ' + listed.join());
  const nList = (await groupMsgs()).length;
  await p.click('#flView .fl-lane[data-stage="eval"] .fl-acct[data-acct="SIM-A"] [data-do="acctbench"]');
  await until(async () => ((await groupMsgs()).slice(nList)).some(m => m.type === 'memberBench' && m.account === 'SIM-A' && m.benched === true), 'Bench on the list sends memberBench through the panel');
  check(((await groupMsgs()).slice(nList)).every(m => m.type === 'memberBench'), 'and nothing else');
  await p.waitForFunction(() => /SIM-A/.test((document.querySelector('#flView .fl-lane[data-stage="eval"] .fl-acctsaid') || {}).textContent || ''), null, { timeout: 5000 }).catch(() => {});
  check(/SIM-A/.test(await p.locator('#flView .fl-lane[data-stage="eval"] .fl-acctsaid').innerText()), 'the panel\'s own answer shows under the list: ' + await p.locator('#flView .fl-lane[data-stage="eval"] .fl-acctsaid').innerText());
  await p.screenshot({ path: path.join(out, 'legion-lane-accounts-155.png') });
  await p.click('#flView .fl-lane[data-stage="eval"] [data-do="addsim"]');
  await until(() => p.evaluate(() => !document.querySelector('#flView .fl-lane[data-stage="eval"] .fl-lanepanels').hidden), 'Add a Sim account opens the panel');
  const n6 = (await groupMsgs()).length;
  await p.click('#flView .fl-lane[data-stage="eval"] [data-chip="SIM-D"]');
  await until(async () => ((await groupMsgs()).slice(n6)).some(m => m.type === 'memberBench' && m.account === 'SIM-D'), 'a move from inside Legion');
  check(((await groupMsgs()).slice(n6)).every(m => m.type === 'memberBench'), 'a click inside Legion\'s lane sends memberBench and nothing else');
  await p.screenshot({ path: path.join(out, 'legion-setup-lane.png') });
  check(errors.filter(e => e.startsWith('pageerror')).length === 0, 'no page error');
} finally {
  await browser.close();
  bridge.kill();
}
if (errors.length) { console.error(`${errors.length} of ${checks} checks FAILED`); for (const e of errors) console.error('  failed: ' + e); process.exit(1); }
console.log(`all ${checks} checks passed`);
