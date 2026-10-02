// Workspace smoke test (live/index.html, ChartBridge's main page since E2a) against the fake bridge, in Chromium: the
// default layout (4 charts, the order ticket's place, Time and Sales), one WebSocket per instrument (not per panel) and
// one subscribe each, the slim chart headers (instrument and bars changed from the header, Indicators, the small menu),
// Settings (Glide, Range style, hotkeys, large prints, Change PIN), Colors in the top bar for every chart, the update
// notice in the top bar, settings shared with the single chart page (/single.html), "/" opening the workspace, drag and
// resize snapping to cells, an overlap refused, add and close, the layout kept over a reload, ?layout=Second as a
// separate layout, New layout / Rename / Delete, the tape (newest first, sides, large prints), a dropped connection, only
// read-only messages sent, and a window resize keeping every panel on screen. Sample data only.
// Screenshots in test/out/ (and SHOTS_DIR when set) at 1920x1080, 2560x1440 and 1366x768.
//   npm run smoke:workspace        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { run as ticketPart } from './workspace-ticket-part.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PORT = +(process.env.WORKSPACE_SMOKE_PORT || 8814);
const URL0 = `http://localhost:${PORT}/live/`;
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

/* Before any page script: record every WebSocket, what it sends and whether it is open. */
function spies() {
  const S = window.__spy = { sockets: [] };
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
}
/* every socket opened since the page loaded: the instruments it subscribed to, open or not */
const allSockets = page => page.evaluate(() => window.__spy.sockets.map(k => ({ open: k.sock.readyState === 1, subs: k.sent.map(d => JSON.parse(d)).filter(m => m.type === 'subscribe').map(m => m.root), auth: k.sent.some(d => JSON.parse(d).type === 'auth') })));
/* the instruments' connections (1.12.0: each window also has its own order connection, which subscribes to nothing) */
const sockets = async page => (await allSockets(page)).filter(k => !k.auth);

