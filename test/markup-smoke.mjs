// Markup Studio smoke: the Python server (tools/markup_studio.py) on synthetic days (test/markup_fixture.py, made-up sample
// data), the page (live/markup.html) in Chromium.
//   1. NO-FUTURE: every WebSocket frame and every HTTP response the page receives is recorded; nothing with a time after the
//      replay clock may be in any of them, the ticks each chart got must be exactly the day's ticks up to the clock, and the
//      history bars exactly the minutes built from them. "Next candle" then moves the clock to the next minute close and the
//      newest time received is the last trade before that close (blind cuts are exclusive: a trade stamped exactly at
//      the cut stays out).
//   2. Blind: no date (YYYY-MM-DD or a month name) in the DOM text, tooltips, document.title, the URL, or any text drawn on the
//      charts' canvases (the crosshair's time tag included), before the grade is saved.
//   3. Grade: hotkeys 1 and S, a chip, a reason, Entry and Stop marks clicked on the chart, Save: the JSON file on disk.
//   4. Free mode: a day and time, play; screenshots; holdout refusals.
//   5. Mutation proof: a copy of the server that lets ONE tick past the clock through must FAIL check 1.
//   6. Bot tab (the public test bot, test/markup_bot_fixture.py): a bot day loaded, played past the bot's entry; every
//      /api/bot response recorded and checked against its clock, the bot's later exit in none of them; the order line and
//      fill marker drawn; the event list holds nothing after the clock. Run all: the summary rows and a hand-worked net $.
//   7. Mutation proof: a copy of the server whose view filter leaks ONE future bot event must FAIL check 6.
//   8. ES (--symbol=ES, its own marks folder; the fixture's ES days): the header says ES, the charts' root is ES (from the
//      server's hello), and the Bot tab's dollars are ES and MES (a hand-worked net $).
//   9. Trades tab (--trade-queue, a synthetic trades.csv of the test bot's TM trades, and --trade-notes): the page opens the
//      next trade by itself; at its cut (the entry order's t_from) the checks of 1 and 2 hold for 2026-03-05, every
//      /api/trades/view response is frozen at the cut, the fill time, the date and the second opinion are nowhere; the key
//      legend shows every key. Keyboard flow: T saves and reveals (date, result, second opinion), N opens the next trade
//      prefetched and faster, A, Next candle, E click, S click, Enter saves an ADJUST, Space plays, X X skips the day.
//      Only the trade being graded is drawn (one entry order at the cut; after the reveal only its fill and exits). Nothing
//      about his own trade ("yours") reaches the page before the grade is complete; after the ADJUST is saved the reveal has
//      the Your trade row in the --ms-yours accent and the charts draw YOU labels; marks on the other side of the bot's trade
//      show the opposite-side note first.
//  10. Mutation proof: a server that cuts one tick late, one that leaks the second opinion into the bot view, and one that
//      leaves the other trades' orders in the Trades view must each FAIL the checks of 9.
//  11. PASS, then "my trade instead" (M) with --trade-exits=t5: nothing of the outcome before his trade is saved or declined,
//      the .mine.json files (instead, none), the reveal's Your trade instead row, and only the t5 legs drawn (never the
//      primary target).
//   npm run smoke:markup     (PYTHON=py to pick the interpreter; CHROMIUM_PATH to use a preinstalled browser; SHOTS_DIR)
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const SHOTS = process.env.SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const PORT = +(process.env.MARKUP_SMOKE_PORT || 8792);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'markup-smoke-'));
const dataDir = path.join(tmp, 'data');
execFileSync(PY, [path.join(root, 'test', 'markup_fixture.py'), dataDir], { stdio: 'ignore' });
execFileSync(PY, [path.join(root, 'test', 'markup_fixture.py'), dataDir, 'ES'], { stdio: 'ignore' });   // ES_<date>.npz beside the NQ days
const FXALL = JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture.json'), 'utf8')).days;
const FX = FXALL['2026-03-10'];

let checks = 0, failures = [];
function check(ok, m, sink) {
  checks++;
  if (sink) { if (!ok) sink.push(m); return ok; }
  if (ok) console.log('  ok   ' + m); else { failures.push(m); console.error('  FAIL ' + m); }
  return ok;
}
const servers = [];
async function startServer(script, port, marks, symbol) {
  const child = spawn(PY, [script, '--source=npz', '--data=' + dataDir, '--marks=' + marks, '--port=' + port, '--no-browser', '--seen=' + path.join(tmp, 'none.csv'),
    '--bot=' + path.join(root, 'test', 'markup_bot_fixture.py')].concat(symbol ? ['--symbol=' + symbol] : []),
    { stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(child);
  await new Promise(r => child.stdout.once('data', r));
  for (let i = 0; i < 100; i++) {
    const s = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Host: 'localhost:' + port } })).json().catch(() => ({}));
    if (s.scan && s.scan.done) return child;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('scan never finished');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 10000); for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(100); } }
async function shot(page, name) {
  const file = path.join(out, name);
  await page.screenshot({ path: file });
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, name));
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/* A page that records every frame (per socket) and every HTTP response body, and every text drawn on a canvas. */
async function openPage(port) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const rec = { sockets: [], responses: [], errors: [] };
  page.on('pageerror', e => rec.errors.push(e.message));
  page.on('websocket', ws => { const s = { url: ws.url(), frames: [] }; rec.sockets.push(s); ws.on('framereceived', f => s.frames.push(String(f.payload))); });
  page.on('response', async r => { try { rec.responses.push({ url: r.url(), body: await r.text() }); } catch (e) { /* redirects, aborted */ } });
  await page.addInitScript(() => {
    window.__drawn = [];
    const P = CanvasRenderingContext2D.prototype, f = P.fillText;
    P.fillText = function (t) { if (window.__drawn.length < 200000) window.__drawn.push(String(t)); return f.apply(this, arguments); };
  });
  await page.goto(`http://localhost:${port}/live/markup.html`);
  return { page, rec };
}
const state = port => fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Host: 'localhost:' + port } }).then(r => r.json());
const chartsReady = page => until(() => page.evaluate(() => { const p = window.__markup.panes; return !!(p.range && p.m1 && p.range.chart.bars().length && p.m1.chart.bars().length); }), 15000);

