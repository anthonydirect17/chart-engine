// The motion kit (live/motion.js, docs/MOTION.md): curves, windows, number formatting, the one clock, finish on
// input, reduced motion, no frame scheduled while idle, order surfaces left alone. A fake clock, a fake
// requestAnimationFrame and a tiny fake DOM; no browser.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../live/motion.js');

// ---- a fake clock and requestAnimationFrame
function fakeClock() {
  let t = 1000, q = [];
  const c = {
    raf(fn) { q.push(fn); c.scheduled++; return q.length; },
    now: () => t,
    scheduled: 0,
    pending: () => q.length,
    frame(ms = 16) { t += ms; const run = q; q = []; for (const fn of run) fn(t); },
    run(ms, step = 16) { for (let e = 0; e < ms; e += step) c.frame(step); },
  };
  return c;
}

// ---- a tiny fake DOM: just what the kit reads and writes
function matches(el, sel) {
  return sel.split(',').map(s => s.trim()).some(s => {
    let m;
    if ((m = /^\[class\^="([^"]+)"\]$/.exec(s))) return (el.attrs.class || '').startsWith(m[1]);
    if ((m = /^\[class\*="([^"]+)"\]$/.exec(s))) return (el.attrs.class || '').includes(m[1]);
    if ((m = /^\[([a-z-]+)\]$/.exec(s))) return m[1] in el.attrs;
    if ((m = /^\.([a-z0-9-]+)$/i.exec(s))) return (el.attrs.class || '').split(/\s+/).includes(m[1]);
    return el.tagName === s.toUpperCase();
  });
}
class El {
  constructor(tag, attrs = {}, text = '') {
    this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = []; this.parent = null;
    this.style = {}; this.textContent = text; this.listeners = []; this.isConnected = true; this.writes = 0;
    const self = this;
    this.classList = { contains: c => (self.attrs.class || '').split(/\s+/).includes(c),
      toggle(c, on) { const s = new Set((self.attrs.class || '').split(/\s+/).filter(Boolean)); on ? s.add(c) : s.delete(c); self.attrs.class = [...s].join(' '); } };
    // count style writes, to check nothing is written twice
    this.style = new Proxy({}, { set(o, k, v) { self.writes++; o[k] = v; return true; } });
  }
  add(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } return this; }
  getAttribute(a) { return a in this.attrs ? this.attrs[a] : null; }
  hasAttribute(a) { return a in this.attrs; }
  setAttribute(a, v) { this.attrs[a] = String(v); }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
  querySelectorAll(sel) { return this.descendants().filter(e => matches(e, sel)); }
  closest(sel) { for (let e = this; e; e = e.parent) if (matches(e, sel)) return e; return null; }
  addEventListener(type, fn, o) { this.listeners.push({ type, fn, o }); }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter(l => !(l.type === type && l.fn === fn)); }
  fire(type, ev = {}) { for (const l of [...this.listeners]) if (l.type === type) l.fn(ev); }
}
function fakeDoc() { const d = new El('#document'); d.documentElement = new El('html'); return d; }
function memStore(init = {}) { const m = { ...init }; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; }, m }; }
function kit(o = {}) {
  const clock = o.clock || fakeClock(), document = o.document || fakeDoc();
  const mq = { matches: !!o.osReduced, addEventListener() {} };
  const K = M.create({ raf: clock.raf, now: clock.now, document, storage: o.storage || memStore(), matchMedia: () => mq });
  return { K, clock, document, mq };
}
// a panel like the mockup's: a header, two rows, a count, a bar, a stamp, a canvas
function panel() {
  const root = new El('div', { class: 'card' });
  const head = new El('div', { 'data-in': '0,.3' }, 'Bot panel');
  const row = new El('div', { 'data-in': '.2,.5' });
  const num = new El('span', { 'data-count': '1284.5', 'data-dec': '2', 'data-sign': '', 'data-pre': '$', 'data-in': '.3,.8' }, '+$1,284.50');
  const bar = new El('i', { 'data-grow': '.2,.6' });
  bar.style.width = '40%';
  const stamp = new El('span', { class: 'stamp' }, 'L2 Ready');
  const canvas = new El('canvas', { 'data-in': '.1,.9' });
  canvas.drawn = []; canvas._draw = p => canvas.drawn.push(p);
  root.add(head, row.add(num, bar), stamp, canvas);
  return { root, head, row, num, bar, stamp, canvas };
}
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, a + ' != ' + b);
const atRest = el => ['opacity', 'translate', 'scale'].every(k => !el.style[k]);

