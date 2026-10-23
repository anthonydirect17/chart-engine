/*
 * The Agents strip (chart 1.36.0, Anthony 2026-10-22, the WORK request "an Agents strip panel: every active agent at a glance"):
 * "I want a panel made, that plays horizontally, but just shows the current active shadow agents and eventually live agents
 * status, so If I dont have their tab pulled up I can still glance over and see their position, spent, stream of thoughts."
 *
 * A panel from + Add panel (at most one a layout), made for the lower left of his Accounts layout (about 1,430 by 450 px): one
 * card per agent, left to right (the league's seats H, S, O first, then the live agents ChartBridge lists, then the bot: 1.36.0
 * merged the Bot panel into the strip, Anthony 2026-10-22: "get rid of the bot panel and merge it into this"), the row scrolling
 * sideways once the cards no longer fit. Each card: the name and colour, the MODE big (SHADOW or LIVE only, the account kind
 * under LIVE), its one-word state when it matters (look cap, API stopped, feed down, day stopped, killed, not connected), its
 * position now, its day, its spend and its stream of thoughts, newest first. A click on a thought opens its full reasoning; a
 * click anywhere else on a card opens that agent's full view (the League tab for a seat, the Agent tab for a live agent, the Bot
 * view for the bot: its switches, kill switch and rails stay there, unchanged).
 *
 * Read only. It never sends an order or a control message: it reads what the page already has.
 *   - The seats: The Desk's GET /api/chart-league, through the one league read the workspace already runs (live/workspace.js LG:
 *     the faint marks' poll, or the League view's day while that view is open). No poller of its own.
 *   - The live agents: the Agent tab's own state (live/agent.js glance(), from ChartBridge's `agent` messages, the agent's notes
 *     and plans, its fills and its working orders) and the PC helper's spend when the Agent tab has read it.
 *   - Prices: the workspace's NQ quote (1.38.1, Anthony 2026-10-23: his charts are NQ; the seats trade MNQ, the same index, so
 *     their P&L and R use NQ's price with MNQ's point value, unconverted; the same quote socket the Quote board uses).
 * What a card wants and nobody reports says "not reported", never a guess. What the page works out itself (the look cap, open
 * P&L and R from the page's NQ price, the seats' pool) says so in its title.
 *
 * 1.38.0 (Anthony 2026-10-23, the approved "Drone sky"): the panel draws the agents as drones over the price (live/agents-sky.js);
 * this file keeps the data: AgentsStripCore's cards (each drone's hover card is its strip card) and the sky's model (who flies
 * today, each drone's trade, R, spend, looks and what it did), all from the same reads as above. The card itself has no motion.
 *
 * Two parts, as league.js: AgentsStripCore (pure: Node tests, test/agents-strip.test.js) and, in a browser, AgentsStrip (the
 * card's markup).
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
/* the league's look cap: at most 30 counted looks in any 60 minutes a seat (Bot-Lab league/config.py LOOKS_PER_HOUR, league/runner.py
   _cap_ok). A look at Anthony's new entry is never counted (Amendment 7: runner.py _look_kind says "mentor"). The league logs the
   cap (events.jsonl look_cap) but neither status.json nor The Desk passes it on, so the strip DERIVES it from the seat's own
   counted decisions (one decision a look) in the 60 minutes before now. */
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

/** A decision's look kind as the league reads it (Bot-Lab league/runner.py _look_kind, the same rule): its look_kind when it has
    one, else by its trigger: "a new mentor entry..." is mentor, one that says reaction is reaction, any other is clock. */
function lookKind(d) {
  if (d && typeof d.look_kind === 'string' && d.look_kind) return d.look_kind;
  const why = d && typeof d.trigger === 'string' ? d.trigger : '';
  return why.startsWith('a new mentor entry') ? 'mentor' : why.includes('reaction') ? 'reaction' : 'clock';
}

/**
 * The look cap, DERIVED (the league reports it nowhere the page can read): the seat's counted looks (every decision but a look at
 * Anthony's new entry, Amendment 7) in the 60 minutes before nowMs (the league's clock convention). 30 or more: capped, and its
 * next look is when the oldest of the last 30 counted ones is an hour old (the league's rule is "any 60 minutes", not the clock
 * hour). Returns { capped, n, nextMs, text }.
 */
function lookCap(decisions, seat, nowMs) {
  const out = { capped: false, n: 0, nextMs: null, text: '' };
  if (!isNum(nowMs)) return out;
  const times = (Array.isArray(decisions) ? decisions : []).filter(d => d && d.seat === seat && isNum(d.t) && d.t <= nowMs && nowMs - d.t < HOUR_MS && lookKind(d) !== 'mentor')
    .map(d => d.t).sort((a, b) => a - b);
  out.n = times.length;
  if (times.length < LOOKS_PER_HOUR) return out;
  out.capped = true;
  out.nextMs = times[times.length - LOOKS_PER_HOUR] + HOUR_MS;
  out.text = out.n + ' counted looks in the last hour, next look ' + clock(out.nextMs);
  return out;
}

