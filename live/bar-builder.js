/*
 * Bar builders for the live chart: time bars (seconds, minutes, hours) and range bars, from ticks.
 * Each keeps a session VWAP. Works in the browser (window.BarBuilder) and in Node (tests).
 * Times follow chart-engine: exchange wall-clock seconds stored as if UTC.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BarBuilder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const DAY = 86400;
const TIME_STEP = 0.00001;                               // 10 microseconds, in bar-time seconds
const tradeDay = (t, s) => s ? Math.floor((t + DAY - s) / DAY) : Math.floor(t / DAY);

/**
 * mode 'time': seconds per bar.
 * mode 'range': bars of rangeTicks * tick, in one of two ways (rangeMode):
 *   'nt' (default): NinjaTrader 8's Range bar type (its @RangeBarsType.cs, see docs/RANGE_BARS.md). A bar closes
 *     once a trade goes past its low + range (or its high - range). The finished bar is set to exactly the range
 *     and closes on its high (or low), even when that price did not trade. The next bar opens one tick further
 *     on. When the trade is more than a range away, the gap is filled with phantom bars of exactly the range and
 *     no volume; the trade's volume goes to the last bar, the one holding its price.
 *   'traded': traded prices only. The trade that breaks out opens the next bar at its own price, so a jump
 *     over the boundary leaves the finished bar short of the full range. Nothing is invented.
 * Both start a new bar at the first trade of each session (NinjaTrader's Break at EOD).
 * vwapSeed (1.8.0, served window): a build from the last hours of trades, not from the session's first. Left out, the
 * VWAP is worked out from the trades fed, as always. { day, pv, vol }: the session VWAP of trade day `day` starts from
 * the price times volume and the volume of that session's trades before the first one fed (ChartBridge's session
 * table, less the trades the page holds); bars of earlier days get none (vw null, which the chart does not draw).
 * null: no VWAP at all (the session's trades before the window are not known yet).
 */
class BarBuilder {
  constructor(opts) {
    const o = opts || {};
    this.mode = o.mode === 'range' ? 'range' : 'time';
    this.seconds = o.seconds || 60;
    this.tick = o.tick || 0.25;
    this.rangeTicks = Math.max(1, o.rangeTicks || 20);
    this.rangeMode = o.rangeMode === 'traded' ? 'traded' : 'nt';
    this.sessionStart = o.sessionStart === undefined ? 18 * 3600 : o.sessionStart;
    this.vwapSeed = o.vwapSeed;
    this.reset();
  }
  reset() { this.bars = []; this.day = null; this.pv = 0; this.vol = 0; this.vwOff = false; this.lastT = -Infinity; this._dayBar = null; this._barDay = null; this._fast = null; }
  get last() { return this.bars[this.bars.length - 1]; }

  _vwap(t, price, v) {
    const d = tradeDay(t, this.sessionStart);
    if (d !== this.day) {
      const s = this.vwapSeed;
      this.day = d; this.pv = 0; this.vol = 0; this.vwOff = s === null || (s !== undefined && d < s.day);
      if (s && d === s.day) { this.pv = s.pv; this.vol = s.vol; }
    }
    this.pv += price * v; this.vol += v;
    return this.vwOff ? null : this.vol > 0 ? this.pv / this.vol : price;
  }

