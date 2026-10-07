// A stand-in for the ChartBridge NT8 add-on, speaking nt8/PROTOCOL.md with sample data.
// For tests and offline work only; prices are NOT market data and no order reaches a broker.
//   node test/fake-bridge.mjs [port] [flags]      then open http://localhost:<port>/live/
// Flags (the config.txt keys of the real add-on):
//   --trading                       trading = true (off by default, like ChartBridge)
//   --trade-accounts=Sim101,DEMO-EVAL   tradeAccounts
//   --max-qty=MNQ:5,NQ:2            maxQty.MNQ = 5 and so on (default 1)
//   --max-ticks-away=400            maxTicksAway = 400 (ChartBridge 0.3.7: a limit or stop price at most this many ticks from
//                                   the last price; default none)
//   --max-bracket-ticks=300         maxBracketTicks = 300 (0.3.7: a bracket stop or target at most this many ticks; default none)
//   --v1                            behave like ChartBridge 0.2 (protocol v1, read only: no trading, no /session)
//   --test-controls                 POST /test/price?root=MNQ&p=25400.25 sets the price and holds the random walk;
//                                   /test/hold, /test/state, /test/status (broadcast a status line), /test/elsewhere
//   --allow-frames                  drop X-Frame-Options and frame-ancestors (only to test the page's own frame check)
//   --allow-origins=https://desk.example,http://host:8800   allowOrigins: other web pages that may open the
//                                   read-only WebSocket (ChartBridge 0.3.1 rule; never trade)
//   --tick-hours-max=3              serve at most this many hours of tick history, whatever the page asks
//                                   (like a PC with little local tick data)
//   --market-hours                  sample data on the real calendar (chart 1.6.1, for the weekend volume profile):
//                                   the sample moved by whole weeks so its weekends fall on the real ones and nothing
//                                   comes after the clock; no trades while CME Globex is closed (the engine's
//                                   util.cmeClosed: Friday 17:00 to Sunday 18:00, the 17:00 break, New Year's Day,
//                                   Good Friday and Christmas, and from 13:00 on the other NYSE holidays, the equity
//                                   futures' halt); tick history counted back from the clock, as ChartBridge does
//   --tick-shift-ms=137             every trade stamped this many ms later (history and live), as real trades are: a
//                                   session's first trade at 18:00:00.137, not 18:00:00.000 (chart 1.6.1, review 2 S4)
//   --version=0.3.5                 the version hello reports (default fake-0.3.2; fake-0.2.1 with --v1); the page
//                                   reads how many hours of ticks ChartBridge serves from it (48 before 0.3.5)
//   --tick-gaps                     tick history skips prices now and then (1 to 3 ticks, sometimes a fast 8 to 16),
//                                   like a fast market, so the two range bar modes differ (sample data, seeded)
//   --tickets                       like The Desk's relay: /ws needs ?ticket=<t>, and each ticket works once
//                                   (a missing or reused one is refused), so every reconnect needs a fresh URL.
//                                   A ticketed connection stands for the relay, which reaches ChartBridge with no
//                                   Origin, so ChartBridge's PIN does not apply to it (the relay has its own gate)
//   --pin-file=path                 where the PIN hash lives (ChartBridge 0.3.2 keeps pin.txt in its folder), so a
//                                   restarted fake keeps the PIN and an open page's unlock; default: memory only
//   --test-pin=2468                 start with this made-up PIN set (tests only), unless the pin file has one
//   --no-hello-accounts             hello lists no accounts and no fills are sent (NinjaTrader with no connected
//                                   account yet); trading and its accounts come from the sign-in as usual
//   --pin-off                       behave like ChartBridge 0.3.1 for the PIN only (no /pin/, nothing gated), to
//                                   measure a page from a checkout older than the PIN (perf-live --root)
// ChartBridge 0.3.2's PIN (test/fake-pin.mjs): the page's WebSocket needs ?unlock=<token> and GET /session the
// X-ChartBridge-Unlock header; POST /pin/status, /pin/set, /pin/unlock, /pin/change. --v1 has no PIN.
// With --test-controls, also: /test/drop closes every WebSocket (a dropped connection); /test/received lists
// what the pages sent (message types, GET /session count, WebSocket URLs, ticketsRefused).
// Load and performance testing (test/perf-live.mjs); sample data, seeded, never market data:
//   --tick-rate=15                  tick history this dense: 15 trades a second on average (weighted by each
//                                   minute's volume), so 33 hours of NQ come to about 1.8 million ticks
//   --live-rate=100                 live trades per second on average, with a burst of 3 times that for 1.5 s in
//                                   every 10 s (a busy market), instead of one trade every 120 ms
//   --serve-root=DIR                serve the page files from another checkout (to compare versions)
//   --clock-offset=-45000           run the exchange clock this many seconds off the PC's (a chosen time of day)
//   --pc-clock-offset=-45010        the clock of the PC ChartBridge runs on, as seconds off the real one (default: the
//                                   exchange clock's, --clock-offset): each live tick's `rx` is read from it and `u` from
//                                   the exchange clock (the data's time, a few ms before), so a PC clock 10 s behind the
//                                   exchange is --pc-clock-offset=<clock offset - 10> (the page's own clock is the test's)
//   --load-delay-ms=3000            a load's ticks and `ready` go out this long after its subscribe (NinjaTrader answering
//                                   the tick request), and no live trade reaches the page meanwhile, as with ChartBridge
//                                   holding them (a page reloading for more ticks misses those seconds)
//   --cme-hours                     the history and trades follow CME's hours on the exchange clock: no minute bar, tick or
//                                   live trade from 17:00 to 18:00 ET, or from Friday 17:00 to Sunday 18:00 (sample data
//                                   shifted to now otherwise trades through 18:00)
//   --no-sides                      behave like ChartBridge 0.3.3 for trade sides: ticks as [t,p,v] and live ticks without
//                                   s and sm (to check the page against an older add-on); no q either
//   --no-q                          behave like ChartBridge 0.3.7 for the Time and Sales category: no q anywhere
// Trade sides (ChartBridge 0.3.4, nt8/PROTOCOL.md "Trade side"): every backfill trade is [t, p, v, s, sm] and every live
// tick carries s (1 buy, -1 sell, 0 unknown) and sm (0 none, 1 aggressor flag, 2 bid/ask, 3 tick rule). The fake has no
// quotes: a trade that moved the price counts as at the quote (sm 2: up a buy, down a sell), an unchanged one keeps the
// previous side by the tick rule (sm 3), the first is unknown (0, 0). Sample data, not a real classification.
// Time and Sales category (ChartBridge 0.3.8, nt8/PROTOCOL.md "Time and Sales category"): a live tick carries q (2 above
// the ask, 1 at it, 0 between, -1 at the bid, -2 below it; no field when unknown) and a backfill trade with one is
// [t, p, v, s, sm, q] (a full load keeps the fake's 0.3.4 sides in places 4 and 5); the served window (--live-first) is
// [t, p, v] for its history (NinjaTrader's answer has no quote) and [t, p, v, null, null, q] for the trades the fake made
// live, as ChartBridge 0.3.8 sends it. The fake has no quotes either: a move of one tick is at the quote (1 or -1), of
// two or more through it (2 or -2), an unchanged price between (0); the first trade, and backfill trades before
// --quote-hours, unknown. Sample data.
// Served window and session table (ChartBridge 0.3.5, nt8/PROTOCOL.md "Served window" and "Session table"), sample data,
// never market data:
//   --live-first                    hello lists "liveFirst" and "profile". The data is one tape per instrument: the tick
//                                   history, then every live trade appended to it, so what a page gets can be checked trade
//                                   by trade (/test/tape). A seconds or range load (subscribe liveFirst, tickHours above 0)
//                                   gets the served window: the last --range-hours of trades; the first such load of a
//                                   session "asks NinjaTrader" (--window-ms), later ones (a reload, another page) get the same
//                                   window from the fake's memory, from the same first trade, extended by the live trades
//                                   (dropped at the next session). Live trades are held during a load, as ChartBridge does.
//                                   A subscribe with profile gets the "profile" message before ready: the session table
//                                   (the tape's trades of the session so far, per half hour and price), exactly the trades
//                                   before the ones the page gets next. A load without liveFirst is a full load from the tape.
//   --range-hours=2                 the served window's hours (ChartBridge's rangeHours)
//   --window-ms=300                 how long "NinjaTrader" takes to answer the first window of a session
//   --table-building=MS             the table is building (ChartBridge started mid-session): only the live trades from the
//                                   fake's start, for MS ms; then its one backfill makes it whole and every page that is
//                                   live and asked for "profile" gets a new one (no sub). Only for --profile-roots
//   --profile-roots=MNQ,NQ          ChartBridge's profileRoots (default all four): with --table-building the others never
//                                   get a backfill (their table counts from the fake's start: "since")
//   As ChartBridge 0.3.5 does it, every tick subscribe gets the served window, with or without liveFirst (a 1.6.x page)
//   --calendar                      sample data on the real calendar at the fake's clock: weekends and the 17:00 to 18:00 ET
//                                   break where they fall (with --clock-offset, a Sunday 18:00 open with Friday before it)
//   With --test-controls: POST /test/features?liveFirst=0 makes hello leave the features out (a full load, like 0.3.4) for
//   new connections; POST /test/tape?root=NQ&from=<t> the tape's trades from that time; /test/books what the fake's
//   "ChartBridge" did per instrument (windows asked and served, the table's state); /test/feed-drop a data connection drop
//   (every table not whole from then on, the served windows dropped, live pages get the profile again).
// --quote-hours=N (ChartBridge 0.3.4.1's config.txt quoteHours): only the backfill's last N hours have measured sides
// (sm 2); every trade before them gets a tick-rule side (sm 3), as when NinjaTrader is asked for no historical quotes
// there. 0 is 0.3.4.1's default (no measured side in the backfill); without the flag, every backfill trade is measured
// like 0.3.4's (its quote history covered the whole window).
// --data-037 (ChartBridge 0.3.7, data side, see nt8/PROTOCOL.md): hello lists a sample prior settlement and its date per instrument
//   (made-up sample data, as everything here) and the features "settlement", "htf", "weekProfile"; the page's strict
//   "htf" request is answered with 4h, 1D or 1W bars made from the sample minutes and kept live by the fake trades
//   ("htfBar" at most once a second), and "weekProfile" with the last 5 sessions' volume at price of the sample minutes
//   (one listed "missing", as a session ChartBridge has no table for). With --test-controls, POST
//   /test/settlement?root=MNQ&p=21456.25&date=2026-09-28 sends a "settlement" message to every page (p=null: none known).
// --deep-history (chart 1.15.0): 62 days of sample minutes instead of a week, and a subscribe gets the `days` it asks for
//   (calendar days back from the last minute; 5 when left out), as ChartBridge does, so a 1 hour chart's 30 days can be
//   loaded and timed. With --test-controls, GET /test/received lists each subscribe's days too.
// --data-037 with --test-controls: POST /test/htf?fail=<why> answers every later htf request with no bars and that error
//   (as ChartBridge does after NinjaTrader's 15 s timeout or a refusal); /test/htf?fail= answers them again.
// --scene=signals (chart signals, G1c): once a page is live on MNQ, MNQ's random walk stops and a scripted tape replays
//   instead (test/signals-scene.mjs: sample trades with sides that read like a real stretch of regular hours, with a few
//   large prints), --scene-warp=36 times faster than the clock (each trade stamped on the scene's own clock from the
//   moment it started, so bars and times read as a real market's), after --scene-delay=1500 ms. With --test-controls,
//   GET /test/scene says how far it got ({ started, sent, total, done }). Sample data, never market data.
// Order entry itself (gates, matching, brackets) is test/fake-orders.mjs.
// --v3 (ChartBridge 0.4.0, protocol v3, nt8/PROTOCOL.md "Protocol v3"; test/fake-v3.mjs): every v3 switch on (accountChecks,
//   orderTypes, strategies, merge, cancelFromList, copier, bot, tapeStats) and the quote-only roots; made-up accounts EVAL-A,
//   EVAL-B, FUNDED-C, SIM-F1, SIM-F2 and Sim101 (tradeAccounts Sim101, EVAL-A pre-checked unless --trade-accounts says
//   otherwise); EVAL-A holds 2 MNQ and a working sell limit, FUNDED-C a working NQ buy limit, EVAL-B loses its connection
//   and goes Gone after the grace; SIM-F1 (3 micro) and SIM-F2 (1 mini) are copier followers of Sim101, stood down until
//   Re-arm. Sample data and made-up names only.
//   --v3-off=copier,bot             those v3 switches off (to test a page against a switch that is off)
//   --gone-grace-ms=10000           the Gone grace (PROTOCOL.md: 10 s); shorter for tests
//   --quote-roots                   only the quote-only roots (YM, RTY, GC, SI, CL, 6E, ZN, ZB), without the rest of v3
//   --no-v3-seed                    no seeded positions, orders or followers
//   With --v3 the bot channel listens on /bot (no Origin, header X-ChartBridge-Bot: the secret, one at a time).
//   With --test-controls (POST): /test/bot-secret (tests only; ChartBridge never shows it), POST /test/bot-connect?on=1 (a
//   simulated bot that never misses a heartbeat; on=0 drops it), /test/bot-signal?id=&action=fired&side=sell&kind=limit&p=
//   &stop=12&target=24&reason= (a signal, handled by the mode), /test/bot-proposal?... (the same, always proposed: a
//   proposal on demand), /test/bot-withdraw?id=, /test/account?name=EVAL-A&connection=lost|connected|disabled,
//   /test/restart?lost=1 (managed strategies resume, or with lost=1 cannot), /test/v3 (the v3 state as JSON).
//   GET /bot-library (lane C4, docs/BOT_LIBRARY.md): with --v3 and the bot switch on, the made-up example
//   test/fixtures/bot-library.json, or the file --bot-library=path names; --no-bot-library answers 404 (no file on this PC).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { OrderDesk } from './fake-orders.mjs';
import { PinLock, HEADER as PIN_HEADER } from './fake-pin.mjs';
import { signalScene } from './signals-scene.mjs';
import { OrderDeskV3, V3_ACCOUNTS, QUOTE_INSTR, TapeStats, SWITCHES } from './fake-v3.mjs';

