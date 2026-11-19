// Chart 1.35.0 smoke (Anthony 2026-10-21): the League tab (the Colosseum since 1.50.0); 1.36.0 (Anthony 2026-10-22): the Bot panel is
// gone, merged into the Agents strip (its bot card opens the Bot view). Plan step 3.2: Legion is its own page (live/legion.html), and
// the Colosseum is its third tab; the chart page keeps the Bot, a small Legion link, and reads no league. Against the fake bridge
// (--v3, the made-up Demo Agent, sample data) and the fake Desk (test/fake-desk.mjs) serving a SAMPLE league day (made up here: three
// seats, made-up paper trades on the sample bars, made-up decisions; no real league, no model name, no account), at 1366 x 768,
// 1600 x 900 and 1920 x 1080:
//   npm run smoke:league        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Checks on the chart page: the top bar is Chart, the Legion link and the Bot button; no Colosseum, Legion, Praetorian or Agent tab;
// + Add panel offers no Bot (1.36.0) but Agents; a chart's ⋯ menu has no league switch; with an Agents strip the Bot button stays in
// the top bar and the strip's bot drone opens the Bot view; the button stays in reach while it carries its red alert (review 2);
// the Drone sky reads NQ bars from the NQ line already open (1.38.1); the chart page reads no league at all; nothing sends an order.
// Checks on Legion's Colosseum: SHADOW: no orders, the legend H Haiku, S Sonnet, O Opus (O bronze, plan step 3.2: house style, no
// purple), the seats' day, the week and month table ("not enough data yet" under 20), the decision log, the spend against the caps,
// the day closed note, the leaderboard (1.57.0), the watch box, no chart and no subscribe (1.57.0); a dropped connection empties the
// watch. Past days (Anthony's task "League view opens a given past day"): ?tab=colosseum&day=YYYY-MM-DD opens that day read only,
// labelled, with Back to today; a day with no record says so; a bad day is refused and said; the chart page's old
// ?tab=league&day= address forwards there. Screenshots test/out/league-*.png and colosseum-*.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { startDesk } from './fake-desk.mjs';
import { createRequire } from 'node:module';
const LC = createRequire(import.meta.url)('../live/league.js');   // LeagueCore in Node (the session of a bar)

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
    window.__sent = []; window.__subs = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (m.type === 'subscribe') window.__subs.push(m); if (['order', 'change', 'cancel', 'flatten', 'plan', 'groupOrder'].includes(m.type)) window.__sent.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
    try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: { Lg: { panels: [
      { id: 'c1', type: 'chart', root: 'NQ', tf: 'm1', x: 0, y: 0, w: 8, h: 6 }, { id: 'c2', type: 'chart', root: 'ES', tf: 'm1', x: 8, y: 0, w: 4, h: 3 }] } } })); } catch (e) { /* blocked */ }
  });
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  let socks = 0; p.on('websocket', () => { socks++; });
  await p.goto(`http://localhost:${PORT}/live/?layout=Lg`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  const bars = await until(() => p.evaluate(() => { const c = window.workspace.chart('c1'); const b = c && c.bars(); return b && b.length > 60 ? b.map(x => ({ t: x.t, c: x.c })) : null; }), 'the NQ chart\'s bars', 20000);
  desk.league = sampleDay(bars);
  /* 1.57.0: the leaderboard's SAMPLE programs (made-up names, made-up days), in The Desk's colosseum.py shape */
  {
    const today = await p.evaluate(() => window.LeagueCore.sessionToday());
    const back = n => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
    const dd = (n, r, more) => Object.assign({ date: back(n), trades: 1, r, pnl: 10, mode: 'shadow', spent_usd: null, paper: true }, more || {});
    desk.colosseum = { v: 1, today, since: back(28), programs: [
      { id: 'sample-bot-alpha', source: 'agents', kind: 'bot', build: 'spec runner:sample', mode: 'shadow', last_day: today, diary: '',
        days: [0, 1, 2, 3, 4, 5].map(i => dd(i, 0.5)), today: [{ n: 1, setup: 'sample setup', side: 'buy', root: 'MNQ', qty: 1, entry_time: '09:45:00', exit_time: '10:02:00', exit_reason: 'target', r: 0.5, pnl: 10 }] },
      { id: 'sample-agent-beta', source: 'agents', kind: 'agent', build: 'sample', mode: 'copilot', last_day: today, diary: 'sample thoughts: waited for the open to settle',
        days: [dd(0, 1.5, { mode: 'copilot', paper: false, spent_usd: 0.4 }), dd(1, -1, { spent_usd: 0.2 })], today: [] }] };
  }
  /* the made-up bot connected, so it carries no alert of its own until the test raises one (review 2) */
  await fetch(`http://127.0.0.1:${PORT}/test/bot-connect?name=Demo%20Opening%20Fade`, { method: 'POST' });
  await until(() => p.$eval('#wsBotTab', b => !b.classList.contains('bt-alert')), 'the made-up bot connected: no alert', 10000);
  const post = (u, q) => fetch(`http://127.0.0.1:${PORT}${u}` + (q ? '?' + new URLSearchParams(q) : ''), { method: 'POST' }).then(r => r.json());
  const reads = () => desk.log.filter(x => x.which === 'chart-league').length;

  /* the chart page's top bar (plan step 3.2): Chart, the Legion link, the Bot button's slot; the moved tabs are gone */
  await until(() => p.isVisible('#wsLegion'), 'the Legion link (a v3 ChartBridge)', 10000);
  check(await p.evaluate(() => [...document.getElementById('wsTopTabs').children].map(b => b.id).join() === 'wsChartTab,wsLegion,wsPrGroup' && [...document.getElementById('wsPrGroup').children].map(b => b.id).join() === 'wsTabSlot'),
    'plan step 3.2: the top bar is Chart, the Legion link and the Bot\'s slot');
  check(await p.evaluate(() => ['wsLeagueTab', 'wsFleetTab', 'wsPraetorianTab', 'wsAgentTab', 'lgView', 'flView'].every(id => !document.getElementById(id))), 'plan step 3.2: no Colosseum, Legion, Praetorian or Agent tab and no league view on the chart page');
  check(await p.isVisible('#wsBotTab') && await p.$eval('#wsTabSlot', h => h.contains(document.getElementById('wsBotTab'))), '1.36.0: no Agents strip on the layout: the Bot button is in the top bar');
  await p.click('#wsAdd');
  const menu = await p.$$eval('#wsAddMenu [data-add]', bs => bs.map(b => b.textContent));
  check(!menu.includes('Bot') && menu.includes('Agents') && !menu.some(t => /^Agent( tab| desk)?$/.test(t)), '1.36.0: + Add panel offers no Bot panel and no Agent tab panel, and the Agents strip: ' + menu.join(', '));
  await p.click('#wsAdd');
  /* plan step 3.2: the league's faint marks went with the league poll: a chart's ⋯ menu has no league switch */
  await p.click('.ws-panel[data-id="c1"] .ws-more');
  check(!(await p.$('#wsMore [data-do="league"]')) && !(await p.$('.ws-panel[data-id="c1"] .lg-overlay')), 'plan step 3.2: the NQ chart\'s ⋯ has no League trades switch, and no marks on the chart');
  await p.click('.ws-panel[data-id="c1"] .ws-more');

  /* 1.36.0: the Bot through the top bar and the Agents strip (the Bot panel is gone); 1.38.0: the strip is the Drone sky, the bot a drone */
  await p.click('#wsBotTab');
  await until(() => p.evaluate(() => document.body.classList.contains('bt-on')), 'the Bot view from the top bar as before');
  check(new URL(p.url()).searchParams.get('tab') === 'bot', '?tab=bot as before');
  check(await p.getAttribute('#wsChartTab', 'aria-pressed') === 'false', 'Chart not pressed under the Bot view');
  await p.click('#wsChartTab');
  await until(() => p.evaluate(() => !document.body.classList.contains('bt-on')), 'Chart closes the Bot view');
  check(await p.getAttribute('#wsChartTab', 'aria-pressed') === 'true' && await p.$eval('#wsGrid', g => getComputedStyle(g).display !== 'none') && !new URL(p.url()).searchParams.has('tab'), 'Chart closes the Bot view: the grid back, Chart pressed, no tab in the address');
  await p.click('#wsChartTab');
  check(await p.getAttribute('#wsChartTab', 'aria-pressed') === 'true', 'Chart with no tab open changes nothing');
  await p.click('#wsBotTab');
  await until(() => p.evaluate(() => document.body.classList.contains('bt-on')), 'the Bot view again');
  await p.click('#wsBotTab');
  await until(() => p.evaluate(() => !document.body.classList.contains('bt-on')), 'closed again from its button');
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll on the chart page at ' + (await p.evaluate(() => innerWidth)));
  const socks0 = socks;
  await p.click('#wsAdd'); await p.click('#wsAddMenu [data-add="agents"]');
  /* the bot's drone: in the sky, or (a narrow panel) in the "+N more" list */
  const botSel = await until(async () => (await p.$('.ws-panel.agents .ak-hit[data-key="bot"]')) ? '.ws-panel.agents .ak-hit[data-key="bot"]'
    : (await p.$('.ws-panel.agents .ak-mi[data-key="bot"]')) ? '.ws-panel.agents .ak-mi[data-key="bot"]' : null, 'the Agents panel with the bot\'s drone', 15000);
  const openBotDrone = async () => { if (/ak-mi/.test(botSel) && await p.$eval('.ws-panel.agents .ak-more', e => e.hidden)) await p.click('.ws-panel.agents .ak-idle'); await p.click(botSel); };
  const hoverBotDrone = async () => { if (/ak-mi/.test(botSel) && await p.$eval('.ws-panel.agents .ak-more', e => e.hidden)) await p.click('.ws-panel.agents .ak-idle'); await p.hover(botSel); };
  check(await p.isVisible('#wsBotTab') && await p.$eval('#wsTabSlot', h => h.contains(document.getElementById('wsBotTab'))), 'with an Agents strip the Bot button stays in the top bar (Anthony: "its fine there")');
  const skyNq = await until(async () => { const s = await p.evaluate(() => window.workspace.agentsStrip()); return s && s.bars > 5 && s.barsRoot === 'NQ' ? s : null; }, 'the Drone sky over NQ bars', 15000);
  check(!!skyNq && skyNq.root === 'NQ' && socks === socks0, '1.38.1: the Drone sky reads NQ bars (' + (skyNq ? skyNq.bars : 0) + ' pillars) from the NQ line already open: no new socket (' + socks0 + ' before, ' + socks + ' after)');
  check(!!skyNq && !skyNq.drones.some(d => /^seat:/.test(d.key)), 'plan step 3.2: no seat drones on the chart page (the seats are on Legion\'s Colosseum): ' + (skyNq ? skyNq.drones.map(d => d.key).join(', ') : ''));
  await openBotDrone();
  await until(() => p.evaluate(() => document.body.classList.contains('bt-on')), 'a click on the bot\'s drone opens the Bot view');
  check(await p.$eval('#wsTabSlot', e => e.contains(document.getElementById('wsBotTab'))) && await p.isVisible('#wsBotTab'), 'while the Bot view is open its button is in the top bar (the way back)');
  check(await p.evaluate(() => document.body.classList.contains('bt-has-tab')), 'review 5: the Layout word gives way (bt-has-tab) while the Bot button is in the top bar');
  await p.screenshot({ path: path.join(out, 'league-panels-1366.png') });
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
  await p.click('.ws-panel.agents [data-act="close"]');
  await until(() => p.$eval('#wsTabSlot', h => h.contains(document.getElementById('wsBotTab'))), 'the strip closed: the Bot button still in the top bar');
  check(await p.isVisible('#wsBotTab'), 'with no strip on the layout the Bot is one click away in the top bar');
  check(reads() === 0, 'plan step 3.2: the chart page read no league the whole time (' + reads() + ' reads of /api/chart-league)');
  check((await p.evaluate(() => window.__sent.length)) === 0, 'nothing on the chart page sent an order message');

  /* Legion's Colosseum (plan step 3.2): its own page, opened on Castra, then the Colosseum: 1.38.1 / 1.57.0, no subscribe */
  const q = await ctx.newPage();
  q.on('pageerror', e => fail('legion pageerror: ' + e.message));
  await q.goto(`http://localhost:${PORT}/live/legion.html`);
  await q.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(q, TEST_PIN);
  await q.waitForFunction(() => document.getElementById('lxConn').dataset.state === 'on', null, { timeout: 40000 });
  await wait(1500);
  const subs0 = await q.evaluate(() => window.__subs.length);
  await q.click('[data-lx-tab="colosseum"]');
  await until(() => q.evaluate(() => window.legion.league() && window.legion.league().shown && window.legion.league().trades === 2), 'the Colosseum with the sample day', 15000);
  check(await q.getAttribute('[data-lx-tab="colosseum"]', 'aria-selected') === 'true' && await q.$eval('#lgView', e => getComputedStyle(e).display !== 'none'), 'Legion: the Colosseum tab is selected and its view shows');
  /* 1.57.0 (part F): the leaderboard, bots and agents mingled, ranked; nothing on it sends */
  await until(() => q.evaluate(() => window.legion.league().board.programs === 2), 'the leaderboard read', 15000);
  const lb = await q.evaluate(() => [...document.querySelectorAll('#lgView .lg-brow')].map(r => [r.dataset.key, r.dataset.kind, r.querySelector('.lg-who').textContent]));
  check(lb.map(x => x[0]).join() === 'desk:sample-agent-beta,desk:sample-bot-alpha,league:H,league:O,league:S' && lb.filter(x => x[0].startsWith('league:')).every(x => x[1] === 'agent'),
    'Today: by today\'s R (+1.50, +0.50); the league\'s sample day is an older session, so its seats have no today and come after, as agents: ' + JSON.stringify(lb));
  check(lb[0][2] === 'AGENT' && lb[1][2] === 'BOT' && lb[2][2] === 'AGENT', 'told apart by the BOT and AGENT tags');
  check(/its last session 2026-10-22/.test(await q.$eval('#lgView .lg-brow[data-key="league:H"]', r => r.innerText)), 'a seat says its last session, not today');
  const rowText = await q.$eval('#lgView .lg-brow[data-key="desk:sample-agent-beta"]', r => r.innerText.replace(/\s+/g, ' '));
  check(/Copilot, reported today/.test(rowText) && /\+1\.50 R/.test(rowText) && /too early/.test(rowText) && /\$0\.40 today, \$0\.60 month/.test(rowText) && /not reported/.test(rowText), 'an agent\'s row: status, today, too early, API cost, decision time: ' + rowText);
  check(/no backtest pace yet/.test(await q.$eval('#lgView .lg-brow[data-key="desk:sample-bot-alpha"]', r => r.innerText)), 'a bot with 6 days: no backtest pace yet');
  await q.click('#lgView [data-do="bview"][data-view="multi"]');
  const multi = await q.evaluate(() => [...document.querySelectorAll('#lgView .lg-brow')].map(r => r.dataset.key));
  check(multi[0] === 'desk:sample-bot-alpha' && multi[1] === 'desk:sample-agent-beta', 'Multi-day: by the last 20 days (+3.00 over +0.50), the seats after: ' + multi.join());
  await q.click('#lgView .lg-bname[data-key="desk:sample-agent-beta"]');
  const detail = await q.$eval('#lgView .lg-bdetail[data-key="desk:sample-agent-beta"]', r => r.innerText.replace(/\s+/g, ' '));
  check(/No trade today/.test(detail) && /Thoughts \(1\)/.test(detail), 'a click opens the row: its trades and its thoughts, folded: ' + detail);
  await q.click('#lgView .lg-bdetail[data-key="desk:sample-agent-beta"] summary');
  check(/sample thoughts: waited for the open to settle/.test(await q.$eval('#lgView .lg-bdetail[data-key="desk:sample-agent-beta"]', r => r.innerText)), 'the thoughts open under the row');
  await q.click('#lgView [data-do="bview"][data-view="today"]');
  await q.screenshot({ path: path.join(root, 'test', 'out', 'colosseum-board-157.png') });
  /* 1.57.0 (Anthony 2026-11-13, the league's chart: "I dont think its necessary"): no chart on the Colosseum, so opening it
     subscribes to nothing */
  await wait(1500);
  const newSubs = await q.evaluate(n => window.__subs.slice(n), subs0);
  check(!(await q.$('#lgView canvas')) && !(await q.$('#lgView .lg-chart')) && newSubs.length === 0 && (await q.evaluate(() => window.legion.league().chart)) === false,
    '1.57.0: no chart on the Colosseum, and opening it sends no subscribe (' + JSON.stringify(newSubs) + ')');
  check(new URL(q.url()).searchParams.get('tab') === 'colosseum', '?tab=colosseum in Legion\'s address');
  /* 1.50.0 the Colosseum: its name, the watch box (ChartBridge's traders in Shadow, read only, "not built yet" for the loop's own
     list); a mode change of the made-up agent moves it in and out of the box (another page's change) */
  check((await q.textContent('#lgView .lg-word')) === 'Colosseum' && await q.$eval('#lgView .lg-word', e => /Cinzel/.test(getComputedStyle(e).fontFamily)), '1.50.0: the tab\'s name, Colosseum, in the title font');
  check(await q.evaluate(() => window.legion.league().watch.linked === true), '1.50.0: the watch box has its listen-only link');
  await post('/test/agent-mode', { agent: 'demo', mode: 'shadow' });
  await until(() => q.evaluate(() => window.legion.league().watch.rows.join() === 'demo'), 'the made-up agent in Shadow is in the watch box', 8000);
  const wtext = await q.$eval('#lgView .lg-watch', e => e.innerText);
  check(/Demo Agent/.test(wtext) && /not built yet/.test(wtext), '1.50.0: the watch box lists the made-up agent in Shadow and says the loop\'s own list is not built yet');
  await q.screenshot({ path: path.join(out, 'colosseum-1366.png') });
  await post('/test/agent-mode', { agent: 'demo', mode: 'auto' });
  await until(() => q.evaluate(() => window.legion.league().watch.rows.length === 0), 'a trader in Auto leaves the watch box', 8000);
  check(/No trader on the agent channel is in Shadow now/.test(await q.$eval('#lgView .lg-watch', e => e.innerText)), '1.50.0: a trader in Auto is not on the watch; the box says none is in Shadow');
  await post('/test/agent-mode', { agent: 'demo', mode: 'shadow' });
  await until(() => q.evaluate(() => window.legion.league().watch.rows.join() === 'demo'), 'back in Shadow: back on the watch', 8000);
  const text = await q.$eval('#lgView', e => e.innerText);
  check(/SHADOW: no orders/.test(text), 'SHADOW: no orders');
  check(/H\s*Haiku/.test(text) && /S\s*Sonnet/.test(text) && /O\s*Opus/.test(text), 'the legend strip: H Haiku, S Sonnet, O Opus');
  const legend = await q.$$eval('.lg-legend .lg-key', ks => ks.map(k => getComputedStyle(k.querySelector('i')).color));
  check(legend.join('|') === 'rgb(255, 194, 102)|rgb(93, 224, 240)|rgb(176, 122, 60)', 'H amber, S cyan, O bronze (plan step 3.2: no purple): ' + legend.join(', '));
  check(/day closed, recording to 17:00/.test(text), 'the day closed note (status from the 16:01 close)');
  check(/LONG 3 MNQ/.test(text) && /Flag for you: cleared fence 2\.99 on day 60/.test(text), 'the seats\' day: S\'s open paper trade, O\'s flag');
  check(/not enough data yet \(n 4 of 20\)/.test(text) && /\+0\.12 R \(n 24\)/.test(text), 'the week and month table: net R with n, not enough data yet under 20');
  check(/\$3\.00 of \$9\.50 today/.test(text) && /\$12\.25 of \$200\.00 this month/.test(text), 'the API spend against the caps');
  const log = await q.$$eval('.lg-log .lg-row', rs => rs.map(r => r.className + ' ' + r.textContent));
  check(log.length === 3 && /k-refused/.test(log[0]) && /k-pass/.test(log[1]) && /k-enter/.test(log[2]) && /short 5 MNQ, stop 15 pt, target 30 pt at VWAP/.test(log[2]) && /\(with you\)/.test(log[2]), 'the decision log, newest first: ' + log.length + ' rows');
  check((await q.evaluate(() => window.legion.league().marks)) === 5, 'five marks for the day: three fills and two exits');
  await q.screenshot({ path: path.join(out, 'league-1366.png') });
  check(await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 1366');
  for (const [w, h] of [[1600, 900], [1920, 1080]]) {
    await q.setViewportSize({ width: w, height: h }); await wait(600);
    check(await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at ' + w);
    await q.screenshot({ path: path.join(out, `league-${w}.png`) });
  }
  await q.setViewportSize({ width: 1366, height: 768 }); await wait(300);
  check((await q.evaluate(() => window.__sent.length)) === 0, 'nothing on the Colosseum sent an order message');
  /* a deliberate break of 98 that no test caught at first (2026-11-12): a dropped connection forgets the traders at once */
  await post('/test/drop');
  const dropped = await until(() => q.evaluate(() => { const w = window.legion.league().watch; return !w.connected ? w : null; }), 'the drop seen by the watch', 8000);
  check(!!dropped && dropped.traders === 0 && dropped.rows.length === 0, 'a dropped connection empties the watch at once (nothing shown on an old word): ' + JSON.stringify(dropped));
  await until(() => q.evaluate(() => window.legion.league().watch.connected && window.legion.league().watch.rows.join() === 'demo'), 'reconnected: the watch back', 20000);
  await q.close();

  /* the chart page's old address ?tab=league forwards to Legion's Colosseum, and a reload keeps it */
  await p.goto(`http://localhost:${PORT}/live/?layout=Lg&tab=league`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await until(() => p.evaluate(() => /legion\.html$/.test(location.pathname) && window.legion && window.legion.league() && window.legion.league().shown), '?tab=league forwards to Legion\'s Colosseum', 20000);
  check(new URL(p.url()).searchParams.get('tab') === 'colosseum', 'the old ?tab=league address lands on Legion with ?tab=colosseum: ' + p.url());
  await p.reload();
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await until(() => p.evaluate(() => window.legion && window.legion.league() && window.legion.league().shown), 'a reload keeps the Colosseum', 20000);
  check(true, 'a reload keeps the Colosseum');
  /* a past day (?tab=league&day=YYYY-MM-DD, The Desk's Agent Stats links here): read only, labelled, the way back to today, a day
     with no record said plainly, a bad day refused. The SAMPLE past day's trades sit on the sample bars of the newest earlier date */
  const sessionNow = await p.evaluate(() => window.LeagueCore.sessionToday());   // review LOW 1: the league's session date
  const dayOf = t => LC.sessionOfBar(t);   // review LOW 3: a bar's session (18:00 opens the next date's)
  const olderBars = bars.filter(b => dayOf(b.t) < sessionNow);
  const pastDate = olderBars.length > 20 ? dayOf(olderBars[olderBars.length - 1].t) : '2026-10-22';
  const onPast = bars.filter(b => dayOf(b.t) === pastDate);
  const pt = k => onPast.length > k ? onPast[onPast.length - k] : null;
  desk.leagueDays = { [pastDate]: { shadow: 'SHADOW: no orders', folder: { set: true, ok: true, problem: null }, date: pastDate,
    status: desk.league.status, day: { date: pastDate, closed: true, note: null }, league: desk.league.league,
    trades: pt(20) ? [{ id: 'p-O-1', seat: 'O', side: 'short', contracts: 2, fill_t: pt(20).t * 1000, fill_px: pt(20).c, stop_px: pt(20).c + 12, target_px: pt(20).c - 24, exit_t: pt(8).t * 1000, exit_px: pt(8).c, exit_reason: 'target', r: 2, relation: 'own' }] : [],
    open: [], decisions: [{ id: 'pd1', seat: 'O', time: '10:20:00', trigger: 'grid', latency_s: 5.5, call_ok: true, refused: null, answer: { action: 'enter', side: 'short', stop_points: 12, target_points: 24, reasoning: 'made up for the past-day smoke' }, contracts: 2 }] } };
  const asked = () => desk.log.filter(x => x.which === 'chart-league' && x.date).map(x => x.date);
  await p.goto(`http://localhost:${PORT}/live/?layout=Lg&tab=league&day=${pastDate}`);   // the chart page's old link: forwarded to Legion
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await until(() => p.evaluate(d => window.legion && window.legion.league() && window.legion.league().shown && window.legion.league().past === d && window.legion.league().decisions === 1, pastDate), 'the League view on the past day ' + pastDate, 20000);
  check(asked().includes(pastDate), 'a past day reads GET /api/chart-league?date=' + pastDate);
  const ptext = await p.$eval('#lgView', e => e.innerText);
  check(await p.isVisible('#lgView [data-k="past"]') && (await p.textContent('#lgView [data-k="past"]')) === 'Past day ' + pastDate + ' · read only', 'labelled: Past day ' + pastDate + ' · read only');
  check(await p.isVisible('#lgView [data-k="today"]'), 'the Back to today button');
  check(/past day: the live status is not kept per day/.test(ptext) && !/LONG 3 MNQ/.test(ptext) && !/Flag for you/.test(ptext), 'a past day shows no live status (no position, no flag of today)');
  check(/the live spend is not kept per day here/.test(ptext) && !/\$3\.00 of \$9\.50 today/.test(ptext), 'a past day shows no spend of today');
  check(/made up for the past-day smoke/.test(ptext) && !/made up: no edge at the level/.test(ptext), 'the decision log is the past day\'s only');
  check(/legion\.html$/.test(new URL(p.url()).pathname) && new URL(p.url()).searchParams.get('day') === pastDate && new URL(p.url()).searchParams.get('tab') === 'colosseum', 'the chart page\'s old ?tab=league&day= link lands on Legion\'s Colosseum and the address keeps the day: ' + p.url());
  if (pt(20)) {
    check((await p.evaluate(() => window.legion.league().marks)) === 2, 'the past day\'s marks: one fill, one exit');
  } else console.log('  note: the sample bars hold no earlier date; the past-day marks were not checked');
  await p.screenshot({ path: path.join(out, 'league-past-1366.png') });
  await p.click('#lgView [data-k="today"]');
  await until(() => p.evaluate(() => window.legion.league().past === null && window.legion.league().date === '2026-10-22' && window.legion.league().trades > 0), 'Back to today: the live day');
  check(!(await p.isVisible('#lgView [data-k="past"]')) && !(await p.isVisible('#lgView [data-k="today"]')) && !new URL(p.url()).searchParams.has('day') && new URL(p.url()).searchParams.get('tab') === 'colosseum', 'Back to today: the label goes, the address drops the day, the view stays');
  /* a day with no record: said plainly, never a guess */
  const emptyDate = pastDate > '2026-10-19' ? '2026-10-19' : '2026-01-05';
  await p.goto(`http://localhost:${PORT}/live/legion.html?tab=colosseum&day=${emptyDate}`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  const emptyText = await until(() => p.$eval('#lgView [data-k="problem"]', e => (!e.hidden && /No league record/.test(e.textContent) ? e.textContent : null)), 'the empty past day said', 20000);
  check(emptyText === 'No league record for ' + emptyDate + ': no paper trade and no decision. Not enough data to show that day.', 'a day with no record: ' + emptyText);
  check((await p.evaluate(() => window.legion.league().marks)) === 0, 'no marks for it');
  await p.screenshot({ path: path.join(out, 'league-past-empty-1366.png') });
  /* leaving the Colosseum drops the day: the next open is the live day */
  await p.click('[data-lx-tab="castra"]');
  await until(() => p.evaluate(() => !window.legion.league().shown), 'closed');
  check(!new URL(p.url()).searchParams.has('day') && new URL(p.url()).searchParams.get('tab') === 'castra', 'another tab: the address keeps no day');
  await p.click('[data-lx-tab="colosseum"]');
  await until(() => p.evaluate(() => window.legion.league().past === null && window.legion.league().date === '2026-10-22' && window.legion.league().trades > 0), 'opened again: the live day');
  /* a bad day: refused, said, the live view */
  for (const [bad, said] of [['2026-02-30', /2026-02-30, which is not a calendar date\. Showing today\./], ['2099-01-02', /2099-01-02, which is after the current session/], ['yesterday', /not a date \(YYYY-MM-DD\)/]]) {
    const before = asked().length;
    await p.goto(`http://localhost:${PORT}/live/legion.html?tab=colosseum&day=${bad}`);
    await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
    const t = await until(() => p.$eval('#lgView [data-k="problem"]', e => (!e.hidden && e.textContent ? e.textContent : null)), 'the bad day ' + bad + ' said', 20000);
    await until(() => p.evaluate(() => window.legion.league().date === '2026-10-22' && window.legion.league().trades > 0), 'the live day under it', 15000);
    check(said.test(t || '') && (await p.evaluate(() => window.legion.league().past)) === null && asked().length === before && !(await p.isVisible('#lgView [data-k="past"]')), 'a bad day (' + bad + ') is refused and said, the live view shows, The Desk is never asked for it: ' + t);
  }
  await p.screenshot({ path: path.join(out, 'league-past-bad-1366.png') });
  /* review LOW 1: the current session's own date (after 17:00 New York the next date, a weekend Monday) is the live view, never refused */
  await p.goto(`http://localhost:${PORT}/live/legion.html?tab=colosseum&day=${sessionNow}`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await until(() => p.evaluate(() => window.legion && window.legion.league() && window.legion.league().shown && window.legion.league().date === '2026-10-22' && window.legion.league().trades > 0), 'the current session\'s date: the live view', 20000);
  check((await p.evaluate(() => window.legion.league().past)) === null && (await p.evaluate(() => window.legion.league().dayProblem)) === '', 'the current session\'s date (' + sessionNow + ') opens the live view, not refused');

  /* The Desk on HOMESERVER reading the copy WORK's League Mirror posts (set false, ok true, source mirror): the day, no warning */
  const live = desk.league;
  desk.league = Object.assign({}, live, { folder: { set: false, ok: true, problem: null, source: 'mirror' } });
  await p.click('[data-lx-tab="castra"]'); await p.click('[data-lx-tab="colosseum"]');
  await until(() => p.evaluate(() => window.legion.league().shown && window.legion.league().trades > 0), 'the mirror: the day shows', 20000);
  await new Promise(r => setTimeout(r, 1500));
  const mirrorWarn = await p.$eval('#lgView [data-k="problem"]', e => (e.hidden ? '' : e.textContent));
  check(mirrorWarn === '' && (await p.evaluate(() => window.legion.league().problem)) === '', 'the mirror (set false, ok true): no warning: "' + mirrorWarn + '"');
  await p.screenshot({ path: path.join(out, 'league-mirror-1366.png') });

  /* The Desk with nothing to read: its own words said plainly */
  const deskSays = 'The league\'s folder is not set, and no league files have arrived from WORK yet.';
  desk.league = { shadow: 'SHADOW: no orders', folder: { set: false, ok: false, problem: deskSays, source: null }, trades: [], open: [], decisions: [] };
  await p.click('[data-lx-tab="castra"]'); await p.click('[data-lx-tab="colosseum"]');
  const nofolder = await until(() => p.$eval('#lgView [data-k="problem"]', (e, want) => (!e.hidden && e.textContent === want ? e.textContent : null), deskSays), 'nothing to read said', 20000);
  check(!!nofolder, 'nothing to read on The Desk: its own words said plainly: ' + nofolder);
  await p.screenshot({ path: path.join(out, 'league-nofolder-1366.png') });

  /* an older Desk (set false, no ok, no problem): the page's sentence, never "set a folder on WORK" */
  desk.league = { shadow: 'SHADOW: no orders', folder: { set: false }, trades: [], open: [], decisions: [] };
  await p.click('[data-lx-tab="castra"]'); await p.click('[data-lx-tab="colosseum"]');
  const oldDesk = await until(() => p.$eval('#lgView [data-k="problem"]', e => (!e.hidden && e.textContent === 'No league files have reached The Desk yet.' ? e.textContent : null)), 'an older Desk said', 20000);
  check(!!oldDesk, 'an older Desk with no league files: said plainly, no folder to set: ' + oldDesk);
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
