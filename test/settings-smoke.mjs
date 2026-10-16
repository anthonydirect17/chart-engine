// Saved settings smoke test (B1: "NQ range set to 40 ticks was back to 20 after a reload"). Drives a mounted chart with its
// toolbar (test/chart-host.html; the single chart page until chart 1.22.0) in Chromium against the fake bridge and checks
// what comes back after a reload:
//   npm run smoke:settings        (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Chart 1.28.0 (ChartBridge 0.6.1, SPEC CE-1): Settings, Account groups: the rules dialog's Type and Hero on duty (every hero
// listed with its tier fit, from the fake PC helper's made-up builds: sample data only), saved and kept; screenshot
// test/out/settings-group-editor.png.
// Chart 1.30.0 (wave 5): account types from The Desk's ledger (test/fake-desk.mjs, made-up values): the Accounts tab's Account
// type dropdown and Apply its rules, the rules dialog's fill, the group's link and "rules differ: Update", the member of another
// type, and the last good list "as of" with The Desk down; screenshots settings-types-accounts-tab.png,
// settings-group-type-filled.png, settings-types-differ.png. The Settings cleanup: every section collapsible and remembered,
// Collapse all / Expand all, the order, and the 1366 x 768 rule open and closed; screenshots settings-sections-*.png.
// Found on 1.3.1: (1) a size typed and not committed (no Enter, no click elsewhere) was never saved, and
// (2) a second chart tab wrote its whole in-memory copy of the sizes back, putting NQ back to 20.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { C, hostUrl, waitLive, view } from './chart-host.mjs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { startFakeHelper } from './fake-helper.mjs';
import { startDesk } from './fake-desk.mjs';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.SETTINGS_SMOKE_PORT || 8793);
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--pin-off'], { stdio: ['ignore', 'pipe', 'inherit'] });   // a mounted chart never has the PIN
await new Promise(r => bridge.stdout.once('data', r));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const live = p => waitLive(p);
const URL = hostUrl(PORT);

async function newPage(ctx) {
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await p.goto(URL); await live(p);
  return p;
}
async function pick(p, seg, text) {
  const pressed = await p.getAttribute(`${C(seg)} >> text="${text}"`, 'aria-pressed');
  if (pressed !== 'true') { await p.click(`${C(seg)} >> text="${text}"`); await live(p); }
  await p.waitForTimeout(300);
}
async function rangeAfterReload(p, rootSym) {
  await p.reload(); await live(p); await p.waitForTimeout(400);
  await pick(p, 'symSeg', rootSym); await pick(p, 'tfSeg', 'Range');
  return { box: await p.inputValue(C('rangeTicks')), range: (await view(p)).range };
}

