/*
 * The league (chart 1.35.0, Anthony 2026-10-21, Bot-Lab notes/DECISIONS_bot_division.md "SHADOW LEAGUE: WHERE IT RUNS AND HOW IT
 * SHOWS", and his ruling of the same day: keep the Agent tab as it is and add the league as a second top-level tab): the top
 * bar's League tab, beside the Agent tab, and the league's trades, faint, on any chart (a switch in each chart's ⋯ menu, off by
 * default).
 *
 * The shadow league runs on the WORK PC as its own process: three seats identical but for the judge model, H (Haiku, amber),
 * S (Sonnet, cyan), O (Opus, violet), each trading on paper. Nothing here sends an order and nothing here can: the page only
 * reads The Desk's GET /api/chart-league (TheDesk docs/API.md "Shadow league"), which serves the league's own files read only:
 * status.json, the day's paper trades (closed and open), its decisions, and the standings. "SHADOW: no orders" is on the view.
 *
 * The League button shows once The Desk answers GET /api/chart-league (a Desk of this release, reachable from this PC); with no such
 * Desk it stays hidden and the top bar keeps its room.
 *
 * The view: one chart, NQ 1 min (1.38.1, Anthony 2026-10-23: his only MNQ chart is a 40-range execution chart and every other
 * chart, a 1 min among them, is NQ; so the League chart is NQ 1 min with {days: 5, tickHours: 0}, the load his NQ 1 min chart
 * already holds, and opens at once with no NinjaTrader request of its own). The league trades MNQ: its marks are drawn at their
 * MNQ prices on the NQ candles (the same index, no conversion), and the chart's label says so. Each seat's paper trades as hollow markers
 * carrying its letter in its colour (a circle at the fill, a diamond at the exit) and faint stop and target lines from the fill
 * to the exit (or to now while open); the legend strip; each seat's day (its position, its virtual 50K Flex account, its
 * decisions, a flag for Anthony); the week and month table with agreement and decision time; the decision log; the API spend
 * against the caps. The chart's look is the chart's own: the marks are an overlay canvas over it, drawn after each frame the
 * chart draws (its `drawn` event), never part of the engine.
 *
 * Times: the league's are New York wall-clock milliseconds stored as if UTC, the chart's own convention times 1000.
 *
 * A past day (Anthony's task "League view opens a given past day", for The Desk's Agent Stats day rows): the page's address
 * `?tab=league&day=YYYY-MM-DD` opens the view on that session date, read only. The date is checked first (the form, a real
 * calendar date, not after the league's current session date; that date itself opens the live view); a bad one is said plainly and the live view
 * shows. A past day reads GET /api/chart-league?date=<day> (The Desk already takes it) and shows that day's paper trades and
 * decisions under a "Past day" label with a Back to today button. The live status (positions, flags, the spend) is not kept
 * per day, so it is never shown for a past day; a day with no record says so ("not enough data"), never a guess. A past day is
 * never handed to the faint marks or the Agents strip (liveDay()).
 *
 * The Colosseum (chart 1.50.0; Anthony 2026-11-11, the loop amendment 1 section 5: "research on the live market"): this tab, renamed
 * and widened. It keeps all of the above and gains the watch: the bots that shadow the live market because the loop wants more
 * data on them (the loop's station 5). Which bots the loop watches is not built yet (the loop's step 3), so the box shows what
 * the page already knows, ChartBridge's own traders that are in Shadow now, said as that, and "not built yet" for the rest.
 * Its connection (o.watch) has one key, listen: nothing on this tab can send a message to ChartBridge, by how it is built.
 *
 * No chart on the Colosseum (chart 1.57.0; Anthony 2026-11-13, asked whether the league's chart stays beside the leaderboard: "I
 * dont think its necessary"). The tab is the leaderboard, the watch, the seats' day, the week and month table and the decision
 * log. The league's marks (LeagueOverlay, below) still go on any NQ or MNQ chart through its ⋯ switch, faint, as before; the
 * chart part of the view text above is history.
 *
 * Two parts, as workspace.js: LeagueCore (pure: Node tests, test/league.test.js) and, in a browser, LeagueOverlay (the marks
 * over a chart) and LeagueView (the tab).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LeagueCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const SHADOW = 'SHADOW: no orders';
/* Anthony's letters and colours (amber, cyan, violet); the colours appear only in the league's own marks and legend */
const SEATS = [
  { id: 'H', family: 'Haiku', color: '#FFC266' },
  { id: 'S', family: 'Sonnet', color: '#5DE0F0' },
  { id: 'O', family: 'Opus', color: '#B69CFF' },
];
const SEAT = Object.fromEntries(SEATS.map(s => [s.id, s]));
const ROOTS = ['MNQ', 'NQ'];               // the league trades MNQ; NQ is one instrument with it (its prices are the same)
const GHOST_KEY = 'live-league-ghost-v1';   // the charts whose ⋯ switch shows the league's trades, faint: { panelId: true }
const isNum = v => typeof v === 'number' && isFinite(v);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n || 200) : '');

/** One paper trade as the page uses it, or null. */
function cleanTrade(t, open) {
  if (!t || typeof t !== 'object' || !SEAT[t.seat] || (t.side !== 'long' && t.side !== 'short')) return null;
  if (!isNum(t.fill_t) || !isNum(t.fill_px)) return null;
  return { id: str(t.id, 64), seat: t.seat, side: t.side, contracts: isNum(t.contracts) ? t.contracts : null, fillT: t.fill_t, fillPx: t.fill_px,
    stopPx: isNum(t.stop_px) ? t.stop_px : null, targetPx: isNum(t.target_px) ? t.target_px : null,
    /* the trade's ORIGINAL risk (1.36.0 review: the Agents strip's open R): the league's risk_dollars and the stop distance at
       the fill; stop_px moves with break-even and the trail, so it is never the risk */
    riskDollars: isNum(t.risk_dollars) && t.risk_dollars > 0 ? t.risk_dollars : null, stopPoints: isNum(t.stop_points) && t.stop_points > 0 ? t.stop_points : null,
    exitT: !open && isNum(t.exit_t) ? t.exit_t : null, exitPx: !open && isNum(t.exit_px) ? t.exit_px : null, exitReason: str(t.exit_reason, 80),
    r: isNum(t.r) ? t.r : null, open: !!open, relation: ['own', 'with', 'against'].includes(t.relation) ? t.relation : null, crashCut: t.crash_cut === true,
    reference: str(t.reference, 40) };
}

/**
 * The Desk's GET /api/chart-league as the view uses it: { date, problem, status, day, league, trades, open, decisions }. Never
 * throws. `problem` is what to say when there is nothing (no league files on The Desk, no session yet), else ''.
 */
