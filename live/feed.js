/*
 * ChartFeed: one ChartBridge connection per instrument per window (the workspace, live/index.html). Every panel that
 * shows an instrument (charts of any timeframe, Time and Sales) gets that instrument's trades from the one WebSocket,
 * so a trade arrives once per window and is parsed once, however many panels show it (E1 opened a socket per panel:
 * MNQ came in three times).
 *
 *   const hub = ChartFeed.create({ wsUrl })        wsUrl: a URL, or a function returning one or a promise of one
 *   const sock = hub.open(root)                    a stand-in for a WebSocket to ChartBridge, on that instrument's line
 *
 * The stand-in behaves like the WebSocket a chart opens today (readyState, onopen, onmessage, onclose, send, close), so
 * ChartLive.mount({ feed: hub }) and the tape use it in place of their own socket. Its onmessage gets { message } (the
 * object, parsed once) rather than { data }. It sends nothing but subscribe (and ping): read only, like every mounted
 * chart. A panel's subscribe goes to its line:
 *   - the line has a load (a subscribe to ChartBridge) that holds what the panel asks for (days, tick hours or the
 *     served window, the session table): the panel gets that load's messages so far (history, ticks, profile, ready),
 *     then the live trades since ready from the line's own record, then the live ones as they come. Its view is built
 *     exactly as if it had been there from the start, and no other panel is touched.
 *   - else one subscribe goes to ChartBridge asking for the most any panel on the line needs; the panels already on it
 *     get the line's "hello" again, so each loads afresh from the new load (as on a reconnect).
 * Subscribes that come in the same task (a layout opening, every panel answering "hello") go out as one.
 * A panel that asks for another instrument moves to that line; a line with no panel left closes its socket. When a
 * line's socket closes, every stand-in on it closes; each panel reconnects as it always has, and the first one back
 * opens the line again.
 *
 * 1.14.0: a load keeps each trade's Time and Sales category (q, ChartBridge 0.3.8) with it, so a tape that joins later or
 * a replay colours its trades as one there from the start; a "settlement" (0.3.7) is kept in the line's hello.
 * Seams for the next build (E2b): order messages (trading, orders, order, position, reject) are passed to every panel
 * of the line as ChartBridge sends them, and a stand-in drops anything a panel sends but subscribe, ping and (1.15.0) htf.
 *
 * No DOM; it also loads in Node for test/feed.test.js (pass `WebSocket` and, if wanted, `now` in the options).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChartFeed = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const CONNECTING = 0, OPEN = 1, CLOSED = 3;
const LIVE_MAX = 1000000;          // live trades a load keeps for a panel that joins later (about 26 MB); past it, a new load
const SLICE = 5000;                // live trades replayed per task
const BACKFILL_MAX = 8000000;      // backfill trades a load keeps for a panel that joins later (the chart's own hard cap)
const LOAD_TYPES = ['history', 'ticks', 'ready', 'profile'];
const NO_TICKS = { tickHours: 0, window: false, tickFrom: null };   // what a panel that asked for no ticks is told (and the load's days, 1.15.0)
const SENDS = ['subscribe', 'ping', 'htf'];         // 1.15.0: htf (ChartBridge 0.3.7) asks for 4h, 1D or 1W bars: read only

/** What a subscribe asks for, with ChartBridge's defaults for anything left out (days 5, tickHours 8). */
function needOf(m) {
  const days = Number.isFinite(+m.days) && m.days !== null && m.days !== '' ? Math.max(0, +m.days) : 5;
  const th = m.tickHours === undefined || m.tickHours === null ? 8 : +m.tickHours;
  return { days, tickHours: Number.isFinite(th) && th > 0 ? th : 0, liveFirst: m.liveFirst === true, profile: m.profile === true };
}
/** The least one load that holds both. */
function merge(a, b) {
  if (!a) return Object.assign({}, b);
  return { days: Math.max(a.days, b.days), tickHours: Math.max(a.tickHours, b.tickHours), liveFirst: a.liveFirst || b.liveFirst, profile: a.profile || b.profile };
}
/**
 * Does a load asked with `have` hold what `want` asks? With ChartBridge 0.3.5 (hello's features list "liveFirst") every
 * subscribe with tickHours above 0 gets the served window whatever the number says, so any window load holds any tick
 * view; before it the hours are compared.
 */
