/*
 * LegionCastra (plan step 3.3): Legion's home tab, drawn from LegionCastraCore (live/legion-castra-core.js, the pure part and its
 * reads). ROI first (Rule 1): at the top, real money against simulated money per roster build with the money alarm (law 9.2);
 * then the daily "who goes in today" view (each roster build's overall profit per $1, days to pass and payout speed; its split
 * by zone and regime stays off), what is running now, Needs you (the one place a decision waits), last night, today (live only)
 * and Centurion's week with its veto and undo (the contract v1 of 2026-11-19, section 6).
 *
 * It sends ChartBridge nothing and places nothing. Its only writes are Centurion's two, to The Desk, each one POST of exactly
 * { run_id, name } after a Yes: POST /api/legion/centurion/veto (a change of this week's Saturday report turned off) and
 * POST /api/legion/centurion/undo (an applied change asked back). The three routes it uses for Centurion are those two and
 * GET /api/legion/centurion; it never calls the seal or the undo list, which are Bot-Lab's night run's (a test pins it). It acts only on
 * The Desk's veto version 1 (veto.built true, veto.version 1); any other answer is read only. The page never decides the veto window:
 * it shows The Desk's state and The Desk refuses. A hidden Castra reads nothing; a shown one reads The Desk once, then every
 * READ_EVERY_MS while it stays shown, at "Read again", and at once after each answer to a veto or an undo. What only the trading PC
 * knows (the traders, the prop accounts' day) is read from FleetView's own state (o.live()), never a second time.
 *
 * THE QUESTION (Veto and Undo, Anthony 2026-11-19: keep the Yes for both; a veto is never taken back): a click opens it in the card,
 * as Legion's Stop all question: a real click on Yes only (realClick, the page's one rule), no answer in the first K.ARM_MS, gone after
 * K.CONFIRM_MS by the clock, Escape and Cancel close it. Yes sends one POST; the button reads "Sending..." and nothing else is sent
 * until the answer. No button is drawn on a stale or failed read.
 *
 *   const v = LegionCastra.mount(el, { deskBase, fetch, live, go, realClick });
 *     deskBase()  The Desk's address (AccountsPage.deskBase); fetch: window.fetch
 *     live()      { traders, accounts } from FleetView.state() (FleetCore.traders and FleetCore.propAccounts), or null
 *     go(tab)     opens another Legion tab (Needs you's links)
 *     realClick(e)  OrderTicket.realClick (legion-tabs.js hands Legion's own); none: Yes is never taken, as in Legion's header
 *   v.show(on); v.state(); v.destroy()
 */
