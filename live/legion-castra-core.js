/*
 * LegionCastraCore (plan step 3.3): the pure part of Legion's Castra and Cohorts tabs. No DOM: Node tests require it
 * (test/legion-castra.test.js); a plain <script> sets window.LegionCastraCore. live/legion-castra.js and live/legion-cohorts.js
 * draw it. It reuses LudusCore (live/ludus-core.js) for the routes it shares (the roster, the ledger), the words for a failed
 * read (failWords), the number words (perDollar, pct, usd, sessionsText, sampleText), the board's reader and the zone switch.
 *
 * WHAT IT READS (The Desk, TheDesk PR 112, docs/API.md "Legion"; Castra and Cohorts read only, and Cohorts writes only the
 * cohort model's drag and drop):
 *   the roster    GET /api/legion/roster      the roster files (LudusCore.ROUTES.roster)
 *   the cohorts   GET /api/legion/cohorts     the prop account groups, each cohort's pick, firm and PC, every prop account
 *   the move      PUT /api/legion/cohorts/members {version, account, cohort|null}   the one write: drag and drop
 *   the money     GET /api/legion/money       real profit per $1 per roster build beside the Prop Sim's own (law 9.2)
 *   Centurion     GET /api/legion/centurion   the weekly report, the week's veto window and the applied log (contract v1, 2026-11-19)
 *   the veto      POST /api/legion/centurion/veto {run_id, name}   one change of this week's Saturday report turned off
 *   the undo      POST /api/legion/centurion/undo {run_id, name}   one applied change asked back (done at the next night's run)
 * Centurion's three routes are the only ones Castra uses for him. It never calls the seal or the undo list (POST
 * /api/legion/centurion/seal, GET /api/legion/centurion/undos): those are Bot-Lab's night run's, on the box (a test pins it).
 *   the board     GET /api/legion/board       the loop board (last night's builds; LudusCore.boardOf reads it)
 *   the league    GET /api/chart-league       the Drone sky's day (LeagueCore.cleanDay)
 * What only the trading PC knows (a trader's mode, an account's position, its room to the floor and its day) comes from the
 * page's one reader of ChartBridge, FleetView (live/fleet.js: FleetCore.traders and FleetCore.propAccounts); nothing here
 * reads ChartBridge a second time.
 *
 * ROI FIRST (Rule 1, law 1.6): the real money line leads with real profit per $1 beside the simulated one, each with its
 * sample, and a figure with no sample reads "not enough data yet". Every simulated number is labelled simulated (in-sample).
 * THE MONEY ALARM (law 9.2): real profit per $1 under the low end of the Prop Sim's own range95 for the build is shown as
 * tripped. The alarm that STOPS new entries and buys no more evals is step 3.5's (the order path): this page shows it only.
 * THE SPLIT BY ZONE AND REGIME stays off (LudusCore.ZONE_SPLIT_ON) until a zone version passes test 3.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ludus-core.js'));
  else root.LegionCastraCore = factory(root.LudusCore);
})(typeof self !== 'undefined' ? self : this, function (L) {
'use strict';

const NOT_ENOUGH = L.NOT_ENOUGH, NOT_BUILT = 'not built yet';
const ROUTES = Object.freeze({
  roster: L.ROUTES.roster,
  ledger: L.ROUTES.ledger,
  cohorts: '/api/legion/cohorts',
  members: '/api/legion/cohorts/members',
  money: '/api/legion/money',
  centurion: '/api/legion/centurion',
  centurionVeto: '/api/legion/centurion/veto',
  centurionUndo: '/api/legion/centurion/undo',
  board: '/api/legion/board',
  league: '/api/chart-league',
});
const FLEET_PATH = '/#/prop/fleet';       // The Desk's Prop screen, Accounts: Fleet, the one place for every prop account's book (plan 3.6)
const RN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const MAX_ROWS = 60;

const isNum = x => typeof x === 'number' && isFinite(x);
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x, n) => (typeof x === 'string' ? (n ? x.slice(0, n) : x) : '');
const lc = s => str(s).toLowerCase();
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => n.toLocaleString('en-US') + ' ' + (n === 1 ? one : (many || one + 's'));

/* ---------------------------------------------------------------- the one Desk client (Castra and Cohorts share it) */
/**
 * { get(path), put(path, body), post(path, body) }: The Desk's one address (deskBase(), AccountsPage.deskBase), no credentials, never
 * cached. A failed read or write rejects with { words, status, body }: words in plain language naming the route (LudusCore.failWords);
 * status null when The Desk did not answer (off, a hang past the timeout, or an answer that does not read).
 */
