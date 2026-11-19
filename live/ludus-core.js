/*
 * LudusCore (plan step 3.4): the pure part of Legion's Ludus tab and the build page. No DOM: Node tests require it
 * (test/ludus.test.js); a plain <script> sets window.LudusCore. live/ludus.js draws it.
 *
 * WHAT IT READS (The Desk, read only; nothing here writes, sends or places anything):
 *   the board     GET /api/lab/loop/board (thedesk/loop_board.py; Bot-Lab teststudio/loop/board.py writes it): the stations,
 *                 the line of 30, every build (candidate) with its runs, the library and the Builder's requests. The Desk's
 *                 own Lab screen reads it there today. The Desk gives Legion's origin no CORS on it yet: the page says so
 *                 plainly and the Board falls back to the ledger.
 *   the ledger    GET /api/legion/ledger (moved to Legion for Ludus's Board, plan step 3.1): every run, flat, each with its
 *                 candidate. With no board, the builds and the build page are made from it.
 *   the roster    GET /api/legion/roster: the roster files Anthony approved or that were placed, each with its playbook.
 *   the trades    GET /api/legion/build/{candidate}/trades?show=&page=: discovery days only, 20 a page (a placeholder
 *                 shape, loop.build_trades/0, until Bot-Lab's side writes the file).
 *   the bars      GET /api/bars?root=&session=: The Desk's stored 1-minute bars of one session, for the one trade on the
 *                 chart (an hour before the entry to half an hour after the exit).
 *   the Lab       GET /api/lab: the seeds (Seeds); the PC helper's GET /status: this PC's agent builds (Agents).
 * Every route is in ROUTES, the one table.
 *
 * ROI FIRST (Rule 1, law 1.6): every build leads with profit per $1, then the pass rate, the days to pass and the payout per
 * funded account, each beside its sample (trades, days with a trade, sessions). A figure the Prop Sim did not make (under the
 * verdict's minimums) reads NOT_ENOUGH. Every number here is simulated by the Prop Sim on in-sample days (SIMULATED): none is
 * proven and none is real money (real money per roster build is Castra's, from The Desk's prop ledger).
 *
 * THE BEST TRY (the board's own rule, teststudio/loop/board.py build): among a build's runs of kind 'try' whose figure was
 * made by law 6.7's no-edge line (prop.no_edge_line 'resampled'), the highest profit per $1; an older re-ordered figure is
 * never the best try. Builds rank by it, best first, a build with none last, then by id (the board's order).
 *
 * THE SPLIT BY ZONE AND REGIME stays off until a zone version passes test 3 on later days (law 1.6, item 114; plan step 3.3
 * and 2.4). The Desk names no passed version today, so ZONE_SPLIT_ON is false and no zone figure is shown anywhere.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LudusCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const SUBS = Object.freeze(['pipeline', 'board', 'builder', 'seeds', 'agents']);
const SUB_NAMES = Object.freeze({ pipeline: 'Pipeline', board: 'Board', builder: 'Builder', seeds: 'Seeds', agents: 'Agents' });
const SHOWS = Object.freeze(['all', 'winners', 'losers', 'worth_a_look']);
const SHOW_NAMES = Object.freeze({ all: 'All', winners: 'Winners', losers: 'Losers', worth_a_look: 'Worth a look' });
const CANDIDATE = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROOTS = ['MNQ', 'NQ', 'MES', 'ES'];
const PER_PAGE = 20;              // the build page's trades (The Desk serves 20 a page)
const BUILDS_PER_PAGE = 25;       // the Board's list of every build
const BEFORE_MS = 3600000;        // the chart: about an hour before the entry
const AFTER_MS = 1800000;         // and half an hour after the exit
const NEW_LINE = 'resampled';     // law 6.7's no-edge line (propsim.NO_EDGE_LINE)
const ZONE_SPLIT_ON = false;      // law 1.6, item 114: off until a zone version passes test 3 (the module docstring)

const NOT_ENOUGH = 'not enough data yet';
const NOT_GIVEN = 'not given yet';
const SIMULATED = 'Simulated by the Prop Sim on in-sample days: nothing here is proven, and none of it is real money.';
const ZONES_OFF = 'Off until a zone version passes test 3 on later days: per zone almost no build has enough trades yet to say anything.';
const SLOT_30 = 'Dollars per funded slot per 30 sessions: ' + NOT_GIVEN + ' (the playbook search for every build in the line adds it).';
const NOT_NAMED = 'Its own account type is named by the playbook search on its tuned days; that search has not run for this build yet, so the screen\'s account is shown.';
const DEFAULT_SETTING = 'the default setting: the 50K account with the daily loss limit, at its list price, with the default playbooks';
const PLACED = 'in-sample, not proven, not approved';

const ROUTES = Object.freeze({
  board: '/api/lab/loop/board',
  ledger: '/api/legion/ledger',
  roster: '/api/legion/roster',
  lab: '/api/lab',
  trades: (cid, show, page) => '/api/legion/build/' + cid + '/trades?show=' + encodeURIComponent(show) + '&page=' + page,
  bars: (root, session) => '/api/bars?root=' + encodeURIComponent(root) + '&session=' + encodeURIComponent(session),
});

const isNum = x => typeof x === 'number' && isFinite(x);
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const str = x => (typeof x === 'string' ? x : '');
const plural = (n, one, many) => n.toLocaleString('en-US') + ' ' + (n === 1 ? one : (many || one + 's'));

/* ---------------------------------------------------------------- words for numbers */
function signed(x, dp) { const d = dp === undefined ? 2 : dp; return (x >= 0 ? '+' : '-') + Math.abs(x).toFixed(d); }
/** "+0.82 per $1", or null with no figure */
const perDollar = x => (isNum(x) ? signed(x) + ' per $1' : null);
/** a share 0..1 as "62%" */
const pct = x => (isNum(x) ? Math.round(x * 100) + '%' : null);
/** whole dollars "$1,240" (negative "-$40") */
const usd = x => (isNum(x) ? (x < 0 ? '-' : '') + '$' + Math.round(Math.abs(x)).toLocaleString('en-US') : null);
/** a median count of sessions, "14 sessions" */
const sessionsText = x => (isNum(x) ? (Math.round(x * 10) / 10).toLocaleString('en-US') + ' sessions' : null);

