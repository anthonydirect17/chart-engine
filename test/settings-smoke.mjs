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
import { startDesk, sampleFirmTypes } from './fake-desk.mjs';
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
      /* 1.32.0: a few firms and plans, named as The Desk names them ("<Plan> <Size>K <rest>"); made-up values */
      types: [T({ id: 'lucid-50k-flex-no-dll', name: 'LucidFlex 50K Eval' }),
        T({ id: 'lucid-150k-daily-dll', name: 'LucidPro 150K Funded', account_type: 'funded', account_size: 150000, daily_loss: 3000, drawdown: 4500, lock_at: 150100, profit_target: 9000, consistency_pct: null, status: 'checked', checked_at: '2026-10-16T13:00:00Z', version: 2 }),
        T({ id: 'lucid-25k-static-sample', name: 'LucidFlex 25K Static Eval', account_type: 'eval', account_size: 25000, daily_loss: null, drawdown: 1500, drawdown_type: 'static', lock_at: null, profit_target: 1500, consistency_pct: null }),
        ...sampleFirmTypes().map(T)],
      accounts: [{ account: 'SIM-A', firm: 'Lucid', archived: false, account_type: 'lucid-50k-flex-no-dll' }, { account: 'SIM-B', firm: 'Lucid', archived: false, account_type: 'lucid-150k-daily-dll' },
        { account: 'Sim101', firm: null, archived: false, account_type: 'lucid-150k-daily-dll' }, { account: 'SIM-F1', firm: 'Lucid', archived: false, account_type: 'lucid-25k-static-sample' },
        { account: 'SIM-T', firm: 'Topstep', archived: false, account_type: 'sample-topstep-tc-50k' },   // 1.32.0: a Desk row of a Topstep type: Topstep is a firm in use
        { account: 'SIM-D', firm: 'FundedNext', archived: false, account_type: null }] });   // 1.32.0: a row's firm with no type set: FundedNext is in use too
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
      /* the Accounts tab (1.32.0, Anthony 2026-10-19, "Text + Change"): each account's type as text with Change, or "Not set" with
         Set; the picker (Firm, Plan, Size) opens in a row under the account, one row at a time */
      await until(async () => (await p.$$(`${AP} .apg-ttext`)).length >= 4, 'the Account type cells');
      const cellOf = id => p.evaluate(([ap, id]) => { const r = document.querySelector(`${ap} .gr-row[data-k="${id}"] .apg-type`); if (!r) return null;
        const t = r.querySelector('.apg-ttext'), b = r.querySelector('[data-act="type-edit"]');
        return { text: t.textContent, tip: t.title, full: t.scrollWidth <= t.clientWidth + 1, off: t.classList.contains('apg-toff'), btn: b ? b.textContent : null }; }, [AP, id]);
      const pickOf = id => p.evaluate(([ap, id]) => Object.fromEntries(['acct-firm', 'acct-plan', 'acct-type'].map(k => { const e = document.querySelector(`${ap} .apg-typeask select[data-act="${k}"][data-id="${id}"]`);
        return [k, e ? { v: e.value, opts: [...e.options].map(o => o.textContent), dis: e.disabled } : null]; })), [AP, id]);
      const rowsOpen = () => p.$$eval(`${AP} .apg-typeask`, els => els.map(e => e.querySelector('select').dataset.id));
      const putsNow = () => desk.log.filter(x => x.method === 'PUT' && x.which === 'account-type').length;
      const ca = await cellOf('SIM-A');
      check(ca && ca.text === 'LucidFlex 50K Eval' && ca.btn === 'Change' && ca.tip.startsWith('Lucid LucidFlex 50K Eval (not checked). The account'), 'Accounts tab: SIM-A\'s type as text, the firm and "(not checked)" in the tooltip, Change: ' + JSON.stringify(ca));
      const cc = await cellOf('SIM-C');
      check(cc && cc.text === 'Not set' && cc.btn === 'Set', 'SIM-C with no type: "Not set" and Set: ' + JSON.stringify(cc));
      check((await p.$$(`${AP} select.apg-tpick`)).length === 0 && (await rowsOpen()).length === 0, 'no select in the table until Change or Set');
      const fitT = await p.evaluate(sel => [...document.querySelectorAll(sel)].every(c => c.scrollWidth <= c.clientWidth + 1 && [...c.querySelectorAll('button')].every(x => x.getBoundingClientRect().right <= c.getBoundingClientRect().right + 0.5 && x.getBoundingClientRect().width >= x.scrollWidth)), `${AP} .apg-type`);
      check(fitT, 'the text, Change (or Set) and Apply fit the Account type cell at 1366 x 768 (the text cut at the end where it is long, whole in the tooltip)');
      const fullRows = await p.$$eval(`${AP} .apg-acc .apg-ttext`, els => els.map(e => e.closest('.gr-row').dataset.k + (e.scrollWidth <= e.clientWidth + 1 ? ' full' : ' cut') + ' "' + e.textContent + '"'));
      console.log('  info: Account type text at 1366: ' + fullRows.join('; '));
      check((await p.$$eval(`${AP} .apg-acc-g .gr-h [role="columnheader"]`, els => els.map(e => e.textContent))).includes('Account type'), 'the Account type column');
      /* the widths of 1.30.0 again: the column 128 px, and the Room no narrower than without the column (1.29) */
      const roomW = await p.evaluate(sel => { const g = document.querySelector(sel), h = n => Math.round(g.querySelector(`.gr-h [role="columnheader"]:nth-child(${n})`).getBoundingClientRect().width);
        const w = h(6), tw = h(8); g.classList.remove('apg-types'); const w0 = h(6); g.classList.add('apg-types'); return { w, w0, tw }; }, `${AP} .apg-acc-g`);
      check(roomW.w >= roomW.w0 && roomW.tw === 128, 'the Account type column at 128 px as in 1.30.0, the Room no narrower than without it: ' + JSON.stringify(roomW));
      await p.screenshot({ path: path.join(out, 'settings-types-text-1366.png') });
      /* Set on SIM-C: the row, Firm first (the firms in use first: FundedNext from its Desk row's firm, Lucid, Topstep; then A to Z) */
      await p.click(`${AP} [data-act="type-edit"][data-id="SIM-C"]`);
      const c0 = await until(async () => { const x = await pickOf('SIM-C'); return x['acct-firm'] ? x : null; }, 'SIM-C\'s Change row');
      check(c0 && c0['acct-firm'].v === '' && c0['acct-firm'].opts.join(' | ') === 'Firm | FundedNext | Lucid | Topstep | Bulenox' && c0['acct-plan'].dis && c0['acct-type'].dis,
        'Set: Firm (the firms in use first, a Desk row\'s firm counted), Plan and Size wait: ' + JSON.stringify(c0));
      check(await p.$(`${AP} [data-act="type-clear"][data-id="SIM-C"]`) === null && await p.$(`${AP} [data-act="type-cancel"][data-id="SIM-C"]`) !== null, 'no Not set in the row when no type is set; Cancel');
      check(await p.evaluate(ap => document.activeElement && document.activeElement.matches(`${ap} select[data-act="acct-firm"][data-id="SIM-C"]`), AP), 'the Firm select has the focus');
      await p.selectOption(`${AP} select[data-act="acct-firm"][data-id="SIM-C"]`, 'Topstep');
      const c1 = await until(async () => { const x = await pickOf('SIM-C'); return x['acct-plan'] && !x['acct-plan'].dis ? x : null; }, 'SIM-C\'s plans of Topstep');
      check(c1 && c1['acct-firm'].opts.join(' | ') === 'FundedNext | Lucid | Topstep | Bulenox' && c1['acct-plan'].opts.join(' | ') === 'Plan | Express Funded | Trading Combine' && c1['acct-type'].dis, 'Firm Topstep: its plans A to Z, Size still waits: ' + JSON.stringify(c1 && c1['acct-plan']));
      check(await p.evaluate(ap => document.activeElement && document.activeElement.matches(`${ap} select[data-act="acct-plan"][data-id="SIM-C"]`), AP), 'the Plan select has the focus after Firm');
      await p.selectOption(`${AP} select[data-act="acct-plan"][data-id="SIM-C"]`, 'Trading Combine');
      const c2 = await until(async () => { const x = await pickOf('SIM-C'); return x['acct-type'] && !x['acct-type'].dis ? x : null; }, 'SIM-C\'s sizes of Trading Combine');
      check(c2 && c2['acct-type'].opts.join(' | ') === 'Size | 50K (not checked) | 100K (not checked)', 'Plan Trading Combine: its sizes by size number: ' + JSON.stringify(c2 && c2['acct-type']));
      const rowFit = await p.$eval(`${AP} .apg-typeask`, c => { const r = c.getBoundingClientRect(); return c.scrollWidth <= c.clientWidth + 1 && [...c.querySelectorAll('select')].every(s => { const ctx = document.createElement('canvas').getContext('2d'); ctx.font = getComputedStyle(s).font; return s.getBoundingClientRect().right <= r.right && [...s.options].every(o => ctx.measureText(o.textContent).width <= s.clientWidth); }); });
      check(rowFit, 'the row\'s selects at full width: every label whole, inside the row at 1366 x 768');
      await p.waitForTimeout(300);
      check(putsNow() === 0, 'choosing Firm and Plan sent nothing to The Desk');
      await p.screenshot({ path: path.join(out, 'settings-types-change-row-1366.png') });
      /* one row at a time: Change on SIM-A closes SIM-C's; its own type shown, and Not set offered (a type is set) */
      await p.click(`${AP} [data-act="type-edit"][data-id="SIM-A"]`);
      const a0 = await until(async () => { const x = await pickOf('SIM-A'); return x['acct-type'] ? x : null; }, 'SIM-A\'s Change row');
      check(JSON.stringify(await rowsOpen()) === '["SIM-A"]' && putsNow() === 0, 'one open row at a time (SIM-C\'s closed, nothing sent): ' + JSON.stringify(await rowsOpen()));
      check(a0 && a0['acct-firm'].v === 'Lucid' && a0['acct-plan'].v === 'LucidFlex' && a0['acct-plan'].opts.join(' | ') === 'LucidFlex | LucidPro' && a0['acct-type'].v === 'lucid-50k-flex-no-dll' &&
        a0['acct-type'].opts.join(' | ') === '25K Static Eval (not checked) | 50K Eval (not checked)', 'Change opens on its own firm, plan and type: ' + JSON.stringify(a0));
      check(await p.$(`${AP} [data-act="type-clear"][data-id="SIM-A"]`) !== null, 'Not set offered in the row when a type is set');
      /* Bulenox: Master, and Other for a name with no size; within a size Eval words first, Funded words last; nothing sent */
      await p.selectOption(`${AP} select[data-act="acct-firm"][data-id="SIM-A"]`, 'Bulenox');
      const a1 = await until(async () => { const x = await pickOf('SIM-A'); return x['acct-firm'] && x['acct-firm'].v === 'Bulenox' ? x : null; }, 'SIM-A on Bulenox');
      check(a1 && a1['acct-plan'].opts.join(' | ') === 'Plan | Master | Other' && putsNow() === 0, 'Bulenox: Master, and Other for a name with no size; nothing sent: ' + JSON.stringify(a1 && a1['acct-plan']));
      await p.selectOption(`${AP} select[data-act="acct-plan"][data-id="SIM-A"]`, 'Master');
      const a2 = await until(async () => { const x = await pickOf('SIM-A'); return x['acct-type'] && !x['acct-type'].dis ? x : null; }, 'SIM-A Master sizes');
      check(a2 && a2['acct-type'].opts.join(' | ') === 'Size | 25K Option 2 EOD (not checked) | 25K Funded (not checked)', 'within a size: Eval words first, Funded words last, the rest between: ' + JSON.stringify(a2 && a2['acct-type']));
      await p.selectOption(`${AP} select[data-act="acct-firm"][data-id="SIM-A"]`, 'Lucid');
      const a3 = await until(async () => { const x = await pickOf('SIM-A'); return x['acct-type'] && x['acct-type'].v === 'lucid-50k-flex-no-dll' ? x : null; }, 'SIM-A back on its own type');
      check(!!a3 && a3['acct-plan'].v === 'LucidFlex' && putsNow() === 0, 'back to its own firm: its plan and type again, nothing sent');
      /* Cancel: the row closes, nothing sent, the text as it was */
      await p.click(`${AP} [data-act="type-cancel"][data-id="SIM-A"]`);
      await until(async () => (await rowsOpen()).length === 0, 'SIM-A\'s row closed by Cancel');
      await p.waitForTimeout(300);
      check(putsNow() === 0 && (await cellOf('SIM-A')).text === 'LucidFlex 50K Eval', 'Cancel: nothing sent, the type as it was');
      /* a firm with one plan: the plan is taken at once, nothing sent */
      await p.click(`${AP} [data-act="type-edit"][data-id="SIM-C"]`);
      await until(async () => (await pickOf('SIM-C'))['acct-firm'], 'SIM-C\'s row again');
      await p.selectOption(`${AP} select[data-act="acct-firm"][data-id="SIM-C"]`, 'FundedNext');
      const c3 = await until(async () => { const x = await pickOf('SIM-C'); return x['acct-plan'] && x['acct-plan'].v === 'Direct' ? x : null; }, 'FundedNext\'s one plan');
      check(c3 && c3['acct-type'].opts.join(' | ') === 'Size | 50K Account (not checked)' && putsNow() === 0, 'a firm with one plan: Plan taken, nothing sent: ' + JSON.stringify(c3 && c3['acct-type']));
      /* the last select sends PUT /api/accounts/{account}/account-type and closes the row; the text shows the pick from the click until
         The Desk's rows say it: sampled every 15 ms, never the old text in between */
      await p.selectOption(`${AP} select[data-act="acct-firm"][data-id="SIM-C"]`, 'Lucid');
      await until(async () => (await pickOf('SIM-C'))['acct-plan'].opts.includes('LucidFlex'), 'SIM-C on Lucid');
      await p.selectOption(`${AP} select[data-act="acct-plan"][data-id="SIM-C"]`, 'LucidFlex');
      await until(async () => !(await pickOf('SIM-C'))['acct-type'].dis, 'SIM-C LucidFlex sizes');
      check(putsNow() === 0, 'still nothing sent before the size');
      await p.evaluate(sel => { window.__seen = []; window.__sampler = setInterval(() => { const x = document.querySelector(sel); window.__seen.push(x ? x.textContent : '?'); }, 15); }, `${AP} .gr-row[data-k="SIM-C"] .apg-ttext`);
      await p.selectOption(`${AP} select[data-act="acct-type"][data-id="SIM-C"]`, 'lucid-50k-flex-no-dll');
      await until(async () => (await cellOf('SIM-C')).text === 'LucidFlex 50K Eval' && desk.accounts.some(a => a.account === 'SIM-C' && a.account_type === 'lucid-50k-flex-no-dll'), 'SIM-C saved on The Desk');
      check((await rowsOpen()).length === 0, 'the last select closes the row');
      await p.waitForTimeout(800);   // past the next read of The Desk's rows
      const seen = await p.evaluate(() => { clearInterval(window.__sampler); return window.__seen; });
      const firstNew = seen.indexOf('LucidFlex 50K Eval');
      check(firstNew >= 0 && seen.slice(firstNew).every(v => v === 'LucidFlex 50K Eval'), 'the picked type stays shown until The Desk\'s rows are read again (no flash of the old value; ' + seen.length + ' samples)');
      const put = desk.log.filter(x => x.method === 'PUT' && x.which === 'account-type');
      check(put.length === 1 && put[0].account === 'SIM-C' && JSON.stringify(put[0].body) === '{"account_type":"lucid-50k-flex-no-dll"}', 'one PUT with the spec\'s body: ' + JSON.stringify(put));
      check((await cellOf('SIM-C')).btn === 'Change', 'SIM-C now offers Change');
      /* Not set (in the row) sends null and closes the row */
      await p.click(`${AP} [data-act="type-edit"][data-id="SIM-C"]`);
      await until(() => p.$(`${AP} [data-act="type-clear"][data-id="SIM-C"]`), 'SIM-C\'s row with Not set');
      await p.click(`${AP} [data-act="type-clear"][data-id="SIM-C"]`);
      await until(() => desk.accounts.some(a => a.account === 'SIM-C' && a.account_type === null), 'SIM-C Not set on The Desk');
      const put2 = desk.log.filter(x => x.method === 'PUT' && x.which === 'account-type');
      check(put2.length === 2 && JSON.stringify(put2[1].body) === '{"account_type":null}', 'Not set: one PUT with null: ' + JSON.stringify(put2.slice(1)));
      await until(async () => { const x = await cellOf('SIM-C'); return x.text === 'Not set' && x.btn === 'Set' && (await rowsOpen()).length === 0; }, 'SIM-C shown Not set, the row closed');
      /* Apply its rules: only for an account in no group, and it asks first */
      check(await p.$(`${AP} [data-act="apply-type"][data-id="SIM-A"]`) === null && await p.$(`${AP} [data-act="apply-type"][data-id="Sim101"]`) !== null, 'Apply its rules only on an account in no group (Sim101), not on SIM-A in Group A');
      /* a trailing type (Sim101: 150K, end of day): My floor is never set from it (ChartBridge trails a floor only in a group); the
         account's own My floor is sent again unchanged; My daily from the type */
      const askText = () => p.$eval(`${AP} .apg-applyask`, e => e.textContent.replace(/\s+/g, ' '));
      await p.fill(`${AP} input[data-act="my-floor"][data-id="Sim101"]`, '96000'); await p.press(`${AP} input[data-act="my-floor"][data-id="Sim101"]`, 'Enter'); await p.click(`${AP} .apg-foot`);
      await until(async () => (await received()).types.accountLimits === 1, 'My floor 96,000 typed by hand');
      await p.click(`${AP} [data-act="apply-type"][data-id="Sim101"]`);
      const ask = await until(askText, 'the Apply its rules question');
      check(/Apply its rules from Lucid LucidPro 150K Funded to Sim101: My floor stays as it is \(\$96,000\)\. A trailing floor is tracked only in a group: put this account in a group \(a one-account group is fine\) so ChartBridge trails it from its highest close\. My daily \$3,000 \(its daily loss limit\)\./.test(ask || ''), 'trailing: the question says My floor stays and why: ' + ask);
      check(await p.$(`${AP} [data-act="apply-high"]`) === null, 'no highest-close box in Apply');
      check((await received()).types.accountLimits === 1, 'nothing sent before the answer (never applied silently)');
      await p.screenshot({ path: path.join(out, 'settings-types-accounts-tab.png') });
      await p.click(`${AP} [data-act="apply-yes"][data-id="Sim101"]`);
      await until(async () => (await p.$eval(`${AP} input[data-act="my-daily"][data-id="Sim101"]`, e => e.value)) === '3000', 'Sim101\'s My daily from its type');
      check((await received()).types.accountLimits === 2 && await p.$eval(`${AP} input[data-act="my-floor"][data-id="Sim101"]`, e => e.value) === '96000', 'one accountLimits sent; a trailing type never changes My floor (96,000 as it was)');
      /* a static type (SIM-F1: 25K static, drawdown 1,500): account size less the drawdown; My daily none, saying what it replaces */
      await p.fill(`${AP} input[data-act="my-daily"][data-id="SIM-F1"]`, '400'); await p.press(`${AP} input[data-act="my-daily"][data-id="SIM-F1"]`, 'Enter'); await p.click(`${AP} .apg-foot`);
      await until(async () => (await received()).types.accountLimits === 3, 'SIM-F1 My daily 400 by hand');
      await until(async () => /to floor|daily/.test(await p.$eval(`${AP} .gr-row[data-k="SIM-F1"] .apg-room`, e => e.textContent)), 'SIM-F1\'s own limits back from ChartBridge');
      await p.click(`${AP} [data-act="apply-type"][data-id="SIM-F1"]`);
      const t4 = await until(askText, 'the static question');
      check(/to SIM-F1: My floor \$23,500 \(a static drawdown: account size \$25,000 less the drawdown \$1,500\), My daily none \(it has no daily loss limit; it replaces your \$400\)\./.test(t4 || ''), 'static: size less the drawdown; My daily none says what it replaces: ' + t4);
      await p.click(`${AP} [data-act="apply-yes"][data-id="SIM-F1"]`);
      await until(async () => (await p.$eval(`${AP} input[data-act="my-floor"][data-id="SIM-F1"]`, e => e.value)) === '23500', 'SIM-F1\'s My floor from its static type');
      /* the join question for an intraday group (Group B) asks the highest balance so far (intraday) */
      await p.selectOption(`${AP} select.apg-grp[data-id="SIM-F2"]`, 'g2');
      const jq = await until(() => p.$eval(`${AP} .apg-join`, e => e.textContent.replace(/\s+/g, ' ')), 'the join question');
      check(/Put SIM-F2 in Group B: highest balance so far \(intraday\)/.test(jq || ''), 'an intraday group asks the highest balance so far (intraday): ' + jq);
      await p.click(`${AP} [data-act="join-no"]`);
      await p.selectOption(`${AP} select.apg-grp[data-id="SIM-F2"]`, 'g1');
      check(/Put SIM-F2 in Group A: highest close so far /.test(await until(() => p.$eval(`${AP} .apg-join`, e => e.textContent.replace(/\s+/g, ' ')), 'the eod join question') || ''), 'an end-of-day group asks the highest close so far, as before');
      await p.click(`${AP} [data-act="join-no"]`);

      /* Settings, the rules dialog: the Account type select at the top fills every box and the Type; Save sends groupSave */
      await p.click('#wsSet');
      await until(async () => (await p.$$('#wsGroups .gp-row')).length === 2, 'the groups in Settings');
      await p.click('#wsGroups [data-gp="edit"][data-id="g1"]');
      await until(() => p.$('#wsDialog[open] #gp-fromType'), 'the rules dialog with Account type');
      /* 1.32.0: Firm, Plan and Size, as on the Accounts tab; Firm and Plan fill nothing, the size fills */
      const optsOf = id => p.$$eval('#' + id + ' option', els => els.map(e => e.textContent).join(' | '));
      check(await optsOf('gp-fromFirm') === 'Not set | FundedNext | Lucid | Topstep | Bulenox' && await p.$eval('#gp-fromType', e => e.disabled), 'the dialog\'s Firm: Not set, the firms in use first; Size waits: ' + await optsOf('gp-fromFirm'));
      const target0 = await p.inputValue('#gp-target');
      await p.selectOption('#gp-fromFirm', 'Lucid');
      check(await optsOf('gp-fromPlan') === 'Plan | LucidFlex | LucidPro' && await p.inputValue('#gp-target') === target0, 'Firm Lucid: its plans, no box filled: ' + await optsOf('gp-fromPlan'));
      await p.selectOption('#gp-fromPlan', 'LucidFlex');
      check(await optsOf('gp-fromType') === 'Size | 25K Static Eval (not checked) | 50K Eval (not checked)' && await p.inputValue('#gp-target') === target0, 'Plan LucidFlex: its sizes, "(not checked)" on the last select, no box filled: ' + await optsOf('gp-fromType'));
      await p.selectOption('#gp-fromType', 'lucid-50k-flex-no-dll');
      const filled = await p.evaluate(() => Object.fromEntries(['name', 'size', 'dailyLoss', 'drawdown', 'drawdownType', 'lockAt', 'target', 'consistency', 'accountType'].map(k => [k, document.getElementById('gp-' + k).value])));
      check(JSON.stringify(filled) === JSON.stringify({ name: 'Group A', size: '50000', dailyLoss: '', drawdown: '2000', drawdownType: 'eod', lockAt: '50100', target: '3000', consistency: '50', accountType: 'eval' }),
        'every rule box and the Type filled from the type; the name kept (Anthony names his groups): ' + JSON.stringify(filled));
      const why = await p.textContent('#gp-fromWhy');
      check(/Filled from Lucid LucidFlex 50K Eval \(not checked\), version 1/.test(why), 'the line under it says where from, "(not checked)" included: ' + why);
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
      check(/from Lucid LucidFlex 50K Eval \(not checked\)/.test(rowA || '') && /rules differ from Lucid LucidFlex 50K Eval \(not checked\): Update/.test(rowA || ''), 'Group A: "rules differ from <type>: Update" after a box was changed by hand: ' + rowA);
      /* SIM-B (in Group A) is of another type: a warning in Settings and on the Accounts tab */
      check(/SIM-B is Lucid LucidPro 150K Funded: not the group's type/.test(rowA || ''), 'Settings: the member of another type is named (a warning only)');
      await p.screenshot({ path: path.join(out, 'settings-types-differ.png') });
      /* Update: one click refills and asks Save */
      await p.click('#wsGroups [data-gp="update"][data-id="g1"]');
      await until(() => p.$('#wsDialog[open] #gp-fromType'), 'the dialog refilled');
      check(await p.inputValue('#gp-target') === '3000' && await p.evaluate(() => document.activeElement && document.activeElement.type === 'submit'), 'Update refills the boxes from the type and puts Save in focus');
      check(await p.inputValue('#gp-fromFirm') === 'Lucid' && await p.inputValue('#gp-fromPlan') === 'LucidFlex' && await p.inputValue('#gp-fromType') === 'lucid-50k-flex-no-dll', 'the picker opens on the group\'s type');
      await p.click('#wsDialog button[type="submit"]');
      await p.click('#wsSet');
      await until(async () => !/rules differ/.test(await p.$eval('#wsGroups .gp-row[data-id="g1"]', e => e.textContent)), 'no differ line once saved from the type');
      await p.keyboard.press('Escape');
      const warn = await until(() => p.$eval(`${AP} .apg-twarn`, e => e.textContent), 'the Accounts tab warning for SIM-B');
      check(/SIM-B is Lucid LucidPro 150K Funded; its group Group A was filled from Lucid LucidFlex 50K Eval\. A warning only: nothing is blocked\./.test(warn || ''), 'Accounts tab: SIM-B\'s warning row: ' + warn);
      const cb = await cellOf('SIM-B');
      check(cb && cb.off && cb.btn === 'Change', 'SIM-B\'s type marked, Change still offered: ' + JSON.stringify(cb));
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
      await until(async () => (await p.$$(`${AP} .apg-ttext`)).length >= 4, 'the Account type cells from the copy');
      const foot = await until(async () => { const t = await p.$eval(`${AP} .apg-foot`, e => e.textContent); return /as of/.test(t) ? t : null; }, 'the as-of note', 15000);
      check(/Account types: The Desk is not reachable; the list as of [A-Z][a-z]{2} \d{1,2} \d\d:\d\d ET\./.test(foot || ''), 'The Desk down: the cached list "as of <time>": ' + foot);
      const cd = await cellOf('SIM-A');
      check(cd && /The Desk is not reachable: the list as of/.test(cd.tip) && (await p.$$(`${AP} [data-act="type-edit"]`)).length === 0 && (await p.$$(`${AP} .apg-typeask`)).length === 0, 'read only (no Change or Set, no row) while The Desk is down, as before: ' + JSON.stringify(cd));
      await p.click('#wsSet');
      await p.click('#wsGroups [data-gp="edit"][data-id="g2"]');
      await until(() => p.$('#wsDialog[open] #gp-fromType'), 'the dialog with The Desk down');
      const why2 = await p.textContent('#gp-fromWhy'), n2 = await p.$$eval('#gp-fromFirm option', els => els.length);
      check(n2 === 5 && /The Desk is not reachable: the list as of/.test(why2), 'the dialog still fills from the copy, and says as of when: ' + why2);
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
      /* fits: no scroll at all (scrollHeight equal to clientHeight), on screen, and under the gear (the top bar never covered) */
      const fits = () => q.evaluate(() => { const s = document.getElementById('wsSettings'), r = s.getBoundingClientRect(), g = document.getElementById('wsSet').getBoundingClientRect();
        return { ok: s.scrollHeight <= s.clientHeight && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && r.top >= g.bottom, top: Math.round(r.top), gear: Math.round(g.bottom), bottom: Math.round(r.bottom), sh: s.scrollHeight, ch: s.clientHeight }; });
      await open8();
      let ss = await secs();
      check(ss.map(x => x.id + '@' + x.col).join(' ') === 'charts@0 hotkeys@0 strategies@1 entry@1 prints@1 desk@1 pin@1 layout@1 groups@2', 'the order: Charts, Hotkeys | Order Strategies, Entry types, Large prints, The Desk, PIN, Layout | Account groups: ' + ss.map(x => x.id + '@' + x.col).join(' '));
      check(ss.every(x => x.open && x.body), 'the default: every section open, as before: ' + JSON.stringify(ss.map(x => [x.id, x.open])));
      let f = await fits();
      check(f.ok, 'Settings at 1366 x 768 with every section open (the fullest case): under the gear, no scroll, nothing off screen: ' + JSON.stringify(f));
      check(await q.textContent('#wsSecAll') === 'Collapse all' && await q.$eval('#wsSecAll', e => !!e.closest('.ws-sec[data-sec="charts"] h2')), 'Collapse all in the first header row (no row of its own) while sections are open');
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
      check(f.ok, 'every section open again: placed again under the gear, no scroll, nothing cut: ' + JSON.stringify(f));
      /* any size change while open places it again (a ResizeObserver): 120 px more content moves it up; taken away, back under the gear */
      await q.evaluate(() => { const d = document.createElement('div'); d.id = 'smokeGrow'; d.style.height = '120px'; document.getElementById('wsSecBody-hotkeys').appendChild(d); });
      await q.waitForTimeout(250);
      const grown = await q.evaluate(() => { const r = document.getElementById('wsSettings').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), ih: innerHeight }; });
      check(grown.bottom <= grown.ih && grown.top < 36, 'grown while open: placed again, nothing off screen: ' + JSON.stringify(grown));
      await q.evaluate(() => document.getElementById('smokeGrow').remove());
      await q.waitForTimeout(250);
      f = await fits();
      check(f.ok, 'shrunk again: back under the gear: ' + JSON.stringify(f));
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