  /** Seed with finished bars (e.g. 1-minute history). VWAP continues from their typical prices. */
  seed(bars) {
    this.reset();
    for (const b of bars) {
      const tp = (b.h + b.l + b.c) / 3;
      const vw = this._vwap(b.t, tp, b.v || 0);
      this.bars.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, vw });
    }
    return this.bars;
  }

  /**
   * Add one trade. Returns the bar it landed in, whether that bar is new, and `changed`: every bar this trade
   * touched, oldest first (a finished range bar set to its full range, phantom bars, then the trade's bar).
   */
  add(t, price, v) {
    const r = this._step(t, price, v);
    if (typeof r === 'object') return r;
    const bar = this.last;
    return { bar, isNew: r === 1, changed: [bar] };
  }

  /** The same as add, returning nothing: for building from many ticks at once (TickStore.feed), with no garbage. */
  addQuiet(t, price, v) { this._step(t, price, v); }

  /* One trade. Returns 0 when it landed in the newest bar, 1 when it opened one new bar (the newest), or add()'s
     result when a NinjaTrader-style range bar finished (that is rare, so only then is anything allocated). */
  _step(t, price, v) {
    v = v || 0;
    // Fast path (NinjaTrader-style range bars, most trades): the trade is inside the newest bar's range and well
    // inside that bar's session, so it only moves the bar. Same arithmetic as the full path below.
    const f = this._fast;
    if (f !== null && t > f.from && t < f.to) {
      const P = Math.round(price / this.tick);
      if (P <= f.lo + this.rangeTicks && P >= f.hi - this.rangeTicks) {
        this.pv += price * v; this.vol += v;
        const vw = this.vwOff ? null : this.vol > 0 ? this.pv / this.vol : price, bar = f.bar;
        if (t > this.lastT) this.lastT = t;
        if (price > bar.h) { bar.h = price; f.hi = P; }
        if (price < bar.l) { bar.l = price; f.lo = P; }
        bar.c = price; bar.v += v; bar.vw = vw;
        return 0;
      }
    }
    this._fast = null;
    const r = this._slow(t, price, v);
    const bar = this.bars[this.bars.length - 1];
    if (this.mode === 'range' && this.rangeMode === 'nt' && bar && tradeDay(bar.t, this.sessionStart) === this.day) {
      // the fast path holds while trades stay in this bar's session (the builder's day too), 1 ms clear of its edges
      const from = sessionStartOf(bar.t, this.sessionStart);
      this._fast = { bar, lo: Math.round(bar.l / this.tick), hi: Math.round(bar.h / this.tick), from: from + 0.001, to: from + DAY - 0.001 };
    }
    return r;
  }

  _slow(t, price, v) {
    const vw = this._vwap(t, price, v);
    const prevT = this.lastT;
    if (t > prevT) this.lastT = t;
    let bar = this.bars[this.bars.length - 1], isNew = 0;
    if (this.mode === 'time') {
      const bt = Math.floor(t / this.seconds) * this.seconds;
      if (!bar || bt > bar.t) {
        bar = { t: bt, o: price, h: price, l: price, c: price, v: 0, vw };
        this.bars.push(bar); isNew = 1;
      }
      // a late tick for an older bucket folds into the newest bar rather than rewriting history
    } else {
      if (bar && bar !== this._dayBar) { this._dayBar = bar; this._barDay = tradeDay(bar.t, this.sessionStart); }
      const newSession = !bar || this.day !== this._barDay;       // this.day: the trade's day, set by _vwap
      if (!newSession && this.rangeMode === 'nt') {
        const r = this._ntRange(t, price, v, vw, bar, prevT);
        if (r) return r;
      } else {
        const span = this.rangeTicks * this.tick + 1e-9;
        if (newSession || price > bar.l + span || price < bar.h - span) { bar = this._open(this._times(t, 1, prevT)(0), price, vw); isNew = 1; }
      }
    }
    if (price > bar.h) bar.h = price;
    if (price < bar.l) bar.l = price;
    bar.c = price; bar.v += v; bar.vw = vw;
    return isNew;
  }

  _open(bt, price, vw) {
    const bar = { t: bt, o: price, h: price, l: price, c: price, v: 0, vw };
    this.bars.push(bar);
    return bar;
  }

  /*
   * Times for n new range bars opened by one trade at t, oldest first; strictly after the last bar and the
   * previous trade. The trade's own bar (the last) keeps the trade's time, so a fill at that time lands on the bar
   * that holds its price. Phantom bars before it sit in the gap since the previous trade, at most 1 ms apart.
   * Only when there is no room (trades in the same instant) do the bars step on by 10 microseconds each, so
   * times can run ahead of the trades by at most 10 microseconds per bar.
   */
  _times(t, n, prevT) {
    const prev = this.last;
    if (!prev) return () => t;
    const lo = Math.max(prev.t, prevT);
    if (t - lo >= n * TIME_STEP) { const d = Math.min(0.001, (t - lo) / n); return i => (i === n - 1 ? t : t - (n - 1 - i) * d); }
    return i => lo + (i + 1) * TIME_STEP;
  }

  /* NinjaTrader's Range OnDataPoint, in whole ticks so prices never drift. Returns null when the trade stays in
     the forming bar (the caller then updates it as usual). */
  _ntRange(t, price, v, vw, bar, prevT) {
    const tk = this.tick, R = this.rangeTicks;
    const P = Math.round(price / tk), lo = Math.round(bar.l / tk), hi = Math.round(bar.h / tk);
    let up;
    if (P > lo + R) up = true;
    else if (P < hi - R) up = false;
    else return null;                                    // most trades: checked before anything is allocated
    const px = n => +(n * tk).toFixed(10), cl = Math.round(bar.c / tk);
    const changed = [];
    let edge = up ? lo + R : hi - R;                     // the finished bar ends exactly one range from its far side
    if (up ? edge > cl : edge < cl) {
      if (up) bar.h = px(edge); else bar.l = px(edge);
      bar.c = px(edge);                                  // every bar closes on its high or its low; no volume added
      changed.push(bar);
    }
    const made = [];                                     // [open, close] in ticks for each new bar
    let open = up ? edge + 1 : edge - 1;
    while (up ? P > edge : P < edge) {
      edge = up ? Math.min(P, open + R) : Math.max(P, open - R);
      made.push([open, edge]);
      open = up ? edge + 1 : edge - 1;
    }
    const at = this._times(t, made.length, prevT);
    let last = null;
    made.forEach(([o, c], i) => {
      last = this._open(at(i), px(o), vw);
      if (up) last.h = px(c); else last.l = px(c);
      last.c = px(c);
      if (c === P) last.v = v;                           // phantom bars carry no volume; the trade's bar does
      changed.push(last);
    });
    return { bar: last, isNew: true, changed };
  }

  /** Range bars: ticks left before the forming bar completes, up and down. */
  rangeLeft() {
    const b = this.last; if (!b || this.mode !== 'range') return null;
    const span = this.rangeTicks * this.tick;
    return { up: Math.max(0, Math.round((b.l + span - b.c) / this.tick)), down: Math.max(0, Math.round((b.c - (b.h - span)) / this.tick)) };
  }
}

