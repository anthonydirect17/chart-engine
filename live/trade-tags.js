/*
 * Trade tags (chart 1.34.0, Anthony 2026-10-21): a placeable workspace panel (+ Add panel, Trade tags) where Anthony locks in
 * what he entered on with one click per chip. Clicks only: no hotkeys, and a chip pressed by the keyboard (Enter or Space)
 * records nothing. Four rows, one chip each (a click on the set chip clears its row):
 *   Setup    Continuation, Breakout, Reversal, Sweep/retest, Other
 *   Grade    A+, A, B
 *   Context  With-trend, Counter-trend, No context
 *   Trigger  Absorption, Delta flip/divergence, Level hold/reclaim, Other
 * Each click is one record with its phase, worked out from the order ticket's account and instrument (ChartBridge's position
 * and fills): `open` while a position is open, else `pre` for the next trade (before the fill) or `after` for the last trade
 * (after it closed), picked with the Next trade / Last trade switch while flat. Records are append-only: a change is a new
 * record, never an overwrite; the newest record of a row is that row's chip, shown with the phase it was set in. Everything
 * else (levels, delta, time, MFE, MAE, hold, exit, the stop) is measured from the trade on The Desk, never chosen here.
 *
 * Records go to The Desk's POST /api/trade-tags (TheDesk docs/API.md "Trade record"; its address from ChartBridge's /diag, as
 * the Account page's). Until The Desk answers they wait in this browser (live-trade-tags-v1: the records and the pending ids)
 * and are sent again every 10 seconds; The Desk stores a record once by its id, so a resend is safe. A ticket on a group
 * records each click for every member account, each with its own phase. Nothing here sends, changes or cancels an order.
 *
 * Two parts, as workspace.js: TradeTagsCore (pure, loads in Node for test/trade-tags.test.js) and TradeTags.mount (browser).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TradeTagsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* The chips, as The Desk keeps them (thedesk/trade_record.py CHIPS; a test checks they match): [value, label] */
const CHIPS = {
  setup: [['continuation', 'Continuation'], ['breakout', 'Breakout'], ['reversal', 'Reversal'], ['sweep_retest', 'Sweep/retest'], ['other', 'Other']],
  grade: [['A+', 'A+'], ['A', 'A'], ['B', 'B']],
  context: [['with_trend', 'With-trend'], ['counter_trend', 'Counter-trend'], ['no_context', 'No context']],
  trigger: [['absorption', 'Absorption'], ['delta_flip', 'Delta flip/divergence'], ['level_hold', 'Level hold/reclaim'], ['other', 'Other']],
};
const DIMS = ['setup', 'grade', 'context', 'trigger'];
const DIM_LABEL = { setup: 'Setup', grade: 'Grade', context: 'Context', trigger: 'Trigger' };
const ROOTS = ['MNQ', 'NQ', 'MES', 'ES'];
const PHASES = ['pre', 'open', 'after'];
const MATCH_MS = 2000;                      // a record's trade_open_ms and the trade's first fill (The Desk's TRADE_MATCH_MS)
const KEEP = 400;                           // records kept in this browser (the newest)
const STORE_KEY = 'live-trade-tags-v1';
const ID_RX = /^[A-Za-z0-9_-]{8,64}$/;

const labelOf = (dim, value) => { const c = (CHIPS[dim] || []).find(x => x[0] === value); return c ? c[1] : null; };
const validValue = (dim, value) => value === null || !!labelOf(dim, value);

/** A new record id: 20 characters of a-z and 0-9 from `rand` (Math.random by default). */
function newId(rand) {
  const r = typeof rand === 'function' ? rand : Math.random, abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'tt';
  for (let i = 0; i < 18; i++) s += abc[Math.floor(r() * abc.length) % abc.length];
  return s;
}

/** The start of the CME session (18:00 ET) holding `nowMs`, in UTC ms, from the ET wall clock `etSec` of the same moment. */
function sessionStartMs(nowMs, etSec) {
  const tod = ((Math.floor(etSec) % 86400) + 86400) % 86400;
  return nowMs - (((tod - 64800) % 86400 + 86400) % 86400) * 1000;
}

/**
 * The trades on one account and root from ChartBridge's fills (each { account, root, side, qty, u }), with the position now
 * (`qtyNow`, signed). Returns { trades: [{ open, close }] oldest first (open or close null when not known), openTrade (the
 * one still open, or null) }. A position that began before the first known fill has open null: its first fill is not known.
 */
