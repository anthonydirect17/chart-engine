// A fake Desk for the chart page's tests (chart 1.16.0): GET/PUT /api/chart-hotkeys and /api/chart-strategies as
// TheDesk docs/API.md "Desk endpoints used by the chart page" describes them (and DESK_SETTINGS_CONTRACT draft v1): a whole
// document with a `rev`, the stored rev + 1 on a PUT, 409 on a stale rev, 400 with { detail } on a bad shape, CORS for a
// localhost page (the real one allows http://localhost:8765 and http://127.0.0.1:8765 only; a test page has another port).
// Sample data only. With `down` set it answers nothing (the connection is dropped), as a Desk that is not running.
//   const desk = await startDesk(port, { hotkeys, strategies });  desk.docs, desk.log, desk.down = true, desk.bump(which), desk.close()
import http from 'node:http';

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
  const desk = { docs, log: [], down: false, bump(which) { docs[which].rev++; }, close: () => new Promise(r => server.close(r)) };
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    if (desk.down) { req.socket.destroy(); return; }
    const cors = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, PUT', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' } : {};
    const send = (status, body) => { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors)); res.end(JSON.stringify(body)); };
    const m = /^\/api\/chart-(hotkeys|strategies)$/.exec(req.url.split('?')[0]);
    if (req.method === 'OPTIONS') { if (!cors['Access-Control-Allow-Origin']) { res.writeHead(403); res.end(); return; } res.writeHead(204, cors); res.end(); return; }
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