function cleanDay(j, past) {
  const out = { date: '', problem: '', status: null, day: null, league: null, trades: [], open: [], decisions: [] };
  if (!j || typeof j !== 'object') { out.problem = 'The Desk sent nothing the page can read.'; return out; }
  out.date = typeof j.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j.date) ? j.date : '';
  const f = j.folder && typeof j.folder === 'object' ? j.folder : {};
  /* 1.42.1 (Anthony 2026-11-02, a false alarm): since The Desk moved to HOMESERVER (2026-10-27) it reads the league from the
     copy WORK's League Mirror task posts, and answers folder { set: false, ok: true, problem: null, source: 'mirror' }. The Desk's
     own folder.problem text is always shown; with no text, ok true is never a problem whatever set says, and only an older Desk
     (set false, no ok) gets the page's sentence, which never sends Anthony to set a folder on WORK. */
  if (typeof f.problem === 'string' && f.problem) out.problem = f.problem.slice(0, 200);
  else if (f.ok !== true && f.set === false) out.problem = 'No league files have reached The Desk yet.';
  /* a past day: status.json is the league's LIVE status (today's positions, flags and spend), never that day's, so it is left out */
  out.status = !past && j.status && typeof j.status === 'object' ? j.status : null;
  out.past = !!past;
  out.day = j.day && typeof j.day === 'object' ? { closed: j.day.closed === true, note: str(j.day.note, 300) } : null;
  out.league = j.league && typeof j.league === 'object' ? j.league : null;
  out.trades = (Array.isArray(j.trades) ? j.trades : []).map(t => cleanTrade(t, false)).filter(Boolean);
  out.open = (Array.isArray(j.open) ? j.open : []).map(t => cleanTrade(t, true)).filter(Boolean);
  out.decisions = (Array.isArray(j.decisions) ? j.decisions : []).filter(d => d && SEAT[d.seat]).slice(-500);
  return out;
}

/**
 * What the overlay draws for a chart of `root`, from a cleaned day: [{ seat, color, letter, kind: 'entry' | 'exit', t (chart
 * seconds), price, side }] and lines [{ seat, color, kind: 'stop' | 'target', t0, t1 (null: to the right edge), price }].
 * Nothing for a root the league does not trade.
 */
function marksFor(day, root) {
  const out = { marks: [], lines: [] };
  if (!day || !ROOTS.includes(root)) return out;
  for (const t of day.trades.concat(day.open)) {
    const c = SEAT[t.seat].color, t0 = t.fillT / 1000, t1 = t.exitT === null ? null : t.exitT / 1000;
    out.marks.push({ seat: t.seat, color: c, letter: t.seat, kind: 'entry', t: t0, price: t.fillPx, side: t.side });
    if (t.exitT !== null && t.exitPx !== null) out.marks.push({ seat: t.seat, color: c, letter: t.seat, kind: 'exit', t: t1, price: t.exitPx, side: t.side });
    if (t.stopPx !== null) out.lines.push({ seat: t.seat, color: c, kind: 'stop', t0, t1, price: t.stopPx });
    if (t.targetPx !== null) out.lines.push({ seat: t.seat, color: c, kind: 'target', t0, t1, price: t.targetPx });
  }
  return out;
}

/** The index of the bar holding chart time t (seconds): the last bar starting at or before t, or -1. Bars are oldest first. */
function barIndex(bars, t) {
  let lo = 0, hi = (bars ? bars.length : 0) - 1, hit = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].t <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1; }
  return hit;
}

