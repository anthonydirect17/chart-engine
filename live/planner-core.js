/*
 * PlannerCore: the planner's rules, pure (chart 1.62.0, Anthony 2026-11-21, the planner on the page path). No DOM; it also loads
 * in Node for test/planner-core.test.js. The page part is live/planner.js.
 *
 * What a plan is: a trade Anthony draws on a chart (the engine's plan layer), with its side, entry line, stop, target 1, qty,
 * account (one account, never a group: decision 7), entry type, expiry (1 to 30 minutes from Arm, 30 unless set: decision 9) and
 * grade (A+, A or B, A+ unless set: decision 12). Submit stamps it at The Desk (its plan log, the reused call chain), Arm stamps
 * `arm` and The Desk answers when it expires on its own clock; then exactly one window on this PC (the leader, a Web Lock) sends
 * its entry through TradeCore's own order path (sendPlanOrder) and watches it from the trades.
 *
 * Here:
 *   the model        newUid, cleanDraft, validate, submitBody, phaseOf, viewOf (what the engine draws), cardWords
 *   the entry        entryFor (decision 2 A: by where the line sits against the last price at Arm), bracketFor (decision 3 A)
 *   the watches      createWatch: touch, the 1 minute confirmation (decision 13 A), stop-through, expiry, from trades and the clock
 *   resume           reconcile: after a reload, a crash or a ChartBridge restart; NEVER a second entry
 *   the journal      createJournal: the local send journal, written synchronously before every entry send (decision 11 A)
 *   The Desk's queue createQueue: the facts recorded at The Desk, kept in this browser while The Desk does not answer
 *   The Desk         deskApi: the plan log's endpoints (TheDesk docs/API.md "Plans"); an older Desk with none: `none`
 *   the leader       createLeader: one window per PC places entries and runs watches (Web Lock "chartbridge-planner", queued)
 *   the shared state createShared: every window shows every plan (BroadcastChannel "chartbridge-planner-v1" + live-planner-v1)
 *
 * Nothing here sends an order: the page hands sendPlanOrder the plan, and ChartBridge decides as for any order.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlannerCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const LOCK = 'chartbridge-planner';
const CHANNEL = 'chartbridge-planner-v1';
const STORE_KEY = 'live-planner-v1';          // the drawn plans not yet submitted, and the plans The Desk last gave (every window)
const JOURNAL_KEY = 'live-planner-sent-v1';   // { <plan uid>: { entry: { cid, at } } }: an entry sent, written before the send
const QUEUE_KEY = 'live-planner-queue-v1';    // the facts waiting for The Desk
const OFF_KEY = 'live-planner-off-v1';        // true: Planner off in this browser
const ROOTS = ['MNQ', 'NQ', 'MES', 'ES'];
const SIDES = ['long', 'short'];
const ENTRY_TYPES = ['limit', 'touch', 'confirm'];
const ENTRY_WORDS = { limit: 'Limit at the line', touch: 'Market on touch', confirm: 'Touch, then a 1 minute close back' };
const ENTRY_SHORT = { limit: 'LMT', touch: 'TOUCH', confirm: 'CONFIRM' };
const GRADES = ['A+', 'A', 'B'];
const GRADE_DEFAULT = 'A+';
const EXPIRY_MIN = 1, EXPIRY_MAX = 30, EXPIRY_DEFAULT = 30;   // minutes from Arm (decision 9 A; Anthony: "30 mins is fine")
const CONFIRM_LAG_MS = 250;                    // a minute's close is checked this long after the minute boundary
const QTY_MAX = 50;                            // a sanity bound; ChartBridge's maxQty decides
const JOURNAL_KEEP_MS = 3 * 86400000;
const QUEUE_MAX = 500;
const EVENT_KINDS = ['edit', 'arm', 'cancel', 'sent', 'placed', 'refused', 'touched', 'confirmed', 'filled', 'closed', 'expired', 'stop_through', 'missed', 'override', 'owner', 'ended'];
/* the facts that end a plan before (or without) a fill, and after it */
const END_KINDS = ['cancel', 'refused', 'expired', 'stop_through', 'missed', 'closed', 'ended'];
const OVERRIDES = ['armed_on', 'manual_order', 'flatten', 'flatten_all', 'cut_half', 'moved_outside', 'cancelled_outside', 'position_outside'];

const isNum = v => typeof v === 'number' && isFinite(v);
const onGrid = (p, tick) => isNum(p) && tick > 0 && Math.abs(p / tick - Math.round(p / tick)) < 1e-6;
const roundTo = (p, tick) => Math.round(p / tick) * tick;
const dirOf = side => (side === 'short' ? -1 : 1);
const orderSide = side => (side === 'short' ? 'sell' : 'buy');
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