function deskClient(o) {
  const TIMEOUT_MS = isNum(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : 15000;
  /* a hang becomes a failure: the request is aborted (AbortController) and, whatever the fetch does, the answer is not waited for past TIMEOUT_MS */
  const withTimeout = (go) => {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = 0;
    const late = new Promise((_, no) => { timer = setTimeout(() => { if (ac) ac.abort(); no({ status: null, timedOut: true }); }, TIMEOUT_MS); });
    return Promise.race([go(ac ? ac.signal : undefined), late]).then(r => { clearTimeout(timer); return r; }, e => { clearTimeout(timer); return Promise.reject(e); });
  };
  const base = () => Promise.resolve().then(() => o.deskBase());
  const fail = (path, e) => Promise.reject({ words: e && e.timedOut ? 'The Desk did not answer ' + path.split('?')[0] + ' in ' + Math.round(TIMEOUT_MS / 1000) + ' s.' : L.failWords(path.split('?')[0], e && typeof e.status === 'number' ? e.status : null), status: e && typeof e.status === 'number' ? e.status : null, body: e && e.body ? e.body : null });
  const answer = r => (r.ok ? r.json() : r.json().catch(() => null).then(b => Promise.reject({ status: r.status, body: b })));
  return {
    get: path => withTimeout(signal => base().then(b => o.fetch(b + path, { cache: 'no-store', mode: 'cors', credentials: 'omit', signal })).then(answer)).catch(e => fail(path, e)),
    put: (path, body) => withTimeout(signal => base().then(b => o.fetch(b + path, { method: 'PUT', cache: 'no-store', mode: 'cors', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })).then(answer)).catch(e => fail(path, e)),
    post: (path, body) => withTimeout(signal => base().then(b => o.fetch(b + path, { method: 'POST', cache: 'no-store', mode: 'cors', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })).then(answer)).catch(e => fail(path, e)),
  };
}

/* ---------------------------------------------------------------- markup helpers (strings: the views set them as html) */
function table(cls, heads, rows) {
  return '<div class="lx-tbl ' + cls + '"><table><thead><tr>' + heads.map(h => '<th scope="col">' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr' + (r.attrs || '') + '>' + r.cells.map((c, i) => '<td data-l="' + esc(heads[i]) + '"' + (c.cls ? ' class="' + c.cls + '"' : '') + '>' + c.html + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}
const cell = (text, cls) => ({ html: esc(text), cls });
const raw = (html, cls) => ({ html, cls });
const card = (rn, title, body, extra) => '<section class="lx-card cx-card' + (extra ? ' ' + extra : '') + '"><h2>' + (rn ? '<span class="lx-rn">' + esc(rn) + '</span>' : '') + esc(title) + '</h2>' + body + '</section>';
const note = (text, cls) => '<p class="cx-note' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</p>';
const tone = x => (isNum(x) ? (x > 0 ? 'cx-up' : x < 0 ? 'cx-down' : '') : '');

/* ---------------------------------------------------------------- the money: real beside simulated, per roster build */
const SIM_LABEL = 'Simulated by the Prop Sim on in-sample days: not proven, and none of it is real money.';
/** The Prop Sim's own number for a stage of a build ({ ppd, low, high, text }): "+1.10 per $1 (range +0.20 to +2.00), simulated". */
function simStage(sim, stage) {
  const s = isObj(sim) && isObj(sim[stage]) ? sim[stage] : null;
  if (!s || !isNum(s.profit_per_dollar)) return { ppd: null, low: null, high: null, text: NOT_ENOUGH };
  const r = Array.isArray(s.range95) && s.range95.length === 2 && isNum(s.range95[0]) && isNum(s.range95[1]) ? s.range95 : null;
  return { ppd: s.profit_per_dollar, low: r ? r[0] : null, high: r ? r[1] : null,
    text: L.perDollar(s.profit_per_dollar) + (r ? ' (range ' + L.signed(r[0]) + ' to ' + L.signed(r[1]) + ')' : ' (no range given)') + ', simulated' };
}
/**
 * The money alarm of one build (law 9.2, Anthony 2026-11-19): real results are held to the Prop Sim's range for the SAME NUMBER of
 * evals. The Desk serves only the range of the sim's own run (range95), not a range for N evals, so until that is served the alarm
 * reads "not known yet" and never trips: a range for a different number of evals would trip it wrongly. rangeForN is that served range,
 * { low } for the build's number of evals, or null (always null today). -> { state: 'tripped' | 'clear' | 'unknown', words }.
 * It stops nothing here (step 3.5).
 */
const ALARM_NOT_KNOWN = 'Not known yet: the Prop Sim\'s range for the same number of evals is not served yet (law 9.2), so real money cannot be judged against it.';
function alarmOf(real, simEval, rangeForN) {
  if (!rangeForN || !isNum(rangeForN.low)) return { state: 'unknown', words: ALARM_NOT_KNOWN };
  if (!isObj(real) || !isNum(real.profit_per_dollar) || !isNum(real.costs) || real.costs <= 0) return { state: 'unknown', words: 'No real figure yet (' + NOT_ENOUGH + '): nothing to hold to the simulated range.' };
  if (real.profit_per_dollar < rangeForN.low) {
    return { state: 'tripped', words: 'Money alarm: real profit per $1 (' + L.signed(real.profit_per_dollar) + ') is under the low end of the Prop Sim\'s range for the same number of evals (' + L.signed(rangeForN.low) + '). It decides nothing by itself yet: the stop is step 3.5 (' + NOT_BUILT + ').' };
  }
  return { state: 'clear', words: 'Real profit per $1 (' + L.signed(real.profit_per_dollar) + ') is not under the low end of the Prop Sim\'s range for the same number of evals (' + L.signed(rangeForN.low) + ').' };
}
/**
 * TheDesk #120 (docs/API.md, GET /api/legion/money): an entry is counted under the card's fills account as it stood when the entry
 * was booked, from The Desk's log of the card's fills account. For an entry dated before the log began (or a card whose log
 * cannot be read) whether the card had another account then cannot be told: The Desk reads it by the card's account now, counts
 * it in real.card_account_could_not_tell and sets real.card_account_words ("could not tell"). The numbers are still shown, and
 * the page says so beside the build's real figure. -> the words, or '' when every entry could be told (or the Desk says nothing).
 */
function cardAccountWords(r) {
  const n = isObj(r) && isNum(r.card_account_could_not_tell) && r.card_account_could_not_tell > 0 ? Math.floor(r.card_account_could_not_tell) : 0;
  const w = isObj(r) ? str(r.card_account_words, 60) : '';
  if (!n && !w) return '';
  return (w || 'could not tell') + ': ' + (n ? plural(n, 'entry', 'entries') : 'some entries') + ' counted by the card\'s fills account now (whether the card had another account when ' + (n === 1 ? 'it was' : 'they were') + ' booked cannot be told)';
}
/** One build's real money cells: { ppd, costs, payouts, net, sample, cardAccount } as words ("not enough data yet" with no figure). */
function realCells(real) {
  const r = isObj(real) ? real : {};
  const has = isNum(r.profit_per_dollar);
  const entries = isNum(r.entries) ? r.entries : 0, accounts = isNum(r.accounts) ? r.accounts : 0, withCard = isNum(r.accounts_with_a_card) ? r.accounts_with_a_card : null;
  return { has, ppd: has ? L.perDollar(r.profit_per_dollar) : NOT_ENOUGH, costs: L.usd(r.costs) || NOT_ENOUGH, payouts: L.usd(r.payouts) || NOT_ENOUGH, net: L.usd(r.net) || NOT_ENOUGH,
    netTone: tone(r.net), ppdTone: tone(has ? r.profit_per_dollar : null),
    sample: plural(entries, 'ledger entry', 'ledger entries') + ' on ' + plural(accounts, 'account') + (withCard !== null ? ' (' + withCard + ' with a card)' : ''), words: str(r.words, 120),
    cardAccount: cardAccountWords(r) };
}
/**
 * The ledger-level line of TheDesk #120: by_card_account_could_not_tell (the entries of every build read by the card's account now)
 * and card_account_log ({ began: the log's first trade day, note }). -> { couldNotTell, began, note, words }, or null when The Desk
 * gives neither (a Desk from before #120: nothing to say).
 */
function cardAccountLog(ans) {
  const n = isObj(ans) && isNum(ans.by_card_account_could_not_tell) && ans.by_card_account_could_not_tell >= 0 ? Math.floor(ans.by_card_account_could_not_tell) : null;
  const log = isObj(ans) && isObj(ans.card_account_log) ? ans.card_account_log : null;
  if (n === null && !log) return null;
  const began = log && /^\d{4}-\d{2}-\d{2}$/.test(str(log.began)) ? log.began : null, logNote = log ? str(log.note, 300) : '';
  let words = 'Each entry counts under the card\'s fills account when it was booked, from The Desk\'s log of each card\'s fills account, which '
    + (began ? 'begins on ' + began + ' (its first trade day).' : 'gives no first day (could not tell when it began).');
  if (n === null) words += ' The Desk does not say how many entries could not be told.';
  else if (n) words += ' Could not tell for ' + plural(n, 'entry', 'entries') + ' (booked before the log began, or a card whose log cannot be read): each is counted by the card\'s fills account now, and the card may have had another account then.';
  else words += ' Every entry could be told.';
  return { couldNotTell: n, began, note: logNote, words };
}
/** The money answer as the page shows it: { ok, problem, builds, unattributed, total, tripped, note }. */
function moneyView(ans) {
  if (!isObj(ans) || !Array.isArray(ans.builds)) return { ok: false, problem: 'The money\'s answer is not one this page knows.', builds: [], unattributed: null, total: null, tripped: 0, note: '' };
  const builds = ans.builds.filter(isObj).slice(0, MAX_ROWS).map(b => {
    const sim = { eval: simStage(b.simulated, 'eval'), funded: simStage(b.simulated, 'funded') };
    const real = realCells(b.real);
    return { bot: str(b.bot, 60), file: str(b.file, 60), onRoster: b.on_roster === true, accounts: Array.isArray(b.accounts) ? b.accounts.filter(x => typeof x === 'string').slice(0, 50) : [],
      real, sim, hasSim: isObj(b.simulated), alarm: alarmOf(b.real, sim.eval, null) };
  });
  const un = isObj(ans.unattributed) ? ans.unattributed : null, tot = isObj(ans.ledger_total) ? ans.ledger_total : null;
  return { ok: true, problem: null, builds, tripped: builds.filter(b => b.alarm.state === 'tripped').length,
    unattributed: un ? { entries: isNum(un.entries) ? un.entries : 0, costs: L.usd(un.costs) || '$0', payouts: L.usd(un.payouts) || '$0' } : null,
    total: tot ? { entries: isNum(tot.entries) ? tot.entries : 0, costs: L.usd(tot.costs) || '$0', payouts: L.usd(tot.payouts) || '$0' } : null,
    problems: Array.isArray(ans.problems) ? ans.problems.filter(x => typeof x === 'string').slice(0, 10) : [], note: str(ans.note, 400),
    cardLog: cardAccountLog(ans) };
}

/* ---------------------------------------------------------------- who goes in today: each roster build's overall ROI, days to pass, payout speed */
/**
 * The roster's builds, one row each, from GET /api/legion/roster: a bot's file or a lineup's, never a quick one. Approved builds
 * first (only builds Anthony approved reach the roster; a placed one says so), then the best overall profit per $1. Overall
 * profit per $1 is the file's own business figure for the build (its eval stage's numbers); days to pass is the eval stage's
 * median, payout speed the funded stage's median sessions to the first payout. cohorts: the cohorts that picked this file today.
 * The split by zone and regime stays off (LudusCore.ZONE_SPLIT_ON).
 */
function goesInView(rosterAns, cohortsAns) {
  if (!isObj(rosterAns)) return { ok: false, problem: 'The roster\'s answer is not one this page knows.', rows: [], left: 0 };
  if (!rosterAns.ok) return { ok: false, problem: str(rosterAns.problem) || 'The roster is not there yet.', rows: [], left: 0 };
  const cohorts = isObj(cohortsAns) && Array.isArray(cohortsAns.cohorts) ? cohortsAns.cohorts.filter(isObj) : [];
  const rows = [];
  for (const f of Array.isArray(rosterAns.files) ? rosterAns.files : []) {
    if (!isObj(f) || !f.ok || f.quick || !isObj(f.roster)) continue;
    const r = f.roster, lineup = r.format === 'specrunner.lineup/1';
    if (r.format !== 'specrunner.roster/1' && !lineup) continue;
    const n = isObj(r.numbers) ? r.numbers : {}, ev = isObj(n.eval) ? n.eval : {}, fu = isObj(n.funded) ? n.funded : {};
    const rec = isObj(r.record) ? r.record : {};
    const approved = isObj(f.board) && f.board.group === 'approved_by_anthony';
    const picked = cohorts.filter(c => isObj(c.pick) && c.pick.file === f.name).map(c => str(c.name, 40));
    const has = isNum(ev.profit_per_dollar);
    rows.push({ file: str(f.name, 60), name: str(r.display_name, 40) || str(lineup ? r.lineup : r.bot, 60) || str(f.name, 60), kind: lineup ? 'lineup' : 'bot',
      approved, label: approved ? 'approved by Anthony' : L.PLACED,
      ppd: has ? ev.profit_per_dollar : null, ppdText: has ? L.perDollar(ev.profit_per_dollar) + ' (simulated)' : NOT_ENOUGH,
      daysText: ev.sessions_to_pass === null ? 'none passed' : (L.sessionsText(ev.sessions_to_pass) ? L.sessionsText(ev.sessions_to_pass) + ' (median, simulated)' : NOT_ENOUGH),
      passText: L.pct(ev.eval_pass) ? L.pct(ev.eval_pass) + ' (simulated)' : NOT_ENOUGH,
      payoutText: fu.sessions_to_first_payout === null ? 'none paid' : (L.sessionsText(fu.sessions_to_first_payout) ? L.sessionsText(fu.sessions_to_first_payout) + ' to the first payout (median, simulated)' : NOT_ENOUGH),
      paidText: L.usd(fu.paid_per_funded) ? L.usd(fu.paid_per_funded) + ' per funded account (simulated)' : NOT_ENOUGH,
      sample: L.sampleText({ trades: rec.trades, sessions: rec.sessions }), live: r.runs_live === true, whyNot: str(r.why_not, 200), picked });
  }
  rows.sort((a, b) => (b.approved - a.approved) || ((b.ppd === null ? -Infinity : b.ppd) - (a.ppd === null ? -Infinity : a.ppd)) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { ok: true, problem: null, rows: rows.slice(0, MAX_ROWS), left: Math.max(0, rows.length - MAX_ROWS) + (isNum(rosterAns.left) ? rosterAns.left : 0), zoneSplit: L.ZONE_SPLIT_ON ? 'on' : 'off', zoneWords: L.ZONES_OFF };
}

/* ---------------------------------------------------------------- running now and today, live only (from ChartBridge, by FleetView) */
/** The traders running now: in Auto or Copilot (never a Shadow one, never one that is off, killed or stood down). rows: FleetCore.traders. */
function runningNow(traders, heard) {
  if (heard === false) return { running: [], total: 0, shadow: 0, cannotTell: 'ChartBridge has not sent the traders yet (it is signing in, or signed out), so this page cannot tell what is running.' };
  const list = Array.isArray(traders) ? traders.filter(isObj) : [];
  const running = list.filter(t => (t.mode === 'auto' || t.mode === 'copilot') && t.tone !== 'off' && t.tone !== 'killed' && t.tone !== 'standDown');
  return { running: running.map(t => ({ id: str(t.id), name: str(t.name), build: str(t.build), mode: str(t.modeText), accounts: str(t.accountText), status: str(t.status), tone: str(t.tone), today: isNum(t.pnlToday) ? t.pnlToday : null, trades: isNum(t.trades) ? t.trades : null, auto: t.mode === 'auto' })),
    total: list.length, shadow: list.filter(t => t.mode === 'shadow').length, cannotTell: list.some(t => t.cannotTell) ? 'A trader in Auto whose accounts this page cannot read: what is running cannot be told in full.' : '' };
}
/** Today, live only: the day's result of the prop accounts ChartBridge lists now. rows: FleetCore.propAccounts. Nothing simulated. */
function todayLive(accounts) {
  const list = Array.isArray(accounts) ? accounts.filter(isObj) : [];
  const known = list.filter(a => isNum(a.today));
  const sum = known.reduce((s, a) => s + a.today, 0);
  return { accounts: list.length, known: known.length, sum: known.length ? Math.round(sum * 100) / 100 : null,
    rows: list.map(a => ({ name: str(a.name), stage: str(a.stageText), today: isNum(a.today) ? a.today : null, room: isNum(a.cushion) ? a.cushion : null, position: str(a.position), done: !!a.done })) };
}

/* ---------------------------------------------------------------- last night (the board's nights) */
function lastNight(boardAns) {
  const b = L.boardOf(boardAns);
  if (!b.ok) return { ok: false, problem: b.problem, night: null };
  const nights = Array.isArray(b.board.nights) ? b.board.nights.filter(isObj) : [];
  if (!nights.length) return { ok: true, problem: null, night: null, words: 'No screen night yet.' };
  const n = nights[nights.length - 1];
  return { ok: true, problem: null, words: '', night: { night: str(n.night, 20), asked: isNum(n.asked) ? n.asked : null, made: isNum(n.made) ? n.made : null, fresh: isNum(n.new) ? n.new : null,
    neighbours: isNum(n.neighbours) ? n.neighbours : null, skipped: isNum(n.skipped_as_already_tried) ? n.skipped_as_already_tried : null },
    builds: isObj(b.board.line) && isObj(b.board.line.counts) && isNum(b.board.line.counts.in_the_line) ? b.board.line.counts.in_the_line : null };
}

/* ---------------------------------------------------------------- Centurion's week, its veto and its undo (the contract v1, 2026-11-19) */
/*
 * The Desk serves the week (GET /api/legion/centurion, veto: { built: true, version: 1 }): the week's Saturday report, its veto window as The
 * Desk counts it in New York time, each change with its veto and its outcome, and the applied log's newest lines with each one's undo. This
 * page never decides the window: it shows The Desk's state, offers Veto only while The Desk says "open" and Undo only on an applied change
 * whose undo state is "none", and The Desk refuses whatever is late. Any other veto answer (an older Desk, built false, another version):
 * read only. Both actions ask first (ARM_MS and CONFIRM_MS, as Legion's Stop all question) and send one POST of exactly { run_id, name }.
 */
const VETO_VERSION = 1;
const ARM_MS = 600;               // the question takes no answer for this long after it opens (LegionCore.ARM_MS; a test holds them equal)
const CONFIRM_MS = 8000;          // and is gone after this long, by the clock (LegionCore.CONFIRM_MS)
const RUN_ID_RE = /^centurion_\d{8}T\d{6}Z$/;
const NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const WINDOW_STATES = Object.freeze(['open', 'closed', 'sealed', 'missed', 'reports only', 'not a Saturday report']);
const NOTHING_GOES_IN = Object.freeze(['missed', 'reports only', 'not a Saturday report', 'unknown']);   // nothing of the report is applied (or this page cannot tell)
const WINDOW_TIMED = Object.freeze(['open', 'closed', 'sealed']);                                        // the states the window's closing time is said for
const OUTCOME_WORDS = Object.freeze({ applied: 'Applied', vetoed: 'Vetoed', refused: 'Refused', 'not applied': 'Not applied' });
const UNDO_STATES = Object.freeze(['none', 'asked', 'done', 'refused']);
const IN_SAMPLE = 'In-sample: nothing here is proven, and no change here trades.';
const VETO_UNKNOWN = 'The Desk\'s veto is not one this page knows: read only.';
const VETO_UNREACHABLE = 'The Desk did not answer, so no veto or undo can be sent now. If Sunday night\'s run cannot read the veto list, it applies nothing that week.';
const NO_WEEK = 'No Saturday report yet: nothing to veto.';
const NO_CHANGE = 'No change proposed this week.';
const NO_APPLIED = 'No change applied yet.';
const ALLOW_REFUSED = 'Refused by the allow-list: never applied';
const VETO_Q = 'Veto this change? It will not go in at Sunday night\'s run. A veto cannot be taken back.';
const undoQuestion = (name, from) => 'Undo this change? ' + name + ' goes back to ' + from + ' at the start of the next night\'s run.';
const ANSWER_ID_RE = Object.freeze({ veto: /^v_[0-9a-f]{16}$/, undo: /^u_[0-9a-f]{16}$/ });
const noAnswer = kind => 'The Desk did not answer: the ' + (kind === 'undo' ? 'undo' : 'veto') + ' may or may not be recorded. Reading again.';

/** A UTC stamp (YYYY-MM-DDTHH:MM:SSZ) in New York time, by the browser's own zone data: "Mon, Jan 8, 2001, 00:00 EST". '' when it is not one. */
const NY_FMT = (() => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }); } catch (e) { return null; } })();
function nyTime(utc) {
  if (!NY_FMT || !UTC_RE.test(str(utc))) return '';
  const d = new Date(utc);
  return isFinite(d.getTime()) ? NY_FMT.format(d) : '';
}
const valueText = x => (isNum(x) || typeof x === 'string' ? String(x).slice(0, 40) : '-');

