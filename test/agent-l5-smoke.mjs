// The Agent tab's Layout 5 (chart 1.23.0, DECISION 2026-10-14a): what the parity test (test/agent-parity-smoke.mjs) does not
// cover, against the fake bridge with the made-up "Demo Agent", the made-up account SIM-AG1 and made-up prices, notes and plans
// (sample data only):
//   - one screen with no page scroll at 1366 x 768, 1600 x 900 and 1920 x 1080, the chart about 60 % of the centre column,
//     Accept and Reject in the window; nothing rezzes in (no animation but the light on load);
//   - the grid: each step's words are today's tracker words with how long ago, a step with nothing yet says nothing, the
//     decision is the newest plan; its canvas draws at most 30 frames a second at most 1.5 device pixels per CSS pixel, and
//     is paused (no frame loop) with Motion Off, with the system's reduced motion and while the tab is closed; a plan arriving
//     fires its orange beam;
//   - Maximize: the button, a double click on the chart's head bar (not in the chart: that is the chart's own), Escape only
//     with the focus inside the chart's panel; the chart takes the centre column, its strip shows the eight figures, and the
//     kill switch, the mode, Accept and Reject neither move nor get covered;
//   - his figures from real data: heat at his own stop in a trade, the risk if accepted, Session R and the R curve from the
//     plan's riskDollars after the trade ends;
//   - ChartBridge's words above Accept and Reject (the last 5 s, "Accept sent.", a long refusal) move them 0 px at 1366 x 768,
//     1600 x 900, 1920 x 1080 and in the pop-out, and a real proposal's last 5 s too (review of 84893d0);
//   - the controls column cuts no line off at those sizes: the Rules card scrolls inside itself with "more below", its lines
//     keep a floor of height at each size, and Change the rules (in its header) is in sight without scrolling (review of #43);
//   - the smaller screens keep board F's stacking (1000 x 800 and 390 x 844).
//   npm run smoke:agent-l5   (CHROMIUM_PATH=/path/to/chrome; SHOTS=dir)
// Screenshots (test/out): agent-l5-1366x768, -1600x900, -1920x1080, -max, -narrow (1000 x 800), -phone (390 x 844),
// -proposal (a proposal open with Accept and Reject), -drawer (a stream row's drawer open).
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
async function until(fn, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t0 > ms) { fail('timed out: ' + what); return null; } await sleep(150); }
}
const free = p => new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
let port = +(process.env.AGENT_L5_PORT || 0) || 9041;
while (!(await free(port))) port++;
/* the smoke's clock: 11:00 New York whatever the time of day (as the other agent smokes), so his session trail holds */
const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const OFFSET_S = (() => { const o = {}, now = Date.now(); for (const x of NY.formatToParts(new Date(now))) o[x.type] = +x.value || 0;
  return Math.round((Date.UTC(o.year, o.month - 1, o.day, 11, 0, 0) - Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second)) / 1000); })();
