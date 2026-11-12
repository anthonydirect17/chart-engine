// Legion's trader desk (chart 1.49.0, live/legion-desk.js) in a browser, beside Praetorian, as the page will have them: the real
// Agent and Bot desks twice on one stand-in feed, Praetorian's on AgentCore.praetorianLink and Legion's mounted by
// LegionDesk.mount on AgentCore.legionLink. Made-up messages only: MINE-1 is the personal account, PROP-1 and PROP-2 prop,
// SIM-A Sim, group g1 two prop accounts.
//   npm run smoke:legion-desk      (CHROMIUM_PATH=/path/to/chrome; SHOTS=dir)
// Checks: a prop trader is whole on Legion's desk and held back on Praetorian's; Auto from Legion goes, forced on Praetorian
// nothing goes; Legion's picker offers prop accounts and the prop group, not your personal account or Sim; the bot on a prop
// account the same; the bot's proposal card of Legion's copy stays inside it; the copilot key never reaches Legion's copy;
// a personal trader the other way round. Screenshots: legion-desk-agent.png, legion-desk-bot.png.
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
const js = ['bot-core.js', 'agent-core.js', 'fleet.js', 'motion.js', 'agent-grid.js', 'bot.js', 'agent.js', 'legion-desk.js'].map(f => `<script src="${pathToFileURL(path.join(root, 'live', f))}"></script>`).join('\n');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">${css}
<style>html,body{margin:0}body{display:block;overflow:auto}#prAg,#prBt{display:none}</style></head>
<body><div class="ws-top"><span>SAMPLE DATA: made-up accounts and traders</span></div>
<section class="ag-view" id="prAg"></section><section class="bt-view" id="prBt"></section>
<div id="lgd" style="height:900px"></div>
${js}
<script>
  window.posted = []; window.subs = [];
  const AF = { listen: h => { window.subs.push(h); return () => {}; }, post: m => { window.posted.push(m); return true; }, send: m => { window.posted.push(['send', m]); return true; }, sendOrder: m => { window.posted.push(['order', m]); return true; }, limit: () => null };
  window.feed = m => { for (const h of window.subs) h.message(m); };
  const mem = new Map(), storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  const pr = window.AgentCore.praetorianLink(AF);
  window.prAgent = window.AgentDesk.create({ v3: pr, storage, els: { view: document.getElementById('prAg') }, onTab: () => {} });
  window.prBot = window.BotDesk.create({ v3: pr, storage, els: { view: document.getElementById('prBt') }, onTab: () => {} });
  window.legion = window.LegionDesk.mount(document.getElementById('lgd'), { v3: AF, storage });
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
  await page.evaluate(() => window.prAgent.showTab(true));
  await sleep(400);

  check(await page.evaluate(() => window.legion.state().linked && window.legion.state().side === 'agent'), 'Legion\'s desk is mounted on its own link, the Agent side shown');
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

  check(!(await page.evaluate(() => window.posted.some(m => Array.isArray(m)))), 'nothing ever reached the feed\'s send or sendOrder');
  check(pageErrors.length === 0, 'no page errors: ' + pageErrors.join(' | '));
} finally {
  await browser.close();
}
console.log(errors.length ? errors.length + ' of ' + checks + ' checks FAILED' : 'all ' + checks + ' checks passed');
process.exit(errors.length ? 1 : 0);