/** The week The Desk serves: { runId, madeUtc, saturday, state, words, closes, sealed, changes: [{ name, from, to, why, allowed, veto, outcome, then, can }] }, or null. */
function weekOf(w) {
  if (!isObj(w)) return null;
  const runId = str(w.run_id, 40), runOk = RUN_ID_RE.test(runId);
  const win = isObj(w.window) ? w.window : {};
  const state = WINDOW_STATES.includes(win.state) ? win.state : 'unknown';
  const changes = (Array.isArray(w.changes) ? w.changes : []).filter(isObj).slice(0, 20).map(c => {
    const name = str(c.name, 64), nameOk = NAME_RE.test(name) && str(c.name).length <= 64;
    const veto = isObj(c.veto) ? { id: str(c.veto.id, 18), at: nyTime(c.veto.at_utc) } : null;
    const outcome = typeof c.outcome === 'string' && c.outcome ? c.outcome.slice(0, 40) : null;
    const outWord = outcome ? (OUTCOME_WORDS[outcome] || outcome) : '', outWhy = str(c.outcome_why, 300);
    let then = '', can = false;
    if (c.allowed !== true) then = ALLOW_REFUSED;
    else if (veto) then = 'Vetoed' + (outcome && outcome !== 'vetoed' ? ' (the applied log says: ' + outWord + (outWhy ? ', ' + outWhy : '') + ')' : '');
    else if (outcome) then = outWord + (outWhy ? ': ' + outWhy : '');
    else if (state === 'open' && runOk && nameOk) can = true;
    else then = NOTHING_GOES_IN.includes(state) ? '-' : 'Not vetoed';   // the R12 review, N1: "Not vetoed" would read as "it goes in"
    return { name, from: valueText(c.from), to: valueText(c.to), why: str(c.why, 400), allowed: c.allowed === true, veto, outcome, then, can };
  });
  return { runId, runOk, madeUtc: str(w.made_utc, 20), saturday: str(w.saturday, 10), applies: w.applies === true, state, words: str(win.words, 400),
    timed: WINDOW_TIMED.includes(state), closes: nyTime(win.closes_utc), sealed: nyTime(win.sealed_utc), changes };
}

