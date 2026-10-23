// Chart 1.38.0 smoke (Anthony 2026-10-23, the approved "Drone sky"): the Agents panel. Against the fake bridge (--v3, the made-up
// Demo Agent and Demo Opening Fade, sample data) and the fake Desk (test/fake-desk.mjs) serving a SAMPLE league day made up here
// (every reasoning starting "Sample:"; three seats: H flat, S with an open paper trade at break-even, O at the look cap after a
// made-up stopped-out trade; no real league, no model name, no account). Every screenshot carries a "SAMPLE DATA" tag put on the
// page by this smoke (the page cannot tell the fake bridge from a real one).
//   npm run smoke:agents-strip        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser; SHOTS_DIR=dir for copies;
//                                      STRIP_DPR=2 for a 2x screen)
// An Accounts-like layout at 1906 x 1014 (Anthony's third screen), the panel from + Add panel in the lower left (about 1,430 by
// 450 px). Checks: + Add panel's "Agents" and one a layout; a saved layout with the strip opens the sky; one drone per agent active
// today (H, S, O, the Demo Agent, the bot) in its colour, SHADOW rings dashed; the strip's state words on the text blocks; each text
// block inside its slot at every width; the canvas on whole device pixels; MNQ bars from the quote line (no new socket); no replay
// of history; a new look fires the laser; a pass pulses and types into the feed; a trail moves the stop line and says so; Anthony's
// fill drops the A beacon; the hover card and its full reasoning; a click opens the League tab, the Agent tab or the Bot view;
// "+N idle" and the empty state; slim below 200 px; at most 30 frames a second, 15 calm (reduced motion); no frame while hidden
// (another view open, a panel maximized over it, the window in the background, scrolled away); the frame time; one league read;
// nothing sent. Screenshots test/out/agents-sky-*.png.
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
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); return ok; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };

/* New York wall time now, in ms stored as if UTC (the league's convention) */
function etNow() {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
}
const hms = ms => new Date(ms).toISOString().slice(11, 19);

/* the SAMPLE league day around now; px: MNQ's price on the page; extra: { pass: [seat, id, why] played later, trail: S's stop moved
   up, date: another date } */
