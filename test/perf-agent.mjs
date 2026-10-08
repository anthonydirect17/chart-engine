// R5 (docs/MOTION.md) for the Agent tab: the light (look F: the flowing border light) costs no frames while the agent is in a
// trade over a busy chart. The workspace on the Agent tab against the fake bridge's agent channel with a busy tape (sample
// data, the made-up "Demo Agent" and the made-up account SIM-AG1): the agent's entry fills, then MNQ trades at --live-rate
// while the light circles the chart and the P&L footer (9 s a lap, its colour following the open P&L). Measured as
// test/perf-bot.mjs does: each chart's own frame callback, all charts per frame, the frame intervals; once with Motion Full
// and with Motion Off on the same tape, taking turns (four rounds of each by default).
// Gates: a chart's frame p95 under 4 ms and all charts per frame p95 under 8 ms (the chart's own gates, README), and the
// light's cost: the frame interval p95 with Motion Full at most 4 ms over Motion Off's (review of fc3101a: the old light,
// a conic gradient painted again every frame with a blur, took Full's p95 to 66.7 ms against 16.8 ms Off at 1920 x 1080).
// Also: the light runs (sixteen strips on each lit panel: the line and the halo, each with its crossfade copy, on the chart and the footer) with Full and none with Off.
// Not part of `npm test` (about a minute).
//   node test/perf-agent.mjs [--secs=20] [--rounds=4] [--warm=6] [--live-rate=200] [--profit=100] [--size=1920x1080] [--port=8969] [--json=FILE]
//   npm run perf:agent       (CHROMIUM_PATH=/path/to/chrome uses a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, d) => { const a = process.argv.slice(2).find(x => x === '--' + name || x.startsWith('--' + name + '=')); return a === undefined ? d : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true; };
const SECS = +arg('secs', 20), WARM = +arg('warm', 6), LIVE_RATE = +arg('live-rate', 200), PROFIT = +arg('profit', 100);
const [W, H] = String(arg('size', '1920x1080')).split('x').map(Number);
const GATE = { chartP95: 4, allP95: 8, lightOverOffMs: 4 };
const free = p => new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
let PORT = +arg('port', 0);
if (!PORT) { PORT = 8969; while (!(await free(PORT))) PORT++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();

const init = `(() => {
  const P = window.__perf = { on: false, ts: [], charts: [], perFrame: [], long: [] };
  const now = () => performance.now();
  let creating = null, frameCost = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => {
    if (creating && !cb.__chartEl) cb.__chartEl = creating;
    const el = cb.__chartEl;
    return raf(ts => {
      if (!P.on || !el) return cb(ts);
      const t0 = now(); try { cb(ts); } finally { const dt = now() - t0; P.charts.push(dt); frameCost += dt; }
    });
  };
  const loop2 = ts => { if (P.on) { P.ts.push(ts); P.perFrame.push(frameCost); } frameCost = 0; raf(loop2); }; raf(loop2);
  let CE;
  Object.defineProperty(window, 'ChartEngine', { configurable: true, get() { return CE; }, set(v) {
    const create = v.create; v.create = function (el) { creating = el; try { return create.apply(this, arguments); } finally { creating = null; } };
    CE = v;
  } });
  try { new PerformanceObserver(l => { if (P.on) for (const e of l.getEntries()) P.long.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch (e) {}
})();`;
const q = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r3 = v => Math.round(v * 1000) / 1000;

const bridge = spawn(process.execPath, [path.join(here, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN,
  '--agents=demo', '--agent-any-time', '--live-rate=' + LIVE_RATE], { stdio: ['ignore', 'pipe', 'inherit'] });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let result = null; const failed = [];
try {
  await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await ctx.addInitScript(init);
  for (const u of ['chart-hotkeys', 'chart-strategies', 'chart-accounts']) await ctx.route('http://localhost:8800/api/' + u, r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: u === 'chart-accounts' ? '{"accounts":[]}' : u === 'chart-strategies' ? '{"rev":0,"strategies":[]}' : '{"rev":0,"keys":{},"modifiers":{}}' }));
  // only the Agent tab's chart: the workspace's layout has no panel (the Agent tab is measured, not the grid)
  await ctx.addInitScript(() => { try { localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: { Perf: { panels: [] } } })); localStorage.removeItem('live-agent-motion-v1'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/live/?layout=Perf&tab=agent`);
  await page.waitForSelector('.cb-pin-key', { timeout: 30000 });
  await enterPin(page, TEST_PIN);
  await page.waitForFunction(() => { const a = window.workspace && window.workspace.agent(); return a && a.signedIn && a.agents.length === 1; }, null, { timeout: 30000, polling: 200 });
  /* the agent in a trade: its entry placed (Copilot, accepted) and filled at a held price, then the tape runs */
  await control('price', { root: 'MNQ', p: 25400 });
  await control('agent-connect', { agent: 'demo', name: 'Demo Agent', build: 'sample-build-1' });
  await page.waitForFunction(() => { const a = window.workspace.agent(); return a && a.shown && a.agents.length === 1 && a.agents[0].connected; }, null, { timeout: 20000 });
  await page.click('#agView [data-act="acctOpen"]'); await page.selectOption('#agView [data-k="acctSel"]', 'SIM-AG1'); await page.click('#agView [data-act="acctSave"]');
  await page.waitForFunction(() => document.querySelector('.ag-strip [data-k="sAccount"]').textContent === 'SIM-AG1', null, { timeout: 10000 });
  await page.click('#agView [data-mode="copilot"]');
  await page.waitForFunction(() => document.querySelector('.ag-strip [data-k="modeChip"]').textContent === 'COPILOT', null, { timeout: 10000 });
  const plan = await control('agent-plan', { agent: 'demo', id: 'perf1', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 1200, target: 1200, expire: 900, setup: 'Sample perf', reason: 'Sample: a made-up plan to put the agent in a trade', confidence: 0.6 });
  if (plan.refused) throw new Error('the plan was refused: ' + plan.refused);
  await page.waitForSelector('.ag-plist .ag-prop [data-agans="accept"]', { timeout: 10000 });
  await sleep(1300);                                                           // on screen 1 s
  await page.click('.ag-plist [data-agans="accept"]');
  await page.waitForFunction(() => window.workspace.agent().orders.some(o => o.by === 'agent:demo' && o.role === 'entry'), null, { timeout: 10000 });
  await control('price', { root: 'MNQ', p: 25389.75 });                       // it fills
  await page.waitForFunction(() => { const a = window.workspace.agent().agents[0]; return a.position && a.position.qty === 1; }, null, { timeout: 10000 });
  /* --profit=points: where the tape starts above the entry (0: at the entry, so the open P&L crosses zero again and again and
     the light's colour fades between green and red; 100, the default: a trade well in profit, the light steady) */
  await control('price', { root: 'MNQ', p: 25390 + PROFIT });
  await control('hold', { root: 'MNQ', on: 0 });                              // the busy tape from here on
  await page.waitForFunction(() => { const l = window.workspace.agent().light; return l && l.phase === 'trade'; }, null, { timeout: 15000 });
  await page.waitForFunction(() => { const c = document.querySelector('#agView .ag-chart .badge, #agView .ag-chart [data-conn]'); return !c || c.dataset.conn === 'live'; }, null, { timeout: 30000, polling: 200 }).catch(() => null);
  if (arg('css', '')) await page.addStyleTag({ content: String(arg('css', '')) });   // an experiment: a style added (what costs what)
  await sleep(WARM * 1000);
  const lightNow = () => page.evaluate(() => { const by = {}; for (const a of document.getAnimations()) if (a.animationName === 'ag-orbit' && a.playState === 'running') { const p = a.effect.target.closest('[data-panel]').dataset.panel; by[p] = (by[p] || 0) + 1; } return by; });
  /* Full and Off take turns (ROUNDS rounds of SECS / ROUNDS seconds each), so a busier moment of the machine or of the tape
     falls on both alike; each mode's frames are pooled */
  const ROUNDS = Math.max(1, +arg('rounds', 4));
  const pool = { full: { ts: [], charts: [], perFrame: [], long: [], light: null }, off: { ts: [], charts: [], perFrame: [], long: [], light: null } };
  for (let r = 0; r < ROUNDS; r++) for (const motion of ['full', 'off']) {
    await page.click('#agView button[data-motion="' + motion + '"]');
    await sleep(800);
    const light = await lightNow();
    if (!pool[motion].light || Object.keys(light).length < Object.keys(pool[motion].light).length) pool[motion].light = light;
    await page.evaluate(() => { const p = window.__perf; p.ts = []; p.charts = []; p.perFrame = []; p.long = []; p.on = true; });
    await sleep(SECS * 1000 / ROUNDS);
    const P = await page.evaluate(() => { const p = window.__perf; p.on = false; return { ts: p.ts, charts: p.charts, perFrame: p.perFrame, long: p.long }; });
    const iv = []; for (let i = 1; i < P.ts.length; i++) iv.push(P.ts[i] - P.ts[i - 1]);
    const m = pool[motion]; m.ts.push(...iv); m.charts.push(...P.charts); m.perFrame.push(...P.perFrame); m.long.push(...P.long);
  }
  const sum = motion => { const m = pool[motion], iv = m.ts;
    return { motion, light: m.light, frames: iv.length, frameP50: r3(q(iv, 0.5)), frameP95: r3(q(iv, 0.95)), over33: iv.filter(d => d > 33.4).length, over50: iv.filter(d => d > 50).length,
      chartFrames: m.charts.length, chartP95: r3(q(m.charts, 0.95)), allChartsPerFrameP95: r3(q(m.perFrame, 0.95)), longTasks: m.long.length }; };
  const full = sum('full'), off = sum('off');
  await page.click('#agView button[data-motion="full"]');
  const state = await page.evaluate(() => { const a = window.workspace.agent(); return { phase: a.light && a.light.phase, lit: [...document.querySelectorAll('#agView .ag-panel.lit')].map(e => e.dataset.panel).sort().join(',') }; });
  result = { page: 'workspace, the Agent tab in a trade (MNQ 1 min, live), the light on the chart and the footer', size: W + 'x' + H, secs: SECS, liveRate: LIVE_RATE, state, full, off, lightCostP95: r3(full.frameP95 - off.frameP95), errors };
  for (const m of [full, off]) {
    if (!(m.chartFrames > SECS * 10)) failed.push('Motion ' + m.motion + ': the chart drew only ' + m.chartFrames + ' frames');
    if (m.chartP95 >= GATE.chartP95) failed.push('Motion ' + m.motion + ': chart frame p95 ' + m.chartP95 + ' ms (gate ' + GATE.chartP95 + ')');
    if (m.allChartsPerFrameP95 >= GATE.allP95) failed.push('Motion ' + m.motion + ': all charts per frame p95 ' + m.allChartsPerFrameP95 + ' ms (gate ' + GATE.allP95 + ')');
  }
  if (state.phase !== 'trade' || state.lit !== 'chart,pnl') failed.push('not in a trade with the chart and the footer lit: ' + JSON.stringify(state));
  if (full.light.chart !== 16 || full.light.pnl !== 16) failed.push('Motion Full: the light did not run on the chart and the footer: ' + JSON.stringify(full.light));
  if (Object.keys(off.light).length) failed.push('Motion Off: the light still ran: ' + JSON.stringify(off.light));
  if (full.frameP95 - off.frameP95 > GATE.lightOverOffMs) failed.push('the light costs frames: frame p95 ' + full.frameP95 + ' ms with Motion Full against ' + off.frameP95 + ' ms Off (gate: at most ' + GATE.lightOverOffMs + ' ms more)');
  if (errors.length) failed.push('page errors: ' + errors.join('; '));
} catch (e) {
  failed.push('stopped: ' + (e && e.stack || e));
} finally { await browser.close(); bridge.kill(); }
const json = arg('json', '');
if (json && result) fs.appendFileSync(json, JSON.stringify(result) + '\n');
console.log(JSON.stringify(result, null, 1));
console.log(failed.length ? 'FAILED: ' + failed.join('; ') : 'the gates hold: frame p95 ' + result.full.frameP95 + ' ms with the light, ' + result.off.frameP95 + ' ms without; chart p95 ' + result.full.chartP95 + ' ms, all charts ' + result.full.allChartsPerFrameP95 + ' ms');
process.exit(failed.length ? 1 : 0);
