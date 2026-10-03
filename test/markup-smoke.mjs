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
const FX = JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture.json'), 'utf8')).days['2026-03-10'];

let checks = 0, failures = [];
function check(ok, m, sink) {
  checks++;
  if (sink) { if (!ok) sink.push(m); return ok; }
  if (ok) console.log('  ok   ' + m); else { failures.push(m); console.error('  FAIL ' + m); }
  return ok;
}
const servers = [];
async function startServer(script, port, marks) {
  const child = spawn(PY, [script, '--source=npz', '--data=' + dataDir, '--marks=' + marks, '--port=' + port, '--no-browser', '--seen=' + path.join(tmp, 'none.csv')],
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
function noFuture(rec, clockUtc, sink, label) {
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
    check(prior.length > 0 && JSON.stringify(prior) === JSON.stringify(FX.prior_bars), `${label}: the history starts with exactly the prior day's ${FX.prior_bars.length} minutes`, sink);
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
  // the prior day levels in view (the fixture's prior close, PDL and the low end of its value area sit below this day's prices)
  const pd = ['PDH', 'PD VAH'].filter(k => !seen.drawn.split(' | ').some(t => t.trim().startsWith(k)));
  check(!pd.length, 'blind: the charts draw the prior day levels in view (PDH, PD VAH)' + (pd.length ? ' (missing ' + pd.join(', ') + ')' : ''));
  const mr = await fetch(`http://127.0.0.1:${PORT}/api/machine`, { headers: { Host: 'localhost:' + PORT } });
  check(mr.status === 409, 'blind: the machine read is refused before the grade is saved');
  check(await page.locator('#secMachine').isHidden(), 'blind: the machine read panel is hidden before the grade is saved');
  check(await page.locator('#tabFree').isDisabled(), 'blind: the Free tab is locked while the candidate is ungraded');
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
