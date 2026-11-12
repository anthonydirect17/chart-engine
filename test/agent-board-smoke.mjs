// The Agent tab's heroes-on-duty board and a group's default hero (chart 1.28.0, ChartBridge 0.6.1, SPEC CE-1) in the workspace
// against the fake bridge (--agents=demo,demotwo,demothree --board-groups: Group A on SIM-A and SIM-B, Funded, default hero
// sample-build-3; Group B on SIM-C and SIM-D (a made-up LIVE account), Evals, default hero sample-build-1) and the fake PC helper (test/fake-helper.mjs) on 8767 with tiers on its build rows. Every agent,
// hero, build, account and number is made up: sample data only, and the page says so where it shows (the hero names say
// "Sample Hero").
//   - the group's default hero preselected in his build picker, every hero listed with its tier fit for the group's Type;
//   - the board: a group hero row, a single account row, a NO HERO row; columns hero, tier, group and accounts, mode, position,
//     today R, room left, Kill; R3 (nothing moves);
//   - Assign hero with no free slot: "add an agent id to config.txt", nothing sent; with one: agentAccount {group} (the LIVE
//     member asked once in the page; the slot asked again at Continue), then the helper's POST /on with the group's default hero,
//     in Shadow; a seated slot that is Off says so, with Start in Shadow and No hero on duty;
//   - KILL ALL AGENTS: agentKill on to every agent, in one click.
//   npm run smoke:agent-board   (CHROMIUM_PATH=/path/to/chrome; AGENT_BOARD_PORT, else the first free port from 9011; SHOTS=dir)
//   - 1.29.0 (SPEC CE-2): a league seat in the picker (Sim only, a LIVE one listed with the reason) and its PROVING n of 100; an
//     amber stand-down row with its why, kind and time, and Clear stand-down (agentStandDownClear, one click).
// Screenshots: agent-board, agent-board-assign-ask, agent-board-assigned, agent-board-off, agent-board-standdown, agent-board-killed, agent-board-picker (.png in test/out).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { startFakeHelper } from './fake-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t0 > ms) { fail('timed out: ' + what); return null; } await sleep(150); }
}
const free = p => new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
let port = +(process.env.AGENT_BOARD_PORT || 0) || 9011;
while (!(await free(port))) port++;
const control = async (what, q) => (await fetch(`http://127.0.0.1:${port}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
/* the helper's build rows: tiers on two, none on the third (the Bot-Lab side that fills them comes later) */
const BUILDS = [
  { build: 'sample-build-1', stamp: 'aaaaaaaaaaaa', hero: 'Sample Hero A', here: true, shadowOk: true, trades: 40, meanR: 0.2, tier: 'Good', edge: 0.1, examEdge: 0.12, liveEdge: 0.09, liveN: 30 },
  { build: 'sample-build-2', stamp: 'bbbbbbbbbbbb', hero: 'Sample Hero B', here: true, shadowOk: true, trades: 25, meanR: 0.1, tier: 'Acceptable', edge: 0.05 },
  { build: 'sample-build-3', stamp: 'cccccccccccc', hero: 'Sample Hero C', here: true, shadowOk: true, trades: 12, meanR: 0.05 },
];

const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN,
  '--agents=demo,demotwo,demothree', '--agent-any-time', '--board-groups', '--agent-accounts=demotwo:Sim101'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
let helper = null;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  helper = await startFakeHelper({ bridgePort: port, agents: ['demo', 'demotwo', 'demothree'], builds: BUILDS });
  /* demo leads Group A with Sample Hero B, demotwo trades Sim101 with Sample Hero A (both on in the helper); demothree is on None and Off */
  await control('agent-connect', { agent: 'demo', name: 'Sample Hero B', build: 'sample-build-2 bbbbbbbbbbbb' });
  await control('agent-connect', { agent: 'demotwo', name: 'Sample Hero A', build: 'sample-build-1 aaaaaaaaaaaa' });
  Object.assign(helper.status.demo, { on: true, running: true, why: 'on', build: 'sample-build-2', runningBuild: 'sample-build-2', hero: 'Sample Hero B' });
  Object.assign(helper.status.demotwo, { on: true, running: true, why: 'on', build: 'sample-build-1', runningBuild: 'sample-build-1', hero: 'Sample Hero A' });
  await control('agent-group', { agent: 'demo', name: 'Group A', members: 'SIM-A,SIM-B', sizes: '3,2' });

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  for (const api of ['chart-hotkeys', 'chart-strategies', 'chart-accounts'])
    await ctx.route('http://localhost:8800/api/' + api, r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(api === 'chart-accounts' ? { accounts: [] } : api === 'chart-strategies' ? { rev: 0, strategies: [] } : { rev: 1, keys: {}, modifiers: {} }) }));
  /* every agent message the page sends; window.__dropMode: an agentMode never reaches ChartBridge (Shadow never confirmed) */
  await ctx.addInitScript(() => {
    const Real = window.WebSocket, socks = window.__socks = [];
    function Spy(url, p) { const s = p === undefined ? new Real(url) : new Real(url, p); const rec = { msgs: [] }; const send = s.send.bind(s); s.send = d => { let m = null; try { m = JSON.parse(d); if (/^agent/.test(m.type)) rec.msgs.push(m); } catch (e) { /* not JSON */ } if (m && m.type === 'agentMode' && window.__dropMode) return; return send(d); }; socks.push(rec); return s; }
    Spy.prototype = Real.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
    window.WebSocket = Spy;
    /* 1.48.0: the desk's state on the page (window.workspace) or in the Agent window (window.agentDesk) */
    window.__st = () => (window.workspace ? window.workspace.agent() : window.agentDesk.state());
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  page.on('dialog', d => { fail('a browser dialog: ' + d.message()); d.dismiss(); });
  /* 1.48.0 (Praetorian): Assign hero and a group's Clear stand-down are the prop business: on the page they are not on
     Praetorian (the end of this smoke checks that), and the Agent window (Pop out, agent.html, the page's full feed as before)
     keeps them. So the board runs there: the same desk, the same code */
  await page.goto(`http://localhost:${port}/live/agent.html`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => !!window.agentDesk && window.__st().agents.length === 3, null, { timeout: 30000 });
  const sent = () => page.evaluate(() => window.__socks.flatMap(s => s.msgs));

  /* ---------------- piece 3: a group's default hero preselected, every hero listed with its tier fit */
  console.log('piece 3: the default hero of the group he trades is preselected');
  await control('agent-connect', { agent: 'demothree', name: 'Sample Hero C', build: 'sample-build-3 cccccccccccc' });
  await control('agent-group', { agent: 'demothree', name: 'Group B', members: 'SIM-C,SIM-D', sizes: '1,1' });   // a sample view: demothree on Group B (Evals)
  await page.selectOption('#agView [data-k="pick"]', 'demothree');
  const pick = await until(async () => { const r = await page.evaluate(() => { const s = document.querySelector('#agView [data-k="hPick"]'); return s && s.options.length > 1 ? { v: s.value, opts: [...s.options].map(o => o.textContent), note: document.querySelector('#agView [data-k="hNote"]').textContent } : null; }); return r; }, 'the build picker filled');
  check(pick && pick.v === 'sample-build-1', 'Group B\'s default hero (sample-build-1) preselected: ' + JSON.stringify(pick));
  check(pick && pick.opts.length === 3 && pick.opts.includes('Sample Hero C (sample-build-3), tier unknown') && pick.opts.includes('Sample Hero B (sample-build-2)'),
    'every hero listed for Group B (Evals): Acceptable fits evals, a hero with no rating says tier unknown: ' + JSON.stringify(pick && pick.opts));
  await page.selectOption('#agView [data-k="hPick"]', 'sample-build-3');
  check(await page.$eval('#agView [data-k="hPick"]', s => s.value) === 'sample-build-3' && await page.$eval('#agView [data-k="hNote"]', e => e.textContent) === 'tier unknown', 'he can pick another; its warning in the card\'s head');
  await page.screenshot({ path: path.join(SHOTS, 'agent-board-picker.png'), clip: { x: 0, y: 0, width: 520, height: 520 } });
  await control('agent-group', { agent: 'demothree', on: '0' });
  await control('agent-connect', { agent: 'demothree', on: '0' });
  await until(async () => !(await page.evaluate(() => window.__st().agents.find(a => a.agent === 'demothree').connected)), 'demothree back on None, not connected');

  /* ---------------- piece 2: the board */
  console.log('piece 2: the heroes-on-duty board');
  await page.click('#agView [data-act="board"]');
  await until(() => page.isVisible('#agView [data-k="board"]'), 'the board shown');
  check(!(await page.isVisible('#agView [data-k="main"]')), 'the board in place of the desk');
  const rows = await until(async () => { const r = await page.$$eval('#agView [data-brow]', els => els.map(e => ({ kind: e.dataset.brow, agent: e.dataset.agent || '', gid: e.dataset.gid || '', text: e.innerText.replace(/\s+/g, ' ').trim() })));
    return r.length === 3 && r.some(x => /Good/.test(x.text)) && r.some(x => /Acceptable/.test(x.text)) ? r : null; }, 'three rows with the tiers from the helper');
  const [rg, rs, rn] = [rows.find(r => r.agent === 'demo'), rows.find(r => r.agent === 'demotwo'), rows.find(r => r.kind === 'none')];
  check(rg && /SAMPLE HERO B/i.test(rg.text) && /Acceptable \+0\.05R/i.test(rg.text) && /Acceptable: evals only; funded only when no Good or better hero is on duty/.test(rg.text) && /Group A/.test(rg.text) && /leads 2 accounts: SIM-A, SIM-B · Funded/.test(rg.text) && /daily room/.test(rg.text),
    'a group hero row: name and build, tier and its fit for Funded, the group and the accounts it leads, the room of the tightest seat: ' + (rg && rg.text));
  check(rs && /SAMPLE HERO A/i.test(rs.text) && /Good \+0\.10R/i.test(rs.text) && /Sim101/.test(rs.text) && /one account/.test(rs.text) && /Shadow/i.test(rs.text) && /FLAT/.test(rs.text),
    'a single account row: Sim101, Good, Shadow, flat: ' + (rs && rs.text));
  check(rn && rn.gid === 'g2' && /No hero/i.test(rn.text) && /Group B/.test(rn.text) && /2 accounts: SIM-C, SIM-D · Evals/.test(rn.text) && /Default hero: Sample Hero A \(sample-build-1\)/.test(rn.text) && /Assign hero/i.test(rn.text),
    'a NO HERO row for Group B with its accounts, its Type, its default hero and Assign hero: ' + (rn && rn.text));
  const moving = await page.evaluate(() => [...document.querySelectorAll('#agView [data-k="board"], #agView [data-k="board"] *')].filter(e => { const s = getComputedStyle(e); return s.animationName !== 'none' || s.transitionDuration.split(',').some(d => parseFloat(d) > 0); }).map(e => e.className));
  check(moving.length === 0, 'R3: nothing on the board moves or has a transition: ' + JSON.stringify(moving));
  const wide = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check(wide, 'no sideways scroll at 1440 px');
  await page.screenshot({ path: path.join(SHOTS, 'agent-board.png') });

  /* 1.48.0 (the review of 102, F1 and F5): the Agent window is Praetorian too. Assign hero, a group trader's Start in Shadow
     and a group's Clear stand-down are the prop business: held back here, with the reason, and WAITING FOR LEGION'S TRADER
     DESK (the next pull request), where this smoke's flows for them run again. Their checks below are the hold-backs. */
  console.log('  waiting for Legion\'s trader desk: Assign hero and a group trader\'s Start in Shadow run there; here they are held back');
  const asg = await page.$eval('#agView [data-act="bAssign"][data-gid="g2"]', b => ({ d: b.disabled, t: b.title }));
  check(asg.d && /Not on Praetorian: a group is the prop business/.test(asg.t), '1.48.0: in the Agent window too (F1), Assign hero is held back with the reason: ' + JSON.stringify(asg));
  const before = (await sent()).length;
  await page.evaluate(() => { const b = document.querySelector('#agView [data-act="bAssign"][data-gid="g2"]'); b.disabled = false; b.click(); });
  await sleep(300);
  check((await sent()).length === before && /Not on Praetorian/.test(await page.textContent('#agView [data-k="bLine"]')), '1.48.0: Assign hero forced in the Agent window: nothing sent, the reason said');
  /* ---------------- ChartBridge's line on the board (Anthony 2026-10-22): it lay over Desk and Kill all agents (a "no heartbeat"
     warning, now and then, made the Desk click below time out); in the band above the board it covers neither and moves neither */
  console.log('ChartBridge\'s line on the board: in the band above it, over no Desk or Kill all agents, moving neither');
  const headBtns = (pg) => (pg || page).evaluate(() => [...document.querySelectorAll('#agView [data-act="boardClose"], #agView [data-act="killAll"]')].map(b => {
    const r = b.getBoundingClientRect(), hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 3, r.top + 3], [r.right - 3, r.bottom - 3]].every(([x, y]) => { const e = document.elementFromPoint(x, y); return !!e && b.contains(e); });
    return b.dataset.act + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + (hits ? '' : ' covered');
  }));
  /* the workspace's own alert line lives on the page, not in the Agent window: this part runs on the page's Praetorian */
  const mp = await ctx.newPage();
  mp.on('pageerror', e => fail('page error: ' + e.message));
  await mp.goto(`http://localhost:${port}/live/?layout=Main&tab=agent`);
  await mp.waitForSelector('.cb-pin-key', { timeout: 15000 }).then(() => enterPin(mp, TEST_PIN), () => {});
  await mp.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.agent().agents.length === 3, null, { timeout: 30000 });
  await until(() => mp.isVisible('#agView [data-k="board"]') || mp.isVisible('#agView [data-act="board"]'), 'the desk or the board on the page');
  if (!(await mp.isVisible('#agView [data-k="board"]'))) await mp.click('#agView [data-act="board"]');   // the board is kept in this browser: the Agent window may have opened it
  await until(() => mp.isVisible('#agView [data-k="board"]'), 'the board on the page');
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await mp.setViewportSize({ width: w, height: h }); await sleep(400);
    if (await mp.isVisible('#wsAlertClose')) { await mp.click('#wsAlertClose'); await sleep(200); }
    const b0 = await headBtns(mp);
    await control('status', { level: 'warn', text: 'Sample: Agent demothree: no heartbeat for 5 s (a made-up warning for the board)' });
    await until(() => mp.isVisible('#wsAlert'), 'the line shows on the board');
    const b1 = await headBtns(mp), inTray = await mp.evaluate(() => !!document.getElementById('wsAlerts').closest('#agView [data-k="tray"]'));
    check(inTray && b0.length === 2 && JSON.stringify(b1) === JSON.stringify(b0) && !b1.some(s => s.endsWith('covered')), 'at ' + w + ' x ' + h + ' ChartBridge\'s line on the board sits in the band above it, over no Desk or Kill all agents, moving neither: ' + JSON.stringify({ inTray, b0, b1 }));
    await mp.click('#wsAlertClose');
  }
  /* 1.48.0 Praetorian on the page: Assign hero held back with the reason; a group's Clear stand-down refused by the gate */
  const assign = await mp.$('#agView [data-act="bAssign"]');
  if (assign) check(await assign.evaluate(b => b.disabled && /Not on Praetorian: a group is the prop business/.test(b.title)), '1.48.0: on the page, Assign hero is held back with the reason');
  await mp.close();
  await page.setViewportSize({ width: 1440, height: 900 }); await sleep(400);

  /* ---------------- chart 1.29.0 (ChartBridge 0.6.2, SPEC CE-2): a league seat in the picker, its PROVING chip; a stand-down */
  console.log('CE-2: a league seat and a stand-down on the board');
  await page.click('#agView [data-act="boardClose"]');
  await until(() => page.isVisible('#agView [data-k="main"]'), 'his desk again');
  await page.selectOption('#agView [data-k="pick"]', 'demotwo');
  await page.click('#agView [data-act="acctOpen"]');
  const lopts = await until(async () => { const o = await page.$$eval('#agView [data-k="acctSel"] option', els => els.map(e => ({ v: e.value, t: e.textContent, d: e.disabled }))); return o.some(x => x.v.startsWith('league:')) ? o : null; }, 'the league seats in the picker');
  const lsim = lopts && lopts.find(x => x.v.startsWith('league:') && !x.d), lacct = lsim ? lsim.v.slice(7) : '', llive = lopts && lopts.filter(x => x.v.startsWith('league:') && /\(LIVE\)/.test(x.t));
  check(lsim && lsim.t === 'League seat: ' + lacct + ' (SIM)', 'the picker offers a league seat on a Sim account: ' + JSON.stringify(lsim));
  check(llive && llive.length > 0 && llive.every(x => x.d && /cannot be: a league seat is a Sim account only \(.+ is LIVE\)/.test(x.t)), 'a LIVE account is listed as a league seat with the reason, never offered: ' + JSON.stringify(llive));
  check(lopts && lopts.some(x => x.v === 'league:Sim101' && x.d && /the copier's leader/.test(x.t)), 'another\'s account (the copier\'s leader) is listed with why, never offered');
  await page.selectOption('#agView [data-k="acctSel"]', 'league:' + lacct);
  const l0 = (await sent()).length;
  await page.click('#agView [data-act="acctSave"]');
  const lmsg = await until(async () => (await sent()).slice(l0).find(m => m.type === 'agentAccount' && m.agent === 'demotwo'), 'agentAccount league sent');
  check(lmsg && lmsg.account === lacct && lmsg.league === true && lmsg.group === undefined, 'agentAccount {agent, account, league: true, keepMode}: ' + JSON.stringify(lmsg));
  await until(async () => (await page.evaluate(() => window.__st().agents.find(a => a.agent === 'demotwo').league)) === true, 'ChartBridge says demotwo is a league seat');
  await page.click('#agView [data-act="board"]');
  await until(() => page.isVisible('#agView [data-k="board"]'), 'the board again');
  const lrow = await until(async () => { const t = await page.$eval('#agView [data-brow="hero"][data-agent="demotwo"]', e => e.innerText.replace(/\s+/g, ' ')).catch(() => ''); return /PROVING 30 of 100/i.test(t) ? t : null; }, 'the league row\'s PROVING chip');
  check(lrow && /league seat \(Sim only\)/.test(lrow) && lrow.includes(lacct), 'a league seat\'s row: PROVING n of 100 (n the helper\'s liveN), league seat (Sim only): ' + lrow);
  const gidA = await page.$eval('#agView [data-brow="hero"][data-agent="demo"]', e => e.innerText).then(() => page.evaluate(() => { const g = window.__st().agents.find(a => a.agent === 'demo').group; return g && g.id; }));
  await control('agent-standdown', { agent: 'demo', group: gidA, kind: 'edge watch', why: 'sample: live mean below the exam mean by more than 2 SE' });
  const sdRowT = await until(async () => { const t = await page.$eval('#agView [data-brow="standdown"][data-gid="' + gidA + '"]', e => e.innerText.replace(/\s+/g, ' ')).catch(() => ''); return t || null; }, 'the amber stand-down row');
  check(sdRowT && /Stood down/i.test(sdRowT) && /Sample Hero B on Group A/i.test(sdRowT) && /build sample-build-2 bbbbbbbbbbbb/.test(sdRowT) && /edge watch: sample: live mean below the exam mean by more than 2 SE/.test(sdRowT) && /Since [A-Z][a-z]{2} [0-9]{1,2}, [0-9]{2}:[0-9]{2} ET/.test(sdRowT) &&
    /No new trades from this hero on Group A until you clear it; exits, stops and targets always work/.test(sdRowT) && /Clear stand-down/i.test(sdRowT), 'the amber row: the hero, the group, the kind and why, since when, and Clear stand-down: ' + sdRowT);
  const amber = await page.$eval('#agView [data-brow="standdown"]', e => getComputedStyle(e).borderTopColor);
  check(/rgba?\(255, 194, 102/.test(amber), 'amber (the tab\'s warning color): ' + amber);
  check(/stood down/i.test(await page.$eval('#agView [data-brow="hero"][data-agent="demo"]', e => e.innerText)), 'his row says stood down');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll with the stand-down row');
  await page.screenshot({ path: path.join(SHOTS, 'agent-board-standdown.png') });
  const sd = await page.$eval('#agView [data-act="bSdClear"][data-gid="' + gidA + '"]', b => ({ d: b.disabled, t: b.title }));
  check(sd.d && /Not on Praetorian: a stand-down is on a group/.test(sd.t), '1.48.0 (F6): a group\'s Clear stand-down held back with the reason (waiting for Legion\'s trader desk): ' + JSON.stringify(sd));
  const c0 = (await sent()).length;
  await page.evaluate(g => { const b = document.querySelector('#agView [data-act="bSdClear"][data-gid="' + g + '"]'); b.disabled = false; b.click(); }, gidA);
  await sleep(300);
  check(!(await sent()).slice(c0).some(m => m.type === 'agentStandDownClear'), '1.48.0: Clear stand-down forced: refused by the gate, nothing sent');

  /* KILL ALL AGENTS: agentKill on to every agent, one click */
  const k0 = (await sent()).filter(m => m.type === 'agentKill').length;
  await page.click('#agView [data-act="killAll"]');
  const kills = await until(async () => { const k = (await sent()).filter(m => m.type === 'agentKill').slice(k0); return k.length >= 3 ? k : null; }, 'three agentKill');
  check(kills && kills.length === 3 && kills.every(m => m.on === true) && kills.map(m => m.agent).sort().join() === 'demo,demothree,demotwo', 'one click: agentKill on to every agent: ' + JSON.stringify(kills));
  await until(async () => (await page.evaluate(() => window.__st().agents.every(a => a.killed))), 'every agent killed');
  await until(async () => /All agents killed/i.test(await page.textContent('#agView [data-act="killAll"]')), 'the button says so');
  check((await page.$$eval('#agView [data-act="bKill"]', b => b.map(x => x.disabled && /Killed/i.test(x.textContent)))).every(Boolean), 'each row\'s Kill says Killed');
  await page.screenshot({ path: path.join(SHOTS, 'agent-board-killed.png') });
  /* Open goes to his desk; the board is kept in this browser */
  await page.click('#agView [data-act="bOpen"][data-agent="demo"]');
  await until(() => page.isVisible('#agView [data-k="main"]'), 'his desk');
  check(await page.evaluate(() => window.__st().chosen) === 'demo', 'Open shows that agent\'s desk');
  await page.close();
} catch (e) {
  fail('smoke stopped: ' + (e && e.stack || e));
} finally {
  if (helper) await helper.close();
  bridge.kill();
  await browser.close();
}
console.log(errors.length ? '\n' + errors.length + ' of ' + checks + ' checks failed' : '\nall ' + checks + ' checks passed');
process.exit(errors.length ? 1 : 0);