const money = v => (isNum(v) ? (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
const signedR = v => (isNum(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) + ' R' : '');

/** A decision log row: { time, seat, text, kind ('enter' | 'rest' | 'cancel' | 'pass' | 'refused' | 'failed'), latency }. Newest first.
    1.36.0: a "rest" answer (a resting entry, PREREG Amendment 6) is shown as a resting order, never as an entry; "cancel" as
    the cancel of one. The Desk passes no good-until time with a decision: "good until not reported". */
function decisionRows(decisions, most) {
  const out = [];
  for (const d of (decisions || []).slice().reverse()) {
    if (out.length >= (most || 60)) break;
    const a = d.answer && typeof d.answer === 'object' ? d.answer : {};
    let kind, text;
    if (!d.call_ok) { kind = 'failed'; text = 'no answer (the call failed)'; }
    else if (d.refused) { kind = 'refused'; text = 'refused: ' + str(d.refused, 160); }
    else if (a.action === 'pass') { kind = 'pass'; text = 'passed' + (a.reasoning ? ': ' + str(a.reasoning, 200) : ''); }
    else if (a.action === 'cancel') { kind = 'cancel'; text = 'cancelled its resting order' + (a.reasoning ? ': ' + str(a.reasoning, 200) : ''); }
    else if (a.action === 'rest') { kind = 'rest'; text = 'rest ' + (a.side === 'short' ? 'short' : 'long') + (a.reference ? ' at ' + str(a.reference, 30) : '') +
      (isNum(a.stop_points) ? ', stop ' + a.stop_points + ' pt' : '') + (isNum(a.target_points) ? ', target ' + a.target_points + ' pt' : ', no target') + ', good until not reported' + (a.reasoning ? ': ' + str(a.reasoning, 200) : ''); }
    else { kind = 'enter'; text = (a.side === 'short' ? 'short' : 'long') + (isNum(d.contracts) ? ' ' + d.contracts + ' MNQ' : '') + (isNum(a.stop_points) ? ', stop ' + a.stop_points + ' pt' : '') +
      (isNum(a.target_points) ? ', target ' + a.target_points + ' pt' : ', no target') + (a.reference ? ' at ' + str(a.reference, 30) : '') + (a.reasoning ? ': ' + str(a.reasoning, 200) : ''); }
    if (d.relation === 'with') text += ' (with you)'; else if (d.relation === 'against') text += ' (against you)';
    out.push({ time: str(d.time, 8).slice(0, 5), seat: d.seat, kind, text, latency: isNum(d.latency_s) ? d.latency_s : null, trigger: str(d.trigger, 60) });
  }
  return out;
}

/** Each seat's day from status.json and the day's trades: { seat, family, color, line, account, flag, stopped, todayR, n }. */
function seatDays(day) {
  const past = !!(day && day.past);
  const st = day && day.status && day.status.seats && typeof day.status.seats === 'object' ? day.status.seats : {};
  return SEATS.map(s => {
    const x = st[s.id] && typeof st[s.id] === 'object' ? st[s.id] : null;
    const mine = (day ? day.trades : []).filter(t => t.seat === s.id && t.r !== null && !t.crashCut);
    const todayR = mine.length ? mine.reduce((a, t) => a + t.r, 0) : null;
    const pos = x && x.position && typeof x.position === 'object' ? x.position : null;
    const fx = x && x.flex && typeof x.flex === 'object' ? x.flex : null;
    const line = past ? 'past day: the live status is not kept per day' : !x ? 'not reported' : pos ? (pos.side === 'short' ? 'SHORT ' : 'LONG ') + (isNum(pos.contracts) ? pos.contracts + ' MNQ' : '') + (isNum(pos.fill_px) ? ' from ' + pos.fill_px : '')
      : x.api_stopped ? 'API stopped: ' + str(x.api_stopped, 120) : x.stopped ? 'stopped: ' + str(x.stopped, 120) : 'flat';
    return { seat: s.id, family: s.family, color: s.color, line, flag: x && typeof x.flag === 'string' ? x.flag.slice(0, 200) : '',
      account: fx ? str(String(fx.phase || ''), 10) + (isNum(fx.balance) ? ' · ' + money(fx.balance) : '') + (isNum(fx.today_pnl) ? ' · today ' + money(fx.today_pnl) : '') : '',
      decisions: x && isNum(x.decisions) ? x.decisions : null, entries: x && isNum(x.entries) ? x.entries : null, todayR, n: mine.length };
  });
}

/** The standings table's rows (week, month, agreement, decision time) from the league's standings; "not enough data yet" under its 20. */
function standingRows(league) {
  const seats = league && league.seats && typeof league.seats === 'object' ? league.seats : {};
  const enough = league && isNum(league.enough_n) ? league.enough_n : 20;
  const cell = d => (!d || !isNum(d.n) || !d.n ? 'n 0' : !d.enough || !isNum(d.mean_r) ? 'not enough data yet (n ' + d.n + ' of ' + enough + ')' : signedR(d.mean_r) + ' (n ' + d.n + ')');
  return SEATS.map(s => {
    const x = seats[s.id] || {};
    const r = x.rolling || {};
    const m = x.mentor || {};
    const lat = x.latency || {};
    return { seat: s.id, family: s.family, color: s.color, week: cell(r.week), month: cell(r.month), all: cell(x.score),
      agreement: isNum(m.agreement) ? Math.round(m.agreement * 100) + '%' : 'none yet',
      latency: isNum(lat.median_s) ? lat.median_s + ' s median (n ' + (lat.n || 0) + ')' : 'no call yet',
      fence: x.fences && isNum(x.fences.cleared) ? 'cleared fence ' + x.fences.cleared + ' (a signal)' : '' };
  });
}

/** The spend against the caps, in words: { day, month, stopped }. */
function spendText(spend) {
  if (!spend || typeof spend !== 'object') return { day: 'not reported', month: 'not reported', stopped: '' };
  const cap = (v, c) => money(v) + ' of ' + money(isNum(c) ? c : 0);
  return { day: cap(spend.day_spent, spend.day_cap), month: cap(spend.month_spent, spend.month_cap), stopped: spend.stopped ? 'API stopped: ' + str(spend.stopped, 200) : '' };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;
const isoOf = ms => new Date(ms).toISOString().slice(0, 10);
/* a session date from a calendar date (UTC ms of its midnight) and the time of day (minutes): from 17:00 the next date, and a
   Saturday or Sunday rolls to Monday (the league's session date, as Bot-Lab manrae.live.session_date) */
function rollSession(dayMs, minutes) {
  let t = dayMs + (minutes >= 17 * 60 ? DAY_MS : 0);
  const wd = new Date(t).getUTCDay();
  if (wd === 6) t += 2 * DAY_MS; else if (wd === 0) t += DAY_MS;
  return isoOf(t);
}
/** The league's current session date (YYYY-MM-DD) at `now` (ms, default the clock): New York time, from 17:00 the next date,
    a weekend rolls to Monday. "Today" for a link's day. */
function sessionToday(now) {
  const d = new Date(isNum(now) ? now : Date.now());
  let p;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  } catch (e) { p = null; }
  if (!p) return rollSession(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), d.getUTCHours() * 60 + d.getUTCMinutes());
  return rollSession(Date.UTC(+p.year, +p.month - 1, +p.day), (+p.hour % 24) * 60 + +p.minute);
}
/** The session a chart bar belongs to (t: chart seconds, New York wall time as if UTC): 18:00 opens the next date's session
    (a bar in the 17:00 break counts with the next one), a weekend rolls to Monday. */
function sessionOfBar(t) {
  const dayMs = Math.floor(t / 86400) * DAY_MS;
  return rollSession(dayMs, Math.floor((t - dayMs / 1000) / 60));
}

/**
 * The `day` of the page's address (?tab=league&day=YYYY-MM-DD), checked against `today` (New York, YYYY-MM-DD):
 * { ok: true, day: 'YYYY-MM-DD' } a past day; { ok: true, day: null } no day asked, or today (the live view);
 * { ok: false, day: null, problem } anything else, said plainly (the live view shows, nothing is guessed).
 */
function checkDay(raw, today) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, day: null, problem: '' };
  const s = String(raw).slice(0, 40);
  const shown = s.replace(/[^0-9A-Za-z-]/g, '?');
  const m = DATE_RE.exec(s);
  if (!m) return { ok: false, day: null, problem: 'The link asked for the day "' + shown + '", which is not a date (YYYY-MM-DD). Showing today.' };
  const y = +m[1], mo = +m[2], d = +m[3], t = new Date(Date.UTC(y, mo - 1, d));
  if (y < 2000 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return { ok: false, day: null, problem: 'The link asked for ' + s + ', which is not a calendar date. Showing today.' };
  if (DATE_RE.test(today || '') && s > today) return { ok: false, day: null, problem: 'The link asked for ' + s + ', which is after the current session (' + today + '). Showing today.' };
  if (s === today) return { ok: true, day: null, problem: '' };
  return { ok: true, day: s, problem: '' };
}

/** A past day with nothing to show: no paper trade, open or closed, and no decision. The words say so; nothing is guessed. */
function pastEmpty(day) {
  return !!day && !day.trades.length && !day.open.length && !day.decisions.length;
}
function emptyText(date) {
  return 'No league record for ' + date + ': no paper trade and no decision. Not enough data to show that day.';
}


/**
 * The Colosseum's watch box (1.50.0): the traders in Shadow now, from the rows FleetCore.traders makes of ChartBridge's own
 * `agent` messages (passed in, so this stays pure). -> [{ id, name, build, status, place, trades }]. Only mode 'shadow': a
 * trader in Auto or Copilot is trading or asking, not being watched, and one whose mode is not known is not guessed at.
 */
const KIND_WORDS = { prop: 'on a prop account', propsim: 'on prop and Sim accounts', personal: 'on your personal account', sim: 'on Sim accounts', unlisted: 'on an account NinjaTrader does not list now', mixed: 'on your personal and prop accounts', none: 'on None: no account' };
function watchRows(traders) {
  const out = [];
  for (const t of Array.isArray(traders) ? traders : []) {
    if (!t || t.mode !== 'shadow' || typeof t.id !== 'string') continue;
    out.push({ id: str(t.id, 64), name: str(t.name, 40) || str(t.id, 40), build: str(t.build, 40), status: str(t.status, 160),
      place: KIND_WORDS[t.kind] || 'on an account the page cannot tell yet', trades: isNum(t.trades) ? t.trades : null });
  }
  return out;
}
const WATCH_LATER = 'Which bots the loop is watching, why, and their score against the bar: not built yet (the loop\'s step 3, the watch of station 5).';

