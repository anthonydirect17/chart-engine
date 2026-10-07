/*
 * BotCore: the Bot tab's logic, with no page in it (chart page 1.16.0, ChartBridge 0.4.0's bot channel, nt8/PROTOCOL.md
 * "Bot channel"). live/bot.js draws the Bot tab, the bot strip, the pop-ups and the ghost marks from it; the unit tests
 * (test/bot.test.js) run it in Node. One dependency-free file: a plain <script> sets window.BotCore; Node requires it.
 *
 * What lives here:
 *   rails       how close the bot is to each of its limits (trades x of 5, losing trades x of 3): amber from 70%, red from
 *               90%; and the page's change of them (`botRails` as ChartBridge 0.4.0 built it: maxTrades 1 to 5, maxLosses
 *               1 to 3, the root botRoot or its micro or mini, kept by ChartBridge in bot-rails.txt)
 *   the bot's   which orders and fills are the bot's: ChartBridge 0.4.0 marks none on the page, so those on Sim101 on the
 *   orders      bot's root (isBotMark)
 *   proposals   a copilot proposal's life on the page: shown (then `botSeen` once), answered once (`botAnswer`), and gone
 *               when ChartBridge says accepted, rejected, withdrawn or not answered (an expired one shows "not answered")
 *   library     the frozen Bot-Lab builds (`GET /bot-library`, docs/BOT_LIBRARY.md): read, checked, shelved
 *   day type    Anthony's day-type calls, each one logged on this PC with its time
 *   log         today's signals, proposals, answers and the page's own actions, kept for the trading day (18:00 ET)
 *   notices     what changed between two `bot` messages that deserves a corner notice
 *   trips       the bot's fills as trades, for its marks on the charts
 *
 * Nothing here sends an order. The page never builds an order for the bot: ChartBridge places every bot order from the
 * bot's own parameters (PROTOCOL.md: "AI is never in the order path"). The bot in this repository's tests is made up.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const VERSION = '1.0.0';
/* Rails (PROTOCOL.md "Bot channel"): ChartBridge's defaults; the `bot` message carries the ones in force. */
const RAILS = Object.freeze({ maxQty: 1, maxTrades: 5, maxLosses: 3 });
/* The most the page may ask for (ChartBridgeBot.cs MaxTradesLimit, MaxLossesLimit): ChartBridge's own limits. */
const RAIL_MAX = Object.freeze({ maxTrades: 5, maxLosses: 3 });
/* The bot's account and the roots it may trade (botRoot, or its micro or mini: ChartBridgeBot.cs Sibling). */
const BOT_ACCOUNT = 'Sim101';
const ROOT_SIBLING = Object.freeze({ MNQ: 'NQ', NQ: 'MNQ', MES: 'ES', ES: 'MES' });
/* How close to a limit (Anthony, addendum 2): amber at 70% used, red at 90%. */
const AMBER = 0.7, RED = 0.9;
/* A conditions cell with fewer trades than this is faded: too few to read. */
const THIN = 20;
const MODES = ['shadow', 'copilot', 'auto'];
const MODE_NAME = { shadow: 'Shadow', copilot: 'Copilot', auto: 'Sim auto' };
const DAY_TYPES = ['Trend', 'Range', 'Gap', 'Unsure'];
const PROPOSAL_END = ['accepted', 'rejected', 'withdrawn', 'not answered'];
const KEYS = { log: 'live-bot-log-v1', dayType: 'live-bot-daytype-v1', ghost: 'live-bot-ghost-v1', options: 'live-bot-options-v1' };
const LOG_MAX = 300, DAY_LOG_MAX = 100;

const isInt = v => typeof v === 'number' && Number.isInteger(v);
const isNum = v => typeof v === 'number' && isFinite(v);
const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const plainObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ======================================================================== rails */
/**
 * How close one rail is: { used, max, pct (0 to 1, capped), level ('ok', 'amber' or 'red'), text ('2 of 5') }.
 * A rail with no maximum (null, 0, not a whole number) is { level: 'ok', pct: 0, known: false }.
 */
