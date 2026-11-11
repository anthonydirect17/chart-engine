/*
 * The Fleet tab (chart 1.45.0, build plan 2026-11-10, B1, first cut): the Prop Business on the chart page. One place for the
 * traders (the bots and agents on ChartBridge's agent channel) and the prop accounts they trade.
 *
 * FIRST CUT. It is added beside the Agent, Bot and League tabs and replaces none of them yet. It shows only what ChartBridge
 * itself says on the window's own connection, so every value is live and nothing is sample data:
 *   - Kill all: flatten and stop. ChartBridge 0.6.17's `agentKillAllProp`: every trader on prop accounts is flattened, its kill
 *     switch goes on and its mode goes to Shadow. It asks first, in the page (two buttons, no browser dialog). It never touches
 *     the personal account, a Sim account, the bot, the copier or an order placed by hand: ChartBridge decides that, not the page.
 *   - Traders: each one's mode, account, window, what it is doing, why it is stood down, the day's profit stop its plan named
 *     (ChartBridge 0.6.19), and its two entry switches, Market entry and No target (0.6.18), so a market entry with no target is
 *     never a surprise (the coordinator's condition, 2026-11-11). Read only: a switch is changed on the Agent tab, by a person.
 *   - Prop accounts: stage (the group's Type), progress to the target, the cushion to the floor, today, the day's profit stop
 *     mark and where it comes from, and what would stop the runner sizing it (no group Type: size 0).
 * What the mockup also shows and this cut does not: the money tiles, today's plan, the live trades against the backtest band,
 * and the feed. They need The Desk and the live runner, and are said plainly on the tab as not built yet.
 *
 * "Prop" is ChartBridge's word (`prop` on each row of the `accounts` message, 0.6.16): every live account that is not the
 * personal account Anthony picked. With no pick nothing is prop, and the tab says how to pick.
 *
 * Nothing here places an order. The one message it can send is `agentKillAllProp`.
 *
 * Two parts, as league.js: FleetCore (pure: Node tests, test/fleet.test.js) and, in a browser, FleetView (the tab).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FleetCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const KILL_MIN = '0.6.17';       // ChartBridge that knows agentKillAllProp
const SWITCH_MIN = '0.6.18';     // ... the two entry switches
const DAYSTOP_MIN = '0.6.19';    // ... the day's profit stop
const CONFIRM_MS = 8000;         // the Kill all question stays this long
const MODE_NAME = { shadow: 'Shadow', copilot: 'Copilot', auto: 'Auto' };
const isNum = v => typeof v === 'number' && isFinite(v);
const plainObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n || 200) : '');

function parseVersion(v) { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? [+m[1], +m[2], +m[3]] : null; }
function atLeast(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

/** Dollars for the tab: "$1,200", "-$310", "+$310" with sign true; "" when not a number. Whole dollars unless cents matter. */
function usd(v, sign) {
  if (!isNum(v)) return '';
  const a = Math.abs(v), cents = Math.abs(a - Math.round(a)) > 0.004;
  const body = '$' + a.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  return (v < 0 ? '-' : sign && v > 0 ? '+' : '') + body;
}

/** The rows of the `accounts` message by name (lower case). */
function accountIndex(accountsMsg) {
  const m = new Map();
  for (const a of (accountsMsg && Array.isArray(accountsMsg.list) ? accountsMsg.list : [])) if (plainObj(a) && typeof a.name === 'string') m.set(a.name.toLowerCase(), a);
  return m;
}
/** The groups of the `groups` message (its `list`) by id. */
function groupIndex(groupsMsg) {
  const m = new Map();
  for (const g of (groupsMsg && Array.isArray(groupsMsg.list) ? groupsMsg.list : [])) if (plainObj(g) && typeof g.id === 'string') m.set(g.id, g);
  return m;
}

/** 'prop', 'personal', 'sim' or '' (not known, or no personal account picked) for one row of the accounts message. */
function kindOf(row) {
  if (!plainObj(row)) return '';
  if (row.prop === true) return 'prop';
  if (row.personal === true) return 'personal';
  if (row.sim === true) return 'sim';
  return '';
}