function covers(have, want, windowed) {
  if (have.days < want.days) return false;
  if (want.profile && !have.profile) return false;
  if (want.tickHours <= 0) return true;
  return windowed ? have.tickHours > 0 : have.tickHours >= want.tickHours;
}

/* Trades in columns (no object or array per trade): a load's tick backfill, and its live trades since ready. */
class LiveLog {
  constructor(max) { this.max = max || LIVE_MAX; this.n = 0; this.cap = 0; this.t = this.p = this.v = null; this.s = this.sm = this.q = null; this.dropped = false; }
  /** One trade as ChartBridge sends it in a "ticks" list: [t, p, v], [t, p, v, s, sm] or (0.3.8) [t, p, v, s, sm, q]. */
  pushRow(x) { this.push({ t: x[0], p: x[1], v: x[2], s: x[3], sm: x[4], q: x[5] }); }
  /* the row as ChartBridge sent it: q (the Time and Sales category, 0.3.8) in the 6th place when known, with null sides
     when it had none (as ChartBridge 0.3.8 sends a served-window trade) */
  row(i) {
    const q = this.q[i];
    if (this.s[i] === -128) return q === -128 ? [this.t[i], this.p[i], this.v[i]] : [this.t[i], this.p[i], this.v[i], null, null, q];
    const r = [this.t[i], this.p[i], this.v[i], this.s[i], this.sm[i] === -128 ? 0 : this.sm[i]];
    if (q !== -128) r.push(q);
    return r;
  }
  push(m) {
    if (this.dropped) return;
    if (this.n >= this.max) { this.dropped = true; this.t = this.p = this.v = this.s = this.sm = this.q = null; return; }
    if (this.n === this.cap) {
      const cap = Math.min(this.max, Math.max(4096, this.cap * 2));
      const grow = (a, T) => { const b = new T(cap); if (a) b.set(a); return b; };
      this.t = grow(this.t, Float64Array); this.p = grow(this.p, Float64Array); this.v = grow(this.v, Float64Array);
      this.s = grow(this.s, Int8Array); this.sm = grow(this.sm, Int8Array); this.q = grow(this.q, Int8Array);
      this.cap = cap;
    }
    const i = this.n++;
    this.t[i] = +m.t; this.p[i] = +m.p; this.v[i] = +m.v || 0;
    // -128: no side given (ChartBridge before 0.3.4); the trade is replayed without one
    this.s[i] = typeof m.s === 'number' ? m.s : -128; this.sm[i] = typeof m.sm === 'number' ? m.sm : -128;
    // 1.14.0: the Time and Sales category (ChartBridge 0.3.8, -2 to 2), so a tape that joins later or a replay keeps it
    this.q[i] = typeof m.q === 'number' && m.q >= -2 && m.q <= 2 ? m.q : -128;
  }
  tick(root, i) {
    const m = { type: 'tick', root, t: this.t[i], p: this.p[i], v: this.v[i] };
    if (this.s[i] !== -128) m.s = this.s[i];
    if (this.sm[i] !== -128) m.sm = this.sm[i];
    if (this.q[i] !== -128) m.q = this.q[i];
    return m;                                          // no u or rx: a replayed trade is never counted as a delay
  }
}