function tradesOf(fills, account, root, qtyNow) {
  const mine = (Array.isArray(fills) ? fills : []).filter(f => f && f.account === account && f.root === root && isFinite(f.u) && +f.u > 0 && +f.qty > 0)
    .slice().sort((a, b) => (+a.u) - (+b.u));
  const net = mine.reduce((a, f) => a + (f.side === 'buy' ? 1 : -1) * (+f.qty), 0);
  let pos = (isFinite(qtyNow) ? +qtyNow : 0) - net;
  const trades = [];
  let cur = pos !== 0 ? { open: null, close: null } : null;
  for (const f of mine) {
    const after = pos + (f.side === 'buy' ? 1 : -1) * (+f.qty);
    if (pos !== 0 && (after === 0 || Math.sign(after) !== Math.sign(pos))) { cur.close = +f.u; trades.push(cur); cur = null; }
    if (after !== 0 && (pos === 0 || Math.sign(after) !== Math.sign(pos))) cur = { open: +f.u, close: null };
    pos = after;
  }
  if (cur) trades.push(cur);
  const openTrade = trades.length && trades[trades.length - 1].close === null && pos !== 0 ? trades[trades.length - 1] : null;
  return { trades, openTrade };
}

/**
 * What a click records now on one account: { phase, tradeOpenMs, trade } where trade is the trade the chips show, or null.
 * target: 'next' or 'last' (the switch while flat). An open trade whose first fill is not known (it began before ChartBridge's
 * list) cannot be named: phase 'open' with tradeOpenMs null, and the click is refused with why.
 */
function targetOf(tr, target) {
  if (tr.openTrade) return { phase: 'open', tradeOpenMs: tr.openTrade.open, trade: tr.openTrade, why: tr.openTrade.open === null ? 'this position began before the fills ChartBridge lists, so its trade cannot be named' : '' };
  const closed = tr.trades.filter(t => t.close !== null);
  const last = closed.length ? closed[closed.length - 1] : null;
  if (target === 'last') {
    if (!last) return { phase: 'after', tradeOpenMs: null, trade: null, why: 'no closed trade on this account and instrument this session' };
    return { phase: 'after', tradeOpenMs: last.open, trade: last, why: last.open === null ? 'the last trade began before the fills ChartBridge lists, so it cannot be named' : '' };
  }
  return { phase: 'pre', tradeOpenMs: null, trade: null, why: '' };
}

/**
 * The records that belong to what the panel shows (one account and root): for a trade, those that name it (trade_open_ms
 * within MATCH_MS of its first fill) and the pre records from the close before it to its first fill; for the next trade, the
 * pre records since the last close (or the session's start). The Desk joins them the same way (thedesk/trade_record.py).
 */
function recordsFor(records, account, root, tr, shown, sessionStart) {
  const list = (records || []).filter(r => r.account === account && r.root === root);
  const closes = tr.trades.filter(t => t.close !== null).map(t => t.close);
  if (!shown || shown.trade === null) {
    const since = Math.max(sessionStart || 0, closes.length ? closes[closes.length - 1] : 0);
    return list.filter(r => r.phase === 'pre' && r.at_ms > since);
  }
  const t = shown.trade;
  if (t.open === null) return [];
  const before = Math.max(sessionStart || 0, ...closes.filter(c => c <= t.open));
  return list.filter(r => (r.trade_open_ms !== null && Math.abs(r.trade_open_ms - t.open) <= MATCH_MS) ||
    (r.phase === 'pre' && r.at_ms > before && r.at_ms <= t.open + MATCH_MS));
}

/** Each row's chip from records (any order): the newest record of the row; a cleared row null. { dim: { value, label, phase, at_ms } | null } */
function chipsOf(records) {
  const out = { setup: null, grade: null, context: null, trigger: null };
  const sorted = (records || []).slice().sort((a, b) => a.at_ms - b.at_ms || (a.seq || 0) - (b.seq || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of sorted) out[r.dim] = r.value === null ? null : { value: r.value, label: labelOf(r.dim, r.value), phase: r.phase, at_ms: r.at_ms };
  return out;
}

/** One record as The Desk takes it, or null when a field is not right. */
function cleanRecord(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.id !== 'string' || !ID_RX.test(r.id)) return null;
  if (typeof r.account !== 'string' || !r.account || r.account.length > 64) return null;
  if (!ROOTS.includes(r.root) || !PHASES.includes(r.phase) || !DIMS.includes(r.dim) || !validValue(r.dim, r.value === undefined ? undefined : r.value)) return null;
  const tom = r.trade_open_ms === null || r.trade_open_ms === undefined ? null : r.trade_open_ms;
  if (tom !== null && !(Number.isInteger(tom) && tom > 0)) return null;
  if ((r.phase === 'pre') !== (tom === null)) return null;
  if (!Number.isInteger(r.at_ms) || r.at_ms <= 0) return null;
  return { id: r.id, account: r.account, root: r.root, phase: r.phase, dim: r.dim, value: r.value, trade_open_ms: tom, at_ms: r.at_ms };
}