/** The mode shown big: SHADOW or LIVE, nothing else (Anthony 2026-10-22: "theres really only 2 types right now, shadow or live.
    They are either shadow trading or get promoted and trade live with either sim or a cheap eval"). A league seat is SHADOW
    (paper). A live agent or the bot from its message (`mode` shadow, copilot or auto; `account`; `sim`): Shadow is SHADOW; Copilot
    or Auto on an account of its own is LIVE, the account kind under it in small text (sim, or not Sim: an eval or funded account,
    which the page cannot tell apart); on no account nothing trades, so SHADOW. A mode not given: not reported. The Copilot and
    Auto words are never shown. { word, sub, kind } (kind for the look). */
function seatMode() { return { word: 'SHADOW', sub: 'paper: no orders', kind: 'shadow' }; }
function liveMode(x) {
  const a = x || {}, mode = a.mode;
  if (mode === 'shadow') return { word: 'SHADOW', sub: 'no orders', kind: 'shadow' };
  if (mode !== 'copilot' && mode !== 'auto') return { word: '?', sub: 'mode ' + NR, kind: 'unknown' };
  const hasAccount = (typeof a.account === 'string' && a.account) || (a.group && typeof a.group === 'object');
  if (!hasAccount) return { word: 'SHADOW', sub: 'account None: no orders', kind: 'shadow' };
  return { word: 'LIVE', sub: a.sim === true ? 'sim' : a.sim === false ? 'not Sim: eval or funded' : 'account kind ' + NR, kind: 'live' };
}
const agentMode = liveMode;

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
  const full = [order + (action === 'rest' ? (order ? ', ' : '') + 'good until ' + NR : ''), reason, action === 'refused' ? 'Refused: ' + str(d.refused, 400) : '', action === 'failed' ? 'The call failed: no answer.' : '',
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
 * pv: the root's point value. opts.risk: the trade's ORIGINAL risk in dollars (a seat's risk_dollars, a live agent's plan risk),
 * opts.riskNote: what that risk is, for the hover; opts.stopPoints: the stop distance at the fill (a seat's stop_points). R is
 * open P&L dollars over that risk, else the points over that stop distance, else not reported. The current stop (pos.stop) is
 * never used for R: after break-even or the trail it is not the trade's risk any more.
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
    let r = null, how = ', R not reported (no risk at the fill)';
    if (isNum(o.risk) && o.risk > 0 && usd !== null) { r = usd / o.risk; how = ', R: open P&L over ' + (o.riskNote || 'the trade\'s risk') + ' (' + money(o.risk) + ')'; }
    else if (isNum(o.stopPoints) && o.stopPoints > 0) { r = p / o.stopPoints; how = ', R: open points over the stop distance at the fill (' + pts(o.stopPoints) + ' pt), before fees'; }
    open = { text: 'open ' + (usd !== null ? signedMoney(usd) || '$0.00' : (p > 0 ? '+' : '') + pts(p) + ' pt') + (r !== null ? ' · ' + signedR(r) : ' · R ' + NR), tone: tone(p),
      title: 'Worked out on this page: ' + (pos.root || '') + ' last ' + px(last) + ' against the fill ' + px(pos.fill) + how };
  }
  const ref = isNum(last) ? last : pos.fill, from = isNum(last) ? '' : ' from the fill';
  const stops = isNum(ref) ? ['stop ' + (isNum(pos.stop) ? pts(Math.abs(ref - pos.stop)) + ' pt' : NR), 'target ' + (isNum(pos.target) ? pts(Math.abs(pos.target - ref)) + ' pt' : pos.target === null && o.noTarget ? 'none' : NR)].join(' · ') + from
    : 'stop and target ' + NR;
  return { flat: false, head, side: dir < 0 ? 'short' : 'long', since, open, stops, rest: o.rest || '' };
}

/** A seat's resting order: status.json's `resting` as The Desk passes it on (status.seats.<seat>.resting; an older Desk that
    leaves the field out: not reported): text, '' for none. nowMs: the league's clock, for the time left. */
