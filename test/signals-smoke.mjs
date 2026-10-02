// Signals smoke: absorption bars, a CVD divergence arrow and large-order bubbles on the fake bridge.
// Sample data only, never market data.
//   npm run smoke:signals
// NQ 1 minute at 10:30 ET (RTH, large-print floor 50). Scripted prints after the page opened must paint one cyan
// bullish bar and one yellow bearish bar, show one hollow divergence arrow and then the same arrow solid, and draw
// bubbles. Screenshots land in test/out, labelled as sample data.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CE = require('../src/chart-engine.js'), U = CE.util;
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const BASE_PORT = +(process.env.SIGNALS_SMOKE_PORT || 8891);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };

function offsetTo(hh, mm, ss, want) {
  const now = Date.now() / 1000, today = Math.floor(U.zoneSeconds(now) / 86400);
  for (let back = 0; back < 30; back++) {
    const bt = (today - back) * 86400 + hh * 3600 + mm * 60 + ss;
    if (!want(bt)) continue;
    let unix = bt - (U.zoneSeconds(now) - now);
    unix = bt - (U.zoneSeconds(unix) - unix);
    if (unix > now) continue;
    return Math.round(unix - now);
  }
  throw new Error('no day found');
}
const weekday = bt => U.rthDay(bt);

const pane = {
  ind: {
    volume: { on: true, shown: true, pin: true },
    vwap: { on: false, shown: true, pin: false },
    levels: { on: true, shown: true, pin: true },
    ib: { on: true, shown: true, pin: true },
    vp: { on: false, shown: true, pin: false },
    delta: { on: true, shown: true, pin: false },
    bubbles: { on: true, shown: true, pin: true },
    fills: { on: true, shown: true, pin: true },
    absorb: { on: true, shown: true, pin: false },
  },
  recent: [],
  restore: null,
};
const signals = { div: { main: { on: true, swing: 2, minBars: 3, minPct: 0.10 } } };

let port = BASE_PORT;
const bridges = [];
async function startBridge(offset) {
  for (let tries = 0; tries < 8; tries++, port++) {
    const p = port;
    const b = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--pin-off', '--test-controls', '--clock-offset=' + offset], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errText = '';
    b.stderr.on('data', d => { errText += d; });
    const ok = await new Promise(res => { b.stdout.once('data', () => res(true)); b.once('exit', () => res(false)); });
    if (ok) { port++; bridges.push(b); return { port: p, kill: () => b.kill() }; }
    if (!/EADDRINUSE/.test(errText)) throw new Error('bridge failed: ' + errText);
  }
  throw new Error('no free port from ' + BASE_PORT);
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function context(offset) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(`(() => {
    const realNow = Date.now; Date.now = () => realNow() + ${offset * 1000};
    try {
      localStorage.setItem('live-settings-v2', ${JSON.stringify(JSON.stringify({ root: 'NQ', tf: 'm1', glide: 'off', rangeMode: 'nt' }))});
      localStorage.setItem('live-range-v2', ${JSON.stringify(JSON.stringify({ NQ: 40 }))});
      localStorage.setItem('live-indicators-v2', ${JSON.stringify(JSON.stringify({ main: pane }))});
      localStorage.setItem('live-signal-settings-v1', ${JSON.stringify(JSON.stringify(signals))});
    } catch (e) {}
  })();`);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  return ctx;
}
const live = p => p.waitForFunction(() => document.getElementById('connPill') && document.getElementById('connPill').textContent === 'LIVE', null, { timeout: 30000 });
async function openPage(ctx, url) {
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(m.text())) fail('console: ' + m.text()); });
  await p.goto(url);
  await live(p);
  await p.waitForTimeout(600);
  return p;
}
const label = (p, text) => p.evaluate(t => {
  let el = document.getElementById('__sample');
  if (!el) { el = document.createElement('div'); el.id = '__sample'; el.style.cssText = 'position:fixed;left:50%;top:118px;transform:translateX(-50%);z-index:50;font:600 13px system-ui,sans-serif;color:#080B10;background:#E0B45A;padding:4px 12px;border-radius:6px'; document.body.appendChild(el); }
  el.textContent = t;
}, text);
const shot = async (p, name, text) => { await label(p, 'SAMPLE DATA (fake bridge), not market data. ' + text); await p.mouse.move(8, 8); await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, name) }); };

async function post(portNum, pathName) {
  const r = await fetch('http://127.0.0.1:' + portNum + pathName, { method: 'POST' });
  if (!r.ok) throw new Error(pathName + ' ' + r.status);
}
const quiet = portNum => post(portNum, '/test/quiet?root=NQ&on=1');
async function sendPrints(portNum, list) {
  for (const x of list) await post(portNum, '/test/print?root=NQ&p=' + x.p + '&v=' + x.v + '&s=' + x.s + '&t=' + x.t);
}

