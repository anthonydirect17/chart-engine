// The Bot tab (chart 1.16.0, live/bot.js) in the workspace against the fake bridge's protocol v3 (fake-bridge --v3, every
// switch on, a simulated bot, a made-up library file: test/fixtures/bot-library.json). Made-up bots and accounts only.
//   - the bot strip on the Main tab only; a click opens the Bot tab (the grid hidden, ?tab=bot);
//   - the Library: the two shelves, the slot, the evidence badges; a click opens the build full screen (the large curve,
//     the tiles counting to their values, the stamp, the rule card, the conditions with their trade counts, thin cells
//     faded); Escape closes it;
//   - R4: a click during the entrance acts at once and finishes it; R3: the kill switch, the mode, position and P&L are
//     never animated;
//   - the panel: the kill switch (on in one click, release in two), the rails tightened (never loosened), the modes
//     (Sim auto asks once more; a Research build offers Shadow only), the day type calls logged with their times;
//   - copilot proposals on the Main tab: botSeen the moment one shows, Accept with The Desk's accept key, Reject with
//     the button, an expired one shows "not answered" and goes; ChartBridge places the order from the proposal itself;
//   - corner notices; per-chart ghost marks from a chart's menu (off by default); Less motion in Settings;
//   - the pop-out window (bot.html) on its own connection;
//   - with the bot switch off: the Bot tab says the bot channel is off and offers nothing (no strip, no ghost choice);
//     with no library file: "No frozen builds on this PC".
//   npm run smoke:bot        (CHROMIUM_PATH=/path/to/chrome; BOT_SMOKE_PORT; SHOTS=dir)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = +(process.env.BOT_SMOKE_PORT || 8961);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let port = PORT;
const control = async (what, q) => (await fetch(`http://127.0.0.1:${port}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const v3 = () => control('v3');
async function until(fn, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t0 > ms) { fail('timed out: ' + what); return null; } await sleep(150); }
}
async function startBridge(p, flags) {
  port = p;
  const br = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(p), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN].concat(flags || []), { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { br.stdout.once('data', res); br.once('exit', c => rej(new Error('bridge exited ' + c))); });
  return br;
}
/* The Desk's hotkeys document with the copilot keys (made up; The Desk is not running in the test) */
const DESK_KEYS = { rev: 3, keys: { buy: '', sell: '', be: '', close: '', flattenAll: '', merge: '', maximize: '', accept: 'Alt+Y', reject: 'Alt+N' }, modifiers: { limit: '', stop: '' } };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let bridge = null;
try {
  bridge = await startBridge(PORT);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route('http://localhost:8800/api/chart-hotkeys', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(DESK_KEYS) }));
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  const open = async (q = '?layout=Main') => {
    await page.goto(`http://localhost:${port}/live/${q}`);
    await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
    await enterPin(page, TEST_PIN);
    await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
  };
  const B = () => page.evaluate(() => window.workspace.bot());
  await open();

  /* ---------------------------------------------------------------- the strip on Main */
  console.log('the bot strip (Main tab)');
  await until(async () => (await B()).on, 'the bot switch read from ChartBridge (trading.switches.bot)');
  check(await page.isVisible('#wsBotTab'), 'the Bot tab button is in the top bar');
  check(await page.isHidden('#btStrip'), 'no strip before ChartBridge tells the bot\'s status');
  await control('bot-connect', { name: 'Sample Lantern Fade' });
  await until(() => page.isVisible('#btStrip .bt-sline'), 'the strip shows');
  const strip = await page.textContent('#btStrip');
  check(/Sample Lantern Fade/.test(strip) && /Shadow/.test(strip) && /Flat/.test(strip) && /\$0\.00/.test(strip) && /0 of 5/.test(strip) && /0 of 3/.test(strip),
    'one line: name, mode, position, P&L, the rails: "' + strip.replace(/\s+/g, ' ').trim() + '"');
  await page.screenshot({ path: path.join(SHOTS, 'bot-strip.png'), clip: { x: 0, y: 0, width: 1600, height: 120 } });

  /* ---------------------------------------------------------------- the Bot tab, mid-entrance: R4 and R3 */
  console.log('the Bot tab: the entrance, a click during it');
  await page.click('#btStrip .bt-sline');
  const mid = await page.evaluate(() => {
    const op = sel => { const el = document.querySelector(sel); return el ? +getComputedStyle(el).opacity : null; };
    return { lib: op('.bt-lib .bt-ph'), kill: document.querySelector('.bt-kill').style.opacity, killOp: op('.bt-kill'), money: document.querySelector('.bt-money').style.opacity,
      modes: document.querySelector('.bt-modes').style.cssText, chart: document.querySelector('.bt-chart').style.cssText, grid: getComputedStyle(document.getElementById('wsGrid')).display };
  });
  check(mid.lib !== null && mid.lib < 1, 'the entrance is running: the Library\'s header is still rising (opacity ' + mid.lib + ')');
  check(mid.kill === '' && mid.killOp === 1 && mid.money === '' && mid.modes === '' && mid.chart === '', 'R3: the kill switch, the mode, position and P&L and the chart are never animated, even mid-entrance');
  check(mid.grid === 'none' && /tab=bot/.test(page.url()), 'the grid is hidden while the Bot tab is open; the URL keeps ?tab=bot');
  await page.click('.bt-dtype [data-dt="Trend"]');                 // a click during the scene (R4)
  const after = await page.evaluate(() => ({ lib: +getComputedStyle(document.querySelector('.bt-lib .bt-ph')).opacity, inline: [...document.querySelectorAll('.bt-grid [data-in]')].filter(e => e.style.opacity !== '').length }));
  let st = await B();
  check(st.dayType === 'Trend' && st.dayCalls === 1, 'R4: the click acted at once (day type Trend logged)');
  check(after.lib === 1 && after.inline === 0, 'R4: the click finished the entrance: every piece in its final state, its own styles back');

  /* ---------------------------------------------------------------- the Library */
  console.log('the Library');
  await until(async () => (await B()).library.state === 'ok', 'the library read from GET /bot-library');
  const lib = await page.evaluate(() => ({ ready: [...document.querySelectorAll('[data-shelf="ready"] .bt-entry .nm')].map(e => e.textContent), research: [...document.querySelectorAll('[data-shelf="research"] .bt-entry .nm')].map(e => e.textContent),
    badges: [...document.querySelectorAll('.bt-entry .bt-badge')].map(e => e.textContent), slot: document.querySelector('[data-k="slot"]').textContent, loaded: [...document.querySelectorAll('.bt-entry.loaded .nm')].map(e => e.textContent),
    thumbs: [...document.querySelectorAll('.bt-thumb')].map(c => c.width > 10), ev: document.querySelector('[data-k="ev"]').textContent }));
  check(lib.ready.join() === 'Sample Lantern Fade,Sample Harbor Pullback' && lib.research.join() === 'Sample Kite Sweep,Sample Quarry Turn', 'two shelves: Ready ' + lib.ready.join(', ') + '; Research ' + lib.research.join(', '));
  check(lib.badges.join() === 'L2,L1,Research,Research', 'evidence badges: ' + lib.badges.join(', '));
  check(/Slot 1: Sample Lantern Fade in Shadow/.test(lib.slot) && lib.loaded.join() === 'Sample Lantern Fade' && lib.ev === 'L2', 'one slot: the running bot is its library entry (' + lib.slot + ')');
  check(lib.thumbs.length === 4 && lib.thumbs.every(Boolean), 'each entry has its equity curve thumbnail');
  const dtw = await page.textContent('[data-k="dtWhy"]');
  check(/Called Trend at \d\d:\d\d ET \(1 call today/.test(dtw), 'the day type call shown with its time: ' + dtw);
  await page.click('.bt-dtype [data-dt="Range"]');
  await page.click('.bt-panel [data-ptab="log"]');
  const logText = await page.textContent('[data-k="tabBody"]');
  check(/Day type called: Range/.test(logText) && /Day type called: Trend/.test(logText), 'every day type call is in the Log');
  await page.screenshot({ path: path.join(SHOTS, 'bot-tab.png') });

  console.log('a build full screen');
  await page.click('.bt-entry[data-id="sample-lantern-fade"]');
  await page.waitForSelector('.bt-detail');
  await sleep(150);
  const dmid = await page.evaluate(() => { const s = document.querySelector('.bt-detail .bt-stamp'); return { stampScale: s.style.scale, rot: getComputedStyle(s).transform }; });
  check(dmid.stampScale !== '' && dmid.rot !== 'none', 'the evidence stamp lands with its own tilt kept (scale ' + dmid.stampScale + ')');
  await page.waitForFunction(() => !document.querySelector('.bt-detail [data-count]') || [...document.querySelectorAll('.bt-detail [data-count]')].every(e => !e.style.opacity && e.textContent !== '0'), null, { timeout: 8000 });
  await sleep(1600);
  const det = await page.evaluate(() => ({
    title: document.querySelector('.bt-dtitle h2').textContent, tiles: [...document.querySelectorAll('.bt-tile')].map(t => [...t.children].map(c => c.textContent).join(' ')),
    rules: document.querySelectorAll('.bt-rules li').length, tod: document.querySelectorAll('.bt-tod .b').length, todThin: document.querySelectorAll('.bt-tod .b.thin').length,
    counts: [...document.querySelectorAll('.bt-tod .n')].map(n => n.textContent), hb: document.querySelectorAll('.bt-hb').length, thin: document.querySelectorAll('.bt-hb.thin').length,
    curve: document.querySelector('[data-k="eqbig"]').width, live: document.querySelector('.bt-detail').textContent.includes('Live record since loaded'), cond: document.querySelector('.bt-detail').textContent.includes('Conditions it works best in') }));
  check(det.title === 'Sample Lantern Fade' && det.curve > 300, 'full screen: the large equity curve (' + det.curve + ' px)');
  check(det.tiles[0] === '214 Trades' && det.tiles[1] === '58.4% Won' && det.tiles[2] === '+0.31 R Average', 'the tiles counted to their values: ' + det.tiles.slice(0, 3).join(' | '));
  check(det.rules === 6 && det.live && det.cond, 'the rule card (6 rules), the live record, the conditions');
  check(det.tod >= 10 && det.counts.every(c => /^\d+$/.test(c)) && det.hb === 12, 'time of day in 30-minute windows (' + det.tod + ') and the day type, volatility and level cells (' + det.hb + '), each with its trade count');
  check(det.todThin + det.thin > 0, 'thin cells (under 20 trades) are faded: ' + (det.todThin + det.thin));
  await page.screenshot({ path: path.join(SHOTS, 'bot-detail.png') });
  await page.keyboard.press('Escape');
  check(!(await B()).detail && !(await page.$('.bt-detail')), 'Escape closes it');

  /* ---------------------------------------------------------------- the panel: kill switch, rails, modes */
  console.log('the bot panel');
  await page.click('.bt-kill');
  await until(async () => (await v3()).bot.killed === true, 'the kill switch reached ChartBridge in one click');
  await until(async () => /Release/.test(await page.textContent('.bt-kill')), 'the kill switch says how to release it');
  await page.click('.bt-kill');
  await sleep(400);
  check((await v3()).bot.killed === true, 'one click does not release it');
  await page.click('.bt-kill');
  await until(async () => (await v3()).bot.killed === false, 'the second click releases it');
  await page.click('[data-act="railsOpen"]');
  const maxAttr = await page.getAttribute('[data-k="railTIn"]', 'max');
  await page.fill('[data-k="railTIn"]', '6');
  await page.click('[data-act="railsSave"]');
  const loosen = await page.textContent('[data-k="railsWhy"]');
  check(maxAttr === '5' && /only be tightened/.test(loosen), 'the rails never loosen: ' + loosen);
  check((await v3()).bot.maxTrades === 5, 'nothing was sent for a loosening');
  await page.fill('[data-k="railTIn"]', '3'); await page.fill('[data-k="railLIn"]', '2');
  await page.click('[data-act="railsSave"]');
  await until(async () => { const b = (await v3()).bot; return b.maxTrades === 3 && b.maxLosses === 2; }, 'botRails reached ChartBridge');
  await until(async () => (await page.textContent('[data-k="railTText"]')) === '0 of 3' && (await page.textContent('[data-k="railLText"]')) === '0 of 2', 'the panel shows the tighter rails');
  await page.click('.bt-modes [data-mode="copilot"]');
  await until(async () => (await v3()).bot.mode === 'copilot', 'Copilot');
  await page.click('.bt-modes [data-mode="auto"]');
  await sleep(300);
  check((await v3()).bot.mode === 'copilot' && (await page.textContent('.bt-modes [data-mode="auto"]')) === 'Confirm', 'Sim auto asks once more');
  await page.click('.bt-modes [data-mode="auto"]');
  await until(async () => (await v3()).bot.mode === 'auto', 'Sim auto on Sim101 (ChartBridge allows it: Sim101 is tradable)');
  await page.click('.bt-modes [data-mode="shadow"]');
  await until(async () => (await v3()).bot.mode === 'shadow', 'back to Shadow');

  /* ---------------------------------------------------------------- notices and proposals on the Main tab */
  console.log('copilot proposals wherever Anthony is (the Main tab)');
  await page.click('#wsBotTab');
  await until(async () => !(await B()).shown && (await page.isVisible('#btStrip .bt-sline')), 'back on Main');
  await control('bot-signal', { id: 's1', action: 'skipped', reason: 'Sample: the range was too wide' });
  await until(() => page.isVisible('.bt-note'), 'a corner notice for a signal');
  check(/Skipped/.test(await page.textContent('.bt-note')), 'it says what the signal was');
  await until(async () => (await B()).keys.accept === 'Alt+Y', 'the copilot keys from The Desk\'s hotkeys document');
  await control('bot-proposal', { id: 'p1', side: 'sell', kind: 'market', stop: 12, target: 24, reason: 'Sample: price stalled at the made-up line twice' });
  await until(() => page.isVisible('.bt-prop[data-id="p1"]'), 'the proposal pops up on the Main tab');
  const pv = await until(async () => { const p = (await v3()).proposals.find(x => x.id === 'p1'); return p && p.seenAt ? p : null; }, 'botSeen reached ChartBridge');
  check(!!pv && pv.seenAt > 0 && pv.state === 'open', 'botSeen the moment it showed (seenAt ' + (pv && pv.seenAt) + ')');
  const ptext = await page.textContent('.bt-prop[data-id="p1"]');
  check(/Sell 1 MNQ market/.test(ptext) && /stalled at the made-up line/.test(ptext) && /Stop 12 ticks · Target 24 ticks/.test(ptext) && /Alt\+Y/.test(ptext) && /Alt\+N/.test(ptext), 'the bot\'s reason, the legs and the keys on it');
  check(await page.evaluate(() => getComputedStyle(document.querySelector('.bt-prop .bt-acc')).opacity === '1' && document.querySelector('.bt-props').hasAttribute('data-no-motion')), 'R3: Accept is there at once, never animated');
  await page.screenshot({ path: path.join(SHOTS, 'bot-proposal.png') });
  await page.mouse.click(5, 300);                                   // the focus on the page, as Anthony's would be
  await page.keyboard.press('Alt+KeyY');
  await until(async () => (await v3()).proposals.find(x => x.id === 'p1').state === 'accepted', 'Accept with The Desk\'s accept key');
  const placed = await v3();
  const pp = placed.proposals.find(x => x.id === 'p1');
  check(pp.answeredAt >= pp.seenAt, 'both times recorded: seen ' + pp.seenAt + ', answered ' + pp.answeredAt);
  await until(async () => !(await page.$('.bt-prop[data-id="p1"]')), 'the accepted proposal goes');
  const st2 = await control('state', { root: 'MNQ' });
  check(st2.positions['Sim101|MNQ'] && st2.positions['Sim101|MNQ'].qty === -1, 'ChartBridge placed it on Sim101 from the proposal itself: short 1 MNQ');
  await control('bot-proposal', { id: 'p2', side: 'buy', kind: 'market', stop: 10, target: 20 });
  await until(() => page.isVisible('.bt-prop[data-id="p2"] .bt-rej'), 'a second proposal');
  await page.click('.bt-prop[data-id="p2"] .bt-rej');
  await until(async () => (await v3()).proposals.find(x => x.id === 'p2').state === 'rejected', 'Reject with the button');
  await control('bot-proposal', { id: 'p3', side: 'buy', kind: 'market', stop: 10, target: 20 });
  await until(() => page.isVisible('.bt-prop[data-id="p3"]'), 'a third proposal');
  await control('bot-withdraw', { id: 'p3' });
  await until(async () => /not answered/i.test((await page.textContent('.bt-prop[data-id="p3"]').catch(() => '')) || ''), 'an expired proposal says "not answered"');
  await until(async () => !(await page.$('.bt-prop[data-id="p3"]')), 'and disappears', 6000);
  check((await v3()).proposals.find(x => x.id === 'p3').state === 'not answered', 'ChartBridge logged it as not answered; nothing was sent');

  /* ---------------------------------------------------------------- ghost marks, per chart */
  console.log('ghost marks');
  const mnq = (await page.evaluate(() => window.workspace.panels())).find(p => p.type === 'chart' && p.root === 'MNQ');
  await page.click(`.ws-panel[data-id="${mnq.id}"] [data-act="more"]`);
  const g0 = await page.textContent('#wsMore [data-do="ghost"]');
  check(/Bot trades \(faint\): off/.test(g0), 'off by default, in the chart\'s menu: ' + g0);
  await page.click('#wsMore [data-do="ghost"]');
  const ghosts = await page.evaluate(() => JSON.parse(localStorage.getItem('live-bot-ghost-v1') || '{}'));
  check(ghosts[mnq.id] === true && Object.keys(ghosts).length === 1, 'switched on for that chart only');
  await page.click(`.ws-panel[data-id="${mnq.id}"] [data-act="more"]`);
  check(/: on/.test(await page.textContent('#wsMore [data-do="ghost"]')), 'the menu says it is on');
  await page.keyboard.press('Escape');
  const trips = (await B()).trips;
  check(trips.length === 1 && trips[0].tOut === null && trips[0].dir === -1, 'the bot\'s open trade is known for its marks (' + JSON.stringify(trips) + ')');
  await page.screenshot({ path: path.join(SHOTS, 'bot-ghost.png') });

  /* ---------------------------------------------------------------- Research: shadow only; Less motion */
  console.log('a Research build; Less motion');
  await control('bot-connect', { name: 'Sample Kite Sweep' });
  await page.click('#wsSet');
  await page.click('#wsMotion [data-v="less"]');
  check(await page.evaluate(() => document.documentElement.classList.contains('motion-off') && localStorage.getItem('motion-reduced-v1') === '1'), 'Settings > Motion: Less (the kit\'s own setting)');
  await page.keyboard.press('Escape');
  await page.click('#wsBotTab');
  const lm = await page.evaluate(() => ({ lib: +getComputedStyle(document.querySelector('.bt-lib .bt-ph')).opacity, inline: [...document.querySelectorAll('.bt-grid [data-in]')].filter(e => e.style.opacity !== '').length }));
  check(lm.lib === 1 && lm.inline === 0, 'with Less motion the Bot tab shows in its final state at once');
  await until(async () => /Sample Kite Sweep/.test(await page.textContent('[data-k="slot"]')), 'the slot follows the running bot');
  const modes = await page.evaluate(() => [...document.querySelectorAll('.bt-modes button')].map(b => b.dataset.mode + ':' + (b.disabled ? 'off' : 'on')));
  check(modes.join() === 'shadow:on,copilot:off,auto:off' && /Shadow only/.test(await page.textContent('[data-k="modeWhy"]')), 'a Research build: Shadow only (' + modes.join(', ') + ')');
  await page.click('#wsSet'); await page.click('#wsMotion [data-v="full"]'); await page.keyboard.press('Escape');

  /* ---------------------------------------------------------------- the pop-out */
  console.log('the pop-out window');
  const [pop] = await Promise.all([ctx.waitForEvent('page'), page.click('.bt-pop')]);
  pop.on('pageerror', e => fail('pop-out page error: ' + e.message));
  await pop.waitForSelector('.cb-pin-key', { timeout: 15000 });
  await enterPin(pop, TEST_PIN);
  await until(() => pop.evaluate(() => window.botDesk && window.botDesk.state().on && window.botDesk.state().library.state === 'ok' && window.botDesk.state().chart), 'bot.html: its own connection, the Library and the chart', 20000);
  check(/bot\.html$/.test(new URL(pop.url()).pathname), 'a bot-only page (bot.html) for a third monitor');
  await control('bot-proposal', { id: 'p4', side: 'sell', kind: 'market', stop: 12, target: 24 });
  await until(() => pop.isVisible('.bt-prop[data-id="p4"]'), 'proposals pop up in the pop-out too');
  await until(() => page.isVisible('.bt-prop[data-id="p4"]'), 'and in the workspace');
  await pop.click('.bt-prop[data-id="p4"] .bt-rej');
  await until(async () => !(await page.$('.bt-prop[data-id="p4"]')), 'answered in one window: gone from the other');
  await sleep(1500);
  await pop.screenshot({ path: path.join(SHOTS, 'bot-popout.png') });
  await pop.close();
  bridge.kill();

  /* ---------------------------------------------------------------- the switch off; no library file */
  console.log('the bot switch off');
  bridge = await startBridge(PORT + 1, ['--v3-off=bot']);
  await open();
  await until(async () => { const b = await B(); return b && b.v3 && b.signedIn; }, 'signed in');
  await sleep(500);
  check(!(await B()).on && await page.isVisible('#wsBotTab') && await page.isHidden('#btStrip'), 'off: the Bot tab is there, no strip');
  await page.click('#wsBotTab');
  const offText = await page.textContent('[data-k="offText"]');
  check(/bot channel is off on this PC/.test(offText) && await page.isHidden('.bt-grid') && !(await B()).chart, 'the Bot tab says the bot channel is off and offers nothing: ' + offText);
  await page.click('#wsBotTab');
  const mnq2 = (await page.evaluate(() => window.workspace.panels())).find(p => p.type === 'chart');
  await page.click(`.ws-panel[data-id="${mnq2.id}"] [data-act="more"]`);
  check(await page.isHidden('#wsMore [data-do="ghost"]'), 'no ghost choice in a chart\'s menu');
  await page.keyboard.press('Escape');
  bridge.kill();

  console.log('no library file on this PC');
  bridge = await startBridge(PORT + 2, ['--no-bot-library']);
  await open('?layout=Main&tab=bot');
  await until(async () => (await B()).library.state === 'none', 'GET /bot-library answered 404');
  const none = await page.textContent('[data-k="shelves"]');
  check(/No frozen builds on this PC/.test(none), 'the Library says so plainly: ' + none.trim());
  check((await B()).shown, '?tab=bot opens on the Bot tab');
} catch (e) {
  fail('smoke stopped: ' + (e && e.stack || e));
} finally {
  await browser.close();
  if (bridge) bridge.kill();
}
console.log(errors.length ? `\nFAILED ${errors.length} of ${checks} checks` : `\nall ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