/* ---------------------------------------------------------------- the leaderboard (chart 1.57.0, part F; Anthony 2026-11-13)
 * One ranked table of every bot and agent, mingled ("so we see what performs better each day"), told apart by the BOT and AGENT
 * tags the other pages use. No chart. The rows come from The Desk's GET /api/chart-colosseum (every program that posted a
 * trading day lately: R per day) and the league's seats from GET /api/chart-league (R per trade, as the league keeps it). The
 * two measures are never added together: on Multi-day the seats rank after the Desk's rows and show their own numbers. */
const MODE_WORD = { shadow: 'Shadow', copilot: 'Copilot', auto: 'Auto', sim: 'Sim' };
const BOARD_EARLY = 5;          // fewer days than this: "too early" instead of a word (Anthony 2026-11-13)
const r2 = v => Math.round(v * 10000) / 10000;
/** The Desk's GET /api/chart-colosseum, cleaned: { ok, why, today, programs: [...] }. Never throws; a program not in the shape is left out. */
function cleanBoard(j) {
  const out = { ok: false, why: '', today: '', programs: [] };
  if (!j || typeof j !== 'object' || j.v !== 1 || !Array.isArray(j.programs)) { out.why = 'The Desk\'s leaderboard answer is not one the page reads.'; return out; }
  out.ok = true; out.today = DATE_RE.test(j.today || '') ? j.today : '';
  for (const p of j.programs.slice(0, 200)) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id || (p.kind !== 'bot' && p.kind !== 'agent') || !Array.isArray(p.days)) continue;
    const days = p.days.filter(d => d && DATE_RE.test(d.date || '') && isNum(d.r) && isNum(d.trades) && d.trades >= 0).slice(0, 20)
      .map(d => ({ date: d.date, r: d.r, trades: d.trades, pnl: isNum(d.pnl) ? d.pnl : null, mode: MODE_WORD[d.mode] ? d.mode : '', spent: isNum(d.spent_usd) ? d.spent_usd : null, paper: d.paper === true }));
    const today = (Array.isArray(p.today) ? p.today : []).filter(t => t && typeof t === 'object').slice(0, 200).map(t => ({
      n: isNum(t.n) ? t.n : null, setup: str(t.setup, 80), side: str(t.side, 8), root: str(t.root, 8), qty: isNum(t.qty) ? t.qty : null,
      entry: str(t.entry_time, 8), exit: str(t.exit_time, 8), why: str(t.exit_reason, 40), r: isNum(t.r) ? t.r : null, pnl: isNum(t.pnl) ? t.pnl : null }));
    out.programs.push({ id: str(p.id, 64), kind: p.kind, source: p.source === 'bots' ? 'bots' : 'agents', build: str(p.build, 60), mode: MODE_WORD[p.mode] ? p.mode : '',
      lastDay: DATE_RE.test(p.last_day || '') ? p.last_day : '', days, today, diary: str(p.diary, 1000) });
  }
  return out;
}
/** The pace word (Anthony 2026-11-13: "are they on track, beating or lagging?"): fewer than 5 days "too early"; a bot's backtest
    pace is not on the roster card yet ("no backtest pace yet", builder 1's fields to come); an agent has none ("no backtest"). */
function paceWord(kind, days) {
  if (days < BOARD_EARLY) return 'too early';
  return kind === 'bot' ? 'no backtest pace yet' : 'no backtest';
}
/**
 * The leaderboard's rows. board: cleanBoard()'s result (or null); day: the league's cleaned day (or null); today: New York's session
 * date. -> [{ key, name, kind, source, status, todayN, todayR, r5, r20, n5, n20, comparable, pace, cost, decision, trades, log }]
 */
function boardRows(board, day, today) {
  const out = [];
  for (const p of board && board.ok ? board.programs : []) {
    const d0 = p.days[0] && p.days[0].date === today ? p.days[0] : null;
    const take = n => p.days.slice(0, n);
    const sum = ds => r2(ds.reduce((a, d) => a + d.r, 0));
    const month = today.slice(0, 7), mDays = p.days.filter(d => d.date.slice(0, 7) === month);
    const spentToday = d0 ? d0.spent : null, spentMonth = mDays.some(d => d.spent !== null) ? r2(mDays.reduce((a, d) => a + (d.spent || 0), 0)) : null;
    const mTrades = mDays.reduce((a, d) => a + d.trades, 0);
    out.push({ key: 'desk:' + p.id, name: p.id, kind: p.kind, source: 'desk',
      status: (MODE_WORD[p.mode] || 'mode not said') + (d0 ? (d0.paper ? ', paper' : '') + ', reported today' : p.lastDay ? ', last day ' + p.lastDay : ''),
      todayN: d0 ? d0.trades : 0, todayR: d0 ? d0.r : null,
      r5: p.days.length ? sum(take(5)) : null, n5: Math.min(5, p.days.length), r20: p.days.length ? sum(take(20)) : null, n20: p.days.length, comparable: true,
      pace: paceWord(p.kind, p.days.length),
      cost: p.kind === 'agent' ? { today: spentToday, month: spentMonth, perTrade: spentMonth !== null && mTrades > 0 ? r2(spentMonth / mTrades) : null } : null,
      decision: p.kind === 'agent' ? 'not reported' : '', trades: d0 ? p.today : [], log: p.diary ? [{ time: '', text: p.diary }] : [] });
  }
  if (day && !day.past) {
    const st = standingRows(day.league), sd = seatDays(day), rows = decisionRows(day.decisions, 200);
    const same = day.date === today;                      // the league's day is today's session: its results are today's, else none are
    for (const s of SEATS) {
      const x = sd.find(y => y.seat === s.id), r = st.find(y => y.seat === s.id);
      out.push({ key: 'league:' + s.id, name: s.family + ' seat (' + s.id + ')', kind: 'agent', source: 'league',
        status: 'Shadow league, ' + (!same ? 'its last session ' + (day.date || 'not known') : x ? x.line : 'not reported'),
        todayN: same && x ? x.n : 0, todayR: same && x ? x.todayR : null, r5: null, r20: null, n5: 0, n20: 0, comparable: false, week: r ? r.week : '', month: r ? r.month : '',
        pace: 'no backtest', cost: { league: true }, decision: r ? r.latency : 'not reported',
        trades: (same ? day.trades : []).filter(t => t.seat === s.id).map(t => ({ n: null, setup: '', side: t.side, root: 'MNQ', qty: t.contracts, entry: '', exit: '', why: t.exitReason, r: t.r, pnl: null })),
        log: same ? rows.filter(y => y.seat === s.id).map(y => ({ time: y.time, text: y.text })) : [] });
    }
  }
  return out;
}
/** Ranked: Today by today's R (none last); Multi-day by the last 20 days' R, the league's seats (R per trade, not comparable) after. */
function rankBoard(rows, view) {
  const by = (a, b, f) => { const x = f(a), y = f(b); if (x === null && y === null) return 0; if (x === null) return 1; if (y === null) return -1; return y - x; };
  const name = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return rows.slice().sort(view === 'multi'
    ? (a, b) => (a.comparable !== b.comparable ? (a.comparable ? -1 : 1) : by(a, b, x => x.r20) || name(a, b))
    : (a, b) => by(a, b, x => x.todayR) || name(a, b));
}

