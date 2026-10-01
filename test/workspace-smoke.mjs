// Workspace smoke test (live/workspace.html) against the fake bridge, in Chromium: the default layout's 5 panels, drag
// and resize snapping to cells, an overlap refused, add and close, the layout kept over a reload, ?layout=Second as a
// separate layout, New layout / Rename / Delete, the Time and Sales tape (newest first, sides, large prints), only
// read-only messages sent, and a window resize keeping every panel on screen. Sample data only.
// Screenshots in test/out/ (and SHOTS_DIR when set) at 1920x1080, 2560x1440 and 1366x768.
//   npm run smoke:workspace        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PORT = +(process.env.WORKSPACE_SMOKE_PORT || 8814);
const URL0 = `http://localhost:${PORT}/live/workspace.html`;
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
async function shot(page, name) {
  const file = path.join(out, name);
  await page.screenshot({ path: file });
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, name));
}
const control = async what => (await fetch(`http://127.0.0.1:${PORT}/test/${what}`, { method: 'POST' })).json();

/* Before any page script: record every WebSocket and what it sends. */
function spies() {
  const S = window.__spy = { sockets: [] };
  const Real = window.WebSocket;
  function Spy(url, protocols) {
    const sock = protocols === undefined ? new Real(url) : new Real(url, protocols);
    const rec = { url: String(url), sent: [] };
    const send = sock.send.bind(sock);
    sock.send = d => { rec.sent.push(d); return send(d); };
    S.sockets.push(rec);
    return sock;
  }
  Spy.prototype = Real.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
  window.WebSocket = Spy;
}