function create(options) {
  const opt = options || {};
  const WS = opt.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  const now = typeof opt.now === 'function' ? opt.now : () => Date.now();
  const later = typeof opt.later === 'function' ? opt.later : (fn => setTimeout(fn, 0));
  const lines = new Map();                            // root -> line
  let subSeq = 0, closedHub = false;
  const counts = { opened: 0, subscribes: 0 };       // real sockets opened, subscribes sent (for tests and perf)

  function lineOf(root) {
    let L = lines.get(root);
    if (!L) {
      L = { root, ws: null, state: 'idle', hello: null, windowed: false, useSub: false, clients: new Set(), pending: new Set(),
        load: null, fills: new Map(), flushQueued: false, seq: 0 };
      lines.set(root, L);
    }
    return L;
  }

  /* ---------------- the real socket of a line */
  function connect(L) {
    if (L.state !== 'idle' || closedHub) return;
    L.state = 'connecting';
    const seq = ++L.seq;
    let url;
    try { url = typeof opt.wsUrl === 'function' ? opt.wsUrl() : opt.wsUrl; } catch (e) { lost(L, seq); return; }
    Promise.resolve(url).then(u => { if (seq === L.seq && L.state === 'connecting') openReal(L, u, seq); }, () => lost(L, seq));
  }
  function openReal(L, url, seq) {
    let ws;
    try { ws = new WS(url); } catch (e) { lost(L, seq); return; }
    L.ws = ws; counts.opened++;
    ws.onopen = () => {
      if (L.ws !== ws) return;
      L.state = 'open';
      for (const V of [...L.clients]) if (V.readyState === CONNECTING) V._open();
    };
    ws.onmessage = ev => {
      if (L.ws !== ws) return;
      let m;
      try { m = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
      if (m && typeof m === 'object') onMessage(L, m);
    };
    ws.onclose = () => { if (L.ws === ws) lost(L, seq); };
    ws.onerror = () => { /* onclose follows */ };
  }
  /* The line's socket closed (or never opened): every stand-in on it closes, and the line starts over when one comes back. */
  function lost(L, seq) {
    if (seq !== L.seq) return;
    const ws = L.ws;
    reset(L);
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch (e) { /* closed */ } }
    for (const V of [...L.clients]) V._closed();
  }
  function reset(L) {
    L.seq++; L.ws = null; L.state = 'idle'; L.hello = null; L.load = null; L.fills.clear(); L.pending.clear();
  }
  /* No panel left on a line: its socket closes. */
  function release(L) {
    if (L.clients.size) return;
    const ws = L.ws;
    reset(L);
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch (e) { /* closed */ } }
    lines.delete(L.root);
  }

  /* ---------------- ChartBridge to the panels */
  function onMessage(L, m) {
    const t = m.type;
    if (t === 'tick') {
      const load = L.load;
      if (!load) return;
      if (m.root === L.root && load.ready) load.live.push(m);
      for (const V of L.clients) if (V.load === load && !V.replaying) V._deliver(m);
      return;
    }
    if (LOAD_TYPES.includes(t)) {
      const load = L.load;
      if (!load || m.root !== L.root) return;
      const hasSub = m.sub !== undefined && m.sub !== null;
      if (hasSub && load.sub !== null && +m.sub !== load.sub) return;            // an older load's message, still on its way
      if (t === 'profile' && !hasSub && load.ready) {                            // the session table made whole, after ready
        load.late.push({ at: load.live.n, m });
        for (const V of L.clients) if (V.load === load && !V.replaying) V._deliver(m);
        return;
      }
      if (t === 'ready') { load.ready = true; load.readyAt = now(); }
      if (t === 'ticks') {
        // kept in columns, not as ChartBridge's arrays (a day of trades as arrays is some 100 MB), and passed only to the
        // panels that asked for ticks: a minute or hour chart, and the tape, load exactly as they would on their own
        const from = load.bf.n, list = Array.isArray(m.ticks) ? m.ticks : [];
        for (let i = 0; i < list.length; i++) load.bf.pushRow(list[i]);
        load.msgs.push({ type: 'ticks', root: m.root, done: m.done, from, to: load.bf.n });
        for (const V of L.clients) if (V.load === load && wantsTicks(V)) V._deliver(copyFor(V, load, m));
        return;
      }
      load.msgs.push(m);
      for (const V of L.clients) if (V.load === load) V._deliver(copyFor(V, load, m));
      return;
    }
    if (t === 'hello') {
      L.hello = m;
      const f = Array.isArray(m.features) ? m.features : [];
      L.windowed = f.includes('liveFirst');
      L.useSub = f.includes('liveFirst') || f.includes('profile');
      for (const V of [...L.clients]) if (!V.helloed && V.readyState === OPEN) { V.helloed = true; V._deliver(m); }
      queueFlush(L);
      return;
    }
    // 0.3.7: the prior settlement changed: a panel that joins later gets it in the line's hello
    if (t === 'settlement' && L.hello && Array.isArray(L.hello.instruments)) {
      L.hello = Object.assign({}, L.hello, { instruments: L.hello.instruments.map(i => i && i.root === m.root ? Object.assign({}, i, { settlement: m.p === undefined ? null : m.p, settlementDate: m.date }) : i) });
    }
    if (t === 'execs') { L.fills.clear(); for (const f of m.list || []) if (f && f.id) L.fills.set(f.account + '|' + f.id, f); }
    else if (t === 'exec' && m.id) L.fills.set(m.account + '|' + m.id, m);
    for (const V of L.clients) if (V.helloed) V._deliver(m);                   // execs, exec, status, and anything else
  }
  const wantsTicks = V => !!V.need && V.need.tickHours > 0;
  /* A load message as one panel gets it: its own subscribe id, and what the load holds for it (ChartLive.mount adopts it). */
  function copyFor(V, load, m) {
    const c = Object.assign({}, m, { sub: V.sub, load: wantsTicks(V) ? load.info : Object.assign({ days: load.info.days }, NO_TICKS) });
    if (m.type === 'ready') c.readyAt = load.readyAt;
    return c;
  }
  /* A recorded "ticks" message, made again from the columns for a panel that joins later. */
  function ticksFor(V, load, rec) {
    if (load.bf.dropped) return null;
    const list = new Array(rec.to - rec.from);
    for (let i = rec.from; i < rec.to; i++) list[i - rec.from] = load.bf.row(i);
    return copyFor(V, load, { type: 'ticks', root: rec.root, ticks: list, done: rec.done });
  }

  /* ---------------- panels' subscribes */
  function queueFlush(L) {
    if (L.flushQueued) return;
    L.flushQueued = true;
    Promise.resolve().then(() => { L.flushQueued = false; flush(L); });
  }
  function flush(L) {
    if (!L.hello || L.state !== 'open' || !L.pending.size) return;
    const asking = [...L.pending].filter(V => L.clients.has(V) && V.need);
    L.pending.clear();
    if (!asking.length) return;
    let need = null;
    for (const V of asking) need = merge(need, V.need);
    const cur = L.load;
    if (cur && !cur.live.dropped && !cur.bf.dropped && covers(cur.need, need, L.windowed)) { for (const V of asking) attach(V, cur); return; }
    // a new load: what the panels on the old one had, and what is asked now
    if (cur) for (const V of L.clients) if (V.load === cur && V.need) need = merge(need, V.need);
    const sub = L.useSub ? ++subSeq : null, at = now();
    const load = { sub, need, msgs: [], ready: false, readyAt: 0, live: new LiveLog(), bf: new LiveLog(BACKFILL_MAX), late: [],
      info: { tickHours: need.tickHours, window: L.windowed && need.tickHours > 0, tickFrom: need.tickHours > 0 ? at - need.tickHours * 3600000 : null, days: need.days } };
    L.load = load;
    const msg = { type: 'subscribe', root: L.root, days: need.days, tickHours: need.tickHours };
    if (sub !== null) msg.sub = sub;
    if (L.windowed && need.tickHours > 0) msg.liveFirst = true;
    if (need.profile) msg.profile = true;
    counts.subscribes++;
    try { L.ws.send(JSON.stringify(msg)); } catch (e) { /* the close follows */ }
    for (const V of asking) attach(V, load);
    // the panels on the old load start over from this one, as after a reconnect: "hello" again, and they subscribe
    if (cur) for (const V of [...L.clients]) if (V.load === cur) { V.load = null; V.replaying = false; V._deliver(L.hello); }
  }
  /* A panel joins a load: what it has sent so far, then (once ready) the live trades since, then live. */
  function attach(V, load) {
    V.load = load; V.replaying = false;
    const msgs = load.msgs.slice();                    // what has come so far; later ones are passed on as they come
    for (const m of msgs) {
      if (V.load !== load) return;
      if (m.type !== 'ticks') V._deliver(copyFor(V, load, m));
      else if (wantsTicks(V)) { const c = ticksFor(V, load, m); if (c) V._deliver(c); }
    }
    if (!load.ready || (!load.live.n && !load.late.length)) return;
    V.replaying = true;
    let i = 0, k = 0;
    const L = V.line;
    const step = () => {
      if (V.load !== load || !V.replaying) return;
      if (load.live.dropped) { V.load = null; V.replaying = false; if (L.hello) V._deliver(L.hello); return; }   // past the record's cap: load afresh
      const end = Math.min(load.live.n, i + SLICE);
      for (; i < end; i++) {
        while (k < load.late.length && load.late[k].at <= i) V._deliver(load.late[k++].m);
        V._deliver(load.live.tick(L.root, i));
        if (V.load !== load) return;
      }
      if (i < load.live.n && !load.live.dropped) { later(step); return; }
      while (k < load.late.length) V._deliver(load.late[k++].m);
      V.replaying = false;
    };
    step();
  }

  /* ---------------- the stand-in a panel holds */
  function open(root) {
    if (closedHub) throw new Error('ChartFeed: closed');
    const V = {
      readyState: CONNECTING, onopen: null, onmessage: null, onclose: null, onerror: null,
      line: null, helloed: false, need: null, sub: undefined, load: null, replaying: false,
      send(data) {
        if (V.readyState !== OPEN) return;
        let m = data;
        if (typeof data === 'string') { try { m = JSON.parse(data); } catch (e) { return; } }
        if (!m || !SENDS.includes(m.type)) return;                              // read only: nothing else leaves a panel
        if (m.type === 'ping' || m.type === 'htf') { const L = V.line; if (L && L.ws && L.state === 'open') { try { L.ws.send(JSON.stringify(m)); } catch (e) { /* closing */ } } return; }
        subscribe(V, m);
      },
      close() {
        if (V.readyState === CLOSED) return;
        V.readyState = CLOSED; V.load = null; V.replaying = false;
        const L = V.line; V.line = null;
        if (L) { L.clients.delete(V); L.pending.delete(V); release(L); }
        const cb = V.onclose;
        if (cb) later(() => { try { cb({ code: 1000 }); } catch (e) { setTimeout(() => { throw e; }); } });
      },
      _open() {
        if (V.readyState !== CONNECTING) return;
        V.readyState = OPEN;
        call(V, 'onopen', {});
      },
      _closed() {
        if (V.readyState === CLOSED) return;
        V.readyState = CLOSED; V.load = null; V.replaying = false;
        const L = V.line; V.line = null;
        if (L) { L.clients.delete(V); L.pending.delete(V); }
        call(V, 'onclose', { code: 1006 });
      },
      _deliver(m) { if (V.readyState === OPEN) call(V, 'onmessage', { message: m }); },
    };
    join(V, lineOf(root));
    return V;
  }
  function call(V, k, ev) {
    const cb = V[k];
    if (typeof cb !== 'function') return;
    try { cb.call(V, ev); } catch (e) { setTimeout(() => { throw e; }); }       // one panel's error never stops the others
  }
  function join(V, L) {
    V.line = L; L.clients.add(V);
    if (L.state === 'idle') { connect(L); return; }
    if (L.state === 'open' && V.readyState === CONNECTING) {
      // a line already up: the panel opens on the next turn with the line's hello (and the day's fills), as a new socket would
      later(() => {
        if (V.line !== L || V.readyState !== CONNECTING || L.state !== 'open') return;
        V._open();
        if (L.hello && !V.helloed) {
          V.helloed = true; V._deliver(L.hello);
          if (L.fills.size) V._deliver({ type: 'execs', list: [...L.fills.values()] });
        }
      });
    }
  }
  function subscribe(V, m) {
    const root = typeof m.root === 'string' ? m.root : '';
    if (!root) return;
    let L = V.line;
    if (L.root !== root) {                            // another instrument: this panel moves to that line
      L.clients.delete(V); L.pending.delete(V); release(L);
      L = lineOf(root);
      V.line = L; L.clients.add(V);
      if (L.state === 'idle') connect(L);
    }
    V.need = needOf(m); V.sub = m.sub; V.load = null; V.replaying = false;
    L.pending.add(V);
    queueFlush(L);
  }

  return {
    open,
    /** For tests and the perf script: the lines (instrument, panels, socket state, load) and the counts. */
    stats() {
      return { sockets: [...lines.values()].filter(L => L.ws).length, opened: counts.opened, subscribes: counts.subscribes,
        lines: [...lines.values()].map(L => ({ root: L.root, clients: L.clients.size, state: L.state, load: L.load ? Object.assign({ ready: L.load.ready, live: L.load.live.n }, L.load.need) : null })) };
    },
    /** Close every line (the page going away). */
    close() { closedHub = true; for (const L of [...lines.values()]) { for (const V of [...L.clients]) V.close(); release(L); } },
  };
}

return { create, needOf, merge, covers, LIVE_MAX, SLICE };
});