/**
 * This browser's copy: { records, pending (ids not yet taken by The Desk), dropped (records lost before The Desk took them, ever) },
 * from its JSON; never throws. Every pending record is kept; of the others (The Desk has them) the newest KEEP (the review of
 * b4bc612: trimming never drops an unsent record). A pending id whose record is not usable is counted in dropped.
 */
function cleanStore(raw) {
  let v = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch (e) { v = null; } }
  const out = { records: [], pending: [], dropped: 0 };
  if (!v || typeof v !== 'object') return out;
  out.dropped = Number.isInteger(v.dropped) && v.dropped > 0 ? v.dropped : 0;
  const seen = new Set(), all = [];
  for (const r of Array.isArray(v.records) ? v.records : []) { const c = cleanRecord(r); if (c && !seen.has(c.id)) { seen.add(c.id); all.push(c); } }
  const want = new Set((Array.isArray(v.pending) ? v.pending : []).filter(id => typeof id === 'string'));
  for (const id of want) if (!seen.has(id)) out.dropped++;
  const sent = all.filter(r => !want.has(r.id)), keepSent = new Set(sent.slice(-KEEP).map(r => r.id));
  out.records = all.filter(r => want.has(r.id) || keepSent.has(r.id));
  out.pending = out.records.filter(r => want.has(r.id)).map(r => r.id);
  return out;
}

/** Records from The Desk's GET /api/trade-tags added to this browser's (by id; the browser's own kept as they are). */
function mergeRecords(mine, desk) {
  const have = new Set(mine.map(r => r.id)), out = mine.slice();
  for (const r of Array.isArray(desk) ? desk : []) { const c = cleanRecord(r); if (c && !have.has(c.id)) { have.add(c.id); out.push(c); } }
  return out.sort((a, b) => a.at_ms - b.at_ms);   // cleanStore trims, never a pending record
}

return { CHIPS, DIMS, DIM_LABEL, ROOTS, PHASES, MATCH_MS, KEEP, STORE_KEY, labelOf, newId, sessionStartMs, tradesOf, targetOf, recordsFor, chipsOf,
  cleanRecord, cleanStore, mergeRecords };
});

/* ======================================================================== the panel (browser only) */
if (typeof window !== 'undefined' && typeof document !== 'undefined') window.TradeTags = (function () {
'use strict';
const C = window.TradeTagsCore;
const SEND_EVERY_MS = 10000;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const etFmt = (() => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return null; } })();
const hms = ms => (etFmt ? etFmt.format(new Date(ms)) : new Date(ms).toTimeString().slice(0, 8));

