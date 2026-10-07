/*
 * ChartMotion: the shared motion kit for the chart page's panels, The Desk and the Markup Studio (docs/MOTION.md).
 * One dependency-free file. Load it as a plain <script> (it sets window.ChartMotion), from an ES module
 * (`import './motion.js'` then `window.ChartMotion`), or from Node (`require('./live/motion.js')`, for the tests).
 *
 * NEVER ON ORDER SURFACES (R3): no motion on the order ticket, the chart's order lines and drags, fills, Flatten,
 * position and P&L figures, the copier, Accounts warnings or any live trading panel. The kit has no hook into the
 * chart engine and never runs inside the chart's draw loop (R5): it only touches DOM panels and its own small
 * canvases. A scene whose root is inside `.chart-live`, a ticket (`tk-*`), Flatten (`.ws-flat`) or any element marked
 * `data-no-motion` is shown in its final state at once, and pieces inside such an element are left alone.
 *
 * The motion language:
 *   M1 One clock. A scene is drawn from (scene, progress 0..1). Pause, scrub, step back and reduced motion all call the
 *      same drawing: reduced motion simply draws progress 1.
 *   M2 Staggered arrivals. Each piece has its own window [a, b] of the scene's time; windows overlap (stagger()).
 *   M3 Four curves: ease.out (arrivals), ease.inOut (moves), ease.in (exits), ease.back (stamps only, c1 = 1.4).
 *   M4 Numbers count up to their value (formatNumber: sign, prefix, decimals, grouping; tabular digits in motion.css).
 *   M5 Tokens: fast 150 ms, base 250 ms, slow 400 ms (motion.css has them as --motion-fast/base/slow).
 *   M7 Cheap. One requestAnimationFrame loop for every running scene, scheduled only while something moves; a frame
 *      step is capped at 50 ms; canvases at 2x device pixels; a style or text is written only when it changes.
 *   M8 Reduced motion: the system setting (prefers-reduced-motion) or the page setting (setReducedMotion, saved under
 *      the storage key below) shows every scene in its final state at once.
 *   R4 Never blocks input. A pointerdown inside a running scene's root, or any keydown, finishes the scene at once;
 *      the kit never stops or cancels the event, so the click or key still acts.
 *   At rest every element is complete: nothing is hidden by CSS. Start states are written only when a scene begins,
 *   and the end restores each element's own inline styles and text exactly.
 *
 * Markup a scene reads (the root itself and everything under it):
 *   data-in="a,b"      rises in (opacity 0 to 1, moved down data-rise px, default 12, to 0) over [a, b], ease.out
 *   data-grow="a,b"    a bar grows (scaleX 0 to 1) over [a, b], ease.inOut (motion.css sets transform-origin left)
 *   data-count="1284.5" counts up over its data-in window (default 0,1), ease.out; data-dec, data-sign, data-pre /
 *                      data-prefix, data-suf / data-suffix, data-from. The element's own text is put back at the end.
 *   .stamp, data-stamp="a,b"  lands big and settles with ease.back (default window .12,.42)
 *   canvas._draw(p)    a canvas with a _draw function is drawn with its data-in window (default 0,1), ease.inOut
 *
 *   const run = ChartMotion.scene(panelEl, { ms: 1100 });   // run() finishes it; run.seek(p), run.pause(), run.play()
 *
 * Transforms use the separate CSS properties `translate` and `scale`, so a piece's own `transform` (the stamp's
 * rotation, for one) is never overwritten.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.ChartMotion = factory(root);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (glob) {
'use strict';

const VERSION = '1.0.0';
const STORAGE_KEY = 'motion-reduced-v1';
const MS = Object.freeze({ fast: 150, base: 250, slow: 400, scene: 1100 });
const DT_CAP = 50;
const DPR_CAP = 2;
const NO_MOTION = '.chart-live, [data-no-motion], .ws-flat, [class^="tk-"], [class*=" tk-"]';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
/** Where p is inside the window [a, b], as 0..1 (0 before it, 1 after it). */
const seg = (p, a, b) => (b <= a ? (p >= b ? 1 : 0) : clamp((p - a) / (b - a), 0, 1));
const lerp = (a, b, t) => a + (b - a) * t;

/** The four curves (M3). back is for stamps only. */
const ease = Object.freeze({
  out: t => 1 - Math.pow(1 - t, 3),
  inOut: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  in: t => t * t * t,
  back: t => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
});

/** Windows for a list of pieces (M2): piece i gets [start + i * step, start + i * step + span], kept inside 0..1.
 *  `list` is a count or an array; with an array of elements and `attr` ('in', 'grow' or 'stamp') each element's
 *  data-<attr> is set to its window. Returns the windows. */