test('the four curves start at 0, end at 1 and keep their shape; back overshoots a little', () => {
  for (const k of ['out', 'inOut', 'in', 'back']) { close(M.ease[k](0), 0); close(M.ease[k](1), 1); }
  assert.deepStrictEqual(Object.keys(M.ease).sort(), ['back', 'in', 'inOut', 'out']);
  assert.ok(M.ease.out(0.25) > 0.25 && M.ease.in(0.25) < 0.25, 'out leads, in lags');
  close(M.ease.inOut(0.5), 0.5);
  const peak = Math.max(...Array.from({ length: 101 }, (_, i) => M.ease.back(i / 100)));
  assert.ok(peak > 1.02 && peak < 1.12, 'back peaks slightly over 1 (c1 = 1.4): ' + peak);
  for (let i = 1; i <= 100; i++) assert.ok(M.ease.out(i / 100) >= M.ease.out((i - 1) / 100), 'out never goes back');
});

test('seg: where p is inside a window, as 0..1', () => {
  close(M.seg(0.1, 0.2, 0.6), 0); close(M.seg(0.4, 0.2, 0.6), 0.5); close(M.seg(0.9, 0.2, 0.6), 1);
  close(M.seg(0.5, 0.5, 0.5), 1); close(M.seg(0.4, 0.5, 0.5), 0);   // an empty window is a step, never NaN
});

test('stagger: overlapping windows from start, step and span, kept inside 0..1, written to data attributes', () => {
  assert.deepStrictEqual(M.stagger(3, { start: 0.1, step: 0.05, span: 0.3 }), [[0.1, 0.4], [0.15, 0.45], [0.2, 0.5]]);
  const w = M.stagger(5, { start: 0.5, step: 0.2, span: 0.3 });
  for (const [a, b] of w) assert.ok(a >= 0 && b <= 1 && a <= b, a + ',' + b);
  assert.deepStrictEqual(w[4], [0.7, 1]);
  const els = [new El('div'), new El('div')];
  M.stagger(els, { attr: 'in' });
  assert.deepStrictEqual(els.map(e => e.getAttribute('data-in')), ['0,0.3', '0.04,0.34']);
  assert.deepStrictEqual(M.stagger(0), []);
});

test('formatNumber: grouping, decimals, sign before prefix, no sign on zero', () => {
  assert.strictEqual(M.formatNumber(1284.5, { dec: 2, prefix: '$', sign: true }), '+$1,284.50');
  assert.strictEqual(M.formatNumber(-1284.5, { dec: 2, prefix: '$' }), '-$1,284.50');
  assert.strictEqual(M.formatNumber(6.2, { dec: 1, suffix: ' R', sign: true }), '+6.2 R');
  assert.strictEqual(M.formatNumber(-0.004, { dec: 2, sign: true }), '0.00');
  assert.strictEqual(M.formatNumber(1234567), '1,234,567');
  assert.strictEqual(M.formatNumber(1234567, { group: false }), '1234567');
  assert.strictEqual(M.formatNumber(NaN), '0');
});

test('a scene: start states only when it begins, one clock to the end, everything put back exactly', () => {
  const { K, clock } = kit();
  const P = panel();
  assert.ok(atRest(P.head) && atRest(P.stamp), 'complete at rest before any scene');
  const run = K.scene(P.root, { ms: 1000 });
  assert.strictEqual(P.head.style.opacity, '0');
  assert.strictEqual(P.head.style.translate, '0px 12.00px');
  assert.strictEqual(P.bar.style.scale, '0.0000 1');
  assert.strictEqual(P.num.textContent, '$0.00');
  assert.strictEqual(P.stamp.style.opacity, '0');
  assert.strictEqual(P.canvas.drawn.at(-1), 0);
  clock.run(400);
  assert.ok(atRest(P.head), 'the header window (0 to .3) is over');
  assert.ok(+P.row.style.opacity > 0 && +P.row.style.opacity < 1, 'the row is arriving');
  assert.ok(!run.done());
  clock.run(700);
  assert.ok(run.done());
  assert.ok([P.head, P.row, P.bar, P.stamp].every(atRest));
  assert.strictEqual(P.bar.style.width, '40%', 'the bar keeps its own inline width');
  assert.strictEqual(P.num.textContent, '+$1,284.50', 'the number ends on its own text');
  assert.strictEqual(P.canvas.drawn.at(-1), 1);
  assert.strictEqual(K.running(), 0);
});

