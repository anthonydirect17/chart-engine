'use strict';
// A line-for-line port of ChartBridge 0.3.5's ChartBridgeFill.Join (nt8/ChartBridge.cs), for the fake bridge, so the
// smokes exercise the real join logic on the fake's tape (review N7). Sample data only.
// nt8/check/join-cases.txt holds cases with the C# answers; test/live-first.test.js checks this port gives the same, and
// nt8/check/FillHarness.cs checks the C# still does, so the two cannot drift apart unnoticed.
//
// B (bt, bp, bv): the older history, oldest first. R (rt, rp, rv): the recent window, of which the page got R[w ..].
// Times are any comparable numbers (the fake uses bar-time seconds). Returns what FillJoin holds: index, matched, checked,
// mismatchAt, gapMs (-1: none; in the time unit given), truncated, startsAfter, and send (the trades the page may be given:
// B[0 .. send), 0 unless the join is proven).
const JOIN_CHECK = 2000;
const priceKey = p => Math.round(p * 1e6);   // prices on a tick grid: the same as C#'s Math.Round there

function join(bt, bp, bv, rt, rp, rv, w, check) {
  const JC = check || JOIN_CHECK;
  const bn = bt ? Math.min(bt.length, bp.length, bv.length) : 0, rn = rt ? Math.min(rt.length, rp.length, rv.length) : 0;
  const r = { index: 0, matched: false, checked: 0, mismatchAt: -1, gapMs: -1, truncated: false, startsAfter: false, rFrom: -1, send: 0 };
  const done = () => { r.send = r.matched && r.gapMs < 0 ? r.index : 0; return r; };
  if (rn === 0 || w < 0 || w >= rn || bn === 0) return done();
  const sameTrade = (j, i) => bt[j] === rt[i] && priceKey(bp[j]) === priceKey(rp[i]) && bv[j] === rv[i];
  const same = (j, ww) => {
    let k = 0; const most = Math.min(JC, Math.min(rn - ww, bn - j));
    while (k < most && sameTrade(j + k, ww + k)) k++;
    return { k, whole: most > 0 && k === most };
  };
  const sameBefore = j => { const most = Math.min(JC, Math.min(j, w)); for (let k = 1; k <= most; k++) if (!sameTrade(j - k, w - k)) return k; return -1; };
  const lower = (t, n, x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };
  const upper = (t, n, x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] <= x) lo = m + 1; else hi = m; } return lo; };
  const t0 = rt[w];
  r.rFrom = w;
  if (bt[0] > t0) {
    r.startsAfter = true; r.index = 0;
    const p = lower(rt, rn, bt[0]);
    r.rFrom = p;
    const k = p < rn ? same(0, p).k : 0;
    const whole = p < rn && k === Math.min(JC, Math.min(rn - p, bn));
    r.checked = k;
    if (whole && k > 0) r.matched = true; else { r.mismatchAt = k; r.checked = k + 1; }
    return done();
  }
  const a = lower(bt, bn, t0);
  if (a >= bn) { r.index = bn; r.gapMs = t0 - bt[bn - 1]; return done(); }
  const b = upper(bt, bn, t0);
  let g0 = 0;
  for (let i = w - 1; i >= 0 && rt[i] === t0; i--) g0++;
  r.truncated = w - g0 === 0;
  const bCut = a === 0 && bt[0] === t0;
  const first = Math.min(a + g0, b);
  const lo = bCut ? a : first, hi = r.truncated ? b : first;
  let bestK = -1, bestJ = first, found = -1, provenCount = 0, foundK = 0;
  for (let j = lo; j <= hi && j < bn; j++) {
    const s = same(j, w);
    if (s.whole && sameBefore(j) < 0) {
      if (++provenCount > 1) break;
      found = j; foundK = s.k;
    } else if (s.k > bestK) { bestK = s.k; bestJ = j; }
  }
  if (provenCount === 1) { r.index = found; r.matched = true; r.checked = foundK; return done(); }
  r.index = Math.max(a, Math.min(provenCount > 1 ? found : bestJ, b));
  r.checked = Math.max(0, bestK) + 1;
  r.mismatchAt = provenCount > 1 ? r.checked : Math.max(0, bestK);
  return done();
}

module.exports = { join, JOIN_CHECK };