/** A new plan uid: "pu" and 16 of a-z, 0-9 (rand: Math.random by default). The entry's cid is "pl<uid>-e". */
function newUid(rand) {
  const r = typeof rand === 'function' ? rand : Math.random, abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'pu';
  for (let i = 0; i < 16; i++) s += abc[Math.floor(r() * abc.length) % abc.length];
  return s;
}
const UID_RX = /^pu[a-z0-9]{16}$/;
/** The entry's cid, fixed per plan and leg: one plan has one entry, so one cid ever. */
const entryCid = uid => 'pl' + uid + '-e';
/** The plan uid an order's cid names, or '' (not a plan's). */
function uidOfCid(cid) { const m = typeof cid === 'string' ? /^pl(pu[a-z0-9]{16})-e$/.exec(cid) : null; return m ? m[1] : ''; }

/** A drawn plan as kept (before Submit), or null: every field checked for its type only (validate says what is wrong). */
function cleanDraft(d) {
  if (!d || typeof d !== 'object' || !UID_RX.test(d.uid || '') || !ROOTS.includes(d.root)) return null;
  const num = v => (isNum(v) ? v : null);
  return { uid: d.uid, root: d.root, side: SIDES.includes(d.side) ? d.side : 'long', entry: num(d.entry), stop: num(d.stop), target: num(d.target),
    qty: Number.isInteger(d.qty) && d.qty > 0 ? d.qty : 1, account: str(d.account, 64), entryType: ENTRY_TYPES.includes(d.entryType) ? d.entryType : 'limit',
    expiryMin: Number.isInteger(d.expiryMin) ? d.expiryMin : EXPIRY_DEFAULT, grade: GRADES.includes(d.grade) ? d.grade : GRADE_DEFAULT,
    t0: num(d.t0), contract: str(d.contract, 32), tick: num(d.tick), at: num(d.at) };
}

/**
 * What is wrong with a plan before Submit ('' when nothing): ctx { tick, maxQty (ChartBridge's for its root; 0 when not known),
 * maxBracketTicks (0: no cap), accounts (the trade accounts ChartBridge lists) }. Submit works at any hour (Anthony: "this
 * system would be open to all hours"); only Arm needs CME open.
 */
function validate(d, ctx) {
  const c = ctx || {}, tick = c.tick > 0 ? c.tick : d && d.tick;
  if (!d) return 'No plan.';
  if (!ROOTS.includes(d.root)) return 'The plan\'s instrument is not one ChartBridge trades here.';
  if (!SIDES.includes(d.side)) return 'Pick long or short.';
  if (!(tick > 0)) return 'The instrument\'s tick is not known yet.';
  for (const [k, w] of [['entry', 'entry line'], ['stop', 'stop'], ['target', 'target 1']]) {
    if (!isNum(d[k])) return 'The plan needs its ' + w + '.';
    if (!onGrid(d[k], tick)) return 'The ' + w + ' is not on the tick (' + tick + ').';
  }
  const dir = dirOf(d.side);
  if (!((d.entry - d.stop) * dir > 0)) return 'The stop must be ' + (dir > 0 ? 'below' : 'above') + ' the entry for a ' + d.side + '.';
  if (!((d.target - d.entry) * dir > 0)) return 'Target 1 must be ' + (dir > 0 ? 'above' : 'below') + ' the entry for a ' + d.side + '.';
  if (!Number.isInteger(d.qty) || d.qty < 1 || d.qty > QTY_MAX) return 'Qty must be a whole number from 1.';
  if (c.maxQty > 0 && d.qty > c.maxQty) return 'Qty ' + d.qty + ' is over ChartBridge\'s ' + d.root + ' limit of ' + c.maxQty + '.';
  if (!Number.isInteger(d.expiryMin) || d.expiryMin < EXPIRY_MIN || d.expiryMin > EXPIRY_MAX) return 'Expiry must be ' + EXPIRY_MIN + ' to ' + EXPIRY_MAX + ' minutes.';
  if (!GRADES.includes(d.grade)) return 'Grade must be A+, A or B.';
  if (!ENTRY_TYPES.includes(d.entryType)) return 'Pick an entry type.';
  if (!d.account) return 'Pick the account the plan trades on.';
  if (/^group:/.test(d.account)) return 'A plan trades one account, never a group.';
  if (Array.isArray(c.accounts) && !c.accounts.includes(d.account)) return d.account + ' is not a trade account in ChartBridge.';
  const b = bracketTicks(d, d.entry, tick);
  if (c.maxBracketTicks > 0 && (b.stop > c.maxBracketTicks || b.target > c.maxBracketTicks)) return 'The stop or target is more than ChartBridge\'s ' + c.maxBracketTicks + ' ticks (maxBracketTicks).';
  return '';
}
/** The stop and target 1 in whole ticks from `from` (decision 3 A: ChartBridge's bracket is ticks from the fill). */
function bracketTicks(d, from, tick) {
  const dir = dirOf(d.side);
  return { stop: Math.round((from - d.stop) * dir / tick), target: Math.round((d.target - from) * dir / tick) };
}
/** The Desk's Submit body (POST /api/plans): the call log's fields and the plan's own (`plan`, JSON). pc: this PC's name. */
function submitBody(d, pc) {
  return { uid: d.uid, root: d.root, side: d.side, entry: d.entry, stop: d.stop, targets: [d.target], size: d.qty, account: d.account, grade: d.grade,
    plan: { uid: d.uid, pc: pc || '', entry_type: d.entryType, expiry_min: d.expiryMin, qty: d.qty, target1: d.target, tick: d.tick, contract: d.contract || '' } };
}

