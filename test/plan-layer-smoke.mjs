// The plan layer (chart 1.62.0, the planner): the engine alone (test/plan-layer-host.html, made-up bars, sample data only):
//   - setPlans draws each plan's entry, stop and target 1 over its box, with labels and axis tags; screenshots of a long and a
//     short plan, one only drawn (editable, with handles) and one armed (locked), at 1440x860;
//   - a drag of an editable plan's stop or target moves that line alone, of its entry all three (planMove with the new prices,
//     on the tick); the stop never crosses the entry; Escape takes a drag back; a click selects (planSelect);
//   - a locked plan's line is never moved: a press says so once (planPressOff) and pans as before;
//   - the Plan tool: a click on the plot asks for a plan at that price (planCreate), then the tool is off;
//   - the drawings are untouched by all of it (getDrawings stays empty).
//   npm run smoke:plan-layer        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
page.on('pageerror', e => errors.push('page: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('file://' + path.join(root, 'test', 'plan-layer-host.html'));
await page.waitForTimeout(400);
const box = await page.locator('#chart canvas').first().boundingBox();
const heard = () => page.evaluate(() => window.heard.splice(0));
const handles = () => page.evaluate(() => window.chart.planHandles());
const lastClose = await page.evaluate(() => window.bars[window.bars.length - 1].c);
const t0 = await page.evaluate(() => window.bars[110].t);
const long = { id: 'p1', side: 'long', entry: lastClose - 6, stop: lastClose - 10, target: lastClose + 2, state: 'draft', editable: true, label: 'Plan LONG LMT 2', note: 'not submitted', t0, qty: 2 };
const short = { id: 'p2', side: 'short', entry: lastClose + 8, stop: lastClose + 11, target: lastClose + 2, state: 'armed', editable: false, label: 'Plan #12 SHORT MIT 1', note: 'armed · 28m left', t0: t0 + 1200, qty: 1 };
await page.evaluate(l => window.chart.setPlans(l), [long, short]);
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, 'plan-layer.png') });
let h = await handles();
check(h.length === 6, 'two plans drawn, three lines each: ' + h.length);
check(h.filter(x => x.id === 'p1').every(x => x.editable) && h.filter(x => x.id === 'p2').every(x => !x.editable), 'the drawn plan is editable, the armed one is not');
const line = (id, which) => h.find(x => x.id === id && x.which === which);

// drag the long's stop down 2 points: only the stop moves, on the tick
let s = line('p1', 'stop');
await page.mouse.move(box.x + s.x0 + 80, box.y + s.y);
await page.mouse.down();
for (let k = 1; k <= 6; k++) { await page.mouse.move(box.x + s.x0 + 80, box.y + s.y + k * 6); await page.waitForTimeout(16); }
await page.screenshot({ path: path.join(out, 'plan-layer-drag.png') });
await page.mouse.up();
let ev = await heard();
const mv = ev.find(e => e.ev === 'planMove');
check(!!mv && mv.which === 'stop' && mv.entry === long.entry && mv.target === long.target && mv.stop < long.stop && Math.abs(mv.stop / 0.25 - Math.round(mv.stop / 0.25)) < 1e-9, 'a stop drag moves the stop alone, on the tick: ' + JSON.stringify(mv));
// the host takes it (as the planner does) and sets the plans again
await page.evaluate(m => window.chart.setPlans([Object.assign({}, window.chart.getPlans()[0], { stop: m.stop }), window.chart.getPlans()[1]]), mv);
await page.waitForTimeout(100);
h = await handles();

// the stop dragged up through the entry stops one tick under it
s = line('p1', 'stop');
const e1 = line('p1', 'entry');
await page.mouse.move(box.x + s.x0 + 80, box.y + s.y);
await page.mouse.down();
for (let k = 1; k <= 10; k++) { await page.mouse.move(box.x + s.x0 + 80, box.y + s.y - k * ((s.y - e1.y + 60) / 10)); await page.waitForTimeout(16); }
await page.mouse.up();
ev = await heard();
const mv2 = ev.find(e => e.ev === 'planMove');
check(!!mv2 && mv2.stop === long.entry - 0.25, 'a long\'s stop never crosses its entry (one tick under it): ' + (mv2 && mv2.stop));
await page.evaluate(() => window.chart.setPlans(window.chart.getPlans()));   // the host did not take it: drawn as before
await page.waitForTimeout(100);