const require = createRequire(import.meta.url);
const CE = require('../src/chart-engine.js');
const SampleFeed = require('../demo/sample-feed.js');
const root = flagValueEarly('serve-root') ? path.resolve(flagValueEarly('serve-root')) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function flagValueEarly(name) { const a = process.argv.slice(2).find(x => x.startsWith('--' + name + '=')); return a ? a.slice(a.indexOf('=') + 1) : ''; }
const args = process.argv.slice(2);
const flag = name => args.find(a => a === '--' + name || a.startsWith('--' + name + '='));
const flagValue = name => { const a = flag(name); return a && a.includes('=') ? a.slice(a.indexOf('=') + 1) : ''; };
const PORT = +(args.find(a => /^\d+$/.test(a)) || process.env.PORT || 8765);
const SCENE = flagValue('scene'), SCENE_WARP = +flagValue('scene-warp') || 36, SCENE_DELAY = flagValue('scene-delay') === '' ? 1500 : +flagValue('scene-delay');
const PIN_OFF = !!flag('pin-off');
const NO_HELLO_ACCOUNTS = !!flag('no-hello-accounts');
const DATA_037 = !!flag('data-037');
const DEEP = !!flag('deep-history');
const V3 = !!flag('v3') && !flag('v1');
const V3_OFF = flagValue('v3-off').split(',').map(x => x.trim()).filter(Boolean);
const QUOTE = (V3 && !V3_OFF.includes('quoteRoots')) || (!!flag('quote-roots') && !flag('v1'));
const TAPE_STATS = V3 && !V3_OFF.includes('tapeStats');
let htfFail = '';                                  // /test/htf?fail=: the error every htf request gets (none when '')
const V1 = !!flag('v1'), TEST_CONTROLS = !!flag('test-controls'), ALLOW_FRAMES = !!flag('allow-frames'), TICK_GAPS = !!flag('tick-gaps'), TICKETS = !!flag('tickets');
const TICK_HOURS_MAX = flagValue('tick-hours-max') ? +flagValue('tick-hours-max') : Infinity;
const TICK_RATE = +flagValue('tick-rate') || 0, LIVE_RATE = +flagValue('live-rate') || 0;
const SIDES = !flag('no-sides') && !V1;           // ChartBridge 0.2 (--v1) had no sides either
const TAPE_Q = SIDES && !flag('no-q');             // 0.3.8: the Time and Sales category (see the header)
const LIVE_FIRST = !!flag('live-first') && !V1, CALENDAR = !!flag('calendar');
let liveFirstOn = LIVE_FIRST;                      // /test/features can turn it off for new connections
const RANGE_HOURS = +flagValue('range-hours') || 2, WINDOW_MS = flagValue('window-ms') === '' ? 300 : +flagValue('window-ms');
const TABLE_BUILDING_MS = flagValue('table-building') === '' ? -1 : +flagValue('table-building');
const PROFILE_ROOTS = flagValue('profile-roots') ? flagValue('profile-roots').split(',').map(x => x.trim().toUpperCase()) : ['MNQ', 'NQ', 'ES', 'MES'];
let dropAt = null;                                 // /test/feed-drop: when the data connection dropped (bar time)
/* The side of a trade from the previous one (see the header): [s, sm]. */
function sideOf(p, prev, prevSide) {
  if (prev === undefined) return [0, 0];
  if (p > prev + 1e-9) return [1, 2];
  if (p < prev - 1e-9) return [-1, 2];
  return prevSide ? [prevSide, 3] : [0, 0];
}
/* The Time and Sales category of a trade from the previous price and its side's method (see the header), or null. */
function qOf(p, prev, sm) {
  if (sm === 2) { const d = p - prev; return Math.abs(d) >= 0.5 - 1e-9 ? Math.sign(d) * 2 : Math.sign(d); }
  return sm === 3 ? 0 : null;
}
// 0.3.7: a limit that is not a whole number of 1 or more is no limit, and the pages are warned (Anthony, 2026-10-01).
const limitWarnings = [];
function limitFlag(name, key) {
  const v = flagValue(name);
  if (v === '') return 0;
  if (/^[0-9]+$/.test(v) && +v >= 1) return +v;
  limitWarnings.push('config.txt: ' + key + ' = ' + v + ' is not a whole number of 1 or more; it is ignored, so there is NO ' + key + ' limit');
  return 0;
}
const config = {
  trading: !V1 && !!flag('trading'),
  tradeAccounts: (flagValue('trade-accounts') || (V3 ? 'Sim101,EVAL-A' : '')).split(',').map(x => x.trim()).filter(Boolean),
  maxQty: Object.fromEntries(flagValue('max-qty').split(',').filter(Boolean).map(x => { const [r, n] = x.split(':'); return [r.trim(), +n]; })),
  maxTicksAway: limitFlag('max-ticks-away', 'maxTicksAway'),            // 0.3.7: 0 = no limit, as an absent config.txt line
  maxBracketTicks: limitFlag('max-bracket-ticks', 'maxBracketTicks'),
  warnings: limitWarnings,                                              // told to every page as it signs in, as ChartBridge does
  port: PORT,
  // ChartBridge 0.3.1: exact scheme://host[:port], lower-cased (the real parser also drops a default port and
  // a trailing slash, and skips wildcards; the fake takes the list as given)
  allowOrigins: flagValue('allow-origins').split(',').map(x => x.trim().toLowerCase().replace(/\/$/, '')).filter(Boolean),
};
const ACCOUNTS = V3 ? V3_ACCOUNTS.map(a => a.name) : ['DEMO-EVAL', 'DEMO-EMPTY', 'Sim101'];
const pin = new PinLock({ file: flagValue('pin-file') || null });
const pinReady = flagValue('test-pin') && !pin.isSet() ? pin.set(flagValue('test-pin')) : Promise.resolve();
const OWN = 'http://localhost:' + PORT;