function stagger(list, o) {
  o = o || {};
  const start = o.start == null ? 0 : +o.start, step = o.step == null ? 0.04 : +o.step, span = o.span == null ? 0.3 : +o.span;
  const n = typeof list === 'number' ? list : (list ? list.length : 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    let a = start + i * step, b = a + span;
    if (b > 1) { a = Math.max(0, a - (b - 1)); b = 1; }
    a = clamp(a, 0, 1);
    const w = [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000];
    out.push(w);
    if (o.attr && typeof list !== 'number' && list[i] && list[i].setAttribute) list[i].setAttribute('data-' + o.attr, w[0] + ',' + w[1]);
  }
  return out;
}

/** A number as the page shows it: grouped thousands, `dec` decimals, '+' when sign and above zero, '-' before the
 *  prefix (-$1,284.50). Zero after rounding never gets a sign. */
function formatNumber(v, o) {
  o = o || {};
  const dec = clamp(Math.round(+o.dec || 0), 0, 10);
  let n = +v;
  if (!isFinite(n)) n = 0;
  let s = Math.abs(n).toFixed(dec);
  const zero = +s === 0;
  const dot = s.indexOf('.');
  let int = dot < 0 ? s : s.slice(0, dot);
  const frac = dot < 0 ? '' : s.slice(dot);
  if (o.group !== false) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = zero ? '' : n < 0 ? '-' : o.sign ? '+' : '';
  return sign + (o.prefix || '') + int + frac + (o.suffix || '');
}