/** The applied log's newest lines: { ok, problem, rows: [{ runId, name, from, to, when, state, then, can }], more }. */
function appliedOf(a) {
  if (!isObj(a)) return { ok: false, problem: 'The applied log\'s answer is not one this page knows: nothing from it is shown, and no undo can be asked now.', rows: [], more: 0 };
  if (a.ok !== true) return { ok: false, problem: str(a.problem, 400) || 'The applied log does not read: nothing from it is shown, and no undo can be asked now.', rows: [], more: 0 };
  const rows = (Array.isArray(a.rows) ? a.rows : []).filter(isObj).slice(0, 20).map(r => {
    const runId = str(r.run_id, 40), name = str(r.name, 64), u = isObj(r.undo) ? r.undo : {};
    const state = UNDO_STATES.includes(u.state) ? u.state : 'unknown';
    const keyOk = RUN_ID_RE.test(runId) && NAME_RE.test(name) && str(r.name).length <= 64;
    let then = '', can = false;
    if (state === 'none') { if (keyOk) can = true; else then = 'Not undone'; }
    else if (state === 'asked') then = 'Undo asked: done at the start of the next night\'s run';
    else if (state === 'done') then = 'Undone';
    else if (state === 'refused') then = 'Undo refused: ' + (str(u.why, 300) || 'no reason given');
    else then = 'Undo: could not tell';
    return { runId, name, from: valueText(r.from), to: valueText(r.to), when: nyTime(r.applied_utc) || 'not stated', state, then, can };
  });
  return { ok: true, problem: null, rows, more: isNum(a.more) && a.more > 0 ? Math.floor(a.more) : 0 };
}

