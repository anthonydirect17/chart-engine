'use strict';
// Made-up answers of The Desk's Legion reads for Castra and the cohort model (plan step 3.3): test/legion-castra.test.js and
// test/legion-castra-smoke.mjs. SAMPLE DATA ONLY: no build, account, firm, PC, dollar or percent here is real. It builds on the
// Ludus's made-up roster and board (test/fixtures/ludus-sample.js), so the two tabs read one made-up world.
const LS = require('./ludus-sample.js');
const SHA_A = '6'.repeat(64);

/* each build: its real money line and its simulated one (the Prop Sim's own, in-sample) */
const stage = (ppd, lo, hi) => ({ profit_per_dollar: ppd, range95: [lo, hi], no_edge_p95: 0.4, above_no_edge: ppd > 0.4 });
const real = (costs, payouts, accounts) => ({ entries: 3, not_checked: 3, spent: costs, refunds: 0, costs, payouts, net: payouts - costs,
  roi_pct: costs ? Math.round(100 * (payouts - costs) / costs) : null, profit_per_dollar: costs ? Math.round(100 * (payouts - costs) / costs) / 100 : null,
  words: costs ? null : 'not enough data yet', accounts, accounts_with_a_card: accounts, card_account_could_not_tell: 0, card_account_words: null });
function moneyAnswer(o) {
  const x = o || {};
  return { v: 1, note: 'made up', in_sample_simulated: true,
    builds: [
      { bot: 'sample_a_v1', file: 'sample_a_v1.json', sha256: SHA_A, on_roster: true, simulated: { in_sample: true, eval: stage(1.1, 0.2, 2.0), funded: stage(0.9, 0.1, 1.8) }, accounts: ['EVAL-B', 'FUNDED-C'],
        /* TheDesk #120: 2 of its entries were booked before the card's fills account log began (made up) */
        real: Object.assign(x.alarm === false ? real(200, 500, 2) : real(200, 120, 2), { card_account_could_not_tell: 2, card_account_words: 'could not tell' }) },
      { bot: 'sample_b_v1', file: 'sample_b_v1.json', sha256: '7'.repeat(64), on_roster: true, simulated: { in_sample: true, eval: stage(0.8, 0.1, 1.5), funded: stage(0.7, 0.0, 1.4) }, accounts: ['EVAL-D'], real: real(0, 0, 1) },
      { bot: 'sample_old_v1', file: 'sample_old_v1.json', sha256: '8'.repeat(64), on_roster: false, simulated: null, accounts: ['GONE-1'], real: real(150, 0, 1) },
    ],
    by_bought_for_before_history: 0, by_card_account_could_not_tell: 2,
    card_account_log: { began: '2001-03-05', note: 'made up' },
    unattributed: { entries: 2, costs: 130, payouts: 0, by_reason: { no_account: 1, no_build: 1, no_pick: 0, not_prop: 0 }, note: 'made up' },
    ledger_total: { entries: 12, costs: 680, payouts: 620 }, problems: [] };
}

const acct = (account, firm, stage, extra) => Object.assign({ account, firm, stage, type: { id: 't-' + stage, firm, name: stage === 'eval' ? '50K Eval' : '50K Funded', version: 1, status: 'not_checked' }, problem: null, since_ms: 1 }, extra || {});
const pick = (state) => ({ file: 'sample_a_v1.json', sha256: SHA_A, state: state || 'ok', why: null, bot: 'sample_a_v1', display_name: null });
function cohortsAnswer(o) {
  const x = o || {};
  const alpha = { id: 'alpha', name: 'Alpha', stage: 'eval', firm: 'Firm A', firms: ['Firm A'], pc: 'PC-ONE', pick: pick(x.pick), accounts: x.alphaEmpty ? [] : [acct('EVAL-B', 'Firm A', 'eval')], created_ms: 1, updated_ms: 1, problems: x.problem ? ['EVAL-B: its type was taken away (made up)'] : [] };
  const beta = { id: 'beta', name: 'Beta', stage: 'funded', firm: 'Firm A', firms: ['Firm A'], pc: 'PC-ONE', pick: null, accounts: [acct('FUNDED-C', 'Firm A', 'funded')], created_ms: 1, updated_ms: 1, problems: [] };
  const gamma = { id: 'gamma', name: 'Gamma', stage: 'eval', firm: 'Firm A', firms: ['Firm A'], pc: 'PC-ONE', pick: null, accounts: [], created_ms: 1, updated_ms: 1, problems: [] };
  const inAlpha = alpha.accounts.map(a => a.account);
  return { v: 1, version: x.version || 4, note: 'made up', cohorts: [alpha, beta, gamma],
    firms: [{ firm: 'Firm A', pc: 'PC-ONE', set_ms: 1, cohorts: ['alpha', 'beta', 'gamma'] }], by_pc: {},
    prop_accounts: [{ account: 'EVAL-B', firm: 'Firm A', stage: 'eval', cohort: inAlpha.includes('EVAL-B') ? 'alpha' : null, pc: 'PC-ONE' }, { account: 'FUNDED-C', firm: 'Firm A', stage: 'funded', cohort: 'beta', pc: 'PC-ONE' },
      { account: x.tray || 'EVAL-D', firm: 'Firm A', stage: 'eval', cohort: null, pc: null }],
    bought_for: {}, pick_history: {}, problems: [] };
}
const centurionAnswer = () => ({ ok: true, problem: null, report: { schema: 'loop.centurion.report/1', run_id: 'made-up-week', status: 'reported', applies: false, summary: 'A made-up week: nothing to do.',
  findings: ['made-up finding one', 'made-up finding two'], proposal: { changes: [{ name: 'sample_builds_a_night', from: 50, to: 60, allowed: true }, { name: 'sample_other', from: 'a', to: 'b', allowed: false }] } },
  veto: { built: false, note: 'the veto is Castra\'s (plan step 3.3): until it exists Centurion reports only and nothing is applied' } });
