'use strict';
// Made-up answers of The Desk's reads for the Ludus (plan step 3.4): test/ludus.test.js and test/ludus-smoke.mjs. SAMPLE DATA
// ONLY: no build, run, account, price, bar or number here is real. The dates are in 2001 so none can be a locked day.
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const SPEC_A = '1'.repeat(64), SPEC_B = '2'.repeat(64), SPEC_C = '3'.repeat(64);
const ACCT50 = { size: '50K', daily_loss_limit: true, cost_dollars: 150 };
const ACCT25 = { size: '25K', daily_loss_limit: true, cost_dollars: 110 };
const sim = {};

function prop(ppd, o) {
  const x = o || {};
  const p = { setting: 'default setting', unit: 'profit per $1 spent on accounts', verdict: 'not confident', sim,
    sample: x.sample || { trades: 210, days_with_a_trade: 120, sessions: 143 }, account: x.account || ACCT50 };
  if (ppd === null) return Object.assign(p, { verdict: 'not enough data yet' });
  Object.assign(p, { profit_per_dollar: ppd, range95: [ppd - 0.5, ppd + 0.6], no_edge: { p5: -0.4, median: 0.05, p95: x.p95 === undefined ? 0.4 : x.p95 },
    above_no_edge: ppd > (x.p95 === undefined ? 0.4 : x.p95), mean_r: 0.11,
    eval: { pass_share: x.pass === undefined ? 0.61 : x.pass, sessions_to_pass: x.toPass === undefined ? 12 : x.toPass },
    funded: { paid_per_funded: x.paid === undefined ? 1240 : x.paid, share_paid: 0.48, sessions_to_first_payout: 21 } });
  if (x.older) delete p.mean_r; else p.no_edge_line = 'resampled';
  return p;
}
function run(id, kind, family, spec, p, extra) {
  return Object.assign({ run_id: id, source: 'screen', kind, repeat_of: null, engineering: false, counts_as_try: kind === 'try', counts_as_evidence: kind === 'try',
    status: 'finished', started_day_utc: '2001-03-01', family, spec_sha256: spec, name: family + '_v1', version: 1, instrument: 'MNQ', time_frame: 'm1',
    exit_mode: 'bracket', data_bound: true, direction: 'both', days: { run: 143, asked: 143, in_reserved_weeks: 0 }, trades: p.sample.trades, exits: {}, dollars: 1000,
    per_trade: { trades: p.sample.trades, mean_r: 0.11 }, try_in_its_family: 1, prop: p, no_edge_line: p.no_edge_line || (p.profit_per_dollar !== undefined ? 'reordered' : null),
    prop_taken_from_the_same_run: false, zones: { state: 'not labelled yet' } }, extra || {});
}
const half = (ppd, above) => ({ sessions: 50, trades: 70, days_with_a_trade: 40, verdict: above ? 'beats its no-edge line' : 'does not beat its no-edge line',
  profit_per_dollar: ppd, no_edge: { p5: -0.3, median: 0.05, p95: 0.35 }, above_no_edge: above });
const LINE_A = { setting: 'default setting', tuned_share: 0.7, tuned: { sessions: 100, trades: 150, days_with_a_trade: 80 }, untuned: { sessions: 43 },
  floor: { share: 0.7, met: true }, halves: [half(0.9, true), half(0.7, true)], halves_why: null };
const LINE_C = { setting: 'default setting', tuned_share: 0.7, tuned: { sessions: 100, trades: 90, days_with_a_trade: 55 }, untuned: { sessions: 43 },
  floor: { share: 0.7, met: false }, halves: null, halves_why: 'floor' };

