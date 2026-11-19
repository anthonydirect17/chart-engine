/*
 * LudusView (plan step 3.4): Legion's Ludus tab (Pipeline, Board, Builder, Seeds, Agents) and the build page, drawn from
 * LudusCore (live/ludus-core.js, the pure part and its reads). Read only: this file sends nothing to ChartBridge, writes
 * nothing to The Desk and places nothing. A hidden Ludus reads nothing; a shown one reads The Desk once, then every
 * READ_EVERY_MS while it stays shown, or at "Read again".
 *
 *   const v = LudusView.mount(el, { deskBase, fetch, helper, chart, store, prefix });
 *     deskBase()  The Desk's address (AccountsPage.deskBase: ChartBridge's /diag desk.deskUrl, else its default)
 *     fetch       window.fetch; helper: the PC helper's client (AgentHelper.createClient) or null
 *     chart       window.ChartEngine (the one trade on the chart: chart-engine's own engine, no other library)
 *   v.show(on); v.state(); v.destroy()
 *
 * The address keeps the view (?tab=ludus&ludus=board, and the build page's &build=<candidate>&show=&page=&trade=), written
 * with history.replaceState as Legion's tabs are, so a reload opens the same page.
 */
(function () {
'use strict';
if (typeof window === 'undefined' || typeof document === 'undefined') return;
const C = window.LudusCore;
const READ_EVERY_MS = 300000;           // the board changes once a night: every five minutes while shown is plenty
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* a table that stacks on a phone: each cell carries its column's name (legion.css .lx-tbl) */
function table(cls, heads, rows) {
  return '<div class="lx-tbl ' + cls + '"><table><thead><tr>' + heads.map(h => '<th scope="col">' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr' + (r.attrs || '') + '>' + r.cells.map((c, i) => '<td data-l="' + esc(heads[i]) + '"' + (c.cls ? ' class="' + c.cls + '"' : '') + '>' + c.html + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}
const cell = (text, cls) => ({ html: esc(text), cls });
const raw = (html, cls) => ({ html, cls });
/* Roman numerals as the rest of Legion draws them (LegionCore.roman), else the plain number */
const roman = n => (window.LegionCore && typeof window.LegionCore.roman === 'function' && window.LegionCore.roman(n)) || String(n);
const tone = x => (typeof x === 'number' && isFinite(x) ? (x > 0 ? 'ld-up' : x < 0 ? 'ld-down' : '') : '');
const buildLink = (id, name) => '<button type="button" class="ld-link" data-ld-build="' + esc(id) + '">' + esc(name) + '</button>';
const card = (rn, title, body, extra) => '<section class="lx-card ld-card' + (extra ? ' ' + extra : '') + '"><h2>' + (rn ? '<span class="lx-rn">' + esc(rn) + '</span>' : '') + esc(title) + '</h2>' + body + '</section>';
const note = (text, cls) => '<p class="ld-note' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</p>';

function mount(el, opts) {
  const o = opts || {};
  if (!el || !C) return null;
  const S = { shown: false, route: C.routeFrom(location.search), readAt: 0, timer: 0, gen: 0,
    board: { state: 'idle', why: '', board: null }, ledger: { state: 'idle', why: '', ans: null }, roster: { state: 'idle', why: '', ans: null },
    lab: { state: 'idle', why: '', ans: null }, helper: { state: 'idle', why: '', status: null },
    trades: { key: '', state: 'idle', view: null, why: '' }, bars: { key: '', state: 'idle', rows: [], why: '', answer: null, from: '', ownWhy: '' },
    boardPage: 1, chart: null, chartKey: '' };

  const get = path => Promise.resolve().then(() => o.deskBase()).then(base => o.fetch(base + path, { cache: 'no-store', mode: 'cors', credentials: 'omit' }))
    .then(r => (r.ok ? r.json() : Promise.reject({ status: r.status })))
    .catch(e => Promise.reject(C.failWords(path.split('?')[0], e && typeof e.status === 'number' ? e.status : null)));

  /* ---------------------------------------------------------------- reads */
  function readAll() {
    const g = ++S.gen;
    S.readAt = Date.now();
    S.board.state = 'loading'; S.roster.state = 'loading';
    render();
    get(C.ROUTES.board).then(ans => {
      if (g !== S.gen) return;
      const b = C.boardOf(ans);
      S.board = { state: b.ok ? 'ok' : 'fail', why: b.problem || '', board: b.board };
      if (!b.ok) readLedger(g); else S.ledger = { state: 'idle', why: '', ans: null };
      render();
    }, why => { if (g !== S.gen) return; S.board = { state: 'fail', why, board: null }; readLedger(g); render(); });
    get(C.ROUTES.roster).then(ans => { if (g === S.gen) { S.roster = { state: 'ok', why: '', ans }; render(); } },
      why => { if (g === S.gen) { S.roster = { state: 'fail', why, ans: null }; render(); } });
    if (S.route.sub === 'seeds') readLab(g);
    if (S.route.sub === 'agents') readHelper(g);
  }
  function readLedger(g) {
    S.ledger.state = 'loading';
    get(C.ROUTES.ledger).then(ans => { if (g === S.gen) { S.ledger = { state: 'ok', why: '', ans }; render(); } },
      why => { if (g === S.gen) { S.ledger = { state: 'fail', why, ans: null }; render(); } });
  }
  function readLab(g) {
    S.lab.state = 'loading';
    get(C.ROUTES.lab).then(ans => { if (g === S.gen) { S.lab = { state: 'ok', why: '', ans }; render(); } },
      why => { if (g === S.gen) { S.lab = { state: 'fail', why, ans: null }; render(); } });
  }
  function readHelper(g) {
    if (!o.helper) { S.helper = { state: 'fail', why: 'The PC helper is not on this page.', status: null }; return; }
    S.helper.state = 'loading';
    o.helper.status().then(r => { if (g !== S.gen) return; S.helper = r && r.reach === 'ok' ? { state: 'ok', why: '', status: r.body } : { state: 'fail', why: 'The PC helper on this PC is not answering (' + (r ? r.reach : 'down') + ').', status: null }; render(); });
  }
  function readTrades() {
    const r = S.route, key = r.build + '|' + r.show + '|' + r.page;
    if (!r.build || S.trades.key === key) return;
    S.trades = { key, state: 'loading', view: null, why: '' };
    get(C.ROUTES.trades(r.build, r.show, r.page)).then(ans => {
      if (S.trades.key !== key) return;
      const v = C.tradesOf(ans);
      S.trades = { key, state: v.ok ? 'ok' : 'fail', view: v, why: v.problem || '' };
      render();
    }, why => { if (S.trades.key === key) { S.trades = { key, state: 'fail', view: null, why }; render(); } });
  }
  /* the trade's own bars first (Bot-Lab's, from the master's ticks: the trade chart's one data source); only a trade with none
     reads The Desk's stored bars of its session (ChartBridge's), and the page says which it drew */
  function readBars(t, root) {
    const own = C.ownBars(t), b = S.route.build;
    if (own.rows) {
      const key = b + '|own|' + t.n;
      if (S.bars.key !== key) S.bars = { key, state: 'ok', rows: own.rows, why: '', answer: null, from: 'trade', ownWhy: '' };
      return;
    }
    const w = C.tradeWindow(t, root);
    const key = b + '|' + (w ? w.root + '|' + w.session : 'none') + '|' + t.n;
    if (S.bars.key === key) return;
    const ownWhy = own.why || 'This trade carries no bars of its own.';
    if (!w) { S.bars = { key, state: 'fail', rows: [], why: ownWhy + ' It has no entry time in the file either: it cannot be placed on a chart.', answer: null, from: '', ownWhy }; return; }
    S.bars = { key, state: 'loading', rows: [], why: '', answer: null, from: 'desk', ownWhy };
    get(C.ROUTES.bars(w.root, w.session)).then(ans => {
      if (S.bars.key !== key) return;
      const rows = C.barsIn(ans, w);
      S.bars = { key, state: rows.length ? 'ok' : 'fail', rows, answer: ans, from: 'desk', ownWhy,
        why: rows.length ? '' : ownWhy + ' The Desk has no stored bars for this trade\'s time either (' + w.root + ', session ' + w.session + '): its numbers are below.' };
      render();
    }, why => { if (S.bars.key === key) { S.bars = { key, state: 'fail', rows: [], why: ownWhy + ' ' + why, answer: null, from: 'desk', ownWhy }; render(); } });
  }

  /* ---------------------------------------------------------------- what is known */
  function data() {
    const board = S.board.board;
    const rs = C.runsOf(board, board ? null : S.ledger.ans);
    const list = (board || S.ledger.state === 'ok') ? C.builds(rs.runs, board) : [];
    return { board, list, from: rs.from, problem: rs.problem };
  }
  const loading = x => x.state === 'loading' || x.state === 'idle';
  function sourceLine(d) {
    if (S.board.state === 'ok') return note('Read from the loop\'s board (made ' + (d.board.made_utc || 'at a time not stated') + ').', 'ld-src');
    if (loading(S.board)) return note('Reading the loop\'s board...', 'ld-src');
    const led = S.ledger.state === 'ok' ? (d.problem ? ' The loop\'s ledger: ' + d.problem : ' The builds below are read from the loop\'s ledger instead.') : loading(S.ledger) ? ' Reading the loop\'s ledger...' : ' The loop\'s ledger: ' + S.ledger.why;
    return note('The board: ' + S.board.why + led, 'ld-src bad');
  }

  /* ---------------------------------------------------------------- the views */
  function viewPipeline(d) {
    if (!d.board) return card('', 'Pipeline', sourceLine(d) + note('The stations come from the loop\'s board only.'));
    const st = C.pipeline(d.board, d.list, 6);
    const body = '<ol class="ld-stations">' + st.map(s => '<li class="ld-station" data-station="' + esc(s.id) + '"><div class="ld-st-head"><span class="lx-rn">' + esc(s.rn) + '</span><b>' + esc(s.name) + '</b>' +
      '<span class="ld-count">' + (s.count === null ? 'not built yet' : esc(s.count.toLocaleString('en-US'))) + '</span></div>' + note(s.note) +
      (s.items.length ? '<ul class="ld-st-items">' + s.items.map(x => '<li>' + (x.link ? buildLink(x.candidate, x.name) : esc(x.name)) + (x.words ? ' <span class="ld-dim">' + esc(x.words) + '</span>' : '') + '</li>').join('') + '</ul>' : '') + '</li>').join('') + '</ol>';
    return card('', 'Pipeline: idea to live, stations I to VII', sourceLine(d) + body);
  }
  function roiRow(b, extra) {
    const roi = C.roiOf(b.best || b.runs.find(r => r.kind === 'try') || null);
    const cells = C.roiCells(roi);
    return { attrs: ' data-candidate="' + esc(b.id) + '"', cells: [raw(buildLink(b.id, b.name) + (b.family && b.family !== b.name ? '<span class="ld-dim"> ' + esc(b.family) + '</span>' : '')),
      cell(cells[0].text, 'ld-num ld-lead'), cell(cells[1].text, 'ld-num'), cell(cells[2].text, 'ld-num'), cell(cells[3].text, 'ld-num'), cell(cells[4].text, 'ld-dim'),
      cell(C.noEdgeText(roi) || '-', 'ld-dim')].concat(extra || []) };
  }
  const ROI_HEADS = ['Build', 'Profit per $1', 'Pass rate', 'Days to pass', 'Payout per funded account', 'Sample', 'Against no edge'];
  function viewBoard(d) {
    let out = '';
    if (d.board) {
      const ln = C.lineOf(d.board, d.list);
      const rows = ln.rows.map(e => ({ attrs: ' data-candidate="' + esc(e.candidate) + '"', cells: [cell(e.rank === null ? '-' : roman(e.rank), 'ld-rank'), raw(buildLink(e.candidate, e.name)),
        cell(C.roiCells(e.roi)[0].text, 'ld-num ld-lead'), cell(C.roiCells(e.roi)[1].text, 'ld-num'), cell(C.roiCells(e.roi)[2].text, 'ld-num'), cell(C.roiCells(e.roi)[3].text, 'ld-num'),
        cell(C.roiCells(e.roi)[4].text, 'ld-dim'), cell(e.halves.join('; ') || C.NOT_ENOUGH, 'ld-dim'),
        cell(e.toProof ? 'may go to proof' : (e.whyNot || 'not to proof'), 'ld-dim')] }));
      out += card('II', 'The line of 30', note(ln.note) + (ln.rankedBy ? note('Ranked: ' + ln.rankedBy + '.', 'ld-dim') : '') +
        (rows.length ? table('ld-line', ['Rank', 'Build', 'Profit per $1', 'Pass rate', 'Days to pass', 'Payout per funded account', 'Sample', 'Both halves', 'Proof'], rows) : note('No build is in the line yet.')));
    }
    const all = d.list;
    const pg = C.pageOf(all, S.boardPage, C.BUILDS_PER_PAGE);
    S.boardPage = pg.page;
    const body = sourceLine(d) + note(C.SLOT_30, 'ld-dim') +
      (all.length ? table('ld-builds', ROI_HEADS, pg.rows.map(b => roiRow(b))) + pager('board', pg.page, pg.pages, all.length, 'build') :
        note(loading(S.board) || loading(S.ledger) ? 'Reading...' : 'No build to show yet.'));
    out += card('', 'Every build on the screen, best first', body);
    return out;
  }
  function pager(kind, page, pages, total, word) {
    if (pages <= 1) return note(total.toLocaleString('en-US') + ' ' + word + (total === 1 ? '' : 's') + '.', 'ld-dim');
    return '<div class="ld-pager" data-pager="' + kind + '"><button type="button" class="lx-btn" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<span>Page ' + page + ' of ' + pages + ' (' + total.toLocaleString('en-US') + ' ' + word + 's)</span>' +
      '<button type="button" class="lx-btn" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>Next</button></div>';
  }
  function viewBuilder(d) {
    if (!d.board) return card('', 'Builder', sourceLine(d) + note('The library and the Builder\'s requests come from the loop\'s board only.'));
    const b = C.builderOf(d.board);
    let body = note('Asking for a build stays on The Desk\'s Lab (its Builder screen) for now: Legion only shows the library and what became of each request.') +
      note(b.perNight === null ? 'The Builder is off on the board (no requests a night are set).' : 'Requests a night: ' + b.perNight + '.', 'ld-dim');
    body += b.slots.length ? '<dl class="ld-lib">' + b.slots.map(s => '<dt>' + esc(s.slot) + '</dt><dd>' + s.options.map(x => '<span class="ld-chip">' + esc(x) + '</span>').join('') + '</dd>').join('') + '</dl>' : note(b.why);
    const names = new Map(d.list.map(x => [x.id, x.name]));
    body += b.fates.length ? table('ld-fates', ['Request', 'Night', 'State', 'Why', 'Build'], b.fates.slice().reverse().map(f => ({ cells: [cell(f.id), cell(f.night || '-'), cell(f.state), cell(f.why || '-', 'ld-dim'),
      raw(C.isCandidate(f.candidate) ? buildLink(f.candidate, names.get(f.candidate) || f.candidate.slice(0, 12)) : '-')] }))) : note('No request yet.', 'ld-dim');
    return card('', 'Builder: the library and your requests', body);
  }
  function viewSeeds() {
    let body = note('A hybrid agent is seeded in your own words, then proved here: its bots alone, against its bots with the agent, against skipping the same number of flags at random. The exam is not built yet; seeding stays on The Desk\'s Lab for now.');
    if (loading(S.lab)) body += note('Reading The Desk\'s Lab...');
    else if (S.lab.state === 'fail') body += note(S.lab.why, 'bad');
    else {
      const seeds = C.seedsOf(S.lab.ans);
      body += seeds.length ? table('ld-seeds', ['Name', 'Size', 'Path', 'State'], seeds.map(s => ({ cells: [cell(s.name), cell(s.size), cell(s.path),
        cell(s.state === 'seeded' ? 'seeded (' + s.agent + ')' : s.state === 'refused' ? 'refused: ' + s.refused : s.state)] }))) : note('No seed asked for yet.', 'ld-dim');
    }
    return card('', 'Seeds', body);
  }
  /* an agent's edge: green or red only on a figure shown with its sample */
  function edgeCell(x, n) { const t = C.edgeText(x, n); return cell(t, 'ld-num' + (t.startsWith(C.NOT_ENOUGH) ? ' ld-dim' : ' ' + tone(x))); }
  function viewAgents() {
    let body = note('The hybrid\'s exam (its bots alone, against its bots with the agent, against random skipping) is not built yet. Below: the agent builds this PC\'s helper knows, with their exam and live edges.');
    if (loading(S.helper)) body += note('Asking the PC helper...');
    else if (S.helper.state === 'fail') body += note(S.helper.why, 'bad');
    else {
      const a = C.agentsOf(S.helper.status);
      body += a.length ? table('ld-agents', ['Build', 'Hero', 'Tier', 'Exam edge', 'Live edge'], a.map(x => ({ cells: [cell(x.build), cell(x.hero || '-'), cell(x.tier || 'tier unknown'),
        edgeCell(x.exam, null), edgeCell(x.live, x.liveN)] }))) : note('The PC helper lists no agent build.', 'ld-dim');
      body += note('An edge shows with its sample, from ' + C.EDGE_MIN_TRADES + ' trades on (the league\'s bar); under that, or with no sample reported (the exam edge has none from the PC helper): ' + C.NOT_ENOUGH + '.', 'ld-dim');
    }
    return card('', 'Agents', body);
  }

  /* ---------------------------------------------------------------- the build page */
  function viewBuild(d) {
    const r = S.route;
    const b = d.list.find(x => x.id === r.build) || null;
    let out = '<div class="ld-back"><button type="button" class="lx-btn" data-ld-back>Back to the ' + esc(C.SUB_NAMES[r.sub] || 'Board') + '</button></div>';
    if (!b) {
      return out + card('', 'Build ' + r.build.slice(0, 12), sourceLine(d) + note(loading(S.board) || loading(S.ledger) ? 'Reading...' : 'This build is not in what The Desk served.'));
    }
    const head = '<p class="ld-id">' + esc(b.family ? b.family + ' · ' : '') + esc(b.instrument || 'instrument not stated') + ' · ' + esc(b.tries) + ' tr' + (b.tries === 1 ? 'y' : 'ies') + ' · <span class="ld-dim">' + esc(b.id) + '</span></p>';
    /* I: ROI first, per account type */
    const types = C.byType(b);
    const ro = C.rosterFor(S.roster.ans, b);
    let roi = note(C.SIMULATED, 'ld-sim') + note(C.NOT_NAMED, 'ld-dim');
    roi += types.length ? table('ld-types', ['Account type', 'Profit per $1', 'Pass rate', 'Days to pass', 'Payout per funded account', 'Sample', 'Against no edge'], types.map(t => {
      const c = C.roiCells(t.roi);
      return { cells: [cell(t.type + (t.best ? '' : ' (no law 6.7 figure)') + ', ' + t.tries + ' tr' + (t.tries === 1 ? 'y' : 'ies')), cell(c[0].text, 'ld-num ld-lead'), cell(c[1].text, 'ld-num'), cell(c[2].text, 'ld-num'), cell(c[3].text, 'ld-num'), cell(c[4].text, 'ld-dim'), cell(C.noEdgeText(t.roi) || '-', 'ld-dim')] };
    })) : note('No try of this build has a prop score yet: ' + C.NOT_ENOUGH + '.');
    roi += note('Each row: the best try on that row\'s own account type, at its list price, with the default playbooks (not only the 50K account of the screen\'s default setting).', 'ld-dim');
    out += card('', b.name, head + roi, 'ld-build-head');
    /* II: the best eval and funded playbooks */
    let pb = '';
    if (S.roster.state === 'loading' || S.roster.state === 'idle') pb = note('Reading the roster...');
    else if (S.roster.state === 'fail') pb = note('The roster: ' + S.roster.why, 'bad');
    else if (!ro) pb = note('No roster file for this build: its playbooks have not been searched yet, so no playbook is shown.');
    else {
      pb = note('Roster file ' + ro.name + ' (' + ro.label + '), for ' + C.planName(ro.roster) + '. The suggested setting: a playbook searched on that run, in-sample. ' + C.SIMULATED, 'ld-sim');
      pb += '<div class="ld-pbs">' + ['eval', 'funded'].map(stage => {
        const s = C.playbookStage(ro.roster, stage);
        if (!s) return '<div class="ld-pb">' + note('The ' + stage + ' playbook is not in this file.') + '</div>';
        return '<div class="ld-pb"><h3>' + (stage === 'eval' ? 'Eval: played for speed' : 'Funded: played steadier') + '</h3>' +
          '<dl class="ld-kv">' + s.cells.map(c => '<dt>' + esc(c.label) + '</dt><dd class="ld-num">' + esc(c.text) + '</dd>').join('') + '</dl>' +
          note(s.noEdge + '; ' + s.untuned + '.', 'ld-dim') +
          '<dl class="ld-kv ld-kv-pb">' + s.playbook.map(c => '<dt>' + esc(c.label) + '</dt><dd class="ld-num">' + esc(c.text) + '</dd>').join('') + '</dl></div>';
      }).join('') + '</div>';
    }
    out += card('', 'Its best eval and funded playbooks', pb);
    /* III: by zone and regime: off */
    out += card('', 'Results by zone and regime', note(C.ZONES_OFF), 'ld-off');
    /* IV: the plain-code checks */
    const ck = C.checksOf(b, d.board);
    out += card('', 'The plain-code checks', (ck.lines.length ? '<ul class="ld-checks">' + ck.lines.map(l => '<li class="' + (l.ok ? 'ok' : 'no') + '"><b>' + esc(l.label) + ':</b> ' + esc(l.text) + '</li>').join('') + '</ul>' : note('No try of this build carries the line\'s facts yet.')) + note(ck.missing, 'ld-dim'));
    /* V: the trades, 20 a page, one on the chart */
    out += card('', 'Its trades', viewTrades(b));
    return out;
  }
  function viewTrades(b) {
    const r = S.route, t = S.trades;
    let body = '<div class="lx-sub ld-shows" role="tablist" aria-label="Which trades">' + C.SHOWS.map(s => {
      const n = t.view && t.view.counts && typeof t.view.counts[s] === 'number' ? ' (' + t.view.counts[s].toLocaleString('en-US') + ')' : '';
      return '<button type="button" role="tab" data-ld-show="' + s + '" aria-selected="' + (r.show === s) + '">' + esc(C.SHOW_NAMES[s] + n) + '</button>';
    }).join('') + '</div>';
    if (t.state === 'loading' || t.state === 'idle') return body + note('Reading the trades...');
    if (t.state === 'fail') return body + note('The trades: ' + t.why, 'bad');
    const v = t.view;
    body += note(v.fence, 'ld-dim') + (v.placeholder ? note('Placeholder shape: Bot-Lab\'s side does not write this file yet, so what shows here is whatever the file holds.', 'ld-dim') : '');
    if (!v.rows.length) return body + note('No trade on this page.');
    const chosen = v.rows.find(x => x.n === r.trade) || null;
    body += table('ld-trades', ['#', 'Session', 'Side', 'R', 'P&L', 'Flags'], v.rows.map(x => ({ attrs: ' data-ld-trade="' + x.n + '"' + (chosen && chosen.n === x.n ? ' aria-current="true"' : ''),
      cells: [raw('<button type="button" class="ld-link" data-ld-trade-btn="' + x.n + '">' + esc(x.n) + '</button>'), cell(x.session), cell(x.side === 'long' ? 'Long' : 'Short', x.side === 'long' ? 'ld-long' : 'ld-short'),
        cell(C.signed(x.r) + ' R', 'ld-num ' + tone(x.r)), cell(typeof x.pnl === 'number' ? C.usd(x.pnl) : C.NOT_GIVEN, 'ld-num ' + tone(x.pnl)), cell(Array.isArray(x.flags) && x.flags.length ? x.flags.join('; ') : '-', 'ld-dim')] })));
    body += pager('trades', v.page, v.pages, v.counts && typeof v.counts[r.show] === 'number' ? v.counts[r.show] : v.rows.length, 'trade');
    body += '<div class="ld-one" id="ldOne">' + (chosen ? oneTrade(chosen, b) : note('Pick a trade to see it on the chart.', 'ld-dim')) + '</div>';
    return body;
  }
  function oneTrade(t, b) {
    readBars(t, b.instrument);
    const rows = C.tradeRows(t);
    const bars = S.bars;
    const words = bars.state === 'loading' ? 'Reading the bars...' : bars.state === 'fail' ? bars.why
      : bars.from === 'trade' ? 'This trade\'s own 1-minute bars, written by Bot-Lab from the master\'s ticks (the trade chart\'s one data source).'
        : bars.ownWhy + ' Instead: The Desk\'s stored 1-minute bars of that session (ChartBridge\'s, not the master\'s ticks), from an hour before the entry to half an hour after the exit.';
    return '<div class="ld-one-grid"><div class="ld-chart-wrap"><div class="ld-chart" id="ldChart" aria-label="Trade ' + esc(t.n) + ' on the chart"' + (bars.state === 'ok' ? '' : ' hidden') + '></div>' + note(words, bars.state === 'fail' ? 'bad' : 'ld-dim') + '</div>' +
      '<dl class="ld-kv">' + rows.map(x => '<dt>' + esc(x.label) + '</dt><dd class="ld-num">' + esc(x.text) + '</dd>').join('') + '</dl></div>' +
      note('Flag this trade: not built yet (The Desk has no place to keep your flag).', 'ld-dim');
  }
  function drawChart(t) {
    const host = document.getElementById('ldChart');
    if (!host || S.bars.state !== 'ok' || !o.chart || typeof o.chart.create !== 'function') { dropChart(); return; }
    const key = S.bars.key;
    if (S.chart && S.chart.host === host && S.chartKey === key) return;
    dropChart();
    const U = o.chart.util || {};
    const draw = C.chartOf(t, S.bars.rows, U.zoneSeconds ? s => U.zoneSeconds(s) : null, o.chart.LEVEL_COLORS ? o.chart.LEVEL_COLORS.close : null);
    /* the whole window in view at once (an hour before to half an hour after), on a phone too: the bars' spacing from the width */
    const spacing = Math.max(1, Math.min(14, ((host.clientWidth || 600) - 90) / (draw.bars.length + 6)));
    const ch = o.chart.create(host, { liveButton: false, lockButton: false, fitButton: false, rightOffset: 4, barSpacing: spacing, ariaLabel: 'Trade ' + t.n,
      layers: { volume: true, vwap: false, levels: true, trades: true, ib: false } });
    /* the candles in Anthony's own colors: the chart page's saved up, down and ground (its Colors panel), else the chart's
       default; the look of the chart itself is chart-engine's, never Legion's */
    try {
      const saved = JSON.parse(window.localStorage.getItem('live-colors-v1') || 'null'), th = {};
      for (const k of ['up', 'down', 'bg']) if (saved && typeof saved[k] === 'string' && /^#[0-9a-f]{6}$/i.test(saved[k])) th[k] = saved[k];
      if (Object.keys(th).length) ch.setTheme(th);
    } catch (e) { /* no storage here: the chart's default colors */ }
    ch.setBars(draw.bars, { barSeconds: 60 });
    ch.setLevels(draw.levels);
    ch.setTrades(draw.trades);
    S.chart = { host, chart: ch }; S.chartKey = key;
  }
  function dropChart() {
    if (S.chart) { try { if (typeof S.chart.chart.destroy === 'function') S.chart.chart.destroy(); } catch (e) { /* gone */ } }
    S.chart = null; S.chartKey = '';
  }

  /* ---------------------------------------------------------------- the frame */
  el.classList.add('ld');
  el.innerHTML = '<div class="lx-sub ld-subs" role="tablist" aria-label="Ludus">' + C.SUBS.map(s => '<button type="button" role="tab" data-ld-sub="' + s + '" aria-selected="false">' + esc(C.SUB_NAMES[s]) + '</button>').join('') +
    '<button type="button" class="lx-btn ld-again" data-ld-again>Read again</button></div><div class="ld-body" id="ldBody"></div>';
  const bodyEl = el.querySelector('.ld-body');
  function render() {
    if (!S.shown) return;
    for (const btn of el.querySelectorAll('[data-ld-sub]')) btn.setAttribute('aria-selected', String(!S.route.build && btn.dataset.ldSub === S.route.sub));
    const d = data();
    const r = S.route;
    let html;
    if (r.build) { readTrades(); html = viewBuild(d); }
    else html = r.sub === 'board' ? viewBoard(d) : r.sub === 'builder' ? viewBuilder(d) : r.sub === 'seeds' ? viewSeeds() : r.sub === 'agents' ? viewAgents() : viewPipeline(d);
    if (S.chart && S.chart.host && bodyEl.contains(S.chart.host)) {
      /* keep the chart's host (and its canvas) across a redraw of the page around it */
      const keep = S.chart.host;
      bodyEl.innerHTML = html;
      const spot = document.getElementById('ldChart');
      if (spot && spot.getAttribute('aria-label') === keep.getAttribute('aria-label') && S.bars.state === 'ok') spot.replaceWith(keep);
      else dropChart();
    } else bodyEl.innerHTML = html;
    if (r.build && r.trade && S.trades.view) { const t = S.trades.view.rows.find(x => x.n === r.trade); if (t) drawChart(t); else dropChart(); } else dropChart();
  }
  function go(next, keepPage) {
    S.route = Object.assign({}, S.route, next);
    if (!keepPage && next.sub) S.boardPage = 1;
    try { history.replaceState(null, '', location.pathname + C.routeSearch(location.search, S.route) + location.hash); } catch (e) { /* file: */ }
    if (S.route.sub === 'seeds' && S.lab.state === 'idle') readLab(S.gen);
    if (S.route.sub === 'agents' && S.helper.state === 'idle') readHelper(S.gen);
    render();
    if (next.build || next.sub) { try { el.scrollIntoView({ block: 'start' }); } catch (e) { /* old browser */ } }
  }
  function onClick(e) {
    const t = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!t || !el.contains(t)) return;
    if (t.dataset.ldSub) { go({ sub: t.dataset.ldSub, build: '', show: 'all', page: 1, trade: 0 }); return; }
    if (t.hasAttribute('data-ld-again')) { S.trades.key = ''; S.bars.key = ''; readAll(); return; }
    if (t.dataset.ldBuild) { go({ build: t.dataset.ldBuild, show: 'all', page: 1, trade: 0 }); return; }
    if (t.hasAttribute('data-ld-back')) { go({ build: '', show: 'all', page: 1, trade: 0 }, true); return; }
    if (t.dataset.ldShow) { go({ show: t.dataset.ldShow, page: 1, trade: 0 }); return; }
    if (t.dataset.ldTradeBtn) { go({ trade: +t.dataset.ldTradeBtn }); const one = document.getElementById('ldOne'); if (one) { try { one.scrollIntoView({ block: 'nearest' }); } catch (x) { /* old */ } } return; }
    const pager = t.closest('[data-pager]');
    if (pager && t.dataset.page) {
      const p = +t.dataset.page;
      if (pager.dataset.pager === 'board') { S.boardPage = p; render(); }
      else go({ page: p, trade: 0 });
    }
  }
  el.addEventListener('click', onClick);

  function show(on) {
    S.shown = on === true;
    clearInterval(S.timer); S.timer = 0;
    if (!S.shown) { dropChart(); return false; }
    S.route = C.routeFrom(location.search);
    if (!S.readAt || Date.now() - S.readAt > READ_EVERY_MS) readAll(); else render();
    S.timer = setInterval(() => { if (S.shown) readAll(); }, READ_EVERY_MS);
    return true;
  }
  return {
    show,
    state: () => ({ shown: S.shown, route: Object.assign({}, S.route), board: S.board.state, boardWhy: S.board.why, ledger: S.ledger.state, roster: S.roster.state,
      trades: S.trades.state, bars: S.bars.state, barsWhy: S.bars.why, barsFrom: S.bars.from, chart: !!S.chart, builds: data().list.length }),
    destroy() { clearInterval(S.timer); dropChart(); el.removeEventListener('click', onClick); el.innerHTML = ''; },
  };
}

window.LudusView = { mount };
})();
