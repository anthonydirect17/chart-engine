// Chart 1.36.0 smoke (Anthony 2026-10-22): the Agents strip. Against the fake bridge (--v3, the made-up Demo Agent, sample data)
// and the fake Desk (test/fake-desk.mjs) serving a SAMPLE league day (made up here, every reasoning starting "Sample:": three seats,
// H flat, S with an open paper trade, O at the look cap after a made-up stopped-out trade; no real league, no model name, no account).
//   npm run smoke:agents-strip        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// An Accounts-like layout at 1906 x 1014 (Anthony's third screen): the Account page across the top, the order ticket bottom right,
// the strip added from + Add panel in the lower left (about 1,430 by 450 px). Checks: one card per agent left to right (H, S, O,
// then the Demo Agent in Shadow), the mode big, the look cap derived, the open paper trade with its P&L, R, stop and target, the
// spend against the pool and the cap, the thoughts newest first, a thought's full reasoning, a card opening the League tab or the
// Agent tab, one Agents strip a layout, no motion, the row scrolling sideways when narrow (not the page), one league read for the
// whole page, and no order or control message sent.
// Screenshots test/out/agents-strip-1906.png, agents-strip-detail-1906.png, agents-strip-narrow.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { startDesk } from './fake-desk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.STRIP_SMOKE_PORT || 8825), DP = PORT + 40;
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };

/* New York wall time now, in ms stored as if UTC (the league's convention) */
function etNow() {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
}
const hms = ms => new Date(ms).toISOString().slice(11, 19);

/* the SAMPLE league day around now; px: MNQ's price on the page */
function sampleDay(px) {
  const now = etNow(), at = m => now - m * 60000, date = new Date(now).toISOString().slice(0, 10);
  const pass = (seat, m, why, conf) => ({ id: seat + '-' + m, seat, t: at(m), time: hms(at(m)), trigger: 'the 5 minute look', latency_s: 3.1, cost: 0.004, call_ok: true, refused: null, answer: { action: 'pass', confidence: conf || 0.4, reasoning: why } });
  const decisions = [];
  for (const m of [44, 33, 21, 9, 2]) decisions.push(pass('H', m, 'Sample: price inside the made-up value area, no level within reach'));
  decisions.push({ id: 'S-15', seat: 'S', t: at(15), time: hms(at(15)), trigger: 'touch VWAP', latency_s: 4.0, cost: 0.006, call_ok: true, refused: null, contracts: 3,
    answer: { action: 'enter', side: 'long', stop_points: 25, target_points: 50, reference: 'VWAP', confidence: 0.62, reasoning: 'Sample: held the made-up VWAP twice with buyers lifting\nThe second line of the made-up reasoning: the target is the prior high.' } });
  for (const m of [12, 6, 1]) decisions.push(pass('S', m, 'Sample: in the trade, nothing to add', 0.5));
  /* O: 31 looks in the last 50 minutes (the cap is 30 in any 60): a made-up resting short that stopped out, then passes */
  decisions.push({ id: 'O-50', seat: 'O', t: at(50), time: hms(at(50)), trigger: 'touch IBL', latency_s: 9.5, cost: 0.03, call_ok: true, refused: null, contracts: 12,
    answer: { action: 'rest', side: 'short', stop_points: 6, target_points: 15, reference: 'IBL', confidence: 0.55, reasoning: 'Sample: a retest of the made-up IBL from below; rest a short there' } });
  for (let i = 0; i < 30; i++) decisions.push(pass('O', 48 - i * 1.5, i === 29 ? 'Sample: price sliced 25 pts through the made-up EMA50, no clean level' : 'Sample: no edge at the made-up level', 0.35));
  /* and three looks at Anthony's made-up new entry: never counted by the cap (league Amendment 7), so still 31 counted */
  for (const m of [40, 30, 20]) decisions.push(Object.assign(pass('O', m, 'Sample: a look at the made-up mentor entry', 0.3), { trigger: 'a new mentor entry: long MNQ at ' + hms(at(m + 1)).slice(0, 5) }));
  decisions.sort((a, b) => a.t - b.t);
  const fill = px - 4;
  return {
    shadow: 'SHADOW: no orders', folder: { set: true, ok: true, problem: null }, date,
    day: { date, closed: false, note: null },
    status: { date, now: hms(now), feed: 'live', seats: {
      H: { status: 'active', flag: 'Sample data, made up for the smoke', decisions: 58, entries: 0, flex: { phase: 'eval', balance: 50000, today_pnl: 0, room_to_floor: 2000 }, position: null, resting: null },
      S: { status: 'active', flag: 'Sample data, made up for the smoke', decisions: 57, entries: 1, flex: { phase: 'eval', balance: 50000, today_pnl: 24, room_to_floor: 2000 },
        /* its stop moved to break-even (the fill): R still on the trade's $150 risk at the fill */
        position: { id: 's-S-1', side: 'long', state: 'open', contracts: 3, fill_px: fill, stop_px: fill, target_px: fill + 50, fill_time: hms(at(15)) }, resting: null },
      O: { status: 'active', flag: 'Sample data, made up for the smoke', decisions: 58, entries: 1, flex: { phase: 'eval', balance: 49838, today_pnl: -162, room_to_floor: 1838 }, position: null,
        resting: { id: 'r-O-2', side: 'short', type: 'limit', price: px + 20, stop_points: 6, target_points: 15, good_until: hms(at(-20)), triggered: false } } },
      spend: { day_spent: 1.61, day_cap: 9.5, month_spent: 12.25, month_cap: 200, coach_reserve: 1, seats: { H: 0.42, S: 0.48, O: 0.71 }, calls_today: 173, stopped: null } },
    league: { enough_n: 20, seats: {} },
    trades: [{ id: 's-O-1', seat: 'O', side: 'short', contracts: 12, fill_t: at(49), fill_px: px + 20, stop_px: px + 26, target_px: px + 5, exit_t: at(48), exit_px: px + 26.75, exit_reason: 'stop', r: -1.13, relation: 'own' }],
    open: [{ id: 's-S-1', seat: 'S', side: 'long', contracts: 3, fill_t: at(15), fill_px: fill, stop_px: fill, target_px: fill + 50, stop_points: 25, risk_dollars: 150 }],
    decisions,
  };
}