/**
 * Centurion's answer as card VII shows it. acts: The Desk's veto is the one this page knows (built true, version 1); with any other
 * answer the card is read only (VETO_UNKNOWN) and shows the report as before. week and applied: The Desk's (only when acts).
 */
function centurionView(ans) {
  if (!isObj(ans)) return { ok: false, problem: 'Centurion\'s answer is not one this page knows.', acts: false, week: null, applied: null };
  const v = isObj(ans.veto) ? ans.veto : {};
  const acts = v.built === true && v.version === VETO_VERSION;
  const extra = { acts, vetoBuilt: v.built === true, vetoWords: str(v.note, 300), week: acts ? weekOf(ans.week) : null, applied: acts ? appliedOf(ans.applied) : null };
  if (!ans.ok || !isObj(ans.report)) return Object.assign({ ok: false, problem: str(ans.problem) || 'Centurion has not reported yet.' }, extra);
  const r = ans.report;
  const changes = isObj(r.proposal) && Array.isArray(r.proposal.changes) ? r.proposal.changes.filter(isObj).slice(0, 20).map(c => ({ name: str(c.name, 60),
    from: valueText(c.from), to: valueText(c.to), allowed: c.allowed === true })) : [];
  return Object.assign({ ok: true, problem: null, runId: str(r.run_id, 60), status: str(r.status, 40), applies: r.applies === true, summary: str(r.summary, 600),
    findings: Array.isArray(r.findings) ? r.findings.filter(x => typeof x === 'string').slice(0, 20).map(x => x.slice(0, 400)) : [], changes }, extra);
}

