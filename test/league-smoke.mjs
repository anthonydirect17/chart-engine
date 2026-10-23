// Chart 1.35.0 smoke (Anthony 2026-10-21): the League tab and the league's trades faint on any chart; 1.36.0 (Anthony 2026-10-22):
// the Bot panel is gone, merged into the Agents strip (its bot card opens the Bot view). Against the fake bridge (--v3, the made-up Demo Agent, sample data) and the fake Desk (test/fake-desk.mjs)
// serving a SAMPLE league day (made up here: three seats, made-up paper trades on the sample bars, made-up decisions; no real
// league, no model name, no account), at 1366 x 768, 1600 x 900 and 1920 x 1080:
//   npm run smoke:league        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Checks: the top bar keeps the Agent tab as it was, League after it, and the Bot button (no Agents strip on the layout); + Add
// panel offers no Bot (1.36.0) but Agents;
// the League tab hides the grid and shows SHADOW: no orders, the legend H Haiku, S Sonnet, O Opus, the seats' day, the week and
// month table ("not enough data yet" under 20), the decision log, the spend against the caps and the day closed note; its chart
// carries the hollow marks (pixels drawn on the overlay, never on the chart's canvas); a chart's ⋯ switch shows them faintly,
// off by default, kept in this browser; the Agent tab and the League tab close each other; with an Agents strip the Bot button
// stays in the top bar (it does on every layout) and the strip's bot card opens the Bot view; the button stays in reach while a
// view is open and while it carries its red alert (review 2), and is still there when the strip goes; nothing sends an order.
// Screenshots test/out/league-*.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { startDesk } from './fake-desk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.LEAGUE_SMOKE_PORT || 8815), DP = PORT + 40;
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };

/* the SAMPLE league day, its times on the sample bars (filled in once the chart has bars) */
function sampleDay(bars) {
  const t = k => bars[bars.length - k].t * 1000, px = k => bars[bars.length - k].c;
  const desc = (n, mean, enough) => ({ n, days: 3, mean_r: mean, enough });
  const seat = (n, mean) => ({ score: desc(n, mean, n >= 20), rolling: { week: desc(n, mean, n >= 20), month: desc(n, mean, n >= 20) }, mentor: { agreement: 0.5 }, latency: { n: 12, median_s: 3.4 }, fences: { cleared: null } });
  return {
    shadow: 'SHADOW: no orders', folder: { set: true, ok: true, problem: null }, date: '2026-10-22',
    day: { date: '2026-10-22', closed: true, note: 'The day closed at 16:01 (its standings are written); the league keeps recording the tape to 17:00, so the live status is the one from the close.' },
    status: { date: '2026-10-22', now: '16:01:00', feed: 'live', seats: {
      H: { status: 'active', flag: null, decisions: 14, entries: 2, flex: { phase: 'eval', balance: 50120, today_pnl: 40 }, position: null },
      S: { status: 'active', flag: null, decisions: 12, entries: 1, flex: { phase: 'eval', balance: 49980, today_pnl: -20 }, position: { side: 'long', contracts: 3, fill_px: px(10) } },
      O: { status: 'active', flag: 'cleared fence 2.99 on day 60 (z 3.1): flag for Anthony (sample)', decisions: 11, entries: 1, flex: { phase: 'eval', balance: 50300, today_pnl: 150 }, position: null } },
      spend: { day_spent: 3, day_cap: 9.5, month_spent: 12.25, month_cap: 200, stopped: null } },
    league: { enough_n: 20, seats: { H: seat(24, 0.12), S: seat(4, -0.3), O: seat(30, 0.6) } },
    trades: [
      { id: 's-H-1', seat: 'H', side: 'short', contracts: 5, fill_t: t(40), fill_px: px(40), stop_px: px(40) + 15, target_px: px(40) - 30, exit_t: t(25), exit_px: px(25), exit_reason: 'target', r: 1.2, relation: 'with' },
      { id: 's-O-1', seat: 'O', side: 'long', contracts: 4, fill_t: t(30), fill_px: px(30), stop_px: px(30) - 18, target_px: px(30) + 36, exit_t: t(15), exit_px: px(15), exit_reason: 'stop', r: -1, relation: 'own' }],
    open: [{ id: 's-S-1', seat: 'S', side: 'long', contracts: 3, fill_t: t(10), fill_px: px(10), stop_px: px(10) - 25, target_px: px(10) + 50 }],
    decisions: [
      { id: 'd1', seat: 'H', t: t(41), time: '10:01:00', trigger: 'grid', latency_s: 2.1, call_ok: true, refused: null, answer: { action: 'enter', side: 'short', stop_points: 15, target_points: 30, reference: 'VWAP', reasoning: 'made up for the smoke' }, relation: 'with', contracts: 5 },
      { id: 'd2', seat: 'S', t: t(35), time: '10:06:00', trigger: 'grid', latency_s: 4.2, call_ok: true, refused: null, answer: { action: 'pass', reasoning: 'made up: no edge at the level' } },
      { id: 'd3', seat: 'O', t: t(31), time: '10:10:00', trigger: 'touch IBL', latency_s: 9.5, call_ok: true, refused: 'stop wider than 25 points (made up)', answer: { action: 'enter' } }],
  };
}