try {
  // 1. type 40 on NQ and reload straight away: no Enter, no click elsewhere
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const p = await newPage(ctx);
    await pick(p, 'symSeg', 'NQ'); await pick(p, 'tfSeg', 'Range');
    await p.click(C('rangeTicks'), { clickCount: 3 }); await p.keyboard.type('40');
    const r = await rangeAfterReload(p, 'NQ');
    check(r.box === '40' && r.range === 40, 'typed 40 on NQ, reloaded at once: ' + JSON.stringify(r));
    // MNQ keeps its own size
    const m = await rangeAfterReload(p, 'MNQ');
    check(m.box === '20', 'MNQ still 20 while NQ is 40: ' + JSON.stringify(m));
    await ctx.close();
  }
  // 2. two chart tabs: A (NQ) sets 40 with Enter; B (MNQ, opened earlier) then sets its own size
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const a = await newPage(ctx), b = await newPage(ctx);
    await pick(b, 'symSeg', 'MNQ'); await pick(b, 'tfSeg', 'Range');
    await a.bringToFront(); await pick(a, 'symSeg', 'NQ'); await pick(a, 'tfSeg', 'Range');
    await a.fill(C('rangeTicks'), '40'); await a.press(C('rangeTicks'), 'Enter'); await a.waitForTimeout(500);
    await b.bringToFront(); await b.fill(C('rangeTicks'), '16'); await b.press(C('rangeTicks'), 'Enter'); await b.waitForTimeout(500);
    await a.bringToFront();
    const r = await rangeAfterReload(a, 'NQ');
    check(r.box === '40', 'NQ 40 kept after another tab saved MNQ 16: ' + JSON.stringify(r));
    const m = await rangeAfterReload(a, 'MNQ');
    check(m.box === '16', 'MNQ 16 from the other tab: ' + JSON.stringify(m));
    await ctx.close();
  }
  // 3. arrow keys and Tab also stick
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const p = await newPage(ctx);
    await pick(p, 'symSeg', 'ES'); await pick(p, 'tfSeg', 'Range');
    await p.focus(C('rangeTicks')); for (let i = 0; i < 4; i++) await p.keyboard.press('ArrowUp');
    const r = await rangeAfterReload(p, 'ES');
    check(r.box === '12', 'ES 8 + four ArrowUp = 12 after reload: ' + JSON.stringify(r));
    await ctx.close();
  }
  // 5. half-typed sizes (review S1): never saved as a stale prefix, never rebuilt while typing
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const p = await newPage(ctx);
    await pick(p, 'symSeg', 'NQ'); await pick(p, 'tfSeg', 'Range');
    const storedNQ = () => p.evaluate(() => (JSON.parse(localStorage.getItem('live-range-v2') || '{}') || {}).NQ);
    // count chart rebuilds (setBars) from here on
    await p.evaluate(() => { const c = window.liveChart, f = c.setBars; window.__rebuilds = 0; c.setBars = function () { window.__rebuilds++; return f.apply(this, arguments); }; });
    const rebuilds = () => p.evaluate(() => window.__rebuilds);
    // a slow "12": no rebuild at 1, none at 12 until Enter
    await p.click(C('rangeTicks'), { clickCount: 3 }); await p.keyboard.type('1'); await p.waitForTimeout(700);
    check(await rebuilds() === 0 && (await view(p)).range === 20, 'slow "1": no rebuild at 1 tick (' + await rebuilds() + ' rebuilds)');
    await p.keyboard.type('2'); await p.waitForTimeout(700);
    check(await rebuilds() === 0, 'typed "12": still no rebuild before Enter');
    check(await storedNQ() === 12, 'typed "12" is saved for a reload: ' + await storedNQ());
    await p.keyboard.press('Enter'); await p.waitForTimeout(400);
    check(await rebuilds() === 1 && (await view(p)).range === 12, 'Enter: one rebuild at 12 (' + await rebuilds() + ')');
    // "450": the "45" on the way is dropped when the "0" makes it invalid; a reload commits it like Enter (400)
    await p.click(C('rangeTicks'), { clickCount: 3 }); await p.keyboard.type('45'); await p.waitForTimeout(700);
    check(await storedNQ() === 45, '"45" typed and waiting is saved: ' + await storedNQ());
    await p.keyboard.type('0'); await p.waitForTimeout(700);
    check(await storedNQ() === 12, '"450" drops the saved 45, keeps the committed 12: ' + await storedNQ());
    let r = await rangeAfterReload(p, 'NQ');
    check(r.box === '400', '"450" then reload: 400, as Enter would give, never 45: ' + JSON.stringify(r));
    // reload mid-typing: "7" saved after a pause, then "5" and an immediate reload gives 75, not the stale 7
    await p.click(C('rangeTicks'), { clickCount: 3 }); await p.keyboard.type('7'); await p.waitForTimeout(700);
    await p.keyboard.type('5');
    r = await rangeAfterReload(p, 'NQ');
    check(r.box === '75' && r.range === 75, 'reload mid-typing keeps what was in the box: ' + JSON.stringify(r));
    await ctx.close();
  }
  // 4. first run after the update: the indicators and size chosen on 1.3 carry over, so the chart looks the same
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const p = await newPage(ctx);
    await p.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('live-settings-v1', JSON.stringify({ root: 'NQ', tf: 'range', glide: 'smooth', layers: { volume: false, vwap: true, levels: false, fills: true } }));
      localStorage.setItem('live-range-v1', JSON.stringify({ MNQ: 20, NQ: 40, MES: 8, ES: 8 }));
    });
    await p.reload(); await live(p); await p.waitForTimeout(400);
    const layers = await p.evaluate(() => window.liveChart.getLayers());
    check(layers.volume === false && layers.vwap === true && layers.levels === true && layers.ib === true, '1.3 indicator choices carried over (Levels on with only the IB lines, as 1.13 drew the IB on by default): ' + JSON.stringify(layers));
    check(await p.inputValue(C('rangeTicks')) === '40' && (await view(p)).range === 40, '1.3 NQ range 40 carried over');
    // 1.3 had no IB: the main pane gets the Initial balance default (on, 1.5.3), so 2 of the 1.3 four plus IB; since 1.6.0 the two
    // that were off stay on the main pane's chart, hidden; since 1.7.0 the delta pane is on too (shown/on: 4/6)
    check(await p.textContent(C('indCount')) === '4/5' && layers.delta === true, 'indicator count 4/5 (the IB in Levels and the delta pane on by default)');
    const lvNames = await p.evaluate(() => window.liveChart.getLevels().filter(l => l.layer !== 'ib').map(l => l.name));
    check(lvNames.length === 0, 'only the IB lines of Levels drawn: ' + JSON.stringify(lvNames));
    await ctx.close();
  }
  // 6. 1.28.0: a group's Type and default hero in the rules dialog (Settings, Account groups), at 1366 x 768
  {
    const GP = PORT + 1, out = path.join(root, 'test', 'out');
    fs.mkdirSync(out, { recursive: true });
    const gb = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(GP), '--v3', '--trading', '--test-controls', '--board-groups', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise(r => gb.stdout.once('data', r));
    const helper = await startFakeHelper({ bridgePort: GP, agents: ['demo'], builds: [
      { build: 'sample-build-1', stamp: 'aaaaaaaaaaaa', hero: 'Sample Hero A', here: true, shadowOk: true, tier: 'Good', edge: 0.1 },
      { build: 'sample-build-2', stamp: 'bbbbbbbbbbbb', hero: 'Sample Hero B', here: true, shadowOk: true, tier: 'Acceptable', edge: 0.05 },
      { build: 'sample-build-3', stamp: 'cccccccccccc', hero: 'Sample Hero C', here: true, shadowOk: true },
      { build: 'sample-build-9', stamp: 'dddddddddddd', hero: null, here: true, shadowOk: true, tier: 'Good' }] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      const p = await ctx.newPage();
      p.on('pageerror', e => fail('pageerror: ' + e.message));
      await p.goto(`http://localhost:${GP}/live/?layout=Main`);
      await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
      await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
      await p.click('#wsSet');
      await p.waitForFunction(() => !document.getElementById('wsGroupsSec').hidden && document.querySelectorAll('#wsGroups .gp-row').length === 2, null, { timeout: 15000 });
      const row = await p.$eval('#wsGroups .gp-row', e => e.textContent);
      check(/Funded · hero sample-build-3/.test(row), 'the group\'s row: its Type and its default hero (the build, until the helper names it): ' + row);
      await p.click('#wsGroups [data-gp="edit"][data-id="g1"]');
      await p.waitForFunction(() => { const s = document.getElementById('gp-hero'); return s && s.options.length === 4; }, null, { timeout: 10000 });
      const dlg = await p.evaluate(() => ({ type: document.getElementById('gp-accountType').value, hero: document.getElementById('gp-hero').value, opts: [...document.getElementById('gp-hero').options].map(o => o.textContent),
        why: document.getElementById('gp-heroWhy').textContent, fits: (r => r.top >= 0 && r.bottom <= innerHeight)(document.getElementById('wsDialog').getBoundingClientRect()) }));
      check(dlg.type === 'funded' && dlg.hero === 'sample-build-3', 'the dialog opens on Group A\'s Type (Funded) and default hero (sample-build-3): ' + JSON.stringify(dlg));
      check(dlg.opts.join(' | ') === 'None | Sample Hero A (sample-build-1) · Good +0.10R | Sample Hero B (sample-build-2) · Acceptable +0.05R · Acceptable: evals only; funded only when no Good or better hero is on duty | Sample Hero C (sample-build-3) · tier unknown',
        'every hero listed with its tier and its fit for Funded; a build that is not a hero is not: ' + JSON.stringify(dlg.opts));
      check(dlg.why === 'tier unknown' && dlg.fits, 'the chosen hero\'s warning beside it; the dialog fits 1366 x 768');
      await p.selectOption('#gp-accountType', 'eval');
      await p.selectOption('#gp-hero', 'sample-build-2');
      check(await p.textContent('#gp-heroWhy') === 'Acceptable: at most 3 evals at once', 'Evals: Acceptable fits, with its guidance line (shown only)');
      await p.screenshot({ path: path.join(out, 'settings-group-editor.png') });
      await p.click('#wsDialog button[type="submit"]');
      await p.click('#wsSet');
      await p.waitForFunction(() => /Evals · hero Sample Hero B/.test(document.querySelector('#wsGroups .gp-row').textContent), null, { timeout: 10000 }).catch(() => {});
      const row2 = await p.$eval('#wsGroups .gp-row', e => e.textContent);
      check(/Evals · hero Sample Hero B/.test(row2), 'saved: ChartBridge sends it back, the row names the hero: ' + row2);
      await p.click('#wsGroups [data-gp="hedge"][data-id="g1"]');
      await p.waitForTimeout(600);
      check(/Evals · hero Sample Hero B/.test(await p.$eval('#wsGroups .gp-row', e => e.textContent)), 'the No hedging switch keeps the Type and the hero');
      await ctx.close();
    } finally { await helper.close(); gb.kill(); }
  }
  // 7. 1.30.0 (wave 5): account types from The Desk's ledger (the fake Desk, made-up values; SIM-A style accounts), at 1366 x 768
  {
    const TP = PORT + 2, DP = PORT + 3, out = path.join(root, 'test', 'out');
    fs.mkdirSync(out, { recursive: true });
    const T = (o) => Object.assign({ firm: 'Lucid', account_type: 'eval', account_size: 50000, daily_loss: null, drawdown: 2000, drawdown_type: 'eod', lock_at: 50100, profit_target: 3000,
      consistency_pct: 50, max_nq: null, max_mnq: null, notes: 'sample values for the test', sources: [], status: 'not_checked', checked_at: null, version: 1, archived: false,
      created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z' }, o);
    const desk = await startDesk(DP, {
      types: [T({ id: 'lucid-50k-flex-no-dll', name: '50K Flex, no DLL' }),
        T({ id: 'lucid-150k-daily-dll', name: '150K, daily DLL', account_type: 'funded', account_size: 150000, daily_loss: 3000, drawdown: 4500, lock_at: 150100, profit_target: 9000, consistency_pct: null, status: 'checked', checked_at: '2026-10-16T13:00:00Z', version: 2 })],
      accounts: [{ account: 'SIM-A', firm: 'Lucid', archived: false, account_type: 'lucid-50k-flex-no-dll' }, { account: 'SIM-B', firm: 'Lucid', archived: false, account_type: 'lucid-150k-daily-dll' },
        { account: 'Sim101', firm: null, archived: false, account_type: 'lucid-150k-daily-dll' }] });
    const tb = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(TP), '--v3', '--trading', '--test-controls', '--board-groups', '--test-pin=' + TEST_PIN, '--desk-url=http://127.0.0.1:' + DP], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise(r => tb.stdout.once('data', r));
    const received = async () => (await fetch(`http://127.0.0.1:${TP}/test/received`, { method: 'POST' })).json();
    const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await new Promise(r => setTimeout(r, 100)); } };
    try {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      await ctx.addInitScript(() => { try { if (!localStorage.getItem('live-workspace-v1')) localStorage.setItem('live-workspace-v1', JSON.stringify({ v: 1, layouts: { Types: { panels: [{ id: 'ap', type: 'accounts', x: 0, y: 0, w: 12, h: 6 }] } } })); } catch (e) { /* blocked */ } });
      const p = await ctx.newPage();
      p.on('pageerror', e => fail('pageerror: ' + e.message));
      const open = async () => {
        await p.goto(`http://localhost:${TP}/live/?layout=Types`);
        await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
        await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
      };
      await open();
      const AP = '.ws-panel[data-id="ap"]';
      /* the Accounts tab: each account's Account type, "Not set" then every type, "(not checked)" until checked */
      await until(async () => (await p.$$(`${AP} select.apg-tsel`)).length >= 4, 'the Account type dropdowns');
      const dd = await p.$eval(`${AP} select.apg-tsel[data-id="SIM-A"]`, e => ({ v: e.value, opts: [...e.options].map(o => o.textContent), dis: e.disabled }));
      check(dd.v === 'lucid-50k-flex-no-dll' && dd.opts.join(' | ') === 'Not set | Lucid 150K, daily DLL | Lucid 50K Flex, no DLL (not checked)' && !dd.dis,
        'Accounts tab: SIM-A shows its type from The Desk; Not set then every type, "(not checked)" on the one not checked: ' + JSON.stringify(dd));
      check((await p.$$eval(`${AP} .apg-acc-g .gr-h [role="columnheader"]`, els => els.map(e => e.textContent))).includes('Account type'), 'the Account type column');
      /* choosing one calls PUT /api/accounts/{account}/account-type, then shows what The Desk says */
      await p.selectOption(`${AP} select.apg-tsel[data-id="SIM-C"]`, 'lucid-50k-flex-no-dll');
      await until(async () => (await p.$eval(`${AP} select.apg-tsel[data-id="SIM-C"]`, e => e.value)) === 'lucid-50k-flex-no-dll' && desk.accounts.some(a => a.account === 'SIM-C' && a.account_type === 'lucid-50k-flex-no-dll'), 'SIM-C saved on The Desk');
      const put = desk.log.filter(x => x.method === 'PUT' && x.which === 'account-type');
      check(put.length === 1 && put[0].account === 'SIM-C' && JSON.stringify(put[0].body) === '{"account_type":"lucid-50k-flex-no-dll"}', 'one PUT with the spec\'s body: ' + JSON.stringify(put));
      /* Apply its rules: only for an account in no group, and it asks first */
      check(await p.$(`${AP} [data-act="apply-type"][data-id="SIM-A"]`) === null && await p.$(`${AP} [data-act="apply-type"][data-id="Sim101"]`) !== null, 'Apply its rules only on an account in no group (Sim101), not on SIM-A in Group A');
      await p.click(`${AP} [data-act="apply-type"][data-id="Sim101"]`);
      const ask = await until(() => p.$eval(`${AP} .apg-applyask`, e => e.textContent), 'the Apply its rules question');
      check(/Apply its rules from Lucid 150K, daily DLL to Sim101: My floor \$145,500 \(account size \$150,000 less the drawdown \$4,500\), My daily \$3,000/.test(ask || ''), 'it asks first, with the numbers: ' + ask);
      check(!(await received()).types.accountLimits, 'nothing sent before the answer (never applied silently)');
      await p.screenshot({ path: path.join(out, 'settings-types-accounts-tab.png') });
      await p.click(`${AP} [data-act="apply-yes"][data-id="Sim101"]`);
      await until(async () => (await p.$eval(`${AP} input[data-act="my-floor"][data-id="Sim101"]`, e => e.value)) === '145500' && (await p.$eval(`${AP} input[data-act="my-daily"][data-id="Sim101"]`, e => e.value)) === '3000', 'Sim101\'s My floor and My daily from its type');
      check((await received()).types.accountLimits === 1, 'one accountLimits sent (the existing message)');

      /* Settings, the rules dialog: the Account type select at the top fills every box and the Type; Save sends groupSave */
      await p.click('#wsSet');
      await until(async () => (await p.$$('#wsGroups .gp-row')).length === 2, 'the groups in Settings');
      await p.click('#wsGroups [data-gp="edit"][data-id="g1"]');
      await until(() => p.$('#wsDialog[open] #gp-fromType'), 'the rules dialog with Account type');
      const opts = await p.$$eval('#gp-fromType option', els => els.map(e => e.textContent));
      check(opts.join(' | ') === 'Not set | Lucid 150K, daily DLL | Lucid 50K Flex, no DLL (not checked)', 'the dialog lists every type, "(not checked)" beside the one not checked: ' + opts.join(' | '));
      await p.selectOption('#gp-fromType', 'lucid-50k-flex-no-dll');
      const filled = await p.evaluate(() => Object.fromEntries(['name', 'size', 'dailyLoss', 'drawdown', 'drawdownType', 'lockAt', 'target', 'consistency', 'accountType'].map(k => [k, document.getElementById('gp-' + k).value])));
      check(JSON.stringify(filled) === JSON.stringify({ name: 'Group A', size: '50000', dailyLoss: '', drawdown: '2000', drawdownType: 'eod', lockAt: '50100', target: '3000', consistency: '50', accountType: 'eval' }),
        'every rule box and the Type filled from the type; the name kept (Anthony names his groups): ' + JSON.stringify(filled));
      const why = await p.textContent('#gp-fromWhy');
      check(/Filled from Lucid 50K Flex, no DLL \(not checked\), version 1/.test(why), 'the line under it says where from, "(not checked)" included: ' + why);
      const dfit = await p.evaluate(() => (r => r.top >= 0 && r.bottom <= innerHeight)(document.getElementById('wsDialog').getBoundingClientRect()));
      check(dfit, 'the rules dialog with the Account type still fits 1366 x 768');
      await p.fill('#gp-target', '3500');   // Anthony can still edit any box
      await p.screenshot({ path: path.join(out, 'settings-group-type-filled.png') });
      const before = (await received()).types.groupSave || 0;
      await p.click('#wsDialog button[type="submit"]');
      await until(async () => ((await received()).types.groupSave || 0) === before + 1, 'groupSave sent');
      const link = await p.evaluate(() => JSON.parse(localStorage.getItem('live-group-types-v1') || '{}'));
      check(link.g1 && link.g1.id === 'lucid-50k-flex-no-dll' && link.g1.version === 1, 'the group remembers its type and version (this browser, keyed by group id): ' + JSON.stringify(link));
      /* the target typed by hand differs from the type: the row says so, with Update; nothing is blocked */
      await p.click('#wsSet');
      await until(async () => /Evals/.test(await p.$eval('#wsGroups .gp-row[data-id="g1"]', e => e.textContent)), 'Group A saved as Evals');
      const rowA = await until(async () => { const t = await p.$eval('#wsGroups .gp-row[data-id="g1"]', e => e.textContent); return /rules differ from/.test(t) ? t : null; }, 'the rules differ line');
      check(/from Lucid 50K Flex, no DLL \(not checked\)/.test(rowA || '') && /rules differ from Lucid 50K Flex, no DLL \(not checked\): Update/.test(rowA || ''), 'Group A: "rules differ from <type>: Update" after a box was changed by hand: ' + rowA);
      /* SIM-B (in Group A) is of another type: a warning in Settings and on the Accounts tab */
      check(/SIM-B is Lucid 150K, daily DLL: not the group's type/.test(rowA || ''), 'Settings: the member of another type is named (a warning only)');
      await p.screenshot({ path: path.join(out, 'settings-types-differ.png') });
      /* Update: one click refills and asks Save */
      await p.click('#wsGroups [data-gp="update"][data-id="g1"]');
      await until(() => p.$('#wsDialog[open] #gp-fromType'), 'the dialog refilled');
      check(await p.inputValue('#gp-target') === '3000' && await p.evaluate(() => document.activeElement && document.activeElement.type === 'submit'), 'Update refills the boxes from the type and puts Save in focus');
      await p.click('#wsDialog button[type="submit"]');
      await p.click('#wsSet');
      await until(async () => !/rules differ/.test(await p.$eval('#wsGroups .gp-row[data-id="g1"]', e => e.textContent)), 'no differ line once saved from the type');
      await p.keyboard.press('Escape');
      const warn = await until(() => p.$eval(`${AP} .apg-twarn`, e => e.textContent), 'the Accounts tab warning for SIM-B');
      check(/SIM-B is Lucid 150K, daily DLL; its group Group A was filled from Lucid 50K Flex, no DLL\. A warning only: nothing is blocked\./.test(warn || ''), 'Accounts tab: SIM-B\'s warning row: ' + warn);
      check(await p.$eval(`${AP} select.apg-tsel[data-id="SIM-B"]`, e => e.classList.contains('apg-toff') && !e.disabled), 'SIM-B\'s dropdown marked, still usable');
      /* The Desk edits the type (version 2): after a reload the page reads it and the group differs from the current version */
      desk.editType('lucid-50k-flex-no-dll', { drawdown: 2500 });
      await open();
      await p.click('#wsSet');
      const rowB = await until(async () => { const t = await p.$eval('#wsGroups .gp-row[data-id="g1"]', e => e.textContent); return /rules differ from/.test(t) ? t : null; }, 'the differ line after the type changed on The Desk');
      check(!!rowB, 'a new version of the type on The Desk: "rules differ" on Group A');
      await p.keyboard.press('Escape');
      /* The Desk not reachable: the last good list from this browser, "as of" its time; the dropdowns read only */
      desk.down = true;
      await open();
      await until(async () => (await p.$$(`${AP} select.apg-tsel`)).length >= 4, 'the Account type dropdowns from the copy');
      const foot = await until(async () => { const t = await p.$eval(`${AP} .apg-foot`, e => e.textContent); return /as of/.test(t) ? t : null; }, 'the as-of note', 15000);
      check(/Account types: The Desk is not reachable; the list as of [A-Z][a-z]{2} \d{1,2} \d\d:\d\d ET\./.test(foot || ''), 'The Desk down: the cached list "as of <time>": ' + foot);
      check(await p.$eval(`${AP} select.apg-tsel[data-id="SIM-A"]`, e => e.disabled && e.options.length === 3), 'the cached list still offered, read only while The Desk is down');
      await p.click('#wsSet');
      await p.click('#wsGroups [data-gp="edit"][data-id="g2"]');
      await until(() => p.$('#wsDialog[open] #gp-fromType'), 'the dialog with The Desk down');
      const why2 = await p.textContent('#gp-fromWhy'), n2 = await p.$$eval('#gp-fromType option', els => els.length);
      check(n2 === 3 && /The Desk is not reachable: the list as of/.test(why2), 'the dialog still fills from the copy, and says as of when: ' + why2);
      await p.click('#wsDialog [data-act="cancel"]');
      await ctx.close();

      // 8. 1.30.0: the Settings cleanup: every section collapsible, remembered, Collapse all / Expand all, the order, and the
      //    1366 x 768 no-scroll rule in the fullest Settings (v3, The Desk, groups): every section open (the default), some
      //    closed, all closed
      desk.down = false;
      const ctx8 = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      const q = await ctx8.newPage();
      q.on('pageerror', e => fail('pageerror: ' + e.message));
      const open8 = async () => {
        await q.goto(`http://localhost:${TP}/live/?layout=Main`);
        await q.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(q, TEST_PIN);
        await q.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 });
        await q.click('#wsSet');
        await until(async () => !(await q.$eval('#wsGroupsCol', e => e.hidden)) && !(await q.$eval('#wsDeskSec', e => e.hidden)), 'Settings with The Desk and the groups');
        await q.waitForTimeout(300);
      };
      const secs = () => q.$$eval('#wsSettings .ws-sec[data-sec]', els => els.map(e => ({ id: e.dataset.sec, open: e.querySelector('.ws-sec-hd').getAttribute('aria-expanded') === 'true', body: !e.querySelector('.ws-sec-body').hidden,
        shown: !e.hidden && !e.closest('[hidden]'), col: [...e.closest('.ws-cols').children].indexOf(e.closest('.ws-col')) })));
      const fits = () => q.evaluate(() => { const s = document.getElementById('wsSettings'), r = s.getBoundingClientRect(); return { ok: s.scrollHeight <= s.clientHeight + 1 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth, bottom: Math.round(r.bottom), sh: s.scrollHeight, ch: s.clientHeight }; });
      await open8();
      let ss = await secs();
      check(ss.map(x => x.id + '@' + x.col).join(' ') === 'charts@0 hotkeys@0 strategies@1 entry@1 prints@1 desk@1 pin@1 layout@1 groups@2', 'the order: Charts, Hotkeys | Order Strategies, Entry types, Large prints, The Desk, PIN, Layout | Account groups: ' + ss.map(x => x.id + '@' + x.col).join(' '));
      check(ss.every(x => x.open && x.body), 'the default: every section open, as before: ' + JSON.stringify(ss.map(x => [x.id, x.open])));
      let f = await fits();
      check(f.ok, 'Settings at 1366 x 768 with every section open: no scroll, nothing off screen: ' + JSON.stringify(f));
      check(await q.textContent('#wsSecAll') === 'Collapse all', 'Collapse all at the top while sections are open');
      await q.screenshot({ path: path.join(out, 'settings-sections-open-default-1366.png') });
      /* a header row closes its section and opens it again; remembered across a reload; Settings placed again, still whole */
      await q.click('#wsSettings .ws-sec[data-sec="charts"] .ws-sec-hd');
      await q.click('#wsSettings .ws-sec[data-sec="desk"] .ws-sec-hd');
      ss = await secs();
      check(!ss.find(x => x.id === 'charts').open && !ss.find(x => x.id === 'charts').body && await q.isHidden('#wsGlide') && await q.isHidden('#wsDeskTry'), 'a click on a header row closes its section (Charts, The Desk)');
      f = await fits();
      check(f.ok, 'two sections closed: placed again, fits: ' + JSON.stringify(f));
      await q.click('#wsSettings .ws-sec[data-sec="desk"] .ws-sec-hd');
      check((await secs()).find(x => x.id === 'desk').open && await q.isVisible('#wsDeskTry'), 'and opens it again');
      check(JSON.parse(await q.evaluate(() => localStorage.getItem('live-settings-sections-v1'))).charts === false, 'kept in this browser (live-settings-sections-v1)');
      await open8();
      ss = await secs();
      check(!ss.find(x => x.id === 'charts').open && ss.find(x => x.id === 'desk').open && ss.find(x => x.id === 'hotkeys').open, 'after a reload: Charts still closed, the others open');
      await q.screenshot({ path: path.join(out, 'settings-sections-charts-closed-1366.png') });
      /* Collapse all, then Expand all */
      await q.click('#wsSecAll');
      ss = await secs();
      check(ss.every(x => !x.open && !x.body) && await q.textContent('#wsSecAll') === 'Expand all', 'Collapse all closes every section; the button says Expand all');
      f = await fits();
      check(f.ok, 'every section closed: fits: ' + JSON.stringify(f));
      await q.screenshot({ path: path.join(out, 'settings-sections-closed-1366.png') });
      await q.click('#wsSecAll');
      ss = await secs();
      check(ss.every(x => x.open && x.body) && await q.textContent('#wsSecAll') === 'Collapse all', 'Expand all opens every section');
      f = await fits();
      check(f.ok, 'every section open again: placed again, no scroll, nothing cut: ' + JSON.stringify(f));
      await q.screenshot({ path: path.join(out, 'settings-sections-open-1366.png') });
      /* the hotkey boxes and the groups still work inside their sections */
      check(await q.isVisible('#wsGroups [data-gp="edit"][data-id="g1"]') && await q.isVisible('#wsPin') && await q.isVisible('#wsFloors input'), 'the controls inside the sections show again (Edit, Change PIN, the floors)');
      await ctx8.close();
    } finally { tb.kill(); await desk.close(); }
  }
} finally {
  await browser.close();
  bridge.kill();
}
if (errors.length) { console.error('FAIL\n' + errors.join('\n')); process.exit(1); }
console.log('settings smoke: ok');