const CLOCK_OFFSET = +flagValue('clock-offset') || 0;
const PC_CLOCK_OFFSET = flagValue('pc-clock-offset') !== '' ? +flagValue('pc-clock-offset') : CLOCK_OFFSET;
const CME_HOURS = !!flag('cme-hours');
const QUOTE_HOURS = flagValue('quote-hours') !== '' ? +flagValue('quote-hours') : null;
const LOAD_DELAY_MS = +flagValue('load-delay-ms') || 0;
const etNow = () => CE.util.zoneSeconds(Date.now() / 1000 + CLOCK_OFFSET);
const MARKET_HOURS = !!flag('market-hours');
/* --market-hours: whether CME equity index futures are closed at exchange time t (the CME calendar, see the header). */
const marketClosed = t => CE.util.cmeClosed(t);
const TICK_SHIFT = (+flagValue('tick-shift-ms') || 0) / 1000;
/* CME closed (Globex equity futures) at exchange time t (New York wall clock as bar-time seconds): 17:00 to 18:00 every
   day, Friday 17:00 to Sunday 18:00. */
function cmeClosed(t) {
  const d = new Date(t * 1000).getUTCDay(), s = ((t % 86400) + 86400) % 86400;
  if (d === 6) return true;
  if (d === 5 && s >= 61200) return true;
  if (d === 0 && s < 64800) return true;
  return s >= 61200 && s < 64800;
}
const INSTR = {
  MNQ: { name: 'MNQ 12-26', tick: 0.25, pointValue: 2, scale: 1 },
  NQ: { name: 'NQ 12-26', tick: 0.25, pointValue: 20, scale: 1 },
  MES: { name: 'MES 12-26', tick: 0.25, pointValue: 5, scale: 0.26 },
  ES: { name: 'ES 12-26', tick: 0.25, pointValue: 50, scale: 0.26 },
};
if (QUOTE) Object.assign(INSTR, QUOTE_INSTR);       // v3: quote-only markets (sample prices), never traded
const rq = (p, t) => Math.round(p / t) * t;
/* a price on root r's grid; the quote-only roots' small ticks are rounded to their decimals (float noise) */
const rqr = (p, r) => { const i = INSTR[r]; return i.quoteOnly ? +(Math.round(p / i.tick) * i.tick).toFixed(i.decimals) : rq(p, i.tick); };

// Sample history shifted so its last bar is the current minute (--calendar: made on the real calendar up to now, unshifted).
function makeData(rootSym) {
  const liveMin = Math.floor(etNow() / 60) * 60;
  // --calendar: the feed made up to the next Tuesday 10:31 ET (its demo trades need that morning), from a week before, and
  // cut at the current minute
  let tue = Math.floor(liveMin / 86400);
  while (new Date(tue * 86400000).getUTCDay() !== 2 || tue * 86400 + 37860 < liveMin) tue++;
  const feed = CALENDAR ? SampleFeed.create({ seed: 20260929 + rootSym.length, start: (tue - 8) * 86400 + 18 * 3600, live: tue * 86400 + 37860 })
    : DEEP ? SampleFeed.create({ seed: 20260929 + rootSym.length, start: Date.UTC(2026, 6, 28, 18, 0) / 1000 })   // --deep-history: from Tue Jul 28 18:00 ET
    : SampleFeed.create({ seed: 20260929 + rootSym.length });
  const k = INSTR[rootSym].scale;
  const base = CALENDAR ? feed.base.filter(b => b.t <= liveMin) : feed.base.slice(0, -1);
  let shift = CALENDAR ? 0 : liveMin - base[base.length - 1].t;
  if (MARKET_HOURS && !CALENDAR) { const W = 7 * 86400; let k = Math.ceil(shift / W); if (base[0].t + k * W > etNow()) k--; shift = k * W; }
  let bars = base.map(b => ({ t: b.t + shift, o: rqr(b.o * k, rootSym), h: rqr(b.h * k, rootSym), l: rqr(b.l * k, rootSym), c: rqr(b.c * k, rootSym), v: b.v }));
  for (const b of bars) { b.h = Math.max(b.h, b.o, b.c); b.l = Math.min(b.l, b.o, b.c); }
  if (CME_HOURS) bars = bars.filter(b => !cmeClosed(b.t));
  return MARKET_HOURS ? bars.filter(b => b.t <= Math.floor(etNow() / 60) * 60 && !marketClosed(b.t)) : bars;
}
function ticksFrom(bars, hours, r) {
  const tk = r && INSTR[r] ? INSTR[r].tick : 0.25, grid = p => r && INSTR[r] ? rqr(p, r) : rq(p, 0.25);
  const out = [], from = (MARKET_HOURS ? etNow() : bars[bars.length - 1].t) - hours * 3600;
  const quoteFrom = QUOTE_HOURS === null ? -Infinity : (MARKET_HOURS ? etNow() : bars[bars.length - 1].t + 60) - QUOTE_HOURS * 3600;
  const nowT = etNow();                                  // no trade after now (the forming minute's walk used to run on to :59.9)
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const stepTicks = () => { if (!TICK_GAPS) return 1; const r = rnd(); return r < 0.8 ? 1 : r < 0.97 ? 2 + Math.floor(rnd() * 2) : 8 + Math.floor(rnd() * 9); };
  for (const b of bars) {
    if (b.t < from) continue;
    // walk open -> low -> high -> close (or the other way) one tick at a time, like real trades
    const way = b.c >= b.o ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
    const prices = [way[0]];
    for (let s = 1; s < way.length; s++) {
      let p = prices[prices.length - 1];
      const dir = way[s] > p ? 1 : -1;
      while (Math.abs(way[s] - p) > tk / 1e4) { const left = Math.round(Math.abs(way[s] - p) / tk); p = grid(p + dir * tk * Math.min(left, stepTicks())); prices.push(p); }
    }
    if (TICK_RATE) pad(prices, b, Math.round(TICK_RATE * 60 * b.v / avgVol(bars)), rnd);
    // the minute's volume shared out over its trades, so they add up to the bar's (at least 1 each), as NinjaTrader's do
    const base = Math.floor(b.v / prices.length), extra = b.v - base * prices.length;
    prices.forEach((p, i) => {
      const row = [+(b.t + i * 59.9 / prices.length + TICK_SHIFT).toFixed(3), p, Math.max(1, base + (i < extra ? 1 : 0))];
      if (row[0] > nowT) return;
      if (SIDES) {
        const prev = out.length ? out[out.length - 1] : undefined, sd = sideOf(p, prev && prev[1], prev && prev[3]);
        if (sd[1] === 2 && row[0] < quoteFrom) sd[1] = 3;          // before the quote window: the same side, by the tick rule
        row.push(...sd);
        const q = TAPE_Q && row[0] >= quoteFrom ? qOf(p, prev && prev[1], sd[1]) : null;
        if (q !== null) row.push(q);                                // 0.3.8: the 6th place, only when known
      }
      out.push(row);
    });
  }
  return out;
}
/* --tick-rate: fill a minute's walk up to n trades with trades at the same price or one tick away, inside the bar */
function pad(prices, b, n, rnd) {
  const extra = n - prices.length;
  if (extra <= 0) return;
  const out = [];
  const every = extra / prices.length;
  let owe = 0;
  for (const p of prices) {
    out.push(p);
    for (owe += every; owe >= 1; owe--) {
      const r = rnd(), q = r < 0.6 ? p : r < 0.8 ? p + 0.25 : p - 0.25;
      out.push(q > b.h || q < b.l ? p : q);
    }
  }
  prices.splice(0, prices.length, ...out);
}
let avgVolCache = new WeakMap();
function avgVol(bars) {
  let a = avgVolCache.get(bars);
  if (a === undefined) { a = bars.reduce((s, b) => s + b.v, 0) / bars.length || 1; avgVolCache.set(bars, a); }
  return a;
}