function railLevel(used, max) {
  const u = isInt(used) && used > 0 ? used : 0;
  if (!isInt(max) || max < 1) return { used: u, max: null, pct: 0, level: 'ok', known: false, text: u + ' of -' };
  const pct = clamp(u / max, 0, 1);
  const level = pct >= RED - 1e-9 ? 'red' : pct >= AMBER - 1e-9 ? 'amber' : 'ok';
  return { used: u, max, pct, level, known: true, text: u + ' of ' + max };
}
/** The worse of two levels. */
const LEVEL_RANK = { ok: 0, amber: 1, red: 2 };
const worse = (a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a);
/** Both rails of a `bot` message: { trades, losses, level }. */
function rails(bot) {
  const b = bot || {};
  const trades = railLevel(b.trades, b.maxTrades), losses = railLevel(b.losses, b.maxLosses);
  return { trades, losses, level: worse(trades.level, losses.level) };
}
/**
 * The page's change of the rails (`botRails`, as ChartBridge 0.4.0 built it): maxTrades a whole number from 1 to 5,
 * maxLosses from 1 to 3 (ChartBridge's own limits: never above), root the bot's root now or its micro or mini sibling. All
 * three are sent; ChartBridge saves them in bot-rails.txt (they stay over a restart and a new day) and refuses a change
 * while the bot has a position or a working entry. cur is the `bot` message ({ maxTrades, maxLosses, root }); want is
 * what Anthony picked. Returns { msg } (the message to send, with cid) or { error } (said on the page; nothing is sent).
 */
function railsChange(cur, want, cid) {
  const c = cur || {}, w = want || {};
  if (!isInt(c.maxTrades) || !isInt(c.maxLosses) || typeof c.root !== 'string' || !c.root) return { error: 'The rails in force are not known yet: nothing was sent.' };
  const parse = v => (typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : v);
  const t = parse(w.maxTrades), l = parse(w.maxLosses), r = w.root === undefined ? c.root : w.root;
  for (const [name, v, max] of [['Trades', t, RAIL_MAX.maxTrades], ['Losing trades', l, RAIL_MAX.maxLosses]]) {
    if (!isInt(v) || v < 1 || v > max) return { error: name + ' must be a whole number from 1 to ' + max + ' (ChartBridge\'s limit): nothing was sent.' };
  }
  if (r !== c.root && r !== ROOT_SIBLING[c.root]) return { error: 'The root must be ' + c.root + (ROOT_SIBLING[c.root] ? ' or ' + ROOT_SIBLING[c.root] : '') + ': nothing was sent.' };
  if (plainObj(c.position) && isNum(c.position.qty) && c.position.qty !== 0) return { error: 'The bot has a position: change its rails when it is flat. Nothing was sent.' };
  if (t === c.maxTrades && l === c.maxLosses && r === c.root) return { error: 'Nothing to change.' };
  const msg = { type: 'botRails' };
  if (cid) msg.cid = cid;
  msg.maxTrades = t; msg.maxLosses = l; msg.root = r;
  return { msg };
}

/**
 * Is this order or fill the bot's? ChartBridge 0.4.0 sends the page no mark on either (the names, `CB#1a2b3c4d bot s8 t16`,
 * stay in NinjaTrader). The bot trades only on Sim101 and only on its root, so a working order or a fill there is taken
 * as the bot's (Anthony's own Sim101 orders on that root are counted too). bot: the `bot` message (its account and root).
 */
function isBotMark(x, bot) {
  const b = bot || {};
  const account = typeof b.account === 'string' && b.account ? b.account : BOT_ACCOUNT, r = typeof b.root === 'string' ? b.root : '';
  return !!x && !!r && x.account === account && x.root === r;
}

/* ======================================================================== modes */
/**
 * Which modes the panel offers: shadow always; copilot unless the loaded build is on the Research shelf; auto only when
 * ChartBridge allows it (Sim101 tradable) and not for a Research build. Returns { shadow, copilot, auto } of
 * { ok, why }.
 */
function modesAllowed(o) {
  const x = o || {};
  const research = !!(x.entry && x.entry.shelf === 'research');
  const rs = 'A Research build runs in Shadow only.';
  return {
    shadow: { ok: true, why: '' },
    copilot: research ? { ok: false, why: rs } : { ok: true, why: '' },
    auto: research ? { ok: false, why: rs } : x.simTradable ? { ok: true, why: '' } : { ok: false, why: 'Sim auto needs Sim101 to be tradable in ChartBridge.' },
  };
}
/** Whether Sim101 can trade now: the v3 `accounts` list (tradable) or the `trading` answer's accounts. */
function simTradable(accountsMsg, trading) {
  const list = accountsMsg && Array.isArray(accountsMsg.list) ? accountsMsg.list : null;
  if (list) { const a = list.find(x => x && x.name === 'Sim101'); if (a) return !!a.tradable; }
  return !!(trading && trading.enabled && Array.isArray(trading.accounts) && trading.accounts.includes('Sim101'));
}
/** ChartBridge's switch (PROTOCOL.md "Telling the page what is on"): the bot channel is on for this page. */
const botSwitchOn = trading => !!(trading && trading.enabled && trading.switches && trading.switches.bot === true);