const RUNS_A = [
  run('run-a1', 'try', 'samplea', SPEC_A, prop(2.0, { older: true })),                                     // an older figure: never the best try
  run('run-a2', 'try', 'samplea', SPEC_A, prop(0.82), { line: LINE_A }),                                   // the best try
  run('run-a3', 'repeat', 'samplea', SPEC_A, prop(3.0)),                                                   // a repeat: never the best try
  run('run-a4', 'try', 'samplea', SPEC_A, prop(0.35, { account: ACCT25, pass: 0.4, toPass: 15, paid: 900 })),
];
const RUNS_B = [run('run-b1', 'try', 'sampleb', SPEC_B, prop(null, { sample: { trades: 12, days_with_a_trade: 9, sessions: 40 } }))];
const RUNS_C = [run('run-c1', 'try', 'samplec', SPEC_C, prop(0.3, { p95: 0.5 }), { line: LINE_C })];

const cand = (id, name, runs) => ({ id, pieces: [], tag: 'sample', choice: null, aliases: { names: [name], families: [runs[0].family], versions: [], spec_sha256: [runs[0].spec_sha256] },
  counts: { try: runs.filter(r => r.kind === 'try').length, repeat: runs.filter(r => r.kind === 'repeat').length, engineering: 0 }, runs, best_try: null, best_older_figure: null,
  line: id === A ? { floor_met: true, halves: ['beats its no-edge line', 'beats its no-edge line'], both_halves_beat: true, joins: true, why: [], untuned_sessions: 43, to_proof: true, why_not_to_proof: null, in_the_line: 1, run_id: 'run-a2' }
    : id === C ? { floor_met: false, halves: null, both_halves_beat: false, joins: false, why: ['trades on fewer than 70% of its tuned sessions (the floor)'], untuned_sessions: 43, to_proof: true, why_not_to_proof: null, in_the_line: null, run_id: 'run-c1' } : null });

const BOARD = {
  schema: 'loop.board/1', made_utc: '2001-03-02T06:00:00Z', in_sample: true, note: 'every number here is in-sample',
  ledger: { rows: 6, candidates: 3, cut_off_runs: 0 },
  zones: { state: 'not labelled yet', versions: [], cuts_file: null },
  stations: {
    screen: [A, C, B], line: [A],
    review: { candidates: [{ candidate: A, night: '2001-03-01', run_id: 'run-a2', margin: 0.42, verdict: null }], note: 'waiting on Tier 2', a_night: 3 },
    proof: { candidates: [], weeks: 4, note: null, rule: { proved: '30 trades or more on 10 reserved days or more with a trade, mean R after costs above 0 (law 9.1)' } },
    shadow: { candidates: [], note: '' },
    your_review: { candidates: [], note: null, decided: {} },
    roster: { approved_by_anthony: [], placed_for_the_legion_build: [{ bot: 'sample_a_v1', label: 'in-sample, not proven, not approved', candidate: A, spec_sha256: SPEC_A }] },
  },
  line: { size: 30, note: 'the line of the best 30: a build joins when it trades on at least 70% of its tuned sessions and beats its no-edge line on both halves of its tuned days (law 8.4). In-sample: nothing in the line is proven',
    ranked_by: 'held and ranked at the default setting on the tuned days', floor: 0.7, tuned_share: 0.7, min_untuned_sessions_for_proof: 40,
    entries: [{ candidate: A, run_id: 'run-a2', profit_per_dollar: 0.82, no_edge_p95: 0.4, no_edge_line: 'resampled', setting: 'default setting',
      sample: { trades: 210, days_with_a_trade: 120, sessions: 143 }, halves: [{ sessions: 50, trades: 70, days_with_a_trade: 40, profit_per_dollar: 0.9, no_edge_p95: 0.35 }, { sessions: 50, trades: 70, days_with_a_trade: 40, profit_per_dollar: 0.7, no_edge_p95: 0.35 }],
      untuned_sessions: 43, to_proof: true, why_not_to_proof: null, rank: 1 }],
    counts: { candidates: 3, held: 2, joins: 1, in_the_line: 1, beyond_the_line: 0 } },
  candidates: { [A]: cand(A, 'samplea_v1', RUNS_A), [C]: cand(C, 'samplec_v1', RUNS_C), [B]: cand(B, 'sampleb_v1', RUNS_B) },
  by_piece: {}, by_zone: {},
  library: { sha256: 'f'.repeat(64), slots: [{ slot: 'window', options: [{ index: 0, words: 'the first hour (sample)', pieces: [] }, { index: 1, words: 'the afternoon (sample)', pieces: [] }] },
    { slot: 'location', options: [{ index: 0, words: 'the prior day low (sample)', pieces: [] }] }], not_together: [] },
  builder: [{ id: 'b_0000000000000001', state: 'ran', why: null, candidate: C, night: '2001-03-01' }, { id: 'b_0000000000000002', state: 'refused', why: 'already tried (sample)', candidate: null, night: '2001-03-01' }],
  builder_builds: 3,
  nights: [{ night: '2001-03-01', asked: 10, made: 9, neighbours: 2, new: 7, skipped_as_already_tried: 1, library_sha256: 'f'.repeat(64), report: null }],
  forward: { state: 'not read', specs: [] },
};
const boardAnswer = () => ({ ok: true, problem: null, folder: { set: true, ok: true }, in_sample: true, note: 'every number here is in-sample', board: BOARD });
const ledgerAnswer = () => ({ ok: true, problem: null, folder: { set: true, ok: true }, in_sample: true, note: 'in-sample', piece: null, zone: null,
  runs: [].concat(RUNS_A.map(r => Object.assign({}, r, { candidate: A })), RUNS_C.map(r => Object.assign({}, r, { candidate: C })), RUNS_B.map(r => Object.assign({}, r, { candidate: B }))) });