/** Builds a kit on its own clock and page (the tests pass fakes); the exported one uses the browser's. */
function create(env) {
  env = env || {};
  const raf = env.raf || (glob && glob.requestAnimationFrame ? glob.requestAnimationFrame.bind(glob) : null);
  const now = env.now || (() => (glob && glob.performance ? glob.performance.now() : Date.now()));
  const doc = env.document !== undefined ? env.document : (glob && glob.document) || null;
  const storage = () => { try { return env.storage !== undefined ? env.storage : (glob && glob.localStorage) || null; } catch (e) { return null; } };
  const mq = (() => {
    try {
      const mm = env.matchMedia || (glob && glob.matchMedia ? glob.matchMedia.bind(glob) : null);
      return mm ? mm('(prefers-reduced-motion: reduce)') : null;
    } catch (e) { return null; }
  })();

  let pageSetting = null;   // true or false once read or set
  const running = new Set();
  const byRoot = typeof WeakMap === 'function' ? new WeakMap() : null;
  let scheduled = false, last = 0;

  function readSetting() {
    if (pageSetting !== null) return pageSetting;
    try { const s = storage(); pageSetting = !!(s && s.getItem(STORAGE_KEY) === '1'); } catch (e) { pageSetting = false; }
    return pageSetting;
  }
  function markRoot(on) {
    try { if (doc && doc.documentElement && doc.documentElement.classList) doc.documentElement.classList.toggle('motion-off', !!on); } catch (e) { /* no page */ }
  }

  /** True while motion is off: the system's reduced motion or the page setting (M8). */
  function reduced() { return !!(mq && mq.matches) || readSetting(); }

  /** The page setting (M8): true shows every scene in its final state and sets the CSS tokens to 0 (class
   *  motion-off on <html>). Saved in localStorage under STORAGE_KEY unless { save: false }. Running scenes finish. */
  function setReducedMotion(on, o) {
    pageSetting = !!on;
    if (!o || o.save !== false) {
      try { const s = storage(); if (s) { if (pageSetting) s.setItem(STORAGE_KEY, '1'); else s.removeItem(STORAGE_KEY); } } catch (e) { /* storage blocked */ }
    }
    markRoot(pageSetting);
    if (reduced()) for (const r of [...running]) r.finish();
    return reduced();
  }

  if (readSetting()) markRoot(true);
  if (mq && typeof mq.addEventListener === 'function') {
    try { mq.addEventListener('change', () => { if (reduced()) for (const r of [...running]) r.finish(); }); } catch (e) { /* old browser */ }
  }

  // ---- the one clock (M1, M7): one rAF loop for every running timeline, only while one runs
  function schedule() {
    if (scheduled || !raf || !running.size) return;
    scheduled = true;
    raf(loop);
  }
  function loop(t) {
    scheduled = false;
    const at = typeof t === 'number' ? t : now();
    const dt = last ? clamp(at - last, 0, DT_CAP) : 0;
    last = at;
    for (const r of [...running]) r._step(dt);
    if (running.size) schedule(); else last = 0;
  }

  /** A timeline: draw(p) with p from 0 to 1 over ms, on the shared clock. Returns run(), which finishes it (draws 1),
   *  with run.seek(p) (pauses there), run.pause(), run.play(), run.progress(), run.done(), run.cancel() (stops where
   *  it is, no final draw). onDone runs once, after the final draw. Reduced motion draws 1 at once. */
  function timeline(draw, o) {
    o = o || {};
    const ms = Math.max(1, +o.ms || MS.scene);
    let p = 0, paused = false, finished = false;
    const set = q => { p = clamp(q, 0, 1); draw(p); };
    // how: 'finish' (draw the end now), 'natural' (the end is drawn), 'cancel' (stop where it is)
    function end(how) {
      if (finished) return;
      finished = true;
      running.delete(api);
      if (how === 'finish') set(1);
      if (o.onEnd) o.onEnd();
      if (how !== 'cancel' && o.onDone) o.onDone();
    }
    const api = {
      _step(dt) {
        if (paused || finished) return;
        if (o.alive && !o.alive()) { end('finish'); return; }
        p = Math.min(1, p + dt / ms);
        draw(p);
        if (p >= 1) end('natural');
      },
      finish() { end('finish'); },
    };
    const run = () => api.finish();
    run.finish = run;
    run.seek = q => { if (finished) return; paused = true; set(q); };
    run.pause = () => { paused = true; };
    run.play = () => { if (finished) return; paused = false; schedule(); };
    run.progress = () => p;
    run.done = () => finished;
    run.cancel = () => end('cancel');
    running.add(api);
    if (reduced() || !raf || o.instant) { end('finish'); return run; }
    set(0);
    schedule();
    return run;
  }

  // ---- scenes
  const win = (el, name, d0, d1) => {
    const raw = el.getAttribute ? el.getAttribute('data-' + name) : null;
    if (raw == null || raw === '') return [d0, d1];
    const v = String(raw).split(',').map(Number);
    const a = isFinite(v[0]) ? v[0] : d0, b = isFinite(v[1]) ? v[1] : d1;
    return [clamp(a, 0, 1), clamp(Math.max(a, b), 0, 1)];
  };
  const has = (el, a) => !!(el.hasAttribute && el.hasAttribute(a));
  const closest = (el, sel) => { try { return el.closest ? el.closest(sel) : null; } catch (e) { return null; } };
  const isStamp = el => has(el, 'data-stamp') || !!(el.classList && el.classList.contains && el.classList.contains('stamp'));
  const flag = v => v != null && v !== 'false' && v !== '0';

  function collect(rootEl) {
    const all = [rootEl].concat(rootEl.querySelectorAll ? [...rootEl.querySelectorAll('[data-in], [data-grow], [data-count], [data-stamp], .stamp, canvas')] : []);
    const pieces = [];
    for (const el of all) {
      if (el !== rootEl && closest(el, '[data-no-motion]')) continue;
      if (has(el, 'data-count')) {
        const to = parseFloat(el.getAttribute('data-count'));
        if (isFinite(to)) {
          const g = k => el.getAttribute('data-' + k);
          pieces.push({ el, kind: 'count', w: win(el, 'in', 0, 1), to, from: parseFloat(g('from')) || 0,
            fmt: { dec: +g('dec') || 0, sign: flag(g('sign')), prefix: g('pre') || g('prefix') || '', suffix: g('suf') || g('suffix') || '' } });
        }
      } else if (has(el, 'data-in') && !(el.tagName === 'CANVAS' && typeof el._draw === 'function')) {
        pieces.push({ el, kind: 'rise', w: win(el, 'in', 0, 1), dy: has(el, 'data-rise') ? +el.getAttribute('data-rise') || 0 : 12 });
      }
      if (has(el, 'data-grow')) pieces.push({ el, kind: 'grow', w: win(el, 'grow', 0, 1) });
      if (isStamp(el)) pieces.push({ el, kind: 'stamp', w: win(el, 'stamp', 0.12, 0.42) });
      if (el.tagName === 'CANVAS' && typeof el._draw === 'function') pieces.push({ el, kind: 'draw', w: win(el, 'in', 0, 1) });
    }
    return pieces;
  }

  // the inline values a piece had before the scene, put back exactly at the end
  const PROPS = ['opacity', 'translate', 'scale'];
  function save(pc) {
    const st = pc.el.style || {};
    pc.rest = {};
    for (const k of PROPS) pc.rest[k] = st[k] == null ? '' : st[k];
    if (pc.kind === 'count') pc.restText = pc.el.textContent;
    pc.last = -1;   // the last q drawn, so nothing is written twice
  }
  function restore(pc) {
    if (!pc.dirty) return;   // never touched: nothing to put back
    pc.dirty = false;
    const st = pc.el.style;
    if (st) for (const k of PROPS) if (st[k] !== pc.rest[k]) st[k] = pc.rest[k];
    if (pc.kind === 'count' && pc.el.textContent !== pc.restText) pc.el.textContent = pc.restText;
  }
  function put(el, k, v) { if (el.style && el.style[k] !== v) el.style[k] = v; }

  function drawPiece(pc, p) {
    const q = seg(p, pc.w[0], pc.w[1]);
    if (pc.kind === 'draw') { if (q !== pc.last) { pc.last = q; pc.el._draw(ease.inOut(q)); } return; }
    if (q === pc.last) return;
    pc.last = q;
    if (q >= 1) { restore(pc); return; }
    pc.dirty = true;
    const el = pc.el;
    if (pc.kind === 'rise') {
      const e = ease.out(q);
      put(el, 'opacity', String(Math.round(e * 1000) / 1000));
      put(el, 'translate', '0px ' + ((1 - e) * pc.dy).toFixed(2) + 'px');
    } else if (pc.kind === 'grow') {
      put(el, 'scale', ease.inOut(q).toFixed(4) + ' 1');
    } else if (pc.kind === 'stamp') {
      const e = ease.back(q);
      put(el, 'opacity', String(Math.round(clamp(q * 2.2, 0, 1) * 1000) / 1000));
      put(el, 'scale', (1.9 - 0.9 * e).toFixed(3));
    } else if (pc.kind === 'count') {
      const txt = formatNumber(lerp(pc.from, pc.to, ease.out(q)), pc.fmt);
      if (el.textContent !== txt) el.textContent = txt;
    }
  }

  /** Plays a scene on rootEl's pieces (see the header). Returns run() (finishes it) with seek, pause, play,
   *  progress, done. Options: ms (default 1100), onDone. A scene already running on rootEl finishes first. */
  function scene(rootEl, o) {
    if (typeof o === 'number') o = { ms: o };
    o = o || {};
    if (!rootEl) return timeline(() => {}, { instant: true });
    const prev = byRoot && byRoot.get(rootEl);
    if (prev && !prev.done()) prev();
    // R3: a root on or inside an order surface or the chart is never touched
    const blocked = !!closest(rootEl, NO_MOTION);
    const pieces = blocked ? [] : collect(rootEl);
    for (const pc of pieces) save(pc);
    const draw = p => { for (const pc of pieces) drawPiece(pc, p); };
    const ownerDoc = rootEl.ownerDocument || doc;
    let run = null;
    const onInput = () => { if (run) run(); };
    const listen = on => {
      const m = on ? 'addEventListener' : 'removeEventListener';
      try { rootEl[m] && rootEl[m]('pointerdown', onInput, { capture: true, passive: true }); } catch (e) { /* not an element */ }
      try { ownerDoc && ownerDoc[m] && ownerDoc[m]('keydown', onInput, { capture: true, passive: true }); } catch (e) { /* no page */ }
    };
    const instant = blocked || !pieces.length;
    if (!instant && !reduced() && raf) listen(true);
    run = timeline(draw, {
      ms: o.ms || MS.scene,
      instant,
      alive: () => rootEl.isConnected !== false,
      onEnd: () => listen(false),
      onDone: o.onDone,
    });
    if (byRoot) byRoot.set(rootEl, run);
    return run;
  }

  /** Counts el up to `to` (M4) on the shared clock: { ms (default slow, 400), from, dec, sign, prefix, suffix }.
   *  The final text is the formatted value. Returns run(). */
  function countTo(el, to, o) {
    o = o || {};
    const from = +o.from || 0, f = { dec: o.dec, sign: o.sign, prefix: o.prefix, suffix: o.suffix, group: o.group };
    return timeline(p => setText(el, formatNumber(lerp(from, +to, ease.out(p)), f)), { ms: o.ms || MS.slow, onDone: o.onDone });
  }

  return {
    VERSION, MS, STORAGE_KEY, NO_MOTION, DT_CAP, DPR_CAP,
    ease, clamp, seg, lerp, stagger, formatNumber,
    scene, timeline, countTo, setText, fitCanvas,
    reduced, setReducedMotion,
    running: () => running.size,
    create,
  };
}

/** Writes text only when it changed (M7). Returns true when it wrote. */
function setText(el, text) {
  if (!el) return false;
  const t = String(text);
  if (el.textContent === t) return false;
  el.textContent = t;
  return true;
}

/** Sizes a canvas to its box at up to 2x device pixels (M7), resizing only when the size changed.
 *  Returns { ctx, w, h, dpr } with the context scaled to CSS pixels. */
function fitCanvas(c, dpr) {
  const r = c.getBoundingClientRect();
  const d = Math.min(dpr || (glob && glob.devicePixelRatio) || 1, DPR_CAP);
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  const W = Math.round(w * d), H = Math.round(h * d);
  if (c.width !== W) c.width = W;
  if (c.height !== H) c.height = H;
  const ctx = c.getContext('2d');
  if (ctx && ctx.setTransform) ctx.setTransform(d, 0, 0, d, 0, 0);
  return { ctx, w, h, dpr: d };
}

return create();
});