/* ======================================================================== proposals */
/**
 * A copilot proposal's life on this page. update(msg) takes every `botProposal`; it returns what the page does:
 *   { act: 'show', p }         a new open proposal: show it now (then call shown(id))
 *   { act: 'update', p }       still open (seenAt filled in, say): keep it shown
 *   { act: 'end', p, why }     ended: accepted, rejected, withdrawn or 'not answered' (an expired one says so)
 *   { act: 'none' }            nothing to do (a repeat, an unknown shape, an end already handled)
 * shown(id, at) gives the `botSeen` message once per proposal (the moment it showed on this page); answer(id, answer, at,
 * cid) gives the `botAnswer` message once, only while it is open here. Times are page UTC ms, whole numbers.
 */
function createProposals() {
  const map = new Map();
  const ok = p => plainObj(p) && typeof p.id === 'string' && p.id.length >= 1 && p.id.length <= 40 && typeof p.state === 'string';
  function update(p) {
    if (!ok(p)) return { act: 'none' };
    const had = map.get(p.id);
    if (!had) {
      const e = { p, seen: false, answered: '', ended: false };
      map.set(p.id, e);
      if (p.state === 'open') return { act: 'show', p };
      e.ended = true;
      return { act: 'none' };                                // ended before this page saw it open: only logged
    }
    had.p = p;
    if (had.ended) return { act: 'none' };
    if (p.state === 'open') return { act: 'update', p };
    had.ended = true;
    return { act: 'end', p, why: p.state === 'withdrawn' ? 'not answered' : p.state };
  }
  function shown(id, at) {
    const e = map.get(id);
    if (!e || e.ended || e.seen || e.p.state !== 'open') return null;
    e.seen = true;
    return { type: 'botSeen', id, at: Math.round(at) };
  }
  function answer(id, ans, at, cid) {
    const e = map.get(id);
    if (ans !== 'accept' && ans !== 'reject') return { error: 'The answer must be accept or reject.' };
    if (!e) return { error: 'No proposal ' + id + '.' };
    if (e.ended || e.p.state !== 'open') return { error: 'That proposal is ' + e.p.state + ': nothing was sent.' };
    if (e.answered) return { error: 'Already answered (' + e.answered + '): nothing was sent.' };
    e.answered = ans;
    const msg = { type: 'botAnswer' };
    if (cid) msg.cid = cid;
    msg.id = id; msg.answer = ans; msg.at = Math.round(at);
    return { msg };
  }
  /** ChartBridge refused this page's answer (a `reject` with its cid): it may be answered again while open. */
  function refused(id) { const e = map.get(id); if (e && !e.ended) e.answered = ''; }
  const open = () => [...map.values()].filter(e => !e.ended && e.p.state === 'open').map(e => e.p).sort((a, b) => (a.at || 0) - (b.at || 0));
  const get = id => (map.has(id) ? map.get(id).p : null);
  const answered = id => (map.has(id) ? map.get(id).answered : '');
  /** A dropped connection: every proposal shown here is gone from the page (ChartBridge sends the open ones again). */
  function clear() { const was = open(); map.clear(); return was; }
  return { update, shown, answer, refused, open, get, answered, clear };
}

/* ======================================================================== the library (docs/BOT_LIBRARY.md) */
const LIB_VERSION = 1;
const SHELVES = ['ready', 'research'];
const COND_KEYS = ['timeOfDay', 'dayType', 'volBand', 'levelSide'];
const STAT_KEYS = { trades: 'int', winRate: 'frac', avgR: 'num', profitFactor: 'num', worstDrawdownR: 'num', days: 'int' };
const ENTRY_KEYS = ['id', 'name', 'shelf', 'evidence', 'sentence', 'settings', 'stats', 'equity', 'ruleCard', 'conditions', 'frozen'];
const EQUITY_MAX = 5000, SETTINGS_MAX = 30, CELLS_MAX = 60, BOTS_MAX = 50;
const TOD_RX = /^([01]\d|2[0-3]):(00|30)$/;
const text = (v, max) => typeof v === 'string' && v.trim().length >= 1 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
/** The evidence level's number ('L2' is 2), or null. */
const evidenceLevel = v => { const m = typeof v === 'string' ? /^L([0-9])$/.exec(v) : null; return m ? +m[1] : null; };

