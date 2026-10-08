// The Agent tab's Accept and Reject (chart 1.17.0, live/agent.js) are order-path targets: Anthony accepts or rejects an
// agent's proposal there. This smoke holds them, in the workspace and the pop-out, against the fake bridge with two made-up
// agents ("Demo Agent", "Second Demo Agent") and the made-up bot (sample data only):
//   - the tab shows only the shown agent's proposal (Anthony, 2026-10-08): with the second agent AND the bot proposing, no
//     other Accept or Reject is on the page; one line of a fixed height under the slot counts them ("Bot: 1 proposal ·
//     Second Demo Agent: 1"), each name a link to the Bot tab or to that agent in the tab; the copilot keys answer nothing
//     hidden; on the Bot tab the bot's cards are as before;
//   - never covered: document.elementFromPoint at the centre and the four corners of the tab's Accept and Reject finds the
//     button itself, in the window without scrolling, at 1000 x 800, 1366 x 768, 1600 x 900, 1440 x 1000, 1920 x 1080 and
//     390 x 844 (and with notices showing); the same in the pop-out;
//   - never moving: the other proposals arriving and leaving move nothing (the slot, the line, the stream, the footer);
//   - never dropped: the focus stays on Reject over several renders, a press held across a render still clicks, and ordinary
//     clicks all arrive (the slot is written only when it changed);
//   - ChartBridge's words for a proposal (the last 5 s, a long refusal) in sight in the sticky foot, right above the buttons;
//     the workspace's ChartBridge line coming and going moves no Accept; at 1100 px and narrower it is pinned in sight;
//   - the kill switch: a double click sends agentKill once.
//   npm run smoke:agent-targets   (CHROMIUM_PATH=/path/to/chrome; AGENT_TARGETS_PORT, else the first free port from 8975; SHOTS=dir)
// Screenshots: agent-targets-1366, agent-targets-390, agent-targets-popout (.png in test/out).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const free = p => new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
let PORT = +(process.env.AGENT_TARGETS_PORT || 0);
if (!PORT) { PORT = 8975; while (!(await free(PORT))) PORT++; }
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const agentsNow = async () => (await control('agents')).agents;
async function until(fn, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t0 > ms) { fail('timed out: ' + what); return null; } await sleep(150); }
}
const DESK_KEYS = { rev: 3, keys: { buy: '', sell: '', be: '', close: '', flattenAll: '', merge: '', maximize: '', accept: 'Alt+Y', reject: 'Alt+N' }, modifiers: { limit: '', stop: '' } };
const LONG = 'Sample reason: a made-up pullback to a made-up level; ' + 'more made-up words to make the reason long. '.repeat(3);
const SIZES = [[1000, 800], [1366, 768], [1600, 900], [1440, 1000], [1920, 1080], [390, 844]];

/* the hit test, in the page: for each button, its centre and four corners (3 px in) must find the button itself; a button out
   of its scroll box's sight is brought into sight first (a phone: the tab scrolls) */
