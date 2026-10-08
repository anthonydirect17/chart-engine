// The Agent tab's Accept and Reject (chart 1.17.0, live/agent.js) are order-path targets: Anthony accepts or rejects an
// agent's proposal there. After the review of fc3101a this smoke holds them, in the workspace and the pop-out, against the
// fake bridge with two made-up agents ("Demo Agent", "Second Demo Agent") and the made-up bot (sample data only):
//   - never covered: with the shown agent's proposal open in the tab while the second agent AND the bot have proposals open,
//     document.elementFromPoint at the centre and the four corners of the tab's Accept and Reject finds the button itself,
//     at 1366 x 768, 1600 x 900, 1440 x 1000, 1920 x 1080 and 390 x 844 (and at 1000 x 800 with notices showing); the other
//     proposals show in the proposal panel under their own names, their own buttons reachable too; the same in the pop-out;
//   - never dropped: the focus stays on Reject over several renders, a press held across a render still clicks, and ordinary
//     clicks all arrive (the list is written only when it changed);
//   - ChartBridge's words for a proposal (the last 5 s, a long refusal) in sight in the sticky foot, right above the buttons;
//   - never moving: the workspace's ChartBridge line coming and going moves no Accept, and an ended card's time running out
//     moves no open card after it; a new proposal right after an ended one never jumps up;
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
const SIZES = [[1366, 768], [1600, 900], [1440, 1000], [1920, 1080], [390, 844]];

/* the hit test, in the page: for each button, its centre and four corners (3 px in) must find the button itself; a button out
   of its scroll box's sight is brought into sight first (a phone: the tab scrolls) */