const ROSTER_A = { format: 'specrunner.roster/1', bot: 'sample_a_v1', spec: { file: 'sample_a.json', sha256: SPEC_A }, runs_live: true, why_not: null,
  record: { run_id: 'run-a2', family: 'samplea', try: 1, sessions: 143, trades: 210, instrument: 'MNQ', verdict: 'sample' }, plan: { size: '50K', dll: true },
  playbook: { eval: { risk_dollars: 200, daily_loss_stop: 500, daily_profit_stop: null, max_trades: 3 }, funded: { risk_dollars: 150, daily_loss_stop: 400, daily_profit_stop: 600, max_trades: 2, payout_at: 1500 } },
  numbers: { eval: { profit_per_dollar: 1.1, range95: [0.2, 2.0], no_edge: { median: 0.1, p5: -0.3, p95: 0.4 }, no_edge_line: 'resampled', above_no_edge: true, not_searched_on: 0.7, eval_pass: 0.66, sessions_to_pass: 11 },
    funded: { profit_per_dollar: 0.9, range95: [0.1, 1.8], no_edge: { median: 0.1, p5: -0.3, p95: 0.5 }, no_edge_line: 'resampled', above_no_edge: true, not_searched_on: 0.6, paid_per_funded: 1310, share_paid: 0.52, sessions_to_first_payout: 19 } },
  other_settings: { eval: [], funded: [] }, counts: {} };
const rosterAnswer = () => ({ ok: true, problem: null, folder: { set: true, ok: true }, in_sample: true, note: 'in-sample',
  files: [
    { name: 'sample_lineup.json', ok: true, sha256: '4'.repeat(64), quick: false, board: null, roster: { format: 'specrunner.lineup/1', lineup: 'sample_lineup', bots: [{ spec: { sha256: SPEC_A } }] } },
    { name: 'sample_c_quick.json', ok: true, sha256: '5'.repeat(64), quick: true, board: null, roster: Object.assign({}, ROSTER_A, { bot: 'sample_c', spec: { file: 'c.json', sha256: SPEC_C } }) },
    { name: 'sample_a_v1.json', ok: true, sha256: '6'.repeat(64), quick: false, board: { group: 'placed_for_the_legion_build', label: 'placed', candidate: A }, roster: ROSTER_A },
    { name: 'broken.json', ok: false, why: 'not valid JSON' },
  ], left: 0 });

