// A MADE-UP agent client for tests (nt8/PROTOCOL.md "Agent channel (agents, 0.5.0)"). It has NO trading logic and no model:
// it connects to /agent/<id> (ChartBridge's, or any server that speaks the contract) with no Origin header and the agent's
// secret in X-ChartBridge-Agent, says agentHello first, beats every second, and sends only what it is told: by hand, a plan
// (sample numbers, never a real agent's), a skip, a withdraw, a note, a subscribe, a flatten. Real agents and their runner
// live in the private Bot-Lab repository, never here.
//
// As a module: connectAgent({ port, id, secret }) -> { plan, skip, withdraw, note, subscribe, flatten, beat, stop, close, next,
// received }; samplePlan(id, fields) builds a plan whose riskDollars adds up; clean(text, max) cleans text as the runner must
// (quotes to ', newlines to " / ", backslashes and control characters dropped, cut to length); readSecret(file) reads
// agent-<id>-secret.txt.
// From the command line (a manual check against a running ChartBridge with "agents = <id>" in config.txt):
//   node test/fake-agent.mjs 8765 --id=manrae --secret-file="%USERPROFILE%\Documents\NinjaTrader 8\ChartBridge\agent-manrae-secret.txt" --plan --price=24990 --seconds=20
//   options: --secret=<hex>, --plan (one sample plan after the welcome), --root=MNQ|NQ, --side=buy|sell, --kind=limit|stopLimit,
//   --price=<p>, --limit=<p> (stopLimit), --qty=<n> (default 1), --stop=<ticks> (default 12), --target=<ticks> (default 24),
//   --expire=<s> (default 300), --withdraw-after=<ms>, --note=<text>, --seconds=<n> (then close; default 10), --silent (no beats)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wsConnect } from './fake-bot.mjs';

export const NAME = 'Demo Agent';               // made up
export const BUILD = 'sample-build-1';          // made up
export const SAMPLE_REASON = 'Sample: price held the made-up level twice';
export const SAMPLE_SETUP = 'Sample fade';
// The contract's instruments (welcome.instruments carries the real ones): tick and point value, for riskDollars.
export const SPECS = { MNQ: { tick: 0.25, pointValue: 2 }, NQ: { tick: 0.25, pointValue: 20 }, MES: { tick: 0.25, pointValue: 5 }, ES: { tick: 0.25, pointValue: 50 } };

// agent-<id>-secret.txt: two # lines, then 64 hex characters (as bot-secret.txt). The secret is never printed.
export function readSecret(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines.length !== 1 || !/^[0-9a-fA-F]{64}$/.test(lines[0])) throw new Error('the agent secret file does not hold one 64 character secret');
  return lines[0];
}