(function () {
'use strict';
if (typeof window === 'undefined' || typeof document === 'undefined') return;
const K = window.LegionCastraCore;
const L = window.LudusCore;
const READ_EVERY_MS = 60000;
const { esc, table, cell, raw, card, note, tone } = K || {};
const NAMES = ['roster', 'cohorts', 'money', 'centurion', 'board'];

function mount(el, opts) {
  const o = opts || {};
  if (!el || !K || !L) return null;
  const desk = K.deskClient({ fetch: o.fetch, deskBase: o.deskBase });
  const realClick = typeof o.realClick === 'function' ? o.realClick : () => false;   // none: Yes is never taken (Legion's header does the same)
  const S = { shown: false, gen: 0, timer: 0, tick: 0, readAt: 0, last: '', reads: {}, ask: null, askTimer: 0, sending: '', said: '', saidBad: false };
  for (const n of NAMES) S.reads[n] = { state: 'idle', why: '', ans: null };

  /* a read keeps its last answer while it is refreshed, and when a refresh fails (shown with a note): never blanked, never all clear */
  function read(name, path) {
    const g = S.gen, r = S.reads[name];
    S.reads[name] = { state: 'loading', why: '', ans: r.ans };
    return desk.get(path).then(ans => { if (g === S.gen) S.reads[name] = { state: 'ok', why: '', ans }; },
      e => { if (g === S.gen) S.reads[name] = { state: 'fail', why: e && e.words ? e.words : 'The read failed.', ans: r.ans }; });
  }
  function readAll() {
    S.gen++;
    S.readAt = Date.now();
    const done = [read('roster', K.ROUTES.roster), read('cohorts', K.ROUTES.cohorts), read('money', K.ROUTES.money), read('centurion', K.ROUTES.centurion), read('board', K.ROUTES.board)];
    render();
    Promise.all(done).then(render);
  }
  const live = () => { try { return (typeof o.live === 'function' && o.live()) || null; } catch (e) { return null; } };
  const status = n => K.readStatus(S.reads[n]).state;
  const staleNote = n => (K.readStatus(S.reads[n]).stale ? note('The last refresh failed (' + S.reads[n].why + ') so this is the last answer, not a current one.', 'cx-bad') : '');
  const failNote = n => (S.reads[n].state === 'fail' ? note(S.reads[n].why, 'cx-bad') : note('Reading...', 'cx-dim'));
  const go = (tab, text) => '<button type="button" class="cx-link" data-cx-go="' + esc(tab) + '">' + esc(text) + '</button>';

  /* I. real against simulated money, per roster build, the money alarm on top */
  function money(mv) {
    if (status('money') !== 'ok') return card('I', 'Real against simulated money', failNote('money') + note(K.SIM_LABEL, 'cx-sim'), 'cx-first');
    if (!mv.ok) return card('I', 'Real against simulated money', note(mv.problem, 'cx-bad'), 'cx-first');
    const banner = mv.tripped ? '<p class="cx-alarm" role="alert"><b>Money alarm: ' + K.plural(mv.tripped, 'roster build') + ' under the low end of the Prop Sim\'s range for the same number of evals.</b> It is shown here and decides nothing by itself yet (the stop is step 3.5, ' + esc(K.NOT_BUILT) + ').</p>'
      : mv.builds.some(b => b.alarm.state === 'unknown' && b.alarm.words === K.ALARM_NOT_KNOWN) ? '<p class="cx-ok"><b>Money alarm: not known yet.</b> ' + esc(K.ALARM_NOT_KNOWN) + ' Until it is served the alarm never trips and never tops Needs you.</p>'
      : mv.builds.length ? '<p class="cx-ok"><b>Money alarm: none tripped.</b></p>' : '';
    let body = staleNote('money') + banner;
    if (!mv.builds.length) body += note('No roster build has real money yet: the prop ledger has nothing attributed to a build (not enough data yet).', 'cx-dim');
    else {
      body += table('cx-money', ['Build', 'Real profit per $1', 'Simulated profit per $1 (eval)', 'Real costs', 'Real payouts', 'Real net', 'Real sample', 'Money alarm'], mv.builds.map(b => ({ attrs: ' data-cx-build="' + esc(b.bot) + '"', cells: [
        raw('<b>' + esc(b.bot) + '</b>' + (b.onRoster ? '' : '<br><span class="cx-dim">no longer on the roster</span>'), 'cx-lead'),
        raw(esc(b.real.ppd) + (b.real.words && !b.real.has && b.real.words !== K.NOT_ENOUGH ? '<br><span class="cx-dim">' + esc(b.real.words) + '</span>' : '') +
          (b.real.cardAccount ? '<br><span class="cx-dim" data-cx-cnt>' + esc(b.real.cardAccount) + '</span>' : ''), 'cx-num cx-lead ' + b.real.ppdTone),
        cell(b.hasSim ? b.sim.eval.text : 'no simulated figure (not on the roster)', 'cx-sim'),
        cell(b.real.costs, 'cx-num'), cell(b.real.payouts, 'cx-num'), cell(b.real.net, 'cx-num ' + b.real.netTone), cell(b.real.sample, 'cx-dim'),
        raw('<span class="cx-al cx-al-' + esc(b.alarm.state) + '">' + esc(b.alarm.state === 'tripped' ? 'Tripped' : b.alarm.state === 'clear' ? 'Clear' : 'Not known yet') + '</span> <span class="cx-dim">' + esc(b.alarm.words) + '</span>')] })));
      body += note('Real: the prop ledger, split by the day each account ran the build (The Desk). ' + K.SIM_LABEL, 'cx-dim');
    }
    if (mv.total) body += note('The ledger in all: ' + K.plural(mv.total.entries, 'entry', 'entries') + ', costs ' + mv.total.costs + ', payouts ' + mv.total.payouts + (mv.unattributed ? '; of it ' + K.plural(mv.unattributed.entries, 'entry', 'entries') + ' (costs ' + mv.unattributed.costs + ') belong to no build' : '') + '.', 'cx-dim');
    /* TheDesk #120: the card's fills account when each entry was booked, and the entries that could not be told (the numbers still shown) */
    if (mv.cardLog) body += '<p class="cx-note cx-dim" data-cx-cardlog>' + esc(mv.cardLog.words) + (mv.cardLog.note ? ' <span class="cx-dim">The Desk: ' + esc(mv.cardLog.note) + '</span>' : '') + '</p>';
    for (const p of mv.problems) body += note(p, 'cx-bad');
    return card('I', 'Real against simulated money', body, 'cx-first');
  }

  /* III. who goes in today */
  function goes(gv) {
    if (status('roster') !== 'ok') return card('III', 'Who goes in today', failNote('roster'));
    if (!gv.ok) return card('III', 'Who goes in today', note(gv.problem, 'cx-bad'));
    let body = '';
    if (!gv.rows.length) body += note('The roster has no build yet: nothing is approved or placed (not enough data yet).', 'cx-dim');
    else {
      body = staleNote('roster') + body + table('cx-goes', ['Build', 'Overall profit per $1', 'Days to pass', 'Payout speed', 'In a cohort today', 'Sample'], gv.rows.map(r => ({ cells: [
        raw('<b>' + esc(r.name) + '</b> <span class="cx-dim">' + esc(r.kind) + '</span><br><span class="' + (r.approved ? 'cx-gold' : 'cx-dim') + '">' + esc(r.label) + '</span>' + '<br><span class="cx-dim">Named account type: ' + esc(K.NOT_BUILT) + ' (law 1.6)</span>' + (r.live ? '' : '<br><span class="cx-dim">cannot run live' + (r.whyNot ? ': ' + esc(r.whyNot) : '') + '</span>'), 'cx-lead'),
        cell(r.ppdText, 'cx-num cx-lead ' + tone(r.ppd)), raw(esc(r.daysText) + '<br><span class="cx-dim">pass rate ' + esc(r.passText) + '</span>', 'cx-num'),
        raw(esc(r.payoutText) + '<br><span class="cx-dim">' + esc(r.paidText) + '<br>Dollars per funded slot per 30 sessions: ' + esc(K.NOT_BUILT) + ' (law 1.6)</span>', 'cx-num'),
        cell(r.picked.length ? r.picked.join(', ') : 'in none', r.picked.length ? '' : 'cx-dim'), cell(r.sample, 'cx-dim')] })));
      if (gv.left) body += note('And ' + K.plural(gv.left, 'more file') + ' not shown.', 'cx-dim');
    }
    body += '<p class="cx-off"><b>Split by zone and regime: off.</b> ' + esc(gv.zoneWords) + '</p>';
    body += note('Every figure here is simulated by the Prop Sim on in-sample days: not proven, none of it real money. Only builds you approved reach the roster; a placed build says so.', 'cx-dim');
    return card('III', 'Who goes in today', body);
  }

  /* IV. running now, V. today live only: from ChartBridge, through FleetView */
  function running(lv) {
    if (!lv) return card('IV', 'Running now', note('ChartBridge is not connected, so this page cannot tell what is running: not read.', 'cx-dim'));
    const r = K.runningNow(lv.traders, lv.heard);
    let body;
    if (r.cannotTell && !r.total && !r.running.length) body = note(r.cannotTell, 'cx-bad');
    else if (!r.total) body = note('No trader is listed by ChartBridge (nothing running, as far as it says).', 'cx-dim');
    else if (!r.running.length) body = note('Nothing is running now: ' + K.plural(r.total, 'trader') + ' listed' + (r.shadow ? ', ' + r.shadow + ' in Shadow' : '') + ', none in Auto or Copilot.', 'cx-dim');
    else body = table('cx-run', ['Trader', 'Build', 'Mode', 'Accounts', 'Status', 'Today'], r.running.map(t => ({ cells: [cell(t.name, 'cx-lead'), cell(t.build || 'not stated', t.build ? '' : 'cx-dim'), cell(t.mode), cell(t.accounts), cell(t.status), cell(t.today === null ? 'not reported' : (t.today >= 0 ? '+' : '-') + L.usd(Math.abs(t.today)) + (t.trades === null ? '' : ' on ' + K.plural(t.trades, 'trade')), 'cx-num ' + tone(t.today))] })));
    return card('IV', 'Running now', body + (r.cannotTell && (r.total || r.running.length) ? note(r.cannotTell, 'cx-bad') : '') + note('Live, from ChartBridge on this PC. Your personal account and the chart\'s Bot tab are not Legion\'s.', 'cx-dim'));
  }
  function today(lv) {
    if (!lv) return card('V', 'Today, live only', note('ChartBridge is not connected: not read.', 'cx-dim'));
    const t = K.todayLive(lv.accounts);
    let body;
    if (!t.accounts) body = note('No prop account is listed by ChartBridge now (not enough data yet).', 'cx-dim');
    else {
      body = '<p class="cx-big"><span class="cx-num ' + tone(t.sum) + '">' + (t.sum === null ? 'not reported' : (t.sum >= 0 ? '+' : '-') + L.usd(Math.abs(t.sum))) + '</span> <span class="cx-dim">today, ' + t.known + ' of ' + K.plural(t.accounts, 'prop account') + ' reporting</span></p>';
      body += table('cx-today', ['Account', 'Type', 'Today', 'Room to the floor', 'Position'], t.rows.map(a => ({ cells: [cell(a.name, 'cx-lead'), cell(a.stage), cell(a.today === null ? 'not reported' : (a.today >= 0 ? '+' : '-') + L.usd(Math.abs(a.today)) + (a.done ? ' (at the day stop)' : ''), 'cx-num ' + tone(a.today)), cell(a.room === null ? 'not reported' : L.usd(a.room), 'cx-num'), cell(a.position)] })));
    }
    return card('V', 'Today, live only', body + note('Live only: what ChartBridge reports now, realized plus open. Nothing simulated is added to it.', 'cx-dim'));
  }

  /* II. Needs you: the one place */
  function needs(nv) {
    let body;
    if (nv.items.length) {
      body = '<ul class="cx-needs">' + nv.items.map(i => '<li><span class="cx-kind">' + esc(i.kind) + '</span> ' + esc(i.words) + ' ' + (i.where && i.where !== 'castra' ? go(i.where, 'Open ' + i.where) : '') + '</li>').join('') + '</ul>';
    } else body = nv.cannotTell.length ? '' : '<p class="cx-ok"><b>Nothing needs you</b> in what this page can read.</p>';
    if (nv.cannotTell.length) body += note('Cannot tell: ' + [nv.failed.length ? nv.failed.join(', ') + ' could not be read' : '', nv.pending.length ? nv.pending.join(', ') + ' is not read yet' : ''].filter(Boolean).join('; ') + ', so what they would add is not shown here.', 'cx-bad');
    body += note('Not wired here yet: the drift alarm and the posts into The Desk\'s Alerts (step 3.5, ' + K.NOT_BUILT + '). Nothing on this list acts by itself.', 'cx-dim');
    return card('II', 'Needs you', body, nv.items.length ? 'cx-needsyou' : '');
  }

  /* VI. last night */
  function night() {
    if (status('board') !== 'ok') return card('VI', 'Last night', failNote('board'));
    const n = K.lastNight(S.reads.board.ans);
    if (!n.ok) return card('VI', 'Last night', note(n.problem, 'cx-bad'));
    if (!n.night) return card('VI', 'Last night', note(n.words, 'cx-dim'));
    const x = n.night, num = v => (v === null ? 'not reported' : String(v));
    const body = '<dl class="cx-kv"><dt>Night</dt><dd>' + esc(x.night || 'not stated') + '</dd><dt>Builds asked</dt><dd>' + esc(num(x.asked)) + '</dd><dt>Builds made</dt><dd>' + esc(num(x.made)) + ' (' + esc(num(x.fresh)) + ' new, ' + esc(num(x.neighbours)) + ' neighbours' + (x.skipped ? ', ' + x.skipped + ' skipped as already tried' : '') + ')</dd>'
      + (n.builds === null ? '' : '<dt>In the line now</dt><dd>' + esc(String(n.builds)) + '</dd>') + '</dl>' + note('Builds only, in-sample: no build is proven or real money. The Ludus has each one.', 'cx-dim') + go('ludus', 'Open the Ludus');
    return card('VI', 'Last night', body);
  }

  /* VII. Centurion's week, its veto and its undo */
  const keyOf = (kind, runId, name) => kind + '|' + runId + '|' + name;
  const centFresh = () => { const rs = K.readStatus(S.reads.centurion); return rs.state === 'ok' && !rs.stale; };
  function askBox(kind) {
    const a = S.ask;
    if (!a || a.kind !== kind) return '';
    return '<div class="cx-ask" role="alertdialog" aria-modal="false" aria-labelledby="cxAskQ" data-cx-ask="' + esc(kind) + '"><span id="cxAskQ">' + esc(a.words) + '</span>'
      + '<button type="button" class="lx-btn cx-yes" data-cx-yes>Yes, ' + esc(kind) + '</button><button type="button" class="lx-btn" data-cx-no>Cancel</button></div>';
  }
  function actBtn(kind, runId, name, can) {
    if (!can) return '';
    const k = keyOf(kind, runId, name), sending = S.sending === k, label = kind === 'veto' ? 'Veto' : 'Undo';
    return '<button type="button" class="lx-btn cx-act" data-cx-' + kind + ' data-run="' + esc(runId) + '" data-name="' + esc(name) + '"'
      + (S.sending ? ' disabled' : '') + (S.ask && S.ask.key === k ? ' aria-expanded="true"' : '') + '>' + (sending ? 'Sending...' : label) + '</button>';
  }
  function centurion() {
    const failed = S.reads.centurion.state === 'fail';
    const away = failed ? note(K.VETO_UNREACHABLE, 'cx-bad') : '';
    if (status('centurion') !== 'ok') return card('VII', 'Centurion\'s week', failNote('centurion') + away);
    const c = K.centurionView(S.reads.centurion.ans), fresh = centFresh();
    let body = staleNote('centurion');
    if (c.ok) {
      body += '<p>' + esc(c.summary || 'The report has no summary.') + '</p>';
      if (c.findings.length) body += '<ul class="cx-list">' + c.findings.map(f => '<li>' + esc(f) + '</li>').join('') + '</ul>';
      body += note(K.IN_SAMPLE, 'cx-sim');
    } else body += note(c.problem, 'cx-dim');
    if (!c.acts) {
      /* an older Desk (its veto not built) or a veto this page does not know: the report as before, and nothing to act on */
      if (c.ok) body += c.changes.length ? table('cx-chg', ['Change', 'From', 'To', 'Allowed'], c.changes.map(x => ({ cells: [cell(x.name, 'cx-lead'), cell(x.from, 'cx-num'), cell(x.to, 'cx-num'), cell(x.allowed ? 'yes' : 'no', x.allowed ? '' : 'cx-dim')] }))) : note('No change proposed.', 'cx-dim');
      body += note(K.VETO_UNKNOWN + (c.vetoWords ? ' The Desk: ' + c.vetoWords : '') + ' (plan steps 2.9 and 3.3: Centurion applies nothing until the veto is on.)', 'cx-dim');
    } else {
      const w = c.week;
      body += '<p class="cx-sub">This week\'s changes</p>';
      if (!w) body += note(K.NO_WEEK, 'cx-dim');
      else {
        if (c.ok && c.runId && w.runId && c.runId !== w.runId) body += note('The summary above is from report ' + c.runId + (c.status ? ' (' + c.status + ')' : '') + '; the changes below are from this week\'s Saturday report, ' + w.runId + '.', 'cx-dim');
        if (!w.changes.length) body += note(K.NO_CHANGE, 'cx-dim');
        else body += table('cx-veto', ['Setting', 'From', 'To', 'Why', 'Then'], w.changes.map(x => ({ attrs: ' data-cx-change="' + esc(x.name) + '"', cells: [cell(x.name, 'cx-lead'), cell(x.from, 'cx-num'), cell(x.to, 'cx-num'), cell(x.why || 'not stated', x.why ? '' : 'cx-dim'),
          x.can && fresh ? raw(actBtn('veto', w.runId, x.name, true)) : cell(x.can ? 'Not vetoed' : x.then, x.allowed ? '' : 'cx-dim')] })));
        body += askBox('veto');
        body += '<p class="cx-window" data-cx-window="' + esc(w.state) + '">' + esc(w.words || ('The Desk gives no words for the window (' + w.state + ').')) + '</p>';
        if (w.closes) body += note((w.state === 'open' ? 'The veto window closes ' : 'The veto window closed ') + w.closes + ', New York time.', 'cx-dim');
      }
      body += '<p class="cx-sub">Applied changes</p>';
      const a = c.applied;
      if (!a.ok) body += note(a.problem, 'cx-bad');
      else if (!a.rows.length) body += note(K.NO_APPLIED, 'cx-dim');
      else {
        body += table('cx-applied', ['Setting', 'From', 'To', 'When', 'Undo'], a.rows.map(r => ({ attrs: ' data-cx-applied="' + esc(r.runId + ' ' + r.name) + '"', cells: [cell(r.name, 'cx-lead'), cell(r.from, 'cx-num'), cell(r.to, 'cx-num'), cell(r.when, 'cx-dim'),
          r.can && fresh ? raw(actBtn('undo', r.runId, r.name, true)) : cell(r.can ? 'Not undone' : r.then, r.state === 'refused' ? '' : 'cx-dim')] })));
        if (a.more) body += note('And ' + a.more.toLocaleString('en-US') + ' older.', 'cx-dim');
      }
      body += askBox('undo');
    }
    if (S.said) body += '<p class="cx-said' + (S.saidBad ? ' cx-bad' : '') + '" role="status" aria-live="polite" data-cx-said>' + esc(S.said) + '</p>';
    body += away;
    return card('VII', 'Centurion\'s week', body + note('Report ' + (c.runId || 'without an id') + (c.status ? ', ' + c.status : '') + '.', 'cx-dim'), 'cx-cent');
  }
  /* the question: open, close, Yes */
  function endAsk() { S.ask = null; clearTimeout(S.askTimer); S.askTimer = 0; }
  function say(text, bad) { S.said = String(text || ''); S.saidBad = !!bad; }
  function openAsk(kind, runId, name) {
    if (S.sending) return;
    const k = keyOf(kind, runId, name);
    if (S.ask && S.ask.key === k) { endAsk(); render(); return; }                  // the same button again closes it, as Stop all
    const v = K.centurionView(S.reads.centurion.ans), act = K.actionFor(v, centFresh(), kind, runId, name);
    if (act.why) { endAsk(); say(act.why, true); render(); return; }
    const row = kind === 'undo' ? v.applied.rows.find(r => r.runId === runId && r.name === name) : null;
    S.ask = { kind, runId, name, key: k, at: Date.now(), words: kind === 'veto' ? K.VETO_Q : K.undoQuestion(name, row ? row.from : '-') };
    clearTimeout(S.askTimer);
    S.askTimer = setTimeout(() => { if (S.ask && S.ask.key === k && Date.now() - S.ask.at >= K.CONFIRM_MS) { endAsk(); render(); } }, K.CONFIRM_MS + 50);
    say('', false);
    render();
    const no = el.querySelector('[data-cx-no]'); if (no) no.focus();
  }
  function send() {
    const a = S.ask;
    endAsk();
    if (!a || S.sending) { render(); return; }
    const act = K.actionFor(K.centurionView(S.reads.centurion.ans), centFresh(), a.kind, a.runId, a.name);    // read again at the Yes: the last answer still offers it
    if (act.why) { say('Not sent: ' + act.why, true); render(); return; }
    S.sending = keyOf(a.kind, a.runId, a.name);
    say('', false);
    render();
    desk.post(act.route, act.body)
      .then(ans => say(K.sentWords(a.kind, ans), false), e => say(K.refusedWords(a.kind, e), true))
      .then(() => { S.sending = ''; render(); if (S.shown) { read('centurion', K.ROUTES.centurion).then(render); render(); } });   // read again at once (the other reads keep their own turn)
  }
  function onYes(e) {
    const r = K.askClick(S.ask ? S.ask.at : 0, Date.now(), realClick(e));
    if (r === 'late') { endAsk(); say('The question closed (8 s): nothing was sent.', false); render(); return; }
    if (r === 'key') { say('A veto or an undo is confirmed by a click on Yes only, not by keyboard. Cancel and Escape work from the keyboard.', true); render(); return; }
    if (r === 'early') { say('Too soon: read the question, then click Yes.', true); render(); return; }
    if (r === 'yes') send();
  }

  function render() {
    if (!S.shown) return;
    try {
      const lv = live();
      const cv = status('cohorts') === 'ok' ? K.cohortsView(S.reads.cohorts.ans, lv ? lv.accounts : [], lv ? lv.traders : [], !!(lv && lv.heard)) : null;
      const mv = status('money') === 'ok' ? K.moneyView(S.reads.money.ans) : null;
      const reads = {}; for (const n of NAMES) { const rs = K.readStatus(S.reads[n]); reads[n] = rs.stale ? 'fail' : rs.state; }
      const nv = K.needsYou({ money: mv, cohorts: cv, traders: lv ? lv.traders : [], reads });
      const gv = status('roster') === 'ok' ? K.goesInView(S.reads.roster.ans, status('cohorts') === 'ok' ? S.reads.cohorts.ans : null) : null;
      const html = '<div class="cx cx-body">' + money(mv) + needs(nv) + goes(gv) + '<div class="cx-two">' + running(lv) + today(lv) + '</div>' + '<div class="cx-two">' + night() + centurion() + '</div>'
        + '<p class="cx-foot"><button type="button" class="lx-btn" data-cx-again>Read again</button> <span class="cx-dim">Read ' + (S.readAt ? new Date(S.readAt).toLocaleTimeString('en-US', { hour12: false }) : 'not yet') + ', then every minute while this tab is open.</span></p></div>';
      if (html !== S.last) { S.last = html; el.innerHTML = html; }
    } catch (e) { el.innerHTML = '<div class="lx-card lx-todo"><p>Castra could not draw: ' + esc(e && e.message) + '. The other tabs work; reload this window.</p></div>'; S.last = ''; }
  }
  const onClick = e => {
    const g = e.target.closest('[data-cx-go]'), a = e.target.closest('[data-cx-again]');
    const v = e.target.closest('[data-cx-veto]'), u = e.target.closest('[data-cx-undo]');
    if (g && typeof o.go === 'function') { e.preventDefault(); o.go(g.dataset.cxGo); }
    else if (a && S.shown) readAll();
    else if (v || u) { const b = v || u; if (!b.disabled) openAsk(v ? 'veto' : 'undo', b.dataset.run || '', b.dataset.name || ''); }
    else if (e.target.closest('[data-cx-yes]')) onYes(e);
    else if (e.target.closest('[data-cx-no]')) { endAsk(); render(); }
  };
  el.addEventListener('click', onClick);
  const onKey = e => { if (e.key === 'Escape' && S.ask) { endAsk(); render(); e.preventDefault(); } };
  document.addEventListener('keydown', onKey, true);
  function show(on) {
    on = on === true;
    if (on === S.shown) return S.shown;
    S.shown = on;
    clearInterval(S.timer); clearInterval(S.tick);
    if (on) { readAll(); S.timer = setInterval(readAll, READ_EVERY_MS); S.tick = setInterval(render, 1000); }
    else { S.gen++; endAsk(); }                                // a hidden Castra reads nothing, an answer in flight is dropped, a question closes
    return S.shown;
  }
  render();
  return { show, state: () => ({ shown: S.shown, readAt: S.readAt, reads: Object.fromEntries(NAMES.map(n => [n, S.reads[n].state])),
      money: S.reads.money.ans ? K.moneyView(S.reads.money.ans) : null, needs: K.needsYou({ money: S.reads.money.ans ? K.moneyView(S.reads.money.ans) : null, cohorts: null, traders: [], reads: {} }).items,
      centurion: S.reads.centurion.ans ? K.centurionView(S.reads.centurion.ans) : null, asking: S.ask ? { kind: S.ask.kind, runId: S.ask.runId, name: S.ask.name } : null, sending: S.sending, said: S.said, saidBad: S.saidBad }),
    readAgain: readAll, destroy() { clearInterval(S.timer); clearInterval(S.tick); endAsk(); S.gen++; el.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey, true); } };
}

window.LegionCastra = { mount };
})();