/* 45 made-up trades of build A, on made-up 2001 sessions; trade 1 has times and prices, the chart draws it */
const T0 = Date.UTC(2001, 1, 1, 14, 0, 0);              // 2001-02-01 09:00 New York
function trades() {
  const out = [];
  for (let i = 1; i <= 45; i++) {
    const day = 1 + Math.floor((i - 1) / 3), session = '2001-02-' + String(day).padStart(2, '0');
    const r = i % 3 === 0 ? -1 : i % 3 === 1 ? 1.5 : 0.5;
    const t = { n: i, session, side: i % 2 ? 'long' : 'short', r, pnl: r * 40, flags: i % 9 === 0 ? ['best day share (sample)'] : [] };
    if (i === 1) Object.assign(t, { entry_ms: T0, exit_ms: T0 + 25 * 60000, entry: 21000.25, exit: 21006.25, stop: 20996.25 });
    out.push(t);
  }
  return out;
}
function tradesAnswer(cid, show, page) {
  const all = trades();
  const g = { all, winners: all.filter(t => t.r > 0), losers: all.filter(t => t.r < 0), worth_a_look: all.filter(t => t.flags.length) };
  const chosen = g[show] || all, pages = Math.max(1, Math.ceil(chosen.length / 20));
  return { ok: true, problem: null, candidate: cid, placeholder: true, fence: { days: 'discovery', by: 'teststudio/fence.py', locked_weeks_counted: 3 },
    show, page, pages, per_page: 20, counts: { all: all.length, winners: g.winners.length, losers: g.losers.length, worth_a_look: g.worth_a_look.length },
    trades: chosen.slice((page - 1) * 20, page * 20) };
}
/* The Desk's GET /api/bars shape: one session's 1-minute bars, [t (UTC ms), o, h, l, c, v]; a made-up walk around the trade */
function barsAnswer(session) {
  const bars = [];
  if (session === '2001-02-01') {
    let p = 21000;
    for (let k = -90; k <= 60; k++) {
      const t = T0 + k * 60000, o = p, step = (k >= 0 && k < 25 ? 0.25 : ((((k % 7) + 7) % 7) - 3) * 0.25);
      p = Math.round((p + step) * 4) / 4;
      bars.push([t, o, Math.max(o, p) + 0.75, Math.min(o, p) - 0.75, p, 100 + (k % 13) * 10]);
    }
  }
  return { root: 'MNQ', session, asked: null, contract: bars.length ? 'MNQ 03-01' : null, partner: false, contracts: [], stamp: 'open', time: 'utc_ms', bars };
}
const labAnswer = () => ({ objectives: [], competitors: [], needs: [], records: [], records_total: 0, routes: [], routes_closed: [], route_tally: 0,
  agents_ratings: { available: true, note: null, builds: [] },
  seeds: [{ id: 1, name: 'Sample seed', size: 'H', path: { kind: 'fresh' }, made_at: 981036000000, state: 'waiting', settled_at: null, agent_id: null, refused: null },
    { id: 2, name: 'Sample fork', size: 'H', path: { kind: 'fork', source_seat: 'S', source_notebook_sha256: '7'.repeat(64) }, made_at: 981036000000, state: 'refused', settled_at: 1, agent_id: null, refused: 'sample reason' }] });
const helperStatus = () => ({ agents: {}, builds: [{ build: 'sample-a', hero: 'Sample Hero A', tier: 'Good', examEdge: 0.12, liveEdge: 0.08, liveN: 40 }, { build: 'sample-c', hero: null }] });

module.exports = { A, B, C, SPEC_A, SPEC_B, SPEC_C, ACCT50, ACCT25, BOARD, RUNS_A, RUNS_B, RUNS_C, ROSTER_A, T0,
  boardAnswer, ledgerAnswer, rosterAnswer, tradesAnswer, barsAnswer, labAnswer, helperStatus, trades };