function checkCell(c, where) {
  if (!plainObj(c)) return where + ' is not an object';
  for (const k of Object.keys(c)) if (!['key', 'trades', 'winRate', 'avgR'].includes(k)) return where + ' has an unknown key "' + k + '"';
  if (!text(c.key, 40)) return where + '.key must be text of 1 to 40 characters';
  if (!isInt(c.trades) || c.trades < 0) return where + '.trades must be a whole number of 0 or more';
  if (!isNum(c.winRate) || c.winRate < 0 || c.winRate > 1) return where + '.winRate must be a number from 0 to 1';
  if (!isNum(c.avgR)) return where + '.avgR must be a number';
  return '';
}
/** One library entry checked: '' when it is good, else why not (the first problem). */
function checkEntry(b, i) {
  const w = 'bots[' + i + ']';
  if (!plainObj(b)) return w + ' is not an object';
  for (const k of Object.keys(b)) if (!ENTRY_KEYS.includes(k)) return w + ' has an unknown key "' + k + '"';
  if (typeof b.id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(b.id)) return w + '.id must be 1 to 64 letters, digits, dots, dashes or underscores';
  if (!text(b.name, 60)) return w + '.name must be text of 1 to 60 characters';
  if (!SHELVES.includes(b.shelf)) return w + '.shelf must be "ready" or "research"';
  const ev = evidenceLevel(b.evidence);
  if (ev === null) return w + '.evidence must be L0 to L9';
  if (b.shelf === 'ready' && ev < 1) return w + ' is on the Ready shelf with ' + b.evidence + ' (Ready needs L1 or higher)';
  if (!text(b.sentence, 240)) return w + '.sentence must be text of 1 to 240 characters';
  if (!plainObj(b.settings)) return w + '.settings must be an object';
  const sk = Object.keys(b.settings);
  if (sk.length > SETTINGS_MAX) return w + '.settings has more than ' + SETTINGS_MAX + ' entries';
  for (const k of sk) {
    const v = b.settings[k];
    if (!text(k, 40)) return w + '.settings has a name that is not 1 to 40 characters';
    if (!(isNum(v) || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 80))) return w + '.settings["' + k + '"] must be a number, true or false, or text up to 80 characters';
  }
  if (!plainObj(b.stats)) return w + '.stats must be an object';
  for (const k of Object.keys(b.stats)) {
    const kind = STAT_KEYS[k], v = b.stats[k];
    if (!kind) return w + '.stats has an unknown key "' + k + '"';
    if (v === null && k !== 'trades' && k !== 'winRate' && k !== 'avgR') continue;
    if (kind === 'int' && !(isInt(v) && v >= 0)) return w + '.stats.' + k + ' must be a whole number of 0 or more';
    if (kind === 'frac' && !(isNum(v) && v >= 0 && v <= 1)) return w + '.stats.' + k + ' must be a number from 0 to 1';
    if (kind === 'num' && !isNum(v)) return w + '.stats.' + k + ' must be a number';
  }
  for (const k of ['trades', 'winRate', 'avgR']) if (!own(b.stats, k)) return w + '.stats.' + k + ' is missing';
  if (!Array.isArray(b.equity) || b.equity.length > EQUITY_MAX || b.equity.some(v => !isNum(v))) return w + '.equity must be a list of at most ' + EQUITY_MAX + ' numbers (R)';
  if (!text(b.ruleCard, 4000)) return w + '.ruleCard must be text of 1 to 4000 characters';
  if (!plainObj(b.conditions)) return w + '.conditions must be an object';
  for (const k of Object.keys(b.conditions)) if (!COND_KEYS.includes(k)) return w + '.conditions has an unknown key "' + k + '"';
  for (const k of COND_KEYS) {
    const list = b.conditions[k];
    if (!Array.isArray(list) || list.length > CELLS_MAX) return w + '.conditions.' + k + ' must be a list of at most ' + CELLS_MAX + ' cells';
    for (let j = 0; j < list.length; j++) {
      const why = checkCell(list[j], w + '.conditions.' + k + '[' + j + ']'); if (why) return why;
      if (k === 'timeOfDay' && !TOD_RX.test(list[j].key)) return w + '.conditions.timeOfDay[' + j + '].key must be a 30-minute window start such as "09:30"';
    }
  }
  if (own(b, 'frozen') && b.frozen !== null && !(typeof b.frozen === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.frozen))) return w + '.frozen must be a date such as "2026-09-15"';
  return '';
}
/**
 * The library file read: { ok, version, bots, problems, none }. `raw` is the text of GET /bot-library (or the parsed
 * object). A good entry is copied (nothing of the file is kept by reference); a bad one is left out and said in
 * problems. Two entries with one id: the second is left out. `none` is true when the file has no usable entry.
 */
