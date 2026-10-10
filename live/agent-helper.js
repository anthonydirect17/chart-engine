/*
 * AgentHelper: the Agent tab's On/Off, spend and hero picker, with no page in it (chart page 1.20.0; DECISION 2026-10-09 v
 * and w, docs/AGENT_TAB.md "On/Off"). live/agent.js draws it; test/agent-helper.test.js runs it in Node. One
 * dependency-free file: a plain <script> sets window.AgentHelper; Node requires it.
 *
 * The PC helper is Bot-Lab's manrae/helper.py: a small process on this PC (started at sign-in) that starts and stops the
 * agent's runner. It listens on http://localhost:8767 only, answers only this page's origin, and checks this page's PIN
 * unlock with ChartBridge on every request (the X-ChartBridge-Unlock header the PIN page already sends to GET /session).
 *
 *   On         the helper starts the runner with the build picked here (it fetches a missing build from The Desk)
 *   Off        the helper ends the runner process: no more model calls, so spend stops. ChartBridge cancels his unfilled
 *              entries when he disconnects (as built); a position keeps its stop and target.
 *   Off in a trade   asks "Flatten and turn him off?" (offStep), for that agent only. Yes (flatOffStart, flatOffStep):
 *              first Shadow (ChartBridge then places nothing more for him and cancels his unfilled entries; SHADOW_WAIT_MS
 *              at most), then the page's own Flatten for his account and root (the chart's Flatten path, never an order built
 *              here), then Off once ChartBridge says he is flat (FLAT_WAIT_MS at most). Not in Shadow or not flat in time: he
 *              stays on, and the line says so until Anthony acts. No: nothing is sent.
 *   Spend      this session's and the overall dollars of the live agent only (the runner's own journal of its calls)
 *   Picker     DECISION w: Copilot, Auto and a LIVE account list heroes only; Shadow on a Sim account lists heroes and the
 *              builds that pass the Shadow bar (pickerRows). A build that is not a hero keeps the mode at Shadow on Sim:
 *              modeBlock says why Copilot and Auto are closed (the runner refuses them too).
 *   Names      DECISION v: a hero's name (Manrae, Manrae 2) in the header; the build id and stamp in the details.
 *
 * Nothing here sends an order.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AgentHelper = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = '1.0.0';
const PORT = 8767;
const BASE = 'http://localhost:' + PORT;
const POLL_MS = 3000;
const TIMEOUT_MS = 4000;
const FLAT_WAIT_MS = 30000;
const SHADOW_WAIT_MS = 10000;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const isNum = v => typeof v === 'number' && isFinite(v);
const str = v => (typeof v === 'string' ? v : '');

/** Dollars as the readout shows them: "$0.00", "$12.34", "$1,234.50". */
function usd(x) {
  if (!isNum(x)) return '-';
  return '$' + x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The readout next to On/Off: { session, overall } in dollars, or dashes while the helper has not answered. */
function spendText(spend) {
  const s = spend || {};
  return { session: usd(s.session), overall: usd(s.overall) };
}

/** The helper's word for one agent, for the line under On/Off. h: the agent's entry in GET /status (or null). */
function stateText(h, reach, why) {
  if (reach === 'down') return 'The PC helper is not running on this PC (tools\\manrae_helper.ps1 register).';
  if (reach === 'forbidden') return 'The PC helper refused this page' + (why ? ': ' + why : '') + '.';
  if (reach === 'locked') return 'Unlock ChartBridge\'s page with its PIN.';
  if (!h) return reach === 'none' ? 'This PC\'s helper does not run this agent.' : 'Asking the PC helper...';
  if (!h.on) return h.running ? 'Turning off...' : 'Off: no model calls, no spend.';
  if (h.running) return 'On' + (h.runningBuild ? ': ' + (h.hero || h.runningBuild) : '') + '.';
  return 'On, not running yet: ' + str(h.why) + '.';
}

/**
 * The picker's rows for the agent shown: [{ build, label, hero, stamp, title }]. mode and sim from ChartBridge's `agent`
 * message (sim true for a Sim account). Copilot, Auto or anything but a Sim account: heroes only. Shadow on Sim: heroes and
 * the builds over the bar (shadowOk from the helper).
 */
function pickerRows(status, mode, sim) {
  const rows = status && Array.isArray(status.builds) ? status.builds : [];
  const heroesOnly = mode !== 'shadow' || sim !== true;
  return rows.filter(r => r && typeof r.build === 'string' && (r.hero || (!heroesOnly && r.shadowOk))).map(r => ({
    build: r.build, hero: r.hero || null, stamp: str(r.stamp),
    label: r.hero ? r.hero + ' (' + r.build + ')' : r.build + ' (Shadow only)',
    title: (r.hero ? 'Hero ' + r.hero + ': ' : 'Not a hero, Shadow on Sim only: ') + r.build + (r.stamp ? ' ' + r.stamp : '') +
      (isNum(r.trades) ? ', ' + r.trades + ' trades' : '') + (isNum(r.meanR) ? ', mean R ' + r.meanR : '') + (r.here === false ? ', fetched from The Desk on On' : ''),
  }));
}

/** Why the picker is short, or '': the heroes-only rule in force, or no bar set yet. */
function pickerNote(status, mode, sim) {
  if (mode !== 'shadow' || sim !== true) return 'Heroes only in ' + (mode === 'copilot' ? 'Copilot' : mode === 'auto' ? 'Auto' : 'this mode') + (sim === true ? '' : ' and on a LIVE account') + '.';
  return status && status.barSet === false ? 'No Shadow bar set: every build is listed in Shadow.' : '';
}

/**
 * The build he runs is not a hero (DECISION w): its name, or '' when he is one or nothing runs. Fails closed: the helper's
 * word when it has one, and always his own hello as well, since a runner that is not a hero says its build id as its name
 * (Bot-Lab manrae/live.py), whether or not the helper answers. a: his `agent` message; h: the helper's entry or null.
 */
function nonHero(a, h) {
  if (h && h.running && !h.hero) return h.runningBuild || 'This build';
  const x = a || {}, build = str(x.build).split(' ')[0];
  if (x.connected && build && str(x.name) === build) return build;
  return '';
}
/**
 * The mode buttons while a build that is not a hero runs: { copilot, auto } each null (allowed) or why not. Only heroes trade
 * in Copilot or Auto (DECISION w); the runner refuses them too.
 */
function modeBlock(h, a) {
  const b = nonHero(a, h);
  if (!b) return { copilot: null, auto: null };
  const why = b + ' is not a hero: Shadow on a Sim account only.';
  return { copilot: why, auto: why };
}
/** A LIVE account while a build that is not a hero runs: why not, or ''. sim: the account chosen is a Sim one. */
function accountBlock(a, h, sim) {
  const b = nonHero(a, h);
  return b && sim !== true ? b + ' is not a hero: it trades a Sim account only. Turn him Off and pick a hero first.' : '';
}

/** Off pressed: 'off' (send it), 'ask' (he holds a position: "Flatten and turn him off?"). a: his `agent` message. */
function offStep(a) {
  const p = a && a.position;
  return p && isNum(p.qty) && p.qty !== 0 ? 'ask' : 'off';
}

/** The question for Off in a trade. */
function offQuestion(a, name) {
  const p = (a && a.position) || {};
  return (name || 'He') + ' holds ' + (p.qty > 0 ? 'long ' : 'short ') + Math.abs(p.qty || 0) + (p.root ? ' ' + p.root : '') + ' on ' + str(a && a.account) + '. Flatten and turn him off?';
}

/** Is he flat now (his `agent` message)? */
function flat(a) { return offStep(a) === 'off'; }

/**
 * "Flatten and turn off" pressed for agent a: { job, action } or { error } (nothing sent). The job: { agent, account, root,
 * phase, until }. action: 'shadow' (send agentMode shadow first), 'flatten' (already in Shadow), or 'off' (he is flat now).
 * His account must be known: never a default.
 */
function flatOffStart(a, now) {
  const x = a || {}, p = x.position || {};
  if (flat(x)) return { job: { agent: str(x.agent), account: str(x.account), root: str(p.root), phase: 'off', until: 0 }, action: 'off' };
  if (!str(x.account)) return { error: 'His account is not known yet: nothing was sent. Flatten in NinjaTrader, then press Off.' };
  if (!str(p.root)) return { error: 'His position\'s instrument is not known: nothing was sent. Flatten in NinjaTrader, then press Off.' };
  const job = { agent: str(x.agent), account: x.account, root: p.root, phase: x.mode === 'shadow' ? 'flatten' : 'shadow', until: now + (x.mode === 'shadow' ? FLAT_WAIT_MS : SHADOW_WAIT_MS) };
  return { job, action: job.phase };
}

/**
 * The job's next step, at each `agent` message and each second: { action, job, line }. action: '' (wait), 'flatten' (he is
 * in Shadow now: send the Flatten), 'off' (flat: send Off), 'giveup' (time is up: he stays on; line says why and stays).
 * a: his `agent` message now (null when ChartBridge no longer tells of him). sent: the Flatten has gone.
 */
function flatOffStep(job, a, now, sent) {
  const j = job, x = a || {};
  if (!j) return { action: '', job: null, line: '' };
  if (!a) {                                     // no word from ChartBridge (the connection dropped): never read as flat
    if (now > j.until) return { action: 'giveup', job: null, line: 'ChartBridge did not answer: ' + (j.phase === 'shadow' ? 'nothing was flattened and he stays on' : 'he may still hold ' + j.account + ' ' + j.root + ' and stays on') + '. Check NinjaTrader, then press Off.' };
    return { action: '', job: j, line: 'Waiting for ChartBridge (the connection dropped): nothing is read as flat meanwhile...' };
  }
  if (j.phase === 'shadow') {
    if (x.mode === 'shadow') return { action: flat(x) ? 'off' : 'flatten', job: Object.assign({}, j, { phase: flat(x) ? 'off' : 'flatten', until: now + FLAT_WAIT_MS }), line: flat(x) ? 'In Shadow and flat: turning him off...' : 'In Shadow: flattening ' + j.account + ' ' + j.root + '...' };
    if (now > j.until) return { action: 'giveup', job: null, line: 'ChartBridge did not put him in Shadow within ' + SHADOW_WAIT_MS / 1000 + ' s: nothing was flattened and he stays on.' };
    return { action: '', job: j, line: 'Putting him in Shadow first (no new entries)...' };
  }
  if (j.phase === 'flatten') {
    if (sent && flat(x)) return { action: 'off', job: Object.assign({}, j, { phase: 'off' }), line: 'Flat: turning him off...' };
    if (now > j.until) return { action: 'giveup', job: null, line: 'Not flat ' + FLAT_WAIT_MS / 1000 + ' s after the Flatten for ' + j.account + ' ' + j.root + ': he stays on, in Shadow. Flatten in NinjaTrader, then press Off.' };
    return { action: '', job: j, line: 'Flatten sent for ' + j.account + ' ' + j.root + ' (he is in Shadow): turning him off once flat...' };
  }
  return { action: '', job: j, line: 'Turning him off...' };
}

/** The header and details (DECISION v): { name, build } where name is the hello's name (a hero's name, or the build id of
 *  a build that is not a hero) and build the build id and stamp for the details row. */
function names(a) {
  const x = a || {};
  return { name: str(x.name) || str(x.agent) || 'Agent', build: str(x.build) };
}

/** The settings form checked: { ok, body } or { error }. autoOn "HH:MM" or ''; cap dollars (0 to 1000) or '' for none. */
function settingsBody(agent, autoOn, cap) {
  const at = str(autoOn).trim();
  if (at && !HHMM.test(at)) return { error: 'Auto-On is HH:MM New York time, or empty for none.' };
  const c = str(cap).trim();
  let n = null;
  if (c) {
    n = Number(c);
    if (!isFinite(n) || n < 0 || n > 1000) return { error: 'The cap is dollars from 0 to 1000, or empty for none.' };
    n = Math.round(n * 100) / 100;
  }
  return { ok: true, body: { agent, autoOn: at, cap: n } };
}

/**
 * The client: env { fetch, headers: () => the PIN page's unlock headers, base }. Each call resolves to
 * { reach: 'ok'|'down'|'locked'|'refused', body }: 'down' the helper did not answer, 'locked' 401 (the PIN), 'refused' its
 * reason in body.error.
 */
function createClient(env) {
  const e = env || {};
  const base = e.base || BASE;
  async function call(method, path, body) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    try {
      const h = Object.assign({}, e.headers ? e.headers() : {});
      if (body) h['Content-Type'] = 'application/json';
      const r = await e.fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', mode: 'cors', credentials: 'omit', signal: ctl ? ctl.signal : undefined });
      let b = null;
      try { b = await r.json(); } catch (x) { b = null; }
      if (r.status === 401) return { reach: 'locked', body: b };
      if (r.status === 403) return { reach: 'forbidden', body: b };
      if (!r.ok) return { reach: r.status === 409 || r.status === 400 ? 'refused' : 'down', body: b || { error: 'HTTP ' + r.status } };
      return { reach: 'ok', body: b };
    } catch (x) {
      return { reach: 'down', body: null };
    } finally { if (timer) clearTimeout(timer); }
  }
  return {
    status: () => call('GET', '/status'),
    on: (agent, build, mode, sim) => call('POST', '/on', { agent, build, mode, sim: sim === true }),
    off: agent => call('POST', '/off', { agent }),
    settings: body => call('POST', '/settings', body),
  };
}

return { VERSION, PORT, BASE, POLL_MS, FLAT_WAIT_MS, SHADOW_WAIT_MS, usd, spendText, stateText, pickerRows, pickerNote, nonHero, modeBlock, accountBlock, offStep, offQuestion, flat, flatOffStart, flatOffStep, names, settingsBody, createClient };
});