/**
 * The question's state at a click on Yes, as Legion's Stop all (LegionCore.stopClick): 'yes' (send), 'early' (inside ARM_MS: nothing,
 * the question stays), 'late' (past CONFIRM_MS: it closes, nothing sent), 'key' (Yes by the keyboard: refused), 'none' (no question open).
 */
function askClick(askedAt, now, real) {
  if (!askedAt) return 'none';
  const age = now - askedAt;
  if (age > CONFIRM_MS) return 'late';
  if (!real) return 'key';
  if (age < ARM_MS) return 'early';
  return 'yes';
}

/**
 * What the page may send for one click, from the last answer it holds: { route, body } (exactly { run_id, name }), or { why } when
 * nothing may be sent. view: centurionView; fresh: the read is held and its last refresh did not fail. kind 'veto' or 'undo'.
 */
function actionFor(view, fresh, kind, runId, name) {
  if (!fresh) return { why: VETO_UNREACHABLE };
  if (!view || !view.acts) return { why: VETO_UNKNOWN };
  if (kind === 'veto') {
    const w = view.week;
    const c = w && w.runId === runId ? w.changes.find(x => x.name === name) : null;
    if (!c || !c.can) return { why: 'This change has no Veto now (The Desk\'s last answer does not offer one): nothing was sent.' };
    return { route: ROUTES.centurionVeto, body: { run_id: runId, name } };
  }
  if (kind === 'undo') {
    const a = view.applied;
    const r = a && a.ok ? a.rows.find(x => x.runId === runId && x.name === name) : null;
    if (!r || !r.can) return { why: 'This change has no Undo now (The Desk\'s last answer does not offer one): nothing was sent.' };
    return { route: ROUTES.centurionUndo, body: { run_id: runId, name } };
  }
  return { why: 'Nothing was sent.' };
}

/**
 * Is this 200 The Desk's answer to the POST that was sent (sent: exactly { run_id, name })? Only an object whose id is a veto's
 * (v_ and 16 hex) or an undo's (u_ and 16 hex), whose run_id and name are the ones sent, and whose words are a non-empty string
 * (the R12 review, B1). Anything else ({}, null, a string, another change's answer) is no answer: the change may or may not be
 * recorded, and the page never calls it done.
 */
function sentOk(kind, ans, sent) {
  const re = ANSWER_ID_RE[kind];
  return !!re && isObj(ans) && isObj(sent) && typeof ans.id === 'string' && re.test(ans.id) && typeof ans.run_id === 'string' && ans.run_id === sent.run_id
    && typeof ans.name === 'string' && ans.name === sent.name && typeof ans.words === 'string' && ans.words.trim().length > 0;
}
/** The line after a 200: The Desk's words when sentOk, else the no-answer words (said as bad). */
function sentWords(kind, ans, sent) { return sentOk(kind, ans, sent) ? ans.words.slice(0, 300) : noAnswer(kind); }
/**
 * The line after a failure. e: { status, body, words } from deskClient (status null: no answer). A refusal is "Refused: " and The
 * Desk's detail as it is; a 5xx with no detail is no answer (may or may not be recorded), never a refusal (the R12 review, B1).
 */
function refusedWords(kind, e) {
  if (!e || typeof e.status !== 'number') return noAnswer(kind);
  const detail = e.body && typeof e.body.detail === 'string' ? e.body.detail.slice(0, 400) : '';
  if (!detail && e.status >= 500) return noAnswer(kind);
  return 'Refused: ' + (detail || str(e.words, 300) || 'The Desk answered ' + e.status + ' and gave no reason.');
}