function parseLibrary(raw) {
  let doc = raw;
  if (typeof raw === 'string') { try { doc = JSON.parse(raw); } catch (e) { return { ok: false, version: null, bots: [], problems: ['The library file is not JSON.'], none: true }; } }
  if (!plainObj(doc)) return { ok: false, version: null, bots: [], problems: ['The library file is not an object.'], none: true };
  for (const k of Object.keys(doc)) if (k !== 'version' && k !== 'bots') return { ok: false, version: null, bots: [], problems: ['The library file has an unknown key "' + k + '".'], none: true };
  if (doc.version !== LIB_VERSION) return { ok: false, version: doc.version === undefined ? null : doc.version, bots: [], problems: ['The library file is version ' + JSON.stringify(doc.version) + '; this page reads version ' + LIB_VERSION + '.'], none: true };
  if (!Array.isArray(doc.bots)) return { ok: false, version: LIB_VERSION, bots: [], problems: ['The library file has no bots list.'], none: true };
  const bots = [], problems = [], ids = new Set();
  doc.bots.slice(0, BOTS_MAX).forEach((b, i) => {
    const why = checkEntry(b, i);
    if (why) { problems.push(why + '.'); return; }
    if (ids.has(b.id)) { problems.push('bots[' + i + '].id "' + b.id + '" is used twice; the second is left out.'); return; }
    ids.add(b.id);
    bots.push(JSON.parse(JSON.stringify(b)));
  });
  if (doc.bots.length > BOTS_MAX) problems.push('Only the first ' + BOTS_MAX + ' bots are read.');
  return { ok: true, version: LIB_VERSION, bots, problems, none: !bots.length };
}
/** The two shelves: { ready, research }, each in the file's order. */
function shelves(bots) {
  const list = Array.isArray(bots) ? bots : [];
  return { ready: list.filter(b => b.shelf === 'ready'), research: list.filter(b => b.shelf === 'research') };
}
/** The library entry the running bot is (ChartBridge's `bot.name`): the same name (case ignored), else the same id. */
function slotEntry(bots, name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const n = name.trim().toLowerCase();
  const list = Array.isArray(bots) ? bots : [];
  return list.find(b => b.name.trim().toLowerCase() === n) || list.find(b => b.id.toLowerCase() === n) || null;
}
/** A conditions cell for the page: thin (faded) under THIN trades. */
const thinCell = c => !c || !(c.trades >= THIN);
/** The time-of-day cells in time order, every 30-minute window from the first to the last present (gaps as 0 trades). */
function timeOfDayRow(cells) {
  const list = (Array.isArray(cells) ? cells : []).filter(c => c && TOD_RX.test(c.key));
  if (!list.length) return [];
  const mins = k => +k.slice(0, 2) * 60 + +k.slice(3);
  const by = new Map(list.map(c => [mins(c.key), c]));
  const keys = [...by.keys()].sort((a, b) => a - b);
  const out = [];
  for (let m = keys[0]; m <= keys[keys.length - 1]; m += 30) {
    const key = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    out.push(by.get(m) || { key, trades: 0, winRate: 0, avgR: 0, gap: true });
  }
  return out;
}
/** At most n points of an equity list, for a thumbnail (the first, the last and evenly between; the lowest and highest kept). */
function thinEquity(eq, n) {
  const a = Array.isArray(eq) ? eq.filter(isNum) : [];
  if (a.length <= n || n < 3) return a.slice();
  const out = [], step = (a.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(a[Math.round(i * step)]);
  return out;
}
/** The rule card's lines, a numbered list's own numbers taken off ("1. Between 9:30..." is "Between 9:30..."). */
function ruleLines(card) {
  return String(card || '').split(/\r?\n/).map(s => s.trim().replace(/^(\d{1,2}[.)]|[-*])\s+/, '')).filter(Boolean).slice(0, 40);
}