/**
 * The day's profit stop for one account, as ChartBridge 0.6.19 computes it (ChartBridgeAgents.DayMark): the smaller of the
 * plan's value and, on an account that is not funded, its consistency percent of its profit target. -> { mark, from } or null.
 */
function dayMark(rules, stage, planValue) {
  let mark = 0, from = '';
  if (isNum(planValue) && planValue > 0) { mark = planValue; from = "the plan's day stop"; }
  const r = plainObj(rules) ? rules : null;
  if (stage !== 'funded' && r && isNum(r.consistency) && r.consistency > 0 && isNum(r.target) && r.target > 0) {
    const c = Math.round(r.consistency / 100 * r.target * 100) / 100;
    if (c > 0 && (mark === 0 || c < mark)) { mark = c; from = r.consistency + '% of the ' + usd(r.target) + ' target'; }
  }
  return mark > 0 ? { mark, from } : null;
}

/** The accounts one trader is on, from its `agent` message: its account, or its group's seats. */
function traderAccounts(agent) {
  const a = agent || {};
  if (plainObj(a.group) && Array.isArray(a.seats)) return a.seats.filter(x => plainObj(x) && typeof x.account === 'string').map(x => x.account);
  return typeof a.account === 'string' && a.account ? [a.account] : [];
}

/** What a trader is doing, in a few words (the Agent tab's own order of reasons). */
function statusText(a) {
  if (!a) return 'Not known yet';
  if (a.enabled === false) return 'Off in ChartBridge';
  if (a.killed) return 'Kill switch on';
  if (a.standDown) return 'Stood down: ' + str(a.standDown, 300);
  if (!a.connected) return 'Not connected: its program is not running';
  if (isNum(a.lastBeatMs) && a.lastBeatMs > 5000) return 'Heartbeat late (' + (a.lastBeatMs / 1000).toFixed(1) + ' s)';
  return a.owns ? 'In a trade' : 'Watching';
}

/**
 * The traders, one row each, in id order. agents: the `agent` messages (a list); accountsMsg; version: ChartBridge's.
 * -> [{ id, name, build, mode, modeText, connected, onDuty, status, tone, accounts, accountText, kind, window, flatAt,
 *       marketEntry, noTarget, switchesKnown, dayStop, dayStopKnown, pnlToday, trades }]
 * onDuty: in Auto, connected, not killed, not stood down, on prop accounts only: it can place an order now.
 */