/* One copy per window for every Trade tags panel in it: the records, the pending queue and the sender. */
let shared = null;
function hub(env) {
  if (shared) return shared;
  const H = shared = { state: C.cleanStore(null), listeners: new Set(), deskState: 'not asked', deskNote: '', timer: 0, sending: false, loaded: new Set() };
  const read = () => { try { H.state = C.cleanStore(env.store.getItem(C.STORE_KEY)); } catch (e) { /* blocked: this window's memory only */ } };
  const write = () => { try { env.store.setItem(C.STORE_KEY, JSON.stringify(H.state)); } catch (e) { /* blocked */ } };
  const changed = () => { for (const f of H.listeners) { try { f(); } catch (e) { /* one panel */ } } };
  read();
  H.add = recs => { read(); for (const r of recs) { H.state.records.push(r); H.state.pending.push(r.id); } H.state = C.cleanStore(H.state); write(); changed(); H.send(); };
  H.send = () => {
    if (H.sending) return;
    read();
    const ids = new Set(H.state.pending);
    const batch = H.state.records.filter(r => ids.has(r.id)).slice(0, 200);
    if (!batch.length) { if (H.deskState !== 'ok' && H.deskState !== 'not asked') { H.deskState = 'ok'; changed(); } return; }
    H.sending = true;
    env.deskBase().then(url => env.fetch(url + '/api/trade-tags', { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: batch }) }))
      .then(r => r.json().then(j => ({ ok: r.ok, status: r.status, j }), () => ({ ok: r.ok, status: r.status, j: null })))
      .then(({ ok, status, j }) => {
        if (!ok) throw new Error('The Desk answered ' + status + (j && typeof j.detail === 'string' ? ': ' + j.detail : ''));
        read();
        const done = new Set(batch.map(r => r.id));
        H.state.pending = H.state.pending.filter(id => !done.has(id));
        const refused = (j && Array.isArray(j.rejected) ? j.rejected : []).concat(j && Array.isArray(j.conflicts) ? j.conflicts : []);
        if (refused.length) { const bad = new Set(refused.map(x => x && x.id)); H.state.records = H.state.records.filter(r => !bad.has(r.id)); H.state.dropped += refused.length; }
        write();
        H.deskState = 'ok'; H.deskNote = refused.length ? 'The Desk refused ' + refused.length + ' record' + (refused.length > 1 ? 's' : '') + ': ' + (refused[0].reason || '') : '';
      }, e => { H.deskState = 'down'; H.deskNote = e && e.message ? e.message : 'not reachable'; })
      .then(() => { H.sending = false; changed(); });
  };
  /* The Desk's records for one account and root since the session's start, once per page load each (another window's clicks) */
  H.load = (account, root, since) => {
    const k = account + '|' + root;
    if (H.loaded.has(k)) return;
    H.loaded.add(k);
    env.deskBase().then(url => env.fetch(url + '/api/trade-tags?' + new URLSearchParams({ account, root, since_ms: String(since) }), { mode: 'cors', credentials: 'omit', cache: 'no-store' }))
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('The Desk answered ' + r.status))))
      .then(j => { read(); H.state = C.cleanStore({ records: C.mergeRecords(H.state.records, j && j.tags), pending: H.state.pending, dropped: H.state.dropped }); write(); changed(); }, () => { H.loaded.delete(k); });
  };
  H.timer = setInterval(H.send, SEND_EVERY_MS);
  if (typeof window.addEventListener === 'function') window.addEventListener('storage', e => { if (e.key && e.key.endsWith(C.STORE_KEY)) { read(); changed(); } });
  setTimeout(H.send, 500);
  return H;
}

/**
 * Mount one panel in `el`. env: { accounts() (the ticket's accounts: one, a group's members, or none), label() (the ticket's
 * account or group as shown), root(), position(account, root) (signed), fills() (ChartBridge's, every account), etNowSec(),
 * deskBase() (a promise of The Desk's address), fetch, store (localStorage) }. Returns { render, destroy }.
 */