/*
 * TickStore: the page's trades [t, p, v] kept in columns of 64-bit floats, in blocks of 65,536, instead of one small
 * array per trade. The range view holds up to 33 hours of ticks (about 2 million on a busy NQ day): as arrays that
 * was about 2 million objects (some 150 MB of JavaScript heap) for the garbage collector to walk and move, and the
 * page's frames waited on it. Blocks live outside that heap, are never copied as the store grows, and the oldest
 * are dropped whole when the page trims its history.
 */
const BLOCK = 65536, SHIFT = 16, MASK = BLOCK - 1;
class TickStore {
  constructor() { this.clear(); }
  clear() { this.blocks = []; this.start = 0; this.length = 0; }
  /** Add one trade at the end. */
  push(t, p, v) {
    const j = this.start + this.length;
    let b = this.blocks[j >>> SHIFT];
    if (!b) { b = new Float64Array(BLOCK * 3); this.blocks.push(b); }
    const k = (j & MASK) * 3;
    b[k] = t; b[k + 1] = p; b[k + 2] = v || 0;
    this.length++;
  }
  /** Add trades as ChartBridge sends them, [[t, p, v], ...]. */
  pushAll(list) { for (let i = 0; i < list.length; i++) { const x = list[i]; this.push(x[0], x[1], x[2]); } }
  _get(i, f) { const j = i + this.start; return this.blocks[j >>> SHIFT][(j & MASK) * 3 + f]; }
  time(i) { return this._get(i, 0); }
  price(i) { return this._get(i, 1); }
  volume(i) { return this._get(i, 2); }
  /** The trade at i as [t, p, v] (a new array; for tests and rare use, not in loops). */
  at(i) { return i >= 0 && i < this.length ? [this._get(i, 0), this._get(i, 1), this._get(i, 2)] : undefined; }
  /** Drop the oldest n trades. */
  dropFirst(n) {
    n = Math.max(0, Math.min(this.length, n));
    this.start += n; this.length -= n;
    const whole = this.start >>> SHIFT;
    if (whole) { this.blocks.splice(0, whole); this.start &= MASK; }
    if (!this.length) this.clear();
  }
  /** The index of the first trade at or after time t (the store is in time order), or length. */
  indexAt(t) {
    let lo = 0, hi = this.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.time(m) < t) lo = m + 1; else hi = m; }
    return lo;
  }
  /** Feed trades from index `from` (with t >= minT, when given) to builder.add(t, p, v), oldest first. */
  feed(builder, from, minT) {
    const min = minT === undefined ? -Infinity : minT;
    const quiet = typeof builder.addQuiet === 'function';
    for (let i = Math.max(0, from || 0); i < this.length;) {
      const j = i + this.start, b = this.blocks[j >>> SHIFT];
      const end = Math.min(this.length, i + BLOCK - (j & MASK));
      for (let k = (j & MASK) * 3; i < end; i++, k += 3) {
        if (!(b[k] >= min)) continue;                  // a NaN time is skipped too, as before 1.5.1
        if (quiet) builder.addQuiet(b[k], b[k + 1], b[k + 2]); else builder.add(b[k], b[k + 1], b[k + 2]);
      }
    }
  }
}
/* the time of trade i, in a TickStore or a plain [[t, p, v], ...] list */
const timeAt = (ticks, i) => typeof ticks.time === 'function' ? ticks.time(i) : ticks[i][0];

