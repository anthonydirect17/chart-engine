/*
 * The planner on the chart page (chart 1.62.0, Anthony 2026-11-21; the rules are PlannerCore's, live/planner-core.js). Mounted by
 * the workspace inside its start guard, so a failure here never stops the charts or the ticket.
 *
 *   PlannerPage.mount(env) -> { message(m), flattened(root), override(what, on), ticketArmed(on), sentManual(msg), pressOff(id),
 *                               armTool(chart), available(), state(), destroy() }
 *
 * What Anthony sees:
 *   - the Plan tool (the drawing ring's fifth button): a click on a chart draws a plan there (entry at the click, the stop and
 *     target 1 from the ticket's bracket for that instrument, its qty and account). Its lines are on every chart of that
 *     instrument, any timeframe, in every window (decision 1 A); before Arm they drag on any of them;
 *   - the plan card on the chart it was drawn or clicked on: side, entry type, expiry (1 to 30 minutes, 30), qty, account
 *     (the ticket's to start; one account, never a group), grade (A+, A, B; A+), Submit, Arm, Cancel, and Planner off;
 *   - Submit stamps it at The Desk (any hour); Arm stamps `arm` (CME open only; The Desk answers when it expires) and turns the
 *     ticket's Armed off (the light lock: Flatten, Flatten all and Cut half still work); Cancel before the fill.
 * Behind it: one window on this PC is the leader (PlannerCore.createLeader): it sends the entry through TradeCore's sendPlanOrder
 * (the send journal written first), watches touch, confirmation, stop-through and expiry from the trades, resumes after a reload,
 * and records every fact at The Desk (queued in this browser while The Desk does not answer). Every window may Cancel.
 * With a Desk that has no plan log (an older Desk) or a ChartBridge that does not name this PC, the planner says so where it is
 * used (the Plan tool) and hides: no plan is drawn or kept.
 *
 * env { PC, U, core, hub, storage, channel (a TicketLink-style channel or null), locks, deskBase(), fetch, pcName() (a promise),
 *       charts() [{ id, root, chart, stage }], tickOf(root), pointValue(root), contract(root), ticketAccount(), ticketRoot(),
 *       holdsTicket(), bracket(root) { stop, target }, qty(root), accounts(), maxQty(root), maxBracketTicks(), orderTypes(),
 *       execs() [fills], note(text, level), alarm(text), now() }
 */
