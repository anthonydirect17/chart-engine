/*
 * LegionCohorts (plan step 3.3): the top of Legion's Cohorts tab: the prop account groups (cohorts) with their roster picks,
 * from The Desk's GET /api/legion/cohorts, drawn from LegionCastraCore (live/legion-castra-core.js). Under it the tab keeps
 * what it had (FleetView's lanes, traders and accounts, live/fleet.js, mounted by live/legion-tabs.js): this file adds the
 * cohort model and reads nothing from ChartBridge itself. Its live figures (room to the floor, the day, the position, a trader in
 * Auto) come from FleetView's own state (o.live()), the one reader, never a second one.
 *
 *   - Each cohort: its stage, firm, the one PC its firm runs on, its pick, and the firm's direction today ("not built yet": The
 *     Desk gives none until step 3.5). Account chips with the live room to the floor and today.
 *   - Drag and drop an account chip onto a cohort (or onto "in no cohort"): PUT /api/legion/cohorts/members with the version
 *     it read. Refused here, in plain words, before The Desk is asked: while the cohort (or the one it leaves) is in Auto, or the
 *     account holds a position (or this page cannot tell). The Desk's own refusals (stage, firm, type, a stale version) come back
 *     in plain words too. Every chip also has a "Move to" list, for a phone and for the keyboard.
 *   - A link to Fleet (The Desk's Prop screen).
 *   - The Agents strip and the Drone sky: the page's own AgentsSky (live/agents-sky.js), mounted the first time the tab is shown.
 *     Its day is the league's (GET /api/chart-league, read here every 30 s while the tab is shown), its agents the Agent desks'.
 *
 * It writes The Desk's cohort model only, and sends ChartBridge nothing. A hidden tab reads nothing.
 *
 *   const v = LegionCohorts.mount(el, { deskBase, fetch, live, sky });
 *     live()   { traders, accounts } from FleetView.state(), or null
 *     sky      the Drone sky's providers (see legion-tabs.js), or null: then the strip is not shown and the tab says why
 *   v.show(on); v.state(); v.destroy()
 */
