// The Legion tab's view (drafted as Fleet; chart 1.45.0, live/fleet.js FleetView) in a browser, on its own: the real fleet.js and the page's real
// stylesheets, fed ChartBridge's messages through a stand-in for the window's v3 connection (listen and post). It checks what is
// drawn, the roster cards from a stand-in GET /roster, the Kill all question, and that exactly one message is ever sent, only
// after Yes. Every account, trader, bot and number is made up: sample data only.
//   npm run smoke:fleet      (CHROMIUM_PATH=/path/to/chrome; SHOTS=dir)
// Then the tab inside the whole workspace against the fake bridge (the button, one view at a time, a reload).
// The review of 92: a double click anywhere on Kill all sends nothing (STOP 1); a press, a message, a release still counts, on
// Kill all and on Yes, also under a stream of messages (STOP 2); hostile strings run nothing; a roster tag is never a P&L colour.
// Screenshots: fleet-roster-shut, fleet-banner, fleet-desktop, fleet-ask, fleet-answer, fleet-phone, fleet-empty, fleet-workspace (.png in test/out).
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

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'live', 'workspace.css'))}">
<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'live', 'fleet.css'))}">
<style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column}</style></head>
<body class="fl-on"><div class="ws-top"><span>SAMPLE DATA: made-up accounts and traders</span>
<button type="button" class="ws-btn fl-tabbtn" id="wsFleetTab" aria-pressed="false" hidden>Legion</button></div>
<section class="fl-view fl-in-ws" id="flView" aria-label="Legion tab"></section>
<script src="${pathToFileURL(path.join(root, 'live', 'order-ticket.js'))}"></script>
<script src="${pathToFileURL(path.join(root, 'live', 'agent-core.js'))}"></script>
<script src="${pathToFileURL(path.join(root, 'live', 'fleet.js'))}"></script>
<script>
  window.sent = []; window.subs = []; window.asked = []; window.rosterAnswer = { status: 404 };
  window.V3 = { listen: h => { window.subs.push(h); return () => {}; }, post: m => { window.sent.push(m); return true; } };
  window.feed = m => { for (const h of window.subs) h.message(m); };
  window.fleet = window.FleetView.create({ view: document.getElementById('flView'), tab: document.getElementById('wsFleetTab'), v3: window.V3, realClick: window.OrderTicket.realClick, onTab: on => { window.tabOn = on; },
    fetch: (url, opt) => { window.asked.push(url); const a = window.rosterAnswer; return a ? Promise.resolve({ status: a.status, json: () => Promise.resolve(a.body) }) : Promise.reject(new Error('down')); } });