const desk = await startDesk(DP, {});
desk.league = { shadow: 'SHADOW: no orders', folder: { set: true, ok: true, problem: 'The league has no session yet.' }, trades: [], open: [], decisions: [] };
let px = null;
const refresh = setInterval(() => { if (px !== null) desk.league = sampleDay(px); }, 3000);   // its clock follows now (no "status late")
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--agents=demo', '--agent-any-time', '--bot-account=Sim101', '--test-pin=' + TEST_PIN, '--desk-url=http://127.0.0.1:' + DP], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const post = u => fetch(`http://127.0.0.1:${PORT}${u}`, { method: 'POST' }).then(r => r.json());
try {
  const ctx = await browser.newContext({ viewport: { width: 1906, height: 1014 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    /* every order message and every agent or bot control message the page could send */
    WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'plan', 'groupOrder'].includes(m.type) || /^(agent|bot)[A-Z]/.test(m.type || '')) window.__sent.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
    try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: { Accounts: { panels: [
      { id: 'ap', type: 'accounts', x: 0, y: 0, w: 12, h: 3 }, { id: 'tk', type: 'ticket', x: 9, y: 3, w: 3, h: 3 },
      { id: 'oldbot', type: 'bot', x: 0, y: 3, w: 2, h: 1 }] } } })); } catch (e) { /* blocked */ }   // 1.35.0's Bot panel, saved: 1.36.0 opens the layout without it
  });
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.goto(`http://localhost:${PORT}/live/?layout=Accounts`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  check(!(await p.$('.ws-panel.bot')) && (await p.evaluate(() => window.workspace.panels().map(x => x.type).join(','))) === 'accounts,ticket', '1.36.0: a saved layout with a Bot panel opens without it, no error');
  check(!!(await until(async () => (await p.isVisible('#wsBotTab')) && p.$eval('#wsTabSlot', e => e.contains(document.getElementById('wsBotTab'))), 'the Bot button', 15000)), 'no strip yet: the Bot button is in the top bar');
  /* the made-up bot connected (no alert of its own) */
  await post('/test/bot-connect?name=Demo%20Opening%20Fade');
  /* the made-up agent, connected, in Shadow, with two made-up thoughts */
  await post('/test/agent-connect?agent=demo&name=Demo%20Agent');
  await post('/test/agent-mode?agent=demo&mode=shadow');
  await post('/test/agent-note?agent=demo&kind=look&text=' + encodeURIComponent('Sample: a made-up look at the opening range'));
  await post('/test/agent-note?agent=demo&kind=thinking&text=' + encodeURIComponent('Sample: waiting for a retest of the made-up level before any plan'));

  /* + Add panel: Agents, into the free lower left */
  await p.click('#wsAdd');
  const menu = await p.$$eval('#wsAddMenu [data-add]', bs => bs.map(b => b.textContent));
  check(menu.includes('Agents') && !menu.includes('Bot'), '+ Add panel offers Agents and no Bot panel (merged into the strip): ' + menu.join(', '));
  await p.click('#wsAddMenu [data-add="agents"]');
  await until(() => p.$('.ws-panel.agents .as-row'), 'the Agents strip placed');
  const box = await p.$eval('.ws-panel.agents', e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
  check(box.w >= 1380 && box.w <= 1480 && box.h >= 400 && box.h <= 520 && box.x < 20, 'the strip fills the lower left: ' + JSON.stringify(box));
  check(await p.evaluate(() => window.workspace.panels().find(x => x.type === 'agents') && JSON.parse(localStorage.getItem('live-workspace-v1')).layouts.Accounts.panels.some(x => x.type === 'agents')), 'kept in the layout');
  await p.click('#wsAdd');
  check(await p.$eval('#wsAddMenu [data-add="agents"]', b => b.disabled), 'one Agents strip a layout: the menu item is off once placed');
  await p.click('#wsAdd');

  px = await until(() => p.evaluate(() => window.workspace.quoteLast('MNQ')), 'MNQ\'s price on the page', 20000);
  desk.league = sampleDay(px);
  const st = await until(async () => { const s = await p.evaluate(() => window.workspace.agentsStrip()); return s && s.cards.length === 5 && s.cards[1].head === 'LONG 3 MNQ' ? s : null; }, 'five cards: the three seats, the Demo Agent and the bot', 40000);
  if (st) {
    check(st.cards.map(c => c.key).join(',') === 'seat:H,seat:S,seat:O,agent:demo,bot', 'left to right: H, S, O, the live agent, then the bot (' + st.cards.map(c => c.key).join(', ') + ')');
    check(st.cards.slice(0, 3).every(c => c.mode === 'SHADOW') && st.cards[3].mode === 'SHADOW', 'the mode: SHADOW on every seat and on the Demo Agent in Shadow');
    check(st.cards.every(c => ['SHADOW', 'LIVE'].includes(c.mode)) && st.cards.every(c => !/copilot|auto/i.test(c.mode + ' ' + c.sub)), 'the big word is SHADOW or LIVE only, never Copilot or Auto (' + st.cards.map(c => c.mode + ' / ' + c.sub).join('; ') + ')');
    check(st.cards[4].alert === false, 'the bot: connected, no alert');
    check(st.cards[0].flat && st.cards[0].state === '', 'H: flat, no state word');
    check(st.cards[1].head === 'LONG 3 MNQ', 'S: LONG 3 MNQ (its open paper trade)');
    check(st.cards[2].state === 'look cap', 'O: look cap (derived from its 31 looks in the last hour)');
  }
  const cardText = async k => p.$eval('.ws-panel.agents [data-card="' + k + '"]', e => e.innerText);
  const s = await cardText('seat:S');
  /* the sample feed moves: the figures are checked against MNQ's price as the card was read */
  const sv = await p.evaluate(() => ({ last: window.workspace.quoteLast('MNQ'), text: document.querySelector('.ws-panel.agents [data-card="seat:S"]').innerText, title: (document.querySelector('.ws-panel.agents [data-card="seat:S"] .as-pnl[title]') || {}).title || '' }));
  const shown = +(/last ([\d,.]+) against/.exec(sv.title) || [0, 'NaN'])[1].replace(/,/g, '');   // the price the card used (the feed moves on)
  const fillPx = px - 4, mv = shown - fillPx, usd = mv * 3 * 2;
  check(Math.abs(shown - sv.last) <= 30, 'S: the card used the page\'s MNQ price (' + shown + ', now ' + sv.last + ')');
  const want = 'open ' + (usd > 0 ? '+' : usd < 0 ? '-' : '') + '$' + Math.abs(usd).toFixed(2) + ' · ' + (mv > 0 ? '+' : mv < 0 ? '-' : '') + Math.abs(mv / 25).toFixed(2) + ' R';
  check(sv.text.includes(want) && /Worked out on this page/.test(sv.title) && /over the trade's risk at the fill, gross/.test(sv.title), 'S: open P&L from the page\'s MNQ price, R on the trade\'s risk at the fill though its stop is at break-even (gross, said so on hover): ' + want);
  const pt = v => String(Math.round(v * 100) / 100);
  check(sv.text.includes('stop ' + pt(Math.abs(shown - fillPx)) + ' pt · target ' + pt(Math.abs(fillPx + 50 - shown)) + ' pt'), 'S: the stop and target distance in points from the price now');
  check(/since \d\d:\d\d/.test(s) && !/resting/.test(s), 'S: since hh:mm; no resting order (The Desk passes resting: null)');
  check(/\$0\.48 seat · seats \$1\.61 of \$8\.50/.test(s) && /day \$1\.61 of \$9\.50 · 57 calls/.test(s), 'S: the spend against the seats\' pool and the day cap, calls today');
  const o = await cardText('seat:O');
  check(/look cap/.test(o) && /31 counted looks in the last hour, next look \d\d:\d\d/.test(o), 'O: the look cap with the next look (its 3 looks at the mentor entry not counted)');
  check(/resting short limit at [\d,.]+, stop 6 pt, target 15 pt until \d\d:\d\d \(\d+ min left\)/.test(o), 'O: its resting order as The Desk passes it on');
  check(/-\$162\.00 · -1\.13 R · 1 trade 0W 1L/.test(o) && /\$1,838\.00 to the floor/.test(o), 'O: today -$162.00, -1.13 R, its 50K Flex and room to the floor');
  const oth = await p.$$eval('.ws-panel.agents [data-card="seat:O"] .as-th', bs => bs.map(b => b.innerText.replace(/\s+/g, ' ')));
  check(oth.length >= 3 && /pass 0\.35 Sample: price sliced 25 pts/i.test(oth[0]), 'O: thoughts newest first with time, action, confidence and the first line: ' + oth[0]);
  const ag = await cardText('agent:demo');
  check(/Demo Agent/.test(ag) && /SHADOW/.test(ag) && /Flat/.test(ag) && /Sample: waiting for a retest/.test(ag) && /spend not reported/.test(ag), 'the Demo Agent: SHADOW, flat, its thoughts, spend not reported');
  const head = await p.$eval('.ws-panel.agents .as-mode', e => ({ size: parseFloat(getComputedStyle(e).fontSize), border: getComputedStyle(e).borderStyle }));
  check(head.size >= 14 && head.border === 'dashed', 'the mode big (' + head.size + ' px), SHADOW in a dashed box');
  const colors = await p.$$eval('.ws-panel.agents .as-card.k-seat', cs => cs.map(c => getComputedStyle(c).borderLeftColor));
  check(colors.join('|') === 'rgb(255, 194, 102)|rgb(93, 224, 240)|rgb(182, 156, 255)', 'H amber, S cyan, O violet, as the League tab: ' + colors.join(', '));
  const motion = await p.$$eval('.ws-panel.agents *', es => es.filter(e => { const c = getComputedStyle(e); return (c.transitionDuration && c.transitionDuration.split(',').some(x => parseFloat(x) > 0)) || (c.animationName && c.animationName !== 'none'); }).length);
  check(motion === 0, 'no motion in the strip (R3): ' + motion + ' moving elements');
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways page scroll at 1906');
  await p.screenshot({ path: path.join(out, 'agents-strip-1906.png') });
  await p.screenshot({ path: path.join(out, 'agents-strip-panel-1906.png'), clip: { x: box.x, y: box.y, width: box.w, height: box.h } });

  /* a new thought prepends: the first line, nothing scrolled */
  const top0 = await p.$eval('.ws-panel.agents [data-card="agent:demo"] .as-list', e => e.scrollTop);
  await post('/test/agent-note?agent=demo&kind=thinking&text=' + encodeURIComponent('Sample: a newer made-up thought'));
  const first = await until(async () => { const t = await p.$eval('.ws-panel.agents [data-card="agent:demo"] .as-th', b => b.innerText); return /newer made-up/.test(t) ? t : null; }, 'the new thought first', 5000);
  check(!!first && top0 === 0 && (await p.$eval('.ws-panel.agents [data-card="agent:demo"] .as-list', e => e.scrollTop)) === 0, 'a new thought is the first line, nothing scrolled or slid');

  /* a thought's full reasoning */
  await p.click('.ws-panel.agents [data-card="seat:S"] .as-th.k-enter');
  const det = await until(() => p.$eval('.ws-panel.agents .as-detail', e => (!e.hidden ? e.innerText : null)), 'the full reasoning', 5000);
  check(!!det && /long, 3 MNQ, stop 25 pt, target 50 pt, at VWAP/.test(det) && /The second line of the made-up reasoning/.test(det) && /confidence 0\.62/.test(det) && /SHADOW: paper only/.test(det), 'a click on a thought opens its full reasoning');
  check(!(await p.evaluate(() => document.body.classList.contains('lg-on'))), 'a thought\'s click opens no tab');
  await p.screenshot({ path: path.join(out, 'agents-strip-detail-1906.png') });
  await p.click('.ws-panel.agents .as-detail [data-close]');
  check(await p.$eval('.ws-panel.agents .as-detail', e => e.hidden), 'Close closes it');

  /* one league read for the page: the strip has no poller of its own; while the League view is open the workspace reads nothing */
  const r0 = await p.evaluate(() => window.workspace.leagueReads());
  /* a card opens the agent's full view */
  await p.click('.ws-panel.agents [data-card="seat:H"] .as-name');
  await until(() => p.evaluate(() => document.body.classList.contains('lg-on')), 'a seat\'s card opens the League tab');
  check(true, 'a click on a seat\'s card opens the League tab');
  await wait(16500);
  const r1 = await p.evaluate(() => window.workspace.leagueReads());
  check(r1 === r0, 'while the League view is open the workspace\'s league read waits (' + r0 + ' then ' + r1 + ')');
  await p.click('#wsLeagueTab');
  await until(() => p.evaluate(() => !document.body.classList.contains('lg-on')), 'back to the layout');
  /* the bot card opens the Bot view (its switches, kill switch and rails, unchanged); the Bot button stays in the top bar too */
  check(await p.isVisible('#wsBotTab') && await p.$eval('#wsTabSlot', e => e.contains(document.getElementById('wsBotTab'))), 'with the strip on the layout: the Bot button stays in the top bar (Anthony: "its fine there")');
  const bt = await cardText('bot');
  check(/Demo Opening Fade/.test(bt) && /RAILS/i.test(bt) && /trades \d+ of \d+ · losing \d+ of \d+/.test(bt), 'the bot card: its name, mode, position, today and rails: ' + bt.replace(/\s+/g, ' ').slice(0, 160));
  await p.click('.ws-panel.agents [data-card="bot"] .as-name');
  await until(() => p.evaluate(() => document.body.classList.contains('bt-on')), 'a click on the bot card opens the Bot view');
  check(await p.isVisible('.bt-kill') && await p.isVisible('#wsBotTab'), 'the Bot view: its kill switch in reach, its button in the top bar (the way back)');
  await p.click('#wsBotTab');
  await until(() => p.evaluate(() => !document.body.classList.contains('bt-on')), 'the Bot view closed');
  await p.click('.ws-panel.agents [data-card="agent:demo"] [data-open]');
  await until(() => p.evaluate(() => window.workspace.agent().shown && window.workspace.agent().chosen === 'demo'), 'the agent\'s card opens the Agent tab on him');
  check(true, 'a click on the live agent\'s card opens the Agent tab, on him');
  await p.click('#wsAgentTab');
  await until(() => p.evaluate(() => !window.workspace.agent().shown), 'closed');

  /* Anthony's smallest screen: no sideways page scroll */
  await p.setViewportSize({ width: 1366, height: 768 }); await wait(800);
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways page scroll at 1366');
  await p.screenshot({ path: path.join(out, 'agents-strip-1366.png') });
  /* narrow: the row scrolls sideways inside the panel, never the page */
  await p.setViewportSize({ width: 1100, height: 720 }); await wait(800);
  const row = await p.$eval('.ws-panel.agents .as-row', e => ({ sw: e.scrollWidth, cw: e.clientWidth }));
  check(row.sw > row.cw, 'narrow: the cards no longer fit, the row scrolls sideways (' + row.sw + ' in ' + row.cw + ')');
  check(await p.$eval('.ws-panel.agents', e => { const r = e.getBoundingClientRect(), w = e.querySelector('.as-row').getBoundingClientRect(); return r.right <= innerWidth && w.right <= r.right + 1; }), 'narrow: nothing of the strip sticks out of its panel (the top bar is the page\'s own at 1100)');
  await p.screenshot({ path: path.join(out, 'agents-strip-narrow.png') });

  await p.setViewportSize({ width: 1906, height: 1014 });
  check((await p.evaluate(() => window.__sent.map(m => m.type))).length === 0, 'nothing sent: no order and no agent or bot control message (' + JSON.stringify(await p.evaluate(() => window.__sent.map(m => m.type))) + ')');
  await ctx.close();
} catch (e) {
  fail('threw: ' + (e && e.stack || e));
} finally {
  clearInterval(refresh);
  await browser.close();
  bridge.kill();
  await desk.close();
}
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall passed');
process.exit(errors.length ? 1 : 0);
