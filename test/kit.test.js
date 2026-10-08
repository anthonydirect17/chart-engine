// The kit (live/kit.js, live/kit.css, live/kit.html, docs/KIT.md): the light's guards (Anthony's rules), the armed
// outline, the motion setting with storage that throws, reduced motion, the tokens against the chart's locked palette,
// contrast on the ground for every text token on every surface, no motion on numbers, chips or buttons (rule R3), and
// the files installed. A tiny fake page; no browser (test/kit-smoke.mjs has the browser).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const K = require('../live/kit.js');

// ---- a tiny fake page: just what the kit reads and writes
function matchOne(el, s) {
  let m;
  const cls = el.attrs.class || '';
  if ((m = /^\[class\^="([^"]+)"\]$/.exec(s))) return cls.startsWith(m[1]);
  if ((m = /^\[class\*="([^"]+)"\]$/.exec(s))) return cls.includes(m[1]);
  if ((m = /^\[([a-z-]+)\]$/.exec(s))) return m[1] in el.attrs;
  if ((m = /^\.([a-z0-9-]+)$/i.exec(s))) return cls.split(/\s+/).includes(m[1]);
  if (/^[a-z]+$/i.test(s)) return el.tagName === s.toUpperCase();
  throw new Error('the fake page cannot match ' + s);
}
const matches = (el, sel) => sel.split(',').map(s => s.trim()).some(s => matchOne(el, s));
class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = []; this.parentElement = null; this.ownerDocument = null;
    this.writes = 0;
    const self = this, props = {};
    this.style = { getPropertyValue: k => props[k] || '', setProperty: (k, v) => { self.writes++; props[k] = String(v); }, props };
    this.classList = {
      contains: c => (self.attrs.class || '').split(/\s+/).includes(c),
      toggle(c, on) { self.writes++; const s = new Set((self.attrs.class || '').split(/\s+/).filter(Boolean)); if (on === undefined) on = !s.has(c); on ? s.add(c) : s.delete(c); self.attrs.class = [...s].join(' '); return on; },
      add(c) { this.toggle(c, true); },
    };
  }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = v; }
  get firstChild() { return this.children[0] || null; }
  add(...kids) { for (const k of kids) { k.parentElement = this; k.ownerDocument = this.ownerDocument; this.children.push(k); } return this; }
  appendChild(k) { return this.add(k), k; }
  insertBefore(k, ref) { k.parentElement = this; const i = ref ? this.children.indexOf(ref) : -1; i < 0 ? this.children.push(k) : this.children.splice(i, 0, k); return k; }
  getAttribute(a) { return a in this.attrs ? this.attrs[a] : null; }
  setAttribute(a, v) { this.attrs[a] = String(v); }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
  querySelector(sel) { return this.descendants().find(e => matches(e, sel)) || null; }
  matches(sel) { return matches(this, sel); }
  closest(sel) { for (let e = this; e; e = e.parentElement) if (matches(e, sel)) return e; return null; }
}
function page() {
  const doc = { documentElement: new El('html'), createElement: t => { const e = new El(t); e.ownerDocument = doc; return e; } };
  const el = (tag, attrs, ...kids) => { const e = new El(tag, attrs); e.ownerDocument = doc; return e.add(...kids); };
  return { doc, el };
}
function quiet() { const notes = []; return { notes, console: { warn: m => notes.push(m) } }; }
function memStore(init = {}) { const m = { ...init }; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; }, m }; }
const layerCount = p => p.children.filter(c => c.classList.contains('kit-orbit') || c.classList.contains('kit-halo')).length;

test('Node: requiring the kit touches no page, schedules nothing, and has no per-frame code', () => {
  assert.strictEqual(typeof globalThis.document, 'undefined');
  assert.strictEqual(K.VERSION, '1.0.0');
  assert.strictEqual(K.STORAGE_KEY, 'kit-motion-v1');
  assert.deepStrictEqual(K.LAP, { decide: 13, trade: 9 });
  for (const f of ['light', 'armed', 'motion', 'setMotion', 'reduced', 'whyNoLight', 'contrast', 'create']) assert.strictEqual(typeof K[f], 'function', f);
  const src = read('live/kit.js').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/requestAnimationFrame|setInterval|setTimeout/.test(src), 'no per-frame or timed script: the light is pure CSS');
  assert.ok(!/ChartEngine|ChartLive|TradeCore|OrderTicket|ChartFeed/.test(src), 'no hook into the chart engine');
  assert.strictEqual(K.motion(), 'full', 'no storage in Node: motion is full');
});