/* Ten prints, five buys and five sells, so the bar has the high and the low and a flat delta. Volume 40, each print 4. */
function balanced(t0, low, high, closeAtHigh) {
  const out = [];
  for (let i = 0; i < 10; i++) {
    const buy = closeAtHigh ? i % 2 === 1 : i % 2 === 0;
    out.push({ t: +(t0 + 0.12 + i * 0.15).toFixed(3), p: buy ? high : low, v: 4, s: buy ? 1 : -1 });
  }
  return out;
}

const marks = p => p.evaluate(() => window.liveChart.signalMarks());
const dump = p => p.evaluate(() => {
  const c = window.liveChart, d = window.liveData(), bars = c.bars();
  const tail = bars.slice(-12).map(b => ({ t: b.t, h: b.h, l: b.l, c: b.c, v: b.v }));
  const cd = c.getDelta();
  return { layers: c.getLayers(), marks: c.signalMarks(), n: bars.length, liveFrom: d.liveFrom, tail, deltas: tail.map(b => { const x = cd && cd.at(b.t); return x ? x.c : null; }) };
});

async function zoomPlot(p, times) {
  const box = await p.locator('#chart canvas').boundingBox();
  await p.mouse.move(box.x + box.width * 0.78, box.y + 90);
  for (let i = 0; i < times; i++) { await p.mouse.wheel(0, -160); await p.waitForTimeout(20); }
  await p.waitForTimeout(250);
}

const pxCount = p => p.evaluate(() => {
  const c = document.querySelector('#chart canvas');
  const img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let cyan = 0, yellow = 0;
  for (let i = 0; i < img.length; i += 4) {
    if (img[i + 3] < 200) continue;
    if (img[i] === 0 && img[i + 1] === 255 && img[i + 2] === 255) cyan++;
    else if (img[i] === 255 && img[i + 1] === 255 && img[i + 2] === 0) yellow++;
  }
  return { cyan, yellow };
});