/**
 * The entry at Arm (decision 2 A), by where the line sits against the last price (ChartBridge's gate 5): the limit side (a buy's
 * line at or under the last price, a sell's at or over it) or the stop side. Returns { kind, price } to send, { kind: null }
 * for a confirmation (nothing is sent until it confirms), or { refuse } with why. orderTypes: ChartBridge's switch (an MIT needs it).
 */
function entryFor(d, last, orderTypes) {
  if (!isNum(last) || !(last > 0)) return { refuse: 'No recent ' + d.root + ' price: not armed.' };
  if (d.entryType === 'confirm') return { kind: null, price: null };
  const buy = d.side !== 'short', limitSide = buy ? d.entry <= last : d.entry >= last;
  if (d.entryType === 'limit') {
    if (!limitSide) return { refuse: 'A ' + (buy ? 'buy' : 'sell') + ' limit at ' + d.entry + ' is through the market (last ' + last + ') and would fill at once: not armed. Use Market on touch for that side.' };
    return { kind: 'limit', price: d.entry };
  }
  if (Math.abs(d.entry - last) < 1e-9) return { refuse: 'The line is at the last price: a touch entry would trigger at once. Not armed.' };
  if (limitSide) {
    if (orderTypes === false) return { refuse: 'Market on touch on this side is an MIT order, and MIT is off in ChartBridge (orderTypes = off in config.txt): not armed.' };
    return { kind: 'mit', price: d.entry };
  }
  return { kind: 'stop', price: d.entry };
}
/**
 * The bracket sent with the entry (decision 3 A): ticks from the fill, measured from the line for an order resting at the line
 * (limit, MIT, stop-market), from the last price at send for the confirmation's market order. { stop, target } or { refuse }.
 */
function bracketFor(d, kind, last, tick, maxBracketTicks) {
  const from = kind === 'market' ? last : d.entry;
  if (!isNum(from)) return { refuse: 'No price to measure the bracket from.' };
  const b = bracketTicks(d, from, tick);
  if (!(b.stop > 0)) return { refuse: 'The price is at or past the stop: not sent.' };
  if (!(b.target > 0)) return { refuse: 'The price is at or past target 1: not sent.' };
  if (maxBracketTicks > 0 && (b.stop > maxBracketTicks || b.target > maxBracketTicks)) return { refuse: 'The bracket is more than ChartBridge\'s ' + maxBracketTicks + ' ticks from the price now: not sent.' };
  return { stop: b.stop, target: b.target };
}
/** Is a trade at `price` through the stop (at least one tick beyond it, decision 13 A)? */
const throughStop = (d, price, tick) => (d.side === 'short' ? price >= d.stop + tick - 1e-9 : price <= d.stop - tick + 1e-9);
/** Is a trade at `price` a touch of the line (at it or beyond, from the side price came from)? */
const touches = (d, price) => (d.side === 'short' ? price >= d.entry - 1e-9 : price <= d.entry + 1e-9);
/** Is a minute's close back on his side (long: above the line; equal does not count)? */
const closesBack = (d, close) => (d.side === 'short' ? close < d.entry - 1e-9 : close > d.entry + 1e-9);

