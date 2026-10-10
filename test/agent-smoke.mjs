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
//   - board F (Anthony 2026-10-08): the light sits on the right panels, in the right colour, for watching, a look, a plan in
//     copilot, his rules being checked, an entry placed, an open trade in profit and under water, and a flat exit; every
//     stream row is a button whose drawer opens and closes (the same row, Close, Escape only from inside it); the Motion
//     switch Off and the system's reduced motion stop the light and keep the glow; the P&L figures, the price line and
//     Accept have no transition; no sideways scroll at 1366 px and at phone width; a long record scrolls inside its drawer;
//     the corner notices cover nothing of the tab (they stack in the chart panel's lower left).
//   npm run smoke:agent      (CHROMIUM_PATH=/path/to/chrome; AGENT_SMOKE_PORT and the next one; SHOTS=dir)
// Screenshots: agent-tab, agent-1366, agent-live-ask, agent-proposal, agent-accepted, agent-rules, agent-corner, agent-popout, agent-none,
// agent-phone, and at 1440 x 1000 agent-f-watching, agent-f-plan, agent-f-profit, agent-f-under, agent-f-drawer, agent-f-notices (.png in test/out).
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
/* The smoke's clock, whatever the time of day it runs at: the fake's exchange and desk clocks (--clock-offset) and the page's
   clock (Playwright's, the same offset) all read 11:00 New York on today's New York date and run on from there, so his
   session trail (entryFrom 09:45 to flatAt 15:55) always holds the fills. Until this, after 15:55 New York the trail check
   failed by the wall clock. */
