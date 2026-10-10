// A fake PC helper (Bot-Lab manrae/helper.py) for the On/Off smoke: http://localhost:8767 by default, the same gate as the
// real one (Host localhost:<port> or 127.0.0.1:<port>, Origin exactly the fake bridge's page, the page's PIN unlock checked
// with the fake bridge's GET /session on every call, CORS for that origin alone) and the same routes (GET /status, POST /on,
// /off, /settings). "Running" the agent is the fake bridge's /test/agent-connect (its hello with the build's name), "off" is
// /test/agent-connect?on=0. The builds, names, stamps and dollars are made up: sample data only.
//   const h = await startFakeHelper({ bridgePort, port });  h.calls (every route asked, in order), h.status (its state),
//   h.setDown(true) (answers nothing, as a PC with no helper), h.setForbid(true) (403, as for another page), h.close()
import http from 'node:http';

const UNLOCK = 'x-chartbridge-unlock';
export const BUILDS = [
  { build: 'sample-build-1', stamp: 'aaaaaaaaaaaa', hero: 'Demo', here: true, shadowOk: true, trades: 40, meanR: 0.2, dollars: 900, frozenAt: '2026-10-05' },
  { build: 'sample-build-3', stamp: 'cccccccccccc', hero: 'Demo 2', here: false, shadowOk: true, trades: 25, meanR: 0.1, dollars: 300, frozenAt: '2026-10-07' },
  { build: 'sample-build-2', stamp: 'bbbbbbbbbbbb', hero: null, here: true, shadowOk: true, trades: 5, meanR: 0.4, dollars: 100, frozenAt: '2026-10-08' },
  { build: 'sample-build-4', stamp: 'dddddddddddd', hero: null, here: true, shadowOk: false, trades: 2, meanR: -0.1, dollars: -50, frozenAt: '2026-10-09' },
];

export async function startFakeHelper({ bridgePort, port = 8767, agents = ['demo'] }) {
  const origin = 'http://localhost:' + bridgePort, hosts = ['localhost:' + port, '127.0.0.1:' + port];
  const calls = [];
  let down = false, forbid = false;
  const state = Object.fromEntries(agents.map(a => [a, { on: false, running: false, why: 'off', build: null, runningBuild: null, hero: null, since: null,
    autoOn: '', cap: null, lastExit: null, spend: { session: 1.8412, overall: 1234.5, date: '2026-10-12' } }]));
  const control = (what, q) => fetch('http://127.0.0.1:' + bridgePort + '/test/' + what + '?' + new URLSearchParams(q), { method: 'POST' }).then(r => r.json());
  const unlocked = async token => {
    if (!/^v1\.[0-9a-f]{32}\.[0-9a-f]{64}$/.test(token || '')) return false;
    const r = await new Promise(res => {
      const q = http.request({ host: '127.0.0.1', port: bridgePort, path: '/session', headers: { Host: 'localhost:' + bridgePort, 'X-ChartBridge-Unlock': token } }, x => { x.resume(); res(x.statusCode); });
      q.on('error', () => res(0)); q.end();
    });
    return r === 200;
  };
  const server = http.createServer(async (req, res) => {
    if (down) { req.socket.destroy(); return; }
    const send = (code, obj) => { const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }; if (req.headers.origin === origin) { h['Access-Control-Allow-Origin'] = origin; h.Vary = 'Origin'; } res.writeHead(code, h); res.end(obj ? JSON.stringify(obj) : ''); };
    if (!hosts.includes(req.headers.host) || req.headers.origin !== origin || (forbid && req.method !== 'OPTIONS')) return send(403, { error: 'only ChartBridge\'s own page' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, X-ChartBridge-Unlock', Vary: 'Origin' });
      return res.end();
    }
    if (!(await unlocked(req.headers[UNLOCK]))) return send(401, { error: 'unlock ChartBridge\'s page with its PIN' });
    const route = req.method + ' ' + req.url;
    let body = null;
    if (req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c;
      try { body = JSON.parse(raw); } catch (e) { return send(400, { error: 'send one small JSON object' }); }
    }
    calls.push({ route, body, at: Date.now() });
    if (route === 'GET /status') return send(200, { v: 1, agents: state, builds: BUILDS, buildsNote: null, bar: { min_trades: null, min_mean_r: null }, barSet: false, session: '2026-10-12' });
    const a = body && state[body.agent];
    if (!a) return send(409, { error: 'no such agent on this PC' });
    if (route === 'POST /on') {
      const b = BUILDS.find(x => x.build === body.build);
      if (!b) return send(409, { error: 'that build is not on this PC or in The Desk\'s store' });
      if (!b.shadowOk) return send(409, { error: b.build + ' is not a hero and does not pass the Shadow bar' });
      if (!b.hero && !(body.mode === 'shadow' && body.sim === true)) return send(409, { error: b.build + ' is not a hero: it runs only in Shadow on a Sim account' });
      if (a.running && a.runningBuild !== b.build) return send(409, { error: body.agent + ' runs ' + a.runningBuild + ': turn him Off first' });
      Object.assign(a, { on: true, running: true, why: 'on', build: b.build, runningBuild: b.build, hero: b.hero, since: Date.now() });
      await control('agent-connect', { agent: body.agent, name: b.hero || b.build, build: b.build + ' ' + b.stamp });
      return send(200, { ok: true });
    }
    if (route === 'POST /off') {
      const was = a.running;
      Object.assign(a, { on: false, running: false, why: 'off', runningBuild: null });
      if (was) await control('agent-connect', { agent: body.agent, on: '0' });
      return send(200, { ok: true });
    }
    if (route === 'POST /settings') { a.autoOn = body.autoOn || ''; a.cap = body.cap === undefined ? a.cap : body.cap; return send(200, { ok: true }); }
    return send(404, { error: 'no such route' });
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); });
  return { calls, status: state, setDown: v => { down = !!v; }, setForbid: v => { forbid = !!v; }, close: () => new Promise(r => server.close(r)) };
}