function seatRest(x, date, nowMs) {
  if (!x || !Object.prototype.hasOwnProperty.call(x, 'resting')) return 'resting order: ' + NR;
  const o = x.resting;
  if (!o || typeof o !== 'object') return '';
  const until = wallMs(date, str(o.good_until, 8));
  const left = until !== null && isNum(nowMs) ? Math.max(0, Math.round((until - nowMs) / 60000)) : null;
  const ref = str(o.ref_text || o.reference || o.price_ref, 30);
  return 'resting ' + (o.side === 'short' ? 'short' : 'long') + (o.type ? ' ' + str(o.type, 10) : '') + (isNum(o.price) ? ' at ' + px(o.price) : ref ? ' at ' + ref : '') +
    (isNum(o.stop_points) ? ', stop ' + pts(o.stop_points) + ' pt' : '') + (isNum(o.target_points) ? ', target ' + pts(o.target_points) + ' pt' : '') +
    (o.triggered === true ? ', triggered' : '') + (o.good_until ? ' until ' + str(o.good_until, 5) : ', time left ' + NR) + (left !== null ? ' (' + left + ' min left)' : '');
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
    else if (cap.capped) state = { word: 'look cap', why: cap.text + ' (worked out on this page from its decisions; the league allows 30 counted looks in any 60 minutes, and a look at your new entry is not counted)' };
    /* the position: status.json's, else The Desk's open paper trade */
    const p = x && x.position && typeof x.position === 'object' ? x.position : null;
    const ot = day ? (day.open || []).find(t => t.seat === s.id) : null;
    const same = !!ot && (!p || !p.id || !ot.id || p.id === ot.id);   // status.json's position is The Desk's open trade
    const pos = p ? { side: p.side, contracts: isNum(p.contracts) ? p.contracts : null, fill: isNum(p.fill_px) ? p.fill_px : null, stop: isNum(p.stop_px) ? p.stop_px : null,
      target: isNum(p.target_px) ? p.target_px : p.target_px === null ? null : undefined, sinceText: str(p.fill_time, 8).slice(0, 5) || (ot ? clock(ot.fillT) : ''), root: 'MNQ' }
      : ot ? { side: ot.side, contracts: ot.contracts, fill: ot.fillPx, stop: ot.stopPx, target: ot.targetPx, sinceMs: ot.fillT, root: 'MNQ' } : null;
    const position = !x && !ot ? { flat: true, head: NR, side: '', since: '', open: null, stops: '', rest: '' }
      : positionBlock(pos, c.last, pv, { rest: seatRest(x, date, statusMs !== null ? statusMs : c.nowMs), noTarget: true,
        /* R on the trade's own risk at the fill (The Desk's open trade: risk_dollars, stop_points), never on the stop now */
        risk: same ? ot.riskDollars : null, stopPoints: same ? ot.stopPoints : null,
        riskNote: 'the trade\'s risk at the fill, gross: before the round-turn fees (the league\'s booked R is net of them)' });
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
  const position = positionBlock(pos, last, pv, { rest, risk: isNum(gl.openRisk) ? gl.openRisk : null, riskNote: 'the plan\'s risk' });
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

/**
 * The bot's card (1.36.0: the Bot panel merged into the strip) from the Bot desk's glance (live/bot.js): { offered, on, bot (its
 * `bot` message), alert (bot.js's own red-alert rule: rails red, stand-down, killed, on but not connected), status, strip
 * (BotCore.stripModel) }. null: no card (the Bot is not offered on this ChartBridge). Its rails take the spend row's place (a
 * rule bot makes no model calls the page knows of: spend not reported).
 */
function botCard(gl, ctx) {
  if (!gl || !gl.offered) return null;
  const c = ctx || {}, b = gl.bot || null, sm = gl.strip || null;
  const name = sm && sm.name ? str(sm.name, 40) : 'Bot';
  let state = null;
  if (!gl.on) state = { word: 'off', why: str(gl.status, 200) || 'The bot channel is off on this PC' };
  else if (!b) state = { word: NR, why: 'ChartBridge has not sent the bot\'s state yet' };
  else if (b.killed) state = { word: 'killed', why: 'Kill switch on: no bot orders' };
  else if (b.standDown) state = { word: 'stood down', why: str(b.standDown, 200) };
  else if (sm && sm.level === 'red') state = { word: 'rails red', why: 'A rail is at its limit' };
  else if (b.enabled === false) state = { word: 'off', why: str(gl.status, 200) };
  else if (!b.connected) state = { word: 'not connected', why: str(gl.status, 200) || 'No bot program connected' };
  const p = b && b.position && isNum(b.position.qty) && b.position.qty ? b.position : null;
  const root = (b && str(b.root, 8)) || '';
  const pos = p ? { side: p.qty < 0 ? 'short' : 'long', contracts: Math.abs(p.qty), fill: isNum(p.avgPrice) ? p.avgPrice : null, stop: null, target: null, sinceText: '', root } : null;
  const position = !b ? { flat: true, head: NR, side: '', since: '', open: null, stops: '', rest: '' }
    : positionBlock(pos, p && typeof c.last === 'function' ? c.last(root) : null, p && typeof c.pv === 'function' ? c.pv(root) : null, {});
  const rail = r => (r && isNum(r.used) && isNum(r.max) ? r.used + ' of ' + r.max : NR);
  const today = {
    usd: b && isNum(b.pnlToday) ? b.pnlToday : null, r: null, n: b && isNum(b.trades) ? b.trades : 0, wins: null, losses: b && isNum(b.losses) ? b.losses : null,
    account: !b ? 'account ' + NR : typeof b.account === 'string' && b.account ? (b.sim === true ? 'Sim account' : b.sim === false ? 'not Sim (eval or funded)' : 'account kind ' + NR) : 'account None: nothing trades',
    room: 'room ' + NR, rNote: 'R ' + NR,
  };
  const spend = sm ? { label: 'Rails', line1: 'trades ' + rail(sm.trades) + ' · losing ' + rail(sm.losses), line2: '', title: 'The bot\'s rails as ChartBridge keeps them', level: sm.level }
    : { label: 'Rails', line1: 'rails ' + NR, line2: '', title: '' };
  const thoughts = sm && sm.last ? [{ id: 'bot-last', time: '', action: 'signal', conf: '', line: str(sm.last, 140), full: str(gl.status, 300) + '\n\n' + str(sm.last, 300), detail: 'the bot' }] : [];
  return { kind: 'bot', key: 'bot', id: 'bot', letter: 'B', name, color: '', mode: b ? liveMode(b) : { word: '?', sub: 'mode ' + NR, kind: 'unknown' }, state, alert: !!gl.alert,
    status: str(gl.status, 200), position, today, spend, thoughts, flag: '', looks: null };
}

/** The line under the strip's cards: the agent slots not shown (off and empty), by name. */
function idleLine(names) {
  const n = (names || []).length;
  return n ? n + (n === 1 ? ' agent slot is' : ' agent slots are') + ' off and empty: ' + names.join(', ') : '';
}

/* ======================================================================== the Drone sky's model (1.38.0) */
/* Anthony 2026-10-23 approved the "Drone sky" concept for the Agents panel (live/agents-sky.js draws it). What follows is the pure
   part: who flies today, what each drone shows and what each one did, all from the very data the strip's cards read. */

/** A live agent's and the bot's drone colour: the strip's own for them (their letter in the second text colour); the seats keep
    the League's amber, cyan and violet. */
const AGENT_COLOR = '#9AA8B8';

/**
 * Open R as a number (null when it cannot be worked out), by positionBlock's own rule: open P&L dollars over the trade's original
 * risk, else the points over the stop distance at the fill; never on the stop now. pos: { side, contracts, fill }.
 */
function openR(pos, last, pv, o) {
  const x = o || {};
  if (!pos || !isNum(pos.fill) || !isNum(last)) return null;
  const dir = pos.side === 'short' ? -1 : 1, p = (last - pos.fill) * dir;
  if (isNum(x.risk) && x.risk > 0 && isNum(pos.contracts) && isNum(pv) && pv > 0) return p * pos.contracts * pv / x.risk;
  if (isNum(x.stopPoints) && x.stopPoints > 0) return p / x.stopPoints;
  return null;
}

/**
 * Is a seat active today ("league seats during and after their session that day"): the league's day is today (its status date or
 * The Desk's date against nowMs, the league's clock), the seat is not retired, and status.json calls it active or it holds a
 * position or a resting order, or it decided or traded today. A day of another date, or a seat with nothing today: idle.
 * Anthony 2026-10-23: seats fade after their session. Once the league's day is over, as The Desk says it (day.closed, the strip's
 * "day closed"; never a clock time worked out here), a seat that holds nothing (no position: status.json's or an open paper trade;
 * no resting order) is idle; one still holding something stays until it is flat. A seat stopped in the session for a risk reason
 * (its own status.json stopped, the strip's "day stopped") is not after its session: it stays a drone showing that word.
 */
function seatHolds(day, seat, x) {
  return !!((x && ((x.position && typeof x.position === 'object') || (x.resting && typeof x.resting === 'object'))) || (day.open || []).some(t => t && t.seat === seat));
}
function dayOver(day) { return !!(day && day.day && day.day.closed); }
function seatActive(day, seat, nowMs) {
  if (!day || !isNum(nowMs)) return false;
  const st = day.status && typeof day.status === 'object' ? day.status : null;
  const date = (st && str(st.date, 10)) || day.date || '';
  if (!date || date !== clockDate(nowMs)) return false;
  const x = st && st.seats && typeof st.seats === 'object' && st.seats[seat] && typeof st.seats[seat] === 'object' ? st.seats[seat] : null;
  if (x && x.status === 'retired') return false;
  if (dayOver(day)) return seatHolds(day, seat, x);
  if (x && (x.status === 'active' || seatHolds(day, seat, x))) return true;
  const mine = t => t && t.seat === seat;
  return (day.decisions || []).some(mine) || (day.trades || []).some(mine) || (day.open || []).some(mine);
}
/** A live agent flies in the sky (the brief of 2026-10-23: "a live agent or the bot that is ON, holds a position or a working
    order"): its program connected, or a position, or a working order. Off, flat and with nothing working: idle, even when killed
    or stood down (its state word shows on its drone while it flies). */
function agentFlies(a, g) {
  const x = a || {};
  return !!(x.connected || (x.position && isNum(x.position.qty) && x.position.qty) || (g && Array.isArray(g.orders) && g.orders.length));
}
/** The bot flies: its channel on and its program connected, or a position. */
function botActive(gl) {
  const b = gl && gl.bot;
  if (!gl || !gl.offered || !gl.on || !b) return false;
  return !!(b.connected || (b.position && isNum(b.position.qty) && b.position.qty));
}

/**
 * What one drone did, oldest first: [{ id, t (seconds, the league's and the chart's clock), kind, text, side? }]. kind: look,
 * pass, enter, rest, cancel, refused, failed (a seat's decision: each is a look), exit (a closed paper trade), note, plan, fill
 * (a live agent's stream; LOOK rows are looks), signal (the bot's last line). Only what the page already holds.
 */
function seatActs(day, seat) {
  const out = [];
  for (const d of (day && day.decisions) || []) {
    if (!d || d.seat !== seat || !isNum(d.t)) continue;
    const th = thoughtOf(d), a = d.answer && typeof d.answer === 'object' ? d.answer : {};
    const side = a.side === 'short' ? 'short' : a.side === 'long' ? 'long' : '';
    let text = th.line;
    if (th.action === 'pass') text = 'PASS  ' + th.line;
    else if (th.action === 'enter') text = (d.relation === 'with' ? 'JOIN ' : 'ENTER ') + (side || 'long') + (isNum(d.contracts) ? ' ' + d.contracts + ' MNQ' : '') + (isNum(a.stop_points) ? ', stop ' + pts(a.stop_points) + ' pt' : '') +
      (isNum(a.target_points) ? ', target ' + pts(a.target_points) + ' pt' : '') + (d.relation === 'with' ? ', with Anthony' : '') + (th.line && th.line !== 'no reasoning given' ? '  ' + th.line : '');
    else if (th.action === 'rest') text = 'REST ' + (side || 'long') + (a.reference ? ' at ' + str(a.reference, 30) : '') + '  ' + th.line;
    else if (th.action === 'cancel') text = 'CANCEL resting order  ' + th.line;
    else if (th.action === 'refused') text = 'REFUSED  ' + th.line;
    else if (th.action === 'failed') text = 'NO ANSWER  the call failed';
    out.push({ id: 'd:' + th.id, t: d.t / 1000, kind: th.action, text, side });
  }
  for (const t of (day && day.trades) || []) {
    if (!t || t.seat !== seat || !isNum(t.exitT)) continue;
    out.push({ id: 'x:' + (t.id || t.fillT), t: t.exitT / 1000, kind: 'exit', text: 'EXIT ' + (t.r !== null ? (t.r >= 0 ? '+' : '') + t.r.toFixed(2) + 'R' : 'R ' + NR) + (t.exitReason ? '  ' + t.exitReason : '') });
  }
  return out.sort((a, b) => a.t - b.t);
}
function agentActs(g, zs) {
  const out = [], z = typeof zs === 'function' ? zs : ms => ms / 1000;   // the stream's times are epoch ms; the sky's clock is the league's
  for (const r of (g && Array.isArray(g.stream) ? g.stream : [])) {
    const tag = str(r.tag, 12).toUpperCase(), kind = tag === 'LOOK' ? 'look' : tag === 'PASS' ? 'pass' : tag === 'PLAN' ? 'plan' : tag === 'FILL' ? 'fill' : tag === 'EXIT' ? 'exit' : tag === 'REFUSED' ? 'refused' : 'note';
    out.push({ id: 'a:' + str(r.key, 120), t: isNum(r.at) ? z(r.at) : 0, kind, text: (tag ? tag + '  ' : '') + firstLine(r.text, 160) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** One minute bar for the sky's pillars from ChartBridge's history row [t, o, h, l, c], or null when any of them is missing or
    not a finite number (a null would read as 0 and wreck the scale; a NaN would break the drawing). */
function cleanBar(b) {
  if (!Array.isArray(b) || b.length < 5) return null;
  const v = [0, 1, 2, 3, 4].map(i => (b[i] === null || b[i] === '' || b[i] === undefined ? NaN : +b[i]));
  return v.every(isNum) ? { t: v[0], o: v[1], h: v[2], l: v[3], c: v[4] } : null;
}

/**
 * Anthony's own entries today from his fills (the order connection's execs for the ticket's account, read only): a fill that takes
 * an instrument from flat (or through flat) is an entry. fills: [{ root, side, qty, p, t }]; start: { root: the position before
 * today's first fill }. Returns [{ t, p, side, root }], oldest first.
 */
function entriesOf(fills, start) {
  const pos = Object.assign({}, start || {}), out = [];
  for (const f of (Array.isArray(fills) ? fills : []).filter(x => x && isNum(+x.t) && isNum(+x.qty) && isNum(+x.p)).sort((a, b) => a.t - b.t)) {
    const q = (f.side === 'sell' ? -1 : 1) * Math.abs(+f.qty), was = pos[f.root] || 0, now = was + q;
    if (now !== 0 && (was === 0 || Math.sign(now) !== Math.sign(was))) out.push({ t: +f.t, p: +f.p, side: now > 0 ? 'long' : 'short', root: f.root });
    pos[f.root] = now;
  }
  return out;
}

/**
 * The sky: { drones, idle } from what the strip reads. o: { day, nowMs, last (MNQ's price or null), pv, agents: [{ a, g }], bot (the
 * Bot desk's glance), lastOf(root), pvOf(root), zoneSec(ms) (epoch ms to the league's clock in seconds) }. A drone: { key, kind, id, letter, name, color, ring ('solid' LIVE, 'dashed'
 * otherwise), mode, state (one word or ''), alert, trade ({ side, contracts, entry, stop, fillT (s) or null, r, be } or null), todayR,
 * spend (text or ''), rails (the bot's, or ''), looks (counted looks in the last hour, a seat's; null for the others), acts, card }.
 * idle: the names folded into "+N idle".
 */
function skyModel(o) {
  const x = o || {}, drones = [], idle = [], zs = typeof x.zoneSec === 'function' ? x.zoneSec : ms => ms / 1000;
  const mk = (card, extra) => Object.assign({ key: card.key, kind: card.kind, id: card.id, letter: card.letter, name: card.name, color: card.color || AGENT_COLOR,
    ring: card.mode && card.mode.kind === 'live' ? 'solid' : 'dashed', mode: card.mode ? card.mode.word : '?', state: card.state ? card.state.word : '', alert: !!card.alert, card }, extra);
  if (x.day) {
    const cards = seatCards(x.day, { nowMs: x.nowMs, last: x.last, pv: x.pv });
    const st = x.day.status && x.day.status.seats && typeof x.day.status.seats === 'object' ? x.day.status.seats : {};
    const spend = (x.day.status && x.day.status.spend) || null;
    const pv = isNum(x.pv) && x.pv > 0 ? x.pv : MNQ_POINT;
    for (const c of cards) {
      if (!seatActive(x.day, c.id, x.nowMs)) { idle.push(c.name); continue; }
      const p = st[c.id] && st[c.id].position && typeof st[c.id].position === 'object' ? st[c.id].position : null;
      const ot = (x.day.open || []).find(t => t.seat === c.id) || null;
      const same = !!ot && (!p || !p.id || !ot.id || p.id === ot.id);
      let trade = null;
      if (p || ot) {
        const side = (p ? p.side : ot.side) === 'short' ? 'short' : 'long';
        const entry = p && isNum(p.fill_px) ? p.fill_px : ot ? ot.fillPx : null;
        const stop = p && isNum(p.stop_px) ? p.stop_px : ot && isNum(ot.stopPx) ? ot.stopPx : null;
        const contracts = p && isNum(p.contracts) ? p.contracts : ot ? ot.contracts : null;
        const date = (x.day.status && str(x.day.status.date, 10)) || x.day.date;
        const fillMs = ot && isNum(ot.fillT) ? ot.fillT : p ? wallMs(date, str(p.fill_time, 8)) : null;
        const r = openR({ side, contracts, fill: entry }, x.last, pv, { risk: same ? ot.riskDollars : null, stopPoints: same ? ot.stopPoints : null });
        if (isNum(entry)) trade = { side, contracts, entry, stop, fillT: isNum(fillMs) ? fillMs / 1000 : null, r, be: isNum(stop) && (side === 'long' ? stop >= entry : stop <= entry) };
      }
      const sp = spend && spend.seats && isNum(spend.seats[c.id]) ? money(spend.seats[c.id]) : '';
      drones.push(mk(c, { trade, todayR: c.today.r, spend: sp, rails: '', looks: c.looks, acts: seatActs(x.day, c.id) }));
    }
  }
  for (const it of x.agents || []) {
    const a = it.a || {}, g = it.g || null;
    if (!agentFlies(a, g)) { idle.push(a.name || a.agent || 'Agent'); continue; }
    const c = agentCard(a, g, { last: x.lastOf, pv: x.pvOf });
    const p = a.position && isNum(a.position.qty) && a.position.qty ? a.position : null;
    let trade = null;
    if (p && isNum(p.avgPrice)) {
      const root = str(p.root, 8), side = p.qty < 0 ? 'short' : 'long';
      const stopO = (g && Array.isArray(g.orders) ? g.orders : []).find(q => q.role === 'stop' && q.root === root && isNum(q.price));
      const last = typeof x.lastOf === 'function' ? x.lastOf(root) : null, pv = typeof x.pvOf === 'function' ? x.pvOf(root) : null;
      const stop = stopO ? stopO.price : null;
      trade = { side, contracts: Math.abs(p.qty), entry: p.avgPrice, stop, fillT: g && isNum(g.sinceAt) ? zs(g.sinceAt) : null,
        r: openR({ side, contracts: Math.abs(p.qty), fill: p.avgPrice }, last, pv, { risk: g && isNum(g.openRisk) ? g.openRisk : null }), be: isNum(stop) && (side === 'long' ? stop >= p.avgPrice : stop <= p.avgPrice) };
    }
    const sp = g && g.spend && isNum(g.spend.session) ? money(g.spend.session) : '';
    drones.push(mk(c, { trade, todayR: c.today.r, spend: sp, rails: '', looks: null, acts: agentActs(g, zs) }));
  }
  if (x.bot && x.bot.offered) {
    if (!botActive(x.bot)) idle.push((x.bot.strip && x.bot.strip.name) || 'Bot');
    else {
      const c = botCard(x.bot, { last: x.lastOf, pv: x.pvOf });
      const b = x.bot.bot, p = b && b.position && isNum(b.position.qty) && b.position.qty ? b.position : null;
      const trade = p && isNum(p.avgPrice) ? { side: p.qty < 0 ? 'short' : 'long', contracts: Math.abs(p.qty), entry: p.avgPrice, stop: null, fillT: null, r: null, be: false } : null;
      const sm = x.bot.strip;
      const acts = sm && sm.last ? [{ id: 'b:' + str(sm.last, 200), t: 0, kind: 'signal', text: str(sm.last, 160) }] : [];
      drones.push(mk(c, { trade, todayR: null, spend: '', rails: c.spend && c.spend.line1 ? c.spend.line1 : '', looks: null, acts }));
    }
  }
  return { drones, idle: idle.filter(Boolean) };
}

/**
 * The fields of a drone's text block that fit its slot (Anthony: "each agent's text block kept inside its own slot"): fields
 * [{ text, keep }] in order, w(text) their width, maxW the room, gap between them. Each field is kept whole while it fits; a
 * field with keep: 'cut' is cut short with "..." instead of dropped. Returns the kept fields with their x.
 */
function fitFields(fields, w, maxW, gap) {
  const out = []; let x = 0;
  for (const f of fields) {
    if (!f || !f.text) continue;
    const g = out.length ? gap || 0 : 0, fw = w(f.text);
    if (x + g + fw <= maxW) { out.push({ text: f.text, x: x + g, w: fw, f }); x += g + fw; continue; }
    if (f.keep === 'cut') {
      let t = f.text;
      while (t.length > 1 && x + g + w(t + '...') > maxW) t = t.slice(0, -1);
      if (t.length > 1 && x + g + w(t + '...') <= maxW) { const tw = w(t + '...'); out.push({ text: t + '...', x: x + g, w: tw, f }); x += g + tw; }
    }
  }
  return out;
}

return { SEATS, LOOKS_PER_HOUR, HOUR_MS, MNQ_POINT, NR, THOUGHTS_MAX, clock, wallMs, clockDate, firstLine, lookCap, seatMode, liveMode, agentMode, thoughtOf, seatThoughts, lookKind,
  positionBlock, seatRest, seatCards, agentActive, agentCard, botCard, idleLine, money, signedMoney, signedR,
  AGENT_COLOR, cleanBar, openR, seatActive, dayOver, seatHolds, agentFlies, botActive, seatActs, agentActs, entriesOf, skyModel, fitFields };
});

/* ======================================================================== the card (browser only) */
/* 1.38.0: the Agents panel became the Drone sky (live/agents-sky.js). The strip's card is today's full card, shown as the pop-up
   when the mouse is on a drone (or a drone's button has the focus); its markup and its full reasoning box live here. */
if (typeof window !== 'undefined' && typeof document !== 'undefined') (function () {
'use strict';
const C = window.AgentsStripCore;
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** What a click on the card opens: the League tab for a seat, the Bot view for the bot, the Agent tab for a live agent. */
const openWhat = c => (c.kind === 'seat' ? 'Open the League tab' : c.kind === 'bot' ? 'Open the Bot (its switches, kill switch and rails)' : 'Open the Agent tab for ' + c.name);

/** One agent's card (the 1.36.0 strip card): name, mode, state, Now, Today, Spend (the bot's Rails) and Thoughts, newest first. */
function cardHtml(c) {
  const p = c.position, t = c.today, sp = c.spend;
  const letter = c.kind === 'seat' ? '<i class="lg-letter as-letter" aria-hidden="true">' + esc(c.letter) + '</i>' : '<i class="as-letter as-ag" aria-hidden="true">' + esc(c.letter) + '</i>';
  const ow = openWhat(c);
  const now = p.flat ? '<div class="as-v"><b>' + esc(p.head) + '</b></div>'
    : '<div class="as-v"><b class="as-side ' + esc(p.side) + '">' + esc(p.head) + '</b>' + (p.since ? ' <span class="as-mut">since ' + esc(p.since) + '</span>' : ' <span class="as-mut">since ' + C.NR + '</span>') + '</div>' +
      (p.open ? '<div class="as-v mono"><span class="as-pnl ' + esc(p.open.tone) + '" title="' + esc(p.open.title) + '">' + esc(p.open.text) + '</span></div>' : '') +
      '<div class="as-v mono as-mut">' + esc(p.stops) + '</div>';
  const rest = p.rest ? '<div class="as-v as-mut">' + esc(p.rest) + '</div>' : '';
  const today = '<div class="as-v mono"><span class="as-pnl ' + (t.usd !== null ? (t.usd > 0 ? 'up' : t.usd < 0 ? 'down' : '') : '') + '">' + esc(t.usd !== null ? C.signedMoney(t.usd) || '$0.00' : 'P&L ' + C.NR) + '</span>' +
    ' · <span class="as-pnl ' + (t.r !== null ? (t.r > 0 ? 'up' : t.r < 0 ? 'down' : '') : '') + '">' + esc(t.r !== null ? C.signedR(t.r) || '0.00 R' : t.rNote || 'R ' + C.NR) + '</span>' +
    ' · ' + t.n + (t.n === 1 ? ' trade' : ' trades') + (t.n ? (t.wins !== null && t.wins !== undefined ? ' ' + t.wins + 'W ' + t.losses + 'L' : t.losses !== null ? ' · ' + t.losses + ' losing' : '') : '') + '</div>' +
    '<div class="as-v as-mut mono">' + esc(t.account) + ' · ' + esc(t.room) + '</div>';
  const spend = '<div class="as-v mono' + (sp.level === 'red' ? ' as-red' : sp.level === 'amber' ? ' as-warn' : '') + '" title="' + esc(sp.title) + '">' + esc(sp.line1) + '</div>' + (sp.line2 ? '<div class="as-v mono as-mut" title="' + esc(sp.title) + '">' + esc(sp.line2) + '</div>' : '');
  const th = c.thoughts.length ? c.thoughts.map(x => '<li><button type="button" class="as-th k-' + esc(x.action) + '" data-th="' + esc(x.id) + '" aria-label="' + esc(x.time + ' ' + x.action + ': open the full reasoning') + '">' +
    '<span class="mono as-t">' + esc(x.time) + '</span><span class="as-act">' + esc(x.action) + '</span><span class="mono as-conf">' + esc(x.conf) + '</span><span class="as-tx">' + esc(x.line) + '</span></button></li>').join('')
    : '<li class="as-mut as-none">No thought yet today.</li>';
  return '<article class="as-card k-' + c.kind + ' m-' + esc(c.mode.kind) + (c.alert ? ' as-alert' : '') + '" data-card="' + esc(c.key) + '"' + (c.color ? ' style="--seat:' + esc(c.color) + '"' : '') + ' title="' + esc(ow) + '">' +
    '<header class="as-head">' + letter + '<span class="as-name">' + esc(c.name) + '</span><span class="as-fill"></span>' +
      '<span class="as-mode m-' + esc(c.mode.kind) + '" title="' + esc(c.mode.sub) + '">' + esc(c.mode.word) + '</span>' +
      '<button type="button" class="as-open" data-open="1" aria-label="' + esc(ow) + '" title="' + esc(ow) + '">›</button></header>' +
    '<div class="as-sub"><span class="as-mut">' + esc(c.mode.sub) + '</span>' + (c.state ? '<span class="as-state' + (c.alert ? ' red' : '') + '" title="' + esc(c.state.why) + '">' + esc(c.state.word) + '</span>' : '') + '</div>' +
    (c.status ? '<div class="as-v as-mut" title="' + esc(c.status) + '">' + esc(c.status) + '</div>' : '') +
    (c.state && c.state.word === 'look cap' ? '<div class="as-v as-warn">' + esc(c.state.why.replace(/ \(worked out.*$/, '')) + '</div>' : '') +
    (c.flag ? '<div class="as-v as-flag" title="' + esc(c.flag) + '">Flag: ' + esc(c.flag) + '</div>' : '') +
    '<section class="as-sec" aria-label="Now"><span class="as-lbl">Now</span><div>' + now + rest + '</div></section>' +
    '<section class="as-sec" aria-label="Today"><span class="as-lbl">Today</span><div>' + today + '</div></section>' +
    '<section class="as-sec" aria-label="' + esc(sp.label || 'Spend') + '"><span class="as-lbl">' + esc(sp.label || 'Spend') + '</span><div>' + spend + '</div></section>' +
    '<section class="as-sec as-ths" aria-label="Stream of thoughts, newest first"><span class="as-lbl">Thoughts</span><ol class="as-list">' + th + '</ol></section>' +
    '</article>';
}
/** A thought's full reasoning (a click on it in the card): the box under the card. */
function detailHtml(c, id) {
  const t = c && c.thoughts.find(x => x.id === id);
  return !t ? '<div class="as-dhead"><b>' + esc(c ? c.name : 'Agent') + '</b><span class="as-fill"></span><button type="button" class="ws-btn" data-close="1">Close</button></div><p class="as-mut">This thought is no longer in the newest few.</p>'
    : '<div class="as-dhead"><b>' + esc(c.name) + '</b><span class="as-act k-' + esc(t.action) + '">' + esc(t.action) + '</span>' + (t.conf ? '<span class="mono">confidence ' + esc(t.conf) + '</span>' : '') +
      '<span class="as-mut mono">' + esc(t.detail) + '</span><span class="as-fill"></span><button type="button" class="ws-btn" data-close="1">Close</button></div>' +
      '<p class="as-full">' + esc(t.full || t.line) + '</p>' + (c.kind === 'seat' ? '<p class="as-mut">SHADOW: paper only, no orders.</p>' : '');
}

window.AgentsStrip = { cardHtml, detailHtml, openWhat, esc };
})();
