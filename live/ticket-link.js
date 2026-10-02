/*
 * TicketLink: one order ticket across the workspace's windows (chart 1.12.0, Anthony 2026-10-01). Same PC, same browser,
 * same origin (ChartBridge's page): several windows, one ticket.
 *
 * Who holds the ticket: the window holding the browser's exclusive lock "chartbridge-order-ticket" (Web Locks). Only that
 * window sends ticket orders (Buy, Sell, B/E, chart clicks, drags, cancels): its TradeCore refuses Armed anywhere else.
 * The lock is the tie-break: two windows that add a ticket at the same moment both ask for it with `ifAvailable`, the
 * browser grants it to exactly one (the first asked), and the other is told another window holds it, so it asks "Move
 * the ticket here?". A window that closes or reloads lets go of the lock with it: then no window holds the ticket until
 * one adds it (no window takes it by itself). A browser without Web Locks cannot keep one ticket safely: it gets none.
 *
 * Messages (BroadcastChannel "chartbridge-ticket-v1"; no storage events needed):
 *   hello { wid }                       a window opened: the holder answers with its state
 *   state { wid, state }                the holder's ticket: { root, account, armed, qty } (on every change)
 *   bye { wid }                         the holder let go (closed its ticket, moved it, the window is going)
 *   release { from, id }                "Move the ticket here": the holder lets go (its Armed off), then says
 *   released { wid, id }                ... this, and the asking window takes the lock
 *   fwd { id, from, at, action }        a chart click, drag, cancel or Buy/Sell/B/E key in another window, for the holder
 *   ack { id, to, sent, note }          the holder's answer: what it sent (0 or more order actions) and its note
 *   note { to, text }                   the holder, later: ChartBridge refused an order a forward sent (matched by its cid)
 * A forward the holder gets later than ACT_MS after it was made is not acted on (answered "too late"); the asking window
 * waits ANSWER_MS for an answer, then says nothing was sent. So a late answer cannot have sent anything, except on a
 * PC so busy that the answer itself takes longer than the gap between the two (it is then shown as it comes: onLate).
 * The stamps are the page's clock (live.js's pageClock: performance.now() on a base that follows the PC's clock, the same
 * for every window); a
 * forward stamped more than CLOCK_SLACK_MS in the future is refused too (the clocks cannot be trusted then).
 *
 * No DOM; it also loads in Node for test/ticket-link.test.js (pass `channel`, `locks` and `now`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TicketLink = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const LOCK = 'chartbridge-order-ticket';
const CHANNEL = 'chartbridge-ticket-v1';
const ANSWER_MS = 300;                       // the asking window waits this long for the holder (Anthony: about 300 ms)
const ACT_MS = 200;                          // the holder acts only on a forward younger than this
const MOVE_MS = 1500;                        // a move waits this long for the old holder to let go
const NO_ANSWER = 'The order ticket\'s window did not answer: nothing was sent.';
const TOO_LATE = 'The order ticket\'s window got this too late: nothing was sent.';
const NO_TICKET = 'No window has the order ticket: nothing was sent. Add the ticket (Add panel) to trade.';
const NO_CHANNEL = 'This browser cannot reach the order ticket\'s window (no BroadcastChannel): nothing was sent.';
const BAD_CLOCK = 'The order ticket\'s window could not tell when this was made: nothing was sent.';
const CLOCK_SLACK_MS = 50;
/* the page's clock (live.js, LivePrefs.pageClock, 1.14.0): it follows Windows clock fixes, as the local delay does */
const browserNow = () => (typeof self !== 'undefined' && self.ChartLivePageClock ? self.ChartLivePageClock.now()
  : typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin + performance.now() : Date.now());

