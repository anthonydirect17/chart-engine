// The Agent tab's parity test (before Layout 5, DECISION 2026-10-14a): every item of test/agent-parity.json (128: the base
// state and each condition) and the rules that hold across the tab, asserted on the tab as it is, through stable hooks, so
// the same test holds after the redesign. Each item's element carries data-parity="<id>" (a part of it <id>-<part>; one
// element may carry several), set in live/agent.js; no style reads them. Behaviour items (keys, Escape, focus, R3 and
// data-no-motion, fixed heights, Accept and Reject never covered or moved, the messages sent) are asserted as behaviour.
// Against the fake bridge with made-up agents ("Demo Agent", "Second Demo Agent"), made-up accounts (Sim101, SIM-AG1,
// SIM-AG2, EVAL-A) and made-up prices, notes and plans; the fake PC helper (test/fake-helper.mjs) on 8767 for On/Off:
// sample data only.
//   phase 1: --agents=demo, no helper. The base state (demo moved to SIM-AG1, flat, Shadow), then notes, plans, the drawer,
//            the rules, Copilot and a proposal, Accept, a trade and its exit, expiry, the keys, the corner, the bot's
//            proposals counted, the small screens and the pop-out (agent.html);
//   phase 2: --agents=demo,demotwo and the fake helper: the picker, On/Off, spend, a build that is not a hero, Off in a
//            trade, the settings, the second agent's proposals counted;
//   phase 3: no agents line (a ChartBridge 0.5.2): the tab's "no agents" card and its count line.
//   npm run smoke:agent-parity   (CHROMIUM_PATH=/path/to/chrome; AGENT_PARITY_PORT, else the first free ports from 8991;
//                                 SHOTS=dir; PARITY_PHASES=1,2,3 to run some phases only, which then fails the count)
// Screenshots: agent-parity-base, agent-parity-trade, agent-parity-popout (.png in test/out).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { tabBtn } from './tab-buttons.mjs';
import { TEST_PIN, enterPin } from './smoke-pin.mjs';
import { startFakeHelper } from './fake-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.resolve(process.env.SHOTS || path.join(root, 'test', 'out'));
fs.mkdirSync(SHOTS, { recursive: true });
const LIST = JSON.parse(fs.readFileSync(path.join(root, 'test', 'agent-parity.json'), 'utf8'));
const ITEM = new Map(LIST.items.map(x => [x.id, x]));
const PHASES = (process.env.PARITY_PHASES || '1,2,3').split(',').map(x => +x);
const errors = [];
let checks = 0;
const fail = m => { errors.push(m); console.error('  FAIL ' + m); };
const check = (ok, m) => { checks++; if (!ok) fail(m); else console.log('  ok   ' + m); };
/* each item's result: asserted at least once, passed every time */
const done = new Map();
function item(id, ok, m) {
  if (!ITEM.has(id)) throw new Error('not a parity item: ' + id);
  const r = done.get(id) || { ok: true, n: 0 }; r.n++; r.ok = r.ok && !!ok; done.set(id, r);
  check(ok, id + ' ' + m);
}
const rules = new Map();
function rule(key, ok, m) { const r = rules.get(key) || { ok: true, n: 0 }; r.n++; r.ok = r.ok && !!ok; rules.set(key, r); check(ok, 'rule ' + key + ': ' + m); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() - t0 > ms) { fail('timed out: ' + what); return null; } await sleep(150); }
}
const free = p => new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
let nextPort = +(process.env.AGENT_PARITY_PORT || 0) || 8991;
async function freePort() { while (!(await free(nextPort))) nextPort++; return nextPort++; }
/* the hook of an item, or of a part of it */
const H = id => '[data-parity~="' + id + '"]';

/* the smoke's clock: 11:00 New York whatever the time of day it runs (as test/agent-smoke.mjs), so his session trail holds */
const NY_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function offsetToNy(hhmm, now) {
  const o = {}; for (const x of NY_PARTS.formatToParts(new Date(now))) o[x.type] = +x.value || 0;
  const wall = Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second), want = Date.UTC(o.year, o.month - 1, o.day, +hhmm.slice(0, 2), +hhmm.slice(3), 0);
  return Math.round((want - wall) / 1000);
}
const CLOCK_OFFSET_S = offsetToNy('11:00', Date.now());
let port = 0;
const control = async (what, q) => (await fetch(`http://127.0.0.1:${port}/test/${what}?` + new URLSearchParams(q || {}), { method: 'POST' })).json();
const agentsNow = async () => (await control('agents')).agents;
const agentNow = async id => (await agentsNow()).find(a => a.agent === id);
async function startBridge(flags) {
  port = await freePort();
  const br = spawn(process.execPath, [path.join(root, 'test', 'fake-bridge.mjs'), String(port), '--v3', '--trading', '--test-controls', '--test-pin=' + TEST_PIN, '--clock-offset=' + CLOCK_OFFSET_S].concat(flags), { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { br.stdout.once('data', res); br.once('exit', c => rej(new Error('bridge exited ' + c))); });
  return br;
}
const DESK_KEYS = { rev: 3, keys: { buy: '', sell: '', be: '', close: '', flattenAll: '', merge: '', maximize: '', accept: 'Alt+Y', reject: 'Alt+N' }, modifiers: { limit: '', stop: '' } };
const LONG = 'Sample: the pullback to the made-up VWAP held twice; a long with the stop under the morning low. ' + 'More made-up words to make the reason long. '.repeat(2);
const AGENT_SENDS = ['agentMode', 'agentKill', 'agentSeen', 'agentAnswer', 'agentAccount', 'agentRules'];

async function newContext(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(off => { const Real = Date; class Shifted extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + off); } static now() { return Real.now() + off; } } window.Date = Shifted; }, CLOCK_OFFSET_S * 1000);
  for (const u of ['chart-hotkeys', 'chart-strategies', 'chart-accounts']) await ctx.route('http://localhost:8800/api/' + u, r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: u === 'chart-accounts' ? '{"accounts":[]}' : u === 'chart-strategies' ? '{"rev":0,"strategies":[]}' : JSON.stringify(DESK_KEYS) }));
  await ctx.addInitScript(() => {
    /* every message the page sends; window.__dropFlatten keeps the page's flatten from ChartBridge (Off in a trade, held) */
    const Real = window.WebSocket; window.__sent = []; window.__dropFlatten = false;
    function Spy(u, p) { const s = p === undefined ? new Real(u) : new Real(u, p); const send = s.send.bind(s); s.send = d => { let m = null; try { m = JSON.parse(d); m.__at = Date.now(); window.__sent.push(m); } catch (e) { /* not JSON */ } if (m && m.type === 'flatten' && window.__dropFlatten) return; return send(d); }; return s; }
    Spy.prototype = Real.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Spy[k] = Real[k];
    window.WebSocket = Spy;
    /* the Agent tab's chart (its lines and its trades) and the AgentDesk instances, as the page hands them over */
    window.__trade = []; window.__trades = []; window.__desks = [];
    let CL = null, AD = null;
    Object.defineProperty(window, 'ChartLive', { configurable: true, get: () => CL, set: v => {
      CL = v;
      if (v && typeof v.mount === 'function' && !v.mount.__spy) {
        const mount = v.mount;
        v.mount = function (el, opt) {
          const inst = mount.apply(this, arguments);
          if (opt && opt.paneId === 'agent' && inst) {
            const st = inst.setTrade; inst.setTrade = t => { window.__trade.push(JSON.parse(JSON.stringify(t || null))); return st.call(inst, t); };
            const c = inst.chart; if (c && typeof c.setTrades === 'function') { const s2 = c.setTrades; c.setTrades = l => { window.__trades.push(Array.isArray(l) ? l.length : 0); return s2.call(c, l); }; }
          }
          return inst;
        };
        v.mount.__spy = true;
      }
    } });
    Object.defineProperty(window, 'AgentDesk', { configurable: true, get: () => AD, set: v => {
      AD = v;
      if (v && typeof v.create === 'function' && !v.create.__spy) { const create = v.create; v.create = function () { const d = create.apply(this, arguments); window.__desks.push(d); return d; }; v.create.__spy = true; }
    } });
    /* the hooks, read in the page */
    const sel = id => '[data-parity~="' + id + '"]';
    const shown = el => {
      if (!el || !el.isConnected) return false;
      const s = getComputedStyle(el);
      if (s.display === 'contents') return [...el.children].some(shown);
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;   // a closed <details>, display none on the way up
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden';
    };
    const all = id => [...document.querySelectorAll(sel(id))];
    const txt = e => e.textContent.replace(/\s+/g, ' ').trim();
    /* R3: what may move is the light (LT02) and a panel's glow (LT01, or a panel that never lights, "glow": box-shadow and
       --ag-pc); everything else holds */
    const glow = el => (el.matches(sel('LT01') + ', ' + sel('glow')) ? ['box-shadow', '--ag-pc'] : []);
    const inLight = el => !!el.closest(sel('LT02'));
    function r3(list) {
      const anims = document.getAnimations().filter(a => !(typeof CSSTransition === 'function' && a instanceof CSSTransition && a.effect && a.effect.target && glow(a.effect.target).includes(a.transitionProperty)));
      const animated = new Set(anims.map(a => a.effect && a.effect.target).filter(Boolean));
      const why = a => {
        if (animated.has(a) && !inLight(a)) return 'animated';
        const s = getComputedStyle(a);
        if (s.animationName !== 'none') return 'animation ' + s.animationName;
        const p = s.transitionProperty.split(',').map(x => x.trim()), d = s.transitionDuration.split(',').map(x => parseFloat(x));
        for (let i = 0; i < p.length; i++) if ((d[i % d.length] || 0) > 0 && !glow(a).includes(p[i])) return 'transition ' + p[i];
        return '';
      };
      const bad = [];
      for (const el of list) {
        if (inLight(el) || !el.getClientRects().length) continue;
        for (let a = el; a && a !== document.documentElement; a = a.parentElement) { const w = why(a); if (w) { bad.push((el.dataset.parity || el.tagName.toLowerCase()) + ' via ' + (a === el ? 'itself' : a.dataset.parity || a.tagName.toLowerCase() + '.' + String(a.className).split(' ')[0]) + ' (' + w + ')'); break; } }
      }
      return bad;
    }
    const box = e => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    window.__P = {
      info: id => { const a = all(id), s = a.filter(shown); return { n: a.length, shown: s.length, text: s.map(txt).join(' | '), texts: s.map(txt) }; },
      r3: (id, deep) => { let list = all(id).filter(shown); if (deep) list = list.flatMap(e => [e, ...e.querySelectorAll('*')]); return r3(list); },
      r3All: () => r3(all('view').flatMap(v => [...v.querySelectorAll('[data-parity]')]).concat(all('P03').flatMap(e => [...e.querySelectorAll('*')]), all('D01').flatMap(e => [...e.querySelectorAll('*')]))),
      nomo: id => all(id).filter(shown).every(e => !!e.closest('[data-no-motion]')),
      box: id => { const e = all(id).find(shown); return e ? box(e) : null; },
      boxes: id => all(id).filter(shown).map(box),
      inside: (id, outer) => { const o = all(outer).find(shown); const a = all(id).filter(shown); return !!o && a.length > 0 && a.every(e => o.contains(e)); },
      focused: id => !!document.activeElement && document.activeElement.matches(sel(id)),
      within: id => { const e = all(id)[0]; return !!e && !!document.activeElement && e.contains(document.activeElement); },
      attr: (id, k) => { const e = all(id).find(shown) || all(id)[0]; return e ? e.getAttribute(k) : null; },
      disabled: id => { const e = all(id)[0]; return !!e && e.disabled; },
      /* Accept and Reject: their centre and four corners are the buttons themselves */
      hit: (ids, still) => {
        const out = [];
        for (const id of ids) for (const b of all(id).filter(shown)) {
          if (!still) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const r = b.getBoundingClientRect();
          if (r.width < 20 || r.height < 20) { out.push(id + ': too small'); continue; }
          for (const [x, y] of [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 3, r.top + 3], [r.right - 3, r.top + 3], [r.left + 3, r.bottom - 3], [r.right - 3, r.bottom - 3]]) {
            const h = document.elementFromPoint(x, y);
            if (!h || !(h === b || b.contains(h))) out.push(id + ' at ' + Math.round(x) + ',' + Math.round(y) + ' -> ' + (h ? (h.dataset.parity || h.className || h.tagName) : 'off the window'));
          }
        }
        return out;
      },
      inWindow: ids => ids.every(id => { const b = all(id).find(shown); if (!b) return false; const r = b.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; }),
    };
  });
  return ctx;
}
async function openPage(ctx, url, ready) {
  const page = await ctx.newPage();
  page.on('pageerror', e => fail('page error: ' + e.message));
  page.on('dialog', d => { fail('a browser dialog: ' + d.message()); d.dismiss(); });
  await page.goto(url);
  if (await page.waitForSelector('.cb-pin-key', { timeout: 15000 }).catch(() => null)) await enterPin(page, TEST_PIN);
  if (ready) await page.waitForFunction(ready, null, { timeout: 30000 });
  return page;
}
const workspaceReady = () => document.getElementById('wsConn').classList.contains('live');