test('L2: the light refuses on data-no-light, inside one, a ticket, Flatten and the copier; a chart panel in a trade lights', () => {
  const { el } = page();
  const q = quiet();
  const k = K.create({ console: q.console, storage: null });
  const trade = { on: true, color: 'profit', pace: 'trade' };
  const refused = {
    'data-no-light': el('section', { class: 'kit-panel', 'data-no-light': '' }),
    'inside data-no-light': (() => { const inner = el('div', { class: 'kit-panel' }); el('div', { 'data-no-light': '' }, inner); return inner; })(),
    'the ticket root (.tk)': el('div', { class: 'chart-live tk' }),
    'a ticket row (tk-row)': (() => { const r = el('div', { class: 'tk-row tk-acct' }); el('div', { class: 'ws-panel' }, r); return r; })(),
    'inside a ticket row': (() => { const b = el('div', { class: 'kit-panel' }); el('div', { class: 'tk-row' }, b); return b; })(),
    'Flatten (.ws-flat)': el('button', { class: 'ws-btn ws-flat' }),
    'the copier (data-copier)': el('div', { class: 'kit-panel', 'data-copier': '' }),
    'the copier table (.apg-cop-g)': el('div', { class: 'gr apg-g apg-cop-g' }),
    'inside the copier header': (() => { const s = el('span', { class: 'apg-arm on' }); el('div', { class: 'apg-cop-top' }, s); return s; })(),
    'inside the chart (an order line)': (() => { const l = el('div', { class: 'kit-panel' }); el('div', { class: 'chart-live' }, l); return l; })(),
    'a panel holding the ticket': el('section', { class: 'kit-panel' }, el('div', { class: 'chart-live tk' })),
    'a panel holding the copier': el('section', { class: 'kit-panel' }, el('div', { class: 'apg-cop-top' })),
    'a button': el('button', { class: 'kit-btn' }),
    'a chip': el('span', { class: 'kit-chip' }),
    'a number': el('span', { class: 'kit-num' }),
    'a big number': el('div', { class: 'kit-big' }),
  };
  for (const [name, p] of Object.entries(refused)) {
    assert.strictEqual(k.light(p, trade), false, name);
    assert.ok(!p.classList.contains('kit-lit'), name + ' is not lit');
    assert.strictEqual(layerCount(p), 0, name + ': no layer added');
    assert.ok(k.whyNoLight(p, 'trade'), name + ' has a reason');
  }
  assert.strictEqual(q.notes.length, Object.keys(refused).length, 'one console note each');
  assert.ok(q.notes.every(n => /^ChartKit: no light here\. /.test(n)));
  // the same refusal again is not noted twice
  k.light(refused['data-no-light'], trade);
  assert.strictEqual(q.notes.length, Object.keys(refused).length);

  // a chart panel in a trade lights, with its price line marked data-no-light inside it
  const chart = el('section', { class: 'kit-panel ws-panel' }, el('div', { class: 'kit-panel-head' }), el('div', { class: 'chart-host' }, el('div', { class: 'chart-live' }, el('div', { class: 'px', 'data-no-light': '' }))));
  assert.strictEqual(k.whyNoLight(chart, 'trade'), '');
  assert.strictEqual(k.light(chart, trade), true);
  assert.ok(chart.classList.contains('kit-lit') && chart.classList.contains('kit-pace-trade') && !chart.classList.contains('kit-pace-decide'));
  assert.strictEqual(chart.style.getPropertyValue('--kit-pc'), '#3ddc97', 'the colour goes on the custom property');
  assert.strictEqual(layerCount(chart), 2, 'an orbit and a halo');
  const [orbit, halo] = chart.children;
  assert.ok(orbit.classList.contains('kit-orbit') && halo.classList.contains('kit-halo') && halo.children[0].classList.contains('kit-orbit'));
  assert.strictEqual(orbit.getAttribute('aria-hidden'), 'true');
  // made once; the colour changes in place
  assert.strictEqual(k.light(chart, { on: true, color: 'loss', pace: 'trade' }), true);
  assert.strictEqual(layerCount(chart), 2, 'the layers are made once');
  assert.strictEqual(chart.style.getPropertyValue('--kit-pc'), '#ff7a7a');
  // the same call again writes nothing (cheap on every P&L update)
  const w = chart.writes;
  k.light(chart, { on: true, color: 'loss', pace: 'trade' });
  assert.strictEqual(chart.writes, w, 'nothing written when nothing changed');
  // off is never refused and keeps the layers for next time
  assert.strictEqual(k.light(chart, { on: false }), false);
  assert.ok(!chart.classList.contains('kit-lit') && !k.lit(chart));
  assert.strictEqual(layerCount(chart), 2);
  assert.strictEqual(k.light(refused['data-no-light'], { on: false }), false);
  assert.strictEqual(k.light(null, trade), false);
});

