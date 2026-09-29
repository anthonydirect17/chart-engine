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
  reset() { this.bars = []; this.day = null; this.pv = 0; this.vol = 0; this.lastT = -Infinity; }
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
    v = v || 0;
    const vw = this._vwap(t, price, v);
    const prevT = this.lastT;
    this.lastT = Math.max(prevT, t);
    let bar = this.last, isNew = false;
    if (this.mode === 'time') {
      const bt = Math.floor(t / this.seconds) * this.seconds;
      if (!bar || bt > bar.t) {
        bar = { t: bt, o: price, h: price, l: price, c: price, v: 0, vw };
        this.bars.push(bar); isNew = true;
      }
      // a late tick for an older bucket folds into the newest bar rather than rewriting history
    } else {
      const newSession = !bar || tradeDay(t, this.sessionStart) !== tradeDay(bar.t, this.sessionStart);
      if (!newSession && this.rangeMode === 'nt') {
        const r = this._ntRange(t, price, v, vw, bar, prevT);
        if (r) return r;
      } else {
        const span = this.rangeTicks * this.tick + 1e-9;
        if (newSession || price > bar.l + span || price < bar.h - span) { bar = this._open(this._times(t, 1, prevT)(0), price, vw); isNew = true; }
      }
    }
    if (price > bar.h) bar.h = price;
    if (price < bar.l) bar.l = price;
    bar.c = price; bar.v += v; bar.vw = vw;
    return { bar, isNew, changed: [bar] };
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
    const q = p => Math.round(p / tk), px = n => +(n * tk).toFixed(10);
    const P = q(price), lo = q(bar.l), hi = q(bar.h), cl = q(bar.c);
    let up;
    if (P > lo + R) up = true;
    else if (P < hi - R) up = false;
    else return null;
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
function rangeTickHours(now, s) { return Math.min(48, Math.ceil((now - rangeHistoryFrom(now, s)) / 3600) + 1); }
function rangeStartIndex(ticks, from, s) {
  for (let i = 0; i < ticks.length; i++) if (sessionStartOf(ticks[i][0], s) >= from) return i;
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
  const k = ticks[from];
  if (!k) return null;
  return k[0] - sessionStartOf(k[0], s) > (slack === undefined ? 600 : slack) ? k[0] : null;
}

return { BarBuilder, tradeDay, sessionStartOf, rangeHistoryFrom, rangeTickHours, rangeStartIndex, rangeNeedsReload, partialStart };
});
