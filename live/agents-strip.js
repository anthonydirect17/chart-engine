/*
 * The Agents strip (chart 1.36.0, Anthony 2026-10-22, the WORK request "an Agents strip panel: every active agent at a glance"):
 * "I want a panel made, that plays horizontally, but just shows the current active shadow agents and eventually live agents
 * status, so If I dont have their tab pulled up I can still glance over and see their position, spent, stream of thoughts."
 *
 * A panel from + Add panel (at most one a layout), made for the lower left of his Accounts layout (about 1,430 by 450 px): one
 * card per agent, left to right (the league's seats H, S, O first, then the live agents ChartBridge lists), the row scrolling
 * sideways once the cards no longer fit. Each card: the name and colour, the MODE big (SHADOW, SIM, LIVE, or AUTO and COPILOT on
 * no account), its one-word state when it matters (look cap, API stopped, feed down, day stopped, killed, not connected), its
 * position now, its day, its spend and its stream of thoughts, newest first. A click on a thought opens its full reasoning; a
 * click anywhere else on a card opens that agent's full view (the League tab for a seat, the Agent tab for a live agent).
 *
 * Read only. It never sends an order or a control message: it reads what the page already has.
 *   - The seats: The Desk's GET /api/chart-league, through the one league read the workspace already runs (live/workspace.js LG:
 *     the faint marks' poll, or the League view's day while that view is open). No poller of its own.
 *   - The live agents: the Agent tab's own state (live/agent.js glance(), from ChartBridge's `agent` messages, the agent's notes
 *     and plans, its fills and its working orders) and the PC helper's spend when the Agent tab has read it.
 *   - Prices: the workspace's MNQ quote (the same quote socket the Quote board uses).
 * What a card wants and nobody reports says "not reported", never a guess. What the page works out itself (the look cap, open
 * P&L and R from the page's MNQ price, the seats' pool) says so in its title.
 *
 * Motion (docs/MOTION.md R3): none. A new thought is simply the first line the next time the card is drawn; nothing scrolls,
 * slides or fades.
 *
 * Two parts, as league.js: AgentsStripCore (pure: Node tests, test/agents-strip.test.js) and, in a browser, AgentsStrip.mount.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentsStripCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* the seats as the League tab shows them (live/league.js LeagueCore.SEATS: H Haiku amber, S Sonnet cyan, O Opus violet) */
const SEATS = [
  { id: 'H', family: 'Haiku', color: '#FFC266' },
  { id: 'S', family: 'Sonnet', color: '#5DE0F0' },
  { id: 'O', family: 'Opus', color: '#B69CFF' },
];
/* the league's look cap: at most 30 looks in any 60 minutes a seat (Bot-Lab league/config.py LOOKS_PER_HOUR, league/runner.py
   _cap_ok). The league logs it (events.jsonl look_cap) but neither status.json nor The Desk passes it on, so the strip DERIVES it
   from the seat's own decisions (one decision a look) in the 60 minutes before now. */
const LOOKS_PER_HOUR = 30, HOUR_MS = 3600000;
/* MNQ's point value, the league's instrument (Bot-Lab league/config.py POINT_VALUE), when the page has none from ChartBridge */
const MNQ_POINT = 2;
const STATUS_LATE_MS = 120000;              // the league writes status.json every few seconds; two minutes behind is late
const NR = 'not reported';
const THOUGHTS_MAX = 12;