test('L1: outside the Agent tab the light runs only in a trade; on the Agent tab it may follow a decision', () => {
  const { el } = page();
  const q = quiet();
  const k = K.create({ console: q.console });
  const desk = el('section', { class: 'kit-card' });
  el('div', { class: 'kit kit-desk' }, desk);
  assert.strictEqual(k.light(desk, { on: true, color: 'screen' }), false, 'no pace: deciding, refused outside the Agent tab');
  assert.strictEqual(k.light(desk, { on: true, color: 'eyes', pace: 'decide' }), false);
  assert.match(q.notes.at(-1), /only while in a trade/);
  assert.strictEqual(k.light(desk, { on: true, color: 'profit', pace: 'trade' }), true, 'in a trade it lights');
  const agent = el('section', { class: 'kit-panel' });
  el('div', { class: 'kit kit-agent' }, el('div', {}, agent));
  for (const c of ['screen', 'eyes', 'judgment', 'checks', 'go', 'pass', 'danger', '#9b7bff']) {
    assert.strictEqual(k.light(agent, { on: true, color: c, pace: 'decide' }), true, c);
    assert.ok(agent.classList.contains('kit-pace-decide'));
  }
  assert.strictEqual(agent.style.getPropertyValue('--kit-pc'), '#9b7bff');
  // even on the Agent tab the order surfaces refuse
  const kill = el('div', { class: 'kit-panel', 'data-no-light': '' });
  el('div', { class: 'kit kit-agent' }, kill);
  assert.strictEqual(k.light(kill, { on: true, color: 'danger', pace: 'decide' }), false);
  // an unknown colour is refused, not guessed
  assert.strictEqual(k.light(agent, { on: true, color: 'chartreuse', pace: 'decide' }), false);
  assert.match(q.notes.at(-1), /Unknown colour/);
  assert.ok(!agent.classList.contains('kit-lit'));
});