/* ---------------------------------------------------------------- the cohorts (The Desk's model + what ChartBridge says live) */
const fleetIndex = rows => { const m = new Map(); for (const r of Array.isArray(rows) ? rows : []) if (isObj(r) && typeof r.name === 'string') m.set(lc(r.name), r); return m; };
const flat = p => p === 'Flat';
/** One account chip: the ledger's facts from The Desk and the live ones from ChartBridge (room to the floor, today, position). */
function chipOf(a, idx) {
  const live = idx.get(lc(a.account)) || null;
  return { account: str(a.account, 64), firm: str(a.firm, 40), stage: str(a.stage, 10), type: isObj(a.type) ? str(a.type.name, 40) : '', problem: str(a.problem, 200),
    listed: !!live, room: live && isNum(live.cushion) ? live.cushion : null, roomWhy: live ? str(live.cushionWhy, 200) : '', today: live && isNum(live.today) ? live.today : null,
    position: live ? str(live.position, 60) : '', connection: live ? str(live.connection, 20) : '' };
}
/** A cohort's pick in words: "Alpha v1 (alpha_v1.json)", or why it is not good. */
function pickWords(p) {
  if (!isObj(p)) return { text: 'No pick yet', state: 'none', bad: false };
  const name = str(p.display_name, 40) || str(p.bot, 60) || str(p.file, 60);
  const st = str(p.state, 20);
  if (st === 'ok') return { text: name + ' (' + str(p.file, 60) + ')', state: 'ok', bad: false };
  const why = { changed: 'its roster file changed since it was picked: pick again', missing: 'its roster file is not served now', not_served: 'its roster file is not served now' }[st] || 'its state is not known';
  return { text: name + ' (' + str(p.file, 60) + '): ' + (str(p.why, 200) || why), state: st || 'unknown', bad: true };
}
/**
 * The model for the Cohorts page. ans: GET /api/legion/cohorts. accounts: FleetCore.propAccounts rows. traders: FleetCore.traders rows.
 * -> { ok, problem, version, cohorts: [{ id, name, stage, firm, pc, pick, chips, problems, auto, openPositions }], tray, firms, problems }
 * auto: a trader in Auto holds one of the cohort's accounts (what only this PC knows); openPositions: its accounts that hold a position.
 */
function cohortsView(ans, accounts, traders, heard) {
  if (!isObj(ans) || !Array.isArray(ans.cohorts) || !isNum(ans.version)) return { ok: false, problem: 'The cohorts\' answer is not one this page knows.', cohorts: [], tray: [], firms: [], problems: [] };
  const idx = fleetIndex(accounts);
  const autos = (Array.isArray(traders) ? traders : []).filter(t => isObj(t) && t.mode === 'auto' && t.tone !== 'off' && t.tone !== 'killed' && t.tone !== 'standDown');
  const cannotTell = (Array.isArray(traders) ? traders : []).some(t => isObj(t) && t.cannotTell);
  const inAuto = name => autos.some(t => Array.isArray(t.accounts) && t.accounts.some(n => lc(n) === lc(name)));
  const cohorts = ans.cohorts.filter(isObj).slice(0, 100).map(c => {
    const chips = (Array.isArray(c.accounts) ? c.accounts : []).filter(isObj).slice(0, 100).map(a => Object.assign(chipOf(a, idx), { inAuto: inAuto(a.account) }));
    return { id: str(c.id, 40), name: str(c.name, 40), stage: str(c.stage, 10), firm: str(c.firm, 40), firms: Array.isArray(c.firms) ? c.firms.filter(x => typeof x === 'string') : [], pc: str(c.pc, 64),
      pick: pickWords(c.pick), chips, problems: Array.isArray(c.problems) ? c.problems.filter(x => typeof x === 'string').slice(0, 10) : [],
      auto: chips.some(k => k.inAuto), openPositions: chips.filter(k => k.listed && !flat(k.position) && k.position !== 'Not connected').map(k => k.account) };
  });
  const inCohort = new Set(cohorts.flatMap(c => c.chips.map(k => lc(k.account))));
  const tray = (Array.isArray(ans.prop_accounts) ? ans.prop_accounts : []).filter(a => isObj(a) && !a.cohort && !inCohort.has(lc(a.account))).slice(0, 100)
    .map(a => Object.assign(chipOf({ account: a.account, firm: a.firm, stage: a.stage, type: null, problem: null }, idx), { inAuto: inAuto(a.account) }));
  return { ok: true, problem: null, version: ans.version, heard: heard === true, cannotTell, cohorts, tray,
    firms: (Array.isArray(ans.firms) ? ans.firms : []).filter(isObj).map(f => ({ firm: str(f.firm, 40), pc: str(f.pc, 64), cohorts: Array.isArray(f.cohorts) ? f.cohorts.length : 0 })),
    problems: Array.isArray(ans.problems) ? ans.problems.filter(x => typeof x === 'string').slice(0, 10) : [], note: str(ans.note, 400) };
}
/** The firm's direction today: The Desk does not give it yet (the direction check is step 3.5), so it says so. */
const directionWords = () => 'Direction today: ' + NOT_BUILT + ' (the one-direction check is step 3.5; The Desk gives no direction yet).';

/**
 * Whether a drag of an account to a cohort (or to nobody: toId null) is refused HERE, in plain words, before The Desk is asked:
 * the account holds a position, a trader is in Auto on it or on the cohort it leaves or enters, or ChartBridge does not list it
 * (this page then cannot tell). '' when this page has no objection; The Desk's own refusals (stage, firm, type) come back from it.
 */