/** "143 trades on 88 days, of 120 sessions": the sample every figure shows beside it */
function sampleText(s) {
  if (!isObj(s) || !isNum(s.trades)) return 'no sample';
  const d = isNum(s.days_with_a_trade) ? s.days_with_a_trade : isNum(s.days_with_trades) ? s.days_with_trades : null;
  let t = plural(s.trades, 'trade');
  if (d !== null) t += ' on ' + plural(d, 'day');
  if (isNum(s.sessions)) t += ', of ' + plural(s.sessions, 'session');
  return t;
}

/* ---------------------------------------------------------------- the address (Ludus's own part of it) */
/** The Ludus part of an address: { sub, build, show, page, trade }. Unknown or none: the Pipeline, no build. */
function routeFrom(search) {
  let q;
  try { q = new URLSearchParams(typeof search === 'string' ? search : ''); } catch (e) { q = new URLSearchParams(''); }
  const sub = String(q.get('ludus') || '').toLowerCase();
  const build = String(q.get('build') || '').toLowerCase();
  const show = String(q.get('show') || '').toLowerCase();
  const page = +q.get('page'), trade = +q.get('trade');
  return { sub: SUBS.includes(sub) ? sub : 'pipeline', build: CANDIDATE.test(build) ? build : '',
    show: SHOWS.includes(show) ? show : 'all', page: Number.isInteger(page) && page >= 1 && page <= 100000 ? page : 1,
    trade: Number.isInteger(trade) && trade >= 1 ? trade : 0 };
}
/** The address for a Ludus view: the page's own query with the Ludus keys set (and the build page's only with a build). */
function routeSearch(search, r) {
  let q;
  try { q = new URLSearchParams(typeof search === 'string' ? search : ''); } catch (e) { q = new URLSearchParams(''); }
  q.set('tab', 'ludus');
  q.set('ludus', SUBS.includes(r.sub) ? r.sub : 'pipeline');
  for (const k of ['build', 'show', 'page', 'trade']) q.delete(k);
  if (r.build && CANDIDATE.test(r.build)) {
    q.set('build', r.build);
    if (r.show && r.show !== 'all' && SHOWS.includes(r.show)) q.set('show', r.show);
    if (Number.isInteger(r.page) && r.page > 1) q.set('page', String(r.page));
    if (Number.isInteger(r.trade) && r.trade >= 1) q.set('trade', String(r.trade));
  }
  return '?' + q.toString();
}

/* ---------------------------------------------------------------- answers */
/** What failed, in words naming the route (a fetch that threw: The Desk off, or no CORS for this page yet). */
function failWords(route, status) {
  if (status === 403) return 'The Desk refused this page\'s read (' + route + '): it answers this PC and THEDESK_FILLS_FROM only.';
  if (isNum(status)) return 'The Desk answered ' + status + ' to ' + route + '.';
  return 'The Desk did not answer ' + route + ' (it is off, or it does not let this page read it yet).';
}
/** The board's answer: { ok, problem, board }. A board not in the shape is never shown in part. */
function boardOf(ans) {
  if (!isObj(ans)) return { ok: false, problem: 'The board\'s answer is not one this page knows.', board: null };
  if (!ans.ok || !isObj(ans.board)) return { ok: false, problem: str(ans.problem) || 'The board is not there yet.', board: null };
  const b = ans.board;
  if (b.schema !== 'loop.board/1' || !isObj(b.candidates) || !isObj(b.stations)) return { ok: false, problem: 'The board is not one this page knows (another schema): nothing from it is shown.', board: null };
  return { ok: true, problem: null, board: b };
}
/** Every run, each with its candidate: from the board's candidates when it reads, else the ledger's answer. */
function runsOf(board, ledgerAns) {
  const out = [];
  if (board) {
    for (const [cid, c] of Object.entries(board.candidates)) for (const r of (isObj(c) && Array.isArray(c.runs) ? c.runs : [])) if (isObj(r)) out.push(Object.assign({}, r, { candidate: cid }));
    return { runs: out, from: 'board', problem: null };
  }
  if (!isObj(ledgerAns)) return { runs: out, from: '', problem: 'The ledger\'s answer is not one this page knows.' };
  if (!ledgerAns.ok) return { runs: out, from: '', problem: str(ledgerAns.problem) || 'The loop\'s ledger is not there yet.' };
  for (const r of Array.isArray(ledgerAns.runs) ? ledgerAns.runs : []) if (isObj(r) && CANDIDATE.test(str(r.candidate))) out.push(r);
  return { runs: out, from: 'ledger', problem: null };
}