function traders(agents, accountsMsg, version) {
  const idx = accountIndex(accountsMsg);
  const out = [];
  for (const a of (Array.isArray(agents) ? agents : [])) {
    if (!plainObj(a) || typeof a.agent !== 'string') continue;
    const names = traderAccounts(a);
    const kinds = names.map(n => kindOf(idx.get(n.toLowerCase())));
    const kind = !names.length ? 'none' : kinds.every(k => k === 'prop') ? 'prop' : kinds.every(k => k === 'personal') ? 'personal' : kinds.every(k => k === 'sim') ? 'sim' : kinds.some(k => k === '') ? '' : 'mixed';
    const r = plainObj(a.rules) ? a.rules : {};
    const mode = MODE_NAME[a.mode] ? a.mode : '';
    const live = a.enabled !== false && a.connected === true && !a.killed && !a.standDown;
    out.push({
      id: a.agent, name: str(a.name, 40) || a.agent, build: str(a.build, 40), mode, modeText: MODE_NAME[mode] || 'Not known',
      connected: a.connected === true, onDuty: live && mode === 'auto' && kind === 'prop',
      status: statusText(a), tone: a.enabled === false ? 'off' : a.killed ? 'killed' : a.standDown ? 'standDown' : !a.connected ? 'lost' : 'on',
      accounts: names, accountText: !names.length ? 'None' : plainObj(a.group) ? 'Group ' + (str(a.group.name, 40) || str(a.group.id, 12)) + ': ' + names.join(', ') : names[0],
      kind, window: str(r.entryFrom, 5) && str(r.entryUntil, 5) ? str(r.entryFrom, 5) + ' to ' + str(r.entryUntil, 5) : '', flatAt: str(r.flatAt, 5),
      marketEntry: r.marketEntry === true, noTarget: r.noTarget === true, switchesKnown: atLeast(version, SWITCH_MIN),
      dayStop: isNum(a.dayStop) && a.dayStop > 0 ? a.dayStop : null, dayStopKnown: atLeast(version, DAYSTOP_MIN),
      pnlToday: isNum(a.pnlToday) ? a.pnlToday : null, trades: isNum(a.trades) ? a.trades : null,
    });
  }
  return out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * The prop accounts, one row each, in name order. -> [{ name, stage, stageText, group, connection, made, target, progressText,
 *   cushion, cushionWhy, today, mark, markText, done, traders: [ids], position, sizeNote }]
 * stage: 'eval', 'funded' or '' (its group has no Type, or it is in no group: the runner sizes it 0 and Fleet says so).
 * done: today is at or over the day's profit stop.
 */
function propAccounts(accountsMsg, groupsMsg, agents) {
  const groups = groupIndex(groupsMsg);
  const rows = [];
  for (const a of (accountsMsg && Array.isArray(accountsMsg.list) ? accountsMsg.list : [])) {
    if (!plainObj(a) || a.prop !== true || typeof a.name !== 'string') continue;
    const g = typeof a.group === 'string' ? groups.get(a.group) : null;
    const stage = g && (g.accountType === 'eval' || g.accountType === 'funded') ? g.accountType : '';
    const rules = plainObj(a.rules) ? a.rules : null;
    const target = rules && isNum(rules.target) && rules.target > 0 ? rules.target : null;
    const made = target !== null && isNum(a.targetLeft) ? Math.round((target - a.targetLeft) * 100) / 100 : null;
    const on = (Array.isArray(agents) ? agents : []).filter(x => plainObj(x) && traderAccounts(x).some(n => n.toLowerCase() === a.name.toLowerCase()));
    const plan = on.map(x => (isNum(x.dayStop) && x.dayStop > 0 ? x.dayStop : 0)).filter(Boolean);
    const dm = dayMark(rules, stage, plan.length ? Math.min.apply(null, plan) : 0);
    const today = isNum(a.pnlToday) ? a.pnlToday : null;
    const pos = (Array.isArray(a.positions) ? a.positions : []).filter(p => plainObj(p) && isNum(p.qty) && p.qty !== 0)
      .map(p => (p.qty > 0 ? 'Long ' : 'Short ') + Math.abs(p.qty) + ' ' + str(p.root || p.name, 12)).join(', ');
    rows.push({
      name: a.name, stage, stageText: stage === 'eval' ? 'Eval' : stage === 'funded' ? 'Funded' : 'No type',
      group: g ? str(g.name, 40) : '', connection: str(a.connection, 20),
      made, target, progressText: target === null ? 'no target in its rules' : made === null ? 'not known' : usd(made) + ' of ' + usd(target),
      cushion: isNum(a.roomFloor) ? a.roomFloor : null, cushionWhy: plainObj(a.why) ? str(a.why.roomFloor, 200) : '',
      today, mark: dm ? dm.mark : null,
      markText: dm ? (today !== null ? usd(today) + ' of ' : '') + usd(dm.mark) + ' (' + dm.from + ')' : stage === 'funded' ? 'none (funded, and no plan value)' : 'none',
      done: !!dm && today !== null && today >= dm.mark - 1e-9,
      traders: on.map(x => x.agent), position: pos || (a.connection === 'connected' ? 'Flat' : 'Not connected'),
      sizeNote: !g ? 'In no group: the runner sizes it 0 (it reads the stage from the group\'s Type)' : !stage ? 'Its group has no Type (eval or funded): the runner sizes it 0' : '',
    });
  }
  return rows.sort((x, y) => (x.name.toLowerCase() < y.name.toLowerCase() ? -1 : x.name.toLowerCase() > y.name.toLowerCase() ? 1 : 0));
}

/** May Kill all be sent now? -> { ok, why }. */
function killAllState(version, accountsMsg, signedIn, connected) {
  if (!connected) return { ok: false, why: 'ChartBridge is not connected' };
  if (!atLeast(version, KILL_MIN)) return { ok: false, why: 'Kill all needs ChartBridge ' + KILL_MIN + ' or later (this one is ' + (version || 'not known') + ')' };
  if (!signedIn) return { ok: false, why: 'Sign in to trading first (the PIN in the top bar)' };
  if (!accountsMsg || accountsMsg.personalNamed !== true) return { ok: false, why: 'No personal account is picked yet, so no account is prop: pick it on the Accounts tab (an account\'s settings, This is my personal account)' };
  return { ok: true, why: '' };
}
const killAllMsg = cid => Object.assign({ type: 'agentKillAllProp' }, cid ? { cid } : {});

/** The line under the title: who can place an order now. */
function dutyLine(rows) {
  const on = rows.filter(t => t.onDuty);
  if (on.length > 1) return 'On duty: ' + on.map(t => t.name).join(', ') + ' (more than one trader in Auto on prop accounts)';
  if (on.length === 1) return 'On duty: ' + on[0].name + ', Auto on ' + on[0].accountText;
  return rows.length ? 'Nobody on duty: no trader is in Auto on prop accounts' : 'No traders yet';
}

return { KILL_MIN, SWITCH_MIN, DAYSTOP_MIN, CONFIRM_MS, MODE_NAME, atLeast, usd, kindOf, dayMark, traderAccounts, statusText, traders, propAccounts, killAllState, killAllMsg, dutyLine };
});