/**
 * A plan's watch before its fill, run by the leader from the trades of its instrument and the clock. plan { side, entry, stop,
 * entryType }, opts { tick, expiresAt (UTC ms), sent (true once its entry went: then only stop-through and expiry are watched),
 * touched (a touch already seen, its minute) }. trade(price, ms) and time(ms) return the facts they found, in order:
 *   { kind: 'stop_through', at, price }    a trade a tick beyond the stop: the plan ends (the working entry is cancelled)
 *   { kind: 'expired', at }                 the clock passed expiresAt: the plan ends
 *   { kind: 'touched', at, price }          a confirmation plan's line was touched (recorded)
 *   { kind: 'confirmed', at, close, minute } a minute closed back on his side at or after the touch's minute: send the market entry
 * After an ending fact or a confirmation the watch is done (nothing more). A minute's close is its last trade; it is final once a
 * trade of a later minute comes, or CONFIRM_LAG_MS after the boundary (time()). Minutes are New York's (whole UTC minutes).
 */
function createWatch(plan, opts) {
  const o = opts || {}, tick = o.tick > 0 ? o.tick : 0.25;
  const S = { done: false, sent: !!o.sent, touchMin: isNum(o.touched) ? o.touched : null, min: null, close: null };
  const confirm = plan.entryType === 'confirm';
  const minuteOf = ms => Math.floor(ms / 60000);
  function closeMinute(out, m, close, at) {
    if (S.done || S.sent || !confirm || S.touchMin === null || m < S.touchMin || close === null) return;
    if (closesBack(plan, close)) { S.done = true; out.push({ kind: 'confirmed', at, close, minute: m * 60000 }); }
  }
  function expiry(out, ms) { if (!S.done && isNum(o.expiresAt) && ms >= o.expiresAt) { S.done = true; out.push({ kind: 'expired', at: ms }); } }
  return {
    trade(price, ms) {
      const out = [];
      if (S.done || !isNum(price) || !isNum(ms)) return out;
      const m = minuteOf(ms);
      if (S.min !== null && m > S.min) { closeMinute(out, S.min, S.close, ms); S.close = null; }
      if (S.done) return out;
      expiry(out, ms);
      if (S.done) return out;
      if (throughStop(plan, price, tick)) { S.done = true; out.push({ kind: 'stop_through', at: ms, price }); return out; }
      S.min = m; S.close = price;
      if (confirm && !S.sent && S.touchMin === null && touches(plan, price)) { S.touchMin = m; out.push({ kind: 'touched', at: ms, price }); }
      return out;
    },
    time(ms) {
      const out = [];
      if (S.done) return out;
      if (S.min !== null && ms >= (S.min + 1) * 60000 + CONFIRM_LAG_MS) { closeMinute(out, S.min, S.close, ms); S.min = null; S.close = null; }
      if (!S.done) expiry(out, ms);
      return out;
    },
    /** the entry went (a confirmation's market order, or the resting entry): from now on only stop-through and expiry */
    sent() { S.sent = true; },
    state: () => ({ done: S.done, sent: S.sent, touched: S.touchMin }),
  };
}

/** A plan The Desk gave, its phase from its facts: 'submitted', 'armed' (nothing sent), 'working' (its entry sent), 'filled',
 *  'ended' (and why: the ending fact's kind). */
function phaseOf(v) {
  const ev = v && Array.isArray(v.events) ? v.events : [];
  const has = k => ev.some(e => e && e.kind === k);
  const end = ev.find(e => e && END_KINDS.includes(e.kind) && !(e.kind === 'cancel' && has('filled')));
  if (has('closed') || has('ended')) return { phase: 'ended', why: has('closed') ? 'closed' : 'ended' };
  if (has('filled')) return { phase: 'filled', why: '' };
  if (end) return { phase: 'ended', why: end.kind };
  if (has('sent') || has('placed')) return { phase: 'working', why: '' };
  if (has('arm')) return { phase: 'armed', why: '' };
  return { phase: 'submitted', why: '' };
}
/** When an armed plan expires (UTC ms), from its arm fact or the view's own field; null when not armed. */
function expiresOf(v) {
  if (v && isNum(v.expires_at_ms)) return v.expires_at_ms;
  const a = v && Array.isArray(v.events) ? v.events.find(e => e && e.kind === 'arm') : null;
  return a && a.detail && isNum(a.detail.expires_at_ms) ? a.detail.expires_at_ms : null;
}
/** A plan The Desk gave, in the page's shape: { seq, uid, root, side, entry, stop, target, qty, account, grade, entryType, expiryMin,
 *  tick, contract, pc, phase, why, expiresAt, armedAt, events }; null when it is not a plan. */
