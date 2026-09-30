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
    this.reset();
  }
  reset() { this.bars = []; this.day = null; this.pv = 0; this.vol = 0; this.lastT = -Infinity; this._dayBar = null; this._barDay = null; this._fast = null; }
  get last() { return this.bars[this.bars.length - 1]; }

  _vwap(t, price, v) {
    const d = tradeDay(t, this.sessionStart);
    if (d !== this.day) { this.day = d; this.pv = 0; this.vol = 0; }
    this.pv += price * v; this.vol += v;
    return this.vol > 0 ? this.pv / this.vol : price;
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
        const vw = this.vol > 0 ? this.pv / this.vol : price, bar = f.bar;
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
 * array per trade. The range view holds up to 34 hours of ticks (about 2 million on a busy NQ day): as arrays that
 * was about 2 million objects (some 150 MB of JavaScript heap) for the garbage collector to walk and move, and the
 * page's frames waited on it. Blocks live outside that heap, are never copied as the store grows, and the oldest
 * are dropped whole when the page trims its history.
 * Each trade's side (1.7.0, ChartBridge 0.3.4 sends `s` and `sm` with every trade; nt8/PROTOCOL.md, Trade side) is one
 * byte beside its block: 0 when the trade came with no side at all (ChartBridge 0.3.3 and older), else
 * 1 + (s + 1) + 3 * sm for s = 1 buy, -1 sell, 0 unknown and sm = 0 none, 1 aggressor, 2 bid/ask, 3 tick rule. A side
 * or method that is not one of those is kept as unknown (s 0, sm 0). The page never works a side out itself.
 */
const BLOCK = 65536, SHIFT = 16, MASK = BLOCK - 1;
/* The side byte for s and sm as ChartBridge sends them (see above). */
function sideCode(s, sm) {
  if (s === undefined || s === null) return 0;
  if (s !== 1 && s !== -1 && s !== 0) return 1 + 1;              // not a side: unknown
  return 1 + (s + 1) + 3 * (sm === 1 || sm === 2 || sm === 3 ? sm : 0);
}
/* The side (1, -1, 0) of a side byte, or undefined for a trade that came with none; and its method (0 to 3). */
const codeSide = c => c ? (c - 1) % 3 - 1 : undefined;
const codeMethod = c => c ? Math.floor((c - 1) / 3) : 0;
class TickStore {
  constructor() { this.clear(); }
  clear() { this.blocks = []; this.sides = []; this.start = 0; this.length = 0; }
  /*
   * The block pair and the slot writer every way in goes through (review 2, merge planning): a trade's columns and its
   * side byte always live at the same slot j (the store's start plus its index) of `blocks` and `sides`, so a block is
   * only ever added or dropped with its side block. _addBlock appends a pair, _addBlockFront puts one in front (for a
   * prepend of older trades: live-first's `prependAll` must add its front blocks with it and write each trade with
   * `_put`, never `blocks` alone, or the sides shift against the trades), and _put writes one trade and its side.
   */
  _addBlock() { this.blocks.push(new Float64Array(BLOCK * 3)); this.sides.push(new Uint8Array(BLOCK)); }
  _addBlockFront() { this.blocks.unshift(new Float64Array(BLOCK * 3)); this.sides.unshift(new Uint8Array(BLOCK)); }
  _put(j, t, p, v, s, sm) {
    const b = this.blocks[j >>> SHIFT], k = (j & MASK) * 3;
    b[k] = t; b[k + 1] = p; b[k + 2] = v || 0;
    this.sides[j >>> SHIFT][j & MASK] = sideCode(s, sm);
  }
  /** Add one trade at the end; s and sm (ChartBridge 0.3.4) are left out for a trade that has none. */
  push(t, p, v, s, sm) {
    const j = this.start + this.length;
    if (!this.blocks[j >>> SHIFT]) this._addBlock();
    this._put(j, t, p, v, s, sm);
    this.length++;
  }
  /** Add trades as ChartBridge sends them, [[t, p, v], ...] or since 0.3.4 [[t, p, v, s, sm], ...]. The only pushAll:
      a merge must keep this five-place one (a second, three-place pushAll defined after it would win silently and drop
      every backfill side; review 2's trial merge). */
  pushAll(list) { for (let i = 0; i < list.length; i++) { const x = list[i]; this.push(x[0], x[1], x[2], x[3], x[4]); } }
  _get(i, f) { const j = i + this.start; return this.blocks[j >>> SHIFT][(j & MASK) * 3 + f]; }
  time(i) { return this._get(i, 0); }
  price(i) { return this._get(i, 1); }
  volume(i) { return this._get(i, 2); }
  _code(i) { const j = i + this.start; return this.sides[j >>> SHIFT][j & MASK]; }
  /** The side of trade i: 1 buy, -1 sell, 0 unknown, or undefined when it came with none (ChartBridge 0.3.3). */
  side(i) { return codeSide(this._code(i)); }
  /** How its side was found: 0 none, 1 aggressor flag, 2 bid/ask, 3 tick rule. */
  method(i) { return codeMethod(this._code(i)); }
  /** The trade at i as [t, p, v] (a new array; for tests and rare use, not in loops). */
  at(i) { return i >= 0 && i < this.length ? [this._get(i, 0), this._get(i, 1), this._get(i, 2)] : undefined; }
  /** Drop the oldest n trades. */
  dropFirst(n) {
    n = Math.max(0, Math.min(this.length, n));
    this.start += n; this.length -= n;
    const whole = this.start >>> SHIFT;
    if (whole) { this.blocks.splice(0, whole); this.sides.splice(0, whole); this.start &= MASK; }
    if (!this.length) this.clear();
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
  /**
   * feed() with each trade's side (1.7.0): builder.addQuiet(t, p, v, s, sm), s undefined for a trade that came with
   * none. For the cumulative delta (ChartEngine.CumulativeDelta), which counts exactly the trades this store holds.
   * `to` (optional) stops before that index, so a long build can go in slices (the page's delta, review S5); returns
   * the index it stopped at.
   */
  feedSides(builder, from, minT, to) {
    const min = minT === undefined || minT === null ? -Infinity : minT, stop = to === undefined ? this.length : Math.min(this.length, to);
    let i = Math.max(0, from || 0);
    while (i < stop) {
      const j = i + this.start, b = this.blocks[j >>> SHIFT], sd = this.sides[j >>> SHIFT];
      const end = Math.min(stop, i + BLOCK - (j & MASK));
      for (let m = j & MASK, k = m * 3; i < end; i++, m++, k += 3) {
        if (!(b[k] >= min)) continue;
        const c = sd[m];
        builder.addQuiet(b[k], b[k + 1], b[k + 2], codeSide(c), codeMethod(c));
      }
    }
    return i;
  }
}
/* the time of trade i, in a TickStore or a plain [[t, p, v], ...] list */
const timeAt = (ticks, i) => typeof ticks.time === 'function' ? ticks.time(i) : ticks[i][0];

/** Exchange time (bar-time seconds) at which the session holding t started. */
const sessionStartOf = (t, s) => s ? (tradeDay(t, s) - 1) * DAY + s : tradeDay(t, s) * DAY;

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
/* One hour more than the session start needs (1.7.0): the request then starts before 17:00 ET, in the previous
   session's last trading hour, not in the 17:00 to 18:00 break, so the backfill holds a trade from before 18:00 and the
   delta pane can prove the session whole (live.js, deltaCoveredFrom). Without it every weekday load was "from 18:00:00.4". */
function rangeTickHours(now, s) { return Math.min(48, Math.ceil((now - rangeHistoryFrom(now, s)) / 3600) + 2); }
/*
 * The tickHours a time view asks for (1.7.0, Anthony's ruling 2026-09-30): seconds bars are built from ticks (8 hours);
 * minute and hour views need none for their bars, but with the delta pane on they ask DELTA_TICK_HOURS (2), so trading
 * after hours has its delta: max(what the view asks, 2 hours). The cumulative still resets at 18:00 ET; when the 2 hours
 * do not reach back to the session start, the page labels it "from HH:MM" (live.js, deltaCoverage).
 */
const DELTA_TICK_HOURS = 2;
function timeTickHours(seconds, delta) { return Math.max(seconds < 60 ? 8 : 0, delta ? DELTA_TICK_HOURS : 0); }
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

/*
 * minuteCover (1.7.0, review 2 S2): from when a TickStore provably holds every trade, by NinjaTrader's own minute history,
 * which comes apart from its tick history. `minutes` is { t, v }: NinjaTrader's complete history minutes (start times and
 * volumes, oldest first; never the forming minute, which ChartBridge may rebuild from the same ticks).
 *   - m, the minute of the store's first trade: when the store's trades in [m, m + 60) add up to that minute's volume
 *     exactly, the store holds every trade of it (none before the first one is missing), so it is whole from m;
 *   - when m is its session's start (18:00 ET) and, in addition, the minute history holds no bar in the hour before it
 *     (the 17:00 to 18:00 break, a weekend or a holiday: the market was closed) and reaches back past that hour, the
 *     session is whole from its start. A Monday's session opening Sunday 18:00 is proved this way, and so is a minute
 *     view's 2 hours of ticks at 19:30; without the closed hour the proof does not count a session whole.
 * Returns { from, code }: `from` the time from which the store is whole (null when nothing is proved), `code` 'open'
 * (the session is whole), 'minute' (from m), 'bar' (no complete history minute at m), 'volume' (the volumes differ),
 * 'closed' (m is 18:00 but the history shows trades in the hour before it, or does not reach back past it), 'empty'.
 */
function minuteCover(ticks, minutes, s) {
  const n = ticks.length;
  if (!n || !minutes || !minutes.t.length) return { from: null, code: 'empty' };
  const t0 = timeAt(ticks, 0), m = Math.floor(t0 / 60) * 60, mt = minutes.t;
  let lo = 0, hi = mt.length;                                  // the first minute at or after m
  while (lo < hi) { const mid = (lo + hi) >> 1; if (mt[mid] < m) lo = mid + 1; else hi = mid; }
  if (lo >= mt.length || mt[lo] !== m || !(minutes.v[lo] > 0)) return { from: null, code: 'bar' };
  let vol = 0;
  for (let i = 0; i < n; i++) {
    const t = timeAt(ticks, i);
    if (t >= m + 60) break;
    if (t >= m) vol += typeof ticks.volume === 'function' ? ticks.volume(i) : ticks[i][2] || 0;
  }
  if (vol !== minutes.v[lo]) return { from: null, code: 'volume' };
  const start = sessionStartOf(t0, s);
  if (m !== start) return { from: m, code: 'minute' };
  // the minute before the open: none in the hour before it, and the history reaches back past that hour
  const prev = lo - 1;
  if (prev < 0 || mt[prev] >= start - 3600) return { from: null, code: 'closed' };
  return { from: start, code: 'open' };
}
/* Whether NinjaTrader's minute history has a bar starting in [from, to): trades the tick history should have held. */
function minutesBetween(minutes, from, to) {
  if (!minutes || !(from < to)) return false;
  const mt = minutes.t;
  let lo = 0, hi = mt.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (mt[mid] < from) lo = mid + 1; else hi = mid; }
  return lo < mt.length && mt[lo] < to;
}

return { BarBuilder, TickStore, sideCode, tradeDay, sessionStartOf, rangeHistoryFrom, rangeTickHours, DELTA_TICK_HOURS, timeTickHours, rangeStartIndex, rangeNeedsReload, partialStart, minuteCover, minutesBetween };
});