const isNum = v => typeof v === 'number' && isFinite(v);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n || 200) : '');
const pad = n => (n < 10 ? '0' : '') + n;
/** hh:mm of a time in the league's convention (New York wall clock in ms, stored as if UTC). */
const clock = ms => (isNum(ms) ? pad(new Date(ms).getUTCHours()) + ':' + pad(new Date(ms).getUTCMinutes()) : '');
/** The league's time of day "10:41:05" as ms on its date (as if UTC), or null. */
function wallMs(date, hms) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}(:\d{2})?$/.test(hms || '')) return null;
  const v = Date.parse(date + 'T' + (hms.length === 5 ? hms + ':00' : hms) + 'Z');
  return isFinite(v) ? v : null;
}
const money = v => (isNum(v) ? (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
const signedMoney = v => (isNum(v) ? (v > 0 ? '+' : '') + money(v) : '');
const signedR = v => (isNum(v) ? (v > 0 ? '+' : v < 0 ? '-' : '') + Math.abs(v).toFixed(2) + ' R' : '');
const pts = v => (isNum(v) ? (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '') : '');
const px = v => (isNum(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
const tone = v => (isNum(v) ? (v > 0 ? 'up' : v < 0 ? 'down' : '') : '');
/** The first line of a reasoning: up to its first line break (or the runner's " / "), at most n characters. */
function firstLine(text, n) {
  const s = str(text, 2000).split(/\r?\n| \/ /)[0].trim();
  const max = n || 140;
  return s.length > max ? s.slice(0, max - 3).trimEnd() + '...' : s;
}

/**
 * The look cap, DERIVED (the league reports it nowhere the page can read): the seat's decisions in the 60 minutes before nowMs
 * (the league's clock convention). 30 or more: capped, and its next look is when the oldest of the last 30 is an hour old
 * (the league's rule is "any 60 minutes", not the clock hour). Returns { capped, n, nextMs, text }.
 */
function lookCap(decisions, seat, nowMs) {
  const out = { capped: false, n: 0, nextMs: null, text: '' };
  if (!isNum(nowMs)) return out;
  const times = (Array.isArray(decisions) ? decisions : []).filter(d => d && d.seat === seat && isNum(d.t) && d.t <= nowMs && nowMs - d.t < HOUR_MS)
    .map(d => d.t).sort((a, b) => a - b);
  out.n = times.length;
  if (times.length < LOOKS_PER_HOUR) return out;
  out.capped = true;
  out.nextMs = times[times.length - LOOKS_PER_HOUR] + HOUR_MS;
  out.text = out.n + ' looks in the last hour, next look ' + clock(out.nextMs);
  return out;
}

/** The mode shown big. A league seat: SHADOW (paper). A live agent from its `agent` message (live/agent-core.js MODES):
    Shadow is SHADOW (proposals only), Copilot or Auto on a Sim account SIM, on a live account LIVE; on no account the mode
    itself (nothing trades); a mode or an account kind not given: not reported. { word, sub, kind } (kind for the look). */
function seatMode() { return { word: 'SHADOW', sub: 'paper: no orders', kind: 'shadow' }; }
function agentMode(a) {
  const x = a || {}, mode = x.mode;
  if (mode === 'shadow') return { word: 'SHADOW', sub: 'proposals only: no orders', kind: 'shadow' };
  if (mode !== 'copilot' && mode !== 'auto') return { word: 'MODE', sub: 'mode ' + NR, kind: 'unknown' };
  const name = mode === 'auto' ? 'Auto' : 'Copilot';
  const hasAccount = (typeof x.account === 'string' && x.account) || (x.group && typeof x.group === 'object');
  if (!hasAccount) return { word: name.toUpperCase(), sub: 'account None: nothing trades', kind: 'none' };
  if (x.sim === true) return { word: 'SIM', sub: name + ' on a Sim account', kind: 'sim' };
  if (x.sim === false) return { word: 'LIVE', sub: name + ' on a live account', kind: 'live' };
  return { word: name.toUpperCase(), sub: 'account kind ' + NR, kind: 'unknown' };
}

/** One decision as a stream line: { id, time, action, conf, line, full }. action: enter, rest, cancel, pass, refused, failed. */
function thoughtOf(d) {
  const a = d.answer && typeof d.answer === 'object' ? d.answer : {};
  const action = !d.call_ok ? 'failed' : d.refused ? 'refused' : ['enter', 'rest', 'cancel', 'pass'].includes(a.action) ? a.action : 'enter';
  const reason = str(a.reasoning, 2000);
  const order = (action === 'enter' || action === 'rest') ? [a.side === 'short' ? 'short' : a.side === 'long' ? 'long' : '', isNum(d.contracts) ? d.contracts + ' MNQ' : '',
    isNum(a.stop_points) ? 'stop ' + pts(a.stop_points) + ' pt' : '', isNum(a.target_points) ? 'target ' + pts(a.target_points) + ' pt' : (action === 'enter' ? 'no target' : ''),
    a.reference ? 'at ' + str(a.reference, 30) : ''].filter(Boolean).join(', ') : '';
  const line = action === 'failed' ? 'no answer (the call failed)' : action === 'refused' ? 'refused: ' + firstLine(d.refused, 120)
    : firstLine(reason, 140) || order || 'no reasoning given';
  const full = [order, reason, action === 'refused' ? 'Refused: ' + str(d.refused, 400) : '', action === 'failed' ? 'The call failed: no answer.' : '',
    d.relation === 'with' ? 'With you.' : d.relation === 'against' ? 'Against you.' : ''].filter(Boolean).join('\n\n');
  return { id: str(d.id, 64) || (d.seat + '|' + (isNum(d.t) ? d.t : str(d.time, 8))), time: str(d.time, 8).slice(0, 5) || clock(d.t), action,
    conf: isNum(a.confidence) ? a.confidence.toFixed(2) : '', line, full,
    detail: [str(d.time, 8) || clock(d.t), d.trigger ? 'look: ' + str(d.trigger, 80) : '', isNum(d.latency_s) ? d.latency_s + ' s' : '', isNum(d.cost) ? '$' + d.cost.toFixed(4) : ''].filter(Boolean).join(' · ') };
}
/** The seat's stream, newest first (the decisions come oldest first). */
function seatThoughts(decisions, seat, most) {
  const out = [];
  const list = Array.isArray(decisions) ? decisions : [];
  for (let i = list.length - 1; i >= 0 && out.length < (most || THOUGHTS_MAX); i--) if (list[i] && list[i].seat === seat) out.push(thoughtOf(list[i]));
  return out;
}

/**
 * The position block of a card: { flat, side, head, since, open: { text, tone, title }, stops: text, rest: text }.
 * pos: { side ('long' | 'short'), contracts, fill, stop, target, sinceMs | sinceText, root }; last: the page's price or null;
 * pv: the root's point value; risk: the open trade's risk in dollars (live agents; a seat's R comes from its stop).
 */
function positionBlock(pos, last, pv, opts) {
  const o = opts || {};
  if (!pos) return { flat: true, head: 'Flat', side: '', since: '', open: null, stops: '', rest: o.rest || '' };
  const dir = pos.side === 'short' ? -1 : 1, q = isNum(pos.contracts) ? pos.contracts : null;
  const head = (dir < 0 ? 'SHORT' : 'LONG') + (q !== null ? ' ' + q : '') + (pos.root ? ' ' + pos.root : '');
  const since = pos.sinceText || (isNum(pos.sinceMs) ? clock(pos.sinceMs) : '');
  let open = { text: 'open P&L ' + NR, tone: '', title: 'No price for ' + (pos.root || 'it') + ' on this page yet' };
  if (!isNum(pos.fill)) open = { text: 'open P&L ' + NR, tone: '', title: 'The fill price is not reported' };
  else if (isNum(last)) {
    const p = (last - pos.fill) * dir;
    const usd = q !== null && isNum(pv) && pv > 0 ? Math.round(p * q * pv * 100) / 100 : null;
    const stopPts = isNum(pos.stop) ? Math.abs(pos.fill - pos.stop) : null;
    const r = isNum(o.risk) && o.risk > 0 && usd !== null ? usd / o.risk : stopPts ? p / stopPts : null;
    open = { text: 'open ' + (usd !== null ? signedMoney(usd) || '$0.00' : (p > 0 ? '+' : '') + pts(p) + ' pt') + (r !== null ? ' · ' + signedR(r) : ' · R ' + NR), tone: tone(p),
      title: 'Worked out on this page: ' + (pos.root || '') + ' last ' + px(last) + ' against the fill ' + px(pos.fill) + (r !== null ? (isNum(o.risk) ? ', R on the plan\'s risk' : ', R on the stop at the fill') : '') };
  }
  const ref = isNum(last) ? last : pos.fill, from = isNum(last) ? '' : ' from the fill';
  const stops = isNum(ref) ? ['stop ' + (isNum(pos.stop) ? pts(Math.abs(ref - pos.stop)) + ' pt' : NR), 'target ' + (isNum(pos.target) ? pts(Math.abs(pos.target - ref)) + ' pt' : pos.target === null && o.noTarget ? 'none' : NR)].join(' · ') + from
    : 'stop and target ' + NR;
  return { flat: false, head, side: dir < 0 ? 'short' : 'long', since, open, stops, rest: o.rest || '' };
}

/** A seat's resting order: status.json's `resting` when The Desk passes it on (the league writes it; The Desk of 1.35.0 does
    not pass it on yet): text, '' for none. nowMs: the league's clock, for the time left. */
function seatRest(x, date, nowMs) {
  if (!x || !Object.prototype.hasOwnProperty.call(x, 'resting')) return 'resting order: ' + NR;
  const o = x.resting;
  if (!o || typeof o !== 'object') return '';
  const until = wallMs(date, str(o.good_until, 8));
  const left = until !== null && isNum(nowMs) ? Math.max(0, Math.round((until - nowMs) / 60000)) : null;
  return 'resting ' + (o.side === 'short' ? 'short' : 'long') + (o.type ? ' ' + str(o.type, 10) : '') + (isNum(o.price) ? ' at ' + px(o.price) : '') +
    (o.good_until ? ' until ' + str(o.good_until, 5) : '') + (left !== null ? ' (' + left + ' min left)' : '');
}

/**
 * Every seat's card from the league day as LeagueCore.cleanDay gives it (null: The Desk not read yet). ctx: { nowMs (the
 * league's clock: New York wall time in ms as if UTC), last (MNQ's price on the page, or null), pv (MNQ's point value) }.
 */
function seatCards(day, ctx) {
  const c = ctx || {};
  const st = day && day.status && typeof day.status === 'object' ? day.status : null;
  const seats = st && st.seats && typeof st.seats === 'object' ? st.seats : {};
  const spend = (st && st.spend) || (day && day.league && day.league.spend) || null;
  const closed = !!(day && day.day && day.day.closed);
  const date = (st && str(st.date, 10)) || (day && day.date) || '';
  const statusMs = st ? wallMs(date, str(st.now, 8)) : null;
  const pv = isNum(c.pv) && c.pv > 0 ? c.pv : MNQ_POINT;
  return SEATS.map(s => {
    const x = seats[s.id] && typeof seats[s.id] === 'object' ? seats[s.id] : null;
    const decisions = day ? day.decisions : [];
    const cap = closed ? { capped: false, n: 0 } : lookCap(decisions, s.id, c.nowMs);
    /* its one word, the first that applies */
    let state = null;
    if (!x) state = { word: NR, why: 'status.json has nothing for this seat' };
    else if (x.status === 'retired') state = { word: 'retired', why: 'The league retired this seat' };
    else if (x.api_stopped || (spend && spend.stopped)) state = { word: 'API stopped', why: str(x.api_stopped || spend.stopped, 200) };
    else if (x.stopped) state = { word: 'day stopped', why: str(x.stopped, 200) };
    else if (closed) state = { word: 'day closed', why: (day.day && day.day.note) || 'The day closed at 16:01' };
    else if (st && typeof st.feed === 'string' && st.feed && st.feed !== 'live') state = { word: 'feed down', why: 'The league\'s feed: ' + str(st.feed, 80) };
    else if (statusMs !== null && isNum(c.nowMs) && date === clockDate(c.nowMs) && c.nowMs - statusMs > STATUS_LATE_MS) state = { word: 'status late', why: 'The league\'s status is from ' + str(st.now, 8) + ' ET' };
    else if (cap.capped) state = { word: 'look cap', why: cap.text + ' (worked out on this page from its decisions; the league allows 30 looks in any 60 minutes)' };
    /* the position: status.json's, else The Desk's open paper trade */
    const p = x && x.position && typeof x.position === 'object' ? x.position : null;
    const ot = day ? (day.open || []).find(t => t.seat === s.id) : null;
    const pos = p ? { side: p.side, contracts: isNum(p.contracts) ? p.contracts : null, fill: isNum(p.fill_px) ? p.fill_px : null, stop: isNum(p.stop_px) ? p.stop_px : null,
      target: isNum(p.target_px) ? p.target_px : p.target_px === null ? null : undefined, sinceText: str(p.fill_time, 8).slice(0, 5) || (ot ? clock(ot.fillT) : ''), root: 'MNQ' }
      : ot ? { side: ot.side, contracts: ot.contracts, fill: ot.fillPx, stop: ot.stopPx, target: ot.targetPx, sinceMs: ot.fillT, root: 'MNQ' } : null;
    const position = !x && !ot ? { flat: true, head: NR, side: '', since: '', open: null, stops: '', rest: '' }
      : positionBlock(pos, c.last, pv, { rest: seatRest(x, date, statusMs !== null ? statusMs : c.nowMs), noTarget: true });
    /* today */
    const mine = (day ? day.trades : []).filter(t => t.seat === s.id);
    const counted = mine.filter(t => t.r !== null && !t.crashCut);
    const fx = x && x.flex && typeof x.flex === 'object' ? x.flex : null;
    const today = {
      usd: fx && isNum(fx.today_pnl) ? fx.today_pnl : null,
      r: counted.length ? counted.reduce((a, t) => a + t.r, 0) : mine.length ? null : 0,   // no trade yet: 0 R; trades with no R: not reported
      n: mine.length, wins: counted.filter(t => t.r > 0).length, losses: counted.filter(t => t.r < 0).length,
      account: fx ? '50K Flex' + (fx.phase ? ' ' + str(String(fx.phase), 12) : '') + (isNum(fx.balance) ? ' ' + money(fx.balance) : '') : '50K Flex ' + NR,
      room: fx && isNum(fx.room_to_floor) ? money(fx.room_to_floor) + ' to the floor' : 'room to the floor ' + NR,
    };
    /* spend: this seat's dollars, the seats' pool (the day cap less the coach's reserve: worked out here), the day cap */
    let spendBlock;
    if (!spend || typeof spend !== 'object') spendBlock = { line1: 'spend ' + NR, line2: '', title: '' };
    else {
      const seatsSp = spend.seats && typeof spend.seats === 'object' ? spend.seats : {};
      const mineSp = isNum(seatsSp[s.id]) ? seatsSp[s.id] : null;
      const poolCap = isNum(spend.day_cap) && isNum(spend.coach_reserve) ? Math.round((spend.day_cap - spend.coach_reserve) * 100) / 100 : null;
      const poolSpent = SEATS.every(z => isNum(seatsSp[z.id])) ? SEATS.reduce((a, z) => a + seatsSp[z.id], 0) : null;
      spendBlock = {
        line1: (mineSp !== null ? money(mineSp) + ' seat' : 'seat ' + NR) + ' · seats ' + (poolSpent !== null ? money(poolSpent) : NR) + ' of ' + (poolCap !== null ? money(poolCap) : NR),
        line2: 'day ' + (isNum(spend.day_spent) ? money(spend.day_spent) : NR) + ' of ' + (isNum(spend.day_cap) ? money(spend.day_cap) : NR) +
          ' · ' + (x && isNum(x.decisions) ? x.decisions + (x.decisions === 1 ? ' call' : ' calls') : 'calls ' + NR),
        title: 'The seats\' pool is the day cap less the coach\'s reserve (worked out on this page). A call is one look.' + (isNum(spend.calls_today) ? ' The league: ' + spend.calls_today + ' calls today.' : ''),
      };
    }
    return { kind: 'seat', key: 'seat:' + s.id, id: s.id, letter: s.id, name: s.family, color: s.color, mode: seatMode(), state, position, today, spend: spendBlock,
      thoughts: seatThoughts(decisions, s.id), flag: x && typeof x.flag === 'string' ? x.flag.slice(0, 200) : '', looks: cap.n };
  });
}
/** The date (YYYY-MM-DD) of a time in the league's convention. */
function clockDate(ms) { return isNum(ms) ? new Date(ms).toISOString().slice(0, 10) : ''; }

/** Should a live agent have a card: running, or holding anything, or stopped by a kill switch or a stand-down. An agent slot
    that is off and empty is listed in the strip's foot instead. */
function agentActive(a, g) {
  const x = a || {}, q = x.position && isNum(x.position.qty) ? x.position.qty : 0;
  return !!(x.connected || x.killed || x.standDown || q || (g && g.orders && g.orders.length) || (g && g.helperOn));
}
/**
 * A live agent's card. a: its `agent` message (ChartBridge); g: the Agent tab's glance (live/agent.js) or null; ctx: { last(root),
 * pv(root) }. What the agent message and the tab do not hold says not reported.
 */
function agentCard(a, g, ctx) {
  const x = a || {}, c = ctx || {}, gl = g || {};
  const name = typeof x.name === 'string' && x.name ? x.name.slice(0, 40) : String(x.agent || 'Agent');
  let state = null;
  if (x.killed) state = { word: 'killed', why: 'Kill switch on: no agent orders' };
  else if (x.standDown) state = { word: 'stood down', why: str(x.standDown, 200) };
  else if (x.enabled === false) state = { word: 'off', why: 'Turned off in ChartBridge' };
  else if (!x.connected) state = { word: 'not connected', why: 'No agent program connected: not started, or its heartbeat was lost' };
  const p = x.position && isNum(x.position.qty) && x.position.qty ? x.position : null;
  const orders = Array.isArray(gl.orders) ? gl.orders : [];
  const root = p ? str(p.root, 8) : '';
  const stopO = p ? orders.find(o => o.role === 'stop' && o.root === root && isNum(o.price)) : null;
  const tgtO = p ? orders.find(o => o.role === 'target' && o.root === root && isNum(o.price)) : null;
  const entries = orders.filter(o => o.role === 'entry');
  const rest = entries.length ? entries.map(o => 'resting ' + (o.side === 'sell' ? 'sell' : 'buy') + (isNum(o.qty) ? ' ' + o.qty : '') + (o.root ? ' ' + o.root : '') + (o.kind ? ' ' + o.kind : '') + (isNum(o.price) ? ' at ' + px(o.price) : '') + ' (time left ' + NR + ')').join('; ') : '';
  const pos = p ? { side: p.qty < 0 ? 'short' : 'long', contracts: Math.abs(p.qty), fill: isNum(p.avgPrice) ? p.avgPrice : null, stop: stopO ? stopO.price : null, target: tgtO ? tgtO.price : null,
    sinceMs: null, sinceText: str(gl.sinceText, 8).slice(0, 5), root } : null;
  const last = p && typeof c.last === 'function' ? c.last(root) : null, pv = p && typeof c.pv === 'function' ? c.pv(root) : null;
  const position = positionBlock(pos, last, pv, { rest, risk: isNum(gl.openRisk) ? gl.openRisk : null });
  const exits = Array.isArray(gl.exits) ? gl.exits : [];
  const known = exits.every(e => isNum(e.pnl));
  const today = {
    usd: exits.length ? (known ? Math.round(exits.reduce((s, e) => s + e.pnl, 0) * 100) / 100 : null) : g ? 0 : null,
    r: isNum(gl.totalR) ? gl.totalR : null, n: exits.length, wins: exits.filter(e => isNum(e.pnl) && e.pnl > 0).length, losses: exits.filter(e => isNum(e.pnl) && e.pnl < 0).length,
    account: x.group && typeof x.group === 'object' ? 'a group' + (x.sim === true ? ' (Sim)' : x.sim === false ? ' (live)' : '') : typeof x.account === 'string' && x.account ? (x.sim === true ? 'Sim account' : x.sim === false ? 'live account' : 'account kind ' + NR) : 'account None',
    room: 'room ' + NR,
  };
  const sp = gl.spend && typeof gl.spend === 'object' ? gl.spend : null;
  const spend = sp ? { line1: (isNum(sp.session) ? money(sp.session) : NR) + ' this session · ' + (isNum(sp.overall) ? money(sp.overall) : NR) + ' overall', line2: 'calls ' + NR, title: 'The PC helper\'s figures, as the Agent tab last read them' }
    : { line1: 'spend ' + NR, line2: '', title: 'The PC helper is read while the Agent tab is open' };
  const thoughts = (Array.isArray(gl.stream) ? gl.stream : []).slice(0, THOUGHTS_MAX).map(r => ({ id: str(r.key, 120), time: str(r.time, 8).slice(0, 5), action: ({ thinking: 'think', notebook: 'notes' }[str(r.tag, 12).toLowerCase()] || str(r.tag, 12).toLowerCase()), conf: '', line: firstLine(r.text, 140), full: str(r.full, 4000), detail: str(r.time, 8) + (r.tag ? ' · ' + str(r.tag, 12) : '') }));
  return { kind: 'agent', key: 'agent:' + x.agent, id: String(x.agent || ''), letter: name.slice(0, 1).toUpperCase(), name, color: '', mode: agentMode(x), state, position, today, spend, thoughts, flag: '', looks: null };
}

/** The line under the strip's cards: the agent slots not shown (off and empty), by name. */
function idleLine(names) {
  const n = (names || []).length;
  return n ? n + (n === 1 ? ' agent slot is' : ' agent slots are') + ' off and empty: ' + names.join(', ') : '';
}

return { SEATS, LOOKS_PER_HOUR, HOUR_MS, MNQ_POINT, NR, THOUGHTS_MAX, clock, wallMs, clockDate, firstLine, lookCap, seatMode, agentMode, thoughtOf, seatThoughts,
  positionBlock, seatRest, seatCards, agentActive, agentCard, idleLine, money, signedMoney, signedR };
});

/* ======================================================================== the panel (browser only) */
if (typeof window !== 'undefined' && typeof document !== 'undefined') (function () {
'use strict';
const C = window.AgentsStripCore;
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const setHtml = (el, html) => { if (el && el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } };

/**
 * The strip in a panel's body. o: { day() (the league day, LeagueCore.cleanDay's shape, or null), reach() ({ problem, at }),
 * agents() ([{ a, g }]: each live agent's message and the Agent tab's glance), nowMs() (New York wall time in ms as if UTC),
 * last(root), pv(root), openLeague(), openAgent(id) }. Returns { render, destroy, state }.
 */
function mount(body, o) {
  const S = { detail: null, cards: [] };
  body.innerHTML = '<div class="as-wrap">' +
    '<p class="as-line" data-k="line" role="status"></p>' +
    '<div class="as-row" data-k="row" role="list" aria-label="Agents"></div>' +
    '<p class="as-foot" data-k="foot"></p>' +
    '<div class="as-detail" data-k="detail" role="dialog" aria-modal="false" aria-label="Full reasoning" hidden></div>' +
    '</div>';
  const q = s => body.querySelector(s);
  const row = q('[data-k="row"]'), detail = q('[data-k="detail"]');

  function cardHtml(c) {
    const p = c.position, t = c.today, sp = c.spend;
    const letter = c.kind === 'seat' ? '<i class="lg-letter as-letter" aria-hidden="true">' + esc(c.letter) + '</i>' : '<i class="as-letter as-ag" aria-hidden="true">' + esc(c.letter) + '</i>';
    const openWhat = c.kind === 'seat' ? 'Open the League tab' : 'Open the Agent tab for ' + c.name;
    const now = p.flat ? '<div class="as-v"><b>' + esc(p.head) + '</b></div>'
      : '<div class="as-v"><b class="as-side ' + esc(p.side) + '">' + esc(p.head) + '</b>' + (p.since ? ' <span class="as-mut">since ' + esc(p.since) + '</span>' : ' <span class="as-mut">since ' + C.NR + '</span>') + '</div>' +
        (p.open ? '<div class="as-v mono"><span class="as-pnl ' + esc(p.open.tone) + '" title="' + esc(p.open.title) + '">' + esc(p.open.text) + '</span></div>' : '') +
        '<div class="as-v mono as-mut">' + esc(p.stops) + '</div>';
    const rest = p.rest ? '<div class="as-v as-mut">' + esc(p.rest) + '</div>' : '';
    const today = '<div class="as-v mono"><span class="as-pnl ' + (t.usd !== null ? (t.usd > 0 ? 'up' : t.usd < 0 ? 'down' : '') : '') + '">' + esc(t.usd !== null ? C.signedMoney(t.usd) || '$0.00' : 'P&L ' + C.NR) + '</span>' +
      ' · <span class="as-pnl ' + (t.r !== null ? (t.r > 0 ? 'up' : t.r < 0 ? 'down' : '') : '') + '">' + esc(t.r !== null ? C.signedR(t.r) || '0.00 R' : 'R ' + C.NR) + '</span>' +
      ' · ' + t.n + (t.n === 1 ? ' trade' : ' trades') + (t.n ? ' ' + t.wins + 'W ' + t.losses + 'L' : '') + '</div>' +
      '<div class="as-v as-mut mono">' + esc(t.account) + ' · ' + esc(t.room) + '</div>';
    const spend = '<div class="as-v mono" title="' + esc(sp.title) + '">' + esc(sp.line1) + '</div>' + (sp.line2 ? '<div class="as-v mono as-mut" title="' + esc(sp.title) + '">' + esc(sp.line2) + '</div>' : '');
    const th = c.thoughts.length ? c.thoughts.map(x => '<li><button type="button" class="as-th k-' + esc(x.action) + '" data-th="' + esc(x.id) + '" aria-label="' + esc(x.time + ' ' + x.action + ': open the full reasoning') + '">' +
      '<span class="mono as-t">' + esc(x.time) + '</span><span class="as-act">' + esc(x.action) + '</span><span class="mono as-conf">' + esc(x.conf) + '</span><span class="as-tx">' + esc(x.line) + '</span></button></li>').join('')
      : '<li class="as-mut as-none">No thought yet today.</li>';
    return '<article class="as-card k-' + c.kind + ' m-' + esc(c.mode.kind) + '" role="listitem" data-card="' + esc(c.key) + '"' + (c.color ? ' style="--seat:' + esc(c.color) + '"' : '') + ' title="' + esc(openWhat) + '">' +
      '<header class="as-head">' + letter + '<span class="as-name">' + esc(c.name) + '</span><span class="as-fill"></span>' +
        '<span class="as-mode m-' + esc(c.mode.kind) + '" title="' + esc(c.mode.sub) + '">' + esc(c.mode.word) + '</span>' +
        '<button type="button" class="as-open" data-open="1" aria-label="' + esc(openWhat) + '" title="' + esc(openWhat) + '">›</button></header>' +
      '<div class="as-sub"><span class="as-mut">' + esc(c.mode.sub) + '</span>' + (c.state ? '<span class="as-state" title="' + esc(c.state.why) + '">' + esc(c.state.word) + '</span>' : '') + '</div>' +
      (c.state && c.state.word === 'look cap' ? '<div class="as-v as-warn">' + esc(c.state.why.replace(/ \(worked out.*$/, '')) + '</div>' : '') +
      (c.flag ? '<div class="as-v as-flag" title="' + esc(c.flag) + '">Flag: ' + esc(c.flag) + '</div>' : '') +
      '<section class="as-sec" aria-label="Now"><span class="as-lbl">Now</span><div>' + now + rest + '</div></section>' +
      '<section class="as-sec" aria-label="Today"><span class="as-lbl">Today</span><div>' + today + '</div></section>' +
      '<section class="as-sec" aria-label="Spend"><span class="as-lbl">Spend</span><div>' + spend + '</div></section>' +
      '<section class="as-sec as-ths" aria-label="Stream of thoughts, newest first"><span class="as-lbl">Thoughts</span><ol class="as-list">' + th + '</ol></section>' +
      '</article>';
  }
  function renderDetail() {
    if (!S.detail) { if (!detail.hidden) { detail.hidden = true; setHtml(detail, ''); } return; }
    const c = S.cards.find(x => x.key === S.detail.card), t = c && c.thoughts.find(x => x.id === S.detail.id);
    const html = !t ? '<div class="as-dhead"><b>' + esc(c ? c.name : 'Agent') + '</b><span class="as-fill"></span><button type="button" class="ws-btn" data-close="1">Close</button></div><p class="as-mut">This thought is no longer in the newest few.</p>'
      : '<div class="as-dhead"><b>' + esc(c.name) + '</b><span class="as-act k-' + esc(t.action) + '">' + esc(t.action) + '</span>' + (t.conf ? '<span class="mono">confidence ' + esc(t.conf) + '</span>' : '') +
        '<span class="as-mut mono">' + esc(t.detail) + '</span><span class="as-fill"></span><button type="button" class="ws-btn" data-close="1">Close</button></div>' +
        '<p class="as-full">' + esc(t.full || t.line) + '</p>' + (c.kind === 'seat' ? '<p class="as-mut">SHADOW: paper only, no orders.</p>' : '');
    setHtml(detail, html);
    detail.hidden = false;
  }
  function render() {
    const day = o.day(), reach = o.reach() || {};
    const nowMs = o.nowMs();
    const cards = [];
    if (day) cards.push(...C.seatCards(day, { nowMs, last: o.last('MNQ'), pv: o.pv('MNQ') }));
    const idle = [];
    for (const x of o.agents()) {
      if (C.agentActive(x.a, x.g)) cards.push(C.agentCard(x.a, x.g, { last: o.last, pv: o.pv }));
      else idle.push(x.a && x.a.name ? x.a.name : x.a ? x.a.agent : '');
    }
    S.cards = cards;
    const line = q('[data-k="line"]');
    const ln = reach.problem ? reach.problem : !day ? 'Reading the league from The Desk...' : day.problem || '';
    line.hidden = !ln; line.textContent = ln;
    /* each card is drawn again only when what it shows changed: a click, a focus or a hover stays where it was */
    const keys = cards.map(c => c.key).join('|');
    if (row.dataset.keys !== keys) {
      row.dataset.keys = keys;
      row.innerHTML = cards.map(c => '<div class="as-slot" data-slot="' + esc(c.key) + '"></div>').join('') || '<p class="as-mut as-empty">No agent to show: the league has not been read and no live agent is running.</p>';
    }
    for (const c of cards) {
      const slot = row.querySelector('[data-slot="' + CSS.escape(c.key) + '"]');
      if (!slot) continue;
      const html = cardHtml(c);
      if (slot.dataset.html !== html) {
        const had = slot.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.th || (document.activeElement.dataset.open ? 'open' : '') : '';
        slot.dataset.html = html; slot.innerHTML = html;
        if (had) { const b = had === 'open' ? slot.querySelector('[data-open]') : slot.querySelector('[data-th="' + CSS.escape(had) + '"]'); if (b) b.focus({ preventScroll: true }); }
      }
    }
    /* the stream shows the lines that fit whole: a line cut by the card's foot is not shown */
    for (const list of row.querySelectorAll('.as-list')) {
      const card = list.closest('.as-card');
      const bottom = Math.min(list.getBoundingClientRect().bottom, card ? card.getBoundingClientRect().bottom - 4 : Infinity);
      for (const li of list.children) { const cut = li.getBoundingClientRect().bottom > bottom + 0.5; if (li.style.visibility !== (cut ? 'hidden' : '')) li.style.visibility = cut ? 'hidden' : ''; }
    }
    setHtml(q('[data-k="foot"]'), esc(C.idleLine(idle.filter(Boolean))) + (day ? (idle.length ? ' · ' : '') + 'League: SHADOW, paper only.' + (reach.at ? ' Read ' + Math.max(0, Math.round((Date.now() - reach.at) / 1000)) + ' s ago.' : '') : ''));
    renderDetail();
  }
  function onClick(e) {
    if (e.target.closest('[data-close]')) { const was = S.detail; S.detail = null; renderDetail(); if (was) { const b = row.querySelector('[data-slot="' + CSS.escape(was.card) + '"] [data-th="' + CSS.escape(was.id) + '"]'); if (b) b.focus({ preventScroll: true }); } return; }
    if (detail.contains(e.target)) return;
    const card = e.target.closest('[data-card]');
    if (!card) return;
    const th = e.target.closest('[data-th]');
    if (th) { S.detail = S.detail && S.detail.card === card.dataset.card && S.detail.id === th.dataset.th ? null : { card: card.dataset.card, id: th.dataset.th }; renderDetail(); return; }
    const c = S.cards.find(x => x.key === card.dataset.card);
    if (!c) return;
    if (c.kind === 'seat') o.openLeague(); else o.openAgent(c.id);
  }
  function onKey(e) { if (e.key === 'Escape' && S.detail && detail.contains(e.target)) { e.stopPropagation(); S.detail = null; renderDetail(); } }
  body.addEventListener('click', onClick);
  body.addEventListener('keydown', onKey);
  render();
  return {
    render,
    destroy() { body.removeEventListener('click', onClick); body.removeEventListener('keydown', onKey); body.innerHTML = ''; },
    /* read only, for the tests */
    state: () => ({ cards: S.cards.map(c => ({ key: c.key, name: c.name, mode: c.mode.word, state: c.state ? c.state.word : '', flat: c.position.flat, head: c.position.head, thoughts: c.thoughts.length })), detail: S.detail ? Object.assign({}, S.detail) : null }),
  };
}

window.AgentsStrip = { mount };
})();