function mount(el, env) {
  const H = hub(env);
  let target = 'next';
  el.innerHTML = '<div class="tt" role="group" aria-label="Trade tags">' +
    '<div class="tt-top"><span class="tt-which" data-t="which" role="status"></span>' +
    '<span class="tt-switch" role="group" aria-label="Which trade while flat"><button type="button" class="tt-sw" data-target="next" aria-pressed="true">Next trade</button>' +
    '<button type="button" class="tt-sw" data-target="last" aria-pressed="false">Last trade</button></span></div>' +
    C.DIMS.map(d => '<div class="tt-row" role="group" aria-label="' + C.DIM_LABEL[d] + '"><span class="tt-lbl">' + C.DIM_LABEL[d] + '</span><span class="tt-chips">' +
      C.CHIPS[d].map(([v, l]) => '<button type="button" class="tt-chip" data-dim="' + d + '" data-val="' + esc(v) + '" aria-pressed="false"><span class="tt-name">' + esc(l) + '</span><span class="tt-ph"></span></button>').join('') +
      '</span></div>').join('') +
    '<p class="tt-foot" data-t="foot"></p></div>';
  const q = s => el.querySelector(s);
  const note = (text, warn) => { const f = q('[data-t="foot"]'); f.textContent = text; f.classList.toggle('warn', !!warn); f.title = text; };
  let flash = '', flashUntil = 0;
  const say = (text, warn) => { flash = text; flashUntil = Date.now() + 6000; note(text, warn); };

  function view() {
    const accts = env.accounts(), r = env.root(), now = Date.now(), since = C.sessionStartMs(now, env.etNowSec());
    const fills = env.fills();
    const per = accts.map(a => { const tr = C.tradesOf(fills, a, r, env.position(a, r)); return { a, tr, t: C.targetOf(tr, target) }; });
    for (const p of per) H.load(p.a, r, since);
    return { accts, r, since, per };
  }

  function render() {
    const v = view(), first = v.per[0];
    const open = !!(first && first.tr.openTrade);
    for (const b of el.querySelectorAll('.tt-sw')) { b.setAttribute('aria-pressed', String(b.dataset.target === target)); b.disabled = open || !first; }
    q('.tt-switch').hidden = open;
    const which = q('[data-t="which"]');
    if (!first) { which.textContent = 'No account on the order ticket'; }
    else if (open) {
      const qty = env.position(first.a, v.r), t = first.tr.openTrade;
      const html = 'Open trade · <b class="' + (qty > 0 ? 'tt-long' : 'tt-short') + '">' + (qty > 0 ? 'LONG ' : 'SHORT ') + Math.abs(qty) + '</b> ' + esc(v.r) + (t.open ? ' since ' + hms(t.open) : '');
      if (which.innerHTML !== html) which.innerHTML = html;   // written only when it changes
    } else if (target === 'last') which.textContent = first.t.trade && first.t.trade.close ? 'Last trade · closed ' + hms(first.t.trade.close) + ' · ' + v.r : 'Last trade · none yet';
    else which.textContent = 'Next trade · ' + v.r + ' · flat';
    which.title = v.accts.length ? env.label() + (v.accts.length > 1 ? ' (' + v.accts.join(', ') + ')' : '') : '';
    const recs = first ? C.recordsFor(H.state.records, first.a, v.r, first.tr, first.t, v.since) : [];
    const chips = C.chipsOf(recs);
    for (const b of el.querySelectorAll('.tt-chip')) {
      const c = chips[b.dataset.dim], on = !!c && c.value === b.dataset.val;
      b.setAttribute('aria-pressed', String(on));
      b.querySelector('.tt-ph').textContent = on ? c.phase : '';
      b.title = on ? 'Set ' + (c.phase === 'pre' ? 'before the fill' : c.phase === 'open' ? 'while the trade was open' : 'after it closed') + ', ' + hms(c.at_ms) + '. Click to clear.' : 'Click to tag';
      b.disabled = !first || !!first.t.why;
    }
    if (Date.now() < flashUntil) return;
    const waiting = H.state.pending.length;
    if (!first) note('Pick an account on the order ticket to tag its trades.', true);
    else if (first.t.why) note('Not taggable: ' + first.t.why + '.', true);
    else if (H.deskState === 'down' && waiting) note(waiting + ' waiting for The Desk (' + H.deskNote + '): kept in this browser and sent again.', true);
    else if (H.deskNote) note(H.deskNote, true);
    else if (H.state.dropped) note(H.state.dropped + ' tag record' + (H.state.dropped > 1 ? 's were' : ' was') + ' lost before The Desk took ' + (H.state.dropped > 1 ? 'them' : 'it') + ' (unreadable in this browser, or refused).', true);
    else if (waiting) note('Sending ' + waiting + ' to The Desk...', false);
    else note(v.accts.length > 1 ? 'Each click is recorded for ' + v.accts.length + ' accounts of ' + env.label() + '.' : (recs.length ? 'Saved to The Desk. Levels, delta, MFE, MAE and the stop are measured from the trade.' : 'Click what you entered on. Levels, delta, MFE, MAE and the stop are measured from the trade.'), false);
  }

  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !el.contains(b)) return;
    b.blur();                                                 // the trading hotkeys keep working at once
    if (e.detail === 0) { say('Trade tags work by click only, not by keyboard.', true); return; }
    if (b.dataset.target) { target = b.dataset.target; flashUntil = 0; render(); return; }
    if (!b.dataset.dim) return;
    const v = view();
    if (!v.per.length) { say('Pick an account on the order ticket first.', true); return; }
    const dim = b.dataset.dim, val = b.dataset.val, now = Date.now();
    const firstRecs = C.recordsFor(H.state.records, v.per[0].a, v.r, v.per[0].tr, v.per[0].t, v.since);
    const cur = C.chipsOf(firstRecs)[dim];
    const value = cur && cur.value === val ? null : val;     // a click on the set chip clears its row
    const recs = [], skipped = [];
    for (const p of v.per) {
      if (p.t.why) { skipped.push(p.a); continue; }
      recs.push({ id: C.newId(), account: p.a, root: v.r, phase: p.t.phase, dim, value, trade_open_ms: p.t.phase === 'pre' ? null : p.t.tradeOpenMs, at_ms: now });
    }
    if (!recs.length) { say('Not recorded: ' + (v.per[0].t.why || 'no account') + '.', true); return; }
    H.add(recs);
    say((value === null ? C.DIM_LABEL[dim] + ' cleared' : C.labelOf(dim, value)) + ' (' + recs[0].phase + ')' + (recs.length > 1 ? ' on ' + recs.length + ' accounts' : '') + (skipped.length ? '; not on ' + skipped.join(', ') : '') + '.', !!skipped.length);
  });
  const onChange = () => render();
  H.listeners.add(onChange);
  render();
  return {
    render,
    destroy: () => { H.listeners.delete(onChange); el.innerHTML = ''; },
    pending: () => H.state.pending.length,
  };
}

return { mount };
})();