const hitTest = (page, sel) => page.evaluate(sel => {
  const out = [];
  for (const b of document.querySelectorAll(sel)) {
    if (!b.offsetParent) { out.push(b.dataset.agans + ': not shown'); continue; }
    b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
}, sel);
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

  /* ---------------------------------------------------------------- nothing covers the tab's Accept and Reject */
  console.log('the tab\'s Accept and Reject while the second agent and the bot have proposals open');
  await control('agent-plan', { agent: 'demotwo', id: 'q2', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 16, target: 32, expire: 900, setup: 'Sample Q', reason: LONG, confidence: 0.6 });
  await control('bot-connect', { name: 'Sample Lantern Fade' });
  await control('bot-proposal', { id: 'b1', side: 'sell', kind: 'market', stop: 12, target: 24, reason: 'Sample: the made-up bot\'s signal' });
  await control('agent-plan', { agent: 'demo', id: 'pa', side: 'buy', kind: 'limit', p: 25390, qty: 2, stop: 16, target: 32, expire: 900, setup: 'Sample A', reason: LONG, confidence: 0.6 });
  await until(() => page.isVisible('.ag-plist .ag-prop[data-id="pa"]'), 'demo\'s proposal in the tab');
  await until(() => page.evaluate(() => !!document.querySelector('.ag-prop.corner[data-id="q2"]:not([hidden])') && !!document.querySelector('.bt-prop[data-id="b1"]')), 'the second agent\'s and the bot\'s proposals show too');
  const TAB = '#agView .ag-plist .ag-prop[data-id="pa"] [data-agans]';
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(700);
    const bad = await hitTest(page, TAB);
    check(!bad.length, 'at ' + w + ' x ' + h + ' the centre and corners of the tab\'s Accept and Reject are the buttons themselves' + (bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''));
    const others = await page.evaluate(() => {
      const two = document.querySelector('.ag-prop.corner[data-id="q2"]'), bot = document.querySelector('.bt-prop[data-id="b1"]'), panel = document.querySelector('#agView [data-panel="prop"]');
      return { two: !!two && panel.contains(two) && !two.hidden, bot: !!bot && panel.contains(bot), name: two ? two.querySelector('.ag-prop-h').textContent : '', botName: bot ? bot.querySelector('.bt-prop-h').textContent : '' };
    });
    check(others.two && others.bot && /Second Demo Agent/.test(others.name) && /Sample Lantern Fade/.test(others.botName),
      'at ' + w + ' x ' + h + ' the second agent\'s and the bot\'s proposals are in the proposal panel, under their own names: ' + JSON.stringify(others));
    const theirs = await hitTest(page, '#agView .ag-prop.corner[data-id="q2"] [data-agans], #agView .bt-prop[data-id="b1"] [data-ans]');
    check(!theirs.length, 'at ' + w + ' x ' + h + ' their own Accept and Reject are reachable and covered by nothing' + (theirs.length ? ': ' + theirs.slice(0, 4).join('; ') : ''));
    const again = await hitTest(page, TAB);
    check(!again.length, 'at ' + w + ' x ' + h + ' and the tab\'s own again after scrolling to them' + (again.length ? ': ' + again.slice(0, 4).join('; ') : ''));
    if (w === 1366 || w === 390) await page.screenshot({ path: path.join(SHOTS, 'agent-targets-' + w + '.png'), fullPage: w === 390 });
  }
  /* notices showing: stacked in the chart, never over a button (at 1100 px and narrower too) */
  for (const [w, h] of [[1366, 768], [1000, 800], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(600);
    await notices(page, 4);
    await sleep(100);
    const bad = await hitTest(page, TAB + ', #agView .ag-prop.corner[data-id="q2"] [data-agans], #agView .bt-prop[data-id="b1"] [data-ans]');
    const inChart = await page.evaluate(() => { const c = document.querySelector('#agView [data-panel="chart"]').getBoundingClientRect(); return [...document.querySelectorAll('.ag-note')].every(n => { const r = n.getBoundingClientRect(); return r.height === 0 || (r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1); }); });
    check(!bad.length && inChart, 'at ' + w + ' x ' + h + ' with four notices showing, they sit in the chart panel and no Accept or Reject is under one' + (bad.length ? ': ' + bad.slice(0, 4).join('; ') : inChart ? '' : ': a notice outside the chart panel'));
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
  const inSight = id => page.evaluate(id => {
    const card = document.querySelector('.ag-plist .ag-prop[data-id="' + id + '"]'), box = document.querySelector('#agView .ag-pbody').getBoundingClientRect();
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

  /* ---------------------------------------------------------------- the pop-out (agent.html) */
  console.log('the pop-out: the same');
  const pop = await ctx.newPage();
  pop.on('pageerror', e => fail('pop-out error: ' + e.message));
  await pop.goto(`http://localhost:${PORT}/live/agent.html`);
  if (await pop.waitForSelector('.cb-pin-key', { timeout: 5000 }).catch(() => null)) await enterPin(pop, TEST_PIN);
  await pop.waitForFunction(() => window.agentDesk && window.agentDesk.state().agents.length === 2, null, { timeout: 20000 });
  await pop.selectOption('#agView [data-k="pick"]', 'demo');
  const pz = await control('agent-plan', { agent: 'demo', id: 'pz', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 16, target: 32, expire: 900, setup: 'Sample Z', reason: LONG, confidence: 0.6 });
  check(!pz.refused, 'a proposal for the pop-out: ' + (pz.refused || 'proposed'));
  const popOpen = await until(() => pop.evaluate(() => !!document.querySelector('.ag-plist .ag-prop:not(.ag-ended)') && !!document.querySelector('.ag-prop.corner:not([hidden]):not(.ag-ended)')), 'the pop-out shows demo\'s proposal and the second agent\'s', 8000);
  if (popOpen) {
    for (const [w, h] of [[1366, 768], [1920, 1080], [390, 844]]) {
      await pop.setViewportSize({ width: w, height: h });
      await sleep(600);
      const bad = await hitTest(pop, '#agView .ag-plist .ag-prop:not(.ag-ended) [data-agans]');
      const inPanel = await pop.evaluate(() => { const c = document.querySelector('.ag-prop.corner:not([hidden])'); return !!c && document.querySelector('#agView [data-panel="prop"]').contains(c); });
      check(!bad.length && inPanel, 'the pop-out at ' + w + ' x ' + h + ': its Accept and Reject are covered by nothing, the second agent\'s proposal in the panel' + (bad.length ? ': ' + bad.slice(0, 4).join('; ') : inPanel ? '' : ': it sits in the corner'));
      if (w === 1366) await pop.screenshot({ path: path.join(SHOTS, 'agent-targets-popout.png') });
    }
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