/* Check 1: nothing after the clock reached the page, and what did reach it is exactly the day up to the clock. */
function noFuture(rec, clockUtc, sink, label, FX = FXALL['2026-03-10']) {
  // blind mode cuts EXCLUSIVE: a trade stamped exactly at the clock (the next candle's first) is not the page's yet
  const n = FX.utc.filter(u => u < clockUtc).length;
  const clockWallS = (clockUtc + (FX.wall[0] - FX.utc[0])) / 1000;       // one offset all day (no DST change in the fixture)
  const bad = [];
  let scanned = 0;
  const scan = (x, where) => {
    if (typeof x === 'number') {
      if (x >= 1e12 && x < 1e13) { scanned++; if (x > clockUtc) bad.push(`${where}: UTC ms ${x} > clock ${clockUtc}`); }
      else if (x >= 1e9 && x < 1e10) { scanned++; if (x > clockWallS + 1e-6) bad.push(`${where}: time ${x} > clock ${clockWallS}`); }
    } else if (Array.isArray(x)) x.forEach(y => scan(y, where));
    else if (x && typeof x === 'object') Object.values(x).forEach(y => scan(y, where));
  };
  let sockets = 0;
  for (const s of rec.sockets) {
    const msgs = s.frames.map(f => { try { return JSON.parse(f); } catch (e) { return null; } }).filter(Boolean);
    msgs.forEach(m => scan(m, 'frame ' + m.type));
    if (!msgs.some(m => m.type === 'ready')) continue;
    sockets++;
    const got = [];
    for (const m of msgs) {
      if (m.type === 'ticks') for (const r of m.ticks) got.push(r);
      if (m.type === 'tick') got.push([m.t, m.p, m.v]);
    }
    const want = n;
    let same = got.length === want;
    for (let i = 0; same && i < want; i++) same = Math.abs(got[i][0] - FX.wall[i] / 1000) < 1e-6 && got[i][1] === FX.px[i] && got[i][2] === FX.vol[i];
    check(same, `${label}: the charts got exactly the day's ${want} ticks before the clock (got ${got.length})`, sink);
    check(FX.utc.includes(clockUtc) && !got.some(r => Math.abs(r[0] - clockWallS) < 1e-6), `${label}: the fixture's trade stamped exactly at the clock did not reach the page`, sink);
    // the history starts with the prior kept day's minutes (for PDH, PDL, the prior close and the prior value area), all
    // before this session's first trade
    const all = msgs.filter(m => m.type === 'history').flatMap(m => m.bars);
    const prior = all.filter(b => b[0] < FX.wall[0] / 1000), hist = all.slice(prior.length);
    check((prior.length > 0 || !FX.prior_bars.length) && JSON.stringify(prior) === JSON.stringify(FX.prior_bars), `${label}: the history starts with exactly the prior day's ${FX.prior_bars.length} minutes`, sink);
    const byMin = new Map();
    for (let i = 0; i < want; i++) {
      const k = Math.floor(FX.wall[i] / 60000) * 60, b = byMin.get(k);
      if (!b) byMin.set(k, [k, FX.px[i], FX.px[i], FX.px[i], FX.px[i], FX.vol[i]]);
      else { b[2] = Math.max(b[2], FX.px[i]); b[3] = Math.min(b[3], FX.px[i]); b[4] = FX.px[i]; b[5] += FX.vol[i]; }
    }
    // the history is the load's: bars up to the clock at load time, each exactly the minutes made from those ticks
    const exp = [...byMin.values()];
    let ok = hist.length > 0 && hist.length <= exp.length;
    for (let i = 0; ok && i < (hist.length === exp.length ? hist.length : hist.length - 1); i++) ok = JSON.stringify(hist[i]) === JSON.stringify(exp[i]);
    check(ok, `${label}: the history bars are exactly the minutes made from ticks at or before the clock`, sink);
  }
  check(sockets >= 2, `${label}: both charts loaded (${sockets} sockets)`, sink);
  for (const r of rec.responses) {
    if (!/\/(api|markup)\//.test(r.url)) continue;
    let j; try { j = JSON.parse(r.body); } catch (e) { continue; }
    scan(j, 'response ' + new URL(r.url).pathname);
  }
  check(scanned > 0 && !bad.length, `${label}: none of the ${scanned} times in every frame and response is after the clock` + (bad.length ? ' (' + bad.length + ' are, e.g. ' + bad[0] + ')' : ''), sink);
}

async function noFutureRun(script, port, label, sink) {
  const marks = path.join(tmp, 'marks-' + port);
  await startServer(script, port, marks);
  const { page, rec } = await openPage(port);
  await page.click('#btnNext');
  await chartsReady(page);
  await sleep(1500);
  const s0 = await state(port);
  noFuture(rec, s0.clock_utc_ms, sink, label + ' at the cut');
  const inPage = await page.evaluate(() => ['range', 'm1'].map(k => { const b = window.__markup.panes[k].chart.bars(); return { maxT: Math.max(...b.map(x => x.t)), last: b[b.length - 1].c }; }));
  const n0 = FX.utc.filter(u => u < s0.clock_utc_ms).length;
  for (const x of inPage) check(x.maxT <= FX.wall[n0 - 1] / 1000 && x.last === FX.px[n0 - 1], `${label}: each chart's newest bar is before the clock and closes at the last price before it`, sink);
  const pre = rec.sockets.flatMap(x => x.frames).concat(rec.responses.filter(r => /\/(api|markup)\//.test(r.url)).map(r => r.body)).join('\n');
  check(!/20260310|2026-03-10/.test(pre), `${label}: no frame or response names the date or a dated id before the grade`, sink);
  // Next candle: the clock moves to the next minute close (exclusive again): the newest time received is the last trade
  // before that close, and the trade stamped exactly at it stays out
  await page.click('#btnStep');
  await sleep(1500);
  const s1 = await state(port);
  check(s1.clock_utc_ms === s0.clock_utc_ms + 60000, `${label}: Next candle moved the clock to the next minute close`, sink);
  noFuture(rec, s1.clock_utc_ms, sink, label + ' after Next candle');
  let maxT = -Infinity;
  for (const s of rec.sockets) for (const f of s.frames) { const m = JSON.parse(f); if (m.type === 'tick') maxT = Math.max(maxT, m.t); if (m.type === 'ticks') for (const r of m.ticks) maxT = Math.max(maxT, r[0]); }
  const closeWall = (s1.clock_utc_ms + (FX.wall[0] - FX.utc[0])) / 1000;
  check(FX.wall.includes(closeWall * 1000) && maxT === closeWall - 5, `${label}: the newest time the page received is the last trade before the next minute close (${maxT} vs ${closeWall} - 5)`, sink);
  check(!rec.errors.length, `${label}: no page errors (${rec.errors.join('; ')})`, sink);
  return { page, rec, marks };
}

/* Check 6: the Bot tab on 2026-03-05 (a bot day), test bot variant T1000: buy stop 21,001.00 armed 10:00:00, filled 10:00:20,
   base target 21,011.00 at 10:03:40. The clock is taken past the fill but not to the exit. */
const BOT_DAY = '2026-03-05';
const botWall = (hh, mm, ss) => Date.UTC(2026, 2, 5, hh, mm, ss || 0);      // wall ms (New York clock stored as if UTC)
async function botRun(port, label, sink) {
  const { page, rec } = await openPage(port);
  await page.click('#tabBot');
  await until(() => page.evaluate(() => document.getElementById('botDay').options.length > 0));
  const days = await page.evaluate(() => [...document.getElementById('botDay').options].map(o => o.value).sort());
  check(JSON.stringify(days) === JSON.stringify(['2026-03-05', '2026-03-09']), `${label}: the day picker lists the bot days only (${days})`, sink);
  const labels = await page.evaluate(() => [...document.getElementById('botDay').options].map(o => [o.value, o.textContent]));
  check(labels.every(([v, t]) => t.includes(v)), `${label}: the day picker's labels show their dates (the blind scrub leaves the Bot section alone): ${JSON.stringify(labels)}`, sink);
  await page.selectOption('#botDay', BOT_DAY);
  await page.selectOption('#botVariant', 'T1000');
  const s0 = rec.sockets.length;                                           // sockets of an earlier load (Free mode's day) are not this day's
  await page.click('#btnBotLoad');
  await chartsReady(page);
  await until(async () => ((await state(port)).bot_day || {}).status === 'done');
  await page.fill('#jumpTime', '10:00');
  await page.click('#btnJump');
  await chartsReady(page);
  await sleep(600);
  await page.click('#btnStep');                                            // 10:01:00
  await sleep(600);
  await page.click('[data-speed="5"]');                                    // about 7 s of replay
  await sleep(1500);
  await page.click('#btnPause');
  await sleep(1200);
  const fin = await (await fetch(`http://127.0.0.1:${port}/api/bot/view`, { headers: { Host: 'localhost:' + port } })).json();
  const clock = fin.clock_wall_ms, fill = botWall(10, 0, 20), exit = botWall(10, 3, 40);
  check(clock > fill && clock < exit, `${label}: the clock is past the bot's fill and before its exit (${new Date(clock).toISOString().slice(11, 19)})`, sink);
  // every /api/bot response: nothing after the clock it was cut at, that clock never past the replay clock, and the bot's
  // exit (later than every clock here) in none of them
  const bad = [];
  let n = 0;
  for (const r of rec.responses) {
    if (!/\/api\/bot\/view/.test(r.url)) continue;
    let j; try { j = JSON.parse(r.body); } catch (e) { continue; }
    n++;
    const c = j.clock_wall_ms;
    if (!(c <= clock)) bad.push('clock ' + c + ' after the replay clock');
    const times = (j.events || []).map(e => e.t).concat((j.orders || []).flatMap(o => [o.t_from, o.t_to]), (j.trades || []).map(t => t.entry_t),
      (j.trades || []).flatMap(t => Object.values(t.exits || {}).map(x => x.exit_t)));
    for (const t of times) if (t > c) bad.push(`time ${t} after the response's clock ${c}`);
    if ((j.events || []).some(e => e.kind === 'exit') || (j.trades || []).some(t => Object.keys(t.exits || {}).length) || r.body.includes(String(exit))) bad.push('the exit before its time');
    if ((j.orders || []).some(o => o.open && o.status)) bad.push('an open order with its status');
  }
  check(n > 3 && !bad.length, `${label}: none of the ${n} /api/bot/view responses holds anything after its clock` + (bad.length ? ' (' + bad.length + ', e.g. ' + bad[0] + ')' : ''), sink);
  // the charts' frames since the bot day's load: nothing after the replay clock (wall seconds)
  let late = 0;
  for (const s of rec.sockets.slice(s0)) for (const f of s.frames) {
    let m; try { m = JSON.parse(f); } catch (e) { continue; }
    if (m.type === 'tick' && m.t * 1000 > clock) late++;
    if (m.type === 'ticks') for (const r of m.ticks) if (r[0] * 1000 > clock) late++;
    if (m.type === 'history') for (const b of m.bars) if (b[0] * 1000 > clock) late++;
  }
  check(late === 0, `${label}: no chart frame holds a time after the clock (${late})`, sink);
  const dom = await page.evaluate(() => ({ events: [...document.querySelectorAll('#botEvents li b')].map(b => b.textContent),
    trades: document.querySelectorAll('#botTrades tbody tr').length, result: (document.querySelector('#botTrades tbody tr') || { cells: [] }).cells[6]?.textContent,
    drawn: window.__markup.botDrawn, texts: window.__drawn.slice(-4000) }));
  const tod = new Date(clock).toISOString().slice(11, 19);
  check(JSON.stringify(dom.events) === JSON.stringify(['10:00:20', '10:00:00', '09:30:00']) && dom.events.every(t => t <= tod),
    `${label}: the event list holds the fill, the arm and the note, newest first, nothing after the clock (${dom.events.join(', ')})`, sink);
  check(dom.trades === 1 && dom.result === 'open', `${label}: one trade, still open`, sink);
  check(!!dom.drawn && dom.drawn.orders > 0 && dom.drawn.fills > 0 && dom.drawn.exits === 0, `${label}: the order lines and the fill marker are drawn, no exit (${JSON.stringify(dom.drawn)})`, sink);
  check(dom.texts.includes('BUY STP 21,001.00') && dom.texts.includes('21,001.00'), `${label}: the order is labeled BUY STP 21,001.00 and the fill 21,001.00`, sink);
  check(!rec.errors.length, `${label}: no page errors (${rec.errors.join('; ')})`, sink);
  if (!sink) await shot(page, 'markup-bot.png');
  return { page, rec };
}


/* Check 9: the Trades tab on the test bot's TM trades of 2026-03-05 (markup_bot_fixture): entry orders placed at 10:00:00,
   11:00:00 and 11:01:00 (wall), filled 20 s later. */
const TMX = { X1: { order: botWall(10, 0, 0), fill: botWall(10, 0, 20), label: 'BUY STP 21,001.00', entry: 21001.0, stop: 20996.0, dir: 'long' },
  X2: { order: botWall(11, 0, 0), fill: botWall(11, 0, 20), label: 'BUY STP 21,013.00', entry: 21013.0, stop: 21008.0, dir: 'long' },
  X3: { order: botWall(11, 1, 0), fill: botWall(11, 1, 20), label: 'SELL STP 21,010.50', entry: 21010.5, stop: 21015.5, dir: 'short' } };
const NOTE = id => 'SECOND-OPINION ' + id + ', "volume dried up"';
function tradesFiles() {
  const head = 'symbol,micro,variant,date,id,level_type,level_price,dir,entry_time,entry_t,entry,stop,target,target_kind,base_exit_t,base_points,base_net_usd';
  const rows = Object.entries(TMX).map(([id, x]) => ['NQ', 'MNQ', 'TM', BOT_DAY, id, 'time', x.entry, x.dir, new Date(x.fill).toISOString().slice(11, 19),
    x.fill, x.entry, x.stop, '', '2R', x.fill + 60000, 0, -4.5].join(','));
  const csvPath = path.join(tmp, 'trades.csv'), notes = path.join(tmp, 'notes.csv');
  fs.writeFileSync(csvPath, [head].concat(rows).join('\n') + '\n');
  fs.writeFileSync(notes, 'trade_id,variant,note,score\n' + Object.keys(TMX).map(id => `${id},TM,"${NOTE(id).replace(/"/g, '""')}",0.5`).join('\n') + '\n');
  return ['--trade-queue=' + csvPath, '--trade-variant=TM', '--trade-notes=' + notes];
}
const sub = (rec, k) => ({ get sockets() { return rec.sockets.slice(k.s); }, get responses() { return rec.responses.slice(k.r); }, errors: rec.errors });
const mark = rec => ({ s: rec.sockets.length, r: rec.responses.length });
async function tradeOpen(port, n) {
  return until(async () => { const s = await state(port); return s.loaded && s.trade_open && s.trade && s.trade.n === n && s.trade.stage === 1 && s; }, 15000);
}
/* The checks at a trade's cut: what reached the page (rec: since the trade opened) holds nothing after the cut. */
async function tradesCut(port, marks, page, rec, n, label, sink) {
  const s = await tradeOpen(port, n);
  if (!check(!!s, `${label}: trade #${n} is open`, sink)) return null;
  await chartsReady(page);
  await sleep(1500);
  const q = JSON.parse(fs.readFileSync(path.join(marks, 'trade_queue_v1.json'), 'utf8'));
  const item = q.items.find(i => i.qid === s.trade.qid), x = TMX[item.trade_id], F5 = FXALL[BOT_DAY];
  const orderUtc = F5.utc[F5.wall.indexOf(x.order)], fillUtc = F5.utc[F5.wall.indexOf(x.fill)];
  check(s.clock_utc_ms === orderUtc && s.clock_tod === new Date(x.order).toISOString().slice(11, 19), `${label}: the clock is the entry order's t_from (${s.clock_tod})`, sink);
  noFuture(rec, s.clock_utc_ms, sink, label + ' at the cut', F5);
  const bad = [];
  let nv = 0;
  for (const r of rec.responses) {
    if (!/\/api\/trades\/view/.test(r.url)) continue;
    let j; try { j = JSON.parse(r.body); } catch (e) { continue; }
    nv++;
    if (!(j.clock_wall_ms <= x.order)) bad.push('view clock ' + j.clock_wall_ms + ' after the cut');
    const times = (j.events || []).map(e => e.t).concat((j.orders || []).flatMap(o => [o.t_from, o.t_to]), (j.trades || []).map(t => t.entry_t),
      (j.trades || []).flatMap(t => Object.values(t.exits || {}).map(e => e.exit_t)));
    for (const t of times) if (t > j.clock_wall_ms) bad.push(`time ${t} after the view's clock`);
    if ((j.trades || []).some(t => t.entry_t === x.fill)) bad.push('this trade (its fill) in the view');
    if ((j.orders || []).some(o => o.open && o.status)) bad.push('an open order with its status');
  }
  check(nv > 2 && !bad.length, `${label}: none of the ${nv} /api/trades/view responses holds the fill or anything after the cut` + (bad.length ? ' (' + bad[0] + ')' : ''), sink);
  const all = rec.sockets.flatMap(z => z.frames).concat(rec.responses.map(r => r.body)).join('\n');
  check(!all.includes(String(x.fill)) && !all.includes(String(fillUtc)), `${label}: the fill's time is in no frame or response`, sink);
  check(!/2026-03-05|20260305/.test(all) && !all.includes(item.trade_id + '"'), `${label}: no frame or response names the date or the trade id`, sink);
  const dom = await page.evaluate(() => {
    const titles = [...document.querySelectorAll('[title],[aria-label],[placeholder]')].map(e => [e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('placeholder')].join(' '));
    const scripts = [...document.scripts].map(s => s.textContent).join('');
    return { all: document.documentElement.textContent.replace(scripts, ''), html: document.documentElement.outerHTML, titles: titles.join(' | '), title: document.title,
      url: location.href, drawn: window.__drawn.slice(-20000).join(' | '), drawnAll: window.__drawn.join(' | '), legend: !document.getElementById('secKeys').hidden && document.getElementById('secKeys').getBoundingClientRect().height > 40,
      keys: [...document.querySelectorAll('#tKeys li')].map(li => [li.textContent.replace(/\s+/g, ' ').trim(), li.classList.contains('off')]) };
  });
  const dm = DATE_RE.exec(dom.all + ' ' + dom.titles + ' ' + dom.title + ' ' + dom.url + ' ' + dom.drawn);
  check(!dm, `${label}: no date in the DOM, tooltips, title, URL or chart canvases` + (dm ? ' (found ' + dm[0] + ')' : ''), sink);
  check(dom.drawnAll.includes(x.label), `${label}: the bot's working entry order is drawn (${x.label})`, sink);
  const api = rec.responses.filter(r => /\/api\//.test(r.url)).map(r => r.body).join('\n');
  check(!/"yours/.test(api), `${label}: nothing about his own trade (yours) in any API response before the save`, sink);
  const dr = await page.evaluate(() => window.__markup.botDrawn);
  const ent = [...new Set(dr.entries)];
  check(ent.length === 1 && ent[0] === x.label && !dr.fills && !dr.exits && !dr.legs.length && !dr.you.length,
    `${label}: the overlay draws exactly this trade's entry order and nothing of another trade (${ent.join(', ')}; ${dr.fills} fills, ${dr.exits} exits, ${dr.legs.length} legs)`, sink);
  check(![dom.html, all].some(t => t.includes('SECOND-OPINION')), `${label}: the second opinion is in no frame, response, page source or DOM before the save`, sink);
  const want = ['T TAKE', 'A ADJUST', 'P PASS', 'M my trade instead', 'E entry', 'S stop', 'G target', '1-4 entry type', '→ next candle', 'Enter/N', 'Space play 5x', 'X seen this day', 'Esc cancel'];
  const miss = want.filter(w => !dom.keys.some(([t]) => t.startsWith(w)));
  check(dom.legend && !miss.length, `${label}: the key legend is on screen and lists every key` + (miss.length ? ' (missing ' + miss.join(', ') + ')' : ''), sink);
  const off = Object.fromEntries(dom.keys.map(([t, o]) => [t.split(' ')[0], o]));
  check(!off.T && !off.A && !off.P && off.E && off.S && off.G, `${label}: T, A, P lit and E, S, G dimmed before ADJUST`, sink);
  const get = p => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Host: 'localhost:' + port } });
  const post = (p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { Host: 'localhost:' + port, 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  const codes = [(await get('/api/trades/result')).status, (await post('/api/reveal')).status, (await post('/api/free/load', { date: '2026-03-10' })).status,
    (await post('/api/bot/load', { date: BOT_DAY })).status, (await post('/api/step')).status];
  check(codes.every(c => c === 409), `${label}: result, reveal, Free, Bot and Next candle are refused (409) before stage 1 (${codes})`, sink);
  check(await page.locator('#tabFree').isDisabled() && await page.locator('#tabBot').isDisabled(), `${label}: the Free and Bot tabs are locked`, sink);
  return { s, item, x };
}

const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\b/;
try {
  console.log('1. no future (the real server)');
  const main = await noFutureRun(path.join(root, 'tools', 'markup_studio.py'), PORT, 'real', null);
  const { page } = main;

  console.log('2. blind: no date anywhere');
  const box = await page.locator('#paneRange .ce-host').boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await sleep(400);
  await shot(page, 'markup-blind.png');
  const seen = await page.evaluate(() => {
    const titles = [...document.querySelectorAll('[title],[aria-label],[placeholder]')].map(e => [e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('placeholder')].join(' '));
    return { text: document.body.innerText, all: document.documentElement.textContent.replace(/<script[\s\S]*?<\/script>/g, ''), titles: titles.join(' | '),
      title: document.title, url: location.href, drawn: window.__drawn.slice(-20000).join(' | '), drewTimeTag: window.__drawn.some(t => /^\d{2}:\d{2}$/.test(t.trim())) };
  });
  const scriptText = await page.evaluate(() => [...document.scripts].map(s => s.textContent).join(''));
  check(!DATE_RE.test(seen.text), 'blind: no date in the page text' + (DATE_RE.exec(seen.text) ? ' (found ' + DATE_RE.exec(seen.text)[0] + ')' : ''));
  check(!DATE_RE.test(seen.all.replace(scriptText, '')), 'blind: no date in any DOM text node, hidden ones included' + (DATE_RE.exec(seen.all.replace(scriptText, '')) ? ' (found ' + DATE_RE.exec(seen.all.replace(scriptText, ''))[0] + ')' : ''));
  check(!DATE_RE.test(seen.titles), 'blind: no date in tooltips or labels');
  check(!DATE_RE.test(seen.title) && !DATE_RE.test(seen.url), 'blind: no date in document.title or the URL');
  check(!DATE_RE.test(seen.drawn), 'blind: no date drawn on any chart canvas (crosshair time tag, axis day labels)' + (DATE_RE.exec(seen.drawn) ? ' (found ' + DATE_RE.exec(seen.drawn)[0] + ')' : ''));
  check(seen.drewTimeTag, 'blind: the charts still draw times of day (HH:MM)');
  const nqHead = await page.evaluate(() => document.querySelector('.ms-sub').textContent);
  check(nqHead === 'NQ replay, read only', 'the header names the instrument the hello announced (' + nqHead + ')');
  // the prior day levels in view (the fixture's prior close, PDL and the low end of its value area sit below this day's prices)
  const pd = ['PDH', 'PD VAH'].filter(k => !seen.drawn.split(' | ').some(t => t.trim().startsWith(k)));
  check(!pd.length, 'blind: the charts draw the prior day levels in view (PDH, PD VAH)' + (pd.length ? ' (missing ' + pd.join(', ') + ')' : ''));
  const mr = await fetch(`http://127.0.0.1:${PORT}/api/machine`, { headers: { Host: 'localhost:' + PORT } });
  check(mr.status === 409, 'blind: the machine read is refused before the grade is saved');
  check(await page.locator('#secMachine').isHidden(), 'blind: the machine read panel is hidden before the grade is saved');
  check(await page.locator('#tabFree').isDisabled(), 'blind: the Free tab is locked while the candidate is ungraded');
  check(await page.locator('#tabBot').isDisabled(), 'blind: the Bot tab is locked while the candidate is ungraded');
  const botEsc = await fetch(`http://127.0.0.1:${PORT}/api/bot/load`, { method: 'POST', headers: { Host: 'localhost:' + PORT, 'Content-Type': 'application/json' }, body: '{"date":"2026-03-05"}' });
  check(botEsc.status === 409, 'blind: bot/load is refused while the candidate is ungraded');
  const esc = await fetch(`http://127.0.0.1:${PORT}/api/free/load`, { method: 'POST', headers: { Host: 'localhost:' + PORT, 'Content-Type': 'application/json' }, body: '{"date":"2026-03-10","time":"16:00"}' });
  check(esc.status === 409, 'blind: free/load is refused while the candidate is ungraded');
  const lst = await (await fetch(`http://127.0.0.1:${PORT}/markup/list`, { headers: { Host: 'localhost:' + PORT } })).text();
  check(!/2026|C20/.test(lst), 'blind: /markup/list sends no dated ids');
  const play = await fetch(`http://127.0.0.1:${PORT}/api/play`, { method: 'POST', headers: { Host: 'localhost:' + PORT, 'Content-Type': 'application/json' }, body: '{"speed":5}' });
  check(play.status === 409, 'blind: play is refused before the grade is saved');
  check(await page.locator('#revealRow').isHidden(), 'blind: Reveal is not offered before the grade is saved');

  console.log('3. grade with hotkeys and marks');
  await page.mouse.move(5, 5);
  await page.locator('body').click({ position: { x: 600, y: 20 } });
  await page.keyboard.press('1');
  await page.keyboard.press('S');
  await page.click('.ms-chip >> text=volume drying up');
  await page.fill('#reason', 'volume dried into PDH, wick reclaim');
  await page.click('[data-role="Entry"]');
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
  await page.click('[data-role="Stop"]');
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.2);
  await page.click('[data-role="Failed candle"]');
  await page.keyboard.press('Escape');
  const armed = await page.evaluate(() => !!window.__markup.tool);
  check(!armed, 'Escape cancels a pending mark');
  check(await page.locator('#markList li').count() === 2, 'two marks listed');
  await page.click('#btnSave');
  const saved = await until(() => page.evaluate(() => document.getElementById('saveMsg').textContent.startsWith('Saved') && document.getElementById('saveMsg').textContent));
  check(!!saved, 'Save says saved (' + saved + ')');
  const files = fs.readdirSync(main.marks).filter(n => n.startsWith('grade_'));
  check(files.length === 1, 'one grade file on disk');
  const g = files.length ? JSON.parse(fs.readFileSync(path.join(main.marks, files[0]), 'utf8')) : {};
  check(g.setup === 'SWEEP' && g.direction === 'SHORT', 'the file holds the hotkey grade (SWEEP, SHORT)');
  check(g.date === '2026-03-10' && g.steps_after_cut === 1 && g.reason.includes('PDH') && g.chips.includes('volume drying up'), 'the file holds the date, 1 step after the cut, the reason and the chip');
  check((g.marks || []).length === 2 && g.marks.every(m => m.chart === 'range' && m.bar_time_utc_ms <= g.clock_utc_ms && m.price > 19000), 'the file holds the two marks (chart, bar time, price)');
  check(g.machine_read && g.machine_read.ok && g.draft && ['TAKE', 'PASS'].includes(g.draft.verdict), 'the file holds the machine read and the draft verdict at the grade moment');
  check(fs.readFileSync(path.join(main.marks, 'marks_log.jsonl'), 'utf8').trim().split('\n').length === 1, 'one line in marks_log.jsonl');
  await until(() => page.locator('#secMachine').isVisible());
  check(await page.locator('#secMachine').isVisible() && await page.locator('#secDraft').isVisible(), 'after saving: the machine read and the draft verdict show');
  check(!!(await until(() => page.locator('#revealRow').isVisible(), 5000)), 'after saving: Reveal is offered');
  await shot(page, 'markup-graded.png');
  await page.click('#btnReveal');
  await sleep(1200);
  const s2 = await state(PORT);
  check(s2.playing && s2.speed === 5, 'Reveal plays forward at 5x');
  await page.click('#btnPause2');
  const exp = await (await fetch(`http://127.0.0.1:${PORT}/api/export`, { method: 'POST', headers: { Host: 'localhost:' + PORT, 'Content-Type': 'application/json' }, body: '{}' })).json();
  check(exp.rows === 1 && fs.existsSync(path.join(main.marks, 'marks_export.csv')), 'Export writes marks_export.csv with one row');

  console.log('4. free mode');
  await page.click('#tabFree');
  await until(() => page.evaluate(() => document.getElementById('freeDay').options.length > 0));
  const days = await page.evaluate(() => [...document.getElementById('freeDay').options].map(o => o.value));
  check(days.includes('2026-03-10') && !days.includes('2026-04-02'), 'free: the holdout day is not listed');
  await page.selectOption('#freeDay', '2026-03-10');
  await page.fill('#freeTime', '10:05');
  await page.click('#btnLoad');
  await chartsReady(page);
  await page.click('[data-speed="20"]');
  await sleep(2500);
  await page.click('#btnPause');
  await until(() => page.evaluate(() => !document.getElementById('secMachine').hidden && document.getElementById('machineOut').rows.length > 3), 6000);
  const fr = await page.evaluate(() => ({ date: document.getElementById('msDate').textContent, rows: document.getElementById('machineOut').rows.length }));
  check(fr.date === '2026-03-10', 'free: the date shows');
  check(fr.rows > 3, 'free: the machine read shows');
  await shot(page, 'markup-free.png');
  const post = (p, b) => fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { Host: 'localhost:' + PORT, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  check((await post('/api/free/load', { date: '2026-04-02', time: '10:00' })).status === 403, 'free: a holdout day is refused');
  const back = await post('/api/jump', { time: '09:00' });
  check(back.status === 409, 'the clock never moves backward');
  const evil = await fetch(`http://127.0.0.1:${PORT}/api/step`, { method: 'POST', headers: { Host: 'localhost:' + PORT, Origin: 'http://evil.example' } });
  check(evil.status === 403, 'another origin is refused');
  await page.close();

  console.log('5. mutation proof: one tick past the clock must fail check 1');
  const src = fs.readFileSync(path.join(root, 'tools', 'markup_studio.py'), 'utf8');
  const line = "return int(np.searchsorted(day.utc, clock_utc, 'left' if exclusive else 'right'))";
  check(src.includes(line), 'the no-future choke point is where the mutation expects it');
  const mutant = path.join(root, 'tools', '_mutant_markup_studio.py');
  fs.writeFileSync(mutant, src.replace(line, "return min(len(day.utc), int(np.searchsorted(day.utc, clock_utc, 'left' if exclusive else 'right')) + 1)  # MUTANT"));
  try {
    const sink = [];
    const m = await noFutureRun(mutant, PORT + 1, 'mutant', sink);
    await m.page.close();
    console.log('  mutant failed ' + sink.length + ' checks, for example: ' + sink.slice(0, 2).join(' / '));
    check(sink.length > 0, 'the smoke catches a server that sends one tick past the clock');
  } finally { fs.rmSync(mutant, { force: true }); }

  console.log('6. bot tab (the public test bot)');
  const bot = await botRun(PORT, 'bot', null);
  const post2 = (p, b) => fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { Host: 'localhost:' + PORT, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const g403 = await post2('/api/bot/load', { date: '2026-03-10' });
  check(g403.status === 403 && /grading day/.test((await g403.json()).error), 'bot: a grading day is refused (403)');
  check((await post2('/api/bot/load', { date: '2026-04-02' })).status === 403, 'bot: a holdout day is refused (403)');
  await bot.page.click('#btnRunAll');
  const nrows = await until(() => bot.page.evaluate(() => { const t = document.querySelector('#botSumMain tbody'); return !document.getElementById('botSummary').hidden && t && t.rows.length; }), 20000);
  check(nrows === 6, 'Run all: the summary has one row per variant x exit id (3 x 2 = 6, got ' + nrows + ')');
  const cellText = await bot.page.evaluate(() => {
    const t = document.getElementById('botSumMain'), cols = [...t.tHead.rows[0].cells].map(c => c.textContent), r = t.tBodies[0].rows[0];
    return { variant: r.cells[0].title, exit: r.cells[1].textContent, net: r.cells[cols.indexOf('Net $ NQ')].textContent,
      micro: r.cells[cols.indexOf('Net $ MNQ')].textContent, note: document.getElementById('botSumNote').textContent };
  });
  check(cellText.micro === '19.00(1)' && cellText.note.includes('NQ $4.50, MNQ $1.00'), 'Run all: MNQ nets $19.00 and the note gives NQ $4.50, MNQ $1.00 (' + cellText.micro + ')');
  // hand-worked: T1000 on 2026-03-05 buys 21,001.00 and the base target is 10 points up: 10 x $20 - $4.50 = $195.50 (1 trade)
  check(cellText.variant === 'T1000' && cellText.exit === 'base' && cellText.net === '195.50(1)', 'Run all: T1000 base nets $195.50 NQ on one trade (' + JSON.stringify(cellText) + ')');
  const runs = path.join(tmp, 'marks-' + PORT, 'botruns');
  const stamp = fs.existsSync(runs) ? fs.readdirSync(runs)[0] : '';
  check(!!stamp && ['trades.csv', 'summary.csv', 'summary.json'].every(n => fs.existsSync(path.join(runs, stamp, n))), 'Run all: trades.csv, summary.csv and summary.json in botruns/<stamp>/');
  await shot(bot.page, 'markup-bot-summary.png');
  await bot.page.click('#btnBotExport');
  const ex = await until(() => bot.page.evaluate(() => document.getElementById('botExportMsg').textContent));
  check(!!ex && ex.includes(path.join('botruns', stamp)), 'Export says where the files are (' + ex + ')');
  await bot.page.close();
  // a screen above 100% scaling (the laptop, 125%): each overlay canvas is exactly its chart's size, not its pixel size
  const hi = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.25 });
  await hi.goto(`http://localhost:${PORT}/live/markup.html`);
  const nov = await until(() => hi.evaluate(() => document.querySelectorAll('canvas.ms-overlay').length >= 2 && document.querySelectorAll('canvas.ms-overlay').length), 15000);
  await sleep(800);
  const off = await hi.evaluate(() => [...document.querySelectorAll('canvas.ms-overlay')].map(c => {
    const r = c.getBoundingClientRect(), p = c.parentElement.getBoundingClientRect(); return Math.max(Math.abs(r.width - p.width), Math.abs(r.height - p.height));
  }));
  check(!!nov && off.length >= 2 && off.every(d => d < 1.5), 'at 125% scaling each overlay covers exactly its chart (off by ' + off.map(d => d.toFixed(1)).join(', ') + ' px)');
  await hi.close();

  console.log('7. mutation proof: a bot view that leaks one future event must fail check 6');
  const csrc = fs.readFileSync(path.join(root, 'tools', 'markup_core.py'), 'utf8');
  const cline = "events = [_pick(e, EVENT_KEYS) for e in evs if e['t'] <= c]";
  check(csrc.includes(cline), 'the bot view filter is where the mutation expects it');
  const mcore = path.join(root, 'tools', '_mutant_markup_core.py'), mstudio = path.join(root, 'tools', '_mutant_bot_markup_studio.py');
  fs.writeFileSync(mcore, csrc.replace(cline, cline + " + [_pick(e, EVENT_KEYS) for e in evs if e['t'] > c][:1]  # MUTANT"));
  fs.writeFileSync(mstudio, src.replace('import markup_core as core', 'import _mutant_markup_core as core'));
  try {
    const sink = [];
    await startServer(mstudio, PORT + 2, path.join(tmp, 'marks-' + (PORT + 2)));
    const m = await botRun(PORT + 2, 'bot mutant', sink);
    await m.page.close();
    console.log('  mutant failed ' + sink.length + ' checks, for example: ' + sink.slice(0, 2).join(' / '));
    check(sink.length > 0, 'the smoke catches a bot view that sends one event before its time');
  } finally { fs.rmSync(mcore, { force: true }); fs.rmSync(mstudio, { force: true }); }

  console.log('8. ES: header, chart root and dollars follow --symbol');
  const EP = PORT + 3, esMarks = path.join(tmp, 'marks_ES');
  await startServer(path.join(root, 'tools', 'markup_studio.py'), EP, esMarks, 'ES');
  const es = await openPage(EP);
  const head = await until(() => es.page.evaluate(() => { const t = document.querySelector('.ms-sub').textContent; return /replay/.test(t) && t !== 'replay, read only' && t; }));
  check(head === 'ES replay, read only', 'ES: the header says "ES replay, read only" (' + head + ')');
  const split = JSON.parse(fs.readFileSync(path.join(esMarks, 'bot_split_v1.json'), 'utf8'));
  check(split.symbol === 'ES', 'ES: the new day split records its symbol (' + split.symbol + ')');
  await es.page.click('#tabBot');
  await until(() => es.page.evaluate(() => document.getElementById('botDay').options.length > 0));
  await es.page.selectOption('#botDay', BOT_DAY);
  await es.page.selectOption('#botVariant', 'T1000');
  await es.page.click('#btnBotLoad');
  check(!!(await chartsReady(es.page)), 'ES: both charts load the ES day');
  const roots = await es.page.evaluate(() => ['range', 'm1'].map(k => window.__markup.panes[k].view().root));
  check(JSON.stringify(roots) === '["ES","ES"]', 'ES: both charts are on root ES (' + roots + ')');
  const frames = es.rec.sockets.flatMap(x => x.frames).map(f => { try { return JSON.parse(f); } catch (e) { return null; } }).filter(Boolean);
  const hello = frames.find(m => m.type === 'hello');
  check(!!hello && JSON.stringify(hello.instruments) === JSON.stringify([{ root: 'ES', name: 'ES replay', tick: 0.25, pointValue: 50.0 }]), 'ES: the hello announces ES ($50 a point)');
  const hroots = [...new Set(frames.filter(m => m.type === 'history' || m.type === 'ticks').map(m => m.root))];
  check(JSON.stringify(hroots) === '["ES"]', 'ES: every history and ticks frame is for ES (' + hroots + ')');
  const esBars = await es.page.evaluate(() => window.__markup.panes.m1.chart.bars().slice(-1)[0].c);
  check(esBars > 5900 && esBars < 6100, 'ES: the chart shows the ES fixture prices (' + esBars + ')');
  await until(async () => ((await state(EP)).bot_day || {}).status === 'done');
  await es.page.fill('#jumpTime', '10:05');
  await es.page.click('#btnJump');
  await chartsReady(es.page);
  const net = await until(() => es.page.evaluate(() => { const r = document.querySelector('#botNet tr'); return r && /1 trades/.test(r.textContent) && r.textContent; }));
  check(!!net && net.includes('$495.50 ES') && net.includes('$49.00 MES') && !/NQ/.test(net), 'ES: the net by exit is in ES and MES (' + net + ')');
  await es.page.click('#btnRunAll');
  await until(() => es.page.evaluate(() => { const t = document.querySelector('#botSumMain tbody'); return !document.getElementById('botSummary').hidden && t && t.rows.length; }), 20000);
  const sum = await es.page.evaluate(() => {
    const t = document.getElementById('botSumMain'), cols = [...t.tHead.rows[0].cells].map(c => c.textContent), r = t.tBodies[0].rows[0];
    return { cols, net: r.cells[cols.indexOf('Net $ ES')]?.textContent, micro: r.cells[cols.indexOf('Net $ MES')]?.textContent, note: document.getElementById('botSumNote').textContent };
  });
  check(['Net $ ES', '$ ES / trade', 'Net $ MES', '$ MES / trade', 'PF (ES)', 'Max DD $ ES', 'Max DD $ MES'].every(c => sum.cols.includes(c)) && !sum.cols.some(c => /NQ/.test(c)),
    'ES: the summary columns name ES and MES (' + sum.cols.filter(c => /\$|PF/.test(c)).join(', ') + ')');
  // hand-worked: T1000 base +10 points: ES 10 x $50 - $4.50 = $495.50, MES 10 x $5 - $1.00 = $49.00 (1 trade)
  check(sum.net === '495.50(1)' && sum.micro === '49.00(1)', 'ES: T1000 base nets $495.50 ES and $49.00 MES on one trade (' + sum.net + ', ' + sum.micro + ')');
  check(sum.note.includes('ES $4.50, MES $1.00'), 'ES: the summary note gives the ES and MES round trips (' + sum.note + ')');
  check(!es.rec.errors.length, 'ES: no page errors (' + es.rec.errors.join('; ') + ')');
  await shot(es.page, 'markup-es-bot.png');
  await es.page.close();

  console.log('9. trades tab (keyboard first)');
  const TP = PORT + 4, tMarks = path.join(tmp, 'marks-trades'), tFlags = tradesFiles();
  const startTrades = async (script, port, marks) => {
    const child = spawn(PY, [script, '--source=npz', '--data=' + dataDir, '--marks=' + marks, '--port=' + port, '--no-browser', '--seen=' + path.join(tmp, 'none.csv'),
      '--bot=' + path.join(root, 'test', 'markup_bot_fixture.py')].concat(tFlags), { stdio: ['ignore', 'pipe', 'inherit'] });
    servers.push(child);
    await new Promise(r => child.stdout.once('data', r));
    await until(async () => ((await state(port).catch(() => ({}))).scan || {}).done, 10000);
  };
  await startTrades(path.join(root, 'tools', 'markup_studio.py'), TP, tMarks);
  const tr = await openPage(TP);
  const t1 = await tradesCut(TP, tMarks, tr.page, tr.rec, 1, 'trades #1', null);
  const cold = t1.s.trade.open_ms;
  const prog0 = await tr.page.evaluate(() => document.getElementById('tProgress').textContent);
  check(prog0.startsWith('Graded 0 of 300 (0 adjusted, 0 days skipped)'), 'trades: the progress line (' + prog0 + ')');
  await shot(tr.page, 'markup-trades-cut.png');
  await tr.page.mouse.move(5, 5);
  await tr.page.keyboard.press('t');
  const res1 = await until(() => tr.page.evaluate(() => !document.getElementById('secTResult').hidden && document.getElementById('tResHead').textContent), 8000);
  check(!!res1 && res1.startsWith('TAKE saved.') && res1.includes(BOT_DAY) && res1.includes(t1.item.trade_id), 'T saves stage 1 and reveals the date and the trade (' + res1 + ')');
  const op = await tr.page.evaluate(() => [document.getElementById('tOpinionBox').hidden, document.getElementById('tOpinion').textContent, document.getElementById('tResult').tBodies[0].rows.length]);
  check(!op[0] && op[1].startsWith(NOTE(t1.item.trade_id)) && op[1].includes('score 0.5') && op[2] === 2, 'the reveal shows the result per exit and the second opinion (' + op[1] + ')');
  const g1 = JSON.parse(fs.readFileSync(path.join(tMarks, 'trade_grades', t1.s.trade.qid + '.json'), 'utf8'));
  check(g1.label === 'TAKE' && g1.date === BOT_DAY && g1.second_opinion.found && g1.second_opinion.score === 0.5, 'the grade file holds TAKE, the date and the second opinion shown');
  check((await state(TP)).date === BOT_DAY, 'after the save the date shows');
  await shot(tr.page, 'markup-trades-reveal.png');
  await sleep(800);
  const dr1 = await tr.page.evaluate(() => window.__markup.botDrawn);
  check([...new Set(dr1.entries)].join() === t1.x.label && dr1.fillPx.every(f => f === '21,001.00') && !dr1.you.length,
    'after the TAKE reveal: only this trade\'s order is drawn (its fill comes after the clock), no YOU (' + [...new Set(dr1.entries)].join(', ') + ')');

  const k2 = mark(tr.rec);
  await tr.page.keyboard.press('n');
  const t2 = await tradesCut(TP, tMarks, tr.page, sub(tr.rec, k2), 2, 'trades #2', null);
  const warm = t2.s.trade.open_ms;
  console.log(`  open a trade: cold ${cold} ms, prefetched ${warm} ms`);
  check(t2.s.trade.prefetched && warm < Math.max(cold, 20), `N opens the next trade prefetched and fast (cold ${cold} ms, prefetched ${warm} ms)`);
  check(!(await tr.page.evaluate(() => document.documentElement.textContent)).includes(BOT_DAY), 'N: the last trade\'s date left the page');
  await tr.page.keyboard.press('a');
  await until(async () => ((await state(TP)).trade || {}).stage === 2, 5000);
  const lit = await until(() => tr.page.evaluate(() => { const o = Object.fromEntries([...document.querySelectorAll('#tKeys li')].map(li => [li.dataset.k, !li.classList.contains('off')])); return o.E && o; }), 4000) || {};
  check(lit.E && lit.S && lit.G && lit.Y && lit.R && !lit.T, 'after A: E, S, G, entry type and next candle lit, T dimmed');
  const before = (await state(TP)).clock_utc_ms;
  await tr.page.keyboard.press('ArrowRight');
  await until(async () => (await state(TP)).clock_utc_ms > before, 5000);
  const tbox = await tr.page.locator('#pane1m .ce-host').boundingBox();
  await tr.page.keyboard.press('e');
  await tr.page.mouse.click(tbox.x + tbox.width * 0.5, tbox.y + tbox.height * 0.35);
  await tr.page.keyboard.press('s');
  await tr.page.mouse.click(tbox.x + tbox.width * 0.55, tbox.y + tbox.height * 0.6);
  check(await tr.page.locator('#tMarkList li').count() === 2, 'ADJUST: E click and S click place two marks');
  const note = await tr.page.evaluate(() => !document.getElementById('tSideNote').hidden && document.getElementById('tSideNote').textContent);
  check(note === "Your trade is long, the bot's is short: this counts as a PASS for the bot's trade. Saving records your trade.",
    'ADJUST on the other side of the bot (it is short): the note shows before the save (' + note + ')');
  const preApi = sub(tr.rec, k2).responses.filter(r => /\/api\//.test(r.url)).map(r => r.body).join('\n');
  check(!/"yours/.test(preApi) && !preApi.includes(BOT_DAY), 'ADJUST stage 2: nothing about his trade (yours) and no date in any response before the save');
  check(!(await tr.page.evaluate(() => window.__markup.botDrawn.you.length)), 'ADJUST stage 2: no YOU drawn before the save');
  await tr.page.keyboard.press('Enter');
  const res2 = await until(() => tr.page.evaluate(() => !document.getElementById('secTResult').hidden && document.getElementById('tResHead').textContent), 8000);
  check(!!res2 && res2.startsWith('ADJUST saved.'), 'Enter saves stage 2 and reveals (' + res2 + ')');
  const a2 = JSON.parse(fs.readFileSync(path.join(tMarks, 'trade_grades', t2.s.trade.qid + '.adjust.json'), 'utf8')).adjust;
  check(a2.entry_type === 'stop-limit' && a2.steps_after_cut === 1 && a2.marks.length === 2 && a2.entry !== null && a2.stop !== null && a2.marks.every(m => m.bar_time_utc_ms < a2.clock_utc_ms),
    'the adjust file: stop-limit by default, 1 step after the cut, Entry and Stop with their bar times');
  check(a2.dir === 'long' && a2.opposite_side === true, 'the adjust file: dir long, opposite_side true');
  const you = await until(() => tr.page.evaluate(() => {
    const el = document.getElementById('tYours'), row = document.querySelector('#tResult tr.you'), d = window.__markup.botDrawn;
    return !el.hidden && row && d.you.length && { text: el.textContent, color: getComputedStyle(el).color, rowColor: getComputedStyle(row.cells[0]).color,
      row: row.textContent, you: d.you, entries: d.entries, fills: d.fillPx };
  }), 8000);
  check(!!you && you.text.startsWith('Your trade: long STP LMT') && you.color === 'rgb(255, 149, 0)' && you.rowColor === 'rgb(255, 149, 0)' && you.row.startsWith('YOU'),
    'the reveal: a Your trade row and line in the accent #FF9500 (' + (you && you.text) + ')');
  check(!!you && you.you.every(t => t.startsWith('YOU ')) && you.you.some(t => t.startsWith('YOU BUY STP LMT')),
    'the charts draw his trade labelled YOU (' + (you ? [...new Set(you.you)].join(', ') : '') + ')');
  check(!!you && [...new Set(you.entries)].join() === t2.x.label && you.fills.every(f => f === '21,010.50'), 'after the ADJUST reveal: only this trade\'s order and fill besides YOU');
  await tr.page.click('#btnJump30');
  await tr.page.evaluate(() => document.activeElement && document.activeElement.blur());   // keys go to the page, not the button
  await until(async () => (await state(TP)).clock_tod >= '11:30', 5000);
  await sleep(1200);
  const dj = await tr.page.evaluate(() => window.__markup.botDrawn);
  // by 11:31 the other trades have closed (the 10:00 long at its target, the 11:00 long at its stop); this one's base exit
  // is still open (flat at 16:00)
  check([...new Set(dj.fillPx)].join() === '21,010.50' && !dj.exitText.length && dj.you.length > 0,
    '30 minutes on: only this trade\'s fill, no other trade\'s exit, and YOU (' + [...new Set(dj.exitText)].join(', ') + ')');
  await shot(tr.page, 'markup-trades-yours.png');
  await tr.page.keyboard.press(' ');
  check(!!(await until(async () => { const s = await state(TP); return s.playing && s.speed === 5; }, 4000)), 'Space plays on at 5x');
  await tr.page.click('#btnPause2');
  await tr.page.keyboard.press('Enter');
  await tradeOpen(TP, 3);
  await until(() => tr.page.evaluate(() => document.getElementById('tInfo').textContent.startsWith('#3') && !document.getElementById('btnTSeen').disabled), 5000);
  await tr.page.keyboard.press('x');
  const xq = await tr.page.evaluate(() => [document.getElementById('tErr').textContent, document.getElementById('tInfo').textContent, (window.__markup.state.trade || {}).stage]);
  check(xq[0].includes('Press X again'), 'X asks to confirm (' + xq.join(' | ') + ')');
  await tr.page.keyboard.press('x');
  await until(() => fs.existsSync(path.join(tMarks, 'trade_skip_days.json')), 5000);
  const skipped = JSON.parse(fs.readFileSync(path.join(tMarks, 'trade_skip_days.json'), 'utf8')).days.map(d => d.date);
  check(JSON.stringify(skipped) === JSON.stringify([BOT_DAY]), 'X X adds the trade\'s day to trade_skip_days.json');
  const prog = await until(() => tr.page.evaluate(() => { const t = document.getElementById('tProgress').textContent; return t.includes('1 days skipped') && t; }), 5000);
  check(!!prog && prog.startsWith('Graded 2 of 300 (1 adjusted, 1 days skipped); 0 left'), 'the progress line counts only (' + prog + ')');
  const st9 = await state(TP);
  const flat = JSON.stringify(st9);
  check(!/"(net|usd|win_pct|wins|pf|TAKE|PASS)"\s*:/.test(flat), 'no tally of outcomes by label in the state');
  const tex = await (await fetch(`http://127.0.0.1:${TP}/api/trades/export`, { method: 'POST', headers: { Host: 'localhost:' + TP, 'Content-Type': 'application/json' }, body: '{}' })).json();
  const head9 = fs.readFileSync(tex.file, 'utf8').split('\n')[0].split(',');
  check(tex.rows === 2 && !head9.some(c => /points|net_|_r$|exit/.test(c)), 'Export: trade_grades.csv has the 2 grades and no outcome column (' + head9.length + ' columns)');
  check(!tr.rec.errors.length, 'trades: no page errors (' + tr.rec.errors.join('; ') + ')');
  await tr.page.close();

  console.log('10. mutation proof: a late cut and a leaked second opinion must fail check 9');
  const coreImport = 'import markup_core as core  # noqa: E402\n';
  check(src.includes(coreImport), 'the core import is where the one-trade mutation expects it');
  const mutants = [['late', src.replace(line, "return min(len(day.utc), int(np.searchsorted(day.utc, clock_utc, 'left' if exclusive else 'right')) + 1)  # MUTANT")],
    ['note', src.replace("out = {'qid': it['qid'], 'name': self.bot['name'],", "out = {'leak': self._opinion(it), 'qid': it['qid'], 'name': self.bot['name'],  # MUTANT\n              ")],
    ['others', src.replace(coreImport, coreImport + "_only = core.trade_only\ncore.trade_only = lambda view, res, t, o: dict(_only(view, res, t, o), orders=view.get('orders'))  # MUTANT\n")]];
  check(src.includes("out = {'qid': it['qid'], 'name': self.bot['name'],"), 'the trades view is where the note mutation expects it');
  for (const [k, text] of mutants) {
    const f = path.join(root, 'tools', `_mutant_trades_${k}_markup_studio.py`), mp = PORT + 5 + ['late', 'note', 'others'].indexOf(k), mm = path.join(tmp, 'marks-mutant-' + k);
    fs.writeFileSync(f, text);
    try {
      await startTrades(f, mp, mm);
      const sink = [], m = await openPage(mp);
      if (k === 'others') {                                  // trade #1 (10:00) has no other order; #2 (11:01) has three
        await tradesCut(mp, mm, m.page, m.rec, 1, 'trades mutant ' + k, null);
        await m.page.keyboard.press('t');
        await until(() => m.page.evaluate(() => !document.getElementById('secTResult').hidden), 8000);
        const km = mark(m.rec);
        await m.page.keyboard.press('n');
        await tradesCut(mp, mm, m.page, sub(m.rec, km), 2, 'trades mutant ' + k, sink);
      } else await tradesCut(mp, mm, m.page, m.rec, 1, 'trades mutant ' + k, sink);
      await m.page.close();
      console.log(`  mutant ${k} failed ${sink.length} checks, for example: ${sink.slice(0, 2).join(' / ')}`);
      check(sink.length > 0, `the smoke catches a Trades server with ${{ late: 'a cut one tick late', note: 'the second opinion in the bot view', others: 'other trades\' orders in the Trades view' }[k]}`);
    } finally { fs.rmSync(f, { force: true }); }
  }

  console.log('11. PASS, then my trade instead (M), with --trade-exits=t5');
  const IP = PORT + 8, iMarks = path.join(tmp, 'marks-instead');
  {
    const child = spawn(PY, [path.join(root, 'tools', 'markup_studio.py'), '--source=npz', '--data=' + dataDir, '--marks=' + iMarks, '--port=' + IP, '--no-browser',
      '--seen=' + path.join(tmp, 'none.csv'), '--bot=' + path.join(root, 'test', 'markup_bot_fixture.py'), '--trade-exits=t5'].concat(tFlags), { stdio: ['ignore', 'pipe', 'inherit'] });
    servers.push(child);
    await new Promise(r => child.stdout.once('data', r));
    await until(async () => ((await state(IP).catch(() => ({}))).scan || {}).done, 10000);
  }
  const ip = await openPage(IP);
  const i1 = await tradeOpen(IP, 1);
  await chartsReady(ip.page);
  await sleep(800);
  await ip.page.mouse.move(5, 5);
  await ip.page.keyboard.press('p');
  await until(async () => ((await state(IP)).trade || {}).stage === 4, 5000);
  const pend = await until(() => ip.page.evaluate(() => !document.getElementById('secTPass').hidden && {
    result: !document.getElementById('secTResult').hidden, text: document.documentElement.textContent,
    lit: Object.fromEntries([...document.querySelectorAll('#tKeys li')].map(li => [li.dataset.k, !li.classList.contains('off')])) }), 5000);
  check(!!pend && !pend.result && !pend.text.includes(BOT_DAY) && pend.lit.M && pend.lit.N && !pend.lit.T, 'P: the PASS waits for M or N; no result, no date, M lit');
  await ip.page.keyboard.press('m');
  const ihead = await until(() => ip.page.evaluate(() => !document.getElementById('secTAdjust').hidden && document.getElementById('tOwnHead').textContent), 4000);
  check(ihead === 'Your trade instead', 'M opens his own trade\'s tools (' + ihead + ')');
  const ibefore = (await state(IP)).clock_utc_ms;
  await ip.page.keyboard.press('ArrowRight');
  await until(async () => (await state(IP)).clock_utc_ms > ibefore, 5000);
  const ib = await ip.page.locator('#pane1m .ce-host').boundingBox();
  await ip.page.keyboard.press('e');
  await ip.page.mouse.click(ib.x + ib.width * 0.5, ib.y + ib.height * 0.35);
  await ip.page.keyboard.press('s');
  await ip.page.mouse.click(ib.x + ib.width * 0.55, ib.y + ib.height * 0.6);
  await ip.page.keyboard.press('g');
  await ip.page.mouse.click(ib.x + ib.width * 0.6, ib.y + ib.height * 0.3);    // a target a little over the entry
  const iapi = () => ip.rec.responses.filter(r => /\/api\//.test(r.url)).map(r => r.body).join('\n');
  check(!/"yours/.test(iapi()) && !iapi().includes(BOT_DAY) && !ip.rec.responses.some(r => /\/api\/trades\/result/.test(r.url) && r.body.includes('"trade_id"')),
    'before his trade instead is saved: no result, no date and nothing about his trade in any response');
  await ip.page.keyboard.press('Enter');
  const ires = await until(() => ip.page.evaluate(() => !document.getElementById('secTResult').hidden && !document.getElementById('tYours').hidden &&
    { head: document.getElementById('tResHead').textContent, yours: document.getElementById('tYours').textContent }), 8000);
  check(!!ires && ires.head.startsWith('PASS saved, your trade instead.') && ires.yours.startsWith('Your trade instead: long'), 'Enter saves his trade instead, then the reveal (' + (ires && ires.head) + ')');
  const mine1 = JSON.parse(fs.readFileSync(path.join(iMarks, 'trade_grades', i1.trade.qid + '.mine.json'), 'utf8'));
  const g1i = JSON.parse(fs.readFileSync(path.join(iMarks, 'trade_grades', i1.trade.qid + '.json'), 'utf8'));
  check(mine1.kind === 'instead' && mine1.mine.after_reveal === false && mine1.mine.steps_after_cut === 1 && mine1.mine.dir === 'long' && g1i.label === 'PASS',
    'the .mine.json: kind instead, after_reveal false, 1 step, long; the label stays PASS');
  const il = await until(() => ip.page.evaluate(() => { const d = window.__markup.botDrawn; return d && d.legs.length && d.you.length && d; }), 5000) || { legs: [], you: [] };
  const labels = [...new Set(il.legs.map(l => l.label))].sort().join(), prices = [...new Set(il.legs.map(l => l.price))].sort().join();
  check(labels === 't5 stop,t5 target' && prices === '20996,21006' && !il.legs.some(l => l.price === 21011),
    '--trade-exits=t5: the t5 stop and target are drawn, named, never the primary target 21,011.00 (' + labels + '; ' + prices + ')');
  await ip.page.click('#btnJump30');
  await ip.page.evaluate(() => document.activeElement && document.activeElement.blur());
  const iy = await until(() => ip.page.evaluate(() => { const d = window.__markup.botDrawn; return d && d.you.some(t => /^YOU (target|stop|flat) /.test(t)) && [...new Set(d.you)]; }), 6000);
  check(!!iy && iy.some(t => /^YOU \d/.test(t.replace(/,/g, ''))), '30 minutes on: his fill and his exit are drawn, labelled YOU (' + (iy || []).join(', ') + ')');
  await shot(ip.page, 'markup-trades-instead.png');
  await ip.page.keyboard.press('n');
  await tradeOpen(IP, 2);
  await until(() => ip.page.evaluate(() => document.getElementById('tInfo').textContent.startsWith('#2') && !document.getElementById('secTGrade').hidden), 5000);
  await ip.page.keyboard.press('p');
  await until(() => ip.page.evaluate(() => !document.getElementById('secTPass').hidden), 5000);
  const kp = mark(ip.rec);
  await ip.page.keyboard.press('n');
  const ires2 = await until(() => ip.page.evaluate(() => !document.getElementById('secTResult').hidden && document.getElementById('tResHead').textContent), 8000);
  const q2 = (await state(IP)).trade.qid;
  const mine2 = JSON.parse(fs.readFileSync(path.join(iMarks, 'trade_grades', q2 + '.mine.json'), 'utf8'));
  check(!!ires2 && ires2.startsWith('PASS saved.') && mine2.kind === 'none' && (await state(IP)).trade.n === 2, 'P then N: no trade of his own (kind none), then the result; the same trade stays open');
  check(!sub(ip.rec, kp).responses.some(r => /\/api\/trades\/result/.test(r.url) && /"yours"/.test(r.body)), 'no Your trade in the result of a PASS without one');
  check(!ip.rec.errors.length, 'instead: no page errors (' + ip.rec.errors.join('; ') + ')');
  await ip.page.close();
} catch (e) {
  failures.push('crashed: ' + (e.stack || e.message));
  console.error(e);
} finally {
  await browser.close();
  for (const s of servers) s.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${checks} checks, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