/* the page's side of the checks */
function tools(page) {
  const P = (fn, ...a) => page.evaluate(([fn, a]) => window.__P[fn](...a), [fn, a]);
  const info = id => P('info', id);
  const text = async id => (await info(id)).text;
  const A = () => page.evaluate(() => window.workspace ? window.workspace.agent() : window.agentDesk.state());
  const sent = () => page.evaluate(() => window.__sent);
  /* an item that shows: present and in sight, its words as wanted, R3 (when the item says so) and under data-no-motion (when
     its rules say so) */
  async function shows(id, want, what, deep) {
    const it = ITEM.get(id), x = await info(id);
    const bad = it.r3NoMotion ? await P('r3', id, !!deep) : [];
    const nomo = /data-no-motion/.test(it.rules) ? await P('nomo', id) : true;
    const okText = !want ? true : typeof want === 'function' ? await want(x) : want.test(x.text);
    item(id, x.shown > 0 && !bad.length && nomo && okText, (what || it.what.slice(0, 70)) + ': "' + x.text.slice(0, 140) + '"' + (bad.length ? ' R3: ' + bad.slice(0, 3).join('; ') : '') + (nomo ? '' : ' (not under data-no-motion)') + (x.shown ? '' : ' (not shown)'));
    return x;
  }
  return { P, info, text, A, sent, shows, click: id => page.click(H(id)) };
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let bridge = null, helper = null;
try {
  /* ====================================================================== phase 1: one agent, no PC helper */
  if (PHASES.includes(1)) {
    console.log('phase 1: --agents=demo, no PC helper');
    bridge = await startBridge(['--agents=demo', '--agent-any-time', '--max-qty=MNQ:20,NQ:2']);   // config.txt's cap holds for agents
    const ctx = await newContext(browser);
    const page = await openPage(ctx, `http://localhost:${port}/live/?layout=Main`, workspaceReady);
    const { P, info, text, A, sent, shows, click } = tools(page);
    await control('price', { root: 'MNQ', p: 25400 });
    await control('agent-connect', { agent: 'demo', name: 'Demo Agent', build: 'sample-build-1' });
    await until(async () => (await A()).agents.length === 1, 'ChartBridge told of demo');
    /* 1.35.0: the Agent button lives in the Agent desk panel (+ Add panel). Main is full, so its Time and Sales goes to make room
       (nothing of the agent desk reads it), then the panel is added and holds W01, closed, as the top bar did */
    await page.click('.ws-panel.tape [data-act="close"]');
    await tabBtn(page, 'agentdesk');
    await until(async () => (await info('W01')).shown, 'the Agent tab button');
    check((await P('attr', 'W01', 'aria-pressed')) === 'false', 'the tab is closed at first');
    await click('W01');
    await until(async () => (await A()).shown, 'the tab opens');

    /* demo with no account file is on None (ChartBridge 0.5.7, DECISION 2026-10-14e): he stands down (ST11), until he has his own */
    await until(async () => /STOOD DOWN/.test(await text('ST11')), 'demo stands down on None', 8000);
    await shows('ST11', /^STOOD DOWN: agent demo's account is None: no new entries until an account is chosen on the Agent tab$/, 'stood down on None');
    check((await P('attr', 'ST11', 'title')) === await text('ST11'), 'its title is the full text');
    /* Change account: the chooser focuses its select (rule: focus) */
    await click('LA04');
    await until(async () => (await info('LA05')).shown, 'the chooser opens');
    rule('focus', await P('focused', 'LA05-sel'), 'Change account focuses the chooser\'s select');
    const opts = await page.$$eval(H('LA05-sel') + ' option', o => o.map(x => x.textContent + (x.disabled ? ' [off]' : '')));
    await shows('LA05', async x => (await info('LA05-sel')).shown && (await info('LA05-set')).shown && (await info('LA05-cancel')).shown && opts[0] === 'None (nothing trades), now' && opts.some(t => /^SIM-AG1 \(SIM\)$/.test(t)) && opts.some(t => /^Sim101 \(SIM\)/.test(t)) && opts.some(t => /^EVAL-A \(LIVE\)/.test(t)),
      'the chooser: None first (DECISION 2026-10-14e), every tradable account, SIM first, the current one ", now", Set and Cancel: ' + opts.join(' | '));
    await page.selectOption(H('LA05-sel'), 'SIM-AG1');
    await click('LA05-set');
    await until(async () => (await text('ST07')).includes('SIM-AG1'), 'demo trades SIM-AG1');
    await shows('LA07', /^Sent: its mode \(Shadow\) is kept\.$/, 'the words under Change account after Set');
    const acctMsg = (await sent()).filter(m => m.type === 'agentAccount');
    rule('messages', acctMsg.length === 1 && acctMsg[0].account === 'SIM-AG1', 'agentAccount sent once: ' + JSON.stringify(acctMsg.map(m => m.account)));
    await until(async () => !(await info('ST11')).shown, 'no longer stood down', 8000);
    await sleep(1500);

    /* ---------------------------------------------------------------- the base state: every item marked visible in it */
    console.log('the base state (demo on SIM-AG1, flat, Shadow, no proposal, no drawer, no PC helper)');
    const B = {
      ST01: /^DA$/, ST02: /^Demo Agent$/, ST03: /^\/\/ AGENT DESK$/, ST05: /^CONNECTED · \d+\.\d s ago$/, ST06: /^SHADOW$/, ST07: /^Account\s*SIM-AG1\s*SIM$/, ST08: /^SIM$/, ST09: /^Position\s*Flat$/,
      ST13: async () => (await text('ST13-full')) === 'Full' && (await text('ST13-off')) === 'Off' && (await P('attr', 'ST13-full', 'aria-pressed')) === 'true', ST14: /^Pop out$/,
      OH01: /^Agent/, OH02: null, OH03: /^On$/, OH04: /^Off$/, OH05: /^Session -$/, OH06: /^Overall -$/, OH07: /^The PC helper is not running on this PC/, OH10: /^Auto-On and daily cap$/,
      LM01: /^SIM-AG1 · SIM$/, LM02: async x => x.shown === 3 && x.texts.join(',') === 'Shadow,Copilot,Auto' && (await P('attr', 'LM02-shadow', 'aria-pressed')) === 'true', LM04: /^Kill switch$/,
      LM05: /^Watching$/, LM06: /^\d+\.\d s ago$/, LM07: /^No plan yet today$/, LM08: /^sample-build-1$/,
      LA01: /^SIM-AG1 SIM$/, LA02: /^Max loss room\s*not reported$/, LA03: /^Daily limit left\s*not reported$/, LA04: /^Change account$/,
      LR01: async x => /NQ, MNQ/.test(x.text) && /09:45/.test(x.text) && /15:55/.test(x.text), LR02: /^Change the rules$/,
      C01: /^What he is doing now$/, C02: /^Watching$/, C03: async x => x.shown === 5 && /^1\s*Screen \| 2\s*Eyes \| 3\s*Judgment \| 4\s*Checks \| 5\s*ChartBridge$/.test(x.text) && (await page.$$eval(H('C03'), l => l.filter(e => e.getAttribute('aria-current') === 'step').length)) === 1,
      CH01: /^(MNQ|NQ)[^·]* · 1 min$/, CH02: async () => (await page.$$eval(H('CH02') + ' option', o => o.map(x => x.value).join(','))) === 'NQ,MNQ', CH03: async () => (await page.$eval(H('CH03'), e => e.value)) === 'm1', CH04: null,
      CH05: /^flat$/, CH07: async () => page.$eval(H('CH07'), e => [...e.querySelectorAll('canvas')].some(c => c.getBoundingClientRect().height > 50)), CH10: null,
      P01: /^Proposal · copilot$/, P02: async () => (await text('P02-empty')) === 'None open',
      O01: /^No other proposals$/, SM01: async () => (await text('SM01-count')) === '0 notes · 0 plans', SM02: async x => x.texts.join(',') === 'All,Plans,Notes,Thinking,Lessons', SM08: /^Nothing yet$/,
      F01: /^\$0\.00$/, F02: /^Today$/, F03: /^0\s*Trades$/, F04: /^0\s*Losses$/,
      F05: async () => (await info('F05-hour')).shown >= 6 && /^09:45/.test(await text('F05-hour')) && /15:55$/.test(await text('F05-hour')) && (await info('F05-head')).shown > 0 && ((await P('box', 'F05-done')) || { width: 0 }).width > 0,
      LT01: async () => { const L = (await A()).light; const lit = await info('LT01-lit'); return L.panels.length === 1 && lit.shown === 1 && await page.$$eval(H('LT01'), l => l.every(e => (getComputedStyle(e).boxShadow !== 'none') === e.matches('[data-parity~="LT01-lit"]'))); },
      LT02: async () => page.evaluate(() => { const run = document.getAnimations().filter(a => a.playState === 'running' && a.effect && a.effect.target && a.effect.target.closest('[data-parity~="LT02"]')); return run.length > 0 && run.every(a => a.effect.target.closest('[data-parity~="LT01"]').matches('[data-parity~="LT01-lit"]')); }),
      W01: async () => (await P('attr', 'W01', 'aria-pressed')) === 'true',
    };
    const base = LIST.items.filter(x => x.mustBeVisible);
    check(base.length === 55 && base.every(x => x.id in B), 'the base state has 55 items, each with its check here: ' + base.filter(x => !(x.id in B)).map(x => x.id).join(','));
    for (const x of base) await shows(x.id, B[x.id], 'base state: ' + x.what.slice(0, 60));
    item('ST12', !(await info('ST12')).shown, 'one agent: no picker');
    item('ST04', !(await info('ST04')).shown && !/sample-build/.test(await text('ST02')), 'the build is never in the header (the Build row has it): ' + JSON.stringify(await info('ST04')));
    rule('heights', Math.abs((await P('box', 'P02')).height - Math.min(380, Math.max(190, 900 * 0.3))) <= 1 && Math.round((await P('box', 'O01')).height) === 30, 'the slot clamp(190px, 30vh, 380px) and the line under it 30 px, with nothing open');
    const labels = (await text('view'));
    rule('labels', !/The light|in profit|under water|bars, delta, levels|a row opens|ChartBridge enforces them|In Copilot each plan comes here|his decision|Only what ChartBridge/i.test(labels), 'no explanatory labels on the tab');
    rule('fonts', await page.evaluate(() => document.fonts.check('600 12px "Chakra Petch"') && document.fonts.check('12px "JetBrains Mono"') && document.fonts.check('12px "IBM Plex Sans"') && performance.getEntriesByType('resource').every(r => !/googleapis|gstatic/.test(r.name))), 'the tab\'s fonts from this PC');
    await page.screenshot({ path: path.join(SHOTS, 'agent-parity-base.png') });

    /* ---------------------------------------------------------------- the light and the Motion switch */
    console.log('the Motion switch and the system\'s reduced motion');
    const orbits = () => page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect && a.effect.target && a.effect.target.closest('[data-parity~="LT02"]')).length);
    await click('ST13-off');
    await until(async () => (await orbits()) === 0, 'Motion Off: no light');
    const offOk = await page.evaluate(() => { const lit = document.querySelector('[data-parity~="LT01-lit"]'); return !!lit && getComputedStyle(lit).boxShadow !== 'none' && localStorage.getItem('live-agent-motion-v1') === 'off'; });
    item('ST13', offOk && (await P('attr', 'ST13-off', 'aria-pressed')) === 'true', 'Motion Off: the light stops, the glow stays, kept in this browser (live-agent-motion-v1)');
    item('LT02', (await orbits()) === 0, 'Motion Off: no light animation');
    rule('motion', offOk, 'Motion Off: no light, the glow still there');
    await click('ST13-full');
    item('LT02', !!(await until(async () => (await orbits()) > 0, 'Motion Full: the light again')), 'Motion Full: the light circles the lit panel again');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await until(async () => (await orbits()) === 0, 'reduced motion: no light');
    rule('motion', await page.evaluate(() => [...document.querySelectorAll('[data-parity~="view"] *')].every(e => getComputedStyle(e).transitionDuration.split(',').every(d => parseFloat(d) === 0))), 'the system\'s reduced motion: no light and no transition in the tab');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await until(async () => (await orbits()) > 0, 'the light back');

    /* ---------------------------------------------------------------- Auto's confirm, the kill switch */
    console.log('Auto asks a second click; the kill switch');
    await click('LM02-auto');
    await shows('LM03', /^Click Confirm within 4 s: Auto on SIM-AG1\.$/, 'Auto armed: the words under the mode');
    check((await text('LM02-auto')) === 'Confirm' && !(await sent()).some(m => m.type === 'agentMode'), 'Auto says Confirm; nothing sent yet');
    await sleep(4300);
    item('LM03', !(await info('LM03')).shown, 'hidden again when the 4 s pass');
    await click('LM04');
    await until(async () => (await agentNow('demo')).killed, 'kill on in one click');
    await until(async () => (await text('ST11')) === 'KILLED', 'the strip says KILLED');
    await shows('ST11', /^KILLED$/, 'killed');
    await shows('LM04', /^Kill switch on · Release$/, 'the kill switch on');
    item('W02', !!(await until(async () => / W02-alert/.test(await P('attr', 'W02', 'data-parity')), 'the tab button marks an agent in trouble')) && /^Agent tab: 1 agent$/.test(await P('attr', 'W02', 'title')), 'the tab button marks a killed agent (alert); its title: ' + await P('attr', 'W02', 'title'));
    await until(async () => (await info('N01')).shown > 0, 'a notice');
    await shows('N01', /Kill switch/, 'the notices: one for the kill switch');
    item('N01', (await page.$$eval(H('N01'), l => l.every(e => ['status', 'alert'].includes(e.getAttribute('role'))))), 'each notice is a status (an alert for red)');
    await shows('N02', null, 'the notices stack in the chart panel while the tab is shown and wider than 1100 px');
    item('N02', await P('inside', 'N01', 'CH10'), 'the notices sit in the chart\'s overlay (CH10)');
    const nn = (await info('N01')).n;
    await page.locator(H('N01')).first().click();
    item('N01', (await info('N01')).n === nn - 1, 'a click dismisses a notice');
    await sleep(1100);
    await click('LM04');
    check((await text('LM04')) === 'Release: click again', 'Release asks a second click');
    await sleep(600);
    await click('LM04');
    await until(async () => !(await agentNow('demo')).killed, 'released');
    item('W02', !!(await until(async () => !/ W02-alert/.test(await P('attr', 'W02', 'data-parity')), 'the alert mark goes')), 'released: the tab button\'s alert mark goes');

    /* ---------------------------------------------------------------- the rules */
    console.log('the rules form');
    await click('LR02');
    await until(async () => (await info('LR03')).shown, 'the form opens');
    rule('focus', await P('focused', 'LR03-root'), 'Change the rules focuses the first root checkbox');
    const roots = await page.$$eval(H('LR03-root'), l => l.map(e => e.dataset.root + (e.disabled ? '(off)' : '') + (e.checked ? '*' : '')).join(','));
    await shows('LR03', async () => (await info('LR03-root')).shown === 4 && (await info('LR03-qty')).shown === 4 && /^NQ\*,MNQ\*,ES/.test(roots), 'the roots: a checkbox, a size and "max N" each: ' + roots);
    await shows('LR04', async x => x.shown === 3 && ['09:45', '15:00', '15:55'].join() === await page.$$eval(H('LR04'), l => l.map(e => e.value).join()), 'the window: from, until, flat at');
    await shows('LR05', async x => x.shown === 3, 'entry lives, trades a day, losing trades');
    await shows('LR06', /^New York time · 0 = no limit$/);
    await shows('LR07', async x => x.texts.join(',') === 'Set,Cancel', 'Set and Cancel');
    item('LR02', !(await info('LR02')).shown, 'the button gives way to the form\'s own Set and Cancel');
    await page.fill(H('LR05-trades'), '51');
    await click('LR07-set');
    await shows('LR09', /^Trades a day must be 0 \(no limit\) or a whole number from 1 to 50/, 'checked before sending, the error under the button');
    const rulesSent = async () => (await sent()).filter(m => m.type === 'agentRules');
    await page.fill(H('LR05-trades'), '6');
    await page.press(H('LR05-trades'), 'Enter');
    await until(async () => (await rulesSent()).length === 1, 'Enter in a form input saves the rules');
    rule('keys', (await rulesSent()).length === 1 && (await rulesSent())[0].maxTrades === 6, 'Enter in a rules input sends agentRules (the view\'s handler, never the document\'s)');
    await until(async () => /at most 6/.test(await text('LR01')), 'the new rules show');
    item('LR01', /at most 6/.test(await text('LR01')), 'the rules after a change: ' + await text('LR01'));
    item('LR07', !!(await until(async () => (await text('LR09')) === 'Sent.' || (await text('LR09')) === '', 'Sent.')), 'Set sends: "Sent." under the button');
    await click('LR02'); await until(async () => (await info('LR03')).shown, 'open again');
    await click('LR07-cancel');
    item('LR07', !(await info('LR03')).shown && (await info('LR02')).shown && (await rulesSent()).length === 1, 'Cancel closes the form; nothing sent');

    /* ---------------------------------------------------------------- notes and plans: his stream */
    console.log('his stream: notes and plans');
    await control('agent-note', { agent: 'demo', kind: 'notebook', text: 'Sample notebook v3: fade the first touch of a made-up level' });
    await control('agent-note', { agent: 'demo', kind: 'look', text: 'Sample: price is pressing the made-up overnight high with shrinking volume' });
    await control('agent-note', { agent: 'demo', kind: 'thinking', text: 'Sample thinking: the push into the level is slowing; a pullback to the made-up VWAP gives a cleaner long. ' + 'More sample words to make this long enough to collapse. '.repeat(3) });
    await control('agent-skip', { agent: 'demo', id: 'sk1', setup: 'Sample breakout', reason: 'Sample: no clean level within reach' });
    await control('agent-plan', { agent: 'demo', id: 'sh1', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 12, target: 24, expire: 900, setup: 'Sample shadow', reason: 'Sample: a plan in Shadow' });
    await control('agent-note', { agent: 'demo', kind: 'lesson', text: 'Sample lesson: wait for the second touch on a slow open' });
    await control('agent-note', { agent: 'demo', kind: 'status', text: 'Sample status: watching MNQ and NQ' });
    await until(async () => (await text('SM01-count')) === '5 notes · 2 plans', 'five notes and two plans');
    await shows('SM01', async () => (await text('SM01')) === 'His stream' && (await text('SM01-count')) === '5 notes · 2 plans', 'his stream and its count');
    await shows('SM03', async x => x.shown === 7 && await page.$$eval(H('SM03'), l => l.every(e => e.tagName === 'BUTTON' && e.type === 'button' && e.hasAttribute('aria-expanded') && e.getAttribute('aria-controls'))), 'every row a real button (time, tag, text), aria-expanded, aria-controls');
    await shows('SM04', async x => ['LOOK', 'THINKING', 'LESSON', 'NOTEBOOK', 'STATUS'].every(t => x.texts.includes(t)), 'the note rows\' tags');
    await shows('SM05', async x => x.shown === 2 && /shadow \(nothing placed\)/.test(await text('SM03')), 'the plan rows (shadow, a pass)');
    check(/\.\.\.$/.test(await page.locator(H('SM03')).filter({ has: page.locator(H('SM04'), { hasText: /^THINKING$/ }) }).first().textContent().then(t => t.replace(/›\s*$/, '').trim())), 'a long note is cut with "..."');
    await click('SM02-plans');
    await until(async () => (await info('SM04')).shown === 0, 'the Plans filter');
    item('SM02', (await info('SM05')).shown === 2 && (await P('attr', 'SM02-plans', 'aria-selected')) === 'true' && await page.evaluate(() => /plans/.test(localStorage.getItem('live-agent-feed-v1'))), 'Plans: the plans only, selected, kept in this browser');
    await click('SM02-thinking');
    item('SM02', !!(await until(async () => (await info('SM04')).texts.join() === 'THINKING', 'Thinking')), 'Thinking: his thinking only');
    await click('SM02-lesson');
    item('SM02', !!(await until(async () => (await info('SM04')).texts.join() === 'LESSON', 'Lessons')), 'Lessons: his lessons only');
    await click('SM02-notes');
    item('SM02', !!(await until(async () => (await info('SM04')).shown === 5 && (await info('SM05')).shown === 0, 'Notes')), 'Notes: the notes only');
    await click('SM02-all');
    await until(async () => (await info('SM03')).shown === 7, 'All');
    await shows('LM07', /Sample shadow: shadow \(nothing placed\)/, 'his last plan');
    await shows('C02', null, 'the light\'s line after his notes');
    item('C03', (await page.$$eval(H('C03'), l => l.filter(e => e.getAttribute('aria-current') === 'step').length)) === 1, 'one step is the step now');

    /* ---------------------------------------------------------------- the drawer */
    console.log('the decision drawer');
    const thinkRow = page.locator(H('SM03')).filter({ has: page.locator(H('SM04'), { hasText: /^THINKING$/ }) }).first();
    await thinkRow.click();
    await until(async () => (await info('D01')).shown, 'the drawer opens');
    await shows('D01', async () => (await P('attr', 'D01', 'role')) === 'dialog' && (await thinkRow.getAttribute('aria-expanded')) === 'true', 'the drawer (role dialog), its row marked open', true);
    rule('focus', await P('focused', 'D03'), 'the drawer\'s Close gets the focus when it opens');
    await shows('D02', async () => /^\d\d:\d\d:\d\d · THINKING$/.test(await text('D02-when')) && (await text('D02-title')) === 'His thinking', 'its head: time and tag, the title');
    await shows('D03', /^Close$/);
    await shows('D04', /More sample words to make this long enough to collapse\. More sample words/, 'his full words');
    await shows('D05', /^Logged/, 'the facts');
    await click('ST02');
    await page.keyboard.press('Escape');
    await sleep(200);
    rule('keys', (await info('D01')).shown > 0, 'Escape with the focus outside the drawer leaves it (no page-wide key handler)');
    await page.focus(H('D03'));
    await page.keyboard.press('Escape');
    await until(async () => !(await info('D01')).shown, 'Escape from inside the drawer closes it');
    rule('keys', !(await info('D01')).shown, 'Escape from inside the drawer closes it');
    rule('focus', await page.evaluate(() => !!document.activeElement && document.activeElement.matches('[data-parity~="SM03"]') && document.activeElement.getAttribute('aria-expanded') === 'false'), 'the focus goes back to its row');
    await thinkRow.click(); await until(async () => (await info('D01')).shown, 'open again');
    await thinkRow.click();
    item('D01', !!(await until(async () => !(await info('D01')).shown, 'the same row closes it')), 'the same row again closes it');
    await thinkRow.click(); await until(async () => (await info('D01')).shown, 'open again');
    await click('D03');
    item('D03', !!(await until(async () => !(await info('D01')).shown, 'Close closes it')), 'Close closes it');

    /* ---------------------------------------------------------------- Copilot: a proposal */
    console.log('Copilot: a proposal in the slot');
    await click('LM02-copilot');
    await until(async () => (await text('ST06')) === 'COPILOT', 'Copilot');
    await shows('ST06', /^COPILOT$/, 'the mode chip at once');
    await shows('LM02', async () => (await P('attr', 'LM02-copilot', 'aria-pressed')) === 'true', 'Copilot pressed');
    const cp1 = await control('agent-plan', { agent: 'demo', id: 'cp1', side: 'buy', kind: 'limit', p: 25390, qty: 2, stop: 16, target: 32, expire: 600, setup: 'Sample pullback', reason: LONG, confidence: 0.64 });
    check(!cp1.refused, 'a proposal: ' + (cp1.refused || 'proposed'));
    await until(async () => (await info('P03')).shown, 'the proposal shows');
    await sleep(300);
    await shows('P03', async () => (await P('attr', 'P03', 'role')) === 'alertdialog' && /^Copilot proposal from Demo Agent: Buy 2 MNQ$/.test(await P('attr', 'P03', 'aria-label')), 'the card (role alertdialog, its label)', true);
    await shows('P04', async () => (await text('P04-name')) === 'Demo Agent' && (await text('P04-id')) === 'demo' && (await text('P04-mark')) === 'SIM', 'the head: name, id, SIM');
    await shows('P05', /^(9|10):\d\d$/, 'the countdown');
    await shows('P06', /^Buy 2 MNQ limit 25,390\.00$/);
    await shows('P07', async () => (await text('P07-setup')) === 'Sample pullback' && /0\.64$/.test(await text('P07-conf')), 'setup and confidence');
    await shows('P08', /^Sample: the pullback to the made-up VWAP held twice/);
    await shows('P09', /^16 ticks \(25,386\.00\)$/); await shows('P10', /^32 ticks \(25,398\.00\)$/); await shows('P11', /^\$16\.00, reward 2\.00 to 1$/);
    await shows('P12', /^\d\d:\d\d:\d\d ET$/); await shows('P13', /^SIM-AG1 SIM$/);
    await shows('P14', async () => (await P('box', 'P14')).height >= 15, 'ChartBridge\'s words: a line reserved even empty');
    await shows('P15', /^Accept\s*Alt\+Y$/, 'Accept with its key'); await shows('P16', /^Reject\s*Alt\+N$/, 'Reject with its key');
    await shows('K02', async x => x.texts.join() === 'Alt+Y,Alt+N', 'the keycaps: The Desk\'s Accept and Reject keys');
    await shows('P19', /^1 open$/);
    item('P02', !(await info('P02-empty')).shown, 'with a proposal "None open" goes; the slot keeps its height');
    await until(async () => (await sent()).some(m => m.type === 'agentSeen' && m.id === 'cp1'), 'agentSeen');
    await sleep(500);
    item('P18', (await sent()).filter(m => m.type === 'agentSeen' && m.id === 'cp1').length === 1, 'agentSeen sent once, the moment it shows');
    await until(async () => (await info('LT01-lit')).shown === 2, 'a plan waiting: the light on the tracker and the proposal');
    item('LT01', (await A()).light.phase === 'plan' && (await info('LT01-lit')).shown === 2, 'a plan waiting lights two panels: ' + JSON.stringify((await A()).light.panels));
    item('C02', /^A plan is waiting for you$/.test(await text('C02')), 'the light\'s line: ' + await text('C02'));
    item('LR02', (await text('LR02')) === 'Change the window' && !(await P('disabled', 'LR02')), 'a proposal open: Change the window');
    item('LR09', /open proposal: only the window \(entries from, until, flat at\) can change now/.test(await text('LR09')), 'and why: ' + await text('LR09'));
    item('CH01', /^MNQ/.test(await text('CH01')), 'the chart on the proposal\'s root: ' + await text('CH01'));
    /* the focus holds on Reject over several renders (an agent message each second) */
    await page.focus(H('P16'));
    const held = []; for (let i = 0; i < 5; i++) { await sleep(700); held.push(await P('focused', 'P16')); }
    rule('focus', held.every(Boolean), 'the focus stays on Reject over 3.5 s of renders: ' + JSON.stringify(held));
    /* a drawer opened with a proposal open sits below the proposal */
    await thinkRow.click(); await until(async () => (await info('D01')).shown, 'the drawer with a proposal open');
    item('D01', (await P('box', 'D01')).top >= (await P('box', 'P02')).bottom && !(await P('hit', ['P15', 'P16'], true)).length, 'never over an open proposal: its top under the slot, Accept and Reject uncovered');
    await click('D03');
    /* never covered, at every size; the slot's height fixed */
    for (const [w, h] of [[1000, 800], [1366, 768], [1600, 900], [1440, 1000], [1920, 1080], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h }); await sleep(600);
      await page.evaluate(phone => { window.scrollTo(0, 0); for (const b of document.querySelectorAll('[data-parity~="view"] *')) if (b.scrollTop) b.scrollTop = 0; if (phone) document.querySelector('[data-parity~="P02"]').scrollIntoView({ block: 'start' }); }, w < 720);
      await sleep(150);
      const bad = await P('hit', ['P15', 'P16'], true), seen = await P('inWindow', ['P15', 'P16']);
      rule('covered', !bad.length && seen, 'at ' + w + ' x ' + h + ' Accept and Reject are in the window, their centre and corners the buttons themselves' + (bad.length ? ': ' + bad.slice(0, 3).join('; ') : seen ? '' : ': not in the window'));
      const slot = (await P('box', 'P02')).height, want = Math.min(380, Math.max(190, h * 0.3));
      rule('heights', Math.abs(slot - want) <= 1 && Math.round((await P('box', 'O01')).height) === 30, 'at ' + w + ' x ' + h + ' the slot ' + slot.toFixed(1) + ' px (clamp: ' + want.toFixed(1) + ') and the line under it 30 px');
    }
    await page.setViewportSize({ width: 1600, height: 900 }); await sleep(500);
    /* nothing arriving moves Accept: a note, and the workspace's ChartBridge line coming and going */
    const accAt = async () => JSON.stringify(await P('box', 'P15'));
    const a0 = await accAt();
    await control('agent-note', { agent: 'demo', kind: 'look', text: 'Sample: a look while the proposal is open' });
    await control('status', { level: 'warn', text: 'Sample: EVAL-B is gone (disconnected for 10 s): entries wait until it is back' });
    await until(() => page.isVisible('#wsAlert'), 'the ChartBridge line shows');
    await sleep(300);
    const a1 = await accAt();
    await shows('N03', /Sample: EVAL-B is gone/, 'the workspace\'s ChartBridge line while the tab is shown');
    item('N03', await P('inside', 'N03', 'CH10'), 'wider than 1100 px it lies over the chart (CH10), covering no control');
    await page.click('#wsAlertClose');
    await sleep(300);
    const a2 = await accAt();
    rule('moved', a0 === a1 && a1 === a2 && !(await P('hit', ['P15', 'P16'], true)).length, 'a note arriving and the ChartBridge line coming and going move no Accept and cover none: ' + [a0, a1, a2].join(' / '));
    await shows('CH10', null, 'the chart\'s overlay holds the notices and the ChartBridge line');

    /* ---------------------------------------------------------------- Accept: his entry, the owner lock, the lines */
    console.log('Accept: his entry works, the owner lock, the chart\'s lines');
    await click('P15');
    await until(async () => (await info('P17')).shown, 'the card ends', 6000);
    await shows('P17', async () => (await page.$$eval(H('P17') + ' button', l => l.every(b => b.disabled))) && /accepted/i.test(await page.$eval(H('P17'), e => e.querySelector('[data-parity~="P14"]').textContent)), 'a card that ended: its buttons closed, its end words', true);
    item('P17', !!(await until(async () => !(await info('P03')).n, 'the ended card goes', 4000)), 'gone after 1.5 s (accepted)');
    rule('messages', (await sent()).filter(m => m.type === 'agentAnswer').every(m => Object.keys(m).filter(k => !k.startsWith('__')).join(',') === 'type,cid,agent,id,answer,at'), 'agentAnswer: exactly the contract\'s keys, no order fields');
    await until(async () => (await A()).orders.some(o => o.by === 'agent:demo' && o.role === 'entry'), 'his working entry');
    await until(async () => (await info('ST10')).shown, 'the owner lock');
    await shows('ST10', /^OWNS SIM-AG1 MNQ$/, 'the owner lock');
    item('ST10', /owner lock/.test(await P('attr', 'ST10', 'title')), 'its tooltip says what the owner lock is');
    await until(async () => (await page.evaluate(() => window.__trade.length)) && (await page.evaluate(() => (window.__trade[window.__trade.length - 1] || {}).orders || [])).some(o => o.by === 'agent:demo'), 'the chart\'s lines');
    const tr1 = await page.evaluate(() => window.__trade[window.__trade.length - 1]);
    item('CH08', tr1.root === 'MNQ' && tr1.account === 'SIM-AG1' && tr1.orders.some(o => o.by === 'agent:demo' && o.role === 'entry') && tr1.orders.filter(o => o.by).every(o => o.by === 'agent:demo') && tr1.orders.length >= 3,
      'his working entry and its planned stop and target as lines on his chart, by agent:demo only: ' + tr1.orders.map(o => (o.role || o.kind || '?') + (o.by ? '/' + o.by : '')).join(', '));
    const own = await page.evaluate(() => { const d = window.__desks[0]; return d && typeof d.ownerOf === 'function' ? [d.ownerOf('SIM-AG1', 'MNQ'), d.ownerOf('SIM-AG2', 'MNQ'), d.ownerOf('SIM-AG1', 'NQ')] : null; });
    item('W03', !!own && own[0] === 'demo' && own[1] === '' && own[2] === '', 'ownerOf in the AgentDesk API (the order ticket refuses a resting order on his pair): ' + JSON.stringify(own));
    await shows('LR02', /^Change the window$/, 'an entry working: Change the window');
    item('LA04', await P('disabled', 'LA04') && /working entry|flat/i.test(await P('attr', 'LA04', 'title')), 'an entry working: Change account closed, its tooltip says why: ' + await P('attr', 'LA04', 'title'));
    await until(async () => /accepted in \d+\.\d s/.test((await info('SM05')).text + ' ' + await text('SM03')), 'the plan row says accepted');
    item('SM05', /accepted in \d+\.\d s/.test(await text('SM03')), 'the plan row says how it ended');
    /* his record of the accepted plan in a short window: "more below", it scrolls inside itself */
    await page.setViewportSize({ width: 1366, height: 768 }); await sleep(500);
    await click('SM02-plans');
    const planRow = page.locator(H('SM03')).filter({ hasText: /accepted in/ }).first();
    await planRow.click();
    await until(async () => (await info('D01')).shown, 'the plan\'s record');
    await shows('D05', async x => x.shown >= 8 && /Entry\s*Buy 2 MNQ, limit 25,390\.00/.test(x.text) && /Stop\s*16 ticks, 25,386\.00/.test(x.text), 'a plan\'s facts: entry, stop, target, risk, the checks, the proposal');
    await shows('D04', /pullback to the made-up VWAP held twice/, 'the plan\'s reason in his words');
    await until(async () => (await info('D06')).shown, 'more below', 3000);
    await shows('D06', /^more below$/, 'a record taller than its drawer says "more below"');
    const ds = await page.evaluate(async () => { const d = document.querySelector('[data-parity~="D01"]'); const tall = d.scrollHeight > d.clientHeight; d.scrollTop = d.scrollHeight; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return { tall, page: document.documentElement.scrollHeight <= innerHeight }; });
    const r3d = await P('r3All');
    rule('R3', !r3d.length, 'with the drawer open nothing of the tab moves (the drawer appears at once)' + (r3d.length ? ': ' + r3d.slice(0, 5).join('; ') : ''));
    item('D06', ds.tall && ds.page && !!(await until(async () => !(await info('D06')).shown, 'scrolled to its end')), 'it scrolls inside itself (never the page), and at its end "more below" goes');
    await click('D03');
    await click('SM02-all');
    await page.setViewportSize({ width: 1600, height: 900 }); await sleep(400);

    /* ---------------------------------------------------------------- in a trade */
    console.log('in a trade');
    await control('price', { root: 'MNQ', p: 25389.75 });
    await until(async () => /Long 2 MNQ/.test(await text('ST09')), 'demo is long 2 MNQ', 15000);
    await shows('ST09', /^Position\s*Long 2 MNQ @ 25,390\.00$/, 'the position');
    await shows('CH05', /^long 2 mnq @ 25,390\.00$/, 'the chart\'s header position');
    await control('price', { root: 'MNQ', p: 25393 });
    await until(async () => /^\+\$/.test(await text('CH06')), 'the open P&L', 15000);
    await shows('CH06', /^\+\$\d/, 'the open P&L, a gain');
    await shows('F02', /^Today · open \+\$\d/, 'today, open P&L beside it');
    await until(async () => (await info('SM06')).shown, 'the fill row');
    await shows('SM06', /^FILL$/, 'a fill row');
    item('SM06', /Bought 2 MNQ at 25,390\.00/.test(await text('SM03')), 'its words');
    await until(async () => (await info('F06')).shown, 'the trail mark');
    await shows('F06', /^F$/, 'the trail marks his fill');
    item('F06', /^Bought 2 MNQ at 25,390\.00$/.test(await P('attr', 'F06', 'title')), 'its tooltip: ' + await P('attr', 'F06', 'title'));
    const tr2 = await page.evaluate(() => window.__trade[window.__trade.length - 1]);
    item('CH08', !!tr2.position && tr2.position.qty === 2, 'his position line on the chart: ' + JSON.stringify(tr2.position));
    await until(async () => (await page.evaluate(() => window.__trades.slice(-1)[0] || 0)) > 0, 'his trades on the chart');
    item('CH09', (await page.evaluate(() => window.__trades.slice(-1)[0] || 0)) > 0 && (await A()).trips.length > 0, 'his trades today as marks on his chart: ' + (await A()).trips.length);
    await until(async () => (await A()).light.phase === 'trade', 'in a trade: the light on the chart and the P&L');
    item('LT01', (await info('LT01-lit')).shown === 2 && (await A()).light.panels.join() === 'chart,pnl', 'in a trade the chart and the footer glow');
    /* the window only, and a window that flattens him now asks first */
    await click('LR02');
    await until(async () => (await info('LR04')).shown, 'the form, window only');
    item('LR05', await page.$$eval(H('LR05'), l => l.every(e => e.disabled)) && await page.$$eval(H('LR03-qty'), l => l.every(e => e.disabled)), 'in a trade the other rules are closed (window only)');
    item('LR04', await page.$$eval(H('LR04'), l => l.every(e => !e.disabled)), 'in a trade the window stays open');
    const rs = (await rulesSent()).length;
    await page.fill(H('LR04-from'), '11:30');
    await click('LR07-set');
    await until(async () => (await info('LR08')).shown, 'the question');
    await shows('LR08', async () => /in his flat hours now \(flat at 15:55, new entries from 11:30\): ChartBridge flattens his position at once/.test(await text('LR08-text')) && (await P('attr', 'LR08', 'role')) === 'alertdialog' && (await info('LR08-yes')).shown && (await info('LR08-no')).shown, 'a window that flattens him now asks first, in the page');
    rule('focus', await P('focused', 'LR08-no'), 'the window-flatten question focuses its Cancel');
    await click('LR08-no');
    item('LR08', !(await info('LR08')).shown && (await rulesSent()).length === rs, 'Cancel: nothing sent');
    await click('LR07-cancel');
    await shows('LR09', /in a trade|only the window/i, 'in a trade: why only the window can change');
    const r3t = await P('r3All');
    rule('R3', !r3t.length, 'in a trade nothing of the tab moves but the light and the glow' + (r3t.length ? ': ' + r3t.slice(0, 5).join('; ') : ''));
    const still = await page.evaluate(() => ['ST09-pos', 'CH05', 'CH06', 'F01', 'F02', 'F03', 'F04'].map(id => { const e = document.querySelector('[data-parity~="' + id + '"]'); if (!e) return id + ' missing'; return e.closest('[data-no-motion]') ? '' : id + ' not under data-no-motion'; }).filter(Boolean));
    rule('R3', !still.length, 'the position, the P&L figures and the footer sit under data-no-motion' + (still.length ? ': ' + still.join(', ') : ''));
    await page.screenshot({ path: path.join(SHOTS, 'agent-parity-trade.png') });
    /* out at the target */
    await control('price', { root: 'MNQ', p: 25399 });
    await until(async () => /^Position\s*Flat$/.test(await text('ST09')), 'out at the target', 15000);
    await until(async () => (await info('SM07')).shown, 'the exit row');
    await shows('SM07', /^EXIT$/, 'an exit row');
    item('SM07', /Out of long 2 MNQ, \+\$\d/.test(await text('SM03')), 'its words: out of long, the result');
    await until(async () => (await info('F06')).texts.includes('X'), 'the X mark');
    item('F06', (await info('F06')).texts.join() === 'F,X' || (await info('F06')).texts.join() === 'X,F', 'F in, X out on the trail');
    await until(async () => /^\+\$/.test(await text('F01')), 'today\'s P&L', 8000);
    await shows('F01', /^\+\$\d/, 'today\'s P&L after the trade');
    await shows('F03', /^1 of 6\s*Trades$/, 'one trade, of the six his rules allow'); await shows('F04', /^0\s*Losses$/, 'no loss');
    item('CH06', (await text('CH06')) === '', 'flat: no open P&L');

    /* ---------------------------------------------------------------- expiry: the last 5 s */
    console.log('expiry: Accept closes in the last 5 s');
    await control('agent-plan', { agent: 'demo', id: 'cp2', side: 'sell', kind: 'limit', p: 25410, qty: 1, stop: 20, target: 40, expire: 60 });
    await until(async () => (await info('P03')).shown, 'cp2');
    await control('agent-expire', { agent: 'demo', id: 'cp2', ms: 4000 });
    await until(async () => /too late to accept/.test(await text('P14')), 'under 5 s left');
    await shows('P14', /^Under 5 s left: too late to accept\. Reject still goes\.$/, 'ChartBridge\'s words above the buttons');
    item('P15', await P('disabled', 'P15'), 'Accept closes in the last 5 s');
    item('P16', !(await P('disabled', 'P16')), 'Reject still goes');
    item('P05', (await P('attr', 'P05', 'class') || '').includes('late') || /^0:0\d$/.test(await text('P05')), 'the countdown under a minute: ' + await text('P05'));
    await until(async () => (await info('P17')).shown, 'expired', 10000);
    item('P17', !!(await until(async () => !(await info('P03')).n, 'the expired card goes', 6000)), 'an expired card goes after 3 s');

    /* ---------------------------------------------------------------- the keys, the corner, the tab button */
    console.log('the copilot keys; off the tab: the corner line, the tab button\'s mark');
    const answers = async () => (await sent()).filter(m => m.type === 'agentAnswer' || m.type === 'botAnswer');
    await control('agent-plan', { agent: 'demo', id: 'k1', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 12, target: 24, expire: 900 });
    await until(async () => (await info('P03')).shown, 'k1');
    await sleep(1200);
    const n0 = (await answers()).length;
    await click('C01');
    await page.keyboard.press('Alt+KeyN');
    await until(async () => (await answers()).length > n0, 'the Reject key');
    await sleep(500);
    const k1 = (await answers()).slice(n0);
    item('K01', k1.length === 1 && k1[0].agent === 'demo' && k1[0].id === 'k1' && k1[0].answer === 'reject', 'the Reject key (The Desk\'s Alt+N) answers the shown agent\'s proposal, once: ' + JSON.stringify(k1.map(m => m.id + ':' + m.answer)));
    rule('keys', k1.length === 1, 'the copilot keys through the one router');
    await until(async () => !(await info('P03')).n, 'k1 gone', 5000);
    await control('agent-plan', { agent: 'demo', id: 'k2', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 12, target: 24, expire: 900 });
    await until(async () => (await info('P03')).shown, 'k2');
    await click('W01');
    await until(async () => !(await A()).shown, 'the tab closes');
    item('W02', !!(await until(async () => / W02-waiting/.test(await P('attr', 'W02', 'data-parity')), 'the waiting mark')), 'the tab closed with a proposal open: the tab button marks it');
    await until(async () => (await info('CO01')).shown, 'the corner\'s line');
    await shows('CO01', /^Demo Agent: 1 proposal$/, 'off the tab, one line in the corner counts his proposals');
    item('CO01', Math.round((await P('box', 'CO01')).height) === 30 && (await P('attr', 'CO01', 'role')) === 'region', 'the line: 30 px, a region');
    item('CO03', await page.evaluate(() => { const b = document.querySelector('.bt-props'); return !!b && getComputedStyle(b).getPropertyValue('--bt-corner-bottom').trim() === '56px'; }), 'agents known, the tab closed: the bot\'s corner keeps the room of the agents\' line');
    rule('cards', !(await page.evaluate(() => [...document.querySelectorAll('[data-agans]')].some(b => b.getClientRects().length))), 'off the tab no agent Accept or Reject anywhere');
    const n1 = (await answers()).length;
    await page.mouse.click(800, 450);
    await page.keyboard.press('Alt+KeyY');
    await sleep(900);
    item('K01', (await answers()).length === n1, 'off the tab no key answers an agent\'s proposal');
    await page.locator(H('CO01') + ' ' + H('O02')).first().click();
    await until(async () => (await A()).shown && (await info('P03')).shown, 'the corner\'s name opens the tab on demo, k2 in the slot');
    item('CO01', (await A()).chosen === 'demo' && !(await info('CO01')).shown, 'its name opens the tab on that agent; the line hides with the tab shown');
    await click('P16');
    await until(async () => !(await info('P03')).n, 'k2 rejected and gone', 5000);
    await click('W01'); await until(async () => !(await A()).shown, 'the tab closes');
    await page.mouse.click(800, 450);
    await page.keyboard.press('Alt+KeyN');
    item('K01', !!(await until(async () => /no copilot proposal to answer here/.test(await page.textContent('#wsNote')), 'the workspace says so')), 'with none open the key says so');
    await click('W01'); await until(async () => (await A()).shown, 'the tab again');

    /* ---------------------------------------------------------------- the bot's proposals: counted under the slot */
    console.log('the bot\'s proposal while the tab is shown: counted under the slot, its corner hidden');
    await control('bot-connect', { name: 'Sample Lantern Fade' });
    await control('bot-proposal', { id: 'b1', side: 'sell', kind: 'market', stop: 12, target: 24, reason: 'Sample: the made-up bot\'s signal' });
    await until(async () => (await text('O01')) === 'Bot: 1 proposal', 'the line counts the bot\'s');
    await shows('O01', /^Bot: 1 proposal$/, 'the line under the slot counts the bot\'s proposal');
    await shows('O02', /^Bot$/, 'its name a link');
    await shows('O03', /^Bot: 1 proposal$/, 'a count that rose is marked at once');
    item('O01', Math.round((await P('box', 'O01')).height) === 30, 'the line keeps 30 px');
    item('O03', !(await P('r3', 'O03', true)).length, 'still: no transition or animation (R3)');
    item('CO02', await page.evaluate(() => { const b = document.querySelector('.bt-props'); return !!b && !!b.querySelector('[data-id="b1"]') && getComputedStyle(b).display === 'none'; }), 'the Bot tab\'s corner (its card for b1) hidden while the Agent tab is shown');
    rule('cards', !(await page.evaluate(() => [...document.querySelectorAll('[data-agans], [data-ans]')].some(b => b.getClientRects().length))), 'with only the bot\'s open, no Accept or Reject on the page');
    await sleep(1100);
    const nb = (await answers()).length;
    await click('C01');
    await page.keyboard.press('Alt+KeyY');
    await sleep(700);
    item('K01', (await answers()).length === nb && /keys answer only demo's proposals/.test(await page.textContent('#wsNote')), 'with the tab open the keys answer only the shown agent\'s proposals (the bot\'s is hidden), and say so: ' + await page.textContent('#wsNote'));
    await page.locator(H('O01') + ' ' + H('O02')).first().click();
    item('O02', !!(await until(() => page.evaluate(() => window.workspace.bot().shown && !window.workspace.agent().shown), 'the Bot tab opens')), 'the bot\'s name opens the Bot tab');
    await control('bot-withdraw', { id: 'b1' });
    await click('W01'); await until(async () => (await A()).shown, 'the Agent tab again');
    await until(async () => (await text('O01')) === 'No other proposals', 'none elsewhere');

    /* ---------------------------------------------------------------- the LIVE account question */
    console.log('a LIVE account asks once, in the page');
    await until(async () => !(await P('disabled', 'LA04')), 'Change account open again', 8000);
    await click('LA04');
    await page.selectOption(H('LA05-sel'), 'EVAL-A');
    const before = (await sent()).filter(m => /^agent/.test(m.type)).length;
    await click('LA05-set');
    await until(async () => (await info('LA06')).shown, 'the question');
    await shows('LA06', async () => /^Agent demo will trade LIVE account EVAL-A in Copilot\. Continue\?$/.test(await text('LA06-text')) && (await P('attr', 'LA06', 'role')) === 'alertdialog' && (await text('LA06-yes')) === 'Continue' && (await text('LA06-no')) === 'Cancel', 'the LIVE question: ' + await text('LA06-text'));
    rule('focus', await P('focused', 'LA06-yes'), 'the LIVE question focuses Continue');
    item('LA06', (await sent()).filter(m => /^agent/.test(m.type)).length === before, 'nothing sent before Continue');
    await click('LA06-no');
    item('LA06', !(await info('LA06')).shown, 'Cancel closes it');
    rule('messages', (await sent()).filter(m => /^agent/.test(m.type)).every(m => AGENT_SENDS.includes(m.type)) && !(await sent()).some(m => m.type === 'order' && /SIM-AG/.test(m.account || '')),
      'the only agent messages are ' + AGENT_SENDS.join(', ') + '; no order for an agent: ' + [...new Set((await sent()).filter(m => /^agent/.test(m.type)).map(m => m.type))].join(','));

    /* ---------------------------------------------------------------- the chart's own controls */
    await page.selectOption(H('CH03'), 'm5');
    item('CH03', !!(await until(async () => / · 5 min$/.test(await text('CH01')), 'the chart on 5 min')) && await page.evaluate(() => /m5/.test(localStorage.getItem('live-agent-chart-v1'))), 'Bars 5 min: the chart\'s title follows, kept in this browser');
    await page.selectOption(H('CH03'), 'm1');
    await page.selectOption(H('CH02'), 'NQ');
    item('CH02', !!(await until(async () => /^NQ/.test(await text('CH01')), 'the chart on NQ')), 'the root select puts the chart on NQ: ' + await text('CH01'));
    await page.selectOption(H('CH02'), 'MNQ');
    await until(async () => /^MNQ/.test(await text('CH01')), 'MNQ again');
    rule('storage', await page.evaluate(() => ['live-agent-chosen-v1', 'live-agent-chart-v1', 'live-agent-fills-v1', 'live-agent-feed-v1', 'live-agent-motion-v1'].every(k => localStorage.getItem(k) !== null)), 'the tab\'s choices kept in this browser: chosen, chart, fills, feed, motion');
    item('CH04', await page.$eval(H('CH04'), e => getComputedStyle(e).display === 'contents' || e.getBoundingClientRect().height > 0) && (await info('CH04')).shown > 0, 'the chart\'s indicators menu and chips in its header');

    /* ---------------------------------------------------------------- the small screens */
    console.log('the small screens');
    await control('agent-plan', { agent: 'demo', id: 'ss1', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 12, target: 24, expire: 900, setup: 'Sample', reason: LONG });
    await until(async () => (await info('P03')).shown, 'a proposal for the sizes');
    await page.setViewportSize({ width: 1366, height: 768 }); await sleep(700);
    const fit = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, w: innerWidth, h: innerHeight }));
    item('SS01', fit.sw <= fit.w && fit.sh <= fit.h && (await P('box', 'CH07')).bottom <= (await P('box', 'SS-foot')).top + 1 && (await P('box', 'SS-foot')).bottom <= 769 && await P('inWindow', ['P15', 'P16']),
      '1366 x 768: the whole tab in the window, no page scroll, the chart ends above the footer, Accept and Reject in sight: ' + JSON.stringify(fit));
    item('N04', !(await info('N04')).shown, 'wider than 1100 px there is no tray');
    await page.setViewportSize({ width: 1000, height: 800 }); await sleep(700);
    await page.evaluate(() => { window.scrollTo(0, 0); for (const b of document.querySelectorAll('[data-parity~="view"] *')) if (b.scrollTop) b.scrollTop = 0; });
    const L = await P('box', 'SS-controls'), R = await P('box', 'SS-right'), C = await P('box', 'SS-centre');
    item('SS02', Math.abs(L.top - R.top) <= 1 && L.right <= R.left + 1 && C.top >= Math.max(L.bottom, R.bottom) - 1 && C.height >= 380 && C.left <= L.left + 1 && C.right >= R.right - 1 && await P('inWindow', ['P15', 'P16']),
      '1000 x 800: the controls and the proposal with the stream side by side at the top, the chart under both, Accept and Reject in the window: ' + JSON.stringify({ L: [L.left, L.top, L.right, L.bottom], R: [R.left, R.top, R.bottom], C: [C.left, C.top, C.right] }));
    await shows('N04', async () => Math.round((await P('box', 'N04')).height) === 66, 'at 1100 px and narrower the tray: 66 px');
    await control('status', { level: 'warn', text: 'Sample: a made-up warning for the tray' });
    await until(() => page.isVisible('#wsAlert'), 'the line');
    await sleep(200);
    item('N03', await P('inside', 'N03', 'N04') && !(await P('hit', ['P15', 'P16'], true)).length, 'at 1100 px and narrower the ChartBridge line is in the tray (N04), over no Accept or Reject');
    await page.click('#wsAlertClose');
    await page.evaluate(() => { const box = document.querySelector('[data-parity~="N02"]'); const d = document.createElement('div'); d.className = 'ag-note'; d.dataset.parity = 'N01'; d.textContent = 'Sample notice for the tray'; box.prepend(d); });
    item('N02', await P('inside', 'N02', 'N04'), 'at 1100 px and narrower the notices sit in the tray');
    await page.evaluate(() => { for (const n of document.querySelectorAll('[data-parity~="N01"]')) n.remove(); });
    await page.setViewportSize({ width: 390, height: 844 }); await sleep(800);
    await page.evaluate(() => window.scrollTo(0, 0));
    const ph = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
    const L2 = await P('box', 'SS-controls'), R2 = await P('box', 'SS-right'), C2 = await P('box', 'SS-centre');
    /* the words under the account and the rules keep two lines even empty, and the mode's words keep theirs while hidden too
       (Layout 5, chart 1.23.0: before it workspace.css [hidden] won over agent.css and the hidden line took none) */
    const twoLines = () => page.evaluate(ids => ids.map(id => { const e = document.querySelector('[data-parity~="' + id + '"]'); return e.getBoundingClientRect().height >= 2 * parseFloat(getComputedStyle(e).lineHeight) - 1; }), ['LA07', 'LR09', 'LM03']);
    const why2 = await twoLines();
    why2.push(await page.evaluate(() => { const e = document.querySelector('[data-parity~="LM03"]'); return e.hidden && getComputedStyle(e).visibility === 'hidden'; }));
    await click('LM02-auto');
    await until(async () => (await info('LM03')).shown, 'Auto armed on a phone');
    why2.push(await page.evaluate(() => { const e = document.querySelector('[data-parity~="LM03"]'); return e.getBoundingClientRect().height >= 2 * parseFloat(getComputedStyle(e).lineHeight) - 1; }));
    await sleep(4300);
    await page.evaluate(() => document.querySelector('[data-parity~="P02"]').scrollIntoView({ block: 'start' })); await sleep(200);
    item('SS03', ph.sw <= ph.w && L2.bottom <= R2.top + 1 && R2.bottom <= C2.top + 1 && why2.every(Boolean) && await P('inWindow', ['P15', 'P16']),
      '390 x 844: one column (controls, proposal and stream, chart), no sideways scroll, the words under mode, account and rules keep two lines, Accept and Reject in the proposal\'s first screen: ' + JSON.stringify({ ph, why2 }));
    await shows('N04', async () => Math.round((await P('box', 'N04')).height) === 96, 'on a phone the tray: 96 px');
    rule('heights', Math.round((await P('box', 'N04')).height) === 96 && why2.every(Boolean), 'the tray 96 px on a phone; the words under mode, account and rules two lines');
    await page.setViewportSize({ width: 1600, height: 900 }); await sleep(500);

    /* ---------------------------------------------------------------- the pop-out */
    console.log('the pop-out (agent.html)');
    const [pop] = await Promise.all([ctx.waitForEvent('page'), click('ST14')]);
    pop.on('pageerror', e => fail('pop-out error: ' + e.message));
    await pop.waitForLoadState();
    item('ST14', /\/live\/agent\.html$/.test(pop.url()), 'Pop out opens agent.html: ' + pop.url());
    if (await pop.waitForSelector('.cb-pin-key', { timeout: 5000 }).catch(() => null)) await enterPin(pop, TEST_PIN);
    await pop.waitForFunction(() => window.agentDesk && window.agentDesk.state().agents.length === 1, null, { timeout: 20000 });
    const T2 = tools(pop);
    await until(async () => (await T2.info('P03')).shown, 'the pop-out shows the proposal');
    await pop.setViewportSize({ width: 1500, height: 900 }); await sleep(800);
    await T2.shows('PO01', async () => (await T2.text('PO01-title')) === 'AGENT' && /^\d\d:\d\d:\d\d ET$/.test(await T2.text('PO01-clock')) && /^ChartBridge places every agent order inside its rules\. This window takes no orders of its own\.$/.test(await T2.text('PO01-note')), 'the pop-out\'s header: AGENT, the New York clock, its line');
    await T2.shows('PO02', async () => !(await T2.info('ST14')).n && !(await T2.info('CO01')).n && (await T2.info('ST02')).text === 'Demo Agent' && await pop.evaluate(() => document.fonts.check('600 12px "Chakra Petch"') && document.fonts.check('12px "JetBrains Mono"') && document.fonts.check('12px "IBM Plex Sans"')),
      'the same tab on its own connection: no Pop out, no corner line, the tab\'s fonts');
    item('K02', (await T2.info('K02')).n === 0, 'no keycaps in the pop-out (no keys there)');
    await control('bot-proposal', { id: 'b2', side: 'sell', kind: 'market', stop: 12, target: 24, reason: 'Sample: the made-up bot\'s signal' });
    await until(async () => (await T2.text('O01')).startsWith('Bot: 1 proposal'), 'the pop-out counts the bot\'s');
    item('O02', await pop.$eval(H('O01') + ' ' + H('O02'), e => e.tagName === 'SPAN' && e.title === 'Answered on the Bot tab of the workspace'), 'in the pop-out the bot is plain text, its title says where it is answered');
    item('PO02', !!(await T2.info('O02')).shown, 'the bot as plain text in the pop-out\'s count line');
    await control('bot-withdraw', { id: 'b2' });
    for (const [w, h] of [[1366, 768], [1920, 1080], [390, 844]]) {
      await pop.setViewportSize({ width: w, height: h }); await sleep(600);
      await pop.evaluate(phone => { window.scrollTo(0, 0); if (phone) document.querySelector('[data-parity~="P02"]').scrollIntoView({ block: 'start' }); }, w < 720);
      await sleep(150);
      const bad = await T2.P('hit', ['P15', 'P16'], true);
      rule('covered', !bad.length && await T2.P('inWindow', ['P15', 'P16']), 'the pop-out at ' + w + ' x ' + h + ': Accept and Reject in the window, uncovered' + (bad.length ? ': ' + bad.slice(0, 3).join('; ') : ''));
      if (w === 1366) await pop.screenshot({ path: path.join(SHOTS, 'agent-parity-popout.png') });
    }
    await pop.setViewportSize({ width: 1500, height: 900 });
    await pop.close();
    await control('agent-withdraw', { agent: 'demo', id: 'ss1' });
    await page.close();
    await ctx.close();
    bridge.kill(); bridge = null;
  }

  /* ====================================================================== phase 2: two agents and the PC helper */
  if (PHASES.includes(2)) {
    console.log('phase 2: --agents=demo,demotwo and the fake PC helper on 8767');
    bridge = await startBridge(['--agents=demo,demotwo', '--agent-any-time', '--max-qty=MNQ:20,NQ:2']);
    helper = await startFakeHelper({ bridgePort: port, agents: ['demo', 'demotwo'] });
    const ctx = await newContext(browser);
    const asks = [];
    ctx.on('request', r => { if (r.url().startsWith('http://localhost:8767/') && r.method() !== 'OPTIONS') asks.push({ url: r.url(), at: Date.now(), unlock: r.headers()['x-chartbridge-unlock'] || '' }); });
    const page = await openPage(ctx, `http://localhost:${port}/live/?layout=Main`, workspaceReady);
    const { P, info, text, A, sent, shows, click } = tools(page);
    await control('price', { root: 'MNQ', p: 25400 });
    await until(async () => (await A()).agents.length === 2, 'ChartBridge told of demo and demotwo');
    await control('agent-connect', { agent: 'demotwo', name: 'Second Demo Agent', build: 'sample-build-7' });
    await page.click('.ws-panel.tape [data-act="close"]'); await tabBtn(page, 'agentdesk');   // 1.35.0: W01 in the Agent desk panel
    await click('W01');
    await until(async () => (await A()).shown, 'the tab opens');
    await until(async () => (await info('ST12')).shown, 'the picker');
    await page.selectOption(H('ST12-pick'), 'demo');
    await until(async () => (await A()).chosen === 'demo', 'demo shown');
    await shows('ST12', async () => (await page.$$eval(H('ST12-pick') + ' option', o => o.map(x => x.textContent).join('|'))) === 'demo|Second Demo Agent (demotwo)' && (await page.$eval(H('ST12-n'), e => e.textContent)) === '2 agents' && await page.evaluate(() => localStorage.getItem('live-agent-chosen-v1') === '"demo"'),
      'two agents: the picker ("N agents", "Name (id)"), the choice kept in this browser');
    await shows('ST05', /^NO AGENT PROGRAM YET$/, 'an agent with no program yet');
    await shows('SM08', /^Nothing yet · not connected$/, 'an empty stream, not connected');
    await click('LA04'); await page.selectOption(H('LA05-sel'), 'SIM-AG1'); await click('LA05-set');
    await until(async () => (await text('ST07')).includes('SIM-AG1'), 'demo trades SIM-AG1');
    /* the PC helper: the picker, the spend, On offered */
    await until(async () => (await page.$$eval(H('OH02') + ' option', o => o.length)) === 3, 'the picker fills from the helper');
    await shows('OH02', async () => (await page.$$eval(H('OH02') + ' option', o => o.map(x => x.value).join())) === 'sample-build-1,sample-build-3,sample-build-2', 'Shadow on Sim: the heroes, then the build over the bar');
    await shows('OH13', /^No Shadow bar set: every build is listed in Shadow\.$/, 'the picker\'s note');
    await shows('OH05', /^Session \$1\.84$/); await shows('OH06', /^Overall \$1,234\.50$/);
    await shows('OH07', /^Off: no model calls, no spend\.$/, 'the helper\'s state');
    item('OH03', !(await P('disabled', 'OH03')) && await P('disabled', 'OH04'), 'On offered, Off not (he is off)');
    /* the helper asked every 3 s while the tab is shown, with the PIN unlock; not while it is closed */
    const k0 = asks.length; await sleep(7000); const k1 = asks.slice(k0);
    await click('W01'); await until(async () => !(await A()).shown, 'the tab closed'); const k2 = asks.length; await sleep(4000); const k3 = asks.length;
    await click('W01'); await until(async () => (await A()).shown, 'the tab again');
    item('OH12', k1.length >= 2 && k1.length <= 4 && asks.every(x => /^v1\.[0-9a-f]{32}\.[0-9a-f]{64}$/.test(x.unlock)) && k3 === k2, 'the helper asked every 3 s while the tab is shown (' + k1.length + ' in 7 s), each with the PIN unlock; none while it is closed (' + (k3 - k2) + ')');
    /* On with a build that is not a hero */
    await page.selectOption(H('OH02'), 'sample-build-2');
    await click('OH03');
    await until(async () => (await agentNow('demo')).connected, 'the helper started him');
    await until(async () => (await text('ST02')) === 'sample-build-2', 'the header shows the build id (no hero name)');
    item('OH03', helper.calls.some(c => c.route === 'POST /on' && c.body.agent === 'demo' && c.body.build === 'sample-build-2'), 'On: POST /on {agent, build}');
    const stripText = (await Promise.all(['ST01', 'ST02', 'ST03', 'ST05', 'ST06', 'ST07', 'ST09', 'ST10', 'ST11'].map(text))).join(' ');
    item('ST04', !(await info('ST04')).shown && !/bbbbbbbbbbbb/.test(stripText), 'a build running: still no build chip and no stamp in the header: "' + stripText + '"');
    await shows('LM08', /^sample-build-2 bbbbbbbbbbbb$/, 'the Build row: the build id and stamp');
    await until(async () => await P('disabled', 'LM02-copilot'), 'Copilot closes for a build that is not a hero');
    await shows('OH11', async () => await P('disabled', 'LM02-copilot') && await P('disabled', 'LM02-auto') && /^sample-build-2 is not a hero: Shadow on a Sim account only\.$/.test(await P('attr', 'LM02-copilot', 'title')), 'a build that is not a hero: Copilot and Auto closed, the title says why');
    await click('LA04'); await page.selectOption(H('LA05-sel'), 'EVAL-A');
    const acctN = (await sent()).filter(m => m.type === 'agentAccount').length;
    await click('LA05-set');
    item('OH11', (await text('LA07')) === 'sample-build-2 is not a hero: it trades a Sim account only. Turn him Off and pick a hero first.' && !(await info('LA06')).shown && (await sent()).filter(m => m.type === 'agentAccount').length === acctN, 'and a LIVE account is refused: ' + await text('LA07'));
    await click('LA05-cancel');
    await click('OH04');
    await until(async () => !(await agentNow('demo')).connected, 'Off: the helper ended him');
    item('OH04', helper.calls.filter(c => c.route === 'POST /off').length === 1 && !(await info('OH08')).shown, 'Off when flat: POST /off at once, no question');
    /* On with a hero: Copilot, a trade, Off asks */
    await until(async () => !(await P('disabled', 'OH02')), 'the picker opens again');
    await page.selectOption(H('OH02'), 'sample-build-3');
    await click('OH03');
    await until(async () => (await text('ST02')) === 'Demo 2', 'the header says Demo 2');
    await until(async () => !(await P('disabled', 'LM02-copilot')), 'a hero may go to Copilot');
    await click('LM02-copilot');
    await until(async () => (await agentNow('demo')).mode === 'copilot', 'Copilot');
    await until(async () => (await text('OH13')) === 'Heroes only in Copilot.', 'heroes only');
    await shows('OH13', /^Heroes only in Copilot\.$/, 'the picker\'s note in Copilot');
    item('OH03', (await P('attr', 'OH03', 'aria-pressed')) === 'true', 'On pressed while he runs');
    /* the second agent: his own account and Copilot, then his proposals counted under the slot */
    await page.selectOption(H('ST12-pick'), 'demotwo');
    await until(async () => (await A()).chosen === 'demotwo', 'demotwo shown');
    await click('LA04'); await page.selectOption(H('LA05-sel'), 'SIM-AG2'); await click('LA05-set');
    await until(async () => (await agentNow('demotwo')).account === 'SIM-AG2', 'demotwo trades SIM-AG2');
    await click('LM02-copilot');
    await until(async () => (await agentNow('demotwo')).mode === 'copilot', 'demotwo in Copilot');
    await page.selectOption(H('ST12-pick'), 'demo');
    await until(async () => (await A()).chosen === 'demo', 'demo shown');
    await control('agent-plan', { agent: 'demo', id: 'oo1', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 12, target: 24, expire: 900 });
    await until(async () => (await info('P03')).shown, 'demo\'s proposal');
    const acc0 = JSON.stringify(await P('box', 'P15'));
    await control('agent-plan', { agent: 'demotwo', id: 'q2', side: 'buy', kind: 'limit', p: 25390, qty: 1, stop: 16, target: 32, expire: 900, setup: 'Sample Q', reason: LONG, confidence: 0.6 });
    await until(async () => (await text('O01')) === 'Second Demo Agent: 1 proposal', 'the line counts demotwo\'s');
    await shows('O01', /^Second Demo Agent: 1 proposal$/, 'the second agent\'s proposal counted under the slot');
    await shows('O02', /^Second Demo Agent$/, 'its name a link');
    await shows('O03', /^Second Demo Agent: 1 proposal$/, 'its count marked as risen');
    await sleep(300);
    rule('moved', JSON.stringify(await P('box', 'P15')) === acc0 && Math.round((await P('box', 'O01')).height) === 30, 'the second agent\'s proposal arriving moves no Accept; the line keeps 30 px');
    rule('cards', (await info('P03')).shown === 1 && (await text('P04-id')) === 'demo' && !(await page.evaluate(() => [...document.querySelectorAll('[data-agans], [data-ans]')].some(b => b.getClientRects().length && !b.closest('[data-parity~="P02"]')))), 'only the shown agent\'s proposal is a card; no other Accept or Reject on the page');
    await page.locator(H('O01') + ' ' + H('O02')).first().click();
    await until(async () => (await A()).chosen === 'demotwo' && (await text('P04-id')) === 'demotwo', 'demotwo shown, his proposal in the slot');
    item('O02', (await text('O01')) === 'Demo Agent: 1 proposal' || (await text('O01')) === 'Demo 2: 1 proposal', 'an agent\'s name shows that agent in the tab; the line now counts the other: ' + await text('O01'));
    await page.locator(H('O01') + ' ' + H('O02')).first().click();
    await until(async () => (await A()).chosen === 'demo', 'demo again');
    await control('agent-withdraw', { agent: 'demotwo', id: 'q2' });
    await until(async () => (await text('O01')) === 'No other proposals', 'none elsewhere');
    rule('moved', JSON.stringify(await P('box', 'P15')) === acc0, 'and its leaving moves nothing');
    /* in a trade: Off asks, for this agent */
    await click('P15');
    await until(async () => (await A()).orders.some(o => o.by === 'agent:demo' && o.role === 'entry'), 'his entry works');
    await control('price', { root: 'MNQ', p: 25389.75 });
    await until(async () => /Long 1 MNQ/.test(await text('ST09')), 'demo is long 1 MNQ', 15000);
    const fl0 = (await sent()).filter(m => m.type === 'flatten').length;
    await click('OH04');
    await until(async () => (await info('OH08')).shown, 'Off in a trade asks');
    await shows('OH08', async () => (await text('OH08-text')) === 'Demo 2 holds long 1 MNQ on SIM-AG1. Flatten and turn him off?' && (await P('attr', 'OH08', 'role')) === 'alertdialog' && (await text('OH08-flat')) === 'Flatten and turn off' && (await text('OH08-no')) === 'Keep him on', 'the question: ' + await text('OH08-text'));
    rule('focus', await P('focused', 'OH08-no'), 'the Off question focuses "Keep him on"');
    await click('OH08-no');
    await sleep(500);
    item('OH08', !(await info('OH08')).shown && helper.calls.filter(c => c.route === 'POST /off').length === 1 && (await sent()).filter(m => m.type === 'flatten').length === fl0 && (await agentNow('demo')).connected, '"Keep him on": nothing sent, he stays on');
    /* Flatten and turn off: Shadow first, the page's own Flatten (held here a moment), Off once flat */
    await page.evaluate(() => { window.__dropFlatten = true; });
    await click('OH04');
    await until(async () => (await info('OH08')).shown, 'asked again');
    await click('OH08-flat');
    await until(async () => (await sent()).filter(m => m.type === 'flatten').length === fl0 + 1, 'the Flatten goes after Shadow');
    const sh = (await sent()).filter(m => m.type === 'agentMode').pop(), fl = (await sent()).filter(m => m.type === 'flatten').pop();
    await shows('OH09', async () => /^Flatten sent for SIM-AG1 MNQ \(he is in Shadow\): turning him off once flat\.\.\.$/.test(await text('OH07')) && sh.agent === 'demo' && sh.mode === 'shadow' && sh.__at <= fl.__at && fl.account === 'SIM-AG1' && fl.root === 'MNQ' && /Turning him off/.test(await P('attr', 'LM02-copilot', 'title')),
      'Shadow first, then the page\'s own Flatten {account, root}; the line waits for flat; the modes wait too: ' + await text('OH07'));
    await page.evaluate(() => { window.__dropFlatten = false; });
    await control('price', { root: 'MNQ', p: 25399 });                                     // out at the target: flat
    await until(async () => helper.calls.filter(c => c.route === 'POST /off').length === 2, 'Off once he is flat', 20000);
    item('OH09', !!(await until(async () => (await text('OH07')) === 'Flat. Off: his program ends, no more model calls.', 'the line says flat, then off')) && !(await sent()).some(m => m.type === 'order' && m.account === 'SIM-AG1'), 'flat, then Off; the page built no order for him');
    /* the folded settings */
    item('OH14', !(await info('OH14')).shown, 'the settings are folded at first');
    await click('OH10');
    item('OH10', !!(await until(async () => (await info('OH14')).shown, 'the settings open')), 'the summary "Auto-On and daily cap" opens the settings form');
    await shows('OH14', async () => (await info('OH14-auto')).shown && (await info('OH14-cap')).shown && (await info('OH14-set')).shown, 'Auto-On, Daily cap $, Set');
    await page.fill(H('OH14-auto'), '09:30'); await page.fill(H('OH14-cap'), '5');
    await click('OH14-set');
    item('OH14', !!(await until(async () => /^Set\./.test(await text('OH14-why')), 'set')) && helper.calls.some(c => c.route === 'POST /settings' && c.body.autoOn === '09:30' && c.body.cap === 5), 'Set: POST /settings, and its line: ' + await text('OH14-why'));
    await page.close();
    await ctx.close();
    await helper.close(); helper = null;
    bridge.kill(); bridge = null;
  }

  /* ====================================================================== phase 3: no agents */
  if (PHASES.includes(3)) {
    console.log('phase 3: a ChartBridge with no agents line');
    /* a current ChartBridge (0.5.2): since 1.22.0 (#41) the tab reads the version for this text only, and the fake's hello
       without agents says fake-0.4.0, which gets "No agents on this ChartBridge (0.5.2 or later)." (test/agent-smoke.mjs does
       the same) */
    bridge = await startBridge(['--version=0.5.2']);
    const ctx = await newContext(browser);
    const page = await openPage(ctx, `http://localhost:${port}/live/?layout=Main&tab=agent`, workspaceReady);
    const { info, text, sent, shows } = tools(page);
    await until(async () => /none is named/.test(await text('OF01-text')), 'the "no agents" card');
    await shows('OF01', async () => (await text('OF01-text')) === 'No agents on this ChartBridge: none is named in its config.txt (agents = ...).', 'no agent known: the card says why (1.21.0: the version is not read)');
    item('O04', !(await info('O04')).shown, 'its count line hidden while nothing is open');
    await control('bot-connect', { name: 'Sample Lantern Fade' });
    await control('bot-proposal', { id: 'b9', side: 'sell', kind: 'market', stop: 12, target: 24, reason: 'Sample: the made-up bot\'s signal' });
    await until(async () => (await info('O04')).shown, 'the count line on the card');
    await shows('O04', /^Bot: 1 proposal$/, 'something open: the card counts it');
    item('OF01', !(await sent()).some(m => /^agent/.test(m.type)), 'nothing agent is sent');
    await page.close();
    await ctx.close();
    bridge.kill(); bridge = null;
  }
} catch (e) {
  fail('smoke stopped: ' + (e && e.stack || e));
} finally {
  if (helper) await helper.close();
  if (bridge) bridge.kill();
  await browser.close();
}

/* every item of the list asserted, and every assertion passed */
const missing = LIST.items.map(x => x.id).filter(id => !done.has(id));
const failed = [...done].filter(([, r]) => !r.ok).map(([id]) => id);
check(LIST.count === LIST.items.length && !missing.length, 'every item of test/agent-parity.json asserted: ' + done.size + ' of ' + LIST.items.length + (missing.length ? ' (not asserted: ' + missing.join(', ') + ')' : ''));
console.log('\nparity: ' + (done.size - failed.length) + ' of ' + LIST.items.length + ' items hold' + (failed.length ? ' (failed: ' + failed.join(', ') + ')' : '') + '; rules: ' + [...rules].map(([k, r]) => k + (r.ok ? '' : ' FAILED')).join(', '));
console.log(errors.length ? '\n' + errors.length + ' of ' + checks + ' checks failed' : '\nall ' + checks + ' checks passed');
process.exit(errors.length ? 1 : 0);
