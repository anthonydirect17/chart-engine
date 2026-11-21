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
 *       execs() [fills], note(text, level), ledger(mark) (BotCore.botFillLedger), now() }
 */
(function (root) {
'use strict';
const REFRESH_MS = 5000, FLUSH_MS = 5000, LEAD_MS = 250, ENDED_KEEP_MS = 60000;

function mount(env) {
  const PC = env.PC || root.PlannerCore;
  const U = env.U, core = env.core, store = env.storage, now = typeof env.now === 'function' ? env.now : () => Date.now();
  const S = {
    ok: null, why: 'Asking The Desk for its plan log...', pc: '', desk: PC.deskApi({ base: env.deskBase, fetch: env.fetch }),
    sel: '', card: null, cardAt: null, lines: new Map(), plans: new Map(), drafts: new Map(), lead: new Map(),
    hooked: new WeakSet(), drawnKey: new Map(), timers: [], destroyed: false, deskDown: false, notes: [],
  };
  const journal = PC.createJournal(store, now), queue = PC.createQueue(store, now);
  const ledger = typeof env.ledger === 'function' ? env.ledger(o => !!o && !!PC.uidOfCid(o.cid) && S.plans.has(PC.uidOfCid(o.cid))) : null;
  const say = (text, level) => { S.notes.push(text); if (S.notes.length > 40) S.notes.shift(); if (S.card) cardNote(text, level); else env.note(text, level); };

  /* ---------------- the plans every window shows (PlannerCore.createShared) */
  const shared = PC.createShared({ storage: store, channel: env.channel, onMessage: m => {
    if (m.t === 'changed' || m.t === 'stamped') { pull(); if (m.t === 'stamped') refresh(); }
    if (m.t === 'armOff' && env.holdsTicket() && core.TR.armed) { core.setArmed(false); env.note('Armed turned off: a plan was armed (the planner\'s light lock). Flatten, Flatten all and Cut half still work.', 'warn'); }
  } });
  function pull() {
    const s = shared.read();
    S.drafts = new Map(Object.entries(s.drafts));
    S.plans = new Map(Object.entries(s.plans).filter(([, p]) => !S.pc || p.pc === S.pc));
    draw(); renderCard();
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
  function flush() { queue.flush(item => S.desk.event(item).then(r => (r.ok ? 'ok' : r.status === 0 ? 'later' : r.status === 404 && !S.ok ? 'later' : 'drop'))); }

  /* ---------------- The Desk's plan log */
  function refresh() {
    if (!S.pc || S.destroyed) return Promise.resolve();
    return S.desk.list(S.pc).then(r => {
      if (r.none) { S.ok = false; S.why = 'The Desk has no plan log (an older Desk): the planner is off.'; draw(); renderCard(); return; }
      if (!r.ok) { S.deskDown = true; if (S.ok === null) S.why = 'The Desk did not answer: the planner waits for it.'; return; }
      S.ok = true; S.deskDown = false; S.why = '';
      const got = new Map();
      for (const v of (r.body && Array.isArray(r.body.plans) ? r.body.plans : [])) { const p = PC.fromDesk(v); if (p && p.pc === S.pc) got.set(p.uid, p); }
      shared.change(s => {
        for (const [uid, p] of got) {
          const was = s.plans[uid];
          const deskUids = new Set(p.events.map(e => e.uid).filter(Boolean)), kinds = new Set(p.events.map(e => e.kind));
          const local = was && Array.isArray(was.events) ? was.events.filter(e => e.uid && !deskUids.has(e.uid) && !(e.local && kinds.has(e.kind))) : [];
          s.plans[uid] = Object.assign({}, p, { t0: was ? was.t0 : null, events: p.events.concat(local), endedAt: was ? was.endedAt : null });
          delete s.drafts[uid];
        }
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
    L = { root: rootName, last: null, at: 0, bars: [], sock: null };
    S.lines.set(rootName, L);
    try { L.sock = env.hub.open(rootName); } catch (e) { return L; }
    L.sock.onmessage = ev => {
      const m = ev.message; if (!m || m.root !== rootName) return;
      if (m.type === 'tick' && isFinite(+m.p)) { L.last = +m.p; L.at = now(); onTrade(rootName, +m.p, isFinite(+m.u) && +m.u > 0 ? +m.u : now()); }
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
    L.sock.onmessage = ev => { if (ev.message && ev.message.type === 'hello') { L.bars = []; sub(); } was(ev); };
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
    S.desk.edit(p.seq, { uid: PC.newUid(), entry: e.entry, stop: e.stop, targets: [e.target], target1: e.target }).then(r => {
      if (!r.ok) { say('Not changed: ' + r.why + '.', 'warn'); S.drawnKey.clear(); draw(); return; }
      shared.change(s => { const q = s.plans[e.id]; if (q) Object.assign(q, { entry: e.entry, stop: e.stop, target: e.target }); });
      shared.tell({ t: 'stamped', uid: e.id }); pull(); refresh();
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
    const key = JSON.stringify([it, phase, off, env.accounts()]);
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
      : phase === 'working' ? 'Working at ChartBridge' : phase === 'filled' ? 'Filled: its stop and target are in ChartBridge. Flatten closes it.' : 'Ended: ' + (PC.WHY_WORDS[p.why] || p.why);
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
      if (!r.ok) { say('Not changed: ' + r.why + '.', 'warn'); renderCard(true); return; }
      shared.change(s => { const q = s.plans[p.uid]; if (q) Object.assign(q, change.entry_type ? { entryType: change.entry_type } : {}, change.expiry_min ? { expiryMin: change.expiry_min } : {}, change.qty ? { qty: change.qty } : {}, change.grade ? { grade: change.grade } : {}, change.account ? { account: change.account } : {}, change.side ? { side: change.side } : {}); });
      shared.tell({ t: 'stamped', uid: p.uid }); pull(); refresh();
    });
  }
  /* the other side: the stop and target mirrored about the entry (their distances kept) */
  function flip(it) { return { side: it.side === 'short' ? 'long' : 'short', stop: 2 * it.entry - it.stop, target: 2 * it.entry - it.target }; }
  function onCard(e) {
    const b = e.target.closest('[data-pl]'); if (!b || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
    const what = b.dataset.pl;
    if (what === 'close') { S.sel = ''; renderCard(); S.drawnKey.clear(); draw(); return; }
    if (e.detail === 0 && ['submit', 'arm', 'cancel'].includes(what)) { cardNote('The plan\'s buttons work by click only, not by keyboard.', 'warn'); return; }
    if (what === 'side') { const it = S.drafts.get(S.sel) || getPlan(S.sel); if (!it || it.side === b.dataset.v) return; const f = flip(it); if (!editDraft(d => Object.assign(d, { side: f.side, stop: f.stop, target: f.target }))) editSubmitted({ side: f.side, stop: f.stop, targets: [f.target], target1: f.target }); return; }
    if (what === 'grade') { if (!editDraft(d => { d.grade = b.dataset.v; })) editSubmitted({ grade: b.dataset.v }); return; }
    if (what === 'submit') submit(S.sel);
    else if (what === 'arm') arm(S.sel);
    else if (what === 'cancel') cancel(S.sel);
  }
  function onCardChange(e) {
    const t = e.target, what = t.dataset.pl;
    if (what === 'off') { PC.setOff(store, t.checked); shared.tell({ t: 'changed' }); say(t.checked ? 'Planner off in this browser: no new plan is drawn, submitted or armed. Plans already armed still end as they would.' : 'Planner on.', ''); renderCard(true); return; }
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
    const why = PC.validate(d, ctxOf(d.root));
    if (why) { cardNote('Not submitted: ' + why, 'warn'); return; }
    cardNote('Submitting to The Desk...', '');
    S.desk.submit(PC.submitBody(d, S.pc)).then(r => {
      if (!r.ok) { cardNote('Not submitted: ' + r.why + '.', 'error'); return; }
      const p = PC.fromDesk(r.body);
      if (!p) { cardNote('Not submitted: The Desk\'s answer was not a plan.', 'error'); return; }
      shared.change(s => { s.plans[p.uid] = Object.assign({}, p, { t0: d.t0, events: p.events }); delete s.drafts[uid]; });
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
    const ent = PC.entryFor(p, lastOf(p.root), env.orderTypes());
    if (ent.refuse) { cardNote(ent.refuse, 'warn'); return; }
    cardNote('Arming at The Desk...', '');
    S.desk.arm(p.seq, PC.newUid()).then(r => {
      if (!r.ok) { cardNote(r.status === 0 ? 'The Desk did not answer: not armed.' : 'Not armed: ' + r.why + '.', 'error'); return; }
      const exp = r.body && isFinite(+r.body.expires_at_ms) ? +r.body.expires_at_ms : null;
      shared.change(s => { const q = s.plans[uid]; if (q) { q.events = (q.events || []).concat([{ kind: 'arm', at: now(), detail: { expires_at_ms: exp }, uid: r.body && r.body.event_uid || '' , local: true }]); q.expiresAt = exp; q.armedAt = now(); } });
      /* the light lock: the ticket's Armed goes off (here, and in the ticket's window) */
      if (env.holdsTicket() && core.TR.armed) core.setArmed(false);
      shared.tell({ t: 'armOff' }); shared.tell({ t: 'stamped', uid }); pull();
      cardNote('Plan #' + p.seq + ' armed' + (exp ? ' until ' + new Date(exp).toLocaleTimeString() : '') + '. The ticket\'s Armed is off; Flatten still works.', '');
      lead();
    });
  }
  function cancel(uid) {
    if (S.drafts.has(uid)) { shared.change(s => { delete s.drafts[uid]; }); S.sel = ''; pull(); return; }
    const p = getPlan(uid); if (!p || p.phase === 'filled' || p.phase === 'ended') return;
    /* the working entry goes at once, from this window (any window may cancel by id); The Desk stamps the cancel */
    const o = workingOf(p);
    if (o) { const r = core.cancelPlanOrder(o.id, p); if (!r.sent) cardNote('The entry\'s cancel was not sent: ' + r.why + ' Cancel it in NinjaTrader, or Flatten.', 'error'); }
    S.desk.cancel(p.seq, PC.newUid(), 'Anthony').then(r => {
      if (r.ok) { shared.change(s => { const q = s.plans[uid]; if (q) { q.events = (q.events || []).concat([{ kind: 'cancel', at: now(), detail: {}, uid: '', local: true }]); q.endedAt = now(); } }); shared.tell({ t: 'stamped', uid }); pull(); cardNote('Plan #' + p.seq + ' cancelled.', ''); return; }
      if (r.status === 0) { fact(uid, 'cancel', { by: 'card', why: 'The Desk did not answer the cancel' }); cardNote('Plan #' + p.seq + ' cancelled here; The Desk did not answer, it is told when it does.', 'warn'); return; }
      cardNote('The Desk refused the cancel: ' + r.why + '.', 'error');
    });
  }
  const workingOf = p => [...core.TR.orders.values()].find(o => o && o.cid === PC.entryCid(p.uid) && (o.state === 'working' || o.state === 'partFilled' || o.state === 'accepted')) || null;

  /* ---------------- the leader: sends, watches, resumes (only the window holding the lock) */
  const leader = PC.createLeader({ locks: env.locks, onLead: () => { for (const st of S.lead.values()) st.resumed = false; lead(); } });
  const LS = uid => { let st = S.lead.get(uid); if (!st) S.lead.set(uid, st = { resumed: false, watch: null, orderId: '', placed: false, filled: false, cancelling: false, lastPrice: null, lastState: '' }); return st; };
  function lead() {
    if (!leader.isLeader() || !S.pc || S.ok !== true) return;
    for (const p of planList()) {
      if (!['armed', 'working', 'filled'].includes(p.phase)) { S.lead.delete(p.uid); continue; }
      const st = LS(p.uid);
      if (!st.resumed) { if (!core.TR.snapReady || !core.TR.enabled) continue; resume(p, st); continue; }
      step(p, st);
    }
  }
  function resume(p, st) {
    st.resumed = true;
    const L = line(p.root);
    const r = PC.reconcile(p, { now: now(), tick: p.tick || env.tickOf(p.root), journal: journal.sentOf(p.uid), orders: [...core.TR.orders.values()], execs: env.execs(), bars: L.bars });
    if (r.act === 'expired' || r.act === 'stop_through' || r.act === 'missed') { fact(p.uid, r.act, { why: r.why, on: 'resume' }); say('Plan #' + p.seq + ': ' + r.why + '.', 'warn'); return; }
    if (r.act === 'resume_working') { st.orderId = r.id; st.placed = true; watchFor(p, st, true); return; }
    if (r.act === 'cancel_expired') { st.orderId = r.id; core.cancelPlanOrder(r.id, p); fact(p.uid, 'expired', { late_ms: r.lateMs, on: 'resume', id: r.id }); say('Plan #' + p.seq + ' had expired while no window watched it: its entry is cancelled now.', 'warn'); return; }
    if (r.act === 'filled') { if (p.phase !== 'filled') fact(p.uid, 'filled', { exec_ids: r.execs, nt_order_id: r.order, price: r.price, qty: r.qty, on: 'resume' }); st.filled = true; return; }
    if (r.act === 'unknown') { if (!p.events.some(e => e.kind === 'owner' && e.detail && e.detail.what === 'unknown')) fact(p.uid, 'owner', { what: 'unknown', why: r.why }); alarm('Plan #' + p.seq + ': ' + r.why); st.unknown = true; return; }
    if (r.act === 'resume') watchFor(p, st, false);
  }
  function alarm(text) { say(text, 'error'); if (typeof env.alarm === 'function') env.alarm(text); }
  function watchFor(p, st, sent) {
    st.watch = PC.createWatch(p, { tick: p.tick || env.tickOf(p.root), expiresAt: p.expiresAt, sent, touched: (p.events.find(e => e.kind === 'touched') || {}).detail ? Math.floor(p.events.find(e => e.kind === 'touched').at / 60000) : null });
    line(p.root);
  }
  function step(p, st) {
    if (st.unknown) return;
    if (p.phase === 'filled') { closedYet(p, st); return; }
    if (!st.watch) watchFor(p, st, !!journal.sentOf(p.uid));
    const sent = journal.sentOf(p.uid);
    if (p.phase === 'armed' && !sent && p.entryType !== 'confirm') send(p, st, null);
    for (const f of st.watch.time(now())) act(p, st, f);
  }
  function send(p, st, kindNow) {
    const tick = p.tick || env.tickOf(p.root), last = lastOf(p.root);
    const ent = kindNow ? { kind: kindNow, price: null } : PC.entryFor(p, last, env.orderTypes());
    if (ent.refuse) { fact(p.uid, 'refused', { why: ent.refuse, by: 'page' }); say('Plan #' + p.seq + ' not sent: ' + ent.refuse, 'warn'); return; }
    const b = PC.bracketFor(p, ent.kind, last, tick, env.maxBracketTicks());
    if (b.refuse) { fact(p.uid, 'refused', { why: b.refuse, by: 'page' }); say('Plan #' + p.seq + ' not sent: ' + b.refuse, 'warn'); return; }
    const why = core.readyPlan(p);
    if (why) { if (st.lastWhy !== why) { st.lastWhy = why; say('Plan #' + p.seq + ' waits: ' + why, 'warn'); } return; }
    const cid = PC.entryCid(p.uid);
    if (!journal.mark(p.uid, cid)) { st.unknown = true; alarm('Plan #' + p.seq + ': its entry could not be written to this browser\'s send journal (or it was sent already): not sent.'); return; }
    const r = core.sendPlanOrder({ uid: p.uid, account: p.account, root: p.root, side: p.side, kind: ent.kind, qty: p.qty, price: ent.price === null ? undefined : ent.price, bracket: b }, 'entry');
    if (!r.sent) { fact(p.uid, 'refused', { why: r.why, by: 'page' }); say('Plan #' + p.seq + ' not sent: ' + r.why, 'error'); return; }
    if (st.watch) st.watch.sent();
    fact(p.uid, 'sent', { cid, kind: ent.kind, price: ent.price, qty: p.qty, bracket_ticks: b, last });
    say('Plan #' + p.seq + ': ' + (p.side === 'short' ? 'SELL ' : 'BUY ') + ent.kind.toUpperCase() + ' ' + p.qty + ' ' + p.root + (ent.price !== null ? ' at ' + ent.price : '') + ' sent with ' + b.stop + ' / ' + b.target + ' ticks, on ' + p.account + '.', '');
  }
  function act(p, st, f) {
    if (f.kind === 'touched') { fact(p.uid, 'touched', { price: f.price }); return; }
    if (f.kind === 'confirmed') { fact(p.uid, 'confirmed', { close: f.close, minute_ms: f.minute }); if (!journal.sentOf(p.uid)) send(p, st, 'market'); return; }
    if (f.kind === 'stop_through' || f.kind === 'expired') {
      const o = workingOf(p);
      if (o) { const r = core.cancelPlanOrder(o.id, p); if (!r.sent) alarm('Plan #' + p.seq + ' ' + f.kind.replace('_', '-') + ', but its entry\'s cancel was not sent: ' + r.why + ' Cancel it in NinjaTrader.'); }
      fact(p.uid, f.kind, { price: f.price, id: o ? o.id : '' });
      say('Plan #' + p.seq + ' ' + (f.kind === 'expired' ? 'expired' : 'ended: price went through the stop') + (o ? ': its entry is cancelled.' : '.'), 'warn');
    }
  }
  function onTrade(r, price, ms) {
    if (!leader.isLeader()) return;
    for (const p of planList()) {
      if (p.root !== r || !['armed', 'working'].includes(p.phase)) continue;
      const st = S.lead.get(p.uid);
      if (!st || !st.resumed || !st.watch || st.unknown) continue;
      for (const f of st.watch.trade(price, ms)) act(p, st, f);
    }
  }
  function closedYet(p, st) {
    const pos = core.TR.positions.get(p.account + '|' + p.root);
    if (core.TR.snapReady && (!pos || !pos.qty) && !p.events.some(e => e.kind === 'closed')) fact(p.uid, 'closed', {});
  }

  /* ---------------- ChartBridge's messages (this window's order connection) */
  function message(m) {
    if (!m || !m.type) return;
    if (m.type === 'order' && typeof m.cid === 'string' && PC.uidOfCid(m.cid)) {
      const uid = PC.uidOfCid(m.cid), p = getPlan(uid);
      if (!p) return;
      const owes = ledger ? ledger.order(m) : false;
      if (!leader.isLeader()) return;
      if (owes) claim(env.execs());                          // a fill that came before its order message is claimed now
      const st = LS(uid);
      if (!st.placed && (m.state === 'working' || m.state === 'accepted' || m.state === 'partFilled' || m.state === 'filled')) { st.placed = true; st.orderId = m.id; fact(uid, 'placed', { id: m.id, state: m.state }); }
      if (st.lastPrice !== null && m.price !== null && m.price !== st.lastPrice && (m.state === 'working' || m.state === 'accepted')) fact(uid, 'override', { what: 'moved_outside', account: p.account, root: p.root, id: m.id, from: st.lastPrice, to: m.price });
      if (m.price !== null && m.price !== undefined) st.lastPrice = m.price;
      if (m.state === 'rejected') { fact(uid, 'refused', { why: m.text || 'NinjaTrader rejected it', by: 'ninjatrader' }); say('Plan #' + p.seq + ': NinjaTrader rejected its entry: ' + (m.text || '') , 'error'); }
      if (m.state === 'cancelled' && !(+m.filled > 0) && ['armed', 'working'].includes(p.phase)) {
        const ours = p.events.some(e => ['cancel', 'expired', 'stop_through'].includes(e.kind));
        if (!ours) { fact(uid, 'override', { what: 'cancelled_outside', account: p.account, root: p.root, id: m.id }); fact(uid, 'ended', { why: 'its entry was cancelled outside the planner' }); }
      }
      return;
    }
    if (m.type === 'reject' && typeof m.cid === 'string' && PC.uidOfCid(m.cid)) {
      const uid = PC.uidOfCid(m.cid), p = getPlan(uid);
      if (p && leader.isLeader()) { fact(uid, 'refused', { why: m.reason || '', by: 'chartbridge' }); say('Plan #' + p.seq + ' refused by ChartBridge: ' + (m.reason || '') + ' The plan ends; it is not tried again.', 'error'); }
      return;
    }
    if ((m.type === 'exec' || m.type === 'execs') && ledger && leader.isLeader()) { claim(m.type === 'exec' ? [m] : m.list || []); return; }
    if (m.type === 'position' && leader.isLeader()) {
      for (const p of planList()) if (p.account === m.account && p.root === m.root && p.phase === 'armed' && +m.qty && !journal.sentOf(p.uid)) fact(p.uid, 'override', { what: 'position_outside', account: m.account, root: m.root, qty: +m.qty });
    }
  }
  /* the plans' fills (BotCore's ledger: a fill is claimed against the contracts its plan's own entry is seen to fill) */
  const claimedIds = new Set();
  function claim(list) {
    if (!ledger) return;
    {
      for (const f of list) {
        if (!f || claimedIds.has(f.id)) continue;
        if (!ledger.claim(f)) continue;
        claimedIds.add(f.id);
        const pid = ledger.orderOf(f.id), o = core.TR.orders.get(pid) || {}, uid = PC.uidOfCid(o.cid || '') || [...S.lead.entries()].find(([, st]) => st.orderId === pid)?.[0];
        const p = uid ? getPlan(uid) : null;
        if (!p) continue;
        const st = LS(uid); st.fills = (st.fills || []).concat([f]);
        const got = st.fills.reduce((a, x) => a + (+x.qty || 0), 0);
        if (got >= p.qty && !st.filled) { st.filled = true; fact(uid, 'filled', { exec_ids: st.fills.map(x => x.id), nt_order_id: f.order || '', price: f.p, qty: got }); say('Plan #' + p.seq + ' filled: ' + got + ' ' + p.root + ' at ' + f.p + ' on ' + p.account + '.', ''); }
      }
    }
  }

  /* ---------------- overrides from the page (section 6) */
  function override(what, on, extra) {
    for (const x of PC.overridesFor(what, on, planList(), extra)) { const p = [...S.plans.values()].find(q => q.seq === x.seq); if (p) fact(p.uid, 'override', x.detail); }
  }
  function flattened(r) { if (r) override('flatten', { account: env.ticketAccount(), root: r }); else override('flatten_all', null); }
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
    if (PC.offIn(store)) { env.note('Planner is off in this browser: switch it on on a plan card (or clear live-planner-off-v1).', 'warn'); PC.setOff(store, false); return false; }
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
    state: () => ({ ok: S.ok, why: S.why, pc: S.pc, leader: leader.isLeader(), sel: S.sel, drafts: [...S.drafts.values()], plans: planList(), journal: journal.all(), queue: queue.items(), lost: queue.lost(), notes: S.notes.slice(), card: !!S.card }),
    destroy() { S.destroyed = true; for (const t of S.timers) clearInterval(t); leader.close(); shared.close(); if (S.card) S.card.remove(); for (const L of S.lines.values()) { try { L.sock.onmessage = L.sock.onclose = null; L.sock.close(); } catch (e) { /* closed */ } } },
  };
}

root.PlannerPage = { mount };
})(typeof self !== 'undefined' ? self : this);