function fromDesk(v) {
  if (!v || typeof v !== 'object' || !Number.isInteger(v.seq) || !v.plan || typeof v.plan !== 'object') return null;
  const p = v.plan, uid = typeof v.uid === 'string' ? v.uid : p.uid;
  if (!UID_RX.test(uid || '') || !ROOTS.includes(v.root)) return null;
  const ph = phaseOf(v), arm = (v.events || []).find(e => e && e.kind === 'arm');
  return { seq: v.seq, uid, root: v.root, side: v.side === 'short' ? 'short' : 'long', entry: +v.entry, stop: +v.stop,
    target: isNum(p.target1) ? p.target1 : Array.isArray(v.targets) && isNum(+v.targets[0]) ? +v.targets[0] : null,
    qty: Number.isInteger(p.qty) ? p.qty : +v.size || 1, account: str(v.account, 64), grade: GRADES.includes(v.grade) ? v.grade : GRADE_DEFAULT,
    entryType: ENTRY_TYPES.includes(p.entry_type) ? p.entry_type : 'limit', expiryMin: Number.isInteger(p.expiry_min) ? p.expiry_min : EXPIRY_DEFAULT,
    tick: isNum(p.tick) ? p.tick : null, contract: str(p.contract, 32), pc: str(p.pc, 64), phase: ph.phase, why: ph.why,
    expiresAt: expiresOf(v), armedAt: arm && isNum(arm.logged_at_ms) ? arm.logged_at_ms : null, loggedAt: isNum(v.logged_at_ms) ? v.logged_at_ms : null,
    events: (Array.isArray(v.events) ? v.events : []).filter(e => e && EVENT_KINDS.includes(e.kind)).map(e => ({ kind: e.kind, at: e.logged_at_ms, detail: e.detail || {}, uid: e.uid || '' })) };
}
const WHY_WORDS = { cancel: 'cancelled', refused: 'refused by ChartBridge', expired: 'expired', stop_through: 'price went through the stop', missed: 'missed (not taken late)', closed: 'closed', ended: 'ended' };
/** What the engine draws for a plan (its cleanPlan shape). A draft (not submitted) has no seq. */
function viewOf(p, nowMs, selected) {
  const kind = p.entryType ? ENTRY_SHORT[p.entryType] : '';
  const head = (p.seq ? 'Plan #' + p.seq : 'Plan') + ' ' + (p.side === 'short' ? 'SHORT' : 'LONG') + ' ' + kind + ' ' + p.qty;
  const phase = p.seq ? p.phase : 'draft';
  const left = p.expiresAt && nowMs ? Math.max(0, Math.ceil((p.expiresAt - nowMs) / 60000)) : null;
  const note = phase === 'draft' ? 'not submitted' : phase === 'submitted' ? 'submitted' : phase === 'armed' ? 'armed' + (left !== null ? ' · ' + left + 'm left' : '')
    : phase === 'working' ? 'working' + (left !== null ? ' · ' + left + 'm left' : '') : phase === 'filled' ? 'filled' : WHY_WORDS[p.why] || 'ended';
  const state = phase === 'draft' ? 'draft' : phase === 'submitted' ? 'submitted' : phase === 'armed' ? 'armed' : phase === 'working' ? 'working' : phase === 'filled' ? 'filled' : 'ended';
  return { id: p.uid, side: p.side, entry: p.entry, stop: p.stop, target: p.target, state, editable: phase === 'draft' || phase === 'submitted',
    label: head, note, t0: isNum(p.t0) ? p.t0 : null, qty: p.qty, selected: !!selected };
}

/**
 * Resume after a reload, a crash or a ChartBridge restart (section 3), for the leader once ChartBridge's snapshot is whole.
 * p: the plan (fromDesk); ctx { now, tick, journal (this browser's { cid, at } for its entry, or null), orders (ChartBridge's
 * working orders), execs (its fills), positions (Map 'account|root' -> { qty }), bars (1 minute bars since Arm: [{ t: UTC ms
 * of the minute's start, h, l, c }]) }. Returns one of:
 *   { act: 'expired' | 'stop_through' | 'missed', why }   armed, nothing sent: stamp it and end the plan
 *   { act: 'resume' }                                     armed, nothing sent, nothing happened: watch (and send) again
 *   { act: 'resume_working', id }                         its entry is working: watch it
 *   { act: 'cancel_expired', id, lateMs }                 its entry is working past expiry: cancel it now, stamp `expired`
 *   { act: 'filled', execs: [ids], price, qty, order }    its entry filled meanwhile: stamp `filled`
 *   { act: 'unknown', why }                               sent, outcome not known: an alarm, check NinjaTrader; NEVER sent again
 *   { act: 'none' }                                       nothing to do here (submitted only, filled or ended)
 */