// the entry drags all three; Escape takes a drag back
h = await handles();
const en = line('p1', 'entry');
await page.mouse.move(box.x + en.x0 + 120, box.y + en.y);
await page.mouse.down();
for (let k = 1; k <= 5; k++) { await page.mouse.move(box.x + en.x0 + 120, box.y + en.y - k * 5); await page.waitForTimeout(16); }
await page.keyboard.press('Escape');
await page.mouse.up();
ev = await heard();
check(!ev.some(e => e.ev === 'planMove'), 'Escape takes a plan\'s drag back: nothing heard');
await page.mouse.move(box.x + en.x0 + 120, box.y + en.y);
await page.mouse.down();
for (let k = 1; k <= 5; k++) { await page.mouse.move(box.x + en.x0 + 120, box.y + en.y - k * 5); await page.waitForTimeout(16); }
await page.mouse.up();
ev = await heard();
const mv3 = ev.find(e => e.ev === 'planMove');
const was = (await page.evaluate(() => window.chart.getPlans()[0]));
check(!!mv3 && mv3.which === 'entry' && mv3.entry > was.entry && Math.abs((mv3.entry - was.entry) - (mv3.stop - was.stop)) < 1e-9 && Math.abs((mv3.entry - was.entry) - (mv3.target - was.target)) < 1e-9, 'the entry carries the stop and target with it: ' + JSON.stringify(mv3));
await page.evaluate(() => window.chart.setPlans(window.chart.getPlans()));

// a click selects
h = await handles();
const tg = line('p1', 'target');
await page.mouse.click(box.x + tg.x0 + 60, box.y + tg.y);
ev = await heard();
check(ev.some(e => e.ev === 'planSelect' && e.id === 'p1') && !ev.some(e => e.ev === 'planMove'), 'a click on a plan\'s line selects it and moves nothing');

// a locked plan: a press says so once and moves nothing
const lk = line('p2', 'entry');
const before = JSON.stringify((await page.evaluate(() => window.chart.getPlans()))[1]);
await page.mouse.move(box.x + lk.x0 + 60, box.y + lk.y);
await page.mouse.down();
for (let k = 1; k <= 5; k++) { await page.mouse.move(box.x + lk.x0 + 60 - k * 10, box.y + lk.y + k * 4); await page.waitForTimeout(16); }
await page.mouse.up();
ev = await heard();
check(ev.filter(e => e.ev === 'planPressOff' && e.id === 'p2').length === 1 && !ev.some(e => e.ev === 'planMove'), 'a locked plan\'s line: planPressOff once, never a move');
check(JSON.stringify((await page.evaluate(() => window.chart.getPlans()))[1]) === before, 'the locked plan is as it was');

// the Plan tool: a click asks for a plan at that price, then the tool is off
await page.evaluate(() => { window.chart.goLive(); window.chart.setTool('plan'); });
await page.waitForTimeout(300);
check(await page.evaluate(() => window.chart.getTool()) === 'plan', 'the Plan tool arms');
await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
ev = await heard();
const cr = ev.find(e => e.ev === 'planCreate');
check(!!cr && Math.abs(cr.price / 0.25 - Math.round(cr.price / 0.25)) < 1e-9 && isFinite(cr.t), 'a click with the Plan tool asks for a plan at a price on the tick: ' + JSON.stringify(cr));
check(await page.evaluate(() => window.chart.getTool()) === null, 'the tool is off after one plan');
check((await page.evaluate(() => window.chart.getDrawings())).length === 0, 'no drawing was made by any of it');

// selected, then a short only drawn (for the screenshot of both sides and states)
await page.evaluate(() => window.chart.setPlans(window.chart.getPlans().map((p, i) => Object.assign(p, { selected: i === 0, state: i === 0 ? 'submitted' : 'armed', note: i === 0 ? 'submitted · Arm on the card' : p.note }))));
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(out, 'plan-layer-submitted.png') });
await page.evaluate(() => window.chart.setPlans([]));
await page.waitForTimeout(100);
check((await handles()).length === 0, 'setPlans([]) clears the layer');
await browser.close();
if (errors.length) { console.error('FAIL (' + errors.length + ' of ' + checks + ')\n' + errors.join('\n')); process.exit(1); }
console.log('plan-layer smoke: ok (' + checks + ' checks)');
