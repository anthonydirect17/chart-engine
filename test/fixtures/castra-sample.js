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
  words: costs ? null : 'not enough data yet', accounts, accounts_with_a_card: accounts });
function moneyAnswer(o) {
  const x = o || {};
  return { v: 1, note: 'made up', in_sample_simulated: true,
    builds: [
      { bot: 'sample_a_v1', file: 'sample_a_v1.json', sha256: SHA_A, on_roster: true, simulated: { in_sample: true, eval: stage(1.1, 0.2, 2.0), funded: stage(0.9, 0.1, 1.8) }, accounts: ['EVAL-B', 'FUNDED-C'], real: x.alarm === false ? real(200, 500, 2) : real(200, 120, 2) },
      { bot: 'sample_b_v1', file: 'sample_b_v1.json', sha256: '7'.repeat(64), on_roster: true, simulated: { in_sample: true, eval: stage(0.8, 0.1, 1.5), funded: stage(0.7, 0.0, 1.4) }, accounts: ['EVAL-D'], real: real(0, 0, 1) },
      { bot: 'sample_old_v1', file: 'sample_old_v1.json', sha256: '8'.repeat(64), on_roster: false, simulated: null, accounts: ['GONE-1'], real: real(150, 0, 1) },
    ],
    by_bought_for_before_history: 0,
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
const rosterAnswer = () => {
  const r = LS.rosterAnswer();
  const files = r.files.map(f => (f.name === 'sample_a_v1.json' ? Object.assign({}, f, { sha256: SHA_A, board: { group: 'approved_by_anthony', label: 'approved by Anthony', candidate: LS.A } }) : f));
  return Object.assign({}, r, { files });
};
module.exports = { SHA_A, moneyAnswer, cohortsAnswer, centurionAnswer, rosterAnswer, boardAnswer: LS.boardAnswer, A: LS.A };
