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
const tradeDay = (t, s) => s ? Math.floor((t + DAY - s) / DAY) : Math.floor(t / DAY);

/**
 * mode 'time': seconds per bar. mode 'range': a bar closes once its high-low span would exceed
 * rangeTicks * tick; the tick that breaks out opens the next bar at its own price (no invented prices).
 */
class BarBuilder {
  constructor(opts) {
    const o = opts || {};
    this.mode = o.mode === 'range' ? 'range' : 'time';
    this.seconds = o.seconds || 60;
    this.tick = o.tick || 0.25;
    this.rangeTicks = Math.max(1, o.rangeTicks || 20);
    this.sessionStart = o.sessionStart === undefined ? 18 * 3600 : o.sessionStart;
    this.reset();
  }
  reset() { this.bars = []; this.day = null; this.pv = 0; this.vol = 0; }
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

  /** Add one trade. Returns the bar it landed in and whether that bar is new. */
  add(t, price, v) {
    v = v || 0;
    const vw = this._vwap(t, price, v);
    let bar = this.last, isNew = false;
    if (this.mode === 'time') {
      const bt = Math.floor(t / this.seconds) * this.seconds;
      if (!bar || bt > bar.t) {
        bar = { t: bt, o: price, h: price, l: price, c: price, v: 0, vw };
        this.bars.push(bar); isNew = true;
      }
      // a late tick for an older bucket folds into the newest bar rather than rewriting history
    } else {
      const span = this.rangeTicks * this.tick + 1e-9;
      if (!bar || price > bar.l + span || price < bar.h - span || tradeDay(t, this.sessionStart) !== tradeDay(bar.t, this.sessionStart)) {
        const bt = bar ? Math.max(t, bar.t + 0.001) : t;          // keep times strictly increasing
        bar = { t: bt, o: price, h: price, l: price, c: price, v: 0, vw };
        this.bars.push(bar); isNew = true;
      }
    }
    if (price > bar.h) bar.h = price;
    if (price < bar.l) bar.l = price;
    bar.c = price; bar.v += v; bar.vw = vw;
    return { bar, isNew };
  }

  /** Range bars: ticks left before the forming bar completes, up and down. */
  rangeLeft() {
    const b = this.last; if (!b || this.mode !== 'range') return null;
    const span = this.rangeTicks * this.tick;
    return { up: Math.max(0, Math.round((b.l + span - b.c) / this.tick)), down: Math.max(0, Math.round((b.c - (b.h - span)) / this.tick)) };
  }
}

return { BarBuilder, tradeDay };
});