/* ================================================================================================ the tab (browser only) */
(function () {
'use strict';
if (typeof window === 'undefined' || typeof document === 'undefined') return;
const C = window.FleetCore;
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function create(o) {
  o = o || {};
  const view = o.view || null, tabBtn = o.tab || null, V3 = o.v3 || null;
  const S = { shown: false, version: '', connected: false, signedIn: false, accounts: null, groups: null, agents: new Map(), ask: 0, askTimer: 0, said: '', saidBad: false, saidState: false, cidSeq: 0, pending: '', sent: 0 };
  const agentList = () => [...S.agents.values()];
  const cid = () => 'fl' + (++S.cidSeq).toString(36) + Math.random().toString(36).slice(2, 6);

  function onMessage(m) {
    switch (m && m.type) {
      case 'hello': S.version = typeof m.version === 'string' ? m.version : ''; S.connected = true; offer(); break;
      case 'trading': S.signedIn = !!m.enabled; break;
      case 'accounts': S.accounts = m; break;
      case 'groups': S.groups = m; break;
      case 'agent': if (m && typeof m.agent === 'string') S.agents.set(m.agent, m); break;
      case 'reject': if (S.pending && m.cid === S.pending) { S.pending = ''; say(typeof m.reason === 'string' ? m.reason : 'ChartBridge refused it', true); } break;
      case 'status': if (typeof m.text === 'string' && /^Kill all \(prop accounts\)/.test(m.text)) { S.pending = ''; say(m.text, m.level === 'error'); } break;
      default: return;
    }
    if (S.saidState && C.killAllState(S.version, S.accounts, S.signedIn, S.connected).why !== S.said) say('', false);
    if (S.shown) render();
  }
  function lost() { S.connected = false; S.signedIn = false; S.agents.clear(); S.accounts = null; S.groups = null; S.pending = ''; say('', false); endAsk(); if (S.shown) render(); }
  /* the tab button shows with a ChartBridge that has prop accounts (0.6.17: Kill all) */
  function offer() { if (tabBtn) tabBtn.hidden = !C.atLeast(S.version, C.KILL_MIN); }
  /* fromState: the line only repeats why Kill all is not offered; it goes as soon as that reason does */
  function say(text, bad, fromState) { S.said = String(text || ''); S.saidBad = !!bad; S.saidState = !!fromState; }
  function endAsk() { clearTimeout(S.askTimer); S.askTimer = 0; S.ask = 0; }

  function killAll() {
    const st = C.killAllState(S.version, S.accounts, S.signedIn, S.connected);
    endAsk();
    if (!st.ok) { say(st.why, true, true); render(); return; }
    S.pending = cid();
    S.sent++;
    const ok = !!V3 && V3.post(C.killAllMsg(S.pending));
    say(ok ? 'Kill all sent: waiting for ChartBridge' : 'Kill all could not be sent: ChartBridge is not connected', !ok);
    if (!ok) S.pending = '';
    render();
  }

  function traderHtml(t) {
    const sw = t.switchesKnown
      ? `<span class="fl-sw${t.marketEntry ? ' on' : ''}">Market entry: ${t.marketEntry ? 'on' : 'off'}</span><span class="fl-sw${t.noTarget ? ' on' : ''}">No target: ${t.noTarget ? 'on' : 'off'}</span>`
      : `<span class="fl-sw">Entry switches: need ChartBridge ${esc(C.SWITCH_MIN)}</span>`;
    const ds = !t.dayStopKnown ? 'needs ChartBridge ' + esc(C.DAYSTOP_MIN) : t.dayStop !== null ? esc(C.usd(t.dayStop)) + ' (from its plan)' : 'none sent with a plan this session';
    const kind = t.kind === 'prop' ? 'prop' : t.kind === 'personal' ? 'personal' : t.kind === 'sim' ? 'sim' : t.kind === 'mixed' ? 'mixed' : '';
    return `<li class="fl-trader" data-id="${esc(t.id)}" data-tone="${esc(t.tone)}">
      <div class="fl-trow"><span class="fl-tname">${esc(t.name)}</span>${t.build ? `<span class="fl-mut">${esc(t.build)}</span>` : ''}
        <span class="fl-mode" data-mode="${esc(t.mode)}">${esc(t.modeText)}</span>${t.onDuty ? '<span class="fl-duty">ON DUTY</span>' : ''}</div>
      <div class="fl-trow"><span class="fl-k">Account</span><span class="fl-v">${esc(t.accountText)}${kind ? ` <span class="fl-tag" data-kind="${kind}">${kind}</span>` : ''}</span></div>
      <div class="fl-trow"><span class="fl-k">Window</span><span class="fl-v mono">${t.window ? esc(t.window) + ' New York' + (t.flatAt ? ', flat at ' + esc(t.flatAt) : '') : 'not known'}</span></div>
      <div class="fl-trow"><span class="fl-k">Now</span><span class="fl-v fl-status">${esc(t.status)}</span></div>
      <div class="fl-trow"><span class="fl-k">Day stop</span><span class="fl-v mono">${ds}</span></div>
      <div class="fl-trow fl-sws">${sw}</div>
    </li>`;
  }
  function accountHtml(a) {
    const tone = a.today === null ? '' : a.today > 0 ? ' up' : a.today < 0 ? ' down' : '';
    return `<tr data-name="${esc(a.name)}"${a.done ? ' class="fl-done"' : ''}>
      <td><span class="fl-aname">${esc(a.name)}</span><span class="fl-mut">${esc(a.stageText)}${a.group ? ', ' + esc(a.group) : ''}</span>${a.sizeNote ? `<span class="fl-warn">${esc(a.sizeNote)}</span>` : ''}</td>
      <td class="mono">${esc(a.progressText)}</td>
      <td class="mono"${a.cushion === null && a.cushionWhy ? ` title="${esc(a.cushionWhy)}"` : ''}>${a.cushion === null ? 'not known' : esc(C.usd(a.cushion))}</td>
      <td class="mono fl-pnl${tone}">${a.today === null ? 'not known' : esc(C.usd(a.today, true))}</td>
      <td class="mono">${esc(a.markText)}${a.done ? ' <span class="fl-tag" data-kind="done">reached</span>' : ''}</td>
      <td>${esc(a.position)}${a.traders.length ? `<span class="fl-mut">${esc(a.traders.join(', '))}</span>` : '<span class="fl-mut">no trader on it</span>'}</td>
    </tr>`;
  }
  function render() {
    if (!view || !S.shown) return;
    const rows = C.traders(agentList(), S.accounts, S.version), accts = C.propAccounts(S.accounts, S.groups, agentList());
    const st = C.killAllState(S.version, S.accounts, S.signedIn, S.connected);
    const asking = S.ask > 0;
    view.innerHTML = `<div class="fl-wrap">
      <div class="fl-head">
        <span class="fl-title">Fleet</span><span class="fl-dutyline">${esc(C.dutyLine(rows))}</span><span class="fl-fill"></span>
        ${asking
          ? `<span class="fl-ask" role="alertdialog" aria-label="Kill all">Flatten every trader on the prop accounts and stop them?
               <button type="button" class="ws-btn fl-kill" data-do="yes">Yes, kill all</button><button type="button" class="ws-btn" data-do="no">Cancel</button></span>`
          : `<button type="button" class="ws-btn fl-kill" data-do="ask"${st.ok ? '' : ` aria-disabled="true" title="${esc(st.why)}"`}>Kill all: flatten and stop</button>`}
      </div>
      <p class="fl-said${S.saidBad ? ' bad' : ''}" role="status" aria-live="polite">${esc(S.said || (st.ok ? 'Kill all acts on the prop accounts only: your personal account, Sim accounts, the bot, the copier and orders placed by hand are never touched.' : st.why))}</p>
      <div class="fl-cols">
        <section class="fl-box" aria-label="Traders"><h3 class="fl-h">Traders</h3>
          ${rows.length ? `<ul class="fl-traders">${rows.map(traderHtml).join('')}</ul>` : `<p class="fl-empty">${S.connected ? 'No trader is set up in ChartBridge yet.' : 'ChartBridge is not connected.'}</p>`}
          <p class="fl-note">A trader's mode, account, window and its two entry switches are changed on the Agent tab, by you. Nothing here changes them.</p>
        </section>
        <section class="fl-box" aria-label="Prop accounts"><h3 class="fl-h">Prop accounts</h3>
          ${accts.length ? `<div class="fl-scroll"><table class="fl-table"><thead><tr><th>Account</th><th>Progress</th><th>Cushion to floor</th><th>Today</th><th>Day stop</th><th>Status</th></tr></thead>
              <tbody>${accts.map(accountHtml).join('')}</tbody></table></div>`
            : `<p class="fl-empty">${!S.connected ? 'ChartBridge is not connected.' : S.accounts && S.accounts.personalNamed === true ? 'No prop account is connected.' : 'No personal account is picked yet, so no account is prop. Pick it once on the Accounts tab: an account\'s settings, This is my personal account.'}</p>`}
          <p class="fl-note">Today counts realized plus open. The day stop is held by ChartBridge itself: reached while a trader holds something on the account, that trader is flattened and stops until 18:00 New York.</p>
        </section>
      </div>
      <p class="fl-later">Not built yet, so not shown: the money (spent, paid out, profit per $1), today's plan with each account's size, the live trades against the backtest band, and the feed. They come from The Desk and the live runner.</p>
    </div>`;
  }
  function onClick(e) {
    const b = e.target.closest('button[data-do]');
    if (!b) return;
    if (b.dataset.do === 'ask') {
      const st = C.killAllState(S.version, S.accounts, S.signedIn, S.connected);
      if (!st.ok) { say(st.why, true, true); render(); return; }
      S.ask = Date.now();
      clearTimeout(S.askTimer);
      S.askTimer = setTimeout(() => { endAsk(); render(); }, C.CONFIRM_MS);
      render();
      const yes = view.querySelector('[data-do="no"]'); if (yes) yes.focus();      // the safe answer has the focus
    } else if (b.dataset.do === 'yes') { if (S.ask) killAll(); }
    else if (b.dataset.do === 'no') { endAsk(); say('', false); render(); }
  }
  function showTab(on) {
    on = !!on;
    if (on === S.shown) return;
    S.shown = on;
    if (tabBtn) { tabBtn.setAttribute('aria-pressed', String(on)); if (on) tabBtn.hidden = false; }
    if (!on) { endAsk(); if (view) view.innerHTML = ''; }
    if (typeof o.onTab === 'function') o.onTab(on);
    render();
  }
  if (view) view.addEventListener('click', onClick);
  if (tabBtn) tabBtn.addEventListener('click', () => showTab(!S.shown));
  const unlisten = V3 ? V3.listen({ message: onMessage, closed: () => lost() }) : () => {};
  return {
    showTab, shown: () => S.shown, offered: () => !!tabBtn && !tabBtn.hidden,
    hello: m => onMessage(m),
    state: () => ({ shown: S.shown, version: S.version, connected: S.connected, signedIn: S.signedIn, asking: S.ask > 0, said: S.said, sent: S.sent,
      traders: C.traders(agentList(), S.accounts, S.version), accounts: C.propAccounts(S.accounts, S.groups, agentList()) }),
    destroy: () => { unlisten(); endAsk(); if (view) view.removeEventListener('click', onClick); },
  };
}
window.FleetView = { create };
})();
