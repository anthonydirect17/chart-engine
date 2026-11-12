// Legion's trader desk (chart 1.52.0, live/legion-desk.js) in a browser, beside Praetorian, as the page will have them: the real
// Agent and Bot desks twice on one stand-in feed, Praetorian's on AgentCore.praetorianLink and Legion's mounted by
// LegionDesk.mount on AgentCore.legionLink. Made-up messages only: MINE-1 is the personal account, PROP-1 and PROP-2 prop,
// SIM-A Sim, group g1 two prop accounts.
//   npm run smoke:legion-desk      (CHROMIUM_PATH=/path/to/chrome; SHOTS=dir)
// Checks: a prop trader is whole on Legion's desk and held back on Praetorian's; Auto from Legion goes, forced on Praetorian
// nothing goes; Legion's picker offers prop accounts and the prop group, not your personal account or Sim; the bot on a prop
// account the same; the bot's proposal card of Legion's copy stays inside it; the copilot key never reaches Legion's copy;
// a personal trader the other way round. Answers B4-2: inside a closed fold (builder 1's) nothing is acknowledged, and only
// the open, shown desk acknowledges a proposal; the page's own Bot card and notes are left alone; its keys are its own; the
// bot's Shadow is offered and goes on each desk; the bot on your personal account is held back on Legion; a move from Legion
// goes in Shadow first. Screenshots: legion-desk-agent.png, legion-desk-bot.png.
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
let checks = 0;
const check = (ok, m) => { checks++; if (!ok) { errors.push(m); console.error('  FAIL ' + m); } else console.log('  ok   ' + m); };