const control = async (what, q) => (await fetch(`http://127.0.0.1:${port}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const H = id => '[data-parity~="' + id + '"]';
const DESK_KEYS = { rev: 3, keys: { buy: '', sell: '', be: '', close: '', flattenAll: '', merge: '', maximize: '', accept: 'Alt+Y', reject: 'Alt+N' }, modifiers: { limit: '', stop: '' } };

const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN, '--clock-offset=' + OFFSET_S,
  '--agents=demo', '--agent-any-time', '--max-qty=MNQ:20,NQ:2'], { stdio: ['ignore', 'pipe', 'inherit'] });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(off => { const Real = Date; class Shifted extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + off); } static now() { return Real.now() + off; } } window.Date = Shifted; }, OFFSET_S * 1000);
  for (const u of ['chart-hotkeys', 'chart-strategies', 'chart-accounts']) await ctx.route('http://localhost:8800/api/' + u, r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: u === 'chart-accounts' ? '{"accounts":[]}' : u === 'chart-strategies' ? '{"rev":0,"strategies":[]}' : JSON.stringify(DESK_KEYS) }));
  /* the AgentDesk the workspace creates, as the parity test finds it */
  await ctx.addInitScript(() => { let AD = null; Object.defineProperty(window, 'AgentDesk', { configurable: true, get: () => AD, set: v => {
    AD = v; if (v && typeof v.create === 'function' && !v.create.__spy) { const c = v.create; v.create = function () { const d = c.apply(this, arguments); window.__desk = d; return d; }; v.create.__spy = true; } } }); });
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  page.on('dialog', d => { fail('a browser dialog: ' + d.message()); d.dismiss(); });
  await page.goto(`http://localhost:${port}/live/?layout=Main`);
  if (await page.waitForSelector('.cb-pin-key', { timeout: 15000 }).catch(() => null)) await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  const A = () => page.evaluate(() => window.workspace.agent());
  const L5 = () => page.evaluate(() => window.__desk.layout5());
  const text = sel => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
  const box = sel => page.evaluate(s => { const e = document.querySelector(s); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }, sel);
  const hit = ids => page.evaluate(ids => { const out = []; for (const id of ids) { const b = document.querySelector('[data-parity~="' + id + '"]'); if (!b) { out.push(id + ' missing'); continue; } const r = b.getBoundingClientRect();
    for (const [x, y] of [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 3, r.top + 3], [r.right - 3, r.bottom - 3]]) { const h = document.elementFromPoint(x, y); if (!h || !(h === b || b.contains(h))) out.push(id + ' covered at ' + Math.round(x) + ',' + Math.round(y)); }
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) out.push(id + ' out of the window'); } return out; }, ids);
  const fits = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, w: innerWidth, h: innerHeight }));
  /* ChartBridge's words right above Accept and Reject (P14) never move them (review of 84893d0: the last 5 s wrapped to a second
     line and moved them 8 to 12 px): each of these, written where the page writes it, moves them 0 px */
  const WORDS = ['Under 5 s left: too late to accept. Reject still goes.', 'Accept sent. Waiting for ChartBridge.',
    'Refused by ChartBridge: SIM-AG1 is not allowed to trade (the account is not checked in config.txt), and this made-up refusal goes on long enough to need three lines in the card.'];
  const accBox = pg => pg.evaluate(() => ['P15', 'P16'].map(id => { const e = document.querySelector('[data-parity~="P03"]:not([data-parity~="P17"]) [data-parity~="' + id + '"]'); if (!e) return id + ':-'; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(v => Math.round(v * 10) / 10).join(','); }).join(' '));
  async function wordsMoveNothing(pg, label) {
    const b0 = await accBox(pg), out = [];
    for (const t of WORDS) {
      await pg.evaluate(t => { document.querySelector('[data-parity~="P03"]:not([data-parity~="P17"]) [data-parity~="P14"]').textContent = t; }, t);
      await pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const b = await accBox(pg); if (b !== b0) out.push('"' + t.slice(0, 24) + '...": ' + b0 + ' -> ' + b);
    }
    await pg.evaluate(() => { document.querySelector('[data-parity~="P03"]:not([data-parity~="P17"]) [data-parity~="P14"]').textContent = ''; });
    check(!out.length && !/-/.test(b0.replace(/,-/g, ',')), label + ': the last 5 s, "Accept sent." and a long refusal above Accept and Reject move them 0 px' + (out.length ? ': ' + out.join('; ') : ' (' + b0 + ')'));
  }
  /* the controls column cuts no line off: it fits, and the Rules card's lines scroll inside it with "more below" when they are more.
     Its lines keep at least `minH` px (the review of #43: 69 px at 1366 x 768; a squeeze below that fails here), and Change the
     rules (LR02, in the card's header) is in sight without scrolling anything, nothing over it */
  async function leftFits(label, minH) {
    const x = await page.evaluate(() => { const c = document.querySelector('.ag-left .ag-scroll'), b = document.querySelector('[data-k="rbody"]'), m = b.querySelector('.ag-rmore');
      c.scrollTop = 0; b.scrollTop = 0;
      const o = document.querySelector('[data-parity~="LR02"]'), r = o.getBoundingClientRect(), cr = c.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const lr02 = !!o.closest('.ag-rulescard > .ag-sechead') && r.height >= 20 && r.top >= Math.max(0, cr.top) - 1 && r.bottom <= Math.min(innerHeight, cr.bottom) + 1 && r.right <= Math.min(innerWidth, cr.right) + 1 && !!at && o.contains(at);
      return { col: c.scrollHeight - c.clientHeight, over: b.scrollHeight - b.clientHeight, more: getComputedStyle(m).display !== 'none', h: b.clientHeight, lr02 }; });
    let end = { more: false, last: true };
    if (x.over > 2) end = await page.evaluate(async () => { const b = document.querySelector('[data-k="rbody"]'); b.scrollTop = b.scrollHeight; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const br = b.getBoundingClientRect(), l = [...b.children].filter(e => !e.classList.contains('ag-rmore') && e.getClientRects().length).pop(); const lr = l ? l.getBoundingClientRect() : null;
      const r = { more: getComputedStyle(b.querySelector('.ag-rmore')).display !== 'none', last: !!lr && lr.bottom <= br.bottom + 1 }; b.scrollTop = 0; return r; });
    check(x.col <= 1 && x.h >= minH && (x.over <= 2 ? !x.more : x.more && !end.more && end.last), label + ': the controls column fits (nothing cut off); the Rules card\'s lines ' + x.h + ' px (at least ' + minH + '), ' + (x.over <= 2 ? 'all shown' : 'scrolling inside it with "more below", gone at its end where its last line is in sight') + ' ' + JSON.stringify(Object.assign(x, { end })));
    check(x.lr02, label + ': Change the rules (LR02) in the Rules card\'s header, in sight without scrolling, nothing over it');
  }

  await control('price', { root: 'MNQ', p: 25400 });
  await control('agent-connect', { agent: 'demo', name: 'Demo Agent', build: 'sample-build-1' });
  await until(async () => (await A()).agents.length === 1, 'ChartBridge told of demo');
  await page.evaluate(() => { window.__anims = []; const b = document.getElementById('wsAgentTab'); b.addEventListener('click', () => requestAnimationFrame(() => { window.__anims = document.getAnimations().map(a => a.animationName || a.transitionProperty || 'other'); })); });
  await page.click('#wsAgentTab');
  await until(async () => (await A()).shown, 'the tab opens');
  check(await page.evaluate(() => !!window.__desk && typeof window.__desk.layout5 === 'function'), 'the AgentDesk API has layout5()');
  const anims = await page.evaluate(() => window.__anims);
  check(anims.every(n => n === 'ag-orbit'), 'nothing rezzes in when the tab opens: the only animations are the light\'s (' + [...new Set(anims)].join(',') + ')');
  /* his own account and Copilot */
  await page.click(H('LA04')); await page.selectOption(H('LA05-sel'), 'SIM-AG1'); await page.click(H('LA05-set'));
  await until(async () => (await text(H('ST07'))).includes('SIM-AG1'), 'demo trades SIM-AG1');
  await until(async () => !(await page.evaluate(() => document.querySelector('[data-parity~="LM02-copilot"]').disabled)), 'Copilot open', 8000);
  await page.click(H('LM02-copilot'));
  await until(async () => (await text(H('ST06'))) === 'COPILOT', 'Copilot');

  /* ------------------------------------------------------------------ the grid's words */
  console.log('the grid: today\'s tracker words and how long ago; a step with nothing says nothing');
  const steps = () => page.evaluate(() => [...document.querySelectorAll('.ag-step')].map(li => ({ words: li.querySelector('[data-k="words"]').textContent, age: li.querySelector('[data-k="age"]').textContent })));
  let st = await steps();
  check(st[0].words === 'Watching' && st.slice(1).every(s => s.words === '' && s.age === ''), 'at first only Screen says "Watching"; the other steps say nothing: ' + JSON.stringify(st));
  await control('agent-note', { agent: 'demo', kind: 'look', text: 'Sample: a made-up look' });
  await control('agent-note', { agent: 'demo', kind: 'thinking', text: 'Sample: made-up thinking' });
  await until(async () => (await steps())[2].words === 'Thinking', 'Judgment says Thinking');
  st = await steps();
  check(st[1].words === 'A look' && /^\d+s$/.test(st[1].age) && st[2].words === 'Thinking' && /^\d+s$/.test(st[2].age) && st[3].words === '' && st[0].words === '', 'Eyes "A look" and Judgment "Thinking" with their ages, Checks nothing, Screen nothing once a newer step is lit: ' + JSON.stringify(st));
  check((await text('[data-k="decT"]')) === 'No plan yet today', 'the decision with no plan: "No plan yet today"');
  check((await page.evaluate(() => [...document.querySelectorAll('.ag-step')].map(li => li.textContent).join(' '))).match(/\d+(\.\d+)?%|score/i) === null, 'no scores on the steps');

  /* ------------------------------------------------------------------ the canvas: 30 frames a second at most, paused when it should be */
  console.log('the grid canvas: its pace and its pauses');
  const g0 = (await L5()).grid; await sleep(2000); const g1 = (await L5()).grid;
  const fps = (g1.frames - g0.frames) / 2;
  check(g1.running && fps <= 31 && fps >= 5 && g1.dpr <= 1.5, 'Motion Full: it runs at ' + fps + ' frames a second (at most 30), pixel ratio ' + g1.dpr);
  const cv = await page.evaluate(() => { const c = document.querySelector('[data-k="gridcv"]'); return { w: c.width, cw: c.clientWidth, h: c.height, ch: c.clientHeight }; });
  check(cv.w <= Math.ceil(cv.cw * 1.5) + 1 && cv.cw > 100, 'the canvas at most 1.5 device pixels per CSS pixel: ' + JSON.stringify(cv));
  await page.click(H('ST13-off'));
  await sleep(300); const o0 = (await L5()).grid; await sleep(1500); const o1 = (await L5()).grid;
  check(!o1.running && o1.frames - o0.frames <= 1, 'Motion Off: no frame loop (one still frame at most): ' + (o1.frames - o0.frames));
  await page.click(H('ST13-full'));
  await until(async () => (await L5()).grid.running, 'Full again: it runs');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await sleep(300); const r0 = (await L5()).grid; await sleep(1200); const r1 = (await L5()).grid;
  check(!r1.running && r1.frames - r0.frames <= 1, 'the system\'s reduced motion: no frame loop: ' + (r1.frames - r0.frames));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await until(async () => (await L5()).grid.running, 'it runs again');
  await page.click('#wsAgentTab');
  await until(async () => !(await A()).shown, 'the tab closed');
  await sleep(500); const h0 = (await L5()).grid; await sleep(1200); const h1 = (await L5()).grid;
  check(!h1.running && h1.frames === h0.frames, 'the tab closed: no frame loop and no frame: ' + JSON.stringify({ running: h1.running, frames: h1.frames - h0.frames }));
  await page.click('#wsAgentTab');
  await until(async () => (await A()).shown && (await L5()).grid.running, 'the tab again: it runs');
  /* the pixel ratio stays at most 1.5 on a screen of 2 */
  await page.evaluate(() => Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => 2 }));
  await page.setViewportSize({ width: 1601, height: 900 }); await sleep(500);
  const cv2 = await page.evaluate(() => { const c = document.querySelector('[data-k="gridcv"]'); return { w: c.width, cw: c.clientWidth }; });
  check(cv2.w <= Math.ceil(cv2.cw * 1.5) + 1 && (await L5()).grid.dpr === 1.5, 'a screen of 2 device pixels: the canvas at 1.5: ' + JSON.stringify(cv2));
  await page.evaluate(() => delete window.devicePixelRatio);
  await page.setViewportSize({ width: 1600, height: 900 }); await sleep(400);

  /* ------------------------------------------------------------------ a proposal: the decision, the orange beam, if accepted */
  console.log('a plan: the decision, the beam, the risk if accepted');
  await control('agent-plan', { agent: 'demo', id: 'l5a', side: 'buy', kind: 'limit', p: 25390, qty: 2, stop: 16, target: 32, expire: 900, setup: 'Sample pullback', reason: 'Sample: a made-up reason for the made-up plan.', confidence: 0.62 });
  await until(async () => page.isVisible(H('P15')), 'the proposal');
  check((await L5()).grid.fired, 'a plan arriving fires the grid\'s orange beam');
  check((await text('[data-k="decT"]')) === 'Buy 2 MNQ · Sample pullback' && /waiting for you$/.test(await text('[data-k="decR"]')) && await page.evaluate(() => document.querySelector('[data-k="decision"]').classList.contains('act')), 'the decision: the newest plan, waiting for you (orange): ' + await text('[data-k="decR"]'));
  check((await text('[data-k="heat"]')) === '$0.00 · $16.00', 'heat flat $0.00, if accepted his proposal\'s risk: ' + await text('[data-k="heat"]'));
  check((await text('[data-k="hR"]')) === '0.00 R', 'Session R with no trade: 0.00 R');
  await sleep(1200);
  await page.screenshot({ path: path.join(SHOTS, 'agent-l5-proposal.png') });

  /* ------------------------------------------------------------------ the PC sizes: one screen, no scroll */
  for (const [w, h, minH] of [[1366, 768, 66], [1600, 900, 116], [1920, 1080, 280]]) {
    await page.setViewportSize({ width: w, height: h }); await sleep(700);
    const f = await fits(), c = await box(H('SS-centre')), ch = await box('[data-panel="chart"]'), foot = await box(H('SS-foot')), bad = await hit(['P15', 'P16', 'LM04']);
    const share = ch.height / c.height;
    check(f.sw <= f.w && f.sh <= f.h && foot.bottom <= h + 1 && share >= 0.52 && share <= 0.68 && !bad.length,
      w + ' x ' + h + ': one screen with no page scroll, the chart ' + Math.round(share * 100) + ' % of the centre, Accept, Reject and the kill switch in sight' + (bad.length ? ': ' + bad.join('; ') : '') + ' ' + JSON.stringify(f));
    await wordsMoveNothing(page, w + ' x ' + h);
    await leftFits(w + ' x ' + h, minH);
    await page.screenshot({ path: path.join(SHOTS, 'agent-l5-' + w + 'x' + h + '.png') });
  }
  await page.setViewportSize({ width: 1600, height: 900 }); await sleep(500);

  /* ------------------------------------------------------------------ Maximize */
  console.log('Maximize: the button, a double click on the chart\'s head, Escape only inside the chart\'s panel');
  const still = () => page.evaluate(() => ['P15', 'P16', 'LM04', 'LM02-shadow', 'OH03'].map(id => { const e = document.querySelector('[data-parity~="' + id + '"]'); if (!e || !e.getClientRects().length) return id + ':-'; const r = e.getBoundingClientRect(); return id + ':' + [r.left, r.top, r.width, r.height].map(Math.round).join(','); }).join(' '));
  /* a double click on the head bar's empty middle (between the chart's selects and its position) */
  const dblHead = async () => { const f = await box('#agView .ag-charthead > .ag-fill'), hb = await box('#agView [data-k="charthead"]'); await page.mouse.dblclick(f.left + f.width / 2, hb.top + hb.height / 2); };
  const before = await still(), cBefore = await box(H('SS-centre'));
  await page.click('#agView [data-act="chartMax"]');
  await until(async () => (await L5()).max, 'maximized');
  const chMax = await box('[data-panel="chart"]'), strip = await page.evaluate(() => [...document.querySelectorAll('[data-k="cstrip"] > span')].map(s => s.firstChild.textContent.trim()));
  check(Math.abs(chMax.height - cBefore.height) <= 2 && !(await page.isVisible('[data-panel="pipe"]')) && (await text('#agView [data-act="chartMax"]')) === 'Restore' && (await page.getAttribute('#agView [data-act="chartMax"]', 'aria-pressed')) === 'true',
    'the button: the chart takes the whole centre column (' + Math.round(chMax.height) + ' of ' + Math.round(cBefore.height) + ' px), the grid makes way, the button says Restore');
  check(strip.join(',') === 'Position,Entry,Stop,Target,Open R,Session,Heat,Room', 'its strip: ' + strip.join(', ') + ': ' + await text('[data-k="cstrip"]'));
  check(/Entry 25,390\.00 \(proposed\)/.test(await text('[data-k="cstrip"]')) && /Stop 25,386\.00/.test(await text('[data-k="cstrip"]')) && /Target 25,398\.00/.test(await text('[data-k="cstrip"]')) && /Open R -/.test(await text('[data-k="cstrip"]')), 'the strip from real data: the proposal\'s entry, stop and target, no open R while flat');
  check((await still()) === before && !(await hit(['P15', 'P16', 'LM04'])).length, 'maximized: Accept, Reject, the kill switch, the mode and On neither moved nor are covered');
  check(await page.evaluate(() => getComputedStyle(document.querySelector('[data-k="cstrip"]')).transitionDuration.split(',').every(d => parseFloat(d) === 0) && !document.querySelector('[data-k="cstrip"]').getAnimations().length), 'the strip never animates (R3)');
  await page.screenshot({ path: path.join(SHOTS, 'agent-l5-max.png') });
  await page.click(H('C01')).catch(() => {});
  await page.focus(H('ST13-full'));
  await page.keyboard.press('Escape'); await sleep(300);
  check((await L5()).max, 'Escape with the focus outside the chart\'s panel leaves it maximized (no page-wide key handler)');
  await page.focus('#agView [data-act="chartMax"]');
  await page.keyboard.press('Escape');
  check(!!(await until(async () => !(await L5()).max, 'Escape inside restores')), 'Escape with the focus inside the chart\'s panel restores it');
  check((await still()) === before && await page.isVisible('[data-panel="pipe"]'), 'restored: the grid back, nothing else moved');
  await dblHead();
  check(!!(await until(async () => (await L5()).max, 'double click maximizes')), 'a double click on the chart\'s head bar maximizes');
  await dblHead();
  check(!!(await until(async () => !(await L5()).max, 'double click restores')), 'and again restores');
  const cvb = await box('[data-k="chart"] canvas');
  await page.mouse.dblclick(cvb.left + cvb.width / 2, cvb.top + cvb.height / 2); await sleep(300);
  check(!(await L5()).max, 'a double click inside the chart is the chart\'s own (it resets its view): no maximize');

  /* ------------------------------------------------------------------ the drawer */
  await page.locator(H('SM03')).first().click();
  await until(async () => page.isVisible(H('D01')), 'the drawer');
  check(!(await hit(['P15', 'P16'])).length, 'the drawer covers no Accept or Reject');
  await page.screenshot({ path: path.join(SHOTS, 'agent-l5-drawer.png') });
  await page.click(H('D03'));

  /* ------------------------------------------------------------------ a trade: heat at his stop, then R from the plan's risk */
  console.log('a trade: heat at his own stop; Session R and the R curve from the plan\'s riskDollars');
  await sleep(1200);
  await page.click(H('P15'));
  await until(async () => (await A()).orders.some(o => o.by === 'agent:demo' && o.role === 'entry'), 'his entry works');
  await control('price', { root: 'MNQ', p: 25389.75 });
  await until(async () => /Long 2 MNQ/.test(await text(H('ST09'))), 'long 2 MNQ', 15000);
  await until(async () => /^\$16\.00 · /.test(await text('[data-k="heat"]')), 'heat at his stop', 8000);
  check(/^\$16\.00 · -$/.test(await text('[data-k="heat"]')), 'in a trade: heat $16.00 (2 MNQ, 4 points to his stop), nothing to accept: ' + await text('[data-k="heat"]'));
  const risks = (await L5()).risks;
  check(Object.values(risks).some(x => x.risk === 16 && x.qty === 2 && x.agent === 'demo'), 'his entry\'s risk is the plan\'s own riskDollars, kept for the day: ' + JSON.stringify(risks));
  await page.click('#agView [data-act="chartMax"]'); await until(async () => (await L5()).max, 'maximized in the trade');
  await control('price', { root: 'MNQ', p: 25393 });
  await until(async () => /Open R \+0\.\d\d R/.test(await text('[data-k="cstrip"]')), 'open R', 10000);
  check(/Position Long 2 MNQ @ 25,390\.00/.test(await text('[data-k="cstrip"]')) && /Entry 25,390\.00/.test(await text('[data-k="cstrip"]')) && /Heat \$16\.00/.test(await text('[data-k="cstrip"]')), 'the strip in the trade: ' + await text('[data-k="cstrip"]'));
  await page.click('#agView [data-act="chartMax"]');
  await control('price', { root: 'MNQ', p: 25399 });
  await until(async () => /Flat/.test(await text(H('ST09'))), 'out at the target', 15000);
  await until(async () => (await text('[data-k="hR"]')) === '+2.00 R', 'Session R', 10000);
  const R = (await L5()).r;
  check((await text('[data-k="hR"]')) === '+2.00 R' && R.trades.length === 1 && R.trades[0].pnl === 32 && R.trades[0].risk === 16, 'out at the target: +$32.00 on a $16.00 plan is +2.00 R: ' + JSON.stringify(R.trades));
  check(await page.evaluate(() => !!document.querySelector('[data-k="rcurve"] polyline')) && (await text('[data-k="heat"]')) === '$0.00 · -', 'the R curve draws his trade; flat again, heat $0.00');

  /* ------------------------------------------------------------------ the last 5 s for real, and the pop-out */
  console.log('the last 5 s of a real proposal, and the pop-out: Accept and Reject never move');
  await control('agent-plan', { agent: 'demo', id: 'l5late', side: 'sell', kind: 'limit', p: 25410, qty: 1, stop: 20, target: 40, expire: 900, setup: 'Sample late', reason: 'Sample: a made-up plan that runs out.' });
  await until(async () => page.isVisible(H('P15')), 'a proposal for the last 5 s');
  await sleep(600);
  const [pop] = await Promise.all([ctx.waitForEvent('page'), page.click(H('ST14'))]);
  pop.on('pageerror', e => fail('pop-out error: ' + e.message));
  await pop.waitForLoadState();
  if (await pop.waitForSelector('.cb-pin-key', { timeout: 5000 }).catch(() => null)) await enterPin(pop, TEST_PIN);
  await pop.waitForFunction(() => !!document.querySelector('[data-parity~="P03"] [data-parity~="P15"]'), null, { timeout: 20000 }).catch(() => fail('the pop-out shows no proposal'));
  for (const [w, h] of [[1366, 768], [1600, 900], [1920, 1080]]) { await pop.setViewportSize({ width: w, height: h }); await sleep(500); await wordsMoveNothing(pop, 'the pop-out at ' + w + ' x ' + h); }
  await pop.close();
  await page.setViewportSize({ width: 1600, height: 900 }); await sleep(500);
  const lateB0 = await accBox(page);
  await control('agent-expire', { agent: 'demo', id: 'l5late', ms: 4000 });
  await until(async () => /too late to accept/.test(await text(H('P14'))), 'under 5 s left');
  const lateB1 = await accBox(page);
  check(lateB1 === lateB0 && /^Under 5 s left/.test(await text(H('P14'))), '1600 x 900, a real proposal in its last 5 s: its words above the buttons and Accept and Reject 0 px moved (' + lateB0 + ' / ' + lateB1 + ')');
  await until(async () => !(await page.$('[data-parity~="P03"]')), 'the expired card goes', 12000);

  /* ------------------------------------------------------------------ the smaller screens keep board F's stacking */
  for (const [w, h, name] of [[1000, 800, 'narrow'], [390, 844, 'phone']]) {
    await page.setViewportSize({ width: w, height: h }); await sleep(800);
    await page.evaluate(() => { window.scrollTo(0, 0); for (const b of document.querySelectorAll('[data-parity~="view"] *')) if (b.scrollTop) b.scrollTop = 0; });
    const f = await fits(), Lb = await box(H('SS-controls')), Rb = await box(H('SS-right')), Cb = await box(H('SS-centre'));
    const ok = w > 720 ? Math.abs(Lb.top - Rb.top) <= 1 && Cb.top >= Math.max(Lb.bottom, Rb.bottom) - 1 : Lb.bottom <= Rb.top + 1 && Rb.bottom <= Cb.top + 1;
    /* the tab itself never runs past the window (at 1000 px the workspace's own top bar does, on main as well: not the tab's; the
       light's gradients are larger than their strips by design and clipped inside them) */
    const wide = await page.evaluate(() => [...document.querySelectorAll('#agView *')].filter(e => e.getClientRects().length && !e.closest('.ag-scroll, .ag-feed, .ag-slot, .ag-tray, .ag-light') && e.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map(e => (e.dataset.parity || e.className || e.tagName) + '@' + Math.round(e.getBoundingClientRect().right)));
    check(!wide.length && ok && (w > 720 || f.sw <= f.w), w + ' x ' + h + ': board F\'s stacking, nothing of the tab past the window ' + JSON.stringify(f) + (wide.length ? ' wider: ' + wide.join(', ') : ''));
    await page.screenshot({ path: path.join(SHOTS, 'agent-l5-' + name + '.png') });
  }
} catch (e) {
  fail('smoke stopped: ' + (e && e.stack || e));
} finally {
  await browser.close();
  bridge.kill();
}
console.log(errors.length ? '\n' + errors.length + ' of ' + checks + ' checks failed' : '\nall ' + checks + ' checks passed');
process.exit(errors.length ? 1 : 0);