(function () {
'use strict';
if (typeof window === 'undefined' || typeof document === 'undefined') return;
const K = window.LegionCastraCore;
const L = window.LudusCore;
const READ_EVERY_MS = 30000;
const { esc, card, note, tone } = K || {};
const signedUsd = x => (x >= 0 ? '+' : '-') + L.usd(Math.abs(x));

function mount(el, opts) {
  const o = opts || {};
  if (!el || !K || !L) return null;
  const desk = K.deskClient({ fetch: o.fetch, deskBase: o.deskBase });
  el.innerHTML = '<div class="ch" data-ch-root><div data-ch-body><p class="lx-muted">Loading the cohorts...</p></div>' +
    '<section class="lx-card cx-card ch-sky" data-ch-skybox aria-label="Agents strip and Drone sky"><h2>Agents strip and Drone sky</h2><div data-ch-sky></div></section></div>';
  const body = el.querySelector('[data-ch-body]'), skyBox = el.querySelector('[data-ch-skybox]'), skyEl = el.querySelector('[data-ch-sky]');
  const S = { shown: false, gen: 0, timer: 0, tick: 0, ans: null, why: '', state: 'idle', readAt: 0, said: '', bad: false, busy: false, drag: '', over: '', fleetHref: '', last: '',
    press: 0, sky: null, skyWhy: '', league: { day: null, problem: '', at: 0, timer: 0, busy: false } };

  const live = () => { try { return (typeof o.live === 'function' && o.live()) || null; } catch (e) { return null; } };
  const view = () => (S.ans ? K.cohortsView(S.ans, live() ? live().accounts : [], live() ? live().traders : [], !!(live() && live().heard)) : null);

  function readCohorts() {
    const g = ++S.gen;
    S.state = 'loading';
    return desk.get(K.ROUTES.cohorts).then(ans => { if (g === S.gen) { S.ans = ans; S.state = 'ok'; S.why = ''; S.readAt = Date.now(); } },
      e => { if (g === S.gen) { S.state = 'fail'; S.why = e && e.words ? e.words : 'The read failed.'; } }).then(render);
  }
  function say(text, bad) { S.said = text; S.bad = !!bad; render(); }

  /* ---------------------------------------------------------------- the drag and drop's one write */
  function move(account, toId) {
    const v = view();
    const no = K.dropRefusal(v, account, toId);
    if (no) { say(no, true); return; }
    if (v && v.ok) {
      const from = v.cohorts.find(c => c.chips.some(k => k.account.toLowerCase() === account.toLowerCase()));
      if ((from ? from.id : null) === toId) { say(account + ' is already there: nothing to change.', false); return; }
    }
    if (S.busy || !v || !v.ok) return;
    S.busy = true; S.gen++;                                   // a cohorts read still in flight must not overwrite this write's newer answer
    say('Asking The Desk to move ' + account + '...', false);
    desk.put(K.ROUTES.members, { version: v.version, account, cohort: toId }).then(ans => {
      S.busy = false; S.ans = ans; S.state = 'ok'; S.readAt = Date.now();
      const to = toId === null ? null : (ans.cohorts || []).find(c => c && c.id === toId);
      say(account + (toId === null ? ' is out of its cohort.' : ' is in ' + (to ? to.name : 'the cohort') + '.'), false);
    }, e => {
      S.busy = false;
      say(K.moveWords(e), true);
      if (e && (e.status === 409 || e.status === 404)) readCohorts();
    });
  }

  /* ---------------------------------------------------------------- drawing */
  function chip(k, cohortId, v) {
    const opts = ['<option value="">Move to...</option>'].concat(v.cohorts.filter(c => c.id !== cohortId).map(c => '<option value="c:' + esc(c.id) + '">' + esc(c.name) + '</option>'),
      cohortId === null ? [] : ['<option value="none">In no cohort</option>']).join('');
    const room = k.listed ? (k.room === null ? 'room not reported' : 'room ' + L.usd(k.room)) : 'not listed by ChartBridge';
    return '<li class="ch-chip' + (k.problem ? ' ch-chip-bad' : '') + '' + '" draggable="true" data-ch-account="' + esc(k.account) + '">' +
      '<span class="ch-chip-name">' + esc(k.account) + '</span> <span class="ch-tag">' + esc(k.stage || 'no stage') + '</span>' +
      '<span class="ch-chip-line cx-dim">' + esc(k.type || 'no checked type') + '</span>' +
      '<span class="ch-chip-line"><span data-l="room" title="' + esc(k.roomWhy) + '">' + esc(room) + '</span></span>' +
      '<span class="ch-chip-line">' + (k.today === null ? '<span class="cx-dim">today not reported</span>' : 'today <span class="cx-num ' + tone(k.today) + '">' + esc(signedUsd(k.today)) + '</span>') +
      (k.listed && k.position ? ' <span class="cx-dim">' + esc(k.position) + '</span>' : '') + '</span>' +
      (k.problem ? '<span class="ch-chip-line cx-bad-t">' + esc(k.problem) + '</span>' : '') +
      '<select class="ch-move" data-ch-move="' + esc(k.account) + '" aria-label="Move ' + esc(k.account) + '">' + opts + '</select></li>';
  }
  function cohortCard(c, i, v) {
    const pcWords = c.pc ? 'PC: ' + esc(c.pc) : 'PC: none set for this firm yet';
    const drop = S.drag ? (K.dropRefusal(v, S.drag, c.id) ? ' ch-drop-no' : ' ch-drop-ok') : '';
    return '<section class="lx-card cx-card ch-cohort' + drop + '" data-ch-drop="' + esc(c.id) + '" aria-label="Cohort ' + esc(c.name) + '">' +
      '<h2><span class="lx-rn">' + esc(K.RN[i] || String(i + 1)) + '</span>' + esc(c.name) + ' <span class="ch-tag">' + esc(c.stage) + '</span>' + (c.auto ? ' <span class="ch-auto">In Auto</span>' : '') + '</h2>' +
      '<dl class="cx-kv"><dt>Firm</dt><dd>' + esc(c.firm || (c.firms.length ? c.firms.join(', ') : 'none yet (no account in it)')) + '</dd><dt>Trades on</dt><dd>' + pcWords + '</dd>' +
      '<dt>Roster pick</dt><dd class="' + (c.pick.bad ? 'cx-bad-t' : '') + '">' + esc(c.pick.text) + '</dd><dt>Direction</dt><dd class="cx-dim">' + esc(K.directionWords().replace(/^Direction today: /, '')) + '</dd></dl>' +
      (c.chips.length ? '<ul class="ch-chips">' + c.chips.map(k => chip(k, c.id, v)).join('') + '</ul>' : '<p class="cx-dim ch-empty">No account yet: drag one here.</p>') +
      c.problems.map(p => note(p, 'cx-bad')).join('') + '</section>';
  }
  function drawBody() {
    if (S.state === 'fail' && !S.ans) return card('', 'The cohorts', note(S.why, 'cx-bad'));
    if (!S.ans) return card('', 'The cohorts', note('Reading the cohorts...', 'cx-dim'));
    const v = view();
    if (!v.ok) return card('', 'The cohorts', note(v.problem, 'cx-bad'));
    let html = '<p class="ch-said' + (S.bad ? ' cx-bad' : '') + '" role="status" aria-live="polite"' + (S.said ? '' : ' hidden') + '>' + esc(S.said) + '</p>';
    html += '<section class="lx-card cx-card ch-head"><h2>The cohorts</h2>' +
      '<p>Prop account groups with the roster build each trades. Drag an account chip onto a cohort, or use its "Move to" list. ' + (S.fleetHref ? '<a class="lx-btn lx-link" href="' + esc(S.fleetHref) + '" target="_blank" rel="noopener">Fleet</a> ' : '') + '<span class="cx-dim">Fleet is The Desk\'s one place for every prop account\'s book.</span></p>' +
      (v.firms.length ? '<dl class="cx-kv">' + v.firms.map(f => '<dt>' + esc(f.firm) + '</dt><dd>' + (f.pc ? 'its cohorts run on ' + esc(f.pc) : 'no PC set') + ', ' + K.plural(f.cohorts, 'cohort') + '. <span class="cx-dim">' + esc(K.directionWords()) + '</span></dd>').join('') + '</dl>' : note('The ledger names no firm yet (not enough data yet).', 'cx-dim')) +
      v.problems.map(p => note(p, 'cx-bad')).join('') +
      note('Refused while a cohort is in Auto or the account holds a position; The Desk refuses a wrong stage, firm or type and says why. The cohort\'s pick is set in The Desk and is not changed on this tab yet. Version ' + v.version + ', read ' + (S.readAt ? new Date(S.readAt).toLocaleTimeString('en-US', { hour12: false }) : 'not yet') + '.', 'cx-dim') + '</section>';
    html += v.cohorts.length ? '<div class="ch-grid">' + v.cohorts.map((c, i) => cohortCard(c, i, v)).join('') + '</div>' : note('No cohort yet (not enough data yet): The Desk holds none.', 'cx-dim');
    const dropT = S.drag ? (K.dropRefusal(v, S.drag, null) ? ' ch-drop-no' : ' ch-drop-ok') : '';
    html += '<section class="lx-card cx-card ch-tray' + dropT + '" data-ch-drop="" aria-label="Prop accounts in no cohort"><h2>In no cohort</h2>' +
      (v.tray.length ? '<ul class="ch-chips">' + v.tray.map(k => chip(k, null, v)).join('') + '</ul>' : '<p class="cx-dim ch-empty">Every prop account The Desk lists is in a cohort. Drop one here to take it out.</p>') + '</section>';
    return html;
  }
  function render() {
    if (!S.shown) return;
    if (S.drag || (S.press && Date.now() - S.press < 4000)) return;  // the page is not redrawn under a press or a drag (the chip would be replaced under the hand); a press older than 4 s is a lost one
    const a = document.activeElement;
    if (a && a.tagName === 'SELECT' && el.contains(a)) return;       // nor under an open list
    let html;
    try { html = drawBody(); } catch (e) { html = '<div class="lx-card lx-todo"><p>The cohorts could not be drawn: ' + esc(e && e.message) + '. Reload this window.</p></div>'; }
    if (html !== S.last) { S.last = html; body.innerHTML = html; }
    if (S.sky) try { S.sky.render(); } catch (e) { /* its own */ }
  }

  /* ---------------------------------------------------------------- events */
  const accountOf = t => { const c = t && t.closest ? t.closest('[data-ch-account]') : null; return c ? c.dataset.chAccount : ''; };
  const dropOf = t => { const z = t && t.closest ? t.closest('[data-ch-drop]') : null; return z ? z.dataset.chDrop : null; };
  const onDragStart = e => {
    const acct = accountOf(e.target);
    if (!acct) return;
    S.drag = acct;
    try { e.dataTransfer.setData('text/plain', acct); e.dataTransfer.effectAllowed = 'move'; } catch (x) { /* no data */ }
    setTimeout(() => { for (const z of body.querySelectorAll('[data-ch-drop]')) z.classList.add(K.dropRefusal(view(), acct, z.dataset.chDrop || null) ? 'ch-drop-no' : 'ch-drop-ok'); }, 0);
  };
  const onDragOver = e => {
    const z = dropOf(e.target);
    if (!S.drag || z === null) return;
    e.preventDefault();                                      // a drop is always taken, so that a refusal is said in words (the zone is drawn dashed grey meanwhile)
    try { e.dataTransfer.dropEffect = 'move'; } catch (x) { /* none */ }                 // never 'none': the browser would not fire the drop, and the refusal would go unsaid
  };
  const onDrop = e => {
    const z = dropOf(e.target);
    if (z === null || !S.drag) return;
    e.preventDefault();
    const acct = S.drag; S.drag = ''; S.press = 0;
    move(acct, z || null);
  };
  const onDown = e => { if (accountOf(e.target)) S.press = Date.now(); };
  const onUp = () => { if (S.press) { S.press = 0; render(); } };
  const onDragEnd = () => { S.press = 0; S.drag = ''; for (const z of body.querySelectorAll('[data-ch-drop]')) z.classList.remove('ch-drop-ok', 'ch-drop-no'); render(); };
  const onChange = e => {
    const s = e.target && e.target.closest ? e.target.closest('[data-ch-move]') : null;
    if (!s || !s.value) return;
    const acct = s.dataset.chMove, val = s.value;
    s.blur();
    move(acct, val === 'none' ? null : val.slice(2));
  };
  body.addEventListener('pointerdown', onDown); document.addEventListener('pointerup', onUp, true); body.addEventListener('dragstart', onDragStart); body.addEventListener('dragover', onDragOver); body.addEventListener('drop', onDrop); body.addEventListener('dragend', onDragEnd); body.addEventListener('change', onChange);

  /* ---------------------------------------------------------------- the Drone sky (the page's own AgentsSky), mounted once, on first show */
  function pollLeague() {
    clearTimeout(S.league.timer); S.league.timer = 0;
    if (!S.shown || S.league.busy) return;
    S.league.busy = true;
    desk.get(K.ROUTES.league).then(j => { S.league.day = window.LeagueCore ? window.LeagueCore.cleanDay(j) : null; S.league.problem = ''; S.league.at = Date.now(); },
      e => { S.league.problem = (e && e.words ? e.words : 'The league did not answer.') + (S.league.day ? ' Showing what it last sent.' : ''); })
      .then(() => { S.league.busy = false; if (S.sky) try { S.sky.render(); } catch (e) { /* its own */ } if (S.shown) S.league.timer = setTimeout(pollLeague, READ_EVERY_MS); });
  }
  function mountSky() {
    if (S.sky || S.skyWhy) return;
    const p = o.sky;
    if (!p || !window.AgentsSky || !window.AgentsStrip || !window.AgentsStripCore) { S.skyWhy = 'The Agents strip is not served here (agents-sky.js or agents-strip.js is missing).'; skyEl.innerHTML = note(S.skyWhy, 'cx-dim'); return; }
    try {
      skyEl.insertAdjacentHTML('afterend', '<p class="cx-note cx-dim">No price line on this page: the sky\'s pillars need the chart page\'s NQ quote, so it can say "Waiting for NQ bars". Its drones and their cards come from the Agent desks.</p>');
      S.sky = window.AgentsSky.mount(skyEl, Object.assign({}, p, { day: () => S.league.day, reach: () => ({ problem: S.league.problem, at: S.league.at }) }));
    } catch (e) { S.skyWhy = 'The Drone sky could not start: ' + (e && e.message); skyEl.innerHTML = note(S.skyWhy, 'cx-bad'); }
  }

  function show(on) {
    on = on === true;
    if (on === S.shown) return S.shown;
    S.shown = on;
    clearInterval(S.timer); clearInterval(S.tick);
    if (on) {
      readCohorts(); mountSky(); pollLeague();
      Promise.resolve().then(() => o.deskBase()).then(b => { S.fleetHref = String(b).replace(/\/+$/, '') + K.FLEET_PATH; render(); }, () => {});
      S.timer = setInterval(() => { if (!S.drag && !S.busy) readCohorts(); }, READ_EVERY_MS);
      S.tick = setInterval(render, 1000);
      render();
    } else { S.gen++; clearTimeout(S.league.timer); S.league.timer = 0; }
    if (S.sky && typeof S.sky.show === 'function') try { S.sky.show(on); } catch (e) { /* its own */ }
    return S.shown;
  }
  return { show, state: () => ({ shown: S.shown, state: S.state, version: S.ans && typeof S.ans.version === 'number' ? S.ans.version : null, said: S.said, saidBad: S.bad, busy: S.busy, sky: !!S.sky, skyWhy: S.skyWhy,
      cohorts: view() && view().ok ? view().cohorts.map(c => ({ id: c.id, name: c.name, accounts: c.chips.map(k => k.account), auto: c.auto })) : [], tray: view() && view().ok ? view().tray.map(k => k.account) : [] }),
    move, readAgain: readCohorts, destroy() { clearInterval(S.timer); clearInterval(S.tick); clearTimeout(S.league.timer); S.gen++;
      body.removeEventListener('pointerdown', onDown); document.removeEventListener('pointerup', onUp, true); body.removeEventListener('dragstart', onDragStart); body.removeEventListener('dragover', onDragOver); body.removeEventListener('drop', onDrop); body.removeEventListener('dragend', onDragEnd); body.removeEventListener('change', onChange);
      if (S.sky && typeof S.sky.destroy === 'function') try { S.sky.destroy(); } catch (e) { /* gone */ } } };
}

window.LegionCohorts = { mount };
})();