function reconcile(p, ctx) {
  const c = ctx || {}, tick = c.tick > 0 ? c.tick : p.tick || 0.25, now = c.now;
  const sentDesk = (p.events || []).find(e => e.kind === 'sent');
  const sent = c.journal || (sentDesk ? { cid: (sentDesk.detail || {}).cid || entryCid(p.uid), at: sentDesk.at } : null);
  if (p.phase === 'submitted' || p.phase === 'ended' || p.phase === 'filled') return { act: 'none' };
  if (!sent) {
    if (p.phase === 'working') return { act: 'unknown', why: 'The Desk says its entry was placed, but nothing says how: check NinjaTrader.' };
    if (isNum(p.expiresAt) && now >= p.expiresAt) return { act: 'expired', why: 'expired while no window watched it' };
    const bars = (Array.isArray(c.bars) ? c.bars : []).filter(b => b && isNum(b.t) && (!isNum(p.armedAt) || b.t + 60000 > p.armedAt));
    if (bars.some(b => throughStop(p, p.side === 'short' ? b.h : b.l, tick))) return { act: 'stop_through', why: 'price went through the stop while no window watched it' };
    if (bars.some(b => touches(p, p.side === 'short' ? b.h : b.l))) return { act: 'missed', why: 'the line was touched while no window watched it: not taken late' };
    return { act: 'resume' };
  }
  const orders = Array.isArray(c.orders) ? c.orders : [];
  const side = orderSide(p.side), working = o => o && (o.state === 'working' || o.state === 'partFilled' || o.state === 'accepted');
  let o = orders.find(x => x && x.cid === sent.cid && working(x));
  if (!o) {   // after a ChartBridge restart the cid is gone: the same account, root, side, kind, price and qty
    const kinds = p.entryType === 'limit' ? ['limit'] : p.entryType === 'touch' ? ['mit', 'stop'] : ['market'];
    o = orders.find(x => working(x) && x.account === p.account && x.root === p.root && x.side === side && kinds.includes(x.kind) && (x.kind === 'market' || Math.abs(+x.price - p.entry) < 1e-9) && +x.qty === p.qty && (x.role === 'entry' || x.role === 'other' || !x.role));
  }
  if (o) {
    if (isNum(p.expiresAt) && now >= p.expiresAt && !(+o.filled > 0)) return { act: 'cancel_expired', id: o.id, lateMs: now - p.expiresAt };
    return { act: 'resume_working', id: o.id };
  }
  const fills = (Array.isArray(c.execs) ? c.execs : []).filter(f => f && f.account === p.account && f.root === p.root && f.side === side && isNum(+f.u) && +f.u >= (sent.at || 0) - 2000)
    .sort((a, b) => +a.u - +b.u);
  let got = 0; const ids = []; let px = 0;
  for (const f of fills) { if (got >= p.qty) break; got += +f.qty || 0; ids.push(f.id); px += (+f.p || 0) * (+f.qty || 0); }
  if (got >= p.qty) return { act: 'filled', execs: ids, price: Math.round(px / got / tick) * tick, qty: got, order: fills[0].order || '' };
  return { act: 'unknown', why: 'Sent, outcome not known: check NinjaTrader. It is never sent again.' };
}

/**
 * Arm needs CME open (decision 9 A: Arm refused while CME is closed, the 17:00 to 18:00 break, the weekend, holidays, early
 * closes; Submit works at any hour). etSec: New York wall seconds now (ChartEngine.util.zoneSeconds); closed(etSec): the
 * engine's util.cmeClosed. '' when Arm may go, else why not.
 */
function armClosedWhy(etSec, closed) {
  if (typeof closed !== 'function' || !isNum(etSec)) return 'This page cannot tell whether CME is open: not armed.';
  return closed(etSec) ? 'CME is closed now (the 17:00 break, the weekend, a holiday or an early close): not armed. Submit works at any hour; Arm once it opens.' : '';
}

/* ---------------------------------------------------------------- this browser's storage */
function readJson(storage, key, fallback) {
  try { const v = JSON.parse(storage.getItem(key)); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; }
}
function writeJson(storage, key, v) { try { storage.setItem(key, JSON.stringify(v)); return true; } catch (e) { return false; } }

/**
 * The local send journal (decision 11 A): { <uid>: { entry: { cid, at } } } under JOURNAL_KEY, shared by this browser's windows.
 * mark() is written synchronously before the send and read fresh each time, so a window that becomes the leader after another
 * sent the entry never sends it again. Entries older than 3 days go. mark returns false (and the page must not send) when the
 * plan already has one or the browser blocks its storage.
 */
