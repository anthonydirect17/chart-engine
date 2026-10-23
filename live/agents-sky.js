/*
 * The Agents panel's Drone sky (chart 1.38.0; Anthony 2026-10-23 approved the concept, mockup version 4, style "drones").
 *
 * The price stands as a skyline of light pillars, one per NQ minute bar (1.38.1, Anthony 2026-10-23: his charts are NQ; the
 * seats trade MNQ, the same index, so their entries and stops are drawn at their MNQ prices on the NQ pillars, unconverted), with very faint, slow code rain and drifting dust
 * behind it. Each agent active today hovers above it as a hexagon drone in its colour (the League's H amber, S cyan, O violet; a
 * live agent and the bot in the strip's own colour for them), a lens turning inside, a dashed ring for SHADOW and a solid one for
 * LIVE, its text block beside it inside its own slot (name, mode, its one-word state; position, today's R, spend; looks left; the
 * 30-tick look cap). What the data says, the sky shows:
 *   - a new look (a seat's decision, a live agent's LOOK) fires that drone's look laser once: a sweeping fan, a hot core and a
 *     burn mark on the bars it crosses, which light up in its colour;
 *   - a pass pulses the drone and types its reason into the feed line under the canvas (a decode effect);
 *   - a trade: a tether from the drone to the trade's entry (green while its open R is up, red while down, a light packet
 *     running along it), its entry and stop as dashed lines to now, its open R stacked right of the price label; break-even
 *     and the trail show as the stop line moving (a short flash where it lands, and the feed line says so);
 *   - Anthony's own entries (his fills on the order ticket's account, read only) are white "A" beacons; a new one drops onto
 *     the price.
 * History is never replayed: what the data held when the panel opened is shown as it stands, and only its newest act plays,
 * once; after that, each act the page reads plays once.
 *
 * Read only: no request, no message, no poller of its own. The workspace hands it the strip's reads (the one league read, the
 * Agent tab's and the Bot desk's state) and the NQ minute bars of the quote line the workspace already watches (no new
 * connection). Hover a drone (or focus its button) for today's full card; a click opens the League tab, the Agent tab or the Bot.
 *
 * Cheap (docs/MOTION.md "Allowed motion: the Agents panel"): one canvas on whole device pixels (as the chart's 1.37.0 snap), at
 * most 30 frames a second (15 in calm motion), and no frame at all while the panel is hidden, off screen or behind another view,
 * or the window is in the background. Reduced motion (the Windows setting, or the page's Less motion) is calm motion: everything
 * slower, the text at once. Figures (position, R, spend) are drawn as they are on every frame: nothing counts up or eases in.
 */