(function (root) {
'use strict';
const REFRESH_MS = 5000, FLUSH_MS = 5000, LEAD_MS = 250, ENDED_KEEP_MS = 60000;

function mount(env) {
  const PC = env.PC || root.PlannerCore;
  const U = env.U, core = env.core, store = env.storage, now = typeof env.now === 'function' ? env.now : () => Date.now();
  const S = {
    ok: null, why: 'Asking The Desk for its plan log...', pc: '', desk: PC.deskApi({ base: env.deskBase, fetch: env.fetch }),
    sel: '', offAsk: 0, card: null, cardAt: null, lines: new Map(), plans: new Map(), drafts: new Map(), lead: new Map(),
    hooked: new WeakSet(), drawnKey: new Map(), timers: [], destroyed: false, deskDown: false, notes: [],
    orderUid: new Map(), claimed: new Set(), lockSeen: new Set(),   // an order's plan (by its page id), exec ids claimed, plans seen armed
  };
  const journal = PC.createJournal(store, now), queue = PC.createQueue(store, now);
  const say = (text, level) => { S.notes.push(text); if (S.notes.length > 40) S.notes.shift(); if (S.card) cardNote(text, level); else env.note(text, level); };

  /* ---------------- the plans every window shows (PlannerCore.createShared) */
  const shared = PC.createShared({ storage: store, channel: env.channel, onMessage: m => {
    if (m.t === 'changed' || m.t === 'stamped') { pull(); if (m.t === 'stamped') refresh(); }
    if (m.t === 'armOff') lightLock();
  } });
  function pull() {
    const s = shared.read();
    S.drafts = new Map(Object.entries(s.drafts));
    S.plans = new Map(Object.entries(s.plans).filter(([, p]) => !S.pc || p.pc === S.pc));
    lockOnSight(); draw(); renderCard();
  }
  const planList = () => [...S.plans.values()].map(p => Object.assign({}, p, PC.phaseOf({ events: p.events })));
  const getPlan = uid => { const p = S.plans.get(uid); return p ? Object.assign({}, p, PC.phaseOf({ events: p.events })) : null; };
  /* a fact recorded here: kept with the plan at once (every window sees it), queued for The Desk */
  function fact(uid, kind, detail) {
    const p = S.plans.get(uid); if (!p) return;
    const item = queue.add(p.seq, kind, detail || {});
    if (!item) return;
    shared.change(s => { const q = s.plans[uid]; if (q) q.events = (q.events || []).concat([{ kind, at: now(), detail: detail || {}, uid: item.uid }]); if (q && PC.END_KINDS.includes(kind)) q.endedAt = now(); });
    pull(); flush();
  }
  /* a cancel The Desk did not answer goes again by its own route; every other fact by /events */
  function flush() {
    queue.flush(item => (item.kind === 'cancel' ? S.desk.cancel(item.seq, item.uid, item.detail && item.detail.reason) : S.desk.event(item)).then(r => {
      if (r.notLive) { off409(); return 'later'; }
      return r.ok ? 'ok' : r.status === 0 ? 'later' : r.status === 404 && !S.ok ? 'later' : 'drop';
    }));
  }
  /* a write refused because The Desk is not the live one: it keeps no plan log here (as an older Desk) */
  function off409() { S.ok = false; S.why = 'The Desk has no live plan log here (it is not the live Desk): the planner is off.'; S.drawnKey.clear(); draw(); renderCard(); }
  /* a plan The Desk answered with (Submit, Arm, Cancel, Edit, the list): kept with the facts of this browser it does not have yet */
  function mergeDesk(s, p) {
    const was = s.plans[p.uid];
    const deskUids = new Set(p.events.map(e => e.uid).filter(Boolean)), kinds = new Set(p.events.map(e => e.kind));
    const local = was && Array.isArray(was.events) ? was.events.filter(e => e.uid && !deskUids.has(e.uid) && !(e.local && kinds.has(e.kind))) : [];
    s.plans[p.uid] = Object.assign({}, p, { t0: was ? was.t0 : null, events: p.events.concat(local), endedAt: was ? was.endedAt : null });
    delete s.drafts[p.uid];
  }
  function takePlan(r) { const p = r && r.body ? PC.fromDesk(r.body.plan) : null; if (p) shared.change(s => mergeDesk(s, p)); return p; }

  /* ---------------- The Desk's plan log */
  function refresh() {
    if (!S.pc || S.destroyed) return Promise.resolve();
    return S.desk.list(S.pc).then(r => {
      if (r.none) { S.ok = false; S.why = 'The Desk has no plan log (an older Desk): the planner is off.'; draw(); renderCard(); return; }
      if (!r.ok) { S.deskDown = true; if (S.ok === null) S.why = 'The Desk did not answer: the planner waits for it.'; return; }
      /* R12 finding 11: The Desk says its plan log is not live here (not the live Desk): the planner is off until it says live */
      if (r.body && r.body.live === false) { if (S.ok !== false) off409(); return; }
      S.ok = true; S.deskDown = false; S.why = '';
      const got = new Map();
      for (const v of (r.body && Array.isArray(r.body.plans) ? r.body.plans : [])) { const p = PC.fromDesk(v); if (p && p.pc === S.pc) got.set(p.uid, p); }
      shared.change(s => {
        for (const p of got.values()) mergeDesk(s, p);
        for (const [uid, p] of Object.entries(s.plans)) {   // not in the live list: ended at The Desk (kept a minute to show why), or this PC's only
          if (got.has(uid)) continue;
          const ph = PC.phaseOf({ events: p.events }).phase;
          if (ph !== 'ended' && !p.events.some(e => e.local)) { p.events = p.events.concat([{ kind: 'ended', at: now(), detail: {}, uid: '' }]); p.endedAt = now(); }
          if (p.endedAt && now() - p.endedAt > ENDED_KEEP_MS && !queue.items().some(x => x.seq === p.seq)) delete s.plans[uid];
        }
      });
      pull();
    });
  }

  /* ---------------- prices: one line per instrument with a plan (the window's feed, read only) */
  function line(rootName) {
    let L = S.lines.get(rootName);
    if (L) return L;
    L = { root: rootName, last: null, at: 0, lastU: 0, lastUAt: 0, firstU: 0, ticks: [], bars: [], sock: null, ready: false };
    S.lines.set(rootName, L);
    try { L.sock = env.hub.open(rootName); } catch (e) { return L; }
    L.sock.onmessage = ev => {
      const m = ev.message; if (!m || m.root !== rootName) return;
      if (m.type === 'tick' && isFinite(+m.p)) {
        /* R12 finding 2: a trade's own time (u) only; one older than the newest seen is a replay and is dropped, so the last price
           and the watches never go back in time (the same trade again changes nothing) */
        const u = +m.u;
        if (!(u > 0) || u < L.lastU) return;
        L.lastU = u; L.lastUAt = now(); L.last = +m.p; L.at = now();
        if (!L.firstU) L.firstU = u;
        /* the last 5 minutes of trades: a plan armed meanwhile is watched from its Arm, trade by trade (resume) */
        L.ticks.push({ u, p: +m.p });
        if (L.ticks.length > 4000 || (L.ticks.length > 64 && L.ticks[0].u < u - 300000)) L.ticks.splice(0, Math.max(1, L.ticks.findIndex(t => t.u >= u - 300000)));
        onTrade(rootName, +m.p, u);
      }
      else if (m.type === 'ready') L.ready = true;                 // the history is whole: a resume may read it
      else if (m.type === 'history' && Array.isArray(m.bars)) {
        const off = (U.zoneSeconds(now() / 1000) - now() / 1000) * 1000;   // New York wall time to UTC
        for (const b of m.bars) if (Array.isArray(b)) L.bars.push({ t: b[0] * 1000 - off, h: +b[2], l: +b[3], c: +b[4] });
        if (L.bars.length > 2000) L.bars.splice(0, L.bars.length - 2000);
        const lb = m.bars[m.bars.length - 1]; if (lb && L.last === null) L.last = +lb[4];
      }
    };
    L.sock.onopen = () => {};
    const sub = () => { try { L.sock.send({ type: 'subscribe', root: rootName, days: 1, tickHours: 0 }); } catch (e) { /* closed */ } };
    const was = L.sock.onmessage;
    L.sock.onmessage = ev => { if (ev.message && ev.message.type === 'hello') { L.bars = []; L.ready = false; sub(); } was(ev); };
    L.sock.onclose = () => { if (S.lines.get(rootName) === L) S.lines.delete(rootName); };
    return L;
  }
  const lastOf = r => { const L = S.lines.get(r); if (L && L.last !== null && now() - L.at < 300000) return L.last; for (const c of env.charts()) if (c.root === r) { const b = c.chart.lastBar(); if (b) return b.c; } return null; };

  /* ---------------- drawing: every chart of the instrument, every window (the engine's plan layer) */
  function viewList() {
    const out = [];
    for (const d of S.drafts.values()) out.push(Object.assign({ _p: d }, PC.viewOf(d, now(), d.uid === S.sel)));
    for (const p of planList()) { const v = PC.viewOf(p, now(), p.uid === S.sel); if (v.state !== 'ended' || p.uid === S.sel) out.push(Object.assign({ _p: p }, v)); }
    return out;
  }
  function draw() {
    const on = S.ok === true && !!S.pc;
    const views = on ? viewList() : [];
    for (const c of env.charts()) {
      hook(c);
      const mine = views.filter(v => v._p.root === c.root).map(v => { const x = Object.assign({}, v); delete x._p; return x; });
      const key = JSON.stringify(mine);
      if (S.drawnKey.get(c.chart) === key) continue;
      S.drawnKey.set(c.chart, key);
      c.chart.setPlans(mine);
    }
    for (const r of new Set(views.map(v => v._p.root))) line(r);
  }
  function hook(c) {
    if (S.hooked.has(c.chart)) return;
    S.hooked.add(c.chart);
    c.chart.on('planCreate', e => guard(() => create(c, e)));
    c.chart.on('planMove', e => guard(() => moved(e)));
    c.chart.on('planSelect', e => guard(() => select(e.id, c)));
    c.chart.on('planPressOff', e => guard(() => { select(e.id, c); const p = getPlan(e.id); say(p ? 'Plan #' + p.seq + ' is ' + p.phase + ': its lines are set. Cancel it on the plan card, or Flatten.' : 'That plan cannot be changed now.', 'warn'); }));
  }
  const guard = fn => { try { fn(); } catch (e) { try { console.error('planner', e); } catch (x) { /* none */ } } };

  /* ---------------- drawn plans (drafts) */
  function create(c, e) {
    if (!available()) { say(S.why || 'The planner is off.', 'warn'); return; }
    if (PC.offIn(store)) { say('Planner is off in this browser: switch it on on the plan card.', 'warn'); return; }
    const r = c.root, tick = env.tickOf(r), last = lastOf(r), br = env.bracket(r) || {};
    const side = last !== null && e.price > last ? 'short' : 'long', dir = side === 'short' ? -1 : 1;
    const st = br.stop > 0 ? br.stop : 16, tg = br.target > 0 ? br.target : 32;
    const acct = env.ticketAccount();
    const d = PC.cleanDraft({ uid: PC.newUid(), root: r, side, entry: PC.roundTo(e.price, tick), stop: PC.roundTo(e.price - dir * st * tick, tick), target: PC.roundTo(e.price + dir * tg * tick, tick),
      qty: env.qty(r) || 1, account: acct && !/^group:/.test(acct) ? acct : '', entryType: 'limit', expiryMin: PC.EXPIRY_DEFAULT, grade: PC.GRADE_DEFAULT, t0: e.t, contract: env.contract(r), tick, at: now() });
    shared.change(s => { s.drafts[d.uid] = d; });
    pull(); select(d.uid, c);
  }
  function moved(e) {
    const d = S.drafts.get(e.id);
    if (d) { shared.change(s => { if (s.drafts[e.id]) Object.assign(s.drafts[e.id], { entry: e.entry, stop: e.stop, target: e.target }); }); pull(); return; }
    const p = getPlan(e.id);
    if (!p || p.phase !== 'submitted') { draw(); return; }
    S.desk.edit(p.seq, { uid: PC.newUid(), entry: e.entry, stop: e.stop, target: e.target }).then(r => {
      if (r.notLive) { off409(); return; }
      if (!r.ok) { say('Not changed: ' + r.why + '.', 'warn'); S.drawnKey.clear(); draw(); return; }
      takePlan(r); shared.tell({ t: 'stamped', uid: e.id }); pull();
    });
  }

  /* ---------------- the card */
  function select(uid, c) {
    S.sel = uid;
    if (c && c.stage) S.cardAt = c.stage;
    S.drawnKey.clear(); draw(); renderCard(true);
  }
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function cardNote(text, level) {
    const el = S.card && S.card.querySelector('[data-pl="note"]'); if (!el) { env.note(text, level); return; }
    el.textContent = text || ''; el.className = 'tk-note' + (level ? ' ' + level : ''); el.title = text || '';
  }
  function renderCard(force) {
    const d = S.drafts.get(S.sel), p = d ? null : getPlan(S.sel), it = d || p;
    if (!it || !S.cardAt || !S.cardAt.isConnected) { if (S.card) { S.card.remove(); S.card = null; } return; }
    const phase = d ? 'draft' : p.phase, open = phase === 'draft' || phase === 'submitted', off = PC.offIn(store);
    const key = JSON.stringify([it, phase, off, env.accounts(), !!(p && phase === 'ended' && sentOf(p) && entryOrderOf(p))]);   // a cancel under way shows
    if (S.card && S.card.parentElement === S.cardAt && S.card.dataset.key === key && !force) return;
    const keepNote = S.card ? S.card.querySelector('[data-pl="note"]').textContent : '';
    if (!S.card) { S.card = document.createElement('section'); S.card.className = 'obar tk-bar mini-tk pl-card'; S.card.setAttribute('aria-label', 'Plan'); S.card.addEventListener('click', onCard); S.card.addEventListener('change', onCardChange); }
    if (S.card.parentElement !== S.cardAt) S.cardAt.appendChild(S.card);
    S.card.dataset.key = key;
    const accts = env.accounts().filter(a => !/^group:/.test(a));
    if (it.account && !accts.includes(it.account)) accts.unshift(it.account);
    const g = U.planGeometry(it, it.tick || env.tickOf(it.root));
    const dis = open && !off ? '' : ' disabled';
    const title = (p ? 'Plan #' + p.seq : 'New plan') + ' · ' + it.root;
    const words = phase === 'draft' ? 'Drawn, not submitted' : phase === 'submitted' ? 'Submitted: Arm sends it' : phase === 'armed' ? 'Armed' + (p.expiresAt ? ': ends ' + new Date(p.expiresAt).toLocaleTimeString() : '')
      : phase === 'working' ? 'Working at ChartBridge' : phase === 'filled' ? 'Filled: its stop and target are in ChartBridge. Flatten closes it.'
      : sentOf(p) && entryOrderOf(p) ? 'Cancelling: its entry is being taken off at ChartBridge' : 'Ended: ' + (PC.WHY_WORDS[p.why] || p.why);
    S.card.innerHTML = `<div class="tk-row mt-head"><span class="mt-root">PLAN</span><span class="pl-title" data-pl="title">${esc(title)}</span><span class="mt-fill"></span><button type="button" class="mt-ic" data-pl="close" data-keep aria-label="Close the plan card" title="Close the card (the plan stays)">&#x2715;</button></div>
      <div class="tk-row pl-row"><span class="seg sans pl-side" role="group" aria-label="Side">${['long', 'short'].map(s => `<button type="button" data-pl="side" data-v="${s}" aria-pressed="${it.side === s}"${dis}>${s === 'long' ? 'Long' : 'Short'}</button>`).join('')}</span>
        <select class="acct-sel pl-type" data-pl="type" aria-label="Entry type"${dis}>${PC.ENTRY_TYPES.map(t => `<option value="${t}"${t === it.entryType ? ' selected' : ''}>${esc(PC.ENTRY_WORDS[t])}</option>`).join('')}</select></div>
      <div class="tk-row pl-row"><span class="glabel">Qty</span><select class="acct-sel oqty" data-pl="qty" aria-label="Plan quantity"${dis}>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<option value="${n}"${n === it.qty ? ' selected' : ''}>${n}</option>`).join('')}</select>
        <span class="glabel">Expires</span><input class="oin pl-exp" data-pl="exp" type="number" min="1" max="30" step="1" value="${it.expiryMin}" aria-label="Expiry in minutes from Arm, 1 to 30"${dis}><span class="ounit">min</span></div>
      <div class="tk-row pl-row"><span class="glabel">Account</span><select class="acct-sel" data-pl="acct" aria-label="Account the plan trades on"${dis}><option value="">Pick an account</option>${accts.map(a => `<option value="${esc(a)}"${a === it.account ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select></div>
      <div class="tk-row pl-row"><span class="glabel">Grade</span><span class="seg sans pl-grade" role="group" aria-label="Grade">${PC.GRADES.map(x => `<button type="button" data-pl="grade" data-v="${x}" aria-pressed="${it.grade === x}"${dis}>${x}</button>`).join('')}</span>
        <span class="oinfo pl-rr" data-pl="rr">${g.riskTicks ? 'SL ' + g.riskTicks + 't' : ''}${g.rewardTicks ? ' · TP ' + g.rewardTicks + 't' : ''}${g.rr ? ' · ' + g.rr.toFixed(1) + 'R' : ''}</span></div>
      <div class="tk-row tk-three pl-btns"><button type="button" class="btn" data-pl="submit"${phase === 'draft' && !off ? '' : ' disabled'} title="Stamp the plan at The Desk (any hour)">Submit</button>
        <button type="button" class="obtn buy pl-arm" data-pl="arm"${phase === 'submitted' && !off ? '' : ' disabled'} title="Arm: The Desk stamps it, the ticket's Armed goes off, and this PC sends the entry">Arm</button>
        <button type="button" class="btn" data-pl="cancel"${phase === 'filled' || phase === 'ended' ? ' disabled' : ''} title="Cancel the plan before its fill (its working entry is cancelled)">Cancel</button></div>
      <div class="tk-state ostate"><span class="oinfo pl-phase" data-pl="phase">${esc(words)}</span><span class="tk-note" data-pl="note" role="status"></span>
        <label class="pl-off"><input type="checkbox" data-pl="off" data-keep${off ? ' checked' : ''}> Planner off</label></div>`;
    if (keepNote) cardNote(keepNote);
  }
  function editDraft(fn) { const uid = S.sel; if (!S.drafts.has(uid)) return false; shared.change(s => { if (s.drafts[uid]) fn(s.drafts[uid]); }); pull(); return true; }
  function editSubmitted(change) {
    const p = getPlan(S.sel); if (!p || p.phase !== 'submitted') return;
    S.desk.edit(p.seq, Object.assign({ uid: PC.newUid() }, change)).then(r => {
      if (r.notLive) { off409(); return; }
      if (!r.ok) { say('Not changed: ' + r.why + '.', 'warn'); renderCard(true); return; }
      takePlan(r); shared.tell({ t: 'stamped', uid: p.uid }); pull();
    });
  }
  /* the other side: the stop and target mirrored about the entry (their distances kept) */
  function flip(it) { return { side: it.side === 'short' ? 'long' : 'short', stop: 2 * it.entry - it.stop, target: 2 * it.entry - it.target }; }
  function onCard(e) {
    const b = e.target.closest('[data-pl]'); if (!b || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
    const what = b.dataset.pl;
    if (what === 'close') { S.sel = ''; renderCard(); S.drawnKey.clear(); draw(); return; }
    if (e.detail === 0 && ['submit', 'arm', 'cancel'].includes(what)) { cardNote('The plan\'s buttons work by click only, not by keyboard.', 'warn'); return; }
    if (what === 'side') { const it = S.drafts.get(S.sel) || getPlan(S.sel); if (!it || it.side === b.dataset.v) return; const f = flip(it); if (!editDraft(d => Object.assign(d, { side: f.side, stop: f.stop, target: f.target }))) editSubmitted({ side: f.side, stop: f.stop, target: f.target }); return; }
    if (what === 'grade') { if (!editDraft(d => { d.grade = b.dataset.v; })) editSubmitted({ grade: b.dataset.v }); return; }
    if (what === 'submit') submit(S.sel);
    else if (what === 'arm') arm(S.sel);
    else if (what === 'cancel') cancel(S.sel);
  }
  function onCardChange(e) {
    const t = e.target, what = t.dataset.pl;
    if (what === 'off') { PC.setOff(store, t.checked); shared.tell({ t: 'changed' }); say(t.checked ? 'Planner off in this browser: no plan is drawn, submitted or armed, and no entry is sent. A working entry stays: Cancel it here, or Flatten.' : 'Planner on.', ''); renderCard(true); return; }
    const val = what === 'qty' ? +t.value : what === 'exp' ? Math.round(+t.value) : t.value;
    if (what === 'exp' && !(val >= PC.EXPIRY_MIN && val <= PC.EXPIRY_MAX)) { cardNote('Expiry must be 1 to 30 minutes.', 'warn'); renderCard(true); return; }
    const map = { type: ['entryType', 'entry_type'], qty: ['qty', 'qty'], exp: ['expiryMin', 'expiry_min'], acct: ['account', 'account'] }[what];
    if (!map) return;
    if (!editDraft(d => { d[map[0]] = val; })) editSubmitted({ [map[1]]: val });
  }
  const ctxOf = r => ({ tick: env.tickOf(r), maxQty: env.maxQty(r), maxBracketTicks: env.maxBracketTicks(), accounts: env.accounts() });
  function submit(uid) {
    const d = S.drafts.get(uid); if (!d) return;
    if (!available()) { say(S.why, 'warn'); return; }
    const why = PC.validate(d, ctxOf(d.root)) || (d.contract || env.contract(d.root) ? '' : 'ChartBridge has not named the ' + d.root + ' contract yet.');
    if (why) { cardNote('Not submitted: ' + why, 'warn'); return; }
    if (!d.contract) d.contract = env.contract(d.root);
    cardNote('Submitting to The Desk...', '');
    S.desk.submit(PC.submitBody(d, S.pc)).then(r => {
      if (r.notLive) { off409(); cardNote('Not submitted: ' + S.why, 'error'); return; }
      if (!r.ok) { cardNote('Not submitted: ' + r.why + '.', 'error'); return; }
      const p = r.body ? PC.fromDesk(r.body.plan) : null;
      if (!p) { cardNote('Not submitted: The Desk\'s answer was not a plan.', 'error'); return; }
      shared.change(s => { mergeDesk(s, p); s.plans[p.uid].t0 = d.t0; delete s.drafts[uid]; });
      shared.tell({ t: 'stamped', uid }); pull();
      cardNote('Plan #' + p.seq + ' submitted. Arm sends it.', '');
    });
  }
  function arm(uid) {
    const p = getPlan(uid); if (!p || p.phase !== 'submitted') return;
    if (PC.offIn(store)) { cardNote('Planner is off in this browser.', 'warn'); return; }
    const closedWhy = PC.armClosedWhy(U.zoneSeconds(now() / 1000), U.cmeClosed);
    if (closedWhy) { cardNote(closedWhy, 'warn'); return; }
    const why = PC.validate(p, ctxOf(p.root)) || (core.readyPlan(p) ? 'not armed: ' + core.readyPlan(p) : '');
    if (why) { cardNote('Not armed: ' + why.replace(/^not armed: /, ''), 'warn'); return; }
    const last = lastOf(p.root), ent = PC.entryFor(p, last, env.orderTypes());
    if (ent.refuse) { cardNote(ent.refuse, 'warn'); return; }
    /* R12 finding 5: the entry is fixed here, at Arm, and kept with the arm fact; the leader sends exactly this */
    const armUid = PC.newUid();
    cardNote('Arming at The Desk...', '');
    const armed = (r, how) => {
      const got = takePlan(r);
      if (!got || got.phase !== 'armed' || !got.entryKind) { cardNote('The Desk\'s answer did not show the plan armed: not armed here.', 'error'); refresh(); return; }
      lightLock(); shared.tell({ t: 'armOff' }); shared.tell({ t: 'stamped', uid }); pull();
      cardNote('Plan #' + p.seq + ' armed' + (got.expiresAt ? ' until ' + new Date(got.expiresAt).toLocaleTimeString() : '') + (how || '') + '. The ticket\'s Armed is off; Flatten still works.', '');
      lead();
    };
    S.desk.arm(p.seq, armUid, PC.armDetail(ent, last)).then(r => {
      if (r.notLive) { off409(); cardNote('Not armed: ' + S.why, 'error'); return; }
      if (r.ok) { armed(r); return; }
      if (r.status !== 0) { cardNote('Not armed: ' + r.why + '.', 'error'); return; }
      /* R12 finding 3: no answer: read the plan back before saying anything (the Arm may have been stamped) */
      cardNote('The Desk did not answer the Arm: reading the plan back...', 'warn');
      S.desk.get(p.seq).then(g => {
        const back = g.ok && g.body ? PC.fromDesk(g.body.plan) : null;
        if (back && back.phase === 'armed') { armed(g, ' (read back after The Desk did not answer)'); return; }
        if (back) { takePlan(g); pull(); cardNote('The Desk did not answer: not armed.', 'error'); return; }
        cardNote('The Desk did not answer the Arm or the read back: it may be armed. The card shows it as The Desk says once it answers.', 'error'); refresh();
      });
    });
  }
  function cancel(uid) {
    if (S.drafts.has(uid)) { shared.change(s => { delete s.drafts[uid]; }); S.sel = ''; pull(); return; }
    const p = getPlan(uid); if (!p || p.phase === 'filled' || p.phase === 'ended') return;
    /* the working entry goes at once, from this window (any window may cancel by id); the leader keeps at it until ChartBridge
       says it is gone (R12 finding 1) */
    const o = entryOrderOf(p), wasSent = sentOf(p);
    if (o) { const r = cancelEntry(p, o); if (!r.sent) cardNote('The entry\'s cancel was not sent: ' + r.why + ' Cancel it in NinjaTrader, or Flatten.', 'error'); }
    const said = () => (wasSent && entryOrderOf(p) ? 'Cancelling plan #' + p.seq + ': its entry is being taken off at ChartBridge.' : 'Plan #' + p.seq + ' cancelled.');
    S.desk.cancel(p.seq, PC.newUid(), 'Cancel on the plan card').then(r => {
      if (r.ok) { takePlan(r); shared.change(s => { const q = s.plans[uid]; if (q) q.endedAt = now(); }); shared.tell({ t: 'stamped', uid }); pull(); cardNote(said(), ''); return; }
      if (r.status === 0) { fact(uid, 'cancel', { reason: 'Cancel on the plan card (The Desk did not answer at first)' }); cardNote(said() + ' The Desk did not answer; it is told when it does.', 'warn'); return; }
      cardNote('The Desk refused the cancel: ' + r.why + '.', 'error');
    });
  }
  const isWorking = o => !!o && (o.state === 'working' || o.state === 'partFilled' || o.state === 'accepted');
  /* was the plan's entry sent (this browser's journal, or The Desk's sent fact)? { cid, at } or null */
  const sentOf = p => journal.sentOf(p.uid) || (() => { const e = (p.events || []).find(x => x.kind === 'sent' && (!x.detail || (x.detail.leg || 'entry') === 'entry')); return e ? { cid: (e.detail && e.detail.cid) || PC.entryCid(p.uid), at: e.detail && isFinite(+e.detail.at_ms) ? +e.detail.at_ms : e.at || 0 } : null; })();
  /* the delta review, finding 1: an order is the plan's entry only if it IS that order: its account, root, side, the kind fixed at
     Arm, its price and its qty, and no other cid. ChartBridge's ids start again after a NinjaTrader restart, so an id alone is
     never trusted (an unrelated order can take an old id) */
  const entryKinds = p => (p.entryKind === 'market_on_confirm' ? ['market'] : p.entryKind ? [p.entryKind] : []);
  const matchesEntry = (o, p) => !!o && o.account === p.account && o.root === p.root && o.side === (p.side === 'short' ? 'sell' : 'buy') &&
    entryKinds(p).includes(o.kind) && (o.kind === 'market' || Math.abs(+o.price - p.entry) < 1e-9) && +o.qty === p.qty && !(o.cid && o.cid !== PC.entryCid(p.uid));
  /* the plan's working entry: by the id the leader linked it by (since ChartBridge's last whole snapshot) or by its cid, and only
     when it still matches the entry. A new id is linked by relink() alone (resume), never here. */
  function entryOrderOf(p) {
    const ws = [...core.TR.orders.values()].filter(isWorking), st = S.lead.get(p.uid);
    const o = (st && st.orderId && ws.find(x => x.id === st.orderId)) || ws.find(x => x.cid === PC.entryCid(p.uid)) || null;
    if (!o || !matchesEntry(o, p)) return null;
    S.orderUid.set(o.id, p.uid); if (st) st.orderId = o.id;
    return o;
  }
  /* after ChartBridge's whole snapshot: the entry found again by its cid, or (the cids gone after a restart) by the attribute match,
     never an order another plan has or an order with another cid; the one place a new id is linked */
  function relink(p, st, id) {
    st.relinked = true;
    const ws = [...core.TR.orders.values()].filter(isWorking);
    const o = (id && ws.find(x => x.id === id)) || ws.find(x => x.cid === PC.entryCid(p.uid)) ||
      ws.find(x => matchesEntry(x, p) && !(S.orderUid.has(x.id) && S.orderUid.get(x.id) !== p.uid) && (x.role === 'entry' || x.role === 'other' || !x.role)) || null;
    if (!o || !matchesEntry(o, p)) return null;
    S.orderUid.set(o.id, p.uid); st.orderId = o.id;
    return o;
  }
  /* every cancel of a plan's entry goes through here: the order is read again by its id and must still be the plan's entry; an
     order that fails the check is never cancelled (said, as an alarm) */
  function cancelEntry(p, o) {
    const now0 = o ? core.TR.orders.get(o.id) : null;
    if (!now0 || !matchesEntry(now0, p)) { if (o) alarm('Plan #' + p.seq + ': order ' + o.id + ' no longer matches its entry: not cancelled. Check NinjaTrader.'); return { sent: false, why: 'not the plan\'s entry' }; }
    return core.cancelPlanOrder(now0.id, p);
  }
  /* R12 finding 2 and 6: the newest trade's own time per instrument, run on from it: the clock a minute's close is judged on */
  const tradeNow = r => { const L = S.lines.get(r); return L && L.lastU > 0 ? L.lastU + Math.max(0, now() - L.lastUAt) : now(); };
  /* R12 finding 3: the light lock whenever a plan is first seen armed in this window (whichever window pressed Arm) */
  function lightLock() { if (env.holdsTicket() && core.TR.armed) { core.setArmed(false); env.note('Armed turned off: a plan is armed (the planner\'s light lock). Flatten, Flatten all and Cut half still work.', 'warn'); } }
  function lockOnSight() {
    for (const p of planList()) {
      if (!['armed', 'working'].includes(p.phase) || S.lockSeen.has(p.uid)) continue;
      S.lockSeen.add(p.uid); lightLock();
    }
  }

  /* ---------------- the leader: sends, watches, resumes, finishes cancels (only the window holding the lock) */
  const leader = PC.createLeader({ locks: env.locks, onLead: () => { for (const st of S.lead.values()) st.resumed = false; lead(); } });
  const LS = uid => { let st = S.lead.get(uid); if (!st) S.lead.set(uid, st = { resumed: false, watch: null, orderId: '', placed: false, filled: false, lastPrice: null, posSeen: false, resumedFilled: false, ntOrder: '', cancelAt: 0, cancelTries: 0, cancelDone: false }); return st; };
  let snapWas = false;
  function lead() {
    /* ChartBridge's whole snapshot again after a drop or a restart: every open plan is reconciled again (never sent again) */
    const snap = !!core.TR.snapReady;
    /* the delta review, finding 1: ChartBridge's ids are not kept across its whole snapshot (a reconnect, a NinjaTrader restart:
       its counter starts again): every id link is forgotten and found again by resume (relink) only */
    if (snap && !snapWas) { S.orderUid.clear(); for (const st of S.lead.values()) { st.resumed = false; st.cancelDone = false; st.orderId = ''; st.relinked = false; } }
    snapWas = snap;
    if (!leader.isLeader() || !S.pc || S.ok !== true) return;
    for (const p of planList()) {
      if (p.phase === 'ended') { finishCancel(p); continue; }
      if (!['armed', 'working', 'filled'].includes(p.phase)) continue;
      const st = LS(p.uid);
      /* a resume waits for ChartBridge's whole snapshot, and for an armed plan with nothing sent, the minutes since Arm too */
      if (!st.resumed) { if (!core.TR.snapReady || !core.TR.enabled || (p.phase === 'armed' && !sentOf(p) && !line(p.root).ready)) continue; resume(p, st); continue; }
      step(p, st);
    }
  }
  /* R12 finding 1: a plan that ended with its entry sent and not filled: its entry is cancelled until ChartBridge says it is gone */
  function finishCancel(p) {
    const st = LS(p.uid);
    if (st.cancelDone || st.filled || !sentOf(p) || (p.events || []).some(e => e.kind === 'filled') || !core.TR.snapReady) return;
    const o = st.relinked ? entryOrderOf(p) : relink(p, st);           // after a new snapshot: found again once, then by its id
    if (!o) { if (now() - (sentOf(p).at || 0) > 30000) st.cancelDone = true; return; }   // gone (a fresh send may not show yet)
    if (now() - st.cancelAt < 2000) return;
    st.cancelAt = now(); st.cancelTries++;
    const r = cancelEntry(p, o);
    if (st.cancelTries === 5) alarm('Plan #' + p.seq + ' ended, but its entry ' + o.id + ' is still working after 5 cancels' + (r.sent ? '' : ' (' + r.why + ')') + ': cancel it in NinjaTrader, or Flatten.');
  }
  function resume(p, st) {
    st.resumed = true; st.watch = null; st.unknown = false;
    const L = line(p.root);
    /* armed while this window saw the trades (after its first live trade): the trades since Arm only, fed to the watch one by one
       (a minute bar would count the trades before Arm in its minute). Armed before that: the minutes since Arm that began before
       its first live trade too (the careful side: a touch there is counted), then the trades */
    const bars = L.firstU && isFinite(p.armedAt) && p.armedAt >= L.firstU ? [] : L.firstU ? L.bars.filter(b => b.t < L.firstU) : L.bars;   // armed while this window watched: its trades only
    const r = PC.reconcile(p, { now: now(), tick: p.tick || env.tickOf(p.root), journal: journal.sentOf(p.uid), orders: [...core.TR.orders.values()], execs: env.execs(), bars });
    if (r.act === 'expired' || r.act === 'stop_through' || r.act === 'missed') {
      /* the delta review, finding 4: a minute bar of the Arm minute holds the trades just before Arm too: said */
      const armMin = isFinite(p.armedAt) ? Math.floor(p.armedAt / 60000) * 60000 : null;
      const maybe = r.act !== 'expired' && armMin !== null && bars.some(b => b.t === armMin) ? ' (it may be a touch from just before Arm: the minute\'s bar cannot tell)' : '';
      fact(p.uid, r.act, { why: r.why + maybe, on: 'resume' }); say('Plan #' + p.seq + ': ' + r.why + maybe + '.', 'warn'); return;
    }
    if (r.act === 'resume_working') { if (!relink(p, st, r.id)) { st.unknown = true; alarm('Plan #' + p.seq + ': its entry could not be told apart from another order: check NinjaTrader. It is never sent again.'); return; } st.placed = true; watchFor(p, st, true); return; }
    if (r.act === 'cancel_expired') { const o = relink(p, st, r.id); if (o) cancelEntry(p, o); st.cancelAt = now(); fact(p.uid, 'expired', { late_ms: r.lateMs, on: 'resume', id: r.id }); say('Plan #' + p.seq + ' had expired while no window watched it: its entry is cancelled now.', 'warn'); return; }
    if (r.act === 'filled') { if (p.phase !== 'filled') { for (const id of r.execs) S.claimed.add(id); fact(p.uid, 'filled', { exec_ids: r.execs, nt_order_id: r.order, price: r.price, qty: r.qty, on: 'resume' }); } st.filled = true; st.resumedFilled = true; return; }
    if (r.act === 'none' && p.phase === 'filled') { st.filled = true; st.resumedFilled = true; return; }
    if (r.act === 'unknown') { if (!p.events.some(e => e.kind === 'owner' && e.detail && e.detail.what === 'unknown')) fact(p.uid, 'owner', { what: 'unknown', why: r.why }); alarm('Plan #' + p.seq + ': ' + r.why); st.unknown = true; return; }
    if (r.act === 'resume') {
      watchFor(p, st, false);
      for (const t of L.ticks) if (isFinite(p.armedAt) && t.u >= p.armedAt) { for (const f of st.watch.trade(t.p, t.u)) act(getPlan(p.uid) || p, st, f); if (st.watch.state().done) break; }
      /* the delta review, finding 3: nothing touched since Arm: sent in this same step (not a step later, when a trade could touch it) */
      const q = getPlan(p.uid);
      if (q && q.phase === 'armed') step(q, st);
    }
  }
  function alarm(text) { say(text, 'error'); if (typeof env.alarm === 'function') env.alarm(text); }
  function watchFor(p, st, sent) {
    const t = p.events.find(e => e.kind === 'touched');
    st.watch = PC.createWatch(p, { tick: p.tick || env.tickOf(p.root), expiresAt: p.expiresAt, sent, touched: t && isFinite(+t.at) ? Math.floor(+t.at / 60000) : null });
    line(p.root);
  }
  function step(p, st) {
    if (st.unknown) return;
    if (p.phase === 'filled') { closedYet(p, st); return; }
    if (p.phase === 'working') linkFills(p, st);
    if (!st.watch) watchFor(p, st, !!sentOf(p));
    /* R12 finding 1: expiry, a minute's close and the stop traded through are looked at BEFORE anything is sent */
    for (const f of st.watch.time(tradeNow(p.root))) act(p, st, f);
    const q = getPlan(p.uid);
    if (!q || q.phase !== 'armed' || sentOf(q) || q.entryType === 'touch_confirm') return;
    const last = lastOf(q.root), tick = q.tick || env.tickOf(q.root);
    if (last !== null && PC.throughStop(q, last, tick)) { act(q, st, { kind: 'stop_through', at: now(), price: last }); return; }
    send(q, st, false);
  }
  /* the entry fixed at Arm, sent once (the journal first). confirm: the confirmation's market order */
  function send(p, st, confirm) {
    const tick = p.tick || env.tickOf(p.root), last = lastOf(p.root);
    const refuse = why => { fact(p.uid, 'refused', { why, by: 'page' }); say('Plan #' + p.seq + ' not sent: ' + why + ' The plan ends.', 'warn'); };
    /* Planner off (this browser): no entry is sent; an armed plan waits (it still expires, ends at its stop, or is missed if its
       line is touched meanwhile); a confirmation that confirms meanwhile ends refused, never taken late */
    if (PC.offIn(store)) {
      if (confirm) refuse('the planner is off in this browser.');
      else if (st.lastWhy !== 'off') { st.lastWhy = 'off'; say('Plan #' + p.seq + ' waits: the planner is off in this browser.', 'warn'); }
      return;
    }
    const kind = confirm ? 'market' : p.entryKind;
    if (!kind || kind === 'market_on_confirm' && !confirm) { refuse('its entry was not fixed at Arm.'); return; }
    const price = kind === 'market' ? null : p.entry;
    const b = PC.bracketFor(p, kind, last, tick, env.maxBracketTicks());
    if (b.refuse) { refuse(b.refuse); return; }
    const why = core.readyPlan(p);
    if (why) {
      /* R12 finding 8: a confirmation that cannot be sent now ends refused; a resting entry waits (a touch meanwhile: missed) */
      if (confirm) { refuse(why); return; }
      if (st.lastWhy !== why) { st.lastWhy = why; say('Plan #' + p.seq + ' waits: ' + why, 'warn'); }
      return;
    }
    const cid = PC.entryCid(p.uid);
    if (!journal.mark(p.uid, cid)) { st.unknown = true; alarm('Plan #' + p.seq + ': its entry could not be written to this browser\'s send journal (or it was sent already): not sent.'); return; }
    const r = core.sendPlanOrder({ uid: p.uid, account: p.account, root: p.root, side: p.side, kind, qty: p.qty, price: price === null ? undefined : price, bracket: b }, 'entry');
    if (!r.sent) { fact(p.uid, 'refused', { why: r.why, by: 'page' }); say('Plan #' + p.seq + ' not sent: ' + r.why, 'error'); return; }
    if (st.watch) st.watch.sent();
    fact(p.uid, 'sent', { leg: 'entry', cid, kind, price, qty: p.qty, bracket_ticks: b, last, at_ms: Date.now() });
    say('Plan #' + p.seq + ': ' + (p.side === 'short' ? 'SELL ' : 'BUY ') + kind.toUpperCase() + ' ' + p.qty + ' ' + p.root + (price !== null ? ' at ' + price : '') + ' sent with ' + b.stop + ' / ' + b.target + ' ticks, on ' + p.account + '.', '');
  }
  function act(p, st, f) {
    if (f.kind === 'touched') {
      if (p.entryType === 'touch_confirm') { fact(p.uid, 'touched', { price: f.price }); return; }
      /* R12 finding 5: a resting entry not sent yet whose line was touched (the planner off, or not ready): missed, never late */
      if (!sentOf(p) && getPlan(p.uid) && getPlan(p.uid).phase === 'armed') { fact(p.uid, 'missed', { why: 'the line was touched before its entry could be sent', price: f.price }); say('Plan #' + p.seq + ' missed: its line was touched before its entry could be sent. It is not taken late.', 'warn'); }
      return;
    }
    if (f.kind === 'confirmed') { fact(p.uid, 'confirmed', { close: f.close, minute_ms: f.minute }); if (!sentOf(p)) send(getPlan(p.uid) || p, st, true); return; }
    if (f.kind === 'stop_through' || f.kind === 'expired') {
      const o = entryOrderOf(p);
      if (o) { const r = cancelEntry(p, o); st.cancelAt = now(); if (!r.sent) alarm('Plan #' + p.seq + ' ' + f.kind.replace('_', '-') + ', but its entry\'s cancel was not sent: ' + r.why + ' It is tried again; cancel it in NinjaTrader if it stays.'); }
      fact(p.uid, f.kind, { price: f.price, id: o ? o.id : '' });
      say('Plan #' + p.seq + ' ' + (f.kind === 'expired' ? 'expired' : 'ended: price went through the stop') + (o ? ': its entry is being cancelled.' : '.'), 'warn');
    }
  }
  function onTrade(r, price, ms) {
    if (!leader.isLeader()) return;
    for (const p of planList()) {
      if (p.root !== r || !['armed', 'working'].includes(p.phase)) continue;
      const st = S.lead.get(p.uid);
      if (!st || !st.resumed || !st.watch || st.unknown) continue;
      for (const f of st.watch.trade(price, ms)) act(getPlan(p.uid) || p, st, f);
    }
  }
  /* R12 finding 9: closed only once the position was seen open after the fill (or the plan was filled before this session), then flat */
  function closedYet(p, st) {
    const pos = core.TR.positions.get(p.account + '|' + p.root);
    if (pos && pos.qty) { st.posSeen = true; return; }
    if (core.TR.snapReady && (st.posSeen || st.resumedFilled) && !p.events.some(e => e.kind === 'closed')) fact(p.uid, 'closed', {});
  }
  /* R12 finding 10: the entry's fills, linked by NinjaTrader's order id: the first fill on the plan's account, root and side after
     the send (once ChartBridge shows the entry filling) names the order, and every fill of that order is the entry's. The plan is
     filled when they cover its qty, or when the entry is no longer working and some filled. BotCore's ledger is left as it is. */
  function linkFills(p, st) {
    if (st.filled || (p.events || []).some(e => e.kind === 'filled')) { st.filled = true; return; }
    const s0 = sentOf(p); if (!s0) return;
    const side = p.side === 'short' ? 'sell' : 'buy', all = env.execs();
    const o = st.orderId ? core.TR.orders.get(st.orderId) : null;
    if (!st.ntOrder) {
      if (!(st.entryFilled > 0)) return;                               // ChartBridge has not shown the entry filling yet
      /* the delta review, finding 4: only a fill that could be this entry's names its NinjaTrader order: a limit at its price or
         better, a stop or MIT, or the confirmation's market order, near the price it was sent at; never more than the plan's qty */
      const tick = p.tick || 0.25, buy = side === 'buy', near = (px, at) => isFinite(+at) && Math.abs(px - +at) <= 20 * tick;
      const sentEv = (p.events || []).find(e => e.kind === 'sent'), lastAt = sentEv && sentEv.detail ? sentEv.detail.last : null;
      const fits = f => (p.entryKind === 'limit' ? (buy ? +f.p <= p.entry + 1e-9 : +f.p >= p.entry - 1e-9) : p.entryKind === 'market_on_confirm' ? near(+f.p, lastAt === null || lastAt === undefined ? p.entry : lastAt) : near(+f.p, p.entry)) && +f.qty <= p.qty;
      const first = all.filter(f => f && f.account === p.account && f.root === p.root && f.side === side && !S.claimed.has(f.id) && +f.u >= (s0.at || 0) - 2000 && f.order && fits(f))
        .sort((a, b) => +a.u - +b.u)[0];
      if (!first) return;
      st.ntOrder = first.order;
    }
    const mine = all.filter(f => f && f.order === st.ntOrder && f.account === p.account && f.root === p.root);
    const got = mine.reduce((a, f) => a + (+f.qty || 0), 0);
    /* filled once the fills cover its qty, or the order reports how much it filled in its final state (filled, or cancelled with
       part filled) and the fills cover that */
    const final = (st.entryState === 'filled' || st.entryState === 'cancelled' || st.entryState === 'rejected') && st.entryFilled > 0 && got >= st.entryFilled;
    if (!(got >= p.qty || final)) return;
    st.filled = true;
    for (const f of mine) S.claimed.add(f.id);
    const px = mine.reduce((a, f) => a + (+f.p || 0) * (+f.qty || 0), 0) / got;
    fact(p.uid, 'filled', { exec_ids: mine.map(f => f.id).slice(0, 50), nt_order_id: st.ntOrder, price: Math.round(px / (p.tick || 0.25)) * (p.tick || 0.25), qty: got });
    if (p.phase === 'ended') alarm('Plan #' + p.seq + '\'s entry filled after the plan ended: ' + got + ' ' + p.root + ' are open on ' + p.account + ' with its stop and target. Flatten if you do not want it.');
    say('Plan #' + p.seq + ' filled: ' + got + ' ' + p.root + ' at ' + px + ' on ' + p.account + '.', '');
  }

  /* ---------------- ChartBridge's messages (this window's order connection) */
  function message(m) {
    if (!m || !m.type) return;
    if (m.type === 'order') {
      /* the plan's entry by its cid, or by the id the leader follows (after a restart its cid is gone) */
      const byCid = typeof m.cid === 'string' ? PC.uidOfCid(m.cid) : '';
      const uid = byCid || S.orderUid.get(m.id) || '';
      const p = uid ? getPlan(uid) : null;
      if (!p || !leader.isLeader()) return;
      /* the delta review, finding 1: an order known by id only (no cid) is the plan's only while it matches the entry; else the link
         goes and the message is not the plan's */
      if (!byCid && !matchesEntry(m, p)) { S.orderUid.delete(m.id); const st0 = S.lead.get(uid); if (st0 && st0.orderId === m.id) st0.orderId = ''; return; }
      S.orderUid.set(m.id, uid);
      const st = LS(uid);
      st.orderId = m.id; st.entryState = m.state;
      if (+m.filled > 0) st.entryFilled = +m.filled;
      if (!st.placed && (m.state === 'working' || m.state === 'accepted' || m.state === 'partFilled' || m.state === 'filled')) { st.placed = true; fact(uid, 'placed', { id: m.id, state: m.state }); }
      if (st.lastPrice !== null && m.price !== null && m.price !== st.lastPrice && (m.state === 'working' || m.state === 'accepted')) fact(uid, 'override', { what: 'moved_outside', account: p.account, root: p.root, id: m.id, from: st.lastPrice, to: m.price });
      if (m.price !== null && m.price !== undefined) st.lastPrice = m.price;
      if (m.state === 'rejected') { fact(uid, 'refused', { why: m.text || 'NinjaTrader rejected it', by: 'ninjatrader' }); say('Plan #' + p.seq + ': NinjaTrader rejected its entry: ' + (m.text || ''), 'error'); }
      if (m.state === 'cancelled' && !(+m.filled > 0) && ['armed', 'working'].includes(p.phase)) {
        const ours = p.events.some(e => ['cancel', 'expired', 'stop_through', 'ended'].includes(e.kind));
        if (!ours) { fact(uid, 'override', { what: 'cancelled_outside', account: p.account, root: p.root, id: m.id }); fact(uid, 'ended', { why: 'its entry was cancelled outside the planner' }); }
      }
      if (st.entryFilled > 0) linkFills(getPlan(uid) || p, st);
      return;
    }
    if (m.type === 'reject' && typeof m.cid === 'string' && PC.uidOfCid(m.cid)) {
      const uid = PC.uidOfCid(m.cid), p = getPlan(uid);
      if (p && leader.isLeader()) { fact(uid, 'refused', { why: m.reason || '', by: 'chartbridge' }); say('Plan #' + p.seq + ' refused by ChartBridge: ' + (m.reason || '') + ' The plan ends; it is not tried again.', 'error'); }
      return;
    }
    if ((m.type === 'exec' || m.type === 'execs') && leader.isLeader()) {
      for (const p of planList()) if (['working', 'armed'].includes(p.phase) || (p.phase === 'ended' && sentOf(p))) { const st = LS(p.uid); if (st.entryFilled > 0 || st.ntOrder) linkFills(p, st); }
      return;
    }
    if (m.type === 'position' && leader.isLeader()) {
      for (const p of planList()) {
        if (p.account !== m.account || p.root !== m.root) continue;
        if (p.phase === 'filled' && +m.qty) LS(p.uid).posSeen = true;
        if (p.phase === 'armed' && +m.qty && !sentOf(p)) fact(p.uid, 'override', { what: 'position_outside', account: m.account, root: m.root, qty: +m.qty });
      }
    }
  }

  /* ---------------- overrides from the page (section 6) */
  function override(what, on, extra) {
    for (const x of PC.overridesFor(what, on, planList(), extra)) { const p = [...S.plans.values()].find(q => q.seq === x.seq); if (p) fact(p.uid, 'override', x.detail); }
  }
  /* Anthony 2026-11-21 ("Flatten ends it"): Flatten on a pair ends every armed or working plan there (Flatten all: every plan of
     this PC), so nothing enters afterwards by itself; recorded as an override; a working entry is cancelled (the leader keeps at
     it until ChartBridge says it is gone). A filled plan's position is closed by the Flatten itself (recorded, then closed). */
  function flattened(r) {
    const acct = env.ticketAccount(), what = r ? 'flatten' : 'flatten_all';
    /* the delta review, finding 4: a group in the ticket: its Flatten ends the plans of every member account */
    const accts = typeof env.members === 'function' ? env.members(acct) : [acct];
    for (const p of planList()) {
      if (r && !(accts.includes(p.account) && p.root === r)) continue;
      if (!['armed', 'working', 'filled'].includes(p.phase)) continue;
      fact(p.uid, 'override', { what, account: p.account, root: r || p.root, ticket: r ? acct : '' });
      if (p.phase === 'filled') continue;
      const o = entryOrderOf(p);
      if (o) cancelEntry(p, o);
      fact(p.uid, 'ended', { why: (r ? 'Flatten' : 'Flatten all') + ' ends the plan', by: 'page' });
      say('Plan #' + p.seq + ' ended by ' + (r ? 'Flatten' : 'Flatten all') + (o ? ': its entry is being cancelled.' : '.'), 'warn');
    }
  }
  function ticketArmed(on) { if (on) override('armed_on', { account: env.ticketAccount(), root: env.ticketRoot() }); }
  function sentManual(msg) {
    if (!msg || msg.type !== 'order' || (typeof msg.cid === 'string' && PC.uidOfCid(msg.cid))) return;
    override('manual_order', { account: msg.account, root: msg.root }, { cid: msg.cid || '' });
  }
  function pressOff(id) {
    const o = core.TR.orders.get(id);
    const uid = o && PC.uidOfCid(o.cid || ''), p = uid ? getPlan(uid) : null;
    return p ? 'Plan #' + p.seq + '\'s order: Cancel it on the plan card, or Flatten.' : '';
  }
  function available() { return S.ok === true && !!S.pc; }
  function armTool(c) {
    if (!available()) { env.note(S.why || 'The planner is off.', 'warn'); return false; }
    /* Planner off is a switch, never undone by a slip: a second click on the Plan tool within 5 s turns it on */
    if (PC.offIn(store)) {
      if (now() - S.offAsk < 5000) { PC.setOff(store, false); shared.tell({ t: 'changed' }); env.note('Planner on again in this browser.', ''); }
      else { S.offAsk = now(); env.note('Planner is off in this browser: nothing is drawn, submitted, armed or sent. Click Plan again within 5 s to turn it on.', 'warn'); return false; }
    }
    c.chart.setTool('plan');
    env.note('Plan: click the entry price on ' + c.root + '. Escape cancels.', '');
    return true;
  }

  /* ---------------- start: this PC's name, then The Desk's plan log */
  Promise.resolve().then(() => env.pcName()).then(pc => {
    if (S.destroyed) return;
    if (typeof pc !== 'string' || !pc) { S.ok = false; S.why = 'ChartBridge does not name this PC (0.6.10 or newer names it): the planner is off.'; return; }
    S.pc = pc; pull(); leader.start(); return refresh();
  }, () => { S.ok = false; S.why = 'ChartBridge did not answer for this PC\'s name: the planner is off.'; });
  S.timers.push(setInterval(() => guard(() => { draw(); renderCard(); }), 1000));
  S.timers.push(setInterval(() => guard(lead), LEAD_MS));
  S.timers.push(setInterval(() => guard(refresh), REFRESH_MS));
  S.timers.push(setInterval(() => guard(flush), FLUSH_MS));

  return {
    message: m => guard(() => message(m)), flattened: r => guard(() => flattened(r)), override: (w, on) => guard(() => override(w, on)),
    ticketArmed: on => guard(() => ticketArmed(on)), sentManual: msg => guard(() => sentManual(msg)), pressOff: id => { try { return pressOff(id); } catch (e) { return ''; } },
    armTool, available,
    state: () => ({ lines: [...S.lines.values()].map(L => ({ root: L.root, ready: L.ready, bars: L.bars.length, last: L.last, firstU: L.firstU, lastU: L.lastU, tail: L.bars.slice(-3) })), ok: S.ok, why: S.why, pc: S.pc, leader: leader.isLeader(), sel: S.sel, drafts: [...S.drafts.values()], plans: planList(), journal: journal.all(), queue: queue.items(), lost: queue.lost(), notes: S.notes.slice(), card: !!S.card }),
    destroy() { S.destroyed = true; for (const t of S.timers) clearInterval(t); leader.close(); shared.close(); if (S.card) S.card.remove(); for (const L of S.lines.values()) { try { L.sock.onmessage = L.sock.onclose = null; L.sock.close(); } catch (e) { /* closed */ } } },
  };
}

root.PlannerPage = { mount };
})(typeof self !== 'undefined' ? self : this);