function createJournal(storage, now) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const read = () => { const v = readJson(storage, JOURNAL_KEY, {}); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  return {
    sentOf(uid) { const j = read()[uid]; return j && j.entry && typeof j.entry.cid === 'string' ? { cid: j.entry.cid, at: +j.entry.at || 0 } : null; },
    mark(uid, cid) {
      const all = read(), t = clock();
      if (all[uid] && all[uid].entry) return false;
      for (const k of Object.keys(all)) if (!(all[k] && all[k].entry && t - all[k].entry.at < JOURNAL_KEEP_MS)) delete all[k];
      all[uid] = { entry: { cid, at: t } };
      if (!writeJson(storage, JOURNAL_KEY, all)) return false;
      const back = read()[uid];                                     // read back: written, and this cid
      return !!(back && back.entry && back.entry.cid === cid);
    },
    all: read,
  };
}

/**
 * The facts for The Desk (POST /api/plans/{seq}/events), queued in this browser while The Desk does not answer, as Trade tags
 * are: { uid (the fact's own id; The Desk stores it once), seq, kind, detail, at (this PC's clock, for the order only) }. The Desk
 * stamps its own time. flush(post) posts the oldest first; post(item) resolves 'ok' (taken, or The Desk says it has it), 'drop'
 * (refused with a reason: kept out of the queue and counted as lost) or 'later' (no answer: kept, and the rest wait).
 */
function createQueue(storage, now, rand) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const read = () => { const v = readJson(storage, QUEUE_KEY, null); return v && Array.isArray(v.items) ? { items: v.items, lost: +v.lost || 0 } : { items: [], lost: 0 }; };
  let busy = false, addSeq = 0;
  const q = {
    add(seq, kind, detail) {
      if (!Number.isInteger(seq) || !EVENT_KINDS.includes(kind)) return null;
      const s = read(), item = { uid: 'pe' + newUid(rand).slice(2, 12) + clock().toString(36).slice(-4) + (++addSeq).toString(36), seq, kind, detail: detail || {}, at: clock() };
      s.items.push(item);
      while (s.items.length > QUEUE_MAX) { s.items.shift(); s.lost++; }
      writeJson(storage, QUEUE_KEY, s);
      return item;
    },
    items: () => read().items,
    lost: () => read().lost,
    flush(post) {
      if (busy) return Promise.resolve(0);
      busy = true;
      let done = 0;
      const step = () => {
        const s = read(), item = s.items[0];
        if (!item) return Promise.resolve();
        return Promise.resolve().then(() => post(item)).then(r => {
          if (r !== 'ok' && r !== 'drop') return;
          const t = read();
          t.items = t.items.filter(x => x.uid !== item.uid);
          if (r === 'drop') t.lost++;
          writeJson(storage, QUEUE_KEY, t);
          done++;
          return step();
        }, () => {});
      };
      return step().then(() => { busy = false; return done; }, () => { busy = false; return done; });
    },
  };
  return q;
}

/**
 * The plan log at The Desk (TheDesk docs/API.md "Plans"; the guard and CORS of the chart page's routes). env { base() (a promise
 * of The Desk's address), fetch }. Each call resolves { ok, status, body, why }; status 0 when The Desk did not answer; `none`
 * true when it has no plan log (404 on GET /api/plans: an older Desk).
 */
function deskApi(env) {
  const call = (method, path, body) => Promise.resolve().then(() => env.base()).then(url => env.fetch(url + path, Object.assign({ method, mode: 'cors', credentials: 'omit', cache: 'no-store' },
    body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})))
    .then(r => r.text().then(t => { let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; } return { ok: r.ok, status: r.status, body: j, why: !r.ok ? (j && typeof j.detail === 'string' ? j.detail : 'The Desk answered ' + r.status) : '' }; }),
      () => ({ ok: false, status: 0, body: null, why: 'The Desk did not answer' }));
  return {
    list: pc => call('GET', '/api/plans?' + new URLSearchParams({ live: '1', pc: pc || '' })).then(r => Object.assign(r, { none: r.status === 404 })),
    get: seq => call('GET', '/api/plans/' + seq),
    submit: body => call('POST', '/api/plans', body),
    edit: (seq, body) => call('POST', '/api/plans/' + seq + '/edit', body),
    arm: (seq, uid) => call('POST', '/api/plans/' + seq + '/arm', { uid }),
    cancel: (seq, uid, why) => call('POST', '/api/plans/' + seq + '/cancel', { uid, why: why || '' }),
    event: item => call('POST', '/api/plans/' + item.seq + '/events', { uid: item.uid, kind: item.kind, detail: item.detail }),
  };
}

/**
 * The leader (decision 11 A): the window holding the Web Lock LOCK places entries and runs the watches. Every window asks for it
 * once, queued (never ifAvailable): the browser grants it to one, and when that window closes or crashes the next asking window
 * gets it at once. o { locks (navigator.locks or a fake), onLead(), name }. With no Web Locks this window never leads (no window
 * of this browser can then place a plan: the careful side).
 */