const SMOKE_NY = '11:00';
const NY_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function offsetToNy(hhmm, now) {
  const o = {}; for (const x of NY_PARTS.formatToParts(new Date(now))) o[x.type] = +x.value || 0;
  const wall = Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second), want = Date.UTC(o.year, o.month - 1, o.day, +hhmm.slice(0, 2), +hhmm.slice(3), 0);
  return Math.round((want - wall) / 1000);   // seconds
}
const CLOCK_OFFSET_S = offsetToNy(SMOKE_NY, Date.now());
async function startBridge(p, flags) {
  port = p;
  const br = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN, '--clock-offset=' + CLOCK_OFFSET_S].concat(flags || []), { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { br.stdout.once('data', res); br.once('exit', c => rej(new Error('bridge exited ' + c))); });
  return br;
}
/* The Desk's hotkeys document with the copilot keys (made up; The Desk is not running in the test) */
const DESK_KEYS = { rev: 3, keys: { buy: '', sell: '', be: '', close: '', flattenAll: '', merge: '', maximize: '', accept: 'Alt+Y', reject: 'Alt+N' }, modifiers: { limit: '', stop: '' } };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let bridge = null;
try {
  bridge = await startBridge(PORT, ['--agents=demo,demotwo', '--agent-any-time', '--max-qty=MNQ:20,NQ:2']);   // config.txt's cap holds for agents (as built)
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  /* the page's clock: the fake's, running on. Only Date is shifted; the timers stay real (Playwright's fake clock also takes
     over the timers, and the tab's 4 s confirm windows then never end) */
  await ctx.addInitScript(off => {
    const Real = Date;
    class Shifted extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + off); } static now() { return Real.now() + off; } }
    window.Date = Shifted;
  }, CLOCK_OFFSET_S * 1000);
  console.log('the smoke runs at ' + SMOKE_NY + ' New York (clock offset ' + CLOCK_OFFSET_S + ' s from the wall clock)');
  await ctx.route('http://localhost:8800/api/chart-hotkeys', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(DESK_KEYS) }));
  await ctx.route('http://localhost:8800/api/chart-strategies', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ rev: 0, strategies: [] }) }));
  await ctx.route('http://localhost:8800/api/chart-accounts', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ accounts: [] }) }));
  /* every message a page sends, by type, on each WebSocket */
  await ctx.addInitScript(() => {
    const Real = window.WebSocket, socks = window.__socks = [];
    /* window.__holdAnswers: agentAnswer waits here (as on a slow line) until window.__release(), so the page's "accepted,
       ChartBridge checks it" moment can be looked at */
    window.__holdAnswers = false; const held = window.__held = [];
    window.__release = () => { window.__holdAnswers = false; while (held.length) held.shift()(); };
    function Spy(url, p) { const s = p === undefined ? new Real(url) : new Real(url, p); const rec = { url: String(url), types: [], msgs: [] }; const send = s.send.bind(s); s.send = d => { let m = null; try { m = JSON.parse(d); rec.types.push(m.type); if (/^agent/.test(m.type)) rec.msgs.push(m); } catch (e) { /* not JSON */ } if (m && m.type === 'agentAnswer' && window.__holdAnswers) { held.push(() => send(d)); return; } return send(d); }; socks.push(rec); return s; }
    Spy.prototype = Real.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
    window.WebSocket = Spy;
  });
  const page = await ctx.newPage();
  const pageNy = await page.evaluate(() => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date()));
  check(/^11:0\d$/.test(pageNy), 'the page\'s clock reads ' + SMOKE_NY + ' New York, whatever the time of day the smoke runs: ' + pageNy);
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
  /* board F: the light's state, the lit panels, the running light animations (the line and its halo: one animation per lit panel) */
  const light = () => page.evaluate(() => window.workspace.agent().light);
  const lit = () => page.evaluate(() => [...document.querySelectorAll('#agView .ag-panel.lit')].map(e => e.dataset.panel).sort().join(','));
  /* the panels whose light runs: each lit panel turns its strips (the line's four and the halo's four, each with its crossfade copy), all on one lap */
  const orbits = () => page.evaluate(() => { const by = {}; for (const a of document.getAnimations()) if (a.animationName === 'ag-orbit' && a.playState === 'running') { const p = a.effect.target.closest('[data-panel]').dataset.panel; by[p] = (by[p] || 0) + 1; } return Object.keys(by).filter(p => by[p] === 16).sort().join(','); });
  const lapOf = () => page.evaluate(() => { const l = document.querySelector('#agView .ag-panel.lit > .ag-light .ag-edge > b'); return l ? getComputedStyle(l).animationDuration : ''; });
  /* R3, motion inherited (as test/kit-smoke.mjs on kit-v1): every figure, price, chip, row and button of the tab, with itself
     or an ancestor that animates, or has a transition that could move or change it. The only transitions allowed on an
     ancestor are a panel's glow and its colour (box-shadow, and --ag-pc, registered as not inherited: no child gets it); a
     figure itself has none at all. */
  const R3_HOLDS = '#agView .mono, #agView button, #agView .ag-chip, #agView .ag-mark, #agView .ag-fact, #agView .ag-prop, #agView .ag-cd, #agView .ag-today, #agView .ag-count, #agView .ag-cpnl, #agView .ag-cpos, #agView .ag-kv, #agView [data-no-motion], #agView .ag-drawer, #agView .ag-drawer *';
  const r3Moving = () => page.evaluate(sel => {
    /* the light's colour and the glow: on the tab's main part and its panels only */
    const allowed = el => (el.matches('.ag-panel') ? ['--ag-pc', 'box-shadow'] : []);
    const animated = new Set(document.getAnimations().filter(a => !(typeof CSSTransition === 'function' && a instanceof CSSTransition && a.effect && a.effect.target && allowed(a.effect.target).includes(a.transitionProperty)))
      .map(a => a.effect && a.effect.target).filter(Boolean));
    const props = s => s.transitionProperty.split(',').map(x => x.trim()), durs = s => s.transitionDuration.split(',').map(d => parseFloat(d));
    const moves = el => {
      if (animated.has(el) && !el.closest('.ag-light')) return 'animated';
      const s = getComputedStyle(el);
      if (s.animationName !== 'none') return 'animation ' + s.animationName;
      const p = props(s), d = durs(s);
      for (let i = 0; i < p.length; i++) if ((d[i % d.length] || 0) > 0 && !allowed(el).includes(p[i])) return 'transition ' + p[i];
      return '';
    };
    const bad = [];
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('.ag-light') || !el.getClientRects().length) continue;
      for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
        const why = moves(a);
        if (why) { bad.push((el.dataset.k || el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]) + ' via ' + (a === el ? 'itself' : (a.dataset.k || a.tagName.toLowerCase() + '.' + String(a.className).split(' ').join('.'))) + ' (' + why + ')'); break; }
      }
    }
    return bad;
  }, R3_HOLDS);
  async function lightIs(phase, tone, panels, what) {
    await until(async () => { const l = await light(); return l && l.phase === phase && l.tone === tone; }, what + ': the light is ' + phase + ' (' + tone + ')');
    await until(async () => (await lit()) === panels.slice().sort().join(','), what + ': lit ' + panels.join(' and '), 3000);
    const L = await light(), on = await lit(), run = await orbits();
    check(L.phase === phase && L.tone === tone && on === panels.slice().sort().join(',') && run === on,
      what + ': the light circles ' + panels.join(' and ') + ' in ' + L.color + ' (' + L.said + '); lit: ' + on + '; running: ' + (run || 'none'));
    return L;
  }
  const shotF = async name => { const vp = page.viewportSize(); await page.setViewportSize({ width: 1440, height: 1000 }); await sleep(700); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); await page.setViewportSize(vp); await sleep(300); };
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
  check(/Demo Agent/.test(strip) && /sample-build-1/.test(strip) && /CONNECTED · 0\.4 s ago/.test(strip) && /SHADOW/.test(strip) && /Sim101\s*SIM/.test(strip) && /Flat/.test(strip),
    'the strip: name, build, connected and its heartbeat, mode, account with SIM, position: "' + strip + '"');
  const foot = await text('#agView .ag-foot');
  check(/\$0\.00/.test(foot) && /Today/.test(foot) && /0\s*Trades/.test(foot) && /0\s*Losses/.test(foot) && /09:45/.test(foot) && /15:55/.test(foot) && !/The light|in profit|under water/.test(foot),
    'the footer: today\'s P&L, trades, losses, his session 09:45 to 15:55, no legend: "' + foot.slice(0, 200) + '"');
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
  const kinds = await page.evaluate(() => [...document.querySelectorAll('.ag-feed .ag-tag')].map(e => e.textContent));
  check(kinds[0] === 'STATUS' && kinds[1] === 'LESSON' && kinds.includes('REFUSED') && kinds.includes('PASS') && kinds.includes('THINKING') && kinds.includes('LOOK') && kinds[kinds.length - 1] === 'NOTEBOOK', 'newest first, every kind: ' + kinds.join(' '));
  check(await page.evaluate(() => [...document.querySelectorAll('.ag-feed > *')].every(e => e.tagName === 'BUTTON' && e.type === 'button' && e.getAttribute('aria-controls'))), 'every stream row is a real button');
  check(/refused: Sim101 is also the bot's account: choose an account for agent demo on the Agent tab/.test(await text('.ag-feed')), 'a refused plan says why (the bot\'s account is never an agent\'s)');
  check(/STOOD DOWN: Sim101 is also the bot's account/.test(await text('.ag-strip')), 'on its unchosen default Sim101, the bot\'s too, the agent stands down and the strip says so (as built)');
  /* the decision drawer: his full record of one row */
  console.log('the decision drawer');
  const thinkRow = '.ag-feed .ag-rowb.t-judgment';
  check(/\.\.\.$/.test(await text(thinkRow + ' .ag-tx')), 'a long thinking row shows its start: ' + (await text(thinkRow + ' .ag-tx')).slice(-40));
  await page.click(thinkRow);
  await until(() => visible('#agView [data-k="drawer"]'), 'the drawer opens');
  const dtext = await text('#agView [data-k="drawer"]');
  check(/His thinking/.test(dtext) && /More sample words to make this long enough to collapse\. More sample words/.test(dtext) && /In his words/.test(dtext) && !/For and against|Notebook rule|cost/i.test(dtext),
    'the drawer: his full thinking, only what the channel carries: "' + dtext.slice(0, 120) + '..."');
  check(await page.evaluate(() => { const d = document.querySelector('#agView [data-k="drawer"]'), r = document.querySelector('.ag-feed .ag-rowb.t-judgment'); return d.classList.contains('t-judgment') && getComputedStyle(d).borderTopColor === 'rgb(200, 31, 224)' && r.getAttribute('aria-expanded') === 'true' && r.classList.contains('sel') && d.contains(document.activeElement); }),
    'outlined in the decision\'s colour (Judgment #c81fe0), the row marked open, the focus on its Close');
  check(await page.evaluate(() => { const d = document.querySelector('#agView [data-k="drawer"]').getBoundingClientRect(), r = document.querySelector('.ag-feed .ag-rowb.sel').getBoundingClientRect(); return r.top >= d.bottom - 1; }), 'the row stays in sight below the drawer');
  await page.click(thinkRow);
  await until(async () => !(await visible('#agView [data-k="drawer"]')), 'the same row again closes it');
  await page.click(thinkRow);
  await until(() => visible('#agView [data-k="drawer"]'), 'open again');
  await page.click('#agView .ag-strip [data-k="name"]');                              // the focus outside the drawer
  await page.keyboard.press('Escape');
  await sleep(200);
  check(await visible('#agView [data-k="drawer"]'), 'Escape with the focus outside the drawer leaves it (no page-wide key handler)');
  await page.focus('#agView [data-k="drawer"] [data-act="drawerClose"]');
  await page.keyboard.press('Escape');
  await until(async () => !(await visible('#agView [data-k="drawer"]')), 'Escape from inside the drawer closes it');
  check(await page.evaluate(() => document.activeElement && document.activeElement.matches('.ag-feed .ag-rowb.t-judgment')), 'the focus goes back to its row');
  await page.click('.ag-feed .ag-rowb.t-no');                                          // the refused plan
  await until(() => visible('#agView [data-k="drawer"]'), 'a refused plan\'s record');
  check(/refused by ChartBridge: Sim101 is also the bot's account/.test(await text('#agView [data-k="drawer"]')), 'a refused plan: ChartBridge\'s words under his rules');
  await page.click('#agView [data-k="drawer"] [data-act="drawerClose"]');
  await until(async () => !(await visible('#agView [data-k="drawer"]')), 'Close closes it');
  await control('agent-note', { agent: 'demo', kind: 'lesson', text: 'Sample: a new lesson after the click' });
  await until(async () => (await A()).feed.notes === 6, 'one more note');
  await page.click('.ag-filters [data-filter="plans"]');
  check((await page.$$('.ag-feed .ag-rowb')).length === 2, 'the Plans filter shows the plans only');
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
  check(await visible('#agView [data-k="acctAsk"]') && /Agent demo will trade LIVE account EVAL-A in (Shadow \(nothing is placed until you choose Copilot or Auto\)|Copilot|Auto)\. Continue\?/.test(await text('#agView [data-k="acctAsk"]')),
    'a LIVE account is asked once, in the page, naming the mode it keeps (ChartBridge 0.5.2): ' + await text('#agView [data-k="acctAsk"]'));
  check((await sent()).length === before, 'nothing sent before the answer');
  await page.screenshot({ path: path.join(SHOTS, 'agent-live-ask.png'), clip: { x: 0, y: 0, width: 640, height: 900 } });
  /* the 0.5.2 re-review: another page changes the mode while the question is open: it closes with a note (never redrawn with
     the new mode), nothing is sent, and Set asks again, naming the mode now */
  const askedSaid = await text('#agView [data-k="acctAsk"]'), wasMode = (await agentsNow()).find(x => x.agent === 'demo').mode;
  const otherMode = wasMode === 'auto' ? 'copilot' : 'auto', otherName = otherMode === 'auto' ? 'Auto' : 'Copilot';
  await control('agent-mode', { agent: 'demo', mode: otherMode });
  await until(async () => !(await visible('#agView [data-k="acctAsk"]')), 'the open question closes when the mode changes');
  check(new RegExp('^demo went to ' + otherName + ' while the question said (Shadow|Copilot|Auto): nothing was sent\\. Choose Set to be asked again\\.$').test(await text('#agView [data-k="acctWhy"]')) && (await sent()).length === before,
    'the mode changed under the open question (it said: ' + askedSaid + '): closed with a note, nothing sent: ' + await text('#agView [data-k="acctWhy"]'));
  await page.click('#agView [data-act="acctSave"]');
  check(await visible('#agView [data-k="acctAsk"]') && new RegExp('Agent demo will trade LIVE account EVAL-A in ' + otherName + '\\. Continue\\?').test(await text('#agView [data-k="acctAsk"]')),
    'Set asks again, naming the mode now: ' + await text('#agView [data-k="acctAsk"]'));
  await page.click('#agView [data-act="acctNo"]');
  await control('agent-mode', { agent: 'demo', mode: wasMode });
  await until(async () => (await agentsNow()).find(x => x.agent === 'demo').mode === wasMode, 'demo back in ' + wasMode);
  await sleep(300);
  await page.click('#agView [data-act="acctOpen"]');
  await page.selectOption('#agView [data-k="acctSel"]', 'SIM-AG1');
  await page.click('#agView [data-act="acctSave"]');
  await until(async () => (await text('.ag-strip [data-k="sAccount"]')) === 'SIM-AG1', 'the agent trades SIM-AG1 now');
  const am = (await sent()).filter(m => m.type === 'agentAccount');
  check(am.length === 1 && am[0].agent === 'demo' && am[0].account === 'SIM-AG1' && Object.keys(am[0]).join(',') === 'type,cid,agent,account,keepMode' && ['shadow', 'copilot', 'auto'].includes(am[0].keepMode),
    'agentAccount sent once, exactly the contract\'s keys; to ChartBridge 0.5.2 or later (the fake says fake-0.5.4) keepMode names the mode the page showed: ' + JSON.stringify(am));
  check((await agentsNow()).find(a => a.agent === 'demo').mode === am[0].keepMode, 'the mode is kept: ' + am[0].keepMode);

  /* ---------------------------------------------------------------- the light: a look */
  console.log('the light follows his real state');
  await control('agent-note', { agent: 'demo', kind: 'look', text: 'Sample: price is back at the made-up VWAP; worth a closer look' });
  await lightIs('look', 'eyes', ['pipe', 'stream'], 'a look');
  check((await lapOf()) === '13s', 'while he decides the light takes 13 s a lap: ' + await lapOf());
  check(await page.evaluate(() => [...document.querySelectorAll('#agView .ag-panel:not(.lit) > .ag-light')].every(l => getComputedStyle(l).display === 'none')), 'no light on a panel that is not lit');
  check(await page.evaluate(() => getComputedStyle(document.querySelector('#agView .ag-step[data-step="1"]')).getPropertyValue('--tc').trim() === '#8f7bff' && document.querySelector('#agView .ag-step[data-step="1"]').classList.contains('now')), 'the tracker: Eyes is the step now');
  check((await text('#agView [data-k="room"]')).includes('Max loss room') && /not reported/.test(await text('#agView [data-k="room"]')) && !/target|NinjaTrader does not/i.test(await text('#agView [data-k="room"]')), 'his account\'s room, terse: ' + await text('#agView [data-k="room"]'));
  const words = await text('#agView');
  check(!/The light|in a trade the light|bars, delta, levels|worth a look\?|a row opens|its own, never shared|ChartBridge enforces them|In Copilot each plan comes here|AGENT TRADES|keeps it \(agent-|his decision|Only what ChartBridge/i.test(words), 'no explanatory labels on the tab (Anthony 2026-10-08)');

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
  await sleep(1100);                                                                   // a click within 1 s of kill-on is the same press (ignored)
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
  check(!(await page.isDisabled('#agView [data-act="rulesOpen"]')) && (await text('#agView [data-act="rulesOpen"]')) === 'Change the window' && /open proposal: only the window \(entries from, until, flat at\) can change now/.test(await text('#agView [data-k="rulesWhy"]')),
    'ChartBridge 0.5.4: with a proposal open only the window can change, and the button says so: ' + await text('#agView [data-k="rulesWhy"]'));
  await sleep(1100);
  check((await text('.ag-plist [data-k="cd"]')) !== cd, 'the countdown runs');
  await page.screenshot({ path: path.join(SHOTS, 'agent-proposal.png') });
  await lightIs('plan', 'judgment', ['pipe', 'prop'], 'a plan waiting in copilot');
  check(await page.evaluate(() => { const L = window.workspace.agent().light, p = document.querySelector('#agView .ag-panel.lit'), l = p.querySelector('.ag-light'); const rgb = h => 'rgb(' + [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ') + ')';
    const slot = l.classList.contains('ag-c1') ? 1 : 0; return getComputedStyle(p).getPropertyValue('--ag-to').trim() === rgb(L.color) && getComputedStyle(l).getPropertyValue('--ag-c' + slot).trim() === rgb(L.color); }),
    'the light\'s colour is set where it draws: the lit panel\'s glow fades to it, the light crossfades to it (registered colours, not inherited by the tab)');
  for (const [w, h] of [[1440, 1000], [1366, 768]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(500);
    const seen = await page.evaluate(() => { const box = document.querySelector('#agView .ag-slot').getBoundingClientRect(); return ['accept', 'reject'].every(a => { const b = document.querySelector('.ag-plist [data-agans="' + a + '"]').getBoundingClientRect(); return b.height > 30 && b.top >= box.top - 1 && b.bottom <= box.bottom + 1 && b.bottom <= innerHeight; }); });
    check(seen, 'at ' + w + ' x ' + h + ' Accept and Reject are fully in sight in the proposal');
  }
  await page.setViewportSize({ width: 1600, height: 900 });
  await shotF('agent-f-plan');
  /* his rules being checked: Accept sent, ChartBridge not answered yet (the answer held a moment, as on a slow line) */
  await page.evaluate(() => { window.__holdAnswers = true; });
  await page.click('.ag-plist [data-agans="accept"]');
  await lightIs('check', 'checks', ['acct', 'prop'], 'Accept sent, his rules being checked');
  check(await page.isDisabled('.ag-plist [data-agans="accept"]') && await page.isDisabled('.ag-plist [data-agans="reject"]'), 'Accept and Reject closed while ChartBridge checks (the double-press guard)');
  await page.evaluate(() => window.__release());
  await until(async () => (await agentsNow()).find(a => a.agent === 'demo').proposals.find(p => p.id === 'cp1').state === 'accepted', 'accepted in ChartBridge');
  const ans = (await sent()).filter(m => m.type === 'agentAnswer');
  check(ans.length === 1 && ans[0].answer === 'accept' && ans[0].agent === 'demo' && ans[0].id === 'cp1' && Object.keys(ans[0]).join(',') === 'type,cid,agent,id,answer,at', 'agentAnswer: exactly the contract\'s keys, no order fields: ' + JSON.stringify(ans[0]));
  await until(async () => (await A()).orders.some(o => o.by === 'agent:demo' && o.role === 'entry'), 'the agent\'s working entry, marked by agent:demo');
  await until(() => visible('#agView [data-k="sOwns"]'), 'the owner lock badge');
  await lightIs('placed', 'bridge', ['chart', 'prop'], 'his entry placed and working');
  /* the drawer on a plan: the facts as the channel carries them */
  await page.click('.ag-filters [data-filter="plans"]');
  await page.click('.ag-feed .ag-rowb.t-bridge');
  await until(() => visible('#agView [data-k="drawer"]'), 'the accepted plan\'s record');
  const drawerTop = await page.evaluate(() => { const d = document.querySelector('#agView [data-k="drawer"]').getBoundingClientRect(); return Math.round(d.top); });
  const pt = await text('#agView [data-k="drawer"]');
  check(/In his words/.test(pt) && /pullback to the made-up VWAP held twice/.test(pt) && /Entry\s*Buy 2 MNQ, limit 25,390\.00/.test(pt) && /Stop\s*16 ticks, 25,386\.00/.test(pt) && /Target\s*32 ticks, 25,398\.00/.test(pt) &&
    /Risk\s*\$16\.00, reward 2\.00 to 1/.test(pt) && /passed ChartBridge's checks/.test(pt) && /Proposal\s*accepted/i.test(pt) && /You answered/.test(pt) && !/For and against|cost/i.test(pt),
    'a plan\'s record: his words, entry, stop, target, risk, the checks, the proposal and his answer time: "' + pt.slice(0, 220) + '..."');
  await shotF('agent-f-drawer');
  const r3d = await r3Moving();
  check(!r3d.length, 'R3: with the drawer open, no figure, price, chip, row or button moves, on its own or through an animated or transitioned ancestor (the drawer appears at once)' + (r3d.length ? ': ' + JSON.stringify(r3d.slice(0, 6)) : ''));
  check(await page.evaluate(() => { const d = document.querySelector('#agView [data-k="drawer"]').getBoundingClientRect(), r = document.querySelector('.ag-feed .ag-rowb.sel'), f = document.querySelector('#agView [data-k="feed"]').getBoundingClientRect(); const b = r.getBoundingClientRect(); return b.top >= d.bottom - 1 && b.bottom <= f.bottom + 1; }),
    'at 1440 x 1000 its row (the newest, in a short list) is in sight below the drawer');
  /* a long record in a short window: the drawer scrolls inside itself and its last fact can be reached */
  await page.setViewportSize({ width: 1366, height: 768 });
  await sleep(600);
  const dscroll = await page.evaluate(async () => {
    const d = document.querySelector('#agView [data-k="drawer"]'), facts = d.querySelectorAll('.ag-fact'), last = facts[facts.length - 1];
    const before = { sh: d.scrollHeight, ch: d.clientHeight, overflow: getComputedStyle(d).overflowY, more: d.classList.contains('ag-more') && getComputedStyle(d.querySelector('.ag-dmore')).display !== 'none' };
    d.scrollTop = d.scrollHeight;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const dr = d.getBoundingClientRect(), lr = last.getBoundingClientRect();
    return Object.assign(before, { more: before.more, facts: facts.length, lastText: last.textContent, lastIn: lr.top >= dr.top - 1 && lr.bottom <= dr.bottom + 1, scrolled: d.scrollTop > 0, moreAfter: d.classList.contains('ag-more'), page: document.documentElement.scrollHeight <= innerHeight });
  });
  check(dscroll.sh > dscroll.ch && /auto|scroll/.test(dscroll.overflow) && dscroll.more && dscroll.scrolled && dscroll.lastIn && !dscroll.moreAfter && dscroll.facts >= 10 && dscroll.page,
    'a record taller than its drawer says "more below", scrolls inside the drawer, and its last fact is reachable (' + dscroll.lastText + '): ' + JSON.stringify(dscroll));
  await page.setViewportSize({ width: 1600, height: 900 });
  await sleep(400);
  await page.click('#agView [data-k="drawer"] [data-act="drawerClose"]');
  await page.click('.ag-filters [data-filter="all"]');
  check(drawerTop >= 0, 'the drawer sits over the right column');
  check(/OWNS SIM-AG1 MNQ/.test(await text('#agView [data-k="sOwns"]')), 'the strip: ' + await text('#agView [data-k="sOwns"]'));
  const lines = await page.evaluate(() => { const c = window.workspace.agent(); return c.chart; });
  check(lines && (await A()).chartRoot === 'MNQ' && /^MNQ/.test(await text('#agView [data-k="chartName"]')), 'the Agent tab\'s chart is on the agent\'s root, MNQ (its working entry\'s, not its first root NQ): ' + await text('#agView [data-k="chartName"]'));
  await sleep(1200);
  await page.screenshot({ path: path.join(SHOTS, 'agent-tab.png') });
  await page.setViewportSize({ width: 1366, height: 768 });                             // Anthony's laptop: no page scroll
  await sleep(600);
  const fit = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, w: innerWidth, h: innerHeight }));
  check(fit.sw <= fit.w && fit.sh <= fit.h, 'at 1366 x 768 the Agent tab fits the window (no page scroll, none sideways): ' + JSON.stringify(fit));
  check(await page.evaluate(() => { const f = document.querySelector('#agView .ag-foot').getBoundingClientRect(), c = document.querySelector('#agView .ag-chart').getBoundingClientRect(); return f.bottom <= innerHeight + 1 && c.bottom <= f.top; }), 'at 1366 x 768 the chart ends above the footer, and the footer is in the window');
  await page.screenshot({ path: path.join(SHOTS, 'agent-1366.png') });
  await page.setViewportSize({ width: 390, height: 844 });                              // a phone
  await sleep(700);
  const phone = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, tab: [...document.querySelectorAll('#agView *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && !e.closest('.chart-live') && !e.closest('.ag-light'); }).length }));
  check(phone.sw <= phone.w && phone.tab === 0, 'at phone width (390 px) no sideways scroll and nothing of the tab past the edge: ' + JSON.stringify(phone));
  await page.screenshot({ path: path.join(SHOTS, 'agent-phone.png') });
  await page.setViewportSize({ width: 1600, height: 900 });

  /* ---------------------------------------------------------------- a cancel not confirmed (ChartBridge 0.5.0 as built) */
  console.log('a cancel NinjaTrader does not confirm: sent again every 3 s, the warning on the workspace\'s line');
  await control('agent-stuck-cancel', { agent: 'demo', n: 2 });
  await control('agent-withdraw', { agent: 'demo', id: 'cp1' });                        // its unfilled entry's cancel is not confirmed twice
  await until(async () => /Agent demo: the cancel of its entry .* was not confirmed in 3 s .*check NinjaTrader/.test(await page.textContent('#wsAlert')), 'ChartBridge\'s warning shows as its other warnings do', 6000);
  await until(async () => !(await A()).orders.some(o => o.by === 'agent:demo' && o.role === 'entry'), 'the entry is gone at the third try', 8000);
  await page.click('#wsAlertClose').catch(() => {});

  /* ---------------------------------------------------------------- expiry: Accept closes in the last 5 s */
  console.log('expiry');
  const ex = await control('agent-plan', { agent: 'demo', id: 'cp2', side: 'sell', kind: 'limit', p: 25410, qty: 1, stop: 20, target: 40, expire: 60 });
  check(!ex.refused, 'a second plan: ' + (ex.refused || 'proposed'));
  await until(() => page.isVisible('.ag-plist .ag-prop[data-id="cp2"]'), 'proposal cp2');
  await control('agent-expire', { agent: 'demo', id: 'cp2', ms: 4000 });
  await until(async () => page.isDisabled('.ag-plist .ag-prop[data-id="cp2"] [data-agans="accept"]'), 'Accept closes with under 5 s left');
  check(/too late to accept/.test(await text('.ag-plist .ag-prop[data-id="cp2"] [data-k="msg"]')), 'it says so: ' + await text('.ag-plist .ag-prop[data-id="cp2"] [data-k="msg"]'));
  check(!(await page.isDisabled('.ag-plist .ag-prop[data-id="cp2"] [data-agans="reject"]')), 'Reject still goes');
  await until(async () => (await agentsNow()).find(a => a.agent === 'demo').proposals.find(p => p.id === 'cp2').state === 'expired', 'ChartBridge expires it', 8000);
  await until(async () => !(await page.$('.ag-prop[data-id="cp2"]')), 'the expired card goes', 6000);
  check(/expired/.test(await text('.ag-feed')) && /accepted in \d+\.\d s/.test(await text('.ag-feed')), 'the feed says how each proposal ended (on its plan): ' + (await text('.ag-feed')).slice(0, 160));
  await lightIs('passed', 'passed', ['prop', 'stream'], 'a plan that expired');

  /* ---------------------------------------------------------------- the flat hours on an account NinjaTrader no longer lists */
  console.log('the flat hours: an account NinjaTrader no longer lists gives NOT FLAT on the workspace\'s line');
  await control('agent-plan', { agent: 'demo', id: 'fl1', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 12, target: 24, expire: 900 });
  await until(() => page.isVisible('.ag-plist .ag-prop[data-id="fl1"]'), 'proposal fl1');
  await page.click('.ag-plist .ag-prop[data-id="fl1"] [data-agans="accept"]');
  await until(async () => (await A()).orders.some(o => o.by === 'agent:demo' && o.role === 'entry'), 'fl1 working');
  await control('price', { root: 'MNQ', p: 25389.75 });                                   // it fills: a position, its legs
  await until(async () => /Long 1 MNQ/.test(await text('.ag-strip [data-k="sPos"]')), 'demo is long 1 MNQ');
  /* ChartBridge 0.5.4 (DECISION 2026-10-10 ag): in a trade the window alone may change; one that flattens him now asks first */
  check((await text('#agView [data-act="rulesOpen"]')) === 'Change the window' && !(await page.isDisabled('#agView [data-act="rulesOpen"]')), 'in a trade: Change the window');
  await page.click('#agView [data-act="rulesOpen"]');
  check(await page.isDisabled('#agView [data-r="maxTrades"]') && await page.isDisabled('#agView [data-qty="MNQ"]') && !(await page.isDisabled('#agView [data-r="flatAt"]')) && !(await page.isDisabled('#agView [data-r="entryFrom"]')),
    'in a trade only the three times of the window are open');
  const rulesSent = async () => (await sent()).filter(m => m.type === 'agentRules').length;
  const rs0 = await rulesSent();
  await page.fill('#agView [data-r="entryFrom"]', '11:30');
  await page.click('#agView [data-act="rulesSave"]');
  check(await visible('#agView [data-k="rulesAsk"]') && /in his flat hours now \(flat at 15:55, new entries from 11:30\): ChartBridge flattens his position at once/.test(await text('#agView [data-k="rulesAsk"]')) && (await rulesSent()) === rs0,
    'a window starting after now asks first, in the page; nothing sent: ' + await text('#agView [data-k="rulesAsk"]'));
  await page.click('#agView [data-act="rulesNo"]');
  check(!(await visible('#agView [data-k="rulesAsk"]')) && (await rulesSent()) === rs0, 'Cancel: nothing sent');
  await page.fill('#agView [data-r="entryFrom"]', '09:45');
  await page.fill('#agView [data-r="flatAt"]', '15:58');
  await page.click('#agView [data-act="rulesSave"]');
  await until(async () => /15:58/.test(await text('#agView [data-k="rules"]')), 'the new flat time is in force, in the trade');
  check((await rulesSent()) === rs0 + 1 && /Long 1 MNQ/.test(await text('.ag-strip [data-k="sPos"]')), 'one agentRules; still in the trade');
  /* an open trade: the light moves to the chart and the P&L, the faster lap, its colour the open P&L */
  await control('price', { root: 'MNQ', p: 25393 });
  await until(async () => /^\+\$/.test(await text('#agView [data-k="cPnl"]')), 'the open P&L shows the gain (NinjaTrader\'s figure for the account)');
  const up = await lightIs('trade', 'bridge', ['chart', 'pnl'], 'an open trade in profit');
  check(up.fast && (await lapOf()) === '9s', 'in a trade the light takes 9 s a lap: ' + await lapOf());
  check((await text('#agView [data-k="said"]')) === 'In a trade, long 1 MNQ', 'the tracker says the plain fact, no "in profit": ' + await text('#agView [data-k="said"]'));
  check(/\+\$/.test(await text('#agView [data-k="cPnl"]')) && (await page.getAttribute('#agView [data-k="cPnl"]', 'class')).includes('pos'), 'the chart\'s header: the open P&L in green: ' + await text('#agView [data-k="cPnl"]'));
  const still = await page.evaluate(() => ['[data-k="sPnl"]', '[data-k="cPnl"]', '[data-k="cPos"]', '[data-k="sTrades"]', '.ag-chart canvas', '.ag-chart .chart-live'].map(sel => { const e = document.querySelector('#agView ' + sel); if (!e) return sel + ' missing'; const c = getComputedStyle(e); return c.transitionDuration.split(',').every(d => parseFloat(d) === 0) && c.animationName === 'none' && !!e.closest('[data-no-motion]') ? '' : sel + ' ' + c.transitionProperty + ' ' + c.transitionDuration; }).filter(Boolean));
  check(!still.length, 'the P&L figures, the position, the price line (the chart) have no transition and sit under data-no-motion' + (still.length ? ': ' + still.join('; ') : ''));
  check(await page.evaluate(() => [...document.querySelectorAll('#agView .ag-trail .ag-ev')].some(e => e.textContent === 'F' && /^Bought 1 MNQ at 25,3(89\.75|90\.00)/.test(e.title) && getComputedStyle(e).getPropertyValue('--tc').trim() === '#3dff9a')),
    'his session\'s trail marks the fill (F, green), drawn above the now mark');
  await shotF('agent-f-profit');
  const r3t = await r3Moving();
  check(!r3t.length, 'R3: in a trade, no figure, price, chip, row or button moves, on its own or through an ancestor' + (r3t.length ? ': ' + JSON.stringify(r3t.slice(0, 6)) : ''));
  await control('price', { root: 'MNQ', p: 25388 });                                   // under water, above its stop
  await until(async () => /^-\$/.test(await text('#agView [data-k="cPnl"]')), 'the open P&L shows the loss');
  await lightIs('trade', 'no', ['chart', 'pnl'], 'an open trade under water');
  check(/-\$/.test(await text('#agView [data-k="cPnl"]')) && (await page.getAttribute('#agView [data-k="cPnl"]', 'class')).includes('neg'), 'the open P&L in red at once: ' + await text('#agView [data-k="cPnl"]'));
  await shotF('agent-f-under');
  await control('agent-unlist', { account: 'SIM-AG1' });
  await control('agent-flat-hours', { agent: 'demo' });
  await until(async () => /Agent demo: NOT FLAT\? its flatten \(.*\) waits: SIM-AG1 \(account not listed by NinjaTrader\)/.test(await page.textContent('#wsAlert')), 'the NOT FLAT error shows as ChartBridge\'s other errors do (10 s after the flatten starts, as built)', 16000);
  check(/Long 1 MNQ/.test(await text('.ag-strip [data-k="sPos"]')), 'nothing goes to an account NinjaTrader does not list');
  await page.screenshot({ path: path.join(SHOTS, 'agent-notflat.png'), clip: { x: 0, y: 0, width: 1600, height: 200 } });
  await control('agent-unlist', { account: 'SIM-AG1', on: 0 });
  await until(async () => (await text('.ag-strip [data-k="sPos"]')) === 'Flat', 'the account is back: ChartBridge flattens it');
  await until(async () => (await light()).phase === 'exit', 'a flat exit');
  const out = await lightIs('exit', (await light()).tone, ['pipe', 'pnl'], 'a flat exit: back on the tracker');
  check(/^Out of the trade/.test(out.said) && ['bridge', 'no'].includes(out.tone), 'how it went: ' + out.said);
  await control('agent-flat-hours', { agent: 'demo', on: 0 });
  await control('price', { root: 'MNQ', p: 25400 });
  await page.click('#wsAlertClose').catch(() => {});

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
  await control('agent-note', { agent: 'demotwo', kind: 'notebook', text: 'Sample notebook v1: wait for a made-up level to be tested twice' });
  await control('agent-note', { agent: 'demotwo', kind: 'status', text: 'Sample status: watching MNQ and NQ' });
  await lightIs('watch', 'screen', ['pipe'], 'watching (a notebook and a status are not decisions)');
  await shotF('agent-f-watching');
  /* the Motion switch: Off stops the light and keeps the glow, kept in this browser; reduced motion does the same */
  await page.click('#agView [data-motion="off"]');
  await until(async () => (await orbits()) === '', 'Motion Off: no light animation');
  check(await page.evaluate(() => { const p = document.querySelector('#agView .ag-panel.lit'); return !!p && getComputedStyle(p).boxShadow !== 'none' && getComputedStyle(p.querySelector('.ag-light')).display === 'none' && localStorage.getItem('live-agent-motion-v1') === 'off' && document.querySelector('#agView [data-motion="off"]').getAttribute('aria-pressed') === 'true'; }),
    'Motion Off: the light stops, the glow stays where his attention is, the choice kept in this browser');
  await page.click('#agView [data-motion="full"]');
  await until(async () => (await orbits()) === 'pipe', 'Motion Full: the light again');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await until(async () => (await orbits()) === '', 'the system\'s reduced motion: no light animation');
  check(await page.evaluate(() => getComputedStyle(document.querySelector('#agView .ag-panel.lit')).transitionDuration.split(',').every(d => parseFloat(d) === 0)), 'reduced motion: no transition either');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await until(async () => (await orbits()) === 'pipe', 'the light back');
  await page.selectOption('#agView [data-k="pick"]', 'demo');
  await until(async () => (await text('.ag-strip [data-k="name"]')) === 'Demo Agent', 'Demo Agent shown');
  await page.click('#agView [data-mode="copilot"]');
  await until(async () => (await agentsNow()).find(a => a.agent === 'demo').mode === 'copilot', 'demo in Copilot');
  // two agents' proposals open: demotwo's (older; with the tab open only counted under the proposal, never a card on the tab)
  // and demo's (in the tab); a quick double press of Accept
  await control('agent-plan', { agent: 'demotwo', id: 'k2', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 12, target: 24, expire: 900 });
  await until(async () => /^Second Demo Agent: 1 proposal$/.test(await text('#agView [data-panel="prop"] [data-k="others"]')), 'demotwo\'s proposal counted under the proposal');
  check(!(await visible('.ag-prop.corner[data-id="k2"]')) && !(await page.evaluate(() => [...document.querySelectorAll('[data-agans], [data-ans]')].some(b => b.getClientRects().length && !b.closest('#agView .ag-plist')))),
    'with the Agent tab open demotwo\'s proposal is no card: no Accept or Reject but in the slot');
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
  check((await agentsNow()).find(a => a.agent === 'demotwo').proposals.find(p => p.id === 'k2').state === 'open', 'demotwo\'s k2 (not shown on the tab) untouched');
  await control('agent-withdraw', { agent: 'demo', id: 'k1' });
  // off the tab: demotwo's proposal is no card anywhere, only counted in the corner's line; the key answers the bot's (1.16.0)
  await page.click('#wsAgentTab');
  await until(async () => !(await A()).shown, 'the tab closes');
  await until(async () => (await text('.ag-cornerline')) === 'Second Demo Agent: 1 proposal', 'the tab closed: demotwo\'s proposal counted in the corner\'s line');
  check(!(await page.evaluate(() => [...document.querySelectorAll('[data-agans]')].some(b => b.getClientRects().length))), 'off the tab no agent Accept or Reject anywhere');
  await control('bot-connect', { name: 'Sample Lantern Fade' });
  await control('bot-proposal', { id: 'b1', side: 'sell', kind: 'market', stop: 12, target: 24, reason: 'Sample: the made-up bot\'s signal' });
  await until(() => visible('.bt-prop[data-id="b1"]'), 'the bot\'s proposal in the corner');
  await sleep(1100);
  await page.screenshot({ path: path.join(SHOTS, 'agent-corner.png') });
  await page.mouse.click(800, 450);
  const a1 = (await answersSent()).length;
  await page.keyboard.press('Alt+KeyN');
  await until(async () => (await control('v3')).proposals.find(p => p.id === 'b1').state === 'rejected', 'the key answers the bot\'s (agents\' proposals are answered only in the Agent tab)');
  check((await answersSent()).length === a1 && (await agentsNow()).find(a => a.agent === 'demotwo').proposals.find(p => p.id === 'k2').state === 'open', 'and never demotwo\'s k2');
  await until(() => page.evaluate(() => !document.querySelector('.bt-prop[data-id="b1"]:not(.bt-ended)')), 'the bot\'s card shows it ended');
  // the corner's line opens the tab on demotwo: k2 answered there with its button
  await page.click('.ag-cornerline [data-goto="agent:demotwo"]');
  await until(async () => (await A()).shown && (await A()).chosen === 'demotwo', 'the Agent tab on demotwo');
  await page.click('.ag-plist .ag-prop[data-id="k2"] [data-agans="reject"]');
  await until(async () => (await agentsNow()).find(a => a.agent === 'demotwo').proposals.find(p => p.id === 'k2').state === 'rejected', 'k2 rejected by its button');
  await until(async () => !(await page.$('.ag-prop[data-id="k2"]')), 'its card goes', 6000);
  await page.selectOption('#agView [data-k="pick"]', 'demo');
  await page.click('#wsAgentTab');
  await until(async () => !(await A()).shown, 'the tab closes again');
  await page.mouse.click(800, 450);
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
  /* the corner notices cover none of the tab: never the left column (its rules and Change the rules), the proposal, the
     tracker, the stream or the footer; they stack in the chart panel's lower left */
  console.log('the corner notices while the Agent tab is open');
  await until(async () => (await A()).shown && (await A()).chosen === 'demo', 'the tab open on Demo Agent');
  await control('agent-plan', { agent: 'demo', id: 'n1', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 12, target: 24, expire: 900, setup: 'Sample pullback', reason: 'Sample: a made-up reason for the notices check' });
  await until(() => page.isVisible('.ag-plist .ag-prop[data-id="n1"]'), 'a proposal in the tab');
  for (const [w, h] of [[1440, 1000], [1366, 768]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(700);
    await control('agent-connect', { agent: 'demotwo', on: 0 });                       // a heartbeat lost, then back: two notices
    await control('agent-connect', { agent: 'demotwo', name: 'Second Demo Agent', build: 'sample-build-7' });
    await page.click('#agView [data-mode="shadow"]');                                  // and a mode change: a third
    await until(async () => (await page.$$('.ag-note')).length >= 3, 'three corner notices at ' + w + ' x ' + h);
    const hits = await page.evaluate(() => {
      const box = e => e.getBoundingClientRect();
      const meet = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const keep = { left: '#agView .ag-left', rules: '#agView [data-k="rules"]', rulesOpen: '#agView [data-act="rulesOpen"]', proposal: '#agView [data-panel="prop"]', card: '#agView .ag-plist .ag-prop',
        tracker: '#agView [data-panel="pipe"]', stream: '#agView [data-panel="stream"]', footer: '#agView .ag-foot', strip: '#agView .ag-strip' };
      const notes = [...document.querySelectorAll('.ag-note')].filter(n => box(n).height > 0), chart = box(document.querySelector('#agView [data-panel="chart"]'));
      const out = [];
      for (const n of notes) {
        for (const [k, sel] of Object.entries(keep)) { const e = document.querySelector(sel); if (e && box(e).height && meet(box(n), box(e))) out.push(k); }
        const b = box(n); if (b.left < chart.left || b.right > chart.right || b.top < chart.top || b.bottom > chart.bottom) out.push('outside the chart panel');
      }
      return { notes: notes.length, hits: out };
    });
    check(hits.notes >= 3 && !hits.hits.length, 'at ' + w + ' x ' + h + ' the corner notices sit in the chart panel and cover nothing else of the tab: ' + JSON.stringify(hits));
    if (w === 1440) await page.screenshot({ path: path.join(SHOTS, 'agent-f-notices.png') });
    await page.click('#agView [data-mode="copilot"]');
    await until(async () => (await agentsNow()).find(a => a.agent === 'demo').mode === 'copilot', 'demo back in Copilot');
    if (w === 1440) {                                                                  // Copilot again: a fresh proposal for the second size
      await control('agent-plan', { agent: 'demo', id: 'n2', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 12, target: 24, expire: 900 });
      await until(() => page.isVisible('.ag-plist .ag-prop[data-id="n2"]'), 'a second proposal in the tab');
    }
  }
  await control('agent-withdraw', { agent: 'demo', id: 'n2' });
  await page.setViewportSize({ width: 1600, height: 900 });
  const [pop] = await Promise.all([ctx.waitForEvent('page'), page.click('.ag-popbtn')]);
  pop.on('pageerror', e => fail('pop-out error: ' + e.message));
  await pop.waitForLoadState();
  if (await pop.$('.cb-pin-key')) await enterPin(pop, TEST_PIN);
  await pop.waitForFunction(() => window.agentDesk && window.agentDesk.state().agents.length === 2, null, { timeout: 20000 });
  await pop.waitForFunction(() => /Demo Agent/.test(document.querySelector('.ag-strip').textContent), null, { timeout: 10000 });
  check(/\/live\/agent\.html$/.test(pop.url()), 'an agent-only page (agent.html) for a third monitor');
  check(await pop.evaluate(() => getComputedStyle(document.querySelector('.ag-view')).fontFamily.includes('Chakra Petch') && document.fonts.check('600 12px "Chakra Petch"') && document.fonts.check('12px "JetBrains Mono"') && document.fonts.check('12px "IBM Plex Sans"')), 'the pop-out has the tab\'s fonts, from this PC');
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
