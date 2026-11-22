// A fake Desk for the chart page's tests (chart 1.16.0): GET/PUT /api/chart-hotkeys and /api/chart-strategies as
// TheDesk docs/API.md "Desk endpoints used by the chart page" describes them (and DESK_SETTINGS_CONTRACT draft v1): a whole
// document with a `rev`, the stored rev + 1 on a PUT, 409 on a stale rev, 400 with { detail } on a bad shape, CORS for a
// localhost page (the real one allows http://localhost:8765 and http://127.0.0.1:8765 only; a test page has another port).
// Sample data only. With `down` set it answers nothing (the connection is dropped), as a Desk that is not running.
//   const desk = await startDesk(port, { hotkeys, strategies });  desk.docs, desk.log, desk.down = true, desk.bump(which), desk.close();
//   desk.oldDesk = true: a Desk before the bar trail (a barTrail key refused, 400)
// Chart 1.30.0 (wave 5, SPEC "account types"): the account types ledger as the spec's API contract gives it, for the chart page only:
//   GET /api/account-types ({"v":1,"types":[...every field...],"asOf"}; archived left out unless ?all=1), GET /api/chart-accounts
//   (rows gain "accountType": {id, firm, name, version, status} or null) and PUT /api/accounts/{account}/account-type
//   ({"account_type": id|null}; 404 for an unknown type, 409 for an archived one, errors as {"detail"}, as The Desk's). Seed { types, accounts }; desk.editType(id, change) is an edit on The Desk
//   (version + 1; a checked type goes back to not_checked). Made-up firm values and SIM-A style accounts only.
// Chart 1.35.0: notes on POST /api/trade-tags (dim "note") come back apart under `notes` on GET, as The Desk's; desk.refuseTags
//   (a function of a record: a reason, or '') refuses records as The Desk's `rejected`; GET /api/chart-floors answers seed.floors
//   ({accounts, skipped}); GET /api/chart-league answers seed.league (the SAMPLE league day: status, trades, open, decisions); with ?date=,
//   desk.leagueDays[date] or that date with no record.
import http from 'node:http';

/* Chart 1.32.0: a few more firms and plans for the type picker (Firm, Plan, Size), named as The Desk names its types ("<Plan>
   <Size>K <rest>"). Real firm names, made-up values and ids (sample data only); each row takes the caller's defaults for the rest. */
export function sampleFirmTypes() {
  const t = (id, firm, name, size, o) => Object.assign({ id, firm, name, account_size: size, drawdown: Math.round(size * 0.04), drawdown_type: 'eod', lock_at: null, daily_loss: null, notes: 'sample values for the test' }, o || {});
  return [t('sample-topstep-tc-100k', 'Topstep', 'Trading Combine 100K', 100000), t('sample-topstep-tc-50k', 'Topstep', 'Trading Combine 50K', 50000),
    t('sample-topstep-xfa-50k', 'Topstep', 'Express Funded 50K', 50000, { account_type: 'funded' }),
    t('sample-bulenox-m25-f', 'Bulenox', 'Master 25K Funded', 25000, { account_type: 'funded' }), t('sample-bulenox-m25-o2', 'Bulenox', 'Master 25K Option 2 EOD', 25000),
    t('sample-bulenox-legacy', 'Bulenox', 'Legacy plan', 50000),
    t('sample-fundednext-d50', 'FundedNext', 'Direct 50K Account', 50000, { account_type: 'funded', drawdown_type: 'static' })];
}

