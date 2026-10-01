// The workspace's order ticket (chart 1.12.0), run by test/workspace-smoke.mjs: two pages in one browser context are two
// windows on one PC. Against the fake bridge with trading on (sample data; nothing reaches a broker):
//   - the ticket's buttons send exactly what the single chart page's 1.11.0 order bar sends (the same sequence run on
//     /single.html and on the ticket, the messages compared);
//   - chart clicks on every chart of the ticket's instrument, in both windows (the other window's forwarded and sent from
//     the ticket's window), none on other instruments; drags and the x; the Armed border;
//   - "Move the ticket here?" and Armed off after the move; the tie-break when two windows add it at once; the ticket's
//     window not answering (a note, nothing sent) and closed;
//   - hotkeys in both windows (Buy forwarded, Close and Flatten all sent from the window pressed in); the top bar's
//     Flatten all in both windows while disarmed; switching the instrument with a position open ("Also open" and its
//     Close); KEYS ON / OFF; the focus coming back after a pick; screenshots at 1920x1080, 2560x1440, 1366x768.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';

const ORDER_TYPES = ['order', 'change', 'cancel', 'flatten'];
const wait = ms => new Promise(r => setTimeout(r, ms));

export async function run({ browser, check, fail, shot, root, port }) {
  const bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port), '--trading', '--trade-accounts=Sim101,DEMO-EVAL', '--max-qty=MNQ:9,NQ:2,MES:2,ES:2', '--test-controls', '--test-pin=' + TEST_PIN], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => bridge.stdout.once('data', r));
  const control = async (what, q) => (await fetch(`http://127.0.0.1:${port}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
  const state = root => control('state', { root: root || 'MNQ' });
  async function until(fn, what, ms) {
    const end = Date.now() + (ms || 8000);
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) { fail('timed out: ' + what); return null; } await wait(100); }
  }
  const flatAll = () => until(async () => { const s = await state(); return !s.orders.length && !Object.values(s.positions).some(p => p.qty); }, 'everything flat', 10000);
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  try {
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await ctx.addInitScript(() => {
      // every message a page sends, by connection (the order connection is the one that signs in)
      const S = window.__spy = { sockets: [] };
      const Real = window.WebSocket;
      function Spy(url, p) { const sock = p === undefined ? new Real(url) : new Real(url, p); const rec = { sent: [], sock }; const send = sock.send.bind(sock); sock.send = d => { rec.sent.push(d); return send(d); }; S.sockets.push(rec); return sock; }
      Spy.prototype = Real.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
      window.WebSocket = Spy;
      // a window that does not answer: its BroadcastChannel messages arrive __bcDelay ms late (0: as they come)
      const RealBC = window.BroadcastChannel;
      if (RealBC) window.BroadcastChannel = function (name) {
        const bc = new RealBC(name), w = { onmessage: null, postMessage: m => bc.postMessage(m), close: () => bc.close() };
        bc.onmessage = e => { const d = window.__bcDelay || 0; if (d) setTimeout(() => w.onmessage && w.onmessage(e), d); else if (w.onmessage) w.onmessage(e); };
        return w;
      };
      try { if (!localStorage.getItem('live-hotkeys-v1')) localStorage.setItem('live-hotkeys-v1', JSON.stringify({ buy: 'Alt+B', sell: 'Alt+S', be: 'Alt+K', close: 'Alt+C', flattenAll: 'Shift+F9' })); } catch (e) {}
    });
    const L = Math.round((await control('hold', { root: 'MNQ' })).last);
    await control('price', { root: 'MNQ', p: L });
    const pages = [];
    async function openWs(layout) {
      const p = await ctx.newPage();
      p.on('pageerror', e => fail('ticket page error: ' + e.message));
      await p.goto(`http://localhost:${port}/live/?layout=${layout}`);
      await p.waitForSelector('.cb-pin-key', { timeout: 15000 });
      await enterPin(p, TEST_PIN);
      await p.waitForFunction(() => document.getElementById('wsConn').classList.contains('live') && window.workspace.ticket().enabled, null, { timeout: 30000 });
      pages.push(p);
      return p;
    }
    /* order messages a page sent (cid dropped; an order id kept as ID), and whether from its order connection */
    const sent = p => p.evaluate(t => window.__spy.sockets.flatMap(k => k.sent.map(d => JSON.parse(d))).filter(m => t.includes(m.type)).map(m => { const c = Object.assign({}, m); delete c.cid; if (c.id) c.id = 'ID'; return c; }), ORDER_TYPES);
    const clear = p => p.evaluate(() => { for (const k of window.__spy.sockets) k.sent.length = 0; });
    const tk = (p, id) => p.locator(`.ws-panel[data-type="ticket"] [data-tk-id="${id}"]`);
    const pos = async p => (await tk(p, 'oPos').textContent()).trim();
    const tnote = p => p.evaluate(() => { const n = document.querySelector('[data-tk-id="note"]'); return n ? n.textContent : ''; });
    const wnote = p => p.evaluate(() => document.getElementById('wsNote').hidden ? '' : document.getElementById('wsNote').textContent);
    const info = p => p.evaluate(() => window.workspace.ticket());
    const panelsOf = async (p, type, rootName) => (await p.evaluate(() => window.workspace.panels())).filter(x => x.type === type && (!rootName || x.root === rootName));

    /* ---------------- the 1.11.0 bar's messages, on /single.html */
    const SEQ = async (p, sel, chartClick) => {
      const msgs = [];
      const click = async s => { await p.click(s); await wait(450); };
      await control('price', { root: 'MNQ', p: L });
      await clear(p);
      await click(sel.buy);                                        // disarmed: nothing
      await click(sel.close);                                      // Flatten works disarmed
      await flatAll();
      await click(sel.arm);
      await p.selectOption(sel.qty, '2');
      for (const [s, v] of [[sel.stop, '40'], [sel.target, '80']]) { await p.fill(s, v); await p.press(s, 'Tab'); }
      await wait(450);
      await click(sel.buy);
      await until(async () => (await state()).orders.filter(o => o.role === 'stop').length === 1, 'long 2 with its legs (' + sel.buy + ')');
      await control('price', { root: 'MNQ', p: L + 2 });
      await wait(450);
      await click(sel.be);
      await until(async () => (await state()).orders.some(o => o.role === 'stop' && o.price === L), 'stop at break-even (' + sel.be + ')');
      await click(sel.sell);                                       // at L + 2: the stop at break-even stays untouched
      await until(async () => !Object.values((await state()).positions).some(x => x.qty) && !(await state()).orders.length, 'flat after Sell (' + sel.sell + ')');
      await chartClick(L - 5);                                     // a buy limit below the price
      await until(async () => (await state()).orders.length === 1, 'a working limit (' + sel.buy + ')');
      await wait(450);
      await click(sel.cancelAll);
      await until(async () => !(await state()).orders.length, 'cancelled (' + sel.cancelAll + ')');
      await click(sel.close);
      await flatAll();
      msgs.push(...await sent(p));
      await control('price', { root: 'MNQ', p: L });
      await p.click(sel.arm);                                      // off again
      await p.selectOption(sel.qty, '1');
      for (const [s, v] of [[sel.stop, '0'], [sel.target, '0']]) { await p.fill(s, v); await p.press(s, 'Tab'); }
      return msgs;
    };
    /* Shift+click on a chart's canvas at a price; `id` a workspace panel, or '' for the single chart page */
    const shiftClickAt = async (p, canvas, price, id) => {
      const b = await p.locator(canvas).first().boundingBox();
      const y = await p.evaluate(([i, pr]) => (i ? window.workspace.chart(i) : window.liveChart).priceToY(pr), [id, price]);
      await p.keyboard.down('Shift'); await p.mouse.click(b.x + b.width * 0.45, b.y + y); await p.keyboard.up('Shift');
    };
    const single = await ctx.newPage();
    single.on('pageerror', e => fail('single page error: ' + e.message));
    await single.goto(`http://localhost:${port}/live/single.html`);
    await single.waitForSelector('.cb-pin-key', { timeout: 15000 }); await enterPin(single, TEST_PIN);
    await single.waitForFunction(() => !!document.getElementById('connPill') && document.getElementById('connPill').textContent === 'LIVE' && !document.getElementById('buyMkt').disabled, null, { timeout: 30000 });
    await single.evaluate(() => window.liveChart.goLive()); await wait(1200);
    const barMsgs = await SEQ(single, { buy: '#buyMkt', sell: '#sellMkt', close: '#flattenBtn', be: '#beBtn', cancelAll: '#cancelAllBtn', arm: '#armBtn', qty: '#oQty', stop: '#bStop', target: '#bTarget' },
      price => shiftClickAt(single, '#chart canvas', price, ''));
    await single.close();

    /* ---------------- two windows; neither takes the ticket by itself */
    const A = await openWs('Main');
    const B = await openWs('Second');
    check(!(await info(A)).held && !(await info(B)).held && (await info(A)).holder === null, 'two windows open: no window has the ticket until one adds it');
    await A.click('.ws-panel[data-type="ticket"] [data-tk="take"]');
    await A.waitForSelector('[data-tk-id="buyMkt"]');
    await B.waitForFunction(() => /Ticket is in the other window/.test(document.querySelector('.ws-panel[data-type="ticket"] .ws-body').textContent));
    check((await info(A)).held && !(await info(B)).held && (await info(B)).holder.root === 'MNQ', 'A takes it: B shows "Ticket is in the other window"');
    const ticketUi = await A.evaluate(() => [...document.querySelectorAll('.ws-panel[data-type="ticket"] [data-tk-id]')].map(e => e.dataset.tkId));
    check(['root', 'oAcct', 'oQty', 'bPreset', 'armBtn', 'buyMkt', 'sellMkt', 'beBtn', 'flattenBtn', 'cancelAllBtn', 'oPos', 'fill'].every(x => ticketUi.includes(x)) && await tk(A, 'flattenBtn').textContent() === 'Close',
      'the ticket: instrument, account, Qty, bracket presets, Armed, Buy MKT, Sell MKT, B/E, Close, Cancel all, position, last fill');
    const mnqMain = (await panelsOf(A, 'chart', 'MNQ'))[0];
    await A.evaluate(id => window.workspace.chart(id).goLive(), mnqMain.id); await wait(1200);
    const ticketMsgs = await SEQ(A, { buy: '[data-tk-id="buyMkt"]', sell: '[data-tk-id="sellMkt"]', close: '[data-tk-id="flattenBtn"]', be: '[data-tk-id="beBtn"]', cancelAll: '[data-tk-id="cancelAllBtn"]', arm: '[data-tk-id="armBtn"]', qty: '[data-tk-id="oQty"]', stop: '[data-tk-id="bStop"]', target: '[data-tk-id="bTarget"]' },
      price => shiftClickAt(A, `.ws-panel[data-id="${mnqMain.id}"] canvas`, price, mnqMain.id)).catch(e => { fail('ticket sequence: ' + e.message); return []; });
    check(barMsgs.length >= 7 && JSON.stringify(ticketMsgs) === JSON.stringify(barMsgs), 'the ticket sends exactly what the 1.11.0 order bar sends (Close disarmed, Buy 2 with bracket 40 / 80, B/E, Sell, a chart click, Cancel all, Close): ' + JSON.stringify(ticketMsgs) + (JSON.stringify(ticketMsgs) === JSON.stringify(barMsgs) ? '' : ' vs the bar ' + JSON.stringify(barMsgs)));
    await shot(A, 'workspace-ticket-1920x1080.png');
    await clear(A); await clear(B);

    /* ---------------- chart clicks on every chart of the ticket's instrument, in both windows; none on others */
    await A.click('[data-tk-id="armBtn"]');
    await B.waitForFunction(() => window.workspace.ticket().armed);
    const border = p => p.evaluate(() => window.workspace.panels().filter(x => x.type === 'chart').map(x => x.root + ':' + document.querySelector(`.ws-panel[data-id="${x.id}"] .ws-body > .chart-live`).classList.contains('is-armed')));
    const bA = await border(A), bB = await border(B);
    check(bA.every(x => x.startsWith('MNQ') ? x.endsWith('true') : x.endsWith('false')) && bB.every(x => x.startsWith('MNQ') ? x.endsWith('true') : x.endsWith('false')), 'the Armed border on every MNQ chart in both windows, on no other: ' + bA + ' | ' + bB);
    const borderColor = await A.evaluate(id => getComputedStyle(document.querySelector(`.ws-panel[data-id="${id}"] .stage`)).borderTopColor, mnqMain.id);
    check(borderColor === 'rgb(224, 180, 90)', 'in the existing Armed color (' + borderColor + ')');
    const clickChart = async (p, id, price) => { await p.evaluate(i => window.workspace.chart(i).goLive(), id); await wait(300); await shiftClickAt(p, `.ws-panel[data-id="${id}"] canvas`, price, id); await wait(500); };
    const workingN = async () => (await state()).orders.length;
    let n0 = await workingN();
    for (const [p, w] of [[A, 'A'], [B, 'B']]) {
      for (const c of await panelsOf(p, 'chart', 'MNQ')) {
        await clickChart(p, c.id, L - 3 - (await workingN()));
        const n1 = await until(async () => { const n = await workingN(); return n > n0 ? n : null; }, 'a limit from ' + w + ' ' + c.tf);
        check(n1 === n0 + 1, 'Shift+click on ' + w + '\'s MNQ ' + c.tf + ' chart places a limit');
        n0 = n1;
        await wait(450);
      }
    }
    const fromA = (await sent(A)).filter(m => m.type === 'order').length, fromB = (await sent(B)).filter(m => m.type === 'order').length;
    check(fromA === 4 && fromB === 0, 'all four sent from the ticket\'s window (B\'s two forwarded): A ' + fromA + ', B ' + fromB);
    for (const [p, w] of [[A, 'A'], [B, 'B']]) {
      const other = (await p.evaluate(() => window.workspace.panels())).find(x => x.type === 'chart' && x.root !== 'MNQ');
      await clickChart(p, other.id, 1);
      check(await workingN() === n0, 'a Shift+click on ' + w + '\'s ' + other.root + ' chart sends nothing (display only for orders)');
    }
    await shot(B, 'workspace-ticket-other-window.png');

    /* ---------------- drags and the x, from the other window (forwarded) */
    const bMain = (await panelsOf(B, 'chart', 'MNQ'))[0];
    await B.evaluate(i => window.workspace.chart(i).goLive(), bMain.id); await wait(500);
    const handle = await B.evaluate(i => { const c = window.workspace.chart(i); const h = c.orderHandles()[0]; return h ? { id: h.id, x: h.box.x + h.box.w / 2, y: h.box.y + h.box.h / 2, xx: h.xbox ? h.xbox.x + h.xbox.w / 2 : 0, xy: h.xbox ? h.xbox.y + h.xbox.h / 2 : 0 } : null; }, bMain.id);
    const cb = await B.locator(`.ws-panel[data-id="${bMain.id}"] canvas`).first().boundingBox();
    if (!handle) fail('no order label on B\'s chart');
    else {
      const before = (await state()).orders.find(o => o.id === handle.id).price;
      const to = await B.evaluate(([i, p]) => window.workspace.chart(i).priceToY(p), [bMain.id, before - 2]);
      await clear(A);
      await B.mouse.move(cb.x + handle.x, cb.y + handle.y); await B.mouse.down();
      await B.mouse.move(cb.x + handle.x, cb.y + (handle.y + to) / 2, { steps: 4 }); await B.mouse.move(cb.x + handle.x, cb.y + to, { steps: 4 }); await B.mouse.up();
      const moved = await until(async () => { const o = (await state()).orders.find(x => x.id === handle.id); return o && o.price !== before ? o.price : null; }, 'the dragged order moved');
      check(moved !== null && (await sent(A)).some(m => m.type === 'change') && !(await sent(B)).some(m => m.type === 'change'), 'a drag on B\'s chart moves the order, sent from A (' + before + ' to ' + moved + ')');
      await wait(450);
      await B.evaluate(i => window.workspace.chart(i).goLive(), bMain.id); await wait(400);
      const h2 = await B.evaluate(([i, id]) => { const h = window.workspace.chart(i).orderHandles().find(x => x.id === id); return h && h.xbox ? { x: h.xbox.x + h.xbox.w / 2, y: h.xbox.y + h.xbox.h / 2 } : null; }, [bMain.id, handle.id]);
      if (h2) { await B.mouse.click(cb.x + h2.x, cb.y + h2.y); }
      await until(async () => !(await state()).orders.some(x => x.id === handle.id), 'the x on B\'s chart cancels it');
      check(!(await sent(B)).some(m => m.type === 'cancel'), 'the x on B\'s chart: the cancel went from A');
    }

    /* ---------------- hotkeys in both windows */
    const press = async (p, k) => { await p.evaluate(() => document.activeElement && document.activeElement.blur()); await p.keyboard.press(k); await wait(500); };
    await clear(A); await clear(B);
    await B.bringToFront();
    await press(B, 'Alt+B');                                       // Buy, forwarded to A
    await until(async () => (await pos(A)).startsWith('LONG 1'), 'long 1 from B\'s Buy key');
    check((await sent(A)).filter(m => m.type === 'order').length === 1 && !(await sent(B)).some(m => m.type === 'order'), 'B\'s Buy key: forwarded, sent from A');
    await press(B, 'Alt+C');                                       // Close, direct from B
    await until(async () => !Object.values((await state()).positions).some(x => x.qty), 'flat after B\'s Close key');
    check(JSON.stringify((await sent(B)).filter(m => m.type === 'flatten')) === JSON.stringify([{ type: 'flatten', account: 'Sim101', root: 'MNQ' }]), 'B\'s Close key: the flatten goes from B, on the ticket\'s account and instrument');
    await A.bringToFront();
    await press(A, 'Alt+B');
    await until(async () => (await pos(A)).startsWith('LONG 1'), 'long 1 from A\'s Buy key');
    await clear(A); await clear(B);
    await press(A, 'Shift+F9');
    await flatAll();
    check((await sent(A)).filter(m => m.type === 'flatten').length >= 1 && !(await sent(B)).length, 'A\'s Flatten all key: from A');
    await wait(450);
    await A.click('[data-tk-id="buyMkt"]');
    await until(async () => (await pos(A)).startsWith('LONG 1'), 'long 1 again');
    await clear(A); await clear(B);
    await B.bringToFront();
    await press(B, 'Shift+F9');
    await flatAll();
    check((await sent(B)).some(m => m.type === 'flatten') && !(await sent(A)).length, 'B\'s Flatten all key: from B');

    /* ---------------- the top bar's Flatten all, in both windows, disarmed */
    await A.bringToFront();
    await A.click('[data-tk-id="armBtn"]');                        // off
    check(!(await info(A)).armed, 'disarmed');
    for (const [p, w] of [[A, 'A'], [B, 'B']]) {
      await control('elsewhere', { account: 'Sim101', root: 'NQ', side: 'buy', kind: 'limit', qty: 1, p: Math.round((await state('NQ')).last) - 20 });
      await until(async () => (await state()).orders.some(o => o.root === 'NQ'), 'an NQ order working');
      await clear(A); await clear(B);
      await p.bringToFront(); await p.click('#wsFlat'); await wait(300);
      await flatAll();
      const mine = (await sent(p)).filter(m => m.type === 'flatten'), theirs = (await sent(p === A ? B : A)).length;
      check(JSON.stringify(mine) === JSON.stringify([{ type: 'flatten', account: 'Sim101', root: 'NQ' }]) && !theirs, w + '\'s Flatten all button while disarmed: from ' + w + ' (' + JSON.stringify(mine) + ')');
    }

    /* ---------------- the ticket's window does not answer: a note, nothing sent */
    await A.bringToFront();
    await A.click('[data-tk-id="armBtn"]');
    await B.waitForFunction(() => window.workspace.ticket().armed);
    await clear(A); await clear(B);
    const bMain2 = (await panelsOf(B, 'chart', 'MNQ'))[0];
    await B.evaluate(i => window.workspace.chart(i).goLive(), bMain2.id); await wait(300);
    await A.evaluate(() => { window.__bcDelay = 700; });             // A's window stalls: what B says reaches it 0.7 s late
    await shiftClickAt(B, `.ws-panel[data-id="${bMain2.id}"] canvas`, L - 6, bMain2.id);
    await wait(1500);
    await A.evaluate(() => { window.__bcDelay = 0; });
    check(/did not answer: nothing was sent/.test(await wnote(B)) && !(await sent(A)).length && !(await state()).orders.length, 'A stalled 0.7 s: B\'s click says "' + await wnote(B) + '", and nothing is sent, then or later');

    /* ---------------- switch the ticket's instrument with a position open: "Also open" and its Close */
    await A.bringToFront();
    await wait(450);
    await A.click('[data-tk-id="buyMkt"]');
    await until(async () => (await pos(A)).startsWith('LONG 1'), 'MNQ long 1');
    await A.selectOption('[data-tk-id="root"]', 'NQ');
    const afterPick = await A.evaluate(() => document.activeElement === document.body);
    await wait(300);
    const also = await A.textContent('[data-tk-id="also"]');
    check(/Also open: MNQ \+1/.test(also) && !(await info(A)).armed && (await info(A)).root === 'NQ', 'switched to NQ with MNQ long: "' + also.trim() + '", Armed off');
    check(afterPick, 'the focus comes back after the instrument pick');
    const bAfter = await border(B);
    await A.click('[data-tk-id="armBtn"]');
    await B.waitForFunction(() => window.workspace.ticket().armed && window.workspace.ticket().root === 'NQ');
    const bArmed = await border(B);
    check(bArmed.every(x => x.startsWith('NQ') || x.endsWith('false')), 'the MNQ charts stop taking order clicks (no border); the NQ chart takes them: ' + bArmed + ' (before ' + bAfter + ')');
    const mnqStill = await B.evaluate(id => window.workspace.chart(id).getPosition(), bMain2.id);
    check(mnqStill && mnqStill.qty === 1, 'the MNQ chart still shows the position');
    await clear(A);
    await A.click('[data-tk-id="also"] button[data-close="MNQ"]');
    await flatAll();
    check(JSON.stringify(await sent(A)) === JSON.stringify([{ type: 'flatten', account: 'Sim101', root: 'MNQ' }]), '"Also open"\'s Close flattens MNQ');
    await shot(A, 'workspace-ticket-also-open.png');
    await A.selectOption('[data-tk-id="root"]', 'MNQ');

    /* ---------------- KEYS ON / OFF, focus return, a key in a box */
    await A.bringToFront();
    await A.evaluate(() => document.activeElement && document.activeElement.blur()); await wait(400);
    const keysOn = await A.textContent('#wsKeys');
    await A.focus('[data-tk-id="bStop"]'); await wait(400);
    const keysBox = await A.textContent('#wsKeys');
    await clear(A);
    await A.keyboard.press('Alt+C'); await wait(300);
    const boxNote = await wnote(A);
    check(keysOn === 'KEYS ON' && keysBox === 'KEYS OFF', 'KEYS ON with nothing focused, KEYS OFF with the focus in a box (' + keysOn + ', ' + keysBox + ')');
    check(!(await sent(A)).length && boxNote === 'Hotkey ignored: a box has the focus.', 'Close pressed in a box: nothing sent, the note says why (' + boxNote + ')');
    await A.evaluate(() => document.activeElement.blur());
    await A.click('#wsSet'); await wait(300);
    check(await A.textContent('#wsKeys') === 'KEYS OFF', 'KEYS OFF while Settings is open');
    await A.keyboard.press('Escape'); await wait(300);
    const focusBack = [];
    for (const [id, v] of [['oQty', '2'], ['bPreset', '1:2'], ['oAcct', 'DEMO-EVAL'], ['oAcct', 'Sim101'], ['oQty', '1']]) {
      await A.focus(`[data-tk-id="${id}"]`); await A.selectOption(`[data-tk-id="${id}"]`, v); await wait(150);
      focusBack.push(id + ':' + (await A.evaluate(() => document.activeElement === document.body)));
    }
    await A.focus('[data-tk-id="bStop"]');
    await A.evaluate(() => { const i = document.querySelector('[data-tk-id="bStop"]'); i.stepUp(); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
    focusBack.push('spinner:' + (await A.evaluate(() => document.activeElement === document.body)));
    await A.click('[data-tk-id="bUnit"] [data-v="pt"]'); focusBack.push('unit:' + (await A.evaluate(() => document.activeElement === document.body)));
    await A.click('[data-tk-id="bUnit"] [data-v="t"]');
    await A.click('[data-tk-id="armBtn"]'); focusBack.push('armed:' + (await A.evaluate(() => document.activeElement === document.body)));
    check(focusBack.every(x => x.endsWith('true')) && await A.textContent('#wsKeys') === 'KEYS ON', 'the focus comes back after every ticket pick (selects, a spinner step, buttons): KEYS ON at once: ' + focusBack.join(' '));
    await A.selectOption('[data-tk-id="bPreset"]', 'custom');
    for (const [s, v] of [['bStop', '0'], ['bTarget', '0']]) { await A.fill(`[data-tk-id="${s}"]`, v); await A.press(`[data-tk-id="${s}"]`, 'Tab'); }

    /* ---------------- "Move the ticket here?"; Armed off after the move */
    check((await info(A)).armed, 'A armed before the move');
    await B.bringToFront();
    await B.click('.ws-panel[data-type="ticket"] [data-tk="take"]');
    await B.waitForSelector('#wsDialog[open]');
    const ask = await B.textContent('#wsDialog');
    check(/Move the ticket here\?/.test(ask), 'B asks "Move the ticket here?"');
    await B.click('#wsDialog [type="submit"]');
    await B.waitForSelector('[data-tk-id="buyMkt"]', { timeout: 5000 });
    await A.waitForFunction(() => /Ticket is in the other window/.test(document.querySelector('.ws-panel[data-type="ticket"] .ws-body').textContent));
    const iA = await info(A), iB = await info(B);
    check(iB.held && !iA.held && !iB.armed && !iA.armed && iA.holder && iA.holder.wid === iB.wid, 'the ticket moved to B, A shows "Ticket is in the other window", Armed is off');
    await clear(A); await clear(B);
    await A.bringToFront(); await press(A, 'Alt+B');
    check(!(await sent(A)).some(m => m.type === 'order') && !(await sent(B)).some(m => m.type === 'order') && /Armed is off/.test(await wnote(A)), 'A\'s Buy key now goes to B, disarmed there: nothing sent (' + await wnote(A) + ')');
    await shot(B, 'workspace-ticket-moved.png');

    /* ---------------- the tie-break: both windows add the ticket at the same moment */
    await B.click('.ws-panel[data-type="ticket"] .ws-x');            // B closes it: no window has it
    await A.waitForFunction(() => window.workspace.ticket().holder === null && /No window has the ticket/.test(document.querySelector('.ws-panel[data-type="ticket"] .ws-body').textContent));
    check(!(await info(A)).held && !(await info(B)).held, 'the ticket closed in B: no window has it, A does not take it by itself');
    await B.click('#wsAdd');
    await Promise.all([A.click('.ws-panel[data-type="ticket"] [data-tk="take"]'), B.click('#wsAddMenu [data-add="ticket"]')]);
    await wait(800);
    const heldNow = [(await info(A)).held, (await info(B)).held];
    check(heldNow.filter(Boolean).length === 1, 'two windows adding it at once: exactly one holds it (A ' + heldNow[0] + ', B ' + heldNow[1] + ')');
    const loser = heldNow[0] ? B : A;
    if (await loser.$('#wsDialog[open]')) { check(/Move the ticket here\?/.test(await loser.textContent('#wsDialog')), 'the other is asked "Move the ticket here?"'); await loser.click('#wsDialog [data-act="cancel"]'); }
    await wait(300);
    check([(await info(A)).held, (await info(B)).held].filter(Boolean).length === 1, 'and after its "no", still exactly one');

    /* ---------------- the ticket's window closes: no window has it; a forward gets the note and sends nothing */
    const winner = heldNow[0] ? A : B, other = winner === A ? B : A;
    await winner.close();
    await other.waitForFunction(() => window.workspace.ticket().holder === null && !window.workspace.ticket().held, null, { timeout: 5000 });
    await clear(other);
    await other.bringToFront(); await press(other, 'Alt+B');
    check(!(await sent(other)).some(m => m.type === 'order') && /No window has the order ticket: nothing was sent/.test(await wnote(other)), 'the ticket\'s window closed: Buy key in the other says so, nothing sent (' + await wnote(other) + ')');
    await other.click('#wsFlat');
    await wait(300);
    check(/Flatten all/.test(await wnote(other)), 'Flatten all still works there: "' + await wnote(other) + '"');

    /* ---------------- screenshots with the ticket, fully visible */
    if (await other.$('.ws-panel[data-type="ticket"] [data-tk="take"]')) await other.click('.ws-panel[data-type="ticket"] [data-tk="take"]');
    else { await other.click('#wsAdd'); await other.click('#wsAddMenu [data-add="ticket"]'); }
    await other.waitForSelector('[data-tk-id="buyMkt"]').catch(() => fail('the ticket did not open again'));
    for (const [w, h] of [[1920, 1080], [2560, 1440], [1366, 768]]) {
      await other.setViewportSize({ width: w, height: h });
      await wait(900);
      const fit = await other.evaluate(() => { const t = document.querySelector('.ws-panel[data-type="ticket"] .chart-live.tk'); const r = t.getBoundingClientRect(); return { sh: t.scrollHeight, ch: t.clientHeight, sw: t.scrollWidth, cw: t.clientWidth, bottom: r.bottom <= innerHeight }; });
      check(fit.sh <= fit.ch + 1 && fit.sw <= fit.cw + 1 && fit.bottom, w + 'x' + h + ': the whole ticket shows, no scrolling (' + JSON.stringify(fit) + ')');
      await shot(other, `workspace-ticket-${w}x${h}.png`);
    }
  } finally {
    await ctx.close();
    bridge.kill();
  }
}