/** Exchange time (bar-time seconds) at which the session holding t started. */
const sessionStartOf = (t, s) => s ? (tradeDay(t, s) - 1) * DAY + s : tradeDay(t, s) * DAY;

/*
 * RangeSync (1.8.0, served window): where range bars built from a window of recent trades become exactly the bars a build
 * from the session's first trade gives, without the trades before the window. Range bars depend on where the build
 * starts, but two builds meet for good once they close a bar on the same trade with the same edge; from that trade on
 * every bar is the same (the bar it opens, and all after it). That happens, whatever the build before the window did:
 *   - at the first trade of a new session seen inside the window (both open a new bar there, Break at EOD);
 *   - after a swing of more than the range each way: when the price has risen more than the range from the window's low
 *     so far to a high, and then falls more than the range below that high (before any higher high), both builds close
 *     their bar down on the same trade from the same high. (The rise forces both to have opened a bar after the low, so
 *     neither bar can hold a price above that high: in NinjaTrader style a bar opened by a down close starts below the
 *     bar before it, and one opened by an up close starts at its trade. So both highs are that high.) And the mirror:
 *     a fall of more than the range from the high so far to a low, then a rise of more than the range above that low.
 * Both range styles close on the same test (a price past the far side by more than the range, in whole ticks), so the
 * rule holds for both. step(t, price), fed every trade of the window in order, returns true for the trade from which
 * the two builds agree; the bars from the one that trade opens on are exact. test/live-first.test.js checks it against
 * full builds from many made-up histories.
 */