test('one clock: seek, pause, step back and play draw the same frames', () => {
  const { K, clock } = kit();
  const A = panel(), B = panel();
  const ra = K.scene(A.root, { ms: 1000 });
  clock.run(480);
  const p = ra.progress();
  const rb = K.scene(B.root, { ms: 1000 });
  rb.seek(p);
  assert.strictEqual(B.row.style.opacity, A.row.style.opacity);
  assert.strictEqual(B.num.textContent, A.num.textContent);
  rb.seek(0.2);   // step back
  const back = B.row.style.opacity;
  assert.ok(+back < +A.row.style.opacity || back === '0');
  clock.run(300);
  assert.strictEqual(rb.progress(), 0.2, 'a paused scene stays put');
  rb.play(); clock.run(100);
  assert.ok(rb.progress() > 0.2);
  ra(); rb();
});

test('a frame step is capped at 50 ms (a stalled tab does not jump to the end)', () => {
  const { K, clock } = kit();
  const run = K.timeline(() => {}, { ms: 1000 });
  clock.frame(16); clock.frame(5000);
  close(run.progress(), 0.05);
  run();
});

test('R4: a pointerdown in the scene or any keydown finishes it at once, and the event is left alone', () => {
  const { K, clock, document } = kit();
  const P = panel();
  const run = K.scene(P.root, { ms: 1000 });
  clock.run(100);
  const l = P.root.listeners.find(x => x.type === 'pointerdown');
  assert.ok(l && l.o.capture && l.o.passive, 'capture and passive: it can never cancel the click');
  let prevented = false, stopped = false;
  P.root.fire('pointerdown', { preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.ok(run.done() && [P.head, P.row, P.stamp].every(atRest));
  assert.strictEqual(P.num.textContent, '+$1,284.50');
  assert.ok(!prevented && !stopped);
  assert.strictEqual(P.root.listeners.length, 0, 'listeners go with the scene');
  assert.strictEqual(document.listeners.length, 0);
  const Q = panel();
  const r2 = K.scene(Q.root, { ms: 1000 });
  clock.run(50);
  document.fire('keydown', {});
  assert.ok(r2.done() && atRest(Q.head));
});

test('M8: reduced motion (system or page setting) shows the final state at once, with no start state written', () => {
  for (const how of ['os', 'page', 'stored']) {
    const store = memStore(how === 'stored' ? { [M.STORAGE_KEY]: '1' } : {});
    const { K, clock, document } = kit({ osReduced: how === 'os', storage: store });
    if (how === 'page') assert.strictEqual(K.setReducedMotion(true), true);
    assert.ok(K.reduced(), how);
    const P = panel();
    const run = K.scene(P.root, { ms: 1000 });
    assert.ok(run.done(), how);
    assert.ok([P.head, P.row, P.bar, P.stamp].every(atRest), how);
    assert.strictEqual(P.head.writes, 0, how + ': nothing was hidden, not even for a moment');
    assert.strictEqual(P.num.textContent, '+$1,284.50');
    assert.strictEqual(P.canvas.drawn.join(), '1', 'the canvas draws its final frame once');
    assert.strictEqual(clock.pending(), 0, 'no frame scheduled');
    if (how !== 'os') assert.ok(document.documentElement.classList.contains('motion-off'), 'CSS tokens to 0');
    if (how === 'page') assert.strictEqual(store.m[M.STORAGE_KEY], '1', 'saved');
  }
});

test('M8: turning motion off mid scene finishes it; turning it back on clears the setting', () => {
  const store = memStore();
  const { K, clock, document } = kit({ storage: store });
  const P = panel();
  const run = K.scene(P.root, { ms: 1000 });
  clock.run(100);
  K.setReducedMotion(true);
  assert.ok(run.done() && atRest(P.row));
  K.setReducedMotion(false);
  assert.ok(!K.reduced());
  assert.ok(!(M.STORAGE_KEY in store.m));
  assert.ok(!document.documentElement.classList.contains('motion-off'));
});

test('M7: no frame is scheduled while idle; one loop serves every scene; writes only on change', () => {
  const { K, clock } = kit();
  assert.strictEqual(clock.scheduled, 0, 'loading the kit schedules nothing');
  const A = panel(), B = panel();
  K.scene(A.root, { ms: 300 }); K.scene(B.root, { ms: 300 });
  assert.strictEqual(clock.pending(), 1, 'two scenes, one frame request');
  clock.run(400);
  assert.strictEqual(K.running(), 0);
  const n = clock.scheduled;
  clock.run(1000);
  assert.strictEqual(clock.scheduled, n, 'nothing runs once every scene is still');
  // the header's window ends at .3: after it, its style is never written again
  const C = panel();
  K.scene(C.root, { ms: 1000 });
  clock.run(320);
  const w = C.head.writes;
  clock.run(400);
  assert.strictEqual(C.head.writes, w);
  // setText writes only when the text changed
  const el = new El('span', {}, '12');
  assert.strictEqual(K.setText(el, 12), false);
  assert.strictEqual(K.setText(el, 13), true);
  assert.strictEqual(el.textContent, '13');
});

test('countTo: counts on the shared clock to the formatted value', () => {
  const { K, clock } = kit();
  const el = new El('span', {}, '');
  const run = K.countTo(el, 188, { ms: 400 });
  assert.strictEqual(el.textContent, '0');
  clock.run(200);
  assert.ok(+el.textContent > 0 && +el.textContent < 188);
  clock.run(300);
  assert.ok(run.done());
  assert.strictEqual(el.textContent, '188');
  const neg = new El('span');
  K.countTo(neg, -42.5, { dec: 1, prefix: '$', ms: 100 })();
  assert.strictEqual(neg.textContent, '-$42.5');
});

test('R3 and R5: a scene on the chart, a ticket, Flatten or data-no-motion is never animated', () => {
  const { K, clock } = kit();
  for (const attrs of [{ class: 'chart-live' }, { 'data-no-motion': '' }, { class: 'ws-flat' }, { class: 'tk-row tk-acct' }]) {
    const host = new El('div', attrs);
    const P = panel();
    host.add(P.root);
    const run = K.scene(P.root, { ms: 1000 });
    assert.ok(run.done(), JSON.stringify(attrs));
    assert.strictEqual(P.head.writes + P.stamp.writes, 0, JSON.stringify(attrs));
    assert.strictEqual(P.canvas.drawn.length, 0, 'not even a canvas is touched');
  }
  // pieces inside a data-no-motion part of a scene are left alone, the rest plays
  const P = panel();
  P.row.setAttribute('data-no-motion', '');
  K.scene(P.root, { ms: 1000 });
  assert.strictEqual(P.head.style.opacity, '0');
  assert.strictEqual(P.row.writes + P.num.writes + P.bar.writes, 1, 'only the bar width set by panel()');
  assert.strictEqual(P.num.textContent, '+$1,284.50');
  clock.run(1100);
  // the kit names nothing from the chart engine and never hooks into it
  const src = fs.readFileSync(path.join(__dirname, '..', 'live', 'motion.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/ChartEngine|ChartLive|TradeCore|OrderTicket|ChartFeed/.test(src));
});

test('a new scene on the same root finishes the old one; a removed root finishes its scene', () => {
  const { K, clock } = kit();
  const P = panel();
  const r1 = K.scene(P.root, { ms: 1000 });
  clock.run(100);
  const r2 = K.scene(P.root, { ms: 1000 });
  assert.ok(r1.done() && !r2.done());
  P.root.isConnected = false;
  clock.frame(16);
  assert.ok(r2.done() && atRest(P.head));
  assert.strictEqual(K.running(), 0);
});

test('fitCanvas: device pixels capped at 2, resized only when the size changes', () => {
  let sets = 0;
  const c = { _w: 0, _h: 0, getBoundingClientRect: () => ({ width: 200, height: 80 }),
    get width() { return this._w; }, set width(v) { sets++; this._w = v; },
    get height() { return this._h; }, set height(v) { sets++; this._h = v; },
    getContext: () => ({ setTransform() {} }) };
  const r = M.fitCanvas(c, 3);
  assert.deepStrictEqual([r.w, r.h, r.dpr, c.width, c.height], [200, 80, 2, 400, 160]);
  M.fitCanvas(c, 3);
  assert.strictEqual(sets, 2);
});

test('motion.css: the tokens, reduced motion to 0, nothing hidden at rest', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'live', 'motion.css'), 'utf8');
  assert.match(css, /--motion-fast: 150ms/); assert.match(css, /--motion-base: 250ms/); assert.match(css, /--motion-slow: 400ms/);
  assert.match(css, /prefers-reduced-motion: reduce\)\s*{\s*:root { --motion-fast: 0ms; --motion-base: 0ms; --motion-slow: 0ms; }/);
  assert.match(css, /:root\.motion-off { --motion-fast: 0ms; --motion-base: 0ms; --motion-slow: 0ms; }/);
  // opacity 0 only behind .motion-out, which a page adds itself
  for (const m of css.matchAll(/([^{}]+){[^}]*opacity:\s*0[;\s]/g)) assert.match(m[1], /\.motion-out/);
  assert.ok(!/display:\s*none|visibility:\s*hidden/.test(css));
});
