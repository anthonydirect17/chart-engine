/*
 * AgentGrid: the Agent tab's grid canvas (Layout 5, DECISION 2026-10-14a; docs/AGENT_TAB.md, docs/MOTION.md). One 2D canvas
 * in the tab's grid panel, behind its words: the five steps (Screen, Eyes, Judgment, Checks, ChartBridge) feed a point-cloud
 * sphere turning slowly inside identity-disc rings, and lines funnel out of it into the decision. It draws only what the page
 * gives it (AgentDesk, live/agent.js): each step's colour (the tracker's), whether the step has words today (its feed flows),
 * which step is the step now, whether there is a decision to funnel into, and when a plan fired (an agentPlan message): only
 * then an orange beam and an orange segment on the rings, for a few seconds. No scores, no data of its own.
 *
 *   const g = AgentGrid.create(canvas, { root, steps: () => [elements], decision: () => element, colors });
 *   g.set({ steps: [{ color, lit, now }], decision: true, motion: 'full' | 'off', shown: true });
 *   g.fire(at); g.state(); g.destroy();
 *
 * The one place in the tab with a frame loop (the lead's ruling for Layout 5; test/agent.test.js allows it here only):
 *   - at most 30 frames a second (a frame is drawn only when 33 ms have passed), at most 1.5 device pixels per CSS pixel;
 *   - paused (no frame scheduled at all) while the window is hidden, the tab is not shown or the canvas has no size, and while
 *     Motion is Off or the system asks for reduced motion: then one still frame is drawn, again only when what it shows changes;
 *   - cheap: what does not move (the horizon, the feeds' lines, the funnel's lines, the sphere's glow) is drawn once per size
 *     and state on a canvas of its own and copied in one call; per frame only the sphere's points (in three alpha levels), the
 *     rings, the particles and the beam. No shadow blur, no filter. Sizes are read only when the canvas changes size (a
 *     ResizeObserver), never in a frame.
 *   - never over the chart (it sits in the grid panel), never on an order surface, no key or pointer handler.
 */