try {
  const off = offsetTo(10, 30, 0, weekday);
  const br = await startBridge(off);
  const ctx = await context(off);
  const p = await openPage(ctx, 'http://localhost:' + br.port + '/live/single.html');
  await quiet(br.port);
  await p.waitForTimeout(300);

  const chips = await p.$$eval('#indChips .ind-chip', els => els.map(e => e.dataset.id));
  check(chips.includes('bubbles'), 'large-order bubbles has a chip: ' + chips.join(','));
  check(!chips.includes('absorb'), 'absorption bars take no chip: ' + chips.join(','));
  await p.click('#indBtn');
  const menuText = await p.locator('#indBody').innerText();
  check(menuText.includes('Signals'), 'indicators menu has a Signals group');
  check(menuText.includes('Absorption bars'), 'indicators menu lists Absorption bars');
  check(menuText.includes('Large-order bubbles'), 'indicators menu lists Large-order bubbles');
  await p.keyboard.press('Escape');

  const anchor = await p.evaluate(() => {
    const d = window.liveData(), bars = window.liveChart.bars(), last = bars[bars.length - 1];
    return { lastT: last.t, lastC: last.c, liveFrom: d.liveFrom, layers: window.liveChart.getLayers() };
  });
  check(anchor.layers.absorb && anchor.layers.bubbles && anchor.layers.delta, 'absorption, bubbles and delta are on');
  const base = Math.round(anchor.lastC * 4) / 4;
  const start = Math.floor(Math.max(anchor.lastT, anchor.liveFrom) / 60) * 60 + 180;
  const barT = i => start + i * 60;
  console.log('  anchor last ' + anchor.lastC + ' at ' + anchor.lastT + ', script from ' + start);

  /* Bars 0 to 3 rise into the first swing. Bar 4 is the swing high with a large buy. Bars 5 and 6 fall away. */
  const lead = [];
  for (let i = 0; i < 4; i++) lead.push(...balanced(barT(i), base, base + (i + 1), true));
  lead.push(...balanced(barT(4), base, base + 6, true));
  lead.push({ t: +(barT(4) + 1.8).toFixed(3), p: base + 6, v: 504, s: 1 });
  lead.push(...balanced(barT(5), base, base + 4, false));
  lead.push(...balanced(barT(6), base, base + 3, false));
  /* Bar 7: a higher high, and a large sell so cumulative delta is lower. Hollow once this bar has closed. */
  lead.push(...balanced(barT(7), base, base + 8, true));
  lead.push({ t: +(barT(7) + 1.8).toFixed(3), p: base, v: 120, s: -1 });
  lead.push(...balanced(barT(8), base, base + 4, false));
  await sendPrints(br.port, lead);

  let hollow = null;
  try {
    await p.waitForFunction(() => {
      const a = window.liveChart.signalMarks().arrows;
      return a.some(m => m.hollow && m.kind === 'bear');
    }, null, { timeout: 8000 });
    hollow = await marks(p);
  } catch (e) {
    fail('hollow arrow did not appear: ' + JSON.stringify(await dump(p)));
  }
  if (hollow) {
    const bears = hollow.arrows.filter(m => m.kind === 'bear' && m.hollow);
    check(bears.length === 1, 'one hollow bearish arrow');
    check(!hollow.arrows.some(m => !m.hollow), 'the arrow is not solid yet');
  }
  await zoomPlot(p, 18);
  await shot(p, 'signals-hollow-arrow.png', 'Hollow divergence arrow in the CVD pane');

  /* Bars 9 and the start of 10 confirm the swing: the hollow arrow becomes solid. */
  const mid = balanced(barT(9), base, base + 3, false);
  mid.push(balanced(barT(10), base, base + 0.5, false)[0]);
  await sendPrints(br.port, mid);
  let solid = null;
  try {
    await p.waitForFunction(() => {
      const a = window.liveChart.signalMarks().arrows;
      return a.some(m => m.kind === 'bear' && !m.hollow);
    }, null, { timeout: 8000 });
    solid = await marks(p);
  } catch (e) {
    fail('solid arrow did not appear: ' + JSON.stringify(await dump(p)));
  }
  if (solid) {
    const bears = solid.arrows.filter(m => m.kind === 'bear' && !m.hollow);
    check(bears.length === 1, 'one solid bearish arrow');
    check(!solid.arrows.some(m => m.hollow), 'the hollow arrow is gone once the swing confirms');
  }
  await shot(p, 'signals-solid-arrow.png', 'Solid divergence arrow after the swing confirms');

  /* Twenty quiet bars so the absorption average is theirs, then one bullish bar and one bearish bar. */
  const tail = [];
  const rest10 = balanced(barT(10), base, base + 0.5, false).slice(1);
  tail.push(...rest10);
  for (let i = 11; i <= 29; i++) tail.push(...balanced(barT(i), base, base + 0.5, false));
  const bullT = barT(30), bearT = barT(31);
  tail.push(
    { t: +(bullT + 0.10).toFixed(3), p: base, v: 4, s: -1 },
    { t: +(bullT + 0.40).toFixed(3), p: base + 2, v: 4, s: 1 },
    { t: +(bullT + 0.80).toFixed(3), p: base + 2, v: 100, s: 1 },
    { t: +(bullT + 1.20).toFixed(3), p: base + 2, v: 12, s: 1 },
    { t: +(bearT + 0.10).toFixed(3), p: base + 2, v: 4, s: 1 },
    { t: +(bearT + 0.40).toFixed(3), p: base, v: 4, s: -1 },
    { t: +(bearT + 0.80).toFixed(3), p: base, v: 100, s: -1 },
    { t: +(bearT + 1.20).toFixed(3), p: base, v: 12, s: -1 },
    { t: +(barT(32) + 0.20).toFixed(3), p: base + 0.25, v: 4, s: 1 },
  );
  await sendPrints(br.port, tail);

  let done = null;
  try {
    await p.waitForFunction(() => {
      const m = window.liveChart.signalMarks();
      const bodies = m.absorb.filter(a => a.paint === 'body');
      return bodies.some(a => a.kind === 'bull') && bodies.some(a => a.kind === 'bear') && m.bubbles.length > 0;
    }, null, { timeout: 8000 });
    done = await marks(p);
  } catch (e) {
    fail('absorption or bubbles did not draw: ' + JSON.stringify(await dump(p)));
  }
  if (done) {
    const bodies = done.absorb.filter(a => a.paint === 'body');
    check(bodies.filter(a => a.kind === 'bull').length === 1, 'one cyan bullish absorption bar');
    check(bodies.filter(a => a.kind === 'bear').length === 1, 'one yellow bearish absorption bar');
    check(done.bubbles.some(b => b.side === 'buy') && done.bubbles.some(b => b.side === 'sell'), 'bubbles on both a buy and a sell');
    check(done.bubbles.some(b => b.size >= 50), 'a bubble is at least the RTH floor');
  }
  const still = await p.evaluate(() => {
    const c = window.liveChart, d = window.liveData(), bs = c.bars();
    return window.ChartEngine.divergenceMarks(bs.slice(0, -1), t => { const x = d.delta.at(t); return x ? x.c : null; }, { swing: 2, minBars: 3, minPct: 0.10, from: d.liveFrom });
  });
  check(still.some(m => m.kind === 'bear' && !m.hollow) && !still.some(m => m.hollow), 'the solid arrow is still the divergence after the later bars');
  await zoomPlot(p, 8);
  const px = await pxCount(p);
  check(px.cyan > 0, 'cyan pixels on the chart (' + px.cyan + ')');
  check(px.yellow > 0, 'yellow pixels on the chart (' + px.yellow + ')');
  await shot(p, 'signals-absorption-bubbles.png', 'Cyan and yellow absorption bars, and large-order bubbles');
} finally {
  await browser.close();
  for (const b of bridges) b.kill();
}

console.log(errors.length ? 'FAILED ' + errors.length + ' of ' + checks : 'ok ' + checks + ' checks');
if (errors.length) process.exit(1);
