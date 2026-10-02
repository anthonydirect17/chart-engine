// A scripted tape for the chart signals (G1c): sample trades with sides, made up and seeded, never market data. It reads
// like a real stretch of MNQ in regular hours on 40-tick range bars: a choppy start, a trend up to a swing high, a
// pullback on heavy selling that ends in a spring (a large buy at the low and a fast reversal), a rally to a higher high on
// weaker buying, a large sell at the top and a decline, then a small bounce. Large prints come as bursts of one side at
// one price inside a few milliseconds, as a real order fills. The fake bridge (--scene=signals) replays it live;
// test/signals-smoke.mjs and the screenshots look for an absorption bar of each side, a hollow then solid divergence
// arrow and bubbles of several sizes in it.
//
//   signalScene({ t0, p0, tick }) -> [[t, p, v, s], ...] in time order (t in seconds, s 1 buy or -1 sell)

export function signalScene(o) {
  const tick = o.tick || 0.25;
  let seed = o.seed || 20261002;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const exp = mean => -Math.log(1 - rnd() * 0.999999) * mean;
  const size = mean => Math.min(60, Math.max(1, Math.round(exp(mean))));
  const out = [];
  let t = o.t0, p = Math.round(o.p0 / tick) * tick;
  const put = (v, s) => out.push([+t.toFixed(3), +p.toFixed(2), v, s]);
  /* a large order: `n` prints of one side at one price, 3 to 12 ms apart */
  function burst(total, s, n) {
    let left = total;
    for (let k = 0; k < n; k++) {
      const v = k === n - 1 ? left : Math.max(1, Math.round(total / n * (0.6 + rnd() * 0.8)));
      left -= v; put(Math.max(1, v), s); t += 0.003 + rnd() * 0.009;
      if (left <= 0) break;
    }
  }
  /*
   * A leg: price from where it is by `pts` over `n` trades and `secs` seconds, a tick at a time at most, with a swing of
   * `chop` ticks around the line (`period` trades long) and some noise. An uptick is a buy with probability `with`, a
   * downtick a sell; an unchanged price a buy with `flatBuy`. Sizes: exponential around buyMean / sellMean. `bursts`:
   * [{ at (0 to 1 of the leg), v, s, n }].
   */
  function leg(L) {
    const start = p, T = Math.round(L.pts / tick), n = L.n, chop = L.chop === undefined ? 6 : L.chop, period = L.period || 70;
    const bursts = (L.bursts || []).map(b => Object.assign({ i: Math.max(1, Math.floor(b.at * n)) }, b));
    const phase = rnd() * Math.PI * 2;
    for (let i = 1; i <= n; i++) {
      const f = i / n, fade = Math.min(1, 6 * f) * Math.min(1, 6 * (1 - f) + 0.15);
      const want = start + (T * f + chop * fade * Math.sin(phase + 2 * Math.PI * i / period) + (rnd() - 0.5) * 2.2) * tick;
      const steps = Math.round((want - p) / tick), move = rnd() < 0.42 ? 0 : Math.max(-1, Math.min(1, steps));
      p += move * tick;
      const s = move > 0 ? (rnd() < (L.with || 0.85) ? 1 : -1) : move < 0 ? (rnd() < (L.with || 0.85) ? -1 : 1) : (rnd() < (L.flatBuy === undefined ? 0.5 : L.flatBuy) ? 1 : -1);
      put(size(s > 0 ? L.buyMean || 5 : L.sellMean || 5), s);
      for (const b of bursts) if (b.i === i) burst(b.v, b.s, b.n || 5);
      t += exp(L.secs / n) * 0.9 + 0.004;
    }
    // land exactly on the leg's end
    while (Math.abs(p - (start + T * tick)) > 1e-9) { p += Math.sign(start + T * tick - p) * tick; put(size(4), Math.sign(T) || 1); t += 0.05 + rnd() * 0.2; }
  }

  // a choppy start, slightly up (some 8 bars)
  leg({ pts: 6, n: 900, secs: 300, chop: 26, period: 260, flatBuy: 0.5, buyMean: 5, sellMean: 5, bursts: [{ at: 0.35, v: 130, s: -1, n: 4 }, { at: 0.8, v: 160, s: 1, n: 5 }] });
  leg({ pts: 10, n: 700, secs: 240, chop: 18, period: 200, flatBuy: 0.55, buyMean: 5.5, sellMean: 5, bursts: [{ at: 0.5, v: 110, s: 1, n: 3 }] });
  // the trend up to the first swing high (A), buyers in charge
  leg({ pts: 62, n: 2300, secs: 420, chop: 10, period: 150, with: 0.9, flatBuy: 0.66, buyMean: 7, sellMean: 4.5,
    bursts: [{ at: 0.22, v: 180, s: 1, n: 5 }, { at: 0.55, v: 260, s: 1, n: 6 }, { at: 0.86, v: 140, s: 1, n: 4 }] });
  // the pullback on heavy selling
  leg({ pts: -48, n: 2100, secs: 380, chop: 9, period: 160, with: 0.88, flatBuy: 0.36, buyMean: 4.5, sellMean: 6.5,
    bursts: [{ at: 0.3, v: 210, s: -1, n: 6 }, { at: 0.62, v: 120, s: -1, n: 4 }, { at: 0.9, v: 200, s: -1, n: 6 }] });
  // the spring: one more push down on heavy selling, a large buy at the low, a fast reversal on heavy buying (bullish
  // absorption: a large buy, a volume spike, the close at the top of the bar)
  leg({ pts: -4, n: 320, secs: 66, chop: 2, period: 60, with: 0.92, flatBuy: 0.25, buyMean: 4, sellMean: 7 });
  burst(430, 1, 7);
  leg({ pts: 13, n: 520, secs: 75, chop: 1, period: 80, with: 0.93, flatBuy: 0.75, buyMean: 9.5, sellMean: 4 });
  // the rally to a higher high on weaker buying: the price makes it, the delta does not
  leg({ pts: 66, n: 2600, secs: 470, chop: 9, period: 170, with: 0.82, flatBuy: 0.4, buyMean: 4.6, sellMean: 5.6,
    bursts: [{ at: 0.3, v: 120, s: 1, n: 4 }, { at: 0.7, v: 150, s: -1, n: 5 }] });
  // the top: a last push up, a large sell into it and a fast drop on heavy selling (bearish absorption)
  leg({ pts: 3, n: 160, secs: 30, chop: 1, period: 40, with: 0.85, flatBuy: 0.55, buyMean: 5, sellMean: 6 });
  burst(380, -1, 7);
  leg({ pts: -14, n: 640, secs: 85, chop: 1, period: 80, with: 0.93, flatBuy: 0.2, buyMean: 4, sellMean: 12 });
  // the decline that confirms the top, sellers in charge, a few large sells
  leg({ pts: -50, n: 2100, secs: 400, chop: 9, period: 150, with: 0.9, flatBuy: 0.32, buyMean: 4.5, sellMean: 7.5,
    bursts: [{ at: 0.25, v: 240, s: -1, n: 6 }, { at: 0.5, v: 820, s: -1, n: 9 }, { at: 0.78, v: 170, s: -1, n: 5 }] });
  // a small bounce
  leg({ pts: 14, n: 800, secs: 200, chop: 8, period: 120, with: 0.85, flatBuy: 0.55, buyMean: 5, sellMean: 5, bursts: [{ at: 0.4, v: 125, s: 1, n: 4 }] });
  return out;
}