const hitTest = (page, sel, still) => page.evaluate(([sel, still]) => {
  const out = [];
  for (const b of document.querySelectorAll(sel)) {
    if (!b.offsetParent) { out.push(b.dataset.agans + ': not shown'); continue; }
    if (!still) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });   // still: as it shows, nothing scrolled
    const r = b.getBoundingClientRect(), card = b.closest('.ag-prop, .bt-prop');
    const name = (card ? (card.dataset.agent || 'bot') + ':' + card.dataset.id : '?') + ':' + (b.dataset.agans || b.dataset.ans);
    if (r.width < 20 || r.height < 20) { out.push(name + ': too small ' + JSON.stringify(r)); continue; }
    for (const [x, y] of [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 3, r.top + 3], [r.right - 3, r.top + 3], [r.left + 3, r.bottom - 3], [r.right - 3, r.bottom - 3]]) {
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === b || b.contains(hit))) continue;
      const c2 = hit && hit.closest('.ag-prop, .bt-prop');
      out.push(name + ' at ' + Math.round(x) + ',' + Math.round(y) + ' -> ' + (!hit ? 'nothing (off the window)' : c2 ? 'card ' + (c2.dataset.agent || 'bot') + ':' + c2.dataset.id + ' ' + (hit.className || hit.tagName) : hit.closest('.ag-note, .bt-note') ? 'a notice' : hit.closest('.ws-alerts') ? 'the ChartBridge line' : (hit.className || hit.tagName)));
    }
  }
  return out;
}, [sel, !!still]);
/* notices (as the page shows them) in the notice box, wherever the page keeps it */
const notices = (page, n) => page.evaluate(n => {
  const box = document.querySelector('.bt-notes, .ag-notes');
  for (let i = 0; i < n; i++) { const d = document.createElement('div'); d.className = 'ag-note amber'; d.innerHTML = '<span class="ag-ttl">Agent</span><span>Sample notice ' + i + ': a made-up line long enough to take two lines in the box</span>'; box.prepend(d); }
}, n);
const clearNotices = page => page.evaluate(() => { for (const n of document.querySelectorAll('.ag-note')) n.remove(); });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN, '--agents=demo,demotwo', '--agent-any-time', '--max-qty=MNQ:20,NQ:2'], { stdio: ['ignore', 'pipe', 'inherit'] });
try {
  await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  for (const u of ['chart-hotkeys', 'chart-strategies', 'chart-accounts']) await ctx.route('http://localhost:8800/api/' + u, r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: u === 'chart-accounts' ? '{"accounts":[]}' : u === 'chart-strategies' ? '{"rev":0,"strategies":[]}' : JSON.stringify(DESK_KEYS) }));
  await ctx.addInitScript(() => {
    const Real = window.WebSocket; window.__sent = [];
    function Spy(u, p) { const s = p === undefined ? new Real(u) : new Real(u, p); const send = s.send.bind(s); s.send = d => { try { const m = JSON.parse(d); if (/^(agent|bot)/.test(m.type)) window.__sent.push(m); } catch (e) { /* not JSON */ } return send(d); }; return s; }
    Spy.prototype = Real.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
    window.WebSocket = Spy;
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  page.on('dialog', d => { fail('a browser dialog: ' + d.message()); d.dismiss(); });
  await page.goto(`http://localhost:${PORT}/live/?layout=Main`);
  await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  const sent = () => page.evaluate(() => window.__sent);
  const text = sel => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
  await control('price', { root: 'MNQ', p: 25400 });
  await control('agent-connect', { agent: 'demo', name: 'Demo Agent', build: 'sample-build-1' });
  await control('agent-connect', { agent: 'demotwo', name: 'Second Demo Agent', build: 'sample-build-7' });
  await page.click('#wsAgentTab');
  await until(() => page.evaluate(() => window.workspace.agent().shown && window.workspace.agent().agents.length === 2), 'the Agent tab open with both agents');
  for (const [id, acct] of [['demotwo', 'SIM-AG2'], ['demo', 'SIM-AG1']]) {
    await page.selectOption('#agView [data-k="pick"]', id);
    await until(async () => (await page.evaluate(() => window.workspace.agent().chosen)) === id, id + ' shown');
    await page.click('#agView [data-act="acctOpen"]'); await page.selectOption('#agView [data-k="acctSel"]', acct); await page.click('#agView [data-act="acctSave"]');
    await until(async () => (await agentsNow()).find(a => a.agent === id).account === acct, id + ' trades ' + acct);
    await page.click('#agView [data-mode="copilot"]');
    await until(async () => (await agentsNow()).find(a => a.agent === id).mode === 'copilot', id + ' in Copilot');
  }

  /* every Accept and Reject on the page outside the tab's slot that shows (a card hidden, or in a hidden corner, has no box) */
  const strays = pg => pg.evaluate(() => [...document.querySelectorAll('[data-agans], [data-ans]')].filter(b => b.getClientRects().length && !b.closest('#agView .ag-plist'))
    .map(b => { const c = b.closest('.ag-prop, .bt-prop'); return (c ? (c.dataset.agent || 'bot') + ':' + c.dataset.id : '?') + ':' + (b.dataset.agans || b.dataset.ans); }));
  /* the line under the slot: its words, its height, the names marked as risen */
  const LINE = '#agView [data-panel="prop"] [data-k="others"]';
  const others = pg => pg.evaluate(sel => { const e = document.querySelector(sel), r = e.getBoundingClientRect(); return { text: e.textContent.replace(/\s+/g, ' ').trim(), h: Math.round(r.height), up: [...e.querySelectorAll('.ag-oitem.up')].map(x => x.dataset.key) }; }, LINE);
  /* nothing scrolled: the page, the tab and the slot at their tops (a phone: the proposal panel's top at the top of the tab) */
  const toTop = (pg, phone) => pg.evaluate(phone => {
    window.scrollTo(0, 0); for (const b of document.querySelectorAll('#agView .ag-main, #agView .ag-slot')) b.scrollTop = 0;
    if (phone) document.querySelector('#agView [data-panel="prop"]').scrollIntoView({ block: 'start' });
  }, !!phone);
  /* the shown agent's open Accept and Reject in the window as it is (nothing scrolled to them) */
  const inWindow = (pg, sel) => pg.evaluate(sel => { const bs = [...document.querySelectorAll(sel)]; return bs.length === 2 && bs.every(b => { const r = b.getBoundingClientRect(); return r.height > 30 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; }); }, sel);

  /* ---------------------------------------------------------------- the tab: the shown agent's proposal only */
  console.log('the tab shows the shown agent\'s proposal only: the second agent\'s and the bot\'s are counted in one line under it');
  await control('agent-plan', { agent: 'demotwo', id: 'q2', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 16, target: 32, expire: 900, setup: 'Sample Q', reason: LONG, confidence: 0.6 });
  await control('bot-connect', { name: 'Sample Lantern Fade' });
  await control('bot-proposal', { id: 'b1', side: 'sell', kind: 'market', stop: 12, target: 24, reason: 'Sample: the made-up bot\'s signal' });
  await control('agent-plan', { agent: 'demo', id: 'pa', side: 'buy', kind: 'limit', p: 25390, qty: 2, stop: 16, target: 32, expire: 900, setup: 'Sample A', reason: LONG, confidence: 0.6 });
  await until(() => page.isVisible('.ag-plist .ag-prop[data-id="pa"]'), 'demo\'s proposal in the tab');
  const BOTH = 'Bot: 1 proposal · Second Demo Agent: 1';
  await until(async () => (await others(page)).text === BOTH, 'the line counts the bot\'s and the second agent\'s proposals');
  check(await page.evaluate(() => !!document.querySelector('.bt-prop[data-id="b1"]') && !!document.querySelector('.ag-prop.corner[data-id="q2"]') && getComputedStyle(document.querySelector('.bt-props')).display === 'none'),
    'their cards exist (the Bot tab\'s corner) and the corner is hidden while the Agent tab is shown');
  const TAB = '#agView .ag-plist .ag-prop[data-id="pa"] [data-agans]';
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(700);
    await toTop(page, w < 720); await sleep(150);
    const seen = await inWindow(page, TAB), bad = await hitTest(page, TAB, true);
    check(seen && !bad.length, 'at ' + w + ' x ' + h + (w < 720 ? ' (the proposal panel\'s first screen)' : '') + ' the tab\'s Accept and Reject are in the window without scrolling, their centre and corners the buttons themselves' + (bad.length ? ': ' + bad.slice(0, 4).join('; ') : seen ? '' : ': not in the window'));
    const st = await strays(page), o = await others(page);
    check(!st.length && o.text === BOTH && o.h === 30, 'at ' + w + ' x ' + h + ' no other Accept or Reject anywhere on the page; the line says "' + o.text + '" at ' + o.h + ' px' + (st.length ? ': ' + st.join(', ') : ''));
    if (w === 1366 || w === 390) await page.screenshot({ path: path.join(SHOTS, 'agent-targets-' + w + '.png') });
  }
  /* R3: the line's mark for a risen count is still: no transition, no animation */
  check(await page.evaluate(sel => [document.querySelector(sel), ...document.querySelectorAll(sel + ' *')].every(e => { const c = getComputedStyle(e); return c.transitionDuration.split(',').every(d => parseFloat(d) === 0) && c.animationName === 'none'; }), LINE),
    'the line and its names have no transition and no animation (R3)');
  /* notices showing: stacked in the chart, never over a button (at 1100 px and narrower pinned at the top of the tab) */
  for (const [w, h] of [[1366, 768], [1000, 800], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(600);
    await toTop(page);
    await notices(page, 4);
    await sleep(100);
    const bad = await hitTest(page, TAB);
    /* above 1100 px over the chart's lower left; at 1100 px and narrower pinned at the top of the tab (the tray), the newest in sight */
    const inChart = await page.evaluate(() => { const narrow = innerWidth <= 1100, c = document.querySelector(narrow ? '#agView [data-k="tray"]' : '#agView [data-panel="chart"]').getBoundingClientRect(), all = [...document.querySelectorAll('.ag-note')];
      const inside = all.every(n => { const r = n.getBoundingClientRect(); return narrow ? !!n.closest('#agView [data-k="tray"]') : r.height === 0 || (r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1); });
      const newest = all[0] && all[0].getBoundingClientRect();
      return inside && (!narrow || (!!newest && newest.top >= Math.max(0, c.top) - 1 && newest.bottom <= Math.min(innerHeight, c.bottom) + 1)); });
    check(!bad.length && inChart, 'at ' + w + ' x ' + h + ' with four notices showing, they sit ' + (w <= 1100 ? 'at the top of the tab, the newest in sight,' : 'in the chart panel') + ' and no Accept or Reject is under one' + (bad.length ? ': ' + bad.slice(0, 4).join('; ') : inChart ? '' : ': a notice outside the chart panel'));
    await clearNotices(page);
  }

  /* ---------------------------------------------------------------- the focus and the press survive the renders */
  console.log('the focus and a held press survive the renders (an agent message each second)');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await sleep(500);
  await page.focus('.ag-plist .ag-prop[data-id="pa"] [data-agans="reject"]');
  const focusHeld = [];
  for (let i = 0; i < 5; i++) { await sleep(700); focusHeld.push(await page.evaluate(() => { const a = document.activeElement; return a && a.dataset.agans === 'reject' && a.closest('.ag-prop').dataset.id === 'pa'; })); }
  check(focusHeld.every(Boolean), 'the focus stays on Reject over 3.5 s of renders: ' + JSON.stringify(focusHeld));
  /* ordinary clicks (150 ms presses) on Accept, stopped before the page acts on them: every one arrives as a click */
  await page.evaluate(() => { window.__clk = 0; window.__md = 0; window.__sw = e => { if (e.target.closest('.ag-plist [data-agans="accept"]')) { if (e.type === 'click') window.__clk++; else window.__md++; e.stopPropagation(); e.preventDefault(); } }; document.addEventListener('click', window.__sw, true); document.addEventListener('mousedown', window.__sw, true); });
  for (let k = 0; k < 20; k++) {
    const bb = await (await page.$('.ag-plist .ag-prop[data-id="pa"] [data-agans="accept"]')).boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await sleep(150); await page.mouse.up(); await sleep(100);
  }
  const clk = await page.evaluate(() => { document.removeEventListener('click', window.__sw, true); document.removeEventListener('mousedown', window.__sw, true); return [window.__md, window.__clk]; });
  check(clk[0] === 20 && clk[1] === 20, '20 ordinary clicks on Accept: 20 presses and 20 clicks arrive: ' + JSON.stringify(clk));
  /* a press held across a render still clicks (Reject: pa ends rejected) */
  const bb = await (await page.$('.ag-plist .ag-prop[data-id="pa"] [data-agans="reject"]')).boundingBox();
  await page.evaluate(() => { window.__mut = 0; new MutationObserver(r => { window.__mut += r.length; }).observe(document.querySelector('#agView [data-k="plist"]'), { childList: true }); });
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await sleep(1400); await page.mouse.up();
  await until(async () => (await sent()).some(m => m.type === 'agentAnswer' && m.id === 'pa' && m.answer === 'reject'), 'a press held 1.4 s on Reject sends the reject', 3000);
  check((await page.evaluate(() => window.__mut)) === 0 || (await sent()).some(m => m.type === 'agentAnswer' && m.id === 'pa'), 'the list was not written again under the held press');

  /* ---------------------------------------------------------------- never moving */
  console.log('Accept never moves: a new proposal right after an ended one, the ChartBridge line coming and going');
  /* pa ended (rejected); pb right away: pb takes the top at once and never jumps up when pa's time runs out */
  await control('agent-plan', { agent: 'demo', id: 'pb', side: 'sell', kind: 'limit', p: 25410, qty: 1, stop: 20, target: 40, expire: 900, setup: 'Sample B', reason: LONG, confidence: 0.5 });
  await until(() => page.isVisible('.ag-plist .ag-prop[data-id="pb"]'), 'pb in the tab');
  const tops = async id => page.evaluate(id => { const b = document.querySelector('.ag-plist .ag-prop[data-id="' + id + '"] [data-agans="accept"]'); return b ? Math.round(b.getBoundingClientRect().top) : null; }, id);
  const seen = [];
  for (let i = 0; i < 25; i++) { seen.push(await tops('pb')); await sleep(100); }
  check(seen.every(v => v !== null && v === seen[0]), 'a new proposal right after an ended one: its Accept never moves over 2.5 s: ' + JSON.stringify([...new Set(seen)]));
  /* the workspace's ChartBridge line comes and goes: no Accept moves */
  const open1 = 'pb';
  for (const [w, h] of [[1366, 768], [1440, 1000]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(500);
    await page.evaluate(id => document.querySelector('.ag-plist .ag-prop[data-id="' + id + '"] [data-agans="accept"]').scrollIntoView({ block: 'nearest' }), open1);
    await sleep(200);
    const t0 = await tops(open1);
    await control('status', { level: 'warn', text: 'Sample: EVAL-B is gone (disconnected for 10 s): entries wait until it is back' });
    await until(() => page.isVisible('#wsAlert'), 'the ChartBridge line shows');
    await sleep(200);
    const t1 = await tops(open1), cover = await hitTest(page, '.ag-plist .ag-prop[data-id="' + open1 + '"] [data-agans]');
    await page.click('#wsAlertClose');
    await sleep(200);
    const t2 = await tops(open1);
    check(t0 !== null && t0 === t1 && t1 === t2 && !cover.length, 'at ' + w + ' x ' + h + ' the ChartBridge line coming and going moves no Accept and covers none: ' + JSON.stringify([t0, t1, t2, cover]));
  }

  /* ---------------------------------------------------------------- ChartBridge's words in the sticky foot */
  console.log('a proposal\'s words from ChartBridge are in sight, right above Accept and Reject');
  await page.setViewportSize({ width: 1366, height: 768 });
  const target = 'pb';
  await control('agent-expire', { agent: 'demo', id: target, ms: 4000 });
  await until(async () => /too late to accept/.test(await text('.ag-plist .ag-prop[data-id="' + target + '"] [data-k="msg"]')), 'Under 5 s left shows');
  await page.evaluate(id => document.querySelector('.ag-plist .ag-prop[data-id="' + id + '"] [data-agans="accept"]').scrollIntoView({ block: 'nearest' }), target);
  await sleep(200);
  const inSight = id => page.evaluate(id => {
    const card = document.querySelector('.ag-plist .ag-prop[data-id="' + id + '"]'), box = document.querySelector('#agView .ag-slot').getBoundingClientRect();
    const m = card.querySelector('[data-k="msg"]').getBoundingClientRect(), a = card.querySelector('[data-agans="accept"]').getBoundingClientRect();
    const hit = document.elementFromPoint(m.left + Math.min(40, m.width / 2), m.top + m.height / 2);
    return { msg: [Math.round(m.top), Math.round(m.bottom)], accept: Math.round(a.top), box: [Math.round(box.top), Math.round(box.bottom)], ok: m.height > 0 && m.top >= box.top - 1 && m.bottom <= box.bottom + 1 && m.bottom <= a.top + 1 && !!hit && card.querySelector('[data-k="msg"]').contains(hit) };
  }, id);
  const s1 = await inSight(target);
  check(s1.ok, 'at 1366 x 768 "Under 5 s left" is in sight, right above Accept: ' + JSON.stringify(s1));
  await page.evaluate(id => { document.querySelector('.ag-plist .ag-prop[data-id="' + id + '"] [data-k="msg"]').textContent = 'Refused by ChartBridge: SIM-AG1 is not tradable now (its checkmark on the Accounts tab, Connected); a made-up long refusal so the words take two or three lines in the box'; }, target);
  await sleep(200);
  const s3 = await inSight(target), tb = await hitTest(page, '.ag-plist .ag-prop[data-id="' + target + '"] [data-agans]');
  check(s3.ok && !tb.length, 'a long refusal too: in sight above Accept and Reject, which stay uncovered: ' + JSON.stringify(s3) + (tb.length ? ' ' + tb.join('; ') : ''));

  /* ---------------------------------------------------------------- the kill switch on a double click */
  console.log('the kill switch: a double click sends agentKill once');
  const k0 = (await sent()).filter(m => m.type === 'agentKill').length;
  await page.dblclick('#agView [data-k="kill"]');
  await sleep(1200);
  const kills = (await sent()).filter(m => m.type === 'agentKill').slice(k0);
  check(kills.length === 1 && kills[0].on === true, 'a double click on the kill switch sends agentKill on once: ' + JSON.stringify(kills));
  check(await until(async () => (await agentsNow()).find(a => a.agent === 'demo').killed, 'killed'), 'and the agent is killed');
  check((await text('#agView [data-k="kill"]')) === 'Kill switch on · Release', 'the double click never armed the release: ' + await text('#agView [data-k="kill"]'));
  await page.click('#agView [data-k="kill"]'); await sleep(600); await page.click('#agView [data-k="kill"]');   // released (two clicks, as always)
  await until(async () => !(await agentsNow()).find(a => a.agent === 'demo').killed, 'released');

  /* ---------------------------------------------------------------- the others come and go: nothing moves */
  console.log('the bot\'s and the second agent\'s proposals arriving and leaving: the line counts them, nothing on the tab moves');
  let n = 0;
  const botOpen = new Set(['b1']), twoOpen = new Set(['q2']);
  const botNew = async () => { const id = 'bx' + (++n); await control('bot-proposal', { id, side: 'sell', kind: 'market', stop: 12, target: 24, reason: 'Sample: the made-up bot\'s signal ' + n }); botOpen.add(id); return id; };
  const twoNew = async () => { const id = 'qx' + (++n); await control('agent-plan', { agent: 'demotwo', id, side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 16, target: 32, expire: 900, setup: 'Sample Q', reason: LONG, confidence: 0.6 }); twoOpen.add(id); return id; };
  const ownNew = async () => { const id = 'px' + (++n); await control('agent-plan', { agent: 'demo', id, side: 'sell', kind: 'limit', p: 25410, qty: 1, stop: 20, target: 40, expire: 900, setup: 'Sample X', reason: LONG, confidence: 0.5 }); await until(() => page.isVisible('.ag-plist .ag-prop[data-id="' + id + '"]'), 'the shown agent\'s ' + id + ' in the tab'); return id; };
  const botGone = async id => { await control('bot-withdraw', { id }); botOpen.delete(id); };
  const twoGone = async id => { await control('agent-withdraw', { agent: 'demotwo', id }); twoOpen.delete(id); };
  const ownOpen = () => page.evaluate(() => [...document.querySelectorAll('#agView .ag-plist .ag-prop:not(.ag-ended)')].map(c => c.dataset.id));
  for (const id of await ownOpen()) await control('agent-withdraw', { agent: 'demo', id });
  const own = await ownNew();
  const OWN = '#agView .ag-plist .ag-prop[data-id="' + own + '"] [data-agans]';
  /* where everything on the tab is: the shown agent's Accept and Reject, the slot, the line, the stream, the chart, the footer */
  const layout = pg => pg.evaluate(own => {
    const r = sel => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round).join(','); };
    return { accept: r('#agView .ag-plist .ag-prop[data-id="' + own + '"] [data-agans="accept"]'), reject: r('#agView .ag-plist .ag-prop[data-id="' + own + '"] [data-agans="reject"]'), slot: r('#agView .ag-slot'),
      line: r('#agView [data-panel="prop"] [data-k="others"]'), stream: r('#agView [data-panel="stream"]'), chart: r('#agView [data-panel="chart"]'), foot: r('#agView [data-panel="pnl"]'), left: r('#agView [data-panel="acct"]') };
  }, own);
  for (const [w, h] of [[1000, 800], [1366, 768], [1920, 1080], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h }); await sleep(600);
    for (const id of [...botOpen]) await botGone(id);
    for (const id of [...twoOpen]) await twoGone(id);
    await until(async () => (await others(page)).text === 'No other proposals', 'at ' + w + ' x ' + h + ' none open elsewhere');
    await toTop(page, w < 720); await sleep(200);
    const base = await layout(page);
    const o0 = await others(page);
    check(o0.h === 30, 'at ' + w + ' x ' + h + ' with none open elsewhere the line says "' + o0.text + '" at ' + o0.h + ' px');
    const steps = [
      ['the bot\'s proposal arrives', botNew, 'Bot: 1 proposal', 'bot'],
      ['the second agent\'s arrives', twoNew, 'Bot: 1 proposal · Second Demo Agent: 1', 'agent:demotwo'],
      ['the bot\'s second arrives', botNew, 'Bot: 2 proposals · Second Demo Agent: 1', 'bot'],
      ['the bot\'s first leaves', () => botGone([...botOpen][0]), 'Bot: 1 proposal · Second Demo Agent: 1', ''],
      ['the second agent\'s leaves', async () => { for (const id of [...twoOpen]) await twoGone(id); }, 'Bot: 1 proposal', ''],
      ['the bot\'s last leaves', async () => { for (const id of [...botOpen]) await botGone(id); }, 'No other proposals', ''],
    ];
    for (const [what, act, want, up] of steps) {
      await act();
      const moved = [];
      let o = null;
      for (let t = 0; t < 1500; t += 150) {
        await sleep(150);
        const now = await layout(page);
        for (const k of Object.keys(base)) if (now[k] !== base[k] && !moved.some(m => m.startsWith(k + ' '))) moved.push(k + ' ' + base[k] + ' -> ' + now[k]);
        o = await others(page);
        if (o.h !== 30 && !moved.some(m => m.startsWith('line height'))) moved.push('line height ' + o.h);
      }
      check(!moved.length && o.text === want && (!up || o.up.includes(up)), 'at ' + w + ' x ' + h + ' ' + what + ': "' + o.text + '"' + (up ? ', marked' : '') + ', nothing moved' + (moved.length ? ': ' + moved.slice(0, 4).join('; ') : o.text !== want ? ' (wanted "' + want + '")' : up && !o.up.includes(up) ? ' (not marked)' : ''));
    }
    const st = await strays(page), bad = await hitTest(page, OWN, true);
    check(!st.length && !bad.length && await inWindow(page, OWN), 'at ' + w + ' x ' + h + ' after it all the shown agent\'s Accept and Reject are in the window and themselves, and no other is on the page' + (st.length ? ': ' + st.join(', ') : bad.length ? ': ' + bad.slice(0, 3).join('; ') : ''));
  }

  /* ---------------------------------------------------------------- the line's links */
  console.log('the line\'s names: the second agent in the tab, the Bot tab');
  await page.setViewportSize({ width: 1366, height: 768 }); await sleep(500);
  await toTop(page);
  const b2 = await botNew(); await sleep(200);                                         // the bot's oldest: at the foot of its corner on the Bot tab
  const q3 = await twoNew();
  await until(async () => (await others(page)).text === 'Bot: 1 proposal · Second Demo Agent: 1', 'both counted');
  await page.click(LINE + ' [data-goto="agent:demotwo"]');
  await until(async () => (await page.evaluate(() => window.workspace.agent().chosen)) === 'demotwo', 'the second agent shown');
  await until(() => page.isVisible('#agView .ag-plist .ag-prop[data-agent="demotwo"][data-id="' + q3 + '"]'), 'its proposal in the slot');
  const o2 = await others(page);
  check(o2.text === 'Bot: 1 proposal · Demo Agent: 1' && !(await strays(page)).length && !(await hitTest(page, '#agView .ag-plist .ag-prop[data-id="' + q3 + '"] [data-agans]', true)).length,
    'the second agent\'s name shows it in the tab: its proposal in the slot, the line now counts the first agent\'s: "' + o2.text + '"');
  await page.click(LINE + ' [data-goto="agent:demo"]');
  await until(async () => (await page.evaluate(() => window.workspace.agent().chosen)) === 'demo', 'the first agent shown again');
  check((await others(page)).text === 'Bot: 1 proposal · Second Demo Agent: 1' && await page.isVisible('#agView .ag-plist .ag-prop[data-id="' + own + '"]'), 'and its name brings the first agent back, its proposal in the slot');
  await page.click(LINE + ' [data-goto="bot"]');
  await until(() => page.evaluate(() => window.workspace.bot().shown && !window.workspace.agent().shown), 'the Bot tab opens and the Agent tab closes');
  await sleep(300);
  const botCard = '.bt-prop[data-id="' + b2 + '"] [data-ans]';
  const onBot = await page.evaluate(sel => ({ corner: getComputedStyle(document.querySelector('.bt-props')).display !== 'none', btns: [...document.querySelectorAll(sel)].filter(b => b.getClientRects().length).length }), botCard);
  const botBad = await hitTest(page, botCard, true);
  check(onBot.corner && onBot.btns === 2 && !botBad.length, 'the Bot tab: the bot\'s proposal in its corner as before, its Accept and Reject the buttons themselves' + (botBad.length ? ': ' + botBad.slice(0, 3).join('; ') : ' ' + JSON.stringify(onBot)));
  await page.evaluate(() => document.getElementById('wsAgentTab').click());          // three tall cards in the corner reach the top bar here
  await until(() => page.evaluate(() => window.workspace.agent().shown && !window.workspace.bot().shown), 'the Agent tab again');

  /* ---------------------------------------------------------------- the keys answer the shown agent only */
  console.log('the copilot keys with the Agent tab open: the shown agent\'s proposal only, never a hidden one');
  await page.setViewportSize({ width: 1440, height: 1000 }); await sleep(400);
  for (const id of await ownOpen()) await control('agent-withdraw', { agent: 'demo', id });
  await until(async () => !(await ownOpen()).length, 'none of the shown agent\'s open');
  await sleep(1200);                                                                    // the bot's and the second agent's on screen 1 s (were they shown)
  const answers = async () => (await sent()).filter(m => m.type === 'agentAnswer' || m.type === 'botAnswer');
  const n0 = (await answers()).length;
  await page.click('#agView .ag-loghead');
  await page.keyboard.press('Alt+KeyY'); await sleep(400); await page.keyboard.press('Alt+KeyN'); await sleep(700);
  const k1 = (await answers()).slice(n0);
  check(!k1.length && /keys answer only demo's proposals/.test(await page.textContent('#wsNote')), 'with none of the shown agent\'s open, Accept and Reject keys answer nothing (the bot\'s and the second agent\'s are hidden) and say so: ' + JSON.stringify(k1));
  const mineK = await ownNew();
  await sleep(1200);
  await page.click('#agView .ag-loghead');
  await page.keyboard.press('Alt+KeyN');
  await until(async () => (await answers()).slice(n0).length >= 1, 'a key answer');
  await sleep(500);
  const k2 = (await answers()).slice(n0);
  check(k2.length === 1 && k2[0].type === 'agentAnswer' && k2[0].agent === 'demo' && k2[0].id === mineK && k2[0].answer === 'reject', 'the Reject key answers the shown agent\'s proposal, and nothing else: ' + JSON.stringify(k2.map(m => (m.agent || 'bot') + ':' + m.id + ':' + m.answer)));
  check(botOpen.has(b2) && (await control('v3')).proposals.find(p => p.id === b2).state === 'open' && (await agentsNow()).find(a => a.agent === 'demotwo').proposals.find(p => p.id === q3).state === 'open', 'the bot\'s and the second agent\'s proposals still open');

  /* ---------------------------------------------------------------- ChartBridge's errors in sight at narrow widths */
  console.log('at 1100 px and narrower ChartBridge\'s error line is pinned in sight, over no Accept or Reject');
  await until(async () => !(await ownOpen()).length, 'the rejected one gone', 6000);
  await ownNew();
  for (const [w, h] of [[1000, 800], [800, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h }); await sleep(600);
    await toTop(page);
    const before = await page.evaluate(() => { const b = document.querySelector('#agView .ag-plist [data-agans="accept"]'); return b ? Math.round(b.getBoundingClientRect().top) : null; });
    await control('status', { level: 'error', text: 'Sample: Agent demo: NOT FLAT 10 s after its flatten (flat time): MNQ on SIM-AG1 still shows 1; act in NinjaTrader now' });
    await until(() => page.isVisible('#wsAlert'), 'the error line shows');
    await sleep(200);
    const r = await page.evaluate(() => {
      const a = document.getElementById('wsAlert'), ar = a.getBoundingClientRect(), hit = document.elementFromPoint(ar.left + Math.min(60, ar.width / 2), ar.top + Math.min(12, ar.height / 2));
      const covered = [];
      for (const b of document.querySelectorAll('#agView [data-agans], #agView [data-ans]')) {
        const br = b.getBoundingClientRect(); if (!b.getClientRects().length || br.top < 0 || br.bottom > innerHeight) continue;
        for (const [x, y] of [[br.left + br.width / 2, br.top + br.height / 2], [br.left + 3, br.top + 3], [br.right - 3, br.bottom - 3]]) { const e = document.elementFromPoint(x, y); if (!e || !b.contains(e)) { covered.push((b.closest('.ag-prop, .bt-prop') || {}).className + ' -> ' + (e ? e.className : 'none')); break; } }
      }
      const own = document.querySelector('#agView .ag-plist [data-agans="accept"]');
      return { top: Math.round(ar.top), bottom: Math.round(ar.bottom), seen: ar.height > 0 && ar.top >= 0 && ar.bottom <= innerHeight && !!hit && a.contains(hit), covered, own: own ? Math.round(own.getBoundingClientRect().top) : null };
    });
    check(r.seen && !r.covered.length && r.own !== null && Math.abs(r.own - before) <= 1, 'at ' + w + ' x ' + h + ' with the tab at its top, ChartBridge\'s error line is in sight, covers no Accept or Reject and moves none: ' + JSON.stringify(r) + ' (Accept at ' + before + ' before)');
    await page.click('#wsAlertClose');
  }
  for (const id of await ownOpen()) await control('agent-withdraw', { agent: 'demo', id });
  if (!twoOpen.size) await twoNew();                                                    // the pop-out counts the second agent's

  /* ---------------------------------------------------------------- the pop-out (agent.html) */
  console.log('the pop-out: the same rule (its agent\'s slot and the count line)');
  const pop = await ctx.newPage();
  pop.on('pageerror', e => fail('pop-out error: ' + e.message));
  await pop.goto(`http://localhost:${PORT}/live/agent.html`);
  if (await pop.waitForSelector('.cb-pin-key', { timeout: 5000 }).catch(() => null)) await enterPin(pop, TEST_PIN);
  await pop.waitForFunction(() => window.agentDesk && window.agentDesk.state().agents.length === 2, null, { timeout: 20000 });
  await pop.selectOption('#agView [data-k="pick"]', 'demo');
  await until(async () => (await pop.evaluate(() => window.agentDesk.state().chosen)) === 'demo', 'the pop-out shows demo');
  const pz = await control('agent-plan', { agent: 'demo', id: 'pz', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 16, target: 32, expire: 900, setup: 'Sample Z', reason: LONG, confidence: 0.6 });
  check(!pz.refused, 'a proposal for the pop-out: ' + (pz.refused || 'proposed'));
  const popOpen = await until(() => pop.evaluate(() => !!document.querySelector('.ag-plist .ag-prop[data-id="pz"]:not(.ag-ended)')), 'the pop-out shows demo\'s proposal', 8000);
  if (popOpen) {
    const PZ = '#agView .ag-plist .ag-prop[data-id="pz"] [data-agans]';
    for (const [w, h] of [[1366, 768], [1920, 1080], [390, 844]]) {
      await pop.setViewportSize({ width: w, height: h });
      await sleep(600);
      await toTop(pop, w < 720); await sleep(150);
      const bad = await hitTest(pop, PZ, true), seen = await inWindow(pop, PZ), st = await strays(pop), o = await others(pop);
      check(!bad.length && seen && !st.length && /Second Demo Agent: 1/.test(o.text) && o.h === 30,
        'the pop-out at ' + w + ' x ' + h + ': its Accept and Reject in the window and themselves, no other Accept or Reject, the line "' + o.text + '" at ' + o.h + ' px' + (bad.length ? ': ' + bad.slice(0, 4).join('; ') : st.length ? ': ' + st.join(', ') : ''));
      if (w === 1366) await pop.screenshot({ path: path.join(SHOTS, 'agent-targets-popout.png') });
    }
    await pop.setViewportSize({ width: 1366, height: 768 }); await sleep(300);
    await pop.click(LINE + ' [data-goto="agent:demotwo"]');
    const shownTwo = await until(async () => (await pop.evaluate(() => window.agentDesk.state().chosen)) === 'demotwo' && await pop.isVisible('#agView .ag-plist .ag-prop[data-agent="demotwo"]'), 'the pop-out shows the second agent');
    const o3 = await others(pop);
    check(!!shownTwo && /(^|· )Demo Agent: 1( proposal)?$/.test(o3.text) && !(await strays(pop)).length, 'the pop-out\'s line: the second agent\'s name shows it there, its proposal in the slot, the line "' + o3.text + '"');
  }
  await pop.close();
} catch (e) {
  fail('smoke stopped: ' + (e && e.stack || e));
} finally {
  bridge.kill();
  await browser.close();
}
console.log(errors.length ? '\n' + errors.length + ' of ' + checks + ' checks failed' : '\nall ' + checks + ' checks passed');
process.exit(errors.length ? 1 : 0);
