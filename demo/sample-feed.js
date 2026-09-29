/*
 * Sample MNQ-shaped data and a simulated tick feed, for the demo and tests only. NOT market data.
 * Seeded, so every load draws the same history (identical to Chart lab v0).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../src/chart-engine.js'));
  else root.SampleFeed = factory(root.ChartEngine);
})(typeof self !== 'undefined' ? self : this, function (CE) {
'use strict';
const U = CE.util, DAY = 86400, TICK = 0.25;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rq = p => Math.round(p / TICK) * TICK;
const SESSION = 18 * 3600;

function marketOpen(t) {
  const d = new Date(t * 1000).getUTCDay(), s = U.tod(t);
  if (d === 6) return false;
  if (d === 5 && s >= 61200) return false;
  if (d === 0 && s < 64800) return false;
  return !(s >= 61200 && s < 64800);                  // daily break 17:00-18:00 ET
}
function volFactor(t) {
  const m = U.tod(t) / 60;
  if (m >= 1080 || m < 120) return 0.38;   // Asia
  if (m < 510) return 0.5;                 // London
  if (m < 570) return 0.85;                // 8:30 data to the open
  if (m < 630) return 1.6;                 // first hour
  if (m < 720) return 1.05;
  if (m < 840) return 0.72;                // lunch
  if (m < 930) return 0.9;
  if (m < 960) return 1.3;                 // close
  return 0.45;                             // 16:00-17:00
}

function create(options) {
  const opt = options || {};
  const rnd = mulberry32(opt.seed !== undefined ? opt.seed : 20260929);
  const gauss = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const T_START = opt.start !== undefined ? opt.start : Date.UTC(2026, 8, 22, 18, 0) / 1000;   // Tue Sep 22 18:00 ET
  const T_LIVE = opt.live !== undefined ? opt.live : Date.UTC(2026, 8, 29, 10, 31) / 1000;     // Tue Sep 29 10:31 ET

  const base = [], gen = { z: 0, d: 0, regime: 1 }, cum = { pv: 0, v: 0 };
  let p = opt.startPrice || 25610, prevDay = null;
  for (let t = T_START; t < T_LIVE; t += 60) {
    if (!marketOpen(t)) continue;
    const day = U.tradeDay(t, SESSION);
    if (day !== prevDay) { cum.pv = 0; cum.v = 0; if (prevDay !== null) p += gauss() * 6; prevDay = day; }
    gen.z = gen.z * 0.995 + 0.07 * gauss(); gen.regime = Math.exp(0.35 * gen.z);
    gen.d = gen.d * 0.985 + 0.04 * gauss();
    let f = volFactor(t);
    const m = U.tod(t) / 60;
    if (m === 510 || m === 570 || m === 600) f *= 2.2;
    const sd = 5.0 * f * gen.regime / Math.sqrt(12);
    const o = rq(p); let h = p, l = p;
    for (let k = 0; k < 12; k++) {
      p += gen.d * 0.12 * f + sd * gauss();
      if (rnd() < 0.002) p += gauss() * 8 * f;
      if (p > h) h = p; if (p < l) l = p;
    }
    const c = rq(p); p = c;
    h = Math.max(rq(h), o, c); l = Math.min(rq(l), o, c);
    const v = Math.round(700 * Math.pow(f, 1.5) * gen.regime * Math.exp(0.35 * gauss()) * (1 + Math.abs(c - o) / (5 * f + 1) * 0.5)) + 3;
    cum.pv += (h + l + c) / 3 * v; cum.v += v;
    base.push({ t, o, h, l, c, v, vw: cum.pv / cum.v });
  }
  const lb = base[base.length - 1];
  base.push({ t: T_LIVE, o: lb.c, h: lb.c, l: lb.c, c: lb.c, v: 0, vw: lb.vw });

  const levels = U.levelLines(U.sessionLevels(base, { asOf: T_LIVE, sessionStart: SESSION, tick: TICK }));

  const day0 = Math.floor(T_LIVE / DAY) * DAY;
  const trades = [['09:41', 3, true], ['09:58', 4, true], ['10:12', 3, false], ['10:24', 2, true]].map(([hm, k, win]) => {
    const [H, M] = hm.split(':').map(Number);
    const i = base.findIndex(b => b.t === day0 + H * 3600 + M * 60), j = i + k;
    const pIn = base[i].o, pOut = base[j].c;
    let dir = Math.sign(pOut - pIn) || 1; if (!win) dir = -dir;
    return { tIn: base[i].t, tOut: base[j].t, pIn, pOut, dir };
  });

  const feed = { simT: T_LIVE + 14, acc: 0, gap: 150, lastReal: 0, mom: 0, speed: 1 };
  const listeners = [];
  const nextGap = () => Math.min(900, Math.max(25, -Math.log(1 - rnd()) * 170));
  function tick() {
    feed.simT += feed.gap / 1000 * feed.speed;
    if (!marketOpen(feed.simT)) { let t = Math.floor(feed.simT / 60) * 60; while (!marketOpen(t)) t += 60; feed.simT = t; }
    const minute = Math.floor(feed.simT / 60) * 60;
    let b = base[base.length - 1];
    if (minute > b.t) {
      cum.pv += (b.h + b.l + b.c) / 3 * b.v; cum.v += b.v;
      if (U.tradeDay(minute, SESSION) !== U.tradeDay(b.t, SESSION)) { cum.pv = 0; cum.v = 0; }
      gen.z = gen.z * 0.995 + 0.07 * gauss(); gen.regime = Math.exp(0.35 * gen.z);
      b = { t: minute, o: b.c, h: b.c, l: b.c, c: b.c, v: 0, vw: b.vw };
      base.push(b);
    }
    const f = volFactor(feed.simT);
    feed.mom = feed.mom * 0.92 + 0.08 * gauss();
    const sd = 1.05 * f * gen.regime * Math.sqrt(feed.speed);
    const ticks = Math.round(gauss() * sd + feed.mom * sd * 0.8);
    const px = b.c + ticks * TICK;
    b.c = px; if (px > b.h) b.h = px; if (px < b.l) b.l = px;
    b.v += 1 + Math.floor(rnd() * rnd() * 24 * f);
    b.vw = (cum.pv + (b.h + b.l + b.c) / 3 * b.v) / (cum.v + b.v);
    for (const fn of listeners) fn(b, ticks);
  }

  return {
    base, levels, trades, tick: TICK, sessionStart: SESSION,
    now: () => feed.simT,
    getSpeed: () => feed.speed,
    setSpeed(s) { feed.speed = s; },
    onTick(fn) { listeners.push(fn); },
    /** Call every animation frame with performance.now(); fires ticks at a live-market pace. */
    step(now) {
      if (!feed.lastReal) feed.lastReal = now;
      const dt = now - feed.lastReal; feed.lastReal = now;
      if (feed.speed === 0) return;
      feed.acc += Math.min(dt, 1000);
      let guard = 0;
      while (feed.acc >= feed.gap && guard++ < 50) { feed.acc -= feed.gap; tick(); feed.gap = nextGap(); }
    },
  };
}

return { create };
});