export const KEY_IDS = ['buy', 'sell', 'be', 'close', 'flattenAll', 'cutHalf', 'merge', 'maximize', 'accept', 'reject'];   // release 1 (1.6c): The Desk with cutHalf (thedesk claude/desk-hotkeys-cut-half)
const exact = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k));
const COMBO = /^(Ctrl\+)?(Alt\+)?(Shift\+)?([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Num[0-9]|Num[-+*/.]|[-=[\];',./\\`])$/;

export function emptyDocs() {
  return { hotkeys: { rev: 0, keys: Object.fromEntries(KEY_IDS.map(k => [k, ''])), modifiers: { limit: '', stop: '' } }, strategies: { rev: 0, strategies: [] } };
}
/* The Desk's own checks, written apart from the page's (a shape check is enough for a fake) */
/* oldDesk: The Desk before the bar trail (it refuses a barTrail key, as The Desk of the Sunday 11-01 release does) */
function check(which, d, oldDesk) {
  if (which === 'hotkeys') {
    if (!exact(d, ['rev', 'keys', 'modifiers'])) return 'the hotkeys need exactly rev, keys and modifiers';
    if (!exact(d.keys, KEY_IDS)) return 'keys has unknown or missing actions';
    const seen = new Set();
    for (const k of KEY_IDS) { const c = d.keys[k]; if (typeof c !== 'string' || (c && !COMBO.test(c))) return 'keys.' + k + ' is not a combo'; if (c && seen.has(c)) return c + ' is used twice'; if (c) seen.add(c); }
    if (!exact(d.modifiers, ['limit', 'stop']) || !['', 'Shift', 'Ctrl', 'Alt'].includes(d.modifiers.limit) || !['', 'Shift', 'Ctrl', 'Alt'].includes(d.modifiers.stop)) return 'modifiers must be "", Shift, Ctrl or Alt';
    return '';
  }
  if (!exact(d, ['rev', 'strategies']) || !Array.isArray(d.strategies) || d.strategies.length > 24) return 'the strategies need exactly rev and strategies (at most 24)';
  for (let i = 0; i < d.strategies.length; i++) {
    const s = d.strategies[i];
    const KEYS = ['id', 'name', 'stop', 'targets', 'breakeven', 'trail', 'hotkey'];
    /* next release: an optional barTrail { bars 1 to 50, offsetTicks 0 to 100 }, never with trail (the chart's checkStrategy) */
    if (!exact(s, KEYS) && (oldDesk || !exact(s, KEYS.concat(['barTrail'])))) return 'strategies[' + i + '] has unknown or missing keys';
    if ('barTrail' in s) {
      const b = s.barTrail;
      const bk = b && typeof b === 'object' ? Object.keys(b) : [];
      if (!b || !('bars' in b) || !('offsetTicks' in b) || bk.some(k => !['bars', 'offsetTicks', 'type', 'size', 'startTicks'].includes(k)) || !Number.isInteger(b.bars) || b.bars < 1 || b.bars > 50 || !Number.isInteger(b.offsetTicks) || b.offsetTicks < 0 || b.offsetTicks > 100) return 'strategies[' + i + '] barTrail needs bars 1 to 50 and offsetTicks 0 to 100';
      /* Anthony 2026-11-01: type 'minute' (1 to 60, dividing the hour) or 'range' (1 to 400 ticks) with size, both or neither; startTicks 0 to 2000 */
      if (('type' in b) !== ('size' in b)) return 'strategies[' + i + '] barTrail type and size go together';
      if ('type' in b && !(b.type === 'minute' && [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60].includes(b.size)) && !(b.type === 'range' && Number.isInteger(b.size) && b.size >= 1 && b.size <= 400)) return 'strategies[' + i + '] barTrail type and size are minute 1 to 60 or range 1 to 400';
      if ('startTicks' in b && !(Number.isInteger(b.startTicks) && b.startTicks >= 0 && b.startTicks <= 2000)) return 'strategies[' + i + '] barTrail startTicks must be 0 to 2000';
      if (s.trail !== null) return 'strategies[' + i + '] has trail and barTrail: one trail per strategy';
    }
    if (!exact(s.stop, ['ticks', 'type', 'limitOffsetTicks'])) return 'strategies[' + i + '] stop needs ticks, type and limitOffsetTicks';
    if (!Array.isArray(s.targets) || !s.targets.length || s.targets.length > 3) return 'strategies[' + i + '] needs 1 to 3 targets';
    if (s.targets.reduce((a, t) => a + t.sharePct, 0) !== 100) return 'strategies[' + i + '] targets must add up to 100';
  }
  return '';
}

/* chart 1.62.0: the plan log's checks and its <plan> object, as TheDesk's thedesk/plans.py (validate_plan, state_of, plan_view) */
const PLAN_FIELDS = ['uid', 'pc', 'account', 'root', 'contract', 'side', 'entry_type', 'entry', 'stop', 'target', 'qty', 'tick', 'expiry_min', 'grade', 'setup_name', 'why'];
function planCheck(d, submit) {
  if (!d || typeof d !== 'object') return 'send a JSON object';
  if (submit) {
    const unknown = Object.keys(d).filter(k => !PLAN_FIELDS.includes(k));
    if (unknown.length) return 'unknown field(s): ' + unknown.sort().join(', ');
    if (typeof d.uid !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(d.uid)) return 'uid must be 6 to 64 letters, digits, - or _';
    if (typeof d.pc !== 'string' || !d.pc) return 'pc is required';
    if (typeof d.contract !== 'string' || !new RegExp('^' + d.root + ' \\d\\d-\\d\\d$').test(d.contract)) return 'contract must be the ' + d.root + ' contract as NinjaTrader names it';
    if (d.tick !== undefined && d.tick !== null && d.tick !== 0.25) return 'tick must be 0.25 for ' + d.root;
  }
  if (!['MNQ', 'NQ', 'MES', 'ES'].includes(d.root)) return 'root must be one of MNQ, NQ, MES, ES';
  if (!['long', 'short'].includes(d.side)) return 'side must be long or short';
  if (!['limit', 'market_on_touch', 'touch_confirm'].includes(d.entry_type)) return 'entry_type must be one of limit, market_on_touch, touch_confirm';
  for (const k of ['entry', 'stop', 'target']) if (typeof d[k] !== 'number' || Math.abs(d[k] / 0.25 - Math.round(d[k] / 0.25)) > 1e-9) return k + ' must be on the tick grid';
  const sg = d.side === 'long' ? 1 : -1;
  if (!((d.entry - d.stop) * sg > 0)) return 'a ' + d.side + '\'s stop must be ' + (sg > 0 ? 'below' : 'above') + ' its entry';
  if (!((d.target - d.entry) * sg > 0)) return 'a ' + d.side + '\'s target must be ' + (sg > 0 ? 'above' : 'below') + ' its entry';
  if (!Number.isInteger(d.qty) || d.qty < 1) return 'qty must be a whole number';
  if (d.expiry_min !== undefined && d.expiry_min !== null && !(Number.isInteger(d.expiry_min) && d.expiry_min >= 1 && d.expiry_min <= 30)) return 'expiry_min must be 1 to 30';
  if (d.grade !== undefined && d.grade !== null && !['A+', 'A', 'B'].includes(d.grade)) return 'grade must be one of A+, A, B';
  if (typeof d.account !== 'string' || !d.account) return 'account is required';
  return '';
}
const planValues = d => ({ account: d.account, side: d.side, entry_type: d.entry_type, entry: d.entry, stop: d.stop, target: d.target, qty: d.qty,
  expiry_min: d.expiry_min === undefined || d.expiry_min === null ? 30 : d.expiry_min, grade: d.grade || 'A+', setup_name: d.setup_name || null, why: d.why || null });
function planView(v) {
  const evs = v.events, fi = evs.findIndex(e => e.kind === 'filled');
  const ENDS = ['cancel', 'expired', 'stop_through', 'missed', 'refused', 'closed', 'ended'], PROGRESS = ['armed', 'touched', 'confirmed', 'sent', 'placed', 'filled'];
  const end = fi >= 0 ? evs.slice(fi + 1).find(e => e.kind === 'closed' || e.kind === 'ended') : evs.find(e => ENDS.includes(e.kind));
  let status = 'submitted';
  for (const e of evs) { const k = e.kind === 'arm' ? 'armed' : e.kind; if (PROGRESS.includes(k) && PROGRESS.indexOf(k) >= PROGRESS.indexOf(status)) status = k; }
  const arm = evs.find(e => e.kind === 'arm'), sent = evs.find(e => e.kind === 'sent');
  const exec = []; for (const e of evs) if (e.kind === 'filled') for (const x of e.detail.exec_ids || []) if (!exec.includes(x)) exec.push(x);
  const flags = []; for (const e of evs) for (const f of e.detail.desk_flags || []) if (!flags.includes(f)) flags.push(f);
  return Object.assign({ seq: v.seq, uid: v.uid, logged_at_ms: v.logged_at_ms, pc: v.pc, root: v.root, contract: v.contract, tick: v.tick }, v.values, {
    submitted: v.submitted, status: end ? end.kind : status, live: !end, ended: end ? { kind: end.kind, seq: end.seq, at_ms: end.logged_at_ms } : null,
    armed_at_ms: arm ? arm.logged_at_ms : null, expires_at_ms: arm ? arm.detail.expires_at_ms : null, entry_cid: sent ? sent.detail.cid || null : null,
    nt_order_id: (evs.find(e => (e.kind === 'placed' || e.kind === 'filled') && e.detail.nt_order_id) || { detail: {} }).detail.nt_order_id || null,
    fill_exec_ids: exec, flags, events: evs.map(e => Object.assign({}, e)), row_hash: 'sample' });
}

export async function startDesk(port, seed) {
  const docs = Object.assign(emptyDocs(), JSON.parse(JSON.stringify(seed || {})));
  const types = JSON.parse(JSON.stringify((seed && seed.types) || [])), accounts = JSON.parse(JSON.stringify((seed && seed.accounts) || []));
  const floors = (seed && seed.floors) || null, league = (seed && seed.league) || null;
  delete docs.types; delete docs.accounts; delete docs.floors; delete docs.league;
  const desk = { docs, types, accounts, floors, league, tags: [], log: [], down: false, refuseTags: null, plans: [], chain: 0, planFlags: [], opinion: null, opinionAsks: [], noPlans: false, notLive: false, closed: false, expiryMs: 0, bump(which) { docs[which].rev++; }, close: () => new Promise(r => server.close(r)),
    editType(id, change) { const t = types.find(x => x.id === id); Object.assign(t, change, { version: t.version + 1, status: 'not_checked', updated_at: new Date().toISOString() }); } };
  const typeLink = id => { const t = types.find(x => x.id === id); return t ? { id: t.id, firm: t.firm, name: t.name, version: t.version, status: t.status } : null; };
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    if (desk.down) { req.socket.destroy(); return; }
    const cors = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, PUT, POST', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' } : {};
    const send = (status, body) => { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors)); res.end(JSON.stringify(body)); };
    const m = /^\/api\/chart-(hotkeys|strategies)$/.exec(req.url.split('?')[0]);
    if (req.method === 'OPTIONS') { if (!cors['Access-Control-Allow-Origin']) { res.writeHead(403); res.end(); return; } res.writeHead(204, cors); res.end(); return; }
    const [urlPath, query] = req.url.split('?');
    /* chart 1.34.0: the Trade tags panel's records (TheDesk POST and GET /api/trade-tags): stored once by id, never changed */
    /* chart 1.62.0: the planner's plan log as TheDesk's claude/planner-desk answers it (thedesk/plans.py, api/plans_routes.py;
       docs/API.md "Plans"): POST /api/plans (Submit: exactly its fields, any other a 400; idempotent on uid, the same uid with other
       values a 409), /{seq}/edit (status submitted only), /{seq}/arm ({uid?, detail?}; expires_at_ms on this clock, Arm + expiry_min
       or desk.expiryMs; a 409 once armed or ended, or while desk.closed), /{seq}/cancel ({uid?, reason?, detail?}; refused once
       filled or ended), /{seq}/events ({uid, kind, detail?}: recorded, never refused for state; `filled` needs exec_ids; a second
       sent of the entry flagged in detail.desk_flags and desk.planFlags); answers { plan, duplicate } (Arm adds expires_at_ms);
       GET /api/plans?live=1&pc= { live, now_ms, plans }, GET /api/plans/{seq} { plan, links }. desk.noPlans: an older Desk (404);
       desk.notLive: a Desk that is not the live one (every write a 409). CORS here allows any localhost port (a test page's); The
       Desk allows its two 8765 origins only. Sample data only. */
    if (/^\/api\/plans(\/|$)/.test(urlPath)) {
      if (desk.noPlans) return send(404, { detail: 'Not Found' });
      const pm = /^\/api\/plans(?:\/(\d+)(?:\/(arm|cancel|edit|events|opinion))?)?$/.exec(urlPath);
      if (!pm) return send(404, { detail: 'Not Found' });
      const seq = pm[1] ? +pm[1] : null, act = pm[2] || null, P = seq ? desk.plans.find(x => x.seq === seq) : null;
      const view = v => planView(v);
      if (req.method === 'GET') {
        desk.log.push({ method: 'GET', which: 'plans', url: req.url });
        if (seq) return P ? send(200, { plan: view(P), links: {} }) : send(404, { detail: 'no plan #' + seq });
        const q = new URLSearchParams(query || '');
        return send(200, { live: true, now_ms: Date.now(), plans: desk.plans.slice().reverse().map(view).filter(v => (q.get('pc') === null || v.pc === q.get('pc')) && (q.get('live') !== '1' || v.live)) });
      }
      if (req.method !== 'POST') return send(405, { detail: 'Method not allowed' });
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let d; try { d = body ? JSON.parse(body) : {}; } catch (e) { return send(400, { detail: 'send JSON with Content-Type: application/json' }); }
        desk.log.push({ method: 'POST', which: 'plans', url: urlPath, body: d });
        if (desk.notLive) return send(409, { detail: 'This Desk is not the live Desk (THEDESK_LIVE is not set), so A+ calls are not logged or exported here.' });
        const uidOk = u => typeof u === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(u);
        const ev = (v, kind, detail, uid) => { v.events.push({ seq: ++desk.chain, uid: uid || 'desk-' + desk.chain, kind, logged_at_ms: Date.now(), detail: detail || {} }); };
        const dupOf = (v, uid, kind) => { const e = uid ? v.events.find(x => x.uid === uid) : null; if (!e) return null; return e.kind === kind ? 'dup' : 'clash'; };
        if (!seq) {
          const why = planCheck(d, true);
          if (why) return send(400, { detail: why });
          const was = desk.plans.find(v => v.uid === d.uid);
          const vals = planValues(d);
          if (was) return JSON.stringify(was.values) === JSON.stringify(vals) && was.pc === d.pc ? send(200, { plan: view(was), duplicate: true }) : send(409, { detail: 'uid ' + d.uid + ' is already plan #' + was.seq + ' with other values' });
          const v = { seq: ++desk.chain, uid: d.uid, pc: d.pc, root: d.root, contract: d.contract, tick: 0.25, logged_at_ms: Date.now(), values: vals, submitted: vals, events: [] };
          desk.plans.push(v); return send(200, { plan: view(v), duplicate: false });
        }
        if (!P) return send(404, { detail: 'no plan #' + seq });
        const st = view(P);
        /* chart 1.64.0 (phase 6 part B): POST /{seq}/opinion { uid, context: { bars_1m, bars_5m, levels, lines } }, as the contract
           of TheDesk's claude/planner-opinion-desk: desk.opinion null: a Desk without it (404); { off: true }: { status: 'off' },
           nothing stamped; else after delayMs one `opinion` fact stamped by The Desk (its detail: desk.opinion.detail and on_seq)
           and { plan }; idempotent (a second ask answers the plan as it is), 409 "asking" while one is in flight. Every ask is kept
           in desk.opinionAsks. Sample answers only: no model is asked here. */
        if (act === 'opinion') {
          if (Object.keys(d).some(k => !['uid', 'context'].includes(k)) || !uidOk(d.uid) || !d.context || typeof d.context !== 'object') return send(400, { detail: 'send {"uid": ..., "context": {...}}' });
          if (Object.keys(d.context).sort().join(',') !== 'bars_1m,bars_5m,levels,lines') return send(400, { detail: 'context is {bars_1m, bars_5m, levels, lines}' });
          desk.opinionAsks.push({ seq, body: d, at: Date.now() });
          const O = desk.opinion;
          if (!O) return send(404, { detail: 'Not Found' });
          if (O.off) return send(200, { status: 'off' });
          if (P.events.some(e => e.kind === 'opinion')) return send(200, { plan: view(P), duplicate: true });
          if (P.asking) return send(409, { detail: 'asking' });
          P.asking = true;
          const onSeq = [P.seq].concat(P.events.filter(e => e.kind === 'edit').map(e => e.seq)).pop();
          setTimeout(() => { P.asking = false; ev(P, 'opinion', Object.assign({ on_seq: onSeq }, JSON.parse(JSON.stringify(O.detail || {})))); send(200, { plan: view(P), duplicate: false }); }, O.delayMs || 0);
          return;
        }
        if (act === 'events') {
          const FACTS = ['sent', 'placed', 'refused', 'touched', 'confirmed', 'filled', 'closed', 'expired', 'stop_through', 'missed', 'override', 'owner', 'ended'];
          if (Object.keys(d).some(k => !['uid', 'kind', 'detail'].includes(k)) || !uidOk(d.uid)) return send(400, { detail: 'send {"uid": ..., "kind": ..., "detail": {...}}' });
          if (!FACTS.includes(d.kind)) return send(400, { detail: 'kind must be one of ' + FACTS.join(', ') });
          const det = Object.assign({}, d.detail || {});
          if (Object.keys(det).some(k => k.startsWith('desk_'))) return send(400, { detail: 'detail keys starting with desk_ are The Desk\'s own' });
          if (d.kind === 'filled' && !(Array.isArray(det.exec_ids) && det.exec_ids.length >= 1 && det.exec_ids.length <= 50 && det.exec_ids.every(x => typeof x === 'string' && x))) return send(400, { detail: 'a filled event\'s detail needs exec_ids' });
          const dup = dupOf(P, d.uid, d.kind);
          if (dup === 'dup') return send(200, { plan: view(P), duplicate: true });
          if (dup === 'clash') return send(409, { detail: 'uid ' + d.uid + ' is already another event' });
          const flags = [];
          if (d.kind === 'sent' && (det.leg || 'entry') === 'entry') {
            if (P.events.some(e => e.kind === 'sent' && (e.detail.leg || 'entry') === 'entry')) flags.push('second_sent_entry');
            if (st.armed_at_ms === null) flags.push('sent_before_arm');
            else if (st.expires_at_ms !== null && (Number.isInteger(det.at_ms) ? det.at_ms : Date.now()) > st.expires_at_ms) flags.push('sent_after_expiry');   // The Desk judges it on detail.at_ms
          }
          if (['sent', 'placed', 'filled'].includes(d.kind) && st.ended) flags.push(d.kind + '_after_end');
          if (flags.length) { det.desk_flags = flags; desk.planFlags.push({ seq, flags }); }
          ev(P, d.kind, det, d.uid);
          return send(200, { plan: view(P), duplicate: false });
        }
        if (d.uid !== undefined && d.uid !== null && !uidOk(d.uid)) return send(400, { detail: 'uid must be 6 to 64 letters, digits, - or _' });
        const dup = dupOf(P, d.uid, act === 'arm' ? 'arm' : act);
        if (dup === 'dup') return send(200, Object.assign({ plan: view(P), duplicate: true }, act === 'arm' ? { expires_at_ms: view(P).expires_at_ms } : {}));
        if (dup === 'clash') return send(409, { detail: 'uid ' + d.uid + ' is already another event' });
        if (act === 'arm') {
          if (Object.keys(d).some(k => !['uid', 'detail'].includes(k))) return send(400, { detail: 'send {"uid": ..., "detail": {...}} (both optional)' });
          if (st.ended) return send(409, { detail: 'plan #' + seq + ' already ended (' + st.ended.kind + '): not armed' });
          if (st.armed_at_ms !== null) return send(409, { detail: 'plan #' + seq + ' is already armed (it expires at ' + st.expires_at_ms + ')' });
          if (desk.closed) return send(409, { detail: 'CME is closed (the 17:00 to 18:00 break): not armed' });
          const exp = Date.now() + (desk.expiryMs || P.values.expiry_min * 60000);
          ev(P, 'arm', Object.assign({ expires_at_ms: exp, expiry_min: P.values.expiry_min }, d.detail && typeof d.detail === 'object' ? { client: d.detail } : {}), d.uid);
          return send(200, { plan: view(P), duplicate: false, expires_at_ms: exp });
        }
        if (act === 'cancel') {
          if (Object.keys(d).some(k => !['uid', 'reason', 'detail'].includes(k))) return send(400, { detail: 'send {"uid": ..., "reason": ..., "detail": {...}} (all optional)' });
          if (st.fill_exec_ids.length) return send(409, { detail: 'plan #' + seq + ' is filled: its position is closed with Flatten on the chart, not Cancel' });
          if (st.ended) return send(409, { detail: 'plan #' + seq + ' already ended (' + st.ended.kind + '): nothing to cancel' });
          ev(P, 'cancel', d.reason ? { reason: d.reason } : {}, d.uid);
          return send(200, { plan: view(P), duplicate: false });
        }
        if (act === 'edit') {
          const EDITABLE = ['account', 'side', 'entry_type', 'entry', 'stop', 'target', 'qty', 'expiry_min', 'grade', 'setup_name', 'why'];
          const bad = Object.keys(d).filter(k => k !== 'uid' && !EDITABLE.includes(k));
          if (bad.length) return send(400, { detail: 'unknown or fixed field(s): ' + bad.join(', ') });
          if (st.status !== 'submitted' || st.armed_at_ms !== null) return send(409, { detail: 'plan #' + seq + ' is ' + st.status + ': edit it before Arm, or Cancel it and submit a new one' });
          const next = Object.assign({}, P.values, d); delete next.uid;
          const why = planCheck(Object.assign({ root: P.root }, next), false);
          if (why) return send(400, { detail: why });
          P.values = planValues(next);
          ev(P, 'edit', { values: P.values }, d.uid);
          return send(200, { plan: view(P), duplicate: false });
        }
        return send(404, { detail: 'Not Found' });
      });
      return;
    }
    if (urlPath === '/api/trade-tags' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let d; try { d = JSON.parse(body); } catch (e) { return send(400, { detail: 'send JSON with Content-Type: application/json' }); }
        if (!d || !Array.isArray(d.tags)) return send(400, { detail: 'send {"tags": [...]}' });
        let inserted = 0, duplicates = 0;
        const rejected = [];
        d.tags.forEach((t, index) => {
          const why = typeof desk.refuseTags === 'function' ? desk.refuseTags(t) : '';
          if (why) { rejected.push({ index, id: t.id, reason: why }); return; }
          if (desk.tags.some(x => x.id === t.id)) duplicates++; else { desk.tags.push(t); inserted++; }
        });
        desk.log.push({ method: 'POST', which: 'trade-tags', body: d });
        send(200, { received: d.tags.length, rejected, inserted, duplicates, conflicts: [] });
      });
      return;
    }
    if (urlPath === '/api/trade-tags' && req.method === 'GET') {
      const q = new URLSearchParams(query || '');
      desk.log.push({ method: 'GET', which: 'trade-tags' });
      const hit = desk.tags.filter(t => (!q.get('account') || t.account === q.get('account')) && (!q.get('root') || t.root === q.get('root')) && (!q.get('since_ms') || t.at_ms >= +q.get('since_ms')));
      return send(200, { tags: hit.filter(t => t.dim !== 'note'), notes: hit.filter(t => t.dim === 'note') });
    }
    if (urlPath === '/api/chart-floors' && req.method === 'GET') {
      desk.log.push({ method: 'GET', which: 'chart-floors' });
      return desk.floors ? send(200, desk.floors) : send(404, { detail: 'Not Found' });
    }
    if (urlPath === '/api/chart-colosseum' && req.method === 'GET') {
      /* 1.57.0: the Colosseum's leaderboard (The Desk's colosseum.py): desk.colosseum (SAMPLE), else 404 as an older Desk */
      desk.log.push({ method: 'GET', which: 'chart-colosseum' });
      return desk.colosseum ? send(200, desk.colosseum) : send(404, { detail: 'Not Found' });
    }
    if (urlPath === '/api/chart-league' && req.method === 'GET') {
      /* ?date=YYYY-MM-DD (The Desk's read_day): desk.leagueDays[date] (SAMPLE), else that date with no record, as The Desk answers */
      const date = new URLSearchParams(query || '').get('date');
      desk.log.push({ method: 'GET', which: 'chart-league', date: date || null });
      if (!desk.league) return send(404, { detail: 'Not Found' });
      if (date === null) return send(200, desk.league);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(400, { detail: 'date must be YYYY-MM-DD' });
      const past = desk.leagueDays && desk.leagueDays[date];
      return send(200, past || { shadow: 'SHADOW: no orders', folder: desk.league.folder, status: desk.league.status || null, date,
        day: { date, closed: false, note: null }, league: desk.league.league || null, trades: [], open: [], decisions: [] });
    }
    if (urlPath === '/api/account-types' && req.method === 'GET') {
      desk.log.push({ method: 'GET', which: 'account-types' });
      return send(200, { v: 1, types: types.filter(t => !t.archived || /(^|&)all=1(&|$)/.test(query || '')), asOf: new Date().toISOString() });
    }
    if (urlPath === '/api/chart-accounts' && req.method === 'GET') {
      desk.log.push({ method: 'GET', which: 'chart-accounts' });
      return send(200, { accounts: accounts.map(a => Object.assign({}, a, { accountType: typeLink(a.account_type || null) })) });
    }
    const at = /^\/api\/accounts\/([^/]+)\/account-type$/.exec(urlPath);
    if (at && req.method === 'PUT') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let d; try { d = JSON.parse(body); } catch (e) { return send(400, { detail: 'Bad JSON' }); }
        const name = decodeURIComponent(at[1]);
        desk.log.push({ method: 'PUT', which: 'account-type', account: name, body: d });
        if (!d || typeof d !== 'object' || !('account_type' in d) || (d.account_type !== null && typeof d.account_type !== 'string')) return send(400, { detail: 'account_type must be a type id or null' });
        const want = d.account_type === null ? null : types.find(t => t.id === d.account_type);
        if (d.account_type !== null && !want) return send(404, { detail: 'no account type ' + d.account_type });
        if (want && want.archived) return send(409, { detail: 'account type ' + d.account_type + ' is archived' });
        let row = accounts.find(a => a.account === name);
        if (!row) { row = { account: name, firm: null, archived: false, daily_loss_limit: null, trailing_drawdown: null, account_size: null }; accounts.push(row); }
        row.account_type = d.account_type;
        send(200, { account: name, account_type: d.account_type });
      });
      return;
    }
    if (!m) return send(404, { detail: 'Not found' });
    const which = m[1];
    if (req.method === 'GET') { desk.log.push({ method: 'GET', which }); return send(200, docs[which]); }
    if (req.method !== 'PUT') return send(405, { detail: 'Method not allowed' });
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let d;
      try { d = JSON.parse(body); } catch (e) { return send(400, { detail: 'Bad JSON' }); }
      desk.log.push({ method: 'PUT', which, body: d });
      const why = check(which, d, desk.oldDesk);
      if (why) return send(400, { detail: why });
      if (d.rev !== docs[which].rev) return send(409, { detail: 'stale rev ' + d.rev + ': the ' + which + ' are at rev ' + docs[which].rev + '. Read them again.' });
      docs[which] = Object.assign({}, d, { rev: d.rev + 1 });
      send(200, docs[which]);
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return desk;
}