function createLeader(o) {
  const locks = o.locks || null;
  let lead = false, release = null, closed = false;
  function start() {
    if (!locks || closed) return false;
    Promise.resolve(locks.request(o.name || LOCK, lock => {
      if (closed || !lock) return null;
      lead = true;
      const kept = new Promise(r => { release = r; });
      try { if (typeof o.onLead === 'function') o.onLead(); } catch (e) { /* the page's own fault: still the leader */ }
      return kept;
    })).catch(() => {});
    return true;
  }
  return { start, isLeader: () => lead, supported: !!locks, close() { closed = true; lead = false; if (release) release(); release = null; } };
}

/**
 * The plans every window shows (decision 1 A: every chart of the instrument, every window): drafts (drawn, not submitted) and the
 * plans The Desk gave, kept under STORE_KEY and told to the other windows on the channel ({ t: 'changed', from }). An Arm or a
 * Cancel pressed in any window is stamped at The Desk by that window, then told ({ t: 'stamped', uid, from }), and the leader
 * acts on what The Desk stamped only (it reads the plan log again).
 */
function cleanStore(v) {
  const out = { drafts: {}, plans: {} };
  if (!v || typeof v !== 'object') return out;
  for (const [k, d] of Object.entries(v.drafts || {})) { const c = cleanDraft(d); if (c && c.uid === k) out.drafts[k] = c; }
  for (const [k, p] of Object.entries(v.plans || {})) if (p && typeof p === 'object' && UID_RX.test(k) && Number.isInteger(p.seq)) out.plans[k] = p;
  return out;
}
function createShared(o) {
  const storage = o.storage, ch = o.channel || null, wid = o.wid || ('w' + Math.random().toString(36).slice(2, 10));
  const read = () => cleanStore(readJson(storage, STORE_KEY, null));
  const write = s => writeJson(storage, STORE_KEY, s);
  const tell = m => { if (ch) { try { ch.post(Object.assign({ from: wid }, m)); } catch (e) { /* closed */ } } };
  if (ch) ch.onmessage = m => { if (m && m.from !== wid && typeof o.onMessage === 'function') o.onMessage(m); };
  return {
    wid, read,
    /** change(fn): read fresh, change, write, tell the others */
    change(fn) { const s = read(); fn(s); write(s); tell({ t: 'changed' }); return s; },
    tell,
    close() { if (ch && ch.close) ch.close(); },
  };
}

/** Planner off in this browser (a switch on the plan card): no new plans; the leader still ends what it owns. */
const offIn = storage => readJson(storage, OFF_KEY, false) === true;
const setOff = (storage, on) => writeJson(storage, OFF_KEY, !!on);

/**
 * The override a manual action is (section 6, stored as an `override` fact, read in a later phase): what: the action
 * ('flatten', 'flatten_all', 'cut_half', 'manual_order', 'armed_on'), on: { account, root } it acted on, plans: the open plans
 * (phase armed, working or filled). Returns the facts [{ seq, detail }] for each plan it touches.
 */
function overridesFor(what, on, plans, extra) {
  if (!OVERRIDES.includes(what)) return [];
  return (plans || []).filter(p => p && ['armed', 'working', 'filled'].includes(p.phase) && (what === 'flatten_all' || what === 'armed_on' ? !on || !on.account || p.account === on.account || what === 'flatten_all' : p.account === on.account && p.root === on.root))
    .map(p => ({ seq: p.seq, detail: Object.assign({ what, account: on && on.account ? on.account : p.account, root: on && on.root ? on.root : p.root }, extra || {}) }));
}

return { LOCK, CHANNEL, STORE_KEY, JOURNAL_KEY, QUEUE_KEY, OFF_KEY, ROOTS, SIDES, ENTRY_TYPES, ENTRY_WORDS, ENTRY_SHORT, GRADES, GRADE_DEFAULT,
  EXPIRY_MIN, EXPIRY_MAX, EXPIRY_DEFAULT, CONFIRM_LAG_MS, EVENT_KINDS, END_KINDS, OVERRIDES, WHY_WORDS,
  newUid, entryCid, uidOfCid, cleanDraft, validate, bracketTicks, submitBody, entryFor, bracketFor, throughStop, touches, closesBack,
  createWatch, armClosedWhy, phaseOf, expiresOf, fromDesk, viewOf, reconcile, createJournal, createQueue, deskApi, createLeader, cleanStore, createShared,
  offIn, setOff, overridesFor, onGrid, roundTo };
});
