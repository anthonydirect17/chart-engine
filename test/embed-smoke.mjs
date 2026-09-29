// Embedded chart smoke test: ChartLive.mount inside a plain host page (test/embed-host.html), against the fake
// bridge, in Chromium. Checks the read-only guarantee (only subscribe and ping sent, no GET /session, no order bar),
// a fresh wsUrl on every reconnect (single-use tickets, like The Desk's relay), destroy() taking everything down,
// mount again, two panes with their own indicators, and storagePrefix keeping settings apart from the standalone page.
// Sample data only. Screenshots in test/out/ (and SHOTS_DIR when set).
//   npm run smoke:embed        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { TEST_PIN, unlockIfAsked } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PORT = +(process.env.EMBED_SMOKE_PORT || 8811);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const bridges = [];
async function startBridge(port, flags) {
  const child = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port)].concat(flags), { stdio: ['ignore', 'pipe', 'inherit'] });
  bridges.push(child);
  await new Promise(r => child.stdout.once('data', r));
}
const control = async (port, what) => (await fetch(`http://127.0.0.1:${port}/test/${what}`, { method: 'POST' })).json();
async function shot(page, name) {
  const file = path.join(out, name);
  await page.screenshot({ path: file });
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, name));
}
async function until(fn, what, ms) {
  const end = Date.now() + (ms || 8000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) { fail('timed out: ' + what); return null; }
    await new Promise(r => setTimeout(r, 100));
  }
}

/* Runs before any page script: records WebSockets (URL, messages sent, the socket), listeners on document and
   window, and intervals, so the test can see what a mount leaves behind after destroy(). */