/* The Desk's Centurion answer with its veto (the contract v1, 2026-11-19, section 4.3): a made-up SAMPLE week, every setting name, value,
   reason and time made up (2001). state: the window's state ('open', 'closed', 'sealed', 'missed', 'reports only', 'not a Saturday report');
   vetoed: names already vetoed; outcomes: { name: outcome } from the applied log; undo: { name: undo state } of the applied rows */
const WEEK_WORDS = {
  open: 'Veto until the end of Sunday, New York time. The rest go in at Sunday night\'s run.',
  closed: 'Closed. Sunday night\'s run takes the list.',
  sealed: 'Sunday night\'s run read the list at 2001-01-08 00:05 New York time.',
  missed: 'Sunday night\'s run did not take it: nothing from this report was applied.',
  'reports only': 'Centurion reports only: nothing is applied, so there is nothing to veto.',
  'not a Saturday report': 'Made on another day: never applied.',
};
const SAMPLE_RUN = 'centurion_20010106T110500Z';
function centurionV1(o) {
  const x = Object.assign({ state: 'open', vetoed: [], outcomes: {}, undo: {}, more: 0, applied: true, week: true }, o || {});
  const change = (name, from, to, allowed, why) => ({ name, from, to, why, allowed, bounds: { minimum: 1, maximum: 100, weekly_step: 10 },
    veto: x.vetoed.includes(name) ? { id: 'v_' + '0123456789abcdef', at_utc: '2001-01-07T14:00:00Z' } : null,
    outcome: x.outcomes[name] ? x.outcomes[name][0] : null, outcome_why: x.outcomes[name] ? x.outcomes[name][1] : null });
  const row = (run, name, from, to, at, state, why) => ({ run_id: run, name, from, to, applied_utc: at, undo: state === 'none' ? { state: 'none' } : { state, id: 'u_' + 'fedcba9876543210', asked_utc: '2001-01-09T15:00:00Z', why: why || null } });
  return { ok: true, problem: null,
    report: { schema: 'loop.centurion.report/1', run_id: SAMPLE_RUN, status: 'reported', applies: x.state !== 'reports only', made_utc: '2001-01-06T11:05:00Z',
      summary: 'Sample week (made up): three changes proposed, one refused by the allow-list.', findings: ['made-up sample finding one', 'made-up sample finding two'],
      proposal: { changes: [{ name: 'sample_builds_a_night', from: 50, to: 60, allowed: true }, { name: 'sample_neighbours', from: 4, to: 5, allowed: true }, { name: 'sample_other', from: 'a', to: 'b', allowed: false }] } },
    veto: { built: true, version: 1, note: 'a veto turns a change off; the rest go in at Sunday night\'s run' },
    week: !x.week ? null : { run_id: SAMPLE_RUN, made_utc: '2001-01-06T11:05:00Z', saturday: '2001-01-06', applies: x.state !== 'reports only',
      window: { state: x.state, closes_utc: '2001-01-08T05:00:00Z', sealed_utc: x.state === 'sealed' ? '2001-01-08T05:05:00Z' : null, words: WEEK_WORDS[x.state] || '' },
      changes: x.changes || [change('sample_builds_a_night', 50, 60, true, 'Sample reason: more builds a night (made up).'), change('sample_neighbours', 4, 5, true, 'Sample reason: one more neighbour (made up).'),
        change('sample_other', 'a', 'b', false, 'Sample reason: outside the allow-list (made up).')] },
    applied: !x.applied ? { ok: false, problem: 'The applied log does not read: nothing from it is shown, and no undo can be asked now.', rows: [], more: 0 }
      : { ok: true, problem: null, more: x.more, rows: x.rows || [
        row('centurion_20001230T110500Z', 'sample_builds_a_night', 40, 50, '2001-01-01T05:05:00Z', x.undo.sample_builds_a_night || 'none'),
        row('centurion_20001230T110500Z', 'sample_neighbours', 3, 4, '2001-01-01T05:05:00Z', x.undo.sample_neighbours || 'none'),
        row('centurion_20001223T110500Z', 'sample_spare', 7, 8, '2000-12-25T05:05:00Z', x.undo.sample_spare || 'refused', 'Sample: moved since: undo by hand (made up).')] } };
}
const rosterAnswer = () => {
  const r = LS.rosterAnswer();
  const files = r.files.map(f => (f.name === 'sample_a_v1.json' ? Object.assign({}, f, { sha256: SHA_A, board: { group: 'approved_by_anthony', label: 'approved by Anthony', candidate: LS.A } }) : f));
  return Object.assign({}, r, { files });
};
module.exports = { SHA_A, moneyAnswer, cohortsAnswer, centurionAnswer, centurionV1, SAMPLE_RUN, rosterAnswer, boardAnswer: LS.boardAnswer, A: LS.A };