(function () {
'use strict';
if (typeof window === 'undefined' || typeof document === 'undefined') return;
const C = window.AgentsStripCore, CARD = window.AgentsStrip;
const VERSION = '1.38.1';
const FPS = 30, CALM_FPS = 15, SLIM_H = 200, PULSE_S = 0.7, TICKS = 30;
/* the code rain's glyphs: digits and signs only (every PC's fonts have them) */
const GLY = '0123456789<>/\\|=+*#:;{}[]$%';
const LOOK_S = 1.8;                         // one look's sweep
const SKY_ROOT = 'NQ';                      // 1.38.1: the pillars and the price label (the seats' contracts and point value stay MNQ)
const FEED_IDLE = 'watching ' + SKY_ROOT;

const isNum = v => typeof v === 'number' && isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = CARD ? CARD.esc : s => String(s);
const alpha = (hex, a) => { const n = parseInt(String(hex).slice(1), 16); return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')'; };
const fmtPx = p => (isNum(p) ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
const pad = n => (n < 10 ? '0' : '') + n;
const hms = s => { const d = new Date(s * 1000); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()); };
const sR = v => (isNum(v) ? (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(2) + 'R' : '');

/**
 * The sky in a panel's body. o: { day(), reach(), agents(), bot(), nowMs(), last(root), pv(root), bars() ({ root, name, bars:
 * [{ t, o, h, l, c }] } or null: the NQ minute bars the page holds), mine() (Anthony's entries today, AgentsStripCore.entriesOf),
 * zoneSec(ms) (epoch ms to the league's clock, seconds), openLeague(), openAgent(id), openBot() }. Returns { render, destroy, state }.
 */
function mount(body, o) {
  body.innerHTML = '<div class="ak-wrap">' +
    '<div class="ak-stage" data-k="stage"><canvas class="ak-cv" aria-hidden="true"></canvas>' +
      '<p class="ak-empty" data-k="empty" hidden>No agents active today</p>' +
      '<div class="ak-hits" data-k="hits" role="list" aria-label="Agents active today"></div></div>' +
    '<div class="ak-feed" data-k="feed"><span class="ak-who" data-k="who"></span><span class="ak-t" data-k="t"></span><span class="ak-txt" data-k="txt" aria-live="off"></span>' +
      '<span class="ak-warn" data-k="warn" hidden></span><button type="button" class="ak-idle" data-k="idle" hidden></button></div>' +
    '<div class="ak-more" data-k="more" role="list" aria-label="Agents with no room in the panel" hidden></div>' +
    '<div class="ak-pop" data-k="pop" role="dialog" aria-modal="false" aria-label="Today\'s card" hidden></div>' +
    '</div>';
  const q = k => body.querySelector('[data-k="' + k + '"]');
  const stage = q('stage'), cv = stage.querySelector('canvas'), ctx = cv.getContext('2d');
  const hitsEl = q('hits'), moreEl = q('more'), emptyEl = q('empty'), popEl = q('pop'), idleEl = q('idle'), warnEl = q('warn'), whoEl = q('who'), tEl = q('t'), txtEl = q('txt');
  const css = n => getComputedStyle(body).getPropertyValue(n).trim();
  const K = { ground: css('--ws-bg') || '#06080C', ink: css('--ws-text') || '#E6EDF5', dim: css('--ws-muted') || '#7F8C9C', up: css('--ws-buy') || '#3DDC97', down: css('--ws-sell') || '#FF5C7A',
    warn: css('--ws-warn') || '#FFC266', him: '#F2F4FF' };
  const FD = '"Orbitron", "IBM Plex Sans", system-ui, sans-serif', FM = '"IBM Plex Mono", ui-monospace, Consolas, monospace';
  if (document.fonts && document.fonts.load) { document.fonts.load('700 12px Orbitron').catch(() => {}); document.fonts.load('500 11px "IBM Plex Mono"').catch(() => {}); }

  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const calm = () => !!(mq && mq.matches) || !!(window.ChartMotion && typeof window.ChartMotion.reduced === 'function' && window.ChartMotion.reduced());

  const S = {
    model: { drones: [], idle: [] }, anim: new Map(), seen: new Map(), playedNewest: false, mineSeen: null, beacons: [], openedSec: null,
    W: 0, H: 0, dpr: 1, snapAt: '', snapLook: 0, dust: [], rain: [],
    raf: 0, last: 0, now: 0, running: false, calm: false, onScreen: true, frames: 0, ms: [], destroyed: false,
    decode: null, said: false, pop: null, popT: 0, hitsKey: '', lay: null, slots: [],
  };

  /* ---------------- sizing: the canvas on whole device pixels (the chart's 1.37.0 snap) */
  function resize() {
    const r = stage.getBoundingClientRect(), d = Math.max(1, window.devicePixelRatio || 1);
    const L = r.left * d, T = r.top * d, sl = Math.round(L), st = Math.round(T);
    const cw = Math.max(1, Math.round((r.left + r.width) * d) - sl), ch = Math.max(1, Math.round((r.top + r.height) * d) - st);
    S.dpr = d; S.W = cw / d; S.H = ch / d;
    if (cv.width !== cw) cv.width = cw;
    if (cv.height !== ch) cv.height = ch;
    const s = cv.style; s.left = (sl - L) / d + 'px'; s.top = (st - T) / d + 'px'; s.width = S.W + 'px'; s.height = S.H + 'px';
    S.snapAt = [r.left, r.top, r.width, r.height, d].join('|');
    makeDust(); makeRain(); S.hitsKey = '';
  }
  function snapCheck(ms) {
    if (ms - S.snapLook < 500) return;
    S.snapLook = ms;
    const r = stage.getBoundingClientRect(), d = Math.max(1, window.devicePixelRatio || 1);
    if ([r.left, r.top, r.width, r.height, d].join('|') !== S.snapAt) resize();
  }
  function makeDust() { S.dust = []; const n = Math.round(clamp(S.W * S.H / 4600, 20, 90)); for (let i = 0; i < n; i++) S.dust.push({ x: Math.random() * S.W, y: Math.random() * S.H, v: 2 + Math.random() * 6, r: Math.random() * 1.2 + 0.2 }); }
  function makeRain() { S.rain = []; const cols = Math.floor(S.W / 13); for (let i = 0; i < cols; i++) S.rain.push({ x: i * 13 + 6, y: Math.random() * S.H, v: 25 + Math.random() * 55, seed: Math.random() * 100 }); }

  /* ---------------- the data: the model, the acts that play, the feed line */
  const animOf = key => { let a = S.anim.get(key); if (!a) { a = { spin: Math.random() * 6, pulse: 0, beam: null, queue: [], stop: null, entry: null, flash: 0, ox: Math.random() * 6 }; S.anim.set(key, a); } return a; };
  function say(d, text, tSec) {
    whoEl.textContent = d ? d.letter : 'A'; whoEl.style.color = d ? d.color : K.him;
    tEl.textContent = isNum(tSec) ? hms(tSec) : '';
    S.decode = { text: String(text || ''), t: calm() ? 99 : 0 }; S.said = true;
    if (S.decode.t >= 99) { txtEl.textContent = S.decode.text; S.decode = null; }
    txtEl.title = String(text || '');
  }
  function tickDecode(dt) {
    const dc = S.decode; if (!dc) return;
    dc.t += dt;
    const n = dc.text.length, shown = Math.min(n, Math.floor(dc.t * 90));
    let s = dc.text.slice(0, shown);
    if (shown < n) for (let i = shown; i < Math.min(n, shown + 6); i++) s += dc.text[i] === ' ' ? ' ' : GLY[(Math.random() * GLY.length) | 0];
    txtEl.textContent = s;
    if (shown >= n) S.decode = null;
  }
  /* an act plays: a look fires the laser, then its outcome; anything else at once */
  const LOOKS = ['look', 'pass', 'enter', 'rest', 'cancel', 'refused', 'failed'];
  function play(d, act) {
    const a = animOf(d.key);
    if (d.kind === 'seat' ? LOOKS.includes(act.kind) : act.kind === 'look') a.queue.push(act);
    else land(d, act);
  }
  function land(d, act) {
    const a = animOf(d.key);
    if (act.kind === 'pass' || act.kind === 'exit' || act.kind === 'refused') a.pulse = 1;
    say(d, act.text, act.t || null);
  }
  function read() {
    const nowMs = o.nowMs();
    const model = C.skyModel({ day: o.day(), nowMs, last: o.last(SKY_ROOT), pv: o.pv('MNQ'), agents: o.agents(), bot: o.bot ? o.bot() : null, lastOf: o.last, pvOf: o.pv, zoneSec: o.zoneSec });
    S.model = model;
    if (S.openedSec === null) S.openedSec = nowMs / 1000;
    /* no replays of history: a drone's acts from before the panel opened are taken as seen when it first shows (its source may be
       read a few seconds after the panel opened: the league every 15 s); its newer ones play, each once; and of the history, the
       newest act of all plays once, the first time there is any */
    let newest = null;
    for (const d of model.drones) {
      let seen = S.seen.get(d.key);
      if (!seen) {
        seen = new Set();
        for (const act of d.acts) if (!(act.t > S.openedSec)) { seen.add(act.id); if (!newest || act.t > newest[1].t) newest = [d, act]; }
        S.seen.set(d.key, seen);
      }
      for (const act of d.acts) if (!seen.has(act.id)) { seen.add(act.id); play(d, act); }
    }
    if (newest && !S.playedNewest) { S.playedNewest = true; play(newest[0], newest[1]); }
    /* a trade's stop moved (break-even, the trail): the line moves there at once, flashes, and the feed line says so */
    for (const d of model.drones) {
      const a = animOf(d.key), t = d.trade;
      if (t && a.entry === t.entry && isNum(a.stop) && isNum(t.stop) && t.stop !== a.stop) {
        a.flash = 1;
        say(d, (t.be && !(t.side === 'long' ? a.stop >= t.entry : a.stop <= t.entry) ? 'B/E  stop to entry ' : 'TRAIL  stop to ') + fmtPx(t.stop), nowMs / 1000);
      }
      a.entry = t ? t.entry : null; a.stop = t ? t.stop : null;
    }
    for (const k of [...S.anim.keys()]) if (!model.drones.some(d => d.key === k)) S.anim.delete(k);
    /* Anthony's entries: each stands as a beacon; one newer than the panel drops in */
    const mine = typeof o.mine === 'function' ? o.mine() || [] : [];
    const keyOf = e => e.root + '|' + e.t + '|' + e.p;
    if (!S.mineSeen) S.mineSeen = new Set(mine.map(keyOf));
    S.beacons = mine.map(e => {
      const k = keyOf(e), fresh = !S.mineSeen.has(k);
      if (fresh) { S.mineSeen.add(k); say(null, 'ENTRY ' + e.side + ' ' + fmtPx(e.p) + ' (Anthony)', e.t); }
      const was = S.beacons.find(b => b.k === k);
      return { k, t: e.t, p: e.p, born: was ? was.born : fresh ? S.now : -99 };
    });
    if (!S.said && !S.decode) { say(null, model.drones.length ? FEED_IDLE : 'No agents active today', null); S.said = false; }
  }

  /* ---------------- the DOM around the canvas: the drones' buttons, the idle chip, the empty state */
  function domSync() {
    const m = S.model, reach = o.reach() || {};
    emptyEl.hidden = m.drones.length > 0;
    const shown = S.slots.length;
    const more = Math.max(0, m.drones.length - shown);
    const idle = m.idle.length;
    idleEl.hidden = !idle && !more;
    const chip = (idle ? '+' + idle + ' idle' : '') + (idle && more ? ' · ' : '') + (more ? '+' + more + ' more' : '');
    if (idleEl.textContent !== chip) idleEl.textContent = chip;
    const tip = (idle ? 'Idle today (off, nothing held, nothing working): ' + m.idle.join(', ') : '') + (more ? (idle ? '. ' : '') + 'No room for ' + m.drones.slice(shown).map(d => d.name).join(', ') + ': widen the panel' : '');
    if (idleEl.title !== tip) { idleEl.title = tip; idleEl.setAttribute('aria-label', tip || 'none idle'); }
    /* the drones with no room: a list from the chip (a click), each with its card on hover and its tab on a click */
    idleEl.classList.toggle('ak-click', more > 0); idleEl.setAttribute('aria-expanded', String(more > 0 && !moreEl.hidden));
    if (!more) moreEl.hidden = true;
    const mh = m.drones.slice(shown).map(d => '<button type="button" class="ak-mi" role="listitem" data-key="' + esc(d.key) + '" aria-label="' + esc(d.letter + ' ' + d.name + ', ' + d.mode + (d.state ? ', ' + d.state : '') + ': ' + CARD.openWhat(d.card)) + '">' +
      '<b style="color:' + esc(d.color) + '">' + esc(d.letter) + '</b><span>' + esc(d.name) + '</span>' + (d.state ? '<i>' + esc(d.state) + '</i>' : '') + '</button>').join('');
    if (moreEl.dataset.html !== mh) { moreEl.dataset.html = mh; moreEl.innerHTML = mh; }
    const prob = reach.problem || (!o.day() ? 'Reading the league from The Desk...' : o.day().problem || '');
    warnEl.hidden = !prob; if (warnEl.textContent !== prob) { warnEl.textContent = prob; warnEl.title = prob; }
    const key = S.slots.map(s => s.d.key + ':' + Math.round(s.x) + ':' + Math.round(s.w) + ':' + Math.round(s.h) + ':' + s.d.name + s.d.mode + s.d.state + (s.d.trade ? s.d.trade.side : 'flat')).join('|');
    if (key !== S.hitsKey) {
      S.hitsKey = key;
      hitsEl.innerHTML = S.slots.map(s => '<button type="button" class="ak-hit" role="listitem" data-key="' + esc(s.d.key) + '" style="left:' + s.x.toFixed(1) + 'px;width:' + s.w.toFixed(1) + 'px;height:' + s.h.toFixed(1) + 'px" aria-label="' +
        esc(s.d.letter + ' ' + s.d.name + ', ' + s.d.mode + (s.d.state ? ', ' + s.d.state : '') + ', ' + (s.d.trade ? 'in a ' + s.d.trade.side + ' trade' : 'flat') + ': ' + CARD.openWhat(s.d.card)) + '"></button>').join('');
    }
    if (S.pop) renderPop();
  }
  /* the hover card: the strip's card for that drone, in a box over the panel (and a thought's full reasoning under it) */
  function renderPop() {
    const d = S.model.drones.find(x => x.key === S.pop.key);
    if (!d) { closePop(); return; }
    const html = CARD.cardHtml(d.card) + (S.pop.th ? '<div class="as-detail ak-detail">' + CARD.detailHtml(d.card, S.pop.th) + '</div>' : '');
    if (popEl.dataset.html !== html) { popEl.dataset.html = html; popEl.innerHTML = html; }
    const slot = S.slots.find(s => s.d.key === d.key), wrap = body.firstElementChild.getBoundingClientRect(), st = stage.getBoundingClientRect();
    let pw = Math.min(320, wrap.width - 8), x = slot ? clamp(st.left - wrap.left + slot.x, 4, Math.max(4, wrap.width - pw - 4)) : 4;
    let top = slot && S.H >= SLIM_H ? Math.min(slot.h + 4, wrap.height * 0.35) : 4, bottom = wrap.height - 4;
    if (!slot && !moreEl.hidden) {                             // a drone from the "+N more" list: beside the list, else above it
      const ml = moreEl.getBoundingClientRect();
      if (ml.left - wrap.left - 12 >= 200) { pw = Math.min(320, ml.left - wrap.left - 12); x = ml.left - wrap.left - 8 - pw; }
      else bottom = ml.top - wrap.top - 4;
    }
    popEl.style.left = x + 'px'; popEl.style.width = pw + 'px'; popEl.style.top = top + 'px'; popEl.style.maxHeight = Math.max(80, bottom - top) + 'px';
    popEl.hidden = false;
  }
  function openPop(key) { if (S.pop && S.pop.key === key) { S.popT = 0; return; } S.pop = { key, th: null }; S.popT = 0; renderPop(); }
  function closePop() { S.pop = null; S.popT = 0; popEl.hidden = true; popEl.dataset.html = ''; popEl.innerHTML = ''; }
  function leaveSoon() { S.popT = performance.now() + 250; if (!S.running) setTimeout(() => { if (S.popT && performance.now() >= S.popT) closePop(); }, 300); }
  function openFor(d) { if (!d) return; if (d.kind === 'seat') o.openLeague(); else if (d.kind === 'bot') o.openBot(); else o.openAgent(d.id); }
  const droneOf = key => S.model.drones.find(x => x.key === key);
  idleEl.addEventListener('click', () => { if (!idleEl.classList.contains('ak-click')) return; moreEl.hidden = !moreEl.hidden; idleEl.setAttribute('aria-expanded', String(!moreEl.hidden)); if (moreEl.hidden) closePop(); });
  moreEl.addEventListener('pointerover', e => { const b = e.target.closest('.ak-mi'); if (b) openPop(b.dataset.key); });
  moreEl.addEventListener('focusin', e => { const b = e.target.closest('.ak-mi'); if (b) openPop(b.dataset.key); });
  moreEl.addEventListener('pointerleave', e => { if (!(e.relatedTarget && popEl.contains(e.relatedTarget))) leaveSoon(); });
  moreEl.addEventListener('click', e => { const b = e.target.closest('.ak-mi'); if (b) { moreEl.hidden = true; closePop(); openFor(droneOf(b.dataset.key)); } });
  moreEl.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); moreEl.hidden = true; closePop(); idleEl.focus({ preventScroll: true }); } });
  hitsEl.addEventListener('pointerover', e => { const b = e.target.closest('.ak-hit'); if (b) openPop(b.dataset.key); });
  hitsEl.addEventListener('pointerout', e => { const b = e.target.closest('.ak-hit'); if (b && !(e.relatedTarget && (popEl.contains(e.relatedTarget) || b.contains(e.relatedTarget)))) leaveSoon(); });
  hitsEl.addEventListener('focusin', e => { const b = e.target.closest('.ak-hit'); if (b) openPop(b.dataset.key); });
  hitsEl.addEventListener('focusout', e => { if (!(e.relatedTarget && (popEl.contains(e.relatedTarget) || hitsEl.contains(e.relatedTarget)))) leaveSoon(); });
  hitsEl.addEventListener('click', e => { const b = e.target.closest('.ak-hit'); if (b) openFor(droneOf(b.dataset.key)); });
  popEl.addEventListener('pointerover', () => { S.popT = 0; });
  popEl.addEventListener('pointerleave', e => { if (!(e.relatedTarget && (hitsEl.contains(e.relatedTarget) || moreEl.contains(e.relatedTarget)))) leaveSoon(); });
  popEl.addEventListener('click', e => {
    if (!S.pop) return;
    if (e.target.closest('[data-close]')) { S.pop.th = null; renderPop(); return; }
    if (e.target.closest('.ak-detail')) return;
    const th = e.target.closest('[data-th]');
    if (th) { S.pop.th = S.pop.th === th.dataset.th ? null : th.dataset.th; renderPop(); return; }
    if (e.target.closest('[data-card]')) openFor(droneOf(S.pop.key));
  });
  popEl.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); const k = S.pop && S.pop.key; closePop(); const b = k && hitsEl.querySelector('[data-key="' + CSS.escape(k) + '"]'); if (b) b.focus({ preventScroll: true }); } });

  /* ---------------- drawing (the mockup's drone sky) */
  const bw = () => (o.bars && o.bars()) || null;
  function scaleOf(bars, x0, x1, top, bot) {
    let lo = Infinity, hi = -Infinity;
    for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    for (const s of S.slots) { const t = s.d.trade; if (t) for (const p of [t.entry, t.stop]) if (isNum(p)) { lo = Math.min(lo, p); hi = Math.max(hi, p); } }
    for (const b of S.beacons) if (b.t >= bars[0].t) { lo = Math.min(lo, b.p); hi = Math.max(hi, b.p); }
    if (!isNum(lo) || !isNum(hi)) return null;                // nothing finite to scale by: no pillars this frame
    const pd = (hi - lo) * 0.1 + 1; lo -= pd; hi += pd;
    const n = bars.length, step = n > 1 ? (x1 - x0) / (n - 1) : 0;
    const X = i => x0 + i * step, Y = p => bot - (p - lo) / (hi - lo) * (bot - top);
    const idx = t => { if (!isNum(t)) return n - 1; let a = 0, b = n - 1, hit = 0; while (a <= b) { const m = (a + b) >> 1; if (bars[m].t <= t) { hit = m; a = m + 1; } else b = m - 1; } return t < bars[0].t ? 0 : hit; };
    return { X, Y, idx, step, nx: X(n - 1), ny: Y(bars[n - 1].c), top, bot, x0, x1 };
  }
  const glow = (c, b) => { ctx.shadowColor = c; ctx.shadowBlur = b; }, noGlow = () => { ctx.shadowBlur = 0; };
  function laser(x0, y0, x1, y1, col, a, w) {
    ctx.lineCap = 'round';
    glow(col, 14); ctx.strokeStyle = alpha(col, 0.35 * a); ctx.lineWidth = w * 3.5; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = alpha(col, 0.95 * a); ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); noGlow();
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.7 * a) + ')'; ctx.lineWidth = Math.max(0.6, w * 0.4); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  function beamPoint(a, k, bars) {                            // where a look's laser lands: sweeping back over the last bars
    const p = Math.min(1, a.beam.t / a.beam.dur), idx = Math.max(0, bars.length - 1 - Math.round((1 - p) * 18));
    return { x: k.X(idx), y: k.Y(bars[idx].c), idx, p, fade: p < 0.85 ? 1 : (1 - p) / 0.15 };
  }
  function lookFan(x0, y0, bp, col) {
    if (![x0, y0, bp.x, bp.y, bp.fade].every(isNum)) return;   // a gradient with a value not finite throws
    const g = ctx.createLinearGradient(x0, y0, bp.x, bp.y); g.addColorStop(0, alpha(col, 0)); g.addColorStop(1, alpha(col, 0.22 * bp.fade));
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(bp.x - 14, bp.y); ctx.lineTo(bp.x + 14, bp.y); ctx.closePath(); ctx.fill();
    laser(x0, y0, bp.x, bp.y, col, bp.fade, 1.2);
    glow(col, 12); ctx.fillStyle = alpha(col, 0.9 * bp.fade); ctx.beginPath(); ctx.arc(bp.x, bp.y, 2.6, 0, 7); ctx.fill(); noGlow();
  }
  function fit(s, maxW) { if (ctx.measureText(s).width <= maxW) return s; while (s.length > 1 && ctx.measureText(s + '...').width > maxW) s = s.slice(0, -1); return s.length > 1 ? s + '...' : ''; }
  const mw = s => ctx.measureText(s).width;
  let hudRight = 0;                                            // the right end of what the text block being drawn drew (the tests' check)
  function drawFields(fields, x, y, maxW, gap) { for (const f of C.fitFields(fields, mw, maxW, gap)) { ctx.fillStyle = f.f.col; ctx.fillText(f.text, x + f.x, y); hudRight = Math.max(hudRight, x + f.x + f.w); } }
  /* the text block beside a drone, fitted to its slot so nothing overlaps (fit or drop fields, as the mockup's hud) */
  function hud(d, a, x, y, maxW, slim) {
    if (maxW < 30) return;
    ctx.textBaseline = 'alphabetic';
    ctx.font = '700 ' + (slim ? 12 : 15) + 'px ' + FD; ctx.fillStyle = d.color; glow(d.color, 8); ctx.fillText(d.letter, x, y); noGlow();
    const lx = x + (slim ? 14 : 18);
    const doing = a.beam ? 'looking' : d.trade ? (d.trade.be ? 'in trade · B/E' : 'in trade') : 'watching';
    ctx.font = '700 ' + (slim ? 8 : 9) + 'px ' + FD;
    /* line 1: the name, its one-word state (amber, kept before the mode when room is short), the mode */
    const l1 = [{ text: String(d.name).toUpperCase(), keep: 'cut', col: K.dim }];
    if (d.state) l1.push({ text: d.state.toUpperCase(), col: d.alert ? K.down : K.warn });
    l1.push({ text: d.mode, col: K.dim });
    drawFields(l1, lx, y - 1, maxW - (lx - x), 7);
    const l2y = y + (slim ? 14 : 18);
    ctx.font = '500 ' + (slim ? 10 : 11) + 'px ' + FM;
    const t = d.trade;
    const pos = t ? (t.side === 'short' ? '▼' : '▲') + (isNum(t.contracts) ? t.contracts : '') + ' ' + t.side : 'flat';
    const r = d.todayR;
    drawFields([{ text: pos, col: t ? (t.side === 'short' ? K.down : K.up) : K.dim }, { text: isNum(r) ? sR(r) + ' today' : '', col: isNum(r) ? (r > 0 ? K.up : r < 0 ? K.down : K.dim) : K.dim },
      { text: d.spend || d.rails, col: K.dim }], x, l2y, maxW, 9);
    if (slim) return;
    ctx.font = '9.5px ' + FM;
    const used = isNum(d.looks) ? Math.min(TICKS, d.looks) : null;
    drawFields([{ text: used !== null ? (TICKS - used) + ' looks left' : '', col: K.dim }, { text: doing, col: K.dim }], x, l2y + 15, maxW, 9);
    if (used !== null) {                                       // the 30-tick look cap: the used ones dark
      const w = Math.min(maxW, 120), gap = w / TICKS;
      for (let i = 0; i < TICKS; i++) { ctx.fillStyle = i >= used ? alpha(d.color, 0.8) : 'rgba(124,130,163,0.2)'; ctx.fillRect(x + i * gap, l2y + 22, Math.max(1, gap - 1.2), 3); }
    }
  }
  function priceLabel(k, last, slim) {
    glow('#ffffff', 14); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(k.nx, k.ny, 3, 0, 7); ctx.fill(); noGlow();
    ctx.textBaseline = 'middle'; ctx.font = '600 ' + (slim ? 10 : 11) + 'px ' + FM; ctx.fillStyle = K.ink;
    ctx.fillText(fit(SKY_ROOT + ' ' + fmtPx(last), S.W - k.nx - 14), k.nx + 10, k.ny);
    ctx.font = (slim ? 9 : 10) + 'px ' + FM; ctx.fillStyle = K.dim;
    ctx.fillText(fit(hms(o.nowMs() / 1000) + ' ET', S.W - k.nx - 14), k.nx + 10, k.ny + (slim ? 11 : 13));
  }
  function tradeLevels(k, bars, last, slim) {
    let row = 0;
    for (const s of S.slots) {
      const d = s.d, t = d.trade; if (!t) continue;
      const a = animOf(d.key), ex = k.X(k.idx(t.fillT)), ey = k.Y(t.entry);
      ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
      ctx.strokeStyle = alpha(d.color, 0.6); ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(k.nx, ey); ctx.stroke();
      if (isNum(t.stop)) {
        const sy = k.Y(t.stop);
        ctx.strokeStyle = alpha(K.down, 0.55 + 0.45 * a.flash); ctx.lineWidth = 1 + a.flash; ctx.beginPath(); ctx.moveTo(ex, sy); ctx.lineTo(k.nx, sy); ctx.stroke();
      }
      ctx.setLineDash([]);
      const r = isNum(t.r) ? t.r : null;
      ctx.font = '600 ' + (slim ? 9 : 10) + 'px ' + FM; ctx.textBaseline = 'middle'; ctx.fillStyle = r === null ? K.dim : r >= 0 ? K.up : K.down;
      ctx.fillText(fit(d.letter + ' ' + (r === null ? 'R n/r' : sR(r)) + (t.be ? ' B/E' : ''), S.W - k.nx - 14), k.nx + 10, k.ny + (slim ? 23 : 29) + row * (slim ? 10 : 12)); row++;
    }
  }
  function beacons(k, bars) {
    for (const b of S.beacons) {
      if (b.t < bars[0].t) continue;
      const x = k.X(k.idx(b.t)), y = k.Y(b.p), age = S.now - b.born, drop = clamp(age / 0.6, 0, 1);
      const yy = k.top - 8 + (y - k.top + 8) * (1 - (1 - drop) ** 3);
      glow(K.him, 18); ctx.fillStyle = K.him; ctx.beginPath(); ctx.moveTo(x, yy - 6); ctx.lineTo(x + 5, yy); ctx.lineTo(x, yy + 6); ctx.lineTo(x - 5, yy); ctx.closePath(); ctx.fill(); noGlow();
      ctx.font = '700 9px ' + FD; ctx.textBaseline = 'bottom'; ctx.fillText('A', x - 3, yy - 8);
      if (age >= 0 && age < 1.5) { ctx.strokeStyle = alpha(K.him, 0.6 * (1 - age / 1.5)); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, 6 + age * 26, 0, 7); ctx.stroke(); }
    }
  }
  function background(dt, sp) {
    ctx.font = '11px ' + FM; ctx.textBaseline = 'middle';
    for (const d of S.rain) {                                    // faint, slow code rain (version 4 levels)
      d.y += d.v * 0.35 * dt * sp; if (d.y > S.H + 60) { d.y = -20 - Math.random() * 80; d.v = 25 + Math.random() * 55; }
      for (let j = 0; j < 4; j++) {
        const y = d.y - j * 14; if (y < 0 || y > S.H) continue;
        ctx.fillStyle = j === 0 ? 'rgba(200,185,255,0.09)' : 'rgba(91,61,255,' + (0.05 * (1 - j / 4)) + ')';
        ctx.fillText(GLY[((d.seed + j * 7 + Math.floor(S.now * 6 + d.seed)) | 0) % GLY.length], d.x - 4, y);
      }
    }
    ctx.fillStyle = 'rgba(167,123,255,0.25)';
    for (const d of S.dust) { d.y -= d.v * dt * sp; if (d.y < 0) { d.y = S.H; d.x = Math.random() * S.W; } ctx.fillRect(d.x, d.y, d.r, d.r); }
  }
  /* the slots: one per drone shown, left to right, each at least 150 px (90 slim) */
  function layout() {
    const slim = S.H < SLIM_H, min = slim ? 90 : 150, n = S.model.drones.length;
    const fitN = Math.max(1, Math.floor(S.W / min)), shown = S.model.drones.slice(0, Math.min(n, fitN));
    const slotW = shown.length ? S.W / Math.max(3, shown.length) : 0;   // three slots across at least, as the mockup
    const h = slim ? Math.min(S.H * 0.42, 52) : Math.min(S.H * 0.4, 96);
    S.slots = shown.map((d, i) => ({ d, x: i * slotW, w: slotW, h }));
  }
  function draw(dt) {
    const sp = S.calm ? 0.3 : 1, W = S.W, H = S.H, slim = H < SLIM_H;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.fillStyle = K.ground; ctx.fillRect(0, 0, W, H);
    layout();
    background(dt, sp);
    const feed = bw(), bars0 = feed && Array.isArray(feed.bars) ? feed.bars.filter(b => b && [b.t, b.o, b.h, b.l, b.c].every(isNum)) : [];
    const nb = Math.round(clamp((W * 0.83) / 13, 24, 90)), bars = bars0.slice(-nb);
    let k = null;
    if (bars.length >= 2) k = scaleOf(bars, W * 0.03, W * 0.86, H * 0.40, H * 0.96);
    if (k) {
      const lit = S.lit && S.lit.length === bars.length && S.litT === bars[0].t ? S.lit : (S.lit = bars.map(() => ({ v: 0, c: null })), S.litT = bars[0].t, S.lit);
      for (const l of lit) l.v = Math.max(0, l.v - dt * 1.6);
      const w = Math.max(1.5, k.step * 0.55);
      for (let i = 0; i < bars.length; i++) {                  // the pillars, one per bar, lit where a laser crosses them
        const b = bars[i], x = k.X(i), yT = k.Y(Math.max(b.o, b.c)), yB = Math.max(yT + 1.5, k.Y(Math.min(b.o, b.c))), L = lit[i].v, col = lit[i].c || '#a77bff';
        if (![x, yT, yB, k.bot].every(isNum)) continue;
        ctx.strokeStyle = L > 0 ? alpha(col, 0.4 + 0.5 * L) : 'rgba(217,220,240,0.18)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, k.Y(b.h)); ctx.lineTo(x, k.Y(b.l)); ctx.stroke();
        const pg = ctx.createLinearGradient(0, yT, 0, k.bot); pg.addColorStop(0, L > 0 ? alpha(col, 0.35 * L) : 'rgba(167,123,255,0.10)'); pg.addColorStop(1, 'rgba(91,61,255,0)');
        ctx.fillStyle = pg; ctx.fillRect(x - w / 2, yT, w, k.bot - yT);
        if (L > 0) glow(col, 10 * L);
        ctx.fillStyle = L > 0 ? alpha(col, 0.6 + 0.4 * L) : 'rgba(226,214,255,0.75)'; ctx.fillRect(x - w / 2, yT, w, yB - yT); noGlow();
      }
      beacons(k, bars); tradeLevels(k, bars, bars[bars.length - 1].c, slim); priceLabel(k, bars[bars.length - 1].c, slim);
      S.k = k; S.kBars = bars;
    } else {
      ctx.font = '10px ' + FM; ctx.fillStyle = K.dim; ctx.textBaseline = 'middle';
      ctx.fillText('Waiting for ' + SKY_ROOT + ' bars from ChartBridge', W * 0.03, H * 0.7);
    }
    for (let i = 0; i < S.slots.length; i++) {
      const s = S.slots[i], d = s.d, a = animOf(d.key), r = slim ? 9 : 13;
      const dx = s.x + (slim ? 30 : 44) + Math.sin(S.now * 0.6 + i * 2 + a.ox) * 5 * sp, dy = (slim ? 24 : 34) + Math.sin(S.now * 1.4 + i + a.ox) * 3 * sp;
      a.spin += dt * (d.trade ? 2.4 : a.beam ? 1.8 : 0.7) * (S.calm ? 0.35 : 1);
      a.flash = Math.max(0, a.flash - dt * 0.8);
      if (!a.beam && a.queue.length) a.beam = { t: 0, dur: LOOK_S * (S.calm ? 0.6 : 1), act: a.queue.shift() };
      if (a.beam) {
        a.beam.t += dt;
        if (k) { const bp = beamPoint(a, k, bars); lookFan(dx, dy + r, bp, d.color); S.lit[bp.idx].v = 1; S.lit[bp.idx].c = d.color; }
        if (a.beam.t >= a.beam.dur) { const act = a.beam.act; a.beam = null; if (act) land(d, act); }
      }
      if (d.trade && k) {                                        // the tether to its entry: green while open R is up, red while down
        const t = d.trade, ex = k.X(k.idx(t.fillT)), ey = k.Y(t.entry), col = isNum(t.r) ? (t.r >= 0 ? K.up : K.down) : K.dim;
        laser(dx, dy + r, ex, ey, col, 0.9, 1.5);
        const qq = (S.now * 0.8 * sp + i * 0.33) % 1; ctx.fillStyle = '#fff'; glow('#fff', 8);
        ctx.beginPath(); ctx.arc(dx + (ex - dx) * qq, dy + r + (ey - dy - r) * qq, 1.9, 0, 7); ctx.fill(); noGlow();
      }
      /* the drone: a hexagon hull, wings, a lens that turns; the ring dashed for SHADOW, solid for LIVE */
      ctx.strokeStyle = alpha(d.color, 0.9); ctx.lineWidth = 1.3; ctx.fillStyle = '#0b0f1c';
      ctx.beginPath(); for (let j = 0; j < 6; j++) { const th = j / 6 * Math.PI * 2 + Math.PI / 6; ctx.lineTo(dx + Math.cos(th) * r, dy + Math.sin(th) * r); } ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(dx - r, dy); ctx.lineTo(dx - r * 1.9, dy - r * 0.35); ctx.moveTo(dx + r, dy); ctx.lineTo(dx + r * 1.9, dy - r * 0.35); ctx.stroke();
      const hot = a.beam || d.trade ? 1 : 0.5 + 0.25 * Math.sin(S.now * 2 + i);
      glow(d.color, 16 * hot); ctx.fillStyle = alpha(d.color, hot); ctx.beginPath(); ctx.arc(dx, dy, r * 0.38, 0, 7); ctx.fill(); noGlow();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(dx, dy, r * 0.62, a.spin, a.spin + 1.4); ctx.stroke();
      if (d.ring === 'dashed') { ctx.setLineDash([4, 4]); ctx.lineDashOffset = -a.spin * 6; }
      ctx.strokeStyle = alpha(d.color, d.ring === 'dashed' ? 0.6 : 0.85); ctx.lineWidth = d.ring === 'dashed' ? 1 : 1.4;
      ctx.beginPath(); ctx.arc(dx, dy, r * 2.2, 0, 7); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
      if (a.pulse > 0) { ctx.strokeStyle = alpha(d.color, a.pulse * 0.7); ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(dx, dy, r * 2.2 + (1 - a.pulse) * 22, 0, 7); ctx.stroke(); a.pulse = Math.max(0, a.pulse - dt / PULSE_S); }
      const tx = s.x + (slim ? 30 : 44) + r * 2.6 + 8;
      hudRight = 0;
      hud(d, a, tx, dy - (slim ? 1 : 4), s.x + s.w - 12 - tx, slim);
      s.right = hudRight;
    }
  }

  /* ---------------- the frame loop: at most 30 a second, none while nothing can be seen */
  let io = null, onScreen = true;
  if (typeof IntersectionObserver === 'function') { io = new IntersectionObserver(es => { for (const e of es) onScreen = e.isIntersecting; wake(); }); io.observe(stage); }
  /* seen: not in the background, on screen, and (looked at twice a second in the loop, at once on a wake) shown: no view over the
     layout (display none) and no panel maximized over it (visibility hidden) */
  const shown = () => stage.isConnected && stage.offsetParent !== null &&
    (typeof stage.checkVisibility === 'function' ? stage.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true }) : getComputedStyle(stage).visibility !== 'hidden');
  let shownAt = 0, shownWas = true;
  const visible = deep => {
    if (S.destroyed || document.hidden || !onScreen) return false;
    const t = performance.now();
    if (deep || t - shownAt >= 500) { shownAt = t; shownWas = shown(); }
    return shownWas;
  };
  function frame(ts) {
    S.raf = 0;
    if (!visible(false)) { S.running = false; S.last = 0; return; }
    S.raf = requestAnimationFrame(frame);
    S.calm = calm();
    const step = 1000 / (S.calm ? CALM_FPS : FPS);
    if (S.last && ts - S.last < step - 1) return;
    const dt = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 1 / FPS;
    S.last = ts;
    const t0 = performance.now();
    snapCheck(t0);
    S.now += dt;
    tickDecode(S.calm ? dt * 4 : dt);
    if (S.popT && t0 >= S.popT) closePop();
    draw(dt);
    const ms = performance.now() - t0;
    S.frames++; S.ms.push(ms); if (S.ms.length > 240) S.ms.shift();
  }
  function wake() { if (!S.raf && visible(true)) { S.running = true; S.last = 0; S.raf = requestAnimationFrame(frame); } }
  const onVis = () => wake();
  document.addEventListener('visibilitychange', onVis);
  if (mq && mq.addEventListener) mq.addEventListener('change', onVis);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { resize(); layout(); domSync(); wake(); }) : null;
  if (ro) ro.observe(stage);

  function render() {
    if (S.destroyed) return;
    read();
    layout(); domSync();
    wake();
  }
  resize();
  render();
  return {
    render,
    destroy() { S.destroyed = true; if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; if (ro) ro.disconnect(); if (io) io.disconnect(); document.removeEventListener('visibilitychange', onVis); if (mq && mq.removeEventListener) mq.removeEventListener('change', onVis); body.innerHTML = ''; },
    /* read only, for the tests */
    state: () => {
      const ms = S.ms.slice().sort((a, b) => a - b), p = f => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * f))] : null);
      return { version: VERSION, running: S.running && !!S.raf, frames: S.frames, frameMs: { n: ms.length, mean: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null, p95: p(0.95), max: ms.length ? ms[ms.length - 1] : null },
        calm: calm(), slim: S.H < SLIM_H, size: { w: S.W, h: S.H, cw: cv.width, ch: cv.height, dpr: S.dpr },
        drones: S.model.drones.map(d => ({ key: d.key, name: d.name, letter: d.letter, color: d.color, ring: d.ring, mode: d.mode, state: d.state, trade: d.trade ? Object.assign({}, d.trade) : null, looks: d.looks, beam: !!(S.anim.get(d.key) || {}).beam, queued: ((S.anim.get(d.key) || {}).queue || []).length })),
        shown: S.slots.map(s => s.d.key), slots: S.slots.map(s => ({ key: s.d.key, x: s.x, w: s.w, right: s.right || 0 })), idle: S.model.idle.slice(), beacons: S.beacons.map(b => ({ t: b.t, p: b.p })), feed: { who: whoEl.textContent, text: S.decode ? S.decode.text : txtEl.textContent }, pop: S.pop ? Object.assign({}, S.pop) : null,
        bars: (S.kBars || []).length, barsRoot: (bw() || {}).root || null, root: SKY_ROOT };
    },
    /* for the tests: reset the frame times */
    resetStats() { S.ms = []; S.frames = 0; },
  };
}

window.AgentsSky = { mount, VERSION };
})();