const desk = await startDesk(DP, {});
/* The Desk of this release answers GET /api/chart-league from the start (no session yet); the sample day comes once the chart has bars */
desk.league = { shadow: 'SHADOW: no orders', folder: { set: true, ok: true, problem: 'The league has no session yet.' }, trades: [], open: [], decisions: [] };
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--agents=demo', '--agent-any-time', '--bot-account=Sim101', '--test-pin=' + TEST_PIN, '--desk-url=http://127.0.0.1:' + DP], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const inked = (p, sel) => p.$eval(sel, cv => { const c = cv.getContext('2d'), d = c.getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'plan', 'groupOrder'].includes(m.type)) window.__sent.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
    try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: { Lg: { panels: [
      { id: 'c1', type: 'chart', root: 'MNQ', tf: 'm1', x: 0, y: 0, w: 8, h: 6 }, { id: 'c2', type: 'chart', root: 'ES', tf: 'm1', x: 8, y: 0, w: 4, h: 3 }] } } })); } catch (e) { /* blocked */ }
  });
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.goto(`http://localhost:${PORT}/live/?layout=Lg`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  const bars = await until(() => p.evaluate(() => { const c = window.workspace.chart('c1'); const b = c && c.bars(); return b && b.length > 60 ? b.map(x => ({ t: x.t, c: x.c })) : null; }), 'the MNQ chart\'s bars', 20000);
  desk.league = sampleDay(bars);
  /* the made-up bot connected, so it carries no alert of its own until the test raises one (review 2) */
  await fetch(`http://127.0.0.1:${PORT}/test/bot-connect?name=Demo%20Opening%20Fade`, { method: 'POST' });
  await until(() => p.$eval('#wsBotTab', b => !b.classList.contains('bt-alert')), 'the made-up bot connected: no alert', 10000);

  /* the top bar: Agent (as it was), then League; the Bot button in the top bar (1.36.0: on a layout with no Agents strip) */
  check(await p.isVisible('#wsLeagueTab') && (await p.textContent('#wsLeagueTab')) === 'League', 'the top bar has the League tab');
  check(await p.evaluate(() => document.getElementById('wsAgentTab').nextElementSibling === document.getElementById('wsLeagueTab') && !!document.getElementById('wsAgentTab').closest('.ws-top')), 'the Agent tab stays in the top bar, League right after it');
  check(await p.isVisible('#wsBotTab') && await p.$eval('#wsTabSlot', h => h.contains(document.getElementById('wsBotTab'))), '1.36.0: no Agents strip on the layout: the Bot button is in the top bar');
  await p.click('#wsAdd');
  const menu = await p.$$eval('#wsAddMenu [data-add]', bs => bs.map(b => b.textContent));
  check(!menu.includes('Bot') && menu.includes('Agents') && !menu.some(t => /^Agent( tab| desk)?$/.test(t)), '1.36.0: + Add panel offers no Bot panel and no Agent tab panel, and the Agents strip: ' + menu.join(', '));
  await p.click('#wsAdd');

  /* the League tab */
  await p.click('#wsLeagueTab');
  await until(() => p.evaluate(() => document.body.classList.contains('lg-on') && window.workspace.league().trades === 2), 'the League tab with the sample day', 15000);
  check(await p.$eval('#wsGrid', g => getComputedStyle(g).display === 'none'), 'the League tab hides the grid');
  check(new URL(p.url()).searchParams.get('tab') === 'league', '?tab=league in the address');
  const text = await p.$eval('#lgView', e => e.innerText);
  check(/SHADOW: no orders/.test(text), 'SHADOW: no orders');
  check(/H\s*Haiku/.test(text) && /S\s*Sonnet/.test(text) && /O\s*Opus/.test(text), 'the legend strip: H Haiku, S Sonnet, O Opus');
  const legend = await p.$$eval('.lg-legend .lg-key', ks => ks.map(k => getComputedStyle(k.querySelector('i')).color));
  check(legend.join('|') === 'rgb(255, 194, 102)|rgb(93, 224, 240)|rgb(182, 156, 255)', 'H amber, S cyan, O violet: ' + legend.join(', '));
  check(/day closed, recording to 17:00/.test(text), 'the day closed note (status from the 16:01 close)');
  check(/LONG 3 MNQ/.test(text) && /Flag for you: cleared fence 2\.99 on day 60/.test(text), 'the seats\' day: S\'s open paper trade, O\'s flag');
  check(/not enough data yet \(n 4 of 20\)/.test(text) && /\+0\.12 R \(n 24\)/.test(text), 'the week and month table: net R with n, not enough data yet under 20');
  check(/\$3\.00 of \$9\.50 today/.test(text) && /\$12\.25 of \$200\.00 this month/.test(text), 'the API spend against the caps');
  const log = await p.$$eval('.lg-log .lg-row', rs => rs.map(r => r.className + ' ' + r.textContent));
  check(log.length === 3 && /k-refused/.test(log[0]) && /k-pass/.test(log[1]) && /k-enter/.test(log[2]) && /short 5 MNQ, stop 15 pt, target 30 pt at VWAP/.test(log[2]) && /\(with you\)/.test(log[2]), 'the decision log, newest first: ' + log.length + ' rows');
  const ink = await until(async () => { const n = await inked(p, '#lgView .lg-overlay'); return n > 200 ? n : null; }, 'the marks drawn', 10000);
  check(!!ink, 'the league chart carries the marks on its overlay (' + ink + ' pixels)');
  check((await p.evaluate(() => window.workspace.league().marks)) === 5, 'five marks: three fills and two exits');
  await p.screenshot({ path: path.join(out, 'league-1366.png') });
  const box = await p.$eval('#lgView .lg-chartbox', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  await p.screenshot({ path: path.join(out, 'league-chart.png'), clip: box });
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 1366');
  for (const [w, h] of [[1600, 900], [1920, 1080]]) {
    await p.setViewportSize({ width: w, height: h }); await wait(600);
    check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at ' + w);
    await p.screenshot({ path: path.join(out, `league-${w}.png`) });
  }
  await p.setViewportSize({ width: 1366, height: 768 }); await wait(300);
  await p.click('#wsLeagueTab');
  await until(() => p.evaluate(() => !document.body.classList.contains('lg-on')), 'back to the layout');

  /* a chart's ⋯ switch: the league's trades, faint, off by default; not offered on ES */
  check((await p.evaluate(() => window.workspace.leagueGhosts().length)) === 0 && !(await p.$('.ws-panel[data-id="c1"] .lg-overlay')), 'off by default: no marks on the charts');
  await p.click('.ws-panel[data-id="c2"] .ws-more');
  check(await p.$eval('#wsMore [data-do="league"]', b => b.hidden), 'not offered on an ES chart');
  await p.click('.ws-panel[data-id="c2"] .ws-more');
  await p.click('.ws-panel[data-id="c1"] .ws-more');
  check((await p.textContent('#wsMore [data-do="league"]')) === 'League trades (faint): off', 'the MNQ chart\'s ⋯: League trades (faint): off');
  await p.click('#wsMore [data-do="league"]');
  const ink2 = await until(async () => { const n = await inked(p, '.ws-panel[data-id="c1"] .lg-overlay').catch(() => 0); return n > 100 ? n : null; }, 'the faint marks on the MNQ chart', 40000);
  check(!!ink2, 'on: the league\'s trades, faint, on that chart (' + ink2 + ' pixels)');
  await p.screenshot({ path: path.join(out, 'league-faint-1366.png') });
  check(await p.evaluate(() => JSON.parse(localStorage.getItem('live-league-ghost-v1')).c1 === true), 'kept in this browser');
  /* review 3: the League tab was open once; after it closed the faint marks still follow The Desk (a new paper trade shows) */
  const n0 = await p.evaluate(() => window.workspace.leagueGhostTrades());
  const d2 = sampleDay(bars);
  d2.trades.push({ id: 's-S-2', seat: 'S', side: 'short', contracts: 2, fill_t: bars[bars.length - 5].t * 1000, fill_px: bars[bars.length - 5].c, stop_px: bars[bars.length - 5].c + 20, target_px: null, exit_t: bars[bars.length - 2].t * 1000, exit_px: bars[bars.length - 2].c, exit_reason: 'flat time', r: 0.1 });
  desk.league = d2;
  const n1 = await until(async () => { const n = await p.evaluate(() => window.workspace.leagueGhostTrades()); return n === n0 + 1 ? n : null; }, 'a new paper trade on the faint marks after the League tab was closed', 45000);
  if (await p.isVisible('#wsAlertClose')) await p.click('#wsAlertClose');   // the fake bridge's made-up "EVAL-B is gone" banner, over the headers
  if (n1 !== n0 + 1) console.log('  debug: ' + JSON.stringify(await p.evaluate(() => ({ body: document.body.className, n: window.workspace.leagueGhostTrades(), ghosts: window.workspace.leagueGhosts() }))));
  check(n1 === n0 + 1, 'review 3: the faint marks read on after the League tab closed (' + n0 + ' to ' + n1 + ' trades)');
  await p.click('.ws-panel[data-id="c1"] .ws-more');
  await p.click('#wsMore [data-do="league"]');
  await until(async () => !(await p.$('.ws-panel[data-id="c1"] .lg-overlay')), 'off again: the marks go');

  /* the Agent tab stays in the top bar, as it was (Anthony 2026-10-21): the League tab closes it and it closes the League tab */
  await until(() => p.isVisible('#wsAgentTab'), 'the Agent tab (the agents came)', 15000);
  await p.click('#wsAgentTab');
  await until(() => p.evaluate(() => window.workspace.agent().shown && document.body.classList.contains('ag-on')), 'the Agent tab opens as before');
  check(new URL(p.url()).searchParams.get('tab') === 'agent', '?tab=agent as before');
  await p.click('#wsLeagueTab');
  await until(() => p.evaluate(() => !window.workspace.agent().shown && document.body.classList.contains('lg-on')), 'one view at a time: the League tab closes the Agent tab');
  await p.click('#wsAgentTab');
  await until(() => p.evaluate(() => window.workspace.agent().shown && !document.body.classList.contains('lg-on')), 'and the Agent tab closes the League tab');
  await p.screenshot({ path: path.join(out, 'league-agent-tab-1366.png') });
  await p.click('#wsAgentTab');
  await until(() => p.evaluate(() => !window.workspace.agent().shown), 'closed');

  /* 1.36.0: the Bot through the Agents strip (the Bot panel is gone); 1.38.0: the strip is the Drone sky, the bot a drone */
  await p.click('#wsBotTab');
  await until(() => p.evaluate(() => document.body.classList.contains('bt-on')), 'the Bot view from the top bar as before');
  check(new URL(p.url()).searchParams.get('tab') === 'bot', '?tab=bot as before');
  await p.click('#wsBotTab');
  await until(() => p.evaluate(() => !document.body.classList.contains('bt-on')), 'closed again from its button');
  await p.click('#wsAdd'); await p.click('#wsAddMenu [data-add="agents"]');
  /* the bot's drone: in the sky, or (a narrow panel) in the "+N more" list */
  const botSel = await until(async () => (await p.$('.ws-panel.agents .ak-hit[data-key="bot"]')) ? '.ws-panel.agents .ak-hit[data-key="bot"]'
    : (await p.$('.ws-panel.agents .ak-mi[data-key="bot"]')) ? '.ws-panel.agents .ak-mi[data-key="bot"]' : null, 'the Agents panel with the bot\'s drone', 15000);
  const openBotDrone = async () => { if (/ak-mi/.test(botSel) && await p.$eval('.ws-panel.agents .ak-more', e => e.hidden)) await p.click('.ws-panel.agents .ak-idle'); await p.click(botSel); };
  const hoverBotDrone = async () => { if (/ak-mi/.test(botSel) && await p.$eval('.ws-panel.agents .ak-more', e => e.hidden)) await p.click('.ws-panel.agents .ak-idle'); await p.hover(botSel); };
  check(await p.isVisible('#wsBotTab') && await p.$eval('#wsTabSlot', h => h.contains(document.getElementById('wsBotTab'))), 'with an Agents strip the Bot button stays in the top bar (Anthony: "its fine there")');
  await openBotDrone();
  await until(() => p.evaluate(() => document.body.classList.contains('bt-on')), 'a click on the bot\'s drone opens the Bot view');
  check(await p.$eval('#wsTabSlot', e => e.contains(document.getElementById('wsBotTab'))) && await p.isVisible('#wsBotTab'), 'while the Bot view is open its button is in the top bar (the way back)');
  await p.click('#wsBotTab');
  await until(() => p.evaluate(() => !document.body.classList.contains('bt-on') && document.getElementById('wsTabSlot').contains(document.getElementById('wsBotTab'))), 'closed: the button still in the top bar');
  /* review 6: from the League view the Bot is one click away in the top bar */
  await p.click('#wsLeagueTab');
  await until(() => p.evaluate(() => document.body.classList.contains('lg-on')), 'the League view');
  await until(() => p.isVisible('#wsBotTab'), 'from the League view the Bot button is in the top bar', 5000);
  check(await p.$eval('#wsTabSlot', e => e.contains(document.getElementById('wsBotTab'))) && await p.isVisible('#wsAgentTab'), 'from the League view: Bot and Agent both in reach in the top bar');
  check(await p.evaluate(() => document.body.classList.contains('bt-has-tab')), 'review 5: the Layout word gives way (bt-has-tab) while the Bot button is in the top bar');
  await p.screenshot({ path: path.join(out, 'league-panels-1366.png') });
  await p.click('#wsBotTab');
  await until(() => p.evaluate(() => document.body.classList.contains('bt-on') && !document.body.classList.contains('lg-on')), 'the Bot view from the League view');
  /* review 2: the Bot's red alert is never hidden: killed, with the strip on the layout, the button stays in the top bar, red,
     and the strip's bot card carries the same alert */
  await p.click('.bt-kill');
  await until(() => p.$eval('#wsBotTab', b => b.classList.contains('bt-alert')), 'the bot killed: the alert on its button', 8000);
  await p.click('#wsBotTab');
  await until(() => p.evaluate(() => !document.body.classList.contains('bt-on')), 'the Bot view closed');
  await wait(300);
  const red = await p.$eval('#wsBotTab', b => ({ inTop: document.getElementById('wsTabSlot').contains(b), seen: b.getClientRects().length > 0, border: getComputedStyle(b).borderColor, cls: b.className }));
  check(red.inTop && red.seen && /bt-alert/.test(red.cls) && await p.isVisible('#wsBotTab'), 'the bot\'s alert raised: its button is in the top bar and seen, with the strip on the layout (' + red.border + ')');
  /* 1.38.0: the bot's drone says killed on its text block (in the alert's red), and its hover card is the strip's card in the red alert look */
  const drone = await until(async () => { const s = await p.evaluate(() => window.workspace.agentsStrip()); const d = s && s.drones.find(x => x.key === 'bot'); return d && d.state === 'killed' ? d : null; }, 'the bot\'s drone says killed', 5000);
  await hoverBotDrone();
  const card = await until(() => p.$eval('.ws-panel.agents .ak-pop [data-card="bot"]', e => (e.classList.contains('as-alert') && /killed/.test(e.innerText) ? e.innerText : null)), 'the bot\'s card carries the alert', 5000);
  check(!!drone && !!card, 'the bot\'s drone: killed, its card in the red alert look');
  await p.mouse.move(2, 400); await p.keyboard.press('Escape');
  check(await p.evaluate(() => document.body.classList.contains('bt-has-tab')), 'the Layout word gives way for it (bt-has-tab)');
  await p.screenshot({ path: path.join(out, 'league-bot-alert-1366.png') });
  await p.click('#wsBotTab');
  await until(() => p.evaluate(() => document.body.classList.contains('bt-on')), 'the Bot view again');
  await p.click('.bt-kill'); await wait(900); await p.click('.bt-kill');   // release asks a second click (not a double-click)
  await until(() => p.$eval('#wsBotTab', b => !b.classList.contains('bt-alert')), 'released: no alert', 8000);
  await p.click('#wsBotTab');
  await until(() => p.$eval('#wsTabSlot', h => h.contains(document.getElementById('wsBotTab'))), 'the alert cleared and the grid back: the button stays in the top bar', 8000);
  check(await p.evaluate(() => document.body.classList.contains('bt-has-tab')), 'the Layout word gives way while the Bot button is in the top bar (bt-has-tab), as before 1.35.0');
  await p.click('.ws-panel.agents [data-act="close"]');
  await until(() => p.$eval('#wsTabSlot', h => h.contains(document.getElementById('wsBotTab'))), 'the strip closed: the Bot button still in the top bar');
  check(await p.isVisible('#wsBotTab'), 'with no strip on the layout the Bot is one click away in the top bar');
  check((await p.evaluate(() => window.__sent.length)) === 0, 'nothing here sent an order message');

  /* a reload with ?tab=league keeps the League tab */
  await p.goto(`http://localhost:${PORT}/live/?layout=Lg&tab=league`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await until(() => p.evaluate(() => document.body.classList.contains('lg-on')), '?tab=league opens the League tab', 20000);
  check(true, 'a reload keeps the League tab');
  /* The Desk without a league folder: said plainly */
  desk.league = { shadow: 'SHADOW: no orders', folder: { set: false, ok: false, problem: null }, trades: [], open: [], decisions: [] };
  await p.evaluate(() => window.workspace.league && 0);
  await p.click('#wsLeagueTab'); await p.click('#wsLeagueTab');
  const nofolder = await until(() => p.$eval('#lgView [data-k="problem"]', e => (!e.hidden && /folder is not set/.test(e.textContent) ? e.textContent : null)), 'no folder said', 20000);
  check(!!nofolder, 'no league folder on The Desk: said plainly: ' + nofolder);
  await p.screenshot({ path: path.join(out, 'league-nofolder-1366.png') });
  await ctx.close();
} catch (e) {
  fail('threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  bridge.kill();
  await desk.close();
}
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall passed');
process.exit(errors.length ? 1 : 0);