(function () {
'use strict';
const FPS = 30, FRAME_MS = 1000 / FPS, MAX_DPR = 1.5, FIRE_MS = 6000, N_POINTS = 340;
const ORANGE = '#ff7a18', CYAN = '#5df2ff', HOT = '#e8feff';

/* points on a unit sphere, evenly spread (a Fibonacci lattice): the cloud */
const SPHERE = (() => {
  const out = new Float32Array(N_POINTS * 3), g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N_POINTS; i++) {
    const y = 1 - (i / (N_POINTS - 1)) * 2, r = Math.sqrt(Math.max(0, 1 - y * y)), t = g * i;
    out[i * 3] = Math.cos(t) * r; out[i * 3 + 1] = y; out[i * 3 + 2] = Math.sin(t) * r;
  }
  return out;
})();

function create(canvas, o) {
  o = o || {};
  const win = typeof window !== 'undefined' ? window : null;
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  const S = { steps: [], decision: false, motion: 'full', shown: true, fireAt: 0, w: 0, h: 0, dpr: 1, frames: 0, still: 0 };
  const G = { cx: 0, cy: 0, r: 0, feeds: [], out: null, layer: null, sig: '' };
  const reducedMq = win && typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(reducedMq && reducedMq.matches);
  const docHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const now = () => (win && win.performance ? win.performance.now() : Date.now());
  let raf = 0, last = -1e9, stillTimer = 0, dead = false;

  const moving = () => !dead && !!ctx && S.shown && S.motion !== 'off' && !reduced() && !docHidden() && S.w > 0 && S.h > 0;

  /* ---------------- size and geometry: read when the canvas changes size (and when the page says the words moved) */
  function measure() {
    if (!canvas || dead) return;
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(MAX_DPR, Math.max(1, (win && win.devicePixelRatio) || 1));
    S.w = w; S.h = h; S.dpr = dpr;
    if (!w || !h) { stop(); return; }
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const cr = canvas.getBoundingClientRect();
    const at = el => { if (!el || !el.getClientRects().length) return null; const r = el.getBoundingClientRect(); return { l: r.left - cr.left, r: r.right - cr.left, t: r.top - cr.top, b: r.bottom - cr.top }; };
    const steps = (typeof o.steps === 'function' ? o.steps() : []).map(at), dec = at(typeof o.decision === 'function' ? o.decision() : null);
    const left = Math.max(0, ...steps.filter(Boolean).map(s => s.r)), right = dec ? dec.l : w - 16;
    const span = Math.max(40, right - left);
    G.r = Math.max(16, Math.min(h * 0.36, span * 0.24));
    G.cx = left + span * 0.5; G.cy = h * 0.53;
    /* each step's feed: from the end of its words to the sphere's left side, a curve sampled once */
    G.feeds = steps.map((s, i) => {
      if (!s) return null;
      const x0 = s.r + 6, y0 = (s.t + s.b) / 2, dy = (i - 2) * G.r * 0.34;
      const x3 = G.cx - Math.sqrt(Math.max(0, G.r * G.r - dy * dy)), y3 = G.cy + dy;
      const pts = [];
      for (let k = 0; k <= 40; k++) {
        const u = k / 40, a = 1 - u, mx = (x0 + x3) / 2;
        pts.push([a * a * a * x0 + 3 * a * a * u * mx + 3 * a * u * u * mx + u * u * u * x3, a * a * a * y0 + 3 * a * a * u * y0 + 3 * a * u * u * y3 + u * u * u * y3]);
      }
      return pts;
    });
    G.out = dec ? { x0: G.cx + G.r * 1.05, y0: G.cy, x1: dec.l - 4, y1: (dec.t + dec.b) / 2, t: dec.t, b: dec.b } : null;
    G.sig = '';
    if (moving()) start(); else still();
  }

  /* ---------------- what does not move: drawn once per size and state */
  function staticLayer() {
    const sig = [S.w, S.h, S.dpr, S.decision ? 1 : 0, S.steps.map(s => s.color + (s.lit ? 1 : 0) + (s.now ? 1 : 0)).join(',')].join('|');
    if (sig === G.sig && G.layer) return G.layer;
    G.sig = sig;
    const L = G.layer || (typeof document !== 'undefined' ? document.createElement('canvas') : null);
    if (!L) return null;
    G.layer = L; L.width = canvas.width; L.height = canvas.height;
    const c = L.getContext('2d'); c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0); c.clearRect(0, 0, S.w, S.h);
    /* the horizon: a floor of lines under the sphere, fading up */
    const hz = G.cy + G.r * 0.95;
    c.lineWidth = 1;
    for (let i = 0; i < 7; i++) { const y = hz + (S.h - hz) * Math.pow(i / 6, 1.7); c.strokeStyle = 'rgba(46,155,255,' + (0.05 + 0.1 * i / 6).toFixed(3) + ')'; c.beginPath(); c.moveTo(0, y); c.lineTo(S.w, y); c.stroke(); }
    for (let i = -12; i <= 12; i++) { c.strokeStyle = 'rgba(46,155,255,0.07)'; c.beginPath(); c.moveTo(G.cx + i * 18, hz); c.lineTo(G.cx + i * 110, S.h); c.stroke(); }
    /* the sphere's glow and its rim */
    const gl = c.createRadialGradient(G.cx, G.cy, 0, G.cx, G.cy, G.r * 1.1);
    gl.addColorStop(0, 'rgba(232,254,255,0.22)'); gl.addColorStop(0.35, 'rgba(93,242,255,0.08)'); gl.addColorStop(1, 'rgba(93,242,255,0)');
    c.fillStyle = gl; c.beginPath(); c.arc(G.cx, G.cy, G.r * 1.1, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(93,242,255,0.18)'; c.beginPath(); c.arc(G.cx, G.cy, G.r * 1.4, 0, Math.PI * 2); c.stroke();
    /* the feeds: one line per step in its colour, bright where the step has words today */
    G.feeds.forEach((pts, i) => {
      if (!pts) return;
      const s = S.steps[i] || {};
      c.strokeStyle = s.color || CYAN; c.globalAlpha = s.now ? 0.75 : s.lit ? 0.45 : 0.14; c.lineWidth = s.now ? 1.5 : 1;
      c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (const p of pts) c.lineTo(p[0], p[1]); c.stroke();
    });
    c.globalAlpha = 1;
    /* the funnel: lines out of the sphere's right side into one point at the decision */
    if (G.out) {
      const f = G.out;
      for (let k = -5; k <= 5; k++) {
        const a = k / 5 * 0.8;
        c.strokeStyle = 'rgba(93,242,255,' + (0.07 + 0.05 * (1 - Math.abs(k) / 5)).toFixed(3) + ')';
        c.beginPath(); c.moveTo(G.cx + Math.cos(a) * G.r * 1.05, G.cy + Math.sin(a) * G.r * 1.05); c.lineTo(f.x1 - 22, f.y1); c.stroke();
      }
      c.strokeStyle = S.decision ? 'rgba(93,242,255,0.55)' : 'rgba(93,242,255,0.2)'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(f.x1 - 22, f.y1); c.lineTo(f.x1, f.y1); c.stroke();
    }
    return L;
  }

  /* ---------------- one frame at time t (ms) */
  function draw(t) {
    if (!ctx || !S.w || !S.h) return;
    S.frames++;
    const L = staticLayer();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (L) ctx.drawImage(L, 0, 0);
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    const fired = S.fireAt && Date.now() - S.fireAt < FIRE_MS ? 1 - (Date.now() - S.fireAt) / FIRE_MS : 0;
    /* the identity-disc rings: broken arcs turning slowly, two ways */
    const rings = [[1.18, 0.00011, 5, 0.42], [1.3, -0.00007, 3, 0.3], [1.42, 0.00004, 8, 0.18]];
    ctx.lineWidth = 2;
    rings.forEach(([k, sp, n, al], ri) => {
      const rr = G.r * k, a0 = t * sp, seg = Math.PI * 2 / n;
      ctx.strokeStyle = 'rgba(93,242,255,' + al + ')';
      ctx.beginPath();
      for (let i = 0; i < n; i++) { const a = a0 + i * seg; ctx.moveTo(G.cx + Math.cos(a) * rr, G.cy + Math.sin(a) * rr); ctx.arc(G.cx, G.cy, rr, a, a + seg * 0.62); }
      ctx.stroke();
      if (fired && ri === 0) { ctx.strokeStyle = ORANGE; ctx.globalAlpha = fired; ctx.beginPath(); ctx.arc(G.cx, G.cy, rr, a0 - 0.5, a0 + 0.5); ctx.stroke(); ctx.globalAlpha = 1; }
    });
    /* the point cloud: turning about its upright axis, tilted toward the viewer; nearer points brighter */
    const ay = t * 0.00016, cy = Math.cos(ay), sy = Math.sin(ay), tx = 0.38, cxr = Math.cos(tx), sxr = Math.sin(tx);
    const buckets = [[], [], []];
    for (let i = 0; i < N_POINTS; i++) {
      const x = SPHERE[i * 3], y = SPHERE[i * 3 + 1], z = SPHERE[i * 3 + 2];
      const x1 = x * cy + z * sy, z1 = -x * sy + z * cy, y2 = y * cxr - z1 * sxr, z2 = y * sxr + z1 * cxr;
      buckets[z2 > 0.35 ? 2 : z2 > -0.35 ? 1 : 0].push(G.cx + x1 * G.r, G.cy + y2 * G.r);
    }
    const style = ['rgba(93,242,255,0.22)', 'rgba(93,242,255,0.5)', 'rgba(232,254,255,0.9)'];
    buckets.forEach((b, k) => { ctx.fillStyle = style[k]; const s = k === 2 ? 2 : 1.5; for (let i = 0; i < b.length; i += 2) ctx.fillRect(b[i] - s / 2, b[i + 1] - s / 2, s, s); });
    /* the particles: each step with words today flows into the sphere, the step now fastest */
    G.feeds.forEach((pts, i) => {
      const s = S.steps[i] || {};
      if (!pts || !s.lit) return;
      const n = s.now ? 6 : 3, period = s.now ? 2600 : 4200;
      ctx.fillStyle = s.color || CYAN;
      for (let j = 0; j < n; j++) {
        const u = ((t / period) + j / n + i * 0.13) % 1, p = pts[Math.min(40, Math.floor(u * 40))];
        ctx.globalAlpha = 0.35 + 0.65 * u; ctx.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3);
      }
    });
    ctx.globalAlpha = 1;
    /* the beam into the decision: cyan dashes while there is one; orange only for a plan that just fired */
    if (G.out && (S.decision || fired)) {
      const f = G.out;
      ctx.lineWidth = fired ? 2 : 1.25;
      ctx.strokeStyle = fired ? ORANGE : HOT;
      ctx.globalAlpha = fired ? Math.max(0.35, fired) : 0.5;
      ctx.setLineDash([6, 10]); ctx.lineDashOffset = -t * 0.03;
      ctx.beginPath(); ctx.moveTo(f.x0, f.y0); ctx.lineTo(f.x1 - 22, f.y1); ctx.lineTo(f.x1, f.y1); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
  }

  /* ---------------- the loop: 30 frames a second at most, none while paused */
  function loop(ts) {
    raf = 0;
    if (!moving()) { still(); return; }
    if (ts - last >= FRAME_MS - 2) { last = ts; draw(ts); }
    raf = win.requestAnimationFrame(loop);
  }
  function start() { if (!raf && win && typeof win.requestAnimationFrame === 'function' && moving()) raf = win.requestAnimationFrame(loop); }
  function stop() { if (raf && win) win.cancelAnimationFrame(raf); raf = 0; }
  /* paused: one still frame, drawn again only when what it shows changes (and once when an orange beam ends) */
  function still() {
    stop();
    clearTimeout(stillTimer); stillTimer = 0;
    if (dead || !ctx || !S.w || !S.h || !S.shown) return;
    draw(S.still || (S.still = now()));
    const left = S.fireAt ? FIRE_MS - (Date.now() - S.fireAt) : 0;
    if (left > 0) stillTimer = setTimeout(still, left + 20);
  }
  function update() { if (moving()) start(); else still(); }

  const ro = typeof ResizeObserver === 'function' && canvas ? new ResizeObserver(() => measure()) : null;
  if (ro) ro.observe(canvas);
  const onVis = () => update();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  const onReduce = () => update();
  if (reducedMq) { if (reducedMq.addEventListener) reducedMq.addEventListener('change', onReduce); else if (reducedMq.addListener) reducedMq.addListener(onReduce); }

  return {
    /** what to draw: steps [{ color, lit, now }], decision (bool), motion ('full' or 'off'), shown (the tab is shown) */
    set(x) {
      const v = x || {}, before = JSON.stringify([S.steps, S.decision, S.motion, S.shown]);
      if (Array.isArray(v.steps)) S.steps = v.steps.map(s => ({ color: String(s.color || CYAN), lit: !!s.lit, now: !!s.now }));
      if ('decision' in v) S.decision = !!v.decision;
      if ('motion' in v) S.motion = v.motion === 'off' ? 'off' : 'full';
      if ('shown' in v) S.shown = !!v.shown;
      if (!S.w) return;                        // no size (the tab closed, the chart maximized): its ResizeObserver measures when it has one
      /* nothing new to draw: only make sure the loop runs exactly when it should (a missed reduced-motion change, say) */
      if (JSON.stringify([S.steps, S.decision, S.motion, S.shown]) === before) { if (moving() !== !!raf) update(); return; }
      update();
    },
    /** a plan fired (an agentPlan message, at its time): the orange beam and segment for a few seconds */
    fire(at) { S.fireAt = Date.now(); update(); },
    /** the words moved (a new layout): measure again */
    layout: () => measure(),
    /** read only, for the tests */
    state: () => ({ running: !!raf, moving: moving(), dpr: S.dpr, fps: FPS, frames: S.frames, w: S.w, h: S.h, fired: !!(S.fireAt && Date.now() - S.fireAt < FIRE_MS) }),
    destroy() {
      dead = true; stop(); clearTimeout(stillTimer);
      if (ro) ro.disconnect();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
      if (reducedMq) { if (reducedMq.removeEventListener) reducedMq.removeEventListener('change', onReduce); else if (reducedMq.removeListener) reducedMq.removeListener(onReduce); }
    },
  };
}

const api = { create, FPS, MAX_DPR, FIRE_MS };
if (typeof window !== 'undefined') window.AgentGrid = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