const css = ['workspace.css', 'bot.css', 'agent.css'].map(f => `<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'live', f))}">`).join('');
const js = ['bot-core.js', 'agent-core.js', 'fleet.js', 'motion.js', 'agent-helper.js', 'agent-grid.js', 'bot.js', 'agent.js', 'legion-desk.js'].map(f => `<script src="${pathToFileURL(path.join(root, 'live', f))}"></script>`).join('\n');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">${css}
<style>html,body{margin:0}body{display:block;overflow:auto}#prAg,#prBt{display:none}</style></head>
<body><div class="ws-top"><span>SAMPLE DATA: made-up accounts and traders</span></div>
<section class="ag-view" id="prAg"></section><section class="bt-view" id="prBt"></section>
<details id="fold"><summary>Traders (Legion's trader desk)</summary><div id="lgd" style="height:900px"></div></details><div id="below" style="height:3000px"></div>
${js}
<script>
  window.posted = []; window.subs = [];
  /* a stand-in PC helper (made up, as test/praetorian-smoke.mjs has): GET /status, POST /on, /off, each call kept */
  window.helperCalls = []; window.flattened = [];
  window.helperState = { demo: { on: false, running: false, why: 'off', build: 'sample-build-1', runningBuild: null, hero: null, since: null, autoOn: '', cap: null, lastExit: null, spend: { session: 0, overall: 0, date: '2026-11-12' } } };
  const realFetch = window.fetch;
  window.fetch = (u, o) => {
    const url = String(u), at = url.indexOf(':8767/'), m = at > 0 && (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) ? [null, null, '/' + url.slice(at + 6).split(/[?#]/)[0]] : null;
    if (!m) return realFetch(u, o);
    const route = ((o && o.method) || 'GET') + ' ' + m[2];
    window.helperCalls.push(route);
    const body = route === 'GET /status' ? { v: 1, agents: window.helperState, builds: [{ build: 'sample-build-1', stamp: 'aaaaaaaaaaaa', hero: 'Demo', here: true, shadowOk: true, trades: 40, meanR: 0.2, dollars: 900, frozenAt: '2026-10-05' }],
      buildsNote: null, bar: { min_trades: null, min_mean_r: null }, barSet: false, session: '2026-11-12' } : { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  const AF = { listen: h => { window.subs.push(h); return () => {}; }, post: m => { window.posted.push(m); return true; }, send: m => { window.posted.push(['send', m]); return true; }, sendOrder: m => { window.posted.push(['order', m]); return true; }, limit: () => null };
  window.feed = m => { for (const h of window.subs) h.message(m); };
  const mem = window.mem = new Map(), storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  const pr = window.AgentCore.praetorianLink(AF);
  window.prAgent = window.AgentDesk.create({ v3: pr, storage, els: { view: document.getElementById('prAg') }, onTab: () => {} });
  window.prBot = window.BotDesk.create({ v3: pr, storage, els: { view: document.getElementById('prBt') }, onTab: () => {} });
  window.fromLegion = [];   // what Legion's copy posted (the same feed, counted apart)
  const AFL = Object.assign({}, AF, { post: m => { window.fromLegion.push(m.type); return AF.post(m); } });
  window.legion = window.LegionDesk.mount(document.getElementById('lgd'), { v3: AFL, storage, flatten: (account, root) => { window.flattened.push(account + ' ' + root); return true; } });
</script></body></html>`;
const file = path.join(SHOTS, 'legion-desk-smoke.html');
fs.writeFileSync(file, html);

const accounts = { type: 'accounts', personalNamed: true, list: [
  { name: 'MINE-1', connection: 'connected', personal: true, prop: false, sim: false, tradable: true, state: 'ok', pnlToday: 0, positions: [] },
  { name: 'PROP-1', connection: 'connected', prop: true, sim: false, tradable: true, state: 'ok', pnlToday: 0, positions: [] },
  { name: 'PROP-2', connection: 'connected', prop: true, sim: false, tradable: true, state: 'ok', pnlToday: 0, positions: [] },
  { name: 'SIM-A', connection: 'connected', sim: true, tradable: true, state: 'ok', pnlToday: 0, positions: [] }] };
const groups = { type: 'groups', list: [{ id: 'g1', name: 'Sample evals', members: ['PROP-1', 'PROP-2'], accountType: 'eval' }] };
const agent = more => Object.assign({ type: 'agent', agent: 'demo', name: 'Demo Agent', build: 'sample-build-1', enabled: true, connected: true, mode: 'shadow', account: 'PROP-1', sim: false,
  killed: false, standDown: null, owns: false, lastBeatMs: 300, rules: { maxTrades: 2, maxLosses: 1, entryFrom: '09:40', entryUntil: '15:00', flatAt: '15:55' } }, more || {});
const bot = more => Object.assign({ type: 'bot', enabled: true, connected: true, name: 'Sample bot', mode: 'copilot', account: 'PROP-1', sim: false, killed: false, maxTrades: 2, maxLosses: 1, root: 'MNQ' }, more || {});

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('dialog', d => { pageErrors.push('a browser dialog: ' + d.message()); d.dismiss(); });
  await page.goto(pathToFileURL(file).href);
  const feed = m => page.evaluate(x => window.feed(x), m);
  const posted = () => page.evaluate(() => window.posted.map(m => Array.isArray(m) ? m[0] : m.type + (m.agent ? ':' + m.agent : '') + (m.mode ? ':' + m.mode : '') + (m.on !== undefined ? ':' + m.on : '') + (m.answer ? ':' + m.answer : '')));
  const clear = () => page.evaluate(() => { window.posted.length = 0; });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const L = '#lgd .lgd-agent', LB = '#lgd .lgd-bot';

  await feed({ type: 'hello', version: '0.6.21', features: ['v3'], instruments: [{ root: 'MNQ', tick: 0.25, pointValue: 2 }] });
  await feed({ type: 'trading', enabled: true, switches: { bot: true, agents: true } });
  await feed(accounts); await feed(groups); await feed(agent());
  await sleep(300);

  /* answers B4-2 item 4: a closed fold acknowledges nothing; shown but hidden acknowledges nothing; open and shown does */
  check(await page.evaluate(() => window.legion.state().shown === false), 'Legion\'s desk starts closed (shown only when its fold says so)');
  await feed(agent({ mode: 'copilot' }));
  await feed({ type: 'agentProposal', agent: 'demo', id: 'q1', at: Date.now(), account: 'PROP-1', sim: false, root: 'MNQ', side: 'buy', kind: 'limit', price: 25000, qty: 1, stopTicks: 12, targetTicks: 24, expireSec: 60, setup: 'Sample', reason: 'Sample: a made-up level', expiresAt: Date.now() + 60000, state: 'open', seenAt: null, answeredAt: null });
  await sleep(600);
  check(!(await posted()).some(x => /^agentSeen/.test(x)), 'a proposal while the fold is closed: no agentSeen: ' + JSON.stringify(await posted()));
  await page.evaluate(() => window.legion.show(true)); await sleep(400);
  check(!(await posted()).some(x => /^agentSeen/.test(x)), 'shown, but the fold still closed (nothing on screen): no agentSeen');
  check(await page.evaluate(() => { const b = [...document.querySelectorAll('.bt-props')].find(x => x.parentElement === document.body); return !!b && !b.classList.contains('ag-hide'); }), 'Legion\'s copy shown never hides the page\'s own Bot card (Praetorian\'s Agent desk is closed)');
  check(await page.evaluate(() => !document.querySelector('#lgd .ag-notes, #lgd .bt-notes')), 'nor moves the page\'s notes into itself');
  /* round 2, F3: open, but the desk's box is visibility:hidden, then opacity 0: still nothing seen */
  await page.evaluate(() => { const f = document.getElementById('fold'); f.style.visibility = 'hidden'; f.open = true; window.legion.show(true); }); await sleep(400);
  check(!(await posted()).some(x => /^agentSeen/.test(x)), 'round 2, F3: the fold open but visibility:hidden: no agentSeen');
  await page.evaluate(() => { const f = document.getElementById('fold'); f.style.visibility = ''; f.style.opacity = '0'; window.legion.show(true); }); await sleep(400);
  check(!(await posted()).some(x => /^agentSeen/.test(x)), 'round 2, F3: the fold open but opacity 0: no agentSeen');
  await page.evaluate(() => { document.getElementById('fold').style.opacity = ''; window.legion.show(true); }); await sleep(400);
  check((await posted()).filter(x => /^agentSeen:demo/.test(x)).length === 1, 'the fold opens: agentSeen once: ' + JSON.stringify(await posted()));
  await feed({ type: 'agentProposal', agent: 'demo', id: 'q1', at: Date.now(), account: 'PROP-1', sim: false, root: 'MNQ', side: 'buy', kind: 'limit', price: 25000, qty: 1, stopTicks: 12, targetTicks: 24, expireSec: 60, setup: 'Sample', reason: 'Sample', expiresAt: Date.now() + 60000, state: 'ended', end: 'withdrawn', seenAt: Date.now(), answeredAt: null });
  await feed(agent());
  await clear();
  /* answers B4-4, G4: the fold open and the desk shown, but the agent card scrolled off screen: no agentSeen; back in view: one */
  await feed(agent({ mode: 'copilot' }));
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await feed({ type: 'agentProposal', agent: 'demo', id: 'q2', at: Date.now(), account: 'PROP-1', sim: false, root: 'MNQ', side: 'sell', kind: 'limit', price: 25010, qty: 1, stopTicks: 12, targetTicks: 24, expireSec: 60, setup: 'Sample', reason: 'Sample: another made-up level', expiresAt: Date.now() + 60000, state: 'open', seenAt: null, answeredAt: null });
  await sleep(500); await page.evaluate(() => window.legion.show(true)); await sleep(300);
  check(!(await posted()).some(x => /^agentSeen/.test(x)), 'G4: the agent card scrolled off screen: no agentSeen: ' + JSON.stringify(await posted()));
  await page.evaluate(() => { window.scrollTo(0, 0); window.legion.show(true); }); await sleep(400);
  check((await posted()).filter(x => /^agentSeen:demo/.test(x)).length === 1, 'G4: scrolled back into view: agentSeen once: ' + JSON.stringify(await posted()));
  await feed({ type: 'agentProposal', agent: 'demo', id: 'q2', at: Date.now(), account: 'PROP-1', sim: false, root: 'MNQ', side: 'sell', kind: 'limit', price: 25010, qty: 1, stopTicks: 12, targetTicks: 24, expireSec: 60, setup: 'Sample', reason: 'Sample', expiresAt: Date.now() + 60000, state: 'ended', end: 'withdrawn', seenAt: Date.now(), answeredAt: null });
  await feed(agent());
  await clear();
  check(await page.evaluate(() => !document.querySelector('#lgd [data-act="popout"]') && !document.querySelector('.ws-top [data-parity]')), 'no Pop out in Legion\'s copies, and the page\'s top bar keeps no parity tags of theirs');
  await page.evaluate(() => window.prAgent.showTab(true));
  await sleep(400);

  check(await page.evaluate(() => window.legion.state().linked && window.legion.state().side === 'agent' && window.legion.state().shown), 'Legion\'s desk is mounted on its own link, the Agent side shown');
  check(await page.locator(L + ' [data-k="prWhy"]').isHidden(), 'a prop trader on Legion\'s desk: no hold-back line');
  check(/PROP-1 is a prop account/.test(await page.$eval('#prAg [data-k="prWhy"]', e => e.textContent)), 'the same trader on Praetorian\'s desk: held back');
  const dis = await page.evaluate(L2 => ({ auto: document.querySelector(L2 + ' [data-mode="auto"]').disabled, acct: document.querySelector(L2 + ' [data-k="acctOpen"]').disabled, rules: document.querySelector(L2 + ' [data-k="rulesOpen"]').disabled }), L);
  check(!dis.auto && !dis.acct && !dis.rules, 'Legion\'s desk offers his modes, account and rules: ' + JSON.stringify(dis));
  await page.screenshot({ path: path.join(SHOTS, 'legion-desk-agent.png') });
  await clear();
  await page.click(L + ' [data-mode="auto"]'); await sleep(500); await page.click(L + ' [data-mode="auto"]'); await sleep(200);
  check(JSON.stringify(await posted()) === JSON.stringify(['agentMode:demo:auto']), 'Auto from Legion\'s desk (its second click) goes: ' + JSON.stringify(await posted()));
  await clear();
  await page.evaluate(() => { for (const b of document.querySelectorAll('#prAg [data-k="modes"] button')) b.disabled = false; document.querySelector('#prAg [data-mode="copilot"]').click(); });
  await sleep(200);
  check((await posted()).length === 0, 'Copilot forced on Praetorian\'s desk for the prop trader: nothing goes');

  /* Legion's picker: prop accounts and the prop group, never your personal account or Sim */
  await page.click(L + ' [data-k="acctOpen"]');
  const opts = await page.$$eval(L + ' [data-k="acctSel"] option', os => os.map(o => ({ v: o.value, d: o.disabled, t: o.textContent })));
  const o = v => opts.find(x => x.v === v) || {};
  check(o('PROP-2').d === false && o('group:g1').d === false && o('').d === false, 'Legion\'s picker offers PROP-2, the prop group and None');
  check(o('MINE-1').d === true && /not on Legion/.test(o('MINE-1').t) && o('SIM-A').d === true, 'Legion\'s picker lists your personal account and Sim as not on Legion: ' + o('MINE-1').t);
  await page.click(L + ' [data-act="acctCancel"]');
  check(await page.evaluate(() => [...window.mem.keys()].some(k => k === 'legion-live-agent-chosen-v1') && [...window.mem.keys()].some(k => k === 'live-agent-chosen-v1')), 'each copy keeps its own chosen trader (a reload mixes nothing): ' + JSON.stringify(await page.evaluate(() => [...window.mem.keys()])));

  /* answers B4-2 item 6: the trader is in Auto (sent above); a move from Legion goes in Shadow first, the move after ChartBridge shows Shadow */
  await feed(agent({ mode: 'auto' })); await sleep(200); await clear();
  await page.click(L + ' [data-k="acctOpen"]');
  await page.selectOption(L + ' [data-k="acctSel"]', 'PROP-2');
  await page.click(L + ' [data-act="acctSave"]'); await sleep(200);
  if (await page.locator(L + ' [data-act="acctYes"]').isVisible()) {
    check(/in Shadow \(nothing is placed until you choose Copilot or Auto\)/.test(await page.$eval(L + ' [data-k="acctAsk"]', e => e.textContent)), 'the LIVE question names Shadow: ' + await page.$eval(L + ' [data-k="acctAsk"]', e => e.textContent));
    await page.click(L + ' [data-act="acctYes"]'); await sleep(200);
  }
  check(JSON.stringify(await posted()) === JSON.stringify(['agentMode:demo:shadow']), 'Shadow first, nothing else yet: ' + JSON.stringify(await posted()));
  check(/Shadow first, then the change/.test(await page.$eval(L + ' [data-k="acctWhy"]', e => e.textContent)), 'and the desk says so: ' + await page.$eval(L + ' [data-k="acctWhy"]', e => e.textContent));
  await feed(agent({ mode: 'shadow' })); await sleep(200);
  const mv = await page.evaluate(() => window.posted.filter(m => m.type === 'agentAccount'));
  check(mv.length === 1 && mv[0].account === 'PROP-2' && mv[0].keepMode === 'shadow', 'then the move, in Shadow: ' + JSON.stringify(mv));
  await feed(agent({ account: 'PROP-1' })); await sleep(100);

  /* a personal trader, the other way round */
  await feed(agent({ account: 'MINE-1', mode: 'shadow' }));
  await sleep(200);
  check(/trades your personal account: it is set up from Praetorian/.test(await page.$eval(L + ' [data-k="prWhy"]', e => e.textContent)), 'a personal trader on Legion\'s desk: held back, sent to Praetorian');
  check(await page.locator('#prAg [data-k="prWhy"]').isHidden(), 'and whole on Praetorian\'s');
  await clear();
  await page.evaluate(L2 => { for (const b of document.querySelectorAll(L2 + ' [data-k="modes"] button')) b.disabled = false; document.querySelector(L2 + ' [data-mode="copilot"]').click(); }, L);
  await sleep(200);
  check((await posted()).length === 0, 'the break: Copilot forced on Legion\'s desk for a personal trader sends nothing');
  await page.click(L + ' [data-k="kill"]'); await sleep(200);
  check(JSON.stringify(await posted()) === JSON.stringify(['agentKill:demo:true']), 'Kill switch ON from Legion\'s desk goes for anyone');

  /* answers B4-4, G3 on Legion's desk: a trader on None with a leftover seat on PROP-1: stops only, said; Off asks, "Flatten and
     turn off" sends Shadow, then the flatten of that seat only, then Off once flat */
  await page.evaluate(() => { Object.assign(window.helperState.demo, { on: true, running: true, why: 'on', runningBuild: 'sample-build-1' }); window.flattened.length = 0; window.helperCalls.length = 0; });
  const left = (mode, qty) => agent({ account: null, mode, killed: false, owns: !!qty, position: qty ? { root: 'MNQ', qty, avg: 25000 } : null, seats: [{ account: 'PROP-1', owns: !!qty, position: qty ? { root: 'MNQ', qty, avgPrice: 25000 } : null }] });
  await feed(left('auto', 1));
  await page.waitForFunction(() => window.helperCalls.includes('GET /status'), null, { timeout: 8000 }).catch(() => {});
  await sleep(3600);
  check(/a leftover position on a prop account: stop and flatten it first/.test(await page.$eval(L + ' [data-k="prWhy"]', e => e.textContent)), 'G3 (Legion): a leftover position: held back, with the words');
  await clear(); await page.evaluate(() => { window.fromLegion.length = 0; });
  await page.evaluate(L2 => { const b = document.querySelector(L2 + ' [data-k="hBtns"] [data-onoff="off"]'); b.disabled = false; b.click(); }, L);
  await page.waitForSelector(L + ' [data-act="hFlatOff"]', { state: 'visible', timeout: 5000 }).catch(() => {});
  await page.click(L + ' [data-act="hFlatOff"]').catch(() => {});
  await sleep(300);
  check(JSON.stringify(await page.evaluate(() => window.fromLegion)) === JSON.stringify(['agentMode']) && JSON.stringify(await posted()) === JSON.stringify(['agentMode:demo:shadow']), 'G3 (Legion): "Flatten and turn off" sends Shadow first: ' + JSON.stringify(await posted()));
  await feed(left('shadow', 1));
  await page.waitForFunction(() => window.flattened.length > 0, null, { timeout: 5000 }).catch(() => {});
  check(JSON.stringify(await page.evaluate(() => window.flattened)) === JSON.stringify(['PROP-1 MNQ']), 'G3 (Legion): then the flatten of that seat only (PROP-1 MNQ): ' + JSON.stringify(await page.evaluate(() => window.flattened)));
  await feed(agent({ account: null, mode: 'shadow', killed: false, owns: false, position: null, seats: [] }));
  await page.waitForFunction(() => window.helperCalls.includes('POST /off'), null, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => window.helperCalls.includes('POST /off')) && JSON.stringify(await posted()) === JSON.stringify(['agentMode:demo:shadow']), 'G3 (Legion): then Off once flat; nothing but Shadow was sent to ChartBridge');
  await page.evaluate(() => { Object.assign(window.helperState.demo, { on: false, running: false, why: 'off', runningBuild: null }); });
  await feed(agent({ account: 'PROP-1' }));

  /* the Bot side: the bot on a prop account in Copilot, a proposal */
  await page.click('#lgd .lgd-seg [data-side="bot"]');
  await feed(bot());
  await sleep(300);
  check(await page.locator(LB).isVisible() && await page.locator(L).isHidden(), 'the switch shows Legion\'s Bot side');
  check(await page.locator(LB + ' [data-k="prWhy"]').isHidden() && !(await page.evaluate(L2 => document.querySelector(L2 + ' [data-k="acctOpen"]').disabled, LB)), 'the bot on a prop account: whole on Legion\'s desk');
  await page.screenshot({ path: path.join(SHOTS, 'legion-desk-bot.png') });
  await clear();
  await feed({ type: 'botProposal', id: 'p1', at: Date.now(), account: 'PROP-1', sim: false, root: 'MNQ', side: 'buy', kind: 'limit', price: 25000, qty: 1, stopTicks: 12, targetTicks: 24, reason: 'Sample: a made-up level', state: 'open', seenAt: null, answeredAt: null });
  await sleep(1300);
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.bt-props')].map(b => (b.closest('.lgd') ? 'legion' : b.parentElement === document.body ? 'body' : 'other') + ':' + b.children.length));
  check(boxes.includes('legion:2') && boxes.filter(x => x.startsWith('body')).length === 1, 'Legion\'s copy keeps its proposal card inside its own desk; only Praetorian\'s floats over the page: ' + JSON.stringify(boxes));
  /* the copilot key: Praetorian's desks only (refused there for a prop bot); never Legion's copy */
  const prevented = await page.evaluate(() => { const e = new CustomEvent('chart-copilot-key', { cancelable: true, detail: { answer: 'accept' } }); document.dispatchEvent(e); return e.defaultPrevented; });
  await sleep(300);
  check(!(await posted()).some(x => /^botAnswer/.test(x)), 'the Accept key never answers through Legion\'s copy (Praetorian\'s refuses a prop bot): ' + JSON.stringify(await posted()) + ' prevented ' + prevented);
  /* Legion's own Accept button answers it */
  await page.click('#lgd .bt-props [data-ans="accept"]').catch(() => {});
  await sleep(300);
  check((await posted()).some(x => x === 'botAnswer:accept'), 'Legion\'s own Accept on its card answers the prop bot\'s proposal: ' + JSON.stringify(await posted()));

  /* the bot's Shadow (answers B4-2 item 3): a stop on both desks. On Praetorian the bot on a prop account is held back, Shadow offered and goes */
  await feed(bot({ mode: 'copilot' })); await page.evaluate(() => window.prBot.showTab(true)); await sleep(300); await clear();
  const prSh = await page.evaluate(() => ({ shadow: document.querySelector('#prBt [data-mode="shadow"]').disabled, auto: document.querySelector('#prBt [data-mode="auto"]').disabled }));
  check(!prSh.shadow && prSh.auto, 'Praetorian, the bot on a prop account: Shadow offered, Auto not: ' + JSON.stringify(prSh));
  await page.evaluate(() => document.querySelector('#prBt [data-mode="shadow"]').click()); await sleep(300);
  check((await posted()).includes('botMode:shadow'), 'Praetorian\'s Shadow goes for the prop bot: ' + JSON.stringify(await posted()));
  /* the bot on your personal account: held back on Legion (P11, B22), its Shadow offered and going */
  await feed(bot({ account: 'MINE-1', mode: 'copilot' })); await sleep(300); await clear();
  const held = await page.evaluate(L2 => ({ why: (document.querySelector(L2 + ' [data-k="prWhy"]') || {}).textContent || '', whyShown: !(document.querySelector(L2 + ' [data-k="prWhy"]') || { hidden: true }).hidden,
    auto: document.querySelector(L2 + ' [data-mode="auto"]').disabled, copilot: document.querySelector(L2 + ' [data-mode="copilot"]').disabled, shadow: document.querySelector(L2 + ' [data-mode="shadow"]').disabled,
    acct: document.querySelector(L2 + ' [data-k="acctOpen"]').disabled }), LB);
  check(held.whyShown && /On Legion the bot can only be stopped/.test(held.why) && /MINE-1, not a prop account/.test(held.why) && held.auto && held.copilot && held.acct && !held.shadow,
    'the bot on your personal account on Legion: the hold-back line, modes and Change account off, Shadow offered: ' + JSON.stringify(held));
  await page.click(LB + ' [data-mode="shadow"]'); await sleep(300);
  check((await posted()).includes('botMode:shadow'), 'Legion\'s Shadow goes for the bot on your personal account: ' + JSON.stringify(await posted()));
  /* a botSeen only while Legion's card is on screen: the fold closed, nothing */
  await page.evaluate(() => { document.getElementById('fold').open = false; window.legion.show(true); });   // told shown, but the fold is closed: nothing on screen
  await feed(bot({ account: 'PROP-1', mode: 'copilot' }));
  await feed({ type: 'botProposal', id: 'p1', at: Date.now(), account: 'PROP-1', sim: false, root: 'MNQ', side: 'buy', kind: 'limit', price: 25000, qty: 1, stopTicks: 12, targetTicks: 24, reason: 'Sample: a made-up level', state: 'accepted', seenAt: Date.now(), answeredAt: Date.now() });
  await sleep(1600); await clear(); await page.evaluate(() => { window.fromLegion.length = 0; });   // the ended card stays 1.2 s, then the next one shows
  await page.evaluate(() => window.prBot.showTab(false));
  await feed({ type: 'botProposal', id: 'p2', at: Date.now(), account: 'PROP-1', sim: false, root: 'MNQ', side: 'sell', kind: 'limit', price: 25010, qty: 1, stopTicks: 12, targetTicks: 24, reason: 'Sample: another made-up level', state: 'open', seenAt: null, answeredAt: null });
  await sleep(800);
  const legionSaid = () => page.evaluate(() => window.fromLegion.slice());
  check(!(await legionSaid()).includes('botSeen'), 'a bot proposal while Legion\'s fold is closed (the desk told it is shown): no botSeen from Legion\'s copy (Praetorian\'s floating card is the page\'s own): ' + JSON.stringify(await legionSaid()));
  /* answers B4-6, H2: the fold open and the desk shown, but the bot card scrolled up off screen: no botSeen */
  await page.evaluate(() => { document.getElementById('fold').open = true; window.scrollTo(0, document.body.scrollHeight); window.legion.show(true); });
  await sleep(600);
  check(!(await legionSaid()).includes('botSeen'), 'H2: the bot card scrolled off screen (fold open, desk shown): no botSeen: ' + JSON.stringify(await legionSaid()));
  await page.evaluate(() => { document.querySelector('#lgd .bt-props').scrollIntoView({ block: 'center' }); window.legion.show(true); });
  await sleep(600);
  check((await legionSaid()).filter(x => x === 'botSeen').length === 1, 'the fold opens with the card on screen: Legion\'s copy sends botSeen once: ' + JSON.stringify(await legionSaid()));

  check(!(await page.evaluate(() => window.posted.some(m => Array.isArray(m)))), 'nothing ever reached the feed\'s send or sendOrder');
  check(pageErrors.length === 0, 'no page errors: ' + pageErrors.join(' | '));
} finally {
  await browser.close();
}
console.log(errors.length ? errors.length + ' of ' + checks + ' checks FAILED' : 'all ' + checks + ' checks passed');
process.exit(errors.length ? 1 : 0);