function spies() {
  const S = window.__spy = { sockets: [], listeners: new Set(), intervals: new Set() };
  const Real = window.WebSocket;
  function Spy(url, protocols) {
    const sock = protocols === undefined ? new Real(url) : new Real(url, protocols);
    const rec = { url: String(url), sent: [], sock };
    const send = sock.send.bind(sock);
    sock.send = d => { rec.sent.push(d); return send(d); };
    S.sockets.push(rec);
    return sock;
  }
  Spy.prototype = Real.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
  window.WebSocket = Spy;
  for (const [name, target] of [['document', document], ['window', window]]) {
    const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
    const keyOf = (type, fn, o) => { const k = name + ' ' + type + ' ' + (typeof o === 'boolean' ? o : !!(o && o.capture)); if (!fn.__spyId) fn.__spyId = Math.random().toString(36).slice(2); return k + ' ' + fn.__spyId; };
    const ours = () => /\/live\/|\/src\/chart-engine\.js/.test(new Error().stack);   // only listeners the chart's own files add
    target.addEventListener = (type, fn, o) => { if (fn && ours()) S.listeners.add(keyOf(type, fn, o)); return add(type, fn, o); };
    target.removeEventListener = (type, fn, o) => { if (fn) S.listeners.delete(keyOf(type, fn, o)); return remove(type, fn, o); };
  }
  const si = window.setInterval.bind(window), ci = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...a) => { const id = si(fn, ms, ...a); S.intervals.add(id); return id; };
  window.clearInterval = id => { S.intervals.delete(id); return ci(id); };
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  /* ChartBridge offers trading here (protocol v2, trading on), and the WebSocket needs single-use tickets. */
  // ChartBridge 0.3.2: a PIN is set on this bridge; the embedded chart must never ask for it or need it
  await startBridge(PORT, ['--trading', '--trade-accounts=Sim101', '--test-controls', '--tickets', '--test-pin=' + TEST_PIN]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(spies);
  page.on('pageerror', e => fail('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket connection/.test(m.text())) fail('console: ' + m.text()); });
  const requests = [];
  page.on('request', r => requests.push(r.url()));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(`http://localhost:${PORT}/test/embed-host.html`);
  await page.evaluate(() => localStorage.clear());

  /* ---------------- one pane: mount, bars and fills from wsUrl, read only */
  const before = await page.evaluate(() => ({ globals: Object.keys(window), listeners: [...window.__spy.listeners], intervals: window.__spy.intervals.size }));
  await page.evaluate(port => {
    document.getElementById('paneB').hidden = true;
    window.__calls = { A: 0, B: 0 }; window.__status = { A: [], B: [] };
    // an async function, like The Desk fetching a relay ticket for every connect
    window.__urlA = () => { window.__calls.A++; return Promise.resolve('ws://localhost:' + port + '/ws?ticket=A' + window.__calls.A + '-' + Math.random().toString(36).slice(2)); };
    window.__urlB = () => { window.__calls.B++; return 'ws://localhost:' + port + '/ws?ticket=B' + window.__calls.B + '-' + Math.random().toString(36).slice(2); };
    // trading: true is ignored by mount(): a mounted chart is read only whatever the options say
    window.__a = ChartLive.mount(document.getElementById('paneA'), { wsUrl: window.__urlA, trading: true, paneId: 'main', storagePrefix: 'desk:', onStatus: s => window.__status.A.push(s.state) });
  }, PORT);
  const paneLive = id => page.evaluate(id => { const el = document.querySelector('#' + id + ' .pill[id$="-connPill"]'); return !!el && el.textContent === 'LIVE'; }, id);
  await until(() => paneLive('paneA'), 'pane A live');
  await page.waitForTimeout(1200);
  check(await page.evaluate(() => window.__a.chart.bars().length > 100), 'bars from wsUrl: ' + await page.evaluate(() => window.__a.chart.bars().length));
  const legendA = (await page.textContent('#paneA .legend')).replace(/\s+/g, ' ');
  check(/MNQ 12-26/.test(legendA) && /Last fill (BUY|SELL)/.test(legendA), 'legend shows the contract and the last fill: ' + legendA.slice(0, 120));
  check(await page.evaluate(() => window.__status.A.join(',')) === 'connecting,loading,live', 'onStatus: ' + await page.evaluate(() => window.__status.A.join(',')));
  check(await page.evaluate(() => window.liveChart === undefined), 'no window.liveChart from an embedded chart');
  // the page's ids are prefixed per mount; the engine's Colors panel makes its own random ones
  check(await page.evaluate(() => { const el = document.querySelector('#paneA .chart-live'); return !!el && [...el.querySelectorAll('[id]')].every(e => e.id.startsWith('chart-live-') || e.closest('.ce-theme')); }), 'every element id is prefixed per mount');
  check(await page.evaluate(() => window.__spy.listeners.size > 0 && [...window.__spy.listeners].every(k => /^(document|window) /.test(k))), 'listener spy sees the chart\'s own listeners: ' + await page.evaluate(() => [...window.__spy.listeners].map(k => k.split(' ').slice(0, 2).join(' ')).join(', ')));
  check(await page.evaluate(() => !document.getElementById('connPill') && !document.getElementById('chart')), 'none of the standalone page ids exist in the host');
  check(await page.evaluate(() => !document.querySelector('.cb-pin') && typeof window.ChartBridgePin === 'undefined') && !requests.some(u => /\/pin\//.test(u)),
    'PIN set on ChartBridge: the embedded chart shows no PIN pad, loads no pin.js, asks nothing of /pin/');
  check(await page.evaluate(() => document.body.getAttribute('style') === null && document.documentElement.getAttribute('style') === null && document.body.className === '' && document.documentElement.className === ''), 'no style or class put on html or body');
  check(await page.evaluate(() => !document.querySelector('#paneA .obar, #paneA .arm, #paneA [role="switch"], #paneA .pill.armed, #paneA .side-seg')), 'mounted with trading: true, still no order bar, no Armed switch, no ARMED pill');
  // Shift+click and a drag on the chart: nothing is sent, no order lines
  const box = await page.locator('#paneA canvas').boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.waitForTimeout(150);
  await shot(page, 'embed-shift-hover.png');
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(600);
  check(await page.evaluate(() => window.__a.chart.getOrders().length === 0), 'no order lines on the chart');
  await shot(page, 'embed-one-pane.png');

  /* ---------------- reconnect: the wsUrl function is asked again, with a fresh ticket each time */
  const callsBefore = await page.evaluate(() => window.__calls.A);
  await control(PORT, 'drop');
  await until(() => page.evaluate(() => window.__status.A.includes('offline')), 'offline after the drop');
  await until(() => paneLive('paneA'), 'pane A live again after the drop', 10000);
  const callsAfter = await page.evaluate(() => window.__calls.A);
  check(callsBefore === 1 && callsAfter === 2, 'wsUrl called again on reconnect: ' + callsBefore + ' then ' + callsAfter);
  await control(PORT, 'drop');
  await until(() => page.evaluate(() => window.__calls.A >= 3), 'wsUrl called a third time');
  await until(() => paneLive('paneA'), 'pane A live after a second drop', 10000);
  let rec = await control(PORT, 'received');
  const ticketsA = rec.urls.filter(u => /ticket=A/.test(u));
  check(ticketsA.length === 3 && new Set(ticketsA).size === 3 && rec.ticketsRefused === 0, 'three connects, three different tickets, none refused: ' + JSON.stringify(ticketsA));
  // the fake really refuses a reused ticket (so the check above means something)
  const reused = await page.evaluate(u => new Promise(r => { const s = new WebSocket(u); s.onopen = () => { s.close(); r('open'); }; s.onerror = () => r('refused'); }), 'ws://localhost:' + PORT + ticketsA[0]);
  check(reused === 'refused', 'a reused ticket is refused by the fake relay: ' + reused);

  /* ---------------- read-only guarantee */
  const sentTypes = await page.evaluate(() => [...new Set(window.__spy.sockets.flatMap(s => s.sent.map(d => JSON.parse(d).type)))]);
  check(sentTypes.length > 0 && sentTypes.every(t => t === 'subscribe' || t === 'ping'), 'the page sent only subscribe and ping: ' + sentTypes.join(','));
  rec = await control(PORT, 'received');
  check(Object.keys(rec.types).every(t => t === 'subscribe' || t === 'ping'), 'the bridge received only subscribe and ping: ' + JSON.stringify(rec.types));
  check(rec.sessionRequests === 0 && !requests.some(u => /\/session(\?|$)/.test(u)), 'GET /session never requested (bridge count ' + rec.sessionRequests + ')');
  check(/^Read only/.test(await page.textContent('#paneA .status .ro')), 'footer says read only');

  /* ---------------- destroy: socket closed, listeners and timers gone, nothing reconnects */
  await page.evaluate(() => { window.__a.destroy(); window.__a.destroy(); });   // twice is harmless
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    globals: Object.keys(window), listeners: [...window.__spy.listeners], intervals: window.__spy.intervals.size,
    open: window.__spy.sockets.filter(s => s.sock.readyState < 2).length, children: document.getElementById('paneA').children.length,
  }));
  check(after.open === 0, 'destroy closed the socket (' + after.open + ' open)');
  check(after.children === 0, 'destroy removed the chart element');
  const leftListeners = after.listeners.filter(k => !before.listeners.includes(k));
  check(leftListeners.length === 0, 'document and window listeners back to before mount (' + leftListeners.join('; ') + ')');
  check(after.intervals === before.intervals, 'intervals back to before mount: ' + before.intervals + ' -> ' + after.intervals);
  const newGlobals = after.globals.filter(k => !before.globals.includes(k) && !k.startsWith('__'));
  check(newGlobals.length === 0, 'no new globals after mount and destroy: ' + newGlobals.join(','));
  check(await page.evaluate(() => ['ChartEngine', 'BarBuilder', 'OrderTicket', 'LivePrefs', 'ChartLive'].every(k => k in window)), 'the scripts define ChartEngine, BarBuilder, OrderTicket, LivePrefs and ChartLive');
  const callsAtDestroy = await page.evaluate(() => window.__calls.A);
  await control(PORT, 'drop');
  await page.waitForTimeout(2500);
  check(await page.evaluate(() => window.__calls.A) === callsAtDestroy, 'no reconnect after destroy');

  /* ---------------- mount again, then two panes side by side with their own indicators */
  await page.evaluate(() => {
    document.getElementById('paneB').hidden = false;
    window.__a = ChartLive.mount(document.getElementById('paneA'), { wsUrl: window.__urlA, paneId: 'main', storagePrefix: 'desk:', onStatus: s => window.__status.A.push(s.state) });
    window.__b = ChartLive.mount(document.getElementById('paneB'), { wsUrl: window.__urlB, paneId: 'pane-2', storagePrefix: 'desk:', onStatus: s => window.__status.B.push(s.state) });
  });
  await until(async () => await paneLive('paneA') && await paneLive('paneB'), 'both panes live');
  await page.waitForTimeout(800);
  check(await page.evaluate(() => window.__a.chart.bars().length > 100 && window.__b.chart.bars().length > 100), 'mount again works, and the second pane has bars');
  let layers = await page.evaluate(() => [window.__a.chart.getLayers(), window.__b.chart.getLayers()]);
  check(layers[0].volume && layers[0].vwap && !layers[1].volume && !layers[1].vwap, 'main pane starts with the usual set, a new pane with none: ' + JSON.stringify(layers));
  // pane A: VWAP hidden with its switch; pane B (a new pane): Volume and VWAP added, from search and from a group
  await page.click('#paneA .ind-btn');
  check(await page.evaluate(() => document.activeElement.matches('#paneA .ind-search input')), 'menu opens with focus in its search box');
  await page.click('#paneA .ind-panel [data-f="sw:vwap"]');
  await page.keyboard.press('Escape');
  await page.click('#paneB .ind-btn');
  check(await page.evaluate(() => document.querySelector('#paneA .ind-panel').hidden), 'opening pane B\'s menu closes pane A\'s');
  check(/Nothing on this chart yet/.test(await page.textContent('#paneB .ind-body')) && await page.textContent('#paneB .ind-count') === '0/0', 'a new pane starts with nothing on its chart');
  await page.keyboard.type('vol'); await page.keyboard.press('Enter');                          // the first match: Volume bars
  await page.fill('#paneB .ind-search input', '');
  await page.click('#paneB .ind-panel .ind-cat[data-id="price"]');
  await page.click('#paneB .ind-panel [data-f="add:vwap"]');
  await page.mouse.click(700, 20);
  check(await page.evaluate(() => document.querySelector('#paneB .ind-panel').hidden), 'a click outside closes pane B\'s menu');
  layers = await page.evaluate(() => [window.__a.chart.getLayers(), window.__b.chart.getLayers()]);
  check(layers[0].volume && !layers[0].vwap && layers[0].levels && layers[1].volume && layers[1].vwap && !layers[1].levels, 'indicator choices stay per pane: ' + JSON.stringify(layers));
  // pane A (main): the five less VWAP (hidden, still on its chart); pane B (new): the two added
  check(await page.textContent('#paneA .ind-count') === '4/5' && await page.textContent('#paneB .ind-count') === '2/2' && layers[0].ib === true && layers[1].ib === false, 'indicator counts per pane: ' + await page.textContent('#paneA .ind-count') + ' ' + await page.textContent('#paneB .ind-count'));
  check(await page.$$eval('#paneB .ind-chip', c => c.length) === 0 && await page.$$eval('#paneA .ind-chip', c => c.length) === 5, 'chips: pane A\'s five pinned ones, none on pane B until pinned');
  // B on ES at 5m, A stays MNQ 1m
  await page.click('#paneB [role="group"][aria-label="Instrument"] >> text="ES"');
  await page.click('#paneB .seg >> text="5m"');
  await until(() => paneLive('paneB'), 'pane B live on ES');
  await page.waitForTimeout(1500);
  check(/ES 12-26/.test(await page.textContent('#paneB .legend')) && /MNQ 12-26/.test(await page.textContent('#paneA .legend')), 'each pane has its own instrument');
  // keys go to the focused pane only: arrows pan pane A away from live, pane B stays live
  await page.focus('#paneA .chart-box');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(300);
  check(await page.evaluate(() => !window.__a.chart.isLive() && window.__b.chart.isLive()), 'arrow keys pan only the focused pane');
  await page.keyboard.press('End');
  await page.waitForTimeout(600);
  await shot(page, 'embed-two-panes.png');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('desk:live-indicators-v2')));
  check(saved && saved.main && saved['pane-2'] && saved.main.ind.vwap.shown === false && saved.main.ind.fills.on === true && saved['pane-2'].ind.vwap.on === true && saved['pane-2'].ind.levels.on === false && saved['pane-2'].ind.fills.on === false, 'saved per pane id under the prefix: ' + JSON.stringify(saved));
  // "/" opens the menu of the pane under the mouse, and only that one
  {
    const bb = await page.locator('#paneB canvas').boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.keyboard.press('/');
    check(!(await page.evaluate(() => document.querySelector('#paneB .ind-panel').hidden)) && await page.evaluate(() => document.querySelector('#paneA .ind-panel').hidden) && await page.evaluate(() => document.activeElement.matches('#paneB .ind-search input')), '"/" opens the menu of the pane under the mouse (B), not A\'s');
    // add everything on pane B and pin it all, then make B narrow: letter chips, one line
    await page.fill('#paneB .ind-search input', '');
    for (const cat of ['price', 'trades']) {
      if (await page.getAttribute(`#paneB .ind-cat[data-id="${cat}"]`, 'aria-expanded') !== 'true') await page.click(`#paneB .ind-cat[data-id="${cat}"]`);
      while (await page.$('#paneB .ind-body [data-f^="add:"]')) await page.click('#paneB .ind-body [data-f^="add:"]');   // each add redraws the list
    }
    for (const id of ['volume', 'vwap', 'levels', 'ib', 'fills']) await page.click(`#paneB .ind-body [data-act="pin"][data-id="${id}"]`);
    await page.keyboard.press('Escape');
    check(await page.textContent('#paneB .ind-count') === '5/5' && await page.$$eval('#paneB .ind-chip', c => c.length) === 5, 'pane B: all five added and pinned');
    await page.evaluate(() => { document.getElementById('paneA').style.flex = '3 1 0'; });
    await page.waitForTimeout(300);
    const nb = await page.evaluate(() => { const s = document.querySelector('#paneB .ind-chips'), cs = [...s.querySelectorAll('.ind-chip')];
      return { w: Math.round(document.getElementById('paneB').getBoundingClientRect().width), narrow: s.classList.contains('is-narrow'), lines: new Set(cs.map(c => Math.round(c.getBoundingClientRect().top))).size, text: cs.map(c => c.innerText.trim()).join(''), fits: s.scrollWidth <= s.clientWidth + 1 }; });
    const na = await page.evaluate(() => document.querySelector('#paneA .ind-chips').classList.contains('is-narrow'));
    check(nb.narrow && nb.lines === 1 && nb.text === 'VWLIF' && nb.fits && !na, 'narrow pane (' + nb.w + ' px): one-letter chips on one line, the wide pane keeps full chips: ' + JSON.stringify(nb));
    await page.click('#paneB .ind-chip[data-id="levels"]');
    check(await page.evaluate(() => window.__b.chart.getLayers().levels === false && window.__a.chart.getLayers().levels === true), 'a letter chip hides Levels on its own pane only');
    await shot(page, 'embed-narrow-pane-chips.png');
    await page.click('#paneB .ind-btn');
    const pb = await page.locator('#paneB .ind-panel').boundingBox(), paneBox = await page.locator('#paneB').boundingBox();
    check(pb.x >= paneBox.x - 1 && pb.x + pb.width <= paneBox.x + paneBox.width + 1, 'the menu stays inside a narrow pane: ' + JSON.stringify([pb.x, pb.width, paneBox.x, paneBox.width]));
    await shot(page, 'embed-narrow-pane-menu.png');
    await page.keyboard.press('Escape');
    // back to pane B's earlier set: Volume and VWAP only, not pinned
    await page.click('#paneB .ind-btn');
    for (const id of ['levels', 'ib', 'fills']) await page.click(`#paneB .ind-body [data-act="remove"][data-id="${id}"]`);
    for (const id of ['volume', 'vwap']) await page.click(`#paneB .ind-body [data-act="pin"][data-id="${id}"]`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { document.getElementById('paneA').style.flex = ''; });
    check(await page.textContent('#paneB .ind-count') === '2/2', 'pane B back to Volume and VWAP');
  }
  // take both down and mount again: each pane gets its own choices back
  await page.evaluate(() => { window.__a.destroy(); window.__b.destroy(); });
  await page.evaluate(() => {
    window.__a = ChartLive.mount(document.getElementById('paneA'), { wsUrl: window.__urlA, paneId: 'main', storagePrefix: 'desk:' });
    window.__b = ChartLive.mount(document.getElementById('paneB'), { wsUrl: window.__urlB, paneId: 'pane-2', storagePrefix: 'desk:' });
  });
  await until(async () => await paneLive('paneA') && await paneLive('paneB'), 'both panes live after mounting again');
  layers = await page.evaluate(() => [window.__a.chart.getLayers(), window.__b.chart.getLayers()]);
  check(layers[0].volume && !layers[0].vwap && layers[0].levels && layers[1].volume && layers[1].vwap && !layers[1].levels, 'per-pane indicators come back after mounting again: ' + JSON.stringify(layers));
  // two panes on one instrument each keep their own drawings (and colors are saved one field at a time)
  for (const pane of ['paneA', 'paneB']) {
    if (await page.getAttribute('#' + pane + ' [aria-label="Instrument"] >> text="MNQ"', 'aria-pressed') !== 'true') {
      await page.click('#' + pane + ' [aria-label="Instrument"] >> text="MNQ"');
      await until(() => paneLive(pane), pane + ' live on MNQ');
    }
  }
  await page.waitForTimeout(600);
  for (const [pane, y] of [['paneA', 0.3], ['paneB', 0.6]]) {
    await page.click('#' + pane + ' [id$="-toolHline"]');
    const b = await page.locator('#' + pane + ' canvas').boundingBox();
    await page.mouse.click(b.x + b.width * 0.4, b.y + b.height * y);
  }
  await page.waitForTimeout(300);
  const drawn = await page.evaluate(() => ({ a: window.__a.chart.getDrawings().length, b: window.__b.chart.getDrawings().length,
    main: JSON.parse(localStorage.getItem('desk:live-drawings-v1-MNQ') || '[]').length, pane2: JSON.parse(localStorage.getItem('desk:live-drawings-v1-pane-2-MNQ') || '[]').length }));
  check(drawn.a === 1 && drawn.b === 1 && drawn.main === 1 && drawn.pane2 === 1, 'two panes on MNQ: one price line each, saved per pane: ' + JSON.stringify(drawn));
  await page.click('#paneA .ce-theme-btn'); await page.click('#paneA .ce-preset[data-id="mint"]'); await page.keyboard.press('Escape');
  await page.click('#paneB .ce-theme-btn'); await page.fill('#paneB .ce-theme-panel input[data-hex="vwap"]', '#ABCDEF'); await page.keyboard.press('Escape');
  const colorsA = await page.evaluate(() => window.__a.chart.getTheme());
  const colorsSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('desk:live-colors-v1')));
  check(colorsSaved.vwap === '#ABCDEF' && colorsSaved.up === colorsA.up.toUpperCase() && colorsSaved.down === colorsA.down.toUpperCase(), 'colors: pane A\'s preset and pane B\'s VWAP both saved: ' + JSON.stringify(colorsSaved));
  const linesBefore = await page.evaluate(() => [window.__a.chart.getDrawings()[0].price, window.__b.chart.getDrawings()[0].price]);
  await page.evaluate(() => { window.__a.destroy(); window.__b.destroy(); });
  await page.reload();
  await page.evaluate(() => {
    window.__calls = { A: 0, B: 0 };
    window.__urlA = () => { window.__calls.A++; return 'ws://' + location.host + '/ws?ticket=RA' + window.__calls.A + '-' + Math.random().toString(36).slice(2); };
    window.__urlB = () => { window.__calls.B++; return 'ws://' + location.host + '/ws?ticket=RB' + window.__calls.B + '-' + Math.random().toString(36).slice(2); };
    window.__a = ChartLive.mount(document.getElementById('paneA'), { wsUrl: window.__urlA, paneId: 'main', storagePrefix: 'desk:' });
    window.__b = ChartLive.mount(document.getElementById('paneB'), { wsUrl: window.__urlB, paneId: 'pane-2', storagePrefix: 'desk:' });
  });
  await until(async () => await paneLive('paneA') && await paneLive('paneB'), 'both panes live after a reload');
  const linesAfter = await page.evaluate(() => [window.__a.chart.getDrawings().map(d => d.price), window.__b.chart.getDrawings().map(d => d.price)]);
  check(linesAfter[0].length === 1 && linesAfter[1].length === 1 && linesAfter[0][0] === linesBefore[0] && linesAfter[1][0] === linesBefore[1] && linesBefore[0] !== linesBefore[1],
    'each pane\'s line survives a reload and remount: ' + JSON.stringify(linesAfter));
  const vwapAfter = await page.evaluate(() => [window.__a.chart.getTheme().vwap, window.__b.chart.getTheme().up]);
  check(vwapAfter[0].toUpperCase() === '#ABCDEF' && vwapAfter[1].toUpperCase() === colorsA.up.toUpperCase(), 'colors from both panes come back: ' + JSON.stringify(vwapAfter));
  const sentTypes2 = await page.evaluate(() => [...new Set(window.__spy.sockets.flatMap(s => s.sent.map(d => JSON.parse(d).type)))]);
  rec = await control(PORT, 'received');
  check(sentTypes2.every(t => t === 'subscribe' || t === 'ping') && Object.keys(rec.types).every(t => t === 'subscribe' || t === 'ping') && rec.sessionRequests === 0, 'two panes: still only subscribe and ping, no /session: ' + JSON.stringify(rec.types));
  await page.evaluate(() => { window.__a.destroy(); window.__b.destroy(); });

  /* ---------------- storagePrefix: the standalone page and the embedded chart keep their own settings */
  {
    // instrument, bars and range settings are saved per prefix (the last pane to change them wins); indicators per pane
    const deskBefore = await page.evaluate(() => localStorage.getItem('desk:live-settings-v2'));
    const sa = await ctx.newPage();
    sa.on('pageerror', e => fail('standalone pageerror: ' + e.message));
    await sa.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await sa.goto(`http://localhost:${PORT}/live/`);             // no ticket: the standalone page is refused by --tickets,
    await unlockIfAsked(sa);                                     // (after its PIN, ChartBridge 0.3.2)
    await sa.waitForTimeout(300);                                // but its controls and storage work the same offline
    await sa.click('#symSeg >> text="NQ"'); await sa.click('#tfSeg >> text="Range"');
    await sa.fill('#rangeTicks', '40'); await sa.press('#rangeTicks', 'Enter');
    await sa.click('#indBtn'); await sa.click('#indPanel [data-f="sw:levels"]'); await sa.keyboard.press('Escape');
    await sa.waitForTimeout(300);
    // the embedded chart (prefix desk:) still starts as it was left, on its own keys
    await page.evaluate(() => { window.__a = ChartLive.mount(document.getElementById('paneA'), { wsUrl: window.__urlA, paneId: 'main', storagePrefix: 'desk:' }); });
    await until(() => paneLive('paneA'), 'pane A live next to the standalone page');
    const emb = await page.evaluate(() => ({ root: document.querySelector('#paneA [aria-label="Instrument"] [aria-pressed="true"]').dataset.v, tf: document.querySelector('#paneA [id$="-tfSeg"] [aria-pressed="true"]').dataset.v, layers: window.__a.chart.getLayers() }));
    const want = JSON.parse(deskBefore);
    check(await page.evaluate(() => localStorage.getItem('desk:live-settings-v2')) === deskBefore && emb.root === want.root && emb.tf === want.tf && emb.layers.levels === true && emb.layers.vwap === false,
      'embedded settings untouched by the standalone page: ' + JSON.stringify(emb) + ' saved ' + deskBefore);
    // and the other way: an embedded change does not reach the standalone page
    await page.click('#paneA [aria-label="Instrument"] >> text="MES"');
    await page.click('#paneA .ce-theme-btn'); await page.click('#paneA .ce-preset[data-id="mint"]'); await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await sa.reload(); await unlockIfAsked(sa); await sa.waitForTimeout(500);
    const st = await sa.evaluate(() => ({ root: document.querySelector('#symSeg [aria-pressed="true"]').dataset.v, tf: document.querySelector('#tfSeg [aria-pressed="true"]').dataset.v, range: document.getElementById('rangeTicks').value, levels: window.liveChart.getLayers().levels, colors: localStorage.getItem('live-colors-v1') }));
    check(st.root === 'NQ' && st.tf === 'range' && st.range === '40' && st.levels === false && st.colors === null, 'standalone settings untouched by the embedded chart: ' + JSON.stringify(st));
    const keys = await page.evaluate(() => Object.keys(localStorage).sort());
    const embedKeys = keys.filter(k => k.startsWith('desk:'));
    const standaloneKeys = keys.filter(k => !k.startsWith('desk:'));
    check(embedKeys.includes('desk:live-settings-v2') && embedKeys.includes('desk:live-indicators-v2') && embedKeys.includes('desk:live-colors-v1'), 'embedded keys carry the prefix: ' + embedKeys.join(','));
    check(standaloneKeys.length > 0 && standaloneKeys.every(k => /^live-/.test(k)), 'standalone keys are unprefixed: ' + standaloneKeys.join(','));
    const deskSettings = await page.evaluate(() => JSON.parse(localStorage.getItem('desk:live-settings-v2')));
    check(deskSettings.root === 'MES', 'embedded instrument saved under the prefix: ' + JSON.stringify(deskSettings));
    await page.evaluate(() => window.__a.destroy());
    await sa.close();
  }
  await page.close();

  /* ---------------- a plain string wsUrl against ChartBridge 0.2 (protocol v1), and no storagePrefix given */
  await startBridge(PORT + 1, ['--v1']);
  {
    const p2 = await ctx.newPage();
    p2.on('pageerror', e => fail('v1 pageerror: ' + e.message));
    await p2.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await p2.goto(`http://localhost:${PORT + 1}/test/embed-host.html`);
    await p2.evaluate(port => {
      localStorage.clear();
      // saved by 1.5.3 under this prefix: carried over once to live-indicators-v2 (1.6.0), VWAP's explicit off kept
      localStorage.setItem(ChartLive.EMBED_PREFIX + 'live-indicators-v1', JSON.stringify({ main: { volume: true, vwap: false, levels: true, fills: true, ib: true } }));
      document.getElementById('paneB').hidden = true; window.__a = ChartLive.mount(document.getElementById('paneA'), { wsUrl: 'ws://localhost:' + port + '/ws' });
    }, PORT + 1);
    await p2.waitForFunction(() => { const el = document.querySelector('#paneA .pill[id$="-connPill"]'); return el && el.textContent === 'LIVE'; }, null, { timeout: 15000 });
    await p2.click('#paneA .seg >> text="5m"'); await p2.waitForTimeout(300);
    const keys = await p2.evaluate(() => Object.keys(localStorage)), prefix = await p2.evaluate(() => ChartLive.EMBED_PREFIX);
    check(prefix && keys.length > 0 && keys.every(k => k.startsWith(prefix)), 'string wsUrl on ChartBridge 0.2 works; with no storagePrefix every key starts with "' + prefix + '": ' + keys.join(','));
    check(await p2.evaluate(() => { try { ChartLive.mount(document.getElementById('paneB'), {}); return false; } catch (e) { return /wsUrl/.test(e.message); } }), 'mount without wsUrl throws');
    const mig = await p2.evaluate(() => ({ layers: window.__a.chart.getLayers(), count: document.querySelector('#paneA .ind-count').textContent, v2: JSON.parse(localStorage.getItem(ChartLive.EMBED_PREFIX + 'live-indicators-v2')), plain: localStorage.getItem('live-indicators-v2') }));
    check(mig.layers.vwap === false && mig.layers.volume === true && mig.count === '4/5' && mig.v2 && mig.v2.main.ind.vwap.on === true && mig.v2.main.ind.vwap.shown === false && mig.plain === null,
      'a 1.5.3 embed\'s indicators carried over under its own prefix, VWAP still off: ' + JSON.stringify(mig));
    // phone width: no sideways scroll
    await p2.setViewportSize({ width: 400, height: 820 });
    await p2.waitForTimeout(400);
    check(await p2.evaluate(() => document.documentElement.scrollWidth) <= 400, '400 px: no sideways scroll');
    await shot(p2, 'embed-phone.png');
    await p2.evaluate(() => window.__a.destroy());
    await p2.close();
  }

  /* ---------------- host on its own origin, connecting straight to the bridge: allowOrigins (ChartBridge 0.3.1) */
  {
    const HOST_PORT = PORT + 4;
    const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
    const host = http.createServer((req, res) => {                // a plain static server: another origin than the bridge
      const full = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
      fs.createReadStream(full).pipe(res);
    });
    await new Promise(r => host.listen(HOST_PORT, '127.0.0.1', r));
    const origin = 'http://localhost:' + HOST_PORT;
    await startBridge(PORT + 2, ['--allow-origins=' + origin, '--test-pin=' + TEST_PIN]);           // lists the host (and has a PIN)
    await startBridge(PORT + 3, ['--allow-origins=http://localhost:1', '--test-pin=' + TEST_PIN]);  // lists someone else
    try {
      const p3 = await ctx.newPage();
      const p3req = [];
      p3.on('request', r => p3req.push(r.url()));
      p3.on('pageerror', e => fail('cross-origin pageerror: ' + e.message));
      await p3.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
      await p3.goto(origin + '/test/embed-host.html');
      await p3.evaluate(port => {
        document.getElementById('paneB').hidden = true; window.__st = [];
        window.__a = ChartLive.mount(document.getElementById('paneA'), { wsUrl: 'ws://localhost:' + port + '/ws', storagePrefix: 'desk:', onStatus: s => window.__st.push(s.state) });
      }, PORT + 3);
      await until(() => p3.evaluate(() => window.__st.filter(s => s === 'offline').length >= 2), 'not listed: refused, offline after each try');
      const diag3 = await (await fetch(`http://127.0.0.1:${PORT + 3}/diag`)).json();
      const pill3 = await p3.textContent('#paneA .pill[id$="-connPill"]');
      check(!(await p3.evaluate(() => window.__st.includes('live'))) && diag3.network.refusedOrigin >= 2 && /CONNECTING|OFFLINE/.test(pill3),
        'host origin not in allowOrigins: refused (' + diag3.network.refusedOrigin + ' refusals), never live, pill ' + pill3);
      await p3.evaluate(port => {
        window.__a.destroy(); window.__st = [];
        window.__a = ChartLive.mount(document.getElementById('paneA'), { wsUrl: 'ws://localhost:' + port + '/ws', storagePrefix: 'desk:', onStatus: s => window.__st.push(s.state) });
      }, PORT + 2);
      await until(() => p3.evaluate(() => window.__st.includes('live')), 'listed in allowOrigins: connects', 10000);
      const diag2 = await (await fetch(`http://127.0.0.1:${PORT + 2}/diag`)).json();
      check(await p3.evaluate(() => window.__a.chart.bars().length > 100) && diag2.network.refusedOrigin === 0, 'host origin in allowOrigins: live with bars, no refusals');
      check(diag2.pin.set === true && !(await p3.$('.cb-pin')) && !p3req.some(u => /\/pin\//.test(u)), 'ChartBridge has a PIN set: the allowOrigins host is live with no PIN pad and no /pin/ request');
      await p3.evaluate(() => window.__a.destroy());
      await p3.close();
    } finally { host.close(); host.closeAllConnections(); }
  }
  await ctx.close();
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}
if (errors.length) { console.error('FAIL (' + errors.length + ' of ' + checks + ' checks)\n' + errors.join('\n')); process.exit(1); }
console.log('embed smoke: ok (' + checks + ' checks)');