function dropRefusal(view, account, toId) {
  if (!view || !view.ok) return 'The cohorts are not read yet.';
  const all = view.cohorts;
  const from = all.find(c => c.chips.some(k => lc(k.account) === lc(account))) || null;
  const chip = from ? from.chips.find(k => lc(k.account) === lc(account)) : view.tray.find(k => lc(k.account) === lc(account));
  if (!chip) return account + ' is not one of the prop accounts The Desk lists.';
  const to = toId === null ? null : all.find(c => c.id === toId) || null;
  if (toId !== null && !to) return 'That cohort is not there any more: the page reads the cohorts again.';
  if ((from ? from.id : null) === (to ? to.id : null)) return '';
  if (!view.heard) return 'This page cannot tell whether a cohort is in Auto: ChartBridge has not sent the traders yet (it is signing in, or signed out). Nothing is moved.';
  if (view.cannotTell) return 'This page cannot tell whether a cohort is in Auto: a trader in Auto has accounts it cannot read. Nothing is moved.';
  if (!chip.listed) return account + ' is not listed by ChartBridge now, so this page cannot tell whether it holds a position: nothing is moved.';
  if (chip.position !== 'Flat') return account + (chip.position === 'Not connected' ? ' is not connected, so this page cannot tell whether it holds a position' : ' holds a position (' + chip.position + ')') + ': nothing is moved while it does. Close the position first.';
  if (chip.inAuto) return account + ' has a trader in Auto on it: nothing is moved. Turn the trader off first.';
  const busy = [from, to].filter(c => c && c.auto)[0];
  if (busy) return busy.name + ' is in Auto (a trader is running on its accounts): nothing is moved into or out of it. Turn the trader off first.';
  return '';
}
/** What The Desk refused (or that it did not answer), in plain words. e: { words, status, body } from deskClient. */
function moveWords(e, account) {
  const detail = e && e.body && typeof e.body.detail === 'string' ? e.body.detail.slice(0, 300) : '';
  if (e && e.status === 409) return 'Another change came first, so nothing was moved: the cohorts are read again, then drag again.';
  if (e && e.status === 404) return 'The Desk says ' + (detail || 'there is no such cohort') + '. The cohorts are read again.';
  if (e && e.status === 400) return 'The Desk refused it: ' + (detail || 'it gave no reason') + '.';
  if (e && e.status === null) return 'The Desk did not answer, so this page cannot tell whether ' + (account || 'the account') + ' moved: the cohorts are read again.';
  return e && e.words ? e.words + ' Nothing was moved.' : 'Nothing was moved.';
}

/* ---------------------------------------------------------------- one read's state, as the views and Needs you take it */
/**
 * r: { state: 'idle' | 'loading' | 'ok' | 'fail', ans }. A read keeps its LAST answer while it is refreshed and when a refresh fails
 * (stale), so a refresh never blanks the page or reads as all clear. -> 'ok' (an answer is held), 'fail' (it failed and nothing is held)
 * or 'pending' (nothing yet, and not failed): a pending or failed read is never "nothing needs you". stale: a held answer whose last refresh failed.
 */
function readStatus(r) {
  const has = !!r && r.ans !== null && r.ans !== undefined;
  return { state: has ? 'ok' : r && r.state === 'fail' ? 'fail' : 'pending', stale: has && r.state === 'fail' };
}

/* ---------------------------------------------------------------- Needs you: the one place a decision waits */
/**
 * Everything that waits for a decision, in one list: [{ kind, words, where }], worst first. money: moneyView, cohorts: cohortsView,
 * traders: FleetCore.traders, reads: { name: readStatus(...).state } for the reads Castra depends on: any that is not 'ok' (failed or still pending) is named under cannotTell, never read as all clear.
 */
function needsYou(o) {
  const out = [];
  const m = o && o.money && o.money.ok ? o.money : null;
  if (m) for (const b of m.builds) if (b.alarm.state === 'tripped') out.push({ kind: 'money alarm', words: b.bot + ': ' + b.alarm.words, where: 'castra' });
  const c = o && o.cohorts && o.cohorts.ok ? o.cohorts : null;
  if (c) {
    for (const x of c.cohorts) {
      if (x.pick.bad) out.push({ kind: 'pick', words: x.name + ': ' + x.pick.text, where: 'cohorts' });
      for (const p of x.problems) out.push({ kind: 'cohort', words: x.name + ': ' + p, where: 'cohorts' });
      for (const k of x.chips) if (k.problem) out.push({ kind: 'account', words: k.account + ' (' + x.name + '): ' + k.problem, where: 'cohorts' });
    }
    for (const p of c.problems) out.push({ kind: 'cohort', words: p, where: 'cohorts' });
    if (c.tray.length) out.push({ kind: 'accounts', words: plural(c.tray.length, 'prop account') + ' in no cohort (' + c.tray.slice(0, 5).map(k => k.account).join(', ') + (c.tray.length > 5 ? ', ...' : '') + '): no bot trades them.', where: 'cohorts' });
  }
  for (const t of Array.isArray(o && o.traders) ? o.traders : []) {
    if (!isObj(t) || (t.kind !== 'prop' && t.kind !== 'propsim' && t.kind !== 'unlisted' && t.kind !== 'mixed')) continue;
    if (t.tone === 'killed' || t.tone === 'standDown' || (t.tone === 'lost' && t.mode === 'auto')) out.push({ kind: 'trader', words: str(t.name) + ': ' + str(t.status), where: 'cohorts' });
  }
  const names = Object.keys(o && o.reads ? o.reads : {});
  const failed = names.filter(k => o.reads[k] === 'fail'), pending = names.filter(k => o.reads[k] !== 'ok' && o.reads[k] !== 'fail');
  return { items: out, cannotTell: names.filter(k => o.reads[k] !== 'ok'), failed, pending };
}

return Object.freeze({ ROUTES, FLEET_PATH, RN, NOT_BUILT, NOT_ENOUGH, SIM_LABEL, deskClient, esc, table, cell, raw, card, note, tone, plural,
  simStage, alarmOf, ALARM_NOT_KNOWN, readStatus, realCells, cardAccountWords, cardAccountLog, moneyView, goesInView, runningNow, todayLive, lastNight, centurionView, fleetIndex,
  VETO_VERSION, ARM_MS, CONFIRM_MS, RUN_ID_RE, NAME_RE, IN_SAMPLE, VETO_UNKNOWN, VETO_UNREACHABLE, NO_WEEK, NO_CHANGE, NO_APPLIED, ALLOW_REFUSED, VETO_Q,
  undoQuestion, nyTime, weekOf, appliedOf, askClick, actionFor, sentOk, sentWords, refusedWords, chipOf, pickWords, cohortsView, directionWords, dropRefusal, moveWords, needsYou });
});