// Text as ChartBridge's strict parser takes it: quotes to ', newlines to " / ", backslashes and control characters dropped,
// cut to max characters (200 for every string, 1,000 for note.text).
export function clean(text, max) {
  let t = String(text == null ? '' : text).replace(/"/g, "'").replace(/\r\n|\r|\n/g, ' / ').replace(/\\/g, '');
  t = Array.from(t).filter(ch => { const c = ch.codePointAt(0); return c >= 0x20 && c !== 0x7f; }).join('');
  return t.slice(0, max || 200);
}

// riskDollars as ChartBridge checks it (check 5): stopTicks x tick x point value x qty, to the cent.
export function riskDollars(root, stopTicks, qty, specs) {
  const s = (specs || SPECS)[root];
  if (!s) throw new Error('no tick and point value for ' + root);
  return Math.round(stopTicks * s.tick * s.pointValue * qty * 100) / 100;
}

// A sample plan: every field the contract asks for, made-up numbers, riskDollars that add up. fields override any of them.
export function samplePlan(id, fields, specs) {
  const p = Object.assign({ type: 'plan', id, root: 'MNQ', side: 'buy', kind: 'limit', price: 24990, qty: 1, stopTicks: 12, targetTicks: 24, expireSec: 300,
    setup: SAMPLE_SETUP, reason: SAMPLE_REASON, confidence: 0.5 }, fields || {});
  if (p.kind !== 'stopLimit') delete p.limitPrice;
  if (p.riskDollars === undefined) p.riskDollars = riskDollars(p.root, p.stopTicks, p.qty, specs);
  return p;
}

// Connects as agent <id>: no Origin, the secret, agentHello first; beats every second until stop() (or silent: true).
export async function connectAgent({ port, id, secret, name, build, silent, host, noHello }) {
  const ws = await wsConnect(port, '/agent/' + id, { 'X-ChartBridge-Agent': secret }, host);
  if (!noHello) ws.send({ type: 'agentHello', name: clean(name || NAME, 40), build: clean(build || BUILD, 40) });
  let timer = silent ? null : setInterval(() => ws.send({ type: 'beat' }), 1000);
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const closeSocket = ws.close;
  return Object.assign(ws, {
    stop,
    close: () => { stop(); closeSocket(); },
    beat: () => ws.send({ type: 'beat' }),
    plan: (pid, fields, specs) => ws.send(samplePlan(pid, fields, specs)),
    skip: (sid, reason, setup) => ws.send(Object.assign({ type: 'skip', id: sid, reason: clean(reason || 'Sample: no setup (made up)') }, setup ? { setup: clean(setup, 40) } : {})),
    withdraw: (wid, reason) => ws.send({ type: 'withdraw', id: wid, reason: clean(reason || 'Sample: the plan is no longer valid') }),
    note: (kind, text) => ws.send({ type: 'note', kind, text: clean(text, 1000) }),
    subscribe: (root, extra) => ws.send(Object.assign({ type: 'subscribe', root }, extra || {})),
    flatten: () => ws.send({ type: 'flatten' }),
  });
}

function flagValue(args, name) { const a = args.find(x => x.startsWith('--' + name + '=')); return a ? a.slice(a.indexOf('=') + 1) : ''; }

async function main() {
  const args = process.argv.slice(2);
  const port = +(args.find(a => /^\d+$/.test(a)) || 8765);
  const id = flagValue(args, 'id') || 'manrae';
  const secret = flagValue(args, 'secret') || (flagValue(args, 'secret-file') ? readSecret(flagValue(args, 'secret-file')) : '');
  if (!secret) { console.error('fake-agent: give --secret=<hex> or --secret-file=<agent-<id>-secret.txt>'); process.exit(2); }
  const agent = await connectAgent({ port, id, secret, silent: args.includes('--silent') });
  const w = await agent.next('welcome', 5000);
  console.log('fake-agent: welcome', JSON.stringify(w));
  const specs = {};
  for (const i of (w && w.instruments) || []) specs[i.root] = { tick: i.tick, pointValue: i.pointValue };
  if (flagValue(args, 'note')) agent.note('status', flagValue(args, 'note'));
  if (args.includes('--plan')) {
    const pid = 'demo-' + Date.now();
    const f = { root: flagValue(args, 'root') || 'MNQ', side: flagValue(args, 'side') || 'buy', kind: flagValue(args, 'kind') || 'limit', price: +flagValue(args, 'price'),
      qty: +(flagValue(args, 'qty') || 1), stopTicks: +(flagValue(args, 'stop') || 12), targetTicks: +(flagValue(args, 'target') || 24), expireSec: +(flagValue(args, 'expire') || 300) };
    if (f.kind === 'stopLimit') f.limitPrice = +flagValue(args, 'limit');
    agent.plan(pid, f, Object.keys(specs).length ? specs : null);
    console.log('fake-agent: sent plan', pid);
    const after = +flagValue(args, 'withdraw-after');
    if (after > 0) setTimeout(() => { agent.withdraw(pid); console.log('fake-agent: withdrew', pid); }, after);
  }
  const seconds = +(flagValue(args, 'seconds') || 10);
  const shown = new Set(['welcome', 'agentState', 'answer', 'reject', 'order', 'position', 'exec']);
  const t = setInterval(() => { for (const m of agent.received.splice(0)) if (shown.has(m.type)) console.log('fake-agent:', JSON.stringify(m)); }, 200);
  setTimeout(() => { clearInterval(t); agent.close(); process.exit(0); }, seconds * 1000);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error('fake-agent: ' + e.message); process.exit(1); });