/* ---------------------------------------------------------------- one run's money (ROI first) */
const judged = p => isObj(p) && p.no_edge_line === NEW_LINE;
const figure = r => (isObj(r) && r.kind === 'try' && isObj(r.prop) && isNum(r.prop.profit_per_dollar) ? r.prop.profit_per_dollar : null);

/** One run's prop score as the page shows it: { ppd, pass, toPass, paid, sharePaid, toPayout, noEdge95, above, older,
 *  enough, verdict, sample, account }. enough false: the Prop Sim made no figure (NOT_ENOUGH on every number). */
function roiOf(run) {
  const p = isObj(run) && isObj(run.prop) ? run.prop : {};
  const ev = isObj(p.eval) ? p.eval : {}, fu = isObj(p.funded) ? p.funded : {};
  const enough = isNum(p.profit_per_dollar);
  return { enough, ppd: enough ? p.profit_per_dollar : null, verdict: str(p.verdict),
    pass: isNum(ev.pass_share) ? ev.pass_share : null, toPass: isNum(ev.sessions_to_pass) ? ev.sessions_to_pass : null,
    paid: isNum(fu.paid_per_funded) ? fu.paid_per_funded : null, sharePaid: isNum(fu.share_paid) ? fu.share_paid : null,
    toPayout: isNum(fu.sessions_to_first_payout) ? fu.sessions_to_first_payout : null,
    noEdge95: isObj(p.no_edge) && isNum(p.no_edge.p95) ? p.no_edge.p95 : null, above: p.above_no_edge === true && judged(p),
    older: enough && !judged(p), meanR: isNum(p.mean_r) ? p.mean_r : null,
    sample: isObj(p.sample) ? p.sample : (isNum(run && run.trades) ? { trades: run.trades } : null),
    account: isObj(p.account) ? p.account : null };
}
/** The four ROI cells in order, each { label, text } (NOT_ENOUGH where there is no figure), and the sample. */
function roiCells(roi) {
  const or = (t, why) => t === null ? (roi.enough ? why || NOT_GIVEN : NOT_ENOUGH) : t;
  return [
    { key: 'ppd', label: 'Profit per $1', text: roi.enough ? perDollar(roi.ppd) + (roi.older ? ' (older figure)' : '') : NOT_ENOUGH },
    { key: 'pass', label: 'Pass rate', text: or(pct(roi.pass)) },
    { key: 'days', label: 'Days to pass', text: or(roi.toPass === null ? null : sessionsText(roi.toPass) + ' (median)', 'none passed') },
    { key: 'paid', label: 'Payout per funded account', text: or(usd(roi.paid), 'none funded') },
    { key: 'sample', label: 'Sample', text: sampleText(roi.sample) },
  ];
}
/** The no-edge words beside a figure: "above its no-edge p95 (+0.40)" and the like, '' with no figure. */
function noEdgeText(roi) {
  if (!roi.enough) return '';
  if (roi.older) return 'an older re-ordered figure: never judged against law 6.7\'s no-edge line';
  if (roi.noEdge95 === null) return 'no-edge p95 not known';
  return (roi.above ? 'above' : 'not above') + ' its no-edge p95 (' + signed(roi.noEdge95) + ')';
}
/** The account a score is for: "50K, daily loss limit, $NNN" (the Prop Sim's own; the ledger's checked types come later). */
function typeName(a) {
  if (!isObj(a) || !str(a.size)) return 'account not stated';
  return a.size + ', ' + (a.daily_loss_limit ? 'daily loss limit' : 'no daily loss limit') + (isNum(a.cost_dollars) ? ', ' + usd(a.cost_dollars) : '');
}
const typeKey = a => (isObj(a) ? str(a.size) + '|' + (a.daily_loss_limit ? 1 : 0) + '|' + (isNum(a.cost_dollars) ? a.cost_dollars : '') : '');

