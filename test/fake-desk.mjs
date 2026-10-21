// A fake Desk for the chart page's tests (chart 1.16.0): GET/PUT /api/chart-hotkeys and /api/chart-strategies as
// TheDesk docs/API.md "Desk endpoints used by the chart page" describes them (and DESK_SETTINGS_CONTRACT draft v1): a whole
// document with a `rev`, the stored rev + 1 on a PUT, 409 on a stale rev, 400 with { detail } on a bad shape, CORS for a
// localhost page (the real one allows http://localhost:8765 and http://127.0.0.1:8765 only; a test page has another port).
// Sample data only. With `down` set it answers nothing (the connection is dropped), as a Desk that is not running.
//   const desk = await startDesk(port, { hotkeys, strategies });  desk.docs, desk.log, desk.down = true, desk.bump(which), desk.close()
// Chart 1.30.0 (wave 5, SPEC "account types"): the account types ledger as the spec's API contract gives it, for the chart page only:
//   GET /api/account-types ({"v":1,"types":[...every field...],"asOf"}; archived left out unless ?all=1), GET /api/chart-accounts
//   (rows gain "accountType": {id, firm, name, version, status} or null) and PUT /api/accounts/{account}/account-type
//   ({"account_type": id|null}; 404 for an unknown type, 409 for an archived one, errors as {"detail"}, as The Desk's). Seed { types, accounts }; desk.editType(id, change) is an edit on The Desk
//   (version + 1; a checked type goes back to not_checked). Made-up firm values and SIM-A style accounts only.
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

export const KEY_IDS = ['buy', 'sell', 'be', 'close', 'flattenAll', 'merge', 'maximize', 'accept', 'reject'];
const exact = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k));
const COMBO = /^(Ctrl\+)?(Alt\+)?(Shift\+)?([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Num[0-9]|Num[-+*/.]|[-=[\];',./\\`])$/;

export function emptyDocs() {
  return { hotkeys: { rev: 0, keys: Object.fromEntries(KEY_IDS.map(k => [k, ''])), modifiers: { limit: '', stop: '' } }, strategies: { rev: 0, strategies: [] } };
}
/* The Desk's own checks, written apart from the page's (a shape check is enough for a fake) */
function check(which, d) {
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
    if (!exact(s, ['id', 'name', 'stop', 'targets', 'breakeven', 'trail', 'hotkey'])) return 'strategies[' + i + '] has unknown or missing keys';
    if (!exact(s.stop, ['ticks', 'type', 'limitOffsetTicks'])) return 'strategies[' + i + '] stop needs ticks, type and limitOffsetTicks';
    if (!Array.isArray(s.targets) || !s.targets.length || s.targets.length > 3) return 'strategies[' + i + '] needs 1 to 3 targets';
    if (s.targets.reduce((a, t) => a + t.sharePct, 0) !== 100) return 'strategies[' + i + '] targets must add up to 100';
  }
  return '';
}

export async function startDesk(port, seed) {
  const docs = Object.assign(emptyDocs(), JSON.parse(JSON.stringify(seed || {})));
  const types = JSON.parse(JSON.stringify((seed && seed.types) || [])), accounts = JSON.parse(JSON.stringify((seed && seed.accounts) || []));
  delete docs.types; delete docs.accounts;
  const desk = { docs, types, accounts, tags: [], log: [], down: false, bump(which) { docs[which].rev++; }, close: () => new Promise(r => server.close(r)),
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
    if (urlPath === '/api/trade-tags' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let d; try { d = JSON.parse(body); } catch (e) { return send(400, { detail: 'send JSON with Content-Type: application/json' }); }
        if (!d || !Array.isArray(d.tags)) return send(400, { detail: 'send {"tags": [...]}' });
        let inserted = 0, duplicates = 0;
        for (const t of d.tags) { if (desk.tags.some(x => x.id === t.id)) duplicates++; else { desk.tags.push(t); inserted++; } }
        desk.log.push({ method: 'POST', which: 'trade-tags', body: d });
        send(200, { received: d.tags.length, rejected: [], inserted, duplicates, conflicts: [] });
      });
      return;
    }
    if (urlPath === '/api/trade-tags' && req.method === 'GET') {
      const q = new URLSearchParams(query || '');
      desk.log.push({ method: 'GET', which: 'trade-tags' });
      return send(200, { tags: desk.tags.filter(t => (!q.get('account') || t.account === q.get('account')) && (!q.get('root') || t.root === q.get('root')) && (!q.get('since_ms') || t.at_ms >= +q.get('since_ms'))) });
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
      const why = check(which, d);
      if (why) return send(400, { detail: why });
      if (d.rev !== docs[which].rev) return send(409, { detail: 'stale rev ' + d.rev + ': the ' + which + ' are at rev ' + docs[which].rev + '. Read them again.' });
      docs[which] = Object.assign({}, d, { rev: d.rev + 1 });
      send(200, docs[which]);
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return desk;
}