/* ======================================================================== times (Eastern) */
const ET = (() => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return null; } })();
function etParts(ms) {
  if (!ET) { const d = new Date(ms); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }; }
  const o = {};
  for (const p of ET.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
const p2 = n => (n < 10 ? '0' : '') + n;
/** HH:MM ET of a UTC ms time. */
const etClock = ms => { const t = etParts(ms); return p2(t.h) + ':' + p2(t.mi); };
const etClockSec = ms => { const t = etParts(ms); return p2(t.h) + ':' + p2(t.mi) + ':' + p2(t.s); };
/** The trading day of a UTC ms time, as 'YYYY-MM-DD' of the session's end: a new day starts at 18:00 ET (the rails' reset). */
function tradeDay(ms) {
  const t = etParts(ms);
  let d = Date.UTC(t.y, t.mo - 1, t.d);
  if (t.h >= 18) d += 86400000;
  const x = new Date(d);
  return x.getUTCFullYear() + '-' + p2(x.getUTCMonth() + 1) + '-' + p2(x.getUTCDate());
}

/* ======================================================================== storage: the log and the day-type calls */
function readJson(storage, key) { try { const v = JSON.parse(storage.getItem(key)); return v; } catch (e) { return null; } }
function writeJson(storage, key, v) { try { storage.setItem(key, JSON.stringify(v)); return true; } catch (e) { return false; } }

/**
 * Today's log on this PC (live-bot-log-v1): { day, list: [{ k, at, kind, text, level }] }, newest last. kind is 'signal',
 * 'proposal', 'answer', 'mode', 'kill', 'rails', 'daytype', 'notice'. k is the entry's key: an entry with the same key
 * replaces the older one (a proposal's state changes, one signal from several windows). A new trading day starts empty.
 */
function createLog(storage, now) {
  const clock = now || (() => Date.now());
  function read() {
    const v = readJson(storage, KEYS.log), day = tradeDay(clock());
    if (!plainObj(v) || v.day !== day || !Array.isArray(v.list)) return { day, list: [] };
    return { day, list: v.list.filter(e => plainObj(e) && typeof e.k === 'string' && isNum(e.at) && typeof e.text === 'string').slice(-LOG_MAX) };
  }
  function add(e) {
    const s = read();
    const entry = { k: String(e.k || e.kind + ':' + (e.at || clock())), at: isNum(e.at) ? e.at : clock(), kind: String(e.kind || 'notice'), text: String(e.text || '').slice(0, 400), level: e.level || '' };
    if (e.extra && plainObj(e.extra)) entry.extra = e.extra;
    const i = s.list.findIndex(x => x.k === entry.k);
    if (i >= 0) { entry.at = Math.min(entry.at, s.list[i].at) || entry.at; s.list[i] = entry; } else s.list.push(entry);
    s.list.sort((a, b) => a.at - b.at);
    if (s.list.length > LOG_MAX) s.list.splice(0, s.list.length - LOG_MAX);
    writeJson(storage, KEYS.log, s);
    return entry;
  }
  return { read, add, list: () => read().list };
}
/**
 * The day-type selector (Anthony, addendum 2): every call is logged on this PC with its time (live-bot-daytype-v1) and
 * shown. { day, calls: [{ at, type }] }; the current call is the last one. A new trading day starts with no call.
 */
function createDayTypes(storage, now) {
  const clock = now || (() => Date.now());
  function read() {
    const v = readJson(storage, KEYS.dayType), day = tradeDay(clock());
    if (!plainObj(v) || v.day !== day || !Array.isArray(v.calls)) return { day, calls: [] };
    return { day, calls: v.calls.filter(c => plainObj(c) && isNum(c.at) && DAY_TYPES.includes(c.type)).slice(-DAY_LOG_MAX) };
  }
  function call(type) {
    if (!DAY_TYPES.includes(type)) return { error: 'The day type must be ' + DAY_TYPES.join(', ') + '.' };
    const s = read(), c = { at: clock(), type };
    s.calls.push(c);
    if (s.calls.length > DAY_LOG_MAX) s.calls.splice(0, s.calls.length - DAY_LOG_MAX);
    if (!writeJson(storage, KEYS.dayType, s)) return { error: 'This browser would not save it (site data blocked).', call: c };
    return { call: c };
  }
  const current = () => { const c = read().calls; return c.length ? c[c.length - 1].type : ''; };
  return { read, call, current, calls: () => read().calls };
}
/** The per-chart ghost marks switch (off by default): { panelId: true }. */
function readGhosts(storage) {
  const v = readJson(storage, KEYS.ghost), out = {};
  if (plainObj(v)) for (const k of Object.keys(v)) if (/^[A-Za-z0-9_-]{1,40}$/.test(k) && v[k] === true) out[k] = true;
  return out;
}
function setGhost(storage, id, on) {
  const g = readGhosts(storage);
  if (on) g[id] = true; else delete g[id];
  return writeJson(storage, KEYS.ghost, g);
}
/** The Bot tab's options on this PC: { sound } (off by default: Anthony). */
function readOptions(storage) {
  const v = readJson(storage, KEYS.options);
  return { sound: !!(plainObj(v) && v.sound === true) };
}
function setOption(storage, key, val) {
  const o = readOptions(storage);
  if (key === 'sound') o.sound = !!val;
  return writeJson(storage, KEYS.options, o);
}

/* ======================================================================== hotkeys: accept and reject */
/**
 * Copilot's one-key Accept and Reject (Anthony): The Desk's hotkeys document's `accept` and `reject` (GET
 * /api/chart-hotkeys, `keys`), no default. A combo is used only when `refused(combo)` says nothing (the page's
 * OrderTicket.hotkeyRefused), it is not one of the trading hotkeys in use, and the two differ. { accept, reject, notes }.
 */
function answerKeys(doc, tradingKeys, refused) {
  const keys = doc && plainObj(doc.keys) ? doc.keys : {};
  const used = new Set(Object.values(plainObj(tradingKeys) ? tradingKeys : {}).filter(v => typeof v === 'string' && v));
  const out = { accept: '', reject: '', notes: [] };
  for (const id of ['accept', 'reject']) {
    const c = typeof keys[id] === 'string' ? keys[id] : '';
    if (!c) continue;
    const why = c.length > 32 ? 'too long' : typeof refused === 'function' ? refused(c) : '';
    if (why) { out.notes.push(id + ': ' + why); continue; }
    if (used.has(c)) { out.notes.push(id + ': ' + c + ' is a trading hotkey here'); continue; }
    if (id === 'reject' && c === out.accept) { out.notes.push('reject: the same key as accept'); continue; }
    out[id] = c;
  }
  return out;
}

/* ======================================================================== notices */
/**
 * What deserves a corner notice between two `bot` messages (prev may be null): entry, exit, a rail turning amber or red,
 * a stand-down, the heartbeat lost (or back), the kill switch. fmtPnl and fmtPrice write money and prices as the page
 * does. Returns [{ kind, text, level }].
 */
function noticesFrom(prev, next, fmtPnl, fmtPrice) {
  const out = [], a = prev || {}, b = next || {};
  if (!prev || !next) return out;
  const money = typeof fmtPnl === 'function' ? fmtPnl : v => String(v), px = typeof fmtPrice === 'function' ? fmtPrice : v => String(v);
  const qa = a.position && isNum(a.position.qty) ? a.position.qty : 0, qb = b.position && isNum(b.position.qty) ? b.position.qty : 0;
  const nm = b.name || 'The bot';
  if (!qa && qb) out.push({ kind: 'entry', level: '', text: nm + ': entered ' + (qb > 0 ? 'long ' : 'short ') + Math.abs(qb) + ' ' + (b.root || '') + (isNum(b.position.avgPrice) ? ' at ' + px(b.position.avgPrice) : '') });
  else if (qa && !qb) out.push({ kind: 'exit', level: '', text: nm + ': exited; today ' + money(b.pnlToday) });
  else if (qa && qb && Math.sign(qa) !== Math.sign(qb)) out.push({ kind: 'entry', level: '', text: nm + ': reversed to ' + (qb > 0 ? 'long ' : 'short ') + Math.abs(qb) });
  const ra = rails(a), rb = rails(b);
  for (const k of ['trades', 'losses']) {
    const x = ra[k], y = rb[k];
    if (y.known && LEVEL_RANK[y.level] > LEVEL_RANK[x.level]) out.push({ kind: 'limit', level: y.level, text: nm + ': ' + (k === 'trades' ? 'trades ' : 'losing trades ') + y.text + (y.level === 'red' ? ' (at or near the limit)' : '') });
  }
  if (!a.standDown && b.standDown) out.push({ kind: 'standDown', level: 'red', text: nm + ' stood down: ' + b.standDown });
  if (a.connected && !b.connected) out.push({ kind: 'heartbeat', level: 'red', text: nm + ': heartbeat lost. ChartBridge cancelled its unfilled entries; a position keeps its stop and target.' });
  else if (a.enabled && !a.connected && b.connected) out.push({ kind: 'heartbeat', level: '', text: nm + ' is connected' });
  if (!a.killed && b.killed) out.push({ kind: 'kill', level: 'red', text: 'Kill switch on: no bot orders until it is released' });
  else if (a.killed && !b.killed) out.push({ kind: 'kill', level: '', text: 'Kill switch released' });
  return out;
}

/* ======================================================================== signals and trips */
/** A signal for the page's list: { time, title, why, result, tone }. tone 'ok', 'skip', 'bad'. */
function signalLine(s) {
  const x = s || {};
  const side = x.side === 'buy' ? 'Long' : x.side === 'sell' ? 'Short' : '';
  const res = typeof x.result === 'string' ? x.result : '';
  let title, tone = 'ok';
  if (x.action === 'skipped' || res === 'skipped') { title = 'Skipped' + (side ? ' ' + side.toLowerCase() : ''); tone = 'skip'; }
  else if (/^refused/.test(res)) { title = side + ' · refused'; tone = 'bad'; }
  else title = side + ' · ' + ({ shadow: 'shadow', proposed: 'proposed', placed: 'placed' }[res] || res || 'fired');
  const extra = /^refused: /.test(res) ? ' (' + res.slice(9) + ')' : '';
  return { time: isNum(x.at) ? etClock(x.at) : '', title, why: (typeof x.reason === 'string' ? x.reason : '') + extra, result: res, tone };
}
/**
 * The bot's fills as trades for its marks on the charts: execs [{ side, qty, p, t }] in time order (t in the chart's
 * seconds) to [{ tIn, pIn, tOut, pOut, dir, qty }] (an open trade has tOut and pOut null). Average price in, the last
 * fill out; a reversal closes one trade and opens the next.
 */
function trips(execs) {
  const out = [];
  let pos = 0, avg = 0, cur = null;
  for (const f of Array.isArray(execs) ? execs : []) {
    if (!f || (f.side !== 'buy' && f.side !== 'sell') || !(f.qty > 0) || !isNum(f.p) || !isNum(f.t)) continue;
    let q = f.side === 'buy' ? f.qty : -f.qty;
    if (pos && Math.sign(q) !== Math.sign(pos)) {
      const closing = Math.min(Math.abs(q), Math.abs(pos));
      pos += Math.sign(q) * closing; q -= Math.sign(q) * closing;
      if (!pos) { cur.tOut = f.t; cur.pOut = f.p; out.push(cur); cur = null; avg = 0; }
    }
    if (q) {
      if (!pos) { cur = { tIn: f.t, pIn: f.p, tOut: null, pOut: null, dir: Math.sign(q), qty: 0 }; avg = 0; }
      avg = (avg * Math.abs(pos) + f.p * Math.abs(q)) / (Math.abs(pos) + Math.abs(q));
      pos += q; cur.pIn = avg; cur.qty = Math.max(cur.qty, Math.abs(pos));
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* ======================================================================== the strip and formats */
/** R with its sign: '+0.31 R'; null or not a number is ''. */
function fmtR(v, dec) { if (!isNum(v)) return ''; const d = dec === undefined ? 2 : dec, s = Math.abs(v).toFixed(d); return (+s === 0 ? '' : v > 0 ? '+' : '-') + s + ' R'; }
/** A share 0 to 1 as a percent: '58.4%'. */
function fmtPct(v) { return isNum(v) ? (v * 100).toFixed(1) + '%' : ''; }
/** Dollars with a sign: '+$40.00', '-$12.50', '$0.00'. */
function fmtUsd(v) {
  if (!isNum(v)) return '';
  const s = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (+Math.abs(v).toFixed(2) === 0 ? '' : v > 0 ? '+' : '-') + '$' + s;
}
/** The bot's position in words: 'Flat', 'Long 1 @ 24,901.25'. */
function positionText(pos, fmtPrice) {
  const q = pos && isNum(pos.qty) ? pos.qty : 0;
  if (!q) return 'Flat';
  const px = pos && isNum(pos.avgPrice) ? ' @ ' + (typeof fmtPrice === 'function' ? fmtPrice(pos.avgPrice) : pos.avgPrice) : '';
  return (q > 0 ? 'Long ' : 'Short ') + Math.abs(q) + px;
}
/** The bot strip's line (Main tab): { name, mode, position, pnl, pnlTone, last, trades, losses, level, state }. */
function stripModel(bot, fmtPrice) {
  const b = bot || {};
  const r = rails(b);
  const last = b.lastSignal ? signalLine(b.lastSignal) : null;
  const state = !b.enabled ? 'off' : b.killed ? 'killed' : b.standDown ? 'standDown' : !b.connected ? 'lost' : 'on';
  return {
    name: typeof b.name === 'string' && b.name ? b.name : 'Bot', mode: MODE_NAME[b.mode] || '-',
    position: positionText(b.position, fmtPrice), pnl: isNum(b.pnlToday) ? fmtUsd(b.pnlToday) : '-',
    pnlTone: isNum(b.pnlToday) ? (b.pnlToday > 0 ? 'pos' : b.pnlToday < 0 ? 'neg' : '') : '',
    last: last ? 'Last signal ' + last.time + ' ' + last.title.toLowerCase() : 'No signal yet today',
    trades: r.trades, losses: r.losses, level: r.level, state,
  };
}
/** The status words for the panel: what the bot is doing. */
function statusText(b) {
  if (!b || !b.enabled) return 'Off: the bot channel is off in ChartBridge';
  if (b.killed) return 'Kill switch on: no bot orders';
  if (b.standDown) return 'Stood down: ' + b.standDown;
  if (!b.connected) return 'Not connected: no bot program on this PC';
  if (isNum(b.lastBeatMs) && b.lastBeatMs > 5000) return 'Heartbeat late (' + (b.lastBeatMs / 1000).toFixed(1) + ' s)';
  return 'Watching';
}

return {
  VERSION, RAILS, RAIL_MAX, BOT_ACCOUNT, ROOT_SIBLING, isBotMark, AMBER, RED, THIN, MODES, MODE_NAME, DAY_TYPES, PROPOSAL_END, KEYS, LIB_VERSION, SHELVES, COND_KEYS,
  railLevel, rails, railsChange, worse,
  modesAllowed, simTradable, botSwitchOn,
  createProposals,
  parseLibrary, checkEntry, shelves, slotEntry, thinCell, timeOfDayRow, thinEquity, ruleLines, evidenceLevel,
  etClock, etClockSec, tradeDay,
  createLog, createDayTypes, readGhosts, setGhost, readOptions, setOption,
  answerKeys, noticesFrom, signalLine, trips,
  fmtR, fmtPct, fmtUsd, positionText, stripModel, statusText,
};
});