/* ---------------------------------------------------------------- builds */
/** The best try of a list of runs (the board's rule, the module docstring), or null. */
function bestTry(runs) {
  let best = null;
  for (const r of runs || []) {
    const f = figure(r);
    if (f === null || !judged(r.prop)) continue;
    if (!best || f > figure(best)) best = r;
  }
  return best;
}
/** The newest try (in the order given, the ledger's) with the line's facts that read no reserved week (line.py _held_by). */
function heldRun(runs) {
  let held = null;
  for (const r of runs || []) {
    if (!isObj(r) || r.kind !== 'try' || (isObj(r.days) && r.days.in_reserved_weeks)) continue;
    if (isObj(r.line)) held = r;
  }
  return held;
}
/** Every build from its runs: [{ id, name, family, instrument, runs, best, tries, specs }], ranked as the board ranks them. */
function builds(runs, board) {
  const by = new Map();
  for (const r of runs || []) {
    const id = str(r.candidate);
    if (!CANDIDATE.test(id)) continue;
    let b = by.get(id);
    if (!b) { b = { id, name: '', family: '', instrument: '', runs: [], best: null, tries: 0, specs: [] }; by.set(id, b); }
    b.runs.push(r);
    if (r.kind === 'try') b.tries++;
    if (!b.name && str(r.name)) b.name = r.name;
    if (!b.family && str(r.family)) b.family = r.family;
    if (!b.instrument && ROOTS.includes(r.instrument)) b.instrument = r.instrument;
    if (str(r.spec_sha256) && !b.specs.includes(r.spec_sha256)) b.specs.push(r.spec_sha256);
  }
  const cands = board && isObj(board.candidates) ? board.candidates : {};
  for (const b of by.values()) {
    b.best = bestTry(b.runs);
    const c = cands[b.id];
    if (isObj(c) && isObj(c.aliases) && Array.isArray(c.aliases.names) && str(c.aliases.names[0])) b.name = c.aliases.names[0];
    if (!b.name) b.name = b.id.slice(0, 12);
  }
  return [...by.values()].sort((a, b) => (a.best === null) - (b.best === null) || (figure(b.best) || 0) - (figure(a.best) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** One page of a list: { rows, page, pages } (page from 1, kept inside the list). */
function pageOf(list, page, per) {
  const pages = Math.max(1, Math.ceil(list.length / per));
  const p = Math.min(Math.max(1, page | 0), pages);
  return { rows: list.slice((p - 1) * per, p * per), page: p, pages };
}

/** The build page's results per account type: each account its tries were scored on, with its best try there; then the
 *  roster's suggested setting when the build is on the roster. [{ kind: 'default' | 'suggested', type, roi | stage numbers }] */
function byType(build) {
  const groups = new Map();
  for (const r of build ? build.runs : []) {
    if (r.kind !== 'try' || !isObj(r.prop)) continue;
    const k = typeKey(r.prop.account);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const rs of groups.values()) {
    const best = bestTry(rs);
    const shown = best || rs[rs.length - 1];
    out.push({ type: typeName(shown.prop.account), tries: rs.length, run: shown.run_id, roi: roiOf(shown), best: !!best });
  }
  return out.sort((a, b) => (b.roi.ppd === null ? -Infinity : b.roi.ppd) - (a.roi.ppd === null ? -Infinity : a.roi.ppd));
}

/* ---------------------------------------------------------------- the roster: the suggested setting and the playbooks */
/** The roster file of this build ({ name, label, approved, roster }) or null: a bot's file (never a lineup's, never a quick
 *  one) whose board candidate is this build, or whose spec is one of the build's. */
function rosterFor(ans, build) {
  if (!isObj(ans) || !ans.ok || !Array.isArray(ans.files) || !build) return null;
  for (const f of ans.files) {
    if (!isObj(f) || !f.ok || f.quick || !isObj(f.roster) || f.roster.format !== 'specrunner.roster/1') continue;
    const mine = (isObj(f.board) && f.board.candidate === build.id) || (isObj(f.roster.spec) && build.specs.includes(f.roster.spec.sha256));
    if (!mine) continue;
    const approved = isObj(f.board) && f.board.group === 'approved_by_anthony';
    return { name: str(f.name), approved, label: approved ? 'approved by Anthony' : PLACED, roster: f.roster };
  }
  return null;
}
const PB_ROWS = [['risk_dollars', 'Risk a trade'], ['daily_loss_stop', 'Daily loss stop'], ['daily_profit_stop', 'Daily profit stop'], ['max_trades', 'Max trades a day'], ['payout_at', 'Payout at']];
/** One stage's playbook and its numbers, as rows: { playbook: [{label, text}], cells (ROI first), noEdge, untuned, sample }. */
function playbookStage(roster, stage) {
  const pb = isObj(roster) && isObj(roster.playbook) && isObj(roster.playbook[stage]) ? roster.playbook[stage] : null;
  const n = isObj(roster) && isObj(roster.numbers) && isObj(roster.numbers[stage]) ? roster.numbers[stage] : null;
  if (!pb || !n) return null;
  const rows = [];
  for (const [k, label] of PB_ROWS) {
    if (!(k in pb)) continue;
    const v = pb[k];
    rows.push({ label, text: v === null ? 'none' : k === 'max_trades' ? (isNum(v) ? String(v) : NOT_GIVEN) : (usd(v) || NOT_GIVEN) });
  }
  const rec = isObj(roster.record) ? roster.record : {};
  const sample = { trades: rec.trades, sessions: rec.sessions };
  const cells = stage === 'eval'
    ? [{ key: 'ppd', label: 'Profit per $1', text: perDollar(n.profit_per_dollar) || NOT_ENOUGH },
      { key: 'pass', label: 'Pass rate', text: pct(n.eval_pass) || NOT_GIVEN },
      { key: 'days', label: 'Days to pass', text: n.sessions_to_pass === null ? 'none passed' : (sessionsText(n.sessions_to_pass) ? sessionsText(n.sessions_to_pass) + ' (median)' : NOT_GIVEN) }]
    : [{ key: 'slot', label: 'Dollars per funded slot per 30 sessions', text: NOT_GIVEN },
      { key: 'ppd', label: 'Profit per $1', text: perDollar(n.profit_per_dollar) || NOT_ENOUGH },
      { key: 'paid', label: 'Payout per funded account', text: usd(n.paid_per_funded) || 'none funded' },
      { key: 'share', label: 'Funded accounts paid', text: pct(n.share_paid) || NOT_GIVEN },
      { key: 'days', label: 'Days to first payout', text: n.sessions_to_first_payout === null ? 'none paid' : (sessionsText(n.sessions_to_first_payout) ? sessionsText(n.sessions_to_first_payout) + ' (median)' : NOT_GIVEN) }];
  cells.push({ key: 'sample', label: 'Sample', text: sampleText(sample) });
  const ne = isObj(n.no_edge) && isNum(n.no_edge.p95) ? n.no_edge.p95 : null;
  const noEdge = n.no_edge_line !== NEW_LINE ? 'an older card: its figure is not law 6.7\'s no-edge line' : ne === null ? 'no-edge p95 not known' : (n.above_no_edge ? 'above' : 'not above') + ' its no-edge p95 (' + signed(ne) + ')';
  return { playbook: rows, cells, noEdge, untuned: isNum(n.not_searched_on) ? perDollar(n.not_searched_on) + ' on the sessions not searched' : 'no number on the sessions not searched' };
}
/** The roster's account: "50K, daily loss limit" (the plan the numbers are for). */
const planName = r => (isObj(r) && isObj(r.plan) ? typeName({ size: r.plan.size, daily_loss_limit: !!r.plan.dll }) : 'account not stated');

/* ---------------------------------------------------------------- the line and the checks */
/** The line of 30 from the board: [{ rank, candidate, name, roi (its held run's), lineFigure, noEdge95, halves, untuned,
 *  toProof, whyNot }], best first; and its words. */
function lineOf(board, list) {
  if (!board || !isObj(board.line) || !Array.isArray(board.line.entries)) return { rows: [], note: '', rankedBy: '', counts: null };
  const by = new Map((list || []).map(b => [b.id, b]));
  const rows = board.line.entries.filter(isObj).map(e => {
    const b = by.get(e.candidate) || null;
    const run = b ? b.runs.find(r => r.run_id === e.run_id) || null : null;
    return { rank: isNum(e.rank) ? e.rank : null, candidate: str(e.candidate), name: b ? b.name : str(e.candidate).slice(0, 12),
      roi: roiOf(run || { prop: { profit_per_dollar: e.profit_per_dollar, sample: e.sample, no_edge: { p95: e.no_edge_p95 }, no_edge_line: e.no_edge_line } }),
      halves: Array.isArray(e.halves) ? e.halves.map(h => (isObj(h) && isNum(h.profit_per_dollar) ? perDollar(h.profit_per_dollar) + ' (no-edge p95 ' + (isNum(h.no_edge_p95) ? signed(h.no_edge_p95) : 'not known') + ')' : NOT_ENOUGH)) : [],
      untuned: isNum(e.untuned_sessions) ? e.untuned_sessions : null, toProof: e.to_proof === true, whyNot: str(e.why_not_to_proof) };
  });
  return { rows, note: str(board.line.note), rankedBy: str(board.line.ranked_by), counts: isObj(board.line.counts) ? board.line.counts : null };
}
/** The plain-code checks the page can show today: { lines: [{ label, text, ok }], missing } from the held run's line facts
 *  (and the board's standing when it reads). The other checks are not on the board yet: missing names them. */
function checksOf(build, board) {
  const held = heldRun(build ? build.runs : []);
  const st = board && isObj(board.candidates) && isObj(board.candidates[build && build.id]) ? board.candidates[build.id].line : null;
  const lines = [];
  if (held) {
    const ln = held.line, tu = isObj(ln.tuned) ? ln.tuned : {};
    const share = isNum(tu.sessions) && tu.sessions > 0 && isNum(tu.days_with_a_trade) ? tu.days_with_a_trade / tu.sessions : null;
    lines.push({ label: 'Trades on 70% of sessions (the floor)', ok: !!(isObj(ln.floor) && ln.floor.met),
      text: (share === null ? 'not known' : pct(share) + ' of its tuned sessions (' + plural(tu.days_with_a_trade, 'day') + ' with a trade of ' + plural(tu.sessions, 'session') + ')') });
    const hs = Array.isArray(ln.halves) ? ln.halves : null;
    lines.push({ label: 'Beats its no-edge line on both halves', ok: !!(hs && hs.length === 2 && hs.every(h => isObj(h) && h.above_no_edge === true)),
      text: hs ? hs.map((h, i) => (i ? 'second half: ' : 'first half: ') + (isObj(h) ? str(h.verdict) + (isNum(h.profit_per_dollar) ? ' (' + perDollar(h.profit_per_dollar) + ', ' + sampleText(h) + ')' : ' (' + sampleText(h) + ')') : NOT_ENOUGH)).join('; ') : 'not scored' });
    const un = isObj(ln.untuned) && isNum(ln.untuned.sessions) ? ln.untuned.sessions : null;
    lines.push({ label: 'At least 40 untuned sessions before proof', ok: un !== null && un >= 40, text: un === null ? 'not known' : plural(un, 'untuned session') });
  }
  if (isObj(st)) {
    lines.push({ label: 'In the line of 30', ok: isNum(st.in_the_line), text: isNum(st.in_the_line) ? 'rank ' + st.in_the_line : (Array.isArray(st.why) && st.why.length ? st.why.join('; ') : 'not in the line') });
  }
  return { lines, held: held ? str(held.run_id) : '',
    missing: 'Not on the board yet: the best day\'s share, 2 more ticks a side, nearness to a proved or rejected build, bunching by time and by zone, and each firm\'s own rules (for Lucid, the microscalp flag).' };
}

/* ---------------------------------------------------------------- the pipeline (stations I to VII) */
const RN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
/** The seven stations with their counts, notes and up to `cap` builds each: [{ rn, id, name, count, note, items: [{ candidate, words }] }]. */
function pipeline(board, list, cap) {
  const n = cap || 6;
  const name = new Map((list || []).map(b => [b.id, b.name]));
  const nm = c => name.get(c) || (str(c) ? str(c).slice(0, 12) : 'not in the ledger');
  const st = board && isObj(board.stations) ? board.stations : {};
  const arr = x => (Array.isArray(x) ? x : []);
  const cands = s => (isObj(s) && Array.isArray(s.candidates) ? s.candidates.filter(isObj) : []);
  const lineCounts = board && isObj(board.line) && isObj(board.line.counts) ? board.line.counts : null;
  const nights = board && Array.isArray(board.nights) ? board.nights.filter(isObj) : [];
  const last = nights.length ? nights[nights.length - 1] : null;
  const out = [];
  const screen = arr(st.screen);
  out.push({ id: 'screen', name: 'Screen', count: screen.length,
    note: last ? 'Last night (' + str(last.night) + '): ' + plural(isNum(last.made) ? last.made : 0, 'build') + ' made, ' + plural(isNum(last.new) ? last.new : 0, 'new one') + '.' : 'No screen night yet.',
    items: screen.slice(0, n).map(c => ({ candidate: c, words: '' })) });
  const line = arr(st.line);
  out.push({ id: 'line', name: 'The line', count: line.length,
    note: lineCounts ? plural(isNum(lineCounts.in_the_line) ? lineCounts.in_the_line : line.length, 'build') + ' of 30; ' + plural(isNum(lineCounts.joins) ? lineCounts.joins : 0, 'build') + ' met the floor and beat the no-edge line on both halves.' : 'The line of the best 30 (trades on 70% of sessions and beats its no-edge line on both halves).',
    items: line.slice(0, n).map((c, i) => ({ candidate: c, words: 'rank ' + (i + 1) })) });
  const review = cands(st.review), proof = cands(st.proof);
  const outcome = { proved: 'proved', not_proved: 'not proved', shadow: 'short of 30 trades' };
  out.push({ id: 'proof', name: 'Proof', count: proof.length,
    note: plural(review.length, 'build') + ' picked for proof (' + (isObj(st.review) && isNum(st.review.a_night) ? st.review.a_night : 3) + ' a night). ' + (isObj(st.proof) && str(st.proof.note) ? st.proof.note : (isObj(st.proof) && isObj(st.proof.rule) ? 'Proved: ' + str(st.proof.rule.proved) + '.' : '')),
    items: review.slice(0, n).map(e => ({ candidate: str(e.candidate), words: 'picked ' + str(e.night) })).concat(proof.slice(0, n).map(e => ({ candidate: str(e.candidate), words: outcome[e.outcome] || 'not read' }))) });
  const yours = cands(st.your_review);
  out.push({ id: 'your_review', name: 'Your review', count: yours.length,
    note: yours.length ? 'Proved: waiting for your Approve or Reject (The Desk\'s Lab, until Legion\'s review is built).' : (isObj(st.your_review) && str(st.your_review.note)) || 'Nothing waits for you.',
    items: yours.slice(0, n).map(e => ({ candidate: str(e.candidate), words: 'proved' + (isObj(e.proof) && isNum(e.proof.trades) ? ', ' + plural(e.proof.trades, 'trade') : '') })) });
  const ro = isObj(st.roster) ? st.roster : {};
  const appr = arr(ro.approved_by_anthony).filter(isObj), placed = arr(ro.placed_for_the_legion_build).filter(isObj);
  out.push({ id: 'roster', name: 'Roster', count: appr.length,
    note: plural(appr.length, 'build') + ' approved by you. ' + plural(placed.length, 'file') + ' placed for the Legion build (' + PLACED + ').',
    items: appr.slice(0, n).map(e => ({ candidate: str(e.candidate), words: str(e.display_name) || str(e.bot) })).concat(placed.slice(0, n).map(e => ({ candidate: str(e.candidate), words: str(e.bot) + ' (' + PLACED + ')' }))) });
  out.push({ id: 'live', name: 'Live check', count: null, note: 'A build\'s first live trades at half size by your GO: on Go live (not built yet).', items: [] });
  out.push({ id: 'full', name: 'Full size', count: null, note: 'The size your GO names, once the live check passes: on Go live (not built yet).', items: [] });
  const shadow = cands(st.shadow);
  if (shadow.length) out[2].note += ' ' + plural(shadow.length, 'build') + ' in the board\'s older shadow outcome.';
  out.forEach((s, i) => { s.rn = RN[i]; s.items = s.items.map(x => Object.assign(x, { name: nm(x.candidate), link: CANDIDATE.test(x.candidate) })); });
  return out;
}

/* ---------------------------------------------------------------- the trades and the one trade on the chart */
/** The trades answer: { ok, problem, placeholder, fence, counts, pages, page, show, rows }. */
function tradesOf(ans) {
  const out = { ok: false, problem: null, placeholder: true, fence: '', counts: null, pages: 0, page: 1, show: 'all', rows: [] };
  if (!isObj(ans)) return Object.assign(out, { problem: 'The trades\' answer is not one this page knows.' });
  if (!ans.ok) return Object.assign(out, { problem: str(ans.problem) || 'This build\'s trades are not there yet.' });
  const f = isObj(ans.fence) ? ans.fence : {};
  if (f.days !== 'discovery') return Object.assign(out, { problem: 'The trades are not marked discovery days only: nothing is shown.' });
  const rows = (Array.isArray(ans.trades) ? ans.trades : []).filter(t => isObj(t) && isNum(t.n) && DATE.test(str(t.session)) && (t.side === 'long' || t.side === 'short') && isNum(t.r));
  return Object.assign(out, { ok: true, placeholder: ans.placeholder !== false, counts: isObj(ans.counts) ? ans.counts : null,
    fence: 'Discovery days only (by ' + str(f.by) + '). ' + (isNum(f.locked_weeks_counted) ? plural(f.locked_weeks_counted, 'locked week') + ' of the proof counted, never listed or drawn.' : ''),
    pages: isNum(ans.pages) ? ans.pages : 1, page: isNum(ans.page) ? ans.page : 1, show: SHOWS.includes(ans.show) ? ans.show : 'all', rows });
}
/** The bars to ask for one trade: { root, session, from, to } (UTC ms), or null when the trade has no entry time. */
function tradeWindow(t, root) {
  if (!isObj(t) || !isNum(t.entry_ms) || !DATE.test(str(t.session))) return null;
  const exit = isNum(t.exit_ms) && t.exit_ms >= t.entry_ms ? t.exit_ms : t.entry_ms;
  return { root: ROOTS.includes(root) ? root : 'MNQ', session: t.session, from: t.entry_ms - BEFORE_MS, to: exit + AFTER_MS };
}
/** The Desk's GET /api/bars answer cut to the window: [[t, o, h, l, c, v], ...] (UTC ms), in time order. */
function barsIn(ans, w) {
  if (!isObj(ans) || !Array.isArray(ans.bars) || !w) return [];
  return ans.bars.filter(b => Array.isArray(b) && b.length >= 5 && b.slice(0, 5).every(isNum) && b[0] >= w.from && b[0] <= w.to && b[2] >= b[3])
    .sort((a, b) => a[0] - b[0]);
}
/** What the chart draws for one trade: { bars (chart-engine's), trades, levels }. zone(unixSeconds) -> the chart's wall clock
 *  seconds (ChartEngine.util.zoneSeconds). Only the trade's own numbers and the bars given: nothing made up. */
function chartOf(t, rows, zone, stopColor) {
  const z = typeof zone === 'function' ? zone : (s => s);
  const bars = (rows || []).map(b => ({ t: z(b[0] / 1000), o: b[1], h: b[2], l: b[3], c: b[4], v: isNum(b[5]) ? b[5] : 0 }));
  const dir = t.side === 'long' ? 1 : -1;
  const trades = [];
  if (isNum(t.entry_ms) && isNum(t.entry)) {
    const done = isNum(t.exit_ms) && isNum(t.exit);
    trades.push({ tIn: z(t.entry_ms / 1000), pIn: t.entry, tOut: done ? z(t.exit_ms / 1000) : null, pOut: done ? t.exit : null, dir,
      label: signed(t.r) + ' R' });
  }
  const levels = isNum(t.stop) ? [{ name: 'Stop', price: t.stop, color: stopColor || '#8392A5' }] : [];
  return { bars, trades, levels };
}
/** One trade's numbers as rows: [{ label, text }] (prices in points as the file gives them, R and dollars). */
function tradeRows(t) {
  const px = x => (isNum(x) ? x.toFixed(2) : NOT_GIVEN);
  const flags = Array.isArray(t.flags) && t.flags.length ? t.flags.join('; ') : 'none';
  return [
    { label: 'Trade', text: '#' + t.n + ', session ' + t.session },
    { label: 'Side', text: t.side === 'long' ? 'Long' : 'Short' },
    { label: 'Entry', text: px(t.entry) }, { label: 'Stop', text: px(t.stop) }, { label: 'Exit', text: px(t.exit) },
    { label: 'R', text: signed(t.r) + ' R' }, { label: 'P&L', text: isNum(t.pnl) ? usd(t.pnl) : NOT_GIVEN },
    { label: 'Plain-code flags', text: flags },
  ];
}

/* ---------------------------------------------------------------- the Builder, the Seeds and the Agents (read only here) */
/** The board's library and the Builder's requests: { slots: [{ slot, options: [words] }], fates: [{ id, state, why, candidate,
 *  night }], perNight, why }. Asking for a build stays on The Desk's Lab for now (the write is The Desk page's). */
function builderOf(board) {
  const lib = board && isObj(board.library) ? board.library : null;
  const slots = lib && Array.isArray(lib.slots) ? lib.slots.filter(s => isObj(s) && str(s.slot) && Array.isArray(s.options))
    .map(s => ({ slot: s.slot, options: s.options.filter(isObj).map(o => str(o.words)) })) : [];
  const fates = board && Array.isArray(board.builder) ? board.builder.filter(isObj).map(f => ({ id: str(f.id), state: str(f.state), why: str(f.why), candidate: str(f.candidate), night: str(f.night) })) : [];
  return { slots, fates, perNight: board && isNum(board.builder_builds) ? board.builder_builds : null,
    why: slots.length ? '' : 'The board has no library yet: the Builder works once Bot-Lab\'s board carries it.' };
}
/** The seeds from GET /api/lab ("seeds": the newest 30 requests, never their words): [{ name, size, path, state, made, agent, refused }]. */
function seedsOf(lab) {
  const list = isObj(lab) && Array.isArray(lab.seeds) ? lab.seeds.filter(isObj) : [];
  return list.map(s => ({ name: str(s.name), size: str(s.size), path: isObj(s.path) ? (s.path.kind === 'fork' ? 'fork of seat ' + str(s.path.source_seat) : 'fresh') : '',
    state: str(s.state), agent: str(s.agent_id), refused: str(s.refused), made: isNum(s.made_at) ? s.made_at : null }));
}
/** This PC's agent builds from the PC helper's GET /status: [{ build, hero, tier, exam, live, liveN }] (numbers or null). */
function agentsOf(status) {
  const list = isObj(status) && Array.isArray(status.builds) ? status.builds.filter(isObj) : [];
  return list.map(b => ({ build: str(b.build), hero: str(b.hero), tier: str(b.tier),
    exam: isNum(b.examEdge) ? b.examEdge : null, live: isNum(b.liveEdge) ? b.liveEdge : null, liveN: isNum(b.liveN) ? b.liveN : null }));
}
/** An edge in R with its sample: "+0.12 R over 40 trades", or NOT_ENOUGH. */
const edgeText = (x, n) => (isNum(x) ? signed(x) + ' R' + (isNum(n) ? ' over ' + plural(n, 'trade') : '') : NOT_ENOUGH);

return Object.freeze({ SUBS, SUB_NAMES, SHOWS, SHOW_NAMES, PER_PAGE, BUILDS_PER_PAGE, BEFORE_MS, AFTER_MS, NEW_LINE, ZONE_SPLIT_ON,
  NOT_ENOUGH, NOT_GIVEN, SIMULATED, ZONES_OFF, SLOT_30, NOT_NAMED, DEFAULT_SETTING, PLACED, ROUTES, RN,
  signed, perDollar, pct, usd, sessionsText, sampleText, routeFrom, routeSearch, failWords, boardOf, runsOf,
  roiOf, roiCells, noEdgeText, typeName, bestTry, heldRun, builds, pageOf, byType, rosterFor, playbookStage, planName,
  lineOf, checksOf, pipeline, tradesOf, tradeWindow, barsIn, chartOf, tradeRows, builderOf, seedsOf, agentsOf, edgeText,
  isCandidate: id => CANDIDATE.test(str(id)) });
});