const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--test-controls', '--live-rate=150', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(spies);
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));

  /* Open a URL, type the PIN on ChartBridge's pad (the page's own origin needs it, like the standalone page), wait for live. */
  async function open(url) {
    await page.goto(url);
    await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
    await enterPin(page, TEST_PIN);
    await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  }
  const state = () => page.evaluate(() => ({ layout: window.workspace.layout, panels: window.workspace.panels(), views: window.workspace.views(), search: location.search }));
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('workspace:live-workspace-v1')));
  const box = id => page.evaluate(i => { const r = document.querySelector(`.ws-panel[data-id="${i}"]`).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, id);
  const head = id => page.evaluate(i => { const r = document.querySelector(`.ws-panel[data-id="${i}"] .ws-name`).getBoundingClientRect(); return { x: r.x + 4, y: r.y + r.height / 2 }; }, id);
  const pitch = () => page.evaluate(() => { const g = document.getElementById('wsGrid'); return { x: (g.clientWidth - 12 - 66) / 12 + 6, y: (g.clientHeight - 12 - 30) / 6 + 6 }; });

  console.log('default layout');
  await open(URL0);
  let s = await state();
  check(s.layout === 'Main' && s.search === '?layout=Main', 'no ?layout opens Main and puts it in the URL (' + s.search + ')');
  check(s.views.length === 5 && s.views.filter(v => v.type === 'chart').length === 4 && s.views.filter(v => v.type === 'tape').length === 1, '5 panels: 4 charts and Time and Sales');
  check(s.views.every(v => v.state === 'live'), 'every panel live');
  const byKey = k => s.panels.find(p => p.type + ':' + p.root + ':' + (p.tf || '') === k);
  const exec = s.panels.find(p => p.exec), nq = byKey('chart:NQ:m5'), es = byKey('chart:ES:m1'), daily = byKey('chart:MNQ:h1'), tape = s.panels.find(p => p.type === 'tape');
  check(exec && exec.root === 'MNQ' && exec.tf === 'range' && exec.range === 40 && exec.x === 0 && exec.w === 7 && exec.h === 4, 'the execution chart: MNQ Range 40, cols 1 to 7, rows 1 to 4');
  check(daily && daily.y === 4 && daily.h === 2 && nq && nq.x === 7 && nq.h === 3 && es && es.y === 3 && tape && tape.x === 10 && tape.h === 6, 'the 1 hour chart under it, NQ 5 min and ES 1 min in the middle, the tape on the right');
  const ui = await page.evaluate(id => {
    const ex = document.querySelector(`.ws-panel[data-id="${id}"]`);
    return { tag: ex.querySelector('.ws-tag.exec') && ex.querySelector('.ws-tag.exec').textContent, close: !!ex.querySelector('.ws-x'), obar: !!document.querySelector('[id$="obar"], [id$="armBtn"], [id$="buyMkt"]'),
      viewOnly: document.querySelectorAll('.ws-panel[data-type="chart"]:not(.exec) .ws-tag').length, border: getComputedStyle(ex).borderTopColor,
      dailyTf: document.querySelectorAll('.ws-panel .ws-tf')[1].textContent, names: [...document.querySelectorAll('.ws-panel .ws-name')].map(e => e.textContent),
      flattenSlot: !!document.getElementById('wsFlattenSlot'), clock: document.getElementById('wsClock').textContent, topH: document.querySelector('.ws-top').offsetHeight };
  }, exec.id);
  check(ui.tag === 'EXECUTION CHART' && !ui.close && ui.border === 'rgb(123, 92, 255)', 'the execution panel: purple border and tag, no close button');
  check(!ui.obar, 'no order bar anywhere in this build (every chart is a read-only mount)');
  check(ui.viewOnly === 3, 'the other three charts say view only');
  check(ui.dailyTf === '1 hour', 'the long chart is labelled 1 hour, not Daily (ChartBridge 0.3.7 brings daily bars)');
  check(ui.names.includes('MNQ 12-26') && ui.names.includes('Time and Sales'), 'headers show the contract (' + ui.names.join(', ') + ')');
  check(ui.flattenSlot && /^\d\d:\d\d:\d\d$/.test(ui.clock) && ui.topH === 40, 'top bar 40 px, New York clock ' + ui.clock + ', the Flatten slot kept for E2');
  const paneIds = await page.evaluate(() => [...document.querySelectorAll('.ws-panel[data-type="chart"] [data-pane]')].map(e => e.dataset.pane));
  check(paneIds.length === 4 && new Set(paneIds).size === 4 && paneIds.every(id => s.panels.some(p => p.id === id)), 'each chart has its own paneId, the panel id');
  const ind = await page.evaluate(() => JSON.parse(localStorage.getItem('workspace:live-indicators-v2') || '{}'));
  check(ind[exec.id] && ind[exec.id].ind.vwap.on && !ind[nq.id], 'the execution chart starts with the trading page\'s indicators, the others with none');
  await shot(page, 'workspace-1920x1080.png');

  console.log('Time and Sales');
  await page.evaluate(() => { localStorage.setItem('workspace:live-tape-floors-v1', JSON.stringify({})); });
  await page.click('#wsSet');
  await page.fill('#wsFloors input[data-root="MNQ"][data-w="rth"]', '4');
  await page.fill('#wsFloors input[data-root="MNQ"][data-w="eth"]', '4');
  await page.keyboard.press('Escape');
  check((await page.evaluate(() => JSON.parse(localStorage.getItem('workspace:live-tape-floors-v1')))).MNQ.rth === 4, 'large-print floors set in Settings are saved');
  await control('price?root=MNQ&p=12345.25');
  await control('price?root=MNQ&p=12345.5');
  await page.waitForFunction(() => { const r = document.querySelectorAll('.tp-row .tp-p'); return r[0] && r[0].textContent === '12,345.50'; }, null, { timeout: 5000 }).catch(() => {});
  let rows = await page.evaluate(() => [...document.querySelectorAll('.tp-row:not([hidden])')].slice(0, 2).map(r => r.querySelector('.tp-p').textContent));
  check(rows[0] === '12,345.50' && rows[1] === '12,345.25', 'newest on top (' + rows.join(', ') + ')');
  await control('hold?root=MNQ&on=0');
  await page.waitForTimeout(1500);
  const tp = await page.evaluate(() => {
    const rs = [...document.querySelectorAll('.tp-row:not([hidden])')];
    const list = document.querySelector('.tp-list');
    const col = r => getComputedStyle(r.querySelector('.tp-p')).color;
    return { n: rs.length, fit: Math.ceil(list.clientHeight / 18), times: rs.map(r => r.querySelector('.tp-t').textContent),
      buy: rs.filter(r => r.classList.contains('buy')).map(col)[0], sell: rs.filter(r => r.classList.contains('sell')).map(col)[0],
      big: rs.filter(r => r.classList.contains('big')).length, bigBg: (rs.find(r => r.classList.contains('big')) || rs[0]).style && getComputedStyle(rs.find(r => r.classList.contains('big')) || rs[0]).backgroundColor,
      small: rs.filter(r => !r.classList.contains('big')).every(r => +r.querySelector('.tp-v').textContent < 4),
      bigOk: rs.filter(r => r.classList.contains('big')).every(r => +r.querySelector('.tp-v').textContent >= 4), dom: list.children.length };
  });
  check(tp.n > 10 && tp.dom === tp.fit, 'only the rows that fit are in the page (' + tp.dom + ' rows for ' + tp.fit + ' visible)');
  check(tp.times.every((t, i) => i === 0 || t <= tp.times[i - 1]), 'times run newest first');
  check(tp.buy === 'rgb(61, 220, 151)' && tp.sell === 'rgb(255, 92, 122)', 'buys green, sells red');
  check(tp.big > 0 && tp.bigOk && tp.small && tp.bigBg === 'rgb(42, 31, 77)', 'large prints (size 4 or more here) highlighted purple, ' + tp.big + ' on screen');
  const kept = await page.evaluate(() => window.workspace.views().find(v => v.type === 'tape').count);
  check(kept <= 500, 'at most 500 trades kept (' + kept + ')');
  await shot(page, 'workspace-tape.png');

  console.log('drag, resize, overlap, close, add');
  let pt = await pitch();
  let h0 = await head(nq.id);
  await page.mouse.move(h0.x, h0.y); await page.mouse.down();
  await page.mouse.move(h0.x - pt.x * 3, h0.y + 10, { steps: 6 });
  const blocked = await page.evaluate(() => { const g = document.getElementById('wsGhost'); return !g.hidden && g.classList.contains('blocked'); });
  check(blocked, 'dragging onto the execution chart shows the ghost blocked');
  await shot(page, 'workspace-blocked.png');
  await page.mouse.up();
  s = await state();
  let nq2 = s.panels.find(p => p.id === nq.id);
  check(nq2.x === 7 && nq2.y === 0, 'dropped on another panel: put back');
  check(await page.evaluate(() => document.getElementById('wsGhost').hidden), 'the ghost is gone after the drop');

  await page.click(`.ws-panel[data-id="${es.id}"] .ws-x`);
  s = await state();
  check(s.views.length === 4 && !s.panels.some(p => p.id === es.id), 'the ES panel closes with its x');
  check((await saved()).layouts.Main.panels.length === 4, 'the close is saved');

  h0 = await head(nq.id);
  await page.mouse.move(h0.x, h0.y); await page.mouse.down();
  await page.mouse.move(h0.x + 13, h0.y + pt.y * 1.4, { steps: 6 });
  await page.mouse.up();
  s = await state(); nq2 = s.panels.find(p => p.id === nq.id);
  check(nq2.x === 7 && nq2.y === 1 && nq2.w === 3 && nq2.h === 3, 'drag snaps to whole cells (1.4 cells down, a few px right: one row down)');
  const b1 = await box(nq.id);
  check(Math.abs(b1.y - (6 + 40 + pt.y)) < 2, 'the panel sits on the cell edge (' + Math.round(b1.y) + ' px)');

  const c = await page.evaluate(i => { const r = document.querySelector(`.ws-panel[data-id="${i}"] .ws-size`).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, nq.id);
  await page.mouse.move(c.x, c.y); await page.mouse.down();
  await page.mouse.move(c.x - pt.x * 0.6, c.y + pt.y * 1.7, { steps: 6 });
  await page.mouse.up();
  s = await state(); nq2 = s.panels.find(p => p.id === nq.id);
  check(nq2.w === 2 && nq2.h === 5, 'resize from the corner snaps to cells (w ' + nq2.w + ', h ' + nq2.h + ')');
  const c2 = await page.evaluate(i => { const r = document.querySelector(`.ws-panel[data-id="${i}"] .ws-size`).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, nq.id);
  await page.mouse.move(c2.x, c2.y); await page.mouse.down();
  await page.mouse.move(c2.x + pt.x * 2, c2.y, { steps: 4 });
  check(await page.evaluate(() => document.getElementById('wsGhost').classList.contains('blocked')), 'a resize over the tape is blocked');
  await page.mouse.up();
  s = await state(); nq2 = s.panels.find(p => p.id === nq.id);
  check(nq2.w === 2, 'and put back');
  await page.mouse.move(c2.x, c2.y); await page.mouse.down();
  await page.mouse.move(c2.x - pt.x * 3, c2.y - pt.y * 9, { steps: 4 });
  await page.mouse.up();
  s = await state(); nq2 = s.panels.find(p => p.id === nq.id);
  check(nq2.w === 2 && nq2.h === 1, 'never smaller than 2 x 1');

  await page.click('#wsAdd'); await page.click('[data-add="tape"]');
  s = await state();
  const added = s.panels[s.panels.length - 1];
  check(s.views.length === 5 && added.type === 'tape' && added.x === 7 && added.y === 2 && added.w === 3 && added.h === 4, 'Add panel puts a tape in the largest free rectangle (' + [added.x, added.y, added.w, added.h] + ')');
  await page.click('#wsAdd'); await page.click('[data-add="chart"]');
  s = await state();
  const added2 = s.panels[s.panels.length - 1];
  check(s.views.length === 6 && added2.type === 'chart' && added2.w >= 2, 'Add panel: a chart in what is left (' + [added2.x, added2.y, added2.w, added2.h] + ')');
  await page.waitForFunction(() => window.workspace.views().every(v => v.state === 'live'), null, { timeout: 20000 }).catch(() => fail('added panels not live'));
  await page.click('#wsAdd'); await page.click('[data-add="chart"]');
  const full = await page.evaluate(() => ({ note: document.getElementById('wsNote').textContent, n: window.workspace.views().length }));
  check(full.n === 6 && full.note === 'No free space: close or shrink a panel', 'a full grid says so: "' + full.note + '"');

  console.log('instrument and timeframe per panel');
  await page.click(`.ws-panel[data-id="${added2.id}"] [id$="symSeg"] [data-v="ES"]`);
  await page.click(`.ws-panel[data-id="${added2.id}"] [id$="tfSeg"] [data-v="m15"]`);
  await page.selectOption(`.ws-panel[data-id="${added.id}"] select[data-act="root"]`, 'NQ');
  s = await state();
  const a2 = s.panels.find(p => p.id === added2.id), a1 = s.panels.find(p => p.id === added.id);
  check(a2.root === 'ES' && a2.tf === 'm15' && a1.root === 'NQ', 'a chart keeps its own instrument and bars, a tape its instrument');
  check(await page.evaluate(i => document.querySelector(`.ws-panel[data-id="${i}"] .ws-tf`).textContent, added2.id) === '15 min', 'the header follows the chart');
  const layoutBefore = (await state()).panels;

  console.log('reload');
  await open(URL0 + '?layout=Main');
  s = await state();
  check(JSON.stringify(s.panels) === JSON.stringify(layoutBefore), 'a reload opens the same layout, panels, places and choices');
  const roots = await page.evaluate(() => [...document.querySelectorAll('.ws-panel[data-type="chart"]')].map(p => p.querySelector('[id$="symSeg"] [aria-pressed="true"]').dataset.v + ':' + p.querySelector('[id$="tfSeg"] [aria-pressed="true"]').dataset.v));
  check(JSON.stringify(roots) === JSON.stringify(s.panels.filter(p => p.type === 'chart').map(p => p.root + ':' + p.tf)), 'each chart mounts on its own instrument and bars (' + roots.join(', ') + ')');

  console.log('?layout=Second');
  await open(URL0 + '?layout=Second');
  s = await state();
  check(s.layout === 'Second' && s.views.length === 5 && s.panels.every(p => !layoutBefore.some(q => q.id === p.id)), 'a new name opens the default layout with its own panel ids');
  const st = await saved();
  check(Object.keys(st.layouts).join() === 'Main,Second' && st.layouts.Main.panels.length === 6, 'Main is left as it was');
  check(await page.evaluate(() => [...document.getElementById('wsLayout').options].map(o => o.textContent).join('|')) === 'Main|Second|──────|New layout...|Rename|Delete', 'the Layout select lists both, then New layout..., Rename, Delete');

  console.log('read only');
  const sent = await page.evaluate(() => window.__spy.sockets.flatMap(k => k.sent.map(d => JSON.parse(d).type)));
  check(sent.length > 0 && sent.every(t => t === 'subscribe' || t === 'ping'), 'the page sends only subscribe (and ping): ' + [...new Set(sent)].join(', '));
  const open_ = await page.evaluate(() => window.__spy.sockets.length);
  check(open_ === 5, 'one WebSocket per panel: ' + open_);
  const received = await (await fetch(`http://127.0.0.1:${PORT}/test/received`, { method: 'POST' })).json();
  check(received.sessionRequests === 0, 'no GET /session');

  console.log('New layout, Rename, Delete');
  await page.selectOption('#wsLayout', '\u0001new');
  await page.fill('#wsName', 'Third');
  await page.click('#wsDialog [type="submit"]');
  await page.waitForFunction(() => window.workspace.layout === 'Third');
  check((await state()).search === '?layout=Third', 'New layout opens it and puts it in the URL');
  await page.selectOption('#wsLayout', '\u0001rename');
  await page.fill('#wsName', 'Second');
  await page.click('#wsDialog [type="submit"]');
  check(await page.textContent('#wsNameErr') === 'A layout with that name exists', 'a name taken is refused');
  await page.fill('#wsName', 'Left screen');
  await page.click('#wsDialog [type="submit"]');
  s = await state();
  check(s.layout === 'Left screen' && s.search === '?layout=Left+screen' && Object.keys((await saved()).layouts).includes('Left screen'), 'Rename renames it and the URL');
  await page.selectOption('#wsLayout', '\u0001delete');
  await page.click('#wsDialog [type="submit"]');
  s = await state();
  check(s.layout === 'Main' && !Object.keys((await saved()).layouts).includes('Left screen'), 'Delete removes it and opens Main');
  await page.waitForFunction(() => window.workspace.views().every(v => v.state === 'live'), null, { timeout: 20000 }).catch(() => fail('Main not live again'));

  console.log('screens');
  for (const [w, h] of [[2560, 1440], [1366, 768]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(800);
    const fitOk = await page.evaluate(() => { const g = document.getElementById('wsGrid').getBoundingClientRect(); return [...document.querySelectorAll('.ws-panel')].every(p => { const r = p.getBoundingClientRect(); return r.left >= g.left - 1 && r.top >= g.top - 1 && r.right <= g.right + 1 && r.bottom <= g.bottom + 1 && r.width > 50 && r.height > 50; }) && document.documentElement.scrollWidth <= innerWidth; });
    check(fitOk, w + 'x' + h + ': every panel inside the window, by cells');
    await shot(page, `workspace-${w}x${h}.png`);
  }
  // the default layout itself at 2560 and 1366, for Anthony to look at
  await page.setViewportSize({ width: 2560, height: 1440 });
  await open(URL0 + '?layout=Second');
  await page.waitForTimeout(1500);
  await shot(page, 'workspace-2560x1440.png');
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForTimeout(1500);
  await shot(page, 'workspace-1366x768.png');
} catch (e) {
  fail('threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  bridge.kill();
}
console.log(errors.length ? `\n${errors.length} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
