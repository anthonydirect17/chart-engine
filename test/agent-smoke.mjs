// The Agent tab (chart 1.17.0, live/agent.js) in the workspace against the fake bridge's agent channel (fake-bridge --v3
// --agents=demo,demotwo: ChartBridge 0.5.0, contract AGENT_CHANNEL v1). The agents are made up ("Demo Agent" and "Second
// Demo Agent"), and so are the accounts (Sim101, SIM-AG1, EVAL-A) and every note, plan and price: sample data only.
//   - the Agent tab next to the Bot tab; the grid hidden while it is open (?tab=agent); one tab at a time;
//   - the picker (two agents), the strip: name, build, connected and the heartbeat, mode, SIM or LIVE, account, position,
//     P&L, trades, losses, the owner lock badge, the kill switch's state;
//   - notes (look, thinking collapsed, lesson, notebook, status) and plans (shadow, refused, skipped), newest first;
//   - Change account: the tradable accounts, never the bot's or the copier's; a LIVE one asked once in the page; sent;
//   - the rules: checked against the contract's allowed values before sending; sent with flat keys; ChartBridge's words;
//     the button only while flat with no working entry or proposal;
//   - Copilot: a proposal shows in the tab with its countdown (agentSeen sent), Accept places it (by agent:demo on the
//     chart), the strip shows the owner lock; Accept closes in the last 5 s; an expired one ends;
//   - one copilot key for the bot and the agents: the oldest open proposal across both is answered first;
//   - the kill switch (on in one click, release in two), Auto asks a second click;
//   - the pop-out window (agent.html); an older ChartBridge (0.4.0): "No agents on this ChartBridge (0.5.0 or later)".
//   npm run smoke:agent      (CHROMIUM_PATH=/path/to/chrome; AGENT_SMOKE_PORT and the next one; SHOTS=dir)
// Screenshots: agent-tab, agent-1366, agent-live-ask, agent-proposal, agent-accepted, agent-rules, agent-corner, agent-popout, agent-none (.png in
// test/out).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = +(process.env.AGENT_SMOKE_PORT || 8971);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let port = PORT;
const control = async (what, q) => (await fetch(`http://127.0.0.1:${port}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const agentsNow = async () => (await control('agents')).agents;
async function until(fn, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t0 > ms) { fail('timed out: ' + what); return null; } await sleep(150); }
}
async function startBridge(p, flags) {
  port = p;
  const br = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN].concat(flags || []), { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { br.stdout.once('data', res); br.once('exit', c => rej(new Error('bridge exited ' + c))); });
  return br;
}
/* The Desk's hotkeys document with the copilot keys (made up; The Desk is not running in the test) */
const DESK_KEYS = { rev: 3, keys: { buy: '', sell: '', be: '', close: '', flattenAll: '', merge: '', maximize: '', accept: 'Alt+Y', reject: 'Alt+N' }, modifiers: { limit: '', stop: '' } };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let bridge = null;
try {
  bridge = await startBridge(PORT, ['--agents=demo,demotwo', '--agent-any-time']);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route('http://localhost:8800/api/chart-hotkeys', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(DESK_KEYS) }));
  await ctx.route('http://localhost:8800/api/chart-strategies', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ rev: 0, strategies: [] }) }));
  await ctx.route('http://localhost:8800/api/chart-accounts', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ accounts: [] }) }));
  /* every message a page sends, by type, on each WebSocket */
  await ctx.addInitScript(() => {
    const Real = window.WebSocket, socks = window.__socks = [];
    function Spy(url, p) { const s = p === undefined ? new Real(url) : new Real(url, p); const rec = { url: String(url), types: [], msgs: [] }; const send = s.send.bind(s); s.send = d => { try { const m = JSON.parse(d); rec.types.push(m.type); if (/^agent/.test(m.type)) rec.msgs.push(m); } catch (e) { /* not JSON */ } return send(d); }; socks.push(rec); return s; }
    Spy.prototype = Real.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
    window.WebSocket = Spy;
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  page.on('dialog', d => { fail('a browser dialog: ' + d.message()); d.dismiss(); });
  const open = async (q = '?layout=Main') => {
    await page.goto(`http://localhost:${port}/live/${q}`);
    await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
    await enterPin(page, TEST_PIN);
    await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  };
  const A = () => page.evaluate(() => window.workspace.agent());
  const sent = () => page.evaluate(() => window.__socks.flatMap(s => s.msgs));
  const text = sel => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
  const visible = sel => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }, sel);
  await open();
  await control('price', { root: 'MNQ', p: 25400 });                                   // MNQ held at a sample price: the entries rest

  /* ---------------------------------------------------------------- the tab */
  console.log('the Agent tab next to the Bot tab');
  await until(async () => (await A()).agents.length === 2, 'ChartBridge told of both agents after sign-in');
  check(await page.isVisible('#wsAgentTab') && await page.isVisible('#wsBotTab'), 'the Agent tab button is in the top bar, next to the Bot tab');
  check(await page.evaluate(() => { const b = document.getElementById('wsBotTab'), a = document.getElementById('wsAgentTab'); return b.nextElementSibling === a; }), 'right after the Bot tab');
  await control('agent-connect', { agent: 'demo', name: 'Demo Agent', build: 'sample-build-1' });
  await control('agent-connect', { agent: 'demotwo', name: 'Second Demo Agent', build: 'sample-build-7' });
  await page.click('#wsAgentTab');
  await until(async () => (await A()).shown, 'the tab opens');
  check(await page.evaluate(() => getComputedStyle(document.getElementById('wsGrid')).display) === 'none' && /tab=agent/.test(page.url()), 'the grid is hidden while the Agent tab is open; the URL keeps ?tab=agent');
  check(await visible('#agView [data-k="pickWrap"]'), 'two agents: the picker shows');
  await page.selectOption('#agView [data-k="pick"]', 'demo');
  await until(async () => (await text('.ag-strip [data-k="name"]')) === 'Demo Agent', 'Demo Agent chosen');
  const strip = await text('.ag-strip');
  check(/Demo Agent/.test(strip) && /sample-build-1/.test(strip) && /CONNECTED · 0\.4 s ago/.test(strip) && /SHADOW/.test(strip) && /Sim101\s*SIM/.test(strip) && /Flat/.test(strip) && /\$0\.00/.test(strip) && /Trades\s*0/.test(strip) && /Losses\s*0/.test(strip),
    'the strip: name, build, connected and its heartbeat, mode, account with SIM, position, P&L, trades, losses: "' + strip + '"');
  check(!(await visible('#agView [data-k="sOwns"]')), 'no owner lock while flat with nothing working');

  /* ---------------------------------------------------------------- notes and plans */
  console.log('notes and plans, newest first');
  await control('agent-note', { agent: 'demo', kind: 'notebook', text: 'Sample notebook v3: fade the first touch of a made-up level' });
  await control('agent-note', { agent: 'demo', kind: 'look', text: 'Sample: price is pressing the made-up overnight high with shrinking volume' });
  await control('agent-note', { agent: 'demo', kind: 'thinking', text: 'Sample thinking: the push into the level is slowing; a pullback to the made-up VWAP gives a cleaner long with the stop under the morning low, and the target at the overnight high. ' + 'More sample words to make this long enough to collapse. '.repeat(3) });
  await control('agent-skip', { agent: 'demo', id: 'sk1', setup: 'Sample breakout', reason: 'Sample: no clean level within reach' });
  await control('agent-plan', { agent: 'demo', id: 'r1' });              // refused: Sim101 is the bot's account
  await control('agent-note', { agent: 'demo', kind: 'lesson', text: 'Sample lesson: wait for the second touch on a slow open' });
  await control('agent-note', { agent: 'demo', kind: 'status', text: 'Sample status: watching MNQ and NQ' });
  await until(async () => (await A()).feed.notes === 5 && (await A()).feed.plans === 2, 'five notes and two plans in the feed');
  const kinds = await page.evaluate(() => [...document.querySelectorAll('.ag-feed .ag-k')].map(e => e.textContent));
  check(kinds[0] === 'STATUS' && kinds[1] === 'LESSON' && kinds.includes('PLAN') && kinds.includes('SKIP') && kinds.includes('THINKING') && kinds[kinds.length - 1] === 'NOTEBOOK', 'newest first, every kind: ' + kinds.join(' '));
  check(/refused: Sim101 is the bot's account/.test(await text('.ag-feed')), 'a refused plan says why (the bot\'s account is never an agent\'s)');
  check(await page.evaluate(() => { const d = document.querySelector('.ag-feed details.ag-think'); return !!d && !d.open; }), 'thinking is a collapsed block');
  await page.click('.ag-feed details.ag-think summary');
  await control('agent-note', { agent: 'demo', kind: 'look', text: 'Sample: a new look after the click' });
  await until(async () => (await A()).feed.notes === 6, 'one more note');
  check(await page.evaluate(() => document.querySelector('.ag-feed details.ag-think').open), 'an opened thinking block stays open when the feed redraws');
  await page.click('.ag-filters [data-filter="plans"]');
  check((await page.$$('.ag-feed .ag-item')).length === 2, 'the Plans filter shows the plans only');
  await page.click('.ag-filters [data-filter="all"]');

  /* ---------------------------------------------------------------- account */
  console.log('the agent\'s account: its own, never the bot\'s, the copier\'s or another agent\'s');
  await page.click('#agView [data-act="acctOpen"]');
  const opts = await page.$$eval('#agView [data-k="acctSel"] option', o => o.map(x => ({ t: x.textContent, d: x.disabled })));
  const optText = opts.map(x => x.t + (x.d ? ' [off]' : '')).join(' | ');
  check(opts.some(x => /^Sim101 \(SIM\), now/.test(x.t)) && opts.some(x => /^SIM-AG1 \(SIM\)$/.test(x.t) && !x.d) && opts.some(x => /^EVAL-A \(LIVE\)/.test(x.t) && !x.d) && opts.some(x => /SIM-F1 \(SIM\), a copier follower/.test(x.t) && x.d),
    'the tradable accounts, SIM first, each marked; the copier\'s followers listed but not offered: ' + optText);
  const before = (await sent()).length;
  await page.selectOption('#agView [data-k="acctSel"]', 'EVAL-A');
  await page.click('#agView [data-act="acctSave"]');
  check(await visible('#agView [data-k="acctAsk"]') && /Demo Agent is in Shadow: it will trade LIVE account EVAL-A once you put it in Copilot or Auto\. The agent goes to Shadow when its account changes\. Continue\?/.test(await text('#agView [data-k="acctAsk"]')),
    'a LIVE account is asked once, in the page, naming the mode and the move to Shadow: ' + await text('#agView [data-k="acctAsk"]'));
  check((await sent()).length === before, 'nothing sent before the answer');
  await page.screenshot({ path: path.join(SHOTS, 'agent-live-ask.png'), clip: { x: 0, y: 0, width: 640, height: 900 } });
  await page.click('#agView [data-act="acctNo"]');
  await page.click('#agView [data-act="acctOpen"]');
  await page.selectOption('#agView [data-k="acctSel"]', 'SIM-AG1');
  await page.click('#agView [data-act="acctSave"]');
  await until(async () => (await text('.ag-strip [data-k="sAccount"]')) === 'SIM-AG1', 'the agent trades SIM-AG1 now');
  const am = (await sent()).filter(m => m.type === 'agentAccount');
  check(am.length === 1 && am[0].agent === 'demo' && am[0].account === 'SIM-AG1' && Object.keys(am[0]).join(',') === 'type,cid,agent,account', 'agentAccount sent once, exactly the contract\'s keys: ' + JSON.stringify(am));

  /* ---------------------------------------------------------------- rules */
  console.log('the rules');
  await page.click('#agView [data-act="rulesOpen"]');
  await page.fill('#agView [data-r="maxTrades"]', '51');
  await page.click('#agView [data-act="rulesSave"]');
  check(/Trades a day must be 0 \(no limit\) or a whole number from 1 to 50/.test(await text('#agView [data-k="rulesWhy"]')), 'checked before sending: ' + await text('#agView [data-k="rulesWhy"]'));
  await page.fill('#agView [data-r="maxTrades"]', '6');
  await page.fill('#agView [data-r="maxLosses"]', '3');
  await page.fill('#agView [data-qty="MNQ"]', '10');
  await page.screenshot({ path: path.join(SHOTS, 'agent-rules.png'), clip: { x: 0, y: 0, width: 760, height: 900 } });
  await page.click('#agView [data-act="rulesSave"]');
  await until(async () => /at most 6/.test(await text('#agView [data-k="rules"]')), 'the new rules show (from ChartBridge\'s agent message)');
  const rm = (await sent()).filter(m => m.type === 'agentRules').pop();
  check(rm && rm.roots === 'NQ,MNQ' && rm.maxQtyNQ === 2 && rm.maxQtyMNQ === 10 && rm.maxTrades === 6 && rm.maxLosses === 3 && Object.values(rm).every(v => v === null || typeof v !== 'object'), 'agentRules with flat keys: ' + JSON.stringify(rm));
  check(/10 MNQ/.test(await text('#agView [data-k="rules"]')) && /stand down at 3/.test(await text('#agView [data-k="rules"]')), 'the rules panel: ' + await text('#agView [data-k="rules"]'));

  /* ---------------------------------------------------------------- mode, kill */
  console.log('mode and kill switch');
  const modesSent = async () => (await sent()).filter(m => m.type === 'agentMode');
  await page.click('#agView [data-mode="auto"]');
  check((await text('#agView [data-mode="auto"]')) === 'Confirm' && !(await modesSent()).length, 'Auto asks a second click within 4 s; nothing sent yet');
  await sleep(4300);
  check((await text('#agView [data-mode="auto"]')) === 'Auto', 'no second click: Auto is not asked for');
  await page.dblclick('#agView [data-mode="auto"]');
  await sleep(500);
  check(!(await modesSent()).length && (await A()).agents.find(a => a.agent === 'demo').mode === 'shadow', 'a double-click on Auto never confirms it (review S3)');
  await page.click('#agView [data-mode="auto"]');                                     // the double-click's own second click armed it: confirm now
  await until(async () => (await A()).agents.find(a => a.agent === 'demo').mode === 'auto', 'a second click 400 ms or more after the first confirms Auto');
  const ms = await modesSent();
  check(ms.length === 1 && ms[0].mode === 'auto' && ms[0].agent === 'demo', 'Auto\'s second click sends agentMode auto, once: ' + JSON.stringify(ms));
  await page.click('#agView [data-k="kill"]');
  await until(async () => (await A()).agents.find(a => a.agent === 'demo').killed, 'kill on in one click');
  check(/KILLED/.test(await text('.ag-strip')), 'the strip says KILLED');
  await sleep(300);
  await page.dblclick('#agView [data-k="kill"]');
  await sleep(500);
  check((await A()).agents.find(a => a.agent === 'demo').killed && (await sent()).filter(m => m.type === 'agentKill').length === 1, 'a double-click on Release never releases (review S3)');
  check((await text('#agView [data-k="kill"]')) === 'Release: click again', 'release asks a second click');
  await page.click('#agView [data-k="kill"]');
  await until(async () => !(await A()).agents.find(a => a.agent === 'demo').killed, 'released');
  await page.click('#agView [data-mode="copilot"]');
  await until(async () => (await text('.ag-strip [data-k="modeChip"]')) === 'COPILOT', 'Copilot');

  /* ---------------------------------------------------------------- a proposal, accepted */
  console.log('a copilot proposal in the tab: countdown, agentSeen, Accept');
  await control('agent-plan', { agent: 'demo', id: 'cp1', side: 'buy', kind: 'limit', p: 25390, qty: 2, stop: 16, target: 32, expire: 600, setup: 'Sample pullback', reason: 'Sample: the pullback to the made-up VWAP held twice; a long with the stop under the morning low', confidence: 0.64 });
  await until(() => page.isVisible('.ag-plist .ag-prop'), 'the proposal shows in the tab');
  check(!(await visible('.ag-props .ag-prop, .bt-props .ag-prop')), 'no corner card for the agent shown in the tab');
  const cd = await text('.ag-plist [data-k="cd"]');
  check(/^(9|10):\d\d$/.test(cd), 'a live countdown to expiresAt: ' + cd);
  const card = await text('.ag-plist .ag-prop');
  check(/Buy 2 MNQ/.test(card) && /limit/.test(card) && /Sample pullback/.test(card) && /0\.64/.test(card) && /16 ticks/.test(card) && /32 ticks/.test(card) && /\$16\.00/.test(card) && /SIM-AG1/.test(card) && /SIM/.test(card) && /pullback to the made-up VWAP/.test(card),
    'side, root, qty, kind, price, stop and target ticks, risk, setup, confidence, reason, account: "' + card.slice(0, 260) + '"');
  await until(async () => (await agentsNow()).find(a => a.agent === 'demo').proposals.find(p => p.id === 'cp1').seenAt > 0, 'agentSeen the moment it showed');
  check((await sent()).filter(m => m.type === 'agentSeen' && m.id === 'cp1').length === 1, 'agentSeen once');
  check(await page.isDisabled('#agView [data-act="rulesOpen"]') && /open proposal/.test(await text('#agView [data-k="rulesWhy"]')), 'Change the rules only while flat with nothing working or proposed: ' + await text('#agView [data-k="rulesWhy"]'));
  await sleep(1100);
  check((await text('.ag-plist [data-k="cd"]')) !== cd, 'the countdown runs');
  await page.screenshot({ path: path.join(SHOTS, 'agent-proposal.png') });
  await page.click('.ag-plist [data-agans="accept"]');
  await until(async () => (await agentsNow()).find(a => a.agent === 'demo').proposals.find(p => p.id === 'cp1').state === 'accepted', 'accepted in ChartBridge');
  const ans = (await sent()).filter(m => m.type === 'agentAnswer');
  check(ans.length === 1 && ans[0].answer === 'accept' && ans[0].agent === 'demo' && ans[0].id === 'cp1' && Object.keys(ans[0]).join(',') === 'type,cid,agent,id,answer,at', 'agentAnswer: exactly the contract\'s keys, no order fields: ' + JSON.stringify(ans[0]));
  await until(async () => (await A()).orders.some(o => o.by === 'agent:demo' && o.role === 'entry'), 'the agent\'s working entry, marked by agent:demo');
  await until(() => visible('#agView [data-k="sOwns"]'), 'the owner lock badge');
  check(/OWNS SIM-AG1 MNQ/.test(await text('#agView [data-k="sOwns"]')), 'the strip: ' + await text('#agView [data-k="sOwns"]'));
  const lines = await page.evaluate(() => { const c = window.workspace.agent(); return c.chart; });
  check(lines && (await A()).chartRoot === 'MNQ' && /^MNQ/.test(await text('#agView [data-k="chartName"]')), 'the Agent tab\'s chart is on the agent\'s root, MNQ (its working entry\'s, not its first root NQ): ' + await text('#agView [data-k="chartName"]'));
  await sleep(1200);
  await page.screenshot({ path: path.join(SHOTS, 'agent-tab.png') });
  await page.setViewportSize({ width: 1366, height: 768 });                             // Anthony's laptop: no page scroll
  await sleep(600);
  const fit = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, w: innerWidth, h: innerHeight }));
  check(fit.sw <= fit.w && fit.sh <= fit.h, 'at 1366 x 768 the Agent tab fits the window (no page scroll): ' + JSON.stringify(fit));
  await page.screenshot({ path: path.join(SHOTS, 'agent-1366.png') });
  await page.setViewportSize({ width: 1600, height: 900 });

  /* ---------------------------------------------------------------- expiry: Accept closes in the last 5 s */
  console.log('expiry');
  await control('agent-withdraw', { agent: 'demo', id: 'cp1' });                        // its unfilled entry is cancelled
  await until(async () => !(await A()).orders.some(o => o.by === 'agent:demo' && o.role === 'entry'), 'the entry is gone');
  const ex = await control('agent-plan', { agent: 'demo', id: 'cp2', side: 'sell', kind: 'limit', p: 25410, qty: 1, stop: 20, target: 40, expire: 60 });
  check(!ex.refused, 'a second plan: ' + (ex.refused || 'proposed'));
  await until(() => page.isVisible('.ag-plist .ag-prop[data-id="cp2"]'), 'proposal cp2');
  await control('agent-expire', { agent: 'demo', id: 'cp2', ms: 4000 });
  await until(async () => page.isDisabled('.ag-plist .ag-prop[data-id="cp2"] [data-agans="accept"]'), 'Accept closes with under 5 s left');
  check(/too late to accept/.test(await text('.ag-plist .ag-prop[data-id="cp2"] [data-k="msg"]')), 'it says so: ' + await text('.ag-plist .ag-prop[data-id="cp2"] [data-k="msg"]'));
  check(!(await page.isDisabled('.ag-plist .ag-prop[data-id="cp2"] [data-agans="reject"]')), 'Reject still goes');
  await until(async () => (await agentsNow()).find(a => a.agent === 'demo').proposals.find(p => p.id === 'cp2').state === 'expired', 'ChartBridge expires it', 8000);
  await until(async () => !(await page.$('.ag-prop[data-id="cp2"]')), 'the expired card goes', 6000);
  check(/EXPIRED/.test(await text('.ag-feed')) && /ACCEPTED IN \d+\.\d S/.test(await text('.ag-feed')), 'the feed says how each proposal ended (on its plan): ' + (await text('.ag-feed')).slice(0, 160));

  /* ---------------------------------------------------------------- one copilot key for the bot and every agent */
  console.log('copilot keys: never a second proposal (review B1), the tab answers its agent only, elsewhere one open only (S1)');
  const answersSent = async () => (await sent()).filter(m => m.type === 'agentAnswer');
  await until(async () => (await page.evaluate(() => window.workspace.bot().keys.accept)) === 'Alt+Y', 'the copilot keys from The Desk');
  // the second agent on its own made-up account, in Copilot
  await page.selectOption('#agView [data-k="pick"]', 'demotwo');
  await until(async () => (await text('.ag-strip [data-k="name"]')) === 'Second Demo Agent', 'Second Demo Agent shown');
  check(/Second Demo Agent \(demotwo\)/.test(await page.$eval('#agView [data-k="pick"]', e => e.textContent)), 'the picker shows each agent\'s id next to its name');
  await page.click('#agView [data-act="acctOpen"]'); await page.selectOption('#agView [data-k="acctSel"]', 'SIM-AG2'); await page.click('#agView [data-act="acctSave"]');
  await until(async () => (await agentsNow()).find(a => a.agent === 'demotwo').account === 'SIM-AG2', 'demotwo trades SIM-AG2');
  await page.click('#agView [data-mode="copilot"]');
  await until(async () => (await agentsNow()).find(a => a.agent === 'demotwo').mode === 'copilot', 'demotwo in Copilot');
  await page.selectOption('#agView [data-k="pick"]', 'demo');
  await until(async () => (await text('.ag-strip [data-k="name"]')) === 'Demo Agent', 'Demo Agent shown');
  await page.click('#agView [data-mode="copilot"]');
  await until(async () => (await agentsNow()).find(a => a.agent === 'demo').mode === 'copilot', 'demo in Copilot');
  // two agents' proposals open: demotwo's (older, in the corner) and demo's (in the tab); a quick double press of Accept
  await control('agent-plan', { agent: 'demotwo', id: 'k2', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 12, target: 24, expire: 900 });
  await until(() => visible('.ag-prop.corner[data-id="k2"]'), 'demotwo\'s proposal in the corner');
  check(/Second Demo Agent\s*demotwo/.test(await text('.ag-prop.corner[data-id="k2"] .ag-prop-h')), 'a card names the agent and its id');
  await sleep(300);
  await control('agent-plan', { agent: 'demo', id: 'k1', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 12, target: 24, expire: 900 });
  await until(() => page.isVisible('.ag-plist .ag-prop[data-id="k1"]'), 'demo\'s proposal in the tab');
  await sleep(1100);                                                                   // a key answers a proposal on screen 1 s or more
  const a0 = (await answersSent()).length;
  await page.mouse.click(800, 450);
  await page.keyboard.press('Alt+KeyY');
  await page.keyboard.press('Alt+KeyY');                                               // the double press
  await sleep(900);
  const dbl = (await answersSent()).slice(a0);
  check(dbl.length === 1 && dbl[0].agent === 'demo' && dbl[0].id === 'k1', 'a double press answers one proposal, the shown agent\'s: ' + JSON.stringify(dbl.map(m => m.agent + ':' + m.id)));
  await until(async () => (await agentsNow()).find(a => a.agent === 'demo').proposals.find(p => p.id === 'k1').state === 'accepted', 'demo\'s k1 accepted');
  check((await agentsNow()).find(a => a.agent === 'demotwo').proposals.find(p => p.id === 'k2').state === 'open', 'demotwo\'s k2 (in the corner) untouched');
  await control('agent-withdraw', { agent: 'demo', id: 'k1' });
  // elsewhere: two open (demotwo's and the bot's): the key answers neither and says so
  await page.click('#wsAgentTab');
  await until(async () => !(await A()).shown, 'the tab closes');
  await control('bot-connect', { name: 'Sample Lantern Fade' });
  await control('bot-proposal', { id: 'b1', side: 'sell', kind: 'market', stop: 12, target: 24, reason: 'Sample: the made-up bot\'s signal' });
  await until(() => visible('.bt-prop[data-id="b1"]'), 'the bot\'s proposal too');
  await sleep(1100);
  await page.screenshot({ path: path.join(SHOTS, 'agent-corner.png') });
  await page.mouse.click(800, 450);
  const a1 = (await answersSent()).length;
  await page.keyboard.press('Alt+KeyN');
  await until(async () => /More than one proposal is open: click the one you mean/.test(await page.textContent('#wsNote')), 'more than one open: the key says so on the workspace\'s line');
  await sleep(300);
  check((await answersSent()).length === a1 && !(await sent()).some(m => m.type === 'botAnswer'), 'and answers nothing');
  // click Reject on demotwo's card: the bot's is the only one left, and the key answers it as 1.16.0 did
  await page.click('.ag-prop.corner[data-id="k2"] [data-agans="reject"]');
  await until(async () => (await agentsNow()).find(a => a.agent === 'demotwo').proposals.find(p => p.id === 'k2').state === 'rejected', 'k2 rejected by its button');
  await until(async () => !(await page.$('.ag-prop[data-id="k2"]')), 'its card goes', 6000);
  await page.keyboard.press('Alt+KeyN');
  await until(async () => (await control('v3')).proposals.find(p => p.id === 'b1').state === 'rejected', 'the bot\'s alone: the key answers it (1.16.0)');
  await until(() => page.evaluate(() => !document.querySelector('.bt-prop[data-id="b1"]:not(.bt-ended)')), 'the bot\'s card shows it ended');
  await page.keyboard.press('Alt+KeyN');
  await until(async () => /no copilot proposal to answer here/.test(await page.textContent('#wsNote')), 'with none open the workspace says so (as in 1.16.0)');

  /* ---------------------------------------------------------------- the Bot tab: a double-click never confirms (review S3) */
  console.log('the Bot tab: a double-click on Auto or Release never confirms');
  await page.click('#wsBotTab');
  await until(async () => (await page.evaluate(() => window.workspace.bot().shown)), 'the Bot tab opens');
  await sleep(1500);                                                                   // its entrance
  const botModes = async () => (await sent()).filter(m => m.type === 'botMode').length;
  const bm0 = await botModes();
  await page.dblclick('.bt-modes [data-mode="auto"]');
  await sleep(500);
  check((await botModes()) === bm0 && (await control('v3')).bot.mode !== 'auto', 'a double-click on the bot\'s Auto never confirms it');
  await page.click('.bt-modes [data-mode="auto"]');
  await until(async () => (await control('v3')).bot.mode === 'auto', 'a later second click confirms it, as before');
  await page.click('.bt-modes [data-mode="shadow"]');
  await page.click('.bt-kill');
  await until(async () => (await control('v3')).bot.killed, 'the bot\'s kill on in one click');
  await sleep(300);
  await page.dblclick('.bt-kill');
  await sleep(500);
  check((await control('v3')).bot.killed, 'a double-click on the bot\'s Release never releases');
  await page.click('.bt-kill');
  await until(async () => !(await control('v3')).bot.killed, 'a later second click releases, as before');
  await page.click('#wsBotTab');

  /* ---------------------------------------------------------------- the pop-out */
  console.log('the pop-out window');
  await page.click('#wsAgentTab');
  const [pop] = await Promise.all([ctx.waitForEvent('page'), page.click('.ag-popbtn')]);
  pop.on('pageerror', e => fail('pop-out error: ' + e.message));
  await pop.waitForLoadState();
  if (await pop.$('.cb-pin-key')) await enterPin(pop, TEST_PIN);
  await pop.waitForFunction(() => window.agentDesk && window.agentDesk.state().agents.length === 2, null, { timeout: 20000 });
  await pop.waitForFunction(() => /Demo Agent/.test(document.querySelector('.ag-strip').textContent), null, { timeout: 10000 });
  check(/\/live\/agent\.html$/.test(pop.url()), 'an agent-only page (agent.html) for a third monitor');
  await pop.setViewportSize({ width: 1500, height: 900 });
  await sleep(1500);
  await pop.screenshot({ path: path.join(SHOTS, 'agent-popout.png') });
  await pop.close();
  await page.close();
  await bridge.kill(); bridge = null;

  /* ---------------------------------------------------------------- an older ChartBridge */
  console.log('an older ChartBridge (0.4.0): no agents');
  bridge = await startBridge(PORT + 1, []);
  const p2 = await ctx.newPage();
  p2.on('pageerror', e => fail('page error: ' + e.message));
  await p2.goto(`http://localhost:${port}/live/?layout=Main&tab=agent`);
  await p2.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(p2, TEST_PIN);
  await p2.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  await p2.waitForFunction(() => /0\.5\.0 or later/.test(document.querySelector('#agView [data-k="offText"]').textContent), null, { timeout: 10000 });
  check((await p2.textContent('#agView [data-k="offText"]')) === 'No agents on this ChartBridge (0.5.0 or later).', 'the tab says: No agents on this ChartBridge (0.5.0 or later).');
  check(!(await p2.evaluate(() => window.__socks.some(s => s.types.some(t => /^agent/.test(t))))), 'nothing agent is sent');
  check(await p2.isVisible('#wsBotTab'), 'the Bot tab is as it was');
  await p2.screenshot({ path: path.join(SHOTS, 'agent-none.png') });
  await p2.close();
} catch (e) {
  fail('smoke stopped: ' + (e && e.stack || e));
} finally {
  if (bridge) bridge.kill();
  await browser.close();
}
console.log(errors.length ? '\n' + errors.length + ' of ' + checks + ' checks failed' : '\nall ' + checks + ' checks passed');
process.exit(errors.length ? 1 : 0);