</script></body></html>`;
const file = path.join(SHOTS, 'fleet-smoke.html');
fs.writeFileSync(file, html);

const accounts = { type: 'accounts', personalNamed: true, list: [
  { name: 'SAMPLE-MINE', connection: 'connected', personal: true, prop: false, pnlToday: 40, positions: [] },
  { name: 'SAMPLE-EVAL-1', connection: 'connected', prop: true, tradable: true, group: 'g1', pnlToday: 310, roomFloor: 3140, targetLeft: 1860, rules: { target: 3000, consistency: 40 }, positions: [{ root: 'MNQ', qty: 4 }] },
  { name: 'SAMPLE-EVAL-2', connection: 'connected', prop: true, tradable: true, group: 'g1', pnlToday: 1200, roomFloor: 2380, targetLeft: 520, rules: { target: 3000, consistency: 40 }, positions: [] },
  { name: 'SAMPLE-FUNDED-1', connection: 'connected', prop: true, tradable: true, group: 'g2', pnlToday: -155.5, roomFloor: 2620, targetLeft: null, rules: { target: null, consistency: null }, positions: [{ root: 'MNQ', qty: 2 }] },
  { name: 'SAMPLE-NEW-1', connection: 'connected', prop: true, group: null, pnlToday: 0, rules: null, positions: [] }] };
const groups = { type: 'groups', list: [{ id: 'g1', name: 'Sample evals', accountType: 'eval' }, { id: 'g2', name: 'Sample funded', accountType: 'funded' }] };
const agent = (id, more) => Object.assign({ type: 'agent', agent: id, name: id, build: 'sample build', enabled: true, connected: true, mode: 'auto', account: 'SAMPLE-EVAL-1',
  rules: { entryFrom: '09:40', entryUntil: '15:00', flatAt: '15:55' }, pnlToday: 0, trades: 0, killed: false, standDown: null, owns: false, lastBeatMs: 300 }, more || {});

/* made-up roster files in Bot-Lab's format (specrunner.roster/1 and specrunner.lineup/1): sample numbers only */
const scored = (ppd, above) => ({ plan: { size: '50K', dll: true },
  playbook: { eval: { risk_dollars: 400, daily_loss_stop: 800, daily_profit_stop: 1200, max_trades: 1 }, funded: { risk_dollars: 250, daily_loss_stop: null, daily_profit_stop: null, max_trades: 1, payout_at: 1500 } },
  numbers: { eval: { profit_per_dollar: ppd, range95: [ppd - 0.3, ppd + 0.3], no_edge: { median: 0.05, p5: -0.4, p95: 0.35 }, above_no_edge: above, not_searched_on: 0.2, eval_pass: 0.58, sessions_to_pass: 9 },
    funded: { profit_per_dollar: 0.1, range95: [-0.2, 0.4], no_edge: { median: 0.02, p5: -0.3, p95: 0.3 }, above_no_edge: false, not_searched_on: null, paid_per_funded: 1830.5, share_paid: 0.41, sessions_to_first_payout: 14 } },
  other_settings: { eval: [], funded: [] }, counts: {} });
const botFile = (bot, live, ppd, above) => Object.assign({ format: 'specrunner.roster/1', bot, spec: { file: bot + '.json', sha256: 'a'.repeat(64) }, runs_live: live, why_not: live ? null : 'a level trigger: the tape is proved whole only from its own first trade',
  record: { run_id: 'sample-run-7', family: 'sample', try: 3, sessions: 240, trades: 198, instrument: 'MNQ', verdict: 'sample verdict: not enough to call' } }, scored(ppd, above));
const rosterBody = { left: 0, files: [
  { name: 'sample-alpha.json', ok: true, roster: botFile('sample-alpha', true, 0.62, true), sha256: 'a'.repeat(64) },
  { name: 'sample-beta.json', ok: true, roster: botFile('sample-beta', false, 0.1, false) },
  { name: 'sample-pair.json', ok: true, roster: Object.assign({ format: 'specrunner.lineup/1', lineup: 'sample-pair', runs_live: false, joined: { sessions: 230, trades: 300, skipped: 12 },
      bots: ['sample-alpha', 'sample-beta'].map((b, i) => Object.assign({ taken: 150, skipped: 6, sessions_left_out: i * 10 }, (({ bot, spec, runs_live, why_not, record }) => ({ bot, spec, runs_live, why_not, record }))(botFile(b, i === 0, 0, false)))) }, scored(0.44, true)) },
  { name: 'sample-quick.json', ok: true, roster: Object.assign(botFile('sample-quick', true, 0.3, false), { counts: { quick: true } }) },
  { name: 'sample-wrong.json', ok: true, roster: (d => { d.playbook.eval.daily_loss_stop = '800'; return d; })(botFile('sample-wrong', true, 0.3, false)) },
  { name: 'broken.json', ok: false, why: 'not valid JSON' }] };

const X = '<img src=x onerror="window.ranScript=1">';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });
  page.on('dialog', d => { pageErrors.push('a browser dialog: ' + d.message()); d.dismiss(); });
  await page.goto(pathToFileURL(file).href);
  const feed = m => page.evaluate(x => window.feed(x), m);
  const text = sel => page.locator(sel).innerText();
  const sentN = () => page.evaluate(() => window.sent.length);
  const asking = () => page.evaluate(() => window.fleet.state().asking);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ARM = 650;                                             // just past the tab's 600 ms

  // before ChartBridge says anything the tab's button is hidden; an older ChartBridge keeps it hidden
  check(await page.locator('#wsFleetTab').isHidden(), 'the Legion button is hidden before ChartBridge says hello');
  await feed({ type: 'hello', version: '0.6.16', features: ['v3'] });
  check(await page.locator('#wsFleetTab').isHidden(), 'and with a ChartBridge before 0.6.17');
  await feed({ type: 'hello', version: '0.6.19', features: ['v3'] });
  check(await page.locator('#wsFleetTab').isVisible() && (await text('#wsFleetTab')) === 'Legion', 'shown with ChartBridge 0.6.19, named Legion');
  await page.click('#wsFleetTab');
  check(await page.evaluate(() => window.tabOn === true && window.fleet.shown()), 'a click opens the tab');
  check(await page.evaluate(() => document.querySelector('.fl-title').textContent) === 'Legion' && (await text('.fl-title')) === 'LEGION', 'the tab is titled Legion (in capitals by its look)');

  // the roster: an older ChartBridge is not asked; no folder set is said; then the cards
  check((await text('.fl-roster .fl-empty')).includes('The roster needs ChartBridge 0.6.20 or later (this one is 0.6.19)') && await page.evaluate(() => window.asked.length === 0), 'ChartBridge 0.6.19: the roster is not asked for, and the tab says which version it needs');
  await feed({ type: 'hello', version: '0.6.20', features: ['v3'] });
  await page.waitForFunction(() => window.fleet.state().roster.state === 'none');
  check((await text('.fl-roster .fl-empty')).includes('No roster folder is set on this PC') && await page.evaluate(() => window.asked.join() === '/roster'), 'ChartBridge 0.6.20 with no roster folder: one GET /roster, and the tab says the folder is not set');

  // nothing known yet: said plainly, and Kill all is not offered
  check((await text('.fl-box[aria-label="Prop accounts"] .fl-empty')).includes('No personal account is picked yet'), 'no accounts message yet: says how to pick the personal account');
  check(await page.locator('[data-do="ask"]').getAttribute('aria-disabled') === 'true', 'Kill all is not offered yet');
  await page.click('[data-do="ask"]', { force: true });      // Playwright will not click an aria-disabled button by itself; a person can
  check(await sentN() === 0 && (await text('.fl-said')).includes('Sign in to trading first'), 'a click on it sends nothing and says why');
  await page.screenshot({ path: path.join(SHOTS, 'fleet-empty.png') });

  await page.evaluate(b => { window.rosterAnswer = { status: 200, body: b }; }, rosterBody);
  await page.click('.fl-roster [data-do="roster"]');
  await page.waitForFunction(() => window.fleet.state().roster.state === 'ok');
  // one line a FAMILY with its settings inside (Legion Setup, chart 1.48.0); a lineup is a family of its own
  const fams = await page.locator('.fl-fam').evaluateAll(els => els.map(e => ({ key: e.dataset.fam, open: e.dataset.open === '1', head: e.querySelector('.fl-famrow').innerText.replace(/\s+/g, ' '), sets: e.querySelectorAll('.fl-set').length })));
  check(fams.length === 2 && fams.every(f => f.open), 'two families, open: ' + JSON.stringify(fams));
  const sam = fams.find(f => f.key === 'bot:sample'), pair = fams.find(f => f.key === 'lineup:sample-pair');
  check(sam && /^Sample BOT 3 settings best \+0\.62 58% not built yet in-sample, not proven Close$/i.test(sam.head) && sam.sets === 3, 'the Sample family: its settings counted, its best number, its best eval pass: ' + (sam && sam.head));
  check(pair && /^Sample pair LINEUP 1 setting/i.test(pair.head) && pair.sets === 1, 'the lineup is a family of its own: ' + (pair && pair.head));
  const lines = await page.locator('.fl-set').evaluateAll(els => els.map(e => ({ name: e.dataset.name, h: e.getBoundingClientRect().height, text: e.innerText.replace(/\s+/g, ' '), more: e.querySelectorAll('.fl-more').length })));
  check(lines.length === 4 && lines.every(l => l.h <= 80 && l.more === 0), 'each setting is one row (' + lines.map(l => Math.round(l.h)).join(', ') + ' px high) with no detail drawn');
  const al0 = lines.find(l => l.name === 'sample-alpha');
  check(al0 && /^Sample alpha risk \$400 eval, \$250 funded \+0\.62 \(\+0\.32 to \+0\.92\) ABOVE NO EDGE 58% not built yet 198 trades, 240 sessions; In-sample, not confirmed; try 3 Details$/i.test(al0.text), 'a setting: its readable name, its risk, ONE profit per $1 with its range and the file\'s word, eval pass, standing, in-sample and the try: ' + (al0 && al0.text));
  const rosterH = (await page.locator('.fl-roster').boundingBox()).height;
  check(rosterH < 560, 'the whole roster, two families open, is ' + Math.round(rosterH) + ' px high');
  await page.screenshot({ path: path.join(SHOTS, 'fleet-roster-shut.png') });
  for (const b of await page.locator('.fl-set [data-do="more"]').all()) await b.click();
  check(await page.locator('.fl-more').count() === 4 && (await page.locator('.fl-set [data-do="more"]').first().innerText()) === 'Hide', 'Details opens each setting');
  const cards = await page.locator('.fl-set').evaluateAll(els => els.map(e => ({ name: e.dataset.name, kind: e.dataset.kind, tone: e.dataset.tone || '', text: e.innerText.replace(/\s+/g, ' ') })));
  const byName = n => cards.find(c => c.name === n) || { text: '', tone: '' };
  const al = byName('sample-alpha').text, be = byName('sample-beta'), pr = byName('sample-pair'), qk = byName('sample-quick');
  check(!/DOES NOT/i.test(al) && al.includes('File sample-alpha.json, 50K with the daily loss limit') && al.includes('In-sample, not confirmed; try 3') && al.includes('Run sample-run-7: 240 sessions, 198 trades, MNQ'), 'a bot: its plan, its file, in-sample and its try count, its run: ' + al);
  check(al.includes("The run's own per-trade verdict (in-sample): sample verdict: not enough to call"), 'the file\'s free-text verdict is labelled as the run\'s own, in-sample');
  check(al.includes('Profit per $1: +0.62 (95%: +0.32 to +0.92)') && al.includes('No edge would show +0.05 (5th to 95th: -0.40 to +0.35)') && /ABOVE NO EDGE/i.test(al) && al.includes('Passes 58% of evals, in 9 sessions (median)'), 'its eval numbers beside the no-edge range');
  check(al.includes('Risk $400 a trade; day loss stop $800; day profit stop $1,200; at most 1 trade a day') && al.includes('Paid $1,830.50 per funded account; 41% reach a payout, the first in 14 sessions (median)') && al.includes('payout at $1,500') && /NOT ABOVE NO EDGE/i.test(al), 'the playbook it sizes with, and the funded stage, in Details');
  check(al.includes('the line shows the eval stage\'s'), 'its two stages differ in the file, and Details says the line shows the eval stage\'s');
  check(be.tone === 'notlive' && /DOES NOT RUN LIVE/i.test(be.text) && be.text.includes('Why not: a level trigger'), 'a bot the runner refuses says so and why');
  check(pr.tone === 'notlive' && pr.text.includes('Why not: sample-beta: a level trigger') && pr.text.includes('230 sessions in common, 300 trades taken, 12 skipped because another bot\'s trade was open') && pr.text.includes('In-sample, not confirmed; tries: sample-alpha 3, sample-beta 3'), 'the lineup: not live because one bot is not, its joined record, each bot\'s tries');
  check(qk.tone === 'notlive' && /QUICK LOOK: NEVER TRADED/i.test(qk.text) && /DOES NOT RUN LIVE/i.test(qk.text) && qk.text.includes('built with --quick'), 'a quick file is marked, and never reads as running live');
  check((await text('.fl-notshown')).includes('broken.json: not shown, not valid JSON') && (await text('.fl-notshown')).includes('sample-wrong.json: not shown, its playbook or its numbers are not in the format\'s shape'), 'a file ChartBridge did not serve, and one with a wrong-typed value, are listed with why');
  check((await text('.fl-roster')).includes('Every number is from in-sample runs, and none is a promise.') && !/confirmed\b(?!;)/i.test((await text('.fl-roster')).replace(/not confirmed/gi, '')), 'no line and no footer says "confirmed"');
  // the filters and Find: the file's own word only, sorted; nothing is invented on the page
  const setNames = () => page.locator('.fl-set').evaluateAll(els => els.map(e => e.dataset.name));
  check((await text('[data-k="allbtn"]')) === 'All (4)', 'All counts every file shown');
  await page.click('[data-do="filter"][data-filter="evals"]');
  check(JSON.stringify(await setNames()) === '["sample-alpha"]', 'Good for evals: only what runs live and the file marks above no edge for the eval: ' + JSON.stringify(await setNames()));
  await page.click('[data-do="filter"][data-filter="funded"]');
  check((await setNames()).length === 0 && (await text('.fl-roster')).includes('Nothing in the roster matches this filter.'), 'Good for funded: none here (no file marks its funded number above no edge), and it says so');
  await page.click('[data-do="filter"][data-filter="fits"]', { force: true });
  check(await page.locator('[data-do="filter"][data-filter="funded"][aria-pressed="true"]').count() === 1, 'Fits now does nothing until Market now exists (it says why on hover)');
  await page.click('[data-do="filter"][data-filter="all"]');
  await page.fill('[data-do="find"]', 'beta');
  check(JSON.stringify(await setNames()) === '["sample-beta"]' && await page.evaluate(() => document.activeElement && document.activeElement.dataset.do === 'find'), 'Find: by name or family, as typed, and the box keeps the focus');
  await page.fill('[data-do="find"]', '');
  check((await setNames()).length === 4, 'an empty Find shows all again');
  await page.click('.fl-fam[data-fam="bot:sample"] [data-do="fam"]');
  check(await page.locator('.fl-fam[data-fam="bot:sample"] .fl-set').count() === 0 && (await text('.fl-fam[data-fam="bot:sample"] [data-do="fam"]')) === 'Open 3', 'a family shuts to its one line');
  await page.click('.fl-fam[data-fam="bot:sample"] [data-do="fam"]');
  // a roster tag is never a P&L colour: both tags against both P&L colours, each resolved by the browser to the same form
  const colours = await page.evaluate(() => {
    const as = v => { const e = document.createElement('span'); e.style.color = 'var(' + v + ')'; document.body.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c; };
    const tag = (n, k) => getComputedStyle(document.querySelector('.fl-set[data-name="' + n + '"] .fl-tag[data-kind="' + k + '"]'));
    return { buy: as('--ws-buy'), sell: as('--ws-sell'), tags: [['sample-alpha', 'edge'], ['sample-beta', 'notlive'], ['sample-alpha', 'noedge']].map(([n, k]) => document.querySelector('.fl-set[data-name="' + n + '"] .fl-tag[data-kind="' + k + '"]') ? tag(n, k) : null).filter(Boolean).flatMap(t => [t.color, t.borderTopColor, t.backgroundColor]) };
  });
  check(/^rgb/.test(colours.buy) && /^rgb/.test(colours.sell) && colours.buy !== colours.sell && colours.tags.every(c => c !== colours.buy && c !== colours.sell), 'a roster tag is never green or red (text, border or fill): it is not a P&L: ' + JSON.stringify(colours));

  await feed({ type: 'trading', enabled: true });
  await feed(accounts); await feed(groups);
  await feed(agent('germanicus', { rules: { entryFrom: '09:40', entryUntil: '15:00', flatAt: '15:55', marketEntry: true, noTarget: true }, dayStop: 900, owns: true }));
  await feed(agent('manrae', { account: 'SAMPLE-MINE', mode: 'copilot' }));
  await feed(agent('resting', { account: 'SAMPLE-EVAL-2', standDown: "the day's profit stop is reached on SAMPLE-EVAL-2 ($1200, 40% of the profit target (the consistency rule); the day is at $1200, realized plus open): flat, and no new entries for agent resting until 18:00 ET" }));
  await feed({ type: 'agentStandDowns', list: [] });   // ChartBridge's end of the sign-in replay (answers 25, S1)

  check(!(await text('.fl-said')).includes('Sign in') && (await text('.fl-said')).includes('Kill all stops every trader on a prop account and closes its position there whole'), 'signed in: the reason it was not offered is gone, and the line says what Kill all touches');
  check((await text('.fl-autoline')) === 'In Auto on prop accounts: germanicus', 'the head line names the one trader in Auto on a prop account: ' + await text('.fl-autoline'));
  // the traders on no lane are under Other connections, folded
  check(/Other connections \(3\)/i.test(await text('.fl-others')) && await page.locator('.fl-trader').count() === 0, 'three traders on no lane, folded: ' + (await text('.fl-others')).slice(0, 80));
  await page.click('[data-do="others"]');
  const gt = await page.locator('.fl-trader[data-id="germanicus"]').innerText();
  check(gt.includes('AUTO ON PROP') && !/on duty/i.test(gt) && gt.includes('SAMPLE-EVAL-1') && gt.includes('09:40 to 15:00 New York, flat at 15:55') && gt.includes('In a trade'), 'germanicus: Auto on prop, its account, window and what it is doing');
  check(gt.includes('Market entry: on') && gt.includes('No target: on') && gt.includes('$900 (from its plan)'), 'its two entry switches are on and shown, and its day stop: ' + gt.replace(/\s+/g, ' '));
  const mt = await page.locator('.fl-trader[data-id="manrae"]').innerText();
  check(mt.includes('Market entry: off') && mt.includes('No target: off') && !mt.includes('AUTO ON PROP') && /personal/i.test(mt), 'manrae: both switches off, on the personal account, not counted');
  check((await page.locator('.fl-trader[data-id="resting"]').getAttribute('data-tone')) === 'standDown' && (await page.locator('.fl-trader[data-id="resting"]').innerText()).includes("Stood down: the day's profit stop is reached"), 'a trader stood down by the day stop says so');
  // PROP 3: a trader in Auto on a group with the personal account in it is named as the one Kill all will not stop
  await feed(agent('mixed', { account: null, group: { id: 'g9', name: 'Sample both' }, seats: [{ account: 'SAMPLE-MINE' }, { account: 'SAMPLE-EVAL-2' }] }));
  check((await text('.fl-autoline')).includes('In Auto on a group with your personal account in it (Kill all will NOT stop it: stop it on the Agent tab): mixed'), 'the head line names the trader Kill all will not stop: ' + await text('.fl-autoline'));
  await feed(agent('mixed', { mode: 'shadow', account: null }));

  await page.click('[data-do="sub"][data-sub="live"]');
  check(await page.locator('[data-k="setup"]').isHidden() && await page.locator('[data-k="live"]').isVisible() && await page.locator('[data-do="ask"]').isVisible() && await page.locator('[data-do="arm"]').isVisible(), 'Live: its own page, Kill all and Armed in the same head');
  const rows = await page.locator('.fl-table tbody tr').evaluateAll(trs => trs.map(tr => ({ name: tr.dataset.name, done: tr.classList.contains('fl-done'), cells: [...tr.cells].map(c => c.innerText.replace(/\s+/g, ' ').trim()) })));
  check(rows.map(r => r.name).join(',') === 'SAMPLE-EVAL-1,SAMPLE-EVAL-2,SAMPLE-FUNDED-1,SAMPLE-NEW-1', 'the prop accounts only (the personal account is not listed): ' + rows.map(r => r.name).join(','));
  const r1 = rows[0].cells, r2 = rows[1], r3 = rows[2].cells, r4 = rows[3].cells;
  check(r1[1] === '$1,140 of $3,000' && r1[2] === '$3,140' && r1[3] === '+$310' && r1[4] === "$310 of $900 (the plan's day stop)" && r1[5].startsWith('Long 4 MNQ'), 'eval 1: progress, cushion, today, the plan\'s day stop, its position: ' + r1.join(' | '));
  check(r2.done && r2.cells[4].startsWith('$1,200 of $1,200 (40% of the $3,000 target)') && /reached/i.test(r2.cells[4]), 'eval 2: at the consistency mark: reached: ' + r2.cells[4]);
  check(r3[0].includes('Funded') && r3[3] === '-$155.50' && r3[4] === 'none (funded, and no plan value)', 'funded: no mark without a plan value: ' + r3.join(' | '));
  check(r4[0].includes('In no group: the runner sizes it 0'), 'an account in no group says why it would be sized 0');
  const pnl = await page.evaluate(() => ['SAMPLE-EVAL-1', 'SAMPLE-FUNDED-1'].map(n => getComputedStyle(document.querySelector('.fl-table tbody tr[data-name="' + n + '"] .fl-pnl')).color));
  check(pnl[0] === colours.buy && pnl[1] === colours.sell, 'Today is green when up and red when down (the only green and red on the tab): ' + pnl.join(' '));
  check((await text('.fl-later')).includes('Legion Live (the tiles, one chart with each lane\'s marks, each trader\'s day, the accounts by group) is the next change'), 'Live says what comes next, not faked');
  await page.click('[data-do="sub"][data-sub="setup"]');
  check((await text('.fl-market')).includes('Not built yet.'), 'Market now says it is not built yet, not faked');
  // nothing on the tab can be pressed, typed in or switched but Kill all with its two answers, the Armed switch with its two, Read again and the Details
  const pressable = await page.evaluate(() => [...document.querySelectorAll('#flView button, #flView input, #flView select, #flView textarea, #flView a, #flView [tabindex], #flView [contenteditable], #flView [role="switch"], #flView [role="checkbox"], #flView [role="slider"], #flView label, #flView summary')].map(e => e.tagName + ':' + (e.dataset.do || '?')).sort());
  check(pressable.join() === 'BUTTON:arm,BUTTON:armno,BUTTON:armyes,BUTTON:ask,BUTTON:fam,BUTTON:fam,BUTTON:filter,BUTTON:filter,BUTTON:filter,BUTTON:filter,BUTTON:more,BUTTON:more,BUTTON:more,BUTTON:more,BUTTON:no,BUTTON:others,BUTTON:roster,BUTTON:sub,BUTTON:sub,BUTTON:yes,INPUT:find,LABEL:?', 'the tab has Kill all, the Armed switch, their Yes and Cancel, Read again and a Details on each card, and no other control: ' + pressable.join());
  await page.screenshot({ path: path.join(SHOTS, 'fleet-desktop.png') });

  // the head is pinned: scrolled to the bottom of the tab, Kill all is still in sight
  await page.evaluate(() => { const v = document.getElementById('flView'); v.scrollTop = v.scrollHeight; });
  const pinned = await page.evaluate(() => { const v = document.getElementById('flView'), b = document.querySelector('[data-do="ask"]').getBoundingClientRect(), r = v.getBoundingClientRect(); return { scrolled: v.scrollTop, top: b.top - r.top, hit: document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === document.querySelector('[data-do="ask"]') }; });
  check(pinned.scrolled > 50 && pinned.top >= 0 && pinned.top < 40 && pinned.hit, 'scrolled down ' + pinned.scrolled + ' px, Kill all is still at the top and can be clicked');
  // ---- STOP 2: the head is built once. A press, a message, a release still counts, on Kill all and on Yes
  await page.evaluate(() => { window.killNode = document.querySelector('[data-do="ask"]'); window.yesNode = document.querySelector('[data-do="yes"]'); });
  const centre = async sel => { const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  let [kx, ky] = await centre('[data-do="ask"]');
  await page.mouse.move(kx, ky); await page.mouse.down();
  await feed(agent('germanicus', { owns: false })); await feed(Object.assign({}, accounts, { tickle: 1 })); await feed({ type: 'status', level: 'info', text: 'sample status' });
  await page.mouse.up();
  check(await asking() && await sentN() === 0, 'a press on Kill all, three messages, a release: the question opens (the click is not lost)');
  check(await page.evaluate(() => document.activeElement && document.activeElement.dataset.do === 'no'), 'the focus is on Cancel');
  await feed(agent('germanicus', { owns: true }));
  check(await page.evaluate(() => document.activeElement && document.activeElement.dataset.do === 'no'), 'and stays there when a message arrives');
  await page.screenshot({ path: path.join(SHOTS, 'fleet-ask.png') });
  await sleep(ARM);
  let [yx, yy] = await centre('[data-do="yes"]');
  await page.mouse.move(yx, yy); await page.mouse.down();
  await feed(Object.assign({}, accounts, { tickle: 2 })); await feed(agent('germanicus', { owns: false }));
  await page.mouse.up();
  let sent = await page.evaluate(() => window.sent);
  check(sent.length === 1 && sent[0].type === 'agentKillAllProp' && typeof sent[0].cid === 'string' && Object.keys(sent[0]).sort().join(',') === 'cid,type', 'a press on Yes, two messages, a release: exactly one message, agentKillAllProp with a cid and nothing else: ' + JSON.stringify(sent));
  check(await page.evaluate(() => window.killNode === document.querySelector('[data-do="ask"]') && window.yesNode === document.querySelector('[data-do="yes"]') && document.body.contains(window.killNode)), 'the Kill all and Yes buttons are the same elements after all of it: the head is never rebuilt');
  check(/^\d\d:\d\d:\d\d\s+Kill all sent: waiting for ChartBridge's answer$/.test(await text('.fl-answer')), 'and the tab says it was sent, with the time, claiming nothing: ' + await text('.fl-answer'));
  await feed({ type: 'status', level: 'warn', text: 'Kill all (prop accounts): agent germanicus on SAMPLE-EVAL-1: flattening what it owns, the kill switch on, mode shadow. The bot, the copier and manual orders are never touched' });
  check(/^\d\d:\d\d:\d\d\s+Kill all \(prop accounts\): agent germanicus/.test(await text('.fl-answer')) && await page.locator('.fl-answer.bad').count() === 0, "ChartBridge's own words are shown with the time in front");

  // the same under a stream of messages at more than the rate PROTOCOL states (6 traders a second and accounts: here 20 a second)
  await page.evaluate(({ a, acc }) => { let i = 0; window.stream = setInterval(() => { i++; window.feed(Object.assign({}, a, { agent: 'germanicus', owns: i % 2 === 0 })); if (i % 3 === 0) window.feed(Object.assign({}, acc, { tickle: i })); }, 50); }, { a: agent('germanicus'), acc: accounts });
  let opened = 0, got = 0;
  const rosterDraws = await page.evaluate(() => window.fleet.state().draws.roster);
  for (let i = 0; i < 12; i++) {
    const before = await sentN();
    [kx, ky] = await centre('[data-do="ask"]');
    await page.mouse.move(kx, ky); await page.mouse.down(); await sleep(i % 2 ? 150 : 90); await page.mouse.up();
    if (await asking()) opened++;
    await sleep(ARM);
    [yx, yy] = await centre('[data-do="yes"]');
    await page.mouse.move(yx, yy); await page.mouse.down(); await sleep(i % 2 ? 150 : 90); await page.mouse.up();
    if (await sentN() === before + 1) got++;
  }
  await page.evaluate(() => clearInterval(window.stream));
  check(opened === 12 && got === 12, 'under 20 messages a second, mouse held 90 and 150 ms: Kill all opened the question ' + opened + ' of 12 times and Kill all then Yes sent ' + got + ' of 12');
  check(await page.evaluate(() => window.fleet.state().draws.roster) === rosterDraws, 'and the roster was not drawn again by any of those messages');
  await feed({ type: 'status', level: 'warn', text: 'Kill all (prop accounts): agent germanicus: stopped. Agent resting: NOT STOPPED, still trading its prop accounts' });
  const badStyle = await page.evaluate(() => { const e = document.querySelector('.fl-answer'), h = document.querySelector('.fl-said'); return { bad: e.classList.contains('bad'), w: +getComputedStyle(e).fontWeight, size: parseFloat(getComputedStyle(e).fontSize), hint: parseFloat(getComputedStyle(h).fontSize), colour: getComputedStyle(e).color, muted: getComputedStyle(h).color }; });
  check(badStyle.bad && badStyle.w >= 600 && badStyle.size > badStyle.hint && badStyle.colour !== badStyle.muted, 'an answer holding NOT STOPPED is marked: heavier, larger and not the muted colour: ' + JSON.stringify(badStyle));
  await page.screenshot({ path: path.join(SHOTS, 'fleet-answer.png') });
  await page.click('[data-do="ask"]'); await sleep(ARM); await page.click('[data-do="no"]');
  check(await page.locator('.fl-answer.bad').count() === 1 && (await text('.fl-answer')).includes('NOT STOPPED'), 'and the NOT STOPPED answer is still there after a new question and Cancel');

  // ---- STOP 1: a double click anywhere on Kill all sends nothing, at every width
  for (const width of [1440, 1024, 700, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const base = await sentN(); let stayed = 0;
    for (let i = 0; i < 10; i++) {
      const b = await page.locator('[data-do="ask"]').boundingBox();
      await page.mouse.dblclick(b.x + 2 + (b.width - 4) * i / 9, b.y + b.height / 2);
      if (await asking()) stayed++;
      // where the first button was, the question now has Cancel (or nothing), never Yes
      const under = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); const btn = e && e.closest('button'); return btn ? btn.dataset.do : ''; }, [b.x + 2 + (b.width - 4) * i / 9, b.y + b.height / 2]);
      if (under === 'yes') errors.push('at ' + width + ' px, point ' + i + ': Yes is drawn where Kill all was');
      await sleep(ARM); await page.click('[data-do="no"]');
    }
    check(await sentN() === base && stayed === 10, 'at ' + width + ' px: a double click at 10 points across Kill all sent nothing, and the question stayed up for a real answer (' + stayed + ' of 10)');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // the Kill all button, Yes and Cancel keep their place whatever the line under the title says (the second look, PROP A)
  for (const width of [1440, 1024, 700, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const box = sel => page.evaluate(q => { const r = document.querySelector(q).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(); }, sel);
    const k0 = await box('[data-do="ask"]');
    await page.click('[data-do="ask"]');
    const y0 = await box('[data-do="yes"]'), c0 = await box('[data-do="no"]');
    for (const id of ['mixa', 'mixb', 'mixc']) await feed(agent(id, { account: null, group: { id: 'g9', name: 'Sample both' }, seats: [{ account: 'SAMPLE-MINE' }, { account: 'SAMPLE-EVAL-2' }] }));
    const long = (await text('.fl-autoline')).length;
    const y1 = await box('[data-do="yes"]'), c1 = await box('[data-do="no"]');
    await sleep(ARM); await page.click('[data-do="no"]');
    const k1 = await box('[data-do="ask"]');
    check(long > 150 && k0 === k1 && y0 === y1 && c0 === c1, 'at ' + width + ' px: a line of ' + long + ' characters under the title moves neither Kill all (' + k0 + ' / ' + k1 + ') nor Yes nor Cancel');
    for (const id of ['mixa', 'mixb', 'mixc']) await feed(agent(id, { mode: 'shadow', account: null }));
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // each guard by itself: too soon; then a person in a hurry
  await page.click('[data-do="ask"]');
  const n0 = await sentN();
  await page.click('[data-do="yes"]');
  check(await sentN() === n0 && await asking() && (await text('.fl-said')) === 'Too soon: read the question, then click Yes.', 'Yes at once after the question opens: nothing sent, the question still up, and the tab says why');
  await sleep(ARM); await page.click('[data-do="no"]');
  // Yes clicked again and again from the moment the question opens (the browser counts them as one multiple click): it sends
  // once, soon after 600 ms (the second look, FIX B)
  for (const gap of [150, 250, 400]) {
    const before = await sentN();
    await page.click('[data-do="ask"]');
    const t0 = Date.now(); let at = 0;
    const [hx, hy] = await centre('[data-do="yes"]');
    for (let n = 1; n <= 12 && !at; n++) { await sleep(gap); await page.mouse.click(hx, hy, { clickCount: n + 1 }); if (await sentN() > before) at = Date.now() - t0; }
    check(await sentN() === before + 1 && at >= 600 && at < 600 + gap + 400, 'Yes clicked every ' + gap + ' ms from the moment the question opens: sent once, ' + at + ' ms after it opened');
    await feed({ type: 'status', level: 'warn', text: 'Kill all (prop accounts): sample answer' });
  }
  const n1 = await sentN();
  await page.click('[data-do="ask"]'); await sleep(ARM); await page.click('[data-do="no"]');
  check(!(await asking()) && await sentN() === n1, 'Cancel: the question goes, nothing sent');
  // Yes takes a real click only (Anthony 2026-11-11): the keyboard can open the question and cancel it, never confirm it
  await page.locator('[data-do="ask"]').focus(); await page.keyboard.press('Enter');
  check(await asking() && await page.evaluate(() => document.activeElement.dataset.do === 'no'), 'Enter on Kill all opens the question, the focus on Cancel');
  await sleep(ARM);
  await page.keyboard.press('Shift+Tab');
  check(await page.evaluate(() => document.activeElement.dataset.do === 'yes'), 'Shift+Tab reaches Yes');
  await page.keyboard.press('Enter'); await page.keyboard.press('Space'); await page.keyboard.press('Enter');
  check(await sentN() === n1 && await asking() && (await text('.fl-said')).includes('confirmed by a click on Yes only, not by keyboard'), 'Enter and Space on Yes send nothing, and the tab says Yes is a click only');
  await page.keyboard.press('Escape');
  check(!(await asking()) && await sentN() === n1, 'Escape cancels');
  await page.locator('[data-do="ask"]').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  check(!(await asking()) && await sentN() === n1, 'Enter on Cancel cancels, at once');
  await page.locator('[data-do="ask"]').focus(); await page.keyboard.press('Enter'); await sleep(ARM);
  await page.evaluate(() => document.querySelector('[data-do="yes"]').click());      // a click made by script, as a key's is
  check(await sentN() === n1, 'a click on Yes made by script sends nothing');
  await page.click('[data-do="yes"]');
  check(await sentN() === n1 + 1, 'and a real click on the same question sends');
  await feed({ type: 'status', level: 'warn', text: 'Kill all (prop accounts): sample answer' });
  // a refusal is shown too
  await page.click('[data-do="ask"]'); await sleep(ARM); await page.click('[data-do="yes"]');
  const cid = await page.evaluate(() => window.sent[window.sent.length - 1].cid);
  await feed({ type: 'reject', cid, reason: 'this connection may not trade; reload ChartBridge\'s page' });
  check((await text('.fl-answer')).includes('ChartBridge refused Kill all: this connection may not trade') && await page.locator('.fl-answer.bad').count() === 1, 'a refusal from ChartBridge is shown as one');
  check(await page.evaluate(() => window.sent.every(m => m.type === 'agentKillAllProp' && Object.keys(m).sort().join() === 'cid,type')), 'nothing but Kill all was ever sent');
  check(await page.evaluate(() => window.asked.every(u => u === '/roster')), 'and nothing but GET /roster was ever asked for');

  // ---- D2: the lanes, the pick and the one Armed switch (ChartBridge 0.6.21). Sample traders, sample accounts, sample files
  const d2from = await sentN();
  const sentD2 = () => page.evaluate(n => window.sent.slice(n), d2from);
  const laneRules = { roots: ['NQ', 'MNQ'], entryFrom: '09:40', entryUntil: '15:55', flatAt: '15:55', marketEntry: true, noTarget: true };
  const lane1 = more => agent('legion1', Object.assign({ mode: 'shadow', account: null, group: { id: 'g1', name: 'Sample evals' }, seats: [{ account: 'SAMPLE-EVAL-1' }, { account: 'SAMPLE-EVAL-2' }], rules: laneRules, pick: 'sample-alpha.json' }, more || {}));
  const lane2 = more => agent('legion2', Object.assign({ mode: 'shadow', account: null, group: { id: 'g2', name: 'Sample funded' }, seats: [{ account: 'SAMPLE-FUNDED-1' }], rules: laneRules }, more || {}));
  const armAsking = () => page.evaluate(() => window.fleet.state().arm.asking);
  await page.evaluate(b => { window.rosterAnswer = { status: 200, body: b }; }, rosterBody);
  await feed({ type: 'hello', version: '0.6.21' }); await feed({ type: 'trading', enabled: true }); await feed(accounts); await feed(groups);
  await feed(lane1()); await feed(lane2()); await feed({ type: 'agentStandDowns', list: [] });   // ChartBridge's end of the sign-in replay (answers 25, S1)
  await page.waitForFunction(() => window.fleet.state().roster.state === 'ok' && window.fleet.state().lanes[0].armable === true);
  // the review of 94, FIX 2: a trader in Auto on a prop account outside the lanes (germanicus, from above) is named at the switch
  check((await text('[data-do="arm"]')) === 'Armed: PARTLY' && /Not a lane, so not armed from here: germanicus on a prop account; resting on a prop account in Auto/.test(await text('.fl-armsaid')), 'a trader in Auto outside the lanes: Armed reads PARTLY and names it: ' + await text('.fl-armsaid'));
  await feed(agent('germanicus', { mode: 'shadow' }));
  await feed(agent('resting', { mode: 'shadow', account: 'SAMPLE-EVAL-2' }));   // a stood-down trader in Auto counts too (the re-review of 94, R3)
  const laneText = await page.evaluate(() => [...document.querySelectorAll('.fl-lane')].map(e => e.innerText.replace(/\s+/g, ' ')));
  check(laneText.length === 2 && /^Eval lane Goal: pass the eval SHADOW READY legion1, group Sample evals Bot /i.test(laneText[0]) && laneText[0].includes('Sample alpha BOT risk $400 a trade Watching +$1,510'), 'the eval lane: its goal, its mode, Ready, its trader and group, the picked bot with its risk, its state and today on its accounts: ' + laneText[0]);
  check(/^Funded lane Goal: reach the payout SHADOW NOT READY legion2, group Sample funded Bot /i.test(laneText[1]) && laneText[1].includes('No bot is picked for this lane. A second bot on a lane comes as a lineup file from the Lab.') && laneText[1].includes('No bot is picked for it'), 'the funded lane: not ready, and why: ' + laneText[1]);
  const offered = await page.evaluate(() => [...document.querySelectorAll('#flPick-eval option')].map(o => o.value + (o.selected ? '*' : '')));
  check(offered.join() === ',sample-alpha.json*', 'the pick list offers None and only the files that run live, with ChartBridge\'s pick chosen: ' + offered.join());
  const order = await page.evaluate(() => [...document.querySelectorAll('#flView [data-k="setup"] > section')].map(e => e.getAttribute('aria-label')));
  check(order.join() === 'Market now,Today,Roster,Other connections', 'Setup, top to bottom: Market now, Today (the lanes), the Roster, Other connections: ' + order.join());
  check((await text('[data-do="arm"]')) === 'Armed: off' && await page.locator('#flView [role="switch"]').count() === 1 && await page.locator('[data-do="arm"]').getAttribute('aria-checked') === 'false', 'one Armed switch, off');
  await page.evaluate(() => { document.getElementById('flView').scrollTop = 0; });
  await page.screenshot({ path: path.join(SHOTS, 'fleet-lanes.png') });
  // a double click anywhere on the switch arms nothing, at every width; where the switch was, the question has Cancel, never Yes
  for (const width of [1440, 1024, 700, 390]) {
    await page.setViewportSize({ width, height: 900 });
    let stayed = 0;
    for (let i = 0; i < 10; i++) {
      const b = await page.locator('[data-do="arm"]').boundingBox();
      const pt = [b.x + 2 + (b.width - 4) * i / 9, b.y + b.height / 2];
      await page.mouse.dblclick(pt[0], pt[1]);
      if (await armAsking()) stayed++;
      const under = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); const btn = e && e.closest('button'); return btn ? btn.dataset.do : ''; }, pt);
      if (under !== 'armno') errors.push('at ' + width + ' px, point ' + i + ': under the switch\'s place the question has ' + (under || 'nothing') + ', not Cancel');
      await sleep(ARM); await page.click('[data-do="armno"]');
    }
    check((await sentD2()).length === 0 && stayed === 10, 'at ' + width + ' px: a double click at 10 points across the Armed switch sent nothing, and the question stayed up (' + stayed + ' of 10)');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // a press, messages, a release: the click is not lost, on the switch and on its Yes; the switch is never rebuilt
  await page.evaluate(() => { window.armNode = document.querySelector('[data-do="arm"]'); });
  let [ax, ay] = await centre('[data-do="arm"]');
  await page.mouse.move(ax, ay); await page.mouse.down();
  await feed(lane1({ pnlToday: 5 })); await feed(Object.assign({}, accounts, { tickle: 5 })); await feed(lane2({ pnlToday: 6 }));
  await page.mouse.up();
  check(await armAsking() && (await sentD2()).length === 0 && await page.evaluate(() => document.activeElement && document.activeElement.dataset.do === 'armno'), 'a press on the switch, three messages, a release: the question opens, nothing sent, the focus on Cancel');
  check((await text('.fl-armask')).startsWith('Arm? Eval lane: legion1 goes to Auto and trades sample-alpha on 2 accounts. Funded lane: stays off (No bot is picked for it).'), 'the question says what each lane will do: ' + await text('.fl-armask'));
  await page.screenshot({ path: path.join(SHOTS, 'fleet-arm-ask.png') });
  await page.click('[data-do="armyes"]');
  check((await sentD2()).length === 0 && await armAsking() && (await text('.fl-armsaid')).endsWith('Too soon: read the question, then click Yes.'), 'Yes at once: nothing sent, and the tab says why');
  await page.focus('[data-do="armyes"]'); await sleep(ARM); await page.keyboard.press('Enter'); await page.keyboard.press('Space');
  check((await sentD2()).length === 0 && (await text('.fl-armsaid')).includes('confirmed by a click on Yes only, not by keyboard'), 'Enter and Space on Yes arm nothing');
  await page.evaluate(() => document.querySelector('[data-do="armyes"]').click());
  check((await sentD2()).length === 0, 'a click on Yes made by script arms nothing');
  let [yx2, yy2] = await centre('[data-do="armyes"]');
  await page.mouse.move(yx2, yy2); await page.mouse.down();
  await feed(lane1({ pnlToday: 7 })); await feed(Object.assign({}, accounts, { tickle: 6 }));
  await page.mouse.up();
  let d2 = await sentD2();
  check(d2.length === 1 && d2[0].type === 'agentMode' && d2[0].agent === 'legion1' && d2[0].mode === 'auto' && Object.keys(d2[0]).sort().join() === 'agent,cid,mode,pick,pickSha,type' && d2[0].pick === 'sample-alpha.json' && d2[0].pickSha === 'a'.repeat(64), 'a press on Yes, two messages, a release: exactly one message, Auto for the one ready lane: ' + JSON.stringify(d2));
  check((await text('[data-do="arm"]')) === 'Armed: off', 'the switch does not move by itself: it waits for ChartBridge');
  await feed(lane1({ mode: 'auto' }));
  const onLook = await page.evaluate(() => { const b = document.querySelector('[data-do="arm"]'); return { text: b.textContent, checked: b.getAttribute('aria-checked'), same: b === window.armNode, colour: getComputedStyle(b).color, sel: document.querySelector('#flPick-eval').disabled }; });
  check(onLook.text === 'Armed: ON' && onLook.checked === 'true' && onLook.same && onLook.sel === true, 'ChartBridge says Auto: the switch reads ON, it is the same element, and the lane\'s pick list is locked');
  check(onLook.colour !== colours.buy && onLook.colour !== colours.sell, 'the switch is never a P&L colour: ' + onLook.colour);
  await page.screenshot({ path: path.join(SHOTS, 'fleet-armed.png') });
  // a mode changed somewhere else (the Agent tab, Kill all, 17:00) shows here: the other lane in Auto while not ready is "partly"
  await feed(lane2({ mode: 'auto' }));
  check((await text('[data-do="arm"]')) === 'Armed: PARTLY' && (await text('.fl-armsaid')).includes('A click switches every lane off'), 'a lane in Auto that is not ready reads as partly, and says what a click does');
  // off: one click, no question, Shadow for both
  await page.click('[data-do="arm"]');
  d2 = await sentD2();
  check(d2.length === 3 && d2.slice(1).map(m => m.agent + ':' + m.mode).join() === 'legion1:shadow,legion2:shadow' && !(await armAsking()), 'one click on the switch sends Shadow for both lanes, with no question: ' + JSON.stringify(d2.slice(1)));
  await feed(lane1()); await feed(lane2());
  check((await text('[data-do="arm"]')) === 'Armed: off', 'and ChartBridge\'s Shadow reads as off');
  // the pick: chosen in the list, sent as agentPick; a refusal is said and the list shows ChartBridge's pick again
  await page.selectOption('#flPick-funded', 'sample-alpha.json');
  d2 = await sentD2();
  check(d2.length === 4 && d2[3].type === 'agentPick' && d2[3].agent === 'legion2' && d2[3].file === 'sample-alpha.json' && Object.keys(d2[3]).sort().join() === 'agent,cid,file,type', 'choosing a file in the funded lane sends one agentPick: ' + JSON.stringify(d2[3]));
  check(await page.evaluate(() => document.querySelector('#flPick-funded').value === ''), 'the list goes back to ChartBridge\'s pick until ChartBridge says otherwise');
  await feed({ type: 'reject', cid: d2[3].cid, reason: 'sample refusal' });
  check((await text('.fl-armsaid')).includes('ChartBridge refused the pick for legion2: sample refusal') && await page.locator('.fl-armsaid.bad').count() === 1, 'a refused pick is said, marked');
  await feed(lane2({ pick: 'sample-alpha.json' }));
  check(await page.evaluate(() => document.querySelector('#flPick-funded').value === 'sample-alpha.json' && window.fleet.state().lanes[1].armable === true), 'ChartBridge\'s own word moves the list, and the lane is ready');
  // Escape anywhere on the page cancels a question while the tab is open
  await page.click('[data-do="arm"]'); await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press('Escape');
  check(!(await armAsking()), 'Escape with the focus nowhere in the tab cancels the Armed question');
  await page.click('[data-do="ask"]'); await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press('Escape');
  check(!(await asking()), 'and the Kill all question');
  check(await page.evaluate(n => window.sent.slice(n).every(m => window.FleetCore.maySend(m) && (m.type === 'agentMode' || m.type === 'agentPick')), d2from) && (await sentD2()).length === 4, 'the lanes sent four messages in all, each one the gate passes: one Auto, two Shadow, one pick');
  // the lanes at a phone's width: one column, the switch and its answers in sight
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await page.evaluate(() => { const g = getComputedStyle(document.querySelector('.fl-lanegrid')).gridTemplateColumns.split(' ').length, b = document.querySelector('[data-do="arm"]').getBoundingClientRect(); return { cols: g, right: b.right, w: document.documentElement.clientWidth }; });
  check(narrow.cols === 1 && narrow.right <= narrow.w, 'at 390 px the lanes are one column and the switch is inside the window');
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---- hostile strings in every field of the roster and of ChartBridge's own messages: nothing runs, nothing is injected
  await page.evaluate(({ X, body }) => {
    const j = JSON.parse(JSON.stringify(body));
    const a = j.files[0].roster; a.runs_live = false; a.why_not = X; a.record.run_id = X; a.record.verdict = X; a.record.instrument = X; a.plan.size = X;
    const l = j.files[2].roster; l.bots[1].why_not = X; l.bots[0].record.run_id = X;
    j.files.push({ name: X, ok: false, why: X }); j.files[0].name = X + '.json';
    window.rosterAnswer = { status: 200, body: j };
  }, { X, body: rosterBody });
  await page.click('.fl-roster [data-do="roster"]');
  await page.waitForFunction(() => window.fleet.state().roster.state === 'ok' && window.fleet.state().roster.notShown >= 3);
  for (const b of await page.locator('[data-do="more"][aria-expanded="false"]').all()) await b.click();
  await feed({ type: 'accounts', personalNamed: true, list: [{ name: 'S' + X, connection: X, prop: true, group: 'g1', pnlToday: 1, why: { roomFloor: X }, rules: { target: 3000, consistency: 40 }, positions: [{ root: X, qty: 1 }] }] });
  await feed({ type: 'groups', list: [{ id: 'g1', name: X, accountType: 'eval' }] });
  await feed(agent('hostile', { name: X, build: X, account: 'S' + X, standDown: X, rules: { entryFrom: X, entryUntil: X, flatAt: X } }));
  await feed(agent('hostile2', { account: null, group: { id: X, name: X }, seats: [{ account: X }] }));
  await page.click('[data-do="ask"]'); await sleep(ARM); await page.click('[data-do="yes"]');
  await feed({ type: 'status', level: 'warn', text: 'Kill all (prop accounts): ' + X });
  await feed({ type: 'agentStandDowns', list: [] });   // the end of the replay: the hostile traders are heard and shown (answers 25, S1)
  const seenSignedIn = await page.evaluate(() => (document.getElementById('flView').innerText.match(/<img src=x/g) || []).length);
  check(seenSignedIn >= 12, 'signed in, the hostile strings show as text ' + seenSignedIn + ' times');
  await feed({ type: 'trading', enabled: false });   // a sign-out forgets the traders (S1); what is left is still text only
  const hostile = await page.evaluate(() => ({ ran: window.ranScript || 0, imgs: document.querySelectorAll('#flView img, #flView script, #flView iframe, #flView [onerror]').length, seen: (document.getElementById('flView').innerText.match(/<img src=x/g) || []).length }));
  check(hostile.ran === 0 && hostile.imgs === 0 && hostile.seen >= 1, 'hostile strings in every roster field, account, group, trader and answer: 0 scripts ran, 0 elements injected, shown as text ' + hostile.seen + ' times');
  await page.evaluate(b => { window.rosterAnswer = { status: 500, body: { error: 'the roster folder named in config.txt is not there' } }; }, null);
  await page.click('.fl-roster [data-do="roster"]');
  await page.waitForFunction(() => window.fleet.state().roster.state === 'error');
  check((await text('.fl-roster .fl-empty')).includes('could not read the roster folder: the roster folder named in config.txt is not there') && await page.locator('.fl-card').count() === 0, 'a folder that cannot be read: ChartBridge\'s reason, and no stale cards');

  // the connection drops: everything ChartBridge said is forgotten; an unanswered Kill all is not
  await feed({ type: 'trading', enabled: true }); await feed(accounts); await feed(groups);
  await page.click('[data-do="ask"]'); await sleep(ARM); await page.click('[data-do="yes"]');
  await page.evaluate(() => { for (const h of window.subs) h.closed(); });
  check((await text('.fl-others .fl-empty')).includes('ChartBridge is not connected') && await page.locator('.fl-table').count() === 0 && await page.locator('.fl-set').count() === 0, 'connection lost: no stale traders, accounts or roster');
  check((await text('.fl-answer')).includes("Kill all was sent and ChartBridge's answer never came (the connection dropped): look in NinjaTrader now") && await page.locator('.fl-answer.bad').count() === 1, 'and a Kill all that was sent and not answered is said, marked bad');
  await page.evaluate(b => { window.rosterAnswer = { status: 200, body: b }; }, rosterBody);
  await feed({ type: 'hello', version: '0.6.20', features: ['v3'] });
  await page.waitForFunction(() => window.fleet.state().roster.state === 'ok');
  await feed({ type: 'trading', enabled: true }); await feed(accounts); await feed(groups);
  await feed(agent('germanicus', { rules: { entryFrom: '09:40', entryUntil: '15:00', flatAt: '15:55', marketEntry: true, noTarget: true }, dayStop: 900, owns: true }));
  await feed({ type: 'agentStandDowns', list: [] });   // ChartBridge's end of the sign-in replay (answers 25, S1)

  // the re-review of 94, R1: Armed never moves when the words beside it grow (the longest PARTLY reason), at four widths
  for (const width of [1440, 700, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await sleep(150);
    const box = () => page.evaluate(() => { const r = document.querySelector('[data-do="arm"]').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; });
    const before = await box();
    await page.evaluate(() => { document.querySelector('[data-k="armsaid"]').textContent = 'Eval lane has a trader not in Shadow: twin (Copilot). '.repeat(7); });
    const after = await box();
    await page.evaluate(() => { document.querySelector('[data-k="armsaid"]').textContent = ''; });
    check(JSON.stringify(before) === JSON.stringify(after), 'Armed stays where it is at ' + width + ' px when the words beside it grow: ' + JSON.stringify(before) + ' and ' + JSON.stringify(after));
    // answers 25, N-c: the same width whatever it says, so its right edge does not move either
    const widths = await page.evaluate(() => { const b = document.querySelector('[data-do="arm"]'); const was = b.textContent; const out = [];
      for (const words of ['Armed: off', 'Armed: ON', 'Armed: PARTLY', 'Armed: not known']) { b.textContent = words; out.push(Math.round(b.getBoundingClientRect().width)); }
      b.textContent = was; return out; });
    check(new Set(widths).size === 1, 'Armed keeps one width in every state at ' + width + ' px: ' + widths.join(', '));
  }
  // phone width: one column, no sideways scroll of the page, the buttons big enough to touch
  await page.setViewportSize({ width: 390, height: 844 });
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    cols: getComputedStyle(document.querySelector('.fl-lanegrid')).gridTemplateColumns.split(' ').length, kill: document.querySelector('[data-do="ask"]').getBoundingClientRect().height }));
  check(m.sw <= m.cw + 1 && m.cols === 1 && await page.locator('.fl-set').count() === 4, 'at 390 px: the lanes in one column, the roster scrolls inside its box, no sideways scroll of the page (' + m.sw + ' in ' + m.cw + ')');
  check(m.kill >= 30, 'the Kill all button keeps its height (' + m.kill + ' px)');
  await page.screenshot({ path: path.join(SHOTS, 'fleet-phone.png'), fullPage: true });
  check(pageErrors.length === 0, 'no page errors and no browser dialog: ' + pageErrors.join(' | '));
} finally { await browser.close(); }

/* ---- in the whole workspace, against the fake bridge: the button shows with a ChartBridge that knows Kill all, the tab opens
   over the grid, one view at a time, and a reload keeps it. The fake bridge knows nothing of prop accounts: the tab then says
   how to pick the personal account, and nothing is sent. */
{
  const { spawn } = await import('node:child_process');
  const { TEST_PIN, enterPin } = await import('./smoke-pin.mjs');
  const PORT = +(process.env.FLEET_SMOKE_PORT || 8987);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const b2 = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  let bridge = null;
  try {
    bridge = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(PORT), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN, '--agents=demo', '--version=0.6.20'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res, rej) => { bridge.stdout.once('data', res); bridge.once('exit', c => rej(new Error('bridge exited ' + c))); });
    const ctx = await b2.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    for (const r of ['chart-hotkeys', 'chart-strategies', 'chart-accounts'])
      await ctx.route('http://localhost:8800/api/' + r, x => x.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    const page = await ctx.newPage();
    const pe = [];
    page.on('pageerror', e => pe.push(e.message));
    page.on('dialog', d => { pe.push('a browser dialog: ' + d.message()); d.dismiss(); });
    await page.goto(`http://localhost:${PORT}/live/?layout=Main`);
    await page.waitForSelector('.cb-pin-key', { timeout: 15000 });
    await enterPin(page, TEST_PIN);
    await page.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 });
    await page.waitForFunction(() => !document.getElementById('wsFleetTab').hidden, null, { timeout: 15000 }).catch(() => {});
    check(await page.locator('#wsFleetTab').isVisible(), 'workspace: the Legion button shows with ChartBridge 0.6.20');
    await page.waitForFunction(() => !document.getElementById('wsAgentTab').hidden, null, { timeout: 15000 }).catch(() => {});
    check(await page.locator('#wsAgentTab').isVisible(), 'workspace: the Agent button is still there');
    await page.click('#wsFleetTab');
    await sleep(300);
    const on = await page.evaluate(() => ({ cls: document.body.classList.contains('fl-on'), url: location.search, grid: getComputedStyle(document.querySelector('.ws-grid')).display,
      view: getComputedStyle(document.getElementById('flView')).display, title: (document.querySelector('.fl-title') || {}).textContent }));
    check(on.cls && /tab=legion/.test(on.url) && on.grid === 'none' && on.view !== 'none' && on.title === 'Legion', 'workspace: the tab opens over the grid and the address keeps it: ' + JSON.stringify(on));
    await page.waitForFunction(() => /Other connections \((\d+)\)/i.test((document.querySelector('.fl-others') || {}).textContent || '') && !/\(0\)/.test(document.querySelector('.fl-others').textContent), null, { timeout: 10000 }).catch(() => {});
    if (await page.locator('[data-do="others"][aria-expanded="false"]').count()) await page.click('[data-do="others"]');
    check(await page.locator('.fl-trader[data-id="demo"]').count() === 1, 'workspace: the fake bridge\'s agent is listed as a trader');
    check((await page.locator('.fl-box[aria-label="Prop accounts"] .fl-empty').innerText()).includes('No personal account is picked yet'), 'workspace: no pick, so no prop account, and it says how to pick');
    await page.waitForFunction(() => window.workspace.fleet().roster.state !== 'loading', null, { timeout: 10000 }).catch(() => {});
    const ro = await page.evaluate(() => window.workspace.fleet().roster);
    check(ro.state === 'none' && ro.asked === 1 && /No roster folder is set on this PC/.test(ro.text), 'workspace: the real request: the fake bridge has no roster (404), asked once, and the tab says the folder is not set: ' + JSON.stringify(ro));
    await page.click('#wsAgentTab');
    await sleep(300);
    check(await page.evaluate(() => !document.body.classList.contains('fl-on') && document.body.classList.contains('ag-on') && /tab=agent/.test(location.search)), 'workspace: opening the Agent tab closes Legion (one view at a time)');
    await page.click('#wsFleetTab');
    await sleep(300);
    check(await page.evaluate(() => document.body.classList.contains('fl-on') && !document.body.classList.contains('ag-on')), 'workspace: and Legion closes the Agent tab');
    await page.reload();
    await page.waitForSelector('.cb-pin-key', { timeout: 15000 }).then(() => enterPin(page, TEST_PIN)).catch(() => {});
    await page.waitForFunction(() => document.body.classList.contains('fl-on'), null, { timeout: 20000 }).catch(() => {});
    check(await page.evaluate(() => document.body.classList.contains('fl-on')), 'workspace: a reload with ?tab=legion opens the tab again');
    await page.click('#wsFleetTab');
    await sleep(300);
    check(await page.evaluate(() => !document.body.classList.contains('fl-on') && !/tab=/.test(location.search) && getComputedStyle(document.querySelector('.ws-grid')).display !== 'none'), 'workspace: a second click closes it and the grid is back');
    check(pe.length === 0, 'workspace: no page errors and no browser dialog: ' + pe.join(' | '));
    await page.screenshot({ path: path.join(SHOTS, 'fleet-workspace.png') });

    /* ---- STOP 3 (the second look at 92): the page's alert banner never covers the tab's head. The fake bridge knows nothing of a
       personal account, so the page is told one is picked (the accounts message, as it arrives), and every frame it sends is kept */
    const p2 = await ctx.newPage();
    const pe2 = [];
    p2.on('pageerror', e => pe2.push(e.message));
    await p2.addInitScript(() => {
      window.__frames = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (m && m.type !== 'auth' && m.type !== 'client' && m.type !== 'subscribe') window.__frames.push(m); } catch (e) { /* not JSON */ } return send.call(this, d); };
      const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
      Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return d.get.call(this); }, set(fn) {
        d.set.call(this, fn && function (ev) {
          let m; try { m = JSON.parse(ev.data); } catch (e) { return fn.call(this, ev); }
          if (!m || m.type !== 'accounts') return fn.call(this, ev);
          m.personalNamed = true;
          return fn.call(this, new MessageEvent('message', { data: JSON.stringify(m) }));
        });
      } });
    });
    const control = (what, q) => fetch(`http://127.0.0.1:${PORT}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' });
    for (const width of [1600, 1024, 700]) {
      await p2.setViewportSize({ width, height: 900 });
      await p2.goto(`http://localhost:${PORT}/live/?layout=Main&tab=legion`);
      await p2.waitForSelector('.cb-pin-key', { timeout: 15000 }).then(() => enterPin(p2, TEST_PIN)).catch(() => {});
      await p2.waitForFunction(() => document.body.classList.contains('fl-on') && document.querySelector('[data-do="ask"]') && !document.querySelector('[data-do="ask"]').hasAttribute('aria-disabled'), null, { timeout: 30000 }).catch(() => {});
      check(await p2.evaluate(() => !document.querySelector('[data-do="ask"]').hasAttribute('aria-disabled')), 'banner, ' + width + ' px: Kill all is offered (signed in, a personal account picked)');
      await control('status', { level: 'error', text: 'Sample: NOT FLAT? a made-up error line from ChartBridge' });
      await control('status', { level: 'warn', text: 'Sample: a second made-up line' });
      await p2.waitForFunction(() => !document.getElementById('wsAlert').hidden, null, { timeout: 8000 }).catch(() => {});
      const reach = sel => p2.evaluate(q => { const b = document.querySelector(q), r = b.getBoundingClientRect(); let n = 0; for (let i = 0; i < 15; i++) { const e = document.elementFromPoint(r.left + 1 + (r.width - 2) * i / 14, r.top + r.height / 2); if (e && (e === b || b.contains(e))) n++; } return n; }, sel);
      const overlap = () => p2.evaluate(() => { const a = document.getElementById('wsAlert').getBoundingClientRect(), h = document.querySelector('.fl-top').getBoundingClientRect(); return !(a.bottom <= h.top || a.top >= h.bottom); });
      check(await p2.isVisible('#wsAlert') && !(await overlap()) && await reach('[data-do="ask"]') === 15, 'banner, ' + width + ' px: with the alert banner up it does not lie on the head, and 15 of 15 points of Kill all reach it (' + await reach('[data-do="ask"]') + ')');
      const kb = await p2.locator('[data-do="ask"]').boundingBox();
      await p2.mouse.click(kb.x + kb.width / 2, kb.y + kb.height / 2);
      check(await p2.evaluate(() => window.workspace.fleet().asking), 'banner, ' + width + ' px: a click on Kill all opens the question');
      await control('status', { level: 'error', text: 'Sample: another made-up error, arriving while the question is up' });
      await sleep(700);
      check(!(await overlap()) && await reach('[data-do="yes"]') === 15 && await reach('[data-do="no"]') === 15, 'banner, ' + width + ' px: an alert that arrives while the question is up covers neither Yes nor Cancel (' + await reach('[data-do="yes"]') + ', ' + await reach('[data-do="no"]') + ' of 15)');
      const yb = await p2.locator('[data-do="yes"]').boundingBox();
      await p2.mouse.click(yb.x + yb.width / 2, yb.y + yb.height / 2);
      const frames = await p2.evaluate(() => window.__frames.filter(m => m.type === 'agentKillAllProp'));
      check(frames.length === 1 && Object.keys(frames[0]).sort().join() === 'cid,type', 'banner, ' + width + ' px: Kill all then Yes sends, with the banner up: ' + JSON.stringify(frames));
      if (width === 1600) await p2.screenshot({ path: path.join(SHOTS, 'fleet-banner.png') });
      await p2.click('#wsAlertClose').catch(() => {});
    }
    check(pe2.length === 0, 'banner: no page errors: ' + pe2.join(' | '));
    await p2.close();

    /* ---- FIX A: with accounts.js not served the page starts exactly as before (its panels, live), and nothing of Legion stops it */
    const p3 = await ctx.newPage();
    const pe3 = [];
    p3.on('pageerror', e => pe3.push(e.message));
    await p3.route('**/accounts.js', r => r.fulfill({ status: 404, contentType: 'text/plain', body: 'not here' }));
    await p3.goto(`http://localhost:${PORT}/live/?layout=Main`);
    await p3.waitForSelector('.cb-pin-key', { timeout: 15000 }).then(() => enterPin(p3, TEST_PIN)).catch(() => {});
    await p3.waitForFunction(() => document.getElementById('wsConn').classList.contains('live'), null, { timeout: 30000 }).catch(() => {});
    const started = await p3.evaluate(() => ({ live: document.getElementById('wsConn').classList.contains('live'), panels: window.workspace ? window.workspace.panels().length : 0, feed: !!window.AccountsPage }));
    check(started.live && started.panels > 0 && !started.feed && pe3.length === 0, 'with accounts.js not served the workspace starts: live, ' + started.panels + ' panels, no page error: ' + pe3.join(' | '));
    await p3.close();

  } finally { if (bridge) bridge.kill(); await b2.close(); }
}
for (const e of errors) console.log('  failed: ' + e);
console.log(errors.length ? `\n${errors.length} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(errors.length ? 1 : 0);