test('the armed outline: on and off, and together with the light', () => {
  const { el } = page();
  const k = K.create({ console: quiet().console });
  const p = el('section', { class: 'kit-panel' });
  assert.strictEqual(k.armed(p, true), true);
  assert.ok(p.classList.contains('kit-armed'));
  assert.strictEqual(k.light(p, { on: true, color: 'profit', pace: 'trade' }), true);
  assert.ok(p.classList.contains('kit-armed') && p.classList.contains('kit-lit'), 'both at once');
  assert.strictEqual(k.armed(p, false), false);
  assert.ok(!p.classList.contains('kit-armed') && p.classList.contains('kit-lit'));
  const css = read('live/kit.css');
  assert.match(css, /\.kit \.kit-armed \{ border-color: var\(--kit-armed-line\); box-shadow: 0 0 22px -3px rgba\(123,92,255,\.55\), 0 0 8px -2px rgba\(182,156,255,\.35\), inset 0 0 18px -8px rgba\(123,92,255,\.30\); \}/);
  assert.match(css, /\.kit \.kit-armed\.kit-lit::after \{ content: ""; position: absolute; inset: -1px; pointer-events: none; border: 1px solid rgba\(155,123,255,\.50\);/, 'armed and lit: the purple ring is drawn over the light');
  // armed is trading truth: the panel, the card and the outline never fade
  for (const r of rules(css)) if (/kit-(panel|card|armed)\b/.test(r.sel) && !/kit-halo|kit-orbit/.test(r.sel)) assert.ok(!/transition|animation/.test(r.body), r.sel + ' has motion');
});

test('motion: full by default, off remembered under kit-motion-v1, and storage that throws never breaks it', () => {
  const { doc } = page();
  const store = memStore();
  const k = K.create({ document: doc, storage: store, matchMedia: () => ({ matches: false }) });
  assert.strictEqual(k.motion(), 'full');
  assert.strictEqual(k.reduced(), false);
  assert.strictEqual(k.setMotion('off'), 'off');
  assert.strictEqual(store.m['kit-motion-v1'], 'off');
  assert.ok(doc.documentElement.classList.contains('kit-motion-off'));
  assert.strictEqual(k.reduced(), true);
  // a new page reads it back
  const page2 = page();
  const k2 = K.create({ document: page2.doc, storage: store, matchMedia: () => ({ matches: false }) });
  assert.strictEqual(k2.motion(), 'off');
  k2.init();
  assert.ok(page2.doc.documentElement.classList.contains('kit-motion-off'));
  assert.strictEqual(k.setMotion('full'), 'full');
  assert.ok(!('kit-motion-v1' in store.m), 'full clears the setting');
  assert.ok(!doc.documentElement.classList.contains('kit-motion-off'));
  assert.strictEqual(k.setMotion('sideways'), 'full', 'anything else is full');
  assert.strictEqual(k.setMotion('off', { save: false }), 'off');
  assert.ok(!('kit-motion-v1' in store.m), 'save: false writes nothing');

  // storage that throws on every call, and a storage getter that throws
  const boom = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const p3 = page();
  const k3 = K.create({ document: p3.doc, storage: boom, matchMedia: () => ({ matches: false }) });
  assert.doesNotThrow(() => k3.motion());
  assert.strictEqual(k3.motion(), 'full');
  assert.strictEqual(k3.setMotion('off'), 'off', 'the setting still holds for this page');
  assert.ok(p3.doc.documentElement.classList.contains('kit-motion-off'));
  assert.strictEqual(k3.setMotion('full'), 'full');
  const p4 = page();
  const env = { document: p4.doc, matchMedia: () => ({ matches: false }) };
  Object.defineProperty(env, 'storage', { enumerable: true, get() { throw new Error('SecurityError'); } });
  const k4 = K.create(env);
  assert.strictEqual(k4.motion(), 'full');
  assert.strictEqual(k4.setMotion('off'), 'off');
  // in the source, every storage call is inside a try
  const src = read('live/kit.js');
  for (const m of src.matchAll(/^.*(?:getItem|setItem|removeItem|localStorage).*$/gm)) assert.match(m[0], /try \{|\/\*|^\s*\*|\/\//, 'not in a try: ' + m[0].trim());
});

test('reduced motion: the system setting and the motion kit\'s Less motion stop the orbit, the glow stays (CSS)', () => {
  const { doc } = page();
  const k = K.create({ document: doc, storage: memStore(), matchMedia: q => ({ matches: q === '(prefers-reduced-motion: reduce)' }) });
  assert.strictEqual(k.motion(), 'full', 'the page setting is still full');
  assert.strictEqual(k.reduced(), true, 'the system asks for reduced motion');
  const p2 = page();
  const k2 = K.create({ document: p2.doc, storage: memStore(), matchMedia: () => ({ matches: false }) });
  assert.strictEqual(k2.reduced(), false);
  p2.doc.documentElement.classList.toggle('motion-off', true);
  assert.strictEqual(k2.reduced(), true, 'ChartMotion.setReducedMotion(true) puts motion-off on <html>');
  // a lit panel under reduced motion is still lit (the glow shows)
  const { el } = p2;
  const panel = el('section', { class: 'kit-panel' });
  assert.strictEqual(k2.light(panel, { on: true, color: 'loss', pace: 'trade' }), true);
  const css = read('live/kit.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.kit \.kit-orbit \{ animation: none; transition: none; \}/);
  assert.match(css, /:root\.kit-motion-off \.kit \.kit-orbit, :root\.motion-off \.kit \.kit-orbit \{ animation: none; transition: none; \}/);
  // the glow is on the lit panel's halo, which nothing turns off for reduced motion
  assert.match(css, /\.kit \.kit-lit > \.kit-halo \{ box-shadow: 0 0 34px -4px var\(--kit-pc\), inset 0 0 22px -12px var\(--kit-pc\); \}/);
  for (const block of css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)) assert.ok(!/kit-lit|box-shadow|opacity/.test(block[1]), 'reduced motion leaves the glow alone');
  // the light: a registered angle and colour, a comet masked to the border, the paces
  assert.match(css, /@property --kit-ang \{ syntax: '<angle>'; inherits: false; initial-value: 0deg; \}/);
  assert.match(css, /@property --kit-pc \{ syntax: '<color>'; inherits: true; initial-value: #5df2ff; \}/);
  assert.match(css, /conic-gradient\(from var\(--kit-ang\)/);
  assert.match(css, /mask-composite: xor/);
  assert.match(css, /--kit-lap-decide: 13s;/); assert.match(css, /--kit-lap-trade: 9s;/);
  assert.match(css, /@keyframes kit-orbit \{ to \{ --kit-ang: 360deg; \} \}/);
});

// ---- the tokens
function cssBlock(css, sel) {
  const m = new RegExp('(?:^|\\n)' + sel.replace(/\./g, '\\.') + ' \\{([^}]*)\\}').exec(css);
  assert.ok(m, sel + ' block');
  return Object.fromEntries([...m[1].matchAll(/--kit-([a-z0-9-]+):\s*([^;]+);/g)].map(x => [x[1], x[2].trim()]));
}
const LOCKED = JSON.parse(/const LOCKED = (\{[^\n]*\});/.exec(read('test/theme.test.js'))[1]);

test('tokens: kit.css and ChartKit.TOKENS agree, on .kit and on each surface', () => {
  const css = read('live/kit.css');
  const base = cssBlock(css, '.kit');
  for (const [k, v] of Object.entries(K.TOKENS)) assert.strictEqual(base[k], v, '--kit-' + k);
  for (const [name, over] of Object.entries(K.VARIANTS)) {
    const b = cssBlock(css, '.kit-' + name);
    for (const [k, v] of Object.entries(over)) assert.strictEqual(b[k], v, '.kit-' + name + ' --kit-' + k);
    for (const k of Object.keys(b)) if (k in K.TOKENS) assert.strictEqual(b[k], over[k], '.kit-' + name + ' --kit-' + k + ' is in ChartKit.VARIANTS');
  }
  // the approved values (Anthony, 2026-10-08)
  assert.deepStrictEqual([K.TOKENS.ground, K.TOKENS.panel, K.TOKENS.hot, K.TOKENS.text, K.TOKENS.dim, K.TOKENS.cyan], ['#010307', 'rgba(0,6,12,.74)', '#e8feff', '#c9e7ec', '#7fb6c0', '#5df2ff']);
  assert.deepStrictEqual(K.VARIANTS.trading, { hot: '#dfe8ef', text: '#b7c6d1', dim: '#7d8fa0', line: 'rgba(120,146,166,.20)', 'line-soft': 'rgba(120,146,166,.14)', tint: 'rgba(120,146,166,.08)', meter: '#7d8fa0' });
  assert.strictEqual(K.tokens('desk').line, 'rgba(93,242,255,.20)');
  assert.deepStrictEqual(['purple-deep', 'purple', 'purple-soft', 'purple-text', 'danger'].map(k => K.TOKENS[k]), ['#6d28d9', '#7b5cff', '#b69cff', '#d8ccff', '#ff3b5c']);
  assert.deepStrictEqual(['screen', 'eyes', 'judgment', 'checks', 'go', 'pass', 'danger'].map(k => K.TOKENS['sig-' + k]), ['#5df2ff', '#8f7bff', '#c81fe0', '#ffd23f', '#3dff9a', '#ff8a2a', '#ff3b5c']);
  assert.strictEqual(K.COLORS.caution, K.COLORS.pass);
  assert.match(base.head, /^"Chakra Petch", "IBM Plex Sans Condensed",/);
  assert.match(base.body, /^"IBM Plex Sans",/);
  assert.match(base.mono, /^"JetBrains Mono", "IBM Plex Mono",/);
  assert.match(base.head + base.body + base.mono, /sans-serif.*sans-serif.*monospace/, 'system fallbacks last');
});

test('tokens: money, candles and three purples are the chart\'s locked palette (test/theme.test.js LOCKED)', () => {
  const pairs = { profit: 'profit', loss: 'loss', 'candle-up': 'up', 'candle-down': 'down', 'purple-deep': 'down', 'purple-soft': 'vwap', 'purple-text': 'drawing' };
  for (const [kit, chart] of Object.entries(pairs)) assert.strictEqual(K.TOKENS[kit].toUpperCase(), LOCKED[chart], '--kit-' + kit + ' = LOCKED.' + chart);
  assert.strictEqual(K.COLORS.profit.toUpperCase(), LOCKED.profit);
  assert.strictEqual(K.COLORS.loss.toUpperCase(), LOCKED.loss);
  // and the engine still builds those colours (the engine is not changed by the kit)
  const T = require('../src/chart-engine.js').util.buildTheme();
  for (const [kit, chart] of Object.entries(pairs)) assert.strictEqual(K.TOKENS[kit].toUpperCase(), T[chart].toUpperCase(), 'buildTheme().' + chart);
});

test('contrast: every text token is 4.5:1 or more on the ground and on a panel, on every surface (3:1 at 24 px and up)', () => {
  assert.ok(Math.abs(K.contrast('#ffffff', '#000000') - 21) < 1e-9);
  assert.ok(Math.abs(K.contrast('#777777', '#ffffff') - 4.4783) < 1e-3);
  const ground = K.TOKENS.ground;
  const glowPeak = K.over('rgba(0,150,255,.07)', ground);           // the brightest point of the ground's glow
  const surfaces = { ground: K.parseColor(ground), panel: K.over(K.TOKENS.panel, ground), 'panel on the glow': K.over(K.TOKENS.panel, glowPeak) };
  let n = 0;
  for (const v of ['trading', 'desk', 'agent']) {
    const t = K.tokens(v);
    for (const [k, size] of Object.entries(K.TEXT)) {
      const need = size >= 24 ? 3 : 4.5;
      for (const [s, bg] of Object.entries(surfaces)) {
        const c = K.contrast(t[k], bg);
        assert.ok(c >= need, `${v}: --kit-${k} ${t[k]} on the ${s} is ${c.toFixed(2)}:1, needs ${need}:1`);
        n++;
      }
    }
    // the main text stays readable even on the bare glow
    for (const k of ['hot', 'text', 'dim']) assert.ok(K.contrast(t[k], glowPeak) >= 4.5, v + ' ' + k + ' on the glow');
  }
  assert.ok(n >= 3 * 3 * 20, n + ' pairs checked');
  // text on the filled buttons and chips
  const panel = surfaces.panel;
  const fills = [
    ['ground on primary cyan', ground, K.TOKENS.cyan],
    ['dark red on the kill switch', '#1a0006', K.TOKENS.danger],
    ['accent text on the accent button', K.TOKENS['purple-text'], K.over('rgba(109,40,217,.32)', panel)],
    ['danger text on the danger button', K.TOKENS['danger-text'], K.over('rgba(255,59,92,.20)', panel)],
    ['purple chip', K.TOKENS['purple-text'], K.over('rgba(109,40,217,.16)', panel)],
    ['profit chip', K.TOKENS['profit-text'], K.over('rgba(61,220,151,.08)', panel)],
    ['loss chip', K.TOKENS['loss-text'], K.over('rgba(255,122,122,.08)', panel)],
    ['ground on an active tab', ground, K.TOKENS.cyan],
    ['the rail brand', K.TOKENS['purple-text'], K.over('rgba(109,40,217,.25)', panel)],
  ];
  for (const [name, fg, bg] of fills) assert.ok(K.contrast(fg, bg) >= 4.5, name + ': ' + K.contrast(fg, bg).toFixed(2));
  // every token used as text is listed (each var used in a color: declaration)
  const css = read('live/kit.css');
  const asText = new Set([...css.matchAll(/(?:^|[;{\s])color:\s*var\(--kit-([a-z-]+)\)/g)].map(m => m[1]));
  for (const k of asText) assert.ok(k in K.TEXT || k === 'ground' || k === 'sig', '--kit-' + k + ' is used as text: list it in ChartKit.TEXT');
});

// ---- R3: no motion on numbers, prices, P&L, chips or buttons
function rules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
}
test('R3: kit.css puts no transition or animation on a number, chip, button, row, tab, field or meter', () => {
  const css = read('live/kit.css');
  const all = rules(css);
  assert.ok(all.length > 80, 'the rules were read: ' + all.length);
  const NEVER = /kit-num|kit-big|kit-chip|kit-tag|kit-btn|kit-row|kit-tab|kit-seg|kit-meter|kit-field|kit-step|kit-pill|kit-dot|kit-rail|kit-fact|kit-key|kit-glow|kit-profit-text|kit-loss-text|button|select|input|\*/;
  const MAY_MOVE = /^\.kit \.kit-(?:orbit|halo|drawer|pace-trade > \.kit-orbit|pace-trade > \.kit-halo > \.kit-orbit|lit > \.kit-orbit|lit > \.kit-halo > \.kit-orbit)$|^:root\.(?:kit-)?motion-off \.kit \.kit-(?:orbit|halo|drawer)$/;
  let moving = 0;
  for (const r of all) {
    const decls = [...r.body.matchAll(/(?:^|;)\s*(transition[a-z-]*|animation[a-z-]*)\s*:\s*([^;]+)/g)].filter(d => !/^(none|0s?|paused|running)$/.test(d[2].trim()) && !/^animation-(?:play-state|duration)$/.test(d[1]));
    const any = [...r.body.matchAll(/(?:^|;)\s*(transition|animation)[a-z-]*\s*:/g)].length;
    if (!any || r.sel.startsWith('@') || /^(from|to|\d+%)$/.test(r.sel)) continue;
    for (const s of r.sel.split(',').map(x => x.trim())) {
      assert.ok(!NEVER.test(s), 'motion on ' + s);
      assert.match(s, MAY_MOVE, s + ' is not one of the parts that may move');
    }
    if (decls.length) moving++;
  }
  assert.ok(moving >= 3, 'the orbit, the panel glow and the drawer move');
  // what moves: the orbit's opacity and colour, the panel's glow, the drawer's slide; nothing else
  for (const r of all) for (const d of r.body.matchAll(/(?:^|;)\s*transition\s*:\s*([^;]+)/g)) {
    if (d[1].trim() === 'none') continue;
    for (const part of d[1].split(',')) assert.match(part.trim(), /^(opacity|--kit-pc|box-shadow) [\d.]+s ease$/, r.sel + ': ' + part);
  }
  // the page side writes no transition or animation either
  const js = read('live/kit.js');
  assert.ok(!/transition|animation\s*[=:]|\.animate\(/.test(js.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'kit.js starts no motion itself');
});

test('the order surfaces the light refuses include the motion kit\'s (R3), and the copier', () => {
  const M = require('../live/motion.js');
  const noLight = K.NO_LIGHT.split(',').map(s => s.trim());
  for (const s of M.NO_MOTION.split(',').map(x => x.trim()).filter(x => x !== '[data-no-motion]')) assert.ok(noLight.includes(s), s);
  for (const s of ['[data-no-light]', '.tk', '.ws-flat', '.apg-cop-top', '.apg-cop-g', '[data-copier]']) assert.ok(noLight.includes(s), s);
  // the classes are the real ones: the ticket, Flatten and the copier in the live page
  assert.match(read('live/workspace.js'), /class="chart-live tk"/);
  assert.match(read('live/workspace.css'), /\.ws-btn\.ws-flat/);
  assert.match(read('live/accounts.js'), /class="apg-cop-top"/);
  assert.match(read('live/accounts.js'), /apg-cop-g/);
});

// ---- the files
const KIT_FILES = ['live/kit.css', 'live/kit.js', 'live/kit.html', 'docs/KIT.md', 'test/kit.test.js', 'test/kit-smoke.mjs'];
// AI model and vendor names, spelled backwards so this file does not name them either
const MODEL = new RegExp('\\b(' + ['edualc', 'ciporhtna', 'tpg', 'ianepo', 'inimeg', 'korg', 'amall', 'lartsim', 'supo', 'tennos', 'ukiah'].map(w => [...w].reverse().join('')).join('|') + ')\\b', 'i');
test('plain words: no em or en dash, and no AI model name, in any kit file', () => {
  for (const f of KIT_FILES) {
    const t = read(f);
    assert.ok(!/[\u2013\u2014]/.test(t), f + ' has an em or en dash');
    assert.ok(!MODEL.test(t), f + ' names a model');
  }
});

test('installed: kit.css, kit.js and kit.html are in the www list, and the gallery loads only installed files', () => {
  const www = JSON.parse(read('nt8/install-files.json')).www;
  for (const f of ['kit.css', 'kit.js', 'kit.html']) assert.ok(www.some(x => x.from === 'live/' + f && x.to === f), f + ' is installed');
  const to = www.map(x => x.to);
  const html = read('live/kit.html');
  const refs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(refs, ['fonts/plex.css', 'fonts/agent-fonts.css', 'kit.css', 'kit.js']);
  for (const r of refs) assert.ok(to.includes(r), r + ' is installed');
  assert.ok(!/https?:\/\//.test(html + read('live/kit.css') + read('live/kit.js')), 'nothing from the internet in the installed kit files');
  for (const f of KIT_FILES) assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(read(f)), f + ' has a web font address');
  // the fonts: the Agent tab's files, every face installed, and only the weights they have
  const faces = [...read('live/fonts/agent-fonts.css').matchAll(/font-family: "([^"]+)"; font-style: normal; font-weight: (\d+);[^}]*url\("([^"]+)"\)/g)].map(m => ({ family: m[1], weight: +m[2], file: m[3] }));
  assert.deepStrictEqual(faces.map(f => f.family + ' ' + f.weight), ['Chakra Petch 400', 'Chakra Petch 500', 'Chakra Petch 600', 'Chakra Petch 700', 'JetBrains Mono 400', 'JetBrains Mono 600']);
  for (const f of faces) {
    assert.strictEqual(fs.readFileSync(path.join(root, 'live', 'fonts', f.file)).subarray(0, 4).toString('latin1'), 'wOF2', f.file);
    assert.ok(www.some(x => x.from === 'live/fonts/' + f.file && x.to === 'fonts/' + f.file), f.file + ' is installed');
  }
  for (const f of ['agent-fonts.css', 'OFL-agent.txt']) assert.ok(www.some(x => x.from === 'live/fonts/' + f && x.to === 'fonts/' + f), f + ' is installed');
  assert.match(read('live/fonts/OFL-agent.txt'), /SIL OPEN FONT LICENSE Version 1\.1/);
  const css = read('live/kit.css');
  for (const m of css.matchAll(/font: (\d{3}) [^;]*var\(--kit-(head|mono)\)/g)) {
    const fam = m[2] === 'head' ? 'Chakra Petch' : 'JetBrains Mono';
    assert.ok(faces.some(f => f.family === fam && f.weight === +m[1]), fam + ' ' + m[1] + ' is used but not served');
  }
  assert.ok(!/font: 500 [^;]*var\(--kit-mono\)/.test(css));
  // test/offline.test.js reads every www file: kit.html, kit.css, kit.js and the font stylesheet are among them
  assert.match(read('test/offline.test.js'), /for \(const f of www\)/);
  // the gallery uses sample data only
  assert.match(html, /Sample data only: Sim101/);
});

test('docs/KIT.md: the tokens, the fonts link, the rules, the API and the storage key', () => {
  const md = read('docs/KIT.md');
  for (const k of Object.keys(K.TOKENS)) assert.ok(md.includes('--kit-' + k), 'KIT.md lists --kit-' + k);
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(md), 'no web font link: the fonts are served with the page');
  assert.match(md, /fonts\/agent-fonts\.css/); assert.match(md, /The Desk vendors the same files/);
  assert.match(md, /## No explanatory labelling/);
  assert.match(md, /`\.kit-keys`, `\.kit-key`\) is \*\*gallery and docs only, never on a product\s+screen\*\*/);
  assert.match(read('live/kit.css'), /legend key: gallery and docs only, never on a product screen/);
  for (const s of ['kit-motion-v1', 'data-no-light', 'ChartKit.light', 'ChartKit.armed', 'ChartKit.setMotion', 'kit-trading', 'kit-desk', 'kit-agent', 'kit-armed', 'R3', 'npm run smoke:kit']) assert.ok(md.includes(s), s);
});
