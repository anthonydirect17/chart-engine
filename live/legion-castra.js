/*
 * LegionCastra (plan step 3.3): Legion's home tab, drawn from LegionCastraCore (live/legion-castra-core.js, the pure part and its
 * reads). ROI first (Rule 1): at the top, real money against simulated money per roster build with the money alarm (law 9.2);
 * then the daily "who goes in today" view (each roster build's overall profit per $1, days to pass and payout speed; its split
 * by zone and regime stays off), what is running now, Needs you (the one place a decision waits), last night, today (live only)
 * and Centurion's week (read only: its veto is not built yet, so there is no veto action).
 *
 * Read only: this file sends nothing to ChartBridge, writes nothing to The Desk and places nothing. A hidden Castra reads
 * nothing; a shown one reads The Desk once, then every READ_EVERY_MS while it stays shown, or at "Read again". What only the
 * trading PC knows (the traders, the prop accounts' day) is read from FleetView's own state (o.live()), never a second time.
 *
 *   const v = LegionCastra.mount(el, { deskBase, fetch, live, go });
 *     deskBase()  The Desk's address (AccountsPage.deskBase); fetch: window.fetch
 *     live()      { traders, accounts } from FleetView.state() (FleetCore.traders and FleetCore.propAccounts), or null
 *     go(tab)     opens another Legion tab (Needs you's links)
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
  const S = { shown: false, gen: 0, timer: 0, tick: 0, readAt: 0, last: '', reads: {} };
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
        raw(esc(b.real.ppd) + (b.real.words && !b.real.has && b.real.words !== K.NOT_ENOUGH ? '<br><span class="cx-dim">' + esc(b.real.words) + '</span>' : ''), 'cx-num cx-lead ' + b.real.ppdTone),
        cell(b.hasSim ? b.sim.eval.text : 'no simulated figure (not on the roster)', 'cx-sim'),
        cell(b.real.costs, 'cx-num'), cell(b.real.payouts, 'cx-num'), cell(b.real.net, 'cx-num ' + b.real.netTone), cell(b.real.sample, 'cx-dim'),
        raw('<span class="cx-al cx-al-' + esc(b.alarm.state) + '">' + esc(b.alarm.state === 'tripped' ? 'Tripped' : b.alarm.state === 'clear' ? 'Clear' : 'Not known yet') + '</span> <span class="cx-dim">' + esc(b.alarm.words) + '</span>')] })));
      body += note('Real: the prop ledger, split by the day each account ran the build (The Desk). ' + K.SIM_LABEL, 'cx-dim');
    }
    if (mv.total) body += note('The ledger in all: ' + K.plural(mv.total.entries, 'entry', 'entries') + ', costs ' + mv.total.costs + ', payouts ' + mv.total.payouts + (mv.unattributed ? '; of it ' + K.plural(mv.unattributed.entries, 'entry', 'entries') + ' (costs ' + mv.unattributed.costs + ') belong to no build' : '') + '.', 'cx-dim');
    for (const p of mv.problems) body += note(p, 'cx-bad');
    return card('I', 'Real against simulated money', body, 'cx-first');
  }

  /* II. who goes in today */
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

  /* III. running now, VI. today live only: from ChartBridge, through FleetView */
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

  /* IV. Needs you: the one place */
  function needs(nv) {
    let body;
    if (nv.items.length) {
      body = '<ul class="cx-needs">' + nv.items.map(i => '<li><span class="cx-kind">' + esc(i.kind) + '</span> ' + esc(i.words) + ' ' + (i.where && i.where !== 'castra' ? go(i.where, 'Open ' + i.where) : '') + '</li>').join('') + '</ul>';
    } else body = nv.cannotTell.length ? '' : '<p class="cx-ok"><b>Nothing needs you</b> in what this page can read.</p>';
    if (nv.cannotTell.length) body += note('Cannot tell: ' + [nv.failed.length ? nv.failed.join(', ') + ' could not be read' : '', nv.pending.length ? nv.pending.join(', ') + ' is not read yet' : ''].filter(Boolean).join('; ') + ', so what they would add is not shown here.', 'cx-bad');
    body += note('Not wired here yet: the drift alarm and the posts into The Desk\'s Alerts (step 3.5, ' + K.NOT_BUILT + '). Nothing on this list acts by itself.', 'cx-dim');
    return card('II', 'Needs you', body, nv.items.length ? 'cx-needsyou' : '');
  }

  /* V. last night */
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

  /* VII. Centurion's week, read only */
  function centurion() {
    if (status('centurion') !== 'ok') return card('VII', 'Centurion\'s week', failNote('centurion'));
    const c = K.centurionView(S.reads.centurion.ans);
    if (!c.ok) return card('VII', 'Centurion\'s week', note(c.problem, 'cx-dim'));
    let body = '<p>' + esc(c.summary || 'The report has no summary.') + '</p>';
    if (c.findings.length) body += '<ul class="cx-list">' + c.findings.map(f => '<li>' + esc(f) + '</li>').join('') + '</ul>';
    body += c.changes.length ? table('cx-chg', ['Change', 'From', 'To', 'Allowed'], c.changes.map(x => ({ cells: [cell(x.name, 'cx-lead'), cell(x.from, 'cx-num'), cell(x.to, 'cx-num'), cell(x.allowed ? 'yes' : 'no', x.allowed ? '' : 'cx-dim')] }))) : note('No change proposed.', 'cx-dim');
    body += note('Read only. Veto: ' + K.NOT_BUILT + ' (plan steps 2.9 and 3.3): this page has no veto action, and Centurion applies nothing until the veto exists' + (c.vetoBuilt ? ' (The Desk says its veto exists; this page does not act on it)' : '') + (c.applies ? ' (the report says it applies, which this page does not take to mean anything)' : '') + '.', 'cx-dim');
    return card('VII', 'Centurion\'s week', body + note('Report ' + (c.runId || 'without an id') + (c.status ? ', ' + c.status : '') + '.', 'cx-dim'));
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
    if (g && typeof o.go === 'function') { e.preventDefault(); o.go(g.dataset.cxGo); }
    else if (a && S.shown) readAll();
  };
  el.addEventListener('click', onClick);
  function show(on) {
    on = on === true;
    if (on === S.shown) return S.shown;
    S.shown = on;
    clearInterval(S.timer); clearInterval(S.tick);
    if (on) { readAll(); S.timer = setInterval(readAll, READ_EVERY_MS); S.tick = setInterval(render, 1000); }
    else S.gen++;                                              // a hidden Castra reads nothing, and an answer in flight is dropped
    return S.shown;
  }
  render();
  return { show, state: () => ({ shown: S.shown, readAt: S.readAt, reads: Object.fromEntries(NAMES.map(n => [n, S.reads[n].state])),
      money: S.reads.money.ans ? K.moneyView(S.reads.money.ans) : null, needs: K.needsYou({ money: S.reads.money.ans ? K.moneyView(S.reads.money.ans) : null, cohorts: null, traders: [], reads: {} }).items }),
    readAgain: readAll, destroy() { clearInterval(S.timer); clearInterval(S.tick); S.gen++; el.removeEventListener('click', onClick); } };
}

window.LegionCastra = { mount };
})();