const data = {};
for (const r of Object.keys(INSTR)) data[r] = makeData(r);

/* --live-first: one tape of trades per instrument, in columns (history up to now, then every live trade), with sides. */
class Tape {
  constructor(cap) { this.n = 0; this._grow(cap || 1024); }
  _grow(cap) {
    const old = this.n ? this : null;
    this.cap = cap;
    const t = new Float64Array(cap), p = new Float64Array(cap), v = new Float64Array(cap), s = new Int8Array(cap), m = new Int8Array(cap), q = new Int8Array(cap);
    if (old) { t.set(this.t.subarray(0, this.n)); p.set(this.p.subarray(0, this.n)); v.set(this.v.subarray(0, this.n)); s.set(this.s.subarray(0, this.n)); m.set(this.m.subarray(0, this.n)); q.set(this.q.subarray(0, this.n)); }
    this.t = t; this.p = p; this.v = v; this.s = s; this.m = m; this.q = q;
  }
  /* q: the Time and Sales category, null when unknown (kept as -128) */
  push(t, p, v, s, sm, q) { if (this.n === this.cap) this._grow(this.cap * 2); const i = this.n++; this.t[i] = t; this.p[i] = p; this.v[i] = v; this.s[i] = s; this.m[i] = sm; this.q[i] = q === null || q === undefined ? -128 : q; }
  row(i) {
    if (!SIDES) return [this.t[i], this.p[i], this.v[i]];
    return TAPE_Q && this.q[i] !== -128 ? [this.t[i], this.p[i], this.v[i], this.s[i], this.m[i], this.q[i]] : [this.t[i], this.p[i], this.v[i], this.s[i], this.m[i]];
  }
  /* plain: the served window as ChartBridge 0.3.7 sends it, [t, p, v]; 0.3.8: [t, p, v, null, null, q] for a trade with a known q */
  plainRow(i) { return TAPE_Q && this.q[i] !== -128 ? [this.t[i], this.p[i], this.v[i], null, null, this.q[i]] : [this.t[i], this.p[i], this.v[i]]; }
  rows(a, b, plain) { const out = new Array(Math.max(0, b - a)); for (let i = a; i < b; i++) out[i - a] = plain ? this.plainRow(i) : this.row(i); return out; }
  /* the first trade at or after time t */
  at(t) { let lo = 0, hi = this.n; while (lo < hi) { const m = (lo + hi) >> 1; if (this.t[m] < t) lo = m + 1; else hi = m; } return lo; }
}
const tapes = {};
if (LIVE_FIRST) for (const r of Object.keys(INSTR)) {
  const hist = ticksFrom(data[r], CALENDAR ? 96 : 48, r), now = etNow(), k = new Tape(hist.length + 65536);   // --calendar: back over a weekend
  let prevP, prevS = 0;
  for (const x of hist) {
    if (x[0] > now) break;                          // the tape ends now; live trades carry on from here
    const [sd, sm] = sideOf(x[1], prevP, prevS);
    k.push(x[0], x[1], x[2], sd, sm, null); prevP = x[1]; prevS = sd;   // NinjaTrader's tick answer: no stored quote, q unknown
  }
  tapes[r] = k;
}
/* The fake's "ChartBridge" per instrument (--live-first): the served window (its first tape index and session) and the
   session table's state. The table itself is worked out from the tape when a profile is sent (the same numbers ChartBridge
   keeps as trades come). */
const SESSION = 18 * 3600;
const sessionOf = t => (CE.util.tradeDay(t, SESSION) - 1) * 86400 + SESSION;
const startN = {};
for (const r of Object.keys(tapes)) startN[r] = tapes[r].n;   // --table-building: the live trades from here on
const books = {};
for (const r of Object.keys(tapes)) books[r] = { window: null, asked: 0, served: 0, profiles: 0, pushed: 0 };
let backfillDone = false;                          // --table-building: set when its time has come (a flag: timers can fire a ms early)
const backfilled = r => TABLE_BUILDING_MS < 0 || (backfillDone && PROFILE_ROOTS.includes(r));
const tableWhole = r => dropAt === null && backfilled(r);
/* One session's table from the tape, trades [a, b), as ChartBridge sends it: [[half hour start, price in ticks, volume]]. */
function tableRows(r, a, b) {
  const k = tapes[r], tick = INSTR[r].tick, m = new Map();
  for (let i = a; i < b; i++) {
    const key = Math.floor(k.t[i] / 1800) * 1800 + '|' + Math.round(k.p[i] / tick);
    m.set(key, (m.get(key) || 0) + k.v[i]);
  }
  return [...m].map(([key, v]) => { const [h, p] = key.split('|'); return [+h, +p, v]; }).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}
/* The "profile" message: the session of the tape's last trade up to trade `end` (ChartBridge's table), and the one before. */
function profileMsg(r, end, sub) {
  const k = tapes[r], lastT = end > 0 ? k.t[end - 1] : etNow(), s0 = sessionOf(lastT), a = k.at(s0);
  const whole = tableWhole(r), all = backfilled(r);
  const from = all ? a : Math.max(a, startN[r]);
  const cov = all ? s0 : startN[r] < k.n ? Math.max(s0, k.t[startN[r]]) : etNow();
  const backfill = TABLE_BUILDING_MS < 0 ? 'none' : !PROFILE_ROOTS.includes(r) ? 'none (not in profileRoots)' : all ? 'done' : 'asked';
  const p0 = k.at(sessionOf(s0 - 1));
  const msg = { type: 'profile', root: r, tick: INSTR[r].tick, bucketSeconds: 1800,
    session: { from: s0, whole, coveredFrom: +cov.toFixed(3), backfill, drop: dropAt === null ? null : { at: dropAt, why: 'the data connection went ConnectionLost' }, rows: tableRows(r, from, end) },
    last: p0 < a ? { from: sessionOf(s0 - 1), whole: true, coveredFrom: sessionOf(s0 - 1), rows: tableRows(r, p0, a) } : null };
  if (sub !== undefined) msg.sub = sub;
  books[r].profiles++;
  return msg;
}
if (LIVE_FIRST && TABLE_BUILDING_MS >= 0) setTimeout(() => {
  // the one backfill of the session is in: the table is whole, and every live page that asked for it gets it
  backfillDone = true;
  for (const c of clients) if (c.ready && c.profile && tapes[c.root] && PROFILE_ROOTS.includes(c.root)) { send(c, profileMsg(c.root, tapes[c.root].n)); books[c.root].pushed++; }
}, TABLE_BUILDING_MS);

