// Chart 1.33.0 and ChartBridge 0.6.5 smoke (Anthony 2026-10-19, "Trade the group"): the order ticket picks a group, one entry
// with its bracket stop goes to every member, each sized by ChartBridge from the group's risk percent of its own max loss. Against
// the fake bridge (--mix-groups-full: a made-up Lucid group, risk 10%, SIM-A 150K, SIM-B 50K, SIM-C 25K intraday, SIM-D on the
// group's rules; sample data only), at 1366 x 768:
//   npm run smoke:group-ticket       (CHROMIUM_PATH=/path/to/chrome to use a preinstalled browser)
// Checks: the picker lists the group; no stop: refused before anything is sent; Buy asks ChartBridge (groupPreview); 1.34.0: the
// confirm only when an account sits out (each account's size, dollar risk and budget, and why one sits out); Enter never sends;
// Cancel sends nothing; with no issue the ticket shows the next entry's sizes and Buy sends groupOrder at once, and every member
// gets its own entry; Close flattens every member; Flatten all from another window flattens every member on every instrument.
// Screenshot test/out/group-ticket-confirm-1366.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.GROUP_TICKET_SMOKE_PORT || 8801);
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const errors = [];
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { if (!ok) fail(m); else console.log('  ok   ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, what, ms) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); } };
const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--mix-groups-full', '--max-qty=MNQ:9,NQ:9', '--trade-accounts=SIM-A,SIM-B,SIM-C,SIM-D', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => bridge.stdout.once('data', r));
const control = async (what, q) => (await fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const groupMsgs = async () => ((await control('received')).groupMsgs || []);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const tk = i => `[data-tk-id="${i}"]`;
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (['order', 'change', 'cancel', 'flatten', 'groupPreview', 'groupOrder'].includes(m.type)) window.__sent.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
  });
  const p = await ctx.newPage();
  p.on('pageerror', e => fail('pageerror: ' + e.message));
  await p.goto(`http://localhost:${PORT}/live/?layout=Main`);
  await p.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(p, TEST_PIN);
  await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 40000 });
  const sent = types => p.evaluate(t => window.__sent.filter(m => t.includes(m.type)), types);
  const clearSent = () => p.evaluate(() => { window.__sent.length = 0; });
  /* the picker: the group after the accounts */
  const opt = await until(() => p.$eval(tk('oAcct'), s => [...s.options].map(o => o.value + '=' + o.textContent).find(x => x.startsWith('group:'))), 'the group in the ticket\'s picker');
  check(opt === 'group:g1=Group Lucid (4)', 'the ticket\'s picker lists the group: ' + opt);
  await p.selectOption(tk('oAcct'), 'group:g1');
  await p.selectOption(tk('root'), 'NQ'); await wait(600);
  await p.fill(tk('bStop'), '0'); await p.press(tk('bStop'), 'Tab');
  await p.click(tk('armBtn')); await wait(400);
  await clearSent();
  await p.click(tk('buyMkt')); await wait(400);
  const note0 = await p.$eval(tk('note'), e => e.textContent).catch(() => '');
  check((await sent(['groupPreview', 'groupOrder', 'order'])).length === 0 && /a group entry needs a stop/.test(note0), 'no stop: nothing sent, the ticket says why: ' + note0);
  await p.fill(tk('bStop'), '20'); await p.press(tk('bStop'), 'Tab');
  /* 1.34.0 (Anthony 2026-10-20: "it should only appear with an issue"): a 30 tick stop leaves SIM-C out ($150 a contract
     against its $100), so the confirm shows, saying who sits out */
  await p.fill(tk('bStop'), '30'); await p.press(tk('bStop'), 'Tab');
  await p.fill(tk('bTarget'), '40'); await p.press(tk('bTarget'), 'Tab');
  if (!(await p.evaluate(() => window.workspace.ticket().armed))) { await p.click(tk('armBtn')); await wait(300); }
  await clearSent();
  await p.click(tk('buyMkt'));
  await until(() => p.$eval('#wsDialog', d => d.open && !!d.querySelector('.ws-gq')), 'the group entry\'s confirm (one sits out)');
  const rows = await p.$$eval('.ws-gq tbody tr', trs => trs.map(t => [...t.children].map(c => c.textContent).join(' | ')));
  check(rows.length === 4 && /^SIM-C \| - \| - \| \$100 \| sits out: /.test(rows[2]) && /^SIM-A \| \d+ NQ \| /.test(rows[0]),
    'an issue (SIM-C sits out): the confirm shows each account\'s size and dollar risk, and who sits out: ' + JSON.stringify(rows));
  const pv = (await sent(['groupPreview'])).find(m => m.bracket && m.bracket.stop === 30);
  check(pv && pv.group === 'g1' && pv.root === 'NQ' && pv.side === 'buy' && pv.kind === 'market' && (await sent(['groupOrder', 'order'])).length === 0, 'Buy asked ChartBridge for the sizes (groupPreview) and sent no order: ' + JSON.stringify(pv));
  const fit = await p.$eval('.ws-gq', f => { const r = f.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && f.scrollWidth <= f.clientWidth + 1; });
  check(fit, 'the confirm fits 1366 x 768');
  await p.screenshot({ path: path.join(out, 'group-ticket-confirm-1366.png') });
  await p.focus('#gqSend'); await p.keyboard.press('Enter'); await wait(400);
  check((await sent(['groupOrder'])).length === 0, 'Enter on Send sends nothing (a click only, as every order button)');
  await p.click('.ws-gq [data-act="cancel"]'); await wait(400);
  check((await sent(['groupOrder', 'order'])).length === 0 && !(await p.$eval('#wsDialog', d => d.open)), 'Cancel: the confirm closes, nothing sent');
  /* no issue (20 ticks: every account takes it): the projected sizes on the ticket, and Buy sends with no confirm */
  await p.fill(tk('bStop'), '20'); await p.press(tk('bStop'), 'Tab');
  const proj = await until(async () => { const t = await p.$eval(tk('oOther'), e => e.textContent); return /^Next entry: SIM-A 4, SIM-B 2, SIM-C 1, SIM-D 2 NQ · \$900 at risk$/.test(t) ? t : null; }, 'the projected sizes on the ticket');
  check(!!proj, 'the ticket shows the next entry\'s sizes, out of the way: ' + proj);
  await clearSent();
  await p.click(tk('buyMkt'));
  const go = await until(async () => (await sent(['groupOrder']))[0], 'groupOrder');
  check(go && go.sizes === 'SIM-A:4,SIM-B:2,SIM-C:1,SIM-D:2' && go.bracket.stop === 20 && go.bracket.target === 40 && !(await p.$eval('#wsDialog', d => d.open)), 'no issue: Buy sends groupOrder with the sizes, no confirm: ' + JSON.stringify(go));
  const pos = await until(async () => { const s = await control('state', { root: 'NQ' }); const q = ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'].map(a => ((s.positions || {})[a + '|NQ'] || {}).qty || 0); return q.every(x => x > 0) ? q : null; }, 'every member filled', 8000);
  const note1 = await p.$eval(tk('note'), e => e.textContent).catch(() => '');
  check(JSON.stringify(pos) === '[4,2,1,2]' || /placed SIM-A 4, SIM-B 2, SIM-C 1, SIM-D 2/.test(note1), 'every member got its own entry at its own size: ' + JSON.stringify(pos) + ' ' + note1);
  const tkInfo = await until(async () => { const x = await p.evaluate(() => { const q = document.querySelector('[data-tk-id="oQty"]'), c = document.querySelector('[data-tk-id="oQtyCap"]'), ps = document.querySelector('[data-tk-id="oPos"]'); return { qtyHidden: q.hidden, cap: c.textContent, pos: ps.textContent }; }); return /SIM-A \+4/.test(x.pos) ? x : null; }, 'the members\' positions on the ticket');
  check(tkInfo && tkInfo.qtyHidden && tkInfo.cap === 'risk 10% of each max loss' && tkInfo.pos === 'SIM-A +4 · SIM-B +2 · SIM-C +1 · SIM-D +2', 'review 7: on a group the ticket shows the risk in place of QTY, and each member\'s position: ' + JSON.stringify(tkInfo));
  await p.screenshot({ path: path.join(out, 'group-ticket-placed-1366.png') });
  /* answer 1: the group's lines on an MNQ chart: one per level, "STP n · Lucid ×4", each account in the tooltip; a drag moves each */
  await p.click(tk('flattenBtn')); await wait(800);
  await p.selectOption(tk('root'), 'MNQ'); await wait(800);
  await p.fill(tk('bStop'), '20'); await p.press(tk('bStop'), 'Tab'); await p.fill(tk('bTarget'), '40'); await p.press(tk('bTarget'), 'Tab');
  if (!(await p.evaluate(() => window.workspace.ticket().armed))) { await p.click(tk('armBtn')); await wait(300); }
  await clearSent();
  await p.click(tk('buyMkt'));
  await wait(800); console.log('  info: ' + await p.$eval(tk('note'), e => e.textContent).catch(() => ''));
  await until(async () => (await sent(['groupOrder']))[0], 'the MNQ groupOrder (no confirm: every account takes it)');
  const cid = await p.evaluate(() => { const c = window.workspace.panels().find(x => x.type === 'chart' && x.root === 'MNQ' && window.workspace.chart(x.id)); return c ? c.id : null; });
  const stopLine = await until(async () => { const hs = await p.evaluate(i => window.workspace.chart(i).orderHandles(), cid); return hs.find(h => /^G~stop~/.test(h.id)); }, 'the group stop line on the MNQ chart', 10000);
  check(!!stopLine, 'the group\'s stop line is drawn: ' + JSON.stringify(stopLine && stopLine.id));
  /* 1.34.0 (Anthony 2026-10-20, the badge over the instrument): the badge names the group; squeezed, the instrument stays */
  const badge = await p.$eval('.ws-panel[data-id="' + cid + '"] .ws-head .pill.armed', e => ({ text: e.textContent, title: e.title }));
  check(badge.text === 'ARMED' && badge.title === 'Armed: this chart\'s orders go to group Lucid (group g1)', 'the ARMED badge names the group: ' + JSON.stringify(badge));
  const squeezed = await p.evaluate(i => { const head = document.querySelector('.ws-panel[data-id="' + i + '"] .ws-head'); const was = head.style.width; head.style.width = '470px';
    const n = head.querySelector('.ws-name'), b = head.querySelector('.pill.armed'), r = { name: Math.round(n.getBoundingClientRect().width), nameFull: n.scrollWidth <= n.clientWidth + 1, badge: Math.round(b.getBoundingClientRect().width) }; head.style.width = was; return r; }, cid);
  check(squeezed.name >= 50 && squeezed.badge <= 50 && squeezed.badge >= 30, 'a narrow chart (470 px): the badge gives way first (down to ARMED), the instrument still shows: ' + JSON.stringify(squeezed));
  /* 1.34.0 (Anthony 2026-10-20, "the order entry does not show on the chart"): the group's position, one combined line */
  const gpos = await until(async () => { const s = await control('state', { root: 'MNQ' }); const q = ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'].map(a => ((s.positions || {})[a + '|MNQ'] || {}).qty || 0); if (!q.every(x => x > 0)) return null;
    const cp = await p.evaluate(i => window.workspace.chart(i).getPosition(), cid); return cp && cp.qty === q.reduce((a, b) => a + b, 0) ? { cp, q } : null; }, 'the group\'s position on the MNQ chart', 8000);
  check(!!gpos && gpos.cp.group === 'Lucid \u00d74' && gpos.cp.avgPrice > 0, 'the group\'s entry: one position line, the members\' sizes added, named for the group: ' + JSON.stringify(gpos));
  if (gpos) {
    const pbox = await p.evaluate(i => window.workspace.chart(i).positionBox(), cid), cbox = await p.locator('.ws-panel[data-id="' + cid + '"] canvas').first().boundingBox();
    if (pbox) { await p.mouse.move(cbox.x + pbox.x + 6, cbox.y + pbox.y + pbox.h / 2); await wait(300); }
    let ptip = await p.$eval('.ws-panel[data-id="' + cid + '"] canvas', c => c.title);
    if (!ptip) {   // the review: the label moved with the price axis between measuring and hovering: measured again, hovered again
      const pb2 = await p.evaluate(i => window.workspace.chart(i).positionBox(), cid), cb2 = await p.locator('.ws-panel[data-id="' + cid + '"] canvas').first().boundingBox();
      if (pb2) { await p.mouse.move(cb2.x + pb2.x + 6, cb2.y + pb2.y + pb2.h / 2); await wait(300); }
      ptip = await p.$eval('.ws-panel[data-id="' + cid + '"] canvas', c => c.title);
    }
    check(/^Group Lucid: SIM-A LONG \d+ @ [0-9.,]+\nSIM-B LONG \d+ @ [0-9.,]+\nSIM-C LONG \d+ @ [0-9.,]+\nSIM-D LONG \d+ @ [0-9.,]+\nLONG \d+ in all @ [0-9.,]+ \(the average\)$/.test(ptip), 'its tooltip lists each account\'s position and the average: ' + JSON.stringify(ptip));
    await p.screenshot({ path: path.join(out, 'group-ticket-position-1366.png') });
    /* 1.40.0 (Anthony 2026-10-30): one fill mark per group fill on the group's chart, at the members' average, the contracts summed;
       its hover lists each account's own fill */
    const gm = await until(async () => { const ms = await p.evaluate(i => window.workspace.chart(i).getMarkers(), cid); const g = ms.filter(m => m.account === 'group' && m.side === 'buy'); return g.length ? g : null; }, 'the group fill mark on the MNQ chart', 8000);
    const want = gpos.q.reduce((a, b) => a + b, 0);
    check(gm && gm.length === 1 && gm[0].qty === want && gm[0].members.length === 4 && Math.abs(gm[0].price - gm[0].members.reduce((a, x) => a + x.qty * x.price, 0) / want) < 1e-9,
      '1.40.0: one mark for the group entry, ' + want + ' contracts at the members\' average: ' + JSON.stringify(gm && gm.map(m => ({ qty: m.qty, price: m.price, n: m.members.length }))));
    if (gm) {
      const at = await p.evaluate(([i, t, price]) => { const ch = window.workspace.chart(i), bs = ch.bars(); let k = bs.length - 1; while (k > 0 && bs[k].t > t) k--; return { x: ch.barToX(k), y: ch.priceToY(price) }; }, [cid, gm[0].t, gm[0].price]);
      const cb = await p.locator('.ws-panel[data-id="' + cid + '"] canvas').first().boundingBox();
      await p.mouse.move(cb.x + at.x, cb.y + at.y + 3); await wait(300);
      const ftip = await p.$eval('.ws-panel[data-id="' + cid + '"] canvas', c => c.title);
      check(/^Group buy \d+ @ [0-9.,]+: SIM-A \d+ @ [0-9.,]+, SIM-B \d+ @ [0-9.,]+, SIM-C \d+ @ [0-9.,]+, SIM-D \d+ @ [0-9.,]+$/.test(ftip), '1.40.0: its hover lists each account\'s own fill: ' + JSON.stringify(ftip));
      await p.locator('.ws-panel[data-id="' + cid + '"]').screenshot({ path: path.join(out, 'group-chart-fill-marks-1366.png') });
    }
  }
  if (stopLine) {
    /* the review: measured again right before the hover too (the label moves with the price axis's width) */
    const box = await p.locator('.ws-panel[data-id="' + cid + '"] canvas').first().boundingBox();
    const sl1 = (await p.evaluate(i => window.workspace.chart(i).orderHandles(), cid)).find(h => h.id === stopLine.id) || stopLine;
    await p.mouse.move(box.x + sl1.box.x + 8, box.y + sl1.box.y + sl1.box.h / 2); await wait(300);
    let tip = await p.$eval('.ws-panel[data-id="' + cid + '"] canvas', c => c.title);
    if (!tip) {
      const bx = await p.locator('.ws-panel[data-id="' + cid + '"] canvas').first().boundingBox();
      const sl = (await p.evaluate(i => window.workspace.chart(i).orderHandles(), cid)).find(h => h.id === stopLine.id) || stopLine;
      await p.mouse.move(bx.x + sl.box.x + 8, bx.y + sl.box.y + sl.box.h / 2); await wait(300);
      tip = await p.$eval('.ws-panel[data-id="' + cid + '"] canvas', c => c.title);
    }
    check(/^Group Lucid: SIM-A SELL STP \d+ @ [0-9.,]+\nSIM-B SELL STP \d+ @ [0-9.,]+\nSIM-C SELL STP \d+ @ [0-9.,]+\nSIM-D SELL STP \d+ @ [0-9.,]+$/.test(tip), 'its tooltip lists each account\'s stop: ' + JSON.stringify(tip));
    await p.screenshot({ path: path.join(out, 'group-ticket-lines-1366.png') });
    await clearSent();
    /* the review: measured again right before the drag (the line's label moves with the price axis's width as prices change) */
    const box2 = await p.locator('.ws-panel[data-id="' + cid + '"] canvas').first().boundingBox();
    const sl2 = (await p.evaluate(i => window.workspace.chart(i).orderHandles(), cid)).find(h => h.id === stopLine.id) || stopLine;
    await p.mouse.move(box2.x + sl2.box.x + 8, box2.y + sl2.box.y + sl2.box.h / 2); await wait(150);
    await p.mouse.down(); await p.mouse.move(box2.x + sl2.box.x + 8, box2.y + sl2.box.y + sl2.box.h / 2 + 30, { steps: 6 }); await p.mouse.up(); await wait(700);
    const ch = await sent(['change']);
    const prices = [...new Set(ch.map(m => m.price))];
    check(ch.length === 4 && prices.length === 1, 'a drag of the group stop: one change per member, all to the same price: ' + JSON.stringify(ch.map(m => m.id + ' ' + m.price)));
    await wait(2000);
    const note2 = await p.$eval(tk('note'), e => e.textContent).catch(() => '');
    check(/^Group stops to [0-9.,]+: SIM-A, SIM-B, SIM-C, SIM-D moved\.$/.test(note2), 'each member\'s result said: ' + note2);
    await p.screenshot({ path: path.join(out, 'group-ticket-moved-1366.png') });
  }
  /* Close: every member's own position */
  await clearSent();
  await p.click(tk('flattenBtn')); await wait(500);
  const fl = (await sent(['flatten'])).map(m => m.account + ' ' + m.root).sort();
  check(JSON.stringify(fl) === JSON.stringify(['SIM-A MNQ', 'SIM-B MNQ', 'SIM-C MNQ', 'SIM-D MNQ']), 'Close on the group: a Flatten for every member: ' + JSON.stringify(fl));
  /* Anthony 2026-10-20: "flatten all does not work with these group orders": a group entry on NQ and one on MNQ, then the
     top bar's Flatten all in ANOTHER window (it was left on None there: a group was not followed) covers both instruments on
     every member, and every member ends flat */
  await until(async () => { const s = await control('state', { root: 'MNQ' }); return ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'].every(a => !(((s.positions || {})[a + '|MNQ'] || {}).qty)) || null; }, 'flat after Close');
  const p2 = await ctx.newPage(); p2.on('pageerror', e => fail('p2 pageerror: ' + e.message));
  await p2.goto(`http://localhost:${PORT}/live/?layout=Main`);
  await p2.waitForSelector('.cb-pin-key', { timeout: 15000 }).then(() => enterPin(p2, TEST_PIN)).catch(() => {});
  await p2.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 40000 }); await wait(2500);
  for (const R of ['NQ', 'MNQ']) {
    await p.selectOption(tk('root'), R); await wait(600);
    await p.fill(tk('bStop'), '20'); await p.press(tk('bStop'), 'Tab'); await p.fill(tk('bTarget'), '40'); await p.press(tk('bTarget'), 'Tab');
    if (!(await p.evaluate(() => window.workspace.ticket().armed))) { await p.click(tk('armBtn')); await wait(300); }
    await clearSent(); await wait(1200);
    await p.click(tk('buyMkt'));
    await until(async () => (await sent(['groupOrder']))[0], 'the ' + R + ' groupOrder for Flatten all');
    await until(async () => { const s = await control('state', { root: R }); return ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'].every(a => (((s.positions || {})[a + '|' + R] || {}).qty || 0) > 0) || null; }, 'every member long ' + R);
  }
  /* Anthony 2026-10-20: "the order entry does not show on the chart": the other window's MNQ chart draws the group's lines too */
  const cid2 = await p2.evaluate(() => { const c = window.workspace.panels().find(x => x.type === 'chart' && x.root === 'MNQ' && window.workspace.chart(x.id)); return c ? c.id : null; });
  const line2 = cid2 && await until(async () => { const hs = await p2.evaluate(i => window.workspace.chart(i).orderHandles(), cid2); return hs.find(h => /^G~(stop|target)~/.test(h.id)); }, 'the group\'s lines on the other window\'s MNQ chart', 6000);
  check(!!line2, 'the other window\'s MNQ chart draws the group\'s lines: ' + JSON.stringify(line2 && line2.id));
  await p2.screenshot({ path: path.join(out, 'group-ticket-other-window-1366.png') });
  /* the sample market may fill a bracket meanwhile: Flatten all is checked against what is open at the press */
  const held = []; for (const R of ['NQ', 'MNQ']) { const s = await control('state', { root: R }); for (const a of ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D']) if (((s.positions || {})[a + '|' + R] || {}).qty) held.push(a + ' ' + R); }
  await p2.click('#wsFlat'); await wait(2500);
  const fa = (await p2.evaluate(() => window.__sent.filter(m => m.type === 'flatten'))).map(m => m.account + ' ' + m.root).sort();
  check(held.length >= 4 && held.every(x => fa.includes(x)) && fa.every(x => /^SIM-[A-D] (NQ|MNQ)$/.test(x)), 'Flatten all on the group, from another window: every member with a position, both instruments: ' + JSON.stringify(fa) + ' (open: ' + held.length + ')');
  const flat = await until(async () => { const q = []; for (const R of ['NQ', 'MNQ']) { const s = await control('state', { root: R }); for (const a of ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D']) q.push(((s.positions || {})[a + '|' + R] || {}).qty || 0); } return q.every(x => !x) ? q : null; }, 'every member flat after Flatten all', 6000);
  check(!!flat, 'after Flatten all every member is flat on NQ and MNQ');
  /* 1.34.0 (Anthony 2026-10-20, item 7): one account on the ticket shows its room (ChartBridge's numbers) and this entry's risk at
     its stop; a group shows none of it (its next entry's sizes instead) */
  const grpRoom = await p.$eval(tk('room'), e => e.textContent);
  await p.selectOption(tk('oAcct'), 'SIM-B'); await p.selectOption(tk('root'), 'NQ'); await wait(600);
  await p.selectOption(tk('oQty'), '1');
  await p.fill(tk('bStop'), '20'); await p.press(tk('bStop'), 'Tab');
  const room = await until(async () => { const t = await p.$eval(tk('room'), e => e.textContent); return /^Room (\$[0-9,.]+ daily · )?\$[0-9,.]+ to floor · entry \$100\.00 at stop$/.test(t) ? t : null; }, 'the room line on a single account');
  check(grpRoom === '' && !!room, 'the ticket on one account shows its room and the entry\'s risk at its stop (1 NQ, 20 ticks: $100); on the group none: ' + room);
  await p.fill(tk('bStop'), '0'); await p.press(tk('bStop'), 'Tab');
  const room0 = await until(async () => { const t = await p.$eval(tk('room'), e => e.textContent); return /entry: no stop$/.test(t) ? t : null; }, 'the room line with no stop');
  check(!!room0, 'with no stop the line says so (nothing is held on it): ' + room0);
  await p.fill(tk('bStop'), '20'); await p.press(tk('bStop'), 'Tab'); await wait(600);
  await p.locator('.ws-panel:has([data-tk-id="room"])').screenshot({ path: path.join(out, 'group-ticket-room-1366.png') });
  await ctx.close();
} catch (e) { fail('threw: ' + (e && e.stack || e)); }
finally { await browser.close(); bridge.kill(); }
console.log(errors.length ? errors.length + ' FAILED' : 'group-ticket smoke: all passed');
process.exit(errors.length ? 1 : 0);