function create(o) {
  const wid = o.wid || ('w' + Math.random().toString(36).slice(2, 10));
  const ch = o.channel, locks = o.locks || null;
  const now = typeof o.now === 'function' ? o.now : browserNow;
  const later = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const unlater = o.clearTimeout || (id => clearTimeout(id));
  const on = k => (typeof o[k] === 'function' ? o[k] : () => {});
  let held = false, releaseLock = null, holder = null, mine = null, seq = 0, taking = null, closed = false;
  const pending = new Map();                 // forward id -> { resolve, timer }
  const expired = new Set();                 // forward ids answered "no answer" already
  const post = m => { if (!closed) { try { ch.post(m); } catch (e) { /* the channel closed */ } } };
  const changed = () => on('onState')(info());

  /** { held, holder: { wid, root, account, armed, qty } | null, supported } */
  function info() { return { held, supported: !!locks, holder: held ? Object.assign({ wid }, mine || {}) : holder ? Object.assign({}, holder) : null }; }

  /* Ask the browser for the lock without waiting: 'held' (this window has the ticket now), 'busy' (another window has
     it), 'unsupported' (no Web Locks). */
  function take() {
    if (closed) return Promise.resolve('busy');
    if (!locks) return Promise.resolve('unsupported');
    if (held) return Promise.resolve('held');
    if (taking) return taking;
    taking = new Promise(resolve => {
      let answered = false;
      const done = v => { if (!answered) { answered = true; taking = null; resolve(v); } };
      Promise.resolve(locks.request(LOCK, { ifAvailable: true }, lock => {
        if (!lock || closed) { done('busy'); return null; }
        held = true; holder = null;
        const kept = new Promise(r => { releaseLock = r; });
        changed();
        if (mine) post({ t: 'state', wid, state: mine });
        done('held');
        return kept;
      })).catch(() => done('busy'));
    });
    return taking;
  }
  /* "Move the ticket here?" answered yes: the holder is asked to let go, then this window takes the lock as soon as it is
     free (MOVE_MS at most). 'held', or 'busy' (another window took it first, or the holder did not let go). */
  function move() {
    if (!locks) return Promise.resolve('unsupported');
    if (held) return Promise.resolve('held');
    const id = wid + '-m' + (++seq), until = now() + MOVE_MS;
    post({ t: 'release', from: wid, id });
    return new Promise(resolve => {
      const tryNow = () => take().then(r => {
        if (r === 'held' || now() >= until || closed) { resolve(r); return; }
        later(tryNow, 50);
      });
      later(tryNow, 30);
    });
  }
  /** This window lets go of the ticket (its panel closed, the ticket moved away, the window going). */
  function release() {
    if (!held) return;
    held = false;
    const r = releaseLock; releaseLock = null;
    post({ t: 'bye', wid });
    if (r) r();
    changed();
  }
  /** The holder's ticket as the other windows show it (and use for Close and Flatten all). */
  function publish(state) {
    mine = Object.assign({}, state || {});
    if (held) post({ t: 'state', wid, state: mine });
  }

  /* A click, drag, cancel or key in this window for the ticket in another: { sent, note, answered }. */
  function forward(action) {
    if (held) return Promise.resolve({ answered: false, sent: 0, note: 'This window has the ticket.' });
    if (!holder) return Promise.resolve({ answered: false, sent: 0, note: NO_TICKET });
    const id = wid + '-f' + (++seq);
    post({ t: 'fwd', id, from: wid, to: holder.wid, at: now(), action });
    return new Promise(resolve => {
      const timer = later(() => {
        pending.delete(id); expired.add(id);
        if (expired.size > 64) expired.delete(expired.values().next().value);
        resolve({ answered: false, sent: 0, note: NO_ANSWER });
      }, ANSWER_MS);
      pending.set(id, { resolve, timer });
    });
  }

  function onMessage(m) {
    if (!m || typeof m !== 'object' || closed) return;
    switch (m.t) {
      case 'hello': if (held) post({ t: 'state', wid, state: mine || {} }); break;
      case 'state': if (m.wid !== wid && !held) { holder = Object.assign({}, m.state || {}, { wid: m.wid }); changed(); } break;
      case 'bye': if (holder && holder.wid === m.wid) { holder = null; changed(); } break;
      case 'release':
        if (!held || m.from === wid) break;
        on('onRelease')(m.from);               // the host turns its ticket off (Armed off) before the lock goes
        release();
        post({ t: 'released', wid, id: m.id });
        break;
      case 'fwd': {
        if (!held || m.from === wid || (m.to && m.to !== wid)) break;   // for this window only
        let r;
        const age = now() - m.at;
        if (!(age >= -CLOCK_SLACK_MS)) r = { sent: 0, note: BAD_CLOCK };
        else if (!(age <= ACT_MS)) r = { sent: 0, note: TOO_LATE };
        else { try { r = on('onForward')(m.action, m.from) || { sent: 0, note: '' }; } catch (e) { r = { sent: 0, note: 'The order ticket\'s window failed: ' + (e && e.message) }; } }
        post({ t: 'ack', id: m.id, to: m.from, sent: r.sent | 0, note: String(r.note || '') });
        break;
      }
      case 'note': if (m.to === wid && typeof m.text === 'string' && m.text) on('onNote')(m.text); break;
      case 'ack': {
        if (m.to !== wid) break;
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); unlater(p.timer); p.resolve({ answered: true, sent: m.sent | 0, note: m.note || '' }); }
        else if (expired.has(m.id)) { expired.delete(m.id); if (m.sent) on('onLate')({ sent: m.sent, note: m.note || '' }); }
        break;
      }
    }
  }
  ch.onmessage = onMessage;
  post({ t: 'hello', wid });

  /** The holder that was announced is still there (Web Locks says the lock is held); a crashed window is dropped. */
  function check() {
    if (!locks || held || !holder || typeof locks.query !== 'function') return Promise.resolve();
    return Promise.resolve(locks.query()).then(q => {
      const busy = q && Array.isArray(q.held) && q.held.some(l => l.name === LOCK);
      if (!busy && holder && !held) { holder = null; changed(); }
    }, () => {});
  }
  /** The holder tells the window a forward came from something that happened since (a refusal by ChartBridge). */
  function tell(to, text) { if (held && to && to !== wid) post({ t: 'note', to, text: String(text) }); }
  function close() { release(); closed = true; for (const p of pending.values()) unlater(p.timer); pending.clear(); }

  return { wid, take, move, release, publish, forward, tell, check, close, info, held: () => held, onMessage };
}

/** A channel for create() from the browser's BroadcastChannel, or null when there is none. */
function browserChannel(name) {
  if (typeof BroadcastChannel !== 'function') return null;
  const bc = new BroadcastChannel(name || CHANNEL);
  const ch = { onmessage: null, post: m => bc.postMessage(m), close: () => bc.close() };
  bc.onmessage = e => { if (ch.onmessage) ch.onmessage(e.data); };
  return ch;
}

return { create, browserChannel, browserNow, LOCK, CHANNEL, ANSWER_MS, ACT_MS, MOVE_MS, CLOCK_SLACK_MS, NO_ANSWER, TOO_LATE, NO_TICKET, NO_CHANNEL, BAD_CLOCK };
});