// ---------------------------------------------------------------- tiny WebSocket server
function frame(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function parseFrames(buf, onText) {
  let off = 0;
  while (buf.length - off >= 2) {
    const op = buf[off] & 0x0f, masked = buf[off + 1] & 0x80;
    let len = buf[off + 1] & 0x7f, p = off + 2;
    if (len === 126) { if (buf.length < p + 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length < p + 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const mask = masked ? buf.slice(p, p + 4) : null; if (masked) p += 4;
    if (buf.length < p + len) break;
    const data = Buffer.from(buf.slice(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    if (op === 1) onText(data.toString('utf8'));
    if (op === 8) return { rest: Buffer.alloc(0), closed: true };
    off = p + len;
  }
  return { rest: buf.slice(off), closed: false };
}

// ChartBridge 0.3.1 network rules (nt8/PROTOCOL.md, "Network access"): only this PC, and a browser WebSocket
// only from ChartBridge's own page or allowOrigins. No Origin header (a local program) is allowed.
const isLoopback = a => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(String(a || ''));
function wsOriginAllowed(origin) {
  if (origin === undefined) return true;
  const o = String(origin).trim().toLowerCase();
  if (!o || o === 'null') return false;
  return o === 'http://localhost:' + PORT || config.allowOrigins.includes(o);
}
const refused = { notThisPc: 0, origin: 0 };

const clients = new Set();
const received = { types: {}, sessionRequests: 0, urls: [], ticketsRefused: 0, pinRefused: 0 };   // for /test/received (no PIN or token ever in it)
const ticketsUsed = new Set();
function send(c, obj) { if (!c.sock.destroyed) c.sock.write(frame(JSON.stringify(obj))); }

// a new random session token each start, served same-origin at GET /session (gate 4)
const deskOpts = {
  config, instruments: INSTR, knownAccounts: ACCOUNTS, token: crypto.randomBytes(24).toString('base64url'),
  send, conns: () => clients, barTime: () => etNow(),
};
// --v3: ChartBridge 0.4.0's desk (test/fake-v3.mjs) with every switch on but those in --v3-off
const desk = V3 ? new OrderDeskV3(Object.assign(deskOpts, { switches: Object.fromEntries(SWITCHES.map(k => [k, !V3_OFF.includes(k)])), accountList: V3_ACCOUNTS,
  graceMs: flagValue('gone-grace-ms') === '' ? 10000 : +flagValue('gone-grace-ms'), botRoot: 'MNQ' })) : new OrderDesk(deskOpts);
const tapeStats = TAPE_STATS ? new TapeStats() : null;
const BOT_SECRET = crypto.randomBytes(32).toString('hex');   // ChartBridge keeps it in bot-secret.txt; never printed

function onMessage(c, text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  const type = m && typeof m.type === 'string' ? m.type : '?';
  received.types[type] = (received.types[type] || 0) + 1;
  if (type === 'subscribe') { (received.subscribes = received.subscribes || []).push({ root: m.root, days: m.days, tickHours: m.tickHours, at: Date.now() }); if (received.subscribes.length > 200) received.subscribes.shift(); }
  if (type === 'flatten' || type === 'cancel') { (received.orderActions = received.orderActions || []).push({ type, root: m.root, id: m.id, at: Date.now() }); if (received.orderActions.length > 200) received.orderActions.shift(); }
  if (V1) { if (m.type === 'subscribe') subscribe(c, m); return; }       // 0.2 ignores everything else
  if (m.type === 'subscribe') subscribe(c, m);
  else if (DATA_037 && (m.type === 'htf' || m.type === 'weekProfile')) onDataRequest(c, m, text);
  else if (m.type === 'auth') desk.auth(c, m.token);
  else if (V3 && m.type === 'client') desk.client(c, m);
  else if (V3 && ['order', 'change', 'plan', 'cancel', 'flatten', 'accountTrade', 'accountArchive', 'merge', 'copierGet', 'copierSet', 'copierFollower', 'copierRearm',
    'botMode', 'botKill', 'botSeen', 'botAnswer', 'botRails'].includes(m.type)) desk.handle(c, m, text);
  else if (['order', 'change', 'plan', 'cancel', 'flatten'].includes(m.type)) desk.handle(c, m);   // plan: ChartBridge 0.3.7 (prices), 0.3.8 (ticks)
}
/* ---------------- --data-037: settlement, higher-timeframe bars, the weekly profile (sample data) */
const settlement = {}, settlementDate = {};       // the prior session's settlement and its trading date (sample: its last close)
for (const r of Object.keys(INSTR)) {
  const b = data[r], day = CE.util.tradeDay(b[b.length - 1].t, 64800), prior = b.filter(x => CE.util.tradeDay(x.t, 64800) < day);
  settlement[r] = prior.length ? prior[prior.length - 1].c : null;
  settlementDate[r] = new Date((prior.length ? CE.util.tradeDay(prior[prior.length - 1].t, 64800) : day - 1) * 86400000).toISOString().slice(0, 10);
}
const HTF_FRAMES = ['4h', '1D', '1W'];
function htfStart(tf, t) {                       // as ChartBridge.HtfStart: 4h from the 18:00 ET open, 1D the trading day, 1W its Monday
  const day = Math.floor((t + 21600) / 86400);
  if (tf === '4h') { const open = day * 86400 - 21600; return open + Math.floor((t - open) / 14400) * 14400; }
  if (tf === '1D') return day * 86400;
  const dow = ((day + 4) % 7 + 7) % 7;
  return (day - (dow + 6) % 7) * 86400;
}
const htfSeries = {};                             // 'MNQ 4h' -> bars [[t,o,h,l,c,v]], made once, kept live by trade()
function htfBars(r, tf) {
  const key = r + ' ' + tf;
  if (htfSeries[key]) return htfSeries[key];
  const out = [];
  for (const b of data[r]) {
    const t = htfStart(tf, b.t), x = out[out.length - 1];
    if (x && x[0] === t) { x[2] = Math.max(x[2], b.h); x[3] = Math.min(x[3], b.l); x[4] = b.c; x[5] += b.v; }
    else out.push([t, b.o, b.h, b.l, b.c, b.v]);
  }
  return (htfSeries[key] = out.slice(-300));
}
function htfTrade(r, t, p, v) {
  for (const tf of HTF_FRAMES) {
    const s = htfSeries[r + ' ' + tf]; if (!s) continue;
    const st = htfStart(tf, t), x = s[s.length - 1];
    if (x && st < x[0]) continue;
    if (x && st === x[0]) { x[2] = Math.max(x[2], p); x[3] = Math.min(x[3], p); x[4] = p; x[5] += v; }
    else s.push([st, p, p, p, p, v]);
    s.version = (s.version || 0) + 1;
  }
}
// strict, as ChartBridge: only the listed keys, strings or (id) a whole number of up to 15 digits, no escapes
function strict(text, m, keys, need) {
  if (/\\/.test(text) || !m || typeof m !== 'object' || Array.isArray(m)) return 'not a plain JSON object';
  for (const k of Object.keys(m)) if (!keys.includes(k)) return 'unknown key ' + k;
  for (const k of need) if (m[k] === undefined) return 'missing ' + k;
  for (const k of Object.keys(m)) if (k !== 'id' && typeof m[k] !== 'string') return k + ' must be a string';
  if (m.id !== undefined && !(Number.isInteger(m.id) && m.id >= 0 && String(m.id).length <= 15 && /"id"\s*:\s*(0|[1-9]\d*)\s*[,}]/.test(text))) return 'id must be a whole number';
  return null;
}
function onDataRequest(c, m, text) {
  const why = m.type === 'htf' ? strict(text, m, ['type', 'root', 'tf', 'id'], ['root', 'tf']) || (HTF_FRAMES.includes(m.tf) ? null : 'tf must be 4h, 1D or 1W')
    : strict(text, m, ['type', 'root', 'id'], ['root']);
  if (why) return send(c, { type: 'status', level: 'warn', text: 'ChartBridge refused a ' + m.type + ' message: ' + why });
  const id = m.id === undefined ? null : m.id;
  if (!INSTR[m.root]) {
    if (m.type === 'htf') return send(c, { type: 'htf', root: m.root, tf: m.tf, id, name: null, bars: [], error: 'ChartBridge does not serve ' + m.root });
    return send(c, { type: 'weekProfile', root: m.root, id, tick: null, sessions: [], rows: [], error: 'ChartBridge does not serve ' + m.root });
  }
  if (m.type === 'htf' && htfFail) return send(c, { type: 'htf', root: m.root, tf: m.tf, id, name: INSTR[m.root].name, bars: [], error: htfFail });
  if (m.type === 'htf') {
    const bars = htfBars(m.root, m.tf);
    c.htf = c.htf || new Map();
    if (c.htf.size < 12 || c.htf.has(m.root + ' ' + m.tf)) c.htf.set(m.root + ' ' + m.tf, { version: bars.version || 0, lastT: bars.length ? bars[bars.length - 1][0] : -Infinity });
    return send(c, { type: 'htf', root: m.root, tf: m.tf, id, name: INSTR[m.root].name, bars, error: null });
  }
  // weekProfile: the last 5 finished sample sessions, each bar's volume at its close (sample data, not a real profile)
  const tick = INSTR[m.root].tick, byDay = new Map();
  for (const b of data[m.root]) { const d = CE.util.tradeDay(b.t, 64800); if (!byDay.has(d)) byDay.set(d, new Map()); const rows = byDay.get(d), k = Math.round(b.c / tick); rows.set(k, (rows.get(k) || 0) + b.v); }
  // a fixed set (review D2): the 5 weekday sessions before today by the calendar, whatever hours the sample's window
  // covers now; a session the sample has no minutes for takes the rows of the nearest one it has
  const today = CE.util.tradeDay(etNow(), 64800), days = [], have = [...byDay.keys()].sort((a, b) => a - b);
  for (let d = today - 1; days.length < 5 && have.length; d--) { const wd = new Date(d * 86400000).getUTCDay(); if (wd !== 0 && wd !== 6) days.unshift(d); }
  const nearest = d => (byDay.has(d) ? d : have.reduce((x, y) => (Math.abs(y - d) < Math.abs(x - d) ? y : x), have[0]));
  const all = new Map(), sessions = days.map((d, i) => {
    const date = new Date(d * 86400000).toISOString().slice(0, 10);
    if (i === 1) return { date, missing: 'no table: ChartBridge was not running for this session, or its file is gone' };
    const rows = [...byDay.get(nearest(d))].sort((a, b) => a[0] - b[0]);
    for (const [k, v] of rows) all.set(k, (all.get(k) || 0) + v);
    return { date, from: d * 86400 - 21600, whole: true, coveredFrom: d * 86400 - 21600, drop: null, rows };
  });
  send(c, { type: 'weekProfile', root: m.root, id, tick, sessions, rows: [...all].sort((a, b) => a[0] - b[0]), error: null });
}
if (DATA_037) setInterval(() => {                 // htfBar: at most once a second while a watched forming bar changes
  for (const c of clients) if (c.htf) for (const [key, w] of c.htf) {
    const s = htfSeries[key]; if (!s || !s.length || (s.version || 0) === w.version) continue;
    const lastT = s[s.length - 1][0], from = Math.min(w.lastT, lastT);
    w.version = s.version || 0; w.lastT = lastT;
    const [root, tf] = key.split(' ');
    send(c, { type: 'htfBar', root, tf, bars: s.filter(x => x[0] >= from) });
  }
}, 1000);

const tickCache = new Map();             // --tick-rate: millions of ticks, made once per root and hours
function subscribe(c, m) {
  const r = INSTR[m.root] ? m.root : 'MNQ';
  c.root = r; c.ready = false;
  if (LIVE_FIRST) return subscribeTape(c, m, r);
  const seq = c.seq = (c.seq || 0) + 1;
  let bars = data[r];
  if (DEEP) { const days = Number.isFinite(+m.days) && m.days !== null ? Math.min(60, Math.max(0, +m.days)) : 5, from = bars[bars.length - 1].t - days * 86400; bars = bars.filter(b => b.t >= from); }
  for (let i = 0; i < bars.length; i += 4000) {
    const chunk = bars.slice(i, i + 4000).map(b => [b.t, b.o, b.h, b.l, b.c, b.v]);
    send(c, { type: 'history', root: r, name: INSTR[r].name, barSeconds: 60, bars: chunk, done: i + 4000 >= bars.length });
  }
  const hours = Math.min(TICK_HOURS_MAX, m.tickHours === undefined ? 8 : m.tickHours), key = r + '|' + hours;
  // tickHours 0 (minute views): no tick backfill at all, as ChartBridge (its seam trades are never sent; 1.7.0 round 4:
  // the fake used to send the forming minute's trades)
  const finish = () => {
    if (c.seq !== seq) return;                             // a newer subscribe won
    const ticks = m.tickHours === 0 ? null : TICK_RATE ? (tickCache.get(key) || tickCache.set(key, ticksFrom(bars, hours, r)).get(key)) : ticksFrom(bars, hours, r);
    for (let i = 0; ticks && (i < ticks.length || i === 0); i += 20000) {
      send(c, { type: 'ticks', root: r, ticks: ticks.slice(i, i + 20000), done: i + 20000 >= ticks.length });
      if (!ticks.length) break;
    }
    send(c, { type: 'ready', root: r });
    c.ready = true;
    sceneReady(r);
  };
  if (LOAD_DELAY_MS) setTimeout(finish, LOAD_DELAY_MS); else finish();   // --load-delay-ms: NinjaTrader's tick request taking that long
}

/* --live-first: a load from the tape, as ChartBridge 0.3.5 does it. */
function subscribeTape(c, m, r) {
  const sub = Number.isInteger(m.sub) ? m.sub : undefined, k = tapes[r], bars = data[r], b = books[r];
  const tag = o => (sub !== undefined ? Object.assign(o, { sub }) : o);
  c.seq = (c.seq || 0) + 1; c.profile = m.profile === true;
  const seq = c.seq;
  for (let i = 0; i < bars.length; i += 4000) {
    const chunk = bars.slice(i, i + 4000).map(x => [x.t, x.o, x.h, x.l, x.c, x.v]);
    send(c, tag({ type: 'history', root: r, name: INSTR[r].name, barSeconds: 60, bars: chunk, done: i + 4000 >= bars.length }));
  }
  const hours = Math.min(TICK_HOURS_MAX, m.tickHours === undefined ? 8 : m.tickHours);
  const sendTicks = (a, e) => {
    // the served window's trades carry no side (ChartBridge 0.3.5 sends [t, p, v]); an old bridge's full load does
    for (let i = a; i < e || i === a; i += 20000) { send(c, tag({ type: 'ticks', root: r, ticks: k.rows(i, Math.min(e, i + 20000), liveFirstOn), done: i + 20000 >= e })); if (e <= a) break; }
  };
  const finish = from => {                          // the trades from `from` up to now, the profile of exactly those before, ready
    const end = k.n;
    if (from !== null) sendTicks(from, end);
    if (c.profile) send(c, tag(profileMsg(r, end)));
    send(c, tag({ type: 'ready', root: r })); c.ready = true; sceneReady(r);
  };
  if (!(hours > 0)) { finish(null); return; }       // a minute chart: no trades
  if (!liveFirstOn && m.liveFirst !== true) { finish(k.at(etNow() - hours * 3600)); return; }   // an old bridge: the full load
  // the served window: dropped at the next session (the session of the tape's last trade moved on)
  if (b.window && b.window.session !== sessionOf(k.t[k.n - 1])) b.window = null;
  if (b.window) { b.served++; finish(b.window.from); return; }
  b.asked++;
  setTimeout(() => {                                 // "NinjaTrader" answers; the live trades meanwhile are held, then in the window
    if (c.seq !== seq || c.sock.destroyed) return;
    if (!b.window) b.window = { from: k.at(etNow() - RANGE_HOURS * 3600), session: sessionOf(k.t[k.n - 1]) };
    finish(b.window.from);
  }, WINDOW_MS);
}

const last = {}, held = {}, lastSide = {};
for (const r of Object.keys(INSTR)) { last[r] = data[r][data[r].length - 1].c; desk.tick(r, last[r]); }
if (LIVE_FIRST) for (const r of Object.keys(INSTR)) { const k = tapes[r]; if (k.n) { last[r] = k.p[k.n - 1]; lastSide[r] = k.s[k.n - 1]; } }
function trade(r, p) {
  if (CME_HOURS && cmeClosed(etNow())) return;          // nothing trades while CME is closed
  const [s, sm] = sideOf(p, last[r], lastSide[r]);
  const q = TAPE_Q && last[r] !== undefined ? qOf(p, last[r], sm) : null;   // 0.3.8
  last[r] = p; lastSide[r] = s;
  const now = Date.now();
  // u: the data's UTC time, on the exchange clock, 20 to 50 ms before ChartBridge's PC receives it (rx, on its clock)
  const msg = { type: 'tick', root: r, t: +(etNow() + TICK_SHIFT).toFixed(3), u: now + CLOCK_OFFSET * 1000 - 20 - Math.random() * 30, rx: now + PC_CLOCK_OFFSET * 1000, p, v: 1 + Math.floor(Math.random() * 5) };
  if (SIDES) { msg.s = s; msg.sm = sm; }
  if (q !== null) msg.q = q;                          // 0.3.8: no field when unknown
  if (LIVE_FIRST) {                                   // on the tape: never older than its last trade
    const k = tapes[r];
    if (k.n && msg.t < k.t[k.n - 1]) msg.t = k.t[k.n - 1];
    k.push(msg.t, p, msg.v, s, sm, q);
  }
  for (const c of clients) if (c.ready && c.root === r) send(c, msg);
  if (DATA_037) htfTrade(r, msg.t, p, msg.v);   // the forming 4h, 1D and 1W bars follow the trades
  if (tapeStats) tapeStats.add(r, msg.t, p, msg.u, msg.rx, INSTR[r].tick);
  if (V3 && desk.bot.conn) send(desk.bot.conn, msg);  // the bot reads every live trade
  desk.tick(r, p);                        // the matching engine sees every trade
}
/* --scene=signals: the scripted MNQ tape (see the header), replayed once from the first page that is live on MNQ. */
const scene = { started: false, sent: 0, total: 0, done: false, t0: 0 };
function sceneReady(r) {
  if (SCENE !== 'signals' || r !== 'MNQ' || scene.started) return;
  scene.started = true; held.MNQ = true;                 // the random walk stops; only the scene trades MNQ from here
  setTimeout(() => {
    const t0 = +(etNow() + 0.2).toFixed(3), list = signalScene({ t0, p0: last.MNQ, tick: INSTR.MNQ.tick }), wall0 = Date.now();
    scene.total = list.length; scene.t0 = t0;
    const timer = setInterval(() => {
      const upTo = t0 + (Date.now() - wall0) / 1000 * SCENE_WARP;
      while (scene.sent < list.length && list[scene.sent][0] <= upTo) { const [t, p, v, sd] = list[scene.sent++]; sceneTrade('MNQ', t, p, v, sd); }
      if (scene.sent >= list.length) { scene.done = true; clearInterval(timer); }
    }, 10);
  }, SCENE_DELAY);
}
function sceneTrade(r, t, p, v, sd) {
  last[r] = p; lastSide[r] = sd;
  const now = Date.now();
  const msg = { type: 'tick', root: r, t, u: now + CLOCK_OFFSET * 1000 - 25, rx: now + PC_CLOCK_OFFSET * 1000, p, v };
  if (SIDES) { msg.s = sd; msg.sm = 2; }
  if (LIVE_FIRST) { const k = tapes[r]; if (k.n && msg.t < k.t[k.n - 1]) msg.t = k.t[k.n - 1]; k.push(msg.t, p, v, sd, 2); }
  for (const c of clients) if (c.ready && c.root === r) send(c, msg);
  desk.tick(r, p);
}
if (!LIVE_RATE) setInterval(() => {
  if (MARKET_HOURS && marketClosed(etNow())) return;              // CME closed: no trades
  for (const r of Object.keys(INSTR)) if (!(scene.started && r === 'MNQ')) trade(r, held[r] ? last[r] : rqr(last[r] + (Math.random() - 0.5) * 6 * INSTR[r].tick, r));
}, 120);
else {
  // --live-rate: a busy market. Every 10 ms a Poisson number of trades; mostly 0 or 1 tick apart, and a fast jump of
  // 8 to 16 ticks now and then (NinjaTrader-style range bars then add phantom bars). Seeded, so runs compare.
  let seed = 424242;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const poisson = mean => { let k = 0, p = Math.exp(-mean), s = p; const u = rnd(); while (u > s && k < 200) { k++; p *= mean / k; s += p; } return k; };
  const t0 = Date.now();
  setInterval(() => {
    const burst = ((Date.now() - t0) % 10000) < 1500 ? 3 : 1;
    for (const r of Object.keys(INSTR)) {
      if (held[r] || (scene.started && r === 'MNQ') || ![...clients].some(c => (c.ready || LIVE_FIRST) && c.root === r)) continue;   // live first: the market trades on during a load
      const n = poisson(LIVE_RATE * burst / 100);
      for (let k = 0; k < n; k++) {
        const u = rnd(), steps = u < 0.0005 ? 8 + Math.floor(rnd() * 9) : u < 0.5 ? 0 : 1;
        trade(r, rqr(last[r] + (rnd() < 0.5 ? -1 : 1) * steps * INSTR[r].tick, r));
      }
    }
  }, 10);
}

const fillsSample = () => {
  const b = data.MNQ, n = b.length;
  return [
    { account: 'Sim101', name: 'MNQ 12-26', root: 'MNQ', side: 'buy', qty: 2, p: b[n - 30].l, t: b[n - 30].t + 20, u: 0, id: 'x1', order: 'o1' },
    { account: 'Sim101', name: 'MNQ 12-26', root: 'MNQ', side: 'sell', qty: 2, p: b[n - 22].h, t: b[n - 22].t + 40, u: 0, id: 'x2', order: 'o2' },
    { account: 'DEMO-EVAL', name: 'MNQ 12-26', root: 'MNQ', side: 'sell', qty: 1, p: b[n - 12].h, t: b[n - 12].t + 10, u: 0, id: 'x3', order: 'o3' },
    { account: 'DEMO-EVAL', name: 'MNQ 12-26', root: 'MNQ', side: 'buy', qty: 1, p: b[n - 8].l, t: b[n - 8].t + 30, u: 0, id: 'x4', order: 'o4' },
  ];
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  if (!V1 && !isLoopback(req.socket.remoteAddress)) { refused.notThisPc++; res.writeHead(403); return res.end(); }   // first, before any routing
  // clickjacking: ChartBridge's page may never sit in another page's frame (protocol v2)
  if (!V1 && !ALLOW_FRAMES) { res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', "frame-ancestors 'none'"); }
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') { res.writeHead(302, { Location: '/live/' }); return res.end(); }
  if (p === '/session') received.sessionRequests++;
  if (p === '/session' && !V1) {
    // same-origin only: no CORS headers, and (like HttpListener's localhost prefix) only Host localhost:<port>
    if (req.headers.host !== 'localhost:' + PORT) { res.writeHead(400); return res.end('bad host'); }
    if (!PIN_OFF && !pin.tokenValid(req.headers[PIN_HEADER])) { res.writeHead(403); return res.end(); }   // 0.3.2: only for a page unlocked with the PIN
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ token: desk.token }));
  }
  if (p.startsWith('/pin/') && !V1 && !PIN_OFF) return pin.handle(req, res, PORT);
  if (p.startsWith('/test/') && TEST_CONTROLS && req.method === 'POST') {
    const q = new URL(req.url, 'http://x').searchParams, r = q.get('root') || 'MNQ';
    if (p === '/test/price') { held[r] = true; trade(r, rqr(+q.get('p'), r)); }
    else if (p === '/test/hold') held[r] = q.get('on') !== '0';
    else if (p === '/test/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ last: last[r], orders: [...desk.orders.values()].filter(o => o.state === 'working' || o.state === 'partFilled').map(o => desk.orderMsg(o)),
        positions: Object.fromEntries(desk.positions) }));
    }
    else if (p === '/test/status') { for (const c of clients) send(c, { type: 'status', level: q.get('level') || 'error', text: q.get('text') || '' }); }
    else if (p === '/test/htf' && DATA_037) htfFail = q.get('fail') || '';
    else if (p === '/test/settlement' && DATA_037) {
      settlement[r] = q.get('p') === 'null' ? null : +q.get('p'); if (q.get('date')) settlementDate[r] = q.get('date');
      for (const c of clients) send(c, { type: 'settlement', root: r, p: settlement[r], date: settlementDate[r] });
    }
    else if (p === '/test/drop') { for (const c of clients) c.sock.destroy(); }
    else if (p === '/test/received') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(received)); }
    else if (p === '/test/features') liveFirstOn = LIVE_FIRST && q.get('liveFirst') !== '0';
    else if (p === '/test/feed-drop') {
      dropAt = +etNow().toFixed(3);
      for (const x of Object.values(books)) if (x.window && !x.gapAsked) { x.window = null; x.gapAsked = true; }   // asked again once (ChartBridge: at most once in 10 minutes)
      for (const c of clients) if (c.ready && c.profile && tapes[c.root]) { send(c, profileMsg(c.root, tapes[c.root].n)); books[c.root].pushed++; }
    }
    else if (p === '/test/scene') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(scene)); }
    else if (p === '/test/tape') {
      const k = tapes[r], from = k ? k.at(+q.get('from') || 0) : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(k ? { n: k.n - from, t: Array.from(k.t.subarray(from, k.n)), p: Array.from(k.p.subarray(from, k.n)), v: Array.from(k.v.subarray(from, k.n)), s: Array.from(k.s.subarray(from, k.n)), m: Array.from(k.m.subarray(from, k.n)),
        q: Array.from(k.q.subarray(from, k.n), x => x === -128 ? null : x) } : null));
    }
    else if (p === '/test/books') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(Object.fromEntries(Object.entries(books).map(([x, b]) => [x, { asked: b.asked, served: b.served, profiles: b.profiles, pushed: b.pushed, whole: tableWhole(x),
        windowFrom: b.window ? tapes[x].t[b.window.from] : null }]))));
    }
    else if (V3 && p === '/test/bot-secret' && req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ secret: BOT_SECRET })); }
    else if (V3 && p === '/test/bot-connect') {
      if (q.get('on') === '0') { desk.bot.simulated = false; desk.bot.connected = false; desk.botQuiet('no heartbeat for 5 s'); desk.bot.stats.heartbeatLost++; desk.botNotify(); }
      else { desk.bot.simulated = true; desk.botMessage({ type: 'botHello', name: q.get('name') || 'Demo Opening Fade' }); }
    }
    else if (V3 && (p === '/test/bot-signal' || p === '/test/bot-proposal')) {
      if (!desk.bot.connected) { desk.bot.simulated = true; desk.botMessage({ type: 'botHello', name: 'Demo Opening Fade' }); }
      const mode = desk.bot.mode, sig = { type: 'signal', id: q.get('id') || 'demo-' + Date.now(), action: q.get('action') || 'fired', reason: q.get('reason') || 'Sample: price stalled at the made-up level twice' };
      if (sig.action === 'fired') Object.assign(sig, { side: q.get('side') || 'sell', kind: q.get('kind') || 'market', stopTicks: +(q.get('stop') || 12), targetTicks: q.get('target') === 'null' ? null : +(q.get('target') || 24) });
      if (sig.kind && sig.kind !== 'market') sig.price = q.get('p') ? rqr(+q.get('p'), desk.botRoot) : rqr(last[desk.botRoot] + (sig.side === 'sell' ? 4 : -4) * INSTR[desk.botRoot].tick, desk.botRoot);
      if (p === '/test/bot-proposal') desk.bot.mode = 'copilot';      // a proposal on demand, whatever the mode
      desk.botMessage(sig);
      if (p === '/test/bot-proposal') { desk.bot.mode = mode; desk.botNotify(); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: sig.id }));
    }
    else if (V3 && p === '/test/bot-withdraw') desk.botMessage({ type: 'withdraw', id: q.get('id') || '', reason: q.get('reason') || 'Sample: the entry is no longer valid' });
    else if (V3 && p === '/test/account') desk.setConnection(q.get('name'), q.get('connection') || 'lost');
    else if (V3 && p === '/test/restart') desk.simulateRestart(q.get('lost') === '1');
    else if (V3 && p === '/test/v3') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ accounts: desk.accountsMsg(), copier: desk.copierMsg(), bot: desk.botMsg(), managed: [...desk.managed.values()].map(x => desk.managedMsg(x)),
        proposals: [...desk.bot.proposals.values()], log: desk.log, diag: desk.diag() }));
    }
    else if (p === '/test/elsewhere') desk.placeElsewhere({ account: q.get('account'), root: r, side: q.get('side'), kind: q.get('kind'), qty: +q.get('qty'), price: +q.get('p') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ root: r, last: last[r], held: !!held[r] }));
  }
  if (p === '/diag') {   // same shape as ChartBridge's /diag, sample values
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ version: 'fake-0.2.0', clockOffsetMs: 0, fillEventsDelivered: 0, fillsFoundByPolling: 0, lastPollUtcMs: Date.now(), clients: clients.size,
      desk: { postFills: false, deskUrl: 'http://localhost:8800', waiting: 0, lastSendFailed: false, lastError: '' },
      ...(V1 ? {} : { network: { loopbackOnly: true, allowOrigins: ['http://localhost:' + PORT].concat(config.allowOrigins), refusedNotThisPc: refused.notThisPc, refusedOrigin: refused.origin },
        pin: { set: pin.isSet() } }),
      accounts: ACCOUNTS.map(name => ({ name, connection: 'Connected', executions: fillsSample().filter(f => f.account === name).length, orders: 0, positions: 0, fillEvents: 0, orderEvents: 0, positionEvents: 0 })),
      ...(V3 ? Object.assign({   // 0.4.0 (PROTOCOL.md "Tape timing and new /diag counters"); sample values where the fake has no real number
        memory: { managedMb: +(process.memoryUsage().heapUsed / 1048576).toFixed(1), gen0: 0, gen1: 0, gen2: 0, trims: 0, lastTrimUtcMs: null },
        threads: { workerAvailable: 32767, workerMax: 32767, ioAvailable: 1000, ioMax: 1000, minWorkerAvailableToday: 32767 },
        send: {}, reconnects: { pages: received.urls.length, lagCloses: 0, feedDrops: dropAt === null ? 0 : 1, accountReconnects: 0 } }, desk.diag(), tapeStats ? { tape: tapeStats.diag() } : {}) : {}) }));
  }
  if (p === '/bot-library') {   // lane C4: the frozen Bot-Lab builds (docs/BOT_LIBRARY.md); a made-up example file here
    const file = flagValue('bot-library') ? path.resolve(flagValue('bot-library')) : path.join(root, 'test', 'fixtures', 'bot-library.json');
    if (!V3 || V3_OFF.includes('bot') || flag('no-bot-library') || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(file));
  }
  if (p.endsWith('/')) p += 'index.html';
  const full = path.join(root, p);
  if (!full.startsWith(root) || !fs.existsSync(full)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
});
server.on('upgrade', (req, sock) => {
  if (!V1 && !isLoopback(req.socket.remoteAddress)) { refused.notThisPc++; sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
  if (V3 && !V3_OFF.includes('bot') && req.url.split('?')[0] === '/bot') return botUpgrade(req, sock);
  if (!req.url.startsWith('/ws')) { sock.destroy(); return; }
  if (!V1 && !wsOriginAllowed(req.headers.origin)) { refused.origin++; sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
  if (TICKETS) {
    const ticket = new URL(req.url, 'http://x').searchParams.get('ticket');
    if (!ticket || ticketsUsed.has(ticket)) { received.ticketsRefused++; sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
    ticketsUsed.add(ticket);
  }
  const unlock = new URL(req.url, 'http://x').searchParams.get('unlock');
  if (!V1 && !TICKETS && !PIN_OFF && !pin.wsUnlocked(req.headers.origin, unlock, OWN)) { received.pinRefused++; sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
  received.urls.push(req.url.replace(/([?&]unlock=)[^&]*/, '$1(hidden)'));
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const c = { sock, root: null, ready: false, buf: Buffer.alloc(0), origin: req.headers.origin || null, authed: false, actions: [] };
  clients.add(c);
  // the version as the real add-on names it in hello: 0.3.4 sends trade sides, 0.3.3 (--no-sides) does not; --version sets it
  const hello = { type: 'hello', version: flagValue('version') || (V1 ? 'fake-0.2.1' : SIDES ? 'fake-0.3.4' : 'fake-0.3.3'), now: Date.now(), instruments: Object.entries(INSTR).map(([r, i]) => ({ root: r, name: i.name, tick: i.tick, pointValue: i.pointValue })), accounts: NO_HELLO_ACCOUNTS ? [] : ACCOUNTS };
  if (!V1) hello.trading = desk.helloTrading(c);
  if (liveFirstOn) { hello.features = ['liveFirst', 'profile']; hello.version = 'fake-0.3.5'; }
  if (DATA_037) {                                   // 0.3.7: the prior settlement per instrument (sample), and the new features
    for (const i of hello.instruments) { i.settlement = settlement[i.root]; i.settlementDate = settlementDate[i.root]; }
    hello.features = (hello.features || []).concat(['settlement', 'htf', 'weekProfile']); hello.version = 'fake-0.3.7';
  }
  if (V3 || QUOTE) {                                // 0.4.0: every instrument says whether it is quote only, and its price format
    for (const i of hello.instruments) { const x = INSTR[i.root]; i.quoteOnly = !!x.quoteOnly; i.format = x.format || 'dec'; i.decimals = x.decimals === undefined ? 2 : x.decimals; }
    hello.features = (hello.features || []).concat(V3 ? ['v3'] : [], QUOTE ? ['quoteOnly'] : []); if (V3) hello.version = 'fake-0.4.0';
  }
  send(c, hello);
  send(c, { type: 'execs', list: NO_HELLO_ACCOUNTS ? [] : fillsSample() });
  sock.on('data', d => {
    const r = parseFrames(Buffer.concat([c.buf, d]), t => onMessage(c, t));
    c.buf = r.rest; if (r.closed) sock.end();
  });
  sock.on('close', () => clients.delete(c));
  sock.on('error', () => clients.delete(c));
});
/* --v3: the bot channel (PROTOCOL.md "Bot channel"): no Origin, the secret in X-ChartBridge-Bot, one bot at a time */
function botUpgrade(req, sock) {
  const no = code => sock.end('HTTP/1.1 ' + code + '\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  const given = String(req.headers['x-chartbridge-bot'] || '');
  if (req.headers.origin !== undefined) return no('403 Forbidden');
  if (given.length !== BOT_SECRET.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(BOT_SECRET))) return no('403 Forbidden');
  if (desk.bot.conn) return no('409 Conflict');
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const c = { sock, bot: true, buf: Buffer.alloc(0) };
  desk.bot.conn = c; desk.bot.simulated = false; desk.bot.lastBeat = Date.now();
  sock.on('data', d => {
    const r = parseFrames(Buffer.concat([c.buf, d]), t => {
      let m; try { m = JSON.parse(t); } catch (e) { return send(c, { type: 'reject', id: null, reason: 'Not JSON.' }); }
      const why = desk.botMessage(m, t);
      if (why) send(c, { type: 'reject', id: m && typeof m.id === 'string' ? m.id : null, reason: why });
    });
    c.buf = r.rest; if (r.closed) sock.end();
  });
  const gone = () => { if (desk.bot.conn === c) { desk.bot.conn = null; desk.bot.connected = false; desk.botQuiet('the bot disconnected'); desk.botNotify(); } };
  sock.on('close', gone); sock.on('error', gone);
}
if (V3) {
  setInterval(() => { desk.everySecond(); desk.sendAccounts(); for (const c of clients) if (c.authed && c.v3 && desk.sw.bot && desk.bot.connected) send(c, desk.botMsg()); }, 1000);
  if (!flag('no-v3-seed')) {                           // made-up state for the page lanes' smokes (see the header)
    const lp = r => last[r];
    desk.placeElsewhere({ account: 'EVAL-A', root: 'MNQ', side: 'buy', kind: 'market', qty: 2, price: null });
    desk.placeElsewhere({ account: 'EVAL-A', root: 'MNQ', side: 'sell', kind: 'limit', qty: 2, price: rq(lp('MNQ') + 40, 0.25) });
    desk.placeElsewhere({ account: 'FUNDED-C', root: 'NQ', side: 'buy', kind: 'limit', qty: 1, price: rq(lp('NQ') - 40, 0.25) });
    const a = desk.acct.get('FUNDED-C'); if (a) a.drawdown = 2500;
    desk.setConnection('EVAL-B', 'lost');
    if (desk.sw.copier) {
      desk.copier.followers.set('SIM-F1', { account: 'SIM-F1', on: true, qty: 3, size: 'micro', lossLimit: null, root: 'MNQ' });
      desk.copier.followers.set('SIM-F2', { account: 'SIM-F2', on: true, qty: 1, size: 'mini', lossLimit: 500, root: 'NQ' });
      for (const n of ['SIM-F1', 'SIM-F2']) { const x = desk.acct.get(n); if (x) x.trade = true; }
      desk.refreshAccounts();
    }
  }
}
pinReady.then(() => server.listen(PORT, '127.0.0.1', () => console.log('fake ChartBridge on http://localhost:' + PORT + '/live/' +
  (V1 ? ' (v1, read only)' : (config.trading ? ' (trading on: ' + desk.accounts.join(', ') + ')' : ' (trading off)') + (pin.isSet() ? ' (PIN set)' : ' (no PIN set)')))));