class RangeSync {
  constructor(rangeTicks, tick, sessionStart) {
    this.R = Math.max(1, rangeTicks | 0); this.tick = tick || 0.25; this.sessionStart = sessionStart === undefined ? 18 * 3600 : sessionStart;
    this.day = null; this.found = false;
  }
  _reset(P) { this.min = P; this.max = P; this.peak = P; this.trough = P; }   // peak: highest since the low; trough: lowest since the high
  step(t, price) {
    if (this.found) return false;
    const P = Math.round(price / this.tick), d = tradeDay(t, this.sessionStart);
    if (this.day === null) { this.day = d; this._reset(P); return false; }
    if (d !== this.day) { this.day = d; this._reset(P); return (this.found = true); }
    const R = this.R;
    if ((this.peak - this.min > R && P < this.peak - R) || (this.max - this.trough > R && P > this.trough + R)) return (this.found = true);
    if (P < this.min) { this.min = P; this.peak = P; } else if (P > this.peak) this.peak = P;
    if (P > this.max) { this.max = P; this.trough = P; } else if (P < this.trough) this.trough = P;
    return false;
  }
}

/*
 * trimCount (1.8.0): how many of the oldest trades the page drops when its store is over `cap`: the trades of sessions
 * before the one holding `now`, but the last of them (so a range build from the store's first trade still sees the
 * session start, RangeSync). The current session's trades are never dropped (range bars stay all day), unless the store
 * passes `hard` (a memory limit only; far above a busy session): then the oldest `step`.
 */
function trimCount(ticks, now, s, cap, hard, step) {
  if (ticks.length <= cap) return 0;
  const n = ticks.indexAt(sessionStartOf(now, s)) - 1;
  if (n > 0) return n;
  return ticks.length > hard ? Math.min(step, ticks.length) : 0;
}

/*
 * Range bars depend on where the build starts, so the page builds them from a session's first trade, like
 * NinjaTrader (Break at EOD). rangeHistoryFrom: the earliest session start the tick backfill has to reach: this
 * session's, or the one before while this session is under 8 hours old (so the evening still shows the day).
 * rangeTickHours: the tickHours to ask ChartBridge for (it serves at most 48).
 * rangeStartIndex: the first tick whose session started at or after the backfill's start; ticks of a session
 * the backfill only partly covers are skipped. When no session start is covered (a long closure), it is 0.
 */
const YOUNG_SESSION = 8 * 3600;
function rangeHistoryFrom(now, s) {
  const cur = sessionStartOf(now, s);
  return now - cur < YOUNG_SESSION ? cur - DAY : cur;
}
function rangeTickHours(now, s) { return Math.min(48, Math.ceil((now - rangeHistoryFrom(now, s)) / 3600) + 1); }
function rangeStartIndex(ticks, from, s) {
  for (let i = 0; i < ticks.length; i++) if (sessionStartOf(timeAt(ticks, i), s) >= from) return i;
  return 0;
}

/*
 * rangeNeedsReload: whether switching to Range needs a new tick backfill. Normally the ticks must reach back to
 * rangeHistoryFrom. After the page trimmed its oldest ticks (trimmed = true, on a very long session), it is
 * enough that they still reach this session's start: the partial older session is skipped, not reloaded.
 */
function rangeNeedsReload(tickFrom, now, s, trimmed) {
  return tickFrom > (trimmed ? sessionStartOf(now, s) : rangeHistoryFrom(now, s));
}
/*
 * partialStart: when the first tick used for range bars comes more than `slack` seconds after its session's start
 * (NinjaTrader returned less tick history than asked), its time; else null. Bars of that first session are then
 * built from mid-session and can differ from NinjaTrader's until the next session starts.
 */
function partialStart(ticks, from, s, slack) {
  if (!(from >= 0 && from < ticks.length)) return null;
  const t = timeAt(ticks, from);
  return t - sessionStartOf(t, s) > (slack === undefined ? 600 : slack) ? t : null;
}

return { BarBuilder, TickStore, RangeSync, trimCount, tradeDay, sessionStartOf, rangeHistoryFrom, rangeTickHours, rangeStartIndex, rangeNeedsReload, partialStart };
});