const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--test-controls', '--live-rate=150', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  // the per-PC updater installed new page files after this page loaded: "Update ready: reload when flat"
  await ctx.route(/\/update\.json$/, r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ schema: 1,
    page: { version: '1.12.0', build: 'b2', installedAt: Date.now() + 3600000, state: '' }, chartBridge: { compiled: '0.3.5', ready: null, copied: null, mixed: null }, updater: null }) }));
  await ctx.addInitScript(spies);
  // the single chart page's own instrument and bars, which the workspace must never change
  await ctx.addInitScript(() => { try { if (!localStorage.getItem('live-settings-v2')) localStorage.setItem('live-settings-v2', JSON.stringify({ root: 'NQ', tf: 'm5', glide: 'smooth', rangeMode: 'nt' })); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));

  /* Open a URL, type the PIN on ChartBridge's pad (the page's own origin needs it, like the single chart page), wait for live. */
  async function open(url, p = page) {
    await p.goto(url);
    await p.waitForSelector('.cb-pin-key', { timeout: 15000 });
    await enterPin(p, TEST_PIN);
    await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  }
  const state = () => page.evaluate(() => ({ layout: window.workspace.layout, panels: window.workspace.panels(), views: window.workspace.views(), search: location.search, feed: window.workspace.feed() }));
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('live-workspace-v1')));
  const box = id => page.evaluate(i => { const r = document.querySelector(`.ws-panel[data-id="${i}"]`).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, id);
  const head = id => page.evaluate(i => { const r = document.querySelector(`.ws-panel[data-id="${i}"] .ws-grip`).getBoundingClientRect(); return { x: r.x + 4, y: r.y + r.height / 2 }; }, id);
  const pitch = () => page.evaluate(() => { const g = document.getElementById('wsGrid'); return { x: (g.clientWidth - 12 - 66) / 12 + 6, y: (g.clientHeight - 12 - 30) / 6 + 6 }; });
  const allLive = () => page.waitForFunction(() => window.workspace.views().every(v => v.state === null || v.state === 'live'), null, { timeout: 20000 });

  console.log('"/" is the workspace');
  await open(`http://localhost:${PORT}/`);
  check(await page.evaluate(() => !!document.getElementById('wsGrid') && !document.getElementById('connPill')), '"/" opens the workspace (index.html)');

  console.log('default layout');
  await open(URL0);
  let s = await state();
  check(s.layout === 'Main' && s.search === '?layout=Main', 'no ?layout opens Main and puts it in the URL (' + s.search + ')');
  check(s.views.length === 6 && s.views.filter(v => v.type === 'chart').length === 4 && s.views.filter(v => v.type === 'tape').length === 1 && s.views.filter(v => v.type === 'ticket').length === 1, '6 panels: 4 charts, the order ticket, Time and Sales');
  check(s.views.every(v => v.state === null || v.state === 'live'), 'every chart and the tape live');
  const byKey = k => s.panels.find(p => p.type + ':' + (p.root || '') + ':' + (p.tf || '') === k);
  const main = byKey('chart:MNQ:range'), nq = byKey('chart:NQ:m5'), es = byKey('chart:ES:m1'), daily = byKey('chart:MNQ:h1'), tape = byKey('tape:MNQ:'), ticket = byKey('ticket::');
  check(main && main.range === 40 && main.x === 0 && main.y === 0 && main.w === 7 && main.h === 4, 'MNQ Range 40: cols 1 to 7, rows 1 to 4');
  check(daily && daily.x === 0 && daily.y === 4 && daily.w === 7 && daily.h === 2, 'MNQ under it: cols 1 to 7, rows 5 to 6');
  check(nq && nq.x === 7 && nq.y === 0 && nq.w === 3 && nq.h === 3 && es && es.x === 7 && es.y === 3 && es.w === 3 && es.h === 3, 'NQ 5 min (cols 8 to 10, rows 1 to 3) and ES 1 min (rows 4 to 6)');
  check(ticket && ticket.x === 10 && ticket.y === 0 && ticket.w === 2 && ticket.h === 3, 'the order ticket: cols 11 to 12, rows 1 to 3 (1.12.0: it fits at 1366x768)');
  check(tape && tape.x === 10 && tape.y === 3 && tape.w === 2 && tape.h === 3, 'Time and Sales: cols 11 to 12, rows 4 to 6 (it gives up a row)');
  check(s.panels.every(p => !('exec' in p)), 'no execution chart');
  const ui = await page.evaluate(ids => {
    const P = id => document.querySelector(`.ws-panel[data-id="${id}"]`);
    const tk = P(ids.ticket);
    return { ticketText: tk.querySelector('.ws-body').textContent, ticketCtl: tk.querySelectorAll('.ws-body button, .ws-body input, .ws-body select').length, ticketName: tk.querySelector('.ws-name').textContent,
      obar: !!document.querySelector('[id$="obar"], [id$="armBtn"], [id$="buyMkt"]'), dailyTf: P(ids.daily).querySelector('.ws-tf').textContent, dailyTitle: P(ids.daily).querySelector('.ws-view').title,
      names: [...document.querySelectorAll('.ws-panel .ws-name')].map(e => e.textContent), flattenSlot: !!document.getElementById('wsFlat') && !!document.getElementById('wsKeys'),
      clock: document.getElementById('wsClock').textContent, topH: document.querySelector('.ws-top').offsetHeight };
  }, { ticket: ticket.id, daily: daily.id });
  const tkInfo = await page.evaluate(() => window.workspace.ticket());
  check(tkInfo.held && !tkInfo.armed && /Buy MKT/.test(ui.ticketText) && ui.ticketCtl > 10 && ui.ticketName === 'Order ticket', 'the window opened with no other ticket around: it took the ticket, Armed off (Anthony)');
  check(/Trading off/.test(ui.ticketText), 'trading is off on this ChartBridge: the ticket says so (' + ui.ticketText.replace(/\s+/g, ' ').slice(-90) + ')');
  check(!ui.obar, 'no order bar inside any chart (the order ticket is its own panel)');
  check(ui.dailyTf === '1 hour' && /ChartBridge 0\.3\.7/.test(ui.dailyTitle), 'the long chart is labelled 1 hour, not Daily (ChartBridge 0.3.7 brings daily bars)');
  check(ui.names.includes('MNQ 12-26') && ui.names.includes('Time and Sales'), 'headers show the contract (' + ui.names.join(', ') + ')');
  check(ui.flattenSlot && /^\d\d:\d\d:\d\d$/.test(ui.clock) && ui.topH === 40, 'top bar 40 px, New York clock ' + ui.clock + ', Flatten all and KEYS in it');
  const paneIds = await page.evaluate(() => [...document.querySelectorAll('.ws-panel[data-type="chart"] [data-pane]')].map(e => e.dataset.pane));
  check(paneIds.length === 4 && new Set(paneIds).size === 4 && paneIds.every(id => s.panels.some(p => p.id === id)), 'each chart has its own paneId, the panel id');
  const ind = await page.evaluate(() => JSON.parse(localStorage.getItem('live-indicators-v2') || '{}'));
  check(ind[main.id] && ind[main.id].ind.vwap.on && !ind[nq.id], 'the first chart starts with the single chart page\'s indicators, the others with none');

  const sessions = async () => (await (await fetch(`http://127.0.0.1:${PORT}/test/received`, { method: 'POST' })).json()).sessionRequests;
  check(await sessions() === 2, 'each window load signs in once for its own order connection (GET /session): ' + await sessions());

  console.log('one connection per instrument');
  let k = await sockets(page);
  const subsOf = r => k.flatMap(x => x.subs).filter(x => x === r).length;
  check(k.length === 3 && k.every(x => x.open), 'three WebSockets for six panels: one per instrument (' + k.map(x => x.subs.join('+')).join(', ') + ')');
  check((await allSockets(page)).filter(x => x.auth && x.open && !x.subs.length).length === 1, 'and one order connection for the window, which subscribes to nothing');
  check(subsOf('MNQ') === 1 && subsOf('NQ') === 1 && subsOf('ES') === 1, 'one subscribe per instrument (MNQ feeds two charts and the tape)');
  check(s.feed.lines.find(l => l.root === 'MNQ').clients === 4, 'the MNQ connection feeds 3 panels and the order ticket\'s price (1.12.0)');
  await page.waitForTimeout(1500);
  const counts = await page.evaluate(() => [...document.querySelectorAll('.ws-panel[data-type="chart"] [id$="ticksSeen"]')].map(e => +e.textContent.replace(/\D/g, '')));
  check(counts.every(n => n > 0), 'every chart takes live trades from it (' + counts.join(', ') + ')');

  console.log('slim headers');
  const hd = await page.evaluate(() => [...document.querySelectorAll('.ws-panel[data-type="chart"]')].map(p => {
    const h = p.querySelector('.ws-head'), bar = p.querySelector('.chart-live > header.bar');
    return { grip: !!h.querySelector('.ws-grip'), view: !!h.querySelector('.ws-view .ws-name') && !!h.querySelector('.ws-view .ws-tf'), ind: !!h.querySelector('.ind-btn'), more: !!h.querySelector('[data-act="more"]'), x: !!h.querySelector('[data-act="close"]'),
      bar: bar ? getComputedStyle(bar).display : 'none', h: h.offsetHeight, colorsInBar: !!p.querySelector('.chart-live > header.bar .ce-theme-btn') };
  }));
  check(hd.every(x => x.grip && x.view && x.ind && x.more && x.x), 'every chart header: handle, instrument and bars, Indicators, the small menu, the x');
  check(hd.every(x => x.bar === 'none' && x.h === 28), 'the chart\'s own toolbar is not shown; the header is 28 px');
  const chips = await page.evaluate(id => [...document.querySelectorAll(`.ws-panel[data-id="${id}"] .ws-head .ind-chip[data-id]`)].map(c => c.textContent), main.id);
  check(chips.join(' ') === 'VO VW LV IB FL', 'the main chart\'s pinned indicators as 2-letter chips in its header (' + chips.join(' ') + ')');
  const vw = `.ws-panel[data-id="${main.id}"] .ws-head .ind-chip[data-id="vwap"]`;
  await page.click(vw);
  const vwSaved = await page.evaluate(id => { const v = JSON.parse(localStorage.getItem('live-indicators-v2') || '{}')[id]; return v ? v.ind.vwap.shown : 'none: ' + Object.keys(JSON.parse(localStorage.getItem('live-indicators-v2') || '{}')).join(','); }, main.id);
  check(await page.getAttribute(vw, 'aria-pressed') === 'false' && vwSaved === false, 'a chip click hides that indicator, as the toolbar\'s chips do (' + vwSaved + ')');
  await page.click(vw);
  check(await page.getAttribute(vw, 'aria-pressed') === 'true', 'and shows it again');
  const one = await page.evaluate(() => ({ footers: [...document.querySelectorAll('.ws-body > .chart-live > .status')].map(f => getComputedStyle(f).display), feed: document.getElementById('wsFeed').textContent,
    local: document.getElementById('wsLocal').textContent, fps: document.getElementById('wsFps').textContent, tip: document.getElementById('wsStat').title }));
  check(one.footers.length === 4 && one.footers.every(d => d === 'none'), 'no status line under the charts');
  check(/ms( [A-Z]+)?$/.test(one.feed) && /ms$/.test(one.local) && /^(\d+ fps|idle)$/.test(one.fps) && /MNQ: feed/.test(one.tip) && /ES: feed/.test(one.tip), 'one status line in the top bar: feed ' + one.feed + ', local ' + one.local + ', ' + one.fps);
  const ib = `.ws-panel[data-id="${nq.id}"] .ws-head .ind-btn`;
  await page.click(ib);
  const im = await page.evaluate(id => { const p = document.querySelector(`.ws-panel[data-id="${id}"] .ind-panel`); const r = p.getBoundingClientRect(); return { open: !p.hidden, w: r.width, right: r.right, vw: innerWidth }; }, nq.id);
  check(im.open && im.w >= 300 && im.right <= im.vw, 'the header\'s Indicators button opens the chart\'s menu, inside the window (' + Math.round(im.w) + ' px)');
  await page.keyboard.press('Escape');
  await page.click(`.ws-panel[data-id="${nq.id}"] [data-act="more"]`);
  check(await page.evaluate(() => !document.getElementById('wsMore').hidden && [...document.querySelectorAll('#wsMore button')].map(b => b.textContent).join('|') === 'Trend line|Price line|Clear drawings|Reset view'), 'the small menu: Trend line, Price line, Clear drawings, Reset view');
  await page.click('#wsMore [data-tool="trend"]');
  await page.click(`.ws-panel[data-id="${nq.id}"] [data-act="more"]`);
  check(await page.getAttribute('#wsMore [data-tool="trend"]', 'aria-pressed') === 'true', 'Trend line is on for that chart');
  await page.click('#wsMore [data-do="reset"]');
  await shot(page, 'workspace-1920x1080.png');

  console.log('instrument and bars from the header');
  await page.click(`.ws-panel[data-id="${nq.id}"] .ws-view`);
  check(await page.evaluate(() => !document.getElementById('wsView').hidden), 'a click on the instrument opens its picker');
  await shot(page, 'workspace-view-picker.png');
  await page.click('#wsView [data-root="ES"]');
  await page.click('#wsView [data-tf="m15"]');
  check(await page.evaluate(() => !document.getElementById('wsView').hidden), 'the picker stays open while choosing');
  await page.keyboard.press('Escape');
  await page.waitForFunction(i => window.workspace.views().find(v => v.id === i).state === 'live', nq.id, { timeout: 15000 }).catch(() => fail('NQ panel not live on ES'));
  s = await state();
  let p1 = s.panels.find(p => p.id === nq.id);
  check(p1.root === 'ES' && p1.tf === 'm15', 'the panel changed to ES 15 min (' + p1.root + ' ' + p1.tf + ')');
  check((await saved()).layouts.Main.panels.find(p => p.id === nq.id).tf === 'm15', 'and it is saved in the layout');
  await page.waitForTimeout(500);
  check(await page.evaluate(i => { const p = document.querySelector(`.ws-panel[data-id="${i}"]`); return p.querySelector('.ws-name').textContent.startsWith('ES') && p.querySelector('.ws-tf').textContent === '15 min'; }, nq.id), 'the header follows');
  k = await sockets(page);
  check(k.filter(x => x.open).length === 2 && k.filter(x => x.open && x.subs[0] === 'ES').length === 1, 'NQ has no panel left: its connection closed; ES still one connection (' + k.filter(x => x.open).length + ' open)');
  check(subsOf('ES') === 1, 'the ES chart joined the ES connection without a second subscribe');
  await page.click(`.ws-panel[data-id="${nq.id}"] .ws-view`);
  await page.click('#wsView [data-tf="range"]');
  await page.fill('#wsView [data-f="range"]', '12');
  await page.press('#wsView [data-f="range"]', 'Enter');
  await page.keyboard.press('Escape');
  s = await state(); p1 = s.panels.find(p => p.id === nq.id);
  check(p1.tf === 'range' && p1.range === 12, 'Range bars of 12 ticks from the header (' + p1.tf + ' ' + p1.range + ')');
  check(await page.evaluate(i => document.querySelector(`.ws-panel[data-id="${i}"] .ws-tf`).textContent, nq.id) === 'Range 12', 'the header says Range 12');
  const single = await page.evaluate(() => ({ s: JSON.parse(localStorage.getItem('live-settings-v2')), r: JSON.parse(localStorage.getItem('live-range-v2') || '{}') }));
  check(single.s.root === 'NQ' && single.s.tf === 'm5' && single.r.ES !== 12, 'the single chart page\'s instrument, bars and range sizes are untouched (' + single.s.root + ' ' + single.s.tf + ')');
  await page.click(`.ws-panel[data-id="${nq.id}"] .ws-view`);
  await page.click('#wsView [data-root="NQ"]');
  await page.click('#wsView [data-tf="m5"]');
  await page.keyboard.press('Escape');
  await allLive();

  console.log('Settings');
  await page.click('#wsSet');
  const st = await page.evaluate(() => ({ glide: [...document.querySelectorAll('#wsGlide button')].map(b => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')).join('|'),
    range: [...document.querySelectorAll('#wsRangeMode option')].map(o => o.textContent).join('|'), pin: !document.getElementById('wsPinSec').hidden && document.getElementById('wsPin').textContent,
    floors: document.querySelectorAll('#wsFloors input').length, hk: [...document.querySelectorAll('#wsHotkeys .hk-name')].map(e => e.textContent).join('|'), reset: !!document.getElementById('wsReset'),
    fits: (() => { const r = document.getElementById('wsSettings').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.left >= 0; })() }));
  check(st.glide === 'Smooth*|Fast|Off', 'Settings: Glide (' + st.glide + ')');
  check(st.range === 'NinjaTrader|Traded prices only', 'Settings: Range style');
  check(st.pin === 'Change PIN', 'Settings: Change PIN (ChartBridge has a PIN)');
  check(st.floors === 8, 'Settings: the large-print floors, RTH and overnight for 4 instruments');
  check(st.hk === 'Buy MKT|Sell MKT|B/E|Close|Flatten all', 'Settings: the hotkeys of the single chart page (' + st.hk + ')');
  check(st.reset && st.fits, 'Settings: Reset layout, and the panel fits the window (it scrolls inside)');
  await shot(page, 'workspace-settings.png');
  await page.click('#wsGlide [data-v="fast"]');
  await page.selectOption('#wsRangeMode', 'traded');
  await page.click('#wsHk-buy');
  await page.keyboard.press('Alt+B');
  check((await page.textContent('#wsHkNote-buy')) === 'Saved.', 'a hotkey is set by pressing it in its box');
  await page.keyboard.press('Escape');
  check(!(await page.evaluate(() => document.getElementById('wsSettings').hidden)), 'Escape in a hotkey box is read as a key, Settings stays open');
  await page.click('#wsGrid', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => { localStorage.setItem('live-tape-floors-v1', JSON.stringify({})); });
  await page.click('#wsSet');
  await page.fill('#wsFloors input[data-root="MNQ"][data-w="rth"]', '4');
  await page.fill('#wsFloors input[data-root="MNQ"][data-w="eth"]', '4');
  await page.click('#wsHk-be');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => document.getElementById('wsSettings').hidden), 'Escape closes Settings');
  const kept = await page.evaluate(() => ({ s: JSON.parse(localStorage.getItem('live-settings-v2')), hk: JSON.parse(localStorage.getItem('live-hotkeys-v1')), fl: JSON.parse(localStorage.getItem('live-tape-floors-v1')) }));
  check(kept.s.glide === 'fast' && kept.s.rangeMode === 'traded' && kept.s.root === 'NQ' && kept.s.tf === 'm5', 'Glide and Range style saved where the single chart page keeps them (its instrument and bars untouched)');
  check(kept.hk && kept.hk.buy === 'Alt+B', 'the hotkey saved where the single chart page keeps them');
  check(kept.fl.MNQ.rth === 4, 'large-print floors set in Settings are saved');

  console.log('Colors in the top bar');
  check(await page.evaluate(() => !!document.querySelector('#wsColors .ce-theme-btn') && document.querySelectorAll('.ws-top .ce-theme-btn').length === 1), 'one Colors button, in the top bar');
  await page.click('#wsColors .ce-theme-btn');
  await shot(page, 'workspace-colors.png');
  const pre = await page.evaluate(() => [...document.querySelectorAll('#wsColors .ce-preset')].map(b => b.dataset.id));
  await page.click(`#wsColors .ce-preset[data-id="${pre[pre.length - 1]}"]`);
  await page.waitForTimeout(200);
  const ups = await page.evaluate(() => [...document.querySelectorAll('.ws-body > .chart-live:not(.tk)')].map(e => e.style.getPropertyValue('--up-text')));
  check(ups.length === 4 && new Set(ups).size === 1 && ups[0] !== '', 'a preset picked there colors every chart at once (' + ups[0] + ')');
  await page.click('#wsColors .ce-reset');
  await page.keyboard.press('Escape');

  console.log('the update notice');
  await page.evaluate(() => window.ChartUpdateNotice && window.ChartUpdateNotice.checkNow());
  await page.waitForFunction(() => { const n = document.getElementById('updNote'); return n && !n.hidden; }, null, { timeout: 5000 }).catch(() => {});
  const un = await page.evaluate(() => { const n = document.getElementById('updNote'); return n ? { text: n.querySelector('[role=status]').textContent, top: !!n.closest('#wsUpdate'), inChart: !!n.closest('.chart-live') } : null; });
  check(un && un.top && !un.inChart && /Update ready: reload when flat/.test(un.text), '"Update ready: reload when flat" in the top bar (' + (un && un.text) + ')');

  console.log('settings shared with the single chart page');
  const sp = await ctx.newPage();
  sp.on('pageerror', e => fail('single page error: ' + e.message));
  await sp.goto(`http://localhost:${PORT}/live/single.html`);
  await sp.waitForSelector('.cb-pin-key', { timeout: 15000 }).then(() => enterPin(sp, TEST_PIN)).catch(() => {});
  await sp.waitForFunction(() => document.getElementById('connPill') && document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 30000 }).catch(() => fail('single page not live'));
  const sv = await sp.evaluate(() => ({ grid: !!document.getElementById('wsGrid'), sym: document.querySelector('#symSeg [aria-pressed="true"]').dataset.v, tf: document.querySelector('#tfSeg [aria-pressed="true"]').dataset.v,
    glide: document.querySelector('#glideSeg [aria-pressed="true"]').dataset.v, mode: document.getElementById('rangeMode').value, toolbar: getComputedStyle(document.querySelector('header.bar')).display }));
  check(!sv.grid && sv.toolbar !== 'none', '/single.html is the single chart page with its toolbar');
  check(sv.sym === 'NQ' && sv.tf === 'm5', 'it opens on its own instrument and bars (' + sv.sym + ' ' + sv.tf + ')');
  const sl = await sp.evaluate(() => { const vis = id => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none' && e.offsetHeight > 0; };
    return { src: vis('lgSrc') && /ChartBridge .*chart \d/.test(document.getElementById('lgSrc').textContent), pill: vis('connPill'), time: vis('lgTime'), grid: getComputedStyle(document.getElementById('legend')).display,
      status: vis('dFeed') && vis('fps') && getComputedStyle(document.querySelector('footer.status')).display !== 'none' }; });
  check(sl.src && sl.pill && sl.time && sl.grid === 'grid' && sl.status, 'the single chart page keeps its full legend (source line, LIVE, bar time) and its status line');
  check(sv.glide === 'fast' && sv.mode === 'traded', 'with the Glide and Range style set in the workspace');
  // and back: Glide set on the single chart page reaches the workspace's charts
  await sp.click('#setBtn'); await sp.click('#glideSeg [data-v="off"]'); await sp.keyboard.press('Escape');   // 1.14.0: Glide in the page's Settings
  await page.waitForTimeout(300);
  await page.click('#wsSet');
  check(await page.evaluate(() => document.querySelector('#wsGlide [aria-pressed="true"]').dataset.v) === 'off', 'Glide set on the single chart page shows in the workspace\'s Settings');
  await page.keyboard.press('Escape');
  await sp.close();
  const sess0 = await sessions();                          // each page load (the workspace's and the single chart page's) signs in once
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('live-settings-v2')); s.glide = 'smooth'; s.rangeMode = 'nt'; localStorage.setItem('live-settings-v2', JSON.stringify(s)); localStorage.removeItem('live-hotkeys-v1'); });

  console.log('Time and Sales');
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
      // 1.14.0: with ChartBridge 0.3.8's q each row has its category's color (its own test: smoke:display); without, its side
      q: rs.filter(r => /\bq(m?\d)\b/.test(r.className)).length,
      buy: rs.filter(r => r.classList.contains('buy') && !r.classList.contains('big')).map(col)[0], sell: rs.filter(r => r.classList.contains('sell') && !r.classList.contains('big')).map(col)[0],
      big: rs.filter(r => r.classList.contains('big')).length, bigBold: rs.filter(r => r.classList.contains('big')).every(r => +getComputedStyle(r).fontWeight >= 700),
      bigBg: rs.filter(r => r.classList.contains('big')).every(r => !/rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(r).backgroundColor)),
      small: rs.filter(r => !r.classList.contains('big')).every(r => +r.querySelector('.tp-v').textContent < 4),
      bigOk: rs.filter(r => r.classList.contains('big')).every(r => +r.querySelector('.tp-v').textContent >= 4), dom: list.children.length };
  });
  check(tp.n > 10 && tp.dom === tp.fit, 'only the rows that fit are in the page (' + tp.dom + ' rows for ' + tp.fit + ' visible)');
  check(tp.times.every((t, i) => i === 0 || t <= tp.times[i - 1]), 'times run newest first');
  check(tp.q === tp.n || (tp.buy === 'rgb(61, 220, 151)' && tp.sell === 'rgb(255, 92, 122)'), tp.q === tp.n ? 'every row by its Time and Sales category (ChartBridge 0.3.8)' : 'buys green, sells red');
  check(tp.big > 0 && tp.bigOk && tp.small && tp.bigBg && tp.bigBold, 'large prints (size 4 or more here) bold on a tint of their color, ' + tp.big + ' on screen');
  const keptN = await page.evaluate(() => window.workspace.views().find(v => v.type === 'tape').count);
  check(keptN <= 500, 'at most 500 trades kept (' + keptN + ')');
  await shot(page, 'workspace-tape.png');

  console.log('a dropped connection');
  await control('drop');
  await page.waitForFunction(() => !document.getElementById('wsConn').classList.contains('live'), null, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 }).catch(() => fail('not live again after the drop'));
  k = await sockets(page);
  const openNow = k.filter(x => x.open);
  check(openNow.length === 3 && new Set(openNow.map(x => x.subs[0])).size === 3, 'back with one connection per instrument (' + openNow.map(x => x.subs.join('+')).join(', ') + ')');

  console.log('drag, resize, overlap, close, add');
  let pt = await pitch();
  let h0 = await head(nq.id);
  await page.mouse.move(h0.x, h0.y); await page.mouse.down();
  await page.mouse.move(h0.x - pt.x * 3, h0.y + 10, { steps: 6 });
  const blocked = await page.evaluate(() => { const g = document.getElementById('wsGhost'); return !g.hidden && g.classList.contains('blocked'); });
  check(blocked, 'dragging onto the MNQ chart shows the ghost blocked');
  await shot(page, 'workspace-blocked.png');
  await page.mouse.up();
  s = await state();
  let nq2 = s.panels.find(p => p.id === nq.id);
  check(nq2.x === 7 && nq2.y === 0, 'dropped on another panel: put back');
  check(await page.evaluate(() => document.getElementById('wsGhost').hidden), 'the ghost is gone after the drop');

  await page.click(`.ws-panel[data-id="${es.id}"] .ws-x`);
  s = await state();
  check(s.views.length === 5 && !s.panels.some(p => p.id === es.id), 'the ES panel closes with its x');
  check((await saved()).layouts.Main.panels.length === 5, 'the close is saved');
  check(s.feed.lines.every(l => l.root !== 'ES' || l.clients === 0) && (await sockets(page)).filter(x => x.open).length === 2, 'its instrument\'s connection closes with it');

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
  check(await page.evaluate(() => document.getElementById('wsGhost').classList.contains('blocked')), 'a resize over the ticket and the tape is blocked');
  await page.mouse.up();
  s = await state(); nq2 = s.panels.find(p => p.id === nq.id);
  check(nq2.w === 2, 'and put back');
  await page.mouse.move(c2.x, c2.y); await page.mouse.down();
  await page.mouse.move(c2.x - pt.x * 3, c2.y - pt.y * 9, { steps: 4 });
  await page.mouse.up();
  s = await state(); nq2 = s.panels.find(p => p.id === nq.id);
  check(nq2.w === 2 && nq2.h === 1, 'never smaller than 2 x 1');

  await page.click('#wsAdd');
  check(await page.isDisabled('#wsAddMenu [data-add="ticket"]'), 'Add panel: Order ticket is off while the layout has one');
  await page.click('[data-add="tape"]');
  s = await state();
  const added = s.panels[s.panels.length - 1];
  check(s.views.length === 6 && added.type === 'tape' && added.x === 7 && added.y === 2 && added.w === 3 && added.h === 4, 'Add panel puts a tape in the largest free rectangle (' + [added.x, added.y, added.w, added.h] + ')');
  await page.click('#wsAdd'); await page.click('[data-add="chart"]');
  s = await state();
  const added2 = s.panels[s.panels.length - 1];
  check(s.views.length === 7 && added2.type === 'chart' && added2.w >= 2, 'Add panel: a chart in what is left (' + [added2.x, added2.y, added2.w, added2.h] + ')');
  await allLive().catch(() => fail('added panels not live'));
  check((await sockets(page)).filter(x => x.open).length === 2 && subsOf('MNQ') <= 2, 'the new MNQ panels join the MNQ connection');
  await page.click('#wsAdd'); await page.click('[data-add="chart"]');
  const full = await page.evaluate(() => ({ note: document.getElementById('wsNote').textContent, n: window.workspace.views().length }));
  check(full.n === 7 && full.note === 'No free space: close or shrink a panel', 'a full grid says so: "' + full.note + '"');

  console.log('instrument and timeframe per panel');
  await page.click(`.ws-panel[data-id="${added2.id}"] .ws-view`);
  await page.click('#wsView [data-root="ES"]');
  await page.click('#wsView [data-tf="m15"]');
  await page.keyboard.press('Escape');
  await page.selectOption(`.ws-panel[data-id="${added.id}"] select[data-act="root"]`, 'NQ');
  s = await state();
  const a2 = s.panels.find(p => p.id === added2.id), a1 = s.panels.find(p => p.id === added.id);
  check(a2.root === 'ES' && a2.tf === 'm15' && a1.root === 'NQ', 'a chart keeps its own instrument and bars, a tape its instrument');
  check(await page.evaluate(i => document.querySelector(`.ws-panel[data-id="${i}"] .ws-tf`).textContent, added2.id) === '15 min', 'the header follows the chart');
  await allLive().catch(() => fail('not live after the changes'));
  const layoutBefore = (await state()).panels;

  console.log('reload');
  await open(URL0 + '?layout=Main');
  s = await state();
  check(JSON.stringify(s.panels) === JSON.stringify(layoutBefore), 'a reload opens the same layout, panels, places and choices');
  const roots = await page.evaluate(() => [...document.querySelectorAll('.ws-panel[data-type="chart"]')].map(p => p.querySelector('[id$="symSeg"] [aria-pressed="true"]').dataset.v + ':' + p.querySelector('[id$="tfSeg"] [aria-pressed="true"]').dataset.v));
  check(JSON.stringify(roots) === JSON.stringify(s.panels.filter(p => p.type === 'chart').map(p => p.root + ':' + p.tf)), 'each chart mounts on its own instrument and bars (' + roots.join(', ') + ')');
  k = await sockets(page);
  check(k.length === 3 && subsOf('MNQ') === 1 && subsOf('NQ') === 1 && subsOf('ES') === 1, 'three instruments, three connections, one subscribe each (' + k.map(x => x.subs.join('+')).join(', ') + ')');

  console.log('?layout=Second');
  await open(URL0 + '?layout=Second');
  s = await state();
  check(s.layout === 'Second' && s.views.length === 6 && s.panels.every(p => !layoutBefore.some(q => q.id === p.id)), 'a new name opens the default layout with its own panel ids');
  const sto = await saved();
  check(Object.keys(sto.layouts).join() === 'Main,Second' && sto.layouts.Main.panels.length === 7, 'Main is left as it was');
  check(await page.evaluate(() => [...document.getElementById('wsLayout').options].map(o => o.textContent).join('|')) === 'Main|Second|──────|New layout...|Rename|Delete', 'the Layout select lists both, then New layout..., Rename, Delete');

  console.log('read only');
  const sent = await page.evaluate(() => window.__spy.sockets.map(k => k.sent.map(d => JSON.parse(d).type)));
  const feedSent = sent.filter(l => !l.includes('auth')).flat(), orderSent = sent.filter(l => l.includes('auth')).flat();
  check(feedSent.length > 0 && feedSent.every(t => t === 'subscribe' || t === 'ping'), 'the instruments\' connections send only subscribe (and ping): ' + [...new Set(feedSent)].join(', '));
  check(orderSent.length === 1 && orderSent[0] === 'auth', 'the order connection signs in and sends nothing else (trading is off on this ChartBridge): ' + orderSent.join(', '));
  check((await page.evaluate(() => window.__spy.sockets.length)) === 4, 'one WebSocket per instrument (3 for 6 panels) and the order connection');
  check(await sessions() === sess0 + 3, 'one GET /session per order connection: the reconnect after the drop and two loads: ' + (await sessions() - sess0));

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
  await allLive().catch(() => fail('Main not live again'));

  console.log('screens');
  for (const [w, h] of [[2560, 1440], [1366, 768]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(800);
    const fitOk = await page.evaluate(() => { const g = document.getElementById('wsGrid').getBoundingClientRect(); return [...document.querySelectorAll('.ws-panel')].every(p => { const r = p.getBoundingClientRect(); return r.left >= g.left - 1 && r.top >= g.top - 1 && r.right <= g.right + 1 && r.bottom <= g.bottom + 1 && r.width > 50 && r.height > 50; }) && document.documentElement.scrollWidth <= innerWidth; });
    check(fitOk, w + 'x' + h + ': every panel inside the window, by cells');
    const heads = await page.evaluate(() => [...document.querySelectorAll('.ws-head')].every(h => h.offsetHeight === 28 && h.scrollHeight <= 28 && h.scrollWidth <= h.clientWidth + 1));
    check(heads, w + 'x' + h + ': every header one 28 px line, nothing past its edge (a 2 x 1 chart too)');
  }
  // the default layout itself at 2560 and 1366, for Anthony to look at
  await page.setViewportSize({ width: 2560, height: 1440 });
  await open(URL0 + '?layout=Second');
  await page.waitForTimeout(1500);
  await shot(page, 'workspace-2560x1440.png');
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForTimeout(1500);
  console.log('chips on a narrow chart (1366x768, the default layout)');
  s = await state();
  const nq3 = s.panels.find(p => p.type === 'chart' && p.root === 'NQ');
  await page.click(`.ws-panel[data-id="${nq3.id}"] .ws-head .ind-btn`);
  for (const q of ['vwap', 'levels', 'ib', 'fills', 'volume bars']) { await page.fill(`.ws-panel[data-id="${nq3.id}"] .ind-panel input[data-f="q"]`, q); await page.keyboard.press('Enter'); }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const ch = await page.evaluate(id => { const h = document.querySelector(`.ws-panel[data-id="${id}"] .ws-head`), more = h.querySelector('.ind-chip-more');
    return { shown: [...h.querySelectorAll('.ind-chips > .ind-chip[data-id]')].map(c => c.textContent), more: more && !more.hidden ? more.textContent : '', listed: h.querySelectorAll('.ind-chip-list .ind-chip').length,
      fits: h.scrollWidth <= h.clientWidth + 1 && h.offsetHeight === 28, all: [...document.querySelectorAll('.ws-head')].every(x => x.scrollWidth <= x.clientWidth + 1 && x.offsetHeight === 28) }; }, nq3.id);
  check(ch.more === '+' + ch.listed && ch.listed > 0 && ch.shown.length + ch.listed === 5, 'the chips that do not fit go behind "' + ch.more + '" (' + ch.shown.join(' ') + ' shown)');
  check(ch.fits && ch.all, 'the header does not wrap or scroll, and no header does');
  await page.click(`.ws-panel[data-id="${nq3.id}"] .ind-chip-more`);
  const lst = await page.evaluate(id => { const l = document.querySelector(`.ws-panel[data-id="${id}"] .ind-chip-list`); const r = l.getBoundingClientRect(); return { open: !l.hidden, n: l.querySelectorAll('.ind-chip').length, inside: r.right <= innerWidth && r.bottom <= innerHeight }; }, nq3.id);
  check(lst.open && lst.n === ch.listed && lst.inside, '"' + ch.more + '" opens a small list of them');
  await shot(page, 'workspace-1366x768-chips.png');
  const esP = s.panels.find(p => p.type === 'chart' && p.root === 'ES');
  const lg = await page.evaluate(id => {
    const el = document.querySelector(`.ws-panel[data-id="${id}"] .legend`), r = el.getBoundingClientRect();
    const hidden = sel => { const e = el.querySelector(sel); return !e || getComputedStyle(e).display === 'none'; };
    const inside = sel => { const e = el.querySelector(sel); const q = e.getBoundingClientRect(); return q.height > 0 && q.bottom <= r.bottom + 0.5; };
    const tops = new Set([...el.querySelectorAll('.lg1 > *, .lg2 > *, .lg3 > *')].filter(e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().top < r.bottom - 1).map(e => Math.round(e.getBoundingClientRect().top)));
    return { src: hidden('[id$="lgSrc"]'), pill: hidden('[id$="connPill"]'), h: r.height, rows: tops.size, close: inside('.lg2 > :nth-child(5)') && inside('[id$="lgChg"]') && inside('[id$="lgName"]'), text: el.innerText.replace(/\s+/g, ' ').slice(0, 80) };
  }, esP.id);
  check(lg.src && lg.pill, 'the panel legend has no source and version line and no LIVE pill (the top bar says LIVE · ChartBridge)');
  check(lg.rows <= 2 && lg.h <= 40 && lg.close, 'ES 1 min at 1366x768: the legend fits in 2 lines (' + lg.rows + ' rows, ' + Math.round(lg.h) + ' px: ' + lg.text + ')');
  await control('status?level=warn&text=' + encodeURIComponent('Test note for the chart'));
  await page.waitForTimeout(400);
  const nt = await page.evaluate(id => { const c = document.querySelector(`.ws-panel[data-id="${id}"] .ws-body > .chart-live`), st = c.querySelector(':scope > .status'), m = st.querySelector('.msg'), r = st.getBoundingClientRect(), b = c.getBoundingClientRect();
    return { on: c.classList.contains('has-note'), shown: getComputedStyle(st).display !== 'none', text: m.textContent, color: getComputedStyle(m).color, bottom: b.bottom - r.bottom < 8, h: r.height, others: [...st.children].filter(x => getComputedStyle(x).display !== 'none').length }; }, esP.id);
  check(nt.on && nt.shown && nt.text === 'Test note for the chart' && nt.bottom && nt.h <= 18 && nt.others === 1, 'a note shows in one faint line at the bottom of the chart (' + Math.round(nt.h) + ' px), nothing else on it');
  check(nt.color === 'rgb(224, 180, 90)', 'a warning keeps its colour (' + nt.color + ')');
  await shot(page, 'workspace-1366x768-note.png');
  await control('status?level=info&text=');
  await page.waitForTimeout(400);
  const nc = await page.evaluate(id => { const c = document.querySelector(`.ws-panel[data-id="${id}"] .ws-body > .chart-live`); return { on: c.classList.contains('has-note'), shown: getComputedStyle(c.querySelector(':scope > .status')).display !== 'none' }; }, esP.id);
  check(!nc.on && !nc.shown, 'and clears: no line and no space when there is no note');
  const first = await page.evaluate(id => document.querySelector(`.ws-panel[data-id="${id}"] .ind-chip-list .ind-chip`).dataset.id, nq3.id);
  await page.click(`.ws-panel[data-id="${nq3.id}"] .ind-chip-list .ind-chip[data-id="${first}"]`);
  check(await page.evaluate(([id, f]) => { const c = document.querySelector(`.ws-panel[data-id="${id}"] .ind-chip-list .ind-chip[data-id="${f}"]`); return !!c && c.getAttribute('aria-pressed') === 'false'; }, [nq3.id, first]), 'a chip in the list works like the others, and the list stays open');
  await page.keyboard.press('Escape');
  check(await page.evaluate(id => document.querySelector(`.ws-panel[data-id="${id}"] .ind-chip-list`).hidden, nq3.id), 'Esc closes the list');
  await shot(page, 'workspace-1366x768.png');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(1500);
  await shot(page, 'workspace-1920x1080.png');
  console.log('the order ticket (1.12.0): two windows, trading on');
  if (!process.env.WORKSPACE_SKIP_TICKET) await ticketPart({ browser, check, fail, shot, root, port: PORT + 1 });
} catch (e) {
  fail('threw: ' + (e && e.stack || e));
} finally {
  await browser.close();
  bridge.kill();
}
console.log(errors.length ? `\n${errors.length} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