/** The charts whose switch is on, from this browser's copy (never throws). */
function cleanGhosts(raw) {
  let v = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch (e) { v = null; } }
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const k of Object.keys(v)) if (v[k] === true && k.length <= 64) out[k] = true;
  return out;
}

return { cleanBoard, paceWord, boardRows, rankBoard, BOARD_EARLY, SHADOW, SEATS, SEAT, ROOTS, GHOST_KEY, watchRows, WATCH_LATER, sessionToday, sessionOfBar, checkDay, pastEmpty, emptyText, cleanDay, cleanTrade, marksFor, barIndex, decisionRows, seatDays, standingRows, spendText, cleanGhosts };
});

/* ======================================================================== the overlay and the view (browser only) */
if (typeof window !== 'undefined' && typeof document !== 'undefined') (function () {
'use strict';
const C = window.LeagueCore;
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AXIS_W = 78;                          // the chart's own price axis width (chart-engine's default axisWidth)

/**
 * The league's marks over one chart (a ChartLive pane: { chart, ... } in `host`, the element that holds the chart's canvas).
 * get() returns the cleaned day, or null; root() the chart's instrument. faint: the ⋯ switch's look (fainter, smaller).
 * Returns { redraw, destroy }. Drawn after each frame the chart draws; nothing is drawn on the chart's own canvas.
 */
function attach(pane, host, get, root, faint) {
  const chart = pane && pane.chart;
  const base = host && host.querySelector('.ce-canvas');
  if (!chart || !base) return { redraw() {}, destroy() {} };
  const cv = document.createElement('canvas');
  cv.className = 'lg-overlay';
  cv.setAttribute('aria-hidden', 'true');
  cv.style.cssText = 'position:absolute;pointer-events:none;z-index:2;';
  base.parentElement.appendChild(cv);
  const ctx = cv.getContext('2d');
  function draw() {
    const dpr = window.devicePixelRatio || 1, w = base.clientWidth, h = base.clientHeight;
    if (cv.style.left !== base.offsetLeft + 'px') { cv.style.left = base.offsetLeft + 'px'; cv.style.top = base.offsetTop + 'px'; }
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const day = get();
    if (!day) return;
    /* 1.47.0 (the reuse map: Legion Live marks each lane's trades as this tab marks its traders): get() may instead return
       { kind: 'marks', marks: [{ kind 'entry'|'exit', t (chart seconds), price, color, letter }], lines: [{ kind 'stop'|'target',
       t0, t1 (or null: to the right edge), price, color }] }. Each is checked here: a colour is a #hex or rgb()/rgba() value, a
       letter one or two letters or digits, times and prices finite numbers; anything else is left out, never drawn. A league
       day is drawn exactly as before. */
    const COL = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9., ]{5,40}\))$/, LET = /^[A-Za-z0-9]{1,2}$/, fin = v => typeof v === 'number' && isFinite(v);
    const m = day.kind === 'marks' ? {
      marks: (Array.isArray(day.marks) ? day.marks : []).filter(k => k && (k.kind === 'entry' || k.kind === 'exit') && fin(k.t) && fin(k.price) && COL.test(String(k.color)) && LET.test(String(k.letter))).slice(0, 2000),
      lines: (Array.isArray(day.lines) ? day.lines : []).filter(l => l && (l.kind === 'stop' || l.kind === 'target') && fin(l.t0) && (l.t1 === null || fin(l.t1)) && fin(l.price) && COL.test(String(l.color))).slice(0, 2000),
    } : C.marksFor(day, root());
    if (!m.marks.length && !m.lines.length) return;
    const bars = chart.bars();
    if (!bars || !bars.length) return;
    const plotW = w - AXIS_W, ps = chart.priceScale(), plotH = ps && isFinite(ps.plotHeight) ? ps.plotHeight : h;
    const xAt = t => { const i = C.barIndex(bars, t); return i < 0 ? null : chart.barToX(i); };
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, plotW, plotH); ctx.clip();
    ctx.globalAlpha = faint ? 0.3 : 0.5;
    ctx.lineWidth = 1;
    for (const l of m.lines) {
      const x0 = xAt(l.t0), x1 = l.t1 === null ? plotW : xAt(l.t1), y = chart.priceToY(l.price);
      if (x0 === null || x1 === null || !isFinite(y)) continue;
      ctx.strokeStyle = l.color;
      ctx.setLineDash(l.kind === 'stop' ? [4, 3] : [1, 3]);
      ctx.beginPath(); ctx.moveTo(Math.round(x0) + 0.5, Math.round(y) + 0.5); ctx.lineTo(Math.round(x1) + 0.5, Math.round(y) + 0.5); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = faint ? 0.55 : 1;
    const r = faint ? 6 : 8;
    ctx.font = '600 ' + (faint ? 8 : 10) + 'px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const k of m.marks) {
      const x = xAt(k.t), y = chart.priceToY(k.price);
      if (x === null || !isFinite(y)) continue;
      ctx.strokeStyle = k.color; ctx.fillStyle = k.color; ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (k.kind === 'entry') ctx.arc(x, y, r, 0, Math.PI * 2);
      else { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
      ctx.stroke();                                           // hollow: the candle under it stays in sight
      ctx.fillText(k.letter, x, y + 0.5);
    }
    ctx.restore();
  }
  const off = chart.on('drawn', draw);
  draw();
  return { redraw: () => { chart.redraw(); draw(); }, destroy: () => { try { off(); } catch (e) { /* gone */ } cv.remove(); } };
}

/**
 * The League tab. o: { view (its section), tab (the top bar's button), feed (the window's ChartFeed), storagePrefix, deskBase()
 * (a promise of The Desk's address), fetch, onTab(on), onDay(day or null: the past day shown, for the page's address), today()
 * (optional: New York's date, for the tests) }. Returns { showTab, openDay, shown, state, day, liveDay, destroy }.
 */
