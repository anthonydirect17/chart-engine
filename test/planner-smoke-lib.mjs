// Helpers for the planner's smokes (chart 1.62.0): test/planner-windows-smoke.mjs and test/planner-resume-smoke.mjs. The fake
// bridge (--v3, made-up accounts, sample data; nothing reaches a broker) and the fake Desk's plan log (test/fake-desk.mjs).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

export const LAYOUT = { v: 1, layouts: { Plan: { panels: [{ id: 'c1', type: 'chart', root: 'MNQ', tf: 'm1', x: 0, y: 0, w: 6, h: 6 }, { id: 'tk', type: 'ticket', x: 8, y: 0, w: 4, h: 6 }] } } };
export const wait = ms => new Promise(r => setTimeout(r, ms));
export function checker() {
  const errors = []; let checks = 0;
  const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
  const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
  const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };
  const done = name => { if (errors.length) { console.error('FAIL (' + errors.length + ' of ' + checks + ')\n' + errors.join('\n')); process.exit(1); } console.log(name + ': ok (' + checks + ' checks)'); };
  return { fail, check, until, done };
}
/** the fake bridge on `port`, with this PC's name and a PIN kept in a file (a restart keeps the page's unlock) */
export async function startBridge(root, port, deskPort, pinFile, extra) {
  const child = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port), '--v3', '--trading', '--test-controls', '--max-qty=MNQ:9,NQ:9', '--pc=TESTPC',
    '--test-pin=' + TEST_PIN, '--desk-url=http://127.0.0.1:' + deskPort].concat(pinFile ? ['--pin-file=' + pinFile] : [], extra || []), { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => child.stdout.once('data', r));
  return child;
}
/** every order action a page sends, in window.__sent (kept in sessionStorage too, so a reload keeps the count) */
export async function spyContext(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(l => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'cutHalf'].includes(m.type)) window.__sent.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
    try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify(l)); } catch (e) { /* blocked */ }
  }, LAYOUT);
  return ctx;
}
export async function openPage(ctx, port, fail) {
  const pg = await ctx.newPage();
  pg.on('pageerror', e => fail('pageerror: ' + e.message));
  await pg.goto(`http://localhost:${port}/live/?layout=Plan`);
  await livePage(pg);
  return pg;
}
export async function livePage(pg) {
  await Promise.race([pg.waitForSelector('.cb-pin-key', { timeout: 20000 }).then(() => enterPin(pg, TEST_PIN)), pg.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 20000 })]).catch(() => {});
  await pg.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 40000 });
  await pg.evaluate(() => { window.ChartEngine.util.cmeClosed = () => false; });   // CME open, whatever day the smoke runs
}
export const st = pg => pg.evaluate(() => window.workspace.planner());
export const card = s => `.pl-card [data-pl="${s}"]`;
/** the Plan tool (the ring's fifth button) on chart c1, then a click at `price`, right of the plan card */
export async function drawAt(pg, price, until) {
  const box = await pg.$eval('.ws-panel[data-id="c1"] canvas.ce-canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await pg.mouse.click(box.x + box.w * 0.45, box.y + box.h * 0.35, { button: 'middle' });
  await pg.click('#wsRing [data-ring="plan"]');
  await until(() => pg.evaluate(pr => { const c = window.workspace.chart('c1'), s = c.priceScale(), y = c.priceToY(pr); return !s.target || (Math.abs(s.lo - s.target.lo) < 1 && Math.abs(s.hi - s.target.hi) < 1) ? y > 20 && y < s.plotHeight - 20 : false; }, price), 'the price scale shows ' + price, 8000);
  const y = await pg.evaluate(pr => window.workspace.chart('c1').priceToY(pr), price);
  await pg.mouse.click(box.x + box.w * 0.72, box.y + y);
}
export const orders = pg => pg.evaluate(() => window.__sent.filter(m => m.type === 'order'));