const extra = { passes: [], trail: 0, date: null, closed: false };
let base = null;
function sampleDay(px) {
  const now = etNow(), at = m => (base || now) - m * 60000, date = extra.date || new Date(now).toISOString().slice(0, 10);
  const pass = (seat, m, why, conf) => ({ id: seat + '-' + m, seat, t: at(m), time: hms(at(m)), trigger: 'the 5 minute look', latency_s: 3.1, cost: 0.004, call_ok: true, refused: null, answer: { action: 'pass', confidence: conf || 0.4, reasoning: why } });
  const decisions = [];
  for (const m of [44, 33, 21, 9, 2]) decisions.push(pass('H', m, 'Sample: price inside the made-up value area, no level within reach'));
  decisions.push({ id: 'S-15', seat: 'S', t: at(15), time: hms(at(15)), trigger: 'touch VWAP', latency_s: 4.0, cost: 0.006, call_ok: true, refused: null, contracts: 3,
    answer: { action: 'enter', side: 'long', stop_points: 25, target_points: 50, reference: 'VWAP', confidence: 0.62, reasoning: 'Sample: held the made-up VWAP twice with buyers lifting\nThe second line of the made-up reasoning: the target is the prior high.' } });
  for (const m of [12, 6, 1]) decisions.push(pass('S', m, 'Sample: in the trade, nothing to add', 0.5));
  decisions.push({ id: 'O-50', seat: 'O', t: at(50), time: hms(at(50)), trigger: 'touch IBL', latency_s: 9.5, cost: 0.03, call_ok: true, refused: null, contracts: 12,
    answer: { action: 'rest', side: 'short', stop_points: 6, target_points: 15, reference: 'IBL', confidence: 0.55, reasoning: 'Sample: a retest of the made-up IBL from below; rest a short there' } });
  for (let i = 0; i < 30; i++) decisions.push(pass('O', 48 - i * 1.5, i === 29 ? 'Sample: price sliced 25 pts through the made-up EMA50, no clean level' : 'Sample: no edge at the made-up level', 0.35));
  for (const m of [40, 30, 20]) decisions.push(Object.assign(pass('O', m, 'Sample: a look at the made-up mentor entry', 0.3), { trigger: 'a new mentor entry: long MNQ at ' + hms(at(m + 1)).slice(0, 5) }));
  for (const [seat, id, why] of extra.passes) decisions.push({ id, seat, t: now - 1000, time: hms(now - 1000), trigger: 'the 5 minute look', call_ok: true, refused: null, answer: { action: 'pass', confidence: 0.4, reasoning: why } });
  decisions.sort((a, b) => a.t - b.t);
  const fill = Math.round((px - 4) * 4) / 4, stop = fill + extra.trail;
  return {
    shadow: 'SHADOW: no orders', folder: { set: true, ok: true, problem: null }, date,
    day: { date, closed: extra.closed, note: extra.closed ? 'Sample: the made-up day closed' : null },
    status: { date, now: hms(now), feed: 'live', seats: {
      H: { status: 'active', flag: 'Sample data, made up for the smoke', decisions: 58, entries: 0, flex: { phase: 'eval', balance: 50000, today_pnl: 0, room_to_floor: 2000 }, position: null, resting: null },
      S: { status: 'active', flag: 'Sample data, made up for the smoke', decisions: 57, entries: 1, flex: { phase: 'eval', balance: 50000, today_pnl: 24, room_to_floor: 2000 },
        position: { id: 's-S-1', side: 'long', state: 'open', contracts: 3, fill_px: fill, stop_px: stop, target_px: fill + 50, fill_time: hms(at(15)) }, resting: null },
      O: { status: 'active', flag: 'Sample data, made up for the smoke', decisions: 58, entries: 1, flex: { phase: 'eval', balance: 49838, today_pnl: -162, room_to_floor: 1838 }, position: null,
        resting: { id: 'r-O-2', side: 'short', type: 'limit', price: px + 20, stop_points: 6, target_points: 15, good_until: hms(at(-20)), triggered: false } } },
      spend: { day_spent: 1.61, day_cap: 9.5, month_spent: 12.25, month_cap: 200, coach_reserve: 1, seats: { H: 0.42, S: 0.48, O: 0.71 }, calls_today: 173, stopped: null } },
    league: { enough_n: 20, seats: {} },
    trades: [{ id: 's-O-1', seat: 'O', side: 'short', contracts: 12, fill_t: at(49), fill_px: px + 20, stop_px: px + 26, target_px: px + 5, exit_t: at(48), exit_px: px + 26.75, exit_reason: 'stop', r: -1.13, relation: 'own' }],
    open: [{ id: 's-S-1', seat: 'S', side: 'long', contracts: 3, fill_t: at(15), fill_px: fill, stop_px: stop, target_px: fill + 50, stop_points: 25, risk_dollars: 150 }],
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
const post = (u, q) => fetch(`http://127.0.0.1:${PORT}${u}` + (q ? '?' + new URLSearchParams(q) : ''), { method: 'POST' }).then(r => r.json());
const SKY = '.ws-panel.agents';
const LABEL = 'SAMPLE DATA: the fake bridge and a made-up league day, not real trades';
try {
  const ctx = await browser.newContext({ viewport: { width: 1906, height: 1014 }, deviceScaleFactor: +(process.env.STRIP_DPR || 1) });   // STRIP_DPR=2: the frame time at 2x
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    /* every order message and every agent or bot control message the page could send */
    WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'plan', 'groupOrder'].includes(m.type) || /^(agent|bot)[A-Z]/.test(m.type || '')) window.__sent.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
    try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: { Accounts: { panels: [
      { id: 'ap', type: 'accounts', x: 0, y: 0, w: 12, h: 3 }, { id: 'tk', type: 'ticket', x: 9, y: 3, w: 3, h: 3 },
      { id: 'oldbot', type: 'bot', x: 0, y: 3, w: 2, h: 1 }] } } })); } catch (e) { /* blocked */ }   // 1.35.0's Bot panel, saved: opens without it
  });
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  let socks = 0; p.on('websocket', () => { socks++; });
  const sky = () => p.evaluate(() => window.workspace.agentsStrip());
  const label = async () => p.evaluate(t => { const h = document.querySelector('.ws-panel.agents .ws-head'); if (h && !h.querySelector('.smoke-sample')) { const s = document.createElement('span'); s.className = 'smoke-sample'; s.textContent = t; s.style.cssText = 'font:10.5px var(--ws-mono);color:#FFC266;border:1px dashed #FFC266;padding:1px 6px;border-radius:3px;margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0'; h.insertBefore(s, h.querySelector('.ws-fill')); } }, LABEL);
  const shot = async (name, panelOnly) => {
    await label();
    const file = path.join(out, name);
    if (panelOnly) await p.locator(SKY).screenshot({ path: file }); else await p.screenshot({ path: file });
    if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, name));
  };
  await p.goto(`http://localhost:${PORT}/live/?layout=Accounts`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  check(!(await p.$('.ws-panel.bot')) && (await p.evaluate(() => window.workspace.panels().map(x => x.type).join(','))) === 'accounts,ticket', 'a saved layout with the old Bot panel opens without it, no error');
  await post('/test/bot-connect', { name: 'Demo Opening Fade' });
  await post('/test/agent-connect', { agent: 'demo', name: 'Demo Agent' });
  await post('/test/agent-mode', { agent: 'demo', mode: 'shadow' });
  await post('/test/agent-note', { agent: 'demo', kind: 'look', text: 'Sample: a made-up look at the opening range' });
  await post('/test/agent-note', { agent: 'demo', kind: 'thinking', text: 'Sample: waiting for a retest of the made-up level before any plan' });
  px = await until(() => p.evaluate(() => window.workspace.quoteLast('MNQ')), 'MNQ\'s price on the page', 20000);
  base = etNow();
  desk.league = sampleDay(px);

  /* + Add panel: Agents, into the free lower left */
  const socks0 = socks;
  await p.click('#wsAdd');
  const menu = await p.$$eval('#wsAddMenu [data-add]', bs => bs.map(b => b.textContent));
  check(menu.includes('Agents') && !menu.includes('Bot'), '+ Add panel offers Agents (and no Bot panel): ' + menu.join(', '));
  await p.click('#wsAddMenu [data-add="agents"]');
  await until(() => p.$(SKY + ' canvas.ak-cv'), 'the Drone sky placed');
  check(await p.$eval(SKY + ' .ws-name', e => e.textContent) === 'Agents', 'the panel keeps its name, Agents');
  const box = await p.$eval(SKY, e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
  check(box.w >= 1380 && box.w <= 1480 && box.h >= 400 && box.h <= 520 && box.x < 20, 'the panel fills the lower left: ' + JSON.stringify(box));
  await p.click('#wsAdd');
  check(await p.$eval('#wsAddMenu [data-add="agents"]', b => b.disabled), 'one Agents panel a layout: the menu item is off once placed');
  await p.click('#wsAdd');

  /* the drones: one per agent active today, the league's seats first */
  const st = await until(async () => { const s = await sky(); return s && s.drones.length === 5 && s.drones[1].trade && s.bars > 20 ? s : null; }, 'five drones (H, S, O, the Demo Agent, the bot) over MNQ bars', 40000);
  if (st) {
    check(st.drones.map(d => d.key).join(',') === 'seat:H,seat:S,seat:O,agent:demo,bot', 'left to right: ' + st.drones.map(d => d.key).join(', '));
    check(st.drones.slice(0, 3).map(d => d.color).join(',') === '#FFC266,#5DE0F0,#B69CFF' && st.drones.slice(3).every(d => d.color === '#9AA8B8'), 'H amber, S cyan, O violet as the League; the live agent and the bot in the strip\'s own colour: ' + st.drones.map(d => d.color).join(', '));
    check(st.drones.every(d => d.ring === 'dashed' && d.mode === 'SHADOW'), 'SHADOW everywhere here: dashed rings (a LIVE one would be solid)');
    check(st.drones[2].state === 'look cap' && st.drones[2].looks === 31, 'O keeps the strip\'s state word on its text block: look cap (31 counted looks)');
    const s = st.drones[1].trade;
    check(s.side === 'long' && s.contracts === 3 && s.be === true && s.stop === s.entry && typeof s.r === 'number', 'S: in a long trade at break-even, its open R worked out: ' + JSON.stringify(s));
    check(st.bars >= 24 && st.bars <= 90, 'the pillars: ' + st.bars + ' MNQ minute bars');
    check(st.size.cw === Math.round(st.size.w * st.size.dpr) && Number.isInteger(st.size.cw) && Math.abs(st.size.cw / st.size.dpr - st.size.w) < 1e-9, 'the canvas on whole device pixels: ' + JSON.stringify(st.size));
  }
  check(socks === socks0, 'no new connection for the panel: the bars come from the MNQ quote line already open (' + socks0 + ' sockets before and after)');
  /* no replay: of the history, at most the newest act plays (once) */
  const played = st ? st.drones.reduce((a, d) => a + (d.beam ? 1 : 0) + d.queued, 0) : -1;
  check(played <= 1, 'no replay of history on load: ' + played + ' look(s) playing (the newest at most)');
  await wait(2500);
  await shot('agents-sky-full-1906.png', true);
  await shot('agents-sky-page-1906.png');

  /* each text block inside its own slot, at any width */
  const slotsOk = async w => {
    const s = await sky();
    const bad = s.slots.filter(x => x.right > x.x + x.w + 0.5);
    return check(!bad.length && s.slots.length, 'at ' + Math.round(s.size.w) + ' px: every text block inside its slot (' + s.slots.map(x => x.key + ' ' + Math.round(x.right) + '/' + Math.round(x.x + x.w)).join(', ') + ')' + (w ? '' : ''));
  };
  await slotsOk();

  /* a new look: the Demo Agent's LOOK fires its laser; the feed says it */
  await post('/test/agent-note', { agent: 'demo', kind: 'look', text: 'Sample: a newer made-up look at the high' });
  const lk = await until(async () => { const s = await sky(); const d = s.drones.find(x => x.key === 'agent:demo'); return d && (d.beam || d.queued) ? s : null; }, 'the Demo Agent\'s look laser', 5000);
  check(!!lk, 'a new LOOK fires that drone\'s look laser');
  await wait(600);
  await shot('agents-sky-look-1906.png', true);
  const fd = await until(async () => { const s = await sky(); return /^LOOK\s+Sample: a newer made-up look/.test(s.feed.text) && s.feed.who === 'D' ? s.feed : null; }, 'the look in the feed line', 6000);
  check(!!fd, 'then the feed line types it: ' + JSON.stringify(fd));
  /* a new pass from a seat (the next league read, every 15 s with the panel): its laser, then the pulse and the reason */
  extra.passes.push(['H', 'H-new', 'Sample: a newer made-up pass, nothing at the level']);
  desk.league = sampleDay(px);
  const ps = await until(async () => { const s = await sky(); return /^PASS\s+Sample: a newer made-up pass/.test(s.feed.text) && s.feed.who === 'H' ? s : null; }, 'H\'s new pass in the feed line', 25000);
  check(!!ps, 'a seat\'s new pass: its look, then the pulse and its reason typed into the feed line');
  /* the trail: S's stop moves up 5 points; the line moves and the feed says so */
  extra.trail = 5; desk.league = sampleDay(px);
  const tr = await until(async () => { const s = await sky(); const d = s.drones.find(x => x.key === 'seat:S'); return d && d.trade && d.trade.stop === d.trade.entry + 5 && /^TRAIL\s+stop to/.test(s.feed.text) ? s : null; }, 'the trail on S', 25000);
  check(!!tr, 'S\'s trail: the stop line moves 5 points up and the feed line says TRAIL');
  /* Anthony's own fill: a market buy on the ticket's account (as the order connection reports it) drops the A beacon */
  await p.selectOption('.tk [data-tk-id="oAcct"]', 'Sim101'); await wait(300);   // the ticket's account (nothing picked by default)
  const acct = await p.evaluate(() => window.workspace.ticket().account);
  const b0 = (await sky()).beacons.length;
  await post('/test/elsewhere', { account: acct, root: 'MNQ', side: 'buy', kind: 'market', qty: 1 });
  const bc = await until(async () => { const s = await sky(); return s.beacons.length > b0 && /^ENTRY long [\d,.]+ \(Anthony\)/.test(s.feed.text) ? s : null; }, 'the A beacon', 8000);
  check(!!bc, 'Anthony\'s fill on ' + acct + ': the A beacon drops onto the price and the feed says ENTRY: ' + (bc && bc.feed.text));
  await wait(700);
  await shot('agents-sky-beacon-1906.png', true);
  await post('/test/elsewhere', { account: acct, root: 'MNQ', side: 'sell', kind: 'market', qty: 1 });   // flat again

  /* the hover card: the strip's card for that drone */
  const hit = async k => p.$eval(SKY + ` .ak-hit[data-key="${k}"]`, e => { const r = e.getBoundingClientRect(); return { x: r.x + 30, y: r.y + 20 }; });
  const hs = await hit('seat:S');
  await p.mouse.move(hs.x, hs.y);
  const pop = await until(() => p.$eval(SKY + ' .ak-pop', e => (!e.hidden ? e.innerText : null)), 'the hover card', 4000);
  check(!!pop && /Sonnet/.test(pop) && /LONG 3 MNQ/.test(pop) && /open [+-]?\$[\d,.]+ · [+-]?\d+\.\d\d R/.test(pop) && /\$0\.48 seat/.test(pop) && /Thoughts/i.test(pop), 'hover on S: today\'s full card (LONG 3 MNQ, open P&L and R, spend, thoughts)');
  await shot('agents-sky-hover-1906.png', true);
  await p.click(SKY + ' .ak-pop .as-th.k-enter');
  const det = await until(() => p.$eval(SKY + ' .ak-pop .ak-detail', e => e.innerText), 'the full reasoning', 4000);
  check(!!det && /The second line of the made-up reasoning/.test(det) && /confidence 0\.62/.test(det) && /SHADOW: paper only/.test(det), 'a click on a thought in the card: its full reasoning');
  check(!(await p.evaluate(() => document.body.classList.contains('lg-on'))), 'a thought\'s click opens no tab');
  await p.mouse.move(5, 5); await wait(700);
  check(await p.$eval(SKY + ' .ak-pop', e => e.hidden), 'the card goes when the mouse leaves');

  /* a click opens the agent's full view */
  const r0 = await p.evaluate(() => window.workspace.leagueReads());
  const hh = await hit('seat:H');
  const f0 = (await sky()).frames;
  await p.mouse.click(hh.x, hh.y);
  await until(() => p.evaluate(() => document.body.classList.contains('lg-on')), 'a seat\'s drone opens the League tab');
  check(true, 'a click on a seat\'s drone opens the League tab');
  await wait(1500);
  const f1 = (await sky()).frames; await wait(1500); const f2 = (await sky()).frames;
  check(f2 === f1 && !(await sky()).running, 'no frame while the League view covers the panel (' + f0 + ', ' + f1 + ', ' + f2 + ')');
  await wait(14000);
  check((await p.evaluate(() => window.workspace.leagueReads())) === r0, 'while the League view is open the workspace\'s league read waits (one read for the page)');
  await p.click('#wsLeagueTab');
  await until(() => p.evaluate(() => !document.body.classList.contains('lg-on')), 'back to the layout');
  await until(async () => (await sky()).running, 'the sky runs again', 4000);
  const hb = await hit('bot');
  await p.mouse.click(hb.x, hb.y);
  await until(() => p.evaluate(() => document.body.classList.contains('bt-on')), 'the bot\'s drone opens the Bot view');
  check(await p.isVisible('.bt-kill'), 'a click on the bot\'s drone opens the Bot view, its kill switch in reach');
  await p.click('#wsBotTab');
  await until(() => p.evaluate(() => !document.body.classList.contains('bt-on')), 'the Bot view closed');
  const ha = await hit('agent:demo');
  await p.mouse.click(ha.x, ha.y);
  await until(() => p.evaluate(() => window.workspace.agent().shown && window.workspace.agent().chosen === 'demo'), 'the agent\'s drone opens the Agent tab on him');
  check(true, 'a click on the live agent\'s drone opens the Agent tab, on him');
  await p.click('#wsAgentTab');
  await until(() => p.evaluate(() => !window.workspace.agent().shown), 'closed');
  /* keys: a drone's button takes the focus and shows its card */
  await p.focus(SKY + ' .ak-hit[data-key="seat:O"]');
  check(!!(await until(() => p.$eval(SKY + ' .ak-pop', e => (!e.hidden && /look cap/.test(e.innerText) ? 1 : null)), 'the card on focus', 3000)), 'a drone\'s button with the focus shows its card (O, look cap)');
  await p.keyboard.press('Escape').catch(() => {}); await p.mouse.move(5, 5); await p.evaluate(() => document.activeElement && document.activeElement.blur()); await wait(500);

  /* the pace and the cost: at most 30 frames a second; the frame time small */
  await p.mouse.move(5, 5);
  const a0 = await sky(); await wait(3000); const a1 = await sky();
  const fps = (a1.frames - a0.frames) / 3;
  check(fps <= 31 && fps >= 20, 'at most 30 frames a second: ' + fps.toFixed(1));
  check(a1.frameMs.p95 !== null && a1.frameMs.p95 < 8, 'its frame time small: mean ' + a1.frameMs.mean.toFixed(2) + ' ms, p95 ' + a1.frameMs.p95.toFixed(2) + ' ms, max ' + a1.frameMs.max.toFixed(2) + ' ms (' + a1.frameMs.n + ' frames, 1430 x 450)');
  console.log('  perf: ' + JSON.stringify({ fps: +fps.toFixed(1), mean: +a1.frameMs.mean.toFixed(3), p95: +a1.frameMs.p95.toFixed(3), max: +a1.frameMs.max.toFixed(3), size: a1.size }));
  fs.writeFileSync(path.join(out, 'agents-sky-perf.json'), JSON.stringify({ fps, frameMs: a1.frameMs, size: a1.size }, null, 1));
  /* hidden: the window in the background; a panel maximized over it; scrolled out of view */
  await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await wait(400); const h0 = (await sky()).frames; await wait(1500); const h1 = (await sky()).frames;
  check(h1 === h0 && !(await sky()).running, 'no frame while the window is in the background (' + h0 + ', ' + h1 + ')');
  await p.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await until(async () => (await sky()).running, 'running again in the foreground', 3000);
  if (await p.isVisible('#wsAlertClose')) { await p.click('#wsAlertClose'); await wait(200); }   // a note from the fills above
  await p.click('.ws-panel[data-id="ap"] [data-act="max"]');
  check(await p.evaluate(() => document.querySelector('.ws-grid').classList.contains('ws-maxed')), 'the Account page maximized over the layout');
  await wait(1600); const m0 = (await sky()).frames; await wait(1500); const m1 = (await sky()).frames;
  check(m1 === m0 && !(await sky()).running, 'no frame while another panel is maximized over it (' + m0 + ', ' + m1 + ')');
  await p.click('.ws-panel[data-id="ap"] [data-act="max"]').catch(() => {});
  await until(async () => (await sky()).running, 'running again after the restore', 3000);
  /* reduced motion: calm, at most 15 frames a second */
  await p.emulateMedia({ reducedMotion: 'reduce' }); await wait(500);
  const c0 = await sky(); await wait(2000); const c1 = await sky();
  check(c1.calm && (c1.frames - c0.frames) / 2 <= 16, 'reduced motion: calm, ' + ((c1.frames - c0.frames) / 2).toFixed(1) + ' frames a second');
  await shot('agents-sky-calm-1906.png', true);
  await p.emulateMedia({ reducedMotion: 'no-preference' });

  /* slim: the panel 180 px tall (the layout below 200 px) */
  await p.$eval(SKY, e => { e.style.height = '200px'; e.style.alignSelf = 'start'; });
  await wait(800);
  const sl = await sky();
  check(sl.slim && sl.size.h < 200, 'slim below 200 px: the drones and their text in the slim layout (' + Math.round(sl.size.h) + ' px tall)');
  await slotsOk();
  await shot('agents-sky-slim-1906.png', true);
  await p.$eval(SKY, e => { e.style.height = ''; e.style.alignSelf = ''; });
  /* narrower: the text blocks still fit their slots, fields dropped as needed */
  for (const w of [1000, 720, 520, 380]) {
    await p.$eval(SKY, (e, w) => { e.style.width = w + 'px'; e.style.justifySelf = 'start'; }, w); await wait(700);
    await slotsOk();
    if (w === 520) await shot('agents-sky-narrow-520.png', true);
  }
  const nar = await sky();
  check(nar.shown.length < nar.drones.length && await p.$eval(SKY + ' .ak-idle', e => !e.hidden && /\+\d+ more/.test(e.textContent)), 'too narrow for every drone: the rest named on the chip (+N more): ' + await p.$eval(SKY + ' .ak-idle', e => e.textContent));
  await p.click(SKY + ' .ak-idle');
  const ml = await p.$$eval(SKY + ' .ak-more:not([hidden]) .ak-mi', bs => bs.map(b => b.dataset.key));
  check(ml.length === nar.drones.length - nar.shown.length && ml.every(k => !nar.shown.includes(k)), 'a click on "+N more" lists them: ' + ml.join(', '));
  const mr = await p.$eval(SKY + ' .ak-more .ak-mi', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await p.mouse.move(mr.x, mr.y);
  check(!!(await until(() => p.$eval(SKY + ' .ak-pop', e => (!e.hidden ? 1 : null)), 'the card from the list', 3000)), 'hover one in the list: its card');
  await shot('agents-sky-more-380.png', true);
  await p.keyboard.press('Escape'); await p.click(SKY + ' .ak-idle'); await p.mouse.move(5, 5); await wait(500);
  check(await p.$eval(SKY + ' .ak-more', e => e.hidden), 'the list closes from its chip');
  await p.$eval(SKY, e => { e.style.width = ''; e.style.justifySelf = ''; });
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways page scroll at 1906');

  /* Anthony 2026-10-23: seats fade after their session. The league's day closed (as The Desk reports it): H (flat, nothing resting)
     folds into +N idle; S (its open paper trade) and O (its resting order) stay until they are flat */
  extra.closed = true; desk.league = sampleDay(px);
  const fade = await until(async () => { const s = await sky(); return s.idle.includes('Haiku') ? s : null; }, 'H folded into idle after the day stopped', 25000);
  check(!!fade && !fade.drones.some(d => d.key === 'seat:H') && fade.drones.some(d => d.key === 'seat:S' && d.trade) && fade.drones.some(d => d.key === 'seat:O'),
    'the day stopped: flat H folds into idle (' + (fade && fade.idle.join(', ')) + '); S still holding its trade and O its resting order stay: ' + (fade && fade.drones.map(d => d.key).join(', ')));
  const chipF = await p.$eval(SKY + ' .ak-idle', e => ({ text: e.textContent, title: e.title }));
  check(/\+1 idle/.test(chipF.text) && /Haiku/.test(chipF.title), 'named on hover of the chip: ' + JSON.stringify(chipF));
  await shot('agents-sky-day-stopped-1906.png', true);
  extra.closed = false;

  /* +N idle: the league's day not today (yesterday's file): the seats fold into the chip, named on hover */
  extra.date = '2020-01-02'; desk.league = sampleDay(px);
  const idl = await until(async () => { const s = await sky(); return s.idle.length === 3 && s.drones.length === 2 ? s : null; }, 'the seats idle', 25000);
  const chip = await p.$eval(SKY + ' .ak-idle', e => ({ text: e.textContent, title: e.title, hidden: e.hidden }));
  check(!!idl && chip.text === '+3 idle' && /Haiku, Sonnet, Opus/.test(chip.title), 'a league day of another date: the seats fold into "+3 idle", named on hover: ' + JSON.stringify(chip));
  /* the empty state: the agent and the bot off too */
  await post('/test/bot-connect', { on: '0' });
  await post('/test/agent-connect', { agent: 'demo', on: '0' });
  const emp = await until(async () => { const s = await sky(); return s.drones.length === 0 ? s : null; }, 'nobody active', 15000);
  if (!emp) console.log('  still active: ' + JSON.stringify((await sky()).drones.map(d => [d.key, d.state, d.trade])) + ' ' + JSON.stringify(await p.evaluate(() => { const b = window.workspace.agent().agents; return b.map(a => ({ c: a.connected, k: a.killed, s: a.standDown, p: a.position })); })));
  if (emp) {
    check(await p.$eval(SKY + ' .ak-empty', e => !e.hidden && e.textContent === 'No agents active today'), 'the empty state: "No agents active today"');
    const e0 = (await sky()).frames; await wait(1000);
    check((await sky()).frames > e0, 'the faint background still moves');
    await shot('agents-sky-empty-1906.png', true);
  }

  /* a saved layout with the panel opens the sky again */
  await p.reload();
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
  check(!!(await until(() => p.$(SKY + ' canvas.ak-cv'), 'the sky after a reload', 15000)), 'a saved layout with the Agents panel opens the Drone sky');
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
console.log(errors.length ? `\nagents smoke: ${errors.length} of ${checks} checks FAILED` : `\nagents smoke: ${checks} checks, all ok`);
process.exit(errors.length ? 1 : 0);