function create(o) {
  const view = o.view, tabBtn = o.tab;
  const S = { shown: false, day: null, raw: null, problem: 'Not read yet.', reach: '', at: 0, timer: 0, root: 'NQ', busy: false,
    past: null, dayProblem: '', seq: 0,
    board: null, boardWhy: 'Not read yet.', boardView: 'today', boardOpen: new Set(), boardBusy: false };   // 1.57.0: the leaderboard   // past: the past session date shown (read only), or null (the live day); dayProblem: a link's bad day, said   // 1.38.1: NQ 1 min (Anthony 2026-10-23), the league trades MNQ
  const q = s => view.querySelector(s);
  /* the watch (1.50.0): ChartBridge's own messages, read only. W is forgotten when the connection drops */
  const W = { connected: false, version: '', agents: new Map(), accounts: null };
  const watchLink = o.watch && typeof o.watch.listen === 'function' ? o.watch : null;
  view.innerHTML =
    '<div class="lg-wrap">' +
      '<header class="lg-top"><h1 class="lg-word">Colosseum</h1><span class="lg-sub">Research on the live market. Nothing here sends an order or changes a trader\'s mode.</span></header>' +
      '<header class="lg-head">' +
        '<span class="lg-title">Shadow league</span><span class="lg-shadow">' + esc(C.SHADOW) + '</span>' +
        '<span class="lg-legend" aria-label="The seats">' + C.SEATS.map(s => '<span class="lg-key" style="--seat:' + s.color + '"><i aria-hidden="true">' + s.id + '</i>' + s.family + '</span>').join('') + '</span>' +
        '<span class="lg-past" data-k="past" hidden></span><button type="button" class="ws-btn lg-today" data-k="today" hidden>Back to today</button>' +
        '<span class="lg-fill"></span><span class="lg-when" data-k="when" role="status"></span>' +
      '</header>' +
      '<section class="lg-board" aria-label="Leaderboard"><div class="lg-bhead"><span class="lg-title">Leaderboard</span>' +
        '<span class="lg-mut">Every bot and agent that traded lately, ranked. <span class="lg-who" data-who="bot">BOT</span> fixed rules, <span class="lg-who" data-who="agent">AGENT</span> an AI trader.</span><span class="lg-fill"></span>' +
        '<span class="ws-seg lg-bview" role="group" aria-label="Rank by"><button type="button" data-do="bview" data-view="today" aria-pressed="true">Today</button><button type="button" data-do="bview" data-view="multi" aria-pressed="false">Multi-day</button></span></div>' +
        '<p class="lg-mut lg-bsaid" data-k="bsaid" role="status"></p>' +
        '<div class="lg-bscroll"><table class="lg-btable"><thead><tr><th>#</th><th>Name</th><th>Status</th><th>Today</th><th>Last 5 days</th><th>Last 20 days</th><th>Projected</th><th>API cost</th><th>Decision time</th></tr></thead><tbody data-k="board"></tbody></table></div>' +
        '<p class="lg-mut lg-bnote">R per day from The Desk\'s trading days; the league\'s seats keep R per trade (week and month means), shown as that and ranked after on Multi-day. Projected is each bot\'s backtest pace for its days: none is on the roster cards yet. Click a row for its trades of the day.</p></section>' +
      '<p class="lg-problem" data-k="problem" role="status" hidden></p>' +
      /* 1.57.0 (Anthony 2026-11-13: the league's chart is not necessary): no chart; the watch, the seats and the log side by side */
      '<div class="lg-main lg-side" aria-label="The seats today and the watch">' +
        '<section class="lg-watch" aria-label="The watch"><div class="lg-loghead">The watch: in Shadow on the agent channel now</div><div data-k="watch"></div><p class="lg-mut lg-later">' + esc(C.WATCH_LATER) + '</p></section>' +
        '<section class="lg-seatbox" aria-label="The seats">' +
          '<div class="lg-seats" data-k="seats"></div>' +
          '<div class="lg-spend" data-k="spend"></div>' +
          '<table class="lg-table" aria-label="Week and month"><thead><tr><th>Seat</th><th>Week</th><th>Month</th><th>With you</th><th>Decision time</th></tr></thead><tbody data-k="table"></tbody></table>' +
        '</section>' +
        '<section class="lg-logbox" aria-label="Decision log"><div class="lg-loghead">Decision log</div><ol class="lg-log" data-k="log"></ol></section>' +
      '</div>' +
    '</div>';

  /* 1.57.0: the leaderboard's read, beside the league's (its own error, never the league's); the live day only */
  function pollBoard() {
    if (S.boardBusy) return;
    if (S.past) { S.board = null; S.boardWhy = 'The leaderboard shows the live day only.'; return; }
    S.boardBusy = true;
    Promise.resolve().then(() => o.deskBase()).then(url => o.fetch(url + '/api/chart-colosseum', { cache: 'no-store', mode: 'cors', credentials: 'omit' }))
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? 'The Desk has no leaderboard yet (it needs The Desk of this release).' : 'The Desk answered ' + r.status + ' for the leaderboard.'))))
      .then(j => { const b = C.cleanBoard(j); S.board = b.ok ? b : null; S.boardWhy = b.ok ? '' : b.why; }, e => { S.board = null; S.boardWhy = e && e.message && /^The Desk/.test(e.message) ? e.message : 'The Desk is not reachable for the leaderboard.'; })
      .then(() => { S.boardBusy = false; if (S.shown) renderBoard(); });
  }
  function poll() {
    clearTimeout(S.timer);
    pollBoard();
    if (S.busy) return;
    S.busy = true;
    const seq = S.seq, past = S.past;                     // a read started for one day never lands on another (Back to today, a new link)
    const path = '/api/chart-league' + (past ? '?date=' + encodeURIComponent(past) : '');
    Promise.resolve().then(() => o.deskBase()).then(url => o.fetch(url + path, { cache: 'no-store', mode: 'cors', credentials: 'omit' }))
      .then(r => (r.ok ? r.json() : r.json().then(j => Promise.reject(new Error('The Desk answered ' + r.status + (j && j.detail ? ': ' + j.detail : ''))), () => Promise.reject(new Error('The Desk answered ' + r.status)))))
      .then(j => {
        if (seq !== S.seq) return;
        const d = C.cleanDay(j, !!past);
        /* a Desk that answered another day than the one asked (one that does not take ?date=): nothing of it is shown as that day */
        /* review LOW 2: and an answer with no date at all (no folder, no session): its own problem, or said, never shown as the day */
        if (past && d.date !== past) {
          S.raw = null; S.day = null; S.reach = 'ok';
          S.problem = d.date ? 'The Desk sent the day ' + d.date + ', not ' + past + ': opening a past day needs a Desk that reads ?date=.' : (d.problem || 'The Desk sent no day for ' + past + '.');
          return;
        }
        S.raw = j; S.day = d; S.problem = d.problem; S.reach = 'ok'; S.at = Date.now();
      },
        e => { if (seq !== S.seq) return; S.reach = 'down'; S.problem = (e && /answered 404/.test(e.message) ? 'The Desk has no league view yet (it needs The Desk of this release).' : 'The Desk is not reachable: ' + (e && e.message ? e.message : 'no answer')) + (S.day ? ' Showing what it last sent.' : ''); })
      .then(() => { if (seq !== S.seq) return; S.busy = false; render(); if (S.shown) S.timer = setTimeout(poll, 15000); });
  }
  /* the day shown: a past session date (read only) or null (the live day). A change drops what was read for the other day at once */
  function setPast(day) {
    day = day || null;
    if (day === S.past) return false;
    S.past = day; S.seq++; S.busy = false; S.day = null; S.raw = null; S.problem = 'Not read yet.'; S.reach = ''; clearTimeout(S.timer);
    if (typeof o.onDay === 'function') o.onDay(day);
    return true;
  }
  const today = () => (typeof o.today === 'function' ? o.today() : C.sessionToday());   // review LOW 1: the league's session date
  const setHtml = (el, html) => { if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } };
  function render() {
    const d = S.day, past = S.past;
    const p = q('[data-k="problem"]');
    const empty = past && d && !S.problem && C.pastEmpty(d) ? C.emptyText(past) : '';
    const said = [S.dayProblem, S.problem, empty].filter(Boolean).join(' ');
    p.hidden = !said; p.textContent = said;
    const pastEl = q('[data-k="past"]');
    pastEl.hidden = !past; pastEl.textContent = past ? 'Past day ' + past + ' · read only' : '';
    q('[data-k="today"]').hidden = !past;
    const st = d && d.status;
    q('[data-k="when"]').textContent = past ? (d && d.day && d.day.closed ? 'day closed' : '') : d && d.date ? d.date + (st && st.now ? ' · ' + st.now + ' ET' : '') + (st && st.feed ? ' · feed ' + st.feed : '') + (d.day && d.day.closed ? ' · day closed, recording to 17:00' : '') : '';
    q('[data-k="when"]').title = !past && d && d.day && d.day.note ? d.day.note : '';
    setHtml(q('[data-k="seats"]'), C.seatDays(d).map(s => '<div class="lg-seat" style="--seat:' + s.color + '" data-seat="' + s.seat + '"><i class="lg-letter" aria-hidden="true">' + s.seat + '</i>' +
      '<div class="lg-sbody"><div class="lg-sname">' + esc(s.family) + ' <span class="lg-mut">' + esc(s.line) + '</span></div>' +
      '<div class="lg-mut mono">' + (s.account ? esc(s.account) + ' · ' : '') + (s.n ? (past ? 'that day ' : 'today ') + esc((s.todayR >= 0 ? '+' : '') + s.todayR.toFixed(2)) + ' R (n ' + s.n + ')' : past ? 'no closed trade that day' : 'no closed trade today') +
      (s.decisions !== null ? ' · ' + s.decisions + ' looks' : '') + '</div>' + (s.flag ? '<div class="lg-flag">Flag for you: ' + esc(s.flag) + '</div>' : '') + '</div></div>').join(''));
    const sp = C.spendText((st && st.spend) || (d && d.league && d.league.spend));
    setHtml(q('[data-k="spend"]'), past ? '<span class="lg-mut">API spend: the live spend is not kept per day here (each day\'s spend is on The Desk\'s Agent Stats).</span>'
      : '<span class="lg-mut">API spend</span> <span class="mono">' + esc(sp.day) + ' today · ' + esc(sp.month) + ' this month</span>' + (sp.stopped ? '<div class="lg-warn">' + esc(sp.stopped) + '</div>' : ''));
    q('.lg-table').setAttribute('aria-label', past ? 'Week and month as of now (not as of the past day)' : 'Week and month');
    q('.lg-table thead th').textContent = past ? 'Seat (as of now)' : 'Seat';
    setHtml(q('[data-k="table"]'), C.standingRows(d && d.league).map(r => '<tr><td><i class="lg-letter sm" style="--seat:' + r.color + '">' + r.seat + '</i></td><td>' + esc(r.week) + '</td><td>' + esc(r.month) + '</td><td>' + esc(r.agreement) + '</td><td>' + esc(r.latency) + '</td></tr>').join(''));
    const rows = C.decisionRows(d && d.decisions, 80);
    renderWatch();
    renderBoard();
    setHtml(q('[data-k="log"]'), rows.length ? rows.map(r => '<li class="lg-row k-' + r.kind + '"><span class="mono">' + esc(r.time) + '</span><i class="lg-letter sm" style="--seat:' + C.SEAT[r.seat].color + '">' + r.seat + '</i><span class="lg-text" title="' + esc(r.text + (r.trigger ? ' (look: ' + r.trigger + ')' : '') + (r.latency !== null ? ', ' + r.latency + ' s' : '')) + '">' + esc(r.text) + '</span>' + (r.latency !== null ? '<span class="lg-mut mono">' + esc(r.latency) + ' s</span>' : '') + '</li>').join('') : (past ? '<li class="lg-mut">No decision that day.</li>' : '<li class="lg-mut">No decision yet today.</li>'));
  }
  function renderBoard() {
    for (const b of view.querySelectorAll('[data-do="bview"]')) b.setAttribute('aria-pressed', String(b.dataset.view === S.boardView));
    const rows = C.rankBoard(C.boardRows(S.board, S.past ? null : S.day, today()), S.boardView);
    q('[data-k="bsaid"]').textContent = S.boardWhy || (S.board && !S.board.programs.length ? 'No bot or agent posted a trading day to The Desk lately.' : '');
    const R = v => (v === null ? '<span class="lg-mut">none</span>' : '<span class="lg-r' + (v > 0 ? ' up' : v < 0 ? ' down' : '') + '">' + esc((v >= 0 ? '+' : '') + v.toFixed(2)) + ' R</span>');
    const usd = v => (v === null || v === undefined ? 'not reported' : '$' + v.toFixed(2));
    const cost = r => (!r.cost ? '' : r.cost.league ? 'the league\'s, below' : usd(r.cost.today) + ' today, ' + usd(r.cost.month) + ' month' + (r.cost.perTrade !== null ? ', ' + usd(r.cost.perTrade) + ' a trade' : ''));
    const html = rows.map((r, i) => {
      const open = S.boardOpen.has(r.key);
      const multi5 = r.comparable ? R(r.r5) + (r.n5 ? ' <span class="lg-mut">(' + r.n5 + ' d)</span>' : '') : '<span class="lg-mut">week ' + esc(r.week) + '</span>';
      const multi20 = r.comparable ? R(r.r20) + (r.n20 ? ' <span class="lg-mut">(' + r.n20 + ' d)</span>' : '') : '<span class="lg-mut">month ' + esc(r.month) + '</span>';
      const row = '<tr class="lg-brow" data-key="' + esc(r.key) + '" data-kind="' + r.kind + '"><td class="mono">' + (i + 1) + '</td>' +
        '<td><button type="button" class="lg-bname" data-do="brow" data-key="' + esc(r.key) + '" aria-expanded="' + open + '">' + esc(r.name) + '</button> <span class="lg-who" data-who="' + r.kind + '">' + (r.kind === 'bot' ? 'BOT' : 'AGENT') + '</span></td>' +
        '<td>' + esc(r.status) + '</td><td>' + (r.todayN ? r.todayN + ' trade' + (r.todayN === 1 ? '' : 's') + ', ' : '') + R(r.todayR) + '</td><td>' + multi5 + '</td><td>' + multi20 + '</td>' +
        '<td>' + esc(r.pace) + '</td><td>' + esc(cost(r)) + '</td><td>' + esc(r.decision) + '</td></tr>';
      if (!open) return row;
      const trades = r.trades.length ? '<ul class="lg-btrades">' + r.trades.map(t => '<li class="mono">' + esc([t.n !== null ? '#' + t.n : '', t.side, t.qty !== null ? t.qty + ' ' + t.root : t.root, t.entry && t.exit ? t.entry + ' to ' + t.exit : '', t.why, t.setup].filter(Boolean).join(' · ')) + ' ' + R(t.r) + '</li>').join('') + '</ul>'
        : '<p class="lg-mut">No trade today.</p>';
      const log = r.kind === 'agent' ? '<details class="lg-blog"><summary>Thoughts (' + r.log.length + ')</summary>' + (r.log.length ? '<ol>' + r.log.map(l => '<li>' + (l.time ? '<span class="mono">' + esc(l.time) + '</span> ' : '') + esc(l.text) + '</li>').join('') + '</ol>' : '<p class="lg-mut">None today.</p>') + '</details>' : '';
      return row + '<tr class="lg-bdetail" data-key="' + esc(r.key) + '"><td></td><td colspan="8">' + trades + log + '</td></tr>';
    }).join('');
    setHtml(q('[data-k="board"]'), html || '<tr><td colspan="9" class="lg-mut">Nothing to rank yet.</td></tr>');
  }
  function renderWatch() {
    const el = q('[data-k="watch"]');
    if (!watchLink) { setHtml(el, '<p class="lg-mut">ChartBridge\'s list of traders is not on this page (no ChartBridge connection here).</p>'); return; }
    if (!W.connected) { setHtml(el, '<p class="lg-mut">ChartBridge is not connected: its traders are not known now.</p>'); return; }
    if (!window.FleetCore || typeof window.FleetCore.traders !== 'function') { setHtml(el, '<p class="lg-mut">The page\'s trader list (fleet.js) is not served here.</p>'); return; }
    const rows = C.watchRows(window.FleetCore.traders([...W.agents.values()], W.accounts, W.version));
    setHtml(el, rows.length ? '<ul class="lg-wlist">' + rows.map(r => '<li class="lg-wrow" data-id="' + esc(r.id) + '"><div class="lg-sname">' + esc(r.name) + (r.build ? ' <span class="lg-mut">' + esc(r.build) + '</span>' : '') + '</div>' +
      '<div class="lg-mut">' + esc(r.status) + ' · ' + esc(r.place) + (r.trades !== null ? ' · ' + r.trades + ' trades today' : '') + '</div></li>').join('') + '</ul>'
      : '<p class="lg-mut">No trader on the agent channel is in Shadow now.</p>');
  }
  function onWatch(m) {
    switch (m && m.type) {
      case 'hello': W.connected = true; W.version = typeof m.version === 'string' ? m.version : ''; break;
      case 'accounts': W.accounts = m; break;
      case 'agent': if (typeof m.agent === 'string') W.agents.set(m.agent, m); break;
      default: return;
    }
    if (S.shown) renderWatch();
  }
  function watchLost() { W.connected = false; W.version = ''; W.agents.clear(); W.accounts = null; if (S.shown) renderWatch(); }
  const unwatch = watchLink ? watchLink.listen({ message: onWatch, closed: watchLost }) : () => {};
  function showTab(on) {
    on = !!on;
    if (on === S.shown) return;
    S.shown = on;
    if (tabBtn) { tabBtn.setAttribute('aria-pressed', String(on)); if (on) tabBtn.hidden = false; }
    if (typeof o.onTab === 'function') o.onTab(on);
    if (on) poll(); else { clearTimeout(S.timer); if (S.past) setPast(null); S.dayProblem = ''; }   // closed: the next open is the live day
    render();
  }
  /* the page's address asked for a day (?tab=league&day=YYYY-MM-DD): checked first; a past day opens read only, today or no day the
     live view, and a bad day is said plainly over the live view (never a guess at what was meant) */
  function openDay(raw) {
    const c = C.checkDay(raw, today());
    S.dayProblem = c.problem;
    const changed = setPast(c.day);
    if (!S.shown) showTab(true);
    else { if (changed) poll(); render(); }
    return c;
  }
  /* the tab is offered once The Desk answers GET /api/chart-league (a Desk of this release, reachable from this PC), asked at the
     start and every 5 minutes; with no such Desk the top bar keeps its room (the trading controls never give way to it) */
  S.offered = false;
  function probe() {
    Promise.resolve().then(() => o.deskBase()).then(url => o.fetch(url + '/api/chart-league', { cache: 'no-store', mode: 'cors', credentials: 'omit' }))
      .then(r => r.ok, () => false).then(ok => { S.offered = ok; if (tabBtn) tabBtn.hidden = !(ok || S.shown); if (typeof o.onOffered === 'function') o.onOffered(ok); });
  }
  if (tabBtn) { tabBtn.hidden = true; tabBtn.addEventListener('click', e => { tabBtn.blur(); showTab(!S.shown); }); }
  /* 1.57.0: the leaderboard's two views and its rows: display only, nothing is sent */
  q('.lg-board').addEventListener('click', e => {
    const b = e.target && e.target.closest ? e.target.closest('button[data-do]') : null;
    if (!b) return;
    if (b.dataset.do === 'bview' && (b.dataset.view === 'today' || b.dataset.view === 'multi')) { S.boardView = b.dataset.view; renderBoard(); }
    else if (b.dataset.do === 'brow') { const k = String(b.dataset.key || ''); if (S.boardOpen.has(k)) S.boardOpen.delete(k); else S.boardOpen.add(k); renderBoard(); }
  });
  q('[data-k="today"]').addEventListener('click', () => { S.dayProblem = ''; if (setPast(null)) poll(); render(); });
  probe();
  const probeTimer = setInterval(probe, 300000);
  render();
  return {
    showTab, openDay, shown: () => S.shown, poll, offered: () => S.offered,
    /* read only, for the tests and the console */
    state: () => ({ board: { view: S.boardView, why: S.boardWhy, programs: S.board ? S.board.programs.length : 0, open: [...S.boardOpen] }, shown: S.shown, past: S.past, dayProblem: S.dayProblem, empty: !!(S.past && S.day && C.pastEmpty(S.day)), problem: S.problem, reach: S.reach, date: S.day ? S.day.date : '', trades: S.day ? S.day.trades.length : 0, open: S.day ? S.day.open.length : 0,
      decisions: S.day ? S.day.decisions.length : 0, chart: false, marks: S.day ? C.marksFor(S.day, S.root).marks.length : 0,   // 1.57.0: no chart on the tab; marks: what a chart's faint switch would draw
      watch: { linked: !!watchLink, connected: W.connected, traders: W.agents.size, rows: window.FleetCore && typeof window.FleetCore.traders === 'function' ? C.watchRows(window.FleetCore.traders([...W.agents.values()], W.accounts, W.version)).map(r => r.id) : [] } }),
    day: () => S.day,
    /* the live day only (null while a past day is shown): what the faint marks and the Agents strip may use */
    liveDay: () => (S.past ? null : S.day),
    destroy() { clearTimeout(S.timer); clearInterval(probeTimer); try { unwatch(); } catch (e) { /* gone */ } },
  };
}

window.LeagueOverlay = { attach };
window.LeagueView = { create };
})();
